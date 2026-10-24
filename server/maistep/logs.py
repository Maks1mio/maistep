"""Логи сервера в файлы и отчёт для отправки — чтобы после зависания или падения системы было что прислать.

user/logs/server-ГГГГММДД-ЧЧММСС.log — всё, что сервер пишет в stdout/stderr (с временем), строки статистики
во время запусков (sysmon) и аварийные падения самого Python (faulthandler: segfault в torch/драйвере).
Пишется построчно с fsync раз в пару секунд — после жёсткой перезагрузки в файле остаётся почти всё.
Хранятся последние KEEP файлов. report() — zip: последние логи, сведения о системе, настройки без ключей.
"""
import datetime
import faulthandler
import json
import os
import platform
import re
import sys
import threading
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DIR = ROOT / "user" / "logs"
KEEP = 10
_file = None
_lock = threading.Lock()
_synced = [0.0]


def _write(text):
    if not _file:
        return
    with _lock:
        try:
            _file.write(text)
            _file.flush()
            if time.time() - _synced[0] > 2:
                _synced[0] = time.time()
                os.fsync(_file.fileno())
        except (OSError, ValueError):
            pass


class _Tee:
    """Поток вывода: как был (консоль редактора) + в файл с временем в начале строки."""

    def __init__(self, orig):
        self.orig, self.bol = orig, True

    def write(self, s):
        try:
            self.orig.write(s)
        except Exception:
            pass
        if s:
            stamp = datetime.datetime.now().strftime("%H:%M:%S ")
            out = "".join((stamp + part if self.bol or i else part) for i, part in enumerate(s.splitlines(True)))
            self.bol = s.endswith("\n")
            _write(out)
        return len(s)

    def flush(self):
        try:
            self.orig.flush()
        except Exception:
            pass

    def __getattr__(self, name):
        return getattr(self.orig, name)


def setup():
    global _file
    DIR.mkdir(parents=True, exist_ok=True)
    old = sorted(DIR.glob("server-*.log"))
    for p in old[:max(0, len(old) - KEEP + 1)]:
        try:
            p.unlink()
        except OSError:
            pass
    path = DIR / f"server-{datetime.datetime.now():%Y%m%d-%H%M%S}.log"
    _file = open(path, "a", encoding="utf-8", buffering=1)
    _write(f"=== maistep server · {datetime.datetime.now():%Y-%m-%d %H:%M:%S} · {platform.platform()} · Python {sys.version.split()[0]}\n")
    sys.stdout, sys.stderr = _Tee(sys.stdout), _Tee(sys.stderr)
    faulthandler.enable(file=_file, all_threads=True)
    return path


def files():
    return [{"name": p.name, "size": p.stat().st_size, "mtime": p.stat().st_mtime}
            for p in sorted(DIR.glob("*.log"), reverse=True)] if DIR.is_dir() else []


_SECRET = re.compile(r"key|token|secret|password", re.I)


def _clean(v):
    """Настройки без ключей API и токенов."""
    if isinstance(v, dict):
        return {k: ("•••" if _SECRET.search(k) and x else _clean(x)) for k, x in v.items()}
    if isinstance(v, list):
        return [_clean(x) for x in v]
    return v


def report(extra=None):
    """zip для отправки: последние 5 логов, сведения о системе, настройки без ключей. Возвращает путь."""
    DIR.mkdir(parents=True, exist_ok=True)
    path = DIR / f"maistep-report-{datetime.datetime.now():%Y%m%d-%H%M%S}.zip"
    info = {"time": datetime.datetime.now().isoformat(timespec="seconds"), "platform": platform.platform(),
            "machine": platform.machine(), "python": sys.version, **(extra or {})}
    try:
        settings = json.loads((ROOT / "user" / "settings.json").read_text("utf-8"))
    except (OSError, ValueError):
        settings = {}
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(DIR.glob("server-*.log"), reverse=True)[:5]:
            z.write(p, f"logs/{p.name}")
        for name in ("applied.json",):
            p = ROOT / "update" / name
            if p.is_file():
                z.write(p, f"update/{name}")
        z.writestr("system.json", json.dumps(info, ensure_ascii=False, indent=2, default=str))
        z.writestr("settings.json", json.dumps(_clean(settings), ensure_ascii=False, indent=2))
    return str(path)
