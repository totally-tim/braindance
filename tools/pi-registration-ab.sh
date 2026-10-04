#!/bin/bash
# Measures what threading registration is actually worth on a capture node. Run it on the Pi,
# with the sensor attached; nothing depends on it. Two arms, two libraries, rather than one
# binary with a thread count - =1 against =4 would measure our banded scatter against itself.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$PWD
OUT=${OUT:-/tmp/pi-reg-ab}
ROUNDS=${ROUNDS:-3}
WINDOW=${WINDOW:-40}          # seconds of sensor time per arm
THREAD_SWEEP=${THREAD_SWEEP:-"2 3 4"}

mkdir -p "$OUT"

# The GL depth processor opens a GLFW context, so it needs the compositor's socket. Over SSH
# neither is inherited, and the grabber then fails at device start looking like a sensor fault.
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-0}
if [ ! -S "$XDG_RUNTIME_DIR/$WAYLAND_DISPLAY" ] && [ -z "${DISPLAY:-}" ]; then
  echo "FAIL no compositor socket at $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY and no DISPLAY set."
  echo "     The gl pipeline cannot open a context. Start the graphical session"
  echo "     or point WAYLAND_DISPLAY/DISPLAY at one before running this."
  exit 1
fi

# V3D has OpenGL and no OpenCL, and asking for a pipeline the library lacks is an error.
CMAKE_COMMON=(-DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DENABLE_CXX11=ON
              -DENABLE_CUDA=OFF -DENABLE_OPENCL=OFF -DENABLE_OPENGL=ON)

echo "== verifying the vendored tree before building anything from it =="
node tools/vendor-check.mjs

echo "== building the upstream arm =="
rm -rf "$OUT/upstream-src"
cp -r third_party/libfreenect2 "$OUT/upstream-src"
cp third_party/oracle/registration.cpp "$OUT/upstream-src/src/registration.cpp"
cmake -S "$OUT/upstream-src" -B "$OUT/build-upstream" \
  "${CMAKE_COMMON[@]}" -DCMAKE_INSTALL_PREFIX="$OUT/prefix-upstream" > "$OUT/build-upstream.log" 2>&1
cmake --build "$OUT/build-upstream" --target install -j4 >> "$OUT/build-upstream.log" 2>&1

echo "== building the threaded arm =="
cmake -S third_party/libfreenect2 -B "$OUT/build-threaded" \
  "${CMAKE_COMMON[@]}" -DCMAKE_INSTALL_PREFIX="$OUT/prefix-threaded" > "$OUT/build-threaded.log" 2>&1
cmake --build "$OUT/build-threaded" --target install -j4 >> "$OUT/build-threaded.log" 2>&1

echo "== building both grabbers =="
cmake -S native -B "$OUT/grabber-upstream" -DFREENECT2_ROOT="$OUT/prefix-upstream" > /dev/null
cmake --build "$OUT/grabber-upstream" --target grabber -j4 > /dev/null
cmake -S native -B "$OUT/grabber-threaded" -DFREENECT2_ROOT="$OUT/prefix-threaded" > /dev/null
cmake --build "$OUT/grabber-threaded" --target grabber -j4 > /dev/null

# If both arms resolve the same library the comparison is a tautology. Field 3 is the path
# after the `=>`; field 1 is the SONAME, which is identical for both arms by construction.
UP_LIB=$(ldd "$OUT/grabber-upstream/grabber" | awk '/libfreenect2/ {print $3; exit}')
TH_LIB=$(ldd "$OUT/grabber-threaded/grabber" | awk '/libfreenect2/ {print $3; exit}')
if [ -z "$UP_LIB" ] || [ -z "$TH_LIB" ]; then
  echo "FAIL could not resolve libfreenect2 for one of the arms - not measuring blind"
  exit 1
fi
echo "upstream arm loads: $UP_LIB"
echo "threaded arm loads: $TH_LIB"
if [ "$UP_LIB" = "$TH_LIB" ]; then
  echo "FAIL both arms load the same library - this is not a differential measurement"
  exit 1
fi

run() { # $1=label  $2=grabber  $3=threads
  # A fixed wall-clock window, so every arm gets the same sensor time rather than the same log lines.
  # The grabber stops when its stdin closes, and a background job in a script reads /dev/null, so
  # a pipe from sleep keeps stdin open through the window and the grace period below.
  LIBFREENECT2_REG_THREADS=$3 "$2" --profile < <(sleep "$((WINDOW + 30))") > /dev/null 2> "$OUT/$1.txt" &
  local pid=$!
  sleep "$WINDOW"
  kill -INT "$pid" 2>/dev/null || true
  local w=0
  while kill -0 "$pid" 2>/dev/null && [ "$w" -lt 20 ]; do sleep 1; w=$((w+1)); done
  kill -0 "$pid" 2>/dev/null && kill -TERM "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  echo "  $1 done ($(grep -c '^\[prof\]' "$OUT/$1.txt" 2>/dev/null || echo 0) records)"
}

stat() { # $1=file $2=field -> prints the number
  node tools/prof-summary.mjs "$1" 60 --json | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const j=JSON.parse(s);
      console.log((process.argv[1]==="fps"?j.fps:j.seg.reg.p50).toFixed(2));
    })' "$2"
}

# Interleaved, never sequential: a sequential before/after on this rig once produced a 23%
# figure that was really 12.9%. Upstream runs inside every round as the control.
echo "== running $ROUNDS interleaved rounds over threads: $THREAD_SWEEP =="
for r in $(seq 1 "$ROUNDS"); do
  run "up-$r" "$OUT/grabber-upstream/grabber" 1
  for t in $THREAD_SWEEP; do
    run "th$t-$r" "$OUT/grabber-threaded/grabber" "$t"
  done
done

echo
echo "== results =="
UP_LOST=0
declare -A LOST
for r in $(seq 1 "$ROUNDS"); do
  for arm in "up" $(for t in $THREAD_SWEEP; do echo "th$t"; done); do
    f="$OUT/$arm-$r.txt"
    fps=$(stat "$f" fps); reg=$(stat "$f" reg)
    slow=""
    if [ "$(echo "$fps < 29.5" | bc -l)" = "1" ]; then
      slow="  <-- lost frames"
      if [ "$arm" = "up" ]; then UP_LOST=1; else LOST[$arm]=$(( ${LOST[$arm]:-0} + 1 )); fi
    fi
    printf "  %-5s round %s   reg p50 %6s ms   delivered %6s fps%s\n" "$arm" "$r" "$reg" "$fps" "$slow"
  done
done

echo
# A threaded arm below rate while the upstream control holds rate is that arm competing for four
# cores, and that IS the result. Only the control losing rate too means something external ran.
if [ "$UP_LOST" = "1" ]; then
  echo "VERDICT  unusable - the upstream control itself did not sustain rate, so"
  echo "         something external was competing. Check load and re-run; do not"
  echo "         report the millisecond figures above."
  exit 1
fi
echo "VERDICT  the upstream control held rate in every round, so the machine was"
echo "         quiet and the numbers above are about the code."
for t in $THREAD_SWEEP; do
  n=${LOST[th$t]:-0}
  if [ "$n" != "0" ]; then
    echo "         th$t dropped frames in $n of $ROUNDS rounds - it oversubscribes."
    echo "         A faster registration that loses frames has made things worse."
  fi
done
echo "         Prefer the lowest reg p50 among arms that never lost a frame, and"
echo "         only ship it if every paired delta against up has the same sign."
