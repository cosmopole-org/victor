//! Regression: the shipped Victor UI demo (godot.js + ui.js +
//! project/scripts/ui_demo.js) must actually RUN — not just compile — the way
//! the ElpianVM node drives it: `run_root()` for main(), then per frame a
//! `__godotEvent _process` broadcast plus `pump(delta)`.
//!
//! Beyond booting, the test exercises the UI end to end against a mock
//! engine: it verifies the portrait/content-scale setup ops, then presses
//! EVERY button the page connected (in connection order) through the real
//! `__godotDispatch` path — which walks the bottom nav, counts taps, opens
//! dialogs/sheets/toasts, spawns the JavaScript child VM and terminates it —
//! and finally drives ~4s of frames so the dashboard's periodic refresh and
//! the child's lifecycle run on real frame time. A watchdog turns a
//! regression into a timeout rather than a hung test run.

use std::sync::{Arc, Mutex};

use elpian_godot::{GuestLang, VmManager};
use serde_json::{json, Value};

#[derive(Default)]
struct Mock {
    next_handle: i64,
    ops: usize,
    creates_canvas_layer: usize,
    creates_button: usize,
    creates_styleboxes: usize,
    window_sized: bool,
    scale_size_set: bool,
    orientation_set: bool,
    /// Namespaced cb ids of every `pressed` connect, in connection order.
    pressed_cbs: Vec<i64>,
    /// (signal, cb) for the value/text signals.
    value_cbs: Vec<(String, i64)>,
}

impl Mock {
    fn exec(&mut self, op: &Value) -> Value {
        self.ops += 1;
        if op.get("chk").is_some() {
            return json!(true);
        }
        if let Some(signal) = op.get("connect").and_then(|v| v.as_str()) {
            let cb = op.get("cb").and_then(|v| v.as_i64()).unwrap_or(0);
            if signal == "pressed" {
                self.pressed_cbs.push(cb);
            } else {
                self.value_cbs.push((signal.to_string(), cb));
            }
            return Value::Null;
        }
        if op.get("set").and_then(|v| v.as_str()) == Some("content_scale_size") {
            self.scale_size_set = true;
            return Value::Null;
        }
        if let Some(method) = op.get("method").and_then(|v| v.as_str()) {
            match method {
                "window_set_size" => self.window_sized = true,
                "screen_set_orientation" => self.orientation_set = true,
                "get_root" | "create_tween" | "get_parent" => {
                    self.next_handle -= 1;
                    return json!({"obj": self.next_handle, "class": "Object"});
                }
                _ => {}
            }
            return Value::Null;
        }
        if let Some(class) = op.get("new").and_then(|v| v.as_str()) {
            match class {
                "CanvasLayer" => self.creates_canvas_layer += 1,
                "Button" => self.creates_button += 1,
                "StyleBoxFlat" => self.creates_styleboxes += 1,
                _ => {}
            }
        }
        if op.get("new").is_some()
            || op.get("singleton").is_some()
            || op.get("tree").is_some()
            || op.get("self").is_some()
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
}

#[test]
fn run_shipped_ui_demo_end_to_end() {
    let demo = include_str!("../../project/scripts/ui_demo.js");

    let (tx, rx) = std::sync::mpsc::channel::<Result<String, String>>();
    let source = demo.to_string();
    std::thread::spawn(move || {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mock = Arc::new(Mutex::new(Mock::default()));
            let mut mgr =
                VmManager::new_root_lang("run-ui-demo".to_string(), &source, GuestLang::Js, true, 0, 0)
                    .map_err(|e| format!("COMPILE ERROR: {e}"))?;
            let hooked = mock.clone();
            mgr.set_bridge(Some(Box::new(move |name, args| {
                let mut m = hooked.lock().unwrap();
                match name {
                    "godot.op" => Some(m.exec(args.first().unwrap_or(&Value::Null))),
                    "godot.batch" => {
                        let ops =
                            args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
                        Some(Value::Array(ops.iter().map(|op| m.exec(op)).collect()))
                    }
                    _ => None,
                }
            })));

            mgr.run_root().map_err(|e| format!("run_root() ERROR: {e}"))?;
            mgr.invoke("__godotEvent", json!(["_ready", Value::Null]));

            {
                let m = mock.lock().unwrap();
                if m.creates_canvas_layer != 1 {
                    return Err(format!("expected 1 CanvasLayer, saw {}", m.creates_canvas_layer));
                }
                if !m.scale_size_set {
                    return Err("content_scale_size was never set (design-space fit)".into());
                }
                if !m.window_sized && !m.orientation_set {
                    return Err("portrait mode set neither orientation nor window size".into());
                }
                if m.creates_button < 15 {
                    return Err(format!("suspiciously few Buttons: {}", m.creates_button));
                }
                if m.creates_styleboxes < 30 {
                    return Err(format!("suspiciously few StyleBoxFlats: {}", m.creates_styleboxes));
                }
            }

            // Press every button the page wired at build time, in connection
            // order (nav items, chips, tiles, all button kinds, spawn/kill…).
            // Dialog/sheet buttons connect later and are exercised implicitly
            // by the toasts/dialogs those presses open.
            let initial_pressed: Vec<i64> = mock.lock().unwrap().pressed_cbs.clone();
            for cb in &initial_pressed {
                mgr.invoke("__godotDispatch", json!([cb, []]));
            }
            // Drive the value signals too: the slider and the text field.
            let value_cbs: Vec<(String, i64)> = mock.lock().unwrap().value_cbs.clone();
            for (signal, cb) in &value_cbs {
                match signal.as_str() {
                    "value_changed" => mgr.invoke("__godotDispatch", json!([cb, [42.5]])),
                    "text_changed" | "text_submitted" => {
                        mgr.invoke("__godotDispatch", json!([cb, ["elpian"]]))
                    }
                    _ => {}
                }
            }

            // ~4s of 16ms frames: the 1s dashboard refresh must tick and the
            // spawned child's 2s heartbeat must have arrived before the kill.
            for i in 0..250 {
                mgr.invoke("__godotEvent", json!(["_process", 0.016]));
                mgr.pump(16).map_err(|e| format!("pump() ERROR at frame {i}: {e}"))?;
            }

            let total_ops = mock.lock().unwrap().ops;
            let log = mgr.take_log().join("\n");
            Ok::<String, String>(format!("total_ops={total_ops}\n{log}"))
        }));
        let _ = tx.send(res.unwrap_or_else(|_| Err("PANIC".into())));
    });

    match rx.recv_timeout(std::time::Duration::from_secs(120)) {
        Ok(Ok(log)) => {
            eprintln!("UI DEMO LOG:\n{log}");
            // Boot.
            assert!(log.contains("victor ui demo up: portrait 720x1280"), "boot line missing");
            // The nav walked all three pages.
            assert!(log.contains("nav -> page 1"), "widgets page never selected");
            assert!(log.contains("nav -> page 2"), "system page never selected");
            // The tap counter counted.
            assert!(log.contains("ui tap #1"), "the filled button never counted a tap");
            // Selection controls reacted.
            assert!(log.contains("toggle animations -> false"), "toggle never flipped");
            assert!(log.contains("checkbox -> true"), "checkbox never checked");
            // The slider / field signals reached the guest closures.
            assert!(log.contains("slider: 43") || log.contains("slider: 42"), "slider callback missing");
            assert!(log.contains("field: elpian"), "text field callback missing");
            // The JS child VM lived: spawned, reported in, was terminated.
            assert!(log.contains("system: spawned child vm 2"), "child vm never spawned");
            assert!(
                log.contains("system: vm 2 says: child vm alive in its sandbox"),
                "child vm never messaged the UI"
            );
            assert!(
                log.contains("system: terminated child vm 2"),
                "child vm never terminated"
            );
        }
        Ok(Err(e)) => panic!("ui demo did not run cleanly: {e}"),
        Err(_) => panic!(
            "TIMEOUT — ui demo run_root/dispatch/pump did not finish in 120s \
             (regression: a wedged dispatch or a spinning timer)"
        ),
    }
}
