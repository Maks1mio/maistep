// maistep: окно редактора AI-пайплайнов (Tauri v2, веб-UI в app/ui). Исполнение графов — Python-сервер server/main.py.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

mod commands;
mod project;
mod server;
mod update;

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::http::{Response, StatusCode};
use tauri::Manager;

// Корень проекта — папка с server/main.py (ищем от текущей папки и от exe вверх)
fn find_root() -> PathBuf {
    let mut bases = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        bases.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            bases.push(dir.to_owned());
        }
    }
    for base in bases {
        let mut dir = Some(base.as_path());
        while let Some(d) = dir {
            if d.join("server").join("main.py").is_file() {
                return d.to_owned();
            }
            dir = d.parent();
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn main() {
    let root = find_root();
    update::cleanup();
    if update::apply_pending(&root) {
        // новый maistep.exe уже на месте старого — запускаем его
        if let Ok(exe) = std::env::current_exe() {
            if std::process::Command::new(exe).args(std::env::args_os().skip(1)).spawn().is_ok() {
                return;
            }
        }
    }
    let mut context = tauri::generate_context!();
    let embedded = context.set_assets(Box::new(update::NoAssets));
    context.set_assets(Box::new(update::DiskAssets { dir: root.join("app").join("ui"), fallback: embedded }));
    let shared: server::Shared = Arc::new(Mutex::new(server::Server::default()));
    let on_exit = shared.clone();
    let file_root = root.clone();
    let app = tauri::Builder::default()
        .manage(commands::AppState { root, server: shared })
        // oja://localhost/p/<путь> (на Windows http://oja.localhost/p/…) — любой файл проекта для проводника Project
        .register_uri_scheme_protocol("oja", move |_ctx, req| {
            let path = percent_decode(req.uri().path().trim_start_matches('/'));
            let (pak, rel) = path.split_once('/').unwrap_or(("", ""));
            let file = if pak == "p" { project::resolve_file(&file_root, rel) } else { None };
            match file {
                Some(file) => match std::fs::read(&file) {
                    Ok(bytes) => Response::builder()
                        .header("content-type", project::mime(&file))
                        .header("access-control-allow-origin", "*")
                        .header("cache-control", "no-cache")
                        .body(Cow::Owned(bytes))
                        .unwrap(),
                    Err(_) => Response::builder().status(StatusCode::INTERNAL_SERVER_ERROR).body(Cow::Borrowed(&[][..])).unwrap(),
                },
                None => Response::builder().status(StatusCode::NOT_FOUND).body(Cow::Borrowed(&[][..])).unwrap(),
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::load_project,
            commands::data_write,
            commands::data_delete,
            commands::data_stamp,
            commands::fs_list,
            commands::fs_search,
            commands::fs_read,
            commands::fs_write,
            commands::server_start,
            commands::server_stop,
            commands::server_status,
            commands::open_external,
            commands::app_restart,
        ])
        .setup(|app| {
            if let Some(w) = app.get_webview_window("main") {
                let root = app.state::<commands::AppState>().root.clone();
                let _ = w.set_title(&format!("maistep — {}", root.display()));
            }
            Ok(())
        })
        .build(context)
        .expect("не удалось запустить maistep");
    app.run(move |_, ev| {
        if let tauri::RunEvent::Exit = ev {
            server::kill_on_exit(&on_exit);
        }
    });
}
