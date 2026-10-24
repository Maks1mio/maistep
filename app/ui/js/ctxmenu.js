// Контекстное меню UI Kit (.ui-menu) вместо системного — по всему приложению. Модуль со своим меню вызывает
// popup(e, items) и preventDefault (граф, проводник); остальное собирает общий обработчик: поставщики
// onContextMenu(fn) по элементу под курсором + общие разделы — картинка (просмотр, копировать изображение / адрес)
// и текст (вырезать / копировать / вставить / выделить всё). Shift+ПКМ — системное меню (отладка).
// Пункт: { ic, label, sc, fn, disabled } | '-' (разделитель) | null (пропуск). Клавиши: ↑/↓, Enter, Esc.
import { h } from './util.js';
import { icon } from './icons.js';
import { openViewer, copyImage } from './viewer.js';
import { openExternal } from './api.js';

const providers = [];
let cur = null;

export const onContextMenu = fn => providers.push(fn);

export function closeMenu() {
  if (!cur) return;
  cur.el.remove();
  removeEventListener('pointerdown', cur.off, true);
  removeEventListener('keydown', cur.key, true);
  removeEventListener('blur', closeMenu);
  removeEventListener('resize', closeMenu);
  cur = null;
}

// Меню у курсора (e — событие или { clientX, clientY })
export function popup(e, items) {
  e.preventDefault?.();
  e.stopPropagation?.();
  closeMenu();
  const list = tidy(items);
  if (!list.length) return;
  const rows = [];
  const el = h('div.ui-menu.ctx-menu', { oncontextmenu: ev => ev.preventDefault() }, ...list.map(it => {
    if (it === '-') return h('div.sep');
    const row = h(`div.item${it.disabled ? '.off' : ''}`, {
      onclick: () => { if (it.disabled) return; closeMenu(); it.fn?.(); },
      onpointerenter: () => focus(rows.indexOf(row)),
    }, h('span.ic', {}, it.ic ? icon(it.ic, { size: 16 }) : null), h('span', {}, it.label), it.sc ? h('span.sc', {}, it.sc) : null);
    if (!it.disabled) rows.push(row);
    return row;
  }));
  let at = -1;
  const focus = i => { at = i; rows.forEach((r, k) => r.classList.toggle('on', k === i)); };
  const key = ev => {
    if (ev.key === 'Escape') closeMenu();
    else if (ev.key === 'ArrowDown') focus((at + 1) % rows.length);
    else if (ev.key === 'ArrowUp') focus((at - 1 + rows.length) % rows.length);
    else if (ev.key === 'Enter' && at >= 0) rows[at].click();
    else return;
    ev.preventDefault(); ev.stopPropagation();
  };
  const off = ev => { if (!el.contains(ev.target)) closeMenu(); };
  document.body.append(el);
  const x = e.clientX ?? 0, y = e.clientY ?? 0, w = el.offsetWidth, ht = el.offsetHeight;
  el.style.left = `${Math.max(4, Math.min(x, innerWidth - w - 4))}px`;
  el.style.top = `${Math.max(4, y + ht > innerHeight - 4 ? y - ht : y)}px`;
  cur = { el, off, key };
  addEventListener('pointerdown', off, true);
  addEventListener('keydown', key, true);
  addEventListener('blur', closeMenu);
  addEventListener('resize', closeMenu);
}

// без пустых пунктов и лишних разделителей
function tidy(items) {
  const out = [];
  for (const it of items.flat()) {
    if (!it) continue;
    if (it === '-' && (!out.length || out.at(-1) === '-')) continue;
    out.push(it);
  }
  while (out.at(-1) === '-') out.pop();
  return out;
}

// ---------- общие разделы ----------
const copyText = t => navigator.clipboard?.writeText(String(t));

// картинки рядом (та же галерея / список) — для листания в просмотре
function siblings(img) {
  const box = img.closest('.rimgs, .rgrid, .lgrid, .pj-grid, .cv-grid, .ag-msgs, .insp, .vw-strip') || img.parentElement;
  const all = [...box.querySelectorAll('img:not(.ui-ic)')].filter(i => i.currentSrc || i.src);
  const list = all.map(i => ({ src: i.currentSrc || i.src, name: i.alt || i.dataset.tip || '' }));
  return { list, i: Math.max(0, all.indexOf(img)) };
}

function imageItems(img) {
  const src = img.currentSrc || img.src;
  if (!src || img.closest('.vw')) return [];
  return [
    { ic: 'show', label: 'Открыть просмотр', fn: () => { const { list, i } = siblings(img); openViewer(list, i); } },
    { ic: 'copy', label: 'Копировать изображение', fn: () => copyImage(src) },
    { ic: 'link', label: 'Копировать адрес изображения', fn: () => copyText(src) },
    /^https?:\/\/(?!localhost|127\.)/.test(src) ? { ic: 'externalLink', label: 'Открыть в браузере', fn: () => openExternal(src) } : null,
  ];
}

function textItems(t) {
  const field = t.closest('input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea, [contenteditable=""], [contenteditable=true]');
  const sel = String(getSelection() || '');
  if (field) {
    const ro = field.readOnly || field.disabled;
    const has = field.isContentEditable ? !!sel : field.selectionStart !== field.selectionEnd;
    return [
      { ic: 'cut', label: 'Вырезать', sc: 'Ctrl+X', disabled: ro || !has, fn: () => { field.focus(); document.execCommand('cut'); } },
      { ic: 'copy', label: 'Копировать', sc: 'Ctrl+C', disabled: !has, fn: () => { field.focus(); document.execCommand('copy'); } },
      { ic: 'paste', label: 'Вставить', sc: 'Ctrl+V', disabled: ro, fn: () => paste(field) },
      '-',
      { ic: null, label: 'Выделить всё', sc: 'Ctrl+A', fn: () => { field.focus(); field.select ? field.select() : document.execCommand('selectAll'); } },
    ];
  }
  return sel.trim() ? [{ ic: 'copy', label: 'Копировать', sc: 'Ctrl+C', fn: () => copyText(sel) }] : [];
}

async function paste(field) {
  field.focus();
  let t = '';
  try { t = await navigator.clipboard.readText(); } catch { document.execCommand('paste'); return; }
  if (field.isContentEditable) { document.execCommand('insertText', false, t); return; }
  field.setRangeText(t, field.selectionStart, field.selectionEnd, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

// пункт дерева Hierarchy без своего меню: то же, что щелчок, и копировать название (после всех поставщиков)
const treeItems = t => {
  const row = t.closest('.tree .item');
  if (!row) return null;
  const name = row.querySelector('.nm')?.textContent || '';
  return [
    { ic: 'open', label: 'Открыть', fn: () => row.click() },
    name ? { ic: 'copy', label: 'Копировать название', fn: () => copyText(name) } : null,
  ];
};

export function initContextMenu() {
  // превью в Inspector (.preview) — щелчок открывает просмотр с соседними картинками
  document.addEventListener('click', e => {
    const img = e.target.closest?.('.preview img:not(.ui-ic)');
    if (!img || img.closest('.preview.nsfw, .vw')) return;
    const { list, i } = siblings(img);
    openViewer(list, i);
  });
  document.addEventListener('contextmenu', e => {
    if (e.defaultPrevented) return;      // своё меню модуля уже показано
    if (e.shiftKey) return;              // системное — для отладки
    e.preventDefault();
    const t = e.target instanceof Element ? e.target : e.target.parentElement;
    if (!t || t.closest('canvas')) return;
    const own = [...providers, treeItems].map(p => p(t, e)).find(r => r?.length) || [];
    const img = t.closest('img');
    popup(e, [own, own.length && img ? '-' : null, img ? imageItems(img) : [], '-', textItems(t)]);
  });
}
