// 缓存应用外壳，离线也能打开并听写已保存的词表
const CACHE = 'dictation-v5';
// 识字工具和模型（十几 MB），地址里带着版本号，下载一次就一直用缓存
const OCR_CACHE = 'dictation-ocr-v1';
const OCR_HOSTS = ['cdn.jsdelivr.net', 'paddle-model-ecology.bj.bcebos.com'];
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== OCR_CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (OCR_HOSTS.includes(url.hostname)) {
    e.respondWith(
      caches.open(OCR_CACHE).then((c) =>
        c.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
          if (res.ok) c.put(e.request, res.clone());
          return res;
        }))
      )
    );
    return;
  }
  const sameOrigin = url.origin === location.origin;
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
