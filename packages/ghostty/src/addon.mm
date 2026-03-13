/**
 * @laborer/ghostty native addon
 *
 * N-API addon that wraps the Ghostty C API for terminal rendering.
 * Built as Objective-C++ (.mm) because Ghostty surfaces require native
 * macOS AppKit views (NSView) and Metal layers for rendering.
 *
 * This module provides:
 * - Ghostty runtime initialization (init/getInfo/validateConfig)
 * - Ghostty app creation with runtime callbacks (createApp/destroyApp)
 * - Surface lifecycle (createSurface/destroySurface)
 * - Surface control (setSurfaceSize/setSurfaceFocus)
 * - IOSurface handle extraction for zero-copy rendering in Electron
 */

#include <napi.h>
#include <ghostty.h>
#include <string>
#include <vector>
#include <unordered_map>
#include <mutex>

#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#import <IOSurface/IOSurface.h>
#import <Metal/Metal.h>

namespace {

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

bool g_initialized = false;
ghostty_app_t g_app = nullptr;
ghostty_config_t g_app_config = nullptr;

/** Monotonically increasing surface ID counter. */
uint32_t g_next_surface_id = 1;

/**
 * Tracked Ghostty surface with its hosting NSView and NSWindow.
 * Each surface gets an offscreen NSWindow with a content NSView that
 * Ghostty renders into via Metal. The IOSurface from the Metal layer
 * can be extracted for sharing with Electron's renderer.
 */
struct TrackedSurface {
  uint32_t id;
  ghostty_surface_t surface;
  NSWindow* __strong window;
  NSView* __strong view;
};

/** Map of surface ID -> tracked surface. */
std::unordered_map<uint32_t, TrackedSurface> g_surfaces;
std::mutex g_surfaces_mutex;

/**
 * Reverse map: ghostty_surface_t pointer -> surface ID.
 * Used by RuntimeAction to quickly look up which surface an action
 * belongs to. Updated alongside g_surfaces.
 * Protected by g_surfaces_mutex.
 */
std::unordered_map<uintptr_t, uint32_t> g_surface_ptr_to_id;

// ---------------------------------------------------------------------------
// Action queue — Ghostty actions queued by RuntimeAction for JS retrieval
// ---------------------------------------------------------------------------

/**
 * Queued action event from the Ghostty runtime.
 * Populated by RuntimeAction() during ghostty_app_tick() and drained
 * by DrainActions() from the host process tick loop.
 */
struct QueuedAction {
  std::string action_type;
  /** Surface ID (0 if the action targets the app, not a surface). */
  uint32_t surface_id;
  /** String payload (title, pwd, etc.). Empty if not applicable. */
  std::string str_value;
  /** Numeric payload (exit code, cell width/height, health). */
  uint32_t num_value_1;
  uint32_t num_value_2;
};

std::vector<QueuedAction> g_action_queue;
std::mutex g_action_queue_mutex;

/**
 * Reverse lookup: find the surface ID for a ghostty_surface_t pointer.
 * Must be called with g_surfaces_mutex held.
 * Returns 0 if not found.
 */
uint32_t findSurfaceIdByPointer(ghostty_surface_t surface) {
  auto key = reinterpret_cast<uintptr_t>(surface);
  auto it = g_surface_ptr_to_id.find(key);
  if (it != g_surface_ptr_to_id.end()) {
    return it->second;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Runtime callbacks
// ---------------------------------------------------------------------------

/**
 * Wakeup callback — Ghostty calls this when it needs the app runtime
 * to process events. In a full integration this would schedule a
 * ghostty_app_tick on the main thread. For now it's a no-op since
 * we're not running an AppKit run loop in the helper process yet.
 */
void RuntimeWakeup(void* userdata) {
  // In the future, this should dispatch ghostty_app_tick to the
  // main thread / run loop. For now, wakeup is handled by the
  // tick timer in the helper process.
  (void)userdata;
}

/**
 * Action callback — Ghostty calls this when a terminal action occurs
 * (title change, bell, pwd update, close request, etc.).
 *
 * Core actions are queued into g_action_queue for the host process to
 * drain via DrainActions(). RENDER is handled directly by the Metal layer.
 *
 * Returns true if the action was handled, false otherwise.
 */
bool RuntimeAction(ghostty_app_t app, ghostty_target_s target,
                   ghostty_action_s action) {
  (void)app;

  // Resolve the surface ID from the target.
  uint32_t surface_id = 0;
  if (target.tag == GHOSTTY_TARGET_SURFACE) {
    std::lock_guard<std::mutex> lock(g_surfaces_mutex);
    surface_id = findSurfaceIdByPointer(target.target.surface);
  }

  switch (action.tag) {
    case GHOSTTY_ACTION_RENDER: {
      // Render requests are handled by the Metal layer automatically.
      // Queue a render_frame notification so the host process can notify
      // the Electron main process that a new frame is ready for import.
      QueuedAction qa;
      qa.action_type = "render_frame";
      qa.surface_id = surface_id;
      qa.num_value_1 = 0;
      qa.num_value_2 = 0;
      std::lock_guard<std::mutex> lock(g_action_queue_mutex);
      g_action_queue.push_back(std::move(qa));
      return true;
    }

    case GHOSTTY_ACTION_SET_TITLE: {
      QueuedAction qa;
      qa.action_type = "set_title";
      qa.surface_id = surface_id;
      qa.str_value = action.action.set_title.title != nullptr
                       ? std::string(action.action.set_title.title)
                       : "";
      qa.num_value_1 = 0;
      qa.num_value_2 = 0;
      std::lock_guard<std::mutex> lock(g_action_queue_mutex);
      g_action_queue.push_back(std::move(qa));
      return true;
    }

    case GHOSTTY_ACTION_PWD: {
      QueuedAction qa;
      qa.action_type = "pwd";
      qa.surface_id = surface_id;
      qa.str_value = action.action.pwd.pwd != nullptr
                       ? std::string(action.action.pwd.pwd)
                       : "";
      qa.num_value_1 = 0;
      qa.num_value_2 = 0;
      std::lock_guard<std::mutex> lock(g_action_queue_mutex);
      g_action_queue.push_back(std::move(qa));
      return true;
    }

    case GHOSTTY_ACTION_RING_BELL: {
      QueuedAction qa;
      qa.action_type = "ring_bell";
      qa.surface_id = surface_id;
      qa.num_value_1 = 0;
      qa.num_value_2 = 0;
      std::lock_guard<std::mutex> lock(g_action_queue_mutex);
      g_action_queue.push_back(std::move(qa));
      return true;
    }

    case GHOSTTY_ACTION_SHOW_CHILD_EXITED: {
      QueuedAction qa;
      qa.action_type = "child_exited";
      qa.surface_id = surface_id;
      qa.num_value_1 = action.action.child_exited.exit_code;
      qa.num_value_2 = 0;
      std::lock_guard<std::mutex> lock(g_action_queue_mutex);
      g_action_queue.push_back(std::move(qa));
      return true;
    }

    case GHOSTTY_ACTION_CLOSE_WINDOW: {
      QueuedAction qa;
      qa.action_type = "close_window";
      qa.surface_id = surface_id;
      qa.num_value_1 = 0;
      qa.num_value_2 = 0;
      std::lock_guard<std::mutex> lock(g_action_queue_mutex);
      g_action_queue.push_back(std::move(qa));
      return true;
    }

    case GHOSTTY_ACTION_CELL_SIZE: {
      QueuedAction qa;
      qa.action_type = "cell_size";
      qa.surface_id = surface_id;
      qa.num_value_1 = action.action.cell_size.width;
      qa.num_value_2 = action.action.cell_size.height;
      std::lock_guard<std::mutex> lock(g_action_queue_mutex);
      g_action_queue.push_back(std::move(qa));
      return true;
    }

    case GHOSTTY_ACTION_RENDERER_HEALTH: {
      QueuedAction qa;
      qa.action_type = "renderer_health";
      qa.surface_id = surface_id;
      // 0 = healthy, 1 = unhealthy
      qa.num_value_1 = (action.action.renderer_health ==
                        GHOSTTY_RENDERER_HEALTH_HEALTHY)
                           ? 0
                           : 1;
      qa.num_value_2 = 0;
      std::lock_guard<std::mutex> lock(g_action_queue_mutex);
      g_action_queue.push_back(std::move(qa));
      return true;
    }

    default: {
      // Unsupported action — queue it for observability so the host process
      // can log/count it, then return false so Ghostty knows we didn't
      // handle it natively. This fulfills the PRD requirement that
      // unsupported actions be tracked rather than silently dropped.
      const char* action_name = nullptr;
      switch (action.tag) {
        case GHOSTTY_ACTION_QUIT: action_name = "quit"; break;
        case GHOSTTY_ACTION_NEW_WINDOW: action_name = "new_window"; break;
        case GHOSTTY_ACTION_NEW_TAB: action_name = "new_tab"; break;
        case GHOSTTY_ACTION_CLOSE_TAB: action_name = "close_tab"; break;
        case GHOSTTY_ACTION_NEW_SPLIT: action_name = "new_split"; break;
        case GHOSTTY_ACTION_CLOSE_ALL_WINDOWS: action_name = "close_all_windows"; break;
        case GHOSTTY_ACTION_TOGGLE_MAXIMIZE: action_name = "toggle_maximize"; break;
        case GHOSTTY_ACTION_TOGGLE_FULLSCREEN: action_name = "toggle_fullscreen"; break;
        case GHOSTTY_ACTION_TOGGLE_TAB_OVERVIEW: action_name = "toggle_tab_overview"; break;
        case GHOSTTY_ACTION_TOGGLE_WINDOW_DECORATIONS: action_name = "toggle_window_decorations"; break;
        case GHOSTTY_ACTION_TOGGLE_QUICK_TERMINAL: action_name = "toggle_quick_terminal"; break;
        case GHOSTTY_ACTION_TOGGLE_COMMAND_PALETTE: action_name = "toggle_command_palette"; break;
        case GHOSTTY_ACTION_TOGGLE_VISIBILITY: action_name = "toggle_visibility"; break;
        case GHOSTTY_ACTION_TOGGLE_BACKGROUND_OPACITY: action_name = "toggle_background_opacity"; break;
        case GHOSTTY_ACTION_MOVE_TAB: action_name = "move_tab"; break;
        case GHOSTTY_ACTION_GOTO_TAB: action_name = "goto_tab"; break;
        case GHOSTTY_ACTION_GOTO_SPLIT: action_name = "goto_split"; break;
        case GHOSTTY_ACTION_GOTO_WINDOW: action_name = "goto_window"; break;
        case GHOSTTY_ACTION_RESIZE_SPLIT: action_name = "resize_split"; break;
        case GHOSTTY_ACTION_EQUALIZE_SPLITS: action_name = "equalize_splits"; break;
        case GHOSTTY_ACTION_TOGGLE_SPLIT_ZOOM: action_name = "toggle_split_zoom"; break;
        case GHOSTTY_ACTION_PRESENT_TERMINAL: action_name = "present_terminal"; break;
        case GHOSTTY_ACTION_SIZE_LIMIT: action_name = "size_limit"; break;
        case GHOSTTY_ACTION_RESET_WINDOW_SIZE: action_name = "reset_window_size"; break;
        case GHOSTTY_ACTION_INITIAL_SIZE: action_name = "initial_size"; break;
        case GHOSTTY_ACTION_SCROLLBAR: action_name = "scrollbar"; break;
        case GHOSTTY_ACTION_INSPECTOR: action_name = "inspector"; break;
        case GHOSTTY_ACTION_SHOW_GTK_INSPECTOR: action_name = "show_gtk_inspector"; break;
        case GHOSTTY_ACTION_RENDER_INSPECTOR: action_name = "render_inspector"; break;
        case GHOSTTY_ACTION_DESKTOP_NOTIFICATION: action_name = "desktop_notification"; break;
        case GHOSTTY_ACTION_PROMPT_TITLE: action_name = "prompt_title"; break;
        case GHOSTTY_ACTION_MOUSE_SHAPE: action_name = "mouse_shape"; break;
        case GHOSTTY_ACTION_MOUSE_VISIBILITY: action_name = "mouse_visibility"; break;
        case GHOSTTY_ACTION_MOUSE_OVER_LINK: action_name = "mouse_over_link"; break;
        case GHOSTTY_ACTION_OPEN_CONFIG: action_name = "open_config"; break;
        case GHOSTTY_ACTION_QUIT_TIMER: action_name = "quit_timer"; break;
        case GHOSTTY_ACTION_FLOAT_WINDOW: action_name = "float_window"; break;
        case GHOSTTY_ACTION_SECURE_INPUT: action_name = "secure_input"; break;
        case GHOSTTY_ACTION_KEY_SEQUENCE: action_name = "key_sequence"; break;
        case GHOSTTY_ACTION_KEY_TABLE: action_name = "key_table"; break;
        case GHOSTTY_ACTION_COLOR_CHANGE: action_name = "color_change"; break;
        case GHOSTTY_ACTION_RELOAD_CONFIG: action_name = "reload_config"; break;
        case GHOSTTY_ACTION_CONFIG_CHANGE: action_name = "config_change"; break;
        case GHOSTTY_ACTION_UNDO: action_name = "undo"; break;
        case GHOSTTY_ACTION_REDO: action_name = "redo"; break;
        case GHOSTTY_ACTION_CHECK_FOR_UPDATES: action_name = "check_for_updates"; break;
        case GHOSTTY_ACTION_OPEN_URL: action_name = "open_url"; break;
        case GHOSTTY_ACTION_PROGRESS_REPORT: action_name = "progress_report"; break;
        case GHOSTTY_ACTION_SHOW_ON_SCREEN_KEYBOARD: action_name = "show_on_screen_keyboard"; break;
        case GHOSTTY_ACTION_COMMAND_FINISHED: action_name = "command_finished"; break;
        case GHOSTTY_ACTION_START_SEARCH: action_name = "start_search"; break;
        case GHOSTTY_ACTION_END_SEARCH: action_name = "end_search"; break;
        case GHOSTTY_ACTION_SEARCH_TOTAL: action_name = "search_total"; break;
        case GHOSTTY_ACTION_SEARCH_SELECTED: action_name = "search_selected"; break;
        case GHOSTTY_ACTION_READONLY: action_name = "readonly"; break;
        case GHOSTTY_ACTION_COPY_TITLE_TO_CLIPBOARD: action_name = "copy_title_to_clipboard"; break;
        // Handled actions should never reach default, but guard anyway
        default: action_name = "unknown"; break;
      }

      QueuedAction qa;
      qa.action_type = std::string("unsupported:") + action_name;
      qa.surface_id = surface_id;
      qa.num_value_1 = 0;
      qa.num_value_2 = 0;
      std::lock_guard<std::mutex> lock(g_action_queue_mutex);
      g_action_queue.push_back(std::move(qa));
      return false;
    }
  }
}

/**
 * Read clipboard callback — Ghostty calls this when it needs clipboard data.
 */
void RuntimeReadClipboard(void* userdata, ghostty_clipboard_e clipboard,
                          void* state) {
  (void)userdata;
  (void)clipboard;
  (void)state;
  // Clipboard integration will be added later.
}

/**
 * Confirm read clipboard callback — for clipboard confirmation dialogs.
 */
void RuntimeConfirmReadClipboard(void* userdata, const char* content,
                                 void* state,
                                 ghostty_clipboard_request_e req_type) {
  (void)userdata;
  (void)content;
  (void)state;
  (void)req_type;
  // Not implemented yet.
}

/**
 * Write clipboard callback — Ghostty calls this to write to the clipboard.
 */
void RuntimeWriteClipboard(void* userdata, ghostty_clipboard_e clipboard,
                           const ghostty_clipboard_content_s* content,
                           size_t content_len, bool confirm) {
  (void)userdata;
  (void)clipboard;
  (void)content;
  (void)content_len;
  (void)confirm;
  // Clipboard write will be implemented later.
}

/**
 * Close surface callback — Ghostty calls this when a surface should close.
 */
void RuntimeCloseSurface(void* userdata, bool needs_confirm) {
  (void)userdata;
  (void)needs_confirm;
  // Surface close handling will be wired in Issue 4 (lifecycle).
}

// ---------------------------------------------------------------------------
// N-API functions: Runtime initialization
// ---------------------------------------------------------------------------

/**
 * Initialize the Ghostty library.
 * Must be called once before any other Ghostty API usage.
 */
Napi::Value Init(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_initialized) {
    return Napi::Boolean::New(env, true);
  }

  int result = ghostty_init(0, nullptr);
  if (result != GHOSTTY_SUCCESS) {
    Napi::Error::New(env, "Failed to initialize Ghostty runtime (error code: " +
                     std::to_string(result) + ")")
        .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  g_initialized = true;
  return Napi::Boolean::New(env, true);
}

/**
 * Check whether the Ghostty runtime has been initialized.
 */
Napi::Value IsInitialized(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_initialized);
}

/**
 * Get Ghostty build information.
 * Returns an object with version and buildMode fields.
 */
Napi::Value GetInfo(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!g_initialized) {
    Napi::Error::New(env, "Ghostty is not initialized. Call init() first.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ghostty_info_s build_info = ghostty_info();

  Napi::Object result = Napi::Object::New(env);
  result.Set("version",
             Napi::String::New(env, build_info.version, build_info.version_len));

  const char* mode_str;
  switch (build_info.build_mode) {
    case GHOSTTY_BUILD_MODE_DEBUG:
      mode_str = "debug";
      break;
    case GHOSTTY_BUILD_MODE_RELEASE_SAFE:
      mode_str = "release-safe";
      break;
    case GHOSTTY_BUILD_MODE_RELEASE_FAST:
      mode_str = "release-fast";
      break;
    case GHOSTTY_BUILD_MODE_RELEASE_SMALL:
      mode_str = "release-small";
      break;
    default:
      mode_str = "unknown";
      break;
  }
  result.Set("buildMode", Napi::String::New(env, mode_str));

  return result;
}

/**
 * Validate the Ghostty config subsystem by loading default config files.
 */
Napi::Value ValidateConfig(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!g_initialized) {
    Napi::Error::New(env, "Ghostty is not initialized. Call init() first.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ghostty_config_t config = ghostty_config_new();
  if (config == nullptr) {
    return Napi::Boolean::New(env, false);
  }

  ghostty_config_load_default_files(config);
  ghostty_config_finalize(config);

  uint32_t diag_count = ghostty_config_diagnostics_count(config);

  Napi::Object result = Napi::Object::New(env);
  result.Set("success", Napi::Boolean::New(env, true));
  result.Set("diagnosticsCount", Napi::Number::New(env, diag_count));

  if (diag_count > 0) {
    Napi::Array diagnostics = Napi::Array::New(env, diag_count);
    for (uint32_t i = 0; i < diag_count; i++) {
      ghostty_diagnostic_s diag = ghostty_config_get_diagnostic(config, i);
      if (diag.message != nullptr) {
        diagnostics.Set(i, Napi::String::New(env, diag.message));
      }
    }
    result.Set("diagnostics", diagnostics);
  }

  ghostty_config_free(config);
  return result;
}

// ---------------------------------------------------------------------------
// N-API functions: App lifecycle
// ---------------------------------------------------------------------------

/**
 * Create the Ghostty app runtime.
 *
 * Creates a ghostty_app_t with runtime callbacks wired up.
 * Only one app instance is supported. Must be called after init()
 * and before any surfaces can be created.
 *
 * Returns true on success.
 */
Napi::Value CreateApp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (!g_initialized) {
    Napi::Error::New(env, "Ghostty is not initialized. Call init() first.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (g_app != nullptr) {
    return Napi::Boolean::New(env, true);
  }

  // Create and finalize config
  ghostty_config_t config = ghostty_config_new();
  if (config == nullptr) {
    Napi::Error::New(env, "Failed to create Ghostty config")
        .ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  ghostty_config_load_default_files(config);
  ghostty_config_finalize(config);

  // Set up runtime config with callbacks
  ghostty_runtime_config_s runtime_config = {};
  runtime_config.userdata = nullptr;
  runtime_config.supports_selection_clipboard = false;
  runtime_config.wakeup_cb = RuntimeWakeup;
  runtime_config.action_cb = RuntimeAction;
  runtime_config.read_clipboard_cb = RuntimeReadClipboard;
  runtime_config.confirm_read_clipboard_cb = RuntimeConfirmReadClipboard;
  runtime_config.write_clipboard_cb = RuntimeWriteClipboard;
  runtime_config.close_surface_cb = RuntimeCloseSurface;

  ghostty_app_t app = ghostty_app_new(&runtime_config, config);
  if (app == nullptr) {
    uint32_t diag_count = ghostty_config_diagnostics_count(config);
    std::string error_msg = "Failed to create Ghostty app";
    if (diag_count > 0) {
      ghostty_diagnostic_s diag = ghostty_config_get_diagnostic(config, 0);
      if (diag.message != nullptr) {
        error_msg += ": " + std::string(diag.message);
      }
    }
    ghostty_config_free(config);
    Napi::Error::New(env, error_msg).ThrowAsJavaScriptException();
    return Napi::Boolean::New(env, false);
  }

  g_app = app;
  g_app_config = config;
  return Napi::Boolean::New(env, true);
}

/**
 * Check whether the Ghostty app runtime has been created.
 */
Napi::Value IsAppCreated(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_app != nullptr);
}

/**
 * Destroy the Ghostty app runtime and all surfaces.
 */
Napi::Value DestroyApp(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_app == nullptr) {
    return Napi::Boolean::New(env, true);
  }

  // Destroy remaining surfaces first
  {
    std::lock_guard<std::mutex> lock(g_surfaces_mutex);
    for (auto& [id, tracked] : g_surfaces) {
      @autoreleasepool {
        if (tracked.surface != nullptr) {
          ghostty_surface_free(tracked.surface);
        }
        if (tracked.window != nil) {
          [tracked.window orderOut:nil];
          [tracked.window close];
        }
      }
    }
    g_surfaces.clear();
    g_surface_ptr_to_id.clear();
  }

  ghostty_app_free(g_app);
  g_app = nullptr;

  if (g_app_config != nullptr) {
    ghostty_config_free(g_app_config);
    g_app_config = nullptr;
  }

  return Napi::Boolean::New(env, true);
}

/**
 * Tick the Ghostty app runtime.
 * Must be called periodically to process Ghostty events.
 */
Napi::Value AppTick(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_app == nullptr) {
    Napi::Error::New(env, "Ghostty app is not created. Call createApp() first.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ghostty_app_tick(g_app);
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// N-API functions: Surface lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a new Ghostty terminal surface.
 *
 * Creates an offscreen NSWindow with an NSView that Ghostty renders into.
 * The surface is invisible — its content is shared to Electron via IOSurface.
 *
 * Options (optional object):
 *   - width: initial width in pixels (default 800)
 *   - height: initial height in pixels (default 600)
 *   - workingDirectory: initial working directory for the shell
 *   - command: command to run instead of the default shell
 *
 * Returns { id: number }
 */
Napi::Value CreateSurface(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_app == nullptr) {
    Napi::Error::New(env, "Ghostty app is not created. Call createApp() first.")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Parse options
  uint32_t width = 800;
  uint32_t height = 600;
  std::string working_directory;
  std::string command;

  if (info.Length() > 0 && info[0].IsObject()) {
    Napi::Object opts = info[0].As<Napi::Object>();

    if (opts.Has("width") && opts.Get("width").IsNumber()) {
      width = opts.Get("width").As<Napi::Number>().Uint32Value();
    }
    if (opts.Has("height") && opts.Get("height").IsNumber()) {
      height = opts.Get("height").As<Napi::Number>().Uint32Value();
    }
    if (opts.Has("workingDirectory") && opts.Get("workingDirectory").IsString()) {
      working_directory = opts.Get("workingDirectory").As<Napi::String>().Utf8Value();
    }
    if (opts.Has("command") && opts.Get("command").IsString()) {
      command = opts.Get("command").As<Napi::String>().Utf8Value();
    }
  }

  @autoreleasepool {
    NSRect frame = NSMakeRect(0, 0, (CGFloat)width, (CGFloat)height);

    // Create an offscreen NSWindow to host the Ghostty surface.
    // Ghostty requires a real NSView backed by a CAMetalLayer for rendering.
    NSWindow* window = [[NSWindow alloc]
        initWithContentRect:frame
                  styleMask:NSWindowStyleMaskBorderless
                    backing:NSBackingStoreBuffered
                      defer:NO];
    [window setReleasedWhenClosed:NO];

    // Create a layer-backed view for Metal rendering
    NSView* view = [[NSView alloc] initWithFrame:frame];
    [view setWantsLayer:YES];
    [window setContentView:view];

    // Move offscreen so it never appears on the user's display
    [window setFrameOrigin:NSMakePoint(-10000, -10000)];
    [window orderBack:nil];

    // Set up surface config
    ghostty_surface_config_s surface_config = ghostty_surface_config_new();
    surface_config.platform_tag = GHOSTTY_PLATFORM_MACOS;
    surface_config.platform.macos.nsview = (__bridge void*)view;
    surface_config.scale_factor = [window backingScaleFactor];
    surface_config.context = GHOSTTY_SURFACE_CONTEXT_WINDOW;

    if (!working_directory.empty()) {
      surface_config.working_directory = working_directory.c_str();
    }
    if (!command.empty()) {
      surface_config.command = command.c_str();
    }

    ghostty_surface_t surface = ghostty_surface_new(g_app, &surface_config);
    if (surface == nullptr) {
      [window orderOut:nil];
      [window close];
      Napi::Error::New(env, "Failed to create Ghostty surface")
          .ThrowAsJavaScriptException();
      return env.Undefined();
    }

    // Set initial size
    ghostty_surface_set_size(surface, width, height);

    uint32_t surface_id = g_next_surface_id++;

    TrackedSurface tracked = {
      .id = surface_id,
      .surface = surface,
      .window = window,
      .view = view,
    };

    {
      std::lock_guard<std::mutex> lock(g_surfaces_mutex);
      g_surfaces[surface_id] = tracked;
      g_surface_ptr_to_id[reinterpret_cast<uintptr_t>(surface)] = surface_id;
    }

    Napi::Object result = Napi::Object::New(env);
    result.Set("id", Napi::Number::New(env, surface_id));
    return result;
  }
}

/**
 * Destroy a Ghostty terminal surface by its ID.
 */
Napi::Value DestroySurface(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected surface ID (number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  @autoreleasepool {
    TrackedSurface& tracked = it->second;
    // Remove reverse mapping before freeing the surface
    if (tracked.surface != nullptr) {
      g_surface_ptr_to_id.erase(reinterpret_cast<uintptr_t>(tracked.surface));
      ghostty_surface_free(tracked.surface);
    }
    if (tracked.window != nil) {
      [tracked.window orderOut:nil];
      [tracked.window close];
    }
  }

  g_surfaces.erase(it);
  return Napi::Boolean::New(env, true);
}

/**
 * Get a list of all active surface IDs.
 */
Napi::Value ListSurfaces(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  Napi::Array result = Napi::Array::New(env, g_surfaces.size());
  uint32_t idx = 0;
  for (const auto& [id, _] : g_surfaces) {
    result.Set(idx++, Napi::Number::New(env, id));
  }
  return result;
}

// ---------------------------------------------------------------------------
// N-API functions: Surface control
// ---------------------------------------------------------------------------

/**
 * Set the size of a Ghostty surface in pixels.
 * Args: surfaceId, width, height
 */
Napi::Value SetSurfaceSize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 3 || !info[0].IsNumber() || !info[1].IsNumber() ||
      !info[2].IsNumber()) {
    Napi::TypeError::New(env, "Expected (surfaceId, width, height)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();
  uint32_t width = info[1].As<Napi::Number>().Uint32Value();
  uint32_t height = info[2].As<Napi::Number>().Uint32Value();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  @autoreleasepool {
    TrackedSurface& tracked = it->second;
    NSRect frame = NSMakeRect(-10000, -10000, (CGFloat)width, (CGFloat)height);
    [tracked.window setFrame:frame display:YES];
    [tracked.view setFrame:NSMakeRect(0, 0, (CGFloat)width, (CGFloat)height)];
    ghostty_surface_set_size(tracked.surface, width, height);
  }

  return Napi::Boolean::New(env, true);
}

/**
 * Set focus state of a Ghostty surface.
 * Args: surfaceId, focused
 */
Napi::Value SetSurfaceFocus(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
    Napi::TypeError::New(env, "Expected (surfaceId, focused)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();
  bool focused = info[1].As<Napi::Boolean>().Value();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ghostty_surface_set_focus(it->second.surface, focused);
  return Napi::Boolean::New(env, true);
}

/**
 * Get the current size of a Ghostty surface.
 * Returns { columns, rows, widthPx, heightPx, cellWidthPx, cellHeightPx }
 */
Napi::Value GetSurfaceSize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected surface ID (number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ghostty_surface_size_s size = ghostty_surface_size(it->second.surface);

  Napi::Object result = Napi::Object::New(env);
  result.Set("columns", Napi::Number::New(env, size.columns));
  result.Set("rows", Napi::Number::New(env, size.rows));
  result.Set("widthPx", Napi::Number::New(env, size.width_px));
  result.Set("heightPx", Napi::Number::New(env, size.height_px));
  result.Set("cellWidthPx", Napi::Number::New(env, size.cell_width_px));
  result.Set("cellHeightPx", Napi::Number::New(env, size.cell_height_px));
  return result;
}

// ---------------------------------------------------------------------------
// N-API functions: IOSurface extraction
// ---------------------------------------------------------------------------

/**
 * Get the IOSurface ID for a Ghostty surface's Metal layer.
 *
 * Ghostty renders into a CAMetalLayer backed by IOSurface. This function
 * extracts the IOSurfaceID which can be used by another process (Electron)
 * to import the surface for zero-copy rendering via WebGPU.
 *
 * Returns { ioSurfaceId: number | null, hasLayer: boolean }
 *
 * Note: The IOSurface may not be available immediately after surface creation.
 * Ghostty needs to render at least one frame to produce a drawable.
 */
Napi::Value GetSurfaceIOSurfaceId(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected surface ID (number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  Napi::Object result = Napi::Object::New(env);

  @autoreleasepool {
    TrackedSurface& tracked = it->second;
    CALayer* layer = [tracked.view layer];

    if (layer != nil && [layer isKindOfClass:[CAMetalLayer class]]) {
      result.Set("hasLayer", Napi::Boolean::New(env, true));

      // Try to get IOSurface from the layer's contents.
      // CALayer.contents can be a CGImageRef or an IOSurfaceRef.
      id contents = [layer contents];
      if (contents != nil) {
        CFTypeRef contentsRef = (__bridge CFTypeRef)contents;
        CFTypeID ioSurfaceTypeID = IOSurfaceGetTypeID();
        if (CFGetTypeID(contentsRef) == ioSurfaceTypeID) {
          IOSurfaceRef ioSurface = (IOSurfaceRef)contentsRef;
          IOSurfaceID surfaceIOId = IOSurfaceGetID(ioSurface);
          result.Set("ioSurfaceId", Napi::Number::New(env, surfaceIOId));
        } else {
          result.Set("ioSurfaceId", env.Null());
        }
      } else {
        result.Set("ioSurfaceId", env.Null());
      }
    } else {
      result.Set("hasLayer", Napi::Boolean::New(env, false));
      result.Set("ioSurfaceId", env.Null());
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// N-API functions: Keyboard and text input
// ---------------------------------------------------------------------------

/**
 * Send a key event to a Ghostty surface.
 *
 * Args: surfaceId, action (0=release, 1=press, 2=repeat), mods (bitmask),
 *       keycode (ghostty_input_key_e value), text (string|null),
 *       unshiftedCodepoint (number), composing (boolean)
 *
 * Returns true if the key was consumed by Ghostty.
 */
Napi::Value SendSurfaceKey(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 7) {
    Napi::TypeError::New(env,
        "Expected (surfaceId, action, mods, keycode, text, unshiftedCodepoint, composing)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  if (!info[0].IsNumber() || !info[1].IsNumber() || !info[2].IsNumber() ||
      !info[3].IsNumber() || !info[5].IsNumber() || !info[6].IsBoolean()) {
    Napi::TypeError::New(env, "Invalid argument types for sendSurfaceKey")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();
  int action = info[1].As<Napi::Number>().Int32Value();
  int mods = info[2].As<Napi::Number>().Int32Value();
  int keycode = info[3].As<Napi::Number>().Int32Value();
  // info[4] is text (string or null)
  uint32_t unshifted_codepoint = info[5].As<Napi::Number>().Uint32Value();
  bool composing = info[6].As<Napi::Boolean>().Value();

  std::string text_str;
  const char* text_ptr = nullptr;
  if (info[4].IsString()) {
    text_str = info[4].As<Napi::String>().Utf8Value();
    if (!text_str.empty()) {
      text_ptr = text_str.c_str();
    }
  }

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ghostty_input_key_s key_event = {};
  key_event.action = static_cast<ghostty_input_action_e>(action);
  key_event.mods = static_cast<ghostty_input_mods_e>(mods);
  key_event.consumed_mods = GHOSTTY_MODS_NONE;
  key_event.keycode = static_cast<uint32_t>(keycode);
  key_event.text = text_ptr;
  key_event.unshifted_codepoint = unshifted_codepoint;
  key_event.composing = composing;

  bool consumed = ghostty_surface_key(it->second.surface, key_event);
  return Napi::Boolean::New(env, consumed);
}

/**
 * Send composed text input to a Ghostty surface.
 * Args: surfaceId, text (UTF-8 string)
 */
Napi::Value SendSurfaceText(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsString()) {
    Napi::TypeError::New(env, "Expected (surfaceId, text)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();
  std::string text = info[1].As<Napi::String>().Utf8Value();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ghostty_surface_text(it->second.surface, text.c_str(), text.size());
  return Napi::Boolean::New(env, true);
}

// ---------------------------------------------------------------------------
// N-API functions: Mouse input
// ---------------------------------------------------------------------------

/**
 * Check whether the Ghostty surface has captured the mouse.
 * When captured, mouse events should be forwarded to the terminal
 * rather than handled by the surrounding UI (e.g., for selection).
 *
 * Args: surfaceId
 * Returns boolean.
 */
Napi::Value SurfaceMouseCaptured(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected surface ID (number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  bool captured = ghostty_surface_mouse_captured(it->second.surface);
  return Napi::Boolean::New(env, captured);
}

/**
 * Send a mouse button event to a Ghostty surface.
 *
 * Args: surfaceId, state (0=release, 1=press), button (ghostty_input_mouse_button_e),
 *       mods (ghostty_input_mods_e bitmask)
 *
 * Returns true if the button event was consumed by Ghostty.
 */
Napi::Value SendSurfaceMouseButton(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() ||
      !info[2].IsNumber() || !info[3].IsNumber()) {
    Napi::TypeError::New(env, "Expected (surfaceId, state, button, mods)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();
  int state = info[1].As<Napi::Number>().Int32Value();
  int button = info[2].As<Napi::Number>().Int32Value();
  int mods = info[3].As<Napi::Number>().Int32Value();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  bool consumed = ghostty_surface_mouse_button(
    it->second.surface,
    static_cast<ghostty_input_mouse_state_e>(state),
    static_cast<ghostty_input_mouse_button_e>(button),
    static_cast<ghostty_input_mods_e>(mods));
  return Napi::Boolean::New(env, consumed);
}

/**
 * Send a mouse position update to a Ghostty surface.
 *
 * Args: surfaceId, x (double, pixels), y (double, pixels),
 *       mods (ghostty_input_mods_e bitmask)
 */
Napi::Value SendSurfaceMousePos(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() ||
      !info[2].IsNumber() || !info[3].IsNumber()) {
    Napi::TypeError::New(env, "Expected (surfaceId, x, y, mods)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();
  double x = info[1].As<Napi::Number>().DoubleValue();
  double y = info[2].As<Napi::Number>().DoubleValue();
  int mods = info[3].As<Napi::Number>().Int32Value();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ghostty_surface_mouse_pos(
    it->second.surface, x, y,
    static_cast<ghostty_input_mods_e>(mods));
  return env.Undefined();
}

/**
 * Send a mouse scroll event to a Ghostty surface.
 *
 * Args: surfaceId, dx (double), dy (double), scrollMods (int, packed scroll mods)
 *
 * scrollMods is a packed int (ghostty_input_scroll_mods_t) that encodes
 * precision scrolling state and momentum phase. For standard wheel events
 * from the browser, pass 0.
 */
Napi::Value SendSurfaceMouseScroll(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 4 || !info[0].IsNumber() || !info[1].IsNumber() ||
      !info[2].IsNumber() || !info[3].IsNumber()) {
    Napi::TypeError::New(env, "Expected (surfaceId, dx, dy, scrollMods)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();
  double dx = info[1].As<Napi::Number>().DoubleValue();
  double dy = info[2].As<Napi::Number>().DoubleValue();
  int scroll_mods = info[3].As<Napi::Number>().Int32Value();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  ghostty_surface_mouse_scroll(
    it->second.surface, dx, dy,
    static_cast<ghostty_input_scroll_mods_t>(scroll_mods));
  return env.Undefined();
}

// ---------------------------------------------------------------------------
// N-API functions: IOSurface handle extraction (for Electron sharedTexture)
// ---------------------------------------------------------------------------

/**
 * Get the raw IOSurfaceRef as a Node.js Buffer for a Ghostty surface.
 *
 * This extracts the IOSurfaceRef pointer from the CAMetalLayer's contents
 * and returns it as a Buffer that can be passed directly to Electron's
 * sharedTexture.importSharedTexture({ handle: { ioSurface: buffer } }).
 *
 * The IOSurfaceRef is process-local on macOS but can be shared via
 * Electron's sharedTexture API which handles cross-process GPU texture
 * sharing internally.
 *
 * Returns { ioSurfaceHandle: Buffer | null, width: number, height: number }
 * or null if the IOSurface is not yet available.
 */
Napi::Value GetSurfaceIOSurfaceHandle(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected surface ID (number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  @autoreleasepool {
    TrackedSurface& tracked = it->second;
    CALayer* layer = [tracked.view layer];

    if (layer == nil || ![layer isKindOfClass:[CAMetalLayer class]]) {
      return env.Null();
    }

    id contents = [layer contents];
    if (contents == nil) {
      return env.Null();
    }

    CFTypeRef contentsRef = (__bridge CFTypeRef)contents;
    if (CFGetTypeID(contentsRef) != IOSurfaceGetTypeID()) {
      return env.Null();
    }

    IOSurfaceRef ioSurface = (IOSurfaceRef)contentsRef;
    size_t width = IOSurfaceGetWidth(ioSurface);
    size_t height = IOSurfaceGetHeight(ioSurface);

    if (width == 0 || height == 0) {
      return env.Null();
    }

    // Create a Buffer containing the raw IOSurfaceRef pointer.
    // Electron's sharedTexture API on macOS expects an IOSurfaceRef
    // wrapped in a Buffer for the handle.ioSurface field.
    // We also CFRetain the surface to keep it alive while the main
    // process imports it.
    CFRetain(ioSurface);

    // The Buffer holds the IOSurfaceRef as a raw pointer (sizeof(void*) bytes).
    // When the Buffer is garbage collected, we release the IOSurface.
    auto buffer = Napi::Buffer<uint8_t>::New(
      env,
      reinterpret_cast<uint8_t*>(ioSurface),
      sizeof(IOSurfaceRef),
      [](Napi::Env /*env*/, uint8_t* data) {
        IOSurfaceRef surface = reinterpret_cast<IOSurfaceRef>(data);
        CFRelease(surface);
      }
    );

    Napi::Object result = Napi::Object::New(env);
    result.Set("ioSurfaceHandle", buffer);
    result.Set("width", Napi::Number::New(env, static_cast<double>(width)));
    result.Set("height", Napi::Number::New(env, static_cast<double>(height)));
    return result;
  }
}

// ---------------------------------------------------------------------------
// N-API functions: Pixel readback
// ---------------------------------------------------------------------------

/**
 * Read pixel data from a Ghostty surface's IOSurface.
 *
 * Locks the IOSurface, copies the BGRA pixel buffer, and returns it as a
 * Node.js Buffer. This is the "tracer bullet" rendering path that proves
 * Ghostty output can flow to the Electron renderer. The zero-copy path
 * (Issue 3) will replace this with shared-texture display via WebGPU.
 *
 * Returns { width: number, height: number, data: Buffer } or null if the
 * IOSurface is not yet available (Ghostty hasn't rendered a frame).
 *
 * The buffer contains BGRA pixel data (4 bytes per pixel), row-major,
 * with possible row padding (bytesPerRow may exceed width * 4).
 */
Napi::Value GetSurfacePixels(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "Expected surface ID (number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  uint32_t surface_id = info[0].As<Napi::Number>().Uint32Value();

  std::lock_guard<std::mutex> lock(g_surfaces_mutex);
  auto it = g_surfaces.find(surface_id);
  if (it == g_surfaces.end()) {
    Napi::Error::New(env, "Surface not found: " + std::to_string(surface_id))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  @autoreleasepool {
    TrackedSurface& tracked = it->second;
    CALayer* layer = [tracked.view layer];

    if (layer == nil || ![layer isKindOfClass:[CAMetalLayer class]]) {
      return env.Null();
    }

    id contents = [layer contents];
    if (contents == nil) {
      return env.Null();
    }

    CFTypeRef contentsRef = (__bridge CFTypeRef)contents;
    if (CFGetTypeID(contentsRef) != IOSurfaceGetTypeID()) {
      return env.Null();
    }

    IOSurfaceRef ioSurface = (IOSurfaceRef)contentsRef;

    size_t width = IOSurfaceGetWidth(ioSurface);
    size_t height = IOSurfaceGetHeight(ioSurface);
    size_t bytesPerRow = IOSurfaceGetBytesPerRow(ioSurface);

    if (width == 0 || height == 0) {
      return env.Null();
    }

    // Lock the IOSurface for CPU read access
    kern_return_t lockResult = IOSurfaceLock(ioSurface, kIOSurfaceLockReadOnly, nullptr);
    if (lockResult != kIOReturnSuccess) {
      return env.Null();
    }

    void* baseAddress = IOSurfaceGetBaseAddress(ioSurface);
    if (baseAddress == nullptr) {
      IOSurfaceUnlock(ioSurface, kIOSurfaceLockReadOnly, nullptr);
      return env.Null();
    }

    // Copy pixel data into a tightly-packed buffer (no row padding).
    // Source may have bytesPerRow > width * 4 due to GPU alignment.
    size_t tightBytesPerRow = width * 4;
    size_t totalBytes = tightBytesPerRow * height;

    Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::New(env, totalBytes);
    uint8_t* dst = buffer.Data();
    uint8_t* src = static_cast<uint8_t*>(baseAddress);

    if (bytesPerRow == tightBytesPerRow) {
      // No padding — single memcpy
      memcpy(dst, src, totalBytes);
    } else {
      // Row-by-row copy to strip GPU row padding
      for (size_t row = 0; row < height; row++) {
        memcpy(dst + row * tightBytesPerRow, src + row * bytesPerRow, tightBytesPerRow);
      }
    }

    IOSurfaceUnlock(ioSurface, kIOSurfaceLockReadOnly, nullptr);

    Napi::Object result = Napi::Object::New(env);
    result.Set("width", Napi::Number::New(env, static_cast<double>(width)));
    result.Set("height", Napi::Number::New(env, static_cast<double>(height)));
    result.Set("data", buffer);
    return result;
  }
}

// ---------------------------------------------------------------------------
// N-API functions: Action queue
// ---------------------------------------------------------------------------

/**
 * Drain all queued Ghostty actions since the last drain.
 *
 * Returns an array of action objects, each containing:
 *   - action: string (the action type: "set_title", "pwd", "ring_bell", etc.)
 *   - surfaceId: number (0 if the action targets the app, not a surface)
 *   - value: string (string payload, e.g., title or pwd; empty if N/A)
 *   - num1: number (first numeric payload, e.g., exit code or cell width)
 *   - num2: number (second numeric payload, e.g., cell height)
 *
 * This is the polling-based mechanism for the host process to receive
 * Ghostty action callbacks. Called once per tick in the host process.
 */
Napi::Value DrainActions(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  // Move the queue out under the lock, then process without holding it
  std::vector<QueuedAction> actions;
  {
    std::lock_guard<std::mutex> lock(g_action_queue_mutex);
    actions.swap(g_action_queue);
  }

  Napi::Array result = Napi::Array::New(env, actions.size());
  for (uint32_t i = 0; i < actions.size(); i++) {
    const auto& qa = actions[i];
    Napi::Object obj = Napi::Object::New(env);
    obj.Set("action", Napi::String::New(env, qa.action_type));
    obj.Set("surfaceId", Napi::Number::New(env, qa.surface_id));
    obj.Set("value", Napi::String::New(env, qa.str_value));
    obj.Set("num1", Napi::Number::New(env, qa.num_value_1));
    obj.Set("num2", Napi::Number::New(env, qa.num_value_2));
    result.Set(i, obj);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Module initialization
// ---------------------------------------------------------------------------

Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  // Runtime initialization
  exports.Set("init", Napi::Function::New(env, Init));
  exports.Set("isInitialized", Napi::Function::New(env, IsInitialized));
  exports.Set("getInfo", Napi::Function::New(env, GetInfo));
  exports.Set("validateConfig", Napi::Function::New(env, ValidateConfig));

  // App lifecycle
  exports.Set("createApp", Napi::Function::New(env, CreateApp));
  exports.Set("isAppCreated", Napi::Function::New(env, IsAppCreated));
  exports.Set("destroyApp", Napi::Function::New(env, DestroyApp));
  exports.Set("appTick", Napi::Function::New(env, AppTick));

  // Surface lifecycle
  exports.Set("createSurface", Napi::Function::New(env, CreateSurface));
  exports.Set("destroySurface", Napi::Function::New(env, DestroySurface));
  exports.Set("listSurfaces", Napi::Function::New(env, ListSurfaces));

  // Surface control
  exports.Set("setSurfaceSize", Napi::Function::New(env, SetSurfaceSize));
  exports.Set("setSurfaceFocus", Napi::Function::New(env, SetSurfaceFocus));
  exports.Set("getSurfaceSize", Napi::Function::New(env, GetSurfaceSize));

  // Keyboard and text input
  exports.Set("sendSurfaceKey", Napi::Function::New(env, SendSurfaceKey));
  exports.Set("sendSurfaceText", Napi::Function::New(env, SendSurfaceText));

  // Mouse input
  exports.Set("surfaceMouseCaptured",
              Napi::Function::New(env, SurfaceMouseCaptured));
  exports.Set("sendSurfaceMouseButton",
              Napi::Function::New(env, SendSurfaceMouseButton));
  exports.Set("sendSurfaceMousePos",
              Napi::Function::New(env, SendSurfaceMousePos));
  exports.Set("sendSurfaceMouseScroll",
              Napi::Function::New(env, SendSurfaceMouseScroll));

  // IOSurface extraction
  exports.Set("getSurfaceIOSurfaceId",
              Napi::Function::New(env, GetSurfaceIOSurfaceId));

  // IOSurface handle for Electron sharedTexture
  exports.Set("getSurfaceIOSurfaceHandle",
              Napi::Function::New(env, GetSurfaceIOSurfaceHandle));

  // Pixel readback
  exports.Set("getSurfacePixels",
              Napi::Function::New(env, GetSurfacePixels));

  // Action queue
  exports.Set("drainActions",
              Napi::Function::New(env, DrainActions));

  return exports;
}

}  // namespace

NODE_API_MODULE(ghostty_addon, InitModule)
