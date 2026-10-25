"""Локальный llama.cpp (llama-server) для AI Chat: запуск, остановка, состояние.

Настройки — user/settings.json "llamacpp": { bin — путь к llama-server(.exe), model — .gguf, ctx, ngl (слоёв на GPU),
port, extra — доп. аргументы строкой, autostart — поднимать сам при первом сообщении }.
llama-server отдаёт OpenAI-совместимый API (/v1/chat/completions с инструментами при --jinja, /v1/models) — поэтому
провайдер llamacpp ходит туда как openai (providers.route). Модель одна — та, с которой запущен сервер.
"""
import json
import os
import shlex
import shutil
import subprocess
import threading
import time
import urllib.request
from collections import deque
from pathlib import Path

from . import library as L
from . import providers as P

NO_WINDOW = 0x08000000 if os.name == "nt" else 0
DEFAULTS = {"bin": "", "model": "", "ctx": 16384, "ngl": 99, "port": 8088, "extra": "", "autostart": True}
_state = {"proc": None, "log": deque(maxlen=200), "started": 0, "args": None}
_lock = threading.Lock()


def config():
    return {**DEFAULTS, **(P.load_settings().get("llamacpp") or {})}


def save(d):
    s = P.load_settings()
    cur = {**DEFAULTS, **(s.get("llamacpp") or {})}
    for k in DEFAULTS:
        if k in d:
            cur[k] = d[k]
    for k in ("ctx", "ngl", "port"):
        cur[k] = int(cur[k] or DEFAULTS[k])
    cur["autostart"] = bool(cur["autostart"])
    s["llamacpp"] = cur
    P.save_settings(s)
    P.invalidate("llamacpp")
    return status()


def base_url(cfg=None):
    return f"http://127.0.0.1:{(cfg or config())['port']}"


def find_bin(cfg=None):
    b = (cfg or config()).get("bin") or ""
    if b and Path(b).is_file():
        return b
    if b and Path(b).is_dir():
        for n in ("llama-server.exe", "llama-server"):
            if (Path(b) / n).is_file():
                return str(Path(b) / n)
    return shutil.which("llama-server") or ""


def ggufs():
    """.gguf из папок моделей библиотеки (категории llm / text_encoders / любые) — для выбора в настройках."""
    seen, out = set(), []
    try:
        roots = {Path(r["path"]) for r in L.sources()[0] if r.get("exists")}
    except Exception:
        roots = set()
    extra = config().get("model")
    if extra:
        roots.add(Path(extra).parent)
    for base in roots:
        for dp, dirs, files in os.walk(base):
            dirs[:] = [d for d in dirs if not d.startswith(".")]
            for f in files:
                if f.lower().endswith(".gguf") and "mmproj" not in f.lower():
                    p = str(Path(dp) / f)
                    if p not in seen:
                        seen.add(p)
                        out.append({"path": p, "name": f, "size": os.path.getsize(p)})
            if len(out) > 400:
                break
    return sorted(out, key=lambda x: x["name"].lower())


def running():
    p = _state["proc"]
    return bool(p and p.poll() is None)


def healthy(cfg=None):
    try:
        with urllib.request.urlopen(f"{base_url(cfg)}/health", timeout=2) as r:
            return r.status == 200
    except Exception:
        return False


def status():
    cfg = config()
    run = running()
    out = {"config": cfg, "bin_found": find_bin(cfg), "running": run, "external": False, "ready": False,
           "pid": _state["proc"].pid if run else None, "log": list(_state["log"])[-40:], "base_url": f"{base_url(cfg)}/v1"}
    out["ready"] = healthy(cfg) if run or not _state["proc"] else False
    out["external"] = out["ready"] and not run  # сервер поднят не нами (вручную)
    if out["ready"]:
        try:
            with urllib.request.urlopen(f"{base_url(cfg)}/props", timeout=2) as r:
                pr = json.loads(r.read())
            out["n_ctx"] = (pr.get("default_generation_settings") or {}).get("n_ctx")
            out["model_path"] = pr.get("model_path")
        except Exception:
            pass
    return out


def _pump(proc):
    for raw in proc.stdout:
        _state["log"].append(raw.decode("utf-8", "replace").rstrip()[:300])


def start(wait=0):
    with _lock:
        if running():
            return status()
        cfg = config()
        exe = find_bin(cfg)
        if not exe:
            raise RuntimeError("не найден llama-server — укажите путь в Настройки → llama.cpp")
        if not cfg["model"] or not Path(cfg["model"]).is_file():
            raise RuntimeError("не выбрана модель .gguf — Настройки → llama.cpp")
        args = [exe, "-m", cfg["model"], "-c", str(cfg["ctx"]), "-ngl", str(cfg["ngl"]), "--host", "127.0.0.1",
                "--port", str(cfg["port"]), "--jinja"] + shlex.split(cfg.get("extra") or "", posix=os.name != "nt")
        _state["log"].clear()
        _state["log"].append("$ " + " ".join(args))
        _state["proc"] = subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                                          creationflags=NO_WINDOW, cwd=str(Path(exe).parent))
        _state["started"], _state["args"] = time.time(), args
        threading.Thread(target=_pump, args=(_state["proc"],), daemon=True).start()
    t0 = time.time()
    while wait and time.time() - t0 < wait:
        if not running():
            raise RuntimeError("llama-server завершился: " + " | ".join(list(_state["log"])[-4:]))
        if healthy(cfg):
            break
        time.sleep(0.5)
    P.invalidate("llamacpp")
    return status()


def stop():
    with _lock:
        p, _state["proc"] = _state["proc"], None
        if p and p.poll() is None:
            p.terminate()
            try:
                p.wait(5)
            except subprocess.TimeoutExpired:
                p.kill()
    return status()


def ensure():
    """Перед ходом агента: сервер не отвечает, а в настройках есть модель и autostart — поднять и дождаться."""
    cfg = config()
    if healthy(cfg):
        return
    if not cfg.get("autostart") or not cfg.get("model"):
        raise RuntimeError(f"llama.cpp не отвечает на {base_url(cfg)} — запустите его (Настройки → llama.cpp)")
    start(wait=300)
    if not healthy(cfg):
        raise RuntimeError("llama-server не поднялся за 5 минут: " + " | ".join(list(_state["log"])[-4:]))
