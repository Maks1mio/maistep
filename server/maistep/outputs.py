"""Порядок в output/: результаты раскладываются по подпапкам — откуда запуск.

    output/workflow/<id воркфлоу>/   запуски воркфлоу пользователя
    output/naizer/                    ImageNaizer (скрытый граф id «naizer», сохранение холста)
    output/tocolar/                   ToColar (скрытые графы «tocolar», «tocolar_ctx»)
    output/agent/                     картинки AI Agent (граф «agent_image»)
    output/video/                     вкладка «Видео» (граф «video»)
    output/other/                     старые файлы, чей запуск уже не найти в истории

Новые файлы сразу пишутся в свою папку (registry.Ctx.output_dir → folder()). Файлы, лежащие прямо в output/,
разбирает organize() при старте сервера: владельца находит по истории запусков (самый ранний запуск, где файл
появился), иначе по префиксу имени. Перенос записывается в user/output_moved.json {старый путь: новый}: по нему
переписываются ссылки в истории, избранном и воркфлоу, а /view и Load Image открывают старые пути (localStorage окна,
чаты агента). Повторный запуск ничего не ломает: переносится только то, что ещё лежит в корне output/.
"""
import json
import os
import re
import time
from pathlib import Path

GROUPS = {"naizer": "naizer", "tocolar": "tocolar", "tocolar_ctx": "tocolar", "agent_image": "agent", "video": "video"}
PREFIX = [(re.compile(r"^(naizer|canvas)_"), "naizer"), (re.compile(r"^(tocolar|colored)_"), "tocolar")]
_moved = None  # кеш user/output_moved.json


def folder(wf_id):
    """Подпапка output/ для запуска графа с этим id."""
    if wf_id in GROUPS:
        return GROUPS[wf_id]
    safe = re.sub(r"[^\w.-]+", "_", str(wf_id or "")).strip("._")[:60]
    return f"workflow/{safe}" if safe else "other"


def _map_path(root):
    return Path(root) / "user" / "output_moved.json"


def moved(root):
    global _moved
    if _moved is None:
        try:
            _moved = json.loads(_map_path(root).read_text("utf-8"))
        except (OSError, ValueError):
            _moved = {}
    return _moved


def resolve(root, rel):
    """Старый путь output/x.png → новый, если файл перенесён (иначе как есть)."""
    rel = str(rel or "")
    if not (Path(root) / rel).exists():
        return moved(root).get(rel, rel)
    return rel


def _files(o):
    if isinstance(o, dict):
        for v in o.values():
            yield from _files(v)
    elif isinstance(o, list):
        for v in o:
            yield from _files(v)
    elif isinstance(o, str) and o.startswith("output/") and o.count("/") == 1:
        yield o


def _rewrite(o, m):
    """Строки, равные старому пути, → новый (рекурсивно)."""
    if isinstance(o, dict):
        return {k: _rewrite(v, m) for k, v in o.items()}
    if isinstance(o, list):
        return [_rewrite(v, m) for v in o]
    if isinstance(o, str):
        return m.get(o, o)
    return o


def _rewrite_file(p, m):
    try:
        data = json.loads(p.read_text("utf-8"))
    except (OSError, ValueError):
        return False
    new = _rewrite(data, m)
    if new == data:
        return False
    tmp = p.with_suffix(p.suffix + ".tmp")
    pretty = p.name != "history.json"  # воркфлоу и избранное редактор пишет с отступом 2, историю — одной строкой
    tmp.write_text(json.dumps(new, ensure_ascii=False, indent=2 if pretty else None, default=str) + ("\n" if pretty else ""), "utf-8")
    os.replace(tmp, p)
    return True


def organize(root, log=print):
    """Разложить файлы из корня output/ по подпапкам и переписать ссылки. → число перенесённых файлов."""
    global _moved
    root = Path(root)
    out = root / "output"
    top = [p for p in out.iterdir() if p.is_file()] if out.is_dir() else []
    m = dict(moved(root))
    if top:
        owner = {}
        try:
            hist = json.loads((root / "user" / "history.json").read_text("utf-8"))
        except (OSError, ValueError):
            hist = []
        for it in reversed(hist if isinstance(hist, list) else []):  # от старых к новым: владелец — первый запуск
            wid = (it.get("workflow") or {}).get("id")
            for f in _files(it.get("outputs") or {}):
                owner.setdefault(f, wid)
        for p in top:
            rel = f"output/{p.name}"
            sub = folder(owner[rel]) if rel in owner else next((g for rx, g in PREFIX if rx.search(p.name)), "other")
            dst = out / sub / p.name
            dst.parent.mkdir(parents=True, exist_ok=True)
            n = 2
            while dst.exists():  # то же имя уже в папке — не затираем
                dst = dst.with_name(f"{p.stem}_{n}{p.suffix}")
                n += 1
            try:
                os.replace(p, dst)
            except OSError as e:
                log(f"output: не перенесён {p.name}: {e}")
                continue
            m[rel] = dst.relative_to(root).as_posix()
        _map_path(root).parent.mkdir(parents=True, exist_ok=True)
        _map_path(root).write_text(json.dumps(m, ensure_ascii=False, indent=1), "utf-8")
        _moved = m
        log(f"output: разложено по папкам {len(top)} файлов (карта переносов — user/output_moved.json)")
    if m:  # ссылки — и после переносов прошлых запусков (старый сервер мог дописать историю со старыми путями)
        for p in [root / "user" / "history.json", root / "user" / "favorites.json", *sorted((root / "workflows").glob("*.json"))]:
            if p.is_file():
                _rewrite_file(p, m)
    return len(top)


TEMP_DAYS = 7


def clean_temp(root, days=TEMP_DAYS):
    """temp/ — кадры VAE Decode (в output/ их кладёт только Save Image): при старте сервера убираем старше `days` дней.
    Неделю они живы — превью в истории, подсказки ToColar на прежней генерации. → число удалённых файлов."""
    d = Path(root) / "temp"
    if not d.is_dir():
        return 0
    old, n = time.time() - days * 86400, 0
    for p in d.rglob("*"):
        try:
            if p.is_file() and p.stat().st_mtime < old:
                p.unlink()
                n += 1
        except OSError:
            pass
    return n
