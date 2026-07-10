//! The TritonLand boot gate must RUN the way the exported APK drives it:
//! `run_root()` mounts the "/" connect screen, then bridged signal dispatch +
//! `pump` simulate typing the server URL and pressing "Dive In". Driven
//! against a recording mock engine, the press must survive (no VM error),
//! flip the UI into its busy state, and put a real HTTPRequest on the wire
//! (create + mount + `request(url)`), because on the device "nothing
//! happening" after the press means this exact path died.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use elpian_godot::{GuestLang, VmManager};
use serde_json::{json, Value};

#[derive(Default)]
struct Mock {
    ops: usize,
    creates: HashMap<String, usize>,
    next_handle: i64,
    /// (signal, namespaced cb id) in connection order.
    connects: Vec<(String, i64)>,
    /// recorded `set text` values, newest last.
    texts: Vec<String>,
    /// recorded method calls: (method, first-arg-as-string).
    calls: Vec<(String, String)>,
}

impl Mock {
    fn exec(&mut self, op: &Value) -> Value {
        self.ops += 1;
        if op.get("chk").is_some() {
            return json!(true);
        }
        if let Some(signal) = op.get("connect").and_then(|v| v.as_str()) {
            let cb = op.get("cb").and_then(|v| v.as_i64()).unwrap_or(0);
            self.connects.push((signal.to_string(), cb));
            return Value::Null;
        }
        if op.get("set").and_then(|v| v.as_str()) == Some("text") {
            if let Some(v) = op.get("value").and_then(|v| v.as_str()) {
                self.texts.push(v.to_string());
            }
            return Value::Null;
        }
        if let Some(class) = op.get("new").and_then(|v| v.as_str()) {
            *self.creates.entry(class.to_string()).or_insert(0) += 1;
            return op.get("def").cloned().unwrap_or_else(|| {
                self.next_handle -= 1;
                json!(self.next_handle)
            });
        }
        if let Some(method) = op.get("method").and_then(|v| v.as_str()) {
            let arg0 = op
                .get("args")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .map(|v| match v.as_str() {
                    Some(s) => s.to_string(),
                    None => v.to_string(),
                })
                .unwrap_or_default();
            self.calls.push((method.to_string(), arg0));
            match method {
                "get_root" | "create_tween" | "get_parent" => {
                    self.next_handle -= 1;
                    return json!({"obj": self.next_handle, "class": "Object"});
                }
                // HTTPRequest.request must report OK (0) or net.js treats it
                // as an immediate transport failure.
                "request" => return json!(0),
                _ => {}
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
            return op
                .get("def")
                .cloned()
                .unwrap_or_else(|| json!(self.next_handle));
        }
        if op.get("const").is_some() || op.get("expr").is_some() {
            return json!(1);
        }
        Value::Null
    }

    fn created(&self, class: &str) -> usize {
        *self.creates.get(class).unwrap_or(&0)
    }
}

fn boot(id: &str, source: &str) -> (VmManager, Arc<Mutex<Mock>>) {
    let mock = Arc::new(Mutex::new(Mock::default()));
    let mut mgr = VmManager::new_root_lang(id.to_string(), source, GuestLang::Js, true, 0, 0)
        .expect("the TritonLand guest must COMPILE in the js2elpian subset");
    let hooked = mock.clone();
    mgr.set_bridge(Some(Box::new(move |name, args| {
        let mut m = hooked.lock().unwrap();
        match name {
            "godot.op" => Some(m.exec(args.first().unwrap_or(&Value::Null))),
            "godot.batch" => {
                let ops = args
                    .first()
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                Some(Value::Array(ops.iter().map(|op| m.exec(op)).collect()))
            }
            _ => None,
        }
    })));
    mgr.run_root().expect("mounting the boot gate must run");
    (mgr, mock)
}

fn pump(mgr: &mut VmManager, frames: usize) {
    for _ in 0..frames {
        mgr.invoke("__godotEvent", json!(["_process", 0.016]));
        mgr.pump(16).expect("pump must not wedge");
    }
}

#[test]
fn dive_in_press_reaches_the_network() {
    let guest = std::fs::read_to_string("/home/user/TritonLand/victor-client/build/guest.js")
        .expect("guest.js must be built first (node tools/build.mjs)");
    let (mut mgr, mock) = boot("tritonland-boot", &guest);
    pump(&mut mgr, 3);

    // The boot gate mounted: a LineEdit (server URL) and a Button (Dive In).
    let (line_edits, buttons, text_changed_cb, pressed_cb) = {
        let m = mock.lock().unwrap();
        let tc = m
            .connects
            .iter()
            .find(|(s, _)| s == "text_changed")
            .map(|(_, cb)| *cb);
        let pr = m
            .connects
            .iter()
            .find(|(s, _)| s == "pressed")
            .map(|(_, cb)| *cb);
        (m.created("LineEdit"), m.created("Button"), tc, pr)
    };
    assert!(line_edits >= 1, "the server URL input never mounted");
    assert!(buttons >= 1, "the Dive In button never mounted");
    let text_changed_cb = text_changed_cb.expect("LineEdit text_changed never connected");
    let pressed_cb = pressed_cb.expect("Button pressed never connected");

    // Type the server URL, then press Dive In.
    mgr.invoke(
        "__godotDispatch",
        json!([text_changed_cb, ["https://tritonland.onrender.com"]]),
    );
    pump(&mut mgr, 2);
    mgr.invoke("__godotDispatch", json!([pressed_cb, []]));
    pump(&mut mgr, 4);

    let log = mgr.take_log().join("\n");
    let m = mock.lock().unwrap();

    // The press flipped the gate into its busy state…
    assert!(
        m.texts.iter().any(|t| t.contains("Contacting the Triton currents")),
        "busy status never rendered — the press handler died; texts: {:?}\nlog:\n{log}",
        m.texts
    );
    // …and a real HTTP request went on the wire.
    assert!(
        m.created("HTTPRequest") >= 1,
        "no HTTPRequest was created — Net.request never ran; log:\n{log}"
    );
    let req = m
        .calls
        .iter()
        .find(|(method, _)| method == "request")
        .map(|(_, url)| url.clone());
    assert_eq!(
        req.as_deref(),
        Some("https://tritonland.onrender.com/api/auth/me"),
        "the wrong (or no) URL was requested; calls: {:?}\nlog:\n{log}",
        m.calls.iter().take(40).collect::<Vec<_>>()
    );
    println!(
        "BOOT DIAG OK: {} ops, texts tail: {:?}",
        m.ops,
        m.texts.iter().rev().take(4).collect::<Vec<_>>()
    );
}
