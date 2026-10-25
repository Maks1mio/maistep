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
import urllib.parse
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
        "import json, sys, importlib.metadata as md\n"
        f"names = {names!r}\n"
        "out, err = {}, {}\n"
        "for n in names:\n"
        "    try: out[n] = md.version(n)\n"
        "    except Exception as e: err[n] = type(e).__name__\n"
        "print(json.dumps({'versions': out, 'errors': err, 'python': '.'.join(map(str, sys.version_info[:3]))}))\n"
    )
    data = _run_json(py, script, 30)
    data.setdefault("versions", {})
    data.setdefault("errors", {})
    _versions.update(key=key, at=time.time(), data=data)
    return data


def deep_status():
    """CUDA/ROCm и видеопамять (запускает torch в отдельном процессе, кэш 5 мин)."""
    info = python_info()
    if _deep["key"] == info["path"] and time.time() - _deep["at"] < DEEP_TTL:
        return _deep["data"]
    script = (
        "import json\n"
        "try:\n"
        "    import torch\n"
        "    d = {'torch': torch.__version__, 'cuda': bool(torch.cuda.is_available()), 'hip': getattr(torch.version, 'hip', None)}\n"
        "    if d['cuda']:\n"
        "        p = torch.cuda.get_device_properties(0)\n"
        "        d.update(device=p.name, vram_gb=round(p.total_memory / 2**30, 1), capability=f'{p.major}.{p.minor}',\n"
        "                 arch=(getattr(p, 'gcnArchName', '') or '').split(':')[0] or None)\n"
        "    print(json.dumps(d))\n"
        "except Exception as e:\n"
        "    print(json.dumps({'error': f'{type(e).__name__}: {e}'}))\n"
    )
    data = _run_json(info["path"], script, 120)
    _deep.update(key=info["path"], at=time.time(), data=data)
    return data


# ---------- видеокарта и вариант torch ----------
# Сборка torch зависит от видеокарты: CUDA (NVIDIA), ROCm (AMD, пакет под архитектуру gfx — с индекса AMD) или CPU.
# Видеокарта определяется без torch: Linux — sysfs (/sys/class/kfd даёт архитектуру AMD), Windows — WMI + название.
# Ручной выбор — user/settings.json → "components": {"torch_variant": "auto|cuda|rocm|cpu", "gfx": "gfx1201"}.
GPU_TTL = 600
_gpu = {"at": 0, "data": None}
VARIANTS = ("cuda", "rocm", "cpu")

# Windows не сообщает архитектуру AMD — по названию карты (как таблицы ROCm)
_AMD_NAMES = [
    (r"RX\s*90[67]0|R9[67]00", "gfx1201"), (r"RX\s*906\d", "gfx1200"),
    (r"RX\s*79[05]0", "gfx1100"), (r"RX\s*7[78]\d0", "gfx1101"), (r"RX\s*76\d0", "gfx1102"),
    (r"RX\s*6[89]\d0", "gfx1030"), (r"RX\s*67\d0", "gfx1031"), (r"RX\s*66\d0", "gfx1032"), (r"RX\s*6[45]\d0", "gfx1034"),
    (r"80[56]0S", "gfx1151"), (r"8[89]0M", "gfx1150"), (r"7[68]0M", "gfx1103"),
]


def _amd_gfx(name):
    return next((g for pat, g in _AMD_NAMES if re.search(pat, name or "", re.I)), None)


def _gfx_from_target(v):
    """gfx_target_version из kfd: 120001 → gfx1201, 90010 → gfx90a."""
    v = int(v)
    major, minor, step = v // 10000, v // 100 % 100, v % 100
    return f"gfx{major}{minor:x}{step:x}"


def _drm_amd_name():
    """Название карты из DRM (amdgpu: /sys/class/drm/card0/device/product_name): в kfd у части ядер вместо имени
    лежит имя IP-блока («ip discovery» — так карта и попадала в отчёты)."""
    for card in sorted(Path("/sys/class/drm").glob("card[0-9]*/device/vendor")):
        try:
            if card.read_text().strip() != "0x1002":
                continue
            name = (card.parent / "product_name").read_text().strip()
        except OSError:
            continue
        if name and name.lower() not in ("ip discovery", "0x0000"):
            return name
    return ""


def _gpus_linux():
    out = []
    drm = _drm_amd_name()
    for node in sorted(Path("/sys/class/kfd/kfd/topology/nodes").glob("*/properties")):
        try:
            props = dict(line.split(None, 1) for line in node.read_text().splitlines() if " " in line)
        except OSError:
            continue
        if int(props.get("simd_count", "0")) > 0 and int(props.get("gfx_target_version", "0")) > 0:
            gfx = _gfx_from_target(props["gfx_target_version"])
            name = ""
            try:
                name = (node.parent / "name").read_text().strip()
            except OSError:
                pass
            if name.lower() == "ip discovery":
                name = ""
            out.append({"vendor": "amd", "name": drm or name or gfx, "gfx": gfx})
    for card in sorted(Path("/sys/class/drm").glob("card[0-9]*/device/vendor")):
        try:
            if card.read_text().strip() == "0x10de":
                out.append({"vendor": "nvidia", "name": "NVIDIA", "gfx": None})
                break
        except OSError:
            pass
    return out


def _gpus_windows():
    script = "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress"
    try:
        r = subprocess.run(["powershell", "-NoProfile", "-Command", script], capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=20, creationflags=0x08000000)
        names = json.loads(r.stdout or "[]")
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return []
    out = []
    for name in [names] if isinstance(names, str) else names or []:
        if re.search(r"NVIDIA|GeForce|Quadro|Tesla", name, re.I):
            out.append({"vendor": "nvidia", "name": name, "gfx": None})
        elif re.search(r"AMD|Radeon", name, re.I):
            out.append({"vendor": "amd", "name": name, "gfx": _amd_gfx(name)})
    return out


def _nvidia_names():
    exe = shutil.which("nvidia-smi")
    if not exe:
        return []
    try:
        r = subprocess.run([exe, "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True,
                           timeout=15, creationflags=0x08000000 if sys.platform == "win32" else 0)
        return [n.strip() for n in (r.stdout or "").splitlines() if n.strip()]
    except (OSError, subprocess.TimeoutExpired):
        return []


def gpu_info():
    """Видеокарты и выбранный вариант torch: {"gpus": [...], "auto": …, "variant": …, "gfx": …}."""
    if _gpu["data"] is None or time.time() - _gpu["at"] > GPU_TTL:
        gpus = _gpus_windows() if sys.platform == "win32" else _gpus_linux() if sys.platform.startswith("linux") else []
        nv = _nvidia_names()
        if nv:
            gpus = [g for g in gpus if g["vendor"] != "nvidia"] + [{"vendor": "nvidia", "name": n, "gfx": None} for n in nv]
        _gpu.update(at=time.time(), data=gpus)
    gpus = _gpu["data"]
    cfg = _settings().get("components") or {}
    amd = next((g for g in gpus if g["vendor"] == "amd" and g["gfx"]), None)
    auto = "cuda" if any(g["vendor"] == "nvidia" for g in gpus) else "rocm" if amd else "cpu"
    variant = cfg.get("torch_variant") if cfg.get("torch_variant") in VARIANTS else auto
    gfx = str(cfg.get("gfx") or "").strip() or (amd or {}).get("gfx")
    return {"gpus": gpus, "auto": auto, "variant": variant, "manual": cfg.get("torch_variant") in VARIANTS, "gfx": gfx}


def set_variant(variant, gfx=None):
    """Ручной выбор сборки torch (auto — по видеокарте)."""
    if variant not in (*VARIANTS, "auto"):
        return {"error": f"неизвестный вариант: {variant}"}
    if gfx is not None and gfx and not re.fullmatch(r"gfx[0-9a-f]{3,4}x?", str(gfx)):
        return {"error": f"архитектура AMD вида gfx1201, а не «{gfx}»"}
    s = _settings()
    cfg = s.setdefault("components", {})
    if variant == "auto":
        cfg.pop("torch_variant", None)
    else:
        cfg["torch_variant"] = variant
    if gfx is not None:
        if gfx:
            cfg["gfx"] = gfx
        else:
            cfg.pop("gfx", None)
    _write_json(SETTINGS, s)
    return status()


def _installed_variant(version):
    """Сборка установленного torch по локальной части версии: +cu130 / +rocm10.1.0 / +cpu."""
    local = str(version or "").partition("+")[2].lower()
    if "rocm" in local:
        return "rocm"
    if local.startswith("cu"):
        return "cuda"
    if local == "cpu" or sys.platform != "linux":
        return "cpu"
    return "cuda"  # torch с PyPI на Linux — CUDA-сборка


def _resolve(c, gpu):
    """Компонент с подставленным вариантом сборки (для torch — по видеокарте)."""
    vs = c.get("variants")
    if not isinstance(vs, dict) or not vs:
        return c
    name = gpu["variant"] if gpu["variant"] in vs else next(iter(vs))
    out = {k: v for k, v in c.items() if k != "variants"}
    out.update({k: v for k, v in vs[name].items() if k != "title"})
    out["variant"] = name
    out["variants"] = [{"id": k, "title": v.get("title") or k} for k, v in vs.items()]
    if out.get("extra"):
        out["extra"] = out["extra"].replace("{gfx}", gpu.get("gfx") or "")
    return out


def _spec(c, version):
    """pip-спецификация: torch[device-gfx1201]==2.14.0+rocm10.1.0."""
    extra = f"[{c['extra']}]" if c.get("extra") else ""
    local = f"+{c['local']}" if c.get("local") else ""
    return f"{c['package']}{extra}=={version}{local}"


def _py_ok(c, py):
    """Подходит ли версия Python сборке (у ROCm-колёс AMD — до 3.14)."""
    m = re.fullmatch(r"<(\d+)\.(\d+)", str(c.get("python_lt") or ""))
    if not m or not py:
        return True
    return tuple(int(x) for x in py.split(".")[:2]) < (int(m[1]), int(m[2]))


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
    """Сводка по пакетам; модели (опциональные файлы весов) в счётчики и значок не попадают."""
    rows = [r for r in rows if r.get("kind") != "model"]
    return {k: sum(1 for r in rows if r["status"] == k) for k in ("ok", "update", "missing", "newer")}


# ---------- модели (файлы весов, не pip) ----------
# models в components.json: файл с Hugging Face (url, sha256, bytes) → папка категории библиотеки, куда качает и
# Civitai (civitai._folder_for). Установленной считается модель с таким именем файла в любой папке категории.
def _bundle_have(c, f):
    base = ROOT / c["dir"]
    return (base / f["path"]).is_file() or bool(f.get("alt") and (base / f["alt"]).is_file())


def _model_path(c, refresh=False):
    if c.get("files"):  # набор файлов в своей папке (MangaNinja): установлена, когда на месте все
        return str(ROOT / c["dir"]) if all(_bundle_have(c, f) for f in c["files"]) else None
    from maistep import library as L
    for it in L.index(refresh)["items"]:
        if it["cat"] == c["cat"] and Path(it["path"]).name.lower() == c["file"].lower():
            return it["path"]
    return None


def _model_row(c):
    path = _model_path(c)
    return {
        "id": c["id"], "kind": "model", "title": c.get("title") or c.get("file") or c["id"], "package": c.get("file") or c["id"],
        "group": c.get("group") or "Модели", "tabs": c.get("tabs") or [], "required": bool(c.get("required")),
        "note": c.get("note") or "", "size": c.get("size") or "", "installed": "скачана" if path else None,
        "installed_base": None, "recommended": "", "latest": None, "latest_newer": False,
        "status": "ok" if path else "missing", "index_url": None, "pypi": False, "spec": c.get("file") or c["id"],
        "variant": None, "variants": None, "installed_variant": None, "problem": None,
        "path": path, "cat": c.get("cat"), "page": c.get("page"), "license": c.get("license"),
        "starter": bool(c.get("starter")), "bytes": int(c.get("bytes") or 0),
    }


def model_status(cid):
    """Строка модели по id (для вкладок: есть ли ControlNet ToColar)."""
    c = next((x for x in manifest().get("models") or [] if x["id"] == cid), None)
    return _model_row(c) if c else None


def _fetch_file(job, c, part, pos):
    """Скачать url модели в .part с позиции pos (Range), с прогрессом в лог задания."""
    url = c["url"]
    if urllib.parse.urlparse(url).hostname == "civitai.com":  # ключ Civitai (если задан) — только самому Civitai
        from maistep import civitai
        url = civitai._dl_url(url)
    req = urllib.request.Request(url, headers={**UA, **({"range": f"bytes={pos}-"} if pos else {})})
    with urllib.request.urlopen(req, timeout=60) as r:
        if pos and r.status != 206:
            pos = 0  # сервер не умеет Range — сначала
        total = pos + int(r.headers.get("content-length") or 0) or int(c.get("bytes") or 0)
        done, shown, t0 = pos, -1, time.time()
        with open(part, "ab" if pos else "wb") as out:
            while True:
                if job.cancelled:
                    raise InterruptedError("загрузка прервана (недокачанное продолжится при следующей установке)")
                b = r.read(1 << 20)
                if not b:
                    break
                out.write(b)
                done += len(b)
                pct = int(100 * done / total) if total else 0
                if pct // 5 != shown:
                    shown = pct // 5
                    speed = (done - pos) / max(0.1, time.time() - t0) / 2**20
                    job.log(f"  {pct}% · {done / 2**20:.0f} из {total / 2**20:.0f} МБ · {speed:.1f} МБ/с")


def _download_model(job, c):
    """Скачать файл модели: докачка .part по Range, проверка размера и sha256, затем атомарная замена."""
    import hashlib
    from maistep import civitai
    from maistep import library as L
    if c.get("files"):
        return _download_bundle(job, c)
    if _model_path(c, refresh=True):
        job.log(f"{c['file']}: уже есть в библиотеке")
        return
    folder, _cat = civitai._folder_for(c.get("civitai_type") or "Controlnet")
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / c["file"]
    part = dest.with_name(dest.name + ".part")
    pos = part.stat().st_size if part.exists() else 0
    job.log(f"$ download {c['url']}\n  → {dest}" + (f" (докачка с {pos / 2**20:.0f} МБ)" if pos else ""))
    if c.get("bytes") and pos > int(c["bytes"]):
        part.unlink()
        pos = 0
    if c.get("bytes") and pos == int(c["bytes"]):
        job.log("  файл уже скачан целиком")
    else:
        _fetch_file(job, c, part, pos)
    size = part.stat().st_size
    if c.get("bytes") and size != int(c["bytes"]):
        raise RuntimeError(f"файл скачан не полностью: {size} из {c['bytes']} байт")
    if c.get("sha256"):
        job.log("  проверка sha256…")
        h = hashlib.sha256()
        with open(part, "rb") as f:
            for b in iter(lambda: f.read(8 << 20), b""):
                h.update(b)
        if h.hexdigest().lower() != c["sha256"].lower():
            part.unlink(missing_ok=True)
            raise RuntimeError("sha256 не совпал — файл повреждён, скачайте ещё раз")
    os.replace(part, dest)
    L.index(refresh=True)
    _emit("library-changed", {})
    job.log(f"готово: {dest}")


def _download_bundle(job, c):
    """Набор файлов модели в свою папку (dir от корня maistep): каждый — с докачкой .part и проверкой размера."""
    base = ROOT / c["dir"]
    for f in c["files"]:
        if _bundle_have(c, f):
            continue
        dest = base / f["path"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        part = dest.with_name(dest.name + ".part")
        pos = part.stat().st_size if part.exists() else 0
        if f.get("bytes") and pos > int(f["bytes"]):
            part.unlink()
            pos = 0
        job.log(f"$ download {f['url']}\n  → {dest}" + (f" (докачка с {pos / 2**20:.0f} МБ)" if pos else ""))
        if not (f.get("bytes") and pos == int(f["bytes"])):
            _fetch_file(job, f, part, pos)
        size = part.stat().st_size
        if f.get("bytes") and size != int(f["bytes"]):
            raise RuntimeError(f"{f['path']}: скачан не полностью ({size} из {f['bytes']} байт)")
        os.replace(part, dest)
    job.log(f"готово: {base}")


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

    gpu = gpu_info()
    py = ver.get("python")
    rows = []
    for c in (_resolve(c, gpu) for c in m["python"]["components"]):
        cid, package = c["id"], c["package"]
        inst = versions.get(package)
        rec = str(c.get("recommended") or "")
        latest = (pypi.get(package) or {}).get("version")
        inst_variant = _installed_variant(inst) if inst and c.get("variant") else None
        problem = None
        if c.get("variant") == "rocm" and not gpu.get("gfx"):
            problem = "не удалось определить архитектуру AMD — укажите её (например gfx1201)"
        elif not _py_ok(c, py):
            problem = f"сборка не поддерживает Python {py} (нужен {c['python_lt']})"
        if inst is None:
            st = "missing"
        elif inst_variant and inst_variant != c["variant"]:
            st = "update"  # стоит сборка под другую видеокарту
        elif rec and _vcmp(_base(inst), rec) < 0:
            st = "update"
        elif rec and _vcmp(_base(inst), rec) > 0:
            st = "newer"
        else:
            st = "ok"
        rows.append({
            "id": cid, "title": c.get("title") or package, "package": package, "group": c.get("group") or "Прочее",
            "tabs": c.get("tabs") or [],
            "required": bool(c.get("required")), "note": c.get("note") or "", "size": c.get("size") or "",
            "installed": inst, "installed_base": _base(inst) if inst else None, "recommended": rec,
            "latest": latest, "latest_newer": bool(latest and rec and _vcmp(latest, rec) > 0),
            "status": st, "index_url": c.get("index_url"),
            "pypi": c.get("pypi") is not False,
            "spec": _spec(c, rec) if rec else package,
            "variant": c.get("variant"), "variants": c.get("variants"), "installed_variant": inst_variant,
            "problem": problem,
        })
    rows += [_model_row(c) for c in m.get("models") or []]
    data = {
        "app": {"name": app_cfg.get("name") or "maistep", "installed": app_installed, "recommended": app_rec,
                "latest": app_latest, "status": app_status,
                "url": (cache.get("app") or {}).get("url") or app_cfg.get("releases") or app_cfg.get("url"),
                "notes": (cache.get("app") or {}).get("notes") or ""},
        "python": {"path": info["path"], "source": info["source"], "is_venv": info["is_venv"],
                   "version": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
                   "requires": ((m.get("python") or {}).get("requires") or "")},
        "deep": deep_status() if deep else None, "gpu": gpu,
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


def info_path():
    return python_info()["path"]


def install(ids=None, mode="recommended"):
    """Установить/обновить пакеты манифеста. mode: recommended (стабильная из манифеста), missing, latest."""
    global _job
    with _lock:
        if _job and _job.state == "running":
            return {"error": "установка уже идёт", "job": _job.snap()}
        m = manifest()
        gpu = gpu_info()
        comps = {c["id"]: _resolve(c, gpu) for c in m["python"]["components"]}
        models = {c["id"]: c for c in m.get("models") or []}
        wanted = [i for i in (ids or []) if i in comps]
        get = [models[i] for i in (ids or []) if i in models and not _model_path(models[i], refresh=True)]
        if ids and len(wanted) + len([i for i in ids if i in models]) != len(ids):
            return {"error": f"неизвестные компоненты: {', '.join(set(ids) - set(wanted) - set(models))}"}
        if ids and not wanted:  # только модели (пакеты по пустому списку не добираем)
            if not get:
                _job = Job([], mode)
                _job.state = "done"
                _job.log("модели уже скачаны")
                _job.ended = time.time()
                return {"job": _job.snap()}
            _job = Job([c["id"] for c in get], mode)
            threading.Thread(target=_run_install, args=(_job, info_path(), [("model", c) for c in get]), daemon=True).start()
            _emit("components", {"job": _job.snap()})
            return {"job": _job.snap()}
        info = python_info()
        ver = installed(info["path"])
        versions = ver.get("versions") or {}
        pypi = _cache().get("pypi") or {}
        mismatch = lambda c: bool(c.get("variant") and versions.get(c["package"]) and
                                  _installed_variant(versions[c["package"]]) != c["variant"])
        if not wanted:
            wanted = [cid for cid, c in comps.items() if versions.get(c["package"]) is None or mismatch(c) or
                      _vcmp(_base(versions[c["package"]]), c.get("recommended") or "0") < 0]
        for cid in wanted:
            c = comps[cid]
            if c.get("variant") == "rocm" and not gpu.get("gfx"):
                return {"error": "не удалось определить архитектуру AMD — укажите её в карточке PyTorch (например gfx1201)"}
            if not _py_ok(c, ver.get("python")):
                return {"error": f"{c['title']}: сборка не поддерживает Python {ver.get('python')} (нужен {c['python_lt']})"}
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
            if inst is not None and _vcmp(_base(inst), target) >= 0 and not mismatch(c):
                continue
            chosen.append(c)
            groups.setdefault(c.get("index_url"), []).append(_spec(c, target))
        if not chosen and not get:
            _job = Job(wanted, mode)
            _job.state = "done"
            _job.log("нечего устанавливать — версии уже совпадают")
            _job.ended = time.time()
            return {"job": _job.snap()}
        _job = Job([c["id"] for c in chosen] + [c["id"] for c in get], mode)
        args = []
        for index, specs in groups.items():
            cmd = ["-m", "pip", "install", "--upgrade", "--disable-pip-version-check", "--no-input", *specs]
            if index:
                cmd += ["--index-url", index]
            args.append(cmd)
        args += [("model", c) for c in get]
        threading.Thread(target=_run_install, args=(_job, info["path"], args), daemon=True).start()
        _emit("components", {"job": _job.snap()})
        return {"job": _job.snap()}


def _run_install(job, py, commands):
    flags = 0x08000000 if sys.platform == "win32" else 0
    try:
        for cmd in commands:
            if cmd[0] == "model":
                _download_model(job, cmd[1])
                continue
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
    except InterruptedError as e:
        job.state, job.error = "cancelled", str(e)
        job.log(job.error)
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
