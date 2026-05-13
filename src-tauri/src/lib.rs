//! Sift Tauri host library.
//!
//! Runs the Tauri runtime, owns the main window, spawns the
//! `sift-engine-host` subprocess at boot, and exposes Tauri commands
//! ([`engine::engine_info`], [`engine::engine_apply`], …) that the
//! React UI invokes via `@tauri-apps/api`.
//!
//! See [`engine`] for the bridge mechanics; this module is just the
//! Tauri runtime glue.

mod engine;
mod preview;
mod preview_render;

use tauri::Manager;
use tokio::sync::Mutex;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .setup(|app| {
            // Spawn the engine subprocess on the Tauri runtime's
            // tokio executor. We block_on here because the rest of
            // setup (and command handling) needs the engine handle
            // to already exist.
            let handle = tauri::async_runtime::block_on(async {
                engine::Engine::spawn().await
            });
            match handle {
                Ok((engine, info)) => {
                    log::info!(
                        "[sift-app] spawned engine: bin={}, socket={}",
                        info.bin.display(),
                        info.socket.display(),
                    );
                    app.manage(engine::EngineHandle(Mutex::new(engine)));
                }
                Err(e) => {
                    // Surface the failure clearly. For dev we keep
                    // running so the UI loads — commands will return
                    // errors via the missing managed state, which the
                    // UI shows in the engine status badge.
                    log::error!(
                        "[sift-app] failed to spawn engine: {e}\n\
                         The UI will run but engine commands will fail. \
                         Try `cargo build --bin sift-engine-host` in sift-engine, \
                         or set CUT_ENGINE_BIN to an explicit path."
                    );
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            engine::engine_info_static,
            engine::engine_info,
            engine::engine_new,
            engine::engine_head,
            engine::engine_apply,
            engine::engine_apply_batch,
            engine::engine_inverse,
            engine::engine_undo,
            engine::engine_redo,
            engine::engine_render_ranges,
            engine::engine_timeline_layout,
            engine::engine_preview_primary_media,
            engine::engine_clear_history,
            engine::engine_save,
            engine::engine_load,
            preview::preview_frame_png,
            preview::preview_probe,
            preview_render::preview_render_flatten,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
