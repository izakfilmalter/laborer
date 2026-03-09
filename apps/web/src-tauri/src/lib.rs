use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

mod sidecar;

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

/// Focus the main Laborer window: unminimize, show, and set focus.
/// Shared by the tray icon click, "Show Laborer" menu item, and global shortcut.
fn focus_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Create the sidecar manager upfront so the shell environment is probed
    // once, before any sidecars are spawned.
    let manager = Arc::new(sidecar::SidecarManager::new());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Window state plugin: persists and restores window position, size,
        // maximized/fullscreen state across app restarts.
        // See Issue #117: Tauri window management.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(manager.clone())
        .invoke_handler(tauri::generate_handler![
            update_tray_workspace_count,
            sidecar::restart_sidecar
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Register global shortcut: Cmd+Shift+L (macOS) / Ctrl+Shift+L (Windows/Linux)
            // Brings the Laborer window to the front from anywhere in the OS.
            // See Issue #116: Tauri global shortcut.
            #[cfg(desktop)]
            {
                let shortcut = Shortcut::new(Some(Modifiers::SUPER | Modifiers::SHIFT), Code::KeyL);
                app.handle().plugin(
                    tauri_plugin_global_shortcut::Builder::new()
                        .with_handler(move |app, _shortcut, event| {
                            if event.state() == ShortcutState::Pressed {
                                focus_main_window(app);
                            }
                        })
                        .build(),
                )?;
                app.global_shortcut().register(shortcut)?;
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
                        focus_main_window(app);
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
                        focus_main_window(app);
                    }
                })
                .build(app)?;

            // Intercept the window close event to minimize to tray instead of quitting.
            // The user can quit via the tray menu "Quit" item or Cmd+Q.
            // See Issue #117: Tauri window management.
            if let Some(window) = app.get_webview_window("main") {
                let window_clone = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        // Prevent the window from actually closing
                        api.prevent_close();
                        // Hide the window instead (minimize to tray)
                        let _ = window_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Run with event handler to kill all sidecars on app exit.
    let exit_manager = manager.clone();
    app.run(move |_app, event| {
        if let RunEvent::Exit = event {
            // Block on killing all sidecars before the process exits.
            // Use a new tokio runtime since the Tauri runtime is shutting down.
            let mgr = exit_manager.clone();
            std::thread::spawn(move || {
                let rt = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .expect("Failed to create tokio runtime for cleanup");
                rt.block_on(mgr.kill_all());
            })
            .join()
            .expect("Sidecar cleanup thread panicked");
        }
    });
}
