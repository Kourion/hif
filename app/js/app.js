import { makeZip } from './zip.mjs';

const $ = (id) => document.getElementById(id);

const SETTINGS_KEY = 'hif-settings-v1';
const SHARE_CACHE = 'hif-share-inbox';
const DEFAULT_SETTINGS = { quality: 90, maxSize: 0, keepMetadata: true, removeGps: false };

const STAGE_TEXT = {
  queued: 'Waiting',
  reading: 'Reading file',
  decoding: 'Decoding',
  encoding: 'Saving JPG',
};

const settings = loadSettings();
const items = [];
let nextId = 1;
let nextJob = 1;

// ------------------------------------------------------------------ settings

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return Object.assign({}, DEFAULT_SETTINGS, saved);
  } catch (e) {
    return Object.assign({}, DEFAULT_SETTINGS);
  }
}

function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    // Private mode or storage disabled: settings last for this session only.
  }
}

function bindSettings() {
  const quality = $('quality');
  const qualityValue = $('quality-value');
  const keep = $('keep-meta');
  const gps = $('remove-gps');

  quality.value = settings.quality;
  qualityValue.textContent = settings.quality;
  quality.addEventListener('input', () => {
    settings.quality = Number(quality.value);
    qualityValue.textContent = settings.quality;
    saveSettings();
  });

  for (const radio of document.querySelectorAll('input[name="size"]')) {
    radio.checked = Number(radio.value) === settings.maxSize;
    radio.addEventListener('change', () => {
      settings.maxSize = Number(radio.value);
      saveSettings();
    });
  }

  keep.checked = settings.keepMetadata;
  gps.checked = settings.removeGps;
  gps.disabled = !settings.keepMetadata;
  keep.addEventListener('change', () => {
    settings.keepMetadata = keep.checked;
    gps.disabled = !keep.checked;
    saveSettings();
  });
  gps.addEventListener('change', () => {
    settings.removeGps = gps.checked;
    saveSettings();
  });

  $('open-settings').addEventListener('click', () => {
    $('reconvert-field').hidden = !items.some((it) => it.state === 'done' || it.state === 'error');
    $('settings').showModal();
  });
  $('reconvert').addEventListener('click', () => {
    $('settings').close();
    for (const it of items) {
      if (it.state === 'done' || it.state === 'error') requeue(it);
    }
    pump();
  });
  closeOnBackdrop($('settings'));
}

function jobOptions() {
  return {
    quality: settings.quality / 100,
    maxSize: settings.maxSize,
    keepMetadata: settings.keepMetadata,
    removeGps: settings.keepMetadata && settings.removeGps,
  };
}

// ------------------------------------------------------------------ workers
//
// Camera HIF files are grids of independently coded tiles, so every photo is
// shared between all workers: one "lead" worker opens it and owns the output
// canvas, any idle worker decodes tiles, and decoded tiles are forwarded to
// the lead, which finally encodes the JPG. Two photos may be in flight so
// workers keep busy while a lead is encoding.

const slots = []; // { worker, pending }
const jobs = new Map(); // job id -> { id, item, lead, options, opened, tiles, next, received }

function poolSize() {
  const cores = navigator.hardwareConcurrency || 4;
  const memory = navigator.deviceMemory || 4;
  // Each worker keeps its own copy of the photo (about 40 MB with the decoder).
  return Math.max(1, Math.min(cores, memory >= 8 ? 6 : memory >= 4 ? 3 : 2));
}

function maxActiveJobs() {
  // Each photo in flight holds a full-size canvas (130 MB for 33 MP).
  return (navigator.deviceMemory || 4) >= 6 ? 2 : 1;
}

function createSlot() {
  const slot = { worker: new Worker(new URL('./worker.js', import.meta.url)), pending: 0 };
  slot.worker.onmessage = (event) => onWorkerMessage(slot, event.data);
  slot.worker.onerror = (event) => {
    event.preventDefault();
    workerCrashed(slot);
  };
  slots.push(slot);
  return slot;
}

function idleSlot() {
  return slots.find((s) => s.pending === 0) || (slots.length < poolSize() ? createSlot() : null);
}

function send(slot, msg, transfer) {
  slot.pending++;
  slot.worker.postMessage(msg, transfer || []);
}

function broadcastClose(jobId) {
  for (const slot of slots) slot.worker.postMessage({ type: 'close', job: jobId });
}

function onWorkerMessage(slot, msg) {
  if (msg.type === 'fatal') {
    toast(msg.message);
    return;
  }
  if (msg.type !== 'put-error') slot.pending = Math.max(0, slot.pending - 1);
  const job = jobs.get(msg.job);
  if (job) {
    if (msg.type === 'opened') jobOpened(job, msg);
    else if (msg.type === 'tile') tileDecoded(job, msg);
    else if (msg.type === 'done') jobDone(job, msg.result);
    else if (msg.type === 'error' || msg.type === 'put-error') jobFailed(job, msg.message);
  }
  pump();
}

function jobOpened(job, msg) {
  job.opened = true;
  job.tiles = [];
  for (let ty = 0; ty < msg.rows; ty++) for (let tx = 0; tx < msg.columns; tx++) job.tiles.push([tx, ty]);
  job.item.el.querySelector('.frame-readout').textContent = readout(msg.camera);
  setState(job.item, 'decoding');
  setProgress(job.item, 0);
}

function tileDecoded(job, msg) {
  job.lead.worker.postMessage(
    { type: 'put', job: job.id, x: msg.x, y: msg.y, width: msg.width, height: msg.height, rgba: msg.rgba },
    [msg.rgba.buffer],
  );
  job.received++;
  setProgress(job.item, job.received / job.tiles.length);
  if (job.received === job.tiles.length) {
    send(job.lead, { type: 'finish', job: job.id, options: job.options });
    setState(job.item, 'encoding');
  }
}

function jobDone(job, result) {
  jobs.delete(job.id);
  broadcastClose(job.id);
  finish(job.item, result);
}

function jobFailed(job, message) {
  jobs.delete(job.id);
  broadcastClose(job.id);
  fail(job.item, message);
}

function workerCrashed(slot) {
  // A worker that dies (usually out of memory) may hold tiles of any photo
  // in flight, so those photos fail and the rest of the queue carries on.
  slot.worker.terminate();
  slots.splice(slots.indexOf(slot), 1);
  for (const job of [...jobs.values()]) {
    jobFailed(job, 'The converter ran out of memory. Close other apps or pick a smaller size in Settings.');
  }
  pump();
}

function pump() {
  for (;;) {
    // Tiles of photos that are already open come first ...
    const job = [...jobs.values()].find((j) => j.opened && j.next < j.tiles.length);
    if (job) {
      const slot = idleSlot();
      if (!slot) break;
      const [tx, ty] = job.tiles[job.next++];
      send(slot, { type: 'tile', job: job.id, file: job.item.file, tx, ty });
      continue;
    }
    // ... then start the next photo if there is room for it.
    const item = jobs.size < maxActiveJobs() && items.find((it) => it.state === 'queued');
    if (!item) break;
    const lead = idleSlot();
    if (!lead) break;
    const id = item.id + ':' + nextJob++;
    const newJob = { id, item, lead, options: jobOptions(), opened: false, tiles: [], next: 0, received: 0 };
    jobs.set(id, newJob);
    setState(item, 'reading');
    send(lead, { type: 'open', job: id, file: item.file, lead: true });
  }
  updateSummary();
}

function cancelAll() {
  for (const slot of slots.splice(0)) slot.worker.terminate();
  jobs.clear();
}

// ------------------------------------------------------------------ items

function splitName(name) {
  const stem = name.replace(/\.[^.]+$/, '') || name;
  const m = stem.match(/^(.*?)(\d{3,})$/);
  return { stem, prefix: m ? m[1] : '', digits: m ? m[2] : stem };
}

function outputName(stem) {
  const taken = new Set(items.map((it) => it.outName));
  let name = `${stem}.jpg`;
  for (let n = 2; taken.has(name); n++) name = `${stem}-${n}.jpg`;
  return name;
}

function addFiles(fileList) {
  const files = Array.from(fileList || []).filter((f) => f && f.size > 0);
  if (!files.length) return;
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  for (const file of files) {
    const parts = splitName(file.name);
    const item = {
      id: nextId++,
      file,
      name: file.name,
      stem: parts.stem,
      outName: '',
      state: 'queued',
      result: null,
      url: null,
      previewUrl: null,
      el: null,
    };
    item.outName = outputName(parts.stem);
    item.el = renderFrame(item, parts);
    items.push(item);
  }
  showSheet();
  pump();
}

function renderFrame(item, parts) {
  const node = $('frame-template').content.firstElementChild.cloneNode(true);
  node.querySelector('.frame-prefix').textContent = parts.prefix;
  node.querySelector('.frame-digits').textContent = parts.digits;
  node.querySelector('.frame-open').setAttribute('aria-label', `Open ${item.name}`);
  node.querySelector('.frame-open').addEventListener('click', () => openViewer(item));
  $('frames').insertBefore(node, $('add-slot'));
  item.el = node;
  setState(item, 'queued');
  return node;
}

function setState(item, state) {
  item.state = state;
  item.el.dataset.state = state;
  if (STAGE_TEXT[state]) item.el.querySelector('.frame-status').textContent = STAGE_TEXT[state];
  updateSummary();
}

function setProgress(item, fraction) {
  item.el.style.setProperty('--progress', (0.05 + fraction * 0.85).toFixed(3));
  item.el.querySelector('.frame-status').textContent = `${STAGE_TEXT.decoding} ${Math.round(fraction * 100)}%`;
}

function requeue(item) {
  releaseUrls(item);
  item.el.style.removeProperty('--progress');
  item.result = null;
  const img = item.el.querySelector('.frame-img');
  img.hidden = true;
  img.removeAttribute('src');
  item.el.querySelector('.frame-open').disabled = true;
  item.el.querySelector('.frame-readout').textContent = '';
  setState(item, 'queued');
}

function finish(item, result) {
  releaseUrls(item);
  item.result = result;
  item.url = URL.createObjectURL(result.jpeg);
  item.previewUrl = URL.createObjectURL(result.preview);
  const img = item.el.querySelector('.frame-img');
  img.src = item.previewUrl;
  img.alt = item.name;
  img.hidden = false;
  item.el.querySelector('.frame-open').disabled = false;
  item.el.querySelector('.frame-readout').textContent = readout(result.camera);
  const status = item.el.querySelector('.frame-status');
  status.textContent = `${result.width} × ${result.height}${GAP}${formatBytes(result.jpeg.size)}`;
  if (result.info.hdr) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = result.info.hdr;
    tag.title = `${result.info.hdr} HDR, tone-mapped to SDR`;
    status.append(tag);
  }
  setState(item, 'done');
  if (result.warnings.length) toast(`${item.name}: ${result.warnings[0]}`);
}

function fail(item, message) {
  item.el.querySelector('.frame-status').textContent = message;
  setState(item, 'error');
}

function releaseUrls(item) {
  if (item.url) URL.revokeObjectURL(item.url);
  if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  item.url = item.previewUrl = null;
}

function clearAll() {
  const busy = items.some((it) => it.state !== 'done' && it.state !== 'error');
  if (busy && !confirm('Stop converting and remove all photos from the list?')) return;
  cancelAll();
  for (const it of items) releaseUrls(it);
  items.length = 0;
  for (const el of $('frames').querySelectorAll('.frame')) el.remove();
  showSheet();
  warmUp();
}

function doneItems() {
  return items.filter((it) => it.state === 'done');
}

function updateSummary() {
  const total = items.length;
  const done = doneItems().length;
  const failed = items.filter((it) => it.state === 'error').length;
  let text;
  if (done + failed === total) {
    text = `${done} ${done === 1 ? 'photo' : 'photos'} converted`;
    if (failed) text += `, ${failed} failed`;
  } else {
    text = `Converting ${done + failed + 1} of ${total}`;
  }
  $('summary').textContent = text;
  const none = done === 0;
  $('save-all').disabled = none;
  $('share-all').disabled = none;
  $('zip-all').disabled = none;
  $('save-all').querySelector('span').textContent = done > 1 ? `Save all ${done}` : 'Save';
}

function showSheet() {
  const has = items.length > 0;
  $('intake').hidden = has;
  $('sheet').hidden = !has;
  $('actionbar').hidden = !has;
  document.body.classList.toggle('has-photos', has);
  if (has) updateSummary();
}

// ------------------------------------------------------------------ formatting

// Wide gaps between readout groups, like the data line on a camera screen.
const GAP = '\u2002\u2002';

function formatBytes(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1e3))} KB`;
}

function formatExposure(t) {
  if (!t) return '';
  if (t >= 1) return `${Math.round(t * 10) / 10}"`;
  return `1/${Math.round(1 / t)}`;
}

function readout(cam, withFocalLength = false) {
  if (!cam) return '';
  const parts = [];
  if (cam.fNumber) parts.push(`f/${Math.round(cam.fNumber * 10) / 10}`);
  if (cam.exposure) parts.push(formatExposure(cam.exposure));
  if (cam.iso) parts.push(`ISO ${cam.iso}`);
  if (withFocalLength && cam.focalLength) parts.push(`${Math.round(cam.focalLength)}mm`);
  return parts.join(GAP);
}

function formatDate(exifDate) {
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2})/.exec(exifDate || '');
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const TRANSFER_NAMES = { 1: 'BT.709', 13: 'sRGB', 16: 'PQ (HDR)', 18: 'HLG (HDR)' };

// ------------------------------------------------------------------ saving and sharing

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function saveAll() {
  const list = doneItems();
  if (!list.length) return;
  if (list.length > 1 && 'showDirectoryPicker' in window) {
    let dir;
    try {
      dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'hif-jpg', startIn: 'pictures' });
    } catch (e) {
      if (e.name === 'AbortError') return;
      dir = null;
    }
    if (dir) {
      try {
        for (const it of list) {
          const handle = await dir.getFileHandle(it.outName, { create: true });
          const w = await handle.createWritable();
          await w.write(it.result.jpeg);
          await w.close();
        }
        toast(`Saved ${list.length} photos to ${dir.name}`);
        return;
      } catch (e) {
        toast(`Could not write to that folder (${e.message}). Downloading instead.`);
      }
    }
  }
  for (const it of list) {
    download(it.result.jpeg, it.outName);
    // Browsers drop rapid-fire downloads; give each one a moment.
    if (list.length > 1) await pause(350);
  }
  if (list.length > 1) toast(`Saving ${list.length} photos to Downloads. Allow multiple downloads if asked.`);
}

function zipAll() {
  const list = doneItems();
  if (!list.length) return;
  try {
    const zip = makeZip(list.map((it) => ({ name: it.outName, blob: it.result.jpeg, crc: it.result.crc })));
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    download(zip, `hif-to-jpg-${stamp}.zip`);
  } catch (e) {
    toast(e.message);
  }
}

async function share(list) {
  if (!list.length) return;
  const files = list.map((it) => new File([it.result.jpeg], it.outName, { type: 'image/jpeg' }));
  if (!navigator.canShare || !navigator.canShare({ files })) {
    toast(list.length > 1
      ? 'This browser cannot share these photos together. Try Save instead.'
      : 'This browser cannot share photos. Use Save instead.');
    return;
  }
  try {
    await navigator.share({ files });
  } catch (e) {
    if (e.name === 'AbortError') return;
    toast(list.length > 1
      ? `Sharing ${list.length} photos at once failed. Try fewer, or use Save all.`
      : `Sharing failed: ${e.message}`);
  }
}

// ------------------------------------------------------------------ viewer

let viewerItem = null;

function openViewer(item) {
  if (item.state !== 'done') return;
  viewerItem = item;
  const r = item.result;
  $('viewer-title').textContent = item.outName;
  const img = $('viewer-img');
  img.src = item.url;
  img.alt = item.outName;
  const rows = [];
  const cam = r.camera || {};
  if (cam.model) rows.push(['Camera', cam.model]);
  if (cam.lens) rows.push(['Lens', cam.lens]);
  const exposure = readout(cam, true);
  if (exposure) rows.push(['Exposure', exposure]);
  if (cam.date) rows.push(['Taken', formatDate(cam.date)]);
  rows.push(['JPG', `${r.width} × ${r.height}${GAP}${formatBytes(r.jpeg.size)}`]);
  rows.push(['Source', `${r.info.bitDepth}-bit ${r.info.chroma}${GAP}${r.sourceWidth} × ${r.sourceHeight}`]);
  if (r.info.hdr) rows.push(['Colour', `${TRANSFER_NAMES[r.info.colour.transfer]}, tone-mapped to SDR`]);
  const dl = $('viewer-details');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    dl.append(dt, dd);
  }
  const done = doneItems();
  const i = done.indexOf(item);
  $('viewer-prev').hidden = i <= 0;
  $('viewer-next').hidden = i < 0 || i >= done.length - 1;
  if (!$('viewer').open) $('viewer').showModal();
}

function stepViewer(dir) {
  const done = doneItems();
  const next = done[done.indexOf(viewerItem) + dir];
  if (next) openViewer(next);
}

function bindViewer() {
  const viewer = $('viewer');
  $('viewer-close').addEventListener('click', () => viewer.close());
  $('viewer-prev').addEventListener('click', () => stepViewer(-1));
  $('viewer-next').addEventListener('click', () => stepViewer(1));
  $('viewer-save').addEventListener('click', () => viewerItem && download(viewerItem.result.jpeg, viewerItem.outName));
  $('viewer-share').addEventListener('click', () => viewerItem && share([viewerItem]));
  viewer.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') stepViewer(-1);
    if (e.key === 'ArrowRight') stepViewer(1);
  });
  viewer.addEventListener('close', () => {
    $('viewer-img').removeAttribute('src');
    viewerItem = null;
  });
  // Horizontal swipe to move between photos.
  let startX = null;
  const stage = viewer.querySelector('.viewer-stage');
  stage.addEventListener('pointerdown', (e) => { startX = e.clientX; });
  stage.addEventListener('pointerup', (e) => {
    if (startX === null) return;
    const dx = e.clientX - startX;
    startX = null;
    if (Math.abs(dx) > 60) stepViewer(dx < 0 ? 1 : -1);
  });
}

function closeOnBackdrop(dialog) {
  dialog.addEventListener('click', (e) => {
    if (e.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    if (!inside) dialog.close();
  });
}

// ------------------------------------------------------------------ toast

let toastTimer = 0;

function toast(text, action) {
  const el = $('toast');
  $('toast-text').textContent = text;
  const btn = $('toast-action');
  btn.hidden = !action;
  if (action) {
    btn.textContent = action.label;
    btn.onclick = () => {
      el.hidden = true;
      action.run();
    };
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  if (!action) toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

// ------------------------------------------------------------------ input sources

function bindInputs() {
  const input = $('file-input');
  const pick = () => input.click();
  $('pick').addEventListener('click', pick);
  $('add-more').addEventListener('click', pick);
  input.addEventListener('change', () => {
    addFiles(input.files);
    input.value = '';
  });

  let depth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    depth++;
    document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) document.body.classList.remove('dragging');
  });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    addFiles(e.dataTransfer && e.dataTransfer.files);
  });

  $('save-all').addEventListener('click', saveAll);
  $('share-all').addEventListener('click', () => share(doneItems()));
  $('zip-all').addEventListener('click', zipAll);
  $('clear-all').addEventListener('click', clearAll);

  // Files opened with the installed app (desktop file handlers).
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (params) => {
      if (!params.files || !params.files.length) return;
      addFiles(await Promise.all(params.files.map((h) => h.getFile())));
    });
  }
}

// Files shared to the app from Android's share sheet are parked in a cache by
// the service worker (see sw.js) and picked up here.
async function receiveSharedFiles() {
  const url = new URL(location.href);
  if (!url.searchParams.has('shared')) return;
  history.replaceState(null, '', url.pathname);
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const files = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (res) {
        const name = decodeURIComponent(res.headers.get('x-file-name') || 'shared.HIF');
        files.push(new File([await res.blob()], name, { type: res.headers.get('content-type') || '' }));
      }
      await cache.delete(req);
    }
    addFiles(files);
  } catch (e) {
    toast('Could not open the shared photos. Try opening them from the app instead.');
  }
}

// ------------------------------------------------------------------ install and offline

function bindInstall() {
  let deferred = null;
  const btn = $('install');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    btn.hidden = false;
  });
  btn.addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    btn.hidden = true;
  });
  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    toast('Installed. Open HIF to JPG from your home screen, even offline.');
  });
}

async function registerServiceWorker() {
  const status = $('offline-status');
  if (!('serviceWorker' in navigator)) {
    status.textContent = 'This browser cannot keep the app for offline use.';
    return;
  }
  try {
    const reg = await navigator.serviceWorker.register('sw.js');
    let updateRequested = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!updateRequested) return;
      updateRequested = false;
      location.reload();
    });
    const showUpdate = (worker) => {
      toast('A new version is ready.', {
        label: 'Update',
        run: () => {
          if (items.length && !confirm('Updating reloads the app and clears the list. Save your photos first. Update now?')) return;
          updateRequested = true;
          worker.postMessage({ type: 'skip-waiting' });
        },
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) showUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const worker = reg.installing;
      worker.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(worker);
      });
    });
    await navigator.serviceWorker.ready;
    status.textContent = 'Ready to work offline.';
  } catch (e) {
    status.textContent = 'Offline use is not available here (the app must be served over HTTPS).';
  }
}

function warmUp() {
  // Start one worker early so the decoder is compiled before the first photo.
  if (!slots.length) createSlot().worker.postMessage({ type: 'warmup' });
}

// ------------------------------------------------------------------ start

function checkSupport() {
  const missing = [];
  if (typeof Worker === 'undefined') missing.push('web workers');
  if (typeof WebAssembly === 'undefined') missing.push('WebAssembly');
  if (typeof OffscreenCanvas === 'undefined') missing.push('OffscreenCanvas');
  if (missing.length) {
    $('pick').disabled = true;
    $('pick-label').textContent = 'This browser is too old';
    toast(`This browser is missing ${missing.join(', ')}. Use a current version of Chrome, Edge, Firefox or Samsung Internet.`);
    return false;
  }
  return true;
}

bindSettings();
bindViewer();
bindInputs();
bindInstall();
registerServiceWorker();
if (checkSupport()) {
  warmUp();
  receiveSharedFiles();
}
