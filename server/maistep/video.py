"""Видео локально: Wan 2.2 I2V A14B (два эксперта: high noise → low noise) из файлов ComfyUI.

Файлы — как в ComfyUI: UNet high/low (`*_high_noise_*`, `*_low_noise_*`, fp8 «scaled» — у каждого Linear вес
F8_E4M3 и скаляр `scale_weight`), текстовый энкодер umt5-xxl (тоже fp8 scaled), VAE `wan_2.1_vae`. Конфиги и
токенайзер — маленькие файлы репозитория Wan-AI/Wan2.2-I2V-A14B-Diffusers (кэш Hugging Face, веса не качаются).

Память — как ComfyUI на 8 ГБ: fp8 остаётся fp8 (14 ГБ на эксперта в RAM), вес Linear переводится в bf16 и
умножается на scale прямо перед умножением (`_Fp8Linear`); на GPU едет по одному блоку (group offload diffusers),
так что VRAM хватает на активации. Цикл — шаг в шаг как WanImageToVideoPipeline: эксперт high при t ≥ 900
(boundary 0.9), потом low; с lightx2v (уже вшита в *_lightx2v_4step_*) — 4 шага, cfg 1, euler, shift 5.
"""
import gc
import re
import threading
import time
from pathlib import Path

from . import diffusion as D, library as L

REPO = "Wan-AI/Wan2.2-I2V-A14B-Diffusers"
BOUNDARY = 0.9  # model_index.json репозитория: high noise — t ≥ 900
_state = {"key": None, "high": None, "low": None, "te": None, "tok": None, "vae": None, "cfg": None}
_lock = threading.RLock()


def _repo():
    """Папка конфигов и токенайзера (кэш HF; качаются только json и spiece.model)."""
    from huggingface_hub import snapshot_download
    return Path(snapshot_download(REPO, allow_patterns=["*.json", "tokenizer/*"]))


# ---------- поиск файлов в библиотеке ----------
def _items(cat):
    return [x for x in L.index()["items"] if x.get("cat") == cat]


def find(cat, name):
    """Путь модели библиотеки по имени (как в props), иначе ошибка с подсказкой."""
    for x in _items(cat) + (_items("diffusion_models") if cat == "unet" else []):
        if x.get("name") == name or Path(x.get("path", "")).name == Path(name).name:
            return Path(x["path"])
    raise FileNotFoundError(f"нет модели «{name}» в библиотеке ({cat})")


def auto():
    """Что взять, если в ноде пусто: пара high/low (лучше с вшитой lightx2v), umt5, VAE Wan 2.1."""
    unets = [x["name"] for x in _items("unet") + _items("diffusion_models") if x["name"].endswith(".safetensors")]
    i2v = [n for n in unets if re.search(r"i2v", n, re.I)]

    def pick(kind):
        c = [n for n in i2v if re.search(rf"{kind}[_ -]?noise|[_-]{kind[0]}n[_.-]|{kind}\b", n, re.I)]
        c.sort(key=lambda n: (not re.search("lightx2v|4step", n, re.I), len(n)))
        return c[0] if c else ""
    te = [x["name"] for x in _items("text_encoders") + _items("clip") if re.search("umt5", x["name"], re.I)]
    vae = [x["name"] for x in _items("vae") if re.search(r"wan_?2\.1|wan.*vae", x["name"], re.I)]
    return {"high": pick("high"), "low": pick("low"), "text_encoder": te[0] if te else "", "vae": vae[0] if vae else ""}


# ---------- fp8 ----------
def _fp8_linear(torch):
    class Fp8Linear(torch.nn.Module):
        """Linear с весом fp8 и скаляром scale (формат ComfyUI «scaled fp8»): вес переводится в dtype входа на лету."""

        def __init__(self, weight, scale, bias, dtype):
            super().__init__()
            self.in_features, self.out_features = weight.shape[1], weight.shape[0]
            self.dtype = dtype  # в чём считать, если вход пришёл в fp8 (diffusers приводит вход к dtype 1-го параметра)
            # bias — первым параметром: модули вроде time_embedder берут dtype входа из next(parameters())
            self.bias = torch.nn.Parameter(bias.to(dtype), requires_grad=False) if bias is not None else None
            self.weight = torch.nn.Parameter(weight, requires_grad=False)
            self.register_buffer("scale", (scale if scale is not None else torch.ones(())).float().reshape(()))
            self.fast = False  # _fp8_fast: умножение прямо в fp8 на тензорных ядрах (RTX 40/50)

        def forward(self, x):
            if self.fast and x.is_cuda and x.dtype == torch.bfloat16:
                # как fp8_fast в ComfyUI: вход → fp8 с масштабом по тензору, вес не разжимается
                x2 = x.reshape(-1, x.shape[-1])
                sx = (x2.abs().amax().float() / 448).clamp(min=1e-8)
                xq = (x2 / sx.to(x2.dtype)).to(torch.float8_e4m3fn)
                y = torch._scaled_mm(xq, self.weight.t(), scale_a=sx, scale_b=self.scale, bias=self.bias, out_dtype=torch.bfloat16)
                return y.reshape(*x.shape[:-1], self.out_features)
            dt = self.dtype if x.dtype.itemsize == 1 else x.dtype
            w = self.weight.to(dt) * self.scale.to(dt)
            return torch.nn.functional.linear(x.to(dt), w, self.bias.to(dt) if self.bias is not None else None)
    return Fp8Linear


def _fp8_fast(model, torch, on=True):
    """fp8-умножение там, где карта умеет (sm 8.9+: RTX 40/50) и размеры кратны 16; on=False — обратно.
    Замер (блок Wan 14B, 39 тыс. токенов, RTX 5060 Ti): 1,32 → 1,12 с, выход блока отличается на ~3 %. → слоёв."""
    ok = on and torch.cuda.is_available() and torch.cuda.get_device_capability() >= (8, 9) and hasattr(torch, "_scaled_mm")
    n = 0
    for mod in model.modules():
        if type(mod).__name__ == "Fp8Linear":
            mod.fast = bool(ok and mod.weight.dtype == torch.float8_e4m3fn and mod.in_features % 16 == 0
                            and mod.out_features % 16 == 0 and (mod.bias is None or mod.bias.dtype == torch.bfloat16))
            n += mod.fast
    return n


def _attention(torch):
    """Внимание: cuDNN первым. В сборке torch для Windows нет flash attention, а «memory efficient» на RTX 50 в 2,5 раза
    медленнее cuDNN (39 тыс. токенов: 1,60 → 0,63 с на слой, результат тот же до 0,1 %). Нет cuDNN (AMD) — следующий."""
    import contextlib
    try:
        from torch.nn.attention import sdpa_kernel, SDPBackend
        return sdpa_kernel([SDPBackend.CUDNN_ATTENTION, SDPBackend.FLASH_ATTENTION, SDPBackend.EFFICIENT_ATTENTION,
                            SDPBackend.MATH], set_priority=True)
    except (ImportError, TypeError, AttributeError):
        return contextlib.nullcontext()


def _stream(m, torch, dev):
    """umt5: слои по одному на GPU (forward-хуки), эмбеддинг остаётся в RAM. Group offload diffusers на T5 не
    сработал — энкодер целиком лёг на GPU (6,4 ГБ), и VAE с шагами уходили в системную память (9 мин вместо 11 с)."""
    if dev == "cpu":
        return

    def to(x):
        return x.to(dev) if torch.is_tensor(x) else x

    def pre(mod, args, kwargs):
        mod.to(dev)
        return tuple(to(a) for a in args), {k: to(v) for k, v in kwargs.items()}

    def post(mod, args, out):
        mod.to("cpu")
        return out
    for blk in m.encoder.block:
        blk.register_forward_pre_hook(pre, with_kwargs=True)
        blk.register_forward_hook(post)
    m.encoder.final_layer_norm.to(dev)


def _chunk_ffn(model, torch, size=8192):
    """FFN блоков — кусками по `size` токенов. Сейчас не включено: замер на блоке Wan 14B (39 тыс. токенов) — пик не
    меньше (5,0 ГБ, его держит внимание), а скорость −9 %. Результат тот же (FFN считает каждый токен отдельно)."""
    for b in getattr(model, "blocks", []):
        ff = b.ffn
        if getattr(ff, "_chunked", False):
            continue

        def fwd(x, *a, _f=ff.forward, **k):
            if x.shape[1] <= size:
                return _f(x, *a, **k)
            return torch.cat([_f(c, *a, **k) for c in x.split(size, dim=1)], dim=1)
        ff.forward, ff._chunked = fwd, True


def _fill(model, sd, torch, keep32=()):
    """Веса state dict → модель, созданная на meta: Linear с fp8 → Fp8Linear, прочее fp8 — разжать в bf16,
    float — bf16 (модули из keep32 — fp32). → (не загружено, лишнее)."""
    fp8 = {getattr(torch, n) for n in ("float8_e4m3fn", "float8_e5m2") if hasattr(torch, n)}
    scales = {k[:-len(".scale_weight")]: sd.pop(k) for k in list(sd) if k.endswith(".scale_weight")}
    for k in [k for k in sd if k.endswith((".scale_input", "scaled_fp8"))]:
        sd.pop(k)
    F8 = _fp8_linear(torch)
    for name, mod in list(model.named_modules()):
        w = sd.get(f"{name}.weight")
        if isinstance(mod, torch.nn.Linear) and w is not None and w.dtype in fp8:
            dt = torch.float32 if any(m in name for m in keep32) else torch.bfloat16
            new = F8(sd.pop(f"{name}.weight"), scales.get(name), sd.pop(f"{name}.bias", None), dt)
            parent, _, attr = name.rpartition(".")
            setattr(model.get_submodule(parent) if parent else model, attr, new)
    for k in list(sd):
        t = sd[k]
        if t.dtype in fp8:
            t = t.to(torch.bfloat16) * scales.get(k.rsplit(".", 1)[0], torch.ones(())).to(torch.bfloat16)
        if t.is_floating_point():
            t = t.to(torch.float32 if any(m in k for m in keep32) else torch.bfloat16)
        sd[k] = t
    res = model.load_state_dict(sd, strict=False, assign=True)
    left = [n for n, p in list(model.named_parameters()) + list(model.named_buffers()) if p.device.type == "meta"]
    return left, list(res.unexpected_keys)


def _load_sd(path):
    from safetensors.torch import load_file
    if str(path).lower().endswith(".gguf"):
        raise ValueError(f"{Path(path).name}: GGUF пока не поддерживается — выберите .safetensors (fp8 / bf16)")
    return load_file(str(path))


def _transformer(path, cfg_dir, torch, diffusers, ctx):
    from accelerate import init_empty_weights
    from diffusers.loaders.single_file_utils import convert_wan_transformer_to_diffusers
    cfg = diffusers.WanTransformer3DModel.load_config(str(cfg_dir))
    with init_empty_weights():
        m = diffusers.WanTransformer3DModel.from_config(cfg)
    sd = _load_sd(path)
    if any(k.endswith("comfy_quant") for k in sd):
        raise ValueError(f"{path.name}: формат comfy_quant (новый fp8 ComfyUI, как у smoothMix) пока не поддерживается — "
                         f"возьмите *_scaled_fp8_* (например, …lightx2v_4step_comfyui) или bf16")
    sd = convert_wan_transformer_to_diffusers(sd)
    left, extra = _fill(m, sd, torch, getattr(m, "_keep_in_fp32_modules", None) or ())
    if left:
        raise ValueError(f"{path.name}: не хватает весов ({len(left)}: {', '.join(left[:4])}…) — это не Wan 2.2 I2V A14B?")
    if extra:
        ctx.log(f"{path.name}: лишние ключи пропущены ({len(extra)}: {', '.join(extra[:3])}…)", "warn")
    return m.eval().requires_grad_(False)


def _text_encoder(path, repo, torch):
    import transformers
    from accelerate import init_empty_weights
    cfg = transformers.AutoConfig.from_pretrained(str(repo / "text_encoder"))
    with init_empty_weights():
        m = transformers.UMT5EncoderModel(cfg)
    sd = _load_sd(path)
    sd = {k: v for k, v in sd.items() if not k.startswith("decoder.")}  # в файле может быть и декодер T5
    if "encoder.embed_tokens.weight" not in sd and "shared.weight" in sd:
        sd["encoder.embed_tokens.weight"] = sd["shared.weight"]
    left, _ = _fill(m, sd, torch)
    if [k for k in left if "embed_tokens" not in k]:
        raise ValueError(f"{path.name}: не хватает весов umt5 ({', '.join(left[:4])}…)")
    m.encoder.embed_tokens = m.shared
    tok = transformers.AutoTokenizer.from_pretrained(str(repo / "tokenizer"))
    return m.eval().requires_grad_(False), tok


def _vae(path, repo, torch, diffusers):
    from diffusers.loaders.single_file_utils import convert_wan_vae_to_diffusers
    vae = diffusers.AutoencoderKLWan.from_config(diffusers.AutoencoderKLWan.load_config(str(repo / "vae")))
    vae.load_state_dict(convert_wan_vae_to_diffusers(_load_sd(path)))
    return vae.to(torch.bfloat16).eval().requires_grad_(False)


def _offload(m, device, torch):
    """По одному блоку на GPU (группами), остальное в RAM — 14 ГБ fp8 на 8 ГБ карте."""
    if device == "cpu":
        return
    from diffusers.hooks import apply_group_offloading
    apply_group_offloading(m, onload_device=torch.device(device), offload_device=torch.device("cpu"),
                           offload_type="block_level", num_blocks_per_group=1, use_stream=False)


def load(ctx, paths):
    """Модели Wan (кэш по путям). paths = {high, low, text_encoder, vae} — Path."""
    torch, diffusers, _ = D._packages()
    key = tuple(str(paths[k]) for k in ("high", "low", "text_encoder", "vae"))
    if _state["key"] == key:
        return _state
    unload()
    D.unload()  # SDXL из этого процесса — с GPU и из RAM: Wan нужна вся память
    device = "cuda" if torch.cuda.is_available() else "cpu"
    repo = _repo()
    t0 = time.time()
    ctx.log("Wan 2.2: загрузка high noise…")
    high = _transformer(paths["high"], repo / "transformer", torch, diffusers, ctx)
    ctx.check()
    ctx.log("Wan 2.2: загрузка low noise…")
    low = _transformer(paths["low"], repo / "transformer_2", torch, diffusers, ctx)
    ctx.check()
    ctx.log("Wan 2.2: текстовый энкодер umt5-xxl и VAE…")
    te, tok = _text_encoder(paths["text_encoder"], repo, torch)
    vae = _vae(paths["vae"], repo, torch, diffusers)
    for m in (high, low):
        _offload(m, device, torch)
    _stream(te, torch, device)
    _state.update(key=key, high=high, low=low, te=te, tok=tok, vae=vae, device=device, emb={})
    ctx.log(f"Wan 2.2 загружена за {time.time() - t0:.0f} с ({device}, fp8 → bf16 по слоям, блоки по одному на GPU)")
    return _state


def unload():
    with _lock:
        _state.update(key=None, high=None, low=None, te=None, tok=None, vae=None)
        gc.collect()
        try:
            import torch
            torch.cuda.empty_cache()
        except Exception:
            pass


# ---------- генерация ----------
def _embed(st, text, torch, device, max_len=512):
    """Как WanPipeline._get_t5_prompt_embeds: токены до 512, хвост после реальной длины — нули. Кэш по тексту (в RAM)."""
    hit = st["emb"].get(text)
    if hit is not None:
        return hit.to(device)
    ids = st["tok"]([text], padding="max_length", max_length=max_len, truncation=True, add_special_tokens=True,
                    return_attention_mask=True, return_tensors="pt")
    mask = ids.attention_mask
    with torch.no_grad():
        e = st["te"](ids.input_ids, mask).last_hidden_state  # эмбеддинг в RAM, слои сами едут на GPU (_stream)
    n = int(mask.sum())
    e = e.to(torch.bfloat16)
    out = torch.zeros(1, max_len, e.shape[-1], dtype=e.dtype, device=e.device)
    out[:, :n] = e[:, :n]
    if len(st["emb"]) > 32:
        st["emb"].clear()
    st["emb"][text] = out.cpu()
    return out.to(device)


def _scheduler(diffusers, sampler, shift):
    if sampler == "unipc":
        return diffusers.UniPCMultistepScheduler(prediction_type="flow_prediction", use_flow_sigmas=True,
                                                 flow_shift=shift, num_train_timesteps=1000)
    return diffusers.FlowMatchEulerDiscreteScheduler(num_train_timesteps=1000, shift=shift)


def _vae_dev(st, torch, fn, w, h, decode):
    """VAE на GPU на время encode/decode, потом обратно в RAM. Целиком быстрее (528×752, 97 кадров: encode 11 с /
    decode 18 с, пик 3,6 / 4,9 ГБ; тайлами 16 / 28 с, пик 1,0 / 1,5 ГБ) — тайлы, только если целиком не влезет."""
    vae, dev = st["vae"], st["device"]
    try:
        vae.to(dev)
        tiled = False
        if dev == "cuda":
            torch.cuda.empty_cache()
            need = (4.85 if decode else 3.64) * 2 ** 30 * (w * h) / (528 * 752) * 1.2 + 0.3 * 2 ** 30
            tiled = torch.cuda.mem_get_info()[0] < need
        if tiled:
            vae.enable_tiling()
        else:
            vae.disable_tiling()
        return fn(vae)
    finally:
        vae.to("cpu")
        if dev == "cuda":
            torch.cuda.empty_cache()


def i2v(ctx, paths, image_file, prompt, negative, width, height, frames, steps, cfg, shift, sampler, seed, fast=False):
    """Картинка → кадры (numpy F×H×W×3, uint8)."""
    torch, diffusers, _ = D._packages()
    from PIL import Image
    from diffusers.video_processor import VideoProcessor
    with D._lock, _lock:
        st = load(ctx, paths)
        dev = st["device"]
        vp = VideoProcessor(vae_scale_factor=8)
        ctx.log(f"Wan 2.2 I2V: {width}×{height}, {frames} кадров, {steps} шагов, cfg {cfg}, {sampler}, shift {shift}, seed {seed}")
        # текст
        t0 = time.time()
        pe = _embed(st, prompt, torch, dev)
        ne = _embed(st, negative, torch, dev) if cfg > 1 else None
        if dev == "cuda":
            torch.cuda.empty_cache()
        ctx.log(f"текст закодирован за {time.time() - t0:.1f} с")
        ctx.check()
        # латенты: шум + условие (маска первого кадра и латент картинки) — prepare_latents пайплайна
        img = Image.open(ctx.root / image_file).convert("RGB")
        image = vp.preprocess(img, height=height, width=width).to(dev, dtype=torch.float32)
        lat_f, lh, lw = (frames - 1) // 4 + 1, height // 8, width // 8
        gen = torch.Generator(device="cpu").manual_seed(int(seed))
        from diffusers.utils.torch_utils import randn_tensor
        latents = randn_tensor((1, 16, lat_f, lh, lw), generator=gen, device=torch.device(dev), dtype=torch.float32)
        vae = st["vae"]
        mean = torch.tensor(vae.config.latents_mean).view(1, 16, 1, 1, 1).to(dev, torch.float32)
        inv_std = 1.0 / torch.tensor(vae.config.latents_std).view(1, 16, 1, 1, 1).to(dev, torch.float32)
        cond_video = torch.cat([image.unsqueeze(2), image.new_zeros(1, 3, frames - 1, height, width)], dim=2)
        t0 = time.time()
        with torch.no_grad():
            lc = _vae_dev(st, torch, lambda v: v.encode(cond_video.to(dev, v.dtype)).latent_dist.mode(), width, height, False)
        lc = (lc.to(dev, torch.float32) - mean) * inv_std
        mask = torch.ones(1, 1, frames, lh, lw)
        mask[:, :, 1:] = 0
        mask = torch.cat([torch.repeat_interleave(mask[:, :, :1], 4, dim=2), mask[:, :, 1:]], dim=2)
        mask = mask.view(1, -1, 4, lh, lw).transpose(1, 2).to(dev)
        condition = torch.cat([mask, lc], dim=1)
        ctx.log(f"картинка закодирована VAE за {time.time() - t0:.1f} с")
        ctx.check()
        # шаги
        sch = _scheduler(diffusers, sampler, shift)
        sch.set_timesteps(steps, device=dev)
        bound = BOUNDARY * sch.config.num_train_timesteps
        for m in (st["high"], st["low"]):
            _fp8_fast(m, torch, fast)
        del cond_video, image
        if dev == "cuda":
            torch.cuda.empty_cache()
        t0 = time.time()
        for i, t in enumerate(sch.timesteps):
            m = st["high"] if t >= bound else st["low"]
            x = torch.cat([latents, condition], dim=1).to(torch.bfloat16)
            ts = t.expand(1)
            with torch.no_grad(), _attention(torch):
                noise = m(hidden_states=x, timestep=ts, encoder_hidden_states=pe, return_dict=False)[0]
                if ne is not None:
                    un = m(hidden_states=x, timestep=ts, encoder_hidden_states=ne, return_dict=False)[0]
                    noise = un + cfg * (noise - un)
            latents = sch.step(noise, t, latents, return_dict=False)[0]
            ctx.log(f"шаг {i + 1}/{steps} ({'high' if m is st['high'] else 'low'} noise): {time.time() - t0:.0f} с")
            if i == 0 and dev == "cuda":
                free, total = torch.cuda.mem_get_info()
                if free < 0.25 * 2 ** 30:  # на Windows нехватка VRAM не даёт ошибку, а уводит в системную память
                    ctx.log(f"видеопамять на пределе ({(total - free) / 2 ** 30:.1f} из {total / 2 ** 30:.1f} ГБ): Windows "
                            f"может считать через системную память в разы медленнее — уменьшите длину или размер, "
                            f"закройте программы, занимающие GPU", "warn")
            ctx.progress(i + 1, steps)
        # кадры
        t0 = time.time()
        lat = latents / inv_std + mean
        with torch.no_grad():
            video = _vae_dev(st, torch, lambda v: v.decode(lat.to(dev, v.dtype)).sample, width, height, True)
        out = vp.postprocess_video(video.float().cpu(), output_type="np")[0]
        ctx.log(f"кадры декодированы за {time.time() - t0:.1f} с")
        if dev == "cuda":
            torch.cuda.empty_cache()
        return (out * 255).round().clip(0, 255).astype("uint8")


def write(frames, path, fps):
    """Кадры → MP4 (H.264, yuv420p) через PyAV; стороны чётные."""
    import av
    path.parent.mkdir(parents=True, exist_ok=True)
    h, w = frames.shape[1] // 2 * 2, frames.shape[2] // 2 * 2
    with av.open(str(path), "w") as box:
        s = box.add_stream("libx264", rate=int(fps))
        s.width, s.height, s.pix_fmt = w, h, "yuv420p"
        s.options = {"crf": "18", "preset": "medium"}
        for f in frames:
            for p in s.encode(av.VideoFrame.from_ndarray(f[:h, :w], format="rgb24")):
                box.mux(p)
        for p in s.encode():
            box.mux(p)


def meta(file, fps, frames, w, h):
    return {"file": file, "fps": int(fps), "frames": int(frames), "width": int(w), "height": int(h),
            "poster": re.sub(r"\.mp4$", ".jpg", file), "last": re.sub(r"\.mp4$", "_last.png", file)}


def info():
    """Для вкладки «Видео»: что найдено в библиотеке и готово ли окружение."""
    import importlib.util as u
    return {"auto": auto(), "av": u.find_spec("av") is not None, "repo": REPO}
