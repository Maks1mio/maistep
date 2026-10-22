# maistep — заметки для продолжения работы

Нодовый редактор AI-пайплайнов (как ComfyUI) на оболочке OCST, перенесённой из `C:\Users\OneEvT\mashit\editor`.
mashit (игра и её редактор) **не трогаем** — maistep независимая копия. Общение — по-русски. Устройство — README.md.

## Запуск и проверка
- `npm run app` — окно; бинарь `app/src-tauri/target/debug/maistep.exe`. UI встраивается в бинарь при сборке
  (frontendDist) — после правок `app/ui` нужна пересборка (инкрементальная ~15 с).
- `npm run app:web` → http://localhost:3210 (порт 3200 занят веб-режимом OCST из mashit). Проверять UI в браузерной панели.
- Python-сервер: порт 3300 (не 8188, чтобы не спорить с ComfyUI). Ядро при старте освобождает порт, если его держит python.
- Веб-режим по умолчанию ведёт свой Python-сервер на :3310, окно — на :3300. Пользователь часто держит окно открытым:
  НЕ трогать процессы на 3300 и maistep.exe; dev-server порт не освобождает, только сообщает.
- В скрытой браузерной панели не работает requestAnimationFrame — раскладка дока и onShow видов не срабатывают, пока не
  сделать скриншот; не путать с багами.
- Быстрая проверка без ключей: воркфлоу `demo_words` (своя нода custom.word_count).

## Решения
- Мост ComfyUI — `server/maistep/comfy.py` (свой WebSocket-клиент на socket; ui_to_api по object_info.input_order;
  значения randomize/fixed после INT пропускаются; алиасы старых классов в ALIASES). Генерация — PreviewImage (temp),
  чтобы не мусорить в output ComfyUI. Имена моделей из библиотеки → ComfyUI через os.sep (comfy_name).
- В воркфлоу пользователя бывает NSFW-контент — для тестов использовать comfy_workflows/example_txt2img_api.json.
- Библиотека моделей — `server/maistep/library.py`, строго только чтение; источники — yaml Comfy Desktop + model_roots.
- Python — только `.venv` проекта (пользователь не хочет засорять систему); ядро и dev-server запускают сервер из него.
- Провайдеры LLM — `server/maistep/providers.py`; CheapVibeCode = kind `proxy` (Claude → SDK anthropic с base_url без /v1,
  остальное → chat/completions). Через прокси работают `effort` и `fallbacks` (проверено 2026-10-22).
- На Windows `allow_reuse_address` выключен: иначе второй сервер тихо делил порт 3300 со старым.
- Сервер — только стандартная библиотека (ThreadingHTTPServer + SSE); пакеты нужны лишь отдельным нодам (requirements.txt).
- Провайдер anthropic — официальный SDK `anthropic` (ленивый импорт); openai/ollama — urllib.
- id запуска генерирует клиент (backend.js): события SSE приходят раньше ответа POST /api/prompt.
- Проверка графа (`executor.check(only_needed=True)`) — только ноды, которые реально исполнятся (цели + всё выше).
- Документы редактора пишутся только в `workflows/` и `user/` (project.rs `doc_path`).
