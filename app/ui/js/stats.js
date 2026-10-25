// Нагрузка системы в строке состояния (справа): CPU, RAM, GPU с температурой, VRAM — компактно, красным то, что
// упирается в лимит. Данные — GET /api/stats раз в секунду, пока сегмент виден или открыт поповер.
// Щелчок — поповер: шкалы и графики за 2 минуты, память maistep/torch и «Лимиты» ползунками (запас RAM, потолок
// VRAM, нагрузка GPU, предел размера — sysmon.py), сохраняются, когда ползунок отпущен. Логи и отчёт после сбоя — logsReport() (logs.py).
import { h } from './util.js';
import { S, on, emit } from './store.js';
import { api } from './backend.js';
import { invoke } from './api.js';
import { icon } from './icons.js';

const LS = 'maistep-stats';
const GB = 2 ** 30;
let on_ = (() => { try { return localStorage.getItem(LS) !== '0'; } catch { return true; } })();
let seg = null, pop = null, timer = 0, last = null;
const log = (level, text) => emit('log', { src: 'editor', level, text });

export const statsShown = () => on_;
export function toggleStats() {
  on_ = !on_;
  try { localStorage.setItem(LS, on_ ? '1' : '0'); } catch {}
  tick();
}

const gb = n => (n / GB).toFixed(1);
const pct = (a, b) => (b ? (100 * a) / b : 0);
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim() || '#888';

// что упирается в лимит
function flags(s) {
  const lim = s.limits || {}, g = s.gpu;
  const cap = lim.vram_max_pct > 0 && lim.vram_max_pct < 100 ? lim.vram_max_pct : 100;
  return {
    ram: lim.ram_reserve_gb > 0 && s.ram_total - s.ram_used < lim.ram_reserve_gb * GB * 1.5,
    vram: !!g && pct(g.vram_used, g.vram_total) >= cap - 3,
    temp: g?.temp >= 85,
    cap,
  };
}

// Каждую секунду меняются только тексты, ширина шкал и графики — элементы создаются один раз
// (пересборка под курсором мигала и сбивала тултип и наведение).
const set = (el, t) => { if (el.textContent !== t) el.textContent = t; };

// ---------- сегмент строки состояния ----------
let sp = null; // части сегмента; пересобираются, только если появилась/пропала видеокарта
function drawSeg(s) {
  const g = s.gpu, f = flags(s);
  if (!sp || sp.gpu !== !!g) {
    const it = l => { const v = h('span'); return { e: h('span.sst-i', {}, h('b', {}, l), v), v }; };
    sp = { gpu: !!g, cpu: it('CPU'), ram: it('RAM'), g: g ? it('GPU') : null, temp: h('i'), vram: g ? it('VRAM') : null };
    sp.g?.e.append(sp.temp);
    seg.replaceChildren(...[sp.cpu, sp.ram, sp.g, sp.vram].filter(Boolean).map(x => x.e));
  }
  set(sp.cpu.v, s.cpu != null ? `${Math.round(s.cpu)}%` : '—');
  set(sp.ram.v, `${gb(s.ram_used)}/${Math.round(s.ram_total / GB)}`);
  sp.ram.e.classList.toggle('bad', f.ram);
  if (g) {
    set(sp.g.v, g.util != null ? `${Math.round(g.util)}%` : '—');
    set(sp.temp, g.temp != null ? ` ${Math.round(g.temp)}°` : '');
    sp.temp.classList.toggle('hot', f.temp);
    set(sp.vram.v, `${gb(g.vram_used)}/${Math.round(g.vram_total / GB)}`);
    sp.vram.e.classList.toggle('bad', f.vram);
  }
}

// ---------- поповер ----------
// строка: точка цвета, название, значение (+ доп. текст), шкала с меткой лимита (mark — доля 0..1)
function metric(name, color) {
  const v = h('span'), x = h('span.dim'), fill = h('i', { style: { background: color } }), mark = h('u');
  const m = h('div.sst-m', {}, fill, mark);
  const e = h('div.sst-row', {}, h('div.sst-hd', {}, h('span.dot', { style: { background: color } }), h('b', {}, name), h('span.v', {}, v, x)), m);
  return {
    e,
    upd(value, frac, { extra = '', extraBad = false, mark: mk = 0, bad = false } = {}) {
      set(v, value); set(x, extra);
      v.parentNode.classList.toggle('bad', bad); x.classList.toggle('bad', extraBad);
      m.classList.toggle('bad', bad);
      fill.style.width = `${Math.min(100, Math.max(0, frac * 100)).toFixed(1)}%`;
      mark.style.display = mk > 0 && mk < 1 ? '' : 'none';
      if (mk > 0 && mk < 1) mark.style.left = `${(mk * 100).toFixed(1)}%`;
    },
  };
}

// график последних значений (0..max) с заливкой — на одном и том же холсте
function spark(color) {
  const w = 248, ht = 28, d = devicePixelRatio || 1;
  const c = h('canvas.sst-spark', { width: w * d, height: ht * d });
  const g = c.getContext('2d');
  c.upd = (values, max) => {
    const pts = values.slice(-120);
    g.setTransform(d, 0, 0, d, 0, 0);
    g.clearRect(0, 0, w, ht);
    if (pts.filter(v => v != null).length < 2) return;
    const x0 = 120 - pts.length;
    g.beginPath();
    pts.forEach((v, i) => { const x = ((i + x0) / 119) * w, y = ht - 1 - Math.min(1, (v ?? 0) / max) * (ht - 3); i ? g.lineTo(x, y) : g.moveTo(x, y); });
    g.globalAlpha = 1; g.strokeStyle = color; g.lineWidth = 1.5; g.stroke();
    g.lineTo(w, ht); g.lineTo((x0 / 119) * w, ht); g.closePath();
    g.globalAlpha = 0.15; g.fillStyle = color; g.fill();
  };
  return c;
}

let mp = null; // части поповера
function drawMetrics(s) {
  const box = pop?.querySelector('.sst-metrics');
  if (!box) return;
  const g = s.gpu, f = flags(s), lim = s.limits || {}, hist = s.history || [];
  if (!mp || mp.box !== box || mp.gpu !== !!g) {
    const C = { cpu: css('--p-yellow-6'), ram: '#c58af9', gpu: css('--p-green-7'), vram: css('--p-blue-8') };
    mp = { box, gpu: !!g, cpu: metric('CPU', C.cpu), ram: metric('RAM', C.ram), ramS: spark(C.ram),
      g: metric('GPU', C.gpu), gS: spark(C.gpu), vram: metric('VRAM', C.vram), proc: h('b'), torch: h('b'), torchL: h('span', {}, 'torch') };
    box.replaceChildren(mp.cpu.e, mp.ram.e, mp.ramS,
      ...(g ? [mp.g.e, mp.gS, mp.vram.e] : [h('div.sst-none', {}, 'GPU — нет данных')]),
      h('div.sst-proc', {}, h('span', {}, 'maistep'), mp.proc, mp.torchL, mp.torch));
  }
  mp.cpu.upd(s.cpu != null ? `${Math.round(s.cpu)}%` : '—', (s.cpu || 0) / 100);
  mp.ram.upd(`${gb(s.ram_used)} / ${gb(s.ram_total)} ГБ`, pct(s.ram_used, s.ram_total) / 100,
    { bad: f.ram, mark: lim.ram_reserve_gb > 0 ? 1 - (lim.ram_reserve_gb * GB) / s.ram_total : 0 });
  mp.ramS.upd(hist.map(x => x.ram_used), s.ram_total);
  if (g) {
    mp.g.upd(g.util != null ? `${Math.round(g.util)}%` : '—', (g.util || 0) / 100,
      { extra: g.temp != null ? ` · ${Math.round(g.temp)}°C` : '', extraBad: f.temp, mark: lim.gpu_load < 100 ? lim.gpu_load / 100 : 0 });
    mp.gS.upd(hist.map(x => x.gpu), 100);
    mp.vram.upd(`${gb(g.vram_used)} / ${gb(g.vram_total)} ГБ`, pct(g.vram_used, g.vram_total) / 100,
      { bad: f.vram, mark: f.cap < 100 ? f.cap / 100 : 0 });
  }
  set(mp.proc, `${gb(s.proc_ram)} ГБ`);
  set(mp.torch, s.torch ? `${gb(s.torch.alloc)} / ${gb(s.torch.reserved)} ГБ` : '');
  mp.torchL.style.display = mp.torch.style.display = s.torch ? '' : 'none';
}

// ползунок лимита: подпись, значение справа, подсказка; 0 (или max у нагрузки) — «выкл»
const LIMITS = [
  { key: 'ram_reserve_gb', label: 'Запас RAM', min: 0, max: () => Math.max(4, Math.floor((last?.ram_total || 64 * GB) / GB / 2)), step: 0.5,
    fmt: v => (v ? `${v} ГБ` : 'не следить'), tip: 'Меньше свободной памяти — запуск остановится, система не зависнет' },
  { key: 'vram_max_pct', label: 'Потолок VRAM', min: 0, max: () => 100, step: 5,
    fmt: v => (v && v < 100 ? `${v}%` : 'без потолка'), tip: 'Выше — повтор тайлами вместо переполнения видеопамяти в RAM' },
  { key: 'gpu_load', label: 'Нагрузка GPU', min: 10, max: () => 100, step: 5,
    fmt: v => (v < 100 ? `${v}%` : 'полная'), tip: 'Паузы между шагами: тише, холоднее, медленнее' },
  { key: 'max_mp', label: 'Предел размера', min: 0, max: () => 16, step: 0.1,
    fmt: v => (v ? `${v} МП` : 'без предела'), tip: '1920×1080 = 2.1 МП, SDXL 1024×1024 = 1.0 МП' },
];

export function limitsBox(cur) {
  const vals = { ...cur };
  // сохраняется, когда ползунок отпущен (change); пока тянут — только подпись и заливка
  const save = async () => {
    try { const saved = await api('/api/limits', vals); if (last) last.limits = saved; tick(); } catch (e) { log('error', `лимиты: ${e.message}`); }
  };
  return h('div.sst-limits', {}, LIMITS.map(L => {
    const out = h('span.v', {}, L.fmt(vals[L.key]));
    const r = h('input', { type: 'range', min: L.min, max: Math.max(L.max(), vals[L.key] || 0), step: L.step, value: vals[L.key] ?? L.min });
    const paint = () => r.style.setProperty('--f', `${(100 * (r.value - r.min)) / (r.max - r.min || 1)}%`);
    r.addEventListener('input', () => { vals[L.key] = Number(r.value); out.textContent = L.fmt(vals[L.key]); paint(); });
    r.addEventListener('change', save);
    paint();
    return h('div.sst-lim', { 'data-tip': L.tip }, h('div.sst-hd', {}, h('span', {}, L.label), out), r);
  }));
}

function closePop() { pop?.remove(); pop = null; seg?.classList.remove('open'); }

export async function limitsDialog() {
  if (pop) { closePop(); return; }
  let cur = {};
  try { cur = await api('/api/limits'); } catch (e) { log('error', `лимиты: ${e.message}`); return; }
  const item = (ic, label, fn) => h('div.it', { onclick: () => { closePop(); fn(); } }, icon(ic, { size: 16 }), h('span', {}, label));
  pop = h('div.runpop.sst-pop', { onclick: e => e.stopPropagation(), onpointerdown: e => e.stopPropagation() },
    h('div.hd', {}, h('b', {}, 'Нагрузка системы'), h('span.dim', {}, 'за 2 минуты')),
    h('div.sst-metrics'),
    h('hr'),
    h('div.hd', {}, h('b', {}, 'Лимиты'), h('span.dim', {}, 'применяются при отпускании')),
    limitsBox(cur),
    h('hr'),
    item('folder', 'Открыть папку логов', openLogs),
    item('general/export', 'Собрать отчёт для отправки', logsReport));
  document.body.append(pop);
  seg.classList.add('open');
  if (last) drawMetrics(last);
  placePop();
  tick();
}

function placePop() {
  if (!pop) return;
  const r = (seg.offsetWidth ? seg : document.getElementById('statusbar')).getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(innerWidth - pop.offsetWidth - 4, r.right - pop.offsetWidth))}px`;
  pop.style.top = `${Math.max(4, r.top - pop.offsetHeight - 6)}px`;
}

// Один цикл опроса: вызов во время запроса не запускает второй, а лишь просит повторить сразу после него.
// Сбой запроса не прячет сегмент — остаются последние значения (приглушённые); прячется после 5 сбоев подряд.
let busy = false, again = false, fails = 0;
async function tick() {
  if (busy) { again = true; return; }
  clearTimeout(timer);
  busy = true; again = false;
  if (S.server.running && (on_ || pop)) {
    try {
      const s = await api('/api/stats');
      if (s.error || !s.ram_total) throw new Error(s.error);
      last = s; fails = 0;
      if (on_) drawSeg(last);
      drawMetrics(last);
      placePop();
    } catch { fails++; }
  } else if (!S.server.running) { closePop(); fails = 0; }
  seg.style.display = on_ && S.server.running && last && fails < 5 ? '' : 'none';
  seg.classList.toggle('stale', fails > 0);
  busy = false;
  timer = setTimeout(tick, again ? 0 : 1000);
}

// zip с логами и сведениями о системе — показать в проводнике, чтобы сразу отправить
export async function logsReport() {
  try {
    const { path } = await api('/api/logs/report', {});
    log('ok', `отчёт собран: ${path} — отправьте этот файл`);
    invoke('fs_reveal', { path }).catch(() => {});
  } catch (e) { log('error', `отчёт: ${e.message}`); }
}

export async function openLogs() {
  try {
    const { dir } = await api('/api/logs');
    await invoke('fs_reveal', { path: dir });
  } catch (e) { log('error', `логи: ${e.message || e}`); }
}

export function initStats() {
  seg = h('div#st-stats', { 'data-tip': 'Нагрузка системы\nЩелчок — подробности и лимиты\nCtrl+Shift+M — скрыть или показать', onclick: e => { e.stopPropagation(); limitsDialog(); } });
  seg.style.display = 'none';
  document.getElementById('st-right').before(seg);
  addEventListener('pointerdown', e => { if (pop && !pop.contains(e.target) && !seg.contains(e.target)) closePop(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });
  addEventListener('resize', placePop);
  on('server', () => tick());
  tick();
}
