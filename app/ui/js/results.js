// Results: очередь запусков и история с результатами. Вид v-results — галерея: все картинки лентой по дням,
// ряды выровнены по высоте с сохранением пропорций (размер — ползунок), щелчок — просмотр с листанием по всей ленте,
// перетаскивание — в ноды/ImageNaizer (text/mai-file), ПКМ — меню. Режим «Запуски» — карточки с текстами и ошибками.
// Избранное — user/favorites.json (звезда на плитке, «Избранное» в шапке): держится и после того, как запуск ушёл
// из истории (её 200 последних); граф такой картинки берётся из самого PNG (wfimport.js).
// Hierarchy (контекст results) — очередь и список запусков; щелчок — запуск в Inspector, «Открыть граф» — его воркфлоу.
import { h, debounce } from './util.js';
import { S, on, emit, select, addDoc, uniqueId } from './store.js';
import { registerInspector } from './inspector.js';
import { icon } from './icons.js';
import { history, fileUrl, thumbUrl, interrupt, clearQueue } from './backend.js';
import { isShown } from './dock.js';
import { openViewer, copyImage } from './viewer.js';
import { dropdown, search } from './kit.js';
import { popup } from './ctxmenu.js';
import { invoke } from './api.js';
import { graphFromImage, importGraph } from './wfimport.js';

let items = [];
const LS = 'maistep-results';
const DEF = { view: 'gallery', size: 180, wf: '', q: '', filter: 'all', fav: false };
const st = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(LS)) }; } catch { return { ...DEF }; } })();
const keep = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch {} };
// пропорции картинок (ширина/высота) — чтобы ряды не прыгали при повторном показе
const AR_KEY = 'maistep-results-ar';
const ar = (() => { try { return new Map(Object.entries(JSON.parse(localStorage.getItem(AR_KEY)) || {})); } catch { return new Map(); } })();
const keepAr = debounce(() => { try { localStorage.setItem(AR_KEY, JSON.stringify(Object.fromEntries([...ar].slice(-3000)))); } catch {} }, 1000);

// ---------- избранное ----------
const FAV = 'user/favorites.json';
let favs = new Map(); // file → { file, title, at, prompt_id, number, wf, added }
async function loadFavs() {
  try { favs = new Map((JSON.parse(await invoke('fs_read', { path: FAV })) || []).map(f => [f.file, f])); } catch { favs = new Map(); }
}
const saveFavs = debounce(() => invoke('data_write', { path: FAV, value: [...favs.values()], pretty: true })
  .catch(e => emit('log', { src: 'editor', level: 'error', text: `избранное не сохранено: ${e}` })), 300);
const isFav = f => favs.has(f);
function toggleFav(file, it) {
  if (favs.has(file)) favs.delete(file);
  else favs.set(file, { file, title: it.title, at: it.at, prompt_id: it.prompt_id, number: it.number, wf: wfOf(it),
    added: new Date().toLocaleString('sv').slice(0, 19) });
  saveFavs();
  if (st.fav && st.view === 'gallery') return fillBody();
  for (const el of bodyEl?.querySelectorAll('.rg-t') || []) if (el.dataset.file === file) paintFav(el, isFav(file));
}
function paintFav(el, on_) {
  el.classList.toggle('fav', on_);
  const b = el.querySelector('.rg-star');
  if (b) { b.replaceChildren(icon(on_ ? 'starFilled' : 'star', { size: 16 })); b.dataset.tip = on_ ? 'Убрать из избранного' : 'В избранное'; }
}

// граф, на котором сделана картинка, — новым воркфлоу: из PNG (там seed, который выпал), иначе из истории запуска
async function graphOfImage(file, it) {
  const g = await graphFromImage(file);
  if (g) return importGraph(g);
  if (it?.workflow?.nodes) return importGraph({ kind: 'maistep', wf: it.workflow, name: file.split('/').pop() });
  emit('log', { src: 'editor', level: 'warn', text: `${file}: в картинке нет графа (сделана до вшивания графа в PNG), а запуск ушёл из истории` });
}

export async function refresh() {
  if (!S.server.running) { items = []; render(); return; }
  let next = [];
  try { next = await history(200); } catch {}
  const sig = list => list.map(it => `${it.prompt_id}:${it.ok}`).join();
  const same = sig(next) === sig(items) && bodyEl?.isConnected;
  items = next;
  if (!same) render();
  emit('results', items);
}

const outsOf = it => Object.entries(it.outputs || {});
// картинки запуска без дублей: Save Image кладёт копию кадра (VAE Decode → sd_….png, Save → prefix_….png) —
// исходный кадр того, что ушло в Save Image, не показываем нигде в запуске (Preview на том же Decode — тоже он),
// остаётся сохранённая копия
const filesOf = o => [...(o?._ui?.images || []), ...Object.values(o || {}).filter(v => v?.image).map(v => v.image)];
const savedOf = it => {
  const wf = it.workflow, out = it.outputs || {};
  return (wf?.links || []).filter(l => out[l.to] && wf.nodes?.find(n => n.id === l.to)?.type === 'image.save').flatMap(l => filesOf(out[l.from]));
};
function imagesOf(it, saved = new Set(savedOf(it))) {
  return [...new Set(outsOf(it).flatMap(([, o]) => filesOf(o)))].filter(f => !saved.has(f));
}
const view = f => ({ src: fileUrl(f), name: f });
const textsOf = it => outsOf(it).flatMap(([id, o]) => (o._ui?.text != null ? [[id, o._ui.text]] : []));

export function resultsTreeItems() {
  const rows = [];
  const q = S.queue || { running: null, pending: [] };
  rows.push({ grp: `Очередь${q.pending.length ? ` (${q.pending.length})` : ''}` });
  if (q.running) rows.push({ ic: 'play', label: q.running.title, tag: `#${q.running.number} · выполняется` });
  for (const p of q.pending) rows.push({ ic: 'history', label: p.title, tag: `#${p.number}` });
  if (!q.running && !q.pending.length) rows.push({ ic: 'success', label: 'пусто' });
  rows.push({ grp: `История (${items.length})` });
  for (const it of items) {
    const imgs = imagesOf(it);
    rows.push({ ic: it.ok ? 'success' : 'error', label: it.title, tag: `#${it.number} · ${it.time}s`, title: it.at,
      sel: S.sel?.kind === 'run' && S.sel.id === it.prompt_id, onClick: () => select({ kind: 'run', id: it.prompt_id }),
      menu: () => [
        { ic: 'properties', label: 'Показать в Inspector', fn: () => select({ kind: 'run', id: it.prompt_id }) },
        { ic: 'blueprint', label: 'Открыть граф', fn: () => openAsWorkflow(it) },
        imgs.length ? { ic: 'show', label: `Просмотр картинок (${imgs.length})`, fn: () => openViewer(imgs.map(view)) } : null,
        '-',
        { ic: 'copy', label: 'Копировать название', fn: () => navigator.clipboard?.writeText(it.title) },
      ] });
  }
  return rows;
}

function openAsWorkflow(it) {
  const wf = it.workflow || {};
  const base = (wf.id || 'run').replace(/[^\w-]/g, '_');
  if (S.docs.workflow.has(wf.id)) { emit('open-workflow', wf.id); return; }
  const id = uniqueId(base, S.docs.workflow.keys());
  const { id: _, targets, ...data } = wf;
  addDoc('workflow', id, data);
  emit('open-workflow', id);
}

const wfOf = it => it.workflow?.id || it.wf || '';
const matches = it => (!st.wf || wfOf(it) === st.wf) && (!st.q || `${it.title} ${wfOf(it)} #${it.number}`.toLowerCase().includes(st.q.toLowerCase()));
const runSel = it => S.sel?.kind === 'run' && S.sel.id === it.prompt_id;

function dayLabel(at) {
  const d = (at || '').slice(0, 10), t = new Date(), y = new Date(t - 864e5);
  const iso = x => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
  if (d === iso(t)) return 'Сегодня';
  if (d === iso(y)) return 'Вчера';
  const [Y, M, D] = d.split('-').map(Number);
  return Y ? new Date(Y, M - 1, D).toLocaleDateString([], { day: 'numeric', month: 'long', year: Y === t.getFullYear() ? undefined : 'numeric' }) : '—';
}

// плоский список картинок галереи: { file, it } — для ленты и для просмотрщика (листание по всей галерее)
function shots() {
  if (!st.fav) {
    // только результаты (output/: входные картинки Load Image и промежуточные из input/ — не результаты) и каждый
    // файл один раз: при кеше нод тот же кадр приходит и в следующих запусках — оставляем самый новый
    // исходные кадры сохранённых копий — по всей истории: Decode из кеша приносит тот же кадр в следующий запуск
    const seen = new Set(), saved = new Set(items.flatMap(savedOf));
    return items.filter(matches).flatMap(it => imagesOf(it, saved).filter(f => f.startsWith('output/') && !seen.has(f) && seen.add(f)).map(file => ({ file, it })));
  }
  // избранное: запуск из истории, если он ещё там, иначе — то, что запомнили при добавлении
  const byId = new Map(items.map(it => [it.prompt_id, it]));
  return [...favs.values()].map(f => ({ file: f.file, it: byId.get(f.prompt_id) || { ...f, ok: true, outputs: {} } }))
    .filter(s => matches(s.it)).sort((a, b) => String(b.it.at).localeCompare(String(a.it.at)));
}
const viewItem = ({ file, it }) => ({ src: fileUrl(file), thumb: thumbUrl(file, 128), name: file.split('/').pop(), info: `${it.title} · #${it.number} · ${it.at}` });

function openAt(list, k) {
  select({ kind: 'run', id: list[k].it.prompt_id, file: list[k].file });
  openViewer(list.map(viewItem), k, { actions: x => {
    const s = list.find(y => fileUrl(y.file) === x.src);
    return s ? [{ ic: isFav(s.file) ? 'starFilled' : 'star', tip: 'В избранное / убрать', fn: () => toggleFav(s.file, s.it) },
      { ic: 'blueprint', tip: 'Граф этой картинки — новым воркфлоу', fn: () => graphOfImage(s.file, s.it) },
      { ic: 'properties', tip: 'Запуск в Inspector', fn: () => select({ kind: 'run', id: s.it.prompt_id, file: s.file }) }] : [];
  } });
}

function shotMenu(e, list, k) {
  const { file, it } = list[k];
  popup(e, [
    { ic: 'show', label: 'Просмотр', fn: () => openAt(list, k) },
    { ic: isFav(file) ? 'starFilled' : 'star', label: isFav(file) ? 'Убрать из избранного' : 'В избранное', fn: () => toggleFav(file, it) },
    '-',
    { ic: 'blueprint', label: 'Граф этой картинки → новый воркфлоу', fn: () => graphOfImage(file, it) },
    { ic: 'nodes/plugin', label: `Открыть воркфлоу «${it.title}»`, disabled: !it.workflow, fn: () => openAsWorkflow(it) },
    { ic: 'properties', label: 'Запуск в Inspector', fn: () => select({ kind: 'run', id: it.prompt_id, file }) },
    '-',
    { ic: 'copy', label: 'Копировать изображение', fn: () => copyImage(fileUrl(file)) },
    { ic: 'link', label: 'Копировать путь', fn: () => navigator.clipboard?.writeText(file) },
    { ic: 'filter', label: `Только «${it.title}»`, disabled: !wfOf(it) || st.wf === wfOf(it), fn: () => { st.wf = wfOf(it); keep(); render(); } },
  ]);
}

// высота миниатюры: размер плитки × плотность экрана, ступенями 256/384/512/768
const tileH = () => [256, 384, 512, 768].find(x => x >= st.size * (devicePixelRatio || 1)) || 768;

function tile(list, k) {
  const { file, it } = list[k];
  const r = Number(ar.get(file)) || 1;
  const img = h('img', { src: thumbUrl(file, tileH()), loading: 'lazy', decoding: 'async', alt: '', draggable: false });
  const el = h(`div.rg-t${S.sel?.kind === 'run' && S.sel.file === file ? '.sel' : ''}${isFav(file) ? '.fav' : ''}`, {
    draggable: true, 'data-file': file,
    onclick: () => openAt(list, k),
    oncontextmenu: e => shotMenu(e, list, k),
    ondragstart: e => { e.dataTransfer.setData('text/mai-file', file); e.dataTransfer.setData('text/uri-list', fileUrl(file)); e.dataTransfer.setData('text/plain', file); },
  }, img,
    h('div.rg-cap', {}, h('b', {}, it.title), h('span', {}, `#${it.number} · ${it.at.slice(11, 16)}`)),
    h('span.rg-badge', {}, icon('starFilled', { size: 16 })), // избранное — видно и без наведения
    h('div.ui-tb.float.rg-act', {}, // плавающий тулбар UI Kit
      h('button.b.rg-star', { 'data-tip': isFav(file) ? 'Убрать из избранного' : 'В избранное', onclick: e => { e.stopPropagation(); toggleFav(file, it); } },
        icon(isFav(file) ? 'starFilled' : 'star', { size: 16 })),
      h('button.b', { 'data-tip': 'Граф этой картинки — новым воркфлоу', onclick: e => { e.stopPropagation(); graphOfImage(file, it); } }, icon('blueprint', { size: 16 })),
      h('button.b', { 'data-tip': 'Ещё', onclick: e => { e.stopPropagation(); shotMenu(e, list, k); } }, icon('more', { size: 16 }))));
  el.style.setProperty('--ar', r);
  img.addEventListener('load', () => {
    const v = img.naturalWidth / img.naturalHeight;
    if (!v || Math.abs(v - r) < 0.01) return;
    ar.set(file, Math.round(v * 1000) / 1000); keepAr();
    el.style.setProperty('--ar', v);
  }, { once: true });
  // файла уже нет на диске (удалён руками) — плитку не показываем; избранное оставляем с пометкой
  img.addEventListener('error', () => { if (st.fav) el.classList.add('gone'); else el.hidden = true; }, { once: true });
  return el;
}

function gallery() {
  const list = shots();
  if (!list.length && st.fav) return [h('div.msg', {}, 'В избранном пусто — звезда на картинке (при наведении) или ПКМ → «В избранное»')];
  if (!list.length) return [h('div.msg', {}, items.length ? 'Картинок нет — смените фильтр или откройте «Запуски»' : S.server.running ? 'Запусков пока нет — нажмите «Запуск» (Ctrl+Enter)' : 'Сервер не запущен')];
  const out = [];
  let day = null, row = null, head = null;
  list.forEach((s, k) => {
    const d = dayLabel(s.it.at);
    if (d !== day) { day = d; head = h('span.dim'); row = h('div.rg-row'); out.push(h('div.rg-day', {}, h('b', {}, d), head), row); }
    row.append(tile(list, k));
    head.textContent = String(row.childElementCount);
  });
  return out;
}

function card(it) {
  const imgs = imagesOf(it), texts = textsOf(it);
  const list = imgs.map(file => ({ file, it }));
  return h(`div.rcard${it.ok ? '' : '.bad'}${runSel(it) ? '.sel' : ''}`, { 'data-id': it.prompt_id, onclick: () => select({ kind: 'run', id: it.prompt_id }) },
    h('div.rh', {}, icon(it.ok ? 'success' : 'error', { size: 16 }), h('b', {}, it.title), h('span.dim', {}, `#${it.number} · ${it.time}s · ${it.at.slice(5, 16)}`)),
    imgs.length ? h('div.rimgs', {}, ...imgs.slice(0, 6).map((f, k) => h('img', { src: thumbUrl(f, 256), loading: 'lazy', decoding: 'async', alt: '', 'data-tip': `${f}\nЩелчок — просмотр`,
      onclick: e => { e.stopPropagation(); openAt(list, k); } }))) : null,
    texts.length ? h('div.rtext', {}, texts[0][1].slice(0, 600)) : null,
    !it.ok ? h('div.rtext.err', {}, (it.error?.message || '').split('\n')[0]) : null);
}

function runs() {
  const list = items.filter(matches).filter(it => st.filter === 'all' || (st.filter === 'text' ? textsOf(it).length : !it.ok));
  return list.length ? list.map(card) : [h('div.msg', {}, S.server.running ? 'Ничего не найдено' : 'Сервер не запущен')];
}

let bodyEl = null;
function render() {
  const v = document.getElementById('v-results');
  if (!v) return;
  const top = bodyEl?.isConnected && bodyEl.className === (st.view === 'gallery' ? 'rgal' : 'rgrid') ? bodyEl.scrollTop : 0; // перерисовка по очереди не сбрасывает прокрутку
  const mode = (id, ic, t) => h(`button${st.view === id ? '.on' : ''}`, { onclick: () => { st.view = id; keep(); render(); } }, icon(ic, { size: 16 }), t);
  const favSeg = (on_, ic, t) => h(`button${st.fav === on_ ? '.on' : ''}`, { onclick: () => { st.fav = on_; keep(); render(); } }, ic ? icon(ic, { size: 16 }) : null, t);
  const flt = (id, t) => h(`button${st.filter === id ? '.on' : ''}`, { onclick: () => { st.filter = id; keep(); render(); } }, t);
  const wfs = [...new Map(items.filter(wfOf).map(it => [wfOf(it), it.title])).entries()];
  const wfDd = dropdown(st.wf, wfs.map(([id, t]) => ({ value: id, label: t, sec: id })), val => { st.wf = val || ''; keep(); render(); },
    { empty: 'Все воркфлоу', width: 190 }); // обычный комбо-бокс UI Kit, как остальные поля шапки
  const sq = search({ placeholder: 'Поиск по названию', value: st.q, onInput: debounce(val => { st.q = val; keep(); fillBody(); }, 150) });
  sq.input.addEventListener('keydown', e => e.stopPropagation());
  const size = h('input.ui-range', { type: 'range', min: 100, max: 360, step: 10, value: st.size, 'data-tip': 'Размер картинок' });
  size.addEventListener('input', () => { st.size = +size.value; keep(); bodyEl.style.setProperty('--rsz', `${st.size}px`); });
  bodyEl = h(`div.${st.view === 'gallery' ? 'rgal' : 'rgrid'}`);
  bodyEl.style.setProperty('--rsz', `${st.size}px`);
  v.replaceChildren(
    h('div.bar', {},
      h('div.ui-seg', {}, mode('gallery', 'image', 'Галерея'), mode('runs', 'general/listFiles', 'Запуски')),
      st.view === 'runs' ? h('div.ui-seg', {}, flt('all', 'Все'), flt('text', 'Тексты'), flt('err', 'Ошибки')) : null,
      st.view === 'gallery' ? h('div.ui-seg', {}, favSeg(false, null, 'Все'), favSeg(true, 'star', `Избранное${favs.size ? ` ${favs.size}` : ''}`)) : null,
      wfDd, sq,
      st.view === 'gallery' ? size : null,
      h('span.grow'),
      queueEl = h('span.rq'),
      h('button.ui-ib', { 'data-tip': 'Обновить', onclick: refresh }, icon('refresh', { size: 16 }))),
    bodyEl);
  queueBar();
  fillBody();
  bodyEl.scrollTop = top;
}
let queueEl = null;
function queueBar() {
  if (!queueEl?.isConnected) return;
  const q = S.queue || { running: null, pending: [] };
  queueEl.replaceChildren(
    h('span.dim', {}, q.running ? `выполняется: ${q.running.title}` : 'очередь пуста', q.pending.length ? ` · ждут ${q.pending.length}` : ''),
    h('button.ui-ib', { 'data-tip': 'Прервать запуск', onclick: interrupt, disabled: !q.running }, icon('stop', { size: 16 })),
    h('button.ui-ib', { 'data-tip': 'Очистить очередь', onclick: clearQueue, disabled: !q.pending.length }, icon('delete', { size: 16 })));
}
function fillBody(keepScroll = true) {
  if (!bodyEl) return;
  const top = bodyEl.scrollTop;
  bodyEl.replaceChildren(...(st.view === 'gallery' ? gallery() : runs()));
  if (keepScroll) bodyEl.scrollTop = top;
}

function runInspector(s) {
  const it = items.find(x => x.prompt_id === s.id);
  if (!it) return [h('div.dim', {}, 'запуск не найден')];
  return [
    h('h3', {}, icon(it.ok ? 'success' : 'error', { size: 16 }), it.title), h('div.hint', {}, `#${it.number} · ${it.at} · ${it.time} с`),
    it.error ? h('pre.out.err', {}, `${it.error.node ? `нода ${it.error.node}: ` : ''}${it.error.message}`) : null,
    h('button.ui-btn.primary.slim', { style: { margin: '6px 0' }, onclick: () => openAsWorkflow(it) }, icon('blueprint', { size: 16 }), 'Открыть граф'),
    ...outsOf(it).flatMap(([id, o]) => {
      const imgs = [...(o._ui?.images || []), ...Object.values(o).filter(v => v?.image).map(v => v.image)];
      const t = o._ui?.text ?? Object.values(o).find(v => v?.text != null)?.text;
      if (!imgs.length && t == null) return [];
      return [h('h4', {}, `${id}${o._time != null ? ` · ${o._time} с` : ''}`),
        ...imgs.map((f, k) => h('div.preview', {}, h('img', { src: fileUrl(f), alt: f, onclick: e => { e.stopPropagation(); openViewer(imgs.map(view), k); } }))),
        t != null ? h('pre.out', {}, t) : null];
    }),
  ];
}

export function initResults() {
  registerInspector('run', runInspector);
  on('run-done', () => setTimeout(refresh, 100));
  on('queue', queueBar);
  // выделение (Hierarchy, Inspector, просмотр) — подсветка плитки и карточки без перерисовки
  on('select', sel => {
    if (!bodyEl?.isConnected) return;
    bodyEl.querySelectorAll('.rg-t.sel, .rcard.sel').forEach(x => x.classList.remove('sel'));
    if (sel?.kind !== 'run') return;
    if (sel.file) [...bodyEl.querySelectorAll('.rg-t')].find(x => x.dataset.file === sel.file)?.classList.add('sel');
    [...bodyEl.querySelectorAll('.rcard')].find(x => x.dataset.id === sel.id)?.classList.add('sel');
  });
  on('server', s => { if (s.running) setTimeout(refresh, 1500); else refresh(); });
  loadFavs().then(() => { if (bodyEl?.isConnected) render(); });
  addEventListener('view', e => { if (e.detail === 'results') refresh(); });
}
