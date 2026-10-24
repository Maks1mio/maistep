"""Локальная генерация Stable Diffusion (torch + diffusers) — набор нод в духе ComfyUI.

Граф как в ComfyUI: Load Checkpoint → (MODEL, CLIP, VAE) → Load LoRA → CLIP Text Encode (positive / negative)
→ KSampler (+ Empty Latent Image или VAE Encode) → VAE Decode → IMAGE. Значения между нодами — лёгкие описатели
(Model, Clip, Vae, Cond, Latent); тяжёлый пайплайн diffusers один, держится в памяти (_state) и подгружается
по описателю при необходимости. Чекпоинты и LoRA — из библиотеки моделей (library.py); SD1.5 и SDXL
(Pony / Illustrious / аниме-миксы).

Пакеты — только в .venv проекта (см. requirements.txt):
    .venv\\Scripts\\python -m pip install torch --index-url https://download.pytorch.org/whl/cu130
    .venv\\Scripts\\python -m pip install -r requirements.txt

Настройки в user/settings.json:
    "gen": {"device": "cuda|cpu|auto", "dtype": "fp16|bf16|fp32", "offload": "auto|true|false", "keep": true,
            "vae_dtype": "auto|bf16|fp16|fp32"}

Раскладка по памяти (offload):
    auto  (по умолчанию) — всё на GPU при 12+ ГБ VRAM, иначе «split»: UNet+VAE на GPU, текстовые энкодеры
          на CPU (пик ~6 ГБ — важно для 8 ГБ карт, где всё сразу уезжает в sysmem и генерация ползёт);
    true  — model-offload от accelerate: на GPU только текущий модуль (медленнее, минимальный пик);
    false — всё на GPU.
VAE — по образцу ComfyUI (comfy/sd.py, model_management.py): dtype auto = bf16 там, где карта умеет (у SDXL-VAE
нет NaN, перекаст в fp32 не нужен), иначе fp16; перед VAE-операцией оценивается память, и если рядом с UNet
места мало — UNet временно уходит на CPU (на Windows нехватка не даёт OOM, а уводит память в sysmem: секунды
превращаются в минуты). Если места мало и без UNet — тайлы; NaN → повтор в fp32. Старое vae_fp16=false = fp32.
keep=false — выгружать модель после каждого VAE Decode.

AMD (ROCm-сборка torch, тот же API torch.cuda) — как в ComfyUI: на RDNA3+ MIOpen выключен (cudnn.enabled=False,
свёртки так быстрее; MAISTEP_ENABLE_MIOPEN=1 — вернуть), в VAE внимание без SDPA (на AMD оно падает на больших
разрешениях), на RDNA2 и старше нет bf16 — VAE в fp32.

Лимиты нагрузки (sysmon.py, «Сервер → Производительность и лимиты…»): vram_max_pct — потолок памяти torch
(set_per_process_memory_fraction; оценки места ниже считают от него), max_mp — предел размера картинки,
gpu_load — паузы между шагами сэмплера. Запас RAM следит sysmon и при нехватке прерывает запуск.
"""
import gc
import math
import os
import re
import sys
import threading
import time
from pathlib import Path

def _rocm_build():
    """ROCm-сборка torch — по версии пакета (+rocm…), без импорта torch: настройки аллокатора действуют только до него."""
    try:
        from importlib.metadata import version
        return "rocm" in version("torch").lower()
    except Exception:
        return False


ROCM = _rocm_build()
# expandable_segments — только CUDA. На ROCm (HIP VMM) он при каждом empty_cache() снимает и заново отображает
# физическую память, и на RDNA4 под Linux это давало зелёные артефакты по всему экрану со второй генерации и
# зависание сэмплера (отчёты Марши 2026-10-25). ComfyUI на AMD его тоже не включает. MAISTEP_EXPANDABLE=1 — вернуть.
if not ROCM or os.environ.get("MAISTEP_EXPANDABLE") == "1":
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", "expandable_segments:True")
os.environ.setdefault("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", "1")  # flash-внимание на RDNA3/4 (ROCm)

# AMD до RDNA3: bf16 нет (у ComfyUI — тот же список)
AMD_OLD = ("gfx1030", "gfx1031", "gfx1032", "gfx1033", "gfx1034", "gfx1035", "gfx1036", "gfx1010", "gfx1011", "gfx1012",
           "gfx906", "gfx900", "gfx803")


def _dbg(*args):
    """Диагностика фаз генерации: MAISTEP_DEBUG=1 (пишет в stderr сервера)."""
    if os.environ.get("MAISTEP_DEBUG") == "1":
        print("[diffusion]", *args, file=sys.stderr, flush=True)

from . import library as L  # noqa: E402
from . import logs  # noqa: E402
from . import sysmon  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]

SAMPLERS = {
    "euler": ("EulerDiscreteScheduler", {}),
    "euler_ancestral": ("EulerAncestralDiscreteScheduler", {}),
    "heun": ("HeunDiscreteScheduler", {}),
    "lms": ("LMSDiscreteScheduler", {}),
    "dpm_2": ("KDPM2DiscreteScheduler", {}),
    "dpm_2_ancestral": ("KDPM2AncestralDiscreteScheduler", {}),
    "dpmpp_2m": ("DPMSolverMultistepScheduler", {"algorithm_type": "dpmsolver++", "solver_order": 2}),
    "dpmpp_2m_sde": ("DPMSolverMultistepScheduler", {"algorithm_type": "sde-dpmsolver++", "solver_order": 2}),
    "dpmpp_3m_sde": ("DPMSolverMultistepScheduler", {"algorithm_type": "sde-dpmsolver++", "solver_order": 3}),
    "dpmpp_sde": ("DPMSolverSDEScheduler", {}),
    "ddim": ("DDIMScheduler", {}),
    "ddpm": ("DDPMScheduler", {}),
    "uni_pc": ("UniPCMultistepScheduler", {}),
    "lcm": ("LCMScheduler", {}),
}
SCHEDULERS = {
    "normal": {},
    "karras": {"use_karras_sigmas": True},
    "exponential": {"use_exponential_sigmas": True},
    "beta": {"use_beta_sigmas": True},
    "simple": {"timestep_spacing": "simple"},
    "sgm_uniform": {"timestep_spacing": "sgm_uniform"},
    "ddim_uniform": {"timestep_spacing": "trailing"},
}
UPSCALE = ["nearest-exact", "bilinear", "area", "bicubic"]

_lock = threading.RLock()
_state = {"key": None, "pipe": None, "i2i": None, "i2i_cls": None, "loras": {}, "layout": None, "device": None,
          "dtype": None, "vae_dtype": None, "unet_at": None, "ckpt": None, "sdxl": False, "vaes": {}, "cns": {},
          "cn_pipes": {}, "vae_peak": {}}


class NotInstalled(RuntimeError):
    """Пакеты генерации не установлены в .venv."""


# ---------- описатели значений между нодами ----------
class Model:
    """MODEL: чекпоинт + LoRA (путь, сила для UNet)."""
    def __init__(self, ckpt, loras=()):
        self.ckpt, self.loras = Path(ckpt), tuple(loras)

    def __str__(self):
        return f"MODEL {self.ckpt.stem}" + (f" + {len(self.loras)} LoRA" if self.loras else "")


class Clip:
    """CLIP: текстовые энкодеры чекпоинта + LoRA (путь, сила для энкодеров) + последний слой (-1 — без пропуска)."""
    def __init__(self, ckpt, loras=(), stop=-1):
        self.ckpt, self.loras, self.stop = Path(ckpt), tuple(loras), int(stop)

    def __str__(self):
        return f"CLIP {self.ckpt.stem}" + (f" + {len(self.loras)} LoRA" if self.loras else "") + \
            (f", last layer {self.stop}" if self.stop != -1 else "")


class Vae:
    """VAE: из чекпоинта или отдельный файл (vae/)."""
    def __init__(self, path, standalone=False):
        self.path, self.standalone = Path(path), standalone

    def __str__(self):
        return f"VAE {self.path.stem}" + ("" if self.standalone else " (from checkpoint)")


class Cond:
    """CONDITIONING: эмбеддинги промпта на CPU (+ pooled у SDXL); control — ControlNet'ы, приложенные к нему
    (Apply ControlNet): кортежи (путь модели, файл картинки-подсказки, сила, start, end)."""
    def __init__(self, embeds, pooled, sdxl, text, control=()):
        self.embeds, self.pooled, self.sdxl, self.text, self.control = embeds, pooled, sdxl, text, tuple(control)

    def __str__(self):
        t = self.text if len(self.text) < 80 else self.text[:77] + "…"
        return f"CONDITIONING {'SDXL' if self.sdxl else 'SD1.5'}: {t}" + \
            (f" + ControlNet ×{len(self.control)}" if self.control else "")


class Control:
    """CONTROL_NET: файл модели ControlNet (веса грузятся при сэмплинге)."""
    def __init__(self, path):
        self.path = Path(path)

    def __str__(self):
        return f"CONTROL_NET {self.path.stem}"


class Latent:
    """LATENT: латент на CPU в масштабе diffusers (×scaling_factor); empty — пустой (txt2img)."""
    def __init__(self, samples, empty=False, seed=None):
        self.samples, self.empty, self.seed = samples, empty, seed

    def __str__(self):
        b, _c, h, w = self.samples.shape
        return f"LATENT {w * 8}×{h * 8}" + (f" ×{b}" if b > 1 else "") + (" (empty)" if self.empty else "")


def _packages():
    try:
        import torch
        import diffusers
        from PIL import Image
    except ImportError as e:
        raise NotInstalled(
            "generation packages are not installed — open the «Компоненты» tab and install them, or run in the project .venv:\n"
            "  .venv\\Scripts\\python -m pip install torch --index-url https://download.pytorch.org/whl/cu130\n"
            "  .venv\\Scripts\\python -m pip install -r requirements.txt"
        ) from e
    return torch, diffusers, Image


def _opts(ctx):
    g = ((ctx.settings if ctx else None) or {}).get("gen") or {}
    vae = g.get("vae_dtype") or "auto"
    if g.get("vae_fp16", True) in (False, "false", "0", 0):
        vae = "fp32"
    return {"device": g.get("device") or "auto", "dtype": g.get("dtype") or "fp16",
            "offload": g.get("offload", "auto"), "keep": g.get("keep", True), "vae": vae,
            "cn_offload": g.get("controlnet_offload", "auto")}


def model_path(cat, name):
    """Имя модели из виджета (как в библиотеке) → путь к файлу."""
    if not name:
        raise ValueError(f"no {cat} model selected")
    for it in L.index()["items"]:
        if it["cat"] == cat and it["name"] == name:
            return Path(it["path"])
    raise FileNotFoundError(f"model {cat}/{name} not found in the library")


def _supported(arch):
    a = (arch or "").lower()
    if not a:
        return True
    if "lora" in a or "vae" in a:
        return False
    return ("xl" in a or "sd1" in a or "sd-v1" in a or "1.x" in a or "1.5" in a or "stable-diffusion-v1" in a
            or "sdxl" in a or "pony" in a or "illustrious" in a)


def _arch_of(path):
    """Архитектура по заголовку safetensors (веса не читаются) — «SDXL», «SD1.x», «Flux» …"""
    try:
        h = L._safetensors_header(path) or {}
    except Exception:
        return ""
    keys = [k for k in h if k != "__metadata__"]
    return L._arch(keys, h.get("__metadata__") or {})


def _classes(arch, diffusers):
    """Пары (txt2img, img2img) по архитектуре; при неизвестной — список проб (SDXL, затем SD1.5)."""
    a = (arch or "").lower()
    if "xl" in a or "sdxl" in a:
        return [(diffusers.StableDiffusionXLPipeline, diffusers.StableDiffusionXLImg2ImgPipeline)]
    if "1.x" in a or "1.5" in a or "sd1" in a or "sd-v1" in a or "stable-diffusion-v1" in a:
        return [(diffusers.StableDiffusionPipeline, diffusers.StableDiffusionImg2ImgPipeline)]
    return [
        (diffusers.StableDiffusionXLPipeline, diffusers.StableDiffusionXLImg2ImgPipeline),
        (diffusers.StableDiffusionPipeline, diffusers.StableDiffusionImg2ImgPipeline),
    ]


def _vae_tile_size(vae, sample=512):
    """Тайл VAE — 512 px: по умолчанию diffusers берёт config.sample_size (у SDXL-VAE 1024), а декод режет по
    латенту (1024/8 = 128) и включает тайлы только если латент БОЛЬШЕ — то есть для 1024×1024 и меньше
    enable_tiling ничего не делал, и повтор после OutOfMemory падал тем же куском. Меньше конфига — только
    уменьшаем (у SD1.5 sample_size 512 и так)."""
    cfg = getattr(vae, "config", None)
    try:
        factor = 2 ** (len(cfg.block_out_channels) - 1)
    except Exception:
        factor = 8
    cur = getattr(vae, "tile_sample_min_size", None)
    if isinstance(cur, int) and 0 < cur <= sample:
        return
    for attr, val in (("tile_sample_min_size", sample), ("tile_latent_min_size", max(1, sample // factor))):
        try:
            setattr(vae, attr, val)
        except Exception:
            pass


def _vae_flags(vae, slicing=None, tiling=None):
    if vae is None:
        return
    for flag, name in ((slicing, "slicing"), (tiling, "tiling")):
        if flag is None:
            continue
        fn = getattr(vae, ("enable_" if flag else "disable_") + name, None)
        if fn:
            try:
                fn()
            except Exception:
                pass
    if tiling:
        _vae_tile_size(vae)


def _drop():
    _state.update(key=None, pipe=None, i2i=None, i2i_cls=None, loras={}, layout=None, device=None, dtype=None,
                  vae_dtype=None, unet_at=None, ckpt=None, sdxl=False, vaes={}, cns={}, cn_pipes={}, vae_peak={})
    gc.collect()


def unload():
    """Выгрузить модели из памяти (кнопка/запрос «освободить память»)."""
    with _lock:
        _drop()
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:
            pass


def _dtype(torch, opts, device):
    if device == "cpu":
        return torch.float32
    return {"fp16": torch.float16, "bf16": torch.bfloat16, "fp32": torch.float32}.get(opts["dtype"], torch.float16)


def _amd_arch(torch):
    """Архитектура AMD (gfx1201) в ROCm-сборке torch, иначе None."""
    if not getattr(torch.version, "hip", None) or not torch.cuda.is_available():
        return None
    try:
        return (torch.cuda.get_device_properties(0).gcnArchName or "").split(":")[0] or None
    except Exception:
        return None


def _gpu_setup(torch, device):
    """Настройки бэкенда под карту (один раз на загрузку модели)."""
    arch = _amd_arch(torch) if device == "cuda" else None
    if arch and arch not in AMD_OLD and os.environ.get("MAISTEP_ENABLE_MIOPEN") != "1":
        torch.backends.cudnn.enabled = False  # без MIOpen на RDNA3+ заметно быстрее (замеры ComfyUI)
    return arch


def _vae_attn(torch, vae):
    """На AMD — внимание VAE без SDPA (как pytorch_attention_enabled_vae в ComfyUI)."""
    if not _amd_arch(torch):
        return
    try:
        from diffusers.models.attention_processor import AttnProcessor
        vae.set_attn_processor(AttnProcessor())
    except Exception:
        pass


def _vae_dtype(torch, opts, device):
    """Как vae_dtype в ComfyUI: bf16, если карта умеет (диапазон fp32 — у SDXL-VAE нет NaN и не нужен
    перекаст в fp32), иначе fp16; fp32 — по настройке, на CPU и на AMD без bf16 (RDNA2 и старше)."""
    v = opts["vae"]
    if device == "cpu" or v == "fp32":
        return torch.float32
    if v == "fp16":
        return torch.float16
    if _amd_arch(torch) in AMD_OLD:
        return torch.float32
    if v == "bf16" or torch.cuda.is_bf16_supported():
        return torch.bfloat16
    return torch.float16


# Оценки памяти VAE (AutoencoderKL) из ComfyUI comfy/sd.py — с запасом, но лучше переоценить:
# при нехватке Windows не падает с OOM, а уводит память в sysmem, и секунда превращается в минуту.
def _vae_need(kind, h, w, dtype):
    size = dtype.itemsize if hasattr(dtype, "itemsize") else 2
    if kind == "encode":
        return 1767 * h * w * size                  # h, w — пиксели
    return 2178 * (h // 8) * (w // 8) * 64 * size   # по латенту


def _free(torch, device):
    """Свободно на GPU: драйвер + отложенное в кэше torch (как get_free_memory в ComfyUI); с потолком VRAM —
    не больше, чем осталось до него."""
    free, total = torch.cuda.mem_get_info(device)
    out = free + torch.cuda.memory_reserved(device) - torch.cuda.memory_allocated(device)
    pct = sysmon.limits()["vram_max_pct"]
    if 0 < pct < 100:
        out = min(out, total * pct / 100 - torch.cuda.memory_allocated(device))
    return max(0, out)


def _vram_cap(torch, device):
    """Потолок VRAM для torch: выше — OutOfMemory (и повтор тайлами), а не переполнение в системную память."""
    if device != "cuda":
        return
    pct = sysmon.limits()["vram_max_pct"]
    try:
        torch.cuda.set_per_process_memory_fraction(pct / 100 if 0 < pct < 100 else 1.0)
    except Exception as e:
        _dbg("vram cap", e)


def _unet_to(torch, where):
    """UNet между GPU и CPU — как load_models_gpu в ComfyUI. UNet общий у t2i и i2i пайплайнов."""
    st = _state
    pipe = st["pipe"]
    if pipe is None or st.get("layout") == "offload" or st.get("unet_at") == where:
        return
    t0 = time.time()
    # Зовётся и из VAE под inference_mode: перенос там делает веса inference-тензорами, и потом PEFT не может
    # включить LoRA («Setting requires_grad=True on inference tensor…»). Переносим всегда обычными тензорами.
    with torch.inference_mode(False), torch.no_grad():
        pipe.unet.to(where)
        for cn in st["cns"].values():  # ControlNet работает только вместе с UNet — уходит и возвращается с ним
            if not getattr(cn, "maistep_stream", False):
                cn.to(where)
    st["unet_at"] = where
    if where == "cpu":
        torch.cuda.empty_cache()
    _dbg("unet →", where, round(time.time() - t0, 2), "с")


def _layout(torch, device, opts):
    """full — всё на GPU; split — UNet+VAE на GPU, энкодеры на CPU; offload — по модулям (accelerate)."""
    if device != "cuda":
        return "full"
    if isinstance(opts["offload"], bool):
        return "full" if opts["offload"] is False else "offload"
    free, total = torch.cuda.mem_get_info()
    pct = sysmon.limits()["vram_max_pct"]
    if 0 < pct < 100:
        total, free = total * pct / 100, min(free, total * pct / 100)
    return "full" if (total >= 12 * 2**30 and free >= 8 * 2**30) else "split"


def _check_ckpt(path):
    arch = _arch_of(path)
    if not _supported(arch):
        raise ValueError(f"checkpoint «{path.name}» is «{arch or 'unknown'}»; local generation supports SD1.5 and SDXL only")
    return arch


def _pipe(path, opts, torch, diffusers, ctx=None):
    """Пайплайн чекпоинта (из кэша или загрузка). Один в памяти — другой чекпоинт вытесняет прежний."""
    st = _state
    path = Path(path)
    key = (str(path), path.stat().st_size, opts["device"], opts["dtype"], str(opts["offload"]), opts["vae"])
    if st["key"] == key and st["pipe"] is not None:
        return st["pipe"]
    arch = _check_ckpt(path)
    if ctx and (amd := _amd_arch(torch)):
        alloc = os.environ.get("PYTORCH_HIP_ALLOC_CONF") or os.environ.get("PYTORCH_CUDA_ALLOC_CONF") or "default"
        ctx.log(f"AMD {amd}, ROCm {torch.version.hip}, torch {torch.__version__}, allocator {alloc}")
    _drop()
    device = "cuda" if opts["device"] in ("auto", "cuda") and torch.cuda.is_available() else "cpu"
    amd = _gpu_setup(torch, device)
    _vram_cap(torch, device)
    dt = _dtype(torch, opts, device)
    if amd in AMD_OLD and dt == torch.bfloat16:
        dt = torch.float16
    pipe = i2i_cls = None
    errors = []
    t0 = time.time()
    for t2i_cls, i2i_cls in _classes(arch, diffusers):
        try:
            try:
                pipe = t2i_cls.from_single_file(str(path), torch_dtype=dt)
            except TypeError:
                pipe = t2i_cls.from_single_file(str(path), dtype=dt)
            break
        except Exception as e:
            errors.append(f"{t2i_cls.__name__}: {type(e).__name__}: {e}")
            pipe = None
    if pipe is None:
        raise ValueError(f"checkpoint «{path.name}» did not load as SD:\n" + "\n".join(errors))
    # VAE декодируем сами (vae_decode) в своём dtype; встроенный перекаст SDXL в fp32 не нужен
    vdt = _vae_dtype(torch, opts, device)
    pipe.vae.to(dtype=vdt)
    try:
        pipe.vae.config.force_upcast = False
    except Exception:
        pass
    lay = _layout(torch, device, opts)
    if lay == "offload":
        pipe.enable_model_cpu_offload()
    elif lay == "split":
        pipe.unet.to(device)
        pipe.vae.to(device)
        for te in (getattr(pipe, "text_encoder", None), getattr(pipe, "text_encoder_2", None)):
            if te is not None:
                te.to("cpu").float()
    else:
        pipe.to(device)
    _vae_flags(pipe.vae, slicing=True)
    _vae_attn(torch, pipe.vae)
    # cudnn.benchmark на новых картах подбирает свёртки минутами (VAE decode) — включаем только по флагу
    try:
        torch.backends.cudnn.benchmark = os.environ.get("MAISTEP_CUDNN_BENCHMARK") == "1"
    except Exception:
        pass
    st.update(key=key, pipe=pipe, i2i=None, i2i_cls=i2i_cls, loras={}, layout=lay, device=device, dtype=dt,
              vae_dtype=vdt, unet_at=device, ckpt=str(path), sdxl=getattr(pipe, "text_encoder_2", None) is not None)
    if ctx:
        ctx.log(f"checkpoint loaded: {path.name} ({'SDXL' if st['sdxl'] else 'SD1.5'}, {lay}, {time.time() - t0:.1f} s)")
    return pipe


def _set_scheduler(pipe, sampler, scheduler, diffusers):
    cls_name, base = SAMPLERS[sampler]
    cls = getattr(diffusers, cls_name)
    kw = {**base, **SCHEDULERS[scheduler]}
    for extra in (kw, base, {}):
        try:
            pipe.scheduler = cls.from_config(pipe.scheduler.config, **extra)
            return
        except (TypeError, ValueError):
            continue
    raise ValueError(f"sampler {sampler}/{scheduler} is not supported by this diffusers version")


def _present_adapters(pipe):
    """Имена адаптеров, реально попавших в модули пайплайна (unet/transformer/text_encoder)."""
    names = set()
    for comp in ("unet", "transformer", "text_encoder", "text_encoder_2"):
        m = getattr(pipe, comp, None)
        names.update((getattr(m, "peft_config", None) or {}).keys())
    try:
        for part in (pipe.get_list_adapters() or {}).values():
            names.update(part)
    except Exception:
        pass
    return names


def _lora_arch(path):
    """Архитектура/база LoRA из библиотеки — для понятной ошибки при несовместимости."""
    try:
        d = L.details(f"loras/{path.name}")
        return " / ".join(x for x in (d.get("arch"), d.get("base")) if x) or "unknown"
    except Exception:
        return "unknown"


def _load_lora(pipe, path, ctx=None):
    """Адаптер LoRA в пайплайне (загружается один раз), возвращает его имя."""
    st = _state
    ad = st["loras"].get(str(path))
    if ad is not None:
        return ad
    ad = f"m{len(st['loras'])}"
    try:
        pipe.load_lora_weights(str(path), adapter_name=ad)
    except Exception as e:
        raise ValueError(f"LoRA «{path.name}» failed to load: {type(e).__name__}: {e}") from e
    if ad not in _present_adapters(pipe):
        raise ValueError(
            f"LoRA «{path.name}» does not match the checkpoint (file: {_lora_arch(path)}). "
            "Use a LoRA for the same base: SDXL checkpoint — SDXL LoRA, SD1.5 — SD1.5 LoRA.")
    st["loras"][str(path)] = ad
    if ctx:
        ctx.log(f"LoRA loaded: {path.name}")
    return ad


def _apply_loras(pipe, unet=(), te=(), ctx=None):
    """Силы адаптеров по компонентам: unet — из MODEL, text_encoder* — из CLIP (как strength_model/strength_clip)."""
    wu, wt = {}, {}
    for p, s in unet:
        a = _load_lora(pipe, Path(p), ctx)
        wu[a] = wu.get(a, 0.0) + float(s)
    for p, s in te:
        a = _load_lora(pipe, Path(p), ctx)
        wt[a] = wt.get(a, 0.0) + float(s)
    names = [a for a in {**wu, **wt} if wu.get(a) or wt.get(a)]
    if not names:
        if _state["loras"]:
            pipe.disable_lora()
        return
    comps = [c for c in ("unet", "text_encoder", "text_encoder_2") if getattr(pipe, c, None) is not None]
    weights = [{c: (wu.get(a, 0.0) if c == "unet" else wt.get(a, 0.0)) for c in comps} for a in names]
    try:
        pipe.enable_lora()
        pipe.set_adapters(names, adapter_weights=weights)
    except Exception as e:
        raise ValueError(f"LoRA could not be applied: {type(e).__name__}: {e}") from e


def _derive(cls, pipe, **extra):
    """Пайплайн другого класса на тех же модулях (from_pipe). Без dtype from_pipe перекастует общие модули
    в float32 (на 8 ГБ это уводит UNet в sysmem); текстовые энкодеры в split-раскладке остаются на CPU в fp32 —
    им нужна точность кодирования."""
    st = _state
    out = cls.from_pipe(pipe, dtype=st.get("dtype") or getattr(pipe.unet, "dtype", None), **extra)
    if st.get("layout") == "split":
        for te in (getattr(out, "text_encoder", None), getattr(out, "text_encoder_2", None)):
            if te is not None:
                te.to("cpu").float()
    if st.get("vae_dtype") is not None:
        out.vae.to(dtype=st["vae_dtype"])
    _vae_flags(out.vae, slicing=True)
    return out


def _i2i(pipe):
    st = _state
    if st["i2i"] is None:
        st["i2i"] = _derive(st["i2i_cls"], pipe)
    return st["i2i"]


# ---------- ControlNet ----------
def _cn_stream(torch, opts):
    """Держать веса ControlNet в RAM и подгружать на GPU по слоям во время шага (group offload diffusers с
    CUDA-потоком — как lowvram в ComfyUI): на картах до 12 ГБ SDXL-ControlNet (2,5 ГБ) рядом с UNet (5 ГБ) не
    влезает, и всё уходит в sysmem (минута на шаг вместо секунды). gen.controlnet_offload: auto | true | false."""
    if _state.get("device") != "cuda" or _state.get("layout") == "offload":
        return False
    v = opts.get("cn_offload", "auto")
    if v in (True, "true", "1", 1):
        return True
    if v in (False, "false", "0", 0):
        return False
    total = torch.cuda.mem_get_info()[1]
    pct = sysmon.limits()["vram_max_pct"]
    return total * (pct / 100 if 0 < pct < 100 else 1) < 12 * 2**30


def _controlnet(path, torch, diffusers, ctx=None):
    """Модель ControlNet под загруженный чекпоинт (кэш в _state). Файлы в формате diffusers (Hugging Face:
    xinsir, NoobAI) собираются по конфигу UNet чекпоинта, формат ControlNet 1.1 / ComfyUI — from_single_file."""
    st = _state
    key = str(path)
    if key in st["cns"]:
        return st["cns"][key]
    pipe = st["pipe"]
    dt, dev = st["dtype"], st["device"]
    base = "SDXL" if st["sdxl"] else "SD1.5"
    t0 = time.time()
    from safetensors.torch import load_file
    sd = load_file(key)
    if "controlnet_cond_embedding.conv_in.weight" in sd:
        from accelerate import init_empty_weights
        with init_empty_weights():
            cn = diffusers.ControlNetModel.from_unet(pipe.unet, load_weights_from_unet=False)
        try:
            cn.load_state_dict(sd, strict=True, assign=True)
        except RuntimeError as e:
            raise ValueError(f"ControlNet «{path.name}» does not match the checkpoint ({base}) — "
                             "use a ControlNet for the same base") from e
    else:
        try:
            cn = diffusers.ControlNetModel.from_single_file(key, torch_dtype=dt)
        except Exception as e:
            raise ValueError(f"ControlNet «{path.name}» did not load: {type(e).__name__}: {e}") from e
        if cn.config.cross_attention_dim != pipe.unet.config.cross_attention_dim:
            raise ValueError(f"ControlNet «{path.name}» does not match the checkpoint ({base})")
    del sd
    stream = _cn_stream(torch, _opts(ctx))
    with torch.inference_mode(False), torch.no_grad():
        cn.to(dtype=dt)
        if stream:
            cn.enable_group_offload(onload_device=torch.device(dev), offload_device=torch.device("cpu"),
                                    offload_type="leaf_level", use_stream=True)
        else:
            cn.to(st.get("unet_at") or dev)
    cn.maistep_stream = stream  # такие не переносим вместе с UNet (_unet_to)
    cn.eval()
    # в памяти — один набор ControlNet'ов: прежние уходят вместе со своими пайплайнами
    st["cns"] = {key: cn}
    st["cn_pipes"] = {}
    gc.collect()
    if ctx:
        ctx.log(f"ControlNet loaded: {path.name} ({'streamed from RAM, ' if stream else ''}{time.time() - t0:.1f} s)")
    return cn


def _cn_pipe(pipe, paths, img2img, torch, diffusers, ctx=None):
    """Пайплайн ControlNet (txt2img или img2img) на модулях загруженного чекпоинта."""
    st = _state
    key = (tuple(str(p) for p in paths), img2img)
    if key in st["cn_pipes"]:
        return st["cn_pipes"][key]
    if any(str(p) not in st["cns"] for p in paths):
        st["cns"], st["cn_pipes"] = {}, {}
        gc.collect()
    nets = [_controlnet(Path(p), torch, diffusers, ctx) for p in paths]
    if len(paths) > 1:
        st["cns"] = {str(p): n for p, n in zip(paths, nets)}
    if st["sdxl"]:
        cls = diffusers.StableDiffusionXLControlNetImg2ImgPipeline if img2img else diffusers.StableDiffusionXLControlNetPipeline
    else:
        cls = diffusers.StableDiffusionControlNetImg2ImgPipeline if img2img else diffusers.StableDiffusionControlNetPipeline
    out = _derive(cls, pipe, controlnet=nets[0] if len(nets) == 1 else nets)
    if st.get("layout") == "offload":
        out.enable_model_cpu_offload()
    st["cn_pipes"][key] = out
    return out


def apply_controlnet(positive, negative, control_net, image, strength, start_percent, end_percent):
    """Apply ControlNet (Advanced): подсказка ControlNet к обоим промптам, как в ComfyUI (в diffusers она и так
    действует на всю пару CFG). strength 0 — без изменений."""
    if not control_net or float(strength) == 0 or float(end_percent) <= float(start_percent):
        return positive, negative
    c = (str(control_net.path), image["file"], float(strength), float(start_percent), float(end_percent))
    add = lambda x: Cond(x.embeds, x.pooled, x.sdxl, x.text, x.control + (c,)) if x is not None else None  # noqa: E731
    return add(positive), add(negative)


def _control_images(ctx, controls, w, h, box=None):
    """Картинки-подсказки ControlNet в размер латента (×8). box — область картинки, которую сэмплируем
    (Inpaint Region: {"x", "y", "w", "h", "W", "H"}): из подсказки берётся тот же кусок — в её масштабе, она может
    быть другого размера, чем картинка (например, лайнарт уменьшенной копии)."""
    from PIL import Image
    root = ctx.root if ctx else ROOT
    out = []
    for c in controls:
        with Image.open(root / c[1]) as im:
            pil = im.convert("RGB")
        if box:
            kx, ky = pil.width / box["W"], pil.height / box["H"]
            pil = pil.crop((round(box["x"] * kx), round(box["y"] * ky),
                            round((box["x"] + box["w"]) * kx), round((box["y"] + box["h"]) * ky)))
        out.append(pil if pil.size == (w, h) else pil.resize((w, h), Image.LANCZOS))
    return out


# ---------- ноды ----------
def load_checkpoint(ctx, name):
    """Load Checkpoint → (MODEL, CLIP, VAE). Модель загружается сразу — ошибки и время видны на этой ноде."""
    torch, diffusers, _ = _packages()
    path = model_path("checkpoints", name)
    with _lock:
        _pipe(path, _opts(ctx), torch, diffusers, ctx)
    return Model(path), Clip(path), Vae(path)


def load_lora(ctx, model, clip, name, strength_model, strength_clip):
    """Load LoRA: добавляет LoRA к MODEL и CLIP; совместимость проверяется сразу."""
    torch, diffusers, _ = _packages()
    path = model_path("loras", name)
    with _lock:
        pipe = _pipe(model.ckpt, _opts(ctx), torch, diffusers, ctx)
        _load_lora(pipe, path, ctx)
    m = Model(model.ckpt, model.loras + ((str(path), float(strength_model)),)) if model else None
    c = Clip(clip.ckpt, clip.loras + ((str(path), float(strength_clip)),), clip.stop) if clip else None
    return m, c


def load_vae(name):
    return Vae(model_path("vae", name), standalone=True)


def _clip_skip(stop, sdxl):
    """stop_at_clip_layer ComfyUI → clip_skip diffusers. SDXL и так берёт предпоследний слой (-2 — по умолчанию)."""
    stop = int(stop)
    n = -stop - (2 if sdxl else 1)
    return n if n > 0 else None


def encode(ctx, clip, text):
    """CLIP Text Encode: эмбеддинги (для split — энкодеры на CPU), хранятся на CPU."""
    torch, diffusers, _ = _packages()
    with _lock:
        pipe = _pipe(clip.ckpt, _opts(ctx), torch, diffusers, ctx)
        st = _state
        _apply_loras(pipe, te=clip.loras, ctx=ctx)
        dev = "cpu" if st["layout"] == "split" else (st["device"] or "cpu")
        cs = _clip_skip(clip.stop, st["sdxl"])
        t0 = time.time()
        with torch.inference_mode():
            pe, ppe, n = _encode_long(torch, pipe, text or "", dev, cs, st["sdxl"])
        _dbg("encode", round(time.time() - t0, 2), "с")
        if n > 1 and ctx:
            ctx.log(f"long prompt: {n} chunks of 75 tokens")
        return Cond(pe.to("cpu", torch.float32), ppe.to("cpu", torch.float32) if ppe is not None else None,
                    st["sdxl"], text or "")


def parse_weights(text):
    """Синтаксис весов A1111 / ComfyUI → [(кусок, вес)]: (tag:1.3), (tag) ×1.1, [tag] ÷1.1, вложенность
    перемножается, \\( \\) — буквальные скобки."""
    out, buf, stack = [], [], []  # stack: (позиция в out на момент «(», «(» или «[»)
    cur = lambda: 1.0 if not stack else stack[-1][2]  # noqa: E731

    def flush():
        if buf:
            out.append(["".join(buf), cur()])
            buf.clear()
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "\\" and i + 1 < len(text):
            buf.append(text[i + 1])
            i += 2
            continue
        if ch in "([":
            flush()
            stack.append((len(out), ch, cur() * (1.1 if ch == "(" else 1 / 1.1)))
        elif ch == ")" and stack and stack[-1][1] == "(":
            flush()
            start, _, w = stack.pop()
            m = re.match(r"^(.*):\s*([+-]?\d+(?:\.\d+)?)\s*$", out[-1][0], re.S) if len(out) > start else None
            if m:  # (tag:1.3) — явный вес вместо ×1.1 (на всё внутри скобок)
                out[-1][0] = m.group(1)
                for p in out[start:]:
                    p[1] *= float(m.group(2)) / 1.1
        elif ch == "]" and stack and stack[-1][1] == "[":
            flush()
            stack.pop()
        else:
            buf.append(ch)
        i += 1
    flush()
    return [(t, round(w, 4)) for t, w in out if t.strip()]


def _encode_long(torch, pipe, text, dev, clip_skip, sdxl):
    """CLIP Text Encode как в ComfyUI (sd1_clip.py): промпт режется на куски по 75 токенов (BOS + 75 + EOS), каждый
    кодируется отдельно, эмбеддинги склеиваются — длинный промпт не обрезается на 77 токенах (иначе пропадает хвост,
    куда lora.js дописывает триггер-слова). Веса (tag:1.2): z = z_пустого + (z − z_пустого)·вес по токенам.
    pooled (SDXL) — из первого куска. Короткий промпт без весов даёт то же, что encode_prompt diffusers.
    Возвращает (эмбеддинги, pooled | None, число кусков)."""
    toks = [pipe.tokenizer] + ([pipe.tokenizer_2] if sdxl else [])
    tes = [pipe.text_encoder] + ([pipe.text_encoder_2] if sdxl else [])
    toks, tes = zip(*[(t, e) for t, e in zip(toks, tes) if t is not None and e is not None])
    pieces = parse_weights(text) or [("", 1.0)]
    ids, ws = [], []
    for seg, w in pieces:  # токенизатор у обоих энкодеров SDXL один и тот же (BPE CLIP) — делим по первому
        t = toks[0](seg, add_special_tokens=False, truncation=False, verbose=False)["input_ids"]
        ids += t
        ws += [w] * len(t)
    chunks = [(ids[i:i + 75], ws[i:i + 75]) for i in range(0, len(ids), 75)] or [([], [])]
    embeds, pooled = [], None
    for ci, (cid, cw) in enumerate(chunks):
        parts = []
        weighted = any(abs(w - 1) > 1e-4 for w in cw)
        for k, (tk, te) in enumerate(zip(toks, tes)):
            pad = tk.pad_token_id if tk.pad_token_id is not None else tk.eos_token_id

            def run(body, tk=tk, te=te, pad=pad, k=k):
                seq = [tk.bos_token_id] + body + [tk.eos_token_id]
                seq += [pad] * (77 - len(seq))
                x = torch.tensor([seq], device=dev)
                o = te(x, output_hidden_states=True)
                if sdxl:
                    hs = o.hidden_states[-2] if clip_skip is None else o.hidden_states[-(clip_skip + 2)]
                    pool = o[0] if o[0].ndim == 2 else None
                elif clip_skip is None:
                    hs, pool = o[0], None
                else:
                    hs, pool = te.text_model.final_layer_norm(o.hidden_states[-(clip_skip + 1)]), None
                return hs, pool
            z, pool = run(cid)
            if weighted:
                empty, _ = run([])
                w = torch.tensor([1.0] + cw + [1.0] * (76 - len(cw)), device=z.device, dtype=z.dtype).view(1, -1, 1)
                z = empty + (z - empty) * w
            if ci == 0 and pool is not None:
                pooled = pool
            parts.append(z.to("cpu", torch.float32))
        embeds.append(torch.cat(parts, -1))
    pe = torch.cat(embeds, 1)
    return pe, (pooled.to("cpu", torch.float32) if pooled is not None else None), len(chunks)


def empty_latent(width, height, batch):
    torch, _, _ = _packages()
    return Latent(torch.zeros(max(1, int(batch)), 4, int(height) // 8, int(width) // 8), empty=True)


def upscale_latent(latent, method, width, height):
    torch, _, _ = _packages()
    import torch.nn.functional as F
    w, h = max(8, int(width) // 8), max(8, int(height) // 8)
    mode = method if method != "nearest-exact" else "nearest-exact"
    kw = {"align_corners": False} if mode in ("bilinear", "bicubic") else {}
    s = F.interpolate(latent.samples, size=(h, w), mode=mode, **kw)
    return Latent(s, empty=latent.empty)


def _fixed_encode(values):
    """Подмена encode_prompt: эмбеддинги уже посчитаны (и уже размножены на батч). Иначе пайплайн
    перекастует их в dtype текстового энкодера (в split-раскладке он fp32 — ради кодирования на CPU)."""
    def encode_prompt(*_a, **_kw):
        return values
    return encode_prompt


# Поэтапное превью: латент → RGB линейной проекцией (latent_rgb_factors из ComfyUI comfy/latent_formats.py) —
# без VAE, доли миллисекунды на шаг. Шлём не чаще PREVIEW_EVERY секунд.
PREVIEW_EVERY = 0.35
STALL = 120  # с без шага сэмплера / конца VAE — стеки потоков в лог (logs.watchdog): зависание GPU видно в отчёте
PREVIEW_MAX = 512
_RGB = {
    False: ([[0.3512, 0.2297, 0.3227], [0.3250, 0.4974, 0.2350], [-0.2829, 0.1762, 0.2721], [-0.2120, -0.2616, -0.7177]],
            [0.0, 0.0, 0.0]),
    True: ([[0.3651, 0.4232, 0.4341], [-0.2533, -0.0042, 0.1068], [0.1076, 0.1111, -0.0362], [-0.3165, -0.2492, -0.2188]],
           [0.1084, -0.0175, -0.0011]),
}


def _sigma(pipe):
    """Уровень шума текущих латентов у k-диффузионных планировщиков (Euler и т.п. держат x·√(1+σ²)); иначе 0."""
    s = pipe.scheduler
    if float(getattr(s, "init_noise_sigma", 1.0)) < 1.5 or getattr(s, "step_index", None) is None:
        return 0.0
    sig = getattr(s, "sigmas", None)
    return float(sig[min(s.step_index, len(sig) - 1)]) if sig is not None else 0.0


def _latent_preview(torch, latents, sigma, sdxl):
    import base64
    import io
    from PIL import Image
    f, b = _RGB[bool(sdxl)]
    x = latents[0].detach().float().cpu() / (1 + sigma * sigma) ** 0.5
    rgb = torch.einsum("chw,cr->hwr", x[:4], torch.tensor(f)) + torch.tensor(b)
    arr = ((rgb + 1) / 2).clamp(0, 1).mul(255).byte().numpy()
    im = Image.fromarray(arr)
    k = PREVIEW_MAX / max(im.size)
    im = im.resize((max(1, round(im.width * k)), max(1, round(im.height * k))), Image.BILINEAR)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=80)
    return "data:image/jpeg;base64," + base64.b64encode(buf.getvalue()).decode()


def _sample_need(shape, sdxl):
    """Грубая оценка памяти активаций UNet на шаг (батч ×2 из-за CFG), байты — с запасом, как у ComfyUI."""
    _b, _c, h, w = shape
    mp = (h * 8) * (w * 8) / 1e6
    return int((1.3 if sdxl else 0.8) * 2**30 * mp * _b * 2)


def _unet_back(torch, ctx, shape, b):
    """UNet на GPU перед сэмплингом. После прошлого VAE Decode он мог уйти на CPU — перед возвратом чистим кэш
    CUDA (иначе 5 ГБ ложатся в обрывки и Windows уводит часть в системную память — второй запуск «ползёт»),
    после — проверяем, хватит ли места на активации; если нет — предупреждаем: сэмплинг будет медленным."""
    st = _state
    if st["device"] != "cuda" or st.get("layout") == "offload":
        return
    t0 = time.time()
    if st.get("unet_at") != st["device"]:
        gc.collect()
        torch.cuda.empty_cache()
    _unet_to(torch, st["device"])
    moved = time.time() - t0
    free, need = _free(torch, st["device"]), _sample_need(shape, st["sdxl"])
    _dbg("sample: UNet на GPU за", round(moved, 2), "с; свободно", round(free / 2**30, 2), "ГБ, нужно ~", round(need / 2**30, 2), "ГБ")
    if moved > 4 and ctx:
        ctx.log(f"UNet returned to GPU in {moved:.1f} s", "warn")
    if free < need and ctx:
        total = torch.cuda.mem_get_info(st["device"])[1]
        ctx.log(f"low free VRAM: {free / 2**30:.1f} GB of {total / 2**30:.1f} GB (need ~{need / 2**30:.1f} GB) — sampling may spill "
                "into system memory and get very slow. Another process may hold a model (e.g. the app window and the web "
                "mode both running a server): Сервер → «Освободить память» in the other one, or reduce size/batch.", "warn")


def sample(ctx, model, positive, negative, latent, seed, steps, cfg, sampler, scheduler, denoise, noise_mask=None,
           control_box=None):
    """KSampler. denoise=1 — txt2img (из шума), меньше — img2img по латенту. steps — сколько шагов реально
    выполнится (как в ComfyUI: при denoise<1 расписание считается на steps/denoise).
    noise_mask (1×1×h×w в масштабе латента, 1 — перерисовать) — как SetLatentNoiseMask в ComfyUI: после каждого шага
    вне маски возвращается исходный латент, зашумлённый до уровня следующего шага (так же делает inpaint-пайплайн).
    control_box — какой кусок картинки сэмплируется (Inpaint Region): подсказки ControlNet обрезаются так же."""
    torch, diffusers, _ = _packages()
    if positive.sdxl != negative.sdxl:
        raise ValueError("positive and negative come from different model families (SD1.5 vs SDXL)")
    steps, denoise = max(1, int(steps)), min(1.0, max(0.0, float(denoise)))
    if denoise <= 0:
        return Latent(latent.samples.clone(), empty=latent.empty)
    lim = sysmon.limits()
    mp = latent.samples.shape[-2] * latent.samples.shape[-1] * 64 / 1e6
    if lim["max_mp"] > 0 and mp > lim["max_mp"] + 1e-6:
        h, w = latent.samples.shape[-2] * 8, latent.samples.shape[-1] * 8
        raise ValueError(f"{w}×{h} = {mp:.1f} MP is above the limit of {lim['max_mp']:g} MP (Server → Performance and limits). "
                         "Generate smaller and upscale with hires fix, or raise the limit")
    with _lock:
        pipe = _pipe(model.ckpt, _opts(ctx), torch, diffusers, ctx)
        _vram_cap(torch, _state["device"])
        st = _state
        if positive.sdxl != st["sdxl"]:
            raise ValueError("conditioning does not match the model (SD1.5 vs SDXL) — encode with this model's CLIP")
        _apply_loras(pipe, unet=model.loras, ctx=ctx)
        img2img = (denoise < 0.999 or noise_mask is not None) and not latent.empty
        controls = positive.control or negative.control
        if controls:
            active = _cn_pipe(pipe, [c[0] for c in controls], img2img, torch, diffusers, ctx)
        else:
            active = _i2i(pipe) if img2img else pipe
        _set_scheduler(active, sampler, scheduler, diffusers)
        dev, dt = st["device"], st["dtype"]
        b = latent.samples.shape[0]
        _unet_back(torch, ctx, latent.samples.shape, b)

        def rep(x):
            return x.to(device=dev, dtype=dt).repeat(b, *([1] * (x.ndim - 1)))
        pe, npe = rep(positive.embeds), rep(negative.embeds)
        # эмбеддинги разной длины (длинный промпт — несколько кусков по 77) — как ComfyUI: короче повторяется до
        # общего кратного (нули вместо этого внимание тоже «видит», и картинка смещается)
        if pe.shape[1] != npe.shape[1]:
            n = math.lcm(pe.shape[1], npe.shape[1])
            pe, npe = pe.repeat(1, n // pe.shape[1], 1), npe.repeat(1, n // npe.shape[1], 1)
        call = {"prompt_embeds": pe, "negative_prompt_embeds": npe, "guidance_scale": float(cfg),
                "num_images_per_prompt": 1, "output_type": "latent",
                "generator": torch.Generator(device="cpu").manual_seed(int(seed))}
        values = (pe, npe)
        if st["sdxl"]:
            ppe, nppe = rep(positive.pooled), rep(negative.pooled)
            call.update(pooled_prompt_embeds=ppe, negative_pooled_prompt_embeds=nppe)
            values = (pe, npe, ppe, nppe)
        if img2img:
            call.update(image=latent.samples.to(device=dev, dtype=dt), strength=denoise,
                        num_inference_steps=max(steps, round(steps / denoise)))
        else:
            h, w = latent.samples.shape[-2] * 8, latent.samples.shape[-1] * 8
            call.update(width=w, height=h, num_inference_steps=steps)
        if controls:
            h, w = latent.samples.shape[-2] * 8, latent.samples.shape[-1] * 8
            one = len(controls) == 1
            pick = lambda i: controls[0][i] if one else [c[i] for c in controls]  # noqa: E731
            imgs = _control_images(ctx, controls, w, h, control_box)
            call["control_image" if img2img else "image"] = imgs[0] if one else imgs
            call.update(controlnet_conditioning_scale=pick(2), control_guidance_start=pick(3), control_guidance_end=pick(4))

        last = [0.0]
        # нагрузка GPU < 100% — пауза после шага, пропорциональная его времени (видеокарта остывает, система живая)
        duty = max(0.1, min(1.0, lim["gpu_load"] / 100))
        tick = [time.time()]
        nmask = None
        if noise_mask is not None and img2img:
            init = latent.samples.to(device=dev, dtype=dt)
            nmask = noise_mask.to(device=dev, dtype=dt)
            noise = torch.randn(init.shape, generator=torch.Generator(device="cpu").manual_seed(int(seed) + 1)).to(device=dev, dtype=dt)

        def cb(_pipe, i, _timestep, kw):
            logs.watchdog(STALL)  # шаг прошёл — сторож заново
            if nmask is not None:
                ts = _pipe.scheduler.timesteps
                keep = init
                if i + 1 < len(ts):
                    keep = _pipe.scheduler.add_noise(init, noise, ts[i + 1:i + 2])
                kw["latents"] = (1 - nmask) * keep + nmask * kw["latents"]
            if duty < 1:
                if dev == "cuda":
                    torch.cuda.synchronize()
                busy = time.time() - tick[0]
                time.sleep(min(30.0, busy * (1 / duty - 1)))
                tick[0] = time.time()
            if ctx:
                ctx.progress(min(i + 1, steps), steps)
                now = time.time()
                if now - last[0] >= PREVIEW_EVERY and i + 1 < steps:  # последний шаг покажет VAE Decode
                    last[0] = now
                    try:
                        ctx.preview(_latent_preview(torch, kw["latents"], _sigma(_pipe), st["sdxl"]), i + 1)
                    except Exception as e:  # превью — необязательное
                        _dbg("preview", e)
            return kw
        call["callback_on_step_end"] = cb
        if ctx:
            ctx.log(f"KSampler ({'inpaint' if nmask is not None else 'img2img' if img2img else 'txt2img'}, {st['layout']}): {steps} steps, cfg {cfg}, "
                    f"{sampler}/{scheduler}, seed {seed}" + (f", denoise {denoise}" if img2img else "")
                    + "".join(f", ControlNet {Path(c[0]).stem} {c[2]:g} [{c[3]:g}–{c[4]:g}]" for c in controls)
                    + (f", GPU load {lim['gpu_load']:g}%" if duty < 1 else ""))
        orig = active.encode_prompt
        active.encode_prompt = _fixed_encode(values)
        t0 = tick[0] = time.time()
        logs.watchdog(STALL * 2)  # первый шаг дольше: прогрев ядер (MIOpen/cuDNN)
        try:
            with torch.inference_mode():
                out = active(**call).images
        except Exception as e:
            name, msg = type(e).__name__, str(e)
            if "out of memory" in msg.lower() or name in ("OutOfMemoryError", "CudaOutOfMemoryError"):
                torch.cuda.empty_cache()
                raise RuntimeError(f"not enough VRAM ({name}). Reduce size or batch, or set "
                                   "\"gen\": {\"offload\": true} in user/settings.json") from e
            raise
        finally:
            active.encode_prompt = orig
            logs.stop_watchdog()
        took = time.time() - t0
        _dbg("sampling", round(took, 2), "с")
        if ctx:
            ctx.progress(steps, steps)
            ctx.log(f"sampling: {took:.1f} s, {took / steps:.2f} s/step")
        return Latent(out.to("cpu", torch.float32), seed=int(seed))


# ---------- VAE ----------
def _vae_module(ctx, vae, torch, diffusers):
    """Модуль AutoencoderKL: VAE загруженного чекпоинта или отдельный (файл vae/ или VAE другого чекпоинта)."""
    st = _state
    opts = _opts(ctx)
    if not vae.standalone and st["pipe"] is not None and st["ckpt"] == str(vae.path):
        return st["pipe"].vae
    if not vae.standalone and st["pipe"] is None:
        return _pipe(vae.path, opts, torch, diffusers, ctx).vae
    m = st["vaes"].get(str(vae.path))
    if m is None:
        device = "cuda" if opts["device"] in ("auto", "cuda") and torch.cuda.is_available() else "cpu"
        vdt = _vae_dtype(torch, opts, device)
        m = diffusers.AutoencoderKL.from_single_file(str(vae.path), torch_dtype=vdt)
        m.config.force_upcast = False
        m.to(device)
        _vae_flags(m, slicing=True)
        _vae_attn(torch, m)
        st["vaes"][str(vae.path)] = m
        if ctx:
            ctx.log(f"VAE loaded: {vae.path.name}")
    return m


def _is_oom(torch, e):
    cls = getattr(getattr(torch, "cuda", None), "OutOfMemoryError", None)
    return isinstance(e, cls) if isinstance(cls, type) else "out of memory" in str(e).lower()


def _cap_note(torch, dev, need):
    """Подсказка, если аллокацию отклонил потолок VRAM, а на карте место физически есть: torch не может занять
    больше потолка, и вместо свопа (как на Windows) получается OutOfMemory."""
    pct = sysmon.limits()["vram_max_pct"]
    if not (0 < pct < 100):
        return ""
    try:
        free, total = torch.cuda.mem_get_info(dev)
    except Exception:
        return ""
    if free < need:
        return ""
    return (f" Потолок VRAM {pct:g}% = {total * pct / 100 / 2**30:.1f} ГБ: torch не может занять больше, хотя на карте"
            f" свободно {free / 2**30:.1f} ГБ. Поднимите «Потолок VRAM» в строке состояния (100% — без потолка).")


def _vae_run(torch, vae, need, fn, ctx=None, key=None):
    """VAE-операция с местом под неё: при нехватке UNet уходит на CPU, если и так мало — тайлы.
    Оценка из ComfyUI (см. _vae_need) — нижняя граница: фактический пик декода на больших разрешениях и на ROCm
    выше, поэтому пик запоминается для этого разрешения и dtype и следующий раз считается от него.
    OOM → кэш, UNet на CPU, тайлы; не влезло и так — VAE на CPU (медленно, но не ошибка).
    NaN (проблемный VAE в fp16) → повтор в fp32."""
    st = _state
    dev = next(vae.parameters()).device
    if dev.type != "cuda" or st.get("layout") == "offload":
        return fn()
    peaks = st["vae_peak"]
    peak_key = (key, str(vae.dtype).replace("torch.", ""))
    need = max(int(need), peaks.get(peak_key, 0))
    # Кэш аллокатора — не гарантия: нужный блок из обрывков не собрать («reserved but unallocated»), а с потолком
    # VRAM новый кусок может уже не влезть. Отдаём кэш драйверу — тогда _free считает по-честному.
    try:
        total = torch.cuda.mem_get_info(dev)[1]
        pct = sysmon.limits()["vram_max_pct"]
        cap = total * (pct / 100 if 0 < pct < 100 else 1.0)
        if torch.cuda.memory_reserved(dev) + need > cap:
            torch.cuda.empty_cache()
    except Exception:
        pass
    if _free(torch, dev) < need:
        _unet_to(torch, "cpu")
    tiled = _free(torch, dev) < need
    _vae_flags(vae, tiling=tiled)
    _dbg("vae: нужно", round(need / 2**30, 2), "ГБ, свободно", round(_free(torch, dev) / 2**30, 2), "ГБ, тайлы", tiled)

    def measure():
        torch.cuda.reset_peak_memory_stats(dev)
        base = torch.cuda.memory_allocated(dev)
        out = fn()
        peaks[peak_key] = max(need, torch.cuda.max_memory_allocated(dev) - base)
        return out

    try:
        out = measure()
    except Exception as e:
        if not _is_oom(torch, e):
            raise
        note = _cap_note(torch, dev, need)
        if ctx:
            ctx.log("VAE: не хватило VRAM — освобождаю UNet и включаю тайлы")
        torch.cuda.empty_cache()
        _unet_to(torch, "cpu")
        torch.cuda.empty_cache()
        _vae_flags(vae, tiling=True)
        try:
            out = measure()
        except Exception as e2:
            if not _is_oom(torch, e2):
                raise
            if ctx:
                ctx.log("VAE: и с тайлами не влезло — считаю на CPU (медленно)")
            with torch.inference_mode(False), torch.no_grad():
                vae.to("cpu")
            torch.cuda.empty_cache()
            try:
                out = fn()
            except Exception as e3:
                raise RuntimeError(f"{e3}{note}") from e3
            finally:
                with torch.inference_mode(False), torch.no_grad():
                    vae.to(dev)
    if torch.isnan(out).any() and vae.dtype != torch.float32:
        if ctx:
            ctx.log("VAE produced NaN — retrying in fp32")
        old = vae.dtype
        vae.to(torch.float32)
        try:
            out = fn()
        finally:
            vae.to(old)
    return out


def _processor(diffusers):
    from diffusers.image_processor import VaeImageProcessor
    return VaeImageProcessor(vae_scale_factor=8)


def vae_encode(ctx, vae, image):
    """VAE Encode: картинка IMAGE (файл) → LATENT (×scaling_factor, как ждёт img2img)."""
    _torch, _diffusers, Image = _packages()
    p = (ctx.root if ctx else ROOT) / image["file"]
    with Image.open(p) as im:
        pil = im.convert("RGB")
    return encode_pil(ctx, vae, pil)


def encode_pil(ctx, vae, pil):
    """PIL RGB → LATENT."""
    torch, diffusers, _ = _packages()
    with _lock:
        m = _vae_module(ctx, vae, torch, diffusers)
        px = _processor(diffusers).preprocess(pil)
        h, w = px.shape[-2:]
        gen = torch.Generator(device="cpu").manual_seed(0)

        def run():
            x = px.to(device=next(m.parameters()).device, dtype=m.dtype)
            return m.encode(x).latent_dist.sample(generator=gen)
        t0 = time.time()
        with torch.inference_mode():
            logs.watchdog(STALL)
            try:
                lat = _vae_run(torch, m, _vae_need("encode", h, w, m.dtype), run, ctx,
                               key=("encode", w, h)).float()
            finally:
                logs.stop_watchdog()
        _dbg("vae encode", round(time.time() - t0, 2), "с")
        cfg = m.config
        mean, std = getattr(cfg, "latents_mean", None), getattr(cfg, "latents_std", None)
        if mean is not None and std is not None:
            mean = torch.tensor(mean).view(1, 4, 1, 1).to(lat)
            std = torch.tensor(std).view(1, 4, 1, 1).to(lat)
            lat = (lat - mean) * cfg.scaling_factor / std
        else:
            lat = lat * cfg.scaling_factor
        return Latent(lat.to("cpu"))


def vae_decode(ctx, vae, latent, prefix="sd"):
    """VAE Decode: LATENT → PNG в output/ (IMAGE = {"file": …}). Возвращает список файлов."""
    return save_pils(ctx, decode_pils(ctx, vae, latent), prefix, latent.seed)


def save_pils(ctx, pils, prefix="sd", seed=None):
    """PIL → PNG в output/, пути относительно проекта."""
    root = ctx.root if ctx else ROOT
    out_dir = ctx.output_dir if ctx else ROOT / "output"
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d_%H%M%S")
    tag = f"_{seed}" if seed is not None else ""
    files = []
    for i, im in enumerate(pils):
        p = out_dir / (f"{prefix}_{ts}{tag}" + (f"_{i}" if len(pils) > 1 else "") + ".png")
        n = 1
        while p.exists():
            p = p.with_name(f"{p.stem}-{n}.png")
            n += 1
        im.save(p)
        files.append(p.relative_to(root).as_posix())
    return files


def decode_pils(ctx, vae, latent):
    """LATENT → список PIL."""
    torch, diffusers, _ = _packages()
    with _lock:
        m = _vae_module(ctx, vae, torch, diffusers)
        cfg = m.config
        mean, std = getattr(cfg, "latents_mean", None), getattr(cfg, "latents_std", None)
        h, w = latent.samples.shape[-2] * 8, latent.samples.shape[-1] * 8

        def run():
            lat = latent.samples.to(device=next(m.parameters()).device, dtype=m.dtype)
            if mean is not None and std is not None:
                lat = lat * torch.tensor(std).view(1, 4, 1, 1).to(lat) / cfg.scaling_factor \
                    + torch.tensor(mean).view(1, 4, 1, 1).to(lat)
            else:
                lat = lat / cfg.scaling_factor
            return m.decode(lat, return_dict=False)[0]
        t0 = time.time()
        with torch.inference_mode():
            logs.watchdog(STALL)
            try:
                img = _vae_run(torch, m, _vae_need("decode", h, w, m.dtype), run, ctx, key=("decode", w, h))
            finally:
                logs.stop_watchdog()
        _dbg("vae decode", round(time.time() - t0, 2), "с")
        if ctx:
            ctx.log(f"VAE decode {w}×{h}: {time.time() - t0:.1f} s ({str(m.dtype).replace('torch.', '')})")
        pils = _processor(diffusers).postprocess(img.to("cpu", torch.float32), output_type="pil")
        if not _opts(ctx)["keep"]:
            _drop()
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass
    return pils


# ---------- перерисовка области (inpaint / детализация) ----------
def _span(lo, hi, size, minside):
    """Отрезок [lo, hi) не короче minside внутри [0, size)."""
    if hi - lo >= minside or size <= minside:
        return (lo, hi) if hi - lo >= minside else (0, size)
    c = (lo + hi) / 2
    lo = int(max(0, min(size - minside, c - minside / 2)))
    return lo, lo + minside


def inpaint(ctx, model, positive, negative, vae, image, mask, seed, steps, cfg, sampler, scheduler, denoise,
            only_masked=True, padding=48, resolution=0, feather=12, fill=False, patch=False):
    """Перерисовка области по маске, как «Inpaint only masked» в A1111 / Detailer в ComfyUI: область маски с полями
    вырезается и масштабируется до родного разрешения модели (мелкие детали получают все пиксели), латент вне маски
    держится на месте, результат уменьшается обратно и вклеивается с растушёвкой — остальная картинка не трогается
    вовсе (без потерь VAE). denoise ~0.3–0.5 — детализация, 0.8–1 — заменить объект по промпту.
    fill — область маски перед сэмплингом размывается (как «fill» в A1111): старый объект не просвечивает.
    patch — сохраняется только область (RGBA, альфа — растушёванная маска) для слоёв редактора.
    Возвращает (файл, {"x", "y", "w", "h", "W", "H"}) — где область лежит на картинке."""
    torch, _diffusers, Image = _packages()
    from PIL import ImageFilter
    root = ctx.root if ctx else ROOT
    with Image.open(root / image["file"]) as im:
        src = im.convert("RGB")
    with Image.open(root / mask["file"]) as im:
        m = im.convert("RGBA")
        # маска — белое по прозрачному или чёрному: яркость × альфа
        msk = Image.composite(m.convert("L"), Image.new("L", m.size, 0), m.getchannel("A"))
    if msk.size != src.size:
        msk = msk.resize(src.size, Image.BILINEAR)
    box = msk.point(lambda v: 255 if v > 16 else 0).getbbox()
    if not box:
        raise ValueError("the mask is empty — paint the area to change")
    W, H = src.size
    res = int(resolution) or (1024 if positive.sdxl else 640)
    if only_masked:
        pad, minside = int(padding), max(64, res // 4)  # мелкой области — немного контекста вокруг
        x0, x1 = _span(max(0, box[0] - pad), min(W, box[2] + pad), W, minside)
        y0, y1 = _span(max(0, box[1] - pad), min(H, box[3] + pad), H, minside)
    else:
        x0, y0, x1, y1 = 0, 0, W, H
    crop = (x0, y0, x1, y1)
    cw, ch = x1 - x0, y1 - y0
    k = min(4.0, (res * res / (cw * ch)) ** 0.5)
    tw, th = max(64, int(round(cw * k / 8)) * 8), max(64, int(round(ch * k / 8)) * 8)
    part = src.crop(crop).resize((tw, th), Image.LANCZOS)
    pmask = msk.crop(crop)
    if fill:
        r = max(8, min(tw, th) // 10)
        soft = pmask.resize((tw, th), Image.BILINEAR).filter(ImageFilter.MaxFilter(9)).filter(ImageFilter.GaussianBlur(4))
        part = Image.composite(part.filter(ImageFilter.GaussianBlur(r)), part, soft)
    # маска латента — чуть шире и мягче: шов перерисовывается вместе с областью
    grow = max(2, int(round(min(cw, ch) * 0.015)))
    lmask = pmask.filter(ImageFilter.MaxFilter(grow * 2 + 1)).filter(ImageFilter.GaussianBlur(grow))
    lmask = lmask.resize((tw // 8, th // 8), Image.BILINEAR)
    nm = torch.tensor(list(lmask.getdata()), dtype=torch.float32).view(1, 1, th // 8, tw // 8) / 255.0
    box = {"x": x0, "y": y0, "w": cw, "h": ch, "W": W, "H": H}
    if ctx:
        ctx.log(f"inpaint: area {cw}×{ch} at ({x0},{y0}) → {tw}×{th}, denoise {denoise}" + (", fill" if fill else ""))
        ctx.preview_meta = {"box": box}
    lat = encode_pil(ctx, vae, part)
    out = sample(ctx, model, positive, negative, lat, seed, steps, cfg, sampler, scheduler, denoise, noise_mask=nm,
                 control_box=box)
    gen = decode_pils(ctx, vae, out)[0].resize((cw, ch), Image.LANCZOS)
    # вклейка по растушёванной маске; вне неё — исходные пиксели
    f = max(0, int(feather))
    paste = pmask.filter(ImageFilter.MaxFilter(3))
    if f:
        paste = paste.filter(ImageFilter.MaxFilter(min(f, 15) // 2 * 2 + 1)).filter(ImageFilter.GaussianBlur(f / 2))
    if patch:
        layer = gen.convert("RGBA")
        layer.putalpha(paste)
        return save_pils(ctx, [layer], "naizer", int(seed))[0], box
    result = src.copy()
    result.paste(Image.composite(gen, src.crop(crop), paste), crop[:2])
    return save_pils(ctx, [result], "inpaint", int(seed))[0], box
