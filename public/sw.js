const CACHE_NAME = "sarah-crm-v1";
self.addEventListener("install", e => e.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(["/painel"]))));
self.addEventListener("fetch", e => e.respondWith(fetch(e.request).catch(() => caches.match(e.request))));
self.addEventListener("activate", e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))));
