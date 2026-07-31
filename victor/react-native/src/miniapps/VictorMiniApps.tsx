// <VictorMiniApps/> — a sized view that hosts a set of Elpian mini apps.
//
// Give it a width/height and a list of mini apps, each with its Elpian-based JS
// program; Victor runs every one as its own sandboxed VM inside a single shared
// wasm instance and renders its React Native widget tree into a cell. Apps are
// reconciled by `id`: adding one boots a VM, removing one frees that VM,
// changing a program's source restarts just that mini app — the rest keep
// running untouched.
//
//   <VictorMiniApps
//     width="100%" height={480}
//     wasm={loadWasmBytes}                       // or engine={preloadedEngine}
//     layout="grid" columns={2} gap={8}
//     apps={[
//       { id: "clock",   source: clockElpianJs },
//       { id: "counter", source: counterElpianJs },
//     ]}
//     onLog={(appId, line) => console.log(appId, line)}
//   />
//
// The VM does all app-code execution (no JIT). Each mini app is isolated: a
// separate VM tree + separate widget store, so one mini app can neither see nor
// touch another's widgets — the multi-VM guarantee, host-driven.

import React from "react";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { VictorEngine } from "./engine.ts";
import { VictorHost } from "../render/VictorHost.tsx";
import type { ElpianRuntime } from "../vm/runtime.ts";
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
  apps: MiniAppDef[];
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
  /** Called if the shared VM module fails to load. */
  onError?: (error: unknown) => void;

  /** Shown while the wasm module loads. */
  fallback?: React.ReactNode;

  style?: object;
}

// A live mini app: its runtime + the source/lang it was booted with (so we know
// when a redefinition means "restart this one").
interface Instance {
  runtime: ElpianRuntime;
  source: string;
  lang: string;
}

/** Load (or accept) the shared engine. */
function useEngine(
  provided: VictorEngine | undefined,
  wasm: VictorMiniAppsProps["wasm"],
  onError?: (e: unknown) => void,
): VictorEngine | null {
  const [engine, setEngine] = React.useState<VictorEngine | null>(provided ?? null);
  React.useEffect(() => {
    if (provided) {
      setEngine(provided);
      return;
    }
    if (!wasm) return;
    let alive = true;
    (async () => {
      try {
        const bytes = typeof wasm === "function" ? await wasm() : wasm;
        const e = await VictorEngine.load(bytes);
        if (alive) setEngine(e);
      } catch (e) {
        if (onError) onError(e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [provided, wasm, onError]);
  return engine;
}

/** A content signature so reconciliation runs on real changes, not every render. */
function signature(apps: MiniAppDef[]): string {
  return JSON.stringify(apps.map((a) => [a.id, a.source, a.lang ?? "js"]));
}

/**
 * Reconcile the running mini apps against `apps`: boot new ones, free removed
 * ones, restart redefined ones. Returns each app's runtime (or null until it
 * boots) in `apps` order.
 */
function useMiniApps(
  engine: VictorEngine | null,
  apps: MiniAppDef[],
  onLog?: (appId: string, line: string) => void,
): Array<{ def: MiniAppDef; runtime: ElpianRuntime | null }> {
  const instances = React.useRef(new Map<string, Instance>());
  const [, force] = React.useReducer((n: number) => n + 1, 0);
  const sig = signature(apps);
  // Keep the latest onLog reachable without making it a reconciliation trigger.
  const onLogRef = React.useRef(onLog);
  onLogRef.current = onLog;

  React.useEffect(() => {
    if (!engine) return;
    const map = instances.current;
    const desired = new Map(apps.map((a) => [a.id, a]));
    let changed = false;

    // Remove or restart: drop instances that vanished or whose program changed.
    for (const [id, inst] of [...map]) {
      const d = desired.get(id);
      if (!d || d.source !== inst.source || (d.lang ?? "js") !== inst.lang) {
        inst.runtime.stop();
        map.delete(id);
        changed = true;
      }
    }

    // Add: boot any desired app without a live instance.
    for (const a of apps) {
      if (map.has(a.id)) continue;
      const lang = a.lang ?? "js";
      const runtime = engine.createRuntime({
        lang,
        onLog: (line) => onLogRef.current?.(a.id, line),
      });
      try {
        runtime.start(a.source, { lang });
      } catch (e) {
        onLogRef.current?.(a.id, "[error] " + String(e));
      }
      map.set(a.id, { runtime, source: a.source, lang });
      changed = true;
    }

    if (changed) force();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, sig]);

  // Free every mini app's VM on unmount.
  React.useEffect(() => {
    const map = instances.current;
    return () => {
      for (const inst of map.values()) inst.runtime.stop();
      map.clear();
    };
  }, []);

  return apps.map((def) => ({ def, runtime: instances.current.get(def.id)?.runtime ?? null }));
}

export function VictorMiniApps(props: VictorMiniAppsProps): React.ReactElement {
  const {
    apps,
    engine: providedEngine,
    wasm,
    width = "100%",
    height,
    layout = "column",
    columns = 2,
    gap = 0,
    scene3dEngine,
    onLog,
    onError,
    fallback,
    style,
  } = props;

  const engine = useEngine(providedEngine, wasm, onError);
  const cells = useMiniApps(engine, apps, onLog);

  const container: object = {
    width: width as number,
    height: height as number,
    flexDirection: layout === "row" || layout === "grid" ? "row" : "column",
    flexWrap: layout === "grid" ? "wrap" : "nowrap",
  };

  if (!engine) {
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
          {runtime ? <VictorHost runtime={runtime} engine={scene3dEngine} /> : null}
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
