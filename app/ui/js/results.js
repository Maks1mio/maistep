// Results: очередь запусков и история с результатами (картинки, тексты, файлы). Вид v-results — галерея,
// Hierarchy (контекст results) — очередь и список запусков; щелчок — запуск в Inspector, «Открыть граф» — его воркфлоу.
import { h } from './util.js';
import { S, on, emit, select, addDoc, uniqueId } from './store.js';
import { registerInspector } from './inspector.js';
import { icon } from './icons.js';
import { history, fileUrl, interrupt, clearQueue } from './backend.js';
import { isShown } from './dock.js';

let items = [], filter = 'all';

export async function refresh() {
  if (!S.server.running) { items = []; render(); return; }
  try { items = await history(80); } catch { items = []; }
  render();
  emit('results', items);
}

const outsOf = it => Object.entries(it.outputs || {});
const imagesOf = it => [...new Set(outsOf(it).flatMap(([, o]) => [...(o._ui?.images || []), ...Object.values(o).filter(v => v?.image).map(v => v.image)]))];
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
    rows.push({ ic: it.ok ? 'success' : 'error', label: it.title, tag: `#${it.number} · ${it.time}s`, title: it.at,
      sel: S.sel?.kind === 'run' && S.sel.id === it.prompt_id, onClick: () => select({ kind: 'run', id: it.prompt_id }) });
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

function card(it) {
  const imgs = imagesOf(it), texts = textsOf(it);
  return h(`div.rcard${it.ok ? '' : '.bad'}${S.sel?.kind === 'run' && S.sel.id === it.prompt_id ? '.sel' : ''}`, { onclick: () => select({ kind: 'run', id: it.prompt_id }) },
    h('div.rh', {}, icon(it.ok ? 'success' : 'error', { size: 14 }), h('b', {}, it.title), h('span.dim', {}, `#${it.number} · ${it.time}s · ${it.at.slice(11)}`)),
    imgs.length ? h('div.rimgs', {}, ...imgs.slice(0, 6).map(f => h('img', { src: fileUrl(f), loading: 'lazy', 'data-tip': f }))) : null,
    texts.length ? h('div.rtext', {}, texts[0][1].slice(0, 600)) : null,
    !it.ok ? h('div.rtext.err', {}, (it.error?.message || '').split('\n')[0]) : null);
}

function render() {
  const v = document.getElementById('v-results');
  if (!v) return;
  const list = items.filter(it => filter === 'all' || (filter === 'img' ? imagesOf(it).length : filter === 'text' ? textsOf(it).length : !it.ok));
  const seg = (id, t) => h(`button${filter === id ? '.on' : ''}`, { onclick: () => { filter = id; render(); } }, t);
  const q = S.queue || { running: null, pending: [] };
  v.replaceChildren(
    h('div.bar', {},
      h('button', { onclick: refresh }, icon('refresh', { size: 14 }), 'Обновить'),
      h('div.ui-seg', {}, seg('all', 'Все'), seg('img', 'Картинки'), seg('text', 'Тексты'), seg('err', 'Ошибки')),
      h('span.grow'),
      h('span.dim', {}, q.running ? `выполняется: ${q.running.title}` : 'очередь пуста', q.pending.length ? ` · ждут ${q.pending.length}` : ''),
      h('button', { onclick: interrupt, disabled: !q.running }, icon('stop', { size: 14 }), 'Прервать'),
      h('button', { onclick: clearQueue, disabled: !q.pending.length }, icon('delete', { size: 14 }), 'Очистить очередь')),
    h('div.rgrid', {}, ...(list.length ? list.map(card) : [h('div.msg', {}, S.server.running ? 'Запусков пока нет — нажмите «Запуск» (Ctrl+Enter)' : 'Сервер не запущен')])));
}

function runInspector(s) {
  const it = items.find(x => x.prompt_id === s.id);
  if (!it) return [h('div.dim', {}, 'запуск не найден')];
  return [
    h('h3', {}, icon(it.ok ? 'success' : 'error', { size: 16 }), it.title), h('div.hint', {}, `#${it.number} · ${it.at} · ${it.time} с`),
    it.error ? h('pre.out.err', {}, `${it.error.node ? `нода ${it.error.node}: ` : ''}${it.error.message}`) : null,
    h('button.primary', { style: { margin: '6px 0' }, onclick: () => openAsWorkflow(it) }, icon('blueprint', { size: 14 }), 'Открыть граф'),
    ...outsOf(it).flatMap(([id, o]) => {
      const imgs = [...(o._ui?.images || []), ...Object.values(o).filter(v => v?.image).map(v => v.image)];
      const t = o._ui?.text ?? Object.values(o).find(v => v?.text != null)?.text;
      if (!imgs.length && t == null) return [];
      return [h('h4', {}, `${id}${o._time != null ? ` · ${o._time} с` : ''}`),
        ...imgs.map(f => h('div.preview', {}, h('img', { src: fileUrl(f) }))),
        t != null ? h('pre.out', {}, t) : null];
    }),
  ];
}

export function initResults() {
  registerInspector('run', runInspector);
  on('run-done', () => setTimeout(refresh, 100));
  on('queue', () => { if (isShown('results')) render(); });
  on('server', st => { if (st.running) setTimeout(refresh, 1500); else refresh(); });
  addEventListener('view', e => { if (e.detail === 'results') refresh(); });
}
