# CaspiGames on Victor — the Caspar protocol prelude

Victor ships the protocol layer of **CaspiGames**, a gaming super-app whose
backend is a mesh of WASM creatures on a
[Caspar](https://github.com/cosmopole-org/caspar) node. The client scene
itself (connect form, the 3D garage, the sandboxed game loader) lives in the
[CaspiGames platform repo](https://github.com/cosmopole-org/CaspiGames) under
`client/` — its e2e/Docker pipeline copies it into this Godot project and
builds/export it (web export included). What lives HERE is the reusable
piece: `prelude/caspar.js`.

## caspar.js — the Caspar protocol prelude

`prelude/caspar.js` (composed on `import 'caspar.js';`) is a full client for
the Caspar signed binary action protocol, in the guest-JS subset over the
reflective bridge:

* **Transports** — `StreamPeerTCP` (default) or `WebSocketPeer`
  (`transport: 'ws'`, auto-selected on web exports where raw TCP does not
  exist; each WS Binary message carries one `u32be(len)||body` frame, matching
  the node's client WS driver), both pumped on a `GTimer` (33 ms) into one
  resumable length-prefixed frame parser (requests carry *no* tag byte;
  responses `0x02` are ACKed with a `u32be(1)|0x01` frame so the server's
  send gate opens; updates `0x01` are fire-and-forget).
* **Auth** — dev `/creatures/login` returns `{user, privateKey}`; the PEM is
  loaded into a Godot `CryptoKey` and every subsequent action is signed
  RSA-SHA256 over the exact payload bytes (`HashingContext` + `Crypto.sign`,
  i.e. PKCS#1 v1.5 — the Caspar node verifies it alongside PSS, see
  caspar `docs/API_REFERENCE.md` "Request signatures").
* **Creature signalling** — `node.signal({creatureId, programId, entityId,
  action, payload}, cb)` wraps the payload in the platform's
  correlation-id envelope, sends `/creatures/signal` (type `pvp`), and routes
  the creature's `creatures/signal/result` update frame back to `cb` by
  correlation id, with timeouts.
* **CaspiNet** — the super-app discovery layer: given the main entry
  creature id + program id (entity id `main`), `discover()` fetches the
  platform manifest + service registry, and `call(service, action, payload,
  cb)` reaches any registered service by name.

## The client (in the CaspiGames repo)

`CaspiGames/client/scripts/caspigames.js` + `client/caspigames.tscn` build on
this prelude: connect form → login → discovery → the 3D garage lab → games
loaded into sandboxed child VMs with the Caspi SDK shim. See
`CaspiGames/README.md` and `CaspiGames/docs/GAME_DEV_GUIDE.md`.

## Running

The CaspiGames e2e pipeline (or by hand):

```sh
cp <CaspiGames>/client/caspigames.tscn project/
cp <CaspiGames>/client/scripts/caspigames.js project/scripts/
godot --path project caspigames.tscn
```

with a deployed backend (CaspiGames repo: `./build-all.sh` then
`python3 deploy/deploy_platform.py` against a running Caspar node — it prints
the three connect-form values). The dockerized stack in the CaspiGames repo
automates all of this, including the browser build served over HTTP.

## Tests

`capi/tests/run_caspigames.rs` — the caspar.js length-prefixed framing
round-trips byte-for-byte (incl. multi-byte UTF-8 and truncation safety);
`Caspar.connect` opens and pumps a `StreamPeerTCP` (and a `WebSocketPeer` in
`transport: 'ws'` mode); the Caspi SDK message contract bridges a sandboxed
child VM to the platform proxy and back; and — when `CASPIGAMES_CLIENT_JS`
points at the CaspiGames client script — the full client boots to its
connect form on a real VM.
