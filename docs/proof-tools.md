# Proof tools

Every tool that proves something: how to run it, what it needs before it will run, what its exit
code means, and the `--mutate` controls it must fail under. `CLAUDE.md` carries the one-line
index of which tool proves what. `docs/instruments.md` carries the method behind the suite.

## Read the count, not the code

Most tools print an assertion count and a failed count, and that pair is the verdict. Five do
not: `determinism-check` prints `PASS` or `FAIL` alone, `index-check` and `registry-check` print
`PASS` or `FAIL (n)` with the failed count only, `release-gate-check` prints the failed count
alone, and `syntax-check` counts files, not assertions. A run with zero failed assertions and a non-zero exit is a crash to investigate, not
a catch to record.

The tools disagree about what a caught mutation exits. Four exit **0** on a catch and 1 on a miss
— `registry-check`, `vendor-check`, `registration-check` and `release-gate-check` — so anything
gating on "non-zero means caught" reads a genuine miss by these four as a catch. Twelve exit 1 on
a catch *and* 1 on a miss, so the code carries no information and only the printed sentence
separates them. Six carry no miss branch at all and exit on the failure count, so a mutation they
fail to catch exits 0 and reads as a clean pass.

Per tool, read from the source:

| tool | 0 | 1 | 2 |
| --- | --- | --- | --- |
| `determinism-check` | pass | a failed assertion | not used |
| `index-check` | pass | a failed assertion, a catch, or a miss | `DID NOT RUN`: no 2 GiB fixture, a stale anchor, a crash |
| `registry-check` | pass, or a **catch** | a failed assertion, or a miss | `DID NOT RUN`: a stale anchor, a crash, no browser |
| `timeline-check` | pass, or a missed mutation | a failed assertion, or a stale anchor | `DID NOT RUN`: a take under 12s |
| `preview-check` | pass, or a **catch** | a failed assertion, a crash, or a miss | not used |
| `keyframe-check` | pass, or a missed mutation | a failed assertion, a stale anchor, or the page stopped answering | `DID NOT RUN`: a take under 24s |
| `export-check` | pass, or a missed mutation | a failed assertion, a stale anchor, or a crash (it has no crash handler) | not used |
| `editor-check` | pass | a failed assertion, a catch, or a miss | `DID NOT RUN`: a take under 32s, a stale anchor |
| `library-check` | pass, or a missed mutation | a failed assertion, or a stale anchor | `PASS WITH CLAIMS UNPROVEN`, or a held port |
| `boot-check` | pass | a failed assertion, a catch, or a miss | `DID NOT RUN`: 8391 held, a crash |
| `monitor-check` | pass | a failed assertion, a catch, or a miss | `DID NOT RUN`: 8341 held, a crash |
| `sensor-view-check` | pass | a failed assertion, a catch, or a miss | `DID NOT RUN`: no sensor hello, a stale anchor, no browser |
| `level-check` | pass | a failed assertion, a catch, or a miss | `DID NOT RUN`: 8377 held, no GPU browser |
| `vcam-check` | pass | a failed assertion, a catch, or a miss | `DID NOT RUN`, or section 6 unproven without an IPv4 |
| `guard-check` | pass | a failed assertion, a catch, or a miss | `PASS, with claims untested here`: no non-internal IPv4 |
| `jobs-check` | pass | a failed assertion, a catch, or a miss | `DID NOT RUN`: a port held, a crash |
| `effect-check` | pass | a failed assertion, a catch, or a miss | `UNTESTED`, or `DID NOT RUN` |
| `effect-conformance-check` | pass | a failed assertion, a catch, or a miss | `UNTESTED`, or `DID NOT RUN` |
| `module-check` | pass | a failed assertion, a catch, or a miss | `DID NOT RUN`: a stale anchor |
| `syntax-check` | pass, or a missed mutation | a failed assertion | `DID NOT RUN`: a stale anchor |
| `cpp-check` | pass, or a missed mutation | a failed assertion | `DID NOT RUN`: a stale anchor, no compiler or headers |
| `vendor-check` | pass, or a **catch** | a failed assertion, a miss, or a stale anchor | `PASS on the source, with the artifact untested` |
| `registration-check` | pass, or a **catch** | a failed assertion, or a miss | a build or tooling failure |
| `release-gate-check` | pass, or a **catch** | a failed assertion, or a miss | `DID NOT RUN`: no registry |

A *catch* is a mutation the tool reddened and a *miss* is its `NOT CAUGHT` line. No tool uses a
code above 2.

## How a mutation is delivered

A mutation is a piece of source text. Each entry names a file and a `from`/`to` pair that has to
match exactly once (`vendor-check` checks presence only, so a duplicated anchor there edits the
first occurrence), and an anchor that no longer matches stops the run before it asserts
anything. Most tools report that as `DID NOT RUN` and exit 2. Six of them throw instead, so a
stale anchor there exits 1 as an uncaught crash with nothing asserted: `timeline-check`,
`keyframe-check`, `export-check`, `library-check`, `vendor-check` and `registry-check`, the last
of which turns the throw back into an exit 2 through its own crash handler.

Every tool answers a name it does not declare by listing the whole set it does, so
`node tools/registry-check.mjs --mutate __enumerate__` prints
`unknown mutation __enumerate__ - have …` and exits without running. The tools that check their
fixture, server or browser first (`timeline-check`, `keyframe-check`, `export-check`,
`sensor-view-check`, `editor-check`) need those in place before they reach the name.
`tools/sweep-all.mjs` reads its inventory out of exactly that line.

A mutated run prints the expected failure row when its entry carries a `fails:` field.
For other entries, read the catch from the assertions that fired.

Four tables are too large to reproduce here — `editor-check` declares 202, `library-check` 114,
`registry-check` 54 and `effect-check` 42. Their sections give the count and the enumerate
command prints the names.

## `determinism-check`

The same program time produces the same image.

```
node tools/determinism-check.mjs
node tools/determinism-check.mjs --clock --before HEAD~1
```

| needs | |
| --- | --- |
| server | `--url`, default `http://localhost:8080` |
| fixture | a capture; `--capture` names it |
| browser | a GPU browser |

`--frames`, `--stride` and `--substeps` size the run; `--headed` shows it. `--clock` is the
before-half and reads `uniforms.time` off an untouched `git show <rev>` page, so it refuses a rev
whose `web/main.js` already contains the transport. This tool declares no mutations.

## `index-check`

The sidecar index, the content hash and the HTTP frame API.

```
node tools/index-check.mjs --url http://localhost:8080
node tools/index-check.mjs --stage
```

| needs | |
| --- | --- |
| server | `--url`, default `http://localhost:8080`; `--stage` spawns its own on 8251 |
| fixture | `--fixtures`, three captures by default; the last must be past 2 GiB or it refuses and names the byte count |
| binaries | none |

A mutation edits the server's own copy of `server/capture.js`, so a mutated run cannot borrow the
server at `--url` and implies `--stage`. `--stage` without a mutation is the way to re-run the
baseline in the conditions a mutated run failed in.

- **`frame-read-is-a-whole-file-read`** — `Capture.readAt` reads the file whole and slices, the
  hazard `server/capture.js` opens by naming: a whole-file read cannot reach past 2 GiB.
- **`frame-offsets-truncated-to-32-bits`** — the frame at `offset % 2**31` served with a 200, so
  only the row's own byte comparison can redden.

## `registry-check`

One registry drives the renderer, the panel is a view on it, and every look term reaches the
pixels.

```
node tools/registry-check.mjs --url http://localhost:8080
```

| needs | |
| --- | --- |
| server | `--url`, default `http://localhost:8080` |
| fixture | a capture |
| browser | a GPU browser |

`--before` and `--against` drive the cross-build arm, which finds its revision by a content
marker instead of a hash, so a rewritten history does not move it.

54 controls, one per look term or per rule about how a term reaches the pixels.
`node tools/registry-check.mjs --mutate __enumerate__` prints the names. Read the fired rows and
not the total.

Section 1b's `readGhost` row carries a two-sided tolerance: it absorbs up to 64 bytes of 921,600
and a single step, and the passing line names what it absorbed. A clean run reads
`6 frames, 1 within tolerance (worst 1 bytes of 921600, delta 1)`, so a red row there is a finding
and so is that byte count climbing.

**Known reds.** On a `make-sample` fixture the tool comes back FAIL (3) on a clean tree: the
sweep reports `unexplained: bottom snapDelta`, the count lands at `92 of 97 parameters are proven
to reach the pixels`, and the crop's second row reports `identical with only near/far authored`.

| commit | rows | cause |
| --- | --- | --- |
| `3b7ab90` | 3, all crop and snap | the synthetic cloud sits inside the authored depth pair, so there is nothing to cut |

A run that takes the count past three has moved something. On real footage all three pass.

## `timeline-check`

A seek lands where playback would have, and an arbitrary output rate interpolates the capture
instead of repeating it.

```
node tools/timeline-check.mjs --url http://localhost:8080 --take fixture-1g
```

| needs | |
| --- | --- |
| server | `--url`, default `http://localhost:8080` |
| take | `--take`, at least 12s, or it exits 2 naming the shortfall |
| browser | a GPU browser |

Section 7 is 71 of the assertions and runs five clips over two takes, four of them overlapping at
6.5s. About one run in three dies with `Resulting promise was garbage collected` and zero failed
assertions. That run did not run; re-run it, and read nothing off its count.

- **`warm-reads-the-selection`** — every clip warms on the selected clip's persistence instead of
  its own. Section 8b is the catch.
- **`cache-is-a-constant`** — a take's cache back to one constant however many clips share it,
  capping a four-clip pre-roll at 41 of the 60 frames it computed.
- **`cache-keeps-absent-demand`** — a take outside the current plan keeps the demand and decoded
  frames of the last plan that named it.
- **`prefetch-ignores-shared-take-demand`** — prefetch keeps the full output horizon when eight
  clips overflow their shared take cache.
- **`preroll-constant`** — the pre-roll stops being a function of anything.
- **`preroll-none`** — nothing is rendered ahead of the target.
- **`preroll-ignores-warming`** — a seek inside a later clip's warm window rebuilds none of the
  warm history already elapsed.
- **`rate-ignored`** — a clip's speed stops scaling its local time into source time.
- **`duplicate-frames`** — the interpolation weight is rounded to 0 or 1, so an output rate
  repeats a capture frame instead of blending two.
- **`draft-keeps-accumulators`** — a draft stops bypassing the accumulators and inherits its
  history.
- **`draft-always-resets`** — no draft is ever standing, so every draft clears them.
- **`no-reset`** — the accumulators are not cleared before a pre-roll.
- **`mosh-no-history`** — the mosh pass stops reading the frame it drew last.
- **`mosh-never-refreshes`** — the refresh never fires, so the memory has no ceiling and the
  pre-roll decodes from a frame that was never a keyframe.
- **`mosh-preroll-zero`** — the mosh contributes nothing to the pre-roll.
- **`age-clamp-low`** — the surface memory's age ceiling drops from 6.0s to 4.0s and stops being
  checked against the longest life the look asks for.
- **`no-repaint`** — the registry stops announcing its writes, so a slider moved at a parked
  playhead changes nothing.
- **`reading-write-skips-repaint`** — selecting a reading that writes no parameter leaves the
  previous one on screen.
- **`rain-accumulates`** — the rain integrated frame to frame, so a seek lands where playback
  never would. Its section raises the rain itself, because every other arm renders it inert.
- **`rain-phase-unread`** — the same clock written correctly and read by nothing; the control for
  the guard rather than for the claim.
- **`warm-skipped`** — a clip is shown the instant it starts, with whatever its ping-pong pair
  last drew still in it.
- **`warm-without-reset`** — a clip warms and is shown without ever being put back to nothing.
- **`look-broadcast`** — every clip is written the first clip's look.
- **`clip-look-reads-selection`** — a clip value is read off the selected clip rather than the
  clip being asked about.
- **`draw-order-by-array`** — draw order comes off the array instead of the clip ids, so a
  document composites differently depending on how its clips are listed.
- **`take-not-shared`** — every clip opens its own copy of its take, so two clips of one take
  carry two indexes and two caches.

## `preview-check`

```
node tools/preview-check.mjs --url http://localhost:8080 --take fixture-1g
```

Needs `--url`, a GPU browser, and a take with at least nine seconds of
footage. It uses an isolated browser profile and leaves its screenshot and assertion report in
a temporary directory printed at exit. It drives the preview settings in View and the Play button, compares
every RGB byte against an accurate live render, checks the preview's visible position and its
removal on pause and resize, then checks cache boundaries, invalidation, animated keys,
free-camera views, reload persistence, overlapping clips, and storage failures. The top-down
inset must match the live pixels for either selected clip. Other rows drive cross-tab eviction
and clear, corrupt-frame repair, error containment, source prefetch before a cache boundary,
and preserved-page lifecycle events. The ordinary run also waits for the renderer's idle release.
The pixel comparisons use a 1000 by 700 browser viewport at device scale 1; their source is
whichever take `--take` names. The overlap/feedback row uses the timeline tool's 2/255
tolerance and repeats the sequential-versus-seek comparison on the live renderer beside it;
the other cached-image rows require exact equality. These establish correctness, not a sensor
performance claim.

Add `--http-origin` to run the editor at `http://preview.local` through a browser-only resolver
mapping to the host at `--url`. This is a real non-secure browser origin using the same server;
the tool asserts that Web Crypto is absent. It does not open a LAN listener or test a physical
network link.

The timeline, editor, export, and boot tools turn idle rendering off in their isolated browser
profiles. Their foreground checks must not compete with a second renderer; `preview-check`
drives that renderer and its idle preference explicitly.

The coverage rows compare the visible band against ruler ticks and the playhead while zooming
and panning. They remove stored frames to expose a gap, check the readiness percentage, and
scrub through the band. The preview controls must belong to View, with no popup on the timeline.

Its controls are `--mutate cache-never-displays`, `--mutate edits-keep-old-previews`,
`--mutate preview-skips-history`, `--mutate preview-ignores-free-camera`,
`--mutate first-frame-is-skipped`, `--mutate late-decode-survives-camera-change`,
`--mutate live-resume-skips-history`, `--mutate hidden-preview-stays-visible`,
`--mutate preview-is-misplaced`, `--mutate preview-plan-is-empty`,
`--mutate cache-boundary-stays-cold`, `--mutate corrupt-frame-stops-idle`,
`--mutate clear-allows-stale-render`, `--mutate preview-error-stops-loop`,
`--mutate manual-render-skips-settle`, `--mutate camera-drag-rebuilds-identity`, and
`--mutate storage-changes-stay-local`, `--mutate stale-storage-error-survives`, and
`--mutate clear-keeps-frame-blobs`, `--mutate coverage-uses-whole-clip`,
`--mutate coverage-hides-gaps`, and `--mutate coverage-stays-in-overview`.
Each intercepts the changed module in both browser contexts and must fail its declared assertion.
A mutation exits zero only when that assertion
fails and the browser loaded the changed module. The ordinary run exits zero only with no
failed assertions. Run one GPU proof at a time and keep served code unchanged during it.

## `keyframe-check`

The three interpolation kinds are the curves the design names, evaluation writes them through the
registry, and undo restores the document and never the view.

```
node tools/keyframe-check.mjs --url http://localhost:8080 --take fixture-1g
```

| needs | |
| --- | --- |
| server | `--url`, default `http://localhost:8080` |
| take | `--take`, at least 24s, or it exits 2 naming the shortfall |
| browser | a GPU browser |

It runs its cheapest claim first on a 60-second budget and stops the run if that fails: an
evaluator that announces its writes schedules a seek per frame, so the page never answers and
every later section reads as a timeout.

- **`rate-anchor-skips-clip-start`** — the speed gesture anchors on the source second without
  subtracting the clip start.
- **`rate-landing-skips-clip-start`** — the same conversion run back, so the landing is a clip
  second read as a project one.
- **`ease-ignored`** — ease handles stop bending the timing and every scalar segment is a lerp.
- **`step-lerps`** — a step track interpolates, which is the one thing a boolean cannot do.
- **`pose-linear`** — the camera corners on straight lines between its keys.
- **`pose-ignores-ease`** — the camera ignores its handles; separable from `pose-linear` because
  it aims at the remap alone.
- **`source-start-ignored`** — the in-point drops out of the mapping, so a trimmed clip reads the
  take from its head.
- **`clip-keys-on-the-program-clock`** — everything a clip owns is read and written at program
  time rather than on the clip's own clock.
- **`every-key-on-the-clip-clock`** — the same boundary from the other side, with scope unasked.
- **`placement-rotation-lerped`** — the rotation between two keys is lerped and normalised rather
  than slerped, which reaches every rotation this build interpolates.
- **`evaluator-repaints`** — the evaluator's writes are no longer wrapped in `withoutRepaint`, so
  every evaluated frame asks for a repaint.
- **`undo-includes-view`** — undo restores the view as well as the document.
- **`undo-on-input`** — undo pushes per input event instead of per interaction, so one drag is
  two hundred entries.
- **`seek-plans-once`** — a seek plans its span once and never looks again.
- **`preroll-reads-uniforms`** — the pre-roll reads the uniforms, which hold the look where the
  playhead was parked.
- **`trails-damp-at-target`** — the trails half of the same fault, back to a closed form that
  holds only while damp is constant.
- **`pose-no-slerp`** — orientation holds the earlier key. Every quaternion stays a unit
  quaternion and every key is hit, so identity rotations hide it.
- **`chrome-in-frame`** — the furniture goes back inside the frame.

## `export-check`

The look is resolution-relative, an exported frame is the frame the editor showed, no wall clock
reaches the render, and the file ffmpeg produced is the one that was asked for.

```
node tools/export-check.mjs --url http://localhost:8080
```

| needs | |
| --- | --- |
| server | `--url`, default `http://localhost:8080` |
| fixture | a capture; `--take` names it |
| browser | a GPU browser |
| binaries | ffmpeg and ffprobe, resolved through PATH; `--ffmpeg` and `--ffprobe` override |

Section 9 drives refused edits on purpose and its refusals are DOM-only, so it needs no render.
`--before` drives the cross-build arm.

The lens rows compare the center half of a 50-degree frame with a full 26.25-degree frame
reduced by two, both rendered at 1728x1080 at program time 4s. Bloom, trails and vignette are off.
They require a different image without the crop and modeled sprite sizes clear of the clamps.

| row | look | coarse mean limit, out of 255 | luminance ratio tolerance |
| --- | --- | --- | --- |
| `lens-points` | depth-writing points, `pointSize` 24 | 3 | 0.01 |
| `lens-splat` | additive points, `pointSize` 40 | 6 | 0.01 |
| `lens-glyph` | depth-writing points, `pointSize` 64, glyph 0.25, cell 0.12 m | 6 | 0.01 |

The glyph arm requires every modeled sprite above the 16-pixel legibility band. `splat-large`
checks resolution scaling with additive points at `pointSize` 60, exposure 0.25 and a 50-degree
camera, requiring the smallest sprite above the 10.8-reference-pixel normalization threshold.
`docs/performance.md` carries the lens and mutation measurements.

- **`edits-during-an-export-are-not-refused`** — the guard removed at its source, so every door
  lets a write through while a render is reading the document.
- **`the-progress-bar-is-never-painted`** — the bar and the chip stop following the render they
  report, while the reading behind them stays correct.
- **`prores-writes-h264`** — the container is kept and the stream swapped.
- **`pngseq-writes-one-file`** — the sequence stops being a directory.
- **`pointsize-absolute`** — the dominant screen-space term goes back to framebuffer pixels.
- **`lens-absolute`** — ordinary points stop following the lens; fails `lens-points` and `lens-splat`.
- **`glyph-base-lens-absolute`** — the glyph branch's base stops following the lens; fails `lens-glyph`.
- **`vsize-lensed`** — additive normalization includes lens magnification; fails `lens-splat`.
- **`vsize-framebuffer`** — the additive normalisation reads the drawn size, so the look sums four
  times too bright at twice the resolution.
- **`grade-absolute`** — grain and scanlines go back to framebuffer pixels.
- **`mosh-buffer-sized`** — the smear's reach and column width go back to framebuffer pixels.
- **`bloom-buffer-sized`** — the glow's chain follows the buffer, so its halo halves in width
  every time the buffer doubles.
- **`bloom-reference-1080`** — the chain frozen against 1080 rather than the height the look was
  graded at. Nothing here catches it; `test/bloom-chain.test.mjs` holds the arithmetic.
- **`export-ignores-missing-effects`** — the door stops refusing, so a clip renders without the
  effect it asked for.
- **`suppress-is-global`** — the door answers a per-effect question globally, so the second
  missing effect passes on a decision about the first.
- **`deliverable-forgets-suppressed`** — the record loses the note that a layer was skipped.
- **`export-button-drops-the-suppression`** — the click handler stops handing the door what the
  badge holds, so a suppressed effect is still refused.
- **`suppression-outlives-its-document`** — a suppression made about one clip is carried into the
  next document opened.
- **`rgbsplit-absolute`** — only the split reverts, so the other two terms cannot carry the claim.
- **`region-in-metres`** — the region's falloff stops being metres and becomes reference pixels.
- **`crop-in-pixels`** — the lateral crop planes stop being metres in the room and become a
  fraction of the frame.
- **`cropoutside-reaches-the-export`** — the faint pass answers to the button alone, so a crop box
  left on puts the cut points into the file.
- **`faint-survives-at-zero`** — a point outside the box survives to the fragment stage and goes
  on writing depth.
- **`grain-continuous`** — the grain's hash loses its `floor`, so the noise is continuous instead
  of one value per reference pixel.
- **`intrinsics-defaults`** — the take renders on the boot intrinsics again.
- **`export-wall-clock`** — a wall clock reaches the export's playhead, sub-frame, because the
  point is that any clock in the seam is enough.
- **`export-second-look`** — the export renders through a look of its own that nearly agrees.
- **`export-repeats-frame`** — one frame of the export is the frame before it, with the count
  still right and the file still playing.
- **`export-wrong-rate`** — the browser tells the encoder a rate it is not stepping at.
- **`export-flipped`** — the frames leave the browser upside down, which every metadata probe
  reports as correct.
- **`export-ignores-size`** — the output size stops reaching the renderer, so an unfamiliar size
  delivers the preview's buffer.
- **`scale-by-width`** — the reference becomes buffer width over 1728 rather than height over
  1080, and every term follows it.
- **`export-fail-unlinks-output`** — the failure path reaches back to an output it did not write.

**Known reds.** The recorded `make-sample` baseline has ten fixture-dependent failures.

| commit | rows | cause |
| --- | --- | --- |
| `3b7ab90` | 9 resolution-invariance rows (`trails`, `rgbsplit`, `scanlines`, `grain`, `bloom`, `nobloom`, `full`, `regionpush`, `regionmask`) | the synthetic sample has no depth jitter, so the fine structure those rows correlate is aliasing |
| `3b7ab90` | the crop's cull row | the same fixture |

The numbers repeat to four figures across trees — `trails` at a coarse mean of 2.732, the crop row
at 110 revealed and 314,021 lit against 410,577 released — so compare the numbers, not the pass
count. An eleventh red in section 4 is inherited state: clear the server's working project and
re-run.

## `editor-check`

The editor's controls exist, pressing them changes something, and the set of controls it has is
the set this tool knows how to drive.

```
node tools/editor-check.mjs --url http://localhost:8080 --take fixture-1g
node tools/editor-check.mjs --url http://localhost:8080 --take fixture-1g --no-render
```

| needs | |
| --- | --- |
| server | `--url`, default `http://localhost:8080` |
| take | `--take`, at least 32s, or it exits 2 naming the shortfall |
| library | four openable takes: the selected take, another clip, and two uncached takes for delayed-open checks; fewer fail a fixture assertion and skip that interaction |
| browser | a GPU browser |
| binaries | ffmpeg for section 7's real export, which `--no-render` skips |

It measures layout at three window widths. `--timeline-h` and `--tlanes-h` are the CSS custom
properties the strip's height comes from, read off the strip rather than off the root element,
because `rebuildLanes` writes the second one onto the strip itself. Sections 13 and 14 need the
state the sections before them leave. Two sweeps must never run at once, and `web/` must not be
edited under a running one.

202 controls, listed by `node tools/editor-check.mjs --mutate __enumerate__`. A mutated run is judged against the standing red set
rather than against zero, so it reports the assertions that fired beyond it and names the row a
control is required to redden — as with this one, which `syntax-check`'s own bullet control
anchors on:

- **`reveal-ignores-tracks`** — the reveal walks the clips and not their tracks, so a keyed
  parameter stays hidden.

**Known reds.**

| commit | rows | cause |
| --- | --- | --- |
| the tree carrying the projects page, `739 assertions, 2 failed` | section 4, `and never falls back to a rebuild, which is what resized the drawing buffer` — reading `1 fallbacks` | the take's duration, not the machine's load |
| the same | section 5, `and a double click on a key removes it` — reading `3 keys left` | the same |

Both rows are red on a 243.3s `fixture-1g` and green on a 91.2s one, at loads that overlap in
both directions. `fixture-1g` is a name and not a length: `npm run fixtures` builds it as eight
loops of whatever `captures/sample.knct` holds, and on a fresh clone that sample is
`make-sample`'s default 284 frames at 30fps, so the fixture is about 76s. Report a take's
duration beside its name whenever a verdict is being attributed. A run reddening only these two
is a re-run against a shorter take before it is a finding.

## `library-check`

One manifest over a directory of takes, one library spanning two machines joined by content hash,
a project that survives a round trip through a file, and the two removals doing what their names
say.

```
node tools/library-check.mjs
```

| needs | |
| --- | --- |
| ports | `--node-port` (8210) and `--mac-port`..`+16` (8211..8227), all free |
| fixture | `captures/sample.knct`, or `--capture` |
| browser | a GPU browser |

It takes no `--url` and spawns everything it needs, because its central claim is about two
machines reconciling and several of its mutations are in server code no served page reaches.
`reservePorts` asks the kernel about every port in the span before anything spawns and exits 2
naming what is held: a stranger already listening answers `/library/takes` just as well, so a
borrowed port is a green run proving nothing.

114 controls, listed by `node tools/library-check.mjs --mutate __enumerate__`.

**Known reds.** Three rows are flaky under machine contention. Two are
in the marks-on-the-scrubber section and are one race between a seek, `settled()` and the mark's
stamp, reading `0ms against source 150ms` or `934ms into 425ms`. The third is the descriptor row,
reading `real 19 against a baseline of 18`: its settle is a fixed 250ms against a collector that
takes 300ms to 1s. All three fail on unmutated trees as well as mutated ones and disagree with
themselves across runs of one tree, so a run reddening only these is a re-run and not a finding.

The fatal-log sweep matches `/Error|throw|unhandled/i`, so a checkout whose own path contains the
word reddens the sweep on every server it started.

## `boot-check`

After boot every control shows the value the registry holds for the selected clip; the document
door adopts a whole document or none; the undo stack is the session's and the file is the
document's.

```
node tools/boot-check.mjs
```

| needs | |
| --- | --- |
| port | 8391 free; `--port` moves it |
| fixture | none: it synthesises two captures into its own temporary directory |
| browser | a GPU browser |

It asks the kernel for the port first and exits 2 naming what holds it. The comparison is
registry-versus-control: in the fault the registry holds correct values and only the controls are
wrong, so a diff against declared defaults compares defaults with defaults and reports nothing.

- **`reset-before-the-panel-generator`** — the boot write lands before the panel generator fills
  its Maps, so it reaches no control and throws nothing. Reddens one row of nine.
- **`panel-does-not-follow-the-selection`** — the panel is written by value writes alone, so
  selecting a clip leaves every clip-scope control showing the previous clip.
- **`effect-rack-shows-every-effect`** — every installed package row shown on a fresh recorder.
- **`document-door-takes-a-clip-parameter-raw`** — the door normalises a block's track keys and
  copies plain values in raw, so a bad one is caught with earlier clips already written.
- **`the-door-normalises-a-parked-value`** — the falsification control for the row above: a value
  belonging to an absent effect held to a spec this build has not got.
- **`document-door-takes-a-clip-with-no-take`** — a clip naming no take is accepted, because the
  refusal sits inside the loop over clips whose footage changed.
- **`take-page-invents-a-name-to-save-under`** — the take page saves under a name nobody chose.
- **`the-save-writes-the-undo-stack`** — undo history written back into the file.
- **`the-load-arms-the-saved-stack-in-apply`** — `applyProject`'s tail reads `project.history`.
- **`the-load-arms-the-saved-stack-in-the-loader`** — the loader reads `doc.body.history`, which
  is the site that is load-bearing; only the synchronous door can see it.
- **`the-selection-guard-tests-the-object`** — the guard tests that the object is still in the
  array, so undoing a delete selects whichever clip inherited the slot.
- **`a-refused-take-stays-cached`** — a take refused for its capture format stays in `openTakes`
  reading as open.
- **`source-switch-keeps-old-colour`** — switching source leaves the previous take's colour flag.

## `monitor-check`

The monitor negotiates decimation on the live socket, the take never pays for it, and the picture
a decimated frame draws is the same scene coarser.

```
node tools/monitor-check.mjs
```

| needs | |
| --- | --- |
| port | 8341 free; `--port` moves it |
| fixture | `captures/sample.knct`, which `tools/fake-grabber.mjs` streams; a missing one reddens a row and stops the run |
| browser | a GPU browser for section 5; `--no-browser` drops it |

It spawns its own servers and needs none running. Its renderer section rebuilds the capture index
every run.

- **`decimate-reaches-recorder`** — decimation leaks into the recorder, so the take pays for a
  viewer.
- **`stride-ignored`** — the frame stride is never applied.
- **`divisor-ignored`** — the payload is sent whole whatever divisor was granted.
- **`grant-not-echoed`** — the echo is sent before the grant is recorded, so the setting on screen
  is not the one on the wire.
- **`start-never-refuses`** — `/record/start` stops refusing a costly monitor.
- **`refuse-ignores-loopback`** — the refusal fires for a loopback viewer too, which makes the
  product useless while every "it refused" row still passes.
- **`remote-default-eligible`** — a remote viewer defaults to full rate instead of the recording
  cap.
- **`accept-any-setting`** — any number is taken as a setting. A stride of 0 makes `frameSeq % 0`
  NaN and sends nothing, which reads as a dead sensor.
- **`bind-ignores-grid`** — the decimated block is copied into the texture without expansion.
- **`expand-shifts-by-a-block`** — the expansion reads one block across.
- **`colour-off-keeps-the-texture`** — a hello saying colour is off leaves `hasColor` set.

## `sensor-view-check`

The sensor-view button puts the free camera where the Kinect is, the angles come from the take's
own intrinsics, and pressing it writes nothing.

```
node tools/sensor-view-check.mjs --url http://localhost:8080
```

| needs | |
| --- | --- |
| server | `--url`, default `http://localhost:8080`, plus port 8131 for the section with its own capture |
| fixture | a capture in `captures/` for the private server on 8131; it throws naming the path without one |
| sensor | the record arm needs one; without it the tool exits 2 |
| browser | a GPU browser |

Without a sensor the record arm gets no hello and the tool exits 2, which is the sensorless
baseline. Arm C is anamorphic, so `fx` and `fy` differ and a substitution
between them is visible.

- **`fov-hardcoded`** — the vertical angle becomes a constant, which is right for this rig, so
  only the synthetic arms see it.
- **`tanv-uses-fx`** — the vertical half-angle taken off `fx` rather than `fy`, the one
  substitution a square sensor would hide.
- **`keyframes-on-every-surface`** — the key button is built whether or not the surface is the
  editor. It must redden the recorder rows alone.
- **`no-repaint`** — the button moves the camera and asks for no repaint.
- **`sensor-view-keys-camera`** — the button writes a camera key as well as moving the view, so
  looking at the intrinsics becomes an edit to the clip.

## `level-check`

Levelling rotates the room into its own frame, and the crop, the region, the top-down and the
sensor view all keep their meaning.

```
node tools/level-check.mjs
```

| needs | |
| --- | --- |
| port | 8377 free; `--port` moves it |
| fixture | none: the frames are planted along each pixel's own ray |
| browser | a GPU browser; without one it exits 2 |

Two of its five claims are invariants: rotating the world and the camera by the same quaternion is
a no-op, so the two pictures have to be bit-identical. Section 3 is measured two-sided, because a
one-sided "it changed" row passes on any change at all.

- **`tilt-ignored`** — the parameters are stored and drawn on their sliders and never reach the
  cloud. Section 1's control, because every comparison below it passes on a build that draws the
  same picture twice.
- **`crop-follows-tilt`** — the crop moves to the far side of the levelling, so the six faces stop
  being a place in the room.
- **`plan-box-ignores-tilt`** — the top-down draws the crop box straight off the uniforms, in the
  sensor's axes, over a cloud in the room's.
- **`plan-ignores-tilt`** — the picture levels and the box in the corner does not.
- **`crop-switch-reaches-only-the-shader`** — the switch reaches the shader and stops, so the
  top-down goes on culling what the picture shows in full.
- **`plan-skips-vertical-crop`** — the plan culls on x alone, so discarded points reappear inside
  the footprint once levelling turns sensor y into its axes.
- **`sensor-view-ignores-tilt`** — the sensor view keeps navigation's pole, so the one button
  meaning "exactly what the sensor shot" shows a rolled picture.
- **`reset-keeps-roll`** — the reset takes tilt to neutral and leaves roll behind.
- **`region-follows-tilt`** — the region is read after the model rotation instead of on the
  undisplaced position.
- **`level-order-swapped`** — the pair composed `Rz(roll) * Rx(tilt)`, which only the two-sided
  reading of a plane planted at 27 degrees of roll catches.
- **`x-not-mirrored`** — the shader goes back to a faithful port of `Registration::getPointXYZ`,
  so the cloud is a reflection of the room.
- **`plan-x-not-mirrored`** — the sign is fixed in the shader and the top-down keeps the old one.

## `vcam-check`

The webcam output serves the colour camera, and the take never learns about it.

```
node tools/vcam-check.mjs
```

| needs | |
| --- | --- |
| port | 8361 free; `--port` moves it |
| fixture | `captures/sample.knct`, which `tools/fake-grabber.mjs --hd` streams; without it the tool exits 2 naming the path |
| browser | a GPU browser for section 5; `--no-browser` drops it |
| binaries | ffmpeg, which builds and decodes the fixture |
| network | a non-internal IPv4 for section 6, or it exits 2 as unproven |

The discriminator is geometric rather than perceptual: the colour camera sees 84.1 degrees where
the registered frustum sees 70.6, and the fixture plants a magenta left margin and a cyan right one
in the difference, which no upscale can invent.

- **`pose-skips-the-registry`** — the camera pose in a socket patch bypasses the registry, so four
  finite numbers are drawn as a rotation.
- **`patch-params-applied-one-at-a-time`** — the parameter half lands name by name, so a refused
  name keeps the rest and the source draws half a patch.
- **`hd-upscales-registered`** — the endpoint serves the registered colour scaled to 1080p, which
  is the plausible wrong implementation.
- **`hd-reencodes-in-flight`** — the colour payload decoded and re-encoded at the same size, so
  every geometric row passes and only the bytes differ.
- **`hd-reaches-recorder`** — the colour message reaches the recorder, so the take carries a third
  message type and its content hash moves.
- **`refusal-ignores-webcam`** — the refusal loses its webcam clause, so a take starts while a
  full-rate MJPEG pull competes with the depth packets.

## `guard-check`

A socket is held to the same origin rule the mutating routes stand behind, and nothing is on the
network unless somebody typed a flag saying so.

```
node tools/guard-check.mjs
```

| needs | |
| --- | --- |
| port | 8321 free; `--port` moves it |
| fixture | `captures/sample.knct`, served with `--replay`; the read rows ask for `/capture/sample/...` |
| network | a non-internal IPv4, or the bind half is unproven and it exits 2 |

It spawns its own servers and needs none running. Every refusal row has a positive twin, so a
server that refused every upgrade fails.

- **`reads-answer-any-page`** — the reads a cross-origin `<img>` can start, which `originAllowed`
  cannot see: an `<img>` sends no Origin, so the header that separates it from the capture node is
  `sec-fetch-site`.
- **`upgrade-skips-origin`** — the upgrade stops checking the origin at all.
- **`listen-any-host`** — the default bind becomes `0.0.0.0`.
- **`origin-ignores-scheme`** — a parsed origin host compared against a raw Host string.
- **`host-parsed-loosely`** — the authority-shape check goes, which is the hole the scheme fix
  opened.
- **`host-accepts-a-name`** — the rebinding rule compares the two headers against each other,
  which a rebound browser satisfies by construction.
- **`origin-allows-null`** — the literal string `null`, which a `file://` page and a sandboxed
  iframe both send, is treated as same-origin.

## `jobs-check`

The queue only hands a job to a machine that can reproduce it, and a job carries enough to be
reproduced at all.

```
node tools/jobs-check.mjs
```

| needs | |
| --- | --- |
| ports | 8231, and 8232 for the forwarding proxy; `--port` and `--proxy-port` move them |
| fixture | `captures/sample.knct` via `--source`, plus a 60-frame take it synthesises |
| browser | a GPU browser |
| binaries | ffprobe |

Its server runs out of `.jobs-check/root`, a staged tree it deletes on the way out, so the store
roots the flags default to never resolve into the checkout. The worker under test is the staged
copy of `server/`, not the repo's, and it reads its renderer class out of the browser it will
render in. Some mutations are queue semantics and take `--no-render`; others need the render
block, so reading every mutation run as `--no-render` is wrong.

- **`claim-ignores-renderer`** — `rendererMatches` returns true for every pairing, so a job pinned
  to one renderer class is handed to any worker.
- **`claim-hides-blocked`** — a claim with nothing to hand out returns an empty blocked list and a
  queue length of 0, so a job nobody can take reads as no job at all.
- **`enqueue-accepts-any-capture`** — the caller's capture list is never held to the content-hash
  rule, so a take id reaches the queue.
- **`envelope-takes-the-callers-captures`** — the footage a job renders comes from the caller's
  list instead of being derived from the clips.
- **`worker-reads-any-job-version`** — the worker's gate on the job envelope's version goes.
- **`worker-preflights-only-the-first-capture`** — the worker asks its library about the first
  hash a job names instead of every one.
- **`attestation-passes-on-a-mismatch`** — the worker stops comparing what the page opened against
  what the job named.
- **`finish-accepts-any-state`** — the finish drops both its state test and its lease-shape test,
  so a report lands on a job that is already terminal.
- **`transitions-not-serialised`** — the transition gate stops chaining, so two transitions run
  against one record at once.
- **`jobs-serve-lease`** — the job listing stops stripping the lease, so `GET /jobs` hands out the
  token that authorises a finish.
- **`lease-optional-when-absent`** — the finish's lease-shape test goes, so a job carrying no
  lease string is finished without one.
- **`finish-ignores-lease`** — the finish stops comparing the lease it was given with the job's.
- **`requeue-refuses-all-running`** — every running job reads as still alive, so the requeue never
  reclaims one whose worker is gone.
- **`heartbeat-ignores-lease`** — the heartbeat's lease comparison goes, so another claim's beat
  renews the job.
- **`heartbeat-stops-on-first-error`** — the worker stops beating on the first failed beat instead
  of reporting a missed one.
- **`static-serves-nothing`** — the static route throws after its `stat`, so the worker's page
  never loads.
- **`requeue-clears-renderer`** — the requeue nulls `job.renderer` as well as the claim, so the
  pin is lost.
- **`codec-read-through-prototype`** — the codec lookup drops `Object.hasOwn`, so an inherited
  name passes validation.
- **`worker-door-waved-open`** — the worker's door on an effect it has not got. It reddens the
  reason and leaves the state row green.
- **`envelope-takes-the-callers-requires`** — the effects a job needs come from a field beside the
  document instead of from it.
- **`envelope-trusts-the-documents-requires`** — the same lie one field in, with
  `project.requires` copied whole.
- **`envelope-takes-a-repeated-requires-id`** — one id claimed twice, which a membership test and
  a set test both read as claimed once.
- **`queue-takes-any-requires-shape`** — the list is taken if it happens to be an array and no
  entry is asked what it is.
- **`preflight-snapshot-is-taken-once`** — the worker's `/effects` read is memoised, so an install
  landing mid-run is invisible.
- **`preflight-asks-once`** — the retry budget is cut to one attempt, covering both of the
  worker's store readings.
- **`preflight-reads-a-failure-as-an-empty-store`** — the status, shape and entry checks come off
  that read, leaving `?? []` where they were.

## `effect-check`

Installing an effect: the store's revisions, the door a package has to get through, and what
happens on a page that is already up when one lands.

```
node tools/effect-check.mjs
```

| needs | |
| --- | --- |
| port | 8281 free; `--port` moves it |
| fixture | none: no capture, no sensor, no ffmpeg |
| browser | a GPU browser |

It hands its staged server both store roots by name rather than letting them resolve, so a run
cannot leave fixtures in `effects/`. It asks the kernel for the port first and exits 2 naming what
holds it. Section 11 restarts the server and closes the browser first.

42 controls, listed by `node tools/effect-check.mjs --mutate __enumerate__`. What they all test is a page that will not boot: a
package is GLSL spliced into two programs and a table of parameters spliced into the registry,
both assembled while `web/main.js` is still evaluating, so a package that does not assemble fails
the *next* page load rather than its own install.

## `effect-conformance-check`

Every installed effect draws nothing at all when it is off.

```
node tools/effect-conformance-check.mjs --url http://localhost:8080
node tools/effect-conformance-check.mjs --mutate leaks-at-zero
```

| needs | |
| --- | --- |
| server | `--url`, default `http://localhost:8080` |
| browser | a GPU browser |

Three renders per package — the defaults, the master at zero with everything the manifest gates
raised, and the package served hollow — must be the same image byte for byte, and a fourth with
the package's own parameters raised must differ. The population comes off `GET /effects`, so a
seventeenth package is asked by existing.

- **`leaks-at-zero`** — a floor under the rain's master, so the package contributes at the term it
  is meant to be absent at. It is served over an interception rather than written, because this
  tool runs against a server somebody else started, and it reddens exactly one row: rain's drop
  equality. It is declared as a function rather than an anchored edit, so it carries no `fails:`
  field and this line is its description.

Two of `syntax-check`'s own controls anchor on the invocation above, one on the mutation name and
one on the whole command. Move or delete that line and both stop being able to run, which the
`anchors/` row reports.

## `module-check`

The boundaries in `web/`: the import graph has no cycle, every import names a file this server can
serve and a binding that file exports, mutable state crosses a boundary as a live `let` or a
setter rather than as an object anybody may write into, and a name crosses only because both ends
wanted it.

```
node tools/module-check.mjs
node tools/module-check.mjs --root <dir>
```

| needs | |
| --- | --- |
| everything | nothing at all: no port, no server, no browser, no install |

It needs nothing because every failure it is about is a failure to boot, and an instrument that
needs the page running cannot see one. Rule 4 reads the whole checkout, so four of its mutations
land outside `web/`.

It does not test the intra-module dead zone, and the run says so in its own output. Its use
question asks about a name, not a scope, so a method written in shorthand, `{ name(gl) { … } }`
with no dot in front of it, reads as a use of any import of the same name. `gpuTimer.poll` in
`web/main.js` is that shape. The miss is a false negative: a dead import this row does not find.

- **`cycle-planted`** — a side-effect import closing a cycle, so only the cycle row can redden.
- **`cycle-through-a-second-spelling`** — the same cycle through a second path spelling.
- **`import-of-a-missing-file`** — an import naming a file that is not there.
- **`import-names-a-missing-export`** — an import naming a binding the file does not export.
- **`one-spelling-for-every-module`** — one module reached under two spellings.
- **`exported-mutable-object`** — state exported as an object anybody can write into.
- **`imported-object-written-across-the-boundary`** — a write into somebody else's imported object.
- **`state-crosses-as-a-live-let`** — the shape rule's other form.
- **`state-crosses-as-a-default`** — and the same through a default export.
- **`export-form-nothing-claims`** — an export in a form no rule claims.
- **`a-barrel-re-export`** — a re-export hiding which module owns a name.
- **`write-through-a-namespace`** — a write through a namespace import.
- **`write-through-a-rename`** — the same through a renamed binding.
- **`write-from-a-page`** — a page writing into an imported binding.
- **`exemption-outlives-its-export`** — an exemption whose export is gone.
- **`exemption-covers-nothing`** — an exemption promoted to a shape it no longer covers.
- **`import-nothing-uses`** — an imported name the file never reads.
- **`import-used-under-its-far-side-name`** — an aliased import read under the wrong name.
- **`export-nothing-imports`** — an exported name nothing imports.
- **`consumer-outside-web-drops-the-name`** — a consumer outside `web/` stops reading a name.
- **`dead-import-is-not-a-consumer`** — the same the other way: the import stays, its reader stops.
- **`outside-consumer-imports-a-name-it-never-reads`** — an outside file importing a dead name.
- **`dead-bare-import`** — a bare import nothing needs.
- **`import-used-only-in-a-string`** — a name appearing only inside a string.
- **`import-used-only-as-an-object-key`** — a name appearing only as an object-literal key.
- **`namespace-hides-a-dead-export`** — a namespace import making a dead export look read.
- **`namespace-reach-cannot-be-named`** — the reach a namespace import cannot be pinned to.

## `syntax-check`

Every shipped JavaScript file parses, the constants the two languages cannot share agree, the
citations resolve, and every tool is named in `CLAUDE.md`.

```
node tools/syntax-check.mjs
node tools/syntax-check.mjs --root <dir>
```

| needs | |
| --- | --- |
| everything | nothing at all |

It refuses to pass on finding no files. It walks every `docs/*.md` and `web/….js` path this
repo's prose and source cite, across the whole tree minus what `.gitignore` excludes, and fails on
one that does not resolve; a `file:line` form fails when the file has fewer lines than the
citation names. A path is checked for resolving and never for being right, so cite a function by
name.

- **`spec-drifts`** — the `.knct` decoder specification disagrees with the module it specifies.
- **`shell-id-renamed`** — a shell id the page draws is renamed out from under the markup.
- **`shell-key-undeclared`** — a shell key the page reads is not declared.
- **`web-citation-outlives-its-module`** — prose citing a `web/` module that is not there.
- **`line-citation-past-the-end`** — a citation naming a line past the end of its file.
- **`manifest-does-not-parse`** — a shipped effect manifest that does not parse.
- **`anchor-in-dead-fallback`** — a shader anchor matching its file once while sitting in a slot's
  fallback, a second copy of the shipped text that nothing compiles.
- **`anchor-duplicated-into-a-second-chunk`** — one anchor over two sites in the assembled text,
  where the edit reaches one and the count reads whole.
- **`anchor-duplicated-into-a-second-program`** — the same duplicate in the *other* program, which
  says the count sums over every assembled string rather than asking each one alone.
- **`citation-outside-the-prose`** — a citation in source rather than prose that no longer
  resolves.
- **`doc-invokes-an-undeclared-mutation`** — a `--mutate` this page offers that no tool's table
  declares, which is a run nobody can make listed as one anybody can.
- **`doc-lists-a-mutation-under-the-wrong-tool`** — one listed under a tool that does not declare
  it, which the row above cannot see because the name resolves somewhere.
- **`doc-bullets-an-undeclared-mutation`** — the other form this page offers a control in, a
  bullet naming one nothing declares.
- **`doc-line-ends-in-whitespace`** — a prose line ending in a space, which is invisible on the
  page and invisible to a clean `git diff --check`.

## `cpp-check`

Both C++ files parse and typecheck, in all four combinations of the two macros `native/grabber.cpp`
branches on.

```
node tools/cpp-check.mjs
```

| needs | |
| --- | --- |
| binaries | a C++ compiler and turbojpeg's headers |
| everything else | no sensor, no prefix, no libfreenect2 build |

It parses and typechecks; it does not link and it does not run, so a call to a function present in
the headers and absent from the library is as green here as a correct one. What it closes is that
`native/grabber.cpp` — the only writer of the one artifact in this program that cannot be shot
again — had no compile gate.

- **`grabber-syntax-error`** — a token-level break in the grabber.
- **`grabber-type-error`** — a wrong argument type, which is the row saying this is a semantic
  pass and not a tokeniser.
- **`opencl-branch-broken`** — a break inside the OpenCL `#ifdef` arm.
- **`opengl-branch-broken`** — a break inside the Pi's arm, which is why the matrix exists: a gate
  parsing one configuration reports this green. It reddens 2 of the 4 grabber rows.
- **`harness-syntax-error`** — a break in `native/harness/reg-runner.cpp`.

## `vendor-check`

`third_party/libfreenect2` is upstream v0.2.1 plus exactly the declared edits.

```
node tools/vendor-check.mjs
```

| needs | |
| --- | --- |
| everything | nothing; only files in this repo |
| optional | `vendor/prefix` for the artifact rows, or they are unproven and it exits 2 |

Each declared edit pins the blob hash the patched file must have, because "differs from upstream"
is not "contains our change". A declared edit that has quietly reverted fails too: that is what a
careless re-vendor looks like. Its mutations are delivered as functions over a staged tree rather
than as anchored text.

- **`undeclared-edit`** — an edit nothing declares.
- **`revert-local-edit`** — a declared edit quietly put back to upstream.
- **`extra-file`** — a file upstream does not have.
- **`missing-file`** — a file upstream has and this tree does not.
- **`oracle-drift`** — the pristine upstream copy edited, so the comparison is against the wrong
  thing.
- **`stale-prefix`** — the artifact rows pointed at a prefix from an earlier build.

## `registration-check`

Our `Registration::apply` equals upstream's, bit for bit, on identical corpus input.

```
node tools/registration-check.mjs
node tools/registration-check.mjs --corpus captures/reg-corpus
```

| needs | |
| --- | --- |
| fixture | a corpus from `grabber --dump-corpus`, default `captures/reg-corpus` |
| binaries | cmake and a C++ compiler |
| sensor | none; the corpus was captured with one |

It builds both sides every run — a pristine upstream prefix and ours — because nothing about a
stale oracle prefix looks wrong. The comparison is an exact differing-element count, since one
wrong pixel in 217,088 is a mean around 1e-5. Build and tooling failures exit 2 and never 1, so
exit 1 here means that assertions fired, that a mutation was `NOT CAUGHT`, or that both runners
linked the same prefix, which is refused before any assertion. Read the line, not the code.

- **`filter-tolerance`** — the occlusion filter's tolerance moved by a thousandth.
- **`filter-width`** — the filter's half-width halved.
- **`filter-never-rejects`** — the occlusion test never rejects. It mutates the decision rather
  than the allocation, which segfaults.
- **`band-off-by-one`** — the threaded banding off by one, so a window straddling two threads'
  ranges is written by neither, or twice.
- **`depth-one-mm`** — one depth sample moved by a millimetre.
- **`one-lsb`** — one pixel, one least-significant bit: the comparator's sensitivity floor. It
  counts surviving pixels rather than flipping a fixed index, which can land in a dead zone.

`--mutate filter-never-rejects` also reports what fraction of pixels the filter rejects, which is
how corpus coverage is measured. `captures/` is gitignored, so a corpus is per rig: the 72-frame
one on this rig sits at 6.93%, and a capture of one static-ish scene managed 6.55%. Aim above the
first figure.

## Fixtures and the registration corpus

`captures/` is gitignored: the generators are committed and the artifacts are not. A fresh clone
has no capture at all.

```
npm run fixtures
node tools/make-sample.mjs captures/sample.knct
node tools/make-fixture.js captures/sample.knct captures/fixture-1g.knct --loops 8
```

`npm run fixtures` is those two commands with `--if-missing` on the first.

**`make-sample` refuses to overwrite an existing capture**, because the path it runs at is where a
machine with a sensor keeps real footage. Bare, it refuses and names the size and date of what it
declined to destroy. `--force` replaces. `--if-missing` leaves an existing one alone and exits 0.
It also takes `--frames`, `--fps` and `--quality`. It writes to a temporary path and renames, so a
run interrupted halfway leaves nothing for the next `--if-missing` to adopt.

`make-fixture.js` loops one short capture into a longer one. `--loops N` or `--minutes M` sets the
length; bare it loops 32 times. Every frame carries real depth and a real JPEG, and only the u64
timestamp at payload offset 8 moves, advancing across the seam by the median gap so the loop point
is not a discontinuity the index trips on.

**Size fixtures by frame count, never by duration.** A capture's frame rate is a property of the
link it was shot over, so two takes of one duration hold different numbers of frames and different
byte counts. Read the frame count off the file and size against that.

**`make-sample` produces a stand-in and not footage.** There is no depth jitter, no confidence
gate chattering on a flat wall, no dropped frames and no colour camera halving its rate in dim
light, so anything measuring those needs the sensor. It is deterministic — same arguments,
byte-identical file — and takes about 14s for 284 frames. Say which sample a number came from.

**The registration corpus is gitignored like every other capture.** Regenerate it with the sensor
attached, and vary the scene while it runs — a hand near the lens, a person against a far wall,
something occluding something further — because the occlusion filter only does work at depth
discontinuities:

```
./native/build/grabber --dump-corpus captures/reg-corpus --dump-count 40 --dump-every 45
```

`tools/fake-grabber.mjs` stands in for the sensor when a tool needs a live stream. It honours
`--no-color` and `--no-low-light`, rewriting each payload at load so the declared lengths still
describe it. `--pipeline`, `--log`, `--quality`, `--min-depth` and `--max-depth` are accepted and
ignored, and anything else gets one line on stderr and is not refused.

## The supply-chain gate

`release-gate-check` proves this repo's gate is armed: that `.npmrc` names a minimum release age,
and that the npm doing the installing actually refuses on it.

```
node tools/release-gate-check.mjs
```

| needs | |
| --- | --- |
| network | the npm registry |
| binaries | npm; CI pins `npm@12.0.2` in the gate job |

The setting is `min-release-age=2` in `.npmrc`, and **the unit is days as a plain integer**. Other
package managers in this family take minutes or seconds, which is how a wrong number gets written
here. A duration string like `2d` stops the install with `Invalid time value` rather than
proceeding ungated; the dangerous values are the ones npm accepts and nobody meant, since `0` puts
the cutoff at this instant and `-1` puts it tomorrow, and neither warns.

**Do not verify the gate with `npm config get before` or `npm config get min-release-age`.** The
first answers a date on npm 11.12.1 and `null` on 11.16.0 and 12.0.2 while the gate is enforced
identically; the second reads back null whether the file took effect or not. This tool asks npm to
resolve a package and reads the cutoff out of the refusal instead, and it runs the same query in a
directory with no `.npmrc` to prove the cutoff came from the file under test.

- **`wrong-unit`** — `min-release-age=2d`, a value npm cannot parse.
- **`no-gate`** — an `.npmrc` naming no gate.
- **`absent`** — no `.npmrc` at all, so a contributor cloning the tree inherits nothing.
