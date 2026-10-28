// Граф из картинки или файла: PNG maistep (iTXt «maistep» — граф запуска, вшивает сервер: registry Ctx.pnginfo),
// PNG ComfyUI (tEXt «prompt» — формат API, «workflow» — формат интерфейса) и .json тех же форматов.
// Ноды ComfyUI переводятся в ноды maistep по таблице COMFY (ядро SD: чекпоинт, LoRA, CLIP, латент, KSampler, VAE,
// ControlNet, картинки); остальные пропускаются с предупреждением. Результат — новый воркфлоу (importGraph).
import { S, emit, addDoc, uniqueId } from './store.js';
import { api, fileUrl } from './backend.js';

const log = (level, text) => emit('log', { src: 'editor', level, text });

// ---------- PNG: текстовые чанки ----------
async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function pngText(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), out = {};
  if (u8.length < 8 || u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) return out;
  const utf = new TextDecoder();
  for (let o = 8; o + 8 <= u8.length;) {
    const len = dv.getUint32(o), type = String.fromCharCode(...u8.subarray(o + 4, o + 8));
    const d = u8.subarray(o + 8, o + 8 + len);
    o += 12 + len;
    if (type === 'IEND') break;
    try {
      const z = d.indexOf(0);
      if (z < 0) continue;
      const key = utf.decode(d.subarray(0, z));
      if (type === 'tEXt') out[key] = utf.decode(d.subarray(z + 1));
      else if (type === 'zTXt') out[key] = utf.decode(await inflate(d.subarray(z + 2)));
      else if (type === 'iTXt') { // ключ\0 сжато метод язык\0 перевод\0 текст
        const comp = d[z + 1];
        let p = d.indexOf(0, z + 3); p = d.indexOf(0, p + 1);
        const body = d.subarray(p + 1);
        out[key] = utf.decode(comp ? await inflate(body) : body);
      }
    } catch { /* битый чанк — пропускаем */ }
  }
  return out;
}

// ---------- что внутри: { kind: 'maistep' | 'comfy', wf | prompt+ui, name } ----------
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const isMaistep = j => j && Array.isArray(j.nodes) && !isComfyUi(j) && j.nodes.every(n => typeof n?.type === 'string' && 'id' in n) && Array.isArray(j.links ?? []) && (j.links || []).every(l => l && 'from' in l && 'to' in l);
const isComfyUi = j => j && Array.isArray(j.nodes) && j.nodes.some(n => n && 'widgets_values' in n || n?.type && Array.isArray(n?.pos));
const isComfyApi = j => j && typeof j === 'object' && !Array.isArray(j) && Object.values(j).length && Object.values(j).every(n => n && typeof n.class_type === 'string');

function classify(texts, name) {
  const m = parse(texts.maistep || '');
  if (m?.workflow && isMaistep(m.workflow)) return { kind: 'maistep', wf: m.workflow, name };
  const prompt = parse(texts.prompt || ''), ui = parse(texts.workflow || '');
  if (isComfyApi(prompt) || isComfyUi(ui)) return { kind: 'comfy', prompt: isComfyApi(prompt) ? prompt : null, ui: isComfyUi(ui) ? ui : null, name };
  return null;
}

// src: File | Blob | путь проекта (input/…, output/…) → граф или null
export async function graphFromImage(src) {
  try {
    const name = typeof src === 'string' ? src.split('/').pop() : src?.name || 'image';
    const buf = typeof src === 'string' ? await (await fetch(fileUrl(src))).arrayBuffer() : await src.arrayBuffer();
    return classify(await pngText(buf), name);
  } catch { return null; }
}

export function graphFromJson(text, name = 'workflow.json') {
  const j = parse(text);
  if (!j) return null;
  if (isMaistep(j)) return { kind: 'maistep', wf: j, name };
  if (j.workflow && isMaistep(j.workflow)) return { kind: 'maistep', wf: j.workflow, name };
  if (isComfyApi(j)) return { kind: 'comfy', prompt: j, ui: null, name };
  if (isComfyUi(j)) return { kind: 'comfy', prompt: null, ui: j, name };
  return null;
}

// ---------- ComfyUI → maistep ----------
// type — нода maistep; in — имя входа ComfyUI → имя maistep; out — выходы по номеру слота ComfyUI;
// w — порядок widgets_values в формате интерфейса (null — пропустить значение, например control_after_generate)
const COMFY = {
  CheckpointLoaderSimple: { type: 'sd.checkpoint', in: { ckpt_name: 'ckpt_name' }, out: ['model', 'clip', 'vae'], w: ['ckpt_name'] },
  LoraLoader: { type: 'sd.lora', in: { model: 'model', clip: 'clip', lora_name: 'lora_name', strength_model: 'strength_model', strength_clip: 'strength_clip' },
    out: ['model', 'clip'], w: ['lora_name', 'strength_model', 'strength_clip'] },
  LoraLoaderModelOnly: { type: 'sd.lora', in: { model: 'model', lora_name: 'lora_name', strength_model: 'strength_model' }, out: ['model'], w: ['lora_name', 'strength_model'] },
  VAELoader: { type: 'sd.vae', in: { vae_name: 'vae_name' }, out: ['vae'], w: ['vae_name'] },
  CLIPSetLastLayer: { type: 'sd.clip_skip', in: { clip: 'clip', stop_at_clip_layer: 'stop_at_clip_layer' }, out: ['clip'], w: ['stop_at_clip_layer'] },
  CLIPTextEncode: { type: 'sd.text_encode', in: { clip: 'clip', text: 'text' }, out: ['conditioning'], w: ['text'] },
  EmptyLatentImage: { type: 'sd.empty_latent', in: { width: 'width', height: 'height', batch_size: 'batch_size' }, out: ['latent'], w: ['width', 'height', 'batch_size'] },
  LatentUpscale: { type: 'sd.latent_upscale', in: { samples: 'samples', upscale_method: 'upscale_method', width: 'width', height: 'height' }, out: ['latent'],
    w: ['upscale_method', 'width', 'height', null] },
  KSampler: { type: 'sd.ksampler', in: { model: 'model', positive: 'positive', negative: 'negative', latent_image: 'latent_image', seed: 'seed', steps: 'steps',
    cfg: 'cfg', sampler_name: 'sampler_name', scheduler: 'scheduler', denoise: 'denoise' }, out: ['latent'],
    w: ['seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise'] },
  KSamplerAdvanced: { type: 'sd.ksampler', in: { model: 'model', positive: 'positive', negative: 'negative', latent_image: 'latent_image', noise_seed: 'seed',
    steps: 'steps', cfg: 'cfg', sampler_name: 'sampler_name', scheduler: 'scheduler' }, out: ['latent'],
    w: [null, 'seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', null, null, null] },
  VAEDecode: { type: 'sd.vae_decode', in: { samples: 'samples', vae: 'vae' }, out: ['image'] },
  VAEEncode: { type: 'sd.vae_encode', in: { pixels: 'pixels', vae: 'vae' }, out: ['latent'] },
  ControlNetLoader: { type: 'sd.controlnet_load', in: { control_net_name: 'control_net_name' }, out: ['control_net'], w: ['control_net_name'] },
  ControlNetApplyAdvanced: { type: 'sd.controlnet_apply', in: { positive: 'positive', negative: 'negative', control_net: 'control_net', image: 'image',
    strength: 'strength', start_percent: 'start_percent', end_percent: 'end_percent' }, out: ['positive', 'negative'], w: ['strength', 'start_percent', 'end_percent'] },
  LoadImage: { type: 'image.load', in: { image: 'file' }, out: ['image'], w: ['file', null] },
  SaveImage: { type: 'image.save', in: { images: 'image', filename_prefix: 'prefix' }, out: [], w: ['prefix'] },
  PreviewImage: { type: 'image.preview', in: { images: 'image' }, out: [] },
  // обнулённый негатив ≈ пустой промпт на том же CLIP (clip берём у исходного CLIP Text Encode)
  ConditioningZeroOut: { type: 'sd.text_encode', in: { conditioning: '@zero' }, out: ['conditioning'], zero: true },
};
COMFY['CheckpointLoader|pysssss'] = COMFY.CheckpointLoaderSimple;
COMFY['LoraLoader|pysssss'] = COMFY.LoraLoader;
const MODEL_CAT = { ckpt_name: 'checkpoints', lora_name: 'loras', vae_name: 'vae', control_net_name: 'controlnet' };

// значения ComfyUI, которых нет в maistep
function fixValue(type, key, v, warn) {
  const opts = S.nodes['sd.ksampler']?.inputs?.[key]?.options; // варианты из каталога нод сервера
  if (key === 'sampler_name' && typeof v === 'string' && opts && !opts.includes(v)) {
    const base = v.replace(/_gpu$|_cfg_pp$/, ''), pick = opts.includes(base) ? base : 'euler';
    warn(`сэмплер ${v} → ${pick}`);
    return pick;
  }
  if (key === 'scheduler' && typeof v === 'string' && opts && !opts.includes(v)) { warn(`планировщик ${v} → normal`); return 'normal'; }
  if (key === 'file' && typeof v === 'string' && !/^(input|output)\//.test(v)) return `input/${v}`;
  if (key === 'stop_at_clip_layer' && typeof v === 'number' && v > 0) return -v;
  return v;
}

// имя модели ComfyUI → имя из библиотеки maistep (тот же формат; не нашлось точно — по имени файла)
function matchModel(cat, name, lib, warn) {
  if (!lib || !name) return name;
  const items = lib.filter(it => it.cat === cat);
  if (items.some(it => it.name === name)) return name;
  const base = String(name).split(/[\\/]/).pop().toLowerCase();
  const hit = items.find(it => it.name.split(/[\\/]/).pop().toLowerCase() === base);
  if (hit) return hit.name;
  warn(`нет в библиотеке (${cat}): ${name}`);
  return name;
}

function comfyToMaistep({ prompt, ui }, lib) {
  const warns = new Set(), warn = t => warns.add(t);
  const nodes = [], links = [], idOf = new Map(), defOf = new Map(), skipped = new Map(), zero = [];
  const uiNodes = new Map((ui?.nodes || []).map(n => [String(n.id), n]));
  // узлы: из формата API (значения и связи по именам), позиции/выключенность — из формата интерфейса
  const src = prompt ? Object.entries(prompt).map(([id, n]) => ({ id, cls: n.class_type, inputs: n.inputs || {}, ui: uiNodes.get(id) }))
    : (ui?.nodes || []).map(n => ({ id: String(n.id), cls: n.type, ui: n }));
  let k = 0;
  for (const s of src) {
    const def = COMFY[s.cls];
    if (!def) { if (!['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote'].includes(s.cls)) skipped.set(s.cls, (skipped.get(s.cls) || 0) + 1); continue; }
    const id = `n${++k}`, props = {};
    idOf.set(s.id, id); defOf.set(s.id, def);
    if (prompt) for (const [ck, v] of Object.entries(s.inputs)) if (!Array.isArray(v) && def.in[ck]) props[def.in[ck]] = v;
    // формат интерфейса — по порядку виджетов; при формате API — то, что пришло связью от непереводимой ноды
    // (ResolutionSelector → width/height и т.п.): в виджетах ComfyUI хранит и такие значения
    (def.w || []).forEach((key, i) => { if (key && props[key] === undefined && s.ui?.widgets_values?.[i] !== undefined) props[key] = s.ui.widgets_values[i]; });
    if (def.zero) { props.text = ''; warn('ConditioningZeroOut → пустой CLIP Text Encode (почти то же)'); }
    for (const key of Object.keys(props)) {
      props[key] = fixValue(def.type, key, props[key], warn);
      if (MODEL_CAT[key]) props[key] = matchModel(MODEL_CAT[key], props[key], lib, warn);
    }
    const pos = Array.isArray(s.ui?.pos) ? s.ui.pos : s.ui?.pos && typeof s.ui.pos === 'object' ? [s.ui.pos[0], s.ui.pos[1]] : [];
    const n = { id, type: def.type, x: Number(pos[0]) || 0, y: Number(pos[1]) || 0, props };
    if (s.ui && (s.ui.mode === 2 || s.ui.mode === 4)) n.mode = 'mute';
    nodes.push(n);
  }
  // связи
  if (prompt) {
    for (const s of src) {
      const def = defOf.get(s.id);
      if (!def) continue;
      for (const [ck, v] of Object.entries(s.inputs)) {
        if (!Array.isArray(v) || !def.in[ck]) continue;
        const [from, slot] = v, fd = defOf.get(String(from));
        if (def.in[ck] === '@zero') { zero.push({ to: idOf.get(s.id), src: idOf.get(String(from)) }); continue; }
        if (fd?.out[slot]) links.push({ from: idOf.get(String(from)), out: fd.out[slot], to: idOf.get(s.id), in: def.in[ck] });
      }
    }
  } else {
    const L = new Map((ui.links || []).map(l => [l[0], { from: String(l[1]), slot: l[2], to: String(l[3]), toSlot: l[4] }]));
    const source = (lid, guard = 0) => { // сквозь Reroute
      const l = L.get(lid);
      if (!l || guard > 50) return null;
      const n = uiNodes.get(l.from);
      if (n?.type === 'Reroute') return source(n.inputs?.[0]?.link, guard + 1);
      return l;
    };
    for (const s of src) {
      const def = defOf.get(s.id);
      if (!def) continue;
      for (const inp of s.ui.inputs || []) {
        if (inp.link == null || !def.in[inp.name]) continue;
        const l = source(inp.link), fd = l && defOf.get(l.from);
        if (def.in[inp.name] === '@zero') { if (l) zero.push({ to: idOf.get(s.id), src: idOf.get(l.from) }); continue; }
        if (fd?.out[l.slot]) links.push({ from: idOf.get(l.from), out: fd.out[l.slot], to: idOf.get(s.id), in: def.in[inp.name] });
      }
    }
  }
  for (const z of zero) {
    const c = links.find(l => l.to === z.src && l.in === 'clip');
    if (c) links.push({ from: c.from, out: c.out, to: z.to, in: 'clip' });
  }
  layout(nodes, links);
  for (const [cls, n] of skipped) warn(`нода ComfyUI «${cls}»${n > 1 ? ` ×${n}` : ''} не поддерживается — пропущена`);
  return { nodes, links, warns: [...warns] };
}

// позиции: из ComfyUI (сдвиг к началу координат), без них — колонки по глубине графа
function layout(nodes, links) {
  if (nodes.some(n => n.x || n.y)) {
    const x0 = Math.min(...nodes.map(n => n.x)), y0 = Math.min(...nodes.map(n => n.y));
    for (const n of nodes) { n.x = Math.round((n.x - x0) / 10) * 10 + 40; n.y = Math.round((n.y - y0) / 10) * 10 + 40; }
    return;
  }
  const depth = new Map(nodes.map(n => [n.id, 0]));
  for (let i = 0; i < nodes.length; i++) for (const l of links) depth.set(l.to, Math.max(depth.get(l.to), depth.get(l.from) + 1));
  const rows = new Map();
  for (const n of nodes) {
    const d = depth.get(n.id), r = rows.get(d) || 0;
    rows.set(d, r + 1);
    n.x = 40 + d * 300; n.y = 40 + r * 220;
  }
}

// ---------- новый воркфлоу ----------
export async function importGraph(found) {
  let data, title;
  if (found.kind === 'maistep') {
    const { id: _, targets, ...wf } = found.wf;
    data = wf;
    title = `${wf.title || found.wf.id || 'воркфлоу'} (из ${found.name})`;
  } else {
    let lib = null;
    try { lib = (await api('/api/library')).items; } catch {}
    const r = comfyToMaistep(found, lib);
    if (!r.nodes.length) { log('warn', `${found.name}: в графе ComfyUI нет нод, которые maistep умеет перевести`); return null; }
    data = { nodes: r.nodes, links: r.links };
    title = `ComfyUI: ${found.name.replace(/\.(png|json)$/i, '')}`;
    for (const w of r.warns) log('warn', `импорт ComfyUI: ${w}`);
  }
  const base = (found.kind === 'maistep' ? found.wf.id : 'comfy') || 'imported';
  const id = uniqueId(`${String(base).replace(/[^\w-]/g, '_').slice(0, 40)}_img`, S.docs.workflow.keys());
  if (!addDoc('workflow', id, { ...data, title })) return null;
  emit('open-workflow', id);
  log('ok', `открыт граф из ${found.name}${found.kind === 'comfy' ? ' (ComfyUI)' : ''} — новый воркфлоу «${title}»`);
  return id;
}
