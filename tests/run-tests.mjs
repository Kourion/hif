// Test suite: decoder/metadata checks in Node, then the real app in headless
// Chromium (conversion, saving, ZIP, offline mode, Android share target).
//
//   node tests/run-tests.mjs            run everything
//   node tests/run-tests.mjs --node     Node checks only
//   node tests/run-tests.mjs --large    also time a 33 MP (7008x4672) photo
//
// Fixtures are made by tests/fixtures/make_hif.py (see README).
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../tools/serve.mjs';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = join(ROOT, 'tests/fixtures');
const HifCore = require('../app/js/hif-core.js');
const JpegMeta = require('../app/js/jpeg-meta.js');
const { makeZip } = await import('../app/js/zip.mjs');

const args = new Set(process.argv.slice(2));
const work = mkdtempSync(join(tmpdir(), 'hif-tests-'));
let failures = 0;
let passes = 0;

function check(name, ok, detail = '') {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
}

function fixtures() {
  return readdirSync(FIXTURES).filter((f) => f.endsWith('.HIF')).sort();
}

function expectations(file) {
  return JSON.parse(readFileSync(join(FIXTURES, file.replace(/\.HIF$/, '.json')), 'utf8'));
}

function comparePatches(name, meta, sample, tolerance) {
  let worst = 0;
  let where = '';
  for (const p of meta.patches) {
    const got = sample(p.x, p.y);
    const d = Math.max(...got.map((v, i) => Math.abs(v - p.rgb[i])));
    if (d > worst) {
      worst = d;
      where = `${p.name}: want ${p.rgb} got ${got}`;
    }
  }
  check(`${name}: colour patches within ±${tolerance}`, worst <= tolerance, `worst ${worst}${worst ? `, ${where}` : ''}`);
  const m = sample(meta.marker.x, meta.marker.y);
  check(`${name}: orientation marker is white`, Math.min(...m) > 200, `got ${m}`);
}

function loadLibheif() {
  const M = { wasmBinary: readFileSync(join(ROOT, 'app/vendor/libheif/libheif.wasm')) };
  return new Promise((resolve) => {
    M.onRuntimeInitialized = () => setTimeout(() => resolve(M));
    require('../app/vendor/libheif/libheif.js')(M);
  });
}

function jpegSegments(bytes) {
  const segs = [];
  let i = 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1];
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    segs.push({ marker, data: bytes.subarray(i + 4, i + 2 + len) });
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return segs;
}

function jpegInfo(bytes) {
  const segs = jpegSegments(bytes);
  const sof = segs.find((s) => s.marker === 0xc0 || s.marker === 0xc2);
  const app1 = segs.find((s) => s.marker === 0xe1 && String.fromCharCode(...s.data.subarray(0, 4)) === 'Exif');
  return {
    width: sof ? (sof.data[3] << 8) | sof.data[4] : 0,
    height: sof ? (sof.data[1] << 8) | sof.data[2] : 0,
    firstMarker: segs[0] && segs[0].marker,
    tiff: app1 ? app1.data.subarray(6) : null,
  };
}

// ------------------------------------------------------------------ Node checks

async function nodeChecks() {
  console.log('\n# Decoder and metadata (Node)');
  const M = await loadLibheif();
  for (const file of fixtures()) {
    const meta = expectations(file);
    const r = HifCore.decode(M, new Uint8Array(readFileSync(join(FIXTURES, file))), { dither: false });
    check(`${file}: size ${meta.width}x${meta.height}`, r.width === meta.width && r.height === meta.height, `${r.width}x${r.height}`);
    check(`${file}: 10-bit ${meta.chroma}`, r.info.bitDepth === 10, `${r.info.bitDepth}-bit ${r.info.chroma}`);
    check(`${file}: HDR flag`, (r.info.hdr === 'HLG') === meta.hlg, String(r.info.hdr));
    check(`${file}: transformation flag`, r.info.transformed === meta.transformed);
    comparePatches(file, meta, (x, y) => {
      const i = (y * r.width + x) * 4;
      return [r.rgba[i], r.rgba[i + 1], r.rgba[i + 2]];
    }, 2);
    const tiff = JpegMeta.exifToTiff(r.exif);
    const cam = JpegMeta.readCameraInfo(tiff);
    check(`${file}: Exif readable`, cam.model === 'ILCE-7M4' && cam.iso === 400 && Math.abs(cam.fNumber - 2.8) < 1e-6 && cam.orientation === meta.exif_orientation_in,
      JSON.stringify(cam));
    check(`${file}: GPS presence`, cam.hasGps === meta.gps);
  }

  // Exif patching
  const exifItem = HifCore.decode(M, new Uint8Array(readFileSync(join(FIXTURES, 'sony-422.HIF'))), {}).exif;
  const tiff = JpegMeta.exifToTiff(exifItem);
  const patched = JpegMeta.patchExif(tiff, { orientation: 1, width: 600, height: 400, removeGps: true });
  const cam = JpegMeta.readCameraInfo(patched);
  check('patchExif: GPS removed, camera info kept', cam.hasGps === false && cam.model === 'ILCE-7M4' && cam.iso === 400);
  const latitude = Buffer.from([52, 0, 0, 0, 1, 0, 0, 0, 31, 0, 0, 0]);
  check('patchExif: GPS coordinates wiped from the block', !Buffer.from(patched).includes(latitude) && Buffer.from(tiff).includes(latitude));
  check('patchExif: original block untouched', JpegMeta.readCameraInfo(tiff).hasGps === true);

  // JPEG metadata insertion
  const fakeJpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  const icc = new Uint8Array(150000).fill(7);
  const { jpeg } = JpegMeta.insertMetadata(fakeJpeg, { tiff, xmp: null, icc });
  const segs = jpegSegments(jpeg);
  check('insertMetadata: Exif APP1 first, JFIF removed', segs[0].marker === 0xe1 && !segs.some((s) => s.marker === 0xe0));
  const iccSegs = segs.filter((s) => s.marker === 0xe2);
  const iccBytes = iccSegs.reduce((n, s) => n + s.data.length - 14, 0);
  check('insertMetadata: ICC profile split into chunks', iccSegs.length === 3 && iccBytes === icc.length, `${iccSegs.length} chunks, ${iccBytes} bytes`);
  check('insertMetadata: ends with EOI', jpeg[jpeg.length - 2] === 0xff && jpeg[jpeg.length - 1] === 0xd9);

  // ZIP writer
  const a = new TextEncoder().encode('first file');
  const b = new Uint8Array(70000).map((_, i) => i & 255);
  const zip = makeZip([
    { name: 'DSC00001.jpg', blob: new Blob([a]), crc: JpegMeta.crc32(a) },
    { name: 'DSC00002.jpg', blob: new Blob([b]), crc: JpegMeta.crc32(b) },
  ]);
  const zipPath = join(work, 'test.zip');
  writeFileSync(zipPath, Buffer.from(await zip.arrayBuffer()));
  check('makeZip: archive passes python zipfile test', zipTest(zipPath) === 'DSC00001.jpg,DSC00002.jpg');

  check('looksLikeHeif: rejects a JPEG', !HifCore.looksLikeHeif(fakeJpeg));
}

function zipTest(path) {
  try {
    return execFileSync('python3', ['-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; print(",".join(z.namelist()))`, path]).toString().trim();
  } catch (e) {
    return String(e.stderr || e.message);
  }
}

// ------------------------------------------------------------------ browser checks

async function browserChecks() {
  console.log('\n# App in headless Chromium');
  const { chromium } = require('playwright');
  const server = await serve(0);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 412, height: 915 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  try {
    await page.goto(base);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null || document.getElementById('offline-status').textContent.startsWith('Ready'), null, { timeout: 30000 });
    await page.evaluate(() => navigator.serviceWorker.ready);
    check('service worker installed', true);

    const files = fixtures().map((f) => join(FIXTURES, f));
    await page.setInputFiles('#file-input', files);
    await waitForFrames(page, files.length);
    const states = await page.$$eval('.frame', (els) => els.map((e) => e.dataset.state + ': ' + e.querySelector('.frame-status').textContent));
    check('all fixtures converted', states.every((s) => s.startsWith('done')), states.join(' | '));
    const readout = await page.textContent('.frame-readout');
    check('frame shows camera readout', /f\/2\.8.*1\/250.*ISO 400/.test(readout), readout);

    const names = fixtures();
    for (let i = 0; i < names.length; i++) {
      const file = names[i];
      const meta = expectations(file);
      const bytes = await saveFromViewer(page, i);
      const info = jpegInfo(bytes);
      check(`${file}: JPG is ${meta.width}x${meta.height}`, info.width === meta.width && info.height === meta.height, `${info.width}x${info.height}`);
      check(`${file}: Exif is the first segment`, info.firstMarker === 0xe1);
      const cam = JpegMeta.readCameraInfo(info.tiff);
      check(`${file}: Exif orientation ${meta.exif_orientation_out}`, cam.orientation === meta.exif_orientation_out, String(cam.orientation));
      check(`${file}: location kept by default`, cam.hasGps === meta.gps);
      // Browsers apply the Exif orientation when showing a JPG, so check the
      // colours where a viewer will actually display them.
      const shown = [...meta.patches, meta.marker].map((p) => displayPoint(p, meta.width, meta.height, cam.orientation));
      const pixels = await samplePixels(page, bytes, shown);
      let k = 0;
      comparePatches(`${file} (JPG as displayed)`, meta, () => pixels[k++], 6);
    }

    // Remove-location setting + reconvert
    await page.click('#open-settings');
    await page.check('#remove-gps');
    await page.click('#reconvert');
    await waitForFrames(page, files.length);
    const gpsIndex = names.indexOf('sony-422.HIF');
    const cleaned = jpegInfo(await saveFromViewer(page, gpsIndex));
    check('"Remove location" strips GPS from the JPG', JpegMeta.readCameraInfo(cleaned.tiff).hasGps === false && !!cleaned.tiff);

    // Smaller output size
    await page.click('#open-settings');
    await page.check('input[name="size"][value="1080"]');
    await page.click('#reconvert');
    await waitForFrames(page, files.length);
    const small = jpegInfo(await saveFromViewer(page, gpsIndex));
    check('Size 1080 limits the long side', small.width === 1080 && small.height === 720, `${small.width}x${small.height}`);
    const smallCam = JpegMeta.readCameraInfo(small.tiff);
    check('Size 1080 keeps camera info', smallCam.model === 'ILCE-7M4');

    // ZIP
    const [zipDownload] = await Promise.all([page.waitForEvent('download'), page.click('#zip-all')]);
    const zipPath = join(work, 'all.zip');
    await zipDownload.saveAs(zipPath);
    const listed = zipTest(zipPath).split(',');
    check('ZIP contains every JPG', listed.length === files.length && listed.every((n) => n.endsWith('.jpg')), listed.join(','));

    // Not a HEIF file
    await page.setInputFiles('#file-input', { name: 'notes.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    await page.waitForSelector('.frame[data-state="error"]');
    const errorText = await page.textContent('.frame[data-state="error"] .frame-status');
    check('non-HEIF file is reported clearly', /not a HEIF\/HIF photo/.test(errorText), errorText);

    // Offline: reload without network and convert again.
    page.once('dialog', (d) => d.accept());
    await context.setOffline(true);
    await page.reload();
    await page.setInputFiles('#file-input', join(FIXTURES, 'sony-422.HIF'));
    await waitForFrames(page, 1);
    check('works offline after the first visit', (await page.getAttribute('.frame', 'data-state')) === 'done');
    await context.setOffline(false);

    // Android share target: POST files to the share endpoint like the OS does.
    const hif = readFileSync(join(FIXTURES, 'sony-422.HIF')).toString('base64');
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const form = new FormData();
      form.append('photos', new File([bytes], 'DSC09999.HIF', { type: 'image/heif' }));
      await fetch('./share-target', { method: 'POST', body: form });
    }, hif);
    await page.goto(base + '?shared=1');
    await waitForFrames(page, 1);
    const shared = await page.$$eval('.frame', (els) => els.map((e) => e.querySelector('.frame-number').textContent + ':' + e.dataset.state));
    check('share target delivers photos to the app', shared.length === 1 && shared[0] === 'DSC09999:done', shared.join(','));
    check('share target clears the address bar', !(await page.url()).includes('shared'));

    check('no errors in the page console', errors.length === 0, errors.join(' | '));

    if (args.has('--screenshots')) await screenshots(browser, base);
    if (args.has('--large')) await largeCheck(page, base);
  } finally {
    await browser.close();
    server.close();
  }
}

async function waitForFrames(page, count, timeout = 120000) {
  await page.waitForFunction((n) => {
    const frames = [...document.querySelectorAll('.frame')];
    return frames.length >= n && frames.every((f) => f.dataset.state === 'done' || f.dataset.state === 'error');
  }, count, { timeout });
}

async function saveFromViewer(page, index) {
  await page.click(`.frame:nth-child(${index + 1}) .frame-open`);
  const [download] = await Promise.all([page.waitForEvent('download'), page.click('#viewer-save')]);
  await page.click('#viewer-close');
  const path = join(work, `dl-${Date.now()}.jpg`);
  await download.saveAs(path);
  return new Uint8Array(readFileSync(path));
}

// Where pixel (x, y) of a stored w x h image ends up once Exif orientation is applied.
function displayPoint(p, w, h, orientation) {
  switch (orientation) {
    case 3: return { x: w - 1 - p.x, y: h - 1 - p.y };
    case 6: return { x: h - 1 - p.y, y: p.x };
    case 8: return { x: p.y, y: w - 1 - p.x };
    default: return { x: p.x, y: p.y };
  }
}

async function samplePixels(page, bytes, points) {
  return page.evaluate(async ({ b64, points }) => {
    const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([data], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    return points.map((p) => {
      // Average a 5x5 block: JPEG noise and dither make single pixels jitter.
      const d = ctx.getImageData(p.x - 2, p.y - 2, 5, 5).data;
      const sum = [0, 0, 0];
      for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += d[i + k];
      return sum.map((s) => Math.round(s / 25));
    });
  }, { b64: Buffer.from(bytes).toString('base64'), points });
}

async function screenshots(browser, base) {
  const out = join(ROOT, 'tests/screenshots');
  if (!existsSync(out)) execFileSync('mkdir', ['-p', out]);
  for (const scheme of ['dark', 'light']) {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, colorScheme: scheme });
    const p = await ctx.newPage();
    await p.goto(base);
    await p.screenshot({ path: join(out, `empty-${scheme}.png`) });
    await p.setInputFiles('#file-input', fixtures().map((f) => join(FIXTURES, f)));
    await waitForFrames(p, fixtures().length);
    await p.screenshot({ path: join(out, `sheet-${scheme}.png`) });
    await p.click('.frame:nth-child(1) .frame-open');
    await p.waitForTimeout(300);
    await p.screenshot({ path: join(out, `viewer-${scheme}.png`) });
    await p.click('#viewer-close');
    await p.click('#open-settings');
    await p.waitForTimeout(200);
    await p.screenshot({ path: join(out, `settings-${scheme}.png`) });
    await ctx.close();
  }
  console.log('screenshots written to', out);
}

async function largeCheck(page, base) {
  const file = join(work, 'DSC00033.HIF');
  console.log('\n# 33 MP photo (7008x4672, 4:2:2 10-bit)');
  execFileSync('python3', [join(FIXTURES, 'make_hif.py'), file, '--width', '7008', '--height', '4672']);
  await page.goto(base);
  await page.click('#open-settings');
  await page.check('input[name="size"][value="0"]');
  await page.click('#settings button[type="submit"]');
  const t0 = Date.now();
  await page.setInputFiles('#file-input', file);
  await waitForFrames(page, 1, 300000);
  const status = await page.textContent('.frame-status');
  check('33 MP photo converts', (await page.getAttribute('.frame', 'data-state')) === 'done', `${((Date.now() - t0) / 1000).toFixed(1)} s, ${status}`);
}

await nodeChecks();
if (!args.has('--node')) await browserChecks();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
