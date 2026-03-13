/**
 * @laborer/ghostty native addon
 *
 * Minimal N-API addon that wraps the Ghostty C API.
 * This module provides the native bridge between Node.js and
 * the Ghostty terminal engine via GhosttyKit.
 */

#include <napi.h>
#include <ghostty.h>
#include <string>

namespace {

bool g_initialized = false;

/**
 * Initialize the Ghostty library.
 * Must be called once before any other Ghostty API usage.
 * Returns true on success, false on failure.
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
 * Ghostty must be initialized first.
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
 * Create a Ghostty config object and load default config files.
 * Returns true if config was created and loaded successfully.
 * This is a validation function to verify the config subsystem works.
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

  // Collect diagnostic messages if any
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

/**
 * Module initialization — register all exported functions.
 */
Napi::Object InitModule(Napi::Env env, Napi::Object exports) {
  exports.Set("init", Napi::Function::New(env, Init));
  exports.Set("isInitialized", Napi::Function::New(env, IsInitialized));
  exports.Set("getInfo", Napi::Function::New(env, GetInfo));
  exports.Set("validateConfig", Napi::Function::New(env, ValidateConfig));
  return exports;
}

}  // namespace

NODE_API_MODULE(ghostty_addon, InitModule)
