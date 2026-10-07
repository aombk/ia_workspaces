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
 * Two more readings ride along, for the same reason — free to any process, but
 * only through C:
 *
 * - **Drive health** (default mode, after the temperatures). The NVMe SMART
 *   log, through the `NVMeSMARTLib` plug-in macOS ships for every drive that
 *   says `NVMe SMART Capable`, Apple's own SSD included. `diskutil` reports
 *   that drive's SMART as "Not Supported"; the plug-in reports wear, spare,
 *   hours and bytes written.
 * - **Graphics** (`macsensors gpu`). Temperature from the SMC's `Tg` keys,
 *   power from IOReport's energy counters over a short window, and the
 *   memory Metal will let the GPU hold — the nearest thing unified memory has
 *   to a VRAM size.
 *
 * Every extra line is tagged in its first column, which is not a number, so a
 * reader that only knows the temperature lines skips them.
 *
 * Built by `build.mjs` on macOS only. See `resources/bin`.
 */
#include <CoreFoundation/CoreFoundation.h>
#include <IOKit/IOKitLib.h>
#include <IOKit/IOCFPlugIn.h>
#include <dlfcn.h>
#include <objc/message.h>
#include <objc/runtime.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

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

static int temperatures(void) {
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

/* ------------------------------------------------------------- drive health */

/* The plug-in's type and interface, as smartmontools declares them. */
#define NVME_SMART_TYPE                                                                  \
  CFUUIDGetConstantUUIDWithBytes(NULL, 0xAA, 0x0F, 0xA6, 0xF9, 0xC2, 0xD6, 0x45, 0x7F, \
                                 0xB1, 0x0B, 0x59, 0xA1, 0x32, 0x53, 0x29, 0x2F)
#define NVME_SMART_INTERFACE                                                             \
  CFUUIDGetConstantUUIDWithBytes(NULL, 0xCC, 0xD1, 0xDB, 0x19, 0xFD, 0x9A, 0x4D, 0xAF, \
                                 0xBF, 0x95, 0x12, 0x45, 0x4B, 0x23, 0x0A, 0xB6)

typedef struct {
  IUNKNOWN_C_GUTS;
  UInt16 version;
  UInt16 revision;
  IOReturn (*SMARTReadData)(void *self, void *log);
} NVMeSMARTInterface;

/* Little-endian, as the NVMe log is. Counters are 128-bit; the low half is
   more than any drive will reach. */
static uint64_t le64(const uint8_t *at) {
  uint64_t value = 0;
  for (int i = 7; i >= 0; i--) value = (value << 8) | at[i];
  return value;
}

/* One line per drive: `smart`, its BSD name, then the log's fields. */
static void smart(void) {
  io_iterator_t iterator;
  if (IOServiceGetMatchingServices(MACH_PORT_NULL, IOServiceMatching("IOBlockStorageDevice"),
                                   &iterator) != KERN_SUCCESS)
    return;

  io_object_t device;
  while ((device = IOIteratorNext(iterator))) {
    CFTypeRef capable = IORegistryEntryCreateCFProperty(device, CFSTR("NVMe SMART Capable"), NULL, 0);
    CFStringRef bsd = (CFStringRef)IORegistryEntrySearchCFProperty(
        device, kIOServicePlane, CFSTR("BSD Name"), NULL, kIORegistryIterateRecursively);
    char name[64] = "";
    if (bsd && CFGetTypeID(bsd) == CFStringGetTypeID())
      CFStringGetCString(bsd, name, sizeof(name), kCFStringEncodingUTF8);

    IOCFPlugInInterface **plugin = NULL;
    NVMeSMARTInterface **iface = NULL;
    SInt32 score;
    uint8_t log[512] = {0};
    if (capable && name[0] &&
        IOCreatePlugInInterfaceForService(device, NVME_SMART_TYPE, kIOCFPlugInInterfaceID, &plugin,
                                          &score) == KERN_SUCCESS &&
        plugin &&
        (*plugin)->QueryInterface(plugin, CFUUIDGetUUIDBytes(NVME_SMART_INTERFACE),
                                  (LPVOID *)&iface) == S_OK &&
        iface && (*iface)->SMARTReadData(iface, log) == kIOReturnSuccess) {
      /* Data units are thousands of 512-byte blocks, per the NVMe spec. */
      printf("smart\t%s\twarning=%u\tkelvin=%u\tspare=%u\tspareThreshold=%u\tused=%u"
             "\tread=%llu\twritten=%llu\tcycles=%llu\thours=%llu\tunsafe=%llu\tmediaErrors=%llu\n",
             name, log[0], log[1] | (log[2] << 8), log[3], log[4], log[5],
             (unsigned long long)(le64(log + 32) * 512000), (unsigned long long)(le64(log + 48) * 512000),
             (unsigned long long)le64(log + 112), (unsigned long long)le64(log + 128),
             (unsigned long long)le64(log + 144), (unsigned long long)le64(log + 160));
    }
    if (iface) (*iface)->Release(iface);
    if (plugin) IODestroyPlugInInterface(plugin);
    if (bsd) CFRelease(bsd);
    if (capable) CFRelease(capable);
    IOObjectRelease(device);
  }
  IOObjectRelease(iterator);
}

/* ----------------------------------------------------------------- graphics */

/* The SMC's own call shape. Every SMC reader carries this struct; its layout
   is the kernel's and has not moved since Intel. */
typedef struct {
  UInt32 key;
  struct { char major, minor, build, reserved; UInt16 release; } version;
  struct { UInt16 version, length; UInt32 cpu, gpu, mem; } limits;
  struct { UInt32 size; UInt32 type; char attributes; } info;
  char result, status, command;
  UInt32 index;
  unsigned char bytes[32];
} SMCCall;

enum { SMC_READ = 5, SMC_KEY_AT = 8, SMC_INFO = 9 };

static int smcCall(io_connect_t smc, SMCCall *in, SMCCall *out) {
  size_t size = sizeof(SMCCall);
  memset(out, 0, sizeof(SMCCall));
  return IOConnectCallStructMethod(smc, 2, in, sizeof(SMCCall), out, &size) != KERN_SUCCESS || out->result;
}

/* The hottest `Tg` key, which is the graphics cores. Walked by index rather
   than named, because which `Tg` keys exist changes with every chip. */
static double gpuTemperature(void) {
  io_service_t service = IOServiceGetMatchingService(MACH_PORT_NULL, IOServiceMatching("AppleSMC"));
  io_connect_t smc;
  if (!service) return -1;
  kern_return_t opened = IOServiceOpen(service, mach_task_self(), 0, &smc);
  IOObjectRelease(service);
  if (opened != KERN_SUCCESS) return -1;

  SMCCall in, out;
  memset(&in, 0, sizeof(in));
  in.key = '#KEY';
  in.command = SMC_INFO;
  UInt32 count = 0;
  if (!smcCall(smc, &in, &out)) {
    in.info.size = out.info.size;
    in.command = SMC_READ;
    if (!smcCall(smc, &in, &out))
      count = ((UInt32)out.bytes[0] << 24) | (out.bytes[1] << 16) | (out.bytes[2] << 8) | out.bytes[3];
  }

  double hottest = -1;
  for (UInt32 i = 0; i < count; i++) {
    memset(&in, 0, sizeof(in));
    in.command = SMC_KEY_AT;
    in.index = i;
    if (smcCall(smc, &in, &out)) continue;
    UInt32 key = out.key;
    if ((key >> 16) != (('T' << 8) | 'g')) continue;

    memset(&in, 0, sizeof(in));
    in.key = key;
    in.command = SMC_INFO;
    if (smcCall(smc, &in, &out) || out.info.type != 'flt ' || out.info.size != 4) continue;
    in.info.size = 4;
    in.command = SMC_READ;
    if (smcCall(smc, &in, &out)) continue;
    float celsius;
    memcpy(&celsius, out.bytes, 4);
    /* Unpowered sensors read 0 or below; above 150 is not a reading. */
    if (celsius > 0 && celsius < 150 && celsius > hottest) hottest = celsius;
  }
  IOServiceClose(smc);
  return hottest;
}

/* IOReport is private and has no header; loaded at run time so a release that
   drops it costs the power figure and nothing else. */
typedef CFDictionaryRef (*CopyChannelsFn)(CFStringRef, CFStringRef, uint64_t, uint64_t, uint64_t);
typedef void *(*SubscribeFn)(void *, CFMutableDictionaryRef, CFMutableDictionaryRef *, uint64_t, CFTypeRef);
typedef CFDictionaryRef (*SampleFn)(void *, CFMutableDictionaryRef, CFTypeRef);
typedef CFDictionaryRef (*DeltaFn)(CFDictionaryRef, CFDictionaryRef, CFTypeRef);
typedef CFStringRef (*ChannelStringFn)(CFDictionaryRef);
typedef int64_t (*IntegerFn)(CFDictionaryRef, int32_t);

/* Watts the graphics drew over `window` microseconds, or -1. */
static double gpuWatts(useconds_t window) {
  void *lib = dlopen("/usr/lib/libIOReport.dylib", RTLD_LAZY);
  if (!lib) return -1;
  CopyChannelsFn copyChannels = (CopyChannelsFn)dlsym(lib, "IOReportCopyChannelsInGroup");
  SubscribeFn subscribe = (SubscribeFn)dlsym(lib, "IOReportCreateSubscription");
  SampleFn sample = (SampleFn)dlsym(lib, "IOReportCreateSamples");
  DeltaFn delta = (DeltaFn)dlsym(lib, "IOReportCreateSamplesDelta");
  ChannelStringFn channelName = (ChannelStringFn)dlsym(lib, "IOReportChannelGetChannelName");
  ChannelStringFn unitLabel = (ChannelStringFn)dlsym(lib, "IOReportChannelGetUnitLabel");
  IntegerFn integer = (IntegerFn)dlsym(lib, "IOReportSimpleGetIntegerValue");
  if (!copyChannels || !subscribe || !sample || !delta || !channelName || !unitLabel || !integer) return -1;

  CFDictionaryRef channels = copyChannels(CFSTR("Energy Model"), NULL, 0, 0, 0);
  if (!channels) return -1;
  CFMutableDictionaryRef wanted = CFDictionaryCreateMutableCopy(NULL, 0, channels);
  CFRelease(channels);
  CFMutableDictionaryRef subscribed = NULL;
  void *subscription = subscribe(NULL, wanted, &subscribed, 0, NULL);
  if (!subscription || !subscribed) {
    CFRelease(wanted);
    return -1;
  }

  CFDictionaryRef before = sample(subscription, subscribed, NULL);
  usleep(window);
  CFDictionaryRef after = sample(subscription, subscribed, NULL);
  CFDictionaryRef change = before && after ? delta(before, after, NULL) : NULL;

  double joules = -1;
  CFArrayRef items = change ? CFDictionaryGetValue(change, CFSTR("IOReportChannels")) : NULL;
  for (CFIndex i = 0; items && i < CFArrayGetCount(items); i++) {
    CFDictionaryRef item = CFArrayGetValueAtIndex(items, i);
    CFStringRef name = channelName(item);
    /* `GPU Energy` is the whole graphics block; `GPU` alone is a subset that
       reads zero on some chips. */
    if (!name || CFStringCompare(name, CFSTR("GPU Energy"), 0) != kCFCompareEqualTo) continue;
    char unit[8] = "";
    CFStringRef label = unitLabel(item);
    if (label) CFStringGetCString(label, unit, sizeof(unit), kCFStringEncodingUTF8);
    double scale = !strcmp(unit, "nJ") ? 1e-9 : !strcmp(unit, "uJ") ? 1e-6 : !strcmp(unit, "mJ") ? 1e-3 : 0;
    if (scale) joules = integer(item, 0) * scale;
  }

  if (change) CFRelease(change);
  if (after) CFRelease(after);
  if (before) CFRelease(before);
  CFRelease(subscribed);
  CFRelease(wanted);
  return joules < 0 ? -1 : joules / (window / 1e6);
}

/* `recommendedMaxWorkingSetSize`: what Metal will let the GPU keep resident.
   Unified memory has no VRAM, and this is the ceiling a GPU program actually
   meets — about three quarters of the RAM. */
extern void *MTLCreateSystemDefaultDevice(void);

static uint64_t gpuMemoryLimit(void) {
  void *device = MTLCreateSystemDefaultDevice();
  if (!device) return 0;
  SEL selector = sel_registerName("recommendedMaxWorkingSetSize");
  uint64_t limit = ((uint64_t (*)(void *, SEL))objc_msgSend)(device, selector);
  ((void (*)(void *, SEL))objc_msgSend)(device, sel_registerName("release"));
  return limit;
}

static int graphics(void) {
  double celsius = gpuTemperature();
  if (celsius > 0) printf("gpu-temp\t%.2f\n", celsius);
  double watts = gpuWatts(250000);
  if (watts >= 0) printf("gpu-power\t%.3f\n", watts);
  uint64_t limit = gpuMemoryLimit();
  if (limit) printf("gpu-memory-limit\t%llu\n", (unsigned long long)limit);
  return 0;
}

int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "gpu")) return graphics();
  int status = temperatures();
  smart();
  return status;
}
