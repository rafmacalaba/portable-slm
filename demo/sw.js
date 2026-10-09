// App-shell service worker (template; vite.config.js injects the file list at build time).
// Model weights are NOT handled here: the runtime caches them itself.
const FILES = self.__PRECACHE__;
const PREFIX = "portable-slm-shell-";
const CACHE = PREFIX + self.__VERSION__;

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "PORTABLE_SLM_READINESS" || !event.ports[0]) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const missing = [];
    for (const file of FILES) {
      if (!(await cache.match(new URL(file, self.registration.scope).href, { ignoreVary: true }))) missing.push(file);
    }
    event.ports[0].postMessage({ ready: missing.length === 0, missing });
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Never intercept authenticated host API responses: the assistant's context reads must reach the network.
  if (request.method !== "GET" || url.origin !== location.origin || /\/(?:index\.php\/)?api\//.test(url.pathname)) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true, ignoreVary: true }).then(
      (hit) =>
        hit ??
        fetch(request).catch(() => (request.mode === "navigate" ? caches.match("./") : Response.error())),
    ),
  );
});
