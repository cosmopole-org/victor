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
//   let app  = VUI.app({ responsive: true });
//   let page = VUI.column({
//     gap: 16, pad: 20,
//     children: [
//       VUI.heading("Hello"),
//       VUI.button("Tap me", { onTap: () => VUI.toast("hi!") }),
//     ],
//   });
//   app.push(page);
//
// ## The design system
//
// VUI follows Material Design 3 (the Flutter widget design language):
//
//   * COLOR — a full M3 scheme: primary/secondary/tertiary (+ their
//     containers and on- roles), error, five surface-container steps,
//     outline/outlineVariant, inverse roles and a scrim. Legacy token names
//     (bg, surface2, text, textDim, danger, …) remain as aliases so existing
//     guests keep working.
//   * TYPE — a dp-true scale (display 36 / headline 28 / title 22/16 /
//     body 16/14 / label 12) rendered with a real app font when one is
//     installed (VUI.installFonts / the `fonts` app option): body + medium +
//     bold weights with an emoji fallback, Flutter-style.
//   * SHAPE — radius steps 8/12/16/28/full; buttons are stadium-shaped, cards
//     round 16, dialogs 28, sheets round the top 28.
//   * ELEVATION — five shadow levels (VUI.styleBox `shadow: 1..5`).
//   * TOUCH — every control meets a 48dp minimum target.
//
// ## Responsive, mobile-first layout
//
// `VUI.app({ responsive: true })` sizes the UI in device-independent pixels:
// the window content-scale factor is derived from the real screen scale
// (devicePixelRatio on web, DPI/160 on Android), so `16` means 16dp on every
// device — exactly Flutter's logical-pixel model. `VUI.metrics()` reports the
// live logical viewport + Material breakpoints (compact < 600dp ≤ medium <
// 840dp ≤ expanded), and `VUI.onResize(cb)` fires on every window resize.
// The legacy fixed-design mode (`design: [w, h]`) still works for guests
// that want a scaled canvas instead.
//
// ## The pieces
//
//   theme      — themeDark / themeLight / use / theme (M3 design tokens)
//   fonts      — installFonts (body/emoji TTFs → app-wide Theme font)
//   root       — app (CanvasLayer + full-rect page + overlay, responsive dp
//                mode or fixed-design content-scale mode)
//   layout     — column, row, grid, scroll, margin, center, panel, spacer,
//                divider, expand
//   content    — text, heading, title, caption, icon, badge, chip, avatar,
//                card, stat, listTile
//   controls   — button, iconButton, fab, field, toggle, checkbox, slider,
//                progress, dropdown, textarea
//   structure  — appBar, tabs, bottomNav, dialog, sheet, toast, window
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
// size, toast/dialog bookkeeping, open-overlay count).
var __vuiApp = {
  layer: null,
  root: null,
  overlay: null,
  w: 412.0,
  h: 915.0,
  toast: null,
  overlays: 0,
};

// Live viewport metrics (kept fresh by the app root's resize hook).
var __vuiViewport = { w: 412.0, h: 915.0, scale: 1.0, cbs: [] };

// Installed app fonts: FontFile/FontVariation handles (null until
// VUI.installFonts runs; widgets fall back to the engine default font).
var __vuiFonts = { regular: null, medium: null, bold: null, emoji: null };

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

// Read a numeric option with a default. The VM has ONE representation for
// 0 / null / an absent member (see the conventions note), so an absent option
// and an explicit 0 are indistinguishable: both take the default. Pass -1 (or
// any negative) where an explicit zero is meant — sinks clamp negatives to 0.
function __vuiNum(v, d) {
  if (v == null) {
    return d;
  }
  if (__isType(v, "num")) {
    return v;
  }
  return d;
}

// Clamp a spacing/size value: negatives are the explicit-zero sentinel.
function __vuiPx(v) {
  if (v < 0) {
    return 0;
  }
  return v;
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

// Blend a Material state layer onto a base color: hover ≈ 8%, pressed ≈ 12%
// of the layer color composited over the base.
function __vuiLayer(base, layer, opacity) {
  return new Color(
    base.r + (layer.r - base.r) * opacity,
    base.g + (layer.g - base.g) * opacity,
    base.b + (layer.b - base.b) * opacity,
    base.a
  );
}

// ---------------------------------------------------------------------------
// theme — Material 3 design tokens
// ---------------------------------------------------------------------------
//
// The token object carries the full M3 color scheme plus shape / type /
// structure metrics, all in dp. Legacy names (bg, surface2/3, text, textDim,
// textFaint, primaryDim, accent, danger) are kept as aliases of the scheme
// roles so pre-M3 guests render correctly without changes.

VUI.themeDark = () => {
  let t = {
    name: "victor-dark",
    dark: true,
    // primary
    primary: new Color(0.651, 0.784, 1.0, 1.0), // #A6C8FF
    onPrimary: new Color(0.043, 0.188, 0.373, 1.0), // #0B305F
    primaryContainer: new Color(0.153, 0.278, 0.467, 1.0), // #274777
    onPrimaryContainer: new Color(0.839, 0.89, 1.0, 1.0), // #D6E3FF
    // secondary
    secondary: new Color(0.745, 0.776, 0.863, 1.0), // #BEC6DC
    onSecondary: new Color(0.157, 0.188, 0.247, 1.0), // #28303F
    secondaryContainer: new Color(0.243, 0.278, 0.349, 1.0), // #3E4759
    onSecondaryContainer: new Color(0.855, 0.886, 0.976, 1.0), // #DAE2F9
    // tertiary (teal)
    tertiary: new Color(0.525, 0.824, 0.804, 1.0),
    onTertiary: new Color(0.0, 0.216, 0.2, 1.0),
    tertiaryContainer: new Color(0.122, 0.306, 0.294, 1.0),
    onTertiaryContainer: new Color(0.635, 0.949, 0.925, 1.0),
    // error
    error: new Color(1.0, 0.706, 0.671, 1.0), // #FFB4AB
    onError: new Color(0.412, 0.0, 0.02, 1.0), // #690005
    errorContainer: new Color(0.576, 0.0, 0.039, 1.0), // #93000A
    onErrorContainer: new Color(1.0, 0.855, 0.839, 1.0), // #FFDAD6
    // surfaces
    surface: new Color(0.063, 0.078, 0.094, 1.0), // #101418
    surfaceBright: new Color(0.212, 0.227, 0.243, 1.0),
    surfaceContainerLowest: new Color(0.043, 0.059, 0.071, 1.0),
    surfaceContainerLow: new Color(0.094, 0.11, 0.125, 1.0), // #181C20
    surfaceContainer: new Color(0.11, 0.125, 0.141, 1.0), // #1C2024
    surfaceContainerHigh: new Color(0.149, 0.165, 0.18, 1.0), // #262A2E
    surfaceContainerHighest: new Color(0.192, 0.208, 0.224, 1.0), // #313539
    onSurface: new Color(0.882, 0.886, 0.91, 1.0), // #E1E2E8
    onSurfaceVariant: new Color(0.765, 0.776, 0.812, 1.0), // #C3C6CF
    outline: new Color(0.553, 0.569, 0.6, 1.0), // #8D9199
    outlineVariant: new Color(0.263, 0.278, 0.306, 1.0), // #43474E
    inverseSurface: new Color(0.882, 0.886, 0.91, 1.0),
    inverseOnSurface: new Color(0.18, 0.192, 0.208, 1.0),
    inversePrimary: new Color(0.251, 0.373, 0.565, 1.0),
    scrim: new Color(0.0, 0.0, 0.0, 0.45),
    // extended status roles
    success: new Color(0.42, 0.85, 0.56, 1.0),
    warning: new Color(1.0, 0.72, 0.35, 1.0),
    info: new Color(0.49, 0.75, 1.0, 1.0),
    // shape
    radiusXS: 4,
    radiusS: 8,
    radiusM: 12,
    radiusL: 16,
    radiusXL: 28,
    radiusFull: 999,
    space: 4.0,
    // type scale (dp)
    fontXS: 12,
    fontS: 14,
    fontM: 16,
    fontL: 22,
    fontXL: 28,
    fontXXL: 36,
    // structure (dp)
    barHeight: 64.0,
    navHeight: 80.0,
    controlHeight: 48.0,
    fieldHeight: 56.0,
    minTouch: 48.0,
  };
  return __vuiThemeAliases(t);
};

VUI.themeLight = () => {
  let t = VUI.themeDark();
  t.name = "victor-light";
  t.dark = false;
  t.primary = new Color(0.251, 0.373, 0.565, 1.0); // #405F90
  t.onPrimary = new Color(1.0, 1.0, 1.0, 1.0);
  t.primaryContainer = new Color(0.839, 0.89, 1.0, 1.0); // #D6E3FF
  t.onPrimaryContainer = new Color(0.0, 0.106, 0.243, 1.0);
  t.secondary = new Color(0.337, 0.369, 0.443, 1.0);
  t.onSecondary = new Color(1.0, 1.0, 1.0, 1.0);
  t.secondaryContainer = new Color(0.855, 0.886, 0.976, 1.0);
  t.onSecondaryContainer = new Color(0.075, 0.11, 0.169, 1.0);
  t.tertiary = new Color(0.161, 0.42, 0.408, 1.0);
  t.onTertiary = new Color(1.0, 1.0, 1.0, 1.0);
  t.tertiaryContainer = new Color(0.733, 0.925, 0.906, 1.0);
  t.onTertiaryContainer = new Color(0.0, 0.125, 0.114, 1.0);
  t.error = new Color(0.729, 0.102, 0.102, 1.0); // #BA1A1A
  t.onError = new Color(1.0, 1.0, 1.0, 1.0);
  t.errorContainer = new Color(1.0, 0.855, 0.839, 1.0);
  t.onErrorContainer = new Color(0.255, 0.0, 0.008, 1.0);
  t.surface = new Color(0.976, 0.976, 1.0, 1.0); // #F9F9FF
  t.surfaceBright = new Color(0.976, 0.976, 1.0, 1.0);
  t.surfaceContainerLowest = new Color(1.0, 1.0, 1.0, 1.0);
  t.surfaceContainerLow = new Color(0.953, 0.953, 0.98, 1.0);
  t.surfaceContainer = new Color(0.929, 0.929, 0.957, 1.0);
  t.surfaceContainerHigh = new Color(0.906, 0.91, 0.933, 1.0);
  t.surfaceContainerHighest = new Color(0.882, 0.886, 0.91, 1.0);
  t.onSurface = new Color(0.098, 0.11, 0.125, 1.0); // #191C20
  t.onSurfaceVariant = new Color(0.263, 0.278, 0.306, 1.0);
  t.outline = new Color(0.451, 0.467, 0.498, 1.0);
  t.outlineVariant = new Color(0.765, 0.776, 0.812, 1.0);
  t.inverseSurface = new Color(0.18, 0.192, 0.208, 1.0);
  t.inverseOnSurface = new Color(0.941, 0.941, 0.969, 1.0);
  t.inversePrimary = new Color(0.651, 0.784, 1.0, 1.0);
  t.scrim = new Color(0.0, 0.0, 0.0, 0.4);
  t.success = new Color(0.11, 0.53, 0.25, 1.0);
  t.warning = new Color(0.62, 0.42, 0.0, 1.0);
  t.info = new Color(0.13, 0.42, 0.75, 1.0);
  return __vuiThemeAliases(t);
};

// Refresh the legacy alias tokens from the scheme roles. Call after mutating
// scheme roles in place (a re-skin) so pre-M3 guests keep matching colors.
function __vuiThemeAliases(t) {
  t.bg = t.surface;
  t.surface2 = t.surfaceContainerHigh;
  t.surface3 = t.surfaceContainerHighest;
  t.text = t.onSurface;
  t.textDim = t.onSurfaceVariant;
  t.textFaint = t.outline;
  t.primaryDim = t.primary.withAlpha(0.14);
  t.accent = t.tertiary;
  t.danger = t.error;
  return t;
}
VUI.themeAliases = (t) => {
  return __vuiThemeAliases(t);
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
// fonts — a real app typeface (Flutter-style), loaded at runtime
// ---------------------------------------------------------------------------
//
// VUI.installFonts({ body: "res://…/Roboto.ttf", emoji: "res://…/Emoji.ttf" })
// loads raw TTF/OTF files over the bridge (no import pipeline needed — they
// only have to be present in the pack), builds regular / medium / bold
// variations (real weight axes when the font is variable, synthetic emphasis
// otherwise), chains the emoji font as a fallback so emoji glyphs render
// everywhere, and installs the result as the app-wide Theme default font.
// Idempotent; safe to call before VUI.app.

// The OpenType `wght` axis tag: ('w'<<24)|('g'<<16)|('h'<<8)|('t').
var __VUI_WGHT_TAG = 2003265652;

function __vuiFontVariation(base, weight, embolden) {
  let v = GD.create("FontVariation");
  v.set("base_font", base);
  let axes = new GDict();
  axes.put(GInt(__VUI_WGHT_TAG), GInt(weight));
  v.set("variation_opentype", axes);
  if (embolden > 0.0) {
    // A touch of synthetic emphasis so static (non-variable) fonts still get
    // a visible weight step.
    v.set("variation_embolden", GFloat(embolden));
  }
  return v;
}

VUI.installFonts = (o) => {
  o = o ?? {};
  if (__vuiFonts.regular != null) {
    return __vuiFonts;
  }
  if (o.body == null) {
    return __vuiFonts;
  }
  let body = GD.create("FontFile");
  let err = body.call("load_dynamic_font", [o.body]);
  if (GD.isError(err)) {
    return __vuiFonts;
  }
  body.set("antialiasing", GInt(1)); // grayscale AA
  body.set("hinting", GInt(1)); // light hinting
  body.set("subpixel_positioning", GInt(1));
  if (o.emoji != null) {
    let emoji = GD.create("FontFile");
    let eerr = emoji.call("load_dynamic_font", [o.emoji]);
    if (!GD.isError(eerr)) {
      __vuiFonts.emoji = emoji;
      body.set("fallbacks", [emoji]);
    }
  }
  __vuiFonts.regular = body;
  __vuiFonts.medium = __vuiFontVariation(body, 500, 0.0);
  __vuiFonts.bold = __vuiFontVariation(body, 700, 0.12);

  // App-wide install: the root window Theme's default font.
  let th = GD.create("Theme");
  th.set("default_font", body);
  th.set("default_font_size", GInt(VUI.theme().fontM));
  let win = GD.tree().call("get_root");
  if (win != null && !GD.isError(win)) {
    win.set("theme", th);
  }
  return __vuiFonts;
};

// The installed fonts (regular/medium/bold/emoji — entries are null until
// VUI.installFonts has run).
VUI.fonts = () => {
  return __vuiFonts;
};

// Apply a font weight to a themed Control ("medium" | "bold"); no-op when no
// app font is installed or the weight is absent.
function __vuiFontFor(weight) {
  if (weight == "bold") {
    return __vuiFonts.bold;
  }
  if (weight == "medium") {
    return __vuiFonts.medium;
  }
  return null;
}

function __vuiApplyWeight(n, weight) {
  // Weight variant when asked; otherwise the regular app font. Applying the
  // font explicitly on every text node (rather than relying on the root
  // Theme) keeps the typeface + emoji fallback intact on every platform.
  let f = __vuiFontFor(weight);
  if (f == null) {
    f = __vuiFonts.regular;
  }
  if (f != null) {
    n.set("theme_override_fonts/font", f);
  }
}

// ---------------------------------------------------------------------------
// style plumbing
// ---------------------------------------------------------------------------

// Material elevation → StyleBoxFlat shadow parameters (size, alpha, y-offset).
function __vuiElevation(level) {
  if (level <= 0) {
    return { size: 0, alpha: 0.0, y: 0.0 };
  }
  if (level == 1) {
    return { size: 6, alpha: 0.2, y: 2.0 };
  }
  if (level == 2) {
    return { size: 10, alpha: 0.22, y: 3.0 };
  }
  if (level == 3) {
    return { size: 14, alpha: 0.24, y: 4.0 };
  }
  if (level == 4) {
    return { size: 18, alpha: 0.26, y: 6.0 };
  }
  return { size: 24, alpha: 0.3, y: 8.0 };
}

// A StyleBoxFlat from options: { bg, radius, radiusTL/TR/BL/BR, border,
// borderColor, borderB (bottom-only width), pad, padX, padY, padL/T/R/B,
// shadow (elevation level 1..5 — or raw px when > 5), shadowColor, shadowY }.
VUI.styleBox = (o) => {
  o = o ?? {};
  let sb = GD.create("StyleBoxFlat");
  if (o.bg != null) {
    sb.set("bg_color", o.bg);
  } else {
    sb.set("bg_color", new Color(0.0, 0.0, 0.0, 0.0));
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
  }
  let bb = __vuiNum(o.borderB, 0);
  if (bb > 0) {
    sb.set("border_width_bottom", GInt(bb));
  }
  if ((bw > 0 || bb > 0) && o.borderColor != null) {
    sb.set("border_color", o.borderColor);
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
    let e = __vuiElevation(sh);
    if (sh > 5) {
      // Raw pixel size for callers predating elevation levels.
      e = { size: sh, alpha: 0.26, y: sh * 0.4 };
    }
    sb.set("shadow_size", GInt(e.size));
    sb.set("shadow_color", o.shadowColor ?? new Color(0.0, 0.0, 0.0, e.alpha));
    sb.set("shadow_offset", new Vector2(0.0, __vuiNum(o.shadowY, e.y)));
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
  tw.call("set_trans", [GInt(3)]); // Tween.TRANS_QUART — snappy
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
//   responsive: true — dp mode (the default when no design size is given):
//             the content scale factor tracks the device pixel ratio, so all
//             kit dimensions are device-independent pixels and the layout
//             REFLOWS on resize instead of scaling. Flutter's logical pixels.
//   design:   [w, h] — legacy fixed-design mode: the window content-scales so
//             coordinates in this space fit any screen.
//   portrait: true — lock the screen to portrait: on handheld devices via
//             DisplayServer.screen_set_orientation, on desktop by sizing the
//             window itself to a portrait shape.
//   bg:       page background color (theme bg when omitted; pass false to
//             leave the world visible behind the UI).
//   fonts:    { body, emoji } — TTF paths handed to VUI.installFonts.
//
// Returns the app handle: { layer, root, overlay, w, h, push(widget) }.

// Compute the device scale factor (dp mode): the display server's screen
// scale (devicePixelRatio on web) with a DPI/160 fallback for platforms that
// report scale 1 with a real DPI (Android), clamped to [1, 4].
function __vuiDeviceScale() {
  let ds = GD.displayServer();
  let s = ds.call("screen_get_scale", []);
  let scale = 1.0;
  if (!GD.isError(s) && __isType(s, "num") && s > 0.0) {
    scale = s;
  }
  if (scale <= 1.01) {
    let dpi = ds.call("screen_get_dpi", []);
    if (!GD.isError(dpi) && __isType(dpi, "num") && dpi >= 180) {
      scale = dpi / 160.0;
    }
  }
  if (scale < 1.0) {
    scale = 1.0;
  }
  if (scale > 4.0) {
    scale = 4.0;
  }
  return scale;
}

function __vuiRefreshMetrics(win) {
  let sz = win.get("size");
  if (sz == null || GD.isError(sz)) {
    return;
  }
  let sc = __vuiViewport.scale;
  __vuiViewport.w = sz.x / sc;
  __vuiViewport.h = sz.y / sc;
  __vuiApp.w = __vuiViewport.w;
  __vuiApp.h = __vuiViewport.h;
}

// The live logical viewport: { w, h, scale, compact, medium, expanded,
// portrait } — Material window size classes on the logical width.
VUI.metrics = () => {
  let w = __vuiViewport.w;
  let h = __vuiViewport.h;
  return {
    w: w,
    h: h,
    scale: __vuiViewport.scale,
    compact: w < 600.0,
    medium: w >= 600.0 && w < 840.0,
    expanded: w >= 840.0,
    portrait: h >= w,
  };
};

// Subscribe to viewport changes; returns an unsubscribe closure.
VUI.onResize = (cb) => {
  __vuiViewport.cbs.push(cb);
  return () => {
    let out = [];
    for (let i = 0; i < __vuiViewport.cbs.length; i++) {
      if (__vuiViewport.cbs[i] != cb) {
        out.push(__vuiViewport.cbs[i]);
      }
    }
    __vuiViewport.cbs = out;
  };
};

function __vuiFireResize() {
  for (let i = 0; i < __vuiViewport.cbs.length; i++) {
    __vuiViewport.cbs[i](VUI.metrics());
  }
}

VUI.app = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  if (o.fonts != null) {
    VUI.installFonts(o.fonts);
  }

  let win = GD.tree().call("get_root");
  let responsive = o.responsive == true || o.design == null;

  if (responsive) {
    // dp mode: scale factor = device pixel ratio; layout reflows on resize.
    let scale = __vuiDeviceScale();
    __vuiViewport.scale = scale;
    if (win != null && !GD.isError(win)) {
      win.set("content_scale_size", new Vector2i(0, 0));
      win.set("content_scale_mode", GD.constant("Window.CONTENT_SCALE_MODE_CANVAS_ITEMS"));
      win.set("content_scale_aspect", GD.constant("Window.CONTENT_SCALE_ASPECT_EXPAND"));
      win.set("content_scale_factor", GFloat(scale));
      __vuiRefreshMetrics(win);
      win.connect("size_changed", (a) => {
        __vuiRefreshMetrics(win);
        __vuiFireResize();
      });
    }
  } else {
    let dw = o.design[0];
    let dh = o.design[1];
    __vuiApp.w = dw;
    __vuiApp.h = dh;
    __vuiViewport.w = dw;
    __vuiViewport.h = dh;
    if (win != null && !GD.isError(win)) {
      win.set("content_scale_size", new Vector2i(dw, dh));
      win.set("content_scale_mode", GD.constant("Window.CONTENT_SCALE_MODE_CANVAS_ITEMS"));
      win.set("content_scale_aspect", GD.constant("Window.CONTENT_SCALE_ASPECT_EXPAND"));
    }
  }

  if (o.portrait == true) {
    let os = GD.os();
    let mobile = os.call("has_feature", ["mobile"]);
    if (mobile == true) {
      GD.displayServer().call("screen_set_orientation", [
        GD.constant("DisplayServer.SCREEN_PORTRAIT"),
      ]);
    } else if (o.design != null) {
      // Desktop preview: make the window itself portrait at the design size.
      GD.displayServer().call("window_set_size", [new Vector2i(o.design[0], o.design[1])]);
    }
  }

  let layer = GD.create("CanvasLayer");
  GD.mount(layer);

  // The page root: a full-rect Control carrying the background. PASS-through
  // for input: sandboxed game VMs render on layers below the app shell, and
  // taps that hit no actual widget must reach them — every interactive VUI
  // control STOPs for itself.
  let root = GD.create("Control");
  root.set("name", "VuiRoot");
  root.set("mouse_filter", GInt(2)); // MOUSE_FILTER_IGNORE
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
    w: __vuiApp.w,
    h: __vuiApp.h,
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
  let p = __vuiPx(__vuiNum(pad, 0));
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
  box.set("theme_override_constants/separation", GInt(__vuiPx(__vuiNum(o.gap, 12))));
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
  box.set("theme_override_constants/separation", GInt(__vuiPx(__vuiNum(o.gap, 12))));
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
  let gap = __vuiPx(__vuiNum(o.gap, 12));
  g.set("theme_override_constants/h_separation", GInt(gap));
  g.set("theme_override_constants/v_separation", GInt(gap));
  __vuiAddAll(g, o.children);
  return g;
};

// Style a ScrollContainer's bars as thin, subtle Material scrollbars.
VUI.scrollbarStyle = (sc) => {
  let t = VUI.theme();
  let names = ["get_h_scroll_bar", "get_v_scroll_bar"];
  for (let i = 0; i < names.length; i++) {
    let bar = sc.call(names[i]);
    if (bar == null || GD.isError(bar)) {
      continue;
    }
    bar.set("custom_minimum_size", new Vector2(4.0, 4.0));
    bar.set("theme_override_styles/scroll", VUI.styleBox({ bg: t.onSurface.withAlpha(0.06), radius: t.radiusFull }));
    bar.set("theme_override_styles/grabber", VUI.styleBox({ bg: t.outline.withAlpha(0.55), radius: t.radiusFull }));
    bar.set("theme_override_styles/grabber_highlight", VUI.styleBox({ bg: t.outline, radius: t.radiusFull }));
    bar.set("theme_override_styles/grabber_pressed", VUI.styleBox({ bg: t.primary, radius: t.radiusFull }));
  }
};

// Scrollable area: { child, horizontal }. The child expands to the scroll
// width so columns lay out naturally.
VUI.scroll = (o) => {
  o = o ?? {};
  let sc = GD.create("ScrollContainer");
  __vuiExpandH(sc);
  __vuiExpandV(sc);
  sc.set("horizontal_scroll_mode", GInt(o.horizontal == true ? 1 : 0));
  VUI.scrollbarStyle(sc);
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
// gap, children, child, shadow }.
VUI.panel = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let p = GD.create("PanelContainer");
  p.set(
    "theme_override_styles/panel",
    VUI.styleBox({
      bg: o.bg ?? t.surfaceContainerLow,
      radius: __vuiNum(o.radius, t.radiusL),
      border: __vuiNum(o.border, 0),
      borderColor: o.borderColor,
      pad: __vuiNum(o.pad, 16),
      shadow: __vuiNum(o.shadow, 0),
    })
  );
  if (o.child != null) {
    p.call("add_child", [__vuiNode(o.child)]);
  } else if (o.children != null) {
    let col = GD.create("VBoxContainer");
    col.set("theme_override_constants/separation", GInt(__vuiPx(__vuiNum(o.gap, 12))));
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
  d.set("theme_override_styles/panel", VUI.styleBox({ bg: t.outlineVariant, radius: 1 }));
  if (o.vertical == true) {
    __vuiMinSize(d, 1.0, 8.0);
    __vuiExpandV(d);
  } else {
    __vuiMinSize(d, 8.0, 1.0);
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

// A text label: (str, { size, color, dim, faint, weight: 'medium'|'bold',
// align: 'left|center|right', wrap, expand }).
VUI.text = (str, o) => {
  o = o ?? {};
  let t = VUI.theme();
  let l = GD.create("Label");
  l.set("text", "" + str);
  l.set("theme_override_font_sizes/font_size", GInt(__vuiNum(o.size, t.fontM)));
  let color = o.color;
  if (color == null) {
    color = t.onSurface;
    if (o.dim == true) {
      color = t.onSurfaceVariant;
    }
    if (o.faint == true) {
      color = t.outline;
    }
  }
  l.set("theme_override_colors/font_color", color);
  __vuiApplyWeight(l, o.weight);
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

// Headline (28dp, medium weight).
VUI.heading = (str, o) => {
  o = o ?? {};
  let t = VUI.theme();
  o.size = __vuiNum(o.size, t.fontXL);
  o.weight = o.weight ?? "medium";
  return VUI.text(str, o);
};

// Title (22dp, medium weight).
VUI.title = (str, o) => {
  o = o ?? {};
  let t = VUI.theme();
  o.size = __vuiNum(o.size, t.fontL);
  o.weight = o.weight ?? "medium";
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
    VUI.styleBox({ bg: o.color ?? t.primary, radius: t.radiusFull, padX: 10, padY: 2 })
  );
  p.call("add_child", [
    VUI.text(str, { size: 11, color: o.textColor ?? t.onPrimary, weight: "medium" }),
  ]);
  return p;
};

// A selectable Material chip: (str, { selected, glyph, onTap }). Returns a
// handle { node, setSelected(b), isSelected() }.
VUI.chip = (str, o) => {
  o = o ?? {};
  let t = VUI.theme();
  let st = { on: o.selected == true };
  let b = GD.create("Button");
  let label = "" + str;
  if (o.glyph != null) {
    label = o.glyph + " " + label;
  }
  b.set("text", label);
  b.set("theme_override_font_sizes/font_size", GInt(t.fontS));
  __vuiApplyWeight(b, "medium");
  b.set("focus_mode", GInt(0));
  __vuiMinSize(b, 0.0, 32.0);

  let offSb = VUI.styleBox({
    radius: t.radiusS, padX: 16, padY: 6,
    border: 1, borderColor: t.outline,
  });
  let offHover = VUI.styleBox({
    bg: __vuiLayer(t.surface, t.onSurfaceVariant, 0.08),
    radius: t.radiusS, padX: 16, padY: 6,
    border: 1, borderColor: t.outline,
  });
  let onSb = VUI.styleBox({ bg: t.secondaryContainer, radius: t.radiusS, padX: 16, padY: 6 });
  let onHover = VUI.styleBox({
    bg: __vuiLayer(t.secondaryContainer, t.onSecondaryContainer, 0.08),
    radius: t.radiusS, padX: 16, padY: 6,
  });
  let apply = () => {
    b.set("theme_override_styles/normal", st.on ? onSb : offSb);
    b.set("theme_override_styles/hover", st.on ? onHover : offHover);
    b.set("theme_override_styles/pressed", st.on ? onHover : offHover);
    b.set("theme_override_colors/font_color", st.on ? t.onSecondaryContainer : t.onSurfaceVariant);
    b.set("theme_override_colors/font_hover_color", st.on ? t.onSecondaryContainer : t.onSurface);
    b.set("theme_override_colors/font_pressed_color", st.on ? t.onSecondaryContainer : t.onSurface);
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
  let d = __vuiNum(o.size, 40.0);
  let p = GD.create("PanelContainer");
  __vuiMinSize(p, d, d);
  p.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: o.color ?? t.primaryContainer, radius: t.radiusFull })
  );
  let l = VUI.text(initials, {
    size: d * 0.4,
    color: o.textColor ?? t.onPrimaryContainer,
    align: "center",
    weight: "medium",
  });
  l.set("vertical_alignment", GInt(1)); // centered
  p.call("add_child", [l]);
  return p;
};

// An elevated content card (Material Card): { children, child, gap, pad,
// accent, variant: 'elevated'|'filled'|'outlined' }.
VUI.card = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let variant = o.variant ?? "elevated";
  if (variant == "filled") {
    o.bg = o.bg ?? t.surfaceContainerHighest;
    o.shadow = __vuiNum(o.shadow, 0);
  } else if (variant == "outlined") {
    o.bg = o.bg ?? t.surface;
    o.border = __vuiNum(o.border, 1);
    o.borderColor = o.borderColor ?? t.outlineVariant;
    o.shadow = __vuiNum(o.shadow, 0);
  } else {
    o.bg = o.bg ?? t.surfaceContainerLow;
    o.shadow = __vuiNum(o.shadow, 1);
  }
  o.radius = __vuiNum(o.radius, t.radiusM);
  o.pad = __vuiNum(o.pad, 16);
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
  let valueLabel = VUI.text("" + (o.value ?? ""), { size: 24, color: t.onSurface, weight: "medium" });
  let children = [];
  if (o.glyph != null) {
    children.push(
      VUI.row({
        gap: 8,
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
    bg: t.surfaceContainerLow,
    radius: t.radiusM,
    pad: 16,
    gap: 4,
    shadow: 1,
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

// A tappable Material list tile: { leading (glyph), leadingColor, title,
// subtitle, trailing (string or widget), onTap }.
VUI.listTile = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let b = GD.create("Button");
  b.set("focus_mode", GInt(0));
  let normal = VUI.styleBox({ bg: t.surfaceContainerLow, radius: t.radiusM });
  let hover = VUI.styleBox({ bg: __vuiLayer(t.surfaceContainerLow, t.onSurface, 0.08), radius: t.radiusM });
  let pressed = VUI.styleBox({ bg: __vuiLayer(t.surfaceContainerLow, t.onSurface, 0.12), radius: t.radiusM });
  b.set("theme_override_styles/normal", normal);
  b.set("theme_override_styles/hover", hover);
  b.set("theme_override_styles/pressed", pressed);
  __vuiMinSize(b, 0.0, o.subtitle != null ? 72.0 : 56.0);
  __vuiExpandH(b);

  let content = GD.create("MarginContainer");
  __vuiFullRect(content);
  content.set("theme_override_constants/margin_left", GInt(16));
  content.set("theme_override_constants/margin_right", GInt(16));
  content.set("theme_override_constants/margin_top", GInt(8));
  content.set("theme_override_constants/margin_bottom", GInt(8));
  content.set("mouse_filter", GInt(2)); // let the button take the clicks

  let items = [];
  if (o.leading != null) {
    let iconWrap = GD.create("PanelContainer");
    __vuiMinSize(iconWrap, 40.0, 40.0);
    iconWrap.set(
      "theme_override_styles/panel",
      VUI.styleBox({ bg: t.surfaceContainerHigh, radius: t.radiusFull })
    );
    let ic = VUI.icon(o.leading, { size: t.fontM, color: o.leadingColor ?? t.primary });
    ic.set("vertical_alignment", GInt(1));
    iconWrap.call("add_child", [ic]);
    let iconCenter = GD.create("CenterContainer");
    iconCenter.set("mouse_filter", GInt(2));
    iconCenter.call("add_child", [iconWrap]);
    items.push(iconCenter);
  }
  let mid = [];
  mid.push(VUI.text(o.title ?? "", { size: t.fontM }));
  if (o.subtitle != null) {
    mid.push(VUI.text(o.subtitle, { size: t.fontS, dim: true }));
  }
  let midCol = VUI.column({ gap: 2, children: mid });
  __vuiExpandH(midCol);
  let midCenter = GD.create("VBoxContainer");
  midCenter.set("alignment", GInt(1));
  midCenter.set("mouse_filter", GInt(2));
  midCenter.call("add_child", [__vuiNode(midCol)]);
  __vuiExpandH(midCenter);
  items.push(midCenter);
  if (o.trailing != null) {
    if (__isType(o.trailing, "String")) {
      let tr = VUI.text(o.trailing, { size: t.fontXS, faint: true });
      tr.set("vertical_alignment", GInt(1));
      items.push(tr);
    } else {
      items.push(__vuiNode(o.trailing));
    }
  }
  let rowBox = GD.create("HBoxContainer");
  rowBox.set("theme_override_constants/separation", GInt(16));
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

// Style an existing Godot Button as one of the Material button kinds. Shared
// by VUI.button and the VReact <button> driver so both render identically.
// (b, kind: 'filled'|'tonal'|'elevated'|'outline'|'ghost'|'text'|'danger',
//  { radius, padX })
VUI.buttonStyle = (b, kind, o) => {
  o = o ?? {};
  let t = VUI.theme();
  if (kind == null) {
    kind = "filled";
  }
  // Stadium shape (Material 3 buttons are fully rounded).
  let radius = __vuiNum(o.radius, t.radiusFull);
  let padX = __vuiNum(o.padX, 24);
  let disabledSb = VUI.styleBox({
    bg: t.onSurface.withAlpha(0.12), radius: radius, padX: padX,
  });
  let setColors = (color) => {
    b.set("theme_override_colors/font_color", color);
    b.set("theme_override_colors/font_hover_color", color);
    b.set("theme_override_colors/font_pressed_color", color);
    b.set("theme_override_colors/font_hover_pressed_color", color);
    b.set("theme_override_colors/font_focus_color", color);
    b.set("theme_override_colors/font_disabled_color", t.onSurface.withAlpha(0.38));
  };
  if (kind == "filled") {
    b.set("theme_override_styles/normal", VUI.styleBox({ bg: t.primary, radius: radius, padX: padX }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: __vuiLayer(t.primary, t.onPrimary, 0.08), radius: radius, padX: padX }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: __vuiLayer(t.primary, t.onPrimary, 0.12), radius: radius, padX: padX }));
    setColors(t.onPrimary);
  } else if (kind == "tonal") {
    b.set("theme_override_styles/normal", VUI.styleBox({ bg: t.secondaryContainer, radius: radius, padX: padX }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: __vuiLayer(t.secondaryContainer, t.onSecondaryContainer, 0.08), radius: radius, padX: padX }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: __vuiLayer(t.secondaryContainer, t.onSecondaryContainer, 0.12), radius: radius, padX: padX }));
    setColors(t.onSecondaryContainer);
  } else if (kind == "elevated") {
    b.set("theme_override_styles/normal", VUI.styleBox({ bg: t.surfaceContainerLow, radius: radius, padX: padX, shadow: 1 }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: __vuiLayer(t.surfaceContainerLow, t.primary, 0.08), radius: radius, padX: padX, shadow: 2 }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: __vuiLayer(t.surfaceContainerLow, t.primary, 0.12), radius: radius, padX: padX, shadow: 1 }));
    setColors(t.primary);
  } else if (kind == "danger") {
    b.set("theme_override_styles/normal", VUI.styleBox({ bg: t.error, radius: radius, padX: padX }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: __vuiLayer(t.error, t.onError, 0.08), radius: radius, padX: padX }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: __vuiLayer(t.error, t.onError, 0.12), radius: radius, padX: padX }));
    setColors(t.onError);
  } else if (kind == "outline" || kind == "outlined") {
    b.set("theme_override_styles/normal", VUI.styleBox({ radius: radius, padX: padX, border: 1, borderColor: t.outline }));
    b.set("theme_override_styles/hover", VUI.styleBox({ radius: radius, padX: padX, border: 1, borderColor: t.outline, bg: t.primary.withAlpha(0.08) }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ radius: radius, padX: padX, border: 1, borderColor: t.primary, bg: t.primary.withAlpha(0.12) }));
    setColors(t.primary);
    disabledSb = VUI.styleBox({ radius: radius, padX: padX, border: 1, borderColor: t.onSurface.withAlpha(0.12) });
  } else {
    // ghost / text button
    b.set("theme_override_styles/normal", VUI.styleBox({ radius: radius, padX: padX }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: t.primary.withAlpha(0.08), radius: radius, padX: padX }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: t.primary.withAlpha(0.12), radius: radius, padX: padX }));
    setColors(t.primary);
    disabledSb = VUI.styleBox({ radius: radius, padX: padX });
  }
  b.set("theme_override_styles/disabled", disabledSb);
  b.set("theme_override_styles/focus", VUI.styleEmpty());
};

// The button. (text, { kind: 'filled'|'tonal'|'elevated'|'outline'|'ghost'|
// 'danger', glyph, onTap, wide, height, fontSize, radius }).
VUI.button = (text, o) => {
  o = o ?? {};
  let t = VUI.theme();
  let h = __vuiNum(o.height, t.controlHeight);
  let b = GD.create("Button");
  let label = "" + text;
  if (o.glyph != null) {
    label = o.glyph + "  " + label;
  }
  b.set("text", label);
  b.set("theme_override_font_sizes/font_size", GInt(__vuiNum(o.fontSize, t.fontS)));
  __vuiApplyWeight(b, "medium");
  b.set("focus_mode", GInt(0));
  __vuiMinSize(b, __vuiNum(o.minWidth, 0.0), h);
  if (o.wide == true) {
    __vuiExpandH(b);
  }
  VUI.buttonStyle(b, o.kind, o);
  if (o.disabled == true) {
    b.set("disabled", true);
  }
  if (o.onTap != null) {
    b.connect("pressed", (a) => {
      o.onTap();
    });
  }
  return b;
};

// A round icon-only button: (glyph, { onTap, size, color, bg, kind }).
VUI.iconButton = (glyph, o) => {
  o = o ?? {};
  let t = VUI.theme();
  let d = __vuiNum(o.size, 48.0);
  let b = GD.create("Button");
  b.set("text", glyph);
  b.set("theme_override_font_sizes/font_size", GInt(d * 0.44));
  b.set("focus_mode", GInt(0));
  __vuiMinSize(b, d, d);
  let kind = o.kind ?? "standard";
  if (kind == "filled") {
    b.set("theme_override_styles/normal", VUI.styleBox({ bg: o.bg ?? t.primary, radius: t.radiusFull }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: __vuiLayer(o.bg ?? t.primary, t.onPrimary, 0.08), radius: t.radiusFull }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: __vuiLayer(o.bg ?? t.primary, t.onPrimary, 0.12), radius: t.radiusFull }));
    b.set("theme_override_colors/font_color", o.color ?? t.onPrimary);
    b.set("theme_override_colors/font_hover_color", o.color ?? t.onPrimary);
    b.set("theme_override_colors/font_pressed_color", o.color ?? t.onPrimary);
  } else if (kind == "tonal") {
    b.set("theme_override_styles/normal", VUI.styleBox({ bg: o.bg ?? t.secondaryContainer, radius: t.radiusFull }));
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: __vuiLayer(o.bg ?? t.secondaryContainer, t.onSecondaryContainer, 0.08), radius: t.radiusFull }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: __vuiLayer(o.bg ?? t.secondaryContainer, t.onSecondaryContainer, 0.12), radius: t.radiusFull }));
    b.set("theme_override_colors/font_color", o.color ?? t.onSecondaryContainer);
    b.set("theme_override_colors/font_hover_color", o.color ?? t.onSecondaryContainer);
    b.set("theme_override_colors/font_pressed_color", o.color ?? t.onSecondaryContainer);
  } else {
    // standard: transparent with a state layer, like Flutter's IconButton.
    if (o.bg != null) {
      b.set("theme_override_styles/normal", VUI.styleBox({ bg: o.bg, radius: t.radiusFull }));
    } else {
      b.set("theme_override_styles/normal", VUI.styleBox({ radius: t.radiusFull }));
    }
    b.set("theme_override_styles/hover", VUI.styleBox({ bg: t.onSurface.withAlpha(0.08), radius: t.radiusFull }));
    b.set("theme_override_styles/pressed", VUI.styleBox({ bg: t.onSurface.withAlpha(0.12), radius: t.radiusFull }));
    b.set("theme_override_colors/font_color", o.color ?? t.onSurfaceVariant);
    b.set("theme_override_colors/font_hover_color", o.color ?? t.onSurface);
    b.set("theme_override_colors/font_pressed_color", t.primary);
  }
  b.set("theme_override_styles/focus", VUI.styleEmpty());
  if (o.onTap != null) {
    b.connect("pressed", (a) => {
      o.onTap();
    });
  }
  return b;
};

// A floating action button: (glyph, { onTap, size, bg, color }). Material FAB
// — 56dp, radius 16, primaryContainer, elevation 3.
VUI.fab = (glyph, o) => {
  o = o ?? {};
  let t = VUI.theme();
  let d = __vuiNum(o.size, 56.0);
  let b = GD.create("Button");
  b.set("text", glyph);
  b.set("theme_override_font_sizes/font_size", GInt(d * 0.42));
  b.set("focus_mode", GInt(0));
  __vuiMinSize(b, d, d);
  let bg = o.bg ?? t.primaryContainer;
  let fg = o.color ?? t.onPrimaryContainer;
  b.set("theme_override_styles/normal", VUI.styleBox({ bg: bg, radius: t.radiusL, shadow: 3 }));
  b.set("theme_override_styles/hover", VUI.styleBox({ bg: __vuiLayer(bg, fg, 0.08), radius: t.radiusL, shadow: 4 }));
  b.set("theme_override_styles/pressed", VUI.styleBox({ bg: __vuiLayer(bg, fg, 0.12), radius: t.radiusL, shadow: 3 }));
  b.set("theme_override_styles/focus", VUI.styleEmpty());
  b.set("theme_override_colors/font_color", fg);
  b.set("theme_override_colors/font_hover_color", fg);
  b.set("theme_override_colors/font_pressed_color", fg);
  if (o.onTap != null) {
    b.connect("pressed", (a) => {
      o.onTap();
    });
  }
  return b;
};

// Style an existing LineEdit as a Material filled text field. Shared by
// VUI.field and the VReact <input> driver.
VUI.fieldStyle = (e) => {
  let t = VUI.theme();
  e.set("theme_override_font_sizes/font_size", GInt(t.fontM));
  if (__vuiFonts.regular != null) {
    e.set("theme_override_fonts/font", __vuiFonts.regular);
  }
  __vuiMinSize(e, 0.0, t.fieldHeight);
  e.set(
    "theme_override_styles/normal",
    VUI.styleBox({
      bg: t.surfaceContainerHighest,
      radiusTL: t.radiusXS, radiusTR: t.radiusXS, radiusBL: 0, radiusBR: 0, radius: 0,
      padX: 16, borderB: 1, borderColor: t.onSurfaceVariant,
    })
  );
  e.set(
    "theme_override_styles/focus",
    VUI.styleBox({
      bg: t.surfaceContainerHighest,
      radiusTL: t.radiusXS, radiusTR: t.radiusXS, radiusBL: 0, radiusBR: 0, radius: 0,
      padX: 16, borderB: 2, borderColor: t.primary,
    })
  );
  e.set("theme_override_colors/font_color", t.onSurface);
  e.set("theme_override_colors/font_placeholder_color", t.onSurfaceVariant.withAlpha(0.7));
  e.set("theme_override_colors/caret_color", t.primary);
  e.set("theme_override_colors/selection_color", t.primary.withAlpha(0.3));
};

// A text input: { placeholder, label, value, obscure, onChanged(text),
// onSubmit(text) }. Material filled field; a `label` renders a small heading
// above (the retained kit has no floating animation). Returns a handle
// { node, getText(), setText(v) }.
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
  __vuiExpandH(e);
  VUI.fieldStyle(e);
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
  let node = e;
  if (o.label != null) {
    node = __vuiNode(
      VUI.column({
        gap: 6,
        children: [VUI.text(o.label, { size: t.fontXS, color: t.primary, weight: "medium" }), e],
      })
    );
  }
  return {
    node: node,
    edit: e,
    getText: () => st.text,
    setText: (v) => {
      st.text = "" + v;
      e.set("text", st.text);
    },
  };
};

// An animated Material switch: { value, onChanged(bool) }. Pill track +
// sliding knob (52×32, 24dp thumb), tweened over the bridge. Returns a handle
// { node, isOn(), setOn(v) }.
VUI.toggle = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let w = 52.0;
  let h = 32.0;
  let knobD = 24.0;
  let inset = (h - knobD) / 2.0;
  let st = { on: o.value == true };

  let b = GD.create("Button");
  b.set("focus_mode", GInt(0));
  __vuiMinSize(b, w, h);
  b.set("theme_override_styles/normal", VUI.styleEmpty());
  b.set("theme_override_styles/hover", VUI.styleEmpty());
  b.set("theme_override_styles/pressed", VUI.styleEmpty());
  b.set("theme_override_styles/focus", VUI.styleEmpty());

  let offTrack = VUI.styleBox({ bg: t.surfaceContainerHighest, radius: t.radiusFull, border: 2, borderColor: t.outline });
  let onTrack = VUI.styleBox({ bg: t.primary, radius: t.radiusFull });
  let track = GD.create("Panel");
  __vuiFullRect(track);
  track.set("mouse_filter", GInt(2));
  track.set("theme_override_styles/panel", st.on ? onTrack : offTrack);
  b.call("add_child", [track]);

  let offKnob = VUI.styleBox({ bg: t.outline, radius: t.radiusFull });
  let onKnob = VUI.styleBox({ bg: t.onPrimary, radius: t.radiusFull, shadow: 1 });
  let knob = GD.create("Panel");
  __vuiMinSize(knob, knobD, knobD);
  knob.set("size", new Vector2(knobD, knobD));
  knob.set("mouse_filter", GInt(2));
  knob.set("theme_override_styles/panel", st.on ? onKnob : offKnob);
  let xOff = inset;
  let xOn = w - knobD - inset;
  knob.set("position", new Vector2(st.on ? xOn : xOff, inset));
  b.call("add_child", [knob]);

  let apply = (animate) => {
    track.set("theme_override_styles/panel", st.on ? onTrack : offTrack);
    knob.set("theme_override_styles/panel", st.on ? onKnob : offKnob);
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
  let d = 22.0;

  let b = GD.create("Button");
  b.set("focus_mode", GInt(0));
  b.set("theme_override_styles/normal", VUI.styleEmpty());
  b.set("theme_override_styles/hover", VUI.styleEmpty());
  b.set("theme_override_styles/pressed", VUI.styleEmpty());
  b.set("theme_override_styles/focus", VUI.styleEmpty());
  __vuiMinSize(b, 0.0, t.minTouch);

  let boxOff = VUI.styleBox({ radius: t.radiusXS, border: 2, borderColor: t.onSurfaceVariant });
  let boxOn = VUI.styleBox({ bg: t.primary, radius: t.radiusXS });
  let box = GD.create("PanelContainer");
  __vuiMinSize(box, d, d);
  box.set("mouse_filter", GInt(2));
  box.set("theme_override_styles/panel", st.on ? boxOn : boxOff);
  let mark = VUI.text("✓", { size: t.fontS, color: t.onPrimary, align: "center", weight: "bold" });
  mark.set("vertical_alignment", GInt(1));
  mark.set("visible", st.on);
  box.call("add_child", [mark]);

  let boxCenter = GD.create("CenterContainer");
  boxCenter.set("mouse_filter", GInt(2));
  boxCenter.call("add_child", [box]);

  let items = [boxCenter];
  if (o.label != null) {
    let lab = VUI.text(o.label, { size: t.fontS });
    lab.set("vertical_alignment", GInt(1));
    items.push(lab);
  }
  let rowBox = GD.create("HBoxContainer");
  rowBox.set("theme_override_constants/separation", GInt(12));
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

// Style an existing HSlider like a Material slider. Shared with the VReact
// <slider> driver.
VUI.sliderStyle = (s) => {
  let t = VUI.theme();
  __vuiMinSize(s, 0.0, t.minTouch);
  // The groove…
  s.set(
    "theme_override_styles/slider",
    VUI.styleBox({ bg: t.surfaceContainerHighest, radius: t.radiusFull, padY: 3 })
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
  // …and a code-generated round thumb (no image assets).
  let grabber = VUI.circleTexture(22, t.primary);
  let grabberHi = VUI.circleTexture(26, __vuiLayer(t.primary, t.onPrimary, 0.1));
  s.set("theme_override_icons/grabber", grabber);
  s.set("theme_override_icons/grabber_disabled", grabber);
  s.set("theme_override_icons/grabber_highlight", grabberHi);
};

// A slider: { min, max, value, step, onChanged(value) }. Returns a handle
// { node, getValue(), setValue(v) }.
VUI.slider = (o) => {
  o = o ?? {};
  let s = GD.create("HSlider");
  let st = { value: __vuiNum(o.value, 0.0) };
  s.set("min_value", GFloat(__vuiNum(o.min, 0.0)));
  s.set("max_value", GFloat(__vuiNum(o.max, 100.0)));
  if (o.step != null) {
    s.set("step", GFloat(o.step));
  }
  s.set("value", GFloat(st.value));
  s.set("focus_mode", GInt(0));
  __vuiExpandH(s);
  VUI.sliderStyle(s);
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

// A progress bar: { value, max, height, color }. Returns a handle
// { node, setValue(v) }.
VUI.progress = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let p = GD.create("ProgressBar");
  p.set("min_value", GFloat(0.0));
  p.set("max_value", GFloat(__vuiNum(o.max, 100.0)));
  p.set("value", GFloat(__vuiNum(o.value, 0.0)));
  p.set("show_percentage", false);
  __vuiMinSize(p, 0.0, __vuiNum(o.height, 6.0));
  __vuiExpandH(p);
  p.set(
    "theme_override_styles/background",
    VUI.styleBox({ bg: t.surfaceContainerHighest, radius: t.radiusFull })
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

// The top app bar (Material small top app bar): { title, subtitle, leading
// (widget), actions: [widget], bg, flat }.
VUI.appBar = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let bar = GD.create("PanelContainer");
  __vuiMinSize(bar, 0.0, t.barHeight);
  bar.set(
    "theme_override_styles/panel",
    VUI.styleBox({
      bg: o.bg ?? t.surfaceContainer,
      radius: 0,
      padX: 16,
      padY: 8,
      shadow: o.flat == true ? 0 : 1,
    })
  );
  let items = [];
  if (o.leading != null) {
    items.push(__vuiNode(o.leading));
  }
  let titleCol = [];
  titleCol.push(VUI.text(o.title ?? "", { size: t.fontL, weight: "medium" }));
  if (o.subtitle != null) {
    titleCol.push(VUI.caption(o.subtitle));
  }
  let midInner = VUI.column({ gap: 0, children: titleCol });
  let mid = GD.create("VBoxContainer");
  mid.set("alignment", GInt(1));
  mid.call("add_child", [__vuiNode(midInner)]);
  __vuiExpandH(mid);
  items.push(mid);
  if (o.actions != null) {
    for (let i = 0; i < o.actions.length; i++) {
      items.push(__vuiNode(o.actions[i]));
    }
  }
  let rowBox = GD.create("HBoxContainer");
  rowBox.set("theme_override_constants/separation", GInt(12));
  __vuiAddAll(rowBox, items);
  bar.call("add_child", [rowBox]);
  return bar;
};

// A Material segmented button strip: { items: [label], index, onSelect(i) }.
// Returns a handle { node, select(i), getIndex() }.
VUI.tabs = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let st = { index: __vuiNum(o.index, 0), buttons: [] };
  let wrap = GD.create("PanelContainer");
  wrap.set(
    "theme_override_styles/panel",
    VUI.styleBox({ radius: t.radiusFull, pad: 4, bg: t.surfaceContainerHigh })
  );
  let rowBox = GD.create("HBoxContainer");
  rowBox.set("theme_override_constants/separation", GInt(4));
  wrap.call("add_child", [rowBox]);

  let onSb = VUI.styleBox({ bg: t.secondaryContainer, radius: t.radiusFull, padX: 16, padY: 8 });
  let offSb = VUI.styleBox({ radius: t.radiusFull, padX: 16, padY: 8 });
  let offHover = VUI.styleBox({ bg: t.onSurface.withAlpha(0.08), radius: t.radiusFull, padX: 16, padY: 8 });

  let applyAll = () => {
    for (let i = 0; i < st.buttons.length; i++) {
      let selected = i == st.index;
      let bb = st.buttons[i];
      bb.set("theme_override_styles/normal", selected ? onSb : offSb);
      bb.set("theme_override_styles/hover", selected ? onSb : offHover);
      bb.set("theme_override_styles/pressed", selected ? onSb : offHover);
      bb.set("theme_override_colors/font_color", selected ? t.onSecondaryContainer : t.onSurfaceVariant);
      bb.set("theme_override_colors/font_hover_color", selected ? t.onSecondaryContainer : t.onSurface);
      bb.set("theme_override_colors/font_pressed_color", selected ? t.onSecondaryContainer : t.onSurface);
    }
  };
  let items = o.items ?? [];
  for (let i = 0; i < items.length; i++) {
    // A fresh `let` per iteration: each closure captures its own index.
    let idx = i;
    let b = GD.create("Button");
    b.set("text", "" + items[i]);
    b.set("theme_override_font_sizes/font_size", GInt(t.fontS));
    __vuiApplyWeight(b, "medium");
    b.set("focus_mode", GInt(0));
    b.set("theme_override_styles/focus", VUI.styleEmpty());
    __vuiMinSize(b, 0.0, 40.0);
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

// The Material navigation bar: { items: [{glyph, label}], index, onSelect(i) }.
// 80dp bar on surfaceContainer; the active item gets a secondaryContainer
// indicator pill behind its icon. Returns a handle { node, select(i),
// getIndex() }.
VUI.bottomNav = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let st = { index: __vuiNum(o.index, 0), glyphs: [], labels: [], pills: [] };
  let bar = GD.create("PanelContainer");
  __vuiMinSize(bar, 0.0, t.navHeight);
  bar.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: t.surfaceContainer, radius: 0, padY: 10 })
  );
  let rowBox = GD.create("HBoxContainer");
  rowBox.set("theme_override_constants/separation", GInt(0));
  bar.call("add_child", [rowBox]);

  let pillOn = VUI.styleBox({ bg: t.secondaryContainer, radius: t.radiusFull });
  let pillOff = VUI.styleEmpty();

  let applyAll = () => {
    for (let i = 0; i < st.glyphs.length; i++) {
      let selected = i == st.index;
      st.pills[i].set("theme_override_styles/panel", selected ? pillOn : pillOff);
      st.glyphs[i].set(
        "theme_override_colors/font_color",
        selected ? t.onSecondaryContainer : t.onSurfaceVariant
      );
      st.labels[i].set(
        "theme_override_colors/font_color",
        selected ? t.onSurface : t.onSurfaceVariant
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
    b.set("theme_override_styles/focus", VUI.styleEmpty());
    __vuiExpandH(b);

    // The icon sits inside a 56×30 indicator pill.
    let glyph = VUI.icon(items[i]["glyph"] ?? "•", { size: 18, color: t.onSurfaceVariant });
    glyph.set("vertical_alignment", GInt(1));
    let pill = GD.create("PanelContainer");
    __vuiMinSize(pill, 56.0, 30.0);
    pill.set("mouse_filter", GInt(2));
    pill.set("theme_override_styles/panel", pillOff);
    pill.call("add_child", [glyph]);
    let pillCenter = GD.create("CenterContainer");
    pillCenter.set("mouse_filter", GInt(2));
    pillCenter.call("add_child", [pill]);

    let label = VUI.text(items[i]["label"] ?? "", {
      size: t.fontXS, color: t.onSurfaceVariant, align: "center", weight: "medium",
    });
    let col = GD.create("VBoxContainer");
    col.set("theme_override_constants/separation", GInt(4));
    col.set("mouse_filter", GInt(2));
    __vuiFullRect(col);
    col.set("alignment", GInt(1)); // centered
    col.call("add_child", [pillCenter]);
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
    st.pills.push(pill);
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
//
// The overlay only captures input while at least one modal is up; a counter
// keeps stacked modals honest (a dialog above a sheet, …).

function __vuiOverlayOn() {
  __vuiApp.overlays = __vuiApp.overlays + 1;
  __vuiApp.overlay.set("mouse_filter", GInt(0)); // MOUSE_FILTER_STOP
}

function __vuiOverlayOff() {
  __vuiApp.overlays = __vuiApp.overlays - 1;
  if (__vuiApp.overlays <= 0) {
    __vuiApp.overlays = 0;
    __vuiApp.overlay.set("mouse_filter", GInt(2)); // MOUSE_FILTER_IGNORE
  }
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
  s.set("theme_override_styles/focus", VUI.styleEmpty());
  s.connect("pressed", (a) => {
    onTap();
  });
  return s;
}

// A modal Material dialog: { title, body (string or widget), actions:
// [{text, kind, onTap}], width, dismissible }. Shows immediately; returns
// { close() }.
VUI.dialog = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let m = VUI.metrics();
  let maxW = m.w - 48.0;
  if (maxW > 560.0) {
    maxW = 560.0;
  }
  let w = __vuiNum(o.width, maxW);
  if (w > m.w - 24.0) {
    w = m.w - 24.0;
  }
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
    children.push(VUI.text(o.title, { size: 24, weight: "medium" }));
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
          height: 40.0,
          onTap: () => {
            close();
            if (spec["onTap"] != null) {
              spec["onTap"]();
            }
          },
        })
      );
    }
    children.push(VUI.row({ gap: 8, children: btns }));
  }

  let card = VUI.panel({
    bg: t.surfaceContainerHigh,
    radius: t.radiusXL,
    pad: 24,
    gap: 16,
    shadow: 3,
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

// A Material bottom sheet: { title, children, dismissible }. Returns
// { close() }.
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
    print("DBGJS sheet close: scheduling free");
    VUI.fade(holder, 0.0, 150);
    GTimer.after(170, () => {
      print("DBGJS sheet holder freed");
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
  // The grab handle (32×4, outline-tinted).
  let handleBar = GD.create("Panel");
  __vuiMinSize(handleBar, 32.0, 4.0);
  handleBar.set("theme_override_styles/panel", VUI.styleBox({ bg: t.outlineVariant, radius: t.radiusFull }));
  let handleCenter = GD.create("CenterContainer");
  handleCenter.call("add_child", [handleBar]);
  children.push(handleCenter);
  if (o.title != null) {
    children.push(VUI.title(o.title));
  }
  if (o.children != null) {
    for (let i = 0; i < o.children.length; i++) {
      children.push(o.children[i]);
    }
  }

  let card = VUI.panel({
    bg: t.surfaceContainer,
    radius: 0,
    pad: 20,
    gap: 16,
    children: children,
  });
  // Pin to the bottom edge, full width, rounded top corners.
  card.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: t.surfaceContainer, radiusTL: t.radiusXL, radiusTR: t.radiusXL, radius: 0, pad: 20, shadow: 2 })
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

// Style an existing OptionButton like a Material filled field/menu anchor.
// Shared with the VReact <select> driver. Also restyles its popup menu.
VUI.dropdownStyle = (e) => {
  let t = VUI.theme();
  e.set("theme_override_font_sizes/font_size", GInt(t.fontM));
  if (__vuiFonts.regular != null) {
    e.set("theme_override_fonts/font", __vuiFonts.regular);
  }
  __vuiMinSize(e, 0.0, t.fieldHeight);
  e.set("theme_override_styles/normal", VUI.styleBox({
    bg: t.surfaceContainerHighest,
    radiusTL: t.radiusXS, radiusTR: t.radiusXS, radiusBL: 0, radiusBR: 0, radius: 0,
    padX: 16, borderB: 1, borderColor: t.onSurfaceVariant,
  }));
  e.set("theme_override_styles/hover", VUI.styleBox({
    bg: __vuiLayer(t.surfaceContainerHighest, t.onSurface, 0.06),
    radiusTL: t.radiusXS, radiusTR: t.radiusXS, radiusBL: 0, radiusBR: 0, radius: 0,
    padX: 16, borderB: 1, borderColor: t.onSurfaceVariant,
  }));
  e.set("theme_override_styles/pressed", VUI.styleBox({
    bg: t.surfaceContainerHighest,
    radiusTL: t.radiusXS, radiusTR: t.radiusXS, radiusBL: 0, radiusBR: 0, radius: 0,
    padX: 16, borderB: 2, borderColor: t.primary,
  }));
  e.set("theme_override_styles/focus", VUI.styleEmpty());
  e.set("theme_override_colors/font_color", t.onSurface);
  e.set("theme_override_colors/font_hover_color", t.onSurface);
  e.set("theme_override_colors/font_pressed_color", t.onSurface);
  // The popup menu: an elevated Material menu surface.
  let popup = e.call("get_popup");
  if (popup != null && !GD.isError(popup)) {
    popup.set(
      "theme_override_styles/panel",
      VUI.styleBox({ bg: t.surfaceContainerHigh, radius: t.radiusXS, pad: 8, shadow: 2 })
    );
    popup.set("theme_override_font_sizes/font_size", GInt(t.fontM));
    popup.set("theme_override_colors/font_color", t.onSurface);
    popup.set("theme_override_colors/font_hover_color", t.onSurface);
    popup.set(
      "theme_override_styles/hover",
      VUI.styleBox({ bg: t.onSurface.withAlpha(0.08), radius: t.radiusXS })
    );
  }
};

// A dropdown selector (OptionButton): { items: [label], index, onSelect(i) }.
// Returns a handle { node, getIndex(), select(i) }.
VUI.dropdown = (o) => {
  o = o ?? {};
  let st = { index: __vuiNum(o.index, 0) };
  let e = GD.create("OptionButton");
  e.set("focus_mode", GInt(0));
  VUI.dropdownStyle(e);
  let items = o.items ?? [];
  for (let i = 0; i < items.length; i++) {
    e.call("add_item", ["" + items[i], GInt(i)]);
  }
  if (items.length > 0) {
    e.call("select", [GInt(st.index)]);
  }
  e.connect("item_selected", (a) => {
    st.index = a[0];
    if (o.onSelect != null) {
      o.onSelect(a[0]);
    }
  });
  return {
    node: e,
    getIndex: () => st.index,
    select: (i) => {
      st.index = i;
      e.call("select", [GInt(i)]);
    },
  };
};

// Style an existing TextEdit as a Material filled multiline field. Shared
// with the VReact <textarea> driver.
VUI.textareaStyle = (e) => {
  let t = VUI.theme();
  e.set("theme_override_font_sizes/font_size", GInt(t.fontM));
  if (__vuiFonts.regular != null) {
    e.set("theme_override_fonts/font", __vuiFonts.regular);
  }
  e.set(
    "theme_override_styles/normal",
    VUI.styleBox({
      bg: t.surfaceContainerHighest,
      radiusTL: t.radiusXS, radiusTR: t.radiusXS, radiusBL: 0, radiusBR: 0, radius: 0,
      pad: 14, borderB: 1, borderColor: t.onSurfaceVariant,
    })
  );
  e.set(
    "theme_override_styles/focus",
    VUI.styleBox({
      bg: t.surfaceContainerHighest,
      radiusTL: t.radiusXS, radiusTR: t.radiusXS, radiusBL: 0, radiusBR: 0, radius: 0,
      pad: 14, borderB: 2, borderColor: t.primary,
    })
  );
  e.set("theme_override_colors/font_color", t.onSurface);
  e.set("theme_override_colors/font_placeholder_color", t.onSurfaceVariant.withAlpha(0.7));
  e.set("theme_override_colors/caret_color", t.primary);
  e.set("theme_override_colors/selection_color", t.primary.withAlpha(0.3));
};

// A multiline text input (TextEdit): { placeholder, value, height,
// onChanged(text) }. Returns a handle { node, getText(), setText(v) }.
VUI.textarea = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let st = { text: "" + (o.value ?? "") };
  let e = GD.create("TextEdit");
  if (o.placeholder != null) {
    e.set("placeholder_text", o.placeholder);
  }
  if (st.text != "") {
    e.set("text", st.text);
  }
  e.set("wrap_mode", GInt(1));
  __vuiMinSize(e, 0.0, __vuiNum(o.height, 120.0));
  __vuiExpandH(e);
  VUI.textareaStyle(e);
  e.connect("text_changed", (a) => {
    st.text = "" + e.get("text");
    if (o.onChanged != null) {
      o.onChanged(st.text);
    }
  });
  return {
    node: e,
    getText: () => st.text,
    setText: (v) => {
      st.text = "" + v;
      e.set("text", st.text);
    },
  };
};

// A draggable, closable floating window (the desktop-game "panel window"
// idiom): { title, subtitle, accent (Color), width, height, x, y, child,
// children, gap, onClose }. Mounts on the app overlay; returns
// { node, close(), setTitle(v) }. Drag the title bar to move it.
VUI.window = (o) => {
  o = o ?? {};
  let t = VUI.theme();
  let w = __vuiNum(o.width, __vuiApp.w - 80.0);
  let h = __vuiNum(o.height, 0.0);
  let accent = o.accent ?? t.primary;

  let holder = GD.create("PanelContainer");
  holder.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: t.surfaceContainerLow, radius: t.radiusL, shadow: 4 })
  );
  holder.set("position", new Vector2(__vuiNum(o.x, 40.0), __vuiNum(o.y, 60.0)));
  __vuiMinSize(holder, w, h);

  let closed = { done: false };
  let close = () => {
    if (closed.done) {
      return;
    }
    closed.done = true;
    holder.queueFree();
    if (o.onClose != null) {
      o.onClose();
    }
  };

  let titleLabel = VUI.text(o.title ?? "", { size: t.fontM, color: accent, weight: "medium" });
  __vuiExpandH(titleLabel);
  let closeBtn = VUI.iconButton("✕", { size: 40.0, onTap: close });

  // Title bar doubles as the drag handle.
  let bar = GD.create("PanelContainer");
  bar.set(
    "theme_override_styles/panel",
    VUI.styleBox({ bg: t.surfaceContainerHigh, radiusTL: t.radiusL, radiusTR: t.radiusL, radius: 0, padX: 16, padY: 8 })
  );
  let barRow = GD.create("HBoxContainer");
  barRow.set("theme_override_constants/separation", GInt(12));
  let titleItems = [titleLabel];
  if (o.subtitle != null) {
    let col = VUI.column({ gap: 2, children: [titleLabel, VUI.caption(o.subtitle)] });
    __vuiExpandH(col);
    titleItems = [col];
  }
  __vuiAddAll(barRow, titleItems);
  barRow.call("add_child", [closeBtn]);
  bar.call("add_child", [barRow]);

  let drag = { on: false };
  bar.connect("gui_input", (a) => {
    let ev = a[0];
    if (ev == null || !__isType(ev, "GObj")) {
      return;
    }
    if (ev.cls == "InputEventMouseButton" || ev.cls == "InputEventScreenTouch") {
      drag.on = ev.get("pressed") == true;
    } else if (ev.cls == "InputEventMouseMotion" || ev.cls == "InputEventScreenDrag") {
      if (drag.on) {
        let rel = ev.get("relative");
        let pos = holder.get("position");
        holder.set("position", new Vector2(pos.x + rel.x, pos.y + rel.y));
      }
    }
  });

  let bodyChildren = [];
  if (o.child != null) {
    bodyChildren.push(o.child);
  }
  if (o.children != null) {
    for (let i = 0; i < o.children.length; i++) {
      bodyChildren.push(o.children[i]);
    }
  }
  let body = VUI.column({ gap: __vuiNum(o.gap, 12), pad: 16, children: bodyChildren });

  let frame = GD.create("VBoxContainer");
  frame.set("theme_override_constants/separation", GInt(0));
  frame.call("add_child", [bar]);
  if (h > 0.0) {
    frame.call("add_child", [__vuiNode(VUI.scroll({ child: body }))]);
  } else {
    frame.call("add_child", [__vuiNode(body)]);
  }
  holder.call("add_child", [frame]);

  __vuiApp.overlay.call("add_child", [holder]);
  return {
    node: holder,
    close: close,
    setTitle: (v) => {
      titleLabel.set("text", "" + v);
    },
  };
};

// A snackbar / toast: (msg, { kind: 'info'|'success'|'warning'|'danger',
// ms }). Material snackbar — inverse surface, bottom of the screen.
// Auto-dismisses; a new toast replaces the previous one.
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
    VUI.styleBox({ bg: t.inverseSurface, radius: t.radiusS, padX: 16, padY: 12, shadow: 3 })
  );
  let rowBox = GD.create("HBoxContainer");
  rowBox.set("theme_override_constants/separation", GInt(10));
  rowBox.call("add_child", [VUI.icon(glyph, { size: t.fontM, color: accent })]);
  let msgLabel = VUI.text("" + msg, { size: t.fontS, color: t.inverseOnSurface });
  rowBox.call("add_child", [msgLabel]);
  p.call("add_child", [rowBox]);

  // Bottom-center strip, above the nav bar.
  p.set("anchor_left", GFloat(0.0));
  p.set("anchor_right", GFloat(1.0));
  p.set("anchor_top", GFloat(1.0));
  p.set("anchor_bottom", GFloat(1.0));
  p.set("offset_left", GFloat(16.0));
  p.set("offset_right", GFloat(-16.0));
  p.set("offset_top", GFloat(0.0 - t.navHeight - 76.0));
  p.set("offset_bottom", GFloat(0.0 - t.navHeight - 16.0));
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
