'use strict';
// ===== Configuración: URL de la aplicación web de Apps Script (termina en /exec) =====
const URL_CATALOGO = 'https://script.google.com/macros/s/AKfycbybvx-jbQmZWSXjJlC5nvC3MPJ1PjDlK9tEYGN04hALuRwuSAGoYgHjSM6bJzZxAXy4/exec';
// =====================================================================================

const $ = s => document.querySelector(s);
const audio = $('#audio');
const LS_PROG = 'cuentos.progreso', LS_CAT = 'cuentos.catalogo', LS_CLAVE = 'cuentos.clave', LS_AUDIOS = 'cuentos.audios';
const MAX_CUENTOS = 2000;
const MAX_AUDIOS_GUARDADOS = 15;     // cuentos que se quedan en la tablet para abrir al instante
const CARATULAS_POR_PETICION = 25;
const params = new URLSearchParams(location.search);
const MODO_PRUEBA = !URL_CATALOGO || params.has('local');
const URL_SCRIPT = (MODO_PRUEBA && params.get('script')) || URL_CATALOGO;   // ?script= solo en pruebas locales
let cuentos = [], actual = null, ultimoGuardado = 0;

const leer = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const escribir = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento: la app sigue */ } };
const borrar = k => { try { localStorage.removeItem(k); } catch { /* nada */ } };

// ---------- Clave de acceso ----------
const FORMATO_CLAVE = /^[A-Za-z0-9]{20,128}$/;
// Un enlace con #clave=... la guarda y la quita de la barra de direcciones (el # nunca llega a ningún servidor).
(function claveDesdeEnlace() {
  const m = location.hash.match(/^#clave=([A-Za-z0-9]{20,128})$/);
  if (m) escribir(LS_CLAVE, m[1]);
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
})();
const clave = () => { const k = leer(LS_CLAVE, ''); return typeof k === 'string' && FORMATO_CLAVE.test(k) ? k : ''; };

class SinPermiso extends Error {}
async function llamar(a, extra) {
  const k = clave();
  if (!k) throw new SinPermiso();
  const r = await fetch(URL_SCRIPT, {
    method: 'POST', cache: 'no-store', credentials: 'omit',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },   // sin preflight: Apps Script no lo admite
    body: JSON.stringify({ k, a, ...extra })
  });
  if (!r.ok) throw new Error('script ' + r.status);
  const t = (await r.text()).trim();
  if (t === 'no') throw new SinPermiso();
  return t;
}

function mostrarCandado(error) {
  $('#candado').classList.add('visible');
  $('#candado').classList.toggle('error', !!error);
  const campo = $('#campo-clave');
  campo.value = '';
  setTimeout(() => campo.focus(), 50);
}
$('#form-clave').addEventListener('submit', e => {
  e.preventDefault();
  const v = $('#campo-clave').value.trim();
  if (!FORMATO_CLAVE.test(v)) { $('#candado').classList.add('error'); return; }
  escribir(LS_CLAVE, v);
  $('#candado').classList.remove('visible', 'error');
  cargarCatalogo();
});

// ---------- Validación del catálogo (viene de fuera: se trata como no fiable) ----------
const ID_DRIVE = /^[A-Za-z0-9_-]{10,100}$/;
const RUTA_LOCAL = /^\.{0,2}\/?[A-Za-z0-9_./-]{1,200}$/;   // solo rutas relativas en modo prueba
function limpiarCuento(c) {
  if (!c || typeof c !== 'object') return null;
  const n = Number(c.n);
  if (!Number.isInteger(n) || n < 1 || n > 99999) return null;
  const titulo = typeof c.titulo === 'string' ? c.titulo.slice(0, 200) : '';
  const out = { n, titulo, audio: null, caratula: null, audioUrl: null, caratulaUrl: null };
  if (typeof c.audio === 'string' && ID_DRIVE.test(c.audio)) out.audio = c.audio;
  if (typeof c.caratula === 'string' && ID_DRIVE.test(c.caratula)) out.caratula = c.caratula;
  if (MODO_PRUEBA) {
    if (typeof c.audioUrl === 'string' && RUTA_LOCAL.test(c.audioUrl) && !c.audioUrl.includes(':')) out.audioUrl = c.audioUrl;
    if (typeof c.caratulaUrl === 'string' && RUTA_LOCAL.test(c.caratulaUrl) && !c.caratulaUrl.includes(':')) out.caratulaUrl = c.caratulaUrl;
  }
  return (out.audio || out.audioUrl) ? out : null;
}
function limpiarCatalogo(lista) {
  if (!Array.isArray(lista)) return [];
  const vistos = new Set();
  return lista.slice(0, MAX_CUENTOS).map(limpiarCuento)
    .filter(c => c && !vistos.has(c.n) && vistos.add(c.n))
    .sort((a, b) => a.n - b.n);
}

// ---------- Ficheros guardados en la tablet (Cache Storage) ----------
const clavePropia = (tipo, id) => new URL(`${tipo}-guardada/${id}`, location.href).href;
const abrirCache = nombre => ('caches' in window ? caches.open(nombre).catch(() => null) : Promise.resolve(null));
function base64ABlob(b64, tipo) {
  if (typeof b64 !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(b64) || b64.length > 60e6) throw new Error('datos no válidos');
  const bin = atob(b64), bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: tipo });
}

// ---------- Carátulas: por lotes a través del script, y se quedan en la tablet ----------
const urlsCaratula = new Map();     // id -> blob: URL ya lista
const esperando = new Map();        // id -> [img] que esperan esa carátula
let cargandoCaratulas = false;
function ponerCaratula(img, url) {
  img.addEventListener('load', () => img.classList.add('cargada'), { once: true });
  img.src = url;
}
async function cargarCaratulasPendientes() {
  if (cargandoCaratulas || MODO_PRUEBA && !params.get('script')) return;
  cargandoCaratulas = true;
  try {
    const cache = await abrirCache('caratulas');
    // 1) las que ya están en la tablet
    for (const id of [...esperando.keys()]) {
      const r = cache && await cache.match(clavePropia('caratula', id)).catch(() => null);
      if (r) entregarCaratula(id, await r.blob());
    }
    // 2) el resto, del script, de 25 en 25
    while (esperando.size) {
      const lote = [...esperando.keys()].slice(0, CARATULAS_POR_PETICION);
      const datos = JSON.parse(await llamar('caratulas', { ids: lote }));
      for (const id of lote) {
        const d = datos && datos[id];
        if (!d || !/^image\/(jpeg|png|webp)$/.test(d.t)) { esperando.delete(id); continue; }
        const blob = base64ABlob(d.b, d.t);
        if (cache) await cache.put(clavePropia('caratula', id), new Response(blob, { headers: { 'Content-Type': d.t } })).catch(() => {});
        entregarCaratula(id, blob);
      }
    }
  } catch (e) {
    if (e instanceof SinPermiso) mostrarCandado(true);
  } finally {
    cargandoCaratulas = false;
  }
}
function entregarCaratula(id, blob) {
  const url = URL.createObjectURL(blob);
  urlsCaratula.set(id, url);
  (esperando.get(id) || []).forEach(img => ponerCaratula(img, url));
  esperando.delete(id);
}

// ---------- Audio: también a través del script ----------
function recordarAudio(id) {
  let lista = leer(LS_AUDIOS, []);
  if (!Array.isArray(lista)) lista = [];
  lista = [id, ...lista.filter(x => x !== id)];
  const sobran = lista.slice(MAX_AUDIOS_GUARDADOS);
  escribir(LS_AUDIOS, lista.slice(0, MAX_AUDIOS_GUARDADOS));
  if (sobran.length) abrirCache('audios').then(c => c && sobran.forEach(x => c.delete(clavePropia('audio', x))));
}
async function blobAudio(c) {
  const cache = await abrirCache('audios');
  const guardado = cache && await cache.match(clavePropia('audio', c.audio)).catch(() => null);
  if (guardado) { recordarAudio(c.audio); return guardado.blob(); }
  const blob = base64ABlob(await llamar('audio', { id: c.audio }), 'audio/mpeg');
  if (cache) { await cache.put(clavePropia('audio', c.audio), new Response(blob, { headers: { 'Content-Type': 'audio/mpeg' } })).catch(() => {}); recordarAudio(c.audio); }
  return blob;
}

// ---------- Catálogo ----------
async function cargarCatalogo() {
  if (!MODO_PRUEBA && !clave()) {   // sin clave no se enseña nada, ni lo que guardaran versiones anteriores
    borrar(LS_CAT); if ('caches' in window) caches.delete('caratulas').catch(() => {});
    mostrarCandado(false); return;
  }
  const guardado = limpiarCatalogo(leer(LS_CAT, null));
  if (guardado.length) { cuentos = guardado; pintar(); }
  try {
    let datos;
    if (MODO_PRUEBA && !params.get('script')) {
      const r = await fetch('catalogo-local.json', { cache: 'no-store' });
      datos = await r.json();
    } else {
      datos = JSON.parse(await llamar('catalogo'));
    }
    const nuevos = limpiarCatalogo(datos && datos.cuentos);
    if (nuevos.length) { cuentos = nuevos; escribir(LS_CAT, cuentos); pintar(); }
  } catch (e) {
    if (e instanceof SinPermiso) {
      // Clave cambiada o borrada: no se enseña nada de lo guardado
      borrar(LS_CLAVE); borrar(LS_CAT); cuentos = []; $('#rejilla').replaceChildren(); pintarContinuar();
      mostrarCandado(true);
    } else if (!guardado.length) {
      mostrarAviso(true);
    }
  }
}

// ---------- Dibujo (solo DOM, nada de HTML con datos) ----------
const SVG = 'http://www.w3.org/2000/svg';
const FORMAS = [
  ['circle', { cx: 12, cy: 12, r: 9, fill: '#FFC94A' }],
  ['path', { d: 'M12 2l2.9 6.6 7.1.6-5.4 4.7 1.6 7L12 17.3 5.8 21l1.6-7L2 9.2l7.1-.6z', fill: '#FF8FAB' }],
  ['path', { d: 'M12 21s-8-5.1-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 5.9-8 11-8 11z', fill: '#7FD6C2' }],
  ['path', { d: 'M20 15.5A8.5 8.5 0 1 1 8.5 4a7 7 0 0 0 11.5 11.5z', fill: '#B9A7FF' }]
];
function libro(c) {
  const span = document.createElement('span');
  span.className = 'libro';
  if (c.caratula || c.caratulaUrl) {
    const img = document.createElement('img');
    img.alt = ''; img.decoding = 'async';
    if (c.caratulaUrl) ponerCaratula(img, c.caratulaUrl);
    else if (urlsCaratula.has(c.caratula)) ponerCaratula(img, urlsCaratula.get(c.caratula));
    else { if (!esperando.has(c.caratula)) esperando.set(c.caratula, []); esperando.get(c.caratula).push(img); }
    span.append(img);
  } else {
    const hueco = document.createElement('span');
    hueco.className = 'sin-caratula';
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    const [tag, attrs] = FORMAS[c.n % FORMAS.length];
    const forma = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) forma.setAttribute(k, v);
    svg.append(forma); hueco.append(svg); span.append(hueco);
  }
  return span;
}

function pintar() {
  esperando.clear();
  const items = cuentos.map(c => {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.dataset.n = String(c.n);
    b.setAttribute('aria-label', c.titulo || 'Cuento');
    b.append(libro(c)); li.append(b);
    return li;
  });
  $('#rejilla').replaceChildren(...items);
  pintarContinuar();
  cargarCaratulasPendientes();
}

// ---------- Progreso (tipo Spotify) ----------
function progresos() {
  const p = leer(LS_PROG, {});
  return p && typeof p === 'object' && !Array.isArray(p) ? p : {};
}
const aMedias = v => v && Number.isFinite(v.t) && v.t > 5 && (!v.d || v.t < v.d - 10);
function pendiente() {
  const lista = Object.entries(progresos())
    .filter(([n, v]) => aMedias(v) && cuentos.some(c => c.n === Number(n)))
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  return lista.length ? { c: cuentos.find(c => c.n === Number(lista[0][0])), ...lista[0][1] } : null;
}
function pintarContinuar() {
  const btn = $('#continuar'), p = pendiente();
  btn.classList.toggle('visible', !!p);
  if (!p) return;
  btn.dataset.n = String(p.c.n);
  btn.querySelector('.libro').replaceWith(libro(p.c));
  cargarCaratulasPendientes();
  const pct = p.d ? Math.min(100, Math.max(0, (p.t / p.d) * 100)) : 0;
  btn.querySelector('.aro .hecho').setAttribute('stroke-dasharray', `${pct.toFixed(1)} 100`);
}
function guardarProgreso(forzar) {
  if (!actual || !audio.currentTime) return;
  const ahora = Date.now();
  if (!forzar && ahora - ultimoGuardado < 3000) return;
  ultimoGuardado = ahora;
  const p = progresos();
  p[actual.n] = { t: audio.currentTime, d: Number.isFinite(audio.duration) ? audio.duration : 0, at: ahora };
  escribir(LS_PROG, p);
}
function borrarProgreso(n) { const p = progresos(); delete p[n]; escribir(LS_PROG, p); }

// ---------- Reproductor ----------
let urlBlobActual = null, peticion = 0;
async function abrir(n) {
  const c = cuentos.find(x => x.n === Number(n)); if (!c) return;
  if (actual && actual.n === c.n && audio.src) { mostrarReproductor(c); audio.play().catch(() => {}); return; }
  guardarProgreso(true);
  audio.pause();
  actual = c;
  const mia = ++peticion;
  mostrarReproductor(c);
  const p = progresos()[c.n];
  const inicio = aMedias(p) ? p.t : 0;
  $('#barra div').style.width = inicio && p.d ? (inicio / p.d * 100) + '%' : '0%';
  $('#play').classList.add('cargando');
  let src;
  try {
    src = c.audioUrl || URL.createObjectURL(await blobAudio(c));
  } catch (e) {
    if (mia === peticion) {
      $('#play').classList.remove('cargando');
      if (e instanceof SinPermiso) { cerrar(false); mostrarCandado(true); } else mostrarAviso(true);
    }
    return;
  }
  if (mia !== peticion || actual !== c) { if (!c.audioUrl) URL.revokeObjectURL(src); return; }  // ya eligieron otro
  if (urlBlobActual) URL.revokeObjectURL(urlBlobActual);
  urlBlobActual = c.audioUrl ? null : src;
  audio.src = src;
  if (inicio) audio.addEventListener('loadedmetadata', () => { audio.currentTime = inicio; }, { once: true });
  if ($('#reproductor').classList.contains('abierto')) audio.play().catch(() => $('#play').classList.remove('cargando'));
  else $('#play').classList.remove('cargando');
  if ('mediaSession' in navigator) {
    const art = c.caratulaUrl || urlsCaratula.get(c.caratula);
    navigator.mediaSession.metadata = new MediaMetadata({ title: c.titulo || 'Cuento', artist: 'Cuentos',
      artwork: art ? [{ src: art, sizes: '500x750', type: 'image/jpeg' }] : [] });
  }
}
function mostrarReproductor(c) {
  $('#grande').replaceChildren(libro(c));
  cargarCaratulasPendientes();
  $('#reproductor').classList.add('abierto');
  history.pushState({ reproductor: true }, '');
}
function cerrar(desdeHistorial) {
  peticion++;
  guardarProgreso(true);
  audio.pause();
  $('#reproductor').classList.remove('abierto');
  pintarContinuar();
  if (!desdeHistorial && history.state && history.state.reproductor) history.back();
}

audio.addEventListener('playing', () => { $('#play').classList.remove('cargando'); $('#play').classList.add('sonando'); });
audio.addEventListener('waiting', () => $('#play').classList.add('cargando'));
audio.addEventListener('pause', () => { $('#play').classList.remove('sonando', 'cargando'); guardarProgreso(true); });
audio.addEventListener('timeupdate', () => {
  if (audio.duration) $('#barra div').style.width = (audio.currentTime / audio.duration * 100) + '%';
  guardarProgreso(false);
});
audio.addEventListener('ended', () => {
  if (actual) { borrarProgreso(actual.n); actual = null; }  // terminado: no se vuelve a guardar
  $('#barra div').style.width = '100%';
  setTimeout(() => cerrar(false), 1500);
});
audio.addEventListener('error', () => { if (actual && audio.src) { $('#play').classList.remove('cargando'); mostrarAviso(true); } });

$('#rejilla').addEventListener('click', e => { const b = e.target.closest('button[data-n]'); if (b) abrir(b.dataset.n); });
$('#continuar').addEventListener('click', e => abrir(e.currentTarget.dataset.n));
$('#volver').addEventListener('click', () => cerrar(false));
$('#play').addEventListener('click', () => { if (audio.paused) audio.play().catch(() => {}); else audio.pause(); });
$('#atras').addEventListener('click', () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
window.addEventListener('popstate', () => { if ($('#reproductor').classList.contains('abierto')) cerrar(true); });
window.addEventListener('pagehide', () => guardarProgreso(true));
document.addEventListener('visibilitychange', () => { if (document.hidden) guardarProgreso(true); });

function mostrarAviso(si) { $('#aviso').classList.toggle('visible', si); }
$('#reintentar').addEventListener('click', () => {
  mostrarAviso(false);
  if (actual && $('#reproductor').classList.contains('abierto')) { const n = actual.n; actual = null; audio.removeAttribute('src'); abrir(n); }
  else cargarCatalogo();
});

if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', () => audio.play());
  navigator.mediaSession.setActionHandler('pause', () => audio.pause());
}
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
cargarCatalogo();
