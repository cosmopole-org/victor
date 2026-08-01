// Local Expo module that installs the native Elpian VM JSI binding
// (global.__ElpianRN). Importing it links the module; installNative() nudges the
// native side to install the binding (bridgeless startup can hand it the JS
// runtime after OnCreate) and returns a status string for diagnostics.
import { requireNativeModule } from "expo";

interface ElpianRnNativeModule {
  install(): string;
}

let nativeModule: ElpianRnNativeModule | null = null;
let requireError: string | null = null;
try {
  nativeModule = requireNativeModule("ElpianRn") as ElpianRnNativeModule;
} catch (e) {
  requireError = String(e);
  nativeModule = null; // not present (web / Expo Go) — callers fall back
}

/**
 * Install `global.__ElpianRN` if it isn't already, returning a diagnostic
 * status: "ok" (or already installed), "module-not-found: …", or the native
 * reason it failed (loadLibrary / no-runtime-pointer / nativeInstall).
 */
export function installNative(): string {
  const g = globalThis as { __ElpianRN?: unknown };
  if (g.__ElpianRN) return "ok";
  if (!nativeModule) return `module-not-found: ${requireError ?? "unavailable"}`;
  try {
    return nativeModule.install();
  } catch (e) {
    return `install-threw: ${String(e)}`;
  }
}

/** True once the native binding is installed. */
export function ensureInstalled(): boolean {
  installNative();
  return !!(globalThis as { __ElpianRN?: unknown }).__ElpianRN;
}

export default nativeModule;
