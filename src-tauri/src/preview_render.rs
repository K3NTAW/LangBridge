//! Shell-side preview renderer for Sift (Milestone A slice 3).
//!
//! Given a list of `(source_path, src_in_secs, src_out_secs)` ranges
//! and an output path, shells out to `ffmpeg` with a `filter_complex`
//! `concat` graph that trims each range from its source and glues them
//! together into a single MP4. Single-pass encode for now — the
//! segment cache (incremental rendering, concat-by-copy) lands as a
//! follow-up once we have a working baseline.
//!
//! Output is H.264 + AAC, CRF 23, `veryfast` preset, 1280-edge target
//! resolution. Tuned for preview, not finishing — export uses the same
//! plumbing at full resolution.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};

/// One range from the engine's render plan, with its source path resolved.
#[derive(Debug, Deserialize)]
pub struct PreviewRange {
    pub source_path: String,
    pub src_in_secs: f64,
    pub src_out_secs: f64,
}

/// Result of [`preview_render_flatten`].
#[derive(Debug, Serialize)]
pub struct PreviewRenderResult {
    /// Absolute path to the produced preview MP4.
    pub output_path: String,
    /// Total duration of the cut (sum of range durations).
    pub duration_secs: f64,
    /// Number of ranges that were concatenated.
    pub range_count: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum PreviewRenderError {
    #[error("no ranges to render")]
    Empty,
    #[error("range {0}: src_out ({1}) must be greater than src_in ({2})")]
    BadRange(usize, f64, f64),
    #[error("could not create output directory: {0}")]
    Io(#[from] std::io::Error),
    #[error("ffmpeg not on PATH (install via `brew install ffmpeg`)")]
    FfmpegMissing,
    #[error("ffmpeg failed: {0}")]
    FfmpegFailed(String),
}

/// Build the `filter_complex` graph for the supplied ranges.
///
/// Each range becomes:
///   `[input_idx:v]trim=start=A:end=B,setpts=PTS-STARTPTS,fps=30,format=yuv420p[vN];`
///   `[input_idx:a]atrim=start=A:end=B,asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0[aN];`
///
/// Then a single `concat` glues them all together.
///
/// The `fps=30` + `format=yuv420p` chain on each segment normalises
/// variable-frame-rate inputs so concat doesn't produce a stream
/// with non-monotonic timestamps (which WebKit refuses to play).
/// Likewise `aresample=async=1` keeps audio aligned across cuts.
fn build_filter(ranges: &[PreviewRange], source_indices: &[(String, usize)]) -> String {
    let lookup = |path: &str| -> usize {
        source_indices
            .iter()
            .find(|(p, _)| p == path)
            .map(|(_, i)| *i)
            .expect("source path was deduped before filter build")
    };

    let mut filter = String::new();
    for (i, r) in ranges.iter().enumerate() {
        let idx = lookup(&r.source_path);
        // Format f64 explicitly to avoid scientific notation that ffmpeg rejects.
        filter.push_str(&format!(
            "[{idx}:v]trim=start={a:.6}:end={b:.6},setpts=PTS-STARTPTS,fps=30,format=yuv420p[v{i}];",
            idx = idx,
            a = r.src_in_secs,
            b = r.src_out_secs,
            i = i,
        ));
        filter.push_str(&format!(
            "[{idx}:a]atrim=start={a:.6}:end={b:.6},asetpts=PTS-STARTPTS,aresample=async=1:first_pts=0[a{i}];",
            idx = idx,
            a = r.src_in_secs,
            b = r.src_out_secs,
            i = i,
        ));
    }
    let concat_inputs: String = (0..ranges.len())
        .map(|i| format!("[v{}][a{}]", i, i))
        .collect();
    filter.push_str(&format!(
        "{concat}concat=n={n}:v=1:a=1[outv][outa]",
        concat = concat_inputs,
        n = ranges.len(),
    ));
    filter
}

/// Dedupe source paths preserving first-seen order. Returns
/// `[(path, ffmpeg_input_index)]` and the unique path list.
fn dedupe_sources(ranges: &[PreviewRange]) -> (Vec<(String, usize)>, Vec<String>) {
    let mut indices: Vec<(String, usize)> = Vec::new();
    let mut unique: Vec<String> = Vec::new();
    for r in ranges {
        if !indices.iter().any(|(p, _)| p == &r.source_path) {
            let i = unique.len();
            unique.push(r.source_path.clone());
            indices.push((r.source_path.clone(), i));
        }
    }
    (indices, unique)
}

fn ensure_parent_dir(path: &Path) -> Result<(), std::io::Error> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

/// Run ffmpeg synchronously (in a blocking task on the caller).
fn run_ffmpeg(
    sources: &[String],
    filter: &str,
    output: &Path,
    max_edge: u32,
) -> Result<(), PreviewRenderError> {
    let mut cmd = Command::new("ffmpeg");
    cmd.arg("-y").arg("-hide_banner").arg("-loglevel").arg("warning");

    for src in sources {
        cmd.arg("-i").arg(src);
    }

    // Cap the long edge with a scale filter chained onto the concat output.
    let final_filter = format!(
        "{filter};[outv]scale=w='if(gt(iw,ih),min({m},iw),-2)':h='if(gt(iw,ih),-2,min({m},ih))'[finalv]",
        filter = filter,
        m = max_edge,
    );

    cmd.arg("-filter_complex").arg(&final_filter);
    cmd.arg("-map").arg("[finalv]");
    cmd.arg("-map").arg("[outa]");

    // Encoder settings — broadly WebKit-compatible.
    //
    // Previous attempts at `ultrafast + zerolatency` and `veryfast + high@4.0`
    // both produced streams WebKit refused (MEDIA_ERR_SRC_NOT_SUPPORTED).
    // The safest combo: `main` profile (no 8x8 transform, no CABAC quirks),
    // explicit GOP, constant frame rate output. The fps normalisation in
    // build_filter() already pinned each segment to 30fps before concat,
    // so the encoder just sees a clean CFR stream.
    cmd.arg("-c:v").arg("libx264");
    cmd.arg("-preset").arg("veryfast");
    cmd.arg("-profile:v").arg("main");
    cmd.arg("-level").arg("4.1");
    cmd.arg("-crf").arg("23");
    cmd.arg("-pix_fmt").arg("yuv420p");
    cmd.arg("-r").arg("30");
    cmd.arg("-g").arg("60");
    cmd.arg("-keyint_min").arg("60");
    cmd.arg("-sc_threshold").arg("0");
    cmd.arg("-fps_mode").arg("cfr");

    cmd.arg("-c:a").arg("aac");
    cmd.arg("-ar").arg("48000");
    cmd.arg("-b:a").arg("128k");
    cmd.arg("-ac").arg("2");

    // `+faststart` moves the MP4 moov atom to the front so the WebView
    // can begin playback before the full file is downloaded.
    cmd.arg("-movflags").arg("+faststart");
    cmd.arg(output);

    // Log the full argv so we can reproduce ffmpeg invocations from the
    // dev terminal when WebKit rejects the output.
    let argv_str: String = std::iter::once("ffmpeg".to_string())
        .chain(cmd.get_args().map(|a| {
            let s = a.to_string_lossy();
            if s.contains(' ') || s.contains('[') || s.contains(';') {
                format!("'{}'", s)
            } else {
                s.into_owned()
            }
        }))
        .collect::<Vec<_>>()
        .join(" ");
    eprintln!(
        "[sift] preview_render: ffmpeg sources={} filter_len={} max_edge={} → {}",
        sources.len(),
        final_filter.len(),
        max_edge,
        output.display(),
    );
    eprintln!("[sift] preview_render: argv: {}", argv_str);
    let started = std::time::Instant::now();

    let out = cmd
        .output()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => PreviewRenderError::FfmpegMissing,
            _ => PreviewRenderError::FfmpegFailed(e.to_string()),
        })?;

    let elapsed = started.elapsed();
    eprintln!(
        "[sift] preview_render: ffmpeg done in {:.2}s (exit {})",
        elapsed.as_secs_f64(),
        out.status.code().unwrap_or(-1),
    );

    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_string();
        // Full stderr to the dev terminal for diagnosis.
        eprintln!(
            "[sift] preview_render: ffmpeg FAILED (exit {})\n--- ffmpeg stderr ---\n{}\n--- end stderr ---",
            out.status.code().unwrap_or(-1),
            stderr.trim_end(),
        );
        let tail: String = stderr
            .lines()
            .rev()
            .take(20)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        return Err(PreviewRenderError::FfmpegFailed(format!(
            "exit {}: {}",
            out.status.code().unwrap_or(-1),
            tail
        )));
    }
    Ok(())
}

/// Synchronous implementation. The Tauri command wrapper below runs
/// this on a blocking thread so the IPC loop stays responsive.
pub fn render_preview_blocking(
    ranges: Vec<PreviewRange>,
    output_path: PathBuf,
    max_edge: u32,
) -> Result<PreviewRenderResult, PreviewRenderError> {
    if ranges.is_empty() {
        return Err(PreviewRenderError::Empty);
    }
    for (i, r) in ranges.iter().enumerate() {
        if !(r.src_out_secs > r.src_in_secs) {
            return Err(PreviewRenderError::BadRange(i, r.src_out_secs, r.src_in_secs));
        }
    }

    ensure_parent_dir(&output_path)?;

    let (indices, unique) = dedupe_sources(&ranges);
    let filter = build_filter(&ranges, &indices);
    run_ffmpeg(&unique, &filter, &output_path, max_edge)?;

    let duration_secs = ranges
        .iter()
        .map(|r| r.src_out_secs - r.src_in_secs)
        .sum::<f64>();

    Ok(PreviewRenderResult {
        output_path: output_path.to_string_lossy().to_string(),
        duration_secs,
        range_count: ranges.len(),
    })
}

#[tauri::command]
pub async fn preview_render_flatten(
    ranges: Vec<PreviewRange>,
    output_path: String,
    max_edge: Option<u32>,
) -> Result<PreviewRenderResult, String> {
    let output_path = PathBuf::from(output_path);
    let max_edge = max_edge.unwrap_or(1280).clamp(240, 4096);
    tokio::task::spawn_blocking(move || render_preview_blocking(ranges, output_path, max_edge))
        .await
        .map_err(|e| format!("join error: {e}"))?
        .map_err(|e| e.to_string())
}
