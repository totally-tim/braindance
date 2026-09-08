#include <cstdio>
#include <cstdint>
#include <cstring>
#include <cmath>
#include <vector>
#include <thread>
#include <atomic>
#include <mutex>
#include <condition_variable>
#include <chrono>
#include <memory>
#include <unistd.h>
#include <turbojpeg.h>

struct Message { uint32_t type; std::vector<uint8_t> payload; };
std::mutex gate;
std::condition_variable wake;
std::vector<Message> messages;
bool blockFirst = false, blocked = false, released = false;
int checked = 0, failed = 0;
static uint64_t stamp(const std::vector<uint8_t> &p, size_t at = 0) {
  uint64_t value; std::memcpy(&value, p.data() + at, 8); return value;
}
static uint64_t now_us() {
  return std::chrono::duration_cast<std::chrono::microseconds>(
    std::chrono::steady_clock::now().time_since_epoch()).count();
}
static bool write_message(int, uint32_t type, const void *data, uint32_t size) {
  std::unique_lock<std::mutex> lock(gate);
  if (blockFirst && type == 3 && !blocked) {
    blocked = true; wake.notify_all();
    if (!wake.wait_for(lock, std::chrono::seconds(5), [] { return released; })) std::exit(2);
  }
  const uint8_t *bytes = static_cast<const uint8_t *>(data);
  messages.push_back({type, std::vector<uint8_t>(bytes, bytes + size)});
  wake.notify_all();
  return true;
}

#include "encoder-under-test.h"

static void check(bool pass, const char *name) {
  checked++; if (!pass) failed++;
  std::printf("  %s %s\n", pass ? "PASS" : "FAIL", name);
}
static void clearMessages(bool block = false) {
  messages.clear(); blockFirst = block; blocked = released = false;
}
static bool waitMessages(uint32_t type, uint64_t ts) {
  std::unique_lock<std::mutex> lock(gate);
  return wake.wait_for(lock, std::chrono::seconds(5), [=] {
    for (const auto &m : messages) if (m.type == type && stamp(m.payload) == ts) return true;
    return false;
  });
}
static std::vector<uint8_t> colour(int r, int g, int b, bool rgbx = false) {
  std::vector<uint8_t> out((size_t)CW * CH * 4);
  for (size_t i = 0; i < out.size(); i += 4) {
    out[i] = rgbx ? r : b; out[i+1] = g; out[i+2] = rgbx ? b : r;
  }
  return out;
}
static std::vector<uint8_t> decode(const Message &m, int header, int format) {
  tjhandle decoder = tjInitDecompress();
  std::vector<uint8_t> out((size_t)CW * CH * tjPixelSize[format]);
  const int result = tjDecompress2(decoder, m.payload.data() + header, m.payload.size() - header,
    out.data(), CW, 0, CH, format, 0);
  tjDestroy(decoder);
  if (result != 0) { std::fprintf(stderr, "JPEG decode failed\n"); std::exit(2); }
  return out;
}
static std::vector<Message> keys() {
  std::vector<Message> out;
  for (const auto &m : messages) if (m.type == TYPE_KEY) out.push_back(m);
  return out;
}
static void checkPairs(const char *name) {
  const Message *held = nullptr;
  bool identities = true, pixels = true;
  int pairs = 0;
  for (const auto &m : messages) {
    if (m.type == TYPE_COLOR) held = &m;
    if (m.type != TYPE_KEY) continue;
    pairs++;
    const uint64_t depthTs = stamp(m.payload), colourTs = stamp(m.payload, 8);
    identities = identities && held && stamp(held->payload) == colourTs && colourTs == depthTs;
    if (!held) { pixels = false; continue; }
    const auto rgb = decode(*held, 8, TJPF_RGB);
    const auto grey = decode(m, KEY_HEADER_BYTES, TJPF_GRAY);
    // Frame 1 is red at 1m; frame 2 is green at 2m. Changing stamps cannot fake these pixels.
    const bool first = depthTs == 1;
    pixels = pixels && std::abs((int)rgb[0] - (first ? 220 : 20)) < 5
      && std::abs((int)rgb[1] - (first ? 20 : 220)) < 5
      && std::abs((int)grey[0] - (first ? 28 : 57)) <= 1;
    std::printf("  pair depth=%llu colour=%llu latest=%llu RGB=%d,%d,%d depth-level=%d\n",
      (unsigned long long)depthTs, (unsigned long long)colourTs,
      (unsigned long long)stamp(held->payload), rgb[0], rgb[1], rgb[2], grey[0]);
  }
  check(pairs > 0 && identities, name);
  check(pairs > 0 && pixels, "the decoded colour and depth carry the same planted frame, even if stamps lie");
}

int main() {
  std::vector<float> depth((size_t)CW * CH, 1000);
  auto red = colour(220, 20, 10), green = colour(20, 220, 10);
  clearMessages(true);
  {
    HdEncoder encoder(80); encoder.setKeyHeader(1000, 1000, 960, 540, 9);
    encoder.submitColour(red.data(), red.size(), 1);
    encoder.submitDepth(depth.data(), depth.size(), 1);
    encoder.start();
    {
      std::unique_lock<std::mutex> lock(gate);
      if (!wake.wait_for(lock, std::chrono::seconds(5), [] { return blocked; })) return 2;
    }
    encoder.submitDepth(depth.data(), depth.size(), 1);
    encoder.submitColour(green.data(), green.size(), 2);
    { std::lock_guard<std::mutex> lock(gate); released = true; } wake.notify_all();
    const bool progressed = waitMessages(TYPE_COLOR, 2) && waitMessages(TYPE_KEY, 1);
    check(progressed, "a colour backlog drains without losing the in-flight depth");
    std::fill(depth.begin(), depth.end(), 2000);
    encoder.submitDepth(depth.data(), depth.size(), 2);
    check(waitMessages(TYPE_KEY, 2), "the next depth recovers after the backlog");
    encoder.stop();
    check(encoder.dropped() == 0, "replacing pending held colour does not count a colour frame as dropped");
    checkPairs("each backlog key names the colour delivered immediately before it");
  }

  clearMessages();
  {
    HdEncoder encoder(80); encoder.setKeyHeader(1000, 1000, 960, 540, 9); encoder.start();
    encoder.submitColour(red.data(), red.size(), 10);
    encoder.submitDepth(depth.data(), depth.size(), 10);
    const bool first = waitMessages(TYPE_KEY, 10);
    encoder.submitDepth(depth.data(), depth.size(), 11);
    const bool second = waitMessages(TYPE_KEY, 11);
    encoder.stop();
    const auto out = keys();
    check(first && second && out.size() == 2 && stamp(out.back().payload, 8) == 10,
      "slow colour keeps its identity while depth advances");
    check(encoder.sent() == 1, "reused colour is encoded only once");
  }

  clearMessages();
  {
    HdEncoder encoder(80); encoder.setKeyHeader(1000, 1000, 960, 540, 1000);
    const float depths[] = {1000, 2000, 4000, 0, -1, INFINITY, NAN, 70000};
    for (int y = 0; y < CH; y++) for (int x = 0; x < CW; x++) depth[(size_t)y*CW+x] = depths[x/(CW/8)];
    encoder.submitColour(red.data(), red.size(), 20);
    encoder.submitDepth(depth.data(), depth.size(), 20); encoder.start();
    check(waitMessages(TYPE_KEY, 20), "a capture maximum of 1000m still produces a key");
    encoder.stop();
    const auto out = keys();
    if (out.empty()) return 2;
    float range; std::memcpy(&range, out[0].payload.data() + KEY_HEADER_BYTES - 4, 4);
    const auto grey = decode(out[0], KEY_HEADER_BYTES, TJPF_GRAY);
    const int one = grey[CW/16], two = grey[CW/8+CW/16], four = grey[CW/4+CW/16];
    check(range <= 65.536f && one > 1 && two > one && four > two,
      "the key range is bounded and ordinary subject depths remain distinct");
    bool empty = true;
    for (int i = 3; i < 8; i++) empty = empty && grey[i*(CW/8)+CW/16] == 0;
    check(empty, "zero, negative, infinite, NaN and out-of-range depths stay empty");
    std::printf("  range=%f levels=%d,%d,%d\n", range, one, two, four);
  }

  clearMessages();
  {
    HdEncoder encoder(80); encoder.setKeyHeader(1000, 1000, 960, 540, 9);
    auto rgbx = colour(220, 40, 10, true);
    encoder.submitColour(rgbx.data(), rgbx.size(), 30, TJPF_RGBX); encoder.start();
    check(waitMessages(TYPE_COLOR, 30), "RGBX colour is accepted");
    encoder.stop();
    const auto rgb = decode(messages[0], 8, TJPF_RGB);
    check(std::abs((int)rgb[0]-220) < 5 && std::abs((int)rgb[2]-10) < 5,
      "RGBX preserves red and blue through the real JPEG encoder");
  }

  clearMessages();
  {
    HdEncoder encoder(80); encoder.setKeyHeader(1000, 1000, 960, 540, 9); encoder.start();
    encoder.submitDepth(depth.data(), depth.size(), 40);
    encoder.submitColour(red.data(), red.size()-4, 41);
    encoder.submitDepth(depth.data(), depth.size(), 41);
    encoder.submitColour(red.data(), red.size(), 42, TJPF_GRAY);
    encoder.submitDepth(depth.data(), depth.size(), 42);
    {
      std::unique_lock<std::mutex> lock(gate);
      const bool emitted = wake.wait_for(lock, std::chrono::milliseconds(100), [] { return !messages.empty(); });
      check(!emitted, "missing, malformed and unsupported colour emits neither colour nor key");
    }
    encoder.submitColour(red.data(), red.size(), 43);
    encoder.submitDepth(depth.data(), depth.size(), 43);
    check(waitMessages(TYPE_KEY, 43), "valid colour recovers after unsupported input");
    encoder.stop();
  }
  std::printf("\n[hd-encoder] %d assertions, %d failed\n", checked, failed);
  return failed ? 1 : 0;
}
