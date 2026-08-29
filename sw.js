/* CHANGE 2026-08-29 PWA-01: minimal service worker, intentionally network-only for the app
   itself. This app updates almost every session (v1.5.x -> v1.6.x in a matter of days) -- a
   caching service worker is the single most common cause of "why is my phone stuck on the old
   version" bugs in PWAs. So this worker does NOT cache index.html or any JS/CSS: every load goes
   straight to the network, exactly like a normal bookmark would. It exists ONLY so the app
   qualifies as an installable PWA (Chrome/Android requires a registered service worker with a
   fetch handler for the "Add to Home Screen" / install-as-app treatment; iOS Safari does not
   require this at all, but it doesn't hurt there either). The only thing actually cached is the
   two icon files, since those never change on their own and caching them costs nothing. See
   CHANGELOG for the version this shipped in. */
const ICON_CACHE = "vtp-icons-v1";
const ICONS = ["icon-192.png", "icon-512.png"];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(ICON_CACHE).then((c) => c.addAll(ICONS)).catch(() => {}));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (ICONS.some((i) => url.pathname.endsWith(i))) {
    e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
    return;
  }
  // Everything else (the HTML app itself, all JS/CSS, Supabase/weather/fx calls) is left
  // completely untouched -- no e.respondWith() means the browser just does its normal network
  // fetch, so the family always gets whatever version is actually live on GitHub Pages.
});
