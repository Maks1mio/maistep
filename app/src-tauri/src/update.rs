// Обновления: скачивает Python-сервер (server/maistep/updater.py) в update/staging/, здесь — применение при старте,
// до запуска сервера и окна: файлы переносятся на место, лишние удаляются, maistep.exe подменяется (запущенный exe
// на Windows можно переименовать в .old) и процесс перезапускается. Итог — update/applied.json (его читает сервер).
// UI грузится с диска (app/ui), вшитый в exe — запасной: обновление интерфейса не требует нового exe.
use std::borrow::Cow;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Wry};

// Пользовательские данные: обновление сюда не пишет никогда
const USER_DIRS: [&str; 8] = ["workflows", "user", "input", "output", ".venv", "venv", "update", ".git"];

fn safe_rel(rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    let ok = !rel.is_empty()
        && p.components().all(|c| matches!(c, Component::Normal(_)))
        && !USER_DIRS.iter().any(|d| rel == *d || rel.starts_with(&format!("{d}/")));
    ok.then(|| p.to_path_buf())
}

fn write_result(root: &Path, v: &Value) {
    let _ = fs::write(root.join("update").join("applied.json"), format!("{v}\n"));
}

// Остаток прошлой подмены exe
pub fn cleanup() {
    if let Ok(exe) = std::env::current_exe() {
        let _ = fs::remove_file(exe.with_extension("exe.old"));
    }
}

// Применить update/pending.json. true — exe заменён, процесс нужно перезапустить.
pub fn apply_pending(root: &Path) -> bool {
    let dir = root.join("update");
    let pending = dir.join("pending.json");
    let Ok(text) = fs::read_to_string(&pending) else { return false };
    let plan: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_file(&pending);
            write_result(root, &json!({ "ok": false, "error": format!("pending.json: {e}") }));
            return false;
        }
    };
    let version = plan["version"].as_str().unwrap_or("").to_string();
    let staging = dir.join("staging");
    let mut errors = Vec::new();
    for f in plan["files"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        let Some(rel) = safe_rel(f) else { errors.push(format!("{f}: недопустимый путь")); continue };
        let (src, dst) = (staging.join(&rel), root.join(&rel));
        if !src.is_file() {
            continue; // перенесён прошлой попыткой
        }
        if let Some(d) = dst.parent() {
            let _ = fs::create_dir_all(d);
        }
        if fs::rename(&src, &dst).is_err() {
            if let Err(e) = fs::copy(&src, &dst) {
                errors.push(format!("{f}: {e}"));
            }
        }
    }
    for f in plan["remove"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if let Some(rel) = safe_rel(f) {
            let _ = fs::remove_file(root.join(rel));
        }
    }
    let mut exe_swapped = false;
    let new_exe = staging.join("maistep.exe");
    if plan["exe"].as_bool() == Some(true) && new_exe.is_file() {
        match std::env::current_exe() {
            Ok(exe) => {
                let old = exe.with_extension("exe.old");
                let _ = fs::remove_file(&old);
                match fs::rename(&exe, &old).and_then(|_| fs::rename(&new_exe, &exe)) {
                    Ok(()) => exe_swapped = true,
                    Err(e) => {
                        if !exe.exists() {
                            let _ = fs::rename(&old, &exe);
                        }
                        errors.push(format!("maistep.exe: {e}"));
                    }
                }
            }
            Err(e) => errors.push(format!("maistep.exe: {e}")),
        }
    }
    if !errors.is_empty() {
        // файлы заняты — повторим при следующем запуске
        write_result(root, &json!({ "ok": false, "version": version, "error": errors.join("; ") }));
        return exe_swapped;
    }
    if plan["manifest"].is_object() {
        let _ = crate::project::write_json(&root.join("manifest.json"), &plan["manifest"], true);
    }
    let _ = fs::remove_file(&pending);
    let _ = fs::remove_dir_all(&staging);
    write_result(root, &json!({ "ok": true, "version": version, "exe": exe_swapped }));
    exe_swapped
}

// UI с диска (app/ui), иначе — вшитый при сборке
pub struct DiskAssets {
    pub dir: PathBuf,
    pub fallback: Box<dyn Assets<Wry>>,
}

impl Assets<Wry> for DiskAssets {
    fn setup(&self, app: &tauri::App<Wry>) {
        self.fallback.setup(app)
    }

    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        let rel = key.as_ref().trim_start_matches('/');
        safe_rel(rel)
            .and_then(|p| fs::read(self.dir.join(p)).ok())
            .map(Cow::Owned)
            .or_else(|| self.fallback.get(key))
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        self.fallback.iter()
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        self.fallback.csp_hashes(html_path)
    }
}

// Заглушка на время подмены провайдера в Context
pub struct NoAssets;

impl Assets<Wry> for NoAssets {
    fn get(&self, _: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }

    fn csp_hashes(&self, _: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}
