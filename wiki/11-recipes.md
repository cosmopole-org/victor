# 11 — Recipes (copy-paste patterns)

Working patterns for common tasks. Each is complete and follows the rules in
`12-gotchas.md`. Put a recipe in `victor/bridge/project/scripts/yourapp.js`,
point an `ElpianVM` node at it (`10-building-and-ci.md`), and run.

## A pure-2D app (VUI)

```js
import 'godot.js';
import 'ui.js';

VUI.use(VUI.themeDark());
let app = VUI.app({ design: [720, 1280], portrait: true });

let count = 0;
let label = VUI.title("Taps: 0");
app.push(VUI.column({ gap: 16, pad: 24, children: [
  label,
  VUI.button("Tap me", { kind: "filled", onTap: () => {
    count = count + 1;
    label.set("text", "Taps: " + count);
  }}),
  VUI.slider({ value: 0.5, onChanged: (v) => print("slider " + v) }),
  VUI.toggle({ value: true, onChanged: (on) => print("toggle " + on) }),
]}));
print("2D app up");
```

## A 3D scene (Godot bridge + G3)

```js
import 'godot.js';

let host = GD.host();
host.call("add_child", [G3.environment({ bg: new Color(0.04,0.05,0.09,1) })]);
host.call("add_child", [G3.dirLight({ energy: 1.3, shadow: true, rotation: [-50,-30,0] })]);
host.call("add_child", [G3.camera({ position: [0,3,9], rotation: [-16,0,0], fov: 52 })]);
host.call("add_child", [G3.mesh("plane", { width: 40, depth: 40, position: [0,-1,0], color: new Color(0.1,0.12,0.17,1) })]);

let spinner = G3.node({});
host.call("add_child", [spinner]);
let n = 6;
for (let i = 0; i < n; i++) {
  let pivot = G3.node({ rotation: [0, i * 360 / n, 0] });     // ring without trig
  pivot.call("add_child", [G3.mesh("torus", { position: [2.6,0,0], color: new Color(0.4,0.6,1,1) })]);
  spinner.call("add_child", [pivot]);
}
let angle = 0;
GD.onProcess((d) => { angle = angle + d * 40; spinner.set("rotation_degrees", new Vector3(0, angle, 0)); });
print("3D scene up");
```

## A mixed 2D UI over a 3D scene

Combine the two: build the 3D world under `GD.host()`, then a **transparent**
VUI page (`bg: false`) so the 3D shows through, with controls in a bottom panel.
The shipped `victor/bridge/project/scripts/flutter_3d_demo.js` is the reference —
read it. Skeleton:

```js
import 'godot.js';
import 'ui.js';

buildWorld();                                   // the 3D scene under GD.host()
VUI.use(VUI.themeDark());
let app = VUI.app({ design: [720,1280], portrait: true, bg: false });   // bg:false!
app.push(VUI.column({ gap: 0, children: [
  VUI.spacer(),                                 // top: 3D shows here
  VUI.panel({ pad: 18, radius: 22, child: VUI.column({ gap: 12, children: [
    VUI.title("Controls"),
    VUI.slider({ value: 0.3, onChanged: (v) => setSpeed(v * 180) }),
  ]}) }),
]}));
GD.onProcess((d) => spin(d));
```

## A canvas painter (works on VUI and Flutter)

Write the painter once; use it on either path. See `06-vui.md` / `07-flutter-bridge.md`.

```js
import 'godot.js';
import 'ui.js';
import 'flutter.js';     // for FL.paint helper

function drawMeter(cv, value) {
  cv.drawArc([16,16,304,304], PI, PI, false,
    FL.paint({ color:[1,1,1,0.14], style:"stroke", strokeWidth:16, strokeCap:"round" }));
  cv.drawArc([16,16,304,304], PI, PI * value, false,
    FL.paint({ color:[0.35,0.7,1,1], style:"stroke", strokeWidth:16, strokeCap:"round" }));
  cv.drawCircle(160, 160, 8, FL.paint({ color:[1,0.85,0.3,1] }));
}

let v = 0.5;
let meter = VUI.canvas({ size: [320, 190], paint: (cv) => drawMeter(cv, v) });
// ... add `meter` to a VUI layout; call VUI.repaint(meter) after changing v.
```

## Input & gestures

```js
// Native (VUI) — drag anywhere on a control:
let pad = VUI.gestures(VUI.panel({ child: VUI.text("drag me") }), {
  onPanUpdate: (e) => { print("dx " + e.dx + " dy " + e.dy); },
  onTap: () => print("tap"),
  onLongPress: () => print("long press"),
});

// Raw engine input (any node):
GD.onInput((event) => {
  if (event.call("is_class", ["InputEventKey"]) && event.get("pressed")) {
    print("key " + event.get("keycode"));
  }
});
```

## Timers & animation

```js
GTimer.after(1000, () => print("one second later"));
let t = GTimer.periodic(500, () => print("tick"));   // t.cancel() to stop
GD.onProcess((delta) => { /* per-frame; delta seconds */ });
```

## Networking (HTTP)

```js
import 'godot.js';
import 'net.js';

Net.setBase("https://api.example.com");
Net.postJson("/login", { user: "a", pass: "b" }, (err, res) => {
  if (err) { print("error " + err); return; }
  print("status " + res.status + " body " + res.body);
});
```

## A multi-VM app (sandboxed modules)

```js
import 'godot.js';

// root VM: build a container node, spawn a sandboxed child into it.
let slot = GD.create("Node2D");
GD.mount(slot);
let childSrc = "import 'godot.js';\nlet b = GD.create('Button'); b.set('text','child'); GD.mount(b);";
let child = VMs.spawn(childSrc, slot, {
  label: "widget", lang: "js",
  limits: { instructions: 2e7, instructionsPerTurn: 5e5, memoryBytes: 4e6 },
});
VMs.onMessage((sender, msg) => print("child " + sender + " says " + msg));
```

## A game (see the shipped TPS)

The complete third-person shooter `victor/bridge/project/scripts/tps_main.dart`
(design in `victor/bridge/GAME_DESIGN.md`) is the canonical game example — city
generation, animated characters, hitscan combat, wave AI, HUD, touch controls,
synthesized audio — all Dart on the Elpian VM. Read it for game-scale patterns.

## Verifying headlessly

Add a Rust test modeled on `victor/bridge/capi/tests/run_ui_demo.rs` /
`run_flutter_3d_demo.rs`: compile your shipped script, `run_root()`, drive
`__godotEvent`/`__godotDispatch`/`pump`, and assert on the ops a mock host saw.
Run with `cd victor && cargo test -p elpian-godot-capi`. This catches compile and
runtime errors without a GPU.
