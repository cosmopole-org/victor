// <VictorMiniApps/> — a sized view that hosts a set of Elpian mini apps.
//
// Two ways to drive it:
//
//  1. Declarative — hand it a list of mini apps. Apps are reconciled by `id`:
//     adding one boots a VM, removing one frees that VM, changing a program's
//     source restarts just that mini app — the rest keep running untouched.
//
//       <VictorMiniApps
//         width="100%" height={480}
//         wasm={loadWasmBytes}                       // or engine={preloadedEngine}
//         layout="grid" columns={2} gap={8}
//         apps={[
//           { id: "clock",   source: clockElpianJs },
//           { id: "counter", source: counterElpianJs },
//         ]}
//         onLog={(appId, line) => console.log(appId, line)}
//       />
//
//  2. Imperative (object-oriented) — construct a VictorMiniAppsController, hold
//     onto it, and add/remove/update/start/stop mini apps through method calls;
//     the component just renders whatever the controller currently holds:
//
//       const controller = new VictorMiniAppsController({ wasm: loadWasmBytes });
//       controller.add({ id: "clock", source: clockElpianJs });
//       …
//       <VictorMiniApps controller={controller} width="100%" height={480} />
//
// Both paths share one implementation: the declarative form builds an internal
// controller and reconciles it from `apps`. The VM does all app-code execution
// (no JIT). Each mini app is isolated: a separate VM tree + separate widget
// store, so one mini app can neither see nor touch another's widgets — the
// multi-VM guarantee, host-driven.

import React from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { VictorEngine } from "./engine.ts";
import { VictorMiniAppsController } from "./controller.ts";
import { VictorHost } from "../render/VictorHost.tsx";
import type { RnScene3dEngine } from "../scene3d/engine.ts";

/** One mini app: an id (identity for reconciliation) + its Elpian program. */
export interface MiniAppDef {
  /** Stable identity. Changing `source` for the same id restarts that mini app. */
  id: string;
  /** The mini app's program — Elpian-based JavaScript (compiled by js2elpian). */
  source: string;
  /** Guest language; defaults to "js". */
  lang?: "js" | "dart";
  /** Cell sizing hints (see `layout`). */
  flex?: number;
  width?: number;
  height?: number;
}

export type MiniAppsLayout = "column" | "row" | "grid" | "stack";

export interface VictorMiniAppsProps {
  /**
   * Imperative controller. When set, the component renders whatever the
   * controller holds and ignores `apps`/`engine`/`wasm` (they live on the
   * controller). The caller owns the controller's lifecycle — the component
   * does not dispose a controller it did not create.
   */
  controller?: VictorMiniAppsController;

  /**
   * Declarative mini-app set. Reconciled by `id` on every change. Ignored when
   * `controller` is set. Required unless a `controller` is provided.
   */
  apps?: MiniAppDef[];
  /** A preloaded engine, OR `wasm` to load one internally. */
  engine?: VictorEngine;
  /** `elpian_rn.wasm` bytes, or a loader returning them. Ignored if `engine` set. */
  wasm?: BufferSource | (() => Promise<BufferSource>);

  /** Overall size of the host view. */
  width?: number | string;
  height?: number | string;

  /** How cells are arranged. Default "column". */
  layout?: MiniAppsLayout;
  /** Columns for `layout="grid"`. Default 2. */
  columns?: number;
  /** Space between cells (px). Default 0. */
  gap?: number;

  /** Optional embedded-Godot engine for any `Scene3D` a mini app builds. */
  scene3dEngine?: RnScene3dEngine;

  /** Per-mini-app log sink. */
  onLog?: (appId: string, line: string) => void;
  /**
   * Host-side service for guest `askHost("host.call", …)`, scoped per mini app.
   * The seam a tool frontend uses to reach the embedding app (e.g. sign a Caspar
   * request with the user's identity). Ignored when a `controller` is supplied
   * (set it on the controller instead).
   */
  onHostCall?: (appId: string, method: string, payload: unknown) => Promise<unknown> | unknown;
  /** Called if the shared VM module fails to load. */
  onError?: (error: unknown) => void;

  /** Shown while the wasm module loads. */
  fallback?: React.ReactNode;

  style?: object;
}

/** A content signature so reconciliation runs on real changes, not every render. */
function signature(apps: MiniAppDef[]): string {
  return JSON.stringify(apps.map((a) => [a.id, a.source, a.lang ?? "js"]));
}

/**
 * Resolve the controller to render from: the caller's own (external) or an
 * internal one built from the declarative props. For the declarative path the
 * internal controller is created once and reconciled from `apps` on change, and
 * disposed on unmount; an external controller is left untouched (the caller
 * owns it).
 */
function useResolvedController(props: VictorMiniAppsProps): VictorMiniAppsController {
  const { controller, apps, engine, wasm, scene3dEngine, onLog, onHostCall, onError } = props;

  // Keep callbacks reachable without recreating the internal controller.
  const onLogRef = React.useRef(onLog);
  onLogRef.current = onLog;
  const onHostCallRef = React.useRef(onHostCall);
  onHostCallRef.current = onHostCall;
  const onErrorRef = React.useRef(onError);
  onErrorRef.current = onError;

  // One internal controller for this component's whole lifetime (declarative
  // path only). Built lazily and never rebuilt — engine/wasm are read once, the
  // same as a preloaded engine would be.
  const internalRef = React.useRef<VictorMiniAppsController | null>(null);
  if (!controller && internalRef.current === null) {
    internalRef.current = new VictorMiniAppsController({
      engine,
      wasm,
      scene3dEngine,
      onLog: (id, line) => onLogRef.current?.(id, line),
      onHostCall: (id, method, payload) => onHostCallRef.current?.(id, method, payload),
      onError: (e) => onErrorRef.current?.(e),
    });
  }
  const active = controller ?? internalRef.current!;

  // Declarative reconciliation: push `apps` into the internal controller.
  const sig = apps ? signature(apps) : "";
  React.useEffect(() => {
    if (controller) return; // caller drives an external controller directly
    internalRef.current!.setApps(apps ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, sig]);

  // Dispose only the controller we created.
  React.useEffect(() => {
    return () => {
      if (!controller) internalRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return active;
}

/** Re-render whenever the controller's set changes (version bump). */
function useControllerSnapshot(controller: VictorMiniAppsController): number {
  return React.useSyncExternalStore(
    React.useCallback((cb) => controller.subscribe(cb), [controller]),
    () => controller.version,
    () => controller.version,
  );
}

export function VictorMiniApps(props: VictorMiniAppsProps): React.ReactElement {
  const {
    width = "100%",
    height,
    layout = "column",
    columns = 2,
    gap = 0,
    scene3dEngine,
    fallback,
    style,
  } = props;

  const controller = useResolvedController(props);
  useControllerSnapshot(controller); // subscribe → re-render on any change
  const cells = controller.list();
  const engineReady = controller.isReady();
  const surface3d = scene3dEngine ?? controller.scene3dEngine;

  const container: object = {
    width: width as number,
    height: height as number,
    flexDirection: layout === "row" || layout === "grid" ? "row" : "column",
    flexWrap: layout === "grid" ? "wrap" : "nowrap",
  };

  if (!engineReady && cells.length === 0) {
    return (
      <View style={[styles.container, container, style, styles.center]}>
        {fallback ?? <ActivityIndicator />}
      </View>
    );
  }

  return (
    <View style={[styles.container, container, style]}>
      {cells.map(({ def, runtime }) => (
        <View key={def.id} style={cellStyle(def, layout, columns, gap)}>
          {runtime ? <VictorHost runtime={runtime} engine={surface3d} /> : null}
        </View>
      ))}
    </View>
  );
}

// Per-cell sizing: explicit width/height win; otherwise grid splits by columns
// and column/row/stack share space via flex. `stack` overlaps all cells.
function cellStyle(
  def: MiniAppDef,
  layout: MiniAppsLayout,
  columns: number,
  gap: number,
): object {
  const pad = gap > 0 ? { padding: gap / 2 } : {};
  if (layout === "stack") {
    return { ...StyleSheet.absoluteFillObject, ...pad };
  }
  if (layout === "grid") {
    return {
      width: `${100 / Math.max(1, columns)}%`,
      height: def.height ?? 200,
      ...pad,
    };
  }
  // column / row
  const base: Record<string, unknown> = { ...pad };
  if (def.width !== undefined) base.width = def.width;
  if (def.height !== undefined) base.height = def.height;
  if (def.width === undefined && def.height === undefined) {
    base.flex = def.flex ?? 1;
  } else if (def.flex !== undefined) {
    base.flex = def.flex;
  }
  return base;
}

const styles = StyleSheet.create({
  container: { overflow: "hidden" },
  center: { alignItems: "center", justifyContent: "center" },
});
