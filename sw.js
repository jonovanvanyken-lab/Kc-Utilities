/* Kč Utilities service worker: lets the app open offline. The app's own code is fetched fresh when online
   (network first), so an old copy is never mixed with a new one. Fonts and icons are cache first.
   It never touches GitHub API traffic. */
const VERSION = "kc-meters-1.0";
const SHELL = ["./", "index.html", "app.css?v=1.0", "app.js?v=1.0", "manifest.webmanifest"];
const STATIC = ["icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png", "icons/apple-touch-icon.png", "icons/favicon-32.png",
  "fonts/barlow-latin-400-normal.woff2", "fonts/barlow-latin-500-normal.woff2", "fonts/barlow-latin-600-normal.woff2",
  "fonts/barlow-latin-ext-400-normal.woff2", "fonts/barlow-latin-ext-500-normal.woff2", "fonts/barlow-latin-ext-600-normal.woff2",
  "fonts/barlow-condensed-latin-500-normal.woff2", "fonts/barlow-condensed-latin-600-normal.woff2", "fonts/barlow-condensed-latin-700-normal.woff2",
  "fonts/barlow-condensed-latin-ext-500-normal.woff2", "fonts/barlow-condensed-latin-ext-600-normal.woff2", "fonts/barlow-condensed-latin-ext-700-normal.woff2",
  "fonts/martian-mono-latin-400-normal.woff2", "fonts/martian-mono-latin-600-normal.woff2",
  "fonts/martian-mono-latin-ext-400-normal.woff2", "fonts/martian-mono-latin-ext-600-normal.woff2"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL.concat(STATIC).map(u => new Request(u, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (/\/(icons|fonts)\//.test(url.pathname)) {
    e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  e.respondWith(fetch(e.request, { cache: "no-cache" }).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
    return res;
  }).catch(() => caches.match(e.request).then(hit => hit || caches.match("index.html"))));
});
