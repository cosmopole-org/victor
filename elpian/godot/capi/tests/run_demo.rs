//! Regression: the shipped demo (prelude + project/scripts/main.dart) must
//! actually RUN — not just compile — the way the ElpianVM node drives it:
//! `run_realtime()` for main(), then `pump_frame(delta)` once per frame.
//!
//! The demo's `main()` installs a `Timer.periodic(2000, …)`. Under the old
//! batch drain (`run()` → `pump()`), that spun the event loop forever (each
//! tick jumping the virtual clock 2s and re-firing), so `elpian_godot_run`
//! never returned and the Godot app hung on the boot splash. This test guards
//! that `run_realtime()` returns promptly and the periodic timer fires on real
//! elapsed frame time instead. A watchdog turns a regression into a timeout
//! rather than a hung test run.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use dart::governance::{DartCapabilitySet, ResourceMeter};
use dart::runtime::DartRuntime;
use elpian_godot::compose_godot_program;
use serde_json::{json, Value};

#[derive(Default)]
struct Mock {
    next_handle: i64,
    ops: usize,
    mounts: usize,
}

impl Mock {
    fn exec(&mut self, op: &Value) -> Value {
        self.ops += 1;
        // An action op executes even when addressed via "self"/"tree" — mirror
        // the C++ dispatcher, where GD.mount is add_child on the hosting node.
        if op.get("method").is_some() {
            if op.get("self").is_some()
                && op.get("method").and_then(|v| v.as_str()) == Some("add_child")
            {
                self.mounts += 1;
            }
            return Value::Null;
        }
        let def = op.get("def").and_then(|v| v.as_i64());
        if op.get("new").is_some()
            || op.get("singleton").is_some()
            || op.get("tree").is_some()
            || op.get("self").is_some()
            || op.get("load").is_some()
        {
            return match def {
                Some(d) => json!(d),
                None => {
                    self.next_handle -= 1;
                    json!(self.next_handle)
                }
            };
        }
        if op.get("audit").is_some() {
            return json!({"dict": {
                "classes": 900, "instantiable": 500, "methods": 12000,
                "properties": 4000, "signals": 800, "constants": 5000,
                "singletons": 20, "unreachable": []
            }});
        }
        if let Some(name) = op.get("const").and_then(|v| v.as_str()) {
            return if name == "KEY_ESCAPE" { json!(4194305) } else { json!(0) };
        }
        Value::Null
    }
}

fn hook(mock: Arc<Mutex<Mock>>) -> impl Fn(&str, &[Value]) -> Option<Value> + Send + 'static {
    move |name, args| {
        let mut m = mock.lock().unwrap();
        match name {
            "godot.op" => Some(m.exec(args.first().unwrap_or(&Value::Null))),
            "godot.batch" => {
                let ops =
                    args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
                Some(Value::Array(ops.iter().map(|op| m.exec(op)).collect()))
            }
            _ => None,
        }
    }
}

#[test]
fn run_shipped_demo_end_to_end() {
    let demo = include_str!("../../project/scripts/main.dart");
    let program = compose_godot_program(demo);

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mock = Arc::new(Mutex::new(Mock::default()));
            let mut rt = DartRuntime::from_dart(
                "run-demo".to_string(),
                &program,
                DartCapabilitySet::full(),
                ResourceMeter::unbounded(),
            )
            .map_err(|e| format!("COMPILE ERROR: {e:?}"))?;
            rt.set_host_hook(Box::new(hook(mock.clone())));

            // main(): must return promptly despite installing Timer.periodic.
            rt.run_realtime().map_err(|e| format!("run_realtime() ERROR: {e:?}"))?;
            rt.deliver_event("__godotEvent", json!(["_ready", Value::Null]));

            let (ops_after_main, mounts_after_main) = {
                let m = mock.lock().unwrap();
                (m.ops, m.mounts)
            };

            // Drive ~3 seconds of 16ms frames; the 2000ms periodic must fire.
            for i in 0..200 {
                rt.deliver_event("__godotEvent", json!(["_process", 0.016]));
                rt.pump_frame(16).map_err(|e| format!("pump_frame() ERROR at frame {i}: {e:?}"))?;
            }
            let (total_ops, total_mounts) = {
                let m = mock.lock().unwrap();
                (m.ops, m.mounts)
            };
            Ok::<String, String>(format!(
                "OK ops_after_main={ops_after_main} total_ops={total_ops} \
                 mounts_after_main={mounts_after_main} total_mounts={total_mounts}"
            ))
        }));
        let _ = tx.send(res.unwrap_or_else(|_| Err("PANIC".into())).unwrap_or_else(|e| e));
    });

    match rx.recv_timeout(std::time::Duration::from_secs(20)) {
        Ok(msg) => {
            eprintln!("DEMO RESULT: {msg}");
            assert!(msg.starts_with("OK"), "demo did not run cleanly: {msg}");
            // Parse the two op counts; the periodic spawnBox must have fired
            // during the frame loop (more ops after frames than right after main).
            let nums: HashMap<&str, usize> = msg
                .split_whitespace()
                .filter_map(|kv| kv.split_once('='))
                .filter_map(|(k, v)| v.parse().ok().map(|n| (k, n)))
                .collect();
            let after_main = nums["ops_after_main"];
            let total = nums["total_ops"];
            assert!(
                total > after_main,
                "periodic Timer never fired over 3s of frames \
                 (after_main={after_main}, total={total})"
            );
            // main() mounts the GUI CanvasLayer, the floor, and the spinner;
            // each 2s periodic tick mounts another spawned box.
            let mounts_after_main = nums["mounts_after_main"];
            let total_mounts = nums["total_mounts"];
            assert!(
                mounts_after_main >= 3,
                "demo main() must mount its scene roots (saw {mounts_after_main})"
            );
            assert!(
                total_mounts > mounts_after_main,
                "periodic spawnBox never mounted a box over 3s of frames"
            );
        }
        Err(_) => panic!(
            "TIMEOUT — demo run_realtime/pump did not finish in 20s \
             (regression: periodic timer spinning the event loop)"
        ),
    }
}
