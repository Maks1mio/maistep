"""Дополнительные инструменты AI Agent: генерация и правка картинок, интернет, файлы приложения, персонажи.

Генерация — тот же путь, что у ImageNaizer: скрытый граф Load Checkpoint → (LoRA) → CLIP Skip → CLIP Text Encode ×2 →
Canvas Generate в общей очереди. Пустая прозрачная рамка — txt2img, фото — img2img, фото + маска — inpaint.
Параметры сэмплера — из рекомендации Magic под чекпоинт (как в ImageNaizer).
Файлы (режим Code) — только в папках, выданных диалогу (Access), без .git/.venv и файлов с ключами.
Персонажи (режим RP) — user/characters/<id>.json.
"""
import html
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

from . import magic
from .registry import NODES

ROOT = Path(__file__).resolve().parents[2]
CHARS = ROOT / "user" / "characters"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36"
# user_agent инструментов веба: desktop | mobile | bot | своя строка
UAS = {"desktop": UA,
       "mobile": "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36",
       "iphone": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
       "bot": "maistep-agent/1.0 (+local)"}


def ua_of(v):
    v = str(v or "desktop").strip()
    return UAS.get(v.lower(), v if len(v) > 12 else UA)


# ---------- генерация ----------
def default_ckpt():
    d = NODES.get("sd.checkpoint")
    return (d.inputs["ckpt_name"][1].get("default") if d else "") or ""


def _png(name, w, h, rects=None):
    """Прозрачная рамка (rects=None) или маска: белые прямоугольники в долях 0..1 на чёрном."""
    from PIL import Image, ImageDraw
    if rects is None:
        im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    else:
        im = Image.new("L", (w, h), 0)
        d = ImageDraw.Draw(im)
        for r in rects:
            x, y, rw, rh = (float(r.get(k, 0)) for k in ("x", "y", "w", "h"))
            d.rectangle([round(x * w), round(y * h), round((x + rw) * w), round((y + rh) * h)], fill=255)
    rel = f"input/{name}"
    (ROOT / "input").mkdir(exist_ok=True)
    im.save(ROOT / rel)
    return rel


def _size_of(rel):
    from PIL import Image
    with Image.open(ROOT / rel) as im:
        return im.size


def generate(run, *, prompt, negative="", image=None, mask=None, regions=None, width=0, height=0, denoise=0.6,
             ckpt="", loras=(), count=1, nsfw=False):
    """run(workflow) → запись истории очереди. → (текст для модели, [картинки output/…])."""
    ckpt = ckpt or default_ckpt()
    if not ckpt:
        raise ValueError("no checkpoint: the library has no checkpoints — download one (Компоненты → «Стартовые модели»)")
    rec = magic.recommend(ckpt, [(n, w) for n, w in loras])
    if not rec.get("ok"):
        raise ValueError(rec.get("error") or "checkpoint not found")
    p, q = rec["params"], rec.get("prompt") or {}
    pos = ", ".join(x for x in (q.get("positive"), (prompt or "").strip()) if x)
    neg = ", ".join(x for x in (q.get("negative"), (negative or "").strip(), "" if nsfw else "nsfw, nude, explicit") if x)
    stamp = uuid.uuid4().hex[:8]
    if image:
        frame = image
        if regions:
            w, h = _size_of(image)
            mask = _png(f"agent_mask_{stamp}.png", w, h, regions)
    else:
        sw, sh = rec.get("size") or [1024, 1024]
        w, h = int(width or sw), int(height or sh)
        w, h = max(256, min(2048, w // 8 * 8)), max(256, min(2048, h // 8 * 8))
        frame = _png(f"agent_frame_{w}x{h}.png", w, h)
    L = lambda a, o, b, i: {"from": a, "out": o, "to": b, "in": i}  # noqa: E731
    nodes = [{"id": "ckpt", "type": "sd.checkpoint", "props": {"ckpt_name": ckpt}}]
    links, model, clip = [], ("ckpt", "model"), ("ckpt", "clip")
    for i, (name, strength) in enumerate(loras or ()):
        nid = f"lora{i}"
        nodes.append({"id": nid, "type": "sd.lora", "props": {"lora_name": name, "strength_model": strength, "strength_clip": strength}})
        links += [L(*model, nid, "model"), L(*clip, nid, "clip")]
        model, clip = (nid, "model"), (nid, "clip")
    nodes += [
        {"id": "skip", "type": "sd.clip_skip", "props": {"stop_at_clip_layer": rec.get("clip_skip") or -2}},
        {"id": "pos", "type": "sd.text_encode", "props": {"text": pos}},
        {"id": "neg", "type": "sd.text_encode", "props": {"text": neg}},
        {"id": "img", "type": "image.load", "props": {"file": frame}},
        {"id": "gen", "type": "sd.canvas", "props": {
            "seed": -1, "steps": p.get("steps", 25), "cfg": p.get("cfg", 6), "sampler_name": p.get("sampler_name", "euler_ancestral"),
            "scheduler": p.get("scheduler", "normal"), "denoise": max(0.05, min(1.0, float(denoise or 0.6))),
            "fill": 0.85, "resolution": 0, "edge": 16, "blur": 16}},
    ]
    links += [L(*model, "gen", "model"), L(*clip, "skip", "clip"), L("skip", "clip", "pos", "clip"), L("skip", "clip", "neg", "clip"),
              L("pos", "conditioning", "gen", "positive"), L("neg", "conditioning", "gen", "negative"),
              L("ckpt", "vae", "gen", "vae"), L("img", "image", "gen", "image")]
    if mask:
        nodes.append({"id": "mask", "type": "image.load", "props": {"file": mask}})
        links.append(L("mask", "image", "gen", "mask"))
    wf = {"id": "agent_image", "title": "AI Agent: картинка", "nodes": nodes, "links": links, "targets": ["gen"]}
    images, errors = [], []
    for _ in range(max(1, min(4, int(count or 1)))):
        item = run(wf)
        if not item.get("ok"):
            errors.append((item.get("error") or {}).get("message", "failed")[:800])
            break
        ui = ((item.get("outputs") or {}).get("gen") or {}).get("_ui") or {}
        images += ui.get("images") or []
    mode = "inpaint" if mask else "img2img" if image else "txt2img"
    head = f"{mode} · {ckpt} · {p.get('steps')} steps, cfg {p.get('cfg')}, {p.get('sampler_name')}/{p.get('scheduler')}"
    if errors:
        head += "\nFAILED: " + errors[0]
    return f"{head}\nimages: {', '.join(images) or 'none'}", images


# ---------- интернет ----------
def _get(url, timeout=25, limit=4 << 20, ua=None):
    if not re.match(r"^https?://", url or ""):
        raise ValueError("only http(s) URLs")
    req = urllib.request.Request(url, headers={"user-agent": ua or UA, "accept-language": "ru,en;q=0.8"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read(limit), r.headers.get_content_type() or "", r.geturl()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code} {e.reason}") from None


def _text_of(markup):
    s = re.sub(r"(?is)<(script|style|noscript|svg|head)\b.*?</\1>", " ", markup)
    s = re.sub(r"(?i)<br\s*/?>|</(p|div|li|h[1-6]|tr|section|article)>", "\n", s)
    s = re.sub(r"(?s)<[^>]+>", " ", s)
    s = html.unescape(s)
    s = re.sub(r"[ \t\r\f\v]+", " ", s)
    return re.sub(r"\n\s*\n+", "\n\n", s).strip()


def web_search(query, n=8):
    body, _, _ = _get("https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query, "kl": "ru-ru"}))
    page = body.decode("utf-8", "replace")
    out = []
    for m in re.finditer(r'(?s)<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?class="result__snippet"[^>]*>(.*?)</a>', page):
        href = html.unescape(m.group(1))
        q = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
        url = q.get("uddg", [href])[0]
        if "duckduckgo.com/y.js" in url:  # реклама
            continue
        out.append({"title": _text_of(m.group(2)), "url": url, "snippet": _text_of(m.group(3))})
        if len(out) >= n:
            break
    if not out:
        return "no results (or the search engine blocked the request) — try other words or web_fetch a known site"
    return json.dumps(out, ensure_ascii=False, indent=1)


def web_fetch(url, max_chars=20000, user_agent=None):
    """→ (текст, [картинка]) — картинка по ссылке сохраняется в input/ и её видно модели."""
    data, ctype, final = _get(url, ua=ua_of(user_agent))
    if ctype.startswith("image/"):
        ext = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif"}.get(ctype, "png")
        rel = f"input/web_{uuid.uuid4().hex[:10]}.{ext}"
        (ROOT / rel).write_bytes(data)
        return f"image saved as {rel} ({len(data) // 1024} KB) — use it as an input file", [rel]
    text = data.decode("utf-8", "replace")
    if "html" in ctype or text.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        title = re.search(r"(?is)<title[^>]*>(.*?)</title>", text)
        imgs = re.findall(r'(?i)<meta[^>]+property="og:image"[^>]+content="([^"]+)"', text)[:1]
        text = (f"# {_text_of(title.group(1))}\n" if title else "") + (f"og:image: {imgs[0]}\n" if imgs else "") + _text_of(text)
    max_chars = max(1000, min(100000, int(max_chars or 20000)))
    more = f"\n… truncated, {len(text) - max_chars} more chars" if len(text) > max_chars else ""
    return f"URL: {final}\n\n{text[:max_chars]}{more}", []


# ---------- файлы (режим Code) ----------
SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "target", "__pycache__", ".pytest_cache", "dist", "build", ".next"}
DENY = re.compile(r"(^|/)(\.git|\.venv)(/|$)|\.token$|(^|/)\.env(\.[\w-]+)?$|(^|/)id_(rsa|ed25519)|\.(pem|key|pfx)$")
APP_DENY = re.compile(r"^user/(settings\.json|agent\.json)$|^update/")


class Access:
    """Папки, которые пользователь дал диалогу: cwd — рабочая (команды, относительные пути), extra — [(путь, запись)].\n    Запись в cwd — всегда (с разрешением по perm), в доп. папки — только если отмечено «запись»."""

    def __init__(self, cwd, extra=()):
        self.cwd = Path(cwd).resolve() if cwd else None
        self.roots = ([(self.cwd, True)] if self.cwd else []) + [(Path(p).resolve(), bool(w)) for p, w in extra if p]

    def resolve(self, path, write=False):
        """→ (Path, показываемый путь). Относительный — от cwd; абсолютный — внутри любой выданной папки."""
        if not self.roots:
            raise PermissionError("no folder is open in this chat — ask the user to pick a project folder")
        raw = str(path or ".").strip()
        p = Path(raw) if os.path.isabs(raw) else (self.cwd or self.roots[0][0]) / raw
        p = p.resolve()
        for root, w in self.roots:
            if p == root or root in p.parents:
                rel = p.relative_to(root).as_posix() if p != root else "."
                if DENY.search(rel) or (root == ROOT and APP_DENY.search(rel)):
                    raise PermissionError(f"{rel}: closed (secrets / git internals / venv)")
                if write and not w:
                    raise PermissionError(f"{p}: the folder is read-only for you (the user granted read access only)")
                if write and rel.split("/")[0] in SKIP_DIRS:
                    raise PermissionError(f"{rel}: not writable")
                return p, self.show(p)
        raise PermissionError(f"{p}: outside the folders the user gave you ({', '.join(str(r) for r, _ in self.roots)})")

    def show(self, p):
        if self.cwd and (p == self.cwd or self.cwd in p.parents):
            return p.relative_to(self.cwd).as_posix() if p != self.cwd else "."
        return str(p)


def list_files(acc, path=".", pattern=""):
    base, rel = acc.resolve(path)
    if not base.is_dir():
        raise NotADirectoryError(rel)
    out = []
    rx = re.compile(pattern, re.I) if pattern else None
    for dp, dirs, files in os.walk(base):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS and not d.startswith("."))
        for f in sorted(files):
            fp = Path(dp) / f
            r = acc.show(fp)
            if DENY.search(r.replace("\\", "/")) or (rx and not rx.search(r)):
                continue
            out.append(r)
            if len(out) >= 600:
                return "\n".join(out) + "\n… more (narrow the path or pattern)"
    return "\n".join(out) or "empty"


def read_file(acc, path, offset=1, limit=800):
    p, rel = acc.resolve(path)
    if not p.is_file():
        raise FileNotFoundError(rel)
    lines = p.read_text("utf-8", "replace").splitlines()
    a = max(1, int(offset or 1))
    b = min(len(lines), a - 1 + max(1, min(3000, int(limit or 800))))
    body = "\n".join(f"{i:5}\t{lines[i - 1]}" for i in range(a, b + 1))
    return f"{rel} — lines {a}–{b} of {len(lines)}\n{body}"


TEXT_EXT = {".py", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".css", ".scss", ".html", ".vue", ".svelte", ".json",
            ".md", ".rs", ".toml", ".txt", ".yaml", ".yml", ".go", ".java", ".kt", ".kts", ".c", ".h", ".cpp", ".hpp",
            ".cs", ".swift", ".dart", ".php", ".rb", ".lua", ".sh", ".ps1", ".bat", ".sql", ".xml", ".gradle", ".ini", ".cfg"}


def search_code(acc, pattern, path=".", glob=""):
    base, _ = acc.resolve(path)
    rx = re.compile(pattern)
    grx = re.compile(glob.replace(".", r"\.").replace("*", ".*") + "$") if glob else None
    hits = []
    for dp, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS and not d.startswith(".") and d not in ("icons", "fonts")]
        for f in files:
            fp = Path(dp) / f
            r = acc.show(fp)
            if fp.suffix not in TEXT_EXT or DENY.search(r) or (grx and not grx.search(f)) or fp.stat().st_size > 2 << 20:
                continue
            try:
                for i, line in enumerate(fp.read_text("utf-8", "replace").splitlines(), 1):
                    if rx.search(line):
                        hits.append(f"{r}:{i}: {line.strip()[:220]}")
                        if len(hits) >= 200:
                            return "\n".join(hits) + "\n… more"
            except OSError:
                continue
    return "\n".join(hits) or "no matches"


def write_file(acc, path, content):
    p, rel = acc.resolve(path, write=True)
    p.parent.mkdir(parents=True, exist_ok=True)
    old = p.read_text("utf-8", "replace") if p.is_file() else None
    p.write_text(content, "utf-8", newline="")
    return f"{'rewrote' if old is not None else 'created'} {rel} ({len(content.splitlines())} lines)"


def edit_file(acc, path, old, new, replace_all=False):
    p, rel = acc.resolve(path, write=True)
    src = p.read_text("utf-8")
    n = src.count(old)
    if not old or n == 0:
        raise ValueError("old text not found — read the file again, the match must be exact (whitespace too)")
    if n > 1 and not replace_all:
        raise ValueError(f"old text occurs {n} times — add more context or set replace_all")
    p.write_text(src.replace(old, new) if replace_all else src.replace(old, new, 1), "utf-8", newline="")
    return f"edited {rel}: {n if replace_all else 1} replacement(s)"


SHIMS = ROOT / "user" / "bin"


def _python_shims():
    """python / python3 / pip для команд агента. На Windows без Python вместо него стоит заглушка Microsoft Store
    («Python was not found») — тогда кладём .cmd на Python самого maistep (его .venv / встроенный), в user/bin."""
    if os.name != "nt":
        return None
    found = shutil.which("python")
    if found and "WindowsApps" not in found and shutil.which("python3") and "WindowsApps" not in shutil.which("python3"):
        return None
    SHIMS.mkdir(parents=True, exist_ok=True)
    py = sys.executable
    for name, cmd in (("python", f'"{py}" %*'), ("python3", f'"{py}" %*'), ("pip", f'"{py}" -m pip %*'), ("pip3", f'"{py}" -m pip %*')):
        f = SHIMS / f"{name}.cmd"
        body = f"@echo off\r\n{cmd}\r\n"
        if not f.is_file() or f.read_text("utf-8", "replace") != body:
            f.write_text(body, "utf-8")
    return SHIMS


def cmd_env(acc):
    if not acc.cwd:
        raise PermissionError("no folder is open in this chat")
    env = dict(os.environ)
    if acc.cwd == ROOT:  # maistep: .venv проекта
        scripts = ROOT / ".venv" / ("Scripts" if os.name == "nt" else "bin")
        env["PATH"] = f"{scripts}{os.pathsep}{env.get('PATH', '')}"
    shims = _python_shims()
    if shims:
        env["PATH"] = f"{shims}{os.pathsep}{env.get('PATH', '')}"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUNBUFFERED"] = "1"  # вывод Python-серверов сразу (иначе порт и ошибки видны только после выхода)
    return env


# команды, которые не завершаются сами (серверы, вотчеры) — их агент должен запускать в фоне; если запустил в
# обычном режиме, run_more переводит их в фон сам, иначе ход висел бы до таймаута
LONG_RUNNING = re.compile(r"(^|[\s&|;])(start\s+(/b\s+)?|npm\s+(run\s+)?(dev|start|serve|watch)\b|yarn\s+(dev|start|serve)\b|"
                          r"pnpm\s+(run\s+)?(dev|start|serve)\b|npx\s+(vite|serve|http-server|live-server|next\s+dev)\b|vite(\s|$)|"
                          r"-m\s+http\.server|http-server\b|live-server\b|uvicorn\b|flask\s+run|manage\.py\s+runserver|"
                          r"webpack\s+serve|ng\s+serve|cargo\s+watch|nodemon\b|--watch\b)", re.I)


def long_running(command):
    return bool(LONG_RUNNING.search(command or ""))


def strip_detach(command):
    """«start /b cmd» / «cmd &» → cmd: отсоединение делает сам фоновый запуск (иначе процесс теряется из виду)."""
    c = re.sub(r"^\s*start\s+(/b\s+)?(\"[^\"]*\"\s+)?", "", command or "", flags=re.I)
    return re.sub(r"\s*&\s*$", "", c).strip()


def run_command(acc, command, timeout=120, stop=None):
    env = cmd_env(acc)
    flags = 0x08000000 if os.name == "nt" else 0  # CREATE_NO_WINDOW
    t0 = time.time()
    pr = subprocess.Popen(command, shell=True, cwd=acc.cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                          stdin=subprocess.DEVNULL, creationflags=flags)
    # вывод читает поток: отсоединённый внук (start /b, nohup …) держит трубу открытой, и чтение после выхода
    # оболочки висело бы, пока он жив
    chunks = []
    reader = threading.Thread(target=lambda: chunks.extend(iter(lambda: pr.stdout.read(4096), b"")), daemon=True)
    reader.start()
    limit = max(5, min(600, int(timeout or 120)))
    killed = False
    while pr.poll() is None:
        if (stop and stop.is_set()) or time.time() - t0 > limit:
            if os.name == "nt":
                subprocess.run(["taskkill", "/T", "/F", "/PID", str(pr.pid)], capture_output=True, creationflags=flags)
            pr.kill()
            killed = True
            break
        time.sleep(0.2)
    reader.join(1.5)
    out = b"".join(chunks).decode("utf-8", "replace")
    status = "killed (timeout or stop)" if killed else f"exit {pr.returncode}"
    if reader.is_alive():
        status += " · a detached child process is still running (use background=true for servers)"
    if out and len(out) > 30000:
        out = out[:12000] + f"\n… {len(out) - 24000} chars skipped …\n" + out[-12000:]
    return f"$ {command}\n{status} in {time.time() - t0:.1f}s\n{out}"


# ---------- персонажи ----------
CHAR_FIELDS = ("name", "avatar", "persona", "scenario", "greeting", "appearance", "negative", "ckpt", "nsfw", "style")


def _cpath(cid):
    if not re.fullmatch(r"[a-z0-9]{6,40}", cid or ""):
        raise ValueError("плохой id персонажа")
    return CHARS / f"{cid}.json"


def character(cid):
    try:
        return json.loads(_cpath(cid).read_text("utf-8"))
    except OSError:
        raise KeyError(cid) from None


def characters():
    out = []
    for p in CHARS.glob("*.json") if CHARS.is_dir() else []:
        try:
            out.append(json.loads(p.read_text("utf-8")))
        except (OSError, ValueError):
            continue
    return sorted(out, key=lambda c: c.get("updated") or 0, reverse=True)


def char_upsert(d):
    c = character(d["id"]) if d.get("id") else {"id": uuid.uuid4().hex[:16], "created": time.time(), "name": "Персонаж",
                                                "style": "chat"}
    for k in CHAR_FIELDS:
        if k in d:
            c[k] = d[k]
    c["updated"] = time.time()
    CHARS.mkdir(parents=True, exist_ok=True)
    _cpath(c["id"]).write_text(json.dumps(c, ensure_ascii=False, indent=1), "utf-8")
    return c


def char_delete(cid):
    _cpath(cid).unlink(missing_ok=True)
    return {"ok": True}


FRAMING = {"portrait": ("portrait, upper body, looking at viewer", 832, 1216),
           "half": ("cowboy shot, looking at viewer", 832, 1216),
           "full": ("full body", 832, 1216),
           "wide": ("wide shot, scenery", 1216, 832)}


def char_photo(run, c, scene="", framing="portrait", count=1, nsfw=True):
    tags, w, h = FRAMING.get(framing, FRAMING["portrait"])
    prompt = ", ".join(x for x in (c.get("appearance"), tags, scene) if x and str(x).strip())
    return generate(run, prompt=prompt, negative=c.get("negative", ""), width=w, height=h, ckpt=c.get("ckpt") or "",
                    count=count, nsfw=nsfw)
