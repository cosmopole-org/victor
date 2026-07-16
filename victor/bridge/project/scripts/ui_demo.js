// ui_demo.js — the Victor UI showcase: a full phone-style app written 100% in
// JavaScript on the Elpian VM, driving Godot through the reflective bridge.
//
// The scene (`ui_demo.tscn`) is a 3D world — its root is a Node3D — and this
// program builds a complete 2D page INSIDE it: VUI.app creates a CanvasLayer,
// which composites over the viewport, so the 2D page covers the full screen
// while the 3D environment keeps existing (unshown) underneath. The app locks
// the screen to portrait (DisplayServer orientation on handheld devices, a
// portrait-sized window on desktop) and content-scales a 720×1280 design space
// to whatever the real screen is.
//
// Three pages behind a bottom navigation bar:
//   Home    — dashboard: live stat tiles (real frames/ops), progress, chips,
//             tappable activity tiles
//   Widgets — the whole kit: buttons, inputs, selection controls, dialogs,
//             sheets, toasts
//   System  — the VM introspecting itself (id, instructions, heap) and
//             spawning a sandboxed CHILD VM (in JavaScript) that reports back
import 'godot.js';
import 'ui.js';

// Mutable app state lives in objects (closures capture locals by value).
var S = {
  frames: 0,
  seconds: 0,
  taps: 0,
  nav: null,
  pages: [],
  framesStat: null,
  opsStat: null,
  tapsStat: null,
  liveBar: null,
  sliderLabel: null,
  sliderBar: null,
  vmLabel: null,
  childLabel: null,
  child: null,
};

// ---------------------------------------------------------------------------
// page plumbing: three full-rect pages inside one stack, swapped by the nav
// ---------------------------------------------------------------------------

function makeStack() {
  let stack = GD.create("Control");
  stack.set("size_flags_horizontal", GInt(3));
  stack.set("size_flags_vertical", GInt(3));
  return stack;
}

function addPage(stack, page, visible) {
  let n = page;
  n.set("anchor_left", GFloat(0.0));
  n.set("anchor_top", GFloat(0.0));
  n.set("anchor_right", GFloat(1.0));
  n.set("anchor_bottom", GFloat(1.0));
  n.set("offset_left", GFloat(0.0));
  n.set("offset_top", GFloat(0.0));
  n.set("offset_right", GFloat(0.0));
  n.set("offset_bottom", GFloat(0.0));
  n.set("visible", visible);
  stack.call("add_child", [n]);
  S.pages.push(n);
}

function showPage(i) {
  for (let p = 0; p < S.pages.length; p++) {
    S.pages[p].set("visible", p == i);
  }
}

// A scrollable page body with standard padding.
function pageScroll(children) {
  return VUI.scroll({
    child: VUI.column({ gap: 20, pad: 24, children: children }),
  });
}

// ---------------------------------------------------------------------------
// Home — the dashboard
// ---------------------------------------------------------------------------

function buildHome() {
  let t = VUI.theme();

  S.framesStat = VUI.stat({ label: "FRAMES", value: "0", glyph: "◈", accent: t.primary });
  S.opsStat = VUI.stat({ label: "UPTIME", value: "0s", glyph: "◷", accent: t.accent });
  S.tapsStat = VUI.stat({ label: "TAPS", value: "0", glyph: "◉", accent: t.warning });
  S.liveBar = VUI.progress({ value: 0.0, max: 100.0 });

  let filters = VUI.row({
    gap: 12,
    children: [
      VUI.chip("Realtime", { selected: true, onTap: (on) => { print("chip realtime -> " + on); } }),
      VUI.chip("Signals", { onTap: (on) => { print("chip signals -> " + on); } }),
      VUI.chip("Batched", { onTap: (on) => { print("chip batched -> " + on); } }),
    ],
  });

  let activity = VUI.column({
    gap: 12,
    children: [
      VUI.listTile({
        leading: "⚡", leadingColor: t.warning,
        title: "Reflective bridge online",
        subtitle: "every ClassDB class addressable by name",
        trailing: "now",
        onTap: () => { VUI.toast("ops flow through ONE seam", { kind: "info" }); },
      }),
      VUI.listTile({
        leading: "▦", leadingColor: t.accent,
        title: "Retained scene graph",
        subtitle: "Godot renders; the VM only reacts",
        trailing: "60fps",
        onTap: () => { VUI.toast("no per-frame redraws", { kind: "success" }); },
      }),
      VUI.listTile({
        leading: "⬡", leadingColor: t.primary,
        title: "Sandboxed multi-VM tree",
        subtitle: "spawn children on the System page",
        trailing: "→",
        onTap: () => { S.nav.select(2); },
      }),
    ],
  });

  return pageScroll([
    VUI.caption("LIVE FROM THE VM"),
    VUI.grid({ cols: 2, gap: 16, children: [S.framesStat, S.opsStat] }),
    VUI.grid({ cols: 2, gap: 16, children: [S.tapsStat, VUI.stat({ label: "GUEST LANG", value: "JS", glyph: "✦", accent: t.success })] }),
    VUI.card({
      gap: 14,
      children: [
        VUI.row({ children: [VUI.title("Engine load", { size: VUI.theme().fontM }), VUI.spacer(), VUI.badge("LIVE", { color: t.success })] }),
        S.liveBar,
        VUI.caption("a sine of elapsed time, written per second over the bridge"),
      ],
    }),
    VUI.caption("FILTERS"),
    filters,
    VUI.caption("ACTIVITY"),
    activity,
  ]);
}

// ---------------------------------------------------------------------------
// Widgets — the whole kit on one page
// ---------------------------------------------------------------------------

function buildWidgets() {
  let t = VUI.theme();

  let name = VUI.field({
    placeholder: "Type your name…",
    onSubmit: (text) => { VUI.toast("hello, " + text + "!", { kind: "success" }); },
    onChanged: (text) => { print("field: " + text); },
  });

  S.sliderLabel = VUI.text("35", { size: t.fontM, color: t.primary });
  S.sliderBar = VUI.progress({ value: 35.0, color: t.accent });
  let slider = VUI.slider({
    min: 0.0, max: 100.0, value: 35.0,
    onChanged: (v) => {
      S.sliderLabel.set("text", "" + round(v));
      S.sliderBar.setValue(v);
      print("slider: " + round(v));
    },
  });

  let buttonsCard = VUI.card({
    gap: 14,
    children: [
      VUI.title("Buttons", { size: t.fontM }),
      VUI.button("Filled — count a tap", {
        wide: true,
        onTap: () => {
          S.taps = S.taps + 1;
          S.tapsStat.setValue("" + S.taps);
          print("ui tap #" + S.taps);
          VUI.toast("tap #" + S.taps + " counted", { kind: "info" });
        },
      }),
      VUI.button("Tonal", { kind: "tonal", wide: true, onTap: () => { VUI.toast("tonal tapped"); } }),
      VUI.row({
        gap: 12,
        children: [
          VUI.expand(VUI.button("Outline", { kind: "outline", wide: true, onTap: () => { VUI.toast("outline tapped"); } })),
          VUI.expand(VUI.button("Ghost", { kind: "ghost", wide: true, onTap: () => { VUI.toast("ghost tapped"); } })),
        ],
      }),
      VUI.button("Danger — confirm something", {
        kind: "danger", wide: true,
        onTap: () => {
          VUI.dialog({
            title: "Delete everything?",
            body: "This is only a demo, so nothing actually happens. Still — are you sure?",
            actions: [
              { text: "Cancel", kind: "ghost" },
              { text: "Delete", kind: "danger", onTap: () => { VUI.toast("deleted nothing", { kind: "danger" }); } },
            ],
          });
        },
      }),
    ],
  });

  let inputsCard = VUI.card({
    gap: 14,
    children: [
      VUI.title("Inputs", { size: t.fontM }),
      name,
      VUI.row({ gap: 16, children: [VUI.expand(slider), S.sliderLabel] }),
      S.sliderBar,
    ],
  });

  let selectionCard = VUI.card({
    gap: 14,
    children: [
      VUI.title("Selection", { size: t.fontM }),
      VUI.row({
        gap: 16,
        children: [
          VUI.text("Animations", { size: t.fontS, dim: true, expand: true }),
          VUI.toggle({ value: true, onChanged: (on) => { print("toggle animations -> " + on); } }),
        ],
      }),
      VUI.row({
        gap: 16,
        children: [
          VUI.text("Telemetry", { size: t.fontS, dim: true, expand: true }),
          VUI.toggle({ value: false, onChanged: (on) => { print("toggle telemetry -> " + on); } }),
        ],
      }),
      VUI.divider(),
      VUI.checkbox({ label: "I read the op protocol chapter", onChanged: (on) => { print("checkbox -> " + on); } }),
      VUI.checkbox({ label: "Ship it", value: true, onChanged: (on) => { print("checkbox ship -> " + on); } }),
    ],
  });

  let overlaysCard = VUI.card({
    gap: 14,
    children: [
      VUI.title("Overlays", { size: t.fontM }),
      VUI.row({
        gap: 12,
        children: [
          VUI.expand(VUI.button("Dialog", { kind: "tonal", wide: true, onTap: () => {
            VUI.dialog({
              title: "A modal dialog",
              body: "Scrim, card, actions — all Godot Controls, all tweened over the bridge.",
              actions: [{ text: "Nice", kind: "filled" }],
            });
          } })),
          VUI.expand(VUI.button("Sheet", { kind: "tonal", wide: true, onTap: () => {
            VUI.sheet({
              title: "A bottom sheet",
              children: [
                VUI.text("Slides over everything, dismisses on the scrim.", { size: t.fontS, dim: true, wrap: true }),
                VUI.button("Got it", { wide: true, onTap: () => { VUI.toast("sheet dismissed"); } }),
              ],
            });
          } })),
        ],
      }),
      VUI.row({
        gap: 12,
        children: [
          VUI.expand(VUI.button("Toast ✓", { kind: "ghost", wide: true, onTap: () => { VUI.toast("all good", { kind: "success" }); } })),
          VUI.expand(VUI.button("Toast !", { kind: "ghost", wide: true, onTap: () => { VUI.toast("careful now", { kind: "warning" }); } })),
          VUI.expand(VUI.button("Toast ✕", { kind: "ghost", wide: true, onTap: () => { VUI.toast("that failed", { kind: "danger" }); } })),
        ],
      }),
    ],
  });

  return pageScroll([buttonsCard, inputsCard, selectionCard, overlaysCard]);
}

// ---------------------------------------------------------------------------
// System — the VM looking at itself, plus a sandboxed JS child VM
// ---------------------------------------------------------------------------

var childSrc = ""
  + "var t = 0.0;\n"
  + "function main() {\n"
  + "  VMs.sendParent('child vm alive in its sandbox');\n"
  + "  GD.onProcess((d) => { t = t + d; });\n"
  + "  GTimer.periodic(2000, () => {\n"
  + "    VMs.sendParent('child heartbeat at ' + round(t) + 's');\n"
  + "  });\n"
  + "}\n"
  + "main();\n";

function spawnChild() {
  if (S.child != null) {
    VUI.toast("child already running", { kind: "warning" });
    return;
  }
  let pod = GD.create("Node2D");
  GD.mount(pod);
  let child = VMs.spawn(childSrc, pod, {
    label: "ui-child",
    limits: { instructionsPerTurn: 2000000 },
  });
  if (child == null) {
    VUI.toast("spawn denied", { kind: "danger" });
    return;
  }
  S.child = child;
  print("system: spawned child vm " + child.id);
  VUI.toast("child VM " + child.id + " spawned", { kind: "success" });
  S.childLabel.set("text", "child vm " + child.id + ": booting…");
}

function killChild() {
  if (S.child == null) {
    VUI.toast("no child to terminate", { kind: "warning" });
    return;
  }
  S.child.terminate();
  print("system: terminated child vm " + S.child.id);
  S.child = null;
  S.childLabel.set("text", "child: terminated");
  VUI.toast("child branch terminated", { kind: "danger" });
}

function buildSystem() {
  let t = VUI.theme();
  S.vmLabel = VUI.text("collecting…", { size: t.fontXS, dim: true, wrap: true });
  S.childLabel = VUI.text("child: not running", { size: t.fontXS, dim: true, wrap: true });

  let me = VMs.info();
  let idLine = "vm";
  if (__isType(me, "map")) {
    idLine = "vm " + me["id"] + " · " + me["label"] + (me["scene"] == true ? " · whole-scene" : "");
  }

  return pageScroll([
    VUI.caption("THIS VM"),
    VUI.card({
      gap: 12,
      children: [
        VUI.row({
          gap: 16,
          children: [
            VUI.avatar("JS", { color: t.accent, textColor: new Color(0.0, 0.1, 0.08, 1.0) }),
            VUI.column({ gap: 4, children: [
              VUI.title("Elpian guest", { size: t.fontM }),
              VUI.caption(idLine),
            ] }),
          ],
        }),
        VUI.divider(),
        S.vmLabel,
      ],
    }),
    VUI.caption("MULTI-VM TREE"),
    VUI.card({
      gap: 14,
      children: [
        VUI.text("Spawn a JavaScript child VM, sandboxed to its own node. It messages back over the tree.", { size: t.fontXS, dim: true, wrap: true }),
        S.childLabel,
        VUI.row({
          gap: 12,
          children: [
            VUI.expand(VUI.button("Spawn child", { kind: "filled", wide: true, onTap: () => { spawnChild(); } })),
            VUI.expand(VUI.button("Terminate", { kind: "danger", wide: true, onTap: () => { killChild(); } })),
          ],
        }),
      ],
    }),
    VUI.caption("ABOUT"),
    VUI.card({
      gap: 10,
      children: [
        VUI.text("Victor UI", { size: t.fontM }),
        VUI.text("A full UI kit in JavaScript on the Elpian VM. Every widget is a retained Godot Control created reflectively over one host-call seam — no wrappers, no assets, no JIT.", { size: t.fontXS, dim: true, wrap: true }),
      ],
    }),
  ]);
}

// ---------------------------------------------------------------------------
// live wiring
// ---------------------------------------------------------------------------

function refreshVmCard() {
  let me = VMs.info();
  if (!__isType(me, "map")) {
    return;
  }
  let mine = VMs.of(me["id"]);
  let u = mine.usage();
  if (__isType(u, "map")) {
    S.vmLabel.set(
      "text",
      "instructions " + u["instructions"] + "\nheap " + u["memoryBytes"] + " B (peak " + u["peakMemoryBytes"] + " B)"
    );
  }
}

function main() {
  VUI.use(VUI.themeDark());
  let t = VUI.theme();

  // The full-screen 2D page inside the 3D scene, locked to portrait.
  let app = VUI.app({ design: [720, 1280], portrait: true });

  let bar = VUI.appBar({
    title: "Victor UI",
    subtitle: "JavaScript on the Elpian VM",
    leading: VUI.avatar("V", { size: 76.0 }),
    actions: [
      VUI.iconButton("♥", { onTap: () => { VUI.toast("thanks!", { kind: "success" }); } }),
    ],
  });

  let stack = makeStack();
  addPage(stack, buildHome(), true);
  addPage(stack, buildWidgets(), false);
  addPage(stack, buildSystem(), false);

  S.nav = VUI.bottomNav({
    items: [
      { glyph: "◈", label: "Home" },
      { glyph: "❖", label: "Widgets" },
      { glyph: "⬡", label: "System" },
    ],
    index: 0,
    onSelect: (i) => {
      showPage(i);
      print("nav -> page " + i);
    },
  });

  app.push(VUI.column({ gap: 0, children: [bar, stack, S.nav.node] }));

  // Messages from the child VM surface on the System page + a toast.
  VMs.onMessage((sender, msg) => {
    print("system: vm " + sender + " says: " + msg);
    S.childLabel.set("text", "child vm " + sender + ": " + msg);
  });
  VMs.onChildTerminated((kind, vmId, detail) => {
    print("system: child vm " + vmId + " terminated (" + detail + ")");
  });

  // Per-frame: count frames, breathe the "engine load" bar.
  GD.onProcess((d) => {
    S.frames = S.frames + 1;
  });

  // Once a second: push the live numbers over the bridge.
  GTimer.periodic(1000, () => {
    S.seconds = S.seconds + 1;
    S.framesStat.setValue("" + S.frames);
    S.opsStat.setValue(S.seconds + "s");
    S.liveBar.setValue(50.0 + 45.0 * sin(S.seconds * 0.7));
    refreshVmCard();
  });

  print("victor ui demo up: portrait 720x1280, 3 pages, theme " + t.name);
}

main();
