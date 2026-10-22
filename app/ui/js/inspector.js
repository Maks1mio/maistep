// Inspector: свойства выбранного объекта. Формы регистрируют модули: graph.js (нода, связь, воркфлоу),
// project.js (файл), codeedit.js (код), results.js (запуск).
import { h, debounce } from './util.js';
import { S, on } from './store.js';

const custom = new Map();
export const registerInspector = (kind, fn) => custom.set(kind, fn);

const box = () => document.getElementById('inspector');

function render() {
  const b = box();
  const s = S.sel;
  let content;
  try {
    if (!s) content = [h('div.dim', {}, 'Ничего не выбрано')];
    else if (custom.has(s.kind)) content = custom.get(s.kind)(s);
    else content = [h('div.dim', {}, `${s.kind}: ${s.id ?? ''}`)];
  } catch (e) {
    content = [h('div', { style: { color: 'var(--err)' } }, `Ошибка инспектора: ${e.message}`)];
    console.error(e);
  }
  b.replaceChildren(...content.filter(Boolean));
}

// перерисовка инспектора при внешних правках — без потери фокуса в поле, которое сейчас редактируют
const soft = debounce(() => { if (!box().contains(document.activeElement) || document.activeElement === document.body) render(); }, 60);

export function initInspector() {
  on('select', render);
  on('change', e => { if (e.undo || e.created || e.removed || !box().contains(document.activeElement)) render(); else soft(); });
  on('project', render);
  on('nodes', render);
  on('run-output', soft);
  on('run-stream', () => { if (S.sel?.kind === 'node') soft(); });
  on('run-error', soft);
  on('models', soft);
}
export const refreshInspector = render;
