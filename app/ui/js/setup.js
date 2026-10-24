// Установщик и удаление maistep (setup.html, команды setup_* ядра — app/src-tauri/src/setup.rs).
// Установка portable: всё в выбранной папке; вне её — только ярлыки, если их отметить.
// В обычном браузере (проверка вёрстки) команды подменяются заглушками.
const T = window.__TAURI__;
const call = (cmd, args = {}) => T ? T.core.invoke(cmd, args) : MOCK[cmd]?.(args);
const listen = (evt, fn) => T?.event.listen(evt, e => fn(e.payload));

const MOCK = {
  setup_info: () => ({ mode: location.hash === '#uninstall' ? 'uninstall' : 'install', version: '0.0.0', dir: 'C:\\Users\\user\\AppData\\Local\\Programs\\maistep', data: ['workflows', 'user'] }),
  setup_check_dir: ({ dir }) => ({ ok: /^[a-z]:\\/i.test(dir), exists: false, empty: true, installed: null, error: 'укажите полный путь' }),
  setup_pick_dir: ({ current }) => current,
  setup_install: async () => { for (let i = 0; i <= 10; i++) { progress({ stage: 'files', done: i, total: 10 }); await new Promise(r => setTimeout(r, 120)); } return {}; },
};

function h(tag, attrs = {}, ...kids) {
  const [name, ...cls] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (cls.length) el.className = cls.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : String(k));
  return el;
}

const root = document.getElementById('setup');
let info = null, bar = null, stageEl = null;

const head = (title, sub) => h('div.st-head', {}, h('img', { src: 'icons/maistep.svg', alt: '' }),
  h('div', {}, h('h1', {}, title), h('div.sub', {}, sub)));
const foot = (...kids) => h('div.st-foot', {}, ...kids);
const btn = (cls, text, onclick, attrs = {}) => h(`button.ui-btn.${cls}`, { onclick, ...attrs }, text);
const check = (label, hint, checked) => {
  const input = h('input', { type: 'checkbox', checked });
  return { el: h('label.ui-check.col', {}, input, h('span.lbl', {}, label), hint ? h('span.hint', {}, hint) : null), input };
};
const show = (...kids) => root.replaceChildren(...kids);
const close = () => T ? call('setup_close') : window.close();

const STAGES = { files: 'Копирование файлов', python: 'Загрузка Python 3.12', 'python-unpack': 'Распаковка Python и создание .venv' };
const mb = n => `${(n / 1048576).toFixed(1)} МБ`;
function progress(p) {
  if (!bar) return;
  const pct = p.total ? Math.round(100 * p.done / p.total) : 0;
  bar.style.width = `${pct}%`;
  stageEl.replaceChildren(h('span', {}, STAGES[p.stage] || p.stage),
    h('span', {}, p.stage === 'python' && p.total ? `${mb(p.done)} из ${mb(p.total)}` : `${pct}%`));
}

// ---------- установка ----------
function installScreen() {
  const input = h('input', { value: info.dir, spellcheck: false });
  const note = h('div.st-note');
  const desktop = check('Ярлык на рабочем столе', null, true);
  const linux = info.os === 'linux';
  const menu = check(linux ? 'Ярлык в меню приложений' : 'Ярлык в меню «Пуск»', null, linux);
  const python = check('Портативный Python 3.12', `скачать ~${linux ? 34 : 22} МБ в папку приложения — не нужен Python в системе`, true);
  const go = btn('primary', 'Установить', () => runInstall(input.value, desktop.input.checked, menu.input.checked, python.input.checked));
  let seq = 0;
  const validate = async () => {
    const my = ++seq, r = await call('setup_check_dir', { dir: input.value });
    if (my !== seq) return;
    go.disabled = !r.ok;
    note.className = 'st-note';
    if (!r.ok) { note.classList.add('bad'); note.textContent = r.error; }
    else if (r.installed) { note.classList.add('ok'); note.textContent = `Здесь maistep ${r.installed} — файлы приложения обновятся, графы, ключи и картинки останутся.`; go.textContent = 'Обновить'; return; }
    else if (r.exists && !r.empty) { note.classList.add('warn'); note.textContent = 'Папка не пуста — maistep будет установлен прямо в неё.'; }
    else note.textContent = r.exists ? '' : 'Папка будет создана.';
    go.textContent = 'Установить';
  };
  input.addEventListener('input', validate);
  show(
    head(`Установка maistep ${info.version}`, 'Нодовый редактор AI-пайплайнов'),
    h('div.st-body', {},
      h('div', {}, h('div.st-label', {}, 'Папка установки'),
        h('div.st-path', {}, input, btn('secondary', 'Обзор…', async () => {
          const p = await call('setup_pick_dir', { current: input.value });
          if (p) { input.value = p; validate(); }
        })),
        note),
      h('div.st-opts', {}, desktop.el, menu.el, python.el),
      h('div.st-box', {}, h('b', {}, 'Portable: '), 'всё приложение и его данные (графы, настройки, Python, кэш окна) живут в этой папке. ',
        'Реестр и AppData не используются — папку можно перенести или удалить целиком.')),
    foot(h('span.grow'), btn('secondary', 'Отмена', close), go));
  validate();
  input.focus();
}

async function runInstall(dir, desktop, startMenu, python) {
  bar = h('i'); stageEl = h('div.st-stage');
  show(head('Установка…', dir), h('div.st-body', {}, h('div.st-prog', {}, bar), stageEl), foot(h('span.grow')));
  progress({ stage: 'files', done: 0, total: 1 });
  try {
    await call('setup_install', { dir, desktop, startMenu, python });
    doneScreen(dir);
  } catch (e) {
    show(head('Не удалось установить', dir), h('div.st-body', {}, h('div.st-err', {}, String(e))),
      foot(h('span.grow'), btn('secondary', 'Закрыть', close), btn('primary', 'Назад', installScreen)));
  }
}

function doneScreen(dir) {
  const launch = check('Запустить maistep', null, true);
  show(
    head('maistep установлен', dir),
    h('div.st-body', {},
      h('div.st-big', {}, 'Готово.'),
      h('div.st-box', {}, 'Удалить можно файлом ', h('b', {}, info.os === 'linux' ? 'uninstall.sh' : 'uninstall.cmd'), ' в папке приложения. ',
        'Обновления приходят сами: изменившиеся файлы скачиваются в фоне и применяются при перезапуске.'),
      launch.el),
    foot(btn('secondary', 'Открыть папку', () => call('setup_open_dir', { dir })), h('span.grow'),
      btn('primary', 'Готово', () => launch.input.checked && T ? call('setup_launch', { dir }) : close())));
}

// ---------- удаление ----------
function uninstallScreen() {
  const keep = check('Сохранить мои данные', `${(info.data || []).join(', ') || 'workflows, user, input, output'} — графы, ключи API, картинки`, true);
  show(
    head(`Удаление maistep ${info.version}`, info.dir),
    h('div.st-body', {},
      h('div', {}, 'Будут удалены файлы приложения, .venv и портативный Python', info.shortcuts?.length ? ', ярлыки' : '', '. Другие файлы в папке не трогаются.'),
      keep.el,
      h('div.st-box', {}, 'Если данные сохранить, папка останется только с ними — при повторной установке в неё всё подхватится.')),
    foot(h('span.grow'), btn('secondary', 'Отмена', close), btn('danger', 'Удалить', async () => {
      try {
        await call('setup_uninstall', { keepData: keep.input.checked });
        show(head('maistep удалён', info.dir), h('div.st-body', {}, h('div.st-big', {}, keep.input.checked ? 'Данные остались в папке.' : 'Файлы приложения и данные удалены.')),
          foot(h('span.grow'), btn('primary', 'Закрыть', close)));
      } catch (e) {
        show(head('Не удалось удалить', info.dir), h('div.st-body', {}, h('div.st-err', {}, String(e))), foot(h('span.grow'), btn('primary', 'Закрыть', close)));
      }
    })));
}

listen('setup-progress', progress);
info = await call('setup_info');
document.title = info.mode === 'uninstall' ? 'Удаление maistep' : 'Установка maistep';
(info.mode === 'uninstall' ? uninstallScreen : installScreen)();
