// Граф из картинки или файла: PNG maistep (iTXt «maistep» — граф запуска, вшивает сервер: registry Ctx.pnginfo),
// ComfyUI (PNG tEXt «prompt» — формат API, «workflow» — формат интерфейса; WebP/JPEG — EXIF «Prompt:…»/«Workflow:…»)
// и .json тех же форматов; параметры генерации других программ (PNG tEXt / EXIF UserComment / XMP): A1111, Forge,
// Civitai («parameters» текстом), NovelAI («Comment»), InvokeAI («invokeai_metadata»), SwarmUI и Fooocus (JSON).
// Ноды ComfyUI переводятся в ноды maistep по таблице COMFY (ядро SD: чекпоинт, LoRA, CLIP, латент, KSampler, VAE,
// ControlNet, картинки, апскейл моделью, FaceDetailer, Ultimate SD Upscale), параметры — в типовой граф (paramsGraph:
// hires, ADetailer). Чего в maistep нет (прочие ноды ComfyUI, ControlNet/Refiner A1111…), становится заглушкой
// core.missing: пины и значения сохраняются, проверка графа о ней сообщает.
// Результат — новый воркфлоу (importGraph).
import { S, emit, addDoc, uniqueId } from './store.js';
import { api, fileUrl } from './backend.js';

const log = (level, text) => emit('log', { src: 'editor', level, text });

// ---------- PNG: текстовые чанки ----------
async function inflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

const utf = new TextDecoder(), latin = new TextDecoder('latin1');

export async function pngText(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(buf), out = {};
  if (u8.length < 8 || u8[0] !== 0x89 || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) return out;
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

// ---------- JPEG / WebP: EXIF и XMP ----------
// EXIF (TIFF): ImageDescription/Make/Model — ComfyUI пишет туда «Prompt:{…}», «Workflow:{…}»; UserComment —
// параметры A1111/Forge/Civitai; XPComment — запасной путь некоторых программ.
const EXIF_TAGS = [0x010e, 0x010f, 0x0110, 0x9286, 0x9c9c];
function exifTexts(u8, out) {
  if (latin.decode(u8.subarray(0, 6)) === 'Exif\0\0') u8 = u8.subarray(6);
  if (u8.length < 8) return;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), le = u8[0] === 0x49;
  const g16 = o => dv.getUint16(o, le), g32 = o => dv.getUint32(o, le);
  const SIZE = { 3: 2, 4: 4, 9: 4 }, tags = {};
  const ifd = (off, depth) => {
    if (depth > 2 || off + 2 > u8.length) return;
    for (let i = 0, n = g16(off); i < n; i++) {
      const e = off + 2 + i * 12;
      if (e + 12 > u8.length) break;
      const tag = g16(e), bytes = g32(e + 4) * (SIZE[g16(e + 2)] || 1);
      if (tag === 0x8769) { ifd(g32(e + 8), depth + 1); continue; } // Exif IFD — там UserComment
      if (!EXIF_TAGS.includes(tag)) continue;
      const at = bytes <= 4 ? e + 8 : g32(e + 8);
      if (at + bytes <= u8.length) tags[tag] = u8.subarray(at, at + bytes);
    }
  };
  ifd(g32(4), 0);
  for (const tag of [0x010e, 0x010f, 0x0110]) {
    if (!tags[tag]) continue;
    const t = utf.decode(tags[tag]).replace(/\0+$/, ''), m = /^(\w+):\s*([[{][\s\S]*)$/.exec(t);
    if (m) out[m[1].toLowerCase()] ??= m[2];
    else if (tag === 0x010e && t.trim()) out.Description ??= t;
  }
  if (tags[0x9286]) out.parameters ??= userComment(tags[0x9286]);
  if (tags[0x9c9c]) out.parameters ??= new TextDecoder('utf-16le').decode(tags[0x9c9c]).replace(/\0+$/, '');
}
// UserComment: 8 байт кодировки («UNICODE\0» — UTF-16, порядок байт бывает любой; «ASCII\0\0\0»; нули — не указана)
function userComment(b) {
  const head = latin.decode(b.subarray(0, 8)), body = b.subarray(8);
  let t;
  if (head.startsWith('UNICODE')) {
    let even = 0, odd = 0;
    for (let i = 0; i + 1 < Math.min(body.length, 400); i += 2) { if (!body[i]) even++; if (!body[i + 1]) odd++; }
    t = new TextDecoder(even > odd ? 'utf-16be' : 'utf-16le').decode(body);
  } else t = utf.decode(head.startsWith('ASCII') || /^\0{8}$/.test(head) ? body : b);
  return t.replace(/\0+$/, '');
}
const unxml = t => t.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(x?)([0-9a-f]+);/gi, (_, x, n) => String.fromCodePoint(parseInt(n, x ? 16 : 10))).replace(/&amp;/g, '&');
function xmpTexts(x, out) { // Draw Things и др.: exif:UserComment внутри XMP
  const m = /<exif:UserComment>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(x) || /exif:UserComment="([^"]*)"/.exec(x);
  if (m) out.parameters ??= unxml(m[1]);
}

// текстовые метаданные картинки: PNG — чанки, JPEG — APP1 (EXIF, XMP) и COM, WebP — чанки EXIF и XMP
export async function imageTexts(buf) {
  const u8 = new Uint8Array(buf), out = {};
  if (u8[0] === 0x89 && u8[1] === 0x50) return pngText(buf);
  try {
    if (u8[0] === 0xff && u8[1] === 0xd8) {
      for (let o = 2; o + 4 <= u8.length && u8[o] === 0xff;) {
        const m = u8[o + 1], len = (u8[o + 2] << 8) | u8[o + 3], d = u8.subarray(o + 4, o + 2 + len);
        if (m === 0xda || m === 0xd9) break; // дальше — сами пиксели
        if (m === 0xe1 && latin.decode(d.subarray(0, 6)) === 'Exif\0\0') exifTexts(d, out);
        else if (m === 0xe1) xmpTexts(utf.decode(d), out);
        else if (m === 0xfe) out.comment ??= utf.decode(d);
        o += 2 + len;
      }
    } else if (latin.decode(u8.subarray(0, 4)) === 'RIFF' && latin.decode(u8.subarray(8, 12)) === 'WEBP') {
      const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
      for (let o = 12; o + 8 <= u8.length;) {
        const type = latin.decode(u8.subarray(o, o + 4)), len = dv.getUint32(o + 4, true), d = u8.subarray(o + 8, o + 8 + len);
        if (type === 'EXIF') exifTexts(d, out);
        else if (type === 'XMP ') xmpTexts(utf.decode(d), out);
        o += 8 + len + (len & 1);
      }
    }
  } catch { /* битые метаданные — что успели, то и есть */ }
  return out;
}

// ---------- что внутри: { kind: 'maistep' | 'comfy' | 'params', wf | prompt+ui | p, name } ----------
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const isMaistep = j => j && Array.isArray(j.nodes) && !isComfyUi(j) && j.nodes.every(n => typeof n?.type === 'string' && 'id' in n) && Array.isArray(j.links ?? []) && (j.links || []).every(l => l && 'from' in l && 'to' in l);
const isComfyUi = j => j && Array.isArray(j.nodes) && j.nodes.some(n => n && 'widgets_values' in n || n?.type && Array.isArray(n?.pos));
const isComfyApi = j => j && typeof j === 'object' && !Array.isArray(j) && Object.values(j).length && Object.values(j).every(n => n && typeof n.class_type === 'string');

function classify(texts, name) {
  const m = parse(texts.maistep || '');
  if (m?.workflow && isMaistep(m.workflow)) return { kind: 'maistep', wf: m.workflow, name };
  const prompt = parse(texts.prompt || ''), ui = parse(texts.workflow || '');
  if (isComfyApi(prompt) || isComfyUi(ui)) return { kind: 'comfy', prompt: isComfyApi(prompt) ? prompt : null, ui: isComfyUi(ui) ? ui : null, name };
  const pj = parse(texts.parameters || ''); // бывает, что граф ComfyUI лежит в UserComment
  if (isComfyApi(pj)) return { kind: 'comfy', prompt: pj, ui: null, name };
  if (isComfyUi(pj)) return { kind: 'comfy', prompt: null, ui: pj, name };
  const p = genParams(texts);
  return p ? { kind: 'params', p, name } : null;
}

// src: File | Blob | путь проекта (input/…, output/…) → граф или null
export async function graphFromImage(src) {
  try {
    const name = typeof src === 'string' ? src.split('/').pop() : src?.name || 'image';
    const buf = typeof src === 'string' ? await (await fetch(fileUrl(src))).arrayBuffer() : await src.arrayBuffer();
    return classify(await imageTexts(buf), name);
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

// ---------- параметры генерации других программ ----------
// p = { source, prompt, negative, model (строка или варианты имени), vae, loras [{name, alt, w, wc}], clipSkip, steps, cfg,
//       seed, sampler, scheduler, width, height, denoise (img2img), hires {width, height, scale, steps, denoise, upscaler},
//       missing [{node, values, note, chain}] — заглушки, warns [] }
function genParams(t) {
  const inv = parse(t.invokeai_metadata || '');
  if (inv && typeof inv === 'object') return fromJson(inv, 'InvokeAI');
  const nai = parse(t.Comment || '');
  if (nai && typeof nai === 'object' && (nai.prompt != null || nai.uc != null)) return fromJson(nai, 'NovelAI', t.Source);
  const raw = t.parameters ?? t.comment ?? t.Comment;
  const j = parse(raw || '');
  if (j && typeof j === 'object' && !Array.isArray(j)) {
    if (j.sui_image_params) return fromJson(j.sui_image_params, 'SwarmUI');
    return fromJson(j, /fooocus/i.test(String(j.version || j.Version || '')) ? 'Fooocus' : 'JSON');
  }
  return typeof raw === 'string' && raw.trim() ? fromA1111(raw) : null;
}

const num = v => (v == null || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));
const size = v => { const m = /(\d{2,5})\s*[x×,*]\s*(\d{2,5})/.exec(String(v ?? '')); return m ? [+m[1], +m[2]] : []; };

// <lora:имя:вес> / <lora:имя:te:unet> / <lyco:…> — вырезаются из промпта и становятся цепочкой Load LoRA
function takeLoras(text, p) {
  return String(text || '').replace(/<(lora|lyco|locon):([^:>]+)(?::([^:>]*))?(?::([^:>]*))?>/gi, (_, k, name, a, b) => {
    const te = num(String(a ?? '').replace(/^te=/, '')) ?? 1, unet = num(String(b ?? '').replace(/^unet=/, '')) ?? te;
    if (!p.loras.some(l => l.name === name.trim())) p.loras.push({ name: name.trim(), w: unet, wc: te });
    return '';
  }).replace(/<hypernet:([^:>]+)[^>]*>/gi, (_, n) => { p.warns.push(`hypernetwork «${n}» не поддерживается — убран из промпта`); return ''; })
    .replace(/[ \t]*,[ \t]*,/g, ',').replace(/^[\s,]+|[\s,]+$/g, '');
}

// «Ключ: значение, Ключ: "в кавычках", Ключ: [JSON]» — строка параметров A1111 (значения с запятыми — в кавычках/скобках)
function a1111Fields(line) {
  const out = {}, key = /\s*(\w[\w \-/+.()]*?):\s*/y;
  for (let i = 0; i < line.length;) {
    key.lastIndex = i;
    const r = key.exec(line);
    if (!r) break;
    let j = key.lastIndex, v;
    if (line[j] === '"') {
      let k = j + 1;
      while (k < line.length && line[k] !== '"') k += line[k] === '\\' ? 2 : 1;
      v = parse(line.slice(j, k + 1)) ?? line.slice(j + 1, k);
      j = k + 1;
    } else if (line[j] === '[' || line[j] === '{') {
      let k = j, depth = 0, str = false;
      for (; k < line.length; k++) {
        const c = line[k];
        if (str) { if (c === '\\') k++; else if (c === '"') str = false; continue; }
        if (c === '"') str = true;
        else if (c === '[' || c === '{') depth++;
        else if ((c === ']' || c === '}') && !--depth) { k++; break; }
      }
      v = line.slice(j, k);
      j = k;
    } else {
      const k = line.indexOf(',', j);
      v = line.slice(j, k < 0 ? line.length : k).trim();
      j = k < 0 ? line.length : k;
    }
    out[r[1].trim()] = v;
    const c = line.indexOf(',', j);
    i = c < 0 ? line.length : c + 1;
  }
  return out;
}

// параметры A1111 / Forge / Civitai: промпт, «Negative prompt: …», последняя строка «Steps: …, Sampler: …»
const A1111_KNOWN = new Set(['Steps', 'Sampler', 'Schedule type', 'CFG scale', 'Seed', 'Size', 'Model', 'Model hash', 'VAE', 'VAE hash',
  'Denoising strength', 'Clip skip', 'Hires upscale', 'Hires resize', 'Hires steps', 'Hires upscaler', 'Hires sampler', 'Hires schedule type',
  'Hires CFG Scale', 'Hires prompt', 'Hires negative prompt', 'Hires Module 1', 'Lora hashes', 'TI hashes', 'TI', 'Hashes', 'Version',
  'Civitai resources', 'Civitai metadata', 'Created Date', 'RNG', 'ENSD', 'Eta', 'Eta DDIM', 'Emphasis', 'Schedule max sigma',
  'Schedule min sigma', 'Schedule rho', 'Pad conds', 'Downcast alphas_cumprod', 'Module 1', 'Module 2', 'Module 3', 'Diffusion in Low Bits',
  'Batch size', 'Batch pos', 'Mask blur', 'Token merging ratio', 'Beta schedule alpha', 'Beta schedule beta', 'Template', 'Negative Template',
  'Style Selector Enabled', 'Style Selector Randomize', 'Style Selector Style', 'Refiner', 'Refiner switch at', 'Refiner switch by sampling steps']);
function fromA1111(text) {
  const lines = text.replace(/\r/g, '').trim().split('\n');
  let pi = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (/(^|,\s*)Steps:\s*\d/.test(lines[i])) { pi = i; break; }
  const f = pi >= 0 ? a1111Fields(lines[pi]) : {};
  const pos = [], neg = [];
  let inNeg = false;
  for (const l of pi >= 0 ? lines.slice(0, pi) : lines) {
    if (!inNeg && /^Negative prompt:/i.test(l)) { inNeg = true; neg.push(l.slice(16).trim()); } else (inNeg ? neg : pos).push(l);
  }
  if (pi < 0 && !inNeg) return null; // просто подпись, не параметры
  const res = parse(f['Civitai resources'] || '');
  const p = { source: f['Civitai resources'] || f['Civitai metadata'] ? 'Civitai' : /^f\d/.test(f.Version || '') ? 'Forge' : 'A1111',
    loras: [], warns: [], missing: [] };
  p.prompt = takeLoras(pos.join('\n'), p);
  p.negative = takeLoras(neg.join('\n'), p);
  p.steps = num(f.Steps); p.cfg = num(f['CFG scale']); p.seed = num(f.Seed);
  [p.width, p.height] = size(f.Size);
  p.sampler = f.Sampler; p.scheduler = f['Schedule type'];
  p.model = f.Model; p.vae = f.VAE; p.clipSkip = num(f['Clip skip']);
  if (Array.isArray(res)) { // ресурсы генератора Civitai: имена моделей на сайте вместо файлов
    const nm = r => [r.modelName && r.modelVersionName && `${r.modelName} ${r.modelVersionName}`, r.modelName].filter(Boolean);
    const ck = res.find(r => /checkpoint/i.test(r.type || ''));
    if (ck) p.model = [p.model, ...nm(ck)].filter(Boolean);
    if (!p.loras.length) {
      for (const r of res.filter(r => /lora|lycoris|locon|dora/i.test(r.type || ''))) p.loras.push({ name: nm(r)[0] || `version ${r.modelVersionId}`, alt: nm(r), w: num(r.weight) ?? 1 });
    }
  }
  const den = num(f['Denoising strength']);
  if (f['Hires upscale'] || f['Hires resize'] || f['Hires upscaler']) {
    const [hw, hh] = size(f['Hires resize']);
    p.hires = { width: hw, height: hh, scale: num(f['Hires upscale']) ?? 2, steps: num(f['Hires steps']) || undefined, denoise: den ?? 0.5,
      upscaler: f['Hires upscaler'] || 'Latent' };
    if (f['Hires prompt']) p.warns.push('отдельный промпт hires-прохода не перенесён — используется основной');
  } else if (den != null && den < 1) p.denoise = den;
  // ADetailer → Face Detailer (по блоку на модель: «ADetailer model», «ADetailer model 2nd»…); чего нет — заглушки
  const units = {};
  for (const [k, v] of Object.entries(f)) {
    const m = /^ADetailer (.+?)( \d+(?:st|nd|rd|th))?$/.exec(k);
    if (m) (units[`ADetailer${m[2] || ''}`] ||= {})[m[1]] = v;
  }
  p.detailers = Object.values(units).filter(u => u.model && !/^none$/i.test(u.model)).map(u => ({
    model: u.model, prompt: u.prompt, negative: u['negative prompt'], confidence: num(u.confidence), dilation: num(u['dilate erode']),
    feather: num(u['mask blur']), denoise: num(u['denoising strength']), padding: num(u['inpaint padding']),
    steps: /true/i.test(u['use separate steps'] || '') ? num(u.steps) : undefined,
    cfg: /true/i.test(u['use separate CFG scale'] || '') ? num(u['CFG scale']) : undefined }));
  for (const [k, v] of Object.entries(f)) {
    if (/^ControlNet( \d+)?$/.test(k)) p.missing.push({ node: `A1111 ${k}`, values: { [k]: v }, note: 'в maistep — Load ControlNet Model + Apply ControlNet; картинку-подсказку выберите сами' });
  }
  if (f.Refiner) p.missing.push({ node: 'Refiner', values: { Refiner: f.Refiner, 'switch at': f['Refiner switch at'] }, note: 'A1111 Refiner: смена модели в середине сэмплинга' });
  const rest = Object.keys(f).filter(k => !A1111_KNOWN.has(k) && !/^(ADetailer|ControlNet)/.test(k));
  if (rest.length) p.warns.push(`не перенесено (нет в maistep): ${rest.join(', ')}`);
  return p;
}

// NovelAI: {x} — сильнее в 1.05 раза, [x] — слабее; переводим в веса A1111 (x:1.10)
function naiWeights(t) {
  let out = '', buf = '', w = 0;
  const flush = () => { if (buf) out += w && buf.trim() ? `(${buf}:${(1.05 ** w).toFixed(2)})` : buf; buf = ''; };
  for (const c of String(t)) {
    const d = { '{': 1, '}': -1, '[': -1, ']': 1 }[c];
    if (d) { flush(); w += d; } else buf += c;
  }
  flush();
  return out;
}

// JSON-метаданные: InvokeAI, NovelAI, SwarmUI, Fooocus и прочие — ключи без учёта регистра, пробелов и подчёркиваний
function fromJson(j, source, model) {
  const L = {};
  for (const [k, v] of Object.entries(j)) L[k.toLowerCase().replace(/[\s_-]/g, '')] = v;
  const pick = (...ks) => ks.map(k => L[k]).find(v => v != null && v !== '');
  const name = v => (typeof v === 'string' ? v : v && (v.name || v.model_name || v.title || v.key));
  const p = { source, loras: [], warns: [], missing: [] };
  let prompt = pick('prompt', 'positiveprompt', 'caption'), negative = pick('negativeprompt', 'uc', 'negative', 'negprompt');
  if (typeof prompt === 'object') prompt = prompt?.caption?.base_caption ?? JSON.stringify(prompt);
  if (typeof negative === 'object') negative = negative?.caption?.base_caption ?? '';
  if (prompt == null && pick('steps') == null) return null;
  if (source === 'NovelAI') { prompt = naiWeights(prompt ?? ''); negative = naiWeights(negative ?? ''); }
  p.prompt = takeLoras(prompt ?? '', p);
  p.negative = takeLoras(negative ?? '', p);
  p.steps = num(pick('steps')); p.cfg = num(pick('cfgscale', 'cfg', 'scale', 'guidancescale')); p.seed = num(pick('seed', 'noiseseed'));
  p.width = num(pick('width')); p.height = num(pick('height'));
  if (!p.width) [p.width, p.height] = size(pick('resolution', 'size', 'aspectratio'));
  if (source === 'InvokeAI') p.sampler = pick('scheduler'); // у InvokeAI «scheduler» — это сэмплер (dpmpp_2m_k)
  else { p.sampler = pick('sampler', 'samplername'); p.scheduler = pick('scheduler', 'noiseschedule', 'scheduletype'); }
  p.model = name(pick('model', 'basemodel', 'modelname', 'ckpt', 'checkpoint'));
  p.vae = name(pick('vae'));
  const cs = num(pick('clipskip', 'clipstopatlayer'));
  p.clipSkip = cs && Math.abs(cs);
  const den = num(pick('denoisingstrength', 'denoise', 'initimagecreativity', ...(source === 'InvokeAI' ? ['strength'] : [])));
  if (den != null && den < 1) p.denoise = den;
  const ls = pick('loras');
  if (Array.isArray(ls)) ls.forEach((it, i) => {
    if (typeof it === 'string') p.loras.push({ name: it, w: num(L.loraweights?.[i]) ?? 1 });
    else if (Array.isArray(it)) { if (it[0] && it[0] !== 'None') p.loras.push({ name: String(it[0]), w: num(it[1]) ?? 1 }); }
    else if (it) p.loras.push({ name: name(it.model ?? it.lora ?? it), w: num(it.weight ?? it.strength) ?? 1 });
  });
  if (source === 'NovelAI') {
    p.warns.push(`модель NovelAI${model ? ` (${model})` : ''} — облачная, в maistep её нет: взят чекпоинт по умолчанию`);
    p.model = undefined;
  }
  return p;
}

// встроенные апскейлеры A1111 → файлы моделей
const UPSCALER_ALIAS = { 'R-ESRGAN 4x+': 'RealESRGAN_x4plus', 'R-ESRGAN 4x+ Anime6B': 'RealESRGAN_x4plus_anime_6B', 'R-ESRGAN General 4xV3': 'realesr-general-x4v3',
  'R-ESRGAN General WDN 4xV3': 'realesr-general-wdn-x4v3', 'R-ESRGAN AnimeVideo': 'realesr-animevideov3', 'R-ESRGAN 2x+': 'RealESRGAN_x2plus',
  ESRGAN_4x: 'ESRGAN_4x', SwinIR_4x: 'SwinIR_4x', ScuNET: 'ScuNET', 'ScuNET PSNR': 'ScuNET' };

// сэмплеры и планировщики A1111 («DPM++ 2M Karras»), InvokeAI (dpmpp_2m_k), NovelAI (k_euler_ancestral), ComfyUI
const SAMPLER_KEYS = { euler: 'euler', eulera: 'euler_ancestral', eulerancestral: 'euler_ancestral', heun: 'heun', lms: 'lms', dpm2: 'dpm_2',
  dpm2a: 'dpm_2_ancestral', dpm2ancestral: 'dpm_2_ancestral', kdpm2: 'dpm_2', kdpm2a: 'dpm_2_ancestral', dpmpp2m: 'dpmpp_2m',
  dpmpp2msde: 'dpmpp_2m_sde', dpmpp3msde: 'dpmpp_3m_sde', dpmppsde: 'dpmpp_sde', ddim: 'ddim', ddpm: 'ddpm', unipc: 'uni_pc', lcm: 'lcm' };
const SCHED_KEYS = { automatic: 'normal', uniform: 'normal', native: 'normal', normal: 'normal', karras: 'karras', exponential: 'exponential',
  polyexponential: 'exponential', sgm_uniform: 'sgm_uniform', simple: 'simple', beta: 'beta', ddim_uniform: 'ddim_uniform' };
function samplerOf(raw, sched, warn) {
  const opts = S.nodes['sd.ksampler']?.inputs, so = opts?.sampler_name?.options, sco = opts?.scheduler?.options;
  let s = String(raw ?? '').trim(), sc = sched ? String(sched).trim() : '';
  const tail = /\s+(Karras|Exponential|SGM Uniform|Simple|Beta)$/i.exec(s);
  if (tail) { sc ||= tail[1]; s = s.slice(0, tail.index); }
  if (/_k$/.test(s)) { sc ||= 'karras'; s = s.slice(0, -2); }
  let sampler, scheduler;
  if (s) {
    const key = s.toLowerCase().replace(/^k_/, '').replace(/\+\+/g, 'pp').replace(/[\s_-]/g, '').replace(/(cfgpp|gpu)$/, '');
    sampler = SAMPLER_KEYS[key];
    if (!sampler || (so && !so.includes(sampler))) {
      sampler = /a$|ancestral/.test(key) ? 'euler_ancestral' : 'euler';
      warn(`сэмплер «${raw}» в maistep нет → ${sampler}`);
    }
  }
  if (sc) {
    const key = sc.toLowerCase().replace(/[\s-]+/g, '_');
    scheduler = SCHED_KEYS[key];
    if (!scheduler || (sco && !sco.includes(scheduler))) { scheduler = 'normal'; warn(`планировщик «${sc}» в maistep нет → normal`); }
    else if (key === 'polyexponential') warn('планировщик polyexponential → exponential');
  }
  return { sampler, scheduler };
}

// параметры → типовой граф maistep: чекпоинт → LoRA… → clip skip → промпты → латент (пустой / img2img) → KSampler
// (→ hires: Upscale Latent → KSampler) → VAE Decode → заглушки-цепочки → Save Image; прочие заглушки — отдельно
function paramsGraph(p, lib) {
  const warns = new Set(p.warns), warn = t => warns.add(t);
  const nodes = [], links = [];
  const add = (type, props = {}, extra = {}) => {
    const n = { id: `n${nodes.length + 1}`, type, x: 0, y: 0, props: Object.fromEntries(Object.entries(props).filter(([, v]) => v !== undefined)), ...extra };
    nodes.push(n);
    return n.id;
  };
  const link = ([from, out], to, inp) => links.push({ from, out, to, in: inp });
  const model0 = [p.model].flat().filter(Boolean);
  const ckName = model0.length ? findModel('checkpoints', model0, lib) : null;
  if (model0.length && !ckName && lib) warn(`нет в библиотеке (checkpoints): ${model0[0]} — выберите чекпоинт или скачайте его (Civitai)`);
  if (!model0.length && p.source !== 'NovelAI') warn('модель не указана — взят чекпоинт по умолчанию');
  const ck = add('sd.checkpoint', model0.length ? { ckpt_name: ckName || model0[0] } : {});
  let model = [ck, 'model'], clip = [ck, 'clip'], vae = [ck, 'vae'];
  for (const l of p.loras) {
    const hit = findModel('loras', [l.name, ...(l.alt || [])], lib);
    if (!hit && lib) warn(`нет в библиотеке (loras): ${l.name}`);
    const id = add('sd.lora', { lora_name: hit || l.name, strength_model: l.w ?? 1, strength_clip: l.wc ?? l.w ?? 1 });
    link(model, id, 'model'); link(clip, id, 'clip');
    model = [id, 'model']; clip = [id, 'clip'];
  }
  if (p.clipSkip > 1) {
    const id = add('sd.clip_skip', { stop_at_clip_layer: -p.clipSkip });
    link(clip, id, 'clip');
    clip = [id, 'clip'];
  }
  if (p.vae && !/^(auto(matic)?|none|baked)$/i.test(p.vae)) {
    const hit = findModel('vae', p.vae, lib);
    if (hit) { const id = add('sd.vae', { vae_name: hit }); vae = [id, 'vae']; } else warn(`VAE «${p.vae}» нет в библиотеке — используется VAE чекпоинта`);
  }
  const pos = add('sd.text_encode', { text: p.prompt || '' }), neg = add('sd.text_encode', { text: p.negative || '' });
  link(clip, pos, 'clip'); link(clip, neg, 'clip');
  const { sampler, scheduler } = samplerOf(p.sampler, p.scheduler, warn);
  const ks = (latent, props) => {
    const id = add('sd.ksampler', { seed: p.seed, steps: p.steps, cfg: p.cfg, sampler_name: sampler, scheduler, ...props });
    link(model, id, 'model'); link([pos, 'conditioning'], id, 'positive'); link([neg, 'conditioning'], id, 'negative'); link(latent, id, 'latent_image');
    return [id, 'latent'];
  };
  let lat;
  if (p.denoise != null) { // img2img: исходной картинки в метаданных нет
    const load = add('image.load', {}), enc = add('sd.vae_encode');
    link([load, 'image'], enc, 'pixels'); link(vae, enc, 'vae');
    lat = ks([enc, 'latent'], { denoise: p.denoise });
    warn('img2img: исходной картинки в метаданных нет — выберите её в Load Image');
  } else {
    lat = ks([add('sd.empty_latent', { width: p.width, height: p.height, batch_size: 1 }), 'latent'], { denoise: 1 });
  }
  const decode = latent => { const id = add('sd.vae_decode'); link(latent, id, 'samples'); link(vae, id, 'vae'); return [id, 'image']; };
  if (p.hires) {
    // латентный апскейлер — Upscale Latent; модель (ESRGAN, 4x-UltraSharp…) или Lanczos — как в A1111: декод → апскейл
    // картинки → VAE Encode → второй KSampler
    const h = p.hires, r8 = v => Math.max(64, Math.round(v / 8) * 8);
    const tw = h.width || (p.width && r8(p.width * h.scale)), th = h.height || (p.height && r8(p.height * h.scale));
    const m = /^Latent(?:\s*\(([^)]+)\))?/i.exec(h.upscaler || '');
    if (m) {
      const method = { 'nearest-exact': 'nearest-exact', nearest: 'nearest-exact', bilinear: 'bilinear', antialiased: 'bilinear', bicubic: 'bicubic', area: 'area' }[(m[1] || 'bilinear').toLowerCase()] || 'bilinear';
      const up = add('sd.latent_upscale', { upscale_method: method, width: tw, height: th });
      link(lat, up, 'samples');
      lat = ks([up, 'latent'], { steps: h.steps || p.steps, denoise: h.denoise });
    } else {
      let img = decode(lat);
      const plain = /^(lanczos|nearest|none)$/i.exec(h.upscaler || '');
      if (!plain) {
        const names = [h.upscaler, UPSCALER_ALIAS[h.upscaler]].filter(Boolean);
        const hit = findModel('upscale_models', names, lib);
        if (!hit && lib) warn(`апскейлер «${h.upscaler}» нет в библиотеке — скачайте (Компоненты → Модели: 4x-UltraSharp, RealESRGAN anime) или с Civitai и выберите в Load Upscale Model`);
        const um = add('sd.upscale_model_load', { model_name: hit || `${names.at(-1)}.pth` }), up = add('image.upscale_model');
        link([um, 'upscale_model'], up, 'upscale_model'); link(img, up, 'image');
        img = [up, 'image'];
      }
      const sc = add('image.scale', { upscale_method: /nearest/i.test(h.upscaler) ? 'nearest-exact' : 'lanczos', width: tw, height: th, crop: 'disabled' });
      link(img, sc, 'image');
      const enc = add('sd.vae_encode');
      link([sc, 'image'], enc, 'pixels'); link(vae, enc, 'vae');
      lat = ks([enc, 'latent'], { steps: h.steps || p.steps, denoise: h.denoise });
    }
  }
  let img = decode(lat);
  for (const d of p.detailers || []) { // ADetailer → Load Detector + Face Detailer (свой промпт — свой CLIP Text Encode)
    const kind = (/^(face|hand|person|mediapipe_face)/i.exec(stem(d.model)) || [])[0] || 'face';
    const hit = findModel('ultralytics', [d.model, ...['m', 'n', 's'].map(v => `${kind}_yolov8${v}`), `${kind}_yolov8m-seg`, `${kind}_yolov8n-seg`], lib);
    if (!hit && lib) warn(`детектор «${d.model}» нет в библиотеке — скачайте (Компоненты → Модели: «Детектор лиц (ADetailer)»)`);
    else if (hit && stem(hit) !== stem(d.model)) warn(`детектор ${d.model} → ${hit} (такой же, другого размера)`);
    const det = add('sd.detector_load', { model_name: hit || `bbox/${d.model}` });
    const enc = (text, base) => {
      if (!text) return base;
      const id = add('sd.text_encode', { text: text.replace(/\[PROMPT\]/g, p.prompt || '') });
      link(clip, id, 'clip');
      return id;
    };
    const fd = add('sd.detailer', { seed: p.seed, steps: d.steps ?? p.steps, cfg: d.cfg ?? p.cfg, sampler_name: sampler, scheduler, denoise: d.denoise ?? 0.4,
      confidence: d.confidence, dilation: d.dilation, feather: d.feather, padding: d.padding });
    link(img, fd, 'image'); link(model, fd, 'model'); link(vae, fd, 'vae'); link([det, 'bbox_detector'], fd, 'bbox_detector');
    link([enc(d.prompt, pos), 'conditioning'], fd, 'positive'); link([enc(d.negative, neg), 'conditioning'], fd, 'negative');
    img = [fd, 'image'];
  }
  for (const m of p.missing) {
    const pins = m.chain ? [{ name: 'image', type: 'IMAGE' }] : [];
    const id = add(MISSING, { missing: { node: m.node, source: p.source, inputs: pins, outputs: pins, values: m.values, note: m.note } },
      { title: `⚠ ${m.node}`, ...(m.chain ? { mode: 'mute' } : {}) });
    if (m.chain) { link(img, id, 'image'); img = [id, 'image']; }
    warn(`«${m.node}» в maistep нет — поставлена заглушка${m.chain ? ' (выключена: картинка проходит насквозь)' : ''}`);
  }
  link(img, add('image.save', { prefix: String(p.source).toLowerCase() }), 'image');
  layout(nodes, links);
  return { nodes, links, warns: [...warns] };
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
// доработка картинки (refine.py): апскейл моделью, детектор Impact Pack, FaceDetailer, Ultimate SD Upscale
const SAMPLER_IN = { seed: 'seed', steps: 'steps', cfg: 'cfg', sampler_name: 'sampler_name', scheduler: 'scheduler', denoise: 'denoise' };
Object.assign(COMFY, {
  UpscaleModelLoader: { type: 'sd.upscale_model_load', in: { model_name: 'model_name' }, out: ['upscale_model'], w: ['model_name'], cats: { model_name: 'upscale_models' } },
  ImageUpscaleWithModel: { type: 'image.upscale_model', in: { upscale_model: 'upscale_model', image: 'image' }, out: ['image'] },
  ImageScaleBy: { type: 'image.scale_by', in: { image: 'image', upscale_method: 'upscale_method', scale_by: 'scale_by' }, out: ['image'], w: ['upscale_method', 'scale_by'] },
  ImageScale: { type: 'image.scale', in: { image: 'image', upscale_method: 'upscale_method', width: 'width', height: 'height', crop: 'crop' }, out: ['image'],
    w: ['upscale_method', 'width', 'height', 'crop'] },
  UltralyticsDetectorProvider: { type: 'sd.detector_load', in: { model_name: 'model_name' }, out: ['bbox_detector'], w: ['model_name'], cats: { model_name: 'ultralytics' } },
  FaceDetailer: { type: 'sd.detailer', in: { image: 'image', model: 'model', vae: 'vae', positive: 'positive', negative: 'negative', bbox_detector: 'bbox_detector',
    ...SAMPLER_IN, feather: 'feather', bbox_threshold: 'confidence', bbox_dilation: 'dilation' }, out: ['image', null, null, 'mask'],
    w: [null, null, null, 'seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise', 'feather', null, null, 'confidence', 'dilation'] },
  UltimateSDUpscale: { type: 'sd.ultimate_upscale', in: { image: 'image', model: 'model', positive: 'positive', negative: 'negative', vae: 'vae',
    upscale_model: 'upscale_model', upscale_by: 'upscale_by', ...SAMPLER_IN, tile_width: 'tile_width', tile_height: 'tile_height', mask_blur: 'mask_blur',
    tile_padding: 'tile_padding' }, out: ['image'],
    w: ['upscale_by', 'seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise', null, 'tile_width', 'tile_height', 'mask_blur', 'tile_padding'] },
  UltimateSDUpscaleNoUpscale: { type: 'sd.ultimate_upscale', in: { upscaled_image: 'image', model: 'model', positive: 'positive', negative: 'negative', vae: 'vae',
    ...SAMPLER_IN, tile_width: 'tile_width', tile_height: 'tile_height', mask_blur: 'mask_blur', tile_padding: 'tile_padding' }, out: ['image'],
    w: ['seed', null, 'steps', 'cfg', 'sampler_name', 'scheduler', 'denoise', null, 'tile_width', 'tile_height', 'mask_blur', 'tile_padding'], fixed: { upscale_by: 1 } },
});
COMFY['LoraLoader|pysssss'] = COMFY.LoraLoader;
const MODEL_CAT = { ckpt_name: 'checkpoints', lora_name: 'loras', vae_name: 'vae', control_net_name: 'controlnet' };
const MISSING = 'core.missing';
// ноды ComfyUI без смысла в maistep — не переносятся вовсе
const COMFY_SKIP = ['Reroute', 'PrimitiveNode', 'Note', 'MarkdownNote'];

// значения ComfyUI, которых нет в maistep
function fixValue(type, key, v, warn) {
  const opts = S.nodes['sd.ksampler']?.inputs?.[key]?.options; // варианты из каталога нод сервера
  if (key === 'sampler_name' && typeof v === 'string' && opts && !opts.includes(v)) {
    const base = v.replace(/_gpu$|_cfg_pp$/, ''), pick = opts.includes(base) ? base : 'euler';
    warn(`сэмплер ${v} → ${pick}`);
    return pick;
  }
  if (key === 'scheduler' && typeof v === 'string' && opts && !opts.includes(v)) { warn(`планировщик ${v} → normal`); return 'normal'; }
  if (key === 'file' && typeof v === 'string' && !/^(input|output|temp)\//.test(v)) return `input/${v}`;
  if (key === 'stop_at_clip_layer' && typeof v === 'number' && v > 0) return -v;
  return v;
}

// имя модели → имя из библиотеки maistep: точно, по имени файла без расширения и знаков («waiIllustriousSDXL_v160»
// = «WAI-illustrious-SDXL v16.0»), по началу имени; names — варианты по порядку. Нет — null
const stem = v => String(v || '').split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|pth|bin|sft|gguf)$/i, '').toLowerCase().replace(/[^a-z0-9]/g, '');
function findModel(cat, names, lib) {
  const items = (lib || []).filter(it => it.cat === cat);
  for (const nm of [names].flat().filter(Boolean)) {
    if (items.some(it => it.name === nm)) return nm;
    const s = stem(nm);
    if (!s) continue;
    const hit = items.find(it => stem(it.name) === s)
      || (s.length >= 6 && items.filter(it => { const t = stem(it.name); return t.length >= 6 && (t.startsWith(s) || s.startsWith(t)); }).sort((a, b) => a.name.length - b.name.length)[0]);
    if (hit) return hit.name;
  }
  return null;
}
function matchModel(cat, name, lib, warn) {
  if (!lib || !name) return name;
  const hit = findModel(cat, name, lib);
  if (!hit) warn(`нет в библиотеке (${cat}): ${name}`);
  return hit || name;
}

// нода ComfyUI, которой нет в таблице, → заглушка: пины из формата интерфейса (имена и типы) или из связей формата API
function missingDef(s, prompt, ui) {
  const uniq = list => { const seen = new Set(); return list.map((x, i) => { let n = x.name || `out${i}`; while (seen.has(n)) n += '_'; seen.add(n); return { ...x, name: n }; }); };
  let inputs, outputs, values;
  if (s.ui) {
    inputs = uniq((s.ui.inputs || []).filter(i => i.link != null || !i.widget).map(i => ({ name: i.name, type: i.type || '*' })));
    outputs = uniq((s.ui.outputs || []).map((o, i) => ({ name: o.name || `out${i}`, type: o.type || '*' })));
  }
  if (prompt && s.inputs) {
    inputs ||= Object.entries(s.inputs).filter(([, v]) => Array.isArray(v)).map(([k]) => ({ name: k, type: '*' }));
    values = Object.fromEntries(Object.entries(s.inputs).filter(([, v]) => !Array.isArray(v)));
    if (!outputs) {
      let max = -1;
      for (const n of Object.values(prompt)) for (const v of Object.values(n.inputs || {})) if (Array.isArray(v) && String(v[0]) === s.id) max = Math.max(max, v[1]);
      outputs = Array.from({ length: max + 1 }, (_, i) => ({ name: `out${i}`, type: '*' }));
    }
  } else if (s.ui?.widgets_values != null) values = { widgets_values: s.ui.widgets_values };
  const sub = ui?.definitions?.subgraphs?.find(g => g.id === s.cls);
  const title = s.ui?.title || sub?.name || s.cls;
  return { type: MISSING, title, in: Object.fromEntries(inputs.map(i => [i.name, i.name])), out: outputs.map(o => o.name),
    missing: { node: title, source: 'ComfyUI', class_type: s.cls, inputs, outputs, values } };
}

function comfyToMaistep({ prompt, ui }, lib) {
  const warns = new Set(), warn = t => warns.add(t);
  const nodes = [], links = [], idOf = new Map(), defOf = new Map(), skipped = new Map(), zero = [];
  const uiNodes = new Map((ui?.nodes || []).map(n => [String(n.id), n]));
  // узлы: из формата API (значения и связи по именам), позиции/выключенность — из формата интерфейса
  const src = prompt ? Object.entries(prompt).map(([id, n]) => ({ id, cls: n.class_type, inputs: n.inputs || {}, ui: uiNodes.get(id) }))
    : (ui?.nodes || []).map(n => ({ id: String(n.id), cls: n.type, ui: n }));
  // ноды-константы формата API (PrimitiveInt, Seed (rgthree)…: одно значение, без входов-связей) — подставляются значением
  const consts = new Map();
  if (prompt) for (const s of src) {
    if (COMFY[s.cls]) continue;
    const vals = Object.values(s.inputs);
    if (vals.length === 1 && !Array.isArray(vals[0]) && typeof vals[0] !== 'object') consts.set(s.id, vals[0]);
  }
  let k = 0;
  for (const s of src) {
    if (COMFY_SKIP.includes(s.cls) || consts.has(s.id)) continue;
    let def = COMFY[s.cls];
    if (!def) { def = missingDef(s, prompt, ui); skipped.set(s.cls, (skipped.get(s.cls) || 0) + 1); }
    const id = `n${++k}`, props = {};
    idOf.set(s.id, id); defOf.set(s.id, def);
    if (prompt && !def.missing) for (const [ck, v] of Object.entries(s.inputs)) {
      if (!def.in[ck]) continue;
      if (!Array.isArray(v)) props[def.in[ck]] = v;
      else if (consts.has(String(v[0]))) props[def.in[ck]] = consts.get(String(v[0])); // значение из ноды-константы
    }
    // формат интерфейса — по порядку виджетов; при формате API — то, что пришло связью от непереводимой ноды
    // (ResolutionSelector → width/height и т.п.): в виджетах ComfyUI хранит и такие значения
    (def.w || []).forEach((key, i) => { if (key && props[key] === undefined && s.ui?.widgets_values?.[i] !== undefined) props[key] = s.ui.widgets_values[i]; });
    if (def.zero) { props.text = ''; warn('ConditioningZeroOut → пустой CLIP Text Encode (почти то же)'); }
    if (def.fixed) Object.assign(props, def.fixed);
    for (const key of Object.keys(props)) {
      props[key] = fixValue(def.type, key, props[key], warn);
      const cat = def.cats?.[key] || MODEL_CAT[key];
      if (cat) props[key] = matchModel(cat, props[key], lib, warn);
    }
    const pos = Array.isArray(s.ui?.pos) ? s.ui.pos : s.ui?.pos && typeof s.ui.pos === 'object' ? [s.ui.pos[0], s.ui.pos[1]] : [];
    const n = { id, type: def.type, x: Number(pos[0]) || 0, y: Number(pos[1]) || 0, props: def.missing ? { missing: def.missing } : props };
    if (def.missing) n.title = `⚠ ${def.title}`;
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
        if (consts.has(String(from)) && !def.missing) continue;
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
  settleMissing(nodes, links);
  layout(nodes, links);
  for (const [cls, n] of skipped) warn(`нода ComfyUI «${cls}»${n > 1 ? ` ×${n}` : ''} не поддерживается — поставлена заглушка (⚠)`);
  return { nodes, links: links.filter(l => l.from && l.to), warns: [...warns] };
}

// заглушки после связей: тип «*» уточняется по ноде на другом конце связи; связь заглушки в виджет известной ноды,
// у которой значение уже есть (ComfyUI хранит его и в виджетах), снимается — граф остаётся исполнимым; заглушка-
// источник значения, оставшаяся без связей, убирается
function settleMissing(nodes, links) {
  const byId = new Map(nodes.map(n => [n.id, n]));
  const pinOf = (n, side, name) => n.props?.missing?.[side]?.find(p => p.name === name);
  for (let i = links.length - 1; i >= 0; i--) {
    const l = links[i], a = byId.get(l.from), b = byId.get(l.to);
    if (!a || !b) continue;
    if (a.type === MISSING && b.type !== MISSING) {
      const inp = S.nodes[b.type]?.inputs?.[l.in];
      if (inp?.widget && b.props?.[l.in] !== undefined) { links.splice(i, 1); continue; }
      const o = pinOf(a, 'outputs', l.out);
      if (o && o.type === '*' && inp?.type) o.type = inp.type;
    } else if (b.type === MISSING && a.type !== MISSING) {
      const ip = pinOf(b, 'inputs', l.in), t = S.nodes[a.type]?.outputs?.find(o => o.name === l.out)?.type;
      if (ip && ip.type === '*' && t) ip.type = t;
    }
  }
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.type === MISSING && !n.props.missing.inputs.length && !links.some(l => l.from === n.id || l.to === n.id)) nodes.splice(i, 1);
  }
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

// граф находки в нодах maistep: { data: {nodes, links, …}, title, warns } или null (ComfyUI без переводимых нод)
export async function graphData(found) {
  if (found.kind === 'maistep') {
    const { id: _, targets, ...wf } = found.wf;
    return { data: wf, title: `${wf.title || found.wf.id || 'воркфлоу'} (из ${found.name})`, warns: [] };
  }
  let lib = null;
  try { lib = (await api('/api/library')).items; } catch {}
  const source = found.kind === 'params' ? found.p.source : 'ComfyUI';
  const r = found.kind === 'params' ? paramsGraph(found.p, lib) : comfyToMaistep(found, lib);
  if (!r.nodes.length) return null;
  return { data: { nodes: r.nodes, links: r.links }, title: `${source}: ${found.name.replace(/\.(png|jpe?g|webp|json)$/i, '')}`, warns: r.warns, source };
}

// ---------- новый воркфлоу ----------
export async function importGraph(found) {
  const g = await graphData(found);
  if (!g) { log('warn', `${found.name}: в графе ComfyUI нет нод, которые maistep умеет перевести`); return null; }
  const { data, title } = g;
  for (const w of g.warns) log('warn', `импорт ${g.source}: ${w}`);
  const base = (found.kind === 'maistep' ? found.wf.id : found.kind === 'params' ? found.p.source.toLowerCase() : 'comfy') || 'imported';
  const id = uniqueId(`${String(base).replace(/[^\w-]/g, '_').slice(0, 40)}_img`, S.docs.workflow.keys());
  if (!addDoc('workflow', id, { ...data, title })) return null;
  emit('open-workflow', id);
  log('ok', `открыт граф из ${found.name}${g.source ? ` (${g.source})` : ''} — новый воркфлоу «${title}»`);
  return id;
}
