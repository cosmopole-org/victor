//! The shipped TPS game (project/scripts/tps_main.dart) must actually RUN the
//! way the ElpianVM node drives it: `run_root()` for main(), then per frame a
//! `__godotEvent _process` broadcast plus `pump(delta)`.
//!
//! Driven against a mock engine (all reads answer null), which by design
//! exercises the game's prediction/fallback layer: no assets import, no
//! physics answers, no raycast hits — and the game must still boot its city,
//! run its menu, start a mission, deploy waves whose hostiles close in and
//! shoot (Dart-side integration), kill the player, and restart cleanly.

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
            return json!(true);
        }
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
        if op.get("const").is_some() {
            return json!(0);
        }
        Value::Null
    }
}

#[test]
fn run_tps_game_end_to_end() {
    let game = include_str!("../../project/scripts/tps_main.dart");

    let (tx, rx) = std::sync::mpsc::channel::<String>();
    let source = game.to_string();
    std::thread::spawn(move || {
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mock = Arc::new(Mutex::new(Mock::default()));
            let mut mgr = VmManager::new_root("run-tps".to_string(), &source, true, 0, 0)
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

            // boot: main() builds the whole city + UI and lands in the menu
            mgr.run_root().map_err(|e| format!("run_root() ERROR: {e}"))?;
            mgr.invoke("__godotEvent", json!(["_ready", Value::Null]));
            let boot_log = mgr.take_log().join("\n");
            let booted = boot_log.contains("[tps] boot")
                && boot_log.contains("[tps] city built")
                && boot_log.contains("[tps] ready");
            let mounts_after_main = mock.lock().unwrap().mounts;

            // menu idles for a second of frames (the vista orbit must not error)
            for _ in 0..30 {
                mgr.invoke("__godotEvent", json!(["_process", 0.033]));
                mgr.pump(33).map_err(|e| format!("pump() ERROR (menu): {e}"))?;
            }

            // deploy: first mission. Under the mock the enemies advance on
            // Dart-side predicted positions, reach attack range and shoot; the
            // player takes fire until the run ends in a game over.
            mgr.invoke("tpsStartGame", json!([]));
            for i in 0..1200 {
                mgr.invoke("__godotEvent", json!(["_process", 0.033]));
                mgr.pump(33).map_err(|e| format!("pump() ERROR at frame {i}: {e}"))?;
            }
            mgr.invoke("tpsDebugStatus", json!([]));
            let mission_log = mgr.take_log().join("\n");
            let started = mission_log.contains("[tps] mission start");
            let wave1 = mission_log.contains("[tps] wave 1 deployed");
            let failed = mission_log.contains("[tps] mission failed");

            // restart: a second mission must come up clean; the debug hooks
            // must fire a shot, drop the nearest hostile and report status.
            mgr.invoke("tpsStartGame", json!([]));
            for _ in 0..150 {
                mgr.invoke("__godotEvent", json!(["_process", 0.033]));
                mgr.pump(33).map_err(|e| format!("pump() ERROR (restart): {e}"))?;
            }
            mgr.invoke("tpsDebugFire", json!([]));
            mgr.invoke("tpsDebugKillNearest", json!([]));
            mgr.invoke("tpsDebugStatus", json!([]));
            for _ in 0..30 {
                mgr.invoke("__godotEvent", json!(["_process", 0.033]));
                mgr.pump(33).map_err(|e| format!("pump() ERROR (post-kill): {e}"))?;
            }
            let restart_log = mgr.take_log().join("\n");
            let restarted = restart_log.contains("[tps] mission start")
                && restart_log.contains("[tps] wave 1 deployed");
            let hostile_down = restart_log.contains("[tps] hostile down");
            let status = restart_log.contains("[tps] status mode=");

            let (total_ops, total_mounts) = {
                let m = mock.lock().unwrap();
                (m.ops, m.mounts)
            };
            let alive = mgr.vm_alive(ROOT_VM);
            Ok::<String, String>(format!(
                "OK booted={booted} mounts_after_main={mounts_after_main} \
                 started={started} wave1={wave1} failed={failed} \
                 restarted={restarted} hostile_down={hostile_down} status={status} \
                 total_ops={total_ops} total_mounts={total_mounts} alive={alive}"
            ))
        }));
        let _ = tx.send(res.unwrap_or_else(|_| Err("PANIC".into())).unwrap_or_else(|e| e));
    });

    match rx.recv_timeout(std::time::Duration::from_secs(120)) {
        Ok(msg) => {
            eprintln!("TPS RESULT: {msg}");
            assert!(msg.starts_with("OK"), "the game did not run cleanly: {msg}");
            let fields: HashMap<&str, &str> = msg
                .split_whitespace()
                .filter_map(|kv| kv.split_once('='))
                .collect();
            assert_eq!(fields["booted"], "true", "boot log lines missing");
            assert!(
                fields["mounts_after_main"].parse::<usize>().unwrap() >= 60,
                "main() must mount the city, pools and UI (saw {})",
                fields["mounts_after_main"]
            );
            assert_eq!(fields["started"], "true", "mission must start");
            assert_eq!(fields["wave1"], "true", "wave 1 must deploy");
            assert_eq!(
                fields["failed"], "true",
                "under sustained fire the first mission must end in a game over"
            );
            assert_eq!(fields["restarted"], "true", "restart must run a fresh mission");
            assert_eq!(fields["hostile_down"], "true", "the debug kill must score");
            assert_eq!(fields["status"], "true", "the status hook must report");
            assert_eq!(fields["alive"], "true", "the root VM must stay healthy");
        }
        Err(_) => panic!(
            "TIMEOUT — the game wedged the frame loop (a spinning timer, an \
             unbounded loop, or a pump regression)"
        ),
    }
}
