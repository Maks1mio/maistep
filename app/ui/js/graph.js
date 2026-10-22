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
import { fileUrl, queuePrompt, upload, getModels, modelMeta } from './backend.js';
import { modelPicker } from './modelpick.js';
import { libraryPicker } from './library.js';
import { comfyWorkflowPicker } from './comfybridge.js';

const NW = 280, HEAD = 26, ROW = 22, PAD = 8, PREV_MAX = 220;
export const TYPE_COLOR = { STRING: '#8bc78b', INT: '#7fb4e0', FLOAT: '#7fb4e0', BOOLEAN: '#e0a35f', COMBO: '#c9a0dc', IMAGE: '#64b5f6', JSON: '#f2c46b', '*': '#b5b8c0' };
const CAT_COLOR = { 'Значения': '#3b6e4a', 'Текст': '#3d5f8a', 'JSON': '#8a6a2e', 'Логика': '#5c4a8a', 'AI': '#8a3d6a', 'Картинки': '#2e6f86', 'Файлы': '#5a5f68', 'Вывод': '#7a4a2e' };
const catColor = cat => CAT_COLOR[cat] || `hsl(${[...String(cat)].reduce((a, c) => a + c.charCodeAt(0), 0) % 360} 35% 34%)`;
const tcol = t => TYPE_COLOR[t] || '#b5b8c0';

let cv = null, wrap = null, view = { x: 40, y: 20, z: 1 }, linking = null, hover = null, issues = new Map(), clip = null;
const views = new Map();
const imgs = new Map(); // url → Image

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
  const pTop = wTop + widgets.length * ROW + (widgets.length ? 4 : 0);
  const pv = previewOf(n);
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
  return { def, pins, widgets, outs, slots, w, top, wTop, pTop, pv, ph, h: hgt, inPos, outPos };
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

// превью результата: { kind: 'text'|'image'|'error'|'stream', text, images, h }
function previewOf(n) {
  const st = S.run?.wf === S.current.workflow && S.run.stream[n.id];
  if (st) return { kind: 'stream', text: st, h: lineCount(st) * 14 + 10 };
  const o = outputsOf(n.id);
  if (!o) return null;
  if (o._error) return { kind: 'error', text: o._error.split('\n').slice(0, 6).join('\n'), h: Math.min(6, lineCount(o._error)) * 14 + 10 };
  const images = [...(o._ui?.images || []), ...(defs()[n.type]?.output ? Object.values(o).filter(v => v?.image).map(v => v.image) : [])];
  if (images.length) return { kind: 'image', images: [...new Set(images)], h: 200 };
  const text = o._ui?.text ?? Object.values(o).find(v => v?.text != null)?.text;
  if (text != null && (defs()[n.type]?.output || n.preview !== false)) return { kind: 'text', text: String(text), h: lineCount(text) * 14 + 10 };
  return null;
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
  if (!im) { im = new Image(); im.onload = () => draw(); im.src = url; imgs.set(url, im); }
  return im;
}

// ---------- отрисовка ----------
export function draw() {
  const d = cur();
  if (!cv || !wrap.isConnected) return;
  const W = wrap.clientWidth, H = wrap.clientHeight, dpr = devicePixelRatio || 1;
  if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.fillStyle = '#18191c'; c.fillRect(0, 0, W, H);
  const g = 20 * view.z;
  c.fillStyle = '#2a2c31';
  if (g > 6) for (let x = view.x % g; x < W; x += g) for (let y = view.y % g; y < H; y += g) c.fillRect(x, y, 1.2, 1.2);
  if (!d) return;
  c.save();
  c.translate(view.x, view.y); c.scale(view.z, view.z);
  const L = new Map(d.data.nodes.map(n => [n.id, layout(n, d)]));
  const byId = new Map(d.data.nodes.map(n => [n.id, n]));
  // связи
  d.data.links.forEach((l, i) => {
    const a = L.get(l.from), b = L.get(l.to);
    if (!a || !b) return;
    const p = a.outPos[l.out], q = b.inPos[l.in];
    if (!p || !q) return;
    const t = a.outs.find(o => o.name === l.out)?.type;
    const muted = byId.get(l.from).mode === 'mute' || byId.get(l.to).mode === 'mute';
    c.globalAlpha = muted ? 0.35 : 1;
    c.strokeStyle = i === selLink() ? '#ffd24a' : tcol(t);
    c.lineWidth = i === selLink() ? 3.5 : 2.2;
    curve(c, p, q);
    c.globalAlpha = 1;
  });
  if (linking) {
    c.strokeStyle = tcol(linking.type); c.lineWidth = 2.2; c.setLineDash([6, 4]);
    linking.reverse ? curve(c, linking.to, linking.from) : curve(c, linking.from, linking.to);
    c.setLineDash([]);
  }
  for (const n of d.data.nodes) drawNode(c, n, L.get(n.id));
  c.restore();
  c.fillStyle = '#6c707a'; c.font = '11px Segoe UI';
  const run = S.run?.wf === d.id ? ` · выполняется ${S.run.node || '…'}` : '';
  c.fillText(`${d.id} · нод ${d.data.nodes.length} · связей ${d.data.links.length} · ${Math.round(view.z * 100)}%${run}`, 10, H - 10);
  if (!d.data.nodes.length) {
    c.fillStyle = '#80848e'; c.font = '14px Segoe UI'; c.textAlign = 'center';
    c.fillText('Двойной щелчок — добавить ноду · или перетащите из палитры слева', W / 2, H / 2);
    c.textAlign = 'left';
  }
}

function drawNode(c, n, L) {
  const { def, pins, widgets, outs, w, top, wTop, pTop, pv, ph } = L;
  const sel = n.id === selNode(), bad = issues.has(n.id) || outputsOf(n.id)?._error;
  const running = S.run?.wf === S.current.workflow && S.run.node === n.id;
  const muted = n.mode === 'mute';
  c.globalAlpha = muted ? 0.45 : 1;
  c.shadowColor = '#000a'; c.shadowBlur = 12;
  c.fillStyle = '#2a2c31'; rr(c, n.x, n.y, w, L.h, 7); c.fill();
  c.shadowBlur = 0;
  c.fillStyle = def ? catColor(def.cat) : '#6a2a2a'; rr(c, n.x, n.y, w, HEAD, n.collapsed ? 7 : [7, 7, 0, 0]); c.fill();
  c.strokeStyle = running ? '#5fd38a' : bad ? '#ff5a4f' : sel ? '#ffd24a' : '#0c0d0f';
  c.lineWidth = running || bad || sel ? 2 : 1; rr(c, n.x, n.y, w, L.h, 7); c.stroke();
  // шапка
  c.fillStyle = '#fff'; c.font = 'bold 12px Segoe UI';
  const title = n.title || def?.title || n.type;
  c.fillText(clipText(c, `${n.collapsed ? '▸ ' : ''}${title}`, w - 70), n.x + 10, n.y + 17);
  c.fillStyle = '#ffffff99'; c.font = '10px Consolas'; c.textAlign = 'right';
  const o = outputsOf(n.id), t = o?._time;
  c.fillText(muted ? 'выкл' : t != null ? `${t}s` : n.id, n.x + w - 8, n.y + 17);
  c.textAlign = 'left';
  if (running && S.run.progress?.max) {
    c.fillStyle = '#5fd38a'; c.fillRect(n.x + 1, n.y + HEAD - 3, (w - 2) * clamp(S.run.progress.value / S.run.progress.max, 0, 1), 3);
  }
  if (n.collapsed) {
    for (const k in L.inPos) dot(c, L.inPos[k], tcol(def.inputs[k].type), false);
    for (const oo of outs) dot(c, L.outPos[oo.name], tcol(oo.type), true);
    c.globalAlpha = 1;
    return;
  }
  // слоты
  c.font = '11px Segoe UI';
  pins.forEach((k, i) => {
    const t = def.inputs[k].type, y = top + i * ROW + ROW / 2;
    dot(c, L.inPos[k], tcol(t), isLinkedIn(n.id, k), hover?.node === n.id && hover.in === k);
    c.fillStyle = '#c4c7ce'; c.fillText(clipText(c, k + (def.inputs[k].optional ? '' : ''), w / 2 - 20), n.x + 12, y + 4);
  });
  outs.forEach((oo, i) => {
    const y = top + i * ROW + ROW / 2;
    dot(c, L.outPos[oo.name], tcol(oo.type), true, hover?.node === n.id && hover.out === oo.name);
    c.fillStyle = '#c4c7ce'; c.textAlign = 'right'; c.fillText(clipText(c, oo.name, w / 2 - 20), n.x + w - 12, y + 4); c.textAlign = 'left';
  });
  // виджеты
  widgets.forEach((k, i) => {
    const inp = def.inputs[k], y = wTop + i * ROW;
    dot(c, L.inPos[k], tcol(inp.type), false, hover?.node === n.id && hover.in === k, 3.2);
    c.fillStyle = hover?.node === n.id && hover.widget === k ? '#3a3d45' : '#202226';
    rr(c, n.x + 10, y + 2, w - 20, ROW - 4, 9); c.fill();
    c.font = '11px Segoe UI'; c.fillStyle = '#8d919b'; c.fillText(clipText(c, k, w * 0.38), n.x + 20, y + 15);
    const v = n.props?.[k] ?? inp.default;
    let vs = inp.type === 'BOOLEAN' ? (v ? '● да' : '○ нет') : v === '' || v == null ? '—' : String(v).replace(/\n/g, ' ⏎ ');
    c.fillStyle = '#e4e6ea'; c.textAlign = 'right';
    if (inp.picker === 'library_model') {
      const cat = inp.cat || (t.n.props?.[inp.cat_input] ?? t.L.def.inputs[inp.cat_input]?.default);
      return libraryPicker(e, { cat, value: v, onPick: name => setProp(t.node, t.widget, name, false) });
    }
    if (inp.picker === 'llm_model') { const m = llmModel(n, def); if (m) vs = `${m.vision ? '👁 ' : ''}${vs}`; else if (S.models[n.props?.[inp.provider_input]]?.models?.length) c.fillStyle = '#e0a35f'; }
    c.fillText(clipText(c, vs, w * 0.55), n.x + w - (['INT', 'FLOAT', 'COMBO'].includes(inp.type) || inp.picker ? 26 : 20), y + 15);
    if (['INT', 'FLOAT'].includes(inp.type)) { c.fillStyle = '#6c707a'; c.textAlign = 'left'; c.fillText('‹', n.x + 13, y + 15); c.textAlign = 'right'; c.fillText('›', n.x + w - 14, y + 15); }
    if (inp.type === 'COMBO' || inp.picker) { c.fillStyle = '#6c707a'; c.fillText('▾', n.x + w - 14, y + 15); }
    c.textAlign = 'left';
  });
  // превью
  if (pv && ph) {
    const x = n.x + 10, y = pTop, pw = w - 20;
    c.fillStyle = pv.kind === 'error' ? '#3a1f22' : '#1d1f23'; rr(c, x, y, pw, ph, 5); c.fill();
    c.save(); c.beginPath(); c.rect(x, y, pw, ph); c.clip();
    if (pv.kind === 'image') {
      const list = pv.images.slice(0, 4), cw = pw / list.length;
      list.forEach((f, i) => {
        const im = image(fileUrl(f));
        if (!im.complete || !im.naturalWidth) return;
        const k = Math.min((cw - 4) / im.naturalWidth, (ph - 4) / im.naturalHeight);
        const iw = im.naturalWidth * k, ih = im.naturalHeight * k;
        c.drawImage(im, x + i * cw + (cw - iw) / 2, y + (ph - ih) / 2, iw, ih);
      });
    } else {
      c.font = '11px Consolas'; c.fillStyle = pv.kind === 'error' ? '#ff8a80' : pv.kind === 'stream' ? '#9fe0b4' : '#c9ccd3';
      const lines = wrapText(c, pv.text, pw - 12);
      const shown = pv.kind === 'stream' ? lines.slice(-Math.floor((ph - 8) / 14)) : lines;
      shown.forEach((ln, i) => { const yy = y + 14 + i * 14; if (yy < y + ph) c.fillText(ln, x + 6, yy); });
    }
    c.restore();
  }
  c.globalAlpha = 1;
}

function dot(c, p, color, filled, hot = false, r = 4.5) {
  c.beginPath(); c.arc(p.x, p.y, hot ? r + 2 : r, 0, 7);
  if (filled) { c.fillStyle = color; c.fill(); } else { c.fillStyle = '#2a2c31'; c.fill(); c.strokeStyle = color; c.lineWidth = 2; c.stroke(); }
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
  }
  return out;
}
function clipText(c, s, w) { s = String(s); if (c.measureText(s).width <= w) return s; while (s.length > 1 && c.measureText(`${s}…`).width > w) s = s.slice(0, -1); return `${s}…`; }
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
    if (p.x > n.x + L.w - 10 && p.y > n.y + L.h - 10) return { node: n.id, n, L, resize: true };
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
}

export function addNode(type, at, props = {}) {
  const d = cur();
  const def = defs()[type];
  if (!d || !def) return null;
  const id = uniqueId(`n${d.data.nodes.length + 1}`, d.data.nodes.map(n => n.id));
  const pos = at || toWorld({ x: wrap.clientWidth / 2 - NW / 2, y: wrap.clientHeight / 2 - 60 });
  const defaults = Object.fromEntries(Object.entries(def.inputs).filter(([, i]) => i.widget).map(([k, i]) => [k, i.default]));
  wfEdit(wf => { wf.nodes.push({ id, type, x: Math.round(pos.x / 10) * 10, y: Math.round(pos.y / 10) * 10, props: { ...defaults, ...props } }); }, { label: `нода ${def.title}` });
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
    if (inp.picker === 'library_model') {
      const cat = inp.cat || (t.n.props?.[inp.cat_input] ?? t.L.def.inputs[inp.cat_input]?.default);
      return libraryPicker(e, { cat, value: v, onPick: name => setProp(t.node, t.widget, name, false) });
    }
    if (inp.picker === 'comfy_workflow') return comfyWorkflowPicker(e, { value: v, onPick: id => setProp(t.node, t.widget, id, false) });
    if (inp.picker === 'llm_model') {
      const pid = t.n.props?.[inp.provider_input] ?? t.L.def.inputs[inp.provider_input]?.default;
      return modelPicker(e, { provider: pid, value: v, onPick: id => setProp(t.node, t.widget, id, false) });
    }
    if (['INT', 'FLOAT'].includes(inp.type)) return dragNum(e, t, inp, v);
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
  drag(ev => { const q = mouse(ev); view.x = v0.x + q.x - sp.x; view.y = v0.y + q.y - sp.y; draw(); }, () => { cv.style.cursor = ''; views.set(S.current.workflow, { ...view }); });
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
  const nh = t ? { node: t.node, in: t.in, out: t.out, widget: t.widget } : null;
  if (JSON.stringify(nh) !== JSON.stringify(hover)) {
    hover = nh;
    cv.style.cursor = t?.in || t?.out ? 'crosshair' : t?.resize ? 'nwse-resize' : t?.widget ? (['INT', 'FLOAT'].includes(t.L.def.inputs[t.widget].type) ? 'ew-resize' : 'pointer') : t ? 'move' : '';
    draw();
  }
}

function onDbl(e) {
  const p = toWorld(mouse(e)), t = hit(p);
  if (t?.widget) return inlineEdit(t);
  if (t?.head) return toggleCollapse(t.node);
  if (!t) searchBox(e, p);
}

function onWheel(e) {
  e.preventDefault();
  const sp = mouse(e), before = toWorld(sp);
  view.z = clamp(view.z * (e.deltaY < 0 ? 1.1 : 0.9), 0.2, 2.5);
  view.x = sp.x - before.x * view.z; view.y = sp.y - before.y * view.z;
  views.set(S.current.workflow, { ...view });
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
  const t = e.dataTransfer.getData('text/mai-node');
  if (t) return addNode(t, p);
  const f = e.dataTransfer.getData('text/mai-file');
  if (f) return addNode('image.load', p, { file: f });
  for (const file of e.dataTransfer.files || []) {
    try {
      const rel = await upload(file);
      if (/\.(png|jpe?g|webp|gif)$/i.test(rel)) addNode('image.load', p, { file: rel });
      else if (/\.json$/i.test(rel)) emit('log', { src: 'editor', level: 'info', text: `файл загружен: ${rel} (воркфлоу открывайте из папки workflows/)` });
      else addNode('io.read_text', p, { file: rel });
    } catch (err) { emit('log', { src: 'editor', level: 'error', text: `загрузка ${file.name}: ${err.message} (сервер запущен?)` }); }
  }
}

// ---------- вид ----------
export function fit() {
  const d = cur();
  if (!d?.data.nodes.length || !wrap) return;
  const Ls = d.data.nodes.map(n => [n, layout(n, d)]);
  const x0 = Math.min(...Ls.map(([n]) => n.x)) - 40, y0 = Math.min(...Ls.map(([n]) => n.y)) - 40;
  const x1 = Math.max(...Ls.map(([n, L]) => n.x + L.w)) + 40, y1 = Math.max(...Ls.map(([n, L]) => n.y + L.h)) + 40;
  view.z = clamp(Math.min(wrap.clientWidth / (x1 - x0), wrap.clientHeight / (y1 - y0)), 0.25, 1.2);
  view.x = (wrap.clientWidth - (x1 - x0) * view.z) / 2 - x0 * view.z;
  view.y = (wrap.clientHeight - (y1 - y0) * view.z) / 2 - y0 * view.z;
  views.set(S.current.workflow, { ...view });
  draw();
}

function palette() {
  const groups = {};
  for (const [t, def] of Object.entries(defs())) (groups[def.cat] ||= []).push([t, def]);
  const filter = h('input.pal-q', { placeholder: 'Фильтр нод…', spellcheck: false });
  const list = h('div');
  const fill = () => {
    const q = filter.value.toLowerCase();
    list.replaceChildren(...Object.entries(groups).flatMap(([cat, items]) => {
      const vis = items.filter(([t, d]) => !q || `${t} ${d.title}`.toLowerCase().includes(q));
      return vis.length ? [h('div.grp', {}, cat), ...vis.map(([t, def]) => h('div.it', {
        'data-tip': `${def.title}\n${t}${def.hint ? `\n${def.hint}` : ''}`, onclick: () => addNode(t), draggable: true,
        ondragstart: e => e.dataTransfer.setData('text/mai-node', t),
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
  if (e.ctrlKey && k === 'v' && clip) { paste(clip, toWorld(lastMouse)); return true; }
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
  on('models', redraw);
  on('library-insert', it => { showView('graph'); requestAnimationFrame(() => { if (cur()) addNode('library.model', null, { cat: it.cat, name: it.name }); }); });
  on('change', e => { const d = cur(); if (S.server.running && d && (!e.kind || e.kind === 'workflow')) for (const pid of providersUsed(d)) if (!S.models[pid]) getModels(pid); });
  on('run-issues', r => { if (r.wf === S.current.workflow) setIssues(r.issues); });
  on('open-workflow', id => { if (!S.docs.workflow.has(id)) return; S.current.workflow = id; emit('current', 'workflow'); showView('graph'); select({ kind: 'workflow', doc: id, id }); });
  addEventListener('view', e => { if (e.detail === 'graph') requestAnimationFrame(draw); });
  addEventListener('pointerdown', e => { if (float && !float.contains(e.target)) closeFloat(); });
}
