# maistep

Нодовый редактор AI-пайплайнов в духе ComfyUI. Оболочка — OCST (Open Client Studio) из проекта mashit:
те же док-панели, UI Kit в стиле JetBrains New UI, Tauri v2. Исполнение графов — Python-сервер.

```
npm run app          # окно (cargo run; сам поднимает python server/main.py на :3300)
npm run app:web      # веб-режим без Rust: http://localhost:3210, свой сервер на :3310 (отладка UI)
npm run server       # только сервер исполнения
pip install -r requirements.txt   # пакет anthropic для ноды LLM (провайдер anthropic)
```

Требования: Rust 1.80+, Python 3.10+ (в PATH, `.venv/` проекта или `MAISTEP_PYTHON`), WebView2 на Windows.

## Устройство

```
app/src-tauri/   ядро Tauri: окно, команды (воркфлоу, файлы проекта), запуск/остановка Python-сервера
app/ui/          веб-UI (ES-модули без бандлера)
  js/graph.js      граф воркфлоу: пины по типам, виджеты, превью и стриминг на нодах, поиск нод
  js/backend.js    связь с сервером: каталог нод, очередь, события SSE
  js/nodeinsp.js   Inspector ноды / связи / воркфлоу
  js/results.js    очередь и история запусков, галерея
  js/codeedit.js   CodeEditor (Python/JS/Rust), «Сохранить и перезагрузить ноды»
app/dev-server.mjs веб-режим (те же команды, что ядро)
server/main.py   HTTP API + очередь + SSE (только стандартная библиотека)
server/maistep/  API нод (@node), исполнитель графа с кэшем
server/nodes/    встроенные ноды: значения, текст, JSON, логика, файлы, LLM, картинки
custom_nodes/    свои ноды (пример — example.py)
workflows/       графы *.json
input/ output/   входные файлы и результаты (в .gitignore)
user/settings.json  ключи API (в .gitignore)
```

## Рабочие области

- **Workflow** (1) — граф. Палитра слева, двойной щелчок/Space/ПКМ по фону — поиск нод; связь от выхода к входу
  (бросить в пустоту — поиск подходящей ноды с автоподключением); у виджетов тоже есть пин — связь перекрывает значение.
  Двойной щелчок по виджету — правка, числа тянутся мышью, ‹ › — шаг; M — выключить ноду, Ctrl+D, Ctrl+C/V, F — вписать.
  Ctrl+Enter — запуск, Ctrl+Shift+Enter — прервать, ПКМ по ноде → «Выполнить до этой ноды». Картинки из Project
  или из проводника ОС бросаются на граф (нода «Загрузить картинку»).
- **Results** (2) — очередь и история; «Открыть граф» восстанавливает воркфлоу запуска.
- **CodeEditor** (3) — свои ноды на Python; сохранение перезагружает ноды на сервере без перезапуска.
- **UI Kit** (4) — витрина компонентов оболочки.

Сервер кэширует результаты нод между запусками: пересчитывается только изменённое и всё ниже (seed у LLM — чтобы
получить новый ответ). Ответ LLM стримится прямо на ноду.

## Своя нода

```python
from maistep import node

@node("text.upper", title="ВЕРХНИЙ РЕГИСТР", cat="Мои ноды",
      inputs={"text": ("STRING", {"multiline": True})}, outputs={"text": "STRING"})
def upper(text, ctx):          # ctx — необязательный: ctx.progress, ctx.stream, ctx.log, ctx.settings
    return text.upper()
```

Типы: STRING INT FLOAT BOOLEAN COMBO IMAGE JSON `*`. `output=True` — конечная нода (её результат в UI),
`volatile=True` — без кэша.

## Models — библиотека моделей ComfyUI (только чтение)

Рабочая область **Models** (клавиша 3): модели из тех же папок, что видит ComfyUI — yaml Comfy Desktop
(`%APPDATA%\Comfy Desktop\instance-model-paths\*.yaml`) плюс `model_roots` из `user/settings.json`
(по умолчанию D:\ComfyUI\models и папки Comfy Desktop). В папках моделей ничего не пишется; кэш заголовков —
`user/library_meta.json`.

- Hierarchy — категории (checkpoints, loras, unet, vae…) с числом и объёмом, корни; галерея — превью `.preview.jpeg`,
  поиск по имени/базе/триггер-словам, сортировка, размер плиток; NSFW-превью размыты (по флагу из `.cminfo.json`).
- Карточка в Inspector: база (Illustrious, Pony…), архитектура и параметры из заголовка safetensors, триггер-слова и теги
  (щелчок — копировать), ссылка Civitai, описание, метаданные; «Нода в граф» / двойной щелчок по плитке.
- Нода **«Модель из библиотеки»**: категория + модель (галерея по щелчку) → имя для ComfyUI, триггер-слова, сведения.

## ComfyUI — мост к запущенному ComfyUI (http://127.0.0.1:8188)

Генерация идёт в вашем ComfyUI (его GPU, модели и custom nodes); maistep отправляет промпт в `/prompt`, следит за
прогрессом по WebSocket и забирает картинки в `output/comfy/`. Статус ComfyUI — в попапе сервера и в Inspector нод;
если он выключен — кнопка «Запустить Comfy Desktop» (меню Сервер). Адрес меняется полем `comfy_url` в `user/settings.json`.

- **«Генерация (ComfyUI)»**: чекпоинт и до 3 LoRA из библиотеки (галерея по щелчку), промпты, размер, шаги, cfg,
  сэмплер/шедулер (списки берутся из ComfyUI), clip skip, seed (-1 — новый при каждом запуске), батч; с входом image —
  img2img (denoise). В выходную папку ComfyUI ничего не пишется (PreviewImage), результат — на ноде и в `output/comfy/`.
- **«Воркфлоу ComfyUI»**: любой сохранённый воркфлоу ComfyUI (`ComfyUI/user/default/workflows` или `comfy_workflows/`
  maistep, формат UI или API) запускается как есть. UI-формат переводится в API сам: Reroute, Primitive, bypass (mode 4),
  выключенные ноды, старые имена классов. Входы a–d подставляются в поля воркфлоу строками `a → id.поле`; в Inspector —
  список полей с кнопками a–d. Картинки на входах сами загружаются в ComfyUI. Сиды — «из файла» или «случайные».
- «Прервать» в maistep прерывает и задачу в ComfyUI. Шаблон: Файл → «Генерация по идее (ComfyUI)» (идея → LLM-промпт → картинка).

## LLM

Провайдеры — **Файл → Провайдеры LLM…** (хранятся в `user/settings.json`, он в .gitignore; в UI ключ виден только маской):
- **CheapVibeCode** (по умолчанию, тип «агрегатор»): Claude — через `<base>/messages` официальным SDK `anthropic`,
  остальные модели (GPT, Gemini, Grok, DeepSeek, Qwen) — через `<base>/chat/completions`; каталог — `<base>/models`.
- **Anthropic**, **OpenAI-совместимый** (OpenAI, LM Studio, OpenRouter, vLLM), **Ollama**, свои — кнопка «+ Провайдер».

Каталог моделей кэшируется на 6 ч (`user/models_cache.json`). В ноде «LLM» щелчок по полю model открывает поиск по
каталогу: группы по компаниям, значки 👁 (картинки на входе), 🧠 (reasoning), контекст и множитель цены.
Если модель не принимает картинки, вход image на ноде скрыт. Python-пакеты — только в `.venv`:
`.venv\Scripts\python -m pip install -r requirements.txt`.
