// Models: библиотека моделей из папок ComfyUI (только чтение) — /api/library сервера. Hierarchy (контекст library) —
// категории и папки: своя <maistep>/models есть всегда, найденные ComfyUI и добавленные — можно убрать, «Добавить
// папку…» — выбор папки (в окне — системный диалог, в веб-режиме — путь текстом); вид v-library — галерея с превью, поиском и сортировкой; Inspector — карточка модели (база,
// архитектура, триггер-слова, теги, ссылка Civitai, метаданные safetensors). NSFW-превью размыты (переключатель в баре).
// libraryPicker — выбор модели категории для ноды «Модель из библиотеки».
import { h, debounce, prompt } from './util.js';
import { S, on, emit, select } from './store.js';
import { registerInspector } from './inspector.js';
import { icon } from './icons.js';
import { dropdown } from './kit.js';
import { api } from './backend.js';
import { openExternal, invoke, isTauri } from './api.js';
import { isShown } from './dock.js';
import { onContextMenu } from './ctxmenu.js';

const LS = 'maistep-library';
const st = (() => { try { return { cat: '', q: '', sort: 'name', blur: true, size: 150, ...JSON.parse(localStorage.getItem(LS)) }; } catch { return { cat: '', q: '', sort: 'name', blur: true, size: 150 }; } })();
// NSFW-превью (по .cminfo.json): скрыт — вместо картинки значок (модели остаются в списке), размыт, открыт
st.nsfw ??= st.blur ? 'blur' : 'show';
const NSFW = [['off', 'NSFW скрыт'], ['blur', 'NSFW размыт'], ['show', 'NSFW открыт']];
const showPv = it => it.has_preview && !(it.nsfw && st.nsfw === 'off');
const blurPv = it => it.nsfw && st.nsfw === 'blur';
const keep = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch {} };
let lib = null, loading = null;
const details = new Map(); // id → карточка

export const libraryItem = name => (lib?.items || []).find(it => it.name === name) || null;

const base = () => `http://localhost:${S.server.port}`;
export const previewUrl = id => `${base()}/api/library/preview?id=${encodeURIComponent(id)}`;
export const fmtSize = n => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(1)} ГБ` : n >= 1 << 20 ? `${Math.round(n / (1 << 20))} МБ` : `${Math.round(n / 1024)} КБ`);
const fmtParams = n => (!n ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : `${Math.round(n / 1e6)}M`);
const CAT_IC = { checkpoints: 'blueprint', loras: 'link', unet: 'node', diffusion_models: 'node', vae: 'image', clip: 'text', text_encoders: 'text', LLM: 'ai', upscale_models: 'zoomIn' };

export async function loadLibrary(refresh = false) {
  if (!S.server.running) return null;
  if (loading && !refresh) return loading;
  loading = api(`/api/library${refresh ? '?refresh=1' : ''}`)
    .then(r => { lib = r; if (refresh) details.clear(); emit('library', lib); emit('log', { src: 'editor', level: 'info', text: `библиотека моделей: ${lib.items.length} файлов за ${lib.took} с` }); return lib; })
    .catch(e => { emit('log', { src: 'editor', level: 'error', text: `библиотека моделей: ${e.message}` }); return null; })
    .finally(() => { loading = null; });
  return loading;
}

async function card(id) {
  if (!details.has(id)) details.set(id, await api(`/api/library/model?id=${encodeURIComponent(id)}`).catch(e => ({ error: e.message })));
  return details.get(id);
}

function filtered(cat = st.cat, q = st.q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = (lib?.items || []).filter(it => (!cat || it.cat === cat)
    && words.every(w => `${it.name} ${it.title || ''} ${it.base || ''} ${(it.trained || []).join(' ')}`.toLowerCase().includes(w)));
  const by = { name: (a, b) => a.name.localeCompare(b.name), size: (a, b) => b.size - a.size, date: (a, b) => b.mtime - a.mtime }[st.sort];
  return list.sort(by);
}

// ---------- Hierarchy: категории и корни ----------
export function libraryTreeItems() {
  if (!lib) return [{ grp: S.server.running ? 'загрузка…' : 'сервер не запущен' }];
  const rows = [{ grp: 'Категории' }];
  const all = lib.items.reduce((a, it) => a + it.size, 0);
  const pick = cat => () => { st.cat = cat; keep(); render(); emit('change', { kind: null }); };
  rows.push({ ic: 'projectStructure', label: 'Все модели', tag: `${lib.items.length} · ${fmtSize(all)}`, sel: !st.cat, onClick: pick(''),
    menu: () => [{ ic: 'refresh', label: 'Пересканировать папки', fn: () => loadLibrary(true).then(() => { render(); emit('change', { kind: null }); }) }] });
  for (const [cat, c] of Object.entries(lib.categories).sort((a, b) => b[1].size - a[1].size)) {
    rows.push({ depth: 1, ic: CAT_IC[cat] || 'folder', label: cat, tag: `${c.count} · ${fmtSize(c.size)}`, sel: st.cat === cat, onClick: pick(cat) });
  }
  rows.push({ grp: 'Папки моделей (только чтение)' });
  for (const r of lib.roots) {
    const drop = () => editRoots({ remove: r.path });
    rows.push({ ic: r.exists ? 'folder' : 'warning', label: r.path, tag: r.from, title: r.exists ? r.path : `${r.path} — папки нет`,
      act: r.removable ? { ic: 'closeSmall', tip: 'Убрать из списка (файлы не трогаются)', onClick: drop } : null,
      menu: () => [
        { ic: 'folder', label: 'Показать в проводнике', disabled: !r.exists, fn: () => reveal(r.path) },
        { ic: 'copy', label: 'Копировать путь', fn: () => navigator.clipboard?.writeText(r.path) },
        '-',
        { ic: 'add', label: 'Добавить папку…', fn: addRoot },
        r.removable ? { ic: 'closeSmall', label: 'Убрать из списка', fn: drop } : { ic: 'closeSmall', label: 'Своя папка — убрать нельзя', disabled: true },
      ] });
  }
  rows.push({ ic: 'add', label: 'Добавить папку…', title: 'Папка с моделями: подпапки — категории (checkpoints, loras, vae…), как models/ в ComfyUI', onClick: addRoot });
  return rows;
}

const reveal = p => invoke('fs_reveal', { path: p }).catch(e => emit('log', { src: 'editor', level: 'error', text: `проводник: ${e}` }));

async function editRoots(body) {
  try {
    lib = await api('/api/library/roots', body);
    details.clear();
    emit('library', lib);
    render();
    emit('change', { kind: null });
  } catch (e) { emit('log', { src: 'editor', level: 'error', text: `папки моделей: ${e.message}` }); }
}

async function addRoot() {
  let dir; // null — диалог отменили, undefined — спросить путь текстом
  if (isTauri) {
    try { dir = await invoke('pick_folder', { title: 'Папка с моделями' }); }
    catch { dir = undefined; } // старое ядро без команды — путь текстом
  }
  if (dir === null) return;
  if (dir === undefined) {
    const r = await prompt('Добавить папку моделей', [{ key: 'p', label: 'Полный путь к папке (подпапки — checkpoints, loras, vae…)', value: '' }], 'Добавить');
    dir = r?.p?.trim();
  }
  if (dir) editRoots({ add: dir });
}

// ---------- галерея ----------
function tile(it) {
  const th = showPv(it)
    ? h('img', { src: previewUrl(it.id), loading: 'lazy', alt: '', draggable: false })
    : h('div.lph', {}, icon(it.has_preview ? 'eye' : CAT_IC[it.cat] || 'folder', { size: 32 }), h('span', {}, it.has_preview ? 'NSFW' : it.ext));
  return h(`div.ltile${blurPv(it) ? '.nsfw' : ''}${S.sel?.kind === 'libmodel' && S.sel.id === it.id ? '.sel' : ''}`, {
    'data-id': it.id, onclick: () => select({ kind: 'libmodel', id: it.id }),
    ondblclick: () => emit('library-insert', it),
    'data-tip': `${it.cat}/${it.name}\n${fmtSize(it.size)}${it.base ? ` · ${it.base}` : ''}\nДвойной щелчок — нода «Модель из библиотеки»`,
  }, h('div.lth', {}, th, it.base ? h('span.lbase', {}, it.base) : null),
  h('div.lnm', {}, h('span.n', {}, it.title || it.name.replace(/\.[^.]+$/, '').split('/').pop()), h('span.dim', {}, `${st.cat ? '' : `${it.cat} · `}${fmtSize(it.size)}`)));
}

let gridEl = null, countEl = null;
function render() {
  const v = document.getElementById('v-library');
  if (!v || !isShown('library')) return;
  if (!S.server.running) { v.replaceChildren(h('div.msg', {}, 'Сервер не запущен — библиотеку отдаёт он')); gridEl = null; return; }
  if (!lib) { v.replaceChildren(h('div.msg', {}, 'Загрузка библиотеки…')); loadLibrary(); gridEl = null; return; }
  if (!gridEl) {
    const q = h('input.lq', { placeholder: 'Поиск: имя, база, триггер-слова…', value: st.q, spellcheck: false });
    q.addEventListener('input', debounce(() => { st.q = q.value; keep(); fill(); }, 120));
    q.addEventListener('keydown', e => e.stopPropagation());
    const sortBtn = (k, t) => h(`button${st.sort === k ? '.on' : ''}`, { 'data-s': k, onclick: e => { st.sort = k; keep(); e.currentTarget.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.s === k)); fill(); } }, t);
    const blur = dropdown(st.nsfw, NSFW, val => { st.nsfw = val; keep(); fill(); if (S.sel?.kind === 'libmodel') emit('select', S.sel); }, { width: 120 });
    blur.dataset.tip = 'NSFW-превью моделей (по .cminfo.json): скрыт — модели в списке, превью не показывается';
    const size = h('input.ui-range', { type: 'range', min: 100, max: 260, step: 10, value: st.size, 'data-tip': 'Размер плиток' });
    size.addEventListener('input', () => { st.size = +size.value; keep(); gridEl.style.setProperty('--lsz', `${st.size}px`); });
    countEl = h('span.dim');
    gridEl = h('div.lgrid');
    gridEl.style.setProperty('--lsz', `${st.size}px`);
    v.replaceChildren(h('div.bar', {}, q, h('div.ui-seg', {}, sortBtn('name', 'Имя'), sortBtn('size', 'Размер'), sortBtn('date', 'Дата')), blur, size, h('span.grow'), countEl,
      h('button', { 'data-tip': 'Пересканировать папки', onclick: () => loadLibrary(true) }, icon('refresh', { size: 14 }), 'Обновить')), gridEl);
  }
  fill();
}
function fill() {
  if (!gridEl) return;
  const list = filtered();
  countEl.textContent = `${st.cat || 'все'}: ${list.length}`;
  gridEl.replaceChildren(...(list.length ? list.map(tile) : [h('div.msg', {}, 'Ничего не найдено')]));
}

// ---------- Inspector ----------
function libInspector(s) {
  const it = lib?.items.find(x => x.id === s.id);
  if (!it) return [h('div.dim', {}, 'модель не найдена')];
  const box = h('div');
  const copy = t => navigator.clipboard?.writeText(t);
  const head = [
    h('h3', {}, icon(CAT_IC[it.cat] || 'folder', { size: 16 }), it.title || it.file),
    h('div.hint.mono', { style: { userSelect: 'text', wordBreak: 'break-all' } }, `${it.cat}/${it.name}`),
    showPv(it) ? h(`div.preview${blurPv(it) ? '.nsfw' : ''}`, { onclick: e => { if (e.currentTarget.classList.contains('nsfw')) { e.stopPropagation(); e.currentTarget.classList.remove('nsfw'); } } }, h('img', { src: previewUrl(it.id), alt: it.name })) : null,
    it.has_preview && !showPv(it) ? h('div.hint', {}, 'Превью скрыто (NSFW скрыт)') : null,
    h('div.row', { style: { margin: '6px 0', flexWrap: 'wrap' } },
      h('button.primary', { onclick: () => emit('library-insert', it) }, icon('add', { size: 14 }), 'Нода в граф'),
      h('button', { onclick: () => copy(it.name) }, icon('copy', { size: 14 }), 'Имя'),
      h('button', { onclick: () => copy(it.path) }, icon('copy', { size: 14 }), 'Путь')),
    box,
  ];
  box.append(h('div.dim', {}, 'чтение заголовка…'));
  card(it.id).then(d => {
    if (S.sel?.id !== s.id) return;
    const c = d.civitai || {};
    const words = c.trained?.length ? c.trained : [];
    const kv = (k, v) => (v == null || v === '' ? null : h('div.f', {}, h('label', {}, k), h('div.v', { style: { userSelect: 'text' } }, String(v))));
    box.replaceChildren(...[
      kv('Размер', fmtSize(it.size)),
      kv('Формат', it.ext),
      kv('Архитектура', d.arch),
      kv('База', c.base || it.base),
      kv('Тип', c.type),
      kv('Параметры', fmtParams(d.params)),
      kv('Тензоры', d.tensors && `${d.tensors} · ${Object.entries(d.dtypes || {}).map(([t, n]) => `${t}×${n}`).join(', ')}`),
      kv('Автор', c.creator),
      kv('Версия', c.version),
      kv('Корень', it.root),
      d.error ? h('div.hint', { style: { color: 'var(--err)' } }, d.error) : null,
      words.length ? h('h4', {}, 'Триггер-слова (щёлкните — копировать)') : null,
      ...words.map(w => h('div.ltrig', { onclick: () => copy(w), 'data-tip': 'Копировать' }, w)),
      d.tags?.length ? h('h4', {}, 'Частые теги обучения') : null,
      d.tags?.length ? h('div.ltags', {}, ...d.tags.map(t => h('span.mbadge', { onclick: () => copy(t) }, t))) : null,
      c.tags?.length ? h('h4', {}, 'Теги Civitai') : null,
      c.tags?.length ? h('div.ltags', {}, ...c.tags.map(t => h('span.mbadge', {}, t))) : null,
      c.url ? h('button', { style: { marginTop: '8px' }, onclick: () => openExternal(c.url) }, icon('externalLink', { size: 14 }), 'Открыть на Civitai') : null,
      c.description ? h('details', {}, h('summary', {}, 'Описание'), h('pre.out', {}, c.description)) : null,
      d.meta && Object.keys(d.meta).length ? h('details', {}, h('summary', {}, `Метаданные safetensors (${Object.keys(d.meta).length})`),
        h('pre.out', {}, Object.entries(d.meta).map(([k, v]) => `${k}: ${v}`).join('\n'))) : null,
      d.sha256 || c.sha256 ? kv('SHA256', (d.sha256 || c.sha256).slice(0, 16) + '…') : null,
    ].filter(Boolean)); // replaceChildren печатает null как текст
  });
  return head;
}

// ---------- выбор модели для ноды ----------
let pop = null;
export const closeLibraryPicker = () => { pop?.remove(); pop = null; };

export async function libraryPicker(at, { cat, value, onPick }) {
  closeLibraryPicker();
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.clientX, bottom: at.clientY };
  const input = h('input', { placeholder: `${cat}: поиск…`, spellcheck: false });
  const grid = h('div.lgrid.lpick');
  pop = h('div.gfloat.lpop', { onpointerdown: e => e.stopPropagation() }, input, grid);
  document.body.append(pop);
  const place = () => {
    if (!pop) return;
    pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.max(4, Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8))}px`;
  };
  const fillPick = () => {
    if (!lib) { grid.replaceChildren(h('div.dim', {}, 'загрузка библиотеки…')); return place(); }
    const list = filtered(cat, input.value);
    grid.replaceChildren(...(list.length ? list.map(it => {
      const t = tile(it);
      t.classList.toggle('sel', it.name === value);
      t.onclick = () => { closeLibraryPicker(); onPick(it.name); };
      t.ondblclick = null;
      return t;
    }) : [h('div.dim', {}, 'нет моделей')]));
    place();
  };
  input.addEventListener('input', fillPick);
  input.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeLibraryPicker(); if (e.key === 'Enter') grid.querySelector('.ltile')?.click(); });
  fillPick();
  input.focus();
  if (!lib) { await loadLibrary(); fillPick(); }
  const off = e => { if (pop && !pop.contains(e.target)) { closeLibraryPicker(); removeEventListener('pointerdown', off, true); } };
  setTimeout(() => addEventListener('pointerdown', off, true));
}

// ПКМ по плитке модели
function tileMenu(t) {
  const el = t.closest('#v-library .ltile');
  const it = el && lib?.items.find(x => x.id === el.dataset.id);
  if (!it) return null;
  const copy = s => navigator.clipboard?.writeText(s);
  select({ kind: 'libmodel', id: it.id });
  return [
    { ic: 'add', label: 'Вставить ноду «Модель из библиотеки»', fn: () => emit('library-insert', it) },
    { ic: 'properties', label: 'Карточка в Inspector', fn: () => select({ kind: 'libmodel', id: it.id }) },
    '-',
    it.path ? { ic: 'folder', label: 'Показать в проводнике', fn: () => reveal(it.path) } : null,
    { ic: 'copy', label: 'Копировать имя', fn: () => copy(it.name) },
    it.path ? { ic: 'copy', label: 'Копировать полный путь', fn: () => copy(it.path) } : null,
    it.trained?.length ? { ic: 'copy', label: 'Копировать триггер-слова', fn: () => copy(it.trained.join(', ')) } : null,
  ];
}

export function initLibrary() {
  onContextMenu(tileMenu);
  registerInspector('libmodel', libInspector);
  on('library', render);
  on('library-changed', () => loadLibrary(true)); // скачана модель (Civitai, Компоненты)
  on('select', s => { if (gridEl) gridEl.querySelectorAll('.ltile').forEach(t => t.classList.toggle('sel', s?.kind === 'libmodel' && t.dataset.id === s.id)); });
  on('server', st_ => { if (st_.running) setTimeout(() => loadLibrary(), 1500); else { lib = null; render(); } });
  addEventListener('view', e => { if (e.detail === 'library') render(); });
}
