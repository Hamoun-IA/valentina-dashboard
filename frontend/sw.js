const CACHE_NAME = 'valentina-v1.8';
const STATIC_ASSETS = [
  '/',
  '/voice',
  '/css/style.css',
  '/css/voice.css',
  '/js/dashboard.js',
  '/js/voice.js',
  '/assets/valentina-profile.jpg',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Orbitron:wght@400;500;600;700;800;900&family=Rajdhani:wght@300;400;500;600;700&family=JetBrains+Mono:wght@300;400;500&display=swap',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js'
];

const OFFLINE_PAGE = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Valentina — Offline</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:sans-serif;background:#05060f;color:#e8eaff;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
  .wrap{padding:2rem}
  h1{font-size:2rem;color:#00f0ff;margin-bottom:1rem;text-shadow:0 0 20px rgba(0,240,255,0.5)}
  p{color:#8b8fa3;font-size:1.1rem}
</style></head><body><div class="wrap"><h1>VALENTINA</h1><p>You are offline. Please check your connection.</p></div></body></html>`;

// Install — cache static assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('Some assets failed to cache:', err);
        // Cache what we can individually
        return Promise.allSettled(
          STATIC_ASSETS.map(url => cache.add(url).catch(() => {}))
        );
      });
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — cache-first for static, network-first for API
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Network-first for API calls and WebSocket
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request)
        .then(response => {
          if (response.ok && event.request.method === 'GET') {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline fallback for navigation requests
          if (event.request.mode === 'navigate') {
            return new Response(OFFLINE_PAGE, {
              headers: { 'Content-Type': 'text/html' }
            });
          }
        });
    })
  );
});
