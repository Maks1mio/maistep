// Рабочие области (как в Blender/Unity): вкладки сверху — Workflow, Results, CodeEditor, UI Kit; у каждой своя раскладка
// панелей. Раскладка — дерево: разделитель { dir: 'h'|'v', sizes, kids } или область { tabs, active }.
// Вкладку панели можно утащить к краю/в центр другой области, разделители тянутся, меню области (⋮) добавляет,
// закрывает панели и сбрасывает раскладку. Раскладки хранятся в localStorage ('maistep-layouts-1').
// Панели не переносятся по DOM: они лежат в слое .dock-layer и ставятся поверх своей области (iframe игры и превью
// не перезагружаются при смене рабочей области).
import { h } from './util.js';
import { icon } from './icons.js';

const KEY = 'maistep-layouts-1';
const panels = new Map(); // id → { id, title, icon, el, view, onShow }
const WS = [
  ['graph', 'Workflow', 'blueprint'], ['results', 'Results', 'image'], ['library', 'Models', 'diagram'], ['civitai', 'Civitai', 'search'], ['code', 'CodeEditor', 'code'], ['components', 'Компоненты', 'download'], ['naizer', 'ImageNaizer', 'spark'], ['tocolar', 'ToColar', 'gutter/colors'], ['uikit', 'UI Kit', 'layout'],
];
const area = (...tabs) => ({ tabs, active: tabs[0] });
const split = (dir, sizes, ...kids) => ({ dir, sizes, kids });
// раскладки по умолчанию — своя под каждую работу; Hierarchy показывает дерево именно этой области
const DEFAULTS = {
  // граф во всю ширину, воркфлоу и ноды слева, свойства ноды и её результат справа
  graph: () => split('h', [0.16, 0.6, 0.24], split('v', [0.6, 0.4], area('hier'), area('project')),
    split('v', [0.8, 0.2], area('graph'), area('console')), area('inspector', 'agent')),
  // очередь и история слева, галерея результатов, выбранный запуск справа
  results: () => split('h', [0.18, 0.56, 0.26], area('hier'), split('v', [0.82, 0.18], area('results'), area('console')), area('inspector')),
  // категории и корни слева, галерея моделей, карточка модели справа
  library: () => split('h', [0.17, 0.57, 0.26], area('hier'), split('v', [0.85, 0.15], area('library'), area('console')), area('inspector')),
  // фильтры, метки и загрузки слева, галерея Civitai, карточка модели справа
  civitai: () => split('h', [0.17, 0.57, 0.26], area('hier'), split('v', [0.85, 0.15], area('civitai'), area('console')), area('inspector')),
  code: () => split('h', [0.16, 0.58, 0.26], area('hier'), area('code'), split('v', [0.55, 0.45], area('inspector'), area('console'))),
  // группы пакетов слева, таблица, карточка пакета и лог pip справа
  components: () => split('h', [0.16, 0.58, 0.26], area('hier'), split('v', [0.75, 0.25], area('components'), area('console')), area('inspector')),
  // версии и файлы слева, холст с выделением, настройки правки справа
  naizer: () => split('h', [0.15, 0.6, 0.25], area('hier'), split('v', [0.85, 0.15], area('naizer'), area('console')), area('inspector')),
  // список страниц, сравнение до/после, настройки — всё в самой странице
  tocolar: () => split('v', [0.85, 0.15], area('tocolar'), area('console')),
  uikit: () => split('h', [0.75, 0.25], area('uikit'), area('inspector')),
};
const defaultLayout = ws => (DEFAULTS[ws] || DEFAULTS.graph)();
let state = { active: 'graph', layouts: {} };
let started = false, focusView = null, dock = null, layer = null, ro = null;

const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {} };
const layout = (ws = state.active) => (state.layouts[ws] ||= defaultLayout(ws));

// ---------- регистрация ----------
export function addView(id, title, onShow, ic = null) {
  const el = document.getElementById(`v-${id}`);
  panels.set(id, { id, title, icon: WS.find(w => w[0] === id)?.[2] || ic || 'layout', el, view: true, onShow });
}
export const viewTitle = id => panels.get(id)?.title || id;
function addPanel(id, title, ic, el) { panels.set(id, { id, title, icon: ic, el, view: false }); }

export function initDock() {
  dock = document.getElementById('dock');
  addPanel('hier', 'Hierarchy', 'hierarchy', document.getElementById('p-hier'));
  addPanel('project', 'Project', 'folder', document.getElementById('p-project'));
  addPanel('inspector', 'Inspector', 'properties', document.getElementById('p-inspector'));
  addPanel('console', 'Console', 'terminal', document.getElementById('p-console'));
}

// ---------- дерево раскладки ----------
function walk(node, fn, parent = null) { fn(node, parent); node.kids?.forEach(k => walk(k, fn, node)); }
function areas(root = layout()) { const out = []; walk(root, n => { if (n.tabs) out.push(n); }); return out; }
function parentOf(target, root = layout()) { let p = null; walk(root, (n, par) => { if (n === target) p = par; }); return p; }
const shownPanels = () => areas().map(a => a.active).filter(id => panels.has(id));
export const isShown = id => started && shownPanels().includes(id);

// чистка сохранённого: неизвестные панели, пустые области, разделители с одним ребёнком, дубли
function sanitize(node, seen = new Set()) {
  if (node.tabs) {
    node.tabs = node.tabs.filter(t => panels.has(t) && !seen.has(t) && seen.add(t));
    if (!node.tabs.includes(node.active)) node.active = node.tabs[0];
    return node.tabs.length ? node : null;
  }
  const kids = [], sizes = [];
  (node.kids || []).forEach((k, i) => { const c = sanitize(k, seen); if (c) { kids.push(c); sizes.push(node.sizes?.[i] || 1); } });
  if (!kids.length) return null;
  if (kids.length === 1) return kids[0];
  const sum = sizes.reduce((a, b) => a + b, 0);
  return { dir: node.dir === 'v' ? 'v' : 'h', kids, sizes: sizes.map(s => s / sum) };
}

function removePanel(id) {
  const root = layout();
  const a = areas(root).find(x => x.tabs.includes(id));
  if (!a) return;
  a.tabs = a.tabs.filter(t => t !== id);
  if (a.active === id) a.active = a.tabs[0];
  state.layouts[state.active] = sanitize(root) || area('inspector');
}

// вставить панель: zone — 'center' | 'left' | 'right' | 'top' | 'bottom' относительно области target
function insertPanel(id, target, zone) {
  if (zone === 'center') { target.tabs.push(id); target.active = id; return; }
  const dir = zone === 'left' || zone === 'right' ? 'h' : 'v', before = zone === 'left' || zone === 'top';
  const fresh = area(id), parent = parentOf(target);
  if (parent && parent.dir === dir) {
    const i = parent.kids.indexOf(target), s = parent.sizes[i] / 2;
    parent.sizes[i] = s;
    parent.kids.splice(before ? i : i + 1, 0, fresh);
    parent.sizes.splice(before ? i : i + 1, 0, s);
    return;
  }
  const split = { dir, sizes: [0.5, 0.5], kids: before ? [fresh, target] : [target, fresh] };
  if (!parent) state.layouts[state.active] = split;
  else parent.kids[parent.kids.indexOf(target)] = split;
}

function movePanel(id, target, zone, index) {
  const src = areas().find(a => a.tabs.includes(id));
  // полоса вкладок: вставить вкладкой на место index (в той же области — просто поменять порядок)
  if (zone === 'tab') {
    if (src === target) {
      const from = target.tabs.indexOf(id);
      target.tabs.splice(from, 1);
      target.tabs.splice(index > from ? index - 1 : index, 0, id);
    } else {
      removePanel(id);
      if (!areas().includes(target)) return render();
      target.tabs.splice(Math.min(index, target.tabs.length), 0, id);
      state.layouts[state.active] = sanitize(layout());
    }
    target.active = id;
    if (panels.get(id).view) focusView = id;
    save();
    return render();
  }
  if (src === target && (zone === 'center' || src.tabs.length === 1)) return;
  // target переживает удаление: он не пуст (или это другая область)
  const keep = target;
  removePanel(id);
  if (!areas().includes(keep)) return render();
  insertPanel(id, keep, zone);
  state.layouts[state.active] = sanitize(layout());
  save();
  render();
}

// ---------- отрисовка ----------
function build(node) {
  if (node.tabs) return areaEl(node);
  const el = h(`div.dsplit.${node.dir}`);
  node.kids.forEach((k, i) => {
    if (i) el.append(splitter(node, i, el));
    const c = build(k);
    c.style.flex = `${node.sizes[i]} 1 0`;
    el.append(c);
  });
  return el;
}

function splitter(node, i, el) {
  const s = h(`div.dsplitter.${node.dir}`);
  s.addEventListener('pointerdown', e => {
    e.preventDefault();
    const horiz = node.dir === 'h', kids = [...el.children].filter(c => !c.classList.contains('dsplitter'));
    const a = kids[i - 1], b = kids[i];
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const total = horiz ? ra.width + rb.width : ra.height + rb.height, pair = node.sizes[i - 1] + node.sizes[i];
    const start = horiz ? e.clientX : e.clientY, a0 = horiz ? ra.width : ra.height;
    const shield = h('div', { style: { position: 'fixed', inset: '0', zIndex: 999, cursor: horiz ? 'col-resize' : 'row-resize' } });
    document.body.append(shield);
    s.classList.add('drag');
    const mm = ev => {
      const px = Math.max(60, Math.min(total - 60, a0 + (horiz ? ev.clientX : ev.clientY) - start));
      node.sizes[i - 1] = pair * px / total; node.sizes[i] = pair - node.sizes[i - 1];
      a.style.flex = `${node.sizes[i - 1]} 1 0`; b.style.flex = `${node.sizes[i]} 1 0`;
    };
    const mu = () => { removeEventListener('pointermove', mm); removeEventListener('pointerup', mu); shield.remove(); s.classList.remove('drag'); save(); };
    addEventListener('pointermove', mm);
    addEventListener('pointerup', mu);
  });
  return s;
}

function areaEl(node) {
  const body = h('div.darea-body');
  const el = h('div.darea', {}, h('div.darea-tabs', {},
    ...node.tabs.map(id => tabEl(node, id)),
    h('span.grow'),
    h('button.b', { 'data-tip': 'Панели и раскладка', onclick: e => areaMenu(e, node) }, icon('more', { size: 16 }))), body);
  el.node = node; body.node = node;
  ro.observe(body);
  return el;
}

function tabEl(node, id) {
  const p = panels.get(id);
  const t = h(`div.dtab${node.active === id ? '.on' : ''}${p.view && focusView === id ? '.focus' : ''}`, { 'data-panel': id },
    icon(p.icon, { size: 14 }), h('span', {}, p.title),
    h('span.x', { 'data-tip': 'Закрыть панель', onpointerdown: e => e.stopPropagation(), onclick: e => { e.stopPropagation(); removePanel(id); save(); render(); } }, icon('closeSmall', { size: 14 })));
  t.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    const x0 = e.clientX, y0 = e.clientY;
    let drag = null;
    const mm = ev => {
      if (!drag && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 6) return;
      drag ||= startDrag(id);
      drag.move(ev);
    };
    const mu = ev => {
      removeEventListener('pointermove', mm); removeEventListener('pointerup', mu);
      if (drag) drag.drop(ev);
      else if (node.active !== id) { node.active = id; if (p.view) focusView = id; save(); render(); }
    };
    addEventListener('pointermove', mm);
    addEventListener('pointerup', mu);
  });
  return t;
}

function startDrag(id) {
  const p = panels.get(id);
  const ghost = h('div.dghost', {}, icon(p.icon, { size: 14 }), p.title);
  const hint = h('div.ddrop');
  const shield = h('div', { style: { position: 'fixed', inset: '0', zIndex: 998, cursor: 'grabbing' } });
  document.body.append(shield, hint, ghost);
  dock.classList.add('dragging'); // панели слоя не перехватывают курсор — ищем область под ними
  let target = null, zone = null, index = 0;
  return {
    move(ev) {
      ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 8}px)`;
      shield.style.pointerEvents = 'none';
      const under = document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.('.darea');
      shield.style.pointerEvents = '';
      target = under?.node || null;
      if (!target) { hint.style.display = 'none'; return; }
      // над полосой вкладок — вставка вкладкой между соседями (маркер-черта)
      const strip = under.querySelector('.darea-tabs'), sr = strip.getBoundingClientRect();
      if (ev.clientY <= sr.bottom) {
        const tabs = [...strip.querySelectorAll('.dtab')];
        index = tabs.findIndex(t => { const b = t.getBoundingClientRect(); return ev.clientX < b.left + b.width / 2; });
        if (index < 0) index = tabs.length;
        const x = index < tabs.length ? tabs[index].getBoundingClientRect().left : (tabs.at(-1)?.getBoundingClientRect().right ?? sr.left + 4);
        zone = 'tab';
        Object.assign(hint.style, { display: 'block', left: `${x - 2}px`, top: `${sr.top + 3}px`, width: '4px', height: `${sr.height - 6}px` });
        return;
      }
      const r = under.getBoundingClientRect(), fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
      const edge = Math.min(fx, 1 - fx, fy, 1 - fy);
      zone = edge > 0.25 ? 'center' : edge === fx ? 'left' : edge === 1 - fx ? 'right' : edge === fy ? 'top' : 'bottom';
      const q = { center: [0, 0, 1, 1], left: [0, 0, 0.5, 1], right: [0.5, 0, 0.5, 1], top: [0, 0, 1, 0.5], bottom: [0, 0.5, 1, 0.5] }[zone];
      Object.assign(hint.style, { display: 'block', left: `${r.left + q[0] * r.width}px`, top: `${r.top + q[1] * r.height}px`, width: `${q[2] * r.width}px`, height: `${q[3] * r.height}px` });
    },
    drop() {
      ghost.remove(); hint.remove(); shield.remove(); dock.classList.remove('dragging');
      if (target) movePanel(id, target, zone, index);
    },
  };
}

function areaMenu(e, node) {
  e.stopPropagation();
  document.querySelector('.dmenu')?.remove();
  const here = new Set(areas().flatMap(a => a.tabs));
  const it = (ic, label, fn, hint) => h('div.item', { onclick: () => { m.remove(); fn(); } }, h('span.ic', {}, ic ? icon(ic, { size: 16 }) : null), h('span', {}, label), hint ? h('span.sc', {}, hint) : null);
  const ws = WS.find(w => w[0] === state.active);
  const m = h('div.ui-menu.dmenu', {},
    h('div', { style: { padding: '4px 10px 6px', color: 'var(--dim)', fontSize: '12px' } }, 'Показать панель здесь'),
    ...[...panels.values()].map(p => it(p.icon, p.title, () => {
      if (node.tabs.includes(p.id)) { node.active = p.id; save(); render(); } else movePanel(p.id, node, 'center');
    }, node.tabs.includes(p.id) ? 'здесь' : here.has(p.id) ? 'перенести' : '')),
    h('div.sep'),
    it('closeSmall', `Закрыть «${panels.get(node.active)?.title}»`, () => { removePanel(node.active); save(); render(); }),
    it('refresh', `Сбросить раскладку «${ws?.[1]}»`, () => resetLayout()));
  document.body.append(m);
  const r = e.currentTarget.getBoundingClientRect();
  m.style.cssText = `position:fixed;z-index:500;min-width:250px;left:${Math.max(4, Math.min(r.right - 250, innerWidth - 254))}px;top:${r.bottom + 4}px`;
  const off = ev => { if (!m.contains(ev.target)) { m.remove(); removeEventListener('pointerdown', off, true); } };
  addEventListener('pointerdown', off, true);
}

export function resetLayout(ws = state.active) {
  state.layouts[ws] = defaultLayout(ws);
  save();
  if (ws === state.active) render();
}

// панели — поверх своих областей; без области — скрыты
let syncRaf = 0;
function sync() {
  cancelAnimationFrame(syncRaf);
  syncRaf = requestAnimationFrame(() => {
    const d = dock.getBoundingClientRect(), placed = new Set();
    for (const body of dock.querySelectorAll('.darea-body')) {
      const p = panels.get(body.node.active);
      if (!p) continue;
      const r = body.getBoundingClientRect();
      Object.assign(p.el.style, { display: '', left: `${r.left - d.left}px`, top: `${r.top - d.top}px`, width: `${r.width}px`, height: `${r.height}px` });
      p.el.classList.add('on');
      placed.add(p.id);
    }
    for (const p of panels.values()) if (!placed.has(p.id)) { p.el.style.display = 'none'; p.el.classList.remove('on'); }
    dispatchEvent(new Event('dock-resize'));
  });
}

function wsBar() {
  const bar = document.getElementById('wsbar');
  bar.replaceChildren(...WS.map(([id, title, ic], i) => h(`div.wstab${state.active === id ? '.on' : ''}`, {
    'data-tip': `${title} (${i + 1})`, onclick: () => switchWs(id),
  }, icon(ic, { size: 14 }), title)),
  h('span.grow'),
  h('button.b', { 'data-tip': 'Сбросить раскладку этой рабочей области', onclick: () => resetLayout() }, icon('layout', { size: 16 }), h('span', {}, 'Сбросить раскладку')));
}

function render() {
  if (!started) return;
  wsBar();
  ro.disconnect();
  const tree = dock.querySelector('.dock-tree');
  tree.replaceChildren(build(layout()));
  const shown = shownPanels().filter(id => panels.get(id).view);
  if (!shown.includes(focusView)) focusView = shown.includes(state.active) ? state.active : shown[0] || null;
  sync();
  // виджеты видов, ставших видимыми: сначала остальные, главный вид рабочей области — последним (контекст Hierarchy)
  const order = [...shown.filter(id => id !== state.active), ...shown.filter(id => id === state.active)];
  requestAnimationFrame(() => order.forEach(id => { panels.get(id).onShow?.(); dispatchEvent(new CustomEvent('view', { detail: id })); }));
}

function switchWs(id) {
  if (!WS.some(w => w[0] === id)) return;
  state.active = id; focusView = id; save(); render();
  dispatchEvent(new CustomEvent('workspace', { detail: id }));
}

export function startDock() {
  const saved = load();
  state = { active: WS.some(w => w[0] === saved.active) ? saved.active : 'graph', layouts: {} };
  // старая раскладка «Компонентов» была без Hierarchy и Inspector — берём новую по умолчанию
  if (saved.layouts?.components && !JSON.stringify(saved.layouts.components).includes('"inspector"')) delete saved.layouts.components;
  for (const [id] of WS) state.layouts[id] = (saved.layouts?.[id] && sanitize(structuredClone(saved.layouts[id]))) || defaultLayout(id);
  layer = h('div.dock-layer', {}, [...panels.values()].map(p => p.el));
  dock.replaceChildren(h('div.dock-tree'), layer);
  ro = new ResizeObserver(sync);
  addEventListener('resize', sync);
  // активный вид — тот, где последний раз щёлкнули (горячие клавиши Scene/Timeline/Blueprint)
  layer.addEventListener('pointerdown', e => {
    const p = [...panels.values()].find(x => x.view && x.el.contains(e.target));
    if (p && focusView !== p.id) { focusView = p.id; dock.querySelectorAll('.dtab').forEach(t => t.classList.toggle('focus', t.dataset.panel === p.id)); }
  }, true);
  started = true;
  render();
}

// показать вид: если он уже открыт в этой рабочей области — сделать активной вкладкой, иначе перейти в его область
export function showView(id) {
  if (!panels.has(id)) return;
  const a = areas().find(x => x.tabs.includes(id));
  if (a) {
    focusView = id;
    if (a.active !== id) { a.active = id; save(); render(); }
    else dock.querySelectorAll('.dtab').forEach(t => t.classList.toggle('focus', t.dataset.panel === id));
    return;
  }
  // не открыт здесь: своя рабочая область или та, где он есть в раскладке
  const ws = WS.find(w => w[0] === id)?.[0] || WS.find(w => areas(layout(w[0])).some(a => a.tabs.includes(id)))?.[0];
  if (!ws) return;
  switchWs(ws);
  const b = areas().find(x => x.tabs.includes(id));
  if (b && b.active !== id) { b.active = id; focusView = id; save(); render(); }
}

// вид, с которым работают сейчас (горячие клавиши): последний щёлкнутый из видимых, иначе главный вид области
export const activeView = () => (started ? (isShown(focusView) ? focusView : state.active) : null);
export const workspace = () => state.active;
export const openWorkspace = id => switchWs(id);
