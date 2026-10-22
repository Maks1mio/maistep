// Project: проводник проекта maistep (workflows, input, output, custom_nodes, server, …). Хлебные крошки, папки,
// плитки или список, поиск по папке и вложенным, размер плиток (ползунок, Ctrl+колесо), подгрузка при прокрутке,
// превью картинок при наведении. Щелчок — Inspector; двойной щелчок по воркфлоу — открыть граф, по .py — CodeEditor;
// картинку можно перетащить на граф (нода «Загрузить картинку»); ПКМ — меню.
import { h, debounce } from './util.js';
import { S, emit, select } from './store.js';
import { invoke, assetUrl } from './api.js';
import { icon } from './icons.js';
import { search, dropdown } from './kit.js';
import { registerInspector } from './inspector.js';
import { showView } from './dock.js';

const LS = 'maistep-project';
const st = (() => { try { return { dir: '', view: 'grid', size: 84, ...JSON.parse(localStorage.getItem(LS)), mode: 'fs' }; } catch { return { mode: 'fs', dir: '', view: 'grid', size: 84 }; } })();
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
    'data-tip': `${item.path}${item.size ? `\n${fmtSize(item.size)}` : ''}${d ? '\nДвойной щелчок — открыть в редакторе' : ''}`,
    'data-path': item.path, draggable: !!g,
    onclick: () => { select({ kind: 'file', id: item.path, size: item.size }); mark(item.path); },
    ondblclick: () => d && openDoc(d),
    ondragstart: e => { if (!g) return; e.dataTransfer.setData('text/mai-file', g); e.dataTransfer.setData('text/plain', g); },
    oncontextmenu: e => ctxMenu(e, item, dir),
  }, th, h('div.nm', {}, h('span.n', {}, hl(name)), query && dir !== st.dir ? h('span.p', {}, dir.slice(st.dir ? st.dir.length + 1 : 0)) : null,
    st.view === 'list' && item.size ? h('span.c', {}, fmtSize(item.size)) : null));
  if (img && smallTiles()) el.dataset.tipImg = url(item); // мелкие плитки и список — превью при наведении
  return el;
}

function dirEl(item) {
  return h('div.pj-it.dir', {
    'data-tip': `${st.mode === 'gfx' ? 'graphics/' : ''}${item.path}${item.count ? `\n${item.count} файлов` : ''}`,
    onclick: () => go(item.path), oncontextmenu: e => ctxMenu(e, null, item.path),
  }, h('div.th', {}, icon('folder', { size: st.view === 'grid' ? Math.min(48, Math.round(st.size * 0.45)) : 16 })),
  h('div.nm', {}, h('span.n', {}, hl(base(item.path))), item.count ? h('span.c', {}, item.count) : null));
}

const mark = p => document.querySelectorAll('#assets .pj-it.file').forEach(x => x.classList.toggle('sel', x.dataset.path === p));

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
  items = list;
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
    render(list.map(e => ({ dir: e.dir, path: join(st.dir, e.name), size: e.size })), `${nd ? `${nd} папок · ` : ''}${list.length - nd} файлов`);
  } catch (e) {
    if (my !== token) return;
    if (st.dir) { listing.delete(st.dir); return go(''); } // папки больше нет — в корень
    render([], `Ошибка: ${e}`);
  }
}

function ctxMenu(e, item, dir) {
  e.preventDefault();
  document.querySelector('.pj-ctx')?.remove();
  const copy = t => navigator.clipboard?.writeText(t);
  const it = (ic, label, fn) => h('div.item', { onclick: () => { m.remove(); fn(); } }, h('span.ic', {}, icon(ic, { size: 16 })), h('span', {}, label));
  const g = item && gfxPath(item), d = item && !item.gfx && docOf(item.path);
  const m = h('div.ui-menu.pj-ctx', {},
    d ? it('open', 'Открыть в редакторе', () => openDoc(d)) : null,
    item ? it('copy', 'Копировать путь', () => copy(item.path)) : null,
        item && query ? it('folder', 'Показать в папке', () => { go(dir); setTimeout(() => mark(item.path), 50); }) : null,
    !item ? it('open', 'Открыть папку', () => go(dir)) : null,
    !item ? it('copy', 'Копировать путь папки', () => copy(dir)) : null);
  document.body.append(m);
  m.style.cssText = `position:fixed;z-index:500;min-width:220px;left:${Math.min(e.clientX, innerWidth - 240)}px;top:${Math.min(e.clientY, innerHeight - m.offsetHeight - 8)}px`;
  const off = ev => { if (!m.contains(ev.target)) { m.remove(); removeEventListener('pointerdown', off, true); } };
  addEventListener('pointerdown', off, true);
}

// инспектор файла проекта (не картинки graphics)
function fileInspector(s) {
  const name = base(s.id), d = docOf(s.id), img = IMG.test(name);
  return [
    h('h3', {}, icon(d ? DOC_IC[d.kind] : fileIcon(name), { size: 16 }), name),
    h('div.hint.mono', { style: { userSelect: 'text' } }, s.id),
    s.size ? h('div.hint', {}, fmtSize(s.size)) : null,
    img ? h('div.preview', {}, h('img', { src: assetUrl(s.id, 'p'), alt: '' })) : null,
    h('div.row', { style: { marginTop: '8px', flexWrap: 'wrap' } },
      d ? h('button.primary', { onclick: () => openDoc(d) }, icon('open', { size: 14 }), 'Открыть в редакторе') : null,
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
  const viewBtn = (v, ic, tip) => h(`button${st.view === v ? '.on' : ''}`, { 'data-tip': tip, onclick: e => { st.view = v; keep(); e.currentTarget.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); draw(); } }, icon(ic, { size: 14 }));
  $('pj-bar').replaceChildren(s,
    h('div.ui-seg', {}, viewBtn('grid', 'grid', 'Плитки'), viewBtn('list', 'general/listFiles', 'Список')),
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
    if (e.key === 'Backspace' || (e.altKey && e.key === 'ArrowUp')) { e.preventDefault(); up(); }
  });
  registerInspector('file', fileInspector);
  draw();
}

// спрайт сцены хранится без расширения .png (как в рантайме ui.js)
export const spriteOf = asset => asset.replace(/\.png$/i, '');
