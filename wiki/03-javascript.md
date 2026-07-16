# 03 — JavaScript (the `js2elpian` front-end)

JavaScript is the **primary, best-covered** guest language for Victor. Write a
`.js` file, `import` a prelude, and `js2elpian` compiles it to Elpian AST. This
page is the exact supported surface — write within it and your code compiles and
runs; step outside it and you get a compile or runtime error.

Authoritative source: `victor/js2elpian/src/lib.rs` (the `//!` header lists the
surface; the parser is the ground truth).

## Supported surface

### Operators (the full tower)

- Binary: `?? || && | ^ & == === != !== < <= > >= << >> >>> + - * / % **`
- Unary: `! - + ~ typeof void delete`
- `instanceof`, `in`
- Optional chaining `?.` (member, index, and call)
- Assignment: `= += -= *= /= %= **= &= |= ^= <<= >>= >>>= &&= ||= ??=`, `++`, `--`
- Bitwise & shift lower to universal builtins with **JS 32-bit semantics**
  (`ToInt32`/`ToUint32` composed for you); `?? && ||` are the VM's short-circuit
  opcodes.

### Statements

- `let` / `const` / `var` (incl. **destructuring** `let {a, b=1, ...rest} = o`,
  `let [x, , y] = a`)
- `function` declarations and expressions; arrow functions `(a) => …` / `(a) => { … }`
- `class` — fields, methods, `extends`/`super`, `static` members
- `if`/`else`, `while`, `do`/`while`, C-style `for`, `for-of`, `for-in`
- `switch`/`case`/`default` (desugars to an if-chain)
- `break`/`continue`, `return`, `throw`, `try`/`catch`/`finally`

### Closures capture **by reference**

A post-parse transform boxes any local a nested closure *mutates* into a
one-element array, so mutations propagate:

```js
let sum = 0;
[1, 2, 3].forEach((x) => { sum += x; }); // sum === 6
```

### Classes

```js
class Counter {
  constructor(start) { this.n = start; }        // fields via this.x = ...
  inc() { this.n = this.n + 1; return this.n; }
  static make() { return new Counter(0); }      // statics
}
class Doubler extends Counter {
  inc() { super.inc(); return super.inc(); }     // extends / super
}
let c = new Counter(0);   // `new` IS supported
```

### Standard library (member spellings → universal builtins)

JS core-member spellings are mapped to the VM's universal stdlib at compile
time. You write idiomatic JS; the compiler resolves the name:

```js
[1,2,3].includes(2)      // → contains
[1,2,3].filter(f)        // → where
[1,2,3].some(f)          // → any
[1,2,3].map(f).sort()
"hi".toUpperCase()       // → upper
"a,b".replace("a","x")   // → replaceFirst
```

Static namespaces resolve to builtins/intrinsics: **`Math`, `JSON`, `Object`,
`Number`, `Array`, `console`**, plus the globals `parseInt` / `parseFloat`. The
higher-order Array/Map methods run as guest prelude functions.

```js
Math.sin(x); Math.min(a, b); Math.floor(x);   // also available as bare sin/min/floor
JSON.parse(s); JSON.stringify(o);
console.log("...");                            // also: bare print("...")
```

### Type tests — use `__isType`, never `.length`

The single most important JS-on-Victor rule. To distinguish a list from a map:

```js
if (__isType(v, "list")) { /* array */ }
else if (__isType(v, "map")) { /* object */ }
if (__isType(v, "function")) { /* callable */ }
```

`typeof v` works (`"object"` for both arrays and maps, `"function"`, `"string"`,
`"number"`, `"boolean"`, `"undefined"` for null). But **probing a map for
`.length`** to guess array-ness raises `"non object value can not be indexed by
string"`. Always use `__isType` for the list-vs-map decision. (See
`12-gotchas.md`.)

## The prelude / module system

There is **no ES module system**. Instead, a program `import`s a prelude by
name, and the composer strips `import` lines and prepends the named prelude
source:

```js
import 'godot.js';   // GD / GObj / G3 / GTimer / VMs / value types
import 'ui.js';      // VUI (implies nothing else; depends on godot.js)
import 'react.js';   // VReact (implies ui.js)
import 'flutter.js'; // FL (depends on godot.js)
import 'net.js';     // Net / WSocket / SocketIO
import 'caspar.js';  // Caspar protocol client
```

Composition order is fixed: `godot.js` → `net.js`/`caspar.js` → `flutter.js` →
`ui.js` → `react.js` → your program. So later preludes can use earlier ones
(e.g. VUI's canvas reads FL paint maps). You cannot import your own files; put
everything in one program (or use the multi-VM system to load more programs).

`print(x)` writes to the host log (Godot console). It is a global function.

## Gotchas specific to JavaScript

1. **List vs map:** `__isType`, not `.length`. (Repeated because it bites
   everyone.)
2. **`new` is required** for class instantiation (`new Foo()`), and IS supported.
   But some preludes construct value types without `new` internally — follow the
   prelude's own style when extending it.
3. **Numbers marshal to Godot ambiguously.** A JS number is passed to Godot as a
   float or int depending on context; when a Godot API needs a specific `int` or
   `float`, wrap with `GInt(n)` / `GFloat(n)` from `godot.js`. See
   `05-godot-bridge.md` and `12-gotchas.md`.
4. **`delete obj[key]`, `for (k in obj)`, `typeof` all work.**
5. **No `async`/`await`, no Promises, no generators.** Use `GTimer` and callback
   style, or the VReact hook model. Microtasks exist internally (used by the FL
   render loop) via the async loop, but there is no `async` keyword surface.
6. **Signal/event callbacks run on a later turn** (deferred dispatch), not
   synchronously during the engine call that triggers them. Do not rely on a
   connected callback having fired by the next line.

## Minimal working program

```js
import 'godot.js';

// A label that counts up once a second.
let root = GD.host();                 // the ElpianVM node
let label = GD.create("Label");
root.call("add_child", [label]);
let n = 0;
GTimer.periodic(1000, () => { n = n + 1; label.set("text", "tick " + n); });
print("up and running");
```

See `05-godot-bridge.md` for the full `GD`/`GObj` surface, and `11-recipes.md`
for larger examples.
