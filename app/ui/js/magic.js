// Magic KSampler: параметры сэмплинга под чекпоинт выше по входу model (server/maistep/magic.py, /api/magic).
// LoRA на параметры не влияет — только совместимость и подсказки. Рекомендация хранится в самой ноде
// (n.magic = { key, rec, profile }) и ставится в виджеты сразу; значения можно менять руками. При смене
// чекпоинта/LoRA новые рекомендации заменяют только нетронутые значения; «Сбросить» возвращает все.
// Подстановка — без записи в отмену: Ctrl+Z смены модели откатывает и её параметры.
import { S, on, emit, doc, edit } from './store.js';
import { api } from './backend.js';
import { debounce } from './util.js';

export const MAGIC = 'sd.magic_ksampler';
export const MAGIC_KEYS = ['steps', 'cfg', 'sampler_name', 'scheduler'];
const recs = new Map();    // key → полная рекомендация (notes, source, loras…)
const loading = new Map(); // key → Promise
const failed = new Map();  // key → ошибка

const val = (n, k) => n.props?.[k] ?? S.nodes[n.type]?.inputs?.[k]?.default;
const RULE = 'ckpt-only-1';  // версия правила: старые рекомендации (с параметрами от LoRA) пересчитываются
export const keyOf = src => JSON.stringify([RULE, src]);

// чекпоинт и LoRA выше по входу model (через любые ноды с входом MODEL); выключенная нода обрывает цепочку
export function magicSources(d, n) {
  const byId = new Map(d.data.nodes.map(x => [x.id, x]));
  const link = (id, inp) => d.data.links.find(l => l.to === id && l.in === inp);
  const loras = [];
  let ckpt = null, cur = link(n.id, 'model');
  for (let guard = 0; cur && guard < 64; guard++) {
    const x = byId.get(cur.from);
    if (!x || x.mode === 'mute') break;
    if (x.type === 'sd.checkpoint') { ckpt = val(x, 'ckpt_name') || null; break; }
    if (x.type === 'sd.lora') {
      const name = val(x, 'lora_name'), s = Number(val(x, 'strength_model')) || 0;
      if (name && s) loras.unshift([name, s]);
    }
    const k = Object.entries(S.nodes[x.type]?.inputs || {}).find(([, i]) => i.type === 'MODEL')?.[0];
    cur = k ? link(x.id, k) : null;
  }
  return { ckpt, loras };
}

export function fetchRec(src, refresh = false) {
  const key = keyOf(src);
  if (!refresh && recs.has(key)) return Promise.resolve(recs.get(key));
  if (!refresh && loading.has(key)) return loading.get(key);
  const pr = api(`/api/magic?ckpt=${encodeURIComponent(src.ckpt || '')}&loras=${encodeURIComponent(JSON.stringify(src.loras))}${refresh ? '&refresh=1' : ''}`)
    .then(r => { recs.set(key, r); failed.delete(key); return r; })
    .catch(e => { failed.set(key, e.message); return null; })
    .finally(() => { loading.delete(key); emit('magic', key); });
  loading.set(key, pr);
  emit('magic', key);
  return pr;
}

// состояние для ноды на холсте и в Inspector
export function magicState(d, n) {
  const src = magicSources(d, n), key = keyOf(src);
  const rec = n.magic?.key === key ? n.magic.rec : null;
  const changed = rec ? MAGIC_KEYS.filter(k => String(val(n, k)) !== String(rec[k])) : [];
  return { src, key, rec, changed, profile: n.magic?.key === key ? n.magic.profile : null, full: recs.get(key) || null,
    loading: loading.has(key), error: failed.get(key) || (recs.get(key)?.ok === false ? recs.get(key).error : null) };
}

export const isMagicChanged = (n, k) => !!n.magic?.rec && MAGIC_KEYS.includes(k) && String(val(n, k)) !== String(n.magic.rec[k]);

// подстановка: тронутые руками значения (≠ прежней рекомендации) остаются
function apply(d, id, key, r) {
  const n = d.data.nodes.find(x => x.id === id);
  if (!n || n.magic?.key === key || !r?.ok) return;
  n.props ||= {};
  for (const k of MAGIC_KEYS) {
    const old = n.magic?.rec?.[k];
    if (old === undefined || String(val(n, k)) === String(old)) n.props[k] = r.params[k];
  }
  n.magic = { key, rec: { ...r.params }, profile: r.profile };
  d.dirty = true;
  emit('change', { kind: 'workflow', id: d.id, magic: true });
}

async function sync(d) {
  if (!d || !S.server.running) return;
  for (const n of d.data.nodes) {
    if (n.type !== MAGIC) continue;
    const src = magicSources(d, n), key = keyOf(src);
    if (!src.ckpt || n.magic?.key === key || failed.has(key)) continue;
    const r = await fetchRec(src);
    if (r) apply(doc('workflow', d.id), n.id, key, r);
  }
}

export function resetMagic(docId, id) {
  const d = doc('workflow', docId), n = d?.data.nodes.find(x => x.id === id);
  if (!n?.magic?.rec) return;
  edit('workflow', docId, wf => { const nn = wf.nodes.find(z => z.id === id); nn.props ||= {}; Object.assign(nn.props, nn.magic.rec); }, { label: 'Magic KSampler: сбросить' });
}

export async function refreshMagic(docId, id) {
  const d = doc('workflow', docId), n = d?.data.nodes.find(x => x.id === id);
  if (!n) return;
  const src = magicSources(d, n), key = keyOf(src);
  failed.delete(key);
  const r = await fetchRec(src, true);
  if (!r?.ok) return;
  edit('workflow', docId, wf => {
    const nn = wf.nodes.find(z => z.id === id);
    nn.props ||= {};
    Object.assign(nn.props, r.params);
    nn.magic = { key, rec: { ...r.params }, profile: r.profile };
  }, { label: 'Magic KSampler: подобрать заново' });
}

export function initMagic() {
  const run = debounce(() => sync(doc('workflow', S.current.workflow)), 250);
  on('change', e => { if ((!e.kind || e.kind === 'workflow') && !e.magic) run(); });
  on('current', run);
  on('project', run);
  on('nodes', run);
  on('server', s => { if (s.running) { failed.clear(); setTimeout(run, 1200); } });
  on('library', () => { recs.clear(); failed.clear(); });
}
