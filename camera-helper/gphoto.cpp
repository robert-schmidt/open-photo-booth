// The open backend: cameras through libgphoto2 (LGPL, gphoto.org), for the bodies the makers' SDKs don't reach here:
// Canon EOS, Nikon DSLRs, older Sony, and whatever else libgphoto2 can tether. It needs no maker's SDK, so a build
// from the public source has it too (scripts/build-gphoto.mjs builds the libraries; build-camera.mjs compiles this in
// when they are there). Its camera ids are "gphoto:<model as libgphoto2 names it>".
//
// macOS only so far (on Windows libgphoto2 needs the camera's USB driver replaced, which a booth operator can't be asked to do).
// On macOS the system's own camera service (ptpcamerad) takes every camera that is plugged in; open() ends it when
// the camera can't be had otherwise, the way gphoto2's own documentation says to. macOS starts it again when needed.
//
// ponytail: written from libgphoto2's API and tried against its virtual camera only (npm test), not on a real body
// yet. Autofocus at "1" is Canon's and Nikon's ("autofocusdrive"); other makers focus when the shutter fires.
#define Camera GPCamera // libgphoto2's Camera: helper.h has a Camera of its own
#include <gphoto2/gphoto2.h>
#undef Camera
#include "helper.h"
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <thread>

namespace {

std::string lower(std::string s) {
  std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return char(std::tolower(c)); });
  return s;
}
void check(int r, const std::string& code, const std::string& what) {
  if (r < GP_OK) throw Error(code, what + " (" + gp_result_as_string(r) + ")");
}

// The settings the app shows, and what libgphoto2 calls each on the different makers' cameras (the first one found counts).
struct Setting { const char* key; std::vector<const char*> names; };
const std::vector<Setting> SETTINGS = {
  {"mode", {"autoexposuremode", "expprogram"}}, {"iso", {"iso"}}, {"shutter", {"shutterspeed2", "shutterspeed"}},
  {"aperture", {"aperture", "f-number"}}, {"ev", {"exposurecompensation"}}, {"wb", {"whitebalance"}},
};
// A value as the app shows it: apertures as "f/5.6", exposure compensation as "+0.3"; the rest as the camera says it.
std::string shown(const std::string& key, const std::string& v) {
  if (key == "aperture" && !v.empty() && isdigit(static_cast<unsigned char>(v[0]))) return "f/" + v;
  if (key == "ev") {
    char* end = nullptr;
    const double ev = strtod(v.c_str(), &end);
    if (end != v.c_str() && !*end) return evText(ev);
  }
  return v;
}

struct Gphoto : Backend {
  GPContext* ctx = gp_context_new();
  CameraAbilitiesList* models = nullptr; // every camera libgphoto2 knows, loaded once
  GPPortInfoList* ports = nullptr;       // the ports as they were when the camera was opened (it keeps a pointer into them)
  GPCamera* cam = nullptr;
  bool on = false, ram = false, seen = false; // live view wanted; photos go to the computer; a live view frame has arrived
  int misses = 0, shots = 0;

  ~Gphoto() override {
    close();
    if (models) gp_abilities_list_free(models);
    gp_context_unref(ctx);
  }

  // The cameras plugged in that libgphoto2 can take photos with (phones and card readers show up too, without that).
  struct Seen { std::string model, port; CameraAbilities abilities; };
  std::vector<Seen> detect() {
    if (!models) {
      gp_abilities_list_new(&models);
      gp_abilities_list_load(models, ctx);
      // Said once, for whoever runs `camera-helper probe`: with a driver missing, no camera is ever found.
      GPPortInfoList* p = nullptr;
      gp_port_info_list_new(&p);
      gp_port_info_list_load(p);
      if (gp_abilities_list_count(models) <= 0) fprintf(stderr, "libgphoto2: no camera driver could be loaded from %s\n", getenv("CAMLIBS"));
      if (gp_port_info_list_count(p) <= 0) fprintf(stderr, "libgphoto2: no USB driver could be loaded from %s\n", getenv("IOLIBS"));
      gp_port_info_list_free(p);
    }
    std::vector<Seen> out;
    CameraList* l = nullptr;
    gp_list_new(&l);
    if (gp_camera_autodetect(l, ctx) >= GP_OK)
      for (int i = 0; i < gp_list_count(l); i++) {
        const char *model = "", *port = "";
        gp_list_get_name(l, i, &model);
        gp_list_get_value(l, i, &port);
        Seen s{model, port, {}};
        const int m = gp_abilities_list_lookup_model(models, model);
        if (m >= 0 && gp_abilities_list_get_abilities(models, m, &s.abilities) >= GP_OK && (s.abilities.operations & GP_OPERATION_CAPTURE_IMAGE)) out.push_back(s);
      }
    gp_list_free(l);
    return out;
  }
  std::vector<Camera> list() override {
    std::vector<Camera> out;
    for (auto& s : detect()) out.push_back({"gphoto:" + s.model, s.model});
    return out;
  }

  void open(const std::string& id) override {
    close();
    for (auto& s : detect()) {
      if ("gphoto:" + s.model != id) continue;
      GPPortInfo info;
      gp_port_info_list_new(&ports);
      gp_port_info_list_load(ports);
      const int p = gp_port_info_list_lookup_path(ports, s.port.c_str());
      if (p < 0 || gp_port_info_list_get_info(ports, p, &info) < GP_OK) break;
      int r = GP_ERROR;
      for (int tries = 0; tries < 4; tries++) {
        gp_camera_new(&cam);
        gp_camera_set_abilities(cam, s.abilities);
        gp_camera_set_port_info(cam, info);
        if ((r = gp_camera_init(cam, ctx)) >= GP_OK) break;
        gp_camera_unref(cam);
        cam = nullptr;
        if (r != GP_ERROR_IO_USB_CLAIM) break;
#ifdef __APPLE__
        if (system("/usr/bin/killall ptpcamerad 2>/dev/null")) {} // macOS's camera service holds it: see the top of this file
#endif
        std::this_thread::sleep_for(std::chrono::milliseconds(300));
      }
      if (r < GP_OK) {
        close();
        check(r, r == GP_ERROR_IO_USB_CLAIM ? "busy" : "open_failed", r == GP_ERROR_IO_USB_CLAIM ? "another program is using the camera: quit it, or unplug the camera and plug it in again" : "couldn't open the camera");
      }
      toComputer();
      return;
    }
    close();
    throw Error("not_found", "camera not found: " + id);
  }
  void close() override {
    if (cam) {
      toggle("viewfinder", 0);
      gp_camera_exit(cam, ctx);
      gp_camera_unref(cam);
    }
    if (ports) gp_port_info_list_free(ports);
    cam = nullptr, ports = nullptr, on = ram = seen = false, misses = 0;
  }
  GPCamera* need() {
    if (!cam) throw Error("not_connected", "camera not connected");
    return cam;
  }

  // One of the camera's settings, by libgphoto2's name for it: nullptr when the camera has none. Free it with gp_widget_free.
  CameraWidget* widget(const char* name) {
    CameraWidget* w = nullptr;
    return cam && gp_camera_get_single_config(cam, name, &w, ctx) >= GP_OK ? w : nullptr;
  }
  std::string text(CameraWidget* w) {
    CameraWidgetType t;
    const char* v = nullptr;
    gp_widget_get_type(w, &t);
    return (t == GP_WIDGET_RADIO || t == GP_WIDGET_MENU || t == GP_WIDGET_TEXT) && gp_widget_get_value(w, &v) >= GP_OK && v ? v : "";
  }
  // An on/off setting, where the camera has it (a mirror to drop, a focus drive to start): no error when it hasn't.
  void toggle(const char* name, int v) {
    CameraWidget* w = widget(name);
    if (!w) return;
    CameraWidgetType t;
    gp_widget_get_type(w, &t);
    if (t == GP_WIDGET_TOGGLE && gp_widget_set_value(w, &v) >= GP_OK) gp_camera_set_single_config(cam, name, w, ctx);
    gp_widget_free(w);
  }
  // Photos go to the computer, not the card (the makers word that choice differently: "Internal RAM", "sdram"), so
  // the camera needs no card. A camera without the choice keeps its photos on the card, and the booth copies them.
  void toComputer() {
    CameraWidget* w = widget("capturetarget");
    if (!w) return;
    for (int i = 0; i < gp_widget_count_choices(w) && !ram; i++) {
      const char* c = nullptr;
      if (gp_widget_get_choice(w, i, &c) >= GP_OK && c && lower(c).find("ram") != std::string::npos && gp_widget_set_value(w, c) >= GP_OK)
        ram = gp_camera_set_single_config(cam, "capturetarget", w, ctx) >= GP_OK;
    }
    gp_widget_free(w);
  }

  void live(bool v) override {
    need();
    on = v, misses = 0;
    if (!v) toggle("viewfinder", 0); // a DSLR's mirror comes down, the sensor rests
  }
  void focus() override {
    need();
    toggle("autofocusdrive", 1);
  }
  std::string battery() override {
    CameraWidget* w = widget("batterylevel");
    if (!w) return "";
    const std::string v = text(w);
    gp_widget_free(w);
    return !v.empty() && v.back() == '%' ? v : "";
  }

  std::vector<Prop> props() override {
    need();
    std::vector<Prop> out;
    for (auto& s : SETTINGS)
      for (auto name : s.names) {
        CameraWidget* w = widget(name);
        if (!w) continue;
        Prop p{s.key, {}, -1, false};
        const std::string now = text(w);
        int readonly = 0;
        gp_widget_get_readonly(w, &readonly);
        for (int i = 0; i < gp_widget_count_choices(w) && i < 200; i++) {
          const char* c = nullptr;
          if (gp_widget_get_choice(w, i, &c) < GP_OK || !c) continue;
          if (now == c) p.value = int(p.options.size());
          p.options.push_back(shown(s.key, c));
        }
        if (p.value < 0 && !now.empty()) p.options.push_back(shown(s.key, now)), p.value = int(p.options.size()) - 1; // a value outside the camera's list
        p.writable = !readonly && p.options.size() > 1;
        gp_widget_free(w);
        if (!p.options.empty()) out.push_back(p);
        break;
      }
    return out;
  }
  void setProp(const std::string& key, int index) override {
    need();
    for (auto& s : SETTINGS) {
      if (key != s.key) continue;
      for (auto name : s.names) {
        CameraWidget* w = widget(name);
        if (!w) continue;
        const char* c = nullptr;
        int r = index >= 0 && index < gp_widget_count_choices(w) ? gp_widget_get_choice(w, index, &c) : GP_ERROR_BAD_PARAMETERS;
        if (r >= GP_OK) r = gp_widget_set_value(w, c);
        if (r >= GP_OK) r = gp_camera_set_single_config(cam, name, w, ctx);
        gp_widget_free(w);
        check(r, r == GP_ERROR_BAD_PARAMETERS ? "bad_value" : "locked", r == GP_ERROR_BAD_PARAMETERS ? "not one of the camera's values" : "the camera didn't take the setting: its dial or mode may decide it");
        return;
      }
    }
    throw Error("unsupported", "the camera has no such setting");
  }

  // The photo: the camera's shutter, then its JPEG fetched into dir. With RAW + JPEG the camera hands over two files,
  // the second announced a moment later: the JPEG is the booth's. What went to the camera's memory is cleared from
  // there; what went to its card stays on the card.
  std::string shoot(const fs::path& dir) override {
    need();
    CameraFilePath first;
    check(gp_camera_capture(cam, GP_CAPTURE_IMAGE, &first, ctx), "shot_failed", "the camera didn't take the photo");
    const auto jpeg = [](const CameraFilePath& p) {
      const std::string n = lower(p.name);
      return n.size() > 4 && (n.compare(n.size() - 4, 4, ".jpg") == 0 || (n.size() > 5 && n.compare(n.size() - 5, 5, ".jpeg") == 0));
    };
    std::vector<CameraFilePath> files = {first};
    for (auto end = Clock::now() + std::chrono::seconds(5); std::none_of(files.begin(), files.end(), jpeg) && Clock::now() < end;) {
      CameraEventType type;
      void* data = nullptr;
      if (gp_camera_wait_for_event(cam, 200, &type, &data, ctx) < GP_OK) break;
      if (type == GP_EVENT_FILE_ADDED && data) files.push_back(*static_cast<CameraFilePath*>(data));
      free(data);
    }
    const auto it = std::find_if(files.begin(), files.end(), jpeg);
    std::string saved;
    if (it != files.end()) {
      CameraFile* f = nullptr;
      gp_file_new(&f);
      const fs::path out = dir / ("gphoto-" + std::to_string(++shots) + ".jpg");
      if (gp_camera_file_get(cam, it->folder, it->name, GP_FILE_TYPE_NORMAL, f, ctx) >= GP_OK && gp_file_save(f, out.string().c_str()) >= GP_OK) saved = out.u8string();
      gp_file_unref(f);
    }
    if (ram) for (auto& p : files) gp_camera_file_delete(cam, p.folder, p.name, ctx);
    if (it == files.end()) throw Error("no_jpeg", "the camera saved no JPEG: set its image quality to JPEG, or RAW + JPEG");
    if (saved.empty()) throw Error("shot_failed", "the photo couldn't be fetched from the camera");
    return saved;
  }

  // Live view: one frame per turn of the main loop, as fast as the camera hands them over. Frames that stop coming
  // after they had been (about a second of misses) mean the camera is unplugged or off. A camera that never sends
  // one has no live view libgphoto2 can use: the booth then shows nothing until the photo.
  void tick() override {
    if (!cam || !on || (!seen && misses > 60)) return;
    CameraFile* f = nullptr;
    gp_file_new(&f);
    const char* data = nullptr;
    unsigned long n = 0;
    const bool ok = gp_camera_capture_preview(cam, f, ctx) >= GP_OK && gp_file_get_data_and_size(f, &data, &n) >= GP_OK && n > 2 && static_cast<unsigned char>(data[0]) == 0xFF && static_cast<unsigned char>(data[1]) == 0xD8;
    if (ok) seen = true, misses = 0, frame(data, n);
    gp_file_unref(f);
    if (!ok && ++misses > 60 && seen) { close(); lostEvent(); }
  }
};

} // namespace

std::unique_ptr<Backend> gphoto() {
  // libgphoto2 loads its camera and port drivers from folders: ours sit next to the program. (A test points IOLIBS
  // at the virtual camera's driver instead, so what is already set stays.)
  const fs::path dir = exeDir() / "gphoto";
  setenv("CAMLIBS", (dir / "camlibs").string().c_str(), 0);
  setenv("IOLIBS", (dir / "iolibs").string().c_str(), 0);
  return std::make_unique<Gphoto>();
}
