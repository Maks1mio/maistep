// Компоненты UI Kit для всего редактора: клавиши/шорткаты, поле поиска, ON/OFF, комбо-бокс со списком,
// тултипы New UI вместо системных title и подсказки Got It. Разметка и стили — css/uikit.css (.ui-*).
import { h } from './util.js';
import { icon, ic } from './icons.js';

// ---------- клавиши ----------
// 'Ctrl+Shift+F5' → [Ctrl][Shift][F5]
export const kbd = combo => h('span.ui-keys', {}, String(combo).split('+').filter(Boolean).map(k => h('kbd.ui-key', {}, k)));

// ---------- поле поиска ----------
export function search({ placeholder = 'Поиск', value = '', onInput, dark = true, bare = false, id } = {}) {
  const inp = h('input', { type: 'text', placeholder, value, spellcheck: false, id });
  const el = h(`div.ui-search${bare ? '.bare' : ''}${value ? '.has-text' : ''}`, {},
    icon('search', { size: 16, dark }), inp,
    h('span.clr', { title: 'Очистить', onclick: () => { inp.value = ''; inp.dispatchEvent(new Event('input')); inp.focus(); } }, icon('closeSmall', { size: 16, dark })));
  inp.addEventListener('input', () => { el.classList.toggle('has-text', !!inp.value); onInput?.(inp.value); });
  inp.addEventListener('keydown', e => { if (e.key === 'Escape' && inp.value) { e.stopPropagation(); inp.value = ''; inp.dispatchEvent(new Event('input')); } });
  el.input = inp;
  return el;
}

// оборачивает готовый <input> (из index.html) в .ui-search
export function enhanceSearch(inp, { dark = true } = {}) {
  const el = h('div.ui-search', {}, icon('search', { size: 16, dark }));
  inp.replaceWith(el);
  el.append(inp, h('span.clr', { title: 'Очистить', onclick: () => { inp.value = ''; inp.dispatchEvent(new Event('input')); inp.focus(); } }, icon('closeSmall', { size: 16, dark })));
  el.className = `ui-search ${inp.className}`;
  inp.className = '';
  const sync = () => el.classList.toggle('has-text', !!inp.value);
  inp.addEventListener('input', sync);
  sync();
  return el;
}

// ---------- ON/OFF ----------
export function onOff(on, onChange, { disabled = false } = {}) {
  const el = h(`span.ui-onoff${on ? '' : '.off'}${disabled ? '.is-disabled' : ''}`, { role: 'switch' });
  if (!disabled) el.addEventListener('click', e => { e.stopPropagation(); el.classList.toggle('off'); onChange?.(!el.classList.contains('off')); });
  return el;
}

// ---------- выпадающий список (замена <select>) ----------
// dropdown(value, options, onChange, opts) — кнопка .ui-dd + попап .ui-ddpop (в body, поверх панелей).
// options: v | [v, label] | [v, label, icon] | { value, label, sec, icon, hint, dim } | '-' (разделитель); sec — вторичный текст.
// opts: empty — пустой пункт сверху (onChange(undefined)), placeholder — подпись при пустом значении,
//   action — «меню действия» (после выбора подпись снова placeholder), icon — иконка на кнопке,
//   link — вид «Label: Text ⌄» без рамки (тулбары), label — префикс, width, dark, filter (по умолчанию от 15 пунктов).
// Элемент ведёт себя как <select>: .value (get/set), .disabled, событие 'change'.
const normOpt = o => {
  if (o === '-' || o?.sep) return { sep: true };
  if (Array.isArray(o)) return { value: String(o[0]), label: String(o[1] ?? o[0]), icon: o[2] };
  if (o && typeof o === 'object') return { ...o, value: String(o.value), label: String(o.label ?? o.value) };
  return { value: String(o), label: String(o) };
};
let openDd = null;
export function dropdown(value, options, onChange, opts = {}) {
  const { dark = true } = opts;
  let items = options.map(normOpt);
  if (opts.empty !== undefined) items = [{ value: '', label: String(opts.empty), dim: true }, ...items];
  let cur = value == null ? '' : String(value);
  const ic = h('span.ic');
  const txt = h('span.t');
  const el = h(`button.ui-dd${opts.link ? '.link' : ''}${opts.action ? '.action' : ''}`, { type: 'button', style: opts.width ? { width: `${opts.width}px` } : {} },
    opts.icon ? icon(opts.icon, { size: 16, dark }) : null, ic, opts.label ? h('span.pre', {}, `${opts.label}: `) : null, txt, h('span.chev', {}, icon('down', { size: 16, dark })));
  const paint = () => {
    const it = items.find(x => !x.sep && x.value === cur);
    const show = opts.action || !it ? null : it;
    txt.replaceChildren(show ? show.label : (opts.placeholder ?? (cur || '')), show?.sec ? h('span.sec', {}, show.sec) : '');
    txt.classList.toggle('ph', !show || !!show.dim);
    ic.replaceChildren(show?.icon ? icon(show.icon, { size: 16, dark }) : '');
    ic.style.display = show?.icon ? '' : 'none';
  };
  Object.defineProperty(el, 'value', { get: () => cur, set: v => { cur = v == null ? '' : String(v); paint(); } });
  el.setOptions = list => { items = list.map(normOpt); if (opts.empty !== undefined) items.unshift({ value: '', label: String(opts.empty), dim: true }); paint(); };
  const pick = v => {
    close();
    if (!opts.action) { cur = v; paint(); }
    el.dispatchEvent(new Event('change'));
    onChange?.(v === '' && opts.empty !== undefined ? undefined : v);
    el.focus();
  };

  let pop = null, list = null, active = -1, q = '';
  const visible = () => items.filter(x => x.sep ? !q : (x.label + ' ' + x.value).toLowerCase().includes(q));
  const drawList = () => {
    const vis = visible();
    const withIc = vis.some(x => x.icon);
    list.replaceChildren(...vis.map((x, i) => x.sep ? h('div.sep') : h(`div.opt${x.value === cur ? '.cur' : ''}${i === active ? '.act' : ''}${x.dim ? '.dim' : ''}`, {
      onpointerenter: () => { active = i; mark(); },
      onclick: () => pick(x.value),
    }, withIc ? h('span.ic', {}, x.icon ? icon(x.icon, { size: 16, dark }) : null) : null, h('span.l', {}, x.label, x.sec ? h('span.sec', {}, x.sec) : null), x.hint ? h('span.hint', {}, x.hint) : null)));
    if (!vis.some(x => !x.sep)) list.append(h('div.none', {}, 'Ничего не найдено'));
  };
  const mark = () => [...list.children].forEach((c, i) => c.classList.toggle('act', i === active));
  const move = d => {
    const vis = visible();
    for (let i = active + d, n = 0; n < vis.length; i += d, n++) {
      const j = (i + vis.length) % vis.length;
      if (!vis[j].sep) { active = j; mark(); list.children[j]?.scrollIntoView({ block: 'nearest' }); return; }
    }
  };
  const outside = e => { if (pop && !pop.contains(e.target) && !el.contains(e.target)) close(); };
  const onScroll = e => { if (pop && !pop.contains(e.target)) close(); };
  function close() {
    if (!pop) return;
    pop.remove(); pop = null; openDd = null; el.classList.remove('is-open');
    removeEventListener('pointerdown', outside, true);
    removeEventListener('scroll', onScroll, true);
    removeEventListener('resize', close);
  }
  const open = () => {
    if (el.disabled) return;
    openDd?.();
    q = '';
    const vis = visible();
    active = vis.findIndex(x => !x.sep && x.value === cur);
    list = h('div.list');
    const flt = (opts.filter ?? items.length >= 15) ? h('input.flt', { placeholder: 'Поиск…', spellcheck: false, oninput: e => { q = e.target.value.toLowerCase(); active = visible().findIndex(x => !x.sep); drawList(); } }) : null;
    pop = h('div.ui-ddpop', { onkeydown: key }, flt ? h('div.fw', {}, icon('search', { size: 16, dark }), flt) : null, list);
    drawList();
    document.body.append(pop);
    const r = el.getBoundingClientRect();
    pop.style.minWidth = `${Math.max(r.width, 120)}px`;
    const below = innerHeight - r.bottom - 8, above = r.top - 8;
    const hgt = pop.offsetHeight;
    const down = hgt <= below || below >= above;
    pop.style.maxHeight = `${Math.max(120, down ? below : above)}px`;
    pop.style.left = `${Math.max(4, Math.min(innerWidth - pop.offsetWidth - 4, r.left))}px`;
    pop.style.top = down ? `${r.bottom + 4}px` : `${Math.max(4, r.top - 4 - Math.min(hgt, above))}px`;
    list.children[active]?.scrollIntoView({ block: 'center' });
    el.classList.add('is-open');
    openDd = close;
    addEventListener('pointerdown', outside, true);
    addEventListener('scroll', onScroll, true);
    addEventListener('resize', close);
    (flt || el).focus();
  };
  function key(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); const x = visible()[active]; if (x && !x.sep) pick(x.value); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); el.focus(); }
    else if (e.key === 'Tab') close();
    else return;
    e.stopPropagation();
  }
  el.addEventListener('click', () => (pop ? close() : open()));
  el.addEventListener('keydown', e => {
    if (pop) return key(e);
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); e.stopPropagation(); open(); }
  });
  paint();
  return el;
}

// ---------- подсказки у текстового поля (замена <datalist>) ----------
// autocomplete(input, source): source — id <datalist> (данные читаются при открытии), массив или функция → массив.
// Поле остаётся тем же <input>: при вводе всплывают совпадения, шеврон справа (или Alt+↓) показывает весь список.
// opts.preview(v) → url картинки для превью при наведении; opts.onAll() — своё действие шеврона (например, выборщик).
export function autocomplete(input, source, opts = {}) {
  const values = () => {
    const v = typeof source === 'function' ? source() : typeof source === 'string'
      ? [...(document.getElementById(source)?.options || [])].map(o => o.value) : source;
    return [...new Set((v || []).map(String))];
  };
  input.classList.add('ui-ac');
  input.autocomplete = 'off';
  let pop = null, list = [], active = -1;
  const close = () => { pop?.remove(); pop = null; removeEventListener('pointerdown', outside, true); removeEventListener('scroll', onScroll, true); };
  const outside = e => { if (pop && !pop.contains(e.target) && e.target !== input) close(); };
  const onScroll = e => { if (pop && !pop.contains(e.target)) close(); };
  const pick = v => { input.value = v; close(); input.dispatchEvent(new Event('input')); input.dispatchEvent(new Event('change')); input.focus(); };
  const mark = () => [...pop.querySelectorAll('.opt')].forEach((o, i) => o.classList.toggle('act', i === active));
  const open = all => {
    const q = all ? '' : input.value.trim().toLowerCase();
    const vs = values();
    // сначала начинающиеся с запроса, потом содержащие; не больше 300
    list = q ? [...vs.filter(v => v.toLowerCase().startsWith(q)), ...vs.filter(v => !v.toLowerCase().startsWith(q) && v.toLowerCase().includes(q))] : vs;
    list = list.slice(0, 300);
    if (!list.length || (list.length === 1 && list[0] === input.value)) return close();
    if (!pop) {
      pop = h('div.ui-ddpop.ac', { onpointerdown: e => e.preventDefault() });
      document.body.append(pop);
      addEventListener('pointerdown', outside, true);
      addEventListener('scroll', onScroll, true);
    }
    active = list.indexOf(input.value);
    const hl = s => { const i = q ? s.toLowerCase().indexOf(q) : -1; return i < 0 ? s : [s.slice(0, i), h('b', {}, s.slice(i, i + q.length)), s.slice(i + q.length)]; };
    pop.replaceChildren(h('div.list', {}, list.map((v, i) => h(`div.opt${v === input.value ? '.cur' : ''}`, { onpointerenter: () => { active = i; mark(); }, onclick: () => pick(v), 'data-tip-img': opts.preview?.(v), 'data-tip': opts.preview ? v : undefined }, h('span.l', {}, hl(v))))));
    mark();
    const r = input.getBoundingClientRect(), below = innerHeight - r.bottom - 8;
    pop.style.minWidth = `${r.width}px`;
    pop.style.maxHeight = `${Math.max(140, Math.min(320, below > 160 ? below : r.top - 8))}px`;
    pop.style.left = `${Math.max(4, Math.min(innerWidth - pop.offsetWidth - 4, r.left))}px`;
    pop.style.top = below > 160 ? `${r.bottom + 4}px` : `${Math.max(4, r.top - 4 - pop.offsetHeight)}px`;
    if (active >= 0) pop.querySelectorAll('.opt')[active]?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', e => { if (e.isTrusted) open(false); });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 120));
  input.addEventListener('pointerdown', e => { // шеврон — правые 22 px поля
    const r = input.getBoundingClientRect();
    if (e.clientX > r.right - 22 && !input.disabled) { e.preventDefault(); input.focus(); if (opts.onAll) { close(); opts.onAll(); } else pop ? close() : open(true); }
  });
  input.addEventListener('keydown', e => {
    if (!pop) { if (e.key === 'ArrowDown' && (e.altKey || !input.value)) { e.preventDefault(); opts.onAll ? opts.onAll() : open(true); } return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(list.length - 1, active + 1); mark(); pop.querySelectorAll('.opt')[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); pop.querySelectorAll('.opt')[active]?.scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(list[active]); }
    else if (e.key === 'Escape') { e.stopPropagation(); close(); }
    else if (e.key === 'Tab') close();
  });
  return input;
}

// старое имя из витрины: комбо-бокс со списком чисел/строк
export const combo = (value, options, onChange, { width, dark = true } = {}) => dropdown(value, options, onChange, { width, dark, filter: false });

// ---------- тултип ----------
// title вида «Сохранить всё (Ctrl+S)» → «Сохранить всё» + шорткат; многострочный → заголовок + текст.
const SC_RE = /\s*\(((?:Ctrl|Shift|Alt|F\d+|Del|Space|Esc|Enter|Tab)[^)]*)\)\s*$/;
export function tipContent(text, { shortcut, link, img } = {}) {
  let t = String(text || '').trim();
  const m = !shortcut && t.match(SC_RE);
  if (m) { shortcut = m[1]; t = t.slice(0, m.index); }
  const lines = t.split('\n');
  if (lines.length > 1 || link || img) {
    return h(`div.ui-tip.rich${img ? '.img' : ''}`, {},
      img ? h('div.pv', {}, h('img', { src: img, alt: '' })) : null,
      h('div.hd', {}, lines[0]),
      lines.length > 1 ? h('div.tx', {}, lines.slice(1).join('\n')) : null,
      shortcut ? h('div.ui-sc', {}, shortcut) : null,
      link ? h('a', { href: link.href || '#' }, link.text, ' ↗') : null);
  }
  return h('div.ui-tip', {}, h('span', {}, t), shortcut ? h('span.ui-sc', {}, shortcut) : null);
}

let layer = null, timer = 0, cur = null;
function placeTip(target) {
  const r = target.getBoundingClientRect(), t = layer.getBoundingClientRect();
  let x = r.left + r.width / 2 - t.width / 2, y = r.bottom + 6;
  if (y + t.height > innerHeight - 4) y = r.top - t.height - 6;
  x = Math.max(4, Math.min(innerWidth - t.width - 4, x));
  layer.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
}
function hideTip() { clearTimeout(timer); cur = null; layer?.classList.remove('show'); }

// Все title в редакторе показываются тултипом New UI (data-tip хранит текст, системный не всплывает).
export function initTooltips() {
  layer = h('div#ui-tip-layer');
  document.body.append(layer);
  addEventListener('pointerover', e => {
    let el = e.target.closest?.('[title], [data-tip]');
    if (el?.tagName === 'IFRAME') el = null; // title у iframe — для доступности, не подсказка
    if (el?.hasAttribute('title')) { const t = el.getAttribute('title'); el.removeAttribute('title'); if (t) el.dataset.tip = t; }
    if (!el?.dataset.tip) { if (cur && !cur.contains(e.target)) hideTip(); return; }
    if (el === cur) return;
    hideTip();
    cur = el;
    timer = setTimeout(() => {
      if (cur !== el || !el.isConnected) return;
      layer.replaceChildren(tipContent(el.dataset.tip, { img: el.dataset.tipImg })); // data-tip-img — превью картинки
      placeTip(el);
      layer.classList.add('show');
    }, layer.classList.contains('show') ? 0 : 450);
  }, true);
  addEventListener('pointerdown', hideTip, true);
  addEventListener('wheel', hideTip, { capture: true, passive: true });
  addEventListener('blur', hideTip);
}

// ---------- Got It ----------
// gotItCard({ header, text, step, link, button, bottom }) — карточка; gotIt(anchor, opts) — показать у элемента.
export function gotItCard({ header, text, step, link, button = 'Понятно', bottom = false, ill, onClose } = {}) {
  const body = [header ? h('div.hd', {}, header) : null, text ? h('div.tx', {}, text) : null,
    link ? h('a', { href: link.href || '#', onclick: link.onclick }, link.text) : null,
    button ? h('button.btn', { onclick: () => onClose?.() }, button) : null];
  return h(`div.ui-gotit${bottom ? '.bottom' : ''}`, {},
    ill || null,
    step != null ? h('div.step', {}, h('span.n', {}, String(step).padStart(2, '0')), h('div', {}, ...body)) : body);
}

export function gotIt(anchor, opts = {}) {
  const r = anchor.getBoundingClientRect();
  const card = gotItCard({ ...opts, onClose: () => { card.remove(); opts.onClose?.(); } });
  card.classList.add('floating');
  document.body.append(card);
  const below = r.bottom + 10 + card.offsetHeight < innerHeight;
  card.classList.toggle('bottom', !below);
  card.style.left = `${Math.max(4, Math.min(innerWidth - card.offsetWidth - 4, r.left + r.width / 2 - 27))}px`;
  card.style.top = `${below ? r.bottom + 10 : r.top - card.offsetHeight - 10}px`;
  return card;
}

// ---------- цвет ----------
// Любой CSS-цвет → [r, g, b, a(0..1)] (понимает #rgb, #rrggbbaa, rgb(), имена — через canvas), null — не цвет.
let probe = null;
export function parseColor(s) {
  s = String(s ?? '').trim();
  if (!s) return null;
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(s);
  if (m) {
    let x = m[1];
    if (x.length <= 4) x = [...x].map(c => c + c).join('');
    const n = [0, 2, 4, 6].map(i => parseInt(x.slice(i, i + 2) || 'ff', 16));
    return [n[0], n[1], n[2], n[3] / 255];
  }
  probe ??= document.createElement('canvas').getContext('2d');
  probe.fillStyle = '#010203';
  probe.fillStyle = s;
  const v = probe.fillStyle;
  if (v === '#010203') return null;
  if (v.startsWith('#')) return parseColor(v);
  const r = v.match(/[\d.]+/g).map(Number);
  return [r[0], r[1], r[2], r[3] ?? 1];
}
const hx2 = v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
// [r, g, b, a] → '#rrggbb' или '#rrggbbaa' (альфа пишется, только если цвет не непрозрачный)
export const toHexColor = ([r, g, b, a = 1]) => `#${hx2(r)}${hx2(g)}${hx2(b)}${a < 0.999 ? hx2(a * 255) : ''}`;
const rgb2hsv = (r, g, b) => {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let hh = 0;
  if (d) hh = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(hh * 60 + 360) % 360, mx ? d / mx : 0, mx];
};
const hsv2rgb = (hh, s, v) => {
  const f = n => { const k = (n + hh / 60) % 6; return (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))) * 255; };
  return [f(5), f(3), f(1)];
};

const RECENT = 'maistep-colors-recent';
const recent = () => { try { return JSON.parse(localStorage.getItem(RECENT)) || []; } catch { return []; } };
const pushRecent = c => { try { localStorage.setItem(RECENT, JSON.stringify([c, ...recent().filter(x => x !== c)].slice(0, 10))); } catch {} };
const PRESETS = ['#ffffff', '#000000', '#dfe1e5', '#6f737a', '#3574f0', '#57965c', '#f2c55c', '#db5c5c', '#e08855', '#955ae0', '#24a394', '#ffddcc', '#ffce88', '#00000080'];

// Панель выбора цвета: квадрат насыщенность/яркость, оттенок, прозрачность, HEX и RGBA, пипетка, недавние и палитра.
// onChange(hex) — на каждое изменение; el.commit() кладёт цвет в «Недавние».
export function colorPicker(value, onChange, { dark = true } = {}) {
  let [r, g, b, a] = parseColor(value) || [255, 255, 255, 1];
  let [hh, s, v] = rgb2hsv(r, g, b);
  const sv = h('div.sv', {}, h('i.knob'));
  const hue = h('div.hue', {}, h('i.knob'));
  const alpha = h('div.alpha', {}, h('span.grad'), h('i.knob'));
  const prev = h('span.prev', {}, h('span.fill'));
  const hexIn = h('input.hex', { spellcheck: false, maxLength: 9 });
  const chan = ['R', 'G', 'B', 'A'].map(l => h('input', { type: 'text', inputMode: 'numeric', title: l === 'A' ? 'Непрозрачность, %' : `${l}, 0–255` }));
  const out = () => toHexColor([r, g, b, a]);
  const paint = skip => {
    const solid = toHexColor([r, g, b, 1]);
    sv.style.background = toHexColor([...hsv2rgb(hh, 1, 1), 1]);
    sv.firstChild.style.cssText = `left:${s * 100}%;top:${(1 - v) * 100}%;background:${solid}`;
    hue.firstChild.style.left = `${hh / 360 * 100}%`;
    alpha.lastChild.style.left = `${a * 100}%`;
    alpha.firstChild.style.background = `linear-gradient(90deg, ${solid}00, ${solid})`;
    prev.firstChild.style.background = out();
    if (skip !== hexIn) hexIn.value = out().toUpperCase();
    [r, g, b, a * 100].forEach((x, j) => { if (skip !== chan[j]) chan[j].value = Math.round(x); });
  };
  const emit = skip => { paint(skip); onChange?.(out()); };
  const dragOn = (el, fn) => el.addEventListener('pointerdown', e => {
    e.preventDefault();
    const go = ev => { const q = el.getBoundingClientRect(); fn(Math.max(0, Math.min(1, (ev.clientX - q.left) / q.width)), Math.max(0, Math.min(1, (ev.clientY - q.top) / q.height))); emit(); };
    go(e);
    const up = () => { removeEventListener('pointermove', go); removeEventListener('pointerup', up); };
    addEventListener('pointermove', go);
    addEventListener('pointerup', up);
  });
  dragOn(sv, (x, y) => { s = x; v = 1 - y; [r, g, b] = hsv2rgb(hh, s, v); });
  dragOn(hue, x => { hh = x * 360; [r, g, b] = hsv2rgb(hh, s, v); });
  dragOn(alpha, x => { a = Math.round(x * 100) / 100; });
  const set = (c, skip) => {
    if (!c) return;
    const keepHue = hh;
    [r, g, b, a] = c; [hh, s, v] = rgb2hsv(r, g, b);
    if (!s || !v) hh = keepHue; // у серых и чёрного оттенка нет — не сбрасываем ползунок
    emit(skip);
  };
  hexIn.addEventListener('input', () => set(parseColor(hexIn.value), hexIn));
  chan.forEach((inp, j) => {
    inp.addEventListener('input', () => {
      const n = Number(inp.value);
      if (inp.value === '' || !Number.isFinite(n)) return;
      const c = [r, g, b, a];
      c[j] = j === 3 ? Math.max(0, Math.min(100, n)) / 100 : Math.max(0, Math.min(255, n));
      set(c, inp);
    });
    inp.addEventListener('wheel', e => { e.preventDefault(); inp.value = Number(inp.value || 0) + (e.deltaY < 0 ? 1 : -1) * (e.shiftKey ? 10 : 1); inp.dispatchEvent(new Event('input')); }, { passive: false });
  });
  const sw = c => h('span.sw', { title: c, onclick: () => set(parseColor(c)) }, h('span.fill', { style: { background: c } }));
  const drop = window.EyeDropper ? h('button.b', {
    title: 'Взять цвет с экрана',
    onclick: async () => { try { const res = await new window.EyeDropper().open(); const c = parseColor(res.sRGBHex); c[3] = a; set(c); } catch {} },
  }, icon('image/colorPicker', { size: 16, dark })) : null;
  const rec = recent();
  const el = h('div.ui-cp', {},
    sv,
    h('div.mid', {}, drop ? h('div.ui-tb', {}, drop) : null, prev, h('div.bars', {}, hue, alpha)),
    h('div.vals', {}, h('label.hx', {}, hexIn, h('span', {}, 'HEX')), ...chan.map((c, j) => h('label', {}, c, h('span', {}, 'RGBA'[j])))),
    rec.length ? h('div.sws', {}, h('span.cap', {}, 'Недавние'), rec.map(sw)) : null,
    h('div.sws', {}, h('span.cap', {}, 'Палитра'), PRESETS.map(sw)));
  el.value = out;
  el.commit = () => pushRecent(out());
  paint();
  return el;
}

// Поле цвета: образец (шахматка под прозрачностью) + текст; щелчок по образцу — попап colorPicker
export function colorField(value, onChange, { dark = true, placeholder = '#rrggbb[aa]' } = {}) {
  const fill = h('span.fill');
  const t = h('input', { type: 'text', value: value || '', placeholder, spellcheck: false });
  const swatch = h('button.sw', { title: 'Выбрать цвет' }, fill);
  const show = () => { const c = parseColor(t.value); fill.style.background = c ? toHexColor(c) : ''; swatch.classList.toggle('none', !c); t.classList.toggle('bad', !!t.value && !c); };
  t.addEventListener('input', () => { show(); if (!t.value) onChange(undefined); else if (parseColor(t.value)) onChange(t.value); });
  let pop = null;
  const close = () => { if (!pop) return; pop.commit(); pop.remove(); pop = null; swatch.classList.remove('on'); removeEventListener('pointerdown', outside, true); removeEventListener('keydown', key, true); };
  const outside = e => { if (pop && !pop.contains(e.target) && !swatch.contains(e.target)) close(); };
  const key = e => { if (e.key === 'Escape' || e.key === 'Enter') { e.stopPropagation(); close(); } };
  swatch.addEventListener('click', () => {
    if (pop) return close();
    pop = colorPicker(t.value || '#ffffff', v => { t.value = v; show(); onChange(v); }, { dark });
    pop.classList.add('floating');
    document.body.append(pop);
    const q = swatch.getBoundingClientRect();
    const below = q.bottom + 6 + pop.offsetHeight < innerHeight;
    pop.style.left = `${Math.max(4, Math.min(innerWidth - pop.offsetWidth - 4, q.left))}px`;
    pop.style.top = `${below ? q.bottom + 6 : Math.max(4, q.top - pop.offsetHeight - 6)}px`;
    swatch.classList.add('on');
    addEventListener('pointerdown', outside, true);
    addEventListener('keydown', key, true);
  });
  show();
  return h('div.ui-color', {}, swatch, t);
}

// ---------- диалог-сообщение ----------
// messageBox({ kind: 'question'|'error'|'warning'|'info', title, text, ok, cancel, dontAsk, img }) → Promise<{ ok, dontAsk }>; img — картинка вместо значка
const MSG_ICON = { question: 'status/questionDialog', error: 'status/errorDialog', warning: 'status/warningDialog', info: 'status/informationDialog' };
export function messageCard({ kind = 'question', title, text, ok = 'OK', cancel = 'Отмена', dontAsk = false, dark = true, img, onClose } = {}) {
  let ask = false;
  const box = dontAsk ? h('label.ui-check', { onclick: e => { e.preventDefault(); ask = !ask; box.classList.toggle('is-checked', ask); } }, h('span.ui-box'), h('span.lbl', {}, 'Больше не спрашивать')) : null;
  const done = v => onClose?.({ ok: v, dontAsk: ask });
  return h('div.ui-msg', { tabIndex: -1, onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); done(true); } if (e.key === 'Escape') done(false); } },
    h('div.ic', {}, img ? h('img', { src: img, width: 32, height: 32, alt: '' }) : ic(MSG_ICON[kind] || MSG_ICON.info, { size: 32, dark })),
    h('div.bd', {}, title ? h('div.hd', {}, title) : null, text ? h('div.tx', {}, text) : null, box),
    h('div.ft', {}, cancel ? h('button.ui-btn.secondary', { onclick: () => done(false) }, cancel) : null, h('button.ui-btn.primary', { onclick: () => done(true) }, ok)));
}
export function messageBox(opts = {}) {
  return new Promise(res => {
    const close = v => { bg.remove(); res(v); };
    const card = messageCard({ ...opts, onClose: close });
    const bg = h('div.modal-bg', { onmousedown: e => { if (e.target === bg) close({ ok: false, dontAsk: false }); } }, card);
    document.body.append(bg);
    card.querySelector('.ui-btn.primary').focus();
  });
}
