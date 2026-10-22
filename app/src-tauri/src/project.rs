// Проект maistep: воркфлоу workflows/*.json и пути внутри проекта.
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

// Папки, куда редактор пишет документы (data_write/data_delete): графы и настройки пользователя
const WRITABLE: [&str; 2] = ["workflows", "user"];

pub fn write_json(path: &Path, value: &Value, pretty: bool) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    }
    let text = if pretty { serde_json::to_string_pretty(value) } else { serde_json::to_string(value) }
        .map_err(|e| e.to_string())?;
    fs::write(path, format!("{text}\n")).map_err(|e| format!("{}: {e}", path.display()))
}

// Путь документа: только внутри WRITABLE, без «..» и абсолютных частей
pub fn doc_path(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.replace('\\', "/");
    let p = Path::new(&rel);
    let ok = !rel.is_empty()
        && p.components().all(|c| matches!(c, Component::Normal(_)))
        && WRITABLE.iter().any(|w| rel.starts_with(&format!("{w}/")));
    if !ok {
        return Err(format!("недопустимый путь {rel} (можно только {})", WRITABLE.join("/, ")));
    }
    Ok(root.join(p))
}

pub fn resolve_file(root: &Path, rel: &str) -> Option<PathBuf> {
    if rel.split(['/', '\\']).any(|s| s == ".." || s.contains(':')) {
        return None;
    }
    let p = root.join(rel);
    p.is_file().then_some(p)
}

pub fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|s| s.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "jpg" | "jpeg" => "image/jpeg",
        "json" => "application/json",
        "txt" | "md" | "py" | "js" | "css" | "html" => "text/plain; charset=utf-8",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

// Все воркфлоу: { root, workflows: [{ id, data }], errors }
pub fn load(root: &Path) -> Value {
    let mut docs = Vec::new();
    let mut errors = Vec::new();
    if let Ok(rd) = fs::read_dir(root.join("workflows")) {
        let mut paths: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
        paths.sort();
        for path in paths {
            if path.extension().and_then(|s| s.to_str()) != Some("json") {
                continue;
            }
            let id = path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            if id.starts_with('_') {
                continue;
            }
            match fs::read_to_string(&path).map_err(|e| e.to_string()).and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| e.to_string())) {
                Ok(data) => docs.push(json!({ "id": id, "data": data })),
                Err(e) => errors.push(format!("workflows/{id}.json: {e}")),
            }
        }
    }
    json!({ "root": root.display().to_string(), "workflows": docs, "errors": errors })
}
