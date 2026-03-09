use std::sync::Arc;
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, RunEvent,
};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

mod sidecar;

/// Data returned by `await_initialization` once backend services are ready.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceUrls {
    /// HTTP base URL for the main server (e.g., "http://localhost:2100").
    pub server_url: String,
    /// HTTP base URL for the terminal service (e.g., "http://localhost:2102").
    pub terminal_url: String,
}

/// Shared state for tracking sidecar initialization progress.
/// The sender is set to `Some(urls)` once both sidecars are healthy.
struct InitState {
    rx: tokio::sync::watch::Receiver<Option<ServiceUrls>>,
}

/// Tauri command that the frontend calls on load to wait for backend services.
///
/// In production mode (Tauri build), this blocks until sidecars are healthy
/// and returns the service URLs. In dev mode (tauri dev), sidecars are not
/// spawned by the app, so this returns immediately with the default URLs
/// (the Vite proxy handles routing).
#[tauri::command]
async fn await_initialization(
    state: tauri::State<'_, InitState>,
) -> Result<ServiceUrls, String> {
    let mut rx = state.rx.clone();

    // If already initialized, return immediately.
    if let Some(urls) = rx.borrow().clone() {
        return Ok(urls);
    }

    // Wait for the initialization to complete.
    loop {
        rx.changed()
            .await
            .map_err(|_| "Initialization sender dropped".to_string())?;
        if let Some(urls) = rx.borrow().clone() {
            return Ok(urls);
        }
    }
}

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

    // Channel for tracking when sidecar initialization is complete.
    let (init_tx, init_rx) = tokio::sync::watch::channel::<Option<ServiceUrls>>(None);

    // In dev mode (debug builds), sidecars are run separately via `turbo dev`.
    // Immediately mark initialization as complete with default URLs so the
    // frontend doesn't block on `await_initialization`.
    if cfg!(debug_assertions) {
        let _ = init_tx.send(Some(ServiceUrls {
            server_url: String::new(),
            terminal_url: String::new(),
        }));
    }

    // Clone manager before the setup closure captures it.
    let exit_manager = manager.clone();

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // Window state plugin: persists and restores window position, size,
        // maximized/fullscreen state across app restarts.
        // See Issue #117: Tauri window management.
        .plugin(tauri_plugin_window_state::Builder::default().build());

    // In production, serve the frontend via http://localhost:2101 instead of
    // tauri://localhost. This avoids WebKit's cross-origin restrictions that
    // block requests from tauri:// to http://localhost:* sidecar services.
    if !cfg!(debug_assertions) {
        builder = builder.plugin(tauri_plugin_localhost::Builder::new(2101).build());
    }

    let app = builder
        .manage(manager.clone())
        .manage(InitState { rx: init_rx })
        .invoke_handler(tauri::generate_handler![
            update_tray_workspace_count,
            sidecar::restart_sidecar,
            await_initialization
        ])
        .setup(move |app| {
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
                // Open devtools so we can inspect logs in production builds.
                window.open_devtools();

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

            // In release mode, create the MCP symlink and spawn sidecars.
            if !cfg!(debug_assertions) {
                // Create or update the MCP symlink at /usr/local/bin/laborer-mcp
                // before spawning sidecars, so the server sidecar can detect it
                // and pass the symlink path to mcp-registrar.ts.
                sidecar::SidecarManager::create_mcp_symlink(app.handle());

                // Spawn sidecars in order: terminal first (port 2102),
                // then server (port 2100, which connects to terminal on startup).
                // The `await_initialization` command blocks the frontend until both are healthy.
                let app_handle = app.handle().clone();
                let mgr = manager.clone();
                tauri::async_runtime::spawn(async move {
                    log::info!("Starting sidecar initialization...");

                    // 1. Start terminal service first (server depends on it).
                    if let Err(e) = mgr
                        .spawn_and_wait_healthy(&app_handle, sidecar::SidecarName::Terminal)
                        .await
                    {
                        log::error!("Terminal sidecar failed to start: {e}");
                        // Don't block — the frontend will see the error via sidecar:error event.
                        // Still try to start the server in case terminal is optional.
                    }

                    // 2. Start main server (connects to terminal service on startup).
                    if let Err(e) = mgr
                        .spawn_and_wait_healthy(&app_handle, sidecar::SidecarName::Server)
                        .await
                    {
                        log::error!("Server sidecar failed to start: {e}");
                    }

                    // 3. Signal initialization complete with service URLs.
                    let urls = ServiceUrls {
                        server_url: "http://localhost:2100".to_string(),
                        terminal_url: "http://localhost:2102".to_string(),
                    };
                    let _ = init_tx.send(Some(urls));
                    log::info!("Sidecar initialization complete");
                });
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Run with event handler to kill all sidecars on app exit.
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
