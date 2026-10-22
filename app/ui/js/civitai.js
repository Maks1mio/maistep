// Civitai: поиск и загрузка моделей в папки библиотеки (по мотивам Enhanced-Civicomfy, в раскладке maistep).
// Hierarchy (контекст civitai) — тип, база, метки, загрузки и папка назначения; вид v-civitai — поиск и галерея
// (или список загрузок); Inspector — карточка модели: версии, файлы, картинки с промптами, триггер-слова, метки,
// «Скачать». Ctrl/Shift+щелчок по плитке — выбор нескольких моделей (скачать / пометить пачкой).
// Сервер — /api/civitai/* (server/maistep/civitai.py), прогресс — SSE «civitai». Фильтры помнит localStorage.
import { h, debounce, prompt } from './util.js';
import { S, on, emit, select } from './store.js';
import { registerInspector } from './inspector.js';
import { icon } from './icons.js';
import { api } from './backend.js';
import { openExternal } from './api.js';
import { isShown } from './dock.js';
import { dropdown, onOff } from './kit.js';
import { fmtSize, loadLibrary } from './library.js';

const LS = 'maistep-civitai';
const DEF = { q: '', types: ['Checkpoint'], bases: [], sort: 'Most Downloaded', period: 'Month', nsfw: false, limit: 50, size: 170, blur: true, mode: 'search', tag: '', root: '' };
const st = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(LS)) }; } catch { return { ...DEF }; } })();
const keep = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch {} };

let meta = null, conf = null, tagsData = { tags: {}, models: {} };
let items = [], next = null, busy = false, error = '', took = null;
const models = new Map();     // id → карточка (из поиска или /model)
const picked = new Set();     // множественный выбор
const jobs = new Map();       // id → задание
const pickVer = new Map();    // id модели → id выбранной версии
let gridEl = null, countEl = null, moreEl = null, bulkEl = null;
const log = (level, text) => emit('log', { src: 'civitai', level, text });

// уменьшенная картинка с CDN Civitai вместо оригинала (original=true — мегабайты на плитку)
const thumb = (url, w = 450) => (url || '').replace(/\/(?:original=true|width=\d+)(?:,[^/]*)?\//, `/width=${w}/`);
const fmtNum = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n || 0));
const coverOf = (m, vid) => {
  const vs = m.versions || [];
  const v = vs.find(x => x.id === vid) || vs[0];
  // у версии может не быть картинок (NSFW скрыты фильтром) — берём из соседних версий
  return [v, ...vs].flatMap(x => x?.images || []).find(i => i.type === 'image') || null;
};
// nsfwLevel Civitai: 1 PG, 2 PG-13, 4 R, 8 X, 16 XXX
const isNsfwImg = i => i && (i.nsfw === true || (typeof i.nsfw === 'number' && i.nsfw >= 4) || ['Mature', 'X', 'R'].includes(i.nsfw));
const activeJobs = () => [...jobs.values()].filter(j => ['queued', 'running', 'verifying'].includes(j.state));

// ---------- данные ----------
async function loadMeta() {
  if (!S.server.running) return;
  try {
    [meta, conf, tagsData] = await Promise.all([api('/api/civitai/meta'), api('/api/civitai/settings'), api('/api/civitai/tags')]);
    const r = await api('/api/civitai/jobs');
    jobs.clear();
    for (const j of r.jobs) jobs.set(j.id, j);
    if (!st.root || !conf.roots.includes(st.root)) { st.root = conf.root || conf.roots[0] || ''; keep(); }
  } catch (e) { error = e.message; }
  redraw();
}

// Новый поиск (смена фильтра) не ждёт текущего: ответ устаревшего запроса отбрасывается по seq.
let seq = 0;
async function search(more = false) {
  if (!S.server.running || (more && busy)) return;
  if (st.mode !== 'search') { st.mode = 'search'; keep(); }
  const my = ++seq;
  busy = true; error = '';
  if (!more) { items = []; next = null; }
  redraw();
  const q = new URLSearchParams({ q: st.q, types: st.types.join(','), bases: st.bases.join(','), sort: st.sort, period: st.period, nsfw: st.nsfw ? '1' : '0', limit: st.limit });
  if (more && next) q.set('cursor', next);
  try {
    const looksLink = /civitai\.com\/|^v?\d+$/.test(st.q.trim());
    if (looksLink && !more) {
      const m = await api(`/api/civitai/resolve?q=${encodeURIComponent(st.q.trim())}`);
      if (my !== seq) return;
      items = [m]; next = null; took = null;
      models.set(m.id, m);
      if (m.focus_version) pickVer.set(m.id, m.focus_version);
      select({ kind: 'civmodel', id: m.id });
    } else {
      const r = await api(`/api/civitai/search?${q}`);
      if (my !== seq) return;
      for (const m of r.items) models.set(m.id, m);
      const seen = new Set(items.map(m => m.id));
      items.push(...r.items.filter(m => !seen.has(m.id)));
      next = r.next; took = r.took;
    }
  } catch (e) {
    if (my !== seq) return;
    error = e.message; log('error', `поиск: ${e.message}`);
  }
  busy = false;
  redraw();
}

async function fullModel(id) {
  const m = models.get(id);
  if (m?.full) return m;
  try {
    const f = { ...(await api(`/api/civitai/model?id=${id}`)), full: true };
    models.set(id, f);
    return f;
  } catch (e) { log('error', e.message); return m; }
}

export async function download(list) {
  if (!list.length) return;
  try {
    const r = await api('/api/civitai/download', { items: list, root: st.root });
    for (const j of r.jobs) jobs.set(j.id, j);
    log('info', `в очереди: ${r.jobs.map(j => j.name).join(', ')} → ${st.root}`);
    redraw();
  } catch (e) { log('error', `загрузка: ${e.message}`); }
}

async function jobOp(op, id) {
  try { const r = await api(`/api/civitai/${op}`, { id }); if (r?.id) jobs.set(r.id, r); }
  catch (e) { log('error', e.message); }
  if (op === 'retry' || op === 'clear') { const r = await api('/api/civitai/jobs'); jobs.clear(); for (const j of r.jobs) jobs.set(j.id, j); }
  redraw();
}

async function setTags(list, add = [], remove = []) {
  try { tagsData = await api('/api/civitai/tags', { models: list, add, remove }); }
  catch (e) { log('error', e.message); }
  redraw();
}

async function askTag(list) {
  const r = await prompt('Метка', [{ key: 't', label: `Метка для ${list.length === 1 ? `«${list[0].name}»` : `${list.length} моделей`}`, value: st.tag || '' }], 'Добавить');
  if (r?.t) setTags(list, [r.t]);
}

function redraw() {
  render();
  if (S.ctx === 'civitai') emit('change', { kind: null });
  if (S.sel?.kind === 'civmodel') emit('civitai-sel');
}

// ---------- Hierarchy ----------
export function civitaiTreeItems() {
  if (!S.server.running) return [{ grp: 'сервер не запущен' }];
  if (!meta) { loadMeta(); return [{ grp: 'загрузка…' }]; }
  const rows = [];
  const toggle = (arr, v) => () => { const i = st[arr].indexOf(v); if (i >= 0) st[arr].splice(i, 1); else st[arr].push(v); keep(); search(); };
  const act = activeJobs().length;
  rows.push({ grp: 'Режим' });
  rows.push({ ic: 'search', label: 'Поиск', sel: st.mode === 'search', onClick: () => { st.mode = 'search'; keep(); redraw(); } });
  rows.push({ ic: 'download', label: 'Загрузки', tag: act ? `${act} активн.` : `${jobs.size}`, sel: st.mode === 'downloads', onClick: () => { st.mode = 'downloads'; keep(); redraw(); } });
  if (Object.keys(tagsData.tags).length) {
    rows.push({ grp: 'Мои метки' });
    for (const [t, ids] of Object.entries(tagsData.tags).sort()) {
      rows.push({ ic: 'pin', label: t, tag: String(ids.length), sel: st.mode === 'tag' && st.tag === t, onClick: () => { st.mode = 'tag'; st.tag = t; keep(); redraw(); } });
    }
  }
  rows.push({ grp: 'Тип' });
  rows.push({ ic: 'projectStructure', label: 'Все типы', sel: !st.types.length, onClick: () => { st.types = []; keep(); search(); } });
  for (const t of meta.types) rows.push({ depth: 1, ic: st.types.includes(t) ? 'check' : null, label: t, tag: meta.folders[t], sel: st.types.includes(t), onClick: toggle('types', t) });
  rows.push({ grp: 'Базовая модель' });
  rows.push({ ic: 'projectStructure', label: 'Любая', sel: !st.bases.length, onClick: () => { st.bases = []; keep(); search(); } });
  for (const b of meta.bases) rows.push({ depth: 1, ic: st.bases.includes(b) ? 'check' : null, label: b, sel: st.bases.includes(b), onClick: toggle('bases', b) });
  rows.push({ grp: 'Куда скачивать' });
  for (const r of conf?.roots || []) rows.push({ ic: 'folder', label: r, title: r, sel: st.root === r, onClick: () => { st.root = r; keep(); api('/api/civitai/settings', { root: r }).catch(() => {}); redraw(); } });
  return rows;
}

// ---------- галерея ----------
function tile(m) {
  const vid = pickVer.get(m.id);
  const v = (m.versions || []).find(x => x.id === vid) || m.versions?.[0];
  const img = coverOf(m, vid);
  const blur = st.blur && (m.nsfw || isNsfwImg(img));
  const th = img?.url
    ? h('img', { src: thumb(img.url, Math.max(320, st.size * 2)), loading: 'lazy', alt: '', draggable: false, referrerpolicy: 'no-referrer' })
    : h('div.lph', {}, icon('image', { size: 32 }), h('span', {}, m.type));
  const sel = S.sel?.kind === 'civmodel' && S.sel.id === m.id;
  return h(`div.ltile.civ${blur ? '.nsfw' : ''}${sel ? '.sel' : ''}${picked.has(m.id) ? '.picked' : ''}`, {
    'data-id': m.id,
    onclick: e => {
      if (e.ctrlKey || e.metaKey || e.shiftKey) { picked.has(m.id) ? picked.delete(m.id) : picked.add(m.id); e.currentTarget.classList.toggle('picked'); bulkBar(); return; }
      select({ kind: 'civmodel', id: m.id });
    },
    'data-tip': `${m.name}\n${m.type}${v?.base ? ` · ${v.base}` : ''} · ${m.creator || ''}\nCtrl+щелчок — выбрать несколько`,
  },
  h('div.lth', {}, th,
    v?.base ? h('span.lbase', {}, v.base) : null,
    m.installed ? h('span.cv-inst', { 'data-tip': 'Уже есть в библиотеке' }, icon('success', { size: 14 })) : null,
    h('span.cv-pick', {}, icon('check', { size: 12 }))),
  h('div.lnm', {}, h('span.n', {}, m.name),
    h('span.dim', {}, `${m.type} · ⬇ ${fmtNum(m.stats?.downloads)} · 👍 ${fmtNum(m.stats?.likes)}`)));
}

function bulkBar() {
  if (!bulkEl) return;
  const list = [...picked].map(id => models.get(id)).filter(Boolean);
  bulkEl.replaceChildren(...(list.length ? [
    h('span.dim', {}, `выбрано: ${list.length}`),
    h('button.primary', { onclick: () => { download(list.map(m => ({ model: m.id, version: pickVer.get(m.id) || m.versions[0]?.id }))); picked.clear(); fill(); bulkBar(); } }, icon('download', { size: 14 }), 'Скачать'),
    h('button', { onclick: () => askTag(list) }, icon('pin', { size: 14 }), 'Метка…'),
    h('button.icon', { 'data-tip': 'Снять выбор', onclick: () => { picked.clear(); fill(); bulkBar(); } }, icon('closeSmall', { size: 14 })),
  ] : []));
  bulkEl.style.display = list.length ? '' : 'none';
}

function searchBar() {
  const q = h('input.lq', { placeholder: 'Поиск на Civitai или ссылка/ID модели…', value: st.q, spellcheck: false });
  q.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') { st.q = q.value; keep(); search(); } });
  q.addEventListener('input', debounce(() => { st.q = q.value; keep(); }, 200));
  const sort = dropdown(st.sort, meta.sorts.map(s => [s, { 'Highest Rated': 'Рейтинг', 'Most Downloaded': 'Загрузки', 'Most Liked': 'Лайки', 'Most Discussed': 'Обсуждения', 'Most Collected': 'В коллекциях', Newest: 'Новые' }[s] || s]),
    v => { st.sort = v; keep(); search(); }, { width: 130 });
  const period = dropdown(st.period, meta.periods.map(p => [p, { AllTime: 'За всё время', Year: 'Год', Month: 'Месяц', Week: 'Неделя', Day: 'День' }[p]]),
    v => { st.period = v; keep(); search(); }, { width: 120 });
  const limit = dropdown(String(st.limit), [['20', '20'], ['50', '50'], ['100', '100']], v => { st.limit = +v; keep(); search(); }, { width: 64 });
  const nsfw = h('span.row.cv-sw', { 'data-tip': 'Показывать NSFW-модели' }, onOff(st.nsfw, v => { st.nsfw = v; keep(); search(); }), h('span.dim', {}, 'NSFW'));
  const blur = h(`button${st.blur ? '.on' : ''}`, { 'data-tip': 'Размывать NSFW-превью', onclick: e => { st.blur = !st.blur; keep(); e.currentTarget.classList.toggle('on', st.blur); fill(); } }, icon('hide', { size: 14 }));
  const size = h('input.ui-range', { type: 'range', min: 120, max: 300, step: 10, value: st.size, 'data-tip': 'Размер плиток' });
  size.addEventListener('input', () => { st.size = +size.value; keep(); gridEl?.style.setProperty('--lsz', `${st.size}px`); });
  countEl = h('span.dim');
  return h('div.bar', {}, q,
    h('button.primary', { onclick: () => { st.q = q.value; keep(); search(); } }, icon('search', { size: 14 }), 'Найти'),
    sort, period, limit, nsfw, blur, size, h('span.grow'), countEl,
    h('button.icon', { 'data-tip': 'Настройки Civitai (ключ API, соединения)', onclick: settingsDialog }, icon('settings', { size: 14 })));
}

function render() {
  const v = document.getElementById('v-civitai');
  if (!v || !isShown('civitai')) return;
  if (!S.server.running) { v.replaceChildren(h('div.msg', {}, 'Сервер не запущен — Civitai ищет через него')); gridEl = null; return; }
  if (!meta) { v.replaceChildren(h('div.msg', {}, error || 'Загрузка…')); loadMeta(); gridEl = null; return; }
  if (st.mode === 'downloads') { gridEl = null; v.replaceChildren(downloadsView()); return; }
  gridEl = h('div.lgrid.cv-grid');
  gridEl.style.setProperty('--lsz', `${st.size}px`);
  bulkEl = h('div.bar.cv-bulk', { style: { display: 'none' } });
  moreEl = h('div.cv-more');
  const head = st.mode === 'tag'
    ? h('div.bar', {}, icon('pin', { size: 14 }), h('b', {}, st.tag), h('span.dim', {}, '— моя метка (сохранено локально)'), h('span.grow'),
      h('button', { onclick: () => { st.mode = 'search'; keep(); redraw(); } }, icon('left', { size: 14 }), 'К поиску'))
    : searchBar();
  v.replaceChildren(head, bulkEl, h('div.cv-scroll', {}, gridEl, moreEl));
  fill();
  bulkBar();
  if (st.mode === 'search' && !items.length && !busy && !error) search();
}

function fill() {
  if (!gridEl) return;
  const list = st.mode === 'tag'
    ? (tagsData.tags[st.tag] || []).map(id => models.get(+id) || { ...tagsData.models[id], versions: tagsData.models[id]?.image ? [{ id: 0, base: tagsData.models[id].base, images: [tagsData.models[id].image], files: [] }] : [] }).filter(m => m?.id)
    : items;
  if (countEl) countEl.textContent = busy ? 'поиск…' : `${list.length}${took != null ? ` · ${took} с` : ''}`;
  gridEl.replaceChildren(...(list.length ? list.map(tile) : [h('div.msg', {}, busy ? 'Поиск…' : error || 'Ничего не найдено')]));
  if (moreEl) moreEl.replaceChildren(st.mode === 'search' && next ? h('button', { disabled: busy, onclick: () => search(true) }, busy ? 'Загрузка…' : 'Показать ещё') : '');
}

// ---------- загрузки ----------
const STATE = { queued: ['info', 'в очереди'], running: ['warn', 'качается'], verifying: ['warn', 'проверка SHA256'], done: ['ok', 'готово'], error: ['bad', 'ошибка'], cancelled: ['info', 'отменено'] };
function jobRow(j) {
  const pct = j.total ? Math.min(100, Math.round(100 * j.done / j.total)) : 0;
  const [cls, label] = STATE[j.state] || ['info', j.state];
  const live = ['queued', 'running', 'verifying'].includes(j.state);
  const eta = j.speed > 0 && j.total ? Math.max(0, Math.round((j.total - j.done) / j.speed)) : null;
  return h('div.cv-job', { 'data-job': j.id },
    j.image ? h('img.cv-jimg', { src: thumb(j.image, 120), alt: '', referrerpolicy: 'no-referrer' }) : h('div.cv-jimg', {}, icon('download', { size: 18 })),
    h('div.cv-jtx', {},
      h('div', {}, h('b', {}, j.model?.name || j.name), h('span.dim', {}, ` · ${j.version?.name || ''}${j.version?.base ? ` · ${j.version.base}` : ''}`)),
      h('div.dim.mono', { style: { fontSize: '11px' } }, j.dest),
      h('div.cv-prog', {}, h('div', { style: { width: `${j.state === 'done' ? 100 : pct}%` } })),
      h('div.dim', { style: { fontSize: '11px' } },
        `${fmtSize(j.done || 0)} / ${j.total ? fmtSize(j.total) : '?'}`,
        j.state === 'running' && j.speed ? ` · ${fmtSize(j.speed)}/с${eta != null ? ` · ~${eta > 90 ? `${Math.round(eta / 60)} мин` : `${eta} с`}` : ''}` : '',
        j.error ? h('span', { style: { color: 'var(--err)' } }, ` · ${j.error}`) : '')),
    h(`span.cmp-chip.${cls}`, {}, label),
    h('div.cv-jact', {},
      live ? h('button', { onclick: () => jobOp('cancel', j.id) }, icon('stop', { size: 14 }), 'Отмена') : null,
      ['error', 'cancelled'].includes(j.state) ? h('button', { onclick: () => jobOp('retry', j.id) }, icon('restart', { size: 14 }), 'Повторить') : null,
      j.state === 'done' ? h('button.icon', { 'data-tip': 'Показать в папке', onclick: () => jobOp('reveal', j.id) }, icon('folder', { size: 14 })) : null,
      j.model?.id ? h('button.icon', { 'data-tip': 'Карточка модели', onclick: () => { fullModel(j.model.id).then(() => select({ kind: 'civmodel', id: j.model.id })); } }, icon('properties', { size: 14 })) : null));
}

function downloadsView() {
  const list = [...jobs.values()].reverse();
  const done = list.filter(j => !['queued', 'running', 'verifying'].includes(j.state));
  return h('div.cv-dl', {},
    h('div.bar', {}, icon('download', { size: 14 }), h('b', {}, 'Загрузки'), h('span.dim', {}, `· активных ${activeJobs().length} · в папку ${st.root || '—'}`), h('span.grow'),
      h('button', { disabled: !done.length, onclick: () => jobOp('clear') }, icon('delete', { size: 14 }), 'Очистить историю'),
      h('button.icon', { 'data-tip': 'Настройки Civitai', onclick: settingsDialog }, icon('settings', { size: 14 }))),
    h('div.cv-jobs', {}, ...(list.length ? list.map(jobRow) : [h('div.msg', {}, 'Загрузок ещё не было — найдите модель и нажмите «Скачать»')])));
}

function onJob(j) {
  const prev = jobs.get(j.id);
  jobs.set(j.id, j);
  if (prev?.state !== j.state) {
    if (j.state === 'done') { log('ok', `скачано: ${j.dest}`); loadLibrary(true); for (const m of models.values()) if (m.id === j.model?.id) { m.installed = true; m.full = false; } }
    if (j.state === 'error') log('error', `${j.name}: ${j.error}`);
    redraw();
    return;
  }
  // только прогресс — точечно, без перерисовки всего
  const row = document.querySelector(`.cv-job[data-job="${j.id}"]`);
  if (row && st.mode === 'downloads') row.replaceWith(jobRow(j));
  if (S.ctx === 'civitai') emit('change', { kind: null });
  if (S.sel?.kind === 'civmodel' && S.sel.id === j.model?.id) emit('civitai-sel');
}

// ---------- настройки ----------
async function settingsDialog() {
  const c = conf || await api('/api/civitai/settings').catch(() => ({}));
  const r = await prompt('Настройки Civitai', [
    { key: 'api_key', label: `Ключ API${c.has_key ? ` (сейчас ${c.api_key})` : ''} — civitai.com → Account → API Keys`, value: '' },
    { key: 'connections', label: 'Соединений на файл (1–16)', value: String(c.connections || 4) },
    { key: 'concurrent', label: 'Одновременных загрузок (1–4)', value: String(c.concurrent || 1) },
    { key: 'verify', label: 'Проверять SHA256 после загрузки', type: 'select', value: c.verify === false ? '0' : '1', options: [['1', 'да'], ['0', 'нет']] },
    { key: 'preview', label: 'Сохранять превью рядом с моделью', type: 'select', value: c.preview === false ? '0' : '1', options: [['1', 'да'], ['0', 'нет']] },
  ], 'Сохранить');
  if (!r) return;
  const body = { connections: +r.connections || 4, concurrent: +r.concurrent || 1, verify: r.verify === '1', preview: r.preview === '1' };
  if (r.api_key) body.api_key = r.api_key;
  try { conf = await api('/api/civitai/settings', body); log('ok', 'настройки Civitai сохранены'); } catch (e) { log('error', e.message); }
}

// ---------- Inspector ----------
function civInspector(s) {
  let m = models.get(s.id);
  if (!m) return [h('div.dim', {}, 'модель не найдена')];
  if (!m.full) fullModel(s.id).then(f => { if (S.sel?.id === s.id && f?.full) emit('civitai-sel'); });
  const vid = pickVer.get(m.id) || m.versions?.[0]?.id;
  const v = (m.versions || []).find(x => x.id === vid) || m.versions?.[0];
  const copy = t => navigator.clipboard?.writeText(t);
  const imgs = (v?.images || []).filter(i => i.url);
  let at = 0;
  const big = h('img', { referrerpolicy: 'no-referrer' });
  const metaBox = h('div.cv-imeta');
  const showImg = k => {
    at = (k + imgs.length) % imgs.length;
    const i = imgs[at];
    if (!i) return;
    big.src = thumb(i.url, 768);
    pv.classList.toggle('nsfw', st.blur && isNsfwImg(i));
    const mm = i.meta || {};
    metaBox.replaceChildren(...[
      mm.prompt ? h('div.cv-prompt', { 'data-tip': 'Копировать промпт', onclick: () => copy(mm.prompt) }, h('span.dim', {}, 'prompt '), mm.prompt) : null,
      mm.negativePrompt ? h('div.cv-prompt.neg', { onclick: () => copy(mm.negativePrompt) }, h('span.dim', {}, 'negative '), mm.negativePrompt) : null,
      Object.keys(mm).some(k => !['prompt', 'negativePrompt'].includes(k))
        ? h('div.dim', { style: { fontSize: '11px' } }, ['sampler', 'steps', 'cfgScale', 'seed', 'Size', 'clipSkip'].filter(k => mm[k] != null).map(k => `${k} ${mm[k]}`).join(' · ')) : null,
    ].filter(Boolean));
  };
  const pv = h('div.preview.cv-pv', { onclick: e => { if (e.target === big) pv.classList.remove('nsfw'); } }, big,
    imgs.length > 1 ? h('button.icon.cv-nav.l', { onclick: e => { e.stopPropagation(); showImg(at - 1); } }, icon('left', { size: 16 })) : null,
    imgs.length > 1 ? h('button.icon.cv-nav.r', { onclick: e => { e.stopPropagation(); showImg(at + 1); } }, icon('right', { size: 16 })) : null);
  if (imgs.length) showImg(0);
  const files = v?.files || [];
  let fileId = (files.find(f => f.primary) || files[0])?.id;
  const fileRows = files.map(f => h(`label.cv-file${f.id === fileId ? '.on' : ''}`, {},
    h('input', { type: 'radio', name: 'cvf', checked: f.id === fileId, onchange: e => { fileId = f.id; e.target.closest('.cv-files').querySelectorAll('.cv-file').forEach(x => x.classList.toggle('on', x === e.target.closest('.cv-file'))); } }),
    h('span.n', {}, f.name), h('span.dim', {}, [fmtSize(f.size), f.fp, f.pruned, f.format].filter(Boolean).join(' · ')),
    f.installed ? h('span.mbadge', { style: { marginLeft: '4px' } }, 'есть') : null));
  const tagsOf = Object.entries(tagsData.tags).filter(([, ids]) => ids.includes(String(m.id))).map(([t]) => t);
  const kv = (k, val) => (val == null || val === '' ? null : h('div.f', {}, h('label', {}, k), h('div.v', { style: { userSelect: 'text' } }, String(val))));
  return [
    h('h3', {}, icon(m.type === 'Checkpoint' ? 'blueprint' : m.type === 'VAE' ? 'image' : 'link', { size: 16 }), m.name),
    h('div.hint', {}, `${m.type} · ${m.creator || '—'} · ⬇ ${fmtNum(m.stats?.downloads)} · 👍 ${fmtNum(m.stats?.likes)}`, m.installed ? h('span.mbadge', { style: { marginLeft: '6px' } }, 'в библиотеке') : null),
    imgs.length ? pv : null,
    imgs.length ? metaBox : null,
    m.versions?.length > 1 ? h('div.f', {}, h('label', {}, 'Версия'), dropdown(String(v.id), m.versions.map(x => [String(x.id), `${x.name}${x.base ? ` · ${x.base}` : ''}${x.installed ? ' ✓' : ''}`]), val => { pickVer.set(m.id, +val); emit('civitai-sel'); fill(); }, { width: 220 })) : null,
    kv('База', v?.base),
    kv('Опубликована', v?.published?.slice(0, 10)),
    kv('Папка', `${st.root || '—'} → ${meta?.folders?.[m.type] || 'other'}`),
    files.length ? h('h4', {}, 'Файлы') : null,
    files.length ? h('div.cv-files', {}, ...fileRows) : h('div.dim', {}, 'нет файлов'),
    h('div.row', { style: { margin: '8px 0', flexWrap: 'wrap' } },
      h('button.primary', { disabled: !files.length, onclick: () => download([{ model: m.id, version: v.id, file: fileId }]) }, icon('download', { size: 14 }), 'Скачать'),
      h('button', { onclick: () => openExternal(`${m.url}${v ? `?modelVersionId=${v.id}` : ''}`) }, icon('externalLink', { size: 14 }), 'Civitai'),
      h('button', { onclick: () => askTag([m]) }, icon('pin', { size: 14 }), 'Метка…')),
    tagsOf.length ? h('div.ltags', {}, ...tagsOf.map(t => h('span.mbadge', { 'data-tip': 'Снять метку', onclick: () => setTags([m], [], [t]) }, `${t} ×`))) : null,
    v?.trained?.length ? h('h4', {}, 'Триггер-слова (щёлкните — копировать)') : null,
    ...(v?.trained || []).map(w => h('div.ltrig', { onclick: () => copy(w), 'data-tip': 'Копировать' }, w)),
    m.tags?.length ? h('h4', {}, 'Теги') : null,
    m.tags?.length ? h('div.ltags', {}, ...m.tags.slice(0, 30).map(t => h('span.mbadge', { onclick: () => { st.q = t; st.mode = 'search'; keep(); search(); render(); } }, t))) : null,
    (v?.description || m.description) ? h('details', {}, h('summary', {}, 'Описание'), h('div.cv-desc', { innerHTML: sanitize(v?.description || m.description) })) : null,
  ];
}

// описание с Civitai — HTML; оставляем только безопасную разметку
function sanitize(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,form,input,button,link,meta').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(n => {
    for (const a of [...n.attributes]) if (!['href', 'src', 'alt'].includes(a.name) || /^\s*javascript:/i.test(a.value)) n.removeAttribute(a.name);
    if (n.tagName === 'A') { n.setAttribute('target', '_blank'); n.setAttribute('rel', 'noopener noreferrer'); }
    if (n.tagName === 'IMG') n.setAttribute('referrerpolicy', 'no-referrer');
  });
  return doc.body.innerHTML;
}

export function initCivitai() {
  registerInspector('civmodel', civInspector);
  on('civitai', d => { if (d.job) onJob(d.job); if (d.jobs) { jobs.clear(); for (const j of d.jobs) jobs.set(j.id, j); redraw(); } });
  on('civitai-sel', () => emit('select', S.sel));
  on('select', s => { if (gridEl) gridEl.querySelectorAll('.ltile').forEach(t => t.classList.toggle('sel', s?.kind === 'civmodel' && t.dataset.id === String(s.id))); });
  on('server', s => { if (s.running) setTimeout(loadMeta, 800); else { meta = null; render(); } });
  addEventListener('view', e => { if (e.detail === 'civitai') render(); });
  // ссылки в описании — во внешний браузер
  addEventListener('click', e => {
    const a = e.target.closest?.('.cv-desc a[href]');
    if (a) { e.preventDefault(); openExternal(a.href); }
  });
}
export const showCivitai = () => render();
