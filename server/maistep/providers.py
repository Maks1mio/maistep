"""Провайдеры LLM и каталоги их моделей.

Настройки — user/settings.json (в .gitignore):
    { "default_provider": "cheapvibecode",
      "providers": { "<id>": { "name", "base_url", "api_key", "kind" } } }
kind:
    proxy      — агрегатор с обоими протоколами на одном хосте (CheapVibeCode): Claude — через /v1/messages,
                 остальное — через /v1/chat/completions; каталог /v1/models с расширенными полями
    anthropic  — API Anthropic (официальный SDK)
    openai     — любой OpenAI-совместимый API (OpenAI, LM Studio, OpenRouter, vLLM)
    ollama     — локальная Ollama
Встроенные anthropic / openai / ollama есть всегда (ключи из переменных окружения), настроенные их перекрывают.
"""
import json
import os
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = ROOT / "user" / "settings.json"
CACHE_FILE = ROOT / "user" / "models_cache.json"
CACHE_TTL = 6 * 3600
MASK = "••••"

BUILTIN = {
    "anthropic": {"name": "Anthropic", "kind": "anthropic", "base_url": "https://api.anthropic.com", "env": "ANTHROPIC_API_KEY"},
    "openai": {"name": "OpenAI-совместимый", "kind": "openai", "base_url": "https://api.openai.com/v1", "env": "OPENAI_API_KEY"},
    "ollama": {"name": "Ollama", "kind": "ollama", "base_url": "http://localhost:11434"},
}

_lock = threading.Lock()
_cache = None  # pid → {"at": t, "models": [...]}


def load_settings():
    try:
        s = json.loads(SETTINGS.read_text("utf-8"))
    except (OSError, ValueError):
        s = {}
    # старый плоский формат (anthropic_api_key, openai_base_url, ollama_url) — переносим в providers
    prov = s.setdefault("providers", {})
    if s.get("anthropic_api_key"):
        prov.setdefault("anthropic", {})["api_key"] = s.pop("anthropic_api_key")
    if s.get("openai_api_key") or s.get("openai_base_url"):
        p = prov.setdefault("openai", {})
        if s.get("openai_api_key"):
            p["api_key"] = s.pop("openai_api_key")
        if s.get("openai_base_url"):
            p["base_url"] = s.pop("openai_base_url")
    if s.get("ollama_url"):
        prov.setdefault("ollama", {})["base_url"] = s.pop("ollama_url")
    return s


def save_settings(s):
    SETTINGS.parent.mkdir(exist_ok=True)
    SETTINGS.write_text(json.dumps(s, ensure_ascii=False, indent=2), "utf-8")


def providers(settings=None):
    """id → полное описание провайдера (с ключом)."""
    s = settings or load_settings()
    out = {}
    for pid, b in BUILTIN.items():
        out[pid] = {**b, "api_key": os.environ.get(b.get("env", ""), "") if b.get("env") else ""}
    for pid, p in (s.get("providers") or {}).items():
        base = out.get(pid, {"name": pid, "kind": "openai"})
        out[pid] = {**base, **{k: v for k, v in p.items() if v not in (None, "")}}
    return out


def default_provider(settings=None):
    s = settings or load_settings()
    ps = providers(s)
    d = s.get("default_provider")
    return d if d in ps else next((k for k, p in ps.items() if p.get("api_key")), "anthropic")


def provider(pid):
    p = providers().get(pid)
    if not p:
        raise ValueError(f"нет провайдера {pid} — добавьте его в Настройки → Провайдеры")
    return p


def public(settings=None):
    """Настройки для UI: ключи замаскированы."""
    s = settings or load_settings()
    ps = providers(s)
    return {
        "default_provider": default_provider(s),
        "providers": {pid: {**{k: v for k, v in p.items() if k not in ("api_key", "env")},
                            "has_key": bool(p.get("api_key")),
                            "api_key": (MASK + p["api_key"][-4:]) if p.get("api_key") else "",
                            "builtin": pid in BUILTIN, "env": p.get("env", "")} for pid, p in ps.items()},
    }


def update(data):
    """Сохранить правки из UI. Замаскированный ключ = не менять; пустой = удалить."""
    s = load_settings()
    prov = s.setdefault("providers", {})
    for pid, p in (data.get("providers") or {}).items():
        if p is None:
            prov.pop(pid, None)
            continue
        cur = prov.setdefault(pid, {})
        for k in ("name", "base_url", "kind"):
            if k in p:
                cur[k] = p[k]
        if "api_key" in p and not str(p["api_key"]).startswith(MASK):
            if p["api_key"]:
                cur["api_key"] = p["api_key"].strip()
            else:
                cur.pop("api_key", None)
    if data.get("default_provider"):
        s["default_provider"] = data["default_provider"]
    save_settings(s)
    invalidate()
    return public(s)

# ---------- каталог моделей ----------


def _get_json(url, key=None, timeout=30):
    h = {"accept": "application/json"}
    if key:
        h["authorization"] = f"Bearer {key}"
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
        return json.loads(r.read())


def _norm(m, pid):
    """Модель каталога в общем виде для UI."""
    mid = m.get("id") or m.get("name")
    owned = (m.get("owned_by") or m.get("company") or "").lower()
    ctx = m.get("context_window") or m.get("max_context_tokens") or m.get("context_length") or m.get("max_input_tokens")
    return {
        "id": mid,
        "name": m.get("display_name") or mid,
        "company": m.get("company") or m.get("owned_by") or "",
        "series": m.get("series") or "",
        "owned_by": owned,
        "vision": bool(m.get("supports_vision")) or "image" in (m.get("input_modalities") or []),
        "reasoning": bool(m.get("supports_reasoning")),
        "tools": bool(m.get("supports_tools")),
        "context": ctx,
        "max_output": m.get("max_output_tokens") or m.get("max_tokens"),
        "multiplier": m.get("multiplier"),
        "provider": pid,
    }


def _fetch(pid, p):
    kind, base, key = p.get("kind"), (p.get("base_url") or "").rstrip("/"), p.get("api_key")
    if kind == "ollama":
        tags = _get_json(f"{base}/api/tags", timeout=5).get("models", [])
        return [{"id": t["name"], "name": t["name"], "company": "local", "series": t.get("details", {}).get("family", ""), "owned_by": "ollama",
                 "vision": False, "reasoning": False, "tools": False, "context": None, "max_output": None, "multiplier": None, "provider": pid} for t in tags]
    if kind == "anthropic":
        if not key:
            raise RuntimeError("нет ключа")
        import anthropic
        client = anthropic.Anthropic(api_key=key, base_url=base or None)
        out = []
        for m in client.models.list():
            caps = getattr(m, "capabilities", None)
            vision = True if caps is None else bool(getattr(getattr(caps, "image_input", None), "supported", True))
            out.append({"id": m.id, "name": m.display_name or m.id, "company": "Anthropic", "series": "", "owned_by": "anthropic",
                        "vision": vision, "reasoning": True, "tools": True, "context": getattr(m, "max_input_tokens", None),
                        "max_output": getattr(m, "max_tokens", None), "multiplier": None, "provider": pid})
        return out
    data = _get_json(f"{base}/models", key)
    return [_norm(m, pid) for m in (data.get("data", data) if isinstance(data, dict) else data)]


def _load_cache():
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(CACHE_FILE.read_text("utf-8"))
        except (OSError, ValueError):
            _cache = {}
    return _cache


def invalidate(pid=None):
    with _lock:
        c = _load_cache()
        if pid:
            c.pop(pid, None)
        else:
            c.clear()


def models(pid, refresh=False):
    """Каталог моделей провайдера (кэш 6 ч в user/models_cache.json). {models, at, error?}"""
    p = provider(pid)
    with _lock:
        c = _load_cache()
        hit = c.get(pid)
        if hit and not refresh and time.time() - hit["at"] < CACHE_TTL:
            return hit
    try:
        ms = sorted(_fetch(pid, p), key=lambda m: (m["company"].lower(), m["id"]))
    except Exception as e:  # сеть, ключ — отдаём старый кэш с ошибкой
        return {**(hit or {"models": [], "at": 0}), "error": f"{type(e).__name__}: {e}"}
    entry = {"models": ms, "at": time.time()}
    with _lock:
        c[pid] = entry
        try:
            CACHE_FILE.parent.mkdir(exist_ok=True)
            CACHE_FILE.write_text(json.dumps(c, ensure_ascii=False), "utf-8")
        except OSError:
            pass
    return entry


def model_meta(pid, model_id):
    for m in models(pid).get("models", []):
        if m["id"] == model_id:
            return m
    return None


def route(p, model_id, meta=None):
    """Протокол запроса: anthropic | openai | ollama."""
    kind = p.get("kind")
    if kind in ("anthropic", "ollama", "openai"):
        return kind
    # proxy: Claude — через Messages API, остальное — через chat/completions
    owned = (meta or {}).get("owned_by", "")
    return "anthropic" if owned == "anthropic" or model_id.startswith("claude") else "openai"


def anthropic_base(p):
    """Base URL для SDK anthropic: он сам дописывает /v1/messages."""
    base = (p.get("base_url") or "").rstrip("/")
    return base[:-3] if base.endswith("/v1") else base or None
