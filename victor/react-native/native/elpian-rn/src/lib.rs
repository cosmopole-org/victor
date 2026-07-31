//! # elpian-rn — the WebAssembly seam the React Native / Expo host embeds
//!
//! The JavaScript host (`victor/react-native/src`) cannot link Rust directly,
//! so this crate exposes the multi-VM [`VmManager`] (reused verbatim from
//! `elpian-godot-capi`) as a tiny wasm32 surface. It is the exact mirror of the
//! Godot C-ABI, only the transport differs: instead of a C callback the host
//! implements ONE imported function, `host_call`, which services every guest
//! `askHost` the manager forwards.
//!
//! ```text
//!  React Native (JS/TS)                 this crate (wasm)          Elpian VMs
//!  ────────────────────                 ─────────────────          ──────────
//!  <Victor source=…/> ── elpian_rn_new ─▶ VmManager::new_root ───▶ root VM
//!                     ── elpian_rn_run ──▶ run_root()   (main() + settle)
//!                     ── elpian_rn_pump ─▶ pump(dt)     (timers, budgets)
//!                     ── elpian_rn_invoke ▶ invoke()    (widget events)
//!       host_call  ◀── forward("rn.op" | "godot.op" | "log" | …)  (the seam)
//! ```
//!
//! Because nothing here generates machine code, the same `.wasm` is legal on
//! iOS and runs on the web — the whole reason the Elpian VM exists.
//!
//! ## The wire buffers
//!
//! Every string that crosses the boundary is a **length-prefixed buffer**:
//! `[u32 little-endian byte length][utf-8 bytes]`. Both sides allocate with
//! [`elpian_rn_alloc`] and free with [`elpian_rn_free_buf`], so ownership is
//! symmetric and there is no second return value to smuggle across wasm's
//! single-value ABI. A returned null pointer means "no value" (the guest sees
//! `null`).

use std::cell::RefCell;

use elpian_godot::{GuestLang, VmManager};
use serde_json::Value;

/// Opaque runtime handle the host round-trips as an `i32` pointer.
pub struct RnRuntime {
    mgr: VmManager,
}

// ---------------------------------------------------------------------------
// the host-call seam
// ---------------------------------------------------------------------------

#[cfg(target_arch = "wasm32")]
extern "C" {
    /// Implemented by the JavaScript host. Reads `(name, args_json)` out of wasm
    /// memory and returns a length-prefixed reply buffer (or null to decline,
    /// which the guest sees as `null`). The reply buffer is freed by Rust.
    fn host_call(
        name_ptr: *const u8,
        name_len: usize,
        args_ptr: *const u8,
        args_len: usize,
    ) -> *mut u8;
}

// On non-wasm targets (host-side `cargo test`) the import is replaced by an
// injectable function pointer so the seam can be exercised without a browser.
#[cfg(not(target_arch = "wasm32"))]
thread_local! {
    static NATIVE_HOST: RefCell<Option<Box<dyn FnMut(&str, &str) -> Option<String>>>> =
        const { RefCell::new(None) };
}

/// Test hook (native builds only): install the function that services host
/// calls, mirroring the wasm `host_call` import.
#[cfg(not(target_arch = "wasm32"))]
pub fn set_native_host(f: Box<dyn FnMut(&str, &str) -> Option<String>>) {
    NATIVE_HOST.with(|h| *h.borrow_mut() = Some(f));
}

/// Cross the seam once: hand `(name, args)` to the host and parse its reply.
fn dispatch(name: &str, args: &[Value]) -> Option<Value> {
    let args_json = Value::Array(args.to_vec()).to_string();

    #[cfg(target_arch = "wasm32")]
    {
        let reply_ptr = unsafe {
            host_call(name.as_ptr(), name.len(), args_json.as_ptr(), args_json.len())
        };
        if reply_ptr.is_null() {
            return None;
        }
        let reply = read_prefixed(reply_ptr);
        free_prefixed(reply_ptr);
        return serde_json::from_str(&reply).ok();
    }

    #[cfg(not(target_arch = "wasm32"))]
    {
        let reply = NATIVE_HOST.with(|h| {
            h.borrow_mut()
                .as_mut()
                .and_then(|f| f(name, &args_json))
        });
        reply.and_then(|s| serde_json::from_str(&s).ok())
    }
}

// ---------------------------------------------------------------------------
// length-prefixed buffer helpers
// ---------------------------------------------------------------------------

/// Allocate `len` bytes of wasm memory the host may write into. Paired with
/// [`elpian_rn_free_buf`].
#[no_mangle]
pub extern "C" fn elpian_rn_alloc(len: usize) -> *mut u8 {
    let mut v: Vec<u8> = Vec::with_capacity(len.max(1));
    let ptr = v.as_mut_ptr();
    std::mem::forget(v);
    ptr
}

/// Free a buffer previously returned by [`elpian_rn_alloc`] (or by any of the
/// `*_emit` returns from this crate). `total` is the full allocation size.
#[no_mangle]
pub extern "C" fn elpian_rn_free_buf(ptr: *mut u8, total: usize) {
    if !ptr.is_null() && total != 0 {
        unsafe { drop(Vec::from_raw_parts(ptr, total, total)) };
    }
}

/// Write `s` into a freshly allocated length-prefixed buffer and return its
/// pointer. The host reads the `u32` LE prefix, then the bytes.
fn emit(s: &str) -> *mut u8 {
    let bytes = s.as_bytes();
    let total = 4 + bytes.len();
    let ptr = elpian_rn_alloc(total);
    unsafe {
        let len = bytes.len() as u32;
        std::ptr::copy_nonoverlapping(len.to_le_bytes().as_ptr(), ptr, 4);
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.add(4), bytes.len());
    }
    ptr
}

/// Read a length-prefixed buffer the host produced back into a `String`.
#[allow(dead_code)]
fn read_prefixed(ptr: *mut u8) -> String {
    unsafe {
        let mut len_bytes = [0u8; 4];
        std::ptr::copy_nonoverlapping(ptr, len_bytes.as_mut_ptr(), 4);
        let len = u32::from_le_bytes(len_bytes) as usize;
        let slice = std::slice::from_raw_parts(ptr.add(4), len);
        String::from_utf8_lossy(slice).into_owned()
    }
}

#[allow(dead_code)]
fn free_prefixed(ptr: *mut u8) {
    unsafe {
        let mut len_bytes = [0u8; 4];
        std::ptr::copy_nonoverlapping(ptr, len_bytes.as_mut_ptr(), 4);
        let len = u32::from_le_bytes(len_bytes) as usize;
        elpian_rn_free_buf(ptr, 4 + len);
    }
}

fn str_from(ptr: *const u8, len: usize) -> String {
    if ptr.is_null() || len == 0 {
        return String::new();
    }
    unsafe { String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len)).into_owned() }
}

thread_local! {
    static LAST_ERROR: RefCell<String> = const { RefCell::new(String::new()) };
}

fn set_error(msg: &str) {
    LAST_ERROR.with(|e| *e.borrow_mut() = msg.to_string());
}

// ---------------------------------------------------------------------------
// runtime surface
// ---------------------------------------------------------------------------

/// Create a VM tree whose root runs the guest program. `lang` is `"js"` (the
/// default and only front-end React Native ships) or `"dart"`. `prepend != 0`
/// composes the preludes ahead of the program (what the host always does).
/// Returns a runtime pointer, or null on a compile/limit error — read
/// [`elpian_rn_last_error`].
#[no_mangle]
pub extern "C" fn elpian_rn_new(
    src_ptr: *const u8,
    src_len: usize,
    lang_ptr: *const u8,
    lang_len: usize,
    prepend: i32,
) -> *mut RnRuntime {
    let source = str_from(src_ptr, src_len);
    let lang = match str_from(lang_ptr, lang_len).as_str() {
        "dart" => GuestLang::Dart,
        _ => GuestLang::Js,
    };
    match VmManager::new_root_lang("rn-vm-1".to_string(), &source, lang, prepend != 0, 0, 0) {
        Ok(mut mgr) => {
            mgr.set_bridge(Some(Box::new(|name: &str, args: &[Value]| {
                dispatch(name, args)
            })));
            Box::into_raw(Box::new(RnRuntime { mgr }))
        }
        Err(e) => {
            set_error(&format!("compile failed: {e}"));
            std::ptr::null_mut()
        }
    }
}

/// Run the root guest's `main()` and settle the tree. 0 = ok.
#[no_mangle]
pub extern "C" fn elpian_rn_run(rt: *mut RnRuntime) -> i32 {
    let Some(rt) = (unsafe { rt.as_mut() }) else { return 1 };
    match rt.mgr.run_root() {
        Ok(()) => 0,
        Err(e) => {
            set_error(&format!("run failed: {e}"));
            1
        }
    }
}

/// Advance every live VM's clock by `delta_ms`, fire due timers/microtasks and
/// run the aggregate-budget sweep. Call once per animation frame. 0 = ok.
#[no_mangle]
pub extern "C" fn elpian_rn_pump(rt: *mut RnRuntime, delta_ms: u64) -> i32 {
    let Some(rt) = (unsafe { rt.as_mut() }) else { return 1 };
    match rt.mgr.pump(delta_ms) {
        Ok(()) => 0,
        Err(e) => {
            set_error(&format!("pump failed: {e}"));
            1
        }
    }
}

/// Deliver a named guest function one JSON argument. The host uses this for
/// widget events (`__godotDispatch([cbId,[args]])`) and lifecycle callbacks,
/// exactly as the Godot node does. 0 = ok.
#[no_mangle]
pub extern "C" fn elpian_rn_invoke(
    rt: *mut RnRuntime,
    fn_ptr: *const u8,
    fn_len: usize,
    arg_ptr: *const u8,
    arg_len: usize,
) -> i32 {
    let Some(rt) = (unsafe { rt.as_mut() }) else { return 1 };
    let name = str_from(fn_ptr, fn_len);
    let arg_str = str_from(arg_ptr, arg_len);
    let arg: Value = if arg_str.is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&arg_str).unwrap_or(Value::Null)
    };
    rt.mgr.invoke(&name, arg);
    0
}

/// Fresh guest `print`/log lines as a JSON string array, or null when none.
/// Returned buffer is freed with [`elpian_rn_free_buf`].
#[no_mangle]
pub extern "C" fn elpian_rn_take_log(rt: *mut RnRuntime) -> *mut u8 {
    let Some(rt) = (unsafe { rt.as_mut() }) else { return std::ptr::null_mut() };
    let fresh = rt.mgr.take_log();
    if fresh.is_empty() {
        return std::ptr::null_mut();
    }
    emit(&Value::from(fresh).to_string())
}

/// JSON snapshot of the whole VM tree (ids, labels, states, per-VM + aggregate
/// usage) for host dashboards. Freed with [`elpian_rn_free_buf`].
#[no_mangle]
pub extern "C" fn elpian_rn_stats(rt: *mut RnRuntime) -> *mut u8 {
    let Some(rt) = (unsafe { rt.as_ref() }) else { return std::ptr::null_mut() };
    emit(&rt.mgr.stats().to_string())
}

/// The last error message for this thread, as a length-prefixed buffer ("" when
/// none). Freed with [`elpian_rn_free_buf`].
#[no_mangle]
pub extern "C" fn elpian_rn_last_error() -> *mut u8 {
    LAST_ERROR.with(|e| emit(&e.borrow()))
}

/// Destroy the VM tree (terminating the root terminates all descendants).
#[no_mangle]
pub extern "C" fn elpian_rn_free(rt: *mut RnRuntime) {
    if !rt.is_null() {
        unsafe { drop(Box::from_raw(rt)) };
    }
}
