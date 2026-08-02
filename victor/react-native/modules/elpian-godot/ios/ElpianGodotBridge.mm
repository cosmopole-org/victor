// ObjC++ implementation of the Godot bridge: thin forwards to the shared
// extern-"C" entries in cpp/ElpianGodotJsi.cpp (the same file Android builds).
#import "ElpianGodotBridge.h"

extern "C" void ElpianGodotInstall(void *jsiRuntimePtr);
extern "C" const char *ElpianGodotDrainOps(void);

@implementation ElpianGodotBridge

+ (NSString *)installWithRuntimePointer:(uintptr_t)runtimePtr {
  if (runtimePtr == 0) return @"no-runtime-pointer";
  @try {
    ElpianGodotInstall(reinterpret_cast<void *>(runtimePtr));
    return @"ok";
  } @catch (NSException *e) {
    return [NSString stringWithFormat:@"nativeInstall: %@", e.reason];
  }
}

+ (NSString *)pollOps {
  const char *out = ElpianGodotDrainOps();
  NSString *s = out ? [NSString stringWithUTF8String:out] : @"";
  free((void *)out); // ElpianGodotDrainOps returns a malloc'd buffer
  return s;
}

@end
