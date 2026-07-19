//! VUI.webview regression: the webview prelude API must COMPILE under
//! js2elpian and pick the right surface from its ladder when driven against
//! a mock engine:
//!
//!   1. DOM iframe via the JavaScriptBridge (web export) — the mock never
//!      answers eval, so this is attempted-then-skipped in every test;
//!   2. the ElpianWebView Android plugin (Engine.has_singleton);
//!   3. the godot_wry `WebView` Control (ClassDB.class_exists), mounted on
//!      the VUI app overlay under a title bar;
//!   4. the system browser via OS.shell_open.
//!
//! Three tests flip the mock's capabilities to land on each native rung and
//! the final fallback, asserting the surface report the guest observes and
//! the engine traffic (plugin open/close, WebView node + url, shell_open).

use std::sync::{Arc, Mutex};

use elpian_godot::{GuestLang, VmManager};
use serde_json::{json, Value};

const URL: &str = "https://example.org/room/join?x=1";

fn guest(with_app: bool) -> String {
    format!(
        r#"
import 'godot.js';
import 'ui.js';

{}
let r = VUI.webview({{ url: "{URL}", title: "Demo room" }});
let closed = VUI.closeWebview();
let l = GD.create("Label");
l.set("text", "webview-result:" + r + ":" + (closed ? "closed" : "noop"));
"#,
        if with_app { "VUI.app({});" } else { "" }
    )
}

#[derive(Default)]
struct Mock {
    // capabilities
    android_plugin: bool,
    wry_class: bool,
    web_surface: bool, // eval answers like a browser: prepare 1, cross-origin main snippet 2
    // recordings
    next_handle: i64,
    singletons: Vec<String>,
    evals: Vec<String>,
    shell_opens: Vec<String>,
    plugin_opens: Vec<(String, String)>,
    plugin_closes: usize,
    webview_nodes: Vec<i64>,
    webview_urls: Vec<String>,
    queue_frees: usize,
    texts: Vec<String>,
}

impl Mock {
    fn exec(&mut self, op: &Value) -> Value {
        if op.get("chk").is_some() {
            return json!(true);
        }
        let r = op.get("ref").and_then(|v| v.as_i64()).unwrap_or(0);
        if let Some(name) = op.get("singleton").and_then(|v| v.as_str()) {
            self.singletons.push(name.to_string());
            return op.get("def").cloned().unwrap_or_else(|| {
                self.next_handle -= 1;
                json!(self.next_handle)
            });
        }
        if let Some(prop) = op.get("set").and_then(|v| v.as_str()) {
            if prop == "url" && self.webview_nodes.contains(&r) {
                if let Some(s) = op.get("value").and_then(|v| v.as_str()) {
                    self.webview_urls.push(s.to_string());
                }
            }
            if prop == "text" {
                if let Some(s) = op.get("value").and_then(|v| v.as_str()) {
                    self.texts.push(s.to_string());
                }
            }
            return Value::Null;
        }
        if op.get("connect").is_some() {
            return Value::Null;
        }
        if op.get("free").is_some() {
            self.queue_frees += 1;
            return Value::Null;
        }
        if let Some(method) = op.get("method").and_then(|v| v.as_str()) {
            let args = op.get("args").and_then(|a| a.as_array());
            let arg0 = args
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            match method {
                "eval" => {
                    let is_deferred = arg0.contains("__vuiCfg");
                    let is_prepare = !is_deferred && arg0.contains("about:blank");
                    let is_cancel = !is_deferred
                        && !is_prepare
                        && arg0.contains("__vuiPendingTab")
                        && !arg0.contains("vui-webview");
                    let is_main = arg0.contains("vui-webview");
                    self.evals.push(arg0);
                    if !self.web_surface {
                        return Value::Null; // non-web surface: no DOM to answer
                    }
                    if is_deferred || is_prepare {
                        return json!("1"); // tab launched / reserved
                    }
                    if is_cancel {
                        return json!("0"); // nothing pending to cancel
                    }
                    if is_main {
                        // Browser-side the snippet sees a cross-origin URL and
                        // navigates the reserved tab.
                        return json!("2");
                    }
                    return Value::Null;
                }
                "has_singleton" => {
                    return json!(self.android_plugin && arg0 == "ElpianWebView");
                }
                "class_exists" => {
                    return json!(self.wry_class && arg0 == "WebView");
                }
                "open" => {
                    let title = args
                        .and_then(|a| a.get(1))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    self.plugin_opens.push((arg0, title));
                    return json!(true);
                }
                "close" => {
                    self.plugin_closes += 1;
                    return json!(true);
                }
                "queue_free" => {
                    self.queue_frees += 1;
                    return Value::Null;
                }
                // (queueFree actually rides the dedicated {free} op — see below.)
                "shell_open" => {
                    self.shell_opens.push(arg0);
                    return Value::Null;
                }
                "get_root" | "create_tween" | "get_parent" => {
                    self.next_handle -= 1;
                    return json!({"obj": self.next_handle, "class": "Object"});
                }
                _ => {}
            }
            return Value::Null;
        }
        if let Some(class) = op.get("new").and_then(|v| v.as_str()) {
            let handle = op.get("def").cloned().unwrap_or_else(|| {
                self.next_handle -= 1;
                json!(self.next_handle)
            });
            if class == "WebView" {
                if let Some(id) = handle.as_i64() {
                    self.webview_nodes.push(id);
                }
            }
            return handle;
        }
        if op.get("tree").is_some() || op.get("self").is_some() || op.get("load").is_some() {
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

fn run(name: &str, source: &str, android_plugin: bool, wry_class: bool) -> Mock {
    run_with(name, source, android_plugin, wry_class, false)
}

fn run_with(
    name: &str,
    source: &str,
    android_plugin: bool,
    wry_class: bool,
    web_surface: bool,
) -> Mock {
    let mock = Arc::new(Mutex::new(Mock {
        android_plugin,
        wry_class,
        web_surface,
        ..Mock::default()
    }));
    // Unique VM name per test: the VM registry is process-global and the
    // three tests run as parallel threads of one test binary.
    let mut mgr = VmManager::new_root_lang(
        format!("run-webview-{name}"),
        source,
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
    Arc::try_unwrap(mock)
        .map(|m| m.into_inner().unwrap())
        .unwrap_or_else(|arc| {
            let m = arc.lock().unwrap();
            Mock {
                android_plugin: m.android_plugin,
                wry_class: m.wry_class,
                web_surface: m.web_surface,
                next_handle: m.next_handle,
                singletons: m.singletons.clone(),
                evals: m.evals.clone(),
                shell_opens: m.shell_opens.clone(),
                plugin_opens: m.plugin_opens.clone(),
                plugin_closes: m.plugin_closes,
                webview_nodes: m.webview_nodes.clone(),
                webview_urls: m.webview_urls.clone(),
                queue_frees: m.queue_frees,
                texts: m.texts.clone(),
            }
        })
}

#[test]
fn webview_web_surface_opens_cross_origin_in_reserved_tab() {
    let guest_src = format!(
        r#"
import 'godot.js';
import 'ui.js';

let prepped = VUI.webviewPrepare();
let r = VUI.webview({{ url: "{URL}", title: "Demo room" }});
let l = GD.create("Label");
l.set("text", "webview-result:" + r + ":" + (prepped ? "prepped" : "noprep"));
"#
    );
    let m = run_with("webtab", &guest_src, false, false, true);
    assert!(
        m.evals.iter().any(|c| c.contains("about:blank")),
        "webviewPrepare never reserved a tab; evals: {}",
        m.evals.len()
    );
    let main = m
        .evals
        .iter()
        .find(|c| c.contains("vui-webview"))
        .expect("main webview snippet never evaluated");
    assert!(
        main.contains("__vuiPendingTab") && main.contains(URL),
        "main snippet must navigate the reserved tab to the URL: {main}"
    );
    assert!(
        m.shell_opens.is_empty() && m.plugin_opens.is_empty() && m.webview_nodes.is_empty(),
        "no other surface should fire when the browser handled it"
    );
    assert_eq!(m.texts, vec!["webview-result:tab:prepped".to_string()]);
}

#[test]
fn webview_deferred_tab_resolves_url_browser_side() {
    let guest_src = r#"
import 'godot.js';
import 'ui.js';

let r = VUI.webviewOpenDeferred({
  fetchUrl: "https://app.example/api/join?token=t1",
  jsonField: "join_url",
  title: "Demo room",
  failMessage: "Could not join",
});
let l = GD.create("Label");
l.set("text", "webview-result:" + r);
"#;
    let m = run_with("deferred", guest_src, false, false, true);
    let snippet = m
        .evals
        .iter()
        .find(|c| c.contains("__vuiCfg"))
        .expect("deferred-tab snippet never evaluated");
    assert!(
        snippet.contains("https://app.example/api/join?token=t1")
            && snippet.contains("join_url")
            && snippet.contains("location.replace"),
        "snippet must carry the fetch URL + field and self-navigate: {snippet}"
    );
    assert!(
        m.shell_opens.is_empty() && m.plugin_opens.is_empty() && m.webview_nodes.is_empty(),
        "no other surface should fire"
    );
    assert_eq!(m.texts, vec!["webview-result:tab".to_string()]);
}

#[test]
fn webview_falls_back_to_browser() {
    let m = run("browser", &guest(false), false, false);
    let overlay = m
        .evals
        .iter()
        .find(|c| c.contains("vui-webview"))
        .unwrap_or_else(|| panic!("no DOM-overlay eval was attempted; evals: {:?}", m.evals));
    assert!(
        overlay.contains(URL) && overlay.contains("iframe") && overlay.contains("camera; microphone"),
        "overlay snippet lost the URL / iframe / media permissions: {overlay}"
    );
    assert_eq!(
        m.shell_opens,
        vec![URL.to_string()],
        "the browser fallback must open exactly the requested URL"
    );
    assert!(m.plugin_opens.is_empty() && m.webview_nodes.is_empty());
    assert_eq!(m.texts, vec!["webview-result:browser:noop".to_string()]);
}

#[test]
fn webview_uses_android_plugin_when_present() {
    let m = run("android", &guest(false), true, false);
    assert_eq!(
        m.plugin_opens,
        vec![(URL.to_string(), "Demo room".to_string())],
        "the Android plugin must receive the open(url, title) call"
    );
    assert_eq!(m.plugin_closes, 1, "closeWebview must close the plugin overlay");
    assert!(
        m.shell_opens.is_empty(),
        "no browser fallback when the plugin handled it: {:?}",
        m.shell_opens
    );
    assert_eq!(m.texts, vec!["webview-result:native:closed".to_string()]);
}

#[test]
fn webview_uses_wry_node_when_class_registered() {
    let m = run("wry", &guest(true), false, true);
    assert_eq!(m.webview_nodes.len(), 1, "exactly one WebView Control expected");
    assert_eq!(
        m.webview_urls,
        vec![URL.to_string()],
        "the WebView node must be pointed at the requested URL"
    );
    assert!(
        m.shell_opens.is_empty() && m.plugin_opens.is_empty(),
        "no other surface should fire when the WebView class handles it"
    );
    assert!(m.queue_frees >= 1, "closeWebview must free the overlay holder");
    let report = m
        .texts
        .iter()
        .find(|t| t.starts_with("webview-result:"))
        .unwrap_or_else(|| panic!("no result label; texts: {:?}", m.texts));
    assert_eq!(report, "webview-result:native:closed");
}
