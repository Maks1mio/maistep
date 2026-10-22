"""MCP-сервер maistep (stdio, JSON-RPC 2.0, только стандартная библиотека).

    python mcp/maistep_mcp.py            # транспорт stdio для Claude Desktop / Kilo / Cursor
    python mcp/maistep_mcp.py --selftest # проверить связь с сервером maistep

Подключение (пример для kilo.json):
    "mcp": {"maistep": {"type": "local", "command": ["python", "mcp/maistep_mcp.py"]}}

Инструменты работают с запущенным Python-сервером maistep (по умолчанию http://127.0.0.1:3300,
переменная MAISTEP_URL): каталог нод, воркфлоу, очередь, запуск, библиотека моделей, компоненты.
Воркфлоу читаются из <проект>/workflows; запуск и результаты — через HTTP API сервера.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BASE = os.environ.get("MAISTEP_URL", "http://127.0.0.1:3300").rstrip("/")
PROTOCOL = "2024-11-05"
SERVER_INFO = {"name": "maistep", "version": "0.1.0"}


class ApiError(RuntimeError):
    pass


def http(path, body=None, timeout=30):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, headers={"content-type": "application/json"},
                                 method="GET" if body is None else "POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8")
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        try:
            payload = json.loads(e.read().decode("utf-8"))
        except Exception:
            payload = None
        msg = (payload or {}).get("error") if isinstance(payload, dict) else None
        raise ApiError(msg or f"HTTP {e.code} {path}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise ApiError(f"сервер maistep недоступен на {BASE}: {getattr(e, 'reason', e)}. Запустите `npm run app` или `npm run server`.") from e


def workflows():
    out = []
    d = ROOT / "workflows"
    if d.is_dir():
        for p in sorted(d.glob("*.json")):
            if p.name.startswith("_"):
                continue
            try:
                data = json.loads(p.read_text("utf-8"))
                out.append({"id": p.stem, "file": p.name, "title": data.get("title") or p.stem,
                            "nodes": len(data.get("nodes") or []), "links": len(data.get("links") or []),
                            "mtime": int(p.stat().st_mtime)})
            except (OSError, ValueError) as e:
                out.append({"id": p.stem, "file": p.name, "error": str(e)})
    return out


def workflow(id_=None, path=None, data=None):
    if isinstance(data, dict):
        return data
    if path:
        p = Path(path)
        if not p.is_absolute():
            p = ROOT / p
        try:
            return json.loads(p.read_text("utf-8"))
        except (OSError, ValueError) as e:
            raise ApiError(f"не прочитать воркфлоу {p}: {e}") from e
    if not id_:
        raise ApiError("укажите id воркфлоу из workflows/ (list_workflows) или workflow/path")
    p = ROOT / "workflows" / f"{id_}.json"
    try:
        return json.loads(p.read_text("utf-8"))
    except (OSError, ValueError) as e:
        raise ApiError(f"нет воркфлоу {id_}: {e}") from e


def wait_run(prompt_id, timeout=600):
    t0 = time.time()
    while time.time() - t0 < timeout:
        hist = http("/api/history?limit=100&workflow=1") or []
        for h in hist:
            if h.get("prompt_id") == prompt_id:
                return h
        q = http("/api/queue") or {}
        if q.get("running", {}).get("prompt_id") != prompt_id and not any(
                x.get("prompt_id") == prompt_id for x in q.get("pending") or []):
            return {"prompt_id": prompt_id, "ok": False, "error": {"message": "запуск пропал из очереди"}}
        time.sleep(1)
    return {"prompt_id": prompt_id, "ok": False, "error": {"message": f"таймаут {timeout} с"}}


def node_default(node, field, fallback=None):
    try:
        cats = http("/api/nodes") or {}
        value = cats[node]["inputs"][field].get("default")
        return value if value not in (None, "") else fallback
    except Exception:
        return fallback


def first_checkpoint():
    try:
        lib = http("/api/library") or {}
        for it in lib.get("items") or []:
            if it.get("cat") == "checkpoints" and it.get("name"):
                return it["name"]
    except Exception:
        pass
    return ""


def generate_image(args):
    """Граф как в ComfyUI: Load Checkpoint → Load LoRA… → CLIP Set Last Layer → Positive/Negative →
    Empty Latent или (Load Image → VAE Encode) → KSampler → VAE Decode → Save Image."""
    prompt = args.get("prompt") or ""
    if not prompt:
        raise ApiError("нужен prompt")
    ckpt = args.get("checkpoint") or node_default("sd.checkpoint", "ckpt_name") or first_checkpoint()
    if not ckpt:
        raise ApiError("нет чекпоинта: укажите checkpoint или добавьте модели в библиотеку")
    loras = args.get("loras") or []
    if isinstance(loras, str):
        loras = [{"name": loras, "strength": 1.0}]
    N = lambda i, t, **p: {"id": i, "type": t, "props": p}  # noqa: E731
    Lk = lambda a, o, b, i: {"from": a, "out": o, "to": b, "in": i}  # noqa: E731
    nodes = [N("ckpt", "sd.checkpoint", ckpt_name=ckpt)]
    links = []
    model, clip = ("ckpt", "model"), ("ckpt", "clip")
    for i, item in enumerate(loras):
        item = {"name": item} if isinstance(item, str) else item
        lid = f"lora{i}"
        st = float(item.get("strength", 1.0))
        nodes.append(N(lid, "sd.lora", lora_name=item.get("name") or "", strength_model=st,
                       strength_clip=float(item.get("strength_clip", st))))
        links += [Lk(*model, lid, "model"), Lk(*clip, lid, "clip")]
        model, clip = (lid, "model"), (lid, "clip")
    nodes += [N("skip", "sd.clip_skip", stop_at_clip_layer=int(args.get("clip_skip", -2))),
              N("pos", "sd.text_encode", text=prompt),
              N("neg", "sd.text_encode", text=args.get("negative", "lowres, worst quality, bad anatomy, bad hands, watermark, text")),
              N("sampler", "sd.ksampler", seed=int(args.get("seed", -1)), steps=int(args.get("steps", 25)),
                cfg=float(args.get("cfg", 6.0)), sampler_name=args.get("sampler", "euler_ancestral"),
                scheduler=args.get("scheduler", "normal"),
                denoise=float(args.get("denoise", 0.55)) if args.get("input_image") else 1.0),
              N("decode", "sd.vae_decode"), N("save", "image.save", prefix="mcp")]
    links += [Lk(*clip, "skip", "clip"), Lk("skip", "clip", "pos", "clip"), Lk("skip", "clip", "neg", "clip"),
              Lk(*model, "sampler", "model"), Lk("pos", "conditioning", "sampler", "positive"),
              Lk("neg", "conditioning", "sampler", "negative"), Lk("sampler", "latent", "decode", "samples"),
              Lk("ckpt", "vae", "decode", "vae"), Lk("decode", "image", "save", "image")]
    if args.get("input_image"):
        nodes += [N("src", "image.load", file=args["input_image"]), N("encode", "sd.vae_encode")]
        links += [Lk("src", "image", "encode", "pixels"), Lk("ckpt", "vae", "encode", "vae"), Lk("encode", "latent", "sampler", "latent_image")]
    else:
        nodes.append(N("latent", "sd.empty_latent", width=int(args.get("width", 832)), height=int(args.get("height", 1216)),
                       batch_size=int(args.get("batch", 1))))
        links.append(Lk("latent", "latent", "sampler", "latent_image"))
    wf = {"id": "mcp_generate", "title": "MCP: генерация", "nodes": nodes, "links": links}
    pid = f"mcp{int(time.time() * 1000)}"
    r = http("/api/prompt", {"id": pid, "workflow": wf}, timeout=60)
    pid = r.get("prompt_id") or pid
    if args.get("wait", True):
        return {"queued": r, "run": wait_run(pid, float(args.get("timeout_sec", 900)))}
    return {"queued": r, "prompt_id": pid}


# ---------- инструменты ----------
TOOLS = []


def tool(name, description, schema, fn):
    TOOLS.append({"name": name, "description": description, "inputSchema": schema, "fn": fn})


def ok(data):
    return {"content": [{"type": "text", "text": json.dumps(data, ensure_ascii=False, indent=1, default=str)}]}


def fail(msg):
    return {"content": [{"type": "text", "text": str(msg)}], "isError": True}


tool("server_status", "Состояние сервера maistep: доступность, очередь, число нод, версия и компоненты.", {"type": "object", "properties": {}},
     lambda a: {"url": BASE, "queue": http("/api/queue"), "nodes": len(http("/api/nodes") or {}),
                "components": {k: v for k, v in (http("/api/components") or {}).items() if k in ("app", "python", "summary")}})

tool("list_nodes", "Каталог нод maistep (тип, название, категория, входы/выходы). Можно фильтровать.", {
    "type": "object", "properties": {"query": {"type": "string"}, "category": {"type": "string"}}},
     lambda a: (lambda cats, q, cat: [
         {"type": k, **{x: v[x] for x in ("title", "cat", "inputs", "outputs", "hint")}}
         for k, v in cats.items()
         if (not q or q.lower() in f"{k} {v.get('title','')} {v.get('hint','')}".lower())
         and (not cat or cat.lower() in (v.get("cat") or "").lower())
     ])(http("/api/nodes") or {}, a.get("query") or "", a.get("category") or ""))

tool("get_node", "Описание одной ноды по типу (например sd.ksampler).", {
    "type": "object", "required": ["type"], "properties": {"type": {"type": "string"}}},
     lambda a: (http("/api/nodes") or {}).get(a["type"]) or {"error": f"нет ноды {a['type']}"})

tool("list_workflows", "Воркфлоу проекта (workflows/*.json).", {"type": "object", "properties": {}}, lambda a: workflows())

tool("get_workflow", "Полный JSON воркфлоу по id.", {
    "type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}},
     lambda a: workflow(a["id"]))

tool("run_workflow", "Запустить воркфлоу из workflows/ или переданный JSON граф; дождаться результата.", {
    "type": "object", "properties": {
        "id": {"type": "string"}, "workflow": {"type": "object"}, "targets": {"type": "array", "items": {"type": "string"}},
        "wait": {"type": "boolean", "default": True}, "timeout_sec": {"type": "number", "default": 900}}},
     lambda a: (lambda wf, pid: (http("/api/prompt", {"id": pid, "workflow": {**wf, **({"targets": a["targets"]} if a.get("targets") else {})}}, timeout=60),
                                {"prompt_id": pid, "run": wait_run(pid, float(a.get("timeout_sec", 900)))} if a.get("wait", True) else {"prompt_id": pid})[1])(
         workflow(a.get("id"), a.get("path"), a.get("workflow")), f"mcp{int(time.time()*1000)}"))

tool("queue_status", "Очередь maistep: что выполняется и что ждёт.", {"type": "object", "properties": {}}, lambda a: http("/api/queue"))
tool("interrupt", "Прервать текущий запуск.", {"type": "object", "properties": {}}, lambda a: http("/api/interrupt", {}))
tool("history", "История запусков с результатами (по умолчанию 20).", {
    "type": "object", "properties": {"limit": {"type": "integer", "default": 20}}},
     lambda a: http(f"/api/history?limit={int(a.get('limit', 20))}&workflow=1"))

tool("list_models", "Модели из библиотеки (checkpoints, loras, vae…).", {
    "type": "object", "properties": {"category": {"type": "string"}, "query": {"type": "string"}, "limit": {"type": "integer", "default": 100}}},
     lambda a: (lambda lib: [{"id": it["id"], "name": it["name"], "cat": it["cat"], "base": it.get("base"), "size": it.get("size"), "nsfw": it.get("nsfw")}
                             for it in (lib.get("items") or [])
                             if (not a.get("category") or it["cat"] == a["category"])
                             and (not a.get("query") or a["query"].lower() in f"{it.get('name','')} {it.get('title','')} {it.get('base','')}".lower())][:int(a.get("limit", 100))])(
         http("/api/library?refresh=1" if a.get("refresh") else "/api/library") or {}))

tool("model_details", "Карточка модели: архитектура, база, триггер-слова, метаданные.", {
    "type": "object", "required": ["id"], "properties": {"id": {"type": "string"}}},
     lambda a: http(f"/api/library/model?id={urllib.parse.quote(a['id'])}"))


tool("components_status", "Компоненты maistep: установленные, рекомендованные и последние стабильные версии.", {
    "type": "object", "properties": {"refresh": {"type": "boolean", "default": False}, "deep": {"type": "boolean", "default": True}}},
     lambda a: http(f"/api/components?{'refresh=1&' if a.get('refresh') else ''}{'deep=1' if a.get('deep', True) else ''}"))

tool("install_components", "Установить/обновить компоненты в .venv (только стабильные). Идёт в фоне; статус — components_status.", {
    "type": "object", "properties": {
        "ids": {"type": "array", "items": {"type": "string"}},
        "mode": {"type": "string", "enum": ["recommended", "missing", "latest"], "default": "recommended"}}},
     lambda a: http("/api/components/install", {"ids": a.get("ids") or [], "mode": a.get("mode") or "recommended"}))

tool("generate_image", "Сгенерировать картинку локально (ноды SD как в ComfyUI): промпт, чекпоинт, LoRA, txt2img/img2img.", {
    "type": "object", "required": ["prompt"], "properties": {
        "prompt": {"type": "string"}, "negative": {"type": "string"},
        "checkpoint": {"type": "string", "description": "имя из библиотеки; по умолчанию — из ноды"},
        "loras": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}, "strength": {"type": "number"}}}},
        "width": {"type": "integer"}, "height": {"type": "integer"}, "steps": {"type": "integer"}, "cfg": {"type": "number"},
        "sampler": {"type": "string"}, "scheduler": {"type": "string"}, "clip_skip": {"type": "integer"},
        "seed": {"type": "integer"}, "batch": {"type": "integer"}, "denoise": {"type": "number"},
        "input_image": {"type": "string", "description": "путь input/… для img2img"},
        "wait": {"type": "boolean", "default": True}, "timeout_sec": {"type": "number", "default": 900}}},
     generate_image)

TOOL_MAP = {t["name"]: t for t in TOOLS}


def handle_call(name, args):
    t = TOOL_MAP.get(name)
    if not t:
        raise ApiError(f"нет инструмента {name}")
    try:
        return ok(t["fn"](args or {}))
    except Exception as e:
        return fail(f"{type(e).__name__}: {e}")


# ---------- JSON-RPC / MCP ----------
def read_message():
    line = sys.stdin.buffer.readline()
    while line and not line.strip():
        line = sys.stdin.buffer.readline()
    if not line:
        return None
    if line.lower().startswith(b"content-length:"):
        n = int(line.split(b":", 1)[1].strip())
        while True:
            h = sys.stdin.buffer.readline()
            if not h or h in (b"\r\n", b"\n"):
                break
        return json.loads(sys.stdin.buffer.read(n).decode("utf-8"))
    return json.loads(line.decode("utf-8"))


def send(msg):
    sys.stdout.buffer.write(json.dumps(msg, ensure_ascii=False, separators=(",", ":")).encode("utf-8") + b"\n")
    sys.stdout.buffer.flush()


def reply(id_, result=None, error=None):
    msg = {"jsonrpc": "2.0", "id": id_}
    if error is not None:
        msg["error"] = error
    else:
        msg["result"] = result
    send(msg)


def serve():
    while True:
        try:
            msg = read_message()
        except (ValueError, UnicodeDecodeError):
            reply(None, error={"code": -32700, "message": "parse error"})
            continue
        if msg is None:
            return
        method, id_ = msg.get("method"), msg.get("id")
        params = msg.get("params") or {}
        if method == "initialize":
            reply(id_, {"protocolVersion": params.get("protocolVersion") or PROTOCOL,
                        "capabilities": {"tools": {"listChanged": False}},
                        "serverInfo": SERVER_INFO,
                        "instructions": "maistep: нодовый редактор AI-пайплайнов. Инструменты работают с запущенным сервером "
                                        f"maistep на {BASE}. Начните с server_status / list_workflows."})
            continue
        if method in ("notifications/initialized", "notifications/cancelled"):
            continue
        if method == "ping":
            reply(id_, {})
        elif method == "tools/list":
            reply(id_, {"tools": [{k: t[k] for k in ("name", "description", "inputSchema")} for t in TOOLS]})
        elif method == "tools/call":
            reply(id_, handle_call(params.get("name"), params.get("arguments") or {}))
        elif method in ("resources/list", "prompts/list", "resources/templates/list"):
            key = method.split("/")[0]
            reply(id_, {key: []})
        elif method in ("logging/setLevel", "notifications/roots/list_changed"):
            if id_ is not None:
                reply(id_, {})
        else:
            if id_ is not None:
                reply(id_, error={"code": -32601, "message": f"метод {method} не поддерживается"})


def selftest():
    print(f"maistep MCP: {BASE}")
    try:
        q = http("/api/queue")
        print("сервер доступен, очередь:", json.dumps(q, ensure_ascii=False))
        print("воркфлоу:", ", ".join(w["id"] for w in workflows()) or "—")
    except ApiError as e:
        print("ошибка:", e)
        return 1
    return 0


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        raise SystemExit(selftest())
    serve()
