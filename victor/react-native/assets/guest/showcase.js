// Victor showcase — a rich React Native (2D) + Godot (3D) app on one Elpian VM.
// ===========================================================================
//
// Everything here runs entirely on the Elpian VM (no JIT). The 2D UI is a real
// React Native widget tree built with `reactnative.js`; the 3D world is a real
// Godot scene built with the ordinary `godot.js` / `G3` surface and embedded as
// an `RN.Scene3D` widget. The 2D controls *drive* the 3D scene live — the whole
// point of the integration: one program, two renderers, one VM in charge.
//
// It exercises a broad slice of the now-complete React Native element set:
//   SafeAreaView · ScrollView · View (row/column) · Text · TextInput · Switch
//   · Slider · Button · FlatList · Modal · ActivityIndicator · Scene3D (Godot).
//
// Compile with js2elpian, or ship the source and let <VictorHost/> compose the
// `godot.js` + `reactnative.js` preludes ahead of it (what the Expo app does).

import "godot.js";
import "reactnative.js";

// One retained-handle bag so event closures can reach the widgets/nodes they
// mutate without a forest of globals.
var refs = {};
var count = 0;
var itemCount = 0;
var spheres = [];

// --- helpers ---------------------------------------------------------------

function greeting(name) {
  if (name == null || name == "") {
    return "Hello there!";
  }
  return "Hello, " + name + "!";
}

function bump(delta) {
  count = count + delta;
  refs.counter.set("text", "Count: " + count);
  RN.toast("count = " + count);
}

function setLight(on) {
  if (refs.light != null) {
    refs.light.set("visible", on);
  }
}

// The slider gives an absolute Y rotation (degrees) — drag it and the 3D group
// spins. A single 2D event → one godot.op `set` on the live scene node.
function setSpin(deg) {
  if (refs.group != null) {
    refs.group.set("rotation_degrees", new Vector3(0, deg, 0));
  }
}

function addSphere() {
  if (refs.group == null) {
    return;
  }
  var n = spheres.length;
  var x = (n % 5) - 2;
  var z = 0 - (n / 5);
  var s = G3.mesh("sphere", {
    color: new Color(1.0, 0.5, 0.2, 1),
    position: [x, 0.6, z],
    radius: 0.35,
  });
  refs.group.call("add_child", [s]);
  spheres.push(s);
  RN.toast("spheres: " + spheres.length);
}

function clearSpheres() {
  var i = 0;
  while (i < spheres.length) {
    spheres[i].queueFree();
    i = i + 1;
  }
  spheres = [];
}

function addItem() {
  itemCount = itemCount + 1;
  var t = RN.text("List item " + itemCount, {
    color: "#e2e8f0",
    fontSize: 15,
    padding: 12,
    marginV: 4,
    bg: "#1e293b",
    radius: 8,
  });
  refs.list.add(t);
}

// --- the embedded Godot 3D scene -------------------------------------------

function build3d(scene) {
  if (scene.scene3d == null) {
    return; // no Godot engine on this platform — 2D still runs
  }
  var mount = scene.scene3d;
  mount.call("add_child", [
    G3.environment({ bg: new Color(0.02, 0.03, 0.09, 1), ambientEnergy: 0.6 }),
  ]);
  var light = G3.dirLight({ energy: 1.4, rotation: [-50, -30, 0], shadow: true });
  refs.light = light;
  mount.call("add_child", [light]);
  mount.call("add_child", [
    G3.camera({ position: [0, 3, 7], rotation: [-18, 0, 0], fov: 55 }),
  ]);
  mount.call("add_child", [
    G3.mesh("plane", { color: new Color(0.12, 0.15, 0.2, 1), size: [16, 16] }),
  ]);
  var group = G3.node({ position: [0, 1, 0] });
  refs.group = group;
  mount.call("add_child", [group]);
  group.call("add_child", [
    G3.mesh("box", { color: new Color(0.3, 0.6, 1, 1), position: [0, 0, 0] }),
  ]);
}

// --- the 2D React Native UI ------------------------------------------------

function sectionLabel(scroll, s) {
  scroll.add(RN.text(s, { color: "#cbd5e1", fontSize: 15, fontWeight: "600", marginTop: 8 }));
}

function main() {
  RN.begin();

  var root = RN.safe({ flex: 1, bg: "#0b1220" });
  var scroll = RN.scroll({ flex: 1, padding: 20, gap: 14 });

  // Header ------------------------------------------------------------------
  scroll.add(
    RN.text("Victor · React Native 2D + Godot 3D", {
      color: "#e2e8f0",
      fontSize: 22,
      fontWeight: "700",
    }),
  );
  scroll.add(
    RN.text("One Elpian VM drives the widgets and the 3D scene. The controls below mutate the live Godot world.", {
      color: "#94a3b8",
      fontSize: 13,
    }),
  );

  // The embedded Godot 3D scene --------------------------------------------
  var scene = RN.scene3d({ height: 260, radius: 14, bg: "#020617" });
  build3d(scene);
  scroll.add(scene);

  // Counter -----------------------------------------------------------------
  var counter = RN.text("Count: 0", { color: "#38bdf8", fontSize: 18, fontWeight: "600" });
  refs.counter = counter;
  var crow = RN.row({ gap: 12, align: "center" });
  crow.add(RN.button({ title: "−", bg: "#334155", onPress: function (e) { bump(-1); } }));
  crow.add(counter);
  crow.add(RN.button({ title: "+", onPress: function (e) { bump(1); } }));
  scroll.add(crow);

  // Text input echo ---------------------------------------------------------
  sectionLabel(scroll, "Your name");
  var echo = RN.text("Hello there!", { color: "#e2e8f0", fontSize: 16 });
  refs.echo = echo;
  scroll.add(
    RN.input({
      placeholder: "Type your name…",
      onChangeText: function (t) { refs.echo.set("text", greeting(t)); },
    }),
  );
  scroll.add(echo);

  // Switch drives the 3D key light -----------------------------------------
  var srow = RN.row({ gap: 12, align: "center", justify: "space-between" });
  srow.add(RN.text("Key light", { color: "#cbd5e1", fontSize: 15 }));
  srow.add(RN._switch({ value: true, onValueChange: function (v) { setLight(v); } }));
  scroll.add(srow);

  // Slider drives the 3D group rotation ------------------------------------
  sectionLabel(scroll, "Cube rotation");
  scroll.add(
    RN.slider({ value: 30, min: 0, max: 180, onValueChange: function (v) { setSpin(v); } }),
  );

  // Buttons that add / clear 3D spheres ------------------------------------
  var brow = RN.row({ gap: 12 });
  brow.add(RN.button({ title: "Add sphere", onPress: function (e) { addSphere(); } }));
  brow.add(RN.button({ title: "Clear", bg: "#b91c1c", onPress: function (e) { clearSpheres(); } }));
  scroll.add(brow);

  // A FlatList of items -----------------------------------------------------
  sectionLabel(scroll, "Items (FlatList)");
  var list = RN.flatList({ height: 160, bg: "#0f172a", radius: 10, padding: 8 });
  refs.list = list;
  scroll.add(list);
  scroll.add(RN.button({ title: "Add item", bg: "#0ea5e9", onPress: function (e) { addItem(); } }));

  // Busy indicator ----------------------------------------------------------
  var busy = RN.row({ gap: 10, align: "center" });
  busy.add(RN.spinner({}));
  busy.add(RN.text("ActivityIndicator", { color: "#94a3b8", fontSize: 13 }));
  scroll.add(busy);

  // A modal dialog ----------------------------------------------------------
  var modal = RN.modal({ visible: false, animationType: "slide", transparent: true });
  refs.modal = modal;
  var sheet = RN.column({ flex: 1, justify: "center", align: "center", bg: "#000000aa", padding: 24 });
  var card = RN.column({ bg: "#111827", padding: 20, radius: 16, gap: 12, maxWidth: 320 });
  card.add(RN.text("About Victor", { color: "#e2e8f0", fontSize: 18, fontWeight: "700" }));
  card.add(
    RN.text("2D via React Native, 3D via Godot — all app logic on the Elpian VM, no JIT, App-Store-legal, cross-platform.", {
      color: "#94a3b8",
      fontSize: 14,
    }),
  );
  card.add(RN.button({ title: "Close", onPress: function (e) { refs.modal.set("visible", false); } }));
  sheet.add(card);
  modal.add(sheet);
  scroll.add(RN.button({ title: "Show info", bg: "#7c3aed", onPress: function (e) { refs.modal.set("visible", true); } }));
  scroll.add(modal);

  root.add(scroll);

  RN.commit();
  RN.mount(root);

  print("victor rn+godot showcase up");
}

main();
