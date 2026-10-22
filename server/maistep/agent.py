"""AI Agent — чат в редакторе (как Claude), привязанный к воркфлоу.

Диалоги — user/chats/<id>.json: { id, title, created, updated, provider, model, effort, wf, hidden, messages }.
  wf      — воркфлоу, к которому привязан диалог (его граф уходит в контекст);
  hidden  — воркфлоу, которые агенту видеть нельзя (их нет ни в контексте, ни в инструментах).
Сообщения хранятся в нейтральном виде и переводятся под протокол провайдера (providers.route):
  user      { text, images: ["input/…"] }
  assistant { text, thinking, tools: [{ id, name, input }], raw — блоки Claude как есть (для повторной отправки) }
  tool      { results: [{ id, name, ok, content, images }] }
  error     { text } — в модель не уходит.
Граф правит клиент: агент получает снимок видимых воркфлоу из UI, а его правки уходят событием SSE agent/workflow
и применяются в редакторе обычной правкой (с отменой). Запуск — общая очередь сервера (configure → put/history).
Claude (Anthropic SDK) и OpenAI-совместимые модели — с инструментами; Ollama — простой чат.
"""
import base64
import io
import json
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from . import executor
from . import library as L
from . import providers as P
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
_lock = threading.Lock()


def configure(emitter, put, history, interrupt):
    global _emit
    _emit = emitter
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
        return json.loads(_path(cid).read_text("utf-8"))
    except OSError:
        raise KeyError(cid) from None


def _save(chat):
    CHATS.mkdir(parents=True, exist_ok=True)
    chat["updated"] = time.time()
    tmp = _path(chat["id"]).with_suffix(".tmp")
    tmp.write_text(json.dumps(chat, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(_path(chat["id"]))


def meta(chat):
    last = next((m for m in reversed(chat["messages"]) if m["role"] in ("user", "assistant") and m.get("text")), None)
    return {k: chat.get(k) for k in ("id", "title", "created", "updated", "provider", "model", "effort", "wf", "hidden")} | {
        "count": sum(1 for m in chat["messages"] if m["role"] == "user"),
        "last": (last or {}).get("text", "")[:140], "busy": chat["id"] in _runs}


def chats():
    out = []
    for p in CHATS.glob("*.json") if CHATS.is_dir() else []:
        try:
            out.append(meta(json.loads(p.read_text("utf-8"))))
        except (OSError, ValueError):
            continue
    return sorted(out, key=lambda c: c.get("updated") or 0, reverse=True)


def upsert(d):
    """Создать (без id) или поменять настройки диалога: title, provider, model, effort, wf, hidden."""
    if d.get("id"):
        chat = load(d["id"])
    else:
        prov = d.get("provider") or P.default_provider()
        chat = {"id": uuid.uuid4().hex[:16], "title": "", "created": time.time(), "provider": prov,
                "model": d.get("model") or "claude-opus-5-5", "effort": "medium", "wf": None, "hidden": [], "messages": []}
    for k in ("title", "provider", "model", "wf"):
        if k in d:
            chat[k] = d[k]
    if d.get("effort") in EFFORTS:
        chat["effort"] = d["effort"]
    if isinstance(d.get("hidden"), list):
        chat["hidden"] = sorted({str(x) for x in d["hidden"]})
    _save(chat)
    return {**meta(chat), "messages": chat["messages"]}


def delete(cid):
    stop(cid)
    _path(cid).unlink(missing_ok=True)
    return {"ok": True}


def stop(cid):
    r = _runs.get(cid)
    if r:
        r["stop"].set()
    return {"ok": True}


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

Node catalog (type «Title» [category]: inputs → outputs):
"""


def _system(chat, wfs):
    vis = {k: v for k, v in wfs.items() if k not in chat.get("hidden", [])}
    dyn = ["Workflows visible to you: " + (", ".join(f"{k} «{v.get('title') or k}»" for k, v in vis.items()) or "none")]
    bound = chat.get("wf")
    if bound and bound in vis:
        dyn.append(f"This chat is bound to workflow «{bound}». Its current state:\n```json\n"
                   f"{json.dumps(vis[bound], ensure_ascii=False, separators=(',', ':'))}\n```")
    elif bound:
        dyn.append(f"This chat is bound to workflow «{bound}», but the user has hidden it from you.")
    return SYSTEM + _catalog(), "\n\n".join(dyn)


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


class Ctx:
    """Состояние одного хода агента: снимок воркфлоу из UI, скрытые, сигнал остановки."""

    def __init__(self, chat, wfs, stop_ev):
        self.chat, self.stop = chat, stop_ev
        self.hidden = set(chat.get("hidden") or [])
        self.wfs = {k: json.loads(json.dumps(v)) for k, v in wfs.items() if k not in self.hidden}
        self.outputs = {}

    def wf(self, wid):
        if wid in self.hidden:
            raise PermissionError(f"workflow «{wid}» is hidden from you by the user")
        if wid not in self.wfs:
            raise KeyError(f"no workflow «{wid}» (visible: {', '.join(self.wfs) or 'none'})")
        return self.wfs[wid]


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
        pid = uuid.uuid4().hex
        _queue["put"](wf, pid)
        ev(ctx.chat["id"], "run", id=wid, prompt_id=pid)
        t0 = time.time()
        while True:
            item = next((h for h in _queue["history"]() if h["prompt_id"] == pid), None)
            if item:
                break
            if ctx.stop.is_set():
                _queue["interrupt"](pid)
            if time.time() - t0 > 3600:
                raise TimeoutError("run takes longer than an hour")
            time.sleep(0.5)
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


def _call_anthropic(chat, p, system, dynamic, messages, stop_ev):
    import anthropic
    client = anthropic.Anthropic(api_key=p.get("api_key") or None, base_url=P.anthropic_base(p))
    model = chat["model"]
    kw = {"model": model, "max_tokens": 32000,
          # каталог нод неизменен между ходами — кэшируется; список воркфлоу и граф — после точки кэша
          "system": [{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}},
                     {"type": "text", "text": dynamic}],
          "messages": to_anthropic(messages, model), "tools": TOOLS,
          "output_config": {"effort": chat.get("effort") or "medium"}}
    if _THINKING.match(model):
        kw["thinking"] = {"type": "adaptive", "display": "summarized"}
    if model in FALLBACK_MODELS:
        kw["betas"] = ["server-side-fallback-2026-07-01"]
        kw["fallbacks"] = "default"
    stream_fn = client.beta.messages.stream if kw.get("betas") else client.messages.stream
    with stream_fn(**kw) as stream:
        for e in stream:
            if stop_ev.is_set():
                break
            if e.type == "content_block_start" and e.content_block.type == "tool_use":
                ev(chat["id"], "tool_start", name=e.content_block.name, id=e.content_block.id)
            elif e.type == "content_block_delta":
                if e.delta.type == "text_delta":
                    ev(chat["id"], "delta", text=e.delta.text)
                elif e.delta.type == "thinking_delta":
                    ev(chat["id"], "thinking", text=e.delta.thinking)
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


def _sse_lines(req):
    try:
        with urllib.request.urlopen(req, timeout=900) as r:
            for raw in r:
                line = raw.decode("utf-8", "replace").strip()
                if line:
                    yield line
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:600]}") from None


def _call_openai(chat, p, system, dynamic, messages, stop_ev):
    base = (p.get("base_url") or "https://api.openai.com/v1").rstrip("/")
    body = {"model": chat["model"], "messages": to_openai(messages, system + "\n\n" + dynamic), "stream": True,
            "tools": [{"type": "function", "function": {"name": t["name"], "description": t["description"], "parameters": t["input_schema"]}} for t in TOOLS]}
    req = urllib.request.Request(f"{base}/chat/completions", data=json.dumps(body).encode(), method="POST",
                                 headers={"content-type": "application/json", "authorization": f"Bearer {p.get('api_key', '')}"})
    text, calls, finish = [], {}, None
    for line in _sse_lines(req):
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
            ev(chat["id"], "delta", text=delta["content"])
        if delta.get("reasoning_content") or delta.get("reasoning"):
            ev(chat["id"], "thinking", text=delta.get("reasoning_content") or delta.get("reasoning"))
        for tc in delta.get("tool_calls") or []:
            c = calls.setdefault(tc.get("index", 0), {"id": "", "name": "", "args": ""})
            c["id"] = tc.get("id") or c["id"]
            fn = tc.get("function") or {}
            if fn.get("name"):
                c["name"] = fn["name"]
                ev(chat["id"], "tool_start", name=c["name"], id=c["id"])
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


def _call_ollama(chat, p, system, dynamic, messages, stop_ev):
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
    for line in _sse_lines(req):
        if stop_ev.is_set():
            return None
        part = json.loads(line).get("message", {}).get("content")
        if part:
            text.append(part)
            ev(chat["id"], "delta", text=part)
    return {"text": "".join(text), "thinking": "", "tools": [], "model": chat["model"], "note": None}


# ---------- ход агента ----------
def send(cid, text, images, wfs):
    """Сообщение пользователя → фоновый ход агента (модель ↔ инструменты), события agent/* по SSE."""
    with _lock:
        if cid in _runs:
            raise RuntimeError("агент ещё отвечает — дождитесь или остановите")
        chat = load(cid)
        msg = {"role": "user", "text": text or "", "images": [f for f in images or [] if _safe(f)], "at": time.time()}
        chat["messages"].append(msg)
        if not chat.get("title"):
            chat["title"] = (text or "Картинка").strip().split("\n")[0][:60]
        _save(chat)
        stop_ev = threading.Event()
        th = threading.Thread(target=_turn, args=(chat, wfs or {}, stop_ev), daemon=True)
        _runs[cid] = {"stop": stop_ev, "thread": th}
    ev(cid, "user", message=msg, title=chat["title"])
    th.start()
    return {"ok": True}


def _turn(chat, wfs, stop_ev):
    cid = chat["id"]
    ctx = Ctx(chat, wfs, stop_ev)
    ev(cid, "start")
    try:
        p = P.provider(chat["provider"])
        meta_ = P.model_meta(chat["provider"], chat["model"]) if p.get("kind") in ("proxy", "openai") else None
        route = P.route(p, chat["model"], meta_)
        call = {"anthropic": _call_anthropic, "ollama": _call_ollama}.get(route, _call_openai)
        for _ in range(MAX_TURNS):
            system, dynamic = _system(chat, ctx.wfs)
            r = call(chat, p, system, dynamic, chat["messages"], stop_ev)
            if r is None:  # остановлено посреди ответа
                break
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
                    content, imgs = run_tool(ctx, t["name"], t.get("input") or {})
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
        with _lock:
            _runs.pop(cid, None)
        ev(cid, "done", stopped=stop_ev.is_set())


def _error(chat, text):
    m = {"role": "error", "text": text, "at": time.time()}
    chat["messages"].append(m)
    _save(chat)
    ev(chat["id"], "message", message=m)
