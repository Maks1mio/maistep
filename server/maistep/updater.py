"""Обновления maistep из GitHub Releases — только изменившиеся файлы, в фоне, пока редактор работает.

Релиз (scripts/release.mjs) несёт один файл обновления для всех систем — maistep-<версия>-update.mai:
    "MAIUPD01" | u32 длина оглавления | оглавление (JSON) | данные
Оглавление — манифест: версия, тег, sha256/размер каждого файла приложения (app/ui, server, mcp, defaults, …)
и бинари по платформам (bin: {"windows-x86_64": maistep.exe, "linux-x86_64": maistep.AppImage}) с «отпечатком»
исходников Rust (source); у каждой записи — смещение и размер её данных (deflate, у бинарей z=false — как есть).
Обновлятор читает только оглавление (HTTP Range), сравнивает с файлами на диске и докачивает куски файла
обновления: отличающиеся файлы и бинарь своей платформы — только если изменился Rust. Всё складывается
в update/staging/ с проверкой sha256 (уже скачанное не качается снова), затем пишется update/pending.json.
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
import platform
import struct
import sys
import threading
import time
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / "update"
STAGING = DIR / "staging"
PENDING = DIR / "pending.json"
APPLIED = DIR / "applied.json"
LOCAL = ROOT / "manifest.json"
API = "https://api.github.com/repos/{repo}/releases?per_page=20"
UA = "maistep-updater/2.0"
MAGIC = b"MAIUPD01"
CHECK_EVERY = 3600  # раз в час: лимит GitHub API без токена — 60 запросов в час с IP
GAP = 256 * 1024    # соседние куски ближе этого качаются одним запросом
HEAD = 256 * 1024   # первый запрос: оглавление обычно меньше


def platform_key():
    osname = "windows" if sys.platform == "win32" else "macos" if sys.platform == "darwin" else "linux"
    arch = {"amd64": "x86_64", "x86_64": "x86_64", "arm64": "aarch64", "aarch64": "aarch64"}.get(platform.machine().lower(), platform.machine().lower())
    return f"{osname}-{arch}"


_emit = lambda event, data: None  # задаёт main.py (SSE-хаб)
_log = lambda level, text: None
_lock = threading.Lock()
_state = {"status": "idle"}
_remote = None   # {"release": {...}, "asset": {...}, "manifest": {...}, "base": int, "plan": {...}}
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
    for p, key in ((ROOT / "package.json", "version"), (ROOT / "app" / "src-tauri" / "tauri.conf.json", "version")):
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
    snap.update({"installed": installed_version(), "dev": dev_mode(), "repo": repo(), "platform": platform_key(),
                 "auto": _settings().get("auto", True) is not False, "last": _read_json(APPLIED, None)})
    return snap


# ---------- сеть ----------
def _open(url, accept=None, timeout=30, rng=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    if accept:
        req.add_header("Accept", accept)
    if rng:
        req.add_header("Range", f"bytes={rng[0]}-{rng[1]}")
    token = str(_settings().get("token") or "").strip()
    if token and (urllib.parse.urlparse(url).hostname or "") == "api.github.com":
        # не уходит на хранилище после редиректа (подписанный URL с чужим токеном отвечает 400)
        req.add_unredirected_header("Authorization", f"Bearer {token}")
    return urllib.request.urlopen(req, timeout=timeout)


def _update_asset(release):
    return next((a for a in release.get("assets") or [] if str(a.get("name") or "").endswith("-update.mai")), None)


def _latest_release(r):
    with _open(API.format(repo=r), "application/vnd.github+json") as resp:
        rels = json.loads(resp.read().decode("utf-8"))
    best = None
    for rel in rels or []:
        if not isinstance(rel, dict) or rel.get("draft") or rel.get("prerelease") or not _update_asset(rel):
            continue
        if _vkey(rel.get("tag_name")) and (best is None or _vkey(rel["tag_name"]) > _vkey(best["tag_name"])):
            best = rel
    return best


def _range(asset, start, end, sink=None):
    """Байты [start, end] ассета (API-адрес с Accept: octet-stream работает и для приватного репозитория).
    sink(chunk) — потоком, без накопления в памяти."""
    out = []
    with _open(asset["url"], "application/octet-stream", timeout=120, rng=(start, end)) as resp:
        skip = start if resp.status == 200 else 0  # сервер без Range — пропускаем начало сами
        left = end - start + 1
        while left > 0:
            chunk = resp.read(1 << 16)
            if not chunk:
                raise IOError("файл обновления оборвался")
            if skip:
                cut = min(skip, len(chunk))
                chunk, skip = chunk[cut:], skip - cut
                if not chunk:
                    continue
            chunk = chunk[:left]
            left -= len(chunk)
            if sink:
                sink(chunk)
            else:
                out.append(chunk)
    return b"".join(out)


def read_header(asset):
    """Оглавление файла обновления: (манифест, смещение начала данных)."""
    head = _range(asset, 0, min(HEAD, int(asset.get("size") or HEAD)) - 1)
    if head[:8] != MAGIC:
        raise ValueError("это не файл обновления maistep")
    (n,) = struct.unpack("<I", head[8:12])
    if 12 + n > len(head):
        head += _range(asset, len(head), 12 + n - 1)
    return json.loads(head[12:12 + n].decode("utf-8")), 12 + n


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


def plan(remote, root=ROOT, plat=None):
    """Что качать: файлы, отличающиеся от манифеста; что удалить: файлы старой версии, которых больше нет
    (только нетронутые пользователем); бинарь своей платформы — если изменились исходники Rust."""
    local = _read_json(root / "manifest.json", {})
    files = [p for p, m in (remote.get("files") or {}).items() if _sha(root / p) != m.get("sha256")]
    old = local.get("files") or {}
    remove = [p for p, m in old.items() if p not in (remote.get("files") or {}) and _sha(root / p) == m.get("sha256")]
    rbin = (remote.get("bin") or {}).get(plat or platform_key()) or {}
    lsrc = ((local.get("bin") or {}).get(plat or platform_key()) or {}).get("source") or (local.get("exe") or {}).get("source")
    exe = bool(rbin.get("sha256")) and rbin.get("source") != lsrc
    size = sum(int(remote["files"][p].get("csize") or remote["files"][p].get("size") or 0) for p in files)
    size += int(rbin.get("csize") or rbin.get("size") or 0) if exe else 0
    return {"files": files, "remove": remove, "exe": exe, "bin": rbin.get("name") if exe else None, "bytes": size}


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
        asset = _update_asset(rel)
        manifest, base = read_header(asset)
        p = plan(manifest)
        _remote = {"release": rel, "asset": asset, "manifest": manifest, "base": base, "plan": p}
        ready = _read_json(PENDING, {}).get("version") == manifest.get("version")
        return _set(status="ready" if ready else "available", checked_at=time.time(), version=manifest.get("version"),
                    tag=rel["tag_name"], notes=rel.get("body") or "", url=rel.get("html_url"),
                    files=len(p["files"]), remove=len(p["remove"]), exe=p["exe"], bin=p["bin"], bytes=p["bytes"], done=0)
    except Exception as e:
        return _set(status="error", error=f"{type(e).__name__}: {e}", checked_at=time.time())


# ---------- загрузка ----------
_done = {"n": 0, "at": 0}
_done_lock = threading.Lock()


def _progress(n):
    with _done_lock:
        _done["n"] += n
        if time.time() - _done["at"] <= 0.3:
            return
        _done["at"] = time.time()
        n = _done["n"]
    _set(done=n)


def _unpack(path, meta, data):
    out = zlib.decompress(data, -15) if meta.get("z", True) else data
    if hashlib.sha256(out).hexdigest() != meta["sha256"]:
        raise ValueError(f"{path}: контрольная сумма не совпала")
    dest = STAGING / path
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_name(dest.name + ".part")
    tmp.write_bytes(out)
    tmp.replace(dest)


def _groups(entries):
    """Куски файла обновления по смещению: соседние (ближе GAP) — одним запросом."""
    out = []
    for path, meta in sorted(entries, key=lambda e: e[1]["off"]):
        if out and meta["off"] - out[-1]["end"] <= GAP:
            out[-1]["items"].append((path, meta))
            out[-1]["end"] = meta["off"] + meta["csize"]
        else:
            out.append({"start": meta["off"], "end": meta["off"] + meta["csize"], "items": [(path, meta)]})
    return out


def _fetch_group(asset, base, g):
    data = _range(asset, base + g["start"], base + g["end"] - 1)
    for path, meta in g["items"]:
        a = meta["off"] - g["start"]
        _unpack(path, meta, data[a:a + meta["csize"]])
        _progress(meta["csize"])


def _fetch_bin(asset, base, meta):
    dest = STAGING / meta["name"]
    if _sha(dest) == meta["sha256"]:
        _progress(meta["csize"])
        return
    tmp = dest.with_name(dest.name + ".part")
    d = zlib.decompressobj(-15) if meta.get("z", True) else None
    with open(tmp, "wb") as f:
        def sink(chunk):
            f.write(d.decompress(chunk) if d else chunk)
            _progress(len(chunk))
        _range(asset, base + meta["off"], base + meta["off"] + meta["csize"] - 1, sink)
        if d:
            f.write(d.flush())
    if _sha(tmp) != meta["sha256"]:
        tmp.unlink(missing_ok=True)
        raise ValueError(f"{meta['name']}: контрольная сумма не совпала")
    tmp.replace(dest)


def _run_download(remote):
    asset, manifest, base, p = remote["asset"], remote["manifest"], remote["base"], remote["plan"]
    _done.update(n=0, at=0)
    try:
        STAGING.mkdir(parents=True, exist_ok=True)
        todo = []
        for path in p["files"]:
            meta = manifest["files"][path]
            if _sha(STAGING / path) == meta["sha256"]:
                _progress(meta["csize"])  # скачан прошлой попыткой
            else:
                todo.append((path, meta))
        with futures.ThreadPoolExecutor(6) as pool:
            for f in [pool.submit(_fetch_group, asset, base, g) for g in _groups(todo)]:
                f.result()
        if p["exe"]:
            _fetch_bin(asset, base, manifest["bin"][platform_key()])
        # локальный манифест — без смещений (они нужны только внутри файла обновления)
        local = {**manifest, "files": {k: {"sha256": v["sha256"], "size": v["size"]} for k, v in manifest["files"].items()}}
        pending = {"version": manifest.get("version"), "files": p["files"], "remove": p["remove"], "exe": p["exe"],
                   "bin": p["bin"], "manifest": local}
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
