// ObjC++ implementation of the widget bridge: thin forwards to the shared
// extern-"C" entries in cpp/ElpianWidgetsJsi.cpp (the same file Android builds).
#import "ElpianWidgetsBridge.h"

extern "C" void ElpianWidgetsInstall(void *jsiRuntimePtr);
extern "C" const char *ElpianWidgetsDrainOps(const char *appId);
extern "C" void ElpianWidgetsPushEvent(const char *appId, long long id, const char *event,
                                       const char *argJson);

@implementation ElpianWidgetsBridge

+ (NSString *)installWithRuntimePointer:(uintptr_t)runtimePtr {
  if (runtimePtr == 0) return @"no-runtime-pointer";
  @try {
    ElpianWidgetsInstall(reinterpret_cast<void *>(runtimePtr));
    return @"ok";
  } @catch (NSException *e) {
    return [NSString stringWithFormat:@"nativeInstall: %@", e.reason];
  }
}

+ (NSString *)drainOps:(NSString *)appId {
  const char *out = ElpianWidgetsDrainOps(appId.UTF8String);
  NSString *s = out ? [NSString stringWithUTF8String:out] : @"";
  free((void *)out); // ElpianWidgetsDrainOps returns a malloc'd buffer
  return s;
}

+ (void)pushEvent:(NSString *)appId id:(long long)widgetId event:(NSString *)event arg:(NSString *)argJson {
  ElpianWidgetsPushEvent(appId.UTF8String, widgetId, event.UTF8String,
                         argJson ? argJson.UTF8String : NULL);
}

@end
