"""LLM-ноды. Провайдер и модель выбираются из каталога (Настройки → Провайдеры, server/maistep/providers.py):
CheapVibeCode (Claude через /v1/messages, остальное через /v1/chat/completions), Anthropic, OpenAI-совместимые API, Ollama.
Claude — через официальный SDK anthropic, остальное — urllib. Ответ стримится в превью ноды (ctx.stream)."""
import base64
import json
import urllib.error
import urllib.request

from maistep import node
from maistep import providers as P

from .image import image_bytes

# модели, для которых включаем серверный фолбэк при отказе (refusal) — beta server-side-fallback
FALLBACK_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}
EFFORTS = ["medium", "low", "high", "xhigh", "max", "auto"]


def _anthropic(ctx, p, model, system, prompt, image, max_tokens, effort):
    try:
        import anthropic
    except ImportError:
        raise RuntimeError("нет пакета anthropic — выполните: .venv\\Scripts\\python -m pip install -r requirements.txt")
    # ключ None — SDK возьмёт ANTHROPIC_API_KEY / профиль `ant auth login`
    client = anthropic.Anthropic(api_key=p.get("api_key") or None, base_url=P.anthropic_base(p))
    content = []
    if image:
        data, mime = image_bytes(image, ctx.root)
        content.append({"type": "image", "source": {"type": "base64", "media_type": mime, "data": base64.standard_b64encode(data).decode()}})
    content.append({"type": "text", "text": prompt})
    kw = {"model": model, "max_tokens": max_tokens, "messages": [{"role": "user", "content": content}]}
    if system:
        kw["system"] = system
    if effort != "auto":
        kw["output_config"] = {"effort": effort}
    if model in FALLBACK_MODELS:
        kw["betas"] = ["server-side-fallback-2026-07-01"]
        kw["fallbacks"] = "default"
    with client.beta.messages.stream(**kw) as stream:
        for text in stream.text_stream:
            ctx.stream(text)
        msg = stream.get_final_message()
    if msg.stop_reason == "refusal":
        cat = getattr(getattr(msg, "stop_details", None), "category", None)
        raise RuntimeError(f"модель отказалась отвечать{f' ({cat})' if cat else ''}")
    if msg.stop_reason == "max_tokens":
        ctx.log("ответ обрезан по max_tokens", "warn")
    return "".join(b.text for b in msg.content if b.type == "text")


def _sse(req):
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    yield line
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"HTTP {e.code}: {body}") from None


def _openai(ctx, p, model, system, prompt, image, max_tokens, temperature):
    base = (p.get("base_url") or "https://api.openai.com/v1").rstrip("/")
    user = prompt
    if image:
        data, mime = image_bytes(image, ctx.root)
        user = [{"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{base64.b64encode(data).decode()}"}}]
    msgs = ([{"role": "system", "content": system}] if system else []) + [{"role": "user", "content": user}]
    body = {"model": model, "messages": msgs, "stream": True, "max_tokens": max_tokens}
    if temperature is not None:
        body["temperature"] = temperature
    req = urllib.request.Request(f"{base}/chat/completions", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {p.get('api_key', '')}"})
    out = []
    for line in _sse(req):
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        d = json.loads(payload)
        if d.get("error"):
            raise RuntimeError(str(d["error"].get("message") if isinstance(d["error"], dict) else d["error"]))
        delta = (d.get("choices") or [{}])[0].get("delta", {}).get("content")
        if delta:
            out.append(delta)
            ctx.stream(delta)
    return "".join(out)


def _ollama(ctx, p, model, system, prompt, image, temperature):
    base = (p.get("base_url") or "http://localhost:11434").rstrip("/")
    msg = {"role": "user", "content": prompt}
    if image:
        msg["images"] = [base64.b64encode(image_bytes(image, ctx.root)[0]).decode()]
    msgs = ([{"role": "system", "content": system}] if system else []) + [msg]
    req = urllib.request.Request(f"{base}/api/chat", method="POST", headers={"content-type": "application/json"},
                                 data=json.dumps({"model": model, "messages": msgs, "stream": True, "options": {"temperature": temperature}}).encode())
    out = []
    for line in _sse(req):
        part = json.loads(line).get("message", {}).get("content")
        if part:
            out.append(part)
            ctx.stream(part)
    return "".join(out)


def ask(ctx, provider, model, system, prompt, image=None, max_tokens=16000, effort="medium", temperature=0.7):
    """Один запрос к модели: протокол выбирается по провайдеру и каталогу моделей."""
    if not model:
        raise ValueError("не выбрана модель")
    p = P.provider(provider)
    meta = P.model_meta(provider, model) if p.get("kind") in ("proxy", "openai") else None
    if image and meta and not meta.get("vision"):
        raise ValueError(f"{model} не принимает картинки — выберите модель со значком 👁")
    if meta and meta.get("max_output") and max_tokens > meta["max_output"]:
        max_tokens = meta["max_output"]
    r = P.route(p, model, meta)
    if r == "anthropic":
        return _anthropic(ctx, p, model, system, prompt, image, max_tokens, effort)
    if r == "ollama":
        return _ollama(ctx, p, model, system, prompt, image, temperature)
    return _openai(ctx, p, model, system, prompt, image, max_tokens, temperature)


def _provider_opts():
    ids = list(P.providers())
    d = P.default_provider()
    return [d] + [i for i in ids if i != d]


PROVIDERS = _provider_opts()
MODEL = ("STRING", {"default": "claude-opus-5-5", "picker": "llm_model", "provider_input": "provider",
                    "hint": "модель из каталога провайдера (щёлкните по полю — поиск со значками)"})


@node("llm.chat", title="LLM", cat="AI",
      inputs={
          "prompt": ("STRING", {"multiline": True, "default": ""}),
          "system": ("STRING", {"multiline": True, "default": ""}),
          "provider": (PROVIDERS, {"hint": "Настройки → Провайдеры LLM"}),
          "model": MODEL,
          "max_tokens": ("INT", {"default": 16000, "min": 1, "max": 128000}),
          "effort": (EFFORTS, {"hint": "только для Claude: глубина рассуждений; auto — не передавать"}),
          "temperature": ("FLOAT", {"default": 0.7, "min": 0, "max": 2, "step": 0.05, "hint": "только не-Claude модели"}),
          "seed": ("INT", {"default": 0, "hint": "поменяйте, чтобы получить новый ответ вместо кэша"}),
          "image": ("IMAGE", {"optional": True, "needs": "vision"}),
      },
      outputs={"text": "STRING"},
      hint="Запрос к языковой модели; ответ стримится на ноду.")
def llm_chat(prompt, system, provider, model, max_tokens, effort, temperature, seed, ctx, image=None):
    if not prompt.strip():
        raise ValueError("пустой prompt")
    return ask(ctx, provider, model, system, prompt, image, max_tokens, effort, temperature)


@node("llm.map", title="LLM по списку", cat="AI",
      inputs={"items": ("JSON", {}), "template": ("STRING", {"multiline": True, "default": "Кратко опиши: {item}"}),
              "system": ("STRING", {"multiline": True, "default": ""}), "provider": (PROVIDERS, {}), "model": MODEL,
              "max_tokens": ("INT", {"default": 4000}), "effort": (EFFORTS, {})},
      outputs={"list": "JSON", "text": "STRING"},
      hint="Один запрос на каждый элемент списка; {item} — элемент, {i} — номер.")
def llm_map(items, template, system, provider, model, max_tokens, effort, ctx):
    out = []
    for i, it in enumerate(items or []):
        ctx.progress(i, len(items))
        p = template.replace("{item}", it if isinstance(it, str) else json.dumps(it, ensure_ascii=False)).replace("{i}", str(i + 1))
        ctx.stream(f"\n— {i + 1}/{len(items)} —\n")
        out.append(ask(ctx, provider, model, system, p, None, max_tokens, effort))
    ctx.progress(len(out), len(out))
    return {"list": out, "text": "\n\n".join(out)}
