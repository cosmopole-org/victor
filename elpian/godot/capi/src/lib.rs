//! # elpian-godot-capi — the C ABI the Godot GDExtension embeds
//!
//! The C++ side of the bridge (`elpian/godot/extension/`) cannot link Rust
//! directly, so this crate flattens the [`dart::runtime::DartRuntime`] embed
//! into a small, panic-safe C surface (`elpian_godot_*`), mirrored by the
//! `extension/src/elpian_capi.h` header:
//!
//! ```text
//!  Godot (C++)                          this crate                Elpian VM
//!  ─────────────                        ───────────               ─────────
//!  ElpianVM node ── elpian_godot_new ─▶ DartRuntime::from_dart ─▶ compile+load
//!               ── elpian_godot_set_host ─▶ set_host_hook  (godot.* calls out)
//!               ── elpian_godot_run ────▶ run()            (main() + pump)
//!               ── elpian_godot_invoke ─▶ invoke_handler() (events/signals in)
//!               ── elpian_godot_pump ───▶ pump_events()    (timers, per frame)
//! ```
//!
//! The **host callback** is the load-bearing piece: every `askHost("godot.…")`
//! the guest makes arrives at the registered [`ElpianGodotHostFn`] as
//! `(api_name, args_json)`; the C++ `GodotController` interprets the op
//! reflectively against ClassDB and returns a JSON reply that resumes the VM.
//!
//! Threading contract: a runtime and its callback belong to ONE thread (Godot's
//! main thread). The `Send` the hook type demands is satisfied by construction
//! — the embedder never migrates the runtime across threads — and is asserted
//! here rather than proven, exactly like every GDExtension that touches the
//! scene tree.

use std::cell::RefCell;
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicU64, Ordering};

use dart::governance::{DartCapabilitySet, ResourceMeter};
use dart::runtime::DartRuntime;
use serde_json::{json, Value};

/// The `godot.dart` guest prelude, compiled ahead of the user program so the
/// `GD`/`GObj` reflective surface and the marshaling vocabulary are in scope.
pub const GODOT_PRELUDE: &str = include_str!("../../prelude/godot.dart");

/// Service a guest host call: `(user, api_name, args_json)` → reply JSON.
/// Return NULL (or leave unregistered) to decline — the guest then sees `null`.
/// The returned buffer is released via the paired [`ElpianGodotHostFreeFn`].
pub type ElpianGodotHostFn = Option<
    extern "C" fn(user: *mut c_void, api_name: *const c_char, args_json: *const c_char) -> *mut c_char,
>;

/// Release a buffer previously returned by the host callback (same allocator).
pub type ElpianGodotHostFreeFn = Option<extern "C" fn(user: *mut c_void, s: *mut c_char)>;

/// Opaque runtime handle across the C boundary.
pub struct ElpianGodotRuntime {
    rt: DartRuntime,
    /// How many guest `print`/log lines have already been drained by the host.
    log_cursor: usize,
}

/// The registered C callback bundle, captured by the Rust host hook. Carrying
/// the raw `user` pointer across the `Send` bound is sound under the crate's
/// single-thread embedding contract (see module docs).
struct HostBridge {
    call: extern "C" fn(*mut c_void, *const c_char, *const c_char) -> *mut c_char,
    free: ElpianGodotHostFreeFn,
    user: *mut c_void,
}
unsafe impl Send for HostBridge {}

impl HostBridge {
    fn dispatch(&self, api_name: &str, args: &[Value]) -> Option<Value> {
        let name = CString::new(api_name).ok()?;
        let args_json = CString::new(Value::Array(args.to_vec()).to_string()).ok()?;
        let reply_ptr = (self.call)(self.user, name.as_ptr(), args_json.as_ptr());
        if reply_ptr.is_null() {
            return None;
        }
        let reply = unsafe { CStr::from_ptr(reply_ptr) }.to_string_lossy().into_owned();
        if let Some(free) = self.free {
            free(self.user, reply_ptr);
        }
        serde_json::from_str(&reply).ok()
    }
}

thread_local! {
    static LAST_ERROR: RefCell<CString> = RefCell::new(CString::new("").unwrap());
}

fn set_error(msg: &str) {
    let c = CString::new(msg.replace('\0', " ")).unwrap_or_default();
    LAST_ERROR.with(|e| *e.borrow_mut() = c);
}

static NEXT_MACHINE: AtomicU64 = AtomicU64::new(1);

/// Compose the final guest program: the `godot.dart` prelude, then the user
/// source, with `import …;` directives stripped from both (the front-end has
/// no module system; the prelude *is* the import).
pub fn compose_godot_program(user_source: &str) -> String {
    let strip = |src: &str| -> String {
        src.lines()
            .map(|l| if l.trim_start().starts_with("import ") { "" } else { l })
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!("{}\n\n{}", strip(GODOT_PRELUDE), strip(user_source))
}

fn c_str<'a>(p: *const c_char) -> Option<&'a str> {
    if p.is_null() {
        return None;
    }
    unsafe { CStr::from_ptr(p) }.to_str().ok()
}

/// Create a runtime from Dart source. `prepend_prelude != 0` composes the
/// `godot.dart` prelude ahead of the program (what the ElpianVM node does).
/// `max_host_calls` / `max_bytes_moved` bound the resource meter (0 = unbounded).
/// Returns NULL on a compile/limit error — read `elpian_godot_last_error()`.
#[no_mangle]
pub extern "C" fn elpian_godot_new(
    dart_source: *const c_char,
    prepend_prelude: c_int,
    max_host_calls: u64,
    max_bytes_moved: u64,
) -> *mut ElpianGodotRuntime {
    let result = catch_unwind(|| {
        let source = match c_str(dart_source) {
            Some(s) => s,
            None => {
                set_error("dart_source is null or not UTF-8");
                return std::ptr::null_mut();
            }
        };
        let program = if prepend_prelude != 0 {
            compose_godot_program(source)
        } else {
            source.to_string()
        };
        let machine = format!("godot-vm-{}", NEXT_MACHINE.fetch_add(1, Ordering::Relaxed));
        let meter = ResourceMeter::new(
            (max_host_calls > 0).then_some(max_host_calls),
            (max_bytes_moved > 0).then_some(max_bytes_moved),
        );
        match DartRuntime::from_dart(machine, &program, DartCapabilitySet::full(), meter) {
            Ok(rt) => Box::into_raw(Box::new(ElpianGodotRuntime { rt, log_cursor: 0 })),
            Err(e) => {
                set_error(&format!("compile failed: {e:?}"));
                std::ptr::null_mut()
            }
        }
    });
    result.unwrap_or_else(|_| {
        set_error("panic during elpian_godot_new");
        std::ptr::null_mut()
    })
}

/// Register the host callback servicing the guest's `godot.*` calls.
/// Passing a NULL `host_fn` uninstalls (guest sees `null` replies).
#[no_mangle]
pub extern "C" fn elpian_godot_set_host(
    rt: *mut ElpianGodotRuntime,
    host_fn: ElpianGodotHostFn,
    free_fn: ElpianGodotHostFreeFn,
    user: *mut c_void,
) {
    let Some(rt) = (unsafe { rt.as_mut() }) else { return };
    match host_fn {
        Some(call) => {
            let bridge = HostBridge { call, free: free_fn, user };
            rt.rt.set_host_hook(Box::new(move |name, args| bridge.dispatch(name, args)));
        }
        None => rt.rt.set_host_hook(Box::new(|_, _| None)),
    }
}

/// Run the guest's `main()` and drain its event loop. 0 = ok.
#[no_mangle]
pub extern "C" fn elpian_godot_run(rt: *mut ElpianGodotRuntime) -> c_int {
    let Some(rt) = (unsafe { rt.as_mut() }) else { return 1 };
    match catch_unwind(AssertUnwindSafe(|| rt.rt.run())) {
        Ok(Ok(_)) => 0,
        Ok(Err(e)) => {
            set_error(&format!("run failed: {e:?}"));
            1
        }
        Err(_) => {
            set_error("panic during elpian_godot_run");
            1
        }
    }
}

/// Invoke a named guest function with one JSON argument (missing functions are
/// a no-op). This is how the C++ node delivers lifecycle events
/// (`__godotEvent(["_process", delta])`) and bridged signal emissions
/// (`__godotDispatch([cbId, [args…]])`). 0 = ok.
#[no_mangle]
pub extern "C" fn elpian_godot_invoke(
    rt: *mut ElpianGodotRuntime,
    fn_name: *const c_char,
    json_arg: *const c_char,
) -> c_int {
    let Some(rt) = (unsafe { rt.as_mut() }) else { return 1 };
    let Some(name) = c_str(fn_name) else {
        set_error("fn_name is null or not UTF-8");
        return 1;
    };
    let arg: Value = match c_str(json_arg) {
        Some(s) if !s.is_empty() => serde_json::from_str(s).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    let name = name.to_string();
    match catch_unwind(AssertUnwindSafe(|| rt.rt.invoke_handler(&name, arg))) {
        Ok(()) => 0,
        Err(_) => {
            set_error("panic during elpian_godot_invoke");
            1
        }
    }
}

/// Drain due timers/microtasks (call once per engine frame). 0 = ok.
#[no_mangle]
pub extern "C" fn elpian_godot_pump(rt: *mut ElpianGodotRuntime) -> c_int {
    let Some(rt) = (unsafe { rt.as_mut() }) else { return 1 };
    match catch_unwind(AssertUnwindSafe(|| rt.rt.pump_events())) {
        Ok(Ok(())) => 0,
        Ok(Err(e)) => {
            set_error(&format!("pump failed: {e:?}"));
            1
        }
        Err(_) => {
            set_error("panic during elpian_godot_pump");
            1
        }
    }
}

/// New guest `print`/log lines since the last call, as a JSON string array.
/// Caller frees with [`elpian_godot_string_free`]. NULL when nothing new.
#[no_mangle]
pub extern "C" fn elpian_godot_take_log(rt: *mut ElpianGodotRuntime) -> *mut c_char {
    let Some(rt) = (unsafe { rt.as_mut() }) else { return std::ptr::null_mut() };
    let log = rt.rt.log();
    if rt.log_cursor >= log.len() {
        return std::ptr::null_mut();
    }
    let fresh: Vec<&str> = log[rt.log_cursor..].iter().map(|s| s.as_str()).collect();
    rt.log_cursor = log.len();
    CString::new(json!(fresh).to_string())
        .map(|c| c.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

/// The last error message for this thread ("" when none). Borrowed — do not
/// free; valid until the next `elpian_godot_*` call on this thread.
#[no_mangle]
pub extern "C" fn elpian_godot_last_error() -> *const c_char {
    LAST_ERROR.with(|e| e.borrow().as_ptr())
}

/// Free a string returned by this library.
#[no_mangle]
pub extern "C" fn elpian_godot_string_free(s: *mut c_char) {
    if !s.is_null() {
        unsafe { drop(CString::from_raw(s)) };
    }
}

/// Destroy a runtime.
#[no_mangle]
pub extern "C" fn elpian_godot_free(rt: *mut ElpianGodotRuntime) {
    if !rt.is_null() {
        unsafe { drop(Box::from_raw(rt)) };
    }
}
