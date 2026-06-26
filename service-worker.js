const CACHE   = 'escales-v2';
const SHELL   = ['/', '/index.html', '/css/style.css', '/js/app.js', '/manifest.webmanifest', '/icons/icon.svg'];
const YT_CACHE = 'escales-yt-thumbs-v1';

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE && k !== YT_CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // YouTube thumbnails — cache first, then network
  if (url.hostname === 'img.youtube.com') {
    e.respondWith(
      caches.open(YT_CACHE).then(c =>
        c.match(e.request).then(cached => {
          if (cached) return cached;
          return fetch(e.request).then(res => {
            if (res.ok) c.put(e.request, res.clone());
            return res;
          });
        })
      )
    );
    return;
  }

  // External (Supabase, YouTube API, CDN) — network only
  if (url.origin !== self.location.origin) return;

  // Same-origin — cache first, fallback to network then offline shell
  e.respondWith(
    caches.match(e.request).then(cached =>
      cached || fetch(e.request).catch(() => caches.match('/index.html'))
    )
  );
});
