//! End-to-end pipeline test (native, no wasm needed): compose the
//! `reactnative.js` prelude ahead of a guest program, run it on the real
//! multi-VM manager, and assert the widget ops it emits over the `rn.*` seam.
//!
//! This exercises the whole chain the React Native host relies on —
//! `js2elpian` compiling the prelude + program in the subset, the VM running
//! `main()`, and the manager forwarding `rn.op`/`rn.batch` to the bridge — so a
//! regression in any of them fails here rather than only in a browser.

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Mutex;

use elpian_godot::{GuestLang, VmManager};
use serde_json::Value;

// The VM front-end keeps process-global state (compile-time interning), so
// serialize the compile+run of these tests — they otherwise race under the
// default multi-threaded test harness.
static VM_LOCK: Mutex<()> = Mutex::new(());

/// Boot `source` (JS) with the preludes composed, recording every host call the
/// manager forwards to the bridge. Returns the recorded (name, args) list.
fn run_and_record(source: &str) -> Vec<(String, Vec<Value>)> {
    run_and_record_with_log(source).0
}

/// As [`run_and_record`], also returning the guest's `print` lines (which the
/// manager captures internally — the host reads them via `take_log`, not the
/// bridge).
fn run_and_record_with_log(source: &str) -> (Vec<(String, Vec<Value>)>, Vec<String>) {
    let _guard = VM_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let calls: Rc<RefCell<Vec<(String, Vec<Value>)>>> = Rc::new(RefCell::new(Vec::new()));
    let sink = calls.clone();
    let mut mgr = VmManager::new_root_lang(
        "test-vm".to_string(),
        source,
        GuestLang::Js,
        true, // compose the preludes (godot.js + reactnative.js)
        0,
        0,
    )
    .expect("guest + prelude should compile in the subset");

    mgr.set_bridge(Some(Box::new(move |name: &str, args: &[Value]| {
        sink.borrow_mut().push((name.to_string(), args.to_vec()));
        // Reply shape the guest tolerates: a widget-creating op echoes its def
        // id; a scene3d_mount returns a node handle; everything else is null.
        if name == "rn.op" {
            if let Some(op) = args.first() {
                if let Some(def) = op.get("def").and_then(|v| v.as_i64()) {
                    return Some(Value::from(def));
                }
                if op.get("method").and_then(|v| v.as_str()) == Some("scene3d_mount") {
                    return Some(serde_json::json!({ "ref": 1_000_001 }));
                }
            }
        }
        Some(Value::Null)
    })));

    mgr.run_root().expect("guest main() should run");
    let out = calls.borrow().clone();
    let logs = mgr.take_log();
    (out, logs)
}

/// Flatten `rn.op` singletons and `rn.batch` arrays into one op list.
fn all_ops(calls: &[(String, Vec<Value>)]) -> Vec<Value> {
    let mut ops = Vec::new();
    for (name, args) in calls {
        match name.as_str() {
            "rn.op" => {
                if let Some(op) = args.first() {
                    ops.push(op.clone());
                }
            }
            "rn.batch" => {
                if let Some(Value::Array(list)) = args.first() {
                    ops.extend(list.iter().cloned());
                }
            }
            _ => {}
        }
    }
    ops
}

fn has_op<F: Fn(&Value) -> bool>(ops: &[Value], pred: F) -> bool {
    ops.iter().any(pred)
}

#[test]
fn builds_and_mounts_a_widget_tree() {
    let source = r##"
        import 'reactnative.js';
        function main() {
          RN.begin();
          var col = RN.column({ padding: 10, bg: "#111" });
          var t = RN.text("hello victor", {});
          col.add(t);
          RN.commit();
          RN.mount(col);
          print("built");
        }
        main();
    "##;

    let (calls, logs) = run_and_record_with_log(source);
    let ops = all_ops(&calls);

    // A View and a Text were created.
    assert!(
        has_op(&ops, |o| o.get("new").and_then(|v| v.as_str()) == Some("RNView")),
        "expected an RNView create op; got {ops:?}",
    );
    assert!(
        has_op(&ops, |o| o.get("new").and_then(|v| v.as_str()) == Some("RNText")),
        "expected an RNText create op",
    );
    // The text content was set as a prop.
    assert!(
        has_op(&ops, |o| o
            .get("props")
            .and_then(|p| p.get("text"))
            .and_then(|v| v.as_str())
            == Some("hello victor")),
        "expected the text prop to be applied",
    );
    // add_child linked them.
    assert!(
        has_op(&ops, |o| o.get("method").and_then(|v| v.as_str()) == Some("add_child")),
        "expected an add_child structural op",
    );
    // A root was marked.
    assert!(
        has_op(&ops, |o| o.get("root").is_some()),
        "expected a root op from RN.mount",
    );
    // The guest's print line was captured (read via take_log, as the host does).
    assert!(
        logs.iter().any(|l| l.contains("built")),
        "expected the guest print line; got {logs:?}",
    );
}

#[test]
fn events_bind_through_connect_ops() {
    let source = r##"
        import 'reactnative.js';
        function main() {
          var b = RN.button({ title: "Tap", onPress: function (e) { print("pressed"); } });
          RN.mount(b);
        }
        main();
    "##;

    let ops = all_ops(&run_and_record(source));
    eprintln!("EVENTS OPS: {}", serde_json::to_string(&ops).unwrap());
    // The onPress handler must be a `connect` op (so the manager namespaces the
    // callback id), never a raw prop.
    assert!(
        has_op(&ops, |o| o.get("connect").and_then(|v| v.as_str()) == Some("press")
            && o.get("cb").is_some()),
        "expected an onPress connect op with a cb id; got {ops:?}",
    );
    assert!(
        !has_op(&ops, |o| o
            .get("props")
            .map(|p| p.get("onPress").is_some())
            .unwrap_or(false)),
        "onPress must not leak into a props op",
    );
}

#[test]
fn scene3d_widget_requests_a_godot_mount() {
    let source = r##"
        import 'reactnative.js';
        function main() {
          var s = RN.scene3d({ height: 200 });
          RN.mount(s);
        }
        main();
    "##;

    let ops = all_ops(&run_and_record(source));
    assert!(
        has_op(&ops, |o| o.get("new").and_then(|v| v.as_str()) == Some("RNScene3D")),
        "expected an RNScene3D create op",
    );
    assert!(
        has_op(&ops, |o| o.get("method").and_then(|v| v.as_str()) == Some("scene3d_mount")),
        "expected a scene3d_mount request",
    );
}

/// The shipped rich example (`assets/guest/showcase.js`) must compile in the
/// js2elpian subset and run end-to-end: this boots it with the preludes
/// composed and asserts it mounts its 2D tree and requests its embedded Godot
/// 3D scene — so a subset regression in the example fails here, not only in a
/// device build.
#[test]
fn boots_the_rich_showcase_example() {
    let source = include_str!("../../../assets/guest/showcase.js");
    let (calls, logs) = run_and_record_with_log(source);
    let ops = all_ops(&calls);

    // Its 2D surface: a scroll view, a Modal and a FlatList were created.
    for cls in ["RNScroll", "Modal", "FlatList", "RNScene3D"] {
        assert!(
            has_op(&ops, |o| o.get("new").and_then(|v| v.as_str()) == Some(cls)),
            "expected a {cls} create op; got {ops:?}",
        );
    }
    // The embedded Godot scene was mounted and an app root was marked.
    assert!(
        has_op(&ops, |o| o.get("method").and_then(|v| v.as_str()) == Some("scene3d_mount")),
        "expected the Scene3D to request a Godot mount",
    );
    assert!(
        has_op(&ops, |o| o.get("root").is_some()),
        "expected the app root to be mounted",
    );
    assert!(
        logs.iter().any(|l| l.contains("showcase up")),
        "expected the showcase print line; got {logs:?}",
    );
}
