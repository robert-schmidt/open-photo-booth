// camera-helper: controls cameras through their makers' SDKs for the booth app (cameras.js), in a process of its own so a
// crash or hang inside an SDK can't take the booth down; the app restarts it.
//
// Commands come in on stdin, one per line: "<id> <op> [arg]".
//   list                  the cameras plugged in: {"cameras":[{"id","name"}]}
//   open <camera>         start a session with that camera
//   live 1|0              live view on or off; frames come out as they arrive
//   focus                 focus now (the booth does this at "1" in the countdown)
//   status                the open camera: {"name","battery"}; battery is "AC", a percentage like "80%", or ""
//   props                 the camera's settings: {"props":[{"key","value","writable","options":[…]}],"flash"} (see Prop in helper.h)
//   set <key> <index>     change one of them to options[index]
//   shoot                 take a photo with the camera's shutter: {"file"} is the camera's JPEG, in --dir
//   close                 end the session
//   sim <what>            the simulated camera only: unplug, plug, crash, hang
// Every answer carries the command's id, with "ok":true or "ok":false, "error" (a code) and "message".
// Messages out (stdout): a 4-byte big-endian length, a kind byte (0 JSON, 1 a live view JPEG), then the payload.
// Events without an id: {"event":"lost"} when the open camera goes away.
//
// Every camera call starts on the main thread, which runs the platform's event loop (a CFRunLoop on macOS, a message
// loop on Windows) whenever it waits: some SDKs deliver their callbacks there, others on threads of their own. Stdin is
// read on a thread of its own. When stdin closes (the app has quit), the helper ends the session and exits, so a camera
// is never left held.
//
// The makers' backends: sony.cpp (Camera Remote SDK) and nikon.cpp (Nikon's SDK for Z cameras), each compiled in only
// when scripts/build-camera.mjs finds that SDK in drivers/. gphoto.cpp (libgphoto2, open source) covers the cameras
// those don't: it is compiled in when scripts/build-gphoto.mjs has built its libraries.
//
// Usage: camera-helper [--dir <folder for photos>] [--sim <live view.jpg> <photo.jpg>]
//        camera-helper probe [--sim ...]   tries the first camera it finds and says how it went (for trying bodies)
#include "helper.h"
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <deque>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <thread>
#ifdef __APPLE__
#include <CoreFoundation/CoreFoundation.h>
#include <mach-o/dyld.h>
#include <unistd.h>
#elif defined(_WIN32)
#include <fcntl.h>
#include <io.h>
#include <windows.h>
#endif

// Output. Only the main thread writes. The messages have stdout to themselves: what the SDKs print goes to stderr.
static FILE* out = stdout;
static void send(uint8_t kind, const void* data, size_t n) {
  const uint8_t head[5] = {uint8_t(n >> 24), uint8_t(n >> 16), uint8_t(n >> 8), uint8_t(n), kind};
  fwrite(head, 1, 5, out);
  fwrite(data, 1, n, out);
  fflush(out);
}
std::string quote(const std::string& s) {
  std::string out = "\"";
  for (unsigned char c : s) {
    if (c == '"' || c == '\\') out += '\\', out += char(c);
    else if (c < 0x20) { char u[8]; snprintf(u, sizeof u, "\\u%04x", c); out += u; }
    else out += char(c);
  }
  return out + "\"";
}
static bool probing = false; // probe mode prints for people instead
void json(const std::string& s) { if (!probing) send(0, s.data(), s.size()); }
static int frames = 0; // sent so far
void frame(const void* jpeg, size_t n) { frames++; if (!probing) send(1, jpeg, n); }

// The simulated camera, for tests: serves one JPEG as its live view (about 15 frames a second) and another as each photo.
// It can be unplugged and plugged back in, crash, or hang on the next shot.
struct Sim : Backend {
  std::string view; fs::path photo;
  bool plugged = true, on = false, opened = false, hang = false;
  Clock::time_point last;
  int shots = 0;
  // Its settings behave like a camera's: in Auto the camera picks ISO, shutter and aperture itself.
  std::vector<Prop> settings = {
    {"mode", {"Auto", "P (program auto)", "A (aperture priority)", "S (shutter priority)", "M (manual)"}, 0, true},
    {"iso", {"Auto", "100", "200", "400", "800", "1600", "3200", "6400"}, 0, false},
    {"shutter", {"1/250", "1/125", "1/60", "1/30"}, 1, false},
    {"aperture", {"f/2.8", "f/4", "f/5.6", "f/8", "f/11"}, 2, false},
    {"ev", {"-2.0", "-1.7", "-1.3", "-1.0", "-0.7", "-0.3", "0", "+0.3", "+0.7", "+1.0", "+1.3", "+1.7", "+2.0"}, 6, true},
    {"wb", {"Auto", "Daylight", "Cloudy", "Incandescent", "Flash"}, 0, true},
    {"flash", {"Off", "Auto", "On (fill)"}, 0, true},
    {"flashEv", {"-1.0", "-0.7", "-0.3", "0", "+0.3", "+0.7", "+1.0"}, 3, true},
  };
  std::vector<Prop> props() override { return settings; }
  void setProp(const std::string& key, int index) override {
    for (auto& p : settings) if (p.key == key) {
      if (!p.writable) throw Error("locked", "the camera decides this in its current mode");
      if (index < 0 || index >= int(p.options.size())) throw Error("bad_value", "not one of the camera's values");
      p.value = index;
      if (key == "mode") for (auto& q : settings) if (q.key == "iso" || q.key == "shutter" || q.key == "aperture") q.writable = index != 0;
      return;
    }
    throw Error("unsupported", "the camera has no such setting");
  }
  std::string flashUnit() override { return "ready"; }
  Sim(const fs::path& liveFile, fs::path photoFile) : photo(std::move(photoFile)) {
    std::ifstream in(liveFile, std::ios::binary);
    view.assign(std::istreambuf_iterator<char>(in), {});
    if (view.empty() || !fs::exists(photo)) throw std::runtime_error("--sim: can't read the live view or photo file");
  }
  std::vector<Camera> list() override {
    if (!plugged) return {};
    return {{"sim", "Simulated camera (full-resolution photos)"}};
  }
  void open(const std::string&) override {
    if (!plugged) throw Error("not_found", "camera not found");
    opened = true;
  }
  void close() override { opened = on = false; }
  void live(bool v) override { on = v; }
  std::string battery() override { return "AC"; }
  void tick() override {
    if (!opened || !on || !plugged || Clock::now() - last < std::chrono::milliseconds(66)) return;
    last = Clock::now();
    frame(view.data(), view.size());
  }
  std::string shoot(const fs::path& dir) override {
    if (!opened || !plugged) throw Error("not_connected", "camera not connected");
    while (hang) std::this_thread::sleep_for(std::chrono::hours(1));
    std::this_thread::sleep_for(std::chrono::milliseconds(300)); // focus and shutter
    fs::path out = dir / ("sim-" + std::to_string(++shots) + ".jpg");
    fs::copy_file(photo, out, fs::copy_options::overwrite_existing);
    return out.u8string();
  }
  void sim(const std::string& what) override {
    if (what == "unplug" && plugged) { plugged = false; if (opened) lostEvent(); opened = on = false; }
    else if (what == "plug") plugged = true;
    else if (what == "crash") std::abort();
    else if (what == "hang") hang = true;
  }
};

static std::vector<std::unique_ptr<Backend>> backends;
static Backend* current = nullptr;
static std::string currentName;
static fs::path dir = fs::temp_directory_path();

// The cameras found by the last "list" (an SDK may take a moment to look), and whose they are.
struct Found { Camera camera; Backend* backend; };
static std::vector<Found> found;
// A camera that a maker's SDK controls is listed once, as that SDK's: libgphoto2 (asked last, its ids "gphoto:Sony …")
// sees the same body. ponytail: so with a new and an old body of one maker plugged in, only the new one is offered.
static std::vector<Found>& listAll() {
  found.clear();
  for (auto& b : backends) for (auto& c : b->list()) {
    const bool twice = c.id.rfind("gphoto:", 0) == 0 && std::any_of(found.begin(), found.end(), [&](const Found& f) {
      const std::string maker = f.camera.id.substr(0, f.camera.id.find(':'));
      std::string its = c.id.substr(7, maker.size());
      std::transform(its.begin(), its.end(), its.begin(), [](unsigned char ch) { return char(std::tolower(ch)); });
      return (maker == "sony" || maker == "nikon") && its == maker;
    });
    if (!twice) found.push_back({c, b.get()});
  }
  return found;
}
static const Found& find(const std::string& id) {
  for (int tries = 0; tries < 2; tries++, listAll())
    for (auto& f : found) if (f.camera.id == id) return f;
  throw Error("not_found", "camera not found: " + id);
}
static Backend& open() {
  if (!current) throw Error("not_open", "no camera open");
  return *current;
}

static void handle(const std::string& line) {
  std::istringstream in(line);
  long id = 0;
  std::string op, arg;
  in >> id >> op;
  std::getline(in >> std::ws, arg);
  std::string extra;
  try {
    if (op == "list") {
      std::string cams;
      for (auto& f : listAll()) cams += (cams.empty() ? "" : ",") + ("{\"id\":" + quote(f.camera.id) + ",\"name\":" + quote(f.camera.name) + "}");
      extra = ",\"cameras\":[" + cams + "]";
    } else if (op == "open") {
      if (current) current->close(), current = nullptr;
      const Found f = find(arg);
      f.backend->open(arg);
      current = f.backend;
      currentName = f.camera.name;
    } else if (op == "live") open().live(arg == "1");
    else if (op == "focus") open().focus();
    else if (op == "status") extra = ",\"name\":" + quote(currentName) + ",\"battery\":" + quote(open().battery());
    else if (op == "props") {
      std::string all;
      for (auto& p : open().props()) {
        std::string options;
        for (auto& o : p.options) options += (options.empty() ? "" : ",") + quote(o);
        all += (all.empty() ? "" : ",") + ("{\"key\":" + quote(p.key) + ",\"value\":" + std::to_string(p.value) + ",\"writable\":" + (p.writable ? "true" : "false") + ",\"options\":[" + options + "]}");
      }
      extra = ",\"flash\":" + quote(open().flashUnit()) + ",\"props\":[" + all + "]";
    } else if (op == "set") {
      std::istringstream a(arg);
      std::string key;
      int index = -1;
      a >> key >> index;
      open().setProp(key, index);
    } else if (op == "shoot") extra = ",\"file\":" + quote(open().shoot(dir));
    else if (op == "close") { if (current) current->close(); current = nullptr; }
    else if (op == "sim") {
      Backend* sim = nullptr;
      for (auto& b : backends) if (dynamic_cast<Sim*>(b.get())) sim = b.get();
      if (!sim) throw Error("bad_op", "no simulated camera");
      sim->sim(arg);
    } else throw Error("bad_op", "unknown command: " + op);
    json("{\"id\":" + std::to_string(id) + ",\"ok\":true" + extra + "}");
  } catch (const Error& e) {
    json("{\"id\":" + std::to_string(id) + ",\"ok\":false,\"error\":" + quote(e.code) + ",\"message\":" + quote(e.what()) + "}");
  } catch (const std::exception& e) {
    json("{\"id\":" + std::to_string(id) + ",\"ok\":false,\"error\":\"failed\",\"message\":" + quote(e.what()) + "}");
  }
}

// The main loop: the platform's events, then the commands that came in, then the backends' turn.
static std::mutex mu;
static std::deque<std::string> lines;
static bool eof = false;
#ifdef __APPLE__
static CFRunLoopRef mainLoop;
static void wake() { CFRunLoopWakeUp(mainLoop); }
static void pump() { CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.015, true); }
#elif defined(_WIN32)
static DWORD mainThread;
static void wake() { PostThreadMessage(mainThread, WM_NULL, 0, 0); }
static void pump() {
  MsgWaitForMultipleObjects(0, nullptr, FALSE, 15, QS_ALLINPUT);
  MSG m;
  while (PeekMessage(&m, nullptr, 0, 0, PM_REMOVE)) { TranslateMessage(&m); DispatchMessage(&m); }
}
#else
static void wake() {}
static void pump() { std::this_thread::sleep_for(std::chrono::milliseconds(15)); }
#endif

void await(const std::function<bool()>& done, int ms, const std::string& what) {
  for (auto end = Clock::now() + std::chrono::milliseconds(ms); !done();) {
    if (Clock::now() > end) throw Error("timeout", what);
    pump();
  }
}

fs::path exeDir() {
#ifdef __APPLE__
  char buf[4096];
  uint32_t n = sizeof buf;
  if (_NSGetExecutablePath(buf, &n) == 0) return fs::canonical(buf).parent_path();
#elif defined(_WIN32)
  wchar_t buf[MAX_PATH];
  if (GetModuleFileNameW(nullptr, buf, MAX_PATH)) return fs::path(buf).parent_path();
#endif
  return fs::current_path();
}

static int serve() {
  std::thread([] {
    std::string line;
    while (std::getline(std::cin, line)) { std::lock_guard<std::mutex> l(mu); lines.push_back(line); wake(); }
    std::lock_guard<std::mutex> l(mu);
    eof = true;
    wake();
  }).detach();
  for (;;) {
    pump();
    std::deque<std::string> todo;
    bool done;
    { std::lock_guard<std::mutex> l(mu); todo.swap(lines); done = eof; }
    for (auto& line : todo) handle(line);
    if (done) break;
    for (auto& b : backends) b->tick();
  }
  if (current) current->close();
  return 0;
}

// Probe: for trying a camera without the app. Lists the cameras, opens the first, counts live view frames for two
// seconds, takes a photo and says where it went. It also lists the camera's settings.
static int probe() {
  probing = true;
  auto say = [](const std::string& s) { std::cout << s << std::endl; };
  say("Looking for cameras (" + std::to_string(backends.size()) + " kinds compiled in)…");
  auto& cams = listAll();
  if (cams.empty()) { say("No camera found. Is it on, plugged in, and in the right USB mode (PC remote / tethering)?"); return 1; }
  for (auto& f : cams) say("Found: " + f.camera.name + " (" + f.camera.id + ")");
  try {
    const Found f = cams[0];
    Backend* b = f.backend;
    b->open(f.camera.id);
    current = b;
    say("Opened " + f.camera.name + ", battery: " + b->battery());
    for (auto& p : b->props()) say("  " + p.key + ": " + (p.value >= 0 && p.value < int(p.options.size()) ? p.options[p.value] : "?") + " (" + std::to_string(p.options.size()) + " values" + (p.writable ? ")" : ", decided on the camera)"));
    say("  flash unit: " + (b->flashUnit().empty() ? "the camera doesn't say" : b->flashUnit()));
    b->live(true);
    for (auto end = Clock::now() + std::chrono::seconds(2); Clock::now() < end;) { pump(); b->tick(); }
    say("Live view: " + std::to_string(frames) + " frames in 2 s");
    b->focus();
    auto t = Clock::now();
    std::string file = b->shoot(dir);
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now() - t).count();
    say("Photo: " + file + " (" + std::to_string(fs::file_size(fs::u8path(file)) / 1024) + " KB, " + std::to_string(ms) + " ms)");
    b->live(false);
    b->close();
    current = nullptr;
    return 0;
  } catch (const std::exception& e) {
    say(std::string("Failed: ") + e.what());
    return 1;
  }
}

int main(int argc, char** argv) {
#ifdef __APPLE__
  mainLoop = CFRunLoopGetMain();
  out = fdopen(dup(1), "wb");
  dup2(2, 1);
#elif defined(_WIN32)
  out = _fdopen(_dup(_fileno(stdout)), "wb");
  _setmode(_fileno(out), _O_BINARY);
  _dup2(_fileno(stderr), _fileno(stdout));
  mainThread = GetCurrentThreadId();
  MSG m;
  PeekMessage(&m, nullptr, WM_USER, WM_USER, PM_NOREMOVE); // gives this thread its message queue
#endif
#ifdef _WIN32
  wchar_t** wide = CommandLineToArgvW(GetCommandLineW(), &argc); // a path may hold any letter (the user's name in it)
  auto arg = [&](int i) { return fs::path(wide[i]); };
#else
  auto arg = [&](int i) { return fs::path(argv[i]); };
#endif
  bool doProbe = false;
  try {
    for (int i = 1; i < argc; i++) {
      std::string a = arg(i).u8string();
      if (a == "probe") doProbe = true;
      else if (a == "--dir" && i + 1 < argc) dir = arg(++i);
      else if (a == "--sim" && i + 2 < argc) { backends.push_back(std::make_unique<Sim>(arg(i + 1), arg(i + 2))); i += 2; }
      else { std::cerr << "camera-helper: unknown argument " << a << std::endl; return 2; }
    }
  } catch (const std::exception& e) {
    std::cerr << "camera-helper: " << e.what() << std::endl;
    return 2;
  }
#ifdef HAVE_SONY
  if (auto b = sony()) backends.push_back(std::move(b));
#endif
#ifdef HAVE_NIKON
  if (auto b = nikon()) backends.push_back(std::move(b));
#endif
#ifdef HAVE_GPHOTO
  if (auto b = gphoto()) backends.push_back(std::move(b));
#endif
  int code = doProbe ? probe() : serve();
  backends.clear(); // the SDKs shut down
  return code;
}
