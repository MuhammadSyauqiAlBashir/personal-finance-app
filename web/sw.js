// Offline app shell + push notifications. /api is never cached.
// The deploy script stamps VERSION so each release gets a fresh cache.
const VERSION = "__VERSION__"
const CACHE = "finance-" + VERSION
const JS = ["app", "lib", "charts", "home", "inbox", "wallets", "reports", "advisor", "settings", "setup"]
const SHELL = ["/", "/app.css?v=" + VERSION, ...JS.map((n) => `/js/${n}.js?v=${VERSION}`),
  "/manifest.webmanifest", "/icons/icon-180.png", "/icons/icon-192.png"]

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()))
})

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url)
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return
  if (e.request.mode === "navigate") {
    e.respondWith(fetch(e.request).catch(() => caches.match("/")))
    return
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)))
})

self.addEventListener("push", (e) => {
  let data = {}
  try { data = e.data ? e.data.json() : {} } catch (_) { data = { title: "Financial Management", body: e.data && e.data.text() } }
  e.waitUntil(self.registration.showNotification(data.title || "Financial Management", {
    body: data.body || "", tag: data.tag || undefined, renotify: !!data.tag,
    icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", data: { url: data.url || "/" },
  }))
})

self.addEventListener("notificationclick", (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || "/"
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
    for (const c of all) {
      if ("focus" in c) {
        c.postMessage({ type: "navigate", url })
        return c.focus()
      }
    }
    return self.clients.openWindow(url)
  })())
})
