#!/usr/bin/env bash
# Build the REAL tools registry creatures (decillionai-server) as reactor wasm so
# the integration test can run them under a fake Caspar hostCall shim. Skips
# (exit 0) when the sibling repo or Go toolchain is missing.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
server="${DECILLION_SERVER_DIR:-$here/../../../../../decillionai-server}"
out="$here/artifacts"
mkdir -p "$out"
if ! command -v go >/dev/null 2>&1; then echo "skip: no go toolchain"; exit 0; fi
if [ ! -d "$server/creatures/tools" ]; then echo "skip: no decillionai-server at $server"; exit 0; fi
for m in listCommands registerCommands; do
  src="$server/creatures/tools/$m/main.go"
  [ -f "$src" ] || { echo "skip: $src missing"; continue; }
  tmp="$(mktemp -d)"
  cp "$src" "$tmp/main.go"
  cp "$here/harness_export.go" "$tmp/harness_export.go"
  printf 'module creaturewasm\n\ngo 1.24\n' > "$tmp/go.mod"
  ( cd "$tmp" && GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -o "$out/$m.reactor.wasm" . )
  rm -rf "$tmp"
  echo "built $out/$m.reactor.wasm"
done
