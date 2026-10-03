//! macOS Accessibility bridge: raw `extern "C"` declarations, CF-aware ownership wrappers, the
//! focused-element → selected-text walk, and the polling observer thread.
//!
//! Layout:
//! - [`ffi`] — the only `unsafe extern` block in the app, plus the `AX*` constants.
//! - [`owned`] — Drop guards so every `CFTypeRef` handed back by CoreFoundation is released once.
//! - [`app_kit`] — the two Objective-C messages needed to name the frontmost app.
//! - [`ax`] — the actual reads (`AXIsProcessTrusted`, selected text, selection bounds).
//! - [`observer`] — the 600 ms polling loop that turns a read into a gated `selection-changed`.

pub mod app_kit;
pub mod ax;
pub mod ffi;
pub mod observer;
pub mod owned;
