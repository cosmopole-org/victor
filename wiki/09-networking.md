# 09 — Networking (`net.js`, `caspar.js`)

Networking is **user-space** — plain guest-JS over the Godot bridge (HTTPRequest,
WebSocketPeer, StreamPeerTCP), no privileged access. Import the prelude you need.

## `net.js` — HTTP, WebSocket, Socket.IO

`import 'net.js';` (depends only on `godot.js`). Provides `Net`, `WSocket`,
`SocketIO`.

### `Net` — HTTP client (over Godot `HTTPRequest`)

Base URL + default headers + an **automatic cookie jar** (cookie sessions work
out of the box).

```js
Net.setBase("https://api.example.com");
Net.setHeader("Authorization", "Bearer " + token);
Net.setInsecureTls(false);              // dev only

Net.get("/users", (err, res) => { ... });          // res: { status, headers, body }
Net.postJson("/login", { user, pass }, (err, res) => { ... });
Net.putJson("/users/1", { name }, cb);
Net.del("/users/1", cb);
Net.getBytes("/blob", (err, bytes) => { ... });     // PackedByteArray
Net.request(method, path, { headers, body }, cb);   // full control
// cookie helpers: Net.cookie / Net.cookieHeader / Net.clearCookies / Net.resolve
```

Callbacks are `(err, res)` — there is no `async`/`await`; use the callback.

### `WSocket` — WebSocket client (over `WebSocketPeer`)

Polled on a **guest timer** (it deliberately does NOT use `GD.onProcess`, which
VReact owns for `useFrame`).

```js
let ws = WSocket.connect("wss://example.com/socket");
ws.on("open", () => ws.send("hello"));
ws.on("message", (data) => { ... });
ws.on("close", () => { ... });
ws.close();
```

### `SocketIO` — Socket.IO v4 client (over `WSocket`)

```js
let io = SocketIO.connect("https://example.com", { ... });
io.on("connect", () => io.emit("chat", { text: "hi" }));
io.on("chat", (msg) => { ... });
io.off("chat"); io.close();
```

## `caspar.js` — the Caspar protocol client

`import 'caspar.js';` (depends only on `godot.js`). A full client for the
[Caspar](https://github.com/cosmopole-org/caspar) node's **signed binary action
protocol**: framed transport over `StreamPeerTCP` (or `WebSocketPeer` with
`transport: 'ws'`, auto-selected on web where raw TCP is unavailable), dev login,
RSA request signing via Godot `Crypto`, and creature signalling with
correlation-id result routing. Also ships `CaspiNet`, a super-app service-
discovery layer. It powers the CaspiGames client.

Deep doc: **`victor/bridge/prelude/CASPAR.md`**. Use it only if you are talking to
a Caspar node; for ordinary HTTP/WS use `net.js`.

## Gotchas

- **No `async`/`await`.** Everything is callback-style. Compose with helper
  functions or a small state machine.
- **Web transport differences:** raw TCP does not exist in a wasm export; the
  Caspar client auto-switches to WebSocket (`transport: 'ws'`, `url:`), and any
  raw-socket code you write must do the same. HTTP and WebSocket work on all
  targets.
- **TLS:** production must verify TLS; `setInsecureTls(true)` is dev-only.
- **The preludes were written in a conservative JS subset** (their headers
  mention avoiding some syntax). The *current* `js2elpian` supports the full
  tower (see `03-javascript.md`), so your own code can use `try/catch`, spread,
  etc. — but if you *edit* a prelude, match its existing conservative style to be
  safe.
