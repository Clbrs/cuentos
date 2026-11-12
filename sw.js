// Guarda la app y las carátulas para que abra rápido. Los audios siempre llegan de Drive.
const VERSION = 'cuentos-v3';
const APP = ['./', 'index.html', 'app.js', 'app.css', 'manifest.webmanifest', 'icono-192.png', 'icono-512.png', 'icono-180.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== 'caratulas' && k !== 'audios').map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.hostname === 'drive.google.com' && url.pathname === '/thumbnail') {
    e.respondWith(caches.open('caratulas').then(async c => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok || r.type === 'opaque') c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  if (url.origin === location.origin && !url.pathname.endsWith('.json')) {
    // La app: primero red (para recibir actualizaciones), si no hay, la copia guardada
    e.respondWith(fetch(e.request).then(r => {
      const copia = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copia)); return r;
    }).catch(() => caches.match(e.request)));
  }
});
