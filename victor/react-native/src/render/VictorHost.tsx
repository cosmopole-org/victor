// <VictorHost/> — mounts a running Elpian VM's widget tree as React Native UI.
// It subscribes to the widget store and re-renders the root subtree whenever the
// VM commits a change (one commit per frame). Widget events are routed straight
// back into the VM. This is the React Native analogue of the Godot `ElpianVM`
// node: the VM owns all logic; this component only presents it.

import React, { useMemo, useSyncExternalStore } from "react";
import { StyleSheet, Text, View } from "react-native";

import type { ElpianRuntime } from "../vm/runtime.ts";
import type { RnScene3dEngine } from "../scene3d/engine.ts";
import { renderNode, type RenderContext } from "./renderNode.tsx";

export interface VictorHostProps {
  runtime: ElpianRuntime;
  engine?: RnScene3dEngine;
  /** Shown until the guest calls `RN.mount(...)`. */
  fallback?: React.ReactNode;
}

export function VictorHost(props: VictorHostProps): React.ReactElement {
  const { runtime, engine, fallback } = props;
  const store = runtime.dispatcher.store;

  // Re-render on every committed version bump.
  useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.version(),
    () => store.version(),
  );

  const root = store.root();
  const toast = store.takeToast();

  // Stable across app-level re-renders so each memoized <WidgetView/> can bail
  // out on {id, ctx} shallow-compare — the key to re-rendering only the widget
  // that actually changed rather than the whole tree.
  const ctx: RenderContext = useMemo(
    () => ({
      store,
      engine,
      fire: (id: number, event: string, arg?: unknown) =>
        runtime.fireEvent(id, event, arg),
    }),
    [store, engine, runtime],
  );

  return (
    <View style={styles.root}>
      {root ? renderNode(ctx, root.id) : fallback ?? null}
      {toast ? (
        <View style={styles.toast} pointerEvents="none">
          <Text style={styles.toastText}>{toast}</Text>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  toast: {
    position: "absolute",
    bottom: 40,
    alignSelf: "center",
    backgroundColor: "rgba(15,23,42,0.92)",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  toastText: { color: "#fff", fontSize: 14 },
});
