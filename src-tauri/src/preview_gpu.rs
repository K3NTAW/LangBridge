//! GPU preview via **`engine-spike`** (FFmpeg CPU decode → wgpu window).
//!
//! ## Process model (macOS-safe)
//!
//! Tauri owns the main-thread GUI; **`winit`/`wgpu` must not fight that loop**.
//! We therefore **`spawn` the spike executable** with `--ipc-stdin`, keep the
//! child’s **stdin pipe**, and send `seek <seconds>` lines so timeline scrub /
//! play stays loosely coupled without embedding a second event loop in-process.
//!
//! True **in-pane WebView embedding** (metal texture bridged into `<canvas>`)
//! remains compositor work — see `docs/architecture.md` §4.
//!
//! ## Binary resolution
//!
//! 1. `CUT_ENGINE_SPIKE_BIN`
//! 2. **`resolve(..., BaseDirectory::Resource)`** — file bundled via `build.rs`
//!    → `resources/engine-spike` (`npm run tauri build`)
//! 3. Workspace `engine-spike/target/{release,debug}/engine-spike` from cwd or
//!    ancestors of `current_exe` (dev without copying).

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, State};

#[derive(Debug)]
pub struct GpuPreviewSession {
    pub child: Child,
    pub stdin: ChildStdin,
}

#[derive(Clone)]
pub struct GpuPreviewState(pub Arc<Mutex<Option<GpuPreviewSession>>>);

impl Default for GpuPreviewState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(None)))
    }
}

fn workspace_candidates() -> Option<PathBuf> {
    let suffixes = [
        "engine-spike/target/release/engine-spike",
        "engine-spike/target/debug/engine-spike",
    ];
    #[cfg(windows)]
    let suffixes_exe = [
        "engine-spike/target/release/engine-spike.exe",
        "engine-spike/target/debug/engine-spike.exe",
    ];

    let mut anchors: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        anchors.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.parent().map(Path::to_path_buf);
        for _ in 0..10 {
            match cursor {
                Some(p) => {
                    anchors.push(p.clone());
                    cursor = p.parent().map(Path::to_path_buf);
                }
                None => break,
            }
        }
    }

    let bin_name = if cfg!(windows) { ".exe" } else { "" };

    for anchor in &anchors {
        for suffix in suffixes.iter() {
            let mut candidate = anchor.join(suffix);
            if !bin_name.is_empty() {
                candidate.set_extension(&bin_name[1..]);
            }
            if candidate.is_file() {
                return Some(candidate.canonicalize().unwrap_or(candidate));
            }
        }
        #[cfg(windows)]
        for suffix in suffixes_exe.iter() {
            let candidate = anchor.join(suffix);
            if candidate.is_file() {
                return Some(candidate.canonicalize().unwrap_or(candidate));
            }
        }
    }

    None
}

/// Locate `engine-spike` — see module docs.
pub fn resolve_engine_spike_binary(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(env_path) = std::env::var("CUT_ENGINE_SPIKE_BIN") {
        let p = PathBuf::from(env_path);
        if p.is_file() {
            return Some(p);
        }
    }

    if let Ok(r) = app.path().resolve("engine-spike", BaseDirectory::Resource) {
        if r.is_file() {
            return Some(r);
        }
    }

    #[cfg(windows)]
    if let Ok(r) = app.path().resolve("engine-spike.exe", BaseDirectory::Resource) {
        if r.is_file() {
            return Some(r);
        }
    }

    workspace_candidates()
}

fn spawn_gpu_ipc_child(bin: &Path, media: &Path) -> Result<GpuPreviewSession, String> {
    let mut child = Command::new(bin)
        .arg("--ipc-stdin")
        .arg(media.as_os_str())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to start engine-spike ({}): {e}", bin.display()))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "engine-spike stdin pipe missing".to_string())?;

    Ok(GpuPreviewSession { child, stdin })
}

#[tauri::command]
pub async fn preview_gpu_window_open(app: AppHandle, state: State<'_, GpuPreviewState>, path: String) -> Result<(), String> {
    let bin = resolve_engine_spike_binary(&app).ok_or_else(|| {
        "engine-spike binary not found — for dev: `cargo build --release` in engine-spike/ \
         (copied into resources by build.rs), set CUT_ENGINE_SPIKE_BIN, or bundle via `tauri build`"
            .to_string()
    })?;

    let path_buf = PathBuf::from(path);
    if !path_buf.is_file() {
        return Err(format!("not a file: {}", path_buf.display()));
    }

    let gpu = state.inner().clone();

    tokio::task::spawn_blocking(move || {
        let mut guard = gpu
            .0
            .lock()
            .map_err(|_| "GPU preview mutex poisoned".to_string())?;

        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }

        let session = spawn_gpu_ipc_child(&bin, &path_buf)?;
        *guard = Some(session);
        Ok::<_, String>(())
    })
    .await
    .map_err(|e| format!("preview_gpu_window_open join: {e}"))??;

    Ok(())
}

#[tauri::command]
pub fn preview_gpu_seek(state: State<'_, GpuPreviewState>, seek_seconds: f64) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "GPU preview mutex poisoned".to_string())?;
    let session = guard
        .as_mut()
        .ok_or_else(|| "GPU preview is not open".to_string())?;

    let line = format!("seek {seek_seconds:.6}\n");
    session
        .stdin
        .write_all(line.as_bytes())
        .map_err(|e| format!("GPU preview stdin write failed: {e}"))?;
    session
        .stdin
        .flush()
        .map_err(|e| format!("GPU preview stdin flush failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn preview_gpu_close(state: State<'_, GpuPreviewState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "GPU preview mutex poisoned".to_string())?;
    if let Some(mut s) = guard.take() {
        let _ = s.child.kill();
        let _ = s.child.wait();
    }
    Ok(())
}
