//! Protocol e2e for the **Flutter UI bridge** (`prelude/flutter.js` + the
//! `flutter.op` seam in `manager.rs`). No real `libflutter` is involved here —
//! this pins the *guest-visible contract* the C++ `FlutterController` must
//! honour, the same way `run_ui_demo.rs` pins the Godot bridge:
//!
//!   1. `godot.js` + `flutter.js` + a user program actually COMPILE together
//!      (the `import 'flutter.js';` composition path in `compose_godot_program_js`).
//!   2. `FL.mount(...)` crosses the seam as a `flutter.op {"newview", …}` whose
//!      parent ref is the mounting node.
//!   3. `view.render(tree)` ships a serialized widget tree in which event
//!      handlers have become `{"callable": <namespaced cb>}` wire tags.
//!   4. Firing that callback the way the node does — `__godotDispatch([cb,
//!      args])` — reaches the guest closure, mutates state, and the next render
//!      reflects it. This is the widget-event round trip a tap will drive.
//!
//! A mock host records the ops and hands back view handles; a watchdog turns a
//! regression (a wedged dispatch, a compile break) into a timeout.

use std::sync::{Arc, Mutex};

use elpian_godot::{GuestLang, VmManager};
use serde_json::{json, Value};

/// A tiny counter app written against `FL`. Kept inline so the test also serves
/// as a readable example of the intended guest API.
const APP: &str = r#"
import 'flutter.js';

var count = 0;

function App() {
  return FL.scaffold({
    appBar: FL.appBar(FL.text('Counter')),
    body: FL.center(FL.column([
      FL.text('Taps: ' + count, { size: 32 }),
      FL.filledButton('Tap me', function (a) {
        count = count + 1;
        print('tapped -> ' + count);
      }),
    ])),
  });
}

var view = FL.mount(GD.host(), App, { design: [720, 1280] });
print('flutter demo up');
"#;

/// Records the flutter.op traffic and mints view handles.
#[derive(Default)]
struct Mock {
    newviews: usize,
    renders: usize,
    last_parent_ref: Option<i64>,
    /// The most recent serialized widget tree.
    last_tree: Option<Value>,
    /// Namespaced cb id of the button's onTap, harvested from the render tree.
    tap_cb: Option<i64>,
    /// Every 'Text' data string seen across renders, in order.
    texts: Vec<String>,
}

impl Mock {
    fn exec(&mut self, op: &Value) -> Value {
        if op.get("newview").is_some() {
            self.newviews += 1;
            self.last_parent_ref =
                op.get("parent").and_then(|p| p.get("ref")).and_then(|v| v.as_i64());
            // Host-assigned surface handle (negative, like the Godot bridge).
            return json!(-100 - self.newviews as i64);
        }
        if let Some(tree) = op.get("tree") {
            self.renders += 1;
            self.harvest(tree);
            self.last_tree = Some(tree.clone());
            return Value::Null;
        }
        Value::Null
    }

    /// Walk the whole serialized tree (children AND prop-nested widgets like a
    /// Scaffold's `body` / an AppBar's `title`) collecting Text data and the
    /// onTap callable tag.
    fn harvest(&mut self, node: &Value) {
        match node {
            Value::Object(obj) => {
                if obj.get("t").and_then(|v| v.as_str()) == Some("Text") {
                    if let Some(s) =
                        obj.get("p").and_then(|p| p.get("data")).and_then(|v| v.as_str())
                    {
                        self.texts.push(s.to_string());
                    }
                }
                if let Some(cb) = obj.get("callable").and_then(|v| v.as_i64()) {
                    // Any callable tag; the app's only handler here is onTap.
                    self.tap_cb = Some(cb);
                }
                for (_k, v) in obj {
                    self.harvest(v);
                }
            }
            Value::Array(a) => {
                for v in a {
                    self.harvest(v);
                }
            }
            _ => {}
        }
    }
}

#[test]
fn flutter_widget_event_round_trip() {
    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mock = Arc::new(Mutex::new(Mock::default()));
            let mut mgr = VmManager::new_root_lang(
                "run-flutter-demo".to_string(),
                APP,
                GuestLang::Js,
                true,
                0,
                0,
            )
            .map_err(|e| format!("COMPILE ERROR: {e}"))?;

            let hooked = mock.clone();
            mgr.set_bridge(Some(Box::new(move |name, args| {
                let mut m = hooked.lock().unwrap();
                match name {
                    // The guest reaches GD.host() (a godot.op {"self"}) to get its
                    // mount node; hand back a stable node handle.
                    "godot.op" => {
                        let op = args.first().cloned().unwrap_or(Value::Null);
                        if op.get("self").is_some() {
                            return Some(json!(-1));
                        }
                        Some(Value::Null)
                    }
                    "flutter.op" => Some(m.exec(args.first().unwrap_or(&Value::Null))),
                    "flutter.batch" => {
                        let ops =
                            args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
                        Some(Value::Array(ops.iter().map(|op| m.exec(op)).collect()))
                    }
                    _ => None,
                }
            })));

            mgr.run_root().map_err(|e| format!("run_root() ERROR: {e}"))?;

            // After boot: one view, one render, parent ref is the mount node,
            // and the first Text reads "Taps: 0".
            let tap_cb = {
                let m = mock.lock().unwrap();
                if m.newviews != 1 {
                    return Err(format!("expected 1 mounted view, saw {}", m.newviews));
                }
                // The parent ref is the guest's own `GD.host()` handle, and the
                // VmManager has namespaced it into this VM's id space
                // (`(vm << 32) | local`) exactly as it does for native Godot
                // handles — so a mounted surface is bound to a node the VM's
                // sandbox actually contains. Assert it arrived as that positive
                // namespaced handle, not a raw guest-local id.
                match m.last_parent_ref {
                    Some(h) if h > (1i64 << 32) => {}
                    other => return Err(format!("view mounted under {other:?}, expected a namespaced parent handle")),
                }
                if !m.texts.iter().any(|t| t == "Taps: 0") {
                    return Err(format!("initial render missing 'Taps: 0'; saw {:?}", m.texts));
                }
                m.tap_cb.ok_or_else(|| "render tree carried no onTap callable tag".to_string())?
            };

            // Fire the tap exactly as ElpianVM would: the C++ FlutterController
            // queues (cb, args) on the engine event, the node delivers it via
            // __godotDispatch, and the framework's coalesced re-render lands on
            // the next pump — so tap, then pump, three times.
            for _ in 0..3 {
                mgr.invoke("__godotDispatch", json!([tap_cb, []]));
                mgr.pump(16).map_err(|e| format!("pump() ERROR: {e}"))?;
            }

            let m = mock.lock().unwrap();
            Ok::<String, String>(format!(
                "newviews={} renders={} texts={:?}",
                m.newviews, m.renders, m.texts
            ))
        }));
        let _ = tx.send(res.unwrap_or_else(|_| Err("PANIC".into())));
    });

    match rx.recv_timeout(std::time::Duration::from_secs(60)) {
        Ok(Ok(summary)) => {
            eprintln!("FLUTTER DEMO: {summary}");
            // 1 mount + 4 renders (initial + 3 taps).
            assert!(summary.contains("newviews=1"), "expected exactly one view: {summary}");
            assert!(summary.contains("renders=4"), "expected 4 renders (1+3 taps): {summary}");
            // The counter climbed 0 -> 3 across the re-renders, proving the
            // widget event reached the guest closure and re-render reflected it.
            assert!(summary.contains("Taps: 3"), "counter never reached 3: {summary}");
        }
        Ok(Err(e)) => panic!("flutter demo did not run cleanly: {e}"),
        Err(_) => panic!("TIMEOUT — flutter widget round trip wedged"),
    }
}
