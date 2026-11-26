const CACHE_VERSION = 'localshield-shell-v2';
const MAX_ASSET_CACHE_ENTRIES = 60;
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/legalease-logo.jpg',
  '/pdf.worker.min.mjs'
];

const STATIC_ASSET_PATTERN =
  /^\/assets\/|\.(?:js|mjs|css|svg|png|jpe?g|woff2?|webmanifest)$/i;

// Defense-in-depth host bypass (cross-origin requests already return early above).
const BYPASS_HOST_PATTERN =
  /(?:firebase|googleapis|gstatic|google\.com|recaptcha|identitytoolkit|securetoken)/i;

async function trimAssetCache(cache) {
  const keys = await cache.keys();
  const assetKeys = keys.filter((req) => {
    try {
      return new URL(req.url).pathname.startsWith('/assets/');
    } catch {
      return false;
    }
  });
  if (assetKeys.length > MAX_ASSET_CACHE_ENTRIES) {
    const excess = assetKeys.length - MAX_ASSET_CACHE_ENTRIES;
    await Promise.all(assetKeys.slice(0, excess).map((req) => cache.delete(req)));
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_VERSION)
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  if (request.method !== 'GET') {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Never intercept cross-origin traffic (Firebase AI Logic, App Check, reCAPTCHA, Google APIs).
  if (url.origin !== self.location.origin) {
    return;
  }

  if (BYPASS_HOST_PATTERN.test(url.hostname)) {
    return;
  }

  // Never intercept Firebase Hosting reserved auth/config endpoints.
  if (
    url.pathname.startsWith('/__/auth/') ||
    url.pathname.startsWith('/__/firebase/')
  ) {
    return;
  }

  // Navigation requests: network-first with cached /index.html fallback for offline reloads.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (
            response &&
            response.ok &&
            response.type === 'basic' &&
            (url.pathname === '/' || url.pathname === '/index.html')
          ) {
            const copy = response.clone();
            event.waitUntil(
              caches
                .open(CACHE_VERSION)
                .then((cache) => cache.put('/index.html', copy))
            );
          }
          return response;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_VERSION);
          const cachedIndex =
            (await cache.match('/index.html')) || (await cache.match('/'));
          if (cachedIndex) {
            return cachedIndex;
          }
          return new Response(
            '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>LocalShield Offline</title><style>body{font-family:system-ui,sans-serif;background:#0b1120;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:1.5rem}main{max-width:420px;text-align:center}h1{font-size:1.25rem;margin-bottom:.5rem}p{color:#94a3b8;font-size:.95rem;line-height:1.5}</style></head><body><main><h1>LocalShield Offline Shell Unavailable</h1><p>Reconnect to the network to load the application shell.</p></main></body></html>',
            {
              status: 503,
              statusText: 'Service Unavailable',
              headers: { 'Content-Type': 'text/html; charset=utf-8' }
            }
          );
        })
    );
    return;
  }

  // Same-origin static assets (Vite bundles, CSS, local PDF.js worker, icons): stale-while-revalidate.
  if (STATIC_ASSET_PATTERN.test(url.pathname)) {
    const cacheUpdatePromise = caches.open(CACHE_VERSION).then(async (cache) => {
      const cached = await cache.match(request);
      const networkPromise = fetch(request)
        .then(async (response) => {
          if (response && response.ok && response.type === 'basic') {
            await cache.put(request, response.clone());
            if (url.pathname.startsWith('/assets/')) {
              await trimAssetCache(cache);
            }
          }
          return response;
        })
        .catch(() => cached);

      return { cached, networkPromise };
    });

    event.waitUntil(cacheUpdatePromise.then(({ networkPromise }) => networkPromise));

    event.respondWith(
      cacheUpdatePromise.then(async ({ cached, networkPromise }) => {
        const resolved = cached || (await networkPromise);
        return (
          resolved ||
          new Response('Offline', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          })
        );
      })
    );
  }
});
