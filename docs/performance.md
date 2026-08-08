# Performance

What this costs and what it does not, measured rather than reasoned about. Results only;
`docs/measurement.md` is the method, and it says which runs get thrown away.

## Rendering cost

Measured on an M2 Max by rendering N times per frame so fixed overhead amortises out, since
a plain rAF counter only measures the 120Hz vsync ceiling. The point pass does not scale
with resolution; the post chain does:

| Drawing buffer | Points only | With full Blackwall chain |
| --- | --- | --- |
| 0.92 Mpx | 0.83 ms | 0.87 ms |
| 2.07 Mpx | 0.83 ms | 1.17 ms |
| 3.69 Mpx | 0.83 ms | 1.57 ms |

So the 217k points are bound by vertex work and texture fetches, not fill rate. The post
chain costs roughly 0.2 ms per megapixel, which is what `render %` controls, against an
8.33 ms budget at 120Hz.

The one optimisation that mattered was returning early on `mm <= 0.0` before the four
neighbour `texelFetch` calls, cutting the point pass from 1.44 ms to 0.71 ms at 2.28 Mpx: a
large share of every frame is empty. Removing the fragment `discard` in favour of additive
alpha falloff made no difference (0.71 vs 0.74 ms), so it is kept for the look. Bloom runs at
half buffer resolution, being the most expensive pass in the chain.

### Showing the crop box

The box's own drawing is chrome and costs a 2D canvas nothing measures. What costs is the
pass that comes with it: while the box is on screen the points the crop cuts are kept alive
and dimmed instead of returning at the depth test, so they run the whole vertex stage
including the region weight.

**0.285 ms per draft with the box hidden, 0.518 ms with it shown — up 82%.** Interleaved,
17 rounds of 60 drafts each alternating shown and hidden, first round discarded, medians
reported because one hidden round ran 0.45 ms wide. Editor on the `sample` take at a
512-tall buffer, 434,176 points, playhead parked at 12.0 s, box at ±0.6 m over 0.05–2.0 m,
which is deliberately tight enough to cut most of the room and so is the worst case rather
than a typical one.

The proportion is large because the thing it replaces is the cheapest exit in the shader —
almost every point was leaving at the depth test and now runs to the end — and 0.23 ms is
still under a hundredth of a 30 fps frame. Nothing pays it unless somebody is looking at the
box: `cropOutside` is zero everywhere else, and `export-check` holds an exported frame
byte-identical with the box shown and hidden.

**Measured on the editor, because the same run on the recorder destroys its own health
number.** A burst of renders starves the main thread, which starves the socket the sensor
delivers on: `fps in` fell to 2–7 against ~30 and, per `docs/measurement.md`, that run is
noise whatever its per-segment timings say. The editor's take is a file, so there is no
delivered-fps to break, and interleaving is what controls for the machine.

## What did not work, measured rather than assumed

A negative result nobody wrote down is one somebody re-derives. All on a fixed 40-45s window
with a 6s warmup discarded.

**Transfer-pool tuning does nothing.** libfreenect2 uses a different isochronous pool on
macOS (`ir_pkts_per_xfer=128, ir_num_xfers=4`) than elsewhere (`8`/`60`), and all four knobs
take env overrides. Across 13 runs delivered fps spans 1.03fps against 0.60fps for four runs
of the identical baseline, so every knob is barely above noise, and the Linux default was the
worst of the set.

**`--no-color` does not halve the drop rate.** An older revision of this repo's docs said it
did; controlled, drops went slightly *up* (1046/min with colour, 1089 without). SuperSpeed
isochronous bandwidth is reserved, so bulk colour transfers cannot preempt the depth
endpoint's allocation.

**The depth solve is not the bottleneck, and a Metal port would not help.** The OpenCL
kernels benchmark at 0.75-0.85 ms against an 80-90 ms frame interval, on their own
`AsyncPacketProcessor` thread, so making them faster cannot raise USB intake by one frame.
Metal is a contingency against Apple dropping OpenCL.

**What *is* worth watching** is `Registration::apply` at 6.3 ms/frame, because it runs
serially in the grabber's frame loop and lands on capture-to-wire latency; the whole serial
half measures 7.1 ms against a 33 ms budget. That figure is a correction: it was carried as
4.5 ms for a long time, and `grabber --profile` over three runs gives 6.05 / 6.33 / 6.53 at
p50. Its occlusion filter's share has *not* been re-measured here and should not be quoted as
if it had.

**Compressing the wire is bounded by colour.** 434 KB of the 486 KB frame is uncompressed
depth, and an early estimate put zstd-over-temporal-deltas at 35-45 Mbit/s. Measured,
per-frame zstd manages 1.75x on depth, and a u16 temporal delta plus zstd reaches 2.75x on
depth and 2.30x overall (117 Mbit/s down to 51). Colour compresses at 1.00x, being already
JPEG.

## Resolved: USB topology was the whole bottleneck

The sensor ran at 12-15fps with ~1000 discarded depth frames a minute, and it was the hub
chain and nothing else. Moving it from three hubs deep on a Thunderbolt dock to a single hub
on its own controller took it to a flat 30.00fps with zero drops, 1200 frames in 40 seconds,
three runs identical:

| topology | fps | drops/min |
| --- | --- | --- |
| 3 hubs deep on the dock | 12.82 | ~1000 |
| ditto, with the sub-9 patch | 14.48 | ~950 |
| 1 hub, own controller | 30.00 | 0 |

The depth endpoint declares a 33,792-byte isochronous packet per 125µs microframe, reserving
2.16Gbit/s of the link whether it is used or not, against 90MB/s actually sent at 30fps
before colour. Anything sharing that controller competes for what is left, and in the old
topology the sensor was a *sibling* of the last hub, sharing its parent with the network
interface: libfreenect2 reports continuous `not all subsequences received` there, so most
depth frames arrive incomplete and get discarded. Replay from a file held 29fps throughout,
which ruled out the browser and the GPU path.

Check the link is SuperSpeed first, because a USB 2.0 cable enumerates fine and then fails to
stream:

```bash
ioreg -p IOUSB -w0 -l | grep -A 40 "Xbox NUI Sensor@" | grep "Device Speed"
```

`= 3` is SuperSpeed and works. `= 2` is High Speed, and libfreenect2 fails at `failed to
claim interface with IrInterfaceId(=1)`, which reads like a permissions problem and is not
one.

## The depth solve: OpenCL against CPU

`--pipeline cpu` exists for comparison rather than for use:

| pipeline | fps | depth packets skipped |
| --- | --- | --- |
| OpenCL | 30.0 | 0 |
| CPU | 14.4 | 638 |

Both runs saw the same two USB subsequence failures, so delivery was identical and the solve
is the only variable. The CPU path is scalar C++ on a single `AsyncPacketProcessor` thread
(libfreenect2 ships no hand-written SIMD for depth on any architecture), roughly 70ms per
frame against a 33ms budget, against 0.75-0.85ms for the OpenCL kernels.

## The edits we carry in libfreenect2

Two, both in the vendored source rather than in a patch file, and both pinned by
`tools/vendor-check.mjs`.

**Accepting depth frames missing only the unused 10th sub-image.** libfreenect2 discards a
frame unless all ten arrive, but the depth solve reads only 0-8, so frames were thrown away
over ~300KB that nothing reads. Worth +12.9% on the degraded topology (12.82 to 14.48fps)
and inert on a healthy one.

**Threading registration's occlusion filter.** Four threads is worth 2.07ms of registration's
5.76ms p50 on an M2 Max, but the shipped default is two, because the capture node measures
four as the worst threaded setting there is. The constrained machine decides.

`third_party/UPSTREAM.md` carries both in full, with the interleaved A/B behind each number.
