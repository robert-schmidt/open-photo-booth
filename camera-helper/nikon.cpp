// Nikon Z cameras through Nikon's SDK for them (drivers/nikon: the Remote SDK 2.x and its TypeCommon module): the Z9,
// Z8, Z6III, Z7II, Z6II, Z7, Z6, Z5II, Z5, Zf, Z50II, Z50, Z30, Zfc and ZR. The module controls one camera at a time.
//
// As in Nikon's samples: on macOS the module's calls run on a thread of their own while the main thread keeps its event
// loop going (the module reaches the camera through ImageCaptureCore, which needs that loop); on Windows they run on the
// main thread. Its callbacks come on its own threads and leave what they bring for the main thread. Photos are sent to
// the computer only (the camera needs no card), into the folder camera-helper is given.
#include "helper.h"
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <map>
#include <mutex>
#include <thread>
#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#endif
#include "Maid3.h"
#include "Maid3d1.h"

using namespace std::chrono_literals;
#ifdef _WIN32
using NkChar = wchar_t; // the module's paths
#else
using NkChar = char;
#endif

struct Nikon;
static Nikon* self; // for the callbacks; there's one

// The settings the app shows (Prop in helper.h), each with the module's capability for it.
struct Setting { const char* key; ULONG cap; };
static const Setting SETTINGS[] = {
  {"mode", kNkMAIDCapability_ExposureMode}, {"iso", kNkMAIDCapability_Sensitivity}, {"isoAuto", kNkMAIDCapability_IsoControl},
  {"shutter", kNkMAIDCapability_ShutterSpeed}, {"aperture", kNkMAIDCapability_Aperture}, {"ev", kNkMAIDCapability_ExposureComp},
  {"wb", kNkMAIDCapability_WBMode}, {"flash", kNkMAIDCapability_FlashMode}, {"flashEv", kNkMAIDCapability_InternalFlashComp},
};
// The module's numbers as text, for the settings whose values aren't text already.
static std::string label(ULONG cap, ULONG v) {
  if (cap == kNkMAIDCapability_ExposureMode) switch (v) {
    case kNkMAIDExposureMode_Program: return "P (program auto)";
    case kNkMAIDExposureMode_AperturePriority: return "A (aperture priority)";
    case kNkMAIDExposureMode_SpeedPriority: return "S (shutter priority)";
    case kNkMAIDExposureMode_Manual: return "M (manual)";
    case kNkMAIDExposureMode_Auto: return "Auto";
    case kNkMAIDExposureMode_Portrait: return "Portrait";
    case kNkMAIDExposureMode_FlashOff: return "Auto, flash off";
    case kNkMAIDExposureMode_Scene: return "Scene";
    case kNkMAIDExposureMode_Effects: return "Effects";
  }
  if (cap == kNkMAIDCapability_FlashMode) switch (v) {
    case kNkMAIDFlashMode_FrontCurtain: return "On (front curtain)";
    case kNkMAIDFlashMode_RearCurtain: case kNkMAIDFlashMode_RearCurtainSync: return "Rear curtain";
    case kNkMAIDFlashMode_SlowSync: case kNkMAIDFlashMode_SlowSyncFillFlash: return "Slow sync";
    case kNkMAIDFlashMode_RedEyeReduction: case kNkMAIDFlashMode_RedEyeReductionLighting: return "Red-eye reduction";
    case kNkMAIDFlashMode_SlowSyncRedEyeReduction: case kNkMAIDFlashMode_SlowSyncRedEye: return "Slow sync, red-eye reduction";
    case kNkMAIDFlashMode_SlowSyncRearCurtain: return "Slow sync, rear curtain";
    case kNkMAIDFlashMode_Off: return "Off";
    case kNkMAIDFlashMode_Auto: return "Auto";
    case kNkMAIDFlashMode_On: return "On";
    case kNkMAIDFlashMode_FillFlash: return "On (fill)";
  }
  return "Other (" + std::to_string(v) + ")";
}

struct Nikon : Backend {
  LPMAIDInitializeSDKProc initialize = nullptr;
  LPMAIDFreeSDKProc freeSDK = nullptr;
  LPMAIDConnectDeviceProc connect = nullptr;
  LPMAIDDisconnectDeviceProc disconnect = nullptr;
  LPMAIDStartLiveView startLive = nullptr;
  LPMAIDStopLiveView stopLive = nullptr;
  LPMAIDStartShooting startShooting = nullptr;
  LPMAIDGetCapability getCap = nullptr;
  LPMAIDSetCapability setCap = nullptr;
  LPMAIDEnumDevices enumDevices = nullptr;
  LPMAIDStartOperation operation = nullptr;

  bool ready = false, connected = false, on = false;
  std::string openId, openName;
  Clock::time_point focused;
  std::atomic<bool> changed{false}; // cameras came or went
  std::mutex mu; // what the callbacks bring:
  std::string lv; bool fresh = false;
  std::vector<fs::path> saved; bool failed = false;
  std::map<ULONG, ULONG> ops; // what the open camera allows for each capability (kNkMAIDCapOperation bits), as it said on connecting

  // Runs f where the module's calls run, and waits for it.
#ifdef __APPLE__
  std::thread worker;
  std::mutex wmu;
  std::condition_variable wcv;
  std::deque<std::function<void()>> jobs;
  bool quit = false;
  void run(const std::function<void()>& f) {
    std::atomic<bool> done{false};
    std::exception_ptr error;
    { std::lock_guard<std::mutex> l(wmu); jobs.push_back([&] { try { f(); } catch (...) { error = std::current_exception(); } done = true; }); }
    wcv.notify_one();
    await([&] { return done.load(); }, 600000, "the camera stopped answering"); // the app gives up sooner
    if (error) std::rethrow_exception(error);
  }
  void work() {
    for (;;) {
      std::function<void()> job;
      {
        std::unique_lock<std::mutex> l(wmu);
        wcv.wait(l, [&] { return quit || !jobs.empty(); });
        if (jobs.empty()) return;
        job = std::move(jobs.front());
        jobs.pop_front();
      }
      job();
    }
  }
#else
  void run(const std::function<void()>& f) { f(); }
#endif

  ~Nikon() override {
    if (ready) close(), run([&] { freeSDK(); });
#ifdef __APPLE__
    { std::lock_guard<std::mutex> l(wmu); quit = true; }
    wcv.notify_one();
    if (worker.joinable()) worker.join();
#endif
  }

  // The cameras plugged in, by name (a camera's id from the module changes when it's plugged in again). Unless all, only
  // those free: not held by another program, or by this one. While one is open, it's the only one listed.
  std::vector<std::pair<ULONG, Camera>> devices(bool all = false) {
    std::vector<std::pair<ULONG, Camera>> out;
    run([&] {
      LPNkMAIDEnumDevices d = nullptr;
      if (enumDevices(d, nullptr, nullptr) != kNkMAIDResult_NoError || !d) return;
      for (ULONG i = 0; i < d->ulElements; i++) {
        std::string name(d->pDeviceData[i].Name, strnlen(d->pDeviceData[i].Name, sizeof d->pDeviceData[i].Name));
        if (all || d->pDeviceData[i].Availability) out.push_back({d->pDeviceData[i].ID, {"nikon:" + name, "Nikon " + name}});
      }
      free(d->pDeviceData);
      free(d);
    });
    return out;
  }
  std::vector<Camera> list() override {
    if (connected) return {{openId, openName}};
    std::vector<Camera> out;
    for (auto& d : devices()) out.push_back(d.second);
    return out;
  }

  void open(const std::string& id) override {
    close();
    for (auto& [device, camera] : devices()) {
      if (camera.id != id) continue;
      NKERROR err;
      ULONG which = device;
      run([&] {
        LPNkMAIDEnumCapInfo caps = nullptr;
        err = connect(which, &caps);
        ops.clear();
        if (caps) {
          for (ULONG i = 0; i < caps->ulCapCount; i++) ops[caps->pCapArray[i].ulID] = caps->pCapArray[i].ulOperations;
          free(caps->pCapArray), free(caps);
        }
      });
      if (err != kNkMAIDResult_NoError) throw Error("refused", "the camera refused (" + std::to_string(err) + "): is Nikon's own tethering app open?");
      connected = true, openId = id, openName = camera.name;
      // ponytail: settings a body doesn't take are skipped; the photo still arrives, and live view is smaller.
      set(kNkMAIDCapability_SaveMedia, kNkMAIDSaveMedia_SDRAM);
      set(kNkMAIDCapability_LiveViewImageSize, kNkMAIDLiveViewImageSize_XGA);
      return;
    }
    throw Error("not_found", "camera not found");
  }

  void close() override {
    openId.clear();
    if (!connected) return;
    connected = on = false;
    run([&] { disconnect(); });
  }

  void live(bool v) override {
    if (v == on) return;
    NKERROR err;
    run([&] { err = v ? startLive(nullptr, nullptr) : stopLive(nullptr, nullptr); });
    if (err != kNkMAIDResult_NoError && err != kNkMAIDAPIResult_LiveViewAlreadyStarted && err != kNkMAIDAPIResult_LiveViewAlreadyStopped)
      throw Error("failed", "live view didn't " + std::string(v ? "start" : "stop") + " (" + std::to_string(err) + ")");
    on = v;
  }

  // Autofocus now, without waiting for it: the shot follows a second later.
  void focus() override {
    run([&] { operation(kNkMAIDCapability_AutoFocus, [](NKREF, NKERROR) {}, nullptr); });
    focused = Clock::now();
  }

  std::string battery() override {
    std::string out;
    run([&] {
      LPVOID data = nullptr;
      eNkMAIDDataType type = kNkMAIDDataType_IntegerPtr;
      if (getCap(kNkMAIDCapability_BatteryLevel, kNkSDKGetSettingValue, data, type) == kNkMAIDResult_NoError && data) out = std::to_string(*(SLONG*)data) + "%";
      free(data);
    });
    return out; // ponytail: the module doesn't say when the camera runs on mains power
  }

  std::string shoot(const fs::path& dir) override {
    if (!connected) throw Error("not_connected", "camera not connected");
    { std::lock_guard<std::mutex> l(mu); saved.clear(); failed = false; }
    MAIDShootingStructure p{};
    p.ShootingType = kNkSDKShootingTypeSingle;
    p.bAutoFocus = Clock::now() - focused > 3s;
    focused = {};
    auto folder = dir.native();
    folder.copy(p.ImageSavePath, sizeof p.ImageSavePath / sizeof(NkChar) - 1);
    NKERROR err;
    run([&] { err = startShooting(p, nullptr, nullptr); });
    if (err != kNkMAIDResult_NoError) throw Error("failed", "the camera didn't take the photo (" + std::to_string(err) + "): is it in focus?");
    // The JPEG, when the camera saves RAW and JPEG; a RAW file is deleted (ponytail: keep it when operators want RAW).
    fs::path jpeg;
    bool raw = false, lost = false;
    std::error_code ec;
    await([&] {
      std::lock_guard<std::mutex> l(mu);
      for (auto& f : saved) {
        auto ext = f.extension().u8string();
        if (ext == ".JPG" || ext == ".jpg" || ext == ".JPEG" || ext == ".jpeg") jpeg = f;
        else raw = true, fs::remove(f, ec);
      }
      saved.clear();
      lost = failed;
      return !jpeg.empty() || failed;
    }, 12000, "the camera didn't send the photo");
    if (jpeg.empty() && raw) throw Error("raw_only", "the camera saves RAW only: set its image quality to JPEG or RAW+JPEG");
    if (jpeg.empty() || lost) throw Error("failed", "the camera couldn't send the photo");
    return jpeg.u8string();
  }

  void tick() override {
    if (changed.exchange(false) && connected) {
      bool here = false;
      for (auto& d : devices(true)) here |= d.second.id == openId;
      if (!here) {
        close();
        return lostEvent();
      }
    }
    std::lock_guard<std::mutex> l(mu);
    if (fresh) frame(lv.data(), lv.size()), fresh = false;
  }

  void set(ULONG cap, ULONG value) {
    run([&] { setCap(cap, &value, kNkMAIDDataType_UnsignedPtr); });
  }

  // What the module gave for a capability, freed as its sample does.
  static void release(LPVOID data, eNkMAIDDataType type) {
    if (data && type == kNkMAIDDataType_EnumPtr) free(static_cast<LPNkMAIDEnum>(data)->pData);
    free(data);
  }
  // One setting, where the module's calls run: a list of values (texts packed one after another, or numbers), a range
  // in steps, or a switch.
  bool readProp(const Setting& s, Prop& out) {
    auto found = ops.find(s.cap);
    if (found == ops.end() || !(found->second & kNkMAIDCapOperation_Get)) return false;
    out = {s.key, {}, -1, (found->second & kNkMAIDCapOperation_Set) != 0};
    auto values = [&](LPNkMAIDEnum e) {
      if (!e->pData) return;
      if (e->ulType == kNkMAIDArrayType_PackedString) {
        for (ULONG i = 0; i < e->ulElements;) { // as the module's sample walks them
          const char* text = static_cast<const char*>(e->pData) + i;
          out.options.push_back(text);
          i += ULONG(strlen(text)) + 1;
        }
      } else if (e->ulType == kNkMAIDArrayType_Unsigned) {
        for (ULONG i = 0; i < e->ulElements; i++) {
          ULONG v = 0;
          memcpy(&v, static_cast<const char*>(e->pData) + i * e->wPhysicalBytes, std::min<size_t>(sizeof v, size_t(e->wPhysicalBytes)));
          out.options.push_back(label(s.cap, v));
        }
      }
    };
    LPVOID data = nullptr;
    eNkMAIDDataType type = kNkMAIDDataType_Null;
    if ((found->second & kNkMAIDCapOperation_GetArray) && getCap(s.cap, kNkSDKGetSettingSupportedValueArray, data, type) == kNkMAIDResult_NoError && data && type == kNkMAIDDataType_EnumPtr)
      values(static_cast<LPNkMAIDEnum>(data));
    release(data, type);
    data = nullptr, type = kNkMAIDDataType_Null;
    if (getCap(s.cap, kNkSDKGetSettingValue, data, type) != kNkMAIDResult_NoError || !data) { release(data, type); return false; }
    if (type == kNkMAIDDataType_EnumPtr) {
      auto* e = static_cast<LPNkMAIDEnum>(data);
      if (out.options.empty()) values(e);
      out.value = int(e->ulValue);
    } else if (type == kNkMAIDDataType_RangePtr) {
      auto* r = static_cast<LPNkMAIDRange>(data);
      // ponytail: a range without steps shows its value only; none of the settings here has been seen to be one.
      if (r->ulSteps < 2) out.options = {evText(r->lfValue)}, out.value = 0, out.writable = false;
      else {
        for (ULONG i = 0; i < r->ulSteps && i < 200; i++) out.options.push_back(evText(r->lfLower + i * (r->lfUpper - r->lfLower) / (r->ulSteps - 1)));
        out.value = int(r->ulValueIndex);
      }
    } else if (type == kNkMAIDDataType_BooleanPtr) {
      out.options = {"Off", "On"};
      out.value = *static_cast<unsigned char*>(data) ? 1 : 0;
    }
    release(data, type);
    return !out.options.empty();
  }
  std::vector<Prop> props() override {
    std::vector<Prop> out;
    if (!connected) return out;
    run([&] { for (auto& s : SETTINGS) { Prop p; if (readProp(s, p)) out.push_back(std::move(p)); } });
    return out;
  }
  void setProp(const std::string& key, int index) override {
    for (auto& s : SETTINGS) {
      if (key != s.key) continue;
      if (index < 0) throw Error("bad_value", "not one of the camera's values");
      NKERROR err = kNkMAIDResult_NotSupported;
      run([&] {
        LPVOID data = nullptr;
        eNkMAIDDataType type = kNkMAIDDataType_Null;
        if (getCap(s.cap, kNkSDKGetSettingValue, data, type) == kNkMAIDResult_NoError && data) {
          if (type == kNkMAIDDataType_EnumPtr) {
            NkMAIDEnum e = *static_cast<LPNkMAIDEnum>(data);
            e.pData = nullptr, e.ulValue = ULONG(index);
            err = setCap(s.cap, &e, kNkMAIDDataType_EnumPtr);
          } else if (type == kNkMAIDDataType_RangePtr) {
            NkMAIDRange r = *static_cast<LPNkMAIDRange>(data);
            r.ulValueIndex = ULONG(index);
            err = setCap(s.cap, &r, kNkMAIDDataType_RangePtr);
          } else if (type == kNkMAIDDataType_BooleanPtr) {
            unsigned char on = index != 0;
            err = setCap(s.cap, &on, kNkMAIDDataType_BooleanPtr);
          }
        }
        release(data, type);
      });
      if (err != kNkMAIDResult_NoError) throw Error("refused", "the camera refused the change (" + std::to_string(err) + "): its mode dial or exposure mode may decide this");
      return;
    }
    throw Error("unsupported", "this camera doesn't have that setting");
  }
  // A speedlight on the camera, or its built-in flash raised.
  std::string flashUnit() override {
    std::string out;
    if (!connected) return out;
    auto number = [&](ULONG cap, ULONG& v) {
      LPVOID data = nullptr;
      eNkMAIDDataType type = kNkMAIDDataType_Null;
      bool ok = ops.count(cap) && getCap(cap, kNkSDKGetSettingValue, data, type) == kNkMAIDResult_NoError && data && (type == kNkMAIDDataType_UnsignedPtr || type == kNkMAIDDataType_IntegerPtr);
      if (ok) v = *static_cast<ULONG*>(data);
      release(data, type);
      return ok;
    };
    run([&] {
      ULONG ext = 0, built = 0;
      bool e = number(kNkMAIDCapability_ExternalFlashStatus, ext), b = number(kNkMAIDCapability_InternalFlashStatus, built);
      if (e && ext == kNkMAIDExternalFlashStatus_Ready) out = "ready";
      else if (b && (built == kNkMAIDInternalFlashStatus_Ready || built == kNkMAIDInternalFlashStatus_TTL)) out = "ready";
      else if ((e && ext == kNkMAIDExternalFlashStatus_NotReady) || (b && built == kNkMAIDInternalFlashStatus_NotReady)) out = "charging";
      else if (e || b) out = "none";
    });
    return out;
  }
};

// The module's callbacks, on its threads.
static void* CALLPASCAL CALLBACK onAllocate(size_t n) { return malloc(n); }
static void CALLPASCAL CALLBACK onFree(void* p) { free(p); }
static ULONG CALLPASCAL CALLBACK onUI(NKREF, LPNkMAIDUIRequestInfo r) { return r ? r->ulDefault : kNkMAIDUIRequestResult_None; }
static void CALLPASCAL CALLBACK onProgress(ULONG, ULONG, NKREF, ULONG, ULONG) {}
static NKERROR CALLPASCAL CALLBACK onData(NKREF, LPVOID, LPVOID) { return kNkMAIDResult_NoError; }
static void CALLPASCAL CALLBACK onLiveView(NKREF, LPNkMAIDLiveViewData d) {
  if (!d) return;
  if (d->pImageData && d->ulLvImageSize) {
    std::lock_guard<std::mutex> l(self->mu);
    self->lv.assign((const char*)d->pImageData, d->ulLvImageSize);
    self->fresh = true;
  }
  free(d->pImageData);
  free(d);
}
static void CALLPASCAL CALLBACK onEvent(NKREF, ULONG ev, NKPARAM data) {
  void* p = (void*)(uintptr_t)data;
  switch (ev) {
    case kNkMAIDEvent_ImageSaved:
      if (p) {
        std::lock_guard<std::mutex> l(self->mu);
        self->saved.emplace_back((const NkChar*)p);
      }
      free(p);
      break;
    case kNkMAIDEvent_AcquireFailed_ImageNotSaved:
    case kNkMAIDEvent_StorageFull_ImageNotSaved: {
      std::lock_guard<std::mutex> l(self->mu);
      self->failed = true;
      break;
    }
    case kNkMAIDEvent_DeviceInfoChanged:
    case kNkMAIDEvent_RemoveChild: self->changed = true; break;
    case kNkMAIDEvent_CapChange:
    case kNkMAIDEvent_CapChangeOperationOnly: free(p); break; // the module's copy, for us to free
  }
}

// Loads Nikon's module from next to camera-helper, with the settings files it reads from the user's Nikon folder.
std::unique_ptr<Backend> nikon() {
  auto n = std::make_unique<Nikon>();
  std::error_code ec;
#ifdef __APPLE__
  const char* home = getenv("HOME");
  fs::path prefs = fs::path(home ? home : "") / "Library" / "Preferences" / "Nikon" / "NXTether";
  std::string module = (exeDir() / "TypeCommon Module.bundle").native();
  auto url = CFURLCreateFromFileSystemRepresentation(nullptr, (const UInt8*)module.data(), CFIndex(module.size()), true);
  CFBundleRef bundle = url ? CFBundleCreate(nullptr, url) : nullptr;
  if (url) CFRelease(url);
  if (!bundle || !CFBundleLoadExecutable(bundle)) return nullptr;
  auto sym = [&](const char* name) {
    CFStringRef s = CFStringCreateWithCString(nullptr, name, kCFStringEncodingUTF8);
    void* p = CFBundleGetFunctionPointerForName(bundle, s);
    CFRelease(s);
    return p;
  };
#else
  const wchar_t* local = _wgetenv(L"LOCALAPPDATA");
  fs::path prefs = fs::path(local ? local : L"") / "Nikon" / "NXTether";
  HMODULE lib = LoadLibraryW((exeDir() / "ControlServiceLayer.dll").c_str());
  if (!lib) return nullptr;
  auto sym = [&](const char* name) { return (void*)GetProcAddress(lib, name); };
#endif
  fs::create_directories(prefs, ec);
  for (auto f : {"DC_PTP_Config.config", "MaidLayer.config", "RangeValue.config"}) fs::copy_file(exeDir() / f, prefs / f, fs::copy_options::update_existing, ec);
  n->initialize = (LPMAIDInitializeSDKProc)sym("InitializeSDK");
  n->freeSDK = (LPMAIDFreeSDKProc)sym("FreeSDK");
  n->connect = (LPMAIDConnectDeviceProc)sym("ConnectDevice");
  n->disconnect = (LPMAIDDisconnectDeviceProc)sym("DisconnectDevice");
  n->startLive = (LPMAIDStartLiveView)sym("StartLiveView");
  n->stopLive = (LPMAIDStopLiveView)sym("StopLiveView");
  n->startShooting = (LPMAIDStartShooting)sym("StartShooting");
  n->getCap = (LPMAIDGetCapability)sym("GetCapability");
  n->setCap = (LPMAIDSetCapability)sym("SetCapability");
  n->enumDevices = (LPMAIDEnumDevices)sym("EnumDevices");
  n->operation = (LPMAIDStartOperation)sym("StartOperation");
  if (!n->initialize || !n->freeSDK || !n->connect || !n->disconnect || !n->startLive || !n->stopLive || !n->startShooting
      || !n->getCap || !n->setCap || !n->enumDevices || !n->operation) return nullptr;
  self = n.get();
#ifdef __APPLE__
  n->worker = std::thread([p = n.get()] { p->work(); });
#endif
  NkMAIDCSCallback callbacks{(LPNKFUNC)onUI, (LPNKFUNC)onEvent, (LPNKFUNC)onProgress, (LPNKFUNC)onData, (LPNKFUNC)onLiveView, nullptr};
  NKERROR err;
  n->run([&] {
    LPNkMAIDEnumDevices devices = nullptr;
    err = n->initialize(onAllocate, onFree, &callbacks, &devices, nullptr);
    if (devices) free(devices->pDeviceData), free(devices);
  });
  if (err != kNkMAIDResult_NoError) return nullptr;
  n->ready = true;
  return n;
}
