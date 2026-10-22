"""Пример своих нод. Любой *.py (или пакет) в custom_nodes/ подхватывается при старте сервера
и по кнопке «Перезагрузить ноды» (CodeEditor / меню Сервер). API — server/maistep/__init__.py."""
from maistep import node


@node("custom.word_count", title="Word Count", cat="My Nodes",
      inputs={"text": ("STRING", {"multiline": True}), "top": ("INT", {"default": 5, "min": 1, "max": 50})},
      outputs={"report": "STRING", "words": "INT"})
def word_count(text, top):
    words = [w.strip(".,!?:;«»\"'()").lower() for w in text.split()]
    words = [w for w in words if w]
    freq = {}
    for w in words:
        freq[w] = freq.get(w, 0) + 1
    best = sorted(freq.items(), key=lambda x: -x[1])[:top]
    return {"report": "\n".join(f"{w}: {n}" for w, n in best), "words": len(words)}


@node("custom.slow_counter", title="Slow Counter", cat="My Nodes", volatile=True,
      inputs={"steps": ("INT", {"default": 5, "min": 1, "max": 100})}, outputs={"text": "STRING"},
      hint="Demonstrates progress and streaming: ctx.progress / ctx.stream.")
def slow_counter(steps, ctx):
    import time
    for i in range(steps):
        ctx.progress(i, steps)
        ctx.stream(f"step {i + 1}\n")
        time.sleep(0.3)
    ctx.progress(steps, steps)
    return f"done: {steps} steps"
