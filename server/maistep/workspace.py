"""Папки на ПК для AI Chat: недавние проекты, обзор дисков и папок, git (ветка, изменения).

Недавние — user/agent.json { projects: [{ path, name, at }] }; список пополняется, когда диалогу выбирают папку.
Доступ агента к файлам — только к папкам, которые пользователь дал диалогу (agent_tools.Access).
"""
import json
import os
import string
import subprocess
import threading
import time
from pathlib import Path

from . import lifetime

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / "user" / "agent.json"
MAX_RECENT = 20
NO_WINDOW = 0x08000000 if os.name == "nt" else 0
_lock = threading.Lock()


def _load():
    try:
        return json.loads(STATE.read_text("utf-8"))
    except (OSError, ValueError):
        return {}


def _store(s):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(s, ensure_ascii=False, indent=1), "utf-8")


def norm(path):
    """Абсолютный путь папки (существующей) или ValueError."""
    p = Path(os.path.expanduser(str(path or "").strip())).resolve()
    if not p.is_dir():
        raise ValueError(f"нет папки {p}")
    return p


def name_of(path):
    p = Path(path)
    return p.name or str(p)


def recent():
    s = _load()
    out = []
    for r in s.get("projects") or []:
        p = Path(r["path"])
        out.append({**r, "name": r.get("name") or name_of(p), "exists": p.is_dir(), "app": p == ROOT})
    if not any(r["app"] for r in out):
        out.append({"path": str(ROOT), "name": "maistep", "at": 0, "exists": True, "app": True})
    return out


def touch(path):
    """Папка выбрана — наверх списка недавних."""
    p = str(norm(path))
    with _lock:
        s = _load()
        lst = [r for r in s.get("projects") or [] if r.get("path") != p]
        lst.insert(0, {"path": p, "name": name_of(p), "at": time.time()})
        s["projects"] = lst[:MAX_RECENT]
        _store(s)
    return recent()


def forget(path):
    with _lock:
        s = _load()
        s["projects"] = [r for r in s.get("projects") or [] if r.get("path") != str(path)]
        _store(s)
    return recent()


def drives():
    if os.name != "nt":
        return [{"name": "/", "path": "/"}]
    return [{"name": f"{d}:", "path": f"{d}:\\"} for d in string.ascii_uppercase if os.path.exists(f"{d}:\\")]


def dirs(path=None):
    """Обзор: папка → вложенные папки (скрытые не показываем). Без пути — домашняя папка."""
    p = norm(path or Path.home())
    out = []
    try:
        for e in sorted(os.scandir(p), key=lambda e: e.name.lower()):
            if e.name.startswith((".", "$")) or not e.is_dir(follow_symlinks=False):
                continue
            out.append({"name": e.name, "path": e.path, "git": os.path.isdir(os.path.join(e.path, ".git"))})
    except PermissionError:
        pass
    parent = str(p.parent) if p.parent != p else None
    home = Path.home()
    places = [{"name": "Домашняя", "path": str(home)}] + [
        {"name": n, "path": str(home / n)} for n in ("Desktop", "Documents", "Downloads") if (home / n).is_dir()]
    return {"path": str(p), "parent": parent, "dirs": out[:800], "drives": drives(), "places": places,
            "git": (p / ".git").exists()}


# ---------- операции с папками (окно выбора папки) ----------
BAD_NAME = set('<>:"/\\|?*')


def _name(name):
    n = str(name or "").strip().rstrip(".")
    if not n or n in (".", "..") or any(ch in BAD_NAME or ord(ch) < 32 for ch in n) or len(n) > 200:
        raise ValueError("недопустимое имя папки")
    return n


def _guard(p):
    """Нельзя трогать корень диска, домашнюю папку и папки, внутри которых лежит maistep."""
    if p.parent == p or p == Path.home().resolve() or p == ROOT or p in ROOT.parents:
        raise PermissionError(f"{p}: эту папку менять нельзя")
    return p


def mkdir(parent, name):
    p = norm(parent) / _name(name)
    if p.exists():
        raise FileExistsError(f"«{p.name}» уже есть")
    p.mkdir()
    return {"path": str(p)}


def rename(path, name):
    p = _guard(norm(path))
    q = p.with_name(_name(name))
    if q.exists() and q != p:
        raise FileExistsError(f"«{q.name}» уже есть")
    p.rename(q)
    return {"path": str(q)}


def trash(path):
    """В корзину (Windows: SHFileOperation с отменой); на других ОС — только пустая папка."""
    p = _guard(norm(path))
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class OP(ctypes.Structure):
            _fields_ = [("hwnd", wintypes.HWND), ("wFunc", ctypes.c_uint), ("pFrom", wintypes.LPCWSTR),
                        ("pTo", wintypes.LPCWSTR), ("fFlags", ctypes.c_ushort), ("fAnyOperationsAborted", wintypes.BOOL),
                        ("hNameMappings", ctypes.c_void_p), ("lpszProgressTitle", wintypes.LPCWSTR)]
        # FO_DELETE = 3; FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
        op = OP(None, 3, str(p) + "\0", None, 0x40 | 0x10 | 0x04 | 0x400, False, None, None)
        r = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
        if r or op.fAnyOperationsAborted:
            raise OSError(f"не удалось переместить в корзину (код {r})")
    else:
        if any(p.iterdir()):
            raise OSError("здесь удаляются только пустые папки")
        p.rmdir()
    return {"ok": True}


def reveal(path):
    p = norm(path)
    lifetime.detach(["explorer", str(p)] if os.name == "nt" else ["xdg-open", str(p)])
    return {"ok": True}


# ---------- git ----------
def _git(cwd, *args, timeout=8):
    try:
        r = subprocess.run(["git", "-C", str(cwd), *args], capture_output=True, timeout=timeout, creationflags=NO_WINDOW)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return r.stdout.decode("utf-8", "replace") if r.returncode == 0 else None


def git_info(cwd):
    """{branch, branches, added, removed, files: [{path, added, removed, status}]} или None (не git)."""
    if not cwd or not Path(cwd).is_dir():
        return None
    branch = _git(cwd, "rev-parse", "--abbrev-ref", "HEAD")
    if branch is None:
        return None
    files = {}
    for line in (_git(cwd, "diff", "--numstat", "HEAD") or "").splitlines():
        parts = line.split("\t")
        if len(parts) == 3:
            a, r, f = parts
            files[f] = {"path": f, "added": int(a) if a.isdigit() else 0, "removed": int(r) if r.isdigit() else 0, "status": "M"}
    for line in (_git(cwd, "status", "--porcelain", "-uall") or "").splitlines()[:400]:
        st, f = line[:2], line[3:].strip().strip('"')
        if " -> " in f:
            f = f.split(" -> ")[-1]
        if st == "??":
            n = 0
            try:
                fp = Path(cwd) / f
                if fp.stat().st_size < 2 << 20:
                    n = fp.read_bytes().count(b"\n")
            except OSError:
                pass
            files[f] = {"path": f, "added": n, "removed": 0, "status": "A"}
        elif f in files:
            files[f]["status"] = "D" if "D" in st else "M"
    lst = sorted(files.values(), key=lambda x: x["path"])
    branches = [b.strip() for b in (_git(cwd, "branch", "--format=%(refname:short)") or "").splitlines() if b.strip()]
    return {"branch": branch.strip(), "branches": branches, "added": sum(f["added"] for f in lst),
            "removed": sum(f["removed"] for f in lst), "files": lst[:300]}


def git_switch(cwd, branch):
    r = subprocess.run(["git", "-C", str(norm(cwd)), "switch", branch], capture_output=True, timeout=30, creationflags=NO_WINDOW)
    if r.returncode:
        raise RuntimeError((r.stderr or r.stdout).decode("utf-8", "replace").strip()[:600])
    return git_info(cwd)


def git_diff(cwd, path):
    out = _git(norm(cwd), "diff", "HEAD", "--", path, timeout=15)
    if out:
        return out[:200000]
    fp = norm(cwd) / path
    try:
        return "".join(f"+{l}\n" for l in fp.read_text("utf-8", "replace").splitlines()[:3000])
    except OSError:
        return ""
