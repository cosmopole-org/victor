# 04 — Dart (the `dart2elpian` front-end)

Victor accepts a **Dart subset** as an alternative guest language. `dart2elpian`
lowers Dart source to the same JS-subset the VM ingests (it rewrites Dart-
specific surface and then runs through the JS layer, so closure-by-reference,
the universal stdlib, etc. all apply). Use Dart when you want idiomatic
Flutter-style code (`godot.dart`, or the on-VM `flutter.dart` widget library).

Authoritative source: `victor/dart2elpian/src/lib.rs` (the `//!` header lists the
supported subset; it grows over time).

## Supported subset

### Declarations & types

- Top-level function declarations and statements.
- Typed or `var`/`final` locals — **types are parsed and erased**.
- **Named & optional parameters:** `{this.width}`, `[int x = 0]`, `required`,
  with defaults, lowered to a trailing options object; named arguments at call
  sites.
- **Generic type args** in type positions are erased.

### Classes (idiomatic Flutter shape)

- Fields (with initializers), constructors including `this.x` initializing
  formals, methods, `extends`/`super`, instantiation `ClassName(args)`, member
  access, `this`.
- Bare field/method references inside methods resolve to `this.member`
  (including inherited members).
- `static` fields/methods and **named constructors** (reached as `Class.member`,
  backed by the VM's static-member support).
- **Getters** `T get x => …`.
- `const` constructors/expressions are erased to plain instantiation.
- `enum`s (lowered to an object mapping each constant to its name string).
- `abstract` / soft class modifiers and metadata annotations (`@override`,
  `@immutable`, …) are erased.

### Control flow

`if`/`else`, `while`, `do`/`while`, C-style `for`, **`for-in`** (lowered to
`while`), `switch`/`case`/`default`, `break`/`continue`, `return`, blocks.

### Exceptions

`throw` / `rethrow`, and `try` / `on T` / `catch (e[, st])` / `finally`, lowered
to the VM's neutral try-catch opcode (the `on Type` filter and stack-trace
binding are erased; a native builtin error is a catchable `{ name, message }`).

### Expressions & operators

- Literals incl. **hex integers** `0xFF2196F3` (handy for colours).
- The full binary tower `?? || && | ^ & == != < <= > >= << >> >>> + - * / % ~/`,
  unary `! - ~`, ternary `?:`.
- Assignment + compound `+= -= *= /= %= &= |= ^= <<= >>= >>>= ??=`, `++`/`--`.
- Null-assertion `x!` (erased), null-aware `obj?.member`, and **cascades**
  `target..a()..b = c`.
- **String interpolation** `"$x"`, `"${expr}"` (lowered to concatenation).
- `~/` and bitwise/shift operators lower to the VM's universal builtins.

### Closures & functional Dart

`(a) => expr`, `(a) { body }`, and arrow bodies for declarations
(`int f() => expr;`). Combined with the VM's higher-order Iterable methods
(`map`/`where`/`fold`/`reduce`/`any`/`every`/`firstWhere`/`expand`/`takeWhile`/
`sort`/…, bound to prelude functions), real functional Dart runs. Closures
capture **by reference** for mutated captured locals.

### Entry point

`main()` is **auto-invoked** if present. `print(x)` lowers to `askHost("log",
[x])`.

## The Dart Godot prelude (`godot.dart`)

`godot.dart` is the Dart twin of `godot.js` — same `GD` / `GObj` / value types /
`GTimer` / `VMs` surface, same wire protocol. The shipped third-person-shooter
demo (`victor/bridge/project/scripts/tps_main.dart`, see
`victor/bridge/GAME_DESIGN.md`) is written entirely in Dart on the VM and is the
canonical large Dart example.

```dart
import 'godot.dart';

class Game {
  var score = 0;
  void bump() { score = score + 1; }
}

void main() {
  final root = GD.host();
  final label = GD.create('Label');
  root.call('add_child', [label]);
  var g = Game();
  GTimer.periodic(1000, () { g.bump(); label.set('text', 'score ${g.score}'); });
  print('dart game up');
}
```

## The on-VM Flutter widget library (`flutter.dart`)

`victor/dart/flutter/flutter.dart` is a self-contained, Flutter-style widget
library (StatelessWidget/StatefulWidget/MaterialApp/Scaffold/Center/Text/…) that
runs *on the VM* and lowers widgets to `dart:ui` display lists. It is a
different path from the `FL` embedded-engine bridge (`07-flutter-bridge.md`) and
from VUI — read its header before using it. For most apps, prefer VUI, VReact,
or the `FL` bridge.

## Gotchas specific to Dart

1. Everything in `12-gotchas.md` about **marshaling** applies: when a Godot API
   needs a specific `int` vs `float`, use `GInt`/`GFloat` — Dart's `int`/`double`
   distinction is erased at the VM boundary, so the bridge cannot infer it.
2. `Object`/`dynamic` are lowered without involving the VM; reified `is`/`as` run
   against the VM's neutral type tags (`double`→`float`, `String`→`string`, …).
3. Not every `dart:*` library exists. The foundational surface (`dart:ui`,
   `dart:typed_data`, …) is provided by the `dart` crate only on the on-VM
   Flutter path and only partially (see `victor/dart/README.md`). For engine
   work, use `godot.dart` (the Godot bridge), not `dart:*`.
4. `async`/`await`/isolates are **not** implemented in `dart2elpian` — use
   `GTimer` and callbacks.
