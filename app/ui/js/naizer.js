// ImageNaizer: правка готовой картинки по выделению. Кистью, прямоугольником или лассо выделяется область, дальше —
// «Детализировать» (низкий denoise: те же формы, больше деталей) или «Перерисовать» (высокий denoise: на месте
// выделения — то, что написано в промпте). Под капотом — скрытый граф (Load Checkpoint → CLIP Text Encode ×2 →
// Inpaint Region) в общей очереди сервера: прогресс и поэтапное превью приходят как у любого запуска, результат —
// в output/ и в Results. Параметры сэмплинга подбирает Magic (/api/magic) под выбранный чекпоинт.
// Hierarchy (контекст naizer) — версии текущей картинки и последние файлы output/ и input/; Inspector — настройки.
import { h, num, debounce, clamp } from './util.js';
import { S, on, emit, select } from './store.js';
import { registerInspector } from './inspector.js';
import { icon } from './icons.js';
import { api, fileUrl, upload, interrupt } from './backend.js';
import { isShown, activeView } from './dock.js';
import { dropdown } from './kit.js';
import { libraryPicker } from './library.js';
import { fetchRec, MAGIC_KEYS } from './magic.js';
import { imagePicker, imagesFromTransfer, imagesFromClipboard, clipboardHasImage } from './images.js';

const LS = 'maistep-naizer';
const DEF = {
  file: '', versions: [], mode: 'detail', prompt: { detail: '', redraw: '' }, negative: '', denoise: { detail: 0.4, redraw: 0.9 },
  ckpt: '', params: null, magic: null, padding: 48, feather: 12, resolution: 0, seed: -1, tool: 'brush', size: 40,
};
const st = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(LS)) }; } catch { return { ...DEF }; } })();
const keep = debounce(() => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch {} }, 200);
const log = (level, text) => emit('log', { src: 'naizer', level, text });
const MODES = { detail: ['Детализировать', 'Те же формы, больше деталей: denoise 0.3–0.5'], redraw: ['Перерисовать', 'На месте выделения — то, что в промпте: denoise 0.8–1'] };
const TOOLS = [['brush', 'Кисть', 'B'], ['eraser', 'Ластик', 'E'], ['rect', 'Прямоугольник', 'R'], ['lasso', 'Лассо', 'L']];
const TINT = '#548AF7';

let cv = null, wrap = null, img = null, cmpImg = null, mask = null, tint = null, view = { x: 0, y: 0, z: 1 }, fitted = false;
let mouse = null, shape = null, undoStack = [], compare = false, busy = null, files = { output: [], input: [] }, lastMask = null;
let rec = null; // рекомендация Magic для st.ckpt

const cur = () => st.versions.find(v => v.file === st.file) || null;
const ckptName = () => st.ckpt || S.nodes['sd.checkpoint']?.inputs?.ckpt_name?.default || '';
const fileOf = f => (/^(input|output)\//.test(f) ? f : `input/${f}`);

// ---------- картинка и маска ----------
function open(file, { version = false } = {}) {
  if (!file) return;
  st.file = fileOf(file);
  if (!version && !st.versions.some(v => v.file === st.file)) st.versions = [{ file: st.file, root: true }];
  keep();
  img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => { newMask(); fitted = false; fit(); refresh(); };
  img.onerror = () => { log('error', `не открылась картинка ${st.file} (сервер запущен?)`); img = null; draw(); };
  img.src = fileUrl(st.file);
  cmpImg = null;
  refresh();
}

function newMask(keepOld = false) {
  const W = img.naturalWidth, H = img.naturalHeight;
  const old = keepOld && mask && mask.width === W && mask.height === H ? mask : null;
  mask = old || Object.assign(document.createElement('canvas'), { width: W, height: H });
  tint = Object.assign(document.createElement('canvas'), { width: W, height: H });
  undoStack = [];
  retint();
}
// подсветка выделения — та же маска, залитая цветом (рисуется с прозрачностью)
function retint() {
  if (!mask) return;
  const t = tint.getContext('2d');
  t.globalCompositeOperation = 'copy'; t.drawImage(mask, 0, 0);
  t.globalCompositeOperation = 'source-in'; t.fillStyle = TINT; t.fillRect(0, 0, tint.width, tint.height);
  t.globalCompositeOperation = 'source-over';
}
const masked = () => {
  if (!mask) return false;
  const s = 8, c = Object.assign(document.createElement('canvas'), { width: Math.ceil(mask.width / s), height: Math.ceil(mask.height / s) });
  const x = c.getContext('2d'); x.drawImage(mask, 0, 0, c.width, c.height);
  const d = x.getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 8) return true;
  return false;
};
function pushUndo() {
  undoStack.push(mask.getContext('2d').getImageData(0, 0, mask.width, mask.height));
  if (undoStack.length > 25) undoStack.shift();
}
function undoMask() {
  const d = undoStack.pop();
  if (!d) return;
  mask.getContext('2d').putImageData(d, 0, 0);
  retint(); draw();
}
function clearMask() { if (!mask) return; pushUndo(); mask.getContext('2d').clearRect(0, 0, mask.width, mask.height); retint(); draw(); }
function invertMask() {
  if (!mask) return;
  pushUndo();
  const m = mask.getContext('2d');
  m.globalCompositeOperation = 'xor'; m.fillStyle = '#fff'; m.fillRect(0, 0, mask.width, mask.height);
  m.globalCompositeOperation = 'source-over';
  retint(); draw();
}

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
  draw();
}

function draw() {
  if (!cv || !wrap?.isConnected) return;
  const W = wrap.clientWidth, H = wrap.clientHeight, dpr = devicePixelRatio || 1;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--p-gray-1').trim() || '#1E1F22';
  c.fillRect(0, 0, W, H);
  if (!img?.naturalWidth) {
    c.fillStyle = '#868A91'; c.font = '14px Inter, "Segoe UI", sans-serif'; c.textAlign = 'center';
    c.fillText(st.file ? 'Загрузка…' : 'Откройте картинку: кнопка «Открыть», файл из Hierarchy или перетащите сюда', W / 2, H / 2);
    c.textAlign = 'left';
    return;
  }
  if (!fitted) fit();
  const iw = img.naturalWidth * view.z, ih = img.naturalHeight * view.z;
  c.imageSmoothingQuality = 'high';
  c.drawImage(compare && cmpImg?.complete ? cmpImg : img, view.x, view.y, iw, ih);
  if (!compare && tint) { c.globalAlpha = 0.45; c.drawImage(tint, view.x, view.y, iw, ih); c.globalAlpha = 1; }
  c.strokeStyle = '#43454A'; c.strokeRect(view.x - 0.5, view.y - 0.5, iw + 1, ih + 1);
  // фигура в процессе
  if (shape?.kind === 'rect') {
    c.setLineDash([5, 4]); c.strokeStyle = shape.erase ? '#DB5C5C' : '#fff'; c.lineWidth = 1.5;
    c.strokeRect(Math.min(shape.a.x, shape.b.x), Math.min(shape.a.y, shape.b.y), Math.abs(shape.b.x - shape.a.x), Math.abs(shape.b.y - shape.a.y));
    c.setLineDash([]);
  } else if (shape?.kind === 'lasso' && shape.pts.length > 1) {
    c.setLineDash([5, 4]); c.strokeStyle = shape.erase ? '#DB5C5C' : '#fff'; c.lineWidth = 1.5;
    c.beginPath(); shape.pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y))); c.closePath(); c.stroke();
    c.setLineDash([]);
  }
  // курсор кисти
  if (mouse && !compare && (st.tool === 'brush' || st.tool === 'eraser') && !shape?.pan) {
    c.beginPath(); c.arc(mouse.x, mouse.y, st.size / 2, 0, 7);
    c.strokeStyle = '#000a'; c.lineWidth = 3; c.stroke();
    c.strokeStyle = st.tool === 'eraser' ? '#DB5C5C' : '#fff'; c.lineWidth = 1.2; c.stroke();
  }
  if (compare) badge(c, 'до правки', 10, 10);
  // поэтапное превью генерации — в углу
  if (busy) {
    const pv = busy.preview;
    const label = busy.max ? `${busy.mode === 'redraw' ? 'Перерисовка' : 'Детализация'} · шаг ${busy.step}/${busy.max}` : 'В очереди…';
    if (pv?.complete && pv.naturalWidth) {
      const k = Math.min(260 / pv.naturalWidth, 260 / pv.naturalHeight), w = pv.naturalWidth * k, hh = pv.naturalHeight * k;
      c.fillStyle = '#000b'; c.fillRect(W - w - 18, 10, w + 8, hh + 30);
      c.drawImage(pv, W - w - 14, 14, w, hh);
      c.fillStyle = '#fff'; c.font = '11px Inter, sans-serif'; c.fillText(label, W - w - 12, hh + 32);
    } else badge(c, label, W - 200, 10);
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
const pos = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
function onDown(e) {
  if (!img?.naturalWidth) return;
  cv.focus();
  const p = pos(e);
  if (e.button === 1 || e.button === 2 || (e.button === 0 && space)) {
    e.preventDefault();
    const v0 = { ...view };
    shape = { pan: true };
    cv.style.cursor = 'grabbing';
    return track(ev => { const q = pos(ev); view.x = v0.x + q.x - p.x; view.y = v0.y + q.y - p.y; draw(); }, () => { shape = null; cv.style.cursor = ''; draw(); });
  }
  if (e.button !== 0 || compare || busy) return;
  const erase = st.tool === 'eraser' || e.altKey;
  pushUndo();
  if (st.tool === 'brush' || st.tool === 'eraser') {
    let last = toImg(p);
    const w = st.size / view.z;
    const dab = (a, b) => paint(x => { x.lineWidth = w; x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(b.x + 0.01, b.y); x.stroke(); }, erase);
    dab(last, last);
    draw();
    return track(ev => { const q = toImg(pos(ev)); dab(last, q); last = q; mouse = pos(ev); draw(); });
  }
  if (st.tool === 'rect') {
    shape = { kind: 'rect', a: p, b: p, erase };
    return track(ev => { shape.b = pos(ev); draw(); }, () => {
      const a = toImg(shape.a), b = toImg(shape.b);
      if (Math.abs(b.x - a.x) > 2 && Math.abs(b.y - a.y) > 2) paint(x => x.fillRect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y)), shape.erase);
      else undoStack.pop();
      shape = null; draw();
    });
  }
  if (st.tool === 'lasso') {
    shape = { kind: 'lasso', pts: [p], erase };
    return track(ev => { shape.pts.push(pos(ev)); draw(); }, () => {
      const pts = shape.pts.map(toImg);
      if (pts.length > 2) paint(x => { x.beginPath(); pts.forEach((q, i) => (i ? x.lineTo(q.x, q.y) : x.moveTo(q.x, q.y))); x.closePath(); x.fill(); }, shape.erase);
      else undoStack.pop();
      shape = null; draw();
    });
  }
}
function track(move, up) {
  const u = ev => { removeEventListener('pointermove', move); removeEventListener('pointerup', u); up?.(ev); };
  addEventListener('pointermove', move); addEventListener('pointerup', u);
}
function onWheel(e) {
  e.preventDefault();
  if (!img?.naturalWidth) return;
  if (e.ctrlKey || e.altKey) { setSize(st.size * (e.deltaY < 0 ? 1.15 : 1 / 1.15)); return; }
  const p = pos(e), k = Math.exp(-e.deltaY * 0.0015), z = clamp(view.z * k, 0.05, 16);
  view.x = p.x - (p.x - view.x) * (z / view.z); view.y = p.y - (p.y - view.y) * (z / view.z); view.z = z;
  draw();
}
function setSize(v) { st.size = Math.round(clamp(v, 2, 600)); keep(); const s = document.getElementById('nz-size'); if (s) s.value = st.size; draw(); }
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
  if (!r?.ok) { rec = r; refresh_(); return; }
  rec = r;
  const key = ck;
  if (st.magic?.key !== key || !st.params || refresh) {
    const old = st.magic?.rec;
    st.params = st.params || {};
    for (const k of MAGIC_KEYS) if (refresh || !old || st.params[k] === undefined || String(st.params[k]) === String(old[k])) st.params[k] = r.params[k];
    st.magic = { key, rec: { ...r.params } };
    keep();
  }
  refresh_();
}
const changedKeys = () => (st.magic?.rec ? MAGIC_KEYS.filter(k => String(st.params?.[k]) !== String(st.magic.rec[k])) : []);

// ---------- запуск ----------
async function maskFile() {
  // маска в размер картинки: белое — перерисовать; уникальное имя — кэш нод сервера по входам
  const blob = await new Promise(r => mask.toBlob(r, 'image/png'));
  return upload(new File([blob], `naizer_mask_${Date.now()}.png`, { type: 'image/png' }));
}

async function run(again = false) {
  if (busy) return;
  if (!S.server.running) { log('warn', 'сервер не запущен'); emit('server-start'); return; }
  if (!img?.naturalWidth) return log('warn', 'сначала откройте картинку');
  const ck = ckptName();
  if (!ck) return log('warn', 'выберите чекпоинт в Inspector');
  const v = cur();
  const base = again && v?.parent ? v.parent : st.file;
  let mfile = again && v?.mask ? v.mask : null;
  if (!mfile) {
    if (!masked()) return log('warn', 'выделите область: кисть (B), прямоугольник (R) или лассо (L)');
    try { mfile = await maskFile(); } catch (e) { return log('error', `маска: ${e.message}`); }
  }
  const mode = again && v?.mode ? v.mode : st.mode;
  const user = (st.prompt[mode] || '').trim();
  if (mode === 'redraw' && !user) return log('warn', 'напишите в промпте, что нарисовать на месте выделения');
  if (!rec?.ok) await loadRec();
  const q = rec?.prompt || { positive: 'masterpiece, best quality', negative: 'lowres, worst quality, bad anatomy' };
  const positive = mode === 'detail' ? [q.positive, 'highly detailed, sharp focus, intricate details', user].filter(Boolean).join(', ') : [q.positive, user].filter(Boolean).join(', ');
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
      { id: 'img', type: 'image.load', props: { file: base } },
      { id: 'mask', type: 'image.load', props: { file: mfile } },
      { id: 'inp', type: 'sd.inpaint', props: { seed: st.seed, steps: p.steps ?? 25, cfg: p.cfg ?? 6, sampler_name: p.sampler_name || 'euler_ancestral', scheduler: p.scheduler || 'normal',
        denoise: st.denoise[mode], only_masked: true, padding: st.padding, resolution: st.resolution, feather: st.feather } },
    ],
    links: [L('ckpt', 'model', 'inp', 'model'), L('ckpt', 'clip', 'skip', 'clip'), L('skip', 'clip', 'pos', 'clip'), L('skip', 'clip', 'neg', 'clip'),
      L('pos', 'conditioning', 'inp', 'positive'), L('neg', 'conditioning', 'inp', 'negative'), L('ckpt', 'vae', 'inp', 'vae'),
      L('img', 'image', 'inp', 'image'), L('mask', 'image', 'inp', 'mask')],
    targets: ['inp'],
  };
  const pid = crypto.randomUUID().replace(/-/g, '');
  busy = { pid, mode, base, mask: mfile, prompt: user, step: 0, max: 0, preview: null };
  refresh();
  try {
    await api('/api/prompt', { id: pid, workflow: wf });
    log('info', `${MODES[mode][0]}: ${base.split('/').pop()} · denoise ${st.denoise[mode]} · ${p.steps} шагов, cfg ${p.cfg}, ${p.sampler_name}/${p.scheduler}`);
  } catch (e) {
    busy = null;
    for (const is of e.data?.issues || []) log('error', `нода ${is.node}: ${is.message}`);
    if (!e.data?.issues) log('error', `запуск: ${e.message}`);
    refresh();
  }
}

function onResult(file) {
  const b = busy;
  st.versions.push({ file, parent: b.base, mask: b.mask, mode: b.mode, prompt: b.prompt, at: Date.now() });
  lastMask = b.mask;
  busy = null;
  open(file, { version: true });
  log('ok', `готово: ${file}`);
}

// ---------- вид v-naizer ----------
function toolbar() {
  const fileIn = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
  fileIn.onchange = async () => { const f = fileIn.files[0]; if (!f) return; try { open(await upload(f)); } catch (e) { log('error', `загрузка: ${e.message}`); } };
  const size = h('input.ui-range#nz-size', { type: 'range', min: 2, max: 300, step: 1, value: Math.min(300, st.size), 'data-tip': 'Размер кисти ([ ], Ctrl+колесо)' });
  size.addEventListener('input', () => setSize(+size.value));
  const tools = TOOLS.map(([id, label, key]) => h(`button${st.tool === id ? '.on' : ''}`, { 'data-tip': `${label} (${key})${id === 'brush' || id === 'rect' || id === 'lasso' ? '\nAlt — стереть' : ''}`, onclick: () => setTool(id) }, label));
  const cmp = h('button', { 'data-tip': 'Зажмите — картинка до последней правки', disabled: !cur()?.parent },
    icon('eye', { size: 14 }), 'До / после');
  cmp.addEventListener('pointerdown', () => { const p = cur()?.parent; if (!p) return; cmpImg = new Image(); cmpImg.crossOrigin = 'anonymous'; cmpImg.onload = draw; cmpImg.src = fileUrl(p); compare = true; draw(); });
  for (const ev of ['pointerup', 'pointerleave']) cmp.addEventListener(ev, () => { if (compare) { compare = false; draw(); } });
  return h('div.bar', {},
    fileIn, h('button', { onclick: e => imagePicker(e.currentTarget, { value: st.file, onPick: f => open(f) }), 'data-tip': 'Картинка из библиотеки приложения (input/, output/) или с диска\nМожно перетащить файл или вставить Ctrl+V' }, icon('open', { size: 14 }), 'Открыть'),
    h('button.icon', { onclick: () => fileIn.click(), 'data-tip': 'С диска (проводник) — загрузится в input/' }, icon('upload', { size: 14 })),
    h('span.hsep'), ...tools, size,
    h('button.icon', { 'data-tip': 'Инвертировать выделение (I)', onclick: invertMask }, icon('swapPanels', { size: 14 })),
    h('button.icon', { 'data-tip': 'Отменить мазок (Ctrl+Z)', onclick: undoMask }, icon('undo', { size: 14 })),
    h('button.icon', { 'data-tip': 'Снять выделение (Del)', onclick: clearMask }, icon('delete', { size: 14 })),
    h('span.hsep'), h('button.icon', { 'data-tip': 'Вписать (F)', onclick: fit }, icon('fit', { size: 14 })), cmp,
    h('span.grow'),
    busy ? h('button', { onclick: () => interrupt() }, icon('stop', { size: 14 }), 'Прервать')
      : h('button.primary', { onclick: () => run(), disabled: !img, 'data-tip': 'Ctrl+Enter' }, icon('play', { size: 14 }), MODES[st.mode][0]));
}

function strip() {
  if (st.versions.length < 2) return null;
  return h('div.nz-strip', {}, ...st.versions.map((v, i) => h(`div.nz-ver${v.file === st.file ? '.on' : ''}`, {
    'data-tip': `${i ? `${MODES[v.mode]?.[0] || ''}${v.prompt ? `: ${v.prompt}` : ''}` : 'оригинал'}\n${v.file}`,
    onclick: () => open(v.file, { version: true }),
  }, h('img', { src: fileUrl(v.file), loading: 'lazy', alt: '', crossOrigin: 'anonymous' }), h('span', {}, i ? `v${i}` : 'исх.'))));
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
  v.replaceChildren(toolbar(), wrap, strip() || '');
  cv.style.cursor = st.tool === 'rect' || st.tool === 'lasso' ? 'crosshair' : (st.tool === 'brush' || st.tool === 'eraser') ? 'none' : '';
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
  const box = document.getElementById('inspector');
  if (box?.contains(document.activeElement) && document.activeElement !== document.body) return;
  emit('select', S.sel);
}

// ---------- Hierarchy ----------
async function loadFiles() {
  if (!S.server.running) return;
  try {
    const [o, i] = await Promise.all([api('/api/files?dir=output'), api('/api/files?dir=input')]);
    files = { output: o.filter(f => /\.(png|jpe?g|webp)$/i.test(f.file)).slice(0, 40), input: i.filter(f => /\.(png|jpe?g|webp)$/i.test(f.file) && !/naizer_mask_/.test(f.file)).slice(0, 40) };
  } catch {}
  if (S.ctx === 'naizer') emit('change', { kind: null });
}
export function naizerTreeItems() {
  const rows = [];
  if (st.versions.length) {
    rows.push({ grp: 'Версии' });
    st.versions.forEach((v, i) => rows.push({ ic: i ? 'edit' : 'image', label: i ? `v${i} · ${MODES[v.mode]?.[0] || ''}` : st.versions[0].file.split('/').pop(),
      tag: i && v.prompt ? v.prompt.slice(0, 24) : '', title: v.file, sel: v.file === st.file, onClick: () => open(v.file, { version: true }) }));
  }
  for (const [k, title] of [['output', 'Результаты (output/)'], ['input', 'Загруженные (input/)']]) {
    rows.push({ grp: title });
    if (!files[k].length) rows.push({ grp: S.server.running ? 'пусто' : 'сервер не запущен' });
    for (const f of files[k]) rows.push({ depth: 1, ic: 'image', label: f.file.split('/').pop(), title: f.file, sel: f.file === st.file, onClick: () => open(f.file) });
  }
  return rows;
}

// ---------- Inspector ----------
function inspector() {
  const v = cur();
  const area = (value, ph, set, rows = 3) => { const t = h('textarea', { rows, spellcheck: false, placeholder: ph }); t.value = value || ''; t.addEventListener('input', () => set(t.value)); t.addEventListener('keydown', e => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); run(); } }); return t; };
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
  return [
    h('h3', {}, icon('spark', { size: 16 }), 'ImageNaizer'),
    h('div.hint', {}, img?.naturalWidth ? `${st.file} · ${img.naturalWidth}×${img.naturalHeight}${v?.parent ? ` · правка от ${v.parent.split('/').pop()}` : ''}` : 'картинка не открыта'),
    h('div.nz-modes', {}, ...Object.entries(MODES).map(([k, [label, tip]]) => h(`button${st.mode === k ? '.on' : ''}`, { 'data-tip': tip, onclick: () => { st.mode = k; keep(); refresh(); } }, label))),
    h('div.hint', {}, MODES[st.mode][1]),
    h('h4', {}, st.mode === 'redraw' ? 'Что нарисовать на месте выделения' : 'Что подчеркнуть (необязательно)'),
    area(st.prompt[st.mode], st.mode === 'redraw' ? 'например: red rose in a glass vase' : 'например: detailed eyes, sharp texture', t => { st.prompt[st.mode] = t; keep(); }),
    h('h4', {}, 'Негатив'),
    area(st.negative, rec?.prompt?.negative || 'по умолчанию — теги базы модели', t => { st.negative = t; keep(); }, 2),
    row('сила', slider(st.denoise[st.mode], 0.1, 1, 0.05, x => { st.denoise[st.mode] = x; keep(); }), 'denoise: насколько сильно менять выделенное'),
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
      row('поля', num(st.padding, x => { st.padding = x; keep(); }, { int: true, min: 0, max: 512, step: 8 }), 'контекст вокруг выделения, px'),
      row('растушёвка', num(st.feather, x => { st.feather = x; keep(); }, { int: true, min: 0, max: 128 }), 'мягкий край вклейки, px'),
      row('разрешение', num(st.resolution, x => { st.resolution = x; keep(); }, { int: true, min: 0, max: 2048, step: 64 }), '0 — родное для модели (SDXL 1024)'),
      row('seed', num(st.seed, x => { st.seed = x; keep(); }, { int: true, min: -1 }), '-1 — новый каждый раз')),
    h('div.row', { style: { marginTop: '10px', flexWrap: 'wrap' } },
      busy ? h('button', { onclick: () => interrupt() }, icon('stop', { size: 14 }), 'Прервать')
        : h('button.primary', { onclick: () => run(), disabled: !img }, icon('play', { size: 14 }), MODES[st.mode][0]),
      !busy && v?.parent ? h('button', { 'data-tip': 'То же выделение и промпт, новый seed — от той же исходной картинки', onclick: () => run(true) }, icon('refresh', { size: 14 }), 'Ещё вариант') : null),
    h('div.hint', { style: { marginTop: '10px' } }, 'B — кисть, E — ластик, R — прямоугольник, L — лассо, Alt — стереть фигурой, [ ] — размер кисти, I — инвертировать, Del — снять выделение, Ctrl+Z — отменить мазок, колесо — масштаб, ПКМ/Space — сдвиг, Ctrl+Enter — применить.'),
  ];
}

// ---------- клавиши (поверх общих: Ctrl+Z, Ctrl+Enter, цифры) ----------
let space = false;
function keys(e) {
  if (activeView() !== 'naizer' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase();
  let done = true;
  if (e.ctrlKey && k === 'z') undoMask();
  else if (e.ctrlKey && e.key === 'Enter') (e.shiftKey ? interrupt() : run());
  else if (e.ctrlKey) done = false;
  else if (k === 'b') setTool('brush');
  else if (k === 'e') setTool('eraser');
  else if (k === 'r') setTool('rect');
  else if (k === 'l') setTool('lasso');
  else if (k === 'i') invertMask();
  else if (k === 'f') fit();
  else if (e.key === '[') setSize(st.size / 1.2);
  else if (e.key === ']') setSize(st.size * 1.2);
  else if (e.key === 'Delete' || e.key === 'Backspace') clearMask();
  else if (e.key === ' ') { space = true; }
  else done = false;
  if (done) { e.preventDefault(); e.stopPropagation(); }
}

export function initNaizer() {
  registerInspector('naizer', inspector);
  document.addEventListener('keydown', keys, true);
  addEventListener('paste', onPaste);
  addEventListener('keyup', e => { if (e.key === ' ') space = false; });
  on('run-progress', d => { if (busy && d.prompt_id === busy.pid && d.node === 'inp') { busy.step = d.value; busy.max = d.max; draw(); } });
  on('run-preview', d => {
    if (!busy || d.prompt_id !== busy.pid) return;
    const im = new Image();
    im.onload = () => { if (busy) { busy.preview = im; draw(); } };
    im.src = d.image;
  });
  on('run-output', d => { if (busy && d.prompt_id === busy.pid && d.node === 'inp' && d.output?._ui?.images?.[0]) onResult(d.output._ui.images[0]); });
  on('run-done', d => {
    if (!busy || (d.prompt_id && d.prompt_id !== busy.pid)) return;
    if (!d.ok) log('error', `ImageNaizer: ${d.error?.message?.split('\n')[0] || 'запуск не удался'}`);
    busy = null; refresh();
  });
  on('server', s => { if (s.running) setTimeout(() => { loadFiles(); if (st.file && !img) open(st.file, { version: true }); }, 900); });
  addEventListener('view', e => { if (e.detail === 'naizer') render(); });
}

export function showNaizer() {
  if (S.sel?.kind !== 'naizer') select({ kind: 'naizer', id: 'naizer' });
  if (st.file && !img && S.server.running) open(st.file, { version: true });
  loadFiles();
  render();
}
