"""Magic KSampler: подбор параметров сэмплинга под чекпоинт.

LoRA на параметры (steps/cfg/сэмплер) не влияют — по ним только совместимость с базой, сила и триггер-слова.
Источники (по убыванию веса):
  1. «быстрые» чекпоинты (Lightning / Hyper / Turbo / LCM / DMD2) — у них жёсткие требования к steps/cfg/сэмплеру;
  2. описание версии чекпоинта с Civitai (.cminfo.json) — автор обычно пишет «Steps: 25-30, CFG: 5-7, Sampler: Euler a»;
  3. параметры картинок-примеров версии на Civitai (медиана; запрос один раз, кэш user/magic_cache.json);
  4. профиль базовой модели (Illustrious, NoobAI, Pony, Animagine, SDXL, SD1.5, реалистичные миксы).
Сверху — подсказки к промпту (теги качества базы), clip skip, размер, совместимость и сила LoRA, триггер-слова.
Только чтение: в папки моделей ничего не пишется.
"""
import json
import re
import statistics
import threading
import time
from pathlib import Path

from . import library as L

ROOT = Path(__file__).resolve().parents[2]
CACHE = ROOT / "user" / "magic_cache.json"
PARAMS = ("steps", "cfg", "sampler_name", "scheduler")

_lock = threading.Lock()
_cache = None

# профили баз: параметры, теги качества, clip skip, размер
_IL_POS = "masterpiece, best quality, amazing quality, very aesthetic, absurdres"
_IL_NEG = "lowres, worst quality, bad quality, bad anatomy, bad hands, jpeg artifacts, signature, watermark"
PROFILES = {
    "illustrious": {"title": "Illustrious", "steps": 28, "cfg": 5.5, "sampler_name": "euler_ancestral", "scheduler": "normal",
                    "pos": _IL_POS, "neg": _IL_NEG, "clip_skip": -2, "size": [832, 1216]},
    "illustrious_real": {"title": "Illustrious (реализм)", "steps": 30, "cfg": 4.5, "sampler_name": "dpmpp_2m", "scheduler": "karras",
                         "pos": "masterpiece, best quality, photorealistic, highly detailed", "neg": _IL_NEG, "clip_skip": -2, "size": [832, 1216]},
    "noobai": {"title": "NoobAI", "steps": 28, "cfg": 5.0, "sampler_name": "euler_ancestral", "scheduler": "normal",
               "pos": "masterpiece, best quality, newest, absurdres, highres", "neg": "worst quality, old, early, low quality, lowres, signature, username, logo, bad hands, mutated hands",
               "clip_skip": -2, "size": [832, 1216]},
    "pony": {"title": "Pony", "steps": 25, "cfg": 7.0, "sampler_name": "euler_ancestral", "scheduler": "normal",
             "pos": "score_9, score_8_up, score_7_up", "neg": "score_6, score_5, score_4, lowres, bad anatomy, bad hands",
             "clip_skip": -2, "size": [832, 1216]},
    "animagine": {"title": "Animagine XL", "steps": 28, "cfg": 5.0, "sampler_name": "euler_ancestral", "scheduler": "normal",
                  "pos": "masterpiece, high score, great score, absurdres",
                  "neg": "lowres, bad anatomy, bad hands, text, error, worst quality, low quality, low score, bad score, average score, signature, watermark, username, blurry",
                  "clip_skip": -2, "size": [832, 1216]},
    "sdxl": {"title": "SDXL", "steps": 30, "cfg": 6.5, "sampler_name": "dpmpp_2m", "scheduler": "karras",
             "pos": "high quality, detailed", "neg": "lowres, low quality, blurry, watermark, text", "clip_skip": -1, "size": [1024, 1024]},
    "sdxl_real": {"title": "SDXL (реализм)", "steps": 30, "cfg": 5.0, "sampler_name": "dpmpp_2m_sde", "scheduler": "karras",
                  "pos": "photo, highly detailed, sharp focus", "neg": "cartoon, painting, illustration, lowres, blurry, watermark", "clip_skip": -1, "size": [896, 1152]},
    "sd15": {"title": "SD 1.5", "steps": 25, "cfg": 7.0, "sampler_name": "dpmpp_2m", "scheduler": "karras",
             "pos": "masterpiece, best quality", "neg": "lowres, worst quality, low quality, bad anatomy, bad hands, watermark", "clip_skip": -2, "size": [512, 768]},
}
# «быстрые» дистилляты: признак в имени/базе → параметры (steps — по умолчанию, «4step»/«8steps» в имени уточняет)
SPEED = [
    ("lightning", {"title": "Lightning", "steps": 8, "cfg": 1.5, "sampler_name": "euler", "scheduler": "sgm_uniform"}),
    ("hyper", {"title": "Hyper-SD", "steps": 8, "cfg": 1.5, "sampler_name": "euler", "scheduler": "sgm_uniform"}),
    ("dmd", {"title": "DMD2", "steps": 8, "cfg": 1.0, "sampler_name": "lcm", "scheduler": "normal"}),
    ("lcm", {"title": "LCM", "steps": 6, "cfg": 1.5, "sampler_name": "lcm", "scheduler": "normal"}),
    ("turbo", {"title": "Turbo", "steps": 8, "cfg": 2.0, "sampler_name": "dpmpp_sde", "scheduler": "karras"}),
]
SAMPLER_NAMES = ["euler", "euler_ancestral", "heun", "lms", "dpm_2", "dpm_2_ancestral", "dpmpp_2m", "dpmpp_2m_sde",
                 "dpmpp_3m_sde", "dpmpp_sde", "ddim", "ddpm", "uni_pc", "lcm"]
SCHEDULER_NAMES = ["normal", "karras", "exponential", "beta", "simple", "sgm_uniform", "ddim_uniform"]


# ---------- имена сэмплеров A1111 / Civitai → ComfyUI ----------
def parse_sampler(text):
    """«DPM++ 2M Karras», «Euler a», «euler_ancestral» → (sampler_name | None, scheduler | None)."""
    s = (text or "").strip().lower().replace("_", " ")
    if not s:
        return None, None
    sched = next((k for k in ("karras", "exponential", "sgm uniform", "simple", "beta") if k in s), None)
    sched = sched.replace(" ", "_") if sched else None
    flat = s.replace("+", "p").replace(" ", "")
    table = [
        ("dpmpp2msde", "dpmpp_2m_sde"), ("dpmpp3msde", "dpmpp_3m_sde"), ("dpmpp2m", "dpmpp_2m"), ("dpmppsde", "dpmpp_sde"),
        ("dpm2a", "dpm_2_ancestral"), ("dpm2ancestral", "dpm_2_ancestral"), ("dpm2", "dpm_2"),
        ("eulera", "euler_ancestral"), ("eulerancestral", "euler_ancestral"), ("euler", "euler"),
        ("heun", "heun"), ("lms", "lms"), ("ddim", "ddim"), ("ddpm", "ddpm"), ("unipc", "uni_pc"), ("lcm", "lcm"),
    ]
    name = next((v for k, v in table if flat.startswith(k)), None)
    if name is None:
        name = next((v for k, v in table if k in flat), None)
    return name, sched


# ---------- разбор описания ----------
_RANGE = r"(\d{1,3}(?:[.,]\d+)?)(?:\s*(?:-|~|–|—|to|до)\s*(\d{1,3}(?:[.,]\d+)?))?"


def _num(a, b=None, k=0.5):
    """Число или диапазон «a-b» → точка внутри диапазона (k — доля от нижней границы)."""
    x = float(a.replace(",", "."))
    if b:
        x += (float(b.replace(",", ".")) - x) * k
    return x


def parse_description(text):
    """Рекомендации автора из описания модели: steps, cfg, сэмплер, планировщик, clip skip, сила LoRA."""
    t = re.sub(r"<[^>]+>", " ", text or "")
    out = {}
    for m in re.finditer(r"(?i)(hires|upscal\w*|refin\w*|adetailer|2nd)?[^\n.]{0,12}?\bsteps?\b[^\d\n]{0,12}" + _RANGE, t):
        if m.group(1):
            continue
        v = _num(m.group(2), m.group(3), 0.6)  # шагов — ближе к верху диапазона
        if 3 <= v <= 80:
            out["steps"] = int(round(v))
            break
    m = re.search(r"(?i)\bcfg(?:\s*scale)?\b[^\d\n]{0,12}" + _RANGE, t)
    if m:
        v = _num(m.group(1), m.group(2))
        if 1 <= v <= 15:
            out["cfg"] = round(v * 2) / 2
    m = re.search(r"(?i)\bsampl(?:er|ing)(?:\s*method)?\b\s*[:=\-–]\s*([^\n,;|/(]+)", t)
    if m:
        name, sched = parse_sampler(m.group(1))
        if name:
            out["sampler_name"] = name
        if sched:
            out["scheduler"] = sched
    m = re.search(r"(?i)\bschedul(?:er|e type)\b\s*[:=\-–]\s*(karras|exponential|normal|simple|sgm[_ ]uniform|beta)", t)
    if m:
        out["scheduler"] = m.group(1).lower().replace(" ", "_")
    m = re.search(r"(?i)\bclip\s*skip\b[^\d\n]{0,6}(\d)", t)
    if m and 1 <= int(m.group(1)) <= 4:
        out["clip_skip"] = -int(m.group(1))
    m = re.search(r"(?i)\b(?:weight|strength|вес|сила)\b[^\d\n]{0,12}" + _RANGE, t)
    if m:
        v = _num(m.group(1), m.group(2))
        if 0.05 <= v <= 2:
            out["weight"] = round(v, 2)
    return out


# ---------- примеры с Civitai ----------
def _load_cache():
    global _cache
    if _cache is None:
        try:
            _cache = json.loads(CACHE.read_text("utf-8"))
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _save_cache():
    try:
        CACHE.parent.mkdir(exist_ok=True)
        CACHE.write_text(json.dumps(_cache, ensure_ascii=False), "utf-8")
    except OSError:
        pass


def civitai_examples(version_id, refresh=False):
    """Медиана параметров картинок-примеров версии (Civitai model-versions). Кэш — неделя, ошибка — сутки."""
    if not version_id:
        return {}
    key = str(version_id)
    with _lock:
        c = _load_cache().get(key)
    ttl = 7 * 86400 if c and not c.get("error") else 86400
    if c and not refresh and time.time() - c.get("at", 0) < ttl:
        return c.get("params") or {}
    params, err = {}, None
    try:
        from . import civitai
        data = civitai._get(f"{civitai.API}/model-versions/{version_id}", timeout=10)
        metas = [i.get("meta") or {} for i in data.get("images") or []]
        metas = [m for m in metas if m.get("steps") and m.get("cfgScale")]
        if len(metas) >= 2:
            params["steps"] = int(statistics.median(int(m["steps"]) for m in metas))
            params["cfg"] = round(statistics.median(float(m["cfgScale"]) for m in metas) * 2) / 2
            samplers, scheds = [], []
            for m in metas:
                name, sched = parse_sampler(m.get("sampler"))
                if name:
                    samplers.append(name)
                sched = sched or (str(m.get("Schedule type") or m.get("scheduler") or "").lower() or None)
                if sched in SCHEDULER_NAMES:
                    scheds.append(sched)
            if samplers:
                params["sampler_name"] = statistics.mode(samplers)
            if scheds:
                params["scheduler"] = statistics.mode(scheds)
            params["count"] = len(metas)
    except Exception as e:  # нет сети / ключа — не страшно, есть другие источники
        err = f"{type(e).__name__}: {e}"
    with _lock:
        _load_cache()[key] = {"at": time.time(), "params": params, "error": err}
        _save_cache()
    return params


# ---------- модель → профиль ----------
def _item(cat, name_or_path):
    s = str(name_or_path)
    for it in L.index()["items"]:
        if it["cat"] == cat and (it["name"] == s or it["path"] == s):
            return it
    return None


def _cminfo(it):
    try:
        return json.loads(Path(it["cminfo"]).read_text("utf-8")) if it and it.get("cminfo") else {}
    except (OSError, ValueError):
        return {}


def _arch(it):
    try:
        return L.details(it["id"]).get("arch") or ""
    except Exception:
        return ""


def _speed(text):
    t = text.lower()
    for key, prof in SPEED:
        if key in t:
            p = dict(prof)
            m = re.search(r"(\d{1,2})\s*-?\s*steps?", t)
            if m and 1 <= int(m.group(1)) <= 16:
                p["steps"] = int(m.group(1))
            return p
    return None


def profile_of(it, info):
    """Ключ профиля по базе с Civitai, имени файла и архитектуре из заголовка."""
    base = (info.get("BaseModel") or it.get("base") or "").lower()
    name = (it.get("name") or "").lower()
    title = (info.get("ModelName") or "").lower()
    text = f"{base} {name} {title}"
    real = any(w in text for w in ("real", "photo", "realis"))
    if "pony" in text:
        return "pony"
    if "noob" in text:
        return "noobai"
    if "animagine" in text:
        return "animagine"
    if "illustrious" in text or re.search(r"\bil(xl)?\b|wai|ilxl", text):
        return "illustrious_real" if real else "illustrious"
    if "1.5" in base or "sd 1" in base or "sd1" in base:
        return "sd15"
    if "xl" in base or "sdxl" in text:
        return "sdxl_real" if real else "sdxl"
    arch = _arch(it).lower()
    if "1.x" in arch or "sd1" in arch or "1.5" in arch:
        return "sd15"
    return "sdxl_real" if real else "illustrious" if "xl" in arch else "sdxl"


def _family(key):
    return "sd15" if key == "sd15" else "sdxl"


def _lora_family(it, info):
    base = (info.get("BaseModel") or it.get("base") or "").lower()
    if not base:
        a = _arch(it).lower()
        return "sd15" if ("1.x" in a or "sd1" in a or "1.5" in a) else "sdxl" if "xl" in a else None
    if any(k in base for k in ("illustrious", "noob", "pony", "sdxl", "xl")):
        return "sdxl"
    if "1.5" in base or "sd 1" in base:
        return "sd15"
    return "other:" + (info.get("BaseModel") or it.get("base"))


def recommend(ckpt, loras=(), refresh=False, online=True):
    """Рекомендованные параметры KSampler. ckpt — имя (как в виджете) или путь; loras — [(имя|путь, сила)]."""
    it = _item("checkpoints", ckpt) if ckpt else None
    if not it:
        return {"ok": False, "error": f"checkpoint «{ckpt}» not found in the library" if ckpt else "no checkpoint",
                "params": {k: PROFILES["illustrious"][k] for k in PARAMS}, "profile": "—", "notes": [], "source": {}}
    info = _cminfo(it)
    key = profile_of(it, info)
    prof = PROFILES[key]
    params = {k: prof[k] for k in PARAMS}
    source = {k: f"профиль {prof['title']}" for k in PARAMS}
    notes = []
    clip_skip = prof["clip_skip"]

    def take(d, label):
        nonlocal clip_skip
        for k in PARAMS:
            if d.get(k) is not None:
                params[k] = d[k]
                source[k] = label
        if d.get("clip_skip"):
            clip_skip = d["clip_skip"]

    ex = civitai_examples(info.get("VersionId"), refresh) if online else {}
    if ex:
        take(ex, f"примеры Civitai ({ex.get('count')})")
    desc = parse_description(f"{info.get('VersionDescription') or ''}\n{info.get('ModelDescription') or ''}")
    if desc:
        take(desc, "описание чекпоинта")
    sp = _speed(f"{it['name']} {info.get('BaseModel') or ''} {info.get('VersionName') or ''}")
    if sp:
        take(sp, f"{sp['title']}-чекпоинт")
        notes.append(f"{sp['title']}-чекпоинт: мало шагов и низкий CFG — так задумано")

    fam = _family(key)
    lor = []
    for name, strength in loras or ():
        li = _item("loras", name)
        if not li:
            lor.append({"name": Path(str(name)).name, "ok": False, "note": "нет в библиотеке"})
            continue
        linfo = _cminfo(li)
        lf = _lora_family(li, linfo)
        d = parse_description(f"{linfo.get('VersionDescription') or ''}\n{linfo.get('ModelDescription') or ''}")
        row = {"name": li["name"], "base": linfo.get("BaseModel") or li.get("base"), "strength": strength,
               "weight": d.get("weight"), "trained": li.get("trained") or [], "ok": True}
        if lf and lf != fam:
            row["ok"] = False
            row["note"] = f"LoRA для {lf.replace('other:', '')}, чекпоинт — {prof['title']}: не подойдёт"
        lsp = _speed(li["name"])  # параметры чекпоинта не трогаем (правило), но подсказываем, что нужно быстрой LoRA
        if lsp:
            notes.append(f"{lsp['title']}-LoRA {li['name']}: поставьте steps {lsp['steps']}, cfg {lsp['cfg']:g}, "
                         f"{lsp['sampler_name']}/{lsp['scheduler']} — с обычными параметрами картинка пережжётся")
        if row["weight"] and abs(float(strength or 0) - row["weight"]) > 0.25:
            row["note"] = (row.get("note") + "; " if row.get("note") else "") + f"автор советует силу ≈ {row['weight']}"
        lor.append(row)
    if key == "pony":
        notes.append("Pony: начните промпт с score_9, score_8_up, score_7_up")
    if "vpred" in it["name"].lower() or "v-pred" in (info.get("VersionName") or "").lower():
        notes.append("v-prediction модель — локальная генерация её пока не поддерживает (нужен eps)")
    if params["sampler_name"] not in SAMPLER_NAMES:
        params["sampler_name"] = prof["sampler_name"]
    if params["scheduler"] not in SCHEDULER_NAMES:
        params["scheduler"] = prof["scheduler"]
    params["steps"] = int(params["steps"])
    params["cfg"] = float(params["cfg"])
    return {"ok": True, "params": params, "source": source, "profile": prof["title"], "profile_key": key,
            "family": fam, "ckpt": it["name"], "base": info.get("BaseModel") or it.get("base"),
            "prompt": {"positive": prof["pos"], "negative": prof["neg"]}, "clip_skip": clip_skip, "size": prof["size"],
            "loras": lor, "notes": notes}
