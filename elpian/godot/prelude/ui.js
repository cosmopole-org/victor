// =============================================================================
// ui.js — VUI: the Victor UI kit. A full widget toolkit in pure JavaScript,
// built on Godot Control nodes over the Elpian↔Godot bridge.
// =============================================================================
//
// Import it after godot.js (`import 'godot.js'; import 'ui.js';` — the import
// lines are markers the composer resolves; there is no module system). Every
// widget is a real, retained Godot Control node created reflectively through
// the bridge: VUI does not paint per frame — Godot renders the retained scene,
// and the guest only reacts to signals.
//
//   let app  = VUI.app({ design: [720, 1280], portrait: true });
//   let page = VUI.column({
//     gap: 16, pad: 20,
//     children: [
//       VUI.heading("Hello"),
//       VUI.button("Tap me", { onTap: () => VUI.toast("hi!") }),
//     ],
//   });
//   app.push(page);
//
// ## The pieces
//
//   theme      — themeDark / themeLight / use / theme (design tokens)
//   root       — app (CanvasLayer + full-rect page + overlay, portrait mode,
//                content-scale fit)
//   layout     — column, row, grid, scroll, margin, center, panel, spacer,
//                divider, expand
//   content    — text, heading, title, caption, icon, badge, chip, avatar,
//                card, stat, listTile
//   controls   — button, iconButton, field, toggle, checkbox, slider, progress
//   structure  — appBar, tabs, bottomNav, dialog, sheet, toast
//   motion     — tween, fade, slideY (Godot Tweens over the bridge)
//
// ## Conventions
//
//   * Factories take one options map and return the widget's Godot node
//     (a GObj), or a HANDLE — a plain object whose `.node` is the GObj and
//     whose closures read/drive the widget (`toggle`, `tabs`, `progress`, …).
//     Anywhere a child is accepted, both shapes work.
//   * Widget state lives in per-widget state OBJECTS mutated in place (the
//     front-end's closures capture locals by value, so a reassigned local
//     would go stale — a mutated object never does).
//   * There is no first-class null in the subset: an absent option reads as 0
//     (falsy), and `x ?? d` also replaces an explicit 0. Options that must
//     distinguish 0 (slider minimums, tab index 0, …) are therefore read with
//     `__vuiNum(v, d)` which only defaults a true absence… of which the VM has
//     one representation — so pass such values explicitly when they matter.
//   * Colors are Color(r, g, b, a) floats (hex literals are not in the
//     subset).
//
// Everything below is ordinary Elpian-JS: it compiles with js2elpian and runs
// on the VM with no privileged access — the kit is user-space code, the same
// seam any guest program uses. Read it as living documentation of the bridge.

// ---------------------------------------------------------------------------
// namespace + tiny helpers
// ---------------------------------------------------------------------------

var VUI = {};

// The active theme (set by VUI.use; defaults to the dark theme on first read).
var __vuiThemeState = { t: null };

// The app singleton created by VUI.app (root/overlay mount points, design
// size, toast/dialog bookkeeping).
var __vuiApp = { layer: null, root: null, overlay: null, w: 720.0, h: 1280.0, toast: null };

// Unwrap a widget (GObj or handle) to its GObj node.
function __vuiNode(x) {
  if (x == null) {
    return null;
  }
  if (__isType(x, "GObj")) {
    return x;
  }
  if (__isType(x, "Map")) {
    if (x["node"] != null) {
      return x["node"];
    }
  }
  if (x.node != null) {
    return x.node;
  }
  return x;
}

// Read a numeric option with a default (`??` also defaults an explicit 0 —
// see the conventions note).
function __vuiNum(v, d) {
  if (__isType(v, "num")) {
    return v;
  }
  return d;
}

function __vuiAddAll(parent, children) {
  if (children == null) {
    return;
  }
  for (let i = 0; i < children.length; i++) {
    let c = __vuiNode(children[i]);
    if (c != null) {
      parent.call("add_child", [c]);
    }
  }
}

// Anchor a Control to its parent's full rect (manual anchors — no engine
// constant lookups on the hot construction path).
function __vuiFullRect(n) {
  n.set("anchor_left", GFloat(0.0));
  n.set("anchor_top", GFloat(0.0));
  n.set("anchor_right", GFloat(1.0));
  n.set("anchor_bottom", GFloat(1.0));
  n.set("offset_left", GFloat(0.0));
  n.set("offset_top", GFloat(0.0));
  n.set("offset_right", GFloat(0.0));
  n.set("offset_bottom", GFloat(0.0));
}

function __vuiMinSize(n, w, h) {
  n.set("custom_minimum_size", new Vector2(w, h));
}

// Control.SIZE_EXPAND_FILL == 3 (SIZE_FILL 1 | SIZE_EXPAND 2) — stable API.
function __vuiExpandH(n) {
  n.set("size_flags_horizontal", GInt(3));
}
function __vuiExpandV(n) {
  n.set("size_flags_vertical", GInt(3));
}

// ---------------------------------------------------------------------------
// theme — design tokens
// ---------------------------------------------------------------------------

VUI.themeDark = () => {
  return {
    name: "victor-dark",
    // surfaces
    bg: new Color(0.055, 0.063, 0.09, 1.0),
    surface: new Color(0.098, 0.11, 0.153, 1.0),
    surface2: new Color(0.137, 0.153, 0.208, 1.0),
    surface3: new Color(0.18, 0.20, 0.27, 1.0),
    outline: new Color(0.29, 0.32, 0.42, 1.0),
    scrim: new Color(0.0, 0.0, 0.0, 0.55),
    // brand
    primary: new Color(0.42, 0.55, 1.0, 1.0),
    primaryDim: new Color(0.42, 0.55, 1.0, 0.16),
    onPrimary: new Color(0.03, 0.05, 0.10, 1.0),
    accent: new Color(0.36, 0.93, 0.79, 1.0),
    // text
    text: new Color(0.94, 0.95, 0.98, 1.0),
    textDim: new Color(0.67, 0.70, 0.80, 1.0),
    textFaint: new Color(0.45, 0.48, 0.58, 1.0),
    // status
    success: new Color(0.35, 0.85, 0.55, 1.0),
    warning: new Color(1.0, 0.76, 0.30, 1.0),
    danger: new Color(1.0, 0.36, 0.38, 1.0),
    info: new Color(0.42, 0.72, 1.0, 1.0),
    // shape + rhythm
    radiusS: 10,
    radiusM: 16,
    radiusL: 24,
    radiusFull: 999,
    space: 4.0,
    // type scale
    fontXS: 22,
    fontS: 26,
    fontM: 30,
    fontL: 36,
    fontXL: 44,
    fontXXL: 64,
    // structure
    barHeight: 108.0,
    navHeight: 132.0,
    controlHeight: 88.0,
  };
};

VUI.themeLight = () => {
  let t = VUI.themeDark();
  t.name = "victor-light";
  t.bg = new Color(0.955, 0.96, 0.985, 1.0);
  t.surface = new Color(1.0, 1.0, 1.0, 1.0);
  t.surface2 = new Color(0.92, 0.93, 0.965, 1.0);
  t.surface3 = new Color(0.87, 0.885, 0.93, 1.0);
  t.outline = new Color(0.72, 0.74, 0.82, 1.0);
  t.scrim = new Color(0.08, 0.09, 0.14, 0.45);
  t.primary = new Color(0.24, 0.38, 0.95, 1.0);
  t.primaryDim = new Color(0.24, 0.38, 0.95, 0.13);
  t.onPrimary = new Color(1.0, 1.0, 1.0, 1.0);
  t.accent = new Color(0.0, 0.62, 0.52, 1.0);
  t.text = new Color(0.10, 0.11, 0.16, 1.0);
  t.textDim = new Color(0.36, 0.38, 0.47, 1.0);
  t.textFaint = new Color(0.55, 0.57, 0.65, 1.0);
  return t;
};

// Install a theme (call before building widgets; existing nodes keep the
// styles they were built with — the kit is retained, not reactive).
VUI.use = (t) => {
  __vuiThemeState.t = t;
  return t;
};

// The active theme (auto-installs the dark theme on first use).
VUI.theme = () => {
  if (__vuiThemeState.t == null) {
    __vuiThemeState.t = VUI.themeDark();
  }
  return __vuiThemeState.t;
};

// ---------------------------------------------------------------------------
// style plumbing
// ---------------------------------------------------------------------------

// A StyleBoxFlat from options: { bg, radius, radiusTL/TR/BL/BR, border,
// borderColor, pad, padX, padY, padL/T/R/B, shadow, shadowColor, shadowY }.
VUI.styleBox = (o) => {
  o = o ?? {};
  let sb = GD.create("StyleBoxFlat");
  if (o.bg != null) {
    sb.set("bg_color", o.bg);
  }
  let r = __vuiNum(o.radius, -1);
  if (r >= 0) {
    sb.set("corner_radius_top_left", GInt(__vuiNum(o.radiusTL, r)));
    sb.set("corner_radius_top_right", GInt(__vuiNum(o.radiusTR, r)));
    sb.set("corner_radius_bottom_left", GInt(__vuiNum(o.radiusBL, r)));
    sb.set("corner_radius_bottom_right", GInt(__vuiNum(o.radiusBR, r)));
    // Round pills stay smooth at any size.
    sb.set("corner_detail", GInt(12));
  }
  let bw = __vuiNum(o.border, 0);
  if (bw > 0) {
    sb.set("border_width_left", GInt(bw));
    sb.set("border_width_top", GInt(bw));
    sb.set("border_width_right", GInt(bw));
    sb.set("border_width_bottom", GInt(bw));
    if (o.borderColor != null) {
      sb.set("border_color", o.borderColor);
    }
  }
  let padX = __vuiNum(o.padX, __vuiNum(o.pad, -1));
  let padY = __vuiNum(o.padY, __vuiNum(o.pad, -1));
  if (padX >= 0) {
    sb.set("content_margin_left", GFloat(__vuiNum(o.padL, padX)));
    sb.set("content_margin_right", GFloat(__vuiNum(o.padR, padX)));
  }
  if (padY >= 0) {
    sb.set("content_margin_top", GFloat(__vuiNum(o.padT, padY)));
    sb.set("content_margin_bottom", GFloat(__vuiNum(o.padB, padY)));
  }
  let sh = __vuiNum(o.shadow, 0);
  if (sh > 0) {
    sb.set("shadow_size", GInt(sh));
    sb.set("shadow_color", o.shadowColor ?? new Color(0.0, 0.0, 0.0, 0.28));
    sb.set("shadow_offset", new Vector2(0.0, __vuiNum(o.shadowY, sh * 0.4)));
  }
  sb.set("anti_aliasing", true);
  return sb;
};

// A StyleBoxEmpty (fully transparent, no margins) — for ghost buttons and
// invisible hit areas.
VUI.styleEmpty = () => {
  return GD.create("StyleBoxEmpty");
};

// A crisp filled circle as a texture, generated on the fly (radial
// GradientTexture2D — no image assets anywhere in the kit). Used for slider
// grabbers and anywhere a round sprite is handy.
VUI.circleTexture = (size, color) => {
  let g = GD.create("Gradient");
  g.set("offsets", Packed.f32([0.0, 0.78, 0.86, 1.0]));
  g.set(
    "colors",
    Packed.colors([
      color.r, color.g, color.b, color.a,
      color.r, color.g, color.b, color.a,
      color.r, color.g, color.b, 0.0,
      color.r, color.g, color.b, 0.0,
    ])
  );
  let t = GD.create("GradientTexture2D");
  t.set("gradient", g);
  t.set("fill", GInt(1)); // GradientTexture2D.FILL_RADIAL
  t.set("fill_from", new Vector2(0.5, 0.5));
  t.set("fill_to", new Vector2(0.5, 1.0));
  t.set("width", GInt(size));
  t.set("height", GInt(size));
  return t;
};

// ---------------------------------------------------------------------------
// motion — Godot Tweens over the bridge
// ---------------------------------------------------------------------------

// A fresh Tween bound to a node (kills nothing; chain tween_property calls on
// the returned GObj).
VUI.tween = (node) => {
  return node.call("create_tween");
};

// Tween one property: VUI.animate(node, 'position', Vector2(...), 180).
VUI.animate = (node, prop, to, ms) => {
  let tw = node.call("create_tween");
  if (tw == null || GD.isError(tw)) {
    return null;
  }
  tw.call("set_trans", [GInt(3)]); // Tween.TRANS_QUAD? no: TRANS_QUART=3 — snappy
  tw.call("set_ease", [GInt(2)]); // Tween.EASE_IN_OUT
  tw.call("tween_property", [node, new NodePath(prop), to, GFloat(ms / 1000.0)]);
  return tw;
};

// Fade a Control's alpha to `a` over ms.
VUI.fade = (node, a, ms) => {
  return VUI.animate(node, "modulate:a", GFloat(a), ms);
};

// ---------------------------------------------------------------------------
// the app root — a full-screen 2D page inside any (2D or 3D) scene
// ---------------------------------------------------------------------------
//
// VUI.app creates a CanvasLayer on the hosting node: CanvasLayers composite
// over the viewport, so the 2D UI covers the screen even when the scene root
// is a Node3D world — the 3D environment keeps existing (and can render, or
// not) underneath the page. Options:
//
//   design:   [w, h] — the design resolution; the window content-scales so
//             coordinates in this space fit any screen (default [720, 1280]).
//   portrait: true — lock the screen to portrait: on handheld devices via
//             DisplayServer.screen_set_orientation, on desktop by sizing the
//             window itself to the (portrait) design resolution.
//   bg:       page background color (theme bg when omitted; pass false to
//             leave the world visible behind the UI).
//
// Returns the app handle: { layer, root, overlay, w, h, push(widget) }.
VUI.app = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let dw = 720.0;
  let dh = 1280.0;
  if (o.design != null) {
    dw = o.design[0];
    dh = o.design[1];
  }
  __vuiApp.w = dw;
  __vuiApp.h = dh;

  // Content scale: design-space coordinates fit every real screen.
  let win = GD.tree().call("get_root");
  if (win != null && !GD.isError(win)) {
    win.set("content_scale_size", new Vector2i(dw, dh));
    win.set("content_scale_mode", GD.constant("Window.CONTENT_SCALE_MODE_CANVAS_ITEMS"));
    win.set("content_scale_aspect", GD.constant("Window.CONTENT_SCALE_ASPECT_EXPAND"));
  }

  if (o.portrait == true) {
    let os = GD.os();
    let mobile = os.call("has_feature", ["mobile"]);
    if (mobile == true) {
      GD.displayServer().call("screen_set_orientation", [
        GD.constant("DisplayServer.SCREEN_PORTRAIT"),
      ]);
    } else {
      // Desktop preview: make the window itself portrait at the design size.
      GD.displayServer().call("window_set_size", [new Vector2i(dw, dh)]);
    }
  }

  let layer = GD.create("CanvasLayer");
  GD.mount(layer);

  // The page root: a full-rect Control carrying the background.
  let root = GD.create("Control");
  root.set("name", "VuiRoot");
  __vuiFullRect(root);
  layer.call("add_child", [root]);
  if (o.bg != false) {
    let bgPanel = GD.create("Panel");
    __vuiFullRect(bgPanel);
    bgPanel.set("theme_override_styles/panel", VUI.styleBox({ bg: o.bg ?? t.bg }));
    bgPanel.set("mouse_filter", GInt(2)); // MOUSE_FILTER_IGNORE
    root.call("add_child", [bgPanel]);
  }

  // The overlay: dialogs, sheets and toasts mount here, always on top.
  let overlay = GD.create("Control");
  overlay.set("name", "VuiOverlay");
  __vuiFullRect(overlay);
  overlay.set("mouse_filter", GInt(2)); // ignore until something is shown
  layer.call("add_child", [overlay]);

  __vuiApp.layer = layer;
  __vuiApp.root = root;
  __vuiApp.overlay = overlay;

  return {
    layer: layer,
    node: root,
    root: root,
    overlay: overlay,
    w: dw,
    h: dh,
    // Mount a full-screen page widget.
    push: (widget) => {
      let n = __vuiNode(widget);
      __vuiFullRect(n);
      __vuiApp.root.call("add_child", [n]);
      return n;
    },
  };
};

// ---------------------------------------------------------------------------
// layout
// ---------------------------------------------------------------------------

function __vuiWrapPad(inner, pad) {
  if (pad == null) {
    return inner;
  }
  let m = GD.create("MarginContainer");
  let p = __vuiNum(pad, 0);
  m.set("theme_override_constants/margin_left", GInt(p));
  m.set("theme_override_constants/margin_top", GInt(p));
  m.set("theme_override_constants/margin_right", GInt(p));
  m.set("theme_override_constants/margin_bottom", GInt(p));
  m.call("add_child", [inner]);
  return m;
}

// Vertical stack: { gap, pad, children, expand }.
VUI.column = (o) => {
  o = o ?? {};
  let box = GD.create("VBoxContainer");
  box.set("theme_override_constants/separation", GInt(__vuiNum(o.gap, 16)));
  __vuiAddAll(box, o.children);
  if (o.expand == true) {
    __vuiExpandH(box);
    __vuiExpandV(box);
  }
  return __vuiWrapPad(box, o.pad);
};

// Horizontal stack: { gap, pad, children, expand }.
VUI.row = (o) => {
  o = o ?? {};
  let box = GD.create("HBoxContainer");
  box.set("theme_override_constants/separation", GInt(__vuiNum(o.gap, 16)));
  __vuiAddAll(box, o.children);
  if (o.expand == true) {
    __vuiExpandH(box);
  }
  return __vuiWrapPad(box, o.pad);
};

// Grid: { cols, gap, children }.
VUI.grid = (o) => {
  o = o ?? {};
  let g = GD.create("GridContainer");
  g.set("columns", GInt(__vuiNum(o.cols, 2)));
  let gap = __vuiNum(o.gap, 16);
  g.set("theme_override_constants/h_separation", GInt(gap));
  g.set("theme_override_constants/v_separation", GInt(gap));
  __vuiAddAll(g, o.children);
  return g;
};

// Scrollable area: { child, horizontal }. The child expands to the scroll
// width so columns lay out naturally.
VUI.scroll = (o) => {
  o = o ?? {};
  let sc = GD.create("ScrollContainer");
  __vuiExpandH(sc);
  __vuiExpandV(sc);
  sc.set("horizontal_scroll_mode", GInt(o.horizontal == true ? 1 : 0));
  let c = __vuiNode(o.child);
  if (c != null) {
    __vuiExpandH(c);
    sc.call("add_child", [c]);
  }
  return sc;
};

// Uniform padding around one child: { pad, child }.
VUI.margin = (o) => {
  o = o ?? {};
  let c = __vuiNode(o.child);
  let m = __vuiWrapPad(c, __vuiNum(o.pad, 16));
  return m;
};

// Center one child both ways: { child }.
VUI.center = (o) => {
  o = o ?? {};
  let c = GD.create("CenterContainer");
  __vuiExpandH(c);
  __vuiExpandV(c);
  let n = __vuiNode(o.child);
  if (n != null) {
    c.call("add_child", [n]);
  }
  return c;
};

// A styled surface wrapping children: { bg, radius, border, borderColor, pad,
// gap, children, child }.
VUI.panel = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let p = GD.create("PanelContainer");
  p.set(
    "theme_override_styles/panel",
    VUI.styleBox({
      bg: o.bg ?? t.surface,
      radius: __vuiNum(o.radius, t.radiusM),
      border: __vuiNum(o.border, 0),
      borderColor: o.borderColor,
      pad: __vuiNum(o.pad, 24),
      shadow: __vuiNum(o.shadow, 0),
    })
  );
  if (o.child != null) {
    p.call("add_child", [__vuiNode(o.child)]);
  } else if (o.children != null) {
    let col = GD.create("VBoxContainer");
    col.set("theme_override_constants/separation", GInt(__vuiNum(o.gap, 16)));
    __vuiAddAll(col, o.children);
    p.call("add_child", [col]);
  }
  return p;
};

// Flexible empty space (soaks up leftover room in a row/column).
VUI.spacer = () => {
  let s = GD.create("Control");
  __vuiExpandH(s);
  __vuiExpandV(s);
  s.set("mouse_filter", GInt(2));
  return s;
};

// A hairline separator: { vertical, inset }.
VUI.divider = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let d = GD.create("Panel");
  d.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: new Color(t.outline.r, t.outline.g, t.outline.b, 0.45), radius: 1 })
  );
  if (o.vertical == true) {
    __vuiMinSize(d, 2.0, 8.0);
    __vuiExpandV(d);
  } else {
    __vuiMinSize(d, 8.0, 2.0);
    __vuiExpandH(d);
  }
  d.set("mouse_filter", GInt(2));
  return d;
};

// Mark a widget to expand-fill its parent container; returns it.
VUI.expand = (w) => {
  let n = __vuiNode(w);
  __vuiExpandH(n);
  __vuiExpandV(n);
  return w;
};

// Fixed-size box around nothing (a strut): { w, h }.
VUI.gap = (o) => {
  o = o ?? {};
  let s = GD.create("Control");
  __vuiMinSize(s, __vuiNum(o.w, 0.0), __vuiNum(o.h, 0.0));
  s.set("mouse_filter", GInt(2));
  return s;
};

// ---------------------------------------------------------------------------
// content
// ---------------------------------------------------------------------------

// A text label: (str, { size, color, dim, faint, align: 'left|center|right',
// wrap, expand }).
VUI.text = (str, o) => {
  o = o ?? {};
  let t = VUI.theme();
  let l = GD.create("Label");
  l.set("text", "" + str);
  l.set("theme_override_font_sizes/font_size", GInt(__vuiNum(o.size, t.fontM)));
  let color = o.color;
  if (color == null) {
    color = t.text;
    if (o.dim == true) {
      color = t.textDim;
    }
    if (o.faint == true) {
      color = t.textFaint;
    }
  }
  l.set("theme_override_colors/font_color", color);
  if (o.align == "center") {
    l.set("horizontal_alignment", GInt(1));
  } else if (o.align == "right") {
    l.set("horizontal_alignment", GInt(2));
  }
  if (o.wrap == true) {
    l.set("autowrap_mode", GInt(3)); // TextServer.AUTOWRAP_WORD_SMART
    __vuiExpandH(l);
  }
  if (o.expand == true) {
    __vuiExpandH(l);
  }
  return l;
};

VUI.heading = (str, o) => {
  o = o ?? {};
  let t = VUI.theme();
  o.size = __vuiNum(o.size, t.fontXL);
  return VUI.text(str, o);
};

VUI.title = (str, o) => {
  o = o ?? {};
  let t = VUI.theme();
  o.size = __vuiNum(o.size, t.fontL);
  return VUI.text(str, o);
};

VUI.caption = (str, o) => {
  o = o ?? {};
  let t = VUI.theme();
  o.size = __vuiNum(o.size, t.fontXS);
  if (o.color == null) {
    o.dim = true;
  }
  return VUI.text(str, o);
};

// A unicode glyph as an icon: (glyph, { size, color }).
VUI.icon = (glyph, o) => {
  o = o ?? {};
  let t = VUI.theme();
  o.size = __vuiNum(o.size, t.fontL);
  o.align = o.align ?? "center";
  return VUI.text(glyph, o);
};

// A tiny status pill: (str, { color, textColor }).
VUI.badge = (str, o) => {
  o = o ?? {};
  let t = VUI.theme();
  let p = GD.create("PanelContainer");
  p.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: o.color ?? t.primary, radius: t.radiusFull, padX: 18, padY: 4 })
  );
  p.call("add_child", [
    VUI.text(str, { size: t.fontXS, color: o.textColor ?? t.onPrimary }),
  ]);
  return p;
};

// A selectable chip: (str, { selected, onTap }). Returns a handle
// { node, setSelected(b), isSelected() }.
VUI.chip = (str, o) => {
  o = o ?? {};
  let t = VUI.theme();
  let st = { on: o.selected == true };
  let b = GD.create("Button");
  b.set("text", "" + str);
  b.set("theme_override_font_sizes/font_size", GInt(t.fontXS));
  b.set("focus_mode", GInt(0));

  let offSb = VUI.styleBox({
    bg: t.surface2, radius: t.radiusFull, padX: 26, padY: 12,
    border: 1, borderColor: t.outline,
  });
  let onSb = VUI.styleBox({
    bg: t.primaryDim, radius: t.radiusFull, padX: 26, padY: 12,
    border: 1, borderColor: t.primary,
  });
  let apply = () => {
    let sb = st.on ? onSb : offSb;
    b.set("theme_override_styles/normal", sb);
    b.set("theme_override_styles/hover", sb);
    b.set("theme_override_styles/pressed", sb);
    b.set("theme_override_colors/font_color", st.on ? t.primary : t.textDim);
    b.set("theme_override_colors/font_hover_color", st.on ? t.primary : t.text);
    b.set("theme_override_colors/font_pressed_color", t.primary);
  };
  apply();
  b.connect("pressed", (a) => {
    st.on = !st.on;
    apply();
    if (o.onTap != null) {
      o.onTap(st.on);
    }
  });
  return {
    node: b,
    isSelected: () => st.on,
    setSelected: (v) => {
      st.on = v == true;
      apply();
    },
  };
};

// A circular initials avatar: (initials, { color, textColor, size }).
VUI.avatar = (initials, o) => {
  o = o ?? {};
  let t = VUI.theme();
  let d = __vuiNum(o.size, 84.0);
  let p = GD.create("PanelContainer");
  __vuiMinSize(p, d, d);
  p.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: o.color ?? t.primary, radius: t.radiusFull })
  );
  let l = VUI.text(initials, {
    size: d * 0.4,
    color: o.textColor ?? t.onPrimary,
    align: "center",
  });
  l.set("vertical_alignment", GInt(1)); // centered
  p.call("add_child", [l]);
  return p;
};

// An elevated content card: { children, child, gap, pad, accent }.
VUI.card = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  o.bg = o.bg ?? t.surface;
  o.radius = __vuiNum(o.radius, t.radiusL);
  o.pad = __vuiNum(o.pad, 28);
  o.shadow = __vuiNum(o.shadow, 10);
  if (o.accent != null) {
    o.border = 1;
    o.borderColor = o.accent;
  }
  return VUI.panel(o);
};

// A dashboard stat tile: { label, value, glyph, accent }. Returns a handle
// { node, setValue(v) }.
VUI.stat = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let accent = o.accent ?? t.primary;
  let valueLabel = VUI.text("" + (o.value ?? ""), { size: t.fontXL, color: t.text });
  let children = [];
  if (o.glyph != null) {
    children.push(
      VUI.row({
        gap: 12,
        children: [
          VUI.icon(o.glyph, { size: t.fontM, color: accent }),
          VUI.caption(o.label ?? ""),
        ],
      })
    );
  } else {
    children.push(VUI.caption(o.label ?? ""));
  }
  children.push(valueLabel);
  let card = VUI.panel({
    bg: t.surface,
    radius: t.radiusL,
    pad: 24,
    gap: 8,
    children: children,
  });
  __vuiExpandH(card);
  return {
    node: card,
    setValue: (v) => {
      valueLabel.set("text", "" + v);
    },
  };
};

// A tappable list row: { leading (glyph), leadingColor, title, subtitle,
// trailing (string or widget), onTap }.
VUI.listTile = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let b = GD.create("Button");
  b.set("focus_mode", GInt(0));
  let normal = VUI.styleBox({ bg: t.surface, radius: t.radiusM });
  let hover = VUI.styleBox({ bg: t.surface2, radius: t.radiusM });
  let pressed = VUI.styleBox({ bg: t.surface3, radius: t.radiusM });
  b.set("theme_override_styles/normal", normal);
  b.set("theme_override_styles/hover", hover);
  b.set("theme_override_styles/pressed", pressed);
  __vuiMinSize(b, 0.0, 128.0);
  __vuiExpandH(b);

  let content = GD.create("MarginContainer");
  __vuiFullRect(content);
  content.set("theme_override_constants/margin_left", GInt(24));
  content.set("theme_override_constants/margin_right", GInt(24));
  content.set("theme_override_constants/margin_top", GInt(16));
  content.set("theme_override_constants/margin_bottom", GInt(16));
  content.set("mouse_filter", GInt(2)); // let the button take the clicks

  let items = [];
  if (o.leading != null) {
    let iconWrap = GD.create("PanelContainer");
    __vuiMinSize(iconWrap, 76.0, 76.0);
    iconWrap.set(
      "theme_override_styles/panel",
      VUI.styleBox({ bg: t.surface3, radius: t.radiusM })
    );
    let ic = VUI.icon(o.leading, { size: t.fontM, color: o.leadingColor ?? t.primary });
    ic.set("vertical_alignment", GInt(1));
    iconWrap.call("add_child", [ic]);
    items.push(iconWrap);
  }
  let mid = [];
  mid.push(VUI.text(o.title ?? "", { size: t.fontS }));
  if (o.subtitle != null) {
    mid.push(VUI.caption(o.subtitle));
  }
  let midCol = VUI.column({ gap: 4, children: mid });
  __vuiExpandH(midCol);
  items.push(midCol);
  if (o.trailing != null) {
    if (__isType(o.trailing, "String")) {
      items.push(VUI.text(o.trailing, { size: t.fontXS, faint: true }));
    } else {
      items.push(__vuiNode(o.trailing));
    }
  }
  let rowBox = GD.create("HBoxContainer");
  rowBox.set("theme_override_constants/separation", GInt(20));
  rowBox.set("mouse_filter", GInt(2));
  __vuiAddAll(rowBox, items);
  content.call("add_child", [rowBox]);
  b.call("add_child", [content]);

  if (o.onTap != null) {
    b.connect("pressed", (a) => {
      o.onTap();
    });
  }
  return b;
};

// ---------------------------------------------------------------------------
// controls
// ---------------------------------------------------------------------------

// The button. (text, { kind: 'filled'|'tonal'|'outline'|'ghost'|'danger',
// glyph, onTap, wide, height, fontSize }).
VUI.button = (text, o) => {
  o = o ?? {};
  let t = VUI.theme();
  let kind = o.kind ?? "filled";
  let h = __vuiNum(o.height, t.controlHeight);
  let b = GD.create("Button");
  let label = "" + text;
  if (o.glyph != null) {
    label = o.glyph + "  " + label;
  }
  b.set("text", label);
  b.set("theme_override_font_sizes/font_size", GInt(__vuiNum(o.fontSize, t.fontS)));
  b.set("focus_mode", GInt(0));
  __vuiMinSize(b, __vuiNum(o.minWidth, 0.0), h);
  if (o.wide == true) {
    __vuiExpandH(b);
  }

  let radius = __vuiNum(o.radius, t.radiusM);
  let padX = 36;
  if (kind == "filled") {
    b.set("theme_override_styles/normal", VUI.styleBox({ bg: t.primary, radius: radius, padX: padX }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: t.primary.lighter(0.06), radius: radius, padX: padX }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: t.primary.darker(0.08), radius: radius, padX: padX }));
    b.set("theme_override_colors/font_color", t.onPrimary);
    b.set("theme_override_colors/font_hover_color", t.onPrimary);
    b.set("theme_override_colors/font_pressed_color", t.onPrimary);
  } else if (kind == "tonal") {
    b.set("theme_override_styles/normal", VUI.styleBox({ bg: t.primaryDim, radius: radius, padX: padX }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: t.surface3, radius: radius, padX: padX }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: t.surface2, radius: radius, padX: padX }));
    b.set("theme_override_colors/font_color", t.primary);
    b.set("theme_override_colors/font_hover_color", t.primary);
    b.set("theme_override_colors/font_pressed_color", t.primary);
  } else if (kind == "outline") {
    b.set("theme_override_styles/normal", VUI.styleBox({ radius: radius, padX: padX, border: 2, borderColor: t.outline, bg: new Color(0.0, 0.0, 0.0, 0.0) }));
    b.set("theme_override_styles/hover", VUI.styleBox({ radius: radius, padX: padX, border: 2, borderColor: t.primary, bg: t.primaryDim }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ radius: radius, padX: padX, border: 2, borderColor: t.primary, bg: t.primaryDim }));
    b.set("theme_override_colors/font_color", t.text);
    b.set("theme_override_colors/font_hover_color", t.primary);
    b.set("theme_override_colors/font_pressed_color", t.primary);
  } else if (kind == "danger") {
    b.set("theme_override_styles/normal", VUI.styleBox({ bg: t.danger, radius: radius, padX: padX }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: t.danger.lighter(0.06), radius: radius, padX: padX }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: t.danger.darker(0.1), radius: radius, padX: padX }));
    b.set("theme_override_colors/font_color", new Color(1.0, 1.0, 1.0, 1.0));
    b.set("theme_override_colors/font_hover_color", new Color(1.0, 1.0, 1.0, 1.0));
    b.set("theme_override_colors/font_pressed_color", new Color(1.0, 1.0, 1.0, 1.0));
  } else {
    // ghost
    b.set("theme_override_styles/normal", VUI.styleEmpty());
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: t.surface2, radius: radius, padX: padX }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: t.surface3, radius: radius, padX: padX }));
    b.set("theme_override_colors/font_color", t.primary);
    b.set("theme_override_colors/font_hover_color", t.primary);
    b.set("theme_override_colors/font_pressed_color", t.primary);
  }

  if (o.onTap != null) {
    b.connect("pressed", (a) => {
      o.onTap();
    });
  }
  return b;
};

// A round icon-only button: (glyph, { onTap, size, color, bg }).
VUI.iconButton = (glyph, o) => {
  o = o ?? {};
  let t = VUI.theme();
  let d = __vuiNum(o.size, 88.0);
  let b = GD.create("Button");
  b.set("text", glyph);
  b.set("theme_override_font_sizes/font_size", GInt(d * 0.42));
  b.set("focus_mode", GInt(0));
  __vuiMinSize(b, d, d);
  b.set("theme_override_styles/normal", VUI.styleBox({ bg: o.bg ?? t.surface2, radius: t.radiusFull }));
  b.set("theme_override_styles/hover", VUI.styleBox({ bg: t.surface3, radius: t.radiusFull }));
  b.set("theme_override_styles/pressed", VUI.styleBox({ bg: t.primaryDim, radius: t.radiusFull }));
  b.set("theme_override_colors/font_color", o.color ?? t.text);
  b.set("theme_override_colors/font_hover_color", o.color ?? t.text);
  b.set("theme_override_colors/font_pressed_color", t.primary);
  if (o.onTap != null) {
    b.connect("pressed", (a) => {
      o.onTap();
    });
  }
  return b;
};

// A text input: { placeholder, value, obscure, glyph, onChanged(text),
// onSubmit(text) }. Returns a handle { node, getText(), setText(v) }.
VUI.field = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let e = GD.create("LineEdit");
  let st = { text: "" + (o.value ?? "") };
  if (o.placeholder != null) {
    e.set("placeholder_text", o.placeholder);
  }
  if (st.text != "") {
    e.set("text", st.text);
  }
  if (o.obscure == true) {
    e.set("secret", true);
  }
  e.set("theme_override_font_sizes/font_size", GInt(t.fontS));
  __vuiMinSize(e, 0.0, t.controlHeight);
  __vuiExpandH(e);
  e.set(
    "theme_override_styles/normal",
    VUI.styleBox({ bg: t.surface2, radius: t.radiusM, padX: 28, border: 1, borderColor: t.outline })
  );
  e.set(
    "theme_override_styles/focus",
    VUI.styleBox({ bg: t.surface2, radius: t.radiusM, padX: 28, border: 2, borderColor: t.primary })
  );
  e.set("theme_override_colors/font_color", t.text);
  e.set("theme_override_colors/font_placeholder_color", t.textFaint);
  e.set("theme_override_colors/caret_color", t.primary);
  e.connect("text_changed", (args) => {
    st.text = args[0];
    if (o.onChanged != null) {
      o.onChanged(args[0]);
    }
  });
  if (o.onSubmit != null) {
    e.connect("text_submitted", (args) => {
      st.text = args[0];
      o.onSubmit(args[0]);
    });
  }
  return {
    node: e,
    getText: () => st.text,
    setText: (v) => {
      st.text = "" + v;
      e.set("text", st.text);
    },
  };
};

// An animated switch: { value, onChanged(bool) }. A hand-built control —
// pill track + sliding knob, tweened over the bridge. Returns a handle
// { node, isOn(), setOn(v) }.
VUI.toggle = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let w = 108.0;
  let h = 60.0;
  let knobD = 44.0;
  let inset = (h - knobD) / 2.0;
  let st = { on: o.value == true };

  let b = GD.create("Button");
  b.set("focus_mode", GInt(0));
  __vuiMinSize(b, w, h);
  b.set("theme_override_styles/normal", VUI.styleEmpty());
  b.set("theme_override_styles/hover", VUI.styleEmpty());
  b.set("theme_override_styles/pressed", VUI.styleEmpty());

  let offTrack = VUI.styleBox({ bg: t.surface3, radius: t.radiusFull, border: 1, borderColor: t.outline });
  let onTrack = VUI.styleBox({ bg: t.primary, radius: t.radiusFull });
  let track = GD.create("Panel");
  __vuiFullRect(track);
  track.set("mouse_filter", GInt(2));
  track.set("theme_override_styles/panel", st.on ? onTrack : offTrack);
  b.call("add_child", [track]);

  let knob = GD.create("Panel");
  __vuiMinSize(knob, knobD, knobD);
  knob.set("size", new Vector2(knobD, knobD));
  knob.set("mouse_filter", GInt(2));
  knob.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: new Color(1.0, 1.0, 1.0, 1.0), radius: t.radiusFull, shadow: 4 })
  );
  let xOff = inset;
  let xOn = w - knobD - inset;
  knob.set("position", new Vector2(st.on ? xOn : xOff, inset));
  b.call("add_child", [knob]);

  let apply = (animate) => {
    track.set("theme_override_styles/panel", st.on ? onTrack : offTrack);
    let target = new Vector2(st.on ? xOn : xOff, inset);
    if (animate == true) {
      VUI.animate(knob, "position", target, 140);
    } else {
      knob.set("position", target);
    }
  };
  b.connect("pressed", (a) => {
    st.on = !st.on;
    apply(true);
    if (o.onChanged != null) {
      o.onChanged(st.on);
    }
  });
  return {
    node: b,
    isOn: () => st.on,
    setOn: (v) => {
      st.on = v == true;
      apply(false);
    },
  };
};

// A checkbox with a label: { label, value, onChanged(bool) }. Returns a
// handle { node, isChecked(), setChecked(v) }.
VUI.checkbox = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let st = { on: o.value == true };
  let d = 52.0;

  let b = GD.create("Button");
  b.set("focus_mode", GInt(0));
  b.set("theme_override_styles/normal", VUI.styleEmpty());
  b.set("theme_override_styles/hover", VUI.styleEmpty());
  b.set("theme_override_styles/pressed", VUI.styleEmpty());
  __vuiMinSize(b, 0.0, d + 12.0);

  let boxOff = VUI.styleBox({ bg: t.surface2, radius: t.radiusS, border: 2, borderColor: t.outline });
  let boxOn = VUI.styleBox({ bg: t.primary, radius: t.radiusS });
  let box = GD.create("PanelContainer");
  __vuiMinSize(box, d, d);
  box.set("mouse_filter", GInt(2));
  box.set("theme_override_styles/panel", st.on ? boxOn : boxOff);
  let mark = VUI.text("✓", { size: t.fontS, color: t.onPrimary, align: "center" });
  mark.set("vertical_alignment", GInt(1));
  mark.set("visible", st.on);
  box.call("add_child", [mark]);

  let items = [box];
  if (o.label != null) {
    items.push(VUI.text(o.label, { size: t.fontS, dim: true }));
  }
  let rowBox = GD.create("HBoxContainer");
  rowBox.set("theme_override_constants/separation", GInt(18));
  rowBox.set("mouse_filter", GInt(2));
  __vuiFullRect(rowBox);
  __vuiAddAll(rowBox, items);
  b.call("add_child", [rowBox]);

  let apply = () => {
    box.set("theme_override_styles/panel", st.on ? boxOn : boxOff);
    mark.set("visible", st.on);
  };
  b.connect("pressed", (a) => {
    st.on = !st.on;
    apply();
    if (o.onChanged != null) {
      o.onChanged(st.on);
    }
  });
  return {
    node: b,
    isChecked: () => st.on,
    setChecked: (v) => {
      st.on = v == true;
      apply();
    },
  };
};

// A slider: { min, max, value, step, onChanged(value) }. Returns a handle
// { node, getValue(), setValue(v) }.
VUI.slider = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let s = GD.create("HSlider");
  let st = { value: __vuiNum(o.value, 0.0) };
  s.set("min_value", GFloat(__vuiNum(o.min, 0.0)));
  s.set("max_value", GFloat(__vuiNum(o.max, 100.0)));
  if (o.step != null) {
    s.set("step", GFloat(o.step));
  }
  s.set("value", GFloat(st.value));
  s.set("focus_mode", GInt(0));
  __vuiMinSize(s, 0.0, 56.0);
  __vuiExpandH(s);
  // The groove…
  s.set(
    "theme_override_styles/slider",
    VUI.styleBox({ bg: t.surface3, radius: t.radiusFull, padY: 6 })
  );
  // …the filled part…
  s.set(
    "theme_override_styles/grabber_area",
    VUI.styleBox({ bg: t.primary, radius: t.radiusFull })
  );
  s.set(
    "theme_override_styles/grabber_area_highlight",
    VUI.styleBox({ bg: t.primary, radius: t.radiusFull })
  );
  // …and a code-generated round grabber (no image assets).
  let grabber = VUI.circleTexture(44, new Color(1.0, 1.0, 1.0, 1.0));
  let grabberHi = VUI.circleTexture(52, t.primary.lighter(0.15));
  s.set("theme_override_icons/grabber", grabber);
  s.set("theme_override_icons/grabber_disabled", grabber);
  s.set("theme_override_icons/grabber_highlight", grabberHi);
  s.connect("value_changed", (args) => {
    st.value = args[0];
    if (o.onChanged != null) {
      o.onChanged(args[0]);
    }
  });
  return {
    node: s,
    getValue: () => st.value,
    setValue: (v) => {
      st.value = v;
      s.set("value", GFloat(v));
    },
  };
};

// A progress bar: { value, max, height }. Returns a handle
// { node, setValue(v) }.
VUI.progress = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let p = GD.create("ProgressBar");
  p.set("min_value", GFloat(0.0));
  p.set("max_value", GFloat(__vuiNum(o.max, 100.0)));
  p.set("value", GFloat(__vuiNum(o.value, 0.0)));
  p.set("show_percentage", false);
  __vuiMinSize(p, 0.0, __vuiNum(o.height, 18.0));
  __vuiExpandH(p);
  p.set(
    "theme_override_styles/background",
    VUI.styleBox({ bg: t.surface3, radius: t.radiusFull })
  );
  p.set(
    "theme_override_styles/fill",
    VUI.styleBox({ bg: o.color ?? t.primary, radius: t.radiusFull })
  );
  return {
    node: p,
    setValue: (v) => {
      p.set("value", GFloat(v));
    },
  };
};

// ---------------------------------------------------------------------------
// structure
// ---------------------------------------------------------------------------

// The top app bar: { title, subtitle, leading (widget), actions: [widget] }.
VUI.appBar = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let bar = GD.create("PanelContainer");
  __vuiMinSize(bar, 0.0, t.barHeight);
  bar.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: t.surface, radiusBL: t.radiusL, radiusBR: t.radiusL, radius: 0, padX: 28, padY: 16, shadow: 8 })
  );
  let items = [];
  if (o.leading != null) {
    items.push(__vuiNode(o.leading));
  }
  let titleCol = [];
  titleCol.push(VUI.text(o.title ?? "", { size: t.fontL }));
  if (o.subtitle != null) {
    titleCol.push(VUI.caption(o.subtitle));
  }
  let mid = VUI.column({ gap: 2, children: titleCol });
  __vuiExpandH(mid);
  items.push(mid);
  if (o.actions != null) {
    for (let i = 0; i < o.actions.length; i++) {
      items.push(__vuiNode(o.actions[i]));
    }
  }
  let rowBox = GD.create("HBoxContainer");
  rowBox.set("theme_override_constants/separation", GInt(20));
  __vuiAddAll(rowBox, items);
  bar.call("add_child", [rowBox]);
  return bar;
};

// A segmented tab strip: { items: [label], index, onSelect(i) }. Returns a
// handle { node, select(i), getIndex() }.
VUI.tabs = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let st = { index: __vuiNum(o.index, 0), buttons: [] };
  let wrap = GD.create("PanelContainer");
  wrap.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: t.surface2, radius: t.radiusFull, pad: 8 })
  );
  let rowBox = GD.create("HBoxContainer");
  rowBox.set("theme_override_constants/separation", GInt(8));
  wrap.call("add_child", [rowBox]);

  let onSb = VUI.styleBox({ bg: t.primary, radius: t.radiusFull, padX: 30, padY: 14 });
  let offSb = VUI.styleEmpty();

  let applyAll = () => {
    for (let i = 0; i < st.buttons.length; i++) {
      let selected = i == st.index;
      let bb = st.buttons[i];
      bb.set("theme_override_styles/normal", selected ? onSb : offSb);
      bb.set("theme_override_styles/hover", selected ? onSb : offSb);
      bb.set("theme_override_styles/pressed", selected ? onSb : offSb);
      bb.set("theme_override_colors/font_color", selected ? t.onPrimary : t.textDim);
      bb.set("theme_override_colors/font_hover_color", selected ? t.onPrimary : t.text);
      bb.set("theme_override_colors/font_pressed_color", selected ? t.onPrimary : t.text);
    }
  };
  let items = o.items ?? [];
  for (let i = 0; i < items.length; i++) {
    // A fresh `let` per iteration: each closure captures its own index.
    let idx = i;
    let b = GD.create("Button");
    b.set("text", "" + items[i]);
    b.set("theme_override_font_sizes/font_size", GInt(t.fontXS));
    b.set("focus_mode", GInt(0));
    __vuiExpandH(b);
    b.connect("pressed", (a) => {
      st.index = idx;
      applyAll();
      if (o.onSelect != null) {
        o.onSelect(idx);
      }
    });
    st.buttons.push(b);
    rowBox.call("add_child", [b]);
  }
  applyAll();
  return {
    node: wrap,
    getIndex: () => st.index,
    select: (i) => {
      st.index = i;
      applyAll();
      if (o.onSelect != null) {
        o.onSelect(i);
      }
    },
  };
};

// The bottom navigation bar: { items: [{glyph, label}], index, onSelect(i) }.
// Returns a handle { node, select(i), getIndex() }.
VUI.bottomNav = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let st = { index: __vuiNum(o.index, 0), glyphs: [], labels: [] };
  let bar = GD.create("PanelContainer");
  __vuiMinSize(bar, 0.0, t.navHeight);
  bar.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: t.surface, radiusTL: t.radiusL, radiusTR: t.radiusL, radius: 0, padY: 12, shadow: 12 })
  );
  let rowBox = GD.create("HBoxContainer");
  rowBox.set("theme_override_constants/separation", GInt(0));
  bar.call("add_child", [rowBox]);

  let applyAll = () => {
    for (let i = 0; i < st.glyphs.length; i++) {
      let selected = i == st.index;
      st.glyphs[i].set(
        "theme_override_colors/font_color",
        selected ? t.primary : t.textFaint
      );
      st.labels[i].set(
        "theme_override_colors/font_color",
        selected ? t.primary : t.textFaint
      );
    }
  };
  let items = o.items ?? [];
  for (let i = 0; i < items.length; i++) {
    let idx = i;
    let b = GD.create("Button");
    b.set("focus_mode", GInt(0));
    b.set("theme_override_styles/normal", VUI.styleEmpty());
    b.set("theme_override_styles/hover", VUI.styleEmpty());
    b.set("theme_override_styles/pressed", VUI.styleEmpty());
    __vuiExpandH(b);

    let glyph = VUI.icon(items[i]["glyph"] ?? "•", { size: t.fontL, color: t.textFaint });
    let label = VUI.text(items[i]["label"] ?? "", { size: t.fontXS, color: t.textFaint, align: "center" });
    let col = GD.create("VBoxContainer");
    col.set("theme_override_constants/separation", GInt(2));
    col.set("mouse_filter", GInt(2));
    __vuiFullRect(col);
    col.set("alignment", GInt(1)); // centered
    col.call("add_child", [glyph]);
    col.call("add_child", [label]);
    b.call("add_child", [col]);

    b.connect("pressed", (a) => {
      st.index = idx;
      applyAll();
      if (o.onSelect != null) {
        o.onSelect(idx);
      }
    });
    st.glyphs.push(glyph);
    st.labels.push(label);
    rowBox.call("add_child", [b]);
  }
  applyAll();
  return {
    node: bar,
    getIndex: () => st.index,
    select: (i) => {
      st.index = i;
      applyAll();
      if (o.onSelect != null) {
        o.onSelect(i);
      }
    },
  };
};

// ---- overlay helpers (dialogs / sheets / toasts mount on the app overlay) --

function __vuiOverlayOn() {
  __vuiApp.overlay.set("mouse_filter", GInt(0)); // MOUSE_FILTER_STOP
}

function __vuiOverlayOff() {
  __vuiApp.overlay.set("mouse_filter", GInt(2)); // MOUSE_FILTER_IGNORE
}

// A dimmed full-screen scrim button; onTap dismisses.
function __vuiScrim(onTap) {
  let t = VUI.theme();
  let s = GD.create("Button");
  __vuiFullRect(s);
  s.set("focus_mode", GInt(0));
  s.set("theme_override_styles/normal", VUI.styleBox({ bg: t.scrim }));
  s.set("theme_override_styles/hover", VUI.styleBox({ bg: t.scrim }));
  s.set("theme_override_styles/pressed", VUI.styleBox({ bg: t.scrim }));
  s.connect("pressed", (a) => {
    onTap();
  });
  return s;
}

// A modal dialog: { title, body (string or widget), actions: [{text, kind,
// onTap}], width, dismissible }. Shows immediately; returns { close() }.
VUI.dialog = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let w = __vuiNum(o.width, __vuiApp.w - 120.0);
  let holder = GD.create("Control");
  __vuiFullRect(holder);
  __vuiApp.overlay.call("add_child", [holder]);
  __vuiOverlayOn();

  let closed = { done: false };
  let close = () => {
    if (closed.done) {
      return;
    }
    closed.done = true;
    VUI.fade(holder, 0.0, 130);
    GTimer.after(150, () => {
      holder.queueFree();
    });
    __vuiOverlayOff();
  };

  holder.call("add_child", [__vuiScrim(() => {
    if (o.dismissible != false) {
      close();
    }
  })]);

  let children = [];
  if (o.title != null) {
    children.push(VUI.title(o.title));
  }
  if (o.body != null) {
    if (__isType(o.body, "String")) {
      children.push(VUI.text(o.body, { size: t.fontS, dim: true, wrap: true }));
    } else {
      children.push(__vuiNode(o.body));
    }
  }
  if (o.actions != null) {
    let btns = [VUI.spacer()];
    for (let i = 0; i < o.actions.length; i++) {
      let spec = o.actions[i];
      btns.push(
        VUI.button(spec["text"] ?? "OK", {
          kind: spec["kind"] ?? "ghost",
          height: 76.0,
          onTap: () => {
            close();
            if (spec["onTap"] != null) {
              spec["onTap"]();
            }
          },
        })
      );
    }
    children.push(VUI.row({ gap: 12, children: btns }));
  }

  let card = VUI.panel({
    bg: t.surface,
    radius: t.radiusL,
    pad: 32,
    gap: 20,
    shadow: 20,
    children: children,
  });
  // Centered at a fixed width via anchors + symmetric offsets.
  card.set("anchor_left", GFloat(0.5));
  card.set("anchor_right", GFloat(0.5));
  card.set("anchor_top", GFloat(0.5));
  card.set("anchor_bottom", GFloat(0.5));
  card.set("offset_left", GFloat(0.0 - w / 2.0));
  card.set("offset_right", GFloat(w / 2.0));
  card.set("grow_horizontal", GInt(2)); // GROW_DIRECTION_BOTH
  card.set("grow_vertical", GInt(2));
  holder.call("add_child", [card]);

  // Entrance: fade the whole holder in.
  holder.set("modulate", new Color(1.0, 1.0, 1.0, 0.0));
  VUI.fade(holder, 1.0, 150);

  return { node: holder, close: close };
};

// A bottom sheet: { title, children, dismissible }. Returns { close() }.
VUI.sheet = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let holder = GD.create("Control");
  __vuiFullRect(holder);
  __vuiApp.overlay.call("add_child", [holder]);
  __vuiOverlayOn();

  let closed = { done: false };
  let close = () => {
    if (closed.done) {
      return;
    }
    closed.done = true;
    VUI.fade(holder, 0.0, 150);
    GTimer.after(170, () => {
      holder.queueFree();
    });
    __vuiOverlayOff();
  };

  holder.call("add_child", [__vuiScrim(() => {
    if (o.dismissible != false) {
      close();
    }
  })]);

  let children = [];
  // The grab handle.
  let handleBar = GD.create("Panel");
  __vuiMinSize(handleBar, 88.0, 8.0);
  handleBar.set("theme_override_styles/panel", VUI.styleBox({ bg: t.outline, radius: t.radiusFull }));
  children.push(VUI.center({ child: handleBar }));
  if (o.title != null) {
    children.push(VUI.title(o.title));
  }
  if (o.children != null) {
    for (let i = 0; i < o.children.length; i++) {
      children.push(o.children[i]);
    }
  }

  let card = VUI.panel({
    bg: t.surface,
    radius: 0,
    pad: 32,
    gap: 20,
    children: children,
  });
  // Pin to the bottom edge, full width, rounded top corners.
  card.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: t.surface, radiusTL: t.radiusL, radiusTR: t.radiusL, radius: 0, pad: 32, shadow: 20 })
  );
  card.set("anchor_left", GFloat(0.0));
  card.set("anchor_right", GFloat(1.0));
  card.set("anchor_top", GFloat(1.0));
  card.set("anchor_bottom", GFloat(1.0));
  card.set("grow_vertical", GInt(0)); // GROW_DIRECTION_BEGIN — grow upward
  holder.call("add_child", [card]);

  holder.set("modulate", new Color(1.0, 1.0, 1.0, 0.0));
  VUI.fade(holder, 1.0, 150);

  return { node: holder, close: close };
};

// A toast / snackbar: (msg, { kind: 'info'|'success'|'warning'|'danger',
// ms }). Auto-dismisses; a new toast replaces the previous one.
VUI.toast = (msg, o) => {
  o = o ?? {};
  let t = VUI.theme();
  if (__vuiApp.toast != null) {
    __vuiApp.toast.queueFree();
    __vuiApp.toast = null;
  }
  let accent = t.info;
  let glyph = "ℹ";
  if (o.kind == "success") {
    accent = t.success;
    glyph = "✓";
  } else if (o.kind == "warning") {
    accent = t.warning;
    glyph = "!";
  } else if (o.kind == "danger") {
    accent = t.danger;
    glyph = "✕";
  }
  let p = GD.create("PanelContainer");
  p.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: t.surface3, radius: t.radiusM, padX: 30, padY: 20, border: 1, borderColor: accent, shadow: 12 })
  );
  let rowBox = GD.create("HBoxContainer");
  rowBox.set("theme_override_constants/separation", GInt(16));
  rowBox.call("add_child", [VUI.icon(glyph, { size: t.fontM, color: accent })]);
  rowBox.call("add_child", [VUI.text("" + msg, { size: t.fontXS })]);
  p.call("add_child", [rowBox]);

  // Bottom-center strip, above the nav bar.
  p.set("anchor_left", GFloat(0.0));
  p.set("anchor_right", GFloat(1.0));
  p.set("anchor_top", GFloat(1.0));
  p.set("anchor_bottom", GFloat(1.0));
  p.set("offset_left", GFloat(48.0));
  p.set("offset_right", GFloat(-48.0));
  p.set("offset_top", GFloat(-t.navHeight - 128.0));
  p.set("offset_bottom", GFloat(-t.navHeight - 28.0));
  p.set("grow_vertical", GInt(0)); // GROW_DIRECTION_BEGIN — taller toasts grow up
  p.set("mouse_filter", GInt(2));
  __vuiApp.overlay.call("add_child", [p]);
  __vuiApp.toast = p;

  p.set("modulate", new Color(1.0, 1.0, 1.0, 0.0));
  VUI.fade(p, 1.0, 160);
  GTimer.after(__vuiNum(o.ms, 2200), () => {
    // Only dismiss if this toast is still the live one.
    if (__vuiApp.toast != null) {
      if (__vuiApp.toast.id == p.id) {
        VUI.fade(p, 0.0, 200);
        GTimer.after(220, () => {
          p.queueFree();
        });
        __vuiApp.toast = null;
      }
    }
  });
  return p;
};
