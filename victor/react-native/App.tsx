// The Expo entry component: load the Elpian VM, boot the example guest program,
// and present its widget tree with <VictorHost/>. The VM does all the logic;
// this file only wires the platform (wasm loader + render host) together.

import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import { createRuntime, NativeVmBackend, VictorHost } from "./src/index.ts";
import type { ElpianRuntime, RnScene3dEngine } from "./src/index.ts";
import { SHOWCASE_GUEST_SOURCE } from "./src/example/showcaseSource.ts";
import { loadWasmBytes } from "./src/vm/loadWasm.ts";
import { createGodotScene3dEngine } from "./src/scene3d/GodotScene3dEngine.tsx";
import { installNative as installElpianRn } from "./modules/elpian-rn";
import { installGodot } from "./modules/elpian-godot";

export default function App(): React.ReactElement {
  const [runtime, setRuntime] = useState<ElpianRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);

  // The embedded-Godot engine, when a device build bundles it. One instance
  // drives both the guest's 3D ops (as the runtime's scene3d engine) and the
  // on-screen viewport (as <VictorHost/>'s render engine). null → Scene3D shows
  // the placeholder and the 2D app runs unchanged.
  const [engine] = useState<RnScene3dEngine | null>(() => {
    // Install the embedded-Godot JSI binding (no-op on web/Expo Go), then build
    // the engine if it's present; otherwise Scene3D keeps the placeholder.
    installGodot();
    return createGodotScene3dEngine();
  });

  useEffect(() => {
    let rt: ElpianRuntime | null = null;
    (async () => {
      try {
        // Native (Android/iOS): install + use the JSI backend (runs the VM
        // directly — no wasm). Web/Expo Go: the native module is absent, so fall
        // back to elpian_rn.wasm.
        const nativeStatus = installElpianRn();
        let wasmBytes: BufferSource | undefined;
        if (NativeVmBackend.isAvailable()) {
          wasmBytes = undefined; // native VM installed — no wasm needed
        } else if (nativeStatus.startsWith("module-not-found")) {
          wasmBytes = await loadWasmBytes(); // web / Expo Go
        } else {
          // The native module is in the binary but the VM did not install:
          // surface the exact reason instead of the generic wasm error.
          throw new Error(`native VM backend failed to install — ${nativeStatus}`);
        }
        rt = await createRuntime({
          wasmBytes,
          scene3d: engine ?? undefined,
          onLog: (line) => console.log("[guest]", line),
        });
        rt.start(SHOWCASE_GUEST_SOURCE, { lang: "js" });
        setRuntime(rt);
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => rt?.stop();
  }, [engine]);

  if (error) {
    return (
      <ScrollView contentContainerStyle={styles.center}>
        <Text style={styles.title}>Victor React Native host</Text>
        <Text style={styles.note}>
          The 2D + 3D pipeline is wired, but the Elpian VM binary is not loaded
          on this platform yet:
        </Text>
        <Text style={styles.err}>{error}</Text>
        <Text style={styles.note}>
          Build it with{"\n"}
          <Text style={styles.mono}>
            cargo build -p elpian-rn --target wasm32-unknown-unknown --release
          </Text>
          {"\n"}and serve elpian_rn.wasm (web), or install the native JSI backend.
        </Text>
      </ScrollView>
    );
  }

  if (!runtime) {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" />
        <Text style={styles.note}>Booting the Elpian VM…</Text>
      </View>
    );
  }

  return <VictorHost runtime={runtime} engine={engine ?? undefined} />;
}

const styles = StyleSheet.create({
  center: {
    flexGrow: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    gap: 12,
    backgroundColor: "#0f172a",
  },
  title: { color: "#e2e8f0", fontSize: 20, fontWeight: "700" },
  note: { color: "#94a3b8", textAlign: "center", lineHeight: 20 },
  err: { color: "#f87171", textAlign: "center" },
  mono: { fontFamily: "monospace", color: "#38bdf8" },
});
