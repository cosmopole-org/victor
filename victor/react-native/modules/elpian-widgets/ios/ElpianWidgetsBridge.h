// ObjC surface over the shared C++ widget queue (implemented in
// ElpianWidgetsBridge.mm, which calls the extern-"C" entries in the shared
// cpp/ElpianWidgetsJsi.cpp). Swift (the module + VictorSurfaceView) talks to
// this instead of C directly, keeping the JSI/queue code identical to Android.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ElpianWidgetsBridge : NSObject
/// Install global.__ElpianWidgets on the given jsi::Runtime pointer; status string.
+ (NSString *)installWithRuntimePointer:(uintptr_t)runtimePtr;
/// Drain one mini app's queued ops as a JSON array string ("" when none).
+ (NSString *)drainOps:(NSString *)appId;
/// Enqueue a widget event for one mini app: [id, event, <argJson or null>].
+ (void)pushEvent:(NSString *)appId id:(int)widgetId event:(NSString *)event arg:(nullable NSString *)argJson;
@end

NS_ASSUME_NONNULL_END
