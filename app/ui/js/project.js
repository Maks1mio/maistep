// Project: проводник проекта maistep (workflows, input, output, custom_nodes, server, …). Хлебные крошки, папки,
// плитки или список, поиск по папке и вложенным, размер плиток (ползунок, Ctrl+колесо), подгрузка при прокрутке,
// превью картинок при наведении, сортировка (имя / размер / дата / тип). Щелчок — Inspector; двойной щелчок или Enter:
// воркфлоу — граф, .py — CodeEditor, картинка — просмотр (viewer.js, листаются картинки папки); пробел — просмотр;
// стрелки — выбор; картинку можно перетащить на граф (нода «Загрузить картинку»); ПКМ — меню (ctxmenu.js).
import { h, debounce } from './util.js';
import { S, emit, select } from './store.js';
import { invoke, assetUrl } from './api.js';
import { icon } from './icons.js';
import { search, dropdown } from './kit.js';
import { registerInspector } from './inspector.js';
import { showView } from './dock.js';
import { popup } from './ctxmenu.js';
import { openViewer, copyImage } from './viewer.js';

const LS = 'maistep-project';
const st = (() => { try { return { dir: '', view: 'grid', size: 84, sort: 'name', ...JSON.parse(localStorage.getItem(LS)), mode: 'fs' }; } catch { return { mode: 'fs', dir: '', view: 'grid', size: 84, sort: 'name' }; } })();
const SORTS = [{ value: 'name', label: 'По имени' }, { value: 'date', label: 'Сначала новые' }, { value: 'size', label: 'Сначала большие' }, { value: 'type', label: 'По типу' }];
const ext = p => (p.includes('.') ? p.split('.').pop().toLowerCase() : '');
// папки всегда сверху, внутри — по выбранному порядку
function sorted(list) {
  const by = {
    name: (a, b) => base(a.path).toLowerCase().localeCompare(base(b.path).toLowerCase()),
    date: (a, b) => (b.mtime || 0) - (a.mtime || 0),
    size: (a, b) => (b.size || 0) - (a.size || 0),
    type: (a, b) => ext(a.path).localeCompare(ext(b.path)) || base(a.path).localeCompare(base(b.path)),
  }[st.sort] || (() => 0);
  return [...list].sort((a, b) => (b.dir ? 1 : 0) - (a.dir ? 1 : 0) || by(a, b));
}
const keep = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch {} };
const CHUNK = 160;
const IMG = /\.(png|webp|jpe?g|gif|svg)$/i;
// места: fs — папка проекта; gfx — объединённая graphics (custom/ перекрывает game/)
const PLACES = [
  { value: 'fs:', label: 'Проект', icon: 'projectStructure' },
  { value: 'fs:workflows', label: 'workflows', icon: 'folder', sec: 'графы' },
  { value: 'fs:input', label: 'input', icon: 'folder', sec: 'входные файлы' },
  { value: 'fs:output', label: 'output', icon: 'folder', sec: 'результаты' },
  { value: 'fs:custom_nodes', label: 'custom_nodes', icon: 'folder', sec: 'свои ноды' },
  { value: 'fs:server', label: 'server', icon: 'folder', sec: 'сервер и встроенные ноды' },
];
let query = '', tree = null, shown = 0, items = [], io = null, token = 0;
const listing = new Map(); // кэш fs_list: папка → записи

// индекс graphics: dir → { dirs: Map(имя → файлов внутри), files: [путь] }
function buildTree() {
  tree = new Map([['', { dirs: new Map(), files: [] }]]);
  for (const a of S.assets) {
    const parts = a.split('/');
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const node = tree.get(dir);
      node.dirs.set(parts[i], (node.dirs.get(parts[i]) || 0) + 1);
      dir = dir ? `${dir}/${parts[i]}` : parts[i];
      if (!tree.has(dir)) tree.set(dir, { dirs: new Map(), files: [] });
    }
    tree.get(dir).files.push(a);
  }
  if (st.mode === 'gfx' && !tree.has(st.dir)) st.dir = '';
}

export async function loadAssets(refresh = false) {
  if (refresh) listing.clear();
  S.assets = [];
  buildTree();
  draw();
}

const $ = id => document.getElementById(id);
const base = p => p.replace(/\/$/, '').split('/').pop();
const join = (a, b) => (a ? `${a}/${b}` : b);
let clearQuery = () => {}, placeDd = null;
function go(dir, mode = st.mode) {
  st.mode = mode; st.dir = dir; keep();
  placeDd.value = placeOf();
  if (query) clearQuery(); else draw();
  $('pj-body').scrollTop = 0;
}
const up = () => { if (st.dir) go(st.dir.split('/').slice(0, -1).join('/')); };
const placeOf = () => { const exact = `${st.mode}:${st.dir}`; return PLACES.some(p => p.value === exact) ? exact : st.mode === 'gfx' ? 'gfx:' : 'fs:'; };

// ---------- путь файла → что это ----------
// картинка input/ или output/ — её можно бросить на граф (нода «Загрузить картинку»)
function gfxPath(item) {
  return IMG.test(item.path) && /^(input|output)\//.test(item.path) ? item.path : null;
}
const url = item => assetUrl(item.path, 'p');
const fullPath = p => `${S.project?.root || ''}${S.project?.root ? '/' : ''}${p}`.replace(/\//g, S.project?.root?.includes('\\') ? '\\' : '/');
const reveal = p => invoke('fs_reveal', { path: p }).catch(e => emit('log', { src: 'editor', level: 'error', text: `проводник: ${e}` }));
// просмотр картинки: листаются все картинки текущего списка
function preview(item) {
  let imgs = items.filter(x => !x.dir && IMG.test(x.path));
  if (!imgs.some(x => x.path === item.path)) imgs = [item]; // картинка не из текущего списка (Inspector)
  openViewer(imgs.map(x => ({ src: url(x), name: x.path, path: x.path, info: x.size ? fmtSize(x.size) : '' })), Math.max(0, imgs.findIndex(x => x.path === item.path)), {
    actions: it => [{ ic: 'folder', tip: 'Показать в проводнике', fn: () => reveal(it.path) }, { ic: 'locate', tip: 'Выбрать в Project', fn: () => { selectItem(items.find(x => x.path === it.path)); } }],
  });
}
// Enter / двойной щелчок
function activate(item) {
  if (!item) return;
  if (item.dir) return go(item.path);
  const d = !item.gfx && docOf(item.path);
  if (d) return openDoc(d);
  if (IMG.test(item.path)) return preview(item);
}
function selectItem(item) {
  if (!item) return;
  select({ kind: 'file', id: item.path, size: item.size });
  mark(item.path);
  document.querySelector(`#assets .pj-it[data-path="${CSS.escape(item.path)}"]`)?.scrollIntoView({ block: 'nearest' });
}
// JSON данных проекта → документ редактора
function docOf(path) {
  const m = path.match(/^workflows\/([^/]+)\.json$/);
  if (m) return { kind: 'workflow', id: m[1] };
  if (/\.(py|js|mjs|rs|css|html|md|txt)$/i.test(path)) return { kind: 'code', id: path };
  return null;
}
function openDoc(d) {
  if (d.kind === 'code') return emit('open-code', d.id);
  emit('open-workflow', d.id);
}
const DOC_IC = { workflow: 'blueprint', code: 'code' };
const EXT_IC = { json: 'json', py: 'fileTypes/python', js: 'code', mjs: 'code', cjs: 'code', ts: 'code', md: 'fileTypes/markdown', css: 'fileTypes/css', html: 'fileTypes/html',
  txt: 'text', fnt: 'text', lua: 'text', toml: 'fileTypes/yaml', yaml: 'fileTypes/yaml', yml: 'fileTypes/yaml', rs: 'toolwindow/rust', sqlite: 'toolwindow/dbms',
  zip: 'fileTypes/archive', pak: 'fileTypes/archive', svg: 'image', png: 'image', webp: 'image', jpg: 'image' };
const fileIcon = name => EXT_IC[name.split('.').pop().toLowerCase()] || 'fileTypes/unknown';
const fmtSize = n => (n < 1024 ? `${n} Б` : n < 1048576 ? `${(n / 1024).toFixed(1)} КБ` : `${(n / 1048576).toFixed(1)} МБ`);
const projectName = () => S.project?.root?.split(/[\\/]/).filter(Boolean).pop() || 'Проект';

// ---------- элементы ----------
function crumbs() {
  const parts = st.dir ? st.dir.split('/') : [];
  $('pj-crumbs').replaceChildren(
    h('button.b', { 'data-tip': 'Вверх (Backspace)', disabled: !st.dir, onclick: up }, icon('moveUp', { size: 16 })),
    placeDd,
    h(`span.cr${parts.length ? '' : '.last'}`, { onclick: () => go('') }, st.mode === 'gfx' ? 'graphics' : projectName()),
    ...parts.flatMap((p, i) => [h('span.gt', {}, icon('right', { size: 12 })),
      h(`span.cr${i === parts.length - 1 ? '.last' : ''}`, { onclick: () => go(parts.slice(0, i + 1).join('/')) }, p)]));
  $('pj-crumbs').lastElementChild?.scrollIntoView({ inline: 'end', block: 'nearest' });
}

function hl(s) {
  const q = query.trim().toLowerCase().split(/\s+/)[0];
  const i = q ? s.toLowerCase().indexOf(q) : -1;
  return i < 0 ? s : [s.slice(0, i), h('b', {}, s.slice(i, i + q.length)), s.slice(i + q.length)];
}

const isSel = item => S.sel?.kind === 'file' && S.sel.id === item.path;
const smallTiles = () => st.view === 'list' || st.size < 96;

function fileEl(item) {
  const name = base(item.path), img = IMG.test(name), g = gfxPath(item), d = !item.gfx && docOf(item.path);
  const dir = item.path.split('/').slice(0, -1).join('/');
  let th;
  if (img) {
    const im = h('img', { loading: 'lazy', draggable: false, alt: '', decoding: 'async' });
    im.onload = () => { el.dataset.tip = `${item.path}\n${im.naturalWidth}×${im.naturalHeight} px${item.size ? ` · ${fmtSize(item.size)}` : ''}`; };
    im.src = url(item);
    th = h('div.th.img', {}, im);
  } else th = h('div.th', {}, icon(d ? DOC_IC[d.kind] : fileIcon(name), { size: st.view === 'grid' ? Math.min(40, Math.round(st.size * 0.42)) : 16 }));
  const el = h(`div.pj-it.file${isSel(item) ? '.sel' : ''}`, {
    'data-tip': `${item.path}${item.size ? `\n${fmtSize(item.size)}` : ''}${d ? '\nДвойной щелчок — открыть в редакторе' : img ? '\nДвойной щелчок или пробел — просмотр' : ''}`,
    'data-path': item.path, draggable: !!g,
    onclick: () => { select({ kind: 'file', id: item.path, size: item.size }); mark(item.path); },
    ondblclick: () => activate(item),
    ondragstart: e => { if (!g) return; e.dataTransfer.setData('text/mai-file', g); e.dataTransfer.setData('text/plain', g); },
    oncontextmenu: e => ctxMenu(e, item, dir),
  }, th, h('div.nm', {}, h('span.n', {}, hl(name)), query && dir !== st.dir ? h('span.p', {}, dir.slice(st.dir ? st.dir.length + 1 : 0)) : null,
    st.view === 'list' && item.size ? h('span.c', {}, fmtSize(item.size)) : null));
  if (img && smallTiles()) el.dataset.tipImg = url(item); // мелкие плитки и список — превью при наведении
  return el;
}

function dirEl(item) {
  return h('div.pj-it.dir', {
    'data-path': item.path,
    'data-tip': `${st.mode === 'gfx' ? 'graphics/' : ''}${item.path}${item.count ? `\n${item.count} файлов` : ''}`,
    onclick: () => go(item.path), oncontextmenu: e => ctxMenu(e, null, item.path),
  }, h('div.th', {}, icon('folder', { size: st.view === 'grid' ? Math.min(48, Math.round(st.size * 0.45)) : 16 })),
  h('div.nm', {}, h('span.n', {}, hl(base(item.path))), item.count ? h('span.c', {}, item.count) : null));
}

const mark = p => document.querySelectorAll('#assets .pj-it').forEach(x => x.classList.toggle('sel', x.dataset.path === p));

function more() {
  const box = $('assets');
  box.querySelector('.pj-more')?.remove();
  const next = items.slice(shown, shown + CHUNK);
  shown += next.length;
  box.append(...next.map(x => (x.dir ? dirEl(x) : fileEl(x))));
  if (shown < items.length) {
    const s = h('div.pj-more', {}, `ещё ${items.length - shown}…`);
    box.append(s);
    io?.disconnect();
    io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { root: $('pj-body'), rootMargin: '300px' });
    io.observe(s);
  }
}

function render(list, status) {
  items = sorted(list);
  $('pj-count').textContent = status;
  const box = $('assets');
  box.className = `pj-grid ${st.view}`;
  box.style.setProperty('--sz', `${st.size}px`);
  box.replaceChildren();
  shown = 0;
  more();
  if (!items.length) box.append(h('div.pj-empty', {}, icon(query ? 'search' : 'folder', { size: 16 }), query ? 'Ничего не найдено' : 'Пустая папка'));
}

function countIn(d) { const n = tree.get(d); return n.files.length + [...n.dirs.values()].reduce((s, c) => s + c, 0); }

async function draw() {
  if (!placeDd) return;
  crumbs();
  const my = ++token;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (st.mode === 'gfx') {
    if (!tree) return;
    const node = tree.get(st.dir) || tree.get('');
    if (words.length) {
      const pre = st.dir ? `${st.dir}/` : '';
      const dirs = [...tree.keys()].filter(d => d && d.startsWith(pre) && d !== st.dir && words.every(w => base(d).toLowerCase().includes(w)));
      const files = S.assets.filter(a => a.startsWith(pre) && words.every(w => a.slice(pre.length).toLowerCase().includes(w)));
      return render([...dirs.slice(0, 50).map(d => ({ dir: true, path: d, count: countIn(d) })), ...files.map(path => ({ path, gfx: true }))],
        `Найдено: ${files.length} файлов${dirs.length ? `, ${dirs.length} папок` : ''} в graphics/${st.dir}`);
    }
    return render([...[...node.dirs].sort((a, b) => a[0].localeCompare(b[0])).map(([d, count]) => ({ dir: true, path: join(st.dir, d), count })), ...node.files.map(path => ({ path, gfx: true }))],
      `${node.dirs.size ? `${node.dirs.size} папок · ` : ''}${node.files.length} файлов · слои custom → game`);
  }
  try {
    if (words.length) {
      $('pj-count').textContent = 'Поиск…';
      const found = await invoke('fs_search', { path: st.dir, query, limit: 2000 });
      if (my !== token) return;
      const dirs = found.filter(p => p.endsWith('/')).map(p => ({ dir: true, path: p.slice(0, -1) }));
      const files = found.filter(p => !p.endsWith('/')).map(path => ({ path }));
      return render([...dirs, ...files], `Найдено: ${files.length} файлов${dirs.length ? `, ${dirs.length} папок` : ''}${found.length >= 2000 ? ' (первые 2000)' : ''} в ${st.dir || projectName()}`);
    }
    if (!listing.has(st.dir)) listing.set(st.dir, await invoke('fs_list', { path: st.dir }));
    if (my !== token) return;
    const list = listing.get(st.dir).filter(e => !e.name.startsWith('.')); // служебные .git/.kilo/… не показываем
    const nd = list.filter(e => e.dir).length;
    render(list.map(e => ({ dir: e.dir, path: join(st.dir, e.name), size: e.size, mtime: e.mtime })), `${nd ? `${nd} папок · ` : ''}${list.length - nd} файлов`);
  } catch (e) {
    if (my !== token) return;
    if (st.dir) { listing.delete(st.dir); return go(''); } // папки больше нет — в корень
    render([], `Ошибка: ${e}`);
  }
}

function ctxMenu(e, item, dir) {
  e.stopPropagation();
  const copy = t => navigator.clipboard?.writeText(t);
  const d = item && !item.gfx && docOf(item.path), img = item && IMG.test(item.path);
  if (item) { select({ kind: 'file', id: item.path, size: item.size }); mark(item.path); }
  popup(e, item ? [
    d ? { ic: 'open', label: 'Открыть в редакторе', sc: 'Enter', fn: () => openDoc(d) } : null,
    img ? { ic: 'show', label: 'Просмотр', sc: 'Пробел', fn: () => preview(item) } : null,
    img ? { ic: 'copy', label: 'Копировать изображение', fn: () => copyImage(url(item)) } : null,
    '-',
    query ? { ic: 'locate', label: 'Показать в папке', fn: () => { go(dir); setTimeout(() => selectItem(items.find(x => x.path === item.path)), 80); } } : null,
    { ic: 'folder', label: 'Показать в проводнике', fn: () => reveal(item.path) },
    { ic: 'copy', label: 'Копировать путь', fn: () => copy(item.path) },
    { ic: 'copy', label: 'Копировать полный путь', fn: () => copy(fullPath(item.path)) },
  ] : [
    { ic: 'open', label: 'Открыть папку', fn: () => go(dir) },
    { ic: 'folder', label: 'Показать в проводнике', fn: () => reveal(dir || '') },
    { ic: 'copy', label: 'Копировать путь папки', fn: () => copy(dir) },
  ]);
}

// меню пустого места: обновить, вид, сортировка
function bgMenu(e) {
  if (e.target.closest('.pj-it')) return;
  const sort = s => ({ ic: st.sort === s.value ? 'check' : null, label: s.label, fn: () => { st.sort = s.value; keep(); sortDd.value = s.value; draw(); } });
  popup(e, [
    { ic: 'refresh', label: 'Обновить', fn: () => loadAssets(true) },
    { ic: 'folder', label: 'Показать папку в проводнике', fn: () => reveal(st.dir || '') },
    st.dir ? { ic: 'moveUp', label: 'Вверх', sc: 'Backspace', fn: up } : null,
    '-',
    { ic: st.view === 'grid' ? 'check' : 'grid', label: 'Плитки', fn: () => setView('grid') },
    { ic: st.view === 'list' ? 'check' : 'general/listFiles', label: 'Список', fn: () => setView('list') },
    '-',
    ...SORTS.map(sort),
  ]);
}
let sortDd = null, setView = () => {};

// стрелки — выбор (в плитках ↑/↓ — на ряд), Enter — открыть, пробел — просмотр картинки
function navKey(e) {
  const els = [...document.querySelectorAll('#assets .pj-it')];
  if (!els.length) return false;
  const cur = els.findIndex(x => x.classList.contains('sel'));
  let i = cur;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
    const cols = st.view === 'grid' ? Math.max(1, els.filter(x => x.offsetTop === els[0].offsetTop).length) : 1;
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols }[e.key];
    i = e.key === 'Home' ? 0 : e.key === 'End' ? els.length - 1 : cur < 0 ? 0 : Math.max(0, Math.min(els.length - 1, cur + step));
    const it = items.find(x => x.path === els[i].dataset.path);
    if (it?.dir) { document.querySelectorAll('#assets .pj-it').forEach(x => x.classList.toggle('sel', x === els[i])); els[i].scrollIntoView({ block: 'nearest' }); }
    else selectItem(it);
    return true;
  }
  const it = cur >= 0 ? items.find(x => x.path === els[cur].dataset.path) : null;
  if (e.key === 'Enter') { activate(it); return true; }
  if (e.key === ' ' && it && IMG.test(it.path)) { preview(it); return true; }
  return false;
}

// инспектор файла проекта (не картинки graphics)
function fileInspector(s) {
  const name = base(s.id), d = docOf(s.id), img = IMG.test(name), dims = h('div.hint');
  return [
    h('h3', {}, icon(d ? DOC_IC[d.kind] : fileIcon(name), { size: 16 }), name),
    h('div.hint.mono', { style: { userSelect: 'text' } }, s.id),
    s.size ? h('div.hint', {}, fmtSize(s.size)) : null,
    img ? dims : null,
    img ? h('div.preview', { 'data-tip': 'Щелчок — просмотр' }, h('img', { src: assetUrl(s.id, 'p'), alt: s.id,
      onload: e => { dims.textContent = `${e.target.naturalWidth}×${e.target.naturalHeight} px`; } })) : null,
    h('div.row', { style: { marginTop: '8px', flexWrap: 'wrap' } },
      d ? h('button.primary', { onclick: () => openDoc(d) }, icon('open', { size: 14 }), 'Открыть в редакторе') : null,
      img ? h('button.primary', { onclick: () => preview(items.find(x => x.path === s.id) || { path: s.id }) }, icon('show', { size: 14 }), 'Просмотр') : null,
      h('button', { onclick: () => reveal(s.id) }, icon('folder', { size: 14 }), 'В проводнике'),
      h('button', { onclick: () => navigator.clipboard?.writeText(s.id) }, icon('copy', { size: 14 }), 'Копировать путь')),
  ];
}

export function initProject() {
  placeDd = dropdown(placeOf(), PLACES, v => { const [m, d] = v.split(':'); go(d, m); }, { link: true, filter: false });
  placeDd.classList.add('place');
  placeDd.dataset.tip = 'Место: весь проект, workflows, input, output, custom_nodes…';
  const s = search({ placeholder: 'Поиск в папке…', onInput: debounce(v => { query = v; draw(); $('pj-body').scrollTop = 0; }, 200) });
  s.classList.add('grow');
  clearQuery = () => { s.input.value = ''; s.input.dispatchEvent(new Event('input')); query = ''; draw(); };
  const seg = h('div.ui-seg');
  setView = v => { st.view = v; keep(); seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === v)); draw(); };
  const viewBtn = (v, ic, tip) => h(`button${st.view === v ? '.on' : ''}`, { 'data-v': v, 'data-tip': tip, onclick: () => setView(v) }, icon(ic, { size: 14 }));
  seg.append(viewBtn('grid', 'grid', 'Плитки'), viewBtn('list', 'general/listFiles', 'Список'));
  sortDd = dropdown(st.sort, SORTS, v => { st.sort = v; keep(); draw(); }, { link: true, filter: false });
  sortDd.dataset.tip = 'Сортировка (папки — всегда сверху)';
  $('pj-bar').replaceChildren(s, sortDd, seg,
    h('button.icon', { 'data-tip': 'Обновить', onclick: () => loadAssets(true) }, icon('refresh', { size: 16 })));
  const range = h('input.ui-range', { type: 'range', min: 48, max: 160, step: 4, value: st.size, 'data-tip': 'Размер плиток (Ctrl+колесо)' });
  const resize = () => { $('assets').style.setProperty('--sz', `${st.size}px`); keep(); };
  range.addEventListener('input', () => { st.size = Number(range.value); resize(); });
  range.addEventListener('change', () => draw()); // превью при наведении зависит от размера
  $('pj-foot').replaceChildren(h('span.grow#pj-count'), icon('image', { size: 14 }), range);
  const body = $('pj-body');
  body.addEventListener('wheel', e => {
    if (!e.ctrlKey || st.view !== 'grid') return;
    e.preventDefault();
    st.size = Math.max(48, Math.min(160, st.size + (e.deltaY < 0 ? 8 : -8)));
    range.value = st.size; resize();
  }, { passive: false });
  body.tabIndex = 0;
  body.addEventListener('keydown', e => {
    if (e.target.closest('input, textarea')) return;
    // обработанные клавиши не уходят дальше (пробел открыл бы поиск нод графа, Backspace — удалил ноду)
    if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); e.stopPropagation(); up(); return; }
    if (navKey(e)) { e.preventDefault(); e.stopPropagation(); }
  });
  body.addEventListener('contextmenu', bgMenu);
  body.addEventListener('pointerdown', () => body.focus({ preventScroll: true }));
  registerInspector('file', fileInspector);
  draw();
}

// спрайт сцены хранится без расширения .png (как в рантайме ui.js)
export const spriteOf = asset => asset.replace(/\.png$/i, '');
