# maistep

Нодовый редактор AI-пайплайнов в духе ComfyUI: окно на Tauri v2 с док-панелями и UI Kit в стиле JetBrains New UI,
исполнение графов — Python-сервер.

```
npm run app          # окно (cargo run; сам поднимает python server/main.py на :3300)
npm run app:web      # веб-режим без Rust: http://localhost:3210, свой сервер на :3310 (отладка UI)
npm run server       # только сервер исполнения
pip install -r requirements.txt   # пакеты нод: anthropic (LLM), diffusers (генерация Stable Diffusion)
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
custom_nodes/    свои ноды (в репозитории только пример — example.py)
defaults/workflows/  стартовые воркфлоу: копируются в workflows/, пока там пусто (scripts/sync-defaults.mjs из templates.js)
scripts/         release.mjs — установщик и релиз, sync-defaults.mjs
workflows/       графы пользователя *.json (не в git)
input/ output/   входные файлы и результаты (не в git)
user/            ключи API, история, кэши (не в git)
```

## Что в репозитории

`.gitignore` — белый список: в git, в установщик и в обновления попадают только `app/` (ядро и UI), `server/`, `mcp/`,
`defaults/`, `custom_nodes/example.py`, `scripts/`, `components.json`, `requirements.txt`, `package*.json`, `README.md`.
Всё остальное в корне игнорируется само: `workflows/ user/ input/ output/` (графы, ключи, история, картинки),
`.venv/`, `dist/`, `update/`, `manifest.json`, заметки ИИ-ассистентов (`CLAUDE.md`, `.claude/`, `kilo.json`).
Новую папку для приложения нужно явно добавить в `.gitignore` (`!/папка/`) и в `PAYLOAD` в `scripts/release.mjs`.

## Установка и обновления

Установщики в GitHub Releases: Windows — `maistep-<версия>-setup-win.exe`, Linux — `maistep-<версия>-setup-linux.AppImage`
(`chmod +x` и запустить). Окно в стиле UI Kit, выбор папки, ярлыки на рабочем столе / в меню («Пуск» или `.desktop`)
по галочке, портативный Python 3.12 по галочке. Это тот же бинарь приложения (`maistep.exe` / `maistep.AppImage`)
с архивом приложения в конце — без прав администратора и сторонних инсталляторов. AppImage несёт WebKitGTK и прочие
библиотеки окна; нужен FUSE (`libfuse2`), без него — `APPIMAGE_EXTRACT_AND_RUN=1`.

maistep — **portable**: всё живёт в выбранной папке — файлы приложения, `.venv` и `python/`, данные окна
(`user/webview`), графы, ключи, картинки. Реестр и AppData не используются; вне папки — только ярлыки, если их
выбрать. Папку можно перенести или удалить целиком. Удаление — `uninstall.cmd` / `uninstall.sh` (или `maistep.exe
--uninstall`): убирает файлы приложения, `.venv`, `python/` и ярлыки, данные (`workflows user input output`) — по
выбору; другие файлы в папке не трогает. Без окна: `maistep-…-setup-win.exe --silent --dir <папка> [--desktop]
[--start-menu] [--python]`, `maistep.exe --uninstall --silent [--keep-data]` (на Linux — то же с AppImage). Без портативного Python при первом запуске `.venv` создаётся из
Python системы 3.10+ (на свой страх: версия и пакеты дистрибутива бывают неподходящими — сборки PyTorch для AMD только
до 3.14, на Debian/Ubuntu нужен `python3-venv`; установщик и консоль об этом предупреждают); пакеты генерации и LLM ставятся в «Компонентах».

Обновления приходят сами: сервер при старте и раз в час смотрит последний стабильный релиз. В релизе один файл
обновления для всех систем — `maistep-<версия>-update.mai`: оглавление (sha256 каждого файла приложения и бинари
по платформам) и сжатые данные. Сервер читает только оглавление (HTTP Range), сверяет с диском и в фоне качает
**только нужные куски**: изменившиеся файлы и бинарь своей системы (`maistep.exe` или `maistep.AppImage`) — его
только если изменился код Rust; правки UI, сервера и нод — килобайты. Всё складывается в `update/staging/`, уже
скачанное повторно не качается. Скачанное применяется при перезапуске окна («Компоненты» →
«Перезапустить») или при следующем запуске; `workflows/ user/ input/ output/ .venv` не трогаются никогда. UI грузится
с диска (`app/ui`), вшитый в exe — запасной. В git-копии (есть `.git`) обновлятор только показывает версию.
Пока репозиторий приватный, нужен токен: `user/settings.json` → `"update": {"token": "…"}` (`"auto": false` —
не качать самому).

Релиз собирает GitHub Actions (`.github/workflows/release.yml`): поднимите `"version"` в `package.json` и запушьте
в main — на Windows и Ubuntu соберутся установщики, из обоих бинарей — `maistep-<версия>-update.mai`, и выйдет
релиз `v<версия>` со списком изменений (в 0.1.2 ещё `manifest.json` + `maistep.exe` — чтобы обновились копии 0.1.1;
`LEGACY` в `scripts/release.mjs`). Если релиз с этой версией уже есть, сборка пропускается; вручную — Actions → release → Run workflow.
Вручную, без CI:

```
node scripts/release.mjs version 0.2.0   # номер ещё и в tauri.conf.json, Cargo.toml, components.json (необязательно)
node scripts/release.mjs build           # установщик и бинарь под текущую ОС в dist/ (из HEAD; --dirty — из рабочей копии)
node scripts/release.mjs pack            # dist/maistep-<версия>-update.mai из всех собранных бинарей (dist/bin/*)
node scripts/release.mjs publish         # gh release create v0.2.0 (нужны обе ОС; --notes "текст" вместо автосписка)
```

## Рабочие области

- **Workflow** (1) — граф. Палитра слева, двойной щелчок/Space/ПКМ по фону — поиск нод; связь от выхода к входу
  (бросить в пустоту — поиск подходящей ноды с автоподключением); у виджетов тоже есть пин — связь перекрывает значение.
  Двойной щелчок по виджету — правка, числа тянутся мышью, ‹ › — шаг; M — выключить ноду, Ctrl+D, Ctrl+C/V, F — вписать.
  Ctrl+Enter — запуск, Ctrl+Shift+Enter — прервать, ПКМ по ноде → «Выполнить до этой ноды». Картинки из Project
  или из проводника ОС бросаются на граф (нода Load Image).
- **Results** (2) — очередь и история; «Открыть граф» восстанавливает воркфлоу запуска.
- **Models** (3) — библиотека моделей на диске.
- **Civitai** (4) — поиск и загрузка моделей с Civitai прямо в папки библиотеки.
- **CodeEditor** (5) — свои ноды на Python; сохранение перезагружает ноды на сервере без перезапуска.
- **Компоненты** (6) — Python-пакеты генерации и LLM в `.venv` и обновления самого maistep.
- **ImageNaizer** (7) — правка готовой картинки по выделению: детализировать область или перерисовать объект по промпту.
- **UI Kit** (8) — витрина компонентов оболочки.

Редактор помнит всё между запусками: раскладки областей, открытый воркфлоу и выделение, пан/зум каждого графа,
фильтры Models / Civitai / Компонентов, последние результаты на нодах графа; история запусков (Results) хранится
сервером в `user/history.json`. Воркфлоу **автосохраняются** через секунду после правки (Файл → Автосохранение —
выключить); правки в `workflows/` извне подхватываются сами.

Сервер кэширует результаты нод между запусками: пересчитывается только изменённое и всё ниже (seed у LLM — чтобы
получить новый ответ). Ответ LLM стримится прямо на ноду.

## Своя нода

```python
from maistep import node

@node("text.upper", title="Upper Case", cat="My Nodes",
      inputs={"text": ("STRING", {"multiline": True})}, outputs={"text": "STRING"})
def upper(text, ctx):          # ctx — необязательный: ctx.progress, ctx.stream, ctx.log, ctx.settings
    return text.upper()
```

Типы: STRING INT FLOAT BOOLEAN COMBO IMAGE JSON `*`, для генерации — MODEL CLIP VAE CONDITIONING LATENT. `output=True` — конечная нода (её результат в UI),
`volatile=True` — без кэша.

## Models — библиотека моделей

Рабочая область **Models** (клавиша 3): модели с диска — папки из yaml Comfy Desktop
(`%APPDATA%\Comfy Desktop\instance-model-paths\*.yaml`) плюс `model_roots` из `user/settings.json`
(по умолчанию D:\ComfyUI\models и папки Comfy Desktop). Сам ComfyUI не нужен и не запускается. Библиотека только
читает; пишет в папки моделей лишь загрузка с Civitai по вашей кнопке. Кэш заголовков — `user/library_meta.json`.

- Hierarchy — категории (checkpoints, loras, unet, vae…) с числом и объёмом, корни; галерея — превью `.preview.jpeg`,
  поиск по имени/базе/триггер-словам, сортировка, размер плиток; NSFW-превью размыты (по флагу из `.cminfo.json`).
- Карточка в Inspector: база (Illustrious, Pony…), архитектура и параметры из заголовка safetensors, триггер-слова и теги
  (щелчок — копировать), ссылка Civitai, описание, метаданные. «Нода в граф» / двойной щелчок по плитке: чекпоинт →
  Load Checkpoint, LoRA → Load LoRA, VAE → Load VAE, остальное → Library Model.

## Генерация Stable Diffusion — ноды как в ComfyUI

Генерация идёт прямо в maistep (torch + diffusers в `.venv`), граф собирается из тех же кирпичиков, что в ComfyUI:

- **MODEL**: Load Checkpoint → Load LoRA (×n) → KSampler;
- **CLIP**: Load Checkpoint → Load LoRA (×n) → CLIP Set Last Layer → CLIP Text Encode ×2 (positive, negative) → KSampler;
- **LATENT**: Empty Latent Image (txt2img) или Load Image → VAE Encode (img2img) → KSampler → VAE Decode;
- **VAE**: Load Checkpoint (или Load VAE) → VAE Encode / VAE Decode → Save Image / Preview Image.

| Нода | Что делает |
|---|---|
| Load Checkpoint | чекпоинт SD1.5 / SDXL (Pony, Illustrious, аниме-миксы) из библиотеки → MODEL, CLIP, VAE |
| Load LoRA | LoRA с отдельной силой для MODEL и CLIP; цепочкой — сколько угодно LoRA |
| Load VAE | отдельный VAE вместо встроенного |
| CLIP Set Last Layer | clip skip: −2 — привычный «clip skip 2» для аниме |
| CLIP Text Encode (Prompt) | промпт → CONDITIONING (по одной ноде на positive и negative) |
| Empty Latent Image | размер и батч для txt2img |
| KSampler | seed (−1 — новый каждый запуск), steps, cfg, sampler, scheduler, denoise (<1 — img2img; steps — сколько шагов реально пройдёт, как в ComfyUI) |
| Upscale Latent | ресайз латента — для hires fix (KSampler → Upscale Latent → KSampler с denoise 0.4–0.6) |
| VAE Decode / VAE Encode | латент ↔ картинка (PNG в `output/`) |
| Magic KSampler | KSampler, который сам ставит steps / cfg / sampler / scheduler под чекпоинт и LoRA выше по графу; значения можно менять, «Сбросить» на ноде возвращает рекомендацию |
| Inpaint Region | перерисовка области по маске (как «Inpaint only masked» / Detailer): вырез, апскейл до родного разрешения, вклейка с растушёвкой |

**Magic KSampler** берёт рекомендации (по убыванию веса): Lightning / Hyper / LCM / Turbo / DMD2-модели и LoRA →
описание версии чекпоинта с Civitai (`.cminfo.json`: «Steps: 25-30, CFG: 5-7, Sampler: Euler a») → параметры картинок-
примеров версии на Civitai (медиана, кэш `user/magic_cache.json`) → профиль базы (Illustrious, NoobAI, Pony, Animagine,
SDXL, SD1.5, реалистичные миксы). В Inspector — откуда каждое значение, теги качества базы, clip skip, совместимость и
сила LoRA, триггер-слова. `GET /api/magic?ckpt=…&loras=[[имя, сила]]`.

**ImageNaizer** (клавиша 7): открыть картинку (из библиотеки приложения, с диска, перетаскиванием или Ctrl+V),
выделить область кистью (B), прямоугольником (R) или лассо (L) (Alt — стереть, E — ластик, I — инвертировать), выбрать
«Детализировать» (denoise ~0.4, те же формы, больше деталей) или «Перерисовать» (denoise ~0.9, на месте выделения —
то, что в промпте). Под капотом — скрытый граф с Inpaint Region в общей очереди; параметры подбирает Magic под
выбранный чекпоинт. Каждая правка — новая версия (полоса снизу и Hierarchy), «До / после», «Ещё вариант».

Пины раскрашены как в ComfyUI (MODEL, CLIP, VAE, CONDITIONING, LATENT, IMAGE). Модель одна в памяти и держится
между запусками; неизменённые ноды берутся из кэша — смена промпта не перегружает чекпоинт.
Примеры: `workflows/sd_txt2img`, `sd_lora`, `sd_img2img`, `sd_hires_fix`, `sd_idea_llm` (идея → LLM → теги → картинка);
те же графы — в Файл → Новый воркфлоу.

- Установка (один раз, ~3 ГБ) — вкладка «Компоненты» → «Установить недостающее», или вручную:
  `.venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cu130`, затем
  `.venv\Scripts\python -m pip install -r requirements.txt`.
- Видеокарты: NVIDIA — CUDA-сборка torch; AMD (Radeon RX 6000–9000, Windows и Linux) — ROCm-сборка с индекса AMD
  под архитектуру карты (`torch[device-gfx1201]==2.14.0+rocm10.1.0` для RX 9070; Python 3.10–3.14, на Windows — свежий
  Adrenalin); без видеокарты — CPU. «Компоненты» определяют карту сами, сборку можно выбрать вручную в карточке
  PyTorch. На AMD генерация идёт через тот же API (`torch.cuda`), а по образцу ComfyUI на RDNA3+ выключен MIOpen
  (`MAISTEP_ENABLE_MIOPEN=1` — вернуть), VAE считает внимание без SDPA, на RDNA2 VAE — в fp32.
- Настройки в `user/settings.json`: `"gen": {"device": "cuda|cpu|auto", "dtype": "fp16|bf16|fp32",
  "offload": "auto|true|false", "keep": true, "vae_dtype": "auto|bf16|fp16|fp32"}` — `offload` экономит VRAM
  (медленнее), `keep: false` выгружает модель после каждого VAE Decode. Сервер → «Освободить память» выгружает модели
  вручную (`POST /api/free`).
- Память — по образцу ComfyUI. При `offload: auto` на картах меньше 12 ГБ текстовые энкодеры живут на CPU, UNet и
  VAE — на GPU. VAE работает в bf16 (`vae_dtype: auto`; fp16 — на картах без bf16): у SDXL-VAE нет NaN, перекаст
  в fp32 не нужен. Перед VAE Encode/Decode оценивается память (формулы ComfyUI), и если рядом с UNet её мало,
  UNet на время VAE уходит на CPU: на Windows нехватка VRAM не даёт ошибки, а уводит память в системную, и секунды
  превращаются в минуты. Если места мало и без UNet — тайлы; NaN — повтор в fp32. `MAISTEP_DEBUG=1` пишет фазы и
  время в лог сервера.
- Замер (RTX 5060 Ti 8 ГБ, Illustrious SDXL, 832×1216, euler_a): txt2img 8 шагов — 7,8 с (сэмплинг 3,1 с,
  VAE Decode 2,2 с); img2img 6 шагов + LoRA — 20,6 с, из них 6,5 с — первая загрузка LoRA. Раньше VAE Decode
  занимал 30–90 с. Первая загрузка чекпоинта с диска — 1–1,5 мин, дальше он в памяти.

## Civitai — поиск и загрузка моделей

Рабочая область **Civitai** (клавиша 4), по мотивам Enhanced-Civicomfy, но в раскладке maistep:
- Hierarchy — режим (поиск / загрузки / мои метки), тип модели (Checkpoint, LORA, VAE, Embedding…; можно несколько),
  базовая модель (Illustrious, Pony, SDXL, Flux…), папка, куда скачивать (корни библиотеки).
- Галерея — поиск по тексту или ссылке/ID модели (`civitai.com/models/123?modelVersionId=456`), сортировка (рейтинг,
  загрузки, лайки, новые…), период, 20/50/100 результатов, «Показать ещё», NSFW-фильтр и размытие превью, размер
  плиток; ✓ — модель уже есть в библиотеке. Ctrl/Shift+щелчок — выбрать несколько: скачать или пометить пачкой.
- Inspector — карточка: версии, картинки с промптами и параметрами генерации (щелчок — копировать), файлы (fp16/fp32,
  pruned, формат), триггер-слова, теги, описание, «Скачать», «Открыть на Civitai», свои метки.
- Загрузки — очередь с прогрессом, скоростью и ETA; файл качается в несколько соединений (HTTP Range, обрывы
  докачиваются), проверяется SHA256, рядом пишутся `.cminfo.json` и `.preview.jpeg` — модель сразу видна в Models
  с превью, базой и триггер-словами. Отмена, повтор, «показать в папке», история.
- Настройки (шестерёнка): ключ API Civitai (нужен для моделей, требующих входа), соединений на файл, одновременных
  загрузок, проверка SHA256, превью. Хранятся в `user/settings.json` → `civitai`; метки и история — `user/civitai.json`.

## Компоненты и обновления

Рабочая область **Компоненты** (клавиша 6, кнопка в шапке, меню Вид / Сервер): в Hierarchy — группы, вкладки, сводка
и среда (Python, видеокарты, CUDA/ROCm, сборка torch), по центру — таблица «установлено / рекомендуется / последняя
стабильная» для пакетов из `components.json`, в Inspector — карточка пакета; лог pip — в Console. У каждого
компонента `tabs` — вкладки, которым он нужен («нужен для: Workflow, ImageNaizer, ToColar»); фильтр «Вкладки» слева
показывает, чего не хватает конкретной вкладке. У torch — `variants` (cuda / rocm / cpu: свой индекс, локальная
версия, `extra` с архитектурой AMD); выбор — по видеокарте или вручную (`user/settings.json` → `"components":
{"torch_variant": "rocm", "gfx": "gfx1201"}`). Стоит сборка под другую карту — статус «другая сборка» и кнопка
«Поставить ROCm/CUDA».
«Установить недостающее», «Обновить рекомендованные», «До последней стабильной» ставят пакеты в `.venv` через pip;
лог идёт вживую, «Прервать» останавливает установку. При старте один раз предлагаются недостающие пакеты и их
стабильные обновления. Карточка maistep сверху — обновление приложения (см. «Установка и обновления»).
API: `GET /api/components?refresh=1&deep=1`, `POST /api/components/install`, `POST /api/components/cancel`,
`POST /api/components/variant`,
`GET /api/update?check=1`, `POST /api/update/download`.

## MCP

`mcp/maistep_mcp.py` — MCP-сервер (stdio, только стандартная библиотека) для Kilo, Claude Desktop, Cursor: статус,
ноды, воркфлоу, запуск и очередь, история, модели, компоненты, `generate_image` (собирает граф из нод SD). Для Kilo подключён в
`kilo.json`; подробности и конфиги других клиентов — `mcp/README.md`. Нужен запущенный сервер maistep (`MAISTEP_URL`).

## LLM

Провайдеры — **Файл → Провайдеры LLM…** (хранятся в `user/settings.json`, он в .gitignore; в UI ключ виден только маской):
- **CheapVibeCode** (по умолчанию, тип «агрегатор»): Claude — через `<base>/messages` официальным SDK `anthropic`,
  остальные модели (GPT, Gemini, Grok, DeepSeek, Qwen) — через `<base>/chat/completions`; каталог — `<base>/models`.
- **Anthropic**, **OpenAI-совместимый** (OpenAI, LM Studio, OpenRouter, vLLM), **Ollama**, свои — кнопка «+ Провайдер».

Каталог моделей кэшируется на 6 ч (`user/models_cache.json`). В ноде «LLM» щелчок по полю model открывает поиск по
каталогу: группы по компаниям, значки 👁 (картинки на входе), 🧠 (reasoning), контекст и множитель цены.
Если модель не принимает картинки, вход image на ноде скрыт. Python-пакеты — только в `.venv`:
`.venv\Scripts\python -m pip install -r requirements.txt`.
