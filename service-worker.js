const CACHE_NAME = 'gamegram-cache-v3'; // updated version
const urlsToCache = [
  '/',
  '/index.html',
  '/style.css',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/features/index.html',
  '/about/index.html',
  '/offline.html' // Fallback page for offline use
];

// Install event: Cache all the necessary files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(urlsToCache);
    })
  );
});

// Activate event: Remove old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(cacheNames =>
      Promise.all(
        cacheNames
          .filter(name => name !== CACHE_NAME) // Remove old caches
          .map(name => caches.delete(name))
      )
    )
  );
});

// Fetch event: Serve files from cache and update in background
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(event.request).then(cachedResponse => {
        const fetchPromise = fetch(event.request)
          .then(networkResponse => {
            // Only cache valid responses (status 200 and basic type)
            if (
              networkResponse &&
              networkResponse.status === 200 &&
              networkResponse.type === 'basic'
            ) {
              cache.put(event.request, networkResponse.clone());
            }
            return networkResponse;
          })
          .catch(() => {
            // If fetch fails (e.g., offline), serve cached response or offline fallback page
            return cachedResponse || caches.match('/offline.html');
          });

        // Serve the cached version immediately, and update the cache in the background
        return cachedResponse || fetchPromise;
      })
    )
  );
});
