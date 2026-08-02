// ObjC surface of the iOS Elpian VM JSI installer (implemented in
// ElpianRnInstaller.mm). The Swift module calls this after resolving the JS
// runtime pointer; it forwards to the shared C++ installer. Returns a status
// string ("ok" or the reason it failed), mirroring the Android module.
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ElpianRnInstaller : NSObject
+ (NSString *)installWithRuntimePointer:(uintptr_t)runtimePtr;
@end

NS_ASSUME_NONNULL_END
