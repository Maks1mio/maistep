// maistep — точка входа веб-UI: меню, шапка (сервер, запуск, очередь), горячие клавиши, события ядра.
import { h, num, confirmBox } from './util.js';
import { icon } from './icons.js';
import { S, on, emit, loadProject, saveAll, dirtyDocs, undo, redo, select } from './store.js';
import { invoke, listen, isTauri, openExternal } from './api.js';
import { initDock, addView, showView, startDock, openWorkspace, resetLayout, workspace } from './dock.js';
import { initConsole } from './console.js';
import { initHierarchy, newWorkflow, draw as drawHierarchy } from './hierarchy.js';
import { initInspector } from './inspector.js';
import { initProject, loadAssets } from './project.js';
import { initGraph, graphKeys, checkGraph, fit } from './graph.js';
import { initNodeInspector } from './nodeinsp.js';
import { initResults } from './results.js';
import { initLibrary, loadLibrary } from './library.js';
import { initCodeEditor } from './codeedit.js';
import { initUIKit } from './uikit.js';
import { initComponents, showComponents, componentsStartupCheck } from './components.js';
import { initCivitai, showCivitai } from './civitai.js';
import { initAgent, showAgent, showChat } from './agent.js';
import { initNaizer, showNaizer } from './naizer.js';
import { initTocolar, showTocolar } from './tocolar.js';
import { initVideo, showVideo } from './video.js';
import { initPersist, restore, autosaveOn, setAutosave } from './persist.js';
import { initTooltips, messageBox } from './kit.js';
import { initBackend, queuePrompt, interrupt, clearQueue, reloadNodes, api, updateStatus } from './backend.js';
import { openSettings } from './settings.js';
import { initMagic } from './magic.js';
import { initImages } from './images.js';
import { initPromptWeights } from './promptedit.js';
import { initContextMenu } from './ctxmenu.js';
import { initStats, toggleStats, statsShown, logsReport, openLogs } from './stats.js';

const $ = id => document.getElementById(id);
const log = (level, text, src = 'editor') => emit('log', { src, level, text });

// ---------- сервер исполнения (Python) ----------
const PORT_KEY = 'maistep-port';
// у окна и веб-режима разные порты по умолчанию — иначе их серверы делят 3300
const PORT_DEF = isTauri ? 3300 : 3310;
let portPref = (() => { try { return Number(localStorage.getItem(PORT_KEY)) || PORT_DEF; } catch { return PORT_DEF; } })();
const port = () => portPref;
function setPort(v) { portPref = Math.max(1, Math.min(65535, v | 0)) || PORT_DEF; try { localStorage.setItem(PORT_KEY, portPref); } catch {} serverUi(S.server); }

// Процесс Python запущен ≠ сервер готов: порт он открывает через несколько секунд (импорты, загрузка нод), а модули
// по событию 'server' сразу идут к нему — отсюда были «диалоги / библиотека моделей: Failed to fetch» при старте.
// Поэтому «запущен» объявляем, только когда GET / ответил; до того — «Запуск…».
let probe = 0, waiting = null;
async function serverReady(p) {
  const my = ++probe;
  for (let i = 0; i < 480; i++) { // до 2 минут
    if (my !== probe) return false;
    try { if ((await fetch(`http://localhost:${p}/`, { cache: 'no-store' })).ok) return my === probe; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return my === probe ? null : false; // null — так и не ответил
}

function serverUi(st) {
  if (st.running && !S.server.running) {
    const key = `${st.port}:${st.pid}`;
    $('srv-dot').className = 'busy';
    $('srv-text').textContent = 'Запуск…';
    if (waiting === key) return;
    waiting = key;
    serverReady(st.port).then(ok => {
      if (waiting !== key || ok === false) return;
      waiting = null;
      if (ok === null) log('warn', `сервер :${st.port} не отвечает 2 минуты — смотрите консоль (источник «Сервер»)`);
      applyServer(st);
    });
    return;
  }
  probe++; waiting = null;
  applyServer(st);
}

function applyServer(st) {
  const changed = S.server.running !== !!st.running || S.server.port !== st.port || S.server.pid !== st.pid;
  S.server = { ...S.server, ...st, running: !!st.running };
  if (changed) emit('server', S.server);
  const on_ = !!st.running;
  $('runw').classList.toggle('on', on_);
  $('srv-dot').className = on_ ? 'on' : '';
  $('srv-text').textContent = on_ ? `Сервер · :${st.port}` : 'Сервер';
  $('tb-server').dataset.tip = on_ ? `Python-сервер :${st.port}${st.pid ? ` (pid ${st.pid})` : ''}\nПорт, перезагрузка нод` : `Сервер остановлен\nПорт ${port()}`;
  $('tb-stop').disabled = !on_;
  $('tb-restart').disabled = !on_;
  queueUi();
}

function queueUi() {
  const q = S.queue || { running: null, pending: [] };
  const n = (q.running ? 1 : 0) + q.pending.length;
  $('tb-queue').textContent = n ? `${n}` : '';
  $('tb-queue').classList.toggle('on', !!n);
  $('tb-interrupt').disabled = !q.running;
  const r = S.run;
  $('runw').classList.toggle('busy', !!q.running);
  if (r?.progress?.max) $('tb-progress').style.width = `${Math.round(100 * r.progress.value / r.progress.max)}%`;
  else $('tb-progress').style.width = q.running ? '100%' : '0';
}

async function startServer() {
  $('srv-dot').className = 'busy';
  $('srv-text').textContent = 'Запуск…';
  try {
    S.server.port = port();
    serverUi(await invoke('server_start', { port: port() }));
  } catch (e) { log('error', String(e)); serverUi(S.server); }
}
async function stopServer() { serverUi(await invoke('server_stop')); }
async function restartServer() { await stopServer(); await startServer(); }

async function reloadProject() {
  if (dirtyDocs().length && !(await confirmBox('Есть несохранённые изменения — они пропадут. Перезагрузить проект с диска?', { title: 'Перезагрузить проект', ok: 'Перезагрузить' }))) return;
  await loadProject();
}

// ---------- меню ----------
const MENU = [
  ['Файл', [
    ['Новый воркфлоу…', 'Ctrl+N', () => { openWorkspace('graph'); newWorkflow(); }],
    ['Из шаблона «SD: txt2img»…', '', () => { openWorkspace('graph'); newWorkflow('sd_txt2img'); }],
    ['Из шаблона «SD: Magic KSampler»…', '', () => { openWorkspace('graph'); newWorkflow('sd_magic'); }],
    ['Из шаблона «SD: img2img»…', '', () => { openWorkspace('graph'); newWorkflow('sd_img2img'); }],
    ['Из шаблона «Идея → LLM-промпт → SD»…', '', () => { openWorkspace('graph'); newWorkflow('sd_idea_llm'); }],
    ['Из шаблона «Чат»…', '', () => { openWorkspace('graph'); newWorkflow('chat'); }],
    '-',
    ['Сохранить всё', 'Ctrl+S', () => saveAll()],
    [() => `${autosaveOn() ? '✓ ' : ''}Автосохранение`, '', () => setAutosave(!autosaveOn())],
    ['Перезагрузить проект с диска', '', () => reloadProject()],
    '-',
    ['Настройки…', 'Ctrl+,', () => openSettings()],
  ]],
  ['Правка', [['Отменить', 'Ctrl+Z', undo], ['Повторить', 'Ctrl+Y', redo]]],
  ['Вид', [
    ['Workflow', '1', () => openWorkspace('graph')], ['Results', '2', () => openWorkspace('results')],
    ['Models', '3', () => openWorkspace('library')], ['Civitai', '4', () => openWorkspace('civitai')], ['CodeEditor', '5', () => openWorkspace('code')],
    ['Компоненты и обновления', '6', () => openWorkspace('components')], ['ImageNaizer', '7', () => openWorkspace('naizer')],
    ['ToColar', '8', () => openWorkspace('tocolar')], ['Видео', '', () => openWorkspace('video')], ['AI Chat', '0', () => openWorkspace('chat')], ['UI Kit', '9', () => openWorkspace('uikit')], '-',
    ['Вписать граф', 'F', fit],
    [() => `${statsShown() ? '✓ ' : ''}Статистика системы (CPU, RAM, GPU)`, 'Ctrl+Shift+M', toggleStats],
    ['Сбросить раскладку рабочей области', '', () => resetLayout()],
  ]],
  ['Запуск', [
    ['Запустить воркфлоу', 'Ctrl+Enter', () => queuePrompt()], ['Запустить ×4', '', () => queuePrompt(undefined, 4)],
    ['Прервать', 'Ctrl+Shift+Enter', interrupt], ['Очистить очередь', '', clearQueue], '-',
    ['Проверить граф', 'F7', checkGraph],
  ]],
  ['Сервер', [
    ['Запустить', 'F5', startServer], ['Остановить', 'Shift+F5', stopServer], ['Перезапустить', 'Ctrl+F5', restartServer], '-',
    ['Перезагрузить ноды', '', reloadNodes], ['Пересканировать модели', '', () => loadLibrary(true)], ['Освободить память (выгрузить модели)', '', freeMemory], '-',
    ['Производительность и лимиты…', '', () => openSettings('perf')], ['MCP-серверы…', '', () => openSettings('mcp')], ['llama.cpp…', '', () => openSettings('llama')], '-',
    ['Компоненты и обновления…', '', () => openWorkspace('components')],
    ['Открыть API в браузере', '', () => openExternal(`http://localhost:${S.server.port}/api/nodes`)],
  ]],
  ['Справка', [
    ['Собрать отчёт об ошибке (логи)…', '', logsReport],
    ['Открыть папку логов', '', openLogs], '-',
    ['О программе', '', () => about()],
  ]],
];

function buildMenu() {
  const bar = $('menubar');
  const close = () => bar.querySelectorAll('.m.open').forEach(m => m.classList.remove('open'));
  bar.replaceChildren(...MENU.map(([title, items]) => {
    const m = h('div.m', {}, title, h('div.drop', {}, items.map(it => it === '-' ? h('hr') : h('div', { onclick: e => { e.stopPropagation(); close(); it[2](); } }, h('span', {}, typeof it[0] === 'function' ? it[0]() : it[0]), h('kbd', {}, it[1])))));
    m.addEventListener('click', e => { e.stopPropagation(); const was = m.classList.contains('open'); close(); if (!was) m.classList.add('open'); });
    m.addEventListener('mouseenter', () => { if (bar.querySelector('.m.open') && !m.classList.contains('open')) { close(); m.classList.add('open'); } });
    return m;
  }));
  addEventListener('click', close);
}

// ---------- попапы шапки ----------
let pop = null;
function closePop() { pop?.remove(); pop = null; document.querySelectorAll('#header .open').forEach(b => b.classList.remove('open')); }
function openPop(anchor, ...content) {
  const was = pop?.anchor === anchor;
  closePop();
  if (was) return;
  pop = h('div.runpop', { onclick: e => e.stopPropagation() }, ...content);
  pop.anchor = anchor;
  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(innerWidth - pop.offsetWidth - 4, r.left))}px`;
  pop.style.top = `${r.bottom + 6}px`;
  anchor.classList.add('open');
}
const popItem = (ic, label, kbd, fn, dis) => h(`div.it${dis ? '.dis' : ''}`, { onclick: () => { closePop(); fn(); } },
  ic ? icon(ic, { size: 16 }) : h('span', { style: { width: '16px' } }), h('span', {}, label), kbd ? h('kbd', {}, kbd) : null);

function serverPopup() {
  const on_ = S.server.running;
  openPop($('tb-server'),
    h('div.hd', {}, h(`span.pdot${on_ ? '.on' : ''}`), h('b', {}, on_ ? `Сервер запущен · :${S.server.port}` : 'Сервер остановлен'), on_ && S.server.pid ? h('span.dim', {}, `pid ${S.server.pid}`) : null),
    h('div.f', {}, h('span.dim', {}, 'Порт'), num(port(), v => setPort(v), { int: true, min: 1, max: 65535 }), h('span.dim', { style: { fontSize: '12px' } }, on_ ? 'после перезапуска' : '')),
    h('div.dim', { style: { padding: '0 10px 8px', fontSize: '12px' } }, `нод в каталоге: ${Object.keys(S.nodes).length}`),
    h('hr'),
    on_ ? popItem('restart', 'Перезапустить', 'Ctrl+F5', restartServer) : popItem('play', 'Запустить', 'F5', startServer),
    popItem('stop', 'Остановить', 'Shift+F5', stopServer, !on_),
    h('hr'),
    popItem('refresh', 'Перезагрузить ноды (custom_nodes)', '', reloadNodes, !on_),
    popItem('delete', 'Освободить память (выгрузить модели)', '', freeMemory, !on_),
    popItem('settings', 'Настройки…', 'Ctrl+,', () => openSettings(), false),
    popItem('externalLink', 'Открыть API в браузере', '', () => openExternal(`http://localhost:${S.server.port}/`), !on_));
}

async function freeMemory() {
  try { await api('/api/free', {}); log('ok', 'модели выгружены, кэш нод сброшен'); } catch (e) { log('error', `освобождение памяти: ${e.message}`); }
}

const projectName = () => S.project?.root?.split(/[\\/]/).filter(Boolean).pop() || 'проект';
function projectPopup() {
  const n = dirtyDocs().length;
  openPop($('tb-project'),
    h('div.hd', {}, icon('folder', { size: 16 }), h('b', {}, projectName())),
    h('div.dim', { style: { padding: '0 10px 8px', fontSize: '12px', wordBreak: 'break-all' } }, S.project?.root || ''),
    h('hr'),
    popItem('save', n ? `Сохранить всё (${n})` : 'Всё сохранено', 'Ctrl+S', () => saveAll(), !n),
    popItem('refresh', 'Перезагрузить проект с диска', '', reloadProject),
    popItem('add', 'Новый воркфлоу…', 'Ctrl+N', () => newWorkflow()));
}

// ---------- статус ----------
function status(text) { $('st-left').textContent = text; }
function updateDirty() {
  const n = dirtyDocs().length;
  $('st-right').textContent = `${n ? `● не сохранено: ${n}` : 'всё сохранено'} · ${isTauri ? 'Tauri' : 'веб-режим (dev-server)'}`;
  document.title = `${n ? '● ' : ''}maistep`;
  $('tb-dirty').textContent = n;
  $('tb-dirty').classList.toggle('on', !!n);
  if (S.project?.root) $('tb-project-name').textContent = projectName();
}

// версия — как в «Компонентах»: manifest.json установленной копии, в git-копии — package.json (сервер);
// без сервера — версия ядра (она отстаёт, если обновление не меняло Rust)
async function about() {
  let v = '';
  try { v = (await updateStatus()).installed || ''; } catch {}
  if (!v && isTauri) { try { v = await window.__TAURI__.app.getVersion(); } catch {} }
  messageBox({ img: 'icons/maistep.svg', title: 'maistep', ok: 'Закрыть', cancel: null,
    text: `Версия ${v || '—'} · Tauri v2 + Python\nНодовый редактор AI-пайплайнов: графы из нод (LLM, текст, картинки, логика), очередь запусков на Python-сервере, стриминг ответов прямо на ноды, свои ноды на Python в custom_nodes/.` });
}

function keys(e) {
  const k = e.key.toLowerCase(), typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
  if (e.ctrlKey && k === 's') { e.preventDefault(); saveAll(); return; }
  if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); if (e.shiftKey) interrupt(); else queuePrompt(); return; }
  if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (e.ctrlKey && k === 'n') { e.preventDefault(); newWorkflow(); return; }
  if (e.ctrlKey && !typing && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && !typing && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
  if (e.key === 'F5') { e.preventDefault(); if (e.ctrlKey) restartServer(); else if (e.shiftKey) stopServer(); else startServer(); return; }
  if (e.key === 'F7') { e.preventDefault(); checkGraph(); return; }
  if (e.ctrlKey && e.shiftKey && k === 'm') { e.preventDefault(); toggleStats(); return; }
  if (!typing && !e.ctrlKey && !e.altKey && e.key === '0') { openWorkspace('chat'); return; }
  if (!typing && !e.ctrlKey && !e.altKey && /^[1-9]$/.test(e.key)) { openWorkspace(['graph', 'results', 'library', 'civitai', 'code', 'components', 'naizer', 'tocolar', 'uikit'][+e.key - 1]); return; }
  if (!typing && graphKeys(e)) { e.preventDefault(); return; }
  if (e.key === 'Escape' && !typing) select(null);
}

async function boot() {
  initTooltips();
  initDock();
  initConsole();
  buildMenu();
  initBackend();
  initHierarchy();
  initInspector();
  initNodeInspector();
  initContextMenu();
  initStats();
  initProject();
  initGraph();
  initMagic();
  initImages();
  initPromptWeights();
  initResults();
  initLibrary();
  initCodeEditor();
  initComponents();
  initCivitai();
  initAgent();
  initNaizer();
  initTocolar();
  initVideo();
  initPersist();
  addView('graph', 'Workflow', () => setCtxQuiet('workflow'));
  addView('results', 'Results', () => setCtxQuiet('results'));
  addView('library', 'Models', () => setCtxQuiet('library'));
  addView('civitai', 'Civitai', () => { setCtxQuiet('civitai'); showCivitai(); });
  addView('code', 'CodeEditor', () => setCtxQuiet('code'));
  addView('components', 'Компоненты', () => { setCtxQuiet('components'); showComponents(); });
  addView('naizer', 'ImageNaizer', () => { setCtxQuiet('naizer'); showNaizer(); });
  addView('tocolar', 'ToColar', showTocolar);
  addView('video', 'Видео', showVideo);
  addView('chat', 'AI Chat', showChat);
  initUIKit(); // addView('uikit') — последней вкладкой
  addView('agent', 'AI Agent', showAgent, 'ai'); // панель, не рабочая область: ставится в любую область через ⋮
  startDock();
  S.ctx = { graph: 'workflow', results: 'results', library: 'library', civitai: 'civitai', code: 'code', components: 'components', naizer: 'naizer' }[workspace()] || S.ctx; // до первого кадра — Hierarchy сразу в контексте области

  $('tb-save').onclick = () => saveAll();
  $('tb-undo').onclick = undo;
  $('tb-redo').onclick = redo;
  $('tb-run').onclick = () => queuePrompt();
  $('tb-interrupt').onclick = interrupt;
  $('tb-results').onclick = () => openWorkspace('results');
  $('tb-components').onclick = () => openWorkspace('components');
  $('tb-check').onclick = checkGraph;
  $('tb-settings').onclick = () => openSettings();
  on('port-changed', v => setPort(v));
  $('tb-server').onclick = e => { e.stopPropagation(); serverPopup(); };
  $('tb-project').onclick = e => { e.stopPropagation(); projectPopup(); };
  $('tb-stop').onclick = stopServer;
  $('tb-restart').onclick = restartServer;
  addEventListener('click', closePop);
  addEventListener('keydown', e => { if (e.key === 'Escape') closePop(); });
  if (!S.server.running) S.server.port = port();
  serverUi(S.server);
  addEventListener('keydown', keys);
  addEventListener('beforeunload', e => { if (dirtyDocs().length && !autosaveOn()) { e.preventDefault(); e.returnValue = ''; } });

  on('status', status);
  on('autosave', buildMenu);
  on('change', updateDirty);
  on('saved', updateDirty);
  on('project', updateDirty);
  on('server-start', startServer);
  on('queue', queueUi);
  for (const ev of ['run-start', 'run-progress', 'run-node', 'run-done']) on(ev, queueUi);
  on('log', l => { if (l.level === 'error') { $('statusbar').classList.add('err'); status(l.text.split('\n')[0]); setTimeout(() => $('statusbar').classList.remove('err'), 2500); } });

  await listen('console', l => emit('log', l));
  await listen('server', serverUi);

  try {
    await loadProject();
    restore();
    status(`Проект: ${S.project.root}`);
    log('ok', `проект загружен: ${S.project.root} — воркфлоу ${S.docs.workflow.size}`);
  } catch (e) {
    log('error', `не удалось загрузить проект: ${e}`);
    return;
  }
  drawHierarchy();
  loadAssets();
  setInterval(watchData, 2000);
  uiTimer = setInterval(watchUi, 1000);
  const st = await invoke('server_status');
  if (st.running) serverUi(st);
  else await startServer(); // каталог нод и запуски — через Python-сервер
  setTimeout(componentsStartupCheck, 2500);
}

// ---------- правки workflows/ извне (git, другой редактор, ИИ-ассистент) ----------
let stamp = null, ownUntil = 0;
const snapshot = () => Object.fromEntries([...S.docs.workflow].map(([id, d]) => [id, JSON.stringify(d.data)]));

async function watchData() {
  let now;
  try { now = await invoke('data_stamp'); } catch { return; }
  if (stamp === null || Date.now() < ownUntil) { stamp = now; return; }
  if (now === stamp) return;
  stamp = now;
  if (dirtyDocs().length) { log('warn', 'файлы workflows/ изменены извне, но в редакторе есть несохранённые правки — Файл → Перезагрузить проект, когда будете готовы'); return; }
  const before = snapshot(), sel = S.sel;
  await loadProject();
  const after = snapshot();
  const changed = Object.keys({ ...before, ...after }).filter(k => before[k] !== after[k]);
  if (!changed.length) return;
  log('info', `изменено извне: ${changed.join(', ')} — проект перезагружен`);
  if (sel) select(sel);
}
on('saved', () => { ownUntil = Date.now() + 2500; });

// ---------- правки интерфейса (app/ui грузится с диска) ----------
// Стили подменяются на лету, остальное (js, html) — перезагрузка окна: открытые документы сначала сохраняются,
// а пока идёт ввод в поле — ждём, чтобы не потерять набранное.
let uiStamp = null, uiTimer = 0;
async function watchUi() {
  let now;
  try { now = await invoke('ui_stamp'); } catch { clearInterval(uiTimer); return; } // старое ядро без команды
  if (uiStamp === null) { uiStamp = now; return; }
  if (now === uiStamp) return;
  const [css, rest] = now.split('/'), [css0, rest0] = uiStamp.split('/');
  if (rest !== rest0) {
    const el = document.activeElement;
    if (el?.matches?.('input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable]') && el.value !== '') return;
    if (dirtyDocs().length) {
      if (!autosaveOn()) { uiStamp = now; log('warn', 'интерфейс обновлён на диске, но есть несохранённые правки — сохраните и перезагрузите окно (F5)'); return; }
      await saveAll();
    }
    location.reload();
    return;
  }
  uiStamp = now;
  if (css !== css0) {
    for (const l of document.querySelectorAll('link[rel=stylesheet]')) { // новый лист рядом, старый — после загрузки: без мигания
      const n = l.cloneNode();
      n.href = `${l.href.split('?')[0]}?v=${Date.now()}`;
      n.onload = n.onerror = () => l.remove();
      l.after(n);
    }
    log('info', 'стили интерфейса обновлены');
  }
}

function setCtxQuiet(ctx) {
  if (S.ctx !== ctx) { S.ctx = ctx; drawHierarchy(); }
}

boot();
