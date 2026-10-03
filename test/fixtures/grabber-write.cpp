// The shipped stdout writer under a scripted interleaving of the capture loop and the encoder
// thread, on a real non-blocking pipe that the parent leaves unread until the script says.
//
//   grabber-write <scenario> <out-file>
//
// The frame writer sends a 512 KiB message of 0x11 and stalls in it. Then:
//   free    no stop. The encoder's message of 0x22 queues behind it and both finish once the parent reads.
//   queued  the parent writes `stop` to the frame writer's stdin, as the frame loop reads it while
//           stalled, and the encoder's message arrives 50 ms later, before the frame writer gives
//           up. The parent reads again as soon as the frame writer has returned.
//   late    as queued, with the encoder's message arriving after the frame writer has returned.
// What the parent read goes to <out-file>; stdout says what each writer returned.
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fcntl.h>
#include <functional>
#include <mutex>
#include <poll.h>
#include <string>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <thread>
#include <unistd.h>
#include <vector>

static const uint32_t MAGIC = 0x4B4E4354;
static std::atomic<bool> g_stop{false};

#include "write-under-test.h"

static const size_t PAYLOAD = 512 * 1024;
static const uint32_t TYPE_FRAME = 2, TYPE_COLOR = 3;

static void sleepMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

// Bytes waiting in the pipe, unchanged for 100 ms: the frame writer is stuck in its message.
static void waitStalled(int readFd) {
  int last = -1, steady = 0;
  while (steady < 5) {
    int n = 0;
    ::ioctl(readFd, FIONREAD, &n);
    steady = (n > 0 && n == last) ? steady + 1 : 0;
    last = n;
    sleepMs(20);
  }
}

int main(int argc, char **argv) {
  if (argc != 3) return 2;
  const std::string scenario = argv[1];
  if (scenario != "free" && scenario != "queued" && scenario != "late") return 2;

  // The frame loop's stdin: a stop line is what its stalled wait reads.
  int in[2], out[2];
  if (::pipe(in) != 0 || ::pipe(out) != 0) return 2;
  ::fcntl(in[0], F_SETFL, O_NONBLOCK);
  ::dup2(in[0], STDIN_FILENO);
  ::fcntl(out[0], F_SETFL, O_NONBLOCK);
  ::fcntl(out[1], F_SETFL, O_NONBLOCK);
  const std::function<void()> readCommands = [] {
    char line[16];
    if (::read(STDIN_FILENO, line, sizeof(line)) > 0) g_stop = true;
  };

  const std::vector<uint8_t> frame(PAYLOAD, 0x11), colour(PAYLOAD, 0x22);
  std::atomic<int> frameResult{-1}, colourResult{-1};
  std::atomic<bool> colourDone{false};

  std::thread frameWriter([&] {
    frameResult = write_message(out[1], TYPE_FRAME, frame.data(), (uint32_t)frame.size(), readCommands);
  });
  waitStalled(out[0]);

  std::thread encoder;
  auto startEncoder = [&] {
    encoder = std::thread([&] {
      colourResult = write_message(out[1], TYPE_COLOR, colour.data(), (uint32_t)colour.size());
      colourDone = true;
    });
  };

  std::vector<uint8_t> read;
  auto readWhatIsThere = [&] {
    uint8_t buf[65536];
    for (ssize_t n; (n = ::read(out[0], buf, sizeof(buf))) > 0;) read.insert(read.end(), buf, buf + n);
  };
  auto drain = [&](bool untilEncoderDone) {
    for (;;) {
      readWhatIsThere();
      if (!untilEncoderDone) return;
      if (colourDone) { readWhatIsThere(); return; }
      sleepMs(1);
    }
  };

  if (scenario == "free") {
    startEncoder();
    sleepMs(250);
    drain(false);
    std::thread reader([&] { drain(true); });
    frameWriter.join();
    encoder.join();
    reader.join();
  } else {
    if (::write(in[1], "stop\n", 5) != 5) return 2;
    if (scenario == "queued") {
      sleepMs(50);
      startEncoder();
      frameWriter.join();
    } else {
      frameWriter.join();
      startEncoder();
    }
    drain(true);
    encoder.join();
  }

  FILE *file = std::fopen(argv[2], "wb");
  if (!file || std::fwrite(read.data(), 1, read.size(), file) != read.size()) return 2;
  std::fclose(file);
  std::printf("frame=%d colour=%d bytes=%zu\n", (int)frameResult, (int)colourResult, read.size());
  return 0;
}
