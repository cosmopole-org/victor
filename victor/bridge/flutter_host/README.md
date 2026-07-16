# elpian_flutter_host — the embedded AOT interpreter app

This is the fixed Flutter application the GDExtension embeds and runs inside the
`FlutterEngine` (see [`../FLUTTER.md`](../FLUTTER.md)). It contains **no app
logic** — it is a renderer that turns the declarative widget-tree messages the
Elpian VM sends into real Flutter widgets, and sends widget events back. All
dynamic program code stays on the VM; this app is static and AOT-compiled, so
the whole system carries no JIT.

It is the direct analogue of Google's [Remote Flutter Widgets
(`package:rfw`)](https://pub.dev/packages/rfw): a shippable, App-Store-legal way
to drive a real Flutter UI from data delivered at runtime.

## Protocol

Two `BasicMessageChannel`s (StringCodec, JSON payloads), matched on the C++ side
in `../extension/src/flutter_view.cpp`:

| Channel | Direction | Payload |
|---|---|---|
| `victor/widgets` | host → app | `{t, p, c}` serialized widget tree to render |
| `victor/events`  | app → host | `{cb, args}` — a widget fired; `cb` is the VM-namespaced callback id |

A node is `{"t": type, "p": props, "c": [children]}`. Event handlers arrive in
`p` as `{"callable": id}` tags (the guest `FL` facade tags them; the Rust
VmManager namespaces the id to the owning VM). The `type → widget` mapping lives
only in `lib/main.dart`, so growing the widget vocabulary is a change to this
file alone.

## Building the AOT snapshot

The engine loads this app as an **AOT ELF snapshot** (`app.so`) plus a
`flutter_assets` bundle and `icudtl.dat`. Produce them with a matching Flutter
SDK for each target platform, e.g. for desktop/Android-class targets:

```sh
cd bridge/flutter_host
flutter pub get

# 1) the kernel + AOT snapshot
flutter build bundle                     # -> build/flutter_assets/ (assets + icu)
dart --snapshot-kind=... # (or) use the engine's gen_snapshot for the target ABI:
#   <engine>/gen_snapshot --snapshot_kind=app-aot-elf \
#     --elf=app.so build/flutter_assets/kernel_blob.bin
```

Stage the three artifacts where the extension expects them (overridable via
ProjectSettings — see `../FLUTTER.md`):

```
res://flutter/app.so
res://flutter/flutter_assets/     # from `flutter build bundle`
res://flutter/icudtl.dat
```

The engine library itself (`libflutter_engine.so` / `.dylib` /
`flutter_engine.dll`) is a build-time dependency of the GDExtension, not a
runtime asset — see the `ELPIAN_WITH_FLUTTER` switch in
`../extension/CMakeLists.txt` / `SConstruct`.

> The exact `gen_snapshot` invocation and engine artifact are version-matched to
> the Flutter engine you embed; treat the commands above as the shape of the
> step, and pin versions in your CI. This app has no plugins, so no platform
> channel registration or podspec wiring is needed.
