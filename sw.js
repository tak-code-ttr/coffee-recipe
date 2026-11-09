// アプリ本体はネット優先（更新がすぐ反映される）、オフライン時はキャッシュを使う。
// Firebase SDK はバージョン固定なのでキャッシュ優先。
const CACHE = 'coffee-recipe-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const put = (res) => { if (res.ok) { const c = res.clone(); caches.open(CACHE).then((ca) => ca.put(req, c)); } return res; };
  if (url.origin === location.origin) {
    e.respondWith(fetch(req).then(put).catch(() =>
      caches.match(req).then((r) => r || caches.match('./index.html'))));
  } else if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req).then(put)));
  }
});
