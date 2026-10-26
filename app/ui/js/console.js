// Console: логи Python-сервера, запусков графов, редактора и проверки.
import { h } from './util.js';
import { icon } from './icons.js';
import { on } from './store.js';

const SRC = [['all', 'Все'], ['server', 'Сервер'], ['run', 'Запуски'], ['editor', 'Редактор'], ['check', 'Проверка'], ['agent', 'Агент']];
const lines = [];
let filter = 'all', errOnly = false;
const box = () => document.getElementById('console');

function row(l) {
  return h(`div.ln.${l.level}`, {}, h('span.t', {}, l.time), h('span.s', {}, l.src), h('span', {}, l.text));
}

export function log(src, level, text) {
  const l = { src, level: level || 'info', text: String(text), time: new Date().toTimeString().slice(0, 8) };
  lines.push(l);
  if (lines.length > 3000) lines.splice(0, 500);
  if (!visible(l)) return;
  const b = box(), body = document.getElementById('console-body');
  const atEnd = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  b.append(row(l));
  if (b.childElementCount > 1500) b.firstElementChild.remove();
  if (atEnd) body.scrollTop = body.scrollHeight;
  counts();
}

// последние строки для AI-агента (инструмент app_console): «чч:мм:сс [источник] уровень: текст»
export function recentLog(n = 80, src = 'all', errors = false) {
  const pick = lines.filter(l => (src === 'all' || l.src === src) && (!errors || l.level === 'error' || l.level === 'warn'));
  const out = pick.slice(-Math.max(1, Math.min(300, n | 0)));
  return out.length ? out.map(l => `${l.time} [${l.src}] ${l.level}: ${l.text}`).join('\n') : '(пусто)';
}

const visible = l => (filter === 'all' || l.src === filter) && (!errOnly || l.level === 'error' || l.level === 'warn');

function redraw() {
  box().replaceChildren(...lines.filter(visible).slice(-1500).map(row));
  const body = document.getElementById('console-body');
  body.scrollTop = body.scrollHeight;
  counts();
}

function counts() {
  const e = lines.filter(l => l.level === 'error').length, w = lines.filter(l => l.level === 'warn').length;
  document.getElementById('con-count').replaceChildren(icon('error', { size: 14 }), ` ${e}  `, icon('warning', { size: 14 }), ` ${w}`);
}

export function initConsole() {
  const bar = document.getElementById('console-bar');
  bar.append(
    h('div.ui-tb', {}, h('button.b', { 'data-tip': 'Очистить консоль', onclick: () => { lines.length = 0; redraw(); } }, icon('delete', { size: 14 }))),
    h('div.ui-seg', {}, SRC.map(([id, t]) => h(`button${id === filter ? '.on' : ''}`, {
      'data-f': id,
      onclick: e => { filter = id; bar.querySelectorAll('[data-f]').forEach(b => b.classList.toggle('on', b === e.currentTarget)); redraw(); },
    }, t))),
    h('label.row', {}, h('input', { type: 'checkbox', onchange: e => { errOnly = e.target.checked; redraw(); } }), 'только ошибки'),
    h('span.grow'), h('span.dim#con-count'),
  );
  on('log', l => log(l.src, l.level, l.text));
}
