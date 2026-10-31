/* RUNTIME v25 — Passthrough Service Worker + Android Native Share-Sheet Receiver */
const SHARE_CACHE = "runtime-share-target-v1";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => k !== SHARE_CACHE).map((k) => caches.delete(k))
      );
    } catch (_) {}
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (!req || req.method !== "POST") return;
  let pathname = "";
  try {
    pathname = new URL(req.url).pathname;
  } catch (_) {}
  if (pathname !== "/share-checkin") return;

  event.respondWith((async () => {
    try {
      const formData = await req.formData();
      const title = String(formData.get("title") || "");
      const text = String(formData.get("text") || "");
      const url = String(formData.get("url") || "");
      const file = formData.get("screenshot");
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(
        new Request("/__shared_meta__"),
        new Response(JSON.stringify({ title, text, url, hasImage: Boolean(file && file.size), ts: Date.now() }), {
          headers: { "Content-Type": "application/json" }
        })
      );
      if (file && file.size) {
        await cache.put(
          new Request("/__shared_image__"),
          new Response(file, {
            headers: { "Content-Type": file.type || "image/png" }
          })
        );
      } else {
        await cache.delete(new Request("/__shared_image__"));
      }
    } catch (_) {}
    return Response.redirect("/?shared=1#walk", 303);
  })());
});
