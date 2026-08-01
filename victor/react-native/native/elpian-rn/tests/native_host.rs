//! Native transport test: exercise the crate through its **C ABI** exactly as
//! the on-device JSI module will — register a C `host_call` via
//! `elpian_rn_set_host`, then drive `elpian_rn_new` → `elpian_rn_run` and assert
//! the guest's widget ops arrived over the seam and its `print` line came back
//! through `elpian_rn_take_log`.
//!
//! This is the device backend's transport minus JSI/Hermes: it proves the
//! synchronous host round-trip (guest `askHost` → Rust `dispatch` → our C
//! callback → length-prefixed reply → guest resumes) works end-to-end without
//! wasm, so a regression in the native seam fails here rather than only on a
//! phone.

use std::cell::RefCell;

use elpian_rn::{
    elpian_rn_alloc, elpian_rn_free, elpian_rn_new, elpian_rn_run, elpian_rn_set_host,
    elpian_rn_take_log,
};

thread_local! {
    /// Every (name, args_json) the VM forwarded to our C host, in order.
    static RECORDED: RefCell<Vec<(String, String)>> = const { RefCell::new(Vec::new()) };
}

/// Build a length-prefixed reply buffer `[u32 LE len][utf-8 bytes]` in memory
/// the crate owns (allocated with `elpian_rn_alloc`, freed by the crate), the
/// same contract the JS/wasm host uses for `host_call` replies.
fn emit_prefixed(s: &str) -> *mut u8 {
    let bytes = s.as_bytes();
    let total = 4 + bytes.len();
    let ptr = elpian_rn_alloc(total);
    unsafe {
        std::ptr::copy_nonoverlapping((bytes.len() as u32).to_le_bytes().as_ptr(), ptr, 4);
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr.add(4), bytes.len());
    }
    ptr
}

/// The C host: record the call, then reply the way the real JS host does — a
/// widget-creating `rn.op` echoes its `def` id; a `scene3d_mount` returns a
/// Godot mount handle; everything else declines (null).
extern "C" fn host(
    name_ptr: *const u8,
    name_len: usize,
    args_ptr: *const u8,
    args_len: usize,
) -> *mut u8 {
    let name =
        String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(name_ptr, name_len) }).into_owned();
    let args =
        String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(args_ptr, args_len) }).into_owned();
    RECORDED.with(|r| r.borrow_mut().push((name.clone(), args.clone())));

    if name == "rn.op" {
        let parsed: serde_json::Value = serde_json::from_str(&args).unwrap_or(serde_json::Value::Null);
        if let Some(op) = parsed.get(0) {
            if op.get("method").and_then(|m| m.as_str()) == Some("scene3d_mount") {
                return emit_prefixed("{\"ref\":1000001}");
            }
            if let Some(def) = op.get("def").and_then(|d| d.as_i64()) {
                return emit_prefixed(&def.to_string());
            }
        }
    }
    std::ptr::null_mut()
}

#[test]
fn native_c_abi_runs_a_widget_tree_over_the_host_seam() {
    RECORDED.with(|r| r.borrow_mut().clear());
    elpian_rn_set_host(Some(host));

    let source = r##"
        import 'reactnative.js';
        function main() {
          RN.begin();
          var col = RN.column({ padding: 10, bg: "#111" });
          var t = RN.text("hello native", {});
          col.add(t);
          RN.commit();
          RN.mount(col);
          print("native up");
        }
        main();
    "##;
    let lang = "js";

    let rt = elpian_rn_new(
        source.as_ptr(),
        source.len(),
        lang.as_ptr(),
        lang.len(),
        1, // prepend the preludes, as the host always does
    );
    assert!(!rt.is_null(), "elpian_rn_new returned null (compile failed)");

    let rc = elpian_rn_run(rt);
    assert_eq!(rc, 0, "elpian_rn_run reported an error");

    // The guest's print line must round-trip out through take_log.
    let log_ptr = elpian_rn_take_log(rt);
    assert!(!log_ptr.is_null(), "expected a log buffer");
    let logs = read_prefixed_owned(log_ptr);
    assert!(logs.contains("native up"), "expected the guest print line; got {logs}");

    // The host seam saw the widget ops: an RNView + RNText were created and
    // linked, and a root was mounted.
    let calls = RECORDED.with(|r| r.borrow().clone());
    let ops: Vec<serde_json::Value> = calls
        .iter()
        .filter(|(n, _)| n == "rn.op" || n == "rn.batch")
        .flat_map(|(n, a)| {
            let v: serde_json::Value = serde_json::from_str(a).unwrap_or(serde_json::Value::Null);
            let first = v.get(0).cloned().unwrap_or(serde_json::Value::Null);
            if n == "rn.batch" {
                first.as_array().cloned().unwrap_or_default()
            } else {
                vec![first]
            }
        })
        .collect();

    let has = |pred: &dyn Fn(&serde_json::Value) -> bool| ops.iter().any(|o| pred(o));
    assert!(
        has(&|o| o.get("new").and_then(|v| v.as_str()) == Some("RNView")),
        "expected an RNView create op; got {ops:?}",
    );
    assert!(
        has(&|o| o.get("new").and_then(|v| v.as_str()) == Some("RNText")),
        "expected an RNText create op",
    );
    assert!(
        has(&|o| o.get("method").and_then(|v| v.as_str()) == Some("add_child")),
        "expected an add_child structural op",
    );
    assert!(
        has(&|o| o.get("root").is_some()),
        "expected a root op from RN.mount",
    );

    elpian_rn_set_host(None);
    elpian_rn_free(rt);
}

/// Read a crate-owned length-prefixed buffer into a `String` and free it via the
/// crate's allocator (mirrors what the JS host does after `elpian_rn_take_log`).
fn read_prefixed_owned(ptr: *mut u8) -> String {
    unsafe {
        let mut len_bytes = [0u8; 4];
        std::ptr::copy_nonoverlapping(ptr, len_bytes.as_mut_ptr(), 4);
        let len = u32::from_le_bytes(len_bytes) as usize;
        let s = String::from_utf8_lossy(std::slice::from_raw_parts(ptr.add(4), len)).into_owned();
        elpian_rn::elpian_rn_free_buf(ptr, 4 + len);
        s
    }
}
