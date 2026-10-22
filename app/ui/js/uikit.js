// UI Kit — витрина компонентов редактора по референсам JetBrains New UI. Слева — разделы (scroll-spy), сверху —
// поиск по компонентам и тема образцов (Dark / Light / обе). Каждая карточка: образец(ы), название, API, заметка;
// клик по коду или цвету копирует его. Классы .ui-* — css/uikit.css, сборщики компонентов — js/kit.js.
import { h, num } from './util.js';
import { addView, isShown } from './dock.js';
import { on } from './store.js';
import { icon, ic, ICONS, allIcons } from './icons.js';
import { kbd, search, onOff, dropdown, tipContent, gotItCard, gotIt, colorField, colorPicker, messageCard, messageBox } from './kit.js';

const LS = 'maistep-uikit';
const prefs = (() => { try { return { theme: 'dark', iconSize: 16, ...JSON.parse(localStorage.getItem(LS)) }; } catch { return { theme: 'dark', iconSize: 16 }; } })();
const savePrefs = () => { try { localStorage.setItem(LS, JSON.stringify(prefs)); } catch {} };

// ---------- помощники образцов ----------
const STATES = [['Active', ''], ['Hovered', 'is-hover'], ['Pressed', 'is-pressed'], ['Focused', 'is-focus'], ['Disabled', 'is-disabled']];
const CHECK_MODES = [['Active', ''], ['Hovered', 'is-hover'], ['Focused', 'is-focus'], ['Invalid', 'is-invalid'], ['Disabled', 'is-disabled']];
const cls = mods => (mods ? '.' + mods.trim().split(/\s+/).join('.') : '');
const code = s => h('code.uk-code', { title: 'Копировать' }, s);
const I = (k, dark, size = 16) => icon(k, { size, dark });

function toast(text) {
  const t = h('div.uk-toast', {}, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 1200);
}
function copy(text) {
  navigator.clipboard?.writeText(text).then(() => toast(`Скопировано: ${text.length > 48 ? text.slice(0, 48) + '…' : text}`), () => toast('Не удалось скопировать'));
}

// card({ name, api, note, sample(dark), cls, wide, themeless })
function card(c) {
  const themes = c.themeless ? ['dark'] : prefs.theme === 'both' ? ['dark', 'light'] : [prefs.theme];
  const el = h(`div.uk-card${c.wide ? '.wide' : ''}`, { 'data-q': `${c.name} ${c.api || ''} ${c.note || ''}`.toLowerCase() },
    h(`div.uk-samples${themes.length > 1 ? '.both' : ''}`, {}, themes.map(t => h(`div.uk-sample${cls(c.cls)}${t === 'light' ? '.ui-theme-light' : ''}`, {},
      themes.length > 1 ? h('span.th', {}, t) : null, c.sample(t === 'dark')))),
    h('div.meta', {}, h('h4', {}, c.name), c.api ? code(c.api) : null, c.note ? h('div.note', {}, c.note) : null));
  return el;
}

function checkEl(mods, label, hint, hintBottom) {
  const el = h(`label.ui-check${cls(mods)}${hintBottom ? '.col' : ''}`, {},
    h('span.ui-box'), label ? h('span.lbl', {}, label) : null,
    hint ? h('span.hint', {}, hint) : null);
  if (!mods.includes('is-disabled')) el.addEventListener('click', e => { e.preventDefault(); el.classList.toggle('is-checked'); el.classList.remove('is-indet'); });
  return el;
}

function matrix(rows, cols, cell) {
  return h('table.uk-table', {},
    h('tr', {}, h('th', {}), ...cols.map(([name]) => h('th', {}, name))),
    ...rows.map(([rname, rmods], ri) => h('tr', {},
      h('td.meta', {}, rname),
      ...cols.map(([, cmods]) => h('td', {}, cell(rmods, cmods, ri))))));
}

const spec = rows => h('div.uk-spec', {}, rows.flatMap(([l, v]) => [h('span.l', {}, l), h('div', {}, v)]));

// ---------- Основы ----------
function sectionTypo() {
  const ui = [
    ['H1', 't-h1', 'Semibold', '20 / 24', 'Заголовки экранов'],
    ['H2', 't-h2', 'Semibold', '16 / 20', 'Заголовки панелей'],
    ['Default', 't-def', 'Medium', '13 / 16', 'Основной текст UI'],
    ['Default semibold', 't-def-sb', 'Semibold', '13 / 16', 'Акценты в строках'],
    ['Paragraph', 't-p', 'Medium', '13 / 18', 'Абзацы, подсказки'],
    ['Medium', 't-med', 'Medium', '12 / 16', 'Метки, мелкие подписи'],
    ['Medium semibold', 't-med-sb', 'Semibold', '12 / 16', 'Мелкие акценты'],
  ];
  const ed = [
    ['Default', 'e-def', 'Medium', '13 / 22', 'Код, значения'],
    ['Default bold', 'e-def-b', 'Bold', '13 / 22', 'Акценты в коде'],
    ['Small', 'e-sm', 'Medium', '12 / 22', 'Логи, консоль'],
    ['Small bold', 'e-sm-b', 'Bold', '12 / 22', 'Акценты в логах'],
  ];
  const table = rows => h('table.uk-table', {},
    h('tr', {}, h('th', {}, 'Style'), h('th', {}, 'Weight'), h('th', {}, 'Size / Line'), h('th', {}, 'Где')),
    ...rows.map(([name, c, weight, size, use]) => h('tr', {},
      h('td', {}, h(`span.${c}`, {}, name)), h('td.meta', {}, weight), h('td.meta', {}, size), h('td.meta', {}, use))));
  return [
    card({ name: 'UI · Inter', api: '.t-h1 .t-h2 .t-def .t-def-sb .t-p .t-med .t-med-sb', cls: 'left top', sample: () => table(ui),
      note: 'Medium в реализации = Regular (как в референсе); Inter — с системным фолбэком (Segoe UI)' }),
    card({ name: 'Editor · JetBrains Mono', api: '.e-def .e-def-b .e-sm .e-sm-b', cls: 'left top', sample: () => table(ed),
      note: 'шрифт в комплекте: editor/ui/fonts, @font-face в css/uikit.css' }),
  ];
}

const PALETTE = [
  ['Gray', [
    [1, '#1E1F22', 'фон редактора, окна'], [2, '#2B2D30', 'фон полей, панелей'], [3, '#393B40', 'hover строк, меню'],
    [4, '#43454A', 'рамки меню, уведомлений'], [5, '#4E5157', 'границы компонентов'], [6, '#5A5D63', 'disabled текст'],
    [7, '#6F737A', 'вторичный текст'], [8, '#868A91', 'подсказки, иконки'], [9, '#9DA0A8', 'иконки, статус-бар'],
    [10, '#B4B8BF', 'вторичный текст'], [11, '#CED0D6', 'текст тултипов'], [12, '#DFE1E5', 'основной текст'],
    [13, '#F0F1F2', 'текст уведомлений'], [14, '#FFFFFF', 'белый, текст на кнопках']]],
  ['Blue', [
    [1, '#25324D', ''], [2, '#2E436E', 'выделение строк'], [3, '#35538F', 'hover пунктов меню'], [4, '#375FAD', ''],
    [5, '#366ACE', 'кнопка нажата'], [6, '#3574F0', 'кнопка, фокус, акцент'], [7, '#467FF2', 'кнопка hover, прогресс'],
    [8, '#548AF7', ''], [9, '#6B9BFA', 'ссылки'], [10, '#83ACFC', ''], [11, '#99BBFF', ''], [12, '#B5CEFF', ''], [13, '#D1E0FF', '']]],
  ['Green', [
    [1, '#253627', ''], [2, '#273828', ''], [3, '#375239', ''], [4, '#436946', ''], [5, '#4E8052', 'ON-переключатель'],
    [6, '#57965C', 'успех, прогресс'], [7, '#5FAD65', 'success-иконки'], [8, '#73BD79', ''], [9, '#89CC8E', ''],
    [10, '#A0DBA5', ''], [11, '#B9EBBD', ''], [12, '#D4FAD7', '']]],
  ['Yellow', [
    [1, '#3D3223', ''], [2, '#5E4D33', ''], [3, '#826A41', ''], [4, '#9E814A', ''], [5, '#BA9752', 'предупреждение'],
    [6, '#D6AE58', ''], [7, '#F2C55C', 'warning-тултипы'], [8, '#F5D273', ''], [9, '#F7DE8B', ''],
    [10, '#FCEBA4', ''], [11, '#FFF6BD', '']]],
  ['Red', [
    [1, '#402929', ''], [2, '#472B2B', ''], [3, '#5E3838', ''], [4, '#7A4343', ''], [5, '#9C4E4E', ''],
    [6, '#BD5757', ''], [7, '#DB5C5C', 'ошибка'], [8, '#E37774', 'error-тултипы'], [9, '#EB938D', ''],
    [10, '#F2B1AA', ''], [11, '#F7CCC6', ''], [12, '#FAE3DE', '']]],
  ['Orange', [
    [1, '#45322B', ''], [2, '#614438', ''], [3, '#825845', ''], [4, '#A36B4E', ''], [5, '#C27A53', ''],
    [6, '#E08855', 'run/отладка'], [7, '#E5986C', ''], [8, '#F0AC81', 'значения в отладчике'], [9, '#F5BD98', ''],
    [10, '#FACEAF', ''], [11, '#FFDFC7', '']]],
  ['Purple', [
    [1, '#2F2936', ''], [2, '#3B3147', ''], [3, '#433358', ''], [4, '#583D7A', ''], [5, '#6C469C', ''],
    [6, '#8150BE', ''], [7, '#955AE0', 'ветки remote, иконки'], [8, '#A571E6', ''], [9, '#B589EC', ''],
    [10, '#C4A0F3', ''], [11, '#D4B8F9', ''], [12, '#E4CEFF', '']]],
  ['Teal', [
    [1, '#1D3838', ''], [2, '#1D3D3B', ''], [3, '#1E4D4A', ''], [4, '#20635D', ''], [5, '#21786F', ''],
    [6, '#238E82', ''], [7, '#24A394', 'иконки'], [8, '#42B1A4', ''], [9, '#60C0B5', ''],
    [10, '#7DCEC5', ''], [11, '#9BDDD6', ''], [12, '#B9EBE6', '']]],
];

const TOKENS = [
  ['--ui-bg', 'фон полей, кнопок'], ['--ui-bg1', 'фон панелей'], ['--ui-fg', 'текст'], ['--ui-fg-dim', 'подсказки'], ['--ui-fg-off', 'disabled'],
  ['--ui-border', 'рамки'], ['--ui-sep', 'разделители'], ['--ui-hover', 'hover'], ['--ui-sel', 'выделение'], ['--ui-sel-off', 'выделение без фокуса'],
  ['--ui-accent', 'акцент'], ['--ui-link', 'ссылки'], ['--ui-popup', 'попапы'], ['--ui-tip', 'тултипы'], ['--ui-key', 'клавиши'], ['--ui-scroll', 'полоса прокрутки'],
];

function sectionPalette() {
  return [
    card({ name: 'Палитра (Dark)', api: 'var(--p-gray-1) … var(--p-teal-12)', wide: true, themeless: true, cls: 'left top',
      note: 'из expUI_dark.theme.json (IntelliJ New UI); клик по строке копирует hex',
      sample: () => h('div.uk-pal', {}, ...PALETTE.map(([hue, steps]) => h('div.uk-hue', {},
        h('h5', {}, hue),
        ...steps.map(([n, hex, use]) => h('div.row', { onclick: () => copy(hex), title: use || '' },
          h('span.sw', { style: { background: hex } }), h('span.nm', {}, `${hue} ${n}`), h('span.hx', {}, hex),
          use ? h('span.use', {}, use) : null))))) }),
    card({ name: 'Токены компонентов', api: '.ui-theme-light — переопределяет --ui-* для светлой темы', wide: true, cls: 'left top',
      note: 'компоненты красятся только токенами, поэтому одинаково работают в обеих темах',
      sample: () => h('div.uk-pal', {}, TOKENS.map(([t, use]) => h('div.uk-hue', { style: { minWidth: '200px' } }, h('div.row', { onclick: () => copy(`var(${t})`) },
        h('span.sw', { style: { background: `var(${t})` } }), h('span.hx', { style: { width: '92px' } }, t), h('span.use', {}, use))))) }),
  ];
}

function sectionIcons() {
  const box = h('div.uk-icons');
  const short = h('div.uk-icons');
  let q = '';
  const tile = (label, path, copyText) => h('div.ic', { title: path, onclick: () => copy(copyText) },
    ic(path, { size: prefs.iconSize }), h('span', {}, label));
  const drawShort = () => short.replaceChildren(...Object.entries(ICONS).map(([k, p]) => tile(k, p, `icon('${k}')`)));
  const drawAll = async () => {
    const list = await allIcons();
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = list.filter(p => words.every(w => p.toLowerCase().includes(w)));
    box.replaceChildren(...hit.slice(0, 360).map(p => tile(p.split('/').pop(), p, `ic('${p}')`)));
    cnt.textContent = `${hit.length} из ${list.length}${hit.length > 360 ? ' · показаны первые 360' : ''}`;
  };
  const cnt = h('span.dim');
  const sizes = h('div.uk-seg', {}, [16, 20, 24].map(s => h(`span${prefs.iconSize === s ? '.on' : ''}`, {
    onclick: e => { prefs.iconSize = s; savePrefs(); sizes.querySelectorAll('span').forEach(x => x.classList.toggle('on', x === e.target)); drawShort(); drawAll(); },
  }, `${s}px`)));
  drawShort();
  drawAll();
  return [
    card({ name: 'Короткие имена', api: "icon('save', { size: 14, dark: true })", wide: true, themeless: true, cls: 'col',
      note: 'ICONS в js/icons.js; тёмная тема берёт *_dark.svg, при его отсутствии — обычный файл. Клик копирует вызов',
      sample: () => short }),
    card({ name: 'Все иконки набора', api: "ic('general/settings', { size: 16 })", wide: true, themeless: true, cls: 'col',
      note: 'editor/ui/icons/**.svg — экспорт New UI; список — icons/index.json (node tools/icons-index.mjs)',
      sample: () => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px', width: '100%' } },
        h('div.row', {}, search({ placeholder: 'Поиск иконки: run, folder, arrow…', onInput: v => { q = v; drawAll(); } }), sizes, cnt), box) }),
  ];
}

// ---------- Отступы ----------
const SPACING = [
  ['Вертикаль', [
    ['--sp-group', 20, 'Между группами'],
    ['--sp-unrel', 8, 'Между несвязанными настройками в группе'],
    ['—', 0, 'Между связанными настройками в группе (строки стоят вплотную, отступ — внутренние поля контролов)'],
    ['--sp-ctrl', 6, 'Сверху/снизу строки с полем, комбо-боксом, кнопкой; заголовок группы'],
    ['--sp-check', 4, 'Сверху/снизу строки с чекбоксом или радио (две подряд — 8 между ними)'],
    ['--sp-hint', 2, 'От контрола до подсказки под ним'],
  ]],
  ['Горизонталь', [
    ['--sp-inline', 16, 'Между настройками в одной строке; от настройки до её подсказки/ссылки справа'],
    ['--sp-label', 6, 'От подписи «Label:» до поля'],
    ['--sp-indent', 20, 'Левый отступ зависимого контрола или группы'],
    ['--sp-cols', 60, 'Между колонками'],
  ]],
  ['Диалог', [
    ['--sp-dlg-x', 20, 'Поля слева и справа (контент и подвал)'],
    ['--sp-dlg-y', 8, 'От заголовка до контента и от контента до подвала; подвал сверху/снизу'],
    ['--sp-btn', 12, 'Между кнопками подвала; от «?» до чекбокса — 16'],
  ]],
];

function spacingScale() {
  return h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: '20px 40px', width: '100%' } },
    SPACING.map(([grp, rows]) => h('div', {},
      h('div', { style: { fontWeight: 600, marginBottom: '8px' } }, grp),
      rows.map(([tok, v, about]) => h('div.uk-sp', { title: tok === '—' ? '' : `var(${tok})`, onclick: () => tok !== '—' && copy(`var(${tok})`) },
        h('span.v', {}, v), h('span.bar', {}, h('i', { style: { [grp === 'Горизонталь' ? 'width' : 'height']: `${v}px`, [grp === 'Горизонталь' ? 'height' : 'width']: grp === 'Горизонталь' ? '14px' : '36px' } })),
        h('span.t', {}, about, tok !== '—' ? h('code', {}, tok) : null))))));
}

// флажок «показать отступы» подсвечивает поля строк, групп и диалога (как разметка в референсе)
function withGuides(content) {
  const box = h('div.uk-guides-wrap', {}, content);
  const ck = h('label.ui-check', { onclick: e => { e.preventDefault(); ck.classList.toggle('is-checked'); box.classList.toggle('uk-guides', ck.classList.contains('is-checked')); } },
    h('span.ui-box'), h('span.lbl', {}, 'Показать отступы'));
  return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', alignItems: 'flex-start' } }, ck, box);
}

const dlgFoot = (d, extra) => h('div.ft', {}, h('span.help', { title: 'Справка' }, '?'), extra || null, h('span.grow'),
  h('button.ui-btn.secondary', {}, 'Cancel'), h('button.ui-btn.primary', {}, 'OK'));

function prefsForm(d) {
  const dd = (v, opts, w, extra = {}) => dropdown(v, opts, null, { dark: d, width: w, ...extra });
  const ff = dd('Inter', ['Inter', 'JetBrains Mono'], 150); ff.disabled = true;
  const sz = dd('13', ['12', '13', '14'], 64); sz.disabled = true;
  return h('div.ui-form', { style: { width: '600px' } },
    h('div.ui-row', {}, h('span.lbf', {}, 'Theme:', dd('Light', ['Light', 'Dark', 'Darcula'], 150)), checkEl('', 'Sync with OS'), h('a.ui-link', {}, 'Get more themes', I('externalLink', d, 12))),
    h('div.ui-row.gap', {}, h('span.lbf', {}, 'Zoom:', dd('100%', ['90%', '100%', '110%'], 96)),
      h('span.sub', { style: { paddingLeft: '46px' } }, 'Change with Ctrl+= or Ctrl+−. Set to 100% with Ctrl+0')),
    h('div.ui-row.gap', {}, checkEl('', 'Use custom font:'), ff, h('span.lbf', {}, 'Size:', sz)),
    h('div.ui-group', {}, h('div.gh', {}, 'Accessibility'), h('div.gb', {},
      checkEl('', 'Support screen readers', 'Requires restart'),
      h('div.ui-check-note', {}, 'Tab and Shift+Tab will navigate UI controls in dialogs and will not be available for switching editor tabs'),
      checkEl('', 'Use contrast scrollbars'),
      checkEl('', 'Adjust colors for red-green vision deficiency', 'Requires restart. For protanopia and deuteranopia.', true))),
    h('div.ui-group', {}, h('div.gh', {}, 'UI Options'), h('div.gb', {},
      h('div.ui-cols', {},
        h('div', { style: { display: 'flex', flexDirection: 'column' } }, checkEl('', 'Show tree indent guides'), checkEl('', 'Use smaller indents in trees'), checkEl('is-checked', 'Enable mnemonics in menu'), checkEl('', 'Enable mnemonics in controls')),
        h('div', { style: { display: 'flex', flexDirection: 'column' } }, checkEl('is-checked', 'Smooth scrolling'), checkEl('is-checked', 'Drag-and-drop with Alt pressed only'), checkEl('', 'Always show full path in window header'), checkEl('is-checked', 'Display icons in menu items'))),
      h('div.ui-row', {}, h('button.ui-btn.secondary', {}, 'Background Image…')))),
    h('div.ui-group', {}, h('div.gh', {}, 'Antialiasing'), h('div.gb', {},
      h('div.ui-cols', {}, h('div.ui-row', {}, h('span.lbf', {}, 'IDE:', dd('Subpixel', ['Subpixel', 'Greyscale', 'No antialiasing'], 140))),
        h('div.ui-row', {}, h('span.lbf', {}, 'Editor:', dd('Subpixel', ['Subpixel', 'Greyscale', 'No antialiasing'], 140)))))));
}

function moveDialog(d) {
  return h('div.ui-dialog', { style: { width: '600px', maxWidth: 'none' } },
    h('div.ttl', {}, 'Move'),
    h('div.bd', {}, h('div.ui-form', {},
      h('div.ui-row', {}, 'Move file data/ui/main_menu.json'),
      h('div.ui-row', {}, h('span.lbf', { style: { flex: 1 } }, 'To directory:', dropdown('custom/data/ui', ['custom/data/ui', 'data/ui', 'data/ui/old'], null, { dark: d, width: 380 })),
        h('span.sub', { style: { paddingLeft: '86px' } }, 'Use Ctrl+Space for path completion')),
      h('div.ui-row.chk', { style: { paddingLeft: '86px' } }, checkEl('', 'Search for references')))),
    dlgFoot(d, checkEl('', 'Open in editor')));
}

function updateDialog(d) {
  return h('div.ui-dialog', { style: { width: '460px', maxWidth: 'none' } },
    h('div.ttl', {}, 'Update Project'),
    h('div.bd', {}, h('div.ui-form', { 'data-radio': '' },
      h('div.ui-row.chk', {}, radioEl('is-checked', 'Merge incoming changes into the current branch')),
      h('div.ui-row.chk', {}, radioEl('', 'Rebase the current branch on top of incoming changes')))),
    dlgFoot(d, checkEl('', 'Open in editor')));
}

function sectionSpacing() {
  return [
    card({ name: 'Правила отступов', api: "var(--sp-group) · var(--sp-unrel) · var(--sp-inline) · …", wide: true, themeless: true, cls: 'left top',
      sample: spacingScale, note: 'токены в css/uikit.css (:root); щелчок по строке копирует var(…). Инспектор панелей плотнее диалогов: 3 + 3 между полями' }),
    card({ name: 'Форма настроек', api: '.ui-form > .ui-row(.chk|.gap) · .ui-group > .gh + .gb · .ui-cols · .lbf · .sub', wide: true, cls: 'left top',
      sample: d => withGuides(h('div.ui-dialog', { style: { width: '660px', maxWidth: 'none' } }, h('div.ttl', {}, 'Preferences'), h('div.bd', {}, prefsForm(d)), h('div.ft', {}, h('span.help', {}, '?'), h('span.grow'),
        h('button.ui-btn.secondary', {}, 'Cancel'), h('button.ui-btn.secondary.is-disabled', {}, 'Apply'), h('button.ui-btn.primary', {}, 'OK')))),
      note: 'строка поля — 6 сверху/снизу, строка чекбокса — 4, несвязанные — +8, группы — 20, зависимые — 20 слева, колонки — 60, в строке — 16, «Label:» → поле — 6, подсказка снизу — 2' }),
    card({ name: 'Диалог Move', api: '.ui-dialog > .ttl + .bd(8/20) + .ft(8/20, кнопки 12, «?» → чекбокс 16)', cls: 'left top',
      sample: d => withGuides(moveDialog(d)) }),
    card({ name: 'Диалог Update Project', api: 'строки радио .ui-row.chk', cls: 'left top',
      sample: d => withGuides(updateDialog(d)) }),
  ];
}

// ---------- Кнопки и поля ----------
const buttonsMatrix = () => matrix(
  [['Primary', 'primary'], ['Secondary', 'secondary']], STATES,
  (r, m) => h(`button.ui-btn.${r}${cls(m)}`, {}, 'Button'));

function sectionButtons() {
  return [
    card({ name: 'Default Button · состояния', api: '.ui-btn.primary / .ui-btn.secondary (.is-hover .is-pressed .is-focus .is-disabled)', wide: true, cls: 'left',
      sample: buttonsMatrix, note: 'Active / Hovered / Pressed / Focused / Disabled — классы состояний для витрины; живые кнопки реагируют сами' }),
    card({ name: 'Split Button', api: '.ui-split > .ui-btn + .ui-btn.arrow',
      sample: () => [h('div.ui-split', {}, h('button.ui-btn.primary', {}, 'Button'), h('button.ui-btn.primary.arrow')),
        h('div.ui-split', {}, h('button.ui-btn.secondary', {}, 'Button'), h('button.ui-btn.secondary.arrow'))],
      note: 'левая часть — действие, правая со стрелкой — варианты' }),
    card({ name: 'Slim Button', api: '.ui-btn.slim',
      sample: () => [h('button.ui-btn.secondary.slim', {}, 'Button'), h('button.ui-btn.secondary.slim.is-hover', {}, 'Button'),
        h('button.ui-btn.secondary.slim.is-focus', {}, 'Button'), h('button.ui-btn.secondary.slim.is-disabled', {}, 'Button')],
      note: 'компактная высота 22px — панели, тулбары' }),
    card({ name: 'С иконкой', api: "h('button.ui-btn.primary', {}, icon('play', { size: 14 }), 'Запустить')",
      sample: d => [h('button.ui-btn.primary', {}, I('play', true, 14), 'Запустить'),
        h('button.ui-btn.secondary', {}, I('save', d, 14), 'Сохранить'),
        h('button.ui-btn.secondary.slim', {}, I('settings', d, 12), 'Настройки')],
      note: 'иконка 14px слева от подписи; на primary — всегда светлая' }),
  ];
}

// радио: щелчок выбирает пункт и снимает выбор с остальных в ближайшем [data-radio]
function radioEl(mods, label, hint, hintBottom) {
  const el = h(`label.ui-check.ui-radio${cls(mods)}${hintBottom ? '.col' : ''}`, {},
    h('span.ui-box'), label ? h('span.lbl', {}, label) : null, hint ? h('span.hint', {}, hint) : null);
  if (!mods.includes('is-disabled')) el.addEventListener('click', e => {
    e.preventDefault();
    const grp = el.closest('[data-radio]');
    grp?.querySelectorAll(':scope .ui-radio').forEach(r => { if (r.closest('[data-radio]') === grp) r.classList.remove('is-checked'); });
    el.classList.add('is-checked');
  });
  return el;
}
const radios = (dir, ...els) => h('div', { 'data-radio': '', style: dir === 'h' ? { display: 'flex', gap: '14px', flexWrap: 'wrap' } : { display: 'grid', gap: '4px', justifyItems: 'start' } }, ...els);

// вложенные чекбоксы с настоящей логикой: родитель ставит/снимает детей, дети дают родителю «частично»
function nestedChecks() {
  const tree = { label: 'Level 1', kids: [{ label: 'Level 2', kids: [{ label: 'Level 3', on: true }, { label: 'Level 3', on: false }] }] };
  const els = [];
  const state = n => (n.kids ? (n.kids.every(k => state(k) === 1) ? 1 : n.kids.every(k => state(k) === 0) ? 0 : 0.5) : n.on ? 1 : 0);
  const setAll = (n, v) => { if (n.kids) n.kids.forEach(k => setAll(k, v)); else n.on = v; };
  const paint = () => els.forEach(([n, el]) => { const st = state(n); el.classList.toggle('is-checked', st === 1); el.classList.toggle('is-indet', st === 0.5); });
  const walk = (n, depth) => {
    const el = h('label.ui-check', { style: { marginLeft: `${depth * 24}px` }, onclick: e => { e.preventDefault(); setAll(n, state(n) !== 1); paint(); } }, h('span.ui-box'), h('span.lbl', {}, n.label));
    els.push([n, el]);
    return [el, ...(n.kids || []).flatMap(k => walk(k, depth + 1))];
  };
  const box = h('div', { style: { display: 'grid', gap: '4px', justifyItems: 'start' } }, walk(tree, 0));
  paint();
  return box;
}

function sectionChecks() {
  return [
    card({ name: 'Чекбокс · состояния', api: '.ui-check(.is-checked|.is-indet)(.is-hover|.is-focus|.is-invalid|.is-disabled)', wide: true, cls: 'left',
      sample: () => matrix([['Unchecked', ''], ['Checked', 'is-checked'], ['Indeterminate', 'is-indet']], CHECK_MODES,
        (r, m) => checkEl([r, m].filter(Boolean).join(' '), 'Text')),
      note: 'квадрат 16px, скругление 3px; выбран — синяя заливка и галочка; фокус и ошибка — кольцо 2px с зазором; клик по живому чекбоксу переключает' }),
    card({ name: 'Variations', api: ".hint — подсказка справа · .col — подсказка снизу", cls: 'left top',
      sample: () => spec([
        ['Text', checkEl('', 'Use contrast scrollbars')],
        ['With right hint', checkEl('', 'Support screen readers', 'Requires restart')],
        ['With bottom hint', checkEl('', 'Adjust colors for red-green vision deficiency', 'Requires restart. For protanopia and deuteranopia.', true)]]) }),
    card({ name: 'Checkbox group · Nesting', api: 'группа — flex/grid из .ui-check; вложенность — отступ 24px', cls: 'left top',
      sample: () => spec([
        ['Horizontal', h('div', { style: { display: 'flex', gap: '14px' } }, checkEl('', 'Option A'), checkEl('is-checked', 'Option B'), checkEl('', 'Option C'))],
        ['Vertical', h('div', { style: { display: 'grid', gap: '4px', justifyItems: 'start' } }, checkEl('', 'Option A'), checkEl('is-checked', 'Option B'), checkEl('', 'Option C'))],
        ['Nested', nestedChecks()]]),
      note: 'вложенные живые: родитель ставит/снимает всех детей, при частичном выборе — «indeterminate»' }),
    card({ name: 'Группы настроек', api: '.ui-group > .gh (заголовок-линия) + .gb(.cols) · .ui-check-note', wide: true, cls: 'left top',
      sample: () => h('div', { style: { display: 'grid', gap: '16px', width: '100%', maxWidth: '640px' } },
        h('div.ui-group', {}, h('div.gh', {}, 'Accessibility'), h('div.gb', {},
          checkEl('is-checked', 'Support screen readers', 'Requires restart'),
          h('div.ui-check-note', {}, 'Tab and Shift+Tab will navigate UI controls in dialogs and will not be available for switching editor tabs or other IDE actions'))),
        h('div.ui-group', {}, h('div.gh', {}, 'UI Options'), h('div.gb.cols', {},
          checkEl('is-checked', 'Show tree indent guides'), checkEl('is-checked', 'Smooth scrolling'),
          checkEl('is-checked', 'Use smaller indents in trees'), checkEl('is-checked', 'Drag-and-drop with Alt pressed only')))) }),
    card({ name: 'Нативные чекбоксы редактора', api: "util.check(value, v => …) · <input type=checkbox> (стиль глобальный)", cls: 'left',
      sample: () => {
        const ind = h('input', { type: 'checkbox' }); ind.indeterminate = true;
        const bad = h('input.bad', { type: 'checkbox' });
        return h('div', { style: { display: 'grid', gap: '6px' } },
          h('label.row', {}, h('input', { type: 'checkbox', checked: true }), 'checked'), h('label.row', {}, h('input', { type: 'checkbox' }), 'unchecked'),
          h('label.row', {}, ind, 'indeterminate'), h('label.row', {}, bad, 'invalid (.bad)'), h('label.row', {}, h('input', { type: 'checkbox', checked: true, disabled: true }), 'disabled'));
      },
      note: 'все <input type=checkbox> в инспекторе, консоли и таймлайне выглядят так же, как компонент; Tab — фокус-кольцо' }),
  ];
}

function sectionRadio() {
  return [
    card({ name: 'Радио · состояния', api: '.ui-check.ui-radio(.is-checked)(.is-hover|.is-focus|.is-invalid|.is-disabled)', wide: true, cls: 'left',
      sample: () => matrix([['Unselected', ''], ['Selected', 'is-checked']], CHECK_MODES,
        (r, m) => radioEl([r, m].filter(Boolean).join(' '), 'Text')),
      note: 'круг 16px; выбран — синяя заливка с белой точкой; в disabled точка серая' }),
    card({ name: 'Variations', api: 'radioEl(mods, label, hint, hintBottom)', cls: 'left top',
      sample: () => h('div', { 'data-radio': '' }, spec([
        ['Text', radioEl('', 'Manual proxy configuration')],
        ['With right hint', radioEl('', 'Automatically', 'Handled by Gradle wrapper')],
        ['With bottom hint', radioEl('', 'None', 'Turn both features off', true)]])) }),
    card({ name: 'Radio group', api: '[data-radio] — группа, выбор одного', cls: 'left top',
      sample: () => spec([
        ['Horizontal', radios('h', radioEl('', 'Option A'), radioEl('is-checked', 'Option B'), radioEl('', 'Option C'))],
        ['Vertical', radios('v', radioEl('', 'Option A'), radioEl('is-checked', 'Option B'), radioEl('', 'Option C'))]]) }),
    card({ name: 'В настройках', api: '.ui-inline — подпись + группа в строку; вложенная группа — отступ 24px', cls: 'left top',
      sample: () => h('div', { style: { display: 'grid', gap: '16px' } },
        h('div.ui-inline', { 'data-radio': '' }, h('span', {}, 'Open project in'), radioEl('', 'New window'), radioEl('', 'Current window'), radioEl('is-checked', 'Ask')),
        radios('v', radioEl('', 'No proxy'), radioEl('is-checked', 'Manual proxy configuration'),
          h('div', { 'data-radio': '', style: { display: 'flex', gap: '14px', marginLeft: '24px' } }, radioEl('is-checked', 'HTTP'), radioEl('', 'SOCKS'))),
        h('div', { style: { display: 'grid', gap: '6px' } }, h('span', {}, 'When the current tab is closed, activate:'),
          h('div', { style: { marginLeft: '24px' } }, radios('v', radioEl('is-checked', 'The tab on the left'), radioEl('', 'Most recently opened tab'))))) }),
    card({ name: 'Нативное радио', api: "<input type=radio name=…> (стиль глобальный)", cls: 'left',
      sample: () => { const name = `uk-r-${Math.random().toString(36).slice(2)}`; return h('div', { style: { display: 'grid', gap: '6px' } }, ['Сцена', 'Заглушка', 'Нет'].map((t, i) =>
        h('label.row', {}, h('input', { type: 'radio', name, checked: i === 0 }), t)), h('label.row', {}, h('input', { type: 'radio', disabled: true, checked: true }), 'disabled')); } }),
  ];
}

function sectionToggles() {
  const tog = (mods, label) => {
    const el = h(`div.ui-toggle${cls(mods)}`, {}, h('span.track', {}, h('span.knob')), h('span', {}, label));
    if (!mods.includes('is-disabled')) el.addEventListener('click', () => el.classList.toggle('is-on'));
    return el;
  };
  return [
    card({ name: 'Тумблер', api: '.ui-toggle(.is-on|.is-focus|.is-disabled)', cls: 'col',
      sample: () => [tog('', 'Выключено'), tog('is-on', 'Включено'), tog('is-focus is-on', 'В фокусе'), tog('is-disabled is-on', 'Disabled')],
      note: 'клик переключает (кроме disabled)' }),
    card({ name: 'ON / OFF', api: "onOff(on, v => …) · span.ui-onoff(.off)",
      sample: () => [onOff(true), onOff(false), onOff(true, null, { disabled: true })],
      note: 'компактный переключатель для строк списков и Search Everywhere (kit.js)' }),
    card({ name: 'Сегменты', api: "h('div.ui-seg', {}, h('button.on', {}, 'Все'), h('button', {}, 'Сервер'), …)",
      sample: d => { const seg = h('div.ui-seg', {}, ['Все', 'Сервер', 'Игра', 'Редактор'].map((t, i) => h(`button${i ? '' : '.on'}`, { onclick: e => seg.querySelectorAll('button').forEach(b => b.classList.toggle('on', b === e.currentTarget)) }, t))); return seg; },
      note: 'фильтры консоли, режимы таймлайна (Ключи / Кривые)' }),
  ];
}

const THEMES = ['Light', 'Dark', '-', 'High Contrast', 'Darcula', 'IntelliJ Light'];
function ddState(mods, d, opts = {}, value = 'Text', options = ['Text', 'Other']) {
  const el = dropdown(value, options, null, { dark: d, ...opts });
  if (mods) el.classList.add(...mods.split(' ').filter(m => m !== 'is-disabled'));
  if (mods.includes('is-disabled')) el.disabled = true;
  return el;
}
const DD_STATES = [['Default', ''], ['Focused', 'is-focus'], ['Validated', 'is-invalid'], ['Validated focused', 'is-invalid is-focus'], ['Disabled', 'is-disabled']];

function sectionSelects() {
  const sizes = [8, 9, 10, 11, 12, 13, 14, 15, 16, 18, 20, 24];
  const many = Object.keys(ICONS).map(k => [k, k, k]);
  return [
    card({ name: 'Dropdown · состояния', api: "dropdown(value, options, v => …) · .ui-dd(.is-focus|.is-invalid|:disabled)(.split)", wide: true, cls: 'left',
      sample: d => matrix([['Обычный', ''], ['С кнопкой', 'split']], DD_STATES, (r, m) => { const el = ddState(m, d, { width: 160 }); if (r) el.classList.add(r); return el; }),
      note: 'вторая строка — вариант .split (стрелка отделена, как у редактируемого комбо-бокса). Это кнопка, а не <select>: список рисуется своим попапом' }),
    card({ name: 'Иконка · подпись и подсказка · вторичный текст', api: "{ value, label, icon, sec } · .ui-field > .lb + control + .hn", cls: 'left top',
      sample: d => spec([
        ['Icon', h('div.ui-field', {}, h('span.lb', {}, 'Label:'), dropdown('18', [{ value: '18', label: '1.8 java version', icon: 'folder' }, { value: '21', label: '21 java version', icon: 'folder' }], null, { dark: d, width: 200 }))],
        ['Label and hint', h('div.ui-field', {}, h('span.lb', {}, 'Label:'), dropdown('t', [['t', 'Text']], null, { dark: d, width: 200 }), h('span.hn', {}, 'Hint text here'))],
        ['Text & secondary', h('div.ui-field', {}, h('span.lb', {}, 'Label:'), dropdown('m', [{ value: 'm', label: 'Main text', sec: 'Secondary text' }], null, { dark: d, width: 200 }))]]) }),
    card({ name: 'Label: Text ⌄ · состояния', api: "dropdown(v, opts, fn, { link: true, label: 'Label' })", cls: 'left',
      sample: d => h('table.uk-table', { style: { width: 'auto' } },
        h('tr', {}, ['Default', 'Hovered', 'Pressed', 'Disabled'].map(t => h('th', { style: { paddingRight: '18px' } }, t))),
        h('tr', {}, ['', 'is-hover', 'is-pressed', 'is-disabled'].map(m => h('td', {}, ddState(m, d, { link: true, label: 'Label' }))))),
      note: 'без рамки — для тулбаров и фильтров; подпись приглушена, значение — основным цветом' }),
    card({ name: 'На тулбаре', api: '.ui-tb + dropdown({ link: true })', cls: 'left',
      sample: d => spec([
        ['Nothing selected', dropdown('', ['Anna', 'Max'], null, { dark: d, link: true, placeholder: 'User', empty: 'Все' })],
        ['With option', dropdown('since', [['since', 'Since 31.05.2026'], ['week', 'Last 7 days']], null, { dark: d, link: true, label: 'Date' })],
        ['Toolbar', h('div.ui-tb', {}, dropdown('', ['Anna', 'Max'], null, { dark: d, link: true, placeholder: 'User', empty: 'Все' }),
          dropdown('since', [['since', 'Since 31.05.2026']], null, { dark: d, link: true, label: 'Date' }), h('span.sep'),
          h('button.b', { title: 'Добавить' }, I('add', d)), h('button.b', { title: 'Удалить' }, I('remove', d)))]]) }),
    card({ name: 'Живые списки', api: "options: '-' — разделитель · от 15 пунктов — поиск в попапе", cls: 'left top',
      sample: d => h('div', { style: { display: 'grid', gap: '10px' } },
        h('div.ui-field', {}, h('span.lb', {}, 'Theme:'), dropdown('Light', THEMES, v => toast(`Theme: ${v}`), { dark: d, width: 180 })),
        h('div.ui-field', {}, (() => { const ff = dropdown('Inter', ['Inter', 'JetBrains Mono', 'Segoe UI'], null, { dark: d, width: 180 }); ff.disabled = true;
          const ck = checkEl('', 'Use custom font:'); ck.addEventListener('click', () => setTimeout(() => { ff.disabled = !ck.classList.contains('is-checked'); })); return [ck, ff]; })()),
        h('div.ui-field', {}, h('span.lb', {}, 'Size:'), dropdown(13, sizes, v => toast(`Size: ${v}`), { dark: d, width: 76 })),
        h('div.ui-field', {}, h('span.lb', {}, 'Icon:'), dropdown('save', many, v => toast(`icon('${v}')`), { dark: d, width: 180 }))),
      note: '↑/↓ — выбор, Enter — применить, Esc — закрыть; в списке иконок попробуйте поиск' }),
  ];
}

function sectionSearch() {
  return [
    card({ name: 'Поле поиска', api: "search({ placeholder, onInput, bare })", cls: 'col',
      sample: d => [search({ placeholder: 'Search', dark: d }), search({ placeholder: 'Search', value: 'show whi', dark: d }), search({ placeholder: 'Без рамки (в тулбаре)', bare: true, dark: d })],
      note: 'иконка поиска, крестик очистки появляется при вводе; Esc очищает. В редакторе — поиск ассетов Project' }),
    card({ name: 'enhanceSearch', api: 'enhanceSearch(document.getElementById(\'asset-q\'))', cls: 'col',
      sample: d => h('div.ui-search', { style: { width: '260px' } }, I('search', d), h('input', { placeholder: 'Поиск ассетов' })),
      note: 'превращает готовый <input> из index.html в .ui-search (иконка + очистка)' }),
  ];
}

function sectionNumbers() {
  const n = (v, o) => num(v, () => {}, o);
  return [
    card({ name: 'Числовое поле', api: "num(value, v => …, { step, min, max, int })", cls: 'col',
      sample: () => [h('div.row', {}, n(26), n(0.25, { step: 0.05 }), n(-135))],
      note: 'шевроны вместо системных стрелок — видны при наведении/фокусе; зажатие повторяет шаг, протяжка вверх/вниз меняет значение, колесо — в фокусе. Shift ×10, Alt ×0.1' }),
    card({ name: 'Стрелки · состояния', api: '.ui-num > input + .sp > b.up / b.dn', cls: 'left',
      sample: () => { const a = n(14), b = n(32); b.querySelector('.sp').classList.add('is-hover'); return [a, b]; },
      note: 'Default (стрелки скрыты) / Hovered; нажатая стрелка — акцентная' }),
    card({ name: 'Диапазон «от–до»', api: "h('div.xy', {}, num(…), num(…))", cls: 'left',
      sample: () => h('div.xy', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px', width: '240px' } }, n(3), n(22)),
      note: 'так в инспекторе FX: Размер, Жизнь, Сдвиг…' }),
  ];
}

function sectionColor() {
  return [
    card({ name: 'Поле цвета', api: "colorField('#ffffffcc', v => …) · util.color()", cls: 'col',
      sample: d => [colorField('#ffffff', () => {}, { dark: d }), colorField('#3574f080', () => {}, { dark: d }), colorField('', () => {}, { dark: d })],
      note: 'образец на шахматке показывает прозрачность; щелчок — попап пикера; без цвета — образец перечёркнут. Поле принимает #rgb, #rrggbb, #rrggbbaa, rgb(), имена' }),
    card({ name: 'Колор-пикер', api: "colorPicker(value, hex => …)", cls: 'left top',
      sample: d => { const out = h('code.ui-code', {}, '#E08855CC'); return [colorPicker('#e08855cc', v => { out.textContent = v.toUpperCase(); }, { dark: d }), out]; },
      note: 'насыщенность/яркость, оттенок, прозрачность; HEX и R G B A (A в %), колесо над числом меняет его; пипетка (EyeDropper), недавние цвета и палитра. Непрозрачный цвет пишется как #rrggbb, иначе #rrggbbaa' }),
  ];
}

function sectionMessages() {
  const kinds = [['question', 'Удалить data/fx/bubbles.json?'], ['error', 'Не удалось сохранить файл'], ['warning', 'Есть несохранённые изменения']];
  return [
    ...kinds.map(([kind, title]) => card({ name: `messageBox · ${kind}`, api: `messageBox({ kind: '${kind}', title, text, dontAsk: true })`, cls: 'top',
      sample: d => messageCard({ kind, title, text: 'Body text', dontAsk: true, ok: 'OK', cancel: 'Cancel', dark: d }) })),
    card({ name: 'Живой диалог', api: 'await messageBox(…) → { ok, dontAsk } · confirmBox(text) → true/false', cls: 'left',
      sample: () => { const b = h('button.ui-btn.primary', {}, 'Открыть'); b.onclick = async () => { const r = await messageBox({ kind: 'question', title: 'Удалить эффект?', text: 'Файл data/fx/bubbles.json будет удалён.', ok: 'Удалить', dontAsk: true }); toast(`ok: ${r.ok}, не спрашивать: ${r.dontAsk}`); }; return b; },
      note: 'Enter — OK, Esc или щелчок мимо — отмена. confirmBox редактора теперь выглядит так же' }),
  ];
}

// ---------- Списки и навигация ----------
function sectionMenu() {
  const menu = dark => {
    const mi = (key, label, sc, arrow, color) => h('div.item', {},
      h('span.ic', {}, key ? icon(key, { size: 16, dark }) : null),
      h('span', { style: color ? { color } : {} }, label),
      sc ? h('span.sc', {}, sc) : null,
      arrow ? h('span.arrow', {}, I('right', dark)) : null);
    return h('div.ui-menu', {},
      mi('bulb', 'Show Context Actions', 'Alt+Enter'), mi('paste', 'Paste', 'Ctrl+V'), mi('copy', 'Copy / Paste Special', '', true),
      mi(null, 'Column Selection Mode', 'Alt+Shift+Ins'), h('div.sep'),
      mi('search', 'Find Usages', 'Alt+F7'), h('div.sep'),
      mi(null, 'Go To', '', true), mi('collapseAll', 'Folding', '', true), mi('filter', 'Analyze', '', true), h('div.sep'),
      mi('edit', 'Refactor', '', true), mi('add', 'Generate…', 'Alt+Ins'), h('div.sep'),
      mi('play', 'Run \'Game\'', 'Ctrl+Shift+F10'), mi('debug', 'Debug \'Game\''), h('div.sep'),
      mi('history', 'Local History', '', true), mi('diff', 'Compare with Clipboard'));
  };
  return [
    card({ name: 'Контекстное меню', api: '.ui-menu > .item(.ic, .sc, .arrow) · .sep', cls: 'left top', sample: menu,
      note: 'иконка 16px, подпись, шорткат справа, стрелка подменю, разделители. Тот же вид — у меню редактора' }),
  ];
}

const TREE_DEMO = [
  { label: 'Appearance and Behavior', open: true, kids: [{ label: 'Appearance', sel: true }, { label: 'Menus and Toolbar' }, { label: 'System Settings', kids: [{ label: 'Updates' }] },
    { label: 'File Colors' }, { label: 'Scopes', kids: [{ label: 'Local' }] }, { label: 'Notifications' }, { label: 'Path Variables' }] },
  { label: 'Keymap' }, { label: 'Editor', kids: [{ label: 'General' }, { label: 'Font' }] }, { label: 'Plugins' },
  { label: 'Version Control', kids: [{ label: 'Git' }] }, { label: 'Build, Execution, Deployment', kids: [{ label: 'Compiler' }] }, { label: 'Tools', kids: [{ label: 'Terminal' }] },
];
const PROJECT_DEMO = [
  { label: 'mashit', hint: '~/mashit', ic: 'folder', open: true, kids: [
    { label: 'data', ic: 'folder', open: true, kids: [{ label: 'ui', ic: 'folder', kids: [{ label: 'title.json', ic: 'json' }] },
      { label: 'anims', ic: 'folder', kids: [] }, { label: 'mobs.json', ic: 'json', sel: true }] },
    { label: 'editor', ic: 'folder', kids: [{ label: 'README.md', ic: 'text' }] },
    { label: 'server', ic: 'folder', open: true, kids: [{ label: 'index.js', ic: 'code' }, { label: 'room.js', ic: 'code' }] },
    { label: 'package.json', ic: 'json' }] },
];

function trow({ depth = 0, open, ic: k, label, hint, sel, off, check }, dark) {
  return h(`div.row${sel ? '.sel' : ''}${off ? '.off' : ''}`, { style: { paddingLeft: `${4 + depth * 18}px` } },
    h('span.tw', {}, open == null ? null : I(open ? 'down' : 'right', dark)),
    check != null ? checkEl(check ? 'is-checked' : '', '') : null,
    k ? I(k, dark) : null, h('span', {}, label), hint ? h('span.hint', {}, hint) : null);
}

// живое дерево: клик по шеврону — раскрыть, по строке — выделить; без фокуса выделение серое
function liveTree(data, dark) {
  const el = h('div.ui-tree.live', { tabIndex: 0, onfocus: () => el.classList.add('touched') });
  const nodes = structuredClone(data);
  let sel = null;
  const walk = (list, fn, depth = 0) => list.forEach(n => { fn(n, depth); if (n.kids && n.open) walk(n.kids, fn, depth + 1); });
  walk(nodes, n => { if (n.sel) sel = n; });
  const draw = () => {
    el.replaceChildren();
    walk(nodes, (n, depth) => {
      const r = trow({ depth, open: n.kids ? !!n.open : null, ic: n.ic, label: n.label, hint: n.hint, sel: n === sel }, dark);
      r.querySelector('.tw').onclick = e => { e.stopPropagation(); n.open = !n.open; draw(); };
      r.onclick = () => { sel = n; draw(); };
      r.ondblclick = () => { if (n.kids) { n.open = !n.open; draw(); } };
      el.append(r);
    });
  };
  draw();
  el.addEventListener('keydown', e => {
    const flat = [];
    walk(nodes, n => flat.push(n));
    const i = flat.indexOf(sel);
    if (e.key === 'ArrowDown' && i < flat.length - 1) sel = flat[i + 1];
    else if (e.key === 'ArrowUp' && i > 0) sel = flat[i - 1];
    else if (e.key === 'ArrowRight' && sel?.kids) sel.open = true;
    else if (e.key === 'ArrowLeft' && sel?.kids) sel.open = false;
    else return;
    e.preventDefault();
    draw();
  });
  return el;
}

function sectionTree() {
  return [
    card({ name: 'Строка дерева · состояния', api: '.ui-tree > .row(.sel|.off) > .tw + иконка + текст', cls: 'col',
      sample: d => h('div.ui-tree', {}, spec([
        ['Default', trow({ open: false, ic: 'folder', label: 'Text' }, d)],
        ['Selected', trow({ open: false, ic: 'folder', label: 'Text', sel: true }, d)],
        ['Inactive', trow({ open: false, ic: 'folder', label: 'Text', sel: true, off: true }, d)]])),
      note: 'Inactive — выделение в списке без фокуса (--ui-sel-off)' }),
    card({ name: 'Варианты строк', api: 'trow({ depth, open, ic, label, hint, check })', cls: 'col',
      sample: d => h('div.ui-tree', {}, spec([
        ['Expanded node', trow({ open: true, ic: 'folder', label: 'Text' }, d)],
        ['Collapsed node', trow({ open: false, ic: 'folder', label: 'Text' }, d)],
        ['1st level', trow({ open: true, ic: 'folder', label: 'Text' }, d)],
        ['2nd level', trow({ depth: 1, open: false, ic: 'folder', label: 'Text' }, d)],
        ['Without icon', trow({ open: false, label: 'Text' }, d)],
        ['Without chevron', trow({ label: 'Text' }, d)],
        ['With hint', trow({ open: false, label: 'Text', hint: 'Hint' }, d)],
        ['With checkbox', trow({ open: false, label: 'Text', check: false }, d)]])),
      note: 'отступ уровня 18px, до 7 уровней' }),
    card({ name: 'Живое дерево · настройки', api: 'liveTree(data) — клик, двойной клик, ←↑↓→', cls: 'left top',
      sample: d => liveTree(TREE_DEMO, d), note: 'щёлкните вне дерева — выделение станет «неактивным»' }),
    card({ name: 'Живое дерево · проект', api: 'иконки nodes/folder, fileTypes/*', cls: 'left top',
      sample: d => liveTree(PROJECT_DEMO, d), note: 'так выглядит Hierarchy редактора: шевроны и иконки из набора' }),
  ];
}

function tabStrip(items, d, { closable = true, icons = true, slim = false, sel = 0, inactive = false } = {}) {
  const el = h(`div.ui-tabs${slim ? '.slim' : ''}`);
  let cur = sel;
  const draw = () => el.replaceChildren(...items.map(([label, k], i) => {
    const t = h(`div.ui-tab${i === cur ? (inactive ? '.off' : '.on') : ''}`, { onclick: () => { cur = i; draw(); } },
      icons && k ? I(k, d) : null, label,
      closable ? h('span.x', { title: 'Закрыть', onclick: e => { e.stopPropagation(); items.splice(i, 1); if (cur >= items.length) cur = items.length - 1; draw(); } }, I('closeSmall', d)) : null);
    return t;
  }));
  draw();
  return el;
}

function sectionTabs() {
  const one = (mods, d, dim) => h(`div.ui-tab${cls(mods)}${dim ? '.dim' : ''}`, {}, I('folder', d), 'Text', h('span.x', {}, I('closeSmall', d)));
  return [
    card({ name: 'Вкладка · состояния', api: '.ui-tab(.is-hover|.on|.off) > иконка + текст + .x', wide: true, cls: 'left',
      sample: d => h('table.uk-table', { style: { width: 'auto' } },
        h('tr', {}, ['Default', 'Hovered', 'Selected', 'Inactive'].map(s => h('th', { style: { padding: '0 24px 6px 0' } }, s))),
        h('tr', {}, ['', 'is-hover', 'on', 'off'].map(m => h('td', { style: { paddingRight: '24px' } }, h('div.ui-tabs.bare', {}, one(m, d))))),
        h('tr', {}, ['', 'is-hover', 'on', 'off'].map(m => h('td', { style: { paddingRight: '24px', paddingTop: '10px' } }, h('div.ui-tabs.bare', {}, one(m, d, !m))))),
      ),
      note: 'Inactive — выбранная вкладка в окне без фокуса (серая полоса). Крестик виден на hover и у выбранной; вторая строка — вкладки с приглушённым текстом' }),
    card({ name: 'Вкладки редактора', api: "tabStrip([['scene.json', 'json'], …])", wide: true, cls: 'left col',
      sample: d => tabStrip([['title.json', 'json'], ['main_menu.json', 'json'], ['engine.js', 'code'], ['logo.png', 'image'], ['hyper_kai.json', 'blueprint']], d, { sel: 2 }),
      note: 'клик — выбрать, × — закрыть; так же оформлены вкладки панелей редактора' }),
    card({ name: 'Вкладки без иконок', api: '.ui-tabs > .ui-tab (без .x)', cls: 'left col',
      sample: d => tabStrip([['Info'], ['Versions'], ['Encryption'], ['Tags']], d, { closable: false, icons: false }) }),
  ];
}

// ---------- Тулбары ----------
const tb = (d, ...items) => h('div.ui-tb', {}, items.map(x => x === '|' ? h('span.sep') : x));
const tbtn = (k, d, title, mods = '') => h(`button.b${cls(mods)}`, { title }, I(k, d));

function sectionToolbar() {
  return [
    card({ name: 'Тулбары', api: '.ui-tb > button.b · .sep · .dd · .ui-tb.float / .vert', wide: true, cls: 'left',
      sample: d => spec([
        ['Horizontal toolbar', tb(d, tbtn('locate', d, 'Выделить открытый файл'), tbtn('expandAll', d, 'Развернуть всё'), tbtn('collapseAll', d, 'Свернуть всё'), tbtn('more', d, 'Ещё'), tbtn('remove', d, 'Свернуть панель'))],
        ['With separators', tb(d, tbtn('refresh', d, 'Обновить'), tbtn('download', d, 'Скачать', 'drop'), '|', tbtn('add', d, 'Добавить'), '|', tbtn('play', d, 'Запустить (F5)'), tbtn('debug', d, 'Отладка'), tbtn('stop', d, 'Стоп (Shift+F5)'))],
        ['Floating toolbar', h('div.ui-tb.float', {}, tbtn('refresh', d, 'Применить изменения'), tbtn('close', d, 'Скрыть'))],
        ['Vertical toolbar', h('div.ui-tb.vert', {}, tbtn('stop', d, 'Стоп'), h('span.sep'), tbtn('settings', d, 'Настройки'), h('span.sep'), tbtn('pin', d, 'Закрепить'), tbtn('eye', d, 'Вид', 'drop'))],
        ['With dropdowns', tb(d, h('span.dd', {}, 'User', I('down', d)), h('span.dd', {}, 'Date: ', h('b', {}, 'Since 31.05.2026'), I('down', d)), '|', tbtn('add', d, 'Добавить фильтр'))],
        ['With buttons', tb(d, h('button.b.txt', {}, I('folder', d), 'Sources'), h('button.b.txt', {}, I('folder', d), 'Tests'))],
        ['Search field', tb(d, search({ placeholder: 'Search', bare: true, dark: d }), '|', tbtn('add', d, 'Добавить'))],
      ]),
      note: 'кнопка 26×26, иконка 16px, hover — --ui-hover; .drop — треугольник «есть варианты»; наведите на кнопки — тултипы New UI' }),
  ];
}

// ---------- Таблицы и диалоги ----------
function table(cols, rows, { sel = -1, grid = false, toolbar, d = true, dd = [], icons } = {}) {
  let cur = sel;
  const body = h('tbody');
  const draw = () => body.replaceChildren(...rows.map((r, i) => h(`tr${i === cur ? '.sel' : ''}`, { onclick: () => { cur = i; draw(); } },
    r.map((c, j) => h(`td${dd.includes(j) ? '.dd' : ''}`, {}, j === 0 && icons ? I(icons, d) : null, c, dd.includes(j) ? I('down', d) : null)))));
  draw();
  return h(`div.ui-table${grid ? '.grid' : ''}`, {},
    toolbar ? h('div.tbar', {}, h('div.ui-tb', {}, toolbar.map(k => tbtn(k, d, { add: 'Добавить', remove: 'Удалить', edit: 'Изменить', copy: 'Копировать', moveUp: 'Выше', moveDown: 'Ниже' }[k])))) : null,
    h('table', {}, cols ? h('thead', {}, h('tr', {}, cols.map(c => h('th', {}, c)))) : null, body),
    h('div.empty'));
}

function sectionTable() {
  return [
    card({ name: 'Простая таблица', api: '.ui-table > table (thead/tbody, tr.sel)', cls: 'left top',
      sample: d => h('div', { style: { width: '100%' } }, table(['Column', 'Column', 'Column'], [['Text', 'Text', 'Text'], ['Text', 'Text', 'Text'], ['Text', 'Text', 'Text']], { d })),
      note: 'строка 24px, клик выделяет строку' }),
    card({ name: 'Тулбар над таблицей', api: "table(cols, rows, { toolbar: ['add', 'remove', 'edit', 'copy'] })", cls: 'left top',
      sample: d => h('div', { style: { width: '100%' } }, table(['Key', 'Value (optional)'], [['purpose', 'used_by_studio'], ['field', 'beach'], ['stage_name', 'true']], { toolbar: ['add', 'remove', 'edit', 'copy'], d })) }),
    card({ name: 'Ячейка с выпадающим списком', api: "td.dd — шеврон справа", cls: 'left top',
      sample: d => h('div', { style: { width: '100%' } }, table(['Class, package, or member', 'Scope'], [['server.game.engine.Game', 'IDE'], ['server.room.Room', 'Project'], ['public.render.Renderer', 'Project']], { toolbar: ['add', 'remove'], dd: [1], sel: 1, d })) }),
    card({ name: 'Одна колонка с иконками', api: "table(null, rows, { icons: 'folder' })", cls: 'left top',
      sample: d => h('div', { style: { width: '260px' } }, table(null, [['graphics/units'], ['graphics/system/menu_title1…'], ['graphics/field']], { icons: 'folder', sel: 1, d })) }),
  ];
}

function dialog(d, { onClose } = {}) {
  return h('div.ui-dialog', {},
    h('div.ttl', {}, 'Preferences', h('span.x', { title: 'Закрыть', onclick: onClose }, I('close', d))),
    tabStrip([['Info'], ['Versions'], ['Encryption'], ['Tags']], d, { closable: false, icons: false, slim: true }),
    h('div.bd', {},
      h('div.ui-row', {}, 'Track storage cost or other criteria by tagging your bucket. ', h('a.ui-link', {}, 'Learn more', I('externalLink', d, 12))),
      h('div.ui-row', {}, h('div', { style: { flex: 1 } }, table(['Key', 'Value (optional)'], [['purpose', 'used_by_terraform'], ['terraform', 'true'], ['stage_name', 'true']], { toolbar: ['add', 'remove'], d })))),
    h('div.ft', {}, h('span.help', { title: 'Справка' }, '?'), h('span.grow'),
      h('button.ui-btn.secondary', { onclick: onClose }, 'Cancel'), h('button.ui-btn.secondary.is-disabled', {}, 'Apply'), h('button.ui-btn.primary', { onclick: onClose }, 'OK')));
}

function prefsDialog(d) {
  const colors = { Yellow: '#5E4D33', Green: '#375239', Violet: '#3B3147' }, light = { Yellow: '#FFF6BD', Green: '#D4FAD7', Violet: '#E4CEFF' };
  const sw = c => h('span.sw', { style: { background: (d ? colors : light)[c] } }, c);
  return h('div.ui-dialog', { style: { width: '760px', maxWidth: 'none', flexShrink: '0' } },
    h('div.ttl', {}, 'Preferences'),
    h('div', { style: { display: 'grid', gridTemplateColumns: '220px 1fr', borderTop: '1px solid var(--ui-sep)', minHeight: '300px' } },
      h('div', { style: { borderRight: '1px solid var(--ui-sep)', padding: '8px 0', display: 'flex', flexDirection: 'column', gap: '6px' } },
        h('div', { style: { padding: '0 8px' } }, search({ placeholder: '', dark: d })),
        liveTree(TREE_DEMO.map(n => ({ ...n, kids: n.kids?.map(k => ({ ...k, sel: k.label === 'File Colors' })) })), d)),
      h('div.bd', {},
        h('div', {}, h('span.dim', {}, 'Appearance & Behavior  ›  '), h('b', {}, 'File Colors')),
        h('div', { style: { display: 'flex', gap: '16px' } }, checkEl('is-checked', 'Enable file colors'), checkEl('', 'Use in editor tabs'), checkEl('is-checked', 'Use in project view')),
        table(['Scope', 'Color', 'Share through VCS'], [['Non-Project Files', sw('Yellow'), checkEl('', '')], ['Tests', sw('Green'), checkEl('', '')], ['CIDR', sw('Violet'), checkEl('is-checked', '')]],
          { toolbar: ['add', 'remove', 'moveUp', 'moveDown'], dd: [1], d }),
        h('div', { style: { color: 'var(--ui-fg-dim)', fontSize: '12px' } }, 'Files can belong to several scopes. If there are two colors for one scope, the color of the first scope in the list is used.'),
        h('a.ui-link', {}, 'Manage scopes…'))),
    h('div.ft', {}, h('span.help', {}, '?'), h('span.grow'), h('button.ui-btn.secondary', {}, 'Cancel'), h('button.ui-btn.secondary.is-disabled', {}, 'Apply'), h('button.ui-btn.primary', {}, 'OK')));
}

function sectionDialog() {
  return [
    card({ name: 'Диалог с вкладками', api: '.ui-dialog > .ttl + .ui-tabs + .bd + .ft', cls: 'top',
      sample: dialog, note: 'подвал: справка «?», Cancel / Apply (disabled, пока нет изменений) / OK (primary)' }),
    card({ name: 'Настройки: дерево + таблица', api: 'ui-dialog + liveTree + table(dd, checkbox)', wide: true, cls: 'top',
      sample: prefsDialog, note: 'поиск над деревом, хлебные крошки, чекбоксы, таблица с цветной ячейкой-списком, пояснение и ссылка' }),
  ];
}

const SE_ACTIONS = [
  ['Show whitespaces', 'Preferences › Appearance', null], ['Appearance: Show inner whitespaces', null, true],
  ['Appearance: Show leading whitespaces', null, true], ['Appearance: Show trailing whitespaces', null, true],
  ['Appearance: Show whitespaces', null, false], ['Scene: Show grid', 'Scene', true], ['Game: legacy screens', 'Game', false],
  ['Save All', 'Ctrl+S', null], ['Run Game Server', 'F5', null], ['Check Data', 'F7', null],
];

function searchEverywhere(d) {
  let q = 'show whi', sel = 1;
  const list = h('div.list');
  const draw = () => {
    const hit = SE_ACTIONS.filter(([t]) => t.toLowerCase().includes(q.toLowerCase()));
    sel = Math.min(sel, hit.length - 1);
    list.replaceChildren(...hit.map(([t, loc, on], i) => h(`div.r${i === sel ? '.sel' : ''}`, { onclick: () => { sel = i; draw(); } },
      h('span', {}, t), on == null ? h('span.loc', {}, loc || '') : onOff(on))));
  };
  const inp = h('input', { value: q, spellcheck: false, oninput: () => { q = inp.value; sel = 0; draw(); },
    onkeydown: e => { if (e.key === 'ArrowDown') { sel++; draw(); } if (e.key === 'ArrowUp' && sel > 0) { sel--; draw(); } } });
  draw();
  return h('div.ui-se', {},
    h('div.top', {}, tabStrip([['All'], ['Classes'], ['Files'], ['Symbols'], ['Actions']], d, { closable: false, icons: false, sel: 4 }),
      h('div.opts', {}, checkEl('', 'Include non-project items'), h('div.ui-tb', {}, tbtn('filter', d, 'Фильтр'), tbtn('open', d, 'Открыть в окне')))),
    h('div.q', {}, I('search', d), inp, h('span.dim', {}, 'Type / to see commands')),
    list,
    h('div.foot', {}, 'Press ', kbd('Alt+↑'), ' or ', kbd('Alt+↓'), ' to navigate search history'));
}

function sectionPopups() {
  return [
    card({ name: 'Search Everywhere', api: '.ui-se > .top(.ui-tabs) + .q + .list > .r(.sel) + .foot', wide: true, cls: 'top',
      sample: searchEverywhere, note: 'живой: ввод фильтрует действия, ↑/↓ выбирают строку, ON/OFF переключаются' }),
  ];
}

// ---------- Подсказки ----------
function sectionTooltips() {
  const sample = (...n) => h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px', alignItems: 'flex-start' } }, ...n);
  return [
    card({ name: 'Tooltip', api: "tipContent('Сохранить всё (Ctrl+S)')", cls: 'left',
      sample: () => sample(tipContent('Action name'), tipContent('Action name (Ctrl+Alt+A)')),
      note: 'шорткат в скобках в конце title отделяется и рисуется приглушённым' }),
    card({ name: 'Tooltip с заголовком', api: "tipContent('Header\\nТекст…', { shortcut, link })", cls: 'left',
      sample: () => tipContent('Header\nExplain behavior that is not clear from the setting or action name.', { shortcut: 'Ctrl+Alt+A', link: { text: 'External' } }),
      note: 'многострочный title: первая строка — заголовок' }),
    card({ name: 'Глобальные тултипы', api: 'initTooltips() — main.js; любой title="…" в редакторе', cls: 'left',
      sample: d => tb(d, tbtn('save', d, 'Сохранить всё (Ctrl+S)'), tbtn('undo', d, 'Отменить (Ctrl+Z)'), tbtn('play', d, 'Запустить игру\nПоднимает игровой сервер и открывает вкладку Game (F5)'), tbtn('settings', d, 'Настройки')),
      note: 'наведите на кнопки: системный title заменяется тултипом New UI (задержка 450 мс)' }),
  ];
}

function sectionGotIt() {
  const link = { text: 'Help resources' };
  return [
    card({ name: 'Got It · по умолчанию', api: "gotItCard({ header, text, button })", cls: 'top',
      sample: () => gotItCard({ header: 'Header', text: 'A Got It tooltip informs users about a new or changed feature and gives basic information about it.', button: 'Got It' }) }),
    card({ name: 'Ссылка после текста', api: 'gotItCard({ …, link: { text, href } })', cls: 'top',
      sample: () => gotItCard({ header: 'Header', text: 'A Got It tooltip informs users about a new or changed feature and gives basic information about it.', link, button: 'Got It' }) }),
    card({ name: 'Ссылка в тексте', api: "text: [ 'A Got It … ', h('a', {}, 'new or changed feature'), … ]", cls: 'top',
      sample: () => gotItCard({ header: 'Header', text: ['A Got It tooltip informs users about a ', h('a', {}, 'new or changed feature'), ' and gives basic information about it.'], button: 'Got It' }) }),
    card({ name: 'Иллюстрация + шаг', api: 'gotItCard({ ill, step: 1 })', cls: 'top',
      sample: d => gotItCard({ ill: h('div.ill', {}, I('scene', true, 48)), step: 1, header: 'Header', text: 'A Got It tooltip informs users about a new or changed feature and gives basic information about it.', button: 'Got It' }) }),
    card({ name: 'Иконки действий в тексте', api: 'стрелка снизу — { bottom: true }', cls: 'top',
      sample: () => gotItCard({ bottom: true, header: 'Header', text: ['Step Into ', I('down', true, 14), ' will take you to the first line of code in a method you stand on. Step Out ', I('up', true, 14), ' will return to the calling method.'], button: 'Got It' }),
      note: 'иконка всегда идёт после названия действия' }),
    card({ name: 'Шорткат в тексте', api: "text: ['Press ', kbd('Ctrl+F8'), ' to …']", cls: 'top',
      sample: () => gotItCard({ bottom: true, step: 2, header: 'Header', text: ['Press ', kbd('Ctrl+F8'), ' to add another breakpoint in your code'], button: 'Got It' }) }),
    card({ name: 'Живой Got It', api: 'gotIt(anchorEl, { header, text, step })', cls: 'left',
      sample: () => { const b = h('button.ui-btn.primary', {}, 'Показать у этой кнопки'); b.onclick = () => gotIt(b, { header: 'Новое в maistep', text: ['UI Kit теперь с навигацией, поиском и темами. Нажмите ', kbd('8'), ' — вкладка Build.'], button: 'Понятно' }); return b; },
      note: 'появляется рядом с элементом, стрелка указывает на него; кнопка закрывает' }),
  ];
}

// ---------- Клавиши, код, прокрутка ----------
const KEYS = [ // клавиши через «|»
  ['Letter / Digit', 'A|9', 'A|9'], ['Alt / Option', 'Alt', '⌥'], ['Control / Command', 'Ctrl', '⌘'], ['Shift', 'Shift', '⇧ Shift'],
  ['Spacebar', 'Space', 'Space'], ['Escape', 'Esc', '⎋ Esc'], ['Enter / Return', 'Enter', '↩ Return'], ['Backspace / Delete', 'Backspace', '⌫ Del'],
  ['Forward Delete', 'Del', 'Fn|⌫ Del'], ['Arrows', '↑|↓|←|→', '↑|↓|←|→'], ['Page Up', 'Pg Up', 'Pg Up'], ['Page Down', 'Pg Down', 'Pg Down'],
  ['Home', 'Home', 'Home'], ['End', 'End', 'End'], ['Tab', 'Tab', '⇥ Tab'], ['Caps Lock', 'Caps Lock', '⇪ Caps Lock'],
];
const STUDIO_KEYS = [
  ['Сохранить всё', 'Ctrl+S'], ['Отменить / Повторить', 'Ctrl+Z · Ctrl+Y'], ['Дублировать ноду', 'Ctrl+D'], ['Удалить выбранное', 'Del'],
  ['Запуск воркфлоу', 'Ctrl+Enter'], ['Прервать запуск', 'Ctrl+Shift+Enter'], ['Выключить ноду', 'M'], ['Вписать граф', 'F'],
  ['Снять выделение', 'Esc'], ['Запустить / остановить / перезапустить сервер', 'F5 · Shift+F5 · Ctrl+F5'], ['Проверить граф', 'F7'],
  ['Рабочие области', '1 … 4'], ['Найти ноду', 'Space'],
];
const keyCell = s => h('span.ui-keys', {}, s.split('|').map(k => h('kbd.ui-key', {}, k)));
const comboCell = s => h('span', { style: { display: 'inline-flex', gap: '8px', alignItems: 'center' } }, s.split(' · ').map(c => /…/.test(c) ? h('span', {}, c.split(' … ').map(kbd).reduce((a, b) => [a, ' … ', b])) : kbd(c)));

function sectionKeys() {
  return [
    card({ name: 'Клавиши', api: "kbd('Ctrl+Shift+F5') · kbd.ui-key", cls: 'col',
      sample: () => [h('div.ui-keys', {}, ['Key 1', 'Key 2', 'Key 3'].map(k => h('kbd.ui-key', {}, k))), kbd('Ctrl+Shift+F5')],
      note: 'комбинация через «+» → отдельные клавиши' }),
    card({ name: 'Код в тексте', api: 'code.ui-code', sample: () => h('code.ui-code', {}, 'code sample'),
      note: 'моноширинный JetBrains Mono в рамке — пути, id, команды' }),
    card({ name: 'Горячие клавиши maistep', api: 'main.js → keys()', cls: 'left top',
      sample: () => h('table.uk-table', {}, STUDIO_KEYS.map(([a, k]) => h('tr', {}, h('td', {}, a), h('td', {}, comboCell(k))))) }),
    card({ name: 'Названия клавиш', api: 'Windows / Linux и macOS', wide: true, cls: 'left top',
      sample: () => h('table.uk-table', { style: { width: 'auto' } },
        h('tr', {}, h('th', { style: { width: '200px' } }, 'Key'), h('th', { style: { width: '220px' } }, 'Windows / Linux'), h('th', {}, 'macOS')),
        KEYS.map(([n, w, m]) => h('tr', {}, h('td', {}, n), h('td', {}, keyCell(w)), h('td', {}, keyCell(m))))) }),
  ];
}

function sectionScroll() {
  const lines = h('div.ui-scroll', { style: { height: '120px', width: '220px', overflow: 'auto', border: '1px solid var(--ui-sep)', borderRadius: '4px' } },
    h('div', { style: { width: '420px', padding: '6px 8px' } }, Array.from({ length: 24 }, (_, i) => h('div', {}, `${String(i + 1).padStart(2, '0')}  строка прокручиваемого списка`))));
  return [
    card({ name: 'Полоса прокрутки', api: '.ui-thumb.v / .ui-thumb.h (.is-hover)', cls: 'left',
      sample: () => h('table.uk-table', { style: { width: 'auto' } },
        h('tr', {}, h('th'), h('th', { style: { padding: '0 30px 8px 0' } }, 'Default'), h('th', {}, 'Hovered')),
        h('tr', {}, h('td.meta', {}, 'Vertical'), h('td', {}, h('span.ui-thumb.v')), h('td', {}, h('span.ui-thumb.v.is-hover'))),
        h('tr', {}, h('td.meta', {}, 'Horizontal'), h('td', { style: { paddingTop: '14px' } }, h('span.ui-thumb.h')), h('td', { style: { paddingTop: '14px' } }, h('span.ui-thumb.h.is-hover')))) }),
    card({ name: 'Живая прокрутка', api: '.ui-scroll (элемент) · .ui-scrollbars (все потомки)', cls: 'left',
      sample: () => lines.cloneNode(true), note: 'в редакторе .ui-scrollbars стоит на body — все панели прокручиваются так' }),
  ];
}

// ---------- страница ----------
const SECTIONS = [
  ['Основы', [
    ['typo', 'Типографика', 'Inter для интерфейса, JetBrains Mono для кода и логов', sectionTypo],
    ['palette', 'Палитра и токены', 'цвета New UI и семантические токены --ui-*', sectionPalette],
    ['icons', 'Иконки', 'набор New UI в editor/ui/icons', sectionIcons],
    ['spacing', 'Отступы', 'правила Spacing: группы 20, строки 6/4, колонки 60, диалоги 8/20', sectionSpacing],
  ]],
  ['Элементы управления', [
    ['buttons', 'Кнопки', 'default, split, slim, с иконкой', sectionButtons],
    ['checks', 'Чекбоксы', 'все состояния, группы, вложенность', sectionChecks],
    ['radio', 'Радио', 'состояния, группы, в настройках', sectionRadio],
    ['toggles', 'Переключатели', 'тумблер, ON/OFF, сегменты', sectionToggles],
    ['selects', 'Выпадающие списки', 'dropdown вместо <select>, Label: Text, попап', sectionSelects],
    ['search', 'Поиск', 'поле поиска с очисткой', sectionSearch],
    ['numbers', 'Числовые поля', 'стрелки, протяжка, диапазоны', sectionNumbers],
    ['color', 'Цвет', 'поле цвета и колор-пикер с прозрачностью', sectionColor],
  ]],
  ['Навигация и данные', [
    ['menu', 'Меню', 'контекстное меню', sectionMenu],
    ['tree', 'Деревья', 'строки, состояния, живые примеры', sectionTree],
    ['tabs', 'Вкладки', 'состояния, вкладки редактора и диалогов', sectionTabs],
    ['toolbar', 'Тулбары', 'горизонтальный, вертикальный, плавающий', sectionToolbar],
    ['table', 'Таблицы', 'простая, с тулбаром, со списком в ячейке', sectionTable],
  ]],
  ['Окна и подсказки', [
    ['dialog', 'Диалоги', 'настройки с вкладками, деревом и таблицей', sectionDialog],
    ['messages', 'Сообщения', 'вопрос, ошибка, предупреждение', sectionMessages],
    ['popups', 'Search Everywhere', 'попап поиска действий', sectionPopups],
    ['tooltip', 'Тултипы', 'action name, шорткат, заголовок и ссылка', sectionTooltips],
    ['gotit', 'Got It', 'подсказки о новых функциях', sectionGotIt],
    ['keys', 'Клавиши и код', 'шорткаты, клавиши, inline-код', sectionKeys],
    ['scroll', 'Прокрутка', 'полосы прокрутки', sectionScroll],
  ]],
];

let query = '';
let main = null, nav = null;

function applyFilter() {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  for (const sec of main.querySelectorAll('.uk-sec')) {
    const title = sec.dataset.q;
    let n = 0;
    for (const c of sec.querySelectorAll('.uk-card')) {
      const ok = words.every(w => c.dataset.q.includes(w) || title.includes(w));
      c.classList.toggle('hidden', !ok);
      n += ok;
    }
    sec.classList.toggle('hidden', !n);
    const it = nav.querySelector(`[data-id="${sec.id.slice(3)}"]`);
    it.classList.toggle('empty', !n);
    it.querySelector('.n').textContent = n;
  }
}

function spy() {
  const top = main.scrollTop + 60;
  let id = null;
  for (const sec of main.querySelectorAll('.uk-sec:not(.hidden)')) if (sec.offsetTop <= top) id = sec.id.slice(3);
  nav.querySelectorAll('.it').forEach(it => it.classList.toggle('on', it.dataset.id === id));
}

function build() {
  const v = document.getElementById('v-uikit');
  if (!v) return;
  const keep = main?.scrollTop || 0;
  main = h('div.uk-main');
  nav = h('div.uk-nav');
  for (const [grp, list] of SECTIONS) {
    nav.append(h('div.grp', {}, grp));
    for (const [id, title, about, fn] of list) {
      const cards = fn();
      nav.append(h('div.it', { 'data-id': id, onclick: () => main.scrollTo({ top: document.getElementById(`uk-${id}`).offsetTop - 4 }) }, title, h('span.n', {}, cards.length)));
      main.append(h('div.uk-sec#uk-' + id, { 'data-q': `${title} ${about}`.toLowerCase() },
        h('div.hd', {}, h('h3', {}, title), h('span.dim', {}, about)),
        h('div.uk-grid', {}, cards)));
    }
  }
  main.addEventListener('scroll', spy, { passive: true });
  main.addEventListener('click', e => { const c = e.target.closest('.uk-code'); if (c) copy(c.textContent); });
  const themes = h('div.uk-seg', {}, [['dark', 'Dark'], ['light', 'Light'], ['both', 'Обе']].map(([t, l]) => h(`span${prefs.theme === t ? '.on' : ''}`, {
    title: 'Тема образцов', onclick: () => { prefs.theme = t; savePrefs(); build(); },
  }, l)));
  const q = search({ placeholder: 'Найти компонент: tree, кнопка, tooltip…', value: query, onInput: val => { query = val; applyFilter(); spy(); } });
  v.replaceChildren(h('div.uk', {},
    h('div.uk-top', {}, h('h2', {}, 'UI Kit'), h('span.dim', {}, 'JetBrains New UI · компоненты maistep'), h('span.grow'), q, themes),
    nav, main));
  if (query) applyFilter();
  main.scrollTop = keep;
  spy();
}

export function initUIKit() {
  addView('uikit', 'UI Kit', build);
  on('project', () => { if (isShown('uikit')) build(); });
}
