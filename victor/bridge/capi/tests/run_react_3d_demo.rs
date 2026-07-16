//! VReact 3D regression: the mixed 2D+3D React demo (godot.js incl. G3 + ui.js +
//! react.js + project/scripts/react_3d_demo.js) must COMPILE in the js2elpian
//! subset and RUN — building the SubViewport 2D<->3D bridge, the Node3D scene
//! (camera, light, floor, cubes), and driving `useFrame` rotation over pumped
//! frames the way the ElpianVM node does (_process broadcast + pump).

use std::sync::{Arc, Mutex};

use elpian_godot::{GuestLang, VmManager};
use serde_json::{json, Value};

#[derive(Default)]
struct Mock {
    next_handle: i64,
    creates: std::collections::HashMap<String, usize>,
    rotation_sets: usize,
    value_cbs: Vec<i64>,
}
impl Mock {
    fn exec(&mut self, op: &Value) -> Value {
        if op.get("chk").is_some() {
            return json!(true);
        }
        if let Some(sig) = op.get("connect").and_then(|v| v.as_str()) {
            let cb = op.get("cb").and_then(|v| v.as_i64()).unwrap_or(0);
            if sig == "value_changed" {
                self.value_cbs.push(cb);
            }
            return Value::Null;
        }
        if op.get("set").and_then(|v| v.as_str()) == Some("rotation_degrees") {
            self.rotation_sets += 1;
            return Value::Null;
        }
        if op.get("set").is_some() {
            return Value::Null;
        }
        if let Some(class) = op.get("new").and_then(|v| v.as_str()) {
            *self.creates.entry(class.to_string()).or_insert(0) += 1;
            return op.get("def").cloned().unwrap_or_else(|| {
                self.next_handle -= 1;
                json!(self.next_handle)
            });
        }
        if let Some(m) = op.get("method").and_then(|v| v.as_str()) {
            if m == "get_root" || m == "get_parent" || m == "create_tween" {
                self.next_handle -= 1;
                return json!({"obj": self.next_handle, "class": "Object"});
            }
            return Value::Null;
        }
        if op.get("singleton").is_some()
            || op.get("tree").is_some()
            || op.get("self").is_some()
            || op.get("load").is_some()
            || op.get("get").is_some()
        {
            self.next_handle -= 1;
            return op.get("def").cloned().unwrap_or_else(|| json!(self.next_handle));
        }
        if op.get("const").is_some() || op.get("expr").is_some() {
            return json!(1);
        }
        Value::Null
    }
    fn created(&self, c: &str) -> usize {
        *self.creates.get(c).unwrap_or(&0)
    }
}

const DEMO: &str = include_str!("../../project/scripts/react_3d_demo.js");

fn boot(id: &str) -> (VmManager, Arc<Mutex<Mock>>) {
    let mock = Arc::new(Mutex::new(Mock::default()));
    let mut mgr = VmManager::new_root_lang(id.to_string(), DEMO, GuestLang::Js, true, 0, 0)
        .expect("the 3D demo + G3 + react.js must COMPILE in the js2elpian subset");
    let hooked = mock.clone();
    mgr.set_bridge(Some(Box::new(move |name, args| {
        let mut m = hooked.lock().unwrap();
        match name {
            "godot.op" => Some(m.exec(args.first().unwrap_or(&Value::Null))),
            "godot.batch" => {
                let ops = args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
                Some(Value::Array(ops.iter().map(|op| m.exec(op)).collect()))
            }
            _ => None,
        }
    })));
    mgr.run_root().expect("mountApp(<App/>) must run");
    (mgr, mock)
}

#[test]
fn react_3d_demo_builds_the_mixed_scene() {
    let (_mgr, mock) = boot("react-3d-scene");
    let m = mock.lock().unwrap();
    // The 2D<->3D bridge.
    assert!(m.created("SubViewportContainer") >= 1, "no <scene3d> viewport bridge");
    assert!(m.created("SubViewport") >= 1, "no SubViewport");
    // The 3D scene: camera, light, environment, floor plane + 3 cubes (each a
    // MeshInstance3D), and the spinner Node3D.
    assert!(m.created("Camera3D") >= 1, "no camera");
    assert!(m.created("DirectionalLight3D") >= 1, "no light");
    assert!(m.created("WorldEnvironment") >= 1, "no environment");
    assert!(m.created("Node3D") >= 1, "no spinner group");
    assert!(m.created("BoxMesh") >= 3, "expected >=3 cubes, got {}", m.created("BoxMesh"));
    assert!(m.created("PlaneMesh") >= 1, "no floor");
    assert!(
        m.created("MeshInstance3D") >= 4,
        "cubes + floor should be MeshInstance3D: {}",
        m.created("MeshInstance3D")
    );
    assert!(m.created("StandardMaterial3D") >= 4, "meshes need materials");
}

#[test]
fn react_3d_useframe_drives_rotation() {
    let (mut mgr, mock) = boot("react-3d-frame");

    // Let the useFrame effect register (effects flush on a microtask, drained
    // by pump), then broadcast _process frames like the engine does.
    for _ in 0..3 {
        mgr.pump(16).expect("pump");
    }
    let before = mock.lock().unwrap().rotation_sets;
    for _ in 0..5 {
        mgr.invoke("__godotEvent", json!(["_process", 0.016]));
        mgr.pump(16).expect("pump");
    }
    let after = mock.lock().unwrap().rotation_sets;
    assert!(
        after > before,
        "useFrame never set rotation_degrees on the spinner (before={before}, after={after})"
    );
}
