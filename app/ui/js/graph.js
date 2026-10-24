// Workflow: граф нод AI-пайплайна (как в ComfyUI). Каталог нод — с Python-сервера (/api/nodes).
// Нода: шапка, слоты (входы-пины слева, выходы справа), виджеты (значения входов STRING/INT/FLOAT/BOOLEAN/COMBO —
// у каждого тоже есть пин: связь перекрывает значение), превью результата (текст, картинки, стриминг LLM).
// Связь — от выхода к входу (или наоборот); бросить связь в пустоту — поиск ноды с автоподключением.
// Двойной щелчок по фону — поиск нод; по виджету — правка значения; ПКМ — меню ноды; колесо — масштаб;
// тянуть фон (или средней кнопкой) — сдвиг; Del — удалить; Ctrl+D — дублировать; Ctrl+C/V; M — выключить ноду; F — вписать.
import { h, clamp, debounce } from './util.js';
import { S, on, emit, doc, edit, select, uniqueId } from './store.js';
import { activeView, showView } from './dock.js';
import { icon } from './icons.js';
import { openViewer } from './viewer.js';
import { popup } from './ctxmenu.js';
import { fileUrl, queuePrompt, upload, getModels, modelMeta } from './backend.js';
import { modelPicker } from './modelpick.js';
import { libraryPicker } from './library.js';
import { applyLoraTriggers, appendTriggers } from './lora.js';
import { MAGIC, magicState, isMagicChanged, resetMagic } from './magic.js';
import { imagePicker, imagesFromTransfer, imagesFromClipboard, clipboardHasImage } from './images.js';

const NW = 280, HEAD = 30, ROW = 24, PAD = 10, PREV_MAX = 420, R = 8;
const FONT = 'Inter, "Segoe UI", system-ui, sans-serif', MONO = '"JetBrains Mono", Consolas, monospace';
// цвета холста — палитра UI Kit (uikit.css, New UI Dark): читаются из CSS-переменных при сборке вида
const K = { bg: '#1E1F22', dots: '#393B40', node: '#2B2D30', head: '#313337', edge: '#1A1B1D', field: '#1E1F22', fieldBd: '#43454A',
  fieldHi: '#6F737A', fg: '#DFE1E5', fg2: '#B4B8BF', dim: '#868A91', off: '#5A5D63', accent: '#3574F0', ok: '#57965C', warn: '#D6AE58',
  err: '#DB5C5C', errBg: '#402929', sel: '#548AF7' };
function readTheme() {
  const cs = getComputedStyle(document.documentElement), v = n => cs.getPropertyValue(n).trim();
  const map = { bg: '--p-gray-1', dots: '--p-gray-3', node: '--p-gray-2', fieldBd: '--p-gray-4', fieldHi: '--p-gray-7', fg: '--p-gray-12',
    fg2: '--p-gray-10', dim: '--p-gray-8', off: '--p-gray-6', accent: '--p-blue-6', ok: '--p-green-6', warn: '--p-yellow-6', err: '--p-red-7',
    errBg: '--p-red-1', sel: '--p-blue-8' };
  for (const [k, n] of Object.entries(map)) if (v(n)) K[k] = v(n);
  K.field = K.bg;
}
export const TYPE_COLOR = { STRING: '#8bc78b', INT: '#7fb4e0', FLOAT: '#7fb4e0', BOOLEAN: '#e0a35f', COMBO: '#c9a0dc', IMAGE: '#64b5f6', JSON: '#f2c46b', '*': '#b5b8c0',
  MODEL: '#b39ddb', CLIP: '#ffd500', VAE: '#ff6e6e', CONDITIONING: '#ffa931', LATENT: '#ff9cf9', CONTROL_NET: '#00d78d' };
const CAT_COLOR = { Values: '#3b6e4a', Text: '#3d5f8a', JSON: '#8a6a2e', Logic: '#5c4a8a', AI: '#8a3d6a', Image: '#2e6f86', Files: '#5a5f68', Output: '#7a4a2e',
  Loaders: '#4b5a8a', Conditioning: '#8a6a2e', Sampling: '#6a3d7a', Latent: '#8a3d5c', 'My Nodes': '#4a6a5a' };
const catColor = cat => CAT_COLOR[cat] || `hsl(${[...String(cat)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 35% 34%)`;
const tcol = t => TYPE_COLOR[t] || '#b5b8c0';

let cv = null, wrap = null, view = { x: 40, y: 20, z: 1 }, linking = null, hover = null, issues = new Map(), clip = null;
// пан/зум каждого воркфлоу — помнятся между запусками
const VIEWS_KEY = 'maistep-graph-views';
const views = new Map((() => { try { return Object.entries(JSON.parse(localStorage.getItem(VIEWS_KEY)) || {}); } catch { return []; } })());
const keepViews = debounce(() => { try { localStorage.setItem(VIEWS_KEY, JSON.stringify(Object.fromEntries(views))); } catch {} }, 400);
const setView = () => { views.set(S.current.workflow, { ...view }); keepViews(); };
const imgs = new Map(); // url → Image
const imgRetry = new Map(); // url → сколько раз уже пробовали (сервер мог ещё не подняться)

export const defs = () => S.nodes || {};
const cur = () => doc('workflow', S.current.workflow);
const selNode = () => (S.sel?.kind === 'node' && S.sel.doc === S.current.workflow ? S.sel.id : null);
const selLink = () => (S.sel?.kind === 'link' && S.sel.doc === S.current.workflow ? S.sel.index : null);
const outputsOf = id => S.outputs[S.current.workflow]?.[id];

export function compatible(outT, inT) {
  return outT === inT || outT === '*' || inT === '*' || (inT === 'STRING' && ['INT', 'FLOAT', 'JSON'].includes(outT));
}

// ---------- раскладка ноды ----------
function layout(n, d = cur()) {
  const def = defs()[n.type];
  const linked = new Set(d.data.links.filter(l => l.to === n.id).map(l => l.in));
  // вход «needs: vision» (картинка для LLM) прячем, если выбранная модель картинки не принимает
  const noVision = llmModel(n, def)?.vision === false;
  const ins = Object.entries(def?.inputs || {}).filter(([k, i]) => !(i.needs === 'vision' && noVision && !linked.has(k)));
  const pins = ins.filter(([k, i]) => !i.widget || linked.has(k)).map(([k]) => k);
  const widgets = ins.filter(([k, i]) => i.widget && !linked.has(k)).map(([k]) => k);
  const outs = def?.outputs || [];
  const slots = Math.max(pins.length, outs.length);
  const w = n.w || NW;
  const top = n.y + HEAD + 4;
  const wTop = top + slots * ROW;
  // Magic KSampler: строка «профиль · Сбросить» под виджетами
  const mTop = wTop + widgets.length * ROW, mrow = n.type === MAGIC ? ROW : 0;
  const pTop = mTop + mrow + (widgets.length || mrow ? 4 : 0);
  const pv = previewOf(n, def, w - 20);
  const ph = pv ? Math.min(PREV_MAX, pv.h) : 0;
  const hgt = n.collapsed ? HEAD : pTop - n.y + ph + (ph ? PAD : 4);
  const inPos = {};
  pins.forEach((k, i) => { inPos[k] = { x: n.x, y: top + i * ROW + ROW / 2 }; });
  widgets.forEach((k, i) => { inPos[k] = { x: n.x, y: wTop + i * ROW + ROW / 2 }; });
  const outPos = {};
  outs.forEach((o, i) => { outPos[o.name] = { x: n.x + w, y: top + i * ROW + ROW / 2 }; });
  if (n.collapsed) {
    for (const k in inPos) inPos[k] = { x: n.x, y: n.y + HEAD / 2 };
    for (const k in outPos) outPos[k] = { x: n.x + w, y: n.y + HEAD / 2 };
  }
  return { def, pins, widgets, outs, slots, w, top, wTop, mTop, mrow, pTop, pv, ph, h: hgt, inPos, outPos };
}

// модель LLM ноды (если у ноды есть виджет выбора модели): метаданные из каталога или null
export function llmModel(n, def = defs()[n.type]) {
  const e = Object.entries(def?.inputs || {}).find(([, i]) => i.picker === 'llm_model');
  if (!e) return null;
  const [k, i] = e;
  const pid = n.props?.[i.provider_input] ?? def.inputs[i.provider_input]?.default;
  return modelMeta(pid, n.props?.[k] ?? i.default);
}
const providersUsed = d => [...new Set(d.data.nodes.flatMap(n => {
  const def = defs()[n.type], e = Object.entries(def?.inputs || {}).find(([, i]) => i.picker === 'llm_model');
  return e ? [n.props?.[e[1].provider_input] ?? def.inputs[e[1].provider_input]?.default] : [];
}).filter(Boolean))];

// превью: { kind: 'text'|'image'|'error'|'stream', text, urls, h, live, step }
// картинки: поэтапное превью генерации → результат ноды → файл, выбранный во входе с upload: 'image' (Load Image)
function previewOf(n, def = defs()[n.type], pw = (n.w || NW) - 20) {
  const run = S.run?.wf === S.current.workflow ? S.run : null;
  const live = run?.preview?.[n.id];
  if (live) return imagePv([live.image], pw, { live: true, step: live.step });
  const st = run?.stream[n.id];
  if (st) return { kind: 'stream', text: st, h: lineCount(st) * 15 + 12 };
  const o = outputsOf(n.id);
  if (o?._error) return { kind: 'error', text: o._error.split('\n').slice(0, 6).join('\n'), h: Math.min(6, lineCount(o._error)) * 15 + 12 };
  if (o) {
    const images = [...(o._ui?.images || []), ...(def?.output ? Object.values(o).filter(v => v?.image).map(v => v.image) : [])];
    if (images.length) return imagePv([...new Set(images)].map(fileUrl), pw);
    const text = o._ui?.text ?? Object.values(o).find(v => v?.text != null)?.text;
    if (text != null && (def?.output || n.preview !== false)) return { kind: 'text', text: String(text), h: lineCount(text) * 15 + 12 };
  }
  const up = Object.entries(def?.inputs || {}).find(([, i]) => i.upload === 'image');
  const f = up && (n.props?.[up[0]] ?? up[1].default);
  if (f) return imagePv([fileUrl(/^(input|output)\//.test(f) ? f : `input/${f}`)], pw, { input: true });
  return null;
}
// сетка картинок: высота — по пропорциям первой загруженной (до загрузки — квадрат)
function imagePv(urls, pw, extra = {}) {
  const list = urls.slice(0, 8), cols = Math.min(list.length, list.length > 4 ? 4 : list.length);
  const im = extra.live ? liveImage(list[0]) : image(list[0]);
  const ar = im?.naturalWidth ? im.naturalHeight / im.naturalWidth : 1;
  const cw = pw / cols, rows = Math.ceil(list.length / cols);
  return { kind: 'image', urls, list, cols, rows, h: clamp(Math.round(cw * ar) * rows, 60, PREV_MAX), ...extra };
}
const lineCount = t => Math.min(14, String(t).split('\n').reduce((a, l) => a + Math.max(1, Math.ceil(l.length / 40)), 0));

const toScreen = p => ({ x: p.x * view.z + view.x, y: p.y * view.z + view.y });
const toWorld = p => ({ x: (p.x - view.x) / view.z, y: (p.y - view.y) / view.z });

function curve(c, a, b) {
  const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
  c.beginPath(); c.moveTo(a.x, a.y); c.bezierCurveTo(a.x + dx, a.y, b.x - dx, b.y, b.x, b.y); c.stroke();
}

function image(url) {
  let im = imgs.get(url);
  if (!im) {
    if (imgs.size > 200) imgs.delete(imgs.keys().next().value);
    im = new Image(); im.decoding = 'async'; im.crossOrigin = 'anonymous';
    im.onload = () => { imgRetry.delete(url); redraw(); };
    // картинка из input/ или output/: сервер мог быть ещё не готов при старте окна — пробуем ещё несколько раз,
    // иначе «битая» картинка навсегда оставалась в кеше и превью после перезапуска было пустым
    im.onerror = () => {
      if (imgs.get(url) === im) imgs.delete(url);
      const n = (imgRetry.get(url) || 0) + 1;
      if (n > 5) return;
      imgRetry.set(url, n);
      setTimeout(() => { if (S.server.running || n < 2) redraw(); }, 350 * n);
    };
    const n = imgRetry.get(url) || 0;
    im.src = n ? `${url}&_r=${n}` : url; // обходим закешированный неудачный ответ
    imgs.set(url, im);
  }
  return im;
}
// кадры поэтапного превью (data URL): держим один готовый кадр, пока декодируется следующий — без мигания
let liveShown = null, liveNext = null;
function liveImage(url) {
  if (liveShown?.src === url) return liveShown;
  if (liveNext?.src !== url) {
    const im = new Image();
    im.onload = () => { if (liveNext === im) { liveShown = im; liveNext = null; redraw(); } };
    im.src = url; liveNext = im;
  }
  return liveShown;
}

// ---------- отрисовка ----------
export function draw() {
  const d = cur();
  if (!cv || !wrap.isConnected) return;
  const W = wrap.clientWidth, H = wrap.clientHeight, dpr = devicePixelRatio || 1;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = K.bg; c.fillRect(0, 0, W, H);
  const g = 20 * view.z;
  c.fillStyle = K.dots;
  if (g > 6) for (let x = view.x % g; x < W; x += g) for (let y = view.y % g; y < H; y += g) c.fillRect(x, y, 1.3, 1.3);
  if (!d) return;
  c.save();
  c.translate(view.x, view.y); c.scale(view.z, view.z);
  const L = new Map(d.data.nodes.map(n => [n.id, layout(n, d)]));
  const byId = new Map(d.data.nodes.map(n => [n.id, n]));
  // связи
  c.lineCap = 'round';
  d.data.links.forEach((l, i) => {
    const a = L.get(l.from), b = L.get(l.to);
    if (!a || !b) return;
    const p = a.outPos[l.out], q = b.inPos[l.in];
    if (!p || !q) return;
    const t = a.outs.find(o => o.name === l.out)?.type;
    const muted = byId.get(l.from).mode === 'mute' || byId.get(l.to).mode === 'mute';
    const hot = i === selLink() || selNode() === l.from || selNode() === l.to;
    c.globalAlpha = muted ? 0.3 : hot ? 1 : 0.8;
    c.strokeStyle = i === selLink() ? K.warn : tcol(t);
    c.lineWidth = i === selLink() ? 3.5 : hot ? 3 : 2.2;
    curve(c, p, q);
    c.globalAlpha = 1;
  });
  if (linking) {
    c.strokeStyle = tcol(linking.type); c.lineWidth = 2.4; c.setLineDash([6, 4]);
    linking.reverse ? curve(c, linking.to, linking.from) : curve(c, linking.from, linking.to);
    c.setLineDash([]);
  }
  // ноды вне экрана не рисуем
  const v0 = toWorld({ x: 0, y: 0 }), v1 = toWorld({ x: W, y: H });
  for (const n of d.data.nodes) {
    const nl = L.get(n.id);
    if (n.x > v1.x || n.y > v1.y || n.x + nl.w < v0.x || n.y + nl.h < v0.y) continue;
    // одна сломанная нода не должна гасить отрисовку остальных
    c.save();
    try { drawNode(c, n, nl); } catch (e) { console.error('draw node', n.id, e); } finally { c.restore(); }
  }
  c.restore();
  c.fillStyle = K.dim; c.font = `11px ${FONT}`;
  const run = S.run?.wf === d.id ? ` · выполняется ${S.run.node || '…'}` : '';
  c.fillText(`${d.id} · нод ${d.data.nodes.length} · связей ${d.data.links.length} · ${Math.round(view.z * 100)}%${run}`, 10, H - 10);
  if (!d.data.nodes.length) {
    c.fillStyle = K.dim; c.font = `14px ${FONT}`; c.textAlign = 'center';
    c.fillText('Двойной щелчок — добавить ноду · или перетащите из палитры слева', W / 2, H / 2);
    c.textAlign = 'left';
  }
}

// значение виджета для показа: модель библиотеки — имя файла без папок и расширения
function widgetText(n, def, k, inp, v) {
  if (inp.type === 'BOOLEAN') return v ? 'да' : 'нет';
  if (v === '' || v == null) return inp.picker || inp.upload ? 'не выбрано' : '—';
  if (inp.picker === 'library_model' || inp.upload) return String(v).split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, '');
  if (inp.picker === 'llm_model') { const m = llmModel(n, def); return `${m?.vision ? '👁 ' : ''}${v}`; }
  if (inp.type === 'FLOAT') return String(Math.round(Number(v) * 1000) / 1000);
  return String(v).replace(/\n/g, ' ⏎ ');
}

function drawNode(c, n, L) {
  const { def, pins, widgets, outs, w, top, wTop, pTop, pv, ph } = L;
  const sel = n.id === selNode(), bad = issues.has(n.id) || outputsOf(n.id)?._error;
  const running = S.run?.wf === S.current.workflow && S.run.node === n.id;
  const done = !running && outputsOf(n.id) && !bad;
  const muted = n.mode === 'mute';
  const cat = def ? catColor(def.cat) : K.err;
  c.globalAlpha = muted ? 0.45 : 1;
  // корпус
  c.shadowColor = '#0009'; c.shadowBlur = sel ? 18 : 10; c.shadowOffsetY = 2;
  c.fillStyle = K.node; rr(c, n.x, n.y, w, L.h, R); c.fill();
  c.shadowBlur = 0; c.shadowOffsetY = 0;
  // шапка: чуть светлее корпуса, полоска цвета категории сверху
  c.save(); rr(c, n.x, n.y, w, L.h, R); c.clip();
  c.fillStyle = K.head; c.fillRect(n.x, n.y, w, HEAD);
  c.fillStyle = cat; c.fillRect(n.x, n.y, w, 3);
  if (!n.collapsed) { c.fillStyle = K.edge; c.fillRect(n.x, n.y + HEAD, w, 1); }
  if (running && S.run.progress?.max) {
    c.fillStyle = K.ok; c.fillRect(n.x, n.y + HEAD - 2, w * clamp(S.run.progress.value / S.run.progress.max, 0, 1), 2);
  }
  c.restore();
  c.strokeStyle = running ? K.ok : bad ? K.err : sel ? K.sel : K.edge;
  c.lineWidth = running || bad || sel ? 2 : 1; rr(c, n.x, n.y, w, L.h, R); c.stroke();
  // заголовок + статус справа
  const title = n.title || def?.title || n.type;
  let right = muted ? 'выкл' : n.id, rc = K.dim;
  const o = outputsOf(n.id);
  if (running) { const p = S.run.progress; right = p?.max ? `${p.value}/${p.max}` : '…'; rc = K.ok; }
  else if (bad) { right = 'ошибка'; rc = K.err; }
  else if (o?._time != null) { right = `${o._time}s`; rc = K.fg2; }
  c.font = `10.5px ${MONO}`; c.textAlign = 'right'; c.fillStyle = rc;
  const rw = c.measureText(right).width;
  c.fillText(right, n.x + w - 10, n.y + 19.5);
  c.textAlign = 'left';
  let tx = n.x + 10;
  if (n.collapsed) { c.fillStyle = K.dim; c.font = `10px ${FONT}`; c.fillText('▸', tx, n.y + 19.5); tx += 12; }
  if (running || done || bad) {
    c.beginPath(); c.arc(tx + 3, n.y + 16, 3, 0, 7); c.fillStyle = running ? K.ok : bad ? K.err : K.ok; c.globalAlpha = done ? 0.6 : 1; c.fill(); c.globalAlpha = muted ? 0.45 : 1;
    tx += 11;
  }
  c.fillStyle = K.fg; c.font = `600 12.5px ${FONT}`;
  c.fillText(clipText(c, title, n.x + w - rw - 22 - tx), tx, n.y + 20);
  if (n.collapsed) {
    for (const k in L.inPos) dot(c, L.inPos[k], tcol(def?.inputs[k]?.type), isLinkedIn(n.id, k));
    for (const oo of outs) dot(c, L.outPos[oo.name], tcol(oo.type), true);
    c.globalAlpha = 1;
    return;
  }
  // сильно отдалено — только корпус, пины и картинки: текст всё равно не читается, а рисовать его дорого
  const lod = view.z < 0.3;
  // слоты
  c.font = `11.5px ${FONT}`;
  pins.forEach((k, i) => {
    const inp = def.inputs[k], y = top + i * ROW + ROW / 2;
    dot(c, L.inPos[k], tcol(inp.type), isLinkedIn(n.id, k), hover?.node === n.id && hover.in === k);
    if (lod) return;
    c.fillStyle = inp.optional ? K.dim : K.fg2; c.fillText(clipText(c, k, w / 2 - 20), n.x + 14, y + 4);
  });
  outs.forEach((oo, i) => {
    const y = top + i * ROW + ROW / 2;
    dot(c, L.outPos[oo.name], tcol(oo.type), true, hover?.node === n.id && hover.out === oo.name);
    if (lod) return;
    c.fillStyle = K.fg2; c.textAlign = 'right'; c.fillText(clipText(c, oo.name, w / 2 - 20), n.x + w - 14, y + 4); c.textAlign = 'left';
  });
  // виджеты — поля UI Kit: тёмный фон, рамка, подпись слева, значение справа
  widgets.forEach((k, i) => {
    const inp = def.inputs[k], y = wTop + i * ROW;
    const hot = hover?.node === n.id && hover.widget === k;
    dot(c, L.inPos[k], tcol(inp.type), false, hover?.node === n.id && hover.in === k, 3);
    const fx = n.x + 10, fw = w - 20, fy = y + 2, fh = ROW - 4;
    c.fillStyle = K.field; rr(c, fx, fy, fw, fh, 4); c.fill();
    if (lod) return;
    c.strokeStyle = hot ? K.fieldHi : K.fieldBd; c.lineWidth = 1; rr(c, fx + 0.5, fy + 0.5, fw - 1, fh - 1, 4); c.stroke();
    const v = n.props?.[k] ?? inp.default;
    const num = ['INT', 'FLOAT'].includes(inp.type), menu = inp.type === 'COMBO' || inp.picker || inp.upload;
    const ty = y + ROW / 2 + 4;
    if (num) {
      c.fillStyle = hot ? K.fg2 : K.off; c.font = `10px ${FONT}`;
      c.fillText('◀', fx + 5, ty - 0.5); c.textAlign = 'right'; c.fillText('▶', fx + fw - 5, ty - 0.5); c.textAlign = 'left';
    }
    const lx = fx + (num ? 18 : 8);
    c.font = `11px ${FONT}`; c.fillStyle = K.dim;
    const label = clipText(c, k, fw * 0.42);
    c.fillText(label, lx, ty);
    const lw = c.measureText(label).width;
    if (isMagicChanged(n, k)) { c.fillStyle = K.warn; c.beginPath(); c.arc(lx + lw + 5, ty - 3.5, 2.2, 0, 7); c.fill(); }
    if (inp.type === 'BOOLEAN') {
      // тумблер
      const tw = 24, th = 13, tx0 = fx + fw - tw - 7, ty0 = fy + (fh - th) / 2;
      c.fillStyle = v ? K.accent : K.fieldBd; rr(c, tx0, ty0, tw, th, th / 2); c.fill();
      c.fillStyle = '#fff'; c.beginPath(); c.arc(v ? tx0 + tw - th / 2 : tx0 + th / 2, ty0 + th / 2, th / 2 - 2, 0, 7); c.fill();
      return;
    }
    let vs = widgetText(n, def, k, inp, v);
    const empty = (v === '' || v == null) && (inp.picker || inp.upload);
    c.fillStyle = empty ? K.warn : K.fg; c.textAlign = 'right';
    if (inp.picker === 'llm_model' && !llmModel(n, def) && S.models[n.props?.[inp.provider_input]]?.models?.length) c.fillStyle = K.warn;
    const vx = fx + fw - (num ? 18 : menu ? 20 : 8);
    c.font = `${num ? `11px ${MONO}` : `11.5px ${FONT}`}`;
    c.fillText(clipText(c, vs, vx - lx - lw - 10), vx, ty);
    if (menu) { c.fillStyle = K.dim; c.font = `9px ${FONT}`; c.fillText('▼', fx + fw - 7, ty - 1); }
    c.textAlign = 'left';
  });
  if (L.mrow && !lod) drawMagic(c, n, L);
  // превью
  if (pv && ph) {
    const x = n.x + 10, y = pTop, pw = w - 20;
    c.fillStyle = pv.kind === 'error' ? K.errBg : K.field; rr(c, x, y, pw, ph, 6); c.fill();
    c.save(); rr(c, x, y, pw, ph, 6); c.clip();
    if (pv.kind === 'image') {
      const cw = pw / pv.cols, chh = ph / pv.rows;
      pv.list.forEach((u, i) => {
        const im = pv.live ? liveImage(u) : image(u);
        if (!im?.complete || !im.naturalWidth) return;
        const cx = x + (i % pv.cols) * cw, cy = y + Math.floor(i / pv.cols) * chh;
        const k = Math.min((cw - 2) / im.naturalWidth, (chh - 2) / im.naturalHeight);
        const iw = im.naturalWidth * k, ih = im.naturalHeight * k;
        c.imageSmoothingQuality = 'high';
        c.drawImage(im, cx + (cw - iw) / 2, cy + (chh - ih) / 2, iw, ih);
      });
      const tag = pv.live ? `шаг ${pv.step}${S.run?.progress?.max ? `/${S.run.progress.max}` : ''}` : pv.urls.length > pv.list.length ? `+${pv.urls.length - pv.list.length}` : pv.urls.length > 1 ? `${pv.urls.length} шт.` : '';
      if (tag) badge(c, tag, x + 6, y + 6, pv.live ? K.ok : null);
    } else if (!lod) {
      c.font = `11px ${MONO}`; c.fillStyle = pv.kind === 'error' ? '#F0A8A6' : pv.kind === 'stream' ? '#9FE0B4' : K.fg2;
      const lines = wrapText(c, pv.text, pw - 14);
      const shown = pv.kind === 'stream' ? lines.slice(-Math.floor((ph - 8) / 15)) : lines;
      shown.forEach((ln, i) => { const yy = y + 16 + i * 15; if (yy < y + ph) c.fillText(ln, x + 7, yy); });
    }
    c.restore();
  }
  c.globalAlpha = 1;
}

// строка Magic KSampler: профиль модели слева, «Сбросить» справа (активна, когда значения изменены руками)
function drawMagic(c, n, L) {
  const m = magicState(cur(), n), fx = n.x + 10, fw = L.w - 20, y = L.mTop, ty = y + ROW / 2 + 4;
  c.font = `11px ${FONT}`;
  c.fillStyle = m.error ? K.err : K.accent;
  const left = !m.src.ckpt ? '✦ подключите Load Checkpoint' : m.loading ? '✦ подбор параметров…' : m.error ? `✦ ${m.error}` : `✦ Magic · ${m.profile || '…'}`;
  const bw = 72;
  c.fillText(clipText(c, left, fw - bw - 8), fx + 2, ty);
  const on_ = m.changed.length > 0, hot = hover?.node === n.id && hover.magic;
  c.fillStyle = on_ ? (hot ? K.accent : K.fieldBd) : K.field; rr(c, fx + fw - bw, y + 3, bw, ROW - 6, 4); c.fill();
  c.fillStyle = on_ ? K.fg : K.off; c.textAlign = 'center';
  c.fillText(on_ ? `Сбросить (${m.changed.length})` : 'по Magic', fx + fw - bw / 2, ty);
  c.textAlign = 'left';
}

function badge(c, text, x, y, color) {
  c.font = `600 10px ${FONT}`;
  const bw = c.measureText(text).width + 12;
  c.fillStyle = '#000000b0'; rr(c, x, y, bw, 17, 8.5); c.fill();
  if (color) { c.fillStyle = color; c.beginPath(); c.arc(x + 8, y + 8.5, 3, 0, 7); c.fill(); }
  c.fillStyle = '#fff'; c.fillText(text, x + (color ? 14 : 6), y + 12);
}

function dot(c, p, color, filled, hot = false, r = 4.5) {
  if (hot) { c.beginPath(); c.arc(p.x, p.y, r + 5, 0, 7); c.fillStyle = `${color}40`; c.fill(); }
  c.beginPath(); c.arc(p.x, p.y, hot ? r + 1.5 : r, 0, 7);
  if (filled) { c.fillStyle = color; c.fill(); } else { c.fillStyle = K.node; c.fill(); c.strokeStyle = color; c.lineWidth = 2; c.stroke(); }
}
const isLinkedIn = (id, k) => cur()?.data.links.some(l => l.to === id && l.in === k);

function wrapText(c, text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    if (!para) { out.push(''); continue; }
    let line = '';
    for (const ch of para) {
      if (c.measureText(line + ch).width > width) { out.push(line); line = ch; } else line += ch;
    }
    out.push(line);
    if (out.length > 200) break;
  }
  return out;
}
function clipText(c, s, w) { s = String(s); if (w <= 8) return ''; if (c.measureText(s).width <= w) return s; while (s.length > 1 && c.measureText(`${s}…`).width > w) s = s.slice(0, -1); return `${s}…`; }
function rr(c, x, y, w, h0, r) { c.beginPath(); c.roundRect(x, y, w, h0, r); }

// ---------- попадания ----------
function hit(p) {
  const d = cur();
  if (!d) return null;
  for (const n of [...d.data.nodes].reverse()) {
    const L = layout(n, d);
    for (const [k, q] of Object.entries(L.inPos)) if (Math.hypot(q.x - p.x, q.y - p.y) < 9) return { node: n.id, n, L, in: k };
    for (const [k, q] of Object.entries(L.outPos)) if (Math.hypot(q.x - p.x, q.y - p.y) < 9) return { node: n.id, n, L, out: k };
    if (p.x < n.x || p.x > n.x + L.w || p.y < n.y || p.y > n.y + L.h) continue;
    if (p.y < n.y + HEAD) return { node: n.id, n, L, head: true };
    if (!n.collapsed && p.y >= L.wTop && p.y < L.wTop + L.widgets.length * ROW) {
      const k = L.widgets[Math.floor((p.y - L.wTop) / ROW)];
      const side = p.x < n.x + 26 ? -1 : p.x > n.x + L.w - 26 ? 1 : 0;
      return { node: n.id, n, L, widget: k, side };
    }
    if (!n.collapsed && L.mrow && p.y >= L.mTop && p.y < L.mTop + L.mrow) return { node: n.id, n, L, magic: true, reset: p.x > n.x + L.w - 82 };
    if (p.x > n.x + L.w - 10 && p.y > n.y + L.h - 10) return { node: n.id, n, L, resize: true };
    if (!n.collapsed && L.pv?.kind === 'image' && p.y >= L.pTop && p.y < L.pTop + L.ph) {
      const pv = L.pv, i = Math.floor((p.x - n.x - 10) / ((L.w - 20) / pv.cols)) + pv.cols * Math.floor((p.y - L.pTop) / (L.ph / pv.rows));
      return { node: n.id, n, L, preview: clamp(i, 0, pv.list.length - 1), body: true };
    }
    return { node: n.id, n, L, body: true };
  }
  return null;
}

function linkAt(p) {
  const d = cur();
  const L = new Map(d.data.nodes.map(n => [n.id, layout(n, d)]));
  return d.data.links.findIndex(l => {
    const A = L.get(l.from)?.outPos[l.out], B = L.get(l.to)?.inPos[l.in];
    if (!A || !B) return false;
    const dx = Math.max(40, Math.abs(B.x - A.x) * 0.5);
    for (let i = 0; i <= 30; i++) {
      const t = i / 30, u = 1 - t;
      const x = u ** 3 * A.x + 3 * u * u * t * (A.x + dx) + 3 * u * t * t * (B.x - dx) + t ** 3 * B.x;
      const y = u ** 3 * A.y + 3 * u * u * t * A.y + 3 * u * t * t * B.y + t ** 3 * B.y;
      if (Math.hypot(x - p.x, y - p.y) < 6 / view.z) return true;
    }
    return false;
  });
}

function mouse(e) { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
const drag = (mm, mu) => {
  const up = ev => { removeEventListener('pointermove', mm); removeEventListener('pointerup', up); mu?.(ev); };
  addEventListener('pointermove', mm); addEventListener('pointerup', up);
};

// ---------- правка ----------
const wfEdit = (fn, opts) => edit('workflow', S.current.workflow, fn, opts);

export function connect(from, out, to, inp) {
  wfEdit(wf => {
    wf.links = wf.links.filter(l => !(l.to === to && l.in === inp)); // у входа одна связь
    wf.links.push({ from, out, to, in: inp });
  }, { label: 'связь' });
}

function setProp(id, k, v, merge = true) {
  wfEdit(wf => { const n = wf.nodes.find(z => z.id === id); n.props ||= {}; n.props[k] = v; }, { label: `${id}.${k}`, merge: merge ? `${id}.${k}` : null });
  if (k === 'lora_name') applyLoraTriggers(S.current.workflow, id, v);
}

export function addNode(type, at, props = {}, opts = {}) {
  const d = cur();
  const def = defs()[type];
  if (!d || !def) return null;
  const id = uniqueId(`n${d.data.nodes.length + 1}`, d.data.nodes.map(n => n.id));
  const pos = at || toWorld({ x: wrap.clientWidth / 2 - NW / 2, y: wrap.clientHeight / 2 - 60 });
  const defaults = Object.fromEntries(Object.entries(def.inputs).filter(([, i]) => i.widget).map(([k, i]) => [k, i.default]));
  wfEdit(wf => {
    wf.nodes.push({ id, type, x: Math.round(pos.x / 10) * 10, y: Math.round(pos.y / 10) * 10, props: { ...defaults, ...props } });
    if (opts.triggers?.length) appendTriggers(wf, opts.triggers); // вместе с нодой — одним шагом отмены
  }, { label: `нода ${def.title}` });
  select({ kind: 'node', doc: d.id, id });
  return id;
}

export function deleteSel() {
  const d = cur();
  if (!d) return false;
  const n = selNode(), l = selLink();
  if (n) { wfEdit(wf => { wf.nodes = wf.nodes.filter(x => x.id !== n); wf.links = wf.links.filter(x => x.from !== n && x.to !== n); }, { label: `удалить ${n}` }); select({ kind: 'workflow', doc: d.id, id: d.id }); return true; }
  if (l != null) { wfEdit(wf => { wf.links.splice(l, 1); }, { label: 'удалить связь' }); select({ kind: 'workflow', doc: d.id, id: d.id }); return true; }
  return false;
}

function duplicate(id = selNode(), at = null) {
  const d = cur(), n = d?.data.nodes.find(x => x.id === id);
  if (!n) return;
  paste({ ...structuredClone(n) }, at || { x: n.x + 30, y: n.y + 30 });
}
function paste(n, at) {
  const d = cur();
  if (!d || !n) return;
  const id = uniqueId(`n${d.data.nodes.length + 1}`, d.data.nodes.map(x => x.id));
  wfEdit(wf => { wf.nodes.push({ ...structuredClone(n), id, x: Math.round(at.x / 10) * 10, y: Math.round(at.y / 10) * 10 }); }, { label: `копия ${n.type}` });
  select({ kind: 'node', doc: d.id, id });
}

const toggleMute = id => wfEdit(wf => { const n = wf.nodes.find(z => z.id === id); if (n.mode === 'mute') delete n.mode; else n.mode = 'mute'; }, { label: 'вкл/выкл ноду' });
const toggleCollapse = id => wfEdit(wf => { const n = wf.nodes.find(z => z.id === id); n.collapsed = !n.collapsed || undefined; }, { label: 'свернуть ноду' });

// ---------- мышь ----------
let lastMouse = { x: 0, y: 0 };

function onDown(e) {
  const d = cur();
  if (!d) return;
  closeFloat();
  const sp = mouse(e), p = toWorld(sp);
  if (e.button === 1 || (e.button === 0 && e.altKey)) return pan(e, sp);
  if (e.button === 2) return;
  const t = hit(p);
  // связь от выхода
  if (t?.out) {
    const type = t.L.outs.find(o => o.name === t.out).type;
    return startLink({ from: t.L.outPos[t.out], to: p, node: t.node, pin: t.out, type, reverse: false });
  }
  // от входа: есть связь — отцепить и тянуть от её источника; нет — тянуть обратную связь
  if (t?.in) {
    const ex = d.data.links.find(l => l.to === t.node && l.in === t.in);
    if (ex) {
      const src = d.data.nodes.find(n => n.id === ex.from), SL = layout(src, d);
      wfEdit(wf => { wf.links = wf.links.filter(l => !(l.to === t.node && l.in === t.in)); }, { label: 'отцепить связь' });
      return startLink({ from: SL.outPos[ex.out], to: p, node: ex.from, pin: ex.out, type: SL.outs.find(o => o.name === ex.out).type, reverse: false });
    }
    return startLink({ from: t.L.inPos[t.in], to: p, node: t.node, pin: t.in, type: t.L.def.inputs[t.in].type, reverse: true });
  }
  if (t?.widget) {
    select({ kind: 'node', doc: d.id, id: t.node });
    const inp = t.L.def.inputs[t.widget], v = t.n.props?.[t.widget] ?? inp.default;
    if (inp.type === 'BOOLEAN') return setProp(t.node, t.widget, !v, false);
    if (['INT', 'FLOAT'].includes(inp.type) && t.side) return setProp(t.node, t.widget, stepNum(inp, v, t.side), true);
    if (inp.type === 'COMBO') return comboMenu(e, t.node, t.widget, inp, v);
    if (inp.upload) return imagePicker(e, { value: v, onPick: f => setProp(t.node, t.widget, f, false) });
    if (inp.picker === 'library_model') {
      const cat = inp.cat || (t.n.props?.[inp.cat_input] ?? t.L.def.inputs[inp.cat_input]?.default);
      return libraryPicker(e, { cat, value: v, onPick: name => setProp(t.node, t.widget, name, false) });
    }
    if (inp.picker === 'llm_model') {
      const pid = t.n.props?.[inp.provider_input] ?? t.L.def.inputs[inp.provider_input]?.default;
      return modelPicker(e, { provider: pid, value: v, onPick: id => setProp(t.node, t.widget, id, false) });
    }
    if (['INT', 'FLOAT'].includes(inp.type)) return dragNum(e, t, inp, v);
    return;
  }
  if (t?.magic) {
    select({ kind: 'node', doc: d.id, id: t.node });
    if (t.reset) resetMagic(d.id, t.node);
    return;
  }
  if (t?.resize) {
    const w0 = t.L.w;
    return drag(ev => { const q = toWorld(mouse(ev)); wfEdit(wf => { wf.nodes.find(z => z.id === t.node).w = Math.max(180, Math.round((w0 + q.x - p.x) / 10) * 10); }, { label: 'размер ноды', merge: `w.${t.node}` }); });
  }
  if (t) {
    select({ kind: 'node', doc: d.id, id: t.node });
    const x0 = t.n.x, y0 = t.n.y;
    return drag(ev => {
      const q = mouse(ev);
      const nx = Math.round((x0 + (q.x - sp.x) / view.z) / 10) * 10, ny = Math.round((y0 + (q.y - sp.y) / view.z) / 10) * 10;
      wfEdit(wf => { const nn = wf.nodes.find(z => z.id === t.node); nn.x = nx; nn.y = ny; }, { label: 'переместить ноду', merge: `mv.${t.node}` });
    });
  }
  const li = linkAt(p);
  if (li >= 0) return select({ kind: 'link', doc: d.id, index: li });
  select({ kind: 'workflow', doc: d.id, id: d.id });
  pan(e, sp);
}

function pan(e, sp) {
  const v0 = { ...view };
  cv.style.cursor = 'grabbing';
  drag(ev => { const q = mouse(ev); view.x = v0.x + q.x - sp.x; view.y = v0.y + q.y - sp.y; draw(); }, () => { cv.style.cursor = ''; setView(); });
}

const stepNum = (inp, v, dir) => {
  const st = inp.step || (inp.type === 'INT' ? 1 : 0.1);
  let r = Math.round(((Number(v) || 0) + dir * st) * 1e6) / 1e6;
  if (inp.min != null) r = Math.max(inp.min, r);
  if (inp.max != null) r = Math.min(inp.max, r);
  return inp.type === 'INT' ? Math.round(r) : r;
};

// протяжка числа влево/вправо: 6 px = шаг; без движения — двойной щелчок откроет ввод
function dragNum(e, t, inp, v0) {
  const x0 = e.clientX;
  let moved = false;
  drag(ev => {
    const n = Math.trunc((ev.clientX - x0) / 6);
    if (!n && !moved) return;
    moved = true;
    cv.style.cursor = 'ew-resize';
    let r = Number(v0) || 0;
    for (let i = 0; i < Math.abs(n); i++) r = stepNum(inp, r, Math.sign(n) * (ev.shiftKey ? 10 : 1));
    setProp(t.node, t.widget, r, true);
  }, () => { cv.style.cursor = ''; });
}

function startLink(l) {
  linking = l;
  drag(ev => {
    linking.to = toWorld(mouse(ev));
    const t = hit(linking.to);
    hover = t && (linking.reverse ? t.out : t.in || t.widget) ? { node: t.node, in: t.in || t.widget, out: t.out } : null;
    draw();
  }, ev => {
    const l2 = linking; linking = null; hover = null;
    const p = toWorld(mouse(ev)), t = hit(p);
    if (!l2.reverse) {
      let target = t?.in || t?.widget;
      if (t && !target && t.node !== l2.node) {
        // бросили на ноду — первый подходящий свободный вход
        const ins = Object.entries(t.L.def?.inputs || {});
        target = (ins.find(([k, i]) => compatible(l2.type, i.type) && !isLinkedIn(t.node, k) && !i.widget) || ins.find(([, i]) => compatible(l2.type, i.type)))?.[0];
      }
      if (t && target && t.node !== l2.node) {
        const it = t.L.def.inputs[target].type;
        if (compatible(l2.type, it)) connect(l2.node, l2.pin, t.node, target);
        else emit('log', { src: 'editor', level: 'warn', text: `нельзя соединить ${l2.type} → ${it}` });
      } else if (!t) searchBox(ev, p, { from: l2 });
    } else {
      let target = t?.out;
      if (t && !target && t.node !== l2.node) target = t.L.outs.find(o => compatible(o.type, l2.type))?.name;
      if (t && target && t.node !== l2.node) {
        const ot = t.L.outs.find(o => o.name === target).type;
        if (compatible(ot, l2.type)) connect(t.node, target, l2.node, l2.pin);
        else emit('log', { src: 'editor', level: 'warn', text: `нельзя соединить ${ot} → ${l2.type}` });
      } else if (!t) searchBox(ev, p, { to: l2 });
    }
    draw();
  });
  draw();
}

function onMove(e) {
  lastMouse = mouse(e);
  if (linking) return;
  const t = hit(toWorld(lastMouse));
  const nh = t ? { node: t.node, in: t.in, out: t.out, widget: t.widget, magic: t.reset } : null;
  if (JSON.stringify(nh) !== JSON.stringify(hover)) {
    hover = nh;
    cv.style.cursor = t?.in || t?.out ? 'crosshair' : t?.resize ? 'nwse-resize' : t?.widget ? (['INT', 'FLOAT'].includes(t.L.def.inputs[t.widget].type) ? 'ew-resize' : 'pointer') : t?.preview != null ? 'zoom-in' : t?.reset ? 'pointer' : t ? 'move' : '';
    draw();
  }
}

function onDbl(e) {
  const p = toWorld(mouse(e)), t = hit(p);
  if (t?.widget) return inlineEdit(t);
  if (t?.head) return toggleCollapse(t.node);
  if (t?.preview != null) return lightbox(t.L.pv.urls, t.preview);
  if (!t) searchBox(e, p);
}

function onWheel(e) {
  e.preventDefault();
  const sp = mouse(e), before = toWorld(sp);
  view.z = clamp(view.z * Math.exp(-clamp(e.deltaY, -100, 100) * 0.0015), 0.01, 40); // практически без ограничений; тачпад — плавно
  view.x = sp.x - before.x * view.z; view.y = sp.y - before.y * view.z;
  setView();
  draw();
}

// ---------- всплывающие: поиск нод, правка виджета, меню ----------
let float = null;
function closeFloat() { float?.remove(); float = null; }
function place(el, e) {
  document.body.append(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.min(e.clientX, innerWidth - r.width - 8)}px`;
  el.style.top = `${Math.min(e.clientY, innerHeight - r.height - 8)}px`;
  float = el;
}

// поиск ноды; ctx.from — связь от выхода (показать ноды с подходящим входом), ctx.to — к входу
export function searchBox(e, at, ctx = {}) {
  closeFloat();
  const want = ctx.from ? ctx.from.type : ctx.to ? ctx.to.type : null;
  const fits = def => !want ? true : ctx.from ? Object.values(def.inputs).some(i => compatible(want, i.type)) : def.outputs.some(o => compatible(o.type, want));
  const all = Object.entries(defs()).filter(([, d]) => fits(d));
  let list = all, idx = 0;
  const input = h('input', { placeholder: want ? `Нода для ${want}…` : 'Найти ноду…', spellcheck: false });
  const box = h('div.gsearch');
  const pick = ([type, def]) => {
    closeFloat();
    const id = addNode(type, at);
    if (!id) return;
    if (ctx.from) {
      const k = Object.entries(def.inputs).find(([, i]) => compatible(want, i.type))?.[0];
      if (k) connect(ctx.from.node, ctx.from.pin, id, k);
    } else if (ctx.to) {
      const o = def.outputs.find(x => compatible(x.type, want));
      if (o) connect(id, o.name, ctx.to.node, ctx.to.pin);
    }
  };
  const render = () => {
    box.replaceChildren(...list.slice(0, 60).map(([t, d], i) => h(`div.it${i === idx ? '.on' : ''}`, { onmousedown: ev => { ev.preventDefault(); pick([t, d]); } },
      h('i', { style: { background: catColor(d.cat) } }), h('span', {}, d.title), h('span.dim', {}, `${d.cat} · ${t}`))));
    box.children[idx]?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    list = all.filter(([t, d]) => q.every(w => `${t} ${d.title} ${d.cat} ${d.hint || ''}`.toLowerCase().includes(w)));
    idx = 0; render();
  });
  input.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'ArrowDown') { idx = Math.min(list.length - 1, idx + 1); render(); ev.preventDefault(); }
    if (ev.key === 'ArrowUp') { idx = Math.max(0, idx - 1); render(); ev.preventDefault(); }
    if (ev.key === 'Enter' && list[idx]) pick(list[idx]);
    if (ev.key === 'Escape') closeFloat();
  });
  const el = h('div.gfloat', { onpointerdown: ev => ev.stopPropagation() }, input, box);
  place(el, e);
  render();
  input.focus();
  if (!all.length) box.replaceChildren(h('div.dim', { style: { padding: '8px' } }, Object.keys(defs()).length ? 'нет подходящих нод' : 'каталог нод пуст — запустите сервер'));
}

function inlineEdit(t) {
  closeFloat();
  const inp = t.L.def.inputs[t.widget], v = t.n.props?.[t.widget] ?? inp.default;
  const multi = inp.type === 'STRING' && (inp.multiline || String(v).includes('\n'));
  const ed = multi ? h('textarea', { rows: 8, spellcheck: false }) : h('input', { spellcheck: false, type: ['INT', 'FLOAT'].includes(inp.type) ? 'number' : 'text', step: inp.step || 'any' });
  ed.value = v ?? '';
  // Ctrl+↑/↓ меняет вес тега под курсором/выделения: (girl:1.2)
  if (multi && ((t.n.type === 'sd.text_encode' && t.widget === 'text') || (t.n.type === 'image.generate_openai' && t.widget === 'prompt'))) {
    ed.dataset.promptWeight = '';
    ed.title = 'Ctrl+↑ / Ctrl+↓ — вес тега: (girl:1.2)';
  }
  const sp = toScreen({ x: t.n.x + 10, y: t.L.wTop + t.L.widgets.indexOf(t.widget) * ROW });
  const r = cv.getBoundingClientRect();
  const commit = () => {
    let val = ed.value;
    if (inp.type === 'INT') val = Math.round(Number(val) || 0);
    if (inp.type === 'FLOAT') val = Number(val) || 0;
    setProp(t.node, t.widget, val, false);
    closeFloat();
  };
  ed.addEventListener('keydown', ev => {
    ev.stopPropagation();
    if (ev.key === 'Escape') closeFloat();
    if (ev.key === 'Enter' && (!multi || ev.ctrlKey)) { ev.preventDefault(); commit(); }
  });
  ed.addEventListener('blur', () => float === el && commit());
  const el = h('div.gedit', { onpointerdown: ev => ev.stopPropagation() }, h('div.dim', {}, `${t.widget}${multi ? ' · Ctrl+Enter — готово' : ''}`), ed);
  Object.assign(el.style, { left: `${r.left + sp.x}px`, top: `${r.top + sp.y}px`, width: `${Math.max(240, (t.L.w - 20) * view.z)}px` });
  document.body.append(el);
  float = el;
  ed.focus(); ed.select?.();
}

// просмотр картинок превью — общий просмотрщик (viewer.js)
export function lightbox(urls, i = 0) {
  closeFloat();
  openViewer(urls, i);
}

function comboMenu(e, id, k, inp, v) {
  closeFloat();
  const el = h('div.ui-menu.gfloat-menu', { onpointerdown: ev => ev.stopPropagation() },
    ...(inp.options || []).map(o => h(`div.item${o === v ? '.on' : ''}`, { onclick: () => { setProp(id, k, o, false); closeFloat(); } }, h('span.ic', {}, o === v ? icon('check', { size: 14 }) : null), h('span', {}, o))));
  place(el, e);
}

function nodeMenu(e, t) {
  closeFloat();
  const it = (ic, label, fn, sc) => h('div.item', { onclick: () => { closeFloat(); fn(); } }, h('span.ic', {}, ic ? icon(ic, { size: 16 }) : null), h('span', {}, label), sc ? h('span.sc', {}, sc) : null);
  const el = h('div.ui-menu.gfloat-menu', { onpointerdown: ev => ev.stopPropagation() },
    it('play', 'Выполнить до этой ноды', () => queuePrompt(S.current.workflow, 1, [t.node])),
    h('div.sep'),
    it('copy', 'Дублировать', () => duplicate(t.node), 'Ctrl+D'),
    it(t.n.mode === 'mute' ? 'show' : 'hide', t.n.mode === 'mute' ? 'Включить' : 'Выключить', () => toggleMute(t.node), 'M'),
    it(t.n.collapsed ? 'expandAll' : 'collapseAll', t.n.collapsed ? 'Развернуть' : 'Свернуть', () => toggleCollapse(t.node)),
    it('edit', 'Переименовать…', () => { select({ kind: 'node', doc: S.current.workflow, id: t.node }); setTimeout(() => document.querySelector('#inspector input')?.focus(), 30); }),
    t.L.def?.source && t.L.def.source !== 'builtin' ? it('code', `Код ноды (${t.L.def.source})`, () => emit('open-code', t.L.def.source.startsWith('nodes/') ? `server/${t.L.def.source}` : t.L.def.source)) : null,
    h('div.sep'),
    it('delete', 'Удалить', () => { select({ kind: 'node', doc: S.current.workflow, id: t.node }); deleteSel(); }, 'Del'));
  place(el, e);
}

function onContext(e) {
  e.preventDefault();
  const p = toWorld(mouse(e)), t = hit(p);
  if (t) { select({ kind: 'node', doc: S.current.workflow, id: t.node }); return nodeMenu(e, t); }
  searchBox(e, p);
}

// ---------- перетаскивание файлов ----------
async function onDrop(e) {
  e.preventDefault();
  const p = toWorld(mouse(e));
  const dt = e.dataTransfer, t = dt.getData('text/mai-node');
  if (t) return addNode(t, p);
  // не картинки (текст и т.п.) — файл в input/ и нода чтения; читаем до первого await
  const IMGX = /\.(png|jpe?g|webp|gif|bmp)$/i;
  const other = [...(dt.files || [])].filter(f => !/^image\//.test(f.type) && !IMGX.test(f.name));
  const mai = dt.getData('text/mai-file');
  if (mai && !IMGX.test(mai)) return addNode('io.read_text', p, { file: mai });
  const pending = imagesFromTransfer(dt);
  for (const file of other) {
    try {
      const rel = await upload(file);
      if (/\.json$/i.test(rel)) emit('log', { src: 'editor', level: 'info', text: `файл загружен: ${rel} (воркфлоу открывайте из папки workflows/)` });
      else addNode('io.read_text', p, { file: rel });
    } catch (err) { emit('log', { src: 'editor', level: 'error', text: `загрузка ${file.name}: ${err.message} (сервер запущен?)` }); }
  }
  placeImages(await pending, p);
}

// картинки на граф: на ноду со входом-загрузкой (Load Image) под курсором — заменить её файл, иначе — новые Load Image
function placeImages(files, p) {
  if (!files.length || !cur()) return;
  const t = hit(p), upKey = t && Object.entries(t.L.def?.inputs || {}).find(([, i]) => i.upload === 'image')?.[0];
  files.forEach((f, i) => {
    if (i === 0 && upKey) setProp(t.node, upKey, f, false);
    else addNode('image.load', { x: p.x + i * 30, y: p.y + i * 30 }, { file: f });
  });
}

// Ctrl+V: картинка из буфера → в выбранную Load Image или новой нодой под курсором; иначе — скопированная нода
async function onPaste(e) {
  const el = document.activeElement;
  if (activeView() !== 'graph' || !cv || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el?.tagName) || el?.isContentEditable) return;
  const at = toWorld(lastMouse);
  if (clipboardHasImage(e) || /\/view\?file=/.test(e.clipboardData?.getData('text/plain') || '')) {
    e.preventDefault();
    const sel = cur()?.data.nodes.find(n => n.id === selNode());
    const upKey = sel && Object.entries(defs()[sel.type]?.inputs || {}).find(([, i]) => i.upload === 'image')?.[0];
    const files = await imagesFromClipboard(e);
    if (files.length && upKey) setProp(sel.id, upKey, files[0], false);
    else placeImages(files, at);
    return;
  }
  if (clip) { e.preventDefault(); paste(clip, at); }
}

// ---------- вид ----------
export function fit() {
  const d = cur();
  if (!d?.data.nodes.length || !wrap) return;
  const Ls = d.data.nodes.map(n => [n, layout(n, d)]);
  const x0 = Math.min(...Ls.map(([n]) => n.x)) - 40, y0 = Math.min(...Ls.map(([n]) => n.y)) - 40;
  const x1 = Math.max(...Ls.map(([n, L]) => n.x + L.w)) + 40, y1 = Math.max(...Ls.map(([n, L]) => n.y + L.h)) + 40;
  view.z = clamp(Math.min(wrap.clientWidth / (x1 - x0), wrap.clientHeight / (y1 - y0)), 0.01, 1.5);
  view.x = (wrap.clientWidth - (x1 - x0) * view.z) / 2 - x0 * view.z;
  view.y = (wrap.clientHeight - (y1 - y0) * view.z) / 2 - y0 * view.z;
  setView();
  draw();
}

function palette() {
  const groups = {};
  const ORDER = ['Loaders', 'Conditioning', 'Sampling', 'Latent', 'Image', 'AI', 'Text', 'Values', 'Logic', 'JSON', 'Files', 'Output'];
  const rank = c => (ORDER.includes(c) ? ORDER.indexOf(c) : ORDER.length);
  for (const [t, def] of Object.entries(defs()).sort((a, b) => rank(a[1].cat) - rank(b[1].cat))) (groups[def.cat] ||= []).push([t, def]);
  const filter = h('input.pal-q', { placeholder: 'Фильтр нод…', spellcheck: false });
  const list = h('div');
  const fill = () => {
    const q = filter.value.toLowerCase();
    list.replaceChildren(...Object.entries(groups).flatMap(([cat, items]) => {
      const vis = items.filter(([t, d]) => !q || `${t} ${d.title}`.toLowerCase().includes(q));
      return vis.length ? [h('div.grp', {}, cat), ...vis.map(([t, def]) => h('div.it', {
        'data-tip': `${def.title}\n${t}${def.hint ? `\n${def.hint}` : ''}`, onclick: () => addNode(t), draggable: true,
        ondragstart: e => e.dataTransfer.setData('text/mai-node', t),
        oncontextmenu: e => popup(e, [
          { ic: 'add', label: 'Добавить на граф', fn: () => addNode(t) },
          '-',
          { ic: 'copy', label: 'Копировать название', fn: () => navigator.clipboard?.writeText(def.title) },
          { ic: 'copy', label: `Копировать тип (${t})`, fn: () => navigator.clipboard?.writeText(t) },
          def.source && def.source !== 'builtin' ? { ic: 'code', label: 'Код ноды', fn: () => emit('open-code', def.source.startsWith('nodes/') ? `server/${def.source}` : def.source) } : null,
        ]),
      }, h('i', { style: { background: catColor(cat) } }), def.title))] : [];
    }));
    if (!list.childElementCount) list.append(h('div.dim', { style: { padding: '8px 10px' } }, Object.keys(defs()).length ? 'ничего не найдено' : 'нет каталога нод — запустите сервер'));
  };
  filter.addEventListener('input', fill);
  filter.addEventListener('keydown', e => e.stopPropagation());
  fill();
  return h('div.palette', {}, filter, list);
}

function build() {
  const v = document.getElementById('v-graph');
  if (!cur()) { v.replaceChildren(h('div.msg', {}, h('div', {}, 'Нет воркфлоу'), h('button.primary', { onclick: () => emit('new-workflow') }, 'Создать воркфлоу'))); cv = null; return; }
  readTheme();
  view = views.get(S.current.workflow) || { x: 40, y: 20, z: 1 };
  cv = h('canvas', { tabIndex: 0 });
  wrap = h('div.graph', {}, cv);
  const d = cur();
  v.replaceChildren(
    h('div.bar', {},
      h('button.primary', { onclick: () => queuePrompt(), 'data-tip': 'Запустить воркфлоу (Ctrl+Enter)' }, icon('play', { size: 14 }), 'Запуск'),
      h('button', { onclick: () => checkGraph(), 'data-tip': 'Проверить связи и входы' }, icon('check', { size: 14 }), 'Проверить'),
      h('button', { onclick: fit, 'data-tip': 'Вписать (F)' }, icon('fit', { size: 14 }), 'Вписать'),
      h('button', { onclick: deleteSel, 'data-tip': 'Удалить выбранное (Del)' }, icon('delete', { size: 14 })),
      h('span.grow'),
      h('span.dim', {}, d.data.title || d.id)),
    h('div.bp', {}, palette(), wrap));
  cv.addEventListener('pointerdown', onDown);
  cv.addEventListener('pointermove', onMove);
  cv.addEventListener('dblclick', onDbl);
  cv.addEventListener('contextmenu', onContext);
  cv.addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('dragover', e => e.preventDefault());
  cv.addEventListener('drop', onDrop);
  new ResizeObserver(() => draw()).observe(wrap);
  issues = new Map();
  if (!views.has(S.current.workflow)) requestAnimationFrame(fit); else draw();
  if (S.server.running) for (const pid of providersUsed(d)) getModels(pid);
}

export async function checkGraph() {
  const d = cur();
  if (!d) return;
  const { check } = await import('./backend.js');
  try {
    const r = await check({ id: d.id, ...d.data });
    setIssues(r.issues);
    emit('log', { src: 'check', level: r.issues.length ? 'warn' : 'ok', text: r.issues.length ? `${d.id}: замечаний ${r.issues.length}` : `${d.id}: ошибок нет` });
    for (const i of r.issues) emit('log', { src: 'check', level: 'warn', text: `нода ${i.node}: ${i.message}` });
  } catch (e) { emit('log', { src: 'check', level: 'error', text: `проверка: ${e.message} (сервер запущен?)` }); }
}
function setIssues(list) {
  issues = new Map();
  for (const i of list || []) issues.set(i.node, [...(issues.get(i.node) || []), i.message]);
  draw();
}
export const issuesOf = id => issues.get(id) || [];

export function graphKeys(e) {
  if (activeView() !== 'graph' || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return false;
  const k = e.key.toLowerCase();
  if (e.key === 'Delete' || e.key === 'Backspace') return deleteSel();
  if (k === 'f' && !e.ctrlKey) { fit(); return true; }
  if (k === 'm' && !e.ctrlKey && selNode()) { toggleMute(selNode()); return true; }
  if (e.ctrlKey && k === 'd' && selNode()) { duplicate(); return true; }
  if (e.ctrlKey && k === 'c' && selNode()) { clip = structuredClone(cur().data.nodes.find(n => n.id === selNode())); return true; }
  if (k === ' ' || k === 'tab') { const r = cv.getBoundingClientRect(); searchBox({ clientX: r.left + lastMouse.x, clientY: r.top + lastMouse.y }, toWorld(lastMouse)); return true; }
  return false;
}

const redraw = debounce(draw, 16);

export function initGraph() {
  on('project', build);
  on('nodes', build);
  on('current', k => { if (k === 'workflow') build(); });
  on('change', e => { if (!e.kind || e.kind === 'workflow') { if (e.created || e.removed) build(); else draw(); } });
  on('select', () => draw());
  for (const ev of ['run-start', 'run-node', 'run-progress', 'run-output', 'run-error', 'run-done']) on(ev, redraw);
  on('run-stream', redraw);
  on('run-preview', redraw);
  on('models', redraw);
  on('magic', redraw);
  // сервер поднялся после окна — неудачные загрузки снова попадут в очередь (битые из кеша уже удалены)
  on('server', s => { if (!s.running) return; imgRetry.clear(); setTimeout(draw, 500); });
  // чекпоинт / LoRA / VAE — сразу своим загрузчиком, остальное — «Library Model»
  const LOADER = { checkpoints: ['sd.checkpoint', 'ckpt_name'], loras: ['sd.lora', 'lora_name'], vae: ['sd.vae', 'vae_name'] };
  on('library-insert', it => {
    showView('graph');
    requestAnimationFrame(() => {
      if (!cur()) return;
      const [type, key] = LOADER[it.cat] || [];
      if (type && defs()[type]) {
        const triggers = it.cat === 'loras' && type === 'sd.lora' && it.trained?.length ? it.trained : null;
        addNode(type, null, { [key]: it.name }, { triggers });
      } else addNode('library.model', null, { cat: it.cat, name: it.name });
    });
  });
  on('change', e => { const d = cur(); if (S.server.running && d && (!e.kind || e.kind === 'workflow')) for (const pid of providersUsed(d)) if (!S.models[pid]) getModels(pid); });
  on('run-issues', r => { if (r.wf === S.current.workflow) setIssues(r.issues); });
  on('open-workflow', id => { if (!S.docs.workflow.has(id)) return; S.current.workflow = id; emit('current', 'workflow'); showView('graph'); select({ kind: 'workflow', doc: id, id }); });
  addEventListener('view', e => { if (e.detail === 'graph') requestAnimationFrame(draw); });
  addEventListener('pointerdown', e => { if (float && !float.contains(e.target)) closeFloat(); });
  addEventListener('paste', onPaste);
}
