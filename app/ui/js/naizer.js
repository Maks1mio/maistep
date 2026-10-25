// ImageNaizer — холст по образцу Canvas InvokeAI. Бесконечное поле со слоями двух видов: растровые (картинки,
// мазки кистью цветом) и маски inpaint (где менять; у маски свой предел силы). Генерация идёт в РАМКЕ (bbox):
// сервер (sd.canvas) получает композит растровых слоёв в рамке и композит масок и сам выбирает режим — рамка пуста
// → txt2img, частично прозрачна → outpaint, масок нет → img2img, есть маска → inpaint (градиентная маска с кольцом
// coherence). Рамка масштабируется к родному размеру модели: маленькая рамка — больше деталей.
// Результаты попадают в staging: листать, принять (новый растровый слой на месте рамки) или отбросить.
// Документ — один холст (localStorage); пиксели слоёв — файлы input/naizer_layer_* (выгружаются после правок).
// Под капотом — скрытый граф (Load Checkpoint → CLIP Text Encode ×2 → Canvas Generate) в общей очереди: прогресс
// и поэтапное превью рисуются прямо в рамке. Hierarchy — файлы output/ и input/ (щелчок — добавить слоем).
// Inspector — только промпт, сила (и «дорисовка» для outpaint), число вариантов и чекпоинт: шаги, cfg, сэмплер и
// негатив — из рекомендации Magic, остальное — значения по умолчанию (упрощено по просьбе пользователя 2026-10-25).
import { h, num, debounce, clamp, confirmBox, prompt } from './util.js';
import { S, on, emit, select } from './store.js';
import { registerInspector, typingIn } from './inspector.js';
import { icon } from './icons.js';
import { api, fileUrl, upload, interrupt } from './backend.js';
import { isShown, activeView } from './dock.js';
import { dropdown } from './kit.js';
import { libraryPicker } from './library.js';
import { cnNames, cnPick, loadCn, cnMissing } from './cnmodels.js';
import { fetchRec } from './magic.js';
import { imagePicker, imagesFromTransfer, imagesFromClipboard, clipboardHasImage } from './images.js';

const LS = 'maistep-canvas', OLD_LS = 'maistep-naizer';
const DEF = {
  docs: {}, cur: '', prompt: '', denoise: 0.75, fill: 0.85, ckpt: '', batch: 1, tool: 'brush', size: 40, color: '#D9B38C', side: 260, stage: true,
};
const st = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(LS)) }; } catch { return { ...DEF }; } })();
const keep = debounce(() => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch {} }, 200);
const log = (level, text) => emit('log', { src: 'naizer', level, text });

const MODES = {
  txt2img: ['txt2img', 'Рамка пуста — картинка с нуля по промпту'],
  img2img: ['img2img', 'Масок нет — вся рамка перерисовывается с силой denoise'],
  inpaint: ['inpaint', 'Меняется только под масками (сила — denoise, но не выше предела маски)'],
  outpaint: ['outpaint', 'В рамке есть пустое — LaMa продолжает картинку, SD дорабатывает с силой «дорисовка»; маски — как inpaint'],
};
const MASK_COLORS = ['#E05C5C', '#548AF7', '#57C08A', '#D9A441', '#B36BE0'];
const PAD = 128, MAXSIDE = 8192;

// инструменты: свои иконки (в наборе JetBrains нет кисти/лассо), цвет — currentColor
const SVG = {
  bbox: '<rect x="3.5" y="3.5" width="9" height="9" stroke-dasharray="2 1.5"/><path d="M1.5 3.5h2M3.5 1.5v2M12.5 1.5v2M12.5 3.5h2M1.5 12.5h2M3.5 12.5v2M12.5 12.5h2M12.5 12.5v2"/>',
  move: '<path d="M8 1.5v13M1.5 8h13M6 3.5l2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2"/>',
  hand: '<path d="M5 8.5V3.6a1 1 0 0 1 2 0V7.5M7 7.5V2.6a1 1 0 0 1 2 0v4.9M9 7.5V3.6a1 1 0 0 1 2 0v4.4M11 8V5.6a1 1 0 0 1 2 0v4.6a4.3 4.3 0 0 1-4.3 4.3h-.6a4 4 0 0 1-3.4-1.9L2.9 9.8a1 1 0 0 1 1.6-1.2L5 9.3"/>',
  brush: '<path d="M13.6 2.4 8 8M8.4 6.4l1.2 1.2M6.4 8.6c-1.7-.3-3 .9-3 2.6 0 .9-.5 1.6-1.4 2.1 2.2 1 5.6.4 5.6-2.4 0-.9-.4-1.6-1.2-2.3z"/>',
  eraser: '<path d="M9.4 2.6l4 4-6.6 6.6H4.2L2 11l7.4-8.4zM5.8 6.2l4 4M7.8 13.2H14"/>',
  rect: '<rect x="2.5" y="3.5" width="11" height="9" rx=".5"/>',
  lasso: '<path d="M8 2.5c3.2 0 5.5 1.6 5.5 3.5S11.2 9.5 8 9.5 2.5 7.9 2.5 6 4.8 2.5 8 2.5z" stroke-dasharray="2.2 1.6"/><path d="M4.6 8.6c-.9.9-.6 2.1.5 2.3 1 .2 1.3 1.1.7 2.6"/>',
  picker: '<path d="M10.5 2.5l3 3-1.6 1.6-3-3zM9.4 4.6l2 2-6 6H3.4v-2z"/>',
  invert: '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 13.5l11-11V13.5z" fill="currentColor" stroke="none"/>',
  clear: '<rect x="2.5" y="2.5" width="11" height="11" rx=".5" stroke-dasharray="2.2 1.6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>',
  layers: '<path d="M8 2 14 5.2 8 8.4 2 5.2zM2.6 8.2 8 11.1l5.4-2.9M2.6 11 8 13.9l5.4-2.9"/>',
  mask: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" opacity=".7"/>',
  raster: '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 11l3.5-3.5 3 3 2-2 2.5 2.5"/><circle cx="10.5" cy="5.5" r="1"/>',
  merge: '<path d="M8 2v7M5 6.5 8 9.5l3-3M2.5 11.5h11M2.5 14h11"/>',
  fitbox: '<rect x="2.5" y="2.5" width="11" height="11" rx=".5" stroke-dasharray="2.2 1.6"/><path d="M5.5 5.5h5v5h-5z"/>',
  tomask: '<rect x="2.5" y="2.5" width="11" height="11" rx="2"/><path d="M5 11V7.5L8 5l3 2.5V11z" fill="currentColor" stroke="none" opacity=".6"/>',
};
const svg = (k, size = 16) => {
  const s = h('span.nz-svg');
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${SVG[k]}</svg>`;
  return s;
};
const TOOLS = [
  ['bbox', 'Рамка генерации', 'C', 'Тянуть рамку, углы — размер; новая — протянуть снаружи'],
  ['move', 'Перемещение слоя', 'V', 'Тянуть активный слой'], ['hand', 'Рука', 'H', 'Сдвиг холста (или ПКМ / Space)'], null,
  ['brush', 'Кисть', 'B', 'Растровый слой — цветом, маска — где менять\nAlt — пипетка'], ['eraser', 'Ластик', 'E', ''],
  ['rect', 'Прямоугольник', 'U', 'Залить прямоугольник · Alt — стереть'], ['lasso', 'Лассо', 'L', 'Залить контур · Alt — стереть'],
  ['picker', 'Пипетка', 'I', 'Цвет кисти с холста'],
];

let cv = null, wrap = null, view = { x: 0, y: 0, z: 1 }, fitted = false;
let mouse = null, shape = null, busy = null, files = { output: [], input: [] };
let hist = { undo: [], redo: [] }, space = false, dragRow = null, editName = null, mode = 'txt2img';
let rec = null; // рекомендация Magic для чекпоинта
let frameUp = { sig: '', file: '' }, maskUp = { sig: '', file: '' };
const pics = new Map(); // файл → Image
const bm = new Map(); // id слоя → canvas с его пикселями
const revs = new Map(); // id слоя → номер правки (подпись композитов)
const dirty = new Set();
let checker = null;

const ckptName = () => st.ckpt || S.nodes['sd.checkpoint']?.inputs?.ckpt_name?.default || '';
const uid = () => Math.random().toString(36).slice(2, 9);
const mk = (w, hh) => Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(hh)) });
const doc = () => st.docs[st.cur];
const activeL = () => doc()?.layers.find(l => l.id === doc().active) || null;
const shown = L => L.visible !== false && (L.opacity ?? 1) > 0;
const rasters = () => doc().layers.filter(L => L.type === 'raster');
const masks = () => doc().layers.filter(L => L.type === 'mask');
const hasPix = L => L.w > 0 && L.h > 0;
const isectR = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---------- документ ----------
function newDoc(w = 1024, hh = 1024) {
  return { name: '', at: Date.now(), bbox: { x: 0, y: 0, w, h: hh }, layers: [], active: null, staging: [], si: 0 };
}
// имя нового холста: «Холст N» со следующим свободным номером
const nextName = () => {
  const used = new Set(Object.values(st.docs).map(d => d.name));
  let n = 1;
  while (used.has(`Холст ${n}`)) n++;
  return `Холст ${n}`;
};
const byRecent = () => Object.entries(st.docs).sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
// старый ImageNaizer (фон + слои-патчи): фон и слои становятся растровыми слоями
function migrate() {
  try {
    const o = JSON.parse(localStorage.getItem(OLD_LS) || 'null');
    const od = o?.docs?.[o.file];
    if (!od?.base) return null;
    const d = newDoc();
    d.layers.push({ id: uid(), type: 'raster', name: 'Фон', x: 0, y: 0, w: 0, h: 0, file: od.base, visible: true, opacity: 1, fitBbox: true });
    for (const L of od.layers || []) {
      const f = L.vars?.[L.vi]?.file;
      if (f) d.layers.push({ id: uid(), type: 'raster', name: L.name, x: L.x, y: L.y, w: L.w, h: L.h, file: f, visible: L.visible !== false, opacity: L.opacity ?? 1 });
    }
    return d;
  } catch { return null; }
}
// холсты: st.docs (id → документ), st.cur — открытый; прежний единственный st.doc становится первым холстом
if (!st.docs || typeof st.docs !== 'object') st.docs = {};
if (st.doc) { const id = uid(); st.docs[id] = { ...st.doc, name: st.doc.name || 'Холст 1', at: Date.now() }; st.cur = id; delete st.doc; }
if (!st.docs[st.cur]) {
  st.cur = byRecent()[0]?.[0] || '';
  if (!st.cur) { st.cur = uid(); st.docs[st.cur] = { ...(migrate() || newDoc()), name: 'Холст 1' }; }
}
for (const d of Object.values(st.docs)) if (!Array.isArray(d.staging)) d.staging = [];
keep();

function pic(file) {
  let im = pics.get(file);
  if (!im) {
    im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => draw();
    im.src = fileUrl(file);
    pics.set(file, im);
  }
  return im.complete && im.naturalWidth ? im : null;
}
function loadPic(file) {
  const ready = pic(file);
  if (ready) return Promise.resolve(ready);
  const im = pics.get(file);
  return new Promise(res => {
    if (im.complete && !im.naturalWidth) { pics.delete(file); return res(null); }
    im.addEventListener('load', () => res(im), { once: true });
    im.addEventListener('error', () => { pics.delete(file); res(null); }, { once: true });
  });
}

// пиксели слоя: холст в размер слоя; файл подгружается под уже нарисованное (мазки до загрузки не теряются)
function canvasOf(L) {
  let c = bm.get(L.id);
  if (c) return c;
  c = mk(L.w, L.h);
  bm.set(L.id, c);
  if (L.file) fillFromFile(L, c);
  return c;
}
async function fillFromFile(L, c) {
  const im = await loadPic(L.file);
  if (!im) { bm.delete(L.id); return; } // сервер не запущен — попробуем позже
  if (bm.get(L.id) !== c) return;
  if (!hasPix(L)) {
    L.w = im.naturalWidth; L.h = im.naturalHeight;
    c.width = L.w; c.height = L.h;
    if (L.fitBbox) { delete L.fitBbox; doc().bbox = { x: L.x, y: L.y, w: L.w, h: L.h }; fitted = false; }
    keep();
  }
  const x = c.getContext('2d');
  x.globalCompositeOperation = 'destination-over';
  x.drawImage(im, 0, 0, L.w, L.h);
  x.globalCompositeOperation = 'source-over';
  bump(L.id, false);
  refresh();
}
function loadAll() { for (const L of doc().layers) canvasOf(L); }

// холст слоя растёт, если рисуют за его краем (с запасом PAD)
function grow(L, x0, y0, x1, y1) {
  const c = canvasOf(L);
  x0 = Math.floor(x0); y0 = Math.floor(y0); x1 = Math.ceil(x1); y1 = Math.ceil(y1);
  if (hasPix(L) && x0 >= L.x && y0 >= L.y && x1 <= L.x + L.w && y1 <= L.y + L.h) return c;
  let nx0, ny0, nx1, ny1;
  if (!hasPix(L)) { nx0 = x0 - PAD; ny0 = y0 - PAD; nx1 = x1 + PAD; ny1 = y1 + PAD; }
  else {
    nx0 = x0 < L.x ? x0 - PAD : L.x; ny0 = y0 < L.y ? y0 - PAD : L.y;
    nx1 = x1 > L.x + L.w ? x1 + PAD : L.x + L.w; ny1 = y1 > L.y + L.h ? y1 + PAD : L.y + L.h;
  }
  if (nx1 - nx0 > MAXSIDE || ny1 - ny0 > MAXSIDE) return c;
  const n = mk(nx1 - nx0, ny1 - ny0);
  if (hasPix(L)) n.getContext('2d').drawImage(c, L.x - nx0, L.y - ny0);
  Object.assign(L, { x: nx0, y: ny0, w: nx1 - nx0, h: ny1 - ny0 });
  bm.set(L.id, n);
  return n;
}
// правка пикселей: новая подпись, выгрузка файла, пересчёт режима
function bump(id, save = true) {
  revs.set(id, (revs.get(id) || 0) + 1);
  if (save) { dirty.add(id); saveLayers(); }
  detect();
}
const saveLayers = debounce(async () => {
  if (!S.server.running) return;
  for (const id of [...dirty]) {
    dirty.delete(id);
    // слой мог остаться в другом холсте, если переключились до выгрузки
    const L = Object.values(st.docs).flatMap(d => d.layers).find(l => l.id === id), c = bm.get(id);
    if (!L || !c || !hasPix(L)) continue;
    try {
      L.file = await upload(await toFile(c, `naizer_layer_${Date.now()}_${id}.png`));
      keep();
    } catch (e) { dirty.add(id); log('warn', `слой «${L.name}» не сохранён: ${e.message}`); }
  }
}, 900);
const toFile = async (c, name) => new File([await new Promise(r => c.toBlob(r, 'image/png'))], name, { type: 'image/png' });
const copyC = c => { if (!c) return null; const n = mk(c.width, c.height); n.getContext('2d').drawImage(c, 0, 0); return n; };

// снимки для отмены: документ (JSON) + копии пикселей затронутых слоёв
function pushHist(ids = []) {
  hist.undo.push(snap(ids));
  if (hist.undo.length > 30) hist.undo.shift();
  hist.redo = [];
}
function snap(ids) { return { doc: JSON.stringify(doc()), bms: ids.map(id => [id, copyC(bm.get(id))]).filter(e => e[1]) }; }
function undo(redo = false) {
  const [from, to] = redo ? [hist.redo, hist.undo] : [hist.undo, hist.redo];
  const e = from.pop();
  if (!e) return;
  to.push(snap(e.bms.map(b => b[0])));
  st.docs[st.cur] = JSON.parse(e.doc);
  for (const [id, c] of e.bms) { bm.set(id, copyC(c)); bump(id); }
  keep(); detect(); refresh();
}
function changeDoc(fn, ids = []) {
  pushHist(ids);
  fn(doc());
  keep(); detect(); refresh();
}

// ---------- слои ----------
function addLayer(type, props = {}) {
  const d = doc(), n = d.layers.filter(l => l.type === type).length + 1;
  const L = { id: uid(), type, name: type === 'mask' ? `Маска ${n}` : `Слой ${n}`, x: 0, y: 0, w: 0, h: 0, file: '', visible: true, opacity: 1,
    ...(type === 'mask' ? { denoise: 1, color: MASK_COLORS[(n - 1) % MASK_COLORS.length] } : {}), ...props };
  // маски — над растровыми, новый слой — над активным своего вида
  const A = activeL(), firstMask = d.layers.findIndex(l => l.type === 'mask');
  const i = A?.type === type ? d.layers.indexOf(A) + 1 : type === 'mask' || firstMask < 0 ? d.layers.length : firstMask;
  d.layers.splice(i, 0, L);
  d.active = L.id;
  return L;
}
function setActive(id) { const d = doc(); if (d.active === id) return; d.active = id; keep(); refresh(); }
function delLayer(L) {
  changeDoc(d => {
    const i = d.layers.indexOf(L);
    d.layers.splice(i, 1);
    d.active = d.layers[Math.min(i, d.layers.length - 1)]?.id || null;
  });
}
function dupLayer(L) {
  const c = { ...JSON.parse(JSON.stringify(L)), id: uid(), name: `${L.name} (копия)` };
  const src = bm.get(L.id);
  changeDoc(d => { d.layers.splice(d.layers.indexOf(L) + 1, 0, c); d.active = c.id; });
  if (src) { bm.set(c.id, copyC(src)); bump(c.id); }
}
function moveLayer(L, to) {
  const d = doc(), from = d.layers.indexOf(L);
  to = clamp(to, 0, d.layers.length - 1);
  if (from === to) return;
  changeDoc(dd => { dd.layers.splice(from, 1); dd.layers.splice(to, 0, L); });
}
// слить растровый слой с нижним растровым
function mergeDown(L) {
  const d = doc(), below = d.layers.slice(0, d.layers.indexOf(L)).reverse().find(l => l.type === L.type);
  if (!below) return log('warn', 'ниже нет слоя того же вида');
  const a = bm.get(L.id), b = bm.get(below.id);
  if (!a || !b) return;
  const r = union([L, below].filter(hasPix));
  if (!r) return;
  pushHist([below.id]);
  const n = mk(r.w, r.h), x = n.getContext('2d');
  if (hasPix(below)) { x.globalAlpha = shown(below) ? below.opacity ?? 1 : 0; x.drawImage(b, below.x - r.x, below.y - r.y); }
  if (hasPix(L)) { x.globalAlpha = shown(L) ? L.opacity ?? 1 : 0; x.drawImage(a, L.x - r.x, L.y - r.y); }
  Object.assign(below, { x: r.x, y: r.y, w: r.w, h: r.h, opacity: 1, visible: true });
  bm.set(below.id, n);
  d.layers.splice(d.layers.indexOf(L), 1);
  d.active = below.id;
  bump(below.id); keep(); refresh();
}
function union(list) {
  if (!list.length) return null;
  const x0 = Math.min(...list.map(L => L.x)), y0 = Math.min(...list.map(L => L.y));
  const x1 = Math.max(...list.map(L => L.x + L.w)), y1 = Math.max(...list.map(L => L.y + L.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// маска: инвертировать в пределах рамки / очистить
function invertMask(L) {
  if (L?.type !== 'mask') return log('warn', 'выберите маску');
  const r = doc().bbox;
  pushHist([L.id]);
  const c = grow(L, r.x, r.y, r.x + r.w, r.y + r.h), x = c.getContext('2d');
  x.save(); x.beginPath(); x.rect(r.x - L.x, r.y - L.y, r.w, r.h); x.clip();
  x.globalCompositeOperation = 'xor'; x.fillStyle = L.color; x.fillRect(r.x - L.x, r.y - L.y, r.w, r.h);
  x.restore();
  bump(L.id); refresh();
}
function clearLayer(L) {
  if (!L) return;
  pushHist([L.id]);
  const c = canvasOf(L);
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
  bump(L.id); refresh();
}
function recolor(L, color) {
  const c = canvasOf(L), x = c.getContext('2d');
  x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
  x.globalCompositeOperation = 'source-over';
  L.color = color; keep(); bump(L.id); refresh();
}
// растровый слой → маска по его непрозрачной части
function layerToMask(L) {
  const src = bm.get(L.id);
  if (!src || !hasPix(L)) return;
  pushHist();
  const M = addLayer('mask', { x: L.x, y: L.y, w: L.w, h: L.h });
  const c = mk(L.w, L.h), x = c.getContext('2d');
  x.drawImage(src, 0, 0);
  x.globalCompositeOperation = 'source-in'; x.fillStyle = M.color; x.fillRect(0, 0, L.w, L.h);
  bm.set(M.id, c); bump(M.id); keep(); refresh();
}
// растянуть слой в рамку
function fitToBbox(L) {
  const src = bm.get(L.id), r = doc().bbox;
  if (!src || !hasPix(L)) return;
  pushHist([L.id]);
  const k = Math.min(r.w / L.w, r.h / L.h), w = Math.round(L.w * k), hh = Math.round(L.h * k);
  const c = mk(w, hh), x = c.getContext('2d');
  x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, w, hh);
  Object.assign(L, { x: Math.round(r.x + (r.w - w) / 2), y: Math.round(r.y + (r.h - hh) / 2), w, h: hh });
  bm.set(L.id, c); bump(L.id); keep(); refresh();
}

// картинка → новый растровый слой (на пустом холсте — рамка по картинке)
async function addImage(file) {
  if (!file) return;
  const im = await loadPic(file);
  if (!im) return log('error', `не открылась картинка ${file} (сервер запущен?)`);
  const d = doc(), first = !rasters().some(hasPix);
  pushHist();
  const r = d.bbox, w = im.naturalWidth, hh = im.naturalHeight;
  const L = addLayer('raster', { name: file.split('/').pop().replace(/\.[^.]+$/, ''), file, w, h: hh,
    x: first ? 0 : Math.round(r.x + (r.w - w) / 2), y: first ? 0 : Math.round(r.y + (r.h - hh) / 2) });
  if (first) { d.bbox = { x: 0, y: 0, w, h: hh }; fitted = false; }
  const c = mk(w, hh);
  c.getContext('2d').drawImage(im, 0, 0);
  bm.set(L.id, c); bump(L.id, false);
  keep(); refresh();
  if (first) fit();
}
// холсты в Hierarchy: новый (рамка 1024 — сервер всё равно масштабирует её к родному размеру модели), открыть,
// переименовать, удалить; у каждого своя отмена не хранится — история сбрасывается при переключении
function newCanvas() {
  const id = uid();
  st.docs[id] = { ...newDoc(), name: nextName() };
  openCanvas(id);
}
function openCanvas(id) {
  if (!st.docs[id]) return;
  st.cur = id;
  doc().at = Date.now();
  hist = { undo: [], redo: [] };
  fitted = false;
  keep(); loadAll(); detect(); refresh();
}
async function renameCanvas(id) {
  const d = st.docs[id];
  const r = d && await prompt('Переименовать холст', [{ key: 'name', label: 'имя', value: d.name }], 'Переименовать');
  if (!r?.name?.trim()) return;
  d.name = r.name.trim(); keep(); refresh();
}
async function deleteCanvas(id) {
  const d = st.docs[id];
  if (!d || !(await confirmBox(`Удалить холст «${d.name}»? Слои и результаты в staging пропадут.`, { ok: 'Удалить' }))) return;
  delete st.docs[id];
  if (id === st.cur) { const next = byRecent()[0]?.[0]; if (next) openCanvas(next); else newCanvas(); }
  keep(); refresh();
}
function dupCanvas(id) {
  const d = st.docs[id];
  if (!d) return;
  const c = JSON.parse(JSON.stringify(d)), ids = new Map();
  c.layers.forEach(L => { const n = uid(); ids.set(L.id, n); const b = bm.get(L.id); L.id = n; if (b) bm.set(n, copyC(b)); });
  c.active = ids.get(d.active) || null;
  c.name = `${d.name} (копия)`;
  const nid = uid();
  st.docs[nid] = c;
  openCanvas(nid);
}

// ---------- композит ----------
// растровые слои в прямоугольнике мира (масштаб k — для быстрых проверок)
function compose(r, k = 1, list = rasters()) {
  const c = mk(r.w * k, r.h * k), x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  for (const L of list) {
    const b = bm.get(L.id);
    if (!b || !shown(L) || !hasPix(L) || !isectR(L, r)) continue;
    x.globalAlpha = clamp(L.opacity ?? 1, 0, 1);
    x.drawImage(b, (L.x - r.x) * k, (L.y - r.y) * k, L.w * k, L.h * k);
  }
  return c;
}
// маски: чёрное — не трогать, серое/белое — предел силы маски; null — масок в рамке нет
function maskComposite(r, k = 1) {
  const list = masks().filter(L => shown(L) && hasPix(L) && bm.get(L.id) && isectR(L, r));
  if (!list.length) return null;
  const c = mk(r.w * k, r.h * k), x = c.getContext('2d');
  x.fillStyle = '#000'; x.fillRect(0, 0, c.width, c.height);
  x.globalCompositeOperation = 'lighten';
  for (const L of list) {
    const t = mk(L.w, L.h), tx = t.getContext('2d');
    tx.drawImage(bm.get(L.id), 0, 0);
    const g = Math.round(clamp(L.denoise ?? 1, 0, 1) * 255);
    tx.globalCompositeOperation = 'source-in'; tx.fillStyle = `rgb(${g},${g},${g})`; tx.fillRect(0, 0, L.w, L.h);
    x.drawImage(t, (L.x - r.x) * k, (L.y - r.y) * k, L.w * k, L.h * k);
  }
  return c;
}
const alphaRange = c => {
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  let lo = 255, hi = 0;
  for (let i = 3; i < d.length; i += 4) { if (d[i] < lo) lo = d[i]; if (d[i] > hi) hi = d[i]; }
  return [lo, hi];
};
const anyLit = c => {
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  for (let i = 0; i < d.length; i += 4) if (d[i] > 2) return true;
  return false;
};
// режим генерации по содержимому рамки (как getGenerationMode в InvokeAI); сервер решает так же
const detect = debounce(() => {
  const r = doc().bbox, k = Math.min(1, 256 / Math.max(r.w, r.h));
  const [lo, hi] = alphaRange(compose(r, k));
  const m = maskComposite(r, k);
  mode = hi === 0 ? 'txt2img' : lo < 250 ? 'outpaint' : m && anyLit(m) ? 'inpaint' : 'img2img';
  const el = document.getElementById('nz-mode');
  if (el) { el.textContent = MODES[mode][0]; el.dataset.tip = MODES[mode][1]; }
  draw();
  if (S.sel?.kind === 'naizer') refresh_();
}, 200);

async function saveImage(whole) {
  const vis = rasters().filter(L => shown(L) && hasPix(L));
  const r = whole ? union(vis) : doc().bbox;
  if (!r) return log('warn', 'холст пуст');
  try {
    const file = await upload(await toFile(compose(r), `canvas_${new Date().toISOString().slice(0, 19).replace(/\D/g, '')}.png`), 'output');
    log('ok', `сохранено: ${file}`);
    loadFiles();
  } catch (e) { log('error', `сохранение: ${e.message}`); }
}

// ---------- вид ----------
const toW = p => ({ x: (p.x - view.x) / view.z, y: (p.y - view.y) / view.z });
function fit() {
  if (!wrap) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  const vis = rasters().filter(L => shown(L) && hasPix(L));
  const r = union([doc().bbox, ...vis]);
  view.z = clamp(Math.min((W - 60) / r.w, (H - 90) / r.h), 0.05, 4);
  view.x = (W - r.w * view.z) / 2 - r.x * view.z;
  view.y = (H - 30 - r.h * view.z) / 2 - r.y * view.z;
  fitted = true;
  zoomInfo();
  draw();
}
function zoomTo(z, p = { x: wrap.clientWidth / 2, y: wrap.clientHeight / 2 }) {
  z = clamp(z, 0.05, 16);
  view.x = p.x - (p.x - view.x) * (z / view.z); view.y = p.y - (p.y - view.y) * (z / view.z); view.z = z;
  fitted = true;
  zoomInfo();
  draw();
}
function zoomInfo() { const el = document.getElementById('nz-zoom'); if (el) el.textContent = `${Math.round(view.z * 100)}%`; }

function checkerPattern(c) {
  if (!checker) {
    const t = mk(16, 16), x = t.getContext('2d');
    x.fillStyle = '#2B2D30'; x.fillRect(0, 0, 16, 16);
    x.fillStyle = '#35373B'; x.fillRect(0, 0, 8, 8); x.fillRect(8, 8, 8, 8);
    checker = t;
  }
  return c.createPattern(checker, 'repeat');
}
const stageItem = () => { const d = doc(); return st.stage && d.staging.length ? d.staging[clamp(d.si, 0, d.staging.length - 1)] : null; };

function draw() {
  if (!cv || !wrap?.isConnected) return;
  const W = wrap.clientWidth, H = wrap.clientHeight, dpr = devicePixelRatio || 1;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#1E1F22';
  c.fillRect(0, 0, W, H);
  if (!fitted) fit();
  const d = doc(), z = view.z, r = d.bbox;
  // точки сетки (через 64 px мира, пока не слишком мелко)
  const step = 64 * z;
  if (step >= 14) {
    c.fillStyle = '#2E3034';
    const ox = ((view.x % step) + step) % step, oy = ((view.y % step) + step) % step;
    for (let y = oy; y < H; y += step) for (let x = ox; x < W; x += step) c.fillRect(x - 0.75, y - 0.75, 1.5, 1.5);
  }
  const S2 = (x, y, w, hh) => [view.x + x * z, view.y + y * z, w * z, hh * z];
  // рамка: шахматка — пустое (outpaint)
  c.save();
  c.translate(view.x, view.y); c.scale(z, z);
  c.fillStyle = checkerPattern(c);
  c.fillRect(r.x, r.y, r.w, r.h);
  c.imageSmoothingEnabled = z < 2;
  c.imageSmoothingQuality = 'high';
  for (const L of d.layers) {
    if (L.type !== 'raster' || !shown(L) || !hasPix(L)) continue;
    const b = bm.get(L.id);
    if (!b) continue;
    c.globalAlpha = clamp(L.opacity ?? 1, 0, 1);
    c.drawImage(b, L.x, L.y, L.w, L.h);
  }
  c.globalAlpha = 1;
  // staging / поэтапное превью — поверх слоёв, в своей рамке
  const prev = busy?.docId === st.cur ? busy.preview : null;
  const sItem = !prev && stageItem();
  if (prev?.complete && busy.preview.naturalWidth) {
    c.drawImage(prev, busy.rect.x, busy.rect.y, busy.rect.w, busy.rect.h);
  } else if (sItem) {
    const im = pic(sItem.file);
    if (im) c.drawImage(im, sItem.rect.x, sItem.rect.y, sItem.rect.w, sItem.rect.h);
  }
  const A = activeL();
  for (const L of d.layers) {
    if (L.type !== 'mask' || !shown(L) || !hasPix(L)) continue;
    const b = bm.get(L.id);
    if (!b) continue;
    c.globalAlpha = (L.id === A?.id ? 0.55 : 0.4) * (sItem || prev ? 0.4 : 1);
    c.drawImage(b, L.x, L.y, L.w, L.h);
  }
  c.globalAlpha = 1;
  c.restore();
  // активный слой — рамка его пикселей
  if (A && shown(A) && hasPix(A) && (st.tool === 'move' || A.type === 'raster')) {
    c.setLineDash(st.tool === 'move' ? [] : [2, 3]); c.strokeStyle = st.tool === 'move' ? '#3574F0' : '#3574F066'; c.lineWidth = 1;
    c.strokeRect(...S2(A.x, A.y, A.w, A.h)); c.setLineDash([]);
  }
  // рамка генерации
  const br = S2(r.x, r.y, r.w, r.h), bt = st.tool === 'bbox';
  c.strokeStyle = '#000a'; c.lineWidth = 3; c.strokeRect(br[0] - 0.5, br[1] - 0.5, br[2] + 1, br[3] + 1);
  c.strokeStyle = busy ? '#57965C' : bt ? '#548AF7' : '#DFE1E5'; c.lineWidth = 1.2;
  if (!bt && !busy) c.setLineDash([6, 4]);
  c.strokeRect(br[0] - 0.5, br[1] - 0.5, br[2] + 1, br[3] + 1); c.setLineDash([]);
  if (bt) for (const [hx, hy] of handles(br)) { c.fillStyle = '#fff'; c.strokeStyle = '#548AF7'; c.fillRect(hx - 4, hy - 4, 8, 8); c.strokeRect(hx - 4, hy - 4, 8, 8); }
  badge(c, `${r.w}×${r.h} · ${MODES[mode][0]}`, br[0], br[1] - 24);
  // фигура в процессе
  if (shape?.kind === 'rect' || shape?.kind === 'lasso') {
    c.setLineDash([5, 4]); c.strokeStyle = shape.erase ? '#DB5C5C' : '#fff'; c.lineWidth = 1.5;
    if (shape.kind === 'rect') c.strokeRect(Math.min(shape.a.x, shape.b.x), Math.min(shape.a.y, shape.b.y), Math.abs(shape.b.x - shape.a.x), Math.abs(shape.b.y - shape.a.y));
    else if (shape.pts.length > 1) { c.beginPath(); shape.pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath(); c.stroke(); }
    c.setLineDash([]);
  }
  // курсор кисти (размер — в пикселях мира)
  if (mouse && (st.tool === 'brush' || st.tool === 'eraser') && !shape?.pan && !space && !mouse.alt) {
    c.beginPath(); c.arc(mouse.x, mouse.y, Math.max(1, st.size * z / 2), 0, 7);
    c.strokeStyle = '#000a'; c.lineWidth = 3; c.stroke();
    c.strokeStyle = st.tool === 'eraser' ? '#DB5C5C' : A?.type === 'mask' ? A.color : st.color; c.lineWidth = 1.2; c.stroke();
  }
  if (busy) {
    const label = busy.max ? `шаг ${busy.step}/${busy.max}${busy.total > 1 ? ` · ${busy.total - busy.left}/${busy.total}` : ''}` : 'В очереди…';
    badge(c, label, 10, 10);
    if (busy.max) { c.fillStyle = '#57965C'; c.fillRect(0, 0, W * clamp(busy.step / busy.max, 0, 1), 3); }
  }
}
function badge(c, text, x, y) {
  c.font = '600 11px Inter, sans-serif';
  const w = c.measureText(text).width + 14;
  c.fillStyle = '#000b'; c.beginPath(); c.roundRect(x, y, w, 20, 10); c.fill();
  c.fillStyle = '#fff'; c.fillText(text, x + 7, y + 14);
}
// ручки рамки: 4 угла и 4 стороны (экранные координаты)
const handles = ([x, y, w, hh]) => [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + hh / 2], [x + w, y + hh], [x + w / 2, y + hh], [x, y + hh], [x, y + hh / 2]];
const HANDLE_SIDES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

// ---------- мышь ----------
const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, alt: e.altKey, shift: e.shiftKey }; };
function track(move, up) {
  const u = ev => { removeEventListener('pointermove', move); removeEventListener('pointerup', u); up?.(ev); };
  addEventListener('pointermove', move); addEventListener('pointerup', u);
}
const snap8 = v => Math.round(v / 8) * 8;
function bboxHit(p) {
  const r = doc().bbox, br = [view.x + r.x * view.z, view.y + r.y * view.z, r.w * view.z, r.h * view.z];
  const i = handles(br).findIndex(([x, y]) => Math.abs(p.x - x) <= 7 && Math.abs(p.y - y) <= 7);
  if (i >= 0) return HANDLE_SIDES[i];
  return p.x > br[0] && p.x < br[0] + br[2] && p.y > br[1] && p.y < br[1] + br[3] ? 'move' : null;
}
// слой для рисования: активный; нет — новый (растровый для кисти, маска — если активна маска)
function paintTarget() {
  let L = activeL();
  if (!L) { pushHist(); L = addLayer('raster'); keep(); refresh(); }
  return L;
}
function pickColor(p) {
  const w = toW(p), c = compose({ x: Math.floor(w.x), y: Math.floor(w.y), w: 1, h: 1 });
  const [r, g, b, a] = c.getContext('2d').getImageData(0, 0, 1, 1).data;
  if (!a) return;
  st.color = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  keep(); refresh();
}

function onDown(e) {
  cv.focus();
  const p = pos(e);
  if (e.button === 1 || e.button === 2 || (e.button === 0 && (space || st.tool === 'hand'))) {
    e.preventDefault();
    const v0 = { ...view };
    shape = { pan: true };
    cv.style.cursor = 'grabbing';
    return track(ev => { const q = pos(ev); view.x = v0.x + q.x - p.x; view.y = v0.y + q.y - p.y; draw(); }, () => { shape = null; setCursor(); draw(); });
  }
  if (e.button !== 0) return;
  const d = doc();
  if (st.tool === 'picker' || (st.tool === 'brush' && e.altKey)) return pickColor(p);
  if (st.tool === 'bbox') {
    const hit = bboxHit(p), r0 = { ...d.bbox }, a = toW(p), before = JSON.stringify(d);
    const done = () => { if (JSON.stringify(d) !== before) { hist.undo.push({ doc: before, bms: [] }); hist.redo = []; keep(); detect(); refresh(); } };
    if (hit === 'move') return track(ev => { const q = toW(pos(ev)); d.bbox = { ...r0, x: snap8(r0.x + q.x - a.x), y: snap8(r0.y + q.y - a.y) }; draw(); }, done);
    if (hit) {
      return track(ev => {
        const q = toW(pos(ev));
        let x0 = r0.x, y0 = r0.y, x1 = r0.x + r0.w, y1 = r0.y + r0.h;
        if (hit.includes('w')) x0 = Math.min(x1 - 64, snap8(q.x));
        if (hit.includes('e')) x1 = Math.max(x0 + 64, snap8(q.x));
        if (hit.includes('n')) y0 = Math.min(y1 - 64, snap8(q.y));
        if (hit.includes('s')) y1 = Math.max(y0 + 64, snap8(q.y));
        // Shift — сохранить пропорции (по углу)
        if (ev.shiftKey && hit.length === 2) {
          const k = r0.w / r0.h, w = x1 - x0, hh = Math.round(w / k / 8) * 8;
          if (hit.includes('n')) y0 = y1 - hh; else y1 = y0 + hh;
        }
        d.bbox = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        draw();
      }, done);
    }
    // новая рамка — протянуть
    return track(ev => {
      const q = toW(pos(ev));
      const x0 = snap8(Math.min(a.x, q.x)), y0 = snap8(Math.min(a.y, q.y));
      d.bbox = { x: x0, y: y0, w: Math.max(64, snap8(Math.abs(q.x - a.x))), h: Math.max(64, snap8(Math.abs(q.y - a.y))) };
      draw();
    }, done);
  }
  if (st.tool === 'move') {
    const L = activeL();
    if (!L) return log('warn', 'нет активного слоя — выберите слой справа');
    const before = JSON.stringify(d), x0 = L.x, y0 = L.y, a = toW(p);
    return track(ev => { const q = toW(pos(ev)); L.x = Math.round(x0 + q.x - a.x); L.y = Math.round(y0 + q.y - a.y); draw(); }, () => {
      if (L.x === x0 && L.y === y0) return;
      hist.undo.push({ doc: before, bms: [] }); hist.redo = [];
      revs.set(L.id, (revs.get(L.id) || 0) + 1);
      keep(); detect(); refresh();
    });
  }
  const L = paintTarget();
  const color = L.type === 'mask' ? L.color : st.color;
  const erase = st.tool === 'eraser' || e.altKey;
  pushHist([L.id]);
  const paint = (wx0, wy0, wx1, wy1, fn) => {
    const c = grow(L, wx0, wy0, wx1, wy1), x = c.getContext('2d');
    x.save();
    x.translate(-L.x, -L.y);
    x.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    x.fillStyle = x.strokeStyle = color;
    x.lineCap = x.lineJoin = 'round';
    fn(x);
    x.restore();
  };
  if (st.tool === 'brush' || st.tool === 'eraser') {
    let last = toW(p);
    const s = st.size / 2 + 2;
    const dab = (a, b) => paint(Math.min(a.x, b.x) - s, Math.min(a.y, b.y) - s, Math.max(a.x, b.x) + s, Math.max(a.y, b.y) + s,
      x => { x.lineWidth = st.size; x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x + 0.01, b.y); x.stroke(); });
    dab(last, last);
    draw();
    return track(ev => { const q = toW(pos(ev)); dab(last, q); last = q; mouse = pos(ev); draw(); }, () => { bump(L.id); refresh(); });
  }
  if (st.tool === 'rect') {
    shape = { kind: 'rect', a: p, b: p, erase };
    return track(ev => { shape.b = pos(ev); draw(); }, () => {
      const a = toW(shape.a), b = toW(shape.b);
      const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), hh = Math.abs(b.y - a.y);
      if (w > 2 && hh > 2) { paint(x0, y0, x0 + w, y0 + hh, x => x.fillRect(x0, y0, w, hh)); bump(L.id); } else hist.undo.pop();
      shape = null; refresh();
    });
  }
  if (st.tool === 'lasso') {
    shape = { kind: 'lasso', pts: [p], erase };
    return track(ev => { shape.pts.push(pos(ev)); draw(); }, () => {
      const pts = shape.pts.map(toW);
      if (pts.length > 2) {
        const xs = pts.map(q => q.x), ys = pts.map(q => q.y);
        paint(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), x => { x.beginPath(); pts.forEach((q, i) => (i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y))); x.closePath(); x.fill(); });
        bump(L.id);
      } else hist.undo.pop();
      shape = null; refresh();
    });
  }
}
function onMove(e) {
  mouse = pos(e);
  if (st.tool === 'brush' || st.tool === 'eraser') draw();
  if (st.tool === 'bbox' && !shape) {
    const hit = bboxHit(mouse);
    cv.style.cursor = !hit ? 'crosshair' : hit === 'move' ? 'move' : { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' }[hit];
  }
}
function onWheel(e) {
  e.preventDefault();
  if (e.ctrlKey || e.altKey) { setSize(st.size * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); return; }
  zoomTo(view.z * Math.exp(-e.deltaY * 0.0015), pos(e));
}
function setSize(v) {
  st.size = Math.round(clamp(v, 1, 800)); keep();
  const s = document.getElementById('nz-size'); if (s) s.value = st.size;
  const n = document.getElementById('nz-sizen'); if (n) n.textContent = `${st.size} px`;
  draw();
}
function setCursor() {
  if (!cv) return;
  cv.style.cursor = space || st.tool === 'hand' ? 'grab' : st.tool === 'move' ? 'move'
    : st.tool === 'rect' || st.tool === 'lasso' || st.tool === 'bbox' || st.tool === 'picker' ? 'crosshair' : (st.tool === 'brush' || st.tool === 'eraser') ? 'none' : '';
}
async function onDrop(e) {
  e.preventDefault();
  for (const f of await imagesFromTransfer(e.dataTransfer)) await addImage(f);
}
async function onPaste(e) {
  const el = document.activeElement;
  if (activeView() !== 'naizer' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName) || !clipboardHasImage(e)) return;
  e.preventDefault();
  for (const f of await imagesFromClipboard(e)) await addImage(f);
}

// ---------- Magic ----------
// steps/cfg/сэмплер/негатив — только из рекомендации Magic под чекпоинт
async function loadRec(refresh = false) {
  const ck = ckptName();
  if (!ck || !S.server.running) return;
  rec = await fetchRec({ ckpt: ck, loras: [] }, refresh);
  refresh_();
}

// ---------- генерация ----------
// композиты рамки → файлы input/ (уникальные имена — кэш нод сервера по входам; та же подпись — тот же файл)
const sigOf = (r, type) => JSON.stringify([r, doc().layers.filter(L => L.type === type && shown(L)).map(L => [L.id, revs.get(L.id) || 0, L.x, L.y, L.opacity ?? 1, L.denoise ?? 1])]);
async function frameFile() {
  const r = { ...doc().bbox }, sig = sigOf(r, 'raster');
  if (frameUp.sig === sig) return frameUp.file;
  const file = await upload(await toFile(compose(r), `naizer_frame_${Date.now()}.png`));
  frameUp = { sig, file };
  return file;
}
async function maskFile() {
  const r = { ...doc().bbox }, sig = sigOf(r, 'mask');
  if (maskUp.sig === sig) return maskUp.file;
  const m = maskComposite(r);
  const file = m && anyLit(m) ? await upload(await toFile(m, `naizer_mask_${Date.now()}.png`)) : '';
  maskUp = { sig, file };
  return file;
}

async function run(more = false) {
  if (busy) return;
  if (!S.server.running) { log('warn', 'сервер не запущен'); emit('server-start'); return; }
  const ck = ckptName();
  if (!ck) return log('warn', 'выберите чекпоинт в Inspector');
  const prompt = (st.prompt || '').trim();
  if ((mode === 'txt2img' || mode === 'outpaint') && !prompt) log('warn', 'промпт пуст — модель нарисует что угодно');
  let image, mask;
  try { [image, mask] = await Promise.all([frameFile(), maskFile()]); } catch (e) { return log('error', `подготовка: ${e.message}`); }
  if (!rec?.ok) await loadRec();
  const n = more ? 1 : clamp(st.batch | 0, 1, 16);
  busy = { docId: st.cur, rect: { ...doc().bbox }, image, mask, ck, left: n, total: n, k: 0, step: 0, max: 0, preview: null, pid: null };
  refresh();
  next();
}
async function next() {
  const b = busy;
  if (!b || b.left <= 0) { busy = null; refresh(); return; }
  b.left -= 1;
  const q = rec?.prompt || { positive: 'masterpiece, best quality', negative: 'lowres, worst quality, bad anatomy' };
  const positive = [q.positive, (st.prompt || '').trim()].filter(Boolean).join(', ');
  const p = rec?.params || {};
  b.k += 1;
  const L = (from, out, to, inn) => ({ from, out, to, in: inn });
  const wf = {
    id: 'naizer', title: 'ImageNaizer: холст',
    nodes: [
      { id: 'ckpt', type: 'sd.checkpoint', props: { ckpt_name: b.ck } },
      { id: 'skip', type: 'sd.clip_skip', props: { stop_at_clip_layer: rec?.clip_skip || -2 } },
      { id: 'pos', type: 'sd.text_encode', props: { text: positive } },
      { id: 'neg', type: 'sd.text_encode', props: { text: q.negative } },
      { id: 'img', type: 'image.load', props: { file: b.image } },
      { id: 'gen', type: 'sd.canvas', props: { seed: -1, steps: p.steps ?? 25, cfg: p.cfg ?? 6, sampler_name: p.sampler_name || 'euler_ancestral',
        scheduler: p.scheduler || 'normal', denoise: st.denoise, fill: st.fill, resolution: 0, edge: 16, blur: 16 } },
    ],
    links: [L('ckpt', 'model', 'gen', 'model'), L('ckpt', 'clip', 'skip', 'clip'), L('skip', 'clip', 'pos', 'clip'), L('skip', 'clip', 'neg', 'clip'),
      L('pos', 'conditioning', 'gen', 'positive'), L('neg', 'conditioning', 'gen', 'negative'), L('ckpt', 'vae', 'gen', 'vae'),
      L('img', 'image', 'gen', 'image')],
    targets: ['gen'],
  };
  if (b.mask) { wf.nodes.push({ id: 'mask', type: 'image.load', props: { file: b.mask } }); wf.links.push(L('mask', 'image', 'gen', 'mask')); }
  b.pid = crypto.randomUUID().replace(/-/g, '');
  b.step = 0; b.max = 0; b.preview = null;
  try {
    await api('/api/prompt', { id: b.pid, workflow: wf });
    if (b.k === 1) log('info', `${MODES[mode][0]} · рамка ${b.rect.w}×${b.rect.h}${mode === 'txt2img' ? '' : ` · denoise ${st.denoise}`} · ${p.steps} шагов, cfg ${p.cfg}, ${p.sampler_name}/${p.scheduler}${b.total > 1 ? ` · ×${b.total}` : ''}`);
  } catch (e) {
    busy = null;
    for (const is of e.data?.issues || []) log('error', `нода ${is.node}: ${is.message}`);
    if (!e.data?.issues) log('error', `запуск: ${e.message}`);
    refresh();
  }
}
function onResult(file, seed, info) {
  const d = st.docs[busy.docId] || doc();
  d.staging.push({ file, seed, mode: info?.mode || mode, rect: { ...busy.rect } });
  d.si = d.staging.length - 1;
  st.stage = true;
  if (info?.infill === 'blur') log('warn', 'outpaint без LaMa: пустое заполнено размытыми цветами — Inspector → «Скачать» LaMa (196 МБ)');
  keep();
  pic(file);
  if (busy) busy.preview = null;
  refresh();
}

// ---------- staging ----------
function stageNav(k) { const d = doc(), n = d.staging.length; if (n < 2) return; d.si = (d.si + k + n) % n; keep(); refresh(); }
async function accept() {
  const d = doc(), it = d.staging[d.si];
  if (!it) return;
  const im = await loadPic(it.file);
  if (!im) return log('error', 'результат не загрузился');
  pushHist();
  const n = d.layers.filter(l => l.type === 'raster').length + 1;
  const A = activeL();
  if (A?.type !== 'raster') d.active = rasters().at(-1)?.id || null;
  const L = addLayer('raster', { name: `${it.mode} ${n}`, file: it.file, x: it.rect.x, y: it.rect.y, w: it.rect.w, h: it.rect.h, seed: it.seed });
  const c = mk(L.w, L.h);
  c.getContext('2d').drawImage(im, 0, 0, L.w, L.h);
  bm.set(L.id, c); bump(L.id, false);
  d.staging = []; d.si = 0;
  keep(); refresh();
  log('ok', `принято: новый слой «${L.name}»`);
}
function discard(all = false) {
  const d = doc();
  if (!d.staging.length) return;
  changeDoc(dd => {
    if (all) dd.staging = []; else dd.staging.splice(dd.si, 1);
    dd.si = clamp(dd.si, 0, Math.max(0, dd.staging.length - 1));
  });
}
function stagingBar() {
  const d = doc(), n = d.staging.length;
  if (!n && !busy) return null;
  const it = d.staging[d.si];
  const b = (k, tip, fn, dis = false, cls = '') => h(`button.b${cls}`, { 'data-tip': tip, disabled: dis, onclick: fn }, typeof k === 'string' && SVG[k] ? svg(k, 14) : icon(k, { size: 14 }));
  return h('div.nz-stage', {},
    busy ? h('span.row', { style: { gap: '6px' } }, h('span.nz-spin'), h('span#nz-pend', {}, busy.max ? `шаг ${busy.step}/${busy.max}` : 'в очереди'),
      busy.total > 1 ? h('span.dim', {}, `${busy.total - busy.left}/${busy.total}`) : null,
      h('button.b', { 'data-tip': 'Прервать (Ctrl+Shift+Enter)', onclick: () => { if (busy) busy.left = 0; interrupt(); } }, icon('stop', { size: 14 }))) : null,
    n ? h('span.row', { style: { gap: '2px' } },
      busy ? h('span.sep') : null,
      b('left', 'Предыдущий (←)', () => stageNav(-1), n < 2),
      h('span.mono', { style: { minWidth: '36px', textAlign: 'center' } }, `${d.si + 1}/${n}`),
      b('right', 'Следующий (→)', () => stageNav(1), n < 2),
      h('span.sep'),
      h('button.primary', { onclick: accept, 'data-tip': 'Принять — новый растровый слой на месте рамки (Enter)' }, icon('check', { size: 14 }), 'Принять'),
      b(st.stage ? 'show' : 'hide', 'Показать / скрыть результат (\\)', () => { st.stage = !st.stage; keep(); refresh(); }),
      b('refresh', 'Ещё вариант', () => run(true), !!busy),
      b('close', 'Отбросить этот (Del)', () => discard(false)),
      b('delete', 'Отбросить все', () => discard(true)),
      it?.seed != null ? h('span.dim.mono', { style: { marginLeft: '6px', fontSize: '11px' } }, `seed ${it.seed}`) : null) : null);
}

// ---------- вид v-naizer ----------
function toolbar() {
  const fileIn = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  fileIn.onchange = async () => { const f = fileIn.files[0]; if (!f) return; try { addImage(await upload(f)); } catch (e) { log('error', `загрузка: ${e.message}`); } };
  return h('div.bar', {},
    fileIn,
    h('button', { onclick: newCanvas, 'data-tip': 'Новый пустой холст — текущий останется в Hierarchy' }, icon('add', { size: 14 }), 'Новый'),
    h('button', { onclick: e => imagePicker(e.currentTarget, { onPick: f => addImage(f) }), 'data-tip': 'Добавить картинку слоем: из input/, output/ или с диска\nМожно перетащить файл или вставить Ctrl+V' }, icon('open', { size: 14 }), 'Картинка'),
    h('button.icon', { onclick: () => fileIn.click(), 'data-tip': 'С диска (проводник) — загрузится в input/' }, icon('upload', { size: 14 })),
    h('button.icon', { onclick: e => saveImage(e.shiftKey), 'data-tip': 'Сохранить рамку в output/\nShift — весь холст' }, icon('save', { size: 14 })),
    h('span.hsep'),
    h('button.icon', { 'data-tip': 'Отменить (Ctrl+Z)', disabled: !hist.undo.length, onclick: () => undo() }, icon('undo', { size: 14 })),
    h('button.icon', { 'data-tip': 'Повторить (Ctrl+Shift+Z)', disabled: !hist.redo.length, onclick: () => undo(true) }, icon('redo', { size: 14 })),
    h('span.hsep'),
    h('button.icon', { 'data-tip': 'Вписать (F)', onclick: fit }, icon('fit', { size: 14 })),
    h('button.icon', { 'data-tip': '100% (Ctrl+0)', onclick: () => zoomTo(1) }, icon('actualZoom', { size: 14 })),
    h('span.dim.mono#nz-zoom', { style: { minWidth: '40px', fontSize: '11px' } }, `${Math.round(view.z * 100)}%`),
    h('span.grow'),
    h('span.nz-mode#nz-mode', { 'data-tip': MODES[mode][1] }, MODES[mode][0]),
    busy ? h('button', { onclick: () => { if (busy) busy.left = 0; interrupt(); } }, icon('stop', { size: 14 }), 'Прервать')
      : h('button.primary', { onclick: () => run(), 'data-tip': 'Генерировать в рамке (Ctrl+Enter)' }, icon('play', { size: 14 }), 'Генерировать'));
}

function toolStrip() {
  const b = (id, title, key, tip, on, click) => h(`button.b${on ? '.on' : ''}`, { 'data-tip': `${title}${key ? ` (${key})` : ''}${tip ? `\n${tip}` : ''}`, onclick: click }, svg(id));
  const sw = h('button.b.nz-color', { 'data-tip': `Цвет кисти ${st.color}\nAlt+клик кистью — пипетка` });
  sw.append(h('span', { style: { background: st.color } }));
  const inp = h('input', { type: 'color', value: st.color, style: { position: 'absolute', opacity: 0, pointerEvents: 'none', width: 0, height: 0 } });
  inp.addEventListener('input', () => { st.color = inp.value; sw.firstChild.style.background = inp.value; keep(); draw(); });
  sw.onclick = () => inp.click();
  return h('div.ui-tb.vert.nz-tools', {},
    ...TOOLS.map(t => (t ? b(t[0], t[1], t[2], t[3], st.tool === t[0], () => setTool(t[0])) : h('span.sep'))),
    h('span.sep'), sw, inp);
}

function optionsBar() {
  const brush = st.tool === 'brush' || st.tool === 'eraser';
  const size = h('input.ui-range#nz-size', { type: 'range', min: 1, max: 400, step: 1, value: Math.min(400, st.size) });
  size.addEventListener('input', () => setSize(+size.value));
  const T = TOOLS.find(t => t?.[0] === st.tool), A = activeL(), r = doc().bbox;
  const target = A ? `${A.type === 'mask' ? 'маска' : 'слой'} «${A.name}»` : 'новый слой';
  const dim = (k, v) => num(v, x => changeDoc(d => { d.bbox[k] = Math.max(64, snap8(x)); }), { int: true, min: 64, max: 4096, step: 8 });
  const presets = [[1024, 1024], [832, 1216], [1216, 832], [896, 1152], [1152, 896], [512, 512], [512, 768], [768, 512]];
  return h('div.nz-opts', {},
    h('b', {}, T?.[1] || ''),
    brush ? h('span.row', { style: { gap: '6px' } }, 'размер', size, h('span.mono#nz-sizen', {}, `${st.size} px`)) : null,
    brush || st.tool === 'rect' || st.tool === 'lasso' ? h('span', {}, `→ ${target}`) : null,
    st.tool === 'bbox' ? h('span.row.nz-bbox', { style: { gap: '6px' } }, 'ш', dim('w', r.w), 'в', dim('h', r.h),
      dropdown('', [['', 'пропорции…'], ...presets.map(([w, hh]) => [`${w}x${hh}`, `${w}×${hh}`])], v => {
        if (!v) return;
        const [w, hh] = v.split('x').map(Number);
        changeDoc(d => { const cx = d.bbox.x + d.bbox.w / 2, cy = d.bbox.y + d.bbox.h / 2; d.bbox = { x: snap8(cx - w / 2), y: snap8(cy - hh / 2), w, h: hh }; });
      }, { width: 110 }),
      h('button', { 'data-tip': 'Рамка по видимым слоям', onclick: () => { const u = union(rasters().filter(L => shown(L) && hasPix(L))); if (u) changeDoc(d => { d.bbox = { x: u.x, y: u.y, w: Math.max(64, u.w), h: Math.max(64, u.h) }; }); } }, 'по слоям'),
      h('button', { 'data-tip': 'Рамка вокруг масок (с полями 32 px)', onclick: fitBboxToMasks }, 'по маскам'),
      h('span', {}, 'Shift — пропорции')) : null,
    st.tool === 'move' ? h('span', {}, A ? `${target} · ${A.x}, ${A.y}` : 'выберите слой') : null,
    h('span.grow'));
}
// рамка по маскам: точный охват непрозрачного, поля 32 px, кратно 8
function fitBboxToMasks() {
  let box = null;
  for (const L of masks().filter(l => shown(l) && hasPix(l))) {
    const c = bm.get(L.id);
    if (!c) continue;
    const dd = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
      if (dd[(y * c.width + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) continue;
    const b = { x: L.x + x0, y: L.y + y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    box = box ? union([box, b]) : b;
  }
  if (!box) return log('warn', 'маски пусты');
  changeDoc(d => {
    const x0 = Math.floor((box.x - 32) / 8) * 8, y0 = Math.floor((box.y - 32) / 8) * 8;
    d.bbox = { x: x0, y: y0, w: Math.max(64, Math.ceil((box.x + box.w + 32 - x0) / 8) * 8), h: Math.max(64, Math.ceil((box.y + box.h + 32 - y0) / 8) * 8) };
  });
}

function thumb(L) {
  const t = mk(38, 38), x = t.getContext('2d'), c = bm.get(L.id);
  if (c && hasPix(L)) {
    const k = Math.min(38 / L.w, 38 / L.h);
    x.imageSmoothingQuality = 'high';
    x.drawImage(c, (38 - L.w * k) / 2, (38 - L.h * k) / 2, L.w * k, L.h * k);
  }
  t.className = 'th';
  return t;
}
function layerRow(L) {
  const d = doc(), on = d.active === L.id;
  const eye = h('button.b.eye', { 'data-tip': 'Показать / скрыть (Alt+клик — только этот)', onclick: e => {
    e.stopPropagation();
    if (e.altKey) changeDoc(dd => { const solo = dd.layers.every(o => o === L || o.visible === false); dd.layers.forEach(o => { o.visible = solo || o === L; }); });
    else changeDoc(() => { L.visible = L.visible === false; });
  } }, icon(L.visible === false ? 'hide' : 'show', { size: 14 }));
  const name = editName === L.id
    ? (() => {
      const inp = h('input', { type: 'text', value: L.name, spellcheck: false });
      const done = ok => { if (editName !== L.id) return; editName = null; if (ok && inp.value.trim() && inp.value.trim() !== L.name) changeDoc(() => { L.name = inp.value.trim(); }); else render(); };
      inp.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
      inp.addEventListener('blur', () => done(true));
      setTimeout(() => { inp.focus(); inp.select(); });
      return inp;
    })()
    : h('b', { ondblclick: e => { e.stopPropagation(); editName = L.id; render(); } }, L.name);
  const sub = L.type === 'mask' ? `сила ≤ ${L.denoise ?? 1}` : hasPix(L) ? `${L.w}×${L.h}${(L.opacity ?? 1) < 1 ? ` · ${Math.round(L.opacity * 100)}%` : ''}` : 'пусто';
  const row = h(`div.nz-row${on ? '.on' : ''}${L.visible === false ? '.off' : ''}${L.type === 'mask' ? '.mask' : ''}`, {
    draggable: true, title: `${L.name}\nдвойной клик по имени — переименовать, перетащить — порядок`,
    onclick: () => setActive(L.id),
  }, eye, thumb(L), h('div.nm', {}, name, h('span', {}, sub)),
  L.type === 'mask' ? h('span.nz-dot', { style: { background: L.color } }) : null);
  if (L.type === 'mask') row.querySelector('.th').style.background = '#000';
  row.addEventListener('dragstart', e => { dragRow = L; e.dataTransfer.effectAllowed = 'move'; });
  row.addEventListener('dragend', () => { dragRow = null; });
  row.addEventListener('dragover', e => {
    if (!dragRow || dragRow === L || dragRow.type !== L.type) return;
    e.preventDefault();
    const r = row.getBoundingClientRect(), above = e.clientY < r.top + r.height / 2;
    row.classList.toggle('drop-above', above); row.classList.toggle('drop-below', !above);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
  row.addEventListener('drop', e => {
    e.preventDefault();
    row.classList.remove('drop-above', 'drop-below');
    if (!dragRow || dragRow === L || dragRow.type !== L.type) return;
    const r = row.getBoundingClientRect(), above = e.clientY < r.top + r.height / 2;
    const from = d.layers.indexOf(dragRow);
    // список показан сверху вниз, массив — снизу вверх: «выше в списке» = больший индекс
    let to = d.layers.indexOf(L) + (above ? 1 : 0);
    if (from < to) to -= 1;
    moveLayer(dragRow, to);
  });
  return row;
}

function sidePanel() {
  const d = doc(), A = activeL();
  const btn = (k, tip, fn, dis = false) => h('button.b', { 'data-tip': tip, disabled: dis, onclick: fn }, typeof k === 'string' && SVG[k] ? svg(k, 14) : icon(k, { size: 14 }));
  const group = (type, title) => {
    const list = d.layers.filter(L => L.type === type);
    return [h('div.nz-grp', {}, svg(type === 'mask' ? 'mask' : 'raster', 14), h('span', {}, title), h('span.grow'),
      btn('add', type === 'mask' ? 'Новая маска inpaint (Shift+M)' : 'Новый растровый слой (Shift+N)', () => { pushHist(); addLayer(type); keep(); refresh(); if (st.tool !== 'brush' && st.tool !== 'rect' && st.tool !== 'lasso') setTool('brush'); })),
    ...[...list].reverse().map(layerRow),
    !list.length ? h('div.hint', { style: { padding: '2px 8px 6px' } }, type === 'mask' ? 'нет масок — вся рамка img2img' : 'нет слоёв — рамка txt2img') : null];
  };
  const slider = (label, value, min, max, step, set, fmt = v => v) => {
    const r = h('input.ui-range', { type: 'range', min, max, step, value });
    const n = h('span.mono', { style: { width: '38px', textAlign: 'right' } }, fmt(value));
    let before = null;
    r.addEventListener('pointerdown', () => { before = JSON.stringify(doc()); });
    r.addEventListener('input', () => { set(+r.value); n.textContent = fmt(+r.value); draw(); });
    r.addEventListener('change', () => { if (before) { hist.undo.push({ doc: before, bms: [] }); hist.redo = []; before = null; } keep(); detect(); });
    return h('div.row', { style: { gap: '8px' } }, h('span.dim', { style: { width: '84px' } }, label), r, n);
  };
  const props = !A ? h('div.nz-props', {}, h('div.hint', {}, 'Слой не выбран. Кисть создаст новый растровый слой; маска (+ в «Маски inpaint») говорит, где менять.'))
    : A.type === 'mask' ? h('div.nz-props', {},
      slider('предел силы', A.denoise ?? 1, 0.05, 1, 0.05, v => { A.denoise = v; }),
      h('div.row', { style: { gap: '8px' } }, h('span.dim', { style: { width: '84px' } }, 'цвет'),
        ...MASK_COLORS.map(c => h(`button.nz-sw${A.color === c ? '.on' : ''}`, { style: { background: c }, onclick: () => recolor(A, c) }))),
      h('div.row', { style: { flexWrap: 'wrap', gap: '4px' } },
        h('button', { onclick: () => invertMask(A), 'data-tip': 'Инвертировать в пределах рамки (Ctrl+I)' }, svg('invert', 14), 'Инвертировать'),
        h('button', { onclick: () => clearLayer(A), 'data-tip': 'Стереть маску целиком (Shift+Del)' }, svg('clear', 14), 'Очистить')))
      : h('div.nz-props', {},
        slider('непрозрачность', Math.round((A.opacity ?? 1) * 100), 0, 100, 1, v => { A.opacity = v / 100; }, v => `${v}%`),
        h('div.row', { style: { flexWrap: 'wrap', gap: '4px' } },
          h('button', { onclick: () => fitToBbox(A), disabled: !hasPix(A), 'data-tip': 'Вписать слой в рамку (с сохранением пропорций)' }, svg('fitbox', 14), 'В рамку'),
          h('button', { onclick: () => layerToMask(A), disabled: !hasPix(A), 'data-tip': 'Маска по непрозрачной части слоя' }, svg('tomask', 14), 'В маску'),
          h('button', { onclick: () => clearLayer(A), disabled: !hasPix(A), 'data-tip': 'Стереть всё на слое (Shift+Del)' }, svg('clear', 14), 'Очистить')),
        A.seed != null ? h('div.hint', {}, `seed ${A.seed}`) : null);
  const side = h('div.nz-side', { style: { width: `${st.side}px` } },
    h('div.nz-split', { onpointerdown: e => {
      e.preventDefault();
      const x0 = e.clientX, w0 = st.side;
      track(ev => { st.side = clamp(w0 - (ev.clientX - x0), 200, 480); side.style.width = `${st.side}px`; draw(); }, () => keep());
    } }),
    h('div.hd', {}, svg('layers', 14), h('span', {}, 'Слои'), h('span.grow'),
      btn('copy', 'Дублировать', () => A && dupLayer(A), !A),
      btn('merge', 'Слить с нижним (Ctrl+E)', () => A && mergeDown(A), !A),
      btn('delete', 'Удалить слой (Del)', () => A && delLayer(A), !A)),
    h('div.nz-list', {}, ...group('mask', 'Маски inpaint'), ...group('raster', 'Растровые слои')),
    props);
  return side;
}

function setTool(t) { st.tool = t; keep(); render(); }

function render() {
  const v = document.getElementById('v-naizer');
  if (!v || !isShown('naizer')) return;
  if (!cv) {
    cv = h('canvas', { tabIndex: 0 });
    cv.addEventListener('pointerdown', onDown);
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerleave', () => { mouse = null; draw(); });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('dragover', e => e.preventDefault());
    cv.addEventListener('drop', onDrop);
    wrap = h('div.nz-wrap', {}, cv);
    new ResizeObserver(() => { if (!fitted) fit(); draw(); }).observe(wrap);
  }
  wrap.replaceChildren(cv, stagingBar() || '');
  v.replaceChildren(toolbar(), h('div.nz-body', {}, toolStrip(), wrap, sidePanel()), optionsBar());
  setCursor();
  draw();
}

// перерисовать вид, Hierarchy и Inspector (если в нём сейчас не печатают)
function refresh() {
  render();
  if (S.ctx === 'naizer') emit('change', { kind: null });
  refresh_();
}
function refresh_() {
  if (S.sel?.kind !== 'naizer') return;
  if (typingIn(document.getElementById('inspector'))) return;
  emit('select', S.sel);
}

// ---------- Hierarchy ----------
async function loadFiles() {
  if (!S.server.running) return;
  const ok = f => /\.(png|jpe?g|webp)$/i.test(f.file) && !/naizer_/.test(f.file);
  try {
    const [o, i] = await Promise.all([api('/api/files?dir=output'), api('/api/files?dir=input')]);
    files = { output: o.filter(ok).slice(0, 40), input: i.filter(ok).slice(0, 40) };
  } catch {}
  if (S.ctx === 'naizer') emit('change', { kind: null });
}
export function naizerTreeItems() {
  const rows = [{ grp: 'Холсты' }];
  for (const [id, d] of byRecent()) {
    rows.push({ ic: 'image', label: d.name || 'Холст', sel: id === st.cur, title: `${d.name}
ПКМ — переименовать, копия, удалить`,
      tag: [d.layers.length ? `слоёв: ${d.layers.length}` : 'пусто', d.staging?.length ? `staging ${d.staging.length}` : ''].filter(Boolean).join(' · '),
      onClick: () => { if (id !== st.cur) openCanvas(id); },
      act: id === st.cur ? { ic: 'add', tip: 'Новый холст', onClick: newCanvas } : null,
      menu: () => [
        { ic: 'open', label: 'Открыть', fn: () => openCanvas(id), disabled: id === st.cur },
        { ic: 'edit', label: 'Переименовать…', fn: () => renameCanvas(id) },
        { ic: 'copy', label: 'Копия холста', fn: () => dupCanvas(id) },
        '-',
        { ic: 'delete', label: 'Удалить холст…', fn: () => deleteCanvas(id) },
      ] });
  }
  rows.push({ grp: 'Картинки — щелчок добавляет слоем' });
  for (const [k, title] of [['output', 'Результаты (output/)'], ['input', 'Загруженные (input/)']]) {
    rows.push({ grp: title });
    if (!files[k].length) rows.push({ grp: S.server.running ? 'пусто' : 'сервер не запущен' });
    for (const f of files[k]) rows.push({ depth: 1, ic: 'image', label: f.file.split('/').pop(), title: f.file, onClick: () => addImage(f.file) });
  }
  return rows;
}

// ---------- Inspector ----------
// outpaint: сила дорисовки пустого и LaMa (без неё пустое заполняется размытыми цветами краёв)
function outpaintCard(row, slider) {
  if (cnNames() == null) loadCn();
  return [
    row('дорисовка', slider(st.fill, 0.3, 1, 0.05, x => { st.fill = x; keep(); }), 'сила для пустой части рамки'),
    h('div.hint', {}, '0.75–0.9 — продолжение картинки (свет, цвет, фон); 1 — модель рисует пустое с нуля, получается новая картинка поверх'),
    cnNames() != null && !cnPick('lama') ? cnMissing('lama', { slim: false, why: 'Без неё пустое заполняется размытыми цветами краёв и продолжение хуже.' }) : null,
  ];
}

const KEYS_TIP = 'C — рамка, V — слой, H — рука, B — кисть (Alt — пипетка), E — ластик, U — прямоугольник, L — лассо, I — пипетка\n'
  + '[ ] — размер кисти, Shift+N / Shift+M — новый слой / маска, Ctrl+I — инвертировать маску, Ctrl+E — слить с нижним\n'
  + 'Del — удалить слой (в staging — отбросить), Shift+Del — очистить слой\n'
  + 'Enter — принять результат, ← → — листать, \\ — показать/скрыть результат\n'
  + 'Ctrl+Z / Ctrl+Shift+Z — отмена / повтор, колесо — масштаб, ПКМ/Space — сдвиг, F — вписать, Ctrl+Enter — генерация';

function inspector() {
  const area = (value, ph, set, rows = 3) => {
    const t = h('textarea', { rows, spellcheck: false, placeholder: ph, title: 'Ctrl+↑ / Ctrl+↓ — вес тега: (girl:1.2)' });
    t.dataset.promptWeight = '';
    t.value = value || '';
    t.addEventListener('input', () => set(t.value));
    t.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); run(); } });
    return t;
  };
  const row = (label, ctl, tip) => h('div.f', { title: tip || '' }, h('label', {}, label), h('div.v', {}, ctl));
  const slider = (value, min, max, step, set) => {
    const r = h('input.ui-range', { type: 'range', min, max, step, value });
    const n = h('span.mono', { style: { width: '36px', textAlign: 'right' } }, String(value));
    r.addEventListener('input', () => { n.textContent = r.value; set(+r.value); });
    return h('div.row', { style: { flex: 1, gap: '8px' } }, r, n);
  };
  const ck = ckptName();
  const ckIn = h('input', { type: 'text', value: ck, spellcheck: false, readOnly: true });
  const ckBtn = h('button.icon', { 'data-tip': 'Галерея чекпоинтов', onclick: () => libraryPicker(ckBtn, { cat: 'checkpoints', value: ck, onPick: name => { st.ckpt = name; keep(); rec = null; loadRec(); refresh(); } }) }, icon('image', { size: 14 }));
  ckIn.addEventListener('click', () => ckBtn.click());
  if (!rec && ck && S.server.running) loadRec();
  const d = doc(), r = d.bbox;
  const strengthTip = { txt2img: 'в пустой рамке не используется (всегда 1)', img2img: '0.3–0.5 — те же формы, больше деталей; 0.6–0.8 — заметно перерисовать',
    inpaint: '0.3–0.5 — детализировать под маской, 0.8–1 — заменить по промпту', outpaint: 'сила под масками; пустое — «дорисовка»' }[mode];
  return [
    h('h3', {}, icon('spark', { size: 16 }), 'ImageNaizer', h('span.grow'), h('span.nz-help', { 'data-tip': KEYS_TIP }, '?')),
    h('div.hint', {}, `рамка ${r.w}×${r.h} · ${MODES[mode][0]} — ${MODES[mode][1].toLowerCase()} · слоёв: ${d.layers.length}`),
    h('h4', {}, 'Промпт'),
    area(st.prompt, mode === 'inpaint' ? 'что должно быть под маской, например: red rose in a glass vase' : 'что в рамке, например: girl in a garden, sunset', t => { st.prompt = t; keep(); }),
    row('сила', slider(st.denoise, 0.05, 1, 0.05, x => { st.denoise = x; keep(); }), `denoise: ${strengthTip}`),
    h('div.hint', {}, strengthTip),
    ...(mode === 'outpaint' ? outpaintCard(row, slider) : []),
    row('вариантов', num(st.batch, x => { st.batch = clamp(x | 0, 1, 16); keep(); }, { int: true, min: 1, max: 16 }), 'сколько результатов положить в staging за один запуск'),
    row('чекпоинт', h('div.row', { style: { flex: 1 } }, ckIn, ckBtn), 'шаги, cfg, сэмплер и негатив подбирает Magic под чекпоинт'),
    rec?.error ? h('div.hint', { style: { color: 'var(--err)' } }, `Magic: ${rec.error}`) : null,
    h('div.row', { style: { marginTop: '10px', flexWrap: 'wrap' } },
      busy ? h('button', { onclick: () => { if (busy) busy.left = 0; interrupt(); } }, icon('stop', { size: 14 }), 'Прервать')
        : h('button.primary', { onclick: () => run() }, icon('play', { size: 14 }), `Генерировать (${MODES[mode][0]})`)),
  ];
}

// ---------- клавиши (поверх общих: Ctrl+Z, Ctrl+Enter, цифры) ----------
function keys(e) {
  if (activeView() !== 'naizer' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase(), A = activeL(), staged = doc().staging.length > 0;
  let done = true;
  if (e.ctrlKey && (k === 'z' || k === 'я')) undo(e.shiftKey);
  else if (e.ctrlKey && (k === 'y' || k === 'н')) undo(true);
  else if (e.ctrlKey && e.key === 'Enter') { if (e.shiftKey) { if (busy) busy.left = 0; interrupt(); } else run(); }
  else if (e.ctrlKey && (k === 'i' || k === 'ш')) invertMask(A);
  else if (e.ctrlKey && (k === 'e' || k === 'у')) { if (A) mergeDown(A); }
  else if (e.ctrlKey && e.key === '0') zoomTo(1);
  else if (e.ctrlKey) done = false;
  else if (e.shiftKey && (k === 'n' || k === 'т')) { pushHist(); addLayer('raster'); keep(); refresh(); }
  else if (e.shiftKey && (k === 'm' || k === 'ь')) { pushHist(); addLayer('mask'); keep(); refresh(); }
  else if (e.key === 'Enter' && staged) accept();
  else if (e.key === 'ArrowLeft' && staged) stageNav(-1);
  else if (e.key === 'ArrowRight' && staged) stageNav(1);
  else if ((e.key === 'Delete' || e.key === 'Backspace') && e.shiftKey) clearLayer(A);
  else if ((e.key === 'Delete' || e.key === 'Backspace') && staged) discard(false);
  else if (e.key === 'Delete' || e.key === 'Backspace') { if (A) delLayer(A); }
  else if (e.key === '\\') { st.stage = !st.stage; keep(); refresh(); }
  else if (k === 'c' || k === 'с') setTool('bbox');
  else if (k === 'v' || k === 'м') setTool('move');
  else if (k === 'h' || k === 'р') setTool('hand');
  else if (k === 'b' || k === 'и') setTool('brush');
  else if (k === 'e' || k === 'у') setTool('eraser');
  else if (k === 'u' || k === 'г') setTool('rect');
  else if (k === 'l' || k === 'д') setTool('lasso');
  else if (k === 'i' || k === 'ш') setTool('picker');
  else if (k === 'f' || k === 'а') fit();
  else if (e.key === '[' || k === 'х') setSize(st.size / 1.2);
  else if (e.key === ']' || k === 'ъ') setSize(st.size * 1.2);
  else if (e.key === ' ') { if (!space) { space = true; setCursor(); draw(); } }
  else if (e.key === 'Alt') { if (mouse) { mouse.alt = true; draw(); } }
  else done = false;
  if (done) { e.preventDefault(); e.stopPropagation(); }
}

export function initNaizer() {
  registerInspector('naizer', inspector);
  document.addEventListener('keydown', keys, true);
  addEventListener('paste', onPaste);
  addEventListener('keyup', e => {
    if (e.key === ' ' && space) { space = false; setCursor(); draw(); }
    if (e.key === 'Alt' && mouse) { mouse.alt = false; draw(); }
  });
  on('run-progress', d => {
    if (!busy || d.prompt_id !== busy.pid || d.node !== 'gen') return;
    busy.step = d.value; busy.max = d.max;
    const el = document.getElementById('nz-pend'); if (el) el.textContent = `шаг ${busy.step}/${busy.max}`;
    draw();
  });
  on('run-preview', d => {
    if (!busy || d.prompt_id !== busy.pid) return;
    const im = new Image();
    im.onload = () => { if (busy) { busy.preview = im; draw(); } };
    im.src = d.image;
  });
  on('run-output', d => {
    if (!busy || d.prompt_id !== busy.pid || d.node !== 'gen') return;
    const ui = d.output?._ui;
    if (ui?.images?.[0]) onResult(ui.images[0], Number(d.output?.seed?.text ?? NaN) || null, ui.canvas);
  });
  on('run-done', d => {
    if (!busy || (d.prompt_id && d.prompt_id !== busy.pid)) return;
    if (!d.ok) {
      log(d.stopped ? 'warn' : 'error', `ImageNaizer: ${d.stopped ? 'прервано' : d.error?.message?.split('\n')[0] || 'запуск не удался'}`);
      busy = null; refresh(); return;
    }
    next();
  });
  on('server', s => {
    if (!s.running) return;
    setTimeout(() => {
      loadFiles();
      // картинки, не загрузившиеся без сервера, — заново
      for (const [f, im] of pics) if (!im.naturalWidth) pics.delete(f);
      loadAll();
      if (dirty.size) saveLayers();
      draw();
    }, 900);
  });
  addEventListener('view', e => { if (e.detail === 'naizer') render(); });
  on('cn-models', () => { if (S.sel?.kind === 'naizer') refresh_(); });
  loadAll();
  detect();
}

export function showNaizer() {
  if (S.sel?.kind !== 'naizer') select({ kind: 'naizer', id: 'naizer' });
  loadAll();
  loadFiles();
  render();
}

// ---------- управление из AI Agent (agent.js → действия naizer_* инструмента app) ----------
const settle = () => new Promise(r => setTimeout(r, 400)); // режим пересчитывается не сразу
const waitIdle = () => new Promise(res => { const t = setInterval(() => { if (!busy) { clearInterval(t); res(); } }, 300); });
export const naizerApi = {
  state() {
    const d = doc();
    return { canvas: d.name, canvases: byRecent().map(([, x]) => x.name), mode, busy: !!busy, ckpt: ckptName(),
      prompt: st.prompt, denoise: st.denoise, frame: d.bbox, staging: d.staging.map(s => s.file),
      layers: d.layers.map(L => ({ name: L.name, type: L.type, file: L.file || null, x: L.x, y: L.y, w: L.w, h: L.h, visible: L.visible !== false })) };
  },
  async open(files = [], name = '') {
    newCanvas();
    if (name) doc().name = String(name);
    for (const f of files) await addImage(f);
    keep(); refresh();
    await settle();
    return this.state();
  },
  async add(files = []) { for (const f of files) await addImage(f); await settle(); return this.state(); },
  // прямоугольники маски — доли рамки 0..1
  async mask(rects = [], strength = 1) {
    const r = doc().bbox;
    pushHist();
    const L = addLayer('mask', { denoise: clamp(+strength || 1, 0.05, 1), x: r.x, y: r.y, w: r.w, h: r.h });
    const c = mk(r.w, r.h), x = c.getContext('2d');
    x.fillStyle = L.color;
    for (const q of rects) x.fillRect(q.x * r.w, q.y * r.h, q.w * r.w, q.h * r.h);
    bm.set(L.id, c); bump(L.id); keep(); refresh();
    await settle();
    return this.state();
  },
  clearMasks() { changeDoc(d => { d.layers = d.layers.filter(l => l.type !== 'mask'); }); return this.state(); },
  async generate({ prompt, denoise, count } = {}) {
    if (busy) await waitIdle();
    if (prompt != null) st.prompt = String(prompt);
    if (denoise != null) st.denoise = clamp(+denoise, 0.05, 1);
    if (count != null) st.batch = clamp(count | 0, 1, 8);
    keep(); refresh();
    const before = doc().staging.length;
    await run();
    await waitIdle();
    const fresh = doc().staging.slice(before).map(s => s.file);
    return { mode, images: fresh, note: fresh.length ? 'results are in the staging strip — the user accepts them (Enter)' : 'no results (see console)' };
  },
  async snapshot() {
    const file = await upload(await toFile(compose({ ...doc().bbox }), `naizer_snap_${Date.now()}.png`));
    return { file, images: [file] };
  },
};
