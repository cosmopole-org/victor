// Expo Metro config for the sample app.
//
//  * `.wasm` as an asset — so a static web export can serve the Elpian VM module
//    (though this app loads it via fetch from public/, the extension is still
//    registered for completeness).
//  * Package exports ON — `victor-react-native`'s library entry lives in its
//    package `exports` map (its `main` is the library's own demo), so exports
//    resolution is what makes `import { … } from "victor-react-native"` land on
//    the library rather than the demo.
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push("wasm");
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
