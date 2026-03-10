use process_wrap::tokio::CommandWrap;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Emitter;
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{mpsc, Mutex},
};

/// Timeout for probing the user's login shell environment.
const SHELL_ENV_TIMEOUT: Duration = Duration::from_secs(5);

/// Interval between health check HTTP requests.
const HEALTH_CHECK_INTERVAL: Duration = Duration::from_millis(100);

/// Maximum time to wait for a sidecar to become healthy after spawning.
const HEALTH_CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// Default environment variable values for Tauri production sidecars.
/// These use a different port range (4100+) than dev mode (2100+) so that
/// the built Tauri app and `turbo dev` can run simultaneously.
const DEFAULT_PORT: &str = "4100";
const DEFAULT_TERMINAL_PORT: &str = "4102";
const DEFAULT_PORT_RANGE_START: &str = "4200";
const DEFAULT_PORT_RANGE_END: &str = "4999";
const DEFAULT_DATA_DIR: &str = "./data";

// ---------------------------------------------------------------------------
// Shell environment probing (macOS)
// ---------------------------------------------------------------------------

/// Parse NUL-delimited `env -0` output into key-value pairs.
fn parse_shell_env(stdout: &[u8]) -> HashMap<String, String> {
    String::from_utf8_lossy(stdout)
        .split('\0')
        .filter_map(|entry| {
            if entry.is_empty() {
                return None;
            }
            let (key, value) = entry.split_once('=')?;
            if key.is_empty() {
                return None;
            }
            Some((key.to_string(), value.to_string()))
        })
        .collect()
}

/// Run a shell command with a timeout, returning its output or `None` on timeout.
fn command_output_with_timeout(
    mut cmd: std::process::Command,
    timeout: Duration,
) -> std::io::Result<Option<std::process::Output>> {
    let mut child = cmd.spawn()?;
    let start = Instant::now();

    loop {
        if child.try_wait()?.is_some() {
            return child.wait_with_output().map(Some);
        }
        if start.elapsed() >= timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

enum ShellEnvProbe {
    Loaded(HashMap<String, String>),
    Timeout,
    Unavailable,
}

/// Probe the shell environment by running `<shell> <mode> -c "env -0"`.
fn probe_shell_env(shell: &str, mode: &str) -> ShellEnvProbe {
    let mut cmd = std::process::Command::new(shell);
    cmd.args([mode, "-c", "env -0"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());

    let output = match command_output_with_timeout(cmd, SHELL_ENV_TIMEOUT) {
        Ok(Some(output)) => output,
        Ok(None) => {
            log::debug!("Shell env probe timed out: shell={shell} mode={mode}");
            return ShellEnvProbe::Timeout;
        }
        Err(error) => {
            log::debug!("Shell env probe failed: shell={shell} mode={mode} error={error}");
            return ShellEnvProbe::Unavailable;
        }
    };

    if !output.status.success() {
        log::debug!("Shell env probe exited with non-zero status: shell={shell} mode={mode}");
        return ShellEnvProbe::Unavailable;
    }

    let env = parse_shell_env(&output.stdout);
    if env.is_empty() {
        log::debug!("Shell env probe returned empty env: shell={shell} mode={mode}");
        return ShellEnvProbe::Unavailable;
    }

    ShellEnvProbe::Loaded(env)
}

/// Detect whether the shell is nushell (unsupported for env probing).
fn is_nushell(shell: &str) -> bool {
    let name = std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase();
    name == "nu" || name == "nu.exe"
}

/// Load the user's login shell environment. Tries interactive-login first,
/// then login-only, returning `None` if both fail or time out.
pub fn load_shell_env() -> Option<HashMap<String, String>> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());

    if is_nushell(&shell) {
        log::debug!("Skipping shell env probe for nushell: {shell}");
        return None;
    }

    match probe_shell_env(&shell, "-il") {
        ShellEnvProbe::Loaded(env) => {
            log::info!(
                "Loaded shell environment with -il: shell={shell} count={}",
                env.len()
            );
            return Some(env);
        }
        ShellEnvProbe::Timeout => {
            log::warn!("Interactive shell env probe timed out: shell={shell}");
            return None;
        }
        ShellEnvProbe::Unavailable => {}
    }

    if let ShellEnvProbe::Loaded(env) = probe_shell_env(&shell, "-l") {
        log::info!(
            "Loaded shell environment with -l: shell={shell} count={}",
            env.len()
        );
        return Some(env);
    }

    log::warn!("Shell env probe failed, falling back to app environment: shell={shell}");
    None
}

/// Merge the probed shell environment with sidecar-specific overrides.
/// Explicit overrides take precedence over the shell environment.
fn merge_env(
    shell_env: &Option<HashMap<String, String>>,
    overrides: Vec<(String, String)>,
) -> Vec<(String, String)> {
    let mut merged = shell_env.clone().unwrap_or_default();
    for (key, value) in overrides {
        merged.insert(key, value);
    }
    merged.into_iter().collect()
}

// ---------------------------------------------------------------------------
// Sidecar state and events
// ---------------------------------------------------------------------------

/// Identifies a sidecar service.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SidecarName {
    Server,
    Terminal,
}

impl std::fmt::Display for SidecarName {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SidecarName::Server => write!(f, "server"),
            SidecarName::Terminal => write!(f, "terminal"),
        }
    }
}

/// The current state of a sidecar process.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case", tag = "status")]
pub enum SidecarState {
    /// The sidecar has been spawned but is not yet healthy.
    Starting,
    /// The sidecar has passed its health check and is operational.
    Healthy,
    /// The sidecar process terminated unexpectedly.
    Crashed {
        error: String,
    },
    /// The sidecar was intentionally stopped.
    Stopped,
}

/// Payload emitted when a sidecar process terminates.
#[derive(Debug, Clone, Copy)]
pub struct TerminatedPayload {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

/// Payload for the `sidecar:healthy` Tauri event.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarHealthyPayload {
    pub name: SidecarName,
}

/// Payload for the `sidecar:error` Tauri event.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SidecarErrorPayload {
    pub name: SidecarName,
    pub error: String,
    pub last_stderr: String,
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

/// Perform a single HTTP health check against a sidecar's root endpoint.
async fn check_health(url: &str) -> bool {
    let builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy();

    let Ok(client) = builder.build() else {
        return false;
    };

    client
        .get(url)
        .send()
        .await
        .map(|r| r.status().is_success())
        .unwrap_or(false)
}

/// Return the health check URL for a sidecar.
fn health_url(name: SidecarName) -> String {
    match name {
        SidecarName::Server => format!("http://127.0.0.1:{DEFAULT_PORT}"),
        SidecarName::Terminal => format!("http://127.0.0.1:{DEFAULT_TERMINAL_PORT}"),
    }
}

// ---------------------------------------------------------------------------
// Sidecar process management
// ---------------------------------------------------------------------------

/// A handle to a spawned sidecar process, used to kill it.
struct SidecarChild {
    kill_tx: mpsc::Sender<()>,
}

impl SidecarChild {
    fn kill(&self) -> std::io::Result<()> {
        self.kill_tx
            .try_send(())
            .map_err(|e| std::io::Error::other(e.to_string()))
    }
}

/// Tracks a running sidecar.
struct TrackedSidecar {
    name: SidecarName,
    state: SidecarState,
    child: SidecarChild,
    exit_rx: Option<tokio::sync::oneshot::Receiver<TerminatedPayload>>,
    /// Ring buffer of recent stderr lines for crash diagnostics.
    last_stderr: Arc<Mutex<Vec<String>>>,
}

/// Maximum number of stderr lines to retain per sidecar for crash diagnostics.
const MAX_STDERR_LINES: usize = 50;

/// The well-known path where the MCP symlink is created.
const MCP_SYMLINK_PATH: &str = "/usr/local/bin/laborer-mcp";

/// Manages the lifecycle of sidecar processes.
///
/// Stored in Tauri's managed state so it can be accessed from commands and
/// the `RunEvent::Exit` handler.
pub struct SidecarManager {
    sidecars: Mutex<Vec<TrackedSidecar>>,
    shell_env: Option<HashMap<String, String>>,
}

impl SidecarManager {
    /// Create a new manager, probing the shell environment once upfront.
    pub fn new() -> Self {
        let shell_env = load_shell_env();
        Self {
            sidecars: Mutex::new(Vec::new()),
            shell_env,
        }
    }

    /// Resolve the path to a sidecar binary relative to the main Tauri binary.
    fn sidecar_path(app: &tauri::AppHandle, name: SidecarName) -> std::path::PathBuf {
        let binary = tauri::process::current_binary(&app.env())
            .expect("Failed to get current binary path");
        let dir = binary.parent().expect("Failed to get binary parent dir");
        let bin_name = match name {
            SidecarName::Server => "laborer-server",
            SidecarName::Terminal => "laborer-terminal",
        };
        dir.join(bin_name)
    }

    /// Resolve the path to the MCP binary inside the app bundle.
    fn mcp_binary_path(app: &tauri::AppHandle) -> std::path::PathBuf {
        let binary = tauri::process::current_binary(&app.env())
            .expect("Failed to get current binary path");
        let dir = binary.parent().expect("Failed to get binary parent dir");
        dir.join("laborer-mcp")
    }

    /// Create or update the MCP symlink at `/usr/local/bin/laborer-mcp`.
    ///
    /// - If the symlink already exists and points to the correct target, skip.
    /// - If the symlink exists but points elsewhere, remove and recreate.
    /// - If `/usr/local/bin/` is not writable, log a warning but do not block.
    pub fn create_mcp_symlink(app: &tauri::AppHandle) {
        let mcp_path = Self::mcp_binary_path(app);
        let symlink_path = std::path::Path::new(MCP_SYMLINK_PATH);

        // Verify the MCP binary exists in the bundle.
        if !mcp_path.exists() {
            log::warn!(
                "MCP binary not found at {}, skipping symlink creation",
                mcp_path.display()
            );
            return;
        }

        // Check if the symlink already exists and points to the correct target.
        if symlink_path.is_symlink() {
            match std::fs::read_link(symlink_path) {
                Ok(target) if target == mcp_path => {
                    log::info!(
                        "MCP symlink already points to correct target: {} -> {}",
                        MCP_SYMLINK_PATH,
                        mcp_path.display()
                    );
                    return;
                }
                Ok(old_target) => {
                    log::info!(
                        "MCP symlink points to old target: {} -> {}, updating",
                        MCP_SYMLINK_PATH,
                        old_target.display()
                    );
                    if let Err(e) = std::fs::remove_file(symlink_path) {
                        log::warn!(
                            "Failed to remove old MCP symlink at {}: {}",
                            MCP_SYMLINK_PATH,
                            e
                        );
                        return;
                    }
                }
                Err(e) => {
                    log::warn!(
                        "Failed to read MCP symlink at {}: {}",
                        MCP_SYMLINK_PATH,
                        e
                    );
                    // Try to remove and recreate.
                    let _ = std::fs::remove_file(symlink_path);
                }
            }
        } else if symlink_path.exists() {
            // A regular file (not a symlink) exists at the path — don't overwrite.
            log::warn!(
                "A non-symlink file exists at {}, skipping MCP symlink creation",
                MCP_SYMLINK_PATH
            );
            return;
        }

        // Create the symlink.
        #[cfg(unix)]
        match std::os::unix::fs::symlink(&mcp_path, symlink_path) {
            Ok(()) => {
                log::info!(
                    "Created MCP symlink: {} -> {}",
                    MCP_SYMLINK_PATH,
                    mcp_path.display()
                );
            }
            Err(e) => {
                log::warn!(
                    "Failed to create MCP symlink at {} (permission denied? run: sudo ln -sf {} {}): {}",
                    MCP_SYMLINK_PATH,
                    mcp_path.display(),
                    MCP_SYMLINK_PATH,
                    e
                );
            }
        }

        #[cfg(not(unix))]
        {
            log::warn!("MCP symlink creation is only supported on Unix");
        }
    }

    /// Build the environment variables to pass to a sidecar.
    fn sidecar_env(&self, app: &tauri::AppHandle, name: SidecarName) -> Vec<(String, String)> {
        // Use the Tauri app data directory as the data dir so sidecars
        // write to ~/Library/Application Support/com.izakfilmalter.laborer/data
        // instead of a relative path (which fails when CWD is / on macOS).
        let data_dir = app
            .path()
            .app_data_dir()
            .map(|p| p.join("data"))
            .unwrap_or_else(|_| std::path::PathBuf::from(DEFAULT_DATA_DIR));

        let mut vars = vec![
            ("PORT".to_string(), DEFAULT_PORT.to_string()),
            (
                "TERMINAL_PORT".to_string(),
                DEFAULT_TERMINAL_PORT.to_string(),
            ),
            (
                "PORT_RANGE_START".to_string(),
                DEFAULT_PORT_RANGE_START.to_string(),
            ),
            (
                "PORT_RANGE_END".to_string(),
                DEFAULT_PORT_RANGE_END.to_string(),
            ),
            (
                "DATA_DIR".to_string(),
                data_dir.to_string_lossy().to_string(),
            ),
        ];

        // Pass the MCP binary path to the server sidecar so that
        // mcp-registrar.ts writes AI agent configs pointing to it.
        // Prefer the symlink path if it exists and points to the right target,
        // otherwise use the binary path inside the app bundle.
        if name == SidecarName::Server {
            let mcp_path = Self::mcp_binary_path(app);
            let symlink_path = std::path::Path::new(MCP_SYMLINK_PATH);

            let laborer_mcp_path = if symlink_path.is_symlink() {
                // Symlink exists — use the well-known path so AI agents
                // can find it without knowing the .app bundle internals.
                MCP_SYMLINK_PATH.to_string()
            } else {
                // No symlink — fall back to the binary inside the bundle.
                mcp_path.to_string_lossy().to_string()
            };

            vars.push(("LABORER_MCP_PATH".to_string(), laborer_mcp_path));
        }

        merge_env(&self.shell_env, vars)
    }

    /// Spawn a sidecar process, track it, and log its stdout/stderr.
    pub async fn spawn(
        &self,
        app: &tauri::AppHandle,
        name: SidecarName,
    ) -> std::io::Result<()> {
        let path = Self::sidecar_path(app, name);
        let envs = self.sidecar_env(app, name);

        log::info!("Spawning sidecar: name={name} path={}", path.display());

        let mut cmd = Command::new(&path);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.stdin(Stdio::null());

        for (key, value) in &envs {
            cmd.env(key, value);
        }

        // Wrap with process group so killing the sidecar also kills children.
        let mut wrap = CommandWrap::from(cmd);

        #[cfg(unix)]
        {
            wrap.wrap(ProcessGroup::leader());
        }

        let mut child = wrap.spawn()?;

        let (kill_tx, mut kill_rx) = mpsc::channel::<()>(1);
        let (exit_tx, exit_rx) = tokio::sync::oneshot::channel::<TerminatedPayload>();

        // Shared stderr buffer for crash diagnostics.
        let stderr_buf: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

        // Stream stdout to log.
        let stdout = child.stdout().take();
        let sidecar_name_str = name.to_string();
        if let Some(stdout) = stdout {
            let label = sidecar_name_str.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stdout);
                let mut lines = reader.lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => log::info!("[{label}:stdout] {line}"),
                        Ok(None) => break,
                        Err(e) => {
                            log::error!("[{label}:stdout] read error: {e}");
                            break;
                        }
                    }
                }
            });
        }

        // Stream stderr to log and buffer recent lines.
        let stderr = child.stderr().take();
        if let Some(stderr) = stderr {
            let label = sidecar_name_str.clone();
            let buf = stderr_buf.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            log::warn!("[{label}:stderr] {line}");
                            let mut buffer = buf.lock().await;
                            if buffer.len() >= MAX_STDERR_LINES {
                                buffer.remove(0);
                            }
                            buffer.push(line);
                        }
                        Ok(None) => break,
                        Err(e) => {
                            log::error!("[{label}:stderr] read error: {e}");
                            break;
                        }
                    }
                }
            });
        }

        // Monitor process lifecycle: wait for exit or kill signal.
        let label = sidecar_name_str;
        tokio::spawn(async move {
            let mut exit_tx = Some(exit_tx);
            let mut kill_open = true;

            let status = loop {
                match child.try_wait() {
                    Ok(Some(status)) => break Ok(status),
                    Ok(None) => {}
                    Err(err) => break Err(err),
                }

                tokio::select! {
                    msg = kill_rx.recv(), if kill_open => {
                        if msg.is_some() {
                            log::info!("[{label}] Sending kill signal");
                            let _ = child.start_kill();
                        }
                        kill_open = false;
                    }
                    _ = tokio::time::sleep(Duration::from_millis(100)) => {}
                }
            };

            let payload = match status {
                Ok(status) => {
                    let signal = signal_from_status(&status);
                    log::info!(
                        "[{label}] Terminated: code={:?} signal={:?}",
                        status.code(),
                        signal
                    );
                    TerminatedPayload {
                        code: status.code(),
                        signal,
                    }
                }
                Err(err) => {
                    log::error!("[{label}] Process wait error: {err}");
                    TerminatedPayload {
                        code: None,
                        signal: None,
                    }
                }
            };

            if let Some(tx) = exit_tx.take() {
                let _ = tx.send(payload);
            }
        });

        // Track the sidecar.
        let tracked = TrackedSidecar {
            name,
            state: SidecarState::Starting,
            child: SidecarChild { kill_tx },
            exit_rx: Some(exit_rx),
            last_stderr: stderr_buf,
        };
        self.sidecars.lock().await.push(tracked);

        Ok(())
    }

    /// Spawn a sidecar and wait for it to become healthy.
    ///
    /// Polls the sidecar's HTTP health endpoint at `HEALTH_CHECK_INTERVAL` intervals.
    /// If the sidecar terminates before becoming healthy, or if `HEALTH_CHECK_TIMEOUT`
    /// elapses, the sidecar is marked as crashed and a `sidecar:error` event is emitted.
    /// On success, a `sidecar:healthy` event is emitted.
    pub async fn spawn_and_wait_healthy(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
        name: SidecarName,
    ) -> Result<(), String> {
        self.spawn(app, name)
            .await
            .map_err(|e| format!("Failed to spawn {name}: {e}"))?;

        let url = health_url(name);
        let exit_rx = self.take_exit_rx(name).await;
        let app_handle = app.clone();
        let manager = self.clone();

        // Race: health check polling vs process termination vs timeout.
        let result = {
            let health_poll = async {
                loop {
                    tokio::time::sleep(HEALTH_CHECK_INTERVAL).await;
                    if check_health(&url).await {
                        return Ok(());
                    }
                }
            };

            let terminated = async {
                if let Some(rx) = exit_rx {
                    match rx.await {
                        Ok(payload) => Err(format!(
                            "Sidecar {name} terminated before becoming healthy (code={:?} signal={:?})",
                            payload.code, payload.signal
                        )),
                        Err(_) => Err(format!("Sidecar {name} terminated before becoming healthy")),
                    }
                } else {
                    // No exit receiver — should not happen, but wait indefinitely
                    // so the health poll or timeout resolves first.
                    std::future::pending::<Result<(), String>>().await
                }
            };

            let timeout = async {
                tokio::time::sleep(HEALTH_CHECK_TIMEOUT).await;
                Err(format!(
                    "Sidecar {name} did not become healthy within {}s",
                    HEALTH_CHECK_TIMEOUT.as_secs()
                ))
            };

            tokio::select! {
                res = health_poll => res,
                res = terminated => res,
                res = timeout => res,
            }
        };

        match &result {
            Ok(()) => {
                manager.set_state(name, SidecarState::Healthy).await;
                log::info!("Sidecar {name} is healthy");
                let _ = app_handle.emit("sidecar:healthy", SidecarHealthyPayload { name });
            }
            Err(error) => {
                let last_stderr = manager.get_last_stderr(name).await;
                manager
                    .set_state(
                        name,
                        SidecarState::Crashed {
                            error: error.clone(),
                        },
                    )
                    .await;
                log::error!("Sidecar {name} failed: {error}");
                let _ = app_handle.emit(
                    "sidecar:error",
                    SidecarErrorPayload {
                        name,
                        error: error.clone(),
                        last_stderr,
                    },
                );
            }
        }

        // Start crash monitoring for healthy sidecars.
        if result.is_ok() {
            manager
                .start_crash_monitor(app.clone(), name)
                .await;
        }

        result
    }

    /// Set the state of a sidecar.
    async fn set_state(&self, name: SidecarName, state: SidecarState) {
        let mut sidecars = self.sidecars.lock().await;
        if let Some(sidecar) = sidecars.iter_mut().find(|s| s.name == name) {
            sidecar.state = state;
        }
    }

    /// Get the current state of a sidecar.
    pub async fn get_state(&self, name: SidecarName) -> Option<SidecarState> {
        let sidecars = self.sidecars.lock().await;
        sidecars.iter().find(|s| s.name == name).map(|s| s.state.clone())
    }

    /// Get the last stderr lines from a sidecar (for crash diagnostics).
    async fn get_last_stderr(&self, name: SidecarName) -> String {
        let sidecars = self.sidecars.lock().await;
        if let Some(sidecar) = sidecars.iter().find(|s| s.name == name) {
            let lines = sidecar.last_stderr.lock().await;
            lines.join("\n")
        } else {
            String::new()
        }
    }

    /// Take the exit receiver for a specific sidecar (used for health check racing).
    pub async fn take_exit_rx(
        &self,
        name: SidecarName,
    ) -> Option<tokio::sync::oneshot::Receiver<TerminatedPayload>> {
        let mut sidecars = self.sidecars.lock().await;
        for sidecar in sidecars.iter_mut() {
            if sidecar.name == name {
                return sidecar.exit_rx.take();
            }
        }
        None
    }

    /// Start monitoring a healthy sidecar for unexpected crashes.
    ///
    /// Spawns a background task that takes the sidecar's exit receiver and
    /// watches for termination. If the sidecar exits while in the `Healthy`
    /// state, it transitions to `Crashed` and emits a `sidecar:error` event.
    async fn start_crash_monitor(self: &Arc<Self>, app: tauri::AppHandle, name: SidecarName) {
        let exit_rx = self.take_exit_rx(name).await;
        let Some(exit_rx) = exit_rx else {
            log::warn!("No exit receiver for crash monitoring: {name}");
            return;
        };

        let manager = self.clone();
        tokio::spawn(async move {
            let result = exit_rx.await;
            let current_state = manager.get_state(name).await;

            // Only treat as a crash if the sidecar was in the Healthy state.
            // If it was already Stopped (intentional kill), ignore.
            if current_state == Some(SidecarState::Healthy) {
                let error = match result {
                    Ok(payload) => format!(
                        "Sidecar {name} crashed unexpectedly (code={:?} signal={:?})",
                        payload.code, payload.signal
                    ),
                    Err(_) => format!("Sidecar {name} crashed unexpectedly"),
                };

                let last_stderr = manager.get_last_stderr(name).await;
                manager
                    .set_state(
                        name,
                        SidecarState::Crashed {
                            error: error.clone(),
                        },
                    )
                    .await;
                log::error!("{error}");
                let _ = app.emit(
                    "sidecar:error",
                    SidecarErrorPayload {
                        name,
                        error,
                        last_stderr,
                    },
                );
            }
        });
    }

    /// Kill a specific sidecar by name. Sets its state to `Stopped`.
    pub async fn kill_one(&self, name: SidecarName) {
        let mut sidecars = self.sidecars.lock().await;
        if let Some(idx) = sidecars.iter().position(|s| s.name == name) {
            log::info!("Killing sidecar: {name}");
            sidecars[idx].state = SidecarState::Stopped;
            let _ = sidecars[idx].child.kill();
            // Brief wait for the process to exit.
            drop(sidecars);
            tokio::time::sleep(Duration::from_millis(200)).await;
            let mut sidecars = self.sidecars.lock().await;
            if let Some(idx) = sidecars.iter().position(|s| s.name == name) {
                sidecars.remove(idx);
            }
        }
    }

    /// Kill all tracked sidecars and wait briefly for them to exit.
    pub async fn kill_all(&self) {
        let mut sidecars = self.sidecars.lock().await;
        log::info!("Killing all sidecars: count={}", sidecars.len());

        for sidecar in sidecars.iter() {
            log::info!("Killing sidecar: {}", sidecar.name);
            let _ = sidecar.child.kill();
        }

        // Give processes a moment to terminate.
        tokio::time::sleep(Duration::from_millis(500)).await;

        sidecars.clear();
        log::info!("All sidecars killed");
    }

    /// Restart a specific sidecar: kill it (if running), re-spawn, and re-run
    /// health checks. Emits appropriate Tauri events on success or failure.
    pub async fn restart(
        self: &Arc<Self>,
        app: &tauri::AppHandle,
        name: SidecarName,
    ) -> Result<(), String> {
        log::info!("Restarting sidecar: {name}");
        self.kill_one(name).await;
        self.spawn_and_wait_healthy(app, name).await
    }
}

/// Extract the signal number from an exit status (Unix only).
fn signal_from_status(status: &std::process::ExitStatus) -> Option<i32> {
    #[cfg(unix)]
    return status.signal();

    #[cfg(not(unix))]
    {
        let _ = status;
        None
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// Restart a crashed sidecar. Called from the frontend.
#[tauri::command]
pub async fn restart_sidecar(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<SidecarManager>>,
    name: SidecarName,
) -> Result<(), String> {
    manager.restart(&app, name).await
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_shell_env_handles_null_delimited_pairs() {
        let env = parse_shell_env(b"PATH=/usr/bin:/bin\0FOO=bar=baz\0\0");
        assert_eq!(env.get("PATH"), Some(&"/usr/bin:/bin".to_string()));
        assert_eq!(env.get("FOO"), Some(&"bar=baz".to_string()));
    }

    #[test]
    fn parse_shell_env_ignores_invalid_entries() {
        let env = parse_shell_env(b"INVALID\0=empty\0OK=1\0");
        assert_eq!(env.len(), 1);
        assert_eq!(env.get("OK"), Some(&"1".to_string()));
    }

    #[test]
    fn merge_env_overrides_shell_values() {
        let mut shell = HashMap::new();
        shell.insert("PATH".to_string(), "/shell/path".to_string());
        shell.insert("HOME".to_string(), "/tmp/home".to_string());

        let merged: HashMap<String, String> = merge_env(
            &Some(shell),
            vec![
                ("PATH".to_string(), "/override/path".to_string()),
                ("PORT".to_string(), "4100".to_string()),
            ],
        )
        .into_iter()
        .collect();

        assert_eq!(merged.get("PATH"), Some(&"/override/path".to_string()));
        assert_eq!(merged.get("HOME"), Some(&"/tmp/home".to_string()));
        assert_eq!(merged.get("PORT"), Some(&"4100".to_string()));
    }

    #[test]
    fn merge_env_handles_no_shell_env() {
        let merged: HashMap<String, String> = merge_env(
            &None,
            vec![("PORT".to_string(), "4100".to_string())],
        )
        .into_iter()
        .collect();

        assert_eq!(merged.len(), 1);
        assert_eq!(merged.get("PORT"), Some(&"4100".to_string()));
    }

    #[test]
    fn is_nushell_detects_variants() {
        assert!(is_nushell("nu"));
        assert!(is_nushell("/opt/homebrew/bin/nu"));
        assert!(!is_nushell("/bin/zsh"));
        assert!(!is_nushell("/bin/bash"));
    }

    #[test]
    fn sidecar_name_display() {
        assert_eq!(SidecarName::Server.to_string(), "server");
        assert_eq!(SidecarName::Terminal.to_string(), "terminal");
    }

    #[test]
    fn sidecar_name_serialize() {
        let json = serde_json::to_string(&SidecarName::Server).unwrap();
        assert_eq!(json, "\"server\"");
        let json = serde_json::to_string(&SidecarName::Terminal).unwrap();
        assert_eq!(json, "\"terminal\"");
    }

    #[test]
    fn sidecar_state_serialize() {
        let json = serde_json::to_string(&SidecarState::Starting).unwrap();
        assert_eq!(json, r#"{"status":"starting"}"#);

        let json = serde_json::to_string(&SidecarState::Healthy).unwrap();
        assert_eq!(json, r#"{"status":"healthy"}"#);

        let json = serde_json::to_string(&SidecarState::Crashed {
            error: "oops".to_string(),
        })
        .unwrap();
        assert_eq!(json, r#"{"status":"crashed","error":"oops"}"#);

        let json = serde_json::to_string(&SidecarState::Stopped).unwrap();
        assert_eq!(json, r#"{"status":"stopped"}"#);
    }

    #[test]
    fn sidecar_healthy_payload_serialize() {
        let payload = SidecarHealthyPayload {
            name: SidecarName::Server,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert_eq!(json, r#"{"name":"server"}"#);
    }

    #[test]
    fn sidecar_error_payload_serialize() {
        let payload = SidecarErrorPayload {
            name: SidecarName::Terminal,
            error: "crashed".to_string(),
            last_stderr: "line1\nline2".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains(r#""name":"terminal""#));
        assert!(json.contains(r#""error":"crashed""#));
        assert!(json.contains(r#""last_stderr":"line1\nline2""#));
    }

    #[test]
    fn health_url_returns_correct_urls() {
        assert_eq!(health_url(SidecarName::Server), "http://127.0.0.1:4100");
        assert_eq!(health_url(SidecarName::Terminal), "http://127.0.0.1:4102");
    }

    #[tokio::test]
    async fn check_health_returns_false_for_nonexistent_server() {
        // Port 19999 is extremely unlikely to have a server listening.
        let result = check_health("http://127.0.0.1:19999").await;
        assert!(!result);
    }

    #[test]
    fn sidecar_state_equality() {
        assert_eq!(SidecarState::Starting, SidecarState::Starting);
        assert_eq!(SidecarState::Healthy, SidecarState::Healthy);
        assert_eq!(SidecarState::Stopped, SidecarState::Stopped);
        assert_eq!(
            SidecarState::Crashed {
                error: "x".to_string()
            },
            SidecarState::Crashed {
                error: "x".to_string()
            }
        );
        assert_ne!(SidecarState::Starting, SidecarState::Healthy);
    }

    #[tokio::test]
    async fn sidecar_manager_new_creates_empty_state() {
        // NOTE: This test probes the real shell env, which is fine for unit tests.
        let manager = SidecarManager::new();
        let sidecars = manager.sidecars.lock().await;
        assert!(sidecars.is_empty());
    }

    #[tokio::test]
    async fn get_state_returns_none_for_unknown_sidecar() {
        let manager = SidecarManager::new();
        let state = manager.get_state(SidecarName::Server).await;
        assert!(state.is_none());
    }

    #[test]
    fn mcp_symlink_path_constant() {
        assert_eq!(MCP_SYMLINK_PATH, "/usr/local/bin/laborer-mcp");
    }
}
