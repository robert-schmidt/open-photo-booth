// What camera-helper's backends share with main.cpp: one Backend per maker's SDK (sony.cpp, nikon.cpp), compiled in
// only when that SDK is present (scripts/build-camera.mjs).
#pragma once
#include <chrono>
#include <filesystem>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;
using Clock = std::chrono::steady_clock;

struct Error : std::runtime_error {
  std::string code;
  Error(std::string code, const std::string& message) : std::runtime_error(message), code(std::move(code)) {}
};

// One kind of camera: a maker's SDK, or the simulated camera. Camera ids start with the backend's name. Every method
// runs on the main thread; SDK callbacks on other threads leave what they bring for tick() to pick up.
struct Camera { std::string id, name; };
struct Backend {
  virtual ~Backend() = default;
  virtual std::vector<Camera> list() = 0;
  virtual void open(const std::string& id) = 0;
  virtual void close() = 0;
  virtual void live(bool on) = 0;
  virtual void focus() {}
  virtual std::string battery() { return ""; } // "AC", "80%", or "" when the camera doesn't say
  virtual std::string shoot(const fs::path& dir) = 0; // the camera's JPEG, saved in dir (its path in UTF-8)
  virtual void tick() {} // on every turn of the main loop (at least every 15 ms): send live view frames, notice a lost camera
  virtual void sim(const std::string&) { throw Error("bad_op", "not a simulated camera"); }
};

// Output, from the main thread only.
void json(const std::string& s);
void frame(const void* jpeg, size_t n);
std::string quote(const std::string& s);
inline void lostEvent() { json("{\"event\":\"lost\"}"); } // the open camera went away

// Runs the platform's event loop until done() is true, for up to ms milliseconds; then throws Error("timeout", what).
// For SDKs that answer on threads of their own, or need the main thread's loop meanwhile. Live view waits meanwhile.
void await(const std::function<bool()>& done, int ms, const std::string& what);

fs::path exeDir(); // the folder camera-helper runs from, where the SDKs' files sit

std::unique_ptr<Backend> sony(); // nullptr when the SDK can't start
std::unique_ptr<Backend> nikon();
