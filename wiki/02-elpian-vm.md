# 02 — The Elpian VM

The Elpian VM (`victor/elpian-vm/`) is the **executor** at the center of Victor.
It has no notion of any source language: it runs **Elpian AST JSON** (or
prebuilt bytecode) that a front-end (`js2elpian`, `dart2elpian`) produced.

You rarely touch the VM directly — you write JS or Dart — but its semantics
determine what your code *means*. Get these right and your programs behave
identically no matter which language you wrote them in.

## Pipeline

```
source (JS/Dart) ──front-end──▶ Elpian AST JSON ──compile_ast──▶ bytecode (Vec<u8>)
                 ──DecodedProgram::decode──▶ in-memory op list ──executor──▶ run + host calls
```

- The front-end can run **ahead of time** (compile to bytecode at build time),
  so the deployed app loads bytecode with no parsing at startup.
- The executor decodes bytecode **once** at construction into an addressable op
  list, so a program that re-runs its render path every frame pays decode cost
  only once.

## Pausing interpreter + `askHost`

The VM is a coroutine. `askHost(apiName, payload)` **suspends** the VM, hands the
request to the embedder, and **resumes** with the reply. This is the only way a
guest affects the outside world. Everything else (`GD.create`, `FL.mount`, …) is
a prelude wrapper over `askHost`. See `01-architecture.md` for the host-call
families.

Consequence you must internalize: **a host call is a suspension point.** Signal
callbacks and events are delivered back into the VM as *separate* resumed turns,
not synchronously (see `05-godot-bridge.md` and `12-gotchas.md`).

## The value model (language-neutral)

### First-class `null`

The VM has one real `null` literal. Each front-end lowers its own spelling
(`null`, `undefined`) to it. **Absent reads yield null**: a missing argument, an
absent object member, an absent map key, an out-of-range list element all read
as `null`. `??` and `== null` test exactly it. **A numeric `0` is never null**
(this matters: `if (x)` where `x` is `0` is falsy, but `x == null` is false).

### Neutral type tags

Reified type tests run against the VM's neutral tag names:

```
int  float  number  string  list  map  function  bool  null  any
```

Front-ends map their own spellings at compile time (Dart `double`→`float`,
`String`→`string`; JS via `typeof`). From guest code the tag test is the
`__isType(value, "tag")` intrinsic (JS) — **use it, never `.length`, to tell a
list from a map** (see `12-gotchas.md`, this is the #1 source of runtime errors).

```js
__isType(v, "list")      // true only for arrays
__isType(v, "map")       // true only for objects
__isType(v, "function")  // true for functions
__isType(v, "string")    // ...etc
```

### Truthiness

Branches, loops, `!`, `&&`, `||` use the VM's documented truthiness rule. A
front-end whose language coerces differently wraps the condition at compile time
(e.g. Dart requires a real `bool`). In practice, for JS guests: `null`, `0`,
`""`, `false` are falsy; everything else (including empty arrays/objects) is
truthy — but do not rely on exotic coercions; be explicit.

## Universal "shape" operators (native opcodes)

These are first-class VM opcodes (not front-end desugaring), so every language
gets them uniformly:

| Operator | Behaviour |
|---|---|
| **Spread** `...v` | Expands a collection inside an array literal, object literal, or call args. Array→its elements; string→its characters; object→its members. |
| **Template** `` `a${x}b` `` | Concatenates parts using the VM's display coercion. |
| **Destructuring** `let {a, b: r, c = 1, ...rest} = o` / `let [x, , y, ...tail] = a` | Binds many names by member key (object) or position (array), with defaults, holes, and a trailing rest. |

## Exceptions

`throw` raises any value; `try`/`catch` catches it, unwinding across call frames.
A native builtin error surfaces as a catchable `{ name, message }` object. Each
front-end maps its own syntax (JS `try/catch/finally`; Dart `try/on/catch/
finally` + `rethrow`) onto this one neutral opcode.

Host-op failures resume the guest as a value `{"__dart_error__": …}`, which the
front-end lowers into a thrown error. So a failed `askHost` typically **throws**
in the guest — wrap risky host calls in `try/catch` when you need to detect
failure (this is how `FL.mount` detects "no Flutter engine"; see `07`).

## The universal standard library (builtins)

The VM exposes ONE flat, neutral stdlib. Each front-end maps its language's
spelling onto a universal name **at compile time** (JS `Array.push`→`push`,
`.toUpperCase()`→`upper`, `.includes()`→`contains`, `.filter()`→`where`,
`.some()`→`any`, `.replace()`→`replaceFirst`; Dart `List.add`→`push`, etc.). The
VM carries no language-specific method names and does no runtime name
translation.

Builtins available as **global functions** in guest code (partial — full list in
`victor/elpian-vm/src/sdk/stdlib/mod.rs`, const `BUILTINS`):

- **math constants:** `PI E TAU SQRT2 LN2 LN10 INF NAN`
- **math unary:** `abs floor ceil round trunc fract sign sqrt cbrt exp ln log2
  log10 sin cos tan asin acos atan sinh cosh tanh degrees radians isNaN
  isFinite factorial`
- **math binary/variadic:** `pow log atan2 hypot min max clamp gcd lcm sum mean
  intDiv remainder isEven isOdd random seedRandom`
- **bitwise (integer):** `bitAnd bitOr bitXor bitNot shl shr ushr toInt32
  toUint32`
- **reflection/convert/codecs:** `typeOf len length isEmpty isNotEmpty str num
  int bool isNull jsonParse jsonStringify base64Encode base64Decode utf8Encode
  utf8Decode`
- collection/string operators (`push upper has reversed splice at find sort …`)
  are reached through the front-end's method spellings.

> **`sin`, `cos`, `min`, `max`, `clamp`, `abs`, `sqrt`, etc. are globals** — call
> them directly (`sin(x)`), not `Math.sin(x)` (though `Math.sin` also works in
> JS: `js2elpian` maps the `Math` namespace to these builtins). This is how the
> VUI canvas computes arc points.

## Governance: capabilities + resource limits

The VM ships a first-class two-layer governor, enforced inside the executor:

- **Capabilities** — named permissions a VM holds (e.g. `vm_manage`, `scene`).
  A denied capability short-circuits the relevant operation to `null` before it
  reaches the host.
- **Resource limits** — per-VM budgets: total instructions, instructions per
  turn (traps runaway loops), memory bytes, storage bytes, call depth; plus
  host-call and bytes-moved meters. Exceeding a limit terminates the VM (or its
  subtree). See the multi-VM section of `05-godot-bridge.md`.

This is what makes it safe for a root program to spawn sandboxed child VMs that
run untrusted code.

## What you actually write

You do **not** write AST. You write JavaScript (`03-javascript.md`) or Dart
(`04-dart.md`), import a prelude, and the front-end + VM do the rest. The VM
facts above matter because they explain *why* code behaves as it does:

- why `x ?? y` and `x == null` treat only real null;
- why `__isType` is the correct type test;
- why a failed host op throws;
- why `sin`/`cos` are just there;
- why signal callbacks arrive on a later turn.
