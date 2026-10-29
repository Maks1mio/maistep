// Вкладка «Видео»: картинка → ролик Wan 2.2 I2V (ноды video.wan_loader → video.wan_i2v → video.save, скрытый граф
// id «video», результаты — output/video/). Слева — плеер и лента роликов, справа — стартовый кадр, промпт, длина,
// размер и «Модели и шаги». «Продолжить» берёт последний кадр ролика стартовым для следующего.
// Модели — из библиотеки (пусто = подобрать самому: пара high/low i2v, лучше с вшитой lightx2v, umt5, wan_2.1_vae).
import { h, clamp, fill } from './util.js';
import { S, on, emit } from './store.js';
import { icon } from './icons.js';
import { api, fileUrl } from './backend.js';
import { imagePicker, imagesFromTransfer, imagesFromClipboard, clipboardHasImage, transferHasImage } from './images.js';
import { libraryPicker } from './library.js';
import { dropdown, onOff } from './kit.js';
import { activeView } from './dock.js';

const LS = 'maistep-video';
const NEG = ''; // пусто — негатив по умолчанию из ноды (нужен только при cfg > 1)
const DEF = {
  image: '', prompt: '', negative: NEG, secs: 5, fps: 16, size: '480', steps: 4, cfg: 1, shift: 5, sampler: 'euler', seed: -1, fast: false,
  models: { high: '', low: '', text_encoder: '', vae: '' }, clips: [], cur: 0, adv: false,
};
const st = (() => { try { return { ...DEF, ...JSON.parse(localStorage.getItem(LS)) }; } catch { return { ...DEF }; } })();
const keep = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch {} };
const log = (level, text) => emit('log', { src: 'video', level, text });
const SIZES = { 480: 832 * 480, 576: 1024 * 576, 720: 1280 * 720 };

let viewEl = null, info = null, job = null, aspect = 16 / 9;

// размер кадра: площадь пресета, пропорции стартовой картинки, стороны кратны 16
function frameSize() {
  const area = SIZES[st.size] || SIZES[480];
  const w = Math.round(Math.sqrt(area * aspect) / 16) * 16;
  return { w: clamp(w, 256, 1280), h: clamp(Math.round(area / w / 16) * 16, 256, 1280) };
}
const frameCount = () => Math.round((st.secs * st.fps) / 4) * 4 + 1; // Wan: 4k+1 кадров

async function loadInfo() {
  if (!S.server.running) return;
  try { info = await api('/api/video/info'); } catch (e) { info = { error: e.message }; }
  render();
}

function setImage(f) {
  if (!f) return;
  st.image = f; keep();
  const im = new Image();
  im.onload = () => { aspect = im.naturalWidth / im.naturalHeight || aspect; render(); };
  im.src = fileUrl(f);
  render();
}

// ---------- запуск ----------
async function run() {
  if (!S.server.running) { log('warn', 'сервер не запущен'); emit('server-start'); return; }
  if (!st.image) { log('warn', 'сначала стартовый кадр'); return; }
  if (job) return;
  const { w, h: hh } = frameSize();
  const pid = crypto.randomUUID().replace(/-/g, '');
  const L = (from, out, to, inn) => ({ from, out, to, in: inn });
  const wf = {
    id: 'video', title: 'Видео: Wan 2.2 I2V',
    nodes: [
      { id: 'load', type: 'video.wan_loader', props: { ...st.models } },
      { id: 'img', type: 'image.load', props: { file: st.image } },
      { id: 'gen', type: 'video.wan_i2v', props: { prompt: st.prompt, width: w, height: hh, frames: frameCount(), fps: st.fps, steps: st.steps,
        cfg: st.cfg, shift: st.shift, sampler: st.sampler, seed: st.seed, fp8_fast: !!st.fast, ...(st.negative ? { negative: st.negative } : {}) } },
      { id: 'save', type: 'video.save', props: { prefix: 'wan' } },
    ],
    links: [L('load', 'model', 'gen', 'model'), L('img', 'image', 'gen', 'image'), L('gen', 'video', 'save', 'video')],
    targets: ['save'],
  };
  job = { pid, phase: 'В очереди', step: 0, max: st.steps, t0: Date.now(), prompt: st.prompt };
  render();
  try { await api('/api/prompt', { id: pid, workflow: wf }); }
  catch (e) {
    job = null;
    for (const is of e.data?.issues || []) log('error', `нода ${is.node}: ${is.message}`);
    if (!e.data?.issues) log('error', `запуск: ${e.message}`);
    render();
  }
}
function stop() { if (job) api('/api/interrupt', {}).catch(() => {}); }

// ---------- для AI Agent (действия окна video_*) ----------
const clipInfo = c => c && { file: c.file, poster: c.poster, last_frame: c.last, frames: c.frames, fps: c.fps, size: `${c.width}×${c.height}`, prompt: c.prompt };
export const videoApi = {
  state() {
    const { w, h: hh } = frameSize();
    return { start_frame: st.image || null, prompt: st.prompt, negative: st.negative || '(default)', seconds: st.secs, fps: st.fps,
      frames: frameCount(), size: `${st.size}p → ${w}×${hh}`, steps: st.steps, cfg: st.cfg, shift: st.shift, sampler: st.sampler, seed: st.seed, fp8_fast: !!st.fast,
      models: Object.fromEntries(Object.entries(st.models).map(([k, v]) => [k, v || `auto: ${info?.auto?.[k] || '?'}`])),
      busy: job ? { phase: job.phase, step: job.step, of: job.max } : null,
      clips: st.clips.slice(0, 10).map(clipInfo), current: clipInfo(st.clips[st.cur]) };
  },
  // параметры вкладки; image — путь из input/ или output/ (стартовый кадр)
  set(a = {}) {
    if (a.image) setImage(String(a.image));
    for (const k of ['prompt', 'negative', 'sampler']) if (a[k] != null) st[k] = String(a[k]);
    if (a.seconds != null) st.secs = clamp(+a.seconds, 1, 10);
    if (a.size != null && SIZES[String(a.size).replace(/p$/, '')]) st.size = String(a.size).replace(/p$/, '');
    for (const [k, lo, hi] of [['fps', 4, 60], ['steps', 1, 60], ['cfg', 1, 10], ['shift', 1, 20]]) if (a[k] != null) st[k] = clamp(+a[k], lo, hi);
    if (a.fp8_fast != null) st.fast = !!a.fp8_fast;
    if (a.seed != null) st.seed = Math.round(+a.seed);
    if (a.models) for (const k of Object.keys(st.models)) if (a.models[k] != null) st.models[k] = String(a.models[k]);
    keep(); render();
    return this.state();
  },
  // сгенерировать и дождаться ролика (минуты); continue — стартовый кадр = последний кадр текущего ролика
  async generate(a = {}) {
    if (a.continue && st.clips[st.cur]) setImage(st.clips[st.cur].last);
    this.set(a);
    if (job) throw new Error('вкладка «Видео» уже генерирует');
    if (!st.image) throw new Error('нет стартового кадра: video_set {image}');
    const before = st.clips[0]?.file;
    const d = await new Promise(res => { run().then(() => { if (job) job.done = res; else res({ ok: false, error: { message: 'запуск не принят (см. консоль)' } }); }); });
    if (!d.ok) throw new Error(d.stopped ? 'прервано' : d.error?.message || 'ошибка генерации');
    const c = st.clips[0];
    return { video: c?.file !== before ? clipInfo(c) : null, images: c?.poster ? [c.poster, c.last].filter(Boolean) : [] };
  },
  stop() { stop(); return { stopping: !!job }; },
};

function updateRun() {
  const bar = viewEl?.querySelector('.vd-bar i'), t = viewEl?.querySelector('.vd-prog');
  if (!job || !t) return;
  const s = Math.round((Date.now() - job.t0) / 1000);
  t.textContent = `${job.phase}${job.max && job.step ? ` · шаг ${job.step}/${job.max}` : ''} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  if (bar) bar.style.width = `${job.max ? (job.step / job.max) * 100 : 0}%`;
}
setInterval(updateRun, 1000);

// ---------- вид ----------
function render() {
  if (!viewEl) return;
  const clip = st.clips[st.cur];
  const player = clip
    ? h('video.vd-video', { src: fileUrl(clip.file), poster: clip.poster ? fileUrl(clip.poster) : '', controls: true, loop: true, autoplay: true, muted: true, playsinline: true })
    : h('div.vd-empty', {}, icon('image', { size: 32 }), h('div', {}, 'Здесь будет ролик'), h('div.dim', {}, 'Выберите стартовый кадр справа, опишите движение и нажмите «Сгенерировать»'));
  const strip = st.clips.length ? h('div.vd-strip', {}, ...st.clips.map((c, i) => h(`div.vd-th${i === st.cur ? '.on' : ''}`, {
    'data-tip': `${c.prompt || 'без промпта'}\n${c.width}×${c.height} · ${c.frames} кадров`, onclick: () => { st.cur = i; keep(); render(); },
  }, h('img', { src: fileUrl(c.poster), draggable: false, crossOrigin: 'anonymous' }),
    h('button.ui-ib', { 'data-tip': 'Убрать из ленты (файл остаётся в output/video)', onclick: e => { e.stopPropagation(); st.clips.splice(i, 1); st.cur = clamp(st.cur, 0, st.clips.length - 1); keep(); render(); } }, icon('closeSmall', { size: 14 }))))) : null;
  const tools = clip ? h('div.vd-tools', {},
    h('button.ui-btn.secondary.slim', { onclick: () => setImage(clip.last), 'data-tip': 'Последний кадр этого ролика — стартовым для следующего' }, icon('right', { size: 16 }), 'Продолжить с последнего кадра'),
    h('button.ui-btn.secondary.slim', { onclick: () => setImage(clip.poster), 'data-tip': 'Первый кадр — стартовым (ещё вариант)' }, icon('refresh', { size: 16 }), 'Ещё вариант'),
    h('span.grow'),
    h('span.dim', {}, `${clip.width}×${clip.height} · ${clip.frames} кадров · ${clip.fps} fps`),
    h('a.ui-btn.secondary.slim', { href: fileUrl(clip.file), download: clip.file.split('/').pop(), 'data-tip': clip.file }, icon('download', { size: 16 }), 'MP4')) : null;
  fill(viewEl, h('div.vd', {}, h('div.vd-main', {}, h('div.vd-stage', {}, player), tools, strip), side()));
}

function side() {
  const { w, h: hh } = frameSize();
  const row = (label, ctl, tip) => h('div.f', { 'data-tip': tip || null }, h('span.l', {}, label), h('div.v', {}, ctl));
  const slider = (value, min, max, step, set, fmt = v => v) => {
    const el = h('input.ui-range', { type: 'range', min, max, step, value });
    const n = h('span.mono', {}, fmt(value));
    el.addEventListener('input', () => { n.textContent = fmt(+el.value); set(+el.value); keep(); });
    el.addEventListener('change', () => render());
    return h('div.row', { style: { flex: 1, gap: '8px', minWidth: 0 } }, el, n);
  };
  const start = st.image
    ? h('div.vd-start', {}, h('img', { src: fileUrl(st.image), draggable: false }),
      h('button.ui-ib', { 'data-tip': 'Убрать', onclick: () => { st.image = ''; keep(); render(); } }, icon('closeSmall', { size: 16 })))
    : h('div.vd-start.empty', { onclick: e => imagePicker(e.currentTarget, { onPick: setImage }) },
      icon('image', { size: 24 }), h('div', {}, 'Стартовый кадр'), h('div.dim', {}, 'выбрать, перетащить или Ctrl+V'));
  const prompt = h('textarea.vd-prompt', { rows: 4, placeholder: 'Что происходит в кадре: движение, камера, настроение… (по-русски — переведётся)', 'data-prompt-weight': '' });
  prompt.value = st.prompt;
  prompt.addEventListener('input', () => { st.prompt = prompt.value; keep(); });
  prompt.addEventListener('keydown', e => { if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); run(); } });
  const a = info?.auto || {};
  const model = (k, cat, label) => {
    const v = st.models[k], shown = v || a[k];
    const b = h('button.ui-dd', { type: 'button', 'data-tip': shown || 'не найдено', onclick: () => libraryPicker(b, { cat, value: v || a[k], onPick: n => { st.models[k] = n; keep(); render(); } }) },
      h(`span.t${shown ? '' : '.ph'}`, {}, shown ? shown.split(/[\\/]/).pop().replace(/\.(safetensors|gguf)$/, '') : 'не найдено'),
      v ? null : h('span.dim', {}, ' авто'), h('span.chev', {}, icon('down', { size: 16 })));
    return row(label, b);
  };
  const adv = h('details.vd-adv', { open: !!st.adv },
    h('summary', {}, 'Модели и шаги', h('span.dim', {}, ` · ${st.steps} шагов, cfg ${st.cfg}`)),
    model('high', 'unet', 'high noise'), model('low', 'unet', 'low noise'), model('text_encoder', 'text_encoders', 'текст (umt5)'), model('vae', 'vae', 'VAE'),
    Object.values(st.models).some(Boolean) ? h('button.ui-btn.secondary.slim', { onclick: () => { st.models = { ...DEF.models }; keep(); render(); } }, 'Модели — авто') : null,
    row('шаги', slider(st.steps, 1, 30, 1, v => { st.steps = v; }), '4 — с lightx2v (вшита в …lightx2v_4step…), 20–30 — без неё'),
    row('cfg', slider(st.cfg, 1, 8, 0.5, v => { st.cfg = v; }), '1 — с lightx2v (быстрее вдвое: без прохода негатива)'),
    row('shift', slider(st.shift, 1, 12, 0.5, v => { st.shift = v; })),
    row('сэмплер', dropdown(st.sampler, ['euler', 'unipc'], v => { st.sampler = v; keep(); })),
    row('быстрый fp8', onOff(!!st.fast, v => { st.fast = v; keep(); }), 'Умножение прямо в fp8 на тензорных ядрах RTX 40/50: ~15 % быстрее, чуть менее точно'),
    row('fps', slider(st.fps, 8, 30, 1, v => { st.fps = v; })),
    row('seed', h('input', { type: 'number', value: st.seed, oninput: e => { st.seed = Math.round(+e.target.value || -1); keep(); } }), '−1 — случайный'),
    st.cfg > 1 ? h('textarea.vd-neg', { rows: 3, placeholder: 'негатив (пусто — стандартный Wan)', value: st.negative, oninput: e => { st.negative = e.target.value; keep(); } }) : null);
  adv.addEventListener('toggle', () => { st.adv = adv.open; keep(); });
  const busy = !!job;
  const warn = info?.error ? `сервер: ${info.error}` : info && !info.av ? 'нет PyAV — поставьте во вкладке «Компоненты» (MP4)'
    : info && (!a.high || !a.low) && !st.models.high ? 'в библиотеке не найдены модели Wan 2.2 I2V (high/low noise)' : null;
  return h('div.vd-side', {},
    h('div.vd-h', {}, h('b', {}, 'Wan 2.2 · картинка → видео'), h('span.dim', {}, `${w}×${hh}`)),
    start,
    prompt,
    row('длина', slider(st.secs, 1, 10, 0.5, v => { st.secs = v; }, v => `${v} с`), `${frameCount()} кадров при ${st.fps} fps`),
    row('размер', h('div.ui-seg', {}, ...Object.keys(SIZES).map(k => h(`button${st.size === k ? '.on' : ''}`, { type: 'button', onclick: () => { st.size = k; keep(); render(); } }, `${k}p`))),
      'пропорции — как у стартового кадра; 720p на 8 ГБ — долго'),
    busy ? h('div.vd-busy', {}, h('div.vd-bar', {}, h('i')), h('div.row', {}, h('span.vd-prog.grow', {}, '…'), h('button.ui-btn.secondary.slim', { onclick: stop }, 'Прервать')))
      : h('button.ui-btn.primary.vd-go', { disabled: !st.image || !S.server.running, onclick: run, 'data-tip': 'Ctrl+Enter в промпте' }, icon('play', { size: 16 }), 'Сгенерировать'),
    warn ? h('div.hint', { style: { color: 'var(--ui-warn)' } }, warn) : null,
    h('div.hint', {}, 'Первый запуск грузит Wan в память (~30 ГБ RAM, пара минут); потом — быстрее. На 8 ГБ: 480p, 5 с ≈ несколько минут.'),
    adv);
}

export function showVideo() {
  viewEl = document.getElementById('v-video');
  if (!info) loadInfo();
  if (st.image) setImage(st.image); else render();
}

export function initVideo() {
  viewEl = document.getElementById('v-video');
  on('run-node', d => { if (job && d.prompt_id === job.pid) { job.phase = { load: 'Модели', img: 'Кадр', gen: 'Загрузка Wan, текст, VAE', save: 'Сохранение' }[d.node] || job.phase; updateRun(); } });
  on('run-progress', d => {
    if (!job || d.prompt_id !== job.pid || d.node !== 'gen') return;
    job.phase = 'Генерация'; job.step = d.value; job.max = d.max; updateRun();
  });
  on('run-output', d => {
    if (!job || d.prompt_id !== job.pid || d.node !== 'save') return;
    const v = d.output?._ui?.videos?.[0];
    if (v) { st.clips.unshift({ ...v, prompt: job.prompt, at: Date.now() }); st.clips = st.clips.slice(0, 60); st.cur = 0; keep(); log('ok', `видео: ${v.file}`); }
  });
  on('run-done', d => {
    if (!job || (d.prompt_id && d.prompt_id !== job.pid)) return;
    if (!d.ok && !d.stopped) log('error', `видео: ${d.error?.message || 'ошибка'}`);
    const fin = job.done;
    job = null; render();
    fin?.(d);
  });
  on('server', s => { if (s.running) { info = null; setTimeout(() => { if (viewEl?.isConnected) loadInfo(); }, 900); } });
  viewEl?.addEventListener('dragover', e => { if (transferHasImage(e.dataTransfer)) { e.preventDefault(); viewEl.classList.add('drop'); } });
  viewEl?.addEventListener('dragleave', e => { if (!viewEl.contains(e.relatedTarget)) viewEl.classList.remove('drop'); });
  viewEl?.addEventListener('drop', async e => {
    viewEl.classList.remove('drop');
    if (!transferHasImage(e.dataTransfer)) return;
    e.preventDefault();
    const [f] = await imagesFromTransfer(e.dataTransfer);
    setImage(f);
  });
  document.addEventListener('paste', async e => {
    if (activeView() !== 'video' || !clipboardHasImage(e) || /^(input|textarea)$/i.test(document.activeElement?.tagName || '')) return;
    e.preventDefault();
    const [f] = await imagesFromClipboard(e);
    setImage(f);
  });
}
