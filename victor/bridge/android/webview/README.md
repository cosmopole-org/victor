# ElpianWebView — the Android surface for `VUI.webview`

A Godot 4 **Android plugin (v2)** that overlays the **OS-native Android
System WebView** (Chromium) on top of the Godot activity, so Elpian guests
can open web content in-app — video-conference rooms (BigBlueButton),
OAuth flows, docs — **without bundling a browser engine** (the AAR is a few
KB; the webview is the one Android already ships).

```text
src/main/java/org/cosmopole/elpian/webview/ElpianWebView.java
    the plugin: open(url, title) / close() / isOpen(), `webview_closed` signal
src/main/AndroidManifest.xml
    camera/mic permissions + the plugin.v2 registration meta-data
```

The overlay is native UI: a slim dark title bar (title · OPEN IN BROWSER ·
CLOSE) above a full-bleed WebView configured for WebRTC conferences
(JavaScript, DOM storage, media autoplay). Camera/microphone reach the page
through `WebChromeClient.onPermissionRequest`, granted only for capture
resources the app itself holds; `open()` requests missing runtime
permissions on first use. Screen capture is not available in Android
WebView.

## Build & wire-up

```bash
gradle -p victor/bridge/android/webview assembleRelease
cp victor/bridge/android/webview/build/outputs/aar/webview-release.aar \
   victor/bridge/project/addons/elpian_webview_android/bin/ElpianWebView.release.aar
```

The `res://addons/elpian_webview_android` editor plugin injects the AAR into
Android gradle exports (`_get_android_libraries`); `.github/workflows/
android-apk.yml` runs both steps in CI. Guests never talk to the plugin
directly — `VUI.webview` (ui.js) probes `Engine.has_singleton("ElpianWebView")`
and prefers it automatically on Android.
