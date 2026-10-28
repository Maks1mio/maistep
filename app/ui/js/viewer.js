// Просмотр картинок во весь окно (UI Kit): тулбар — имя, размер, номер, масштаб, «вписать» / 1:1, копировать;
// колесо — масштаб к курсору, перетаскивание — сдвиг, двойной щелчок — вписать ↔ 1:1, лента миниатюр внизу.
// Клавиши: ←/→ (Home/End) — листать, + / − — масштаб, 0 — вписать, 1 — 1:1, Ctrl+C — копировать, Esc — закрыть.
// openViewer(list, i, { actions }) — list: адреса или { src, name, info }; actions(item) → доп. кнопки тулбара
// [{ ic, tip, fn }] (например «Показать в проводнике»).
import { h } from './util.js';
import { icon } from './icons.js';
import { emit } from './store.js';

const log = (level, text) => emit('log', { src: 'editor', level, text });
let open = null;

const nameOf = src => {
  try {
    const u = new URL(src, location.href);
    return decodeURIComponent(u.searchParams.get('filename') || u.searchParams.get('id') || u.pathname.split('/').pop() || src);
  } catch { return src; }
};

// Картинка → буфер обмена (PNG: другие форматы буфер не принимает)
export async function copyImage(src) {
  try {
    let blob = await (await fetch(src)).blob();
    if (blob.type !== 'image/png') {
      const bmp = await createImageBitmap(blob);
      const c = Object.assign(document.createElement('canvas'), { width: bmp.width, height: bmp.height });
      c.getContext('2d').drawImage(bmp, 0, 0);
      blob = await new Promise(r => c.toBlob(r, 'image/png'));
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    log('ok', 'изображение скопировано');
  } catch (e) { log('error', `копирование изображения: ${e.message || e}`); }
}

export function openViewer(list, i = 0, { actions } = {}) {
  open?.close();
  const items = list.map(x => (typeof x === 'string' ? { src: x } : x)).filter(x => x?.src);
  if (!items.length) return;
  let at = Math.max(0, Math.min(i, items.length - 1));
  let z = 1, fitZ = 1, x = 0, y = 0, nw = 0, nh = 0, moved = false;

  const img = h('img.vw-img', { draggable: false, alt: '' });
  const stage = h('div.vw-stage', {}, img);
  const title = h('b.vw-name'), info = h('span.vw-info'), zoomEl = h('button.vw-zoom', { 'data-tip': 'Вписать (0)', onclick: () => fit() });
  const extra = h('span.vw-extra');
  const btn = (ic, tip, fn) => h('button.ui-ib', { 'data-tip': tip, onclick: e => { e.stopPropagation(); fn(); } }, icon(ic, { size: 16 }));
  const strip = items.length > 1 ? h('div.vw-strip', {}, ...items.map((it, k) => h('img', { src: it.thumb || it.src, loading: 'lazy', alt: '', draggable: false, onclick: () => go(k) }))) : null;
  const el = h('div.vw', { tabIndex: -1 },
    h('div.vw-top', {},
      icon('image', { size: 16 }), title, info, h('span.grow'), extra,
      btn('zoomOut', 'Уменьшить (−)', () => zoomAt(1 / 1.25)), zoomEl, btn('zoomIn', 'Увеличить (+)', () => zoomAt(1.25)),
      btn('fit', 'Вписать (0)', () => fit()), btn('actualZoom', 'Реальный размер (1)', () => setZoom(1)),
      h('span.vw-sep'),
      btn('copy', 'Копировать изображение (Ctrl+C)', () => copyImage(items[at].src)),
      btn('link', 'Копировать адрес', () => navigator.clipboard?.writeText(items[at].src)),
      h('span.vw-sep'),
      btn('close', 'Закрыть (Esc)', () => close())),
    h('div.vw-main', {}, stage,
      items.length > 1 ? h('button.vw-nav.l', { 'data-tip': 'Предыдущая (←)', onclick: () => go(at - 1) }, icon('left', { size: 20 })) : null,
      items.length > 1 ? h('button.vw-nav.r', { 'data-tip': 'Следующая (→)', onclick: () => go(at + 1) }, icon('right', { size: 20 })) : null),
    strip);

  const apply = () => {
    img.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
    img.classList.toggle('px', z >= 2);
    zoomEl.textContent = `${Math.round(z * 100)}%`;
  };
  const center = () => { const r = stage.getBoundingClientRect(); x = (r.width - nw * z) / 2; y = (r.height - nh * z) / 2; };
  const fit = (cap = false) => {
    const r = stage.getBoundingClientRect();
    fitZ = Math.min((r.width - 32) / nw, (r.height - 32) / nh) || 1;
    z = cap ? Math.min(1, fitZ) : fitZ;
    center(); apply();
  };
  const setZoom = v => { const r = stage.getBoundingClientRect(); zoomAt(v / z, r.width / 2, r.height / 2); };
  function zoomAt(k, cx, cy) {
    const r = stage.getBoundingClientRect();
    cx ??= r.width / 2; cy ??= r.height / 2;
    const nz = Math.max(0.02, Math.min(32, z * k));
    x = cx - (cx - x) * (nz / z); y = cy - (cy - y) * (nz / z); z = nz;
    apply();
  }
  function go(k) {
    at = (k + items.length) % items.length;
    const it = items[at];
    title.textContent = it.name || nameOf(it.src);
    info.textContent = items.length > 1 ? `${at + 1} / ${items.length}` : '';
    extra.replaceChildren(...(actions?.(it) || []).map(a => btn(a.ic, a.tip, () => a.fn(it))));
    strip?.querySelectorAll('img').forEach((t, n) => t.classList.toggle('on', n === at));
    strip?.children[at]?.scrollIntoView({ inline: 'center', block: 'nearest' });
    img.style.opacity = '0';
    img.onload = () => {
      nw = img.naturalWidth; nh = img.naturalHeight;
      info.textContent = [`${nw}×${nh}`, it.info, items.length > 1 ? `${at + 1} / ${items.length}` : ''].filter(Boolean).join(' · ');
      fit(true);
      img.style.opacity = '';
    };
    img.onerror = () => { info.textContent = 'не удалось загрузить'; img.style.opacity = ''; };
    img.src = it.src;
  }
  function close() {
    el.remove();
    removeEventListener('keydown', key, true);
    removeEventListener('resize', onResize);
    open = null;
  }
  const onResize = () => fit(z === Math.min(1, fitZ));

  stage.addEventListener('wheel', e => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  // своё перетаскивание: без выделения и системного drag картинки
  stage.addEventListener('dragstart', e => e.preventDefault());
  stage.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    moved = false;
    const sx = e.clientX - x, sy = e.clientY - y, x0 = e.clientX, y0 = e.clientY;
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('drag');
    const mv = ev => { if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) > 3) moved = true; x = ev.clientX - sx; y = ev.clientY - sy; apply(); };
    const up = () => { stage.classList.remove('drag'); stage.removeEventListener('pointermove', mv); stage.removeEventListener('pointerup', up); };
    stage.addEventListener('pointermove', mv);
    stage.addEventListener('pointerup', up);
  });
  // щелчок мимо картинки — закрыть; двойной по ней — вписать ↔ 1:1
  stage.addEventListener('click', e => { if (!moved && e.target === stage) close(); });
  img.addEventListener('dblclick', e => {
    const r = stage.getBoundingClientRect();
    const target = Math.abs(z - 1) < 0.01 ? Math.min(1, fitZ) === 1 ? 2 : Math.min(1, fitZ) : 1;
    zoomAt(target / z, e.clientX - r.left, e.clientY - r.top);
  });
  const key = e => {
    if (e.target.closest?.('input, textarea')) return;
    const k = e.key;
    if (k === 'Escape') close();
    else if (k === 'ArrowRight' || k === 'PageDown') go(at + 1);
    else if (k === 'ArrowLeft' || k === 'PageUp') go(at - 1);
    else if (k === 'Home') go(0);
    else if (k === 'End') go(items.length - 1);
    else if (k === '+' || k === '=') zoomAt(1.25);
    else if (k === '-' || k === '_') zoomAt(1 / 1.25);
    else if (k === '0') fit();
    else if (k === '1') setZoom(1);
    else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'c' && !String(getSelection())) copyImage(items[at].src);
    else return;
    e.preventDefault(); e.stopPropagation();
  };
  addEventListener('keydown', key, true);
  addEventListener('resize', onResize);
  document.body.append(el);
  el.focus();
  open = { close };
  go(at);
}

export const closeViewer = () => open?.close();
