// DOM-помощники и поля форм (инспектор, панели персонажей/полей), модальные окна.
import { colorField, messageBox, dropdown, autocomplete } from './kit.js';

export function h(tag, attrs = {}, ...kids) {
  // 'tag.класс.класс#id'
  const [base, id] = tag.split('#');
  const [name, ...cls] = base.split('.');
  const e = document.createElement(name || 'div');
  if (cls.length) e.className = cls.join(' ');
  if (id) e.id = id;
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'draggable' && v === false) { e.draggable = false; continue; } // у img по умолчанию true — false тут значим
    if (v == null || v === false) continue;
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'html') e.innerHTML = v;
    else if (k in e && k !== 'list') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

// replaceChildren без null/false (сам DOM превращает их в текст «null»)
export const fill = (el, ...kids) => el.replaceChildren(...kids.flat().filter(k => k != null && k !== false));
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const round = (v, n = 3) => Math.round(v * 10 ** n) / 10 ** n;

// Строка инспектора: подпись + редактор. onChange(value) вызывается при вводе (live) и при потере фокуса.
export function field(label, control, title) {
  return h('div.f', { title: title || '' }, h('label', {}, label), h('div.v', {}, control));
}

export function text(value, onChange, opts = {}) {
  const i = h('input', { type: 'text', value: value ?? '', placeholder: opts.placeholder || '', spellcheck: false });
  if (opts.list) autocomplete(i, opts.list); // подсказки UI Kit вместо системного <datalist>
  i.addEventListener(opts.live === false ? 'change' : 'input', () => {
    const ok = opts.validate ? opts.validate(i.value) : true;
    i.classList.toggle('bad', ok !== true && ok !== undefined);
    i.title = typeof ok === 'string' ? ok : '';
    if (ok === true || ok === undefined) onChange(i.value);
  });
  if (opts.validate) { const ok = opts.validate(i.value); i.classList.toggle('bad', ok !== true && ok !== undefined); }
  return i;
}

export function num(value, onChange, opts = {}) {
  const i = h('input', { type: 'number', value: value ?? '', step: opts.step ?? 'any', placeholder: opts.placeholder || '' });
  if (opts.min != null) i.min = opts.min;
  if (opts.max != null) i.max = opts.max;
  i.addEventListener('input', () => {
    if (i.value === '') { if (opts.allowEmpty) onChange(undefined); return; }
    const v = Number(i.value);
    if (Number.isFinite(v)) onChange(opts.int ? Math.round(v) : v);
  });
  return stepper(i, opts);
}

// Стрелки числового поля (.ui-num из UI Kit): шевроны вместо системных, зажатие повторяет шаг, протяжка по
// стрелкам вверх/вниз меняет значение, колесо — когда поле в фокусе. Shift — шаг ×10, Alt — ×0.1.
export function stepper(i, opts = {}) {
  const base = opts.wheel ?? (Number(i.step) || 1);
  const mul = e => (e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
  const bump = (dir, k = 1) => {
    let v = round((Number(i.value) || 0) + dir * base * k, 6);
    if (i.min !== '') v = Math.max(Number(i.min), v);
    if (i.max !== '') v = Math.min(Number(i.max), v);
    i.value = v;
    i.dispatchEvent(new Event('input'));
  };
  const arrow = dir => h(`b.${dir > 0 ? 'up' : 'dn'}`, {
    onpointerdown: e => {
      e.preventDefault();
      const k = mul(e);
      let moved = false, last = e.clientY, timer = setTimeout(function rep() { moved = true; bump(dir, k); timer = setTimeout(rep, 60); }, 400);
      const move = ev => { // протяжка: 4 px = один шаг
        const n = Math.trunc((last - ev.clientY) / 4);
        if (!n) return;
        clearTimeout(timer); moved = true; last -= n * 4;
        bump(Math.sign(n), Math.abs(n) * mul(ev));
        document.body.style.cursor = 'ns-resize';
      };
      const up = () => { clearTimeout(timer); if (!moved) bump(dir, k); document.body.style.cursor = ''; removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
      addEventListener('pointermove', move);
      addEventListener('pointerup', up);
    },
  });
  i.addEventListener('wheel', e => {
    if (document.activeElement !== i) return;
    e.preventDefault();
    bump(e.deltaY < 0 ? 1 : -1, mul(e));
  }, { passive: false });
  return h('span.ui-num', {}, i, h('span.sp', { title: 'Щёлкните или тяните вверх/вниз (Shift ×10, Alt ×0.1)' }, arrow(1), arrow(-1)));
}

export function check(value, onChange) {
  const i = h('input', { type: 'checkbox', checked: !!value });
  i.addEventListener('change', () => onChange(i.checked));
  return i;
}

// Выпадающий список — компонент UI Kit (kit.js dropdown) вместо системного <select>; тот же контракт:
// options — v | [v, подпись] | [v, подпись, иконка], opts.empty — пустой пункт (onChange(undefined)).
export function select(value, options, onChange, opts = {}) {
  return dropdown(value, options, onChange, opts);
}

// Цвет: образец + поле (#rrggbb / #rrggbbaa / любой CSS-цвет), по щелчку — колор-пикер UI Kit с прозрачностью
export const color = (value, onChange) => colorField(value, onChange);

export function json(value, onChange, rows = 4) {
  const t = h('textarea', { rows, spellcheck: false });
  t.value = value === undefined ? '' : JSON.stringify(value, null, 1);
  t.addEventListener('input', () => {
    if (!t.value.trim()) { t.classList.remove('bad'); onChange(undefined); return; }
    try { const v = JSON.parse(t.value); t.classList.remove('bad'); onChange(v); } catch { t.classList.add('bad'); }
  });
  return t;
}

// Модальное окно с полями: fields = [{ key, label, value, type, options }] → Promise<объект | null>
export function prompt(title, fields, okText = 'OK') {
  return new Promise(res => {
    const vals = Object.fromEntries(fields.map(f => [f.key, f.value ?? '']));
    const close = v => { bg.remove(); res(v); };
    const rows = fields.map(f => {
      const ctl = f.type === 'select'
        ? select(vals[f.key], f.options, v => { vals[f.key] = v; })
        : text(vals[f.key], v => { vals[f.key] = v; }, { placeholder: f.placeholder || '' });
      return h('div.f', {}, h('label', {}, f.label), ctl);
    });
    const bg = h('div.modal-bg', { onmousedown: e => { if (e.target === bg) close(null); } },
      h('div.modal', { onkeydown: e => { if (e.key === 'Enter') close(vals); if (e.key === 'Escape') close(null); } },
        h('h3', {}, title), ...rows,
        h('div.btns', {}, h('button', { onclick: () => close(null) }, 'Отмена'), h('button.primary', { onclick: () => close(vals) }, okText))));
    document.body.append(bg);
    bg.querySelector('input,select')?.focus();
  });
}

// Подтверждение — диалог-сообщение UI Kit (иконка вопроса, Отмена / Да)
export function confirmBox(text, opts = {}) {
  return messageBox({ kind: 'question', title: opts.title || 'Подтверждение', text, ok: opts.ok || 'Да', cancel: 'Отмена' }).then(r => r.ok);
}

// Перетаскивание мышью: onMove(dx, dy, e), onUp(e)
export function drag(e, onMove, onUp) {
  const x0 = e.clientX, y0 = e.clientY;
  const mm = ev => onMove(ev.clientX - x0, ev.clientY - y0, ev);
  const mu = ev => { removeEventListener('pointermove', mm); removeEventListener('pointerup', mu); onUp?.(ev); };
  addEventListener('pointermove', mm);
  addEventListener('pointerup', mu);
}

export const debounce = (fn, ms = 120) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
