// Ambient types for the Victor React runtime.
//
// At build time, `import { … } from "react"` and `from "@victor/react"` are
// stripped — every name resolves to a global provided by the composed
// `react.js` prelude on the Elpian VM. These declarations exist only so an
// editor / tsserver gives you completion and type-checking while authoring.

declare module "react" {
  export type Key = string | number;
  export interface VNode {
    __vreact_element__: true;
    type: any;
    props: any;
    key: Key | null;
  }
  export type FC<P = {}> = (props: P & { children?: any }) => VNode | any;

  export type Dispatch<A> = (action: A) => void;
  export type SetStateAction<S> = S | ((prev: S) => S);

  export function useState<S>(initial: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useReducer<S, A>(reducer: (s: S, a: A) => S, initial: S, init?: (arg: S) => S): [S, Dispatch<A>];
  export function useEffect(effect: () => void | (() => void), deps?: any[]): void;
  export function useLayoutEffect(effect: () => void | (() => void), deps?: any[]): void;
  export function useInsertionEffect(effect: () => void | (() => void), deps?: any[]): void;
  export function useRef<T>(initial: T): { current: T };
  export function useMemo<T>(factory: () => T, deps?: any[]): T;
  export function useCallback<T>(fn: T, deps?: any[]): T;
  export function useContext<T>(ctx: Context<T>): T;
  export function useImperativeHandle<T>(ref: any, create: () => T, deps?: any[]): void;
  export function useId(): string;
  export function useSyncExternalStore<T>(subscribe: (cb: () => void) => (() => void), getSnapshot: () => T): T;
  export function useTransition(): [boolean, (cb: () => void) => void];
  export function useDeferredValue<T>(value: T): T;
  export function useDebugValue(value: any): void;
  export function useFrame(cb: (delta: number) => void): void;

  export interface Context<T> {
    Provider: FC<{ value: T; children?: any }>;
    Consumer: FC<{ children: (value: T) => any }>;
  }
  export function createContext<T>(defaultValue: T): Context<T>;

  export function memo<P>(component: FC<P>, areEqual?: (a: P, b: P) => boolean): FC<P>;
  export function forwardRef<T, P>(render: (props: P, ref: any) => any): FC<P>;
  export const Fragment: any;
  export const StrictMode: any;
  export function createElement(type: any, props?: any, children?: any): VNode;

  const React: {
    useState: typeof useState;
    useEffect: typeof useEffect;
    useRef: typeof useRef;
    useMemo: typeof useMemo;
    useCallback: typeof useCallback;
    useReducer: typeof useReducer;
    useContext: typeof useContext;
    createContext: typeof createContext;
    Fragment: any;
    createElement: typeof createElement;
  };
  export default React;
}

// The Victor primitive components (React-Native-style capitalised wrappers).
declare module "@victor/react" {
  import { FC } from "react";
  type Grow = { grow?: boolean; expand?: boolean; style?: Record<string, any>; children?: any };
  export const View: FC<Grow & { gap?: number; pad?: number }>;
  export const Row: FC<Grow & { gap?: number; pad?: number }>;
  export const Column: FC<Grow & { gap?: number; pad?: number }>;
  export const Stack: FC<Grow>;
  export const Scroll: FC<Grow & { gap?: number; pad?: number }>;
  export const Center: FC<Grow>;
  export const Panel: FC<Grow & { gap?: number; pad?: number; bg?: string }>;
  export const Card: FC<Grow & { gap?: number; pad?: number; bg?: string }>;
  export const Grid: FC<Grow & { cols?: number; gap?: number }>;
  export const Text: FC<{ size?: number; color?: string; align?: string; wrap?: boolean; dim?: boolean; grow?: boolean; children?: any }>;
  export const Heading: FC<{ size?: number; color?: string; children?: any }>;
  export const Caption: FC<{ color?: string; children?: any }>;
  export const Icon: FC<{ size?: number; color?: string; children?: any }>;
  export const Button: FC<{ kind?: "filled" | "tonal" | "outline" | "ghost" | "danger"; onPress?: () => void; wide?: boolean; disabled?: boolean; children?: any }>;
  export const TextInput: FC<{ value?: string; placeholder?: string; obscure?: boolean; onChange?: (t: string) => void; onSubmit?: (t: string) => void }>;
  export const Image: FC<{ src?: string; width?: number; height?: number }>;
  export const Progress: FC<{ value?: number; max?: number }>;
  export const Slider: FC<{ min?: number; max?: number; step?: number; value?: number; onChange?: (v: number) => void }>;
  export const Switch: FC<{ checked?: boolean; onChange?: (on: boolean) => void; children?: any }>;
  export const Checkbox: FC<{ checked?: boolean; onChange?: (on: boolean) => void; children?: any }>;
  export const Divider: FC<{ thickness?: number }>;
  export const Spacer: FC<{}>;

  // 3D primitives.
  type Vec3 = [number, number, number] | number;
  type Xform = { position?: Vec3; rotation?: Vec3; scale?: Vec3; visible?: boolean; ref?: any; children?: any };
  type MeshProps = Xform & { shape?: string; size?: Vec3; radius?: number; height?: number; width?: number; depth?: number; color?: any; emission?: any; emissionEnergy?: number; metallic?: number; roughness?: number };
  export const Scene3D: FC<{ height?: number; transparent?: boolean; msaa?: boolean; grow?: boolean; children?: any }>;
  export const Node3D: FC<Xform>;
  export const Mesh: FC<MeshProps>;
  export const Box: FC<MeshProps>;
  export const Sphere: FC<MeshProps>;
  export const Cylinder: FC<MeshProps>;
  export const Capsule: FC<MeshProps>;
  export const Plane3D: FC<MeshProps>;
  export const Torus: FC<MeshProps>;
  export const Camera3D: FC<Xform & { fov?: number; current?: boolean }>;
  export const DirectionalLight: FC<Xform & { color?: any; energy?: number; shadow?: boolean }>;
  export const OmniLight: FC<Xform & { color?: any; energy?: number; range?: number }>;
  export const SpotLight: FC<Xform & { color?: any; energy?: number; range?: number; angle?: number }>;
  export const Environment3D: FC<{ bg?: any; ambient?: any; ambientEnergy?: number }>;
  export const StaticBody3D: FC<Xform>;
  export const Area3D: FC<Xform>;
  export const CollisionShape3D: FC<Xform & { shape?: string; radius?: number; height?: number; width?: number; depth?: number }>;

  // Victor extras.
  export const Victor: {
    theme(): any;
    color(v: string): any;
    toast(msg: string, o?: any): void;
    dialog(o: any): void;
    onFrame(cb: (delta: number) => void): void;
    interval(ms: number, cb: () => void): any;
    timeout(ms: number, cb: () => void): any;
  };
}

// The JSX automatic-runtime module the transform imports from (stripped at
// build). Declares the intrinsic Victor host elements so lowercase tags
// type-check.
declare module "@victor/react/jsx-runtime" {
  export const jsx: any;
  export const jsxs: any;
  export const Fragment: any;
}

declare namespace JSX {
  interface IntrinsicElements {
    [tag: string]: any;
  }
}
