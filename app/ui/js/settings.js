// Настройки приложения — одно окно вместо разрозненных пунктов меню (как Preferences в UI Kit: разделы слева, форма
// справа, подвал Отмена / Применить / OK). Разделы: Общие, Провайдеры LLM (+ перевод), llama.cpp, MCP-серверы, AI Chat,
// Производительность, Civitai. Каждый раздел — { el, apply } и строится при первом открытии; OK применяет изменённые.
// openSettings('mcp') открывает сразу нужный раздел.
import { h, fill, stepper } from './util.js';
import { S, emit } from './store.js';
import { icon } from './icons.js';
import { api } from './backend.js';
import { dropdown, onOff, search } from './kit.js';
import { isTauri } from './api.js';
import { autosaveOn, setAutosave } from './persist.js';
import { statsShown, toggleStats, limitsBox, openLogs, logsReport } from './stats.js';
import { resetLayout } from './dock.js';
import { providersPanel } from './providers.js';
import { pickFolder } from './folders.js';

const log = (level, text) => emit('log', { src: 'editor', level, text });

// ---------- общие элементы формы (их берут и другие разделы) ----------
export function row(label, control, hintText) {
  return h('div.st-row', {}, h('label', {}, label), h('div.st-ctl', {}, control, hintText ? hint(hintText) : null));
}
export function hint(text) { return h('div.st-hint', {}, text); }
export function input(value, onChange, { type = 'text', placeholder = '', width } = {}) {
  const el = h('input', { type, value: value ?? '', placeholder, spellcheck: false, autocomplete: 'off', style: width ? { width: `${width}px` } : {} });
  el.addEventListener('input', () => onChange?.(type === 'number' ? Number(el.value) : el.value));
  el.addEventListener('keydown', e => e.stopPropagation());
  return type === 'number' ? stepper(el) : el; // числа — со стрелками UI Kit (.ui-num)
}
const head = (text, ...extra) => h('div.st-h', {}, text, ...extra);
const card = (...kids) => h('div.st-card', {}, ...kids);

// ---------- разделы ----------
const SECTIONS = [
  ['general', 'Общие', 'settings'],
  ['providers', 'Провайдеры LLM', 'ai'],
  ['llama', 'llama.cpp', 'nodes/desktop'],
  ['mcp', 'MCP-серверы', 'nodes/plugin'],
  ['chat', 'AI Chat: папки', 'folder'],
  ['perf', 'Производительность', 'toolwindow/profiler'],
  ['civitai', 'Civitai', 'download'],
];

async function general() {
  const PORT_KEY = 'maistep-port', def = isTauri ? 3300 : 3310;
  let port = (() => { try { return Number(localStorage.getItem(PORT_KEY)) || def; } catch { return def; } })();
  let p0 = port, auto = autosaveOn(), stats = statsShown();
  return {
    el: h('div', {},
      head('Редактор'),
      row('Автосохранение', onOff(auto, v => { auto = v; }), 'Воркфлоу сохраняются сами после каждой правки.'),
      row('Нагрузка в строке состояния', onOff(stats, v => { stats = v; }), 'CPU, RAM и GPU внизу окна (Ctrl+Shift+M).'),
      row('Раскладка', h('button.ui-btn.secondary', { onclick: () => resetLayout() }, 'Сбросить раскладку вкладки')),
      head('Python-сервер'),
      row('Порт', input(port, v => { port = Math.max(1, Math.min(65535, v | 0)) || def; }, { type: 'number', width: 100 }),
        `Применяется после перезапуска сервера (Ctrl+F5). По умолчанию ${def}.`)),
    apply: () => {
      if (auto !== autosaveOn()) setAutosave(auto);
      if (stats !== statsShown()) toggleStats();
      if (port !== p0) { try { localStorage.setItem(PORT_KEY, port); } catch {} p0 = port; emit('port-changed', port); }
      return true;
    },
  };
}

async function llama() {
  let st = await api('/api/llamacpp'), cfg = { ...st.config }, dirty = false;
  const box = h('div'), statusEl = h('div.st-status');
  const set = (k, v) => { cfg[k] = v; dirty = true; };
  let models = null;
  const drawStatus = () => fill(statusEl,
    h(`span.st-dot${st.ready ? '.ok' : st.running ? '.run' : ''}`),
    h('span', {}, st.ready ? `работает${st.external ? ' (запущен не maistep)' : ''} · ${st.base_url}${st.n_ctx ? ` · контекст ${st.n_ctx}` : ''}` : st.running ? 'запускается…' : 'остановлен'),
    h('span.grow'),
    st.running ? h('button.ui-btn.secondary.slim', { onclick: async () => { st = await api('/api/llamacpp/stop', {}); drawStatus(); } }, icon('stop', { size: 16 }), 'Остановить')
      : h('button.ui-btn.primary.slim', { onclick: async () => {
        await apply();
        try { st = await api('/api/llamacpp/start', {}); } catch (e) { log('error', `llama.cpp: ${e.message}`); }
        drawStatus(); poll();
      } }, icon('play', { size: 16 }), 'Запустить'));
  let timer = 0;
  const poll = () => { clearTimeout(timer); timer = setTimeout(async () => { if (!box.isConnected) return; st = await api('/api/llamacpp').catch(() => st); drawStatus(); logEl.textContent = (st.log || []).join('\n'); if (st.running && !st.ready) poll(); }, 1500); };
  const logEl = h('pre.st-log', {}, (st.log || []).join('\n'));
  const modelDd = dropdown(cfg.model, cfg.model ? [[cfg.model, cfg.model.split(/[\\/]/).pop()]] : [], v => set('model', v), { width: 360, placeholder: 'выберите .gguf' });
  const loadModels = async () => {
    models ||= await api('/api/llamacpp/models').catch(() => []);
    const opts = models.map(m => ({ value: m.path, label: m.name, sec: `${(m.size / 2 ** 30).toFixed(1)} ГБ` }));
    if (cfg.model && !opts.some(o => o.value === cfg.model)) opts.unshift({ value: cfg.model, label: cfg.model.split(/[\\/]/).pop() });
    modelDd.setOptions(opts);
  };
  loadModels();
  box.append(
    head('Локальный сервер llama.cpp'),
    hint('llama-server даёт OpenAI-совместимый API с инструментами — агент в AI Chat работает с локальной моделью без ключей. Провайдер «llama.cpp (локально)» появится в списке моделей чата.'),
    card(statusEl),
    row('llama-server', h('div.st-line', {}, input(cfg.bin, v => set('bin', v), { placeholder: st.bin_found || 'путь к llama-server.exe или к папке' }),
      h('button.ui-btn.secondary.slim', { onclick: async () => { const p = await pickFolder({ title: 'Папка с llama-server', value: cfg.bin }); if (p) { set('bin', p); box.querySelector('.st-line input').value = p; } } }, icon('open', { size: 16 }))),
    st.bin_found ? `Найден: ${st.bin_found}` : 'Не найден в PATH — скачайте сборку llama.cpp (github.com/ggml-org/llama.cpp/releases) и укажите путь.'),
    row('Модель', h('div.st-line', {}, modelDd,
      h('button.ui-btn.secondary.slim', { 'data-tip': 'Указать путь к .gguf вручную', onclick: () => { const v = window.prompt('Путь к файлу .gguf', cfg.model || ''); if (v) { set('model', v.trim()); models = null; loadModels(); modelDd.value = v.trim(); } } }, icon('edit', { size: 16 }))),
    '.gguf ищутся в папках моделей библиотеки (Models).'),
    row('Контекст', input(cfg.ctx, v => set('ctx', v), { type: 'number', width: 110 }), 'Токенов (-c). Больше — больше памяти.'),
    row('Слоёв на GPU', input(cfg.ngl, v => set('ngl', v), { type: 'number', width: 110 }), '-ngl: 99 — вся модель на видеокарте, 0 — только CPU.'),
    row('Порт', input(cfg.port, v => set('port', v), { type: 'number', width: 110 })),
    row('Доп. аргументы', input(cfg.extra, v => set('extra', v), { placeholder: '--flash-attn on -t 8' })),
    row('Автозапуск', onOff(cfg.autostart, v => set('autostart', v)), 'Поднимать сервер при первом сообщении в чате с llama.cpp.'),
    head('Лог'), logEl);
  drawStatus();
  if (st.running && !st.ready) poll();
  async function apply() {
    if (!dirty) return true;
    try { st = await api('/api/llamacpp', cfg); dirty = false; drawStatus(); emit('providers-changed'); return true; }
    catch (e) { log('error', `llama.cpp: ${e.message}`); return false; }
  }
  return { el: box, apply };
}

async function mcpPanel() {
  let st = await api('/api/mcp'), dirty = false;
  const box = h('div'), listEl = h('div.st-mcp');
  const edits = {}; // имя → { enabled } | null (удалить); применяется к полному конфигу с сервера (/api/mcp/config)
  const draw = () => fill(listEl, ...st.servers.filter(s => edits[s.name] !== null).map(s => {
    const e = edits[s.name] || {};
    const on = e.enabled ?? s.enabled;
    return h('div.st-mcp-it', {},
      h('div.st-mcp-hd', {},
        h(`span.st-dot${s.state === 'ready' ? '.ok' : s.state === 'error' ? '.bad' : s.state === 'starting' ? '.run' : ''}`, { 'data-tip': s.error || s.state }),
        h('b', {}, s.name), h('span.st-dim', {}, s.kind === 'http' ? 'HTTP' : 'stdio'),
        s.tools.length ? h('span.st-badge', { 'data-tip': s.tools.map(t => t.name).join('\n') }, `${s.tools.length} инстр. · ~${(s.tokens / 1000).toFixed(1)}k ток.`) : null,
        h('span.grow'),
        h('button.ui-btn.secondary.slim', { onclick: async b => { b.currentTarget.disabled = true; await apply(); st = await api('/api/mcp/test', { name: s.name }); draw(); } }, 'Проверить'),
        onOff(on, v => { (edits[s.name] ||= {}).enabled = v; dirty = true; }),
        h('div.ui-tb', {}, h('button.b', { 'data-tip': 'Удалить', onclick: () => { edits[s.name] = null; dirty = true; draw(); } }, icon('delete', { size: 16 })))),
      h('div.st-mcp-cmd', {}, s.command),
      s.error ? h('div.st-err', {}, s.error) : null);
  }), !st.servers.length ? hint('Серверов пока нет. Добавьте свой или вставьте JSON из Claude Desktop / Cursor ({"mcpServers": …}).') : null);
  const addForm = () => {
    const f = { name: '', command: '', args: '', url: '', env: '' };
    const kind = { v: 'stdio' };
    const body = h('div');
    const drawForm = () => fill(body,
      row('Имя', input(f.name, v => { f.name = v; }, { placeholder: 'filesystem' })),
      row('Тип', dropdown(kind.v, [['stdio', 'Локальный (команда)'], ['http', 'Удалённый (URL)']], v => { kind.v = v; drawForm(); }, { width: 220 })),
      ...(kind.v === 'stdio' ? [
        row('Команда', input(f.command, v => { f.command = v; }, { placeholder: 'npx' })),
        row('Аргументы', input(f.args, v => { f.args = v; }, { placeholder: '-y @modelcontextprotocol/server-filesystem C:\\Projects' }), 'Через пробел; путь с пробелами — в кавычках.'),
        row('Переменные', input(f.env, v => { f.env = v; }, { placeholder: 'KEY=value; OTHER=…' })),
      ] : [row('URL', input(f.url, v => { f.url = v; }, { placeholder: 'https://example.com/mcp' }))]));
    drawForm();
    return { body, f, kind };
  };
  const add = addForm();
  const jsonIn = h('textarea', { rows: 4, spellcheck: false, placeholder: '{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "…"] } } }' });
  jsonIn.addEventListener('keydown', e => e.stopPropagation());
  const splitArgs = s => (s.match(/"[^"]*"|\S+/g) || []).map(a => a.replace(/^"|"$/g, ''));
  box.append(
    head('Коннекторы MCP'),
    hint('Внешние инструменты для агента (Model Context Protocol): файловые системы, базы, браузер, GitHub… В AI Chat их можно включать для каждого диалога (правая панель → Коннекторы). Вызовы спрашивают разрешение, как запись файлов.'),
    listEl,
    head('Добавить сервер'), card(add.body, h('div.st-btns', {}, h('button.ui-btn.secondary', { onclick: async () => {
      const f = add.f;
      if (!/^[\w-]+$/.test(f.name)) return log('warn', 'MCP: имя — латиница, цифры, - _');
      const c = add.kind.v === 'http' ? { url: f.url.trim() } : { command: f.command.trim(), args: splitArgs(f.args),
        env: Object.fromEntries(f.env.split(';').map(x => x.trim()).filter(Boolean).map(x => [x.split('=')[0].trim(), x.slice(x.indexOf('=') + 1).trim()])) };
      await apply();
      try { st = await api('/api/mcp/import', { text: JSON.stringify({ mcpServers: { [f.name]: c } }) }); draw(); log('ok', `MCP: добавлен ${f.name}`); }
      catch (e) { log('error', `MCP: ${e.message}`); }
    } }, icon('add', { size: 16 }), 'Добавить'))),
    head('Импорт JSON'), card(jsonIn, h('div.st-btns', {}, h('button.ui-btn.secondary', { onclick: async () => {
      await apply();
      try { st = await api('/api/mcp/import', { text: jsonIn.value }); jsonIn.value = ''; draw(); log('ok', 'MCP: серверы импортированы'); }
      catch (e) { log('error', `MCP: ${e.message}`); }
    } }, 'Импортировать'))));
  draw();
  async function apply() {
    if (!dirty) return true;
    try {
      const cur = await api('/api/mcp/config');
      for (const [n, e] of Object.entries(edits)) { if (e === null) delete cur[n]; else if (cur[n]) Object.assign(cur[n], e); }
      st = await api('/api/mcp', { servers: cur });
      for (const k of Object.keys(edits)) delete edits[k];
      dirty = false; draw(); emit('mcp-changed');
      return true;
    } catch (e) { log('error', `MCP: ${e.message}`); return false; }
  }
  return { el: box, apply };
}

async function chatPanel() {
  let recent = await api('/api/agent/projects');
  const listEl = h('div.st-proj');
  const draw = () => listEl.replaceChildren(...recent.map(r => h('div.st-proj-it', {},
    icon(r.app ? 'ai' : 'folder', { size: 16 }), h('b', {}, r.name), h('span.st-dim', {}, r.path), h('span.grow'),
    r.exists ? null : h('span.st-err', {}, 'нет папки'),
    r.app ? h('span.st-badge', {}, 'maistep') : h('div.ui-tb', {}, h('button.b', { 'data-tip': 'Убрать из списка (папка остаётся)', onclick: async () => { recent = await api('/api/agent/projects', { remove: r.path }); draw(); } }, icon('closeSmall', { size: 16 }))))));
  draw();
  return {
    el: h('div', {},
      head('Папки проектов'),
      hint('Недавние папки режима Code. Агент получает доступ только к папке своего диалога и к папкам, которые вы дадите ему в правой панели чата («Доступ»).'),
      listEl,
      h('div.st-btns', {}, h('button.ui-btn.secondary', { onclick: async () => { const p = await pickFolder({ title: 'Добавить папку проекта' }); if (p) { recent = await api('/api/agent/projects', { add: p }); draw(); } } }, icon('add', { size: 16 }), 'Добавить папку…')),
      head('Среды'),
      card(h('div.st-env', {},
        h('div', {}, icon('ai', { size: 16 }), h('b', {}, 'Agent'), h('span', {}, ' — только программа: графы, картинки, ImageNaizer, интернет, управление окном. Файлов ПК не видит.')),
        h('div', {}, icon('code', { size: 16 }), h('b', {}, 'Code'), h('span', {}, ' — помощник программиста в выбранной папке: читает и правит файлы, запускает команды и тесты, видит git.')),
        h('div', {}, icon('profile', { size: 16 }), h('b', {}, 'RP'), h('span', {}, ' — ролевой чат с персонажами и их фото.'))))),
    apply: () => true,
  };
}

async function perf() {
  const cur = await api('/api/limits');
  return {
    el: h('div', {},
      head('Лимиты'),
      hint('Сохраняются сразу, когда ползунок отпущен. Защищают систему от зависания на больших картинках.'),
      card(limitsBox(cur)),
      head('Логи'),
      h('div.st-btns', {},
        h('button.ui-btn.secondary', { onclick: openLogs }, icon('folder', { size: 16 }), 'Открыть папку логов'),
        h('button.ui-btn.secondary', { onclick: logsReport }, 'Собрать отчёт об ошибке'))),
    apply: () => true,
  };
}

async function civitai() {
  const c = await api('/api/civitai/settings').catch(() => ({}));
  const v = { connections: c.connections || 4, concurrent: c.concurrent || 1, speed_limit: c.speed_limit || 0, verify: c.verify !== false, preview: c.preview !== false };
  let key = '', dirty = false;
  const set = (k, x) => { v[k] = x; dirty = true; };
  return {
    el: h('div', {},
      head('Civitai'),
      row('Ключ API', input('', x => { key = x; dirty = true; }, { type: 'password', placeholder: c.has_key ? `сейчас ${c.api_key}` : 'civitai.com → Account → API Keys' })),
      row('Соединений на файл', input(v.connections, x => set('connections', Math.max(1, Math.min(16, x | 0))), { type: 'number', width: 90 }), '1–16'),
      row('Одновременных загрузок', input(v.concurrent, x => set('concurrent', Math.max(1, Math.min(4, x | 0))), { type: 'number', width: 90 }), '1–4'),
      row('Предел скорости, МБ/с', input(v.speed_limit, x => set('speed_limit', Math.max(0, +x || 0)), { type: 'number', width: 90 }), '0 — без ограничения; на все загрузки вместе.'),
      row('Проверять SHA256', onOff(v.verify, x => set('verify', x))),
      row('Сохранять превью', onOff(v.preview, x => set('preview', x)), 'Картинка рядом с моделью — видна в Models.')),
    apply: async () => {
      if (!dirty) return true;
      try { await api('/api/civitai/settings', key ? { ...v, api_key: key } : v); dirty = false; emit('civitai-settings'); return true; }
      catch (e) { log('error', `Civitai: ${e.message}`); return false; }
    },
  };
}

const BUILD = { general, providers: providersPanel, llama, mcp: mcpPanel, chat: chatPanel, perf, civitai };
const NEEDS_SERVER = new Set(['providers', 'llama', 'mcp', 'chat', 'perf', 'civitai']);

// ---------- окно ----------
let open_ = null;
export async function openSettings(section = 'general') {
  if (open_) { open_.go(section); return; }
  const built = new Map();
  let cur = null, q = '';
  const nav = h('div.st-nav'), body = h('div.st-body');
  const close = () => { bg.remove(); open_ = null; };
  async function go(id) {
    cur = id;
    drawNav();
    if (NEEDS_SERVER.has(id) && !S.server.running) { body.replaceChildren(hint('Этот раздел хранит Python-сервер — запустите его (F5).')); return; }
    if (!built.has(id)) {
      body.replaceChildren(h('div.st-hint', {}, 'загрузка…'));
      try { built.set(id, await BUILD[id]()); } catch (e) { body.replaceChildren(h('div.st-err', {}, `${SECTIONS.find(s => s[0] === id)[1]}: ${e.message}`)); return; }
    }
    if (cur === id) body.replaceChildren(h('div.st-crumb', {}, 'Настройки  ›  ', h('b', {}, SECTIONS.find(s => s[0] === id)[1])), built.get(id).el);
  }
  function drawNav() {
    nav.replaceChildren(...SECTIONS.filter(([, t]) => !q || t.toLowerCase().includes(q)).map(([id, t, ic]) =>
      h(`div.opt${id === cur ? '.sel' : ''}`, { onclick: () => go(id) }, icon(ic, { size: 16 }), h('span', {}, t))));
  }
  async function applyAll() {
    let ok = true;
    for (const p of built.values()) ok = (await p.apply()) !== false && ok;
    return ok;
  }
  const dlg = h('div.ui-dialog.st-dlg', { onkeydown: e => { e.stopPropagation(); if (e.key === 'Escape') close(); } },
    h('div.ttl', {}, 'Настройки', h('span.x', { onclick: close }, icon('close', { size: 16 }))),
    h('div.st-grid', {},
      h('div.st-left', {}, search({ placeholder: 'Поиск раздела', onInput: v => { q = v.toLowerCase(); drawNav(); } }), h('div.ui-list.st-navw', {}, nav)),
      body),
    h('div.ft', {}, h('span.st-dim', {}, 'user/settings.json · ключи хранятся только на этом ПК'), h('span.grow'),
      h('button.ui-btn.secondary', { onclick: close }, 'Отмена'),
      h('button.ui-btn.secondary', { onclick: () => applyAll() }, 'Применить'),
      h('button.ui-btn.primary', { onclick: async () => { if (await applyAll()) close(); } }, 'OK')));
  const bg = h('div.modal-bg', { onmousedown: e => { if (e.target === bg) close(); } }, dlg);
  document.body.append(bg);
  open_ = { go };
  go(section);
}
