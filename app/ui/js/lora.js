// Триггер-слова LoRA (trained из карточки библиотеки): показываются под нодой Load LoRA (graph.js) и в Inspector —
// щелчок копирует. В промпт сами не дописываются: что и куда вставить, решает пользователь.
import { emit } from './store.js';
import { libraryItem, loadLibrary } from './library.js';

let asked = false;

// слова LoRA по имени файла; библиотека ещё не загружена — грузим один раз (по событию 'library' граф перерисуется)
export function loraTriggers(name) {
  if (!name) return [];
  const it = libraryItem(name);
  if (!it && !asked) { asked = true; loadLibrary(); }
  const seen = new Set();
  return (it?.trained || []).flatMap(t => splitTop(String(t))).map(t => t.trim())
    .filter(t => t && !seen.has(t.toLowerCase()) && seen.add(t.toLowerCase()));
}

// «a, (b, c), d» → ['a', '(b, c)', 'd']: запятые внутри скобок — часть одного тега
function splitTop(s) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    if (ch === ',' && !depth) { out.push(cur); cur = ''; } else cur += ch;
  }
  return [...out, cur];
}

export function copyTriggers(text) {
  navigator.clipboard?.writeText(text).then(
    () => emit('log', { src: 'editor', level: 'ok', text: `скопировано: ${text}` }),
    e => emit('log', { src: 'editor', level: 'error', text: `копирование: ${e.message}` }));
}
