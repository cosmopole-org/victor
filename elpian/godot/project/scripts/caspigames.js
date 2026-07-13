// caspigames.js — the CaspiGames gaming super-app client, 100% JavaScript on
// the Elpian VM, driving Godot through the reflective bridge.
//
// The platform in one picture:
//
//   ┌ Victor (this program: the ROOT VM — whole-scene, trusted) ┐
//   │  connect form ─▶ Caspar node (TCP, signed action protocol)│
//   │       │             │                                     │
//   │       ▼             ▼                                     │
//   │  3D GARAGE      "main" discovery creature (entity "main") │
//   │  (the lab)          │ introduces creatureId/programId/    │
//   │   │ explore         │ entityId of every backend service   │
//   │   ▼                 ▼                                     │
//   │  games list ◀── games / profiles / leaderboard creatures  │
//   │   │ open            (WASM on Caspar, decillionai-style)   │
//   │   ▼                                                       │
//   │  SANDBOXED CHILD VM renders the third-party game in its   │
//   │  own pod node; platform calls travel child ─▶ parent ─▶   │
//   │  Caspar (the child has no network of its own)             │
//   └───────────────────────────────────────────────────────────┘
//
// Boot flow: a connect form asks for the Caspar node URL and the main entry
// creature id + program id (the discovery creature is deployed with entity id
// "main"). After login + discovery the screen becomes a gamified 3D garage
// lab; from there the player explores the game shelf, and opening a game
// spawns a sandboxed child VM that renders it in a fresh pod "scene".

import 'godot.js';
import 'ui.js';
import 'caspar.js';

// ---------------------------------------------------------------------------
// app state (closures capture locals by value — mutable state lives here)
// ---------------------------------------------------------------------------

var S = {
  phase: "connect",       // connect | garage | game
  node: null,             // Caspar connection handle
  caspi: null,            // CaspiNet discovery layer
  playerName: "player_one",
  profile: null,

  app: null,
  connectPage: null,
  garagePage: null,
  gamePage: null,
  statusLabel: null,
  playerChip: null,
  gameTitleLabel: null,

  garage: null,           // 3D root node
  garageCam: null,
  anims: [],              // [{node, kind, phase, speed, base}]
  camAngle: 0.0,
  pedestals: [],          // game cartridge pedestals

  games: [],              // discovered game manifests
  currentGame: null,
  child: null,            // VmController of the running game
  pod: null,              // the game's sandbox node
  loading: false,

  fields: {},             // connect form fields
};

function accent() {
  return new Color(0.25, 0.9, 0.75, 1.0);
}

function addTo(parent, node) {
  parent.call("add_child", [node]);
  return node;
}

// ---------------------------------------------------------------------------
// the Caspi SDK shim — prepended to every third-party game source before the
// sandboxed child VM boots. The ONLY doorway from a game to the platform:
// JSON messages to the parent VM, answered asynchronously.
// ---------------------------------------------------------------------------

var caspiShim = [
  "// --- Caspi SDK (injected by the CaspiGames host) ---",
  "var __caspi = { next: 1, cbs: {}, onEvent: null };",
  "var Caspi = {};",
  "Caspi.request = (op, payload, cb) => {",
  "  let id = __caspi.next;",
  "  __caspi.next = id + 1;",
  "  if (cb != null) { __caspi.cbs['r' + id] = cb; }",
  "  VMs.sendParent(jsonStringify({ caspi: op, id: id, payload: payload ?? {} }));",
  "};",
  "Caspi.ready = () => { Caspi.request('ready', {}, null); };",
  "Caspi.exit = () => { Caspi.request('exit', {}, null); };",
  "Caspi.submitScore = (score, cb) => { Caspi.request('submitScore', { score: score }, cb); };",
  "Caspi.grant = (xp, coins, cb) => { Caspi.request('grant', { xp: xp, coins: coins }, cb); };",
  "Caspi.top = (count, cb) => { Caspi.request('top', { count: count }, cb); };",
  "Caspi.profile = (cb) => { Caspi.request('profile', {}, cb); };",
  "Caspi.info = (cb) => { Caspi.request('info', {}, cb); };",
  "Caspi.onEvent = (cb) => { __caspi.onEvent = cb; };",
  "VMs.onMessage((sender, msg) => {",
  "  let m = jsonParse('' + msg);",
  "  if (m == null) { return; }",
  "  if (m.caspi == 'result') {",
  "    let cb = __caspi.cbs['r' + m.id];",
  "    if (cb != null) { __caspi.cbs['r' + m.id] = null; cb(m.payload); }",
  "  } else if (m.caspi == 'event') {",
  "    if (__caspi.onEvent != null) { __caspi.onEvent(m.name, m.payload); }",
  "  }",
  "});",
  "// --- end Caspi SDK ---",
  "",
].join("\n");

// ---------------------------------------------------------------------------
// connect page
// ---------------------------------------------------------------------------

function buildConnectPage() {
  let t = VUI.theme();

  S.fields.host = VUI.field({ label: "CASPAR NODE HOST", value: "127.0.0.1" });
  S.fields.port = VUI.field({ label: "PORT", value: "8074" });
  S.fields.creature = VUI.field({
    label: "MAIN ENTRY CREATURE ID",
    placeholder: "the discovery machine creature id",
  });
  S.fields.program = VUI.field({
    label: "MAIN ENTRY PROGRAM ID",
    placeholder: "the discovery program id (entity id is 'main')",
  });
  S.fields.player = VUI.field({ label: "PLAYER HANDLE", value: "player_one" });

  S.statusLabel = VUI.text("Enter your node and the main backend ids.", {
    size: t.fontXS, dim: true, wrap: true,
  });

  let form = VUI.card({
    gap: 14,
    children: [
      VUI.title("Connect to a node", { size: t.fontM }),
      S.fields.host.node,
      S.fields.port.node,
      S.fields.creature.node,
      S.fields.program.node,
      S.fields.player.node,
      S.statusLabel,
      VUI.button("ENTER THE GARAGE", {
        wide: true,
        onTap: () => { startConnect(); },
      }),
    ],
  });

  let page = VUI.scroll({
    child: VUI.column({
      gap: 20, pad: 24,
      children: [
        VUI.spacer(),
        VUI.row({
          gap: 16,
          children: [
            VUI.avatar("CG", { color: accent(), size: 92.0 }),
            VUI.column({
              gap: 4,
              children: [
                VUI.title("CaspiGames", { size: t.fontL }),
                VUI.caption("a gaming super-app on the Caspar network"),
              ],
            }),
          ],
        }),
        form,
        VUI.caption("The main creature is deployed with entity id \"main\" and introduces every other service — games, profiles, leaderboards — by creature id, program id and entity name."),
      ],
    }),
  });

  return page;
}

function setStatus(msg) {
  S.statusLabel.set("text", msg);
  print("caspigames: " + msg);
}

function startConnect() {
  if (S.phase != "connect") {
    return;
  }
  let host = S.fields.host.getText().trim();
  let portText = S.fields.port.getText().trim();
  let creatureId = S.fields.creature.getText().trim();
  let programId = S.fields.program.getText().trim();
  let player = S.fields.player.getText().trim();
  if (host == "" || portText == "" || creatureId == "" || programId == "") {
    VUI.toast("fill in node host, port and the main ids", { kind: "warning" });
    return;
  }
  if (player != "") {
    S.playerName = player;
  }
  let port = int(num(portText));
  setStatus("Connecting to " + host + ":" + port + " …");

  S.node = Caspar.connect({
    host: host,
    port: port,
    timeoutMs: 20000,
    onState: (state) => {
      if (state == "connected") {
        setStatus("Connected. Logging in as " + S.playerName + " …");
        doLogin(creatureId, programId);
      } else if (state == "error") {
        setStatus("Connection failed — check the node URL.");
        VUI.toast("connection failed", { kind: "danger" });
      } else if (state == "closed" && S.phase != "connect") {
        VUI.toast("node connection lost", { kind: "danger" });
      }
    },
  });
}

function doLogin(creatureId, programId) {
  S.node.login(S.playerName, (res) => {
    if (res.ok != true) {
      setStatus("Login failed: " + res.error);
      VUI.toast("login failed", { kind: "danger" });
      return;
    }
    setStatus("Logged in (" + S.node.userId() + "). Discovering services …");
    S.caspi = CaspiNet.open({
      node: S.node,
      mainCreatureId: creatureId,
      mainProgramId: programId,
    });
    S.caspi.discover((d) => {
      if (d == null || d.ok != true) {
        setStatus("Discovery failed — is the main creature deployed with entity id 'main'?");
        VUI.toast("discovery failed", { kind: "danger" });
        return;
      }
      let platformName = "CaspiGames";
      if (__isType(d.platform, "Map") && d.platform.name != null) {
        platformName = "" + d.platform.name;
      }
      setStatus("Discovered " + d.count + " services on " + platformName + ".");
      loadProfileThenEnter();
    });
  });
}

function loadProfileThenEnter() {
  S.caspi.call("profiles", "me", {}, (r) => {
    if (r != null && r.ok == true) {
      S.profile = r.profile;
      // Adopt the chosen handle as the display name once.
      if (S.profile != null && ("" + S.profile.name).startsWith("Player-")) {
        S.caspi.call("profiles", "setName", { name: S.playerName }, (rr) => {
          if (rr != null && rr.ok == true) {
            S.profile = rr.profile;
            refreshPlayerChip();
          }
        });
      }
    }
    refreshGames(() => { enterGarage(); });
  });
}

function refreshGames(done) {
  S.caspi.call("games", "list", {}, (r) => {
    if (r != null && r.ok == true && __isType(r.games, "List")) {
      S.games = r.games;
    }
    if (done != null) {
      done();
    }
  });
}

// ---------------------------------------------------------------------------
// the garage — a gamified 3D lab
// ---------------------------------------------------------------------------

function animate(node, kind, speed, base, phase) {
  S.anims.push({ node: node, kind: kind, speed: speed, base: base, phase: phase });
}

function buildGarage() {
  S.garage = G3.node({});
  GD.mount(S.garage);
  let g = S.garage;

  addTo(g, G3.environment({
    bg: new Color(0.012, 0.016, 0.03, 1.0),
    ambient: new Color(0.32, 0.38, 0.5, 1.0),
    ambientEnergy: 0.9,
  }));

  S.garageCam = addTo(g, G3.camera({
    fov: 62.0,
    current: true,
    position: [0.0, 4.2, 11.0],
    rotation: [-14.0, 0.0, 0.0],
  }));

  addTo(g, G3.dirLight({
    energy: 0.5,
    color: new Color(0.7, 0.8, 1.0, 1.0),
    rotation: [-50.0, 30.0, 0.0],
  }));
  addTo(g, G3.omniLight({
    color: new Color(0.4, 0.9, 0.8, 1.0),
    energy: 1.6, range: 14.0, position: [0.0, 4.5, 0.0],
  }));
  addTo(g, G3.omniLight({
    color: new Color(1.0, 0.55, 0.3, 1.0),
    energy: 1.0, range: 10.0, position: [-6.5, 3.0, -3.0],
  }));

  // Floor: brushed dark slab + glowing seam grid.
  addTo(g, G3.mesh("box", {
    size: [22.0, 0.4, 18.0], position: [0.0, -0.2, 0.0],
    color: new Color(0.07, 0.08, 0.1, 1.0), metallic: 0.7, roughness: 0.4,
  }));
  for (let i = 0; i < 5; i++) {
    addTo(g, G3.mesh("box", {
      size: [21.6, 0.02, 0.06], position: [0.0, 0.011, -7.0 + i * 3.5],
      color: accent(), emission: accent(), emissionEnergy: 0.9,
    }));
  }
  for (let i = 0; i < 6; i++) {
    addTo(g, G3.mesh("box", {
      size: [0.06, 0.02, 17.6], position: [-10.0 + i * 4.0, 0.011, 0.0],
      color: accent(), emission: accent(), emissionEnergy: 0.9,
    }));
  }

  // Walls (back + sides) with an accent trim line.
  addTo(g, G3.mesh("box", {
    size: [22.0, 7.0, 0.4], position: [0.0, 3.5, -9.0],
    color: new Color(0.09, 0.1, 0.13, 1.0), roughness: 0.8,
  }));
  addTo(g, G3.mesh("box", {
    size: [0.4, 7.0, 18.0], position: [-11.0, 3.5, 0.0],
    color: new Color(0.08, 0.09, 0.12, 1.0), roughness: 0.8,
  }));
  addTo(g, G3.mesh("box", {
    size: [0.4, 7.0, 18.0], position: [11.0, 3.5, 0.0],
    color: new Color(0.08, 0.09, 0.12, 1.0), roughness: 0.8,
  }));
  addTo(g, G3.mesh("box", {
    size: [22.0, 0.12, 0.46], position: [0.0, 2.3, -8.99],
    color: accent(), emission: accent(), emissionEnergy: 1.6,
  }));

  // Ceiling light strips.
  for (let i = 0; i < 3; i++) {
    addTo(g, G3.mesh("box", {
      size: [10.0, 0.08, 0.5], position: [0.0, 6.6, -5.0 + i * 4.0],
      color: new Color(0.9, 0.95, 1.0, 1.0),
      emission: new Color(0.8, 0.9, 1.0, 1.0), emissionEnergy: 2.4,
    }));
  }

  // Workbench along the left wall, with a tool rack.
  addTo(g, G3.mesh("box", {
    size: [1.6, 0.12, 7.0], position: [-9.6, 1.1, -1.0],
    color: new Color(0.25, 0.2, 0.14, 1.0), roughness: 0.6,
  }));
  addTo(g, G3.mesh("box", {
    size: [1.5, 1.0, 6.9], position: [-9.6, 0.55, -1.0],
    color: new Color(0.13, 0.14, 0.17, 1.0), metallic: 0.5, roughness: 0.5,
  }));
  // Tools on the rack: cylinders + small boxes in a row (abstract wrenches,
  // drivers, spray cans — enough to read "workshop" at a glance).
  for (let i = 0; i < 6; i++) {
    let hue = i / 6.0;
    addTo(g, G3.mesh("cylinder", {
      radius: 0.08, height: 0.5 + 0.25 * (i % 3),
      position: [-10.6, 3.0 + 0.0, -3.4 + i * 1.0],
      rotation: [0.0, 0.0, 90.0],
      color: new Color(0.6 + 0.3 * hue, 0.6, 0.75 - 0.3 * hue, 1.0),
      metallic: 0.8, roughness: 0.3,
    }));
  }
  for (let i = 0; i < 3; i++) {
    addTo(g, G3.mesh("box", {
      size: [0.35, 0.5, 0.35], position: [-9.7, 1.42, -3.0 + i * 1.6],
      color: new Color(0.75, 0.3 + 0.2 * i, 0.2, 1.0), roughness: 0.5,
    }));
  }

  // Server rack on the right wall with blinking status LEDs.
  addTo(g, G3.mesh("box", {
    size: [1.4, 4.2, 2.4], position: [9.8, 2.1, -4.0],
    color: new Color(0.1, 0.11, 0.15, 1.0), metallic: 0.6, roughness: 0.35,
  }));
  for (let i = 0; i < 8; i++) {
    let led = addTo(g, G3.mesh("box", {
      size: [0.08, 0.08, 0.08],
      position: [9.05, 0.6 + i * 0.45, -4.8 + (i % 2) * 1.6],
      color: new Color(0.2, 1.0, 0.5, 1.0),
      emission: new Color(0.2, 1.0, 0.5, 1.0), emissionEnergy: 2.0,
    }));
    animate(led, "blink", 1.5 + i * 0.7, 0.0, i * 0.9);
  }

  // The centre piece: a holo-table projecting a slowly spinning "core".
  addTo(g, G3.mesh("cylinder", {
    radius: 1.6, height: 0.9, position: [0.0, 0.45, 0.0],
    color: new Color(0.12, 0.13, 0.17, 1.0), metallic: 0.7, roughness: 0.3,
  }));
  addTo(g, G3.mesh("cylinder", {
    radius: 1.7, height: 0.08, position: [0.0, 0.94, 0.0],
    color: accent(), emission: accent(), emissionEnergy: 1.4,
  }));
  let holo = addTo(g, G3.mesh("torus", {
    innerRadius: 0.75, outerRadius: 1.05, position: [0.0, 2.2, 0.0],
    color: new Color(0.4, 0.95, 0.85, 0.9),
    emission: accent(), emissionEnergy: 2.2,
  }));
  animate(holo, "spin", 0.7, 2.2, 0.0);
  let holoCore = addTo(g, G3.mesh("sphere", {
    radius: 0.42, position: [0.0, 2.2, 0.0],
    color: new Color(0.85, 1.0, 0.95, 1.0),
    emission: new Color(0.5, 1.0, 0.9, 1.0), emissionEnergy: 2.6,
  }));
  animate(holoCore, "bob", 1.1, 2.2, 0.5);

  // The game shelf: an arcade cabinet + cartridge pedestals along the back.
  addTo(g, G3.mesh("box", {
    size: [2.2, 3.4, 1.4], position: [6.5, 1.7, -7.6],
    color: new Color(0.14, 0.1, 0.2, 1.0), roughness: 0.5,
  }));
  addTo(g, G3.mesh("box", {
    size: [1.8, 1.2, 0.1], position: [6.5, 2.6, -6.9],
    rotation: [-12.0, 0.0, 0.0],
    color: new Color(0.3, 0.9, 1.0, 1.0),
    emission: new Color(0.3, 0.9, 1.0, 1.0), emissionEnergy: 1.8,
  }));

  buildPedestals();
}

// One pedestal + floating cartridge per discovered game (up to 5).
function buildPedestals() {
  let count = S.games.length;
  if (count > 5) {
    count = 5;
  }
  for (let i = 0; i < count; i++) {
    let x = -6.0 + i * 3.0;
    let z = -6.5;
    addTo(S.garage, G3.mesh("cylinder", {
      radius: 0.55, height: 1.1, position: [x, 0.55, z],
      color: new Color(0.13, 0.14, 0.18, 1.0), metallic: 0.6, roughness: 0.4,
    }));
    addTo(S.garage, G3.mesh("cylinder", {
      radius: 0.62, height: 0.06, position: [x, 1.13, z],
      color: accent(), emission: accent(), emissionEnergy: 1.2,
    }));
    let cart = addTo(S.garage, G3.mesh("box", {
      size: [0.7, 0.9, 0.18], position: [x, 2.0, z],
      color: new Color(0.9, 0.9, 0.95, 1.0),
      emission: gameAccent(S.games[i]), emissionEnergy: 1.5,
    }));
    animate(cart, "spin", 0.9 + i * 0.13, 2.0, i * 1.3);
    animate(cart, "bob", 0.8, 2.0, i * 0.7);
    S.pedestals.push(cart);
  }
}

// Parse a game's "#rrggbb" accent into a Color (fallback: platform accent).
function gameAccent(manifest) {
  if (manifest == null || manifest.accent == null) {
    return accent();
  }
  let hex = "" + manifest.accent;
  if (!hex.startsWith("#") || hex.length != 7) {
    return accent();
  }
  let hv = (c) => {
    let d = "0123456789abcdef".indexOf(c.lower());
    return d < 0 ? 0 : d;
  };
  let r = (hv(hex.charAt(1)) * 16 + hv(hex.charAt(2))) / 255.0;
  let gg = (hv(hex.charAt(3)) * 16 + hv(hex.charAt(4))) / 255.0;
  let b = (hv(hex.charAt(5)) * 16 + hv(hex.charAt(6))) / 255.0;
  return new Color(r, gg, b, 1.0);
}

// Per-frame garage life: camera drift + prop animation.
function garageTick(d) {
  if (S.phase != "garage") {
    return;
  }
  S.camAngle = S.camAngle + d * 0.08;
  let cx = sin(S.camAngle) * 2.2;
  GD.beginBatch();
  S.garageCam.set("position", new Vector3(cx, 4.2 + 0.15 * sin(S.camAngle * 2.0), 11.0));
  S.garageCam.set("rotation_degrees", new Vector3(-14.0, -cx * 2.2, 0.0));
  for (let i = 0; i < S.anims.length; i++) {
    let a = S.anims[i];
    a.phase = a.phase + d * a.speed;
    if (a.kind == "spin") {
      a.node.set("rotation_degrees", new Vector3(0.0, a.phase * 57.29578, 0.0));
    } else if (a.kind == "bob") {
      let p = a.node.get("position");
      a.node.set("position", new Vector3(p.x, a.base + 0.12 * sin(a.phase * 2.0), p.z));
    } else if (a.kind == "blink") {
      a.node.set("visible", sin(a.phase * 3.0) > -0.4);
    }
  }
  GD.endBatch();
}

// ---------------------------------------------------------------------------
// HUD pages (transparent — the 3D garage shows through)
// ---------------------------------------------------------------------------

function buildGaragePage() {
  let t = VUI.theme();

  S.playerChip = VUI.text("…", { size: t.fontS, color: accent() });

  let topBar = VUI.row({
    gap: 12, pad: 18,
    children: [
      VUI.avatar("CG", { color: accent(), size: 64.0 }),
      VUI.column({
        gap: 2,
        children: [
          VUI.title("CaspiGames", { size: t.fontM }),
          S.playerChip,
        ],
      }),
    ],
  });

  let bottom = VUI.row({
    gap: 12, pad: 18,
    children: [
      VUI.expand(VUI.button("🎮 GAMES", { wide: true, onTap: () => { openGamesSheet(); } })),
      VUI.expand(VUI.button("👤 PROFILE", { kind: "tonal", wide: true, onTap: () => { openProfileSheet(); } })),
      VUI.expand(VUI.button("🏆 RANKS", { kind: "tonal", wide: true, onTap: () => { openRanksSheet(); } })),
      VUI.expand(VUI.button("⬡ SYSTEM", { kind: "ghost", wide: true, onTap: () => { openSystemSheet(); } })),
    ],
  });

  let page = VUI.column({
    gap: 0,
    children: [topBar, VUI.spacer(), bottom],
  });
  return page;
}

function buildGamePage() {
  let t = VUI.theme();
  S.gameTitleLabel = VUI.text("", { size: t.fontS, color: accent() });
  let top = VUI.row({
    gap: 12, pad: 14,
    children: [
      S.gameTitleLabel,
      VUI.spacer(),
      VUI.button("✕ EXIT", {
        kind: "danger",
        onTap: () => { closeGame("exited from the HUD"); },
      }),
    ],
  });
  return VUI.column({ gap: 0, children: [top, VUI.spacer()] });
}

function refreshPlayerChip() {
  if (S.playerChip == null) {
    return;
  }
  if (S.profile == null) {
    S.playerChip.set("text", S.playerName);
    return;
  }
  S.playerChip.set("text",
    S.profile.name + " · LVL " + S.profile.level + " · " + S.profile.coins + "¢");
}

function showPhase(phase) {
  S.phase = phase;
  S.connectPage.set("visible", phase == "connect");
  S.garagePage.set("visible", phase == "garage");
  S.gamePage.set("visible", phase == "game");
}

function enterGarage() {
  buildGarage();
  refreshPlayerChip();
  showPhase("garage");
  VUI.toast("welcome to the garage", { kind: "success" });
}

// ---------------------------------------------------------------------------
// sheets: games / profile / ranks / system
// ---------------------------------------------------------------------------

function openGamesSheet() {
  let t = VUI.theme();
  refreshGames(() => {});
  let tiles = [];
  for (let i = 0; i < S.games.length; i++) {
    let game = S.games[i];
    tiles.push(VUI.listTile({
      leading: "" + (game.icon ?? "▣"),
      leadingColor: gameAccent(game),
      title: "" + game.title,
      subtitle: game.developer + " · v" + game.version + " · " + (game.plays ?? 0) + " plays",
      trailing: "▶",
      onTap: () => { openGame(game); },
    }));
  }
  if (tiles.length == 0) {
    tiles.push(VUI.text("No games on this node yet — deploy some with the CaspiGames publisher tooling.", { size: t.fontXS, dim: true, wrap: true }));
  }
  VUI.sheet({
    title: "GAME SHELF — " + S.games.length + " deployed",
    children: tiles,
  });
}

function openProfileSheet() {
  let t = VUI.theme();
  S.caspi.call("profiles", "me", {}, (r) => {
    if (r == null || r.ok != true) {
      VUI.toast("profile unavailable", { kind: "danger" });
      return;
    }
    S.profile = r.profile;
    refreshPlayerChip();
    let nameField = VUI.field({ label: "DISPLAY NAME", value: "" + S.profile.name });
    VUI.sheet({
      title: "PILOT PROFILE",
      children: [
        VUI.row({
          gap: 16,
          children: [
            VUI.avatar(("" + S.profile.name).substring(0, 2).upper(), { color: accent(), size: 84.0 }),
            VUI.column({
              gap: 4,
              children: [
                VUI.title("" + S.profile.name, { size: t.fontM }),
                VUI.caption("LEVEL " + S.profile.level + " · " + S.profile.xp + " XP · " + S.profile.coins + " coins · " + S.profile.plays + " plays"),
              ],
            }),
          ],
        }),
        VUI.divider(),
        nameField.node,
        VUI.button("SAVE NAME", {
          wide: true,
          onTap: () => {
            S.caspi.call("profiles", "setName", { name: nameField.getText() }, (rr) => {
              if (rr != null && rr.ok == true) {
                S.profile = rr.profile;
                refreshPlayerChip();
                VUI.toast("name saved", { kind: "success" });
              } else {
                VUI.toast("rename failed", { kind: "danger" });
              }
            });
          },
        }),
      ],
    });
  });
}

function openRanksSheet() {
  let t = VUI.theme();
  if (S.games.length == 0) {
    VUI.toast("no games to rank yet", { kind: "warning" });
    return;
  }
  let listBox = VUI.column({ gap: 10, children: [] });
  let chips = [];
  let loadBoard = (game) => {
    S.caspi.call("leaderboard", "top", { gameId: "" + game.id, count: 10 }, (r) => {
      // Rebuild the list in place.
      let kids = listBox.call("get_children");
      if (__isType(kids, "List")) {
        for (let i = 0; i < kids.length; i++) {
          kids[i].call("queue_free");
        }
      }
      if (r == null || r.ok != true || !__isType(r.entries, "List") || r.entries.length == 0) {
        listBox.call("add_child", [__vuiNode(VUI.text("No scores yet — set the first one!", { size: t.fontXS, dim: true }))]);
        return;
      }
      for (let i = 0; i < r.entries.length; i++) {
        let e = r.entries[i];
        listBox.call("add_child", [__vuiNode(VUI.listTile({
          leading: "" + (i + 1),
          leadingColor: i == 0 ? new Color(1.0, 0.85, 0.3, 1.0) : accent(),
          title: "" + e.name,
          subtitle: "score " + e.score,
          trailing: i == 0 ? "👑" : "",
        }))]);
      }
    });
  };
  for (let i = 0; i < S.games.length; i++) {
    let game = S.games[i];
    chips.push(VUI.chip("" + game.title, {
      selected: i == 0,
      onTap: (on) => { loadBoard(game); },
    }));
  }
  VUI.sheet({
    title: "LEADERBOARDS",
    children: [
      VUI.scroll({ horizontal: true, child: VUI.row({ gap: 10, children: chips }) }),
      listBox,
    ],
  });
  loadBoard(S.games[0]);
}

function openSystemSheet() {
  let t = VUI.theme();
  let me = VMs.info();
  let vmLine = "root vm";
  if (__isType(me, "Map")) {
    vmLine = "vm " + me["id"] + " · " + me["label"] + (me["scene"] == true ? " · whole-scene" : "");
  }
  let svcLines = [];
  let services = S.caspi.services();
  let names = services.keys;
  for (let i = 0; i < names.length; i++) {
    let svc = services[names[i]];
    svcLines.push(VUI.listTile({
      leading: "⬢",
      leadingColor: accent(),
      title: "" + svc.name,
      subtitle: "creature " + svc.creatureId + "\nprogram " + svc.programId + " · entity " + svc.entityId,
    }));
  }
  VUI.sheet({
    title: "SYSTEM",
    children: [
      VUI.card({
        gap: 8,
        children: [
          VUI.title("This client", { size: t.fontM }),
          VUI.caption(vmLine),
          VUI.caption("node " + (S.node != null ? S.node.status() : "-") + " · user " + (S.node != null ? S.node.userId() : "-")),
        ],
      }),
      VUI.caption("DISCOVERED SERVICES (via the 'main' creature)"),
      VUI.column({ gap: 10, children: svcLines }),
    ],
  });
}

// ---------------------------------------------------------------------------
// game loading: fetch chunks -> compose shim + source -> sandboxed child VM
// ---------------------------------------------------------------------------

var loader = { game: null, total: 0, next: 0, bytes: [] };

function openGame(game) {
  if (S.loading || S.phase == "game") {
    return;
  }
  S.loading = true;
  S.currentGame = game;
  VUI.toast("loading " + game.title + " …", { kind: "info" });
  S.caspi.call("games", "get", { gameId: "" + game.id }, (r) => {
    if (r == null || r.ok != true) {
      S.loading = false;
      VUI.toast("game manifest unavailable", { kind: "danger" });
      return;
    }
    let manifest = r.game;
    let total = int(num("" + (manifest.chunks ?? 0)));
    if (total <= 0 || manifest.published != true) {
      S.loading = false;
      VUI.toast("game has no published build", { kind: "danger" });
      return;
    }
    loader.game = manifest;
    loader.total = total;
    loader.next = 0;
    loader.bytes = [];
    loadNextChunk();
  });
}

function loadNextChunk() {
  if (loader.next >= loader.total) {
    launchGame();
    return;
  }
  S.caspi.call("games", "getChunk", {
    gameId: "" + loader.game.id, idx: loader.next,
  }, (r) => {
    if (r == null || r.ok != true || r.chunk == null) {
      S.loading = false;
      VUI.toast("source download failed (chunk " + loader.next + ")", { kind: "danger" });
      return;
    }
    let part = base64Decode("" + r.chunk.data);
    for (let i = 0; i < part.length; i++) {
      loader.bytes.push(part[i]);
    }
    loader.next = loader.next + 1;
    loadNextChunk();
  });
}

function launchGame() {
  let source = utf8Decode(loader.bytes);
  let game = loader.game;
  loader.bytes = [];
  S.loading = false;

  // A fresh pod node = the game's whole world; the child VM is sandboxed to
  // this subtree and budgeted. vm_manage stays granted: the `vm.*` family
  // carries the Caspi SDK's parent-messaging channel (vm.send), and every
  // vm.* verb is already tree-authorized — a game can only manage its OWN
  // descendants, which live inside its pod and count against its budget.
  S.pod = G3.node({});
  GD.mount(S.pod);

  let child = VMs.spawn(caspiShim + source, S.pod, {
    label: "game:" + game.id,
    lang: "js",
    limits: { instructionsPerTurn: 8000000, maxMemoryBytes: 64000000 },
  });
  if (child == null) {
    S.pod.queueFree();
    S.pod = null;
    VUI.toast("sandbox spawn denied", { kind: "danger" });
    return;
  }
  S.child = child;

  // Hide the garage while the game owns the screen (its camera takes over).
  S.garage.set("visible", false);
  S.gameTitleLabel.set("text", "" + game.title + " — " + game.developer);
  showPhase("game");

  // Count the play (fire-and-forget, both registry and profile).
  S.caspi.call("games", "recordPlay", { gameId: "" + game.id }, null);
  S.caspi.call("profiles", "recordPlay", { gameId: "" + game.id }, null);
  print("caspigames: launched " + game.id + " in child vm " + child.id);
}

function closeGame(reason) {
  if (S.phase != "game") {
    return;
  }
  if (S.child != null) {
    S.child.terminate();
    S.child = null;
  }
  if (S.pod != null) {
    S.pod.queueFree();
    S.pod = null;
  }
  S.garage.set("visible", true);
  S.garageCam.set("current", true);
  showPhase("garage");
  // Refresh profile (the game may have earned XP / coins).
  S.caspi.call("profiles", "me", {}, (r) => {
    if (r != null && r.ok == true) {
      S.profile = r.profile;
      refreshPlayerChip();
    }
  });
  VUI.toast("back to the garage (" + reason + ")", { kind: "info" });
}

// ---------------------------------------------------------------------------
// the child->parent service proxy (the platform side of the Caspi SDK)
// ---------------------------------------------------------------------------

// Reply through the sender's vm id: a game can message during its boot,
// inside the spawn call, before S.child could have been assigned.
function replyToChild(sender, id, payload) {
  VMs.of(sender).send(jsonStringify({ caspi: "result", id: id, payload: payload }));
}

function handleGameRequest(sender, m) {
  let op = "" + m.caspi;
  let id = m.id;
  let payload = m.payload ?? {};
  let game = S.currentGame;

  if (op == "ready") {
    VUI.toast("" + game.title + " ready", { kind: "success" });
    return;
  }
  if (op == "exit") {
    closeGame("game exited");
    return;
  }
  if (op == "info") {
    replyToChild(sender, id, { ok: true, game: game, player: S.profile });
    return;
  }
  if (op == "submitScore") {
    let name = S.profile != null ? "" + S.profile.name : S.playerName;
    S.caspi.call("leaderboard", "submit", {
      gameId: "" + game.id, score: payload.score, name: name,
    }, (r) => { replyToChild(sender, id, r); });
    return;
  }
  if (op == "top") {
    S.caspi.call("leaderboard", "top", {
      gameId: "" + game.id, count: payload.count,
    }, (r) => { replyToChild(sender, id, r); });
    return;
  }
  if (op == "grant") {
    S.caspi.call("profiles", "grant", {
      xp: payload.xp, coins: payload.coins,
    }, (r) => {
      if (r != null && r.ok == true) {
        S.profile = r.profile;
        refreshPlayerChip();
      }
      replyToChild(sender, id, r);
    });
    return;
  }
  replyToChild(sender, id, { ok: false, error: "unknown platform op: " + op });
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

function main() {
  VUI.use(VUI.themeDark());

  // Transparent app shell: the 3D garage lives underneath the HUD.
  S.app = VUI.app({ design: [720, 1280], portrait: true, bg: false });

  S.connectPage = S.app.push(buildConnectPage());
  S.garagePage = S.app.push(buildGaragePage());
  S.gamePage = S.app.push(buildGamePage());
  showPhase("connect");

  // Give the connect page its own opaque backdrop (the app shell is bg-less).
  // Reuse the sheet styling: a full-rect Panel behind the form.
  let backdrop = GD.create("Panel");
  backdrop.call("set_anchors_preset", [GInt(GD.constant("Control.PRESET_FULL_RECT"))]);
  backdrop.set("theme_override_styles/panel", VUI.styleBox({ bg: new Color(0.03, 0.04, 0.07, 1.0) }));
  backdrop.set("mouse_filter", GInt(2));
  S.connectPage.call("add_child", [backdrop]);
  S.connectPage.call("move_child", [backdrop, GInt(0)]);

  // Child-VM plumbing: platform requests + failure containment.
  VMs.onMessage((sender, msg) => {
    let m = jsonParse("" + msg);
    if (m == null || m.caspi == null) {
      return;
    }
    handleGameRequest(sender, m);
  });
  VMs.onChildTrapped((kind, vmId, detail) => {
    print("caspigames: game vm " + vmId + " trapped: " + detail);
    closeGame("game exceeded its budget");
  });
  VMs.onChildTerminated((kind, vmId, detail) => {
    print("caspigames: game vm " + vmId + " terminated (" + detail + ")");
  });

  GD.onProcess((d) => { garageTick(d); });

  print("caspigames: client up — waiting for connect form");
}

main();
