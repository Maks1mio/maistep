// Модели ControlNet для вкладок (ToColar, ImageNaizer): что лежит в библиотеке (папка controlnet), строки
// моделей-компонентов (components.json → models) и скачивание по кнопке прямо из вкладки. Вид подписывается на
// событие 'cn-models' (список изменился) и 'cn-line' (строка прогресса загрузки).
import { h } from './util.js';
import { S, on, emit } from './store.js';
import { icon } from './icons.js';
import { componentsStatus, installComponents } from './backend.js';
import { loadLibrary } from './library.js';
import { openWorkspace } from './dock.js';

// вид опоры → компонент и как узнать подходящий файл (по порядку предпочтения)
export const CN = {
  lines: { id: 'controlnet-lineart-anime', title: 'ControlNet Lineart Anime', find: [/lineart|manga.?line/i, /union|scribble|canny/i] },
  tile: { id: 'controlnet-tile', title: 'ControlNet Tile', find: [/tile/i, /union/i] },
};
let names = null, rows = {}, line = '', loading = null;
const log = (level, text) => emit('log', { src: 'editor', level, text });

export const cnNames = () => names;
export const cnRow = kind => rows[CN[kind].id] || null;
export const cnBusy = kind => S.componentsJob?.state === 'running' && (S.componentsJob.ids || []).includes(CN[kind].id);

// выбранный файл (если он есть в библиотеке) или первый подходящий виду
export function cnPick(kind, want = '') {
  if (!names) return '';
  if (want && names.includes(want)) return want;
  for (const re of CN[kind].find) { const n = names.find(x => re.test(x)); if (n) return n; }
  return '';
}

export function loadCn(refresh = false) {
  if (!S.server.running) return Promise.resolve();
  if (loading && !refresh) return loading;
  loading = Promise.all([loadLibrary(refresh), componentsStatus({}).catch(() => null)]).then(([lib, comp]) => {
    if (lib) names = lib.items.filter(i => i.cat === 'controlnet').map(i => i.name);
    if (comp) rows = Object.fromEntries(comp.components.filter(c => c.kind === 'model').map(c => [c.id, c]));
    emit('cn-models');
  }).finally(() => { loading = null; });
  return loading;
}

export async function downloadCn(kind) {
  const row = cnRow(kind);
  try {
    const r = await installComponents([CN[kind].id], 'missing');
    if (r.error && !r.job) throw new Error(r.error);
    S.componentsJob = r.job; line = 'начинаю загрузку…';
    log('info', `ControlNet: загрузка ${row?.package || CN[kind].id} (${row?.size || '2,5 ГБ'}) — прогресс и в «Компонентах»`);
  } catch (e) { log('error', `ControlNet: ${e.message}`); }
  emit('cn-models');
}

// карточка «модели нет»: что нужно, кнопка «Скачать» и переход в «Компоненты»; cls — классы кнопок вкладки
export function cnMissing(kind, { why = '', fallback = '', slim = true } = {}) {
  const row = cnRow(kind), busy = cnBusy(kind);
  const text = names == null ? 'Проверяю модели ControlNet…'
    : busy ? `Скачивается ${row?.title || CN[kind].title}: ${line || '…'}`
      : `Модель не установлена: ${row?.title || CN[kind].title} (${row?.size || '2,5 ГБ'}).${why ? ` ${why}` : ''}`;
  const b = slim ? '.ui-btn.slim' : '';
  return h('div.cn-miss', { 'data-cn': kind },
    h('div.cn-miss-t', {}, text),
    names == null ? null : h('div.row', { style: { gap: '6px', flexWrap: 'wrap' } },
      h(`button${b}.primary`, { type: 'button', disabled: busy || !S.server.running || !row, onclick: () => downloadCn(kind) },
        icon('download', { size: 14 }), busy ? 'Скачивается…' : `Скачать${row?.size ? ` (${row.size})` : ''}`),
      h(`button${b}${slim ? '.secondary' : ''}`, { type: 'button', onclick: () => openWorkspace('components'), 'data-tip': 'Вкладка «Компоненты» — модели и пакеты' }, 'Компоненты')),
    fallback ? h('div.hint.cn-miss-h', {}, fallback) : null);
}

on('component-log', d => {
  if (!Object.keys(CN).some(cnBusy)) return;
  line = String(d.text || '').trim();
  for (const el of document.querySelectorAll('.cn-miss')) {
    const t = el.querySelector('.cn-miss-t');
    if (t && cnBusy(el.dataset.cn)) t.textContent = `Скачивается ${cnRow(el.dataset.cn)?.title || 'ControlNet'}: ${line}`;
  }
});
on('components', d => {
  const ids = d.job?.ids || [];
  if (!Object.values(CN).some(c => ids.includes(c.id))) return;
  if (d.job.state === 'running') { emit('cn-models'); return; }
  line = '';
  if (d.job.state !== 'done') log('error', `ControlNet: ${d.job.error || d.job.state}`);
  loadCn(true);
});
on('library-changed', () => { if (names != null) loadCn(); });
on('server', s => { names = null; rows = {}; if (s.running) setTimeout(() => loadCn(), 900); else emit('cn-models'); });
