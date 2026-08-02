// iOS JSI installer for the native Elpian VM. The ObjC++ half of the module:
// it resolves the current jsi::Runtime and calls the shared, platform-agnostic
// installer (ElpianRnInstall, defined in the reused cpp/ElpianRnJsi.cpp) which
// installs global.__ElpianRN. This is the iOS analogue of the Android
// JNI nativeInstall — same C++ install(), different runtime plumbing.
//
// Runtime acquisition differs by React Native mode:
//   • bridgeless (RN 0.76 default) — the RCTHost/RCTRuntimeExecutor owns the
//     runtime; we install on the JS thread via the runtime executor.
//   • bridge — RCTCxxBridge exposes `runtime` (a jsi::Runtime&).
// The Swift module passes whichever it can obtain; if it passes 0 we report it
// so the app surfaces the exact reason, mirroring the Android status strings.

#import "ElpianRnInstaller.h"

// Declared in cpp/ElpianRnJsi.cpp (shared with Android; JNI guarded out on iOS).
extern "C" void ElpianRnInstall(void *jsiRuntimePtr);

@implementation ElpianRnInstaller

+ (NSString *)installWithRuntimePointer:(uintptr_t)runtimePtr {
  if (runtimePtr == 0) {
    return @"no-runtime-pointer";
  }
  @try {
    ElpianRnInstall(reinterpret_cast<void *>(runtimePtr));
    return @"ok";
  } @catch (NSException *e) {
    return [NSString stringWithFormat:@"nativeInstall: %@", e.reason];
  }
}

@end
