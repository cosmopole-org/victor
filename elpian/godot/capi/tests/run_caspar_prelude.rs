//! caspar.js prelude coverage: the Caspar signed binary action protocol
//! client that Victor ships for guests (`import 'caspar.js';`).
//!
//!   * the length-prefixed wire framing round-trips byte-for-byte
//!     (lp(sig)|lp(user)|lp(path)|lp(pkt)|payload; multi-byte UTF-8;
//!     truncation safety);
//!   * `Caspar.connect` opens and pumps a `StreamPeerTCP` (the default
//!     transport) and a `WebSocketPeer` (`transport: 'ws'` — the path a
//!     browser-served web export takes, where raw TCP is unavailable).
//!
//! The CaspiGames super-app built on this prelude lives in the CaspiGames
//! platform repo; its client/system tests (`client/tests/` there) are
//! injected into this crate's tests directory and run by that repo's e2e
//! pipeline (`e2e/test-client.sh`).

use std::cell::RefCell;
use std::rc::Rc;

use elpian_godot::{GuestLang, VmManager};
use serde_json::{json, Value};

#[derive(Default)]
struct Mock {
    ops: Vec<Value>,
    next_host_handle: i64,
    /// method-name call log (order preserved)
    methods: Vec<String>,
}

impl Mock {
    fn exec(&mut self, op: &Value) -> Value {
        self.ops.push(op.clone());
        if op.get("chk").is_some() {
            return json!(true);
        }
        if op.get("connect").is_some() {
            return Value::Null;
        }
        if let Some(method) = op.get("method").and_then(|v| v.as_str()) {
            self.methods.push(method.to_string());
            match method {
                "get_root" | "create_tween" | "get_parent" => {
                    self.next_host_handle -= 1;
                    return json!({"obj": self.next_host_handle, "class": "Object"});
                }
                // StreamPeerTCP surface the caspar.js pump touches.
                "connect_to_host" | "put_data" => return json!(0),
                "get_status" => return json!(1), // CONNECTING — keeps the pump idle
                "get_available_bytes" => return json!(0),
                _ => {}
            }
            return Value::Null;
        }
        if op.get("new").is_some()
            || op.get("singleton").is_some()
            || op.get("tree").is_some()
            || op.get("self").is_some()
            || op.get("load").is_some()
        {
            return op.get("def").cloned().unwrap_or_else(|| {
                self.next_host_handle -= 1;
                json!(self.next_host_handle)
            });
        }
        if op.get("const").is_some() {
            return json!(1);
        }
        Value::Null
    }

    fn created(&self, class: &str) -> usize {
        self.ops
            .iter()
            .filter(|op| op.get("new").and_then(|v| v.as_str()) == Some(class))
            .count()
    }
}

fn boot_js(id: &str, source: &str) -> (VmManager, Rc<RefCell<Mock>>) {
    let mock = Rc::new(RefCell::new(Mock::default()));
    let mut mgr = VmManager::new_root_lang(id.to_string(), source, GuestLang::Js, true, 0, 0)
        .expect("JS guest must compile");
    let hooked = mock.clone();
    mgr.set_bridge(Some(Box::new(move |name, args| {
        let mut m = hooked.borrow_mut();
        match name {
            "godot.op" => Some(m.exec(args.first().unwrap_or(&Value::Null))),
            "godot.batch" => {
                let ops = args.first().and_then(|v| v.as_array()).cloned().unwrap_or_default();
                Some(Value::Array(ops.iter().map(|op| m.exec(op)).collect()))
            }
            _ => None,
        }
    })));
    mgr.run_root().expect("main() must run");
    (mgr, mock)
}
/// caspar.js composes on import and its length-prefixed framing round-trips:
/// request bodies build as lp(sig)|lp(user)|lp(path)|lp(pkt)|payload and the
/// response/update parsers read back exactly what was written.
#[test]
fn caspar_framing_round_trips() {
    let src = r#"
        import 'godot.js';
        import 'caspar.js';
        function main() {
            // u32be round-trip.
            let buf = [];
            __cspPushBe32(buf, 305419896); // 0x12345678
            if (buf[0] != 18 || buf[1] != 52 || buf[2] != 86 || buf[3] != 120) {
                print('FAIL be32 encode: ' + buf[0] + ',' + buf[1] + ',' + buf[2] + ',' + buf[3]);
                return;
            }
            if (__cspBe32At(buf, 0) != 305419896) {
                print('FAIL be32 decode');
                return;
            }
            // lp round-trip, including multi-byte utf8.
            let body = [];
            __cspPushLp(body, "sig-α");
            __cspPushLp(body, "/creatures/signal");
            let f1 = __cspReadLp(body, 0);
            if (f1 == null || f1.s != "sig-α") {
                print('FAIL lp field 1');
                return;
            }
            let f2 = __cspReadLp(body, f1.pos);
            if (f2 == null || f2.s != "/creatures/signal") {
                print('FAIL lp field 2');
                return;
            }
            if (f2.pos != body.length) {
                print('FAIL lp consumed length');
                return;
            }
            // Truncation safety.
            if (__cspReadLp(body.slice(0, 3), 0) != null) {
                print('FAIL truncated lp must be null');
                return;
            }
            print('framing OK');

            // A live handle opens a StreamPeerTCP and reports its state.
            let node = Caspar.connect({ host: '127.0.0.1', port: 8074 });
            print('handle status: ' + node.status());
        }
        main();
    "#;
    let (mut mgr, mock) = boot_js("caspar-framing", src);
    for _ in 0..5 {
        mgr.pump(33).expect("pump");
    }
    let log = mgr.take_log().join("\n");
    assert!(log.contains("framing OK"), "log was: {log}");
    assert!(log.contains("handle status: connecting"), "log was: {log}");
    {
        let m = mock.borrow();
        assert_eq!(m.created("StreamPeerTCP"), 1, "the client rides StreamPeerTCP");
        assert!(
            m.methods.iter().any(|x| x == "connect_to_host"),
            "connect_to_host must be issued"
        );
        assert!(
            m.methods.iter().any(|x| x == "poll"),
            "the pump must poll the peer"
        );
    }
}

/// The WebSocket transport: `Caspar.connect({transport:'ws'})` rides a
/// `WebSocketPeer` (connect_to_url + poll) instead of a StreamPeerTCP —
/// the path a browser-served web export takes, where raw TCP is unavailable.
#[test]
fn caspar_ws_transport_opens_a_websocket_peer() {
    let src = r#"
        import 'godot.js';
        import 'caspar.js';
        function main() {
            let node = Caspar.connect({ host: 'game.example', port: 8076, transport: 'ws' });
            print('ws handle: ' + node.transport() + ' ' + node.status());
        }
        main();
    "#;
    let (mut mgr, mock) = boot_js("caspar-ws", src);
    for _ in 0..5 {
        mgr.pump(33).expect("pump");
    }
    let log = mgr.take_log().join("\n");
    assert!(log.contains("ws handle: ws connecting"), "log was: {log}");
    {
        let m = mock.borrow();
        assert_eq!(m.created("WebSocketPeer"), 1, "ws transport rides WebSocketPeer");
        assert_eq!(m.created("StreamPeerTCP"), 0, "no TCP peer in ws mode");
        assert!(
            m.methods.iter().any(|x| x == "connect_to_url"),
            "connect_to_url must be issued"
        );
        assert!(m.methods.iter().any(|x| x == "poll"), "the pump must poll the peer");
    }
}
