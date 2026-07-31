// The Expo entry component: load the Elpian VM, boot the example guest program,
// and present its widget tree with <VictorHost/>. The VM does all the logic;
// this file only wires the platform (wasm loader + render host) together.

import React, { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";

import { createWasmRuntime, VictorHost } from "./src/index.ts";
import type { ElpianRuntime } from "./src/index.ts";
import { SHOWCASE_GUEST_SOURCE } from "./src/example/showcaseSource.ts";
import { loadWasmBytes } from "./src/vm/loadWasm.ts";

export default function App(): React.ReactElement {
  const [runtime, setRuntime] = useState<ElpianRuntime | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let rt: ElpianRuntime | null = null;
    (async () => {
      try {
        const bytes = await loadWasmBytes();
        rt = await createWasmRuntime(bytes, {
          onLog: (line) => console.log("[guest]", line),
        });
        rt.start(SHOWCASE_GUEST_SOURCE, { lang: "js" });
        setRuntime(rt);
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => rt?.stop();
  }, []);

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

  return <VictorHost runtime={runtime} />;
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
