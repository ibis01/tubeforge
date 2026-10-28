// TubeForge service worker — deliberately conservative.
//
// The app is a live dashboard driven by polling APIs; stale HTML or stale
// chunks would break it in confusing ways. So: NETWORK-FIRST for everything,
// with only two safety nets:
//   1. offline.html shown when a navigation fails (phone lost Wi-Fi to the PC)
//   2. static asset cache (icons/manifest) so the installed shell still looks right
// API calls (/api/*) are never intercepted or cached.

const CACHE = "tubeforge-v1";
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // cross-origin: pass through
  if (url.pathname.startsWith("/api/")) return; // live data: never cache

  // Navigations: network first, offline page as the safety net.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match(OFFLINE_URL).then((r) => r ?? Response.error()))
    );
    return;
  }

  // Static assets: network first, fall back to cache when the network is gone.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && (url.pathname.startsWith("/icons/") || url.pathname.startsWith("/_next/static/"))) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((r) => r ?? Response.error()))
  );
});
