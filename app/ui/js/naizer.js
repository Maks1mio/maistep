// ImageNaizer — редактор картинки слоями. Фон — открытая картинка; выделение (кисть, прямоугольник, лассо) говорит,
// где менять. «Детализировать» (низкий denoise: те же формы, больше деталей) и «Перерисовать» (высокий denoise: на
// месте выделения — то, что в промпте) генерируют U-Net'ом чекпоинта только область выделения (sd.inpaint patch=true)
// и кладут результат НОВЫМ СЛОЕМ: PNG этой области с растушёванной альфой и её место на картинке. Фон не меняется,
// слои можно прятать, двигать, менять прозрачность и порядок, перебирать варианты (новый seed), стирать выделенное,
// сводить и сохранять в output/. Генерация идёт по видимому композиту (что на экране, то и основа).
// Документ (слои, контекст сцены) хранится по файлу фона — открыли ту же картинку, слои на месте.
// Под капотом — скрытый граф (Load Checkpoint → CLIP Text Encode ×2 → Inpaint Region) в общей очереди: прогресс и
// поэтапное превью приходят как у любого запуска (превью рисуется прямо в области на холсте).
// Hierarchy (контекст naizer) — недавние документы и файлы output/ и input/; Inspector — настройки генерации.
// «Контекст сцены» — vision-LLM (скрытый llm.chat) описывает картинку, теги подмешиваются в промпт.
import { h, num, check, debounce, clamp } from './util.js';
import { S, on, emit, select } from './store.js';
import { registerInspector, typingIn } from './inspector.js';
import { icon } from './icons.js';
import { api, fileUrl, upload, interrupt, getModels, getSettings } from './backend.js';
import { isShown, activeView } from './dock.js';
import { dropdown } from './kit.js';
import { libraryPicker } from './library.js';
import { modelPicker } from './modelpick.js';
import { fetchRec, MAGIC_KEYS } from './magic.js';
import { imagePicker, imagesFromTransfer, imagesFromClipboard, clipboardHasImage } from './images.js';

const LS = 'maistep-naizer', MASK_KEY = 'maistep-naizer-mask';
const DEF = {
  file: '', docs: {}, mode: 'detail', prompt: { detail: '', redraw: '' }, negative: '', denoise: { detail: 0.4, redraw: 0.9 }, fill: true,
  ckpt: '', params: null, magic: null, padding: 48, feather: 12, resolution: 0, seed: -1, tool: 'brush', size: 60,
  useContext: true, ctxProvider: '', ctxModel: '', side: 250,
};
const st = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(LS)) }; } catch { return { ...DEF }; } })();
if (!st.docs || typeof st.docs !== 'object') st.docs = {};
delete st.versions; delete st.context; // старый формат: версии-картинки целиком
const keep = debounce(() => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch {} }, 200);
const log = (level, text) => emit('log', { src: 'naizer', level, text });
const MODES = { detail: ['Детализировать', 'Те же формы, больше деталей: denoise 0.3–0.5'], redraw: ['Перерисовать', 'На месте выделения — то, что в промпте: denoise 0.8–1'] };
const TINT = '#548AF7';

// инструменты: свои иконки (в наборе JetBrains нет кисти/лассо), цвет — currentColor
const SVG = {
  move: '<path d="M8 1.5v13M1.5 8h13M6 3.5l2-2 2 2M6 12.5l2 2 2-2M3.5 6l-2 2 2 2M12.5 6l2 2-2 2"/>',
  hand: '<path d="M5 8.5V3.6a1 1 0 0 1 2 0V7.5M7 7.5V2.6a1 1 0 0 1 2 0v4.9M9 7.5V3.6a1 1 0 0 1 2 0v4.4M11 8V5.6a1 1 0 0 1 2 0v4.6a4.3 4.3 0 0 1-4.3 4.3h-.6a4 4 0 0 1-3.4-1.9L2.9 9.8a1 1 0 0 1 1.6-1.2L5 9.3"/>',
  brush: '<path d="M13.6 2.4 8 8M8.4 6.4l1.2 1.2M6.4 8.6c-1.7-.3-3 .9-3 2.6 0 .9-.5 1.6-1.4 2.1 2.2 1 5.6.4 5.6-2.4 0-.9-.4-1.6-1.2-2.3z"/>',
  eraser: '<path d="M9.4 2.6l4 4-6.6 6.6H4.2L2 11l7.4-8.4zM5.8 6.2l4 4M7.8 13.2H14"/>',
  rect: '<rect x="2.5" y="3.5" width="11" height="9" rx=".5" stroke-dasharray="2.2 1.6"/>',
  lasso: '<path d="M8 2.5c3.2 0 5.5 1.6 5.5 3.5S11.2 9.5 8 9.5 2.5 7.9 2.5 6 4.8 2.5 8 2.5z" stroke-dasharray="2.2 1.6"/><path d="M4.6 8.6c-.9.9-.6 2.1.5 2.3 1 .2 1.3 1.1.7 2.6"/>',
  invert: '<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 13.5l11-11V13.5z" fill="currentColor" stroke="none"/>',
  all: '<rect x="2.5" y="2.5" width="11" height="11" rx=".5" stroke-dasharray="2.2 1.6"/><path d="M5.5 8l2 2 3.5-4"/>',
  none: '<rect x="2.5" y="2.5" width="11" height="11" rx=".5" stroke-dasharray="2.2 1.6"/><path d="M5.5 5.5l5 5M10.5 5.5l-5 5"/>',
  layers: '<path d="M8 2 14 5.2 8 8.4 2 5.2zM2.6 8.2 8 11.1l5.4-2.9M2.6 11 8 13.9l5.4-2.9"/>',
  merge: '<path d="M8 2v7M5 6.5 8 9.5l3-3M2.5 11.5h11M2.5 14h11"/>',
  sel: '<rect x="2.5" y="2.5" width="11" height="11" rx=".5" stroke-dasharray="2.2 1.6"/><path d="M5 11V7.5L8 5l3 2.5V11z" fill="currentColor" stroke="none" opacity=".6"/>',
  erase: '<rect x="2.5" y="2.5" width="11" height="11" rx=".5" stroke-dasharray="2.2 1.6"/><path d="M6 6l4 4M10 6l-4 4"/>',
  wand: '<path d="M2.5 13.5l7-7M9.5 6.5l1.5-1.5M11.5 1.5v2M14.5 4.5h-2M13.6 2.4l-1.2 1.2M11.5 8.5v1.2M6.8 2.5H8"/>',
};
const svg = (k, size = 16) => {
  const s = h('span.nz-svg');
  s.innerHTML = `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round">${SVG[k]}</svg>`;
  return s;
};
const TOOLS = [
  ['move', 'Перемещение слоя', 'V', 'Тянуть активный слой'], ['hand', 'Рука', 'H', 'Сдвиг холста (или ПКМ / Space)'], null,
  ['brush', 'Кисть выделения', 'B', 'Alt — стирать'], ['eraser', 'Ластик выделения', 'E', ''],
  ['rect', 'Прямоугольник', 'R', 'Alt — вычесть'], ['lasso', 'Лассо', 'L', 'Alt — вычесть'],
];

let cv = null, wrap = null, img = null, mask = null, tint = null, view = { x: 0, y: 0, z: 1 }, fitted = false;
let mouse = null, shape = null, compare = false, busy = null, files = { output: [], input: [] };
let selBox = null, maskRev = 0, maskUp = { rev: -1, file: '' }, flatUp = { sig: '', file: '' };
let hist = { undo: [], redo: [] }, space = false, dragRow = null, editName = null;
let rec = null; // рекомендация Magic для чекпоинта
let ctxProviders = null, ctxBusy = false, ctxPid = null;
const pics = new Map(); // файл → Image (слои и фон)

const CTX_PROMPT = 'Describe the image for an inpainting prompt. Return one line of comma-separated English tags: '
  + 'subject and appearance, clothing, pose, scene, background, lighting, color palette, art style. '
  + 'No quality words, no sentences, no markdown.';
const CTX_SYSTEM = 'You caption images for a Stable Diffusion inpaint node. Keep the subject identity and style, be concrete and brief.';

const ckptName = () => st.ckpt || S.nodes['sd.checkpoint']?.inputs?.ckpt_name?.default || '';
const fileOf = f => (/^(input|output)\//.test(f) ? f : `input/${f}`);
const doc = () => st.docs[st.file] || null;
const fileL = L => L?.vars?.[L.vi]?.file || '';
const activeL = () => { const d = doc(); return d?.layers.find(l => l.id === d.active) || null; };
const shown = L => L.visible !== false && (L.opacity ?? 1) > 0;
const stem = f => f.split('/').pop().replace(/\.[^.]+$/, '');
const uid = () => Math.random().toString(36).slice(2, 9);

// ---------- картинки ----------
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

// ---------- документ ----------
function open(file) {
  if (!file) return;
  file = fileOf(file);
  st.file = file;
  if (!st.docs[file]) st.docs[file] = { base: file, layers: [], active: null, context: '' };
  st.docs[file].at = Date.now();
  // недавние документы — не больше 30
  const old = Object.entries(st.docs).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(30);
  for (const [k] of old) delete st.docs[k];
  keep();
  hist = { undo: [], redo: [] };
  img = null; mask = null; selBox = null; fitted = false;
  loadBase(true);
  refresh();
}

async function loadBase(fresh = false) {
  const d = doc();
  if (!d) return draw();
  const want = d.base;
  const im = await loadPic(want);
  if (doc()?.base !== want) return;
  if (!im) { log('error', `не открылась картинка ${want} (сервер запущен?)`); img = null; return refresh(); }
  const same = img && mask && mask.width === im.naturalWidth && mask.height === im.naturalHeight;
  img = im;
  if (!same) newMask();
  if (fresh) { fitted = false; fit(); loadDraft(); }
  refresh();
}

// снимки для отмены: документ целиком (JSON) или маска выделения
function pushHist(kind = 'doc') {
  hist.undo.push(snap(kind));
  if (hist.undo.length > 40) hist.undo.shift();
  // маски тяжёлые — держим не больше 12
  const masks = hist.undo.filter(e => e.mask);
  if (masks.length > 12) hist.undo.splice(hist.undo.indexOf(masks[0]), 1);
  hist.redo = [];
}
function snap(kind) {
  if (kind === 'mask') return { mask: mask.getContext('2d').getImageData(0, 0, mask.width, mask.height) };
  return { doc: JSON.stringify(doc()) };
}
function applySnap(e) {
  if (e.mask) {
    mask.getContext('2d').putImageData(e.mask, 0, 0);
    maskChanged();
  } else {
    const d = JSON.parse(e.doc), baseWas = doc()?.base;
    st.docs[st.file] = d; keep();
    if (d.base !== baseWas) loadBase();
  }
}
function undo(redo = false) {
  const [from, to] = redo ? [hist.redo, hist.undo] : [hist.undo, hist.redo];
  const e = from.pop();
  if (!e || !mask) return;
  to.push(snap(e.mask ? 'mask' : 'doc'));
  applySnap(e);
  refresh();
}
function changeDoc(fn) {
  pushHist();
  fn(doc());
  keep();
  refresh();
}

// ---------- выделение ----------
function newMask() {
  const W = img.naturalWidth, H = img.naturalHeight;
  mask = Object.assign(document.createElement('canvas'), { width: W, height: H });
  tint = Object.assign(document.createElement('canvas'), { width: W, height: H });
  maskChanged();
}
// подсветка — та же маска, залитая цветом; рамка выделения — по уменьшенной копии
function maskChanged({ save = true } = {}) {
  if (!mask) return;
  maskRev++;
  const t = tint.getContext('2d');
  t.globalCompositeOperation = 'copy'; t.drawImage(mask, 0, 0);
  t.globalCompositeOperation = 'source-in'; t.fillStyle = TINT; t.fillRect(0, 0, tint.width, tint.height);
  t.globalCompositeOperation = 'source-over';
  measure();
  if (save) keepDraft();
}
function measure() {
  const s = 4, c = Object.assign(document.createElement('canvas'), { width: Math.ceil(mask.width / s), height: Math.ceil(mask.height / s) });
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(mask, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = 0; y < c.height; y++) for (let i = y * c.width, xx = 0; xx < c.width; xx++, i++) {
    if (d[i * 4 + 3] > 8) { if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  selBox = x1 < 0 ? null : { x: x0 * s, y: y0 * s, w: Math.min(mask.width, (x1 + 1) * s) - x0 * s, h: Math.min(mask.height, (y1 + 1) * s) - y0 * s };
  const el = document.getElementById('nz-selinfo');
  if (el) el.textContent = selInfo();
}
const selInfo = () => (selBox ? `выделено ${selBox.w}×${selBox.h} px` : 'нет выделения');

function selAll(on = true) {
  if (!mask) return;
  pushHist('mask');
  const m = mask.getContext('2d');
  m.clearRect(0, 0, mask.width, mask.height);
  if (on) { m.fillStyle = '#fff'; m.fillRect(0, 0, mask.width, mask.height); }
  maskChanged(); draw();
}
function invertMask() {
  if (!mask) return;
  pushHist('mask');
  const m = mask.getContext('2d');
  m.globalCompositeOperation = 'xor'; m.fillStyle = '#fff'; m.fillRect(0, 0, mask.width, mask.height);
  m.globalCompositeOperation = 'source-over';
  maskChanged(); draw();
}
// выделить непрозрачную часть слоя (как Ctrl+клик по миниатюре в фотошопе)
async function selFromLayer(L, add = false) {
  const im = await loadPic(fileL(L));
  if (!im || !mask) return;
  pushHist('mask');
  const m = mask.getContext('2d');
  if (!add) m.clearRect(0, 0, mask.width, mask.height);
  m.drawImage(im, L.x, L.y, L.w, L.h);
  // альфа слоя → белая маска
  m.globalCompositeOperation = 'source-in'; m.fillStyle = '#fff'; m.fillRect(0, 0, mask.width, mask.height);
  m.globalCompositeOperation = 'source-over';
  maskChanged(); draw();
}

// черновик выделения: переживает перезапуск окна
function loadDraft() {
  let data = null;
  try { const d = JSON.parse(localStorage.getItem(MASK_KEY)); if (d?.file === st.file) data = d.data; } catch {}
  if (!data) return;
  const im = new Image();
  const want = st.file;
  im.onload = () => {
    if (st.file !== want || !mask) return;
    const c = mask.getContext('2d');
    c.clearRect(0, 0, mask.width, mask.height);
    c.drawImage(im, 0, 0, mask.width, mask.height);
    maskChanged({ save: false }); draw();
  };
  im.src = data;
}
const keepDraft = debounce(() => {
  if (!mask || !st.file) return;
  try { localStorage.setItem(MASK_KEY, JSON.stringify({ file: st.file, data: selBox ? mask.toDataURL('image/png') : '' })); } catch {}
}, 400);

// мазок/фигура — сразу в маску и в подсветку
function paint(fn, erase) {
  for (const [c, color] of [[mask, '#fff'], [tint, TINT]]) {
    const x = c.getContext('2d');
    x.save();
    x.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
    x.fillStyle = x.strokeStyle = color;
    x.lineCap = x.lineJoin = 'round';
    fn(x);
    x.restore();
  }
}

// ---------- композит ----------
// видимые слои поверх фона в размер картинки (для основы генерации, сведения и сохранения)
async function flatten(layers = doc().layers.filter(shown)) {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  for (const L of layers) {
    const im = await loadPic(fileL(L));
    if (!im) throw new Error(`слой «${L.name}» не загрузился`);
    x.globalAlpha = clamp(L.opacity ?? 1, 0, 1);
    x.drawImage(im, L.x, L.y, L.w, L.h);
  }
  x.globalAlpha = 1;
  return c;
}
const toFile = async (c, name) => new File([await new Promise(r => c.toBlob(r, 'image/png'))], name, { type: 'image/png' });

// основа генерации — что видно на экране; без видимых слоёв — сам фон (без загрузки)
async function baseForRun() {
  const d = doc(), vis = d.layers.filter(shown);
  if (!vis.length) return d.base;
  const sig = JSON.stringify([d.base, vis.map(L => [fileL(L), L.x, L.y, L.opacity ?? 1])]);
  if (flatUp.sig === sig) return flatUp.file;
  const file = await upload(await toFile(await flatten(vis), `naizer_base_${Date.now()}.png`));
  flatUp = { sig, file };
  return file;
}
async function maskFile() {
  // маска в размер картинки: белое — перерисовать; уникальное имя — кэш нод сервера по входам
  if (maskUp.rev === maskRev) return maskUp.file;
  const file = await upload(await toFile(mask, `naizer_mask_${Date.now()}.png`));
  maskUp = { rev: maskRev, file };
  return file;
}

// ---------- операции со слоями ----------
function setActive(id) { const d = doc(); if (!d || d.active === id) return; d.active = id; keep(); refresh(); }
function delLayer(L) {
  changeDoc(d => {
    const i = d.layers.indexOf(L);
    d.layers.splice(i, 1);
    d.active = d.layers[Math.min(i, d.layers.length - 1)]?.id || null;
  });
}
function dupLayer(L) {
  changeDoc(d => {
    const c = JSON.parse(JSON.stringify(L));
    c.id = uid(); c.name = `${L.name} (копия)`;
    d.layers.splice(d.layers.indexOf(L) + 1, 0, c);
    d.active = c.id;
  });
}
function moveLayer(L, to) {
  const d = doc(), from = d.layers.indexOf(L);
  to = clamp(to, 0, d.layers.length - 1);
  if (from === to) return;
  changeDoc(dd => { dd.layers.splice(from, 1); dd.layers.splice(to, 0, L); });
}
function setVariant(L, k) {
  const n = L.vars.length;
  if (n < 2) return;
  changeDoc(() => { L.vi = (L.vi + k + n) % n; });
}
// новый файл слоя из холста (стирание/слияние) — в input/, старый остаётся для отмены
async function layerFromCanvas(c, x, y) {
  const file = await upload(await toFile(c, `naizer_layer_${Date.now()}.png`));
  pics.set(file, await canvasImage(c));
  return { file, x, y, w: c.width, h: c.height };
}
function canvasImage(c) {
  return new Promise(res => { const im = new Image(); im.onload = () => res(im); im.src = c.toDataURL('image/png'); });
}
// стереть выделенное из слоя (или оставить только выделенное)
async function cutLayer(L, keepSel = false) {
  if (!selBox) return log('warn', 'сначала выделите область');
  const im = await loadPic(fileL(L));
  if (!im) return;
  const c = Object.assign(document.createElement('canvas'), { width: L.w, height: L.h });
  const x = c.getContext('2d');
  x.drawImage(im, 0, 0, L.w, L.h);
  x.globalCompositeOperation = keepSel ? 'destination-in' : 'destination-out';
  x.drawImage(mask, -L.x, -L.y);
  try {
    const r = await layerFromCanvas(c, L.x, L.y);
    changeDoc(() => { L.vars.splice(L.vi + 1, 0, { file: r.file, seed: L.vars[L.vi]?.seed, edit: true }); L.vi += 1; });
  } catch (e) { log('error', `слой: ${e.message}`); }
}
// слить слой с нижним; нижний — фон → новый фон
async function mergeDown(L) {
  const d = doc(), i = d.layers.indexOf(L);
  try {
    if (i === 0) {
      const c = await flatten([L]);
      const file = await upload(await toFile(c, `${stem(d.base).replace(/_ed\d+$/, '')}_ed${Date.now() % 1e7}.png`));
      pics.set(file, await canvasImage(c));
      changeDoc(dd => { dd.base = file; dd.layers.splice(0, 1); dd.active = dd.layers[0]?.id || null; });
      loadBase();
      return;
    }
    const B = d.layers[i - 1];
    const [a, b] = await Promise.all([loadPic(fileL(L)), loadPic(fileL(B))]);
    if (!a || !b) return;
    const x0 = Math.min(L.x, B.x), y0 = Math.min(L.y, B.y), x1 = Math.max(L.x + L.w, B.x + B.w), y1 = Math.max(L.y + L.h, B.y + B.h);
    const c = Object.assign(document.createElement('canvas'), { width: x1 - x0, height: y1 - y0 });
    const x = c.getContext('2d');
    if (shown(B)) { x.globalAlpha = B.opacity ?? 1; x.drawImage(b, B.x - x0, B.y - y0, B.w, B.h); }
    if (shown(L)) { x.globalAlpha = L.opacity ?? 1; x.drawImage(a, L.x - x0, L.y - y0, L.w, L.h); }
    const r = await layerFromCanvas(c, x0, y0);
    changeDoc(dd => {
      dd.layers.splice(i - 1, 2, { ...B, ...r, opacity: 1, visible: true, vars: [{ file: r.file, seed: null, edit: true }], vi: 0, name: B.name });
      dd.active = B.id;
    });
  } catch (e) { log('error', `слияние: ${e.message}`); }
}
// свести видимые слои в фон; скрытые остаются слоями
async function flattenAll() {
  const d = doc(), vis = d.layers.filter(shown);
  if (!vis.length) return;
  try {
    const c = await flatten(vis);
    const file = await upload(await toFile(c, `${stem(d.base).replace(/_ed\d+$/, '')}_ed${Date.now() % 1e7}.png`));
    pics.set(file, await canvasImage(c));
    changeDoc(dd => { dd.base = file; dd.layers = dd.layers.filter(L => !shown(L)); dd.active = dd.layers.at(-1)?.id || null; });
    loadBase();
    log('ok', `слои сведены в фон: ${file}`);
  } catch (e) { log('error', `сведение: ${e.message}`); }
}
async function exportPng() {
  if (!img) return;
  try {
    const c = await flatten();
    const file = await upload(await toFile(c, `${stem(doc().base)}_naizer_${new Date().toISOString().slice(0, 19).replace(/\D/g, '')}.png`), 'output');
    log('ok', `сохранено: ${file}`);
    loadFiles();
  } catch (e) { log('error', `сохранение: ${e.message}`); }
}

// ---------- вид ----------
const toImg = p => ({ x: (p.x - view.x) / view.z, y: (p.y - view.y) / view.z });
function fit() {
  if (!img?.naturalWidth || !wrap) return;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  if (!W || !H) return;
  view.z = Math.min((W - 40) / img.naturalWidth, (H - 40) / img.naturalHeight, 4);
  view.x = (W - img.naturalWidth * view.z) / 2;
  view.y = (H - img.naturalHeight * view.z) / 2;
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

function draw() {
  if (!cv || !wrap?.isConnected) return;
  const W = wrap.clientWidth, H = wrap.clientHeight, dpr = devicePixelRatio || 1;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#1E1F22';
  c.fillRect(0, 0, W, H);
  if (!img?.naturalWidth) {
    c.fillStyle = '#868A91'; c.font = '13px Inter, "Segoe UI", sans-serif'; c.textAlign = 'center';
    c.fillText(st.file ? 'Загрузка…' : 'Откройте картинку: «Открыть», файл из Hierarchy, перетаскивание или Ctrl+V', W / 2, H / 2);
    c.textAlign = 'left';
    return;
  }
  if (!fitted) fit();
  const z = view.z, iw = img.naturalWidth * z, ih = img.naturalHeight * z;
  const R = (x, y, w, hh) => [view.x + x * z, view.y + y * z, w * z, hh * z];
  c.imageSmoothingQuality = 'high';
  c.drawImage(img, view.x, view.y, iw, ih);
  const d = doc();
  if (!compare && d) {
    for (const L of d.layers) {
      if (!shown(L)) continue;
      const im = pic(fileL(L));
      if (!im) continue;
      c.globalAlpha = clamp(L.opacity ?? 1, 0, 1);
      c.drawImage(im, ...R(L.x, L.y, L.w, L.h));
    }
    c.globalAlpha = 1;
  }
  c.strokeStyle = '#43454A'; c.lineWidth = 1; c.strokeRect(view.x - 0.5, view.y - 0.5, iw + 1, ih + 1);
  // генерация: поэтапное превью прямо в области
  if (busy?.box) {
    const b = busy.box, r = R(b.x, b.y, b.w, b.h);
    if (busy.preview?.complete && busy.preview.naturalWidth) { c.globalAlpha = 0.92; c.drawImage(busy.preview, ...r); c.globalAlpha = 1; }
    c.setLineDash([6, 4]); c.strokeStyle = '#57965C'; c.lineWidth = 1.5; c.strokeRect(...r); c.setLineDash([]);
  }
  if (!compare && tint && selBox) {
    c.globalAlpha = 0.38; c.drawImage(tint, view.x, view.y, iw, ih); c.globalAlpha = 1;
    // рамка выделения и (бледнее) поля контекста вокруг
    const p = st.padding;
    const r = R(Math.max(0, selBox.x - p), Math.max(0, selBox.y - p), 0, 0);
    const x1 = Math.min(img.naturalWidth, selBox.x + selBox.w + p), y1 = Math.min(img.naturalHeight, selBox.y + selBox.h + p);
    c.setLineDash([3, 4]); c.strokeStyle = '#ffffff55'; c.lineWidth = 1;
    c.strokeRect(r[0], r[1], view.x + x1 * z - r[0], view.y + y1 * z - r[1]);
    c.setLineDash([5, 4]); c.strokeStyle = '#fff'; c.strokeRect(...R(selBox.x, selBox.y, selBox.w, selBox.h)); c.setLineDash([]);
  }
  // активный слой — рамка (с инструментом «перемещение» заметнее)
  const A = activeL();
  if (A && !compare && shown(A)) {
    c.setLineDash(st.tool === 'move' ? [] : [2, 3]); c.strokeStyle = st.tool === 'move' ? '#3574F0' : '#3574F088'; c.lineWidth = 1;
    c.strokeRect(...R(A.x, A.y, A.w, A.h)); c.setLineDash([]);
  }
  // фигура в процессе
  if (shape?.kind === 'rect' || shape?.kind === 'lasso') {
    c.setLineDash([5, 4]); c.strokeStyle = shape.erase ? '#DB5C5C' : '#fff'; c.lineWidth = 1.5;
    if (shape.kind === 'rect') c.strokeRect(Math.min(shape.a.x, shape.b.x), Math.min(shape.a.y, shape.b.y), Math.abs(shape.b.x - shape.a.x), Math.abs(shape.b.y - shape.a.y));
    else if (shape.pts.length > 1) { c.beginPath(); shape.pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath(); c.stroke(); }
    c.setLineDash([]);
  }
  // курсор кисти (размер — в пикселях картинки)
  if (mouse && !compare && (st.tool === 'brush' || st.tool === 'eraser') && !shape?.pan && !space) {
    c.beginPath(); c.arc(mouse.x, mouse.y, Math.max(1, st.size * z / 2), 0, 7);
    c.strokeStyle = '#000a'; c.lineWidth = 3; c.stroke();
    c.strokeStyle = st.tool === 'eraser' || mouse.alt ? '#DB5C5C' : '#fff'; c.lineWidth = 1.2; c.stroke();
  }
  if (compare) badge(c, 'без слоёв', 10, 10);
  if (busy) {
    const label = busy.max ? `${MODES[busy.mode][0]} · шаг ${busy.step}/${busy.max}` : 'В очереди…';
    badge(c, label, 10, H - 30);
    if (busy.max) { c.fillStyle = '#57965C'; c.fillRect(0, H - 3, W * clamp(busy.step / busy.max, 0, 1), 3); }
  }
}
function badge(c, text, x, y) {
  c.font = '600 11px Inter, sans-serif';
  const w = c.measureText(text).width + 14;
  c.fillStyle = '#000b'; c.beginPath(); c.roundRect(x, y, w, 20, 10); c.fill();
  c.fillStyle = '#fff'; c.fillText(text, x + 7, y + 14);
}

// ---------- мышь ----------
const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, alt: e.altKey }; };
function track(move, up) {
  const u = ev => { removeEventListener('pointermove', move); removeEventListener('pointerup', u); up?.(ev); };
  addEventListener('pointermove', move); addEventListener('pointerup', u);
}
function onDown(e) {
  if (!img?.naturalWidth) return;
  cv.focus();
  const p = pos(e);
  if (e.button === 1 || e.button === 2 || (e.button === 0 && (space || st.tool === 'hand'))) {
    e.preventDefault();
    const v0 = { ...view };
    shape = { pan: true };
    cv.style.cursor = 'grabbing';
    return track(ev => { const q = pos(ev); view.x = v0.x + q.x - p.x; view.y = v0.y + q.y - p.y; draw(); }, () => { shape = null; setCursor(); draw(); });
  }
  if (e.button !== 0 || compare) return;
  if (st.tool === 'move') {
    const L = activeL();
    if (!L) return log('warn', 'нет активного слоя — выберите слой справа');
    const before = JSON.stringify(doc()), x0 = L.x, y0 = L.y, a = toImg(p);
    return track(ev => { const q = toImg(pos(ev)); L.x = Math.round(x0 + q.x - a.x); L.y = Math.round(y0 + q.y - a.y); draw(); }, () => {
      if (L.x === x0 && L.y === y0) return;
      hist.undo.push({ doc: before }); hist.redo = [];
      keep(); refresh();
    });
  }
  const erase = st.tool === 'eraser' || e.altKey;
  pushHist('mask');
  if (st.tool === 'brush' || st.tool === 'eraser') {
    let last = toImg(p);
    const dab = (a, b) => paint(x => { x.lineWidth = st.size; x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x + 0.01, b.y); x.stroke(); }, erase);
    dab(last, last);
    draw();
    return track(ev => { const q = toImg(pos(ev)); dab(last, q); last = q; mouse = pos(ev); draw(); }, () => { maskChanged(); draw(); });
  }
  if (st.tool === 'rect') {
    shape = { kind: 'rect', a: p, b: p, erase };
    return track(ev => { shape.b = pos(ev); draw(); }, () => {
      const a = toImg(shape.a), b = toImg(shape.b);
      if (Math.abs(b.x - a.x) > 2 && Math.abs(b.y - a.y) > 2) {
        paint(x => x.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)), shape.erase);
        maskChanged();
      } else hist.undo.pop();
      shape = null; draw();
    });
  }
  if (st.tool === 'lasso') {
    shape = { kind: 'lasso', pts: [p], erase };
    return track(ev => { shape.pts.push(pos(ev)); draw(); }, () => {
      const pts = shape.pts.map(toImg);
      if (pts.length > 2) {
        paint(x => { x.beginPath(); pts.forEach((q, i) => (i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y))); x.closePath(); x.fill(); }, shape.erase);
        maskChanged();
      } else hist.undo.pop();
      shape = null; draw();
    });
  }
}
function onWheel(e) {
  e.preventDefault();
  if (!img?.naturalWidth) return;
  if (e.ctrlKey || e.altKey) { setSize(st.size * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); return; }
  zoomTo(view.z * Math.exp(-e.deltaY * 0.0015), pos(e));
}
function setSize(v) {
  st.size = Math.round(clamp(v, 2, 800)); keep();
  const s = document.getElementById('nz-size'); if (s) s.value = st.size;
  const n = document.getElementById('nz-sizen'); if (n) n.textContent = `${st.size} px`;
  draw();
}
function setCursor() {
  if (!cv) return;
  cv.style.cursor = space || st.tool === 'hand' ? 'grab' : st.tool === 'move' ? 'move'
    : st.tool === 'rect' || st.tool === 'lasso' ? 'crosshair' : (st.tool === 'brush' || st.tool === 'eraser') ? 'none' : '';
}
async function onDrop(e) {
  e.preventDefault();
  const [f] = await imagesFromTransfer(e.dataTransfer);
  if (f) open(f);
}
async function onPaste(e) {
  const el = document.activeElement;
  if (activeView() !== 'naizer' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName) || !clipboardHasImage(e)) return;
  e.preventDefault();
  const [f] = await imagesFromClipboard(e);
  if (f) open(f);
}

// ---------- Magic ----------
async function loadRec(refresh = false) {
  const ck = ckptName();
  if (!ck || !S.server.running) return;
  const r = await fetchRec({ ckpt: ck, loras: [] }, refresh);
  rec = r;
  if (!r?.ok) { refresh_(); return; }
  if (st.magic?.key !== ck || !st.params || refresh) {
    const old = st.magic?.rec;
    st.params = st.params || {};
    for (const k of MAGIC_KEYS) if (refresh || !old || st.params[k] === undefined || String(st.params[k]) === String(old[k])) st.params[k] = r.params[k];
    st.magic = { key: ck, rec: { ...r.params } };
    keep();
  }
  refresh_();
}
const changedKeys = () => (st.magic?.rec ? MAGIC_KEYS.filter(k => String(st.params?.[k]) !== String(st.magic.rec[k])) : []);

// ---------- контекст сцены (vision-LLM) ----------
let ctxLoading = false;
async function ensureCtx() {
  if (!S.server.running || ctxLoading) return;
  ctxLoading = true;
  try {
    if (!ctxProviders) {
      const s = await getSettings();
      ctxProviders = s.providers || {};
      if (!st.ctxProvider) {
        st.ctxProvider = s.default_provider || Object.keys(ctxProviders).find(k => ctxProviders[k].has_key) || '';
        keep();
      }
    }
    const pid = st.ctxProvider;
    if (!pid) return;
    await getModels(pid);
    if (!st.ctxModel) {
      const all = S.models[pid]?.models || [];
      // у Ollama нет флага vision — берём первую модель, остальное автор выберет вручную
      const m = all.find(x => x.vision) || (ctxProviders[pid]?.kind === 'ollama' ? all[0] : null);
      if (m) { st.ctxModel = m.id; keep(); }
    }
    refresh_();
  } catch (e) {
    log('warn', `контекст: ${e.message}`);
  } finally { ctxLoading = false; }
}
const ctxMeta = () => (S.models[st.ctxProvider]?.models || []).find(m => m.id === st.ctxModel) || null;

async function describe() {
  if (ctxBusy) return;
  if (!S.server.running) { log('warn', 'сервер не запущен'); emit('server-start'); return; }
  if (!img?.naturalWidth) return log('warn', 'сначала откройте картинку');
  await ensureCtx();
  if (!st.ctxProvider || !st.ctxModel) return log('warn', 'выберите vision-модель для контекста');
  const meta = ctxMeta();
  const ollama = ctxProviders[st.ctxProvider]?.kind === 'ollama';
  if (meta && !meta.vision && !ollama) return log('warn', `${st.ctxModel} не принимает картинки — выберите модель со значком 👁`);
  ctxBusy = true;
  refresh_();
  const pid = crypto.randomUUID().replace(/-/g, '');
  ctxPid = { pid, file: st.file };
  const wf = {
    id: 'naizer_ctx', title: 'ImageNaizer: контекст',
    nodes: [
      { id: 'img', type: 'image.load', props: { file: doc().base } },
      { id: 'llm', type: 'llm.chat', props: { prompt: CTX_PROMPT, system: CTX_SYSTEM, provider: st.ctxProvider, model: st.ctxModel,
        max_tokens: 700, effort: 'auto', temperature: 0.3, seed: Date.now() % 1000000 } },
      { id: 'out', type: 'output.show', props: {} },
    ],
    links: [{ from: 'img', out: 'image', to: 'llm', in: 'image' }, { from: 'llm', out: 'text', to: 'out', in: 'value' }],
    targets: ['out'],
  };
  try {
    await api('/api/prompt', { id: pid, workflow: wf });
    log('info', `контекст: ${st.ctxModel}`);
  } catch (e) {
    ctxBusy = false; ctxPid = null;
    for (const is of e.data?.issues || []) log('error', `нода ${is.node}: ${is.message}`);
    if (!e.data?.issues) log('error', `контекст: ${e.message}`);
    refresh_();
  }
}

// ---------- генерация ----------
// again — слой, для которого нужен ещё вариант (та же основа, маска и промпт, новый seed)
async function run(again = null) {
  if (busy) return;
  if (!S.server.running) { log('warn', 'сервер не запущен'); emit('server-start'); return; }
  if (!img?.naturalWidth) return log('warn', 'сначала откройте картинку');
  const ck = ckptName();
  if (!ck) return log('warn', 'выберите чекпоинт в Inspector');
  let src;
  if (again?.src) src = { ...again.src };
  else {
    if (!selBox) return log('warn', 'выделите область: кисть (B), прямоугольник (R) или лассо (L)');
    const mode = st.mode, prompt = (st.prompt[mode] || '').trim();
    if (mode === 'redraw' && !prompt) return log('warn', 'напишите в промпте, что нарисовать на месте выделения');
    try {
      src = { base: await baseForRun(), mask: await maskFile(), mode, prompt, denoise: st.denoise[mode] };
    } catch (e) { return log('error', `подготовка: ${e.message}`); }
  }
  const { mode } = src;
  if (!rec?.ok) await loadRec();
  const q = rec?.prompt || { positive: 'masterpiece, best quality', negative: 'lowres, worst quality, bad anatomy' };
  const ctx = st.useContext !== false ? (doc()?.context || '').trim() : '';
  const positive = mode === 'detail'
    ? [q.positive, ctx, 'highly detailed, sharp focus, intricate details', src.prompt].filter(Boolean).join(', ')
    : [q.positive, src.prompt, ctx].filter(Boolean).join(', ');
  const negative = st.negative.trim() || q.negative;
  const p = { ...(rec?.params || {}), ...(st.params || {}) };
  const L = (from, out, to, inn) => ({ from, out, to, in: inn });
  const wf = {
    id: 'naizer', title: `ImageNaizer: ${MODES[mode][0].toLowerCase()}`,
    nodes: [
      { id: 'ckpt', type: 'sd.checkpoint', props: { ckpt_name: ck } },
      { id: 'skip', type: 'sd.clip_skip', props: { stop_at_clip_layer: rec?.clip_skip || -2 } },
      { id: 'pos', type: 'sd.text_encode', props: { text: positive } },
      { id: 'neg', type: 'sd.text_encode', props: { text: negative } },
      { id: 'img', type: 'image.load', props: { file: src.base } },
      { id: 'mask', type: 'image.load', props: { file: src.mask } },
      { id: 'inp', type: 'sd.inpaint', props: { seed: again ? -1 : st.seed, steps: p.steps ?? 25, cfg: p.cfg ?? 6, sampler_name: p.sampler_name || 'euler_ancestral',
        scheduler: p.scheduler || 'normal', denoise: src.denoise, only_masked: true, padding: st.padding, resolution: st.resolution,
        feather: st.feather, fill: mode === 'redraw' && st.fill !== false, patch: true } },
    ],
    links: [L('ckpt', 'model', 'inp', 'model'), L('ckpt', 'clip', 'skip', 'clip'), L('skip', 'clip', 'pos', 'clip'), L('skip', 'clip', 'neg', 'clip'),
      L('pos', 'conditioning', 'inp', 'positive'), L('neg', 'conditioning', 'inp', 'negative'), L('ckpt', 'vae', 'inp', 'vae'),
      L('img', 'image', 'inp', 'image'), L('mask', 'image', 'inp', 'mask')],
    targets: ['inp'],
  };
  const pid = crypto.randomUUID().replace(/-/g, '');
  busy = { pid, file: st.file, src, layer: again?.id || null, step: 0, max: 0, preview: null, box: null, mode };
  refresh();
  try {
    await api('/api/prompt', { id: pid, workflow: wf });
    log('info', `${MODES[mode][0]}${again ? ` (ещё вариант «${again.name}»)` : ''} · denoise ${src.denoise} · ${p.steps} шагов, cfg ${p.cfg}, ${p.sampler_name}/${p.scheduler}`);
  } catch (e) {
    busy = null;
    for (const is of e.data?.issues || []) log('error', `нода ${is.node}: ${is.message}`);
    if (!e.data?.issues) log('error', `запуск: ${e.message}`);
    refresh();
  }
}

function onResult(file, box, seed) {
  const b = busy;
  busy = null;
  const d = st.docs[b.file];
  if (!d || !box) { refresh(); return log('error', 'ImageNaizer: сервер не вернул область (перезапустите сервер)'); }
  const here = b.file === st.file;
  const before = JSON.stringify(d);
  const old = b.layer && d.layers.find(l => l.id === b.layer);
  if (old) {
    old.vars.push({ file, seed });
    old.vi = old.vars.length - 1;
    old.visible = true;
    d.active = old.id;
  } else {
    const n = d.layers.filter(l => l.src?.mode === b.mode).length + 1;
    const L = { id: uid(), name: `${MODES[b.mode][0]} ${n}`, x: box.x, y: box.y, w: box.w, h: box.h, visible: true, opacity: 1,
      vars: [{ file, seed }], vi: 0, src: b.src };
    const ai = d.layers.findIndex(l => l.id === d.active);
    d.layers.splice(ai < 0 ? d.layers.length : ai + 1, 0, L);
    d.active = L.id;
  }
  if (here) { hist.undo.push({ doc: before }); hist.redo = []; }
  keep();
  pic(file);
  refresh();
  log('ok', `готово: новый ${old ? 'вариант слоя' : 'слой'} · ${box.w}×${box.h} в (${box.x}, ${box.y})`);
}

// ---------- вид v-naizer ----------
function toolbar() {
  const fileIn = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  fileIn.onchange = async () => { const f = fileIn.files[0]; if (!f) return; try { open(await upload(f)); } catch (e) { log('error', `загрузка: ${e.message}`); } };
  const cmp = h('button.icon', { 'data-tip': 'Зажмите — фон без слоёв (\\)', disabled: !doc()?.layers.length }, icon('eye', { size: 14 }));
  cmp.addEventListener('pointerdown', () => { compare = true; draw(); });
  for (const ev of ['pointerup', 'pointerleave']) cmp.addEventListener(ev, () => { if (compare) { compare = false; draw(); } });
  const seg = h('div.ui-seg', {}, ...Object.entries(MODES).map(([k, [label, tip]]) =>
    h(`button${st.mode === k ? '.on' : ''}`, { 'data-tip': tip, onclick: () => { st.mode = k; keep(); refresh(); } }, label)));
  return h('div.bar', {},
    fileIn, h('button', { onclick: e => imagePicker(e.currentTarget, { value: st.file, onPick: f => open(f) }), 'data-tip': 'Картинка из библиотеки приложения (input/, output/) или с диска\nМожно перетащить файл или вставить Ctrl+V' }, icon('open', { size: 14 }), 'Открыть'),
    h('button.icon', { onclick: () => fileIn.click(), 'data-tip': 'С диска (проводник) — загрузится в input/' }, icon('upload', { size: 14 })),
    h('button.icon', { onclick: exportPng, disabled: !img, 'data-tip': 'Сохранить картинку со слоями в output/' }, icon('save', { size: 14 })),
    h('span.hsep'),
    h('button.icon', { 'data-tip': 'Отменить (Ctrl+Z)', disabled: !hist.undo.length, onclick: () => undo() }, icon('undo', { size: 14 })),
    h('button.icon', { 'data-tip': 'Повторить (Ctrl+Shift+Z)', disabled: !hist.redo.length, onclick: () => undo(true) }, icon('redo', { size: 14 })),
    h('span.hsep'),
    h('button.icon', { 'data-tip': 'Вписать (F)', onclick: fit }, icon('fit', { size: 14 })),
    h('button.icon', { 'data-tip': '100% (Ctrl+0)', onclick: () => zoomTo(1) }, icon('actualZoom', { size: 14 })),
    h('span.dim.mono#nz-zoom', { style: { minWidth: '40px', fontSize: '11px' } }, `${Math.round(view.z * 100)}%`),
    cmp,
    h('span.grow'),
    seg,
    busy ? h('button', { onclick: () => interrupt() }, icon('stop', { size: 14 }), 'Прервать')
      : h('button.primary', { onclick: () => run(), disabled: !img, 'data-tip': 'Сгенерировать область выделения новым слоем (Ctrl+Enter)' }, icon('play', { size: 14 }), MODES[st.mode][0]));
}

function toolStrip() {
  const b = (id, title, key, tip, on, click) => h(`button.b${on ? '.on' : ''}`, { 'data-tip': `${title}${key ? ` (${key})` : ''}${tip ? `\n${tip}` : ''}`, onclick: click }, svg(id));
  return h('div.ui-tb.vert.nz-tools', {},
    ...TOOLS.map(t => (t ? b(t[0], t[1], t[2], t[3], st.tool === t[0], () => setTool(t[0])) : h('span.sep'))),
    h('span.sep'),
    b('all', 'Выделить всё', 'Ctrl+A', '', false, () => selAll(true)),
    b('none', 'Снять выделение', 'Ctrl+D', '', false, () => selAll(false)),
    b('invert', 'Инвертировать выделение', 'Ctrl+I', '', false, invertMask));
}

function optionsBar() {
  const brush = st.tool === 'brush' || st.tool === 'eraser';
  const size = h('input.ui-range#nz-size', { type: 'range', min: 2, max: 400, step: 1, value: Math.min(400, st.size) });
  size.addEventListener('input', () => setSize(+size.value));
  const T = TOOLS.find(t => t?.[0] === st.tool);
  return h('div.nz-opts', {},
    h('b', {}, T?.[1] || ''),
    brush ? h('span.row', { style: { gap: '6px' } }, 'размер', size, h('span.mono#nz-sizen', {}, `${st.size} px`)) : null,
    brush ? h('span', {}, '[ ] или Ctrl+колесо') : null,
    st.tool === 'rect' || st.tool === 'lasso' ? h('span', {}, 'добавляет к выделению · Alt — вычесть') : null,
    st.tool === 'move' ? h('span', {}, activeL() ? `слой «${activeL().name}» · ${activeL().x}, ${activeL().y}` : 'выберите слой') : null,
    h('span.grow'),
    h('span#nz-selinfo', {}, selInfo()));
}

function layerRow(L, i, n) {
  const d = doc(), on = d.active === L.id;
  const eye = h('button.b.eye', { 'data-tip': 'Показать / скрыть (Alt+клик — только этот)', onclick: e => {
    e.stopPropagation();
    if (e.altKey) changeDoc(dd => { const solo = dd.layers.every(o => o === L || o.visible === false); dd.layers.forEach(o => { o.visible = solo || o === L; }); });
    else changeDoc(() => { L.visible = L.visible === false; });
  } }, icon(L.visible === false ? 'hide' : 'show', { size: 14 }));
  const th = h('img.th', { src: fileUrl(fileL(L)), alt: '', crossOrigin: 'anonymous', draggable: false });
  th.addEventListener('click', e => { if (e.ctrlKey) { e.stopPropagation(); selFromLayer(L, e.shiftKey); } });
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
  const sub = [L.src?.prompt || (L.vars[L.vi]?.edit ? 'правка' : ''), `${L.w}×${L.h}`].filter(Boolean).join(' · ');
  const vars = L.vars.length > 1 ? h('span.vars', {},
    h('button.b', { 'data-tip': 'Предыдущий вариант', onclick: e => { e.stopPropagation(); setVariant(L, -1); } }, icon('left', { size: 12 })),
    h('span.mono', {}, `${L.vi + 1}/${L.vars.length}`),
    h('button.b', { 'data-tip': 'Следующий вариант', onclick: e => { e.stopPropagation(); setVariant(L, 1); } }, icon('right', { size: 12 }))) : null;
  const row = h(`div.nz-row${on ? '.on' : ''}${L.visible === false ? '.off' : ''}`, {
    draggable: true, title: `${L.name}${L.src?.prompt ? `\n${L.src.prompt}` : ''}\nдвойной клик по имени — переименовать, Ctrl+клик по миниатюре — выделить слой`,
    onclick: () => setActive(L.id),
  }, eye, th, h('div.nm', {}, name, h('span', {}, sub)), vars);
  row.addEventListener('dragstart', e => { dragRow = L; e.dataTransfer.effectAllowed = 'move'; });
  row.addEventListener('dragend', () => { dragRow = null; });
  row.addEventListener('dragover', e => {
    if (!dragRow || dragRow === L) return;
    e.preventDefault();
    const r = row.getBoundingClientRect(), above = e.clientY < r.top + r.height / 2;
    row.classList.toggle('drop-above', above); row.classList.toggle('drop-below', !above);
  });
  row.addEventListener('dragleave', () => row.classList.remove('drop-above', 'drop-below'));
  row.addEventListener('drop', e => {
    e.preventDefault();
    row.classList.remove('drop-above', 'drop-below');
    if (!dragRow || dragRow === L) return;
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
  const rows = d ? [...d.layers].map((L, i) => layerRow(L, i, d.layers.length)).reverse() : [];
  const baseRow = d ? h(`div.nz-row.base${d.active ? '' : '.on'}`, { onclick: () => setActive(null), title: d.base },
    h('span.b.eye', {}, icon('show', { size: 14 })),
    h('img.th', { src: fileUrl(d.base), alt: '', crossOrigin: 'anonymous', draggable: false }),
    h('div.nm', {}, h('b', {}, 'Фон'), h('span', {}, `${d.base.split('/').pop()}${img ? ` · ${img.naturalWidth}×${img.naturalHeight}` : ''}`)),
    h('span.lock', { 'data-tip': 'Фон не меняется: правки — слоями' }, icon('pin', { size: 12 }))) : null;
  const pending = busy && busy.file === st.file ? h('div.nz-row.pending', {},
    h('span.b.eye', {}, h('span.nz-spin')),
    h('div.th'),
    h('div.nm', {}, h('b', {}, busy.layer ? 'Ещё вариант…' : `${MODES[busy.mode][0]}…`), h('span#nz-pend', {}, busy.max ? `шаг ${busy.step}/${busy.max}` : 'в очереди'))) : null;
  const opacity = A ? (() => {
    const r = h('input.ui-range', { type: 'range', min: 0, max: 100, step: 1, value: Math.round((A.opacity ?? 1) * 100) });
    const n = h('span.mono', { style: { width: '34px', textAlign: 'right' } }, `${Math.round((A.opacity ?? 1) * 100)}%`);
    let before = null;
    r.addEventListener('pointerdown', () => { before = JSON.stringify(doc()); });
    r.addEventListener('input', () => { A.opacity = +r.value / 100; n.textContent = `${r.value}%`; draw(); });
    r.addEventListener('change', () => { if (before) { hist.undo.push({ doc: before }); hist.redo = []; before = null; } keep(); });
    return h('div.row', { style: { gap: '8px' } }, h('span.dim', { style: { width: '84px' } }, 'непрозрачность'), r, n);
  })() : null;
  const props = A ? h('div.nz-props', {},
    opacity,
    h('div.row', { style: { flexWrap: 'wrap', gap: '4px' } },
      A.src ? h('button', { onclick: () => run(A), disabled: !!busy, 'data-tip': 'Та же область и промпт, новый seed — вариант добавится в этот слой' }, icon('refresh', { size: 14 }), 'Ещё вариант') : null,
      h('button', { onclick: () => selFromLayer(A), 'data-tip': 'Выделить непрозрачную часть слоя (Ctrl+клик по миниатюре)' }, svg('sel', 14), 'Выделить'),
      h('button', { onclick: () => cutLayer(A), disabled: !selBox, 'data-tip': 'Стереть выделенное из слоя (Shift+Del)\nстарый вид — в вариантах слоя и в отмене' }, svg('erase', 14), 'Стереть выделенное')),
    A.src ? h('div.hint', {}, `${MODES[A.src.mode]?.[0] || ''} · denoise ${A.src.denoise}${A.vars[A.vi]?.seed != null ? ` · seed ${A.vars[A.vi].seed}` : ''}`) : null)
    : h('div.nz-props', {}, h('div.hint', {}, d?.layers.length ? 'Фон не редактируется — выберите слой, чтобы менять его.' : 'Выделите область и нажмите «Детализировать» или «Перерисовать» — результат появится здесь отдельным слоем.'));
  const side = h('div.nz-side', { style: { width: `${st.side}px` } },
    h('div.nz-split', { onpointerdown: e => {
      e.preventDefault();
      const x0 = e.clientX, w0 = st.side;
      track(ev => { st.side = clamp(w0 - (ev.clientX - x0), 190, 480); side.style.width = `${st.side}px`; draw(); }, () => keep());
    } }),
    h('div.hd', {}, svg('layers', 14), h('span', {}, 'Слои'), h('span.grow'),
      btn('copy', 'Дублировать слой', () => A && dupLayer(A), !A),
      btn('merge', 'Слить с нижним (Ctrl+E)', () => A && mergeDown(A), !A),
      btn('delete', 'Удалить слой', () => A && delLayer(A), !A),
      h('span.sep'),
      btn('wand', 'Свести видимые слои в фон', flattenAll, !d?.layers.some(shown))),
    h('div.nz-list', {}, pending || '', ...rows, baseRow || h('div.hint', { style: { padding: '8px' } }, 'картинка не открыта')),
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
    cv.addEventListener('pointermove', e => { mouse = pos(e); if (st.tool === 'brush' || st.tool === 'eraser') draw(); });
    cv.addEventListener('pointerleave', () => { mouse = null; draw(); });
    cv.addEventListener('wheel', onWheel, { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('dragover', e => e.preventDefault());
    cv.addEventListener('drop', onDrop);
    wrap = h('div.nz-wrap', {}, cv);
    new ResizeObserver(() => { if (!fitted) fit(); draw(); }).observe(wrap);
  }
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
  const rows = [];
  const docs = Object.entries(st.docs).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 10);
  if (docs.length) {
    rows.push({ grp: 'Недавние' });
    for (const [k, d] of docs) rows.push({ ic: 'image', label: k.split('/').pop(), tag: d.layers.length ? `слоёв: ${d.layers.length}` : '', title: k, sel: k === st.file, onClick: () => open(k) });
  }
  for (const [k, title] of [['output', 'Результаты (output/)'], ['input', 'Загруженные (input/)']]) {
    rows.push({ grp: title });
    if (!files[k].length) rows.push({ grp: S.server.running ? 'пусто' : 'сервер не запущен' });
    for (const f of files[k]) rows.push({ depth: 1, ic: 'image', label: f.file.split('/').pop(), title: f.file, sel: f.file === st.file, onClick: () => open(f.file) });
  }
  return rows;
}

// ---------- Inspector ----------
function contextCard() {
  if (!S.server.running) return [];
  if (ctxProviders === null) { ensureCtx(); return [h('h4', {}, 'Контекст сцены'), h('div.hint', {}, 'загрузка провайдеров…')]; }
  const provs = Object.entries(ctxProviders).map(([id, p]) => [id, p.name || id]);
  if (!provs.length) return [];
  const d = doc();
  const meta = ctxMeta();
  const ollama = ctxProviders[st.ctxProvider]?.kind === 'ollama';
  const model = h('input', { type: 'text', value: st.ctxModel, readOnly: true, placeholder: 'модель с 👁' });
  const pick = h('button.icon', { 'data-tip': 'Модель, которая видит картинку', onclick: () => modelPicker(pick, { provider: st.ctxProvider, value: st.ctxModel, onPick: id => { st.ctxModel = id; keep(); refresh_(); } }) }, icon('search', { size: 14 }));
  model.addEventListener('click', () => pick.click());
  const ta = h('textarea', { rows: 3, spellcheck: false, placeholder: 'нажмите «Описать» — теги появятся здесь, их можно править', disabled: !d });
  ta.value = d?.context || '';
  ta.addEventListener('input', () => { if (d) { d.context = ta.value; keep(); } });
  return [
    h('h4', {}, 'Контекст сцены'),
    h('div.f', {}, h('label', {}, 'провайдер'), h('div.v', {}, dropdown(st.ctxProvider, provs, v => {
      st.ctxProvider = v; st.ctxModel = ''; keep(); ensureCtx(); refresh_();
    }, { width: 150 }))),
    h('div.f', {}, h('label', {}, 'модель'), h('div.v', {}, model, pick)),
    meta && !meta.vision && !ollama ? h('div.hint', { style: { color: 'var(--err)' } }, 'модель не принимает картинки — выберите со значком 👁') : null,
    ta,
    h('div.row', { style: { flexWrap: 'wrap', marginTop: '4px' } },
      h('button', { onclick: describe, disabled: ctxBusy || !st.ctxModel || !img }, icon('spark', { size: 14 }), ctxBusy ? 'Описание…' : 'Описать картинку'),
      d?.context ? h('button', { onclick: () => { d.context = ''; keep(); refresh_(); } }, 'Очистить') : null,
      h('label.row', { style: { gap: '4px', marginLeft: 'auto', fontSize: '11px' } },
        check(st.useContext !== false, v => { st.useContext = v; keep(); }), 'в промпте')),
    h('div.hint', {}, 'Vision-модель описывает сцену и стиль; теги добавляются в промпт генерации.'),
  ];
}

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
  const ch = changedKeys();
  const pv = (k, ctl) => h('div.f', {}, h('label', {}, k, ch.includes(k) ? h('span', { style: { color: 'var(--p-yellow-6)' } }, ' •') : null), h('div.v', {}, ctl));
  const setP = k => val => { st.params ||= {}; st.params[k] = val; keep(); };
  const samplers = S.nodes['sd.ksampler']?.inputs?.sampler_name?.options || [], scheds = S.nodes['sd.ksampler']?.inputs?.scheduler?.options || [];
  const redraw = st.mode === 'redraw';
  return [
    h('h3', {}, icon('spark', { size: 16 }), 'ImageNaizer'),
    h('div.hint', {}, img?.naturalWidth ? `${doc().base} · ${img.naturalWidth}×${img.naturalHeight} · слоёв: ${doc().layers.length}` : 'картинка не открыта'),
    h('div.ui-seg.nz-modes', {}, ...Object.entries(MODES).map(([k, [label, tip]]) => h(`button${st.mode === k ? '.on' : ''}`, { 'data-tip': tip, onclick: () => { st.mode = k; keep(); refresh(); } }, label))),
    h('div.hint', {}, `${MODES[st.mode][1]}. U-Net чекпоинта перерисовывает только область выделения (с полями контекста) — результат ложится новым слоем.`),
    h('h4', {}, redraw ? 'Что нарисовать на месте выделения' : 'Что подчеркнуть (необязательно)'),
    area(st.prompt[st.mode], redraw ? 'например: red rose in a glass vase' : 'например: detailed eyes, sharp texture', t => { st.prompt[st.mode] = t; keep(); }),
    h('h4', {}, 'Негатив'),
    area(st.negative, rec?.prompt?.negative || 'по умолчанию — теги базы модели', t => { st.negative = t; keep(); }, 2),
    row('сила', slider(st.denoise[st.mode], 0.1, 1, 0.05, x => { st.denoise[st.mode] = x; keep(); }), 'denoise: насколько сильно менять выделенное'),
    redraw ? h('label.row', { style: { gap: '6px', margin: '2px 0 4px' }, title: 'Перед генерацией размыть выделенное, чтобы старый объект не просвечивал' },
      check(st.fill !== false, v => { st.fill = v; keep(); }), 'размыть старое (лучше заменяет объект)') : null,
    ...contextCard(),
    h('h4', {}, 'Модель'),
    row('чекпоинт', h('div.row', { style: { flex: 1 } }, ckIn, ckBtn)),
    h('div.mcard.magic', {},
      h('div.row', {}, h('b', {}, `✦ Magic · ${rec?.profile || (rec?.error ? 'ошибка' : '…')}`), h('span.grow'),
        h('button', { disabled: !ch.length, onclick: () => { st.params = { ...st.magic.rec }; keep(); refresh(); } }, `Сбросить${ch.length ? ` (${ch.length})` : ''}`)),
      rec?.error ? h('div.hint', { style: { color: 'var(--err)' } }, rec.error) : null,
      pv('steps', num(st.params?.steps ?? '', setP('steps'), { int: true, min: 1, max: 200 })),
      pv('cfg', num(st.params?.cfg ?? '', setP('cfg'), { min: 0, max: 30, step: 0.5 })),
      pv('sampler', dropdown(st.params?.sampler_name || 'euler_ancestral', samplers.map(s => [s, s]), x => { setP('sampler_name')(x); refresh_(); }, { width: 150 })),
      pv('scheduler', dropdown(st.params?.scheduler || 'normal', scheds.map(s => [s, s]), x => { setP('scheduler')(x); refresh_(); }, { width: 150 })),
      ...(rec?.notes || []).map(t => h('div.hint', {}, `• ${t}`))),
    h('details.nz-adv', {}, h('summary', {}, 'Дополнительно'),
      row('поля', num(st.padding, x => { st.padding = x; keep(); draw(); }, { int: true, min: 0, max: 512, step: 8 }), 'контекст вокруг выделения, px (пунктир на холсте)'),
      row('растушёвка', num(st.feather, x => { st.feather = x; keep(); }, { int: true, min: 0, max: 128 }), 'мягкий край слоя, px'),
      row('разрешение', num(st.resolution, x => { st.resolution = x; keep(); }, { int: true, min: 0, max: 2048, step: 64 }), '0 — родное для модели (SDXL 1024)'),
      row('seed', num(st.seed, x => { st.seed = x; keep(); }, { int: true, min: -1 }), '-1 — новый каждый раз')),
    h('div.row', { style: { marginTop: '10px', flexWrap: 'wrap' } },
      busy ? h('button', { onclick: () => interrupt() }, icon('stop', { size: 14 }), 'Прервать')
        : h('button.primary', { onclick: () => run(), disabled: !img }, icon('play', { size: 14 }), MODES[st.mode][0])),
    h('div.hint', { style: { marginTop: '10px' } }, 'V — слой, H — рука, B — кисть, E — ластик, R — прямоугольник, L — лассо, Alt — вычесть, [ ] — размер кисти, Ctrl+A / Ctrl+D / Ctrl+I — всё / снять / инвертировать, Del — снять выделение, Shift+Del — стереть выделенное из слоя, Ctrl+E — слить с нижним, Ctrl+Z / Ctrl+Shift+Z — отмена / повтор, колесо — масштаб, ПКМ/Space — сдвиг, F — вписать, \\ — без слоёв, Ctrl+Enter — генерация.'),
  ];
}

// ---------- клавиши (поверх общих: Ctrl+Z, Ctrl+Enter, цифры) ----------
function keys(e) {
  if (activeView() !== 'naizer' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase(), A = activeL();
  let done = true;
  if (e.ctrlKey && (k === 'z' || k === 'я')) undo(e.shiftKey);
  else if (e.ctrlKey && (k === 'y' || k === 'н')) undo(true);
  else if (e.ctrlKey && e.key === 'Enter') (e.shiftKey ? interrupt() : run());
  else if (e.ctrlKey && (k === 'a' || k === 'ф')) selAll(true);
  else if (e.ctrlKey && (k === 'd' || k === 'в')) selAll(false);
  else if (e.ctrlKey && (k === 'i' || k === 'ш')) invertMask();
  else if (e.ctrlKey && (k === 'e' || k === 'у')) { if (A) mergeDown(A); }
  else if (e.ctrlKey && e.key === '0') zoomTo(1);
  else if (e.ctrlKey) done = false;
  else if (k === 'v' || k === 'м') setTool('move');
  else if (k === 'h' || k === 'р') setTool('hand');
  else if (k === 'b' || k === 'и') setTool('brush');
  else if (k === 'e' || k === 'у') setTool('eraser');
  else if (k === 'r' || k === 'к') setTool('rect');
  else if (k === 'l' || k === 'д') setTool('lasso');
  else if (k === 'f' || k === 'а') fit();
  else if (e.key === '[' || k === 'х') setSize(st.size / 1.2);
  else if (e.key === ']' || k === 'ъ') setSize(st.size * 1.2);
  else if (e.key === '\\') { if (!compare && !e.repeat) { compare = true; draw(); } }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && e.shiftKey) { if (A) cutLayer(A); }
  else if (e.key === 'Delete' || e.key === 'Backspace') selAll(false);
  else if (e.key === ' ') { if (!space) { space = true; setCursor(); draw(); } }
  else done = false;
  if (done) { e.preventDefault(); e.stopPropagation(); }
}

export function initNaizer() {
  registerInspector('naizer', inspector);
  document.addEventListener('keydown', keys, true);
  addEventListener('paste', onPaste);
  addEventListener('keyup', e => {
    if (e.key === ' ' && space) { space = false; setCursor(); draw(); }
    if (e.key === '\\' && compare) { compare = false; draw(); }
  });
  on('run-progress', d => {
    if (!busy || d.prompt_id !== busy.pid || d.node !== 'inp') return;
    busy.step = d.value; busy.max = d.max;
    const el = document.getElementById('nz-pend'); if (el) el.textContent = `шаг ${busy.step}/${busy.max}`;
    draw();
  });
  on('run-preview', d => {
    if (!busy || d.prompt_id !== busy.pid) return;
    if (d.box) busy.box = d.box;
    const im = new Image();
    im.onload = () => { if (busy) { busy.preview = im; draw(); } };
    im.src = d.image;
  });
  on('run-output', d => {
    if (!busy || d.prompt_id !== busy.pid || d.node !== 'inp') return;
    const ui = d.output?._ui;
    if (ui?.images?.[0]) onResult(ui.images[0], ui.patch, Number(d.output?.seed?.text ?? NaN) || null);
  });
  on('run-output', d => {
    if (!ctxPid || d.prompt_id !== ctxPid.pid || d.node !== 'out') return;
    const text = (d.output?._ui?.text || '').trim().replace(/^```[a-z]*\s*/i, '').replace(/\s*```$/, '');
    const dd = st.docs[ctxPid.file];
    if (text && dd) { dd.context = text; keep(); log('ok', 'контекст сцены описан'); }
  });
  on('run-error', d => {
    if (!ctxPid || d.prompt_id !== ctxPid.pid) return;
    ctxBusy = false; ctxPid = null;
    log('error', `контекст: ${String(d.message || 'ошибка').split('\n')[0]}`);
    refresh_();
  });
  on('run-done', d => {
    if (!ctxPid || d.prompt_id !== ctxPid.pid) return;
    if (!d.ok) log('error', `контекст: ${d.error?.message?.split('\n')[0] || 'запуск не удался'}`);
    ctxBusy = false; ctxPid = null;
    refresh_();
  });
  on('run-done', d => {
    if (!busy || (d.prompt_id && d.prompt_id !== busy.pid)) return;
    if (!d.ok) log(d.stopped ? 'warn' : 'error', `ImageNaizer: ${d.stopped ? 'прервано' : d.error?.message?.split('\n')[0] || 'запуск не удался'}`);
    busy = null; refresh();
  });
  on('server', s => {
    if (!s.running) return;
    setTimeout(() => {
      loadFiles();
      ensureCtx();
      // картинки, не загрузившиеся без сервера, — заново
      for (const [f, im] of pics) if (!im.naturalWidth) pics.delete(f);
      if (st.file && !img) open(st.file);
      draw();
    }, 900);
  });
  addEventListener('view', e => { if (e.detail === 'naizer') render(); });
}

export function showNaizer() {
  if (S.sel?.kind !== 'naizer') select({ kind: 'naizer', id: 'naizer' });
  if (st.file && !img && S.server.running) open(st.file);
  ensureCtx();
  loadFiles();
  render();
}
