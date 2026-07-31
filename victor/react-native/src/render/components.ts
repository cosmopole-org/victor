// The reflective component resolver — turns the framework-agnostic names in
// `rnComponents.ts` into real React Native components. This is the React Native
// analogue of the Godot bridge's ClassDB lookup: the renderer never hard-codes a
// component; it asks this registry by name, so the *entire* React Native element
// set is reachable and a new element is one metadata line, never a new `case`.
//
// Resolution rules for a spec's `rn` field:
//   "View", "Animated.View"          → indexed out of the `react-native` module
//   "@victor/<name>"                 → a Victor-implemented widget (handled by
//                                      the renderer directly; no component here)
//   "@community/<pkg>[#export]"      → an optional ecosystem package, resolved if
//                                      installed, else null (graceful fallback)
//
// Anything unavailable on the current platform (e.g. `DrawerLayoutAndroid` on
// web) resolves to a safe fallback so the tree still renders rather than
// crashing — the same "degrade gracefully" contract the 3D surface follows.

import type React from "react";
import * as RN from "react-native";

import { RN_COMPONENTS, canonicalName, type ComponentSpec } from "./rnComponents.ts";

// deno-lint-ignore no-explicit-any
type AnyComponent = React.ComponentType<any>;

// Prefer the real SafeAreaView from react-native-safe-area-context when the app
// has it (the modern Expo default); otherwise fall back to core's SafeAreaView,
// and finally to a plain View. Resolved once, defensively.
function safeAreaComponent(): AnyComponent {
  const ctx = tryRequire("react-native-safe-area-context");
  if (ctx && ctx.SafeAreaView) return ctx.SafeAreaView as AnyComponent;
  // deno-lint-ignore no-explicit-any
  const core = (RN as any).SafeAreaView;
  return (core ?? RN.View) as AnyComponent;
}

// Optional-dependency loader that never throws at bundle time for a *literal*
// module id (Metro/webpack keep the reference) but tolerates its absence.
function tryRequire(id: string): Record<string, unknown> | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const req: ((s: string) => unknown) | undefined =
      typeof require === "function"
        ? (require as unknown as (s: string) => unknown)
        : undefined;
    if (!req) return null;
    return (req(id) as Record<string, unknown>) ?? null;
  } catch {
    return null;
  }
}

// Index a dotted export path ("Animated.View") out of the react-native module.
function resolveRnPath(path: string): AnyComponent | null {
  const parts = path.split(".");
  // deno-lint-ignore no-explicit-any
  let cur: any = RN;
  for (const p of parts) {
    cur = cur?.[p];
    if (cur == null) return null;
  }
  return (cur ?? null) as AnyComponent | null;
}

// Resolve an optional community package spec: "@community/<pkg>[#export]".
function resolveCommunity(spec: string): AnyComponent | null {
  const body = spec.slice("@community/".length);
  const hash = body.lastIndexOf("#");
  const pkg = hash >= 0 ? body.slice(0, hash) : body;
  const exp = hash >= 0 ? body.slice(hash + 1) : "default";
  const mod = tryRequire(pkg);
  if (!mod) return null;
  return ((mod[exp] ?? mod.default ?? null) as AnyComponent) || null;
}

// Fallback component when a spec cannot be resolved on this platform: a plain
// View keeps containers (and their children) visible; text-like kinds use Text.
function fallbackFor(spec: ComponentSpec): AnyComponent {
  if (spec.kind === "text") return RN.Text as AnyComponent;
  return RN.View as AnyComponent;
}

// Build the concrete component for a spec. `@victor/*` entries return null on
// purpose — the renderer implements those itself (Scene3D, the ergonomic
// button, the slider fallback).
function build(spec: ComponentSpec): AnyComponent | null {
  const rn = spec.rn;
  if (rn.startsWith("@victor/")) return null;
  if (rn.startsWith("@community/")) return resolveCommunity(rn) ?? null;
  if (rn === "SafeAreaView") return safeAreaComponent();
  return resolveRnPath(rn) ?? fallbackFor(spec);
}

// The resolved registry: canonical name → component (or null for @victor/*).
const REGISTRY = new Map<string, AnyComponent | null>();
for (const name of Object.keys(RN_COMPONENTS)) {
  REGISTRY.set(name, build(RN_COMPONENTS[name]));
}

// App-supplied overrides / additions — the extension point that makes coverage
// open-ended: register any community or custom component under a class name and
// guests can `RN.create("<name>", props)` (or a prelude factory) to use it.
const OVERRIDES = new Map<string, AnyComponent>();

/**
 * Register (or replace) the React Native component used for a host class name.
 * Lets an app plug in ecosystem widgets — `@react-native-community/slider`,
 * `react-native-webview`, `react-native-maps`, a bespoke component — so the
 * renderer covers those too, not just the built-in React Native set.
 */
export function registerComponent(className: string, component: AnyComponent): void {
  OVERRIDES.set(className, component);
}

/** The component for a host class name, honoring overrides then the registry. */
export function componentFor(className: string): AnyComponent | null {
  if (OVERRIDES.has(className)) return OVERRIDES.get(className)!;
  const canon = canonicalName(className);
  if (OVERRIDES.has(canon)) return OVERRIDES.get(canon)!;
  return REGISTRY.get(canon) ?? null;
}
