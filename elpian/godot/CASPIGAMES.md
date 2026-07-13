# CaspiGames on Victor — the gaming super-app client

`project/caspigames.tscn` + `scripts/caspigames.js` turn Victor into the
client of **CaspiGames**, a gaming super-app whose backend is a mesh of WASM
creatures on a [Caspar](https://github.com/cosmopole-org/caspar) node (see
the [CaspiGames platform repo](https://github.com/cosmopole-org/CaspiGames)
for the backend creatures, sample games and deploy tooling). Everything the
player sees — connect form, 3D garage, HUD, game loading — is JavaScript on
the Elpian root VM; every third-party game runs in a **sandboxed child VM**.

## caspar.js — the Caspar protocol prelude

`prelude/caspar.js` (composed on `import 'caspar.js';`) is a full client for
the Caspar signed binary action protocol, in the guest-JS subset over the
reflective bridge:

* **Transport** — a `StreamPeerTCP` node pumped on a `GTimer` (33 ms), with a
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

## The client flow (scripts/caspigames.js)

1. **Connect form** (VUI, portrait 720×1280, transparent shell): Caspar node
   host/port, the main entry creature id + program id, player handle →
   connect → login → `discover` → profile bootstrap.
2. **The garage** — a gamified 3D lab built with `G3`: emissive floor grid,
   holo-table with a spinning hologram, workbench + tool rack, server rack
   with blinking LEDs, arcade cabinet, and a glowing cartridge pedestal per
   discovered game, under a slow drifting camera. The HUD (games shelf,
   profile, leaderboards, system panel) rides a bg-less VUI app so the 3D
   world shows through.
3. **Opening a game** — manifest + base64 source chunks are fetched from the
   `games` creature, the **Caspi SDK shim** is prepended, and the game boots
   in a child VM sandboxed to a fresh pod node with instruction/memory
   budgets. The garage hides; the game's camera/UI owns the screen; EXIT (or
   `Caspi.exit()`, or a budget trap) terminates the branch, frees the pod and
   restores the garage + camera.
4. **The platform proxy** — the root VM answers game messages
   (`submitScore`, `grant`, `top`, `profile`, `info`, `ready`, `exit`) by
   signalling the discovered backend creatures and replying to the child by
   its **sender vm id** (a game may message during its boot turn, before the
   spawn call has even returned). vm_manage stays granted to games — the
   `vm.*` family carries the messaging channel and every verb is
   tree-authorized anyway, so a game can only manage its own descendants.

## Running

```sh
godot --path project caspigames.tscn
```

with a deployed backend (CaspiGames repo: `./build-all.sh` then
`python3 deploy/deploy_platform.py` against a running Caspar node — it prints
the three connect-form values).

## Tests

`capi/tests/run_caspigames.rs` — the shipped client boots to the connect
form on a real VM against a mock engine; the caspar.js length-prefixed
framing round-trips byte-for-byte (incl. multi-byte UTF-8 and truncation
safety); `Caspar.connect` opens and pumps a `StreamPeerTCP`; and the Caspi
SDK message contract bridges a sandboxed child VM to the platform proxy and
back.
