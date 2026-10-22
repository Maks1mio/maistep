// CodeEditor: рабочая область редактора кода (в духе JetBrains Rider). Свои ноды custom_nodes/, встроенные ноды и сервер
// server/, UI app/ui/js, ядро app/src-tauri/src; подсветка Python/JS/Rust, номера строк, автодополнение (Ctrl+Space),
// переход к определению (F12 / Ctrl+клик), хлебные крошки со символом под курсором, поиск по файлу (Ctrl+F).
// У файлов нод сверху — «Сохранить и перезагрузить ноды»: сервер перечитывает custom_nodes/ без перезапуска.
// Чтение/запись — ядро (fs_read/fs_write): Tauri или dev-server. Правки на диске — без undo-стека store.
import { h } from './util.js';
import { icon } from './icons.js';
import { S, on, emit, select } from './store.js';
import { invoke } from './api.js';
import { showView } from './dock.js';
import { registerInspector } from './inspector.js';
import { reloadNodes } from './backend.js';

// ---------- файлы проекта ----------
const ROOTS = [
  { path: 'custom_nodes', label: 'custom_nodes', ext: /\.py$/i },
  { path: 'server/nodes', label: 'server/nodes', ext: /\.py$/i },
  { path: 'server/maistep', label: 'server/maistep', ext: /\.py$/i },
  { path: 'server', label: 'server', ext: /\.py$/i },
  { path: 'app/ui/js', label: 'app/ui/js', ext: /\.(js|mjs)$/i },
  { path: 'app/src-tauri/src', label: 'app/src-tauri/src', ext: /\.rs$/i },
];
const files = new Map(); // path → { text, saved, symbols: [{name,line,kind,parent}], imports: [{names,from}] }
const index = [];        // глобальный указатель: { name, path, line, kind }
let allFiles = [], tabs = [], active = null, navBack = [];

const isCode = p => /\.(js|mjs|rs|py)$/i.test(p);
const isPy = p => /\.py$/i.test(p);

// ---------- разбор файла: символы и импорты ----------
const NOTSYM = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'do', 'else', 'try', 'typeof', 'new', 'delete']);
function parsePy(text) {
  const symbols = [], imports = [];
  let cls = null;
  text.split('\n').forEach((ln, line) => {
    let m;
    if ((m = ln.match(/^from\s+([\w.]+)\s+import\s+(.+)$/))) { imports.push({ names: m[2].split(',').map(x => x.trim().split(/\s+as\s+/).pop()).filter(Boolean), from: m[1] }); return; }
    if ((m = ln.match(/^import\s+(.+)$/))) { imports.push({ names: m[1].split(',').map(x => x.trim().split(/\s+as\s+/).pop()), from: m[1] }); return; }
    if ((m = ln.match(/^class\s+(\w+)/))) { cls = m[1]; symbols.push({ name: m[1], line, kind: 'class' }); return; }
    if ((m = ln.match(/^def\s+(\w+)/))) { cls = null; symbols.push({ name: m[1], line, kind: 'fn' }); return; }
    if ((m = ln.match(/^\s+def\s+(\w+)/)) && cls) { symbols.push({ name: m[1], line, kind: 'fn', parent: cls }); return; }
    if ((m = ln.match(/^@node\(\s*["']([\w.]+)["']/))) { symbols.push({ name: m[1], line, kind: 'prop' }); return; }
    if ((m = ln.match(/^([A-Z_][A-Z0-9_]*)\s*=/))) symbols.push({ name: m[1], line, kind: 'var' });
  });
  return { symbols, imports };
}

function parse(text, path = '') {
  if (isPy(path)) return parsePy(text);
  const symbols = [], imports = [];
  let parent = null;
  text.split('\n').forEach((ln, line) => {
    let m;
    if ((m = ln.match(/^\s*import\s+(?:([\w$]+)\s*,\s*)?(?:\{([^}]*)\}|\*\s+as\s+([\w$]+)|([\w$]+))?\s*from\s*['"]([^'"]+)['"]/))) {
      const names = [];
      if (m[1]) names.push(m[1]);
      if (m[2]) names.push(...m[2].split(',').map(s => s.trim().split(/\s+as\s+/).pop()).filter(Boolean));
      if (m[3]) names.push(m[3]);
      if (m[4]) names.push(m[4]);
      imports.push({ names, from: m[5] });
      return;
    }
    if (/^\s*(?:export\s+)?const\s+[\w$]+\s*=\s*\{\s*$/.test(ln)) { parent = ln.match(/const\s+([\w$]+)/)[1]; return; }
    if (/^\s*\}\s*;?\s*$/.test(ln) && parent) { parent = null; return; }
    const ind = (ln.match(/^\s*/) || [''])[0].length;
    if ((m = ln.match(/^\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/))) symbols.push({ name: m[1], line, kind: 'fn' });
    else if ((m = ln.match(/^\s*(?:export\s+)?class\s+([\w$]+)/))) symbols.push({ name: m[1], line, kind: 'class' });
    else if (ind <= 2 && (m = ln.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)/))) symbols.push({ name: m[1], line, kind: 'var' });
    else if (ind <= 2 && (m = ln.match(/^\s*(?:export\s+)?(?:const|let|var)\s*\{\s*([^}]+)\}\s*=/))) {
      for (const s of m[1].split(',')) { const n = s.trim().split(/\s+as\s+/).pop(); if (n) symbols.push({ name: n, line, kind: 'var' }); }
    } else if ((m = ln.match(/^(\s{1,6})(?:async\s+)?([\w$]+)\s*\([^)]*\)\s*\{\s*$/)) && !NOTSYM.has(m[2])) symbols.push({ name: m[2], line, kind: 'fn', parent });
    else if ((m = ln.match(/^(\s{1,6})([\w$]+)\s*\([^)]*\)\s*\{/)) && parent && !NOTSYM.has(m[2])) symbols.push({ name: m[2], line, kind: 'fn', parent });
  });
  return { symbols, imports };
}

async function loadFile(path, { keep = false } = {}) {
  if (files.has(path)) return files.get(path);
  const text = await invoke('fs_read', { path });
  const f = { text, saved: text, ...parse(text, path) };
  files.set(path, f);
  for (const s of f.symbols) index.push({ ...s, path });
  return f;
}

async function discover() {
  const out = [];
  for (const r of ROOTS) {
    let list = [];
    try { list = await invoke('fs_list', { path: r.path }); } catch { continue; }
    for (const e of list) if (!e.dir && r.ext.test(e.name)) out.push(`${r.path}/${e.name}`);
  }
  return out;
}

// ---------- дерево в Hierarchy ----------
export function codeTreeItems() {
  const rows = [];
  for (const r of ROOTS) {
    const list = allFiles.filter(p => p.startsWith(`${r.path}/`) && !p.slice(r.path.length + 1).includes("/"));
    rows.push({ ic: 'folder', label: r.label, tag: String(list.length), title: r.path });
    for (const p of list) {
      const f = files.get(p);
      rows.push({
        depth: 1, ic: p.endsWith('.py') ? 'python' : p.endsWith('.css') ? 'text' : 'code',
        label: p.split('/').pop(), tag: f && f.text !== f.saved ? '●' : '',
        sel: S.sel?.kind === 'code' && S.sel.id === p,
        title: p,
        onClick: () => openFile(p),
      });
    }
  }
  return rows;
}

// ---------- подсветка синтаксиса ----------
const KW = new Set(('const let var function return if else for while do of in new class extends super this null undefined true false '
  + 'import from export default async await try catch finally throw typeof instanceof delete void yield static get set').split(' '));
const PYKW = new Set(('def class return if elif else for while in not and or is None True False import from as try except finally raise with '
  + 'lambda yield pass break continue global nonlocal assert del async await self').split(' '));
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const span = (cls, t) => `<span class="${cls}">${esc(t)}</span>`;

function highlight(src, path) {
  const isCss = /\.css$/i.test(path), isHtml = /\.html?$/i.test(path), isJson = /\.json$/i.test(path), py = isPy(path);
  let out = '', last = 0, m;
  const plain = t => { if (t) out += esc(t); };
  const re = isHtml
    ? /(<!--[\s\S]*?-->)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(<\/?[\w-]+|\/?>)|([\w-]+)(?==)/g
    : py ? /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|[rfbu]?'(?:\\.|[^'\\\n])*'|[rfbu]?"(?:\\.|[^"\\\n])*")|(\b\d[\w.]*)|([A-Za-z_@][\w]*)|([^\sA-Za-z_\d])/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|--[^\n]*)|(`(?:\\.|[^`\\])*`|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")|(\b\d[\w.]*)|([A-Za-z_$][\w$]*)|([^\sA-Za-z_$\d])/g;
  while ((m = re.exec(src))) {
    plain(src.slice(last, m.index));
    last = re.lastIndex;
    const t = m[0];
    if (isHtml) {
      if (m[1]) out += span('c-com', t);
      else if (m[2]) out += span('c-str', t);
      else if (m[3]) out += span('c-fn', t);
      else if (m[4]) out += span('c-type', t);
      else plain(t);
    } else if (m[1]) out += span('c-com', t);
    else if (m[2]) out += span('c-str', t);
    else if (m[3]) out += span('c-num', t);
    else if (m[4]) {
      if (py ? PYKW.has(t) || t.startsWith('@') : !isCss && !isJson && KW.has(t)) out += span('c-kw', t);
      else if (!isCss && !isJson && src[re.lastIndex] === '(') out += span('c-fn', t);
      else if (/^[A-Z]/.test(t)) out += span('c-type', t);
      else out += esc(t);
    } else {
      if (isCss && t === ':' && src[re.lastIndex] !== ':') out += span('c-kw', t);
      else out += esc(t);
    }
  }
  plain(src.slice(last));
  return out;
}

// ---------- вид рабочей области ----------
let root = null, ta = null, hlCode = null, gutter = null, crumbs = null, tabbar = null;
let prevWrap = null, prevFrame = null, prevBtns = null, findBar = null, findInput = null, findInfo = null;
let acBox = null, acItems = [], acWord = '';
let lineH = 18, chW = 7.2;

function lineCol() {
  const upto = ta.value.slice(0, ta.selectionStart);
  const lines = upto.split('\n');
  return { line: lines.length - 1, col: lines[lines.length - 1].length };
}

function paint() {
  if (!ta) return;
  hlCode.innerHTML = highlight(ta.value + '\n', active || '') ;
  const n = ta.value.split('\n').length;
  gutter.innerHTML = Array.from({ length: n }, (_, i) => `<div class="ln${i === lineCol().line ? ' cur' : ''}">${i + 1}</div>`).join('');
  syncScroll();
  paintCrumbs();
}

function syncScroll() {
  hlCode.parentElement.scrollTop = ta.scrollTop;
  hlCode.parentElement.scrollLeft = ta.scrollLeft;
  gutter.scrollTop = ta.scrollTop;
}

function paintCrumbs() {
  if (!crumbs || !active) return;
  const { line } = lineCol();
  const f = files.get(active);
  const parts = active.split('/');
  crumbs.replaceChildren();
  parts.forEach((seg, i) => {
    if (i) crumbs.append(h('span.sep', {}, '›'));
    crumbs.append(h('span.seg', { class: i === parts.length - 1 ? 'cur' : '', onclick: () => openFile(active) }, seg));
  });
  const sym = [...(f?.symbols || [])].reverse().find(s => s.line <= line);
  if (sym) {
    crumbs.append(h('span.sep', {}, '›'));
    crumbs.append(h('span.seg.sym', { onclick: () => gotoLine(sym.line) }, sym.parent ? `${sym.parent}.${sym.name}` : sym.name));
  }
}

function gotoLine(line, col = 0) {
  const lines = ta.value.split('\n');
  const pos = lines.slice(0, line).reduce((a, l) => a + l.length + 1, 0) + col;
  ta.focus();
  ta.setSelectionRange(pos, pos);
  ta.scrollTop = Math.max(0, line * lineH - ta.clientHeight / 3);
  paint();
}

async function openFile(path, line = null) {
  if (!path) return;
  let f;
  try { f = await loadFile(path); } catch (e) { emit('log', { src: 'editor', level: 'error', text: `${path}: ${e}` }); return; }
  if (active && active !== path) navBack.push({ path: active, ...lineCol() });
  active = path;
  if (!tabs.includes(path)) tabs.push(path);
  ta.value = f.text;
  renderTabs();
  renderPreviewBar();
  paint();
  if (line != null) gotoLine(line);
  else { ta.scrollTop = 0; syncScroll(); }
  select({ kind: 'code', id: path, line: 0 });
}

function renderTabs() {
  tabbar.replaceChildren(...tabs.map(p => h(`div.ctab${p === active ? '.on' : ''}`, {
    onclick: () => openFile(p),
    onauxclick: e => { if (e.button === 1) closeTab(p); },
    title: p,
  }, h('span', {}, p.split('/').pop()), h('span.x', { onclick: e => { e.stopPropagation(); closeTab(p); } }, '×'))));
}

function closeTab(p) {
  tabs = tabs.filter(t => t !== p);
  if (active === p) active = tabs[tabs.length - 1] || null;
  if (active) openFile(active); else { ta.value = ''; renderTabs(); paint(); renderPreviewBar(); }
}

// ---------- файлы нод: сохранить и перезагрузить ноды на сервере ----------
const isNodeCode = () => /^(custom_nodes|server\/nodes)\/.+\.py$/.test(active || '');

function renderPreviewBar() {
  if (!prevWrap) return;
  prevWrap.classList.add('off');
  prevBtns.replaceChildren();
  if (!isNodeCode()) return;
  prevBtns.append(icon('python', { size: 14 }), h('span.dim', {}, 'Файл нод:'),
    h('button.primary', { onclick: async () => { await saveActive(); if (S.server.running) reloadNodes(); else emit('log', { src: 'editor', level: 'warn', text: 'сервер не запущен — ноды подхватятся при старте' }); } },
      icon('refresh', { size: 14 }), 'Сохранить и перезагрузить ноды'),
    h('span.dim', {}, 'API нод — server/maistep/__init__.py'));
}

// ---------- автодополнение ----------
const BUILTINS = ['document', 'window', 'console', 'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Promise',
  'Map', 'Set', 'Date', 'RegExp', 'Error', 'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'fetch', 'localStorage',
  'getComputedStyle', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'postMessage', 'structuredClone', 'parseInt', 'parseFloat'];

function wordAt(pos = ta.selectionStart) {
  const before = ta.value.slice(0, pos);
  const m = before.match(/[\w$]+$/) || [''];
  return m[0];
}

function memberCtx() {
  const before = ta.value.slice(0, ta.selectionStart - wordAt().length);
  const m = before.match(/([\w$]+)\.\s*$/);
  return m ? m[1] : null;
}

function completions(prefix, obj) {
  const names = new Set();
  if (obj) {
    for (const s of index) if (s.parent === obj) names.add(s.name);
    const f = files.get(active);
    for (const s of f?.symbols || []) if (s.parent === obj) names.add(s.name);
  } else {
    for (const s of index) names.add(s.name);
    const f = files.get(active);
    for (const s of f?.symbols || []) names.add(s.name);
    for (const b of BUILTINS) names.add(b);
    for (const ch of ta.value.matchAll(/[\w$]+/g)) names.add(ch[0]);
    for (const imp of f?.imports || []) for (const n of imp.names) names.add(n);
  }
  return [...names].filter(n => n.startsWith(prefix) && n !== prefix).sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 40);
}

function showAc() {
  const obj = memberCtx(), word = wordAt();
  acItems = completions(word, obj);
  acWord = word;
  if (!acItems.length) return hideAc();
  acBox.dataset.mode = 'ac';
  acBox.replaceChildren(...acItems.map((n, i) => h(`div.aci${i === 0 ? '.on' : ''}`, {
    onmousedown: e => { e.preventDefault(); applyAc(n); },
    onmouseenter: () => { acBox.querySelectorAll('.aci').forEach(x => x.classList.remove('on')); acBox.children[i].classList.add('on'); },
  }, icon('code', { size: 12 }), h('span', {}, n))));
  const { line, col } = lineCol();
  acBox.style.left = `${Math.min(ta.clientWidth - 180, 34 + col * chW - ta.scrollLeft)}px`;
  acBox.style.top = `${line * lineH - ta.scrollTop + 26}px`;
  acBox.classList.add('on');
}

function hideAc() { acBox?.classList.remove('on'); acItems = []; }

function applyAc(name) {
  const from = ta.selectionStart - acWord.length;
  ta.setRangeText(name, from, ta.selectionStart, 'end');
  hideAc();
  paint();
  markDirty();
}

function acKey(e) {
  if (!acBox.classList.contains('on')) return false;
  // попап перехода к определению: Enter — первый пункт, Escape — закрыть
  if (acBox.dataset.mode === 'def') {
    if (e.key === 'Escape') { hideAc(); return true; }
    if (e.key === 'Enter') { e.preventDefault(); acBox.querySelector('.aci.on')?.dispatchEvent(new MouseEvent('mousedown')); return true; }
    return false;
  }
  const list = [...acBox.querySelectorAll('.aci')];
  const i = list.findIndex(x => x.classList.contains('on'));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    list[i]?.classList.remove('on');
    list[(i + (e.key === 'ArrowDown' ? 1 : list.length - 1)) % list.length]?.classList.add('on');
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyAc(list[i >= 0 ? i : 0]?.textContent?.trim() || acItems[0]); return true; }
  if (e.key === 'Escape') { hideAc(); return true; }
  return false;
}

// ---------- переход к определению ----------
function gotoDef() {
  const w = wordAt();
  if (!w) return;
  const hits = index.filter(s => s.name === w || s.name === `${memberCtx()}.${w}`);
  if (!hits.length) return emit('log', { src: 'editor', level: 'warn', text: `определение «${w}» не найдено` });
  if (hits.length === 1) return jump(hits[0]);
  acWord = '';
  acItems = hits.map(x => x.name);
  acBox.dataset.mode = 'def';
  acBox.replaceChildren(...hits.map((x, i) => h(`div.aci${i === 0 ? '.on' : ''}`, {
    onmousedown: e => { e.preventDefault(); jump(x); },
  }, icon('code', { size: 12 }), h('span', {}, `${x.parent ? x.parent + '.' : ''}${x.name} — ${x.path}:${x.line + 1}`))));
  const { line, col } = lineCol();
  acBox.style.left = `${Math.min(ta.clientWidth - 260, 34 + col * chW - ta.scrollLeft)}px`;
  acBox.style.top = `${line * lineH - ta.scrollTop + 26}px`;
  acBox.classList.add('on');
}

function jump(hit) {
  hideAc();
  navBack.push({ path: active, ...lineCol() });
  openFile(hit.path, hit.line);
}

function jumpBack() {
  const prev = navBack.pop();
  if (!prev) return;
  openFile(prev.path).then(() => gotoLine(prev.line, prev.col));
}

// ---------- правка и сохранение ----------
function markDirty() {
  const f = files.get(active);
  if (!f) return;
  f.text = ta.value;
  renderTabs();
  emit('change', { kind: 'code', id: active });
}

async function saveActive() {
  const f = files.get(active);
  if (!f) return;
  f.text = ta.value;
  try {
    await invoke('fs_write', { path: active, text: f.text });
    f.saved = f.text;
    const parsed = parse(f.text, active);
    f.symbols = parsed.symbols; f.imports = parsed.imports;
    for (let i = index.length - 1; i >= 0; i--) if (index[i].path === active) index.splice(i, 1);
    for (const s of f.symbols) index.push({ ...s, path: active });
    renderTabs();
    emit('log', { src: 'editor', level: 'info', text: `сохранено: ${active}` });
    emit('saved', { kind: 'code', id: active });
  } catch (e) {
    emit('log', { src: 'editor', level: 'error', text: `не удалось сохранить ${active}: ${e}` });
  }
}

function reloadActive() {
  if (!active) return;
  files.delete(active);
  openFile(active);
}

// ---------- поиск по файлу ----------
function findNext(back = false) {
  const q = findInput.value;
  if (!q) return;
  const text = ta.value.toLowerCase(), from = back ? ta.selectionStart - 1 : ta.selectionEnd;
  let i = back ? text.lastIndexOf(q, Math.max(0, from)) : text.indexOf(q, from);
  if (i < 0) i = back ? text.lastIndexOf(q) : text.indexOf(q);
  if (i < 0) { findInfo.textContent = 'нет совпадений'; return; }
  ta.focus();
  ta.setSelectionRange(i, i + q.length);
  const line = ta.value.slice(0, i).split('\n').length - 1;
  ta.scrollTop = Math.max(0, line * lineH - ta.clientHeight / 3);
  const total = text.split(q).length - 1;
  const cur = ta.value.slice(0, i).toLowerCase().split(q).length;
  findInfo.textContent = `${cur}/${total}`;
  syncScroll();
}

function openFind() {
  findBar.classList.add('on');
  findInput.value = wordAt() || '';
  findInput.focus();
  findInput.select();
  findNext();
}

// ---------- клавиатура редактора ----------
function onKey(e) {
  if (acKey(e)) { e.stopPropagation(); return; }
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); saveActive(); return; }
  if (ctrl && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); openFind(); return; }
  if (ctrl && e.key === ' ') { e.preventDefault(); e.stopPropagation(); showAc(); return; }
  if (e.key === 'F12') { e.preventDefault(); e.stopPropagation(); gotoDef(); return; }
  if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); jumpBack(); return; }
  if (e.key === 'F3') { e.preventDefault(); e.stopPropagation(); findNext(e.shiftKey); return; }
  if (e.key === 'Escape' && findBar.classList.contains('on')) { findBar.classList.remove('on'); ta.focus(); e.stopPropagation(); return; }
  if (e.key === 'Tab') {
    e.preventDefault(); e.stopPropagation();
    const { line } = lineCol(), lines = ta.value.split('\n');
    if (ta.selectionStart === ta.selectionEnd) ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
    else {
      const a = ta.value.slice(0, ta.selectionStart).split('\n').length - 1, b = ta.value.slice(0, ta.selectionEnd).split('\n').length - 1;
      for (let i = a; i <= b; i++) lines[i] = e.shiftKey ? lines[i].replace(/^ {1,2}/, '') : '  ' + lines[i];
      ta.value = lines.join('\n');
    }
    markDirty(); paint();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault(); e.stopPropagation();
    const { line, col } = lineCol(), src = ta.value.split('\n')[line];
    const ind = (src.match(/^\s*/) || [''])[0];
    const add = /[{([]\s*$|=>\s*$|:\s*$/.test(src) ? (isPy(active) ? '    ' : '  ') : '';
    ta.setRangeText('\n' + ind + add, ta.selectionStart, ta.selectionEnd, 'end');
    markDirty(); paint();
    return;
  }
}

// ---------- сборка вида ----------
function build() {
  const v = document.getElementById('v-code');
  if (root) { v.replaceChildren(root); paint(); renderPreviewBar(); return; }
  ta = h('textarea.ce-ta', { spellcheck: false, autocapitalize: 'off', autocomplete: 'off', wrap: 'off' });
  hlCode = h('code');
  gutter = h('div.ce-gutter');
  crumbs = h('div.ce-crumbs');
  tabbar = h('div.ce-tabs');
  acBox = h('div.ce-ac');
  findBar = h('div.ce-find', {},
    icon('target', { size: 14 }),
    findInput = h('input', { type: 'text', spellcheck: false, placeholder: 'Поиск в файле (Enter — следующее, Shift+Enter — назад)', onkeydown: e => { e.stopPropagation(); if (e.key === 'Enter') findNext(e.shiftKey); if (e.key === 'Escape') { findBar.classList.remove('on'); ta.focus(); } } }),
    findInfo = h('span.dim', {}, ''),
    h('button.icon', { onclick: () => findNext(false) }, icon('down', { size: 14 })),
    h('button.icon', { onclick: () => findNext(true) }, icon('up', { size: 14 })),
    h('button.icon', { onclick: () => findBar.classList.remove('on') }, icon('close', { size: 14 })));
  prevBtns = h('div.bar');
  prevWrap = h('div.ce-prev', {}, prevBtns);

  const ed = h('div.ce-ed', {},
    gutter,
    h('div.ce-code', {}, h('pre.ce-hl', {}, hlCode), ta, acBox, findBar));

  root = h('div.ce', {},
    h('div.bar', {},
      h('button', { onclick: saveActive, title: 'Сохранить (Ctrl+S)' }, icon('save', { size: 14 }), 'Сохранить'),
      h('button', { onclick: reloadActive, title: 'Перечитать с диска' }, icon('restart', { size: 14 })),
      h('button', { onclick: openFind, title: 'Поиск (Ctrl+F)' }, icon('search', { size: 14 })),
      h('button', { onclick: gotoDef, title: 'К определению (F12 / Ctrl+клик)' }, icon('target', { size: 14 }), 'К определению'),
      h('button', { onclick: jumpBack, title: 'Назад (Alt+←)' }, icon('left', { size: 14 })),
      crumbs),
    tabbar, prevWrap, ed);
  v.replaceChildren(root);

  ta.addEventListener('keydown', onKey);
  ta.addEventListener('input', () => { markDirty(); paint(); if (!acBox.classList.contains('on') && /[\w$]/.test(ta.value[ta.selectionStart - 1] || '')) showAc(); else hideAc(); });
  ta.addEventListener('click', () => { paint(); hideAc(); });
  ta.addEventListener('keyup', () => paint());
  ta.addEventListener('scroll', syncScroll);
  ta.addEventListener('mousedown', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    gotoDef();
  });

  // ширина символа и строк — измеряются один раз на живом шрифте
  const probe = h('span', { style: { visibility: 'hidden', font: getComputedStyle(ta).font } }, 'X'.repeat(100));
  document.body.append(probe);
  chW = probe.getBoundingClientRect().width / 100;
  lineH = parseFloat(getComputedStyle(ta).lineHeight) || 18;
  probe.remove();
  if (!active && allFiles.includes('custom_nodes/example.py')) openFile('custom_nodes/example.py');
}

// ---------- Inspector: карточка файла и контур ----------
function codeInspector(s) {
  const f = files.get(s.id);
  if (!f) return [h('h3', {}, icon('code', { size: 16 }), s.id || 'файл не открыт')];
  const rows = f.symbols.map(sym => h('div.f', { style: { gridTemplateColumns: '1fr auto', cursor: 'pointer' }, onclick: () => openFile(s.id, sym.line) },
    h('label', {}, h('span.sym-k', {}, sym.kind === 'fn' ? 'ƒ' : sym.kind === 'class' ? 'C' : sym.kind === 'prop' ? 'P' : 'v'), ' ', sym.parent ? `${sym.parent}.${sym.name}` : sym.name),
    h('div.v.dim', {}, String(sym.line + 1))));
  return [
    h('h3', {}, icon('code', { size: 16 }), s.id.split('/').pop()), h('div.hint', {}, s.id),
    h('div.hint', {}, f.text !== f.saved ? '● есть несохранённые правки' : 'сохранено'),
    f.imports.length ? h('h4', {}, 'Зависимости (import)') : null,
    ...f.imports.map(im => h('div.f', {}, h('label', {}, im.names.slice(0, 4).join(', ') + (im.names.length > 4 ? '…' : '')), h('div.v.dim', {}, im.from))),
    h('h4', {}, `Контур (${f.symbols.length})`),
    ...rows,
  ];
}

// ---------- старт ----------
export async function initCodeEditor() {
  registerInspector('code', codeInspector);
  addEventListener('view', e => { if (e.detail === 'code') build(); });
  on('open-code', p => { showView('code'); build(); openFile(p); });
  on('server', () => renderPreviewBar());
  // индекс и дерево файлов: сразу все кодовые файлы проекта (переходы F12 и Ctrl+клик)
  const refresh = async () => {
    allFiles = await discover().catch(() => []);
    for (const p of allFiles.filter(isCode)) loadFile(p).catch(() => {});
    emit('change', { kind: 'code' });
    renderPreviewBar();
    if (!active && allFiles.includes('custom_nodes/example.py') && root) openFile('custom_nodes/example.py');
  };
  on('project', refresh);
  await refresh();
  // обновление хлебных крошек при движении курсора
  document.addEventListener('selectionchange', () => { if (document.activeElement === ta) paintCrumbs(); });
}
