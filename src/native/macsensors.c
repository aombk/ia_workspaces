/*
 * Every temperature sensor a Mac will name, one per line, and nothing else.
 *
 * This exists because macOS is the one platform where the readings are free but
 * unreachable. On Linux they are files under /sys and on Windows they are behind
 * a signed kernel driver this app will not ship — but on a Mac the processor and
 * NAND sensors are readable by any process, with no administrator and no driver,
 * through an API that has no command-line spelling. `ioreg` lists the sensors
 * and will not give their values; `powermetrics` gives values and needs root,
 * and on Apple Silicon does not report a die temperature at all. What is left is
 * IOHIDEventSystem, which is C, which is this file.
 *
 * A separate executable rather than a native Node module, and that is the whole
 * design decision here. A module would tie the app to a Node ABI, need
 * rebuilding for every Electron version, need building twice and lipo'd together
 * for a universal app, and would put a compiler in the way of `npm install`. A
 * 30 KB binary that prints two columns needs none of that: the collector spawns
 * it exactly as it already spawns `ioreg`, `vm_stat` and `diskutil`, and where
 * it is missing or refuses to run there is simply no reading — which is the same
 * thing that happens on a Windows machine with no sensor source, and already
 * handled.
 *
 * The symbols are private. They are declared here because they are in no public
 * header, and they are what every temperature monitor on macOS uses — the API
 * has carried the same shape since the SMC stopped being readable directly. If a
 * release ever changes it, `IOHIDEventSystemClientCreate` returns null, this
 * prints nothing, exits 1, and the panel says no sensor answered. There is no
 * failure mode here that is worse than the absence this replaces.
 *
 * Deliberately not filtered. Which of these is a processor and which is a
 * calibration constant is a judgement, judgements change, and a judgement
 * compiled into a binary can only be changed by recompiling it. So everything
 * the machine will say goes to stdout and `parseMacSensors` in `systemStats.ts`
 * decides — where it is covered by the test suite, which this cannot be.
 *
 * Built by `build.mjs` on macOS only. See `resources/bin`.
 */
#include <CoreFoundation/CoreFoundation.h>
#include <stdio.h>

typedef struct __IOHIDEvent *IOHIDEventRef;
typedef struct __IOHIDServiceClient *IOHIDServiceClientRef;
typedef struct __IOHIDEventSystemClient *IOHIDEventSystemClientRef;

extern IOHIDEventSystemClientRef IOHIDEventSystemClientCreate(CFAllocatorRef allocator);
extern void IOHIDEventSystemClientSetMatching(IOHIDEventSystemClientRef client, CFDictionaryRef match);
extern CFArrayRef IOHIDEventSystemClientCopyServices(IOHIDEventSystemClientRef client);
extern CFTypeRef IOHIDServiceClientCopyProperty(IOHIDServiceClientRef service, CFStringRef key);
extern IOHIDEventRef IOHIDServiceClientCopyEvent(IOHIDServiceClientRef service, int64_t type,
                                                 int32_t options, int64_t timeout);
extern double IOHIDEventGetFloatValue(IOHIDEventRef event, int32_t field);

/* Apple's own HID usage page, and the usage the temperature sensors sit on. */
#define PAGE_APPLE_VENDOR 0xff00
#define USAGE_TEMPERATURE 5
#define EVENT_TEMPERATURE 15
/* A field is the event type in the high half and the field index in the low. */
#define FIELD_TEMPERATURE (EVENT_TEMPERATURE << 16)

int main(void) {
  int page = PAGE_APPLE_VENDOR;
  int usage = USAGE_TEMPERATURE;
  CFNumberRef pageRef = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &page);
  CFNumberRef usageRef = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &usage);
  if (!pageRef || !usageRef) return 1;

  const void *keys[] = {CFSTR("PrimaryUsagePage"), CFSTR("PrimaryUsage")};
  const void *values[] = {pageRef, usageRef};
  CFDictionaryRef match = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 2,
                                             &kCFTypeDictionaryKeyCallBacks,
                                             &kCFTypeDictionaryValueCallBacks);
  CFRelease(pageRef);
  CFRelease(usageRef);
  if (!match) return 1;

  IOHIDEventSystemClientRef client = IOHIDEventSystemClientCreate(kCFAllocatorDefault);
  if (!client) {
    CFRelease(match);
    return 1;
  }
  IOHIDEventSystemClientSetMatching(client, match);

  CFArrayRef services = IOHIDEventSystemClientCopyServices(client);
  CFRelease(match);
  if (!services) {
    CFRelease(client);
    return 1;
  }

  CFIndex count = CFArrayGetCount(services);
  for (CFIndex i = 0; i < count; i++) {
    IOHIDServiceClientRef service = (IOHIDServiceClientRef)CFArrayGetValueAtIndex(services, i);
    if (!service) continue;

    CFStringRef product = (CFStringRef)IOHIDServiceClientCopyProperty(service, CFSTR("Product"));
    /* A sensor with no name is one nothing downstream could classify anyway. */
    if (!product) continue;

    IOHIDEventRef event = IOHIDServiceClientCopyEvent(service, EVENT_TEMPERATURE, 0, 0);
    if (event) {
      char name[256];
      if (CFStringGetCString(product, name, sizeof(name), kCFStringEncodingUTF8)) {
        /* Degrees first so a name containing a tab cannot shift the number. */
        printf("%.2f\t%s\n", IOHIDEventGetFloatValue(event, FIELD_TEMPERATURE), name);
      }
      CFRelease(event);
    }
    CFRelease(product);
  }

  CFRelease(services);
  CFRelease(client);
  return 0;
}
