"""Реестр нод: декоратор @node, описание для UI (/api/nodes), загрузка модулей нод."""
import importlib.util
import inspect
import sys
import traceback
import types
from pathlib import Path

NODES = {}          # type → NodeDef
WIDGETS = {"STRING", "INT", "FLOAT", "BOOLEAN", "COMBO"}
IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


class Cancelled(Exception):
    """Запуск прерван пользователем (кнопка «Прервать»)."""


class NodeDef:
    def __init__(self, type_, fn, title, cat, inputs, outputs, hint, output, volatile, source):
        self.type, self.fn, self.title, self.cat = type_, fn, title, cat
        self.inputs, self.outputs, self.hint = inputs, outputs, hint
        self.output, self.volatile, self.source = output, volatile, source
        self.wants_ctx = "ctx" in inspect.signature(fn).parameters

    def to_json(self):
        return {
            "title": self.title, "cat": self.cat, "hint": self.hint, "output": self.output,
            "inputs": {k: {"type": t, **opts} for k, (t, opts) in self.inputs.items()},
            "outputs": [{"name": k, "type": t} for k, t in self.outputs.items()],
            "source": self.source,
        }


def _norm_inputs(inputs):
    out = {}
    for k, v in (inputs or {}).items():
        if isinstance(v, str):
            v = (v, {})
        t, opts = v[0], dict(v[1]) if len(v) > 1 else {}
        if isinstance(t, (list, tuple)):  # список вариантов = COMBO
            opts["options"] = list(t)
            t = "COMBO"
        if t == "COMBO" and "default" not in opts and opts.get("options"):
            opts["default"] = opts["options"][0]
        if t in WIDGETS:
            opts["widget"] = True
            opts.setdefault("default", {"STRING": "", "INT": 0, "FLOAT": 0.0, "BOOLEAN": False}.get(t))
        out[k] = (t, opts)
    return out


_loading = {"source": "builtin"}


def node(type_, title=None, cat="Прочее", inputs=None, outputs=None, hint="", output=False, volatile=False):
    """Регистрирует ноду. outputs — dict имя → тип; output=True — конечная нода (её результат показывается в UI);
    volatile=True — не кэшировать (случайные числа, время, внешние запросы, которые должны повторяться);
    volatile=функция(входы) — не кэшировать, когда она вернёт True (например, seed = -1)."""
    def deco(fn):
        NODES[type_] = NodeDef(type_, fn, title or type_, cat, _norm_inputs(inputs), dict(outputs or {}),
                               hint or (fn.__doc__ or "").strip(), output, volatile, _loading["source"])
        return fn
    return deco


def load_dir(path: Path, source: str, log):
    """Импортирует *.py и пакеты из папки. Ошибка в одном модуле не мешает остальным."""
    if not path.is_dir():
        return
    # пакеты-родители, чтобы в модулях нод работали относительные импорты (from .image import …)
    for pkg, where in (("maistep_nodes", []), (f"maistep_nodes.{source}", [str(path)])):
        if pkg not in sys.modules:
            m = types.ModuleType(pkg)
            m.__path__ = where
            sys.modules[pkg] = m
    for p in sorted(path.iterdir()):
        if p.name.startswith(("_", ".")):
            continue
        if p.is_dir() and (p / "__init__.py").is_file():
            file = p / "__init__.py"
        elif p.suffix == ".py":
            file = p
        else:
            continue
        name = f"maistep_nodes.{source}.{p.stem}"
        _loading["source"] = f"{source}/{p.name}"
        try:
            spec = importlib.util.spec_from_file_location(name, file, submodule_search_locations=[str(p)] if p.is_dir() else None)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[name] = mod
            spec.loader.exec_module(mod)
        except Exception:
            log("error", f"не загрузился модуль нод {source}/{p.name}:\n{traceback.format_exc()}")
        finally:
            _loading["source"] = "builtin"


def load_all(root: Path, log):
    NODES.clear()
    for k in [m for m in sys.modules if m == "maistep_nodes" or m.startswith("maistep_nodes.")]:
        del sys.modules[k]
    load_dir(root / "server" / "nodes", "nodes", log)
    load_dir(root / "custom_nodes", "custom_nodes", log)
    log("info", f"нод загружено: {len(NODES)}")


class Ctx:
    """Контекст исполнения ноды: прогресс, стриминг текста, лог, отмена, папки проекта."""

    def __init__(self, run, node_id, root: Path):
        self._run, self.node_id, self.root = run, node_id, root
        self.input_dir, self.output_dir = root / "input", root / "output"

    def progress(self, value, max_=None):
        self._run.emit("progress", {"node": self.node_id, "value": value, "max": max_})
        self.check()

    def stream(self, text):
        """Кусок текста по мере генерации — UI дописывает его в превью ноды."""
        self._run.emit("stream", {"node": self.node_id, "text": text})
        self.check()

    def log(self, text, level="info"):
        self._run.emit("log", {"node": self.node_id, "level": level, "text": str(text)})

    def check(self):
        if self._run.cancel.is_set():
            raise Cancelled()

    @property
    def settings(self):
        return self._run.settings
