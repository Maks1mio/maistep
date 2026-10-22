// Сервер исполнения графов: `python -u server/main.py --port N` (по умолчанию 3300).
// Python: MAISTEP_PYTHON, иначе .venv проекта, иначе `python` / `py -3` из PATH.
// Вывод сервера идёт в консоль редактора (событие "console"), смена состояния — событие "server".
// Перед запуском порт освобождается: если его держит python (сервер прошлого запуска), процесс завершается;
// чужой процесс не трогаем — команда вернёт ошибку с его именем.
use std::io::{BufRead, BufReader};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::json;
use tauri::{AppHandle, Emitter};

use crate::commands::no_window;

pub const DEFAULT_PORT: u16 = 3300;

#[derive(Default)]
pub struct Server {
    child: Option<Child>,
    port: u16,
    gen: u64,
}

#[derive(Serialize, Clone)]
pub struct Status {
    pub running: bool,
    pub port: u16,
    pub pid: Option<u32>,
}

pub type Shared = Arc<Mutex<Server>>;

pub fn status(s: &Shared) -> Status {
    let mut g = s.lock().unwrap();
    if let Some(ch) = g.child.as_mut() {
        if let Ok(Some(_)) = ch.try_wait() {
            g.child = None;
        }
    }
    Status { running: g.child.is_some(), port: if g.port == 0 { DEFAULT_PORT } else { g.port }, pid: g.child.as_ref().map(Child::id) }
}

// ---------- выбор Python ----------

// Интерпретатор и аргументы перед скриптом
fn python(root: &Path) -> (PathBuf, Vec<String>) {
    if let Ok(p) = std::env::var("MAISTEP_PYTHON") {
        if !p.trim().is_empty() {
            return (PathBuf::from(p), vec![]);
        }
    }
    for venv in [".venv", "venv"] {
        let p = if cfg!(windows) { root.join(venv).join("Scripts").join("python.exe") } else { root.join(venv).join("bin").join("python") };
        if p.is_file() {
            return (p, vec![]);
        }
    }
    if run_hidden("python", &["--version"]).is_some() {
        return (PathBuf::from("python"), vec![]);
    }
    if cfg!(windows) && run_hidden("py", &["-3", "--version"]).is_some() {
        return (PathBuf::from("py"), vec!["-3".into()]);
    }
    (PathBuf::from("python3"), vec![])
}

// ---------- освобождение порта ----------

fn port_busy(port: u16) -> bool {
    TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(250)).is_ok()
}

// Служебная команда без окна консоли; None — команда не запустилась
fn run_hidden(cmd: &str, args: &[&str]) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    no_window(&mut c);
    c.output().ok().filter(|o| o.status.success()).map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
}

fn port_pids(port: u16) -> Vec<u32> {
    let mut pids = Vec::new();
    #[cfg(windows)]
    if let Some(out) = run_hidden("netstat", &["-ano", "-p", "tcp"]) {
        let want = port.to_string();
        for line in out.lines() {
            let f: Vec<&str> = line.split_whitespace().collect();
            // TCP  <локальный адрес>  <внешний>  LISTENING  <pid>
            if f.len() < 5 || !f[0].eq_ignore_ascii_case("TCP") || f[3] != "LISTENING" { continue; }
            if f[1].rsplit(':').next() != Some(want.as_str()) { continue; }
            if let Ok(pid) = f[4].parse::<u32>() {
                if !pids.contains(&pid) { pids.push(pid); }
            }
        }
    }
    #[cfg(not(windows))]
    if let Some(out) = run_hidden("lsof", &["-ti", &format!("tcp:{port}"), "-sTCP:LISTEN"]) {
        for line in out.lines() {
            if let Ok(pid) = line.trim().parse::<u32>() { pids.push(pid); }
        }
    }
    pids
}

fn proc_name(pid: u32) -> String {
    #[cfg(windows)]
    if let Some(out) = run_hidden("tasklist", &["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"]) {
        let line = out.lines().next().unwrap_or("");
        if let Some(rest) = line.strip_prefix('"') {
            return rest.split('"').next().unwrap_or("").to_string();
        }
    }
    #[cfg(not(windows))]
    if let Some(out) = run_hidden("ps", &["-p", &pid.to_string(), "-o", "comm="]) {
        return out.trim().to_string();
    }
    String::new()
}

fn kill_tree(pid: u32) {
    #[cfg(windows)]
    let _ = run_hidden("taskkill", &["/PID", &pid.to_string(), "/T", "/F"]);
    #[cfg(not(windows))]
    let _ = run_hidden("kill", &["-9", &pid.to_string()]);
}

fn free_port(app: &AppHandle, port: u16) -> Result<(), String> {
    if !port_busy(port) { return Ok(()); }
    let pids = port_pids(port);
    if pids.is_empty() {
        return Err(format!("порт {port} занят, но определить процесс не удалось — освободите его вручную"));
    }
    let mut done = Vec::new();
    for pid in &pids {
        let name = proc_name(*pid);
        let low = name.to_ascii_lowercase();
        if !(low.starts_with("python") || low.starts_with("py.exe") || low == "py") {
            if !port_busy(port) { return Ok(()); }
            let who = if name.is_empty() { format!("неизвестный процесс (PID {pid})") } else { format!("{name} (PID {pid})") };
            return Err(format!("порт {port} занят: {who} — закройте его или укажите другой порт"));
        }
        done.push(format!("{name} (PID {pid})"));
        kill_tree(*pid);
    }
    let _ = app.emit("console", json!({ "src": "editor", "level": "warn", "text": format!("порт {port} был занят — завершён старый сервер: {}", done.join(", ")) }));
    for _ in 0..40 {
        if !port_busy(port) { return Ok(()); }
        std::thread::sleep(Duration::from_millis(100));
    }
    Err(format!("порт {port} всё ещё занят после завершения старого сервера"))
}

pub fn start(app: &AppHandle, s: &Shared, root: &Path, port: u16) -> Result<Status, String> {
    stop(app, s);
    free_port(app, port)?;
    let (py, pre) = python(root);
    let mut c = Command::new(&py);
    c.args(&pre)
        .arg("-u")
        .arg("server/main.py")
        .arg("--port")
        .arg(port.to_string())
        .current_dir(root)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .env("MAISTEP_APP", "1")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    no_window(&mut c);
    let mut child = c.spawn().map_err(|e| format!("не удалось запустить {}: {e} (нужен Python 3.10+ в PATH или MAISTEP_PYTHON)", py.display()))?;
    let gen = {
        let mut g = s.lock().unwrap();
        g.gen += 1;
        g.gen
    };
    for (stream, level) in [(child.stdout.take().map(|x| Box::new(x) as Box<dyn std::io::Read + Send>), "info"),
        (child.stderr.take().map(|x| Box::new(x) as Box<dyn std::io::Read + Send>), "error")]
    {
        let Some(stream) = stream else { continue };
        let app = app.clone();
        let shared = s.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stream).lines().map_while(Result::ok) {
                // logging Python пишет в stderr и обычные сообщения — уровень берём из префикса
                let lv = if level == "error" && !(line.contains("ERROR") || line.contains("Traceback") || line.contains("Error")) { "info" } else { level };
                let _ = app.emit("console", json!({ "src": "server", "level": lv, "text": line }));
            }
            if level == "info" {
                let mut g = shared.lock().unwrap();
                if g.gen == gen {
                    if let Some(ch) = g.child.as_mut() {
                        let _ = ch.wait();
                    }
                    g.child = None;
                    drop(g);
                    let _ = app.emit("server", status(&shared));
                }
            }
        });
    }
    {
        let mut g = s.lock().unwrap();
        g.child = Some(child);
        g.port = port;
    }
    let st = status(s);
    let _ = app.emit("server", st.clone());
    let _ = app.emit("console", json!({ "src": "editor", "level": "info", "text": format!("сервер запущен: {} server/main.py → http://localhost:{port}", py.display()) }));
    Ok(st)
}

pub fn stop(app: &AppHandle, s: &Shared) {
    let child = {
        let mut g = s.lock().unwrap();
        g.gen += 1;
        g.child.take()
    };
    if let Some(mut ch) = child {
        // py.exe — лаунчер: убиваем всё дерево, иначе python.exe остался бы держать порт
        kill_tree(ch.id());
        let _ = ch.kill();
        let _ = ch.wait();
        let _ = app.emit("console", json!({ "src": "editor", "level": "info", "text": "сервер остановлен" }));
    }
    let _ = app.emit("server", status(s));
}

pub fn kill_on_exit(s: &Shared) {
    if let Some(mut ch) = s.lock().unwrap().child.take() {
        kill_tree(ch.id());
        let _ = ch.kill();
        let _ = ch.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn busy_port_belongs_to_this_process() {
        let l = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(port_busy(port));
        assert!(port_pids(port).contains(&std::process::id()));
    }
}
