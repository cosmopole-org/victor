//! Regression: the shipped demo (prelude + project/scripts/main.dart) must
//! actually RUN — not just compile — the way the ElpianVM node drives it:
//! `VmManager::run_root()` for main(), then per frame a `__godotEvent
//! _process` broadcast plus `pump(delta)` across the whole VM tree.
//!
//! The multi-VM demo's root spawns three children (one of which spawns a
//! grandchild), so this also pins that the whole tree boots against a mock
//! engine, that the rogue child's deliberate hang is trapped by its per-turn
//! budget (and the root notified), and that the physics child's periodic
//! timer keeps mounting bodies on real frame time. A watchdog turns a
//! regression into a timeout rather than a hung test run.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use elpian_godot::{VmManager, ROOT_VM};
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
        if op.get("chk").is_some() {
            return json!(true); // every pod is inside the parent sandbox
        }
        // An action op executes even when addressed via "self"/"tree" — mirror
        // the C++ dispatcher, where GD.mount is add_child on the sandbox root.
        if op.get("method").is_some() {
            if op.get("self").is_some()
                && op.get("method").and_then(|v| v.as_str()) == Some("add_child")
            {
                self.mounts += 1;
            }
            if op.get("method").and_then(|v| v.as_str()) == Some("get_parent") {
                return json!({"obj": -777, "class": "Node3D"});
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
        if let Some(name) = op.get("const").and_then(|v| v.as_str()) {
            return if name == "KEY_ESCAPE" { json!(4194305) } else { json!(0) };
        }
        Value::Null
    }
}

#[test]
fn run_shipped_demo_end_to_end() {
    let demo = include_str!("../../project/scripts/main.dart");

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let source = demo.to_string();
    std::thread::spawn(move || {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mock = Arc::new(Mutex::new(Mock::default()));
            let mut mgr = VmManager::new_root("run-demo".to_string(), &source, true, 0, 0)
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

            // main(): must return promptly despite installing Timer.periodic,
            // and must boot the whole child tree in the same call.
            mgr.run_root().map_err(|e| format!("run_root() ERROR: {e}"))?;
            mgr.invoke("__godotEvent", json!(["_ready", Value::Null]));

            // root + orbiter + physics + rogue + satellite (grandchild).
            let tree_size = mgr.vm_ids().len();

            let (ops_after_main, mounts_after_main) = {
                let m = mock.lock().unwrap();
                (m.ops, m.mounts)
            };

            // Drive ~8 seconds of 16ms frames: the physics child's 1500ms
            // periodic must fire repeatedly, and the rogue's 6s hang must be
            // trapped by its per-turn budget without wedging the frame loop.
            for i in 0..500 {
                mgr.invoke("__godotEvent", json!(["_process", 0.016]));
                mgr.pump(16).map_err(|e| format!("pump() ERROR at frame {i}: {e}"))?;
            }
            let (total_ops, total_mounts) = {
                let m = mock.lock().unwrap();
                (m.ops, m.mounts)
            };
            let rogue_alive = mgr.vm_alive(4);
            let log = mgr.take_log().join("\n");
            let trapped = log.contains("trapped");
            Ok::<String, String>(format!(
                "OK tree_size={tree_size} ops_after_main={ops_after_main} \
                 total_ops={total_ops} mounts_after_main={mounts_after_main} \
                 total_mounts={total_mounts} rogue_alive={rogue_alive} trapped={trapped}"
            ))
        }));
        let _ = tx.send(res.unwrap_or_else(|_| Err("PANIC".into())).unwrap_or_else(|e| e));
    });

    match rx.recv_timeout(std::time::Duration::from_secs(60)) {
        Ok(msg) => {
            eprintln!("DEMO RESULT: {msg}");
            assert!(msg.starts_with("OK"), "demo did not run cleanly: {msg}");
            let fields: HashMap<&str, &str> = msg
                .split_whitespace()
                .filter_map(|kv| kv.split_once('='))
                .collect();
            let num = |k: &str| fields[k].parse::<usize>().unwrap();
            assert_eq!(
                num("tree_size"),
                5,
                "root + 3 children + 1 grandchild must have booted"
            );
            assert!(
                num("mounts_after_main") >= 6,
                "main() + child boots must mount their scene roots (saw {})",
                num("mounts_after_main")
            );
            assert!(
                num("total_mounts") > num("mounts_after_main"),
                "the physics child's periodic drop never mounted a body over 8s of frames"
            );
            assert_eq!(fields["rogue_alive"], "false", "the rogue's hang must be trapped");
            assert_eq!(fields["trapped"], "true", "the trap must be reported in the log");
        }
        Err(_) => panic!(
            "TIMEOUT — demo run_root/pump did not finish in 60s \
             (regression: a hung child wedging the frame loop, or a periodic \
             timer spinning the event loop)"
        ),
    }
}
