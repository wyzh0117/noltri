//! Raw macOS Accessibility / CoreFoundation bindings.
//!
//! Attribute names such as `kAXSelectedTextAttribute` are `CFSTR(...)` **macros** in the SDK
//! headers (`HIServices/AXAttributeConstants.h`), not linker symbols, so they are declared here
//! as plain string literals. The *functions* are real symbols exported by the
//! `ApplicationServices` umbrella framework (verified against the macOS SDK `.tbd`), and the
//! `kAXValue*Type` discriminators are `static const UInt32` in `AXValue.h`, so they are inlined
//! as integers too. Nothing in this module is safe to call: see [`super::owned`] for the memory
//! rules and [`super::ax`] for the fallible wrappers.

use core::ffi::{c_char, c_void};
use core_foundation_sys::base::{Boolean, CFIndex, CFTypeRef};

/// `AXError` is a signed 32-bit enum (`AXError.h`).
pub type AxError = i32;

pub const AX_ERROR_SUCCESS: AxError = 0;
pub const AX_ERROR_ILLEGAL_ARGUMENT: AxError = -25201;
pub const AX_ERROR_INVALID_UI_ELEMENT: AxError = -25202;
pub const AX_ERROR_CANNOT_COMPLETE: AxError = -25204;
pub const AX_ERROR_ATTRIBUTE_UNSUPPORTED: AxError = -25205;
pub const AX_ERROR_NOT_IMPLEMENTED: AxError = -25208;
pub const AX_ERROR_APIDISABLED: AxError = -25211;
pub const AX_ERROR_NO_VALUE: AxError = -25212;
pub const AX_ERROR_PARAMETERIZED_ATTRIBUTE_UNSUPPORTED: AxError = -25213;

/// `AXValueType` discriminators (`AXValue.h`): 1 = CGPoint, 2 = CGSize, 3 = CGRect, 4 = CFRange.
pub const AX_VALUE_TYPE_CGPOINT: u32 = 1;
pub const AX_VALUE_TYPE_CGSIZE: u32 = 2;
pub const AX_VALUE_TYPE_CGRECT: u32 = 3;
pub const AX_VALUE_TYPE_CF_RANGE: u32 = 4;

/// `AXUIElementRef`, `AXValueRef`, `CFStringRef` … are all opaque CF pointers as far as Rust is
/// concerned; keeping one alias makes the wrappers readable.
pub type AxOpaque = *const c_void;

/// `pid_t` on macOS is `int32_t`.
pub type Pid = i32;

/// Attribute names, exactly as `CFSTR(...)` in the SDK headers.
pub mod attr {
    pub const FOCUSED_APPLICATION: &str = "AXFocusedApplication";
    pub const FOCUSED_UI_ELEMENT: &str = "AXFocusedUIElement";
    pub const SELECTED_TEXT: &str = "AXSelectedText";
    pub const SELECTED_TEXT_RANGE: &str = "AXSelectedTextRange";
    pub const SELECTED_TEXT_UI_ELEMENTS: &str = "AXSelectedTextUIElements";
    pub const POSITION: &str = "AXPosition";
    pub const SIZE: &str = "AXSize";
    pub const TITLE: &str = "AXTitle";
    pub const ROLE: &str = "AXRole";
    pub const WINDOWS: &str = "AXWindows";
    pub const MAIN_WINDOW: &str = "AXMainWindow";
    pub const FOCUSED_WINDOW: &str = "AXFocusedWindow";
    /// Parameterized attribute: bounds of a `CFRange` inside a text element.
    pub const BOUNDS_FOR_RANGE: &str = "AXBoundsForRange";
}

/// `CGPoint` / `CGSize` / `CFRange` layouts the AX value accessors memcpy in and out of.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct AxPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct AxSize {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct AxRange {
    pub location: i64,
    pub length: i64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
#[repr(C)]
pub struct AxRect {
    pub origin: AxPoint,
    pub size: AxSize,
}

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    pub fn AXIsProcessTrusted() -> Boolean;
    pub fn AXIsProcessTrustedWithOptions(options: AxOpaque) -> Boolean;
    pub fn AXUIElementCreateSystemWide() -> AxOpaque;
    pub fn AXUIElementCreateApplication(pid: Pid) -> AxOpaque;
    /// `value` is `CF_RETURNS_RETAINED`: the caller owns it and must release it.
    pub fn AXUIElementCopyAttributeValue(element: AxOpaque, attribute: AxOpaque, value: *mut CFTypeRef) -> AxError;
    /// `names` is `CF_RETURNS_RETAINED` (`CFArrayRef` of `CFStringRef`).
    pub fn AXUIElementCopyAttributeNames(element: AxOpaque, names: *mut CFTypeRef) -> AxError;
    /// `result` is `CF_RETURNS_RETAINED`.
    pub fn AXUIElementCopyParameterizedAttributeValue(
        element: AxOpaque,
        attribute: AxOpaque,
        parameter: CFTypeRef,
        result: *mut CFTypeRef,
    ) -> AxError;
    pub fn AXUIElementGetPid(element: AxOpaque, pid: *mut Pid) -> AxError;
    /// Which structure an `AXValueRef` wraps, so the right accessor can be chosen.
    pub fn AXValueGetType(value: AxOpaque) -> u32;
    /// Decodes an `AXValueRef` into the structure `type` names. Returns false on type mismatch.
    pub fn AXValueGetValue(value: AxOpaque, value_type: u32, out: *mut c_void) -> Boolean;
    /// Wraps a structure into an `AXValueRef` (`+1` create rule, may return null).
    pub fn AXValueCreate(value_type: u32, value: *const c_void) -> AxOpaque;
}

/// Convenience: `Boolean` is `unsigned char`, true is 1.
#[inline]
pub fn is_true(value: Boolean) -> bool {
    value != 0
}

/// `CFStringGetLength` counts UTF-16 units; the encoding helper below needs a `CFIndex`.
#[inline]
pub fn as_cf_index(value: usize) -> CFIndex {
    value.min(isize::MAX as usize) as CFIndex
}

/// Marker so the C string type stays referenced in one place.
pub type RawChar = c_char;
