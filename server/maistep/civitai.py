"""Civitai: поиск моделей и загрузка в папки библиотеки (по мотивам Enhanced-Civicomfy, свой UI maistep).

Поиск — публичный API v1 (https://civitai.com/api/v1/models, курсорная пагинация). Загрузка — очередь заданий:
файл качается в <корень>/<категория>/<имя>.part в несколько соединений (HTTP Range), проверяется SHA256,
переименовывается; рядом пишутся <имя>.cminfo.json (формат, который читает library.py) и <имя>.preview.jpeg.
Ключ API (user/settings.json → civitai.api_key) нужен для моделей, требующих входа; передаётся как ?token=,
а не заголовком: Civitai перенаправляет на подписанный URL хранилища, и заголовок Authorization там мешает.

Свои метки (коллекции) — user/civitai.json: { tags: { метка: [modelId] }, models: { modelId: снимок карточки } },
история загрузок — там же (jobs). События для UI — SSE «civitai» (configure задаёт main.py).
"""
import hashlib
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from . import library as L

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = ROOT / "user" / "settings.json"
STORE = ROOT / "user" / "civitai.json"
API = "https://civitai.com/api/v1"
UA = "maistep/0.1 (+civitai browser)"

TYPES = ["Checkpoint", "LORA", "LoCon", "DoRA", "TextualInversion", "VAE", "Upscaler", "Controlnet",
         "Hypernetwork", "MotionModule", "Poses", "Wildcards", "Other"]
FOLDER = {"Checkpoint": "checkpoints", "LORA": "loras", "LoCon": "loras", "DoRA": "loras",
          "TextualInversion": "embeddings", "VAE": "vae", "Upscaler": "upscale_models", "Controlnet": "controlnet",
          "Hypernetwork": "hypernetworks", "MotionModule": "animatediff_models", "Poses": "poses",
          "Wildcards": "wildcards", "Other": "other"}
BASES = ["Illustrious", "NoobAI", "Pony", "SDXL 1.0", "SDXL Lightning", "SDXL Hyper", "SD 1.5", "SD 1.5 LCM",
         "Flux.1 D", "Flux.1 S", "Flux.1 Krea", "Flux.1 Kontext", "SD 3.5", "SD 3.5 Large", "SD 3.5 Medium",
         "Qwen", "Wan Video", "Hunyuan Video", "HiDream", "Chroma", "Other"]
SORTS = ["Highest Rated", "Most Downloaded", "Most Liked", "Most Discussed", "Most Collected", "Newest"]
PERIODS = ["AllTime", "Year", "Month", "Week", "Day"]

_emit = lambda event, data: None  # задаёт main.py (SSE-хаб)
_lock = threading.RLock()
_jobs = []          # очередь и история, новые в конце
_workers = 0


def configure(emitter):
    global _emit
    _emit = emitter
    _load_jobs()


# ---------- настройки и хранилище ----------
def _read(path, default):
    try:
        return json.loads(path.read_text("utf-8"))
    except (OSError, ValueError):
        return default


def _write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    os.replace(tmp, path)


def settings():
    s = (_read(SETTINGS, {}) or {}).get("civitai") or {}
    return {"api_key": s.get("api_key", ""), "root": s.get("root", ""), "connections": int(s.get("connections", 4)),
            "concurrent": int(s.get("concurrent", 1)), "nsfw": bool(s.get("nsfw", False)),
            "verify": s.get("verify", True) is not False, "preview": s.get("preview", True) is not False}


def public_settings():
    s = settings()
    k = s["api_key"]
    return {**s, "api_key": (k[:4] + "…" + k[-4:]) if len(k) > 10 else ("•••" if k else ""), "has_key": bool(k),
            "roots": roots()}


def save_settings(data):
    full = _read(SETTINGS, {}) or {}
    cur = full.get("civitai") or {}
    for k in ("root", "connections", "concurrent", "nsfw", "verify", "preview"):
        if k in data:
            cur[k] = data[k]
    if "api_key" in data and "…" not in str(data["api_key"]) and data["api_key"] != "•••":
        cur["api_key"] = str(data["api_key"]).strip()
    cur["connections"] = max(1, min(16, int(cur.get("connections", 4))))
    cur["concurrent"] = max(1, min(4, int(cur.get("concurrent", 1))))
    full["civitai"] = cur
    _write(SETTINGS, full)
    _pump()
    return public_settings()


def roots():
    """Корни библиотеки, куда можно скачивать (существующие папки)."""
    rs, _pairs = L.sources()
    return [r["path"] for r in rs if r.get("exists")]


def _store():
    d = _read(STORE, {}) or {}
    d.setdefault("tags", {})
    d.setdefault("models", {})
    return d


def _folder_for(model_type, root=None):
    """Папка категории в выбранном корне: по раскладке из yaml Comfy Desktop, иначе <корень>/<категория>."""
    cat = FOLDER.get(model_type, "other")
    root = root or settings()["root"] or (roots() or [str(ROOT / "models")])[0]
    _rs, pairs = L.sources()
    for r, c, folder in pairs:
        if c == cat and Path(r) == Path(root):
            return Path(folder), cat
    return Path(root) / cat, cat


# ---------- HTTP ----------
def _get(url, timeout=30):
    req = urllib.request.Request(url, headers={"user-agent": UA, "accept": "application/json"})
    key = settings()["api_key"]
    if key and url.startswith(API):
        req.add_header("authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read()[:400].decode("utf-8", "replace")
        raise RuntimeError(f"Civitai {e.code}: {body or e.reason}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(f"Civitai unreachable: {e.reason}") from None


def _installed():
    """Что уже есть в библиотеке: имена файлов (нижний регистр) и id версий из .cminfo.json."""
    names, versions = set(), set()
    for it in L.index()["items"]:
        names.add(it["file"].lower())
        if it.get("cminfo"):
            try:
                v = json.loads(Path(it["cminfo"]).read_text("utf-8")).get("VersionId")
                if v:
                    versions.add(int(v))
            except (OSError, ValueError, TypeError):
                pass
    return names, versions


def _image(img):
    return {"url": img.get("url"), "nsfw": img.get("nsfwLevel") or img.get("nsfw"), "type": img.get("type") or "image",
            "w": img.get("width"), "h": img.get("height"),
            "meta": {k: v for k, v in (img.get("meta") or {}).items()
                     if k in ("prompt", "negativePrompt", "sampler", "steps", "cfgScale", "seed", "Size", "Model", "clipSkip")}}


def _version(v, names, versions):
    files = []
    for f in v.get("files") or []:
        files.append({"id": f.get("id"), "name": f.get("name"), "size": int((f.get("sizeKB") or 0) * 1024),
                      "type": f.get("type"), "primary": bool(f.get("primary")),
                      "format": (f.get("metadata") or {}).get("format"), "fp": (f.get("metadata") or {}).get("fp"),
                      "pruned": (f.get("metadata") or {}).get("size"), "url": f.get("downloadUrl"),
                      "sha256": (f.get("hashes") or {}).get("SHA256"),
                      "installed": (f.get("name") or "").lower() in names})
    return {"id": v.get("id"), "name": v.get("name"), "base": v.get("baseModel"), "published": v.get("publishedAt"),
            "trained": v.get("trainedWords") or [], "early": v.get("availability") == "EarlyAccess",
            "description": v.get("description") or "", "files": files,
            "images": [_image(i) for i in (v.get("images") or [])][:12],
            "installed": v.get("id") in versions or any(f["installed"] for f in files),
            "stats": v.get("stats") or {}}


def _model(m, names, versions):
    vs = [_version(v, names, versions) for v in m.get("modelVersions") or []]
    st = m.get("stats") or {}
    return {"id": m.get("id"), "name": m.get("name"), "type": m.get("type"), "nsfw": bool(m.get("nsfw")),
            "creator": (m.get("creator") or {}).get("username"), "avatar": (m.get("creator") or {}).get("image"),
            "tags": m.get("tags") or [], "description": m.get("description") or "",
            "stats": {"downloads": st.get("downloadCount", 0), "likes": st.get("thumbsUpCount", 0),
                      "rating": st.get("rating"), "comments": st.get("commentCount", 0), "collected": st.get("collectedCount", 0)},
            "versions": vs, "installed": any(v["installed"] for v in vs),
            "url": f"https://civitai.com/models/{m.get('id')}"}


def search(q="", types=None, bases=None, sort="Highest Rated", period="AllTime", nsfw=False, limit=20, cursor=None,
           username=""):
    params = [("sort", sort if sort in SORTS else "Highest Rated"),
              ("period", period if period in PERIODS else "AllTime"), ("nsfw", "true" if nsfw else "false")]
    if q:
        # с текстовым запросом Civitai отдаёт пусто при period ≠ AllTime (и сам решает порядок)
        params = [(k, "AllTime" if k == "period" else v) for k, v in params]
        params.append(("query", q))
    if username:
        params.append(("username", username))
    for t in types or []:
        params.append(("types", t))
    for b in bases or []:
        params.append(("baseModels", b))
    if cursor:
        params.append(("cursor", cursor))
    t0 = time.time()
    want = max(1, min(100, int(limit)))
    raw, nxt = [], cursor
    # с текстом Civitai фильтрует по типу/базе уже после поиска — страница сжимается; добираем страницами по 100
    pages = 6 if q and (types or bases) else 1
    for _ in range(pages):
        ps = [(k, v) for k, v in params if k not in ("cursor", "limit")] + [("limit", 100 if pages > 1 else want)]
        if nxt:
            ps.append(("cursor", nxt))
        data = _get(f"{API}/models?{urllib.parse.urlencode(ps)}")
        raw += data.get("items") or []
        nxt = (data.get("metadata") or {}).get("nextCursor")
        if len(raw) >= want or not nxt:
            break
    names, versions = _installed()
    items = [_model(m, names, versions) for m in raw]
    return {"items": items, "next": nxt, "took": round(time.time() - t0, 2)}


def model(mid):
    names, versions = _installed()
    return _model(_get(f"{API}/models/{int(mid)}"), names, versions)


def resolve(text):
    """Ссылка/ID → модель: civitai.com/models/123?modelVersionId=456, …/model-versions/456, «123», «v456»."""
    text = (text or "").strip()
    m = re.search(r"modelVersionId=(\d+)", text) or re.search(r"model-versions/(\d+)", text) or re.match(r"^v(\d+)$", text)
    if m:
        v = _get(f"{API}/model-versions/{m.group(1)}")
        out = model(v["modelId"])
        out["focus_version"] = int(m.group(1))
        return out
    m = re.search(r"models/(\d+)", text) or re.match(r"^(\d+)$", text)
    if not m:
        raise ValueError("expected a Civitai link or a model id")
    return model(m.group(1))


# ---------- метки (коллекции) ----------
def tags():
    d = _store()
    return {"tags": {k: v for k, v in d["tags"].items()}, "models": d["models"]}


def set_tags(models, add=(), remove=()):
    """models — карточки моделей (снимок сохраняется, чтобы метки работали без сети)."""
    d = _store()
    for m in models:
        mid = str(m["id"])
        d["models"][mid] = {k: m.get(k) for k in ("id", "name", "type", "nsfw", "creator", "stats", "url")} | {
            "image": next((i for v in m.get("versions") or [] for i in v.get("images") or [] if i.get("type") == "image"), None),
            "base": next((v.get("base") for v in m.get("versions") or []), None)}
        for t in add:
            t = str(t).strip()
            if t and mid not in d["tags"].setdefault(t, []):
                d["tags"][t].append(mid)
        for t in remove:
            if mid in d["tags"].get(t, []):
                d["tags"][t].remove(mid)
                if not d["tags"][t]:
                    del d["tags"][t]
    used = {x for ids in d["tags"].values() for x in ids}
    d["models"] = {k: v for k, v in d["models"].items() if k in used}
    _write(STORE, d)
    return tags()


# ---------- загрузки ----------
class Job:
    def __init__(self, model_, version, file, dest, name):
        self.id = uuid.uuid4().hex[:10]
        self.model, self.version, self.file = model_, version, file
        self.dest, self.name = str(dest), name
        self.state, self.error = "queued", ""
        self.done = 0
        self.total = file.get("size") or 0
        self.speed = 0.0
        self.created, self.started, self.finished = time.time(), None, None
        self.cancel = threading.Event()

    def snap(self):
        return {"id": self.id, "state": self.state, "error": self.error, "done": self.done, "total": self.total,
                "speed": round(self.speed), "name": self.name, "dest": self.dest,
                "model": {"id": self.model.get("id"), "name": self.model.get("name"), "type": self.model.get("type")},
                "version": {"id": self.version.get("id"), "name": self.version.get("name"), "base": self.version.get("base")},
                "file": {k: self.file.get(k) for k in ("id", "name", "size", "sha256", "url")},
                "image": next((i["url"] for i in self.version.get("images") or [] if i.get("type") == "image"), None),
                "created": self.created, "started": self.started, "finished": self.finished}


def _load_jobs():
    with _lock:
        for s in (_store().get("jobs") or [])[-200:]:
            j = Job(s["model"], s["version"] | {"images": [{"url": s.get("image"), "type": "image"}] if s.get("image") else []},
                    s["file"], s["dest"], s["name"])
            j.id, j.state, j.error = s["id"], s["state"], s.get("error", "")
            if j.state in ("queued", "running", "verifying"):
                j.state, j.error = "error", "interrupted (server restarted)"
            j.done, j.total = s.get("done", 0), s.get("total", 0)
            j.created, j.started, j.finished = s.get("created"), s.get("started"), s.get("finished")
            _jobs.append(j)


def _save_jobs():
    d = _store()
    d["jobs"] = [j.snap() for j in _jobs if j.state not in ("queued", "running", "verifying")][-200:]
    _write(STORE, d)


def jobs():
    with _lock:
        return [j.snap() for j in _jobs]


def _broadcast(job=None):
    _emit("civitai", {"job": job.snap()} if job else {"jobs": jobs()})


def _safe_name(name):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", name or "model.safetensors").strip(". ")
    return name or "model.safetensors"


def enqueue(model_id, version_id, file_id=None, root=None, filename=None):
    """Поставить файл версии в очередь. Возвращает снимок задания."""
    m = model(model_id)
    v = next((x for x in m["versions"] if x["id"] == int(version_id)), None)
    if not v:
        raise ValueError(f"version {version_id} not found in model {model_id}")
    files = v["files"]
    f = next((x for x in files if x["id"] == file_id), None) if file_id else \
        next((x for x in files if x["primary"]), None) or (files[0] if files else None)
    if not f or not f.get("url"):
        raise ValueError("the version has no downloadable files")
    folder, _cat = _folder_for(m["type"], root)
    name = _safe_name(filename or f["name"])
    with _lock:
        for j in _jobs:
            if j.state in ("queued", "running", "verifying") and j.file.get("id") == f["id"]:
                return j.snap()
        j = Job(m, v, f, folder / name, name)
        _jobs.append(j)
    _broadcast(j)
    _pump()
    return j.snap()


def cancel(job_id):
    with _lock:
        for j in _jobs:
            if j.id == job_id and j.state in ("queued", "running", "verifying"):
                j.cancel.set()
                if j.state == "queued":
                    j.state, j.finished = "cancelled", time.time()
                    _save_jobs()
                _broadcast(j)
                return j.snap()
    raise ValueError("no such active download")


def retry(job_id):
    with _lock:
        old = next((j for j in _jobs if j.id == job_id), None)
        if not old or old.state in ("queued", "running", "verifying"):
            raise ValueError("nothing to retry")
        j = Job(old.model, old.version, old.file, old.dest, old.name)
        _jobs.remove(old)
        _jobs.append(j)
    _broadcast()
    _pump()
    return j.snap()


def clear(job_ids=None):
    with _lock:
        keep = [j for j in _jobs if j.state in ("queued", "running", "verifying")
                or (job_ids is not None and j.id not in job_ids)]
        _jobs[:] = keep
        _save_jobs()
    _broadcast()
    return jobs()


def reveal(job_id):
    j = next((x for x in _jobs if x.id == job_id), None)
    if not j:
        raise ValueError("no such download")
    p = Path(j.dest)
    target = p if p.exists() else p.parent
    if os.name == "nt":
        import subprocess
        subprocess.Popen(["explorer", "/select,", str(target)] if target.is_file() else ["explorer", str(target)])
    return {"ok": True}


def _pump():
    """Запустить воркеры, пока есть задания и свободные слоты."""
    global _workers
    with _lock:
        while _workers < settings()["concurrent"] and any(j.state == "queued" for j in _jobs):
            _workers += 1
            threading.Thread(target=_worker, daemon=True).start()


def _worker():
    global _workers
    try:
        while True:
            with _lock:
                j = next((x for x in _jobs if x.state == "queued"), None)
                if not j:
                    return
                j.state, j.started = "running", time.time()
            _broadcast(j)
            try:
                _download(j)
                j.state = "done"
            except _Cancelled:
                j.state = "cancelled"
            except Exception as e:
                j.state, j.error = "error", f"{type(e).__name__}: {e}"
            j.finished = time.time()
            with _lock:
                _save_jobs()
            _broadcast(j)
            if j.state == "done":
                try:
                    L.index(refresh=True)
                    _emit("library-changed", {})
                except Exception:
                    pass
    finally:
        with _lock:
            _workers -= 1


class _Cancelled(Exception):
    pass


def _dl_url(url):
    key = settings()["api_key"]
    if key:
        url += ("&" if "?" in url else "?") + "token=" + urllib.parse.quote(key)
    return url


def _open(url, start=None, end=None, timeout=60):
    req = urllib.request.Request(url, headers={"user-agent": UA})
    if start is not None:
        req.add_header("range", f"bytes={start}-{'' if end is None else end}")
    try:
        return urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise RuntimeError("Civitai refused the download — this model needs an API key (Civitai → Settings)") from None
        raise RuntimeError(f"HTTP {e.code}: {e.reason}") from None


def _download(j):
    dest = Path(j.dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        raise RuntimeError(f"file already exists: {dest}")
    part = dest.with_name(dest.name + ".part")
    s = settings()
    # первый запрос: узнаём итоговый URL (после редиректа на хранилище), размер и поддержку Range
    r = _open(_dl_url(j.file["url"]), 0, None)
    final = r.geturl()
    cr = r.headers.get("content-range") or ""
    total = int(cr.rsplit("/", 1)[1]) if "/" in cr and cr.rsplit("/", 1)[1].isdigit() else int(r.headers.get("content-length") or 0)
    ranged = r.status == 206 and total > 0
    j.total = total or j.total
    conns = s["connections"] if ranged and total > 64 * 2**20 else 1
    last = [time.time(), 0]

    def tick(n):
        with _lock:
            j.done += n
        now = time.time()
        if now - last[0] >= 0.5:
            j.speed = (j.done - last[1]) / (now - last[0])
            last[0], last[1] = now, j.done
            _broadcast(j)
        if j.cancel.is_set():
            raise _Cancelled()

    try:
        if not ranged:
            with open(part, "wb") as out:
                while True:
                    b = r.read(1 << 20)
                    if not b:
                        break
                    out.write(b)
                    tick(len(b))
            r.close()
        else:
            r.close()
            with open(part, "wb") as out:
                out.truncate(total)
            step = -(-total // conns)
            errors = []

            def piece(a, b):
                """Кусок [a, b] с повторами: обрыв или таймаут рукопожатия — докачка с места обрыва."""
                pos, tries = a, 0
                while pos <= b:
                    try:
                        pr = _open(final, pos, b, timeout=30)
                        with open(part, "r+b") as out:
                            out.seek(pos)
                            while True:
                                chunk = pr.read(1 << 20)
                                if not chunk:
                                    break
                                out.write(chunk)
                                pos += len(chunk)
                                tick(len(chunk))
                        pr.close()
                        if pos <= b:
                            raise RuntimeError("connection closed early")
                    except _Cancelled as e:
                        errors.append(e)
                        return
                    except Exception as e:
                        tries += 1
                        if tries > 5 or j.cancel.is_set():
                            errors.append(e)
                            j.cancel.set()
                            return
                        time.sleep(min(10, 2 ** tries))
            th = [threading.Thread(target=piece, args=(a, min(a + step, total) - 1), daemon=True)
                  for a in range(0, total, step)]
            for t in th:
                t.start()
            for t in th:
                t.join()
            real = [e for e in errors if not isinstance(e, _Cancelled)]
            if real:
                raise real[0]
            if errors:
                raise _Cancelled()
        if total and part.stat().st_size != total:
            raise RuntimeError(f"incomplete download: {part.stat().st_size} of {total} bytes")
        if s["verify"] and j.file.get("sha256"):
            j.state = "verifying"
            _broadcast(j)
            h = hashlib.sha256()
            with open(part, "rb") as f:
                for b in iter(lambda: f.read(8 << 20), b""):
                    h.update(b)
                    if j.cancel.is_set():
                        raise _Cancelled()
            if h.hexdigest().upper() != j.file["sha256"].upper():
                raise RuntimeError("SHA256 mismatch — the file is corrupted, try again")
        os.replace(part, dest)
    except BaseException:
        try:
            part.unlink()
        except OSError:
            pass
        raise
    _sidecars(j, dest, s)


def _sidecars(j, dest, s):
    """<имя>.cminfo.json (поля, которые читает library.py) и <имя>.preview.jpeg."""
    m, v, f = j.model, j.version, j.file
    stem = dest.with_suffix("")
    info = {"ModelId": m.get("id"), "ModelName": m.get("name"), "ModelType": m.get("type"),
            "VersionId": v.get("id"), "VersionName": v.get("name"), "BaseModel": v.get("base"),
            "Nsfw": bool(m.get("nsfw")), "TrainedWords": v.get("trained") or [], "Tags": m.get("tags") or [],
            "CreatorUsername": m.get("creator"), "ModelDescription": m.get("description") or "",
            "VersionDescription": v.get("description") or "", "VersionPublishedAt": v.get("published"),
            "FileMetadata": {"format": f.get("format"), "fp": f.get("fp"), "size": f.get("pruned")},
            "Hashes": {"SHA256": f.get("sha256")}, "DownloadedBy": "maistep", "DownloadedAt": time.strftime("%Y-%m-%dT%H:%M:%S")}
    try:
        Path(f"{stem}.cminfo.json").write_text(json.dumps(info, ensure_ascii=False, indent=1), "utf-8")
    except OSError:
        pass
    if not s["preview"]:
        return
    img = next((i for i in v.get("images") or [] if i.get("type") == "image" and i.get("url")), None)
    if img:
        try:
            url = re.sub(r"/(?:original=true|width=\d+)(?:,[^/]*)?/", "/width=768/", img["url"])
            with _open(url, timeout=30) as r:
                Path(f"{stem}.preview.jpeg").write_bytes(r.read())
        except Exception:
            pass


def meta():
    return {"types": TYPES, "bases": BASES, "sorts": SORTS, "periods": PERIODS, "folders": FOLDER}
