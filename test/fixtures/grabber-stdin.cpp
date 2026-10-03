#include <atomic>
#include <cstdio>
#include <string>
#include <fcntl.h>
#include <sys/types.h>
#include <unistd.h>

namespace libfreenect2 {
class Freenect2Device {
 public:
  int autoExposure = 0, semiAutoExposure = 0;
  void setColorAutoExposure(float) { autoExposure++; }
  void setColorSemiAutoExposure(float) { semiAutoExposure++; }
};
}  // namespace libfreenect2

struct HdEncoder {
  int keyCalls = 0;
  bool keyOn = false;
  void setEnabled(bool) {}
  void setKeyEnabled(bool on) { keyCalls++; keyOn = on; }
};

static std::atomic<bool> g_stop{false};

#include "poll-under-test.h"

static int checked = 0, failed = 0;
static void check(bool pass, const char *name) {
  checked++; if (!pass) failed++;
  std::printf("  %s %s\n", pass ? "PASS" : "FAIL", name);
}

// One stdin as the grabber has it: the read end of a pipe, non-blocking, on descriptor 0.
// `writer` is the parent's end, so closing it is the parent going away.
struct Stdin {
  int writer = -1;
  libfreenect2::Freenect2Device dev;
  HdEncoder hd;
  std::string pending;
  Stdin() {
    int fds[2];
    if (::pipe(fds) != 0) std::_Exit(2);
    ::fcntl(fds[0], F_SETFL, O_NONBLOCK);
    if (::dup2(fds[0], STDIN_FILENO) < 0) std::_Exit(2);
    ::close(fds[0]);
    writer = fds[1];
    g_stop = false;
  }
  ~Stdin() { close(); }
  void send(const char *text) {
    const std::string s(text);
    if (::write(writer, s.data(), s.size()) != (ssize_t)s.size()) std::_Exit(2);
  }
  void close() { if (writer >= 0) { ::close(writer); writer = -1; } }
  bool poll(bool wantColor = true) {
    pollCommands(&dev, pending, wantColor, &hd);
    return g_stop;
  }
};

int main() {
  std::printf("a stdin that is open\n");
  {
    Stdin in;
    check(!in.poll(), "an open pipe with nothing in it is not end-of-file, so it does not stop");
    check(!in.poll(), "and it still does not on the next pass");
  }
  {
    Stdin in;
    in.send("low-light on\nkey on\n");
    check(!in.poll(), "ordinary commands on an open pipe do not stop");
    check(in.dev.autoExposure == 1 && in.hd.keyCalls == 1 && in.hd.keyOn,
          "and they are applied");
  }
  {
    Stdin in;
    in.send("stopped\nSTOP\n stop\nstop now\nunknown\n");
    check(!in.poll(), "a line that only resembles stop is not stop");
  }
  {
    Stdin in;
    in.send("stop");
    check(!in.poll(), "stop without its newline is a line still arriving");
    in.send("\n");
    check(in.poll(), "and it stops when the newline arrives in a later read");
  }

  std::printf("stop\n");
  {
    Stdin in;
    in.send("stop\n");
    check(in.poll(), "a stop line stops with the pipe still open");
  }
  {
    Stdin in;
    in.send("stop\r\n");
    check(in.poll(), "a stop line ending in CRLF stops");
  }
  {
    Stdin in;
    in.send("stop\n");
    check(in.poll(false), "a stop line stops a grabber started with --no-color");
  }
  {
    Stdin in;
    in.send("key on\nstop\n");
    check(in.poll() && in.hd.keyCalls == 1, "a command ahead of stop in the same read is applied");
  }

  std::printf("end-of-file\n");
  {
    Stdin in;
    in.close();
    check(in.poll(), "a closed pipe with nothing in it stops");
  }
  {
    Stdin in;
    in.send("low-light on\n");
    in.close();
    check(in.poll() && in.dev.autoExposure == 1,
          "a command read in the same pass as end-of-file is applied before the stop");
  }
  {
    Stdin in;
    in.send("stop");
    in.close();
    check(in.poll(), "a half line followed by end-of-file stops");
  }
  {
    Stdin in;
    in.send("key on\n");
    check(!in.poll(), "data on an open pipe does not stop");
    in.close();
    check(in.poll(), "and the close that follows does");
  }

  std::printf("the reader: %d assertions, %d failed\n", checked, failed);
  return failed ? 1 : 0;
}
