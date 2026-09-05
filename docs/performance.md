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

## What a second, third and fourth overlapping clip cost

`node tools/layering-ab.mjs --url … --take fixture-1g` is the harness, and it interleaves the
arms round-robin rather than running them in sequence. Method: 16 rounds after 4 discarded, one
15-output-frame block per arm per round, `fixture-1g` at a 1280x720 drawing buffer on an M2 Max
through ANGLE's Metal backend, a look of fade 300ms plus wake 300ms with no trails and depth
writing on, so the geometry draws two vertices per point - 434,176 - which is the shedding draw
and not the cheap one. Every block's bytes are resident before the clock starts.

**Three readings decide whether a block is believable**, and a block failing any of them is
discarded rather than timed: it rendered every frame it was asked for and fetched nothing inside
the block, it drew and warmed the clips its arm declares on every one of those frames, and the
page reported no error. The health number is the one-clip arm's median over the first half of the
rounds against the second, held against that arm's own interquartile spread.

| arm | run 1 | run 2 | run 3 | against one clip |
| --- | --- | --- | --- | --- |
| 1 clip | 5.500 | 5.200 | 5.337 | — |
| 2 clips | 6.223 | 5.907 | 6.153 | +0.723, 1.14x |
| 4 clips | 10.167 | 9.977 | 9.720 | +4.667, 1.85x |
| 4 live + 1 warming | 9.977 | 10.037 | 9.840 | +4.503, 1.84x |

Health on the three runs in order: 0.053 ms of movement against a 0.367 ms spread, 0.430 against
0.680, and 0.433 against 0.620. Each arm's last column is its delta taken inside its own run and
then the median of the three, because the 1-clip arm itself moves 0.3 ms between runs and a delta
taken across runs would carry that. The three agree arm by arm to within 6%, which is what this
rig reproduces to on a working machine.

**The third and fourth clips cost about 1.93 ms each and the second costs 0.75, so there is no one
number for "a clip".** Per run the second clip adds 0.723, 0.707 and 0.816, while the third and
fourth add 1.972, 2.035 and 1.784 each. Three extra clouds add 4.667 ms between them, which
averages 1.54, and that average is the trap: it is dragged down by a cheap second clip, so it
describes neither the second nor the fourth and understates the fourth by a fifth. Four clips is
1.85x one, and against a 33.3 ms budget at 30fps four overlapping clips is 30%.

**The warming clip's cost is under this rig's floor rather than measured at some small number, and
the floor is the caveat.** Its difference from the 4-clip arm is -0.190, +0.060 and +0.120 ms
across the three runs, a mean of -0.003 over a 0.310 ms span: the sign flips, and every one of
those sits inside the arm's own interquartile spread. But those spreads are 0.367, 0.680 and 0.620
ms, four to seven times the 0.093 ms of the run this page once called healthy, so all three pass
the drift gate on a machine that was carrying other work. The bound is about +/-0.2 ms and a quiet
rig might yet resolve a warming clip below it. What holds without the hedge is the shape: the
layering bound is the draw, 1.93 ms and 1.85x are large against these spreads, and warming a clip
through a cut is not what to look at first.

**The earlier run of this table is withdrawn rather than corrected, because the harness that took
it could not tell whether its arms had happened.** It read 5.330 / 6.807 / 10.393 / 10.317, and
the -0.076 ms between its last two rows is what this page published as a warming clip costing
0.02. The block's counters for clips drawn and clips warmed were being differenced per block and
read by nothing, so a block whose fifth clip idled all the way through would have been averaged in
as though it had warmed. The counters were collected and discarded rather than missing, so what
closed this was reading them rather than adding them. A look whose warm window cannot cover the
block is caught, but upstream by the render gate, which is not the reading the warming arm needs.
The three runs above are the first ones taken with the new gate armed. None of them tripped it,
and each reports the warming clip warming 15 of its block's 15 frames - which is the number the
old page required and never read. `docs/instruments.md` carries why a guard on the configuration
is not a check on the run.

**Sizing the cache by demand did not move the draw in any direction this rig can resolve.** Two
runs taken either side of that change read 5.330 / 6.807 / 10.393 / 10.317 before and 5.597 /
6.573 / 10.050 / 9.950 after, which is +5.0%, -3.4%, -3.3% and -3.6%: straddling zero rather than
pointing one way, and inside the 6% the gated runs above reproduce to. It was measured on a
machine carrying other agent sessions at a load average of 7 to 9, and both sides of it were
ungated in the sense above, so the null result is what survives and a signed figure was never
available.

**The harness reads its arms' blend back before it times them, and that guard was earned.** A look
applied through the registry lands on the selected clip alone once a clip's look is its own, so an
arm that applied one afterwards would time one clip at the look asked for and the rest at the
registry's defaults - which puts the geometry on one vertex per point instead of two for most of
the clips in the frame. The look goes into each clip's own block in the document now, and a run
whose clips do not agree about their blend refuses rather than averaging two draws.

Fetch and JPEG decode are measured on the pass that makes a block resident, cold, and come to
**2.34 ms per source frame** over two range requests for 61 frames. That is a cost per source
frame rather than per clip: two clips wanting one frame pay it once, two at different offsets pay
it twice, and the prefetch runs it ahead of the playhead rather than inside a rendered frame.

**The budget held on the draw and did not hold on the cache, and the cache is now sized by
demand.** `CACHE_FRAMES` was 192 decoded frames per take while the plan a seek makes is per clip,
so four clips of one take asked that one cache for four windows. At fade 500ms plus wake 1500ms -
two seconds of persistence, an ordinary look - a seek at four clips rendered 42 of the 60 pre-roll
frames it computed and reported itself capped 18 short; at four plus a warming clip it rendered 33
of 60. One and two clips were unaffected, and so were four clips on four *different* takes,
because each take gets its own cache. The failure was reported rather than silent, but a capped
pre-roll is an image that has not converged.

A take's cache now holds what the clips cut on it are asking for between them. The transport
publishes that demand when it plans - `askFor`, from both the seek path and the prefetch - and
`IndexedTake.capacity` is `demand + 16` frames, floored at the 192 a single clip always had and
bounded by a ceiling derived from a memory budget. **A one-clip project caches exactly what it
did.** At the same look the four-clip seek now renders 60 of 60, and so does one at eight clips,
the `CLIP_CEILING`, which asks one take for 496 frames.

**A resident frame costs 1.29 MB, not the 1.7 MB this page carried as an estimate.** By
construction it is a 512x424 depth block at two bytes a cell - 434,176 bytes exactly - plus the
same grid as an RGBA bitmap at 868,352, which is 1,302,528 bytes or 1,272 KiB. Measured: the
resident-set size of every process of the bundled Chromium, before and after filling one take's
cache from a fresh browser per point, with a full GC forced through CDP's
`HeapProfiler.collectGarbage` on both sides. Fresh browser per point is the instrument rather
than a precaution - freed pages are not returned to the OS, so an arm that cleared the cache read
the high-water mark of the arm before it and the interleaved design measured nothing. Baselines
across five fresh browsers agreed to 0.6%: 88 frames cost 157,296 and 154,416 KiB, 176 frames cost
263,248, 273,376 and 267,008, and the null arm - a fresh browser that fetched nothing - moved 560
and 640 KiB. The slope through the two loaded points is **1,263 KiB per frame**, 0.7% under the
1,272 the arithmetic gives; the ~46 MB intercept is the fetch machinery's own high-water.

The ceiling is that figure turned into a frame count: a budget of **768 MB buys 618 frames**, and a
plan may ask one take for 602 of them. It is generous by the measure it was chosen against - eight
clips at two and a half seconds of persistence each - and **what still caps is eight clips of one
take each pre-rolling more than about 2.5 seconds**, or a speed slow enough that one clip's
window alone runs past 602 source frames. A cap reports the arithmetic that produced it:
`lastSeek.bound` names the take, how many clips are on it, what they asked for and what the
ceiling is, and the strip says it once per distinct cap.

The ceiling and the span a fetch may request cannot be moved apart. A cache smaller than the span
a plan is allowed to ask for evicts the frames that fetch has just put in it, `resident()` never
comes true, and the seek stands down for ever rather than reporting anything - which is why
`timeline-check` has one control over both numbers and not one each.

## What a gizmo drag costs, and what it used to

A pointer move through the clip handles arms a redraw and never starts one, which is the rule
`renderProgramFrame` is under: it runs `advanceNavigation`, so a handler that renders on an input
event has asked for the next one. Measured with `editor-check`'s section 22b, which delivers 30
pointer moves' worth of `objectChange` and counts `laneRebuilds` and `renders` across them:
**0 lane rebuilds while the pointer is down, and 1 over the whole gesture** - the one the release
does. The historical failure this is measured against is the pointer-move-renders shape that
shipped once and cost 34 rebuilds for a single move.

`--mutate gizmo-renders-from-the-pointer` puts that shape back in one edit, and it reads
30 rebuilds for 30 moves. The number to watch is the rebuild count rather than the render count:
a look write asks for its repaint through a microtask that coalesces, so a build writing from the
event still renders about as often and only the lane stack gives it away.

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

Nobody drags `streak.amount`; they pick a look. Whole documents against the parameter defaults,
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
`additive`, `wake`, `bloom`, `trails`, `rgbsplit.amount`, `raster.amount`, `grain.amount` and a vignette
together, and four of them add `streak.amount` and a hard raster on top. So "what do the effects
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

`UnrealBloomPass` is gone and `BloomPass` in `web/bloom-pass.js` is ours: a progressive
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

**Those two paragraphs are the wrong way round, and the correction is left beside them
rather than replacing them.** Re-measured on 2026-08-24 by running this file's own
`export-check` at the two commits, one machine, one capture (`sample`), consecutive
revisions and minutes apart: at `124a90b^` the pair reads luminance ratios of **0.99312
and 0.99403** with worst tiles of 1.545 and 1.433 of 255, and passes; at `124a90b` it
reads **0.40978 and 0.40931** with worst tiles of 45.923 and 45.962, and fails. So the
replacement is what turned those two rows red, not what turned them green. The same
numbers come back unchanged to five figures at `ad7c806`, `6ad2433` and at the tip, which
is what says the flip is that one commit and not the fifteen days after it.

The reason is that those rows are cross-build and the build they are pinned against is a
revision, `f14b4be^`, which imports three's `UnrealBloomPass` and always will. From
`124a90b` they compare our chain against three's and report the distance between two
implementations as a rebase failure. Isolated at one 960x600 buffer, so that resolution is
out of it entirely: at Blackwall's `bloom` of 0.5 the mean luminance is **7.1614 here
against 17.3797 there**, a ratio of 0.41205 and a worst tile of 45.649; at `bloom` 0 it is
5.0925 against 5.0581, a ratio of 1.00679 and a worst tile of 0.337. The whole 2.4x is that
one term and none of it is the rebase. `export-check` now takes bloom out of those two rows
and prints the bloom-up ratio beside the judged one on every run; `docs/instruments.md` has
the case file.

**What that leaves open is a picture question rather than an instrument one, and it is not
settled here.** The same reading says the shipped graded looks got about 2.4x dimmer at
`124a90b` - the same build, the same look, one commit apart - and this page prices the
replacement's cost without pricing its picture. Whether that is a regrade somebody accepted
or a gain this chain is missing wants a decision rather than another measurement, and until
one is taken the section above should be read as a cost result only.

### The decision, and the three terms it turned out to be

**Taken on 2026-08-24: the graded brightness is restored.** Nine of the ten shipped looks
were graded on 08-02 and 08-08, before the swap, so the brighter output is what their
authors intended; `cascade` is the one authored inside the dim regime and its `bloom` moves
in the same change to hold it. The paragraph above stands as the state before the decision
rather than being replaced by it.

**It was three dropped terms and not a gain, which is worth more than the decision.** The
comparison this time is against `124a90b^` itself - a worktree at `fb03887`, its own server,
the same `sample` capture by hash, both stages driven to 960x600 where the two builds' chains
come out the same five sizes, every arm repeated across two browser launches with zero spread
and the first bloom-bearing arm of each page discarded, because a frame that engages the pass
pays its compile and reads 1.5114 where every repeat reads 7.1614. On that rig `fb03887` reads
17.4846 to `f14b4be^`'s 17.3797, and Blackwall with `bloom` 0 comes back **identical to four
decimals and 0.000/255 on the worst of forty tiles**, which is what says the rest of the
difference is the pass.

1. **`renderer.autoClear` was never dropped, so the accumulating chain did not accumulate.**
   Read off the pass's own targets in half float: as it shipped all five levels carry a mean
   of 9.67e-3, and with the flag held down they carry 9.68e-3, 1.94e-2, 2.90e-2, 3.87e-2 and
   4.84e-2 - one, two, three, four and five octaves, which is what the pass's comment always
   claimed. Four fifths of the halo was being wiped by the renderer between draws.
2. **The composite's `3.0`**, which `UnrealBloomPass` carries as "backwards compatibility
   with previous alpha-based intensity" and which had no counterpart here.
3. **The per-mip `bloomFactors` and the radius that mirrors them**, which is one term and
   the reason `radius` meant two different things across the swap - a weight mirror in
   `[0, 1]` there, a tent tap spacing in texels here, and `0.7` carried over verbatim. The
   old composite's arithmetic checks out to four figures against its own targets:
   `3.0 * 0.5 * sum(w * mip)` predicts 3.2913e-2 where the target reads **3.2902e-2**.

**What the restoration lands on, and what it does not.** Blackwall at one 960x600 buffer,
`bloom` 0.5, against `fb03887`: **14.4805 against 17.4846, a ratio of 0.82818**, with the
worst of forty tile means down from 45.828/255 to 21.360. At 0.45 it reads 0.85627 and at 0.8
it reads 0.70718, so the residual is not a constant - it grows with the glow. **The residual
is the halo's width and it is not a droppable term.** `UnrealBloomPass` blurs each mip with a
baked Gaussian, and at the coarse end those kernels span the frame - 22 taps across a
15x10 mip - where a down/up chain gets its width from one tent per octave. Measured by
widening that tent while the energy stays put at ~4.3e-2: 0.828 at the shipped 0.7, 0.870 at
1.0, 0.945 at 1.5, 1.012 at 2.0 and 1.093 at 3.0, with the worst tile still improving at 3.0
and coverage still 35% against the old halo's 78%. Mean and tile disagree about where the
optimum is, so there is no measured value to take and the tent is held at 0.7 - **picking 2.0
because the mean lands on 1.0 would be the fudge factor this whole exercise is about.**

**Only Blackwall is comparable across the swap, which is a result about the other four.**
Every other look carrying bloom also carries a duotone, and `bcfdb98` gave the duotone a ramp
width in metres after `fb03887` - so `ember` and `tearline` already differ by 5.17% and 5.16%
with the glow *off*, and their glow-up ratios of 1.25236 and 1.35194 are two changes read as
one. `voxel` carries the glyph field's exposure regrade on top of that. A cross-build reading
of any of them is not a reading of this pass.

**`cascade` cannot be held, and the reason is the parameter rather than the pass.** Fifteen
pinned program positions of `captures/sample.knct` over 0 to 0.9933s at a 640x360 buffer,
device scale 1, minimising mean absolute deviation per RGB channel against frames captured on
the pre-fix tree - the shape `docs/instruments.md` records for `voxel`. The search wants
**0.015 to 0.0167 at a MAD of 2.19**, which is the 0.15/9 the restored gain predicts. It
cannot have it: `bloom` is declared with a `step` of 0.05 and `normalise` snaps every write to
that grid, so the reachable values are 0 and 0.05. Against a reference of mean channel 35.171
and 32.22% lit, they read:

| `bloom` | MAD | worst channel | mean channel | lit |
| --- | --- | --- | --- | --- |
| 0.15, unchanged | 24.9910 | 210/255 | 60.163 | 48.28% |
| 0.05, **shipped** | 7.3004 | 161/255 | 42.441 | 35.88% |
| 0 | 4.7586 | 138/255 | 30.413 | 21.63% |
| 0.0167, unreachable | 2.1926 | 96/255 | - | - |

**0 wins the MAD and was not taken.** At 0 the pass does not run, so the criterion is reached
by deleting the thing it measures, and the frame loses a third of its lit coverage - 21.63%
against the reference's 32.22%, where 0.05 sits at 35.88%. That is CLAUDE.md's rule about an
object every observation skips, arriving as a number. The same table at 960x600, a size the
search did not tune at, keeps the same ordering: 27.8610, 8.5002, 4.8568. **A `step` of 0.01
on `bloom` would let 0.015 hold `cascade` at a MAD of 2.19**, and that is a registry change
somebody should decide on rather than one this change made.

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

**Both numbers below predate `streak.angle` and neither has been re-taken.** The tap offset
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

### The glyph field is unmeasured, and this is what that means

**There is no frame rate for the glyph field anywhere, and nothing on this page prices it.**
It is written down as a hole rather than left to be inferred from the silence, because a term
absent from the cost table above reads as a term that came in under the floor, and this one is
absent for the opposite reason. `wake` is the page's other unmeasured term and says so in its
own paragraph; this is the second.

The arithmetic that says it will not be cheap is arithmetic and not a measurement. At full
`glyph.amount` the sprite grows from `pointSize` to the size of a lattice cell on screen, which is
`latticeCell * projectionMatrix[1][1] * 540.0 / dist` reference pixels — for `cascade`'s 5.5cm
cell under the default 50-degree camera, **63.7 pixels at one metre against the 8.1 that same
document names for `pointSize`**, so about 62 times the fill per point at that distance. That is
over 217,088 rays, and over 434,176 drawn slots whenever `fade` is up, per the draw-range figure
above. On
top of the fill each fragment inside a grown sprite computes a wrapped index out of three keys
and looks a bit out of a 64-entry table of `uvec2`. The field of view keyframes, so 63.7 is the
default camera's number rather than a constant.

**The deleted design document said twenty-two times, and there are two errors under that
number**, which is worth recording because the figure was quoted onward. It stated the cell as
`63.7 / z` reference pixels in two places and "about 42 pixels" in a third, and the cost
paragraph was built on the third: `(42 / 9)²` is 21.8 where `(63.7 / 9)²` is 50.1. The second
error is the 9, which is the registry's default `pointSize` and not the one this look ships —
`cascade` names 8.1, and `(63.7 / 8.1)²` is the 61.8 the paragraph above rounds to 62. Neither
of the document's numbers is `cascade`'s, and a ratio quoted for a shipped look has to be taken
at the value that look names. The shipped shader's comment beside the clamp carries 64, and the
projection expression above is what the code actually evaluates.

**The nearest measured thing on this page is a neighbour rather than a bound.** The
`pointSize` 9 to 48 arm is 28x the fill where a cell-sized sprite at a metre is about 62x —
each against its own point size, the arm's 9 and `cascade`'s 8.1 — and
it costs +0.230 ms batch at 0.851 Mpx, +0.583 at 1.915, and +0.841 on the paced clock. It is a
neighbour in one term only: the glyph branch adds per-fragment index arithmetic and a table
lookup the point-size arm has none of, and it changes what fraction of the sprite survives the
discard, so the two are not the same experiment at two sizes.

**What is measured is that it draws, and that is a correctness result rather than a cost one.**
Driven in a real browser on `/edit` and `/record` with zero console errors, over `fixture-1g` on
a 1280x800 page with a planted look — `lattice.amount` 1 on the 5.5cm cell, `glyph.amount` 1, a depth reading
clipped to 0.4 and 4.5 metres — characters render at cell size in the near room and crossfade
back to round splats at range, and the rain's pattern moves between program times 12.000 and
13.000. None of those runs counted a frame. Those observations predate the crossfade reading
the drawn buffer, and every buffer in them was shorter than 1080 — so their far fields sit on
the fallback, not the look. A character-coverage figure for the shipped look has to come from a
buffer at least 1080 tall; the 1920x1080 render taken after the change is the first one that
qualifies.

**One thing that run looked like it proved, it does not, and the correction belongs here rather
than in a commit message.** Taking the hash key to zero collapses every cell to the same mark,
and this paragraph read that as saying the character is chosen per cell rather than per point.
It says nothing of the kind. A zero coefficient deletes its own seed whichever thing the seed
was keyed on, so a build hashing the *point* collapses to one mark under it just as tidily —
the observation is satisfied by both implementations, which makes it no discriminator at all.
What separates them is `registry-check`'s `one cell, one character` section: thinning a planted
wall to a quarter of its points leaves the two frames bit-identical, hash for hash, because a
mark that belongs to the cell cannot depend on how many points landed in that cell, where a
build reading the point's own texel draws whichever of its four hundred occupants arrived first
and thinning changes which one that is. Its control is the same thinning at `glyph.amount` 0, where the
splat's falloff is a gradient rather than a bit, so the point count reaches the pixels and the
two frames have to differ — which is what says the equality above it is not a fixture nothing
can reach. The digests themselves stay in the run rather than on this page: they are identifiers
for one build's output, they move on any shader edit, and what the row claims is that two of
them match rather than which two. **A screenshot that agrees with the intended implementation is
not evidence against the other one**, and that is the whole of the error being corrected.

**Closing this is two measurements rather than one, and the design document collapsed them
into one.** It said the cost could not be answered offline and wanted `grabber --profile` on
the sensor, which is right about half of it. The render cost is answerable here and by the
instrument this section already runs: `cascade` against the same document at `glyph.amount` 0, paced,
paired, on the GPU's own timer query, with the arm order flipped every round. Nothing stops
that but nobody having run it. What the editor genuinely cannot answer is whether a grown
sprite costs the *recorder* anything, because the recorder's number is delivered fps and a
burst of renders on that surface starves the socket the sensor delivers on — the shape the
crop-box measurement above had to move to the editor to escape. That half is
`grabber --profile` on the sensor with `prof-summary` reading the contention, and it is
deferred. Until both are run the honest statement is the one at the top of this subsection.

## The mosh pass: what it allocates, and the number that is not here

The feedback pass in `web/mosh-pass.js` costs, per rendered frame it is enabled for, **two
full-screen draws** — the mosh program into one target and a copy out of it — against the grade's
one and the bloom's thirteen. That is its shape rather than its price, and the price is not in
this file: the paired A/B that every number in [What each effect costs](#what-each-effect-costs)
comes from was attempted and thrown away, because the harness written for it read a wall clock
around a render loop and `gl.finish()` does not fence on this machine. `docs/measurement.md`
carries what that measured instead. The number wants the animation-loop pacing the older table
used, and nobody has re-run it that way.

**What is measured is the memory, because it is arithmetic rather than a timing.** Two
`HalfFloatType` RGBA targets at the drawing buffer's size, so eight bytes a pixel each: **33.2 MB
at 1920x1080 and 132.7 MB at 3840x2160**. Both are allocated whenever the chain exists rather
than when the pass is switched on — three's own `AfterimagePass` behaves the same way and this
pass follows it rather than inventing a second policy — so a build nobody has raised the smear on
still holds them.

## The effect extraction cost nothing in pixels, and that is a measurement

Moving every effect's GLSL out of two shader files and into sixteen packages is a refactor
exactly as long as the text reaching the driver does not change, and the ways it can change
quietly are not exotic — a chunk boundary off by one line, a blank line kept on both sides of a
joint, an indent normalised on the way through. None of those breaks a compile and none shows in
a picture anybody would look twice at. So the claim is held in pixels, against one recorded
baseline, and it was re-asked at every landing point of the work rather than once at the end.

**The rail: 150 framebuffer hashes, equal at every step.** Ten shipped looks — `blackwall`,
`cascade`, `contour`, `depth`, `ember`, `ghost`, `grille`, `rgb`, `tearline`, `voxel` — each
rendered at 15 pinned program positions and hashed with SHA-256 over `readPixels`. The final
run, on the tree that retired the migration gates, came back **150 of 150 equal** to the
baseline recorded at `0da90174`.

The method, because a hash comparison is only worth what its preconditions are:

- **Fixture.** `captures/sample.knct`, frames 0, 4, 8, 12, 16 and 20 at stride 4, replayed with
  3 substeps and the colour dropped. The rebuilt fixture is 2,605,152 bytes and its SHA-256 is
  checked against the one the baseline recorded **before any look is rendered** — a comparison
  against a different take would agree with itself perfectly and mean nothing.
- **Buffer.** A 572x322 drawing buffer inside a 640x360 viewport at `deviceScaleFactor` 1, with
  the output size set to `640x360`. Asserted rather than assumed, for the same reason.
- **Rasteriser.** ANGLE's Metal renderer on an Apple M2 Max, through Playwright's bundled
  Chromium. The unmasked renderer string is compared against the baseline's and the run refuses
  to continue if it differs, because two GPUs round a fragment differently and their hashes are
  not comparable.
- **Intrinsics.** The WebSocket is intercepted and answered with nothing, so the page falls back
  to the pinned focal length; a run where real intrinsics arrived is refused on reading
  `focal.x !== 366`. The camera is pinned at `(0, 0.1, 1.6)` looking at `(0, 0, -2.2)`.
- **The baseline's own shape.** It was recorded over three passes — two in one page, which is
  what catches a look leaking into the next, and a third in a fresh browser context, which is the
  shape a comparison run has. All three were identical.

**Two re-pins are recorded rather than hidden.** The baseline moved twice, both times for an
approved picture change rather than for a refactor: the zero-alpha discard that keeps a
transparent fragment out of the depth buffer, and the three restored bloom terms. The second
re-pin was measured at the time — the four core looks differed at 12 of 15 positions and the six
bloom-bearing looks at 15 of 15, 138 of 150 hashes in all — and everything since has been equal
at 150. A baseline re-pinned to whatever the tree does today would prove nothing, so each re-pin
carries what moved and why.

**What this does not say** is that the shaders are correct; it says they did not change.
`registry-check` is what says each term reaches pixels, and it runs 145 rows on the same tree.

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

**The keyed webcam's encode rides the colour encoder's thread.** Quantise plus greyscale JPEG
of the 1920x1080 depth measures 6.5 ms mean over 60 keys on an M2 Max at -O2, beside the
5.50 ms colour encode, so one thread carries about 12 ms a frame against a 33 ms budget there;
the loop's own share is the copy, p50 0.16 ms over 360 calls with 40 warmup discarded. The
capture node has not been measured and is the number that decides. One JPEG fact worth
keeping: level 1, the smallest reading, survives an accurate inverse DCT and reads back as 0
through a fast one, measured on a flat field at quality 90, so the lowest step of the range
can decode as no reading.

**The orbit pivot's press cannot be made free, and a target write has never been free.** The
pick that moves the pivot was designed to leave the camera bit-identical, so that
`renderedCameraChanged` would stay false and no screen-space history would be cleared. It cannot:
`OrbitControls.update()` rebuilds `position` out of `target` every frame, so any write to the
pivot re-rounds the position by about an ulp, and the comparison is exact. Nudging the target by
the residual and retrying does not converge - measured, 8 attempts still moving at 7 of 9
camera poses. What it costs is one afterimage clear per press, which is exactly what one move of
a right-drag pan has always cost, and the drag a press precedes clears on every frame anyway. The
mosh history is not involved: `renderedCameraChanged` drives `clearAfterimage()` alone, and the
mosh's two targets are cleared only by `resetAccumulators`.

**The pick itself is cheap; its retry is not.** Interleaved in one loop, 80 trials with the first
20 discarded, headless Chromium at 1512x900 on the M2 Max, `performance.now` quantised to 0.1 ms:
a press that hits costs 0.600 ms at p50 (0.700 at p95), against a 0.100 ms floor for a press that
enters the handler and leaves at the button test. A press that finds nothing over a full grid
costs 2.8 ms, because it sweeps every second texel and then every texel. That is a one-off on a
pointer event against a 33 ms frame, and it buys presses on surfaces far enough away that
stride-2 samples land more than twelve stage pixels apart.

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
