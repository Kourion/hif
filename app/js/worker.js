/*
 * Conversion worker. Several of these share each photo:
 *   open    load the file (the "lead" worker also creates the output canvas)
 *   tile    decode one grid tile to RGBA and send it back
 *   put     (lead) paint a decoded tile into the output canvas
 *   finish  (lead) resize, encode the JPG and copy the camera metadata
 *   close   forget a photo
 * Requests are handled one at a time, in the order they arrive.
 */
/* global libheif, HifCore, JpegMeta */
'use strict';

importScripts('../vendor/libheif/libheif.js', 'hif-core.js', 'jpeg-meta.js');

const PREVIEW_SIZE = 640;
let modulePromise = null;
const files = new Map(); // job id -> Promise<HeifFile>
const canvases = new Map(); // job id -> OffscreenCanvas (lead only)

function getModule() {
  if (!modulePromise) {
    modulePromise = new Promise((resolve, reject) => {
      const M = {
        locateFile: (path) => new URL('../vendor/libheif/' + path, self.location.href).href,
        onRuntimeInitialized: () => resolve(M),
        onAbort: (what) => reject(new Error('The decoder failed to start: ' + what)),
      };
      libheif(M);
    }).catch((e) => {
      modulePromise = null;
      throw e;
    });
  }
  return modulePromise;
}

function openJob(job, file) {
  let promise = files.get(job);
  if (!promise) {
    promise = (async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!HifCore.looksLikeHeif(bytes)) throw new Error('This is not a HEIF/HIF photo.');
      const M = await getModule();
      return HifCore.openFile(M, bytes);
    })();
    files.set(job, promise);
    promise.catch(() => files.delete(job));
  }
  return promise;
}

async function closeJob(job) {
  canvases.delete(job);
  const promise = files.get(job);
  files.delete(job);
  if (promise) {
    try {
      (await promise).close();
    } catch (e) {
      // Opening failed; nothing to free.
    }
  }
}

function fitWithin(width, height, maxSize) {
  const long = Math.max(width, height);
  if (!maxSize || long <= maxSize) return { width, height };
  const s = maxSize / long;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

async function open(msg) {
  const file = await openJob(msg.job, msg.file);
  if (msg.lead) {
    const canvas = new OffscreenCanvas(file.width, file.height);
    if (!canvas.getContext('2d')) throw new Error('This browser cannot create an image canvas.');
    canvases.set(msg.job, canvas);
  }
  return {
    type: 'opened',
    width: file.width,
    height: file.height,
    columns: file.tiling.columns,
    rows: file.tiling.rows,
    camera: JpegMeta.readCameraInfo(JpegMeta.exifToTiff(file.exif)),
  };
}

async function tile(msg) {
  const file = await openJob(msg.job, msg.file);
  const t = file.decodeTile(msg.tx, msg.ty, { dither: true });
  return [{ type: 'tile', x: t.x, y: t.y, width: t.width, height: t.height, rgba: t.rgba }, [t.rgba.buffer]];
}

function put(msg) {
  const canvas = canvases.get(msg.job);
  if (!canvas) throw new Error('Lost track of the photo while assembling it.');
  if (msg.width && msg.height) {
    canvas.getContext('2d').putImageData(new ImageData(msg.rgba, msg.width, msg.height), msg.x, msg.y);
  }
}

async function finish(msg) {
  const { job, options } = msg;
  const canvas = canvases.get(job);
  const file = await files.get(job);
  if (!canvas || !file) throw new Error('Lost track of the photo while saving it.');
  // Chrome drops the backing store of a canvas it cannot allocate and would
  // then encode a black image instead of failing.
  const ctx = canvas.getContext('2d');
  if (ctx.isContextLost && ctx.isContextLost()) throw new Error('Not enough memory to convert this photo.');
  const warnings = [];

  const out = fitWithin(canvas.width, canvas.height, options.maxSize);
  let target = canvas;
  if (out.width !== canvas.width || out.height !== canvas.height) {
    const bitmap = await createImageBitmap(canvas, {
      resizeWidth: out.width,
      resizeHeight: out.height,
      resizeQuality: 'high',
    });
    target = new OffscreenCanvas(out.width, out.height);
    target.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close();
    canvas.width = canvas.height = 1; // release the full-size backing store
  }

  let blob;
  try {
    blob = await target.convertToBlob({ type: 'image/jpeg', quality: options.quality });
  } catch (e) {
    throw new Error('The phone ran out of memory while saving the JPG. Try a smaller size in Settings.');
  }
  if (!blob || blob.type !== 'image/jpeg') throw new Error('This browser cannot save JPG images.');

  // Small preview for the contact sheet.
  const pv = fitWithin(out.width, out.height, PREVIEW_SIZE);
  const small = new OffscreenCanvas(pv.width, pv.height);
  const sctx = small.getContext('2d');
  sctx.imageSmoothingQuality = 'high';
  sctx.drawImage(target, 0, 0, pv.width, pv.height);
  const preview = await small.convertToBlob({ type: 'image/jpeg', quality: 0.8 });
  target.width = target.height = 1;

  let tiff = JpegMeta.exifToTiff(file.exif);
  const camera = JpegMeta.readCameraInfo(tiff);
  let xmp = file.xmp;
  if (!options.keepMetadata) {
    tiff = null;
    xmp = null;
  } else if (tiff) {
    tiff = JpegMeta.patchExif(tiff, {
      // The HEIF rotation/mirroring is already applied to the pixels, so the
      // Exif orientation must not rotate them a second time.
      orientation: file.transformed ? 1 : 0,
      width: out.width,
      height: out.height,
      removeGps: options.removeGps,
    });
    if (!tiff) warnings.push('Camera info was left out because location could not be removed safely');
  }
  if (options.removeGps && JpegMeta.xmpHasLocation(xmp)) xmp = null;

  const encoded = new Uint8Array(await blob.arrayBuffer());
  const result = JpegMeta.insertMetadata(encoded, { tiff, xmp, icc: file.icc });
  warnings.push(...result.warnings);
  const info = file.info;
  await closeJob(job);

  return {
    type: 'done',
    result: {
      jpeg: new Blob([result.jpeg], { type: 'image/jpeg' }),
      crc: JpegMeta.crc32(result.jpeg),
      preview,
      width: out.width,
      height: out.height,
      sourceWidth: file.width,
      sourceHeight: file.height,
      info,
      camera,
      warnings,
    },
  };
}

function friendly(e) {
  const message = (e && e.message) || String(e);
  if (e instanceof RangeError || /memory|allocation|Aborted/i.test(message)) {
    // A failed allocation can leave the WASM heap unusable; start fresh next time.
    modulePromise = null;
    return 'Not enough memory to convert this photo. Close other apps or pick a smaller size in Settings.';
  }
  return message;
}

async function handle(msg) {
  try {
    switch (msg.type) {
      case 'warmup':
        await getModule();
        return;
      case 'open':
        self.postMessage({ job: msg.job, ...(await open(msg)) });
        return;
      case 'tile': {
        const [reply, transfer] = await tile(msg);
        self.postMessage({ job: msg.job, tx: msg.tx, ty: msg.ty, ...reply }, transfer);
        return;
      }
      case 'put':
        put(msg);
        return;
      case 'finish':
        self.postMessage({ job: msg.job, ...(await finish(msg)) });
        return;
      case 'close':
        await closeJob(msg.job);
        return;
      default:
    }
  } catch (e) {
    if (msg.type === 'warmup') {
      self.postMessage({ type: 'fatal', message: friendly(e) });
      return;
    }
    // 'put' has no reply of its own, so its failures are reported separately.
    const type = msg.type === 'put' ? 'put-error' : 'error';
    self.postMessage({ type, job: msg.job, message: friendly(e) });
    if (msg.type !== 'tile') closeJob(msg.job);
  }
}

let queue = Promise.resolve();
self.onmessage = (event) => {
  const msg = event.data;
  queue = queue.then(() => handle(msg));
};
