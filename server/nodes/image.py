"""Images: load from input/, save to output/, preview. IMAGE = {"file": "input|output/<name>"}."""
import base64
import json
import shutil
import time
import urllib.request

from maistep import node
from maistep import translate as T


def image_bytes(img, root):
    """(байты, mime) картинки IMAGE — для отправки в LLM и т.п."""
    p = root / img["file"]
    ext = p.suffix.lower().lstrip(".")
    return p.read_bytes(), {"jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}.get(ext, "image/png")


@node("image.load", title="Load Image", cat="Image",
      inputs={"file": ("STRING", {"default": "", "upload": "image", "hint": "file in input/ (the upload button in the Inspector)"})},
      outputs={"image": "IMAGE"})
def image_load(file, ctx):
    rel = file if file.startswith(("input/", "output/")) else f"input/{file}"
    if not file or not (ctx.root / rel).is_file():
        raise FileNotFoundError(f"no file {rel}")
    return {"file": rel}


@node("image.preview", title="Preview Image", cat="Image", output=True, inputs={"image": ("IMAGE", {})}, outputs={})
def image_preview(image):
    return {"ui": {"images": [image["file"]]}}


@node("image.save", title="Save Image", cat="Image", output=True,
      inputs={"image": ("IMAGE", {}), "prefix": ("STRING", {"default": "maistep"})}, outputs={"image": "IMAGE"})
def image_save(image, prefix, ctx):
    src = ctx.root / image["file"]
    dst = ctx.output_dir / f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}{src.suffix}"
    if src.parent != ctx.output_dir or src.name != dst.name:
        shutil.copyfile(src, dst)
    rel = dst.relative_to(ctx.root).as_posix()
    return {"image": {"file": rel}, "ui": {"images": [rel]}}


def _open(ctx, image, mode="RGB"):
    from PIL import Image
    with Image.open(ctx.root / image["file"]) as im:
        return im.convert(mode)


@node("image.fit", title="Fit Image", cat="Image",
      inputs={"image": ("IMAGE", {}),
              "megapixels": ("FLOAT", {"default": 1.0, "min": 0.1, "max": 16, "step": 0.1, "hint": "target area: ~1.0 for SDXL, ~0.3 for SD1.5"}),
              "multiple": ("INT", {"default": 64, "min": 8, "max": 256, "step": 8, "hint": "sides are rounded to this"})},
      outputs={"image": "IMAGE", "width": "INT", "height": "INT"},
      hint="Scales the image to the given area keeping the aspect ratio — before VAE Encode, so a large page "
           "doesn't overflow VRAM. The result goes to input/ (hidden from the lists).")
def image_fit(image, megapixels, multiple, ctx):
    from PIL import Image
    im = _open(ctx, image)
    k = (megapixels * 1e6 / (im.width * im.height)) ** 0.5
    w = max(multiple, round(im.width * k / multiple) * multiple)
    h = max(multiple, round(im.height * k / multiple) * multiple)
    if (w, h) != im.size:
        im = im.resize((w, h), Image.LANCZOS)
    p = ctx.input_dir / f"tocolar_fit_{time.strftime('%Y%m%d_%H%M%S')}_{w}x{h}.png"
    im.save(p)
    return {"image": {"file": p.relative_to(ctx.root).as_posix()}, "width": w, "height": h}


@node("image.keep_lines", title="Keep Lines (Recolor)", cat="Image",
      inputs={"lines": ("IMAGE", {"hint": "the original black-and-white page"}),
              "colors": ("IMAGE", {"hint": "the colored version (any size — it is stretched to the original)"}),
              "strength": ("FLOAT", {"default": 1.0, "min": 0, "max": 1.5, "step": 0.05, "hint": "color amount; >1 — more saturated"}),
              "shading": ("FLOAT", {"default": 0.6, "min": 0, "max": 1, "step": 0.05,
                                    "hint": "shadows from the generated image: 0 — flat color, 1 — all its shading (lines stay from the original)"}),
              "prefix": ("STRING", {"default": "colored"})},
      outputs={"image": "IMAGE"},
      hint="Takes lightness from the original and color from the generated image (Lab): lines, screentones and "
           "lettering stay exactly as drawn, only the color (and, with shading, its shadows) is added. Saves a PNG to output/ at the original size.")
def image_keep_lines(lines, colors, strength, shading, prefix, ctx):
    from PIL import Image, ImageChops
    base = _open(ctx, lines)
    col = _open(ctx, colors).resize(base.size, Image.LANCZOS).convert("LAB")
    L = base.convert("LAB").getchannel("L")  # светлота оригинала: линии, тон, текст
    Lg, a, b = col.split()
    if shading > 0:  # тени генерации только темнее оригинала: тёмные линии и тон не светлеют
        L = ImageChops.darker(L, Image.blend(L, Lg, shading))
    if strength != 1:
        a, b = (ch.point(lambda v: max(0, min(255, round(128 + (v - 128) * strength)))) for ch in (a, b))
    out = Image.merge("LAB", (L, a, b)).convert("RGB")
    p = ctx.output_dir / f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}.png"
    n = 1
    while p.exists():
        p, n = p.with_name(f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}-{n}.png"), n + 1
    out.save(p)
    rel = p.relative_to(ctx.root).as_posix()
    return {"image": {"file": rel}, "ui": {"images": [rel]}}


@node("image.generate_openai", title="Generate Image (OpenAI)", cat="Image",
      inputs={"prompt": ("STRING", {"multiline": True}), "model": ("STRING", {"default": "gpt-image-1"}),
              "size": (["1024x1024", "1536x1024", "1024x1536", "auto"], {}), "seed": ("INT", {"default": 0, "hint": "change it to regenerate"})},
      outputs={"image": "IMAGE"},
      hint="POST <base_url>/images/generations of the openai provider (File → LLM providers) or OPENAI_API_KEY.")
def image_generate_openai(prompt, model, size, seed, ctx):
    from maistep import providers
    prompt = T.translate(ctx, prompt)
    p = providers.provider("openai")
    base, key = (p.get("base_url") or "https://api.openai.com/v1").rstrip("/"), p.get("api_key", "")
    req = urllib.request.Request(f"{base}/images/generations", method="POST",
                                 data=json.dumps({"model": model, "prompt": prompt, "size": size, "n": 1}).encode(),
                                 headers={"content-type": "application/json", "authorization": f"Bearer {key}"})
    ctx.progress(0, 1)
    with urllib.request.urlopen(req, timeout=300) as r:
        data = json.loads(r.read())["data"][0]
    raw = base64.b64decode(data["b64_json"]) if data.get("b64_json") else urllib.request.urlopen(data["url"], timeout=120).read()
    p = ctx.output_dir / f"gen_{time.strftime('%Y%m%d_%H%M%S')}_{seed}.png"
    p.write_bytes(raw)
    ctx.progress(1, 1)
    return {"file": p.relative_to(ctx.root).as_posix()}
