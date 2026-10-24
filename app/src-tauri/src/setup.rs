// Установка и удаление (окно setup.html в стиле UI Kit). Установщик — тот же бинарь приложения (Windows — maistep.exe,
// Linux — maistep.AppImage) с приклеенным в конец архивом (scripts/release.mjs): [бинарь][записи][u64 длина записей]
// ["MAISTEP-PAYLOAD1"], запись — u16 длина пути, путь, u32 размер, u32 сжатый размер, deflate. Установка portable: всё
// в выбранной папке (данные WebView — user/webview, Python по желанию — python/); реестр и AppData не трогаются, вне
// папки — только ярлыки, если их выбрать (Windows — .lnk, Linux — .desktop; пути в install.json, удаление их убирает).
// `maistep.exe --uninstall` (maistep.AppImage --uninstall) — удаление, `--silent` — без окна.
// Удаление работает только в папке своего exe с install.json и убирает только APP_ITEMS (+ DATA_DIRS по выбору) —
// никакие другие файлы рядом не трогаются.
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::commands::no_window;

const MAGIC: &[u8; 16] = b"MAISTEP-PAYLOAD1";
// Данные пользователя: при обновлении/переустановке не трогаются, при удалении — по выбору
pub const DATA_DIRS: [&str; 4] = ["workflows", "user", "input", "output"];
// Всё, что кладут в папку установщик, обновлятор и первый запуск
const APP_ITEMS: [&str; 19] = ["app", "server", "mcp", "custom_nodes", "defaults", "python", ".venv", "update", "manifest.json",
    "install.json", "uninstall.cmd", "uninstall.sh", "requirements.txt", "components.json", "maistep.exe.old",
    "maistep.AppImage", "maistep.AppImage.old", "maistep.png", "README.md"];
// Портативный Python (python-build-standalone): распаковывается в <папка>/python, из него — .venv
const PYTHON_URL: &str = if cfg!(windows) {
    "https://github.com/astral-sh/python-build-standalone/releases/download/20261021/cpython-3.12.15%2B20261021-x86_64-pc-windows-msvc-install_only_stripped.tar.gz"
} else {
    "https://github.com/astral-sh/python-build-standalone/releases/download/20261021/cpython-3.12.15%2B20261021-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
};
// Ярлык: Windows — .lnk, Linux — .desktop (меню и рабочий стол)
const SHORTCUT: &str = if cfg!(windows) { "maistep.lnk" } else { "maistep.desktop" };
#[cfg(not(windows))]
const ICON: &[u8] = include_bytes!("../icons/icon.png");

pub struct Payload {
    pub exe_len: u64,
    pub entries: (u64, u64), // смещение и длина записей
}

// Архив в конце собственного exe — значит, это установщик
pub fn payload() -> Option<Payload> {
    let mut f = fs::File::open(crate::update::self_path().ok()?).ok()?;
    let size = f.metadata().ok()?.len();
    if size < 24 {
        return None;
    }
    let mut tail = [0u8; 24];
    f.seek(SeekFrom::Start(size - 24)).ok()?;
    f.read_exact(&mut tail).ok()?;
    if &tail[8..] != MAGIC {
        return None;
    }
    let len = u64::from_le_bytes(tail[..8].try_into().ok()?);
    let start = size.checked_sub(24 + len)?;
    Some(Payload { exe_len: start, entries: (start, len) })
}

// Папка установленной копии для удаления: только папка самого exe и только если в ней есть install.json
pub fn installed_root() -> Result<PathBuf, String> {
    let exe = crate::update::self_path().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or("нет папки exe")?.to_path_buf();
    if !dir.join("install.json").is_file() {
        return Err(format!("{} — не папка установленного maistep (нет install.json); удалять нечего", dir.display()));
    }
    if dir.join(".git").exists() {
        return Err(format!("{} — git-копия, удаление отключено", dir.display()));
    }
    Ok(dir)
}

// версия релиза (scripts/release.mjs передаёт package.json → MAISTEP_VERSION), иначе — из Cargo.toml
fn version() -> String {
    option_env!("MAISTEP_VERSION").unwrap_or(env!("CARGO_PKG_VERSION")).to_string()
}

fn progress(app: Option<&AppHandle>, stage: &str, done: u64, total: u64) {
    if let Some(app) = app {
        let _ = app.emit("setup-progress", json!({ "stage": stage, "done": done, "total": total }));
    } else if done == total {
        println!("{stage}: готово");
    }
}

fn default_dir() -> PathBuf {
    if cfg!(windows) {
        return std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("Programs").join("maistep");
    }
    data_home().unwrap_or_else(std::env::temp_dir).join("maistep")
}

// ~/.local/share (XDG_DATA_HOME)
#[allow(dead_code)]
fn data_home() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME").filter(|p| !p.is_empty()).map(PathBuf::from).or_else(|| known_folder("HOME", &[".local", "share"]))
}

fn known_folder(var: &str, sub: &[&str]) -> Option<PathBuf> {
    let mut p = PathBuf::from(std::env::var_os(var)?);
    for s in sub {
        p.push(s);
    }
    Some(p)
}

#[cfg(not(windows))]
fn desktop() -> Option<PathBuf> {
    // папка рабочего стола бывает локализована («Рабочий стол») — спрашиваем xdg-user-dir
    let mut c = Command::new("xdg-user-dir");
    c.arg("DESKTOP");
    no_window(&mut c);
    let p = c.output().ok().filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).filter(|p| !p.is_empty()).map(PathBuf::from);
    p.or_else(|| known_folder("HOME", &["Desktop"])).filter(|p| p.is_dir())
}

#[cfg(not(windows))]
fn start_menu() -> Option<PathBuf> {
    let p = data_home()?.join("applications");
    fs::create_dir_all(&p).ok()?;
    Some(p)
}

#[cfg(not(windows))]
fn shortcut(file: &Path, target: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    let dir = target.parent().unwrap_or(Path::new("."));
    let q = |p: &Path| format!("\"{}\"", p.display().to_string().replace('\\', "\\\\").replace('"', "\\\""));
    let text = format!("[Desktop Entry]\nType=Application\nName=maistep\nComment=Нодовый редактор AI-пайплайнов\nExec={}\nPath={}\nIcon={}\nTerminal=false\nCategories=Graphics;Development;\nStartupWMClass=maistep\n",
        q(target), dir.display(), dir.join("maistep.png").display());
    fs::write(file, text).map_err(|e| format!("{}: {e}", file.display()))?;
    // рабочий стол GNOME запускает только исполняемые .desktop
    let _ = fs::set_permissions(file, fs::Permissions::from_mode(0o755));
    Ok(())
}

#[cfg(windows)]
fn desktop() -> Option<PathBuf> {
    // OneDrive может переносить «Рабочий стол» — спрашиваем у оболочки
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-Command", "[Environment]::GetFolderPath('Desktop')"]);
    no_window(&mut c);
    let out = c.output().ok().filter(|o| o.status.success())?;
    let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if p.is_empty() { known_folder("USERPROFILE", &["Desktop"]) } else { Some(PathBuf::from(p)) }
}

#[cfg(windows)]
fn start_menu() -> Option<PathBuf> {
    known_folder("APPDATA", &["Microsoft", "Windows", "Start Menu", "Programs"])
}

#[cfg(windows)]
fn shortcut(lnk: &Path, target: &Path) -> Result<(), String> {
    let ps = |s: &Path| s.display().to_string().replace('\'', "''");
    let script = format!(
        "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('{}');$s.TargetPath='{}';$s.WorkingDirectory='{}';$s.IconLocation='{},0';$s.Save()",
        ps(lnk), ps(target), ps(target.parent().unwrap_or(Path::new("."))), ps(target)
    );
    let mut c = Command::new("powershell");
    c.args(["-NoProfile", "-Command", &script]);
    no_window(&mut c);
    let out = c.output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

// ---------- проверка папки ----------
pub fn check_dir(dir: &str) -> Value {
    let p = PathBuf::from(dir.trim());
    if !p.is_absolute() {
        return json!({ "ok": false, "error": "укажите полный путь" });
    }
    if p.join(".git").exists() {
        return json!({ "ok": false, "error": "это git-репозиторий — выберите другую папку" });
    }
    let installed = fs::read_to_string(p.join("manifest.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|m| m["version"].as_str().map(String::from));
    let empty = fs::read_dir(&p).map(|mut r| r.next().is_none()).unwrap_or(true);
    json!({ "ok": true, "exists": p.exists(), "empty": empty, "installed": installed })
}

// ---------- установка ----------
pub struct Options {
    pub dir: PathBuf,
    pub desktop: bool,
    pub start_menu: bool,
    pub python: bool,
}

pub fn install(app: Option<&AppHandle>, opt: &Options) -> Result<Value, String> {
    let pl = payload().ok_or("в установщике нет архива приложения")?;
    let dir = &opt.dir;
    if dir.join(".git").exists() {
        return Err(format!("{} — git-репозиторий, установка туда отключена", dir.display()));
    }
    fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let exe = crate::update::self_path().map_err(|e| e.to_string())?;
    let mut f = fs::File::open(&exe).map_err(|e| e.to_string())?;

    // файлы приложения
    f.seek(SeekFrom::Start(pl.entries.0)).map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; pl.entries.1 as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    let (mut pos, total) = (0usize, buf.len() as u64);
    let take = |pos: &mut usize, n: usize| -> Result<&[u8], String> {
        let s = buf.get(*pos..*pos + n).ok_or("архив повреждён")?;
        *pos += n;
        Ok(s)
    };
    let mut count = 0;
    while pos < buf.len() {
        let n = u16::from_le_bytes(take(&mut pos, 2)?.try_into().unwrap()) as usize;
        let rel = String::from_utf8_lossy(take(&mut pos, n)?).into_owned();
        let raw = u32::from_le_bytes(take(&mut pos, 4)?.try_into().unwrap()) as usize;
        let comp = u32::from_le_bytes(take(&mut pos, 4)?.try_into().unwrap()) as usize;
        let data = take(&mut pos, comp)?;
        let Some(rp) = crate::update::safe_rel(&rel) else { return Err(format!("недопустимый путь в архиве: {rel}")) };
        let mut out = Vec::with_capacity(raw);
        flate2::read::DeflateDecoder::new(data).read_to_end(&mut out).map_err(|e| format!("{rel}: {e}"))?;
        let dst = dir.join(rp);
        if let Some(d) = dst.parent() {
            fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
        }
        fs::write(&dst, &out).map_err(|e| format!("{}: {e}", dst.display()))?;
        count += 1;
        if count % 50 == 0 {
            progress(app, "files", pos as u64, total);
        }
    }
    progress(app, "files", total, total);

    // сам бинарь — начало установщика без архива
    f.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut body = vec![0u8; pl.exe_len as usize];
    f.read_exact(&mut body).map_err(|e| e.to_string())?;
    let target = dir.join(crate::update::BIN);
    let mut old = target.clone().into_os_string();
    old.push(".old");
    let _ = fs::rename(&target, old); // запущенный бинарь при переустановке
    fs::write(&target, body).map_err(|e| format!("{}: {e}", target.display()))?;
    #[cfg(windows)]
    let _ = fs::write(dir.join("uninstall.cmd"), "@echo off\r\nstart \"\" \"%~dp0maistep.exe\" --uninstall\r\n");
    #[cfg(not(windows))]
    {
        use std::os::unix::fs::PermissionsExt;
        let x = |p: &Path| fs::set_permissions(p, fs::Permissions::from_mode(0o755));
        x(&target).map_err(|e| format!("{}: {e}", target.display()))?;
        let sh = dir.join("uninstall.sh");
        let _ = fs::write(&sh, "#!/bin/sh\nexec \"$(dirname \"$0\")/maistep.AppImage\" --uninstall \"$@\"\n").and_then(|_| x(&sh));
        let _ = fs::write(dir.join("maistep.png"), ICON);
    }
    for d in DATA_DIRS {
        let _ = fs::create_dir_all(dir.join(d));
    }

    if opt.python && !crate::server::portable_python(dir).is_file() {
        download_python(app, dir)?;
    }

    let mut shortcuts = Vec::new();
    for (want, folder) in [(opt.desktop, desktop()), (opt.start_menu, start_menu())] {
        if let (true, Some(folder)) = (want, folder) {
            let lnk = folder.join(SHORTCUT);
            shortcut(&lnk, &target)?;
            shortcuts.push(lnk.display().to_string());
        }
    }
    let info = json!({ "version": version(), "shortcuts": shortcuts, "python": crate::server::portable_python(dir).is_file() });
    crate::project::write_json(&dir.join("install.json"), &info, true)?;
    Ok(json!({ "dir": dir.display().to_string(), "files": count, "info": info }))
}

// Python 3.12 в <папка>/python и .venv из него — приложение не зависит от системного Python
fn download_python(app: Option<&AppHandle>, dir: &Path) -> Result<(), String> {
    let resp = ureq::get(PYTHON_URL).call().map_err(|e| format!("загрузка Python: {e}"))?;
    let total: u64 = resp.header("content-length").and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut data = Vec::with_capacity(total as usize);
    let mut chunk = vec![0u8; 1 << 16];
    loop {
        let n = reader.read(&mut chunk).map_err(|e| format!("загрузка Python: {e}"))?;
        if n == 0 {
            break;
        }
        data.extend_from_slice(&chunk[..n]);
        progress(app, "python", data.len() as u64, total.max(data.len() as u64));
    }
    progress(app, "python-unpack", 0, 1);
    // в архиве всё лежит в python/ — распаковываем в корень папки
    tar::Archive::new(flate2::read::GzDecoder::new(&data[..])).unpack(dir).map_err(|e| format!("распаковка Python: {e}"))?;
    progress(app, "python-unpack", 1, 1);
    let py = crate::server::portable_python(dir);
    let mut c = Command::new(&py);
    c.args(["-m", "venv", "--clear"]).arg(dir.join(".venv"));
    no_window(&mut c);
    match c.output() {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr);
            let tail: Vec<&str> = err.lines().rev().take(4).collect();
            Err(format!("не удалось создать .venv из {}: {}", py.display(), tail.into_iter().rev().collect::<Vec<_>>().join(" | ")))
        }
        Err(e) => Err(format!("не удалось создать .venv из {}: {e}", py.display())),
    }
}

// ---------- удаление ----------
fn read_info(root: &Path) -> Value {
    fs::read_to_string(root.join("install.json")).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(json!({}))
}

pub fn uninstall(root: &Path, keep_data: bool) -> Result<(), String> {
    let exe = crate::update::self_path().map_err(|e| e.to_string())?;
    if exe.parent() != Some(root) || !root.join("install.json").is_file() || root.join(".git").exists() {
        return Err(format!("{} — не папка установленного maistep, удаление отменено", root.display()));
    }
    for lnk in read_info(root)["shortcuts"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if lnk.ends_with(SHORTCUT) {
            let _ = fs::remove_file(lnk);
        }
    }
    let data: &[&str] = if keep_data { &[] } else { &DATA_DIRS };
    let mut errors = Vec::new();
    for name in APP_ITEMS.iter().chain(data) {
        let p = root.join(name);
        let r = if p.is_dir() { fs::remove_dir_all(&p) } else if p.exists() { fs::remove_file(&p) } else { Ok(()) };
        if let Err(e) = r {
            errors.push(format!("{name}: {e}"));
        }
    }
    // свой бинарь и папка (только если в ней ничего не осталось): Windows — после выхода, Linux — сразу
    // (запущенный файл можно удалить: процесс держит inode)
    #[cfg(windows)]
    {
        // кавычки путей cmd должен получить как есть — обычный arg экранирует их \" (cmd так не понимает)
        use std::os::windows::process::CommandExt;
        let script = format!("ping -n 3 127.0.0.1 >nul & del /f /q \"{}\" & rmdir \"{}\" 2>nul", exe.display(), root.display());
        let mut c = Command::new("cmd");
        c.arg("/C").raw_arg(format!("\"{script}\""));
        no_window(&mut c);
        c.spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = fs::remove_file(&exe);
        let _ = fs::remove_dir(root);
    }
    if errors.is_empty() { Ok(()) } else { Err(format!("часть файлов занята (закройте maistep и повторите): {}", errors.join("; "))) }
}

// ---------- окно ----------
pub struct SetupState {
    pub uninstall_root: Option<PathBuf>,
}

#[tauri::command]
pub fn setup_info(st: tauri::State<SetupState>) -> Value {
    match &st.uninstall_root {
        Some(root) => {
            let data: Vec<&str> = DATA_DIRS.iter().copied().filter(|d| root.join(d).exists()).collect();
            json!({ "mode": "uninstall", "version": version(), "os": std::env::consts::OS, "dir": root.display().to_string(), "data": data,
                    "shortcuts": read_info(root)["shortcuts"] })
        }
        None => json!({ "mode": "install", "version": version(), "os": std::env::consts::OS, "dir": default_dir().display().to_string() }),
    }
}

#[tauri::command]
pub fn setup_check_dir(dir: String) -> Value {
    check_dir(&dir)
}

#[tauri::command]
pub async fn setup_pick_dir(current: String) -> Option<String> {
    let mut d = rfd::AsyncFileDialog::new().set_title("Папка для maistep");
    let cur = PathBuf::from(&current);
    if let Some(p) = cur.ancestors().find(|p| p.is_dir()) {
        d = d.set_directory(p);
    }
    d.pick_folder().await.map(|f| {
        let p = f.path().to_path_buf();
        // выбрали пустую папку или папку maistep — ставим в неё, иначе — в подпапку maistep
        let empty = fs::read_dir(&p).map(|mut r| r.next().is_none()).unwrap_or(true);
        let ours = p.join("manifest.json").is_file() || p.file_name().is_some_and(|n| n.eq_ignore_ascii_case("maistep"));
        if empty || ours { p } else { p.join("maistep") }.display().to_string()
    })
}

#[tauri::command]
pub async fn setup_install(app: AppHandle, dir: String, desktop: bool, start_menu: bool, python: bool) -> Result<Value, String> {
    let opt = Options { dir: PathBuf::from(dir.trim()), desktop, start_menu, python };
    tauri::async_runtime::spawn_blocking(move || install(Some(&app), &opt)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn setup_launch(app: AppHandle, dir: String) -> Result<(), String> {
    let mut c = Command::new(PathBuf::from(&dir).join(crate::update::BIN));
    // переменные AppImage установщика не должны достаться приложению (иначе оно сочтёт себя установщиком)
    no_window(&mut c);
    c.current_dir(&dir).spawn().map_err(|e| e.to_string())?;
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn setup_uninstall(st: tauri::State<SetupState>, keep_data: bool) -> Result<(), String> {
    let root = st.uninstall_root.clone().ok_or("не режим удаления")?;
    uninstall(&root, keep_data)
}

#[tauri::command]
pub fn setup_close(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn setup_open_dir(dir: String) {
    let mut c = Command::new(if cfg!(windows) { "explorer" } else { "xdg-open" });
    c.arg(dir);
    no_window(&mut c);
    let _ = c.spawn();
}

// Окно установщика/удаления. Данные WebView — во временной папке (после закрытия не нужны).
pub fn run(context: tauri::Context, uninstall_root: Option<PathBuf>) {
    let tmp = std::env::temp_dir().join("maistep-setup-webview");
    let title = if uninstall_root.is_some() { "Удаление maistep" } else { "Установка maistep" };
    tauri::Builder::default()
        .manage(SetupState { uninstall_root })
        .invoke_handler(tauri::generate_handler![
            setup_info, setup_check_dir, setup_pick_dir, setup_install, setup_launch, setup_uninstall, setup_close, setup_open_dir,
        ])
        .setup(move |app| {
            WebviewWindowBuilder::new(app, "setup", WebviewUrl::App("setup.html".into()))
                .title(title)
                .inner_size(640.0, 460.0)
                .resizable(false)
                .maximizable(false)
                .data_directory(tmp.clone())
                .build()?;
            Ok(())
        })
        .run(context)
        .expect("не удалось открыть окно установки");
    let _ = fs::remove_dir_all(std::env::temp_dir().join("maistep-setup-webview"));
}

// Без окна: maistep-setup.exe --silent --dir <папка> [--desktop] [--start-menu] [--python]
pub fn silent(args: &[String]) -> i32 {
    let val = |k: &str| args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned();
    let has = |k: &str| args.iter().any(|a| a == k);
    let dir = val("--dir").map(PathBuf::from).unwrap_or_else(default_dir);
    let opt = Options { dir, desktop: has("--desktop"), start_menu: has("--start-menu"), python: has("--python") };
    match install(None, &opt) {
        Ok(r) => {
            println!("установлено: {r}");
            0
        }
        Err(e) => {
            eprintln!("ошибка установки: {e}");
            1
        }
    }
}

// Ошибка без окна приложения (удаление не из той папки и т.п.)
pub fn error_box(text: &str) {
    rfd::MessageDialog::new().set_title("maistep").set_description(text).set_level(rfd::MessageLevel::Error).show();
}

// Данные WebView окна — в папке приложения (portable); один раз переносятся из старого места в AppData
pub fn webview_dir(app: &tauri::App, root: &Path) -> PathBuf {
    let dir = root.join("user").join("webview");
    if !dir.join("EBWebView").exists() {
        if let Ok(old) = app.path().app_local_data_dir() {
            let old = old.join("EBWebView");
            if old.is_dir() {
                let _ = copy_dir(&old, &dir.join("EBWebView"));
            }
        }
    }
    dir
}

fn copy_dir(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for e in fs::read_dir(src)?.flatten() {
        let p = e.path();
        let t = dst.join(e.file_name());
        if p.is_dir() {
            copy_dir(&p, &t)?;
        } else {
            let _ = fs::copy(&p, &t); // занятые файлы (lock) пропускаем
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uninstall_refuses_foreign_folders() {
        // папка теста — не папка exe: удаление обязано отказаться, даже если там есть install.json
        let root = std::env::temp_dir().join(format!("maistep-uninstall-test-{}", std::process::id()));
        fs::create_dir_all(root.join("server")).unwrap();
        fs::write(root.join("install.json"), "{}").unwrap();
        fs::write(root.join("server").join("main.py"), "x").unwrap();
        assert!(uninstall(&root, false).is_err());
        assert!(root.join("server").join("main.py").exists());
        let _ = fs::remove_dir_all(&root);
    }
}
