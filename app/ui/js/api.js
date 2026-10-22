// Связь с ядром: в окне Tauri — invoke/listen, в обычном браузере — dev-сервер editor/dev-server.mjs
// (те же команды по HTTP и события через SSE; нужен для отладки UI без сборки Rust).

const T = window.__TAURI__;
export const isTauri = !!T?.core;
const isWin = navigator.userAgent.includes('Windows');

export async function invoke(cmd, args = {}) {
  if (isTauri) return T.core.invoke(cmd, args);
  const r = await fetch(`/api/${cmd}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw j?.error || `${cmd}: HTTP ${r.status}`;
  return j;
}

let sse = null;
export function listen(evt, fn) {
  if (isTauri) return T.event.listen(evt, e => fn(e.payload));
  sse ||= new EventSource('/events');
  sse.addEventListener(evt, e => fn(JSON.parse(e.data)));
  return Promise.resolve(() => {});
}

// Картинка из graphics (custom/ перекрывает game/) без игрового сервера — протокол oja ядра
export function assetUrl(rel, pak = 'g') {
  const p = rel.split('/').map(encodeURIComponent).join('/');
  if (!isTauri) return `/oja/${pak}/${p}`;
  return isWin ? `http://oja.localhost/${pak}/${p}` : `oja://localhost/${pak}/${p}`;
}

export function openExternal(url) {
  if (isTauri) return invoke('open_external', { url });
  window.open(url, '_blank', 'noopener');
}
