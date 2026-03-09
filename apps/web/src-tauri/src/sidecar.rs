use process_wrap::tokio::CommandWrap;
#[cfg(unix)]
use process_wrap::tokio::ProcessGroup;
use std::collections::HashMap;
#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;
use std::process::Stdio;
use std::time::{Duration, Instant};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    process::Command,
    sync::{mpsc, Mutex},
};

/// Timeout for probing the user's login shell environment.
const SHELL_ENV_TIMEOUT: Duration = Duration::from_secs(5);

/// Default environment variable values matching `@laborer/env/server`.
const DEFAULT_PORT: &str = "2100";
const DEFAULT_TERMINAL_PORT: &str = "2102";
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
// Sidecar process management
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

/// Payload emitted when a sidecar process terminates.
#[derive(Debug, Clone, Copy)]
pub struct TerminatedPayload {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

/// Tracks a running sidecar.
struct TrackedSidecar {
    name: SidecarName,
    child: SidecarChild,
    exit_rx: Option<tokio::sync::oneshot::Receiver<TerminatedPayload>>,
}

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

    /// Build the environment variables to pass to a sidecar.
    fn sidecar_env(&self, name: SidecarName) -> Vec<(String, String)> {
        let vars = vec![
            ("PORT".to_string(), DEFAULT_PORT.to_string()),
            (
                "TERMINAL_PORT".to_string(),
                DEFAULT_TERMINAL_PORT.to_string(),
            ),
            ("DATA_DIR".to_string(), DEFAULT_DATA_DIR.to_string()),
        ];

        // Terminal service only needs its own port.
        if name == SidecarName::Terminal {
            // TERMINAL_PORT is already included above.
        }

        merge_env(&self.shell_env, vars)
    }

    /// Spawn a sidecar process, track it, and log its stdout/stderr.
    ///
    /// Returns a oneshot receiver that resolves when the sidecar terminates.
    pub async fn spawn(
        &self,
        app: &tauri::AppHandle,
        name: SidecarName,
    ) -> std::io::Result<()> {
        let path = Self::sidecar_path(app, name);
        let envs = self.sidecar_env(name);

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

        // Stream stderr to log.
        let stderr = child.stderr().take();
        if let Some(stderr) = stderr {
            let label = sidecar_name_str.clone();
            tokio::spawn(async move {
                let reader = BufReader::new(stderr);
                let mut lines = reader.lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => log::warn!("[{label}:stderr] {line}"),
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
            child: SidecarChild { kill_tx },
            exit_rx: Some(exit_rx),
        };
        self.sidecars.lock().await.push(tracked);

        Ok(())
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
                ("PORT".to_string(), "2100".to_string()),
            ],
        )
        .into_iter()
        .collect();

        assert_eq!(merged.get("PATH"), Some(&"/override/path".to_string()));
        assert_eq!(merged.get("HOME"), Some(&"/tmp/home".to_string()));
        assert_eq!(merged.get("PORT"), Some(&"2100".to_string()));
    }

    #[test]
    fn merge_env_handles_no_shell_env() {
        let merged: HashMap<String, String> = merge_env(
            &None,
            vec![("PORT".to_string(), "2100".to_string())],
        )
        .into_iter()
        .collect();

        assert_eq!(merged.len(), 1);
        assert_eq!(merged.get("PORT"), Some(&"2100".to_string()));
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
}
