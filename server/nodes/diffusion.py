"""Stable Diffusion nodes in the ComfyUI style (server/maistep/diffusion.py): checkpoint, LoRA, prompts, sampler and
VAE are separate nodes. Runs locally on torch/diffusers from .venv — no ComfyUI needed. Images go to output/."""
import random

from maistep import node
from maistep import diffusion as D
from maistep import library as L


def _default(cat, prefs=()):
    try:
        names = L.names(cat)
    except Exception:
        return ""
    for pref in prefs:
        for n in names:
            if n.startswith(pref):
                return n
    return names[0] if names else ""


def _ckpt():
    return _default("checkpoints", ("waiIllustriousSDXL", "aMixIllustrious", "hassakuXLIllustrious", "illustriousnxtXL"))


def picker(cat, default="", hint=""):
    return ("STRING", {"default": default, "picker": "library_model", "cat": cat, "hint": hint})


@node("sd.checkpoint", title="Load Checkpoint", cat="Loaders",
      inputs={"ckpt_name": picker("checkpoints", _ckpt(), "SD1.5 / SDXL / Pony / Illustrious checkpoint from the library")},
      outputs={"model": "MODEL", "clip": "CLIP", "vae": "VAE"},
      hint="Loads a checkpoint and splits it into MODEL (UNet), CLIP (text encoders) and VAE. The model stays in memory "
           "between runs; generation settings — \"gen\" in user/settings.json.")
def load_checkpoint(ckpt_name, ctx):
    m, c, v = D.load_checkpoint(ctx, ckpt_name)
    return {"model": m, "clip": c, "vae": v}


@node("sd.lora", title="Load LoRA", cat="Loaders",
      inputs={"model": ("MODEL", {}), "clip": ("CLIP", {"optional": True}),
              "lora_name": picker("loras", "", "LoRA from the library (same base as the checkpoint)"),
              "strength_model": ("FLOAT", {"default": 1.0, "min": -5, "max": 5, "step": 0.05}),
              "strength_clip": ("FLOAT", {"default": 1.0, "min": -5, "max": 5, "step": 0.05})},
      outputs={"model": "MODEL", "clip": "CLIP"},
      hint="Adds a LoRA to MODEL and CLIP. Chain several Load LoRA nodes to stack them. "
           "Empty lora_name or both strengths 0 — passes through.")
def load_lora(model, lora_name, strength_model, strength_clip, ctx, clip=None):
    if not lora_name or (not strength_model and not strength_clip):
        return {"model": model, "clip": clip}
    m, c = D.load_lora(ctx, model, clip, lora_name, strength_model, strength_clip)
    return {"model": m, "clip": c}


@node("sd.vae", title="Load VAE", cat="Loaders",
      inputs={"vae_name": picker("vae", "", "VAE file from the library")}, outputs={"vae": "VAE"},
      hint="A standalone VAE instead of the checkpoint's own one.")
def load_vae(vae_name):
    return D.load_vae(vae_name)


@node("sd.clip_skip", title="CLIP Set Last Layer", cat="Conditioning",
      inputs={"clip": ("CLIP", {}), "stop_at_clip_layer": ("INT", {"default": -2, "min": -24, "max": -1,
              "hint": "-1 — last layer; -2 — the usual \"clip skip 2\" for anime / Pony / Illustrious"})},
      outputs={"clip": "CLIP"})
def clip_skip(clip, stop_at_clip_layer):
    return D.Clip(clip.ckpt, clip.loras, stop_at_clip_layer)


@node("sd.text_encode", title="CLIP Text Encode (Prompt)", cat="Conditioning",
      inputs={"clip": ("CLIP", {}), "text": ("STRING", {"multiline": True, "default": ""})},
      outputs={"conditioning": "CONDITIONING"},
      hint="Encodes a prompt. Use one node for the positive prompt and one for the negative.")
def text_encode(clip, text, ctx):
    return D.encode(ctx, clip, text)


@node("sd.empty_latent", title="Empty Latent Image", cat="Latent",
      inputs={"width": ("INT", {"default": 832, "min": 64, "max": 4096, "step": 8}),
              "height": ("INT", {"default": 1216, "min": 64, "max": 4096, "step": 8}),
              "batch_size": ("INT", {"default": 1, "min": 1, "max": 8})},
      outputs={"latent": "LATENT"},
      hint="Blank latent for txt2img. SDXL sizes: 1024×1024, 832×1216, 1216×832, 896×1152…")
def empty_latent(width, height, batch_size):
    return D.empty_latent(width, height, batch_size)


@node("sd.latent_upscale", title="Upscale Latent", cat="Latent",
      inputs={"samples": ("LATENT", {}), "upscale_method": (D.UPSCALE, {"default": "nearest-exact"}),
              "width": ("INT", {"default": 1248, "min": 64, "max": 8192, "step": 8}),
              "height": ("INT", {"default": 1824, "min": 64, "max": 8192, "step": 8})},
      outputs={"latent": "LATENT"},
      hint="Resize a latent — for a hires fix: KSampler → Upscale Latent → KSampler (denoise 0.4–0.6).")
def latent_upscale(samples, upscale_method, width, height):
    return D.upscale_latent(samples, upscale_method, width, height)


@node("sd.ksampler", title="KSampler", cat="Sampling",
      inputs={"model": ("MODEL", {}), "positive": ("CONDITIONING", {}), "negative": ("CONDITIONING", {}),
              "latent_image": ("LATENT", {}),
              "seed": ("INT", {"default": -1, "min": -1, "max": 2**50, "hint": "-1 — new random seed every run"}),
              "steps": ("INT", {"default": 25, "min": 1, "max": 200}),
              "cfg": ("FLOAT", {"default": 6.0, "min": 0, "max": 30, "step": 0.5}),
              "sampler_name": (list(D.SAMPLERS), {"default": "euler_ancestral"}),
              "scheduler": (list(D.SCHEDULERS), {"default": "normal"}),
              "denoise": ("FLOAT", {"default": 1.0, "min": 0, "max": 1, "step": 0.05,
                                    "hint": "1 — from noise (txt2img); lower — img2img on the input latent"})},
      outputs={"latent": "LATENT", "seed": "INT"},
      volatile=lambda a: a.get("seed", 0) < 0,
      hint="Denoises the latent. steps — the number of steps actually run (with denoise < 1 the schedule is "
           "stretched like in ComfyUI).")
def ksampler(model, positive, negative, latent_image, seed, steps, cfg, sampler_name, scheduler, denoise, ctx):
    seed = random.randint(0, 2**50) if seed < 0 else int(seed)
    lat = D.sample(ctx, model, positive, negative, latent_image, seed, steps, cfg, sampler_name, scheduler, denoise)
    return {"latent": lat, "seed": seed}


@node("sd.vae_decode", title="VAE Decode", cat="Latent",
      inputs={"samples": ("LATENT", {}), "vae": ("VAE", {})},
      outputs={"image": "IMAGE", "images": "JSON"},
      hint="Latent → image (PNG in output/). With batch > 1, image is the first one and images is the whole batch.")
def vae_decode(samples, vae, ctx):
    files = D.vae_decode(ctx, vae, samples)
    imgs = [{"file": f} for f in files]
    return {"image": imgs[0] if imgs else None, "images": imgs, "ui": {"images": files}}


@node("sd.vae_encode", title="VAE Encode", cat="Latent",
      inputs={"pixels": ("IMAGE", {}), "vae": ("VAE", {})}, outputs={"latent": "LATENT"},
      hint="Image → latent for img2img: VAE Encode → KSampler with denoise < 1.")
def vae_encode(pixels, vae, ctx):
    return D.vae_encode(ctx, vae, pixels)


def _sampler_inputs(seed_hint="-1 — new random seed every run"):
    return {"seed": ("INT", {"default": -1, "min": -1, "max": 2**50, "hint": seed_hint}),
            "steps": ("INT", {"default": 25, "min": 1, "max": 200}),
            "cfg": ("FLOAT", {"default": 6.0, "min": 0, "max": 30, "step": 0.5}),
            "sampler_name": (list(D.SAMPLERS), {"default": "euler_ancestral"}),
            "scheduler": (list(D.SCHEDULERS), {"default": "normal"})}


@node("sd.magic_ksampler", title="Magic KSampler", cat="Sampling",
      inputs={"model": ("MODEL", {}), "positive": ("CONDITIONING", {}), "negative": ("CONDITIONING", {}),
              "latent_image": ("LATENT", {}), **_sampler_inputs(),
              "denoise": ("FLOAT", {"default": 1.0, "min": 0, "max": 1, "step": 0.05,
                                    "hint": "1 — from noise (txt2img); lower — img2img on the input latent"})},
      outputs={"latent": "LATENT", "seed": "INT"},
      volatile=lambda a: a.get("seed", 0) < 0,
      hint="KSampler that tunes itself to the checkpoint and LoRAs upstream: steps, cfg, sampler and scheduler are "
           "filled with the best values for this model (author's description on Civitai, example images, base model "
           "profile, Lightning/Hyper/LCM LoRAs). Change any value freely — «Reset» brings the recommendation back.")
def magic_ksampler(model, positive, negative, latent_image, seed, steps, cfg, sampler_name, scheduler, denoise, ctx):
    try:
        from maistep import magic
        rec = magic.recommend(str(model.ckpt), [(p, s) for p, s in model.loras])
        if rec.get("ok"):
            mine = {"steps": steps, "cfg": cfg, "sampler_name": sampler_name, "scheduler": scheduler}
            diff = [f"{k} {mine[k]} (rec. {v})" for k, v in rec["params"].items() if str(mine[k]) != str(v)]
            ctx.log(f"Magic: {rec['profile']}" + (f"; changed by hand: {', '.join(diff)}" if diff else "; recommended values"))
    except Exception as e:  # подсказка — необязательная
        ctx.log(f"Magic: no recommendation ({type(e).__name__}: {e})", "warn")
    return ksampler(model, positive, negative, latent_image, seed, steps, cfg, sampler_name, scheduler, denoise, ctx)


@node("sd.inpaint", title="Inpaint Region", cat="Sampling",
      inputs={"model": ("MODEL", {}), "positive": ("CONDITIONING", {}), "negative": ("CONDITIONING", {}),
              "vae": ("VAE", {}), "image": ("IMAGE", {}),
              "mask": ("IMAGE", {"hint": "white (or opaque) — the area to redraw"}), **_sampler_inputs(),
              "denoise": ("FLOAT", {"default": 0.9, "min": 0.05, "max": 1, "step": 0.05,
                                    "hint": "0.3–0.5 — add detail keeping the shapes; 0.8–1 — replace the object by the prompt"}),
              "only_masked": ("BOOLEAN", {"default": True, "hint": "crop the masked area and upscale it to the model's resolution"}),
              "padding": ("INT", {"default": 48, "min": 0, "max": 512, "step": 8, "hint": "context around the mask, px"}),
              "resolution": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 64, "hint": "0 — model native (SDXL 1024, SD1.5 640)"}),
              "feather": ("INT", {"default": 12, "min": 0, "max": 128, "hint": "soft edge of the pasted area, px"})},
      outputs={"image": "IMAGE", "seed": "INT"},
      volatile=lambda a: a.get("seed", 0) < 0,
      hint="Redraws only the masked area (like «Inpaint only masked» / Detailer): the area is cropped, upscaled, "
           "denoised with the rest of the latent held in place, scaled back and pasted with a soft edge.")
def inpaint(model, positive, negative, vae, image, mask, seed, steps, cfg, sampler_name, scheduler, denoise,
            only_masked, padding, resolution, feather, ctx):
    seed = random.randint(0, 2**50) if seed < 0 else int(seed)
    f = D.inpaint(ctx, model, positive, negative, vae, image, mask, seed, steps, cfg, sampler_name, scheduler, denoise,
                  only_masked, padding, resolution, feather)
    return {"image": {"file": f}, "seed": seed, "ui": {"images": [f]}}
