'use strict';
// ===== Configuración: URL de la aplicación web de Apps Script (termina en /exec) =====
const URL_CATALOGO = '';
// =====================================================================================

const $ = s => document.querySelector(s);
const audio = $('#audio');
const LS_PROG = 'cuentos.progreso', LS_CAT = 'cuentos.catalogo';
const MAX_CUENTOS = 2000;
const MODO_PRUEBA = !URL_CATALOGO || new URLSearchParams(location.search).has('local');
let cuentos = [], actual = null, ultimoGuardado = 0;

const leer = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
const escribir = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento: la app sigue */ } };

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

const urlCaratula = c => c.caratulaUrl || (c.caratula ? `https://drive.google.com/thumbnail?id=${c.caratula}&sz=w600` : null);
const urlAudio = c => c.audioUrl || `https://drive.usercontent.google.com/download?id=${c.audio}&export=download`;

// ---------- Catálogo ----------
async function cargarCatalogo() {
  const guardado = limpiarCatalogo(leer(LS_CAT, null));
  if (guardado.length) { cuentos = guardado; pintar(); }
  try {
    const r = await fetch(MODO_PRUEBA ? 'catalogo-local.json' : URL_CATALOGO, { cache: 'no-store', credentials: 'omit' });
    if (!r.ok) throw new Error('catálogo ' + r.status);
    const nuevos = limpiarCatalogo((await r.json()).cuentos);
    if (nuevos.length) { cuentos = nuevos; escribir(LS_CAT, cuentos); pintar(); }
  } catch {
    if (!guardado.length) mostrarAviso(true);
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
  const src = urlCaratula(c);
  if (src) {
    const img = document.createElement('img');
    img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    img.addEventListener('load', () => img.classList.add('cargada'), { once: true });
    img.src = src;
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
function abrir(n) {
  const c = cuentos.find(x => x.n === Number(n)); if (!c) return;
  if (actual && actual.n === c.n && audio.src) { mostrarReproductor(c); audio.play().catch(() => {}); return; }
  guardarProgreso(true);
  actual = c;
  mostrarReproductor(c);
  const p = progresos()[c.n];
  audio.src = urlAudio(c);
  const inicio = aMedias(p) ? p.t : 0;
  if (inicio) audio.addEventListener('loadedmetadata', () => { audio.currentTime = inicio; }, { once: true });
  $('#barra div').style.width = inicio && p.d ? (inicio / p.d * 100) + '%' : '0%';
  $('#play').classList.add('cargando');
  audio.play().catch(() => $('#play').classList.remove('cargando'));
  if ('mediaSession' in navigator) {
    const art = urlCaratula(c);
    navigator.mediaSession.metadata = new MediaMetadata({ title: c.titulo || 'Cuento', artist: 'Cuentos',
      artwork: art ? [{ src: art, sizes: '600x900', type: 'image/jpeg' }] : [] });
  }
}
function mostrarReproductor(c) {
  $('#grande').replaceChildren(libro(c));
  $('#reproductor').classList.add('abierto');
  history.pushState({ reproductor: true }, '');
}
function cerrar(desdeHistorial) {
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
