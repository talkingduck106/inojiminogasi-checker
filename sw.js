// オフラインでも開けるようにする仕組み（Service Worker）
// 画面のファイルは保存しておき、データ(data.json)は毎回取りに行って、取れなければ保存分を使う
const CACHE = 'oshi-v12';
const SHELL = ['./', 'index.html', 'app.css', 'app.js', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-512.png', 'logos/il.png', 'logos/nm.png', 'logos/nj.png', 'logos/ch.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // 画面のファイルもデータも「まずネット、ダメなら保存分」。更新がすぐ反映される
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
