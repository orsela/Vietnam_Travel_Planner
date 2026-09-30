/* CHANGE 2026-09-30 APP-OFFLINE-01 (v2.12.0, PRD TASK-104): the app now opens with no network.
   What changed from the PWA-01 version (network-only, icons cached): page navigations are now
   NETWORK-FIRST with a cache fallback — online, the family still always gets the live version from
   GitHub Pages (the concern that made PWA-01 network-only); every successful load refreshes the
   cached copy; offline (or no answer within 6 seconds, e.g. weak airport Wi-Fi) the last cached
   copy is served. The Supabase library from jsdelivr is cached the same way so the app starts
   offline. Supabase data / weather / fx / Google calls are still left to the network (the app
   already falls back to its local data for those). Revert: set SHELL_OFFLINE = false. */
const SHELL_OFFLINE = true;
const ICON_CACHE = "vtp-icons-v1";
const SHELL_CACHE = "vtp-shell-v1";
const ICONS = ["icon-192.png", "icon-512.png"];
const NAV_TIMEOUT_MS = 6000;

self.addEventListener("install", (e) => {
  self.skipWaiting();
  e.waitUntil(Promise.all([
    caches.open(ICON_CACHE).then((c) => c.addAll(ICONS)).catch(() => {}),
    SHELL_OFFLINE ? caches.open(SHELL_CACHE).then((c) => c.add("./")).catch(() => {}) : Promise.resolve()
  ]));
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    if (!SHELL_OFFLINE) await caches.delete(SHELL_CACHE);
    await self.clients.claim();
  })());
});

function shellKey(url) {
  // one cached copy of the app regardless of "index.html" / query string
  const u = new URL(url);
  u.search = ""; u.hash = "";
  if (u.pathname.endsWith("/index.html")) u.pathname = u.pathname.slice(0, -"index.html".length);
  return u.href;
}

async function networkFirst(request, key, timeoutMs) {
  const cache = await caches.open(SHELL_CACHE);
  const net = fetch(request).then((res) => {
    if (res && (res.ok || res.type === "opaque")) cache.put(key, res.clone()).catch(() => {});
    return res;
  });
  const cached = () => cache.match(key);
  if (!timeoutMs) {
    try { return await net; } catch (err) { const c = await cached(); if (c) return c; throw err; }
  }
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(async () => {
      const c = await cached();
      if (c && !done) { done = true; resolve(c); }
    }, timeoutMs);
    net.then((res) => { if (!done) { done = true; clearTimeout(timer); resolve(res); } })
      .catch(async (err) => {
        clearTimeout(timer);
        if (done) return;
        const c = await cached();
        done = true;
        c ? resolve(c) : reject(err);
      });
  });
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (ICONS.some((i) => url.pathname.endsWith(i))) {
    e.respondWith(caches.match(req).then((r) => r || fetch(req)));
    return;
  }
  if (!SHELL_OFFLINE) return;
  if (req.mode === "navigate" && url.origin === self.location.origin) {
    e.respondWith(networkFirst(req, shellKey(req.url), NAV_TIMEOUT_MS));
    return;
  }
  if (url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("/@supabase/supabase-js")) {
    e.respondWith(networkFirst(req, url.href, 0));
    return;
  }
  if (url.origin === self.location.origin && /\/(manifest\.webmanifest|manifest\.json|apple-touch-icon\.png)$/.test(url.pathname)) {
    e.respondWith(networkFirst(req, url.href, 0));
    return;
  }
  // Everything else (Supabase data, weather, fx, Google, the update check) goes straight to the network.
});
