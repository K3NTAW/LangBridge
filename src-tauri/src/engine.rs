//! Bridge from the Tauri host to the spawned `sift-engine-host`
//! subprocess.
//!
//! At app boot, [`Engine::spawn`] launches the binary, waits for its
//! `READY\n` line on stdout, opens the UDS, and stashes everything in
//! a single struct held in Tauri's app state. From then on UI code
//! invokes Tauri commands declared in this module ([`engine_info`],
//! [`engine_new`], [`engine_apply`], …); each acquires the mutex,
//! writes one JSON-RPC request, reads one response, and returns.
//!
//! ## Why a long-lived UDS connection
//!
//! The engine is single-threaded and processes one request at a time
//! (see `sift-engine`'s `host` module). Tauri's UI rarely fires more
//! than one engine call concurrently — and when it does, queueing
//! behind a mutex is the correct semantic. A connection-per-call model
//! would re-incur the bind/connect cost and pay nothing for it.
//!
//! ## Lifetime
//!
//! Right now we spawn the engine on app start and let `kill_on_drop`
//! tear it down on shutdown. A future iteration may want supervised
//! restart on engine death (the engine is the only process that can
//! brick the app), but for v0 the simple lifecycle matches the spec.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::process::{Child, Command};
use tokio::sync::Mutex;
use tokio::time::timeout;

/// Errors surfaced to the front-end as plain strings (Tauri commands
/// must return `Result<_, String>` for serde compatibility, so the
/// outer command layer converts these via `to_string`).
#[derive(Error, Debug)]
pub enum EngineError {
    /// Couldn't spawn the binary or talk to it.
    #[error("engine subprocess: {0}")]
    Subprocess(String),
    /// Wire-level I/O failure.
    #[error("engine io: {0}")]
    Io(#[from] std::io::Error),
    /// JSON failed to encode or decode.
    #[error("engine protocol: {0}")]
    Protocol(String),
    /// Engine returned a JSON-RPC error.
    #[error("engine error {code}: {message}")]
    Rpc {
        /// JSON-RPC error code.
        code: i32,
        /// Engine-supplied message.
        message: String,
    },
}

impl From<EngineError> for String {
    fn from(e: EngineError) -> Self {
        e.to_string()
    }
}

/// Owns the live engine subprocess and the JSON-RPC client end of its
/// UDS. Kept in Tauri's app state behind a `Mutex` because every
/// caller needs exclusive access to write/read one full RPC pair.
pub struct Engine {
    /// Held so `kill_on_drop` triggers on app shutdown.
    _child: Child,
    /// The active socket connection.
    stream: UnixStream,
    /// Monotonic JSON-RPC request id.
    next_id: AtomicU64,
    /// Path of the UDS file, removed on drop.
    socket_path: PathBuf,
}

/// What [`Engine::spawn`] resolves the engine binary to. The path is
/// computed via [`resolve_engine_binary`] and recorded so logs / error
/// messages can include it.
#[derive(Debug)]
pub struct SpawnedEngine {
    /// The path used to spawn the binary, for diagnostics.
    pub bin: PathBuf,
    /// The Unix domain socket the engine bound.
    pub socket: PathBuf,
}

impl Engine {
    /// Spawn `sift-engine-host`, wait for `READY`, connect, and return
    /// the live handle.
    pub async fn spawn() -> Result<(Self, SpawnedEngine), EngineError> {
        let bin = resolve_engine_binary()
            .ok_or_else(|| EngineError::Subprocess(
                "sift-engine-host binary not found — try `cargo build` in sift-engine, \
                 or set CUT_ENGINE_BIN".to_string(),
            ))?;

        let socket = Self::pick_socket_path();

        let mut child = Command::new(&bin)
            .arg("--socket")
            .arg(&socket)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| EngineError::Subprocess(format!(
                "failed to spawn {}: {e}", bin.display()
            )))?;

        let stdout = child.stdout.take().ok_or_else(|| EngineError::Subprocess(
            "child has no stdout pipe".to_string(),
        ))?;
        let mut lines = BufReader::new(stdout).lines();
        let line = timeout(Duration::from_secs(10), lines.next_line())
            .await
            .map_err(|_| EngineError::Subprocess(
                "timed out waiting for engine READY line".to_string(),
            ))?
            .map_err(|e| EngineError::Subprocess(format!("read READY: {e}")))?
            .ok_or_else(|| EngineError::Subprocess(
                "engine exited before printing READY".to_string(),
            ))?;
        if line.trim() != "READY" {
            return Err(EngineError::Subprocess(format!(
                "expected READY, got: {line:?}"
            )));
        }

        // After READY, we keep the lines reader alive to drain stdout
        // (the engine doesn't write more, but if it did we want it to
        // not back-pressure). Spawning a tiny task to discard further
        // bytes is cheaper than leaving the pipe full.
        tokio::spawn(async move {
            let mut lines = lines;
            while let Ok(Some(line)) = lines.next_line().await {
                log::debug!("[engine] {line}");
            }
        });

        let stream = UnixStream::connect(&socket)
            .await
            .map_err(|e| EngineError::Subprocess(format!(
                "failed to connect to engine UDS at {}: {e}",
                socket.display()
            )))?;

        let spawned = SpawnedEngine {
            bin,
            socket: socket.clone(),
        };
        Ok((
            Self {
                _child: child,
                stream,
                next_id: AtomicU64::new(1),
                socket_path: socket,
            },
            spawned,
        ))
    }

    /// Make one JSON-RPC call. Returns the parsed `result` value
    /// (or an `EngineError::Rpc` if the engine returned an error).
    pub async fn call(&mut self, method: &str, params: Value) -> Result<Value, EngineError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let req = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let bytes = serde_json::to_vec(&req)
            .map_err(|e| EngineError::Protocol(format!("encode: {e}")))?;
        self.stream
            .write_all(&(bytes.len() as u32).to_be_bytes())
            .await?;
        self.stream.write_all(&bytes).await?;
        self.stream.flush().await?;

        let mut len_buf = [0u8; 4];
        self.stream.read_exact(&mut len_buf).await?;
        let len = u32::from_be_bytes(len_buf) as usize;
        if len > 16 * 1024 * 1024 {
            return Err(EngineError::Protocol(format!("response too large: {len}")));
        }
        let mut buf = vec![0u8; len];
        self.stream.read_exact(&mut buf).await?;

        #[derive(Deserialize)]
        struct Resp {
            #[allow(dead_code)]
            jsonrpc: String,
            #[allow(dead_code)]
            id: Option<Value>,
            result: Option<Value>,
            error: Option<RpcErrorBody>,
        }
        #[derive(Deserialize)]
        struct RpcErrorBody {
            code: i32,
            message: String,
        }
        let resp: Resp = serde_json::from_slice(&buf)
            .map_err(|e| EngineError::Protocol(format!("decode: {e}")))?;
        if let Some(err) = resp.error {
            return Err(EngineError::Rpc {
                code: err.code,
                message: err.message,
            });
        }
        Ok(resp.result.unwrap_or(Value::Null))
    }

    fn pick_socket_path() -> PathBuf {
        let mut p = std::env::temp_dir();
        // ULID-style nonce so concurrent app launches don't collide.
        // We don't import `ulid` here (it's heavy); a simple
        // pid+timestamp suffix is plenty for a per-launch socket.
        let nonce = format!(
            "{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        );
        p.push(format!("sift-engine-{nonce}.sock"));
        p
    }
}

impl Drop for Engine {
    fn drop(&mut self) {
        // The Child's kill_on_drop handles the process. We just clean
        // up the socket file so it doesn't pile up in /tmp.
        let _ = std::fs::remove_file(&self.socket_path);
    }
}

/// Resolve the path to the `sift-engine-host` binary.
///
/// Order of precedence:
/// 1. `CUT_ENGINE_BIN` environment variable (escape hatch for ops).
/// 2. Sibling workspace `sift-engine/target/{release,debug}/sift-engine-host`,
///    anchored either to the current working directory (when launched
///    from a script that cd'd into the workspace) or to the Tauri
///    executable's own location (so `npm run tauri dev` works
///    regardless of the user's cwd).
///
/// Production-mode resolution from a Tauri-bundled resource lands once
/// we wire the build to copy the binary into the app's resources dir;
/// for now dev-mode is the only supported path.
pub fn resolve_engine_binary() -> Option<PathBuf> {
    if let Ok(env_path) = std::env::var("CUT_ENGINE_BIN") {
        let p = PathBuf::from(env_path);
        if p.is_file() {
            return Some(p);
        }
    }

    let suffixes = [
        "sift-engine/target/release/sift-engine-host",
        "sift-engine/target/debug/sift-engine-host",
    ];
    let bin_name = if cfg!(windows) { ".exe" } else { "" };

    // Anchor candidates: cwd, plus walking up from the Tauri exe.
    let mut anchors: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        anchors.push(cwd);
    }
    if let Ok(exe) = std::env::current_exe() {
        let mut cursor = exe.parent().map(Path::to_path_buf);
        for _ in 0..6 {
            match cursor {
                Some(p) => {
                    anchors.push(p.clone());
                    cursor = p.parent().map(Path::to_path_buf);
                }
                None => break,
            }
        }
    }

    for anchor in &anchors {
        for suffix in suffixes {
            let mut candidate = anchor.join(suffix);
            if !bin_name.is_empty() {
                candidate.set_extension(&bin_name[1..]);
            }
            if candidate.is_file() {
                return Some(candidate.canonicalize().unwrap_or(candidate));
            }
        }
    }

    None
}

// ── Tauri commands (thin pass-throughs to Engine::call) ──────────────

/// Wrapper held in Tauri's managed state. Mutex because the wire
/// requires strict request/response interleaving.
pub struct EngineHandle(pub Mutex<Engine>);

/// Engine version banner returned by [`engine_info_static`]. Exposed
/// publicly because Tauri's command-generation macro requires it.
#[derive(Serialize)]
pub struct EngineInfo {
    /// `sift-engine` crate version.
    pub engine_version: String,
    /// Spec version this engine implements.
    pub spec_version: String,
}

/// Static info about the linked engine. Doesn't hit the subprocess —
/// this is the process-local crate version; matched by the engine's
/// `info` method on the wire (which returns the same constants from
/// the engine subprocess's vantage).
#[tauri::command]
pub fn engine_info_static() -> EngineInfo {
    EngineInfo {
        engine_version: sift_engine::ENGINE_VERSION.to_string(),
        spec_version: sift_engine::SPEC_VERSION.to_string(),
    }
}

#[tauri::command]
pub async fn engine_info(state: tauri::State<'_, EngineHandle>) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("info", json!({})).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_new(state: tauri::State<'_, EngineHandle>) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("new", json!({})).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_head(state: tauri::State<'_, EngineHandle>) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("head", json!({})).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_apply(
    state: tauri::State<'_, EngineHandle>,
    op: Value,
) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("apply", json!({ "op": op })).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_apply_batch(
    state: tauri::State<'_, EngineHandle>,
    ops: Value,
    group_undo: Option<bool>,
) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call(
        "apply_batch",
        json!({
            "ops": ops,
            "group_undo": group_undo.unwrap_or(false),
        }),
    )
    .await
    .map_err(Into::into)
}

#[tauri::command]
pub async fn engine_inverse(
    state: tauri::State<'_, EngineHandle>,
    op: Value,
) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("inverse", json!({ "op": op })).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_undo(state: tauri::State<'_, EngineHandle>) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("undo", json!({})).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_redo(state: tauri::State<'_, EngineHandle>) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("redo", json!({})).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_render_ranges(
    state: tauri::State<'_, EngineHandle>,
) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("render_ranges", json!({})).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_timeline_layout(state: tauri::State<'_, EngineHandle>) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("timeline_layout", json!({})).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_preview_primary_media(state: tauri::State<'_, EngineHandle>) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("preview_primary_media", json!({}))
        .await
        .map_err(Into::into)
}

// engine_proxy_generate and preview_timeline_frame_png removed in the
// Sift pivot. Single-file preview is `preview::preview_frame_png` (kept
// during Milestone A as a thumbnail/poster helper) and the new
// segment-cache renderer (lib/previewRender.ts) is what feeds the
// <video> element.

#[tauri::command]
pub async fn engine_clear_history(
    state: tauri::State<'_, EngineHandle>,
) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("clear_history", json!({})).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_save(
    state: tauri::State<'_, EngineHandle>,
    path: PathBuf,
) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("save", json!({ "path": path })).await.map_err(Into::into)
}

#[tauri::command]
pub async fn engine_load(
    state: tauri::State<'_, EngineHandle>,
    path: PathBuf,
) -> Result<Value, String> {
    let mut g = state.0.lock().await;
    g.call("load", json!({ "path": path })).await.map_err(Into::into)
}
