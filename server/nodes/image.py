"""Images: load from input/, save to output/, preview. IMAGE = {"file": "input|output/<name>"}."""
import base64
import json
import re
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


@node("image.lineart", title="Lineart From Page", cat="Image",
      inputs={"image": ("IMAGE", {}),
              "mode": (["invert", "threshold", "edges", "as_is"], {"default": "invert",
                       "hint": "invert — a black-and-white page is already lineart: ink becomes white lines on black (what "
                               "lineart ControlNets expect); threshold — the same, binarized (drops gray tone and paper "
                               "noise); edges — lines of a color picture (difference of Gaussians: dark strokes and contours); "
                               "as_is — the image is already a hint"}),
              "threshold": ("INT", {"default": 160, "min": 1, "max": 254, "hint": "threshold: darker than this — a line"}),
              "blur": ("FLOAT", {"default": 0.0, "min": 0, "max": 4, "step": 0.1,
                                 "hint": "soften the hint, px at 1 MP: screentone dots merge into gray instead of noise"})},
      outputs={"image": "IMAGE"},
      hint="Preprocessor for lineart / manga-line ControlNets from a black-and-white page or sketch (no extra model): "
           "white lines on black, paper levels stretched. The result goes to input/ (hidden from the lists).")
def image_lineart(image, mode, threshold, blur, ctx):
    from PIL import ImageFilter, ImageOps
    im = _open(ctx, image, "L")
    if mode != "as_is":
        if blur > 0:
            im = im.filter(ImageFilter.GaussianBlur(blur * max(0.5, (im.width * im.height / 1e6) ** 0.5)))
        if mode == "threshold":
            im = im.point(lambda v: 255 if v < threshold else 0)
        elif mode == "edges":
            im = _edges(im)
        else:
            im = ImageOps.autocontrast(ImageOps.invert(im), cutoff=(1, 0.2))  # бумага → чёрный, тушь → белый
    p = ctx.input_dir / f"tocolar_lines_{time.strftime('%Y%m%d_%H%M%S')}_{im.width}x{im.height}.png"
    n = 1
    while p.exists():
        p, n = p.with_name(f"tocolar_lines_{time.strftime('%Y%m%d_%H%M%S')}-{n}_{im.width}x{im.height}.png"), n + 1
    im.convert("RGB").save(p)
    return {"file": p.relative_to(ctx.root).as_posix()}


def _edges(gray):
    """Линии цветной картинки без модели: разность гауссиан (тёмнее окрестности — штрих), как XDoG у
    аниме-препроцессоров, но проще. Белые линии на чёрном; масштаб — от 1 Мп."""
    from PIL import ImageChops, ImageFilter, ImageOps
    k = max(0.5, (gray.width * gray.height / 1e6) ** 0.5)
    fine = gray.filter(ImageFilter.GaussianBlur(0.6 * k))
    wide = gray.filter(ImageFilter.GaussianBlur(2.2 * k))
    lines = ImageChops.subtract(wide, fine, scale=1, offset=0)  # насколько пиксель темнее округи
    lines = ImageOps.autocontrast(lines, cutoff=(60, 0.3))
    return lines.point(lambda v: 0 if v < 40 else min(255, int((v - 40) * 1.6)))


@node("image.keep_lines", title="Keep Lines (Recolor)", cat="Image",
      inputs={"lines": ("IMAGE", {"hint": "the original black-and-white page"}),
              "colors": ("IMAGE", {"hint": "the colored version (any size — it is stretched to the original)"}),
              "strength": ("FLOAT", {"default": 1.0, "min": 0, "max": 1.6, "step": 0.05, "hint": "color amount; >1 — more saturated"}),
              "shading": ("FLOAT", {"default": 0.6, "min": 0, "max": 1, "step": 0.05,
                                    "hint": "shadows from the generated image: 0 — flat color, 1 — all its shading (lines stay from the original)"}),
              "smooth": ("INT", {"default": 5, "min": 0, "max": 32, "hint": "chroma smoothing, px at 1 MP: color regions blend, "
                                                                           "speckles and misaligned details fade; 0 — as generated"}),
              "balance": ("BOOLEAN", {"default": True, "hint": "boost faint colors of the generation to a readable saturation"}),
              "prefix": ("STRING", {"default": "colored"})},
      outputs={"image": "IMAGE"},
      hint="Takes lightness from the original and color from the generated image (Lab): lines, screentones and "
           "lettering stay exactly as drawn, only the color (and, with shading, its shadows) is added. Chroma is smoothed "
           "and faint colors are balanced, so a shy generation still gives a colored page. Saves a PNG to output/ at the original size.")
def image_keep_lines(lines, colors, strength, shading, prefix, ctx, smooth=5, balance=True):
    from PIL import Image, ImageChops, ImageFilter
    base = _open(ctx, lines)
    W, H = base.size
    col = _open(ctx, colors).resize((W, H), Image.LANCZOS).convert("LAB")
    L = base.convert("LAB").getchannel("L")  # светлота оригинала: линии, тон, текст
    Lg, a, b = col.split()
    if shading > 0:  # тени генерации только темнее оригинала: тёмные линии и тон не светлеют
        lg = Lg.filter(ImageFilter.GaussianBlur(1.0 * max(0.5, (W * H / 1e6) ** 0.5)))  # своя штриховка генерации не задваивает линии
        L = ImageChops.darker(L, Image.blend(L, lg, shading))
    _gain, a, b = _chroma_gain(a, b, smooth, balance)
    if abs(strength - 1) > 0.001:  # насыщенность — вокруг нейтрального, поверх авто-баланса
        lut = [max(0, min(255, round(128 + (v - 128) * strength))) for v in range(256)]
        a, b = a.point(lut), b.point(lut)
    out = Image.merge("LAB", (L, a, b)).convert("RGB")
    prefix = re.sub(r"[^\w.-]+", "_", prefix or "colored").lstrip(".")[:60] or "colored"
    p = ctx.output_dir / f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}.png"
    n = 1
    while p.exists():
        p, n = p.with_name(f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}-{n}.png"), n + 1
    out.save(p)
    rel = p.relative_to(ctx.root).as_posix()
    return {"image": {"file": rel}, "ui": {"images": [rel]}}


def _pct(ch, p):
    """Перцентиль яркости канала по гистограмме (без NumPy)."""
    h = ch.histogram()
    total = sum(h)
    if not total:
        return 128
    acc, target = 0, total * p
    for i, c in enumerate(h):
        acc += c
        if acc >= target:
            return i
    return 255


def _chroma_gain(a, b, smooth, balance):
    """Сглаживает цвет (крупные области, без крапа и цветного шума) и считает множитель для бледного цвета.
    Работаем не больше ~2 Мп: размытие дешевле, и шум не размазывается по всей странице."""
    from PIL import Image, ImageFilter
    W, H = a.size
    k = (W * H / 1e6) ** 0.5          # 1 px при 1 Мп = k px здесь
    radius = max(0.0, float(smooth)) * k
    s = min(1.0, (2_000_000 / (W * H)) ** 0.5)
    w2, h2 = max(1, round(W * s)), max(1, round(H * s))
    aw = a.resize((w2, h2), Image.BOX) if (w2, h2) != (W, H) else a.copy()
    bw = b.resize((w2, h2), Image.BOX) if (w2, h2) != (W, H) else b.copy()
    if radius * s >= 0.3:
        r = radius * s
        aw = aw.filter(ImageFilter.GaussianBlur(r))
        bw = bw.filter(ImageFilter.GaussianBlur(r))
    gain = 1.0
    if balance:
        # баланс — вокруг медианы страницы (обычно это бумага): общий цветовой оттенок генерации не раздуваем,
        # подтягиваем только отклонения от него, т.е. сами цветные области
        ma, mb = _pct(aw, 0.5), _pct(bw, 0.5)
        dev = max(_pct(aw, 0.99) - ma, ma - _pct(aw, 0.01),
                  _pct(bw, 0.99) - mb, mb - _pct(bw, 0.01))
        gain = min(3.0, max(1.0, 30.0 / max(dev, 1.0)))  # сильный цвет не трогаем, бледный подтягиваем
        if gain > 1.001:
            aw = aw.point([max(0, min(255, round(128 + (ma - 128) + (v - ma) * gain))) for v in range(256)])
            bw = bw.point([max(0, min(255, round(128 + (mb - 128) + (v - mb) * gain))) for v in range(256)])
    if (w2, h2) != (W, H):  # цвет — низкочастотный, обратно бикубически
        aw = aw.resize((W, H), Image.BICUBIC)
        bw = bw.resize((W, H), Image.BICUBIC)
    return gain, aw, bw


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
