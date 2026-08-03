// A sample Expo app that consumes `victor-react-native` as a library and hosts
// two Victor mini apps, driven by the object-oriented VictorMiniAppsController.
//
// Each mini app is an isolated Elpian VM (its own memory + widget tree) rendered
// into a cell; the counter and greeter can neither see nor touch each other's
// state. On web the VM runs as WebAssembly (elpian_rn.wasm, fetched below).

import React, { useEffect, useRef, useState } from "react";
import { SafeAreaView, ScrollView, StyleSheet, Text, View, Pressable } from "react-native";
import { VictorMiniApps, VictorMiniAppsController } from "victor-react-native";

import { COUNTER, GREETER } from "./miniapps/sources";

// Load the VM module bytes. The wasm is served as a static asset (public/), so a
// plain fetch works on Expo web without any bundler asset plumbing.
const loadWasm = (): Promise<ArrayBuffer> =>
  fetch("elpian_rn.wasm").then((r) => {
    if (!r.ok) throw new Error(`fetch elpian_rn.wasm: ${r.status}`);
    return r.arrayBuffer();
  });

export default function App(): React.ReactElement {
  // One controller for the app's lifetime — construct it once, drive it by hand.
  const controllerRef = useRef<VictorMiniAppsController>();
  if (!controllerRef.current) {
    controllerRef.current = new VictorMiniAppsController({
      wasm: loadWasm,
      onLog: (appId, line) => console.log(`[${appId}]`, line),
    });
  }
  const controller = controllerRef.current;

  // Re-render this outer app when the set changes, to reflect live status.
  const [, force] = useReducerForce();
  useEffect(() => controller.subscribe(force), [controller]);

  useEffect(() => {
    controller.add({ id: "counter", source: COUNTER });
    controller.add({ id: "greeter", source: GREETER });
    return () => controller.dispose();
  }, [controller]);

  const status = (id: string) => controller.get(id)?.status ?? "—";

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.h1} testID="title">
          Victor mini apps · Expo
        </Text>
        <Text style={styles.sub}>
          Two isolated Elpian VMs, one controller. counter={status("counter")} · greeter=
          {status("greeter")}
        </Text>

        <VictorMiniApps
          controller={controller}
          width="100%"
          height={520}
          layout="column"
          gap={12}
          style={styles.board}
        />

        {/* Drive lifecycle imperatively from ordinary RN controls. */}
        <View style={styles.controls}>
          <Ctl label="Restart counter" onPress={() => controller.restart("counter")} testID="restart-counter" />
          <Ctl label="Stop greeter" onPress={() => controller.stop("greeter")} testID="stop-greeter" />
          <Ctl label="Start greeter" onPress={() => controller.start("greeter")} testID="start-greeter" />
          <Ctl
            label="Swap greeter → counter"
            onPress={() => controller.replaceSource("greeter", COUNTER)}
            testID="swap-greeter"
          />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Ctl(props: { label: string; onPress: () => void; testID?: string }): React.ReactElement {
  return (
    <Pressable style={styles.btn} onPress={props.onPress} testID={props.testID}>
      <Text style={styles.btnText}>{props.label}</Text>
    </Pressable>
  );
}

// A tiny force-update hook (kept local to avoid pulling extra deps).
function useReducerForce(): [number, () => void] {
  const [n, setN] = useState(0);
  return [n, () => setN((x) => x + 1)];
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: "#020617" },
  content: { padding: 16, gap: 12 },
  h1: { color: "#e2e8f0", fontSize: 22, fontWeight: "700" },
  sub: { color: "#64748b", fontSize: 13 },
  board: { borderRadius: 12, overflow: "hidden", borderWidth: 1, borderColor: "#1e293b" },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  btn: { backgroundColor: "#1d4ed8", paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8 },
  btnText: { color: "white", fontWeight: "600", fontSize: 13 },
});
