// ToColar — раскраска чёрно-белых картинок (манга, комиксы, скетчи) пачкой. Каждая картинка — скрытый граф
// (id "tocolar"): Fit Image → VAE Encode → KSampler (img2img, denoise) → VAE Decode → Keep Lines. Последняя нода
// берёт светлоту из оригинала, а цвет — из генерации, поэтому линии, тон и текст остаются как нарисованы.
// Состояние (список, настройки) — localStorage; результаты — PNG в output/ (colored_*).
import { h } from './util.js';
import { S, on, emit } from './store.js';
import { icon } from './icons.js';
import { api, upload, fileUrl } from './backend.js';
import { imagePicker, imagesFromTransfer, imagesFromClipboard, clipboardHasImage, transferHasImage } from './images.js';
import { libraryPicker } from './library.js';
import { fetchRec } from './magic.js';
import { activeView } from './dock.js';

const LS = 'maistep-tocolar';
const log = (level, text) => emit('log', { src: 'tocolar', level, text });
const COLOR_POS = 'full color, colorized manga, vibrant colors, anime coloring, detailed shading';
const COLOR_NEG = 'monochrome, greyscale, black and white, sepia, desaturated, lineart only';
const DEF = { items: [], sel: 0, ckpt: '', prompt: '', negative: '', denoise: 0.6, strength: 1.0, shading: 0.6, megapixels: 1.0, seed: -1, steps: null, cfg: null, split: 0.5 };
let st = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(LS)) }; } catch { return { ...DEF }; } })();
let viewEl = null, rec = null, job = null, stopAll = false;
const keep = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch {} };
const ckptName = () => st.ckpt || S.nodes['sd.checkpoint']?.inputs?.ckpt_name?.default || '';
const cur = () => st.items[st.sel] || null;
const name = f => f.split('/').pop();

// ---------- список ----------
function add(files) {
  const have = new Set(st.items.map(i => i.src));
  const fresh = files.filter(f => f && !have.has(f));
  if (!fresh.length) return;
  st.items.push(...fresh.map(src => ({ src, out: null, status: 'new' })));
  st.sel = st.items.length - fresh.length;
  keep(); render();
}
async function addFromDisk(list) {
  const out = [];
  for (const f of list) {
    try { out.push(await upload(f)); } catch (e) { log('error', `загрузка ${f.name}: ${e.message} (сервер запущен?)`); }
  }
  add(out);
}
function remove(i) {
  if (job?.index === i) return;
  st.items.splice(i, 1);
  if (job && job.index > i) job.index--;
  st.sel = Math.max(0, Math.min(st.sel, st.items.length - 1));
  keep(); render();
}

// ---------- Magic: качество и параметры сэмплера под чекпоинт ----------
async function loadRec() {
  const ck = ckptName();
  if (!ck || !S.server.running) return;
  rec = await fetchRec({ ckpt: ck, loras: [] });
  render();
}

// ---------- запуск ----------
function graph(src) {
  const q = rec?.ok ? rec.prompt : { positive: 'masterpiece, best quality', negative: 'lowres, worst quality, bad anatomy' };
  const p = rec?.ok ? rec.params : {};
  const L = (from, out, to, inn) => ({ from, out, to, in: inn });
  return {
    id: 'tocolar', title: `ToColar: ${name(src)}`,
    nodes: [
      { id: 'ckpt', type: 'sd.checkpoint', props: { ckpt_name: ckptName() } },
      { id: 'skip', type: 'sd.clip_skip', props: { stop_at_clip_layer: rec?.clip_skip || -2 } },
      { id: 'pos', type: 'sd.text_encode', props: { text: [q.positive, COLOR_POS, st.prompt.trim()].filter(Boolean).join(', ') } },
      { id: 'neg', type: 'sd.text_encode', props: { text: [st.negative.trim() || q.negative, COLOR_NEG].filter(Boolean).join(', ') } },
      { id: 'img', type: 'image.load', props: { file: src } },
      { id: 'fit', type: 'image.fit', props: { megapixels: st.megapixels, multiple: 64 } },
      { id: 'enc', type: 'sd.vae_encode', props: {} },
      { id: 'ks', type: 'sd.ksampler', props: { seed: st.seed, steps: st.steps ?? p.steps ?? 25, cfg: st.cfg ?? p.cfg ?? 6,
        sampler_name: p.sampler_name || 'euler_ancestral', scheduler: p.scheduler || 'normal', denoise: st.denoise } },
      { id: 'dec', type: 'sd.vae_decode', props: {} },
      { id: 'keep', type: 'image.keep_lines', props: { strength: st.strength, shading: st.shading ?? 0.6, prefix: 'colored' } },
    ],
    links: [L('ckpt', 'clip', 'skip', 'clip'), L('skip', 'clip', 'pos', 'clip'), L('skip', 'clip', 'neg', 'clip'),
      L('img', 'image', 'fit', 'image'), L('fit', 'image', 'enc', 'pixels'), L('ckpt', 'vae', 'enc', 'vae'),
      L('ckpt', 'model', 'ks', 'model'), L('pos', 'conditioning', 'ks', 'positive'), L('neg', 'conditioning', 'ks', 'negative'),
      L('enc', 'latent', 'ks', 'latent_image'), L('dec', 'image', 'keep', 'colors'), L('ks', 'latent', 'dec', 'samples'),
      L('ckpt', 'vae', 'dec', 'vae'), L('img', 'image', 'keep', 'lines')],
    targets: ['keep'],
  };
}

async function start(only = null) {
  if (job) return;
  if (!S.server.running) { log('warn', 'сервер не запущен'); emit('server-start'); return; }
  if (!ckptName()) return log('warn', 'выберите чекпоинт (лучше аниме: Illustrious, Pony, NoobAI)');
  if (!rec) await loadRec();
  if (only == null) for (const it of st.items) if (it.status === 'err') it.status = 'new'; // ошибочные — ещё раз
  stopAll = false;
  next(only);
}

async function next(only = null) {
  const index = only ?? st.items.findIndex(i => i.status === 'new');
  const it = st.items[index];
  if (index < 0 || !it || stopAll) { job = null; render(); return; }
  const pid = crypto.randomUUID().replace(/-/g, '');
  job = { pid, index, step: 0, max: 0, preview: null, single: only != null };
  it.status = 'run';
  st.sel = index;
  render();
  try {
    await api('/api/prompt', { id: pid, workflow: graph(it.src) });
    if (job?.pid === pid) job.posted = true;
    log('info', `раскраска ${name(it.src)} · denoise ${st.denoise}`);
  } catch (e) {
    it.status = 'err'; job = null;
    for (const is of e.data?.issues || []) log('error', `нода ${is.node}: ${is.message}`);
    if (!e.data?.issues) log('error', `запуск: ${e.message}`);
    keep(); render();
  }
}

// конец запуска картинки (событие done или сверка с историей сервера)
function finish(d) {
  const it = st.items[job.index];
  const stopped = d.stopped || d.error?.message === 'прервано';
  if (d.ok && it && !it.out) { const f = (d.outputs?.keep?._ui || d.outputs?.keep?.ui)?.images?.[0]; if (f) { it.out = f; it.status = 'done'; } }
  if (!d.ok) {
    if (it) it.status = stopped ? 'new' : 'err';
    log(stopped ? 'warn' : 'error', `ToColar: ${stopped ? 'прервано' : d.error?.message?.split('\n')[0] || 'запуск не удался'}`);
  } else if (it && it.status !== 'done') it.status = 'err';
  const single = job.single;
  job = null; keep();
  if (single || stopAll || stopped) { render(); return; }
  next();
}

// события SSE теряются при обрыве связи (долгая генерация, перезапуск сервера) — сверяемся с очередью и историей
async function reconcile() {
  if (!job?.posted || !S.server.running) return;
  const pid = job.pid;
  try {
    const q = await api('/api/queue');
    if (q.running?.prompt_id === pid || q.pending?.some(p => p.prompt_id === pid)) return;
    const h = (await api('/api/history?limit=20')).find(x => x.prompt_id === pid);
    if (job?.pid === pid) finish(h ? { ok: h.ok, error: h.error, outputs: h.outputs } : { ok: false, error: { message: 'запуск потерялся (сервер перезапущен?)' } });
  } catch {}
}

function stop() {
  stopAll = true;
  if (job) api('/api/interrupt', {}).catch(() => {});
}

// ---------- отрисовка ----------
const field = (label, ctrl, hint) => h('div.tc-f', {}, h('label', {}, label), ctrl, hint ? h('div.tc-hint', {}, hint) : null);
function num(key, { min, max, step, ph }) {
  return h('input', { type: 'number', min, max, step, value: st[key] ?? '', placeholder: ph ?? '', onchange: e => {
    const v = e.target.value === '' ? null : Number(e.target.value);
    st[key] = v == null ? (DEF[key] ?? null) : v; keep(); render();
  } });
}

function settings() {
  const ck = ckptName();
  const p = rec?.ok ? rec.params : {};
  const ckBtn = h('button.ui-dd.tc-ck', { type: 'button', 'data-tip': 'Чекпоинт для раскраски',
    onclick: () => libraryPicker(ckBtn, { cat: 'checkpoints', value: ck, onPick: n => { st.ckpt = n; rec = null; keep(); loadRec(); render(); } }) },
    icon('image', { size: 16 }), h(`span.t${ck ? '' : '.ph'}`, {}, ck ? name(ck).replace(/\.\w+$/, '') : 'выберите чекпоинт'), h('span.chev', {}, icon('down', { size: 16 })));
  const ta = (key, ph) => h('textarea', { rows: 3, placeholder: ph, value: st[key], 'data-prompt-weight': '', oninput: e => { st[key] = e.target.value; keep(); } });
  return h('div.tc-side', {},
    h('div.tc-sec', {}, 'Модель'),
    field('Чекпоинт', ckBtn, rec?.ok ? `Magic: ${rec.profile || 'рекомендация'}` : 'аниме-чекпоинт (SDXL Illustrious/Pony) — лучше всего для манги'),
    h('div.tc-sec', {}, 'Цвет'),
    field('Подсказка', ta('prompt', 'например: blonde hair, blue eyes, red dress, sunset sky'), 'кто и какого цвета — по-русски тоже можно'),
    field('Негатив', ta('negative', rec?.ok ? rec.prompt.negative : 'lowres, worst quality')),
    field('Denoise', h('div.tc-rng', {}, h('input', { type: 'range', min: 0.3, max: 0.9, step: 0.05, value: st.denoise,
      oninput: e => { st.denoise = Number(e.target.value); e.target.nextSibling.textContent = st.denoise.toFixed(2); keep(); } }), h('b', {}, st.denoise.toFixed(2))),
      'меньше — ближе к исходной картинке, больше — смелее цвет (0.55–0.7)'),
    field('Насыщенность', h('div.tc-rng', {}, h('input', { type: 'range', min: 0, max: 1.5, step: 0.05, value: st.strength,
      oninput: e => { st.strength = Number(e.target.value); e.target.nextSibling.textContent = st.strength.toFixed(2); keep(); } }), h('b', {}, st.strength.toFixed(2)))),
    field('Тени', h('div.tc-rng', {}, h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: st.shading ?? 0.6,
      oninput: e => { st.shading = Number(e.target.value); e.target.nextSibling.textContent = st.shading.toFixed(2); keep(); } }), h('b', {}, (st.shading ?? 0.6).toFixed(2))),
      '0 — плоская заливка, 1 — вся светотень генерации; линии всегда из оригинала'),
    h('div.tc-sec', {}, 'Генерация'),
    h('div.tc-row', {},
      field('Размер, Мп', num('megapixels', { min: 0.3, max: 2.5, step: 0.1 })),
      field('Seed', num('seed', { min: -1, step: 1 }))),
    h('div.tc-row', {},
      field('Шаги', num('steps', { min: 1, max: 100, step: 1, ph: p.steps ?? 25 })),
      field('CFG', num('cfg', { min: 0, max: 30, step: 0.5, ph: p.cfg ?? 6 }))),
    h('div.tc-hint', {}, 'Линии, тон и текст берутся из оригинала — меняется только цвет. Результаты — в output/ (colored_*) и в Results.'));
}

function listEl() {
  return h('div.tc-list', {},
    ...st.items.map((it, i) => h(`div.tc-it${i === st.sel ? '.sel' : ''}`, { onclick: () => { st.sel = i; keep(); render(); } },
      h('img', { src: fileUrl(it.out || it.src), loading: 'lazy', alt: '', draggable: false }),
      h('div.tc-nm', {}, h('span', {}, name(it.src)),
        h(`span.tc-st.${it.status}`, {}, { new: 'ожидает', run: job?.index === i && job.max ? `шаг ${job.step}/${job.max}` : 'в работе…', done: 'готово', err: 'ошибка' }[it.status] || '')),
      h('span.ui-tb.tc-x', {}, h('button.b', { 'data-tip': 'Убрать из списка', onclick: e => { e.stopPropagation(); remove(i); } }, icon('closeSmall', { size: 16 }))))),
    st.items.length ? null : h('div.tc-hint', { style: { padding: '8px' } }, 'список пуст'));
}

// сравнение «до / после»: шторка перетаскивается мышью
function viewer() {
  const it = cur();
  if (!it) {
    return h('div.tc-view.tc-empty', {}, icon('image', { size: 32 }), h('div.t-h2', {}, 'ToColar'),
      h('div.t-p', {}, 'Перетащите сюда чёрно-белые страницы манги или комикса, вставьте Ctrl+V или выберите кнопками сверху — ToColar их раскрасит.'));
  }
  const after = job?.index === st.sel && job.preview ? job.preview : it.out ? fileUrl(it.out) : null;
  const wrap = h('div.tc-cmp');
  const before = h('img.tc-before', { src: fileUrl(it.src), alt: '', draggable: false });
  if (!after) wrap.append(before);
  else {
    const top = h('img.tc-after', { src: after, alt: '', draggable: false });
    const bar = h('div.tc-bar');
    const set = x => { st.split = Math.max(0, Math.min(1, x)); top.style.clipPath = `inset(0 0 0 ${st.split * 100}%)`; bar.style.left = `${st.split * 100}%`; };
    wrap.append(before, top, bar);
    set(st.split);
    wrap.ondragstart = e => e.preventDefault(); // своя картинка не должна «падать» обратно в список
    wrap.onpointerdown = e => {
      e.preventDefault();
      wrap.setPointerCapture(e.pointerId);
      const mv = ev => { const r = before.getBoundingClientRect(); set((ev.clientX - r.left) / r.width); };
      mv(e);
      wrap.onpointermove = mv;
      wrap.onpointerup = () => { wrap.onpointermove = null; keep(); };
    };
  }
  return h('div.tc-view', {}, wrap,
    h('div.tc-cap', {}, after ? 'слева — оригинал, справа — цвет; тяните шторку' : job?.index === st.sel ? 'раскрашивается…' : 'ещё не раскрашено',
      it.out ? h('a.ui-link', { href: fileUrl(it.out), target: '_blank', 'data-tip': it.out }, 'открыть результат') : null));
}

function render() {
  if (!viewEl) return;
  const files = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, onchange: e => { addFromDisk([...e.target.files]); e.target.value = ''; } });
  const pending = st.items.filter(i => i.status !== 'done').length;
  const fromLib = h('button.ui-btn.secondary.slim', { onclick: () => imagePicker(fromLib, { onPick: f => add([f]) }), 'data-tip': 'Из загруженных (input/) или результатов (output/)' }, icon('image', { size: 16 }), 'Из проекта');
  const bar = h('div.tc-top', {},
    h('button.ui-btn.secondary.slim', { onclick: () => files.click(), 'data-tip': 'Выбрать картинки на диске — можно сразу несколько' }, icon('open', { size: 16 }), 'С диска…'), files,
    fromLib,
    h('span.tc-sep'),
    job ? h('button.ui-btn.secondary.slim', { onclick: stop, 'data-tip': 'Остановить очередь' }, icon('stop', { size: 16 }), 'Стоп')
      : h('button.ui-btn.primary.slim', { onclick: () => start(), disabled: !pending, 'data-tip': 'Раскрасить все, что ещё не готовы' }, icon('play', { size: 16 }), `Раскрасить${pending ? ` (${pending})` : ''}`),
    cur() && !job ? h('button.ui-btn.secondary.slim', { onclick: () => start(st.sel), 'data-tip': 'Раскрасить выбранную ещё раз (новый вариант)' }, icon('refresh', { size: 16 }), 'Заново') : null,
    h('span.grow'),
    st.items.some(i => i.status === 'done') && !job ? h('div.ui-tb', {}, h('button.b', { 'data-tip': 'Убрать готовые из списка', onclick: () => { st.items = st.items.filter(i => i.status !== 'done'); st.sel = 0; keep(); render(); } }, icon('delete', { size: 16 }))) : null);
  viewEl.replaceChildren(bar, h('div.tc-body', {}, listEl(), viewer(), settings()));
}

// ---------- регистрация ----------
export function showTocolar() {
  viewEl = document.getElementById('v-tocolar');
  render();
  if (!rec) loadRec();
}

export function initTocolar() {
  viewEl = document.getElementById('v-tocolar');
  for (const it of st.items) if (it.status === 'run') it.status = 'new'; // запуск прервался вместе с окном
  on('run-progress', d => {
    if (!job || d.prompt_id !== job.pid || d.node !== 'ks') return;
    job.step = d.value; job.max = d.max;
    const el = viewEl?.querySelector('.tc-it.sel .tc-st'); if (el) el.textContent = `шаг ${job.step}/${job.max}`;
  });
  on('run-preview', d => {
    if (!job || d.prompt_id !== job.pid) return;
    job.preview = d.image;
    const img = viewEl?.querySelector('.tc-after');
    if (img) img.src = d.image; else render();
  });
  on('run-output', d => {
    if (!job || d.prompt_id !== job.pid || d.node !== 'keep') return;
    const it = st.items[job.index], f = d.output?._ui?.images?.[0];
    if (it && f) { it.out = f; it.status = 'done'; job.preview = null; keep(); log('ok', `раскрашено: ${f}`); }
  });
  on('run-done', d => { if (job && (!d.prompt_id || d.prompt_id === job.pid)) finish(d); });
  setInterval(reconcile, 4000);
  on('server', s => { if (s.running) setTimeout(() => { rec = null; if (viewEl?.isConnected) loadRec(); }, 900); });
  // перетаскивание и вставка картинок
  viewEl?.addEventListener('dragover', e => { if (transferHasImage(e.dataTransfer)) { e.preventDefault(); viewEl.classList.add('drop'); } });
  viewEl?.addEventListener('dragleave', e => { if (!viewEl.contains(e.relatedTarget)) viewEl.classList.remove('drop'); });
  viewEl?.addEventListener('drop', async e => { e.preventDefault(); viewEl.classList.remove('drop'); add(await imagesFromTransfer(e.dataTransfer)); });
  addEventListener('paste', async e => {
    if (activeView() !== 'tocolar' || ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) || !clipboardHasImage(e)) return;
    e.preventDefault();
    add(await imagesFromClipboard(e));
  });
}
