"""Доработка готовой картинки, как в ComfyUI/A1111: апскейл моделью (ESRGAN, 4x-UltraSharp, DAT, SwinIR… — пакет
spandrel), поиск лиц/рук детектором YOLO (ultralytics; модели ADetailer из models/ultralytics) и перерисовка найденного
(Face Detailer = ADetailer), тайловый апскейл с перерисовкой (Ultimate SD Upscale). Перерисовка — diffusion.redraw
(то же ядро, что у Inpaint Region): область вырезается, сэмплится на родном разрешении модели и вклеивается обратно.
Пакеты — необязательные компоненты (Компоненты → Генерация): без них ноды сообщают, что поставить."""
import math
import os
import time

from . import diffusion as D
from . import logs

ROOT = D.ROOT
UPSCALE_TILE = 512


class UpscaleModel:
    """UPSCALE_MODEL: путь к файлу модели апскейла (веса грузятся при первом использовании)."""
    def __init__(self, path):
        self.path = str(path)

    def __repr__(self):
        return os.path.basename(self.path)


class Detector(UpscaleModel):
    """BBOX_DETECTOR: путь к модели YOLO (bbox/…, segm/… — у -seg моделей есть маска силуэта)."""


def _need(pkg, comp):
    try:
        return __import__(pkg)
    except ImportError:
        raise D.NotInstalled(f"нужен пакет {comp}: Компоненты → «{comp}» → Установить (или «Установить недостающее»)") from None


# ---------- апскейл моделью ----------
_up = {}     # путь → дескриптор spandrel (один, на CPU между запусками)
_peak = {}   # (путь, тайл, dtype) → замер пика VRAM


def _upscaler(path):
    _need("spandrel", "spandrel")
    from spandrel import ImageModelDescriptor, ModelLoader
    m = _up.get(path)
    if m is None:
        m = ModelLoader().load_from_file(path)
        if not isinstance(m, ImageModelDescriptor):
            raise ValueError(f"{os.path.basename(path)}: это не модель апскейла картинок")
        m.eval()
        _up.clear()
        _up[path] = m
    return m


def _tiled(torch, m, x, tile, overlap=32):
    """Модель по тайлам с перекрытием и линейной смесью на стыках (как tiled_scale в ComfyUI)."""
    s = m.scale
    _, _, H, W = x.shape
    out = torch.zeros((1, 3, H * s, W * s))
    acc = torch.zeros((1, 1, H * s, W * s))
    step = max(1, tile - overlap)
    ys = sorted({min(y, max(0, H - tile)) for y in range(0, H, step)})
    xs = sorted({min(v, max(0, W - tile)) for v in range(0, W, step)})
    dev, dtype = next(m.model.parameters()).device, next(m.model.parameters()).dtype
    o = overlap * s
    for y in ys:
        for x0 in xs:
            t = x[..., y:y + tile, x0:x0 + tile]
            r = m(t.to(dev, dtype)).float().cpu()
            h, w = r.shape[-2:]
            wt = torch.ones((1, 1, h, w))
            if o:
                ramp = torch.linspace(1 / o, 1, o)
                if y:
                    wt[..., :o, :] *= ramp.view(-1, 1)
                if y + tile < H:
                    wt[..., -o:, :] *= ramp.flip(0).view(-1, 1)
                if x0:
                    wt[..., :, :o] *= ramp.view(1, -1)
                if x0 + tile < W:
                    wt[..., :, -o:] *= ramp.flip(0).view(1, -1)
            out[..., y * s:y * s + h, x0 * s:x0 * s + w] += r * wt
            acc[..., y * s:y * s + h, x0 * s:x0 * s + w] += wt
    return out / acc.clamp_min(1e-6)


def upscale_pil(ctx, path, pil):
    """PIL → PIL, увеличенная моделью (×2/×4 — сколько умеет модель). На 8 ГБ, если места под тайлы нет, UNet
    уходит в RAM на время апскейла (вернётся перед следующим сэмплингом), как при VAE Decode."""
    torch, _diffusers, Image = D._packages()
    import numpy as np
    with D._lock:
        m = _upscaler(path)
        cuda = torch.cuda.is_available()
        dev = "cuda" if cuda else "cpu"
        half = cuda and m.supports_half
        dtype = torch.float16 if half else torch.float32
        tile = UPSCALE_TILE
        params = sum(p.numel() for p in m.model.parameters()) * (2 if half else 4)
        if cuda:
            need = _peak.get((path, tile, str(dtype))) or int(1.6 * 2**30 * (tile / 512) ** 2 * m.scale / 4) + params
            if D._free(torch, dev) < need:
                torch.cuda.empty_cache()
                D._unet_to(torch, "cpu")
                if ctx:
                    ctx.log("upscale: мало места — на время апскейла освобождаю UNet (вернётся перед сэмплингом)")
        m.to(dev)
        m.half() if half else m.float()
        x = torch.from_numpy(np.asarray(pil.convert("RGB")).copy()).permute(2, 0, 1)[None].float() / 255.0
        t0 = time.time()
        logs.watchdog(D.STALL)
        try:
            while True:
                try:
                    if cuda:
                        torch.cuda.reset_peak_memory_stats(dev)
                        base = torch.cuda.memory_allocated(dev)
                    with torch.inference_mode():
                        y = _tiled(torch, m, x, tile)
                    if cuda:
                        _peak[(path, tile, str(dtype))] = torch.cuda.max_memory_allocated(dev) - base + params
                    break
                except Exception as e:
                    if not D._is_oom(torch, e) or tile <= 128:
                        raise
                    tile //= 2
                    torch.cuda.empty_cache()
                    if ctx:
                        ctx.log(f"upscale: не влезло — тайл {tile}px")
        finally:
            logs.stop_watchdog()
            m.to("cpu")
            if cuda:
                torch.cuda.empty_cache()
    if ctx:
        ctx.log(f"upscale ×{m.scale} {os.path.basename(path)}: {pil.width}×{pil.height} → {y.shape[-1]}×{y.shape[-2]}, "
                f"{time.time() - t0:.1f} s")
    arr = (y[0].permute(1, 2, 0).clamp(0, 1) * 255).round().to(torch.uint8).numpy()
    return Image.fromarray(arr)


def resize_to(pil, w, h, method="lanczos"):
    from PIL import Image
    f = {"nearest-exact": Image.NEAREST, "nearest": Image.NEAREST, "bilinear": Image.BILINEAR, "area": Image.BOX,
         "bicubic": Image.BICUBIC, "lanczos": Image.LANCZOS}.get(method, Image.LANCZOS)
    return pil if pil.size == (w, h) else pil.resize((max(1, int(w)), max(1, int(h))), f)


def upscale_to(ctx, path, pil, w, h):
    """Моделью (если задана) — пока не станет не меньше цели, затем точно до w×h (как hires в A1111)."""
    for _ in range(3):
        if not path or (pil.width >= w and pil.height >= h):
            break
        pil = upscale_pil(ctx, path, pil)
    return resize_to(pil, w, h)


# ---------- детектор ----------
_det = {}


def detect(path, pil, confidence):
    """[(рамка (x0, y0, x1, y1), уверенность, контур [(x, y)…] или None)] — сильнее первыми. На CPU: YOLO n/m на
    картинке ~1 МП — доли секунды, а VRAM остаётся SD."""
    os.environ.setdefault("YOLO_CONFIG_DIR", str(ROOT / "user" / "ultralytics"))
    os.environ.setdefault("YOLO_OFFLINE", "1")
    _need("ultralytics", "ultralytics")
    from ultralytics import YOLO
    m = _det.get(path)
    if m is None:
        m = YOLO(path)
        _det.clear()
        _det[path] = m
    r = m.predict(pil.convert("RGB"), conf=float(confidence), device="cpu", verbose=False)[0]
    boxes, confs = r.boxes.xyxy.tolist(), r.boxes.conf.tolist()
    polys = [p.tolist() for p in r.masks.xy] if r.masks is not None else [None] * len(boxes)
    found = [(tuple(b), c, [tuple(pt) for pt in p] if p is not None and len(p) > 2 else None) for b, c, p in zip(boxes, confs, polys)]
    return sorted(found, key=lambda f: -f[1])


def _mask(size, det, dilation, use_segm):
    """Маска одной находки: контур (у -seg моделей) или прямоугольник, расширенная на dilation px."""
    from PIL import Image, ImageDraw, ImageFilter
    (x0, y0, x1, y1), _c, poly = det
    m = Image.new("L", size, 0)
    d = ImageDraw.Draw(m)
    if use_segm and poly:
        d.polygon(poly, fill=255)
        if dilation > 0:
            m = m.filter(ImageFilter.GaussianBlur(dilation / 2)).point(lambda v: 255 if v > 8 else 0)
    else:
        k = max(0, int(dilation))
        d.rectangle([x0 - k, y0 - k, x1 + k, y1 + k], fill=255)
    return m


def detailer(ctx, image, model, positive, negative, vae, detector, seed, steps, cfg, sampler, scheduler, denoise,
             confidence=0.3, dilation=4, padding=32, resolution=0, feather=4, max_count=0, use_segm=True):
    """Face Detailer / ADetailer: детектор находит лица (руки, людей…), каждое перерисовывается отдельно на родном
    разрешении модели (seed, seed+1, …) — на уже изменённой картинке. Ничего не нашлось — картинка как есть.
    Возвращает (файл, маска всех находок, сколько найдено)."""
    _torch, _diffusers, Image = D._packages()
    root = ctx.root if ctx else ROOT
    with Image.open(root / image["file"]) as im:
        cur = im.convert("RGB")
    found = detect(detector.path, cur, confidence)
    if max_count:
        found = found[:int(max_count)]
    union = Image.new("L", cur.size, 0)
    if ctx:
        ctx.log(f"detailer: {os.path.basename(detector.path)} — найдено {len(found)}"
                + (f" (уверенность {', '.join(f'{f[1]:.2f}' for f in found)})" if found else ""))
    for i, det in enumerate(found):
        if ctx:
            ctx.check()
            ctx.progress(i, len(found))
        msk = _mask(cur.size, det, dilation, use_segm)
        union.paste(255, mask=msk)
        gen, paste, crop, _box = D.redraw(ctx, model, positive, negative, vae, cur, msk, int(seed) + i, steps, cfg,
                                          sampler, scheduler, denoise, True, padding, resolution, feather)
        cur = D.paste_area(cur, gen, paste, crop)
    files = D.save_pils(ctx, [cur, union.convert("RGB")], "detailer", int(seed), temp=True)
    return files[0], files[1], len(found)


# ---------- Ultimate SD Upscale ----------
def ultimate_upscale(ctx, image, model, positive, negative, vae, upscale_model, upscale_by, seed, steps, cfg, sampler,
                     scheduler, denoise, tile_width=1024, tile_height=1024, tile_padding=32, mask_blur=8):
    """Как Ultimate SD Upscale (режим Linear): картинка увеличивается (моделью или Lanczos) в upscale_by раз и
    перерисовывается тайлами по строкам с небольшой силой — детали дорисовываются, а памяти нужно как на один тайл."""
    _torch, _diffusers, Image = D._packages()
    root = ctx.root if ctx else ROOT
    with Image.open(root / image["file"]) as im:
        src = im.convert("RGB")
    W, H = (max(8, int(round(v * float(upscale_by) / 8)) * 8) for v in src.size)
    cur = upscale_to(ctx, upscale_model.path if upscale_model else None, src, W, H)
    # тайлы одинаковые (как force_uniform_tiles): сетка по заданному размеру, сторона — поровну; иначе крайняя полоса
    # в 200 px растягивалась до 2000 и модель дорисовывала в ней лишнее
    cols, rows = math.ceil(W / int(tile_width)), math.ceil(H / int(tile_height))
    tw, th = math.ceil(W / cols / 8) * 8, math.ceil(H / rows / 8) * 8
    res = int(round(math.sqrt(int(tile_width) * int(tile_height))))
    if ctx:
        ctx.log(f"ultimate upscale: {src.width}×{src.height} → {W}×{H}, тайлы {cols}×{rows} по {tw}×{th}, denoise {denoise}")
    if denoise > 0:
        n = 0
        for r in range(rows):
            for c in range(cols):
                if ctx:
                    ctx.check()
                    ctx.progress(n, cols * rows)
                n += 1
                msk = Image.new("L", cur.size, 0)
                msk.paste(255, (c * tw, r * th, min(W, (c + 1) * tw), min(H, (r + 1) * th)))
                gen, paste, crop, _box = D.redraw(ctx, model, positive, negative, vae, cur, msk, int(seed), steps, cfg,
                                                  sampler, scheduler, denoise, True, tile_padding, res, mask_blur)
                cur = D.paste_area(cur, gen, paste, crop)
    return D.save_pils(ctx, [cur], "usdu", int(seed), temp=True)[0]
