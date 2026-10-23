"""Перевод промптов на английский перед кодированием.

Русский и смешанный русско-английский текст переводится выбранной LLM (Настройки → Провайдеры →
«Перевод промптов»); English-теги, веса `(tag:1.2)`, `<lora:…>` и подчёркивания сохраняются.
Если перевод не настроен/не удался, промпт уходит как есть — генерация не падает.
"""
import hashlib
import json
import re
import threading
from pathlib import Path

from . import providers as P

ROOT = Path(__file__).resolve().parents[2]
CACHE_FILE = ROOT / "user" / "prompts_en.json"

# кириллица, CJK, хангыль, арабица, иврит: латиницу (в т.ч. английские теги) не трогаем
NON_LATIN = re.compile(r"[\u0400-\u04FF\u4E00-\u9FFF\u3040-\u30FF\uAC00-\uD7AF\u0600-\u06FF\u0590-\u05FF]")
FAST = re.compile(r"(flash|mini|haiku|lite|small|turbo|fast|instant)", re.I)
SYSTEM = ("You translate prompts for Stable Diffusion. Keep the meaning, comma-separated tag order, "
          "weights like (tag:1.2), underscores, <lora:...>, embeddings and already-English tags. "
          "Translate only the non-English words. Return only the prompt, no explanations.")
PROMPT = ("Translate this prompt to English. Keep English tags, weights and <lora:...> as they are:\n\n{text}")

_lock = threading.Lock()
_cache = None  # ключ → перевод


def needs(text):
    """В тексте есть нелатинские буквы (русский/смешанный промпт)."""
    return bool(text and NON_LATIN.search(text))


def _load_cache():
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(CACHE_FILE.read_text("utf-8"))
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save_cache():
    try:
        CACHE_FILE.parent.mkdir(exist_ok=True)
        tmp = CACHE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(_cache, ensure_ascii=False), "utf-8")
        tmp.replace(CACHE_FILE)
    except OSError:
        pass


def _auto_model(pid):
    """Дешёвая/быстрая модель провайдера: flash/mini/haiku, без reasoning, с меньшим множителем."""
    try:
        models = P.models(pid).get("models") or []
    except Exception:
        return ""
    def score(m):
        mid = (m.get("id") or "").lower()
        mult = m.get("multiplier")
        mult = float(mult) if isinstance(mult, (int, float)) else 99.0
        return (0 if FAST.search(mid) else 1, 1 if m.get("reasoning") else 0, mult, mid)
    rows = [m for m in models if m.get("id")]
    return sorted(rows, key=score)[0]["id"] if rows else ""


def target():
    """(provider, model) для перевода или None, если перевод выключен/не настроен."""
    s = P.load_settings()
    t = s.get("translate") or {}
    if t.get("enabled") is False:
        return None
    pid = (t.get("provider") or s.get("default_provider") or P.default_provider() or "").strip()
    if not pid:
        return None
    mid = (t.get("model") or "").strip() or _auto_model(pid)
    return (pid, mid) if mid else None


def translate(ctx, text):
    """Перевести промпт на английский, если в нём есть нелатинские буквы. Ошибки не валят запуск."""
    if not needs(text):
        return text
    t = P.load_settings().get("translate") or {}
    if t.get("enabled") is False:
        return text  # перевод выключен явно — без предупреждений
    tg = target()
    if not tg:
        if ctx:
            ctx.log("промпт не переведён: в Настройках → Провайдеры не выбрана модель перевода", "warn")
        return text
    pid, mid = tg
    key = hashlib.sha1(f"{pid}\n{mid}\n{text}".encode("utf-8")).hexdigest()
    with _lock:
        c = _load_cache()
        if key in c:
            return c[key]
    try:
        from maistep_nodes.nodes import llm as L
        out = L.ask(ctx, pid, mid, SYSTEM, PROMPT.format(text=text), None,
                    max(512, min(4000, len(text) * 2 + 200)), "auto", 0.1)
    except Exception as e:
        if ctx:
            ctx.log(f"перевод промпта не удался ({mid}): {e}", "warn")
        return text
    out = (out or "").strip().strip('`"\'')
    out = re.sub(r"^(translation|перевод)\s*:\s*", "", out, flags=re.I).strip()
    if not out or needs(out):
        if ctx:
            ctx.log(f"перевод промпта не удался ({mid}): ответ не на английском", "warn")
        return text
    with _lock:
        c = _load_cache()
        c[key] = out
        while len(c) > 1000:
            c.pop(next(iter(c)))
        _save_cache()
    if ctx:
        ctx.log(f"промпт переведён на английский ({mid})", "info")
    return out
