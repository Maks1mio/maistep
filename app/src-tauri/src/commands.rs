// Tauri-команды для веб-UI (app/ui/js/api.js).
use std::path::PathBuf;
use std::process::Command;

use serde_json::Value;
use tauri::{AppHandle, State};

use crate::project::{doc_path, write_json};
use crate::server::{self, Shared, Status};

pub struct AppState {
    pub root: PathBuf,
    pub server: Shared,
}

#[cfg(windows)]
pub fn no_window(c: &mut Command) {
    use std::os::windows::process::CommandExt;
    c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
}
#[cfg(not(windows))]
pub fn no_window(_: &mut Command) {}

#[tauri::command]
pub fn load_project(st: State<AppState>) -> Value {
    crate::project::load(&st.root)
}

#[tauri::command]
pub fn data_write(st: State<AppState>, path: String, value: Value, pretty: Option<bool>) -> Result<(), String> {
    let p = doc_path(&st.root, &path)?;
    write_json(&p, &value, pretty.unwrap_or(true))
}

#[tauri::command]
pub fn data_delete(st: State<AppState>, path: String) -> Result<(), String> {
    let p = doc_path(&st.root, &path)?;
    if p.is_file() {
        std::fs::remove_file(&p).map_err(|e| format!("{}: {e}", p.display()))?;
    }
    Ok(())
}

// «Отпечаток» workflows/: самое позднее время изменения и число файлов — редактор сравнивает его, чтобы заметить
// правки извне (другой редактор, git, ИИ-ассистент)
#[tauri::command]
pub fn data_stamp(st: State<AppState>) -> String {
    let mut latest = 0u128;
    let mut count = 0usize;
    for e in walkdir::WalkDir::new(st.root.join("workflows")).into_iter().flatten() {
        if !e.file_type().is_file() {
            continue;
        }
        count += 1;
        if let Some(t) = e.metadata().ok().and_then(|m| m.modified().ok()) {
            latest = latest.max(t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis()).unwrap_or(0));
        }
    }
    format!("{latest}:{count}")
}

// Проводник Project: содержимое одной папки проекта. Папки первыми, по имени.
#[derive(serde::Serialize)]
pub struct FsEntry {
    name: String,
    dir: bool,
    size: u64,
}

fn project_dir(root: &std::path::Path, rel: &str) -> Result<PathBuf, String> {
    if rel.split(['/', '\\']).any(|s| s == ".." || s.contains(':')) {
        return Err(format!("недопустимый путь: {rel}"));
    }
    Ok(if rel.is_empty() { root.to_path_buf() } else { root.join(rel) })
}

const FS_SKIP: [&str; 7] = [".git", "node_modules", "target", ".claude", "__pycache__", ".venv", "venv"];

#[tauri::command]
pub fn fs_list(st: State<AppState>, path: String) -> Result<Vec<FsEntry>, String> {
    let dir = project_dir(&st.root, &path)?;
    let mut out: Vec<FsEntry> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let md = e.metadata().ok()?;
            Some(FsEntry { dir: md.is_dir(), size: if md.is_dir() { 0 } else { md.len() }, name })
        })
        .filter(|e| !(e.dir && FS_SKIP.contains(&e.name.as_str())))
        .collect();
    out.sort_by(|a, b| b.dir.cmp(&a.dir).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
    Ok(out)
}

// Поиск по имени в папке и вложенных: все слова запроса в относительном пути; не больше limit результатов
#[tauri::command]
pub fn fs_search(st: State<AppState>, path: String, query: String, limit: Option<usize>) -> Result<Vec<String>, String> {
    let dir = project_dir(&st.root, &path)?;
    let words: Vec<String> = query.to_lowercase().split_whitespace().map(String::from).collect();
    let limit = limit.unwrap_or(2000);
    let mut out = Vec::new();
    let walk = walkdir::WalkDir::new(&dir).min_depth(1).into_iter()
        .filter_entry(|e| !(e.file_type().is_dir() && FS_SKIP.contains(&e.file_name().to_string_lossy().as_ref())));
    for e in walk.flatten() {
        let Ok(rel) = e.path().strip_prefix(&st.root) else { continue };
        let rel = rel.to_string_lossy().replace('\\', "/");
        let low = rel.to_lowercase();
        let tail = low.strip_prefix(&path.to_lowercase()).unwrap_or(&low);
        if words.iter().all(|w| tail.contains(w.as_str())) {
            out.push(if e.file_type().is_dir() { format!("{rel}/") } else { rel });
            if out.len() >= limit {
                break;
            }
        }
    }
    Ok(out)
}

// Текстовый файл проекта (CodeEditor): чтение и запись произвольных файлов в корне проекта
#[tauri::command]
pub fn fs_read(st: State<AppState>, path: String) -> Result<String, String> {
    let p = project_dir(&st.root, &path)?;
    if !p.is_file() {
        return Err(format!("нет файла: {path}"));
    }
    std::fs::read_to_string(&p).map_err(|e| format!("{}: {e}", p.display()))
}

#[tauri::command]
pub fn fs_write(st: State<AppState>, path: String, text: String) -> Result<(), String> {
    let p = project_dir(&st.root, &path)?;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
    }
    std::fs::write(&p, text).map_err(|e| format!("{}: {e}", p.display()))
}

#[tauri::command]
pub fn server_start(app: AppHandle, st: State<AppState>, port: Option<u16>) -> Result<Status, String> {
    // MAISTEP_PORT перекрывает порт из UI (вторая копия рядом с основной, проверки)
    let env = std::env::var("MAISTEP_PORT").ok().and_then(|p| p.parse().ok());
    server::start(&app, &st.server, &st.root, env.or(port).unwrap_or(server::DEFAULT_PORT))
}

#[tauri::command]
pub fn server_stop(app: AppHandle, st: State<AppState>) -> Status {
    server::stop(&app, &st.server);
    server::status(&st.server)
}

#[tauri::command]
pub fn server_status(st: State<AppState>) -> Status {
    server::status(&st.server)
}

// Перезапуск окна: при старте применяется скачанное обновление (update.rs)
#[tauri::command]
pub fn app_restart(app: AppHandle, st: State<AppState>) {
    server::stop(&app, &st.server);
    app.restart();
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("только http(s)".into());
    }
    let mut c = if cfg!(windows) {
        let mut c = Command::new("cmd");
        c.args(["/C", "start", "", &url]);
        c
    } else if cfg!(target_os = "macos") {
        let mut c = Command::new("open");
        c.arg(&url);
        c
    } else {
        let mut c = Command::new("xdg-open");
        c.arg(&url);
        c
    };
    no_window(&mut c);
    c.spawn().map(|_| ()).map_err(|e| e.to_string())
}
