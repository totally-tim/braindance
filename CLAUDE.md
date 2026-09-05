# Working in this repo

**The shipped program is the design.** There was a design document and a set of HTML studies,
and they were deleted when the thing they described was finished and working — a drawing of a
surface that now exists is a second representation that can only drift out of step with the
first. `README.md` carries the usage path. Three pages beside it carry what survived of the
design: `docs/architecture.md` (the four surfaces, program time, the wire format),
`docs/reference.md` (the command line, the controls, the readings, presets) and
`docs/performance.md` (the measurements and the negative results worth not re-deriving). The
reasoning lives where it is enforced — in the proof tools, and in short comments where the code
alone would mislead.

**Comments are short. The prose pages carry the long form.** This repo spent a period writing
essays in its source and reached 44,000 comment lines against 47,000 of code; that is not a
design record, it is a second document nobody reads that drifts from the first. A measurement,
a failure that shipped twice, an argument for one design over another — those go in the page
under `docs/` that already covers the surface, in one or two sentences. What stays in the source
is the line that stops the next reader making a specific mistake.

**When reality disagrees with an intention, report the contradiction rather than silently
redesigning.** That has happened repeatedly and reporting was the right move every time.

## Working with the person who asked

- **Write plainly.** Short sentences, ordinary words, no term the reader did not use first.
- **Less is more in the interface.** Controls and labels must explain themselves. Do not add
  taglines, helper captions, onboarding copy or modal prose that repeats what the surface already
  says. Keep text for live state, values, errors, accessibility and consequences the controls
  cannot show, especially destructive ones.
- **Surface open questions instead of implementing one reading of them.** An ambiguous
  requirement gets a question with concrete options, asked before the work rather than explained
  after it. Guessing costs a rewrite and asking costs a minute.
- **No slop.** No emojis anywhere — console output, commits, comments, messages. No filler, no
  restating the request back, no recap of what you just said. Say what changed, what it cost, and
  what you did not do.

## Before you commit

**A contribution is proven working code, and code on its own is not.** "Your job is to deliver
code you have proven to work" —
[Simon Willison](https://simonwillison.net/2025/Dec/18/code-proven-to-work/). A thousand-line
patch costs a minute to produce and an hour to read, so the proving is the part that carries the
value, and a change that only happens to work is luck. Work an agent produced gets *more*
scrutiny than a hand-written change rather than less: one pass is rarely enough, and the name on
the commit is yours either way.

- **Every feature gets a full end-to-end run before it is committed.** Drive the real surface a
  person touches — `playwright-cli` for the browser, the proof tool for the thing it proves — and
  watch the change happen. A passing unit test is not a rendered frame, a `curl` is not a click,
  and "the code looks right" is not evidence.
- **An automated test you have not watched fail is not a test.** Write the test for the thing you
  just did by hand, then revert the change and watch it go red before putting the change back.
  That is rule 1 of "Writing a check" — a falsification control — asked of an ordinary test as
  well as of a proof tool.
- **Say what happens off the happy path.** Name the inputs outside it — the empty one, the
  malformed one, the worst one — and either handle them or say in one line what they do. An edge
  nobody named is an edge nobody tested.
- **Run the checks your change is under**: `node tools/syntax-check.mjs` for anything at all,
  `npm run test:unit`, and the proof tools covering the surface you touched.
- **Report what actually ran** — which tools, which rows, which numbers. A check you skipped is a
  check you say out loud you skipped.

Then four questions, and a "not sure" to any of them means it is not ready: have you watched this
work, would the naming still read honestly to someone in six months, did you test the edges, and
could you walk the person who asked through the change end to end? Speed without quality is
negative value — a sloppy change spends more of a reviewer's time than it saved of yours, and it
goes on spending.

## What not to build

- **One implementation only.** No legacy path left beside a new one, no compatibility flag to
  switch between them. A second path drifts, and the drift is the failure this design keeps
  rejecting.
- **No backwards migrations and no compatibility shims.** A capture this build cannot read is
  refused at the door with a reason, not adapted. Adding a reader for last year's format is
  adding a second implementation with extra steps.
- **No new documents.** `README.md` and the six pages under `docs/` are the whole prose surface.
  A lesson learned in a session goes beside its neighbours in one of those; it does not get a
  page of its own, and it does not come back here.
- **No temporary files in the checkout.** Scratch scripts, dumps, probe output and working notes
  live in the session scratchpad. `captures/` is gitignored and holds captures, nothing else.

## Where the rest of this lives

Each of these has a condition attached rather than an invitation:

- **`docs/instruments.md`** — read before writing or modifying any proof tool. Every way a check
  here has claimed a property it was not testing.
- **`docs/measurement.md`** — read before reporting a number. Which runs get thrown away, and the
  rig's two pieces of hardware that read differently from how they measure.
- **`docs/proof-tools.md`** — read before running or editing a specific tool. The full invocation
  list, every `--mutate` control, what each tool needs, its exit codes and its fixtures.

**New lessons go in those files, not in this one.** This file gains a line only if an agent would
get the *next* task wrong without it. The version that absorbed everything reached 814 lines and
stopped being read.

The chain is enforced rather than trusted. `syntax-check` walks every `docs/*.md` and `web/….js`
path this repo's prose and source cite — across the whole tree minus what `.gitignore` declares
this repo does not ship — and fails on one that does not resolve; a `file:line` form fails when
the file has fewer lines than the citation names. **Cite a function by name rather than by a
line**: a path is checked for resolving and never for being *right*, so a line that has drifted
into the middle of something else passes here.

## Measurement culture

This repo measures rather than reasons. Several inherited estimates turned out ~40% wrong when
finally profiled — `Registration::apply` was carried as 4.5ms against a measured 6.3 — and the
corrections are recorded beside the numbers rather than replacing them silently.

- **"This should be faster" is not evidence.** Measure it.
- **Interleaved A/B, never sequential before/after.** A sequential comparison on this rig once
  produced a 23% figure that was really 12.9%.
- **State the method with every number**: window length, sample count, warmup discarded, and
  whether the page cache was warm.
- **Read a health number the measurement itself reports, and throw the run away when it is
  wrong.** Delivered fps is that number for anything using the grabber — a run that does not
  sustain ~30.0 was competing for the machine and its per-segment timings are noise.
- **An offline harness is for correctness; `grabber --profile` on the sensor is for cost.** A
  screening measurement that removes the effect will confidently report its absence.
- **Size fixtures by frame count, never by duration.** The sample was shot on a degraded link at
  about 9.3fps.

## Writing a check

The five rules that survive out of context. `docs/instruments.md` carries the case file for each,
and there is one for each because every rule was learned by shipping the mistake.

1. **An instrument must enforce its claims, not assert them.** Ask what a broken implementation
   would have to do to still pass, and close that. **Every proof tool needs a falsification
   control**: something that must FAIL if the thing under test were not doing the work.
2. **Mutation-test the instrument rather than reasoning about it.** Report which mutations you ran
   and what each caught. Before believing a mutation was *missed*, confirm the mutation did
   something; before believing one was *caught*, confirm it was caught for the reason claimed.
3. **Count failed assertions, never exit codes, and read which assertions fired.** The tools
   disagree about what a caught mutation exits and the disagreement runs the dangerous way. A run
   with zero failed assertions and a non-zero exit is a crash to investigate, not a catch to
   record.
4. **Place a probe where its answer would be different, not where it is convenient** — and ask
   what all of your probes agree about, because a set of arms that agree on a quantity cannot
   measure it however many of them there are.
5. **Ask whether there is an object here that every observation happens to skip**, and be most
   suspicious where the skipping was deliberate: a deliberate exclusion comes with a justification
   that stops anybody looking twice. This has cost three separate holes.

**Close the class, not the instance.** Fixing the six routes that were found leaves the seventh
outside the list; making the route table *be* the dispatch and having the check walk it means a
route added later is asked by existing.

**Before believing a proof tool caught your change, re-run the baseline in the conditions the
failure happened in**, not the conditions the baseline happened in. A contended machine makes a
check fail in ways that read as a finding — that cost five reproductions against an innocent
change.

## Proof tools

`docs/proof-tools.md` carries the invocation list: how to run each tool, every `--mutate` control
it must fail under, and what it needs before it will run. Read the assertion count and never the
exit code (rule 3).

| tool | what it proves | what it needs |
| --- | --- | --- |
| `determinism-check.mjs` | same program time, same image | a capture |
| `index-check.mjs` | the index, the hash, the frame API | `--url`, and a fixture past 2 GiB |
| `registry-check.mjs` | one registry, sliders as views of it, every look term live | `--url` |
| `timeline-check.mjs` | seek equals playback | `--url`, a take of ≥12s |
| `keyframe-check.mjs` | tracks, the retime curve, undo | `--url`, a take of ≥24s |
| `export-check.mjs` | resolution, export, the file | `--url`, ffmpeg and ffprobe |
| `editor-check.mjs` | the editor's controls exist, and pressing them changes something | `--url`, a take of ≥32s |
| `library-check.mjs` | the library, the recorder, the routes | a free port span |
| `boot-check.mjs` | after boot, every control shows the value the registry holds for the selected clip; the document door adopts a whole document or none; the undo stack is the session's and the file is the document's | port 8391 free |
| `monitor-check.mjs` | the monitor's decimation, the take it must not touch, the picture | port 8341 free |
| `sensor-view-check.mjs` | the intrinsics a take was shot with, against a build assuming them | `--url`, plus port 8131 |
| `level-check.mjs` | levelling: the room turns and every surface keeps its meaning | port 8377 free |
| `vcam-check.mjs` | the output to OBS: the colour camera, the keyed webcam and its page, and the take neither may touch | port 8361 free |
| `guard-check.mjs` | the socket's origin rule, the bind, the rebinding rule | port 8321 free |
| `jobs-check.mjs` | the queue, the pin, a real render, a job this build cannot read | ports 8231 and 8232, a GPU browser, ffprobe |
| `effect-check.mjs` | installing an effect: revisions, the door, the hotload, park and restore | port 8281 free, a GPU browser |
| `effect-conformance-check.mjs` | every installed effect draws nothing at all when it is off | `--url`, a GPU browser |
| `module-check.mjs` | the boundaries in `web/`: the import graph, what crosses it | nothing |
| `syntax-check.mjs` | every shipped file parses, the cross-language constants agree, the citations resolve, every tool is named here | nothing |
| `hd-encoder-check.mjs` | native pairing under encoder backlog, held colour, key range and RGBX | a C++ compiler and TurboJPEG |
| `cpp-check.mjs` | both C++ files parse and typecheck, in all four pipeline configurations | a C++ compiler and turbojpeg's headers |
| `vendor-check.mjs` | `third_party` is upstream v0.2.1 plus declared edits | nothing |
| `registration-check.mjs` | our registration equals upstream's, bit for bit | a corpus from `grabber --dump-corpus` |
| `release-gate-check.mjs` | the `.npmrc` supply-chain gate is actually armed | the npm registry |

**Eight spawn their own server, so what they need is a free port rather than a running one** —
`guard-check` on 8321, `jobs-check` on 8231 *and 8232*, `effect-check` on 8281, `level-check` on 8377,
`monitor-check` on 8341, `vcam-check` on 8361, `boot-check` on 8391, and `library-check` across
`--node-port` and `--mac-port`..`+16`, which default to 8210 and 8211..8227. The distinction is not bookkeeping: a
tool that finds a stranger already listening on its port is answered by the stranger and asserts
against whatever fixture *that* process staged, which is a green run proving nothing.
`index-check` is a ninth under `--stage` or `--mutate` only, on 8251: a mutation edits the
server's own `server/capture.js`, so a mutated run cannot borrow the server at `--url`.
`library-check`, `boot-check`, `effect-check` and `index-check` ask the kernel first and exit 2
naming what is held; everywhere else check `pgrep -f "tools/.*-check.mjs"` yourself, because
another agent's run is the normal state on this machine. **Two tools write packages, and each keeps its user root off
the checkout by a different mechanism** — a run whose user root resolved to the checkout would
leave its fixtures in `effects/`. `effect-check` hands its staged server both store roots by name
rather than letting them resolve; `jobs-check` forks one shipped package to move the store between
two claims, and its server is spawned out of `.jobs-check/root`, so the root the flags default to
is the staged tree it deletes on the way out. Anything that grows a third writer picks one of
those and says which. `sensor-view-check` does both — `--url` for most of its run, and a private
server on 8131 for the section needing its own capture.

**`module-check` needs nothing at all** — no port, no browser, no install — because every failure
it is about is a failure to *boot*, and an instrument that needs the page running cannot see one.
It reads `web/` off disk and refuses an import cycle, an import naming a file or an exported name
that is not there, state crossing a boundary as an object anybody can write into, or a name
crossing one that only one end wanted. What it does not test is the intra-module dead zone —
which is the fault `web/main.js` has actually shipped twice. That reach runs through property
dispatch and is not statically decidable, so it belongs to a post-boot state diff rather than to
a source scan, and the tool says so in its own output rather than leaving it to be assumed.

**`cpp-check` parses and typechecks; it does not link and it does not run**, so a call to a
function present in the headers and absent from the library is as green here as a correct one.
What it closes is that `native/grabber.cpp` — the only writer of the one artifact in this program
that cannot be shot again — had no compile gate of any kind.

**The other eleven tools in `tools/`**, listed because a tool nobody documented is a tool nobody
runs. `syntax-check` enforces the list: anything in `tools/` this file does not name fails it, so
a tool added next year is asked by existing.

```
node tools/build-native.mjs        # builds libfreenect2 into vendor/prefix, then the grabber
node tools/fake-grabber.mjs        # a grabber that needs no sensor, for driving the server
node tools/make-sample.mjs         # a synthetic capture, so a clone with no Kinect has one to loop
node tools/make-fixture.js         # loops one short capture into an arbitrarily long one
node tools/sweep-all.mjs           # every mutation of four tools; needs a server and hours
node tools/settle-probe.mjs        # does settle()'s drain scale with the take or the ceiling
node tools/prof-summary.mjs        # reads grabber --profile output, flags contended runs
node tools/render-worker.mjs       # renders one queued job; jobs-check drives it
node tools/layering-ab.mjs         # what a second, third and fourth overlapping clip cost
tools/monitor-cost-ab.mjs          # the monitor's cost on a capture node, over SSH
tools/pi-registration-ab.sh        # the threading A/B runbook for a capture node
```

**Fixtures.** `captures/` is gitignored and `npm run fixtures` builds what the suite needs:

```
node tools/make-sample.mjs captures/sample.knct
node tools/make-fixture.js captures/sample.knct captures/fixture-1g.knct --loops 8
```

`make-sample` synthesises a capture with no sensor and no ffmpeg, and it is **a stand-in rather
than footage** — no depth jitter, no confidence gate chattering on a flat wall, no dropped frames
— so say which sample a number came from. **It refuses to overwrite an existing capture**, because
the path it runs at is where a machine with a sensor keeps real footage: bare refuses and names
the size and date of what it declined to destroy, `--force` replaces, `--if-missing` leaves an
existing one alone and exits 0. `timeline-check`, `editor-check` and `keyframe-check` exit 2 naming
the shortfall on a take shorter than they need, because on the short sample they redden rows about
a build with nothing wrong with it.

## Three things that are easy to get backwards

**A render moves the camera, so rendering in answer to a camera event is a loop.**
`renderProgramFrame` runs `advanceNavigation`, which calls `controls.update()`, which fires
`change` on a damped control that moved — so a handler that renders on `change` has asked for the
next render, and with the playhead parked there is no frame clock to pace it. That shipped: one
pointer move on a paused orbit cost 34 rebuilds and the drag ran at 12fps while rendering 190. Arm
a redraw request and let the animation loop pump it; **nothing may start a redraw except the
loop**.

**`nearClip`/`farClip` versus `--min-depth`/`--max-depth`.** The first pair are viewer uniforms
that hide points which already arrived. The second pair are grabber flags that clip on the GPU
before the frame is built, so they decide what exists at all. The recorder's preview range drives
the first and **must never reach the second** — getting it backwards silently destroys footage in
the one situation where nobody is watching for it.

**`fs.readFileSync` throws above 2 GiB** (`ERR_FS_FILE_TOO_LARGE`; 2,147,483,647 reads,
2,147,483,648 throws). Anything that reads a capture streams, and `server/capture.js` is the only
thing that should be touching capture bytes.

## Conventions

- **Comments are for two things only.** A one-line description of what a function or method
  does, where the name alone is not enough; and a short *why*, one or two lines, where a reader
  would otherwise change the code and break something. Everything else goes: no essays, no
  history of what the code used to be, no measurement narratives, no weighing of design
  alternatives, no restating the line below, no bold-lead paragraphs, no section banners. The
  code is meant to be self-explanatory and the pages under `docs/` carry the long form. When in
  doubt, delete it.
- **Names are contracts.** A name that needs a comment to say what it really holds is lying, and
  so is one you would explain as "x, but really y" — rename the thing instead. The same test
  applies to an abstraction: if you cannot say what it does end to end and part by part, in plain
  words, it will not hold together when the next person changes it.
- Commits: imperative subject, then a body explaining the why and carrying the measurements with
  their methods.
- **`pointSize` is pixels at 1080p**, and every screen-space term with it. A project saved before
  step 6 needs its point size scaled by the buffer height it was authored at, and `registry-check`
  asserts the 1080/600 rebase factor rather than skipping the value, so a preset re-tuned by hand
  to something near it fails.
- **There are three screen-space references and not two, and the third is the newest.** The
  glyph field's legibility band is 8 to 16 pixels of *whichever reading is smaller* — the drawn
  framebuffer sprite, or that sprite back in reference pixels — which the vertex stage writes as
  `outsideCrop ? 0.0 : gl_PointSize / max(k, 1.0)` into `vLegiblePx`. The crop's half of that is
  a decision and not a reading: a point outside the box reports no legible pixels at all, so
  `glyphMix` is exactly 0 and cut-away geometry draws the round mask. Halving the sprite was the
  whole of what the crop used to contribute here and it was never enough — half of a 64-pixel
  sprite is 32, still far above the band, so cut geometry drew a *smaller character* where the
  halving's own paragraph promises dust. Neither half alone is correct and each one
  alone is a shipped defect: in reference pixels the fallback inverts at small buffers, because
  the lower clamp lifts a sub-pixel sprite to one framebuffer pixel and that divides back into
  fifteen reference ones, so the far cloud drew one arbitrary bit of a character each instead of
  a dot; in framebuffer pixels the boundary between text and texture moves with output size, so
  a document turning to splats past four metres at 1080p holds characters to eight at 4K, and
  `renderScale` — a view parameter that keyframes nothing — moves the look. At 1080 the two
  readings are the same number, which is asserted rather than derived: `registry-check`'s unit
  section is the only arm in the suite that can see the difference, because every other glyph
  arm is above the band on both readings.
- **1080p is the unit; 600 is bloom's frozen chain; both are correct and do not reconcile them.**
  Every screen-space term is *expressed* against 1080p, which is why the shaders in
  `web/cloud-shader.js` read `bufferHeight / 1080.0`. That sentence was aspirational for one term
  until recently and is now true of it: the glyph field's point-size ceiling is expressed in
  reference pixels too, `min(255.0 * k, pointCeiling)`, so the range at which characters stop
  filling their cells is the same at any output size. The hardware bound stays outside it, because
  a reference ceiling the GPU will not rasterise is a clamp that does not clamp — measured off the
  context the tools open, this rig reports `ALIASED_POINT_SIZE_RANGE` as [1, 511] (Apple M2 Max
  through ANGLE's Metal backend, one read from the page). 255 is the largest number that survives
  the tallest output `web/export-sizes.js` offers: 2160 is a scale of exactly 2, and 255 × 2 is
  510. Bloom has no parameter to express, because
  `UnrealBloomPass` bakes its tap count in at construction, so its mip chain is frozen at the
  600-tall buffer the look was graded on: `bloomChainSize` computes
  `refWidth = (bufferWidth / bufferHeight) * 600` and sets the chain at half of it. The mechanism
  is the reason — the halo's width is a tap count over a texel count, so a chain with 1.8x the
  texels has a halo 1.8x tighter. Measured: a 1080-frozen chain lands 7.16/255 off the graded look
  on the worst of forty tile means where the 600-frozen one lands 1.10. The comment above
  `bloomChainSize` in `web/bloom-pass.js` carries the rest, and `test/bloom-chain.test.mjs` holds
  the arithmetic to it under bare node.

## Process hygiene

Kill only your own listener, and **by PID resolved as a listener**:

```
for p in $(lsof -ti tcp:8080 -sTCP:LISTEN); do kill "$p"; done
```

A bare `lsof -ti tcp:8080` also matches processes *connected to* the port, and `pkill -f` matches
the shell running your own command.

**Never `git stash` in a worktree of this repo.** The stash is a single ref in the shared `.git`,
so every worktree pushes onto one stack. A session here stashed to take a baseline, a concurrent
session in another worktree stashed ninety seconds later, and the pop restored *that* tree's
`server/index.js` into this one while orphaning six files. Nothing is lost — the stash commits
survive as unreachable objects — but the recovery is long and the interference runs both ways. To
take a baseline, copy the modified files outside the repo, `git checkout --` them, measure, and
copy them back.
