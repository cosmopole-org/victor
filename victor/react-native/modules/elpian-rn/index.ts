// Local Expo module that installs the native Elpian VM JSI binding
// (global.__ElpianRN). Importing it ensures the module is linked; calling
// ensureInstalled() nudges the native side to install the binding if bridgeless
// startup handed it the JS runtime too late for OnCreate.
import { requireNativeModule } from "expo";

interface ElpianRnNativeModule {
  install(): boolean;
}

let nativeModule: ElpianRnNativeModule | null = null;
try {
  nativeModule = requireNativeModule("ElpianRn") as ElpianRnNativeModule;
} catch {
  nativeModule = null; // not present (web / Expo Go) — callers fall back
}

/**
 * Ensure `global.__ElpianRN` is installed. The native module installs it at
 * OnCreate; if the runtime wasn't ready yet (bridgeless), this retries. Returns
 * true when the binding is available.
 */
export function ensureInstalled(): boolean {
  const g = globalThis as { __ElpianRN?: unknown };
  if (g.__ElpianRN) return true;
  try {
    return nativeModule?.install() ?? false;
  } catch {
    return false;
  }
}

export default nativeModule;
