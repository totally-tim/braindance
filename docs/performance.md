# Performance

The numbers this build has been measured at, each with the method that produced it.
`docs/measurement.md` is how to take one and which runs get thrown away. The rig is an Apple
M2 Max, and the browser is Playwright's bundled Chromium through ANGLE's Metal backend.

## Rendering cost

Method: render N times per frame so fixed overhead amortises out, because a plain rAF counter
reads only the 120 Hz vsync ceiling. 217,088 points. Sample count and warmup not recorded.

| drawing buffer | points only | with the full Blackwall chain |
| --- | --- | --- |
| 0.92 Mpx | 0.83 ms | 0.87 ms |
| 2.07 Mpx | 0.83 ms | 1.17 ms |
| 3.69 Mpx | 0.83 ms | 1.57 ms |

The point pass is bound by vertex work and texture fetches, so it does not move with resolution. The post chain costs about 0.2 ms per megapixel against an 8.33 ms budget
at 120 Hz, and `render %` sets the buffer it pays that on.

| what | value | moves when |
| --- | --- | --- |
| returning early on `mm <= 0.0`, before the four neighbour `texelFetch` calls | point pass 1.44 to 0.71 ms at 2.28 Mpx | the empty share of the frame changes |
| the fragment `discard` against additive alpha falloff | 0.71 against 0.74 ms | nothing measurable, so `discard` stays for the look |

## What a second, third and fourth overlapping clip cost

Harness: `node tools/layering-ab.mjs --url … --take fixture-1g`, arms interleaved round-robin.
Method: 16 rounds after 4 discarded, one 15-output-frame block per arm per round, `fixture-1g` at
1280x720, a look of fade 300 ms plus wake 300 ms with no trails and depth writing on, so the
geometry draws two vertices per point — 434,176 slots, the shedding draw. Every block's bytes are
resident before the clock starts. A block is timed only when it rendered every frame it was asked
for, fetched nothing, drew and warmed the clips its arm declares on every one of those frames, and
left the page reporting no error; every other block is discarded.

| arm | run 1 | run 2 | run 3 | against one clip |
| --- | --- | --- | --- | --- |
| 1 clip | 5.500 | 5.200 | 5.337 | — |
| 2 clips | 6.223 | 5.907 | 6.153 | +0.723, 1.14x |
| 4 clips | 10.167 | 9.977 | 9.720 | +4.667, 1.85x |
| 4 live + 1 warming | 9.977 | 10.037 | 9.840 | +4.503, 1.84x |

Health: the one-clip arm's median over the first half of the rounds against the second, against
that arm's interquartile spread — 0.053 ms of movement against 0.367 ms, 0.430 against 0.680,
0.433 against 0.620. Each arm's delta is taken inside its own run and medianed across the three,
because the one-clip arm moves 0.3 ms between runs. The three agree arm by arm to within 6%.

There is no one number for "a clip". The second costs 0.723, 0.707 and 0.816 ms; the third and
fourth cost 1.972, 2.035 and 1.784 each, so the 1.54 ms average of the three understates the
fourth by a fifth. Four clips is 1.85x one, and 30% of a 33.3 ms frame at 30 fps. A warming clip
sits under the floor: -0.190, +0.060 and +0.120 ms against the four-clip arm, a
mean of -0.003 over a 0.310 ms span, each inside its arm's own spread of 0.367 to 0.680 ms, so the
bound is about ±0.2 ms.

The harness reads each arm's blend back before timing it. A look lands on the selected clip alone,
so an arm applying one after adding its clips would time one clip at the look asked for and the
rest at the registry's defaults — one vertex per point instead of two.

## The frame cache

| what | value | method |
| --- | --- | --- |
| fetch and JPEG decode | 2.34 ms per source frame | the pass that makes a block resident, cold, over two range requests for 61 frames. Repeats and warmup not recorded |
| one resident decoded frame | 1,263 KiB measured, 1,302,528 bytes by construction | resident-set size of every bundled-Chromium process before and after filling one take's cache, a fresh browser per point, a full GC through CDP's `HeapProfiler.collectGarbage` on both sides |

Fetch is per source frame, not per clip: two clips wanting one frame pay once, two at different
offsets pay twice, and the prefetch runs ahead of the playhead, outside a rendered frame.
The frame cost is `POINTS * 2 + POINTS * 4`, a depth block at two bytes a cell plus the same grid
as an RGBA bitmap. Baselines across five fresh browsers agree to 0.6%: 88 frames cost 157,296 and
154,416 KiB, 176 frames cost 263,248, 273,376 and 267,008 KiB, and a browser that fetches nothing
moves 560 and 640 KiB. The slope is 0.7% under the arithmetic and the ~46 MB intercept is the
fetch machinery's high-water. Take each point in a fresh browser, because freed pages are not
returned to the OS and an arm that cleared the cache reads the previous arm's peak.

A take's cache is sized by what the clips cut on it ask for: `IndexedTake.capacity` is
`demand + 16`, floored at 192 and bounded by `CACHE_CEILING_FRAMES`, which a 768 MiB budget puts at
618 frames, of which one plan may ask for 602. At fade 500 ms plus wake 1500 ms a seek renders 60
of its 60 pre-roll frames at four clips of one take and again at eight, the `CLIP_CEILING`, which
asks that take for 496. What still caps is eight clips of one take each pre-rolling more than
about 2.5 seconds, or a speed slow enough that one clip's window runs past 602 source frames.

## What a gizmo drag costs

A pointer move through the clip handles arms a redraw and never starts one. `renderProgramFrame`
runs `advanceNavigation`, so a handler that renders on an input event has asked for the next one.

Measured by `editor-check` section 22b, which delivers 30 pointer moves' worth of `objectChange`
and counts `laneRebuilds` and `renders` across them: **0 lane rebuilds while the pointer is down
and 1 over the whole gesture**, the one the release does. Rendering from the pointer event instead
reads 30 rebuilds for 30 moves. Watch the rebuild count and not the render count, because a look
write asks for its repaint through a microtask that coalesces.

## What each effect costs

Method for this whole section: interleaved paired A/B, arm order flipped every round, 21 rounds of
50 renders, and the median of the within-round paired deltas: take each round's A-minus-B and
median those. A quartile band straddling zero is recorded as under floor.
Editor on `captures/sample.knct`, playhead parked at program 12.0 s with every seek verified
against the position it asked for and stand-downs — seeks that resolve without moving the
playhead — counted at zero throughout, camera pinned, page
cache warm, 92.7% buffer coverage, machine load 11-20. Every figure carrying bloom is an upper
bound: these were taken over three's `UnrealBloomPass` and the shipped `BloomPass` costs about a
quarter of it.

The pairing is the instrument. The baseline drifts by more than most of these effects cost, 0.283
to 0.420 ms across one block of arms, and an unpaired design reports the null control at +15.1%.
Two controls hold the table up: a null arm writing the same value on both sides reads -0.009 ms
with a band of [-0.036, 0.032], and `pointSize` 9 to 48 reads +0.230 ms, the arm an instrument
blind to fill rate would fail.

| effect | 0.851 Mpx | 1.915 Mpx | shape |
| --- | --- | --- | --- |
| `pointSize` 9 to 48 | +0.230 | +0.583 | scales with pixels; the dominant fill term |
| bloom | +0.269 | +0.281 | flat: the pass count, not the pixels |
| trails (afterimage) | +0.051 | +0.214 | scales steeply, a full-screen read and write |
| streak, 16 taps | +0.044 | +0.101 | about 0.05 ms/Mpx |
| thermal | +0.076 | +0.044 | |
| `fade` 120 ms, the ghost half | +0.057 | +0.039 | on by default |
| the Blackwall reading against the RGB one | +0.056 | +0.068 | |
| additive | +0.035 | under floor | |
| grain | under floor | +0.010 | |
| turbulence, lattice, region push / scramble / mask, ripple, glitch, duotone and its hue and motion, edges, rgbSplit, scanlines, raster hardness | under floor | under floor | |

The point shader is not where the money goes: `vnoise3`, the lattice, the glitch, the region and
the ripple do not resolve above a 0.035 ms floor. The cost is the post chain and the fill.

Those fragment terms are measured against `readRgb`, the cheapest of the five readings, while
every graded look runs `blackwall.amount` with `additive` on. Re-run pinned to that base at 1.915 Mpx
nine terms stay under floor — duotone +0.025, its hue -0.024, its motion -0.035, thermal +0.061,
edges -0.010, turbulence +0.019, lattice +0.043, glitch +0.025, region scramble +0.007 — but the
floor there is about ±0.15 ms, four times the ±0.035 above, because overdraw varies once additive
blending stops points occluding each other. Thermal and lattice trend positive without resolving.

An arm inside the grade pins the composer on in both states. `postEnabled()` switches
`composer.render` for `renderer.render`, so an arm taking the last grade term to zero measures
that switch: alone it reads -0.089 ms.

### These are two clocks, and the paced one is four times the batch one

Back-to-back renders let the driver pipeline one frame's work under the next one's submission,
which is right for a term's marginal GPU cost and wrong for what a frame costs while somebody is
watching. Method: the GPU's own clock through `EXT_disjoint_timer_query_webgl2`, which is what the
stats overlay's `gpu` row reads, one rAF between frames so each is its own submission, the same
paired design, 13 rounds of 45 frames.

| effect | paired delta | ratio |
| --- | --- | --- |
| null control | +0.010 | 1.00x |
| bloom, `BloomPass` | +0.260 | 1.22x |
| bloom, `UnrealBloomPass` | +1.060 | 2.23x |
| `pointSize` 9 to 48 | +0.841 | 1.23x |
| streak | +0.105 | 1.16x |
| trails | unresolved, band [-0.679, 1.030] | |
| Blackwall entire, over `UnrealBloomPass` | +1.106 | 2.29x |

The ordering does not move and the magnitudes are four times the batch figures. Blackwall entire
over `UnrealBloomPass` slightly more than doubles GPU frame time against a 0.99 ms baseline; the
same look over the shipped chain is not measured. Quote the paced figures to anybody asking
whether a look is smooth. The two bloom rows are separate runs on a drifting machine, so their
ratios compare and their absolutes do not.

### The shipped looks are two populations, not a range

Nobody drags `streak.amount`; they pick a look. Method: whole documents at the parameter defaults,
the same paired design, 17 rounds of 50 renders.

| look | 0.851 Mpx | 1.915 Mpx |
| --- | --- | --- |
| rgb | 1.02x | 1.29x |
| ghost | 1.06x | 1.20x |
| depth | 1.29x | 0.90x |
| contour | 1.44x | 1.15x |
| ember | 1.81x | 3.00x |
| voxel | 1.85x | 2.50x |
| grille | 1.91x | 2.82x |
| blackwall | 1.99x | 2.58x |
| tearline | 2.10x | 2.96x |

Four bare readings cost about nothing and five graded looks cost double, and the gap widens with
resolution because the graded half's cost sits in the post chain. All five turn on `additive`,
`wake`, `bloom`, `trails`, `rgbsplit.amount`, `raster.amount`, `grain.amount` and a vignette
together, and four add `streak.amount` and a hard raster. Which population somebody picks decides
their number before any individual slider does.

### Bloom is the pass count, not the pixels

Shrinking `UnrealBloomPass`'s chain 60-fold changes nothing, which says the cost is fixed overhead
per pass. The second table walks its mip count on Blackwall entire: GPU clock, rAF-paced, 11
rounds of 40 frames, two independent runs.

| bloom chain | ms/frame | against off |
| --- | --- | --- |
| off | 0.308 | — |
| `refWidth/2` x 300 | 0.586 | +0.278 |
| quarter the texels, 266x150 | 0.560 | +0.252 |
| 64x36 | 0.584 | +0.276 |

| mips | passes | run 1 | run 2 |
| --- | --- | --- | --- |
| 5 | 13 | 2.138 | 2.722 |
| 4 | 11 | 2.010 | 2.685 |
| 3 | 9 | 1.173 | 1.613 |
| 2 | 7 | 1.070 | 1.484 |
| 1 | 5 | 1.033 | 1.412 |
| off | 0 | 0.952 | 1.205 |

That pass at five mips is a bright pass, five mips times two blur directions, a composite and an
additive blend — 13 render-target passes, each paying a bind and a full-screen draw — so the only
lever is removing passes. Five mips to three recovers about 80% of what bloom costs and the shape
reproduces across both runs, though the level does not. Three mips also regrades the picture: the
broad haze goes and the glow tightens onto bright edges. The shipped chain reaches a lower cost
and keeps the halo, at ten draws through resampling.

### The shipped bloom chain

`BloomPass` in `web/bloom-pass.js` is ten draws against `UnrealBloomPass`'s thirteen. The up
chain accumulates five octaves, whose target means in half float are 9.68e-3, 1.94e-2,
2.90e-2, 3.87e-2 and 4.84e-2; with `renderer.autoClear` left on they all read 9.67e-3, four fifths
of the halo wiped between draws. The composite carries `BLOOM_COMPAT_GAIN` of 3.0 and
`bloomWeights` mirrors the per-mip factors against `radius`, which is a tent tap spacing in texels
here and a weight mirror in [0, 1] in `UnrealBloomPass`; `web/post-chain.js` constructs it at 0.7.

Against `UnrealBloomPass`. Method: Blackwall at one 960x600 buffer, both chains driven to the same
five sizes, every arm repeated across two browser launches with zero spread, and the first
bloom-bearing arm of each page discarded, because the frame that engages the pass pays its compile
and reads 1.5114 where every repeat reads 7.1614.

| what | value | moves when |
| --- | --- | --- |
| cost, paced | +0.260 ms and 1.22x the frame, against +1.060 and 2.23x | separate runs, so ratios compare and absolutes do not |
| picture at `bloom` 0.5 | mean luminance 14.4805 against 17.4846, ratio 0.82818, worst of 40 tile means 21.360/255 | it grows with the glow: 0.85627 at `bloom` 0.45, 0.70718 at 0.8 |
| picture at `bloom` 0 | identical to four decimals, 0.000/255 worst tile | nothing; this says the rest of the difference is the pass |

The residual is the halo's width and not a droppable term. `UnrealBloomPass` blurs each mip with a
baked Gaussian spanning 22 taps across a 15x10 mip, where a down/up chain gets its width from one
tent per octave. Widening that tent with the energy held at about 4.3e-2 gives ratios of 0.828 at
the shipped 0.7, 0.870 at 1.0, 0.945 at 1.5, 1.012 at 2.0 and 1.093 at 3.0, with the worst tile
still improving at 3.0 and coverage still 35% against the old halo's 78%. Mean and tile disagree
about the optimum, so there is no measured value to take and the tent holds at 0.7.

Only Blackwall is comparable across the two chains. Every other bloom-bearing look carries a
duotone whose ramp width is in metres, so `ember` and `tearline` differ by 5.17% and 5.16% with
the glow off, and `voxel` carries the glyph field's exposure regrade on top.

`export-check` judges its two resolution-independence rows with bloom taken out, because the build
they are pinned against imports `UnrealBloomPass` and always will. Isolated at 960x600, Blackwall
at `bloom` 0.5 reads 7.1614 here against 17.3797 there — a ratio of 0.41205 and a worst tile of
45.649 — where `bloom` 0 reads 5.0925 against 5.0581, 1.00679 and 0.337. The tool prints the
bloom-up ratio beside the judged one on every run, and `docs/instruments.md` has the case file.

No shipped row moves with `BLOOM_LEVELS`, so the level count has no picture control, and both
tools build their earlier arm by serving `git show <rev>:web/main.js` into a second page load, so
a look-affecting change here is argued from the rows it moves and never from a re-baseline.

### Lens scaling and brightness

`export-check` compares a cropped 50-degree frame with a 26.25-degree frame reduced by two at
1728x1080 and program time 4s. Each arm reads one image per lens after an accurate seek on warm
pages, with no additional warmup discarded; bloom, trails and vignette are off. The recorded
luminance ratios are:

| fixture and arm | lens scaling | comparison |
| --- | --- | --- |
| synthetic `sample`, `lens-points` | 1.0049 | 0.6270 on `194ae972` |
| synthetic `sample`, `lens-splat` | 1.0017 | 0.4019 on `194ae972`; 0.4883 with `vsize-lensed` |
| synthetic `sample`, `lens-glyph` | 1.0022 | 0.9758 with `glyph-base-lens-absolute` |
| recorded `2026-08-12-take1`, `lens-points` | 1.0037 | 0.9149 on `194ae972` |
| recorded `2026-08-12-take1`, `lens-splat` | 1.0004 | 0.5459 on `194ae972` |

The synthetic runs retain ten fixture failures and the recorded runs retain the crop-culling
failure. `lens-absolute` fails the two ordinary-point rows; `vsize-lensed` fails only the additive
row; `glyph-base-lens-absolute` fails only the glyph row. `splat-large`, with one accurate frame
at 960x600 and 1920x1200 on warm synthetic pages, reads a coarse difference of 0.287/255 and a
brightness ratio of 1.0001, against 17.567 and 0.6267 with `vsize-framebuffer`.

The wider recorded-take sweep uses six looks, lenses 8/16/22.7446/50/90/300mm and exact
1920x1080 and 3840x2160 buffers at 4s. Three interleaved `194ae972`/fix repeats after one discarded
warmup per build and lens, with warm page caches, retain 432 reads of a center square scaled
with magnification.
All 36 boot-lens frame pairs are byte-identical. At 1080p, additive points at `pointSize` 40 read
32.837/255 at the boot lens and 32.625 at 50mm, against 12.081 on `194ae972` at 50mm. At 4K,
90mm reads 23.857 against 32.826 at the boot lens as point-size clamping enters. Blackwall also
retains a large brightness change: particle coverage with bloom, trails and vignette off is the
claim. These measurements use recorded footage, with no live sensor.

### `cascade` cannot hold its brightness, and the parameter is why

Method: fifteen pinned program positions of `captures/sample.knct` over 0 to 0.9933 s at 640x360,
device scale 1, minimising mean absolute deviation per RGB channel against frames captured on the
dimmer chain. The reference is a mean channel of 35.171 at 32.22% lit.

| `bloom` | MAD | worst channel | mean channel | lit |
| --- | --- | --- | --- | --- |
| 0.15 | 24.9910 | 210/255 | 60.163 | 48.28% |
| 0.05, shipped | 7.3004 | 161/255 | 42.441 | 35.88% |
| 0 | 4.7586 | 138/255 | 30.413 | 21.63% |
| 0.0167, unreachable | 2.1926 | 96/255 | — | — |

The search wants 0.015 to 0.0167 at a MAD of 2.19 and cannot have it: `bloom` is declared with a
`step` of 0.05 and `normalise` snaps every write to that grid, so the reachable values are 0 and
0.05. 0 wins the MAD and is not taken, because at 0 the pass does not run and the criterion is met
by deleting the thing it measures — the frame loses a third of its lit coverage. The same table at
960x600, a size the search did not tune at, keeps the ordering: 27.8610, 8.5002, 4.8568.
`snapScalar` rounds `(value - min) / step`, so 0.01 snaps 0.015 up to 0.02. **0.005 is the
coarsest step that keeps the existing 0.05 grid and puts 0.015 on it**, holding `cascade` at a
MAD of 2.19. That is a registry change somebody has to decide on.

### The first use of a pass costs a compile

Each post pass and each blending variant of the point material compiles the first time it is
reached, so the frame that engages one is long and every frame after it is normal. Method: single
frames with a `readPixels` barrier, editor at 0.851 Mpx.

| first frame after | before | after warming |
| --- | --- | --- |
| the grade pass engaging | 83.1 ms | 1.6 ms |
| bloom engaging | 48.1 ms | 4.3 ms |
| an `additive` toggle | 20.9 ms | 2.5 ms |
| the same toggle a second time | 0.7 to 2.1 ms | unchanged |

A graded preset engages the grade pass, bloom and an `additive` toggle at once, so an unwarmed
build spends about 150 ms of compilation on the first pick and nothing on the second, which is why
one tester reports a stall and another reports the same look as smooth. `warmPrograms` in
`web/main.js` enables all four passes — afterimage, mosh, bloom and grade — and renders one
composed frame in each blending state, at module level before either transport is installed, then
restores every flag and accumulator.

### `fps in` is the sensor's rate and not a rendering number

The `fps` on the status line and in the stats overlay is counted in `handleFrame` off socket
arrivals, so it measures USB and the grabber, and hub topology alone moves it 12.82 to 30.00. The
`gpu` row beside it is a timer query and not a wall clock around the draw call: the queue is
0.005 ms against 0.310 ms of GPU work, so a wall clock reports a sixtieth of the cost and does not
move when an effect is switched on.

### Showing the crop box

While the box is on screen the points the crop cuts are kept alive and dimmed instead of returning
at the depth test, so they run the whole vertex stage including the region weight.

**0.518 ms per draft — one render of the program at a parked position — with the box shown
against 0.285 ms hidden, up 82%.** Interleaved, 17 rounds
of 60 drafts alternating shown and hidden, first round discarded, medians because one hidden round
ran 0.45 ms wide. Editor on the `sample` take at a 512-tall buffer, 434,176 points, playhead parked
at 12.0 s, box at ±0.6 m over 0.05–2.0 m, which cuts most of the room and so is the worst case. The
proportion is large because the exit it replaces is the cheapest in the shader, and 0.23 ms is
under a hundredth of a 30 fps frame. Nothing pays it unless somebody is looking at the box:
`cropOutside` is zero everywhere else, and `export-check` holds an exported frame byte-identical
with the box shown and hidden. Measure it on the editor and not the recorder, because a burst of
renders starves the socket the sensor delivers on and `fps in` falls to 2–7.

### The streak

Sixteen taps per pixel in the grade pass, and it takes two numbers, because what a guarded block
costs the looks that enable it and what it costs the looks that do not are different questions.

**With the term on: 1.403 ms per frame against 1.353 off, so +0.050 ms, up 3.7%.** Interleaved, 17
rounds of 60 renders alternating the uniform inside one page session and one compiled program,
first round discarded, medians. Editor on the `2026-08-07-take2` take at 1320 frames, playhead
parked at 22.000 s, camera pinned, 1230x692 (0.851 Mpx) at 100% render scale, page cache warm
after repeated reads of the same 630 MB capture, machine load 6.0 to 8.7.

It scales with the buffer, which says the number is the taps: 0.015 ms at 0.136 Mpx, 0.028 at
0.417 and 0.050 at 0.851, so about 0.05 ms per megapixel, a quarter of the rest of the post chain.
Each buffer size is interleaved within itself and the three blocks ran in sequence, so the slope
is sound and the absolutes are not comparable between them.

**With the term off: nothing measurable, -0.003 ms.** A parameter toggle reports that by
construction, so it is measured between builds: HEAD against the commit before the streak, both
held at streak 0, interleaved round by round across two pages, 17 rounds of 60, each arm checked
to be its own build by whether the uniform is there.

Both figures cover a scalar tap offset stepping down the column. The shipped tap offset is a vec2
multiply against `streak.angle`, so each tap carries arithmetic these numbers leave out.

## The mosh pass

Per rendered frame it is enabled for, `web/mosh-pass.js` costs **two full-screen draws** — the
mosh program into one target and a copy out of it — against the grade's one and bloom's ten. Its
memory is two `HalfFloatType` RGBA targets at the drawing buffer's size, eight bytes a pixel each:
**33.2 MB at 1920x1080 and 132.7 MB at 3840x2160**. Both are allocated whenever the chain exists
whether the pass is switched on or off, so a build nobody has raised the smear on still holds
them. Its time is not measured; see [Not measured](#not-measured).

## The grabber, the wire and the library

| what | value | method |
| --- | --- | --- |
| `Registration::apply` | 6.3 ms per frame p50 | `grabber --profile` on the sensor, three runs over a fixed 40-45 s window with a 6 s warmup discarded: 6.05 / 6.33 / 6.53. Estimate was 4.5 ms. It runs serially in the frame loop and lands on capture-to-wire latency; its occlusion filter's share is not re-measured here |
| the whole serial half | 7.1 ms against a 33 ms budget | the same runs |
| hoisting `Registration::apply`'s 9.2 MB of per-call allocation | 0.30 ms of 5.71 ms | the offline A/B harness on the real loop, where 33 ms and a JPEG encode sit between calls. Its p50 baseline is that harness's and not `--profile`'s |
| the HD colour encoder | 5.50 ms mean | 90 native 1920x1080 frames over a six-second subscription at q80, TJSAMP_420 and FASTDCT, no encoder warmup discarded, the grabber delivering 180 depth frames at 30.0 fps with zero encoder-busy drops. It runs on its own thread |
| the `/key` encode, quantise plus greyscale JPEG of the 1920x1080 depth | 6.5 ms mean, about 12 ms a frame with the colour encode on the same thread against a 33 ms budget | 60 keys on an M2 Max at -O2, on the thread the colour encode already runs; the loop's own share is the copy, p50 0.16 ms over 360 calls with 40 warmup discarded. The capture node has not been measured and is the number that decides. Level 1, the smallest reading, survives an accurate inverse DCT and reads back as 0 through a fast one on a flat field at quality 90, so the lowest step of the range can decode as no reading |
| compressing the wire | zstd 1.75x on depth per frame; a u16 temporal delta plus zstd 2.75x on depth and 2.30x overall, 117 Mbit/s down to 51 | a fixed 40-45 s window with a 6 s warmup discarded; sample count not recorded. 434 KB of the 486 KB frame is uncompressed depth, and colour compresses at 1.00x, being already JPEG. Estimate was 35-45 Mbit/s |
| `/record/state` against `/library/all` | 1.2 ms against 145 ms | interleaved A/B, 20 pairs against a 200-take library, indexes warm and sidecars written, first eight pairs discarded as page cache settling and the steady-state figures taken from the last twelve, the linked pair on one machine so the listing includes its node round trip. `describeTake` reads a marks sidecar per take, so the listing's cost is per take |
| the first listing over 200 unindexed takes | 7m30s cold, 2.4s warm | `cachedIndex` scans each file once and writes a `.idx` beside it; a second server over the same directory warms off those sidecars |

## The orbit pivot's press

A press clears the afterimage, because `OrbitControls.update()` rebuilds `position` out of
`target` every frame, so any write to the pivot re-rounds the position by about an ulp and
`renderedCameraChanged` compares exactly. That clear is what one move of a right-drag pan costs,
and the drag a press precedes clears every frame anyway. The mosh's two targets are not involved:
they are cleared only by `resetAccumulators`.

Method: interleaved in one loop, 80 trials with the first 20 discarded, headless Chromium at
1512x900, `performance.now` quantised to 0.1 ms. Capture not recorded.

| press | value |
| --- | --- |
| one that hits | 0.600 ms p50, 0.700 p95 |
| one that enters the handler and leaves at the button test | 0.100 ms, the floor |
| one that finds nothing over a full grid | 2.8 ms |

The full-grid sweep goes over every second texel and then every texel. That is a one-off on a
pointer event against a 33 ms frame, and it buys presses on surfaces far enough away that stride-2
samples land more than twelve stage pixels apart.

## The effect extraction cost nothing in pixels

Ten shipped looks — `blackwall`, `cascade`, `contour`, `depth`, `ember`, `ghost`, `grille`, `rgb`,
`tearline`, `voxel` — each rendered at 15 pinned program positions and hashed with SHA-256 over
`readPixels`: **150 of 150 equal** to the recorded baseline, re-asked at every landing point of the
work. Every precondition is asserted: `captures/sample.knct` rebuilt to
2,605,152 bytes and hashed before any look renders, a 572x322 buffer inside a 640x360 viewport at
`deviceScaleFactor` 1, the unmasked renderer string matching the baseline's, and `focal.x !== 366`
refusing a run where real intrinsics arrived. The baseline moves only for an approved picture
change and records what moved; the most recent move carried 138 of 150 hashes with it. This says
the shaders did not change, not that they are correct; `registry-check` says each term reaches
pixels, in 145 rows on the same tree.

## Not measured

An absent term reads as one that came in under the floor. These did not.

| term | why there is no number | what would produce one |
| --- | --- | --- |
| `wake` | the draw range is 434,176 in both arms whenever `fade` is up, and it defaults to 120 ms, so wake moves only the surviving fraction — 5.67% to 6.35% on this fixture, under the floor. A parked frame never sheds | a harness that plays |
| the glyph field | nothing prices it | `cascade` against the same document at `glyph.amount` 0, paced, paired, on the GPU's timer query, for the render cost; `grabber --profile` on the sensor with `prof-summary` reading the contention, for what a grown sprite costs the recorder |
| the mosh pass's time | the harness written for it read a wall clock around a render loop, and `gl.finish()` does not fence on this machine | the animation-loop pacing the other tables use |
| Blackwall entire on the paced clock over the shipped bloom chain | the paced table's whole-look row was taken over `UnrealBloomPass` | the same paired design, 13 rounds of 45 frames |
| the streak's cost with `streak.angle` | its two figures cover a scalar tap offset, not the shipped vec2 multiply | the same design on a quiet machine |
| why bloom's cliff sits between four mips and three | the two mips removed there are the smallest targets, so neither a per-pass constant nor a texel count explains it | — |

The glyph field's arithmetic says it will not be cheap. At full `glyph.amount` the sprite grows
from `pointSize` to a lattice cell on screen, `latticeCell * projectionMatrix[1][1] * 540.0 / dist`
reference pixels, which for `cascade`'s 5.5 cm cell under the default 50-degree camera is **63.7
pixels at one metre against the 8.1 that look names for `pointSize`** — about 62 times the fill
per point at that distance, over 217,088 rays and 434,176 drawn slots. Each fragment inside a
grown sprite also computes a wrapped index out of three keys and looks a bit out of a 64-entry
table of `uvec2`. The field of view keyframes, so 63.7 is the default camera's number, and a
character-coverage figure needs a buffer at least 1080 tall.

## What did not work

A negative result nobody wrote down is one somebody re-derives. The grabber rows are a fixed
40-45 s window with a 6 s warmup discarded.

| what was tried | expected | measured | verdict |
| --- | --- | --- | --- |
| the four libfreenect2 isochronous transfer-pool knobs, all of which take env overrides; macOS uses `ir_pkts_per_xfer=128, ir_num_xfers=4` where elsewhere uses `8`/`60` | raise delivered fps | across 13 runs delivered fps spans 1.03 fps, against 0.60 fps across four runs of the identical baseline | every knob is barely above noise, and the Linux default is the worst of the set |
| `--no-color` | halve the drop rate | drops went slightly up: 1046/min with colour, 1089 without | SuperSpeed isochronous bandwidth is reserved, so bulk colour transfers cannot preempt the depth endpoint's allocation |
| porting the depth solve off OpenCL to Metal | raise USB intake | the OpenCL kernels benchmark at 0.75-0.85 ms against an 80-90 ms frame interval, on their own `AsyncPacketProcessor` thread | making the solve faster cannot raise intake by one frame. Metal is a contingency against Apple dropping OpenCL |
| sizing a take's frame cache by demand | change the draw | two runs either side read 5.330 / 6.807 / 10.393 / 10.317 before and 5.597 / 6.573 / 10.050 / 9.950 after: +5.0%, -3.4%, -3.3%, -3.6% | straddles zero and sits inside the 6% the gated runs reproduce to. Both sides were ungated at a load average of 7 to 9, so a signed figure was never available |
| nudging the pivot target by its rounding residual so the camera stays bit-identical | keep the afterimage across a pivot press | 8 attempts still move the camera at 7 of 9 poses | the position is rebuilt from the target every frame; a target write has never been free |
| blending `BloomPass`'s glow additively onto the buffer it reads, the way `UnrealBloomPass` does | one draw fewer | 0% lit against 100% with the pass off, at a `strength` of zero where the blend provably adds nothing | reading a buffer as a texture at the top of a chain and binding it as the render target at the bottom is undefined in WebGL, so the pass composites into a third target |

## Resolved: USB topology was the whole bottleneck

Method: 1200 frames in 40 seconds, three runs identical. Warmup not recorded.

| topology | fps | drops/min |
| --- | --- | --- |
| 3 hubs deep on a Thunderbolt dock | 12.82 | ~1000 |
| the same, with the 9-of-10 sub-image edit | 14.48 | ~950 |
| 1 hub on its own controller | 30.00 | 0 |

The depth endpoint declares a 33,792-byte isochronous packet per 125 µs microframe, reserving
2.16 Gbit/s of the link whether it is used or not, against 90 MB/s actually sent at 30 fps before
colour, so anything sharing that controller competes for what is left. Three hubs deep the sensor
is a sibling of the last hub, sharing its parent with the network interface, and libfreenect2
reports continuous `not all subsequences received` there, so most depth frames arrive incomplete
and are discarded. Replay from a file holds 29 fps throughout, which rules out the browser and the
GPU path.

Check the link is SuperSpeed first, because a USB 2.0 cable enumerates fine and then fails to
stream:

```bash
ioreg -p IOUSB -w0 -l | grep -A 40 "Xbox NUI Sensor@" | grep "Device Speed"
```

`= 3` is SuperSpeed and works. `= 2` is High Speed, and libfreenect2 fails at `failed to claim
interface with IrInterfaceId(=1)`, which reads like a permissions problem and is not one.

## The depth solve: OpenCL against CPU

`--pipeline cpu` exists for comparison. Both runs saw the same two USB subsequence failures, so
delivery was identical and the solve is the only variable. Window, sample count and warmup not
recorded.

| pipeline | fps | depth packets skipped |
| --- | --- | --- |
| OpenCL | 30.0 | 0 |
| CPU | 14.4 | 638 |

The CPU path is scalar C++ on a single `AsyncPacketProcessor` thread, since libfreenect2 ships no
hand-written SIMD for depth on any architecture. It runs roughly 70 ms per frame against a 33 ms
budget, against 0.75-0.85 ms for the OpenCL kernels.

## The edits carried in libfreenect2

Three, all carried in the vendored source and all pinned by `tools/vendor-check.mjs`. `third_party/UPSTREAM.md` carries each in full with the interleaved A/B
behind its number.

| edit | what it is worth | method |
| --- | --- | --- |
| accept a depth frame missing only sub-image 9, which the depth solve never reads | +12.9% on the degraded topology, 12.82 to 14.48 fps, and inert on a healthy one | 6.8% of discarded frames were missing nothing else. Interleaved with both paths in one binary behind a switch, every new-path run beating every old-path run |
| thread registration's occlusion filter | 2.07 ms of registration's 5.76 ms p50 at four threads on an M2 Max, and p90 from 6.69 to 4.59 ms | the offline A/B harness, interleaved A/B/A/B/A/B against upstream's scatter, three rounds, about 1000 frames per arm after 60 of warmup, all six arms at 30.03 to 30.04 fps. The default is two threads, because a Pi 5 measures four as the worst threaded setting there is: two holds 29.56–29.75 fps at 11.87 ms, three registers fastest at 10.03 ms and drops frames in 3 of 3 rounds, four is slower at 13.10 ms. The constrained machine decides |
| ignore two USB link setup calls on Apple Silicon that `Freenect2DeviceImpl::open` otherwise treats as must-succeed | no throughput number: without it the sensor never opens, because the controller does not implement U1/U2 link power states and `enablePowerStates()` answers `LIBUSB_ERROR_PIPE` | both calls are still made and still log through `CHECK_LIBUSB_RESULT`. `failed to enable power states U1!` is harmless and the U2 form is not, so grep the startup log before reading packet loss on a Mac as a topology problem |
