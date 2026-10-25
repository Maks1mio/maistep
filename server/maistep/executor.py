"""Исполнение графа: проверка, порядок нод, кэш результатов между запусками (как в ComfyUI —
пересчитываются только изменённые ноды и всё, что ниже них).

Воркфлоу: { nodes: [{ id, type, props, mode? }], links: [{ from, out, to, in }] }.
mode: "mute" — нода выключена (не исполняется, её выходы = None).
"""
import hashlib
import json
import time
import traceback

from .registry import NODES, Ctx, Cancelled

CACHE = {}           # ключ входов → (выходы, ui)
CACHE_LIMIT = 500


class GraphError(Exception):
    def __init__(self, message, node=None):
        super().__init__(message)
        self.node = node


def _coerce(t, v):
    if v is None:
        return v
    try:
        if t == "INT":
            return int(float(v))
        if t == "FLOAT":
            return float(v)
        if t == "BOOLEAN":
            return v if isinstance(v, bool) else str(v).lower() in ("1", "true", "yes", "да")
        if t == "STRING" and not isinstance(v, str):
            return v if isinstance(v, (dict, list)) else str(v)
    except (TypeError, ValueError):
        raise GraphError(f"значение {v!r} не приводится к {t}")
    return v


def compatible(out_t, in_t):
    return out_t == in_t or "*" in (out_t, in_t) or "ANY" in (out_t, in_t) or (in_t == "STRING" and out_t in ("INT", "FLOAT", "JSON"))


def needed(wf):
    """Ноды, которые реально исполнятся: цели (targets, иначе конечные ноды, иначе все) и всё выше них."""
    nodes = {n["id"]: n for n in wf.get("nodes", [])}
    live = [n for n in nodes.values() if n.get("mode") != "mute"]
    out = lambda n: NODES.get(n["type"]) is not None and NODES[n["type"]].output  # noqa: E731
    targets = [t for t in wf.get("targets") or [] if t in nodes] or [n["id"] for n in live if out(n)] or [n["id"] for n in live]
    ins, seen, stack = {}, set(), list(targets)
    for l in wf.get("links", []):
        ins.setdefault(l["to"], []).append(l["from"])
    while stack:
        nid = stack.pop()
        if nid in seen or nid not in nodes:
            continue
        seen.add(nid)
        stack.extend(ins.get(nid, []))
    return targets, seen


def _models(cat):
    from . import library
    try:
        return set(library.names(cat))
    except Exception:  # библиотека недоступна — не мешаем запуску, ошибку покажет сама нода
        return _Any()


class _Any:
    def __contains__(self, _):
        return True


def check(wf, only_needed=False):
    """Список замечаний [{node, message}] без исполнения; only_needed — только ноды, которые исполнятся."""
    issues = []
    nodes = {n["id"]: n for n in wf.get("nodes", [])}
    linked = {(l["to"], l["in"]) for l in wf.get("links", [])}
    keep = needed(wf)[1] if only_needed else set(nodes)
    for n in nodes.values():
        if n["id"] not in keep or (only_needed and n.get("mode") == "mute"):
            continue
        d = NODES.get(n["type"])
        if not d:
            issues.append({"node": n["id"], "message": f"неизвестный тип ноды {n['type']}"})
            continue
        for k, (t, opts) in d.inputs.items():
            if not opts.get("widget") and not opts.get("optional") and (n["id"], k) not in linked:
                issues.append({"node": n["id"], "message": f"вход «{k}» ({t}) не подключён"})
            elif opts.get("picker") == "library_model" and (n["id"], k) not in linked:
                name = (n.get("props") or {}).get(k, opts.get("default"))
                if name and name not in _models(opts.get("cat")):
                    issues.append({"node": n["id"], "message": f"{k}: модели «{name}» нет в библиотеке ({opts.get('cat')})"})
    for l in wf.get("links", []):
        a, b = nodes.get(l["from"]), nodes.get(l["to"])
        if l.get("to") not in keep:
            continue
        if not a or not b:
            issues.append({"node": l.get("to"), "message": f"связь {l['from']}→{l['to']}: нет ноды"})
            continue
        da, db = NODES.get(a["type"]), NODES.get(b["type"])
        if not da or not db:
            continue
        ot, it = da.outputs.get(l["out"]), db.inputs.get(l["in"], (None,))[0]
        if ot is None or it is None:
            issues.append({"node": b["id"], "message": f"связь {l['from']}.{l['out']}→{l['to']}.{l['in']}: нет такого пина"})
        elif not compatible(ot, it):
            issues.append({"node": b["id"], "message": f"вход «{l['in']}» ждёт {it}, а подключён {ot}"})
    return issues


def _order(wf, targets):
    nodes = {n["id"]: n for n in wf["nodes"]}
    ins = {}
    for l in wf.get("links", []):
        ins.setdefault(l["to"], []).append(l)
    order, state = [], {}

    def visit(nid):
        if state.get(nid) == 2:
            return
        if state.get(nid) == 1:
            raise GraphError("в графе цикл", nid)
        state[nid] = 1
        for l in ins.get(nid, []):
            if l["from"] in nodes:
                visit(l["from"])
        state[nid] = 2
        order.append(nid)

    for t in targets:
        visit(t)
    return order, ins


def preview(t, v):
    """Короткое представление значения для UI."""
    if v is None:
        return None
    if t == "IMAGE" and isinstance(v, dict):
        return {"image": v.get("file")}
    if isinstance(v, (dict, list)):
        s = json.dumps(v, ensure_ascii=False, indent=1)
    else:
        s = str(v)
    return {"text": s[:4000] + ("…" if len(s) > 4000 else "")}


def run(wf, runner, root):
    """Исполнить граф; runner — объект запуска (emit, cancel, settings). Возвращает {node: {выход: превью}}."""
    for i in check(wf):
        raise GraphError(i["message"], i["node"])
    nodes = {n["id"]: n for n in wf["nodes"]}
    live = [n for n in wf["nodes"] if n.get("mode") != "mute"]
    targets = [t for t in wf.get("targets") or [] if t in nodes] \
        or [n["id"] for n in live if NODES[n["type"]].output] or [n["id"] for n in live]
    if not targets:
        raise GraphError("граф пуст")
    order, ins = _order(wf, targets)
    values, keys, results = {}, {}, {}
    # A volatile node (seed = -1, time, random number) produces a new value on every run, so the cache
    # must be bypassed for it and for everything downstream: otherwise VAE Decode returns the previous run's image.
    dynamic = {}  # nid -> result is non-deterministic (recompute, do not write to cache)
    for nid in order:
        runner.cancel_check()
        n = nodes[nid]
        d = NODES[n["type"]]
        if n.get("mode") == "mute":
            values[nid] = {k: None for k in d.outputs}
            keys[nid] = "mute"
            dynamic[nid] = False
            continue
        props = n.get("props") or {}
        args, key_parts = {}, [n["type"]]
        links_in = {l["in"]: l for l in ins.get(nid, [])}
        inherited = False
        for k, (t, opts) in d.inputs.items():
            if k in links_in:
                l = links_in[k]
                args[k] = _coerce(t, values[l["from"]].get(l["out"]))
                key_parts.append(f"{k}<{keys[l['from']]}.{l['out']}")
                inherited = inherited or dynamic.get(l["from"], False)
            else:
                args[k] = _coerce(t, props.get(k, opts.get("default")))
                key_parts.append(f"{k}={json.dumps(args[k], sort_keys=True, ensure_ascii=False, default=str)}")
        key = hashlib.sha1("|".join(key_parts).encode()).hexdigest()
        keys[nid] = key
        volatile = d.volatile(args) if callable(d.volatile) else d.volatile
        dynamic[nid] = bool(volatile) or inherited
        if not dynamic[nid] and key in CACHE:
            values[nid], ui = CACHE[key]
            results[nid] = ui
            runner.emit("executed", {"node": nid, "output": ui, "cached": True})
            continue
        runner.emit("executing", {"node": nid})
        t0 = time.time()
        try:
            if d.wants_ctx:
                args["ctx"] = Ctx(runner, nid, root)
            r = d.fn(**args)
        except Cancelled:
            raise
        except GraphError as e:
            e.node = e.node or nid
            raise
        except Exception as e:
            raise GraphError(f"{type(e).__name__}: {e}\n{traceback.format_exc(limit=6)}", nid)
        if not isinstance(r, dict) or (len(d.outputs) == 1 and next(iter(d.outputs)) not in r and "ui" not in r):
            r = {next(iter(d.outputs)): r} if d.outputs else {}
        extra = r.pop("ui", None) if isinstance(r, dict) else None
        out = {k: r.get(k) for k in d.outputs}
        ui = {k: preview(t, out[k]) for k, t in d.outputs.items()}
        if extra:
            ui["_ui"] = extra
        ui["_time"] = round(time.time() - t0, 3)
        values[nid] = out
        results[nid] = ui
        if not dynamic[nid]:
            if len(CACHE) > CACHE_LIMIT:
                CACHE.pop(next(iter(CACHE)))
            CACHE[key] = (out, ui)
        runner.emit("executed", {"node": nid, "output": ui, "cached": False})
    return results
