// Kinect v2 grabber: pulls depth + registered colour from libfreenect2 and writes a
// length-framed binary stream to stdout. All logging goes to stderr, because a stray log
// line on stdout would desync the frame stream.
//
//   [u32 magic 'KNCT'][u32 type][u32 payloadLen][payload]
//
//   type 1 (hello) : UTF-8 JSON, sent once before any frame
//   type 2 (frame) : [u32 depthBytes][u32 colorBytes][u64 timestampMs]
//                    [u16 depth[512*424] millimetres, 0 = no reading]
//                    [JPEG of the registered 512x424 colour image]
//   type 3 (colour): [u64 timestampMs][JPEG of the native 1920x1080 colour image]
//                    Only while the server has asked for it - see `hd-color` below.
//   type 4 (key)   : [u64 timestampMs][u64 colourTs][f32 fx][f32 fy][f32 cx][f32 cy][f32 rangeM]
//                    [greyscale JPEG of the 1920x1080 depth mapped into the colour frame,
//                    0 = no reading, level n = n/KEY_DEPTH_LEVELS * rangeM metres]
//                    Only while the server has asked for it - see `key` below.

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cstdint>
#include <csignal>
#include <cerrno>
#include <cmath>
#include <string>
#include <vector>
#include <memory>
#include <chrono>
#include <atomic>
#include <condition_variable>
#include <mutex>
#include <thread>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>

#include <libfreenect2/config.h>
#include <libfreenect2/libfreenect2.hpp>
#include <libfreenect2/frame_listener_impl.h>
#include <libfreenect2/registration.h>
#include <libfreenect2/packet_pipeline.h>
#include <libfreenect2/logger.h>

#include <turbojpeg.h>

static const uint32_t MAGIC = 0x4B4E4354; // 'KNCT'
static const uint32_t TYPE_HELLO = 1;
static const uint32_t TYPE_FRAME = 2;
static const uint32_t TYPE_COLOR = 3;
static const uint32_t TYPE_KEY = 4;

// The levels a type 4 key carries a reading on: 0 means no reading, so a depth inside the
// range quantises into 1..255 and reads back as level/255 * rangeM metres. Unavoidably a
// second spelling of a JavaScript number, since the browser cannot import a C++ constant.
static const uint32_t KEY_DEPTH_LEVELS = 255;

// Fixed rather than following --quality: the key is read as numbers rather than looked at,
// so the setting that trades detail for bytes on a picture does not apply to it.
static const int KEY_JPEG_QUALITY = 90;

static const int CW = 1920;
static const int CH = 1080;

// What generation of this format the hello declares: move the depth quantisation or the
// registration path and one geometry model would run over two archives, reprojecting the
// older half wrong. Unavoidably a second spelling of a JavaScript number, since the browser
// cannot import a C++ constant and Node reads `web/format.js` by path - `tools/syntax-check.mjs`
// requires the two equal.
static const uint32_t CAPTURE_FORMAT = 1;

// A corpus is deliberately not KNCT: the wire format carries u16 millimetre depth and a
// JPEG, both lossy relative to what Registration::apply consumes. Its own magic keeps the
// two from ever being read by the wrong reader.
static const uint32_t CORPUS_MAGIC = 0x4B435250; // 'KCRP'
static const uint32_t CORPUS_VERSION = 1;

static const int DW = 512;
static const int DH = 424;
static const size_t DEPTH_PIXELS = (size_t)DW * DH;

static volatile std::sig_atomic_t g_stop = 0;
static void on_signal(int) { g_stop = 1; }

// libfreenect2 logs to stdout by default, which would corrupt the binary stream.
class StderrLogger : public libfreenect2::Logger {
public:
  explicit StderrLogger(Level level) { level_ = level; }
  void log(Level level, const std::string &message) override {
    std::fprintf(stderr, "[%s] %s\n", libfreenect2::Logger::level2str(level).c_str(), message.c_str());
    std::fflush(stderr);
  }
};

// Pipe writes are capped at 64KB on macOS, so a ~500KB frame always partial-writes.
static bool write_all(int fd, const void *buf, size_t len) {
  const uint8_t *p = static_cast<const uint8_t *>(buf);
  while (len > 0) {
    ssize_t n = ::write(fd, p, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    p += n;
    len -= (size_t)n;
  }
  return true;
}

// Corpus files are written whole and closed before the next frame is touched, so a corpus
// interrupted mid-capture leaves complete frames rather than a trailing half-frame.
static bool write_file(const std::string &path, const void *const *parts,
                       const size_t *lens, size_t n) {
  int fd = ::open(path.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
  if (fd < 0) {
    std::fprintf(stderr, "[grabber] cannot open %s: %s\n", path.c_str(), std::strerror(errno));
    return false;
  }
  bool ok = true;
  for (size_t i = 0; i < n && ok; i++) ok = write_all(fd, parts[i], lens[i]);
  if (::close(fd) != 0) ok = false;
  if (!ok) std::fprintf(stderr, "[grabber] short write to %s\n", path.c_str());
  return ok;
}

// stdout has two writers - the frame loop and the encoder thread - and a message is a
// header plus a payload as two `write_all` calls over a pipe that partial-writes at 64KB.
// Without this lock the two interleave and the parser reads a desync.
static std::mutex g_writeMutex;

static bool write_message(int fd, uint32_t type, const void *payload, uint32_t payloadLen) {
  std::lock_guard<std::mutex> lock(g_writeMutex);
  uint32_t header[3] = {MAGIC, type, payloadLen};
  if (!write_all(fd, header, sizeof(header))) return false;
  if (payloadLen && !write_all(fd, payload, payloadLen)) return false;
  return true;
}

static uint64_t now_ms() {
  using namespace std::chrono;
  return (uint64_t)duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

// Microseconds, because the serial frame-loop segments are single-digit milliseconds each
// and a millisecond clock would quantise half the profile breakdown to zero.
static uint64_t now_us() {
  using namespace std::chrono;
  return (uint64_t)duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
}

// One pending job owns its colour and depth together; overwriting it drops the whole pair.
class HdEncoder {
public:
  explicit HdEncoder(int quality) : quality_(quality) {}

  // A joinable std::thread destroyed is `std::terminate` rather than a leak, and the corpus
  // writer's early `return 1` never reaches the `stop()` in `main`. Idempotent, because
  // `stop()` joins and a joined thread is no longer joinable.
  ~HdEncoder() { stop(); }

  void start() { thread_ = std::thread(&HdEncoder::run, this); }

  void stop() {
    {
      std::lock_guard<std::mutex> lock(m_);
      stop_ = true;
    }
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
  }

  // The fixed half of every type 4 header, and the range its quantiser reads back as full
  // scale. Set before start(), so the encoder thread never reads it mid-write.
  void setKeyHeader(float fx, float fy, float cx, float cy, float rangeM) {
    keyFx_ = fx; keyFy_ = fy; keyCx_ = cx; keyCy_ = cy; keyRangeM_ = std::fmin(rangeM, 65.535f);
  }

  bool enabled() const { return enabled_.load(std::memory_order_relaxed); }
  void setEnabled(bool on) { enabled_.store(on, std::memory_order_relaxed); }
  uint64_t sent() const { return sent_.load(std::memory_order_relaxed); }
  uint64_t encodeUs() const { return encodeUs_.load(std::memory_order_relaxed); }
  uint64_t dropped() const { return dropped_.load(std::memory_order_relaxed); }

  bool keyEnabled() const { return keyEnabled_.load(std::memory_order_relaxed); }
  void setKeyEnabled(bool on) { keyEnabled_.store(on, std::memory_order_relaxed); }
  uint64_t keySent() const { return keySent_.load(std::memory_order_relaxed); }
  uint64_t keyEncodeUs() const { return keyEncodeUs_.load(std::memory_order_relaxed); }
  uint64_t keyDropped() const { return keyDropped_.load(std::memory_order_relaxed); }

  // Copy a new colour once; pending depth keeps an immutable reference to that exact image.
  void submitColour(const uint8_t *pixels, size_t bytes, uint64_t ts, int format = TJPF_BGRX) {
    {
      std::lock_guard<std::mutex> lock(m_);
      if (!pixels || bytes != (size_t)CW * CH * 4 || (format != TJPF_BGRX && format != TJPF_RGBX)) {
        latestColour_.reset();
        pendingColour_.reset();
        pendingColourIsNew_ = false;
        depth_.clear();
        return;
      }
      if (pendingColourIsNew_) dropped_.fetch_add(1, std::memory_order_relaxed);
      if (!depth_.empty()) keyDropped_.fetch_add(1, std::memory_order_relaxed);
      latestColour_ = std::make_shared<Colour>();
      latestColour_->pixels.assign(pixels, pixels + bytes);
      latestColour_->ts = ts;
      latestColour_->format = format;
      pendingColour_ = latestColour_;
      pendingColourIsNew_ = true;
      depth_.clear();
    }
    cv_.notify_one();
  }

  void submitDepth(const float *rows, size_t floats, uint64_t ts) {
    {
      std::lock_guard<std::mutex> lock(m_);
      if (!latestColour_ || !rows || floats != (size_t)CW * CH) return;
      if (!depth_.empty()) keyDropped_.fetch_add(1, std::memory_order_relaxed);
      pendingColour_ = latestColour_;
      depth_.assign(rows, rows + floats);
      depthTs_ = ts;
    }
    cv_.notify_one();
  }

private:
  void run() {
    // TurboJPEG keeps one reusable destination allocation per compressor; alternating two
    // buffers through one handle frees the first while its pointer is still live.
    tjhandle colourJpeg = tjInitCompress();
    tjhandle keyJpeg = tjInitCompress();
    if (!colourJpeg || !keyJpeg) {
      std::fprintf(stderr, "[grabber] cannot start the hd encoder: %s\n", tjGetErrorStr());
      if (colourJpeg) tjDestroy(colourJpeg);
      if (keyJpeg) tjDestroy(keyJpeg);
      return;
    }
    std::vector<uint8_t> grey, payload;
    std::shared_ptr<Colour> encodedColour;
    std::vector<float> depthWork;
    unsigned char *colourBuf = nullptr;
    unsigned char *keyBuf = nullptr;
    // Never reset between encodes: TurboJPEG reads it as the capacity of the buffer it
    // allocated last time, and zeroing it claims a zero-length buffer the encode runs off.
    // A pair per slot, because each size is the capacity of the buffer beside it, and one
    // shared between two allocations describes whichever encode ran last.
    unsigned long colourSize = 0;
    unsigned long keySize = 0;

    for (;;) {
      uint64_t ts;
      std::shared_ptr<Colour> colourWork;
      depthWork.clear();
      {
        std::unique_lock<std::mutex> lock(m_);
        cv_.wait(lock, [this] { return pendingColour_ || stop_; });
        if (stop_) break;
        colourWork.swap(pendingColour_);
        pendingColourIsNew_ = false;
        depthWork.swap(depth_);
        ts = depthTs_;
      }

      if (encodedColour != colourWork) {
        const uint64_t before = sent();
        if (!encodeColour(colourJpeg, colourWork->pixels, colourWork->ts, colourWork->format,
                          payload, &colourBuf, &colourSize)) break;
        if (sent() == before) continue;
        encodedColour = colourWork;
      }
      if (!depthWork.empty()
          && !encodeKey(keyJpeg, depthWork, ts, colourWork->ts, grey, payload, &keyBuf, &keySize)) break;
    }

    if (colourBuf) tjFree(colourBuf);
    if (keyBuf) tjFree(keyBuf);
    tjDestroy(colourJpeg);
    tjDestroy(keyJpeg);
  }

  /** Encodes and writes one type 3 message. False means stdout is gone. */
  bool encodeColour(tjhandle jpeg, const std::vector<uint8_t> &pixels, uint64_t ts, int format,
                    std::vector<uint8_t> &payload, unsigned char **buf, unsigned long *size) {
    const uint64_t t0 = now_us();
    if (tjCompress2(jpeg, pixels.data(), CW, 0, CH, format, buf, size,
                    TJSAMP_420, quality_, TJFLAG_FASTDCT) != 0) {
      std::fprintf(stderr, "[grabber] hd colour encode failed: %s\n", tjGetErrorStr());
      return true;
    }
    encodeUs_.fetch_add(now_us() - t0, std::memory_order_relaxed);

    payload.resize(8 + (size_t)*size);
    std::memcpy(payload.data(), &ts, 8);
    std::memcpy(payload.data() + 8, *buf, (size_t)*size);
    if (!write_message(STDOUT_FILENO, TYPE_COLOR, payload.data(), (uint32_t)payload.size())) return false;
    sent_.fetch_add(1, std::memory_order_relaxed);
    return true;
  }

  /** Encodes and writes one type 4 message. False means stdout is gone. */
  bool encodeKey(tjhandle jpeg, const std::vector<float> &mm, uint64_t ts, uint64_t colourTs,
                 std::vector<uint8_t> &grey, std::vector<uint8_t> &payload,
                 unsigned char **buf, unsigned long *size) {
    const uint64_t t0 = now_us();
    quantise(mm, grey);
    if (tjCompress2(jpeg, grey.data(), CW, 0, CH, TJPF_GRAY, buf, size,
                    TJSAMP_GRAY, KEY_JPEG_QUALITY, TJFLAG_FASTDCT) != 0) {
      std::fprintf(stderr, "[grabber] key depth encode failed: %s\n", tjGetErrorStr());
      return true;
    }
    keyEncodeUs_.fetch_add(now_us() - t0, std::memory_order_relaxed);

    payload.resize(36 + (size_t)*size);
    uint8_t *p = payload.data();
    std::memcpy(p, &ts, 8);         p += 8;
    std::memcpy(p, &colourTs, 8);   p += 8;
    std::memcpy(p, &keyFx_, 4);     p += 4;
    std::memcpy(p, &keyFy_, 4);     p += 4;
    std::memcpy(p, &keyCx_, 4);     p += 4;
    std::memcpy(p, &keyCy_, 4);     p += 4;
    std::memcpy(p, &keyRangeM_, 4); p += 4;
    std::memcpy(p, *buf, (size_t)*size);
    if (!write_message(STDOUT_FILENO, TYPE_KEY, payload.data(), (uint32_t)payload.size())) return false;
    keySent_.fetch_add(1, std::memory_order_relaxed);
    return true;
  }

  /**
   * Float millimetres into KEY_DEPTH_LEVELS levels of grey, with 0 reserved for no reading.
   * bigdepth is +inf wherever nothing scattered, so the range test rejects rather than lets a
   * value wrap, and a reading inside the range floors at 1 rather than 0 - the difference
   * between a surface close to the sensor and empty space. The JPEG is lossy: measured on a
   * flat field, level 1 survives an accurate IDCT and is read as 0 by a fast one.
   */
  void quantise(const std::vector<float> &mm, std::vector<uint8_t> &grey) const {
    const float fullScaleMm = keyRangeM_ * 1000.0f;
    grey.resize((size_t)CW * CH);
    for (size_t i = 0; i < grey.size(); i++) {
      const float v = mm[i];
      if (!(v > 0.0f) || !std::isfinite(v) || v > fullScaleMm) { grey[i] = 0; continue; }
      long level = std::lround((double)KEY_DEPTH_LEVELS * (double)v / (double)fullScaleMm);
      if (level < 1) level = 1;
      if (level > (long)KEY_DEPTH_LEVELS) level = (long)KEY_DEPTH_LEVELS;
      grey[i] = (uint8_t)level;
    }
  }

  const int quality_;
  std::thread thread_;
  std::mutex m_;
  std::condition_variable cv_;
  struct Colour {
    std::vector<uint8_t> pixels;
    uint64_t ts;
    int format;
  };
  std::shared_ptr<Colour> latestColour_, pendingColour_;
  bool pendingColourIsNew_ = false;
  std::vector<float> depth_;
  uint64_t depthTs_ = 0;
  bool stop_ = false;
  float keyFx_ = 0.0f, keyFy_ = 0.0f, keyCx_ = 0.0f, keyCy_ = 0.0f, keyRangeM_ = 0.0f;
  std::atomic<bool> enabled_{false};
  std::atomic<uint64_t> sent_{0};
  std::atomic<uint64_t> encodeUs_{0};
  std::atomic<uint64_t> dropped_{0};
  std::atomic<bool> keyEnabled_{false};
  std::atomic<uint64_t> keySent_{0};
  std::atomic<uint64_t> keyEncodeUs_{0};
  std::atomic<uint64_t> keyDropped_{0};
};

// Low light on lets the sensor lengthen integration until the image is exposed, which drops
// the colour camera to 15fps. Off pins the exposure to one mains-flicker period so colour
// holds 30fps. Depth never changes either way.
static void applyLowLight(libfreenect2::Freenect2Device *dev, bool on) {
  if (on) dev->setColorAutoExposure(0.0f);
  else dev->setColorSemiAutoExposure(16.667f);
  std::fprintf(stderr, "[grabber] low light %s\n", on ? "on" : "off");
}

// Commands arrive newline terminated on stdin so the server can retune a running grabber.
// Restarting instead would cost a multi-second blackout: closing the device on macOS sleeps
// 4s inside libfreenect2.
static void pollCommands(libfreenect2::Freenect2Device *dev, std::string &pending, bool wantColor,
                         HdEncoder *hd) {
  char buf[256];
  ssize_t n;
  while ((n = ::read(STDIN_FILENO, buf, sizeof(buf))) > 0) pending.append(buf, (size_t)n);

  size_t nl;
  while ((nl = pending.find('\n')) != std::string::npos) {
    std::string line = pending.substr(0, nl);
    pending.erase(0, nl + 1);
    if (!line.empty() && line.back() == '\r') line.pop_back();

    if (line == "low-light on" || line == "low-light off") {
      if (wantColor) applyLowLight(dev, line == "low-light on");
    } else if (line == "hd-color on" || line == "hd-color off") {
      // Asked for rather than always on: a 1080p JPEG is roughly 215KB and another ~50Mbit/s
      // down a pipe whose backpressure reaches this process and makes it miss USB deadlines.
      const bool on = line == "hd-color on";
      if (!wantColor && on) {
        std::fprintf(stderr, "[grabber] refusing hd colour: this grabber was started with --no-color\n");
      } else if (hd) {
        hd->setEnabled(on);
        std::fprintf(stderr, "[grabber] hd colour %s\n", on ? "on" : "off");
      }
    } else if (line == "key on" || line == "key off") {
      // A key is the depth mapped into the colour camera's frame, so it needs that camera.
      const bool on = line == "key on";
      if (!wantColor && on) {
        std::fprintf(stderr, "[grabber] refusing key: this grabber was started with --no-color\n");
      } else if (hd) {
        hd->setKeyEnabled(on);
        std::fprintf(stderr, "[grabber] key %s\n", on ? "on" : "off");
      }
    } else if (!line.empty()) {
      std::fprintf(stderr, "[grabber] unknown command: %s\n", line.c_str());
    }
  }
}

/**
 * Reads a flag given in metres, or refuses it.
 *
 * `std::strtof` with the end pointer checked, because `std::atof` stops at the first
 * character it cannot read and keeps what it had: `--max-depth 4,5` typed on a comma-decimal
 * keyboard clips at 4.0m, the hello reports 4.000, and half a room is missing from a file
 * that cannot be shot again. `nan` and `inf` parse cleanly through `strtof` and would reach
 * libfreenect2 as a clip plane, so they are refused too, along with zero and negatives.
 *
 * A large finite value is deliberately not refused - the u16 millimetre conversion already
 * floors anything past 65.535m to "no reading". Note `" 4.5"` is accepted and `"4.5 "` is
 * not, because `strtof` consumes leading whitespace itself.
 */
static bool read_metres(const char *text, float *out) {
  if (!text || !*text) return false;
  char *end = nullptr;
  errno = 0;
  const float v = std::strtof(text, &end);
  if (end == text || *end != '\0') return false;
  if (errno == ERANGE) return false;
  if (!std::isfinite(v)) return false;
  if (v <= 0.0f) return false;
  *out = v;
  return true;
}

int main(int argc, char **argv) {
  int jpegQuality = 80;
  bool wantColor = true;
  // No libfreenect2 build has every processor: the macOS one has OpenCL and no OpenGL, the
  // Pi's V3D has OpenGL and no OpenCL. Asking for one not compiled in is an error rather than
  // a silent fall-through.
#if defined(LIBFREENECT2_WITH_OPENCL_SUPPORT)
  std::string pipelineName = "cl";
#elif defined(LIBFREENECT2_WITH_OPENGL_SUPPORT)
  std::string pipelineName = "gl";
#else
  std::string pipelineName = "cpu";
#endif
  std::string logLevel = "warning";
  bool profile = false;
  // libfreenect2 clips depth on the GPU before we ever see it, and its 0.5-4.5 defaults are
  // Microsoft's published range rather than the sensor's limit - readings stay coherent down
  // to 38mm. Deliberately wider than what looks good: gating here destroys data the viewer
  // can never get back, while the viewer's own near/far merely hides it.
  float minDepth = 0.05f;
  float maxDepth = 9.0f;
  bool lowLight = true;

  // Corpus dumping exists so the registration harness can run without a sensor. It writes the
  // *inputs* to Registration::apply, because a corpus of outputs could only ever agree with
  // the build that produced it.
  std::string dumpCorpus;
  int dumpCount = 24;
  int dumpEvery = 10;

  // The text each numeric flag was given, kept so a refusal can quote it: `std::atoi` answers
  // 0 for anything it cannot read, and reporting the parsed int sends the operator looking
  // for a '0' they never wrote.
  const char *qualityRaw = nullptr, *dumpCountRaw = nullptr, *dumpEveryRaw = nullptr;
  // The depth pair keeps only its text and is parsed below, unlike the three ints above:
  // `read_metres` refuses on what the parse saw - characters left over at the end of the
  // token - and that evidence is gone once a float has been stored.
  const char *minDepthRaw = nullptr, *maxDepthRaw = nullptr;

  for (int i = 1; i < argc; i++) {
    std::string a = argv[i];
    if (a == "--no-color") wantColor = false;
    else if (a == "--pipeline" && i + 1 < argc) pipelineName = argv[++i];
    else if (a == "--quality" && i + 1 < argc) jpegQuality = std::atoi(qualityRaw = argv[++i]);
    else if (a == "--log" && i + 1 < argc) logLevel = argv[++i];
    else if (a == "--min-depth" && i + 1 < argc) minDepthRaw = argv[++i];
    else if (a == "--max-depth" && i + 1 < argc) maxDepthRaw = argv[++i];
    else if (a == "--no-low-light") lowLight = false;
    else if (a == "--profile") profile = true;
    else if (a == "--dump-corpus" && i + 1 < argc) dumpCorpus = argv[++i];
    else if (a == "--dump-count" && i + 1 < argc) dumpCount = std::atoi(dumpCountRaw = argv[++i]);
    else if (a == "--dump-every" && i + 1 < argc) dumpEvery = std::atoi(dumpEveryRaw = argv[++i]);
    else if (a == "--help") {
      std::fprintf(stderr,
        "usage: grabber [--pipeline gl|cl|cpu] [--no-color] [--quality 1-100]\n"
        "               [--log none|error|warning|info|debug] [--profile]\n"
        "               [--min-depth m] [--max-depth m] [--no-low-light]\n"
        "\n"
        "  --pipeline picks the depth processor. Only the ones this libfreenect2\n"
        "  was built with are available: this build offers"
#ifdef LIBFREENECT2_WITH_OPENGL_SUPPORT
        " gl"
#endif
#ifdef LIBFREENECT2_WITH_OPENCL_SUPPORT
        " cl"
#endif
        " cpu, and defaults to %s.\n"
        "\n"
        "  --log debug surfaces libfreenect2's per-packet USB diagnostics,\n"
        "  including 'not all subsequences received' - the dropped-isochronous-\n"
        "  packet counter you want when tuning LIBFREENECT2_IR_TRANSFERS.\n"
        "\n"
        "  --profile times the serial half of the frame loop - registration,\n"
        "  depth conversion, JPEG encode, payload assembly and the write - plus\n"
        "  the time spent blocked waiting for the next depth frame, which is the\n"
        "  headroom left over. One CSV row per frame, all of them written to\n"
        "  stderr at exit so the reporting stays out of the loop being measured.\n"
        "  hd_copy_us is the webcam's share and key_copy_us the key's: both\n"
        "  encodes run on another thread and are summarised separately, so what\n"
        "  lands on the loop is the copy that hands each frame over, nothing else.\n"
        "\n"
        "  On stdin, one command per line: 'low-light on|off', 'hd-color on|off'\n"
        "  and 'key on|off'. The second starts and stops the type 3 colour stream\n"
        "  the webcam output reads; the third starts and stops the type 4 key, the\n"
        "  depth mapped into that same 1920x1080 frame, and turns the colour stream\n"
        "  on with it because a key without its picture mattes nothing. Both are\n"
        "  off until asked, because a 1080p JPEG is roughly 215KB a frame of pipe\n"
        "  nobody is reading.\n"
        "\n"
        "  --min-depth/--max-depth clip on the GPU before the frame is built, so\n"
        "  they decide what exists at all - the viewer's own clip only hides what\n"
        "  these let through. Defaults are 0.05 and 9.0, wider than\n"
        "  libfreenect2's own 0.5 and 4.5.\n"
        "\n"
        "  --no-low-light caps the colour exposure to one flicker period, which\n"
        "  holds the colour camera at 30fps in a dim room at the cost of a darker\n"
        "  image. Left on, the camera lengthens its exposure and falls to 15fps.\n"
        "  Depth is unaffected either way - the two streams are decoupled.\n"
        "\n"
        "  --dump-corpus writes the inputs to Registration::apply into a\n"
        "  directory - one raw file per frame plus the calibration - so the\n"
        "  differential harness can run with no sensor attached. Frames are\n"
        "  sampled every --dump-every (default 10) so a corpus spans real scene\n"
        "  motion rather than a burst of near-identical images, and the grabber\n"
        "  exits after --dump-count (default 24) of them.\n"
        "\n"
        "stdin commands, newline terminated, applied live:\n"
        "  low-light on|off\n"
        "  hd-color on|off\n"
        "  key on|off\n",
        pipelineName.c_str());
      return 0;
    }
    // Nothing falls through this loop. A misspelling, a value eaten by a shell, or a flag left
    // last on the line used to miss every arm and run an ordinary session on defaults - which
    // for the clip flags means footage recorded without the range the operator typed.
    else {
      std::fprintf(stderr, "[grabber] unknown argument or missing value: '%s' - see --help\n", a.c_str());
      return 2;
    }
  }

  // Checked here rather than where they are parsed, because a later argument overwrites an
  // earlier one and the only value worth judging is the one that survives the loop. All three
  // arrive through `std::atoi`, which reports "not a number" as 0: `--dump-every 0` makes the
  // sampling test a division by zero, which is SIGFPE and reads to the server as a grabber
  // dying the instant it is spawned. Exit 2 rather than 1, because nothing was attempted.
  if (jpegQuality < 1 || jpegQuality > 100) {
    std::fprintf(stderr, "[grabber] --quality must be an integer 1-100, got '%s'\n", qualityRaw ? qualityRaw : "");
    return 2;
  }
  if (dumpEvery < 1) {
    std::fprintf(stderr, "[grabber] --dump-every must be an integer 1 or greater, got '%s'\n", dumpEveryRaw ? dumpEveryRaw : "");
    return 2;
  }
  if (dumpCount < 1) {
    std::fprintf(stderr, "[grabber] --dump-count must be an integer 1 or greater, got '%s'\n", dumpCountRaw ? dumpCountRaw : "");
    return 2;
  }

  // The two flags that decide what exists at all. The three above are recoverable mistakes;
  // these clip on the GPU before a frame is assembled, so what a typo here removes is not in
  // the file and cannot be put back - and the hello reports whatever was parsed at `%.3f`.
  if (minDepthRaw && !read_metres(minDepthRaw, &minDepth)) {
    std::fprintf(stderr, "[grabber] --min-depth must be a positive finite number of metres, got '%s'\n", minDepthRaw);
    return 2;
  }
  if (maxDepthRaw && !read_metres(maxDepthRaw, &maxDepth)) {
    std::fprintf(stderr, "[grabber] --max-depth must be a positive finite number of metres, got '%s'\n", maxDepthRaw);
    return 2;
  }
  // Asked of the pair unconditionally, because it is a property of the two values that
  // survived the loop rather than of the arguments that set them. Swapped, the range is empty
  // and every frame is a grid of zeroes delivered at a perfectly healthy 30fps.
  if (!(minDepth < maxDepth)) {
    std::fprintf(stderr, "[grabber] --min-depth %.3f must be less than --max-depth %.3f - "
                 "a range that is empty or inverted clips every point away\n", minDepth, maxDepth);
    return 2;
  }

  // Debug is genuinely noisy - one line per incomplete depth frame - so it stays opt-in.
  libfreenect2::Logger::Level level = libfreenect2::Logger::Warning;
  if (logLevel == "none") level = libfreenect2::Logger::None;
  else if (logLevel == "error") level = libfreenect2::Logger::Error;
  else if (logLevel == "info") level = libfreenect2::Logger::Info;
  else if (logLevel == "debug") level = libfreenect2::Logger::Debug;
  libfreenect2::setGlobalLogger(new StderrLogger(level));

  std::signal(SIGINT, on_signal);
  std::signal(SIGTERM, on_signal);
  std::signal(SIGPIPE, SIG_IGN); // parent going away must not kill us mid-write

  libfreenect2::Freenect2 freenect2;
  if (freenect2.enumerateDevices() == 0) {
    std::fprintf(stderr, "[grabber] no Kinect v2 found\n");
    return 1;
  }
  std::string serial = freenect2.getDefaultDeviceSerialNumber();

  libfreenect2::PacketPipeline *pipeline = nullptr;
  if (pipelineName == "cpu") {
    pipeline = new libfreenect2::CpuPacketPipeline();
  } else if (pipelineName == "gl") {
#ifdef LIBFREENECT2_WITH_OPENGL_SUPPORT
    // The GL processor opens its own window, so a Wayland or X session has to be reachable.
    pipeline = new libfreenect2::OpenGLPacketPipeline();
#else
    std::fprintf(stderr, "[grabber] this libfreenect2 was built without OpenGL support\n");
    return 1;
#endif
  } else if (pipelineName == "cl") {
#ifdef LIBFREENECT2_WITH_OPENCL_SUPPORT
    pipeline = new libfreenect2::OpenCLPacketPipeline();
#else
    std::fprintf(stderr, "[grabber] this libfreenect2 was built without OpenCL support\n");
    return 1;
#endif
  } else {
    std::fprintf(stderr, "[grabber] unknown pipeline '%s' (want gl, cl or cpu)\n", pipelineName.c_str());
    return 1;
  }

  libfreenect2::Freenect2Device *dev = freenect2.openDevice(serial, pipeline);
  if (!dev) {
    std::fprintf(stderr, "[grabber] failed to open device %s\n", serial.c_str());
    return 1;
  }

  // Depth and colour are listened to separately: a single SyncMultiFrameListener releases a
  // frame set only once both streams have delivered, and the colour camera halves to 15fps in
  // dim light while depth stays at 30, so syncing them throws away every other depth frame.
  libfreenect2::SyncMultiFrameListener depthListener(libfreenect2::Frame::Depth);
  libfreenect2::SyncMultiFrameListener colorListener(libfreenect2::Frame::Color);
  dev->setIrAndDepthFrameListener(&depthListener);
  if (wantColor) dev->setColorFrameListener(&colorListener);

  libfreenect2::Freenect2Device::Config config;
  config.MinDepth = minDepth;
  config.MaxDepth = maxDepth;
  dev->setConfiguration(config);

  if (wantColor) {
    if (!dev->start()) { std::fprintf(stderr, "[grabber] device start failed\n"); return 1; }
  } else {
    if (!dev->startStreams(false, true)) { std::fprintf(stderr, "[grabber] device start failed\n"); return 1; }
  }

  if (wantColor) applyLowLight(dev, lowLight);

  // Non-blocking so the capture loop never stalls waiting on a command that may never come.
  ::fcntl(STDIN_FILENO, F_SETFL, O_NONBLOCK);
  std::string pendingCommands;

  libfreenect2::Freenect2Device::IrCameraParams ir = dev->getIrCameraParams();
  libfreenect2::Freenect2Device::ColorCameraParams cp = dev->getColorCameraParams();
  libfreenect2::Registration registration(ir, cp);
  libfreenect2::Frame undistorted(DW, DH, 4), registered(DW, DH, 4);

  // 1920x1082, not 1080. apply() sizes its filter map as 1920*1080 + 1920*1*2 and the scatter
  // writes into the row above and below the image with no bounds check, so a 1080-row buffer
  // is two rows short and it writes past the end.
  libfreenect2::Frame bigdepth(1920, 1082, 4);
  std::vector<int> colorDepthMap(DEPTH_PIXELS);

  if (!dumpCorpus.empty()) {
    if (::mkdir(dumpCorpus.c_str(), 0755) != 0 && errno != EEXIST) {
      std::fprintf(stderr, "[grabber] cannot create %s: %s\n",
                   dumpCorpus.c_str(), std::strerror(errno));
      return 1;
    }
    // The calibration goes out as the raw structs rather than as JSON: Registration builds its
    // distortion maps from these floats, so a value shifted by one ulp through a decimal
    // round-trip would make the harness report a difference that only existed in the reader.
    const uint32_t head[4] = {CORPUS_MAGIC, CORPUS_VERSION,
                              (uint32_t)sizeof(ir), (uint32_t)sizeof(cp)};
    const void *parts[3] = {head, &ir, &cp};
    const size_t lens[3] = {sizeof(head), sizeof(ir), sizeof(cp)};
    if (!write_file(dumpCorpus + "/params.bin", parts, lens, 3)) return 1;
    std::fprintf(stderr, "[grabber] corpus into %s: %d frames, every %d\n",
                 dumpCorpus.c_str(), dumpCount, dumpEvery);
  }

  // The browser needs the real intrinsics to unproject; hardcoded values skew the cloud.
  // `format` leads the record because it says how to read the rest of it. `startedAt` is the
  // wall clock and belongs here because every frame timestamp below is steady_clock, which is
  // right for frame spacing and useless for sorting a library.
  long long startedAt = std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()).count();
  char hello[512];
  int helloLen = std::snprintf(hello, sizeof(hello),
    "{\"format\":%u,\"serial\":\"%s\",\"firmware\":\"%s\",\"width\":%d,\"height\":%d,"
    "\"fx\":%.6f,\"fy\":%.6f,\"cx\":%.6f,\"cy\":%.6f,\"color\":%s,"
    "\"minDepth\":%.3f,\"maxDepth\":%.3f,\"lowLight\":%s,\"startedAt\":%lld}",
    CAPTURE_FORMAT, serial.c_str(), dev->getFirmwareVersion().c_str(), DW, DH,
    ir.fx, ir.fy, ir.cx, ir.cy, wantColor ? "true" : "false",
    minDepth, maxDepth, (wantColor && lowLight) ? "true" : "false", startedAt);
  // snprintf truncates silently, and a truncated hello is not JSON - every take recorded
  // afterwards would carry a sensor record nothing can parse. The serial and the firmware are
  // device strings, so the length is not something this file can reason about once.
  if (helloLen < 0 || (size_t)helloLen >= sizeof(hello)) {
    std::fprintf(stderr, "[grabber] hello needs %d bytes and the buffer is %zu: refusing to "
                 "stream a sensor record that would be cut in half\n", helloLen, sizeof(hello));
    return 1;
  }
  if (!write_message(STDOUT_FILENO, TYPE_HELLO, hello, (uint32_t)helloLen)) return 1;
  std::fprintf(stderr, "[grabber] streaming %s (fx=%.2f fy=%.2f cx=%.2f cy=%.2f)\n",
               serial.c_str(), ir.fx, ir.fy, ir.cx, ir.cy);

  tjhandle jpegCompressor = wantColor ? tjInitCompress() : nullptr;
  unsigned char *jpegBuf = nullptr;
  unsigned long jpegSize = 0;

  // Started with the stream rather than on the first request: a thread parked on a condition
  // variable costs nothing, and starting one on demand puts its startup inside the latency of
  // the first webcam frame.
  HdEncoder hdEncoder(jpegQuality);
  // The key is in the colour camera's frame, so it carries that camera's intrinsics rather
  // than the depth camera's the hello reports. Set before the thread exists.
  hdEncoder.setKeyHeader(cp.fx, cp.fy, cp.cx, cp.cy, maxDepth);
  if (wantColor) hdEncoder.start();

  std::vector<uint8_t> depthOut(DEPTH_PIXELS * sizeof(uint16_t));
  std::vector<uint8_t> payload;

  libfreenect2::FrameMap depthFrames, colorFrames;
  bool haveColor = false;
  // Said once rather than per frame: a decoder producing something the webcam cannot encode
  // does it thirty times a second, and a log that repeats at frame rate is a log nobody reads.
  bool hdFormatWarned = false;
  uint64_t frameCount = 0;
  uint64_t colorCount = 0;
  // Counted rather than only dropped: a drop that leaves no trace is indistinguishable from a
  // frame that never arrived, and the two want opposite answers - one is a machine that cannot
  // keep up with its GPU, the other is a USB link.
  uint64_t badDepth = 0;
  uint64_t badColor = 0;
  int dumped = 0;

  // Records are buffered and dumped at exit rather than printed per frame, so the profiling
  // I/O cannot land inside the loop it is measuring.
  struct ProfRecord {
    uint64_t arrival;
    uint32_t newColor, wait, acq, reg, conv, enc, asm_, write, jpegBytes, hdCopy, keyCopy;
  };
  std::vector<ProfRecord> prof;
  if (profile) prof.reserve(1 << 17); // ~an hour at 30fps, so no realloc mid-loop

  while (!g_stop) {
    uint64_t tWaitStart = now_us();
    if (!depthListener.waitForNewFrame(depthFrames, 10 * 1000)) {
      std::fprintf(stderr, "[grabber] timeout waiting for frame\n");
      break;
    }
    uint64_t tArrived = now_us();

    pollCommands(dev, pendingCommands, wantColor, &hdEncoder);

    // Take a new colour frame only if one is already waiting; never block on it. The previous
    // one is released first, so at most one is held outside the pool.
    bool newColor = false;
    if (wantColor && colorListener.hasNewFrame()) {
      if (haveColor) colorListener.release(colorFrames);
      haveColor = colorListener.waitForNewFrame(colorFrames, 1000);
      // `status` is libfreenect2 saying this frame's own decode failed, and it hands the frame
      // over regardless. Dropped back to no colour rather than reused - the previous good one
      // was already released a line above, and an untextured cloud is better than a torn one.
      if (haveColor && colorFrames[libfreenect2::Frame::Color]->status != 0) {
        badColor++;
        colorListener.release(colorFrames);
        haveColor = false;
      } else if (haveColor) { colorCount++; newColor = true; }
    }

    libfreenect2::Frame *depth = depthFrames[libfreenect2::Frame::Depth];
    libfreenect2::Frame *rgb = haveColor ? colorFrames[libfreenect2::Frame::Color] : nullptr;

    // Depth keeps its own time when low light reuses an older colour frame.
    const uint64_t iterTs = now_ms();

    // Copy only new colour frames, including when the depth readback below fails.
    const bool hdColourValid = rgb && rgb->data && rgb->status == 0
      && (int)rgb->width == CW && (int)rgb->height == CH && rgb->bytes_per_pixel == 4
      && (rgb->format == libfreenect2::Frame::BGRX || rgb->format == libfreenect2::Frame::RGBX);
    if (!hdColourValid) hdEncoder.submitColour(nullptr, 0, iterTs);
    uint64_t tHdStart = now_us();
    uint64_t tHdDone = tHdStart;
    if (newColor && rgb && (hdEncoder.enabled() || hdEncoder.keyEnabled())) {
      if (!hdColourValid) {
        if (!hdFormatWarned) {
          std::fprintf(stderr, "[grabber] hd colour and key off: unsupported colour frame "
                       "(%dx%d, %d bytes per pixel, format %d, status %d)\n",
                       (int)rgb->width, (int)rgb->height, (int)rgb->bytes_per_pixel,
                       (int)rgb->format, (int)rgb->status);
          hdFormatWarned = true;
        }
      } else {
        hdEncoder.submitColour((const uint8_t *)rgb->data, (size_t)CW * CH * 4, iterTs,
          rgb->format == libfreenect2::Frame::RGBX ? TJPF_RGBX : TJPF_BGRX);
      }
      tHdDone = now_us();
    }

    // The same refusal on the half of the frame that cannot be re-derived. The OpenCL processor
    // sets `status = 1` when the readback off the device fails and still delivers the frame,
    // buffer holding whatever was in it - taken as ordinary depth it is written into a take
    // that cannot be shot again while delivered fps stays at a flawless 30.0. `frameCount`
    // deliberately does not advance, so a run losing frames reads as a rate below 30, and the
    // count reports on its own cadence because the healthy log below is gated on that counter.
    if (depth->status != 0) {
      badDepth++;
      if (badDepth % 150 == 0)
        std::fprintf(stderr, "[grabber] depth readback failing: %llu bad frames against %llu delivered\n",
                     (unsigned long long)badDepth, (unsigned long long)frameCount);
      depthListener.release(depthFrames);
      continue;
    }
    uint64_t tAcquired = now_us();

    // Dumped before apply() rather than after, because these two frames are the harness's input
    // and apply() writes into buffers it also reads maps from. Only frames carrying colour are
    // usable: apply() refuses a null rgb.
    if (!dumpCorpus.empty() && rgb && frameCount % (uint64_t)dumpEvery == 0) {
      char path[1024];
      std::snprintf(path, sizeof(path), "%s/frame-%04d.bin", dumpCorpus.c_str(), dumped);
      const uint32_t head[8] = {
        CORPUS_MAGIC, CORPUS_VERSION,
        (uint32_t)depth->width, (uint32_t)depth->height,
        (uint32_t)rgb->width, (uint32_t)rgb->height,
        (uint32_t)rgb->format, (uint32_t)rgb->bytes_per_pixel};
      const void *parts[3] = {head, depth->data, rgb->data};
      const size_t lens[3] = {sizeof(head),
                              (size_t)depth->width * depth->height * depth->bytes_per_pixel,
                              (size_t)rgb->width * rgb->height * rgb->bytes_per_pixel};
      if (!write_file(path, parts, lens, 3)) return 1;
      if (++dumped >= dumpCount) {
        std::fprintf(stderr, "[grabber] corpus complete: %d frames\n", dumped);
        g_stop = 1;
      }
    }

    const float *depthSrc;
    // Zero unless the key copy below runs, so the subtraction out of `reg` is a no-op on the
    // frames that skip it rather than an underflow.
    uint64_t tKeyStart = 0, tKeyDone = 0;
    if (rgb) {
      // The scratch buffers are passed in rather than left to apply(), which otherwise
      // new/deletes an 8.3MB filter map and an 868KB offset map on every frame.
      registration.apply(rgb, depth, &undistorted, &registered, true, &bigdepth, colorDepthMap.data());
      // apply() returns having touched nothing unless the colour frame is exactly 1920x1080x4,
      // so a key taken past that check would carry the previous frame's depth as this one's.
      if (hdEncoder.keyEnabled() && hdColourValid) {
        tKeyStart = now_us();
        // Past the scatter guard row - see the bigdepth declaration for why there is one.
        hdEncoder.submitDepth((const float *)bigdepth.data + CW, (size_t)CW * CH, iterTs);
        tKeyDone = now_us();
      }
      depthSrc = (const float *)undistorted.data;
    } else {
      // Same undistortion the colour path applies, so geometry does not shift between the
      // frames before the first colour arrives and the ones after.
      registration.undistortDepth(depth, &undistorted);
      depthSrc = (const float *)undistorted.data;
    }
    uint64_t tRegistered = now_us();

    uint16_t *d16 = (uint16_t *)depthOut.data();
    for (size_t i = 0; i < DEPTH_PIXELS; i++) {
      float mm = depthSrc[i];
      d16[i] = (mm > 0.0f && mm < 65535.0f) ? (uint16_t)mm : 0;
    }
    uint64_t tConverted = now_us();

    // `jpegSize` is an input as well as an output: TurboJPEG reuses the buffer it allocated on
    // the previous call and reads `jpegSize` as that buffer's capacity, so zeroing it claims a
    // zero-length buffer and the encode runs off the end - libjpeg-turbo 2.1.5 on Debian
    // aarch64 corrupts the heap and dies inside tjCompress2 within a few frames. Because it
    // survives the call, a failed encode would ship the previous frame's bytes as fresh ones.
    uint32_t colorBytes = 0;
    if (rgb) {
      if (tjCompress2(jpegCompressor, (unsigned char *)registered.data, DW, 0, DH,
                      TJPF_BGRX, &jpegBuf, &jpegSize, TJSAMP_420, jpegQuality, TJFLAG_FASTDCT) == 0)
        colorBytes = (uint32_t)jpegSize;
      else
        std::fprintf(stderr, "[grabber] jpeg encode failed: %s\n", tjGetErrorStr());
    }
    uint64_t tEncoded = now_us();

    uint32_t depthBytes = (uint32_t)depthOut.size();
    uint64_t ts = now_ms();

    payload.resize(4 + 4 + 8 + depthBytes + colorBytes);
    uint8_t *p = payload.data();
    std::memcpy(p, &depthBytes, 4); p += 4;
    std::memcpy(p, &colorBytes, 4); p += 4;
    std::memcpy(p, &ts, 8);         p += 8;
    std::memcpy(p, depthOut.data(), depthBytes); p += depthBytes;
    if (colorBytes) std::memcpy(p, jpegBuf, colorBytes);
    uint64_t tAssembled = now_us();

    bool ok = write_message(STDOUT_FILENO, TYPE_FRAME, payload.data(), (uint32_t)payload.size());
    uint64_t tWritten = now_us();
    depthListener.release(depthFrames);

    if (profile) {
      ProfRecord r;
      r.arrival   = tArrived; // absolute, so delivered rate over any window is exact
      r.newColor  = newColor ? 1 : 0;
      r.wait      = (uint32_t)(tArrived - tWaitStart);
      // The webcam's copy happens inside the acquisition span, so it is subtracted back out
      // rather than left to inflate `acq` and be attributed to the wrong stage.
      r.acq       = (uint32_t)((tAcquired - tArrived) - (tHdDone - tHdStart));
      r.hdCopy    = (uint32_t)(tHdDone - tHdStart);
      // The key's copy happens inside the registration span, subtracted back out for the
      // same reason `acq` sheds the webcam's.
      r.reg       = (uint32_t)((tRegistered - tAcquired) - (tKeyDone - tKeyStart));
      r.keyCopy   = (uint32_t)(tKeyDone - tKeyStart);
      r.conv      = (uint32_t)(tConverted - tRegistered);
      r.enc       = (uint32_t)(tEncoded - tConverted);
      r.asm_      = (uint32_t)(tAssembled - tEncoded);
      r.write     = (uint32_t)(tWritten - tAssembled);
      r.jpegBytes = colorBytes;
      prof.push_back(r);
    }

    if (!ok) break; // consumer closed the pipe

    if (++frameCount % 150 == 0)
      std::fprintf(stderr, "[grabber] %llu frames (%llu colour, %llu bad depth, %llu bad colour)\n",
                   (unsigned long long)frameCount, (unsigned long long)colorCount,
                   (unsigned long long)badDepth, (unsigned long long)badColor);
  }

  // Stopped before the listener releases its frame and before the counters below are read, so
  // the thread is quiescent rather than mid-encode when either happens.
  hdEncoder.stop();
  if (haveColor) colorListener.release(colorFrames);

  if (profile) {
    std::fprintf(stderr, "[prof] n,arrival_us,newColor,wait_us,acq_us,reg_us,conv_us,enc_us,asm_us,write_us,jpeg_bytes,hd_copy_us,key_copy_us\n");
    for (size_t i = 0; i < prof.size(); i++) {
      const ProfRecord &r = prof[i];
      std::fprintf(stderr, "[prof] %zu,%llu,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u\n",
                   i, (unsigned long long)r.arrival,
                   r.newColor, r.wait, r.acq, r.reg, r.conv, r.enc, r.asm_, r.write, r.jpegBytes,
                   r.hdCopy, r.keyCopy);
    }
    std::fflush(stderr);
  }

  // Each mean is guarded on its own slot: a run that carried colour and no key would
  // otherwise divide by zero and report the key's cost as nan.
  if (wantColor && (hdEncoder.sent() > 0 || hdEncoder.keySent() > 0)) {
    std::fprintf(stderr, "[grabber] hd colour: %llu sent, %llu dropped busy, %.2f ms mean encode; "
                 "key depth: %llu sent, %llu dropped busy, %.2f ms mean quantise+encode\n",
                 (unsigned long long)hdEncoder.sent(), (unsigned long long)hdEncoder.dropped(),
                 hdEncoder.sent() ? (double)hdEncoder.encodeUs() / (double)hdEncoder.sent() / 1000.0 : 0.0,
                 (unsigned long long)hdEncoder.keySent(), (unsigned long long)hdEncoder.keyDropped(),
                 hdEncoder.keySent() ? (double)hdEncoder.keyEncodeUs() / (double)hdEncoder.keySent() / 1000.0 : 0.0);
  }

  if (jpegBuf) tjFree(jpegBuf);
  if (jpegCompressor) tjDestroy(jpegCompressor);
  dev->stop();
  dev->close();
  std::fprintf(stderr, "[grabber] stopped after %llu frames (%llu bad depth, %llu bad colour)\n",
               (unsigned long long)frameCount, (unsigned long long)badDepth, (unsigned long long)badColor);
  return 0;
}
