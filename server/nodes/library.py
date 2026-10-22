"""Model library nodes (server/maistep/library.py — read only)."""
from maistep import node
from maistep import library as L

try:
    CATS = sorted(L.summary()["categories"]) or ["checkpoints"]
except Exception:  # папок нет — нода всё равно доступна
    CATS = ["checkpoints", "loras", "unet", "vae"]
DEFAULT_CAT = "loras" if "loras" in CATS else CATS[0]


@node("library.model", title="Library Model", cat="Loaders",
      inputs={"cat": (CATS, {"default": DEFAULT_CAT, "hint": "category (models subfolder)"}),
              "name": ("STRING", {"default": "", "picker": "library_model", "cat_input": "cat",
                                  "hint": "click — model gallery of the category"})},
      outputs={"name": "STRING", "triggers": "STRING", "info": "JSON"},
      hint="Model name, its trigger words (from .cminfo.json / training tags) and info: base, architecture, size.")
def library_model(cat, name):
    if not name:
        raise ValueError("no model selected")
    d = L.details(f"{cat}/{name}")
    civ = d.get("civitai") or {}
    triggers = civ.get("trained") or d.get("tags", [])[:10]
    info = {k: d.get(k) for k in ("cat", "name", "size", "arch", "params", "root")} | {
        "base": civ.get("base") or d.get("base"), "title": civ.get("name") or d.get("title"), "url": civ.get("url")}
    return {"name": name, "triggers": ", ".join(triggers), "info": info}
