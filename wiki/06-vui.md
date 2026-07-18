# 06 — VUI (the Victor UI kit)

VUI (`ui.js`) is a **native** widget toolkit: every widget is a retained Godot
`Control` created reflectively over the bridge — no image assets, no second
engine. It **works on every target** (desktop, Android, web) because it is just
Godot. This is what the shipped Android/web artifacts use for UI.

`import 'ui.js';` (implies `godot.js`). Then use the `VUI` facade.

## App shell & layout

```js
VUI.use(VUI.themeDark());                       // or themeLight()
let app = VUI.app({ design: [720, 1280], portrait: true });   // dp mode: {responsive:true}
app.push(VUI.column({ gap: 12, children: [ /* your page */ ] }));
```

`VUI.app(o)` creates a **CanvasLayer** (composites over the viewport, so UI can
sit over a 3D scene) + a full-rect page, content-scales the design space, and
locks portrait if asked. It returns `{ layer, root, overlay, push, w, h }`.

> **`bg: false` for UI over 3D.** By default `VUI.app` paints an **opaque
> full-screen background**. To let a 3D scene show through, pass
> `VUI.app({ ..., bg: false })`. Forgetting this is why "the 3D doesn't render".
> (See `12-gotchas.md`.)

Layout widgets: `VUI.column` · `row` · `grid` · `scroll` · `margin` · `center` ·
`panel` · `spacer` · `divider` · `expand(w)` · `gap` · `stack` · `positioned` ·
`align` · `aspectRatio` · `wrap`. Most take `{ gap, pad, children }`.

## Content & controls (the catalog)

Full list (from `ui.js`): `text` `heading` `title` `caption` · `icon` `badge`
`chip` `avatar` `card` `stat` `listTile` `image` · `button` `iconButton` `fab`
`field` `textarea` `toggle` `checkbox` `slider` `dropdown` `progress` ·
`appBar` `tabs` `bottomNav` `drawer`(via panel) · `dialog` `sheet` `toast` ·
`divider` `spacer`.

```js
VUI.title("Victor");
VUI.caption("subtitle");
VUI.button("Tap me", { kind: "filled", onTap: () => { ... } });   // filled|tonal|outline|ghost|danger
VUI.iconButton("♥", { onTap: () => {} });
VUI.field({ hint: "name", onChanged: (text) => {} });
VUI.slider({ value: 0.5, min: 0, max: 1, onChanged: (v) => {} });
VUI.toggle({ value: true, onChanged: (on) => {} });
VUI.checkbox({ label: "agree", value: false, onChanged: (on) => {} });
VUI.chip("Live", { selected: true, onTap: (on) => {} });
VUI.card({ child: VUI.column({ children: [...] }) });
VUI.stat({ label: "FPS", value: "60" });
```

Overlays (mount to the app overlay, always on top):

```js
VUI.dialog({ title: "...", body: VUI.text("..."), actions: [ ... ] });
VUI.sheet({ child: VUI.column({ children: [...] }) });
VUI.toast("saved", { kind: "success" });   // info|success|warning|danger
```

Navigation:

```js
let nav = VUI.bottomNav({
  items: [ { glyph: "◈", label: "Home" }, { glyph: "❖", label: "More" } ],
  index: 0, onSelect: (i) => { ... },
});
```

External web content (webview):

```js
// Open a URL over the running app in the best available OS-NATIVE surface
// (no bundled browser engine — exports stay small). Ladder, in order:
//   1. WEB export      — a DOM <iframe> over the canvas (JavaScriptBridge),
//                        title bar with open-in-new-tab + close, media
//                        permissions for conferencing (camera/mic/fullscreen)
//   2. ANDROID         — the ElpianWebView plugin (bridge/android/webview):
//                        the system WebView (Chromium) overlaid on the game
//                        activity, camera/mic granted to the page once the
//                        app holds the runtime permissions
//   3. DESKTOP         — godot_wry's `WebView` Control (WebView2 / WKWebView
//                        / WebKitGTK), mounted on the app overlay under a
//                        VUI title bar; present when the export bundles the
//                        addon (bridge/tools/fetch-godot-wry.sh)
//   4. otherwise       — the system browser (OS.shell_open)
let surface = VUI.webview({ url: "https://example.org/room", title: "My room" });
// surface: "webview" (DOM) | "native" (Android/desktop) | "browser" | ""
VUI.closeWebview();   // programmatically close any open in-app surface
```

The DOM and Android overlays are self-contained (their close buttons act
platform-side, so no callback crosses back into the VM) and survive guest
screen rebuilds until closed; the desktop surface is a VUI overlay owning a
native `WebView` Control. The OpenLearn Moodle client uses this ladder to
open BigBlueButton video-conference rooms on every platform. WebRTC caveats:
Windows/macOS/Android webviews support camera + microphone; Linux/WebKitGTK
varies by distro (the title bar's "Open in browser" is the escape hatch);
screen *sharing* is desktop-browser territory everywhere.

## Theming

`VUI.use(VUI.themeDark() | VUI.themeLight())` installs a token set; `VUI.theme()`
reads current tokens (colors, radii, font sizes, control heights). Style helpers:
`VUI.styleBox(o)`, `VUI.buttonStyle`, `VUI.sliderStyle`, `VUI.fieldStyle`,
`VUI.installFonts` / `VUI.fonts`. Animations: `VUI.tween(node)`, `VUI.animate`,
`VUI.fade`. Responsive: `VUI.metrics()`, `VUI.onResize(cb)`.

## Canvas — a `CustomPainter`-equivalent (native)

`VUI.canvas` gives you a full drawing surface. It renders via
`RenderingServer.canvas_item_add_*` on the Control's canvas-item RID — **retained
commands that work outside the draw phase**, unlike `CanvasItem.draw_*` (which
only work inside `_draw`) and unlike the bridged `draw` signal (which is
delivered deferred and would reject draw calls). Its `cv` object **mirrors the
`FLCanvas` method surface** (`07-flutter-bridge.md`), so **one painter function
works on both the VUI path and the real-Flutter path**.

```js
let gaugeNode = VUI.canvas({
  size: [320, 190],
  paint: (cv) => {
    // geometry matches FL: Offset=[x,y], Rect=[l,t,r,b], Color=[r,g,b,a]
    cv.drawArc([16,16,304,304], PI, PI, false,
      FL.paint({ color:[1,1,1,0.14], style:"stroke", strokeWidth:16, strokeCap:"round" }));
    cv.save(); cv.translate(160, 164); cv.rotate(a);
    cv.drawLine([0,0], [110,0], FL.paint({ color:[1,0.85,0.3,1], style:"stroke", strokeWidth:5 }));
    cv.restore();
    cv.drawCircle(160, 164, 9, FL.paint({ color:[1,0.85,0.3,1] }));
    cv.drawParagraph(FL.paragraph("60 °/s", 320, { size:22, color:[1,1,1,0.9] }, "center"), 0, 120);
  },
});
VUI.repaint(gaugeNode);   // call each frame (from GD.onProcess) to animate
```

`cv` methods (mirror `FLCanvas`): `save` `restore` `translate` `rotate` `scale` ·
`drawColor` `drawPaint` `drawLine` `drawRect` `drawRRect` `drawOval` `drawCircle`
`drawArc` `drawPath` `drawParagraph` `drawPoints`. Paints are plain maps built
with `FL.paint({...})` (needs `import 'flutter.js';` for the helper — or write
the map literally: `{ color:[...], style:"stroke", strokeWidth:n }`). Gradients
via `FL.sweepGradient/linearGradient/radialGradient` are honoured on the Flutter
path; on the native path the paint's plain `color` is used, so **give gradient
paints a fallback `color`**.

> `VUI.canvas` uses `sin`/`cos` (VM globals) to sample arcs/paths. Rects are
> `[left,top,right,bottom]`. Per-command clipping is not available in the native
> path (`clipRect`/`clipPath` are no-ops); everything else maps.

## Gestures — the Flutter event vocabulary (native)

`VUI.gestures(child, handlers)` wraps a child in a Control that STOPs for input
and translates Godot `gui_input` / `mouse_entered` / `mouse_exited` into the
Flutter callback set (mouse **and** touch):

```js
let pad = VUI.gestures(VUI.canvas({ size:[300,90], paint: drawPad }), {
  onTapDown: (e) => {},   onTapUp: (e) => {},   onTap: (e) => {},
  onSecondaryTap: (e) => {},   onDoubleTap: (e) => {},   onLongPress: (e) => {},
  onPanStart: (e) => {},  onPanUpdate: (e) => { orbit(e.dx, e.dy); },  onPanEnd: (e) => {},
  onEnter: () => {},  onExit: () => {},  onHover: (e) => {},  onScroll: (e) => { /* e.dy */ },
});
```

Each detail is `{ x, y }` (position) and, for pan, `{ dx, dy, x, y }` (delta).

## Putting it together (UI over a 3D scene)

```js
import 'godot.js';
import 'ui.js';
import 'flutter.js';   // for FL.paint in the canvas painter

buildWorld();          // add G3.environment/camera/light/meshes under GD.host()

VUI.use(VUI.themeDark());
let app = VUI.app({ design: [720,1280], portrait: true, bg: false });   // bg:false!
let gauge = VUI.canvas({ size:[320,190], paint: drawGauge });
app.push(VUI.column({ gap: 0, children: [
  VUI.spacer(),                                  // top area shows the 3D
  VUI.panel({ pad: 18, radius: 22, child: VUI.column({ gap: 12, children: [
    VUI.title("Victor — VUI × 3D"),
    VUI.center({ child: gauge }),
    VUI.gestures(VUI.canvas({ size:[600,90], paint: drawPad }), { onPanUpdate: (e)=>orbit(e.dx,e.dy) }),
    VUI.slider({ value: 0.5, onChanged: (v) => setSpeed(v) }),
  ]}) }),
]}));
GD.onProcess((d) => { spin(d); VUI.repaint(gauge); });
```

The shipped demo `victor/bridge/project/scripts/flutter_3d_demo.js` is exactly
this pattern (with a shared gauge painter used by both VUI and FL). Read it as a
complete working example.
