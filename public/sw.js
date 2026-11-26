const CACHE_VERSION = 'localshield-shell-v1';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/icon-192.svg',
  '/icons/icon-512.svg'
];

const STATIC_ASSET_PATTERN =
  /^\/assets\/|\.(?:js|mjs|css|svg|png|woff2?|webmanifest)$/i;

const BYPASS_HOST_PATTERN =
  /(?:firebase|googleapis|gstatic|google\.com|recaptcha|identitytoolkit|securetoken)/i;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
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

  // Navigation requests: network-first with cached /index.html fallback for offline reloads.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            void caches
              .open(CACHE_VERSION)
              .then((cache) => cache.put('/index.html', copy));
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
          return new Response('LocalShield offline shell unavailable.', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
          });
        })
    );
    return;
  }

  // Same-origin static assets (Vite bundles, CSS, local PDF.js worker, icons): stale-while-revalidate.
  if (STATIC_ASSET_PATTERN.test(url.pathname)) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(async (cache) => {
        const cached = await cache.match(request);
        const networkPromise = fetch(request)
          .then((response) => {
            if (response && response.ok && response.type === 'basic') {
              void cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => cached);

        return cached || networkPromise;
      })
    );
  }
});
