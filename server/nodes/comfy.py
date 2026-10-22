"""Ноды моста к ComfyUI (server/maistep/comfy.py): генерация по чекпоинту + LoRA и запуск сохранённых воркфлоу ComfyUI.
Картинки результата копируются в output/comfy/ maistep; в выходную папку ComfyUI генерация не пишет (PreviewImage)."""
import random

from maistep import node
from maistep import comfy as C
from maistep import library as L

SAMPLERS_FB = ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_sde", "dpmpp_3m_sde", "ddim", "uni_pc", "lcm"]
SCHEDULERS_FB = ["normal", "karras", "exponential", "sgm_uniform", "simple", "ddim_uniform", "beta"]
SAMPLERS = C.choices("KSampler", "sampler_name", SAMPLERS_FB) or SAMPLERS_FB
SCHEDULERS = C.choices("KSampler", "scheduler", SCHEDULERS_FB) or SCHEDULERS_FB


def _default_ckpt():
    try:
        names = L.names("checkpoints")
    except Exception:
        return ""
    for pref in ("waiIllustriousSDXL", "aMixIllustrious"):
        for n in names:
            if n.startswith(pref):
                return n
    return names[0] if names else ""


def _upload(img, ctx):
    """IMAGE maistep ({"file": "output/…"}) → имя картинки в input/ ComfyUI."""
    return C.upload_image(ctx.root / img["file"])


def _result(r, seed=None):
    imgs = [{"file": f} for f in r["images"]]
    out = {"image": imgs[0] if imgs else None, "images": imgs, "ui": {"images": r["images"]}}
    if r["texts"]:
        out["ui"]["text"] = "\n\n".join(r["texts"])
    if seed is not None:
        out["seed"] = seed
    return out


LORA = lambda: ("STRING", {"default": "", "picker": "library_model", "cat": "loras", "hint": "LoRA из библиотеки (пусто — без неё)"})  # noqa: E731
STRENGTH = ("FLOAT", {"default": 1.0, "min": -5, "max": 5, "step": 0.05})


@node("comfy.generate", title="Генерация (ComfyUI)", cat="ComfyUI",
      inputs={
          "positive": ("STRING", {"multiline": True, "default": "masterpiece, best quality, 1girl, cafe by the sea at night, warm light"}),
          "negative": ("STRING", {"multiline": True, "default": "lowres, worst quality, bad anatomy, bad hands, watermark, text"}),
          "checkpoint": ("STRING", {"default": _default_ckpt(), "picker": "library_model", "cat": "checkpoints", "hint": "чекпоинт из библиотеки (SD1.5 / SDXL / Pony / Illustrious)"}),
          "lora1": LORA(), "lora1_strength": STRENGTH,
          "lora2": LORA(), "lora2_strength": STRENGTH,
          "lora3": LORA(), "lora3_strength": STRENGTH,
          "width": ("INT", {"default": 832, "min": 64, "max": 4096, "step": 8}),
          "height": ("INT", {"default": 1216, "min": 64, "max": 4096, "step": 8}),
          "steps": ("INT", {"default": 25, "min": 1, "max": 200}),
          "cfg": ("FLOAT", {"default": 6.0, "min": 0, "max": 30, "step": 0.5}),
          "sampler": (SAMPLERS, {"default": "euler_ancestral" if "euler_ancestral" in SAMPLERS else SAMPLERS[0]}),
          "scheduler": (SCHEDULERS, {"default": "normal" if "normal" in SCHEDULERS else SCHEDULERS[0]}),
          "clip_skip": ("INT", {"default": -2, "min": -12, "max": -1, "hint": "-2 для Pony/Illustrious/аниме, -1 — без пропуска"}),
          "seed": ("INT", {"default": -1, "min": -1, "max": 2**50, "hint": "-1 — случайный при каждом запуске"}),
          "batch": ("INT", {"default": 1, "min": 1, "max": 8}),
          "denoise": ("FLOAT", {"default": 0.55, "min": 0, "max": 1, "step": 0.05, "hint": "только с входной картинкой (img2img)"}),
          "image": ("IMAGE", {"optional": True}),
      },
      outputs={"image": "IMAGE", "images": "JSON", "seed": "INT"},
      volatile=lambda a: a.get("seed", 0) < 0,
      hint="txt2img/img2img в запущенном ComfyUI: чекпоинт + до 3 LoRA. Прогресс шагов — на ноде; картинки — в output/comfy/.")
def comfy_generate(positive, negative, checkpoint, lora1, lora1_strength, lora2, lora2_strength, lora3, lora3_strength,
                   width, height, steps, cfg, sampler, scheduler, clip_skip, seed, batch, denoise, ctx, image=None):
    if not checkpoint:
        raise ValueError("не выбран чекпоинт")
    seed = random.randint(0, 2**50) if seed < 0 else seed
    p = {"ckpt": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": C.comfy_name(checkpoint)}, "_meta": {"title": "чекпоинт"}}}
    model, clip, vae = ["ckpt", 0], ["ckpt", 1], ["ckpt", 2]
    for i, (name, s) in enumerate([(lora1, lora1_strength), (lora2, lora2_strength), (lora3, lora3_strength)], 1):
        if name:
            p[f"lora{i}"] = {"class_type": "LoraLoader", "_meta": {"title": f"LoRA {i}"},
                             "inputs": {"model": model, "clip": clip, "lora_name": C.comfy_name(name), "strength_model": s, "strength_clip": s}}
            model, clip = [f"lora{i}", 0], [f"lora{i}", 1]
    if clip_skip < -1:
        p["skip"] = {"class_type": "CLIPSetLastLayer", "inputs": {"clip": clip, "stop_at_clip_layer": clip_skip}, "_meta": {"title": "clip skip"}}
        clip = ["skip", 0]
    p["pos"] = {"class_type": "CLIPTextEncode", "inputs": {"text": positive, "clip": clip}, "_meta": {"title": "positive"}}
    p["neg"] = {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": clip}, "_meta": {"title": "negative"}}
    if image:
        p["load"] = {"class_type": "LoadImage", "inputs": {"image": _upload(image, ctx)}, "_meta": {"title": "входная картинка"}}
        p["enc"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["load", 0], "vae": vae}, "_meta": {"title": "в латент"}}
        p["rep"] = {"class_type": "RepeatLatentBatch", "inputs": {"samples": ["enc", 0], "amount": batch}, "_meta": {"title": "батч"}}
        latent, dn = ["rep", 0], denoise
    else:
        p["empty"] = {"class_type": "EmptyLatentImage", "inputs": {"width": width, "height": height, "batch_size": batch}, "_meta": {"title": "пустой латент"}}
        latent, dn = ["empty", 0], 1.0
    p["sample"] = {"class_type": "KSampler", "_meta": {"title": "сэмплер"},
                   "inputs": {"model": model, "seed": seed, "steps": steps, "cfg": cfg, "sampler_name": sampler, "scheduler": scheduler,
                              "positive": ["pos", 0], "negative": ["neg", 0], "latent_image": latent, "denoise": dn}}
    p["decode"] = {"class_type": "VAEDecode", "inputs": {"samples": ["sample", 0], "vae": vae}, "_meta": {"title": "декодирование"}}
    p["out"] = {"class_type": "PreviewImage", "inputs": {"images": ["decode", 0]}, "_meta": {"title": "результат"}}
    ctx.log(f"ComfyUI: {checkpoint}, {width}×{height}, {steps} шагов, seed {seed}")
    return _result(C.run(p, ctx, "gen"), seed)


@node("comfy.workflow", title="Воркфлоу ComfyUI", cat="ComfyUI",
      inputs={
          "workflow": ("STRING", {"default": "", "picker": "comfy_workflow", "hint": "сохранённый воркфлоу ComfyUI (UI или API формат)"}),
          "bindings": ("STRING", {"multiline": True, "default": "", "hint": "строки «a → 109.text»: вход ноды → поле воркфлоу (id.поле); подсказки — в Inspector"}),
          "seeds": (["из файла", "случайные"], {"default": "случайные"}),
          "a": ("*", {"optional": True}), "b": ("*", {"optional": True}), "c": ("*", {"optional": True}), "d": ("*", {"optional": True}),
      },
      outputs={"image": "IMAGE", "images": "JSON", "text": "STRING"},
      volatile=lambda a: a.get("seeds") == "случайные",
      hint="Запускает ваш воркфлоу ComfyUI как есть; входы a–d подставляются в выбранные поля (картинки загружаются в ComfyUI сами).")
def comfy_workflow(workflow, bindings, seeds, ctx, a=None, b=None, c=None, d=None):
    if not workflow:
        raise ValueError("не выбран воркфлоу")
    prompt, notes = C.ui_to_api(C.load_workflow(workflow))
    for n in notes:
        ctx.log(n)
    vals = {"a": a, "b": b, "c": c, "d": d}
    for line in bindings.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        src, _, dst = line.replace("->", "→").replace("=", "→").partition("→")
        src, dst = src.strip(), dst.strip()
        nid, _, field = dst.partition(".")
        if src not in vals or not nid or not field:
            raise ValueError(f"привязка «{line}»: нужно «a → id.поле»")
        if nid not in prompt:
            raise ValueError(f"привязка «{line}»: в воркфлоу нет ноды {nid}")
        v = vals[src]
        if v is None:
            continue  # вход не подключён — остаётся значение из файла
        if isinstance(v, dict) and "file" in v:
            v = _upload(v, ctx)
        prompt[nid]["inputs"][field] = v
    if seeds == "случайные":
        C.randomize_seeds(prompt)
    label = workflow.split(":")[-1].rsplit(".", 1)[0].replace("/", "_")[:40]
    r = C.run(prompt, ctx, label)
    out = _result(r)
    out["text"] = "\n\n".join(r["texts"])
    return out
