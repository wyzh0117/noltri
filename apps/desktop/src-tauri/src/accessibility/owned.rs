//! Ownership guards for CoreFoundation values.
//!
//! Every AX call that hands back a `CFTypeRef` is `CF_RETURNS_RETAINED`, and every
//! `AXUIElementCreate*` follows the create rule, so each raw pointer must be wrapped in a value
//! that releases it exactly once. That is the only reason [`Owned`] exists — it makes leaking a
//! CF object impossible rather than merely unlikely, which matters because the selection observer
//! runs this code ~1.5 times per second forever.

use core::ffi::{c_char, c_void};
use core::marker::PhantomData;

use core_foundation_sys::array::{CFArrayGetCount, CFArrayGetTypeID, CFArrayGetValueAtIndex};
use core_foundation_sys::base::{CFGetTypeID, CFRelease, CFRetain, CFTypeRef};
use core_foundation_sys::string::{
    CFStringGetCString, CFStringGetLength, CFStringGetMaximumSizeForEncoding, CFStringGetTypeID,
    kCFStringEncodingUTF8,
};

use super::ffi::{
    as_cf_index, AxOpaque, AxPoint, AxRange, AxRect, AxSize, AXValueCreate, AXValueGetValue,
    AXValueGetType, AX_VALUE_TYPE_CF_RANGE, AX_VALUE_TYPE_CGPOINT, AX_VALUE_TYPE_CGRECT,
    AX_VALUE_TYPE_CGSIZE,
};

/// An owned CoreFoundation object. Dropping it releases the underlying CFType.
pub struct Owned {
    raw: CFTypeRef,
}

impl Owned {
    /// Wrap a pointer the caller has just *created* (copy/retained-return rules).
    ///
    /// # Safety
    /// `raw` must be a valid, live CFTypeRef whose ownership the caller has taken
    /// (`CF_RETURNS_RETAINED`, `…Create…`), and must not be released elsewhere.
    pub unsafe fn from_create_rule(raw: CFTypeRef) -> Self {
        Self { raw }
    }

    pub fn as_raw(&self) -> CFTypeRef {
        self.raw
    }

    pub fn is_null(&self) -> bool {
        self.raw.is_null()
    }

    pub fn type_id(&self) -> usize {
        if self.raw.is_null() {
            return 0;
        }
        unsafe { CFGetTypeID(self.raw) }
    }

    pub fn is_string(&self) -> bool {
        !self.raw.is_null() && self.type_id() == unsafe { CFStringGetTypeID() }
    }

    pub fn is_array(&self) -> bool {
        !self.raw.is_null() && self.type_id() == unsafe { CFArrayGetTypeID() }
    }

    /// Decode a CFString into Rust text. Returns `None` (never panics) for non-strings,
    /// conversion failures or oversized buffers.
    pub fn as_str(&self) -> Option<String> {
        if !self.is_string() {
            return None;
        }
        unsafe { cfstring_to_string(self.raw) }
    }

    /// Number of elements, when this value is a CFArray.
    pub fn array_len(&self) -> usize {
        if !self.is_array() {
            return 0;
        }
        let count = unsafe { CFArrayGetCount(self.raw as _) };
        if count < 0 {
            0
        } else {
            count as usize
        }
    }

    /// Borrow an element of a CFArray. The array owns its elements, so the returned reference is
    /// only valid while `self` is alive; callers must not release it.
    pub fn array_get(&self, index: usize) -> Option<Borrowed<'_>> {
        if !self.is_array() {
            return None;
        }
        let count = self.array_len();
        if index >= count {
            return None;
        }
        let raw = unsafe { CFArrayGetValueAtIndex(self.raw as _, index as _) };
        if raw.is_null() {
            return None;
        }
        Some(Borrowed {
            raw: raw as CFTypeRef,
            _marker: PhantomData,
        })
    }

    /// Element references, retained so they outlive the array.
    pub fn array_items(&self) -> Vec<Owned> {
        let count = self.array_len();
        let mut items = Vec::with_capacity(count);
        for index in 0..count {
            let Some(borrowed) = self.array_get(index) else {
                continue;
            };
            if borrowed.raw.is_null() {
                continue;
            }
            let retained = unsafe { CFRetain(borrowed.raw) };
            if !retained.is_null() {
                // SAFETY: CFRetain returns ownership of one additional reference.
                items.push(unsafe { Owned::from_create_rule(retained) });
            }
        }
        items
    }

    /// `AXValueGetValue` for a wrapped `CGPoint`.
    pub fn as_ax_point(&self) -> Option<AxPoint> {
        ax_value_get::<AxPoint>(self.raw, AX_VALUE_TYPE_CGPOINT)
    }

    /// `AXValueGetValue` for a wrapped `CGSize`.
    pub fn as_ax_size(&self) -> Option<AxSize> {
        ax_value_get::<AxSize>(self.raw, AX_VALUE_TYPE_CGSIZE)
    }

    /// `AXValueGetValue` for a wrapped `CGRect`.
    pub fn as_ax_rect(&self) -> Option<AxRect> {
        ax_value_get::<AxRect>(self.raw, AX_VALUE_TYPE_CGRECT)
    }

    /// Which structure an `AXValueRef` wraps; 0 (`kAXValueIllegalType`) when it is not one.
    pub fn value_type(&self) -> u32 {
        if self.raw.is_null() {
            return 0;
        }
        unsafe { AXValueGetType(self.raw as _) }
    }

    /// `AXValueGetValue` for a wrapped `CFRange` (used by `AXSelectedTextRange`).
    pub fn as_ax_range(&self) -> Option<AxRange> {
        ax_value_get::<AxRange>(self.raw, AX_VALUE_TYPE_CF_RANGE)
    }

    /// Reinterpret this owned reference as an element, transferring ownership to the returned
    /// [`Element`] (which releases it on drop). Type punning only — no CF rule is broken.
    pub fn into_element(self) -> Element {
        let raw = self.raw as AxOpaque;
        core::mem::forget(self);
        // SAFETY: `raw` was created by an AX copy/create call and is released exactly once, by
        // the `Element` returned here.
        unsafe { Element::from_create_rule(raw) }
    }
}

impl Drop for Owned {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { CFRelease(self.raw) };
        }
    }
}

/// A CF object borrowed from a container; releasing it would over-free, so this type has no Drop.
pub struct Borrowed<'a> {
    raw: CFTypeRef,
    _marker: PhantomData<&'a Owned>,
}

impl Borrowed<'_> {
    pub fn as_str(&self) -> Option<String> {
        if self.raw.is_null() || self.type_id() != unsafe { CFStringGetTypeID() } {
            return None;
        }
        unsafe { cfstring_to_string(self.raw) }
    }

    fn type_id(&self) -> usize {
        unsafe { CFGetTypeID(self.raw) }
    }
}

/// An `AXUIElementRef` we own. Same release discipline as [`Owned`], but it documents intent and
/// lets [`super::ax`] take `&Element` instead of a bare pointer.
pub struct Element {
    raw: AxOpaque,
}

impl Element {
    /// # Safety
    /// `raw` must come from `AXUIElementCreate*` (create rule) and be released nowhere else.
    pub unsafe fn from_create_rule(raw: AxOpaque) -> Self {
        Self { raw }
    }

    pub fn as_raw(&self) -> AxOpaque {
        self.raw
    }
}

impl Drop for Element {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { CFRelease(self.raw as CFTypeRef) };
        }
    }
}

/// Wrap a structure into an `AXValueRef` (e.g. a `CFRange` for `AXBoundsForRange`).
pub struct Value {
    raw: AxOpaque,
}

impl Value {
    /// Returns `None` when `AXValueCreate` fails; it never panics.
    pub fn from_range(range: &AxRange) -> Option<Self> {
        let raw = unsafe { AXValueCreate(AX_VALUE_TYPE_CF_RANGE, range as *const AxRange as *const c_void) };
        if raw.is_null() {
            return None;
        }
        Some(Self { raw })
    }

    pub fn as_raw(&self) -> AxOpaque {
        self.raw
    }
}

impl Drop for Value {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            unsafe { CFRelease(self.raw as CFTypeRef) };
        }
    }
}

fn ax_value_get<T: Default>(value: AxOpaque, kind: u32) -> Option<T> {
    if value.is_null() {
        return None;
    }
    let mut out = T::default();
    let ok = unsafe { AXValueGetValue(value, kind, &mut out as *mut T as *mut c_void) };
    if ok == 0 {
        return None;
    }
    Some(out)
}

/// # Safety
/// `raw` must be a live CFString.
unsafe fn cfstring_to_string(raw: CFTypeRef) -> Option<String> {
    let length = CFStringGetLength(raw as _);
    if length < 0 {
        return None;
    }
    let wanted = CFStringGetMaximumSizeForEncoding(length, kCFStringEncodingUTF8);
    if wanted < 0 {
        return None;
    }
    // +1 for the NUL terminator CFStringGetCString writes.
    let capacity = (wanted as usize).saturating_add(1).clamp(1, 16 * 1024 * 1024);
    let mut buffer: Vec<u8> = vec![0u8; capacity];
    let ok = CFStringGetCString(
        raw as _,
        buffer.as_mut_ptr() as *mut c_char,
        as_cf_index(buffer.len()),
        kCFStringEncodingUTF8,
    );
    if ok == 0 {
        return None;
    }
    let cstr = unsafe { std::ffi::CStr::from_ptr(buffer.as_ptr() as *const c_char) };
    Some(cstr.to_string_lossy().into_owned())
}
