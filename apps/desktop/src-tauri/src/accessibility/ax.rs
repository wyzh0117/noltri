//! Accessibility reads: focused application → focused UI element → selected text.
//!
//! Every entry point here returns `Option`/`Result`. An AX call is synchronous cross-process IPC
//! into a program that may be hung, sandboxed, or simply not implement the attribute, and a panic
//! in this module would take the whole companion (and its Setup Manager) down with it.
//!
//! V1 §11.3: this is one generic implementation. There is no Codex / Qoder / Hermes / DSH branch
//! anywhere in here — if the frontmost app exposes `AXSelectedText`, it works; if it does not, the
//! observer records it as 「不完全兼容」 and the fallback ladder (V1 §11.4) takes over.

use core::ptr;

use core_foundation::base::TCFType;
use core_foundation::boolean::CFBoolean;
use core_foundation::dictionary::CFDictionary;
use core_foundation::string::CFString;
use core_foundation_sys::base::CFTypeRef;

use super::app_kit::{self, AppInfo};
use super::ffi::{
    attr, AxError, AxOpaque, AxPoint, AxRange, AxSize, Pid, AX_ERROR_APIDISABLED,
    AX_ERROR_ATTRIBUTE_UNSUPPORTED, AX_ERROR_CANNOT_COMPLETE, AX_ERROR_INVALID_UI_ELEMENT,
    AX_ERROR_NO_VALUE, AX_ERROR_NOT_IMPLEMENTED, AX_ERROR_SUCCESS, AX_VALUE_TYPE_CGPOINT,
    AX_VALUE_TYPE_CGSIZE,
};
use super::ffi::{
    AXIsProcessTrusted, AXIsProcessTrustedWithOptions, AXUIElementCopyAttributeValue,
    AXUIElementCopyAttributeNames, AXUIElementCopyParameterizedAttributeValue,
    AXUIElementCreateApplication, AXUIElementCreateSystemWide, AXUIElementGetPid,
};
use super::owned::{Element, Owned, Value};

/// Why a selection read did not produce text. `AttributeUnsupported` is the only variant that
/// justifies recording an app as 「不完全兼容」; everything else is transient.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadFailure {
    /// Accessibility permission has not been granted to this process yet.
    PermissionDisabled,
    /// No application currently owns the AX focus.
    NoFocusedApplication,
    /// The application has no focused element (nothing is in a text field).
    NoFocusedElement,
    /// The element does not implement `AXSelectedText` at all.
    AttributeUnsupported,
    /// The attribute exists but returned nothing usable.
    NoValue,
    /// The target process did not answer in time, or its element went stale.
    CannotComplete,
    /// Anything else; carries the raw `AXError`.
    Other(AxError),
}

impl ReadFailure {
    pub fn from_ax_error(error: AxError) -> Self {
        match error {
            AX_ERROR_APIDISABLED => Self::PermissionDisabled,
            AX_ERROR_INVALID_UI_ELEMENT | AX_ERROR_CANNOT_COMPLETE => Self::CannotComplete,
            AX_ERROR_ATTRIBUTE_UNSUPPORTED | AX_ERROR_NOT_IMPLEMENTED => Self::AttributeUnsupported,
            AX_ERROR_NO_VALUE => Self::NoValue,
            other => Self::Other(other),
        }
    }

    /// Stable label for the Setup Manager and the persisted 「不完全兼容」 list.
    pub fn label(&self) -> &'static str {
        match self {
            Self::PermissionDisabled => "permission-disabled",
            Self::NoFocusedApplication => "no-focused-application",
            Self::NoFocusedElement => "no-focused-element",
            Self::AttributeUnsupported => "selected-text-unsupported",
            Self::NoValue => "no-value",
            Self::CannotComplete => "cannot-complete",
            Self::Other(_) => "unknown",
        }
    }

    /// Only a hard "this app does not expose selections" verdict counts against the app.
    pub fn is_permanent(&self) -> bool {
        matches!(self, Self::AttributeUnsupported)
    }
}

/// A selection rectangle in **macOS point space, y-down from the top-left of the display grid** —
/// the space the Accessibility API reports, and what the overlay needs to sit next to the
/// selection (V1 §2.2 「在选区 / 光标附近」).
#[derive(Clone, Copy, Debug, Default, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `AXIsProcessTrusted` — the single source of truth for the Setup Manager row
/// 「macOS Accessibility 已授权 / 未授权」. `prompt = true` asks the system to show the grant
/// dialog (V1 §11.2: the user grants it, we only guide).
pub fn is_trusted(prompt: bool) -> bool {
    if !prompt {
        // SAFETY: argument-free system call.
        return unsafe { AXIsProcessTrusted() } != 0;
    }
    let options = CFDictionary::from_CFType_pairs(&[(
        CFString::new("AXTrustedCheckOptionPrompt"),
        CFBoolean::true_value(),
    )]);
    // SAFETY: `options` owns a live CFDictionary until the end of this statement.
    let trusted = unsafe { AXIsProcessTrustedWithOptions(options.as_CFTypeRef()) };
    trusted != 0
}

pub fn frontmost_app() -> Option<AppInfo> {
    app_kit::frontmost_app()
}

fn system_wide() -> Option<Element> {
    // SAFETY: create rule; `Element` releases it on drop.
    let raw = unsafe { AXUIElementCreateSystemWide() };
    if raw.is_null() {
        return None;
    }
    Some(unsafe { Element::from_create_rule(raw) })
}

fn app_element_for_pid(pid: Pid) -> Option<Element> {
    if pid <= 0 {
        return None;
    }
    // SAFETY: create rule.
    let raw = unsafe { AXUIElementCreateApplication(pid) };
    if raw.is_null() {
        return None;
    }
    Some(unsafe { Element::from_create_rule(raw) })
}

/// Copy one attribute. `Ok(None)` = "call succeeded, no value"; `Err(code)` = the raw AX error.
fn copy_value(element: &Element, attribute: &str) -> Result<Option<Owned>, AxError> {
    let name = CFString::new(attribute);
    let mut value: CFTypeRef = ptr::null();
    // SAFETY: `name` outlives the call; `value` is only read on success and is then owned by the
    // returned `Owned`, which releases it exactly once.
    let error =
        unsafe { AXUIElementCopyAttributeValue(element.as_raw(), name.as_CFTypeRef(), &mut value) };
    if error != AX_ERROR_SUCCESS {
        return Err(error);
    }
    if value.is_null() {
        return Ok(None);
    }
    // SAFETY: AXUIElementCopyAttributeValue is CF_RETURNS_RETAINED.
    Ok(Some(unsafe { Owned::from_create_rule(value) }))
}

fn copy_element(element: &Element, attribute: &str) -> Option<Element> {
    let value = copy_value(element, attribute).ok().flatten()?;
    // Element references are opaque; the only cheap sanity check is that we were not handed back
    // a string or an array for an attribute we expect to be an element.
    if value.is_string() || value.is_array() {
        return None;
    }
    Some(value.into_element())
}

pub fn string_value(element: &Element, attribute: &str) -> Option<String> {
    copy_value(element, attribute).ok().flatten()?.as_str()
}

fn point_value(element: &Element, attribute: &str) -> Option<AxPoint> {
    copy_value(element, attribute).ok().flatten()?.as_ax_point()
}

fn size_value(element: &Element, attribute: &str) -> Option<AxSize> {
    copy_value(element, attribute).ok().flatten()?.as_ax_size()
}

fn range_value(element: &Element, attribute: &str) -> Option<AxRange> {
    copy_value(element, attribute).ok().flatten()?.as_ax_range()
}

/// Diagnostic for Setup Manager: which attributes the focused element actually answers.
pub fn attribute_names(element: &Element) -> Vec<String> {
    let mut names: CFTypeRef = ptr::null();
    // SAFETY: out-param, wrapped into an owning `Owned` on success.
    let error = unsafe { AXUIElementCopyAttributeNames(element.as_raw(), &mut names) };
    if error != AX_ERROR_SUCCESS || names.is_null() {
        return Vec::new();
    }
    let array = unsafe { Owned::from_create_rule(names) };
    array
        .array_items()
        .iter()
        .filter_map(|item| item.as_str())
        .collect()
}

/// V1 §11.1 step 1: the element that owns the text cursor, and the application element it came
/// from. `AXFocusedApplication` can be empty while a frontmost app exists, so the pid is used as
/// a fallback before giving up.
pub fn focused_element() -> Result<Focused, ReadFailure> {
    let system = system_wide().ok_or(ReadFailure::NoFocusedApplication)?;
    let app = copy_element(&system, attr::FOCUSED_APPLICATION)
        .or_else(|| app_element_for_pid(frontmost_app().map(|info| info.pid).unwrap_or_default()))
        .ok_or(ReadFailure::NoFocusedApplication)?;
    let element = copy_element(&app, attr::FOCUSED_UI_ELEMENT)
        .or_else(|| copy_element(&system, attr::FOCUSED_UI_ELEMENT))
        .ok_or(ReadFailure::NoFocusedElement)?;
    Ok(Focused { system, app, element })
}

pub struct Focused {
    system: Element,
    app: Element,
    element: Element,
}

impl Focused {
    pub fn element(&self) -> &Element {
        &self.element
    }

    pub fn app(&self) -> &Element {
        &self.app
    }

    /// Window title of the focused element's app, for `CaptureRequest.source.title`.
    pub fn app_title(&self) -> Option<String> {
        string_value(&self.app, attr::TITLE)
    }

    /// Fallback used when the app element itself carries no title.
    pub fn focused_window_title(&self) -> Option<String> {
        let window = copy_element(&self.app, attr::MAIN_WINDOW)
            .or_else(|| copy_element(&self.app, attr::FOCUSED_WINDOW))
            .or_else(|| copy_element(&self.system, attr::FOCUSED_WINDOW))?;
        string_value(&window, attr::TITLE)
    }
}

/// V1 §11.1 step 3 — the selected text of the focused element, or why there is none.
pub fn read_selected_text() -> Selection {
    let app_info = frontmost_app();
    let focused = match focused_element() {
        Ok(focused) => focused,
        Err(failure) => return Selection::Failed { app: app_info, failure },
    };
    match copy_value(focused.element(), attr::SELECTED_TEXT) {
        Ok(Some(value)) => match value.as_str() {
            Some(text) if !text.trim().is_empty() => Selection::Text {
                app: app_info,
                text,
                focused,
            },
            // Present but empty: supported attribute, nothing selected right now.
            Some(_) | None => Selection::Empty { app: app_info },
        },
        Ok(None) => Selection::Empty { app: app_info },
        Err(error) => Selection::Failed {
            app: app_info,
            failure: ReadFailure::from_ax_error(error),
        },
    }
}

/// Result of the focused-element → selected-text walk. `Text` keeps the element alive so the
/// geometry can be read without walking the chain a second time.
pub enum Selection {
    Text {
        app: Option<AppInfo>,
        text: String,
        focused: Focused,
    },
    Empty {
        app: Option<AppInfo>,
    },
    Failed {
        app: Option<AppInfo>,
        failure: ReadFailure,
    },
}

impl Selection {
    pub fn app(&self) -> Option<&AppInfo> {
        match self {
            Self::Text { app, .. } | Self::Empty { app } | Self::Failed { app, .. } => app.as_ref(),
        }
    }

    pub fn element(&self) -> Option<&Element> {
        match self {
            Self::Text { focused, .. } => Some(focused.element()),
            _ => None,
        }
    }
}

/// V1 §11.1 step 3, simplified surface for callers that only need the string.
pub fn selected_text() -> Option<String> {
    match read_selected_text() {
        Selection::Text { text, .. } => Some(text),
        _ => None,
    }
}

/// A rectangle plus the truth about how it was obtained: `estimated = true` means the caret box
/// was unavailable and this is the focused element's frame (V1 §11.1 允许估算).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Measured {
    pub rect: Rect,
    pub estimated: bool,
}

/// V1 §11.1 step 4 — "获取或估算选区 / 光标位置".
///
/// Attempts, each allowed to fail silently:
/// 1. `AXBoundsForRange` over `AXSelectedTextRange` — the real selection box for apps that
///    implement the text suite (NSTextView, most IDEs, browser content).
/// 2. `AXSelectedTextUIElements` — some rich editors hand back per-run elements with geometry.
/// 3. **Estimated fallback**, which V1 §11.1 explicitly allows: the focused element's own
///    `AXPosition` + `AXSize`. Caret geometry is frequently unavailable (Electron surfaces in
///    particular), and anchoring the pill to the text area is honest enough for V1. Paths 1 and 2
///    report `estimated = false`; path 3 reports `true`, so the pill and Setup Manager can say so.
pub fn selection_bounds(element: Option<&Element>) -> Option<Measured> {
    let element = element?;
    if let Some(range) = range_value(element, attr::SELECTED_TEXT_RANGE) {
        if let Some(rect) = bounds_for_range(element, range) {
            return Some(Measured { rect, estimated: false });
        }
    }
    if let Some(rect) = selected_text_element_bounds(element) {
        return Some(Measured { rect, estimated: false });
    }
    element_frame(element).map(|rect| Measured { rect, estimated: true })
}

fn bounds_for_range(element: &Element, range: AxRange) -> Option<Rect> {
    let parameter = Value::from_range(&range)?;
    let name = CFString::new(attr::BOUNDS_FOR_RANGE);
    let mut result: CFTypeRef = ptr::null();
    // SAFETY: `name` and `parameter` are live CF objects for the duration of the call.
    let error = unsafe {
        AXUIElementCopyParameterizedAttributeValue(
            element.as_raw(),
            name.as_CFTypeRef(),
            parameter.as_raw() as CFTypeRef,
            &mut result,
        )
    };
    if error != AX_ERROR_SUCCESS || result.is_null() {
        return None;
    }
    let value = unsafe { Owned::from_create_rule(result) };
    if let Some(rect) = value.as_ax_rect() {
        return Some(rect_from_parts(rect.origin, rect.size));
    }
    match value.value_type() {
        AX_VALUE_TYPE_CGPOINT => value.as_ax_point().map(|point| Rect {
            // A bare origin means "the caret is here": give the pill a caret-sized box.
            x: point.x,
            y: point.y,
            width: 1.0,
            height: 18.0,
        }),
        AX_VALUE_TYPE_CGSIZE => point_value(element, attr::POSITION)
            .zip(value.as_ax_size())
            .map(|(origin, size)| rect_from_parts(origin, size)),
        _ => None,
    }
}

fn selected_text_element_bounds(element: &Element) -> Option<Rect> {
    let values = copy_value(element, attr::SELECTED_TEXT_UI_ELEMENTS).ok().flatten()?;
    let first = values.array_items().into_iter().next()?;
    if first.is_string() || first.is_array() {
        return None;
    }
    element_frame(&first.into_element())
}

/// Position + size of an element — the estimation path.
pub fn element_frame(element: &Element) -> Option<Rect> {
    let origin = point_value(element, attr::POSITION)?;
    let size = size_value(element, attr::SIZE)?;
    Some(rect_from_parts(origin, size))
}

fn rect_from_parts(origin: AxPoint, size: AxSize) -> Rect {
    Rect {
        x: origin.x,
        y: origin.y,
        width: size.width.max(0.0),
        height: size.height.max(0.0),
    }
}

/// `selection_bounds()` for callers that only have the focus chain: walks it again.
pub fn selection_bounds_from_focus() -> Option<Measured> {
    let focused = focused_element().ok()?;
    selection_bounds(Some(focused.element()))
}

pub fn pid_of(element: &Element) -> Option<Pid> {
    let mut pid: Pid = 0;
    // SAFETY: out-param written only on success.
    let error = unsafe { AXUIElementGetPid(element.as_raw(), &mut pid) };
    if error == AX_ERROR_SUCCESS && pid > 0 {
        Some(pid)
    } else {
        None
    }
}

/// Focused element's role, surfaced in Setup Manager's capture test so a failure is explainable.
pub fn role_of(element: &Element) -> Option<String> {
    string_value(element, attr::ROLE)
}

/// Unused-but-exported marker keeps `AxOpaque` referenced for readers of this module.
pub type ElementRef = AxOpaque;
