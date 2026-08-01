// The native embedded-Godot engine for React Native: services 3D ops through
// the Godot binding (via GodotScene3dEngineCore) and draws each Scene3D surface
// as the native Godot viewport view. This is the device implementation of
// `RnScene3dEngine` — the analogue of the WebGodot canvas engine on web.
//
// The viewport view is a native component the Godot module registers under
// `binding.viewName`; it renders a libgodot SubViewport bound to `surfaceId`.
// Until that view is present (op seam shipped before the view, or a build
// without the Godot library) surfaces fall back to a labeled placeholder, so a
// partial install degrades gracefully instead of crashing.

import React from "react";
import { requireNativeComponent, StyleSheet, Text, View } from "react-native";

import type { RnScene3dEngine } from "./engine.ts";
import { getElpianGodotNative, type ElpianGodotNative } from "./godotBinding.ts";
import { GodotScene3dEngineCore } from "./godotEngineCore.ts";

/** Native view components, cached per registered name (RN requires a stable ref). */
const nativeViewCache = new Map<string, React.ComponentType<{ surfaceId: number; style?: unknown }>>();

function nativeViewFor(name: string): React.ComponentType<{ surfaceId: number; style?: unknown }> | null {
  const cached = nativeViewCache.get(name);
  if (cached) return cached;
  try {
    const comp = requireNativeComponent(name) as React.ComponentType<{
      surfaceId: number;
      style?: unknown;
    }>;
    nativeViewCache.set(name, comp);
    return comp;
  } catch {
    return null; // not registered in this binary — caller shows the placeholder
  }
}

export class GodotScene3dEngine extends GodotScene3dEngineCore implements RnScene3dEngine {
  renderSurface(surfaceId: number, style: unknown): React.ReactNode {
    const name = this.native.viewName;
    const NativeView = name ? nativeViewFor(name) : null;
    if (NativeView) {
      return <NativeView surfaceId={surfaceId} style={style} />;
    }
    return (
      <View style={[styles.placeholder, style as object]}>
        <Text style={styles.label}>3D Scene (Godot view not installed)</Text>
      </View>
    );
  }
}

/**
 * Build the native Godot engine when its binding is installed, else `null` so
 * the runtime keeps the `MockScene3dEngine` (Scene3D shows a placeholder). Lets
 * `App`/host code opt into real 3D only on a device build that bundles Godot.
 */
export function createGodotScene3dEngine(): GodotScene3dEngine | null {
  const native: ElpianGodotNative | null = getElpianGodotNative();
  return native ? new GodotScene3dEngine(native) : null;
}

const styles = StyleSheet.create({
  placeholder: {
    minHeight: 160,
    borderRadius: 8,
    backgroundColor: "#0b1220",
    alignItems: "center",
    justifyContent: "center",
  },
  label: { color: "#64748b", fontSize: 12 },
});
