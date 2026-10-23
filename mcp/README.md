# maistep MCP

MCP-сервер приложения: даёт ИИ-клиентам (Kilo, Claude Desktop, Cursor) доступ к каталогу нод, воркфлоу,
очереди запусков, библиотеке моделей и компонентам maistep. Только стандартная библиотека Python 3.10+.

```bash
python mcp/maistep_mcp.py --selftest     # проверить связь с сервером maistep
python mcp/maistep_mcp.py                # stdio-транспорт (обычно запускает клиент)
```

Сервер maistep должен быть запущен (`npm run app` или `npm run server`). Адрес — `MAISTEP_URL`,
по умолчанию `http://127.0.0.1:3300`.

Подключение в `kilo.json` проекта уже есть:

```json
{
  "mcp": {
    "maistep": {
      "type": "local",
      "command": [".venv/Scripts/python.exe", "mcp/maistep_mcp.py"],
      "environment": { "MAISTEP_URL": "http://127.0.0.1:3300" }
    }
  }
}
```

Для Claude Desktop / других клиентов:

```json
{
  "mcpServers": {
    "maistep": {
      "command": "C:\\path\\to\\maistep\\.venv\\Scripts\\python.exe",
      "args": ["C:\\path\\to\\maistep\\mcp\\maistep_mcp.py"],
      "env": { "MAISTEP_URL": "http://127.0.0.1:3300" }
    }
  }
}
```

Инструменты: `server_status`, `list_nodes`, `get_node`, `list_workflows`, `get_workflow`, `run_workflow`,
`queue_status`, `interrupt`, `history`, `list_models`, `model_details`, `components_status`,
`install_components`, `generate_image` (txt2img/img2img с LoRA).

`run_workflow` и `generate_image` по умолчанию ждут завершения и возвращают результаты из истории запусков.
