"""MCP-клиент для AI Chat: внешние серверы инструментов (Model Context Protocol), как в Claude Desktop.

Настройки — user/settings.json "mcp": { "servers": { "<имя>": {
    command, args: [...], env: {...}, cwd   — локальный сервер (stdio, JSON-RPC построчно)
    url, headers: {...}                     — удалённый (Streamable HTTP: POST, ответ JSON или SSE)
    enabled: true } } }
Формат совместим с mcpServers Claude Desktop — его можно вставить целиком (import_json).
Серверы запускаются лениво (первый диалог, которому они нужны) и живут до остановки сервера maistep или правки настроек.
Инструменты уходят модели как mcp__<сервер>__<инструмент>; картинки из ответов сохраняются в input/ — их видно модели.
"""
import base64
import itertools
import json
import os
import re
import shutil
import subprocess
import threading
import urllib.error
import urllib.request
import uuid
from collections import deque
from pathlib import Path

from . import lifetime
from . import providers as P

ROOT = Path(__file__).resolve().parents[2]
PROTOCOL = "2025-06-18"
_lock = threading.Lock()
_clients = {}  # имя → Client


def config():
    return (P.load_settings().get("mcp") or {}).get("servers") or {}


def save_config(servers):
    s = P.load_settings()
    s.setdefault("mcp", {})["servers"] = servers
    P.save_settings(s)
    restart_changed(servers)
    return status()


def import_json(text):
    """{"mcpServers": {...}} Claude Desktop / Cursor или просто {имя: {...}} → добавить к своим."""
    d = json.loads(text)
    d = d.get("mcpServers") or d.get("servers") or d
    if not isinstance(d, dict):
        raise ValueError("ожидается объект { имя: { command, args } }")
    cur = config()
    for name, c in d.items():
        if isinstance(c, dict) and (c.get("command") or c.get("url")):
            cur[_safe_name(name)] = {k: c[k] for k in ("command", "args", "env", "cwd", "url", "headers") if k in c} | {"enabled": c.get("enabled", True)}
    return save_config(cur)


def _safe_name(name):
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(name))[:40] or "server"


# ---------- клиент ----------
class Client:
    def __init__(self, name, cfg):
        self.name, self.cfg = name, dict(cfg)
        self.proc = None
        self.session = None
        self.tools = []
        self.error = None
        self.state = "stopped"  # stopped | starting | ready | error
        self.stderr = deque(maxlen=60)
        self._ids = itertools.count(1)
        self._wait = {}
        self._wlock = threading.Lock()
        self._start_lock = threading.Lock()
        self.info = {}

    # --- транспорт ---
    def _spawn(self):
        c = self.cfg
        cmd = str(c["command"])
        exe = shutil.which(cmd) or cmd
        env = {**os.environ, **{k: str(v) for k, v in (c.get("env") or {}).items()}}
        args = [str(a) for a in c.get("args") or []]
        if os.name == "nt" and exe.lower().endswith((".cmd", ".bat")):
            argv = ["cmd", "/c", exe, *args]
        else:
            argv = [exe, *args]
        self.proc = lifetime.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   cwd=c.get("cwd") or None, env=env, bufsize=0)
        threading.Thread(target=self._read_out, daemon=True).start()
        threading.Thread(target=self._read_err, daemon=True).start()

    def _read_out(self):
        for raw in self.proc.stdout:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except ValueError:
                self.stderr.append(line[:400])
                continue
            self._deliver(msg)
        for w in list(self._wait.values()):
            w["ev"].set()

    def _read_err(self):
        for raw in self.proc.stderr:
            self.stderr.append(raw.decode("utf-8", "replace").rstrip()[:400])

    def _deliver(self, msg):
        if isinstance(msg, list):
            for m in msg:
                self._deliver(m)
            return
        if "id" in msg and ("result" in msg or "error" in msg):
            w = self._wait.get(msg["id"])
            if w:
                w["res"] = msg
                w["ev"].set()
        elif "id" in msg and "method" in msg:  # запрос сервера (ping, roots/list…) — отвечаем минимально
            res = {"roots": []} if msg["method"] == "roots/list" else {}
            self._send({"jsonrpc": "2.0", "id": msg["id"], "result": res})

    def _send(self, msg):
        data = (json.dumps(msg, ensure_ascii=False) + "\n").encode()
        with self._wlock:
            self.proc.stdin.write(data)
            self.proc.stdin.flush()

    def _http(self, msg, timeout):
        c = self.cfg
        h = {"content-type": "application/json", "accept": "application/json, text/event-stream",
             "mcp-protocol-version": PROTOCOL, **{k: str(v) for k, v in (c.get("headers") or {}).items()}}
        if self.session:
            h["mcp-session-id"] = self.session
        req = urllib.request.Request(c["url"], data=json.dumps(msg).encode(), headers=h, method="POST")
        try:
            r = urllib.request.urlopen(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"HTTP {e.code}: {e.read().decode('utf-8', 'replace')[:300]}") from None
        with r:
            self.session = r.headers.get("mcp-session-id") or self.session
            if "id" not in msg:
                return None
            if "text/event-stream" in (r.headers.get("content-type") or ""):
                for raw in r:
                    line = raw.decode("utf-8", "replace").strip()
                    if line.startswith("data:"):
                        try:
                            m = json.loads(line[5:].strip())
                        except ValueError:
                            continue
                        if isinstance(m, dict) and m.get("id") == msg["id"]:
                            return m
                raise RuntimeError("SSE stream ended without a response")
            body = r.read()
            return json.loads(body) if body else None

    def request(self, method, params=None, timeout=60):
        mid = next(self._ids)
        msg = {"jsonrpc": "2.0", "id": mid, "method": method, "params": params or {}}
        if self.cfg.get("url"):
            res = self._http(msg, timeout)
        else:
            if not self.proc or self.proc.poll() is not None:
                raise RuntimeError("server process is not running")
            w = self._wait[mid] = {"ev": threading.Event(), "res": None}
            try:
                self._send(msg)
                if not w["ev"].wait(timeout):
                    raise TimeoutError(f"{self.name}: {method} — no answer in {timeout}s")
                res = w["res"]
            finally:
                self._wait.pop(mid, None)
            if res is None:
                raise RuntimeError(f"{self.name} exited: {' | '.join(list(self.stderr)[-3:])}")
        if res and res.get("error"):
            e = res["error"]
            raise RuntimeError(f"{e.get('message')} ({e.get('code')})")
        return (res or {}).get("result") or {}

    def notify(self, method, params=None):
        msg = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if self.cfg.get("url"):
            self._http(msg, 15)
        else:
            self._send(msg)

    # --- жизненный цикл ---
    def ensure(self):
        with self._start_lock:
            if self.state == "ready" and (self.cfg.get("url") or (self.proc and self.proc.poll() is None)):
                return self
            self.state, self.error = "starting", None
            try:
                if not self.cfg.get("url"):
                    self._spawn()
                r = self.request("initialize", {"protocolVersion": PROTOCOL, "capabilities": {"roots": {"listChanged": False}},
                                                "clientInfo": {"name": "maistep", "version": "1"}}, timeout=60)
                self.info = r.get("serverInfo") or {}
                self.notify("notifications/initialized")
                tools, cursor = [], None
                while True:
                    page = self.request("tools/list", {"cursor": cursor} if cursor else {}, timeout=60)
                    tools += page.get("tools") or []
                    cursor = page.get("nextCursor")
                    if not cursor:
                        break
                self.tools = tools
                self.state = "ready"
            except Exception as e:
                self.state, self.error = "error", f"{type(e).__name__}: {e}"
                tail = " | ".join(list(self.stderr)[-3:])
                if tail:
                    self.error += f" — {tail}"
                self.stop(keep_state=True)
                raise RuntimeError(f"MCP {self.name}: {self.error}") from None
        return self

    def stop(self, keep_state=False):
        p, self.proc = self.proc, None
        if p and p.poll() is None:
            try:
                p.stdin.close()
                p.wait(2)
            except Exception:
                pass
            if p.poll() is None:
                lifetime.kill(p)
        if p:
            lifetime.release(p)
        self.session = None
        if not keep_state:
            self.state = "stopped"

    def call(self, tool, args, timeout=600):
        self.ensure()
        return self.request("tools/call", {"name": tool, "arguments": args or {}}, timeout=timeout)


# ---------- менеджер ----------
def client(name):
    cfg = config().get(name)
    if not cfg:
        raise KeyError(f"нет MCP-сервера {name}")
    with _lock:
        c = _clients.get(name)
        if not c or c.cfg != cfg:
            if c:
                c.stop()
            c = _clients[name] = Client(name, cfg)
    return c


def restart_changed(servers):
    with _lock:
        for name, c in list(_clients.items()):
            if servers.get(name) != c.cfg:
                c.stop()
                _clients.pop(name, None)


def stop_all():
    with _lock:
        for c in _clients.values():
            c.stop()
        _clients.clear()


def enabled():
    return [n for n, c in config().items() if c.get("enabled", True)]


def status():
    out = []
    for name, cfg in config().items():
        c = _clients.get(name)
        out.append({"name": name, "enabled": cfg.get("enabled", True), "kind": "http" if cfg.get("url") else "stdio",
                    "command": cfg.get("url") or " ".join([str(cfg.get("command") or "")] + [str(a) for a in cfg.get("args") or []]),
                    "state": c.state if c else "stopped", "error": c.error if c else None,
                    "tools": [{"name": t["name"], "description": (t.get("description") or "")[:200]} for t in (c.tools if c else [])],
                    "tokens": tool_tokens(c.tools) if c else 0, "server": (c.info if c else {})})
    return {"servers": out}


def test(name):
    c = client(name)
    c.stop()
    c.ensure()
    return status()


def cached_tokens(names):
    """Оценка токенов инструментов уже запущенных серверов (не запускает их) → {имя: токены|None}."""
    return {n: (tool_tokens(_clients[n].tools) if n in _clients and _clients[n].state == "ready" else None) for n in names}


def tool_tokens(tools):
    return sum(len(json.dumps(t, ensure_ascii=False)) for t in tools or []) // 4


def _tool_name(server, tool):
    return f"mcp__{_safe_name(server)}__{re.sub(r'[^A-Za-z0-9_-]', '_', tool)}"[:64]


def tools_for(names):
    """Инструменты включённых серверов в формате Anthropic (+ карта имя → (сервер, инструмент)).
    Сервер, который не запустился, пропускается — его ошибка видна в правой панели."""
    defs, mapping, errors = [], {}, []
    for name in names:
        try:
            c = client(name).ensure()
        except Exception as e:
            errors.append(str(e))
            continue
        for t in c.tools:
            n = _tool_name(name, t["name"])
            mapping[n] = (name, t["name"])
            schema = t.get("inputSchema") or {"type": "object", "properties": {}}
            if schema.get("type") != "object":
                schema = {"type": "object", "properties": {}}
            defs.append({"name": n, "description": f"[MCP {name}] {(t.get('description') or t['name'])[:900]}", "input_schema": schema})
    return defs, mapping, errors


def call(server, tool, args):
    """→ (текст, [картинки input/…])"""
    r = client(server).call(tool, args)
    parts, images = [], []
    for c in r.get("content") or []:
        t = c.get("type")
        if t == "text":
            parts.append(c.get("text") or "")
        elif t == "image" and c.get("data"):
            ext = {"image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}.get(c.get("mimeType"), "png")
            rel = f"input/mcp_{uuid.uuid4().hex[:10]}.{ext}"
            (ROOT / "input").mkdir(exist_ok=True)
            (ROOT / rel).write_bytes(base64.b64decode(c["data"]))
            images.append(rel)
            parts.append(f"[image {rel}]")
        elif t == "resource":
            res = c.get("resource") or {}
            parts.append(res.get("text") or f"[resource {res.get('uri')}]")
        elif t == "resource_link":
            parts.append(f"[resource {c.get('uri')}] {c.get('name') or ''}")
    if r.get("structuredContent") and not parts:
        parts.append(json.dumps(r["structuredContent"], ensure_ascii=False))
    text = "\n".join(parts) or "ok"
    if r.get("isError"):
        raise RuntimeError(text[:4000])
    return text, images
