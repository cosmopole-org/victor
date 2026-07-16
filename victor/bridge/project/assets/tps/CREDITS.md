# VICTOR: CITY STRIKE — asset credits

All 3D models and textures in this directory are **CC0 (Creative Commons Zero)**
assets created and distributed by **Kenney** — https://www.kenney.nl — and were
downloaded from kenney.nl. CC0 places them in the public domain: they can be
used for personal, educational and commercial purposes with no attribution
required (credit to “Kenney” is appreciated, and given here, gladly).

License text: http://creativecommons.org/publicdomain/zero/1.0/

| Directory | Source pack | Contents used |
|---|---|---|
| `buildings/` | [City Kit (Commercial) 2.1](https://kenney.nl/assets/city-kit-commercial) | 8 mid-rise buildings + 3 skyscrapers (`building-a…h`, `building-skyscraper-a/b/e`) |
| `roads/` | [City Kit (Roads)](https://kenney.nl/assets/city-kit-roads) | road tiles (`road-straight/-crossroad/-intersection/-bend/-square`) and street lights (`light-square-double`, `light-curved`) |
| `cars/` | [Car Kit](https://kenney.nl/assets/car-kit) | street props (`sedan`, `taxi`, `police`, `van`, `delivery`, `suv`) |
| `blasters/` | [Blaster Kit 2.1](https://kenney.nl/assets/blaster-kit) | weapon models (`blaster-d` rifle, `blaster-g` heavy, `blaster-a` hostile) |
| `characters/` | [Blocky Characters 2.0](https://kenney.nl/assets/blocky-characters) | rigged, animated characters (`character-a` player; `character-b/h/m/p` hostiles) with their skin textures |

Each `.glb` references its palette texture relatively (`Textures/…png`), so
every model directory carries the texture(s) its models need.

The blocky characters ship with the full animation set the game drives at
runtime through each instance's `AnimationPlayer`: `idle`, `walk`, `sprint`,
`die`, `holding-right`, `holding-right-shoot`, and more.

All sound effects in the game are **generated procedurally** (PCM synthesized
offline, embedded in `scripts/tps_main.dart` as base64 `AudioStreamWAV` data) —
no third-party audio is used.
