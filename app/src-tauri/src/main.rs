// maistep: окно редактора AI-пайплайнов (Tauri v2, веб-UI в app/ui). Исполнение графов — Python-сервер server/main.py.
#![cfg_attr(all(not(debug_assertions), windows), windows_subsystem = "windows")]

mod commands;
mod project;
mod server;
mod setup;
mod update;

use std::borrow::Cow;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::http::{Response, StatusCode};
use tauri::{Manager, WebviewWindowBuilder};

// Корень проекта — папка с server/main.py (ищем сначала от exe вверх, потом от текущей папки)
fn find_root() -> PathBuf {
    let mut bases = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            bases.push(dir.to_owned());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        bases.push(cwd);
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
    let args: Vec<String> = std::env::args().collect();
    // установщик: тот же exe с архивом приложения в конце (setup.rs)
    if setup::payload().is_some() {
        if args.iter().any(|a| a == "--silent") {
            std::process::exit(setup::silent(&args));
        }
        return setup::run(tauri::generate_context!(), None);
    }
    // удаление — только папки самого exe с install.json (не от текущей папки!)
    if args.iter().any(|a| a == "--uninstall") {
        let silent = args.iter().any(|a| a == "--silent");
        let root = match setup::installed_root() {
            Ok(r) => r,
            Err(e) => {
                if silent { eprintln!("{e}"); } else { setup::error_box(&e); }
                std::process::exit(1);
            }
        };
        if silent {
            let keep = args.iter().any(|a| a == "--keep-data");
            std::process::exit(setup::uninstall(&root, keep).map(|_| 0).unwrap_or_else(|e| { eprintln!("{e}"); 1 }));
        }
        return setup::run(tauri::generate_context!(), Some(root));
    }
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
        // mai://localhost/p/<путь> (на Windows http://mai.localhost/p/…) — любой файл проекта для проводника Project
        .register_uri_scheme_protocol("mai", move |_ctx, req| {
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
            commands::ui_stamp,
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
            // окно создаётся здесь, а не из tauri.conf.json: данные WebView (localStorage) — в папке приложения
            let root = app.state::<commands::AppState>().root.clone();
            let conf = app.config().app.windows.iter().find(|w| w.label == "main").cloned().ok_or("нет окна main в tauri.conf.json")?;
            WebviewWindowBuilder::from_config(app.handle(), &conf)?
                .data_directory(setup::webview_dir(app, &root))
                .title(format!("maistep — {}", root.display()))
                .build()?;
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
