# Working in this repo

The shipped program is the design. `README.md` carries the usage path. Six pages under `docs/`
carry the rest — `architecture.md`, `reference.md`, `performance.md`, `measurement.md`,
`instruments.md`, `proof-tools.md` — and the next section says what each is for. When the code
contradicts the intention behind it, report the contradiction instead of redesigning silently.

## Writing prose

Each document has one reader and one job, and a sentence that serves another reader's job moves
or goes.

- `README.md` says what to do. A user reads it to shoot, edit and export. No reasons, no history,
  no measurements.
- `CONTRIBUTING.md` says how to contribute: what runs without a sensor, which checks to run, what
  a pull request says.
- `docs/` say how it works now and what it costs, in present tense. `docs/reference.md` and
  `docs/proof-tools.md` are tables of flags, keys, readings, tools and controls.
  `docs/architecture.md` explains the design as it is. `docs/performance.md` carries the numbers
  with their methods. `docs/measurement.md` says how to take a number. `docs/instruments.md` says
  how to write a check.
- `CLAUDE.md` states rules as present-tense imperatives. A rule stands without the story behind
  it.

No sentence says what something used to be, what shipped once, or what a session did. A past
mistake earns at most one sentence, in the docs page that owns the surface, and only where
knowing it stops a specific mistake. Say what a thing is. Do not say what it is not, or what it
used to be.

## Working with the person who asked

- **Write plainly.** Short sentences, ordinary words, no term the reader did not use first.
- **Less is more in the interface.** Controls and labels explain themselves. Keep text for live
  state, values, errors, accessibility and consequences the controls cannot show. No taglines,
  helper captions, onboarding copy or modal prose.
- **Ask before the work.** An ambiguous requirement gets a question with concrete options.
- **No slop.** No emojis anywhere, no filler, no recap. Say what changed, what it cost, and what
  you did not do.

## Before you commit

A contribution is proven working code, and code on its own is not
([Simon Willison](https://simonwillison.net/2025/Dec/18/code-proven-to-work/)).

- Drive the real surface end to end: `playwright-cli` for the browser, the proof tool for the
  thing it proves. Watch the change happen.
- Write the test for the thing you just did by hand, revert the change, watch it go red, then put
  the change back.
- Name the inputs off the happy path — the empty one, the malformed one, the worst one — and
  either handle them or say in one line what they do.
- Run `node tools/syntax-check.mjs`, `npm run test:unit`, and the proof tools covering the
  surface you touched.
- Report which tools ran, which rows, which numbers, and which checks you skipped.

## What not to build

- **One implementation.** No legacy path beside a new one, no flag to switch between them.
- **No backwards migrations and no compatibility shims.** A capture this build cannot read is
  refused at the door with a reason.
- **No new documents.** A lesson goes in the page that already owns its surface: `README.md`,
  `CONTRIBUTING.md`, `SECURITY.md`, the six pages under `docs/`, `third_party/UPSTREAM.md` or
  `presets-builtin/README.md`.
- **No temporary files in the checkout.** Scratch lives in the session scratchpad. `captures/` is
  gitignored and holds captures.

## Measurement

- Measure. "This should be faster" is not evidence.
- Interleave the A/B. Never take a sequential before/after.
- State window length, sample count, warmup discarded and page-cache state with every number.
- When profiling per-segment cost on the grabber, throw away a run that does not sustain ~30.0
  delivered fps; its timings are noise. A throughput experiment measures that drop instead.
- Use an offline harness for correctness and `grabber --profile` on the sensor for cost.
- Size fixtures by frame count, never by duration.

## Writing a check

`docs/instruments.md` carries the case behind each rule.

1. **Enforce the claim, do not assert it.** Ask what a broken implementation would do to still
   pass, and close that with a falsification control: something that must FAIL when the thing
   under test stops doing the work.
2. **Mutation-test the instrument.** Report which mutations ran. Confirm a missed mutation did
   something, and a caught one was caught for the reason claimed.
3. **Count failed assertions, never exit codes**, and read which fired. Zero failed assertions
   with a non-zero exit is a crash or a printed miss to read, not a catch to record.
4. **Place a probe where its answer would differ.** Arms that agree on a quantity cannot measure
   it.
5. **Look for the object every observation skips**, hardest where the skipping is deliberate.

**Close the class, not the instance.** Make the route table be the dispatch and have the check
walk it, so a route added later is asked by existing.

**Re-run the baseline in the conditions the failure happened in.** A contended machine makes a
check fail in ways that read as a finding.

## Proof tools

`docs/proof-tools.md` carries the invocations, every `--mutate` control and what each tool needs.
Read the assertion count, never the exit code.

| tool | what it proves | what it needs |
| --- | --- | --- |
| `determinism-check.mjs` | same program time, same image | a capture |
| `index-check.mjs` | the index, the hash, the frame API | `--url`, and a fixture past 2 GiB |
| `registry-check.mjs` | one registry, sliders as views of it, every look term live | `--url` |
| `timeline-check.mjs` | seek equals playback | `--url`, a take of ≥12s |
| `keyframe-check.mjs` | tracks, undo | `--url`, a take of ≥24s |
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

**Ports.** These tools spawn their own server and need the port free:
`guard-check` 8321, `jobs-check` 8231 and 8232, `effect-check` 8281, `level-check` 8377,
`monitor-check` 8341, `vcam-check` 8361, `boot-check` 8391, `library-check` 8210 (`--node-port`)
and 8211..8227 (`--mac-port`..`+16`), `index-check` 8251 under `--stage` or `--mutate` only, and
`sensor-view-check` 8131 for the section needing its own capture. A stranger on the port answers
the tool, and its green run proves nothing. `library-check`, `boot-check`, `effect-check` and
`index-check` probe the port first and exit 2 naming what answers. Everywhere else, run
`pgrep -f "tools/.*-check.mjs"` first.

`effect-check` and `jobs-check` write packages and keep their user root out of `effects/` and
`jobs/`: `effect-check` passes both store roots under `.effect-check/` to its staged server by
flag, and `jobs-check` spawns its server out of `.jobs-check/root`. Both delete their tree on
the way out of a run that reached its sections; a refusal at staging (a stale anchor, a missing
sample) exits 2 with the tree left behind, so delete it by hand. A third writer picks one of those and says which.

`module-check` needs no port, no browser and no install. It reads `web/` off disk and refuses an
import cycle, an import naming a missing file or export, state crossing a boundary as a writable
object, or a name crossing one that only one end wanted. It does not test the intra-module dead
zone, the reach through property dispatch inside `web/main.js`, which is not statically decidable
and needs a post-boot state diff.

`cpp-check` parses and typechecks; it does not link or run, so a call present in the headers and
absent from the library passes.

`syntax-check` fails on any tool in `tools/` this file does not name:

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

`make-sample` is synthetic: no depth jitter, no confidence gate chattering, no dropped frames.
Say which sample a number came from. It refuses to overwrite an existing
capture and names what it declined to destroy; `--force` replaces, `--if-missing` exits 0.
`timeline-check`, `editor-check` and `keyframe-check` exit 2 on a take shorter than they need.

## Three things that are easy to get backwards

**Nothing starts a redraw except the animation loop.** The loop runs `advanceNavigation` and then
`renderProgramFrame`; `advanceNavigation` calls `controls.update()`, which fires `change` on a
damped control that moved, so a handler rendering on `change` has asked for the next render. Arm a redraw
request and let the loop pump it.

**`nearClip` and `farClip` are viewer uniforms that hide points which already arrived;
`--min-depth` and `--max-depth` are grabber flags that clip in the depth pipeline before the frame is
built.** The flags decide what exists at all. The recorder's preview range drives the uniforms
and must never reach the flags.

**`fs.readFileSync` throws above 2 GiB** (`ERR_FS_FILE_TOO_LARGE`; 2,147,483,647 reads,
2,147,483,648 throws). Server code streams a capture, and `server/capture.js` owns the frame
decode.

## Conventions

- **Comments are for two things.** One line on what a function or method does, where the name
  alone is not enough; and one or two lines of why, where a reader would otherwise change the
  code and break something. Delete the rest.
- **Names are contracts.** Rename anything you would explain as "x, but really y". The same test
  applies to an abstraction: say what it does end to end, in plain words, or it will not hold.
- **Commits take an imperative subject**, then a body carrying the why and the measurements with
  their methods.
- **Cite a function by name, never by line.** `syntax-check` walks every `docs/` page and `web/`
  module the prose and the source cite, and fails one that does not resolve. A citation is checked
  for resolving, never for being right.
- **`pointSize` is pixels at 1080p through the camera's 50-degree boot lens.** Keep that reference
  in `lensReference` in `web/cloud-shader.js`; `export-check` holds the lens scaling. Every
  screen-space term uses `bufferHeight / 1080.0` for output size.
- **The glyph field's legibility band is 8 to 16 pixels of whichever reading is smaller** — the
  drawn framebuffer sprite, or that sprite back in reference pixels. The vertex stage writes
  `outsideCrop ? 0.0 : gl_PointSize / max(k, 1.0)` into `vLegiblePx`, so a point outside the crop
  reports no legible pixels and `glyphMix` is 0.
- **The glyph point-size ceiling is 255 reference pixels**, applied as `min(255.0 * k, pointCeiling)`
  in framebuffer pixels. 255 is
  the largest number that survives the tallest output `web/export-sizes.js` offers, against this
  rig's `ALIASED_POINT_SIZE_RANGE` of [1, 511].
- **Bloom's mip chain is frozen at the 600-tall buffer**, because `BloomPass` bakes its tap
  count in at construction. `bloomChainSize` in `web/bloom-pass.js` sets it, and
  `test/bloom-chain.test.mjs` holds the arithmetic. Do not reconcile it with 1080.

## Process hygiene

Kill only your own listener. List the listeners, confirm the PID is the server you started,
then kill that PID:

```
lsof -i tcp:8080 -sTCP:LISTEN
kill <pid>
```

A bare `lsof -ti tcp:8080` also matches processes connected to the port, and `pkill -f` matches
the shell running your own command. Another agent's server on 8080 is the normal state here.

**Never `git stash` in a worktree of this repo.** The stash is one ref in the shared `.git`, so
every worktree pushes onto one stack and a pop restores another tree's files into this one. To
take a baseline, copy the modified files outside the repo, `git checkout HEAD --` them, measure, and
copy them back.
