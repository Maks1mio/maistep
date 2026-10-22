"""Мост к ComfyUI (по умолчанию http://127.0.0.1:8188, настройка comfy_url в user/settings.json).

- object_info (кэш 10 мин) — каталог нод ComfyUI: списки моделей, сэмплеров, порядок виджетов;
- ui_to_api() — сохранённый воркфлоу ComfyUI (формат UI: nodes/links/widgets_values) → формат API для /prompt:
  Reroute и PrimitiveNode разворачиваются, Note пропускаются, выключенные (mode 2) выкидываются, обойдённые (mode 4)
  пропускают вход того же типа насквозь; значения control_after_generate («randomize»…) после сидов пропускаются;
- run() — POST /prompt, прогресс по WebSocket /ws (свой минимальный клиент на socket — без зависимостей),
  результат из /history, картинки скачиваются в output/comfy/ проекта maistep;
- прерывание запуска maistep → POST /interrupt в ComfyUI.
Только стандартная библиотека.
"""
import base64
import json
import os
import random
import re
import socket
import struct
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from .registry import Cancelled

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = ROOT / "user" / "settings.json"
DESKTOP_EXE = Path(os.path.expandvars(r"%LOCALAPPDATA%")) / "Programs" / "Comfy Desktop" / "Comfy Desktop.exe"
WORKFLOW_DIRS = [
    ("ComfyUI", Path(os.path.expandvars(r"%LOCALAPPDATA%")) / "Comfy-Desktop" / "ComfyUI-Installs" / "EvTs" / "ComfyUI" / "user" / "default" / "workflows"),
    ("maistep", ROOT / "comfy_workflows"),
]
WIDGET_TYPES = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
CONTROL_VALUES = {"fixed", "increment", "decrement", "randomize"}
# старые имена классов custom nodes, которые ComfyUI уже не знает
ALIASES = {"Segs & Mask": "ImpactSegsAndMask", "Segs  Mask": "ImpactSegsAndMask", "Segs & Mask ForEach": "ImpactSegsAndMaskForEach"}
FRONTEND_ONLY = {"Reroute", "PrimitiveNode", "Note", "MarkdownNote", "Label (rgthree)", "Fast Groups Bypasser (rgthree)", "Fast Groups Muter (rgthree)"}

_oi = {"at": 0, "data": None}


def url():
    try:
        s = json.loads(SETTINGS.read_text("utf-8"))
    except (OSError, ValueError):
        s = {}
    return (s.get("comfy_url") or "http://127.0.0.1:8188").rstrip("/")


def _get(path, timeout=30):
    with urllib.request.urlopen(f"{url()}{path}", timeout=timeout) as r:
        return r.read()


def _get_json(path, timeout=30):
    return json.loads(_get(path, timeout))


def _post_json(path, body, timeout=30):
    req = urllib.request.Request(f"{url()}{path}", json.dumps(body).encode(), {"content-type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
            return json.loads(data) if data else {}
    except urllib.error.HTTPError as e:
        raise ComfyError(_explain(e.read().decode("utf-8", "replace"))) from None


class ComfyError(RuntimeError):
    pass


def _explain(body):
    """Ответ ComfyUI с ошибкой валидации → понятный текст."""
    try:
        d = json.loads(body)
    except ValueError:
        return body[:500]
    parts = [d.get("error", {}).get("message", "") if isinstance(d.get("error"), dict) else str(d.get("error", ""))]
    for nid, ne in (d.get("node_errors") or {}).items():
        for e in ne.get("errors", []):
            parts.append(f"нода {nid} ({ne.get('class_type')}): {e.get('message')} — {e.get('details', '')}")
    return "\n".join(p for p in parts if p)[:2000]


def status():
    try:
        s = _get_json("/system_stats", timeout=3)
        q = _get_json("/queue", timeout=3)
        dev = (s.get("devices") or [{}])[0]
        return {"ok": True, "url": url(), "version": s.get("system", {}).get("comfyui_version"),
                "gpu": re.sub(r"^\w+:\d+\s+", "", dev.get("name", "")).split(" : ")[0].strip(), "vram_free": dev.get("vram_free"), "vram_total": dev.get("vram_total"),
                "running": len(q.get("queue_running", [])), "pending": len(q.get("queue_pending", [])),
                "desktop": DESKTOP_EXE.is_file()}
    except Exception as e:
        return {"ok": False, "url": url(), "error": f"{type(e).__name__}: {e}", "desktop": DESKTOP_EXE.is_file()}


def launch_desktop():
    """Запустить Comfy Desktop (только по явной команде пользователя)."""
    if not DESKTOP_EXE.is_file():
        raise ComfyError(f"не найден {DESKTOP_EXE}")
    import subprocess
    subprocess.Popen([str(DESKTOP_EXE)], cwd=str(DESKTOP_EXE.parent), creationflags=getattr(subprocess, "DETACHED_PROCESS", 0))
    return True


def object_info(refresh=False):
    if refresh or not _oi["data"] or time.time() - _oi["at"] > 600:
        try:
            _oi["data"] = _get_json("/object_info", timeout=120)
            _oi["at"] = time.time()
        except Exception as e:
            if not _oi["data"]:
                raise ComfyError(f"ComfyUI недоступен на {url()} — запустите Comfy Desktop ({type(e).__name__}: {e})") from None
    return _oi["data"]


def choices(node, inp, fallback=()):
    """Список вариантов COMBO-входа ноды ComfyUI (сэмплеры, модели…); ComfyUI выключен — fallback."""
    try:
        spec = (object_info()[node]["input"].get("required") or {}).get(inp) or object_info()[node]["input"]["optional"][inp]
        return list(spec[0]) if isinstance(spec[0], list) else list(spec[1].get("options", fallback))
    except Exception:
        return list(fallback)


def comfy_name(name):
    """Имя модели из библиотеки maistep (через /) → как его ждёт ComfyUI (на Windows подпапки через \\)."""
    return name.replace("/", os.sep) if name else name


# ---------- сохранённые воркфлоу ----------

def workflows():
    out = []
    for src, d in WORKFLOW_DIRS:
        if d.is_dir():
            for p in sorted(d.rglob("*.json")):
                out.append({"id": f"{src}:{p.relative_to(d).as_posix()}", "source": src, "name": p.relative_to(d).as_posix(),
                            "path": str(p), "mtime": p.stat().st_mtime})
    return out


def load_workflow(wid):
    src, _, rel = wid.partition(":")
    base = dict(WORKFLOW_DIRS).get(src)
    if not base or ".." in Path(rel).parts:
        raise ComfyError(f"нет воркфлоу {wid}")
    p = base / rel
    if not p.is_file():
        raise ComfyError(f"нет файла {p}")
    return json.loads(p.read_text("utf-8"))


def _norm(s):
    return "".join(ch for ch in str(s).lower() if ch.isalnum())


def class_of(n, oi):
    """Класс ноды ComfyUI для ноды UI: точное имя, алиас, «Node name for S&R», нормализованное имя/отображаемое имя."""
    t = n["type"]
    if t in oi:
        return t
    for cand in (t, (n.get("properties") or {}).get("Node name for S&R")):
        if cand and ALIASES.get(cand) in oi:
            return ALIASES[cand]
        if cand in oi:
            return cand
    want = {_norm(t), _norm((n.get("properties") or {}).get("Node name for S&R", ""))} - {""}
    for k, d in oi.items():
        if _norm(k) in want or _norm(d.get("display_name", "")) in want:
            return k
    return None


def is_api_format(wf):
    return isinstance(wf, dict) and "nodes" not in wf and all(isinstance(v, dict) and "class_type" in v for v in wf.values())


def _spec_inputs(oi_node):
    """Входы ноды ComfyUI по порядку: [(имя, тип, опции)]."""
    order = oi_node.get("input_order") or {}
    out = []
    for sec in ("required", "optional"):
        specs = oi_node["input"].get(sec) or {}
        for k in order.get(sec) or list(specs):
            v = specs.get(k)
            if v is None:
                continue
            t = "COMBO" if isinstance(v[0], list) else v[0]
            out.append((k, t, v[1] if len(v) > 1 and isinstance(v[1], dict) else {}))
    return out


def ui_to_api(wf, oi=None):
    """Воркфлоу в формате UI → формат API. Возвращает (prompt, notes) — notes: что пропущено и почему."""
    if is_api_format(wf):
        return wf, []
    if (wf.get("definitions") or {}).get("subgraphs"):
        raise ComfyError("в воркфлоу есть подграфы (subgraphs) — пока не поддержаны; разверните их в ComfyUI")
    oi = oi or object_info()
    nodes = {n["id"]: n for n in wf.get("nodes", [])}
    links = {}
    for l in wf.get("links", []):
        if isinstance(l, dict):
            links[l["id"]] = (l["origin_id"], l["origin_slot"], l.get("type"))
        else:
            links[l[0]] = (l[1], l[2], l[5] if len(l) > 5 else None)
    notes = []

    def resolve(link_id, depth=0):
        """Источник связи с учётом Reroute, Primitive и bypass: [id, slot] | ("value", v) | None."""
        if link_id is None or link_id not in links or depth > 50:
            return None
        src_id, slot, ltype = links[link_id]
        src = nodes.get(src_id)
        if not src:
            return None
        t, mode = src["type"], src.get("mode", 0)
        if t == "Reroute":
            return resolve((src.get("inputs") or [{}])[0].get("link"), depth + 1)
        if t == "PrimitiveNode":
            return ("value", (src.get("widgets_values") or [None])[0])
        if mode == 2:
            return None
        if mode == 4:  # bypass: первый вход того же типа
            out_t = (src.get("outputs") or [{}] * (slot + 1))[slot].get("type", ltype)
            for i in src.get("inputs") or []:
                if i.get("link") is not None and (i.get("type") == out_t or out_t in (None, "*")):
                    return resolve(i["link"], depth + 1)
            return None
        return [str(src_id), slot]

    prompt = {}
    for nid, n in nodes.items():
        t, mode = n["type"], n.get("mode", 0)
        if t in FRONTEND_ONLY or mode in (2, 4):
            continue
        cls = class_of(n, oi)
        if not cls:
            raise ComfyError(f"в ComfyUI нет ноды «{t}» (id {nid}) — не установлен custom node?")
        if cls != t:
            notes.append(f"{nid}: «{t}» → {cls}")
        t, spec = cls, oi[cls]
        ui_inputs = {i.get("name"): i for i in n.get("inputs") or []}
        wv = n.get("widgets_values")
        inputs = {}
        vals = list(wv) if isinstance(wv, list) else []
        vi = 0
        for name, typ, opts in _spec_inputs(spec):
            ui_in = ui_inputs.get(name)
            is_widget = typ in WIDGET_TYPES
            if is_widget:
                if isinstance(wv, dict):
                    val = wv.get(name, opts.get("default"))
                elif vi < len(vals):
                    val = vals[vi]
                    vi += 1
                    # значение «control_after_generate» после сида и «image» кнопки загрузки — не входы
                    if typ == "INT" and vi < len(vals) and vals[vi] in CONTROL_VALUES:
                        vi += 1
                    if opts.get("image_upload") and vi < len(vals) and vals[vi] == "image":
                        vi += 1
                else:
                    val = opts.get("default")
                if ui_in and ui_in.get("link") is not None:
                    src = resolve(ui_in["link"])
                    if src is not None:
                        val = src[1] if isinstance(src, tuple) else src
                if val is not None:
                    inputs[name] = val
            else:
                if ui_in and ui_in.get("link") is not None:
                    src = resolve(ui_in["link"])
                    if isinstance(src, tuple):
                        inputs[name] = src[1]
                    elif src is not None:
                        inputs[name] = src
        prompt[str(nid)] = {"class_type": t, "inputs": inputs, "_meta": {"title": n.get("title") or t}}
    skipped = [f"{n['id']} {n['type']}" for n in nodes.values() if n.get("mode") in (2, 4)]
    if skipped:
        notes.append("выключены/обойдены: " + ", ".join(skipped))
    # ссылки на выкинутые ноды убираем
    for p in prompt.values():
        for k, v in list(p["inputs"].items()):
            if isinstance(v, list) and len(v) == 2 and isinstance(v[0], str) and v[0] not in prompt:
                del p["inputs"][k]
    return prompt, notes


def widgets(prompt):
    """Редактируемые значения API-промпта: [{key: 'id.input', node, title, class_type, input, value}] — для привязок."""
    out = []
    for nid, p in prompt.items():
        for k, v in p["inputs"].items():
            if isinstance(v, list):
                continue
            out.append({"key": f"{nid}.{k}", "node": nid, "title": p.get("_meta", {}).get("title", p["class_type"]),
                        "class_type": p["class_type"], "input": k, "value": v})
    return out


def randomize_seeds(prompt, rng=None):
    rng = rng or random.Random()
    for p in prompt.values():
        for k in list(p["inputs"]):
            if k in ("seed", "noise_seed", "seed_num") and isinstance(p["inputs"][k], int):
                p["inputs"][k] = rng.randint(0, 2**50)


# ---------- загрузка картинок ----------

def upload_image(path: Path):
    """Файл → input/ ComfyUI (POST /upload/image, multipart). Возвращает имя для LoadImage."""
    boundary = uuid.uuid4().hex
    data = path.read_bytes()
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; filename=\"maistep_{path.name}\"\r\n"
            f"Content-Type: application/octet-stream\r\n\r\n").encode() + data + \
        f"\r\n--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\ntrue\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"{url()}/upload/image", body, {"content-type": f"multipart/form-data; boundary={boundary}"}, method="POST")
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.loads(r.read())
    return f"{d['subfolder']}/{d['name']}" if d.get("subfolder") else d["name"]


# ---------- WebSocket (только чтение событий) ----------

class _WS:
    def __init__(self, ws_url, timeout=1.0):
        u = urllib.parse.urlparse(ws_url)
        self.sock = socket.create_connection((u.hostname, u.port or 80), timeout=10)
        key = base64.b64encode(os.urandom(16)).decode()
        path = u.path + (f"?{u.query}" if u.query else "")
        self.sock.sendall((f"GET {path} HTTP/1.1\r\nHost: {u.hostname}:{u.port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ComfyError("WebSocket ComfyUI закрылся при подключении")
            head += chunk
        if b" 101 " not in head.split(b"\r\n")[0]:
            raise ComfyError(f"WebSocket ComfyUI: {head.split(b'\r\n')[0].decode(errors='replace')}")
        self.buf = head.split(b"\r\n\r\n", 1)[1]
        self.sock.settimeout(timeout)

    def _read(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ComfyError("WebSocket ComfyUI закрыт")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self):
        """Следующее сообщение: (opcode, bytes) или None по таймауту (чтобы проверять отмену)."""
        try:
            b1, b2 = self._read(2)
        except socket.timeout:
            return None
        op, n = b1 & 0x0F, b2 & 0x7F
        if n == 126:
            n = struct.unpack(">H", self._read(2))[0]
        elif n == 127:
            n = struct.unpack(">Q", self._read(8))[0]
        mask = self._read(4) if b2 & 0x80 else None
        old = self.sock.gettimeout()
        self.sock.settimeout(30)  # тело кадра дочитываем целиком
        try:
            data = self._read(n)
        finally:
            self.sock.settimeout(old)
        if mask:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        if op == 0x9:  # ping → pong (клиентские кадры маскируются)
            m = os.urandom(4)
            self.sock.sendall(bytes([0x8A, 0x80 | len(data)]) + m + bytes(b ^ m[i % 4] for i, b in enumerate(data)))
            return self.recv()
        return op, data

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# ---------- запуск ----------

def run(prompt, ctx, label="comfy"):
    """Выполнить API-промпт в ComfyUI. Возвращает {"images": [rel], "texts": [..], "outputs": {...}}."""
    object_info()  # заодно проверка, что ComfyUI жив
    client_id = uuid.uuid4().hex
    ws = _WS(f"{url().replace('http', 'ws', 1)}/ws?clientId={client_id}")
    try:
        r = _post_json("/prompt", {"prompt": prompt, "client_id": client_id})
        pid = r["prompt_id"]
        ctx.log(f"ComfyUI: промпт {pid[:8]} в очереди (#{r.get('number')})")
        total = len(prompt)
        done = set()
        while True:
            try:
                ctx.check()
            except Cancelled:
                try:
                    _post_json("/interrupt", {"prompt_id": pid})
                    _post_json("/queue", {"delete": [pid]})
                except Exception:
                    pass
                raise
            msg = ws.recv()
            if msg is None:
                continue
            op, data = msg
            if op == 0x8:
                raise ComfyError("ComfyUI закрыл соединение")
            if op != 0x1:
                continue  # двоичные кадры — превью латентов
            m = json.loads(data)
            t, d = m.get("type"), m.get("data", {})
            if d.get("prompt_id") not in (None, pid):
                continue
            if t == "progress":
                ctx.progress(d.get("value", 0), d.get("max", 1))
            elif t == "executing":
                if d.get("node") is None and d.get("prompt_id") == pid:
                    break
                done.add(d.get("node"))
                title = prompt.get(str(d.get("node")), {}).get("_meta", {}).get("title") or prompt.get(str(d.get("node")), {}).get("class_type")
                ctx.stream(f"▸ {title}\n")
            elif t == "execution_cached":
                done.update(d.get("nodes") or [])
            elif t == "execution_error":
                raise ComfyError(f"ComfyUI, нода {d.get('node_id')} ({d.get('node_type')}): {d.get('exception_message', '').strip()}")
            elif t == "execution_interrupted":
                raise Cancelled()
            elif t == "execution_success":
                break
        ctx.progress(total, total)
    finally:
        ws.close()
    hist = _get_json(f"/history/{pid}").get(pid, {})
    return collect(hist.get("outputs", {}), ctx, label)


def collect(outputs, ctx, label):
    """Выходы ComfyUI → картинки в output/comfy/ maistep + тексты."""
    out_dir = ctx.output_dir / "comfy"
    out_dir.mkdir(parents=True, exist_ok=True)
    images, texts = [], []
    stamp = time.strftime("%Y%m%d_%H%M%S")
    for nid, o in outputs.items():
        for i, im in enumerate(o.get("images") or []):
            q = urllib.parse.urlencode({"filename": im["filename"], "subfolder": im.get("subfolder", ""), "type": im.get("type", "output")})
            data = _get(f"/view?{q}", timeout=120)
            dst = out_dir / f"{label}_{stamp}_{nid}_{i}{Path(im['filename']).suffix or '.png'}"
            dst.write_bytes(data)
            images.append(dst.relative_to(ctx.root).as_posix())
        for k in ("text", "string", "STRING"):
            for t in o.get(k) or []:
                texts.append(t if isinstance(t, str) else json.dumps(t, ensure_ascii=False))
    return {"images": images, "texts": texts, "outputs": outputs}
