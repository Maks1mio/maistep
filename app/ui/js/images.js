// Картинки для нод и ImageNaizer: выбор из библиотеки приложения (input/ и output/ сервера) или с диска (проводник),
// разбор перетаскивания (файлы ОС, плитки Project — text/mai-file, картинки из Results/превью — ссылка /view?file=…,
// картинки с веб-страниц — по URL) и вставки из буфера обмена. Всё чужое загружается в input/ (/api/upload).
import { h } from './util.js';
import { emit } from './store.js';
import { api, fileUrl, upload } from './backend.js';

const IMG = /\.(png|jpe?g|webp|gif|bmp)$/i;
const log = (level, text) => emit('log', { src: 'editor', level, text });
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

// путь проекта из ссылки /view?file=output/x.png (картинки самого приложения)
function ownFile(url) {
  try {
    const u = new URL(url);
    const f = u.pathname === '/view' && u.searchParams.get('file');
    return f && /^(input|output)\//.test(f) ? f : null;
  } catch { return null; }
}

async function uploadBlob(blob, name) {
  const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '');
  return upload(new File([blob], IMG.test(name || '') ? name : `${name || `image_${stamp()}`}.${ext}`, { type: blob.type || 'image/png' }));
}

// есть ли в перетаскивании что-то похожее на картинку (для подсветки и preventDefault)
export const transferHasImage = dt => !!dt && [...(dt.types || [])].some(t => t === 'Files' || t === 'text/mai-file' || t === 'text/uri-list' || t === 'text/html');

// перетаскивание → пути картинок в проекте (input/… или output/…)
export async function imagesFromTransfer(dt) {
  // всё из dataTransfer — до первого await: после события браузер его очищает
  const out = [], mai = dt.getData('text/mai-file'), files = [...(dt.files || [])];
  let url = (dt.getData('text/uri-list') || '').split('\n').find(l => l && !l.startsWith('#'));
  if (!url) url = /<img[^>]+src="([^"]+)"/i.exec(dt.getData('text/html') || '')?.[1];
  if (mai) return IMG.test(mai) ? [mai] : [];
  for (const f of files) {
    if (!/^image\//.test(f.type) && !IMG.test(f.name)) continue;
    try { out.push(await upload(f)); } catch (e) { log('error', `загрузка ${f.name}: ${e.message} (сервер запущен?)`); }
  }
  // картинка из окна (Results, превью) или с веб-страницы — ссылкой
  if (out.length || !url) return out;
  url = url.replace(/&amp;/g, '&');
  const own = ownFile(url);
  if (own) return [own];
  try {
    const r = await fetch(url);
    const b = await r.blob();
    if (!/^image\//.test(b.type)) throw new Error('не картинка');
    out.push(await uploadBlob(b, decodeURIComponent(new URL(url).pathname.split('/').pop() || '').replace(/[^\w.-]+/g, '_')));
  } catch (e) { log('warn', `картинку по ссылке не взять (${e.message}) — сохраните её на диск и перетащите файл`); }
  return out;
}

// вставка (Ctrl+V) → пути картинок; пустой список — в буфере нет картинки
export async function imagesFromClipboard(e) {
  const items = [...(e.clipboardData?.items || [])];
  const files = items.filter(i => i.kind === 'file' && /^image\//.test(i.type)).map(i => i.getAsFile()).filter(Boolean);
  const text = e.clipboardData?.getData('text/plain')?.trim(), out = [];
  for (const f of files) {
    try { out.push(await uploadBlob(f, `paste_${stamp()}`)); } catch (err) { log('error', `вставка картинки: ${err.message} (сервер запущен?)`); }
  }
  if (out.length) return out;
  const own = text && ownFile(text);
  return own ? [own] : [];
}
export const clipboardHasImage = e => [...(e.clipboardData?.items || [])].some(i => i.kind === 'file' && /^image\//.test(i.type));

// окно выбора: вкладки «Загруженные (input/)» и «Результаты (output/)», поиск, «С диска…»
let pop = null;
export const closeImagePicker = () => { pop?.remove(); pop = null; };

export async function imagePicker(at, { value = '', onPick }) {
  closeImagePicker();
  const r = at instanceof Element ? at.getBoundingClientRect() : { left: at.clientX, bottom: at.clientY };
  let dir = /^output\//.test(value) ? 'output' : 'input', files = { input: null, output: null };
  const q = h('input', { placeholder: 'поиск по имени…', spellcheck: false });
  const grid = h('div.lgrid.lpick.ipick');
  const fileIn = h('input', { type: 'file', accept: 'image/*', multiple: false, style: { display: 'none' } });
  const tabs = h('div.ui-seg');
  const pick = f => { closeImagePicker(); onPick(f); };
  fileIn.onchange = async () => {
    const f = fileIn.files[0];
    if (!f) return;
    try { pick(await upload(f)); } catch (e) { log('error', `загрузка: ${e.message} (сервер запущен?)`); }
  };
  pop = h('div.gfloat.lpop', { onpointerdown: e => e.stopPropagation() },
    h('div.row', { style: { gap: '6px', marginBottom: '6px' } }, tabs, q,
      h('button.primary', { onclick: () => fileIn.click(), 'data-tip': 'Выбрать файл в проводнике — загрузится в input/' }, 'С диска…'), fileIn),
    grid);
  document.body.append(pop);
  const place = () => {
    if (!pop) return;
    pop.style.left = `${Math.max(4, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
    pop.style.top = `${Math.max(4, Math.min(r.bottom + 4, innerHeight - pop.offsetHeight - 8))}px`;
  };
  const fill = () => {
    tabs.replaceChildren(...[['input', 'Загруженные'], ['output', 'Результаты']].map(([k, t]) =>
      h(`button${dir === k ? '.on' : ''}`, { onclick: () => { dir = k; fill(); load(); } }, t)));
    const list = files[dir];
    if (!list) { grid.replaceChildren(h('div.dim', {}, 'загрузка…')); return place(); }
    const s = q.value.toLowerCase();
    const vis = list.filter(f => !s || f.file.toLowerCase().includes(s)).slice(0, 120);
    grid.replaceChildren(...(vis.length ? vis.map(f => h(`div.ltile${f.file === value ? '.sel' : ''}`, { 'data-tip': f.file, onclick: () => pick(f.file) },
      h('div.lth', {}, h('img', { src: fileUrl(f.file), loading: 'lazy', alt: '', draggable: false })),
      h('div.lnm', {}, h('span.n', {}, f.file.split('/').pop())))) : [h('div.dim', {}, dir === 'input' ? 'нет загруженных картинок — «С диска…»' : 'нет результатов')]));
    place();
  };
  const load = async () => {
    if (files[dir]) return;
    try {
      const l = await api(`/api/files?dir=${dir}`);
      files[dir] = l.filter(f => IMG.test(f.file) && !/naizer_mask_/.test(f.file));
    } catch (e) { files[dir] = []; log('error', `список картинок: ${e.message} (сервер запущен?)`); }
    if (pop) fill();
  };
  q.addEventListener('input', fill);
  q.addEventListener('keydown', e => { e.stopPropagation(); if (e.key === 'Escape') closeImagePicker(); if (e.key === 'Enter') grid.querySelector('.ltile')?.click(); });
  fill();
  q.focus();
  load();
  const off = e => { if (pop && !pop.contains(e.target)) { closeImagePicker(); removeEventListener('pointerdown', off, true); } };
  setTimeout(() => addEventListener('pointerdown', off, true));
}

// файл, брошенный мимо приёмника, не должен открываться в окне вместо редактора
export function initImages() {
  addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) e.preventDefault(); });
  addEventListener('drop', e => { if (!e.defaultPrevented) e.preventDefault(); });
}
