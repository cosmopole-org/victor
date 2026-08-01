//! Capture the **real** `godot.op` stream the shipped showcase emits for its
//! embedded `RN.Scene3D`, so a headless Godot can replay it and prove the app's
//! actual 3D content builds a real Godot 3D scene (see
//! `bridge/project/headless_replay_showcase3d.gd`).
//!
//!   cargo run -p elpian-rn --example capture_godot_ops > ops.json
//!
//! Runs `assets/guest/showcase.js` on the real multi-VM manager with the
//! reactnative.js + godot.js preludes composed (exactly what the Expo app does),
//! records every `godot.op`/`godot.batch` the guest forwards, and prints
//! `{ "mount": <mount-node-handle>, "ops": [ …godot ops in order… ] }`. Handles
//! are guest-allocated (`__gdAllocId` → `def`), so the stream is deterministic
//! and replayable against a fresh Godot controller.

use std::cell::RefCell;
use std::rc::Rc;

use elpian_godot::{GuestLang, VmManager};
use serde_json::{json, Value};

fn main() {
    let source = include_str!("../../../assets/guest/showcase.js");

    let ops: Rc<RefCell<Vec<Value>>> = Rc::new(RefCell::new(Vec::new()));
    let mount: Rc<RefCell<i64>> = Rc::new(RefCell::new(0));
    let sink = ops.clone();
    let mount_sink = mount.clone();

    let mut mgr = VmManager::new_root_lang(
        "capture-vm".to_string(),
        source,
        GuestLang::Js,
        true, // compose the preludes (godot.js + reactnative.js)
        0,
        0,
    )
    .expect("showcase.js should compile in the js2elpian subset");

    mgr.set_bridge(Some(Box::new(move |name: &str, args: &[Value]| {
        match name {
            // Record the 3D ops in order. Creating ops carry a guest `def`; echo
            // it so the guest's chained G3 calls keep flowing.
            "godot.op" => {
                if let Some(op) = args.first() {
                    sink.borrow_mut().push(op.clone());
                    if let Some(def) = op.get("def").and_then(|v| v.as_i64()) {
                        return Some(json!(def));
                    }
                }
                Some(Value::Null)
            }
            "godot.batch" => {
                if let Some(Value::Array(list)) = args.first() {
                    let mut replies = Vec::with_capacity(list.len());
                    for op in list {
                        sink.borrow_mut().push(op.clone());
                        replies.push(op.get("def").cloned().unwrap_or(Value::Null));
                    }
                    return Some(Value::Array(replies));
                }
                Some(Value::Null)
            }
            // The 2D seam: we only need the Scene3D mount-node handle the guest
            // allocated (args[0].ref of scene3d_mount) so the replay can seed it.
            "rn.op" => {
                if let Some(op) = args.first() {
                    if op.get("method").and_then(|v| v.as_str()) == Some("scene3d_mount") {
                        if let Some(node) = op
                            .get("args")
                            .and_then(|a| a.get(0))
                            .and_then(|r| r.get("ref"))
                            .and_then(|v| v.as_i64())
                        {
                            *mount_sink.borrow_mut() = node;
                        }
                    }
                    if let Some(def) = op.get("def").and_then(|v| v.as_i64()) {
                        return Some(json!(def));
                    }
                }
                Some(Value::Null)
            }
            _ => Some(Value::Null),
        }
    })));

    mgr.run_root().expect("showcase main() should run");

    let out = json!({
        "mount": *mount.borrow(),
        "ops": *ops.borrow(),
    });
    println!("{}", serde_json::to_string(&out).expect("serialize ops"));
    eprintln!(
        "captured {} godot ops; mount handle = {}",
        ops.borrow().len(),
        mount.borrow()
    );
}
