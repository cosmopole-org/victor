//! The shipped mixed Flutter-UI + Godot-3D demo (`project/scripts/flutter_3d_demo.js`)
//! must actually RUN — the way the ElpianVM node drives it — down BOTH paths:
//!
//!   * with a Flutter engine present (`FL.mount` succeeds): the real-Flutter UI
//!     boots, and per-frame `flView.update()` ships the CustomPaint gauge as a
//!     render op;
//!   * with no engine (every web export, and any build without
//!     `ELPIAN_WITH_FLUTTER`): `FL.mount` returns null and the demo falls back to
//!     the VUI HUD — the path the CI APK / web artifacts actually ship.
//!
//! This pins that the demo compiles (godot.js + ui.js + flutter.js + the program)
//! and boots either way, and that a 2D control still drives the shared state.

use std::sync::{Arc, Mutex};

use elpian_godot::{GuestLang, VmManager};
use serde_json::{json, Value};

// The two demo runs are each heavy (a full 3D world plus a UI); serialize them
// so they don't contend, mirroring run_tritonland's SERIAL guard.
static SERIAL: Mutex<()> = Mutex::new(());

#[derive(Default)]
struct Mock {
    next_handle: i64,
    /// When true, `newview` returns a handle (engine present); else null.
    flutter_available: bool,
    newviews: usize,
    renders: usize,
    creates_mesh_instance: usize,
    /// `pressed` callback ids in connection order (VUI buttons).
    pressed_cbs: Vec<i64>,
    /// RenderingServer `canvas_item_*` draw commands the VUI canvas emitted.
    canvas_ops: usize,
    /// `gui_input` connections (VUI gesture surfaces).
    gui_input_connects: usize,
    /// The most recent Flutter render tree.
    last_tree: Value,
}

impl Mock {
    fn godot(&mut self, op: &Value) -> Value {
        if op.get("chk").is_some() {
            return json!(true);
        }
        if let Some(sig) = op.get("connect").and_then(|v| v.as_str()) {
            let cb = op.get("cb").and_then(|v| v.as_i64()).unwrap_or(0);
            if sig == "pressed" {
                self.pressed_cbs.push(cb);
            }
            if sig == "gui_input" {
                self.gui_input_connects += 1;
            }
            return Value::Null;
        }
        if let Some(class) = op.get("new").and_then(|v| v.as_str()) {
            if class == "MeshInstance3D" {
                self.creates_mesh_instance += 1;
            }
        }
        if let Some(method) = op.get("method").and_then(|v| v.as_str()) {
            if method.starts_with("canvas_item_") {
                self.canvas_ops += 1;
                return Value::Null;
            }
            match method {
                // Returns an RID the VUI canvas draws into.
                "get_canvas_item" => {
                    self.next_handle -= 1;
                    return json!({ "rid": self.next_handle });
                }
                // These return engine objects the guest then calls methods on,
                // so hand back a marshaled object ({obj,class}) → a GObj, not a
                // bare handle (mirrors run_ui_demo's mock).
                "get_root" | "get_parent" | "create_tween" | "get_theme_default_font"
                | "get_theme_default_base_scale" | "duplicate" | "instantiate" => {
                    self.next_handle -= 1;
                    return json!({"obj": self.next_handle, "class": "Object"});
                }
                _ => {}
            }
            return Value::Null;
        }
        if op.get("new").is_some()
            || op.get("self").is_some()
            || op.get("tree").is_some()
            || op.get("singleton").is_some()
            || op.get("load").is_some()
        {
            return op.get("def").cloned().unwrap_or_else(|| {
                self.next_handle -= 1;
                json!(self.next_handle)
            });
        }
        if op.get("const").is_some() {
            return json!(1);
        }
        Value::Null
    }

    fn flutter(&mut self, op: &Value) -> Value {
        if op.get("newview").is_some() {
            self.newviews += 1;
            if self.flutter_available {
                return json!(-500 - self.newviews as i64);
            }
            return Value::Null; // no engine -> FL.mount returns null -> fallback
        }
        if let Some(tree) = op.get("tree") {
            self.renders += 1;
            self.last_tree = tree.clone();
        }
        Value::Null
    }
}

fn boot(available: bool) -> (VmManager, Arc<Mutex<Mock>>) {
    let src = include_str!("../../project/scripts/flutter_3d_demo.js");
    let mock = Arc::new(Mutex::new(Mock { flutter_available: available, ..Mock::default() }));
    let mut mgr = VmManager::new_root_lang("run-flutter-3d".to_string(), src, GuestLang::Js, true, 0, 0)
        .expect("demo must compile");
    let hooked = mock.clone();
    mgr.set_bridge(Some(Box::new(move |name, args| {
        let mut m = hooked.lock().unwrap();
        match name {
            "godot.op" => Some(m.godot(args.first().unwrap_or(&Value::Null))),
            "godot.batch" => {
                let ops = args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
                Some(Value::Array(ops.iter().map(|op| m.godot(op)).collect()))
            }
            "flutter.op" => Some(m.flutter(args.first().unwrap_or(&Value::Null))),
            "flutter.batch" => {
                let ops = args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
                Some(Value::Array(ops.iter().map(|op| m.flutter(op)).collect()))
            }
            _ => None,
        }
    })));
    (mgr, mock)
}

fn find_slider_cb(node: &Value) -> Option<i64> {
    match node {
        Value::Object(o) => {
            if o.get("t").and_then(|v| v.as_str()) == Some("Slider") {
                if let Some(cb) = o.get("p").and_then(|p| p.get("onChanged")).and_then(|v| v.get("callable")).and_then(|v| v.as_i64()) {
                    return Some(cb);
                }
            }
            o.values().find_map(find_slider_cb)
        }
        Value::Array(a) => a.iter().find_map(find_slider_cb),
        _ => None,
    }
}

#[test]
fn flutter_3d_demo_runs_with_engine() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (mut mgr, mock) = boot(true);
    mgr.run_root().expect("run_root");
    let boot_log = mgr.take_log().join("\n");
    mgr.invoke("__godotEvent", json!(["_ready", Value::Null]));

    {
        let m = mock.lock().unwrap();
        assert_eq!(m.newviews, 1, "should mount exactly one Flutter view");
        assert!(m.creates_mesh_instance >= 6, "the 3D ring should create >= 6 meshes, saw {}", m.creates_mesh_instance);
    }
    assert!(boot_log.contains("REAL Flutter engine"), "should report the Flutter path: {boot_log}");

    // Drive ~10 frames: the per-frame `flView.update()` should repaint the
    // CustomPaint gauge (render ops accumulate) without wedging.
    for _ in 0..10 {
        mgr.invoke("__godotEvent", json!(["_process", 0.016]));
        mgr.pump(16).unwrap();
    }
    let (renders, cb) = {
        let m = mock.lock().unwrap();
        (m.renders, find_slider_cb(&m.last_tree))
    };
    assert!(renders >= 5, "the per-frame gauge repaint should have rendered several times, saw {renders}");
    // The gauge tree carries the spin slider's onChanged handler.
    assert!(cb.is_some(), "the rendered Flutter UI should expose the spin slider callback");
}

#[test]
fn flutter_3d_demo_falls_back_to_vui() {
    let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let (mut mgr, mock) = boot(false);
    mgr.run_root().expect("run_root");
    let boot_log = mgr.take_log().join("\n");
    mgr.invoke("__godotEvent", json!(["_ready", Value::Null]));

    let (pressed, canvas_ops_boot) = {
        let m = mock.lock().unwrap();
        assert_eq!(m.newviews, 1, "FL.mount is attempted once");
        assert_eq!(m.renders, 0, "no Flutter render when the engine is absent");
        assert!(m.creates_mesh_instance >= 6, "the 3D ring still builds, saw {}", m.creates_mesh_instance);
        assert!(!m.pressed_cbs.is_empty(), "the VUI fallback should wire button 'pressed' handlers");
        // The native VUI canvas (the gauge + the gesture pad) emitted draw ops.
        assert!(m.canvas_ops > 20, "VUI.canvas should emit many RenderingServer draw ops, saw {}", m.canvas_ops);
        // The gesture pad wired gui_input.
        assert!(m.gui_input_connects >= 1, "the VUI gesture pad should connect gui_input, saw {}", m.gui_input_connects);
        (m.pressed_cbs.clone(), m.canvas_ops)
    };
    assert!(boot_log.contains("VUI fallback"), "should report the fallback path: {boot_log}");

    // Press the add/remove/colour/shape buttons; some rebuild the 3D ring, and
    // the demo must keep running (no wedge).
    let before = mock.lock().unwrap().creates_mesh_instance;
    for cb in pressed {
        mgr.invoke("__godotDispatch", json!([cb, []]));
    }
    for _ in 0..3 {
        mgr.invoke("__godotEvent", json!(["_process", 0.016]));
        mgr.pump(16).unwrap();
    }
    {
        let m = mock.lock().unwrap();
        // At least one button (add-shape / shape-picker) rebuilt the ring.
        assert!(m.creates_mesh_instance > before, "a control press should have rebuilt the 3D ring");
        // Per-frame VUI.repaint re-emitted the gauge's canvas ops (animation).
        assert!(m.canvas_ops > canvas_ops_boot, "per-frame VUI.repaint should re-emit canvas ops, boot={canvas_ops_boot} now={}", m.canvas_ops);
    }
}
