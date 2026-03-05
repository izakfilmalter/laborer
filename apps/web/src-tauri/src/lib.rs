use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// Update the tray tooltip to reflect the current workspace count.
/// Called from the frontend when the workspace count changes.
#[tauri::command]
fn update_tray_workspace_count(app: tauri::AppHandle, count: u32) {
    if let Some(tray) = app.tray_by_id("laborer-tray") {
        let tooltip = if count == 0 {
            "Laborer — No running workspaces".to_string()
        } else if count == 1 {
            "Laborer — 1 running workspace".to_string()
        } else {
            format!("Laborer — {count} running workspaces")
        };
        let _ = tray.set_tooltip(Some(&tooltip));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![update_tray_workspace_count])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Build system tray menu
            let show_i = MenuItem::with_id(app, "show", "Show Laborer", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            // Build tray icon with menu
            let _tray = TrayIconBuilder::with_id("laborer-tray")
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("Laborer — No running workspaces")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.unminimize();
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
