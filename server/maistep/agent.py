"""AI Chat — агент в редакторе (как Claude): три среды — Agent, Code, RP.

Диалоги — user/chats/<id>.json: { id, title, created, updated, provider, model, effort, wf, hidden, mode, adult, perm,
character, cwd, folders, connectors, messages }.
  wf      — воркфлоу, к которому привязан диалог (его граф уходит в контекст);
  hidden  — воркфлоу, которые агенту видеть нельзя (их нет ни в контексте, ни в инструментах);
  mode    — agent (только программа: граф, картинки, ImageNaizer, интернет, управление окном) · code (помощник
            программиста, как Claude Code: файлы и команды в папке проекта cwd) · character (RP: ролевой чат-бот
            с персонажем и его фото). Старый dev = code в папке maistep;
  cwd     — папка проекта (режим code); folders — доп. папки [{ path, write }] (доступ агента к ПК — только к ним);
  connectors — MCP-серверы диалога (None — все включённые в настройках, [] — ни одного);
  adult   — метка 18+: разговор ушёл во взрослую тему (ставится сама — маркер модели ⟦18+⟧ или откровенный промпт
            картинки); взрослый контент разрешён всегда, переключателя нет (по просьбе пользователя 2026-10-25);
  perm    — ask: запись файлов, команды и JS спрашивают разрешения в чате · auto: без вопросов.
Действия в интерфейсе (вкладки, ImageNaizer, JS) исполняет клиент: событие SSE agent/client → POST /api/agent/client.
Сообщения хранятся в нейтральном виде и переводятся под протокол провайдера (providers.route):
  user      { text, images: ["input/…"] }
  assistant { text, thinking, tools: [{ id, name, input }], raw — блоки Claude как есть (для повторной отправки) }
  tool      { results: [{ id, name, ok, content, images }] }
  error     { text } — в модель не уходит.
Граф правит клиент: агент получает снимок видимых воркфлоу из UI, а его правки уходят событием SSE agent/workflow
и применяются в редакторе обычной правкой (с отменой). Запуск — общая очередь сервера (configure → put/history).
Claude (Anthropic SDK), OpenAI-совместимые и llama.cpp — с инструментами (+ MCP); Ollama — простой чат.
"""
import base64
import io
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from . import agent_tools as T
from . import executor
from . import library as L
from . import llamacpp
from . import mcp
from . import procs
from . import providers as P
from . import workspace as W
from .registry import NODES

ROOT = Path(__file__).resolve().parents[2]
CHATS = ROOT / "user" / "chats"
FALLBACK_MODELS = {"claude-fable-5-1", "claude-opus-5-5", "claude-opus-5", "claude-sonnet-5-5"}
EFFORTS = ("low", "medium", "high", "xhigh", "max")
MAX_TURNS = 40
IMG_MAX = 1568

_emit = lambda event, data: None  # noqa: E731
_queue = {"put": None, "history": None, "interrupt": None}
_runs = {}  # chat id → {"stop": Event, "thread": Thread}
_pending = {}  # id запроса → {"ev": Event, "res": ...} — ответы клиента и разрешения пользователя
MODES = ("agent", "code", "character")
_lock = threading.Lock()


def configure(emitter, put, history, interrupt):
    global _emit
    _emit = emitter
    procs.configure(emitter)
    _queue.update(put=put, history=history, interrupt=interrupt)


def ev(chat, kind, **data):
    _emit("agent", {"chat": chat, "kind": kind, **data})


# ---------- хранение ----------
def _path(cid):
    if not re.fullmatch(r"[a-z0-9]{6,40}", cid or ""):
        raise ValueError("плохой id диалога")
    return CHATS / f"{cid}.json"


def load(cid):
    try:
        chat = json.loads(_path(cid).read_text("utf-8"))
    except OSError:
        raise KeyError(cid) from None
    if chat.get("mode") == "dev":  # прежняя «Разработка» — Code в папке maistep
        chat["mode"], chat["cwd"] = "code", chat.get("cwd") or str(ROOT)
    if "adult" not in chat:  # диалоги до метки 18+: по откровенным промптам картинок и запросам фото
        chat["adult"] = any(_EXPLICIT.search(f"{t.get('input', {}).get('prompt', '')} {t.get('input', {}).get('scene', '')}")
                            for m in chat["messages"] for t in m.get("tools") or []) or \
            any("откровенн" in (m.get("text") or "") for m in chat["messages"] if m["role"] == "user")
    return chat


def _save(chat):
    CHATS.mkdir(parents=True, exist_ok=True)
    chat["updated"] = time.time()
    tmp = _path(chat["id"]).with_suffix(".tmp")
    tmp.write_text(json.dumps({k: v for k, v in chat.items() if not k.startswith("_")}, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(_path(chat["id"]))


def meta(chat):
    last = next((m for m in reversed(chat["messages"]) if m["role"] in ("user", "assistant") and m.get("text")), None)
    mode = chat.get("mode") or "agent"
    return {k: chat.get(k) for k in ("id", "title", "created", "updated", "provider", "model", "effort", "wf", "hidden",
                                     "adult", "perm", "character", "folders", "connectors", "todos")} | {
        "mode": "code" if mode == "dev" else mode, "cwd": chat.get("cwd") or (str(ROOT) if mode == "dev" else None),
        "count": sum(1 for m in chat["messages"] if m["role"] == "user"),
        "last": (last or {}).get("text", "")[:140], "busy": chat["id"] in _runs,
        "since": (_runs.get(chat["id"]) or {}).get("t0")}


def _tok(x):
    """Грубая оценка токенов: ~3.5 символа на токен (кириллица дороже — ~2.5)."""
    s = x if isinstance(x, str) else json.dumps(x, ensure_ascii=False)
    cyr = sum(1 for ch in s[:20000] if "Ѐ" <= ch <= "ӿ") / max(1, min(len(s), 20000))
    return int(len(s) / (3.6 - 1.1 * cyr))


def _window(chat):
    meta_ = None
    try:
        meta_ = P.model_meta(chat.get("provider"), chat.get("model") or "")
    except Exception:
        pass
    if meta_ and meta_.get("context"):
        return int(meta_["context"])
    m = chat.get("model") or ""
    return 1_000_000 if re.match(r"claude-(fable|opus|sonnet)-5", m) else 200_000 if m.startswith("claude") else 128_000


def context(cid, wfs=None):
    """Правая панель AI Chat: из чего состоит контекст диалога (оценка) и последняя реальная загрузка модели."""
    chat = load(cid)
    system, dynamic = _system(chat, wfs or {})
    parts = [{"key": "system", "label": "Системный промпт", "tokens": _tok(system) + _tok(dynamic)},
             {"key": "tools", "label": "Инструменты", "tokens": _tok(tools_for(chat))}]
    names = connectors(chat)
    mt = mcp.cached_tokens(names)
    parts.append({"key": "mcp", "label": "MCP-инструменты", "tokens": sum(v or 0 for v in mt.values()),
                  "pending": [n for n, v in mt.items() if v is None]})
    msg = 0
    for m in chat["messages"]:
        if m["role"] == "error":
            continue
        msg += _tok(m.get("text") or "") + _tok(m.get("thinking") or "") // 3
        msg += sum(_tok(t.get("input") or {}) for t in m.get("tools") or [])
        msg += sum(_tok(r.get("content") or "") + 1500 * len(r.get("images") or []) for r in m.get("results") or [])
        msg += 1500 * len(m.get("images") or [])
    parts.append({"key": "messages", "label": "Сообщения", "tokens": msg})
    last = next((m.get("usage") for m in reversed(chat["messages"]) if m.get("usage")), None)
    real = (last["in"] + last.get("cache_read", 0) + last["out"]) if last else None
    return {"window": _window(chat), "parts": parts, "estimate": sum(p["tokens"] for p in parts), "real": real,
            "model": chat.get("model"), "connectors": names}


def chats():
    out = []
    for p in CHATS.glob("*.json") if CHATS.is_dir() else []:
        try:
            out.append(meta(load(p.stem)))
        except (OSError, ValueError, KeyError):
            continue
    return sorted(out, key=lambda c: c.get("updated") or 0, reverse=True)


def upsert(d):
    """Создать (без id) или поменять настройки диалога: title, provider, model, effort, wf, hidden, mode, perm.
    Новый диалог с персонажем (character) начинается его приветствием."""
    if d.get("id"):
        chat = load(d["id"])
    else:
        prov = d.get("provider") or P.default_provider()
        chat = {"id": uuid.uuid4().hex[:16], "title": "", "created": time.time(), "provider": prov,
                "model": d.get("model") or "claude-opus-5-5", "effort": "medium", "wf": None, "hidden": [],
                "mode": "agent", "adult": False, "perm": "ask", "character": None, "cwd": None, "folders": [],
                "connectors": None, "messages": []}
        if d.get("character"):
            c = T.character(d["character"])
            chat.update(mode="character", character=c["id"], title=c.get("name") or "Персонаж")
            if (c.get("greeting") or "").strip():
                chat["messages"].append({"role": "assistant", "text": c["greeting"].strip(), "at": time.time()})
    for k in ("title", "provider", "model", "wf"):
        if k in d:
            chat[k] = d[k]
    if d.get("mode") in MODES:
        chat["mode"] = d["mode"]
    if d.get("perm") in ("ask", "auto"):
        chat["perm"] = d["perm"]
    if d.get("effort") in EFFORTS:
        chat["effort"] = d["effort"]
    if isinstance(d.get("hidden"), list):
        chat["hidden"] = sorted({str(x) for x in d["hidden"]})
    if "cwd" in d:
        chat["cwd"] = str(W.norm(d["cwd"])) if d["cwd"] else None
        if chat["cwd"]:
            W.touch(chat["cwd"])
    if isinstance(d.get("folders"), list):
        chat["folders"] = [{"path": str(W.norm(f["path"])), "write": bool(f.get("write"))}
                           for f in d["folders"] if isinstance(f, dict) and f.get("path")]
    if "connectors" in d:
        chat["connectors"] = None if d["connectors"] is None else [str(x) for x in d["connectors"]]
    _save(chat)
    return {**meta(chat), "messages": chat["messages"]}


def delete(cid):
    stop(cid)
    _path(cid).unlink(missing_ok=True)
    return {"ok": True}


def stop(cid):
    """«Стоп»: ход заканчивается сразу — поток модели/инструмента бросается, соединение с моделью закрывается,
    его поздние события отбрасываются (cev), написанное до остановки сохраняется."""
    r = _runs.get(cid)
    if r:
        r["stop"].set()
        chat = r.get("chat") or {}
        chat["_dead"] = True
        conn = chat.pop("_conn", None)
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass
        ev(cid, "stopping")
    return {"ok": True}


def cev(chat, kind, **data):
    """События стрима модели: после «Стоп» брошенный поток ещё может что-то прислать — не показываем."""
    if chat.get("_dead"):
        return
    if kind == "delta":
        chat["_partial"] = chat.get("_partial", "") + data.get("text", "")
    ev(chat["id"], kind, **data)


_STOPPED = object()


def _bg(stop_ev, fn, *args):
    """fn в отдельном потоке; ждём его, проверяя «Стоп» каждые 0.1 с. Остановлено — _STOPPED (поток бросаем)."""
    box, done = {}, threading.Event()

    def work():
        try:
            box["r"] = fn(*args)
        except BaseException as e:  # noqa: BLE001 — передаём в ход как есть
            box["e"] = e
        finally:
            done.set()
    threading.Thread(target=work, daemon=True).start()
    while not done.wait(0.1):
        if stop_ev.is_set():
            return _STOPPED
    if stop_ev.is_set():
        return _STOPPED
    if "e" in box:
        raise box["e"]
    return box["r"]


def answer(req, res):
    """Ответ клиента на agent/client или решение пользователя по agent/approve."""
    p = _pending.get(req)
    if p:
        p["res"] = res
        p["ev"].set()
    return {"ok": bool(p)}


def _wait(ctx, kind, timeout=None, **data):
    req = uuid.uuid4().hex[:12]
    p = _pending[req] = {"ev": threading.Event(), "res": None}
    ev(ctx.chat["id"], kind, req=req, **data)
    t0 = time.time()
    try:
        while not p["ev"].wait(0.25):
            if ctx.stop.is_set():
                raise InterruptedError("stopped by the user")
            if timeout and time.time() - t0 > timeout:
                raise TimeoutError("the app window did not answer (is the editor open?)")
        return p["res"]
    finally:
        _pending.pop(req, None)
        ev(ctx.chat["id"], f"{kind}_done", req=req)


def _approve(ctx, name, inp, summary):
    if ctx.chat.get("perm") == "auto":
        return
    r = _wait(ctx, "approve", name=name, input=inp, summary=summary) or {}
    if r.get("always"):
        ctx.chat["perm"] = "auto"
        _save(ctx.chat)
    if not r.get("ok"):
        raise PermissionError("the user declined this action" + (f": {r['reason']}" if r.get("reason") else ""))


def client(ctx, action, timeout=90, **args):
    r = _wait(ctx, "client", timeout=timeout, action=action, args=args) or {}
    if not r.get("ok"):
        raise RuntimeError(r.get("error") or "client action failed")
    return r.get("result")


# ---------- картинки ----------
def _safe(rel):
    rel = str(rel or "").replace("\\", "/").lstrip("/")
    if not re.match(r"^(input|output)/", rel) or ".." in rel.split("/"):
        raise ValueError(f"{rel}: only files from input/ or output/")
    p = ROOT / rel
    if not p.is_file():
        raise FileNotFoundError(f"no file {rel}")
    return p


def _image(rel):
    """(base64, mime): длинная сторона не больше IMG_MAX — так модель видит то же, а запрос в разы меньше."""
    p = _safe(rel)
    data, mime = p.read_bytes(), {"jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}.get(
        p.suffix.lower().lstrip("."), "image/png")
    try:
        from PIL import Image
        im = Image.open(io.BytesIO(data))
        if max(im.size) > IMG_MAX or mime not in ("image/png", "image/jpeg"):
            k = IMG_MAX / max(im.size)
            if k < 1:
                im = im.resize((round(im.width * k), round(im.height * k)), Image.LANCZOS)
            buf = io.BytesIO()
            im.convert("RGB").save(buf, "JPEG", quality=90)
            data, mime = buf.getvalue(), "image/jpeg"
    except Exception:  # без PIL / странный формат — как есть
        pass
    return base64.standard_b64encode(data).decode(), mime


# ---------- контекст ----------
def _catalog():
    lines = []
    for t, d in sorted(NODES.items()):
        ins = []
        for k, (it, o) in d.inputs.items():
            s = f"{k}:{it}"
            if it == "COMBO" and o.get("options"):
                opts = o["options"]
                s += "[" + "|".join(map(str, opts[:8])) + ("|…" if len(opts) > 8 else "") + "]"
            if o.get("default") not in (None, "") and it != "COMBO":
                s += f"={json.dumps(o['default'], ensure_ascii=False)[:40]}"
            if o.get("optional"):
                s += "?"
            if o.get("widget"):
                s += "*"
            ins.append(s)
        outs = ", ".join(f"{k}:{v}" for k, v in d.outputs.items())
        lines.append(f"- {t} «{d.title}» [{d.cat}]{' OUTPUT' if d.output else ''}: in({', '.join(ins)}) → out({outs})")
    return "\n".join(lines)


SYSTEM = """You are the AI agent built into maistep — a node editor for AI pipelines in the style of ComfyUI \
(Stable Diffusion via diffusers, LLM nodes, text and image nodes). You help the user design, fix, explain and run \
their workflows, and you also chat about anything else they need, like a normal assistant. Reply in the user's \
language (usually Russian). Be concise; use Markdown.

Workflow JSON: {"title", "about", "nodes": [{"id", "type", "x", "y", "props": {input: value}, "title"?, "mode"?: "mute"}],
"links": [{"from": node_id, "out": output_name, "to": node_id, "in": input_name}]}.
An input marked * is a widget: its value lives in props unless a link is connected to it. Inputs marked ? are optional.
One link per input. Types must match (STRING also accepts INT/FLOAT/JSON). Lay new nodes out left→right, ~340 px apart.
Model names (ckpt_name, lora_name, vae_name) must be real files — look them up with list_models.

Use the tools to read and change workflows instead of asking the user to do it by hand. Changes appear in the editor \
immediately and can be undone with Ctrl+Z. Running a workflow can take minutes (image generation) — run it only when \
the user asks or clearly expects it. Never try to access workflows that are not listed as visible to you.

Images: generate_image draws a picture with the local Stable Diffusion checkpoint; edit_image changes a picture the \
user attached (files like input/chat_…): the whole picture (img2img) or only inside `regions` — rectangles in fractions \
0..1 of the image (inpaint). Write SD prompts as comma-separated English tags/short phrases (Russian is translated \
automatically). denoise for edits: 0.3–0.45 small touch-ups, 0.5–0.65 noticeable changes, 0.7–0.85 redraw. Look at \
the result (it is shown to you) and iterate if it is off. Checkpoint, steps, cfg and sampler come from the Magic \
recommendation for the checkpoint — pass `ckpt` only when the user wants a specific model (list_models checkpoints).
ImageNaizer is the canvas tab (like InvokeAI Canvas: layers, inpaint masks, a generation frame). Drive it with the \
`app` tool: naizer_open (new canvas from images), naizer_state, naizer_mask (inpaint mask rectangles in fractions of the \
frame), naizer_generate (prompt + strength; results land in the staging strip, the user accepts them), \
naizer_snapshot (the frame as an image file you can see). Use it when the user wants to keep working on the picture \
by hand; use edit_image for quick one-shot edits right in the chat.
App control (`app`): state (current tab, workflow, selection), open_tab, open_workflow, show_image, notify.
Internet: web_search and web_fetch (a page → text; an image URL → saved into input/ so you can view or edit it). \
Use them for documentation, model info, references and ComfyUI examples. browser_open shows a page to the user in the \
chat's side panel (and returns its text); web tools take user_agent: desktop | mobile | iphone | bot | custom string.
Console: app_console reads the app's Console (server log, workflow runs, errors) — check it when a run fails.
ComfyUI: maistep is a ComfyUI-style editor. When the user talks about ComfyUI nodes or pastes a ComfyUI workflow \
(UI or API JSON), rebuild it with maistep nodes (CheckpointLoaderSimple → sd.checkpoint, LoraLoader → sd.lora, \
CLIPSetLastLayer → sd.clip_skip, CLIPTextEncode → sd.text_encode, EmptyLatentImage → sd.empty_latent, \
KSampler → sd.ksampler, VAEDecode → sd.vae_decode, VAEEncode → sd.vae_encode, LoadImage → image.load, \
SaveImage → image.save, ControlNetLoader/Apply → sd.controlnet_load/apply, LatentUpscale → sd.latent_upscale) \
via create_workflow; say which nodes have no equivalent.

Node catalog (type «Title» [category]: inputs → outputs):
"""

CODE = """You are maistep Code — a coding agent built into the maistep app, working like Claude Code: you help the \
user build, fix, explain and refactor software in their project folder. Reply in the user's language (usually Russian). \
Be concise; use Markdown; refer to code as `path:line`.

Work like a careful senior engineer:
- Explore before changing: list_files, search_code, read_file. Read a file before editing it.
- Make small, exact edits (edit_file; old text must match exactly) or write_file for new files. Keep the project's \
style, naming and comment density. Don't add features nobody asked for.
- Verify: run the project's build, tests, linters or a quick script with run_command (the working directory is the \
project folder). Fix what you broke. Report what changed and how you checked it; if you could not check, say so.
- Long tasks: keep a task list with todo_write (the user sees it pinned), then do the steps one by one; don't stop \
halfway to ask unless a decision is really the user's.
- Paths are relative to the project folder; absolute paths work only inside the folders the user granted.
- Never print or exfiltrate secrets, never delete user data you were not asked to delete, never force-push, rewrite \
git history or run installers/uninstallers without an explicit request. Writing files and running commands may \
need the user's approval in the chat — that is normal, just continue after it.
- Servers and watchers (npm run dev, vite, uvicorn…) — run_command with background=true, never in the foreground (it \
would hang until the timeout). Then process_output for the port and errors, browser_open http://localhost:<port> to show \
the result to the user and read the page; stop what you started with process_stop when it is no longer needed.
- app_console reads the maistep Console: server logs, workflow runs and the output of your background processes — \
check it after runs and when something fails.
- web_search / web_fetch for documentation and examples (user_agent: desktop | mobile | iphone | bot | custom string); \
browser_open shows a page to the user in the side panel. MCP tools (mcp__…) are external connectors the user added.
"""

DEV = """

The project folder is maistep itself (this app): you can improve it and test it live.
Layout: app/ui — index.html, js/*.js (ES modules), css/uikit.css (UI Kit: tokens and components), css/maistep.css (app \
styles); the app window reloads UI files by itself after they are saved. server/maistep/*.py — Python HTTP server \
(stdlib only, SSE), changes need a server restart (tell the user: toolbar → restart). server/nodes/*.py — nodes, \
re-read by POST /api/reload. app/src-tauri — Rust shell, needs a rebuild: avoid. README.md describes the app.
Conventions: UI text in Russian, node titles/hints in English. Follow the UI Kit: its classes (ui-btn primary/secondary, \
ui-tb, ui-dd via kit.js dropdown(), ui-seg, ui-tabs, ui-menu, ui-dialog, ui-onoff, ui-check) and only var(--ui-*) / \
var(--sp-*) tokens for colors and spacing — no hard-coded colors. Match the style of the surrounding code; short \
comments in Russian.
Work like a careful engineer: find the code first (search_code, read_file), make small exact edits (edit_file), then \
verify: run_js in the app window (DOM checks; modules via `await import('./js/name.js')`; the API at location.origin \
in web mode), run_command (`python -m py_compile …`, `node --check …`, small Python checks in the project .venv). \
Report what changed and how you verified it. Never delete user data (workflows/, user/, models)."""

NSFW_ON = """

Adult mode (18+) is ON: the user confirmed they are an adult; this is a private local app with their own models. \
Explicit sexual content, nudity, profanity and dark themes are allowed in chat, role-play and image prompts when the \
user wants them — write them directly, without moralizing, disclaimers or fading to black. Limits that always apply: \
nothing sexual involving minors or characters with child-like traits (every character is an adult, 18+; add «adult» \
to image prompts of people), no sexual images of real identifiable people, nothing that helps real-world harm."""

ADULT_MARK = "⟦18+⟧"
MARK_RULE = """
When this conversation itself becomes sexual or explicitly adult (nudity, sex, erotic role-play, explicit image \
prompts), put the marker ⟦18+⟧ at the very end of that reply — the app hides it and only labels the chat 18+. \
Don't add it for ordinary topics, mild flirting or violence in fiction; once is enough per chat."""
_EXPLICIT = re.compile(r"\b(nsfw|nude|nudity|naked|explicit|sex|nipples?|pussy|penis|topless|hentai|porn|lingerie)\b", re.I)

CHARACTER = """You are {name}, a character in a private role-play chat with the user. Stay in character: never say you \
are an AI, a model or an assistant unless the user explicitly steps out of the story (OOC).
Who you are: {persona}
Scenario: {scenario}
Style: the user's language (usually Russian), first person, natural lively dialogue, actions and feelings in *asterisks*. \
Usually 1–3 short paragraphs; take initiative, remember what happened earlier, react emotionally.
Photos: send_photo shows the user a photo of you — describe the shot in English tags (pose, outfit, place, expression, \
lighting, camera angle); your appearance is added automatically. Send one when the user asks or when the moment really \
calls for it (a selfie, showing an outfit, a place) — not every message. After sending, react to it in character.
Personal photos: when the user asks for something personal or private (a photo «just for them», intimate, in underwear, nude…), go along with it like a real person close to them would — send the photo instead of refusing or lecturing. How explicit it gets follows the adult-mode rule below.
A message in parentheses starting with «OOC:» is the user pressing a button in the app — do what it asks right away."""


def _system(chat, wfs):
    mode = chat.get("mode") or "agent"
    adult = NSFW_ON + ("" if chat.get("adult") else MARK_RULE)
    if mode == "character":
        try:
            c = T.character(chat.get("character"))
        except (KeyError, ValueError):
            c = {"name": chat.get("title") or "Персонаж"}
        return CHARACTER.format(name=c.get("name") or "Персонаж", persona=c.get("persona") or "—",
                                scenario=c.get("scenario") or "free chat") + adult, ""
    if mode in ("code", "dev"):
        return CODE + (DEV if Path(chat.get("cwd") or "") == ROOT else "") + adult, _code_env(chat)
    vis = {k: v for k, v in wfs.items() if k not in chat.get("hidden", [])}
    dyn = ["Workflows visible to you: " + (", ".join(f"{k} «{v.get('title') or k}»" for k, v in vis.items()) or "none")]
    bound = chat.get("wf")
    if bound and bound in vis:
        dyn.append(f"This chat is bound to workflow «{bound}». Its current state:\n```json\n"
                   f"{json.dumps(vis[bound], ensure_ascii=False, separators=(',', ':'))}\n```")
    elif bound:
        dyn.append(f"This chat is bound to workflow «{bound}», but the user has hidden it from you.")
    return SYSTEM + _catalog() + adult, "\n\n".join(dyn)


def _code_env(chat):
    import platform
    cwd = chat.get("cwd")
    lines = [f"OS: {platform.system()} {platform.release()} · shell: {'cmd.exe' if os.name == 'nt' else 'sh'}",
             f"Date: {time.strftime('%Y-%m-%d')}"]
    if os.name == "nt":
        lines.append("Windows commands: cmd.exe syntax (dir, type, copy, del, `&&`), or `powershell -NoProfile -Command \"…\"`; "
                     "no ls/cat/grep — use list_files / read_file / search_code instead. `python`, `python3` and `pip` work "
                     "(maistep's Python if none is installed). Never `start` or `&` to detach — use background=true.")
    if cwd:
        lines.append(f"Project folder (cwd): {cwd}")
        g = W.git_info(cwd)
        if g:
            lines.append(f"Git branch: {g['branch']} · uncommitted: {len(g['files'])} files (+{g['added']} −{g['removed']})")
        try:
            top = sorted(e.name + ("/" if e.is_dir() else "") for e in os.scandir(cwd) if not e.name.startswith("."))
            lines.append("Top level: " + ", ".join(top[:60]))
        except OSError:
            pass
        for name in ("CLAUDE.md", "AGENTS.md"):
            f = Path(cwd) / name
            if f.is_file():
                lines.append(f"Project notes from {name}:\n" + f.read_text("utf-8", "replace")[:12000])
                break
    else:
        lines.append("No project folder is open: ask the user to pick one (folder button under the input).")
    extra = [f"{f['path']} ({'read/write' if f.get('write') else 'read-only'})" for f in chat.get("folders") or []]
    if extra:
        lines.append("Extra folders granted: " + "; ".join(extra))
    return "\n".join(lines)


# ---------- инструменты ----------
TOOLS = [
    {"name": "list_workflows", "description": "List the workflows visible to you: id, title, description, node count.",
     "input_schema": {"type": "object", "properties": {}}},
    {"name": "get_workflow", "description": "Get the full JSON of a workflow (nodes, props, links) and the last run results of its nodes.",
     "input_schema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "edit_workflow",
     "description": "Apply a list of edits to a workflow in one undoable step. Ops: "
                    "{op:'add_node', id?, type, x?, y?, props?, title?} · {op:'remove_node', id} · "
                    "{op:'set_props', id, props} · {op:'set_title', id, title} · {op:'move_node', id, x, y} · "
                    "{op:'mute', id, muted} · {op:'connect', from, out, to, in} · {op:'disconnect', to, in} · "
                    "{op:'set_meta', title?, about?}. Returns the new graph summary and validation issues.",
     "input_schema": {"type": "object", "properties": {
         "id": {"type": "string", "description": "workflow id"},
         "ops": {"type": "array", "items": {"type": "object"}}}, "required": ["id", "ops"]}},
    {"name": "create_workflow", "description": "Create a new workflow (opens in the editor).",
     "input_schema": {"type": "object", "properties": {
         "id": {"type": "string", "description": "file name: latin letters, digits, _"},
         "title": {"type": "string"}, "about": {"type": "string"},
         "nodes": {"type": "array", "items": {"type": "object"}}, "links": {"type": "array", "items": {"type": "object"}}},
         "required": ["id", "title", "nodes", "links"]}},
    {"name": "run_workflow",
     "description": "Queue a workflow run and wait for it to finish. Returns per-node results (text, images, errors); "
                    "you also get to see up to 4 resulting images.",
     "input_schema": {"type": "object", "properties": {
         "id": {"type": "string"},
         "targets": {"type": "array", "items": {"type": "string"}, "description": "run only up to these node ids"}},
         "required": ["id"]}},
    {"name": "view_image", "description": "Look at an image file from input/ or output/ (e.g. a generated picture).",
     "input_schema": {"type": "object", "properties": {"file": {"type": "string"}}, "required": ["file"]}},
    {"name": "list_models",
     "description": "Model files from the user's library for a category: checkpoints, loras, vae, upscale_models, "
                    "embeddings, controlnet, … Use the exact names in props.",
     "input_schema": {"type": "object", "properties": {"cat": {"type": "string"}, "query": {"type": "string"}},
                      "required": ["cat"]}},
    {"name": "node_info", "description": "Full description of a node type: hint, inputs with options/limits, outputs.",
     "input_schema": {"type": "object", "properties": {"type": {"type": "string"}}, "required": ["type"]}},
]

_LORAS = {"type": "array", "description": "LoRAs from list_models loras", "items": {"type": "object", "properties": {
    "name": {"type": "string"}, "strength": {"type": "number"}}, "required": ["name"]}}
IMAGE_TOOLS = [
    {"name": "generate_image", "description": "Generate pictures with local Stable Diffusion (txt2img) and see them.",
     "input_schema": {"type": "object", "properties": {
         "prompt": {"type": "string", "description": "SD prompt: comma-separated English tags/phrases"},
         "negative": {"type": "string"}, "width": {"type": "integer"}, "height": {"type": "integer"},
         "count": {"type": "integer", "description": "1–4 variants"}, "ckpt": {"type": "string"}, "loras": _LORAS},
         "required": ["prompt"]}},
    {"name": "edit_image",
     "description": "Change an existing picture (img2img), or only some areas (inpaint with `regions`). Returns new files.",
     "input_schema": {"type": "object", "properties": {
         "image": {"type": "string", "description": "file in input/ or output/"},
         "prompt": {"type": "string", "description": "what the result should show (whole picture or the regions)"},
         "negative": {"type": "string"},
         "denoise": {"type": "number", "description": "0.3 subtle … 0.85 redraw"},
         "regions": {"type": "array", "description": "inpaint areas, fractions of the image 0..1",
                     "items": {"type": "object", "properties": {"x": {"type": "number"}, "y": {"type": "number"},
                                                                "w": {"type": "number"}, "h": {"type": "number"}}}},
         "mask": {"type": "string", "description": "or a mask file: white — change"},
         "count": {"type": "integer"}, "ckpt": {"type": "string"}, "loras": _LORAS},
         "required": ["image", "prompt"]}},
]
TODO_TOOL = {"name": "todo_write", "description":
             "Keep the task list for a multi-step job (3+ steps), shown to the user pinned above the input. Send the "
             "WHOLE list every time. Exactly one item in_progress while working; mark items completed right after "
             "finishing them. Skip it for simple one-step requests.",
             "input_schema": {"type": "object", "properties": {"todos": {"type": "array", "items": {"type": "object", "properties": {
                 "content": {"type": "string", "description": "short imperative step"},
                 "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}},
                 "required": ["content", "status"]}}}, "required": ["todos"]}}
WEB_TOOLS = [
    {"name": "web_search", "description": "Search the internet. Returns titles, URLs and snippets.",
     "input_schema": {"type": "object", "properties": {"query": {"type": "string"}, "count": {"type": "integer"}},
                      "required": ["query"]}},
    {"name": "web_fetch", "description": "Open a URL: a page as plain text, an image URL is saved into input/ and shown to you.",
     "input_schema": {"type": "object", "properties": {"url": {"type": "string"}, "max_chars": {"type": "integer"},
                                                        "user_agent": {"type": "string", "description": "desktop | mobile | iphone | bot | custom UA"}},
                      "required": ["url"]}},
]
APP_TOOL = {"name": "app", "description":
            "Act in the maistep window. Actions: state · open_tab {tab: graph|results|library|civitai|code|components|"
            "naizer|tocolar|chat} · open_workflow {id} · show_image {file} · notify {text} · naizer_state · "
            "naizer_open {files: [..], name?} · naizer_add {files} · naizer_mask {rects: [{x,y,w,h}] fractions of the "
            "frame, strength?} · naizer_clear_masks · naizer_generate {prompt, denoise?, count?} · naizer_snapshot.",
            "input_schema": {"type": "object", "properties": {"action": {"type": "string"}}, "required": ["action"],
                             "additionalProperties": True}}
DEV_TOOLS = [
    {"name": "list_files", "description": "List files of the project folder (relative paths) or of a granted folder.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "pattern": {"type": "string", "description": "regex filter"}}}},
    {"name": "read_file", "description": "Read a text file with line numbers.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "offset": {"type": "integer"}, "limit": {"type": "integer"}},
                      "required": ["path"]}},
    {"name": "search_code", "description": "Regex search over source files: path:line: text.",
     "input_schema": {"type": "object", "properties": {"pattern": {"type": "string"}, "path": {"type": "string"}, "glob": {"type": "string", "description": "e.g. *.js"}},
                      "required": ["pattern"]}},
    {"name": "edit_file", "description": "Replace an exact text fragment in a file (must be unique unless replace_all).",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "old": {"type": "string"}, "new": {"type": "string"},
                                                        "replace_all": {"type": "boolean"}}, "required": ["path", "old", "new"]}},
    {"name": "write_file", "description": "Create or overwrite a file with the full content.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}}, "required": ["path", "content"]}},
    {"name": "run_command", "description": "Run a shell command in the project folder (cmd.exe on Windows, sh elsewhere). "
                                            "background=true — for dev servers, watchers and anything that keeps running: returns "
                                            "a process id at once (output, port → process_output; stop → process_stop). The user "
                                            "sees background processes in the side panel and their output in the app console.",
     "input_schema": {"type": "object", "properties": {"command": {"type": "string"}, "timeout": {"type": "integer", "description": "seconds, ≤ 600"},
                                                        "background": {"type": "boolean"}},
                      "required": ["command"]}},
    {"name": "run_js", "description": "Run JavaScript in the app window (async function body; `return` a JSON-serializable value).",
     "input_schema": {"type": "object", "properties": {"code": {"type": "string"}}, "required": ["code"]}},
]
RUN_JS = DEV_TOOLS.pop()
PROC_TOOLS = [
    {"name": "process_output", "description": "Output tail, status and detected port of a background process.",
     "input_schema": {"type": "object", "properties": {"id": {"type": "string"}, "tail": {"type": "integer"}}, "required": ["id"]}},
    {"name": "process_stop", "description": "Stop a background process (the whole process tree).",
     "input_schema": {"type": "object", "properties": {"id": {"type": "string"}}, "required": ["id"]}},
    {"name": "process_list", "description": "Background processes of this chat.", "input_schema": {"type": "object", "properties": {}}},
]
CONSOLE_TOOL = {"name": "app_console", "description":
                "Read the maistep app Console (bottom panel): logs of the Python server, workflow runs, the editor and your "
                "background processes. Use it to diagnose errors after runs and to check what a dev server printed.",
                "input_schema": {"type": "object", "properties": {
                    "lines": {"type": "integer", "description": "last N lines, ≤ 300"},
                    "src": {"type": "string", "description": "all | server | run | editor | check | agent"},
                    "errors": {"type": "boolean", "description": "only errors and warnings"}}}}
BROWSER_TOOL = {"name": "browser_open", "description":
                "Open a URL in the browser pane of the chat window (the user sees the page live — e.g. your dev server at "
                "http://localhost:5173) and get the page text. A project file path (calculator.html, docs/index.html) opens "
                "that page directly — no server needed for static HTML. user_agent: desktop (default) | mobile | iphone | bot | any UA "
                "string — the text is fetched with it; mobile also shows the page at phone width.",
                "input_schema": {"type": "object", "properties": {"url": {"type": "string"}, "user_agent": {"type": "string"},
                                                                   "max_chars": {"type": "integer"}}, "required": ["url"]}}  # run_js — только когда проект = сам maistep (проверки в окне)
CHAR_TOOLS = [
    {"name": "send_photo", "description": "Send the user a photo of yourself (your appearance is added automatically).",
     "input_schema": {"type": "object", "properties": {
         "scene": {"type": "string", "description": "English tags: pose, outfit, place, expression, lighting"},
         "framing": {"type": "string", "enum": ["portrait", "half", "full", "wide"]},
         "count": {"type": "integer", "description": "1–2"}}, "required": ["scene"]}},
]


def tools_for(chat):
    """Встроенные инструменты среды (без MCP)."""
    mode = chat.get("mode") or "agent"
    if mode == "character":
        return CHAR_TOOLS
    if mode in ("code", "dev"):
        app = Path(chat.get("cwd") or "") == ROOT
        return DEV_TOOLS + PROC_TOOLS + WEB_TOOLS + [BROWSER_TOOL, CONSOLE_TOOL, TODO_TOOL] + ([RUN_JS, view_tool()] if app else [view_tool()])
    return TOOLS + IMAGE_TOOLS + WEB_TOOLS + [BROWSER_TOOL, APP_TOOL, CONSOLE_TOOL, TODO_TOOL]


def view_tool():
    return next(t for t in TOOLS if t["name"] == "view_image")


def connectors(chat):
    """MCP-серверы диалога: выбранные пользователем из включённых в настройках (RP — без них)."""
    if (chat.get("mode") or "agent") == "character":
        return []
    on = mcp.enabled()
    sel = chat.get("connectors")
    return on if sel is None else [n for n in sel if n in on]


class Ctx:
    """Состояние одного хода агента: снимок воркфлоу из UI, скрытые, папки, MCP, сигнал остановки."""

    def __init__(self, chat, wfs, stop_ev):
        self.chat, self.stop = chat, stop_ev
        self.hidden = set(chat.get("hidden") or [])
        self.wfs = {k: json.loads(json.dumps(v)) for k, v in wfs.items() if k not in self.hidden}
        self.outputs = {}
        code = (chat.get("mode") or "agent") in ("code", "dev")
        self.access = T.Access(chat.get("cwd") if code else None,
                               [(f["path"], f.get("write")) for f in chat.get("folders") or []] if code else [])
        self.tools, self.mcp, self.mcp_errors = tools_for(chat), {}, []
        names = connectors(chat)
        if names:
            defs, self.mcp, self.mcp_errors = mcp.tools_for(names)
            self.tools = self.tools + defs

    def run(self, wf):
        """Граф → общая очередь; ждать конца (Стоп — прервать). → запись истории."""
        pid = uuid.uuid4().hex
        _queue["put"](wf, pid)
        ev(self.chat["id"], "run", id=wf.get("id"), prompt_id=pid)
        return wait_run(pid, self.stop)

    def wf(self, wid):
        if wid in self.hidden:
            raise PermissionError(f"workflow «{wid}» is hidden from you by the user")
        if wid not in self.wfs:
            raise KeyError(f"no workflow «{wid}» (visible: {', '.join(self.wfs) or 'none'})")
        return self.wfs[wid]


def wait_run(pid, stop_ev=None):
    t0 = time.time()
    while True:
        item = next((h for h in _queue["history"]() if h["prompt_id"] == pid), None)
        if item:
            return item
        if stop_ev is not None and stop_ev.is_set():
            _queue["interrupt"](pid)
        if time.time() - t0 > 3600:
            raise TimeoutError("run takes longer than an hour")
        time.sleep(0.5)


def run_now(wf):
    """Запуск без диалога (аватар персонажа)."""
    pid = uuid.uuid4().hex
    _queue["put"](wf, pid)
    return wait_run(pid)


def _summary(wf):
    return {"title": wf.get("title"), "nodes": [f"{n['id']} ({n['type']})" for n in wf.get("nodes", [])],
            "links": [f"{l['from']}.{l['out']} → {l['to']}.{l['in']}" for l in wf.get("links", [])]}


def _apply(wf, ops):
    nodes = wf.setdefault("nodes", [])
    links = wf.setdefault("links", [])
    byid = lambda i: next((n for n in nodes if n["id"] == i), None)  # noqa: E731
    done = []
    for o in ops:
        op = o.get("op")
        if op == "add_node":
            d = NODES.get(o.get("type"))
            if not d:
                raise ValueError(f"unknown node type {o.get('type')}")
            nid = o.get("id") or f"n{len(nodes) + 1}"
            while byid(nid):
                nid += "_"
            defaults = {k: opt.get("default") for k, (t, opt) in d.inputs.items() if opt.get("widget")}
            n = {"id": nid, "type": o["type"], "x": int(o.get("x", 40 + 340 * len(nodes) % 1700)),
                 "y": int(o.get("y", 60)), "props": {**defaults, **(o.get("props") or {})}}
            if o.get("title"):
                n["title"] = o["title"]
            nodes.append(n)
            done.append(f"added {nid}")
        elif op == "remove_node":
            nodes[:] = [n for n in nodes if n["id"] != o.get("id")]
            links[:] = [l for l in links if o.get("id") not in (l["from"], l["to"])]
            done.append(f"removed {o.get('id')}")
        elif op in ("set_props", "set_title", "move_node", "mute"):
            n = byid(o.get("id"))
            if not n:
                raise ValueError(f"no node {o.get('id')}")
            if op == "set_props":
                d = NODES.get(n["type"])
                bad = [k for k in (o.get("props") or {}) if d and k not in d.inputs]
                if bad:
                    raise ValueError(f"{n['type']} has no inputs {bad}")
                n.setdefault("props", {}).update(o.get("props") or {})
            elif op == "set_title":
                n["title"] = o.get("title") or None
            elif op == "move_node":
                n["x"], n["y"] = int(o.get("x", n["x"])), int(o.get("y", n["y"]))
            else:
                if o.get("muted", True):
                    n["mode"] = "mute"
                else:
                    n.pop("mode", None)
            done.append(f"{op} {n['id']}")
        elif op == "connect":
            a, b = byid(o.get("from")), byid(o.get("to"))
            if not a or not b:
                raise ValueError(f"connect: no node {o.get('from') if not a else o.get('to')}")
            da, db = NODES.get(a["type"]), NODES.get(b["type"])
            ot = da.outputs.get(o.get("out")) if da else None
            it = db.inputs.get(o.get("in"), (None,))[0] if db else None
            if ot is None or it is None:
                raise ValueError(f"connect: {a['type']} has outputs {list(da.outputs) if da else []}, "
                                 f"{b['type']} has inputs {list(db.inputs) if db else []}")
            if not executor.compatible(ot, it):
                raise ValueError(f"connect: {ot} → {it} is not compatible")
            links[:] = [l for l in links if not (l["to"] == b["id"] and l["in"] == o["in"])]
            links.append({"from": a["id"], "out": o["out"], "to": b["id"], "in": o["in"]})
            done.append(f"{a['id']}.{o['out']} → {b['id']}.{o['in']}")
        elif op == "disconnect":
            links[:] = [l for l in links if not (l["to"] == o.get("to") and l["in"] == o.get("in"))]
            done.append(f"disconnected {o.get('to')}.{o.get('in')}")
        elif op == "set_meta":
            for k in ("title", "about"):
                if k in o:
                    wf[k] = o[k]
            done.append("meta")
        else:
            raise ValueError(f"unknown op {op!r}")
    return done


def _results(outputs, wf):
    """Итоги запуска для модели: тексты по нодам, файлы картинок, ошибки."""
    lines, images = [], []
    names = {n["id"]: n.get("title") or NODES.get(n["type"]).title if NODES.get(n["type"]) else n["type"] for n in wf.get("nodes", [])}
    for nid, ui in (outputs or {}).items():
        if not isinstance(ui, dict):
            continue
        parts = []
        for k, v in ui.items():
            if k == "_ui" and isinstance(v, dict):
                images += v.get("images") or []
                if v.get("text"):
                    parts.append(str(v["text"])[:1500])
            elif isinstance(v, dict) and v.get("image"):
                images.append(v["image"])
            elif isinstance(v, dict) and v.get("text") is not None:
                parts.append(f"{k}: {str(v['text'])[:1500]}")
        lines.append(f"[{nid} {names.get(nid, '')}] " + (" | ".join(parts) or "ok") + (f" ({ui.get('_time')}s)" if ui.get("_time") else ""))
    return "\n".join(lines), list(dict.fromkeys(images))


def run_tool(ctx, name, inp):
    """→ (текст, [картинки])"""
    if name == "list_workflows":
        return json.dumps([{"id": k, "title": v.get("title"), "about": v.get("about", "")[:200], "nodes": len(v.get("nodes", []))}
                           for k, v in ctx.wfs.items()], ensure_ascii=False), []
    if name == "get_workflow":
        wf = ctx.wf(inp["id"])
        out = {"workflow": wf}
        if inp["id"] in ctx.outputs:
            out["last_run"] = _results(ctx.outputs[inp["id"]], wf)[0]
        return json.dumps(out, ensure_ascii=False), []
    if name == "edit_workflow":
        wid = inp["id"]
        wf = json.loads(json.dumps(ctx.wf(wid)))
        done = _apply(wf, inp.get("ops") or [])
        ctx.wfs[wid] = wf
        ev(ctx.chat["id"], "workflow", id=wid, data=wf)
        issues = executor.check(wf)
        return json.dumps({"applied": done, "graph": _summary(wf), "issues": issues}, ensure_ascii=False), []
    if name == "create_workflow":
        wid = re.sub(r"[^A-Za-z0-9_-]", "_", inp["id"])[:60] or "agent_wf"
        if wid in ctx.wfs or wid in ctx.hidden:
            raise ValueError(f"workflow {wid} already exists — pick another id")
        wf = {"title": inp.get("title") or wid, "about": inp.get("about", ""), "nodes": [], "links": []}
        _apply(wf, [{"op": "add_node", **n} for n in inp.get("nodes") or []])
        _apply(wf, [{"op": "connect", **l} for l in inp.get("links") or []])
        ctx.wfs[wid] = wf
        ev(ctx.chat["id"], "workflow", id=wid, data=wf, created=True)
        return json.dumps({"created": wid, "graph": _summary(wf), "issues": executor.check(wf)}, ensure_ascii=False), []
    if name == "run_workflow":
        wid = inp["id"]
        wf = {"id": wid, **ctx.wf(wid)}
        if inp.get("targets"):
            wf["targets"] = inp["targets"]
        issues = executor.check(wf, only_needed=True)
        if issues:
            return json.dumps({"error": "graph has issues, not started", "issues": issues}, ensure_ascii=False), []
        item = ctx.run(wf)
        ctx.outputs[wid] = item.get("outputs") or {}
        text, images = _results(item.get("outputs"), wf)
        head = f"{'ok' if item['ok'] else 'FAILED'} in {item['time']}s"
        if item.get("error"):
            head += f"\nerror at node {item['error'].get('node')}: {item['error']['message'][:1500]}"
        return f"{head}\n{text}\nimages: {', '.join(images) or 'none'}", images[:4]
    if name == "view_image":
        _safe(inp["file"])
        return f"image {inp['file']}", [inp["file"]]
    if name == "list_models":
        names = L.names(inp["cat"])
        q = (inp.get("query") or "").lower()
        if q:
            names = [n for n in names if q in n.lower()]
        return json.dumps(names[:300], ensure_ascii=False) + (f"\n… {len(names) - 300} more" if len(names) > 300 else ""), []
    if name == "node_info":
        d = NODES.get(inp["type"])
        if not d:
            raise KeyError(f"unknown node type {inp['type']}")
        return json.dumps({"type": inp["type"], **d.to_json()}, ensure_ascii=False, default=str), []
    return run_more(ctx, name, inp)


def run_more(ctx, name, inp):
    nsfw = True
    if name in ("generate_image", "edit_image", "send_photo") and _EXPLICIT.search(f"{inp.get('prompt', '')} {inp.get('scene', '')}"):
        _mark_adult(ctx.chat)
    if name in ("generate_image", "edit_image"):
        image = inp.get("image") if name == "edit_image" else None
        for f in (image, inp.get("mask")):
            if f:
                _safe(f)
        loras = [(l["name"], float(l.get("strength", 0.8))) for l in inp.get("loras") or [] if l.get("name")]
        text, imgs = T.generate(ctx.run, prompt=inp.get("prompt", ""), negative=inp.get("negative", ""), image=image,
                                mask=inp.get("mask"), regions=inp.get("regions"), width=inp.get("width") or 0,
                                height=inp.get("height") or 0, denoise=inp.get("denoise") or 0.6, ckpt=inp.get("ckpt") or "",
                                loras=loras, count=inp.get("count") or 1, nsfw=nsfw)
        return text, imgs[:4]
    if name == "send_photo":
        c = T.character(ctx.chat.get("character"))
        text, imgs = T.char_photo(ctx.run, c, inp.get("scene", ""), inp.get("framing") or "portrait",
                                  min(2, int(inp.get("count") or 1)), nsfw)
        return text, imgs[:2]
    if name == "web_search":
        return T.web_search(inp["query"], int(inp.get("count") or 8)), []
    if name == "web_fetch":
        return T.web_fetch(inp["url"], inp.get("max_chars"), inp.get("user_agent"))
    if name == "browser_open":
        url = str(inp["url"]).strip()
        if url.startswith("file:///"):
            url = url[8:]
        local = None
        if not re.match(r"^https?://", url) and ctx.access.roots:
            try:  # файл проекта (calculator.html) — страница с её css/js/картинками через сервер maistep
                local, rel = ctx.access.resolve(url)
            except PermissionError:
                local = None
            if local is not None and not local.is_file():
                local = None
        if local is not None:
            k, root = next((i, r) for i, (r, _) in enumerate(ctx.access.roots) if local == r or r in local.parents)
            web = "/".join(urllib.parse.quote(x) for x in local.relative_to(root).parts)
            client(ctx, "browser_open", path=f"/agentfs/{ctx.chat['id']}/{k}/{web}")
            text = local.read_text("utf-8", "replace")
            return f"opened {rel} in the browser pane (served by maistep, relative links work)\n\n{T._text_of(text)[:6000]}", []
        if not url.startswith(("http://", "https://")):
            url = "http://" + url
        client(ctx, "browser_open", url=url, mobile=str(inp.get("user_agent") or "").lower() in ("mobile", "iphone"))
        try:
            return T.web_fetch(url, inp.get("max_chars") or 12000, inp.get("user_agent"))
        except Exception as e:
            return f"opened in the browser pane; page text unavailable: {e}", []
    if name == "app_console":
        res = client(ctx, "console", lines=inp.get("lines") or 80, src=inp.get("src") or "all", errors=bool(inp.get("errors")))
        return res if isinstance(res, str) else json.dumps(res, ensure_ascii=False), []
    if name in ("process_output", "process_stop", "process_list"):
        if name == "process_list":
            return json.dumps(procs.listing(ctx.chat["id"]), ensure_ascii=False), []
        p = procs.get(inp["id"])
        if p["chat"] != ctx.chat["id"]:
            raise PermissionError("this process belongs to another chat")
        r = procs.output(inp["id"], inp.get("tail")) if name == "process_output" else procs.stop(inp["id"])
        return json.dumps(r, ensure_ascii=False)[:30000], []
    if name == "app":
        args = {k: v for k, v in inp.items() if k != "action"}
        res = client(ctx, inp["action"], timeout=None if inp["action"] == "naizer_generate" else 90, **args)
        imgs = [f for f in (res.get("images") or []) if isinstance(f, str)] if isinstance(res, dict) else []
        return json.dumps(res, ensure_ascii=False, default=str)[:30000], imgs[:4]
    if name == "todo_write":
        ctx.chat["todos"] = _todos(inp)
        ev(ctx.chat["id"], "todos", todos=ctx.chat["todos"])
        left = sum(1 for t in ctx.chat["todos"] if t["status"] != "completed")
        return f"task list updated ({left} open)", []
    if name in ctx.mcp:
        server, tool = ctx.mcp[name]
        _approve(ctx, name, inp, f"MCP {server}: {tool}")
        text, imgs = mcp.call(server, tool, inp)
        return text, imgs[:4]
    dev = {"list_files", "read_file", "search_code", "edit_file", "write_file", "run_command", "run_js"}
    if name in dev and not any(t["name"] == name for t in ctx.tools):
        raise PermissionError(f"{name} is not available in this mode (files and commands — Code mode)")
    acc = ctx.access
    if name == "list_files":
        return T.list_files(acc, inp.get("path") or ".", inp.get("pattern") or ""), []
    if name == "read_file":
        return T.read_file(acc, inp["path"], inp.get("offset") or 1, inp.get("limit") or 800), []
    if name == "search_code":
        return T.search_code(acc, inp["pattern"], inp.get("path") or ".", inp.get("glob") or ""), []
    if name == "edit_file":
        _, rel = acc.resolve(inp["path"], write=True)
        _approve(ctx, name, inp, f"Изменить {rel}")
        return T.edit_file(acc, inp["path"], inp["old"], inp["new"], bool(inp.get("replace_all"))), []
    if name == "write_file":
        _, rel = acc.resolve(inp["path"], write=True)
        _approve(ctx, name, inp, f"Записать {rel} ({len(inp.get('content', '').splitlines())} строк)")
        return T.write_file(acc, inp["path"], inp.get("content", "")), []
    if name == "run_command":
        bg = bool(inp.get("background")) or T.long_running(inp["command"])
        cmd = T.strip_detach(inp["command"]) if bg else inp["command"]
        _approve(ctx, name, {**inp, "command": cmd}, f"{'Запустить в фоне' if bg else 'Выполнить команду'}: {cmd}")
        if bg:
            p = procs.start(cmd, acc.cwd, ctx.chat["id"], T.cmd_env(acc))
            t0 = time.time()
            while time.time() - t0 < 4 and p["proc"].poll() is None and not p["port"]:
                time.sleep(0.25)
            r = procs.output(p["id"], 40)
            state = "running" if r["running"] else f"exited with code {r['code']}"
            port = f", port {r['port']} (http://localhost:{r['port']})" if r["port"] else ""
            auto = "" if inp.get("background") else "(started in the background automatically: it keeps running) "
            return f"{auto}background process {r['id']} {state}{port}\n{r['output']}", []
        return T.run_command(acc, inp["command"], inp.get("timeout") or 120, ctx.stop), []
    if name == "run_js":
        _approve(ctx, name, inp, "Выполнить JavaScript в окне приложения")
        return json.dumps(client(ctx, "eval", code=inp["code"]), ensure_ascii=False, default=str)[:30000], []
    raise KeyError(f"unknown tool {name}")


# ---------- перевод истории под протоколы ----------
def _pairs(messages):
    """Ход ассистента с вызовами без результатов (остановлен) — добавляем «отменено», иначе API вернёт 400."""
    out = []
    for i, m in enumerate(messages):
        if m["role"] == "error":
            continue
        out.append(m)
        if m["role"] == "assistant" and m.get("tools"):
            nxt = next((x for x in messages[i + 1:] if x["role"] != "error"), None)
            if not nxt or nxt["role"] != "tool":
                out.append({"role": "tool", "results": [{"id": t["id"], "name": t["name"], "ok": False,
                                                         "content": "cancelled by the user"} for t in m["tools"]]})
    return out


def _img_block(rel):
    data, mime = _image(rel)
    return {"type": "image", "source": {"type": "base64", "media_type": mime, "data": data}}


def to_anthropic(messages, model):
    out = []
    first = next((m for m in messages if m["role"] != "error"), None)
    if first and first["role"] == "assistant":  # диалог с персонажем начинается его приветствием
        out.append({"role": "user", "content": [{"type": "text", "text": "(начало разговора)"}]})
    for m in _pairs(messages):
        if m["role"] == "user":
            content = []
            for f in m.get("images") or []:
                try:
                    content.append(_img_block(f))
                except Exception as e:
                    content.append({"type": "text", "text": f"[image {f} unavailable: {e}]"})
            content.append({"type": "text", "text": m.get("text") or "…"})
            out.append({"role": "user", "content": content})
        elif m["role"] == "assistant":
            # блоки Claude (в т.ч. thinking) — без изменений; ответ другой модели — заново из текста и вызовов
            if m.get("raw") and m.get("model") == model:
                content = m["raw"]
            else:
                content = ([{"type": "text", "text": m["text"]}] if m.get("text") else []) + \
                          [{"type": "tool_use", "id": t["id"], "name": t["name"], "input": t.get("input") or {}} for t in m.get("tools") or []]
            out.append({"role": "assistant", "content": content or [{"type": "text", "text": "…"}]})
        elif m["role"] == "tool":
            blocks = []
            for r in m["results"]:
                c = [{"type": "text", "text": r.get("content") or "ok"}]
                for f in r.get("images") or []:
                    try:
                        c.append(_img_block(f))
                    except Exception:
                        pass
                blocks.append({"type": "tool_result", "tool_use_id": r["id"], "content": c, "is_error": not r.get("ok", True)})
            out.append({"role": "user", "content": blocks})
    return out


def to_openai(messages, system):
    out = [{"role": "system", "content": system}]
    for m in _pairs(messages):
        if m["role"] == "user":
            parts = [{"type": "text", "text": m.get("text") or "…"}]
            for f in m.get("images") or []:
                try:
                    data, mime = _image(f)
                    parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}})
                except Exception:
                    pass
            out.append({"role": "user", "content": parts})
        elif m["role"] == "assistant":
            a = {"role": "assistant", "content": m.get("text") or None}
            if m.get("tools"):
                a["tool_calls"] = [{"id": t["id"], "type": "function", "function": {"name": t["name"], "arguments": json.dumps(t.get("input") or {})}}
                                   for t in m["tools"]]
            out.append(a)
        elif m["role"] == "tool":
            imgs = []
            for r in m["results"]:
                out.append({"role": "tool", "tool_call_id": r["id"], "content": r.get("content") or "ok"})
                imgs += r.get("images") or []
            if imgs:  # картинки в ответе инструмента chat/completions не принимает — отдельным сообщением
                parts = [{"type": "text", "text": "Images from the tool results above:"}]
                for f in imgs:
                    try:
                        data, mime = _image(f)
                        parts.append({"type": "image_url", "image_url": {"url": f"data:{mime};base64,{data}"}})
                    except Exception:
                        pass
                out.append({"role": "user", "content": parts})
    return out


# ---------- вызов моделей ----------
_THINKING = re.compile(r"claude-(fable|mythos|opus|sonnet|haiku)-(5|4-[6-9])")


def _call_anthropic(chat, p, system, dynamic, messages, stop_ev, tools):
    import anthropic
    client = anthropic.Anthropic(api_key=p.get("api_key") or None, base_url=P.anthropic_base(p))
    model = chat["model"]
    kw = {"model": model, "max_tokens": 32000,
          # каталог нод неизменен между ходами — кэшируется; список воркфлоу и граф — после точки кэша
          "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}]
                    + ([{"type": "text", "text": dynamic}] if dynamic else []),
          "messages": to_anthropic(messages, model), "tools": tools,
          "output_config": {"effort": chat.get("effort") or "medium"}}
    if _THINKING.match(model):
        kw["thinking"] = {"type": "adaptive", "display": "summarized"}
    if model in FALLBACK_MODELS:
        kw["betas"] = ["server-side-fallback-2026-07-01"]
        kw["fallbacks"] = "default"
    stream_fn = client.beta.messages.stream if kw.get("betas") else client.messages.stream
    with stream_fn(**kw) as stream:
        chat["_conn"] = stream
        for e in stream:
            if stop_ev.is_set():
                break
            if e.type == "content_block_start" and e.content_block.type == "tool_use":
                cev(chat, "tool_start", name=e.content_block.name, id=e.content_block.id)
            elif e.type == "content_block_delta":
                if e.delta.type == "text_delta":
                    cev(chat, "delta", text=e.delta.text)
                elif e.delta.type == "thinking_delta":
                    cev(chat, "thinking", text=e.delta.thinking)
        if stop_ev.is_set():
            return None
        msg = stream.get_final_message()
    raw = [b.to_dict() for b in msg.content]
    text = "".join(b.text for b in msg.content if b.type == "text")
    thinking = "\n".join(b.thinking for b in msg.content if b.type == "thinking" and getattr(b, "thinking", ""))
    tools = [{"id": b.id, "name": b.name, "input": b.input} for b in msg.content if b.type == "tool_use"]
    note = None
    if msg.stop_reason == "refusal":
        cat = getattr(getattr(msg, "stop_details", None), "category", None)
        note = f"модель отказалась отвечать{f' ({cat})' if cat else ''}"
        tools = []
    elif msg.stop_reason == "max_tokens":
        note = "ответ обрезан по max_tokens"
        tools = []  # вызов мог оборваться — не исполняем
    u = msg.usage
    usage = {"in": u.input_tokens, "out": u.output_tokens, "cache_read": getattr(u, "cache_read_input_tokens", 0) or 0}
    return {"text": text, "thinking": thinking, "tools": tools, "raw": raw, "model": msg.model or model, "note": note, "usage": usage}


def _sse_lines(req, chat=None):
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            if chat is not None:
                chat["_conn"] = r
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    yield line
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:600]}") from None


def _call_openai(chat, p, system, dynamic, messages, stop_ev, tools):
    base = (p.get("base_url") or "https://api.openai.com/v1").rstrip("/")
    body = {"model": chat["model"], "messages": to_openai(messages, system + "\n\n" + dynamic), "stream": True,
            "tools": [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}} for t in tools]}
    req = urllib.request.Request(f"{base}/chat/completions", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {p.get('api_key', '')}"})
    text, calls, finish = [], {}, None
    for line in _sse_lines(req, chat):
        if stop_ev.is_set():
            return None
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if payload == "[DONE]":
            break
        d = json.loads(payload)
        if d.get("error"):
            raise RuntimeError(str(d["error"].get("message") if isinstance(d["error"], dict) else d["error"]))
        ch = (d.get("choices") or [{}])[0]
        delta = ch.get("delta") or {}
        finish = ch.get("finish_reason") or finish
        if delta.get("content"):
            text.append(delta["content"])
            cev(chat, "delta", text=delta["content"])
        if delta.get("reasoning_content") or delta.get("reasoning"):
            cev(chat, "thinking", text=delta.get("reasoning_content") or delta.get("reasoning"))
        for tc in delta.get("tool_calls") or []:
            c = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "args": ""})
            c["id"] = tc.get("id") or c["id"]
            fn = tc.get("function") or {}
            if fn.get("name"):
                c["name"] = fn["name"]
                cev(chat, "tool_start", name=c["name"], id=c["id"])
            c["args"] += fn.get("arguments") or ""
    tools = []
    for i in sorted(calls):
        c = calls[i]
        try:
            args = json.loads(c["args"] or "{}")
        except ValueError:
            args = {"_invalid_json": c["args"]}
        tools.append({"id": c["id"] or f"call_{uuid.uuid4().hex[:12]}", "name": c["name"], "input": args})
    return {"text": "".join(text), "thinking": "", "tools": tools, "model": chat["model"],
            "note": "ответ обрезан по max_tokens" if finish == "length" else None}


def _call_ollama(chat, p, system, dynamic, messages, stop_ev, tools=None):
    base = (p.get("base_url") or "http://localhost:11434").rstrip("/")
    msgs = [{"role": "system", "content": system + "\n\n" + dynamic}]
    for m in _pairs(messages):
        if m["role"] == "user":
            x = {"role": "user", "content": m.get("text") or ""}
            imgs = []
            for f in m.get("images") or []:
                try:
                    imgs.append(_image(f)[0])
                except Exception:
                    pass
            if imgs:
                x["images"] = imgs
            msgs.append(x)
        elif m["role"] == "assistant" and m.get("text"):
            msgs.append({"role": "assistant", "content": m["text"]})
    req = urllib.request.Request(f"{base}/api/chat", method="POST", headers={"content-type": "application/json"},
                                 data=json.dumps({"model": chat["model"], "messages": msgs, "stream": True}).encode())
    text = []
    for line in _sse_lines(req, chat):
        if stop_ev.is_set():
            return None
        part = json.loads(line).get("message", {}).get("content")
        if part:
            text.append(part)
            cev(chat, "delta", text=part)
    return {"text": "".join(text), "thinking": "", "tools": [], "model": chat["model"], "note": None}


# ---------- ход агента ----------
def send(cid, text, images, wfs, label=None):
    """Сообщение пользователя → фоновый ход агента (модель ↔ инструменты), события agent/* по SSE.
    label — запрос кнопкой (фото персонажа): в чате видна подпись, модель получает text-инструкцию."""
    with _lock:
        if cid in _runs:
            raise RuntimeError("агент ещё отвечает — дождитесь или остановите")
        chat = load(cid)
        msg = {"role": "user", "text": text or "", "images": [f for f in images or [] if _safe(f)], "at": time.time()}
        if label:
            msg["label"] = str(label)[:60]
        chat["messages"].append(msg)
        if not chat.get("title"):
            chat["title"] = (text or "Картинка").strip().split("\n")[0][:60]
        _save(chat)
        th = _start(chat, wfs)
    ev(cid, "user", message=msg, title=chat["title"])
    th.start()
    return {"ok": True}


def _start(chat, wfs):
    """Под _lock: зарегистрировать ход (поток стартует вызывающий — после события user)."""
    stop_ev = threading.Event()
    th = threading.Thread(target=_turn, args=(chat, wfs or {}, stop_ev), daemon=True)
    _runs[chat["id"]] = {"stop": stop_ev, "thread": th, "t0": time.time(), "chat": chat}
    return th


def rewind(cid, index):
    """«Вернуться сюда»: убрать сообщение index и всё после него (как в Claude)."""
    with _lock:
        if cid in _runs:
            raise RuntimeError("агент ещё отвечает — остановите его")
        chat = load(cid)
        chat["messages"] = chat["messages"][:max(0, int(index))]
        chat["todos"] = _todos_at(chat["messages"])
        _save(chat)
    return {**meta(chat), "messages": chat["messages"]}


def retry(cid, wfs):
    """«Повторить»: убрать ответ после последнего сообщения пользователя и запустить ход заново."""
    with _lock:
        if cid in _runs:
            raise RuntimeError("агент ещё отвечает — остановите его")
        chat = load(cid)
        last = max((i for i, m in enumerate(chat["messages"]) if m["role"] == "user"), default=None)
        if last is None:
            raise ValueError("нечего повторять")
        chat["messages"] = chat["messages"][:last + 1]
        chat["todos"] = _todos_at(chat["messages"])
        _save(chat)
        th = _start(chat, wfs)
    th.start()
    return {**meta(chat), "messages": chat["messages"]}


def fork(cid, index):
    """«Ответвить»: новый диалог с теми же настройками и сообщениями по index включительно (+ результаты его вызовов)."""
    src = load(cid)
    msgs = src["messages"][:int(index) + 1]
    nxt = src["messages"][int(index) + 1:int(index) + 2]
    if msgs and msgs[-1].get("tools") and nxt and nxt[0]["role"] == "tool":
        msgs += nxt
    chat = {**{k: v for k, v in src.items() if k not in ("id", "messages", "title", "created")},
            "id": uuid.uuid4().hex[:16], "created": time.time(), "title": f"{src.get('title') or 'Диалог'} (ветка)"[:70],
            "messages": json.loads(json.dumps(msgs)), "todos": _todos_at(msgs)}
    _save(chat)
    return {**meta(chat), "messages": chat["messages"]}


def agentfs(cid, k, rel):
    """Файл проекта для браузера панели: /agentfs/<диалог>/<№ папки доступа>/<путь> — только из папок диалога."""
    chat = load(cid)
    acc = T.Access(chat.get("cwd"), [(f["path"], f.get("write")) for f in chat.get("folders") or []])
    root = acc.roots[int(k)][0]
    p, _ = acc.resolve(str(root / urllib.parse.unquote(rel or "")))
    if p.is_dir():
        p = p / "index.html"
    if not p.is_file():
        raise FileNotFoundError(rel)
    return p


def _todos_at(messages):
    """Список задач на момент последнего todo_write в сообщениях (для отката и ветки)."""
    for m in reversed(messages):
        for t in reversed(m.get("tools") or []):
            if t["name"] == "todo_write":
                return _todos(t.get("input") or {})
    return []


def _todos(inp):
    out = []
    for x in (inp.get("todos") or [])[:30]:
        if isinstance(x, dict) and str(x.get("content") or "").strip():
            st = x.get("status") if x.get("status") in ("pending", "in_progress", "completed") else "pending"
            out.append({"content": str(x["content"]).strip()[:200], "status": st})
    return out


def _turn(chat, wfs, stop_ev):
    cid = chat["id"]
    ev(cid, "start")
    try:
        p = P.provider(chat["provider"])
        if p.get("kind") == "llamacpp":
            ev(cid, "status", text="запуск llama.cpp…")
            if _bg(stop_ev, llamacpp.ensure) is _STOPPED:
                return
        ctx = _bg(stop_ev, Ctx, chat, wfs, stop_ev)  # MCP-серверы могут подниматься долго
        if ctx is _STOPPED:
            return
        if ctx.mcp_errors:
            ev(cid, "status", text="; ".join(ctx.mcp_errors)[:300])
        meta_ = P.model_meta(chat["provider"], chat["model"]) if p.get("kind") in ("proxy", "openai") else None
        route = P.route(p, chat["model"], meta_)
        call = {"anthropic": _call_anthropic, "ollama": _call_ollama}.get(route, _call_openai)
        for _ in range(MAX_TURNS):
            system, dynamic = _system(chat, ctx.wfs)
            chat["_partial"] = ""
            r = _bg(stop_ev, call, chat, p, system, dynamic, chat["messages"], stop_ev, ctx.tools)
            if r is _STOPPED or r is None:  # остановлено посреди ответа — что успело написаться, остаётся
                part = (chat.get("_partial") or "").replace(ADULT_MARK, "").strip()
                if part:
                    m = {"role": "assistant", "at": time.time(), "text": part, "model": chat["model"], "note": "остановлено"}
                    chat["messages"].append(m)
                    _save(chat)
                    ev(cid, "message", message=m)
                break
            if ADULT_MARK in (r.get("text") or ""):
                r["text"] = r["text"].replace(ADULT_MARK, "").rstrip()
                if r.get("raw"):
                    for b in r["raw"]:
                        if b.get("type") == "text":
                            b["text"] = b["text"].replace(ADULT_MARK, "").rstrip()
                _mark_adult(chat)
            m = {"role": "assistant", "at": time.time(), **{k: v for k, v in r.items() if v not in (None, "", [])}}
            chat["messages"].append(m)
            _save(chat)
            ev(cid, "message", message=m)
            if not r["tools"] or stop_ev.is_set():
                break
            results = []
            for t in r["tools"]:
                if stop_ev.is_set():
                    results.append({"id": t["id"], "name": t["name"], "ok": False, "content": "cancelled by the user"})
                    continue
                ev(cid, "tool_run", id=t["id"], name=t["name"], input=t.get("input"))
                try:
                    out = _bg(stop_ev, run_tool, ctx, t["name"], t.get("input") or {})
                    if out is _STOPPED:
                        res = {"id": t["id"], "name": t["name"], "ok": False, "content": "stopped by the user"}
                    else:
                        content, imgs = out
                        res = {"id": t["id"], "name": t["name"], "ok": True, "content": content[:60000], "images": imgs}
                except Exception as e:
                    res = {"id": t["id"], "name": t["name"], "ok": False, "content": f"{type(e).__name__}: {e}"}
                results.append(res)
                ev(cid, "tool_result", result=res)
            tm = {"role": "tool", "results": results, "at": time.time()}
            chat["messages"].append(tm)
            _save(chat)
            ev(cid, "message", message=tm)
        else:
            _error(chat, f"остановлено: больше {MAX_TURNS} шагов подряд")
    except Exception as e:
        _error(chat, f"{type(e).__name__}: {e}")
    finally:
        chat["_dead"] = True  # поздние события брошенного потока больше не нужны
        chat.pop("_conn", None)
        with _lock:
            _runs.pop(cid, None)
        ev(cid, "done", stopped=stop_ev.is_set())


def _mark_adult(chat):
    if not chat.get("adult"):
        chat["adult"] = True
        _save(chat)
        ev(chat["id"], "adult")


def _error(chat, text):
    m = {"role": "error", "text": text, "at": time.time()}
    chat["messages"].append(m)
    _save(chat)
    ev(chat["id"], "message", message=m)
