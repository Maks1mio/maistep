"""Базовые ноды: значения, текст, JSON, логика, вывод."""
import json
import math
import random
import re
import time
import urllib.request
from pathlib import Path

from maistep import node

# ---------- значения ----------


@node("value.text", title="Текст", cat="Значения", inputs={"text": ("STRING", {"multiline": True})}, outputs={"text": "STRING"})
def value_text(text):
    return text


@node("value.int", title="Целое", cat="Значения", inputs={"value": ("INT", {"default": 0})}, outputs={"value": "INT"})
def value_int(value):
    return value


@node("value.float", title="Число", cat="Значения", inputs={"value": ("FLOAT", {"default": 0.0, "step": 0.1})}, outputs={"value": "FLOAT"})
def value_float(value):
    return value


@node("value.bool", title="Да / нет", cat="Значения", inputs={"value": ("BOOLEAN", {})}, outputs={"value": "BOOLEAN"})
def value_bool(value):
    return value


@node("value.random", title="Случайное число", cat="Значения", volatile=True,
      inputs={"min": ("INT", {"default": 0}), "max": ("INT", {"default": 2**31 - 1})}, outputs={"value": "INT"},
      hint="Новое значение при каждом запуске (seed для генерации).")
def value_random(min, max):
    return random.randint(min, max)


@node("value.now", title="Дата и время", cat="Значения", volatile=True,
      inputs={"format": ("STRING", {"default": "%Y-%m-%d %H:%M"})}, outputs={"text": "STRING"})
def value_now(format):
    return time.strftime(format)

# ---------- текст ----------


@node("text.concat", title="Склеить текст", cat="Текст",
      inputs={"a": ("STRING", {"multiline": True}), "b": ("STRING", {"multiline": True}), "sep": ("STRING", {"default": "\\n"})},
      outputs={"text": "STRING"})
def text_concat(a, b, sep):
    return a + sep.replace("\\n", "\n").replace("\\t", "\t") + b


@node("text.template", title="Шаблон", cat="Текст",
      inputs={"template": ("STRING", {"multiline": True, "default": "Тема: {a}\nСтиль: {b}"}),
              "a": ("*", {"optional": True}), "b": ("*", {"optional": True}), "c": ("*", {"optional": True}), "d": ("*", {"optional": True})},
      outputs={"text": "STRING"}, hint="Подставляет входы a b c d вместо {a} {b} {c} {d}.")
def text_template(template, a=None, b=None, c=None, d=None):
    vals = {"a": a, "b": b, "c": c, "d": d}
    return re.sub(r"\{([abcd])\}", lambda m: "" if vals[m[1]] is None else (vals[m[1]] if isinstance(vals[m[1]], str) else json.dumps(vals[m[1]], ensure_ascii=False)), template)


@node("text.replace", title="Заменить", cat="Текст",
      inputs={"text": ("STRING", {"multiline": True}), "find": ("STRING", {}), "replace": ("STRING", {}), "regex": ("BOOLEAN", {})},
      outputs={"text": "STRING"})
def text_replace(text, find, replace, regex):
    if not find:
        return text
    return re.sub(find, replace, text) if regex else text.replace(find, replace)


@node("text.split", title="Разбить на список", cat="Текст",
      inputs={"text": ("STRING", {"multiline": True}), "sep": ("STRING", {"default": "\\n"}), "skip_empty": ("BOOLEAN", {"default": True})},
      outputs={"list": "JSON", "count": "INT"})
def text_split(text, sep, skip_empty):
    parts = text.split(sep.replace("\\n", "\n").replace("\\t", "\t") or "\n")
    parts = [p.strip() for p in parts if p.strip() or not skip_empty]
    return {"list": parts, "count": len(parts)}


@node("text.join", title="Склеить список", cat="Текст",
      inputs={"list": ("JSON", {}), "sep": ("STRING", {"default": "\\n"})}, outputs={"text": "STRING"})
def text_join(list, sep):
    return sep.replace("\\n", "\n").join(x if isinstance(x, str) else json.dumps(x, ensure_ascii=False) for x in (list or []))


@node("text.extract", title="Вытащить по regex", cat="Текст",
      inputs={"text": ("STRING", {"multiline": True}), "pattern": ("STRING", {"default": "```(?:\\w+)?\\n([\\s\\S]*?)```"})},
      outputs={"match": "STRING", "all": "JSON"}, hint="Первая группа (или всё совпадение). По умолчанию — блок кода из ответа LLM.")
def text_extract(text, pattern):
    ms = list(re.finditer(pattern, text))
    pick = lambda m: m.group(1) if m.groups() else m.group(0)  # noqa: E731
    return {"match": pick(ms[0]) if ms else "", "all": [pick(m) for m in ms]}


@node("text.length", title="Длина текста", cat="Текст", inputs={"text": ("STRING", {"multiline": True})},
      outputs={"chars": "INT", "words": "INT", "lines": "INT"})
def text_length(text):
    return {"chars": len(text), "words": len(text.split()), "lines": len(text.splitlines())}

# ---------- JSON ----------


@node("json.parse", title="Разобрать JSON", cat="JSON", inputs={"text": ("STRING", {"multiline": True})}, outputs={"data": "JSON"},
      hint="Понимает и JSON внутри ```json …``` из ответа LLM.")
def json_parse(text):
    m = re.search(r"```(?:json)?\s*([\s\S]*?)```", text)
    return json.loads(m.group(1) if m else text)


@node("json.get", title="Поле JSON", cat="JSON",
      inputs={"data": ("JSON", {}), "path": ("STRING", {"default": "items.0.name"})}, outputs={"value": "*"},
      hint="Путь через точку; числа — индексы списков.")
def json_get(data, path):
    cur = data
    for part in [p for p in path.split(".") if p]:
        cur = cur[int(part)] if isinstance(cur, list) else (cur or {}).get(part)
    return cur


@node("json.build", title="Собрать JSON", cat="JSON",
      inputs={"a": ("*", {"optional": True}), "b": ("*", {"optional": True}), "c": ("*", {"optional": True}),
              "keys": ("STRING", {"default": "a,b,c"})}, outputs={"data": "JSON"})
def json_build(keys, a=None, b=None, c=None):
    names = [k.strip() for k in keys.split(",")] + ["a", "b", "c"]
    return {names[i]: v for i, v in enumerate([a, b, c]) if v is not None}

# ---------- логика и вычисления ----------

_SAFE = {k: getattr(math, k) for k in dir(math) if not k.startswith("_")} | {"abs": abs, "min": min, "max": max, "round": round, "len": len, "int": int, "float": float, "str": str}


@node("logic.expr", title="Выражение", cat="Логика",
      inputs={"expr": ("STRING", {"default": "a * 2 + b"}), "a": ("*", {"optional": True}), "b": ("*", {"optional": True}), "c": ("*", {"optional": True})},
      outputs={"result": "*"}, hint="Выражение Python над a, b, c и функциями math (sqrt, sin, …).")
def logic_expr(expr, a=None, b=None, c=None):
    return eval(expr, {"__builtins__": {}}, {**_SAFE, "a": a, "b": b, "c": c})


@node("logic.switch", title="Если", cat="Логика",
      inputs={"cond": ("BOOLEAN", {}), "then": ("*", {"optional": True}), "else": ("*", {"optional": True})}, outputs={"value": "*"})
def logic_switch(cond, **kw):
    return kw.get("then") if cond else kw.get("else")


@node("logic.compare", title="Сравнить", cat="Логика",
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


@node("logic.python", title="Python-код", cat="Логика",
      inputs={"code": ("STRING", {"multiline": True, "default": "result = str(a).upper()"}),
              "a": ("*", {"optional": True}), "b": ("*", {"optional": True}), "c": ("*", {"optional": True})},
      outputs={"result": "*"}, hint="Выполняет код с переменными a, b, c; результат — переменная result. Код исполняется локально без ограничений.")
def logic_python(code, a=None, b=None, c=None, ctx=None):
    env = {"a": a, "b": b, "c": c, "result": None, "ctx": ctx, "json": json, "re": re, "math": math}
    exec(code, env)
    return env["result"]

# ---------- файлы и сеть ----------


@node("io.read_text", title="Прочитать файл", cat="Файлы",
      inputs={"file": ("STRING", {"default": "input/notes.txt", "hint": "путь от корня проекта (input/…)"})}, outputs={"text": "STRING"})
def io_read_text(file, ctx):
    p = (ctx.root / file).resolve()
    if ctx.root.resolve() not in p.parents:
        raise ValueError("файл должен быть внутри проекта")
    return p.read_text("utf-8")


@node("io.http", title="HTTP-запрос", cat="Файлы", volatile=True,
      inputs={"url": ("STRING", {"default": "https://example.com"}), "method": (["GET", "POST"], {}),
              "body": ("STRING", {"multiline": True, "optional": True}), "headers": ("STRING", {"default": "{}", "hint": "JSON-объект заголовков"})},
      outputs={"text": "STRING", "status": "INT"})
def io_http(url, method, headers, body=""):
    req = urllib.request.Request(url, data=body.encode() if method == "POST" and body else None, method=method, headers=json.loads(headers or "{}"))
    with urllib.request.urlopen(req, timeout=60) as r:
        return {"text": r.read().decode("utf-8", "replace"), "status": r.status}

# ---------- вывод ----------


@node("output.show", title="Показать", cat="Вывод", output=True, inputs={"value": ("*", {})}, outputs={},
      hint="Конечная нода: значение видно на ноде и во вкладке Results.")
def output_show(value):
    return {"ui": {"text": value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2, default=str)}}


@node("output.save_text", title="Сохранить текст", cat="Вывод", output=True,
      inputs={"text": ("STRING", {"multiline": True}), "name": ("STRING", {"default": "result.md"})}, outputs={"file": "STRING"})
def output_save_text(text, name, ctx):
    stem, ext = Path(name).stem or "result", Path(name).suffix or ".txt"
    p = ctx.output_dir / f"{stem}_{time.strftime('%Y%m%d_%H%M%S')}{ext}"
    p.write_text(text, "utf-8")
    rel = p.relative_to(ctx.root).as_posix()
    return {"file": rel, "ui": {"text": text, "files": [rel]}}
