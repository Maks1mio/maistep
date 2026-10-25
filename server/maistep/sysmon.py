"""Статистика системы и лимиты нагрузки — только стандартная библиотека (ctypes / /proc / sysfs / nvidia-smi).

sample(): CPU %, RAM системы, RAM процесса сервера (в нём работает torch), видеокарта — загрузка, температура,
частота, мощность, VRAM (NVIDIA — NVML через ctypes, без процесса nvidia-smi; AMD на Linux — sysfs amdgpu; иначе —
VRAM из torch, если он уже загружен), память torch.
Фоновый поток снимает показатели раз в секунду, пока их смотрят (/api/stats) или идёт запуск; во время запуска
раз в 5 с пишет строку в лог (после зависания системы видно, что кончилось — RAM или VRAM). По частоте и мощности
видно низкий P-state карты («GPU 100%, 48 °C» — счёт в десятки раз медленнее, это не код maistep).

Лимиты (user/settings.json → "limits", UI — «Сервер → Производительность и лимиты…»):
  ram_reserve_gb  — сколько RAM оставлять свободной: меньше — запуск прерывается (иначе система уходит в своп
                    и виснет — так было у друга на 1920×1080), 0 — не следить;
  vram_max_pct    — потолок VRAM для torch (set_per_process_memory_fraction): выше — ошибка нехватки памяти и
                    повтор тайлами, а не переполнение в системную память (Windows так «спасает» и всё ползёт);
  gpu_load        — нагрузка видеокарты, %: паузы между шагами сэмплера (100 — без пауз);
  max_mp          — предел размера картинки в мегапикселях (0 — без предела).
"""
import collections
import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SETTINGS = ROOT / "user" / "settings.json"
DEFAULT_LIMITS = {"ram_reserve_gb": 2.0, "vram_max_pct": 0, "gpu_load": 100, "max_mp": 0}
GB = 2 ** 30

_lock = threading.Lock()
_last = None
_hist = collections.deque(maxlen=120)
_wanted = 0.0          # когда в последний раз спрашивали /api/stats
_busy = lambda: None   # задаёт main.py: текущий запуск (или None)
_on_low = lambda text: None
_log = lambda level, text: None
_thread = None


def configure(busy, on_low, log):
    global _busy, _on_low, _log
    _busy, _on_low, _log = busy, on_low, log


def limits():
    try:
        s = json.loads(SETTINGS.read_text("utf-8")).get("limits") or {}
    except (OSError, ValueError):
        s = {}
    out = dict(DEFAULT_LIMITS)
    for k, v in s.items():
        if k in out:
            try:
                out[k] = float(v)
            except (TypeError, ValueError):
                pass
    return out


def save_limits(data):
    try:
        full = json.loads(SETTINGS.read_text("utf-8"))
    except (OSError, ValueError):
        full = {}
    cur = {**limits(), **{k: v for k, v in (data or {}).items() if k in DEFAULT_LIMITS}}
    cur["ram_reserve_gb"] = max(0.0, min(64.0, float(cur["ram_reserve_gb"])))
    cur["vram_max_pct"] = max(0.0, min(100.0, float(cur["vram_max_pct"])))
    cur["gpu_load"] = max(10.0, min(100.0, float(cur["gpu_load"])))
    cur["max_mp"] = max(0.0, min(64.0, float(cur["max_mp"])))
    full["limits"] = cur
    SETTINGS.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(full, ensure_ascii=False, indent=2), "utf-8")
    os.replace(tmp, SETTINGS)
    return cur


# ---------- CPU и RAM ----------
_cpu_prev = None


def _cpu_win():
    import ctypes
    from ctypes import wintypes
    idle, kern, user = wintypes.FILETIME(), wintypes.FILETIME(), wintypes.FILETIME()
    ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kern), ctypes.byref(user))
    v = lambda f: (f.dwHighDateTime << 32) | f.dwLowDateTime  # noqa: E731
    return v(idle), v(kern) + v(user)  # kernel включает idle


def _cpu_linux():
    with open("/proc/stat") as f:
        parts = [int(x) for x in f.readline().split()[1:]]
    return parts[3] + parts[4], sum(parts)


def _cpu():
    global _cpu_prev
    try:
        cur = _cpu_win() if os.name == "nt" else _cpu_linux()
    except Exception:
        return None
    prev, _cpu_prev = _cpu_prev, cur
    if not prev or cur[1] == prev[1]:
        return None
    return round(100 * (1 - (cur[0] - prev[0]) / (cur[1] - prev[1])), 1)


def _ram():
    """(занято, всего) системной памяти и RAM процесса сервера, байт."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class MS(ctypes.Structure):
            _fields_ = [("len", wintypes.DWORD), ("load", wintypes.DWORD), ("total", ctypes.c_ulonglong),
                        ("avail", ctypes.c_ulonglong), ("tpf", ctypes.c_ulonglong), ("apf", ctypes.c_ulonglong),
                        ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong), ("ave", ctypes.c_ulonglong)]

        class PMC(ctypes.Structure):
            _fields_ = [("cb", wintypes.DWORD), ("pfc", wintypes.DWORD), ("peak", ctypes.c_size_t), ("ws", ctypes.c_size_t),
                        ("qpp", ctypes.c_size_t), ("qp", ctypes.c_size_t), ("qnpp", ctypes.c_size_t), ("qnp", ctypes.c_size_t),
                        ("pf", ctypes.c_size_t), ("ppf", ctypes.c_size_t), ("priv", ctypes.c_size_t)]
        ms = MS()
        ms.len = ctypes.sizeof(MS)
        ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(ms))
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        proc = 0
        try:
            k = ctypes.windll.kernel32
            k.GetCurrentProcess.restype = wintypes.HANDLE
            f = k.K32GetProcessMemoryInfo  # без argtypes 64-битный HANDLE обрезается и вызов молча не удаётся
            f.argtypes, f.restype = [wintypes.HANDLE, ctypes.POINTER(PMC), wintypes.DWORD], wintypes.BOOL
            if f(k.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb):
                proc = pmc.ws  # рабочий набор — сколько RAM процесс реально занимает
        except Exception:
            pass
        return ms.total - ms.avail, ms.total, proc
    info = {}
    with open("/proc/meminfo") as f:
        for line in f:
            k, v = line.split(":", 1)
            info[k] = int(v.split()[0]) * 1024
    proc = 0
    try:
        with open("/proc/self/status") as f:
            proc = next(int(l.split()[1]) * 1024 for l in f if l.startswith("VmRSS:"))
    except Exception:
        pass
    total = info.get("MemTotal", 0)
    return total - info.get("MemAvailable", info.get("MemFree", 0)), total, proc


# ---------- видеокарта ----------
_smi = shutil.which("nvidia-smi")
_NVML = None          # (lib, handle) или False — NVML не поднялся
_smi_cache = [0.0, None]   # nvidia-smi — запасной путь: зовём не чаще раза в 2 с (запуск процесса ~80 мс)


class _NvmlUtil(ctypes.Structure):
    _fields_ = [("gpu", ctypes.c_uint), ("memory", ctypes.c_uint)]


class _NvmlMem(ctypes.Structure):
    _fields_ = [("total", ctypes.c_ulonglong), ("free", ctypes.c_ulonglong), ("used", ctypes.c_ulonglong)]


def _nvml():
    """NVML напрямую через ctypes: без процесса nvidia-smi на каждый снимок (раз в секунду во время запусков —
    на Windows это ещё и очередь команд драйвера). Заодно даёт частоты и мощность: по ним видно «GPU 100%, но
    застрял на низкой частоте» — карта в таком состоянии считает в десятки раз медленнее, и это не наш код."""
    global _NVML
    if _NVML is not None:
        return _NVML or None
    try:
        names = ["nvml.dll"] if os.name == "nt" else ["libnvidia-ml.so.1", "libnvidia-ml.so"]
        lib = None
        for n in names:
            try:
                lib = ctypes.CDLL(n)
                break
            except OSError:
                continue
        if lib is None:
            raise OSError("nvml not found")
        lib.nvmlInit_v2()
        lib.nvmlDeviceGetHandleByIndex_v2.argtypes = [ctypes.c_uint, ctypes.POINTER(ctypes.c_void_p)]
        lib.nvmlDeviceGetHandleByIndex_v2.restype = ctypes.c_int
        h = ctypes.c_void_p()
        if lib.nvmlDeviceGetHandleByIndex_v2(0, ctypes.byref(h)) != 0 or not h:
            raise OSError("no device")
        for fn, sig in (("nvmlDeviceGetUtilizationRates", [ctypes.c_void_p, ctypes.POINTER(_NvmlUtil)]),
                        ("nvmlDeviceGetMemoryInfo", [ctypes.c_void_p, ctypes.POINTER(_NvmlMem)]),
                        ("nvmlDeviceGetTemperature", [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_uint)]),
                        ("nvmlDeviceGetClockInfo", [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_uint)]),
                        ("nvmlDeviceGetMaxClockInfo", [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_uint)]),
                        ("nvmlDeviceGetPowerUsage", [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint)]),
                        ("nvmlDeviceGetName", [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_uint])):
            getattr(lib, fn).argtypes = sig
        _NVML = (lib, h)
    except Exception:
        _NVML = False
    return _NVML or None


def _nvidia():
    nv = _nvml()
    if nv:
        lib, h = nv
        u, m = _NvmlUtil(), _NvmlMem()
        out = {"name": "NVIDIA"}
        try:
            buf = ctypes.create_string_buffer(96)
            lib.nvmlDeviceGetName(h, buf, len(buf))
            out["name"] = buf.value.decode("utf-8", "replace") or "NVIDIA"
        except Exception:
            pass
        try:
            if lib.nvmlDeviceGetMemoryInfo(h, ctypes.byref(m)) == 0:
                out.update(vram_used=m.used, vram_total=m.total)
        except Exception:
            pass
        try:
            if lib.nvmlDeviceGetUtilizationRates(h, ctypes.byref(u)) == 0:
                out["util"] = float(u.gpu)
        except Exception:
            pass
        for key, fn, args in (("temp", "nvmlDeviceGetTemperature", (0,)),
                              ("clock", "nvmlDeviceGetClockInfo", (1,)),        # NVML_CLOCK_SM
                              ("clock_max", "nvmlDeviceGetMaxClockInfo", (1,)),
                              ("power", "nvmlDeviceGetPowerUsage", ())):        # мВт
            try:
                v = ctypes.c_uint()
                if getattr(lib, fn)(h, *args, ctypes.byref(v)) == 0 and v.value:
                    out[key] = v.value / (1000 if key == "power" else 1)
            except Exception:
                pass
        return out if "vram_total" in out else _nvidia_smi()
    return _nvidia_smi()


def _nvidia_smi():
    if not _smi:
        return None
    stamp = time.time()
    if _smi_cache[1] is not None and stamp - _smi_cache[0] < 2:
        return _smi_cache[1]
    try:
        r = subprocess.run([_smi, "--query-gpu=name,utilization.gpu,temperature.gpu,memory.used,memory.total,power.draw",
                            "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=5,
                           creationflags=0x08000000 if os.name == "nt" else 0)
        f = [x.strip() for x in (r.stdout or "").splitlines()[0].split(",")]
        num = lambda s: float(s) if re.fullmatch(r"[\d.]+", s) else None  # noqa: E731
        out = {"name": f[0], "util": num(f[1]), "temp": num(f[2]), "vram_used": (num(f[3]) or 0) * 2**20,
               "vram_total": (num(f[4]) or 0) * 2**20, "power": num(f[5]) if len(f) > 5 else None}
    except Exception:
        out = None
    _smi_cache[:] = [stamp, out]
    return out


def _amd_sysfs():
    for dev in sorted(Path("/sys/class/drm").glob("card[0-9]*/device")):
        try:
            if (dev / "vendor").read_text().strip() != "0x1002" or not (dev / "mem_info_vram_total").exists():
                continue
            rd = lambda n: int((dev / n).read_text().strip())  # noqa: E731
            temp = None
            for t in dev.glob("hwmon/hwmon*/temp1_input"):
                temp = int(t.read_text()) / 1000
                break
            return {"name": "AMD Radeon", "util": rd("gpu_busy_percent"), "temp": temp,
                    "vram_used": rd("mem_info_vram_used"), "vram_total": rd("mem_info_vram_total")}
        except Exception:
            continue
    return None


def _torch():
    """Память torch этого процесса (только если torch уже загружен генерацией — сами его не грузим)."""
    t = sys.modules.get("torch")
    try:
        if not t or not t.cuda.is_available() or not t.cuda.is_initialized():
            return None
        free, total = t.cuda.mem_get_info()
        return {"alloc": t.cuda.memory_allocated(), "reserved": t.cuda.memory_reserved(),
                "free": free, "total": total, "name": t.cuda.get_device_name(0)}
    except Exception:
        return None


def sample():
    used, total, proc = _ram()
    gpu = _nvidia() or (_amd_sysfs() if sys.platform.startswith("linux") else None)
    tq = _torch()
    if not gpu and tq:  # AMD на Windows и прочее: только память, без загрузки и температуры
        gpu = {"name": tq["name"], "util": None, "temp": None, "vram_used": tq["total"] - tq["free"], "vram_total": tq["total"]}
    return {"t": time.time(), "cpu": _cpu(), "ram_used": used, "ram_total": total, "proc_ram": proc,
            "gpu": gpu, "torch": tq and {"alloc": tq["alloc"], "reserved": tq["reserved"]}}


def slow_clock(g):
    """GPU занят (>=80%), а частота ниже половины максимума: в этом состоянии карта считает в десятки раз медленнее
    (драйвер не поднял P-state / питание), и виноват не сэмплер. Видно по «GPU 100%, но 48 °C»."""
    c, m = (g or {}).get("clock"), (g or {}).get("clock_max")
    return bool(c and m and (g.get("util") or 0) >= 80 and c < 0.5 * m)


def gpu_now():
    """Свежие показатели видеокарты (NVML / sysfs; nvidia-smi — запасной путь с кэшем)."""
    return _nvidia() or (_amd_sysfs() if sys.platform.startswith("linux") else None) or {}


def gpu_brief():
    """Строка о видеокарте для предупреждений: загрузка, температура, частота, мощность."""
    g = gpu_now()
    parts = []
    if g.get("util") is not None:
        parts.append(f"{g['util']:.0f}%")
    if g.get("temp"):
        parts.append(f"{g['temp']:.0f}°C")
    if g.get("clock"):
        parts.append(f"{g['clock']:.0f} MHz" + (f" из {g['clock_max']:.0f}" if g.get("clock_max") else ""))
    if g.get("power"):
        parts.append(f"{g['power']:.0f} W")
    return " · ".join(parts)


# ---------- фон ----------
def _loop():
    global _last
    last_log = 0.0
    while True:
        run = _busy()
        if run or time.time() - _wanted < 10:
            try:
                s = sample()
            except Exception as e:
                s = {"t": time.time(), "error": f"{type(e).__name__}: {e}"}
            with _lock:
                _last = s
                _hist.append({k: s.get(k) for k in ("t", "cpu", "ram_used")} | {
                    "gpu": (s.get("gpu") or {}).get("util"), "vram": (s.get("gpu") or {}).get("vram_used")})
            if run and "error" not in s:
                lim = limits()
                free = s["ram_total"] - s["ram_used"]
                if lim["ram_reserve_gb"] > 0 and free < lim["ram_reserve_gb"] * GB:
                    _on_low(f"свободной оперативной памяти {free / GB:.1f} ГБ — меньше запаса {lim['ram_reserve_gb']:g} ГБ: "
                            f"запуск остановлен, чтобы не повесить систему (уменьшите размер картинки или запас в "
                            f"«Сервер → Производительность и лимиты…»)")
                if time.time() - last_log >= 5:
                    last_log = time.time()
                    _log("stats", line(s))
            time.sleep(1)
        else:
            time.sleep(0.5)


def line(s):
    g = s.get("gpu") or {}
    parts = [f"CPU {s.get('cpu')}%" if s.get("cpu") is not None else "CPU ?",
             f"RAM {s['ram_used'] / GB:.1f}/{s['ram_total'] / GB:.1f} ГБ (сервер {s['proc_ram'] / GB:.1f})"]
    if g:
        parts.append(f"GPU {g.get('util') if g.get('util') is not None else '?'}% {g.get('temp') or '?'}°C "
                     f"VRAM {g.get('vram_used', 0) / GB:.1f}/{g.get('vram_total', 0) / GB:.1f} ГБ")
        if g.get("clock"):
            parts.append(f"{g['clock']:.0f}" + (f"/{g['clock_max']:.0f}" if g.get("clock_max") else "") + " МГц")
        if g.get("power"):
            parts.append(f"{g['power']:.0f} Вт")
        if slow_clock(g):
            parts.append("частота ниже половины максимума — карта в низком P-state (драйвер/питание), "
                         "счёт идёт в разы медленнее")
    if s.get("torch"):
        parts.append(f"torch {s['torch']['alloc'] / GB:.1f}/{s['torch']['reserved'] / GB:.1f} ГБ")
    return " · ".join(parts)


def start():
    global _thread
    if not _thread:
        _thread = threading.Thread(target=_loop, daemon=True)
        _thread.start()


def stats():
    """Последний снимок и история для графиков (запрос держит фоновый сбор включённым)."""
    global _wanted
    _wanted = time.time()
    with _lock:
        last = _last
    if last is None:
        try:
            last = sample()
        except Exception as e:
            last = {"error": f"{type(e).__name__}: {e}"}
    with _lock:
        hist = list(_hist)
    return {**last, "limits": limits(), "history": hist}
