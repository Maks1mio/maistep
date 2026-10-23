"""Обновления maistep из GitHub Releases — только изменившиеся файлы, в фоне, пока редактор работает.

Релиз (scripts/release.mjs) несёт manifest.json: версия, тег и sha256/размер каждого файла приложения
(app/ui, server, mcp, defaults, …) плюс sha256 maistep.exe и «отпечаток» исходников Rust (exe.source).
Проверка сравнивает манифест с файлами на диске: качаются только отличающиеся — с raw.githubusercontent.com
по тегу релиза; maistep.exe (ассет релиза) — только если изменился Rust. Всё складывается в update/staging/
с проверкой sha256 (прерванная загрузка продолжается с того же места), затем пишется update/pending.json.
Применяет ядро при следующем старте (app/src-tauri/src/update.rs): «Перезапустить» в «Компонентах» или
просто следующий запуск. Пользовательские папки (workflows, user, input, output, .venv) не трогаются никогда.

В git-копии (есть .git) загрузка выключена — обновлятор переписал бы рабочие файлы; MAISTEP_UPDATE_DEV=1
снимает запрет (для проверки). Настройки — user/settings.json → "update": {"auto": true, "token": ""};
token нужен, только пока репозиторий приватный.
"""
import concurrent.futures as futures
import hashlib
import json
import os
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / "update"
STAGING = DIR / "staging"
PENDING = DIR / "pending.json"
APPLIED = DIR / "applied.json"
LOCAL = ROOT / "manifest.json"
API = "https://api.github.com/repos/{repo}/releases?per_page=20"
RAW = "https://raw.githubusercontent.com/{repo}/{tag}/{path}"
UA = "maistep-updater/1.0"
CHECK_EVERY = 6 * 3600

_emit = lambda event, data: None  # задаёт main.py (SSE-хаб)
_log = lambda level, text: None
_lock = threading.Lock()
_state = {"status": "idle"}
_remote = None   # {"release": {...}, "manifest": {...}, "plan": {...}}
_worker = None


def configure(emitter, logger):
    global _emit, _log
    _emit, _log = emitter, logger


def _read_json(path, default):
    try:
        return json.loads(Path(path).read_text("utf-8"))
    except (OSError, ValueError):
        return default


def _settings():
    return (_read_json(ROOT / "user" / "settings.json", {}).get("update") or {})


def _vkey(v):
    try:
        return tuple(int(x) for x in str(v).lstrip("vV").split("+")[0].split("."))
    except ValueError:
        return ()


def dev_mode():
    return (ROOT / ".git").exists() and os.environ.get("MAISTEP_UPDATE_DEV") != "1"


def repo():
    return ((_read_json(ROOT / "components.json", {}).get("app") or {}).get("repo") or "").strip()


def installed_version():
    v = _read_json(LOCAL, {}).get("version")
    if v:
        return str(v)
    for p, key in ((ROOT / "app" / "src-tauri" / "tauri.conf.json", "version"), (ROOT / "package.json", "version")):
        if v := _read_json(p, {}).get(key):
            return str(v)
    return "0.0.0"


def _set(**kw):
    with _lock:
        _state.update(kw)
        snap = dict(_state)
    _emit("update", snap)
    return snap


def status():
    with _lock:
        snap = dict(_state)
    snap.update({"installed": installed_version(), "dev": dev_mode(), "repo": repo(),
                 "auto": _settings().get("auto", True) is not False, "last": _read_json(APPLIED, None)})
    return snap


# ---------- сеть ----------
def _open(url, accept=None, timeout=30):
    headers = {"User-Agent": UA}
    if accept:
        headers["Accept"] = accept
    token = str(_settings().get("token") or "").strip()
    host = urllib.parse.urlparse(url).hostname or ""
    if token and host in ("api.github.com", "raw.githubusercontent.com"):
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout)


def _asset(release, name):
    return next((a for a in release.get("assets") or [] if a.get("name") == name), None)


def _latest_release(r):
    with _open(API.format(repo=r), "application/vnd.github+json") as resp:
        rels = json.loads(resp.read().decode("utf-8"))
    best = None
    for rel in rels or []:
        if not isinstance(rel, dict) or rel.get("draft") or rel.get("prerelease") or not _asset(rel, "manifest.json"):
            continue
        if _vkey(rel.get("tag_name")) and (best is None or _vkey(rel["tag_name"]) > _vkey(best["tag_name"])):
            best = rel
    return best


def _download_asset(asset, dest=None):
    # API-адрес ассета с Accept: octet-stream работает и для приватного репозитория (с токеном)
    with _open(asset["url"], "application/octet-stream", timeout=120) as resp:
        if dest is None:
            return resp.read()
        with open(dest, "wb") as f:
            while chunk := resp.read(1 << 16):
                f.write(chunk)
                _progress(len(chunk))


# ---------- план ----------
def _sha(path):
    try:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            while chunk := f.read(1 << 16):
                h.update(chunk)
        return h.hexdigest()
    except OSError:
        return None


def plan(remote, root=ROOT):
    """Что качать: файлы, отличающиеся от манифеста; что удалить: файлы старой версии, которых больше нет
    (только нетронутые пользователем); exe — если изменились исходники Rust."""
    local = _read_json(root / "manifest.json", {})
    files = [p for p, m in (remote.get("files") or {}).items() if _sha(root / p) != m.get("sha256")]
    old = local.get("files") or {}
    remove = [p for p, m in old.items() if p not in (remote.get("files") or {}) and _sha(root / p) == m.get("sha256")]
    rexe, lexe = remote.get("exe") or {}, local.get("exe") or {}
    exe = bool(rexe.get("sha256")) and rexe.get("source") != lexe.get("source")
    size = sum(int(remote["files"][p].get("size") or 0) for p in files) + (int(rexe.get("size") or 0) if exe else 0)
    return {"files": files, "remove": remove, "exe": exe, "bytes": size}


def check():
    global _remote
    r = repo()
    if not r:
        return _set(status="error", error="в components.json не указан app.repo")
    _set(status="checking", error=None)
    try:
        rel = _latest_release(r)
        if not rel or _vkey(rel["tag_name"]) <= _vkey(installed_version()):
            _remote = None
            return _set(status="uptodate", checked_at=time.time(), version=None)
        manifest = json.loads(_download_asset(_asset(rel, "manifest.json")).decode("utf-8"))
        p = plan(manifest)
        _remote = {"release": rel, "manifest": manifest, "plan": p}
        ready = _read_json(PENDING, {}).get("version") == manifest.get("version")
        return _set(status="ready" if ready else "available", checked_at=time.time(), version=manifest.get("version"),
                    tag=rel["tag_name"], notes=rel.get("body") or "", url=rel.get("html_url"),
                    files=len(p["files"]), remove=len(p["remove"]), exe=p["exe"], bytes=p["bytes"], done=0)
    except Exception as e:
        return _set(status="error", error=f"{type(e).__name__}: {e}", checked_at=time.time())


# ---------- загрузка ----------
_done = {"n": 0, "at": 0}


def _progress(n):
    _done["n"] += n
    if time.time() - _done["at"] > 0.3:
        _done["at"] = time.time()
        _set(done=_done["n"])


def _fetch_file(r, tag, path, meta):
    dest = STAGING / path
    if _sha(dest) == meta["sha256"]:
        _progress(int(meta.get("size") or 0))
        return
    url = RAW.format(repo=r, tag=urllib.parse.quote(tag), path=urllib.parse.quote(path))
    with _open(url) as resp:
        data = resp.read()
    if hashlib.sha256(data).hexdigest() != meta["sha256"]:
        raise ValueError(f"{path}: контрольная сумма не совпала")
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(dest)
    _progress(len(data))


def _run_download(remote):
    rel, manifest, p = remote["release"], remote["manifest"], remote["plan"]
    r, tag = repo(), manifest.get("tag") or rel["tag_name"]
    _done.update(n=0, at=0)
    try:
        STAGING.mkdir(parents=True, exist_ok=True)
        with futures.ThreadPoolExecutor(8) as pool:
            for f in [pool.submit(_fetch_file, r, tag, path, manifest["files"][path]) for path in p["files"]]:
                f.result()
        if p["exe"]:
            exe = STAGING / "maistep.exe"
            if _sha(exe) != manifest["exe"]["sha256"]:
                _download_asset(_asset(rel, "maistep.exe"), exe)
                if _sha(exe) != manifest["exe"]["sha256"]:
                    exe.unlink(missing_ok=True)
                    raise ValueError("maistep.exe: контрольная сумма не совпала")
        pending = {"version": manifest.get("version"), "files": p["files"], "remove": p["remove"], "exe": p["exe"],
                   "manifest": manifest}
        tmp = PENDING.with_suffix(".tmp")
        tmp.write_text(json.dumps(pending, ensure_ascii=False), "utf-8")
        tmp.replace(PENDING)
        _log("info", f"обновление {manifest.get('version')} скачано ({len(p['files'])} файл(ов)) — применится при перезапуске")
        _set(status="ready", done=p["bytes"])
    except Exception as e:
        _set(status="error", error=f"{type(e).__name__}: {e}")


def download():
    global _worker
    if dev_mode():
        return {"error": "git-копия: обновление выключено (обновляйте через git pull)"}
    if not _remote:
        return {"error": "нет доступного обновления — сначала проверьте"}
    if _worker and _worker.is_alive():
        return status()
    _set(status="downloading", error=None, done=0)
    _worker = threading.Thread(target=_run_download, args=(_remote,), daemon=True)
    _worker.start()
    return status()


# ---------- фон ----------
def _loop():
    time.sleep(15)
    while True:
        st = check()
        if st.get("status") == "available" and not dev_mode() and _settings().get("auto", True) is not False:
            download()
        time.sleep(CHECK_EVERY)


def start():
    last = _read_json(APPLIED, None)
    if isinstance(last, dict) and not last.get("seen"):
        if last.get("ok"):
            _log("info", f"maistep обновлён до {last.get('version')}")
        else:
            _log("error", f"обновление {last.get('version') or ''} не применилось: {last.get('error')}")
        last["seen"] = True
        try:
            APPLIED.write_text(json.dumps(last, ensure_ascii=False), "utf-8")
        except OSError:
            pass
    threading.Thread(target=_loop, daemon=True).start()
