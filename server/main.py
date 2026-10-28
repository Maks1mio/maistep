"""maistep — сервер исполнения графов (только стандартная библиотека Python 3.10+).

    python server/main.py [--port 3300] [--host 127.0.0.1]

HTTP API (CORS — только для окна maistep и страниц на localhost, см. Handler._allowed):
  GET  /api/nodes              каталог нод { type: { title, cat, inputs, outputs, output, hint } }
  POST /api/check              { workflow } → { issues: [{ node, message }] }
  POST /api/prompt             { workflow, id? } → { prompt_id, number } — в очередь
  GET  /api/queue              { running, pending: [...] }
  POST /api/queue              { clear: true } | { delete: [id] }
  POST /api/interrupt          прервать текущий запуск
  GET  /api/history?limit=50   последние запуски с результатами
  POST /api/reload             перечитать ноды (server/nodes, custom_nodes)
  GET  /api/settings, POST /api/settings  провайдеры LLM (user/settings.json; ключи в ответе замаскированы)
  GET  /api/models?provider=id&refresh=1  каталог моделей провайдера (кэш 6 ч)
  POST /api/upload?name=x.png  тело — файл → input/x.png (&dir=output — в output/); имя занято другим файлом → x_2.png
  GET  /api/files?dir=input    файлы input/ или output/
  GET  /api/library?refresh=1   библиотека моделей (только чтение): корни, категории, модели
  GET  /api/library/model?id=cat/name   карточка модели (заголовок safetensors, .cminfo.json, …)
  GET  /api/library/preview?id=cat/name превью модели (только файлы-превью из индекса)
  POST /api/library/roots { add?: путь, remove?: путь }  добавить папку моделей / убрать из списка
  GET  /api/stats               CPU, RAM, GPU, VRAM (+ история для графиков) — оверлей статистики
  GET|POST /api/limits { ram_reserve_gb, vram_max_pct, gpu_load, max_mp }  лимиты нагрузки (sysmon.py)
  GET  /api/logs                файлы логов (user/logs) · POST /api/logs/report — zip для отправки
  GET  /api/components?refresh=1&deep=1  компоненты: установлено/рекомендуется/последняя стабильная, установка
  POST /api/components/install { ids?, mode: recommended|missing|latest }  установка в .venv (SSE comp-log)
  POST /api/components/variant { variant: auto|cuda|rocm|cpu, gfx? }  сборка torch под видеокарту
  GET  /api/civitai/search?q=&types=&bases=&sort=&period=&nsfw=1&limit=&cursor=  поиск Civitai
  GET  /api/civitai/model?id= | resolve?q=ссылка | jobs | tags | settings | meta
  POST /api/civitai/download { items: [{ model, version, file? }], root? } | cancel | retry | clear | reveal | delete { id }
  POST /api/civitai/tags { models, add, remove } | settings { api_key, root, connections, concurrent, … }
  GET  /api/magic?ckpt=имя&loras=[[имя, сила], …]&refresh=1  Magic KSampler: параметры под чекпоинт и LoRA
  POST /api/free               выгрузить модели генерации из памяти и сбросить кэш нод
  POST /api/components/cancel  прервать установку
  GET  /api/update?check=1     обновление maistep из GitHub Releases: статус / проверить (SSE update)
  POST /api/update/download    скачать изменившиеся файлы в update/staging (применяет ядро при перезапуске)
  GET  /api/agent/chats | chat?id=   диалоги AI Agent (user/chats/)
  POST /api/agent/chat { id?, title, provider, model, effort, wf, hidden } | delete { id } | stop { id }
  GET  /api/agent/procs?chat= | proc_output?id=&tail= · POST /api/agent/proc_stop | proc_forget { id }  фоновые процессы агента
  POST /api/agent/rewind { id, index } | retry { id, workflows } | fork { id, index }  как в Claude: откат, повтор, ветка
  POST /api/agent/send { id, text, images: [input/…], workflows: { id: граф } }  ход агента (SSE agent)
  POST /api/agent/client { req, ok, result|error } | approve { req, ok, always }  ответы окна и разрешения
  GET  /api/agent/characters · POST /api/agent/character { id?, name, … } | character_delete { id }
  POST /api/agent/character_photo { id, scene?, framing? }  фото персонажа (аватар) → { images }
  GET  /api/agent/context?id= | projects | git?cwd= | diff?cwd=&path=   правая панель AI Chat
  POST /api/agent/projects { add | remove } | git_switch { cwd, branch }
  GET  /api/fs/dirs?path=      обзор дисков и папок ПК (выбор папки проекта)
  POST /api/fs/mkdir { parent, name } | rename { path, name } | trash { path } (корзина) | reveal { path } (проводник)
  GET  /api/mcp · POST /api/mcp { servers } | mcp/import { text } | mcp/test { name }   MCP-серверы (коннекторы)
  GET  /api/llamacpp | llamacpp/models · POST /api/llamacpp { …настройки } | llamacpp/start | llamacpp/stop
  GET  /view?file=output/a.png файл из input/ или output/
  GET  /thumb?file=…&h=384    миниатюра WebP для галереи (кеш user/thumbs)
  GET  /agentfs/<диалог>/<№ папки>/<путь>  файл проекта для браузера AI Chat (только папки, выданные диалогу)
  GET  /events                 SSE: status, start, executing, progress, preview, stream, executed, run-error, done, log, nodes,
                               components, comp-log, agent, update
"""
import argparse
import hashlib
import json
import mimetypes
import os
import queue
import re
import sys
import threading
import time
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "server"))

from maistep import registry, executor, providers, library, components, civitai, agent, magic, updater, sysmon, logs  # noqa: E402
from maistep import workspace, mcp, llamacpp, lifetime, outputs  # noqa: E402
from maistep.registry import Cancelled  # noqa: E402

for d in ("input", "output", "user", "workflows", "custom_nodes"):
    (ROOT / d).mkdir(exist_ok=True)
SETTINGS = ROOT / "user" / "settings.json"
HISTORY = ROOT / "user" / "history.json"  # история запусков переживает перезапуск сервера


def log(level, text):
    stream = sys.stderr if level == "error" else sys.stdout
    print(f"[{level}] {text}" if level != "info" else text, file=stream, flush=True)


# ---------- события (SSE) ----------
class Hub:
    def __init__(self):
        self.clients, self.lock = [], threading.Lock()

    def add(self):
        q = queue.Queue(maxsize=5000)
        with self.lock:
            self.clients.append(q)
        return q

    def remove(self, q):
        with self.lock:
            if q in self.clients:
                self.clients.remove(q)

    def emit(self, event, data):
        msg = f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n".encode()
        with self.lock:
            for q in self.clients:
                try:
                    q.put_nowait(msg)
                except queue.Full:
                    pass


HUB = Hub()
components.configure(lambda event, data: HUB.emit(event, data))
civitai.configure(lambda event, data: HUB.emit(event, data))


def load_settings():
    try:
        return json.loads(SETTINGS.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


# ---------- очередь запусков ----------
class Run:
    def __init__(self, workflow, pid, number):
        self.workflow, self.id, self.number = workflow, pid, number
        self.cancel = threading.Event()
        self.seeds = {}  # нода → выпавший seed (для графа в PNG)
        self.settings = load_settings()
        self.title = workflow.get("title") or workflow.get("id") or pid[:8]
        # ход запуска — для окна, подключившегося посреди него (перезагрузка UI): replay() досылает его заново
        self.started, self.node, self.progress, self.preview, self.done = False, None, None, {}, {}

    def emit(self, event, data):
        msg = {"prompt_id": self.id, **data}
        if event == "start":
            self.started = True
        elif event == "executing":
            self.node, self.progress = data.get("node"), None
        elif event == "progress":
            self.progress = msg
        elif event == "preview":
            self.preview[data.get("node")] = msg
        elif event == "executed":
            self.done[data.get("node")] = msg
            self.preview.pop(data.get("node"), None)
        HUB.emit(event, msg)

    def replay(self):
        """SSE-сообщения, восстанавливающие ход запуска: start, готовые ноды, текущая нода, прогресс, превью."""
        if not self.started:
            return []
        msgs = [("start", {"prompt_id": self.id, "title": self.title, "wf": self.workflow.get("id")})]
        msgs += [("executed", m) for m in list(self.done.values())]
        if self.node is not None:
            msgs.append(("executing", {"prompt_id": self.id, "node": self.node}))
        if self.progress:
            msgs.append(("progress", self.progress))
        msgs += [("preview", m) for m in list(self.preview.values())]
        return [f"event: {e}\ndata: {json.dumps(d, ensure_ascii=False, default=str)}\n\n".encode() for e, d in msgs]

    def cancel_check(self):
        if self.cancel.is_set():
            raise Cancelled()


class Queue:
    def __init__(self):
        self.pending, self.running, self.history = [], None, self.load()
        self.cond = threading.Condition()
        self.counter = max((h.get("number") or 0 for h in self.history), default=0)
        threading.Thread(target=self.worker, daemon=True).start()

    @staticmethod
    def load():
        try:
            h = json.loads(HISTORY.read_text("utf-8"))
            return h if isinstance(h, list) else []
        except (OSError, ValueError):
            return []

    def save(self):
        """Пишется после каждого запуска (через временный файл — обрыв записи не портит историю)."""
        try:
            tmp = HISTORY.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.history, ensure_ascii=False, default=str), "utf-8")
            os.replace(tmp, HISTORY)
        except OSError as e:
            log("error", f"история запусков не сохранена: {e}")

    def status(self):
        return {"running": self.running and {"prompt_id": self.running.id, "title": self.running.title, "number": self.running.number},
                "pending": [{"prompt_id": r.id, "title": r.title, "number": r.number} for r in self.pending]}

    def put(self, wf, pid=None):
        with self.cond:
            self.counter += 1
            r = Run(wf, pid or uuid.uuid4().hex, self.counter)
            self.pending.append(r)
            self.cond.notify()
        HUB.emit("status", self.status())
        return r

    def worker(self):
        while True:
            with self.cond:
                while not self.pending:
                    self.cond.wait()
                r = self.running = self.pending.pop(0)
            HUB.emit("status", self.status())
            r.emit("start", {"title": r.title, "wf": r.workflow.get("id")})
            t0, ok, err, results = time.time(), False, None, {}
            try:
                results = executor.run(r.workflow, r, ROOT)
                ok = True
            except Cancelled:
                err = {"node": None, "message": "прервано"}
            except executor.GraphError as e:
                err = {"node": e.node, "message": str(e)}
            except Exception as e:
                err = {"node": None, "message": f"{type(e).__name__}: {e}\n{traceback.format_exc()}"}
            dt = round(time.time() - t0, 2)
            if err:
                r.emit("run-error", err)  # не «error»: в браузере это имя у обрыва EventSource (onerror)
                log("error", f"запуск #{r.number} «{r.title}»: {err['message'].splitlines()[0]}" + (f" (нода {err['node']})" if err["node"] else ""))
            else:
                log("info", f"запуск #{r.number} «{r.title}» — {dt} с")
            item = {"prompt_id": r.id, "number": r.number, "title": r.title, "ok": ok, "error": err, "time": dt,
                    "at": time.strftime("%Y-%m-%d %H:%M:%S"), "outputs": results, "workflow": r.workflow}
            with self.cond:
                self.history.insert(0, item)
                del self.history[200:]
                self.running = None
                self.save()
            r.emit("done", {"ok": ok, "time": dt, "error": err})
            HUB.emit("status", self.status())

    def interrupt(self, pid=None):
        """Прервать текущий запуск; с pid — только этот (идёт — прервать, ждёт — убрать из очереди)."""
        if pid and not (self.running and self.running.id == pid):
            return self.clear({pid})
        if self.running:
            self.running.cancel.set()

    def clear(self, ids=None):
        """Убрать ждущие запуски. Каждый попадает в историю с ошибкой и шлёт done: иначе ждущие его (агент — wait_run,
        аватар персонажа, MCP) висели до часа, а окно не узнавало, что запуска не будет."""
        with self.cond:
            gone = [r for r in self.pending if ids is None or r.id in ids]
            self.pending = [r for r in self.pending if r not in gone]
            err = {"node": None, "message": "убран из очереди"}
            for r in gone:
                self.history.insert(0, {"prompt_id": r.id, "number": r.number, "title": r.title, "ok": False, "error": err, "time": 0,
                                        "at": time.strftime("%Y-%m-%d %H:%M:%S"), "outputs": {}, "workflow": r.workflow})
            del self.history[200:]
            if gone:
                self.save()
        for r in gone:
            r.emit("done", {"ok": False, "time": 0, "error": err})
        HUB.emit("status", self.status())


Q = None


# ---------- HTTP ----------
def safe_file(rel):
    rel = unquote(rel or "").replace("\\", "/").lstrip("/")
    if not re.match(r"^(input|output)/", rel) or ".." in rel.split("/"):
        return None
    p = ROOT / rel
    if not p.is_file():  # файл перенесён в подпапку output/ (outputs.organize) — ссылка из старого localStorage, чата
        p = ROOT / outputs.resolve(ROOT, rel)
    return p if p.is_file() else None


THUMBS = ROOT / "user" / "thumbs"


def thumb(p, h=None):
    """Миниатюра картинки для галереи (WebP высотой h, кеш user/thumbs по пути, mtime и размеру файла).
    Галерея грузила PNG целиком (~2 МБ на кадр, сотни кадров) — тормозила. None — не картинка или нет Pillow."""
    try:
        h = max(64, min(1024, int(h or 384)))
    except ValueError:
        h = 384
    if p.suffix.lower() not in (".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"):
        return None
    st = p.stat()
    key = hashlib.sha1(f"{p.resolve()}|{st.st_mtime_ns}|{st.st_size}|{h}".encode()).hexdigest()[:24]
    t = THUMBS / f"{key}.webp"
    if t.is_file():
        return t
    try:
        from PIL import Image
        with Image.open(p) as im:
            im.draft("RGB", (h * 4, h))  # JPEG — декод сразу в меньшем размере
            im.thumbnail((h * 4, h), Image.LANCZOS)
            im = im.convert("RGBA" if im.mode in ("RGBA", "LA", "P") else "RGB")
            THUMBS.mkdir(parents=True, exist_ok=True)
            tmp = t.with_suffix(f".{threading.get_ident()}.tmp")
            im.save(tmp, "WEBP", quality=82, method=4)
        os.replace(tmp, t)
        return t
    except Exception:  # нет Pillow, битый файл — отдадим оригинал
        return None


def civitai_get(op, qs):
    if op == "search":
        lst = lambda k: [x for x in (qs.get(k) or "").split(",") if x]  # noqa: E731
        return civitai.search(qs.get("q", ""), lst("types"), lst("bases"), qs.get("sort", "Highest Rated"),
                              qs.get("period", "AllTime"), qs.get("nsfw") == "1", int(qs.get("limit", 20)),
                              qs.get("cursor") or None, qs.get("username", ""))
    if op == "model":
        return civitai.model(qs.get("id"))
    if op == "resolve":
        return civitai.resolve(qs.get("q", ""))
    if op == "jobs":
        return {"jobs": civitai.jobs()}
    if op == "tags":
        return civitai.tags()
    if op == "settings":
        return civitai.public_settings()
    if op == "meta":
        return civitai.meta()
    raise ValueError(f"нет такого пути civitai/{op}")


def civitai_post(op, d):
    if op == "download":
        items = d.get("items") or [d]
        return {"jobs": [civitai.enqueue(i["model"], i["version"], i.get("file"), d.get("root") or i.get("root"),
                                         i.get("filename")) for i in items]}
    if op == "cancel":
        return civitai.cancel(d.get("id"))
    if op == "retry":
        return civitai.retry(d.get("id"))
    if op == "clear":
        return {"jobs": civitai.clear(d.get("ids"))}
    if op == "delete":
        return civitai.delete_job(d.get("id"))
    if op == "reveal":
        return civitai.reveal(d.get("id"))
    if op == "tags":
        return civitai.set_tags(d.get("models") or [], d.get("add") or [], d.get("remove") or [])
    if op == "settings":
        return civitai.save_settings(d)
    raise ValueError(f"нет такого пути civitai/{op}")


BIND_HOST = "127.0.0.1"  # --host; не loopback (0.0.0.0) — пользователь сам открыл сервер в сеть
ORIGIN_SCHEMES = ("http", "https", "tauri", "mai")


def _local_host(host):
    host = (host or "").lower().strip("[]")
    return host in ("localhost", "127.0.0.1", "::1") or host.endswith(".localhost")


def _local_origin(origin):
    """Окно Tauri (tauri://localhost, http://tauri.localhost), mai://, веб-режим и страницы на localhost."""
    try:
        u = urlparse(origin)
    except ValueError:
        return False
    return u.scheme in ORIGIN_SCHEMES and _local_host(u.hostname)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "maistep"

    def log_message(self, fmt, *args):
        pass

    def _allowed(self):
        """Запрос от окна maistep или локальной страницы, а не от стороннего сайта. Без проверки любой сайт,
        открытый в браузере, мог POST-ом на 127.0.0.1 добавить MCP-сервер с командой и запустить её.
        Host — защита от DNS rebinding (чужое имя, указывающее на 127.0.0.1); Origin — от прямых запросов сайта.
        Без Origin — не браузер (MCP, curl) или обычная навигация: пропускаем."""
        host = urlparse(f"//{self.headers.get('host') or ''}").hostname or ""
        if not _local_host(host) and host != BIND_HOST and BIND_HOST not in ("0.0.0.0", "::"):
            return False
        origin = self.headers.get("origin")
        return origin is None or _local_origin(origin)

    def _head(self, code=200, ctype="application/json; charset=utf-8", length=None, extra=None):
        self.send_response(code)
        self.send_header("content-type", ctype)
        origin = self.headers.get("origin")
        if origin and _local_origin(origin):
            self.send_header("access-control-allow-origin", origin)
            self.send_header("vary", "origin")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
        if length is not None:
            self.send_header("content-length", str(length))
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()

    def json(self, data, code=200):
        body = json.dumps(data, ensure_ascii=False, default=str).encode()
        self._head(code, length=len(body))
        self.wfile.write(body)

    def body(self):
        n = int(self.headers.get("content-length") or 0)
        return self.rfile.read(n) if n else b""

    def do_OPTIONS(self):
        self._head(204 if self._allowed() else 403, length=0)

    def do_GET(self):
        if not self._allowed():
            return self.json({"error": "запрос с чужого сайта"}, 403)
        u = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(u.query).items()}
        if u.path == "/events":
            return self.events()
        if u.path == "/api/nodes":
            return self.json({k: d.to_json() for k, d in registry.NODES.items()})
        if u.path == "/api/queue":
            return self.json(Q.status())
        if u.path == "/api/history":
            lim = int(qs.get("limit", 50))
            full = qs.get("workflow") == "1"
            return self.json([{k: v for k, v in h.items() if full or k != "workflow"} for h in Q.history[:lim]])
        if u.path == "/api/settings":
            return self.json(providers.public())
        if u.path == "/api/models":
            pid = qs.get("provider") or providers.default_provider()
            try:
                return self.json({"provider": pid, **providers.models(pid, qs.get("refresh") == "1")})
            except ValueError as e:
                return self.json({"error": str(e)}, 404)
        if u.path == "/api/files":
            d = qs.get("dir", "output")
            if d not in ("input", "output"):
                return self.json({"error": "dir: input | output"}, 400)
            files = sorted((p for p in (ROOT / d).rglob("*") if p.is_file()), key=lambda p: p.stat().st_mtime, reverse=True)
            return self.json([{"file": p.relative_to(ROOT).as_posix(), "size": p.stat().st_size, "mtime": p.stat().st_mtime} for p in files[:500]])
        if u.path == "/api/library":
            return self.json(library.summary(qs.get("refresh") == "1"))
        if u.path == "/api/stats":
            return self.json(sysmon.stats())
        if u.path == "/api/limits":
            return self.json(sysmon.limits())
        if u.path == "/api/logs":
            return self.json({"dir": str(logs.DIR), "files": logs.files()})
        if u.path == "/api/library/model":
            try:
                return self.json(library.details(qs.get("id", "")))
            except KeyError:
                return self.json({"error": "нет такой модели"}, 404)
        if u.path == "/api/library/preview":
            pp = library.preview_path(qs.get("id", ""))
            if not pp:
                return self.json({"error": "нет превью"}, 404)
            data = Path(pp).read_bytes()
            self._head(200, mimetypes.guess_type(pp)[0] or "image/jpeg", len(data), {"cache-control": "max-age=3600"})
            return self.wfile.write(data)
        if u.path == "/api/magic":
            try:
                loras = json.loads(qs.get("loras") or "[]")
                return self.json(magic.recommend(qs.get("ckpt", ""), [(n, float(w)) for n, w in loras], qs.get("refresh") == "1"))
            except Exception as e:
                return self.json({"error": f"{type(e).__name__}: {e}"}, 400)
        if u.path == "/api/components":
            try:
                return self.json(components.status(qs.get("refresh") == "1", qs.get("deep") == "1"))
            except Exception as e:
                return self.json({"error": f"{type(e).__name__}: {e}"}, 500)
        if u.path == "/api/update":
            if qs.get("check") == "1":
                updater.check()
            return self.json(updater.status())
        if u.path == "/api/agent/chats":
            return self.json(agent.chats())
        try:
            if u.path == "/api/agent/context":
                return self.json(agent.context(qs.get("id")))
            if u.path == "/api/agent/projects":
                return self.json(workspace.recent())
            if u.path == "/api/agent/git":
                return self.json(workspace.git_info(qs.get("cwd")))
            if u.path == "/api/agent/diff":
                return self.json({"diff": workspace.git_diff(qs.get("cwd"), qs.get("path") or "")})
            if u.path == "/api/fs/dirs":
                return self.json(workspace.dirs(qs.get("path")))
            if u.path == "/api/mcp":
                return self.json(mcp.status())
            if u.path == "/api/agent/procs":
                return self.json(agent.procs.listing(qs.get("chat")))
            if u.path == "/api/agent/proc_output":
                return self.json(agent.procs.output(qs.get("id"), qs.get("tail") or 400))
            if u.path == "/api/mcp/config":
                return self.json(mcp.config())
            if u.path == "/api/llamacpp":
                return self.json(llamacpp.status())
            if u.path == "/api/llamacpp/models":
                return self.json(llamacpp.ggufs())
        except KeyError:
            return self.json({"error": "нет такого диалога"}, 404)
        except Exception as e:
            return self.json({"error": f"{type(e).__name__}: {e}"}, 400)
        if u.path == "/api/agent/characters":
            return self.json(agent.T.characters())
        if u.path == "/api/agent/chat":
            try:
                c = agent.load(qs.get("id"))
                return self.json({**agent.meta(c), "messages": c["messages"]})
            except (KeyError, ValueError):
                return self.json({"error": "нет такого диалога"}, 404)
        if u.path.startswith("/api/civitai/"):
            try:
                return self.json(civitai_get(u.path[len("/api/civitai/"):], qs))
            except Exception as e:
                return self.json({"error": str(e)}, 400)
        if u.path.startswith("/agentfs/"):
            parts = u.path.split("/", 4)  # '', agentfs, диалог, № папки, путь
            try:
                p = agent.agentfs(parts[2], parts[3], parts[4] if len(parts) > 4 else "")
            except (KeyError, ValueError, IndexError, FileNotFoundError, PermissionError) as e:
                return self.json({"error": f"{type(e).__name__}: {e}"}, 404)
            data = p.read_bytes()
            self._head(200, mimetypes.guess_type(p.name)[0] or "application/octet-stream", len(data), {"cache-control": "no-cache"})
            return self.wfile.write(data)
        if u.path == "/view":
            p = safe_file(qs.get("file"))
            if not p:
                return self.json({"error": "нет файла"}, 404)
            data = p.read_bytes()
            self._head(200, mimetypes.guess_type(p.name)[0] or "application/octet-stream", len(data), {"cache-control": "no-cache"})
            return self.wfile.write(data)
        if u.path == "/thumb":
            p = safe_file(qs.get("file"))
            if not p:
                return self.json({"error": "нет файла"}, 404)
            t = thumb(p, qs.get("h"))
            tag = f'"{t.stem}"' if t else None
            if tag and self.headers.get("if-none-match") == tag:
                return self._head(304, length=0, extra={"etag": tag, "cache-control": "max-age=600"})
            data = (t or p).read_bytes()
            ctype = "image/webp" if t else mimetypes.guess_type(p.name)[0] or "application/octet-stream"
            self._head(200, ctype, len(data), {"cache-control": "max-age=600", **({"etag": tag} if tag else {})})
            return self.wfile.write(data)
        if u.path == "/":
            return self.json({"app": "maistep", "nodes": len(registry.NODES), "queue": Q.status()})
        self.json({"error": f"нет такого пути {u.path}"}, 404)

    def do_POST(self):
        if not self._allowed():
            self.body()  # дочитать тело: соединение keep-alive
            return self.json({"error": "запрос с чужого сайта"}, 403)
        u = urlparse(self.path)
        qs = {k: v[0] for k, v in parse_qs(u.query).items()}
        try:
            if u.path == "/api/upload":
                name = Path(qs.get("name") or "upload.bin").name
                d = qs.get("dir") or "input"  # input | output | output/<подпапка> (ImageNaizer → output/naizer)
                if not re.fullmatch(r"(input|output)(/[\w.-]+)*", d) or ".." in d.split("/"):
                    d = "input"
                p = ROOT / d / name
                p.parent.mkdir(parents=True, exist_ok=True)
                data = self.body()
                # то же имя, другое содержимое (photo.png из другой папки) — новое имя: перезапись молча меняла картинку
                # во всех воркфлоу и холстах, где стоял прежний файл. Такой же файл — отдаём существующий.
                for i in range(2, 10000):
                    if not p.exists() or p.read_bytes() == data:
                        break
                    p = p.with_name(f"{Path(name).stem}_{i}{Path(name).suffix}")
                if not p.exists():
                    p.write_bytes(data)
                return self.json({"file": f"{d}/{p.name}"})
            data = json.loads(self.body() or b"{}")
        except ValueError as e:
            return self.json({"error": f"плохой JSON: {e}"}, 400)
        if u.path == "/api/prompt":
            wf = data.get("workflow")
            if not isinstance(wf, dict):
                return self.json({"error": "нужен workflow"}, 400)
            issues = executor.check(wf, only_needed=True)
            if issues:
                return self.json({"error": "граф с ошибками", "issues": issues}, 400)
            r = Q.put(wf, data.get("id"))
            return self.json({"prompt_id": r.id, "number": r.number})
        if u.path == "/api/check":
            return self.json({"issues": executor.check(data.get("workflow") or {})})
        if u.path == "/api/queue":
            Q.clear(None if data.get("clear") else set(data.get("delete") or []))
            return self.json(Q.status())
        if u.path == "/api/interrupt":
            Q.interrupt()
            return self.json({"ok": True})
        if u.path.startswith("/api/civitai/"):
            try:
                return self.json(civitai_post(u.path[len("/api/civitai/"):], data))
            except Exception as e:
                return self.json({"error": str(e)}, 400)
        try:
            if u.path == "/api/agent/projects":
                if data.get("remove"):
                    return self.json(workspace.forget(data["remove"]))
                return self.json(workspace.touch(data.get("add")))
            if u.path == "/api/agent/proc_stop":
                return self.json(agent.procs.stop(data.get("id")))
            if u.path == "/api/agent/proc_forget":
                return self.json(agent.procs.forget(data.get("id")))
            if u.path == "/api/fs/mkdir":
                return self.json(workspace.mkdir(data.get("parent"), data.get("name")))
            if u.path == "/api/fs/rename":
                return self.json(workspace.rename(data.get("path"), data.get("name")))
            if u.path == "/api/fs/trash":
                return self.json(workspace.trash(data.get("path")))
            if u.path == "/api/fs/reveal":
                return self.json(workspace.reveal(data.get("path")))
            if u.path == "/api/agent/git_switch":
                return self.json(workspace.git_switch(data.get("cwd"), data.get("branch")))
            if u.path == "/api/mcp":
                return self.json(mcp.save_config(data.get("servers") or {}))
            if u.path == "/api/mcp/import":
                return self.json(mcp.import_json(data.get("text") or "{}"))
            if u.path == "/api/mcp/test":
                try:
                    return self.json(mcp.test(data.get("name")))
                except Exception:
                    return self.json(mcp.status())
            if u.path == "/api/llamacpp":
                return self.json(llamacpp.save(data))
            if u.path == "/api/llamacpp/start":
                return self.json(llamacpp.start(wait=data.get("wait") or 0))
            if u.path == "/api/llamacpp/stop":
                return self.json(llamacpp.stop())
        except Exception as e:
            return self.json({"error": f"{type(e).__name__}: {e}"}, 400)
        if u.path.startswith("/api/agent/"):
            op = u.path[len("/api/agent/"):]
            try:
                if op == "chat":
                    return self.json(agent.upsert(data))
                if op == "delete":
                    return self.json(agent.delete(data.get("id")))
                if op == "stop":
                    return self.json(agent.stop(data.get("id")))
                if op == "rewind":
                    return self.json(agent.rewind(data.get("id"), data.get("index", 0)))
                if op == "retry":
                    return self.json(agent.retry(data.get("id"), data.get("workflows") or {}))
                if op == "fork":
                    return self.json(agent.fork(data.get("id"), data.get("index", 0)))
                if op in ("client", "approve"):
                    return self.json(agent.answer(data.get("req"), data))
                if op == "character":
                    return self.json(agent.T.char_upsert(data))
                if op == "character_delete":
                    return self.json(agent.T.char_delete(data.get("id")))
                if op == "character_photo":
                    c = agent.T.character(data.get("id"))
                    text, imgs = agent.T.char_photo(agent.run_now, c, data.get("scene") or "", data.get("framing") or "portrait")
                    if not imgs:
                        return self.json({"error": text.split("FAILED: ")[-1][:400]}, 400)
                    return self.json({"images": imgs, "text": text})
                if op == "send":
                    return self.json(agent.send(data.get("id"), data.get("text", ""), data.get("images") or [], data.get("workflows") or {},
                                               data.get("label")))
            except KeyError:
                return self.json({"error": "нет такого диалога"}, 404)
            except Exception as e:
                return self.json({"error": f"{type(e).__name__}: {e}"}, 400)
            return self.json({"error": f"нет такого пути {u.path}"}, 404)
        if u.path == "/api/free":
            from maistep import diffusion
            diffusion.unload()
            executor.CACHE.clear()
            return self.json({"ok": True})
        if u.path == "/api/components/install":
            r = components.install(data.get("ids") or [], data.get("mode") or "recommended")
            return self.json(r, 409 if r.get("error") else 200)
        if u.path == "/api/limits":
            r = sysmon.save_limits(data)
            log("info", f"лимиты: {r}")
            return self.json(r)
        if u.path == "/api/logs/report":
            extra = {"version": updater.installed_version(), "gpu": components.gpu_info(), "limits": sysmon.limits(),
                     "gen": load_settings().get("gen") or {}}
            try:
                extra["stats"] = sysmon.line(sysmon.sample())
            except Exception as e:
                extra["stats"] = f"{type(e).__name__}: {e}"
            path = logs.report(extra)
            log("info", f"отчёт для отправки: {path}")
            return self.json({"path": path})
        if u.path == "/api/library/roots":
            try:
                r = library.edit_roots(data.get("add"), data.get("remove"))
            except ValueError as e:
                return self.json({"error": str(e)}, 400)
            HUB.emit("library-changed", {})
            return self.json(r)
        if u.path == "/api/components/variant":
            r = components.set_variant(data.get("variant") or "auto", data.get("gfx"))
            return self.json(r, 409 if r.get("error") else 200)
        if u.path == "/api/update/download":
            r = updater.download()
            return self.json(r, 409 if r.get("error") else 200)
        if u.path == "/api/components/cancel":
            r = components.cancel()
            return self.json(r, 409 if r.get("error") else 200)
        if u.path == "/api/reload":
            registry.load_all(ROOT, log)
            executor.CACHE.clear()
            HUB.emit("nodes", {"count": len(registry.NODES)})
            return self.json({"count": len(registry.NODES)})
        if u.path == "/api/settings":
            pub = providers.update(data)
            registry.load_all(ROOT, log)  # список провайдеров в нодах LLM
            HUB.emit("nodes", {"count": len(registry.NODES)})
            return self.json(pub)
        self.json({"error": f"нет такого пути {u.path}"}, 404)

    def events(self):
        self._head(200, "text/event-stream; charset=utf-8", extra={"cache-control": "no-cache", "connection": "keep-alive"})
        q = HUB.add()
        try:
            self.wfile.write(f"event: status\ndata: {json.dumps(Q.status())}\n\n".encode())
            run = Q.running  # окно подключилось посреди запуска — дослать его ход, иначе граф не знает, где он
            for msg in run.replay() if run else []:
                self.wfile.write(msg)
            self.wfile.flush()
            while True:
                try:
                    msg = q.get(timeout=15)
                except queue.Empty:
                    msg = b": ping\n\n"
                self.wfile.write(msg)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            HUB.remove(q)
            self.close_connection = True


def low_memory(text):
    """sysmon: свободной RAM меньше запаса — остановить текущий запуск (один раз)."""
    run = Q.running if Q else None
    if run and not run.cancel.is_set():
        log("error", text)
        run.emit("log", {"node": None, "level": "error", "text": text})
        Q.interrupt()


class Server(ThreadingHTTPServer):
    def handle_error(self, request, client_address):
        # клиент ушёл, не дождавшись ответа (перезагрузка страницы, закрытое окно) — не ошибка сервера
        if isinstance(sys.exc_info()[1], (ConnectionAbortedError, ConnectionResetError, BrokenPipeError)):
            return
        super().handle_error(request, client_address)


def main():
    global Q, BIND_HOST
    ap = argparse.ArgumentParser(description="maistep server")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT", 3300)))
    ap.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    a = ap.parse_args()
    BIND_HOST = a.host
    lifetime.bind()  # до любых дочерних процессов: они не переживут сервер
    logs.setup()
    sysmon.configure(lambda: Q.running if Q else None, low_memory, lambda level, text: log("info", f"[{level}] {text}"))
    sysmon.start()
    registry.load_all(ROOT, log)
    updater.configure(lambda event, data: HUB.emit(event, data), log)
    updater.start()
    outputs.organize(ROOT, lambda t: log("info", t))  # до загрузки истории: она уже с новыми путями
    Q = Queue()
    agent.configure(lambda event, data: HUB.emit(event, data), lambda wf, pid: Q.put(wf, pid),
                    lambda: list(Q.history), Q.interrupt)
    # на Windows SO_REUSEADDR позволяет второму процессу тихо занять тот же порт — пусть лучше упадёт с ошибкой
    ThreadingHTTPServer.allow_reuse_address = os.name != "nt"
    srv = Server((a.host, a.port), Handler)
    srv.daemon_threads = True
    log("info", f"maistep server: http://{a.host}:{a.port}  (Python {sys.version.split()[0]}, проект {ROOT})")
    import atexit
    atexit.register(mcp.stop_all)
    atexit.register(llamacpp.stop)
    atexit.register(agent.procs.stop_all)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
