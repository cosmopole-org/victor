// Expo Metro config. `.wasm` is added as an asset so the web build serves the
// Elpian VM module, and explicit `.ts`/`.tsx` import specifiers resolve (the
// source uses them so the same files are testable under Node's type stripping).
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push("wasm");

module.exports = config;
