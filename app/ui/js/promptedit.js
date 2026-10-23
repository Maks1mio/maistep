// Вес тега в промптах: Ctrl+↑ / Ctrl+↓ вокруг выделения или тега под курсором.
// Поля помечаются data-prompt-weight (CLIP Text Encode, Generate Image, ImageNaizer).
const STEP = 0.1, MIN = 0.1, MAX = 2.0;

const clampW = (w, cur = 1) => Math.max(MIN, Math.min(Math.max(MAX, cur), Math.round(w * 10) / 10));

function parseTag(s) {
  const t = String(s || '').trim();
  const m = t.match(/^\(([\s\S]*?)(?::\s*(-?\d+(?:\.\d+)?))?\)$/);
  return m ? { content: m[1].trim(), weight: m[2] != null ? Number(m[2]) : 1 } : { content: t, weight: 1 };
}

function adjust(el, delta) {
  const v = el.value;
  let start = el.selectionStart ?? 0, end = el.selectionEnd ?? start;
  if (start === end) {
    // тег под курсором: границы — соседние запятые/переводы строк (пробелы по краям не трогаем)
    start = Math.max(v.lastIndexOf(',', start - 1), v.lastIndexOf('\n', start - 1)) + 1;
    const comma = v.indexOf(',', start), nl = v.indexOf('\n', start);
    end = comma < 0 ? (nl < 0 ? v.length : nl) : (nl < 0 ? comma : Math.min(comma, nl));
    while (start < end && /\s/.test(v[start])) start++;
    while (end > start && /\s/.test(v[end - 1])) end--;
  }
  if (end <= start) return false;
  const { content, weight } = parseTag(v.slice(start, end));
  if (!content) return false;
  const w = clampW(weight + delta, weight);
  if (w === weight) return false;
  el.setRangeText(`(${content}:${w.toFixed(1)})`, start, end, 'select');
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}

export function initPromptWeights() {
  document.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    const el = e.target;
    if (!(el instanceof HTMLTextAreaElement) || !el.hasAttribute('data-prompt-weight') || el.readOnly || el.disabled) return;
    if (adjust(el, e.key === 'ArrowUp' ? STEP : -STEP)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
}
