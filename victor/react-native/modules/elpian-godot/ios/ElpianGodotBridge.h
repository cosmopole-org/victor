// ObjC surface over the shared C++ Godot op queue (implemented in
// ElpianGodotBridge.mm → the extern-"C" entries of cpp/ElpianGodotJsi.cpp). Swift
// (the module + the Godot host view's OpSink drain) talks to this, keeping the
// JSI/queue code identical to Android.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ElpianGodotBridge : NSObject
/// Install global.__ElpianGodot on the given jsi::Runtime pointer; status string.
+ (NSString *)installWithRuntimePointer:(uintptr_t)runtimePtr;
/// Drain the pending 3D op messages as a JSON array string ("" when none).
+ (NSString *)pollOps;
@end

NS_ASSUME_NONNULL_END
