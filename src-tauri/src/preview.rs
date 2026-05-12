//! FFmpeg CPU decode → RGBA → PNG for the webview preview (milestone D).
//!
//! Requires system FFmpeg visible to `pkg-config`.
//! macOS: `brew install ffmpeg pkg-config`.

use std::path::Path;
use std::sync::OnceLock;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use ffmpeg_next::{
    codec,
    format,
    frame,
    media::Type,
    software::scaling::{context::Context as ScalerContext, flag::Flags as ScalerFlags},
    util::format::pixel::Pixel,
    Error as FfmpegError,
};
use ffmpeg_next::error::EAGAIN;
use image::codecs::png::PngEncoder;
use image::{ExtendedColorType, ImageEncoder};
use serde::Serialize;

static FFMPEG_INIT: OnceLock<Result<(), String>> = OnceLock::new();

fn ensure_ffmpeg_init() -> Result<(), PreviewError> {
    match FFMPEG_INIT.get_or_init(|| ffmpeg_next::init().map_err(|e| e.to_string())) {
        Ok(()) => Ok(()),
        Err(msg) => Err(PreviewError::FfmpegInit(msg.clone())),
    }
}

/// Demuxer duration when known (`AVFormatContext.duration` in microseconds).
const AV_TIME_BASE: f64 = 1_000_000.0;

#[derive(Debug, thiserror::Error)]
pub enum PreviewError {
    #[error("FFmpeg failed to initialize: {0}")]
    FfmpegInit(String),
    #[error("no video stream in {0}")]
    NoVideoStream(String),
    #[error("could not decode a video frame (try another time or file)")]
    NoFrame,
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Ffmpeg(#[from] FfmpegError),
    #[error("{0}")]
    Image(#[from] image::ImageError),
}

#[derive(Debug, Serialize)]
pub struct PreviewPngPayload {
    pub width: u32,
    pub height: u32,
    pub duration_seconds: Option<f64>,
    pub png_base64: String,
}

/// Cheap container probe (no decode): duration + coded dimensions from metadata.
#[derive(Debug, Serialize)]
pub struct PreviewProbePayload {
    pub duration_seconds: Option<f64>,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

pub fn decode_preview_probe(path: &Path) -> Result<PreviewProbePayload, PreviewError> {
    ensure_ffmpeg_init()?;

    let path_str = path
        .to_str()
        .ok_or_else(|| PreviewError::NoVideoStream(path.display().to_string()))?;

    let ictx = format::input(path_str)?;
    let duration_seconds = format_duration_secs(&ictx);

    let mut width = None;
    let mut height = None;
    if let Some(st) = ictx.streams().best(Type::Video) {
        if let Ok(dec) = codec::Context::from_parameters(st.parameters())
            .and_then(|cx| cx.decoder().video())
        {
            width = Some(dec.width());
            height = Some(dec.height());
        }
    }

    Ok(PreviewProbePayload {
        duration_seconds,
        width,
        height,
    })
}

fn format_duration_secs(ictx: &format::context::Input) -> Option<f64> {
    let d = ictx.duration();
    if d <= 0 {
        None
    } else {
        Some(d as f64 / AV_TIME_BASE)
    }
}

fn decode_dimensions(decoded: &frame::Video, max_edge: u32) -> (u32, u32) {
    decode_dimensions_wh(decoded.width(), decoded.height(), max_edge)
}

fn decode_dimensions_wh(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    if width == 0 || height == 0 {
        return (1, 1);
    }
    let max_dim = width.max(height);
    if max_dim <= max_edge {
        return (width, height);
    }
    let scale = max_edge as f64 / max_dim as f64;
    let dw = ((width as f64) * scale).round().max(1.0) as u32;
    let dh = ((height as f64) * scale).round().max(1.0) as u32;
    (dw, dh)
}

fn scale_to_rgba(src: &frame::Video, scaler: &mut ScalerContext) -> Result<Vec<u8>, PreviewError> {
    let mut dst = frame::Video::empty();
    scaler.run(src, &mut dst)?;

    let w = dst.width() as usize;
    let h = dst.height() as usize;
    let stride = dst.stride(0);
    let row_bytes = w * 4;
    if stride < row_bytes {
        return Err(PreviewError::Ffmpeg(FfmpegError::InvalidData));
    }

    let data = dst.data(0);
    let mut pixels = Vec::with_capacity(w * h * 4);
    for row in 0..h {
        let start = row * stride;
        pixels.extend_from_slice(&data[start..start + row_bytes]);
    }
    Ok(pixels)
}

pub(crate) fn rgba_to_png_bytes(width: u32, height: u32, rgba: &[u8]) -> Result<Vec<u8>, PreviewError> {
    let mut out = Vec::new();
    let enc = PngEncoder::new(&mut out);
    enc.write_image(rgba, width, height, ExtendedColorType::Rgba8)?;
    Ok(out)
}

fn pack_decoded_frame(
    decoded: &frame::Video,
    max_edge: u32,
    duration_secs: Option<f64>,
) -> Result<PreviewPngPayload, PreviewError> {
    let (dst_w, dst_h) = decode_dimensions(decoded, max_edge);
    let mut scaler = ScalerContext::get(
        decoded.format(),
        decoded.width(),
        decoded.height(),
        Pixel::RGBA,
        dst_w,
        dst_h,
        ScalerFlags::BILINEAR,
    )?;
    let rgba = scale_to_rgba(decoded, &mut scaler)?;
    let png = rgba_to_png_bytes(dst_w, dst_h, &rgba)?;
    Ok(PreviewPngPayload {
        width: dst_w,
        height: dst_h,
        duration_seconds: duration_secs,
        png_base64: STANDARD.encode(&png),
    })
}

/// Decode one frame near `seek_seconds`, scale so longest edge ≤ `max_edge`, encode PNG.
pub fn decode_preview_png(
    path: &Path,
    seek_seconds: f64,
    max_edge: u32,
) -> Result<PreviewPngPayload, PreviewError> {
    ensure_ffmpeg_init()?;

    let path_str = path
        .to_str()
        .ok_or_else(|| PreviewError::NoVideoStream(path.display().to_string()))?;

    let mut ictx = format::input(path_str)?;
    let duration_secs = format_duration_secs(&ictx);

    let stream_index = ictx
        .streams()
        .best(Type::Video)
        .map(|s| s.index())
        .ok_or_else(|| PreviewError::NoVideoStream(path.display().to_string()))?;
    let seek_secs = seek_seconds
        .max(0.0)
        .min(duration_secs.unwrap_or(f64::MAX));

    let ts = (seek_secs * AV_TIME_BASE).round() as i64;
    let pad = (5.0 * AV_TIME_BASE) as i64;
    let range = ts.saturating_sub(pad)..ts.saturating_add(pad);
    ictx.seek(ts, range)?;

    let stream = ictx
        .stream(stream_index)
        .ok_or_else(|| PreviewError::NoVideoStream(path.display().to_string()))?;
    let codec_params = stream.parameters();
    let mut decoder = codec::Context::from_parameters(codec_params)?
        .decoder()
        .video()?;
    decoder.flush();

    let mut decoded = frame::Video::empty();

    for (_, packet) in ictx.packets() {
        if packet.stream() != stream_index {
            continue;
        }
        decoder.send_packet(&packet)?;
        match decoder.receive_frame(&mut decoded) {
            Ok(()) => return pack_decoded_frame(&decoded, max_edge, duration_secs),
            Err(FfmpegError::Other { errno }) if errno == EAGAIN => {}
            Err(FfmpegError::Eof) => {}
            Err(e) => return Err(e.into()),
        }
    }

    decoder.send_eof()?;
    match decoder.receive_frame(&mut decoded) {
        Ok(()) => return pack_decoded_frame(&decoded, max_edge, duration_secs),
        Err(FfmpegError::Other { errno }) if errno == EAGAIN => {}
        Err(FfmpegError::Eof) => {}
        Err(e) => return Err(e.into()),
    }

    Err(PreviewError::NoFrame)
}

#[tauri::command]
pub async fn preview_frame_png(
    path: String,
    seek_seconds: f64,
    max_edge: Option<u32>,
) -> Result<PreviewPngPayload, String> {
    let path = std::path::PathBuf::from(path);
    let max_edge = max_edge.unwrap_or(1280).clamp(64, 8192);
    tokio::task::spawn_blocking(move || decode_preview_png(&path, seek_seconds, max_edge))
        .await
        .map_err(|e| format!("preview join error: {e}"))?
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn preview_probe(path: String) -> Result<PreviewProbePayload, String> {
    let path = std::path::PathBuf::from(path);
    tokio::task::spawn_blocking(move || decode_preview_probe(&path))
        .await
        .map_err(|e| format!("preview probe join error: {e}"))?
        .map_err(|e| e.to_string())
}
