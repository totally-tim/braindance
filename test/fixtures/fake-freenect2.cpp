// The symbols native/grabber.cpp calls in libfreenect2, behind the real headers, so the real `main`
// runs with no sensor. A device thread delivers synthetic frames: noise in the colour image so a
// JPEG of it is larger than a pipe, zeros in depth.
//
// FAKE_DEPTH_MS     milliseconds before each depth frame, the first included (default 10).
// FAKE_COLOUR_EVERY a colour frame comes with every Nth depth frame, the first included (default 10).
// FAKE_MAX_FRAMES   depth frames to deliver before the sensor goes quiet (default: no limit).
// FAKE_REGISTER_MS  how long Registration::apply takes (default 0), so a test can order the
//                   grabber's frame write after its encoder thread's.
#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/frame_listener_impl.h>
#include <libfreenect2/registration.h>
#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/logger.h>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <thread>
#include <vector>

namespace libfreenect2 {

// Frames the grabber took from a listener and frames it gave back, by stream, so the device's
// close can say whether every frame the grabber held was returned. Frames still queued in the
// listener were never taken and are not counted.
static std::atomic<unsigned long long> g_taken[2], g_returned[2];
static int stream(Frame::Type type) { return type == Frame::Depth ? 1 : 0; }

static int envMs(const char *name, int fallback) {
  const char *text = std::getenv(name);
  return text ? std::atoi(text) : fallback;
}

Frame::Frame(size_t width_, size_t height_, size_t bytes_per_pixel_, unsigned char *data_)
    : width(width_), height(height_), bytes_per_pixel(bytes_per_pixel_), data(data_),
      timestamp(0), sequence(0), exposure(0), gain(0), gamma(0), status(0), format(Invalid),
      rawdata(nullptr) {
  if (!data) {
    rawdata = new unsigned char[width * height * bytes_per_pixel]();
    data = rawdata;
  }
}
Frame::~Frame() { delete[] rawdata; }

FrameListener::~FrameListener() {}

class SyncMultiFrameListenerImpl {
 public:
  Frame::Type type;
  std::mutex m;
  std::condition_variable cv;
  std::deque<Frame *> queue;
  std::atomic<unsigned long long> handedOut{0};
};

SyncMultiFrameListener::SyncMultiFrameListener(unsigned int frame_types)
    : impl_(new SyncMultiFrameListenerImpl) {
  impl_->type = (Frame::Type)frame_types;
}
SyncMultiFrameListener::~SyncMultiFrameListener() {
  for (Frame *f : impl_->queue) delete f;
  delete impl_;
}
bool SyncMultiFrameListener::hasNewFrame() const {
  std::lock_guard<std::mutex> lock(impl_->m);
  return !impl_->queue.empty();
}
bool SyncMultiFrameListener::waitForNewFrame(FrameMap &frame, int milliseconds) {
  std::unique_lock<std::mutex> lock(impl_->m);
  if (!impl_->cv.wait_for(lock, std::chrono::milliseconds(milliseconds),
                          [this] { return !impl_->queue.empty(); })) return false;
  frame[impl_->type] = impl_->queue.front();
  impl_->queue.pop_front();
  g_taken[stream(impl_->type)]++;
  // A test counts these to see whether the grabber's loop is still taking frames.
  if (impl_->type == Frame::Depth) std::fprintf(stderr, "[fake] depth frame %llu handed out\n", ++impl_->handedOut);
  return true;
}
void SyncMultiFrameListener::waitForNewFrame(FrameMap &frame) { waitForNewFrame(frame, 1 << 30); }
void SyncMultiFrameListener::release(FrameMap &frame) {
  g_returned[stream(impl_->type)] += frame.size();
  for (auto &entry : frame) delete entry.second;
  frame.clear();
}
// Keeps the newest two, as the real listener replaces a frame nobody took.
bool SyncMultiFrameListener::onNewFrame(Frame::Type, Frame *frame) {
  {
    std::lock_guard<std::mutex> lock(impl_->m);
    impl_->queue.push_back(frame);
    while (impl_->queue.size() > 2) { delete impl_->queue.front(); impl_->queue.pop_front(); }
  }
  impl_->cv.notify_one();
  return true;
}

Freenect2Device::Config::Config()
    : MinDepth(0.5f), MaxDepth(4.5f), EnableBilateralFilter(true), EnableEdgeAwareFilter(true) {}
Freenect2Device::~Freenect2Device() {}

namespace {

class FakeDevice : public Freenect2Device {
 public:
  ~FakeDevice() override { stopThread(); }
  std::string getSerialNumber() override { return "fake-0001"; }
  std::string getFirmwareVersion() override { return "fake"; }
  ColorCameraParams getColorCameraParams() override {
    ColorCameraParams p;
    std::memset(&p, 0, sizeof(p));
    p.fx = 1081.37f; p.fy = 1081.37f; p.cx = 959.5f; p.cy = 539.5f;
    return p;
  }
  IrCameraParams getIrCameraParams() override {
    IrCameraParams p;
    std::memset(&p, 0, sizeof(p));
    p.fx = 366.0f; p.fy = 366.0f; p.cx = 256.0f; p.cy = 212.0f;
    return p;
  }
  void setColorCameraParams(const ColorCameraParams &) override {}
  void setIrCameraParams(const IrCameraParams &) override {}
  void setConfiguration(const Config &) override {}
  void setColorFrameListener(FrameListener *l) override { colour_ = l; }
  void setIrAndDepthFrameListener(FrameListener *l) override { depth_ = l; }
  void setColorAutoExposure(float) override {}
  void setColorSemiAutoExposure(float) override {}
  void setColorManualExposure(float, float) override {}
  void setColorSetting(ColorSettingCommandType, uint32_t) override {}
  void setColorSetting(ColorSettingCommandType, float) override {}
  uint32_t getColorSetting(ColorSettingCommandType) override { return 0; }
  float getColorSettingFloat(ColorSettingCommandType) override { return 0.0f; }
  void setLedStatus(LedSettings) override {}
  bool start() override { return startStreams(true, true); }
  bool startStreams(bool rgb, bool) override {
    if (!rgb) colour_ = nullptr;
    running_ = true;
    thread_ = std::thread(&FakeDevice::produce, this);
    return true;
  }
  bool stop() override {
    stopThread();
    std::fprintf(stderr, "[fake] device stopped\n");
    return true;
  }
  bool close() override {
    std::fprintf(stderr, "[fake] device closed: depth %llu taken, %llu returned; colour %llu taken, %llu returned\n",
                 g_taken[1].load(), g_returned[1].load(), g_taken[0].load(), g_returned[0].load());
    return true;
  }

 private:
  void stopThread() {
    running_ = false;
    if (thread_.joinable()) thread_.join();
  }

  void produce() {
    const int depthMs = envMs("FAKE_DEPTH_MS", 10);
    const int maxFrames = envMs("FAKE_MAX_FRAMES", 0);
    const int colourEvery = envMs("FAKE_COLOUR_EVERY", 10);
    std::vector<unsigned char> noise(1920 * 1080 * 4);
    uint32_t x = 2463534242u;
    for (auto &b : noise) { x ^= x << 13; x ^= x >> 17; x ^= x << 5; b = (unsigned char)x; }
    for (int n = 0; running_ && (maxFrames == 0 || n < maxFrames); n++) {
      // In slices, so stop() does not wait out a long interval.
      for (int waited = 0; running_ && waited < depthMs; waited += 10) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
      }
      if (!running_) break;
      if (colour_ && n % colourEvery == 0) {
        Frame *c = new Frame(1920, 1080, 4);
        c->format = Frame::BGRX;
        std::memcpy(c->data, noise.data(), noise.size());
        if (!colour_->onNewFrame(Frame::Color, c)) delete c;
      }
      Frame *d = new Frame(512, 424, 4);
      d->format = Frame::Float;
      if (!depth_->onNewFrame(Frame::Depth, d)) delete d;
    }
  }

  FrameListener *colour_ = nullptr, *depth_ = nullptr;
  std::atomic<bool> running_{false};
  std::thread thread_;
};

}  // namespace

Freenect2::Freenect2(void *) : impl_(nullptr) {}
Freenect2::~Freenect2() {}
int Freenect2::enumerateDevices() { return 1; }
std::string Freenect2::getDefaultDeviceSerialNumber() { return "fake-0001"; }
Freenect2Device *Freenect2::openDevice(const std::string &, const PacketPipeline *) {
  return new FakeDevice;
}

Registration::Registration(Freenect2Device::IrCameraParams, Freenect2Device::ColorCameraParams)
    : impl_(nullptr) {}
Registration::~Registration() {}
void Registration::apply(const Frame *, const Frame *, Frame *, Frame *, const bool, Frame *, int *) const {
  std::this_thread::sleep_for(std::chrono::milliseconds(envMs("FAKE_REGISTER_MS", 0)));
}
void Registration::undistortDepth(const Frame *, Frame *) const {}

PacketPipeline::PacketPipeline() : comp_(nullptr) {}
PacketPipeline::~PacketPipeline() {}
PacketPipeline::PacketParser *PacketPipeline::getRgbPacketParser() const { return nullptr; }
PacketPipeline::PacketParser *PacketPipeline::getIrPacketParser() const { return nullptr; }
RgbPacketProcessor *PacketPipeline::getRgbPacketProcessor() const { return nullptr; }
DepthPacketProcessor *PacketPipeline::getDepthPacketProcessor() const { return nullptr; }
bool PacketPipeline::colorDecoderStarted() const { return true; }
const char *PacketPipeline::colorDecoderName() const { return "turbojpeg"; }
CpuPacketPipeline::CpuPacketPipeline(ColorDecoder) {}
CpuPacketPipeline::~CpuPacketPipeline() {}
ColorDecoder defaultColorDecoder() { return ColorDecoder::TurboJPEG; }

Logger::~Logger() {}
Logger::Level Logger::level() const { return level_; }
std::string Logger::level2str(Level level) {
  static const char *names[] = {"none", "error", "warning", "info", "debug"};
  return names[level];
}
void setGlobalLogger(Logger *) {}

}  // namespace libfreenect2
