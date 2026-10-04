// The shipped stdout writer under a scripted interleaving of the capture loop and the encoder
// thread. Each step waits for the one before it to have happened, so no outcome rests on a sleep.
//
//   grabber-write <scenario> <out-file>
//
// The frame writer sends a 512 KiB message of 0x11 on a real non-blocking pipe the parent leaves
// unread, and stalls in it. The encoder's message is 512 KiB of 0x22. Then:
//   free     no stop. The encoder's message waits behind the frame and both finish once the parent
//            reads.
//   queued   the encoder's message is waiting when the parent writes `stop` to the frame writer's
//            stdin, which its stalled wait reads. The parent reads again once the frame writer has
//            returned.
//   late     as queued, with the encoder's message starting after the frame writer has returned and
//            the parent has read the pipe empty, so any header it wrote would arrive.
//   stopped  no cut. The parent reads the frame whole, the run is then stopped as the frame loop's
//            stop line or a signal stops it, and the encoder's message starts on a free lock with
//            the pipe empty and the parent reading: a key after its colour finished.
//   cut      no stop. The output is a file that takes 64 KiB and refuses the rest, and takes bytes
//            again before the encoder's message starts.
// What the parent read goes to <out-file>, which is the output itself under `cut`. Stdout says what
// each writer returned and whether the stop was set when the encoder's message started.
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
#include <signal.h>
#include <string>
#include <sys/ioctl.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <thread>
#include <unistd.h>
#include <vector>

static const uint32_t MAGIC = 0x4B4E4354;
static std::atomic<bool> g_stop{false};

#include "write-under-test.h"

static const size_t PAYLOAD = 512 * 1024;
static const uint32_t TYPE_FRAME = 2, TYPE_COLOR = 3;
static const rlim_t CUT_AT = 64 * 1024;

static void sleepMs(int ms) { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }

static void waitFor(const std::atomic<bool> &flag) {
  while (!flag) sleepMs(1);
}

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
  if (scenario != "free" && scenario != "queued" && scenario != "late" && scenario != "stopped"
      && scenario != "cut") return 2;

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

  int outFd = out[1];
  rlimit fileLimit;
  if (scenario == "cut") {
    outFd = ::open(argv[2], O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (outFd < 0 || ::getrlimit(RLIMIT_FSIZE, &fileLimit) != 0) return 2;
    // A write past the limit is then EFBIG rather than the end of the process.
    ::signal(SIGXFSZ, SIG_IGN);
    rlimit cut = fileLimit;
    cut.rlim_cur = CUT_AT;
    if (::setrlimit(RLIMIT_FSIZE, &cut) != 0) return 2;
  }

  const std::vector<uint8_t> frame(PAYLOAD, 0x11), colour(PAYLOAD, 0x22);
  std::atomic<int> frameResult{-1}, colourResult{-1};
  std::atomic<bool> frameDone{false}, colourStarting{false}, colourDone{false}, stoppedAtColour{false};

  std::thread frameWriter([&] {
    frameResult = write_message(outFd, TYPE_FRAME, frame.data(), (uint32_t)frame.size(), readCommands);
    frameDone = true;
  });

  std::thread encoder;
  auto startEncoder = [&] {
    encoder = std::thread([&] {
      stoppedAtColour = g_stop.load();
      colourStarting = true;
      colourResult = write_message(outFd, TYPE_COLOR, colour.data(), (uint32_t)colour.size());
      colourDone = true;
    });
  };

  std::vector<uint8_t> read;
  auto readWhatIsThere = [&] {
    uint8_t buf[65536];
    for (ssize_t n; (n = ::read(out[0], buf, sizeof(buf))) > 0;) read.insert(read.end(), buf, buf + n);
  };
  // Reads as the bytes come until `done` is set, then once more for whatever the writer left last.
  auto drainUntil = [&](const std::atomic<bool> &done) {
    while (!done) { readWhatIsThere(); sleepMs(1); }
    readWhatIsThere();
  };

  if (scenario == "cut") {
    frameWriter.join();
    if (::setrlimit(RLIMIT_FSIZE, &fileLimit) != 0) return 2;
    startEncoder();
    encoder.join();
  } else {
    waitStalled(out[0]);
    if (scenario == "free") {
      startEncoder();
      waitFor(colourStarting);
      drainUntil(colourDone);
      frameWriter.join();
      encoder.join();
    } else if (scenario == "queued") {
      startEncoder();
      waitFor(colourStarting);
      if (::write(in[1], "stop\n", 5) != 5) return 2;
      frameWriter.join();
      drainUntil(colourDone);
      encoder.join();
    } else if (scenario == "late") {
      if (::write(in[1], "stop\n", 5) != 5) return 2;
      frameWriter.join();
      readWhatIsThere();
      startEncoder();
      drainUntil(colourDone);
      encoder.join();
    } else {
      drainUntil(frameDone);
      frameWriter.join();
      g_stop = true;
      startEncoder();
      drainUntil(colourDone);
      encoder.join();
    }
  }

  size_t bytes = read.size();
  if (scenario == "cut") {
    struct stat st;
    if (::fstat(outFd, &st) != 0 || ::close(outFd) != 0) return 2;
    bytes = (size_t)st.st_size;
  } else {
    FILE *file = std::fopen(argv[2], "wb");
    if (!file || std::fwrite(read.data(), 1, read.size(), file) != read.size()) return 2;
    std::fclose(file);
  }
  std::printf("frame=%d colour=%d stopped=%d bytes=%zu\n", (int)frameResult, (int)colourResult,
              (int)stoppedAtColour, bytes);
  return 0;
}
