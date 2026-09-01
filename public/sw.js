const APP_CACHE = "corner-ops-shell-v3";
const APP_SHELL = ["/app", "/pos/deli", "/corner-ops-icon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(APP_CACHE).then((cache) => cache.addAll(APP_SHELL)).catch(() => undefined));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== APP_CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  const posResource = url.pathname === "/pos/deli" || url.pathname === "/api/ordering/menu" || url.pathname.startsWith("/_next/static/");
  if (url.pathname !== "/app" && url.pathname !== "/corner-ops-icon.svg" && !posResource) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(APP_CACHE).then((cache) => cache.put(event.request, copy)).catch(() => undefined);
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || (url.pathname === "/pos/deli" ? caches.match("/pos/deli") : caches.match("/app")))),
  );
});

self.addEventListener("push", (event) => {
  let payload = {
    title: "Corner Ops",
    body: "You have a new notification.",
    url: "/app",
    tag: "corner-ops",
  };
  try {
    if (event.data) payload = { ...payload, ...event.data.json() };
  } catch {
    if (event.data) payload.body = event.data.text();
  }
  event.waitUntil(self.registration.showNotification(payload.title || "Corner Ops", {
    body: payload.body || "",
    icon: "/corner-ops-icon.svg",
    badge: "/corner-ops-icon.svg",
    tag: payload.tag || "corner-ops",
    renotify: true,
    data: { url: payload.url || "/app" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const destination = new URL(event.notification.data?.url || "/app", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(async (windows) => {
      for (const client of windows) {
        if ("navigate" in client) await client.navigate(destination).catch(() => undefined);
        if ("focus" in client) return client.focus();
      }
      return self.clients.openWindow(destination);
    }),
  );
});
