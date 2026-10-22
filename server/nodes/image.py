"""Картинки: загрузка из input/, сохранение в output/, превью. IMAGE = {"file": "input|output/<имя>"}."""
import base64
import json
import shutil
import time
import urllib.request

from maistep import node


def image_bytes(img, root):
    """(байты, mime) картинки IMAGE — для отправки в LLM и т.п."""
    p = root / img["file"]
    ext = p.suffix.lower().lstrip(".")
    return p.read_bytes(), {"jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}.get(ext, "image/png")


@node("image.load", title="Загрузить картинку", cat="Картинки",
      inputs={"file": ("STRING", {"default": "", "upload": "image", "hint": "файл в input/ (кнопка «Загрузить…» в Inspector)"})},
      outputs={"image": "IMAGE"})
def image_load(file, ctx):
    rel = file if file.startswith(("input/", "output/")) else f"input/{file}"
    if not file or not (ctx.root / rel).is_file():
        raise FileNotFoundError(f"нет файла {rel}")
    return {"file": rel}


@node("image.preview", title="Превью картинки", cat="Картинки", output=True, inputs={"image": ("IMAGE", {})}, outputs={})
def image_preview(image):
    return {"ui": {"images": [image["file"]]}}


@node("image.save", title="Сохранить картинку", cat="Картинки", output=True,
      inputs={"image": ("IMAGE", {}), "prefix": ("STRING", {"default": "maistep"})}, outputs={"image": "IMAGE"})
def image_save(image, prefix, ctx):
    src = ctx.root / image["file"]
    dst = ctx.output_dir / f"{prefix}_{time.strftime('%Y%m%d_%H%M%S')}{src.suffix}"
    if src.parent != ctx.output_dir or src.name != dst.name:
        shutil.copyfile(src, dst)
    rel = dst.relative_to(ctx.root).as_posix()
    return {"image": {"file": rel}, "ui": {"images": [rel]}}


@node("image.generate_openai", title="Генерация (OpenAI Images)", cat="Картинки",
      inputs={"prompt": ("STRING", {"multiline": True}), "model": ("STRING", {"default": "gpt-image-1"}),
              "size": (["1024x1024", "1536x1024", "1024x1536", "auto"], {}), "seed": ("INT", {"default": 0, "hint": "меняйте, чтобы перегенерировать"})},
      outputs={"image": "IMAGE"},
      hint="POST <base_url>/images/generations провайдера openai (Настройки → Провайдеры) или OPENAI_API_KEY.")
def image_generate_openai(prompt, model, size, seed, ctx):
    from maistep import providers
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
