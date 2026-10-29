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
    from maistep import outputs
    rel = outputs.resolve(ctx.root, file if file.startswith(("input/", "output/", "temp/")) else f"input/{file}")  # перенесённый результат
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


def _walls(lum, k, level=20):
    """Границы областей страницы: штрих — то, что заметно темнее своей округи (тонкие серые линии тоже), плюс
    сплошная тушь. Скринтон и серый тон почти равны округе — не режут области на крошки; пылинки и обрывки
    меньше ~3×3 px при 1 Мп выкидываются. Щели в 1 px между штрихами закрываются."""
    import numpy as np
    from scipy import ndimage as nd
    lum = lum.astype(np.float32)
    inv = 255 - lum
    line = (inv - nd.gaussian_filter(inv, 2.5 * k)) > level
    lab, n = nd.label(line)
    if n:
        keep = np.bincount(lab.ravel(), minlength=n + 1) >= max(6, 8 * k * k)
        keep[0] = False
        line = keep[lab]
    return nd.binary_dilation(line | (lum < 70), iterations=max(1, round(0.75 * k)))


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
              "regions": ("BOOLEAN", {"default": True, "hint": "flat color per region: the original's lines split the page into "
                                                             "areas, each takes one color of the generation — color never crosses "
                                                             "a line; off — smoothed color pixel by pixel"}),
              "hints": ("IMAGE", {"optional": True, "hint": "color hints (RGBA, page size): a stroke recolors the whole area "
                                                            "between the lines it touches; big areas — around the stroke"}),
              "prefix": ("STRING", {"default": "colored"})},
      outputs={"image": "IMAGE"},
      hint="Takes lightness from the original and color from the generated image (Lab): lines, screentones and "
           "lettering stay exactly as drawn, only the color (and, with shading, its shadows) is added. Chroma is smoothed "
           "and faint colors are balanced, so a shy generation still gives a colored page. The generation's overall tint "
           "(a bluish or yellow page) is removed. Saves a PNG to output/ at the original size.")
def image_keep_lines(lines, colors, strength, shading, prefix, ctx, smooth=5, balance=True, regions=True, hints=None):
    from PIL import Image, ImageChops, ImageFilter
    base = _open(ctx, lines)
    W, H = base.size
    col = _open(ctx, colors).resize((W, H), Image.LANCZOS).convert("LAB")
    L = L0 = base.convert("LAB").getchannel("L")  # светлота оригинала: линии, тон, текст
    Lg, a, b = col.split()
    a, b = _white_balance(Lg, a, b)
    if shading > 0:  # тени генерации только темнее оригинала: тёмные линии и тон не светлеют
        lg = Lg.filter(ImageFilter.GaussianBlur(1.0 * max(0.5, (W * H / 1e6) ** 0.5)))  # своя штриховка генерации не задваивает линии
        L = ImageChops.darker(L, Image.blend(L, lg, shading))
    flat = _region_chroma(L0, a, b, smooth) if regions else None
    if flat:
        a, b, paper = flat
        if paper is not None:  # поля листа — светлота оригинала, без теней генерации
            L = Image.composite(L0, L, paper)
        if balance:
            a, b = _boost(a, b)
    else:
        _gain, a, b = _chroma_gain(a, b, smooth, balance)
    if abs(strength - 1) > 0.001:  # насыщенность — вокруг нейтрального, поверх авто-баланса
        lut = [max(0, min(255, round(128 + (v - 128) * strength))) for v in range(256)]
        a, b = a.point(lut), b.point(lut)
    if hints and hints.get("file"):
        hint = _open(ctx, hints, "RGBA")
        a, b = _apply_hints(L0, a, b, hint.resize((W, H), Image.NEAREST) if hint.size != (W, H) else hint)
    out = Image.merge("LAB", (L, a, b)).convert("RGB")
    prefix = re.sub(r"[^\w.-]+", "_", prefix or "colored").lstrip(".")[:60] or "colored"
    p = ctx.output_dir / f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}.png"
    n = 1
    while p.exists():
        p, n = p.with_name(f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}-{n}.png"), n + 1
    out.save(p, pnginfo=ctx.pnginfo())
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


def _white_balance(Lg, a, b, amount=0.85, cap=25):
    """Общий оттенок генерации (вся страница синеватая / жёлтая) → нейтраль: самые светлые места генерации —
    блики, бумага, баблы — должны быть белыми. Сдвигаем a/b на их медианный оттенок (с потолком)."""
    try:
        import numpy as np
    except ImportError:
        return a, b
    lg = np.asarray(Lg)
    top = lg >= np.percentile(lg, 85)
    if top.sum() < 100:
        return a, b
    out = []
    for ch in (a, b):
        v = np.asarray(ch).astype(np.int16)
        shift = float(np.clip(np.median(v[top]) - 128, -cap, cap)) * amount
        out.append(_img(np.clip(v - round(shift), 0, 255)))
    return out[0], out[1]


def _img(arr):
    from PIL import Image
    import numpy as np
    return Image.fromarray(np.asarray(arr, dtype=np.uint8), "L")


def _region_chroma(L0, a, b, smooth):
    """Цвет по областям, как заливка флэтов: линии оригинала делят страницу на области, каждая получает один цвет —
    медиану цвета генерации внутри неё. Цвет не заходит за линии, крап и сдвиг контуров генерации не дают пятен.
    Крупные области и пёстрые (линии не замкнулись, фон с переходами) — сглаженный цвет генерации, как раньше.
    Нужны numpy и scipy (идут с torch/torchsde); без них — None и прежний путь."""
    try:
        import numpy as np
        from scipy import ndimage as nd
    except ImportError:
        return None
    from PIL import Image
    W, H = L0.size
    s = min(1.0, (2_000_000 / (W * H)) ** 0.5)  # считаем не больше ~2 Мп
    w2, h2 = max(1, round(W * s)), max(1, round(H * s))
    k = max(0.5, (w2 * h2 / 1e6) ** 0.5)  # 1 px при 1 Мп
    lum = np.asarray(L0.resize((w2, h2), Image.BOX) if s < 1 else L0)
    ca = np.asarray(a.resize((w2, h2), Image.BOX) if s < 1 else a).astype(np.float32) - 128
    cb = np.asarray(b.resize((w2, h2), Image.BOX) if s < 1 else b).astype(np.float32) - 128
    wall = _walls(lum, k)
    lab, n = nd.label(~wall)
    if n == 0:
        return None
    area = np.bincount(lab.ravel(), minlength=n + 1)
    tiny = area < max(24, 50 * k * k)
    tiny[0] = True
    lab[tiny[lab]] = 0
    if not lab.any():
        return None
    # линии и крошки достаются ближайшей области — цвет у штриха тот же, что по обе стороны
    idx = nd.distance_transform_edt(lab == 0, return_distances=False, return_indices=True)
    full = lab[tuple(idx)]
    vote = np.where(wall, 0, full)  # голосуют только пиксели внутри областей, не на линиях
    ids = np.unique(full)
    ma = np.zeros(n + 1, np.float32)
    mb = np.zeros(n + 1, np.float32)
    ma[ids] = nd.median(ca, vote, ids)
    mb[ids] = nd.median(cb, vote, ids)
    ma, mb = np.nan_to_num(ma), np.nan_to_num(mb)
    # согласие: доля пикселей области с цветом рядом с её медианой
    agree = np.ones(n + 1, np.float32)
    near = (np.hypot(ca - ma[full], cb - mb[full]) < 12).astype(np.float32)
    agree[ids] = nd.mean(near, vote, ids)
    area = np.bincount(full.ravel(), minlength=n + 1)
    # одной заливкой — только небольшие замкнутые области, где почти все согласны с медианой (глаза, бабл, галстук,
    # пенал); крупные на настоящих страницах обычно слиты через щель в линиях (волосы + фон, рукав + стена) — там
    # одна медиана красит пол-панели чужим цветом, поэтому им сглаженный цвет генерации попиксельно, как раньше
    flat = ((area <= 0.03 * w2 * h2) & (np.nan_to_num(agree) >= 0.55))[full]
    r = max(1.0, float(smooth) * k)
    fa = np.where(flat, ma[full], nd.gaussian_filter(ca, r))
    fb = np.where(flat, mb[full], nd.gaussian_filter(cb, r))
    # поля листа вокруг панелей: пустая бумага (белая вместе с округой), связанная с краем страницы, — её не красим.
    # Через щель в рамке панели «пустота» не просачивается, в отличие от областей
    rr = max(2, round(5 * k))
    blank = nd.minimum_filter(lum, size=2 * rr + 1) > 235
    bl, bn = nd.label(blank)
    paper = None
    if bn:
        side = np.unique(np.concatenate([bl[0], bl[-1], bl[:, 0], bl[:, -1]]))
        side = side[side > 0]
        sizes = np.bincount(bl.ravel(), minlength=bn + 1)
        side = side[sizes[side] > 0.01 * w2 * h2]
        if side.size:
            paper = nd.binary_dilation(np.isin(bl, side), iterations=rr + max(1, round(2 * k)))  # до рамки панели
            fa[paper], fb[paper] = 0, 0
    # шов между областями — на линии (она тёмная, цвет там почти не виден); лёгкое смягчение против лесенки
    fa, fb = nd.gaussian_filter(fa, 0.6 * k), nd.gaussian_filter(fb, 0.6 * k)
    out = []
    for ch in (fa, fb):
        im = _img(np.clip(np.rint(ch + 128), 0, 255))
        out.append(im.resize((W, H), Image.BICUBIC) if s < 1 else im)
    if paper is not None:
        pm = _img(paper * 255)
        out.append(pm.resize((W, H), Image.NEAREST) if s < 1 else pm)
    else:
        out.append(None)
    return out[0], out[1], out[2]


def _apply_hints(L0, a, b, hint):
    """Подсказки цвета поверх раскраски, как заливка ведром во флэтах: штрих кисти перекрашивает всю область между
    линиями оригинала, которой касается: до 25 % страницы — целиком, крупнее (фон, слитое через щель) — в 120 px
    вокруг штриха. В одной области несколько цветов делят её по ближайшему штриху. Светлота не меняется: линии, тон
    и тени остаются. Нужны numpy и scipy."""
    try:
        import numpy as np
        from scipy import ndimage as nd
    except ImportError:
        return a, b
    from PIL import Image
    W, H = L0.size
    s = min(1.0, (2_000_000 / (W * H)) ** 0.5)
    w2, h2 = max(1, round(W * s)), max(1, round(H * s))
    k = max(0.5, (w2 * h2 / 1e6) ** 0.5)
    small = (lambda im, f=Image.BOX: im.resize((w2, h2), f)) if s < 1 else (lambda im, f=None: im)
    stroke = np.asarray(small(hint.getchannel("A"), Image.NEAREST)) > 127
    if not stroke.any():
        return a, b
    hl = small(hint.convert("RGB"), Image.NEAREST).convert("LAB")
    ha, hb = (np.asarray(c).astype(np.float32) for c in hl.split()[1:])
    lum = np.asarray(small(L0))
    wall = _walls(lum, k)
    lab, n = nd.label(~wall)
    idx = nd.distance_transform_edt(lab == 0, return_distances=False, return_indices=True)
    full = lab[tuple(idx)]  # линии — ближайшей области
    touched = np.unique(full[stroke])
    touched = touched[touched > 0]
    if not touched.size:
        return a, b
    # цвет каждого пикселя — ближайшего штриха
    dist, near = nd.distance_transform_edt(~stroke, return_indices=True)
    ca, cb = ha[tuple(near)], hb[tuple(near)]
    area = np.bincount(full.ravel(), minlength=n + 1)
    big = area > 0.25 * w2 * h2
    m = np.isin(full, touched)
    m &= ~big[full] | (dist <= 120 * k)  # крупная область (фон, слитые через щель) — только около штриха
    m = nd.gaussian_filter(m.astype(np.float32), 0.8 * k)
    out = []
    for ch, cc in ((a, ca), (b, cb)):
        mm, cv = _img(np.clip(m * 255, 0, 255)), _img(np.clip(cc, 0, 255))
        if s < 1:
            mm, cv = mm.resize((W, H), Image.BICUBIC), cv.resize((W, H), Image.NEAREST)
        out.append(Image.composite(cv, ch, mm))
    return out[0], out[1]


def _boost(a, b, target=30.0, most=2.5):
    """Бледная генерация → читаемая насыщенность (вокруг нейтрали: оттенок уже снят), сильный цвет не трогаем."""
    import numpy as np
    ca = np.asarray(a).astype(np.float32) - 128
    cb = np.asarray(b).astype(np.float32) - 128
    c = np.hypot(ca, cb)
    dev = float(np.percentile(c, 98))
    gain = min(most, max(1.0, target / max(dev, 1.0)))
    if gain <= 1.001:
        return a, b
    return _img(np.clip(np.rint(ca * gain + 128), 0, 255)), _img(np.clip(np.rint(cb * gain + 128), 0, 255))


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
