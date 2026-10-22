"""Библиотека моделей из папок ComfyUI — ТОЛЬКО ЧТЕНИЕ (в папках моделей ничего не пишется, не переносится и не удаляется).

Где искать:
  1. yaml Comfy Desktop (%APPDATA%/Comfy Desktop/instance-model-paths/*.yaml) — base_path и категория → подпапки,
     ровно та раскладка, по которой ищет сам ComfyUI;
  2. список корней `model_roots` из user/settings.json (подпапки = категории, как models/ в ComfyUI).
Одна и та же категория/путь в нескольких корнях — побеждает первый (порядок yaml, затем model_roots).

О модели (веса не загружаются): размер и дата; заголовок safetensors (JSON в начале файла) — архитектура по именам
тензоров и __metadata__ (ss_*, modelspec.*); файлы рядом — .preview.(jpeg|png|webp), .cminfo.json (Civitai: название,
базовая модель, триггер-слова, теги, NSFW), .civitai.info, .civitaidl.json, .sha256.
"""
import json
import os
import re
import struct
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = ROOT / "user" / "settings.json"
META_CACHE = ROOT / "user" / "library_meta.json"

MODEL_EXT = {".safetensors", ".ckpt", ".pt", ".pth", ".bin", ".gguf", ".onnx", ".sft"}
PREVIEW_EXT = (".preview.jpeg", ".preview.jpg", ".preview.png", ".preview.webp", ".jpeg", ".jpg", ".png", ".webp")
DEFAULT_ROOTS = [
    r"D:\ComfyUI\models",
    os.path.expandvars(r"%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Shared\models"),
    os.path.expandvars(r"%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Installs\EvTs\ComfyUI\models"),
]
HEADER_MAX = 64 * 1024 * 1024  # заголовок safetensors длиннее — только в экзотике

_lock = threading.Lock()
_index = None      # {"at", "roots", "items": [...], "by_id": {...}}
_meta = None       # path → {"mtime", "size", ...}


# ---------- источники ----------

def _parse_desktop_yaml(text):
    """Минимальный разбор yaml Comfy Desktop: секции → base_path и 'cat': 'sub/' или |- со списком строк."""
    out, cur, multi = [], None, None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line or line.lstrip().startswith("#"):
            continue
        if not raw.startswith(" "):
            cur = {"name": line.rstrip(":"), "base": None, "cats": {}}
            out.append(cur)
            multi = None
            continue
        if cur is None:
            continue
        s = line.strip()
        if multi and raw.startswith("    "):
            cur["cats"][multi].append(s.strip("'\""))
            continue
        multi = None
        m = re.match(r"""^['"]?([^'":]+)['"]?\s*:\s*(.*)$""", s)
        if not m:
            continue
        k, v = m.group(1), m.group(2).strip()
        if k == "base_path":
            cur["base"] = v.strip("'\"")
        elif k == "is_default":
            continue
        elif v in ("|", "|-", ">", ">-"):
            multi = k
            cur["cats"][k] = []
        else:
            cur["cats"][k] = [v.strip("'\"")]
    return out


def _settings():
    try:
        return json.loads(SETTINGS.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def sources():
    """Пары (корень, категория, папка) для сканирования и описание корней для UI."""
    roots, pairs, seen = [], [], set()
    ydir = Path(os.path.expandvars(r"%APPDATA%")) / "Comfy Desktop" / "instance-model-paths"
    for y in sorted(ydir.glob("*.yaml")) if ydir.is_dir() else []:
        try:
            secs = _parse_desktop_yaml(y.read_text("utf-8", errors="replace"))
        except OSError:
            continue
        for sec in secs:
            if not sec["base"]:
                continue
            base = Path(sec["base"])
            roots.append({"path": str(base), "from": f"Comfy Desktop ({y.name})", "exists": base.is_dir()})
            for cat, subs in sec["cats"].items():
                for sub in subs:
                    pairs.append((str(base), cat, base / sub.strip("/\\")))
    extra = _settings().get("model_roots") or DEFAULT_ROOTS
    for r in extra:
        base = Path(r)
        if any(Path(x["path"]) == base for x in roots):
            continue
        roots.append({"path": str(base), "from": "settings" if _settings().get("model_roots") else "default", "exists": base.is_dir()})
        if base.is_dir():
            for d in sorted(base.iterdir()):
                if d.is_dir() and not d.name.startswith("."):
                    pairs.append((str(base), d.name, d))
    out = []
    for root, cat, folder in pairs:
        key = (cat, str(folder).lower())
        if key not in seen:
            seen.add(key)
            out.append((root, cat, folder))
    return roots, out


# ---------- индекс ----------

def _sidecars(path: Path):
    stem = path.with_suffix("")
    side = {}
    for ext in PREVIEW_EXT:
        p = Path(f"{stem}{ext}")
        if p.is_file():
            side["preview"] = str(p)
            break
    for ext, key in ((".cminfo.json", "cminfo"), (".civitai.info", "civitai"), (".civitaidl.json", "civitaidl"), (".metadata.json", "metajson"), (".sha256", "sha256")):
        p = Path(f"{stem}{ext}")
        if p.is_file():
            side[key] = str(p)
    return side


def scan():
    """Полный обход папок (только имена, размеры, файлы рядом — быстро)."""
    global _index
    t0 = time.time()
    roots, pairs = sources()
    items, by_id = [], {}
    for root, cat, folder in pairs:
        if not folder.is_dir():
            continue
        for dirpath, dirnames, files in os.walk(folder):
            dirnames[:] = [d for d in dirnames if not d.startswith(".")]
            for f in files:
                p = Path(dirpath) / f
                if p.suffix.lower() not in MODEL_EXT:
                    continue
                rel = p.relative_to(folder).as_posix()
                mid = f"{cat}/{rel}"
                if mid in by_id:  # та же модель в другом корне — побеждает первый (как в ComfyUI)
                    by_id[mid]["dups"] = by_id[mid].get("dups", 0) + 1
                    continue
                st = p.stat()
                it = {"id": mid, "cat": cat, "name": rel, "file": f, "ext": p.suffix.lower()[1:], "root": root,
                      "path": str(p), "size": st.st_size, "mtime": st.st_mtime, **_sidecars(p)}
                items.append(it)
                by_id[mid] = it
    # лёгкие сведения из cminfo — сразу, для поиска и значков в галерее
    for it in items:
        if "cminfo" in it:
            try:
                d = json.loads(Path(it["cminfo"]).read_text("utf-8"))
                it["title"] = d.get("ModelName")
                it["base"] = d.get("BaseModel")
                it["type"] = d.get("ModelType")
                it["nsfw"] = bool(d.get("Nsfw"))
                it["trained"] = [w.strip().strip(",").strip() for w in d.get("TrainedWords") or [] if w.strip().strip(",")]
            except (OSError, ValueError):
                pass
    with _lock:
        _index = {"at": time.time(), "roots": roots, "items": items, "by_id": by_id, "took": round(time.time() - t0, 2)}
    return _index


def index(refresh=False):
    if _index is None or refresh:
        return scan()
    return _index


def summary(refresh=False):
    ix = index(refresh)
    cats = {}
    for it in ix["items"]:
        c = cats.setdefault(it["cat"], {"count": 0, "size": 0})
        c["count"] += 1
        c["size"] += it["size"]
    pub = [{k: v for k, v in it.items() if k not in ("cminfo", "civitai", "civitaidl", "metajson", "sha256")} | {"has_preview": "preview" in it}
           for it in ix["items"]]
    for p in pub:
        p.pop("preview", None)
    return {"at": ix["at"], "took": ix["took"], "roots": ix["roots"], "categories": cats, "items": pub}


def names(cat):
    """Имена моделей категории (так их пишет ComfyUI в своих виджетах)."""
    return sorted(it["name"] for it in index()["items"] if it["cat"] == cat)


def preview_path(mid):
    it = index()["by_id"].get(mid)
    return it and it.get("preview")


# ---------- подробности ----------

def _arch(keys, meta):
    """Архитектура по именам тензоров и __metadata__ (грубо, но полезно)."""
    m = {k.lower(): str(v) for k, v in (meta or {}).items()}
    if m.get("modelspec.architecture"):
        return m["modelspec.architecture"]
    if m.get("ss_base_model_version"):
        return m["ss_base_model_version"]
    ks = keys if len(keys) < 4000 else keys[:4000]
    s = " ".join(ks[:4000])
    lora = any(".lora_" in k or "lora_unet" in k or "lora_te" in k or ".lora_A" in k or ".lora_down" in k for k in ks)
    tag = (
        "Flux" if "double_blocks" in s or "single_transformer_blocks" in s else
        "Wan" if "blocks.0.cross_attn" in s or "patch_embedding" in s else
        "Qwen-Image" if "transformer_blocks.0.img_mod" in s or "txt_norm" in s else
        "SD3" if "joint_blocks" in s else
        "SDXL" if "conditioner.embedders.1" in s or "add_embedding" in s or "label_emb" in s else
        "SD1.x" if "cond_stage_model.transformer" in s or "model.diffusion_model.input_blocks" in s else
        "VAE" if "decoder.conv_in" in s and "encoder.conv_in" in s and len(ks) < 400 else
        "")
    return f"{tag} LoRA".strip() if lora else tag


def _safetensors_header(path):
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        if n <= 0 or n > HEADER_MAX:
            return None
        return json.loads(f.read(n))


def _load_meta_cache():
    global _meta
    if _meta is None:
        try:
            _meta = json.loads(META_CACHE.read_text("utf-8"))
        except (OSError, ValueError):
            _meta = {}
    return _meta


def details(mid):
    """Полная карточка модели: индекс + заголовок safetensors + файлы рядом. Заголовок кэшируется по mtime."""
    it = index()["by_id"].get(mid)
    if not it:
        raise KeyError(mid)
    # пути служебных файлов наружу не отдаём — только разобранное содержимое
    out = {k: v for k, v in it.items() if k not in ("preview", "cminfo", "civitai", "civitaidl", "metajson", "sha256")} | {"has_preview": "preview" in it}
    cache = _load_meta_cache()
    c = cache.get(it["path"])
    if not c or c.get("mtime") != it["mtime"]:
        c = {"mtime": it["mtime"]}
        if it["ext"] in ("safetensors", "sft"):
            try:
                h = _safetensors_header(it["path"]) or {}
                meta = h.pop("__metadata__", {}) or {}
                keys = list(h.keys())
                dtypes = {}
                params = 0
                for v in h.values():
                    if isinstance(v, dict):
                        dtypes[v.get("dtype")] = dtypes.get(v.get("dtype"), 0) + 1
                        n = 1
                        for d in v.get("shape") or []:
                            n *= d
                        params += n
                c.update(tensors=len(keys), params=params, dtypes=dtypes, arch=_arch(keys, meta),
                         meta={k: (v if len(str(v)) < 2000 else str(v)[:2000] + "…") for k, v in meta.items() if k != "ss_tag_frequency"},
                         tags=_top_tags(meta.get("ss_tag_frequency")))
            except Exception as e:
                c["error"] = f"{type(e).__name__}: {e}"
        with _lock:
            cache[it["path"]] = c
            try:
                META_CACHE.parent.mkdir(exist_ok=True)
                META_CACHE.write_text(json.dumps(cache, ensure_ascii=False), "utf-8")
            except OSError:
                pass
    out.update({k: v for k, v in c.items() if k != "mtime"})
    if "cminfo" in it:
        try:
            d = json.loads(Path(it["cminfo"]).read_text("utf-8"))
            out["civitai"] = {
                "name": d.get("ModelName"), "version": d.get("VersionName"), "creator": d.get("CreatorUsername"),
                "type": d.get("ModelType"), "base": d.get("BaseModel"), "nsfw": d.get("Nsfw"), "tags": d.get("Tags") or [],
                "trained": it.get("trained") or [], "url": f"https://civitai.com/models/{d['ModelId']}?modelVersionId={d.get('VersionId')}" if d.get("ModelId") else None,
                "description": _strip_html(d.get("VersionDescription") or d.get("ModelDescription") or "")[:3000],
                "published": d.get("VersionPublishedAt"), "file": d.get("FileMetadata"),
                "sha256": (d.get("Hashes") or {}).get("SHA256"),
            }
        except (OSError, ValueError) as e:
            out["civitai_error"] = str(e)
    if "civitaidl" in it and "civitai" not in out:
        try:
            out["civitai"] = {"url": json.loads(Path(it["civitaidl"]).read_text("utf-8")).get("modelUrl")}
        except (OSError, ValueError):
            pass
    if "sha256" in it:
        try:
            out["sha256"] = Path(it["sha256"]).read_text("utf-8").split()[0]
        except (OSError, IndexError):
            pass
    return out


def _top_tags(freq, n=30):
    """ss_tag_frequency (обучение kohya) → самые частые теги."""
    if not freq:
        return []
    try:
        d = json.loads(freq) if isinstance(freq, str) else freq
    except ValueError:
        return []
    total = {}
    for sub in d.values():
        for t, c in (sub or {}).items():
            total[t.strip()] = total.get(t.strip(), 0) + c
    return [t for t, _ in sorted(total.items(), key=lambda x: -x[1])[:n]]


def _strip_html(s):
    s = re.sub(r"<br\s*/?>|</p>|</h\d>|</li>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    return re.sub(r"\n{3,}", "\n\n", s.replace("&nbsp;", " ").replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")).strip()
