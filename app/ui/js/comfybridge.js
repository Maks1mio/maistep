// Мост к ComfyUI в интерфейсе: статус ComfyUI (попап сервера, Inspector нод ComfyUI), запуск Comfy Desktop по кнопке,
// выбор сохранённого воркфлоу (comfyWorkflowPicker) и подсказки привязок для ноды «Воркфлоу ComfyUI»:
// поля воркфлоу (id.поле = значение) с кнопками a–d — они дописывают строку «a → id.поле» в bindings.
import { h } from './util.js';
import { S, emit } from './store.js';
import { icon } from './icons.js';
import { api } from './backend.js';

const log = (level, text) => emit('log', { src: 'editor', level, text });
let statusCache = null, statusAt = 0;

export async function comfyStatus(force = false) {
  if (!S.server.running) return null;
  if (!force && statusCache && Date.now() - statusAt < 5000) return statusCache;
  try { statusCache = await api('/api/comfy/status'); statusAt = Date.now(); } catch { statusCache = null; }
  return statusCache;
}

export async function launchComfy() {
  try { await api('/api/comfy/launch', {}); log('info', 'Comfy Desktop запускается — подождите, пока поднимется сервер :8188'); }
  catch (e) { log('error', `Comfy Desktop: ${e.message}`); }
}

// строка статуса: ● ComfyUI 0.40 · GPU — или «не запущен» + кнопка запуска
export function statusRow(st) {
  if (!st) return h('div.cstat', {}, h('span.pdot'), h('span.dim', {}, 'ComfyUI: нет данных (сервер maistep не запущен)'));
  if (st.ok) {
    const free = st.vram_free ? ` · VRAM свободно ${(st.vram_free / 2 ** 30).toFixed(1)} из ${(st.vram_total / 2 ** 30).toFixed(1)} ГБ` : '';
    return h('div.cstat', {}, h('span.pdot.on'), h('span', {}, `ComfyUI ${st.version} · ${st.gpu}${free}`),
      st.running || st.pending ? h('span.dim', {}, ` · очередь ${st.running + st.pending}`) : null);
  }
  return h('div.cstat', {}, h('span.pdot'), h('span', {}, `ComfyUI не запущен (${st.url})`),
    st.desktop ? h('button', { onclick: launchComfy }, icon('play', { size: 14 }), 'Запустить Comfy Desktop') : null);
}

// ---------- выбор воркфлоу ----------
let pop = null;
const close = () => { pop?.remove(); pop = null; };

export async function comfyWorkflowPicker(at, { value, onPick }) {
  close();
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.clientX, bottom: at.clientY };
  const list = h('div.gsearch');
  pop = h('div.gfloat', { onpointerdown: e => e.stopPropagation() }, h('div.dim', { style: { padding: '2px 4px 6px' } }, 'Воркфлоу ComfyUI'), list);
  document.body.append(pop);
  const place = () => { if (!pop) return; pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`; pop.style.top = `${Math.max(4, Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8))}px`; };
  place();
  let items = [];
  try { items = await api('/api/comfy/workflows'); } catch (e) { list.replaceChildren(h('div.dim', {}, e.message)); return place(); }
  let src = null;
  const rows = [];
  for (const w of items) {
    if (w.source !== src) { src = w.source; rows.push(h('div.grp', { style: { padding: '6px 8px 2px', color: 'var(--dim)', fontSize: '11px' } }, src === 'ComfyUI' ? 'ComfyUI (user/default/workflows)' : 'maistep (comfy_workflows/)')); }
    rows.push(h(`div.it${w.id === value ? '.on' : ''}`, { onmousedown: e => { e.preventDefault(); close(); onPick(w.id); } }, icon('blueprint', { size: 14 }), h('span', {}, w.name)));
  }
  list.replaceChildren(...(rows.length ? rows : [h('div.dim', { style: { padding: '8px' } }, 'нет сохранённых воркфлоу')]));
  place();
  const off = e => { if (pop && !pop.contains(e.target)) { close(); removeEventListener('pointerdown', off, true); } };
  setTimeout(() => addEventListener('pointerdown', off, true));
}

// ---------- Inspector: поля воркфлоу для привязок ----------
const inspected = new Map(); // id → { widgets, notes } | { error }

export function bindingsHelper(wid, getBindings, setBindings) {
  const box = h('div.cbind');
  if (!wid) return box;
  const render = info => {
    if (info.error) { box.replaceChildren(h('div.hint', { style: { color: 'var(--err)' } }, info.error)); return; }
    const q = h('input', { placeholder: 'Фильтр полей: text, seed, ckpt…', spellcheck: false });
    const rows = h('div.cbrows');
    const fill = () => {
      const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
      const used = getBindings();
      rows.replaceChildren(...info.widgets.filter(w => words.every(x => `${w.key} ${w.title} ${w.class_type} ${w.value}`.toLowerCase().includes(x))).slice(0, 200).map(w => {
        const bound = [...used.matchAll(/^\s*([a-d])\s*(?:→|->|=)\s*(\S+)\s*$/gm)].find(m => m[2] === w.key)?.[1];
        return h(`div.cb${bound ? '.on' : ''}`, {},
          h('div.cbk', {}, h('b', {}, w.key), h('span.dim', {}, ` ${w.title}`)),
          h('div.cbv', { 'data-tip': String(w.value) }, String(w.value).slice(0, 90)),
          h('div.cbb', {}, ...['a', 'b', 'c', 'd'].map(s => h(`button${bound === s ? '.on' : ''}`, {
            'data-tip': bound === s ? 'Убрать привязку' : `Подставлять вход ${s} в ${w.key}`,
            onclick: () => {
              let lines = getBindings().split('\n').filter(l => l.trim() && !new RegExp(`(→|->|=)\\s*${w.key.replace('.', '\\.')}\\s*$`).test(l));
              if (bound !== s) lines.push(`${s} → ${w.key}`);
              setBindings(lines.join('\n'));
            },
          }, s))));
      }));
    };
    q.addEventListener('input', fill);
    q.addEventListener('keydown', e => e.stopPropagation());
    box.replaceChildren(h('h4', {}, `Поля воркфлоу (${info.widgets.length}) — привязать вход`), ...(info.notes || []).map(n => h('div.hint', {}, n)), q, rows);
    fill();
  };
  if (inspected.has(wid)) render(inspected.get(wid));
  else {
    box.append(h('div.dim', {}, 'разбор воркфлоу…'));
    api(`/api/comfy/inspect?id=${encodeURIComponent(wid)}`).then(r => { inspected.set(wid, r); render(r); })
      .catch(e => { const r = { error: e.data?.error || e.message }; inspected.set(wid, r); render(r); });
  }
  return box;
}
export const forgetInspected = () => inspected.clear();
