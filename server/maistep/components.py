"""Компоненты maistep: установленные и рекомендованные версии, проверка стабильных обновлений, установка
недостающих пакетов в .venv с прогрессом в UI.

Рекомендации — стабильные версии из components.json в корне проекта (их можно обновить удалённым манифестом:
user/settings.json → "components": {"manifest_url": "…"}). Предрелизы (a/b/rc/dev) не предлагаются никогда.
Последние стабильные версии пакетов — с pypi.org (кэш 6 ч), обновления приложения — из GitHub Releases (repo
из components.json → app.repo; только non-draft, non-prerelease).

Установка разрешена только для пакетов из манифеста (никаких имён от клиента), идёт в фоне, строки pip
транслируются событиями SSE comp-log / components.
"""
import concurrent.futures as futures
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = ROOT / "components.json"
CACHE_FILE = ROOT / "user" / "components_cache.json"
SETTINGS = ROOT / "user" / "settings.json"
CACHE_TTL = 6 * 3600
VERSIONS_TTL = 30
DEEP_TTL = 300
PYPI = "https://pypi.org/pypi/{pkg}/json"
GITHUB_RELEASES = "https://api.github.com/repos/{repo}/releases?per_page=20"
UA = {"User-Agent": "maistep-components/1.0"}

_emit = lambda event, data: None  # задаёт main.py (SSE-хаб)
_lock = threading.Lock()
_job = None
_versions = {"key": None, "at": 0, "data": None}
_deep = {"key": None, "at": 0, "data": None}


def configure(emitter):
    global _emit
    _emit = emitter


# ---------- версии ----------
def _vkey(v):
    """Сравнимый ключ стабильной версии: (числа, 1 — стабильная, 0 — предрелиз)."""
    s = str(v or "").strip().lstrip("vV").split("+")[0]
    m = re.match(r"^(\d+(?:\.\d+)*)(.*)$", s)
    if not m:
        return ((), 0)
    nums = tuple(int(x) for x in m.group(1).split("."))
    tail = m.group(2) or ""
    return (nums, 1 if not re.search(r"[a-zA-Z]", tail) else 0)


def _vcmp(a, b):
    ka, kb = _vkey(a), _vkey(b)
    n = max(len(ka[0]), len(kb[0]))
    na, nb = ka[0] + (0,) * (n - len(ka[0])), kb[0] + (0,) * (n - len(kb[0]))
    if na != nb:
        return (na > nb) - (na < nb)
    return (ka[1] > kb[1]) - (ka[1] < kb[1])


def _base(v):
    return str(v or "").split("+")[0]


def _stable(v):
    return bool(v) and bool(re.match(r"^\d+(?:\.\d+)*$", str(v).lstrip("vV").split("+")[0]))


def _read_json(path, default):
    try:
        return json.loads(Path(path).read_text("utf-8"))
    except (OSError, ValueError):
        return default


def _write_json(path, data):
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        tmp = Path(str(path) + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
        tmp.replace(path)
    except OSError:
        pass


def _settings():
    return _read_json(SETTINGS, {})


def _cache():
    return _read_json(CACHE_FILE, {})


# ---------- Python окружения ----------
def python_info():
    """Интерпретатор, в котором живут пакеты (MAISTEP_PYTHON → .venv/venv → текущий)."""
    cfg = (_settings().get("components") or {}).get("python") or os.environ.get("MAISTEP_PYTHON")
    cand = []
    if cfg:
        cand.append((Path(cfg), "настройка"))
    if sys.platform == "win32":
        cand += [(ROOT / ".venv" / "Scripts" / "python.exe", "проект .venv"), (ROOT / "venv" / "Scripts" / "python.exe", "проект venv")]
    else:
        cand += [(ROOT / ".venv" / "bin" / "python", "проект .venv"), (ROOT / "venv" / "bin" / "python", "проект venv")]
    for p, source in cand:
        if p.is_file():
            return {"path": str(p), "source": source, "is_venv": p.resolve() != Path(sys.executable).resolve() or ".venv" in str(p) or "venv" in str(p)}
    return {"path": sys.executable, "source": "текущий Python", "is_venv": sys.prefix != getattr(sys, "base_prefix", sys.prefix)}


def _run_json(py, script, timeout):
    flags = 0x08000000 if sys.platform == "win32" else 0  # CREATE_NO_WINDOW
    try:
        r = subprocess.run([py, "-c", script], capture_output=True, text=True, encoding="utf-8", errors="replace",
                           timeout=timeout, creationflags=flags, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
        if r.returncode != 0:
            return {"error": (r.stderr or r.stdout or "").strip()[-2000:]}
        for line in reversed((r.stdout or "").strip().splitlines()):
            try:
                return json.loads(line)
            except ValueError:
                continue
        return {"error": "пустой ответ Python"}
    except (OSError, subprocess.TimeoutExpired) as e:
        return {"error": f"{type(e).__name__}: {e}"}


def installed(py=None):
    """Версии пакетов манифеста в выбранном Python (importlib.metadata, без импорта самих пакетов)."""
    info = python_info()
    py = py or info["path"]
    m = manifest()
    names = [c["package"] for c in m["python"]["components"]]
    key = (py, tuple(names))
    if _versions["key"] == key and time.time() - _versions["at"] < VERSIONS_TTL:
        return _versions["data"]
    script = (
        "import json, importlib.metadata as md\n"
        f"names = {names!r}\n"
        "out, err = {}, {}\n"
        "for n in names:\n"
        "    try: out[n] = md.version(n)\n"
        "    except Exception as e: err[n] = type(e).__name__\n"
        "print(json.dumps({'versions': out, 'errors': err}))\n"
    )
    data = _run_json(py, script, 30)
    data.setdefault("versions", {})
    data.setdefault("errors", {})
    _versions.update(key=key, at=time.time(), data=data)
    return data


def deep_status():
    """CUDA и видеопамять (запускает torch в отдельном процессе, кэш 5 мин)."""
    info = python_info()
    if _deep["key"] == info["path"] and time.time() - _deep["at"] < DEEP_TTL:
        return _deep["data"]
    script = (
        "import json\n"
        "try:\n"
        "    import torch\n"
        "    d = {'torch': torch.__version__, 'cuda': bool(torch.cuda.is_available())}\n"
        "    if d['cuda']:\n"
        "        p = torch.cuda.get_device_properties(0)\n"
        "        d.update(device=p.name, vram_gb=round(p.total_memory / 2**30, 1), capability=f'{p.major}.{p.minor}')\n"
        "    print(json.dumps(d))\n"
        "except Exception as e:\n"
        "    print(json.dumps({'error': f'{type(e).__name__}: {e}'}))\n"
    )
    data = _run_json(info["path"], script, 120)
    _deep.update(key=info["path"], at=time.time(), data=data)
    return data


# ---------- манифест и обновления ----------
def manifest():
    base = _read_json(MANIFEST, {})
    if not base:
        base = {"channel": "stable", "app": {"name": "maistep", "stable": "0.1.0"}, "python": {"components": []}}
    cached = (_cache().get("remote") or {}).get("data") or {}
    return _merge(base, cached)


def _merge(base, remote):
    """Удалённый манифест может поднять рекомендуемые стабильные версии и версию приложения."""
    if not isinstance(remote, dict):
        return base
    out = json.loads(json.dumps(base))
    app = remote.get("app") or {}
    if h := app.get("stable") or app.get("version"):
        out["app"]["stable"] = str(h).lstrip("vV")
    for k in ("url", "releases", "notes"):
        if app.get(k):
            out["app"][k] = app[k]
    rec = remote.get("python") or {}
    if isinstance(rec, dict):
        rec = rec.get("recommended") or rec
    if isinstance(rec, dict):
        by_id = {c["id"]: c for c in out["python"]["components"]}
        for k, v in rec.items():
            if k in by_id and _stable(v):
                by_id[k]["recommended"] = str(v).lstrip("vV")
    return out


def _fetch(url, timeout=10):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _latest_stable(pkg):
    data = _fetch(PYPI.format(pkg=pkg))
    rel = data.get("releases") or {}
    good = []
    for v, files in rel.items():
        if not _stable(v) or not files:
            continue
        if all(f.get("yanked") for f in files):
            continue
        req = (files[0].get("requires_python") or "").split(",")
        good.append(v)
    if not good:
        v = (data.get("info") or {}).get("version")
        return v if _stable(v) else None
    return max(good, key=_vkey)


def _latest_app(app):
    repo = app.get("repo")
    if not repo:
        return None
    try:
        rels = _fetch(GITHUB_RELEASES.format(repo=repo))
    except Exception:
        return None
    best = None
    for r in rels or []:
        if not isinstance(r, dict) or r.get("draft") or r.get("prerelease"):
            continue
        tag = str(r.get("tag_name") or "").lstrip("vV")
        if _stable(tag) and (best is None or _vcmp(tag, best["version"]) > 0):
            best = {"version": tag, "url": r.get("html_url"), "notes": r.get("body") or ""}
    return best


def refresh_sources(m):
    """Сетевые проверки (только стабильные): удалённый манифест, PyPI, GitHub Releases. Кэш 6 ч."""
    cache = _cache()
    now = time.time()
    settings = (_settings().get("components") or {})
    url = settings.get("manifest_url")
    if not url:
        repo = (m.get("app") or {}).get("repo")
        url = f"https://raw.githubusercontent.com/{repo}/main/components.json" if repo else None

    jobs = {}
    if url and now - (cache.get("remote") or {}).get("at", 0) > CACHE_TTL:
        jobs["remote"] = url
    py = cache.setdefault("pypi", {})
    for c in m["python"]["components"]:
        if c.get("pypi") is False:
            continue
        if now - (py.get(c["package"]) or {}).get("at", 0) > CACHE_TTL:
            jobs[c["package"]] = c["package"]
    gh = cache.get("app") or {}
    if (m.get("app") or {}).get("repo") and now - gh.get("at", 0) > CACHE_TTL:
        jobs["app"] = m["app"]

    results = {}
    if jobs:
        with futures.ThreadPoolExecutor(max_workers=6) as ex:
            futs = {}
            for k, v in jobs.items():
                if k == "remote":
                    futs[ex.submit(_fetch, v)] = ("remote", None)
                elif k == "app":
                    futs[ex.submit(_latest_app, v)] = ("app", None)
                else:
                    futs[ex.submit(_latest_stable, v)] = ("pypi", k)
            try:
                for f in futures.as_completed(futs, timeout=45):
                    kind, key = futs[f]
                    try:
                        results[(kind, key)] = f.result()
                    except Exception as e:
                        results[(kind, key)] = {"error": f"{type(e).__name__}: {e}"}
            except futures.TimeoutError:
                pass
    if ("remote", None) in results:
        data = results[("remote", None)]
        cache["remote"] = {"at": now, "data": data} if isinstance(data, dict) and "error" not in data else {"at": now, "data": {}, "error": data.get("error") if isinstance(data, dict) else "ошибка"}
    for (kind, key), val in results.items():
        if kind == "pypi" and isinstance(val, str):
            cache.setdefault("pypi", {})[key] = {"at": now, "version": val}
        elif kind == "app" and isinstance(val, dict):
            cache["app"] = {"at": now, **val}
        elif kind == "app":
            cache["app"] = {"at": now, "version": None}
    cache["at"] = now
    _write_json(CACHE_FILE, cache)
    return cache


def _summary(rows):
    return {k: sum(1 for r in rows if r["status"] == k) for k in ("ok", "update", "missing", "newer")}


def status(refresh=False, deep=False):
    m = manifest()
    cache = _cache()
    if refresh:
        cache = refresh_sources(m)
        _versions["at"] = 0
    info = python_info()
    ver = installed(info["path"])
    versions = ver.get("versions") or {}
    pypi = cache.get("pypi") or {}

    app_cfg = m.get("app") or {}
    from maistep import updater
    app_installed = updater.installed_version()
    app_rec = str(app_cfg.get("stable") or app_installed)
    gh = cache.get("app") or {}
    app_latest = gh.get("version") or app_rec
    app_status = "ok"
    if _vcmp(app_rec, app_installed) > 0:
        app_status = "update"
    elif _vcmp(app_latest, app_installed) > 0:
        app_status = "update"
    elif _vcmp(app_installed, app_rec) > 0:
        app_status = "newer"

    rows = []
    for c in m["python"]["components"]:
        cid, package = c["id"], c["package"]
        inst = versions.get(package)
        rec = str(c.get("recommended") or "")
        latest = (pypi.get(package) or {}).get("version")
        if inst is None:
            st = "missing"
        elif rec and _vcmp(_base(inst), rec) < 0:
            st = "update"
        elif rec and _vcmp(_base(inst), rec) > 0:
            st = "newer"
        else:
            st = "ok"
        rows.append({
            "id": cid, "title": c.get("title") or package, "package": package, "group": c.get("group") or "Прочее",
            "required": bool(c.get("required")), "note": c.get("note") or "", "size": c.get("size") or "",
            "installed": inst, "installed_base": _base(inst) if inst else None, "recommended": rec,
            "latest": latest, "latest_newer": bool(latest and rec and _vcmp(latest, rec) > 0),
            "status": st, "index_url": c.get("index_url"),
            "pypi": c.get("pypi") is not False,
            "spec": f"{package}=={rec}" if rec else package,
        })
    data = {
        "app": {"name": app_cfg.get("name") or "maistep", "installed": app_installed, "recommended": app_rec,
                "latest": app_latest, "status": app_status,
                "url": (cache.get("app") or {}).get("url") or app_cfg.get("releases") or app_cfg.get("url"),
                "notes": (cache.get("app") or {}).get("notes") or ""},
        "python": {"path": info["path"], "source": info["source"], "is_venv": info["is_venv"],
                   "version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                   "requires": ((m.get("python") or {}).get("requires") or "")},
        "deep": deep_status() if deep else None,
        "components": rows, "summary": _summary(rows), "channel": m.get("channel") or "stable",
        "checked_at": cache.get("at"), "job": job_snapshot(),
        "errors": ver.get("errors") or {},
    }
    if deep and not data["deep"]:
        data["deep"] = {}
    return data


# ---------- установка ----------
class Job:
    def __init__(self, ids, mode):
        self.id = f"install-{int(time.time())}"
        self.ids, self.mode = ids, mode
        self.state = "running"
        self.started = time.time()
        self.ended = None
        self.error = None
        self.lines = []
        self.proc = None
        self.cancelled = False

    def snap(self):
        return {"id": self.id, "state": self.state, "mode": self.mode, "ids": self.ids,
                "started": self.started, "ended": self.ended, "error": self.error,
                "lines": self.lines[-160:]}

    def log(self, text):
        text = str(text).rstrip()
        if not text:
            return
        self.lines.append(text)
        del self.lines[:-4000]
        _emit("comp-log", {"job": self.id, "text": text})


def job_snapshot():
    with _lock:
        return _job.snap() if _job else None


def install(ids=None, mode="recommended"):
    """Установить/обновить пакеты манифеста. mode: recommended (стабильная из манифеста), missing, latest."""
    global _job
    with _lock:
        if _job and _job.state == "running":
            return {"error": "установка уже идёт", "job": _job.snap()}
        m = manifest()
        comps = {c["id"]: c for c in m["python"]["components"]}
        wanted = [i for i in (ids or []) if i in comps]
        if ids and len(wanted) != len(ids):
            return {"error": f"неизвестные компоненты: {', '.join(set(ids) - set(wanted))}"}
        info = python_info()
        versions = (installed(info["path"]).get("versions") or {})
        pypi = _cache().get("pypi") or {}
        if not wanted:
            wanted = [cid for cid, c in comps.items() if versions.get(c["package"]) is None or
                      _vcmp(_base(versions[c["package"]]), c.get("recommended") or "0") < 0]
        if not wanted:
            _job = Job([], mode)
            _job.state = "done"
            _job.log("все выбранные компоненты уже установлены")
            _job.ended = time.time()
            return {"job": _job.snap()}
        groups = {}
        chosen = []
        for cid in wanted:
            c = comps[cid]
            inst = versions.get(c["package"])
            rec = str(c.get("recommended") or "")
            if mode == "missing" and inst is not None:
                continue
            target = rec
            if mode == "latest" and c.get("pypi") is not False:
                target = (pypi.get(c["package"]) or {}).get("version") or rec
            if not target:
                continue
            if inst is not None and _vcmp(_base(inst), target) >= 0:
                continue
            chosen.append(c)
            spec = f"{c['package']}=={target}"
            groups.setdefault(c.get("index_url"), []).append(spec)
        if not chosen:
            _job = Job(wanted, mode)
            _job.state = "done"
            _job.log("нечего устанавливать — версии уже совпадают")
            _job.ended = time.time()
            return {"job": _job.snap()}
        _job = Job([c["id"] for c in chosen], mode)
        args = []
        for index, specs in groups.items():
            cmd = ["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "--no-input", *specs]
            if index:
                cmd += ["--index-url", index]
            args.append(cmd)
        threading.Thread(target=_run_install, args=(_job, info["path"], args), daemon=True).start()
        _emit("components", {"job": _job.snap()})
        return {"job": _job.snap()}


def _run_install(job, py, commands):
    flags = 0x08000000 if sys.platform == "win32" else 0
    try:
        for cmd in commands:
            job.log("$ " + " ".join([Path(py).name, *cmd]))
            p = subprocess.Popen([py, *cmd], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                                 encoding="utf-8", errors="replace", bufsize=1, creationflags=flags,
                                 env={**os.environ, "PYTHONIOENCODING": "utf-8", "PIP_DISABLE_PIP_VERSION_CHECK": "1"})
            job.proc = p
            if p.stdout:
                for line in p.stdout:
                    job.log(line)
            code = p.wait()
            job.proc = None
            if job.cancelled:
                job.state = "cancelled"
                job.error = "установка прервана"
                return
            if code != 0:
                job.state = "failed"
                job.error = f"pip завершился с кодом {code}"
                return
        job.state = "done"
        job.log("готово: компоненты обновлены")
    except Exception as e:
        job.state = "failed"
        job.error = f"{type(e).__name__}: {e}"
        job.log(job.error)
    finally:
        job.ended = time.time()
        _versions["at"] = 0
        _deep["at"] = 0
        _write_json(CACHE_FILE, _cache())  # at обновится при следующей проверке
        _emit("components", {"job": job.snap()})


def cancel():
    with _lock:
        if not _job or _job.state != "running":
            return {"error": "нет активной установки"}
        _job.cancelled = True
        p = _job.proc
    if p:
        if sys.platform == "win32":
            subprocess.run(["taskkill", "/PID", str(p.pid), "/T", "/F"], capture_output=True, creationflags=0x08000000)
        else:
            p.terminate()
    return {"ok": True, "job": _job.snap() if _job else None}
