"""MangaNinja: раскраска ч/б лайнарта по цветному референсу (ali-vilab/MangaNinjia, CVPR 2025, CC BY-NC 4.0).

Модель не придумывает цвета — переносит их с референса (цветной кадр того же персонажа / сцены) на линии,
поэтому совпадение с рисунком у неё заметно точнее, чем у SDXL + ControlNet. Основа — SD 1.5, ~512 px.
Веса — models/manganinja (компонент «MangaNinja»): ninja/{denoising_unet,reference_unet,controlnet,point_net}
(.pth авторов → при первой загрузке сохраняются рядом как .fp16.safetensors, .pth можно удалить),
clip/ (openai/clip-vit-large-patch14), controlnet/config.json (control_v11p_sd15_lineart), sd/{unet,vae,scheduler}
(конфиги SD 1.5 + VAE). Модели живут в RAM; на время вызова — на GPU, UNet SDXL на это время уходит в RAM.
"""
import gc
import os
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT / "models" / "manganinja"
PARTS = ("denoising_unet", "reference_unet", "controlnet", "point_net")
_state = {"pipe": None}
_lock = threading.Lock()


def missing():
    """Каких файлов не хватает (пусто — всё на месте)."""
    need = [BASE / "clip" / "model.safetensors", BASE / "clip" / "tokenizer.json", BASE / "controlnet" / "config.json",
            BASE / "sd" / "unet" / "config.json", BASE / "sd" / "vae" / "diffusion_pytorch_model.safetensors",
            BASE / "sd" / "scheduler" / "scheduler_config.json"]
    out = [p for p in need if not p.is_file()]
    for part in PARTS:
        if not _weights(part):
            out.append(BASE / "ninja" / f"{part}.pth")
    return [str(p.relative_to(ROOT)) for p in out]


def _weights(part):
    for name in (f"{part}.fp16.safetensors", f"{part}.pth"):
        p = BASE / "ninja" / name
        if p.is_file():
            return p
    return None


def _state_dict(torch, part):
    """Веса части: fp16-safetensors или .pth авторов (тогда — сразу сохраняем fp16-копию: вдвое меньше и быстрее)."""
    p = _weights(part)
    if p.suffix == ".safetensors":
        from safetensors.torch import load_file
        return load_file(str(p))
    sd = torch.load(str(p), map_location="cpu", weights_only=True)
    sd = {k: (v.half() if v.is_floating_point() else v).contiguous() for k, v in sd.items()}
    try:
        from safetensors.torch import save_file
        save_file(sd, str(p.with_name(f"{part}.fp16.safetensors")))
    except Exception:
        pass
    return sd


def _part(torch, mod, part, log):
    """Веса сразу в fp16: from_config собирает fp32, и четыре сети разом упирались в RAM (60+ ГБ из 64)."""
    import logging
    mu = logging.getLogger("diffusers.models.modeling_utils")
    level = mu.level
    mu.setLevel(logging.ERROR)  # пустой список «держать в float32» — ложная тревога diffusers при .to(fp16)
    try:
        mod.to(dtype=torch.float16)
    finally:
        mu.setLevel(level)
    sd = _state_dict(torch, part)
    bad = mod.load_state_dict(sd, strict=False)
    del sd
    if bad.missing_keys:
        log(f"MangaNinja {part}: нет {len(bad.missing_keys)} весов (напр. {bad.missing_keys[0]})")
    return mod


def _load(torch, log):
    from diffusers import AutoencoderKL, ControlNetModel, DDIMScheduler
    from transformers import CLIPTextModel, CLIPTokenizer, CLIPVisionModelWithProjection
    from .manganinja.manganinjia_pipeline import MangaNinjiaPipeline
    from .manganinja.point_network import PointNet
    from .manganinja.refunet_2d_condition import RefUNet2DConditionModel
    from .manganinja.unet_2d_condition import UNet2DConditionModel
    # transformers 5 режет safetensors по потокам (core_model_loading.spawn_materialize). На Windows
    # рабочий поток падает с access violation в _materialize_copy — процесс сервера умирает целиком,
    # как раз на CLIP после сетей (логи 2026-10-26). Выключатель — их же HF_DEACTIVATE_ASYNC_LOAD.
    os.environ["HF_DEACTIVATE_ASYNC_LOAD"] = "1"
    import logging
    t0 = time.time()
    fp = torch.float16
    ucfg = UNet2DConditionModel.load_config(str(BASE / "sd" / "unet"))
    denoise = _part(torch, UNet2DConditionModel.from_config(ucfg), "denoising_unet", log)
    ref = _part(torch, RefUNet2DConditionModel.from_config(ucfg), "reference_unet", log)
    cn = _part(torch, ControlNetModel.from_config(ControlNetModel.load_config(str(BASE / "controlnet"))), "controlnet", log)
    point = _part(torch, PointNet(), "point_net", log)
    gc.collect()
    clip = str(BASE / "clip")
    tok = CLIPTokenizer.from_pretrained(clip)
    # один файл CLIP на текст и картинку: «UNEXPECTED» и «layers were not sharded» — не ошибка
    # (нет тензорного параллелизма, обе башни лежат в одном checkpoint)
    quiet = ("transformers.modeling_utils", "transformers.distributed.tensor_parallel")
    prev = {name: logging.getLogger(name).level for name in quiet}
    for name in quiet:
        logging.getLogger(name).setLevel(logging.ERROR)
    try:
        text = CLIPTextModel.from_pretrained(clip, torch_dtype=fp)
        vision = CLIPVisionModelWithProjection.from_pretrained(clip, torch_dtype=fp)
    finally:
        for name, level in prev.items():
            logging.getLogger(name).setLevel(level)
    vae = AutoencoderKL.from_pretrained(str(BASE / "sd" / "vae"), torch_dtype=fp)
    sched = DDIMScheduler.from_pretrained(str(BASE / "sd" / "scheduler"))
    # у авторов по копии CLIP на reference UNet и ControlNet — веса одинаковые, держим одну (−0.8 ГБ VRAM)
    pipe = MangaNinjiaPipeline(reference_unet=ref, controlnet=cn, denoising_unet=denoise, vae=vae,
                               refnet_tokenizer=tok, refnet_text_encoder=text, refnet_image_encoder=vision,
                               controlnet_tokenizer=tok, controlnet_text_encoder=text, controlnet_image_encoder=vision,
                               scheduler=sched, point_net=point)
    pipe.set_progress_bar_config(disable=True)
    log(f"MangaNinja загружена за {time.time() - t0:.1f} с")
    return pipe


def size_for(w, h, area=512 * 512, most=768):
    """Размер для модели: площадь ~512², стороны кратны 64 (PointNet уменьшает в 64 раза), не длиннее most."""
    k = (area / (w * h)) ** 0.5
    W = max(256, min(most, round(w * k / 64) * 64))
    H = max(256, min(most, round(h * k / 64) * 64))
    return W, H


def colorize(reference, lineart, steps=30, guidance=9.0, seed=None, log=print, progress=None, stop=None):
    """reference — цветной PIL, lineart — PIL «L»: белые линии на чёрном. → цветной PIL размера lineart
    (стороны кратны 64). Референс растягивается до того же размера, как у авторов."""
    import warnings

    import numpy as np
    import torch
    from . import diffusion as D
    W, H = lineart.size
    if W % 64 or H % 64:
        raise ValueError("lineart sides must be multiples of 64 (use size_for)")
    if not torch.cuda.is_available():
        raise RuntimeError("MangaNinja needs an NVIDIA GPU (CUDA)")
    with D._lock, _lock:
        if _state["pipe"] is None:
            _state["pipe"] = _load(torch, log)
        pipe = _state["pipe"]
        D._unet_to(torch, "cpu")  # 8 ГБ: SDXL и MangaNinja вместе не помещаются
        sd = D._state.get("pipe")
        vae = getattr(sd, "vae", None) if sd is not None else None
        vae_on_gpu = vae is not None and next(vae.parameters()).is_cuda
        if vae_on_gpu:  # после декода SDXL VAE ещё на карте — вместе с MangaNinja это уже за 8 ГБ
            with torch.inference_mode(False), torch.no_grad():
                vae.to("cpu")
            torch.cuda.empty_cache()
        t0 = time.time()
        step = pipe.scheduler.step if progress else None
        try:
            pipe.to("cuda")
            g = torch.Generator("cuda").manual_seed(int(seed if seed is not None and seed >= 0 else time.time()) % 2**32)
            if progress:  # шаги DDIM: обёртка вокруг scheduler.step (у пайплайна нет колбэка)
                n = [0]

                def wrapped(*a, **k):
                    if stop and stop():
                        raise InterruptedError("прервано")
                    n[0] += 1
                    progress(n[0], steps)
                    return step(*a, **k)
                pipe.scheduler.step = wrapped
            zero = torch.from_numpy(np.zeros((H, W), np.uint8))[None, None]
            with warnings.catch_warnings():
                # vendored UNet ещё передаёт scale= в Resnet/Attention; diffusers 0.41 его игнорирует
                warnings.filterwarnings("ignore", message=r"`scale` is deprecated", category=FutureWarning)
                out = pipe(True, reference.convert("RGB").resize((W, H)), lineart.convert("L"), lineart.convert("L"),
                           denosing_steps=int(steps), processing_res=0, match_input_res=True, batch_size=1,
                           show_progress_bar=False, guidance_scale_ref=float(guidance), guidance_scale_point=15.0,
                           generator=g, point_ref=zero, point_main=zero)
        finally:
            if step is not None:
                pipe.scheduler.step = step
            pipe.to("cpu", silence_dtype_warnings=True)  # между вызовами веса лежат в RAM, считаем только на GPU
            if vae_on_gpu:
                with torch.inference_mode(False), torch.no_grad():
                    vae.to("cuda")
            torch.cuda.empty_cache()
        log(f"MangaNinja {W}×{H}, {steps} шагов: {time.time() - t0:.1f} с")
        return out.img_pil


def panels(page, min_frac=0.02):
    """Панели страницы манги: всё, что не поля листа (пустая бумага, связанная с краем). → [(x0, y0, x1, y1)] сверху
    вниз; полей нет (рисунок до края) — одна рамка на всю страницу."""
    import numpy as np
    from scipy import ndimage as nd
    W, H = page.size
    s = min(1.0, 1200 / max(W, H))
    g = page.convert("L").resize((max(1, round(W * s)), max(1, round(H * s))))
    lum = np.asarray(g)
    h, w = lum.shape
    # поля между панелями бывают в 5–10 px: окно маленькое; через сплошную рамку панели «пустота» не пройдёт
    rr = 1
    blank = nd.minimum_filter(lum, size=2 * rr + 1) > 230
    bl, n = nd.label(blank)
    side = np.unique(np.concatenate([bl[0], bl[-1], bl[:, 0], bl[:, -1]]))
    side = side[side > 0]
    if not n or not side.size:
        return [(0, 0, W, H)]
    margin = nd.binary_dilation(np.isin(bl, side), iterations=rr)
    lab, m = nd.label(~margin)
    out = []
    for i, sl in enumerate(nd.find_objects(lab), 1):
        ys, xs = sl
        if (lab[sl] == i).sum() < min_frac * w * h:
            continue
        pad = 2
        out.append((max(0, round((xs.start - pad) / s)), max(0, round((ys.start - pad) / s)),
                    min(W, round((xs.stop + pad) / s)), min(H, round((ys.stop + pad) / s))))
    out.sort(key=lambda b: (round(b[1] / (H * 0.05)), b[0]))  # по строкам, внутри строки — слева направо
    return out or [(0, 0, W, H)]


def colorize_page(page, reference, aligned=True, per_panel=True, steps=30, guidance=9.0, seed=None, log=print,
                  progress=None, stop=None):
    """Страница целиком: каждая панель — отдельно в ~512² (модель видит детали), лайнарт — инверсия оригинала.
    aligned — референс это цветная версия той же страницы (раскраска SDXL): для панели берётся тот же кусок;
    иначе референс — отдельная картинка (персонаж, обложка) и идёт целиком в каждую панель.
    → цветной PIL размера страницы (поля — из референса или белые); линии потом берёт Keep Lines."""
    from PIL import Image, ImageOps
    W, H = page.size
    gray = page.convert("L")
    ref_page = reference.convert("RGB").resize((W, H), Image.LANCZOS) if aligned else None
    canvas = ref_page.copy() if aligned else Image.new("RGB", (W, H), (255, 255, 255))
    boxes = panels(page) if per_panel else [(0, 0, W, H)]
    log(f"MangaNinja: {len(boxes)} {'панелей' if len(boxes) != 1 else 'панель'}")
    for i, box in enumerate(boxes):
        crop = gray.crop(box)
        size = size_for(*crop.size)
        line = ImageOps.autocontrast(ImageOps.invert(crop), cutoff=(1, 0.2)).resize(size, Image.LANCZOS)
        ref = ref_page.crop(box) if aligned else reference
        part = (lambda k, n, i=i: progress(i * n + k, len(boxes) * n)) if progress else None
        out = colorize(ref, line, steps=steps, guidance=guidance, seed=None if seed is None else seed + i, log=log,
                       progress=part, stop=stop)
        canvas.paste(out.resize((box[2] - box[0], box[3] - box[1]), Image.LANCZOS), box[:2])
    return canvas


def unload():
    with _lock:
        _state["pipe"] = None
