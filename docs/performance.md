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

**Bloom being the most expensive pass is now measured rather than asserted, and the reason
it is expensive is not the one that sentence implies** - it is the pass count and not the
resolution, so the "runs at half resolution" half of it buys nothing. See
[what each effect costs](#what-each-effect-costs) below.

## What each effect costs

Taken after testers reported the effects making performance "fluctuate wildly". The
fluctuation turned out to be mostly a different question from the cost, and both answers
are here: the cost table in this section, and [the compile
stalls](#the-first-use-of-a-pass-costs-a-compile) further down.

**Method, common to every number in this section.** Interleaved paired A/B with the arm
order flipped every round, 21 rounds of 50 renders, first round discarded, and **the
median of the within-round paired deltas** rather than a difference of medians. The
quartiles of those same paired deltas are carried beside each figure, and an arm whose
band straddles zero is recorded as under floor rather than as a value. Editor on
`captures/sample.knct`, playhead parked at program 12.0 s with the seek verified against
the position it asked for and the stand-downs counted (zero throughout), camera pinned,
page cache warm after repeated reads of the same capture. The fixture covers 92.7% of the
buffer, so this is a full room rather than an empty one. M2 Max, machine load 11-20 with
other agent sessions live.

**The pairing is not a refinement, it is the instrument.** The baseline drifts on this rig
by more than most of these effects cost - across one block of arms it moved 0.283 to
0.420 ms - and an unpaired design reported the *null* control at **+15.1%**. Differencing
inside a round cancels anything slower than one round. Two controls hold the table up: a
null arm writing the same value on both sides reads -0.009 ms with a band of
[-0.036, 0.032], and `pointSize` 9 to 48 reads +0.230 ms, which is the arm an instrument
blind to fill rate would fail.

| effect | 0.851 Mpx | 1.915 Mpx | shape |
| --- | --- | --- | --- |
| `pointSize` 9 -> 48 | +0.230 | +0.583 | scales with pixels; the dominant fill term |
| bloom | +0.269 | +0.281 | **flat** - the pass count, not the pixels |
| trails (afterimage) | +0.051 | +0.214 | scales steeply, a full-screen read and write |
| streak, 16 taps | +0.044 | +0.101 | about 0.05 ms/Mpx, which is the figure already on this page |
| thermal | +0.076 | +0.044 | |
| `fade` 120 ms, the ghost half | +0.057 | +0.039 | on by default |
| the Blackwall reading against the RGB one | +0.056 | +0.068 | |
| additive | +0.035 | under floor | |
| grain | under floor | +0.010 | |
| turbulence, lattice, region push / scramble / mask, ripple, glitch, duotone and its hue and motion, edges, rgbSplit, scanlines, raster hardness | under floor | under floor | |

**The point shader is not where the money goes**, which is worth stating plainly because
the shader's own comment calls `vnoise3` "the most expensive thing in this shader" and on
this GPU it does not resolve above a 0.035 ms floor. Neither does the lattice, the glitch,
the region or the ripple. The cost is the post chain and the fill.

Two rows in that table are a weaker claim than the rest and are marked so rather than
being quoted flat. The fragment terms above are measured against `readRgb`, the cheapest
of the five readings, while every shipped graded look runs `readBlackwall` with `additive`
on. Re-run pinned to that base at 1.915 Mpx, all nine of the terms re-tested stayed under
floor - duotone +0.025, its hue -0.024, its motion -0.035, thermal +0.061, edges -0.010,
turbulence +0.019, lattice +0.043, glitch +0.025, region scramble +0.007 - **but the floor
on that base is about +/-0.15 ms rather than +/-0.035**, because overdraw varies per frame
once additive blending stops points occluding each other. So those nine are established as
under about 0.15 ms, not under 0.035, and thermal and lattice both trend positive without
resolving.

**`wake` is unmeasured rather than free.** The draw range is 434,176 - two slots per ray -
in both arms, because the ghost half is drawn whenever `fade` is up and fade defaults to
120 ms. Wake moves only the surviving fraction, 5.67% to 6.35% on this fixture, which is
under the floor. A parked frame never sheds, so this harness cannot price it and does not
claim to.

**An arm inside the grade must pin the composer on in both of its states.** `postEnabled()`
switches `composer.render` for `renderer.render`, so an arm that takes the last grade term
to zero measures that switch rather than its own term. Left unpinned, `trails` and the
grade pass both came back negative *and* resolved, which is not a thing a pass can be. The
switch on its own reads -0.089 ms, and that figure is an artifact of reading the canvas
back after two different render paths rather than a claim that post processing is free.

### These are two clocks, and the paced one is four times the batch one

Everything above submits renders back to back, where the driver pipelines one frame's work
under the next one's submission. That is the right shape for the marginal GPU work of a
term and the wrong shape for what a frame costs while somebody is watching. Re-measured on
the GPU's own clock through `EXT_disjoint_timer_query_webgl2` - the instrument the stats
overlay's `gpu` row reads - with one rAF between frames so each is its own submission,
same paired design, 13 rounds of 45 frames:

| effect | paired delta | ratio |
| --- | --- | --- |
| null control | +0.010 | 1.00x |
| bloom | **+1.060** | 2.23x |
| `pointSize` 9 -> 48 | +0.841 | 1.23x |
| streak | +0.105 | 1.16x |
| trails | unresolved, band [-0.679, 1.030] | |
| Blackwall entire | **+1.106** | 2.29x |

The ordering does not move and bloom is still first, but the magnitudes are four times the
batch figures. Bloom costs about **1.06 ms of a 16.7 ms 60 Hz frame on an M2 Max**, and a
whole graded look slightly more than doubles GPU frame time against a 0.99 ms baseline.
Both sets are real measurements of different questions; the paced ones are the ones to
quote at anybody asking whether a look is smooth.

### The shipped looks are two populations, not a range

Nobody drags `streak`; they pick a look. Whole documents against the parameter defaults,
same paired design, 17 rounds of 50 renders:

| look | 0.851 Mpx | 1.915 Mpx |
| --- | --- | --- |
| rgb | 1.02x | 1.29x |
| ghost | 1.06x | 1.20x |
| depth | 1.29x | 0.90x |
| contour | 1.44x | 1.15x |
| ember | 1.81x | **3.00x** |
| voxel | 1.85x | **2.50x** |
| grille | 1.91x | **2.82x** |
| blackwall | 1.99x | **2.58x** |
| tearline | 2.10x | **2.96x** |

Four bare readings cost about nothing and five graded looks cost double, and **the gap
widens with resolution** because the graded half's cost sits in the post chain. The five
expensive ones are expensive for the same reason as each other: every one of them turns on
`additive`, `wake`, `bloom`, `trails`, `rgbSplit`, `scanlines`, `grain` and a vignette
together, and four of them add `streak` and a hard raster on top. So "what do the effects
cost" has no single answer, and which of the two populations a tester happened to pick
decides their number before any individual slider does.

### Bloom is the pass count, not the pixels

Shrinking the chain 60-fold changes nothing, which is what says the cost is fixed overhead
per pass:

| bloom chain | ms/frame | against off |
| --- | --- | --- |
| off | 0.308 | - |
| shipped, `refWidth/2` x 300 | 0.586 | +0.278 |
| quarter the texels, 266x150 | 0.560 | +0.252 |
| 64x36 | 0.584 | +0.276 |

`UnrealBloomPass` at five mips is a bright pass, five mips times two blur directions, a
composite and an additive blend: **13 render-target passes**, each paying a bind and a
full-screen draw. So the only lever is removing passes. Walking the mip count on Blackwall
entire, GPU clock, rAF-paced, 11 rounds of 40 frames, two independent runs:

| mips | passes | run 1 | run 2 |
| --- | --- | --- | --- |
| 5 (shipped) | 13 | 2.138 | 2.722 |
| 4 | 11 | 2.010 | 2.685 |
| 3 | 9 | 1.173 | 1.613 |
| 2 | 7 | 1.070 | 1.484 |
| 1 | 5 | 1.033 | 1.412 |
| bloom off | 0 | 0.952 | 1.205 |

**Dropping five mips to three recovers about 80% of what bloom costs**, and the shape
reproduces across both runs even though the absolute level does not. What is *not*
established is why the cliff sits between four and three rather than the cost falling
smoothly with the pass count - the two mips being removed there are the smallest targets
in the chain, so a per-pass constant does not explain it and neither does a texel count.
That is recorded as an open question rather than given a mechanism.

The picture pays for it. At three mips the broad low-frequency haze goes and the glow
tightens onto the bright edges, which on a look built around red atmosphere is a visible
regrade rather than a refinement. So the mip count was not the answer taken; the chain
was replaced instead.

### What replaced it, and what that cost the proofs

`UnrealBloomPass` is gone and `BloomPass` in `web/main.js` is ours: a progressive
down-and-up sample chain, five downsamples through a thirteen-tap bilinear filter, four
upsamples through a nine-tap tent accumulating as they go, and one composite. **Ten draws
against thirteen**, and the width comes from the resampling rather than from a Gaussian
per mip, so no level is blurred twice. Measured on the GPU clock, rAF-paced, paired, 13
rounds of 45 frames: **+0.260 ms against the old +1.060 ms, so 1.22x the frame where the
old chain was 2.23x.** Those two figures are from separate runs on a drifting machine, so
the ratios are the comparable half and the absolutes are not.

**Two things it got wrong on the way, both worth keeping.** The first version blended the
glow additively onto the buffer it had been handed, the way the pass it replaces does -
which means reading that buffer as a texture at the top of the chain and binding it as
the render target at the bottom. WebGL leaves that undefined and here it lost the picture
outright: with `strength` at zero, where the blend provably adds nothing, the frame came
back **0% lit against 100% with the pass off**. Reading both the picture and the glow and
writing a third target cannot alias, so the pass composites and swaps instead. The second
is that a probe doing five full-buffer `readPixels` calls inside one Playwright
`evaluate` gets its promise collected out from under it, which reads exactly like a page
crash and is not one.

**On `export-check` it is a net two rows better, and the baseline was taken properly
rather than assumed** - the working copies moved outside the repo, `git checkout --`, the
measurement, and the files put back, because a `git stash` in a worktree of this repo
pushes onto a ref every other worktree shares.

| tree | clean | `bloom-buffer-sized` | `bloom-reference-1080` |
| --- | --- | --- | --- |
| before | 45/50, 5 red | 7 red - **caught** | 5 red - **not caught** |
| with `BloomPass` | 47/50, 3 red | 4 red - **caught** | 3 red - **not caught** |

The two rows that went green are *the whole look rebases, not just the points* at
1728x1080 and at 1920x1200 - the resolution-independence pair, which were red on a clean
tree before this and therefore, in the words of the commit that dated them, catching
nothing. A progressive chain resamples rather than point-sampling a frozen chain, which
is the likely reason, and the honest alternative is that a differently-shaped halo simply
differs less between two sizes. Both readings are open.

**`bloom-reference-1080` is now inert for a new reason, and that is a hole to close
rather than a result to bank.** It was already uncaught before this change, blinded by
those two rows being red anyway. It is still uncaught now that they are green, and the
mechanism has moved: that mutation changes the chain's base height, and in a down/up
chain the halo's width in frame-fractions is set by *how many times it halves* and the
tent radius, not by the resolution it starts from. So the arm no longer moves the picture
it is asking about. **The control that would bite this chain mutates `BLOOM_LEVELS`**, and
until `export-check` carries one, the level count is a number nothing falsifies.

**What still pins bloom's appearance is thin, and was thin before.** `registry-check`'s
section 1b renders at parameter defaults, where bloom is 0 and the pass never runs, so it
is blind to all of this. Both tools compute their earlier arm by serving
`git show <rev>:web/main.js` into a second page load, so the reference is the old code and
there is no baseline anybody can accept - which is why a look-affecting change here can
only ever be argued from the rows it moves, never signed off by a re-baseline.

### The first use of a pass costs a compile

The largest single thing behind "the effects fluctuate" was not an effect's steady cost at
all. Each post pass and each blending variant of the point material is compiled the first
time it is actually reached, so the frame that engages one is long and every frame after
it is normal. Single frames with a `readPixels` barrier, editor at 0.851 Mpx:

| first frame after | before | after warming |
| --- | --- | --- |
| the grade pass engaging | **83.1 ms** | 1.6 ms |
| bloom engaging | **48.1 ms** | 4.3 ms |
| an `additive` toggle | **20.9 ms** | 2.5 ms |
| the same toggle a second time | 0.7 - 2.1 ms | unchanged |

A graded preset writes all three at once, so picking one used to cost about 150 ms of
compilation and picking it a second time cost nothing. That asymmetry is why the same look
gets reported as smooth by somebody who tried it twice and as a stall by somebody who
tried it once, and it is why two testers disagreed with each other rather than with the
build. `warmPrograms` in `web/main.js` now renders one composed frame with all three
passes on and both blending states before either transport is installed, and puts every
flag and accumulator back; the comment beside it has why it is one composed frame rather
than a pass-by-pass warm.

### `fps in` is the sensor's rate and has never been a rendering number

Worth writing down because it cost a round of confused reports. The `fps` on the status
line and in the stats overlay is counted in `handleFrame` off socket arrivals, so it
measures USB and the grabber - this page already records it moving 12.82 to 30.00 on hub
topology alone. Until the `gpu` row arrived beside it, it was the only performance number
anywhere in the app, and people read it while dragging sliders. The two are labelled apart
now, and the `gpu` row is a timer query rather than a wall clock around the draw call: the
queue is 0.005 ms against 0.310 ms of GPU work, so a wall clock there would report a
sixtieth of the cost and would not move when an effect was switched on.

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

### The streak

Sixteen taps per pixel in the grade pass, and it needed **two numbers rather than one**,
because what a guarded block costs the looks that enable it and what it costs the looks that
do not are different questions and only one of them answers to a parameter toggle.

**Both numbers below predate `streakAngle` and neither has been re-taken.** The tap offset
was a scalar step down the column when they were measured and is a vec2 multiply against the
streak's axis now, so each tap gained arithmetic the figures do not include. It is left
stated rather than guessed at: the gather is sixteen texture fetches and two more multiplies
is unlikely to move a number whose slope is 0.05 ms per megapixel, but "unlikely to" is the
reasoning this page exists to replace. Re-taking it wants a quiet machine, and the run that
would have taken it was on one at load 13.0.

**With the term on: 1.403 ms per frame against 1.353 off, so 0.050 ms, up 3.7%.** Interleaved,
17 rounds of 60 renders each alternating the uniform inside one page session and one compiled
program, first round discarded, medians reported. Editor on the `2026-08-07-take2` take at
1320 frames, playhead parked at 22.000 s, camera pinned, drawing buffer 1230x692 (0.851 Mpx)
at 100% render scale, page cache warm after repeated reads of the same 630 MB capture. Machine
load 6.0 to 8.7 across the run, with three other agent sessions live on the box.

It scales with the buffer, which is what says the number is the taps rather than an artifact:
0.015 ms at 0.136 Mpx, 0.028 at 0.417 and 0.050 at 0.851, so **about 0.05 ms per megapixel**,
a quarter of what the rest of the post chain costs. Each of those three is interleaved within
its own buffer size; the three blocks ran in sequence, so the slope is sound and the absolute
figures are not comparable between them - the off-arm reads *slower* at the smallest buffer,
which is the point pass being vertex-bound plus warmup, not a resolution effect.

**With the term off: nothing measurable, -0.003 ms.** This is the number a parameter toggle
reports as zero by construction, so it is measured between builds instead: HEAD against
`7c6d0fb`, the commit immediately before the streak, both held at streak 0 and interleaved
round by round across two pages, 17 rounds of 60. The two arms are checked to be the two
builds rather than assumed - one has the uniform and the other does not - because two pages
that had silently loaded the same bundle would have produced this same answer.

**The harness verifies its own seek, and had to.** A seek on this rig can resolve without
moving: the first version of this measurement placed the playhead with one seek, got back a
transport still sitting at 0 with only the opening frames resident, and would have timed
whatever frame it happened to be on. Every seek here is checked against the position it asked
for and retried, and the count of stand-downs comes back with the numbers - one per run at
these loads.

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
