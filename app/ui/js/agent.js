// AI Chat — агент прямо в редакторе (как Claude). Два вида одного агента: панель (маленький чат, ставится в любую
// область) и вкладка «AI Chat» (как приложение Claude: слева диалоги по проектам, по центру разговор, справа среда —
// компьютер, папка, ветка, контекст, доступ, коннекторы MCP, изменения git).
// Среды диалога: Agent — только программа: граф, картинки (генерация и правка присланных фото), ImageNaizer, интернет,
// управление окном; Code — помощник программиста в папке проекта на ПК (файлы, команды, git; в папке maistep ещё и JS
// в окне); RP — ролевой чат-бот с характером и своими фото. Взрослый контент разрешён всегда (кроме жёстких запретов),
// переключателя нет: диалог получает метку 18+ сам, когда разговор уходит во взрослую тему.
// Модели — любые провайдеры (настройки), в т.ч. локальный llama.cpp; MCP-серверы — инструменты для Agent и Code.
// Хранение и ход агента — сервер (server/maistep/agent.py, /api/agent/*, события SSE agent). Правки графа от агента
// применяются обычной правкой — Ctrl+Z отменяет. Действия в окне (agent/client) исполняет этот модуль, разрешения
// на запись файлов и команды (agent/approve) — карточка в разговоре.
import { h, esc, prompt, confirmBox, fill } from './util.js';
import { S, on, emit, doc, edit, addDoc, normalize } from './store.js';
import { icon } from './icons.js';
import { api, upload, fileUrl, getSettings, serverBase } from './backend.js';
import { modelPicker } from './modelpick.js';
import { lightbox } from './graph.js';
import { dropdown, onOff, search } from './kit.js';
import { openWorkspace, workspace, activeView } from './dock.js';
import { naizerApi } from './naizer.js';
import { imagePicker } from './images.js';
import { libraryPicker } from './library.js';
import { pickFolder } from './folders.js';
import { openSettings } from './settings.js';
import { recentLog } from './console.js';
import { openExternal } from './api.js';

let chats = [], chars = [], provs = null, pop = null, projects = [], mcpSt = { servers: [] };
const busy = new Set(), approvals = new Map(), views = [];
const log = (level, text) => emit('log', { src: 'agent', level, text });
const MODES = {
  agent: ['Agent', 'ai', 'Только программа: графы, картинки, ImageNaizer, интернет, управление окном'],
  code: ['Code', 'code', 'Помощник программиста в папке проекта: файлы, команды, тесты, git'],
  character: ['RP', 'profile', 'Ролевой чат с персонажем и его фото'],
};
const charOf = id => chars.find(c => c.id === id) || null;
// метка диалога: разговор ушёл во взрослую тему (ставит сервер — маркер модели или откровенный промпт картинки)
const ADULT_MARK = '⟦18+⟧';
const adultTag = () => h('span.agb-18', { 'data-tip': 'Разговор на взрослую тему' }, '18+');
const base = p => String(p || '').split(/[\\/]/).filter(Boolean).pop() || p;
const kTok = n => (n >= 1e6 ? `${+(n / 1e6).toFixed(n % 1e6 ? 1 : 0)}M` : n >= 1000 ? `${+(n / 1000).toFixed(1)}k` : String(n | 0));
const LSK = 'maistep-chat-ui';
const ui = (() => { try { return JSON.parse(localStorage.getItem(LSK)) || {}; } catch { return {}; } })();
const saveUi = () => { try { localStorage.setItem(LSK, JSON.stringify(ui)); } catch {} };
ui.closed ||= {}; ui.cards ||= {};

// ---------- данные ----------
async function loadAll() {
  if (!S.server.running) return;
  try { [chats, chars] = await Promise.all([api('/api/agent/chats'), api('/api/agent/characters')]); }
  catch (e) { log('error', `диалоги: ${e.message}`); return; }
  loadSide();
  busy.clear();
  for (const c of chats) if (c.busy) busy.add(c.id);
  for (const v of views) if (v.el?.isConnected) await v.restore();
}
// недавние папки и MCP-серверы — для выбора папки и правой панели
async function loadSide() {
  let list;
  [projects, mcpSt, list] = await Promise.all([api('/api/agent/projects').catch(() => projects), api('/api/mcp').catch(() => mcpSt),
    api('/api/agent/procs').catch(() => null)]);
  if (list) { procs.clear(); for (const p of list) procs.set(p.id, p); }
  for (const v of views) v.renderEnv?.();
}

// ход агента, как строка статуса у Claude: «••• 1 мин 12 с · токенов: 3.4k · Размышление»
const runInfo = new Map(); // chat → { t0, tok, chars, phase }
const procs = new Map();   // id → фоновый процесс агента (сервер, сборка…)
function trackRun(d) {
  if (d.kind === 'start') runInfo.set(d.chat, { t0: Date.now(), tok: 0, chars: 0, phase: 'Думает' });
  const r = runInfo.get(d.chat);
  if (!r) return;
  if (r.stopping && !['message', 'done'].includes(d.kind)) return; // после «Стоп» строку хода не перебиваем
  if (d.kind === 'thinking') { r.chars += d.text.length; r.phase = 'Размышление'; }
  else if (d.kind === 'delta') { r.chars += d.text.length; r.phase = 'Пишет ответ'; }
  else if (d.kind === 'tool_start') r.phase = `Готовит: ${toolLabel(d.name)}`;
  else if (d.kind === 'tool_run') {
    r.chars += JSON.stringify(d.input || {}).length; // аргументы вызова — тоже вывод модели
    const arg = toolArg({ input: d.input }).slice(0, 50);
    r.phase = `${toolLabel(d.name)}${arg ? ` · ${arg}` : ''}`;
  }
  else if (d.kind === 'tool_result') r.phase = 'Думает';
  else if (d.kind === 'approve') r.phase = 'Ждёт вашего разрешения';
  else if (d.kind === 'status') r.phase = d.text;
  else if (d.kind === 'stopping') { r.phase = 'Останавливается…'; r.stopping = true; }
  else if (d.kind === 'message' && d.message.usage) { r.tok += d.message.usage.out || 0; r.chars = 0; }
  else if (d.kind === 'done') runInfo.delete(d.chat);
}
async function forgetProc(id) {
  try { await api('/api/agent/proc_forget', { id }); } catch (e) { log('error', e.message); }
  procs.delete(id);
  for (const v of views) v.renderEnv();
}
const fmtTime = ms => { const s = Math.floor(ms / 1000); return s < 60 ? `${s} с` : `${Math.floor(s / 60)} мин ${s % 60} с`; };
const runText = r => `${fmtTime(Date.now() - r.t0)} · токенов: ${kTok(r.tok + Math.round(r.chars / 3.5))} · ${r.phase}`;
setInterval(() => { for (const el of document.querySelectorAll('.ag-run[data-chat]')) { const r = runInfo.get(el.dataset.chat); if (r) el.querySelector('.t').textContent = runText(r); } }, 1000);
const loadList = async () => {
  try { [chats, chars] = await Promise.all([api('/api/agent/chats'), api('/api/agent/characters')]); } catch { return; }
  for (const v of views) v.renderChrome();
};
function upsertMeta(c) {
  const i = chats.findIndex(x => x.id === c.id);
  const { messages, ...m } = c;
  if (i >= 0) chats[i] = { ...chats[i], ...m }; else chats.unshift({ count: 0, ...m });
}

// ---------- события сервера ----------
function onAgent(d) {
  if (d.kind === 'workflow') return applyWorkflow(d);
  if (d.kind === 'client') return clientAction(d);
  if (d.kind === 'approve') { (approvals.get(d.chat) || approvals.set(d.chat, []).get(d.chat)).push(d); }
  if (d.kind === 'approve_done') { const a = approvals.get(d.chat); if (a) approvals.set(d.chat, a.filter(x => x.req !== d.req)); }
  if (d.kind === 'proc_log') { for (const l of d.lines) emit('log', { src: 'agent', level: /error|ошибк|failed|exception/i.test(l) ? 'error' : 'info', text: `[${d.id}] ${l}` }); return; }
  if (d.kind === 'proc') { procs.set(d.proc.id, d.proc); for (const v of views) v.renderEnv(); return; }
  if (d.kind === 'proc_gone') { procs.delete(d.id); for (const v of views) v.renderEnv(); return; }
  if (d.kind === 'start') busy.add(d.chat);
  if (d.kind === 'done') { busy.delete(d.chat); approvals.delete(d.chat); loadList(); }
  trackRun(d);
  for (const v of views) v.onAgent(d);
}

// правка от агента: одна отменяемая правка документа (или новый воркфлоу)
function applyWorkflow(d) {
  if (d.created || !doc('workflow', d.id)) {
    if (doc('workflow', d.id)) return;
    addDoc('workflow', d.id, d.data);
    log('ok', `агент создал воркфлоу «${d.data.title || d.id}»`);
    emit('open-workflow', d.id);
    return;
  }
  edit('workflow', d.id, () => normalize(d.data), { label: 'AI Agent' });
  log('info', `агент изменил «${d.id}» (Ctrl+Z — отменить)`);
}

// действия агента в окне (инструмент app и run_js)
const list = v => (Array.isArray(v) ? v : v ? [v] : []);
const ACTIONS = {
  state: () => ({ tab: workspace(), view: activeView(), workflow: S.current.workflow, workflows: [...S.docs.workflow.keys()],
    selection: S.sel ? { kind: S.sel.kind, id: S.sel.id } : null, server: S.server.running }),
  open_tab: ({ tab }) => { openWorkspace(tab); return { tab: workspace() }; },
  open_workflow: ({ id }, chat) => {
    if (!doc('workflow', id) || chat?.hidden?.includes(id)) throw new Error(`нет воркфлоу ${id}`);
    openWorkspace('graph'); emit('open-workflow', id); return { opened: id };
  },
  show_image: ({ file }) => { lightbox(list(file).map(fileUrl), 0); return { shown: file }; },
  notify: ({ text, level }) => { log(level || 'info', `агент: ${text}`); return { ok: true }; },
  console: ({ lines, src, errors }) => recentLog(lines, src, errors),
  browser_open: ({ url, path, mobile }) => {
    const v = views.find(x => x.big);
    if (workspace() !== 'chat') openWorkspace('chat');
    const u = path ? `${serverBase()}${path}` : url; // path — файл проекта, его отдаёт сервер maistep (/agentfs/…)
    v.showBrowser(u, !!mobile);
    return { opened: u };
  },
  naizer_state: () => naizerApi.state(),
  naizer_open: ({ files, name }) => { openWorkspace('naizer'); return naizerApi.open(list(files), name); },
  naizer_add: ({ files }) => { openWorkspace('naizer'); return naizerApi.add(list(files)); },
  naizer_mask: ({ rects, strength }) => { openWorkspace('naizer'); return naizerApi.mask(list(rects), strength); },
  naizer_clear_masks: () => naizerApi.clearMasks(),
  naizer_generate: a => { openWorkspace('naizer'); return naizerApi.generate(a); },
  naizer_snapshot: () => naizerApi.snapshot(),
  eval: async ({ code }) => {
    const fn = new (Object.getPrototypeOf(async () => {}).constructor)(code);
    const r = await fn();
    return r === undefined ? null : JSON.parse(JSON.stringify(r));
  },
};
async function clientAction(d) {
  const fn = ACTIONS[d.action];
  let body;
  try {
    if (!fn) throw new Error(`неизвестное действие ${d.action} (есть: ${Object.keys(ACTIONS).join(', ')})`);
    body = { ok: true, result: await fn(d.args || {}, chats.find(c => c.id === d.chat)) };
  } catch (e) { body = { ok: false, error: `${e.name}: ${e.message}` }; }
  api('/api/agent/client', { req: d.req, ...body }).catch(() => {});
}

// ---------- markdown (минимальный, безопасный: сначала экранирование) ----------
function md(src) {
  const blocks = [];
  let s = esc(src).replace(/```(\w*)\n?([\s\S]*?)(```|$)/g, (_, lang, code) => { blocks.push(`<pre class="ag-code"><code>${code.replace(/\n$/, '')}</code></pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  const inline = t => t
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const out = [];
  let lst = null, table = null;
  const flush = () => { if (lst) { out.push(`<${lst.t}>${lst.items.map(i => `<li>${inline(i)}</li>`).join('')}</${lst.t}>`); lst = null; } if (table) { out.push(tableHtml(table, inline)); table = null; } };
  for (const line of s.split('\n')) {
    let m;
    if ((m = line.match(/^\u0000(\d+)\u0000$/))) { flush(); out.push(blocks[+m[1]]); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { if (lst) flush(); (table ||= []).push(line); continue; }
    if (table) flush();
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flush(); out.push(`<div class="ag-h${m[1].length}">${inline(m[2])}</div>`); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { if (lst?.t !== 'ul') { flush(); lst = { t: 'ul', items: [] }; } lst.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (lst?.t !== 'ol') { flush(); lst = { t: 'ol', items: [] }; } lst.items.push(m[1]); continue; }
    flush();
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) out.push('<hr>');
    else if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  flush();
  return out.join('').replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[+i]);
}
function tableHtml(rows, inline) {
  const cells = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
  const body = rows.filter(r => !/^\s*\|[\s:|-]+\|\s*$/.test(r));
  const [head, ...rest] = body;
  return `<table class="ag-table"><thead><tr>${cells(head).map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rest.map(r => `<tr>${cells(r).map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
const mdEl = text => {
  const el = h('div.ag-md');
  el.innerHTML = md(text);
  for (const pre of el.querySelectorAll('pre.ag-code')) {
    pre.append(h('button.ag-copy', { 'data-tip': 'Копировать код', onclick: e => {
      navigator.clipboard?.writeText(pre.querySelector('code').textContent);
      e.currentTarget.replaceChildren(icon('check', { size: 14 }));
    } }, icon('copy', { size: 14 })));
  }
  return el;
};
// «4 минуты назад»
function ago(t) {
  if (!t) return '';
  const s = Date.now() / 1000 - t;
  if (s < 50) return 'только что';
  if (s < 3600) { const n = Math.round(s / 60); return `${n} ${plural(n, 'минуту', 'минуты', 'минут')} назад`; }
  if (s < 86400) { const n = Math.round(s / 3600); return `${n} ${plural(n, 'час', 'часа', 'часов')} назад`; }
  return new Date(t * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
}

// ---------- общие элементы ----------
const TOOL_LABEL = { list_workflows: 'Список воркфлоу', get_workflow: 'Читает граф', edit_workflow: 'Правит граф', create_workflow: 'Создаёт воркфлоу',
  run_workflow: 'Запускает', view_image: 'Смотрит картинку', list_models: 'Ищет модели', node_info: 'Описание ноды',
  generate_image: 'Генерирует картинку', edit_image: 'Правит картинку', web_search: 'Ищет в интернете', web_fetch: 'Открывает страницу',
  app: 'Действие в окне', list_files: 'Файлы', read_file: 'Читает файл', search_code: 'Ищет в коде', edit_file: 'Правит файл',
  write_file: 'Пишет файл', run_command: 'Команда', run_js: 'JS в окне', send_photo: 'Фото', todo_write: 'Список задач',
  process_output: 'Вывод процесса', process_stop: 'Останавливает процесс', process_list: 'Процессы', app_console: 'Читает консоль',
  browser_open: 'Открывает в браузере', find_models: 'Ищет на Civitai', download_model: 'Скачивает модель' };

// mcp__сервер__инструмент → «MCP сервер · инструмент»
const toolLabel = n => TOOL_LABEL[n] || (n.startsWith('mcp__') ? `MCP ${n.slice(5).replace('__', ' · ')}` : n);
function toolArg(t) {
  const i = t.input || {};
  const a = i.id || i.file || i.path || i.query || i.url || i.source || i.action || i.command || i.image || i.cat || i.type || i.pattern || i.prompt || i.scene || '';
  return String(a).slice(0, 90);
}
// ---------- вызовы инструментов: группа с итогом, как у Claude («Изменил agent.js +12 −3, прочитал 2 файла ▸») ----------
const plural = (n, a, b, c) => { const m = n % 10, k = n % 100; return m === 1 && k !== 11 ? a : m >= 2 && m <= 4 && (k < 12 || k > 14) ? b : c; };
const fileName = p => String(p || '').split(/[\\/]/).pop();
// грубый построчный diff: строки, которых нет в другой стороне (с учётом повторов)
function lineDiff(a, b) {
  const cnt = new Map();
  for (const l of String(a ?? '').split('\n')) cnt.set(l, (cnt.get(l) || 0) + 1);
  let add = 0;
  for (const l of String(b ?? '').split('\n')) { const c = cnt.get(l) || 0; if (c) cnt.set(l, c - 1); else add++; }
  let del = 0;
  for (const v of cnt.values()) del += v;
  return { add, del };
}
function editStat(t, res) {
  const i = t.input || {};
  if (t.name === 'edit_file') return lineDiff(i.old, i.new);
  if (t.name === 'write_file') return { add: String(i.content || '').split('\n').length, del: 0, created: !/rewrote/.test(res?.content || '') };
  return null;
}
// вызов не удался: ошибка инструмента или команда с ненулевым кодом выхода / убита
const failedRes = (t, res) => !!res && (!res.ok || (t.name === 'run_command' && /^(exit [1-9-]|killed)/m.test(res.content || '')));
const plusMinus = s => [s.add ? h('span.agb-add', {}, ` +${s.add}`) : null, s.del ? h('span.agb-del', {}, ` −${s.del}`) : null];

function summarize(tools, results, running) {
  const files = new Map(), reads = new Set(), counts = new Map();
  let searches = 0, cmds = 0, failed = 0;
  for (const t of tools) {
    const res = results.get(t.id);
    if (failedRes(t, res)) failed++;
    const i = t.input || {};
    if (t.name === 'edit_file' || t.name === 'write_file') {
      const s = editStat(t, res), f = files.get(i.path) || { add: 0, del: 0, created: false };
      files.set(i.path, { add: f.add + s.add, del: f.del + s.del, created: f.created || (t.name === 'write_file' && s.created) });
    } else if (t.name === 'read_file') reads.add(i.path);
    else if (t.name === 'list_files' || t.name === 'search_code') searches++;
    else if (t.name === 'run_command') cmds++;
    else if (t.name !== 'todo_write') counts.set(toolLabel(t.name), (counts.get(toolLabel(t.name)) || 0) + 1);
  }
  const parts = [];
  const edited = [...files].filter(([, f]) => !f.created), created = [...files].filter(([, f]) => f.created);
  const fileList = list => list.slice(0, 3).flatMap(([p, f], k) => [k ? ', ' : ' ', h('b', {}, fileName(p)), ...plusMinus(f)]).concat(list.length > 3 ? [` и ещё ${list.length - 3}`] : []);
  if (edited.length) parts.push(['Изменил', ...fileList(edited)]);
  if (created.length) parts.push(['Создал', ...fileList(created)]);
  if (reads.size) parts.push(reads.size === 1 ? ['прочитал ', h('b', {}, fileName([...reads][0]))] : [`прочитал ${reads.size} ${plural(reads.size, 'файл', 'файла', 'файлов')}`]);
  if (searches) parts.push([`искал в файлах${searches > 1 ? ` ×${searches}` : ''}`]);
  if (cmds) parts.push([`выполнено ${cmds} ${plural(cmds, 'команда', 'команды', 'команд')}`]);
  for (const [label, n] of counts) parts.push([`${label}${n > 1 ? ` ×${n}` : ''}`]);
  if (!parts.length && tools.some(t => t.name === 'todo_write')) parts.push(['Обновил список задач']);
  const out = parts.flatMap((p, k) => (k ? [', ', ...p] : p));
  if (typeof out[0] === 'string') out[0] = out[0][0].toUpperCase() + out[0].slice(1);
  return [running ? h('span.ag-tdot.run') : failed ? h('span.ag-tdot.bad', { 'data-tip': `ошибок: ${failed}` }) : null, h('span.ag-gs', {}, ...out)];
}

// тело вызова: правка файла — diff, запись — содержимое, команда — $ команда и вывод, остальное — JSON
function toolBody(t, res) {
  const i = t.input || {}, out = [];
  const lines = (txt, cls, sign) => String(txt ?? '').split('\n').slice(0, 400).map(l => h(`span.${cls}`, {}, `${sign} ${l}\n`));
  if (t.name === 'edit_file') out.push(h('pre.ag-json.agb-diff', {}, ...lines(i.old, 'd', '−'), ...lines(i.new, 'a', '+')));
  else if (t.name === 'write_file') out.push(h('pre.ag-json.agb-diff', {}, ...lines(i.content, 'a', '+')));
  else if (t.name === 'run_command') out.push(h('pre.ag-json', {}, `$ ${i.command}`));
  else if (t.name === 'todo_write') out.push(h('pre.ag-json', {}, (i.todos || []).map(x => `${x.status === 'completed' ? '✓' : x.status === 'in_progress' ? '▸' : '○'} ${x.content}`).join('\n')));
  else if (Object.keys(i).length) out.push(h('pre.ag-json', {}, JSON.stringify(i, null, 1).slice(0, 4000)));
  if (res && (t.name !== 'write_file' && t.name !== 'edit_file' || !res.ok)) out.push(h(`pre.ag-json${res.ok ? '' : '.err'}`, {}, String(res.content || '').slice(0, 6000)));
  return out;
}

function toolChip(t, res, running = false, view = null) {
  const arg = toolArg(t), st = editStat(t, res);
  const head = h('summary', {}, icon('right', { size: 16, cls: 'ag-tw' }),
    h(`span.ag-tdot${running ? '.run' : res ? (failedRes(t, res) ? '.bad' : '.ok') : ''}`),
    h('b', {}, toolLabel(t.name)), arg ? h('span.dim', {}, ` ${arg}`) : null, ...(st ? plusMinus(st) : []),
    t.name === 'edit_workflow' && t.input?.ops ? h('span.dim', {}, ` · ${t.input.ops.length} правок`) : null);
  const det = h('details', {}, head, ...toolBody(t, res));
  view?.keepOpen(`t:${t.id}`, det);
  const imgs = res?.images?.length ? h('div.ag-imgs', {}, ...res.images.map((f, i, all) => thumb(f, all, i))) : null;
  return h('div.ag-tool', {}, det, imgs);
}
function thumb(f, all = [f], i = 0, cls = '.ag-thumb') {
  return h(`img${cls}`, { src: fileUrl(f), loading: 'lazy', draggable: false, 'data-tip': f, onclick: () => lightbox(all.map(fileUrl), i) });
}
// аватар персонажа: картинка или первая буква на цветном круге
function avatar(c, size = 28) {
  const st = { width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.45)}px` };
  if (c?.avatar) return h('img.ag-ava', { src: fileUrl(c.avatar), style: st, alt: '', draggable: false });
  const hue = [...(c?.name || '?')].reduce((a, ch) => a + ch.charCodeAt(0), 0) % 6;
  return h(`span.ag-ava.c${hue}`, { style: st }, (c?.name || '?').trim()[0]?.toUpperCase() || '?');
}
const ddLink = (cls, tip, onclick, ...content) => h(`button.ui-dd.link${cls}`, { type: 'button', onclick: e => onclick(e.currentTarget), 'data-tip': tip },
  ...content, h('span.chev', {}, icon('down', { size: 16 })));
const tipped = (el, tip) => { el.dataset.tip = tip; return el; };

// ---------- попапы ----------
// попап закрывается по pointerdown вне его; если это нажатие пришлось на кнопку, открывшую попап, следующий click по ней
// не открывает его снова — кнопка работает как переключатель (раньше меню закрывалось и тут же открывалось)
let closedBy = null;
function closePop() { pop?.remove(); pop = null; }
function place(el, anchor, up = false) {
  if (closedBy && closedBy === anchor) { closedBy = null; return; }
  closePop();
  el.anchor = anchor;
  document.body.append(el);
  const r = anchor.getBoundingClientRect(), w = el.offsetWidth, hh = el.offsetHeight;
  el.style.left = `${Math.max(4, Math.min(r.left, innerWidth - w - 6))}px`;
  el.style.top = `${up && r.top - hh - 4 > 4 ? r.top - hh - 4 : Math.min(r.bottom + 4, innerHeight - hh - 6)}px`;
  pop = el;
}
const tbBtn = (ic, tip, fn) => h('button.b', { onclick: e => { e.stopPropagation(); closePop(); fn(); }, 'data-tip': tip }, icon(ic, { size: 16 }));

// ---------- вид чата ----------
class ChatView {
  constructor(el, big) {
    Object.assign(this, { el, big, chat: null, draft: null, running: new Set(), attach: [], filterWf: false, query: '', listEl: null, draftEl: null, ta: null, attachEl: null,
      opened: new Set(), pinned: true, top: 0, queue: [] });
    this.LS = big ? 'maistep-agent-chat-big' : 'maistep-agent-chat';
    el.addEventListener('dragover', e => { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); el.classList.add('drop'); } });
    el.addEventListener('dragleave', e => { if (!el.contains(e.relatedTarget)) el.classList.remove('drop'); });
    el.addEventListener('drop', e => { e.preventDefault(); el.classList.remove('drop'); this.addFiles([...e.dataTransfer.files]); });
  }

  async restore() {
    const want = this.chat?.id || (() => { try { return localStorage.getItem(this.LS); } catch { return null; } })();
    if (want && chats.some(c => c.id === want)) await this.open(want, false);
    else if (chats.length) await this.open(chats[0].id, false);
    else { this.chat = null; this.render(); }
  }

  async open(id, focus = true) {
    try { this.chat = await api(`/api/agent/chat?id=${id}`); } catch (e) { log('error', e.message); return; }
    try { localStorage.setItem(this.LS, id); } catch {}
    this.draft = busy.has(id) ? { text: '', thinking: '', tools: [] } : null;
    this.running.clear();
    this.status = '';
    this.env = { ctx: null, git: null };
    this.opened.clear(); this.queue = []; this.top = 0;
    this.render(true);
    this.refreshEnv();
    if (focus) this.ta?.focus();
  }

  // новый диалог в той же среде (режим, папка, модель), что и открытый; fields — переопределить
  async newChat(fields = {}) {
    const b = this.chat || {};
    const mode = fields.character ? undefined : fields.mode || (b.mode === 'code' ? 'code' : 'agent');
    const env = mode === 'code' ? { cwd: fields.cwd !== undefined ? fields.cwd : b.cwd || null } : {};
    const c = await api('/api/agent/chat', { provider: b.provider || provs?.default_provider, model: b.model, wf: S.current.workflow, mode, ...env, ...fields });
    if (b.effort && b.effort !== 'medium') await api('/api/agent/chat', { id: c.id, effort: b.effort });
    upsertMeta(c);
    await this.open(c.id);
    for (const v of views) if (v !== this) v.renderChrome();
  }

  async patch(fields) {
    if (!this.chat) return;
    try {
      const c = await api('/api/agent/chat', { id: this.chat.id, ...fields });
      Object.assign(this.chat, c);
      upsertMeta(c);
    } catch (e) { log('error', e.message); }
    this.render();
    this.refreshEnv();
    if (fields.cwd) loadSide();
    for (const v of views) if (v !== this) { if (v.chat?.id === this.chat.id) Object.assign(v.chat, fields); v.renderChrome(); }
  }

  async remove(id) {
    if (!(await confirmBox('Удалить диалог? Это нельзя отменить.'))) return;
    await api('/api/agent/delete', { id });
    chats = chats.filter(c => c.id !== id);
    for (const v of views) {
      if (v.chat?.id === id) { v.chat = null; if (chats[0]) await v.open(chats[0].id, false); else v.render(); }
      else v.renderChrome();
    }
  }

  async rename(c) {
    const r = await prompt('Диалог', [{ key: 't', label: 'Название', value: c.title || '' }], 'Сохранить');
    if (r?.t == null) return;
    if (c.id === this.chat?.id) return this.patch({ title: r.t });
    await api('/api/agent/chat', { id: c.id, title: r.t });
    loadList();
  }

  // видимые агенту воркфлоу — текущее состояние редактора (с несохранёнными правками)
  visible() { return Object.fromEntries([...S.docs.workflow].filter(([id]) => !this.chat?.hidden?.includes(id)).map(([id, d]) => [id, d.data])); }

  async send(textArg, label = null) {
    if (!this.chat) await this.newChat();
    const text = (textArg ?? this.ta.value).trim();
    if (!text && !this.attach.length) return;
    if (busy.has(this.chat.id)) {
      if (label) return;
      // как у Claude: пока агент отвечает, сообщение встаёт в очередь и уходит после ответа
      this.queue.push({ text, images: this.attach.map(a => a.file) });
      this.ta.value = ''; this.attach = []; this.autosize(); this.renderAttach(); this.renderTodos();
      return;
    }
    if (this.editing != null && !label) {
      const at = this.editing;
      this.editing = null;
      try { this.chat = await api('/api/agent/rewind', { id: this.chat.id, index: at }); } catch (e) { return log('error', e.message); }
      this.render(true);
    }
    if (label) { // кнопка: поле ввода и вложения не трогаем
      try { await api('/api/agent/send', { id: this.chat.id, text, images: [], label, workflows: {} }); } catch (e) { log('error', e.message); }
      return;
    }
    const images = this.attach.map(a => a.file);
    this.ta.value = ''; this.attach = []; this.autosize(); this.renderAttach();
    try { await api('/api/agent/send', { id: this.chat.id, text, images, workflows: this.visible() }); }
    catch (e) { log('error', e.message); this.ta.value = text; }
  }
  // «Стоп» отвечает сразу: строка хода и кнопка меняются до ответа сервера, черновик больше не дописывается
  stop() {
    if (!this.chat || !busy.has(this.chat.id)) return;
    const id = this.chat.id, r = runInfo.get(id);
    if (r) { r.phase = 'Останавливается…'; r.stopping = true; }
    this.queue = [];
    this.renderTodos();
    const w = this.el.querySelector('.ag-sendwrap .ag-send');
    if (w) w.disabled = true;
    api('/api/agent/stop', { id }).catch(e => log('error', `стоп: ${e.message}`));
  }

  async addFiles(files) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) { log('warn', `${f.name}: можно прикрепить только картинки`); continue; }
      const name = `chat_${Date.now().toString(36)}_${(f.name || 'image.png').replace(/[^\w.-]+/g, '_')}`;
      try { this.attach.push({ file: await upload(new File([f], name, { type: f.type })) }); }
      catch (e) { log('error', `загрузка ${f.name}: ${e.message} (сервер запущен?)`); }
    }
    this.renderAttach();
  }

  onAgent(d) {
    const mine = d.chat === this.chat?.id;
    if (!mine) { if (['start', 'done'].includes(d.kind)) this.renderChrome(); return; }
    const fresh = () => (this.draft ||= { text: '', thinking: '', tools: [] });
    if (d.kind === 'user') { this.chat.messages.push(d.message); if (d.title) this.chat.title = d.title; this.draft = { text: '', thinking: '', tools: [] }; this.render(true); return; }
    if (d.kind === 'start') { fresh(); this.renderDraft(); this.renderComposer(); this.renderChrome(); return; }
    if (['tool_start', 'tool_run', 'tool_result', 'approve', 'status'].includes(d.kind) && this.dockEl) this.renderTodos();
    if (runInfo.get(d.chat)?.stopping && ['delta', 'thinking', 'tool_start', 'tool_run', 'status'].includes(d.kind)) return;
    if (d.kind === 'delta') { fresh().text += d.text; this.renderDraft(); return; }
    if (d.kind === 'thinking') { fresh().thinking += d.text; this.renderDraft(); return; }
    if (d.kind === 'approve' || d.kind === 'approve_done') { this.renderDraft(); return; }
    if (d.kind === 'tool_run' && this.chat.messages.some(m => m.tools?.some(t => t.id === d.id))) {
      // вызов уже в сообщении — отмечаем «выполняется» там, без копии в черновике
      this.running.add(d.id);
      if (this.draft) this.draft.tools = this.draft.tools.filter(t => t.id !== d.id);
      this.render(); return;
    }
    if (d.kind === 'tool_start' || d.kind === 'tool_run') {
      const dr = fresh(), t = dr.tools.find(x => x.id === d.id);
      if (t) t.running = d.kind === 'tool_run'; else dr.tools.push({ id: d.id, name: d.name, input: d.input, running: d.kind === 'tool_run' });
      if (t && d.input) t.input = d.input;
      this.renderDraft(); return;
    }
    if (d.kind === 'message') {
      this.status = '';
      this.chat.messages.push(d.message);
      for (const r of d.message.results || []) this.running.delete(r.id);
      this.draft = busy.has(this.chat.id) ? { text: '', thinking: '', tools: [] } : null;
      this.render(true); return;
    }
    if (d.kind === 'adult') { this.chat.adult = true; upsertMeta({ id: this.chat.id, adult: true }); this.renderChrome(); return; }
    if (d.kind === 'status') { this.status = d.text; this.renderDraft(); return; }
    if (d.kind === 'todos') { this.chat.todos = d.todos; this.renderTodos(); return; }
    if (d.kind === 'done') {
      this.draft = null; this.status = ''; this.running.clear(); this.render(); this.refreshEnv();
      const q = !d.stopped && this.queue.shift();
      if (q) { this.attach = q.images.map(f => ({ file: f })); this.send(q.text); } else this.renderTodos();
    }
  }

  // ---------- отрисовка ----------
  get char() { return this.chat?.mode === 'character' ? charOf(this.chat.character) : null; }

  // конец хода: дальше (не считая результатов инструментов) — сообщение пользователя или ничего
  turnEnd(i) {
    const ms = this.chat.messages;
    let j = i + 1;
    while (j < ms.length && ms[j].role === 'tool') j++;
    return j >= ms.length ? !busy.has(this.chat.id) : ms[j].role === 'user';
  }
  // текст хода целиком (для «Копировать» у ответа): все реплики ассистента от прошлого сообщения пользователя
  turnText(i) {
    const ms = this.chat.messages, out = [];
    for (let j = i; j >= 0 && ms[j].role !== 'user'; j--) if (ms[j].role === 'assistant' && ms[j].text) out.unshift(ms[j].text);
    return out.join('\n\n');
  }
  // строка действий под сообщением (видна при наведении), как у Claude
  msgActions(m, i, user) {
    const b = (ic, tip, fn) => h('button.b', { 'data-tip': tip, onclick: e => { e.stopPropagation(); fn(e.currentTarget); } }, icon(ic, { size: 16 }));
    const idle = !busy.has(this.chat.id);
    return h(`div.ag-acts${user ? '.r' : ''}`, {},
      h('span.ag-ago', { 'data-tip': m.at ? new Date(m.at * 1000).toLocaleString() : '' }, ago(m.at)),
      h('span.ui-tb', {},
        b('copy', 'Копировать', el => { navigator.clipboard?.writeText(user ? m.text || '' : this.turnText(i)); el.replaceChildren(icon('check', { size: 16 })); }),
        user && idle && !m.label ? b('edit', 'Изменить и отправить заново', () => this.editMsg(i)) : null,
        !user && idle ? b('refresh', 'Повторить ответ', () => this.retry()) : null,
        user && idle ? b('undo', 'Вернуться сюда\nУдаляет это сообщение и всё, что после него', () => this.rewind(i)) : null,
        b('general/vcs', 'Ответвить\nНовый диалог с сообщениями до этого места', () => this.fork(i))));
  }

  messageEl(m, results, i) {
    if (m.role === 'user' && m.label) return h('div.ag-msg.user', {}, h('div.ag-req', {}, icon('image', { size: 16 }), m.label), this.msgActions(m, i, true));
    if (m.role === 'user') {
      return h('div.ag-msg.user', {},
        m.images?.length ? h('div.ag-imgs.r', {}, ...m.images.map((f, k, all) => thumb(f, all, k))) : null,
        m.text ? h('div.ag-bubble', {}, m.text) : null,
        this.msgActions(m, i, true));
    }
    if (m.role === 'error') return h('div.ag-msg.err', {}, icon('error', { size: 14 }), h('span', {}, m.text));
    if (m.role !== 'assistant') return null;
    const c = this.char;
    if (c) {
      // персонаж: без вызовов инструментов — только реплика и присланные фото
      const photos = (m.tools || []).flatMap(t => results.get(t.id)?.images || []);
      const failed = (m.tools || []).filter(t => results.get(t.id) && !results.get(t.id).ok);
      const waiting = (m.tools || []).filter(t => this.running.has(t.id));
      return h('div.ag-msg.bot.char', {},
        h('div.ag-who', {}, avatar(c, 22), h('b', {}, c.name)),
        m.text ? mdEl(m.text) : null,
        photos.length ? h('div.ag-imgs', {}, ...photos.map((f, i, all) => thumb(f, all, i, '.ag-photo'))) : null,
        ...waiting.map(t => h('div.ag-pending', {}, h('span.ag-tdot.run'), t.name === 'send_photo' ? 'Отправляет фото…' : `${toolLabel(t.name)}…`)),
        failed.length ? h('div.ag-note', {}, `фото не получилось: ${String(results.get(failed[0].id).content).split('\n').pop().slice(0, 160)}`) : null,
        m.note ? h('div.ag-note', {}, m.note) : null,
        this.turnEnd(i) ? this.msgActions(m, i, false) : null);
    }
    const end = this.turnEnd(i);
    return h('div.ag-msg.bot', {},
      m.thinking ? this.keepOpen(`th:${i}`, h('details.ag-think', {}, h('summary', {}, icon('right', { size: 16, cls: 'ag-tw' }), 'Размышления'), h('div', {}, m.thinking))) : null,
      m.text ? mdEl(m.text) : null,
      m.tools?.length ? this.toolGroup(m.tools, results, `g:${i}`) : null,
      m.note ? h('div.ag-note', {}, m.note) : null,
      end && m.usage ? h('div.ag-meta', { 'data-tip': 'токены: вход / выход / из кэша' }, `${m.model || ''} · ${m.usage.in}/${m.usage.out}${m.usage.cache_read ? ` · кэш ${m.usage.cache_read}` : ''}`) : null,
      end ? this.msgActions(m, i, false) : null);
  }
  // вызовы одного шага — свёрнутая строка-итог; внутри — каждый вызов с подробностями
  toolGroup(tools, results, key) {
    const running = tools.some(t => this.running.has(t.id) || t.running);
    const imgs = tools.flatMap(t => results.get(t.id)?.images || []);
    const det = this.keepOpen(key, h('details.ag-grp', {},
      h('summary', {}, ...summarize(tools, results, running), icon('right', { size: 16, cls: 'ag-tw' })),
      h('div.ag-grp-b', {}, ...tools.map(t => toolChip(t, results.get(t.id), this.running.has(t.id) || t.running, this)))));
    // картинки результатов видны и в свёрнутом виде
    return h('div.ag-grpw', {}, det, imgs.length ? h('div.ag-imgs', {}, ...imgs.map((f, k, all) => thumb(f, all, k))) : null);
  }

  // ---------- как у Claude: откат, правка, повтор, ветка ----------
  async rewind(i) {
    if (!(await confirmBox('Вернуться к этому месту? Сообщение и всё, что после него, будет удалено из диалога.', { title: 'Вернуться сюда', ok: 'Вернуться' }))) return;
    try { this.chat = await api('/api/agent/rewind', { id: this.chat.id, index: i }); } catch (e) { return log('error', e.message); }
    upsertMeta(this.chat);
    this.render(true); this.refreshEnv();
  }
  editMsg(i) {
    const m = this.chat.messages[i];
    this.editing = i;
    this.ta.value = m.text || '';
    this.attach = (m.images || []).map(f => ({ file: f }));
    this.renderAttach(); this.autosize(); this.renderTodos();
    this.ta.focus();
  }
  async retry() {
    try { this.chat = await api('/api/agent/retry', { id: this.chat.id, workflows: this.visible() }); } catch (e) { return log('error', e.message); }
    busy.add(this.chat.id);
    this.draft ||= { text: '', thinking: '', tools: [] };
    this.render(true);
  }
  async fork(i) {
    let c;
    try { c = await api('/api/agent/fork', { id: this.chat.id, index: i }); } catch (e) { return log('error', e.message); }
    upsertMeta(c);
    await this.open(c.id);
    for (const v of views) if (v !== this) v.renderChrome();
  }

  // над полем ввода: список задач агента (todo_write), очередь сообщений, правка сообщения
  renderTodos() {
    const el = this.dockEl;
    if (!el) return;
    const todos = this.chat?.todos || [], open = todos.filter(t => t.status !== 'completed').length;
    const showTodos = todos.length && (open || busy.has(this.chat?.id));
    const done = todos.length - open;
    const run = runInfo.get(this.chat?.id);
    if (busy.has(this.chat?.id) && !run) runInfo.set(this.chat.id, { t0: (this.chat.since || Date.now() / 1000) * 1000, tok: 0, chars: 0, phase: 'Работает' });
    const r = runInfo.get(this.chat?.id);
    fill(el,
      r && busy.has(this.chat.id) ? h('div.ag-run', { 'data-chat': this.chat.id }, h('span.ag-spin'), h('span.t', {}, runText(r))) : null,
      showTodos ? h('div.ag-todos', {},
        h('div.ag-todoh', { onclick: () => { ui.todosOff = !ui.todosOff; saveUi(); this.renderTodos(); } },
          h(`span.agb-tw${ui.todosOff ? '.off' : ''}`, {}, icon('down', { size: 16 })), h('b', {}, 'Задачи'), h('span.dim', {}, `${done} из ${todos.length}`),
          ui.todosOff ? h('span.ag-todocur', {}, (todos.find(t => t.status === 'in_progress') || {}).content || '') : null),
        ui.todosOff ? null : h('div.ag-todol', {}, ...todos.map(t => h(`div.ag-todo.${t.status}`, {},
          t.status === 'completed' ? icon('check', { size: 14 }) : t.status === 'in_progress' ? h('span.ag-tdot.run') : h('span.ag-todoc'),
          h('span', {}, t.content))))) : null,
      this.editing != null ? h('div.ag-qrow', {}, icon('edit', { size: 14 }), h('span.t', {}, 'Правка сообщения — при отправке диалог вернётся к нему'),
        h('span.ui-tb', {}, tbBtn('closeSmall', 'Отменить правку', () => { this.editing = null; this.ta.value = ''; this.attach = []; this.renderAttach(); this.renderTodos(); }))) : null,
      ...this.queue.map((q, k) => h('div.ag-qrow', {}, icon('history', { size: 14 }), h('span.t', {}, `В очереди: ${q.text || 'картинка'}`),
        h('span.ui-tb', {}, tbBtn('closeSmall', 'Убрать из очереди', () => { this.queue.splice(k, 1); this.renderTodos(); })))));
  }

  approveCard(a) {
    const i = a.input || {};
    const files = a.name === 'edit_file' || a.name === 'write_file';
    const detail = files ? null : a.name === 'run_js' ? i.code : a.name === 'run_command' ? `$ ${i.command}` : JSON.stringify(i, null, 1);
    const answer = (ok, always = false) => api('/api/agent/approve', { req: a.req, ok, always }).catch(e => log('error', e.message));
    const st = files ? editStat({ name: a.name, input: i }, null) : null;
    return h('div.ag-approve', {},
      h('div.ag-aph', {}, icon('warning', { size: 16 }), h('b', {}, a.summary || a.name), ...(st ? plusMinus(st) : [])),
      files ? toolBody({ name: a.name, input: i }, null)[0] : null,
      detail ? h('pre.ag-json', {}, detail) : null,
      h('div.ag-apb', {},
        h('button.ui-btn.primary.slim', { onclick: () => answer(true) }, 'Разрешить'),
        h('button.ui-btn.secondary.slim', { onclick: () => answer(true, true), 'data-tip': 'Больше не спрашивать в этом диалоге' }, 'Разрешать всегда'),
        h('span.grow'),
        h('button.ui-btn.secondary.slim', { onclick: () => answer(false) }, 'Отклонить')));
  }

  renderDraft(stick = this.nearBottom()) {
    if (!this.draftEl) return;
    const ap = approvals.get(this.chat?.id) || [];
    const d = this.draft;
    this.renderTodos();
    if ((!d || !this.chat || !busy.has(this.chat.id)) && !ap.length) { this.draftEl.replaceChildren(); return; }
    const c = this.char;
    const tools = c ? (d?.tools || []).map(t => h('div.ag-pending', {}, h('span.ag-tdot.run'), t.name === 'send_photo' ? 'Отправляет фото…' : `${toolLabel(t.name)}…`))
      : d?.tools?.length ? [this.toolGroup(d.tools, new Map(), 'draft')] : [];
    this.draftEl.replaceChildren(h(`div.ag-msg.bot${c ? '.char' : ''}`, {},
      c ? h('div.ag-who', {}, avatar(c, 22), h('b', {}, c.name)) : null,
      d?.thinking && !c ? h('details.ag-think', { open: !d.text }, h('summary', {}, icon('right', { size: 16, cls: 'ag-tw' }), 'Размышляет…'), h('div.ag-thinkb', {}, d.thinking)) : null,
      d?.text ? mdEl(d.text.replace(ADULT_MARK, '')) : null,
      ...tools,
      this.status ? h('div.ag-pending', {}, h('span.ag-tdot.run'), this.status) : null,
      ...ap.map(a => this.approveCard(a)),
      d && !d.text && !d.tools.length && !ap.length && (!d.thinking || c) ? h('div.ag-typing', {}, h('i'), h('i'), h('i')) : null));
    if (stick) this.scrollDown();
  }
  // прокрутка: «прилип к низу» и позиция запоминаются по событиям scroll самого списка — так подряд идущие
  // перерисовки за один кадр не читают позицию у нового, ещё не прокрученного списка (раньше бросало в начало)
  nearBottom() { return this.pinned ?? true; }
  scrollDown() { if (this.listEl) { this.listEl.scrollTop = this.listEl.scrollHeight; this.pinned = true; } }
  trackScroll(el) {
    el.addEventListener('scroll', () => {
      if (el !== this.listEl || this.restoring) return;
      this.pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      this.top = el.scrollTop;
    }, { passive: true });
    // картинки грузятся позже и удлиняют ленту — держим низ, если он был виден
    el.addEventListener('load', () => { if (this.pinned && el === this.listEl) el.scrollTop = el.scrollHeight; }, true);
  }
  restoreScroll(stick) {
    const el = this.listEl;
    this.restoring = true;
    if (stick) el.scrollTop = el.scrollHeight; else el.scrollTop = this.top || 0;
    this.restoring = false;
    this.pinned = stick;
  }
  // раскрытые блоки (инструменты, размышления, группы) переживают перерисовку
  keepOpen(key, el) {
    if (this.opened.has(key)) el.open = true;
    el.addEventListener('toggle', () => { if (el.open) this.opened.add(key); else this.opened.delete(key); });
    return el;
  }

  render(scroll = false) {
    if (!this.el) return;
    if (!S.server.running) { this.el.replaceChildren(h('div.msg', {}, 'Сервер не запущен — агент работает через него')); return; }
    const stick = scroll || this.nearBottom();
    const typed = this.ta?.value, focused = document.activeElement === this.ta;
    this.listEl = h(`div.ag-list${this.big ? '.big' : ''}`);
    this.trackScroll(this.listEl);
    this.draftEl = h('div');
    const results = new Map();
    for (const m of this.chat?.messages || []) if (m.role === 'tool') for (const r of m.results) results.set(r.id, r);
    const msgs = (this.chat?.messages || []).map((m, i) => this.messageEl(m, results, i)).filter(Boolean);
    if (!this.chat?.messages?.some(m => m.role === 'user')) this.listEl.append(this.empty());
    this.listEl.append(...msgs, this.draftEl);
    this.dockEl = h('div.ag-dock');
    const main = [this.topBar(), this.listEl, this.dockEl, this.composer()];
    if (this.big) {
      // каркас строится один раз: иначе каждая перерисовка пересоздавала бы правую панель и перезагружала браузер в ней
      if (this.agbEl?.parentNode !== this.el) {
        this.envEl = h('div.agb-env');
        this.mainEl = h('div.agb-main');
        this.agbEl = h('div.agb', {}, h('div.agb-side'), this.mainEl, this.envEl);
        this.el.replaceChildren(this.agbEl);
      }
      this.agbEl.classList.toggle('noenv', !!ui.envOff);
      this.agbEl.querySelector('.agb-side').replaceWith(this.sidebar());
      this.mainEl.replaceChildren(...main);
      this.renderEnv();
    } else this.el.replaceChildren(...main);
    if (typed) { this.ta.value = typed; this.autosize(); }
    if (focused) this.ta.focus();
    this.renderDraft(stick);
    this.restoreScroll(stick);
    const el = this.listEl;
    requestAnimationFrame(() => { if (el === this.listEl && stick && this.pinned) el.scrollTop = el.scrollHeight; });
  }

  // шапка и список слева — без перерисовки разговора
  renderChrome() {
    if (!this.el?.isConnected || !S.server.running) return;
    this.el.querySelector('.ag-top')?.replaceWith(this.topBar());
    this.el.querySelector('.agb-side')?.replaceWith(this.sidebar());
    this.renderEnv();
  }

  empty() {
    const c = this.char;
    if (c) {
      return h('div.ag-empty', {}, avatar(c, 72), h('div.t-h2', {}, c.name),
        h('div.t-p', {}, c.scenario || c.persona?.slice(0, 200) || 'Напишите первое сообщение.'));
    }
    const code = this.chat?.mode === 'code', cwd = this.chat?.cwd;
    const app = code && projects.find(p => p.app)?.path === cwd;
    const ex = !code
      ? ['Нарисуй уютную кофейню на закате, 2 варианта', 'Открой прикреплённое фото в ImageNaizer и замени фон на пляж', 'Найди в интернете лучшие параметры для Illustrious', 'Собери воркфлоу txt2img с hires fix', 'Переведи этот воркфлоу ComfyUI в ноды maistep']
      : app ? ['Проверь, что все вкладки открываются без ошибок в консоли', 'Добавь в ImageNaizer кнопку «Отразить слой по горизонтали»', 'Найди, где задаются цвета холста графа, и объясни']
        : ['Объясни структуру этого проекта', 'Найди и исправь ошибки, которые выдают тесты', 'Добавь README с инструкцией по запуску', 'Что изменено в рабочей копии и стоит ли это коммитить?'];
    return h('div.ag-empty', {}, icon(code ? 'code' : 'ai', { size: 32 }), h('div.t-h2', {}, code ? `Code${cwd ? ` · ${base(cwd)}` : ''}` : 'Agent'),
      h('div.t-p', {}, code
        ? cwd ? 'Читает и правит файлы проекта, запускает команды и тесты, видит git. Запись и команды — с вашего разрешения.'
          : 'Выберите папку проекта — кнопка с папкой под полем ввода.'
        : 'Собирает и чинит воркфлоу, генерирует и правит картинки (пришлите фото), работает в ImageNaizer, ищет в интернете и управляет окном.'),
      code && !cwd ? h('button.ui-btn.primary', { onclick: e => this.folderPopup(e.currentTarget) }, icon('folder', { size: 16 }), 'Выбрать папку') : null,
      h('div.ag-ex', {}, ...(code && !cwd ? [] : ex).map(t => h('button.ui-btn.secondary.slim', { onclick: () => { this.ta.value = t; this.autosize(); this.ta.focus(); } },
        icon('bulb', { size: 16 }), h('span', {}, t)))));
  }

  // шапка: в панели — диалоги, новый, развернуть, настройки, привязка и доступ; во вкладке — название и режим
  topBar() {
    const c = this.chat, ch = this.char;
    const hiddenN = c?.hidden?.length || 0;
    const access = c?.mode === 'agent' ? h('div.ui-tb', {}, h(`button.b${hiddenN ? '.txt.warn' : ''}`, { onclick: e => this.accessPopup(e.currentTarget),
      'data-tip': hiddenN ? `Агенту не видно воркфлоу: ${hiddenN}` : 'Агент видит все воркфлоу — изменить доступ' },
    icon(hiddenN ? 'hide' : 'show', { size: 16 }), hiddenN ? `скрыто ${hiddenN}` : null)) : null;
    const wf = c?.mode === 'agent' ? this.wfDropdown(c) : null;
    if (!this.big) {
      return h('div.ag-top', {},
        ddLink('.ag-title', 'Диалоги', a => this.chatsPopup(a),
          busy.has(c?.id) ? h('span.ag-tdot.run') : ch ? avatar(ch, 16) : null, h('span.t', {}, c?.title || (c ? 'Новый диалог' : 'Нет диалога'))),
        h('div.ui-tb', {},
          h('button.b', { onclick: () => this.newChat(), 'data-tip': 'Новый диалог' }, icon('add', { size: 16 })),
          h('button.b', { onclick: e => this.settingsPopup(e.currentTarget), 'data-tip': 'Режим, 18+ и разрешения' }, icon('settings', { size: 16 })),
          h('button.b', { onclick: () => bigOpen(c?.id), 'data-tip': 'Открыть во вкладке AI Chat' }, icon('externalLink', { size: 16 }))),
        h('span.grow'), wf, access);
    }
    return h('div.ag-top.big', {},
      ch ? h('button.agb-char', { onclick: () => characterDialog(ch), 'data-tip': 'Изменить персонажа' }, avatar(ch, 22), h('b', {}, ch.name), icon('edit', { size: 16 }))
        : h('span.agb-ttl', { ondblclick: () => c && this.rename(c), 'data-tip': c ? 'Двойной щелчок — переименовать' : '' },
          busy.has(c?.id) ? h('span.ag-tdot.run') : null, c?.title || 'Новый диалог', c?.adult ? adultTag() : null),
      c?.mode === 'code' && c.cwd ? h('span.agb-path', { 'data-tip': c.cwd }, icon('folder', { size: 16 }), base(c.cwd)) : null,
      h('span.grow'),
      ui.envOff ? wf : null, ui.envOff ? access : null,
      h('div.ui-tb', {}, h(`button.b${ui.envOff ? '' : '.on'}`, { onclick: () => { ui.envOff = !ui.envOff; saveUi(); this.agbEl?.classList.toggle('noenv', ui.envOff); this.renderChrome(); },
        'data-tip': ui.envOff ? 'Показать панель среды' : 'Скрыть панель среды' }, icon('general/openInToolWindow', { size: 16 }))));
  }

  // переключатель среды (в настройках панели): Agent ↔ Code; RP — отдельные диалоги с персонажами
  modeSeg() {
    const m = this.chat.mode || 'agent';
    return h('div.ui-seg.ag-mode', {}, ...['agent', 'code'].map(k => h(`button${m === k ? '.on' : ''}`, {
      onclick: () => m !== k && this.setMode(k), 'data-tip': MODES[k][2],
    }, icon(MODES[k][1], { size: 16 }), MODES[k][0])));
  }
  async setMode(k, anchor) {
    if (k === 'character') return this.charsPopup(anchor || this.el.querySelector('.ag-modedd'));
    if (!this.chat) return this.newChat({ mode: k });
    await this.patch({ mode: k });
    if (k === 'code' && !this.chat.cwd) this.folderPopup(this.el.querySelector('.ag-fold') || anchor);
  }
  // выбор среды под полем ввода
  modeDropdown() {
    const m = this.chat?.mode || 'agent';
    return tipped(ddLink('.ag-modedd', '', a => {
      const item = k => h(`div.item${m === k ? '.acc' : ''}`, { onclick: () => { closePop(); if (k !== m) this.setMode(k, a); }, 'data-tip': MODES[k][2] },
        h('span.ic', {}, icon(MODES[k][1], { size: 16 })), h('span', {}, MODES[k][0]), h('span.sc', {}, m === k ? '✓' : ''));
      const box = h('div.ui-menu.ag-pop', {}, h('div.ag-poph', {}, h('b', {}, 'Среда')), item('agent'), item('code'), item('character'),
        h('div.ag-hint', {}, 'Agent — только программа; Code — папка проекта на ПК; RP — персонажи.'));
      place(box, a, true);
    }, icon(MODES[m][1], { size: 16 }), h('span.t', {}, MODES[m][0])), MODES[m][2]);
  }
  // папка проекта (Code) — как у Claude: недавние, «Открыть папку…», ветка
  folderChip() {
    const c = this.chat;
    if (c?.mode !== 'code') return null;
    return tipped(ddLink('.ag-fold', '', a => this.folderPopup(a), icon('folder', { size: 16 }), h(`span.t${c.cwd ? '' : '.ph'}`, {}, c.cwd ? base(c.cwd) : 'папка')),
      c.cwd ? `Папка проекта: ${c.cwd}` : 'Выберите папку проекта');
  }
  folderPopup(anchor) {
    const c = this.chat;
    if (!c) return;
    let q = '';
    const list = h('div');
    const pick = async path => { closePop(); if (path !== c.cwd) await this.patch({ cwd: path }); };
    const draw = () => {
      const rec = projects.filter(p => p.exists && (!q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)));
      fill(list,
        h('div.item', { onclick: () => pick(null) }, h('span.ic', {}), h('span', {}, 'Без папки'), h('span.sc', {}, c.cwd ? '' : '✓')),
        h('div.sep'), h('div.ag-cap', {}, 'Недавние'),
        ...rec.map(p => h('div.item', { onclick: () => pick(p.path), 'data-tip': p.path },
          h('span.ic', {}, icon(p.app ? 'ai' : 'folder', { size: 16 })), h('span', {}, p.name), h('span.sc', {}, p.path === c.cwd ? '✓' : ''))),
        !rec.length ? h('div.ag-hint', {}, 'ничего не найдено') : null);
    };
    const sr = h('input.ag-fsr', { type: 'text', placeholder: 'Поиск папок…', spellcheck: false });
    sr.addEventListener('input', () => { q = sr.value.toLowerCase(); draw(); });
    sr.addEventListener('keydown', e => e.stopPropagation());
    const g = this.env?.git;
    const box = h('div.ui-menu.ag-pop.ag-fpop', {}, sr, list, h('div.sep'),
      h('div.item', { onclick: async () => { closePop(); const p = await pickFolder({ title: 'Папка проекта', value: c.cwd || '' }); if (p) pick(p); } },
        h('span.ic', {}, icon('open', { size: 16 })), h('span', {}, 'Открыть папку…')),
      g ? h('div.item', { onclick: e => { e.stopPropagation(); this.branchPopup(anchor); } },
        h('span.ic', {}, icon('general/vcs', { size: 16 })), h('span', {}, 'Ветка'), h('span.sc', {}, g.branch), h('span.arrow', {}, icon('right', { size: 16 }))) : null);
    box.addEventListener('pointerdown', e => e.stopPropagation());
    draw();
    place(box, anchor, true);
    sr.focus();
  }
  branchPopup(anchor) {
    const g = this.env?.git, cwd = this.chat?.cwd;
    if (!g) return;
    const box = h('div.ui-menu.ag-pop', {}, h('div.ag-poph', {}, h('b', {}, 'Ветка'), h('span.dim', {}, base(cwd))),
      ...g.branches.map(b => h('div.item', { onclick: async () => {
        closePop();
        if (b === g.branch) return;
        if (g.files.length && !(await confirmBox(`В рабочей копии есть изменения (${g.files.length} файлов). Переключиться на «${b}»? git сам откажет, если изменения мешают.`, { ok: 'Переключить' }))) return;
        try { this.env.git = await api('/api/agent/git_switch', { cwd, branch: b }); log('ok', `ветка: ${b}`); } catch (e) { log('error', `git switch: ${e.message}`); }
        this.renderEnv(); this.renderChrome();
      } }, h('span.ic', {}, icon('general/vcs', { size: 16 })), h('span', {}, b), h('span.sc', {}, b === g.branch ? '✓' : ''))));
    place(box, anchor, true);
  }
  permDropdown(withIcon = true) {
    return tipped(dropdown(this.chat.perm || 'ask', [['ask', 'Спрашивать'], ['auto', 'Без вопросов']], v => this.patch({ perm: v }), { link: true, icon: withIcon ? 'general/locked' : null }),
      'Запись файлов, команды, JS и вызовы MCP: спрашивать разрешение или выполнять сразу');
  }

  wfDropdown(c) {
    const opts = [['', 'без воркфлоу'], ...[...S.docs.workflow].map(([id, d]) => [id, `${d.data.title || id}${c.hidden?.includes(id) ? ' (скрыт)' : ''}`])];
    if (c.wf && !doc('workflow', c.wf)) opts.push([c.wf, c.wf]);
    const el = dropdown(c.wf || '', opts, v => this.patch({ wf: v || null }), { link: true, icon: 'blueprint' });
    el.classList.add('ag-wf');
    return tipped(el, 'Воркфлоу, к которому привязан диалог: его граф агент видит сразу');
  }

  // левая колонка вкладки (как у Claude): Новый чат, Поиск, Персонажи, Настройки; ниже — диалоги по проектам:
  // «maistep · Agent», папки Code (по cwd), «RP · персонажи». Группы сворачиваются (▾), «+» — новый диалог в этой среде.
  sidebar() {
    const q = this.query.toLowerCase();
    const match = c => !q || (c.title || '').toLowerCase().includes(q) || (c.last || '').toLowerCase().includes(q);
    const groups = new Map();
    const add = (key, g, c) => { if (!groups.has(key)) groups.set(key, { ...g, list: [], at: 0 }); const x = groups.get(key); if (c) { x.list.push(c); x.at = Math.max(x.at, c.updated || 0); } };
    for (const c of chats.filter(match)) {
      if (c.mode === 'character') continue;
      if (c.mode === 'code') add(`code:${c.cwd || ''}`, { title: c.cwd ? base(c.cwd) : 'Code · без папки', tip: c.cwd || '', ic: c.cwd ? 'folder' : 'code', mode: 'code', cwd: c.cwd || null }, c);
      else add('agent', { title: 'maistep · Agent', tip: MODES.agent[2], ic: 'ai', mode: 'agent' }, c);
    }
    if (this.chat?.mode === 'code' && this.chat.cwd) add(`code:${this.chat.cwd}`, { title: base(this.chat.cwd), tip: this.chat.cwd, ic: 'folder', mode: 'code', cwd: this.chat.cwd });
    const rp = chats.filter(c => c.mode === 'character' && match(c));
    if (chars.length || rp.length) add('rp', { title: 'RP · персонажи', tip: MODES.character[2], ic: 'profile', mode: 'character' });
    for (const c of rp) { const g = groups.get('rp'); g.at = Math.max(g.at, c.updated || 0); }
    const row = (c, cls = '') => {
      const ch = c.mode === 'character' ? charOf(c.character) : null;
      return h(`div.agb-row${cls}${c.id === this.chat?.id ? '.on' : ''}`, { onclick: () => this.open(c.id), oncontextmenu: e => { e.preventDefault(); this.rowMenu(e, c); }, 'data-tip': c.last || '' },
        busy.has(c.id) ? h('span.ag-tdot.run') : ch && !cls ? avatar(ch, 18) : null,
        h('span.t', {}, c.title || 'Новый диалог'), c.adult && !cls ? adultTag() : null,
        h('span.ui-tb.ag-x', {}, tbBtn('edit', 'Переименовать', () => this.rename(c)), tbBtn('delete', 'Удалить', () => this.remove(c.id))));
    };
    const rpBody = () => chars.filter(ch => !q || ch.name.toLowerCase().includes(q) || rp.some(c => c.character === ch.id)).map(ch => {
      const mine = rp.filter(c => c.character === ch.id);
      const cur = this.char?.id === ch.id;
      return [h(`div.agb-crow${cur && mine.length < 2 ? '.on' : ''}`, { onclick: () => this.openCharacter(ch), 'data-tip': ch.scenario || ch.persona?.slice(0, 160) || '' },
        avatar(ch, 22), h('span.t', {}, ch.name), mine.some(x => x.adult) ? adultTag() : null, mine.length > 1 ? h('span.agb-n', {}, mine.length) : null,
        h('span.ui-tb.ag-x', {}, tbBtn('add', 'Новый разговор', () => this.newChat({ character: ch.id })), tbBtn('edit', 'Изменить', () => characterDialog(ch)))),
      ...(cur && mine.length > 1 ? mine.map(c => row(c, '.sub')) : [])];
    }).flat();
    const groupEl = (key, g) => {
      const closed = !!ui.closed[key] && !q;
      const plus = g.mode === 'character' ? tbBtn('add', 'Новый персонаж', () => characterDialog())
        : tbBtn('add', g.mode === 'code' ? `Новый диалог в ${g.title}` : 'Новый диалог Agent', () => this.newChat({ mode: g.mode, ...(g.mode === 'code' ? { cwd: g.cwd } : {}) }));
      return h('div.agb-grp', {},
        h('div.agb-gh', { onclick: () => { ui.closed[key] = !ui.closed[key]; saveUi(); this.renderChrome(); }, 'data-tip': g.tip },
          h('span.t', {}, g.title), h(`span.agb-tw${closed ? '.off' : ''}`, {}, icon('down', { size: 16 })), h('span.grow'), h('span.ui-tb.ag-x', {}, plus)),
        closed ? null : h('div.agb-gb', {}, ...(key === 'rp' ? rpBody() : g.list.map(c => row(c))),
          key === 'rp' && !chars.length ? h('div.agb-hint', {}, 'Создайте персонажа: характер, внешность, приветствие — он может присылать свои фото.') : null));
    };
    const navItem = (ic, label, fn, on = false, kbdText = '') => h(`div.agb-nav${on ? '.on' : ''}`, { onclick: fn }, icon(ic, { size: 16 }), h('span', {}, label), kbdText ? h('span.agb-kbd', {}, kbdText) : null);
    const searchEl = this.searchOn || q ? search({ placeholder: 'Поиск по диалогам', value: this.query, onInput: v => {
      this.query = v; const s = this.el.querySelector('.agb-groups'); s?.replaceWith(this.sidebar().querySelector('.agb-groups'));
    } }) : null;
    const sorted = [...groups].sort((a, b) => b[1].at - a[1].at);
    return h('div.agb-side', {},
      navItem('add', 'Новый чат', () => this.newChat()),
      navItem('search', 'Поиск', () => { this.searchOn = !this.searchOn; if (!this.searchOn) this.query = ''; this.renderChrome(); this.el.querySelector('.agb-side .ui-search input')?.focus(); }, this.searchOn),
      navItem('profile', 'Персонажи', e => this.charsPopup(e.currentTarget)),
      navItem('settings', 'Настройки', () => openSettings('providers')),
      searchEl,
      h('div.agb-groups', {}, ...sorted.map(([k, g]) => groupEl(k, g)),
        !chats.length && !chars.length ? h('div.agb-hint', {}, 'Диалогов пока нет') : null,
        q && !sorted.some(([, g]) => g.list.length) && !rp.length ? h('div.agb-hint', {}, 'ничего не найдено') : null));
  }
  rowMenu(e, c) {
    const box = h('div.ui-menu.ag-pop', {},
      h('div.item', { onclick: () => { closePop(); this.rename(c); } }, h('span.ic', {}, icon('edit', { size: 16 })), h('span', {}, 'Переименовать')),
      h('div.item', { onclick: () => { closePop(); this.remove(c.id); } }, h('span.ic', {}, icon('delete', { size: 16 })), h('span', {}, 'Удалить')));
    place(box, { getBoundingClientRect: () => ({ left: e.clientX, bottom: e.clientY, top: e.clientY }) });
  }
  async openCharacter(c) {
    const last = chats.find(x => x.mode === 'character' && x.character === c.id);
    if (last) await this.open(last.id); else await this.newChat({ character: c.id });
  }

  // подвал поля ввода: провайдер, модель, усилие
  modelBar(c) {
    const provOpts = Object.entries(provs?.providers || {}).map(([pid, p]) => [pid, `${p.name || pid}${p.has_key ? '' : ' (нет ключа)'}`]);
    if (!provOpts.some(([pid]) => pid === c.provider)) provOpts.push([c.provider, c.provider]);
    return [
      c.mode === 'character' ? null : this.modeDropdown(), this.folderChip(),
      tipped(dropdown(c.provider, provOpts, v => this.patch({ provider: v }), { link: true }), 'Провайдер'),
      ddLink('', 'Модель', a => modelPicker(a, { provider: c.provider, value: c.model, onPick: id => this.patch({ model: id }) }), h(`span.t${c.model ? '' : '.ph'}`, {}, c.model || 'модель')),
      tipped(dropdown(c.effort || 'medium', ['low', 'medium', 'high', 'xhigh', 'max'], v => this.patch({ effort: v }), { link: true }), 'Усилие (effort, только Claude): больше — умнее и дороже'),
    ];
  }

  composer() {
    this.attachEl = h('div.ag-attach');
    const ch = this.char;
    const ta = this.ta = h('textarea', { rows: 1, spellcheck: true,
      placeholder: ch ? `Сообщение для ${ch.name}…` : this.big ? 'Спросите что угодно или пришлите фото… (Enter — отправить, Shift+Enter — новая строка)' : 'Сообщение агенту… (Enter — отправить)' });
    ta.addEventListener('input', () => { this.autosize(); this.renderComposer(); });
    ta.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.send(); }
      if (e.key === 'Escape' && this.chat && busy.has(this.chat.id)) this.stop();
    });
    ta.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
      if (files.length) { e.preventDefault(); this.addFiles(files); }
    });
    const file = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
    file.onchange = () => { this.addFiles([...file.files]); file.value = ''; };
    const el = h(`div.ag-comp${this.big ? '.big' : ''}`, {}, this.attachEl, ta,
      h('div.ag-row', {},
        h('div.ui-tb', {},
          h('button.b', { onclick: () => file.click(), 'data-tip': 'Прикрепить картинки с диска (Ctrl+V, перетаскивание)' }, icon('attached', { size: 16 })),
          h('button.b', { onclick: e => imagePicker(e.currentTarget, { onPick: f => { this.attach.push({ file: f }); this.renderAttach(); } }), 'data-tip': 'Картинка из input/ или output/' }, icon('image', { size: 16 }))),
        file,
        ch ? h('div.ui-tb', {}, h('button.b.txt.ag-photo-btn', { onclick: e => this.photoMenu(e.currentTarget), 'data-tip': `Попросить фото у ${ch.name} — без сообщения в чат` },
          icon('image', { size: 16 }), 'Фото', icon('down', { size: 16 }))) : null,
        ...(this.chat ? this.modelBar(this.chat) : []),
        h('span.grow'),
        h('span.ag-sendwrap')));
    this.renderAttach();
    this.renderComposer(el);
    return el;
  }
  // фото персонажа кнопкой: подпись в чате, инструкция — модели
  photoMenu(anchor) {
    const ask = (label, text) => { closePop(); if (!busy.has(this.chat.id)) this.send(`(OOC: ${text} Вызови send_photo, затем коротко отреагируй в роли.)`, label); };
    const item = (ic, label, text, tip = '', off = false) => h(`div.item${off ? '.dis' : ''}`, { 'data-tip': tip, onclick: () => !off && ask(label, text) },
      h('span.ic', {}, icon(ic, { size: 16 })), h('span', {}, label));
    const box = h('div.ui-menu.ag-pop', {},
      h('div.ag-poph', {}, h('b', {}, 'Фото')),
      item('image', 'Фото сцены', 'пришли фото того, что происходит сейчас — кадр по текущему моменту разговора (место, поза, одежда, настроение).'),
      item('profile', 'Селфи', 'пришли селфи прямо сейчас (framing portrait), по текущему моменту.'),
      item('show', 'В полный рост', 'пришли фото себя в полный рост (framing full), по текущему моменту.'),
      item('locked', 'Личное', 'пришли личное откровенное фото только для меня — образ и позу выбери сама по характеру и моменту.'),
      h('div.sep'),
      h('div.item', { onclick: async () => { closePop(); const r = await prompt('Своё фото', [{ key: 't', label: 'Что на фото', value: '' }], 'Попросить'); if (r?.t?.trim()) ask(`Фото: ${r.t.trim().slice(0, 50)}`, `пришли фото: ${r.t.trim()}.`); } },
        h('span.ic', {}, icon('edit', { size: 16 })), h('span', {}, 'Своё описание…')));
    place(box, anchor, true);
  }
  renderComposer(el = this.el?.querySelector('.ag-comp')) {
    const w = el?.querySelector('.ag-sendwrap');
    if (!w) return;
    // во время ответа: пустое поле — «Стоп», есть текст — отправка в очередь (как у Claude)
    const run = this.chat && busy.has(this.chat.id), typed = !!(this.ta?.value.trim() || this.attach.length);
    const mode = run && !typed ? 'stop' : run ? 'queue' : 'send';
    if (w.dataset.mode === mode) return;
    w.dataset.mode = mode;
    w.replaceChildren(mode === 'stop'
      ? h('button.ui-btn.secondary.slim.ag-send.stop', { onclick: () => this.stop(), 'data-tip': 'Остановить (Esc)' }, icon('stop', { size: 16 }))
      : h('button.ui-btn.primary.slim.ag-send', { onclick: () => this.send(), 'data-tip': mode === 'queue' ? 'В очередь — уйдёт после ответа (Enter)' : 'Отправить (Enter)' }, icon(mode === 'queue' ? 'history' : 'send', { size: 16 })));
  }
  renderAttach() {
    if (!this.attachEl) return;
    this.renderComposer();
    this.attachEl.replaceChildren(...this.attach.map((a, i) => h('div.ag-att', {}, h('img', { src: fileUrl(a.file) }),
      h('button', { onclick: () => { this.attach.splice(i, 1); this.renderAttach(); }, 'data-tip': 'Убрать' }, icon('closeSmall', { size: 16 })))));
  }
  autosize() { if (!this.ta) return; this.ta.style.height = 'auto'; this.ta.style.height = `${Math.min(this.big ? 320 : 220, this.ta.scrollHeight)}px`; }

  // ---------- правая панель вкладки: среда диалога (как у Claude) ----------
  async refreshEnv() {
    const c = this.chat;
    if (!c || !S.server.running) return;
    const id = c.id;
    const [ctx, git] = await Promise.all([
      api(`/api/agent/context?id=${id}`).catch(() => null),
      c.mode === 'code' && c.cwd ? api(`/api/agent/git?cwd=${encodeURIComponent(c.cwd)}`).catch(() => null) : null]);
    if (this.chat?.id !== id) return;
    this.env = { ctx, git };
    this.renderEnv();
  }
  // правая панель: вкладки «Среда» (карточки) и «Браузер» (страница, которую открыл агент или вы)
  renderEnv() {
    if (!this.big || !this.envEl?.isConnected) return;
    const c = this.chat, tab = ui.envTab === 'browser' ? 'browser' : 'env';
    if (!this.envCards || this.envCards.parentNode !== this.envEl) {
      this.envTabs = h('div.agb-tabs');
      this.envCards = h('div.agb-cards');
      this.brEl ||= this.browserPane();
      this.envEl.replaceChildren(this.envTabs, this.envCards, this.brEl);
    }
    const run = [...procs.values()].filter(p => p.running).length;
    fill(this.envTabs, h('div.ui-seg', {},
      h(`button${tab === 'env' ? '.on' : ''}`, { onclick: () => { ui.envTab = 'env'; saveUi(); this.renderEnv(); } }, icon('nodes/desktop', { size: 16 }), 'Среда'),
      h(`button${tab === 'browser' ? '.on' : ''}`, { onclick: () => { ui.envTab = 'browser'; saveUi(); this.renderEnv(); } }, icon('toolwindow/web', { size: 16 }), 'Браузер')),
    run ? h('span.agb-runs', { 'data-tip': 'Фоновые процессы агента' }, h('i.st-dot.ok'), `${run}`) : null);
    this.envEl.classList.toggle('wide', tab === 'browser');
    this.envCards.style.display = tab === 'env' ? '' : 'none';
    this.brEl.style.display = tab === 'browser' ? '' : 'none';
    if (tab !== 'env') return;
    if (!c) { fill(this.envCards, h('div.agb-hint', {}, 'Нет диалога')); return; }
    const rp = c.mode === 'character';
    fill(this.envCards, this.cardEnv(c), this.cardContext(), rp ? null : this.cardServers(c), rp ? null : this.cardAccess(c),
      rp ? null : this.cardConnectors(c), c.mode === 'code' && this.env?.git ? this.cardChanges() : null);
  }
  // «Серверы»: фоновые процессы агента этого диалога (dev-серверы, сборки) — порт открывается в браузере панели
  cardServers(c) {
    const list = [...procs.values()].filter(p => p.chat === c.id).sort((a, b) => b.running - a.running || b.started - a.started);
    if (!list.length) return null;
    return this.card('procs', 'Серверы', [...list.map(p => h('div.agb-er', { 'data-tip': `${p.command}\n${p.cwd}` },
      h(`span.st-dot${p.running ? '.ok' : ''}`), h('span.t', {}, p.command),
      p.port ? h('button.ui-btn.secondary.slim.agb-port', { onclick: () => this.showBrowser(`http://localhost:${p.port}`), 'data-tip': 'Открыть в браузере панели' }, `localhost:${p.port}`) : null,
      h('span.ui-tb', {},
        tbBtn('terminal', 'Вывод процесса', () => this.procOutput(p.id)),
        p.running ? tbBtn('stop', 'Остановить', async () => { try { procs.set(p.id, await api('/api/agent/proc_stop', { id: p.id })); } catch (e) { log('error', e.message); } this.renderEnv(); })
          : tbBtn('closeSmall', 'Убрать из списка', () => forgetProc(p.id))))),
    list.filter(p => !p.running).length > 1 ? h('div.agb-er.act', { onclick: () => list.filter(p => !p.running).forEach(p => forgetProc(p.id)) },
      icon('delete', { size: 16 }), h('span.t', {}, 'Убрать все завершённые')) : null]);
  }
  async procOutput(id) {
    const pre = h('pre.ag-json.agb-diff');
    const load = async () => { try { const r = await api(`/api/agent/proc_output?id=${id}&tail=600`); pre.textContent = r.output; pre.scrollTop = pre.scrollHeight; } catch (e) { pre.textContent = e.message; } };
    const close = () => { clearInterval(t); bg.remove(); };
    const bg = h('div.modal-bg', { onmousedown: e => { if (e.target === bg) close(); } },
      h('div.ui-dialog.agb-ddlg', { onkeydown: e => { if (e.key === 'Escape') close(); } },
        h('div.ttl', {}, procs.get(id)?.command || id, h('span.x', { onclick: close }, icon('close', { size: 16 }))),
        h('div.bd', {}, pre),
        h('div.ft', {}, h('span.st-dim', {}, 'обновляется каждые 2 с · строки процесса есть и в Console (источник «Агент»)'), h('span.grow'), h('button.ui-btn.primary', { onclick: close }, 'Закрыть'))));
    document.body.append(bg);
    const t = setInterval(load, 2000);
    load();
  }

  // ---------- браузер в правой панели (как в Claude): адрес, назад/вперёд, телефон, открыть снаружи ----------
  browserPane() {
    const st = this.br = { url: '', back: [], fwd: [], mobile: !!ui.brMobile };
    const frame = h('iframe.agb-frame', { sandbox: 'allow-scripts allow-same-origin allow-forms allow-popups allow-modals', referrerpolicy: 'no-referrer' });
    const urlIn = h('input.agb-url', { type: 'text', spellcheck: false, placeholder: 'Адрес: localhost:5173, example.com…' });
    const empty = h('div.agb-brempty', {}, icon('toolwindow/web', { size: 32 }), h('b', {}, 'Браузер'),
      h('div', {}, 'Введите адрес или попросите агента: «запусти dev-сервер и открой его». Сюда же открываются порты из «Серверов».'));
    const norm = u => { u = String(u || '').trim(); return !u ? '' : /^[a-z]+:\/\//i.test(u) ? u : /^(localhost|127\.|\d+\.\d+\.\d+\.\d+)/.test(u) ? `http://${u}` : `https://${u}`; };
    const show = () => { frame.style.display = st.url ? '' : 'none'; empty.style.display = st.url ? 'none' : ''; wrap.classList.toggle('on', !!st.url); wrap.classList.toggle('mobile', st.mobile); paint(); };
    const go = (u, push = true) => {
      u = norm(u);
      if (!u) return;
      if (push && st.url && st.url !== u) { st.back.push(st.url); st.fwd.length = 0; }
      st.url = u; urlIn.value = u; frame.src = u; show();
    };
    const tb = (k, ic, tip, fn) => h('button.b', { 'data-k': k, 'data-tip': tip, onclick: fn }, icon(ic, { size: 16 }));
    const bar = h('div.ui-tb.agb-brbar', {},
      tb('back', 'left', 'Назад', () => { if (st.back.length) { st.fwd.push(st.url); go(st.back.pop(), false); } }),
      tb('fwd', 'right', 'Вперёд', () => { if (st.fwd.length) { st.back.push(st.url); go(st.fwd.pop(), false); } }),
      tb('reload', 'refresh', 'Обновить', () => { if (st.url) frame.src = st.url; }),
      urlIn,
      tb('mobile', 'general/layout', 'Ширина телефона', () => { st.mobile = !st.mobile; ui.brMobile = st.mobile; saveUi(); show(); }),
      tb('ext', 'externalLink', 'Открыть во внешнем браузере', () => st.url && openExternal(st.url)));
    const paint = () => {
      bar.querySelector('[data-k=back]').disabled = !st.back.length;
      bar.querySelector('[data-k=fwd]').disabled = !st.fwd.length;
      bar.querySelector('[data-k=mobile]').classList.toggle('on', st.mobile);
    };
    urlIn.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Enter') go(urlIn.value); });
    const wrap = h('div.agb-frw', {}, frame, empty);
    this.browserGo = go;
    show();
    return h('div.agb-browser', {}, bar, wrap,
      h('div.agb-hint', {}, 'Пустая страница? Сайт может запрещать встраивание — откройте его во внешнем браузере.'));
  }
  showBrowser(url, mobile = null) {
    ui.envOff = false; ui.envTab = 'browser'; saveUi();
    this.agbEl?.classList.remove('noenv');
    this.renderEnv();
    if (mobile != null && this.br) { this.br.mobile = mobile; ui.brMobile = mobile; }
    this.browserGo?.(url);
  }
  card(key, title, body, extra = null) {
    const off = !!ui.cards[key];
    return h('div.agb-card', {},
      h('div.agb-ch', { onclick: e => { if (e.target.closest('.ui-tb')) return; ui.cards[key] = !off; saveUi(); this.renderEnv(); } },
        h('b', {}, title), h(`span.agb-tw${off ? '.off' : ''}`, {}, icon('down', { size: 16 })), h('span.grow'), extra),
      off ? null : h('div.agb-cb', {}, ...[body].flat().filter(Boolean)));
  }
  cardEnv(c) {
    const r = (ic, text, right = null, onclick = null, tip = '') => h(`div.agb-er${onclick ? '.act' : ''}`, { onclick, 'data-tip': tip },
      icon(ic, { size: 16 }), h('span.t', {}, text), right);
    const g = this.env?.git;
    const code = c.mode === 'code';
    return this.card('env', 'Среда', [
      r('nodes/desktop', 'Этот компьютер', h('span.agb-mode', {}, icon(MODES[c.mode][1], { size: 14 }), MODES[c.mode][0]), null, MODES[c.mode][2]),
      code ? r('folder', c.cwd ? [h('span', {}, base(c.cwd)), h('span.dim', {}, ` · ${c.cwd}`)] : h('span.dim', {}, 'папка не выбрана'),
        null, e => this.folderPopup(e.currentTarget), c.cwd || 'Выбрать папку проекта') : null,
      code && g ? r('general/vcs', g.branch, g.branches.length > 1 ? icon('right', { size: 16 }) : null, e => this.branchPopup(e.currentTarget), 'Ветка git') : null,
      code && c.cwd && !g ? r('general/vcs', h('span.dim', {}, 'не git-репозиторий')) : null,
      c.mode === 'agent' ? h('div.agb-er', {}, this.wfDropdown(c)) : null,
      c.mode === 'character' && this.char ? r('profile', this.char.name, icon('edit', { size: 16 }), () => characterDialog(this.char)) : null,
      c.mode !== 'character' ? h('div.agb-er', {}, icon('general/locked', { size: 16 }), h('span.t', {}, 'Разрешения'), this.permDropdown(false)) : null,
    ]);
  }
  cardContext() {
    const x = this.env?.ctx;
    if (!x) return this.card('ctx', 'Контекст', h('div.agb-hint', {}, 'считается…'));
    const used = x.real || x.estimate, pct = Math.min(100, (100 * used) / x.window);
    const COL = { system: 'c-sys', tools: 'c-tools', mcp: 'c-mcp', messages: 'c-msg' };
    const pc = n => `${((100 * n) / x.window).toFixed(1).replace('.', ',')} %`;
    const free = Math.max(0, x.window - used);
    return this.card('ctx', 'Контекст', [
      h('div.agb-cx', {}, h('b', {}, `Использовано: ${Math.round(pct)} %`), h('span.grow'), h('span.dim', {}, `${kTok(used)} / ${kTok(x.window)}`)),
      h('div.agb-bar', {}, ...x.parts.map(p => h(`i.${COL[p.key]}`, { style: { width: `${(100 * p.tokens) / x.window}%` }, 'data-tip': `${p.label}: ${kTok(p.tokens)}` }))),
      ...x.parts.map(p => h('div.agb-cr', { 'data-tip': p.pending?.length ? `ещё не запущены: ${p.pending.join(', ')}` : '' },
        h(`i.agb-sq.${COL[p.key]}`), h('span.t', {}, p.label), h('span.dim', {}, kTok(p.tokens)), h('span.p', {}, pc(p.tokens)))),
      h('div.agb-cr', {}, h('i.agb-sq.free'), h('span.t', {}, 'Свободно'), h('span.dim', {}, kTok(free)), h('span.p', {}, pc(free))),
      h('div.agb-hint', {}, `${x.real ? 'Всего — по данным модели за последний запрос, разбивка — оценка.' : 'Оценка до первого ответа модели.'}${x.model ? ` ${x.model}` : ''}`),
    ]);
  }
  cardAccess(c) {
    if (c.mode === 'agent') {
      const all = S.docs.workflow.size, hid = (c.hidden || []).length;
      return this.card('access', 'Доступ', [
        h('div.agb-er', {}, icon('blueprint', { size: 16 }), h('span.t', {}, `Воркфлоу: видно ${all - hid} из ${all}`),
          h('button.ui-btn.secondary.slim', { onclick: e => this.accessPopup(e.currentTarget) }, 'Изменить')),
        h('div.agb-er', {}, icon('folder', { size: 16 }), h('span.t.dim', {}, 'Файлы ПК — только в среде Code')),
      ]);
    }
    const folders = c.folders || [];
    const setF = list => this.patch({ folders: list });
    return this.card('access', 'Доступ', [
      c.cwd ? h('div.agb-er', { 'data-tip': c.cwd }, icon('folder', { size: 16 }), h('span.t', {}, base(c.cwd)), h('span.agb-tag', {}, 'чтение и запись'))
        : h('div.agb-hint', {}, 'Нет папки проекта — агенту не видны файлы.'),
      ...folders.map((f, i) => h('div.agb-er', { 'data-tip': f.path }, icon('folder', { size: 16 }), h('span.t', {}, base(f.path)),
        dropdown(f.write ? 'w' : 'r', [['r', 'чтение'], ['w', 'запись']], v => setF(folders.map((x, j) => (j === i ? { ...x, write: v === 'w' } : x))), { link: true }),
        h('span.ui-tb', {}, tbBtn('closeSmall', 'Убрать доступ', () => setF(folders.filter((_, j) => j !== i)))))),
      h('div.agb-er.act', { onclick: async () => { const p = await pickFolder({ title: 'Дать агенту доступ к папке', ok: 'Дать доступ' }); if (p && !folders.some(f => f.path === p)) setF([...folders, { path: p, write: false }]); } },
        icon('add', { size: 16 }), h('span.t', {}, 'Дать доступ к папке…')),
    ]);
  }
  cardConnectors(c) {
    const on = mcpSt.servers.filter(s => s.enabled);
    const sel = c.connectors;
    const isOn = n => (sel == null ? true : sel.includes(n));
    const toggle = (n, v) => { const cur = sel == null ? on.map(s => s.name) : [...sel]; this.patch({ connectors: v ? [...new Set([...cur, n])] : cur.filter(x => x !== n) }); };
    return this.card('mcp', 'Коннекторы', [
      ...on.map(s => h('div.agb-er', { 'data-tip': s.error || `${s.command}${s.tools.length ? `\nинструментов: ${s.tools.length}` : ''}` },
        h('span.agb-mcp', {}, (s.name[0] || '?').toUpperCase(), h(`i.st-dot${s.state === 'ready' ? '.ok' : s.state === 'error' ? '.bad' : ''}`)), h('span.t', {}, s.name),
        onOff(isOn(s.name), v => toggle(s.name, v)))),
      !on.length ? h('div.agb-hint', {}, 'MCP-серверов нет: файловая система, GitHub, браузер, база данных…') : null,
      h('div.agb-er.act', { onclick: () => openSettings('mcp') }, icon('settings', { size: 16 }), h('span.t', {}, on.length ? 'Настроить MCP…' : 'Добавить MCP-сервер…')),
    ], h('span.ui-tb', {}, tbBtn('refresh', 'Обновить состояние', () => loadSide())));
  }
  cardChanges() {
    const g = this.env.git;
    return this.card('changes', 'Изменения', [
      h('div.agb-cx', {}, h('span.agb-add', {}, `+${g.added.toLocaleString('ru')}`), h('span.agb-del', {}, `−${g.removed.toLocaleString('ru')}`), h('span.grow'), h('span.dim', {}, `файлов: ${g.files.length}`)),
      h('div.agb-files', {}, ...g.files.slice(0, 80).map(f => h('div.agb-fr', { onclick: () => this.showDiff(f.path), 'data-tip': `${f.path}\nЩелчок — показать изменения` },
        h(`span.agb-st.s${f.status}`, {}, f.status), h('span.t', {}, f.path), h('span.agb-add', {}, f.added ? `+${f.added}` : ''), h('span.agb-del', {}, f.removed ? `−${f.removed}` : '')))),
      !g.files.length ? h('div.agb-hint', {}, 'Рабочая копия чистая') : null,
    ], h('span.ui-tb', {}, tbBtn('refresh', 'Обновить', () => this.refreshEnv())));
  }
  async showDiff(path) {
    let d = '';
    try { d = (await api(`/api/agent/diff?cwd=${encodeURIComponent(this.chat.cwd)}&path=${encodeURIComponent(path)}`)).diff; } catch (e) { d = e.message; }
    const pre = h('pre.ag-json.agb-diff');
    pre.append(...d.split('\n').map(l => h(`span${l.startsWith('+') && !l.startsWith('+++') ? '.a' : l.startsWith('-') && !l.startsWith('---') ? '.d' : l.startsWith('@@') ? '.h' : ''}`, {}, `${l}\n`)));
    const close = () => bg.remove();
    const bg = h('div.modal-bg', { onmousedown: e => { if (e.target === bg) close(); } },
      h('div.ui-dialog.agb-ddlg', { tabindex: -1, onkeydown: e => { if (e.key === 'Escape') close(); } },
        h('div.ttl', {}, path, h('span.x', { onclick: close }, icon('close', { size: 16 }))),
        h('div.bd', {}, pre),
        h('div.ft', {}, h('span.grow'), h('button.ui-btn.primary', { onclick: close }, 'Закрыть'))));
    document.body.append(bg);
  }

  // ---------- попапы панели ----------
  chatsPopup(anchor) {
    const cur = S.current.workflow;
    const lst = chats.filter(c => !this.filterWf || c.wf === cur);
    const box = h('div.ui-menu.ag-pop.ag-chats', {},
      h('div.ag-poph', {}, h('b', {}, 'Диалоги'), h('span.grow'),
        h('label.ui-check', {}, h('input', { type: 'checkbox', checked: this.filterWf, onchange: () => { this.filterWf = !this.filterWf; this.chatsPopup(anchor); } }),
          h('span', {}, `только «${doc('workflow', cur)?.data.title || cur || '—'}»`))),
      h('div.item', { onclick: () => { closePop(); this.newChat(); } }, h('span.ic', {}, icon('add', { size: 16 })), h('span', {}, 'Новый диалог')),
      chars.length ? h('div.item', { onclick: e => { e.stopPropagation(); this.charsPopup(anchor); } }, h('span.ic', {}, icon('profile', { size: 16 })), h('span', {}, 'С персонажем…')) : null,
      h('div.sep'),
      ...(lst.length ? lst.map(c => h(`div.item.ag-ci${c.id === this.chat?.id ? '.on' : ''}`, { onclick: () => { closePop(); this.open(c.id); } },
        h('span.ic', {}, busy.has(c.id) ? h('span.ag-tdot.run') : c.mode === 'character' && charOf(c.character) ? avatar(charOf(c.character), 16) : icon(MODES[c.mode || 'agent'][1], { size: 16 })),
        h('span.ag-ct', {}, h('span', {}, c.title || 'Новый диалог'), h('span.dim', {}, `${c.wf ? `${doc('workflow', c.wf)?.data.title || c.wf} · ` : ''}${c.count} сообщ. · ${new Date((c.updated || 0) * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`)),
        h('span.ui-tb.ag-x', {}, tbBtn('edit', 'Переименовать', () => this.rename(c)), tbBtn('delete', 'Удалить', () => this.remove(c.id)))))
        : [h('div.ag-hint', {}, 'диалогов нет')]));
    place(box, anchor);
  }
  charsPopup(anchor) {
    const box = h('div.ui-menu.ag-pop', {}, h('div.ag-poph', {}, h('b', {}, 'Персонажи')),
      ...chars.map(c => h('div.item.ag-ci', { onclick: () => { closePop(); this.openCharacter(c); } }, h('span.ic', {}, avatar(c, 16)), h('span', {}, c.name))),
      h('div.sep'),
      h('div.item', { onclick: () => { closePop(); characterDialog(); } }, h('span.ic', {}, icon('add', { size: 16 })), h('span', {}, 'Новый персонаж…')));
    place(box, anchor);
  }
  settingsPopup(anchor) {
    const c = this.chat;
    if (!c) return;
    const box = h('div.ui-menu.ag-pop.ag-set', {},
      h('div.ag-poph', {}, h('b', {}, 'Диалог')),
      c.mode === 'character' ? h('div.ag-srow', {}, h('span', {}, 'Персонаж'), h('button.ui-btn.secondary.slim', { onclick: () => { closePop(); characterDialog(this.char); } }, this.char?.name || '—'))
        : h('div.ag-srow', {}, h('span', {}, 'Среда'), this.modeSeg()),
      c.mode === 'code' ? h('div.ag-srow', {}, h('span', {}, 'Папка'), this.folderChip()) : null,
      c.mode !== 'character' ? h('div.ag-srow', {}, h('span', {}, 'Разрешения'), this.permDropdown()) : null,
      h('div.ag-hint', {}, MODES[c.mode || 'agent'][2] + (c.mode === 'character' ? '' : '. Подробнее — вкладка AI Chat (панель среды справа).')));
    box.addEventListener('pointerdown', e => e.stopPropagation());
    place(box, anchor);
  }
  accessPopup(anchor) {
    const hidden = new Set(this.chat.hidden || []);
    const row = (id, d) => h('label.item.ag-acc', {},
      h('input', { type: 'checkbox', checked: !hidden.has(id), onchange: e => { e.target.checked ? hidden.delete(id) : hidden.add(id); } }),
      h('span', {}, d.data.title || id), h('span.dim', {}, id));
    const box = h('div.ui-menu.ag-pop.ag-access', {},
      h('div.ag-poph', {}, h('b', {}, 'Что видит агент'), h('span.grow'),
        h('button.ui-btn.secondary.slim', { onclick: () => { box.querySelectorAll('input').forEach(i => { i.checked = true; }); hidden.clear(); } }, 'Все'),
        h('button.ui-btn.secondary.slim', { onclick: () => { box.querySelectorAll('input').forEach(i => { i.checked = false; }); for (const id of S.docs.workflow.keys()) hidden.add(id); } }, 'Ни одного')),
      h('div.ag-hint', {}, 'Снятые воркфлоу не попадают в контекст и недоступны инструментам агента в этом диалоге.'),
      ...[...S.docs.workflow].map(([id, d]) => row(id, d)),
      h('div.ag-foot', {}, h('button.ui-btn.primary', { onclick: () => { closePop(); this.patch({ hidden: [...hidden] }); } }, 'Готово')));
    place(box, anchor);
  }
}

// ---------- персонаж: редактор ----------
function characterDialog(c0 = null) {
  const c = { name: '', persona: '', scenario: '', greeting: '', appearance: '', negative: '', ckpt: '', avatar: '', ...(c0 || {}) };
  let saving = false;
  const close = () => bg.remove();
  const area = (key, rows, ph, extra = {}) => {
    const t = h('textarea', { rows, placeholder: ph, value: c[key] || '', spellcheck: key !== 'appearance' && key !== 'negative', ...extra });
    t.addEventListener('input', () => { c[key] = t.value; });
    t.addEventListener('keydown', e => e.stopPropagation());
    return t;
  };
  const nameIn = h('input', { type: 'text', value: c.name, placeholder: 'Имя' });
  nameIn.addEventListener('input', () => { c.name = nameIn.value; });
  nameIn.addEventListener('keydown', e => e.stopPropagation());
  const avaBox = h('div.agc-ava');
  const drawAva = () => avaBox.replaceChildren(c.avatar ? h('img', { src: fileUrl(c.avatar), alt: '', draggable: false, onclick: () => lightbox([fileUrl(c.avatar)]) }) : avatar(c, 132));
  drawAva();
  const ckBtn = h('button.ui-btn.secondary.agc-ck', { 'data-tip': 'Чекпоинт для фото персонажа (пусто — по умолчанию)',
    onclick: e => libraryPicker(e.currentTarget, { cat: 'checkpoints', value: c.ckpt, onPick: n => { c.ckpt = n; ckBtn.lastChild.textContent = n; } }) },
  icon('image', { size: 16 }), h('span', {}, c.ckpt || 'по умолчанию'));
  const save = async () => {
    if (!c.name.trim()) { nameIn.focus(); nameIn.classList.add('bad'); return null; }
    const r = await api('/api/agent/character', c);
    Object.assign(c, r);
    chars = [r, ...chars.filter(x => x.id !== r.id)];
    for (const v of views) v.renderChrome();
    return r;
  };
  const genBtn = h('button.ui-btn.secondary.slim', { 'data-tip': 'Сгенерировать портрет по внешности (локальная SD)', onclick: async () => {
    if (saving) return;
    if (!c.appearance.trim()) return log('warn', 'опишите внешность персонажа тегами — по ней генерируется портрет');
    saving = true; genBtn.disabled = true; genBtn.lastChild.textContent = 'Рисует…';
    try {
      const r = await save();
      if (r) { const p = await api('/api/agent/character_photo', { id: r.id, framing: 'portrait', scene: 'simple background, smile' }); c.avatar = p.images[0]; drawAva(); await save(); }
    } catch (e) { log('error', `портрет: ${e.message}`); }
    saving = false; genBtn.disabled = false; genBtn.lastChild.textContent = 'Сгенерировать';
  } }, icon('spark', { size: 16 }), h('span', {}, 'Сгенерировать'));
  const row = (label, ctl, hint) => h('div.agc-row', {}, h('label', {}, label), h('div', {}, ctl, hint ? h('div.agc-hint', {}, hint) : null));
  const dlg = h('div.ui-dialog.agc-dlg', { onkeydown: e => { if (e.key === 'Escape') close(); } },
    h('div.ttl', {}, c0 ? `Персонаж — ${c0.name}` : 'Новый персонаж', h('span.x', { onclick: close }, icon('close', { size: 16 }))),
    h('div.bd.agc-bd', {},
      h('div.agc-left', {}, avaBox,
        h('div.agc-avab', {},
          h('button.ui-btn.secondary.slim', { onclick: e => imagePicker(e.currentTarget, { value: c.avatar, onPick: f => { c.avatar = f; drawAva(); } }) }, icon('open', { size: 16 }), 'Выбрать'),
          genBtn)),
      h('div.agc-form', {},
        row('Имя', nameIn),
        row('Характер', area('persona', 4, 'Кто это, характер, манера речи, интересы, отношение к вам…')),
        row('Сценарий', area('scenario', 2, 'Где и как вы общаетесь: «переписываемся в мессенджере», «встретились в таверне»…')),
        row('Приветствие', area('greeting', 2, 'Первое сообщение персонажа')),
        row('Внешность', area('appearance', 3, '1girl, adult woman, long silver hair, green eyes, freckles…', { 'data-prompt-weight': '' }), 'Теги Stable Diffusion по-английски — добавляются к каждому фото'),
        row('Негатив', area('negative', 1, 'чего не должно быть на фото', { 'data-prompt-weight': '' })),
        row('Чекпоинт', ckBtn))),
    h('div.ft', {},
      c0 ? h('button.ui-btn.secondary', { onclick: async () => {
        if (!(await confirmBox(`Удалить персонажа «${c0.name}»? Диалоги с ним останутся.`, { ok: 'Удалить' }))) return;
        await api('/api/agent/character_delete', { id: c0.id });
        chars = chars.filter(x => x.id !== c0.id); close();
        for (const v of views) v.render();
      } }, 'Удалить') : null,
      h('span.grow'),
      h('button.ui-btn.secondary', { onclick: close }, 'Отмена'),
      h('button.ui-btn.secondary', { onclick: async () => { if (await save()) { close(); for (const v of views) v.render(); } } }, 'Сохранить'),
      h('button.ui-btn.primary', { onclick: async () => {
        const r = await save();
        if (!r) return;
        close();
        openWorkspace('chat');
        const v = views.find(x => x.big) || views[0];
        await v.newChat({ character: r.id });
      } }, c0 ? 'Новый разговор' : 'Создать и начать')));
  const bg = h('div.modal-bg', { onmousedown: e => { if (e.target === bg) close(); } }, dlg);
  document.body.append(bg);
  nameIn.focus();
}

// панель → вкладка с тем же диалогом
async function bigOpen(id) {
  openWorkspace('chat');
  const v = views.find(x => x.big);
  if (v && id && v.chat?.id !== id) await v.open(id);
}

// ---------- регистрация ----------
async function show(v) {
  provs ||= await getSettings().catch(() => null);
  if (!chats.length && S.server.running) await loadAll();
  else if (!v.chat && chats.length) await v.restore();
  else v.render();
}
export const showAgent = () => show(views[0]);
export const showChat = () => show(views[1]);

export function initAgent() {
  views.push(new ChatView(document.getElementById('v-agent'), false), new ChatView(document.getElementById('v-chat'), true));
  on('agent', onAgent);
  on('server', st => {
    if (st.running) { provs = null; setTimeout(async () => { provs = await getSettings().catch(() => null); await loadAll(); }, 900); }
    else { chats = []; for (const v of views) { v.chat = null; v.render(); } }
  });
  on('providers-changed', async () => { provs = await getSettings().catch(() => provs); for (const v of views) v.render(); });
  on('mcp-changed', loadSide);
  addEventListener('pointerdown', e => {
    closedBy = null;
    if (pop && !pop.contains(e.target) && !e.target.closest?.('.ui-ddpop, .lib-pick, .ip-pop, .ctx-menu')) {
      if (pop.anchor?.contains?.(e.target)) closedBy = pop.anchor;
      closePop();
    }
  }, true);
  addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });
  // «Спросить агента» о ноде/воркфлоу из других мест — в видимый чат
  on('agent-ask', text => { const v = views.find(x => x.big && activeView() === 'chat') || views[0]; if (v.ta) { v.ta.value = text; v.autosize(); v.ta.focus(); } });
}
