/* Дело Ритма — сервис-воркер: приложение открывается без интернета и показывает последнюю загруженную афишу.
   При каждом обновлении сайта увеличьте номер версии ниже, чтобы телефоны подтянули новую версию. */
const VERSION = "dr-v37";
const SHELL = ["./", "./index.html", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png", "./apple-theme.css", "./booking-experience.css", "./experience-v2.css", "./design-refresh.css"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const networkFirst = async req => {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (req.mode === "navigate" ? cache.match("./index.html") : Response.error());
  }
};
const staleWhileRevalidate = async req => {
  const cache = await caches.open(VERSION), hit = await cache.match(req);
  const fresh = fetch(req).then(res => { if (res.ok || res.type === "opaque") cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || fresh;
};

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return; // заявки всегда идут напрямую
  const url = new URL(req.url);
  // афиша из таблицы — свежая из сети, без сети — последняя сохранённая. Поиск детей не кэшируем.
  if (url.hostname === "script.google.com") {
    if (url.searchParams.get("action") === "shifts" || !url.searchParams.get("action")) e.respondWith(networkFirst(req));
    return;
  }
  if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") return e.respondWith(staleWhileRevalidate(req));
  if (url.origin !== location.origin) return;
  if (req.mode === "navigate") return e.respondWith(networkFirst(req));
  e.respondWith(staleWhileRevalidate(req));
});
