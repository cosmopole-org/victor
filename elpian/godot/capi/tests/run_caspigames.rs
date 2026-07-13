//! CaspiGames client coverage: the gaming super-app scene
//! (`project/scripts/caspigames.js`, composed with godot.js + ui.js +
//! caspar.js) must compile and BOOT against a mock engine, and the pieces the
//! platform stands on must hold:
//!
//!   * the connect form comes up first (fields for node URL + the main entry
//!     creature/program ids, per the discovery flow);
//!   * `import 'caspar.js'` composes, and the wire-framing helpers round-trip
//!     the Caspar length-prefixed layout byte-for-byte;
//!   * `Caspar.connect` opens a `StreamPeerTCP` and pumps it on the guest
//!     timer loop;
//!   * the Caspi SDK shim pattern (game -> parent JSON messages, parent ->
//!     game replies) bridges a sandboxed child VM to the platform proxy.

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

/// The shipped CaspiGames client boots to the connect form: the VUI shell
/// (transparent, CanvasLayer), five LineEdit form fields (host, port, main
/// creature id, main program id, player handle) and the enter button.
#[test]
fn caspigames_client_boots_to_connect_form() {
    let src = include_str!("../../project/scripts/caspigames.js");
    let (mut mgr, mock) = boot_js("caspigames", src);
    {
        let m = mock.borrow();
        assert_eq!(m.created("CanvasLayer"), 1, "one VUI app shell layer");
        assert!(
            m.created("LineEdit") >= 5,
            "the connect form needs host/port/creature/program/player fields, saw {}",
            m.created("LineEdit")
        );
        assert!(m.created("Button") >= 5, "connect + garage HUD buttons");
        // The 3D garage must NOT exist yet — it is built after discovery.
        assert_eq!(m.created("WorldEnvironment"), 0, "no garage before connect");
    }
    let log = mgr.take_log().join("\n");
    assert!(log.contains("client up"), "boot log was: {log}");

    // A few frames of the garage ticker while still on the connect page must
    // be inert (phase gate) — drive them to prove no crash.
    for _ in 0..5 {
        mgr.invoke("__godotEvent", json!(["_process", 0.016]));
        mgr.pump(16).expect("pump");
    }
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

/// The Caspi SDK shim contract: a sandboxed game VM reaches the platform
/// ONLY through JSON messages to its parent. This mirrors the shim inside
/// caspigames.js and pins the message shapes both sides rely on:
/// child {caspi:op, id, payload} -> parent; parent {caspi:'result', id,
/// payload} -> child callback.
#[test]
fn caspi_shim_pattern_bridges_game_to_platform() {
    let src = r#"
        import 'godot.js';
        var shim = [
          "var __caspi = { next: 1, cbs: {} };",
          "var Caspi = {};",
          "Caspi.request = (op, payload, cb) => {",
          "  let id = __caspi.next;",
          "  __caspi.next = id + 1;",
          "  if (cb != null) { __caspi.cbs['r' + id] = cb; }",
          "  VMs.sendParent(jsonStringify({ caspi: op, id: id, payload: payload ?? {} }));",
          "};",
          "Caspi.submitScore = (score, cb) => { Caspi.request('submitScore', { score: score }, cb); };",
          "VMs.onMessage((sender, msg) => {",
          "  let m = jsonParse('' + msg);",
          "  if (m == null) { return; }",
          "  if (m.caspi == 'result') {",
          "    let cb = __caspi.cbs['r' + m.id];",
          "    if (cb != null) { __caspi.cbs['r' + m.id] = null; cb(m.payload); }",
          "  }",
          "});",
        ].join("\n");
        var game = shim + "\n"
          + "function main() {\n"
          + "  Caspi.submitScore(420, (res) => {\n"
          + "    print('game: score ack ok=' + res.ok + ' best=' + res.best);\n"
          + "  });\n"
          + "}\n"
          + "main();\n";
        function main() {
            let pod = GD.create('Node3D');
            GD.mount(pod);
            VMs.onMessage((sender, msg) => {
                let m = jsonParse('' + msg);
                if (m == null || m.caspi == null) { return; }
                print('platform: ' + m.caspi + ' #' + m.id + ' score=' + m.payload.score);
                // Reply via the sender id: the child boots (and may message)
                // inside the spawn call, before any spawn return value could
                // have been captured.
                VMs.of(sender).send(jsonStringify({
                    caspi: 'result', id: m.id,
                    payload: { ok: true, best: m.payload.score },
                }));
            });
            // vm_manage stays granted: the vm.* family carries the SDK's
            // messaging channel and is tree-authorized anyway.
            let child = VMs.spawn(game, pod, { label: 'game:test' });
            if (child == null) { print('spawn FAILED'); }
        }
        main();
    "#;
    let (mut mgr, _mock) = boot_js("caspi-shim", src);
    // Message delivery is settled across frames; drive a few.
    for _ in 0..10 {
        mgr.pump(16).expect("pump");
    }
    let log = mgr.take_log().join("\n");
    assert!(
        log.contains("platform: submitScore #1 score=420"),
        "parent must receive the shim request — log was: {log}"
    );
    assert!(
        log.contains("game: score ack ok=true best=420"),
        "child callback must receive the platform reply — log was: {log}"
    );
}
