"""Basic nodes: values, text, JSON, logic, files, output."""
import json
import math
import random
import re
import time
import urllib.request
from pathlib import Path

from maistep import node

# ---------- values ----------


@node("value.text", title="Text", cat="Values", inputs={"text": ("STRING", {"multiline": True})}, outputs={"text": "STRING"})
def value_text(text):
    return text


@node("value.int", title="Integer", cat="Values", inputs={"value": ("INT", {"default": 0})}, outputs={"value": "INT"})
def value_int(value):
    return value


@node("value.float", title="Float", cat="Values", inputs={"value": ("FLOAT", {"default": 0.0, "step": 0.1})}, outputs={"value": "FLOAT"})
def value_float(value):
    return value


@node("value.bool", title="Boolean", cat="Values", inputs={"value": ("BOOLEAN", {})}, outputs={"value": "BOOLEAN"})
def value_bool(value):
    return value


@node("value.random", title="Random Number", cat="Values", volatile=True,
      inputs={"min": ("INT", {"default": 0}), "max": ("INT", {"default": 2**31 - 1})}, outputs={"value": "INT"},
      hint="A new value on every run (e.g. a seed).")
def value_random(min, max):
    return random.randint(min, max)


@node("value.now", title="Date & Time", cat="Values", volatile=True,
      inputs={"format": ("STRING", {"default": "%Y-%m-%d %H:%M"})}, outputs={"text": "STRING"})
def value_now(format):
    return time.strftime(format)

# ---------- text ----------


@node("text.concat", title="Concatenate Text", cat="Text",
      inputs={"a": ("STRING", {"multiline": True}), "b": ("STRING", {"multiline": True}), "sep": ("STRING", {"default": "\\n"})},
      outputs={"text": "STRING"})
def text_concat(a, b, sep):
    return a + sep.replace("\\n", "\n").replace("\\t", "\t") + b


@node("text.template", title="Text Template", cat="Text",
      inputs={"template": ("STRING", {"multiline": True, "default": "Topic: {a}\nStyle: {b}"}),
              "a": ("*", {"optional": True}), "b": ("*", {"optional": True}), "c": ("*", {"optional": True}), "d": ("*", {"optional": True})},
      outputs={"text": "STRING"}, hint="Substitutes inputs a b c d for {a} {b} {c} {d}.")
def text_template(template, a=None, b=None, c=None, d=None):
    vals = {"a": a, "b": b, "c": c, "d": d}
    return re.sub(r"\{([abcd])\}", lambda m: "" if vals[m[1]] is None else (vals[m[1]] if isinstance(vals[m[1]], str) else json.dumps(vals[m[1]], ensure_ascii=False)), template)


@node("text.replace", title="Replace Text", cat="Text",
      inputs={"text": ("STRING", {"multiline": True}), "find": ("STRING", {}), "replace": ("STRING", {}), "regex": ("BOOLEAN", {})},
      outputs={"text": "STRING"})
def text_replace(text, find, replace, regex):
    if not find:
        return text
    return re.sub(find, replace, text) if regex else text.replace(find, replace)


@node("text.split", title="Split to List", cat="Text",
      inputs={"text": ("STRING", {"multiline": True}), "sep": ("STRING", {"default": "\\n"}), "skip_empty": ("BOOLEAN", {"default": True})},
      outputs={"list": "JSON", "count": "INT"})
def text_split(text, sep, skip_empty):
    parts = text.split(sep.replace("\\n", "\n").replace("\\t", "\t") or "\n")
    parts = [p.strip() for p in parts if p.strip() or not skip_empty]
    return {"list": parts, "count": len(parts)}


@node("text.join", title="Join List", cat="Text",
      inputs={"list": ("JSON", {}), "sep": ("STRING", {"default": "\\n"})}, outputs={"text": "STRING"})
def text_join(list, sep):
    return sep.replace("\\n", "\n").join(x if isinstance(x, str) else json.dumps(x, ensure_ascii=False) for x in (list or []))


@node("text.extract", title="Regex Extract", cat="Text",
      inputs={"text": ("STRING", {"multiline": True}), "pattern": ("STRING", {"default": "```(?:\\w+)?\\n([\\s\\S]*?)```"})},
      outputs={"match": "STRING", "all": "JSON"}, hint="First group (or the whole match). Default pattern — a code block from an LLM answer.")
def text_extract(text, pattern):
    ms = list(re.finditer(pattern, text))
    pick = lambda m: m.group(1) if m.groups() else m.group(0)  # noqa: E731
    return {"match": pick(ms[0]) if ms else "", "all": [pick(m) for m in ms]}


@node("text.length", title="Text Length", cat="Text", inputs={"text": ("STRING", {"multiline": True})},
      outputs={"chars": "INT", "words": "INT", "lines": "INT"})
def text_length(text):
    return {"chars": len(text), "words": len(text.split()), "lines": len(text.splitlines())}

# ---------- JSON ----------


@node("json.parse", title="Parse JSON", cat="JSON", inputs={"text": ("STRING", {"multiline": True})}, outputs={"data": "JSON"},
      hint="Also understands JSON inside ```json …``` from an LLM answer.")
def json_parse(text):
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    return json.loads(m.group(1) if m else text)


@node("json.get", title="Get JSON Field", cat="JSON",
      inputs={"data": ("JSON", {}), "path": ("STRING", {"default": "items.0.name"})}, outputs={"value": "*"},
      hint="Dot path; numbers are list indexes.")
def json_get(data, path):
    cur = data
    for part in [p for p in path.split(".") if p]:
        cur = cur[int(part)] if isinstance(cur, list) else (cur or {}).get(part)
    return cur


@node("json.build", title="Build JSON", cat="JSON",
      inputs={"a": ("*", {"optional": True}), "b": ("*", {"optional": True}), "c": ("*", {"optional": True}),
              "keys": ("STRING", {"default": "a,b,c"})}, outputs={"data": "JSON"})
def json_build(keys, a=None, b=None, c=None):
    names = [k.strip() for k in keys.split(",")] + ["a", "b", "c"]
    return {names[i]: v for i, v in enumerate([a, b, c]) if v is not None}

# ---------- logic ----------

_SAFE = {k: getattr(math, k) for k in dir(math) if not k.startswith("_")} | {"abs": abs, "min": min, "max": max, "round": round, "len": len, "int": int, "float": float, "str": str}


@node("logic.expr", title="Math Expression", cat="Logic",
      inputs={"expr": ("STRING", {"default": "a * 2 + b"}), "a": ("*", {"optional": True}), "b": ("*", {"optional": True}), "c": ("*", {"optional": True})},
      outputs={"result": "*"}, hint="Python expression over a, b, c and math functions (sqrt, sin, …).")
def logic_expr(expr, a=None, b=None, c=None):
    return eval(expr, {"__builtins__": {}}, {**_SAFE, "a": a, "b": b, "c": c})


@node("logic.switch", title="Switch", cat="Logic",
      inputs={"cond": ("BOOLEAN", {}), "then": ("*", {"optional": True}), "else": ("*", {"optional": True})}, outputs={"value": "*"})
def logic_switch(cond, **kw):
    return kw.get("then") if cond else kw.get("else")


@node("logic.compare", title="Compare", cat="Logic",
      inputs={"a": ("*", {"optional": True}), "op": (["==", "!=", "<", "<=", ">", ">=", "contains"], {}), "b": ("STRING", {})},
      outputs={"result": "BOOLEAN"})
def logic_compare(op, b, a=None):
    if op == "contains":
        return str(b) in str(a)
    try:
        a, b = float(a), float(b)
    except (TypeError, ValueError):
        a, b = str(a), str(b)
    return {"==": a == b, "!=": a != b, "<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[op]


@node("logic.python", title="Python Code", cat="Logic",
      inputs={"code": ("STRING", {"multiline": True, "default": "result = str(a).upper()"}),
              "a": ("*", {"optional": True}), "b": ("*", {"optional": True}), "c": ("*", {"optional": True})},
      outputs={"result": "*"}, hint="Runs code with variables a, b, c; the result is the variable result. Runs locally without a sandbox.")
def logic_python(code, a=None, b=None, c=None, ctx=None):
    env = {"a": a, "b": b, "c": c, "result": None, "ctx": ctx, "json": json, "re": re, "math": math}
    exec(code, env)
    return env["result"]

# ---------- portals ----------
# Portal — вход: значение любого типа; Portal Exit — выходы, где угодно на холсте, без проводов. Связь портал → выход
# невидимая: её дорисовывает executor.portals() перед проверкой и запуском (вход `_link` у выхода скрыт в UI).


@node("portal.in", title="Portal", cat="Portal",
      inputs={"value": ("*", {}), "name": ("STRING", {"default": "portal", "hint": "label shown on its exits"})},
      outputs={"value": "*"},
      hint="Entry point: send any value (model, image, text…) to Portal Exit nodes anywhere on the canvas — no wires. "
           "Right-click → «Создать выход».")
def portal_in(value, name):
    return value


@node("portal.out", title="Portal Exit", cat="Portal",
      inputs={"portal": ("STRING", {"default": "", "portal": True, "hint": "which Portal this exit receives from"}),
              "order": ("INT", {"default": 1, "min": 0, "max": 99, "hint": "run order: branches after exit 1 run first, then 2…"}),
              "_link": ("*", {"optional": True, "hidden": True})},
      outputs={"value": "*"},
      hint="Receives the value of its Portal. Several exits run their branches in the order of their numbers.")
def portal_out(portal, order, _link=None):
    return _link


# ---------- missing (import placeholder) ----------
# Нода из импортированного графа (ComfyUI, A1111 …), которой в maistep нет: props.missing = {node, source, inputs,
# outputs, values, note}. Пины берутся оттуда (UI graph.js nodeDef, executor.pins), связи сохраняются; проверка графа
# сообщает о ней, выключенная (mute) пропускает вход того же имени/типа насквозь.


@node("core.missing", title="Missing Node", cat="Other",
      inputs={"missing": ("JSON", {"optional": True, "hidden": True})}, outputs={},
      hint="Placeholder from an imported workflow: maistep has no such node. Its pins and values are kept — "
           "bypass it (mute) to pass the input through, replace it with a maistep node, or implement it.")
def missing(missing=None):
    m = missing or {}
    raise RuntimeError(f"нода «{m.get('node', '?')}» ({m.get('source', 'импорт')}) не реализована в maistep — "
                       "замените её, выключите (mute) или реализуйте")


# ---------- files and network ----------


@node("io.read_text", title="Read Text File", cat="Files",
      inputs={"file": ("STRING", {"default": "input/notes.txt", "hint": "path from the project root (input/…)"})}, outputs={"text": "STRING"})
def io_read_text(file, ctx):
    p = (ctx.root / file).resolve()
    if ctx.root.resolve() not in p.parents:
        raise ValueError("the file must be inside the project")
    return p.read_text("utf-8")


@node("io.http", title="HTTP Request", cat="Files", volatile=True,
      inputs={"url": ("STRING", {"default": "https://example.com"}), "method": (["GET", "POST"], {}),
              "body": ("STRING", {"multiline": True, "optional": True}), "headers": ("STRING", {"default": "{}", "hint": "headers as a JSON object"})},
      outputs={"text": "STRING", "status": "INT"})
def io_http(url, method, headers, body=""):
    req = urllib.request.Request(url, data=body.encode() if method == "POST" and body else None, method=method, headers=json.loads(headers or "{}"))
    with urllib.request.urlopen(req, timeout=60) as r:
        return {"text": r.read().decode("utf-8", "replace"), "status": r.status}

# ---------- output ----------


@node("output.show", title="Show", cat="Output", output=True, inputs={"value": ("*", {})}, outputs={},
      hint="Output node: the value is shown on the node and in Results.")
def output_show(value):
    return {"ui": {"text": value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2, default=str)}}


@node("output.save_text", title="Save Text", cat="Output", output=True,
      inputs={"text": ("STRING", {"multiline": True}), "name": ("STRING", {"default": "result.md"})}, outputs={"file": "STRING"})
def output_save_text(text, name, ctx):
    stem, ext = Path(name).stem or "result", Path(name).suffix or ".txt"
    p = ctx.output_dir / f"{stem}_{time.strftime('%Y%m%d_%H%M%S')}{ext}"
    p.write_text(text, "utf-8")
    rel = p.relative_to(ctx.root).as_posix()
    return {"file": rel, "ui": {"text": text, "files": [rel]}}
