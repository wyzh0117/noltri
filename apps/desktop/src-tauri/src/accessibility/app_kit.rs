//! Frontmost-application lookup through `NSWorkspace`.
//!
//! Accessibility exposes no bundle identifier, yet the per-app opt-out list and the
//! 「不完全兼容」 list (V1 §11.4 level three) need a stable app identity, so the two AppKit
//! messages we need are sent through the Objective-C runtime directly rather than pulling another
//! crate into the tree. Every returned object is autoreleased, so the whole call runs inside an
//! explicit autorelease pool: the observer thread is a plain `std::thread` with no pool of its
//! own, and without this the app would leak objects ~1.5 times per second forever.

use core::ffi::{c_char, c_void};
use std::ffi::CStr;

use super::ffi::Pid;

#[link(name = "objc")]
extern "C" {
    fn objc_getClass(name: *const c_char) -> *const c_void;
    fn sel_registerName(name: *const c_char) -> *const c_void;
    fn objc_autoreleasePoolPush() -> *mut c_void;
    fn objc_autoreleasePoolPop(token: *mut c_void);
    #[link_name = "objc_msgSend"]
    fn send_id(receiver: *const c_void, selector: *const c_void) -> *const c_void;
    #[link_name = "objc_msgSend"]
    fn send_pid(receiver: *const c_void, selector: *const c_void) -> Pid;
    #[link_name = "objc_msgSend"]
    fn send_cstr(receiver: *const c_void, selector: *const c_void) -> *const c_char;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AppInfo {
    pub name: String,
    pub bundle_id: Option<String>,
    pub pid: Pid,
}

/// An explicit `@autoreleasepool`, pushed and popped by the same value so nesting is exact.
struct Pool {
    token: *mut c_void,
}

impl Pool {
    fn new() -> Self {
        // SAFETY: push/pop are balanced by the Drop impl below, in the same scope.
        let token = unsafe { objc_autoreleasePoolPush() };
        Self { token }
    }
}

impl Drop for Pool {
    fn drop(&mut self) {
        // SAFETY: `token` is the handle returned by the matching push.
        unsafe { objc_autoreleasePoolPop(self.token) };
    }
}

fn class(name: &str) -> Option<*const c_void> {
    let c_name = to_cstring(name)?;
    // SAFETY: objc_getClass accepts a C string and may legitimately return null.
    let raw = unsafe { objc_getClass(c_name.as_ptr()) };
    if raw.is_null() {
        None
    } else {
        Some(raw)
    }
}

fn selector(name: &str) -> Option<*const c_void> {
    let c_name = to_cstring(name)?;
    let raw = unsafe { sel_registerName(c_name.as_ptr()) };
    if raw.is_null() {
        None
    } else {
        Some(raw)
    }
}

fn to_cstring(value: &str) -> Option<std::ffi::CString> {
    // Interior nul bytes would silently truncate the name; treat them as "no selector".
    if value.bytes().any(|byte| byte == 0) {
        return None;
    }
    std::ffi::CString::new(value).ok()
}

unsafe fn message_string(receiver: *const c_void, selector_name: &str) -> Option<String> {
    if receiver.is_null() {
        return None;
    }
    let sel = selector(selector_name)?;
    let object = send_id(receiver, sel);
    if object.is_null() {
        return None;
    }
    let utf8_selector = selector("UTF8String")?;
    let pointer = send_cstr(object, utf8_selector);
    if pointer.is_null() {
        return None;
    }
    let text = CStr::from_ptr(pointer).to_string_lossy().into_owned();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

/// The application the user is typing in right now. `None` when AppKit cannot answer (rare:
/// headless session, class unavailable) — callers must then fall back to the AX element itself.
pub fn frontmost_app() -> Option<AppInfo> {
    let _pool = Pool::new();
    let workspace_class = class("NSWorkspace")?;
    let shared_selector = selector("sharedWorkspace")?;
    // SAFETY: all messages below are the documented, zero-argument selectors of NSWorkspace and
    // NSRunningApplication; every pointer is null-checked before use.
    let workspace = unsafe { send_id(workspace_class, shared_selector) };
    if workspace.is_null() {
        return None;
    }
    let frontmost_selector = selector("frontmostApplication")?;
    let app = unsafe { send_id(workspace, frontmost_selector) };
    if app.is_null() {
        return None;
    }
    let name = unsafe { message_string(app, "localizedName") };
    let bundle_id = unsafe { message_string(app, "bundleIdentifier") };
    let pid_selector = selector("processIdentifier")?;
    let pid = unsafe { send_pid(app, pid_selector) };
    let name = name.or_else(|| bundle_id.clone()).unwrap_or_default();
    if name.is_empty() && pid <= 0 {
        return None;
    }
    Some(AppInfo {
        name,
        bundle_id,
        pid,
    })
}
