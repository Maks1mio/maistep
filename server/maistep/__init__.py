"""maistep — API для нод (встроенных и своих в custom_nodes/).

Нода — функция с декоратором @node. Входы — именованные аргументы, результат — dict выходов
(или одно значение, если выход один). Аргумент `ctx` (если есть) — контекст исполнения.

    from maistep import node

    @node("text.upper", title="ВЕРХНИЙ РЕГИСТР", cat="Текст",
          inputs={"text": ("STRING", {"multiline": True})},
          outputs={"text": "STRING"})
    def upper(text):
        return text.upper()

Типы: STRING INT FLOAT BOOLEAN COMBO (список вариантов) IMAGE JSON ANY ("*").
Входы STRING/INT/FLOAT/BOOLEAN/COMBO — виджеты на ноде (значение можно подать и связью),
остальные — только пины. Опции входа: default, min, max, step, multiline, options (COMBO), hint, optional.
"""
from .registry import node, NODES, Ctx, Cancelled, IMAGE_EXT

__all__ = ["node", "NODES", "Ctx", "Cancelled", "IMAGE_EXT"]
