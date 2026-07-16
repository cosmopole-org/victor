// flutter_3d_demo.js — a MIXED Flutter-UI + Godot-3D Victor app, in JavaScript
// on the Elpian VM.
//
// A live Godot 3D scene (environment, camera on an orbit pivot, directional
// light, a floor, and a spinning ring of primitives) sits underneath a 2D UI —
// and the UI is REAL FLUTTER, driven over the `flutter.op` bridge (`FL`):
//
//   * Flutter widgets   — a transparent Scaffold with cards, sliders, buttons,
//                         a segmented shape picker and a switch;
//   * Flutter events    — slider onChanged drives spin speed; a GestureDetector
//                         onPanUpdate orbits the 3D camera; buttons add/remove
//                         shapes and cycle their colour;
//   * Flutter canvas    — a CustomPaint speedometer (arcs, a sweep-gradient
//                         fill, a live needle via canvas transforms, tick marks
//                         and a drawParagraph readout) repainted every frame.
//
// The 2D controls mutate plain state; the 3D world reads it each frame. Because
// a real Flutter engine only exists in a build made with `ELPIAN_WITH_FLUTTER`
// (and never on the web, where libflutter cannot embed), `FL.mount` returns null
// when the engine is absent and the demo **falls back to the Victor UI kit
// (VUI)** for an equivalent, fully-interactive HUD — so the shipped APK / web
// artifacts run everywhere while a Flutter-enabled build shows the real thing.
// The active path is shown on screen ("UI: Flutter engine" vs "UI: VUI fallback").

import 'godot.js';
import 'ui.js';
import 'flutter.js';

var PI = 3.14159265358979;
function rad(deg) { return deg * PI / 180.0; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function ifloor(x) { return x - x % 1.0; } // floor for x >= 0
function iround(x) { let y = x + 0.5; return y - y % 1.0; }

// The design space the 2D UI is laid out in.
var DW = 720.0;
var DH = 1280.0;

// ---------------------------------------------------------------------------
// Shared state — mutated by 2D controls, read by the 3D world each frame.
// ---------------------------------------------------------------------------
var S = {
  speed: 55.0, // degrees / second
  count: 6,
  hue: 0.58, // 0..1 base hue of the ring
  angle: 0.0, // current spin angle (degrees)
  shadows: true,
  shape: 0, // index into SHAPES
  camYaw: 0.0, // orbit yaw (degrees)
  camPitch: -14.0, // orbit pitch (degrees)
  usingFlutter: false,
};
var SHAPES = ["box", "sphere", "torus", "capsule", "cylinder"];

// 3D handles.
var host = GD.host();
var camPivot = null;
var spinner = null;
var dirLight = null;
var ringItems = [];

// UI handles.
var flView = null;

// ---------------------------------------------------------------------------
// 3D world
// ---------------------------------------------------------------------------

function hueColor(h, s, v) {
  // Small HSV→RGB so the ring cycles colour without engine calls.
  let i = ifloor(h * 6.0);
  let f = h * 6.0 - i;
  let p = v * (1.0 - s);
  let q = v * (1.0 - f * s);
  let t = v * (1.0 - (1.0 - f) * s);
  let m = i % 6;
  let r = v; let g = t; let b = p;
  if (m == 1) { r = q; g = v; b = p; }
  else if (m == 2) { r = p; g = v; b = t; }
  else if (m == 3) { r = p; g = q; b = v; }
  else if (m == 4) { r = t; g = p; b = v; }
  else if (m == 5) { r = v; g = p; b = q; }
  return new Color(r, g, b, 1.0);
}

function buildWorld() {
  host.call("add_child", [G3.environment({
    bg: new Color(0.04, 0.05, 0.09, 1.0),
    ambient: new Color(0.45, 0.5, 0.7, 1.0),
    ambientEnergy: 0.7,
  })]);

  dirLight = G3.dirLight({ energy: 1.35, shadow: S.shadows, rotation: [-52.0, -38.0, 0.0] });
  host.call("add_child", [dirLight]);

  // A pivot the camera hangs off, so orbiting is just a rotation.
  camPivot = G3.node({ position: [0.0, 0.9, 0.0] });
  host.call("add_child", [camPivot]);
  let cam = G3.camera({ position: [0.0, 0.0, 9.0], fov: 52.0 });
  camPivot.call("add_child", [cam]);

  host.call("add_child", [G3.mesh("plane", {
    width: 40.0, depth: 40.0, position: [0.0, -1.2, 0.0],
    color: new Color(0.10, 0.12, 0.17, 1.0), roughness: 0.9, metallic: 0.0,
  })]);

  spinner = G3.node({});
  host.call("add_child", [spinner]);
  rebuildRing();
  applyOrbit();
}

function rebuildRing() {
  for (let i = 0; i < ringItems.length; i++) {
    ringItems[i].call("queue_free", []);
  }
  ringItems = [];
  let n = S.count;
  let shape = SHAPES[S.shape];
  for (let i = 0; i < n; i++) {
    // A per-item pivot rotated around Y places the shape on a ring — no trig.
    let pivot = G3.node({ rotation: [0.0, i * 360.0 / n, 0.0] });
    let col = hueColor((S.hue + i / n) % 1.0, 0.65, 1.0);
    let mesh = G3.mesh(shape, {
      position: [2.7, 0.0, 0.0],
      size: [0.9, 0.9, 0.9], radius: 0.5, innerRadius: 0.22, outerRadius: 0.48, height: 1.1,
      color: col, emission: col, emissionEnergy: 0.25, metallic: 0.25, roughness: 0.35,
    });
    pivot.call("add_child", [mesh]);
    spinner.call("add_child", [pivot]);
    ringItems.push(pivot);
  }
}

function applyOrbit() {
  if (camPivot != null) {
    camPivot.set("rotation_degrees", new Vector3(S.camPitch, S.camYaw, 0.0));
  }
}

// ---------------------------------------------------------------------------
// Control actions (shared by the Flutter UI and the VUI fallback)
// ---------------------------------------------------------------------------
function setSpeed(v) { S.speed = clamp(v, 0.0, 180.0); }
function addShape() { S.count = clamp(S.count + 1, 1, 16); rebuildRing(); }
function removeShape() { S.count = clamp(S.count - 1, 1, 16); rebuildRing(); }
function cycleColor() { S.hue = (S.hue + 0.12) % 1.0; rebuildRing(); }
function pickShape(i) { S.shape = i % SHAPES.length; rebuildRing(); }
function toggleShadows(on) { S.shadows = on; if (dirLight != null) { dirLight.set("shadow_enabled", on); } }
function orbit(dx, dy) {
  S.camYaw = S.camYaw - dx * 0.4;
  S.camPitch = clamp(S.camPitch - dy * 0.3, -75.0, 10.0);
  applyOrbit();
}

// ---------------------------------------------------------------------------
// Flutter UI (primary) — widgets + events + a live canvas speedometer
// ---------------------------------------------------------------------------

function gauge() {
  let w = 320.0;
  let h = 190.0;
  return FL.customPaint([w, h], function (cv) {
    let cx = w * 0.5;
    let cy = h * 0.86;
    let r = 128.0;
    let a0 = rad(180.0); // sweep from 180°…
    let span = rad(180.0); // …through 180° (a half-dial)
    let frac = clamp(S.speed / 180.0, 0.0, 1.0);

    // Track.
    cv.drawArc([cx - r, cy - r, cx + r, cy + r], a0, span, false,
      FL.paint({ color: [1, 1, 1, 0.14], style: "stroke", strokeWidth: 16, strokeCap: "round" }));
    // Filled portion, sweep-gradient.
    cv.drawArc([cx - r, cy - r, cx + r, cy + r], a0, span * frac, false,
      FL.paint({
        style: "stroke", strokeWidth: 16, strokeCap: "round",
        shader: FL.sweepGradient([cx, cy], [[0.25, 0.75, 1, 1], [0.6, 0.4, 1, 1], [1, 0.4, 0.6, 1]], [0.0, 0.5, 1.0], a0, a0 + span),
      }));

    // Tick marks around the dial.
    let ticks = FL.paint({ color: [1, 1, 1, 0.35], style: "stroke", strokeWidth: 3, strokeCap: "round" });
    for (let i = 0; i <= 10; i++) {
      cv.save();
      cv.translate(cx, cy);
      cv.rotate(a0 + span * (i / 10.0));
      cv.drawLine([r - 6.0, 0.0], [r + 6.0, 0.0], ticks);
      cv.restore();
    }

    // Live needle: points at the fill fraction, and jitters with the actual
    // spin so you can see the 3D and the gauge share one clock.
    let needleA = a0 + span * frac;
    cv.save();
    cv.translate(cx, cy);
    cv.rotate(needleA);
    cv.drawLine([0.0, 0.0], [r - 14.0, 0.0],
      FL.paint({ color: [1, 0.85, 0.3, 1], style: "stroke", strokeWidth: 5, strokeCap: "round" }));
    cv.restore();
    cv.drawCircle(cx, cy, 9.0, FL.paint({ color: [1, 0.85, 0.3, 1] }));

    // Readout.
    cv.drawParagraph(
      FL.paragraph(iround(S.speed) + "  °/s",
        w, { size: 22, color: [1, 1, 1, 0.92], bold: true }, "center"),
      0.0, cy - 44.0);
  });
}

function shapeChip(label, idx) {
  return FL.el("ChoiceChip", {
    label: FL.text(label),
    selected: S.shape == idx,
    onSelected: function (on) { pickShape(idx); },
  });
}

function buildFlutterUI() {
  // Transparent scaffold so the 3D world shows through the gaps.
  return FL.el("Scaffold", {
    backgroundColor: [0, 0, 0, 0],
    body: FL.el("Stack", {}, [
      // Full-screen gesture surface to orbit the camera by dragging anywhere.
      FL.el("Positioned", { left: 0, top: 0, right: 0, bottom: 0 },
        FL.gestures(FL.el("SizedBox", { width: DW, height: DH }), {
          onPanUpdate: function (d) { orbit(d.dx == null ? 0.0 : d.dx, d.dy == null ? 0.0 : d.dy); },
        })),
      // Top status card.
      FL.el("Positioned", { left: 16, top: 16, right: 16 },
        FL.card(FL.padding(16, FL.column([
          FL.text("Victor — Flutter × Godot 3D", { size: 22, bold: true, color: [1, 1, 1, 0.95] }),
          FL.text("UI: Flutter engine  ·  drag to orbit", { size: 13, color: [0.7, 0.8, 1, 0.9] }),
        ])), { color: [0.10, 0.12, 0.20, 0.82] })),
      // Bottom control panel.
      FL.el("Positioned", { left: 12, right: 12, bottom: 16 },
        FL.card(FL.padding(16, FL.column([
          FL.center(gauge()),
          FL.row([
            FL.text("Spin", { size: 14, color: [0.85, 0.9, 1, 1] }),
            FL.expanded(FL.slider(S.speed, function (v) { setSpeed(v); }, { min: 0.0, max: 180.0 })),
          ]),
          FL.row([
            shapeChip("Box", 0), shapeChip("Sphere", 1), shapeChip("Torus", 2),
            shapeChip("Capsule", 3), shapeChip("Cyl", 4),
          ]),
          FL.row([
            FL.expanded(FL.filledButton("– shape", function (a) { removeShape(); })),
            FL.sizedBox(10, 0, null),
            FL.expanded(FL.filledButton("+ shape", function (a) { addShape(); })),
            FL.sizedBox(10, 0, null),
            FL.expanded(FL.textButton("Colour", function (a) { cycleColor(); })),
          ]),
          FL.row([
            FL.text("Shadows", { size: 14, color: [0.85, 0.9, 1, 1] }),
            FL.el("Switch", { value: S.shadows, onChanged: function (on) { toggleShadows(on); } }),
          ]),
        ])), { color: [0.10, 0.12, 0.20, 0.9] })),
    ]),
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

function main() {
  buildWorld();

  // A CanvasLayer to host the Flutter surface over the 3D viewport.
  let layer = GD.create("CanvasLayer");
  host.call("add_child", [layer]);
  flView = FL.mount(layer, buildFlutterUI, { design: [DW, DH], transparent: true });

  if (flView != null) {
    S.usingFlutter = true;
    print("flutter+3d demo up: REAL Flutter engine driving the UI");
  } else {
    layer.call("queue_free", []);
    // Fallback: VUI HUD. bg:false makes the page TRANSPARENT so the live 3D
    // scene shows through — VUI.app otherwise paints an opaque full-screen
    // background (which is what hides the 3D in ui_demo). The controls sit in
    // their own opaque panel at the bottom; the top ~60% is left clear for the
    // 3D ring.
    VUI.use(VUI.themeDark());
    let app = VUI.app({ design: [DW, DH], portrait: true, bg: false });
    app.push(VUI.column({ gap: 0, children: [VUI.spacer(), buildVuiPanel()] }));
    print("flutter+3d demo up: VUI fallback (no Flutter engine in this build)");
  }

  // Per-frame: spin the ring and, when Flutter is live, repaint the gauge so
  // the needle tracks the same clock as the 3D.
  GD.onProcess((d) => {
    S.angle = S.angle + d * S.speed;
    if (spinner != null) {
      spinner.set("rotation_degrees", new Vector3(0.0, S.angle, 0.0));
    }
    if (flView != null) {
      flView.update();
    }
  });
}

// The VUI fallback panel, rebuilt so the selected-shape highlight refreshes.
function buildVuiPanel() {
  let shapeButtons = [];
  for (let i = 0; i < SHAPES.length; i++) {
    let idx = i;
    shapeButtons.push(VUI.expand(VUI.button(SHAPES[i], {
      kind: idx == S.shape ? "filled" : "tonal",
      onTap: () => { pickShape(idx); },
    })));
  }
  return VUI.panel({
    pad: 18, radius: 22,
    child: VUI.column({ gap: 12, children: [
      VUI.title("Victor — VUI × Godot 3D"),
      VUI.caption("UI: VUI fallback (build without ELPIAN_WITH_FLUTTER)"),
      VUI.row({ gap: 10, children: [
        VUI.text("Spin"),
        VUI.expand(VUI.slider({ value: S.speed, min: 0.0, max: 180.0, onChanged: (v) => { setSpeed(v); } })),
      ] }),
      VUI.row({ gap: 8, children: shapeButtons }),
      VUI.row({ gap: 10, children: [
        VUI.expand(VUI.button("– shape", { kind: "tonal", onTap: () => { removeShape(); } })),
        VUI.expand(VUI.button("+ shape", { kind: "filled", onTap: () => { addShape(); } })),
        VUI.expand(VUI.button("Colour", { kind: "outline", onTap: () => { cycleColor(); } })),
      ] }),
      VUI.row({ gap: 10, children: [
        VUI.text("Shadows"),
        VUI.toggle({ value: S.shadows, onChanged: (on) => { toggleShadows(on); } }),
      ] }),
    ] }),
  });
}

main();
