// victor.config.mjs — configuration for the Victor build. This is the Victor
// equivalent of `next.config.js`. `tools/build.mjs` reads it to shape the guest
// program it emits.
export default {
  // Where the app mounts. These become the arguments to VUI.app() inside the
  // generated entry (`VictorClient.mountApp(<App/>, app)`).
  app: {
    // The design-space resolution; the engine content-scales it to any screen.
    design: [720, 1280],
    // Lock to portrait (DisplayServer orientation on device, a portrait window
    // on desktop). Set false for a free-aspect / landscape app.
    portrait: true,
    // "dark" | "light" — the initial VUI theme.
    theme: "dark",
  },

  // The route that renders first (matches a folder under app/, "/" = app/page).
  initialRoute: "/",

  // Output location for the compiled single-file guest program the Victor
  // engine loads (drop it into elpian/godot/project/scripts and point an
  // ElpianVM node at it, exactly like ui_demo.js).
  outFile: "build/guest.js",
};
