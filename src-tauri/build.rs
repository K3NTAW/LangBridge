//! Copy `engine-spike` release binary into `resources/` when present so
//! `tauri build` can bundle it (see `tauri.conf.json` → `bundle.resources`).

use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let resources = manifest_dir.join("resources");
    let _ = std::fs::create_dir_all(&resources);

    let workspace_spike = manifest_dir.join("../../engine-spike/target/release");
    #[cfg(windows)]
    let src = workspace_spike.join("engine-spike.exe");
    #[cfg(not(windows))]
    let src = workspace_spike.join("engine-spike");

    #[cfg(windows)]
    let dest = resources.join("engine-spike.exe");
    #[cfg(not(windows))]
    let dest = resources.join("engine-spike");

    if src.is_file() {
        match std::fs::copy(&src, &dest) {
            Ok(_) => println!(
                "cargo:warning=bundled engine-spike for resources → {}",
                dest.display()
            ),
            Err(e) => println!(
                "cargo:warning=could not copy engine-spike ({}): {}",
                src.display(),
                e
            ),
        }
    } else {
        println!(
            "cargo:warning=engine-spike not found at {} — GPU preview bundle skipped until `cargo build --release` is run in engine-spike/",
            src.display()
        );
    }
}
