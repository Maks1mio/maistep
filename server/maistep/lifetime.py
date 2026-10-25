"""Дочерние процессы живут не дольше сервера: команды и фоновые процессы агента, MCP-серверы, llama-server.

Сервер завершают по-разному — atexit, taskkill /F от ядра, kill -9, падение, — а atexit срабатывает не всегда, и
отсоединённые внуки (start /b, nohup, npm → node) не попадают в дерево процессов. Поэтому:
- Windows: сервер при старте входит в Job Object с KILL_ON_JOB_CLOSE — все потомки наследуют задание, и когда
  процесс сервера исчезает (как угодно), система убивает их всех. Окна проводника — detach() (вне задания).
- POSIX: Popen() запускает каждого в своей группе процессов и сообщает группу сторожу — отдельному процессу,
  который ждёт конца трубы от сервера (EOF = сервер умер) и убивает оставшиеся группы (TERM, через 3 с KILL).
"""
import os
import signal
import subprocess
import sys
import threading

NO_WINDOW = 0x08000000 if os.name == "nt" else 0
BREAKAWAY = 0x01000000  # CREATE_BREAKAWAY_FROM_JOB
_state = {"job": None, "reaper": None}
_lock = threading.Lock()

_REAPER = r"""
import os, signal, sys, time
for s in (signal.SIGINT, signal.SIGHUP, signal.SIGTERM):
    signal.signal(s, signal.SIG_IGN)
groups = set()
for line in sys.stdin:
    s = line.strip()
    if s[:1] == "+":
        groups.add(int(s[1:]))
    elif s[:1] == "-":
        groups.discard(int(s[1:]))
def kill(sig):
    for g in list(groups):
        try:
            os.killpg(g, sig)
        except OSError:
            groups.discard(g)
kill(signal.SIGTERM)
t = time.time()
while groups and time.time() - t < 3:
    time.sleep(0.2)
    kill(0)
kill(signal.SIGKILL)
"""


def bind():
    """Вызвать при старте сервера, до запуска дочерних процессов."""
    try:
        if os.name == "nt":
            _state["job"] = _job()
        else:
            _state["reaper"] = subprocess.Popen([sys.executable, "-I", "-c", _REAPER], stdin=subprocess.PIPE,
                                                start_new_session=True, close_fds=True)
            for s in (signal.SIGTERM, signal.SIGHUP):  # обычное завершение — через atexit (stop_all и т.п.)
                signal.signal(s, lambda *_: sys.exit(0))
    except Exception as e:  # без привязки сервер работает как раньше
        print(f"lifetime: дочерние процессы не привязаны к серверу: {type(e).__name__}: {e}", file=sys.stderr)


def _job():
    import ctypes
    from ctypes import wintypes

    class BASIC(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                    ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD), ("SchedulingClass", wintypes.DWORD)]

    class IO(ctypes.Structure):
        _fields_ = [(n, ctypes.c_uint64) for n in ("ReadOps", "WriteOps", "OtherOps", "ReadBytes", "WriteBytes", "OtherBytes")]

    class EXT(ctypes.Structure):
        _fields_ = [("Basic", BASIC), ("Io", IO), ("ProcessMemoryLimit", ctypes.c_size_t), ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t), ("PeakJobMemoryUsed", ctypes.c_size_t)]

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.CreateJobObjectW.restype = wintypes.HANDLE
    k.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    k.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    k.GetCurrentProcess.restype = wintypes.HANDLE
    k.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    job = k.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    info = EXT()
    info.Basic.LimitFlags = 0x2000 | 0x800  # KILL_ON_JOB_CLOSE | BREAKAWAY_OK (для detach)
    if not k.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):  # JobObjectExtendedLimitInformation
        raise ctypes.WinError(ctypes.get_last_error())
    if not k.AssignProcessToJobObject(job, k.GetCurrentProcess()):
        raise ctypes.WinError(ctypes.get_last_error())
    return job  # хендл не закрываем: его закроет система вместе с процессом сервера


def _tell(line):
    r = _state["reaper"]
    if not r or r.poll() is not None:
        return
    with _lock:
        try:
            r.stdin.write(f"{line}\n".encode())
            r.stdin.flush()
        except OSError:
            pass


def Popen(args, **kw):  # noqa: N802 — как subprocess.Popen
    """subprocess.Popen, привязанный к жизни сервера (POSIX: своя группа процессов, её pgid = pid)."""
    if os.name == "nt":
        kw["creationflags"] = kw.get("creationflags", 0) | NO_WINDOW
    else:
        kw["start_new_session"] = True
    p = subprocess.Popen(args, **kw)
    if os.name != "nt":
        _tell(f"+{p.pid}")
    return p


def kill(p):
    """Убить процесс со всеми потомками (дерево на Windows, группу в POSIX)."""
    if p.poll() is None:
        if os.name == "nt":
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True, creationflags=NO_WINDOW)
        else:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except OSError:
                pass
        try:
            p.kill()
        except OSError:
            pass
    release(p)


def release(p):
    """Процесс завершён — сторожу его группа больше не нужна (номер могут занять другие)."""
    if os.name != "nt" and p is not None:
        _tell(f"-{p.pid}")


def detach(args):
    """Запустить то, что должно пережить сервер (окно проводника): вне задания, без сторожа."""
    if os.name == "nt":
        try:
            return subprocess.Popen(args, creationflags=BREAKAWAY)
        except OSError:  # сервер уже в чужом задании без права выхода — тогда как есть
            return subprocess.Popen(args)
    return subprocess.Popen(args, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
