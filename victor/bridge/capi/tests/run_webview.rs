//! VUI.webview regression: the webview prelude API must COMPILE under
//! js2elpian and, when driven against a mock engine, first try the
//! JavaScriptBridge DOM-overlay path and then fall back to the system
//! browser (OS.shell_open) when no bridge answers — reporting "browser".
//!
//! The mock answers every op generically (creations return fresh handles,
//! method calls return null), which is exactly the shape of a non-web
//! surface: JavaScriptBridge.eval yields nothing, so the guest must land
//! on the shell_open fallback with the original URL.

use std::sync::{Arc, Mutex};

use elpian_godot::{GuestLang, VmManager};
use serde_json::{json, Value};

const GUEST: &str = r#"
import 'godot.js';
import 'ui.js';

let r = VUI.webview({ url: "https://example.org/room/join?x=1", title: "Demo room" });
let closed = VUI.closeWebview();
let l = GD.create("Label");
l.set("text", "webview-result:" + r + ":" + (closed ? "closed" : "noop"));
"#;

#[derive(Default)]
struct Mock {
    next_handle: i64,
    singletons: Vec<String>,
    evals: Vec<String>,
    shell_opens: Vec<String>,
    texts: Vec<String>,
}

impl Mock {
    fn exec(&mut self, op: &Value) -> Value {
        if op.get("chk").is_some() {
            return json!(true);
        }
        if let Some(name) = op.get("singleton").and_then(|v| v.as_str()) {
            self.singletons.push(name.to_string());
            return op.get("def").cloned().unwrap_or_else(|| {
                self.next_handle -= 1;
                json!(self.next_handle)
            });
        }
        if op.get("set").and_then(|v| v.as_str()) == Some("text") {
            if let Some(s) = op.get("value").and_then(|v| v.as_str()) {
                self.texts.push(s.to_string());
            }
            return Value::Null;
        }
        if let Some(method) = op.get("method").and_then(|v| v.as_str()) {
            let arg0 = op
                .get("args")
                .and_then(|a| a.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            match method {
                // No web surface: eval returns nothing, like desktop/headless.
                "eval" => {
                    self.evals.push(arg0);
                    return Value::Null;
                }
                "shell_open" => {
                    self.shell_opens.push(arg0);
                    return Value::Null;
                }
                _ => {}
            }
            return Value::Null;
        }
        if op.get("new").is_some() || op.get("tree").is_some() || op.get("load").is_some() {
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
fn webview_compiles_and_falls_back_to_browser() {
    let mock = Arc::new(Mutex::new(Mock::default()));
    let mut mgr = VmManager::new_root_lang(
        "run-webview".to_string(),
        GUEST,
        GuestLang::Js,
        true,
        0,
        0,
    )
    .unwrap_or_else(|e| panic!("COMPILE ERROR: {e}"));
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

    mgr.run_root().unwrap_or_else(|e| panic!("run_root() ERROR: {e}"));

    let m = mock.lock().unwrap();
    assert!(
        m.singletons.iter().any(|s| s == "JavaScriptBridge"),
        "webview never consulted the JavaScriptBridge; singletons: {:?}",
        m.singletons
    );
    let overlay_eval = m
        .evals
        .iter()
        .find(|c| c.contains("vui-webview"))
        .unwrap_or_else(|| panic!("no DOM-overlay eval was attempted; evals: {:?}", m.evals));
    assert!(
        overlay_eval.contains("https://example.org/room/join?x=1"),
        "overlay snippet does not embed the URL: {overlay_eval}"
    );
    assert!(
        overlay_eval.contains("iframe") && overlay_eval.contains("camera; microphone"),
        "overlay snippet lost the iframe / media permissions: {overlay_eval}"
    );
    assert_eq!(
        m.shell_opens,
        vec!["https://example.org/room/join?x=1".to_string()],
        "the browser fallback must open exactly the requested URL"
    );
    assert_eq!(
        m.texts,
        vec!["webview-result:browser:noop".to_string()],
        "guest observed the wrong webview result"
    );
}
