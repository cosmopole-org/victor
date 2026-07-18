#!/usr/bin/env bash
# Fetch the godot_wry GDExtension (https://github.com/doceazedo/godot_wry) into
# the Godot project's addons folder, giving DESKTOP exports the OS-native
# webview Control that VUI.webview prefers over the system browser:
#
#   Windows  ->  WebView2          macOS  ->  WKWebView
#   Linux    ->  WebKitGTK (X11)
#
# godot_wry wraps the webview the OS already ships (via the WRY library), so
# it adds only a few MB of glue per platform — no embedded browser engine.
# The addon is a build-time dependency and is NOT committed (see .gitignore);
# run this before making a desktop export. Web/Android exports don't need it:
# VUI.webview uses the DOM iframe / the ElpianWebView Android plugin there.
#
# Usage:
#   bridge/tools/fetch-godot-wry.sh [VERSION]     # default: v1.0.2
#
# WebRTC notes for conference pages (BigBlueButton etc.):
#   * Windows/WebView2 and macOS/WKWebView support getUserMedia (macOS exports
#     additionally need the camera/microphone usage descriptions and, when
#     sandboxed, the corresponding entitlements in the export preset).
#   * Linux/WebKitGTK WebRTC support varies by distro build — VUI.webview's
#     "Open in browser" button in the title bar is the escape hatch.
set -euo pipefail

VERSION="${1:-v1.0.2}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADDONS_DIR="$SCRIPT_DIR/../project/addons"
API="https://api.github.com/repos/doceazedo/godot_wry/releases/tags/$VERSION"

command -v curl >/dev/null || { echo "curl is required" >&2; exit 1; }
command -v unzip >/dev/null || { echo "unzip is required" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

echo "[fetch-godot-wry] resolving release $VERSION"
ZIP_URL="$(curl -sSL "$API" | python3 -c '
import json, sys
release = json.load(sys.stdin)
for asset in release.get("assets", []):
    name = asset.get("name", "")
    if name.endswith(".zip") and "source" not in name.lower():
        print(asset["browser_download_url"])
        break
')"
[ -n "$ZIP_URL" ] || { echo "no release ZIP asset found for $VERSION" >&2; exit 1; }

TMP_ZIP="$(mktemp "${TMPDIR:-/tmp}/godot-wry.XXXXXX.zip")"
trap 'rm -f "$TMP_ZIP"' EXIT
echo "[fetch-godot-wry] downloading $ZIP_URL"
curl -sSL -o "$TMP_ZIP" "$ZIP_URL"

mkdir -p "$ADDONS_DIR"
rm -rf "$ADDONS_DIR/godot_wry"
# Release zips contain the addons/ tree (addons/godot_wry/…); tolerate zips
# rooted at godot_wry/ too.
unzip -o -q "$TMP_ZIP" -d "$ADDONS_DIR/.godot-wry-tmp"
if [ -d "$ADDONS_DIR/.godot-wry-tmp/addons/godot_wry" ]; then
  mv "$ADDONS_DIR/.godot-wry-tmp/addons/godot_wry" "$ADDONS_DIR/godot_wry"
elif [ -d "$ADDONS_DIR/.godot-wry-tmp/godot_wry" ]; then
  mv "$ADDONS_DIR/.godot-wry-tmp/godot_wry" "$ADDONS_DIR/godot_wry"
else
  echo "unexpected zip layout (no addons/godot_wry):" >&2
  find "$ADDONS_DIR/.godot-wry-tmp" -maxdepth 2 >&2
  rm -rf "$ADDONS_DIR/.godot-wry-tmp"
  exit 1
fi
rm -rf "$ADDONS_DIR/.godot-wry-tmp"

echo "[fetch-godot-wry] installed:"
find "$ADDONS_DIR/godot_wry" -maxdepth 2 -name '*.gdextension' -o -maxdepth 2 -type d | sed "s|$ADDONS_DIR/|  addons/|"
echo "[fetch-godot-wry] done — desktop exports now register the WebView class VUI.webview probes for."
