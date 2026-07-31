// <Scene3dSurface/> — how Godot appears as a widget inside the React Native
// tree. When a platform Godot engine is supplied it draws the live 3D viewport
// bound to this surface; otherwise it degrades to a labelled placeholder so a
// 2D app still runs everywhere (the same "degrade gracefully" contract the
// Flutter bridge follows). All 3D content is still driven by the VM through the
// ordinary `godot.op` seam — this component only presents the pixels.

import React from "react";
import { StyleSheet, Text, View } from "react-native";

import type { RnScene3dEngine } from "./engine.ts";

export interface Scene3dSurfaceProps {
  surfaceId: number;
  style?: unknown;
  engine?: RnScene3dEngine;
}

export function Scene3dSurface(props: Scene3dSurfaceProps): React.ReactElement {
  const { surfaceId, style, engine } = props;

  if (engine) {
    return (
      <View style={[styles.base, style as object]}>
        {engine.renderSurface(surfaceId, styles.fill)}
      </View>
    );
  }

  return (
    <View style={[styles.base, styles.placeholder, style as object]}>
      <Text style={styles.label}>3D Scene (Godot engine not loaded)</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: { minHeight: 160, overflow: "hidden", borderRadius: 8 },
  fill: { flex: 1 },
  placeholder: {
    backgroundColor: "#0b1220",
    alignItems: "center",
    justifyContent: "center",
  },
  label: { color: "#64748b", fontSize: 12 },
});
