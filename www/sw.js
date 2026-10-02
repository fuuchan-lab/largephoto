// オフラインでも開けるようにアプリ本体をキャッシュ（ネット優先）
const CACHE = 'largepic-v2';
const FILES = ['./', 'index.html', 'css/style.css', 'js/app.js', 'js/mosaic.js', 'js/view.js', 'js/stitcher.js',
  'js/register.js', 'js/imageutil.js', 'js/cropdialog.js', 'js/store.js', 'js/trim.js', 'js/native.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-32.png', 'icons/icon-180.png'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((r) => {
    const copy = r.clone();
    caches.open(CACHE).then((c) => c.put(e.request, copy));
    return r;
  }).catch(() => caches.match(e.request)));
});
