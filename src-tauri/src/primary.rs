//! X11 PRIMARY selection bridge, plus the cross-platform CLIPBOARD half.
//!
//! WebKitGTK does not reliably wire middle-click paste into editable webview
//! content, so the frontend intercepts `mousedown` with `button === 1` and asks
//! us for the current PRIMARY selection instead.
//!
//! PRIMARY is an X11 concept and arboard exposes it only through Linux-only
//! extension traits, so the two PRIMARY commands are cfg'd. Elsewhere they are
//! present but inert: the frontend calls them unconditionally, and "nothing owns
//! PRIMARY" is already a state it handles. The CLIPBOARD commands below are
//! plain arboard and work on every platform.

use arboard::Clipboard;
#[cfg(target_os = "linux")]
use arboard::{GetExtLinux, LinuxClipboardKind, SetExtLinux};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

/// Read the X11 PRIMARY selection (the "highlight buffer").
///
/// Returns an empty string when nothing owns PRIMARY or it holds non-text data,
/// so the frontend can treat "no selection" as a no-op rather than an error.
///
/// `async`: reading a selection is a round-trip to whichever client owns it, and
/// arboard gives that client up to `LONG_TIMEOUT_DUR` (4s on X11) to answer. The
/// frontend asks on middle-mousedown, so on the main thread one unresponsive
/// selection owner freezes the window mid-click.
#[cfg(target_os = "linux")]
#[tauri::command(async)]
pub fn primary_get() -> Result<String, String> {
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    match clipboard
        .get()
        .clipboard(LinuxClipboardKind::Primary)
        .text()
    {
        Ok(text) => Ok(text),
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// No PRIMARY selection off X11, so there is never anything to hand back.
#[cfg(not(target_os = "linux"))]
#[tauri::command(async)]
pub fn primary_get() -> Result<String, String> {
    Ok(String::new())
}

/// Take ownership of PRIMARY with `text`.
///
/// X11 selection ownership lives with the owning process, so the `wait()` call
/// blocks until some other client claims PRIMARY. It runs on a detached thread
/// that exits on its own once ownership is lost.
///
/// The claim is skipped when PRIMARY already holds `text`. Claiming makes X send
/// `SelectionClear` to the previous owner, and WebKitGTK answers that by wiping
/// the webview's visible highlight — so publishing a web-content selection that
/// WebKitGTK had itself just published un-highlighted it the moment it settled.
///
/// Returns whether a claim was actually issued, so the frontend only bothers
/// repairing a highlight when something could have cleared it. `async` because
/// the read is a selection round-trip and must not run on the main thread; the
/// claim itself still gets a detached thread, since `wait()` never returns while
/// we hold the selection.
#[cfg(target_os = "linux")]
#[tauri::command(async)]
pub fn primary_set(text: String) -> Result<bool, String> {
    if let Ok(mut clipboard) = Clipboard::new() {
        let current = clipboard
            .get()
            .clipboard(LinuxClipboardKind::Primary)
            .text()
            .unwrap_or_default();
        if current == text {
            return Ok(false);
        }
    }
    std::thread::spawn(move || {
        if let Ok(mut clipboard) = Clipboard::new() {
            let _ = clipboard
                .set()
                .clipboard(LinuxClipboardKind::Primary)
                .wait()
                .text(text);
        }
    });
    Ok(true)
}

/// Nothing to claim off X11. `false` tells the frontend no `SelectionClear` went
/// out, so it skips the highlight repair that claim would have needed.
#[cfg(not(target_os = "linux"))]
#[tauri::command(async)]
pub fn primary_set(_text: String) -> Result<bool, String> {
    Ok(false)
}

/// Read the regular CLIPBOARD selection (Ctrl+V buffer).
///
/// `async` for the same reason as `primary_get`: an X11 selection round-trip can
/// block for seconds on an unresponsive owner.
#[tauri::command(async)]
pub fn clipboard_get() -> Result<String, String> {
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    match clipboard.get_text() {
        Ok(text) => Ok(text),
        Err(arboard::Error::ContentNotAvailable) => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

/// Write the regular CLIPBOARD selection.
///
/// `async`: taking ownership still talks to the X server, and arboard's own
/// clipboard-manager handshake can block just like a read.
#[tauri::command(async)]
pub fn clipboard_set(text: String) -> Result<(), String> {
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    clipboard.set_text(text).map_err(|e| e.to_string())
}


/// An image lifted off the system clipboard, ready to send as a content block.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardImage {
    /// Always `image/png`: arboard hands back raw RGBA, which we re-encode.
    pub media_type: String,
    /// Base64 PNG, sized for a stream-json `image` block.
    pub data: String,
    pub width: u32,
    pub height: u32,
}

/// Longest edge kept when re-encoding. Full-resolution screenshots are megabytes
/// of base64, and the model does not need more than this to read a screen.
const MAX_EDGE: u32 = 1568;

/// Read an image from the CLIPBOARD selection, if it holds one.
///
/// Returns `None` when the clipboard holds text or nothing, so the frontend can
/// fall through to an ordinary paste rather than treating it as an error.
///
/// `async`: resize + PNG encode + base64 of a full-resolution screenshot takes
/// long enough to freeze the UI if run on the main thread.
#[tauri::command(async)]
pub fn clipboard_image() -> Result<Option<ClipboardImage>, String> {
    let mut clipboard = Clipboard::new().map_err(|e| e.to_string())?;
    let image = match clipboard.get_image() {
        Ok(image) => image,
        Err(arboard::Error::ContentNotAvailable) => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };

    let width = image.width as u32;
    let height = image.height as u32;
    let buffer =
        image::RgbaImage::from_raw(width, height, image.bytes.into_owned())
            .ok_or("clipboard image had an unexpected buffer size")?;

    // Downscale before encoding: cheaper to encode and far cheaper to send.
    let scaled = if width.max(height) > MAX_EDGE {
        let ratio = MAX_EDGE as f32 / width.max(height) as f32;
        image::imageops::resize(
            &buffer,
            (width as f32 * ratio).round() as u32,
            (height as f32 * ratio).round() as u32,
            image::imageops::FilterType::Triangle,
        )
    } else {
        buffer
    };

    let (out_width, out_height) = (scaled.width(), scaled.height());
    let mut png = std::io::Cursor::new(Vec::new());
    image::DynamicImage::ImageRgba8(scaled)
        .write_to(&mut png, image::ImageFormat::Png)
        .map_err(|e| format!("could not encode clipboard image: {e}"))?;

    Ok(Some(ClipboardImage {
        media_type: "image/png".to_string(),
        data: BASE64.encode(png.into_inner()),
        width: out_width,
        height: out_height,
    }))
}
