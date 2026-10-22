// AI Agent — чат с моделью прямо в редакторе (как Claude): диалоги, картинки (кнопка, вставка Ctrl+V, перетаскивание),
// стриминг ответа и размышлений, вызовы инструментов. Диалог привязан к воркфлоу (его граф — в контексте модели),
// а «Доступ» запрещает агенту видеть отдельные воркфлоу. Хранение и ход агента — сервер (server/maistep/agent.py,
// /api/agent/*, события SSE agent). Правки графа от агента применяются обычной правкой — Ctrl+Z отменяет.
import { h, esc, prompt, confirmBox } from './util.js';
import { S, on, emit, doc, edit, addDoc, normalize } from './store.js';
import { icon } from './icons.js';
import { api, upload, fileUrl, getSettings } from './backend.js';
import { modelPicker } from './modelpick.js';
import { lightbox } from './graph.js';

const LS = 'maistep-agent-chat';
let chats = [], chat = null, provs = null, viewEl = null, listEl = null, draftEl = null, ta = null, attachEl = null;
let busy = new Set(), draft = null, attach = [], filterWf = false, pop = null;
const log = (level, text) => emit('log', { src: 'agent', level, text });

// ---------- данные ----------
async function loadChats() {
  if (!S.server.running) return;
  try { chats = await api('/api/agent/chats'); } catch (e) { log('error', `диалоги: ${e.message}`); return; }
  busy = new Set(chats.filter(c => c.busy).map(c => c.id));
  const want = chat?.id || (() => { try { return localStorage.getItem(LS); } catch { return null; } })();
  if (want && chats.some(c => c.id === want)) await openChat(want, false);
  else if (chats.length) await openChat(chats[0].id, false);
  else render();
}

async function openChat(id, focus = true) {
  try { chat = await api(`/api/agent/chat?id=${id}`); } catch (e) { log('error', e.message); return; }
  try { localStorage.setItem(LS, id); } catch {}
  draft = null;
  render(true);
  if (focus) ta?.focus();
}

async function newChat() {
  const base = chat || {};
  const c = await api('/api/agent/chat', { provider: base.provider || provs?.default_provider, model: base.model, wf: S.current.workflow });
  if (base.effort) await api('/api/agent/chat', { id: c.id, effort: base.effort });
  chats.unshift(c);
  await openChat(c.id);
}

async function patch(fields) {
  if (!chat) return;
  try {
    const c = await api('/api/agent/chat', { id: chat.id, ...fields });
    Object.assign(chat, c);
    const i = chats.findIndex(x => x.id === c.id);
    if (i >= 0) chats[i] = { ...chats[i], ...c };
  } catch (e) { log('error', e.message); }
  render();
}

async function removeChat(id) {
  if (!(await confirmBox('Удалить диалог? Это нельзя отменить.'))) return;
  await api('/api/agent/delete', { id });
  chats = chats.filter(c => c.id !== id);
  if (chat?.id === id) { chat = null; if (chats[0]) await openChat(chats[0].id, false); }
  render();
}

// видимые агенту воркфлоу — текущее состояние редактора (с несохранёнными правками)
const visible = () => Object.fromEntries([...S.docs.workflow].filter(([id]) => !chat?.hidden?.includes(id)).map(([id, d]) => [id, d.data]));

async function send() {
  if (!chat) await newChat();
  const text = ta.value.trim();
  if (!text && !attach.length) return;
  if (busy.has(chat.id)) return;
  const images = attach.map(a => a.file);
  ta.value = ''; attach = []; autosize(); renderAttach();
  try { await api('/api/agent/send', { id: chat.id, text, images, workflows: visible() }); }
  catch (e) { log('error', e.message); ta.value = text; }
}

const stop = () => chat && api('/api/agent/stop', { id: chat.id }).catch(() => {});

async function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) { log('warn', `${f.name}: можно прикрепить только картинки`); continue; }
    const name = `chat_${Date.now().toString(36)}_${(f.name || 'image.png').replace(/[^\w.-]+/g, '_')}`;
    try { attach.push({ file: await upload(new File([f], name, { type: f.type })) }); }
    catch (e) { log('error', `загрузка ${f.name}: ${e.message} (сервер запущен?)`); }
  }
  renderAttach();
}

// ---------- события сервера ----------
function onAgent(d) {
  if (d.kind === 'workflow') return applyWorkflow(d);
  if (d.kind === 'start') busy.add(d.chat);
  if (d.kind === 'done') { busy.delete(d.chat); if (d.chat === chat?.id) { draft = null; } loadList(); }
  if (d.chat !== chat?.id) { if (['start', 'done'].includes(d.kind)) renderTop(); return; }
  if (d.kind === 'user') { chat.messages.push(d.message); if (d.title) chat.title = d.title; draft = { text: '', thinking: '', tools: [] }; render(true); return; }
  if (d.kind === 'start') { draft ||= { text: '', thinking: '', tools: [] }; renderDraft(); renderComposer(); return; }
  if (d.kind === 'delta') { draft ||= { text: '', thinking: '', tools: [] }; draft.text += d.text; renderDraft(); return; }
  if (d.kind === 'thinking') { draft ||= { text: '', thinking: '', tools: [] }; draft.thinking += d.text; renderDraft(); return; }
  if (d.kind === 'tool_start' || d.kind === 'tool_run') {
    draft ||= { text: '', thinking: '', tools: [] };
    if (!draft.tools.some(t => t.id === d.id)) draft.tools.push({ id: d.id, name: d.name, running: d.kind === 'tool_run' });
    else draft.tools.find(t => t.id === d.id).running = d.kind === 'tool_run';
    renderDraft(); return;
  }
  if (d.kind === 'message') {
    chat.messages.push(d.message);
    draft = busy.has(chat.id) ? { text: '', thinking: '', tools: [] } : null;
    render(true); return;
  }
  if (d.kind === 'done') render();
}
const loadList = async () => { try { chats = await api('/api/agent/chats'); renderTop(); } catch {} };

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
  let list = null, table = null;
  const flush = () => { if (list) { out.push(`<${list.t}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.t}>`); list = null; } if (table) { out.push(tableHtml(table, inline)); table = null; } };
  for (const line of s.split('\n')) {
    let m;
    if ((m = line.match(/^\u0000(\d+)\u0000$/))) { flush(); out.push(blocks[+m[1]]); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { if (list) flush(); (table ||= []).push(line); continue; }
    if (table) flush();
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flush(); out.push(`<div class="ag-h${m[1].length}">${inline(m[2])}</div>`); continue; }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { if (list?.t !== 'ul') { flush(); list = { t: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (list?.t !== 'ol') { flush(); list = { t: 'ol', items: [] }; } list.items.push(m[1]); continue; }
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
const mdEl = text => { const el = h('div.ag-md'); el.innerHTML = md(text); return el; };

// ---------- отрисовка ----------
const TOOL_LABEL = { list_workflows: 'Список воркфлоу', get_workflow: 'Читает граф', edit_workflow: 'Правит граф', create_workflow: 'Создаёт воркфлоу',
  run_workflow: 'Запускает', view_image: 'Смотрит картинку', list_models: 'Ищет модели', node_info: 'Описание ноды' };

function toolChip(t, res, running = false) {
  const arg = t.input?.id || t.input?.file || t.input?.cat || t.input?.type || '';
  const head = h('summary', {},
    h(`span.ag-tdot${running ? '.run' : res ? (res.ok ? '.ok' : '.bad') : ''}`),
    h('b', {}, TOOL_LABEL[t.name] || t.name), arg ? h('span.dim', {}, ` ${arg}`) : null,
    t.name === 'edit_workflow' && t.input?.ops ? h('span.dim', {}, ` · ${t.input.ops.length} правок`) : null);
  const body = [];
  if (t.input && Object.keys(t.input).length) body.push(h('pre.ag-json', {}, JSON.stringify(t.input, null, 1).slice(0, 4000)));
  if (res) body.push(h(`pre.ag-json${res.ok ? '' : '.err'}`, {}, String(res.content || '').slice(0, 6000)));
  const imgs = res?.images?.length ? h('div.ag-imgs', {}, ...res.images.map((f, i, all) => thumb(f, all, i))) : null;
  return h('div.ag-tool', {}, h('details', {}, head, ...body), imgs);
}

function thumb(f, all = [f], i = 0) {
  return h('img.ag-thumb', { src: fileUrl(f), loading: 'lazy', 'data-tip': f, onclick: () => lightbox(all.map(fileUrl), i) });
}

function messageEl(m, results) {
  if (m.role === 'user') {
    return h('div.ag-msg.user', {},
      m.images?.length ? h('div.ag-imgs.r', {}, ...m.images.map((f, i, all) => thumb(f, all, i))) : null,
      m.text ? h('div.ag-bubble', {}, m.text) : null);
  }
  if (m.role === 'error') return h('div.ag-msg.err', {}, icon('error', { size: 14 }), h('span', {}, m.text));
  if (m.role === 'assistant') {
    return h('div.ag-msg.bot', {},
      m.thinking ? h('details.ag-think', {}, h('summary', {}, 'Размышления'), h('div', {}, m.thinking)) : null,
      m.text ? mdEl(m.text) : null,
      ...(m.tools || []).map(t => toolChip(t, results.get(t.id))),
      m.note ? h('div.ag-note', {}, m.note) : null,
      m.usage ? h('div.ag-meta', { 'data-tip': 'токены: вход / выход / из кэша' }, `${m.model || ''} · ${m.usage.in}/${m.usage.out}${m.usage.cache_read ? ` · кэш ${m.usage.cache_read}` : ''}`) : null);
  }
  return null;
}

function renderDraft() {
  if (!draftEl) return;
  if (!draft || !chat || !busy.has(chat.id)) { draftEl.replaceChildren(); return; }
  const stick = nearBottom();
  draftEl.replaceChildren(h('div.ag-msg.bot', {},
    draft.thinking ? h('details.ag-think', { open: !draft.text }, h('summary', {}, 'Размышляет…'), h('div', {}, draft.thinking)) : null,
    draft.text ? mdEl(draft.text) : null,
    ...draft.tools.map(t => toolChip(t, null, t.running)),
    !draft.text && !draft.tools.length && !draft.thinking ? h('div.ag-typing', {}, h('i'), h('i'), h('i')) : null));
  if (stick) scrollDown();
}
const nearBottom = () => !listEl || listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 80;
const scrollDown = () => { if (listEl) listEl.scrollTop = listEl.scrollHeight; };

function renderTop() {
  const top = viewEl?.querySelector('.ag-top');
  if (top) top.replaceWith(topBar());
}

function topBar() {
  const c = chat;
  const prov = c && provs?.providers?.[c.provider];
  const wfTitle = id => doc('workflow', id)?.data.title || id;
  const hiddenN = c?.hidden?.length || 0;
  return h('div.ag-top', {},
    h('button.ag-title', { onclick: e => chatsPopup(e.currentTarget), 'data-tip': 'Диалоги' },
      busy.has(c?.id) ? h('span.ag-tdot.run') : null,
      h('span', {}, c?.title || (c ? 'Новый диалог' : 'Нет диалога')), icon('down', { size: 12 })),
    h('button.icon', { onclick: newChat, 'data-tip': 'Новый диалог' }, icon('add', { size: 14 })),
    h('span.grow'),
    c ? h('button.ag-chip', { onclick: e => providerPopup(e.currentTarget), 'data-tip': 'Провайдер' }, prov?.name || c.provider) : null,
    c ? h('button.ag-chip', { onclick: e => modelPicker(e.currentTarget, { provider: c.provider, value: c.model, onPick: id => patch({ model: id }) }), 'data-tip': 'Модель' }, c.model || 'модель') : null,
    c ? h('button.ag-chip', { onclick: e => menu(e.currentTarget, ['low', 'medium', 'high', 'xhigh', 'max'].map(x => [x, x === c.effort, () => patch({ effort: x })])), 'data-tip': 'Усилие (effort, только Claude): больше — умнее и дороже' }, c.effort || 'medium') : null,
    c ? h('button.ag-chip', { onclick: e => bindPopup(e.currentTarget), 'data-tip': 'Воркфлоу, к которому привязан диалог: его граф агент видит сразу' },
      icon('blueprint', { size: 12 }), c.wf ? wfTitle(c.wf) : 'без воркфлоу') : null,
    c ? h(`button.ag-chip${hiddenN ? '.warn' : ''}`, { onclick: e => accessPopup(e.currentTarget), 'data-tip': 'Какие воркфлоу агент может видеть' },
      icon(hiddenN ? 'hide' : 'show', { size: 12 }), hiddenN ? `скрыто ${hiddenN}` : 'доступ: все') : null);
}

function render(scroll = false) {
  if (!viewEl) return;
  if (!S.server.running) { viewEl.replaceChildren(h('div.msg', {}, 'Сервер не запущен — агент работает через него')); return; }
  const stick = scroll || nearBottom(), keep = listEl?.scrollTop;
  const typed = ta?.value, focused = document.activeElement === ta;
  listEl = h('div.ag-list');
  draftEl = h('div');
  const results = new Map();
  for (const m of chat?.messages || []) if (m.role === 'tool') for (const r of m.results) results.set(r.id, r);
  const msgs = (chat?.messages || []).map(m => messageEl(m, results)).filter(Boolean);
  if (!msgs.length) listEl.append(empty());
  listEl.append(...msgs, draftEl);
  viewEl.replaceChildren(topBar(), listEl, composer());
  if (typed) { ta.value = typed; autosize(); }
  if (focused) ta.focus();
  renderDraft();
  requestAnimationFrame(() => { if (stick) scrollDown(); else if (keep != null) listEl.scrollTop = keep; });
}

function empty() {
  const ex = ['Объясни, как устроен этот воркфлоу', 'Добавь LoRA между чекпоинтом и сэмплером', 'Почему KSampler падает с ошибкой?', 'Сделай воркфлоу txt2img с hires fix'];
  return h('div.ag-empty', {}, icon('ai', { size: 28 }), h('div.ag-h2', {}, 'AI Agent'),
    h('div.dim', {}, 'Помогает собирать и чинить воркфлоу, видит граф, может его править и запускать. Картинки — кнопкой, Ctrl+V или перетаскиванием.'),
    h('div.ag-ex', {}, ...ex.map(t => h('button', { onclick: () => { ta.value = t; autosize(); ta.focus(); } }, t))));
}

function composer() {
  attachEl = h('div.ag-attach');
  ta = h('textarea', { rows: 1, placeholder: 'Сообщение агенту… (Enter — отправить, Shift+Enter — новая строка)', spellcheck: true });
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    if (e.key === 'Escape' && chat && busy.has(chat.id)) stop();
  });
  ta.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  const file = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' } });
  file.onchange = () => { addFiles([...file.files]); file.value = ''; };
  const el = h('div.ag-comp', {}, attachEl, ta,
    h('div.ag-row', {},
      h('button.icon', { onclick: () => file.click(), 'data-tip': 'Прикрепить картинки' }, icon('attached', { size: 16 })), file,
      h('span.grow'),
      h('span.ag-sendwrap')));
  renderAttach();
  renderComposer(el);
  return el;
}

function renderComposer(el = viewEl?.querySelector('.ag-comp')) {
  const w = el?.querySelector('.ag-sendwrap');
  if (!w) return;
  w.replaceChildren(chat && busy.has(chat.id)
    ? h('button.ag-send.stop', { onclick: stop, 'data-tip': 'Остановить (Esc)' }, icon('stop', { size: 14 }), 'Стоп')
    : h('button.ag-send.primary', { onclick: send, 'data-tip': 'Отправить (Enter)' }, icon('send', { size: 14 }), 'Отправить'));
}

function renderAttach() {
  if (!attachEl) return;
  attachEl.replaceChildren(...attach.map((a, i) => h('div.ag-att', {}, h('img', { src: fileUrl(a.file) }),
    h('button', { onclick: () => { attach.splice(i, 1); renderAttach(); }, 'data-tip': 'Убрать' }, '×'))));
}
function autosize() { if (!ta) return; ta.style.height = 'auto'; ta.style.height = `${Math.min(220, ta.scrollHeight)}px`; }

// ---------- попапы ----------
function closePop() { pop?.remove(); pop = null; }
function place(el, anchor) {
  closePop();
  document.body.append(el);
  const r = anchor.getBoundingClientRect(), w = el.offsetWidth;
  el.style.left = `${Math.max(4, Math.min(r.left, innerWidth - w - 6))}px`;
  el.style.top = `${Math.min(r.bottom + 4, innerHeight - el.offsetHeight - 6)}px`;
  pop = el;
}
function menu(anchor, items) {
  place(h('div.ui-menu.ag-pop', {}, ...items.map(([label, on, fn]) => h(`div.item${on ? '.on' : ''}`, { onclick: () => { closePop(); fn(); } },
    h('span.ic', {}, on ? icon('check', { size: 14 }) : null), h('span', {}, label)))), anchor);
}

function chatsPopup(anchor) {
  const cur = S.current.workflow;
  const list = chats.filter(c => !filterWf || c.wf === cur);
  const box = h('div.ui-menu.ag-pop.ag-chats', {},
    h('div.ag-poph', {}, h('b', {}, 'Диалоги'), h('span.grow'),
      h(`button.ag-chip${filterWf ? '.on' : ''}`, { onclick: () => { filterWf = !filterWf; chatsPopup(anchor); } }, `только «${doc('workflow', cur)?.data.title || cur || '—'}»`)),
    h('div.item', { onclick: () => { closePop(); newChat(); } }, h('span.ic', {}, icon('add', { size: 14 })), h('span', {}, 'Новый диалог')),
    h('div.sep'),
    ...(list.length ? list.map(c => h(`div.item.ag-ci${c.id === chat?.id ? '.on' : ''}`, { onclick: () => { closePop(); openChat(c.id); } },
      h('span.ic', {}, busy.has(c.id) ? h('span.ag-tdot.run') : icon('ai', { size: 14 })),
      h('span.ag-ct', {}, h('span', {}, c.title || 'Новый диалог'), h('span.dim', {}, `${c.wf ? `${doc('workflow', c.wf)?.data.title || c.wf} · ` : ''}${c.count} сообщ. · ${new Date((c.updated || 0) * 1000).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}`)),
      h('button.icon.ag-x', { onclick: e => { e.stopPropagation(); closePop(); renameChat(c); }, 'data-tip': 'Переименовать' }, icon('edit', { size: 13 })),
      h('button.icon.ag-x', { onclick: e => { e.stopPropagation(); closePop(); removeChat(c.id); }, 'data-tip': 'Удалить' }, icon('delete', { size: 13 }))))
      : [h('div.dim', { style: { padding: '6px 12px' } }, 'диалогов нет')]));
  place(box, anchor);
}

async function renameChat(c) {
  const r = await prompt('Диалог', [{ key: 't', label: 'Название', value: c.title || '' }], 'Сохранить');
  if (r?.t == null) return;
  const t = r.t;
  if (c.id === chat?.id) return patch({ title: t });
  await api('/api/agent/chat', { id: c.id, title: t });
  loadList();
}

async function providerPopup(anchor) {
  provs ||= await getSettings().catch(() => null);
  menu(anchor, Object.entries(provs?.providers || {}).map(([pid, p]) => [`${p.name || pid}${p.has_key || p.kind === 'ollama' ? '' : ' (нет ключа)'}`, pid === chat.provider, () => patch({ provider: pid })]));
}

function bindPopup(anchor) {
  menu(anchor, [['без воркфлоу', !chat.wf, () => patch({ wf: null })],
    ...[...S.docs.workflow].map(([id, d]) => [`${d.data.title || id}${chat.hidden?.includes(id) ? ' (скрыт)' : ''}`, chat.wf === id, () => patch({ wf: id })])]);
}

function accessPopup(anchor) {
  const hidden = new Set(chat.hidden || []);
  const row = (id, d) => h('label.item.ag-acc', {},
    h('input', { type: 'checkbox', checked: !hidden.has(id), onchange: e => { e.target.checked ? hidden.delete(id) : hidden.add(id); } }),
    h('span', {}, d.data.title || id), h('span.dim', {}, id));
  const box = h('div.ui-menu.ag-pop.ag-access', {},
    h('div.ag-poph', {}, h('b', {}, 'Что видит агент'), h('span.grow'),
      h('button.ag-chip', { onclick: () => { box.querySelectorAll('input').forEach(i => { i.checked = true; }); hidden.clear(); } }, 'все'),
      h('button.ag-chip', { onclick: () => { box.querySelectorAll('input').forEach(i => { i.checked = false; }); for (const id of S.docs.workflow.keys()) hidden.add(id); } }, 'ни одного')),
    h('div.dim', { style: { padding: '0 12px 6px', fontSize: '11px' } }, 'Снятые воркфлоу не попадают в контекст и недоступны инструментам агента в этом диалоге.'),
    ...[...S.docs.workflow].map(([id, d]) => row(id, d)),
    h('div.ag-poph', {}, h('span.grow'), h('button.primary', { onclick: () => { closePop(); patch({ hidden: [...hidden] }); } }, 'Готово')));
  place(box, anchor);
}

// ---------- регистрация ----------
export async function showAgent() {
  viewEl = document.getElementById('v-agent');
  if (!viewEl) return;
  provs ||= await getSettings().catch(() => null);
  if (!chat && S.server.running) await loadChats();
  else render();
}

export function initAgent() {
  viewEl = document.getElementById('v-agent');
  on('agent', onAgent);
  on('server', st => { if (st.running) { provs = null; setTimeout(() => { if (viewEl?.isConnected) showAgent(); }, 900); } else { chat = null; chats = []; render(); } });
  addEventListener('pointerdown', e => { if (pop && !pop.contains(e.target)) closePop(); });
  addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });
  // перетаскивание картинок на панель
  viewEl?.addEventListener('dragover', e => { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); viewEl.classList.add('drop'); } });
  viewEl?.addEventListener('dragleave', e => { if (!viewEl.contains(e.relatedTarget)) viewEl.classList.remove('drop'); });
  viewEl?.addEventListener('drop', e => { e.preventDefault(); viewEl.classList.remove('drop'); addFiles([...e.dataTransfer.files]); });
  // «Спросить агента» о ноде/воркфлоу из других мест
  on('agent-ask', text => { if (ta) { ta.value = text; autosize(); ta.focus(); } });
}
