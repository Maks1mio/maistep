// Запоминание состояния редактора между запусками и автосохранение воркфлоу.
// Помнится: открытый воркфлоу, выделение (нода / модель / компонент), включено ли автосохранение, последние
// результаты нод (картинки и тексты на графе — 'maistep-outputs'; чего нет — добирается из истории сервера).
// Остальное помнят сами модули: раскладки (dock.js), пан/зум графов (graph.js), фильтры Models, Civitai,
// Project, Компонентов — всё в localStorage. Автосохранение — через 1,2 с после последней правки воркфлоу.
import { S, on, emit, dirtyDocs, save, select } from './store.js';
import { debounce } from './util.js';
import { history } from './backend.js';

const KEY = 'maistep-ui';
const st = (() => { try { return { autosave: true, ...JSON.parse(localStorage.getItem(KEY)) }; } catch { return { autosave: true }; } })();
const keep = () => { try { localStorage.setItem(KEY, JSON.stringify(st)); } catch {} };

export const autosaveOn = () => !!st.autosave;
export function setAutosave(v) {
  st.autosave = !!v; keep();
  emit('status', `Автосохранение ${st.autosave ? 'включено' : 'выключено'}`);
  emit('autosave', st.autosave);
  if (st.autosave) autosave();
}

let saving = false;
const autosave = debounce(async () => {
  if (!st.autosave || saving) return;
  const list = dirtyDocs();
  if (!list.length) return;
  saving = true;
  try {
    for (const d of list) await save(d, { quiet: true });
    emit('status', `Автосохранено: ${list.map(d => d.id).join(', ')} · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    emit('log', { src: 'editor', level: 'error', text: `автосохранение: ${e}` });
  } finally {
    saving = false;
    if (dirtyDocs().length) autosave();
  }
}, 1200);

// ---------- результаты нод ----------
const OUT_KEY = 'maistep-outputs';
// длинные тексты режем — localStorage небольшой; картинки — только пути
const slim = v => (typeof v === 'string' && v.length > 6000 ? `${v.slice(0, 6000)}…` : v && typeof v === 'object' ? (Array.isArray(v) ? v.map(slim) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, slim(x)]))) : v);
const keepOutputs = debounce(() => {
  const data = Object.fromEntries(Object.entries(S.outputs).filter(([wf, o]) => S.docs.workflow.has(wf) && o && Object.keys(o).length).map(([wf, o]) => [wf, slim(o)]));
  try { localStorage.setItem(OUT_KEY, JSON.stringify(data)); } catch {}
}, 800);
function restoreOutputs() {
  let data = {};
  try { data = JSON.parse(localStorage.getItem(OUT_KEY)) || {}; } catch {}
  for (const [wf, o] of Object.entries(data)) if (!S.outputs[wf] || !Object.keys(S.outputs[wf]).length) S.outputs[wf] = o;
}
// воркфлоу без сохранённых результатов — последний удачный запуск из истории сервера (она хранится в user/history.json)
let fromHistory = false;
async function outputsFromHistory() {
  if (fromHistory) return;
  fromHistory = true;
  try {
    let changed = false;
    for (const it of [...await history(200)].reverse()) {
      const wf = it.workflow?.id;
      if (!wf || !it.ok || !S.docs.workflow.has(wf) || !it.outputs) continue;
      if (S.outputs[wf] && Object.keys(S.outputs[wf]).length && !S.outputs[wf]._fromHistory) continue;
      S.outputs[wf] = { ...(S.outputs[wf] || {}), ...it.outputs, _fromHistory: true };
      changed = true;
    }
    for (const o of Object.values(S.outputs)) delete o._fromHistory;
    if (changed) { S.outputsStamp = Date.now(); emit('change', { kind: null }); keepOutputs(); }
  } catch { fromHistory = false; }
}

// после загрузки проекта: вернуть открытый воркфлоу и выделение
export function restore() {
  restoreOutputs();
  if (st.wf && S.docs.workflow.has(st.wf) && S.current.workflow !== st.wf) {
    S.current.workflow = st.wf;
    emit('current', 'workflow');
  }
  const s = st.sel;
  if (!s) return;
  if ((s.kind === 'node' || s.kind === 'workflow') && s.doc !== S.current.workflow) return;
  if (s.kind === 'node' && !S.docs.workflow.get(s.doc)?.data.nodes.some(n => n.id === s.id)) return;
  select(s);
}

export function initPersist() {
  on('change', e => { if (e.kind === 'workflow') autosave(); });
  on('run-output', keepOutputs);
  on('run-error', keepOutputs);
  on('server', s => { if (s.running) setTimeout(outputsFromHistory, 1500); });
  on('current', k => { if (k === 'workflow') { st.wf = S.current.workflow; keep(); } });
  on('select', s => {
    // запоминаем только то, что можно восстановить без сети
    st.sel = s && ['node', 'workflow', 'libmodel', 'component'].includes(s.kind) ? s : st.sel && !s ? null : st.sel;
    if (S.current.workflow) st.wf = S.current.workflow;
    keep();
  });
  // закрытие окна — дописать несохранённое
  addEventListener('beforeunload', () => { if (st.autosave && dirtyDocs().length) for (const d of dirtyDocs()) save(d, { quiet: true }); });
}
