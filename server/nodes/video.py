"""Video: Wan 2.2 image-to-video (local, ComfyUI model files). VIDEO = {"file": "temp|output/….mp4", fps, frames, …}."""
import random
import shutil
import time
from pathlib import Path

from maistep import node, translate as T, video as V

NEG = ("vivid colors, overexposed, static, blurry details, subtitles, style, artwork, painting, still frame, overall gray, "
       "worst quality, low quality, jpeg artifacts, ugly, deformed, extra fingers, poorly drawn hands, poorly drawn face, "
       "malformed limbs, fused fingers, motionless, cluttered background, three legs, walking backwards")


@node("video.wan_loader", title="Load Wan 2.2 I2V", cat="Video",
      inputs={"high": ("STRING", {"default": "", "picker": "library_model", "cat": "unet",
                                  "hint": "high noise expert (…high_noise…); empty — found in the library"}),
              "low": ("STRING", {"default": "", "picker": "library_model", "cat": "unet", "hint": "low noise expert (…low_noise…)"}),
              "text_encoder": ("STRING", {"default": "", "picker": "library_model", "cat": "text_encoders", "hint": "umt5-xxl"}),
              "vae": ("STRING", {"default": "", "picker": "library_model", "cat": "vae", "hint": "wan_2.1_vae"})},
      outputs={"model": "WAN"},
      hint="Wan 2.2 I2V A14B from ComfyUI files (fp8 scaled .safetensors). Empty fields are filled from the library; "
           "models with lightx2v baked in (…lightx2v_4step…) need only 4 steps and cfg 1.")
def wan_loader(high, low, text_encoder, vae):
    a = V.auto()
    names = {"high": high or a["high"], "low": low or a["low"], "text_encoder": text_encoder or a["text_encoder"], "vae": vae or a["vae"]}
    miss = [k for k, v in names.items() if not v]
    if miss:
        raise FileNotFoundError(f"Wan 2.2: в библиотеке не найдено: {', '.join(miss)}")
    cats = {"high": "unet", "low": "unet", "text_encoder": "text_encoders", "vae": "vae"}
    return {"paths": {k: str(V.find(cats[k], v)) for k, v in names.items()}, "names": names}


@node("video.wan_i2v", title="Wan Image to Video", cat="Video",
      inputs={"model": ("WAN", {}), "image": ("IMAGE", {}),
              "prompt": ("STRING", {"multiline": True, "default": "", "hint": "what moves and how; Russian is translated"}),
              "negative": ("STRING", {"multiline": True, "default": NEG}),
              "width": ("INT", {"default": 832, "min": 256, "max": 1280, "step": 16}),
              "height": ("INT", {"default": 480, "min": 256, "max": 1280, "step": 16}),
              "frames": ("INT", {"default": 81, "min": 5, "max": 161, "step": 4, "hint": "4k+1: 49 ≈ 3 s, 81 ≈ 5 s at 16 fps"}),
              "fps": ("INT", {"default": 16, "min": 4, "max": 60}),
              "steps": ("INT", {"default": 4, "min": 1, "max": 60, "hint": "4 with lightx2v, 20–30 without"}),
              "cfg": ("FLOAT", {"default": 1.0, "min": 1.0, "max": 10.0, "step": 0.1, "hint": "1 with lightx2v (no negative pass — twice faster)"}),
              "shift": ("FLOAT", {"default": 5.0, "min": 1.0, "max": 20.0, "step": 0.5}),
              "sampler": (["euler", "unipc"], {}),
              "seed": ("INT", {"default": -1, "min": -1, "max": 2 ** 50}),
              "fp8_fast": ("BOOLEAN", {"default": False, "hint": "multiply in fp8 on RTX 40/50 tensor cores: ~15% faster, "
                                                                  "slightly less precise"})},
      outputs={"video": "VIDEO", "last_frame": "IMAGE", "seed": "INT"},
      volatile=lambda a: a.get("seed", -1) < 0,
      hint="Animates a picture with Wan 2.2: high noise expert for the first steps, then low noise. The clip goes to "
           "temp/ (Save Video puts it into output/); last_frame — to continue the clip with the next one.")
def wan_i2v(model, image, prompt, negative, width, height, frames, fps, steps, cfg, shift, sampler, seed, ctx, fp8_fast=False):
    from PIL import Image
    seed = random.randint(0, 2 ** 50) if seed < 0 else int(seed)
    width, height = width // 16 * 16, height // 16 * 16
    frames = (max(5, frames) - 1) // 4 * 4 + 1
    paths = {k: Path(v) for k, v in model["paths"].items()}
    out = V.i2v(ctx, paths, image["file"], T.translate(ctx, prompt), T.translate(ctx, negative) if cfg > 1 else negative,
                width, height, frames, steps, float(cfg), float(shift), sampler, seed, bool(fp8_fast))
    stem = f"wan_{time.strftime('%Y%m%d_%H%M%S')}_{seed}"
    d = ctx.root / "temp"
    V.write(out, d / f"{stem}.mp4", fps)
    Image.fromarray(out[0]).save(d / f"{stem}.jpg", quality=88)
    Image.fromarray(out[-1]).save(d / f"{stem}_last.png")
    vid = V.meta(f"temp/{stem}.mp4", fps, len(out), out.shape[2], out.shape[1])
    return {"video": vid, "last_frame": {"file": vid["last"]}, "seed": seed, "ui": {"videos": [vid]}}


@node("video.save", title="Save Video", cat="Video", output=True,
      inputs={"video": ("VIDEO", {}), "prefix": ("STRING", {"default": "video"})}, outputs={"video": "VIDEO"},
      hint="Copies the clip (and its poster frame) into output/.")
def video_save(video, prefix, ctx):
    src = ctx.root / video["file"]
    stem = f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}"
    dst = ctx.output_dir / f"{stem}.mp4"
    shutil.copyfile(src, dst)
    for a, b in ((video.get("poster"), ".jpg"), (video.get("last"), "_last.png")):
        if a and (ctx.root / a).is_file():
            shutil.copyfile(ctx.root / a, ctx.output_dir / f"{stem}{b}")
    rel = dst.relative_to(ctx.root).as_posix()
    vid = V.meta(rel, video.get("fps", 16), video.get("frames", 0), video.get("width", 0), video.get("height", 0))
    return {"video": vid, "ui": {"videos": [vid]}}
