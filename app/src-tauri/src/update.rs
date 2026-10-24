// Обновления: скачивает Python-сервер (server/maistep/updater.py) в update/staging/, здесь — применение при старте,
// до запуска сервера и окна: файлы переносятся на место, лишние удаляются, бинарь подменяется (Windows — maistep.exe:
// запущенный exe можно переименовать в .old; Linux — maistep.AppImage: файл заменяется на месте) и процесс
// перезапускается. Итог — update/applied.json (его читает сервер).
// UI грузится с диска (app/ui), вшитый в exe — запасной: обновление интерфейса не требует нового exe.
use std::borrow::Cow;
use std::fs;
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Wry};

// Пользовательские данные: обновление сюда не пишет никогда
const USER_DIRS: [&str; 8] = ["workflows", "user", "input", "output", ".venv", "venv", "update", ".git"];

pub fn safe_rel(rel: &str) -> Option<PathBuf> {
    let p = Path::new(rel);
    let ok = !rel.is_empty()
        && p.components().all(|c| matches!(c, Component::Normal(_)))
        && !USER_DIRS.iter().any(|d| rel == *d || rel.starts_with(&format!("{d}/")));
    ok.then(|| p.to_path_buf())
}

// Имя бинаря приложения в папке установки
pub const BIN: &str = if cfg!(windows) { "maistep.exe" } else { "maistep.AppImage" };

// Сам бинарь: в AppImage current_exe — файл внутри смонтированного образа, настоящий путь — в $APPIMAGE
pub fn self_path() -> std::io::Result<PathBuf> {
    match std::env::var_os("APPIMAGE").filter(|p| !p.is_empty()) {
        Some(p) => Ok(PathBuf::from(p)),
        None => std::env::current_exe(),
    }
}

fn old_path(exe: &Path) -> PathBuf {
    let mut s = exe.as_os_str().to_owned();
    s.push(".old");
    PathBuf::from(s)
}

fn write_result(root: &Path, v: &Value) {
    let _ = fs::write(root.join("update").join("applied.json"), format!("{v}\n"));
}

// Остаток прошлой подмены exe
pub fn cleanup() {
    if let Ok(exe) = self_path() {
        let _ = fs::remove_file(old_path(&exe));
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
    let new_exe = staging.join(BIN);
    if plan["exe"].as_bool() == Some(true) && new_exe.is_file() {
        match self_path().and_then(|exe| swap_bin(&new_exe, &exe)) {
            Ok(()) => exe_swapped = true,
            Err(e) => errors.push(format!("{BIN}: {e}")),
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

// Новый бинарь на место запущенного: старый уходит в .old (Windows не даёт перезаписать запущенный exe,
// но даёт переименовать; на Linux так же можно — процесс держит inode, а не имя)
fn swap_bin(new: &Path, exe: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(new, fs::Permissions::from_mode(0o755))?;
    }
    let old = old_path(exe);
    let _ = fs::remove_file(&old);
    fs::rename(exe, &old)?;
    fs::rename(new, exe).or_else(|_| fs::copy(new, exe).map(|_| ())).inspect_err(|_| {
        if !exe.exists() {
            let _ = fs::rename(&old, exe);
        }
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn swaps_binary_and_keeps_old() {
        let dir = std::env::temp_dir().join(format!("maistep-swap-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let (exe, new) = (dir.join(BIN), dir.join("new.bin"));
        fs::write(&exe, "old").unwrap();
        fs::write(&new, "new").unwrap();
        swap_bin(&new, &exe).unwrap();
        assert_eq!(fs::read_to_string(&exe).unwrap(), "new");
        assert_eq!(fs::read_to_string(old_path(&exe)).unwrap(), "old");
        assert!(!new.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn applies_staged_files_and_keeps_user_data() {
        let root = std::env::temp_dir().join(format!("maistep-update-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let staging = root.join("update").join("staging");
        for (p, t) in [("server/a.py", "old"), ("server/gone.py", "x"), ("workflows/my.json", "mine")] {
            fs::create_dir_all(root.join(p).parent().unwrap()).unwrap();
            fs::write(root.join(p), t).unwrap();
        }
        for (p, t) in [("server/a.py", "new"), ("app/ui/js/n.js", "n"), ("workflows/my.json", "evil")] {
            fs::create_dir_all(staging.join(p).parent().unwrap()).unwrap();
            fs::write(staging.join(p), t).unwrap();
        }
        let plan = json!({ "version": "9.9.9", "files": ["server/a.py", "app/ui/js/n.js", "workflows/my.json", "../out.txt"],
            "remove": ["server/gone.py", "workflows/my.json"], "exe": false, "manifest": { "version": "9.9.9" } });
        fs::write(root.join("update").join("pending.json"), plan.to_string()).unwrap();

        assert!(!apply_pending(&root));
        assert_eq!(fs::read_to_string(root.join("server/a.py")).unwrap(), "new");
        assert_eq!(fs::read_to_string(root.join("app/ui/js/n.js")).unwrap(), "n");
        assert!(!root.join("server/gone.py").exists());
        assert_eq!(fs::read_to_string(root.join("workflows/my.json")).unwrap(), "mine");
        // недопустимые пути — ошибка, pending остаётся для разбора
        let res: Value = serde_json::from_str(&fs::read_to_string(root.join("update/applied.json")).unwrap()).unwrap();
        assert_eq!(res["ok"], false);
        assert!(root.join("update/pending.json").exists());

        // чистый план применяется целиком: манифест записан, staging убран
        fs::write(root.join("update").join("pending.json"), json!({ "version": "9.9.9", "files": ["server/a.py"], "remove": [], "exe": false, "manifest": { "version": "9.9.9" } }).to_string()).unwrap();
        assert!(!apply_pending(&root));
        let res: Value = serde_json::from_str(&fs::read_to_string(root.join("update/applied.json")).unwrap()).unwrap();
        assert_eq!(res["ok"], true);
        assert!(!root.join("update/pending.json").exists() && !staging.exists());
        assert!(fs::read_to_string(root.join("manifest.json")).unwrap().contains("9.9.9"));
        let _ = fs::remove_dir_all(&root);
    }
}
