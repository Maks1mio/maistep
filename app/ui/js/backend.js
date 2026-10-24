// Связь с Python-сервером исполнения (server/main.py): каталог нод, очередь запусков, события SSE.
// События сервера пересылаются в шину store: run-start, run-node, run-progress, run-preview, run-stream, run-output, run-error, run-done,
// queue, nodes; запуск текущего воркфлоу — queuePrompt().
import { S, on, emit, doc } from './store.js';

const NODES_KEY = 'maistep-nodes'; // последний каталог — чтобы граф рисовался и при выключенном сервере
const base = () => `http://localhost:${S.server.port}`;
const log = (level, text) => emit('log', { src: 'run', level, text });
let es = null, retry = 0;

export const fileUrl = file => `${base()}/view?file=${encodeURIComponent(file)}&t=${S.outputsStamp || 0}`;

export async function api(path, body) {
  const r = await fetch(`${base()}${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error(j?.error || `HTTP ${r.status}`); e.data = j; throw e; }
  return j;
}

export async function fetchNodes() {
  try {
    S.nodes = await api('/api/nodes');
    try { localStorage.setItem(NODES_KEY, JSON.stringify(S.nodes)); } catch {}
    emit('nodes', S.nodes);
    return true;
  } catch { return false; }
}

function cachedNodes() {
  try { S.nodes = JSON.parse(localStorage.getItem(NODES_KEY)) || {}; } catch { S.nodes = {}; }
}

// очередь и запуски — по prompt_id; какому воркфлоу принадлежит запуск, помним сами
const runs = new Map(); // prompt_id → workflow id

function connect() {
  es?.close();
  es = new EventSource(`${base()}/events`);
  // у EventSource есть и родное событие error (обрыв связи) — без data, его здесь не разбираем
  const ev = (name, fn) => es.addEventListener(name, e => { if (e.data != null) fn(JSON.parse(e.data)); });
  es.onopen = () => { retry = 0; fetchNodes(); };
  es.onerror = () => {
    es.close(); es = null;
    if (!S.server.running) return;
    setTimeout(() => S.server.running && !es && connect(), Math.min(5000, 400 * ++retry));
  };
  ev('status', q => { S.queue = q; emit('queue', q); });
  ev('nodes', () => { fetchNodes(); log('info', 'ноды перезагружены'); });
  ev('start', d => {
    // запуск не из этого окна (AI Agent, другое окно) — воркфлоу приходит в событии
    const wf = runs.get(d.prompt_id) ?? d.wf ?? null;
    if (wf) runs.set(d.prompt_id, wf);
    S.run = { prompt_id: d.prompt_id, wf, node: null, progress: null, stream: {}, preview: {}, t0: Date.now() };
    if (wf) S.outputs[wf] = {};
    emit('run-start', S.run);
  });
  ev('executing', d => { if (!S.run) return; S.run.node = d.node; S.run.progress = null; emit('run-node', d); });
  ev('progress', d => { if (!S.run) return; S.run.progress = d; emit('run-progress', d); });
  // поэтапное превью генерации (KSampler): data URL, живёт до результата ноды
  ev('preview', d => { if (!S.run) return; S.run.preview[d.node] = d; emit('run-preview', d); });
  ev('stream', d => {
    if (!S.run) return;
    S.run.stream[d.node] = (S.run.stream[d.node] || '') + d.text;
    emit('run-stream', d);
  });
  ev('executed', d => {
    const wf = runs.get(d.prompt_id);
    if (wf) (S.outputs[wf] ||= {})[d.node] = d.output;
    S.outputsStamp = Date.now();
    if (S.run) { delete S.run.stream[d.node]; delete S.run.preview[d.node]; }
    emit('run-output', { ...d, wf });
  });
  ev('log', d => log(d.level || 'info', `${d.node ? `[${d.node}] ` : ''}${d.text}`));
  ev('components', d => { S.componentsJob = d.job || null; emit('components', d); });
  ev('comp-log', d => emit('component-log', d));
  ev('update', d => emit('update', d));
  ev('civitai', d => emit('civitai', d));
  ev('agent', d => emit('agent', d));
  ev('error', d => {
    const wf = runs.get(d.prompt_id);
    if (wf && d.node) (S.outputs[wf] ||= {})[d.node] = { _error: d.message };
    log('error', `${d.node ? `нода ${d.node}: ` : ''}${d.message}`);
    emit('run-error', { ...d, wf });
  });
  ev('done', d => {
    const wf = runs.get(d.prompt_id);
    if (d.ok) log('ok', `готово${wf ? ` «${wf}»` : ''} за ${d.time} с`);
    S.run = null;
    emit('run-done', { ...d, wf });
  });
}

// targets — id нод, до которых выполнить (по умолчанию — все конечные ноды графа)
export async function queuePrompt(id = S.current.workflow, times = 1, targets = null) {
  const d = doc('workflow', id);
  if (!d) return;
  if (!S.server.running) { log('warn', 'сервер не запущен — запускаю, затем повторите запуск'); emit('server-start'); return; }
  for (let i = 0; i < times; i++) {
    // id запуска — свой: события SSE могут прийти раньше ответа на POST
    const pid = crypto.randomUUID().replace(/-/g, '');
    runs.set(pid, id);
    try {
      const r = await api('/api/prompt', { id: pid, workflow: { id, ...d.data, ...(targets ? { targets } : {}) } });
      log('info', `в очереди #${r.number}: «${d.data.title || id}»`);
    } catch (e) {
      for (const is of e.data?.issues || []) log('error', `нода ${is.node}: ${is.message}`);
      emit('run-issues', { wf: id, issues: e.data?.issues || [] });
      if (!e.data?.issues) log('error', `запуск: ${e.message}`);
      return;
    }
  }
}

// ---------- провайдеры и каталог моделей ----------
const MODELS_KEY = 'maistep-models';
S.models = (() => { try { return JSON.parse(localStorage.getItem(MODELS_KEY)) || {}; } catch { return {}; } })(); // pid → { models, at, error }
const loading = new Map();

export function getModels(pid, refresh = false) {
  if (!pid) return Promise.resolve(null);
  if (!refresh && S.models[pid]?.models?.length && Date.now() / 1000 - S.models[pid].at < 6 * 3600) return Promise.resolve(S.models[pid]);
  if (loading.has(pid) && !refresh) return loading.get(pid);
  const pr = api(`/api/models?provider=${encodeURIComponent(pid)}${refresh ? '&refresh=1' : ''}`)
    .then(r => {
      S.models[pid] = r;
      try { localStorage.setItem(MODELS_KEY, JSON.stringify(S.models)); } catch {}
      if (r.error) log('warn', `каталог моделей ${pid}: ${r.error}`);
      emit('models', pid);
      return r;
    })
    .catch(e => { log('warn', `каталог моделей ${pid}: ${e.message}`); return S.models[pid] || null; })
    .finally(() => loading.delete(pid));
  loading.set(pid, pr);
  return pr;
}

// метаданные модели из кэша (синхронно; null — неизвестно)
export const modelMeta = (pid, id) => S.models[pid]?.models?.find(m => m.id === id) || null;

export const getSettings = () => api('/api/settings');
export const saveSettings = data => api('/api/settings', data);

// ---------- компоненты и обновления ----------
export function componentsStatus({ refresh = false, deep = false } = {}) {
  const q = [];
  if (refresh) q.push('refresh=1');
  if (deep) q.push('deep=1');
  return api(`/api/components${q.length ? `?${q.join('&')}` : ''}`);
}
export const installComponents = (ids, mode = 'recommended') => api('/api/components/install', { ids, mode });
export const cancelComponents = () => api('/api/components/cancel', {});
export const updateStatus = (check = false) => api(`/api/update${check ? '?check=1' : ''}`);
export const downloadUpdate = () => api('/api/update/download', {});

export const interrupt =() => api('/api/interrupt', {}).catch(e => log('error', String(e)));
export const clearQueue = () => api('/api/queue', { clear: true }).catch(e => log('error', String(e)));
export const reloadNodes = () => api('/api/reload', {}).then(r => log('ok', `нод: ${r.count}`)).catch(e => log('error', `перезагрузка нод: ${e.message}`));
export const history = (limit = 60) => api(`/api/history?limit=${limit}&workflow=1`);
export const check = wf => api('/api/check', { workflow: wf });

export async function upload(file, dir = 'input') {
  const r = await fetch(`${base()}/api/upload?name=${encodeURIComponent(file.name)}${dir === 'output' ? '&dir=output' : ''}`, { method: 'POST', body: file });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).file;
}

export function initBackend() {
  cachedNodes();
  on('server', st => {
    if (st.running) { retry = 0; setTimeout(connect, 700); }
    else { es?.close(); es = null; S.run = null; emit('run-done', { ok: false, stopped: true }); }
  });
}
