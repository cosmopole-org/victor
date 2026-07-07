# VICTOR: CITY STRIKE — game design document

A complete third-person shooter built **entirely in Dart on the Elpian VM**,
running inside Godot 4 through the reflective Elpian↔Godot bridge. There is no
GDScript and no engine-side game code: every node, resource, signal, physics
query and sound in the game is created and driven at runtime by
[`project/scripts/tps_main.dart`](project/scripts/tps_main.dart) over the
`GD.*` op protocol described in [README.md](README.md).

- **Scene:** `project/tps.tscn` (the project's main scene — `godot --path project` runs the game)
- **Program:** `project/scripts/tps_main.dart` (~3,000 lines of the Elpian Dart subset)
- **Assets:** `project/assets/tps/` (CC0 GLB kits by Kenney — see its `CREDITS.md`)
- **Verification:** `capi/tests/run_tps.rs` boots and plays the game headlessly on the real VM
- **Targets:** desktop (mouse + keyboard), web export, Android export (touch controls)

---

## 1. Vision

*Hold a downtown district against escalating waves of hostiles.* A fast,
readable, arcade-flavoured TPS in a stylised low-poly city at golden hour:
over-the-shoulder aiming, punchy hitscan weapons, enemies that press the
player through open streets, and a survival scoreboard that makes every run
comparable. The second goal is engineering proof: the game is the flagship
demonstration that a **no-JIT, dynamically delivered Dart program** can drive
a full game loop — physics, animation, audio, UI, AI — through one reflective
seam at production quality.

### Pillars

1. **Readable combat** — high-contrast tracers, hit markers, damage numbers,
   health bars: every exchange of fire is legible at a glance.
2. **The city is the level** — sightlines and cover come from real block
   layout (towers, malls, parked cars), not decorated corridors.
3. **Runs anywhere the VM runs** — one program serves desktop, web and
   Android; input, UI scale and pointer capture adapt at runtime.
4. **Fail loud, degrade gracefully** — every host read is guarded; missing
   assets fall back to procedural primitives; the game must run headless
   against a mock engine, in CI, forever.

## 2. Core loop

```
   deploy → intermission (banner, resupply) → wave N spawns at intersections
     → fight: kill hostiles / collect drops / hold integrity
     → wave cleared (+250, banner) → intermission → wave N+1 (bigger, meaner)
     → … → death → stats (score, kills, accuracy, waves) → redeploy
```

Session length target: 3–10 minutes per run. Difficulty is driven purely by
wave composition and count (below) — no stat scaling, so player skill reads
directly.

## 3. The city

A 17×17-cell grid, one cell = 8 m (world spans ±68 m), generated
deterministically from a seeded LCG at boot:

| Element | Rule |
|---|---|
| Roads | every 4th grid line, both axes → 5×5 road lattice with 25 intersections |
| Intersections | `road-crossroad` tiles; alternating ones get paired street lights; all 25 are **enemy spawn points** |
| Blocks | 16 blocks of 3×3 cells between roads, pavement-tiled |
| Tower blocks | inner 2×2 ring, 75%: one skyscraper (3 models, up to ~36 m) centred on the block |
| Mall blocks | 20%: one low wide `building-e` |
| Quad blocks | otherwise: up to 4 mid-rises on the corners (7 models, random yaw), centre left open as a **plaza** (pickup spawns) |
| Street props | 14 parked cars (6 models) along kerbs, boundary walls, one big asphalt slab |
| Collision | every structure gets an invisible `StaticBody3D` box sized from the model's *measured* GLB footprint (layer 1) |

Player spawns at the central intersection. Enemies pick intersections ≥ 22 m
away. The whole build is ~140 mounted branches, assembled in batched ops in a
single boot frame.

**Lighting/mood:** ProceduralSky (warm horizon / deep zenith), one shadowed
`DirectionalLight3D` at a late-afternoon angle, ACES tonemap, soft glow,
distance fog. No per-lamp lights — the muzzle flash `OmniLight3D` is the only
dynamic light, so the mobile renderer stays comfortable.

## 4. The player

| System | Design |
|---|---|
| Body | `CharacterBody3D` + capsule (r 0.38, h 1.8), layer 2 |
| Model | Kenney `character-a` (scale 0.7 ≈ 1.9 m), blaster attached to the `arm-right` node |
| Camera | rig → yaw → pitch → `SpringArm3D` (clips against world) → shoulder-offset `Camera3D` |
| Move | walk 5.2 m/s · sprint 8.2 (FOV 75→83) · aim-walk 3.0 · accel-smoothed |
| Jump | 8 m/s impulse, gravity 22 m/s² |
| Aim (ADS) | spring 3.4 m→1.5 m, FOV→52, spread ×0.35 |
| Health | 100, regenerating 14/s after 5 s without damage; red vignette + shake on hit |
| Facing | model turns toward travel direction; combat (aim/fire) locks it to camera yaw |
| Animation | `holding-right` idle · `walk` · `sprint` · `holding-right-shoot` on fire · driven with cross-blend via `AnimationPlayer.play(name, 0.18)` |

## 5. Combat

Hitscan raycasts through `PhysicsDirectSpaceState3D.intersect_ray` (mask:
world + enemies, player excluded). Headshot = impact ≥ 1.42 m above the
target's feet → ×2 damage, bonus score, distinct pitch.

| Weapon | Mode | Mag | Reserve | Damage | RPS | Spread | Reload |
|---|---|---|---|---|---|---|---|
| **PULSE RIFLE** | auto | 30 | 120 | 12 | 9.0 | 0.020 rad | 1.4 s |
| **ARC CANNON** | semi | 6 | 24 | 55 | 1.6 | 0.006 rad | 2.0 s |

Switch: `Q`/wheel cycles, `1`/`2` direct; both models ride the same hand node
with visibility toggled. Empty trigger auto-reloads.

**Feedback stack per shot:** muzzle light pulse → pooled tracer beam (70 ms)
→ impact spark (pooled, grows & fades) or damage number (pooled `Label3D`,
floats up) → hitmarker cross on the crosshair → recoil pitch kick + camera
shake → synthesized report with random pitch. Crosshair is dynamic-less by
design (fixed, high-visibility) to keep the centre clean.

## 6. Enemies

Three archetypes on one AI chassis (`CharacterBody3D`, capsule, layer 4,
billboard health bar, Kenney character + blaster in hand):

| Archetype | Model | HP | Speed | Damage | Fire interval | Accuracy | Score |
|---|---|---|---|---|---|---|---|
| **Grunt** | character-b / p | 60 | 3.6 | 7 | 0.7–1.2 s | 0.34 | 100 |
| **Runner** | character-h | 35 | 6.2 | 5 | 0.7–1.2 s | 0.26 | 150 |
| **Heavy** | character-m + arc cannon | 150 | 2.5 | 15 | 1.2–1.7 s | 0.42 | 250 |

State machine: `spawn (0.6 s) → chase → attack → (dead)`.

- **Chase:** steer straight at the player (`move_and_slide` handles sliding
  along buildings — the road grid keeps paths open), sprint anim for runners.
- **Attack:** entered inside 17 m; hold ~8 m standoff, strafe with random
  direction flips, fire on a jittered timer. Every shot runs a **line-of-sight
  raycast** (world + player): cover blocks the shot (tracer + spark on the
  obstacle, drop back to chase); a clear line rolls accuracy scaled by
  distance. Getting shot while chasing can provoke an early attack.
- **Death:** `die` animation, collision off, health bar hidden, score + kill
  feed entry, 35% pickup drop, corpse sinks and frees after 2.6 s.

Accuracy-roll gunfire (rather than projectile simulation) keeps enemy fire
readable and fair while costing one ray per shot — and it still traces
visually from the muzzle every time.

## 7. Waves & economy

- Wave `N` = `4 + 2N` hostiles (cap 18), ≤ 12 alive at once, spawned 0.75 s
  apart at far intersections.
- Composition: runners join from wave 2 (every 3rd spawn), heavies from wave
  3 (every 5th spawn).
- Clear bonus +250, then a 6 s intermission with a horn and banner; plazas
  are restocked (up to 4 pickups on the map).
- Pickups: **medkit** +40 HP · **ammo cache** +60 rifle / +8 cannon reserve.
  Spinning, bobbing, emissive; collected by walking through (1.5 m).
- Game-over screen reports waves survived, score, kills, and accuracy
  (`hits/shots` — every trigger pull is accounted).

## 8. UI / UX

- **HUD** (change-driven writes only): wave/score/kills card (top-left), FPS +
  four-line fading kill feed (top-right), integrity bar that turns red under
  35% (bottom-left), weapon card with mag/reserve and reload hint
  (bottom-right), centre crosshair + hitmarker, damage vignette, centre wave
  banners. All anchored for any aspect ratio (canvas-items stretch, expand).
- **Title:** dark overlay over a live orbiting city vista, logo, DEPLOY
  button, full control listing, credits line.
- **Pause:** ESC or focus loss (browser tab switch auto-pauses); resume /
  abandon-to-menu. **Game over:** stats + REDEPLOY.
- **Touch** (auto-enabled when a touchscreen is present): fixed virtual stick
  (bottom-left, sprint at full deflection), drag-to-look on the open screen,
  and circular FIRE / AIM (toggle) / JUMP / R / SWAP buttons bottom-right.
  Multi-touch roles are tracked per finger index; stick/look/button regions
  never steal from each other.

### Controls (desktop)

| Input | Action |
|---|---|
| WASD / mouse | move / look (pointer captured) |
| LMB (hold) / RMB (hold) | fire / aim down sights |
| SHIFT / SPACE / R | sprint / jump / reload |
| Q · wheel · 1 · 2 | weapon switch |
| ESC | pause / resume (releases pointer) |

## 9. Audio

Zero audio files. Every sound is **synthesized offline into raw PCM**
(filtered noise bursts, sine thumps, chirps — the generator script lives in
the session tooling and its output is embedded in `tps_main.dart` as base64
`AudioStreamWAV` data): rifle report, cannon boom, hit tick, hurt thud,
two-click reload, death chime, pickup chime, empty click, wave horn, and a
2.5 s looping city-wind ambience. Playback runs through a six-voice
round-robin `AudioStreamPlayer` pool with per-shot random pitch (±8%) so
rapid fire never machine-guns a single sample.

## 10. Technical architecture (why this runs well on a VM seam)

The bridge's cost model is *seam crossings*, not engine calls — the game is
built around it:

1. **Batch everything per subsystem.** Steady state is ~5 crossings/frame:
   one input poll (12 reads), one player batch (physics step + camera + model
   + anim), one enemy batch (4 ops per live enemy, results decoded by
   recorded slot indices), one effects batch, one HUD batch when dirty.
   Construction (city, pools, UI) is fully batched at boot.
2. **Predict, then reconcile.** Player and enemy positions integrate in Dart
   every frame; the batched `get_position` answer overwrites the prediction
   when it arrives. Under the mock (or a hiccup) the prediction *is* the
   simulation — this is what lets `run_tps.rs` play a full mission headless,
   with enemies closing in and killing the player, against a host that
   answers `null` to everything.
3. **Guard every read.** `is Vector3` / `is Map` / `== true` on all host
   replies; assets load only behind `ResourceLoader.exists()`; characters,
   buildings and guns all have procedural-primitive fallbacks.
4. **Pool the transients.** Tracers (10), impact sparks (8), damage numbers
   (6) are pre-built nodes toggled by visibility — zero allocation during
   combat. Sounds reuse 6 players. One shared muzzle light.
5. **Layered physics.** world = 1, player = 2, enemies = 4. Player rays mask
   1|4, enemy LOS rays mask 1|2, spring arm clips on 1 only — no
   self-hits, no friendly-fire ambiguity, and hit attribution rides
   `set_meta("enemy_ix", …)` on the body.
6. **Handles are released.** Every forwarded `InputEvent` is read and freed
   in a single batched crossing, so the handle table never grows with input.

### Verification

`cargo test -p elpian-godot-capi --test run_tps` compiles the real program
with dart2elpian, boots it on a real VM against a mock engine and asserts the
whole arc: boot logs → city mounted (≥60 branches) → menu frames → mission
start → wave 1 deployed → hostiles wear the player down to a game over →
clean restart → debug hooks fire a shot, score a kill and report status —
with a watchdog so a wedged frame loop fails fast. The pre-existing 26-test
bridge suite and the multi-VM demo test stay green alongside.

### Performance budget

| Metric | Budget | Notes |
|---|---|---|
| Seam crossings / frame | ≤ 8 | ~5 typical in combat |
| Ops / frame (12 enemies) | ≤ ~120 | one JSON marshal each way per crossing |
| Scene nodes | < 1,000 | city ~400 branches, low-poly meshes shared via `PackedScene` |
| Dynamic lights | 1 | muzzle flash only |
| Per-kill allocations | 0 nodes | pools + visibility toggles |

## 11. Asset pipeline

CC0 GLB kits by [Kenney](https://kenney.nl) (see
`project/assets/tps/CREDITS.md`): City Kit Commercial (11 buildings), City
Kit Roads (5 tiles + 2 lights), Car Kit (6 vehicles), Blaster Kit (3
weapons), Blocky Characters (5 **rigged, animated** characters — the game
drives their shipped `idle/walk/sprint/die/holding-right(-shoot)` clips).
Footprints for collision boxes were measured from the glTF accessors, not
eyeballed. Scale system: 1 road tile = 8 m (kit ×8), characters ×0.7 ≈ 1.9 m,
cars ×1.7. Everything imports through Godot's stock glTF path — CI's headless
`--import` step covers web/Android exports.

## 12. Future work

- Nav-aware AI (NavigationServer3D regions over the road grid) for
  flanking routes instead of straight-line steering.
- Projectile weapons (grenade arcs) using the same pooled-effects chassis.
- A second district theme (suburban kit) and a day/night cycle.
- Co-op: the multi-VM tree is the natural host — one sandboxed child VM per
  remote player's replicated actor.
- Persistent high scores via the VM's storage capability.

## 13. Credits

- **Design / code:** the Elpian TPS program (`tps_main.dart`), written for
  this repository.
- **3D assets:** Kenney (kenney.nl), CC0.
- **Audio:** synthesized for this project (CC0, embedded PCM).
- **Engine:** Godot 4.3 via the Elpian↔Godot reflective bridge; execution by
  the Elpian VM (no JIT, App-Store-legal).
