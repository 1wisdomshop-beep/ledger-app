// ---------------------------------------------------------------
// service-worker.js -- app-shell caching so Ledger keeps working
// offline after the first visit, and can be "installed" to a
// phone's home screen. Bump CACHE_NAME whenever shipping an
// update to force clients to pick up the new files.
// ---------------------------------------------------------------
const CACHE_NAME = "ledger-app-v1";

const CORE_ASSETS = [
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/app.js",
  "./js/db.js",
  "./js/i18n.js",
  "./js/vendor/sql-wasm.js",
  "./js/vendor/sql-wasm-binary.js",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(CORE_ASSETS);
      // Best-effort: only works if the host serves index.html for "/".
      // Kept separate from the block above so an unusual host config
      // can't fail the whole install.
      try {
        await cache.add("./");
      } catch (err) {
        /* ignored */
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)));
      await self.clients.claim();
    })()
  );
});

// Stale-while-revalidate for same-origin GET requests: respond from
// cache instantly when available (works offline, feels instant even
// online), while refreshing the cache in the background for next time.
// Cross-origin requests (Google Fonts) are left to the browser as-is.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
