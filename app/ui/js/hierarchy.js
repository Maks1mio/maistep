// Hierarchy: дерево того, с чем работает текущая рабочая область (Workflow — воркфлоу и их ноды, Results —
// очередь и история запусков, Models — категории моделей, CodeEditor — файлы кода). Контекст задаёт рабочая область.
import { h, prompt, confirmBox } from './util.js';
import { icon } from './icons.js';
import { popup } from './ctxmenu.js';
import { S, on, emit, doc, select, addDoc, removeDoc, save } from './store.js';
import { codeTreeItems } from './codeedit.js';
import { resultsTreeItems } from './results.js';
import { libraryTreeItems } from './library.js';
import { civitaiTreeItems } from './civitai.js';
import { componentsTreeItems } from './components.js';
import { naizerTreeItems } from './naizer.js';
import { TEMPLATES } from './templates.js';

const VALID_ID = /^[A-Za-z0-9_-]+$/;

export async function newWorkflow(template = 'empty') {
  const r = await prompt('Новый воркфлоу', [
    { key: 'id', label: 'id файла (латиница, _ -)', value: '' },
    { key: 'title', label: 'Название', value: '' },
    { key: 'tpl', label: 'Шаблон', type: 'select', value: template, options: Object.entries(TEMPLATES).map(([k, t]) => [k, t.title]) },
  ], 'Создать');
  if (!r?.id) return;
  if (!VALID_ID.test(r.id) || S.docs.workflow.has(r.id)) return emit('log', { src: 'editor', level: 'warn', text: `id «${r.id}» недопустим или занят` });
  const data = structuredClone(TEMPLATES[r.tpl || 'empty'].data);
  data.title = r.title || data.title || r.id;
  addDoc('workflow', r.id, data);
  openWf(r.id);
}

async function duplicateWf() {
  const d = doc('workflow', S.current.workflow);
  if (!d) return;
  const r = await prompt('Копия воркфлоу', [{ key: 'id', label: 'id копии', value: `${d.id}_copy` }], 'Создать');
  if (!r?.id || !VALID_ID.test(r.id) || S.docs.workflow.has(r.id)) return;
  addDoc('workflow', r.id, { ...structuredClone(d.data), title: `${d.data.title || d.id} (копия)` });
  openWf(r.id);
}

async function delWf() {
  const id = S.current.workflow;
  if (!id || !(await confirmBox(`Удалить workflows/${id}.json?`))) return;
  await removeDoc('workflow', id);
  emit('current', 'workflow');
  draw();
}

function openWf(id) {
  S.current.workflow = id;
  select({ kind: 'workflow', doc: id, id });
  emit('current', 'workflow');
  draw();
}

function bar() {
  const b = document.getElementById('hier-bar');
  b.replaceChildren();
  if (S.ctx === 'workflow') {
    b.append(h('button', { onclick: () => newWorkflow(), 'data-tip': 'Новый воркфлоу' }, icon('add', { size: 14 }), 'воркфлоу'),
      h('button.icon', { 'data-tip': 'Дублировать', onclick: duplicateWf }, icon('copy', { size: 14 })),
      h('button.icon', { 'data-tip': 'Сохранить', onclick: () => { const d = doc('workflow', S.current.workflow); if (d) save(d).then(draw); } }, icon('save', { size: 14 })),
      h('button.icon', { 'data-tip': 'Удалить файл', onclick: delWf }, icon('delete', { size: 14 })));
  }
}

// act — кнопка справа при наведении: { ic, tip, onClick }; menu() — пункты контекстного меню (ctxmenu.js)
function item({ depth = 0, ic, label, tag, sel, dirty, title, onClick, twisty, act, menu }) {
  return h(`div.item${sel ? '.sel' : ''}${dirty ? '.dirty' : ''}`, { style: { paddingLeft: `${4 + depth * 16}px` }, title: title || '', onclick: onClick,
    oncontextmenu: menu ? e => popup(e, menu()) : null },
    h('span.tw', {}, twisty ? icon(twisty === 'open' ? 'down' : 'right', { size: 16 }) : null),
    ic ? icon(ic, { size: 16 }) : null, h('span.nm', {}, label), tag ? h('span.tag', {}, tag) : null,
    act ? h('button.icon.act', { 'data-tip': act.tip || '', onclick: e => { e.stopPropagation(); act.onClick(); } }, icon(act.ic, { size: 14 })) : null);
}

function wfTree(t) {
  if (!S.docs.workflow.size) return t.append(h('div.grp', {}, 'нет воркфлоу — создайте «+»'));
  for (const [id, d] of S.docs.workflow) {
    const cur = id === S.current.workflow;
    t.append(item({ ic: 'blueprint', label: d.data.title || id, tag: id, dirty: d.dirty, twisty: cur ? 'open' : 'closed', title: d.data.about || '',
      sel: S.sel?.kind === 'workflow' && S.sel.doc === id, onClick: () => openWf(id) }));
    if (!cur) continue;
    for (const n of d.data.nodes) {
      const def = S.nodes[n.type];
      const st = S.outputs[id]?.[n.id];
      t.append(item({ depth: 1, ic: st?._error ? 'error' : def?.output ? 'play' : 'node', label: n.title || def?.title || n.type, tag: `${n.id}${n.mode === 'mute' ? ' · выкл' : ''}`,
        sel: S.sel?.kind === 'node' && S.sel.doc === id && S.sel.id === n.id, onClick: () => select({ kind: 'node', doc: id, id: n.id }) }));
    }
  }
}

export function draw() {
  bar();
  const t = document.getElementById('hier-tree');
  t.replaceChildren();
  if (S.ctx === 'code') for (const row of codeTreeItems()) t.append(item(row));
  else if (S.ctx === 'results') for (const row of resultsTreeItems()) t.append(row.grp ? h('div.grp', {}, row.grp) : item(row));
  else if (S.ctx === 'library') for (const row of libraryTreeItems()) t.append(row.grp ? h('div.grp', {}, row.grp) : item(row));
  else if (S.ctx === 'civitai') for (const row of civitaiTreeItems()) t.append(row.grp ? h('div.grp', {}, row.grp) : item(row));
  else if (S.ctx === 'components') for (const row of componentsTreeItems()) t.append(row.grp ? h('div.grp', {}, row.grp) : item(row));
  else if (S.ctx === 'naizer') for (const row of naizerTreeItems()) t.append(row.grp ? h('div.grp', {}, row.grp) : item(row));
  else wfTree(t);
}

export function initHierarchy() {
  on('project', draw);
  on('change', draw);
  on('select', draw);
  on('saved', draw);
  on('nodes', draw);
  on('run-done', draw);
  on('run-error', draw);
  on('queue', () => { if (S.ctx === 'results') draw(); });
  on('results', () => { if (S.ctx === 'results') draw(); });
  on('library', () => { if (S.ctx === 'library') draw(); });
  on('new-workflow', () => newWorkflow());
}
