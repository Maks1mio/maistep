"""Upscale models, detailers and tiled upscale (server/maistep/refine.py) — the ComfyUI / A1111 nodes that imported
workflows use most: Load Upscale Model + Upscale Image (using Model), Upscale Image / By, Face Detailer (ADetailer),
Ultimate SD Upscale."""
import random

from maistep import node
from maistep import diffusion as D
from maistep import refine as R

from .diffusion import _default, _sampler_inputs, picker


def _image(ctx, image):
    from PIL import Image
    with Image.open(ctx.root / image["file"]) as im:
        return im.convert("RGB")


def _save(ctx, pil, prefix):
    f = D.save_pils(ctx, [pil], prefix, temp=True)[0]
    return {"image": {"file": f}, "ui": {"images": [f]}}


@node("sd.upscale_model_load", title="Load Upscale Model", cat="Loaders",
      inputs={"model_name": picker("upscale_models", _default("upscale_models", ("4x-UltraSharp", "RealESRGAN_x4plus_anime", "4x"))
                                   , "ESRGAN / Real-ESRGAN / DAT / SwinIR… (.pth, .safetensors) from models/upscale_models")},
      outputs={"upscale_model": "UPSCALE_MODEL"},
      hint="An image upscale model, like UpscaleModelLoader in ComfyUI. 4x-UltraSharp — universal, "
           "RealESRGAN_x4plus_anime_6B — anime (Components → Models).")
def upscale_model_load(model_name):
    return R.UpscaleModel(D.model_path("upscale_models", model_name))


@node("image.upscale_model", title="Upscale Image (using Model)", cat="Image",
      inputs={"upscale_model": ("UPSCALE_MODEL", {}), "image": ("IMAGE", {})},
      outputs={"image": "IMAGE"},
      hint="Enlarges the image by the model's own factor (×2, ×4) in tiles. Follow with Upscale Image By to get "
           "the size you need (e.g. ×4 model, then ×0.375 = ×1.5 total).")
def upscale_model(upscale_model, image, ctx):
    return _save(ctx, R.upscale_pil(ctx, upscale_model.path, _image(ctx, image)), "upscale")


METHODS = ["lanczos", "bicubic", "bilinear", "area", "nearest-exact"]


@node("image.scale_by", title="Upscale Image By", cat="Image",
      inputs={"image": ("IMAGE", {}), "upscale_method": (METHODS, {"default": "lanczos"}),
              "scale_by": ("FLOAT", {"default": 1.5, "min": 0.01, "max": 8, "step": 0.05})},
      outputs={"image": "IMAGE", "width": "INT", "height": "INT"},
      hint="Resizes the image by a factor (sides rounded to 8).")
def scale_by(image, upscale_method, scale_by, ctx):
    im = _image(ctx, image)
    w, h = (max(8, round(v * scale_by / 8) * 8) for v in im.size)
    return {**_save(ctx, R.resize_to(im, w, h, upscale_method), "scale"), "width": w, "height": h}


@node("image.scale", title="Upscale Image", cat="Image",
      inputs={"image": ("IMAGE", {}), "upscale_method": (METHODS, {"default": "lanczos"}),
              "width": ("INT", {"default": 1024, "min": 0, "max": 16384, "step": 8, "hint": "0 — by height, keep the aspect"}),
              "height": ("INT", {"default": 1024, "min": 0, "max": 16384, "step": 8, "hint": "0 — by width, keep the aspect"}),
              "crop": (["disabled", "center"], {"default": "disabled", "hint": "center — fill the size and cut the overflow"})},
      outputs={"image": "IMAGE"},
      hint="Resizes the image to the given size, like ImageScale in ComfyUI.")
def scale(image, upscale_method, width, height, crop, ctx):
    im = _image(ctx, image)
    w, h = int(width), int(height)
    if not w and not h:
        return {"image": image}
    w = w or round(im.width * h / im.height)
    h = h or round(im.height * w / im.width)
    if crop == "center":
        k = max(w / im.width, h / im.height)
        im = R.resize_to(im, round(im.width * k), round(im.height * k), upscale_method)
        x, y = (im.width - w) // 2, (im.height - h) // 2
        return _save(ctx, im.crop((x, y, x + w, y + h)), "scale")
    return _save(ctx, R.resize_to(im, w, h, upscale_method), "scale")


@node("sd.detector_load", title="Load Detector (YOLO)", cat="Loaders",
      inputs={"model_name": picker("ultralytics", _default("ultralytics", ("bbox/face_yolov8m", "bbox/face_yolov8n", "face_yolov8")),
                                   "YOLO model from models/ultralytics: bbox/face_yolov8m.pt — faces, hand_yolov8n — hands, "
                                   "segm/person_yolov8m-seg — people (with silhouette)")},
      outputs={"bbox_detector": "BBOX_DETECTOR"},
      hint="Detector for Face Detailer, like UltralyticsDetectorProvider (Impact Pack) / the ADetailer model. "
           "Models: Components → Models → «Детектор лиц (ADetailer)».")
def detector_load(model_name):
    return R.Detector(D.model_path("ultralytics", model_name))


@node("sd.detailer", title="Face Detailer", cat="Sampling",
      inputs={"image": ("IMAGE", {}), "model": ("MODEL", {}), "positive": ("CONDITIONING", {}), "negative": ("CONDITIONING", {}),
              "vae": ("VAE", {}), "bbox_detector": ("BBOX_DETECTOR", {}), **_sampler_inputs(),
              "denoise": ("FLOAT", {"default": 0.4, "min": 0.05, "max": 1, "step": 0.05,
                                    "hint": "0.3–0.5 — sharper face keeping it; higher — redraw by the prompt"}),
              "confidence": ("FLOAT", {"default": 0.3, "min": 0.05, "max": 1, "step": 0.05, "hint": "detection threshold"}),
              "dilation": ("INT", {"default": 4, "min": 0, "max": 256, "hint": "grow each found area, px"}),
              "padding": ("INT", {"default": 32, "min": 0, "max": 512, "step": 8, "hint": "context around the area, px"}),
              "resolution": ("INT", {"default": 0, "min": 0, "max": 2048, "step": 64, "hint": "0 — model native (SDXL 1024, SD1.5 640)"}),
              "feather": ("INT", {"default": 4, "min": 0, "max": 128, "hint": "soft edge of the pasted area, px"}),
              "max_count": ("INT", {"default": 0, "min": 0, "max": 50, "hint": "0 — all found, strongest first"}),
              "use_segm": ("BOOLEAN", {"default": True, "hint": "-seg models: redraw the silhouette, not the box"})},
      outputs={"image": "IMAGE", "mask": "IMAGE", "count": "INT", "seed": "INT"},
      volatile=lambda a: a.get("seed", 0) < 0,
      hint="Like ADetailer / FaceDetailer: the detector finds faces (hands, people…) and each one is redrawn at the "
           "model's native resolution, then pasted back with a soft edge. Nothing found — the image passes as is. "
           "A separate face prompt — its own CLIP Text Encode on positive.")
def detailer(image, model, positive, negative, vae, bbox_detector, seed, steps, cfg, sampler_name, scheduler, denoise,
             confidence, dilation, padding, resolution, feather, max_count, use_segm, ctx):
    seed = random.randint(0, 2**50) if seed < 0 else int(seed)
    f, m, n = R.detailer(ctx, image, model, positive, negative, vae, bbox_detector, seed, steps, cfg, sampler_name,
                         scheduler, denoise, confidence, dilation, padding, resolution, feather, max_count, use_segm)
    return {"image": {"file": f}, "mask": {"file": m}, "count": n, "seed": seed, "ui": {"images": [f]}}


@node("sd.ultimate_upscale", title="Ultimate SD Upscale", cat="Sampling",
      inputs={"image": ("IMAGE", {}), "model": ("MODEL", {}), "positive": ("CONDITIONING", {}), "negative": ("CONDITIONING", {}),
              "vae": ("VAE", {}), "upscale_model": ("UPSCALE_MODEL", {"optional": True, "hint": "none — Lanczos"}),
              "upscale_by": ("FLOAT", {"default": 2.0, "min": 1, "max": 8, "step": 0.05}), **_sampler_inputs(),
              "denoise": ("FLOAT", {"default": 0.3, "min": 0, "max": 1, "step": 0.05,
                                    "hint": "0.2–0.35 — add detail without changing the picture; 0 — upscale only"}),
              "tile_width": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 64, "hint": "SDXL 1024, SD1.5 512–768"}),
              "tile_height": ("INT", {"default": 1024, "min": 256, "max": 2048, "step": 64}),
              "tile_padding": ("INT", {"default": 32, "min": 0, "max": 256, "step": 8, "hint": "context around each tile, px"}),
              "mask_blur": ("INT", {"default": 8, "min": 0, "max": 64, "hint": "soft seams between tiles, px"})},
      outputs={"image": "IMAGE", "seed": "INT"},
      volatile=lambda a: a.get("seed", 0) < 0,
      hint="Like Ultimate SD Upscale (Linear): enlarges the image (with the upscale model or Lanczos) and redraws it "
           "tile by tile at low denoise — new detail at a size the GPU could not sample at once.")
def ultimate_upscale(image, model, positive, negative, vae, upscale_by, seed, steps, cfg, sampler_name, scheduler,
                     denoise, tile_width, tile_height, tile_padding, mask_blur, ctx, upscale_model=None):
    seed = random.randint(0, 2**50) if seed < 0 else int(seed)
    f = R.ultimate_upscale(ctx, image, model, positive, negative, vae, upscale_model, upscale_by, seed, steps, cfg,
                           sampler_name, scheduler, denoise, tile_width, tile_height, tile_padding, mask_blur)
    return {"image": {"file": f}, "seed": seed, "ui": {"images": [f]}}
