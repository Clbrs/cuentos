// Guarda la app para que abra rápido y sin conexión. Carátulas y audios los guarda la propia app.
const VERSION = 'cuentos-v6';
const APP = ['./', 'index.html', 'app.js?v=6', 'app.css?v=6', 'manifest.webmanifest', 'icono-192.png', 'icono-512.png', 'icono-180.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(APP))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== 'caratulas' && k !== 'audios').map(k => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.endsWith('.json')) return;
  // no-cache: pregunta siempre a GitHub si hay versión nueva (si no, sirve hasta 10 min la vieja)
  e.respondWith(fetch(e.request.url, { cache: 'no-cache', credentials: 'same-origin' }).then(r => {
    const copia = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copia)); return r;
  }).catch(() => caches.match(e.request)));
});
