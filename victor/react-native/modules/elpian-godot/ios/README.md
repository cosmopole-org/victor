# iOS embedded-Godot module

The iOS twin of the Android Godot module. It installs `global.__ElpianGodot` from
the **same** shared C++ (`../android/src/main/cpp/ElpianGodotJsi.cpp` — its JNI is
`#if defined(__ANDROID__)`-guarded, with `ElpianGodotInstall` / `ElpianGodotDrainOps`
plain-C entries for iOS) and hosts the Godot viewport in `ElpianGodotView`.

## Files

- `ElpianGodotModule.swift` — the Expo module (install() + View registration).
- `ElpianGodotBridge.{h,mm}` — ObjC++ over the shared install / drain entries.
- `ElpianGodotView.swift` — the viewport host: a `CADisplayLink` drains the op
  queue each frame (the iOS analogue of the Android GodotFragment OpSink) and
  feeds a linked Godot iOS runtime via `ElpianGodotView.opSink`.

## The Godot iOS runtime (a binary build artifact, like the Android AAR/.so)

Rendering needs two artifacts the Android module also ships as binaries:

1. **libgodot.ios** — Godot 4.3 built as an embeddable iOS library
   (`scons platform=ios target=template_release library_type=static_library`),
   the counterpart of `android/libs/godot-lib.template_release.aar`.
2. **elpian_godot GDExtension for iOS** — the reflective `GodotController`
   (`bridge/extension`) built for `arm64` iOS, the counterpart of
   `android/src/main/jniLibs/arm64-v8a/libelpian_godot.android.arm64.so`.
   Plus the exported `embed.pck` (already produced under `godot-project`).

Link those into the pod (`vendored_frameworks`) and set `ElpianGodotView.opSink`
to drive the embedded engine with the same `OpSink.gd` the Android/headless paths
use. Until they are linked, `ElpianGodotView` shows a placeholder and drops
drained ops — the 2D app and the JS 3D-op echo run unchanged (graceful
degradation identical to a Android build without the Godot library).

## One line to verify

`ElpianGodotModule.swift` reads the JSI runtime via `appContext?.runtime?.pointer`
(Expo SDK 52) — the same one-line accessor the VM and widget modules use.
