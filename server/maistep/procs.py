"""Фоновые процессы агента (режим Code): dev-серверы, watch-сборки, долгие команды — как «Серверы» в Claude.

run_command { background: true } запускает команду и сразу возвращает id; вывод копится (последние 2000 строк),
порт ловится из вывода («localhost:5173»), строки уходят в консоль приложения (SSE agent/proc_log, источник «agent»).
Остановка убивает всё дерево процессов (taskkill /T на Windows, группа процессов в POSIX). При выходе сервера — все.
"""
import os
import re
import signal
import subprocess
import threading
import time
import uuid
from collections import deque

from . import lifetime

NO_WINDOW = lifetime.NO_WINDOW
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07")  # цвета и заголовки терминала
PORT = re.compile(r"(?:https?://)?(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})")
_procs = {}
_lock = threading.Lock()
_emit = lambda event, data: None  # noqa: E731


def configure(emitter):
    global _emit
    _emit = emitter


def _summary(p):
    return {"id": p["id"], "chat": p["chat"], "command": p["command"], "cwd": p["cwd"], "started": p["started"],
            "port": p["port"], "running": p["proc"].poll() is None, "code": p["proc"].poll(), "lines": len(p["out"])}


def _pump(p):
    buf, last = [], time.time()
    for raw in p["proc"].stdout:
        line = ANSI.sub("", raw.decode("utf-8", "replace")).rstrip()
        p["out"].append(line)
        if not p["port"]:
            m = PORT.search(line)
            if m:
                p["port"] = int(m.group(1))
                _emit("agent", {"chat": p["chat"], "kind": "proc", "proc": _summary(p)})
        buf.append(line)
        if time.time() - last > 0.4 or len(buf) > 40:
            _emit("agent", {"chat": p["chat"], "kind": "proc_log", "id": p["id"], "lines": buf[-40:]})
            buf, last = [], time.time()
    p["proc"].wait()
    lifetime.release(p["proc"])
    if buf:
        _emit("agent", {"chat": p["chat"], "kind": "proc_log", "id": p["id"], "lines": buf[-40:]})
    p["out"].append(f"[завершён, код {p['proc'].returncode}]")
    _emit("agent", {"chat": p["chat"], "kind": "proc", "proc": _summary(p)})


def start(command, cwd, chat, env=None):
    proc = lifetime.Popen(command, shell=True, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          stdin=subprocess.DEVNULL)
    p = {"id": uuid.uuid4().hex[:8], "chat": chat, "command": command, "cwd": str(cwd), "started": time.time(),
         "port": None, "proc": proc, "out": deque(maxlen=2000)}
    with _lock:
        _procs[p["id"]] = p
    threading.Thread(target=_pump, args=(p,), daemon=True).start()
    _emit("agent", {"chat": chat, "kind": "proc", "proc": _summary(p)})
    return p


def get(pid):
    p = _procs.get(pid)
    if not p:
        raise KeyError(f"нет процесса {pid}")
    return p


def output(pid, tail=200):
    p = get(pid)
    lines = list(p["out"])[-max(1, min(2000, int(tail or 200))):]
    return {**_summary(p), "output": "\n".join(lines)}


def stop(pid):
    p = get(pid)
    pr = p["proc"]
    if pr.poll() is None:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(pr.pid)], capture_output=True, creationflags=NO_WINDOW)
        else:
            try:
                os.killpg(pr.pid, signal.SIGTERM)
            except OSError:
                pr.kill()
        try:
            pr.wait(5)
        except subprocess.TimeoutExpired:
            pr.kill()
    return _summary(p)


def forget(pid):
    """Убрать завершённый процесс из списка (работающий — сначала остановить)."""
    p = get(pid)
    if p["proc"].poll() is None:
        raise RuntimeError("процесс ещё работает — сначала остановите его")
    with _lock:
        _procs.pop(pid, None)
    _emit("agent", {"chat": p["chat"], "kind": "proc_gone", "id": pid})
    return {"ok": True}


def listing(chat=None):
    with _lock:
        items = list(_procs.values())
    # завершённые старше часа не показываем
    now = time.time()
    return [_summary(p) for p in items if (chat is None or p["chat"] == chat)
            and (p["proc"].poll() is None or now - p["started"] < 3600)]


def stop_all():
    for p in list(_procs.values()):
        try:
            stop(p["id"])
        except Exception:
            pass
