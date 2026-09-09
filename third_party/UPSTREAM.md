# libfreenect2, vendored

`libfreenect2/` is upstream's source at **v0.2.1**
(`fd64c5d9b214df6f6a55b4419357e51083f15d93`), committed in full, plus the five
local edits below. `node tools/vendor-check.mjs` proves that offline.

## Why the tree is committed

A clone recipe pins a URL and a branch, so it pins nothing. A submodule pins a SHA
but still needs GitHub to serve that object later. Committing the source makes a
rebuild a function of this repository alone, and puts each change in the file it
changes instead of in a patch beside it. The source is 140 files and 2.0 MB and
nothing was trimmed, because every file removed is a file the manifest can no
longer vouch for.

## What we changed

Five files. Each carries a notice of modification in its header, as Apache-2.0
section 4(b) requires, and `vendor-check` pins the notice with the content, so
stripping it fails the check.

**This fork needs `-DENABLE_CXX11=ON`**, because the colour decoder edit declares a
scoped enum. `tools/build-native.mjs` passes it on both presets.

### `src/registration.cpp`: thread the occlusion filter

`Registration::apply` spends most of its time in the occlusion filter: an 8.3 MB
init to `+inf`, then a scatter writing a min-z into a 5×3 window of a 1920×1080
map for each of 217,088 depth pixels. Upstream does both single-threaded.

The scatter records its windows into a work list, and threads split the init and
the scatter by **linear index, not by row**. The loop guards `c_off` and never
bounds-checks `cx`, so at `cx < 2` a window's left edge lands in the previous
row's tail. Row stripes would collide there. Linear ranges have no such seam and
need no atomics. Output is bit-identical at 2, 3, 4 and 7 threads; odd counts are
the ones to test, because the band chunking `(hi - lo + threads - 1) / threads` is
where an off-by-one would show. `LIBFREENECT2_REG_THREADS` accepts 1 to 64 and
exists so a sweep can run every arm from one binary. It is not a tuning knob.

On an M2 Max at four threads, interleaved A/B/A/B/A/B against upstream's scatter,
three rounds, about 1000 frames per arm after 60 of warmup, all six arms at
30.03 to 30.04 fps:

| round | upstream | threaded | delta |
| --- | --- | --- | --- |
| 1 | 5.71 ms | 3.56 ms | −2.15 |
| 2 | 6.01 ms | 3.60 ms | −2.41 |
| 3 | 5.56 ms | 3.90 ms | −1.66 |
| mean | 5.76 ms | 3.69 ms | **−2.07** |

p90 falls from 6.69 ms to 4.59 ms. p99 is occasionally worse (10.80 ms against
7.32 ms in one round), which is scheduling jitter.

**The default is 2 threads, chosen on the Pi.** Measured with
`tools/pi-registration-ab.sh` on a Pi 5, three interleaved rounds of a 40-second
window per arm, upstream as a control in every round:

| arm | reg p50 | delivered fps | rounds losing frames |
| --- | --- | --- | --- |
| upstream | 13.49 ms | 29.66–29.84 | 0 of 3 |
| **2 threads** | **11.87 ms** | **29.56–29.75** | **0 of 3** |
| 3 threads | 10.03 ms | 27.31–28.69 | 3 of 3 |
| 4 threads | 13.10 ms | 26.40–29.13 | 3 of 3 |

Read the fps column first. Three threads registers fastest and drops frames every
round. Four is slower than three because the threads take CPU from the depth
solve's `AsyncPacketProcessor` and the GL depth processor. Two is the only count
that speeds registration up while holding rate. The Mac idles 27 ms of every
33 ms and keeps the same default.

### `src/depth_packet_stream_parser.cpp`: accept 9-of-10 sub-images

The depth solve reads sub-images 0 to 8. The tenth is commented out in the CPU
processor and never fetched by the OpenCL kernel, so a frame missing only
sub-image 9 is accepted. Depth output is unchanged.

On a degraded link, 6.8% of discarded frames were missing nothing but sub-image 9,
and the edit is worth **+12.9%** there (12.82 to 14.48 fps), measured interleaved
with both paths in one binary behind a switch, every new-path run beating every
old-path run. Inert on a healthy link.

### `src/libfreenect2.cpp`: do not fail the open on two USB link setup calls

`Freenect2DeviceImpl::open` treats `enablePowerStates()` and
`setVideoTransferFunctionState(Disabled)` as must-succeed. On Apple Silicon the
first answers `LIBUSB_ERROR_PIPE`, because the USB controller does not implement
the U1/U2 link power states, and the sensor never opens. Under
`#if defined(__APPLE__)` both calls are still made and their results ignored. A
Linux capture node compiles upstream's code exactly.

Both calls still log their failure through `CHECK_LIBUSB_RESULT`, which is a
`LOG_ERROR` and visible at the grabber's default `--log warning`. Do not add a
second warning.

One failure mode to know: `enablePowerStates` sets `U1_ENABLE` and only on
success `U2_ENABLE`. A device that takes U1 and refuses U2 is left with U1 alone,
and U1 entry and exit on a live isochronous link can cost service intervals, which
is lost RGB and depth packets. Before reading packet loss on a Mac as a topology
problem, grep the startup log: `failed to enable power states U1!` is harmless and
`... U2!` is not.

`vendor-check` pins this edit's content but cannot pin the binary, because an
`#if defined(__APPLE__)` block leaves no symbol a Linux build exposes. A Mac whose
`vendor/prefix` predates the edit runs a grabber without it, and only `npm run build:native`
fixes that.

### `include/libfreenect2/packet_pipeline.h` and `src/packet_pipeline.cpp`: name the colour decoder

Upstream picks the colour decoder inside `getDefaultRgbPacketProcessor` and gives the
caller no say in it. On Linux it takes VAAPI first and substitutes TurboJPEG only when
VAAPI fails to *initialise*. An AMD RX 9070 XT on Mesa 26 (gfx1201) initialises VAAPI,
decodes about 150 frames, then loses the amdgpu context and takes the grabber down with
`SIGABRT`. Initialisation is the wrong moment to judge a decoder that dies later, and
there is nothing to route around it with.

The header declares `enum class ColorDecoder`. Each enumerator is gated on the same
`LIBFREENECT2_WITH_*_SUPPORT` macro that gates the processor behind it, so a decoder that
can be named is a decoder that can be constructed. `defaultColorDecoder()` reads the
build's own pick, and every pipeline class gains one constructor overload taking a
`ColorDecoder`. An overload rather than a default argument, which would bake today's
default into every caller's object file, and a scoped enum so it cannot promote to `int`
and bind to `OpenCLPacketPipeline(const int deviceId)`.

`src/packet_pipeline.cpp` replaces `getDefaultRgbPacketProcessor` with
`defaultColorDecoder` and `createRgbPacketProcessor`. The default order is VideoToolbox,
TurboJPEG, TegraJPEG, VAAPI — software decode ahead of any hardware decoder that can lose
a device context — so on a build carrying TurboJPEG the hardware decoders are reached only
by asking for them. **Nothing substitutes**, because a stream that changes decoder under the
operator hides the fault it should be reporting.

The two kinds fail differently. VAAPI and TegraJPEG hold a device, and one that fails to
start hands out no buffers at all, so every colour transfer reaches the parser with a null
buffer and logs — hundreds of lines a second — while depth streams on and the sensor reads
healthy. Upstream never met that case because it substituted TurboJPEG at exactly that
point. `PacketPipeline::colorDecoderStarted` reports the initialise result without naming
`RgbPacketProcessor`, whose declaration is not installed, and the grabber refuses on it
before opening the sensor. VideoToolbox and TurboJPEG hold no device, drop the frame they
could not read and carry on.

The scoped enum is what makes `-DENABLE_CXX11=ON` a requirement of this fork; the flag was
already set for the threading backend, so no build changes. The grabber
picks a decoder with `--color-decoder` and defaults from `defaultColorDecoder()`, so one
build cannot disagree with itself about which decoder it will use.

## How the proof works

`third_party/libfreenect2.manifest` records the git blob hash of all 140 files
as upstream published them. `tools/vendor-check.mjs` asserts five things:

1. Every upstream file is present and unchanged except the five declared above.
2. The set that differs is exactly the declared set, in both directions.
3. Each declared file matches the exact content that was reviewed. Differing from
   upstream is not enough, because a reverted fix with its comment left in place
   still differs.
4. No file exists that upstream did not ship.
5. The harness oracle beside the tree is upstream's own `registration.cpp` byte for
   byte, and the library at `vendor/prefix` carries both `LIBFREENECT2_REG_THREADS`
   and `defaultColorDecoder`'s mangled symbol, so a stale prefix cannot pass as a
   build of this tree. The macOS edit leaves no symbol behind and cannot be pinned
   this way.

Six controls. Each must be caught, and the failed-assertion count is what to read.
Note that this tool exits 0 on a caught mutation.

```
node tools/vendor-check.mjs                             # PASS; exit 2 with 1 unproven when vendor/prefix is absent
node tools/vendor-check.mjs --mutate undeclared-edit    # must FAIL
node tools/vendor-check.mjs --mutate revert-local-edit  # must FAIL
node tools/vendor-check.mjs --mutate extra-file         # must FAIL
node tools/vendor-check.mjs --mutate missing-file       # must FAIL
node tools/vendor-check.mjs --mutate oracle-drift       # must FAIL
node tools/vendor-check.mjs --mutate stale-prefix       # must FAIL
```

Mutations run against a throwaway copy. `stale-prefix` needs
`vendor/prefix-oracle`, which a `registration-check` run creates, and exits 2
without it.

## Changing the vendored source

Edit the file, update its pinned hash in `DECLARED_EDITS` in
`tools/vendor-check.mjs`, and say why here. A file changed for the first time also
needs the section 4(b) notice in its header.
