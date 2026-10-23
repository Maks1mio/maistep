// Триггер-слова LoRA: при добавлении/выборе LoRA автоматически дописываются в положительный промпт.
// Положительный CLIP Text Encode ищется по связи в sampler.positive, иначе по названию ноды.
import { doc, edit, emit } from './store.js';
import { libraryItem, loadLibrary } from './library.js';

const normTag = s => String(s || '')
  .trim()
  .replace(/^\(+/, '').replace(/\)+$/, '')
  .replace(/:\s*-?\d+(?:\.\d+)?$/, '')
  .replace(/_/g, ' ')
  .replace(/\s+/g, ' ')
  .toLowerCase();

export function positivePromptNode(wf) {
  const texts = (wf.nodes || []).filter(n => n.type === 'sd.text_encode');
  if (!texts.length) return null;
  const fromPositive = new Set((wf.links || []).filter(l => l.in === 'positive').map(l => l.from));
  const traced = texts.find(n => fromPositive.has(n.id));
  if (traced) return traced;
  const isNeg = n => /negative|негатив/i.test(n.title || '');
  const titled = texts.find(n => /positive|позитив/i.test(n.title || '') && !isNeg(n));
  return titled || texts.find(n => !isNeg(n)) || null;
}

export function appendTriggers(wf, triggers) {
  const node = positivePromptNode(wf);
  if (!node) return { added: [], linked: false };
  if ((wf.links || []).some(l => l.to === node.id && l.in === 'text')) return { added: [], linked: true };
  const words = (triggers || []).flatMap(t => String(t).split(',')).map(t => t.trim()).filter(Boolean);
  if (!words.length) return { added: [], linked: false };
  const text = String(node.props?.text || '');
  const have = new Set(text.split(',').map(normTag).filter(Boolean));
  const added = [];
  for (const w of words) {
    const k = normTag(w);
    if (k && !have.has(k)) { have.add(k); added.push(w); }
  }
  if (!added.length) return { added, linked: false };
  node.props ||= {};
  node.props.text = [text.trim().replace(/,\s*$/, ''), ...added].filter(Boolean).join(', ');
  return { added, linked: false };
}

// triggers — уже известные слова (при вставке из библиотеки); иначе берём из карточки LoRA
export async function applyLoraTriggers(docId, nodeId, name, triggers = null) {
  if (!name) return [];
  const d = doc('workflow', docId);
  const n0 = d?.data.nodes.find(n => n.id === nodeId);
  if (!n0 || n0.type !== 'sd.lora' || (n0.props?.lora_name || '') !== name) return [];
  let words = triggers;
  if (!words) {
    let it = libraryItem(name);
    if (!it) { await loadLibrary(); it = libraryItem(name); }
    words = it?.trained || [];
  }
  if (!words?.length) return [];
  const pn = positivePromptNode(d.data);
  if (!pn) {
    emit('log', { src: 'editor', level: 'warn', text: `триггеры LoRA ${name}: в графе нет положительного CLIP Text Encode` });
    return [];
  }
  let added = [], linked = false;
  edit('workflow', docId, wf => {
    const n = wf.nodes.find(x => x.id === nodeId);
    if (!n || n.type !== 'sd.lora' || (n.props?.lora_name || '') !== name) return;
    ({ added, linked } = appendTriggers(wf, words));
  }, { label: `триггеры LoRA ${name}` });
  if (linked) emit('log', { src: 'editor', level: 'warn', text: `триггеры ${name} не добавлены: текст Positive приходит по связи` });
  else if (added.length) emit('log', { src: 'editor', level: 'info', text: `триггеры LoRA ${name} → Positive: ${added.join(', ')}` });
  return added;
}
