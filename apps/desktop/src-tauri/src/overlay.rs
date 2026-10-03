//! Floating windows: the 「归纳知识点」 pill and the mini paste window.
//!
//! The pill is the desktop twin of the extension's floating button (V1 §10.2): light, never
//! steals keyboard focus, closes on ESC, anchored next to the selection (V1 §2.2
//! 「在选区 / 光标附近」). macOS hands us *points* (y-down from the top-left of the display grid)
//! while tao positions windows in *physical pixels*, so every placement converts through the
//! window's own scale factor and clamps against its current monitor.

use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, Position, Size, WebviewWindow, WebviewUrl, WebviewWindowBuilder};

use crate::settings::OverlayPositionMode;
use crate::state::Sample;

pub const OVERLAY_LABEL: &str = "overlay";
pub const PASTE_LABEL: &str = "paste";

/// Logical size of the pill; tall enough for 「✓ 已收纳」 plus a two-line tree path (V1 §10.5).
const PILL_WIDTH: f64 = 300.0;
const PILL_HEIGHT: f64 = 132.0;
/// Distance between the selection box and the pill.
const GAP: f64 = 10.0;
/// Above this height the rect is really a text *area* — the estimated fallback of V1 §11.1 — so
/// anchor to its top-left instead of dropping the pill a screen below it.
pub const ESTIMATED_AREA_HEIGHT: f64 = 240.0;

pub fn show_pill(app: &AppHandle, sample: &Sample, mode: OverlayPositionMode) {
    let Some(window) = app.get_webview_window(OVERLAY_LABEL) else {
        eprintln!("[noltri] overlay 窗口不存在，无法显示浮层");
        return;
    };
    place(&window, sample, mode);
    // `show()` without `set_focus()`: the pill must not take the caret away from the target app.
    if let Err(error) = window.show() {
        eprintln!("[noltri] overlay 显示失败: {error}");
    }
}

fn place(window: &WebviewWindow, sample: &Sample, mode: OverlayPositionMode) {
    let rect = sample.rect;
    let scale = window.scale_factor().unwrap_or(2.0).max(1.0);
    let pill_w = PILL_WIDTH * scale;
    let pill_h = PILL_HEIGHT * scale;
    if let Err(error) = window.set_size(Size::Physical(PhysicalSize::new(
        pill_w.round().max(1.0) as u32,
        pill_h.round().max(1.0) as u32,
    ))) {
        eprintln!("[noltri] overlay 尺寸设置失败: {error}");
    }

    let Some(rect) = rect.filter(|rect| rect.width > 0.0 && rect.height > 0.0) else {
        // No usable geometry: centre it and let the user decide.
        let _ = window.center();
        return;
    };
    if mode == OverlayPositionMode::Center {
        let _ = window.center();
        return;
    }

    // An *estimated* box is the whole text area, so hanging the pill below it would put the pill
    // far away from the selection; anchor it to the area's top-left instead.
    let anchor_y =
        if sample.estimated || rect.height > ESTIMATED_AREA_HEIGHT {
            rect.y
        } else {
            rect.y + rect.height
        };
    let anchor_x = if mode == OverlayPositionMode::Caret {
        rect.x + rect.width.min(24.0)
    } else {
        rect.x
    };

    let mut x = anchor_x * scale;
    let mut y = (anchor_y + GAP) * scale;

    if let Ok(Some(monitor)) = window.current_monitor() {
        let origin = monitor.position();
        let size = monitor.size();
        let left = origin.x as f64;
        let top = origin.y as f64;
        let right = left + size.width as f64;
        let bottom = top + size.height as f64;
        // Flip above the selection when it would hang off the bottom edge.
        if y + pill_h > bottom {
            y = (rect.y - GAP - pill_h).max(top);
        }
        x = x.clamp(left, (right - pill_w).max(left));
        y = y.clamp(top, (bottom - pill_h).max(top));
    }

    if let Err(error) = window.set_position(Position::Physical(PhysicalPosition::new(
        x.round() as i32,
        y.round() as i32,
    ))) {
        eprintln!("[noltri] overlay 位置设置失败: {error}");
    }
}

/// Second-level fallback (V1 §11.4): a small window the user can paste into.
pub fn open_paste(app: &AppHandle) {
    let Some(window) = app.get_webview_window(PASTE_LABEL) else {
        eprintln!("[noltri] paste 窗口不存在");
        return;
    };
    if let Err(error) = window.show() {
        eprintln!("[noltri] paste 显示失败: {error}");
    }
    if let Err(error) = window.set_focus() {
        eprintln!("[noltri] paste 获取焦点失败: {error}");
    }
}

pub fn hide_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        if let Err(error) = window.hide() {
            eprintln!("[noltri] {label} 隐藏失败: {error}");
        }
    }
}

/// Built once during setup and only shown/hidden afterwards: creating a window from a synchronous
/// command is the path that can hang, and a hidden window costs nothing.
pub fn create_paste_window(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(PASTE_LABEL).is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, PASTE_LABEL, WebviewUrl::App("paste.html".into()))
        .title("知序 · 粘贴收纳")
        .inner_size(460.0, 320.0)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .always_on_top(true)
        .visible(false)
        .center()
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}
