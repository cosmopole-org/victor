// The widget renderer — turns a retained `WidgetNode` (built by the VM over
// `rn.op`) into a real React Native element. This is the inverse of the Godot
// host: instead of `Control` nodes, the guest's 2D tree becomes genuine RN
// components, so a Victor app is a first-class React Native view on mobile,
// desktop and web while keeping Godot for 3D via `<Scene3dSurface/>`.
//
// TWO PROPERTIES THIS FILE GUARANTEES
//
// 1. COMPLETE COVERAGE — every React Native element, by construction. There is
//    no per-component `switch`: `componentFor(className)` resolves the class
//    reflectively out of the full `react-native` surface (`rnComponents.ts` +
//    `components.ts`), and a small `kind` decides how children / text / media /
//    list-data are wired. Adding an element is a metadata line, not a code
//    path, so the renderer can never fall behind the component set.
//
// 2. TARGETED PATCHING — a change re-renders one widget, not the page. Each
//    widget is its own `React.memo`'d `<WidgetView/>` that subscribes (via
//    `useSyncExternalStore`) to just its node's revision in the store. When the
//    VM patches one prop, only that node's revision bumps, so only that one
//    component re-renders; its children are stable memoized elements that React
//    bails out of. A child-list edit bumps only the parent, which re-renders
//    its child slots while every unaffected subtree is reused untouched.

import React from "react";

import type { WidgetStore, WidgetNode } from "../core/widgetStore.ts";
import type { Wire } from "../core/protocol.ts";
import { toStyle, STYLE_KEYS } from "./style.ts";
import { Scene3dSurface } from "../scene3d/Scene3dSurface.tsx";
import type { RnScene3dEngine } from "../scene3d/engine.ts";
import { componentFor } from "./components.ts";
import { specFor, canonicalName, type WidgetKind } from "./rnComponents.ts";

export interface RenderContext {
  store: WidgetStore;
  /** Fire a widget event back into the VM. */
  fire: (widgetId: number, event: string, arg?: Wire) => void;
  /** Optional platform Godot engine that draws Scene3D surfaces. */
  engine?: RnScene3dEngine;
}

/**
 * Render the node `id` as a memoized `<WidgetView/>`. Returned to `<VictorHost/>`
 * for the root and used recursively for every child, so each widget owns its own
 * subscription and re-renders independently.
 */
export function renderNode(ctx: RenderContext, id: number): React.ReactNode {
  return <WidgetView key={id} id={id} ctx={ctx} />;
}

interface WidgetViewProps {
  id: number;
  ctx: RenderContext;
}

// One widget = one memoized component subscribed to just its own node revision.
// `ctx` is stable (memoized by the host), so `React.memo`'s shallow compare on
// {id, ctx} lets an unchanged widget bail out even when its parent re-renders.
export const WidgetView = React.memo(function WidgetView(
  props: WidgetViewProps,
): React.ReactElement | null {
  const { id, ctx } = props;
  const store = ctx.store;
  const subscribe = React.useCallback(
    (cb: () => void) => store.subscribeNode(id, cb),
    [store, id],
  );
  const snapshot = React.useCallback(() => store.nodeVersion(id), [store, id]);
  React.useSyncExternalStore(subscribe, snapshot, snapshot);

  const node = store.get(id);
  if (!node) return null;
  return renderWidget(ctx, node);
});

// ---------------------------------------------------------------------------
// element construction
// ---------------------------------------------------------------------------

function renderWidget(ctx: RenderContext, node: WidgetNode): React.ReactElement | null {
  const spec = specFor(node.className);
  const kind: WidgetKind = spec?.kind ?? "view";

  // Victor-specific: the embedded Godot 3D surface.
  if (kind === "scene3d") {
    return (
      <Scene3dSurface
        surfaceId={node.id}
        style={toStyle(node.props) as object}
        engine={ctx.engine}
      />
    );
  }

  const Component = componentFor(node.className) ?? componentFor("View")!;
  const p = buildProps(ctx, node);
  const children = () => node.children.map((cid) => renderNode(ctx, cid));

  switch (kind) {
    case "text": {
      const content = node.props.text != null ? String(node.props.text) : null;
      return (
        <Component {...p}>
          {content}
          {children()}
        </Component>
      );
    }

    case "image":
      return <Component {...p} source={mediaSource(node.props)} />;

    case "imageBackground":
      return (
        <Component {...p} source={mediaSource(node.props)}>
          {children()}
        </Component>
      );

    case "input":
      return <Component {...inputProps(p, node.props)} />;

    case "switch":
      return <Component {...p} value={node.props.value === true} />;

    case "activity":
      return <Component {...p} />;

    case "status":
      // StatusBar takes no children and no style.
      return <Component {...stripStyle(p)} />;

    case "refresh":
      return <Component {...p} refreshing={node.props.refreshing === true} />;

    case "slider":
      return renderSlider(node, p);

    case "button":
      // The raw RN <Button/>: title + onPress, no children.
      return (
        <Component
          {...p}
          title={String(node.props.title ?? node.props.text ?? "")}
        />
      );

    case "victorButton":
      return renderVictorButton(node, p, children());

    case "scroll":
      return (
        <Component {...scrollProps(p)}>{children()}</Component>
      );

    case "list":
      return <Component {...listProps(ctx, node, p)} />;

    case "view":
    default:
      return <Component {...p}>{children()}</Component>;
  }
}

// ---------------------------------------------------------------------------
// generic prop assembly
// ---------------------------------------------------------------------------

type Props = Record<string, unknown>;

// Reserved keys the renderer consumes itself (never forwarded verbatim).
const RESERVED = new Set<string>([
  ...STYLE_KEYS,
  "text",
  "title",
  "children",
  "direction",
  "src",
  "source",
  "refreshing",
]);

// Build the props for a component: pass through every real React Native prop the
// guest set by name, translate the convenience/style keys into a `style` object,
// and reconstruct each connected event as its `on<Event>` handler — so ANY React
// Native prop and ANY event work, not a curated few.
function buildProps(ctx: RenderContext, node: WidgetNode): Props {
  const out: Props = {};
  for (const key of Object.keys(node.props)) {
    if (RESERVED.has(key)) continue;
    out[key] = node.props[key];
  }
  const style = toStyle(node.props);
  if (Object.keys(style).length) out.style = style;

  for (const event of Object.keys(node.events)) {
    out[eventProp(event)] = (native: unknown) =>
      ctx.fire(node.id, event, safeArg(native));
  }
  return out;
}

function eventProp(event: string): string {
  return "on" + event.slice(0, 1).toUpperCase() + event.slice(1);
}

// Make a native RN event argument JSON-safe to cross back into the VM: scalars
// pass through; a synthetic event contributes the scalar fields of its
// `nativeEvent`; anything else becomes null.
function safeArg(v: unknown): Wire {
  if (v == null) return null;
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return v as Wire;
  if (t === "object") {
    const src = ((v as Record<string, unknown>).nativeEvent ?? v) as Record<string, unknown>;
    const out: Record<string, Wire> = {};
    for (const k of Object.keys(src)) {
      const val = src[k];
      const vt = typeof val;
      if (val == null || vt === "string" || vt === "number" || vt === "boolean") {
        out[k] = val as Wire;
      }
    }
    return out;
  }
  return null;
}

function stripStyle(p: Props): Props {
  if (!("style" in p)) return p;
  const { style: _drop, ...rest } = p;
  return rest;
}

function mediaSource(props: Record<string, Wire>): { uri: string } | number | Wire {
  const s = props.src ?? props.source;
  if (typeof s === "number") return s; // a bundler asset id (require())
  return { uri: String(s ?? "") };
}

// TextInput wants a string value/defaultValue; keep the friendly `secure` alias.
function inputProps(p: Props, raw: Record<string, Wire>): Props {
  const out: Props = { ...p };
  if (raw.value !== undefined && raw.value !== null) out.value = String(raw.value);
  if (raw.defaultValue !== undefined && raw.defaultValue !== null) {
    out.defaultValue = String(raw.defaultValue);
  }
  if (raw.secure === true && out.secureTextEntry === undefined) {
    out.secureTextEntry = true;
  }
  return out;
}

// ScrollView pull-to-refresh: an `onRefresh` handler becomes a <RefreshControl/>
// (FlatList/SectionList accept onRefresh/refreshing directly, so they skip this).
function scrollProps(p: Props): Props {
  if (typeof p.onRefresh !== "function") return p;
  const { onRefresh, refreshing, ...rest } = p as Props & { onRefresh: () => void };
  const Refresh = componentFor("RefreshControl");
  if (!Refresh) return rest;
  return {
    ...rest,
    refreshControl: React.createElement(Refresh, {
      refreshing: refreshing === true,
      onRefresh,
    }),
  };
}

// Virtualized lists render the node's retained children as their data set, so a
// guest builds a list by adding children exactly like any other container.
function listProps(ctx: RenderContext, node: WidgetNode, p: Props): Props {
  const data = node.children;
  const keyExtractor = (item: number) => String(item);
  const renderItem = (info: { item: number }) => renderNode(ctx, info.item);
  const canon = canonicalName(node.className);

  if (canon === "SectionList" || canon === "VirtualizedSectionList" ||
      canon === "Animated.SectionList") {
    return {
      ...p,
      sections: [{ data }],
      keyExtractor,
      renderItem,
    };
  }
  if (canon === "VirtualizedList") {
    return {
      ...p,
      data,
      getItem: (d: number[], i: number) => d[i],
      getItemCount: (d: number[]) => d.length,
      keyExtractor,
      renderItem,
    };
  }
  // FlatList / Animated.FlatList
  return { ...p, data, keyExtractor, renderItem };
}

// The ergonomic Victor button (a styled Pressable) — nicer defaults than the
// bare RN <Button/>, with a text label and optional children.
function renderVictorButton(
  node: WidgetNode,
  p: Props,
  children: React.ReactNode,
): React.ReactElement {
  const Pressable = componentFor("Pressable")!;
  const Text = componentFor("Text")!;
  const label = String(node.props.title ?? node.props.text ?? "");
  const bg = (node.props.bg as string) ?? "#2563eb";
  const color = (node.props.color as string) ?? "#fff";
  const { onPress, style } = p as Props & { onPress?: () => void };
  return (
    <Pressable
      onPress={onPress}
      disabled={node.props.disabled === true}
      style={({ pressed }: { pressed: boolean }) => [
        {
          paddingVertical: 10,
          paddingHorizontal: 16,
          borderRadius: 8,
          backgroundColor: bg,
          opacity: pressed ? 0.8 : 1,
          alignItems: "center",
        },
        style,
      ]}
    >
      {label ? <Text style={{ color, fontWeight: "600" }}>{label}</Text> : null}
      {children}
    </Pressable>
  );
}

// A slider: use a registered community slider if the app installed one (see
// registerComponent), else a dependency-free track fallback so the element still
// renders (React Native core has no built-in Slider).
function renderSlider(
  node: WidgetNode,
  p: Props,
): React.ReactElement {
  const Slider = componentFor("RNSlider");
  if (Slider) return <Slider {...p} value={Number(node.props.value ?? 0)} />;
  const View = componentFor("View")!;
  const value = Number(node.props.value ?? 0);
  const min = Number(node.props.min ?? 0);
  const max = Number(node.props.max ?? 1);
  const frac = max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0;
  return (
    <View style={[{ height: 4, backgroundColor: "#334155", borderRadius: 2 }, p.style as object]}>
      <View
        style={{
          width: `${frac * 100}%`,
          height: 4,
          backgroundColor: "#38bdf8",
          borderRadius: 2,
        }}
      />
    </View>
  );
}
