// ToColar — раскраска чёрно-белых картинок (манга, комиксы, скетчи) пачкой. Каждая картинка — скрытый граф
// (id "tocolar"). Основной путь — ControlNet: Fit Image → Lineart From Page (страница сама — лайнарт: инверсия)
// → Apply ControlNet (lineart_anime под SDXL Illustrious/NoobAI) → KSampler с нуля (denoise 1) → VAE Decode →
// Keep Lines. Без ControlNet — прежний img2img (VAE Encode, denoise ~0.7). Keep Lines берёт светлоту из оригинала,
// а цвет — из генерации, поэтому линии, тон и текст остаются как нарисованы.
// Цвета придумывает vision-LLM (скрытый llm.chat): общие персонажи + подсказка страницы, всё можно править.
// Состояние (список, настройки, подсказки) — localStorage; результаты — PNG в output/ (colored_*).
// Страница цельная (2026-10-28): слева — страницы, в центре — просмотр (сравнить / цвет / оригинал) с кистью цвета,
// справа — модель, цвета и «Тонкая настройка» (свёрнута). Кисть цвета: штрих на неверно окрашенном месте перекрашивает
// всю область между линиями (Keep Lines `hints`), «Применить» перезапускает только Keep Lines на прежней генерации
// (it.gens: результат → файл цвета SDXL/MangaNinja) — секунды, без новой генерации. «В ImageNaizer» — доработать.
import { h, check, clamp, stepper } from './util.js';
import { S, on, emit } from './store.js';
import { icon } from './icons.js';
import { api, upload, fileUrl, getSettings, getModels } from './backend.js';
import { imagePicker, imagesFromTransfer, imagesFromClipboard, clipboardHasImage, transferHasImage } from './images.js';
import { libraryPicker } from './library.js';
import { cnNames, cnPick, loadCn, cnMissing, ninjaReady } from './cnmodels.js';
import { modelPicker } from './modelpick.js';
import { dropdown, colorPicker } from './kit.js';
import { naizerApi } from './naizer.js';
import { fetchRec } from './magic.js';
import { activeView, openWorkspace } from './dock.js';

const LS = 'maistep-tocolar';
const log = (level, text) => emit('log', { src: 'tocolar', level, text });
const COLOR_POS = 'full color, colorized manga, vibrant colors, anime coloring, detailed shading';
const COLOR_NEG = 'monochrome, greyscale, black and white, sepia, desaturated, lineart only';
const DEF = {
  items: [], sel: 0, ckpt: '', prompt: '', cast: '', negative: '', auto: true, llmProvider: '', llmModel: '',
  denoise: 0.7, strength: 1.1, shading: 0.55, megapixels: 1.0, seed: -1, steps: null, cfg: null, split: 0.5,
  cn: true, cnModel: '', cnStrength: 1, cnEnd: 1, cnDenoise: 1.0, regions: true, tune: true, engine: 'ninja', refs: [], v: 3,
  vmode: 'split', tool: 'split', hcolor: '#F2C9AE', hsize: 18, adv: false,
};

// vision-LLM: две строки — повторяющиеся персонажи и цвета именно этой страницы
const LLM_SYSTEM = 'You colorize black-and-white manga and comic pages. You infer plausible, natural colors and answer '
  + 'with English comma-separated tags only.';
const LLM_PROMPT = 'This is a black-and-white manga page. Decide the colors that should be applied to it.\n'
  + 'Answer in exactly two lines:\n'
  + 'CAST: characters who repeat on other pages — hair color, eye color, skin tone, main outfit colors\n'
  + 'PAGE: everything on this page — each clothing item and its color, accessories, props, background, lighting\n'
  + 'Use explicit color words in every tag (example: blonde hair, blue eyes, white shirt, red pleated skirt, '
  + 'gray classroom). Invent natural colors where the drawing gives no clue. Do not mention black and white, '
  + 'lineart, monochrome or the drawing style. No names, no sentences, no markdown.';

let st = load();
let viewEl = null, rec = null, job = null, stopAll = false, viewerRO = null;
let llmProvs = null, llmLoading = false, llmPick = null, llmBusy = 0, llmWarned = false;
const waits = new Map(); // pid запроса vision-LLM → { ок, ошибка }

function load() {
  let d = {};
  try { d = JSON.parse(localStorage.getItem(LS)) || {}; } catch {}
  const s = { ...DEF, ...d };
  if (!d.v || d.v < 2) { // прежние умолчания давали бледный цвет
    s.denoise = 0.7; s.strength = 1.1; s.shading = 0.55; s.auto = true;
  }
  if (!d.v || d.v < 3) s.cn = true; // ControlNet — основной путь с 3-й версии настроек
  s.v = DEF.v;
  s.items = (Array.isArray(s.items) ? s.items : []).map(it => ({
    src: it.src, out: it.out || null, outs: Array.isArray(it.outs) ? it.outs : (it.out ? [it.out] : []),
    status: it.status === 'run' ? 'new' : it.status || 'new', prompt: it.prompt ?? null, zoom: it.zoom || 1,
    kind: it.kind || null, gens: it.gens && typeof it.gens === 'object' ? it.gens : {}, hints: it.hints || null,
  })).filter(it => it.src);
  s.sel = clamp(s.sel | 0, 0, Math.max(0, s.items.length - 1));
  s.refs = (Array.isArray(s.refs) ? s.refs : []).filter(Boolean);
  return s;
}
const keep = () => { try { localStorage.setItem(LS, JSON.stringify(st)); } catch {} };
const ckptName = () => st.ckpt || S.nodes['sd.checkpoint']?.inputs?.ckpt_name?.default || '';
const cur = () => st.items[st.sel] || null;
const name = f => String(f || '').split('/').pop();
const stem = f => name(f).replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_').slice(0, 40) || 'page';
const uid = () => crypto.randomUUID().replace(/-/g, '');
const pagePrompt = it => [st.cast, st.prompt, it?.prompt].map(s => (s || '').trim()).filter(Boolean).join(', ');

// ---------- список ----------
function add(files) {
  const have = new Set(st.items.map(i => i.src));
  const fresh = files.filter(f => f && !have.has(f));
  if (!fresh.length) return;
  st.items.push(...fresh.map(src => ({ src, out: null, outs: [], status: 'new', prompt: null, zoom: 1, kind: null, gens: {}, hints: null })));
  st.sel = st.items.length - fresh.length;
  keep(); render();
  for (const it of st.items) if (fresh.includes(it.src)) classify(it);
}

// ---------- автонастройка: какая это картинка и как её красить ----------
// Смотрим на уменьшенную копию прямо в окне: есть ли цвет, сколько штрихов (темнее округи) и серого тона.
// Числа — из прогона настоящей страницы (2026-10-26): ControlNet 0.8 с отпусканием на 80 % шагов давал генерации
// уйти от страницы (чужие предметы и цвета волос), 1.0 до конца держит композицию; тени больше 0.35 на манге
// с тоном проявляли «призраки» генерации.
const KINDS = {
  lineart: { label: 'лайнарт / скетч', p: { cn: true, cnStrength: 1, cnEnd: 1, cnDenoise: 1, shading: 0.5, strength: 1.1, regions: true, hint: 'invert' } },
  manga: { label: 'манга с тоном', p: { cn: true, cnStrength: 1, cnEnd: 1, cnDenoise: 1, shading: 0.35, strength: 1.1, regions: true, hint: 'invert' } },
  gray: { label: 'серая картинка без линий', p: { cn: false, denoise: 0.6, shading: 0, strength: 1.1, regions: false } },
  color: { label: 'уже цветная', p: { cn: true, cnStrength: 0.7, cnEnd: 0.7, cnDenoise: 1, shading: 0.3, strength: 1, regions: false, hint: 'edges' } },
};
async function classify(it) {
  try {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = fileUrl(it.src);
    await img.decode();
    const k = Math.min(1, 640 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(8, Math.round(img.naturalWidth * k)), hh = Math.max(8, Math.round(img.naturalHeight * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = hh;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.drawImage(img, 0, 0, w, hh);
    const d = x.getImageData(0, 0, w, hh).data, n = w * hh;
    const L = new Float32Array(n);
    let chroma = 0;
    for (let i = 0; i < n; i++) {
      const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
      L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      chroma += Math.max(r, g, b) - Math.min(r, g, b);
    }
    // среднее по окну 9×9 (интегральное изображение): штрих — заметно темнее округи, тон — серое в среднем
    const S1 = new Float64Array((w + 1) * (hh + 1));
    for (let y = 0; y < hh; y++) for (let xx = 0, row = 0; xx < w; xx++) {
      row += L[y * w + xx];
      S1[(y + 1) * (w + 1) + xx + 1] = S1[y * (w + 1) + xx + 1] + row;
    }
    const R = 4;
    let lines = 0, tone = 0;
    for (let y = 0; y < hh; y++) for (let xx = 0; xx < w; xx++) {
      const y0 = Math.max(0, y - R), y1 = Math.min(hh, y + R + 1), x0 = Math.max(0, xx - R), x1 = Math.min(w, xx + R + 1);
      const m = (S1[y1 * (w + 1) + x1] - S1[y0 * (w + 1) + x1] - S1[y1 * (w + 1) + x0] + S1[y0 * (w + 1) + x0]) / ((y1 - y0) * (x1 - x0));
      if (m - L[y * w + xx] > 25) lines++;
      if (m > 45 && m < 205) tone++;
    }
    const f = { chroma: chroma / n, lines: lines / n, tone: tone / n };
    it.kind = f.chroma > 18 ? 'color' : f.lines < 0.02 && f.tone > 0.35 ? 'gray' : f.tone > 0.18 ? 'manga' : 'lineart';
    it.stats = { chroma: +f.chroma.toFixed(1), lines: +f.lines.toFixed(3), tone: +f.tone.toFixed(3) };
  } catch {
    it.kind = 'manga'; // не прочиталась (сервер выключен) — самый частый случай
  }
  keep();
  if (viewEl?.isConnected) render();
}
// параметры запуска: автоподбор по типу картинки или ручные из панели
function params(it) {
  const man = { cn: st.cn, cnStrength: st.cnStrength, cnEnd: st.cnEnd, cnDenoise: st.cnDenoise, denoise: st.denoise,
    shading: st.shading ?? 0.55, strength: st.strength, regions: st.regions !== false, hint: 'invert' };
  const P = st.tune ? { ...man, ...(KINDS[it?.kind || 'manga'] || KINDS.manga).p } : man;
  // MangaNinja — для линий (лайнарт, манга); серое без линий и уже цветное красит SDXL
  const lines = !st.tune || ['manga', 'lineart'].includes(it?.kind || 'manga');
  P.engine = lines && ninjaReady() && (st.tune || st.engine === 'ninja') ? 'ninja' : 'sd';
  P.ref = P.engine === 'ninja' ? st.refs[0] || null : null; // свой цветной референс — без SDXL
  return P;
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

// ControlNet: выбранная модель или первая подходящая для лайнарта (cnmodels.js)
const cnName = () => cnPick('lines', st.cnModel);

// ---------- vision-LLM: цвета сам ----------
let defaultProvider = '';
async function ensureLlm(force = false) {
  if (!S.server.running) return null;
  if (llmPick && !force) return llmPick;
  if (llmLoading) return llmPick;
  llmLoading = true;
  try {
    if (!llmProvs || force) {
      const s = await getSettings();
      llmProvs = s.providers || {};
      defaultProvider = s.default_provider || '';
    }
    const hasKey = id => !!llmProvs[id]?.has_key;
    const withKey = Object.keys(llmProvs).find(hasKey);
    const usable = id => llmProvs[id] && (hasKey(id) || llmProvs[id].kind === 'ollama');
    let p = st.llmProvider;
    if (!p || !usable(p)) {
      p = (defaultProvider && usable(defaultProvider) ? defaultProvider : '') || withKey
        || Object.keys(llmProvs).find(usable) || Object.keys(llmProvs)[0] || '';
    }
    st.llmProvider = p;
    if (!p) { llmPick = null; return null; }
    await getModels(p, force);
    const all = S.models[p]?.models || [];
    const vision = m => m.vision || llmProvs[p]?.kind === 'ollama';
    let m = all.find(x => x.id === st.llmModel && vision(x));
    if (!m) m = all.find(vision);
    st.llmModel = m?.id || '';
    llmPick = m ? { provider: p, model: m.id } : null;
    if (!m) log('warn', `vision-LLM: у ${llmProvs[p]?.name || p} нет модели с картинками`);
    keep();
    if (viewEl?.isConnected) render();
  } catch (e) {
    log('warn', `vision-LLM: ${e.message}`);
    llmPick = null;
  } finally { llmLoading = false; }
  return llmPick;
}

function llmRun(src) {
  const pick = llmPick;
  if (!pick) return Promise.reject(new Error('нет vision-модели'));
  const pid = uid();
  const wf = {
    id: 'tocolar_ctx', title: `ToColar: цвета ${name(src)}`,
    nodes: [
      { id: 'img', type: 'image.load', props: { file: src } },
      { id: 'llm', type: 'llm.chat', props: { prompt: LLM_PROMPT, system: LLM_SYSTEM, provider: pick.provider, model: pick.model,
        max_tokens: 500, effort: 'auto', temperature: 0.35, seed: Date.now() % 1000000 } },
      { id: 'out', type: 'output.show', props: {} },
    ],
    links: [{ from: 'img', out: 'image', to: 'llm', in: 'image' }, { from: 'llm', out: 'text', to: 'out', in: 'value' }],
    targets: ['out'],
  };
  return new Promise((resolve, reject) => {
    const done = (fn, v) => { clearTimeout(timer); waits.delete(pid); fn(v); };
    const timer = setTimeout(() => done(reject, new Error('vision-LLM не ответил за 4 мин (в очереди другая генерация?)')), 240000);
    waits.set(pid, { ok: t => done(resolve, t), fail: e => done(reject, e) });
    log('info', `цвета: спрашиваю ${pick.model}`);
    api('/api/prompt', { id: pid, workflow: wf }).catch(e => done(reject, e));
  });
}

const cleanTags = t => t.replace(/^(?:monochrome|greyscale|grayscale|black and white|lineart|line art|sketch|manga)$/i, '')
  .replace(/\s+/g, ' ').replace(/^[,;\s]+|[,.;\s]+$/g, '').trim();
function parseColors(text) {
  const raw = String(text || '').replace(/```[a-z]*|```/gi, ' ').trim();
  if (!raw) return { cast: '', page: '' };
  const grab = re => { const m = re.exec(raw); return m ? cleanTags(m[1]) : ''; };
  const cast = grab(/(?:^|\n)\s*[-*•]?\s*cas[ts]\s*[:\-–]\s*(.+)/i);
  const page = grab(/(?:^|\n)\s*[-*•]?\s*(?:page|scene|colors?)\s*[:\-–]\s*(.+)/i);
  if (cast || page) return { cast, page };
  const line = raw.split('\n').map(s => s.trim()).filter(Boolean).join(', ');
  return { cast: '', page: line.split(',').map(cleanTags).filter(Boolean).join(', ') };
}

async function describe(it, quiet = false) {
  if (!it) return null;
  if (!S.server.running) { if (!quiet) log('warn', 'сервер не запущен'); return null; }
  const pick = await ensureLlm();
  if (!pick) { if (!quiet) log('warn', 'автоцвета: выберите vision-модель (Файл → Провайдеры LLM…)'); return null; }
  llmBusy++;
  if (viewEl?.isConnected) render();
  try {
    const text = await llmRun(it.src);
    const r = parseColors(text);
    if (!r.page && !r.cast) throw new Error('модель не вернула цвета');
    return r;
  } catch (e) {
    if (!quiet || !llmWarned) {
      log('warn', `автоцвета: ${e.message}`);
      llmWarned = true;
    }
    return null;
  } finally {
    llmBusy = Math.max(0, llmBusy - 1);
    if (viewEl?.isConnected) render();
  }
}

async function invent(it, quiet = false) {
  if (!it) return false;
  it.prompt = null; keep();
  const r = await describe(it, quiet);
  if (!r) { it.prompt = ''; keep(); return false; }
  if (r.cast && !st.cast.trim()) st.cast = r.cast;
  it.prompt = r.page || r.cast;
  keep();
  log('ok', `цвета страницы: ${it.prompt.slice(0, 140)}`);
  if (viewEl?.isConnected) render();
  return true;
}

// ---------- запуск ----------
function graph(it) {
  const q = rec?.ok ? rec.prompt : { positive: 'masterpiece, best quality', negative: 'lowres, worst quality, bad anatomy' };
  const p = rec?.ok ? rec.params : {};
  const P = params(it);
  const L = (from, out, to, inn) => ({ from, out, to, in: inn });
  const cn = P.cn && cnName();
  const nodes = [
    { id: 'ckpt', type: 'sd.checkpoint', props: { ckpt_name: ckptName() } },
    { id: 'skip', type: 'sd.clip_skip', props: { stop_at_clip_layer: rec?.clip_skip || -2 } },
    { id: 'pos', type: 'sd.text_encode', props: { text: [q.positive, COLOR_POS, pagePrompt(it)].filter(Boolean).join(', ') } },
    { id: 'neg', type: 'sd.text_encode', props: { text: [st.negative.trim() || q.negative, COLOR_NEG].filter(Boolean).join(', ') } },
    { id: 'img', type: 'image.load', props: { file: it.src } },
    { id: 'fit', type: 'image.fit', props: { megapixels: st.megapixels, multiple: 64 } },
    // латент страницы: при denoise 1 он задаёт только размер (txt2img), ниже — img2img от серой страницы
    { id: 'enc', type: 'sd.vae_encode', props: {} },
    { id: 'ks', type: 'sd.ksampler', props: { seed: st.seed, steps: st.steps ?? p.steps ?? 25, cfg: st.cfg ?? p.cfg ?? 6,
      sampler_name: p.sampler_name || 'euler_ancestral', scheduler: p.scheduler || 'normal', denoise: cn ? P.cnDenoise : P.denoise } },
    { id: 'dec', type: 'sd.vae_decode', props: {} },
    // с ControlNet контуры генерации совпадают с оригиналом — цвет можно сглаживать меньше и брать больше светотени
    // по областям: линии оригинала делят страницу, каждая область — один цвет генерации (не заходит за линии)
    { id: 'keep', type: 'image.keep_lines', props: keepProps(it, P, cn) },
  ];
  const links = [L('ckpt', 'clip', 'skip', 'clip'), L('skip', 'clip', 'pos', 'clip'), L('skip', 'clip', 'neg', 'clip'),
    L('img', 'image', 'fit', 'image'), L('fit', 'image', 'enc', 'pixels'), L('ckpt', 'vae', 'enc', 'vae'),
    L('ckpt', 'model', 'ks', 'model'), L('enc', 'latent', 'ks', 'latent_image'), L('dec', 'image', 'keep', 'colors'),
    L('ks', 'latent', 'dec', 'samples'), L('ckpt', 'vae', 'dec', 'vae'), L('img', 'image', 'keep', 'lines')];
  if (it.hints) { nodes.push({ id: 'hint', type: 'image.load', props: { file: it.hints } }); links.push(L('hint', 'image', 'keep', 'hints')); }
  if (cn) {
    nodes.push(
      { id: 'lines', type: 'image.lineart', props: { mode: P.hint, threshold: 160, blur: 0 } },
      { id: 'cnl', type: 'sd.controlnet_load', props: { control_net_name: cn } },
      { id: 'cna', type: 'sd.controlnet_apply', props: { strength: P.cnStrength, start_percent: 0, end_percent: P.cnEnd } });
    links.push(L('fit', 'image', 'lines', 'image'), L('pos', 'conditioning', 'cna', 'positive'), L('neg', 'conditioning', 'cna', 'negative'),
      L('cnl', 'control_net', 'cna', 'control_net'), L('lines', 'image', 'cna', 'image'),
      L('cna', 'positive', 'ks', 'positive'), L('cna', 'negative', 'ks', 'negative'));
  } else {
    links.push(L('pos', 'conditioning', 'ks', 'positive'), L('neg', 'conditioning', 'ks', 'negative'));
  }
  if (P.engine === 'ninja') {
    // MangaNinja по панелям: референс — свой цветной арт (тогда SDXL не нужен) или SDXL-раскраска этой страницы
    const ninja = { id: 'ninja', type: 'sd.manganinja', props: { aligned: !P.ref, per_panel: true, steps: 30, guidance: 9, seed: st.seed } };
    const keepNode = nodes.find(n => n.id === 'keep');
    if (P.ref) {
      return { id: 'tocolar', title: `ToColar: ${name(it.src)}`, targets: ['keep'],
        nodes: [nodes.find(n => n.id === 'img'), { id: 'ref', type: 'image.load', props: { file: P.ref } }, ninja, keepNode,
          ...nodes.filter(n => n.id === 'hint')],
        links: [L('img', 'image', 'ninja', 'page'), L('ref', 'image', 'ninja', 'reference'),
          L('ninja', 'image', 'keep', 'colors'), L('img', 'image', 'keep', 'lines'), ...links.filter(l => l.from === 'hint')] };
    }
    nodes.push(ninja);
    const i = links.findIndex(l => l.to === 'keep' && l.in === 'colors');
    links.splice(i, 1, L('img', 'image', 'ninja', 'page'), L('dec', 'image', 'ninja', 'reference'), L('ninja', 'image', 'keep', 'colors'));
  }
  return { id: 'tocolar', title: `ToColar: ${name(it.src)}`, nodes, links, targets: ['keep'] };
}

// с ControlNet контуры генерации совпадают с оригиналом — цвет можно сглаживать меньше и брать больше светотени;
// по областям: линии оригинала делят страницу, каждая область — один цвет генерации (не заходит за линии)
function keepProps(it, P, cn) {
  return { strength: P.strength, shading: P.shading, smooth: cn ? 3 : 5, regions: P.regions, prefix: `colored_${stem(it.src)}` };
}

// подсказки кистью на готовой раскраске: только Keep Lines на прежнем цвете генерации — секунды, без SDXL
async function applyHints(i = st.sel) {
  const it = st.items[i];
  if (!it || job) return;
  if (!S.server.running) { log('warn', 'сервер не запущен'); emit('server-start'); return; }
  await flushHints(it);
  const colors = it.out && it.gens?.[it.out];
  if (!colors) { log('info', 'у этого результата нет сохранённой генерации — раскрашиваю заново с подсказками'); return start(i); }
  const P = params(it), L = (from, out, to, inn) => ({ from, out, to, in: inn });
  const wf = { id: 'tocolar', title: `ToColar: подсказки ${name(it.src)}`, targets: ['keep'],
    nodes: [{ id: 'img', type: 'image.load', props: { file: it.src } }, { id: 'col', type: 'image.load', props: { file: colors } },
      { id: 'keep', type: 'image.keep_lines', props: keepProps(it, P, P.cn && cnName()) },
      ...(it.hints ? [{ id: 'hint', type: 'image.load', props: { file: it.hints } }] : [])],
    links: [L('img', 'image', 'keep', 'lines'), L('col', 'image', 'keep', 'colors'), ...(it.hints ? [L('hint', 'image', 'keep', 'hints')] : [])] };
  const pid = uid();
  const me = job = { pid, index: i, phase: 'hints', step: 0, max: 0, single: true, posted: false, miss: 0, colors };
  it.status = 'run'; render();
  try {
    await api('/api/prompt', { id: pid, workflow: wf });
    if (job === me) me.posted = true;
    hintsDirty = false;
  } catch (e) {
    it.status = it.out ? 'done' : 'err'; job = null;
    log('error', `подсказки: ${e.message}`); keep(); render();
  }
}

async function start(only = null) {
  if (job) return;
  if (!S.server.running) { log('warn', 'сервер не запущен'); emit('server-start'); return; }
  if (!ckptName() && !(st.refs.length && ninjaReady())) return log('warn', 'выберите чекпоинт (лучше аниме: Illustrious, Pony, NoobAI)');
  const needCn = st.items.some(i => (only == null || i === st.items[only]) && params(i).cn && !params(i).ref);
  if (needCn && cnNames() == null) await loadCn();
  if (needCn && !cnName()) {
    log('warn', 'ControlNet не установлен — скачайте модель (справа, «Контуры») или выключите ControlNet');
    render();
    return;
  }
  if (only == null) for (const it of st.items) if (it.status === 'err') it.status = 'new';
  if (!rec) await loadRec();
  stopAll = false;
  next(only);
}

async function next(only = null) {
  const index = only ?? st.items.findIndex(i => i.status === 'new');
  const it = st.items[index];
  if (index < 0 || !it || stopAll) { job = null; render(); return; }
  const me = job = { pid: null, index, phase: 'sd', step: 0, max: 0, single: only != null, posted: false, miss: 0 };
  it.status = 'run';
  st.sel = index;
  render();
  if (st.auto && it.prompt == null && !params(it).ref) {
    me.phase = 'prompt'; render();
    const ok = await invent(it, true);
    if (!ok) log('warn', 'автоцвета не сработали — раскрашиваю по общим подсказкам');
    if (job !== me) return;
    if (stopAll) { if (it.status === 'run') it.status = 'new'; keep(); job = null; render(); return; }
  }
  if (!it.kind) await classify(it);
  if (job !== me) return;
  const pid = uid();
  me.phase = 'sd';
  me.pid = pid;
  render();
  try {
    await api('/api/prompt', { id: pid, workflow: graph(it) });
    if (job === me) me.posted = true;
    const P = params(it);
    const how = (P.ref ? 'MangaNinja по референсу' : (P.cn && cnName() ? `ControlNet ${P.cnStrength} до ${P.cnEnd}` : `img2img denoise ${P.denoise}`)
      + (P.engine === 'ninja' ? ' → MangaNinja' : ''))
      + (st.tune ? ` · авто: ${KINDS[it.kind || 'manga'].label}` : '');
    log('info', `раскраска ${name(it.src)} · ${how}${it.prompt ? ` · ${it.prompt.slice(0, 80)}` : ''}`);
  } catch (e) {
    it.status = 'err'; job = null;
    for (const is of e.data?.issues || []) log('error', `нода ${is.node}: ${is.message}`);
    if (!e.data?.issues) log('error', `запуск: ${e.message}`);
    keep(); render();
  }
}

// конец запуска картинки (событие done или сверка с историей сервера)
function finish(d) {
  if (!job) return;
  const it = st.items[job.index];
  const pid = job.pid, index = job.index, colors = job.colors;
  const stopped = d.stopped || d.error?.message === 'прервано';
  if (d.ok && it) {
    const f = (d.outputs?.keep?._ui || d.outputs?.keep?.ui)?.images?.[0];
    if (f) setResult(it, f, job.colors);
  }
  if (!d.ok) {
    if (it) it.status = stopped ? 'new' : 'err';
    log(stopped ? 'warn' : 'error', `ToColar: ${stopped ? 'прервано' : d.error?.message?.split('\n')[0] || 'запуск не удался'}`);
  } else if (it && it.status !== 'done') {
    // результат ноды потерялся по дороге (обрыв SSE) — заберём его из истории сервера
    it.status = 'run';
    api('/api/history?limit=20').then(list => {
      const e = list.find(x => x.prompt_id === pid);
      const f = (e?.outputs?.keep?._ui || e?.outputs?.keep?.ui)?.images?.[0];
      const out = o => (o?._ui || o?.ui)?.images?.[0];
      const item = st.items[index];
      if (!item) return;
      if (f) { setResult(item, f, out(e.outputs?.ninja) || out(e.outputs?.dec) || colors); keep(); render(); }
      else { item.status = 'err'; keep(); render(); }
    }).catch(() => { if (st.items[index]) st.items[index].status = 'err'; keep(); render(); });
  }
  const single = job.single;
  job = null; keep(); render();
  if (single || stopAll || stopped) return;
  next();
}

function setResult(it, f, colors = null) {
  it.out = f;
  it.outs = [...(it.outs || []), f].filter((x, i, a) => a.indexOf(x) === i).slice(-8);
  it.gens = Object.fromEntries(Object.entries({ ...(it.gens || {}), ...(colors ? { [f]: colors } : {}) }).filter(([k]) => it.outs.includes(k)));
  it.status = 'done';
}

// события SSE теряются при обрыве связи (долгая генерация, перезапуск сервера) — сверяемся с очередью и историей
async function reconcile() {
  if (!job?.posted || !job.pid || !S.server.running) return;
  const me = job, pid = me.pid;
  try {
    const q = await api('/api/queue');
    if (job !== me) return;
    if (q.running?.prompt_id === pid || q.pending?.some(p => p.prompt_id === pid)) { me.miss = 0; return; }
    const h = (await api('/api/history?limit=20')).find(x => x.prompt_id === pid);
    if (job !== me) return;
    if (h) finish({ ok: h.ok, error: h.error, outputs: h.outputs });
    else if (++me.miss >= 4) finish({ ok: false, error: { message: 'запуск потерялся (сервер перезапущен?)' } });
  } catch {}
}

function stop() {
  stopAll = true;
  if (job?.pid) api('/api/interrupt', {}).catch(() => {});
  else if (job) { const it = st.items[job.index]; if (it?.status === 'run') { it.status = 'new'; } job = null; keep(); render(); }
}

// ---------- подсказки кистью ----------
// холст подсказок — в пикселях страницы, поверх просмотра; файл input/tocolar_hint_* (скрыт из списков) — вход Keep Lines
const hintC = new Map(); // src → canvas
const hintPending = new Set(); // src с невыгруженными штрихами
let hintsDirty = false; // штрихи есть, «Применить» ещё не нажимали
const PALETTE = ['#F6DCC8', '#E9B89A', '#C98B66', '#8A5A3C', '#F3D56B', '#E07A3F', '#C93C3C', '#E58FB4',
  '#9A6BD1', '#4A78D6', '#5DB8D9', '#5BAA5B', '#2E2E36', '#8D8F96', '#FFFFFF'];

function hintCanvas(it, w, hh) {
  let c = hintC.get(it.src);
  if (c && c.width === w && c.height === hh) return c;
  c = Object.assign(document.createElement('canvas'), { width: w, height: hh, className: 'tc-hints' });
  hintC.set(it.src, c);
  if (it.hints) {
    const im = new Image();
    im.crossOrigin = 'anonymous';
    im.onload = () => c.getContext('2d').drawImage(im, 0, 0, w, hh);
    im.src = fileUrl(it.hints);
  }
  return c;
}
const hasInk = c => {
  const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
  for (let i = 3; i < d.length; i += 16) if (d[i] > 0) return true;
  return false;
};
async function flushHints(it) {
  if (!it || !hintPending.has(it.src)) return;
  hintPending.delete(it.src);
  const c = hintC.get(it.src);
  if (!c || !hasInk(c)) { it.hints = null; keep(); return; }
  try {
    const blob = await new Promise(r => c.toBlob(r, 'image/png'));
    it.hints = await upload(new File([blob], `tocolar_hint_${stem(it.src)}_${Date.now()}.png`, { type: 'image/png' }));
    keep();
  } catch (e) { hintPending.add(it.src); log('warn', `подсказки не сохранены: ${e.message}`); }
}
function clearHints(it) {
  const c = hintC.get(it.src);
  if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
  hintPending.delete(it.src);
  it.hints = null; hintsDirty = false; keep(); render();
}
function setTool(t) { st.tool = t; keep(); render(); }

// ---------- отрисовка ----------
const field = (label, ctrl, hint) => h('div.tc-f', {}, h('label', {}, label), ctrl, hint ? h('div.tc-hint', {}, hint) : null);
function num(key, opts) {
  return stepper(h('input', { type: 'number', min: opts.min, max: opts.max, step: opts.step, value: st[key] ?? '', placeholder: opts.ph ?? '', onchange: e => {
    const v = e.target.value === '' ? null : Number(e.target.value);
    st[key] = v == null ? (DEF[key] ?? null) : v; keep(); render();
  } }));
}
function textarea(value, oninput, ph, rows = 2) {
  const t = h('textarea', { rows, spellcheck: false, placeholder: ph });
  t.value = value ?? '';
  t.addEventListener('input', () => oninput(t.value));
  return t;
}

function llmLine() {
  if (!llmProvs) return h('div.tc-hint', {}, llmLoading ? 'ищу vision-модель…' : 'автоцвета: подключите провайдера LLM');
  const provs = Object.entries(llmProvs).map(([id, p]) => [id, p.name || id]);
  if (!provs.length) return h('div.tc-hint', {}, 'нет провайдеров — Файл → Провайдеры LLM…');
  const prov = dropdown(st.llmProvider, provs, v => {
    st.llmProvider = v; st.llmModel = ''; llmPick = null; keep();
    ensureLlm(true).then(() => render());
  }, { width: 112 });
  const pick = h('button.tc-link', { type: 'button', 'data-tip': 'Модель, которая видит картинку (значок 👁)' }, st.llmModel || 'выбрать модель');
  pick.addEventListener('click', async () => {
    await getModels(st.llmProvider).catch(() => {});
    modelPicker(pick, { provider: st.llmProvider, value: st.llmModel, onPick: id => {
      st.llmModel = id; llmPick = { provider: st.llmProvider, model: id }; keep(); render();
    } });
  });
  return h('div.tc-llm', {}, icon('eye', { size: 13 }), prov, pick);
}

const range = (key, min, max, step, dflt = DEF[key]) => h('div.tc-rng', {}, h('input.ui-range', { type: 'range', min, max, step, value: st[key] ?? dflt,
  oninput: e => { st[key] = Number(e.target.value); e.target.nextSibling.textContent = st[key].toFixed(2); keep(); } }), h('b', {}, (st[key] ?? dflt).toFixed(2)));

// «Контуры»: ControlNet по линиям страницы (или прежний img2img), скачивание модели, если её нет
function contours() {
  const on_ = h('label.tc-check', { 'data-tip': 'SD видит линии страницы и красит точно по областям; без него — img2img по серой странице' },
    check(st.cn, v => { st.cn = v; keep(); render(); }), 'ControlNet по линиям страницы');
  const out = [h('div.tc-sub', {}, 'Контуры'), h('div.tc-auto', {}, on_)];
  if (!st.cn) {
    out.push(field('Denoise', range('denoise', 0.3, 0.95, 0.05), 'без ControlNet: меньше — ближе к исходнику и бледнее, больше — смелее цвет (0.65–0.8)'));
    return out;
  }
  const cn = cnName();
  if (!cn) {
    out.push(cnMissing('lines', { why: 'Нужна для SDXL Illustrious / NoobAI / Pony.', fallback: 'или выключите ControlNet — раскраска пойдёт прежним img2img' }));
    return out;
  }
  const btn = h('button.ui-dd.tc-ck', { type: 'button', 'data-tip': 'Модель ControlNet (папка controlnet библиотеки)',
    onclick: () => libraryPicker(btn, { cat: 'controlnet', value: cn, onPick: n => { st.cnModel = n; keep(); render(); } }) },
  icon('link', { size: 16 }), h('span.t', {}, name(cn).replace(/\.\w+$/, '')), h('span.chev', {}, icon('down', { size: 16 })));
  out.push(field('Модель ControlNet', btn),
    field('Сила контуров', range('cnStrength', 0.3, 1.5, 0.05), 'насколько точно генерация следует линиям (0.7–1)'),
    field('Контуры до', range('cnEnd', 0.3, 1, 0.05), 'доля шагов с ControlNet: последние шаги свободны — цвет мягче, без «жёстких» краёв'),
    field('Denoise', range('cnDenoise', 0.5, 1, 0.05), '1 — рисует цвет с нуля по контурам; меньше — от серой страницы (бледнее)'));
  return out;
}

// референс цвета для MangaNinja: цветной арт тех же персонажей — цвета берутся с него, SDXL не нужен
function refField() {
  const ref = st.refs[0];
  const set = f => { st.refs = f ? [f] : []; keep(); render(); };
  const disk = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' }, onchange: async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (f) try { set(await upload(f)); } catch (err) { log('error', `референс: ${err.message}`); }
  } });
  const pick = h('button.ui-btn.secondary.slim', { type: 'button', onclick: () => imagePicker(pick, { onPick: set }) }, icon('image', { size: 14 }), 'Из проекта');
  return field('Референс цвета (MangaNinja)', h('div.tc-ref', {},
    ref ? h('div.tc-ref-it', {}, h('img', { src: fileUrl(ref), alt: '', draggable: false }), h('span.t', {}, name(ref)),
      h('span.ui-tb', {}, h('button.b', { 'data-tip': 'Убрать референс', onclick: () => set(null) }, icon('closeSmall', { size: 16 })))) : null,
    h('div.tc-row', {}, h('button.ui-btn.secondary.slim', { type: 'button', onclick: () => disk.click() }, icon('open', { size: 14 }), 'С диска…'), disk, pick)),
  ref ? 'цвета персонажей — с этой картинки, для всех страниц' : 'необязательно: цветной арт тех же персонажей (обложка, кадр из аниме)');
}

// ручные настройки (автоподбор выключен)
function manual(p) {
  return [
    field('Негатив', textarea(st.negative, v => { st.negative = v; keep(); }, rec?.ok ? rec.prompt.negative : 'lowres, worst quality')),
    ninjaReady() ? h('div.tc-auto', {}, h('label.tc-check', { 'data-tip': 'После SDXL (или сразу по вашему референсу) MangaNinja перекрашивает каждую панель, строго по линиям' },
      check(st.engine === 'ninja', v => { st.engine = v ? 'ninja' : 'sd'; keep(); render(); }), 'MangaNinja по панелям')) : null,
    ...contours(),
    h('div.tc-sub', {}, 'Цвет'),
    field('Насыщенность', range('strength', 0, 1.6, 0.05, 1.1), 'слабый цвет генерации подтягивается автоматически'),
    field('Тени', range('shading', 0, 1, 0.05, 0.55), '0 — плоская заливка, 1 — вся светотень генерации; линии всегда из оригинала'),
    h('div.tc-auto', {}, h('label.tc-check', { 'data-tip': 'Линии страницы делят её на области, каждая берёт один цвет генерации: '
      + 'цвет не заходит за линии, без пятен. Выключено — цвет генерации попиксельно, со сглаживанием' },
    check(st.regions !== false, v => { st.regions = v; keep(); }), 'цвет по областям (не заходит за линии)')),
    h('div.tc-sub', {}, 'Генерация'),
    h('div.tc-row', {},
      field('Размер, Мп', num('megapixels', { min: 0.3, max: 2.5, step: 0.1 })),
      field('Seed', num('seed', { min: -1, step: 1 }))),
    h('div.tc-row', {},
      field('Шаги', num('steps', { min: 1, max: 100, step: 1, ph: p.steps ?? 25 })),
      field('CFG', num('cfg', { min: 0, max: 30, step: 0.5, ph: p.cfg ?? 6 }))),
  ];
}

// что увидели на картинке и с чем будем красить
function autoInfo(it) {
  if (!it) return [];
  const P = params(it), k = KINDS[it.kind];
  const how = P.ref ? 'MangaNinja по вашему референсу, по панелям'
    : (P.cn ? `SDXL: контуры ControlNet ${P.cnStrength}, тени ${P.shading}` : `SDXL img2img ${P.denoise}, без ControlNet`)
      + (P.engine === 'ninja' ? ' → MangaNinja по панелям' : '');
  const out = [h('div.tc-kind', {}, h('b', {}, st.tune ? (k ? k.label : 'смотрю на картинку…') : 'ручные настройки'),
    h('span', {}, `${how}${P.regions ? ', цвет по областям' : ''}`))];
  if (P.cn && !P.ref && cnNames() != null && !cnName()) {
    out.push(cnMissing('lines', { why: 'Нужна для раскраски по линиям (SDXL Illustrious / NoobAI / Pony).',
      fallback: 'или «Тонкая настройка» → выключите автоподбор и ControlNet — раскраска пойдёт img2img' }));
  }
  if (st.tune && !ninjaReady() && cnNames() != null && ['manga', 'lineart'].includes(it.kind)) {
    out.push(cnMissing('ninja', { why: 'Точнее держит линии и цвета персонажей по референсу (лицензия CC BY-NC — только некоммерческое).',
      fallback: 'необязательно: без неё красит SDXL' }));
  }
  return out;
}

function sidebar() {
  const ck = ckptName();
  const p = rec?.ok ? rec.params : {};
  const ckBtn = h('button.ui-dd.tc-ck', { type: 'button', 'data-tip': 'Чекпоинт для раскраски',
    onclick: () => libraryPicker(ckBtn, { cat: 'checkpoints', value: ck, onPick: n => { st.ckpt = n; rec = null; keep(); loadRec(); render(); } }) },
    icon('image', { size: 16 }), h(`span.t${ck ? '' : '.ph'}`, {}, ck ? name(ck).replace(/\.\w+$/, '') : 'выберите чекпоинт'), h('span.chev', {}, icon('down', { size: 16 })));
  const it = cur();
  const itemText = it ? textarea(it.prompt ?? '', v => { it.prompt = v; keep(); }, 'пусто — только общие подсказки', 2) : null;
  const adv = h('details.tc-adv', { open: !!st.adv },
    h('summary', {}, 'Тонкая настройка'),
    h('div.tc-auto', {}, h('label.tc-check', { 'data-tip': 'ToColar сам смотрит на картинку (лайнарт, манга с тоном, серая без линий, '
      + 'уже цветная) и ставит ControlNet, тени и способ переноса цвета. Выключите, чтобы настроить руками' },
    check(st.tune, v => { st.tune = v; keep(); render(); }), 'подбирать настройки сам')),
    ...(st.tune ? [h('div.tc-hint', {}, 'Снимите галочку, чтобы задать ControlNet, тени, насыщенность и шаги руками.')] : manual(p)));
  adv.addEventListener('toggle', () => { st.adv = adv.open; keep(); });
  return h('div.tc-side', {},
    h('div.tc-sec', {}, 'Модель'),
    field('Чекпоинт', ckBtn, rec?.ok ? `Magic: ${rec.profile || 'рекомендация'}` : 'аниме-SDXL (Illustrious / NoobAI / Pony) — лучше всего для манги'),
    ...autoInfo(it),
    h('div.tc-sec', {}, 'Цвета'),
    h('div.tc-auto', {}, h('label.tc-check', {}, check(st.auto, v => { st.auto = v; keep(); render(); }), 'придумывать цвета самому (vision-LLM)'), st.auto ? llmLine() : null),
    field('Персонажи — все страницы', textarea(st.cast, v => { st.cast = v; keep(); }, 'blonde hair, blue eyes, light skin, white shirt', 2)),
    field('Подсказка — все страницы', textarea(st.prompt, v => { st.prompt = v; keep(); }, 'краски сцены: красное платье, закат (можно по-русски)', 2)),
    it ? field('Цвета этой страницы', itemText, it.prompt ? 'придумано для этой страницы — можно править' : 'пусто — придумаются при раскраске') : null,
    h('div.tc-row', {},
      h('button.ui-btn.secondary.slim', { type: 'button', disabled: !it || !S.server.running || llmBusy > 0,
        'data-tip': 'vision-LLM опишет персонажей и цвета этой страницы',
        onclick: () => { if (it && !llmBusy) invent(it); } }, icon('spark', { size: 14 }), llmBusy ? 'Думаю…' : 'Придумать цвета'),
      h('button.ui-btn.secondary.slim', { type: 'button', disabled: !st.cast && !st.prompt, 'data-tip': 'Очистить общие подсказки',
        onclick: () => { st.cast = ''; st.prompt = ''; keep(); render(); } }, 'Очистить')),
    ninjaReady() ? refField() : null,
    adv,
    h('div.tc-hint', {}, 'Линии, тон и текст берутся из оригинала — меняется только цвет. Не тот цвет — «Кисть цвета» над страницей.'));
}

function listEl() {
  return h('div.tc-list', {},
    ...st.items.map((it, i) => h(`div.tc-it${i === st.sel ? '.sel' : ''}`, { onclick: () => { select_(i); },
      title: `${name(it.src)}${it.prompt ? '\n' + it.prompt : ''}`,
      ondragover: e => { if (transferHasImage(e.dataTransfer)) e.preventDefault(); } },
      h('img', { src: fileUrl(it.out || it.src), loading: 'lazy', alt: '', draggable: false }),
      h('div.tc-nm', {}, h('span', {}, name(it.src)),
        h(`span.tc-st.${it.status}`, {}, statusText(it, i))),
      h('span.ui-tb.tc-x', {}, h('button.b', { 'data-tip': 'Убрать из списка', onclick: e => { e.stopPropagation(); remove(i); } }, icon('closeSmall', { size: 16 }))))),
    st.items.length ? null : h('div.tc-drop', {}, icon('image', { size: 20 }), h('span', {}, 'Перетащите страницы сюда')));
}
async function select_(i) {
  await flushHints(cur());
  st.sel = clamp(i, 0, Math.max(0, st.items.length - 1)); hintsDirty = false; keep(); render();
}

const statusText = (it, i) => {
  if (it.status === 'run' && job?.index === i) {
    if (job.phase === 'prompt') return 'цвета…';
    if (job.phase === 'hints') return 'подсказки…';
    return job.max ? `шаг ${job.step}/${job.max}` : 'в работе…';
  }
  return { new: 'ожидает', run: 'в работе…', done: it.outs?.length > 1 ? `готово · ${it.outs.length} вар.` : 'готово', err: 'ошибка' }[it.status] || '';
};

const runText = () => {
  if (!job) return '';
  if (job.phase === 'prompt') return 'vision-LLM описывает страницу';
  if (job.phase === 'hints') return 'перекрашиваю по подсказкам';
  if (job.phase === 'ninja' && job.max) return `MangaNinja: шаг ${job.step} / ${job.max}`;
  if (!job.max) return job.posted ? 'в очереди…' : 'запуск…';
  return `шаг ${job.step} / ${job.max}`;
};
const runPct = () => (job?.max ? `${Math.round(100 * job.step / job.max)}%` : '0%');
const runTitle = () => (job?.phase === 'prompt' ? 'придумываю цвета…' : job?.phase === 'hints' ? 'применяю подсказки…' : 'раскрашиваю…');

function updateRun() {
  const s = viewEl?.querySelector('.tc-run-s'); if (s) s.textContent = runText();
  const f = viewEl?.querySelector('.tc-run-fill'); if (f) f.style.width = runPct();
  const t = viewEl?.querySelector('.tc-run-t'); if (t) t.textContent = runTitle();
  const g = viewEl?.querySelector('.tc-prog'); if (g) g.textContent = job ? `${name(st.items[job.index]?.src)} · ${runText()}` : '';
  if (!job) return;
  const row = viewEl?.querySelectorAll('.tc-it')?.[job.index];
  const stx = row?.querySelector('.tc-st');
  if (stx) stx.textContent = statusText(st.items[job.index], job.index);
}

// ---------- просмотр: сравнить / цвет / оригинал + кисть цвета ----------
function swatch() {
  const sw = h('button.tc-sw', { type: 'button', 'data-tip': `Цвет кисти ${st.hcolor}\nAlt+щелчок по странице — взять цвет` }, h('span', { style: { background: st.hcolor } }));
  let pop = null;
  const close = () => { if (!pop) return; pop.commit?.(); pop.remove(); pop = null; removeEventListener('pointerdown', outside, true); render(); };
  const outside = e => { if (pop && !pop.contains(e.target) && !sw.contains(e.target)) close(); };
  sw.onclick = () => {
    if (pop) return close();
    pop = colorPicker(st.hcolor, v => { st.hcolor = v; sw.firstChild.style.background = v; keep(); });
    pop.classList.add('floating');
    document.body.append(pop);
    const q = sw.getBoundingClientRect();
    pop.style.left = `${Math.max(4, Math.min(innerWidth - pop.offsetWidth - 4, q.left))}px`;
    pop.style.top = `${Math.min(innerHeight - pop.offsetHeight - 4, q.bottom + 6)}px`;
    addEventListener('pointerdown', outside, true);
  };
  return sw;
}

function viewer() {
  if (viewerRO) { viewerRO.disconnect(); viewerRO = null; }
  const it = cur();
  if (!it) {
    return h('div.tc-view.tc-empty', {}, icon('image', { size: 32 }), h('div.t-h2', {}, 'ToColar'),
      h('div.t-p', {}, 'Перетащите сюда чёрно-белые страницы манги или комикса, вставьте Ctrl+V или нажмите «С диска…» — ToColar сам подберёт настройки и раскрасит.'),
      h('div.tc-steps', {}, h('span', {}, '1. Добавьте страницы'), h('span', {}, '2. Выберите чекпоинт справа'), h('span', {}, '3. «Раскрасить»'),
        h('span', {}, '4. Не тот цвет — «Кисть цвета» и «Применить»')));
  }
  const after = it.out ? fileUrl(it.out) : null;
  const painting = st.tool === 'brush' || st.tool === 'eraser';
  const vmode = !after ? 'before' : painting ? 'after' : st.vmode;
  const zoom = () => it.zoom || 1;
  const cmp = h(`div.tc-cmp.m-${vmode}${painting ? '.paint' : ''}`);
  const stage = h('div.tc-stage');
  const before = h('img.tc-before', { src: fileUrl(it.src), alt: '', draggable: false });
  let top = null, bar = null, hc = null;
  stage.append(before);
  if (after) {
    top = h('img.tc-after', { crossOrigin: 'anonymous', src: after, alt: '', draggable: false });
    stage.append(top);
    if (vmode === 'split') { bar = h('div.tc-bar', { title: 'Тяните шторку' }, h('div.tc-grip', {}, icon('split', { size: 13 }))); stage.append(bar); }
  }
  const cursor = h('div.tc-cur', { style: { display: 'none' } });
  stage.append(cursor);
  cmp.append(stage);

  const setSplit = v => {
    st.split = clamp(v, 0, 1);
    if (top) top.style.clipPath = vmode === 'split' ? `inset(0 0 0 ${st.split * 100}%)` : 'none';
    if (bar) bar.style.left = `${st.split * 100}%`;
  };
  const attachHints = () => {
    if (hc || !before.naturalWidth) return;
    hc = hintCanvas(it, before.naturalWidth, before.naturalHeight);
    stage.insertBefore(hc, cursor);
  };
  const applyLayout = () => {
    const w = before.naturalWidth || 3, hgt = before.naturalHeight || 4;
    const cw = Math.max(40, cmp.clientWidth), ch = Math.max(40, cmp.clientHeight);
    const k = Math.min(cw / w, ch / hgt) * zoom();
    stage.style.width = `${Math.max(1, Math.round(w * k))}px`;
    stage.style.height = `${Math.max(1, Math.round(hgt * k))}px`;
    attachHints();
  };

  const pctEl = h('b.tc-z', {}, `${Math.round(zoom() * 100)}%`);
  const setZoom = (z, focus = null) => {
    const r = stage.getBoundingClientRect();
    const cr = cmp.getBoundingClientRect();
    const fx = focus ? focus.x : cr.left + cmp.clientWidth / 2;
    const fy = focus ? focus.y : cr.top + cmp.clientHeight / 2;
    const rx = clamp((fx - r.left) / (r.width || 1), 0, 1);
    const ry = clamp((fy - r.top) / (r.height || 1), 0, 1);
    it.zoom = clamp(z, 1, 8); keep(); applyLayout();
    const nr = stage.getBoundingClientRect();
    cmp.scrollLeft += (nr.left + rx * nr.width) - fx;
    cmp.scrollTop += (nr.top + ry * nr.height) - fy;
    pctEl.textContent = `${Math.round(zoom() * 100)}%`;
    cmp.classList.toggle('zoomed', zoom() > 1.01);
  };

  applyLayout();
  before.addEventListener('load', applyLayout);
  if (before.complete) applyLayout();
  setSplit(st.split);
  top?.addEventListener('load', applyLayout);
  if (window.ResizeObserver) {
    viewerRO = new ResizeObserver(() => requestAnimationFrame(applyLayout));
    viewerRO.observe(cmp);
  }

  // мышь: шторка (в «Сравнить»), кисть/ластик подсказок, сдвиг в увеличении (ПКМ / колесо-клик — всегда)
  let drag = null;
  const pagePt = e => { const r = stage.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, r }; };
  const moveSplit = e => { const r = stage.getBoundingClientRect(); if (r.width) setSplit((e.clientX - r.left) / r.width); };
  const pickColor = e => {
    const p = pagePt(e), src = top?.naturalWidth ? top : before;
    try {
      const c = document.createElement('canvas'); c.width = c.height = 1;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(src, Math.floor(p.x * src.naturalWidth), Math.floor(p.y * src.naturalHeight), 1, 1, 0, 0, 1, 1);
      const [r, g, b] = x.getImageData(0, 0, 1, 1).data;
      st.hcolor = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
      st.tool = 'brush'; keep(); render();
    } catch { log('warn', 'цвет не взялся — картинка ещё грузится'); }
  };
  const stroke = (a, b) => {
    if (!hc) return;
    const x = hc.getContext('2d');
    const k = hc.width / a.r.width;
    x.save();
    x.globalCompositeOperation = st.tool === 'eraser' ? 'destination-out' : 'source-over';
    x.strokeStyle = st.hcolor; x.lineCap = x.lineJoin = 'round'; x.lineWidth = Math.max(1, st.hsize * k);
    x.beginPath(); x.moveTo(a.x * hc.width, a.y * hc.height); x.lineTo(b.x * hc.width + 0.01, b.y * hc.height); x.stroke();
    x.restore();
  };
  cmp.addEventListener('pointerdown', e => {
    const pan = e.button === 1 || e.button === 2 || (e.button === 0 && zoom() > 1.01 && !painting && vmode !== 'split');
    if (pan) {
      e.preventDefault();
      cmp.setPointerCapture(e.pointerId);
      drag = { kind: 'pan', x: e.clientX, y: e.clientY, sl: cmp.scrollLeft, st: cmp.scrollTop };
      cmp.classList.add('grabbing');
      return;
    }
    if (e.button !== 0) return;
    if (painting) {
      if (e.altKey) return pickColor(e);
      attachHints();
      cmp.setPointerCapture(e.pointerId);
      const p = pagePt(e);
      drag = { kind: 'paint', last: p };
      stroke(p, p);
      return;
    }
    if (top && vmode === 'split') {
      cmp.setPointerCapture(e.pointerId);
      drag = { kind: 'split' };
      moveSplit(e);
    }
  });
  cmp.addEventListener('pointermove', e => {
    if (painting) {
      const r = stage.getBoundingClientRect();
      Object.assign(cursor.style, { display: '', width: `${st.hsize}px`, height: `${st.hsize}px`, left: `${e.clientX - r.left}px`,
        top: `${e.clientY - r.top}px`, borderColor: st.tool === 'eraser' ? '#fff' : st.hcolor });
    }
    if (!drag) return;
    if (drag.kind === 'split') moveSplit(e);
    else if (drag.kind === 'paint') { const p = pagePt(e); stroke(drag.last, p); drag.last = p; }
    else { cmp.scrollLeft = drag.sl - (e.clientX - drag.x); cmp.scrollTop = drag.st - (e.clientY - drag.y); }
  });
  cmp.addEventListener('pointerleave', () => { cursor.style.display = 'none'; });
  const endDrag = () => {
    if (!drag) return;
    const was = drag.kind;
    drag = null; cmp.classList.remove('grabbing');
    if (was === 'paint') {
      hintPending.add(it.src);
      if (!hintsDirty) { hintsDirty = true; render(); }
    } else if (top) keep();
  };
  cmp.addEventListener('pointerup', endDrag);
  cmp.addEventListener('pointercancel', endDrag);
  cmp.addEventListener('contextmenu', e => e.preventDefault());
  cmp.addEventListener('wheel', e => {
    if (!before.naturalWidth) return;
    e.preventDefault();
    if (painting && (e.ctrlKey || e.altKey)) {
      st.hsize = clamp(Math.round(st.hsize * (e.deltaY < 0 ? 1.15 : 1 / 1.15)), 2, 200); keep();
      cursor.style.width = cursor.style.height = `${st.hsize}px`;
      return;
    }
    const z = zoom() * (e.deltaY < 0 ? 1.15 : 1 / 1.15);
    if (z <= 1.005) { if (zoom() > 1) setZoom(1); return; }
    if (z > 8) return;
    setZoom(z, { x: e.clientX, y: e.clientY });
  }, { passive: false });
  cmp.classList.toggle('zoomed', zoom() > 1.01);

  // панель просмотра: режим, инструмент, варианты, масштаб
  const seg = (items, val, set) => h('span.ui-seg', {}, ...items.map(([v, label, tip, dis]) =>
    h(`button${v === val ? '.on' : ''}`, { type: 'button', disabled: !!dis, 'data-tip': tip || '', onclick: () => set(v) }, label)));
  const modes = seg([['split', 'Сравнить', 'Шторка «до / после»', !after], ['after', 'Цвет', 'Только результат', !after], ['before', 'Оригинал', 'Только оригинал']],
    vmode, v => { st.vmode = v; if (painting) st.tool = 'split'; keep(); render(); });
  const tools = seg([['split', 'Смотреть', 'Просмотр и шторка (V)'],
    ['brush', 'Кисть цвета', 'Штрих по неверно окрашенному месту — вся область между линиями станет этого цвета (B)\nAlt+щелчок — взять цвет, Ctrl+колесо — размер'],
    ['eraser', 'Ластик', 'Стереть подсказку (E)']], painting ? st.tool : 'split', setTool);
  const hasHints = !!it.hints || hintPending.has(it.src);
  const quick = !!(it.out && it.gens?.[it.out]);
  const paintBar = painting ? h('div.tc-pbar', {},
    swatch(),
    h('span.tc-pal', {}, ...PALETTE.map(c => h(`button${c === String(st.hcolor).toUpperCase() ? '.on' : ''}`, { type: 'button', style: { background: c }, 'data-tip': c,
      onclick: () => { st.hcolor = c; st.tool = 'brush'; keep(); render(); } }))),
    h('span.tc-rng.tc-size', { 'data-tip': 'Размер кисти (Ctrl+колесо, [ ])' }, h('input.ui-range', { type: 'range', min: 2, max: 120, step: 1, value: st.hsize,
      oninput: e => { st.hsize = +e.target.value; e.target.nextSibling.textContent = `${st.hsize}px`; keep(); } }), h('b', {}, `${st.hsize}px`)),
    h('span.grow'),
    h('button.ui-btn.secondary.slim', { type: 'button', disabled: !hasHints, 'data-tip': 'Стереть все подсказки этой страницы', onclick: () => clearHints(it) }, icon('delete', { size: 14 }), 'Стереть'),
    h(`button.ui-btn.${hintsDirty ? 'primary' : 'secondary'}.slim`, { type: 'button', disabled: !!job || !hasHints,
      'data-tip': quick ? 'Перекрасить по подсказкам — за секунды, без новой генерации' : 'Раскрасить страницу с подсказками (полная генерация)',
      onclick: () => { hintsDirty = false; applyHints(); } }, icon('check', { size: 14 }), quick ? 'Применить' : 'Раскрасить с подсказками')) : null;

  const zbtns = h('div.tc-zctl', {},
    h('span.ui-tb', {}, h('button.b', { 'data-tip': 'Уменьшить', onclick: () => setZoom(zoom() / 1.25) }, icon('zoomOut', { size: 14 }))),
    pctEl,
    h('span.ui-tb', {}, h('button.b', { 'data-tip': 'Увеличить (или колесо мыши)', onclick: () => setZoom(zoom() * 1.25) }, icon('zoomIn', { size: 14 }))),
    h('span.ui-tb', {}, h('button.b', { 'data-tip': 'По размеру', onclick: () => setZoom(1) }, icon('fit', { size: 14 }))));

  const outs = it.outs?.length ? it.outs : (it.out ? [it.out] : []);
  const vi = Math.max(0, outs.indexOf(it.out));
  const vars = outs.length > 1 ? h('div.tc-zctl', {},
    h('span.ui-tb', {}, h('button.b', { 'data-tip': 'Прошлый вариант', disabled: vi === 0, onclick: () => { it.out = outs[Math.max(0, vi - 1)]; keep(); render(); } }, icon('left', { size: 14 }))),
    h('span.tc-vn', {}, `вариант ${vi + 1} / ${outs.length}`),
    h('span.ui-tb', {}, h('button.b', { 'data-tip': 'Следующий вариант', disabled: vi === outs.length - 1, onclick: () => { it.out = outs[Math.min(outs.length - 1, vi + 1)]; keep(); render(); } }, icon('right', { size: 14 })))) : null;

  if (job?.index === st.sel) {
    stage.append(h('div.tc-run', {},
      h('div.tc-run-card', {},
        h('div.tc-spin'),
        h('div.tc-run-t', {}, runTitle()),
        h('div.tc-run-s', {}, runText()),
        h('div.tc-run-bar', {}, h('div.tc-run-fill', { style: { width: runPct() } })))));
  }

  const capt = painting ? 'кисть цвета: штрих по месту с неверным цветом → «Применить». Одна точка красит всю область между линиями; ПКМ — сдвиг'
    : !after ? (job?.index === st.sel ? 'раскрашивается…' : 'ещё не раскрашено — «Раскрасить» сверху')
      : vmode === 'split' ? 'слева — оригинал, справа — цвет; тяните шторку' : vmode === 'after' ? 'результат' : 'оригинал';
  return h('div.tc-view', {},
    h('div.tc-vbar', {}, modes, h('span.tc-sep'), tools, h('span.grow'), vars, zbtns),
    paintBar,
    cmp,
    h('div.tc-cap', {}, h('span.tc-capt', {}, capt), h('span.grow'),
      hasHints && !painting ? h('span.tc-badge', { 'data-tip': 'На странице есть подсказки цвета — они учитываются при раскраске' }, 'подсказки цвета') : null));
}

// результат → новый холст ImageNaizer (доработать маской и inpaint)
async function toNaizer(it) {
  if (!it?.out) return;
  openWorkspace('naizer');
  await naizerApi.open([it.out], `ToColar: ${stem(it.src)}`);
  log('ok', `открыто в ImageNaizer: ${name(it.out)}`);
}

function render() {
  if (!viewEl) return;
  const files = h('input', { type: 'file', accept: 'image/*', multiple: true, style: { display: 'none' }, onchange: e => { addFromDisk([...e.target.files]); e.target.value = ''; } });
  const pending = st.items.filter(i => i.status !== 'done').length;
  const it = cur();
  const fromLib = h('button.ui-btn.secondary.slim', { onclick: () => imagePicker(fromLib, { onPick: f => add([f]) }), 'data-tip': 'Из загруженных (input/) или результатов (output/)' }, icon('image', { size: 16 }), 'Из проекта');
  const bar = h('div.tc-top', {},
    h('button.ui-btn.secondary.slim', { onclick: () => files.click(), 'data-tip': 'Выбрать картинки на диске — можно сразу несколько' }, icon('open', { size: 16 }), 'С диска…'), files,
    fromLib,
    h('span.tc-sep'),
    job ? h('button.ui-btn.secondary.slim', { onclick: stop, 'data-tip': 'Остановить очередь' }, icon('stop', { size: 16 }), 'Стоп')
      : h('button.ui-btn.primary.slim', { onclick: () => start(), disabled: !pending, 'data-tip': 'Раскрасить все, что ещё не готовы' }, icon('play', { size: 16 }), `Раскрасить${pending ? ` (${pending})` : ''}`),
    it && !job ? h('button.ui-btn.secondary.slim', { onclick: () => start(st.sel), 'data-tip': 'Раскрасить выбранную ещё раз — новый вариант' }, icon('refresh', { size: 16 }), 'Ещё вариант') : null,
    job ? h('span.tc-prog', {}, `${name(st.items[job.index]?.src)} · ${runText()}`) : null,
    h('span.grow'),
    it?.out ? h('button.ui-btn.secondary.slim', { onclick: () => toNaizer(it), 'data-tip': 'Открыть результат новым холстом ImageNaizer — доработать маской и inpaint' }, icon('spark', { size: 16 }), 'В ImageNaizer') : null,
    it?.out ? h('a.ui-link', { href: fileUrl(it.out), target: '_blank', 'data-tip': it.out }, 'открыть файл') : null,
    st.items.some(i => i.status === 'done') && !job ? h('div.ui-tb', {}, h('button.b', { 'data-tip': 'Убрать готовые из списка', onclick: () => { st.items = st.items.filter(i => i.status !== 'done'); st.sel = 0; keep(); render(); } }, icon('delete', { size: 16 }))) : null);
  const top = viewEl.querySelector('.tc-side')?.scrollTop || 0; // перерисовка не сбрасывает прокрутку настроек
  viewEl.replaceChildren(bar, h('div.tc-body', {}, listEl(), viewer(), sidebar()));
  const side = viewEl.querySelector('.tc-side');
  if (side) side.scrollTop = top;
}

// ---------- клавиши: B — кисть, E — ластик, V — смотреть, [ ] — размер, ↑ ↓ — страницы ----------
function keys(e) {
  if (activeView() !== 'tocolar' || e.ctrlKey || e.metaKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  const k = e.key.toLowerCase();
  let done = true;
  if (k === 'b' || k === 'и') setTool('brush');
  else if (k === 'e' || k === 'у') setTool('eraser');
  else if (k === 'v' || k === 'м') setTool('split');
  else if (e.key === '[' || k === 'х') { st.hsize = clamp(Math.round(st.hsize / 1.2), 2, 200); keep(); render(); }
  else if (e.key === ']' || k === 'ъ') { st.hsize = clamp(Math.round(st.hsize * 1.2), 2, 200); keep(); render(); }
  else if (e.key === 'ArrowUp' && st.items.length) select_(st.sel - 1);
  else if (e.key === 'ArrowDown' && st.items.length) select_(st.sel + 1);
  else done = false;
  if (done) { e.preventDefault(); e.stopPropagation(); }
}

// ---------- регистрация ----------
export function showTocolar() {
  viewEl = document.getElementById('v-tocolar');
  render();
  if (!rec) loadRec();
  if (st.auto) ensureLlm();
  for (const it of st.items) if (!it.kind && S.server.running) classify(it);
  if (cnNames() == null) loadCn();
}

export function initTocolar() {
  viewEl = document.getElementById('v-tocolar');
  for (const it of st.items) if (it.status === 'run') it.status = it.out ? 'done' : 'new'; // запуск прервался вместе с окном
  document.addEventListener('keydown', keys, true);
  on('run-progress', d => {
    if (!job || !job.pid || d.prompt_id !== job.pid || !['ks', 'ninja'].includes(d.node)) return;
    job.phase = d.node === 'ninja' ? 'ninja' : 'sd';
    job.step = d.value; job.max = d.max;
    updateRun();
  });
  on('run-preview', d => {
    if (!job || !job.pid || d.prompt_id !== job.pid) return;
    job.preview = d.image; // латент-превью для раскраски бесполезно (шум) — показываем только прогресс
  });
  on('run-output', d => {
    const w = waits.get(d.prompt_id);
    if (w && d.node === 'out') { w.ok((d.output?._ui?.text || '').trim()); return; }
    if (!job || !job.pid || d.prompt_id !== job.pid) return;
    // цвет генерации (после MangaNinja — его) — для быстрого «Применить» подсказок без новой генерации
    if (d.node === 'dec' || d.node === 'ninja') { const g = d.output?._ui?.images?.[0]; if (g) job.colors = g; return; }
    if (d.node !== 'keep') return;
    const it = st.items[job.index], f = d.output?._ui?.images?.[0];
    if (it && f) {
      setResult(it, f, job.colors); job.preview = null; keep(); log('ok', `раскрашено: ${f}`); updateRun();
    }
  });
  on('run-error', d => { const w = waits.get(d.prompt_id); if (w) w.fail(new Error(String(d.message || 'ошибка LLM'))); });
  on('run-done', d => {
    const w = waits.get(d.prompt_id);
    if (w) w.fail(new Error(d.stopped ? 'прервано' : d.error?.message || 'пустой ответ'));
    if (job && job.pid && (!d.prompt_id || d.prompt_id === job.pid)) finish(d);
  });
  setInterval(reconcile, 4000);
  on('cn-models', () => { if (viewEl?.isConnected) render(); }); // модели ControlNet: список, загрузка
  on('server', s => {
    if (!s.running) return;
    setTimeout(() => {
      rec = null; llmPick = null; llmProvs = null; llmWarned = false;
      if (viewEl?.isConnected) { loadRec(); if (st.auto) ensureLlm(true); }
    }, 900);
  });
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
