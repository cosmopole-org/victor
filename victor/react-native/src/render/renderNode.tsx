// The widget renderer — turns a retained `WidgetNode` (built by the VM over
// `rn.op`) into a real React Native element. This is the inverse of the Godot
// host: instead of `Control` nodes, the guest's 2D tree becomes genuine RN
// components, so a Victor app is a first-class React Native view on mobile,
// desktop and web while keeping Godot for 3D via `<Scene3dSurface/>`.

import React from "react";
import {
  ActivityIndicator,
  Image,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";

import type { WidgetStore } from "../core/widgetStore.ts";
import type { Wire } from "../core/protocol.ts";
import { toStyle } from "./style.ts";
import { Scene3dSurface } from "../scene3d/Scene3dSurface.tsx";
import type { RnScene3dEngine } from "../scene3d/engine.ts";

export interface RenderContext {
  store: WidgetStore;
  /** Fire a widget event back into the VM. */
  fire: (widgetId: number, event: string, arg?: Wire) => void;
  /** Optional platform Godot engine that draws Scene3D surfaces. */
  engine?: RnScene3dEngine;
}

/** Render the node `id` (and its subtree) to a React element. */
export function renderNode(ctx: RenderContext, id: number): React.ReactNode {
  const node = ctx.store.get(id);
  if (!node) return null;
  const p = node.props;
  const style = toStyle(p);
  const key = String(id);
  const children = node.children.map((cid) => renderNode(ctx, cid));

  switch (node.className) {
    case "RNView":
      return (
        <View key={key} style={style}>
          {children}
        </View>
      );

    case "RNScroll":
      return (
        <ScrollView
          key={key}
          style={style}
          horizontal={p.direction === "row"}
        >
          {children}
        </ScrollView>
      );

    case "RNSafeArea":
      // SafeAreaView lives in react-native-safe-area-context in modern Expo;
      // a plain flex View is the dependency-free fallback with top inset.
      return (
        <View key={key} style={[{ flex: 1 }, style]}>
          {children}
        </View>
      );

    case "RNText":
      return (
        <Text key={key} style={style} numberOfLines={numberProp(p.numberOfLines)}>
          {String(p.text ?? "")}
        </Text>
      );

    case "RNButton":
      return (
        <Pressable
          key={key}
          style={({ pressed }) => [
            {
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderRadius: 8,
              backgroundColor: (p.bg as string) ?? "#2563eb",
              opacity: pressed ? 0.8 : 1,
              alignItems: "center",
            },
            style,
          ]}
          disabled={p.disabled === true}
          onPress={() => ctx.fire(id, "press", null)}
        >
          <Text style={{ color: (p.color as string) ?? "#fff", fontWeight: "600" }}>
            {String(p.title ?? p.text ?? "")}
          </Text>
        </Pressable>
      );

    case "RNInput":
      return (
        <TextInput
          key={key}
          style={[
            {
              borderWidth: 1,
              borderColor: "#cbd5e1",
              borderRadius: 8,
              paddingVertical: 8,
              paddingHorizontal: 12,
            },
            style,
          ]}
          value={p.value === undefined || p.value === null ? undefined : String(p.value)}
          placeholder={p.placeholder === undefined ? undefined : String(p.placeholder)}
          secureTextEntry={p.secure === true}
          keyboardType={(p.keyboardType as never) ?? "default"}
          onChangeText={(t) => ctx.fire(id, "changeText", t)}
          onSubmitEditing={() => ctx.fire(id, "submit", null)}
        />
      );

    case "RNImage":
      return (
        <Image
          key={key}
          style={[{ width: 64, height: 64 }, style]}
          source={{ uri: String(p.src ?? p.source ?? "") }}
          resizeMode={(p.resizeMode as never) ?? "cover"}
        />
      );

    case "RNSwitch":
      return (
        <Switch
          key={key}
          value={p.value === true}
          onValueChange={(v) => ctx.fire(id, "valueChange", v)}
        />
      );

    case "RNActivityIndicator":
      return <ActivityIndicator key={key} style={style} />;

    case "RNScene3D":
      return (
        <Scene3dSurface
          key={key}
          surfaceId={id}
          style={style}
          engine={ctx.engine}
        />
      );

    default:
      // Unknown host class: render children in a plain View so the tree still
      // shows something rather than vanishing.
      return (
        <View key={key} style={style}>
          {children}
        </View>
      );
  }
}

function numberProp(v: Wire | undefined): number | undefined {
  return typeof v === "number" ? v : undefined;
}
