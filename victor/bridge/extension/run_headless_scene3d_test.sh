#!/usr/bin/env bash
# Build the Elpian GDExtension and run the headless Scene3D proof: boot the real
# ElpianVM node with a JS guest that builds a 3D scene through the godot.js/G3
# prelude, then assert real Godot 3D nodes (Node3D, MeshInstance3D, Camera3D,
# DirectionalLight3D) land in the live SceneTree. No GPU/display needed.
#
# This validates the engine side of a React Native <Scene3D/> — VM emits
# godot.op, the reflective GodotController services it against Godot's ClassDB —
# entirely headless, so it runs in CI. The on-device Android embedding of Godot
# (libgodot rendered into a native view) is a separate, device-tested seam.
#
#   ./run_headless_scene3d_test.sh          # uses/downloads Godot 4.3 stable
#   GODOT=/path/to/godot ./run_headless_scene3d_test.sh
set -euo pipefail

EXT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$EXT_DIR/../../.." && pwd)"       # …/victor (repo root)
PROJECT_DIR="$EXT_DIR/../project"
GODOT_VERSION="4.3-stable"
GODOT_CPP_BRANCH="godot-4.3-stable"

echo "==> 1/5 godot-cpp checkout"
if [ ! -d "$EXT_DIR/godot-cpp" ]; then
  git clone -b "$GODOT_CPP_BRANCH" --depth 1 \
    https://github.com/godotengine/godot-cpp "$EXT_DIR/godot-cpp"
fi

echo "==> 2/5 build the Elpian VM Rust static lib (elpian-godot-capi)"
( cd "$REPO_ROOT/victor" && cargo build -p elpian-godot-capi --release )

echo "==> 3/5 build the GDExtension (scons)"
command -v scons >/dev/null 2>&1 || pip install --quiet scons
( cd "$EXT_DIR" && scons platform=linux target=template_debug -j"$(nproc)" )

echo "==> 4/5 resolve a headless Godot binary"
GODOT="${GODOT:-}"
if [ -z "$GODOT" ]; then
  CACHE="${TMPDIR:-/tmp}/godot-$GODOT_VERSION"
  GODOT="$CACHE/Godot_v${GODOT_VERSION}_linux.x86_64"
  if [ ! -x "$GODOT" ]; then
    mkdir -p "$CACHE"
    curl -fsSL -o "$CACHE/godot.zip" \
      "https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}/Godot_v${GODOT_VERSION}_linux.x86_64.zip"
    ( cd "$CACHE" && unzip -oq godot.zip )
    chmod +x "$GODOT"
  fi
fi
echo "    using: $("$GODOT" --headless --version)"

echo "==> 5/6 import (registers the GDExtension) + run the synthetic Scene3D test"
# The first headless --import writes .godot/extension_list.cfg so the extension
# loads for a plain --script run.
( cd "$PROJECT_DIR" && timeout 120 "$GODOT" --headless --path . --import >/dev/null 2>&1 || true )
OUT="$( cd "$PROJECT_DIR" && timeout 120 "$GODOT" --headless --path . \
        --script res://headless_scene3d_test.gd 2>&1 )"
echo "$OUT"
echo "$OUT" | grep -q "HEADLESS_SCENE3D_RESULT: PASS" || {
  echo "FAIL: headless Scene3D proof did not pass." >&2
  exit 1
}
echo "OK: Godot serviced the 3D op protocol and built a real Scene3D."

echo "==> 6/6 capture the REAL showcase 3D op stream and replay it into Godot"
# Phase A: run the shipped assets/guest/showcase.js on the real Elpian VM and
# dump the exact godot.op stream its RN.Scene3D emits.
( cd "$REPO_ROOT/victor" && cargo run -q -p elpian-rn --example capture_godot_ops ) \
  > "$PROJECT_DIR/showcase_ops.json"
# Phase B: replay that real stream through the reflective controller and assert
# the app's actual 3D scene is built.
REPLAY="$( cd "$PROJECT_DIR" && timeout 120 "$GODOT" --headless --path . \
           --script res://headless_replay_showcase3d.gd 2>&1 )"
echo "$REPLAY"
if echo "$REPLAY" | grep -q "HEADLESS_REPLAY_RESULT: PASS"; then
  echo "OK: the showcase app's real godot.op stream built a live Godot 3D scene."
  exit 0
fi
echo "FAIL: showcase 3D replay proof did not pass." >&2
exit 1
