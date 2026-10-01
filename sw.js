// 缓存应用外壳，离线也能打开并听写已保存的词表
const CACHE = 'dictation-v4';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const sameOrigin = new URL(e.request.url).origin === location.origin;
  // 网络优先，失败时用缓存。
  // 本站文件跳过浏览器 HTTP 缓存（GitHub Pages 默认缓存 10 分钟），每次都向服务器确认是否有新版本
  e.respondWith(
    fetch(e.request, sameOrigin ? { cache: 'no-cache' } : undefined)
      .then((res) => {
        if (res.ok && sameOrigin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() =>
        // 离线时：先找完全相同的地址，找不到再忽略 ?v= 找同一个文件
        caches.match(e.request).then((r) => r || caches.match(e.request, { ignoreSearch: true }))
      )
  );
});
