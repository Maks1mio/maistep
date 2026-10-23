# maistep — заметки для продолжения работы

Нодовый редактор AI-пайплайнов (как ComfyUI) на оболочке OCST, перенесённой из `C:\Users\OneEvT\mashit\editor`.
mashit (игра и её редактор) **не трогаем** — maistep независимая копия. Общение — по-русски. Устройство — README.md.

## Запуск и проверка
- `npm run app` — окно; бинарь `app/src-tauri/target/debug/maistep.exe`. UI встраивается в бинарь при сборке
  (frontendDist) — после правок `app/ui` нужна пересборка (инкрементальная ~15 с).
- `npm run app:web` → http://localhost:3210 (порт 3200 занят веб-режимом OCST из mashit). Проверять UI в браузерной панели.
- Python-сервер: порт 3300. Ядро при старте освобождает порт, если его держит python.
- Веб-режим по умолчанию ведёт свой Python-сервер на :3310, окно — на :3300. Пользователь часто держит окно открытым:
  НЕ трогать процессы на 3300 и maistep.exe; dev-server порт не освобождает, только сообщает.
- В скрытой браузерной панели не работает requestAnimationFrame — раскладка дока и onShow видов не срабатывают, пока не
  сделать скриншот; не путать с багами.
- Быстрая проверка без ключей: воркфлоу `demo_words` (своя нода custom.word_count); генерация — `sd_txt2img`.
- Примеры `workflows/*.json` и `app/ui/js/templates.js` генерируются одним скриптом — графы держать одинаковыми.
- Состояние UI — localStorage (persist.js, dock.js, фильтры модулей); воркфлоу автосохраняются (persist.js).

## Решения
- Моста к ComfyUI больше нет (удалён по просьбе пользователя 2026-10-23): maistep не обращается к запущенному ComfyUI.
  Установленный ComfyUI (`%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Installs\EvTs\ComfyUI`) — только справочник по коду.
- Ноды — по-английски (title, cat, hint), как в ComfyUI; остальной UI — по-русски. Генерация — отдельные ноды
  (sd.checkpoint / sd.lora / sd.clip_skip / sd.text_encode / sd.empty_latent / sd.ksampler / sd.vae_decode …), значения
  между ними — описатели (Model, Clip, Vae, Cond, Latent в diffusion.py), пайплайн diffusers один в `_state`.
- В воркфлоу и моделях пользователя бывает NSFW — в тестах только нейтральные промпты и примеры из workflows/.
- Библиотека моделей — `server/maistep/library.py`, строго только чтение; источники — yaml Comfy Desktop + model_roots.
  В папки моделей пишет только загрузка Civitai (`civitai.py`) по явной кнопке: файл + `.cminfo.json` + `.preview.jpeg`.
  Удаление — корзина в «Загрузках»: файл и сайдкары (только внутри папок моделей), запись истории убирается.
  Тестировать загрузки — с `root=` в scratchpad, не в библиотеку пользователя.
- Civitai API: с текстом `query` выдача пустая при period ≠ AllTime, а фильтры типа/базы применяются после поиска —
  поэтому сервер добирает страницы по 100. Картинки — `/original=true/` → менять на `/width=N/`. Скачивание — `?token=`,
  не заголовок (редирект на подписанный URL хранилища).
- Python — только `.venv` проекта (пользователь не хочет засорять систему); ядро и dev-server запускают сервер из него.
- Провайдеры LLM — `server/maistep/providers.py`; CheapVibeCode = kind `proxy` (Claude → SDK anthropic с base_url без /v1,
  остальное → chat/completions). Через прокси работают `effort` и `fallbacks` (проверено 2026-10-22).
- Перевод промптов — `server/maistep/translate.py` на входе `sd.text_encode` и `image.generate_openai`: русский/смешанный
  текст переводится LLM (настройки `translate` в user/settings.json, UI — «Провайдеры LLM… → Перевод промптов»;
  пустая модель — авто: flash/mini/haiku). Кэш — `user/prompts_en.json`; ошибка перевода не валит запуск.
- На Windows `allow_reuse_address` выключен: иначе второй сервер тихо делил порт 3300 со старым.
- Сервер — только стандартная библиотека (ThreadingHTTPServer + SSE); пакеты нужны лишь отдельным нодам (requirements.txt).
- Провайдер anthropic — официальный SDK `anthropic` (ленивый импорт); openai/ollama — urllib.
- id запуска генерирует клиент (backend.js): события SSE приходят раньше ответа POST /api/prompt.
- Проверка графа (`executor.check(only_needed=True)`) — только ноды, которые реально исполнятся (цели + всё выше).
- Документы редактора пишутся только в `workflows/` и `user/` (project.rs `doc_path`).
- Локальная генерация (diffusion.py): VAE encode/decode — свои (`output_type="latent"`, в img2img идёт готовый латент),
  по образцу ComfyUI (`comfy/sd.py`, `model_management.py` у Comfy Desktop: `%LOCALAPPDATA%\Comfy-Desktop\ComfyUI-Installs\EvTs\ComfyUI`):
  VAE в bf16, оценка памяти, UNet на CPU на время VAE при нехватке. GPU — RTX 5060 Ti 8 ГБ: на Windows нехватка VRAM
  не даёт OOM, а уводит в sysmem (медленно) — поэтому только проактивная проверка `mem_get_info`.
- Поэтапное превью KSampler — латент → RGB линейной проекцией (latent_rgb_factors ComfyUI, без VAE), `ctx.preview()` →
  SSE `preview` → `S.run.preview[node]`, не чаще раза в 0.35 с. Холст графа рисуется цветами палитры UI Kit (graph.js `K`).
- Переносить модули (UNet ↔ CPU и т.п.) только вне `torch.inference_mode()` (`_unet_to` сам выходит из него): иначе
  веса становятся inference-тензорами и PEFT не включает LoRA (`requires_grad … inference tensor`).
- MCP-сервер `mcp/maistep_mcp.py` подключён в kilo.json, не в Claude Code; то же самое — HTTP API (`/api/history` и т.д.).
- Картинки на холсте грузятся с `crossOrigin='anonymous'` (сервер шлёт CORS) — иначе холст «грязный» и не снимается.
- Magic KSampler (`magic.py`, `magic.js`): параметры берутся только из правила чекпоинта; LoRA на steps/cfg/сэмплер
  не влияют (только совместимость, сила, триггеры). Рекомендация хранится в ноде (`n.magic = {key, rec, profile}`),
  подстановка — без записи в отмену; при смене модели меняются только значения, равные прежней рекомендации.
  Версия правила в ключе `magic.js` (`RULE`) — старые рекомендации пересчитываются.
- ImageNaizer (`naizer.js`) — редактор слоями: фон не меняется, генерация (скрытый граф `id: "naizer"`, sd.inpaint
  `patch=true`) возвращает только область — PNG с растушёванной альфой + `_ui.patch` {x,y,w,h} → новый слой (или вариант
  слоя при «Ещё вариант»). Основа генерации — видимый композит (`naizer_base_*` в input/), маска — `naizer_mask_*`
  (кэш нод по входам), правки слоёв — `naizer_layer_*`; файлы `naizer_*` скрыты из списков. Документы (слои, контекст
  сцены) — localStorage по файлу фона; выделение — черновик MASK_KEY. Превью шагов рисуется в области (`preview_meta.box`
  в Ctx). `fill` — размыть выделенное перед сэмплингом (перерисовка). «Контекст сцены» — vision-LLM через скрытый
  `llm.chat`. Сохранение — `/api/upload?dir=output`.
- Картинки в ноды: `images.js` — выбор из input/ и output/ или с диска, перетаскивание (файлы, text/mai-file, ссылки
  /view), Ctrl+V. История запусков — `user/history.json`; результаты нод в UI — localStorage `maistep-outputs`.
- Триггер-слова LoRA: `lora.js` — при вставке из библиотеки или смене `lora_name` дописывает `trained` в положительный
  `sd.text_encode` (по связи sampler.positive, иначе по названию ноды); если `text` приходит по связи — предупреждение.
- Вес тегов: Ctrl+↑/↓ в textarea с `data-prompt-weight` (`promptedit.js`) — выделение или тег под курсором становится
  `(tag:1.2)`, шаг 0.1, 0.1…2.0; поля CLIP Text Encode, Generate Image и промпты ImageNaizer.
- Для проверки UI при занятом 3210 — конфигурация `maistep-web-alt` (:3220) в .claude/launch.json.
