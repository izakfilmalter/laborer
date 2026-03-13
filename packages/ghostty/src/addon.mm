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
 * Returns true if the action was handled, false otherwise.
 */
bool RuntimeAction(ghostty_app_t app, ghostty_target_s target,
                   ghostty_action_s action) {
  (void)app;
  (void)target;

  // For now, handle RENDER action (needed for surface display) and
  // acknowledge other core actions. Full action mapping is Issue 7.
  switch (action.tag) {
    case GHOSTTY_ACTION_RENDER:
      // Render requests are handled by the Metal layer automatically.
      return true;

    case GHOSTTY_ACTION_SET_TITLE:
    case GHOSTTY_ACTION_PWD:
    case GHOSTTY_ACTION_RING_BELL:
    case GHOSTTY_ACTION_SHOW_CHILD_EXITED:
    case GHOSTTY_ACTION_CLOSE_WINDOW:
    case GHOSTTY_ACTION_CELL_SIZE:
    case GHOSTTY_ACTION_RENDERER_HEALTH:
      // Recognized but not yet wired to JS callbacks.
      // Will be implemented in Issue 7 (action mapping).
      return true;

    default:
      // Unsupported action — return false so Ghostty knows we didn't handle it.
      return false;
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
    if (tracked.surface != nullptr) {
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

  // IOSurface extraction
  exports.Set("getSurfaceIOSurfaceId",
              Napi::Function::New(env, GetSurfaceIOSurfaceId));

  // Pixel readback
  exports.Set("getSurfacePixels",
              Napi::Function::New(env, GetSurfacePixels));

  return exports;
}

}  // namespace

NODE_API_MODULE(ghostty_addon, InitModule)
