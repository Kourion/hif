/*
 * Service worker: keeps the whole app (including the 1.4 MB decoder) cached
 * for offline use, and receives photos shared from other Android apps.
 */
'use strict';

// The deploy workflow replaces this with the commit hash so every release
// gets a fresh cache.
const VERSION = 'dev';
const CACHE = `hif-to-jpg-${VERSION}`;
const SHARE_CACHE = 'hif-share-inbox';

const ASSETS = [
  './',
  'manifest.webmanifest',
  'css/app.css',
  'js/app.js',
  'js/zip.mjs',
  'js/worker.js',
  'js/hif-core.js',
  'js/jpeg-meta.js',
  'vendor/libheif/libheif.js',
  'vendor/libheif/libheif.wasm',
  'vendor/libheif/LICENSE',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE && k !== SHARE_CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'skip-waiting') self.skipWaiting();
});

async function receiveShare(request) {
  const form = await request.formData();
  const files = form.getAll('photos').filter((f) => typeof f !== 'string');
  const cache = await caches.open(SHARE_CACHE);
  const stamp = Date.now();
  await Promise.all(files.map((file, i) => cache.put(
    new Request(`shared/${stamp}-${i}`),
    new Response(file, {
      headers: {
        'content-type': file.type || 'application/octet-stream',
        'x-file-name': encodeURIComponent(file.name || `shared-${i + 1}.HIF`),
      },
    }),
  )));
  return Response.redirect(new URL('./?shared=1', self.registration.scope).href, 303);
}

async function fromCache(request) {
  const cache = await caches.open(CACHE);
  if (request.mode === 'navigate') {
    const page = await cache.match('./');
    if (page) return page;
  }
  const hit = await cache.match(request, { ignoreSearch: true });
  return hit || fetch(request);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(request));
    return;
  }
  if (request.method !== 'GET') return;
  event.respondWith(fromCache(request));
});
