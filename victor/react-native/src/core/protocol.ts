// The op protocol the guest preludes emit and this host services.
//
// The multi-VM manager (Rust) forwards four host-call families to us over the
// single wasm `host_call` seam:
//
//   "log"        — a print line              args: [string]
//   "rn.op"      — one widget op             args: [Op]
//   "rn.batch"   — many widget ops           args: [Op[]]
//   "godot.op"   — one 3D op (embedded Godot) args: [Op]
//   "godot.batch"— many 3D ops               args: [Op[]]
//
// Every op is a plain JSON object whose *keys* name the action, exactly like
// the Godot bridge. Handle ids (`def`/`ref`/`chk`/`free`/`grant`/`base`) and
// callback ids (`cb`) are already namespaced into the calling VM's id space by
// the manager, and each op carries the caller's sandbox root as `__sbx` (absent
// for the unrestricted root VM). We never trust a guest-forged `__sbx`; the
// manager stamps the real one.

/** A wire value: JSON scalars, arrays, objects, plus the tagged handle/cb shapes. */
export type Wire =
  | null
  | boolean
  | number
  | string
  | Wire[]
  | { [k: string]: Wire };

/** A handle reference as it appears inside op args: `{ ref: id }`. */
export interface RefTag {
  ref: number;
}

/** A callback reference as it appears inside op args/props: `{ cb: id }`. */
export interface CbTag {
  cb: number;
}

export function isRef(v: unknown): v is RefTag {
  return !!v && typeof v === "object" && typeof (v as RefTag).ref === "number";
}

export function isCb(v: unknown): v is CbTag {
  return !!v && typeof v === "object" && typeof (v as CbTag).cb === "number";
}

/** A single op. Only a subset of keys is present on any given op. */
export interface Op {
  __sbx?: number;

  // sandbox probes
  chk?: number;
  grant?: number;
  sbx?: number;

  // object lifecycle
  new?: string;
  def?: number;
  self?: boolean;
  free?: number;

  // addressing an existing object
  ref?: number;

  // property access
  set?: string;
  get?: string;
  props?: Record<string, Wire>;
  value?: Wire;

  // method dispatch
  method?: string;
  args?: Wire[];

  // events
  connect?: string;
  disconnect?: string;
  cb?: number;

  // app-level
  root?: number;
  toast?: string;

  [k: string]: Wire | undefined;
}

/** The wire error convention shared with the Godot bridge. */
export function wireError(message: string): { __dart_error__: string } {
  return { __dart_error__: message };
}

export function isWireError(v: unknown): boolean {
  return !!v && typeof v === "object" && "__dart_error__" in (v as object);
}
