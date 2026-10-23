// Выбор картинки graphics для поля спрайта: попап с поиском по всем ассетам (custom → game), плитки или
// столбик (выбор запоминается), подгрузка при прокрутке, большое превью при наведении. Esc — закрыть.
import { h, debounce } from './util.js';
import { S } from './store.js';
import { assetUrl } from './api.js';
import { icon } from './icons.js';
import { search } from './kit.js';

const LS = 'maistep-picker';
const pref = (() => { try { return { view: 'grid', ...JSON.parse(localStorage.getItem(LS)) }; } catch { return { view: 'grid' }; } })();
const CHUNK = 120;
let open = null;

// anchor — элемент, под которым открыть; value — текущий путь (без .png); onPick(путь от graphics с расширением)
export function assetPicker(anchor, { value = '', onPick } = {}) {
  open?.();
  let q = '', list = [], shown = 0, io = null;
  const cur = String(value || '');
  const grid = h(`div.pk-grid.${pref.view}`);
  const body = h('div.pk-body', {}, grid);
  const count = h('span.dim');
  const more = () => {
    grid.querySelector('.pj-more')?.remove();
    const next = list.slice(shown, shown + CHUNK);
    shown += next.length;
    grid.append(...next.map(a => {
      const name = a.split('/').pop();
      const sel = a.replace(/\.png$/i, '') === cur || a === cur;
      return h(`div.pk-it${sel ? '.sel' : ''}`, { 'data-tip': a, 'data-tip-img': assetUrl(a), onclick: () => { close(); onPick?.(a); } },
        h('div.th', {}, h('img', { src: assetUrl(a), loading: 'lazy', alt: '', draggable: false })),
        h('div.nm', {}, h('span.n', {}, name), pref.view === 'list' ? h('span.p', {}, a.slice(0, -name.length - 1)) : null));
    }));
    if (shown < list.length) {
      const s = h('div.pj-more', {}, `ещё ${list.length - shown}…`);
      grid.append(s);
      io?.disconnect();
      io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) more(); }, { root: body, rootMargin: '200px' });
      io.observe(s);
    }
  };
  const draw = () => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    list = words.length ? S.assets.filter(a => words.every(w => a.toLowerCase().includes(w))) : S.assets;
    // текущая папка — первой, чтобы рядом были соседние кадры
    const dir = cur.includes('/') ? cur.slice(0, cur.lastIndexOf('/') + 1) : '';
    if (dir && !words.length) list = [...list.filter(a => a.startsWith(dir)), ...list.filter(a => !a.startsWith(dir))];
    count.textContent = `${list.length} из ${S.assets.length}`;
    grid.className = `pk-grid ${pref.view}`;
    grid.replaceChildren();
    shown = 0;
    body.scrollTop = 0;
    if (!list.length) grid.append(h('div.pj-empty', {}, icon('search', { size: 16 }), 'Ничего не найдено'));
    more();
  };
  const s = search({ placeholder: 'Поиск по graphics: units kai, system/menu…', onInput: debounce(v => { q = v; draw(); }, 150) });
  s.classList.add('grow');
  const viewBtn = (v, ic, tip) => h(`button${pref.view === v ? '.on' : ''}`, { 'data-tip': tip, onclick: e => {
    pref.view = v; try { localStorage.setItem(LS, JSON.stringify(pref)); } catch {}
    e.currentTarget.parentNode.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)); draw();
  } }, icon(ic, { size: 14 }));
  const pop = h('div.ui-ddpop.pk', { onkeydown: e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } } },
    h('div.pk-top', {}, s, h('div.ui-seg', {}, viewBtn('grid', 'grid', 'Плитки'), viewBtn('list', 'general/listFiles', 'Столбик'))),
    body,
    h('div.pk-foot', {}, count, h('span.grow'), h('span.dim', {}, 'наведите — превью · щелчок — выбрать')));
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const W = Math.min(460, innerWidth - 8), H = Math.min(480, innerHeight - 8);
  pop.style.width = `${W}px`; pop.style.height = `${H}px`;
  pop.style.left = `${Math.max(4, Math.min(innerWidth - W - 4, r.right - W))}px`;
  pop.style.top = `${r.bottom + 4 + H < innerHeight ? r.bottom + 4 : Math.max(4, r.top - H - 4)}px`;
  const outside = e => { if (!pop.contains(e.target) && !anchor.contains(e.target)) close(); };
  function close() { pop.remove(); io?.disconnect(); open = null; removeEventListener('pointerdown', outside, true); }
  addEventListener('pointerdown', outside, true);
  open = close;
  draw();
  s.input.focus();
  return close;
}
