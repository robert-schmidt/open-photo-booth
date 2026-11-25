// Sony cameras through Sony's Camera Remote SDK (drivers/sony): the a6700, a7 IV, a7C, a7C II, ZV-E10 II, a7R V and
// newer, plugged in over USB with "Remote Shoot (PC Remote)" as the USB mode. On Windows the SDK needs its USB driver
// (drivers/sony: Driver.zip, srcameradriver.inf).
//
// The SDK calls back on threads of its own; the callbacks leave what they bring (connected, gone, a downloaded photo)
// for the main thread. Photos are sent to the computer only (the camera needs no card), into the folder camera-helper
// is given.
#include "helper.h"
#include <atomic>
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
