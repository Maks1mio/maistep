// Компоненты: установленные и рекомендованные версии (только стабильные), проверка обновлений, установка
// недостающих пакетов в .venv с живым логом pip. Данные — /api/components сервера; события SSE — components, comp-log.
// Обновления приложения — /api/update (server/maistep/updater.py): изменившиеся файлы релиза качаются в фоне,
// применяются при перезапуске окна (команда app_restart). События SSE — update.
import { h } from './util.js';
import { S, on, emit, select } from './store.js';
import { registerInspector } from './inspector.js';
import { icon } from './icons.js';
import { isShown, openWorkspace } from './dock.js';
import { componentsStatus, installComponents, cancelComponents, updateStatus, downloadUpdate } from './backend.js';
import { messageBox } from './kit.js';
import { openExternal, invoke, isTauri } from './api.js';

const NOTIFY = 'maistep-components-notified';
const LSG = 'maistep-components-group';
let group = (() => { try { return localStorage.getItem(LSG) || ''; } catch { return ''; } })();
const CHECKED = 'maistep-components-checked';
let data = null, upd = null, loading = false, error = null, job = null, lines = [];
let rechecking = new Set(); // пакеты только что поставленной установки — до свежих версий с сервера
let viewEl = null, bodyEl = null, logEl = null;
const log = (level, text) => emit('log', { src: 'editor', level, text });

const CHIP = { checking: ['info', 'проверка…'], ok: ['ok', 'установлено'], update: ['warn', 'обновите'], missing: ['bad', 'не установлено'], newer: ['info', 'новее рекомендованной'] };

function statusChip(st) {
  const [cls, text] = CHIP[st] || ['info', st || '—'];
  return h(`span.cmp-chip.${cls}`, {}, text);
}

// обновление maistep в работе (в git-копии не считается)
const appUpdate = () => !!upd && !upd.dev && ['available', 'downloading', 'ready'].includes(upd.status);
const badgeCount = () => (data?.summary?.missing || 0) + (data?.summary?.update || 0) + (appUpdate() ? 1 : 0);

function setBadge(n) {
  const el = document.getElementById('tb-comp-badge');
  if (!el) return;
  el.textContent = n ? String(n) : '';
  el.classList.toggle('on', !!n);
}

async function load(refresh = false, deep = false) {
  if (!S.server.running) { data = null; render(); return; }
  loading = true; error = null; render();
  try {
    const [d, u] = await Promise.all([componentsStatus({ refresh, deep }), updateStatus(refresh).catch(() => null)]);
    data = d;
    if (u) upd = u;
    if (d.job) { job = d.job; lines = (d.job.lines || []).slice(); }
    setBadge(badgeCount());
    if (refresh) {
      try { localStorage.setItem(CHECKED, String(Date.now())); } catch {}
      log('info', `компоненты: проверка стабильных обновлений — ${d.summary.update} обновлений, ${d.summary.missing} не хватает`);
    }
  } catch (e) {
    error = e.message;
    log('error', `компоненты: ${e.message}`);
  } finally {
    loading = false;
    render();
    if (S.ctx === 'components') emit('change', { kind: null });
  }
}

async function install(ids, mode = 'recommended') {
  if (!ids?.length) return;
  try {
    const r = await installComponents(ids, mode);
    if (r.error && !r.job) throw new Error(r.error);
    job = r.job; lines = (job?.lines || []).slice();
    render();
  } catch (e) {
    log('error', `установка: ${e.message}`);
  }
}

async function cancel() {
  try { const r = await cancelComponents(); if (r.job) job = r.job; render(); }
  catch (e) { log('error', `прерывание: ${e.message}`); }
}

function toolbar(sum) {
  const missing = (data?.components || []).filter(c => c.status === 'missing').map(c => c.id);
  const updates = (data?.components || []).filter(c => c.status === 'update').map(c => c.id);
  const busy = job?.state === 'running';
  return h('div.bar', {},
    h('button', { disabled: loading, 'data-tip': 'Проверить последние стабильные версии (PyPI и GitHub Releases)', onclick: () => load(true, true) },
      icon('refresh', { size: 14 }), loading ? 'Проверка…' : 'Проверить обновления'),
    h('button', { disabled: busy || !missing.length, 'data-tip': 'Установить все отсутствующие пакеты из .venv', onclick: () => install(missing, 'missing') },
      icon('download', { size: 14 }), `Установить недостающее${missing.length ? ` (${missing.length})` : ''}`),
    h('button', { disabled: busy || !updates.length, onclick: () => install(updates, 'recommended') },
      icon('upload', { size: 14 }), `Обновить рекомендованные${updates.length ? ` (${updates.length})` : ''}`),
    h('span.grow'),
    h('span.dim', {}, `стабильный канал · ${data?.checked_at ? new Date(data.checked_at * 1000).toLocaleString() : 'ещё не проверялось'}`));
}

const mb = n => `${(n / 1048576).toFixed(n < 1048576 ? 2 : 1)} МБ`;

async function startDownload() {
  try { const r = await downloadUpdate(); if (r.error) throw new Error(r.error); upd = r; render(); }
  catch (e) { log('error', `обновление: ${e.message}`); }
}

function restart() {
  if (!isTauri) { log('warn', 'обновление применяется при перезапуске окна maistep (в веб-режиме недоступно)'); return; }
  invoke('app_restart').catch(e => log('error', `перезапуск: ${e}`));
}

// Карточка maistep: версия и состояние обновления
function appCard() {
  const a = data?.app, u = upd;
  if (!a) return null;
  const st = u?.status || 'idle', ver = u?.version;
  const size = u ? `${u.files || 0} файл(ов)${u.exe ? ' + maistep.exe' : ''}, ${mb(u.bytes || 0)}` : '';
  let text = 'Установлена последняя версия.', action = statusChip('ok');
  if (u?.dev) {
    text = `git-копия — обновление через git pull${ver ? ` (в релизах есть ${ver})` : ''}.`;
    action = ver && u.url ? h('button', { onclick: () => openExternal(u.url) }, icon('externalLink', { size: 14 }), `Релиз ${ver}`) : null;
  } else if (st === 'checking') { text = 'Проверка обновлений…'; action = null; }
  else if (st === 'available') {
    text = `Вышла версия ${ver}: скачать нужно ${size}.`;
    action = h('button.primary', { onclick: startDownload }, icon('download', { size: 14 }), `Скачать ${ver}`);
  } else if (st === 'downloading') {
    const pct = u.bytes ? Math.min(100, Math.round(100 * (u.done || 0) / u.bytes)) : 0;
    text = h('span', {}, `Загрузка ${ver}: ${mb(u.done || 0)} из ${mb(u.bytes || 0)} — можно продолжать работать. `,
      h('span.cmp-prog', {}, h('i', { style: { width: `${pct}%` } })));
    action = h('span.dim', {}, `${pct}%`);
  } else if (st === 'ready') {
    text = `Версия ${ver} скачана — применится при перезапуске окна.`;
    action = h('button.primary', { onclick: restart }, icon('restart', { size: 14 }), 'Перезапустить');
  } else if (st === 'error') {
    text = `Обновление: ${u.error}`;
    action = h('button', { onclick: () => load(true) }, icon('refresh', { size: 14 }), 'Повторить');
  }
  const hot = appUpdate();
  return h(`div.cmp-app${hot ? '.upd' : ''}`, {},
    h('div.cmp-appic', {}, icon('blueprint', { size: 22 })),
    h('div.cmp-apptx', {},
      h('div', {}, h('b', {}, `${a.name} ${u?.installed || a.installed}`),
        u?.checked_at ? h('span.dim', {}, ` · проверено ${new Date(u.checked_at * 1000).toLocaleString()}`) : null,
        u?.url && hot ? h('a', { href: '#', style: { marginLeft: '8px' }, onclick: e => { e.preventDefault(); openExternal(u.url); } }, 'что нового') : null),
      h('div.dim', { style: { fontSize: '12px' } }, text)),
    h('span.grow'),
    action);
}

function componentRow(c) {
  const busy = job?.state === 'running';
  let action = null;
  if (c.status === 'missing') action = h('button.primary', { disabled: busy, onclick: () => install([c.id], 'missing') }, icon('download', { size: 14 }), 'Установить');
  else if (c.status === 'update') action = h('button.primary', { disabled: busy, onclick: () => install([c.id], 'recommended') }, icon('upload', { size: 14 }), `Обновить до ${c.recommended}`);
  else if (c.latest_newer) action = h('button', { disabled: busy, 'data-tip': `Последняя стабильная версия ${c.latest}. Рекомендуется ${c.recommended} (проверена).`, onclick: () => install([c.id], 'latest') }, icon('download', { size: 14 }), `До ${c.latest}`);
  if (rechecking.has(c.id)) action = h('span.dim', {}, 'проверка…');
  const sel = S.sel?.kind === 'component' && S.sel.id === c.id;
  return h(`tr${sel ? '.sel' : ''}`, { 'data-id': c.id, onclick: e => { if (!e.target.closest('button')) select({ kind: 'component', id: c.id }); } },
    h('td.cmp-name', {},
      h('div', {}, h('b', {}, c.title), c.required ? null : h('span.mbadge', { style: { marginLeft: '6px' } }, 'опционально')),
      h('div.dim.mono', { style: { fontSize: '11px' } }, c.package + (c.size ? ` · ${c.size}` : '')),
      c.note ? h('div.dim', { style: { fontSize: '11px' } }, c.note) : null),
    h('td.mono', {}, c.installed || h('span.dim', {}, '—')),
    h('td.mono', {}, c.recommended || '—'),
    h('td.mono', {}, c.latest || h('span.dim', {}, '—'), c.latest_newer ? h('span.mbadge', { style: { marginLeft: '6px' }, 'data-tip': 'Есть более новая стабильная версия; рекомендуется сначала проверенная из манифеста' }, 'new') : null),
    h('td', {}, rechecking.has(c.id) ? statusChip('checking') : statusChip(c.status)),
    h('td.cmp-act', {}, action || h('span.dim', {}, '—')));
}

function table() {
  const rows = (data?.components || []).filter(c => !group || c.group === group);
  const groups = [...new Set(rows.map(c => c.group))];
  return h('div.cmp-tablewrap', {}, h('table.cmp-table', {},
    h('thead', {}, h('tr', {}, h('th', {}, 'Компонент'), h('th', {}, 'Установлено'), h('th', {}, 'Рекомендуется'), h('th', {}, 'Последняя стабильная'), h('th', {}, 'Статус'), h('th', {}, ''))),
    ...groups.map(g => [
      h('tr.cmp-grp', {}, h('td', { colSpan: 6 }, g)),
      ...rows.filter(c => c.group === g).map(componentRow),
    ])));
}

function jobPanel() {
  if (!job) return null;
  const running = job.state === 'running';
  logEl = h('pre.out.cmp-log', {}, ...(lines.length ? lines : ['…']).map(t => h('div', {}, t)));
  return h('div.cmp-job', {},
    h('div.cmp-jobhd', {},
      icon(running ? 'restart' : job.state === 'done' ? 'success' : 'error', { size: 16 }),
      h('b', {}, running ? 'Установка компонентов…' : job.state === 'done' ? 'Установка завершена' : job.state === 'cancelled' ? 'Установка прервана' : 'Ошибка установки'),
      job.error ? h('span.dim', {}, ` · ${job.error}`) : null,
      h('span.grow'),
      running ? h('button', { onclick: cancel }, icon('stop', { size: 14 }), 'Прервать') : h('button', { onclick: () => { job = null; lines = []; render(); } }, icon('closeSmall', { size: 14 }), 'Скрыть')),
    logEl);
}

function render() {
  if (!viewEl || !isShown('components')) return;
  if (!S.server.running) { viewEl.replaceChildren(h('div.msg', {}, 'Сервер не запущен — компоненты считает он')); return; }
  if (!data) {
    viewEl.replaceChildren(...[h('div.msg', {}, loading ? 'Проверка компонентов…' : error || 'Нет данных'),
      error ? h('button', { onclick: () => load(false, true) }, 'Повторить') : null].filter(Boolean));
    return;
  }
  const sum = data.summary || {};
  viewEl.replaceChildren(...[
    toolbar(sum),
    h('div.cmp-body', {}, ...[!group ? appCard() : null, table(), jobPanel()].filter(Boolean)),
    error ? h('div.hint', { style: { color: 'var(--err)' } }, error) : null,
  ].filter(Boolean));
  if (logEl) logEl.scrollTop = logEl.scrollHeight;
}

// ---------- Hierarchy: группы, сводка, среда ----------
export function componentsTreeItems() {
  if (!S.server.running) return [{ grp: 'сервер не запущен' }];
  if (!data) return [{ grp: loading ? 'проверка…' : 'нет данных' }];
  const sum = data.summary || {};
  const rows = [{ grp: 'Группы' }];
  const pick = g => () => { group = g; try { localStorage.setItem(LSG, g); } catch {} render(); emit('change', { kind: null }); };
  const all = data.components || [];
  rows.push({ ic: 'projectStructure', label: 'Все компоненты', tag: String(all.length), sel: !group, onClick: pick('') });
  for (const g of [...new Set(all.map(c => c.group))]) {
    const list = all.filter(c => c.group === g);
    const bad = list.filter(c => c.status !== 'ok' && c.status !== 'newer').length;
    rows.push({ depth: 1, ic: bad ? 'warning' : 'success', label: g, tag: bad ? `требуют внимания: ${bad}` : `${list.length} · ок`, sel: group === g, onClick: pick(g) });
  }
  rows.push({ grp: 'Сводка' });
  rows.push({ ic: 'success', label: 'Установлено', tag: String(sum.ok || 0) });
  rows.push({ ic: 'upload', label: 'Можно обновить', tag: String(sum.update || 0) });
  rows.push({ ic: sum.missing ? 'error' : 'success', label: 'Не хватает', tag: String(sum.missing || 0) });
  if (data.app) rows.push({ ic: appUpdate() ? 'download' : 'blueprint', label: `maistep ${upd?.installed || data.app.installed}`, tag: appUpdate() ? `→ ${upd.version}${upd.status === 'ready' ? ' (скачано)' : ''}` : 'актуально' });
  const py = data.python || {}, deep = data.deep || {};
  rows.push({ grp: 'Среда' });
  rows.push({ ic: 'python', label: `Python ${py.version || '?'}`, tag: py.is_venv ? '.venv' : 'не .venv!', title: py.path || '' });
  const cuda = !data.deep ? (loading ? 'CUDA: проверка…' : 'CUDA: не проверялась') : deep.cuda ? `CUDA · ${deep.device || 'GPU'}` : 'CUDA недоступна';
  rows.push({ ic: 'lightning', label: cuda, tag: deep.vram_gb ? `${deep.vram_gb} ГБ` : '', title: deep.error || '' });
  return rows;
}

// ---------- Inspector: карточка пакета ----------
function compInspector(s) {
  const c = (data?.components || []).find(x => x.id === s.id);
  if (!c) return [h('div.dim', {}, 'компонент не найден')];
  const busy = job?.state === 'running';
  const kv = (k, v) => (v == null || v === '' ? null : h('div.f', {}, h('label', {}, k), h('div.v.mono', { style: { userSelect: 'text' } }, String(v))));
  return [
    h('h3', {}, icon('download', { size: 16 }), c.title),
    h('div.hint.mono', {}, c.package),
    c.note ? h('div.hint', {}, c.note) : null,
    h('div.row', { style: { margin: '6px 0' } }, statusChip(c.status), c.required ? null : h('span.mbadge', {}, 'опционально')),
    kv('Установлено', c.installed || '—'),
    kv('Рекомендуется', c.recommended),
    kv('Последняя стабильная', c.latest),
    kv('Группа', c.group),
    kv('Размер', c.size),
    h('div.row', { style: { margin: '8px 0', flexWrap: 'wrap' } },
      c.status === 'missing' ? h('button.primary', { disabled: busy, onclick: () => install([c.id], 'missing') }, icon('download', { size: 14 }), 'Установить') : null,
      c.status === 'update' ? h('button.primary', { disabled: busy, onclick: () => install([c.id], 'recommended') }, icon('upload', { size: 14 }), `Обновить до ${c.recommended}`) : null,
      c.latest_newer ? h('button', { disabled: busy, onclick: () => install([c.id], 'latest') }, icon('download', { size: 14 }), `До ${c.latest}`) : null,
      h('button', { onclick: () => openExternal(`https://pypi.org/project/${c.package}/`) }, icon('externalLink', { size: 14 }), 'PyPI')),
  ];
}

export async function showComponents() {
  viewEl = document.getElementById('v-components');
  if (!viewEl) return;
  // данные стартовой проверки — без CUDA (deep); при первом показе дозапрашиваем
  if (!data?.deep) await load(false, true);
  else render();
}

export function initComponents() {
  viewEl = document.getElementById('v-components');
  registerInspector('component', compInspector);
  on('select', s => viewEl?.querySelectorAll('tr[data-id]').forEach(r => r.classList.toggle('sel', s?.kind === 'component' && r.dataset.id === s.id)));
  on('components', d => {
    if (d.job) {
      const wasRunning = job?.state === 'running';
      job = d.job;
      if (d.job.lines) lines = d.job.lines.slice();
      if (wasRunning && d.job.state !== 'running') {
        // сначала быстро — только версии пакетов (CUDA-проверка импортирует torch и идёт секунды), потом CUDA
        rechecking = new Set(d.job.ids || []);
        load(false, false).finally(() => { rechecking = new Set(); render(); load(false, true); });
        log(d.job.state === 'done' ? 'ok' : 'error', `компоненты: ${d.job.state === 'done' ? 'установка завершена' : d.job.error || d.job.state}`);
      }
      render();
    }
  });
  on('update', d => {
    const was = upd?.status;
    upd = { ...(upd || {}), ...d };
    if (d.status === 'ready' && was !== 'ready') log('ok', `maistep ${d.version} скачан — перезапустите окно, чтобы применить`);
    setBadge(badgeCount());
    render();
  });
  on('component-log', d => {
    if (!job || (d.job && d.job !== job.id)) return;
    lines.push(d.text);
    emit('log', { src: 'pip', level: /error|ERROR|failed/.test(d.text) ? 'error' : 'info', text: d.text });
    if (lines.length > 4000) lines.splice(0, lines.length - 4000);
    if (logEl) { logEl.append(h('div', {}, d.text)); logEl.scrollTop = logEl.scrollHeight; }
  });
  on('server', st => {
    if (!st.running) { data = null; upd = null; job = null; lines = []; setBadge(0); render(); }
    else if (isShown('components')) setTimeout(() => load(false, true), 800); // вкладка открыта раньше, чем поднялся сервер
  });
}

// Автопредложение: один раз на набор стабильных обновлений (localStorage). Только stable-канал.
export async function componentsStartupCheck() {
  if (!S.server.running) return;
  try {
    const [d, u] = await Promise.all([componentsStatus({}), updateStatus().catch(() => null)]);
    const missing = d.components.filter(c => c.status === 'missing');
    const updates = d.components.filter(c => c.status === 'update');
    data = d;
    if (u) upd = u;
    setBadge(badgeCount());
    // обновление maistep качается само в фоне и сообщает о готовности в консоль — окно ради него не открываем
    if (!missing.length && !updates.length) return;
    const key = JSON.stringify({ missing: missing.map(c => c.id), updates: updates.map(c => `${c.id}:${c.recommended}`) });
    try { if (localStorage.getItem(NOTIFY) === key) return; localStorage.setItem(NOTIFY, key); } catch {}
    const parts = [];
    if (missing.length) parts.push(`не установлено: ${missing.map(c => c.title).join(', ')}`);
    if (updates.length) parts.push(`можно обновить (стабильные): ${updates.map(c => `${c.title} → ${c.recommended}`).join(', ')}`);
    const r = await messageBox({
      kind: 'info', title: 'Компоненты maistep',
      text: `${parts.join('.\n')}.\n\nОткрыть «Компоненты», чтобы посмотреть версии и скачать/установить недостающее?`,
      ok: 'Открыть компоненты', cancel: 'Позже',
    });
    if (r.ok) openWorkspace('components');
  } catch {}
}
