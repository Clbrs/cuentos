/**
 * Cuentos: script de Google Drive que da a la app los cuentos (lista, carátulas y audios).
 *
 * En tu Drive tiene que haber una carpeta "Cuentos" con dos subcarpetas:
 *   audios/     -> "001 - Aladdin.mp3", "002 - Snow White.mp3", ...
 *   caratulas/  -> "001.jpg", "002.jpg", ...
 *
 * La carpeta NO se comparte: todo pasa por este script y solo responde a quien tenga la clave.
 *
 * Pasos: pega este código, ejecuta instalar() y generarClave() una vez y publícalo como
 * aplicación web. Para añadir cuentos, súbelos con el siguiente número y, si no aparecen
 * en unos minutos, ejecuta actualizar(). Para quitar el acceso a todas las tablets,
 * ejecuta generarClave() otra vez (habrá que meter la clave nueva en cada una).
 */

const NOMBRE_CARPETA = 'Cuentos';
const MINUTOS_CACHE = 30;
const MAX_CUENTOS = 2000;
const MAX_MB_AUDIO = 40;
const MAX_CARATULAS_POR_PETICION = 25;
const URL_APP = 'https://clbrs.github.io/cuentos/';

function instalar() {
  const raiz = buscarCarpeta_(null, NOMBRE_CARPETA);
  const audios = buscarCarpeta_(raiz, 'audios');
  const caratulas = buscarCarpeta_(raiz, 'caratulas');
  PropertiesService.getScriptProperties().setProperties({ AUDIOS_ID: audios.getId(), CARATULAS_ID: caratulas.getId() });
  CacheService.getScriptCache().remove('catalogo');
  const cat = construirCatalogo_();
  Logger.log('Listo: %s cuentos (%s sin carátula).', cat.cuentos.length,
    cat.cuentos.filter(function (c) { return !c.caratula; }).length);
  if (raiz.getSharingAccess() !== DriveApp.Access.PRIVATE) {
    Logger.log('AVISO: la carpeta "%s" sigue compartida. Ponla en Restringido (Drive > Compartir).', NOMBRE_CARPETA);
  }
}

// Crea una clave nueva (la anterior deja de valer) y la muestra UNA vez en el registro.
function generarClave() {
  const clave = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');  // 64 caracteres aleatorios (SecureRandom)
  PropertiesService.getScriptProperties().setProperty('CLAVE', clave);
  Logger.log('Clave nueva: %s', clave);
  Logger.log('Enlace para la tablet (ábrelo una vez allí): %s#clave=%s', URL_APP, clave);
}

function actualizar() {
  CacheService.getScriptCache().remove('catalogo');
  Logger.log('Catálogo actualizado: %s cuentos.', construirCatalogo_().cuentos.length);
}

// Por GET no se entrega nada: así la dirección del script, aunque sea pública, no sirve sin la clave.
function doGet() {
  return texto_('no');
}

// La app pide todo por POST con la clave en el cuerpo (nunca en la dirección).
function doPost(e) {
  let pet;
  try { pet = JSON.parse(e.postData.contents); } catch (err) { return texto_('no'); }
  if (!pet || typeof pet !== 'object' || !claveValida_(pet.k)) {
    Utilities.sleep(400);  // frena a quien pruebe claves
    return texto_('no');
  }
  if (pet.a === 'catalogo') return json_(catalogo_());
  if (pet.a === 'audio') return audio_(pet.id);
  if (pet.a === 'caratulas') return caratulas_(pet.ids);
  return texto_('no');
}

function claveValida_(k) {
  const buena = PropertiesService.getScriptProperties().getProperty('CLAVE');
  if (!buena || typeof k !== 'string' || k.length !== buena.length) return false;
  let dif = 0;
  for (let i = 0; i < buena.length; i++) dif |= buena.charCodeAt(i) ^ k.charCodeAt(i);  // tiempo constante
  return dif === 0;
}

function catalogo_() {
  const cache = CacheService.getScriptCache();
  const guardado = cache.get('catalogo');
  if (guardado) return JSON.parse(guardado);
  const cat = construirCatalogo_();
  const json = JSON.stringify(cat);
  if (json.length < 100000) cache.put('catalogo', json, MINUTOS_CACHE * 60);
  return cat;
}

// Solo se entregan ficheros que están en la lista de cuentos (es decir, dentro de sus carpetas).
// Se comprueba contra la lista en memoria, sin preguntar a Drive por cada fichero (mucho más rápido).
function permitidos_() {
  const cat = catalogo_();
  const audios = {}, caratulas = {};
  cat.cuentos.forEach(function (c) { audios[c.audio] = true; if (c.caratula) caratulas[c.caratula] = true; });
  return { audios: audios, caratulas: caratulas };
}

function idValido_(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{10,100}$/.test(id); }

function audio_(id) {
  if (!idValido_(id) || !permitidos_().audios[id]) return texto_('no');
  let f;
  try { f = DriveApp.getFileById(id); } catch (err) { return texto_('no'); }
  if (f.getSize() > MAX_MB_AUDIO * 1024 * 1024) return texto_('no');
  return texto_(Utilities.base64Encode(f.getBlob().getBytes()));
}

function caratulas_(ids) {
  if (!Array.isArray(ids)) return texto_('no');
  const ok = permitidos_().caratulas;
  const out = {};
  ids.slice(0, MAX_CARATULAS_POR_PETICION).forEach(function (id) {
    if (!idValido_(id) || !ok[id]) return;
    try {
      const b = DriveApp.getFileById(id).getBlob();
      const bytes = b.getBytes();
      if (bytes.length < 2 * 1024 * 1024) out[id] = { t: b.getContentType(), b: Utilities.base64Encode(bytes) };
    } catch (err) { /* se salta esa carátula */ }
  });
  return json_(out);
}

function construirCatalogo_() {
  const p = PropertiesService.getScriptProperties();
  const audiosId = p.getProperty('AUDIOS_ID');
  if (!audiosId) throw new Error('Ejecuta primero instalar()');
  const caratulas = {};
  const it = DriveApp.getFolderById(p.getProperty('CARATULAS_ID')).getFiles();
  while (it.hasNext()) {
    const f = it.next();
    const m = f.getName().match(/^(\d+)\.(jpe?g|png|webp)$/i);
    if (m) caratulas[Number(m[1])] = f.getId();
  }
  const cuentos = [];
  const ia = DriveApp.getFolderById(audiosId).getFiles();
  while (ia.hasNext()) {
    const f = ia.next();
    const m = f.getName().match(/^(\d+)\s*-\s*(.+)\.(mp3|m4a|ogg)$/i);
    if (!m) continue;
    if (cuentos.length >= MAX_CUENTOS) break;
    const n = Number(m[1]);
    // Solo los campos que la app necesita: número, título, id del audio y de la carátula.
    cuentos.push({ n: n, titulo: m[2].trim().slice(0, 200), audio: f.getId(), caratula: caratulas[n] || null });
  }
  cuentos.sort(function (a, b) { return a.n - b.n; });
  return { cuentos: cuentos, generado: new Date().toISOString() };
}

function buscarCarpeta_(padre, nombre) {
  const it = padre ? padre.getFoldersByName(nombre) : DriveApp.getFoldersByName(nombre);
  if (!it.hasNext()) throw new Error('No encuentro la carpeta "' + nombre + '" en tu Drive.');
  return it.next();
}

function texto_(s) { return ContentService.createTextOutput(s).setMimeType(ContentService.MimeType.TEXT); }
function json_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
