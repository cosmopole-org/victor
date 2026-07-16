//! VReact regression: the shipped React demo (godot.js + ui.js + react.js +
//! project/scripts/react_demo.js) must COMPILE in the js2elpian subset and RUN
//! the way the ElpianVM node drives it — `run_root()` for the top-level
//! `VictorClient.mountApp(...)`, then bridged signal dispatch + `pump` for the
//! event loop that flushes setState microtasks and effects.
//!
//! This is the machine check that the whole runtime — element factory, the
//! hook surface, the keyed reconciler and every host driver — stays inside the
//! subset (a syntax/semantics regression fails `new_root_lang` to compile) and
//! that mounting a real component tree emits the expected Godot Control ops.
//! Pressing the counter's "+" button then drives a setState → re-render →
//! node-patch round-trip end to end.

use std::sync::{Arc, Mutex};

use elpian_godot::{GuestLang, VmManager};
use serde_json::{json, Value};

/// A permissive recording mock: every op that must return a handle gets one,
/// signal connects are remembered so the test can fire them back, and property
/// sets are recorded for assertions.
#[derive(Default)]
struct Mock {
    ops: usize,
    creates: std::collections::HashMap<String, usize>,
    next_handle: i64,
    /// (signal, namespaced cb id) in connection order.
    connects: Vec<(String, i64)>,
    /// recorded `set text` values, newest last.
    texts: Vec<String>,
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
            match method {
                "get_root" | "create_tween" | "get_parent" => {
                    self.next_handle -= 1;
                    return json!({"obj": self.next_handle, "class": "Object"});
                }
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
        .expect("the React runtime + demo must COMPILE in the js2elpian subset");
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
    mgr.run_root().expect("mountApp(<App/>) must run");
    (mgr, mock)
}

const DEMO: &str = include_str!("../../project/scripts/react_demo.js");

#[test]
fn react_demo_compiles_and_mounts_the_tree() {
    let (_mgr, mock) = boot("react-demo", DEMO);
    let m = mock.lock().unwrap();
    // The VUI app root + the React tree: a CanvasLayer, a ScrollContainer, the
    // Buttons (counter +/- and each todo's toggle), and Labels for the text.
    assert!(m.created("CanvasLayer") >= 1, "app never created its CanvasLayer");
    assert!(
        m.created("ScrollContainer") >= 1,
        "the <scroll> root never mounted"
    );
    assert!(
        m.created("Button") >= 5,
        "expected the counter +/- and 3 todo buttons, got {}",
        m.created("Button")
    );
    assert!(m.created("Label") >= 5, "headings/captions/text never mounted");
    // Signals were bound (one `pressed` per button).
    let pressed = m
        .connects
        .iter()
        .filter(|(s, _)| s == "pressed")
        .count();
    assert!(pressed >= 5, "expected >=5 pressed connects, got {pressed}");
}

#[test]
fn react_counter_setstate_rerenders_over_the_bridge() {
    let (mut mgr, mock) = boot("react-counter", DEMO);

    // Find the counter "+" press callback. In mount order the counter renders
    // before the todo list, and its buttons connect "-" then "+", so the 2nd
    // pressed connection is "+".
    let plus_cb = {
        let m = mock.lock().unwrap();
        let pressed: Vec<i64> = m
            .connects
            .iter()
            .filter(|(s, _)| s == "pressed")
            .map(|(_, cb)| *cb)
            .collect();
        pressed.get(1).copied().expect("a second pressed callback (+)")
    };

    let texts_before = mock.lock().unwrap().texts.len();

    // Press "+", then pump frames so the setState microtask + effect flush run.
    mgr.invoke("__godotDispatch", json!([plus_cb, []]));
    for _ in 0..4 {
        mgr.invoke("__godotEvent", json!(["_process", 0.016]));
        mgr.pump(16).expect("pump must not wedge");
    }

    // The re-render pushed a new "Value: 1" label text over the bridge…
    let m = mock.lock().unwrap();
    assert!(
        m.texts.len() > texts_before,
        "no property writes after setState — re-render did not commit"
    );
    assert!(
        m.texts.iter().any(|t| t == "Value: 1"),
        "counter never re-rendered to 1; texts: {:?}",
        m.texts
    );

    // The effect (and its cleanup for the previous value) logged to the console.
    drop(m);
    let log = mgr.take_log().join("\n");
    assert!(
        log.contains("count committed: 1"),
        "useEffect did not run after the update; log:\n{log}"
    );
}
