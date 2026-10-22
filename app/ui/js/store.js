// Состояние редактора: документы проекта (воркфлоу), «грязные» флаги, отмена/повтор, выделение, шина событий.
// Документ = { kind, id, data, dirty }. kind: workflow.

import { invoke } from './api.js';

const handlers = new Map();
export const on = (evt, fn) => { if (!handlers.has(evt)) handlers.set(evt, []); handlers.get(evt).push(fn); };
export const emit = (evt, data) => { for (const fn of handlers.get(evt) || []) { try { fn(data); } catch (e) { console.error(evt, e); } } };

export const S = {
  project: null,
  docs: { workflow: new Map() },
  current: { workflow: null },
  ctx: 'workflow',       // контекст Hierarchy: workflow | code | results
  sel: null,             // выделение: { kind, doc, id, … }
  server: { running: false, port: 3300 },
  nodes: {},             // каталог нод сервера (/api/nodes)
  run: null,             // текущий запуск: { prompt_id, node, progress, … }
  outputs: {},           // последние результаты по нодам: workflowId → { nodeId: ui }
  componentsJob: null,  // установка компонентов (server/maistep/components.py)
  assets: [],
};

export const PATHS = { workflow: id => `workflows/${id}.json` };

export async function loadProject() {
  const p = await invoke('load_project');
  S.project = p;
  for (const m of Object.values(S.docs)) m.clear();
  for (const d of p.workflows) S.docs.workflow.set(d.id, { kind: 'workflow', id: d.id, data: normalize(d.data), dirty: false });
  if (!S.current.workflow || !S.docs.workflow.has(S.current.workflow)) S.current.workflow = S.docs.workflow.keys().next().value ?? null;
  undoStack.length = 0; redoStack.length = 0;
  emit('project', p);
  for (const e of p.errors || []) emit('log', { src: 'editor', level: 'error', text: e });
}

export const normalize = wf => ({ title: '', nodes: [], links: [], ...wf, nodes: wf?.nodes || [], links: wf?.links || [] });

export const doc = (kind, id) => S.docs[kind]?.get(id) || null;
export const dirtyDocs = () => Object.values(S.docs).flatMap(m => [...m.values()]).filter(d => d.dirty);

// ---------- правка с отменой ----------
const undoStack = [], redoStack = [];
const snap = d => JSON.stringify(d.data);

// mutate(data) меняет документ на месте; merge — ключ для склейки серии правок (перетаскивание, ввод в поле)
export function edit(kind, id, mutate, { label = 'правка', merge = null } = {}) {
  const d = doc(kind, id);
  if (!d) return;
  const before = snap(d);
  const r = mutate(d.data);
  if (r && typeof r === 'object' && r !== d.data) d.data = r;
  const after = snap(d);
  if (before === after) return;
  const last = undoStack.at(-1);
  if (merge && last && last.merge === merge && last.kind === kind && last.id === id && Date.now() - last.t < 1500) {
    last.after = after; last.t = Date.now();
  } else {
    undoStack.push({ kind, id, before, after, label, merge, t: Date.now() });
    if (undoStack.length > 300) undoStack.shift();
  }
  redoStack.length = 0;
  d.dirty = true;
  emit('change', { kind, id });
}

function apply(entry, which) {
  const d = doc(entry.kind, entry.id);
  if (!d) return;
  d.data = JSON.parse(entry[which]);
  d.dirty = true;
  emit('change', { kind: entry.kind, id: entry.id, undo: true });
  emit('status', `${which === 'before' ? 'Отменено' : 'Повторено'}: ${entry.label}`);
}
export function undo() { const e = undoStack.pop(); if (e) { redoStack.push(e); apply(e, 'before'); } }
export function redo() { const e = redoStack.pop(); if (e) { undoStack.push(e); apply(e, 'after'); } }

// ---------- создание / сохранение ----------
export function addDoc(kind, id, data) {
  S.docs[kind].set(id, { kind, id, data: normalize(data), dirty: true, created: true });
  emit('change', { kind, id, created: true });
}

export async function removeDoc(kind, id) {
  await invoke('data_delete', { path: PATHS[kind](id) });
  S.docs[kind].delete(id);
  if (S.current[kind] === id) S.current[kind] = S.docs[kind].keys().next().value ?? null;
  emit('change', { kind, id, removed: true });
  emit('log', { src: 'editor', level: 'info', text: `${PATHS[kind](id)} удалён` });
}

export async function save(d, { quiet = false } = {}) {
  const snapAt = snap(d);
  await invoke('data_write', { path: PATHS[d.kind](d.id), value: d.data, pretty: true });
  // правка, сделанная во время записи, остаётся несохранённой — её подхватит следующее автосохранение
  d.dirty = snap(d) !== snapAt;
  d.created = false;
  emit('saved', d);
  if (!quiet) emit('log', { src: 'editor', level: 'ok', text: `сохранено: ${PATHS[d.kind](d.id)}` });
}

export async function saveAll() {
  const list = dirtyDocs();
  for (const d of list) {
    try { await save(d); } catch (e) { emit('log', { src: 'editor', level: 'error', text: `не сохранено ${PATHS[d.kind](d.id)}: ${e}` }); }
  }
  if (!list.length) emit('status', 'Нет несохранённых изменений');
  emit('change', { kind: null });
  return list;
}

export function select(sel) {
  S.sel = sel;
  emit('select', sel);
}

export function uniqueId(base, taken) {
  const t = new Set(taken);
  if (!t.has(base)) return base;
  for (let i = 2; ; i++) if (!t.has(`${base}${i}`)) return `${base}${i}`;
}
