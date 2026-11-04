const SHELL_CACHE = "studio-ide-shell-v8";
const RUNTIME_CACHE = "studio-ide-runtime-v1";

const APP_SHELL_URLS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./assets/icon.svg",
  "./assets/apple-touch-icon.png",
  "./assets/icon-512.png",
  "./css/tokens.css",
  "./css/base.css",
  "./css/layout.css",
  "./css/editor.css",
  "./css/chat.css",
  "./css/workspace.css",
  "./css/app.css",
  "./js/app.js",
  "./js/ui/icons.js",
  "./js/ui/layout.js",
  "./js/ui/symbolBar.js",
  "./js/ui/explorerController.js",
  "./js/ui/diffModal.js",
  "./js/ui/livePreviewModal.js",
  "./js/editor/editorManager.js",
  "./js/ai/providers.js",
  "./js/ai/chatController.js",
  "./js/storage/workspaceDb.js",
  "./js/github/githubService.js",
  "./js/github/githubController.js"
];

const CACHEABLE_CDN_HOSTS = new Set([
  "esm.sh",
  "fonts.googleapis.com",
  "fonts.gstatic.com"
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) =>
        Promise.all(
          APP_SHELL_URLS.map((url) =>
            fetch(new Request(url, { cache: "reload" })).then((res) => {
              if (res && res.ok) {
                return cache.put(url, res);
              }
              return undefined;
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const staleKeys = keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE);
      await Promise.all(staleKeys.map((k) => caches.delete(k)));
      await self.clients.claim();

      if (staleKeys.length > 0) {
        const windowClients = await self.clients.matchAll({ type: "window" });
        for (const client of windowClients) {
          client.navigate(client.url).catch(() => {});
        }
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") {
    return;
  }

  const url = new URL(request.url);

  // Cachear módulos ESM (CodeMirror 6, Octokit) y tipografías para uso rápido y offline en el iPad
  if (CACHEABLE_CDN_HOSTS.has(url.hostname)) {
    event.respondWith(
      caches.open(RUNTIME_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        const networkPromise = fetch(request)
          .then((response) => {
            if (response && response.ok) {
              cache.put(request, response.clone());
            }
            return response;
          })
          .catch(() => cached);

        return cached || networkPromise;
      })
    );
    return;
  }

  // Estrategia Network-First para el App Shell propio: siempre trae los últimos cambios con internet
  // y cae automáticamente a la caché local si el iPad está sin conexión.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.open(SHELL_CACHE).then(async (cache) => {
        try {
          const fresh = await fetch(request, { cache: "no-cache" });
          if (fresh && fresh.ok) {
            cache.put(request, fresh.clone());
          }
          return fresh;
        } catch {
          const cached = await cache.match(request);
          if (cached) {
            return cached;
          }
          throw new Error("Sin conexión y recurso no disponible en caché.");
        }
      })
    );
  }
});
