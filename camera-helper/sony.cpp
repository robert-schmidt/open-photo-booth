// Sony cameras through Sony's Camera Remote SDK (drivers/sony): the a6700, a7 IV, a7C, a7C II, ZV-E10 II, a7R V and
// newer, plugged in over USB with "Remote Shoot (PC Remote)" as the USB mode. On Windows the SDK needs its USB driver
// (drivers/sony: Driver.zip, srcameradriver.inf).
//
// The SDK calls back on threads of its own; the callbacks leave what they bring (connected, gone, a downloaded photo)
// for the main thread. Photos are sent to the computer only (the camera needs no card), into the folder camera-helper
// is given.
#include "helper.h"
#include <atomic>
#include <cstring>
#include <mutex>
#include "CameraRemote_SDK.h"
#include "CrDeviceProperty.h"
#include "IDeviceCallback.h"

namespace SDK = SCRSDK;
using namespace std::chrono_literals;

// CrChar is wchar_t on Windows and char elsewhere; fs::path converts either.
static std::string utf8(const CrChar* s) { return s ? fs::path(s).u8string() : ""; }
static std::string idOf(const SDK::ICrCameraObjectInfo* c) { return "sony:" + utf8(reinterpret_cast<const CrChar*>(c->GetId())); }
static std::string nameOf(const SDK::ICrCameraObjectInfo* c) { return "Sony " + utf8(c->GetModel()); }
static void pause(int ms) {
  auto end = Clock::now() + std::chrono::milliseconds(ms);
  await([&] { return Clock::now() >= end; }, ms + 1000, "");
}

// The settings the app shows (Prop in helper.h), each with the SDK's property for it.
struct Setting { const char* key; CrInt32u code; };
static const Setting SETTINGS[] = {
  {"mode", SDK::CrDeviceProperty_ExposureProgramMode}, {"iso", SDK::CrDeviceProperty_IsoSensitivity}, {"shutter", SDK::CrDeviceProperty_ShutterSpeed},
  {"aperture", SDK::CrDeviceProperty_FNumber}, {"ev", SDK::CrDeviceProperty_ExposureBiasCompensation}, {"wb", SDK::CrDeviceProperty_WhiteBalance},
  {"flash", SDK::CrDeviceProperty_FlashMode}, {"flashEv", SDK::CrDeviceProperty_FlashCompensation}, {"preview", SDK::CrDeviceProperty_LiveViewDisplayEffect},
};
static std::string fmt(const char* f, double v) { char b[32]; snprintf(b, sizeof b, f, v); return b; }
static std::string hex(CrInt64u v) { char b[32]; snprintf(b, sizeof b, "0x%04llx", static_cast<unsigned long long>(v)); return b; }
// A property's value as text (the encodings are in CrDeviceProperty.h).
static std::string label(CrInt32u code, CrInt64u v) {
  switch (code) {
    case SDK::CrDeviceProperty_ExposureProgramMode:
      switch (CrInt32u(v)) {
        case SDK::CrExposure_M_Manual: return "M (manual)";
        case SDK::CrExposure_P_Auto: return "P (program auto)";
        case SDK::CrExposure_A_AperturePriority: return "A (aperture priority)";
        case SDK::CrExposure_S_ShutterSpeedPriority: return "S (shutter priority)";
        case SDK::CrExposure_Auto: return "Auto";
        case SDK::CrExposure_Auto_Plus: return "Auto+";
        case SDK::CrExposure_Portrait: return "Portrait";
        case SDK::CrExposure_Flash_Off: return "Auto, flash off";
        case SDK::CrExposure_MemoryRecall: return "Memory recall";
        case SDK::CrExposure_Movie_P: case SDK::CrExposure_Movie_A: case SDK::CrExposure_Movie_S: case SDK::CrExposure_Movie_M: case SDK::CrExposure_Movie_Auto: return "Movie";
      }
      break;
    case SDK::CrDeviceProperty_IsoSensitivity: {
      CrInt32u iso = CrInt32u(v) & 0xFFFFFF, mode = (CrInt32u(v) >> 24) & 0x0F;
      return (iso == SDK::CrISO_AUTO ? std::string("Auto") : std::to_string(iso)) + (mode ? " (multi-frame NR)" : "");
    }
    case SDK::CrDeviceProperty_ShutterSpeed: {
      CrInt32u n = (CrInt32u(v) >> 16) & 0xFFFF, d = CrInt32u(v) & 0xFFFF;
      if (CrInt32u(v) == SDK::CrShutterSpeed_Bulb) return "Bulb";
      if (CrInt32u(v) == SDK::CrShutterSpeed_Nothing || !d) return "--";
      return n == 1 && d > 1 ? "1/" + std::to_string(d) : fmt("%g s", double(n) / d);
    }
    case SDK::CrDeviceProperty_FNumber: return CrInt16u(v) >= SDK::CrFnumber_IrisClose ? "--" : fmt("f/%g", CrInt16u(v) / 100.0);
    case SDK::CrDeviceProperty_ExposureBiasCompensation:
    case SDK::CrDeviceProperty_FlashCompensation: return evText(int16_t(v) / 1000.0);
    case SDK::CrDeviceProperty_WhiteBalance:
      switch (CrInt16u(v)) {
        case SDK::CrWhiteBalance_AWB: return "Auto";
        case SDK::CrWhiteBalance_Underwater_Auto: return "Underwater auto";
        case SDK::CrWhiteBalance_Daylight: return "Daylight";
        case SDK::CrWhiteBalance_Shadow: return "Shade";
        case SDK::CrWhiteBalance_Cloudy: return "Cloudy";
        case SDK::CrWhiteBalance_Tungsten: return "Incandescent";
        case SDK::CrWhiteBalance_Fluorescent: return "Fluorescent";
        case SDK::CrWhiteBalance_Fluorescent_WarmWhite: return "Fluorescent, warm white";
        case SDK::CrWhiteBalance_Fluorescent_CoolWhite: return "Fluorescent, cool white";
        case SDK::CrWhiteBalance_Fluorescent_DayWhite: return "Fluorescent, day white";
        case SDK::CrWhiteBalance_Fluorescent_Daylight: return "Fluorescent, daylight";
        case SDK::CrWhiteBalance_Flush: return "Flash";
        case SDK::CrWhiteBalance_ColorTemp: return "Colour temperature (set on the camera)";
        case SDK::CrWhiteBalance_Custom_1: return "Custom 1";
        case SDK::CrWhiteBalance_Custom_2: return "Custom 2";
        case SDK::CrWhiteBalance_Custom_3: return "Custom 3";
        case SDK::CrWhiteBalance_Custom: return "Custom";
      }
      break;
    case SDK::CrDeviceProperty_FlashMode:
      switch (CrInt16u(v)) {
        case SDK::CrFlash_Auto: return "Auto";
        case SDK::CrFlash_Off: return "Off";
        case SDK::CrFlash_Fill: return "On (fill)";
        case SDK::CrFlash_ExternalSync: return "External sync";
        case SDK::CrFlash_SlowSync: return "Slow sync";
        case SDK::CrFlash_RearSync: return "Rear sync";
      }
      break;
    case SDK::CrDeviceProperty_LiveViewDisplayEffect:
      if (CrInt16u(v) == SDK::CrLiveViewDisplayEffect_ON) return "Shows the exposure";
      if (CrInt16u(v) == SDK::CrLiveViewDisplayEffect_OFF) return "Always bright (for studio flash)";
      break;
  }
  return "Other (" + hex(v) + ")";
}

struct Sony : Backend, SDK::IDeviceCallback {
  SDK::CrDeviceHandle handle = 0;
  std::string openId, openName;
  std::atomic<int> state{0}; // 0 connecting, 1 connected, -1 refused or disconnected
  std::atomic<bool> gone{false};
  std::mutex mu;
  std::vector<fs::path> downloads; // since the last shot
  bool on = false;
  Clock::time_point lastFrame, focused;
  SDK::CrImageDataBlock lv;
  std::vector<CrInt8u> buf;

  ~Sony() override { close(); SDK::Release(); }

  // ponytail: USB cameras only; network ones need pairing on the camera first. While one is open, it's the only one
  // listed: enumerating could disturb its connection.
  std::vector<Camera> list() override {
    if (handle) return {{openId, openName}};
    std::vector<Camera> out;
    SDK::ICrEnumCameraObjectInfo* e = nullptr;
    if (SDK::EnumCameraObjects(&e) || !e) return out;
    for (CrInt32u i = 0; i < e->GetCount(); i++) {
      auto* c = e->GetCameraObjectInfo(i);
      if (utf8(c->GetConnectionTypeName()) == "USB") out.push_back({idOf(c), nameOf(c)});
    }
    e->Release();
    return out;
  }

  void open(const std::string& id) override {
    close();
    SDK::ICrEnumCameraObjectInfo* e = nullptr;
    if (SDK::EnumCameraObjects(&e) || !e) throw Error("not_found", "camera not found");
    SDK::CrError err = SDK::CrError_Generic_NotSupported;
    state = 0, gone = false;
    for (CrInt32u i = 0; i < e->GetCount(); i++) {
      auto* c = e->GetCameraObjectInfo(i);
      if (idOf(c) != id) continue;
      openName = nameOf(c);
      err = SDK::Connect(const_cast<SDK::ICrCameraObjectInfo*>(c), this, &handle, SDK::CrSdkControlMode_Remote, SDK::CrReconnecting_OFF);
      break;
    }
    e->Release(); // the camera's info may go once Connect has it
    if (err) { handle = 0; throw Error("not_found", "camera not found"); }
    try {
      await([&] { return state != 0; }, 10000, "the camera didn't answer");
      if (state < 0) throw Error("refused", "the camera refused: is its USB mode Remote Shoot (PC Remote)?");
    } catch (...) { close(); throw; }
    openId = id;
    set(SDK::CrDeviceProperty_PriorityKeySettings, SDK::CrPriorityKey_PCRemote, SDK::CrDataType_UInt32Array);
    set(SDK::CrDeviceProperty_StillImageStoreDestination, SDK::CrStillImageStoreDestination_HostPC, SDK::CrDataType_UInt16);
    set(SDK::CrDeviceProperty_LiveView_Image_Quality, SDK::CrPropertyLiveViewImageQuality_High, SDK::CrDataType_UInt16Array);
  }

  void close() override {
    openId.clear();
    if (!handle) return;
    if (state == 1) {
      SDK::Disconnect(handle);
      try { await([&] { return state != 1; }, 3000, ""); } catch (...) {}
    }
    SDK::ReleaseDevice(handle);
    handle = 0, on = false, gone = false, buf.clear();
  }

  void live(bool v) override {
    on = v;
    SDK::SetDeviceSetting(handle, SDK::Setting_Key_EnableLiveView, v ? SDK::CrDeviceSetting_Enable : SDK::CrDeviceSetting_Disable);
  }

  // The shutter button held halfway: focus now, so the shot fires on time.
  void focus() override {
    set(SDK::CrDeviceProperty_S1, SDK::CrLockIndicator_Locked, SDK::CrDataType_UInt16);
    focused = Clock::now();
  }

  std::string battery() override {
    CrInt32u codes[] = {SDK::CrDeviceProperty_PowerSource, SDK::CrDeviceProperty_BatteryLevel, SDK::CrDeviceProperty_BatteryRemain};
    SDK::CrDeviceProperty* props = nullptr;
    CrInt32 n = 0;
    if (SDK::GetSelectDeviceProperties(handle, 3, codes, &props, &n) || !props) return "";
    bool ac = false;
    int remain = -1;
    for (CrInt32 i = 0; i < n; i++) {
      CrInt64u v = props[i].GetCurrentValue();
      switch (props[i].GetCode()) {
        case SDK::CrDeviceProperty_PowerSource: ac |= v == SDK::CrPowerSource_DC; break;
        case SDK::CrDeviceProperty_BatteryLevel: ac |= v >= SDK::CrBatteryLevel_USBPowerSupply; break; // on USB power, a dummy battery, or none
        case SDK::CrDeviceProperty_BatteryRemain: if (v <= 100) remain = int(v); break;
      }
    }
    SDK::ReleaseDeviceProperties(handle, props);
    return ac ? "AC" : remain >= 0 ? std::to_string(remain) + "%" : "";
  }

  std::string shoot(const fs::path& dir) override {
    if (state != 1) throw Error("not_connected", "camera not connected");
    auto folder = dir.native();
    CrChar prefix[1] = {0};
    SDK::SetSaveInfo(handle, const_cast<CrChar*>(folder.c_str()), prefix, -1);
    { std::lock_guard<std::mutex> l(mu); downloads.clear(); }
    if (Clock::now() - focused > 3s) focus(), pause(500);
    SDK::SendCommand(handle, SDK::CrCommandId_Release, SDK::CrCommandParam_Down);
    pause(35);
    SDK::SendCommand(handle, SDK::CrCommandId_Release, SDK::CrCommandParam_Up);
    set(SDK::CrDeviceProperty_S1, SDK::CrLockIndicator_Unlocked, SDK::CrDataType_UInt16);
    focused = {};
    // The JPEG, when the camera saves RAW and JPEG; a RAW file is deleted (ponytail: keep it when operators want RAW).
    fs::path jpeg;
    bool raw = false;
    std::error_code ec;
    auto arrived = [&] {
      std::lock_guard<std::mutex> l(mu);
      for (auto& f : downloads) {
        auto ext = f.extension().u8string();
        if (ext == ".JPG" || ext == ".jpg" || ext == ".JPEG" || ext == ".jpeg") jpeg = f;
        else raw = true, fs::remove(f, ec);
      }
      downloads.clear();
      return !jpeg.empty();
    };
    try {
      await(arrived, 12000, "the camera didn't send the photo: is it in focus? (AF-S with a wide focus area, or MF, works best)");
    } catch (const Error&) {
      if (raw) throw Error("raw_only", "the camera saves RAW only: set its file format to JPEG or RAW+JPEG");
      throw;
    }
    return jpeg.u8string();
  }

  // The settings as the camera has them now: for each, the values it offers (raw, and as text) and whether it lets
  // them be changed. A value list comes as bytes, or as a range (lowest, highest, step).
  struct Read { Prop prop; CrInt32u code, type; std::vector<CrInt64u> raw; };
  std::vector<Read> read() {
    std::vector<Read> out;
    if (state != 1) return out;
    const CrInt32u count = sizeof SETTINGS / sizeof *SETTINGS;
    CrInt32u codes[count];
    for (CrInt32u i = 0; i < count; i++) codes[i] = SETTINGS[i].code;
    SDK::CrDeviceProperty* props = nullptr;
    CrInt32 n = 0;
    if (SDK::GetSelectDeviceProperties(handle, count, codes, &props, &n) || !props) return out;
    for (auto& s : SETTINGS) for (CrInt32 i = 0; i < n; i++) {
      auto& p = props[i];
      CrInt32u type = p.GetValueType(), width = type & 0xF; // UInt8 1, UInt16 2, UInt32 3, UInt64 4
      if (p.GetCode() != s.code || !p.IsGetEnableCurrentValue() || width < 1 || width > 4) continue;
      const CrInt32u size = 1u << (width - 1);
      const CrInt64u mask = size == 8 ? ~CrInt64u(0) : (CrInt64u(1) << (size * 8)) - 1;
      Read r{{s.key, {}, -1, p.IsSetEnableCurrentValue()}, s.code, type, {}};
      const CrInt8u* data = p.GetValues();
      const CrInt32u values = data ? p.GetValueSize() / size : 0;
      auto at = [&](CrInt32u k) { CrInt64u v = 0; memcpy(&v, data + k * size, size); return v; }; // little-endian, like the SDK's own sample
      if (type & SDK::CrDataType_RangeBit) {
        auto wide = [&](CrInt64u v) { return size == 8 ? int64_t(v) : int64_t(v << (64 - size * 8)) >> (64 - size * 8); }; // with its sign
        if (values >= 3 && wide(at(2)) > 0)
          for (int64_t v = wide(at(0)); v <= wide(at(1)) && r.raw.size() < 200; v += wide(at(2))) r.raw.push_back(CrInt64u(v) & mask);
      } else for (CrInt32u k = 0; k < values; k++) r.raw.push_back(at(k));
      const CrInt64u now = p.GetCurrentValue() & mask;
      for (size_t k = 0; k < r.raw.size(); k++) if (r.raw[k] == now) r.prop.value = int(k);
      if (r.prop.value < 0) r.raw.insert(r.raw.begin(), now), r.prop.value = 0; // set on the camera to something it doesn't offer here
      for (auto v : r.raw) r.prop.options.push_back(label(s.code, v));
      out.push_back(std::move(r));
    }
    SDK::ReleaseDeviceProperties(handle, props);
    return out;
  }
  std::vector<Prop> props() override {
    std::vector<Prop> out;
    for (auto& r : read()) out.push_back(r.prop);
    return out;
  }
  // The camera applies it a moment later and doesn't say if it won't: the app reads the settings again to show what stuck.
  void setProp(const std::string& key, int index) override {
    for (auto& r : read()) {
      if (r.prop.key != key) continue;
      if (!r.prop.writable) throw Error("locked", "the camera decides this itself right now: check its mode dial and exposure mode");
      if (index < 0 || index >= int(r.raw.size())) throw Error("bad_value", "not one of the camera's values");
      SDK::CrDeviceProperty p;
      p.SetCode(r.code);
      p.SetCurrentValue(r.raw[index]);
      p.SetValueType(SDK::CrDataType((r.type & ~CrInt32u(SDK::CrDataType_RangeBit)) | SDK::CrDataType_ArrayBit)); // as Sony's sample sends them
      if (auto err = SDK::SetDeviceProperty(handle, &p)) throw Error("refused", "the camera refused the change (" + hex(err) + ")");
      return;
    }
    throw Error("unsupported", "this camera doesn't have that setting");
  }

  void tick() override {
    if (gone.exchange(false) && !openId.empty()) {
      close();
      return lostEvent();
    }
    if (!on || state != 1 || Clock::now() - lastFrame < 30ms) return;
    lastFrame = Clock::now();
    if (buf.empty()) {
      SDK::CrImageInfo info;
      if (SDK::GetLiveViewImageInfo(handle, &info) || !info.GetBufferSize()) return;
      buf.resize(info.GetBufferSize());
      lv.SetData(buf.data());
      lv.SetSize(CrInt32u(buf.size()));
    }
    auto err = SDK::GetLiveViewImage(handle, &lv);
    if (err == SDK::CrError_Memory_Insufficient) buf.clear(); // bigger frames now: a bigger buffer next time
    else if (!err && lv.GetImageSize()) frame(lv.GetImageData(), lv.GetImageSize()); // else no newer frame yet
  }

  void set(CrInt32u code, CrInt64u value, SDK::CrDataType type) {
    SDK::CrDeviceProperty p;
    p.SetCode(code);
    p.SetCurrentValue(value);
    p.SetValueType(type);
    SDK::SetDeviceProperty(handle, &p); // ponytail: not every body takes every setting, and a refusal is harmless here
  }

  // The SDK's threads.
  void OnConnected(SDK::DeviceConnectionVersioin) override { state = 1; }
  void OnError(CrInt32u) override { if (state == 0) state = -1; }
  void OnDisconnected(CrInt32u) override { gone = state == 1; state = -1; }
  void OnCompleteDownload(CrChar* file, CrInt32u) override { std::lock_guard<std::mutex> l(mu); downloads.emplace_back(file); }
};

std::unique_ptr<Backend> sony() {
  if (!SDK::Init()) return nullptr;
  return std::make_unique<Sony>();
}
