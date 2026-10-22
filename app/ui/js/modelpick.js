// Выбор модели LLM: попап с поиском по каталогу провайдера (/api/models), группы по компаниям, значки —
// 👁 принимает картинки, 🧠 рассуждает, контекст и множитель цены. Открывается из ноды (щелчок по виджету model)
// и из Inspector. ↑↓ Enter — выбор, Esc — закрыть.
import { h } from './util.js';
import { S } from './store.js';
import { icon } from './icons.js';
import { getModels } from './backend.js';

let pop = null;
export const closeModelPicker = () => { pop?.remove(); pop = null; };

const fmtCtx = n => (!n ? '' : n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}K`);

export function badges(m) {
  return [
    m.vision ? h('span.mbadge.v', { 'data-tip': 'принимает картинки' }, '👁') : null,
    m.reasoning ? h('span.mbadge.r', { 'data-tip': 'рассуждает (reasoning)' }, '🧠') : null,
    m.context ? h('span.mbadge', { 'data-tip': 'контекст, токенов' }, fmtCtx(m.context)) : null,
    m.multiplier != null ? h('span.mbadge.x', { 'data-tip': 'множитель цены провайдера' }, `×${m.multiplier}`) : null,
  ];
}

// at — { clientX, clientY } или элемент-якорь; onPick(id)
export function modelPicker(at, { provider, value, onPick }) {
  closeModelPicker();
  let list = [], idx = 0, onlyVision = false, onlyReason = false;
  const input = h('input', { placeholder: `Модель ${provider}…`, spellcheck: false });
  const box = h('div.gsearch.mlist');
  const info = h('span.dim');
  const chip = (label, tip, get, set) => h(`button.mchip${get() ? '.on' : ''}`, { 'data-tip': tip, onclick: e => { set(!get()); e.currentTarget.classList.toggle('on', get()); fill(); input.focus(); } }, label);
  const refresh = h('button.icon', { 'data-tip': 'Обновить каталог', onclick: () => load(true) }, icon('refresh', { size: 14 }));
  pop = h('div.gfloat.mpick', { onpointerdown: e => e.stopPropagation() },
    h('div.row', {}, input, refresh),
    h('div.row.mfilters', {}, chip('👁 картинки', 'только модели с картинками на входе', () => onlyVision, v => { onlyVision = v; }),
      chip('🧠 reasoning', 'только рассуждающие', () => onlyReason, v => { onlyReason = v; }), h('span.grow'), info),
    box);

  const pick = m => { closeModelPicker(); onPick(m.id); };
  function fill() {
    const all = S.models[provider]?.models || [];
    const q = input.value.toLowerCase().split(/\s+/).filter(Boolean);
    list = all.filter(m => (!onlyVision || m.vision) && (!onlyReason || m.reasoning) && q.every(w => `${m.id} ${m.name} ${m.company} ${m.series}`.toLowerCase().includes(w)));
    idx = Math.max(0, list.findIndex(m => m.id === value));
    info.textContent = all.length ? `${list.length} из ${all.length}` : '';
    if (!all.length) {
      const err = S.models[provider]?.error;
      box.replaceChildren(h('div.dim', { style: { padding: '8px' } }, err ? `каталог недоступен: ${err}` : 'загрузка каталога…'));
      return;
    }
    let company = null;
    const rows = [];
    list.forEach((m, i) => {
      if (m.company !== company) { company = m.company; rows.push(h('div.grp', {}, company || '—')); }
      rows.push(h(`div.it${i === idx ? '.on' : ''}${m.id === value ? '.cur' : ''}`, { 'data-i': i, onmousedown: e => { e.preventDefault(); pick(m); } },
        h('span.mn', {}, m.name.replace(/^[^·]*·\s*/, '')), h('span.dim.mid', {}, m.id), h('span.grow'), ...badges(m)));
    });
    box.replaceChildren(...rows);
    box.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' });
  }
  const move = d => {
    if (!list.length) return;
    idx = (idx + d + list.length) % list.length;
    box.querySelectorAll('.it').forEach(x => x.classList.toggle('on', +x.dataset.i === idx));
    box.querySelector('.it.on')?.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('input', () => { fill(); idx = 0; move(0); });
  input.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    if (e.key === 'Enter' && list[idx]) pick(list[idx]);
    if (e.key === 'Escape') closeModelPicker();
  });
  async function load(force) {
    if (force) { box.replaceChildren(h('div.dim', { style: { padding: '8px' } }, 'обновление каталога…')); }
    await getModels(provider, force);
    if (pop) fill();
  }

  document.body.append(pop);
  // якорь запоминаем сразу: Inspector может перерисоваться (пришёл каталог), и элемент уйдёт из DOM
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.clientX, bottom: at.clientY };
  const place = () => {
    if (!pop) return;
    pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.max(4, Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8))}px`;
  };
  const fill0 = fill;
  fill = () => { fill0(); place(); };
  fill();
  load(false);
  input.focus();
  const off = e => { if (pop && !pop.contains(e.target)) { closeModelPicker(); removeEventListener('pointerdown', off, true); } };
  setTimeout(() => addEventListener('pointerdown', off, true));
}
