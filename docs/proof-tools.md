# The proof-tool suite in detail

This is the whole of the suite: how to run each tool, what it needs before it will run, what its
exit codes mean, and the per-tool facts that are only worth having when you are about to run or
edit that tool. It is not a census of the `--mutate` controls and does not list them — each
tool's own table is that list, and a tool handed a name it does not know prints the complete set
it declares. `CLAUDE.md` carries the index
— one line per tool, what it proves and what it needs — and sends you here for the rest.

For the method behind the suite, see `docs/instruments.md`.

## The invocation list

**Every tool and how to run it.** This list used to live in `CLAUDE.md`, which is loaded into
every session; it is here now because it is reference read on a condition rather than a rule
anybody needs in their head. `CLAUDE.md` keeps the index — which tool proves what, and what it
needs before it will run — and `syntax-check` still enforces that every tool in `tools/` is named
there.

**The controls are not listed here and this is not a census of them.** Every one runs as `node
tools/<tool>.mjs --mutate <name>`, every tool answers a name it does not know by printing the
complete set it declares, and a mutated run prints what its control should have reddened beside
the verdict — so the table is the list and this page cannot fall out of step with it. The few
entries below that still carry a description are the ones a person has still to read.

```
node tools/determinism-check.mjs                    # step 1: same program time, same image
node tools/determinism-check.mjs --clock --before HEAD~1
node tools/index-check.mjs --url http://localhost:8123   # step 2: index, hash, frame API.
                                                          #   **It refuses to run without a fixture past 2 GiB**,
                                                          #   naming the path or the byte count: its whole subject is a
                                                          #   frame at an offset a whole-file read cannot reach, and on
                                                          #   a smaller set every row passes while that one tests
                                                          #   nothing. That absence used to arrive as an ENOENT or as
                                                          #   `walk.frames[-1]`, both with zero failed assertions and a
                                                          #   non-zero exit
node tools/index-check.mjs --stage                        # ... the same run against a server this tool spawns from a
                                                          #   staged tree on 8251, rather than the one at --url. It is
                                                          #   the innocent-conditions control for the two mutations
                                                          #   below: they can only be read against a baseline taken in
                                                          #   the conditions their failure happened in
node tools/registry-check.mjs --url http://localhost:8080 # step 3: one registry, sliders as views
node tools/timeline-check.mjs --url http://localhost:8080 --take fixture-1g # step 4: seek equals playback
node tools/keyframe-check.mjs --url http://localhost:8080 --take fixture-1g # step 5: tracks, retime curve, undo
node tools/export-check.mjs --url http://localhost:8080   # step 6: resolution, export, the file
node tools/audio-check.mjs                              # audio import, modulation, persistence and a real audio/video export
node tools/library-check.mjs                              # step 7: library, recorder, routes
node tools/editor-check.mjs --url http://localhost:8080 --take fixture-1g # the editor's controls: that they exist, that pressing them changes something
node tools/boot-check.mjs                                 # the post-boot state diff: every control shows the value the registry holds for the
                                                          #     selected clip; the document door, which adopts a whole document or none;
                                                          #     undo, which is the session's and is written into no file; and the selection,
                                                          #     which survives the undo of a delete without becoming another clip
node tools/effect-check.mjs                               # installing an effect: revisions, the door, the hotload, park and restore
node tools/effect-conformance-check.mjs --url http://localhost:8080 # the plugin contract: every installed effect draws nothing at all when it is off
node tools/effect-conformance-check.mjs --mutate leaks-at-zero # ... a floor under the rain's master, so the package contributes at
                                                          #     the term it is meant to be absent at. Served over an
                                                          #     interception rather than written, because this tool runs against
                                                          #     a server somebody else started and has no staged tree to edit.
                                                          #     Reddens exactly one row - rain's drop equality - and no other
                                                          #     effect's; the two arms that hold the master at zero cannot see
                                                          #     it, because the sub-keys are behind the `rain > 0.0` gate
                                                          #     This description stays here rather than moving into a
                                                          #     `fails:` like the rest: it is the one control in the tree
                                                          #     declared as a function, so it has no field to hold one, and
                                                          #     reshaping it so a uniform rule can reach it is more change
                                                          #     than the rule is worth. Not an oversight
                                                          #     **Two of syntax-check's own controls anchor on this line**
                                                          #     - `doc-invokes-an-undeclared-mutation` on the `--mutate`
                                                          #     name and `doc-lists-a-mutation-under-the-wrong-tool` on the
                                                          #     whole command - because it is the only `--mutate` invocation
                                                          #     the census deletion left standing. Move or delete it and
                                                          #     both stop being able to run, which `anchors/` will say
node tools/monitor-check.mjs                              # step 9: the monitor's decimation, the take it must not touch, and the picture it shows
node tools/sensor-view-check.mjs                          # the intrinsics a take was shot with, against a build that assumes them
node tools/level-check.mjs                                # levelling: the room turns, and the crop, the top-down and the sensor view keep their meaning
node tools/vcam-check.mjs                                 # the output to OBS: the colour camera, the take it must not touch, and the source's picture
node tools/guard-check.mjs                                # the socket's origin rule, the bind, and the rebinding rule
node tools/jobs-check.mjs                                 # step 8: the queue, the pin, a real render, and a job
                                                          #   whose deliverable this build cannot read, which has to
                                                          #   come back failed rather than rendered - the batch path
                                                          #   adopted past the version gate until it did.
                                                          #   **It wants 8232 as well as 8231**: three arms put a
                                                          #   forwarding proxy between a worker and the server, one
                                                          #   policy at a time on `--proxy-port`, which defaults to
                                                          #   the port above plus one.
                                                          #   **It stages two takes**: `--source` symlinked in, and a
                                                          #   60-frame one it synthesises with `make-sample` at start.
                                                          #   A job carries one hash per clip, and a check with one
                                                          #   take in its library cannot tell a list from a single
                                                          #   entry however many rows it writes
node tools/module-check.mjs                               # the boundaries in web/: the import graph, what an import names, what crosses it
```

`audio-check` stages its server and every writable store in a temporary directory. It uses a
120-frame synthetic take and a generated tone by default. `--source PATH` reuses a capture,
`--audio PATH` imports a real audio file, and `--shots DIRECTORY` saves the panel and an MP4
preview outside the checkout. It checks the destination list, rendered frame changes, seek
repeatability, undo, reload, and exact stereo PCM samples from a lossless export starting after
the audio clip begins. Its `--mutate` controls are `signal-disconnected`, `mux-ignores-start`,
`added-effect-hidden`, `space-keeps-control-focus`, and `undo-leaves-spectrum-empty`. They must
fail the rendered modulation, exact exported samples, newly added destination, focused Space
shortcut, and restored spectrum checks, respectively. Read the failed assertions; exit 2 means
the run did not finish.

`audio-check --queue` also sends an audio project through the real render worker and compares
its exported samples. `editor-check` needs four captures with distinct hashes in the server's
library: its chosen take must have at least 32 seconds, and the additional takes keep the
asynchronous Add Clip checks from reusing an already cached source. Its disk check expects the
tool and server to share the same application root and `exports/` directory.

The two below need no server, and `registration-check` needs no sensor either — it runs on a
corpus of `Registration::apply` inputs dumped by `grabber --dump-corpus`.

```
node tools/vendor-check.mjs                          # third_party is upstream v0.2.1 + declared edits
node tools/registration-check.mjs                    # our registration == upstream's, bit for bit
```

The three below are three of CI's four jobs. The fourth is `npm run test:unit`, which lives in
`test/` rather than `tools/` — it needs no server, no sensor and no browser, but it **does need
`npm ci`**, and that changed with the module extraction rather than being true all along. Four
of the modules taken out of `web/main.js` return three.js types they exist to build —
`world-tilt` a Quaternion, `plan-geometry` a Vector3, `gpu-textures` a DataTexture, `bloom-pass`
a Pass — so a node test of them cannot resolve `three` out of a tree holding only source.
Measured on the first push after the extraction: `ERR_MODULE_NOT_FOUND: Cannot find package
'three'`, 47 tests, 4 failed, on all four CI arms while the same suite ran 68 green locally
against an installed tree. `test/runner-control.test.mjs` is its control.

**Two of those tests were scaffolding and are gone, which is why the count dropped from 120 to
113** — it reads 118 now, the five added being one door row for the step grid and the four in
`test/effect-table.test.mjs`. Both of the deleted ones pinned this build to a revision of its own
history, and both said so in their own
headers when they were written. `test/effect-manifests.test.mjs` held every shipped manifest
field-for-field against the effect table the registry used to declare, materialised out of `git
show` through a `data:` URL — six tests, deleted whole. `test/shader-assembly.test.mjs` held the
four assembled programs byte for byte against the two monolithic literals, resolved by content
marker rather than by hash; that one arm is deleted and the file keeps its other three, which are
structural and live.

The reason to retire them rather than carry them is that a gate pinned to history breaks on the
first *intentional* change — a manifest retune, a shader edit — and a gate that must be deleted
to make a legitimate change is a gate that will be deleted carelessly. What replaces the byte
equality is not weaker and it is not in `test/`: the ten-look probe renders the shipped looks
through the real page and hashes the framebuffer, and it came back 150 of 150 equal to one
recorded baseline at every landing point of the extraction. `docs/performance.md` carries that
result with its full method. What replaces the manifest equality is the coupling that survives
intentional change: `registry-check`'s set equality, `boot-check`'s diff, and
`tableFromPackages`' own both-direction refusals, which `web/main.js` runs at boot on every page
load.

**What left with them, recorded rather than glossed.** `placeParams` was exported only for the
deleted gate and is module-local now, so `module-check` stops reporting it as an export nothing
reads. Its appendix rule — where a parameter no layout order places ends up — is exercised live
by `effect-check`, which installs a fork carrying a parameter the order has never heard of, but
only for one package at a time. The ordering *between* two unplaced packages was stated in the
comment above the function and asserted nowhere; `test/effect-table.test.mjs` holds it now,
through `tableFromPackages` rather than by re-exporting the module-local function, with two
synthetic packages named against their placement so the expected answer disagrees with the order
they are handed over in. Mutation-tested rather than reasoned about: dropping the id sort reddens
three of its four rows, sorting each package's keys reddens two, and dropping the placed prefix
reddens one — each on the rows it names, with the baseline green again after every restore. The other loss is subtler and worth the
sentence: the byte-for-byte arm compared against a string the assembler did not produce, so it
could see a rule the assembler had stopped applying. Its surviving neighbour, the flip control,
assembles the tree twice with the same assembler and compares the two, so a dropped rule is
dropped from both sides. Dropping `stages.sort(byOrder)` leaves the flip control green and
reddens only the synthetic fixture arm — measured at the retirement, and the reason that fixture
arm exists.

```
node tools/syntax-check.mjs                          # every JS file this repo ships parses, and the two
                                                     #   constants the two languages cannot share agree
node tools/release-gate-check.mjs                    # the .npmrc supply-chain gate is actually armed
node tools/cpp-check.mjs                             # both C++ files parse and typecheck, in all four
                                                     #   pipeline configurations they can be built in
```

## Exit codes, and why reading them is a trap

**The tools disagree about what a caught mutation exits,
the disagreement runs the dangerous way, so read the assertion count and never the code.**
Counted rather than recalled:

- **Eight exit non-zero on a catch and say `NOT CAUGHT` when they miss**: `guard-check`,
  `jobs-check`, `editor-check`, `monitor-check`, `sensor-view-check`, `level-check`,
  `vcam-check` and `module-check`.
  **A miss exits 1 here as well, which this line did not say for a long time and which is
  the whole reason to read the verdict.** Counted rather than recalled, across all eight:
  the `NOT CAUGHT` branch is `process.exit(1)` and the `caught, as required` branch beside
  it is `process.exit(1)`, so within this group the code carries **no information at all**
  and only the printed sentence separates the two. The natural reading of the old wording —
  that a non-zero exit is what a catch looks like, so a miss must look like something else —
  is false for every member, and it is the reading anything gating on `!== 0` takes. It cost
  a round here: `module-check` was written up as a fifth shape of its own on exactly that
  misreading, before the other seven were measured and found to be doing the same thing.
- **Four invert it**: `vendor-check`, `registration-check`, `registry-check` and
  `release-gate-check`, where caught is exit **0** with `caught, as required (N assertions
  fired)` and exit **1** is `NOT CAUGHT`.
  Anything gating on "non-zero means caught" reads a genuine miss by these four as a catch.
  `registry-check` joined this group rather than the first deliberately, because all three of
  its outcomes have their own code: it exits **2** with `DID NOT RUN` on a crash, on the same
  reading `registration-check` reserves 2 for. `level-check` and `vcam-check` separate the same
  three and land in the first group instead, so the three-way split and the sign of a catch are
  independent choices rather than one decision — which is the whole reason this section exists.
  That is not hypothetical — two of the four mutations it carried at the time reddened their
  intended row and *then* died on Playwright's `Target page, context or browser has been
  closed`, and without the crash handler each would have exited non-zero having asserted the
  right thing for the wrong reason. (It carries twenty-seven now, and the count is written
  as a moment rather than as a fact because the sentence is about one afternoon's runs.)
  `release-gate-check` is here because its header says it follows `vendor-check` and its code
  does: it prints the assertion count and exits 0 on a catch, and 1 with `NOT CAUGHT` on a miss.
  It is the one tool in this census that carries mutations without appearing in the fourteen
  below, for the reason given there — so an agent who goes looking for it under Mutations and
  gives up reads it by the majority convention, which is backwards for exactly this tool.
- **Six have no `NOT CAUGHT` branch at all** and simply exit on their failure count:
  `timeline-check`, `export-check`, `keyframe-check`, `library-check`, `syntax-check` and
  `cpp-check`, the last two of which are `process.exit(failed ? 1 : 0)` and nothing else.
  **A mutation these six fail to catch exits 0**, which reads as a clean pass rather than as
  the check being blind. That is the same direction as the inverting group above and it is
  silent rather than merely confusing, so it is the worse of the two shapes. The cpp job in
  `.github/workflows/checks.yml` is written against exactly this: it treats a zero exit as
  `NOT CAUGHT`, which is right for that shape and wrong for every other group here.

**So the two groups that carry mutations without a browser fail in opposite directions, and a
CI loop has to be written against both.** `module-check` is in the first group, where a miss
and a catch are both exit 1; `syntax-check` and `cpp-check` are in the last, where a catch is 1
and a miss is 0. Measured against a stub that misses: the cpp job's "non-zero means caught"
test printed `caught` and exited 0, and the gate job's `set -e` fails on all thirty-three of
the runs that work. Neither shape is portable, which is why the step that runs those thirty-three
reads the failed count out of each tool's own summary line instead. `module-check`'s exit **2**
is `DID NOT RUN` in four places, the fourth being a mutation naming a file nothing in the run
read.

Which is why the rule is worded the way it is: count failed assertions, never exit codes — and
read *which* assertions fired, because a tool that counts its own crash as a failure reports a
catch it never made.

**And "read which assertions fired" is not advice you can put in a workflow**, which is the
seam worth stating here rather than leaving somebody to find it. The step that now runs those
thirty-three mutations on every push can only ask that the clean tree passes and each mutation
reddens it — a per-mutation row table in CI would be the hand-maintained list the enumeration
exists to replace. What that misses was measured rather than assumed: with the cycle detector
stubbed out, `--mutate cycle-planted` still printed `caught, as required (1 assertion fired)`
and exited 1 off the *probe tree's* own row rather than the row the mutation names. The thing
that catches that is the unmutated run in the same job, which the same stub reddens at
`61 assertions, 1 failed`. So the two steps are one claim in two halves, and neither is worth
much alone.

**Exit 2 means the harness did not run, or a claim went unproven.** `library-check` exits 2
when the low-space refusal could not be tested — it needs a real small filesystem and only
macOS gets one here — and the verdict line says so. Anything gating on `!== 0` therefore treats
a Linux run as not-a-pass, which is the intended reading: "some claims were not tested here"
and "a claim failed" are different answers and 1 already means the second. `registration-check`
reserves 2 on the other side of the merge, where a build or runtime failure is "the harness did
not run" rather than "the harness found something", so a mutation that failed to compile can
never be recorded as a mutation that was caught. `guard-check` and `vendor-check` use it the
same way. The convention was reached independently several times and it is one rule.

`editor-check` is the fifth, and it is the one that shows what the rule is worth, because it
carried the machinery for a year without ever setting it. Section 21 opens a second page on
`/record` to read the dock the editor withholds, and a page that fails to boot, settle or take
its route interception left six rows unrun behind a printed note — so a build with a broken
recorder reported `PASS`, and the only thing between a reader and that reading was a comment
asking them to add the total up by hand. It now exits **2** naming the arm and its reason. Two
consequences worth having in front of you before reading one: a mutation run that lands here is
reported as *neither* caught nor missed, because the rows it is short of may be the rows that
answer the mutation, and the verdict prints the assertion count and the rows that fired the way
the crash branch does, since an outcome nobody can count is the thing the exit-code rule at the
top of this file exists to refuse.

## Mutations

`--mutate <name>` serves a deliberately broken `main.js` into the running server, or for the
two vendoring tools rebuilds a deliberately broken source tree.

**Read the first line of the output before reading anything else.** A mutated run says
`MUTATED: <name> delivered`; an unmutated one says `unmutated tree`. That distinction is what
tells a run that caught nothing from a run that tested nothing, and the second is easy to
produce by accident from a shell. A batch built as

```sh
for m in first-load-bounded listing-never-times-out; do
  args="--mutate $m"; node tools/library-check.mjs $args --node-port 8210   # WRONG under zsh
done
```

runs five baselines: **zsh does not word-split an unquoted parameter**, so the tool receives one
argument spelled `--mutate first-load-bounded`, matches no flag, and runs the tree as it is.
Every run then reports the same assertions and the same failures, which reads exactly like four
mutations a check could not catch — the same conclusion, from the opposite cause. That cost a
seventy-minute batch here. Pass the name as its own quoted word, `--mutate "$m"`, or write the
invocations out; and either way check the header, because the tool already says which tree it
ran and the header is cheaper than the inference.

**Fourteen tools carry mutations by one of those two mechanisms** — editor, export, guard, jobs,
keyframe, level, library, monitor, registration, registry, sensor-view, timeline, vcam and
vendor — and all of them refuse a mutation whose text they cannot find exactly once, because a
replacement that silently matched nothing would run the unmutated page and be recorded as the
check having missed a bug it was never shown.

**That qualifier is load-bearing, because the exit-code census above has eighteen entries and
this list has fourteen names.** The four in the census and not here each carry mutations by a
mechanism of their own, so there is no staged page and no rebuilt tree for the refusal above to
be about. `release-gate-check` writes a whole `.npmrc` into a scratch directory npm is then
asked to resolve a package from. `syntax-check` and `module-check` substitute their edit into
the bytes they read, so a mutation never reaches disk at all. `cpp-check` templates its two
generated headers and the mutated source into a scratch directory and compiles there. All four
numbers are right because they count different things, so do not reconcile them — a name added
to this list would claim a delivery that tool does not use, and dropping one from the census
leaves the tools whose convention is easiest to read backwards as the ones nothing documents.

**All four do refuse an anchor they cannot find, by their own route rather than by the one
above.** `syntax-check` and `module-check` exit 2 naming the anchor and the file, and
`module-check` exits 2 again for a mutation naming a file nothing in the run read — which is
the half `syntax-check` has no need of, since it reads the whole tree either way.

**A mutation is a piece of source text, so a mutation stops matching the moment the code it
names is edited** — three of `timeline-check`'s nine had to be re-anchored when step 5 rewrote
the retime seam, and the refusal is what surfaced that rather than a silent pass. If you change
something a mutation anchors to, re-anchor it in the same commit and say in the message which
ones moved.

**`library-check` delivers every mutation by one mechanism — the staged tree — and then asks
the server whether it arrived.** Both halves are worth reading before editing that tool,
because it had two mechanisms for a release and the seam between them was a hazard rather
than a redundancy.

Server mutations were always staged. Page mutations were fulfilled by a Playwright route
interception matched on a URL, and that shape has a specific failure: **a page is reached at
the URL `PAGES` names it by, not at its filename**. `web/library.html` has no URL of its own —
`server/index.js` 404s any `.html` under `web/` on purpose, so a page has exactly one address —
and it is served at `/library`, so an interception written as `**/library.html` matches
nothing, the unmutated page loads, and the run is recorded as the check having missed a bug it
was never shown. That is the match-exactly-once failure arriving through the *delivery* rather
than through the anchor, where nothing refused it.

Staging everything closed a different hole — `server/library.js` imports `web/format.js` by
path, so a mutation of it that reached only the page left the server deciding `openable` on the
unmutated band — and made the interception redundant in the same breath, since `WEB_DIR` is
`join(ROOT, 'web')` and `web/` is copied into the staged root. Two mechanisms delivering the
same bytes is not defence in depth; it is the two-gates-that-agree shape `docs/instruments.md`
records, where no mutation can reach one without the other covering, so neither can be tested
and one of them is doing all the work.

So there is one delivery path, and `requireMutationDelivered` is the opposite shape from the
thing it replaced: it fetches the page's own URL before a browser opens anything and requires
the bytes back to be the ones this run staged. `PAGE_URLS` is unavoidably a second spelling of
`PAGES` and is *checked rather than trusted* by exactly that fetch, so a page that moved or
stopped being served fails by name. **It exits 2 rather than failing an assertion**, and the
direction is the point: a suite that fails one row on a mutation run reads as a catch, so a
mutation that never arrived has to be the harness declining to run.

Measured when the mechanisms were collapsed: 19 of the 20 page mutations delivered, each
named with the URL and the byte count, `library-has-no-way-to-the-menu` among them at
`/library`, which is the case the interception existed for. The twentieth is
`marks-ignore-retime`, which could not be constructed at all — its anchor matched twice in
`web/main.js` and the match-exactly-once refusal stopped it, a stale anchor that predated this
and was tracked in #28.
That is closed and the fix is worth knowing, because it is not the one a reader would guess: the
duplicate is still there in `web/main.js`, once at four spaces of indentation and once at six,
and `c757210` re-anchored the entry onto a leading newline and four spaces, which by that alone
cannot match the six-space copy inside the
`miniMarks` map. So the anchor matches exactly once now, which is what `syntax-check`'s anchor
row reports across all 406 anchors in the suite. Whether the mutation *delivers* has not been
re-measured — the anchor being constructible is the weaker claim, and only the weaker one is
stated here.
The control for the delivery refusal is to stop staging `web/` files and run a page mutation:
it names the file, the URL and both byte counts, and exits 2 without printing an assertion.

**There are three kinds of mutation now, not two, and the third arrived with the same hole the
other two were collapsed to close.** A *document* mutation edits a file under
`presets-builtin/`, and the mac server reads its shipped looks through `--builtin-presets`,
which points at `WORK/builtin-presets` — a directory that was copied straight from the repo.
So a mutation written into the staged root landed somewhere nothing served: the arm would have
compared the *unmutated* document against the registry and the run would have come back green,
which is the silent-delivery shape this page already carries two entries about. It is closed
the same way rather than with a second write: `WORK/builtin-presets` is now a copy of the
staged root taken *after* the mutation lands, so "one place a mutation is delivered" stays
literally true. `requireDocumentDelivered` is the exit-2 sibling of `requireMutationDelivered`
and holds the served `rev` — the sha256 `DocumentStore.read` computed over the bytes it read —
against the hash of the staged file. Its control is to point that copy back at the repo and run
`--mutate shipped-look-drops-a-value`: exit 2, zero assertions, `rev 6aaada1b4d4a … staged
a80e035827ce`, where without the refusal the same state is a green run.

## What each tool needs

**`editor-check`** takes `--no-render`, which skips section 7's real export and the saved copy.
Every control is caught with it on; the ten clip controls were listed without it in `df30ed1`
and that was an oversight rather than a claim about those ten.

**`timeline-check`** takes `--take`, and every one of its controls is driven with one.

**`determinism-check --clock`** refuses a rev whose `main.js` already contains the transport,
so it needs `--before` pointing at a commit before step 1.

**`export-check`** needs ffmpeg and ffprobe (`--ffmpeg`, `--ffprobe`; 8.1.1 at
`/opt/homebrew/bin`) and writes into `exports/`, which is gitignored.

**Section 9 drives refused edits on purpose, and the refusals are DOM-only.** It presses six
document doors from inside the render's own progress callback, one per frame, and each one is
declined with a sentence on the status chip. None of them reaches the console, so the run's
closing `no page errors` row stays green without anything being drained out of it - if a door is
ever changed to report through `showTimelineError`, that row is where it will surface, and the
repair is the drain this page describes for the missing-effect block rather than an exemption.

**It was red on ten rows, and the question this page used to leave open — when they went
red — is answered: `40ab241`, all ten in one commit.** Bisected over the 47 commits that
touch `web/main.js` on this branch, using each tree's own copy of the tool. That is sound
because the arms and their bands were defined at `b56d101`, which is in `main`, so the
instrument is constant across the range and only the page moves. `e1996bb`, the parent, is
47/47 clean; `40ab241` is ten red. The branch point `6e1be6f` reads noise 0.304, regionpush
0.423, regionmask 0.317, all green.

What moved is a residual floor, from about 0.3–0.5 of 255 to about 0.8–2.5, which put five
bands underneath it. **The terms are still correct and that was established before any
number was touched**: `region-in-metres` still separates cleanly, taking regionpush from
1.251 to 2.445 and reddening regionmask on its ratio at a 0.0216 departure, and
`pointsize-absolute` clears every band by eight to twelve times. The five within-build rows
are re-baselined against those measured pairs, with the table and the reasoning in the
comment above `RES_TOLERANCE`.

**Three candidate causes inside `40ab241` were reverted individually at HEAD and none of
them restores the floor** — the cyan flare that commit moved into the common path, the
vignette going from a baked `0.55` to a parameter defaulting to 0, and the glitch block's
five constants going from literals to uniforms. What remains is the driver arranging the
arithmetic around those lines differently, an effect `web/main.js` already records costing
three false regressions in `registry-check` when the flare was guarded, and one that
reverting at HEAD cannot undo because the surrounding code has moved 40 commits since.

**The five cross-build rows against `f14b4be…^` were red, and the cause has been found:
the two builds were rendering through different post chains.** That paragraph used to end
"what they need is either the cause found or the comparison moved off parameter defaults" —
it was the first, and the second would have hidden it.

`gradeNeeded()` here is true if any of `rgbSplit`, `scanlines`, `grain`, `vignette` or
`streak` is up. At the pinned rev it knows only the first three, because the vignette was a
baked `0.55` inside the pass rather than a parameter. Blackwall carries `vignette.amount: 0.55`,
and the `OFF` look those arms spread zeroes exactly the three names both builds share — so
the grade switched **off** over there and stayed **on** here, and the cross-build rows have
been comparing a graded image against an ungraded one for as long as they have existed. The
grade adds the vignette, a Reinhard `col / (1 + col)` and a toe subtracting 0.018 linear
from every pixel, and the toe is the term the numbers were about: it pushes the faint edge
of every splat under the tool's own `lum > 8` threshold.

**The reading that named it was a coverage deficit of 7.7% and 7.8% at an identical drawn
point size**, which is a difference a point-size reference cannot produce. Confirmed by
removal, one arm at a time against unchanged old arms: 960x600 goes from luminance ratio
1.06344 / worst 24.297 to **1.00258 / 0.602**, 16:9 from lit 0.92265 / lum 0.43720 / worst
6.997 to **1.00043 / 1.00079 / 0.070**, 4:3 from 0.92220 / 0.55736 / 10.121 to **1.00043 /
1.00101 / 0.071**. The control that says it is the pass rather than one term inside it:
zeroing `crush` alone with the grade still on moves the same row the *other* way, to lit
1.22463 and worst 23.343, because the lift without the toe adds coverage.

The repair is `CROSS_BUILD_OFF`, which is `OFF` with the vignette taken out, reaching only
the arms that render one look through two builds. **It is deliberately not in `OFF`**: eleven
within-build rows spread that, and their bands in `RES_TOLERANCE` were measured with the
grade running. The two `rebase-full` rows spread nothing and were already green — because
Blackwall's own `rgbsplit.amount`/`raster.amount`/`grain.amount` survive on both sides, so both builds run the
grade — and that table came out that way rather than being fitted, which is the reason to
believe the diagnosis.

**The class is closed rather than the instance.** Whether a pass runs is *derived*, so a
build that adds one name to a gate silently changes which arms are comparable and the only
symptom is a ratio. `RES_ARM` now returns the composer's own pass list, and every cross-build
row requires the two builds to have run the same chain — printed in the row's message either
way. `UnrealBloomPass` becoming `BloomPass` is normalised by name rather than skipped, so a
rename nobody knew about fails loudly instead of passing quietly.

**That last sentence was the exemption in miniature and it has been taken out.** Stripping
the prefix made the one guard written to notice a swapped pass the guard that could not:
`124a90b` replaced three's `UnrealBloomPass` with ours and the two do not deliver the same
light, so from that commit the `rebase-full` pair compared two implementations and reported
it as a ratio — 0.40978 and 0.40931 against an expected 1, red for fifteen days. Names are
compared whole now, and the two arms that have to span the swap render with `bloom` at 0
instead, printing the bloom-up ratio beside the judged one so the excluded term is still a
number in the run. `docs/instruments.md` has the case file and the isolation, and the row
titles say **bar the glow** because a label may not claim more than the arm measured.

**"Every cross-build row" was three of five when that paragraph was written, and the two it
missed are the two the paragraph above explains were green.** The guard went on the arms the
vignette had reddened and not on the `rebase-full` pair, whose exemption is the sentence
ending "so both builds run the grade" — a finding about the two builds this pair spans now,
used as a standing precondition for whatever it spans later. That is the instance rather than
the class, wearing the class's own paragraph, and it survived a round of review because a
green row is where an exemption is cheapest to write and hardest to see. Both rows carry
`sameChain` now and print both chains. The same edit closed a second hole underneath all five:
`chainOf` answers `''` for an arm off a page that stopped publishing its composer, and two
empty chains compared equal, so a failed readback read exactly like a match. That is guarded at
the readback rather than at the comparison — `armAt` records every arm it takes, and a row at
the foot asks the population whether each one published a chain, so a future row reading
`chainOf` without going through `sameChain` is covered by a check that already exists. No
correct build can trip it: `RenderPass` and `OutputPass` are never disabled, so the floor for a
healthy arm is two names.

**The chain rows have no mutation, and the one built for them was measured and discarded.** A
control for the chain term has to diverge the two builds' chains without moving the picture, or
the row cannot say which term did the work. `trail-gate-admits-zero` admitted a damp of zero to
the trail's gate, which put `AfterimagePass:on` in this build's chain and nowhere in the pinned
build's; three's `AfterimageShader` is `max(new, old * damp * when_gt(...))`, an identity at damp
zero. The chain diverged exactly as designed and the picture moved anyway — the worst of forty
tile means went from 0.602, 0.070 and 0.071 of 255 to 42.502, 22.141 and 27.607 — because an
enabled pass is another ping-pong through the composer's targets whatever its shader computes.
That generalises: no product edit can diverge the chain and leave the pixels, so this claim's
falsification cannot be a source mutation. `docs/instruments.md` carries the two probes that
stand in for one, with the reading that matters — a divergent chain moves the luminance ratio and
the worst tile not at all.

One row beside them **could not fail on any input**: "every parameter every row asks for
exists on this build" read `Object.entries` over a `Map`, which is `[]`, so it printed a pass
whatever the arms had dropped. Nothing was hiding behind it — `dropped` is genuinely empty on
every arm — but the thing that would have said so was the broken one. It now reads 13 arms.

Nothing in the mirror work touched these rows: with the historical arm normalised for the
sign, the two Blackwall arms read 1.21 and 1.12 of 255 on the worst of forty tile means,
against 1.02 and 0.95 for the same rows at HEAD — run-to-run noise — where an un-normalised
arm reports 22.19 and 22.14. The normalisation is what makes that comparison possible at all,
and it is why the sign appears in this tool as well as in `registry-check`.

**`registry-check` has no standing red row any more, and this paragraph used to say it had
one.** For a long time `readGhost` failed section 1b's claim that the reading at 1.0 is
bit-identical to the old `mode 2` at `f49c8339…^` — one frame of six at the branch point
`6e1be6f`, two frames at the head of the branch that recorded it. What nobody had measured was
how much it differed *by*: one byte of 921,600, at a delta of 1. `52b75cc` replaced the
equality with a two-sided tolerance taken from both ends — the noise at one byte and delta 1
below, the quietest true positive the row must catch, `ghost-alpha-term-dropped` at 156,247 to
159,539 bytes of the frame, 17.0 to 17.3% of it, at deltas of 47 to 52, above — and the passing
line now names what it absorbed rather than reporting a bare `PASS`. Both ends are measured at
the 640x360 comparison frame the tool renders today, which is where the 921,600 comes from:
640 by 360 by four channels. Read on this branch it says `6 frames, 1 within tolerance (worst 1
bytes of 921600, delta 1)`, the identical line on all 13 clean runs recorded here.
`docs/instruments.md` carries the account, the arithmetic, and the correction that moved these
figures off the 640x400 stage they were first taken at. The operational consequence is the whole
point: **a red `readGhost` row is a finding now rather than the weather**, and so is that line's
byte count climbing.

**`contour.width` lands two edges, computed in JavaScript double before either is uploaded.**
The registry's one-at-a-time and all-at-once landing rows read both components of
`contourEdges`. `contour-edges-round-in-float` rounds the operands and subtraction first; it
reddens those two rows, with the pair moving from `[0.3,0.7]` to
`[0.30000001192092896,0.699999988079071]` at the planted width `0.2`. The rendered golden arm is not the precision
proof: that one-unit-in-the-last-place change can remain within its documented image tolerance.

**It then had six standing red rows again, deliberately, and it does not any more — the middle
of that story is the part worth keeping.** Widening the zero-alpha discard from characters to the
whole hard-edged path moves the four non-additive documents, and section 1b compares this build
against a revision that predates the discard entirely — so for a while all five reading rows and
the raster row reported `6 of 6 frames differ`, at 460 to 750 bytes of 921,600 per frame with
worst deltas of 191 to 250, and the clean run read 145 assertions, 139 passed, 6 failed. That was
the approved look change arriving in the one place in this suite that compares this build against
a committed one, and re-pinning the arm to whatever the tree drew would have turned a golden arm
into a mirror.

**What resolved it was handing the arm the change rather than re-pinning it.** The arm already
patched one intentional divergence into the old source — the unprojection's mirror — and the
discard is the second entry beside it, anchored exactly once on the old build's fragment output
line and refused loudly otherwise. The rows kept their claim, which is that everything *but* the
approved changes is identical, and they went green. **The clean run is 145 assertions, 0 failed**,
measured repeatedly since and again at the end of the effect extraction against a server on 8503.
`margins-miss-the-newborn` is what says they still have teeth: it un-discards the births on the
current side alone and reddens all six plus its own planted row.

**Read a mutation's count as a total now, not as rows beyond a standing set.** While the six
stood, every list in that tool was written as rows *on top of* them, and two mutations —
`margins-confined-to-glyphs` and `glyph-margins-occlude` — put the older arithmetic back and so
reported *fewer* total reds than the clean tree. Neither of those readings survives the re-pin,
and the counts in `tools/registry-check.mjs` were re-baselined as totals afterwards. The other
rows to read alongside them are the two two-surface claims, at 19,765 of 75,239 and 365 of
184,184.

**The baseline on this branch is 0 failed at 131 assertions**, up from 89 with the glyph field's
planted sections in — 120 before the review round added the two-surface occlusion section,
the descent row, the ripple arms and the solo-key guards, taken against a server on the default port with the tool's own planted
fixtures on its 640x360 canvas. Three times after the rebase rather than once, because a single
green run of a tool with a known
intermittent in the suite beside it is not a baseline. Paired with `timeline-check` at 128/0, and
with all 22 mutation runs re-run across the rebase reddening **the same named rows before and
after** — the names being the claim, since a total can move without a name moving. The load on
the machine during each of those runs is not recorded, and on this machine another agent's run
is the normal state; what stands in for that field is the repetition, because contention here
shows up as extra reddened rows rather than as a quietly wrong number.

**One row changed verdict here and it is a fixture change rather than a fix.** The streak's
45-degree direction row had been failing its floor at 2.65% of the frame along the angle and now
passes at 4.48 along, 1.71 across; its two neighbours moved with it, 4.04 to 5.60 and 4.17 to
6.75. Nothing touched the streak. The scrambled look those rows are measured over raises
`lattice.amount` to 1 with `additive` on, which used to render a saturated white field, and the glyph
field's energy compensation divides that pile-up back down so the gradient the rows read is
there. Do not read it as the streak having been repaired, and do not compare a streak figure
taken before this branch against one taken after it — they are two fixtures rather than two
builds. `docs/instruments.md` has the case file, including the margin that row now passes by.

**The fifteen glyph and rain mutations need nothing this tool did not already need**: the same
`--url` against the same running server, no extra port, no capture of its own. Their sections
plant looks rather than sweeping parameters, which is the shape
`duotone-span-against-a-frozen-range` and `vspeed-unnormalised` already have and is forced for
the same reason — a drop-one sweep leaves every other displacement at zero, which is exactly
where a character hashed off a moved point draws the bit-identical correct picture.
`normalisation-floor-restored` goes further and cannot pick up a shipped look at all: the
alpha floor bites nearer than `pointSize / 48` metres and all ten documents sit at 9 or below,
so the row plants a large point size and a full lattice before it has anything to see.

**Three of those rows are what now holds the eight-looks-byte-identical claim.**
`glyph-leaks-at-zero` and `rain-leaks-at-zero` are the two masters asserted to be exactly absent
at 0, and `compensation-leaks-at-lattice-zero` is the third and the one with no master over it —
the energy correction rides neither, so neither excuses it. That last one is not a hypothetical
wrong implementation either: the reachable mistake it plants is the deleted design document's own
unbounded formula, which is exactly 1 at `lattice.amount` 0 only while the sprite is no bigger than the
cell, and `pointSize` reaches 64 against a cell that bottoms out at 5mm.

**Where the byte-identity evidence itself came from.** The claim that the eight `lattice.amount`-0
shipped looks render identically to a clean `origin/main` build is not one the suite asserts; it
was taken with a probe built on `registry-check`'s own page machinery, driving the editor and
hashing the framebuffer at 15 pinned program positions per look — 0 to 0.9933s over six source
frames of `captures/sample.knct` at indices 0, 4, 8, 12, 16 and 20 with three substeps each,
drawn into a 572x322 buffer inside a 640x360 viewport at device scale 1. Each build's run takes
three passes and writes nothing unless all three agree — two of them in one page, which catches
a look leaking into the next, and the third in a fresh browser context, which is the shape a
comparison run has — so "identical" is the run's own recorded
verdict rather than something re-derived afterwards, and the two builds' arms are interleaved
against one fixture whose sha256, frame indices, buffer size, camera matrix, browser build and
rasteriser string are compared before any hash is. Measured against `825a3dd`: **8 looks x 15
positions = 120 image hashes, no differences**. The control that says the harness can see a
change at all is `voxel`, which differs at all 15 positions by design. Run the same comparison
across the two `main` revisions this branch was rebased over and it reports 0 of 135 — nine
looks unmoved by `main` itself, which is context for reading the 120 rather than a second
control, since a null result cannot demonstrate sensitivity.

**`timeline-check` runs 169 assertions, 0 failed.** Section 7 is 54 of them and covers more than
one clip: the composite, the cut, and what a clip enters holding. Its fixture is five clips over
two takes, listed in an order that is deliberately not the order of their ids, and every clip in
it is uncomfortable on purpose - a two-second half-speed head, a head shorter than the look asks
for, one entering mid-hold, one whose footage starts at source 0, and one placed to stand on the
same source frame as another clip of the same take. Four of them overlap at 6.5s, which is the
budget `tools/layering-ab.mjs` measures against.

**That fixture names its primary take instead of inheriting the selected clip's take.** A prior
version copied the first open clip before replacing the clip list. A short live capture selected
by an earlier section therefore put every later retime on its held final frame and made both the
warm-history control and the growing-cache arm inert. The tool now clears inherited tracks, owns
the take for every generated clip, and requires the eight retimes to reach eight distinct frames.

Six mutations belong to it and each fires: `warm-skipped` **3 rows**, `warm-without-reset` **8**,
`draw-order-by-array` **3**, `take-not-shared` **2**, `look-broadcast` **6** and
`clip-look-reads-selection` **8**. Three things about that set are written up in
`docs/instruments.md` and are worth knowing before reading a green run: the entry-equality rows
cannot see `warm-skipped` at all, because both arms lose the warm together and agree while both
being wrong, so what catches it is a surface-memory reading taken across two clips standing on one
source frame; `warm-without-reset` had to be widened from one call site to two before it was a
mutation of anything; and the additive half of the draw order had no image arm at all until a
clip's look became its own.

**And it has an unresolved intermittent that ends a run with zero failed assertions** - about one
run in three dies with `Resulting promise was garbage collected`. Its entry in
`docs/instruments.md` carries the measurement and the dead end. A run that ends that way did not
run: re-run it rather than reading its count.

**Its two rain mutations share a section brought in for them.** `rain-accumulates` integrates the rain frame to frame instead of computing it from program
time, so a seek arrives carrying whatever the scrub built rather than the frame playback would
have drawn — which is this tool's whole subject. It could not be hung on any existing arm,
because the rain defaults to 0 and nothing else in the file raises it, so every other section
renders the term completely inert and a mutation of an inert term is bit-identical to the truth.
Section 6 applies a rain-raised look of its own before it seeks, and asserts it did — the first
row reads the uniform back at 0.8, so a section whose look failed to apply says so rather than
proving a seek matches an inert term. It reddens 2 of the 71: the seek row goes from a clean
`max 0/255, 0.000% of pixels differ` to `max 249/255, 24.795%`, against a tolerance of 2/255.

**It had two intermittents and both are fixed**, which is worth knowing before reading a red
`rain-accumulates` result as flake. Tallied over 19 runs on one day: **2 of 19** died before the
first assertion with `the stage came out 533x300 and this file's figures are 640x360`, printing
zero failed assertions on a non-zero exit, and this tool has no crash handler, so nothing in its
output told that from a catch. **3 of 19** overshot in
the playback arm's `runTo` and redden section 1's render-count row at `362 of 361`, with 124
state advances against a good run's 122. The second one was put down to file-write contention and
is not that — it reproduces at about one in five on an idle machine, and the extra render being
inside `runTo` makes it a candidate finding about the transport rather than about the check. Both
are unresolved; `docs/instruments.md` carries the signatures and the measurements.

**The second of those is fixed, and it was never `runTo`** — the sentence above stays because the
way it was misread is the lesson, and `docs/instruments.md` carries the correction in full. `runTo`
lands on its target every time; the extra render arrives afterwards, out of `openTake`'s closing
seek to the head of the take, which is enqueued while three library listings are still in flight
and lands behind whatever the tool has already started. It goes through `repaintHere` now and
stands down when something has already drawn the image. Interleaved against the pre-fix build
served through the same page route, six contending streams: **28 measured runs per arm, 10
overshoots before, 0 after.**

**And the first is fixed too, by the wait `docs/instruments.md` had already named.** The guard
was right to exist and what it caught was a race: the furniture was measured between `__kinect`
publishing and the transport existing, and `#timeline` carries `hidden` until the take opens, so
a take that opened a beat late left the strip reading zero — `338x190` is `398 − 208`, where 398
is `360 + 0 + 38`. The other signature, `533x300`, is `508 − 208`: the *initial* `360 +
TIMELINE_H_GUESS` viewport, so there the resize had not reached the drawing buffer rather than
the strip being absent. The furniture is measured after the transport wait now, and a bounded
`waitForFunction` holds for the buffer to reach 640x360 before the assertion is asked — the wait
is the accommodation and the throw is still the guard, so a run that genuinely cannot reach this
stage dies loudly naming the size it got. `keyframe-check` had the same race and a worse
consequence, since it had no assertion at all; its entry below carries that measurement.

**Read the assertion count and the fired-row names off every run of this tool, never the exit
code or the total.** Both intermittents moved a total without moving the names, and one of them
has already corrupted a record: `preroll-constant` was carried at 11 reddened rows and its honest
count is 8, the 11 having been taken from a run the overshoot was inside. The rule survives the
fixes — a tool with no crash handler still exits non-zero on a throw with nothing asserted.

**Measured after both fixes: 75 assertions, 0 failed, twice**, against a server on 8505 with the
sample capture, `stage 640x360` on both runs.

**It refused before its first assertion on this rig for a while, along with `keyframe-check`, at
`626x352` — a third signature of that guard after `338x190` and `533x300`, and the cause is the
iteration count rather than anything about the build.** The strip is a proportion of the window
rather than a fixed height, so `360 + strip + shell` is a **fixed point** the resize loop has to
converge on: the strip grows every time the viewport does, and each pass closes about two thirds
of what is left. Probed from a 640x464 viewport, the drawing buffer walks 270x152, 510x287,
594x334, 624x351, 635x357, 638x359 and reaches 640x360 on the seventh pass. Both tools allowed
three, stopped around 626x352, and threw. **Twelve passes now, and both reach `stage 640x360`.**

That it was never a regression was measured before it was fixed: four runs against the tree
carrying the projects page and one against a `git archive HEAD` tree, served on its own port from
its own checkout, all produced the identical `626x352`, and a probe reading the furniture on both
builds returns the same numbers at both viewports — strip 252, bar 38, stage 110, buffer 196x110
at 640x400; strip 339, stage 273, buffer 485x273 at 640x650.

**With the stage right, `keyframe-check` reads 166 assertions and 5 failed, and those five are not
this branch's either.** All five are section 6g's clip-drag block declining to run — `did not run:
program 5s does not hit-test back to the clip box`, which is a guarded refusal rather than a wrong
reading, and it is the press-point-in-program-time class this page already records against
`editor-check`'s deselect rows: 5s of a 243.3s program is 2% along the lane and the clip box is not
under it. Held to the same instrument across two builds — the patched tool copied into the `HEAD`
tree and run against a server spawned from it — both come back **161 passed, the same 5 failed,
with identical readings.**

**Section 7 moved every one of those totals and none of the names.** With it the tool runs 124
assertions, and the mutations that were counted against 75 redden more because there are now more
rows about the same thing to redden: `preroll-constant` goes from 8 to **20** and `preroll-none`
from 13 to **21**, each one run against `fixture-1g` - the earlier figures are from a tree without
section 7 in it, so the pairs are not two measurements of one thing. The new four are
`warm-skipped` **4**, `warm-without-reset` **9**, `draw-order-by-array` **3** and `take-not-shared`
**2**. One census pass recorded `draw-order-by-array` at zero and the same invocation then
reproduced 3 three times running, with the tail of the zero run not captured - which is the shape
the first intermittent above wears exactly, so it is written down as one rather than as a mutation
that is sometimes missed.

**`keyframe-check`** runs its cheapest claim first, on a 60-second budget, and stops the run if
it fails. That is not ordering by cost: an evaluator that announces its writes schedules a seek
per frame, each of which renders a pre-roll which evaluates, so the page never answers and
never errors - it runs out of memory some minutes later, somewhere else. A bounded probe turns
that into a sentence.

**Its section 6e stands on something nobody wrote down until it nearly broke.** The two
`page.click('.kf[aria-label="bloom keyframe"]')` calls need that diamond *visible*, and `bloom`
lives in the `post` panel group, which collapses when every parameter in it is at its
default. They work only because 6e applies the Blackwall look first and that look moves `bloom`
off its default, so the group has derived itself open by the time the click lands. That used to
be four parameters carrying it - Blackwall moves `rgbsplit.amount`, `grain.amount` and
`vignette.amount` too, and all three sat in `post` - and each of those effects now has a panel
group of its own, so `post` holds `bloom` and `crush` and Blackwall leaves `crush` where it found
it. The clicked parameter is now the only thing opening the group it is in. Nothing in either file says so, and the two ends can move
independently: a look re-graded to leave `bloom` at zero, or a change to the reveal predicate,
turns those clicks into thirty-second timeouts - which arrive as a crash with **zero failed
assertions**, the shape this repo has twice recorded being written down as a bug found. If you
touch either end, run `keyframe-check`; `editor-check`'s row 'moving one parameter off its
default opens the group that holds it' is the one that grades the mechanism itself.

**Section 6g presses two diamonds and asks first whether it can.** It keys `exposure` and `bloom`
at one playhead over a clip that does not start at zero, which is the pair that says the boundary
is scope: one lands at the playhead less the clip's in-point and the other at the playhead. Both
clicks stand on the same group-reveal the paragraph above is about, so rather than inherit that
silence it queries each control for existing, being enabled and having an `offsetParent`, and
files its four rows red naming which one was unreachable. A thirty-second timeout carrying no
failed assertion becomes a row, which is the difference this file keeps recording.

**It was three rows red on this rig, in section 6b, and it is 139/0 now — the cause was the
stage and not the drag.** The readings were `dx 0.000 against 1.068, dz 0.000 against -0.712`,
`during true, after true` and `0 levels`: the drag moved the node nowhere, so the two rows that
read the consequence went with the one that reads the gesture. `during true` was the tell —
navigation was never suspended, so the pointer-down was not taken as a grab at all.

**It was never a regression, and that was measured rather than argued.** The same three rows
failed with byte-identical readings at `9c906c4`, the revision before the install-system commit,
taken by unpacking that tree with `git archive` into a scratch directory and running *its* copy
of the tool against *its* own server. Two trees, one rig, identical output.

The class is the one the section's own comment describes: `page.mouse` is viewport-relative and
the projection is canvas-local, so the drag point is built by adding `#stage`'s rect. That
correction was right about the *origin* and every figure in the file was wrong about the *size*.
Two things caused it and they compounded. `#timeline` carries `hidden` until the take opens, and
the furniture was measured *before* the wait for the transport, so the strip read zero; and the
strip was the only furniture measured at all, while the application bar sits above the stage and
takes its own height. Both subtract from the same place, so the stage came out `360 - strip -
shell` and then letterboxed 16:9 inside it. **Measured on this rig: 270x152, which is 0.42 of
the size every number in this file is written in.** An earlier reading of 510x287 is the same
fault with the strip measured and the bar not.

The fix is the wait and the second measurement, plus a bounded wait for the drawing buffer to
follow the resize — `setViewportSize` returning is not the renderer having resized, which is the
other way `timeline-check` has been recorded reading a short stage. **And the assertion**, which
this entry used to say was the fix worth making and which is the guard rather than the repair: a
tool whose figures are in stage pixels now refuses a stage that is not the one its figures are
in, so the next thing that moves the furniture is a loud throw rather than three rows describing
a feature that works as gone. Measured after: `stage 640x360`, **139 assertions, 0 failed**.

**`jobs-check`** spawns its own server and drives real jobs through `tools/render-worker.mjs`,
so it needs a GPU browser and ffprobe. `--no-render` drops that whole block and says so - the
queue rows are seconds and each render is about a minute.

**Its mutation runs are no longer all `--no-render`, and reading them as though they were is
how a control gets recorded as green without running.** The split is by *which* mutation and
never by a number: anything whose rows live in the render block needs the browser, and
everything else is queue semantics and wants `--no-render`. Four are in the first group as this
is written - `heartbeat-stops-on-first-error` and `worker-door-waved-open` name lines in the
worker that only a claim reaches, and `preflight-snapshot-is-taken-once` is read off two jobs
one worker takes in sequence, which needs the loop to run at all. Take the names from the tool's
own refusal rather than from a count written here - this paragraph used to carry one and it was
wrong, which is what a count in prose beside a list that grows does to itself, and enumerating
from the refusal is what `sweep-all` already does for the same reason. A reader who takes "its
mutation runs use `--no-render`" as a rule runs one that needs a render without one, and it
passes.

**The worker under test is the staged copy, not the repo's.** `jobs-check` copies `server/`,
`web/` and `tools/render-worker.mjs` into `.jobs-check/root` and spawns from there, because a
mutation naming a file nothing runs reports a miss that is really a control that never applied.

**The heartbeat row runs the whole render through a forwarding proxy**, which destroys the
socket on the first `POST /jobs/<id>/heartbeat` without answering - `ECONNRESET` at the
worker's `fetch`, the one class of failure that is neither a 409 nor a status code. A worker
has one `--url`, so the proxy also carries the page load and the export WebSocket, handling
`upgrade` by piping the raw sockets both ways with the headers verbatim - `Host` included,
since the page's `Origin` names the proxy and `originAllowed` compares the two. If that row
fails with anything about the export, the page or a closed target, the proxy is the suspect and
the finding is not the heartbeat. What discriminates is the record's `heartbeat` against its
`claimed`: `claim` stamps them equal, so a worker that gave up on the first failure finishes
`done` exactly like a healthy one and only the timestamp says it went quiet.

**The worker reads its renderer class out of the browser it will render in and cannot be told
one.** `channel: 'chromium'` rather than the bundled headless shell, which has no GPU and falls
back to SwiftShader - a class nothing else can reproduce, which the worker refuses outright
rather than pinning jobs to.

**`vcam-check`** spawns its own server on 8361 and needs none running, but it needs a capture at
`captures/sample.knct` to loop, ffmpeg and ffprobe, and a GPU browser for section 5
(`--no-browser` drops it and says so). It writes takes into its own staged tree, so it never
touches `captures/`.

**It also needs this machine to have a non-internal IPv4, and exits 2 when it has none.**
Section 6 is the only arm in the repo that creates a webcam subscriber which is not on
loopback, and it makes one the way `guard-check` does: a server widened with `--host 0.0.0.0`
and a subscriber arriving on this machine's own LAN address. Without a second address there is
nothing the loopback exemption can be asked about, so the run prints `UNPROVEN` naming the
missing address rather than passing quietly — `guard-check`'s answer to the same condition,
not `monitor-check`'s, which turns it into a failed assertion. Both exit-2 reasons carry their
own remedy now, because the verdict line used to append playwright's advice to whatever it was
given and would have told an operator missing a LAN address to install a browser.

**Its own server-readiness wait is on the sensor rather than on a constant**, and that was a
bug rather than a nicety. `viewer on` is printed inside `httpServer.listen`'s callback, which
is before the grabber has been spawned at all, and this grabber reads a 138MB capture and runs
a 1080p ffmpeg encode first — measured at 3.8 to 4.7 seconds on a loaded Mac and never under a
second on an idle one, against the 400ms the tool used to allow. Sections 2, 3 and 4 were all
questioning a server with no sensor behind it, so the endpoint 503'd, no take gathered a frame,
and every row read as a finding about the webcam. `start()` now polls `/record/state` until
`webcam.available`, which is the right flag because `server/webcam.js` only ever clears it on a
hello with colour on, and reads without subscribing — which section 1 needs, since its first
row is about what happens while nothing is subscribed. That row was the second casualty: it
passed on an empty emit log, which is as true of a grabber that never started as of one running
with colour off.

**Its discriminator is geometry rather than resolution, and that is the whole design of the
tool.** The webcam's claim is that it serves the colour camera and not the registered 512x424
image the point cloud is textured with — and an implementation that upscaled the registered
image to 1080p would pass every dimension check there is. What it cannot pass is a margin: the
colour camera sees 84.1° where the registered frustum sees 70.6°, so a real colour frame carries
content down the sides that no upscale can invent. `fake-grabber --hd` builds the fixture as
*the registered frame upscaled* plus a magenta left margin and a cyan right one, so a cheating
implementation matches most of the picture and still fails on the 12% at each edge. Run
`--mutate hd-upscales-registered` and read which rows fire: the two margin rows, the
passthrough row and the re-encode row. `--mutate hd-reaches-recorder` fires the two rows about
the take, and only those. A control that failed on a neighbouring row would not be a control
for the thing it names.

**`hd-upscales-registered` reddens neighbouring rows on a contended machine, and that is a
defect in the control rather than a finding about the code.** It runs a synchronous 1920x1080
ffmpeg scale on the server's event loop *per colour message*, so the stream starves — over four
`--no-browser` runs on one Mac spanning one-minute load averages of about 25 to about 95, its
four named rows fired in all four, `and the subscriber is actually being served parts` fired in
two, `the take carries a hello and frames` fired in two, and exactly one run showed neither.
Read the four named rows and treat a fifth in section 1 or 3 as the harness competing for the
machine. Memoising it the way
`hd-reencodes-in-flight` is memoised would fix the starvation, but not for free: the registered
image varies across the fixture's 284-frame loop, so a memoised upscale serves one constant
frame and `and nothing re-encoded it on the way through` would go green — which is a decision
about what that control is for, not a tidy-up, and it has not been taken here.

**The margins say the picture is right and only the emit log says the bytes are.**
`--mutate hd-reencodes-in-flight` decodes the colour payload and re-encodes it at the same size
and a comparable quality, so every geometric row still passes and exactly one fires: `every
served part is the same JPEG the writer emitted`. It fires because the writer's emit log now
carries a fourth column, the sha256 of the part body a reader receives, which is what makes
comparing the two ends possible at all — a colour payload is a u64 stamp then the JPEG, the
stamp moves per frame, and the row that used to be here hashed a served part against the set of
served parts and was therefore true whenever a part arrived. Both readers of that log
destructure positionally and ignore the fourth column, so adding it changed no behaviour; if a
fifth is ever wanted, that is the moment to give the log a header line instead.

The mutation memoises its re-encode, and that is load-bearing rather than an optimisation: a
synchronous 1920x1080 re-encode per message starves the stream until `a frame was served at all`
reddens instead, and a control that fires for a neighbouring reason is not a control. The memo
costs nothing in fidelity because the fixture's colour payload carries one constant HD frame.
Its own falsification is the pair: the same mutation printed NOT CAUGHT with 0 failed against
the row as it stood before, and prints `caught, as required` with 1 failed after — which is
also what discriminates a real catch from ffmpeg having silently failed, since the mutation
falls back to the original bytes when it cannot run.

**`--mutate refusal-ignores-webcam`** deletes the webcam clause from
`consumersCostingTheTake`, leaving the monitors one, and must fire exactly the two section 6
rows that assert the refusal — never the third, which is the operator accepting the cost, since
a take that was already permitted stays permitted. Section 1's `a loopback subscriber does not
refuse the take` is a row that mutation makes *more* true, which is why it could never have
stood in for the arm that creates a remote one.

**That row is the control for the other direction**, and it was tested rather than reasoned
about. `Webcam.subscribersCostingTheTake` is written as a filter over `describe()`, so a
`describe()` that stopped publishing `loopback` would silently make it return every subscriber
and charge every proof tool in this repo for its own localhost connection. Forcing the rule to
`return this.describe()` reddens three rows — the section 1 one by name, and the two in section
3 that need a take to start with a loopback webcam attached.

**`monitor-check`** spawns its own server on 8341 and needs none running, but it needs a
capture at `captures/sample.knct` to stream and a GPU browser for its renderer sections
(`--no-browser` drops them and says `UNTESTED` rather than passing quietly). Read its three
`....  waited Nms after load for ...` lines before you read its rows: each is what one
browser section waited for its page to publish before driving anything, printed rather than
asserted because there is no threshold here worth gating on, and the number is the headroom
a slower machine has left. On an idle Mac they run 15 to 18ms, 92 to 94ms and 60 to 68ms.
**A wait that runs out there is not a row.** The two decimation sections let it throw, so the
run ends `DID NOT RUN` naming what never arrived — which is what stops a `--mutate` run
counting a viewer that never came up as the mutation being caught. Only the colour section
turns it into a failed row, because there "the page never booted" and "colour never arrived"
are different findings and it is the one place that can tell them apart.

**Its renderer section rebuilds the capture index every run, and that is deliberate**: it
symlinks the sample into its own staged tree, so the sidecar the first open builds lands
there and is deleted with it. Warming `captures/sample.idx` therefore does not reach that
section — it reaches the `--replay` server in the section above, which serves the repo's own
capture. So a red `the frame API served frame 7 of the sample at every divisor this compares`
is a server still indexing 138MB rather than a finding about decimation, and it is the row to
suspect first on a contended machine now that the boot sleep no longer stands between the
page load and that fetch. Stated rather than measured: that row passed on all six runs behind
this paragraph, and every one of them was on an idle machine.

**`export-check` has the same shape and a bigger number: 10 of its 66 rows are red on the
synthetic sample and none of them is about the build.** Nine are the resolution-invariance
family — `trails`, `rgbsplit`, `scanlines`, `grain`, `bloom`, `nobloom`, `full`, `regionpush`
and `regionmask` each asking that 1920x1200 is 960x600 at twice the size — and the tenth is the
crop's cull row. They compare fine structure and coarse means between two renders of the same
look at two sizes, and `make-sample`'s three surfaces carry no depth jitter and no sensor noise,
so the structure those rows correlate is aliasing rather than anything in the room. Measured
against a clean checkout of the merge commit `3b7ab90` and again on the effects branch: **the
same ten rows, at identical numbers to four figures** — `trails` at a coarse mean of 2.732 on
both, the crop row at 110 revealed and 314,021 lit against 410,577 released on both. That
identity is the useful part rather than the count: a change that moved any screen-space term
would move these numbers, so reading them as equal is a stronger statement than reading them as
red. Take the baseline before believing this tool has found something, and compare the numbers
rather than the pass count.

**`registry-check`'s crop and snap rows are placed against a capture, and `make-sample`'s is
not that capture.** The scrambled set authors `near` 0.35 and `far` 4.2 and places the four
lateral faces against a cloud running x [-2.31, 2.97] and y [-2.26, 1.63], while
`tools/make-sample.mjs` builds its back wall at z = 3.2m and its sphere at 1.55m with a 0.28m
radius — so the whole synthetic cloud sits inside the depth pair and there is nothing for it
to cut. Run against the synthetic sample the tool therefore comes back **FAIL (3)** on a tree
with nothing wrong with it: the drop-one sweep reports `unexplained: bottom snapDelta`, the
count lands at `92 of 97 parameters are proven to reach the pixels`, and the crop's second row
reports `identical with only near/far authored`. All three are the fixture rather than the
build, and `snapDelta` at 410 is the same shape — a threshold the synthetic motion never
crosses. Measured on a clean checkout of the merge commit `3b7ab90`, so a run of this tool
that reports three reds and these three sentences has found nothing. A machine holding real
footage sees them pass, and a change that takes the count past three has moved something.

**`guard-check`** spawns its own servers and needs none running. It exits 2 when the machine has
no non-internal IPv4, because "not listening on the network" is only a claim if there is a
second address a client could have arrived on. Every refusal it asserts has a positive twin, so
a server that refused every upgrade, or bound to nothing, fails it rather than passing quietly.

**`library-check`** takes no `--url`; it spawns what it needs. `plant-open-take` is the mutation
worth naming beside it rather than a milder one: it is the control for the hole that let a read
route destroy the take being shot.

**It binds a span of fixed ports** — `--node-port`, and `--mac-port` through `--mac-port + 16`,
defaulting to 8210 and 8211..8227. Two worktrees running it at once did not get an
address-in-use error, they got each other's server: one run stat-ed `three-warning-take.knct`,
a fixture belonging to the other tree, and reported itself as not finishing. The quieter half
of that same collision is in `docs/instruments.md`, because it fails in a way that reads as a
finding — most recently six recorder rows reporting `undefined counted, -1 on disk` when
`MAC_PORT + 9` belonged to somebody else.

It now **refuses the run rather than discovering this halfway through**: `reservePorts` asks
the kernel about every port in the span before anything spawns and exits 2 naming what is
held, `startServer` throws if its own child exits instead of listening, and it refuses a port
outside the declared span so a section added at `+17` is a failure rather than a hole. Pass
`--node-port`/`--mac-port` a range nothing else holds.

**Two more collisions inside the span, and both were silent.** An offset two sections both
reach for binds without complaint, because the first holder is dead by the time the second
starts — what is left is two entries for one port, and every `servers.find((s) => s.port ===
n)` in the tool answers with whichever was pushed first, which is the dead one. Measured when
it happened: the respawn-backoff section read another section's log and reported `0 exits`
against a log carrying twenty-two deaths, which reads as a finding about the supervisor and is
a finding about the reading. `startServer` drops the stale entry at the claim now — not at the
lookup, because a section that only starts a server and never reads its log still poisons the
one that does — and keeps it on a retired list the cleanup still walks.

The other is a `--node-port` chosen *inside* the mac span, which the free check deduplicates
away: both pass, the run starts, the node binds the shared offset first and is still live when
a section reaches it, and the retire path then drops a running server off the cleanup list. The
operator sees an EADDRINUSE several sections in, naming neither the overlap nor the node. It is
a fact about the arguments, so `reservePorts` now answers it from the arguments and exits 2.

**Three rows in it are flaky under machine contention, and they are written down here so the
next person does not spend the afternoon on an innocent change.** Two are in the
marks-on-the-scrubber section and are the same race: `and it is stamped in source milliseconds
rather than program time` seeks the editor to program 1.0s, awaits `settled()`, presses mark,
and asserts the written `sourceMs` is within 40ms of `sourceSecAt(1.0)`, while `stamped inside
the footage it flags rather than at an arbitrary offset` asks that the mark land within the
take. Observed failing as `0ms against source 150ms` — the playhead still at program zero when
the mark was taken — and as `934ms into 425ms`. Neither is fixed: `settled()` resolving before
the transport's program position has moved is a page-timing race in the editor, not a property
of anything the section is about.

The third is `and when the reader lets go the descriptor is closed rather than left for the
collector to throw over`, which reports `real 19 against a baseline of 18` and whose own comment
in the file already calls it measured-flaky. Its settle is a fixed 250ms against a collector
measured to take 300ms to 1s, so it is sound on an idle machine and arithmetic on a loaded one.

What says all three are the rows rather than the change under test is that they fail on
unmutated trees as well as mutated ones, and disagree with themselves across runs of one tree —
the descriptor row was green at load 70, red at 250 and green again at 276 on an identical
checkout. A run that reddens only these on a busy machine is a re-run, not a finding, and per
the rule at the top of this file that judgement comes from reading *which* assertion fired,
never from the exit code.

**Under a mutation they are worse than noise, because they land on top of a count.**
`open-ignores-format` carries its claim *as* a number — six, and the doc above says which six —
so a marks row arriving alongside them prints `7 failed` or `8 failed` and reads as a control
that over-fired onto rows it was supposed to leave green, which is the one failure shape that
would mean the band had stopped being a single predicate. Measured twice on the merge that
brought the two together: `7 failed` at load average 71, the intended six by name and one marks
row seventh; and `8 failed` at load average 270, the same six and both marks rows. Compare the
names against the six rather than the total against six, and re-run before recording a spread —
the same tree's baselines passed those rows at other moments, which is what a race looks like
from the outside and what a real interaction would not do.

**`--mutate exit-keeps-the-child-reference` reddens exactly two, and its section is the one to
suspect first on a loaded machine**, because the whole of it is a message that has to land
inside a 1000ms respawn backoff. The two are `the next failure is still reported lost` and `and
it still counts toward the backoff`; the three rows above them are provenance and must stay
green, since they are what separates a control that missed from a fixture that never reached the
window. Read the printed `colour camera on - ...` line beside them either way — `restarting
grabber` says the mutation reached the branch, `takes effect on the next spawn` says it did not,
and the assertion count cannot tell you which. Both claim rows assert an order and a ratio
rather than the presence of a word, and `docs/instruments.md` carries why: the earlier versions
passed the mutated build, which reddened nothing and exited 0.

**Two takes carry the capture format's band, and the second is the one that keeps the archive
readable.** `future-format-take` declares a generation this build has never read and is
otherwise an entirely ordinary take — whole frames, a readable hello, intrinsics in range —
because "nothing here knows what these numbers mean" is a condition with no other symptom.
`generation-zero-take` declares no `format` key at all, which is what `captures/sample.knct`
itself is and what every take shot before the field existed is; it is planted under its own name
rather than left to the takes that are generation zero incidentally, since a band written as
"refuse anything unfamiliar" passes every row about the first take and shuts the whole existing
archive out of the editor.

`--mutate open-ignores-format` is the control and it edits one line of `web/format.js`, which is
the point of it rather than an implementation detail. **There were four doors deciding whether a
take may be opened and there are two**, which is the change the refusal table made: `openable` in
`describeTake` and the library's badge and dead Open button were three separate comparisons, and
the last two now quote `openRefusals` instead. What is left is `OPEN_REFUSALS.format`, which
delegates the sentence, and `openTake` in the editor, which is handed a hello and never a
manifest — so `format.js` is still where the band lives, and a comparison inlined at either door
would still pass every row here and drift the first time the band gains a member.

So the assertion the mutation really carries is the *count*, and it is re-measured rather than
carried forward: it reddens **8 of 527** — the listing's `openable`, the refusal the take carries,
the two-table containment row, the library's badge, its `New project from this take` button, the
sentence in that tile's `⋯` menu, and the editor's note and its refusal to open. The count grew
when the surfaces stopped deriving, which is the right direction: quoting one sentence in five
places means a band that stops refusing is visible in five places rather than in one. The takes
that must stay green stay green — both `no-hello-take` rows, `local-clip`'s
`dateSource === 'hello'`, and all four generation-zero rows. A mutation that reddened fewer would
mean the band had quietly become several predicates that agree.

**The count is the same 8 it was and one member of it is a different row, which is why the
enumeration is what to read and not the total.** This paragraph used to name "the library's badge
and its Open button, the menu's sentence": the Open button is `New project from this take` now,
and the *menu* in that list was the main menu's resume sentence, which left with the EDITOR tile
and could not be replaced by nothing without the count falling to seven. What took its place is
the tile's own `⋯` menu, which quotes the same refusal — so the band is still visible in the same
number of places, arrived at by a different set of them. Measured on the tree that carries the
projects page, against a clean run of 527. The media picker draws the same warning badges and is
**not** in this set: the take it refuses in this suite is `hello-no-frames`, which carries a
`short` refusal rather than a `format` one, so this mutation does not reach it.

**Its opposite number is `--mutate openable-recomputes-the-band`**, which puts the band back to
being a term in `openable` rather than an entry in the table, and it exists because
`openable` is false either way. Every row asking whether the future-format take opens passes a
build where the band decides for itself again — re-measured beside its opposite number on the tree
that carries the projects page: **5 of 527**, the refusal the take carries, the two-table
containment row, the row asking that `openable` is its refusal list being empty, the badge over
the poster, and the sentence in the tile's `⋯` menu — the same count it had, with the main menu's
sentence out of it and the tile's menu in, exactly as `open-ignores-format` above. The three rows that
brought the band into this suite are all still green under it. What reddens is what the take
*carries*: the refusal itself, the containment row now declaring a `format` nothing produces, the
badge over the poster and the sentence in the menu. **When a merge collapses two derivations into
one, the row that proves it needs a mutation that restores the other — the shared predicate
cannot tell them apart, which is why they were able to disagree.**

Reaching all four needed the harness to stage `web/` mutations rather than leaving them to the
browser route interception, because `server/library.js` imports `format.js` by path: served to
the page and not staged, the server would have gone on deciding `openable` on the unmutated band
and the control would have reddened the page's rows only, reading as a partial break in the
product rather than a half-broken build. That is what put the tool briefly on two delivery
mechanisms and is why it is now on one — see the Mutations section above for the collapse and for
what `requireMutationDelivered` asserts.

**`syntax-check` also holds the hello to `docs/architecture.md` and the format constant to the
grabber**, in both directions and without importing either. The prose block documented nine keys
against the thirteen emitted for long enough that the four it omitted became the argument for the
check: `startedAt` is the only durable capture date a take has, so a second producer written
against the documented nine writes takes the library dates by file modification time, which
changes the first time a take is copied off the node and degrades quietly, because that fallback
is legitimate and reports `dateSource: 'mtime'` rather than failing. The document side is cut to
the `type 1  hello` stanza — two spaces, which is what the tool matches on — and stops at
`type 2`, the grabber side to the one `snprintf` that builds the hello, and an empty extraction
from either fails — zero keys means the anchor moved and the comparison ran on nothing.
`CAPTURE_FORMAT` is read textually out of `web/format.js` and `native/grabber.cpp` and
required equal, because this tool takes `--root` and an import would bind the assertion to this
checkout while claiming to have checked another tree.

**That stanza lived in `README.md` until the README was cut back to the usage path**, which is
why this paragraph and the controls below name their file in every sentence. A runbook still
saying README would have had an operator add a key there, watch the check stay green, and read
that as the check having no opinion — a falsification control that falsifies nothing is worse
than not having one, because the whole of what it buys is a reader's trust in the assertion.

Its three controls are run by hand, in the idiom the `tools/` and `docs/` blocks already use.
This tool does carry a `--mutate` harness, and its table holds **six** entries — one for the
specification row, two for the shell rows and three for the citation walk. Not one of them is
about the hello or the format constant, so nothing in *this* block has a named mutation, which
is worth stating rather than leaving to be inferred: a reader who saw the flag and the six names
would otherwise read a green mutation run as a control over these assertions too. The sentence
here said "one entry" for as long as there was one, and went on saying it through five more —
which is what a count in prose does to itself beside a table that grows, and is the same failure
this page records against `jobs-check`'s mutation count two sections up. Take the names from the
tool's own refusal, which is what `sweep-all` and the CI step both do for exactly this reason. Add a key to the grabber literal
and not to the stanza; add one to the stanza the grabber does not emit; bump the constant in one
language. Each must fail naming what it found — measured, in that order: `the grabber's hello
emits exposure and docs/architecture.md's type 1 hello does not document it`,
`docs/architecture.md's type 1 hello documents exposure and the grabber does not emit it`, and
`CAPTURE_FORMAT is 2 in web/format.js and 1 in native/grabber.cpp`. Each is one failed assertion
against a baseline of zero. The first of those three is worth doing carefully: the obvious
`perl -pi` one-liner silently matches nothing against a C++ string literal full of escaped
quotes, and a mutation that did not apply reads exactly like a check that missed one.

**`editor-check` enumerates rather than lists, and it exists because the suite tested the model
and never the control.** The clip in/out markers were detached from the document during boot
for the whole life of the feature — `rebuildLanes` cleared `#tBeds` of every child that was
neither `.ruler` nor the playhead, and `#tIn`/`#tOut` were neither. Nothing caught it because
nothing looked: no proof tool referenced `#tIn`, `#tOut` or `.tcut` at all, and `export-check`
drives in/out through `activeDeliverable`, which is the model. The model was perfect throughout;
`paintTimeline` simply wrote `style.left` onto two nodes no document contained. So section 1
walks every interactive control the page renders and fails on any it has no driver for, with
`plant-unswept-control` as the control for that claim — without it, "every control was tested"
is a sentence the tool writes about itself. **Aiming its layout mutation took three attempts,
and the two misses are recorded in the file** because each was NOT CAUGHT against a build with
a fix removed: the rule they named had been made redundant by the two-row bar, which is worth
knowing about the fix as well as about the check.

**That sweep reaches into `<dialog>` as well as the strip and the panel, and what an uncovered
control means depends on knowing it.** The selector names the element rather than any dialog's
id, so a modal added later is asked about by existing rather than sitting outside every
observation — which is what a body-level `<dialog>` does by default, since it is a sibling of
`#panel` and not a descendant. **The load-bearing part is not visible from the selector: the
dialog's rule is tested *ahead* of the panel's inside `covered()`.** The panel rule matches any
checkbox under `#panel` and credits it to `registry-check`'s drop-one sweep, which drives
sliders and knows nothing about a preset dialog, so the two rules in the other order hand the
dialog's 54 checkboxes to a driver that never touches them and section 1 goes green over an
untested surface. That is the misattribution the `DRIVER_RULES` array was re-keyed to prevent,
arriving as an ordering rather than as an index. A row that reddens for a control inside a
dialog is therefore a coverage failure like any other and not an artifact of the widening.

**Section 5's ease rows carry two fixture traps, and both were found by a row that refused to
go green.** The first is that a segment's control polygon belongs to *two* keys: pressing
`glide` on the key you have selected writes its outgoing side and leaves the next key's
incoming side wherever it was, so a fixture planted bent and then "fixed" with `glide` still
reads 0, 0.2, 0.4, 0.1, 1 — crossed, and crossed in a way that looks tidy. `ends` is what
writes a whole polygon, because it writes the departure and the arrival. The second is that a
synthetic drag has to be aimed at a coordinate the browser will deliver *and* at an element
that will receive it: `.tcut` is a full-height clip marker parked over the head of the strip by
section 3, so a handle drag planted at 1s and 5s pressed the marker instead and the handle it
meant to move never moved. Both failures read identically from the assertion — a handle sitting
where it started — and neither is distinguishable from a clamp doing its job, which is why the
row asserts the point *landed on its neighbour* rather than that it stayed inside a bound.
`document.elementFromPoint` at the press coordinate is what separated them, and it is the first
thing to reach for when a synthetic drag appears to do nothing.

Its `handle-clamped-to-the-segment` mutation is the control for that row, and it is only
visible on a control point that is not index 0 — with one point a side, the neighbours *are*
the segment's ends and the two clamps are the same clamp. Every other handle gesture in the
file grabs the first `.thandle` in DOM order, so before this row the indexed drag had nothing
asking about it at all.

Its `nav-at-the-foot` mutation is the control for section 1's second claim, that the way out of
the editor is *reachable* rather than merely present. Its own two flaws — a probe in a dead zone
and a probe that moved the page it measured — are in `docs/instruments.md`, because both are
instances of rules that were already written down.

**Sections 13 and 14 need the state the sections before them leave, and both say so in their
own terms.** Section 13 counts lit pixels across a resize, and it presses "sensor view" first
rather than measuring whatever twelve sections of orbiting and exporting happened to leave —
inherited, the same claim measured 1543 lit pixels on one run and 89,625 on another, which is a
row whose margin depends on what ran before it. It also takes the chrome off, because the camera
path and the top-down inset live on a second canvas that `placeChrome` repaints regardless, and
those are exactly the pixels a blank-stage build still has. Section 14 hands documents to
`restoreProject` and asserts its own cleanup landed, because the build it matters on is the one
that accepts what it should refuse: a `renderScale` track surviving into section 15 is
`resize()` once per rendered frame there, which arrives as a hang rather than as a row.

**Its deliverable rows size their fixtures off the take rather than writing numbers down.** The
block used to plant a trim at a flat `in: 20, out: 40`, which the clip clamp holds inside a
30.362s sample — so the row meaning to assert that the menu applies a trim would have been
asserting the clamp instead. They are now read off the measured duration, and the one deliberate
exception is `editor-check-past`, planted at 1.5x the duration precisely so that it misses.

**Section 13 used to carry a family of flaky resume rows, and the rows are retired rather than
renamed.** They tested the hidden working document and the chip that offered it back, and both of
those are gone, so a name out of that block is a name nothing in the tool answers to any more.
What is kept is how the noise was told apart from a defect, because that argument outlives its
subject. Measured across twelve runs on two builds during one session: **6 red, 6 green, with the
block's precondition row green every time**, so the fixture built and the ordering simply came out
differently. It waited on a fixed 3000ms hold and a fixed 6000ms settle.

What identified it as the rows rather than the change under test is the same evidence
`library-check`'s entry rests on, in a sharper form: **which member of the family fires rotates
between windows.** Four different subsets were observed across two builds — three of them a
single row each, and the fourth none at all — with the precondition green every time and both
final baselines passing all of them. Three subsets would already be suggestive; four is the
statement, because **an ordering bug picks the same row.** A family that reddens a different
member each window is a re-run, not a finding.

One thing made it worse than ordinary noise, and that part is still live. A polluted `projects/`
store is the first suspect and the cheapest to rule out, because anything that has been driving
the editor by hand against the same server leaves real autosaves and deliverables behind it; take
the re-run against a clean store rather than the one that just failed.

**Four controls went with those rows, and what each of them guaranteed is written down here
because a control removed in silence is a guarantee removed in silence.**
`offer-ignores-take-hash` held the offer to joining on the take's content hash rather than on its
id, so a freed id reused by a later take could not resurrect an edit cut on different footage.
`resume-fetches-the-moving-name` held the press to restoring the document that had been offered
rather than re-reading the name, which the auto-save moves under it between the offer and the
press. `resume-restores-without-keeping` held a restore that could not be written back to throwing,
rather than leaving the screen and the file disagreeing in silence. And
`resume-waits-for-every-list` held the offer to being made of the projects listing alone, so a
neighbouring listing that refused did not hide somebody's work. All four name mechanisms this
build does not have.

**What section 13 is about now is the revision rule, and it needed a second page.** Every row
about a write being refused needs a page that holds a document, and the page this tool drives was
opened on a take — which holds none and writes nothing at all. So the block opens a second page on
`/edit?project=` in the run's own context and through `serveMutation`, because a bare `newPage`
takes the tree's own source and would put two builds inside one measurement. The falsification
control comes first and is a presence, for the reason `boot-check`'s undo section gives in the
same words: on a build that never writes, a refusal is indistinguishable from silence and every
row below it passes. Then two commits in one page-side turn must both land, a second writer moves
the file, this tab's next change is refused, the banner stands, the refused change is still on
screen and still undoable, the tab stops writing, and Duplicate on the banner mints a copy that
carries the work. `autosave-reads-the-revision-outside-the-queue` is the control for the first of
those and the successor to `resume-races-the-autosave`: it hoists the revision read out of the
queued task, so a burst names the revision its own predecessor replaced.

**And the assertion that no fragment of the saved-project controls remains is rewritten rather
than worked around.** It was written when the picker left with the timeline information bar, and
project UI exists again — a projects page, a rename modal, and a File menu that acts on the open
document — so "no fragment" is no longer the claim to make. What is asserted now is both halves:
`tProject`, `tProjectOpen`, `tResume`, `tResumeWhen` and `tResumeOpen` are gone, and what replaced
them is *reachable* rather than merely present, which is what the old row was really about. On a
page opened by a take, Rename and Duplicate are greyed and say why, which is the same fact the
rows below it are about from the other side.

**Two `editor-check` sweeps must never run at once, and neither may `web/` be edited under
one.** This cost two whole measurements in one session. A sweep straddling a `web/main.js`
edit produced five runs at 389 assertions and a sixth at 396, because the build changed
underneath it; separately, two concurrent runs against one server produced the rotating
resume failures above. Hash the files the run depends on before the baseline and again after
the last mutation, report the hashes with the numbers, and check
`pgrep -f "tools/.*-check.mjs"` before starting — on this machine another agent's run is the
normal state.

**Its mutations are delivered by the file they name, and two of its exit-2 refusals are about
that delivery rather than about the build.** Whatever file a spec declares is served to the
page at the path a browser asks for it at — `web/index.html` is the document `/edit` and
`/record` are, and a module or stylesheet under `web/` is its own path — and the run refuses if
the page never asked. `DID NOT RUN - <name> was staged for <file> at <path> and the page never requested
it` means the module is one this surface does not import, and the same sentence naming the
recorder page means it reached the editor and not the recorder, which takes the run to
`UNTESTED` even when the editor arm caught the mutation. `DID NOT RUN - <file> is neither a
module or stylesheet under web/ nor the document /edit is served from` is refused before a
browser launches at all. Neither is a finding, and neither used to exist: a spec naming a third file was served
nothing and reported `NOT CAUGHT` against the tree's own source. `docs/instruments.md` carries
the case.

**The effect rack has controls for presence, focus and geometry.**
`effect-rack-ignores-racked` removes rack membership from the group derivation while leaving Add
itself working, and reddens the one row that returns a racked effect to its defaults and still
expects its group open. `effect-rack-strands-focus` removes the common focus-return path and
reddens the Escape row alone. `effect-rack-keeps-fixed-left` removes both responsive placement
rules and reddens the 520px and collapsed-panel rows. These are separate mutations because a
single broken sidebar could otherwise redden all three claims without saying which contract the
instrument observed.

**Section 24 covers flight, look drags, the lens wheel and control focus.** Shift enables flight
at one speed. Each mutation names the exact row that must fail. Another red row cannot stand in
for it.

- **`fly-leaves-the-pivot`** drops the `controls.target` half of the translation. The camera still
  flies and the row about the view direction stays green; what changes is that the orbit's radius
  grows instead of the standpoint moving, so a drag afterwards swings the cloud across the frame.
- **`fly-up-is-the-cameras-up`** swaps `web/fly.js`'s pole for the camera's own local Y. Those are
  the same vector while the camera is level, which is why the E row poses it at `(0, 2, 0)` looking
  down at the pivot first and asserts the pitch is real before it flies.
- **`fly-moves-while-typing`** moves the keydown block above the typing guard, so a `w` in a
  filename flies the camera while it is being typed.
- **`fly-survives-text-focus`** keeps an existing flight hold after a text field gains focus.
- **`fly-survives-blur`** removes the listener that releases every held key when the page loses
  focus. A key released outside the page never arrives, so the camera then flies until something
  else stops it.
- **`fly-ignores-the-program-camera`** takes `controls.enabled` out of the gate, which is the
  program camera, a gizmo drag, a node drag and the crop drag in one term.
- **`fly-redraws-cancelled-keys`** treats a non-empty held-key set as movement even when opposite
  keys cancel. The camera stays in place, but the parked loop keeps rebuilding the same frame.
- **`fly-reuses-old-clock`** removes the event-side clock reset. A release and new press between
  animation frames then inherit the old hold's time and jump by the stall cap on the first frame.
- **`fly-never-settles`** removes the `orbitSettling` the release arms, so a flight ends on the
  draft-quality frame the hold was redrawing rather than on an accurate seek.
- **`fly-rehomes-reset`** calls `saveState()` after the translation. It is `pick-rehomes-reset`'s
  defect through a second door: Reset stops going anywhere known, which on the Pi's collapsed panel
  is the only way back.
- **`fly-ignores-the-shift-gate`** allows an unmodified key to fly.
- **`fly-takes-the-key-only-with-shift`** prevents flight when Shift arrives after W.
- **`fly-stops-during-a-look`** stops translation while the pointer turns the camera.
- **`typing-guard-takes-every-control`** makes a focused slider swallow flight shortcuts.
- **`typing-guard-takes-adjustment-keys`** takes arrow keys away from a focused slider.
- **`look-orbits-the-camera`** moves the camera instead of turning it in place.
- **`look-shrinks-the-pivot`** changes the orbit radius during a look drag.
- **`look-ignores-the-lens`** uses a fixed turn rate instead of the camera's field of view.
- **`look-drags-backwards`** reverses horizontal look; **`look-pitches-backwards`** reverses pitch.
- **`look-tips-past-the-pole`** removes the pitch limit. Each pole is reached in one pointer move.
- **`look-never-settles`** omits the accurate seek after the pointer is released.
- **`look-survives-blur`**, **`look-survives-capture-loss`** and
  **`look-survives-camera-switch`** each leave a drag active after its owner has changed.
- **`lens-wheel-reads-only-the-vertical`** ignores horizontal wheel input.
- **`lens-wheel-ignores-the-band`** removes the 8–300mm lens limits.
- **`showlens-reads-the-raw-number`** compares unrounded focal lengths with the displayed limits,
  so a lens at 8mm can read as outside the range after conversion through field of view.

The arithmetic mutations target `web/fly.js`; the event and rendering mutations target
`web/main.js`. The unit tests cover the arithmetic, and the browser rows verify its use by the
page. Pole drags start inside the stage and can finish outside it through pointer capture.
The slider row opens the Camera tab before focusing the lens control.
Section 21 also drives flight, look and horizontal wheel input on the recorder, then runs the
same drag-interruption checks as the editor. These checks use the fake grabber or the server's
existing stream; they do not prove physical sensor behavior.
The capture-loss check sends a stationary pointer event after releasing capture, so the browser
delivers its pending `lostpointercapture` event before the state is read.

**Whole clip is driven through both user paths.** Section 3 narrows the trim, selects
**Output > Whole clip**, narrows it again, and presses Option-X. Both must restore
`{ in: 0, out: null }`; `whole-clip-does-nothing` leaves the history write in place while removing
the range change and reddens those two rows. The internal range setter is used only to clean the
mutation fixture after both assertions, not to establish either result.

**Section 17 reads row hiding as layout, not as an attribute.** Its `under` walk comes from the
registry metadata, puts each master at its absent value, and requires every dependent row to have
no rendered box. `under-rows-ignore-hidden` removes the author CSS that gives `hidden` its display
semantics. It reddens five rows: the claim-carrying dependent-row assertion and four existing rack
availability rows that use the same mechanism.

**Section 15 grades a feature whose whole design is that it stores almost nothing**, and its
five controls exist because most of the ways it can be wrong are invisible from the panel.
Whether a parameter group is open is derived — a group is open when any parameter in it carries
keyframes or holds a value off its own default — and the only thing written down is a person
disagreeing with that, in `localStorage` under `kinect.panelGroupsOpen`, deleted again the
moment the derivation catches up with them.

- **`group-never-reveals`** is the falsification control for the derived half: the predicate
  answers "nobody has been here" whatever the document holds, so a group carrying live values
  renders shut. It reddens **20 rows** and the shape of that set is what to read. The rows that
  move a value, key a parameter or move a reading and expect the group to open carry the claim.
  **The mark rows go red with them, and that is correct rather than collateral** — the mark is
  keyed on the same rule the open state is, so a build that cannot tell whether a group is in
  use cannot mark it as in use either. This document said the opposite for a while, describing
  an abandoned draft that widened the mark to a condition of its own; those rows stayed green
  under it, which read as precision and was really the second rule covering for the first. The
  two store rows in 15f-bis go red as well, because both halves of the store rule are
  comparisons against a derivation this build has frozen. What stays green is the toggle itself
  — it still presses, the rows still hide and show — and the count on a shut header, which
  walks `paramTouched` rather than this predicate. 15i's three go red for the reason one step
  further out: that block needs a group that is genuinely in use and then shut, and on a build
  where nothing is ever in use that fixture cannot be built at all. Its pinned-open half stays
  green, which is what says the three are about the predicate rather than about reloading.
- **`override-prunes-only-on-toggle`** is the control for the *stored* half, and it exists
  because that half had none. `toggleGroup` compares what a person asked for against what the
  document derives at the instant of the press, so pressing a toggle back is the one gesture
  where the two agree by construction — and 15f pressed exactly that, then reported the whole
  rule. The term that moves afterwards is the derivation, and nothing drove it: a group pinned
  open while quiet stayed open forever with nothing in it, through a green section. This
  mutation restores the pre-fix build exactly — the prune comes out of `refreshGroups` and goes
  back into `toggleGroup` in one edit — so the toggle path keeps working and only 15f-bis's two
  rows go red. A break that also failed 15f would not say which question was being asked.
- **`prune-ignores-movement`** is the other half of the same control set, and it restores the
  build the first attempt at that prune shipped: the comparison stays where it is and loses only
  its condition that one of the two terms has *moved*. That condition is what the state a page
  boots into needs. Before the take is open every look parameter sits at its default and there
  are no tracks, so the derivation answers `false` for every group — a statement about there
  being no document yet rather than about the document — and a build pruning on agreement alone
  deletes every stored collapse on its way past that reading and writes the pruned map back. It
  fails one-directionally and in the direction people use: a pin stores `true` against a derived
  `false`, which is a disagreement at boot and survives, while a collapse stores `false` against
  the same `false` and does not. It reddens **2 rows**, both in 15i, and the pin row beside them
  stays green — a control that reddened both could not say which of the two it was asking about.
- **`panel-rederives-per-write`** is the control for 13k, which is the one cost row in this file.
  It takes the gate off in both places it lives, which between them are the build from before it
  existed: `params.set` announces every write to the panel unconditionally again, and
  `withoutRepaint` stops asking once on the way out. Both edits or neither — removing only the
  condition would leave the `finally` asking as well, at one pass per frame more than any build
  that ever shipped, and the arm would then be about a build nobody has. Measured, two rounds per
  arm: **1.00 re-derivation per rendered frame at four keyed parameters and 1.00 at eight, against
  4.00 and 8.00 mutated.** Those exact figures are what say the arm is the pre-gate build rather
  than the condition alone, since the latter would answer 9 at eight keys.
- **`reveal-ignores-tracks`** drops the keyframe term alone, and it is the one worth reading
  twice. A parameter that is keyed *and* off its default opens the group either way, so this
  mutation is invisible to every other row in the section: the fixture has to plant a track
  whose keys are all at the parameter's own default, and assert the parked value really is
  there, before the row means anything. Without the term the groups breathe open and shut as
  the playhead crosses a curve's default, because the evaluator writes through `params.set` and
  `params.get` therefore answers the evaluated value.

Two things about the section that are not obvious from reading it. **It reloads the page rather
than opening a second one**, because `page.route` is installed per page — a second page would
take the tree's own `main.js` and put two builds inside one measurement. That reload carries both
polarities at once and they are not the same claim: the pin proves an override survives a reload
at all, the collapse proves nothing pruned it against a document that had not loaded yet, and the
row between them reads `kinect.panelGroupsOpen` straight back before anything touches the panel.
`docs/instruments.md` carries why that row was once re-polarised onto the pin alone and why that
was the wrong call. And **every press is conditional on the state the group is actually in**: under `group-never-reveals` every group is
already shut, so a blind "press to collapse" would open one instead and the row would fail for a
reason that has nothing to do with the mutation.

**The rows are hidden with CSS and never removed from the document**, which is what keeps the
panel checkable at all: section 1 counts a control per registry parameter with a plain
`querySelectorAll`, blind to visibility by construction, so a build that collapsed by rebuilding
the panel would pass every row above it and quietly stop being the registry. Each row in section
13 reads the count in the document beside the count on the screen for that reason. The same rule
is why `framing` is not collapsible and why section 15 spends an assertion saying so: its
`after()` emits `#cropReset`, section 8 clicks it, and Playwright's click waits for visibility —
so a collapsible `framing` turns a row eight sections back into a thirty-second timeout, which
arrives as a crash carrying no failed assertion rather than as a finding.

**`keyframe-check` depends on this feature without mentioning it.** Its section 6e clicks
`.kf[aria-label="bloom keyframe"]`, `bloom` is in the `optical` group, and that click needs the
group open. It works because 6e applies the Blackwall look first, which moves `bloom`, `rgbsplit.amount`,
`raster.amount` and `grain.amount` off their defaults — so the per-write refresh that opens a group is
load-bearing for another tool's actionability and not only for the panel looking right. Run
`keyframe-check` after touching the predicate.

**`vendor-check` reads the built artifact as well as the source.** Sections 1-4 prove
`third_party/` is upstream plus the declared edits; section 5 asserts the library actually
installed at `vendor/prefix` carries `LIBFREENECT2_REG_THREADS`, the env override the threading
edit introduces. Without it the check passed identically whether the grabber loaded that source
or a stale prefix built from something else - and it silently would have, because the grabber's
call passes two optional out-parameters any libfreenect2 0.2 accepts, so an old prefix links and
streams single-threaded with nothing looking wrong. The control is `--mutate stale-prefix`,
which points the assertion at `vendor/prefix-oracle` - a real library `registration-check`
builds from upstream's own registration.cpp, rather than a doctored copy of ours - and it must
FAIL. **What is still source-only is the sub-9 fix**, whose `& 0x1ff` compiles to an immediate
and leaves nothing in the binary to look for; the tool says so rather than implying it covers
both. Exit 2 where no prefix exists.

**`sensor-view-check` exits 2 on a machine with no sensor attached, and that is the tool
working rather than a regression** — worth writing down because it reads like one. Its section 5
arm waits for `uniforms.focal.value.x !== 366`, which is a hello arriving over the socket, so a
server whose grabber will not spawn leaves the boot default standing and the wait times out at
25s. The tool answers `untested` and says "no sensor, no claim" instead of failing, which is the
right reading and still exits 2. Everything else in the file runs: **section 6 is the only arm
in the suite pointed at the recorder's panel** — every block and every look parameter graded on
both surfaces, with the look groups reached through the inspector tabs rather than through a
toggle — so a change to the panel is still graded on both surfaces on a sensorless rig, and that
section is what to read. **Two things this sentence used to name had stopped existing**, and
neither of them failed anything on its way out. It said 54 parameters. The population is derived
from the registry, so it was never a constant to write down: the run prints 86 of 86 against
20 of 20 blocks today and it read 78 before the glyph field's eight arrived, so 54 matches
neither, and nothing here dates when it last did. A count in prose is a snapshot wearing the
grammar of a fact. And it said the groups
are revealed by `extended settings`, whose rule and `#extendedRow` button left the markup in
`988551e` when the panel became tabbed. The groups themselves went from nine to eleven with the
glyph field, which is a second reason not to carry either number here. Read the counts off the
run. One row in
section 3 goes red there for a second environmental reason: it needs **two or more takes** with
a hello to say that the library cannot tell a computed angle from a constant, and a `captures/`
holding only `sample.knct` reports `1 takes`.

**`level-check` needs no sensor and no capture, and that is a claim about what it can grade
rather than a convenience.** It writes analytic planes — `z = c / (u . n)` along each pixel's
own ray — straight into the depth texture, so it knows the normal of every surface it plants.
That is what lets its `levelPair` oracle state the cant a planted surface is level at instead
of asking the page, and the distinction is the point: a check that read the expected angles off
the build under test would agree with any build by construction, including one composing the
pair the other way round. A fixture take would have given it a surface nobody knows the normal
of. Section 5 drives the reset button and reads both axes and both sliders back at neutral.

**Its staged tree deliberately has no `native/`, and that is the reason it works.** A live
socket wipes a planted frame in well under a second — an arriving frame swaps the two depth
textures and the plant is left in the one nothing reads, measured at gone-within-500ms on a
page with the sensor attached. The staged tree carrying no grabber binary is what keeps the
server it spawns quiet. That held by accident for as long as this machine had no Kinect, and
the day one was plugged in nothing in the file would have noticed: symlink `native` alongside
`node_modules` and the run goes on being green while it grades live footage against a normal
it thinks it planted. Section 1 now checksums the planted grid after a full settle and asserts
the texture was not swapped under it; with `native` staged that row fires at 1726596637 against
an expected 95354338 and nine rows fail behind it, the fits reading tilt -3.5 roll -32 off a
surface planted at 73.5 and 0. **Ask of any tool that plants state what else writes to the same
place**, and prefer a row that names the cause to nine that describe the symptom.

Two of its rows are worth knowing about before editing it. **The bit-identity in section 2 is
the whole crop claim**: rotating the world and the camera by the same quaternion is a no-op, so
the two pictures must hash the same, which is only true while the crop and the region are
tested on the undisplaced sensor-space position. It carries its own anti-vacuity row — leaving
the camera behind *must* change the picture — because otherwise a build that ignored the
parameters entirely satisfies the identity by drawing the same thing twice. **And surface A is
deliberately blind to `level-order-swapped`**: it leans along one axis, its roll comes out zero,
and `Rx * Rz` and `Rz * Rx` are then the same rotation. Which is why section 3 — that mutation's
catcher — plants surface B, whose roll is 27 degrees, rather than the simplest of the three. A
surface that only tipped away from the sensor would be levelled by either order and the section
would stay green under the swap.

**Section 7's switch rows have exactly one catcher and it is the top-down.** `crop` has two
readers: the vertex shader, and `croppedOut`, which the plan inset asks. The rows close the
crop in sensor y until the plan loses points, release the switch, and demand the same count
back — so a `crop` wired to the shader alone reddens there and nowhere else. It had a third
reader until the select-floor gesture was removed on 2026-08-08, and that gesture was the one
those rows used to ask, so anything that narrows the plan's use of `croppedOut` now takes the
mutation's only catcher with it.

**`registration-check` builds both sides every run** - a pristine upstream prefix and ours -
because a stale oracle `.dylib` turns the whole thing into a build compared against itself and
nothing about a stale library looks wrong. It needs no sensor: it runs on a corpus of
`Registration::apply` inputs dumped by `grabber --dump-corpus`.

**`syntax-check`** needs nothing at all, and it refuses to pass on finding no files: the roots
must exist, each must yield files, and the count is printed beside the verdict so a number that
has quietly halved is visible rather than implied. It also asserts that every tool in `tools/`
is named in `CLAUDE.md`, which is why the index lives there rather than only here — a tool
added later is asked by existing, and the falsification control is adding a tool without
documenting it.

**Its second row resolves the citations**, and it is one walk asking two questions because they
are the same claim about two kinds of target. Every `docs/*.md` path has to exist, which is what
holds the disclosure chain `CLAUDE.md` opens on together — delete one of the three documents and
every pointer at it resolves to nothing while the tool stays green, and the control for that half
is `mv docs/instruments.md /tmp` and a run. Every `web/….js` path has to exist too, and a
`file:line` form fails when the file has fewer lines than the citation names. That half arrived
with the browser bundle's split: `web/main.js` went from 15,449 lines to 13,206 with twelve
modules beside it, and fourteen citations were left naming the bundle for code that had been
carried out of it — eight of them one sentence about the unprojection copied around the suite.

The **citing** set is every prose page this repo ships and every source file it ships, not
`CLAUDE.md` and `tools/` alone, because the documents cite each other and the modules cite each
other — a scan reading only the two files that point at `docs/` would have seen four of the
thirty `web/` citations. The **question** is asked of the prose rather than of the whole file: a
path in a string is data and a path in a comment is a citation, which is the same distinction
`library-check`'s number scan draws when it refuses to read a declaration out of a debug message.
That exclusion is load-bearing rather than tidy, and it was measured by taking it out — seven
paths red on a clean tree, six of them the fixture paths `library-check` builds its probe tree
out of and the seventh the module name this tool's own mutation table plants for being absent.

Two controls, because the halves fail differently and a path that still resolves would answer for
a line that does not. `--mutate web-citation-outlives-its-module` renames a module in `CLAUDE.md`'s
own prose to something the tree does not hold; `--mutate line-citation-past-the-end` moves a line
citation past the end of the file it names. Each reddens one row and nothing else. The floor was
falsified by hand in the same round, by narrowing the pattern to match nothing: `nothing cites a
web/ module, so this assertion passed on nothing`, one failed assertion.

**What it cannot see is worth knowing before trusting it.** A citation is checked for resolving
and never for being *right*, so a module cited for something that moved to a neighbouring file
passes, and a line that has drifted into the middle of something else passes. `server/capture.js`
records what that costs and answers it the only way that works — it cites `handleFrame` by name
after the line it used to name had drifted nine hundred lines into the middle of a shader with
nothing failing. Cite a function; the line form is checked here because it exists in the tree,
not because it is a good idea.

**Its third row is the `.knct` decoder specification**, the page at the top of
`server/protocol.js` that issue #45 decided is a take's exit from this program instead of a
point-cloud export. That makes it load-bearing in a way prose here usually is not: it is what
somebody writes a reader from once nothing in this tree runs, so a constant that moved while it
did not would send them to a reader that is plausibly shaped and quietly wrong. The row reads the
specification's number table against the module's exports and fails on any disagreement. Two
choices in it are the whole of why it means anything. The exports are **enumerated rather than
listed**, so every numeric export has to appear in the specification and a constant added next
year is asked by existing rather than added to a second table that drifts. And the values are
read by **importing** the module rather than by a regex over its source, because
`MAX_PAYLOAD_BYTES` is `8 * 1024 * 1024` and reads correctly one way and not the other.

The control is `--mutate spec-drifts`, which substitutes `TYPE_COLOR = 3` for `4` and leaves the
prose where it is. Both arms import through a scratch copy of the file rather than the clean arm
importing the live path — they have to differ only in the substitution, or the run is comparing
two mechanisms and calling the difference a catch. An anchor it cannot find and a mutation name it
does not know both exit 2 rather than running, for the reason the exit-code section above gives.
Mutation-tested three ways beyond its own control: a numeric export added to `protocol.js` and
left out of the table reddens it, the specification block deleted reddens it, and a number edited
in the table while the code stays put reddens it.

**`boot-check`** is the post-boot state diff the other three documents deferred to, and it
needs a GPU browser and a free port and nothing else — no capture, no sensor, no server
already running. It spawns its own on 8391 against a temporary captures directory and exits 2
naming the port when something already holds it. The two captures in that directory are
synthesised by the run itself, out of `make-sample` at twelve and sixteen frames, which costs
under two seconds: the take door cannot be asked to refuse footage without footage to refuse,
and the undo sections need a second take that no page opens, cut to a different length so it
hashes differently. Its
projects directory is temporary for the same reason as its captures one and a sharper one —
the checkout's `projects/` holds the editor's autosave and every other tool's staged
documents, so a run writing its fixture there hands the next tool a document it did not
stage.

**Its comparison is registry-versus-control, and the obvious one cannot catch the fault it
is for.** The audit that asked for this sketched it as "read every registry value back after
first paint and compare against the registry's declared defaults". In the fault the registry
ends up holding perfectly correct values — `params.reset()` writes every one of them — and it
is the *controls* that never hear about it, because `writeControl` opens
`const el = panelControls.get(name); if (!el) return;` and the generator has not filled that
map yet. A diff against declared defaults therefore compares defaults to defaults and reports
nothing. Measured with the fault put back: 73 of 80 controls diverge and the registry is right
about all 80.

**What an unwritten control reads is measured rather than derived**, and the arithmetic that
looks right is wrong. A range input the boot write never reached is commonly said to sit at
`(min + max) / 2`; it does not. `pointSize` spans 0.5 to 64, whose midpoint is 32.25, and the
control reads 50.5. Across all 75 range controls here the midpoint disagreed with the element
on **75 of 75**, and a first version of the coverage row that predicted rather than measured
named thirteen parameters as indistinguishable where the fault leaves seven, overlapping on
two. The tool builds a detached input with the same `min`, `max` and `step` and reads its
`value` — the browser answering instead of the check guessing.

**It drives the recorder, and that is a claim about what it needs.** The panel is generated
from the registry on both surfaces and the only `EDITING` gate inside the row loop is the
keyframe diamond, so `/record` and `/edit` build the same 80 controls — measured on both,
against the 81 the registry declares, the difference being `camera`, which is a pose and has
no control by design. What separates them is the price of asking: `/edit` with neither a take
nor a project redirects to the projects page, so the editor needs one of the two to boot at all,
while `/record` boots the full panel against a server with no grabber, no sensor and an empty
captures directory. That is the state a fresh clone is in.

**The second claim is the document door, and it is why the tool now stages a capture.** A
document is adopted whole or not at all, and three shipped faults said otherwise: a clip value
that is not a number was copied into the plan raw and refused by `params.apply` after the
project's look and every earlier clip had been written; a clip naming no take was accepted by
`checkProject`, because the refusal lived inside `sourcesFor`'s loop over the clips whose
footage *changed* and a null take landing in a slot with no source compares null against null
and is filtered out of it; and a take refused for its capture format stayed in `openTakes`
carrying the hello that was rejected, so the next synchronous restore found it already open and
adopted what the fetching door had refused. Each has a `--mutate` control above, and each
control reddens only its own rows.

**The parked half of that door is proved by the same section, in the other direction.** A
parameter belonging to an effect this build has not got is stored raw and never normalised,
because the spec that would hold it to anything is the manifest this build is missing — so the
section feeds one value the registry would refuse on sight under two names, one the registry
answers for and one it does not, and asks for the first to be refused and the second to survive
into the parked pool and back out through the save byte for byte. The control has to be a *core*
clip value rather than an effect parameter: an effect value added to a block naming none of its
siblings is refused by the completeness check two loops earlier, which caught the control before
the line under test ever ran and read as a passing row twice while this was written.

**The third claim is that undo is the session's and the document is the file's**, and it needs
a second capture — one no page here ever opens — because the only thing that separates a stack
which outlives the page from one that does not is a saved entry naming footage a reload never
fetches. The section stages two poisoned documents, with the unreachable entry on top of the
stack and one below it, and asks the same question of both: the page comes up with no stack,
and pressing undo raises nothing. It asks it a third time of `restoreProject`, and that probe is
not a third spelling of the other two. The saved stack used to be read back in *two* places,
`applyProject`'s tail and `loadProjectNamed` a line later, and the loader starts a stack of its
own after `applyProject` returns — so a mutation reinstating the `applyProject` reader alone was
**NOT CAUGHT** by either navigation, and only the synchronous door can see it. Reading the code
would have said the two sites were equals; the measurement said one of them had been dead for as
long as the other was there.

**That claim's subject is a named project now, and moving it broke the poll under it in a way the
clean run could not show.** It used to read `GET /projects/__working__` until a body appeared,
which worked because the hidden document did not exist until the auto-save wrote it. A named
project's file is already there before the commit runs — the create wrote it — so "poll until a
body appears" is satisfied on the first tick and the arm reads a document the commit never
touched. Measured when it happened elsewhere in the suite: `the-save-writes-the-undo-stack`,
correctly re-anchored, came back **NOT CAUGHT** with the control working perfectly and the arm
unable to see the write. **Hold the poll to the value moving rather than to a body existing** —
this section waits for the edit it just made to appear in the stored clip, and the same mutation
then reddens one row with `history` among the stored keys. It is the absence-that-looks-like-the-
instrument-working shape `docs/instruments.md` opens on, arriving through a fixture that grew a
file underneath it.

**Two rows beside it are about a page that holds no document at all.** A page opened on a take
has no file to auto-save into, which used to be carried by `__working__` existing and is carried
by there being nothing to write to now — so the row lists every project the server holds after
the commits above and requires the store not to have grown. `take-page-invents-a-name-to-save-under`
is its control: it puts the hidden name back in one line, and the row reads
`the store holds ["__working__", …]`.

**Every row in that section is an absence, so the falsification control comes first and is a
presence:** undo is made to move a value and put it back, read off the value rather than off the
stack's depth. Without it, a build where undo simply did not work would satisfy every row below.
The same discipline puts a floor under the stored-bytes row — the save is provoked by a real
commit, and the bytes are read back off the server rather than out of the page, because
`JSON.stringify` drops an `undefined` value and a build writing `history: undefined` would read
identically to one that writes nothing.

**The refusal for a clip naming no take is the editor's rather than the format's**, which is
the one place this section could have been made wrong in the other direction. The recorder
draws the live stream, its own `serialiseProjectBody` writes `take: null`, and the panel
section above restores exactly such a document — so a door refusing that unconditionally would
refuse the document the page had just written. The refusal is behind `EDITING`, and the row
saying the recorder still takes its own document back is the over-refusal guard beside it.

`--mutate reset-before-the-panel-generator` is the control and it is the shipped fault itself,
restored by moving the boot write above the generator. **It reddens exactly one row of 57**
and leaves the write-sweep row beside it green, which is the split that matters: the sweep
writes a value through the registry after boot and asks the control to have followed, and by
then `panelControls` is filled either way, so the two rows are different questions rather than
one asked twice. Aiming it took some care — the obvious spelling risks the temporal dead zone
the no-ops above the registry exist for, and a page that throws while evaluating publishes no
`__kinect` at all, which `docs/instruments.md` files under "a mutation whose only effect is
that the page refuses to boot is not a usable mutation". `tracks` is declared below both
positions, so the move stays on the safe side; the mutated build boots both surfaces with zero
page errors. Its four exit-2 refusals were each probed by hand: an unknown name, an anchor
matching zero times, an anchor matching 221 times, and a mutation staged for a module the
recorder never requests.

**`effect-check`** spawns its own server on **8281** and needs none running: a GPU browser, a
free port, no capture, no sensor and no ffmpeg. It asks the kernel for the port before it
stages anything and exits 2 naming the pid that holds it, because a run answered by a stranger
asserts against whatever fixture that process staged. Its staged tree is `.effect-check/`,
gitignored, and it copies `server/`, `tools/`, `web/`, `effects-builtin/` and `presets-builtin/`
into it — the last of those because the page fetches the preset library while it boots and a
staged tree without the shipped root answers 500, which lands in `pageErrors` and reddens the
last row with a fault that has nothing to do with effects.

**It is the only tool in the suite that writes packages, so it hands the server both store
roots by name.** `--effects` and `--builtin-effects` are passed outright rather than left to
resolve from the staged tree, because the failure that costs something is a run whose user root
resolved to the checkout: seventeen fixtures, fifteen of them hostile, written into `effects/`.

**Read the exit line rather than the code**, and this tool says more than most: a mutated run
with failures is reported as caught however it ended, and it says whether it ended early.
`install-skips-the-uniform-cells` leaves the page half-adopted and takes the driver down with
it, so seven rows fire and then the run stops — a verdict that put the crash first would report
DID NOT RUN over a caught mutation, which is the census of exit codes `docs/instruments.md`
already carries a case for.

Baseline **148 assertions, 0 failed**, over sixteen sections: the store's revisions against hashes
the tool computes off the staged tree, twenty-two hostile packages each refused with the sentence
for its own rule, the hotload's registry-and-panel coherence including `boot-check`'s own
control-vs-registry diff on a rebuilt page, the uninstall/reinstall pixel identity, the
must-not-badge control, an install this page cannot carry the open document onto, everything on
the panel that is not a parameter row, what a rebuild costs and what it stands down for, a
package whose GLSL every rule here accepts and no driver will compile, what a crashed install
leaves behind, and — last, after the browser is closed — what somebody plants in the user root
and an install interrupted between its two renames.

**Section 2 sweeps the user root after the residue row rather than trusting that nothing
landed.** On a clean build there is nothing there and the sweep is a no-op; on a build whose door
has stopped refusing something the finding is already recorded by the two rows above it, and what
would otherwise be left is a hostile fixture still installed when section 3 opens a page and
counts its parameters. `door-takes-any-expansion` is the mutation that produces exactly that —
it reddens the refusal row and the residue row and nothing else, where without the sweep the same
run would have carried a sixty-file package into every section after it.

**Section 7 is the one whose subject is invisible.** Sections 3 and 4 ask whether the parameters
arrived and whether their values are right, and a build can get both of those completely right
while the buttons beside them are dead, the tab that was showing has stopped being applied, the
collapse headers are painted for elements that no longer exist and the preset subset dialog is a
statement of the registry from before the install. None of that throws, none of it moves a
pixel, and each of the four has its own mutation because each is a separate way of rebuilding
the panel and forgetting something.

**Two arms sit at the end of section 9, and where they sit was measured rather than chosen.**
Both leave the page in a state a mutation can make unwell, and both wanted section 6's fixture —
a page holding an install it has refused. Put there they widened what three existing mutations
already break: `reinstall-leaves-it-parked` went from nine red rows to fourteen, all five of the
new ones cascades off a document its own defect had already made unloadable. It ends the run
early either way and always has — measured at `4b63f80`, 52 of 91 with nine red, against 55 of
111 with nine red here — so what moved was the blast radius rather than the finishing, and the
early end is a pre-existing gap this page had not recorded. Sections 10
and 11 are short and the second closes the browser anyway, so the cost of a block that leaves the
page unwell is smallest here. The refused fixture is re-staged rather than inherited: the fork is
installed again and driven through `pollNow`, because the block under test is the *poll's* and a
`reload` an operator asks for goes nowhere near it.

**The periodic poll and a requested rebuild share one lock.** Section 8 holds the poll's listing
open, starts the rebuild exposed to an installer, and requires that no second listing starts until
the poll releases the effect set. `--mutate requested-reload-skips-the-poll-lock` exposes the raw
rebuild again and reddens that row. Without the lock, the older rebuild can land after the newer
one and leave the registry, package signature, parked values, and panel describing different
effect sets.

The first counts what the poll does next. A rollback puts the old signature back on purpose, so
the comparison a tick makes on its way in goes on saying the store has moved, and without a block
that is the same rebuild attempted every six seconds forever — every package refetched, both
programs reassembled, the material disposed, the accumulators reset. The row counts package reads
in a window and requires zero, *and* counts listings in the same window and requires two, because
a zero on its own is what a page that has stopped polling also produces. A revision the page has
not refused then has to land, which is what says the block is keyed to the set rather than
latched on the page.

The second is about the uniform table rather than the registry. A cell is a number for a plain
binding and a two-component vector for an `axisDeg` or `centeredEdges` one, and which it has to be
is a fact about the manifest — so a fork exchanging two bindings' shapes writes a number over one cell and then
throws on `.set()` at the other, mid-walk, with the registry already swapped. That throw is what
the transaction is for, and until this round it met an adoption that minted only *missing* cells:
the rollback found both present, skipped them, and died on the number the forward attempt had
left, so a page came out of a rollback holding a registry no document loads into. The fixture is
`probeshape`, its own package with its own uniform names, and it adds a parameter as well as
swapping the shapes — without the addition a build that reshapes both cells adopts the fork
cleanly, nothing rolls back, and the row would be asserting nothing.

**Section 11 restarts the server and closes the browser first**, which is the only place in this
tool that does either. The recovery it asks about is a fact about constructing the store, so it
has to be driven by starting one; the page is closed rather than left running because its own
poll would report a store that stopped answering, which is correct behaviour and has nothing to
do with the rows, and because the section stages a package directly in the user root that no
page has any business adopting.

**Every fixture in that section is written rather than inherited**, and the reason is a mutation
rather than tidiness: `temporaries-are-visible` leaves the store unable to install anything at
all, so a row whose fixture was the previous row's output turned that mutation into an `ENOENT`
crash three sections later instead of into the two red rows it is about. Both blocks now write
their own package into the user root - the one with a symlink in it and the one staged as a
crashed install's aside - so what the mutation reddens is what the mutation is about. Its control is the direction the recovery must not run in: `remove` also
renames a directory aside before deleting it, so a crash there leaves the same shape on disk,
and a recovery that could not tell the two apart would undo somebody's uninstall on every
restart. The suffixes are what tell them apart — `.old` for a copy that should come back and
`.gone` for one on its way out — and the last row of the section is what says so.

**The 6-second poll on the page competes with the driver, and two rows are written around it.**
`pollNow` is the interval's own body, so a tick that started six seconds ago can be mid-read
when the driver calls it, and the reentrancy guard correctly sends that call straight back
having done nothing. Section 6 therefore waits for the note rather than reading it the moment
`pollNow` resolves — a build that never reports still fails, one interval later. It is worth
knowing before reading a red row here: an assertion that reads page state immediately after
`pollNow` is asserting against whichever of the two polls got there first.

**Section 6 is the one that asserts a failure.** It installs a fork of the probe package
carrying one parameter more while the open document holds that effect parked, which makes the
document a subset of the new manifest and so a document the loader refuses per effect — the
refusal is correct and stays a refusal, because filling the added parameter from its default
would be this build guessing at a look somebody else authored. What the thirteen rows hold is
where the page is left standing: the server did take the install, the note names `probe.glow`
and says which set the page is still running, the registry and the signature are the ones it
had, the pool is untouched, the three pinned positions render the images they rendered before,
a save still writes every parked key holding the value it arrived with, and the document that save produces is one
this same page will take back. **It is driven through `pollNow` rather than `reload`**, because
the note is one of the things asserted and the poll is the only thing in the product that
writes it.

Its control row is a cross-state comparison rather than section 4's three-distinct-images, and
the difference is worth keeping: with the effect parked there is nothing keyed left to separate
the three positions from each other, so 0.6s and 1.2s both show the last of the six pinned
frames and hash the same. The three images in section 4 differ because `probe.amount` is
ramping across them. So the control here holds the parked hashes against the ones the same
positions rendered while the effect was installed and raised — which is the state the rollback
must not have left the page in.

**`effect-conformance-check`** needs `--url` against a running server and a GPU browser, and no
port of its own. Every hash is taken inside the run and none is written down: what it compares
is three images the same process just rendered on the same GPU, so it means the same thing on
every machine and there is nothing here to re-baseline. It enumerates from `GET /effects`, so a
seventeenth package is asked its questions by existing.

Baseline **99 assertions, 0 failed** with the shipped sixteen — six or seven rows per package
depending on whether it carries GLSL of its own. Two of them are the controls: the raise has to
reach the registry before its picture means anything, and the package's own longest line of GLSL
has to leave the assembled program while it is hollow and come back after. That second row was
added after the first version of this tool spent a run reporting eleven effects as unable to
reach a pixel — `page.unroute` matches its matcher by reference, so a fresh arrow removed
nothing, every package dropped stayed dropped, and the raise arm was asking hollowed packages to
move a picture. One handler consulting a variable replaced sixteen routes, and the marker row is
what would have said so.

**`module-check`** needs nothing at all — no port, no server, no browser, no sensor and no
install — and that is the point rather than a convenience. Every failure it is about is a
failure to *boot*: an import cycle, a specifier naming a file that is not there, or a named
import of a binding the other side does not export all stop the module graph before a line of
anybody's body runs, and a module that throws while it evaluates publishes no
`globalThis.__kinect`, so every tool in the suite reports DID NOT RUN with no assertion behind
its exit code. An instrument that needs the page running cannot see any of them.

It walks `web/` for `.js` modules and reads every `.html` page for its `<script type="module">`
elements, so a module added later and a page that starts loading one are both asked by existing.
`type="module"` is one exact spelling in the HTML specification, which is why there is no list to
keep up with here — unlike the sixteen MIME essences that mean "classic script", which
`library-check`'s grid scan had to copy out.

**Exit codes.** 0 is a pass and 1 is a failed assertion, as everywhere. **2 is DID NOT RUN**, in
three places: a `--root` that is not a checkout, a `--mutate` name it does not know, and a
mutation whose anchor text no longer matches its file — the last being the important one, because
a mutation that changed nothing comes back green and gets written down as the control passing.
There is a fourth, and it is the one this tool needed that `syntax-check` does not: a mutation
naming a file that nothing in the run read is also exit 2, since the substitution would otherwise
be delivered nowhere and the clean run would be recorded as a catch.

**Four rules, and the second one is narrower than it sounds.**

*Rule 1, the graph is acyclic.* `web/scene.js` opens with the claim that "Nothing here imports
back into this file, which is what keeps that order a fact rather than a convention", and until
this tool that was a convention with a paragraph in front of it. `--mutate cycle-planted` puts
exactly the forbidden import into the file the comment is at the top of.
`--mutate cycle-through-a-second-spelling` writes the same ring the way `web/library.js` writes
its imports, `/main.js` rather than `./main.js`, because `server/index.js` maps a root-relative
URL onto `web/` with `join(WEB_DIR, urlPath)` and a resolver that folds the two spellings onto
different nodes reports a ring as a tree. The pair discriminates and was measured doing it: with
the root-relative branch taken out of the resolver, `cycle-planted` still reddens the cycle row
and `cycle-through-a-second-spelling` leaves it green.

*Rule 2, an import names something that will be there.* The rule as originally posed — no
top-level statement reaches an imported binding before it is initialized — is **entailed by rule
1** rather than a second question, because ES modules evaluate their dependencies to completion
before the importer's body runs, so an acyclic graph cannot put an imported binding in its dead
zone. Top-level `await` does not change that in an acyclic graph and a dynamic `import()`
resolves against a module that has already finished. What is left, and what is asserted, is the
part rule 1 does not imply: the specifier resolves, it does not escape `web/` (which this server
answers 403 for), the named import is a name the target exports, and two spellings of one file
are one node. `--mutate import-of-a-missing-file` and `--mutate import-names-a-missing-export`
are its two controls and they fail differently.

**What rule 2 does not cover, said in the tool's own output rather than left to be found.** The
reach `web/main.js` has actually been bitten by twice — the comments above `groupRevealChanged`
and `transportWriting` — is a top-level statement reaching a `const` declared further down *the
same module*, through `params.reset()` to `params.set` to `spec.apply`. That is property
dispatch, which is not statically decidable, so a check that followed only calls made through a
name would redden on planted toys and stay green on the shape that has shipped. It is left to the
post-boot state diff, which also sees the silent version of the same fault: `params.reset()`
landing before the panel generator has filled its Maps writes every value into the registry,
reaches no control, throws nothing, and leaves a page whose sliders show their markup defaults.

*Rule 3, what crosses a boundary.* Two halves that fail independently. The shape of the export —
a binding holding an object is state anybody importing it can write into, and needs an entry in
the exemption table saying why that is the channel. And the use at the far end — no module writes
a property or an element of a binding it imported. Measured on the tree as it stands, off a clean
run: 35 exports, 6 primitive, 16 behaviour, 1 live `let`, 12 exempted, over 36 bindings across 6
declarations swept. The write count is not a number the tool prints, so it was taken by running
the widened sweep with the exemption table emptied — 17 sites across four bindings, `renderer` 5,
`controls` 9, `freeCamera` 2 and `programCamera` 1, every one of them a three.js object being
configured from `web/main.js`. `--mutate exported-mutable-object`
and `--mutate imported-object-written-across-the-boundary` are its first two controls, and there
are six more below, one per way the rule was found to be escapable.

**The shape decides before the keyword does, and the order is the claim.** The first version
asked what a binding was *declared* as before it asked what it *held*, so `export let x = {}`
went into the live-let bucket without the shape ever being consulted — the sanctioned channel was
one keyword wide. A live `let` is sanctioned because an importer cannot **assign** to what it
imports; that says nothing about the object the binding currently holds, and writing a property
on that object is the same fault under a different keyword. Measured: `export let SENSOR_STATE =
{ frames: 0 }` in `web/format.js` plus `import * as m from './format.js'; m.SENSOR_STATE.frames =
1` in another module passed both rows. `--mutate state-crosses-as-a-live-let` is the control, and
reordering the ladder newly flagged exactly one binding in the tree — `web/scene.js::viewCamera`,
a live `let` holding one of the two cameras beside it, which is why it now carries an entry
saying so rather than a bucket that never looked.

**The sweep ranges over the bindings an import makes, not the names it asks for.** `{ a as b }`
names `a` over there and binds `b` here, `* as ns` binds one object whose properties are the
other module's exports, and `import d from` binds the far side's default. Taking the exported
spelling hands the sweep a name the importing file does not contain: measured, a renamed import,
a namespace import and a default import each hid a write that the unaliased spelling of the same
write reddens, and a page's inline module was skipped entirely because its body is not a file.
`--mutate write-through-a-rename`, `--mutate write-through-a-namespace` and `--mutate
write-from-a-page` are the three controls, and the row that used to print a floor over the edges
it had silently dropped now prints one incremented where the sweeping happens.

**Every `export` and every `import` keyword is claimed by a form, or it is a failed assertion.**
Reading the two keywords with a list of regular expressions means a spelling the list does not
carry contributes nothing and says nothing about it — `export default { … }` and an export list
written without its semicolon both did exactly that, and nothing has to import a binding *by
name* for it to be a channel, so no downstream row noticed. The keywords are enumerated first and
classified second. A property may legally be called `export` (`web/main.js` has two), and brace
depth is the exact discriminator, since a declaration is legal only at the top level of a module.
`--mutate state-crosses-as-a-default` and `--mutate export-form-nothing-claims` are its controls,
the second planting a destructuring export the scan refuses to take apart. A barrel — `export …
from` in any spelling — is refused rather than followed, by `--mutate a-barrel-re-export`.

**And the depth filter has a cross-check of its own, because it is a silent failure path.** If
the brace counter ever drifts, every later top-level keyword in that file reads as nested and is
skipped with no row — a quieter version of the fault the audit closes. Column zero is the
discriminator on top of it: every top-level declaration in this tree is written there and no
property key is, so a keyword at column zero that depth calls nested reddens a row naming the
file. The arm is planted rather than argued about, and it uses the one case the lexer leaves
ambiguous on purpose — a `/` after `}`, read as division, which scans the pattern's body as code
and counts the `{` inside it. Probed by deleting the `depth--` from the closing brace: the row
names the trailing `export { … }` lists in `web/curve.js` and `web/scene.js`, which are the two
that would otherwise have vanished.

**The exemption table cannot rot, and both halves of that needed an arm.** Every entry has to
still name something this tree exports *and* still cover something a rule flagged — an entry
naming nothing is a list going stale, and an entry covering nothing is the standing filter
`docs/instruments.md` warns about. `--mutate exemption-outlives-its-export` takes the `export`
keyword off `POLLED_NODE_FIELDS`. It was first written as a *rename* and reddened two rows,
because the renamed binding is then an exported object with no exemption of its own — a second red
row about a second fact, which is the blast radius that stops a control saying which question it
asked. The module-gone branch of the same row cannot be planted by a text edit and was probed by
hand: pointing an entry at a module name that is not in the tree reports that module "is gone, so
this entry is about a module that no longer exists". The name it was probed with is deliberately
not written down here, because `syntax-check` resolves every `web/….js` this repo's prose spells
and a name chosen for being absent would fail it. The `covers` half went without an arm for
longer, and it was
carrying more than its own weight — see `docs/instruments.md`, which measures what that cost.
`--mutate exemption-covers-nothing` promotes an exempted control-point pair to the number it is
made of, which leaves the entry naming a real export and covering nothing, in one row.

**Three mechanisms cannot be falsified by the subject, and each gets a tree of its own.** The
cycle detector is the first, since `web/` is acyclic and is meant to stay that way: a
three-module ring, a self-loop, a ring spelled through the server root, a diamond that is *not* a
ring, and a file whose only `import` lines are inside a comment and a template. The diamond earns
its place — a depth-first search using a single `visited` set instead of separating "on the
stack" from "finished" calls it a cycle. Probed by planting exactly that, which reddens the
diamond row reporting `d3.js -> d4.js` as a ring and reddens the real tree's cycle row as well.
The second is rule 2's two prohibitions: this tree holds no dynamic `import()` and no specifier
that climbs out of `web/`, so both rows range over an empty population, and the probe carries one
of each so the branch that decides them fires every run. The third is rule 3, where the subject
is worst of all — every object `web/` exports is in the exemption table, so a plant aimed at one
is answered by the table, and the tree imports nothing under a rename, a namespace or a default.
Both classifiers now run over a tree carrying one of every spelling with their findings asserted
as **exact sets**, so stubbing either reddens the clean run: `writesInto` returning nothing and
`shapeOfInit` answering `primitive` were each measured green before this, with the exemption
audit's `covers` forced true.

**Comments have to be removed before the match, not tested after it.** The scan carries a small
lexer for the same reason `numbersIn` in `library-check` does, and it needs a third state that
one does not: a comment is blanked to spaces, a string *body* is kept. `web/main.js` carries a
paragraph containing the word `import` a few lines above a real import declaration, and a regular
expression reaching from the word in the prose to the `from` below it matches leftmost-first — so
the match begins inside the comment, a mask consulted afterwards says "not code", and the
declaration is skipped with its edge silently gone from the graph. Measured before it was fixed:
`web/scene.js` and `web/curve.js` lost their edges and the run reported them as modules nothing
loads, which reads as a finding about the tree.

*Rule 4, a name crosses a boundary because both ends wanted it.* This is the rule the tool
shipped without, and it shipped a green run on a tree that was wrong: **57 assertions, 0 failed,
PASS** on a `web/main.js` carrying six imports nothing in the file used — `vertexShader` and
`fragmentShader` from `./cloud-shader.js`, `BloomPass` from `./bloom-pass.js`, and `easeParam`,
`easeAt` and `easeSlopeAt` from `./curve.js`, three of them dead since the branch point and three
since the commit that moved their callers out. Every neighbouring question answers *yes* for a
dead import — the file is reached, the specifier resolves, the name is exported, the module is not
an orphan — so nothing in rules 1 to 3 could see one. Both halves are built out of what rule 2
already had in hand, the edge list and `exportsByModule`, which is what made the hole cheap to
close and embarrassing to have had.

**One use question, asked once, feeding both halves.** Does the file that wrote a declaration
read the name it binds? The search runs over the same scan the rest of the tool runs over, with
every import declaration in the body blanked on top of it — all of them rather than the one under
the question, because two declarations importing one name from two modules would otherwise each
read as a use of the other, and a name moving between modules is exactly what this refactor does
all day. The population is every declaration that carries a name across the edge of `web/`,
wherever it is written: the in-tree edges, a page's inline module, the **bare-specifier
declarations** (`three` is not a file under `web/`, but `OutputPass` going dead when a pass moves
out is the same fault as `BloomPass` going dead when a constructor does), and the declarations in
`server/`, `tools/` and `test/` that import out of `web/`. 173 name-level bindings on the current
tree — 118 inside and 55 outside — and the row counts each of the three populations where it asks
them rather than off a collection it might skip part of.

A binding whose far-side name the target does not export is skipped here and left to rule 2's row,
so `--mutate import-names-a-missing-export` still reddens one row and not two. `--mutate
import-nothing-uses` adds a real export of `record-poll.js` to `main.js`'s import of it;
`--mutate import-used-under-its-far-side-name` renames the binding so the file is full of the
name the import *asks for* and holds no reference to the one it *makes* — the fault
`docs/instruments.md` records against rule 3's sweep, planted here before it can be made again;
`--mutate outside-consumer-imports-a-name-it-never-reads` plants the same thing in
`tools/fake-grabber.mjs`, where the row used to have nothing to say; and `--mutate
dead-bare-import` plants it on a package name, the half of the population that had no arm at all
until forcing it out of the loop left the clean run green at 60 assertions with all twenty
controls of the day still catching.

**A dead import is not a consumer.** The two halves used to be computed in one run and never
compared, so the same run could redden `web/main.js` for not reading `easeSlopeAt` and five lines
later count that identical dead line as the reader keeping `web/curve.js`'s export of it alive.
Measured at `883f070^` rather than forced: that is exactly what it printed, and the dead export
only became findable because a person removed the import by hand first. Now a binding no line
reads fails the import row **and** asks the far side for nothing, so the pair a name moved out of
a module leaves behind cannot conceal each other. `--mutate dead-import-is-not-a-consumer` leaves
`server/library.js`'s import of `POLLED_NODE_FIELDS` exactly where it is and stops the one line
that reads it: before the join that run was green at every row, and it now reddens two — the dead
import and the export it stopped holding up. Both sentences are true of one edit, and each of the
two claims has a control of its own that reddens exactly one row.

**No module exports a name nothing imports, and the consumer set is the checkout rather than
`web/`.** Seven of this tree's exports have no importer inside `web/` at all: `server/library.js`
imports `POLLED_NODE_FIELDS`, `tools/fake-grabber.mjs` and `tools/library-check.mjs` import
`CAPTURE_FORMAT`, and `BLOOM_LEVELS`, `easeParam`, `easeAt`, `TOP_SPAN` and `MIN_VIEW_SEC` are
held only by unit tests under `test/`. Measured by commenting the outside walk out: the row
reddens naming all seven, which is a check that cries wolf on its first run and then gets deleted
rather than fixed. So the walk is the whole checkout minus `node_modules`, `vendor`, `third_party`
and `web/` itself, and the direction it is allowed to be wrong in is set deliberately — a
directory it fails to walk costs a consumer and reddens a live export, which somebody sees, while
a directory it walks that it should not manufactures a consumer and keeps a dead export green.
`--mutate export-nothing-imports` plants a number nothing asks for, and `--mutate
consumer-outside-web-drops-the-name` takes the name off `server/library.js`'s import while leaving
the module imported, which separates a join done per name from one done per module: a check that
marked every export consumed the moment anything imported the module reads that tree as unchanged.
A row beside them asserts the outside walk is load-bearing rather than decorative — if no export
ever depended on a reader outside `web/`, it says so, in the shape of `--mutate
one-spelling-for-every-module`.

**A namespace import asks for the names it reaches, not for all of them.** `test/clip-range.test.
mjs` is the only one in the checkout, and taking `import * as clip` as a request for every export
`web/clip-range.js` has switched the export row off for that whole module: measured, an added
export nothing wants reddens the row when it is appended to `web/view-window.js` and did not when
it was appended here. A dotted reach asks for that one name, a destructure off the binding asks
for the names in its pattern, and **everything else is a reach this scan cannot name** — a
catch-all rather than the computed-index case alone, because `Object.keys(ns)`, `{ ...ns }`,
`for (const k in ns)` and handing the binding to a function all reach exports without naming one,
and a narrowing that consumed nothing for those would redden every export of the module on a tree
doing something legitimate. It consumes all of them, exactly as the old join did, and says so in a
row of its own, so a module going blind costs an assertion instead of passing in silence.
`--mutate namespace-hides-a-dead-export` is the arm for the narrowing and `--mutate
namespace-reach-cannot-be-named` for the row.

**What the use question gets wrong, and the two it no longer does.** It asks about a name and not
about a scope, so a name written in code position that is not a reference reads as one. A hit
inside a **quoted string body** used to be the first of those, because the blanking that removes
comments keeps string bodies — the specifier of every import lives in one. The mask is asked
instead of the text now: measured over the current tree, the strict reading takes hits off four
names (`grade`, `afterimage`, `bloom`, `material`, words the quoted parameter ids say too) and
leaves every swept name still read in code, so it closed the hole at no cost, with `--mutate
import-used-only-in-a-string` as its arm. What is *not* true, and this page and the tool both said
it was, is that a name mentioned only in a GLSL literal survived — template text is left at mask 0
and blanked to spaces, so the twelve hundred lines of GLSL here were never a masking surface, and
a plant named only inside a template literal is caught either way.

A **property key** was the second, and it is decided by the two neighbours rather than by a
lookahead: the nearest code character before the hit is `{` or `,` and the nearest after it is
`:`, which is the object-literal key and the destructuring pattern key and nothing else. Measured,
it takes no name off the swept set, which is what makes it free in the one file that is full of
registries and menu tables; `--mutate import-used-only-as-an-object-key` is the arm. What is left
open is the **method shorthand**, found by a control coming back NOT CAUGHT: `{ name(gl) { … } }`
has no dot in front of it either, which is what `gpuTimer.poll` in `web/main.js` is and what made an alias of
`poll` look read. That one will not close with a lookahead, and the measurement says so rather
than the argument — excluding a hit followed by `:` or by `(` at the head of a line calls twelve
live imports unused, `writeClipRange`, `tiltQuaternion` and `pollRecordState` among them, because
a call written as its own statement is at the head of a line too. Re-measured after the two
closures above, the `poll` alias still comes back NOT CAUGHT, so the limitation is exactly this
wide: it is a false negative, costing a dead import this row does not find rather than a clean
tree it fails, and telling a definition from a reference needs a scope analysis rather than a
search.

**Its first catch was real, and it arrived one commit late.** On the tree as it stood after the
six imports came off, the export half reddened `easeSlopeAt` in `web/curve.js`: it was let out
through the trailing export list, its last importer was the dead import in `main.js`, and removing
that one left an export with no consumer anywhere in the checkout. Fixed by taking the name off
the list — `scalarSlopeAt` calls the function four lines down, so it is a name coming off a
boundary rather than code being deleted. What the join says about that catch is that it depended
on the hand edit: run the joined rule against `883f070^` and both rows redden in the same run,
which is the version of this that does not need somebody to have removed the import first.

**`prof-summary.mjs <profile> [warmup]`** reads `grabber --profile` output and flags any run
under 29.5fps as contended, because the segment timings from a run that dropped frames are
noise. That floor belongs to a profiling run that writes nothing — see the gate paragraph in
`docs/measurement.md` before reusing it for a recording run.

**`pi-registration-ab.sh`** is the unrun runbook for measuring the threading on a capture node;
it builds both arms, checks with `ldd` that they load different libraries, and refuses to
report milliseconds from an arm that lost frames.

**`sweep-all` says "every mutation of every tool" and drives four of the fourteen that carry
mutations.** Its `TOOLS` is `['library', 'timeline', 'keyframe', 'export']`, so editor, guard,
jobs, level, monitor, registration, registry, sensor-view, vcam and vendor are outside the sweep
a merge waits on - and the file's own header is an argument against exactly this shape, since it
takes each tool's mutation *names* from that tool's refusal specifically so no list has to agree
with anything. The names are enumerated and the tools are not. The ten that are missing each
need something
the sweep does not currently arrange - a private server, a GPU browser, a built prefix - so
wiring them is real work rather than a longer array.
Replay runs use `fixture-1g`; set `SWEEP_TAKE` when the server names another take that satisfies
both tools' duration floors.

## `editor-check` is three rows red at `7cb273d`, and they are not yours

Written down because the alternative is every later change being suspected of them, which is
the trap `CLAUDE.md` names: **re-run the baseline in the conditions the failure happened in**,
and a run nobody took a control for reads as a finding. **The three measurements below ask about the
wrong condition, and the correction is at the end of this section**: two of the three rows track
the length of the take and not the load on the machine.

Measured on `--take fixture-1g --no-render` against a server on 8080 with a warm index, on the
Mac, with the tree at `7cb273d` and no local modifications — taken by copying the working
copies outside the repo and `git checkout --`ing the two files, because a `git stash` in a
worktree of this repo pushes onto a ref every worktree shares. **514 assertions, 3 failed:**

- section 4, `and never falls back to a rebuild, which is what resized the drawing buffer` —
  `1 fallbacks` on a ten-move lane drag.
- section 5, `and a double click on a key removes it` — `3 keys left`.
- section 5, `and it stops on the point before it rather than at the segment start` — `dragged
  from 0.3333 to 0.3333, against a neighbour at 0.1667`.

All three are pointer-gesture rows and all three are in sections that run before 13, so a
change landing later in the file cannot reach them. What has *not* been established is whether
they are a real regression or this machine under load — three reproductions on one contended
rig is not the clean control that question wants, and the honest state is that they were red
before this work and red after it, at the same three rows with the same three readings.

**Re-measured again at the end of the effect extraction: `545 assertions, 3 failed`**, on
`--take fixture-1g --no-render` against a server on 8503 with a warm index, at load average 8.14,
with the same three rows and the same three readings — `1 fallbacks`, `3 keys left`, and `dragged
from 0.3333 to 0.3333, against a neighbour at 0.1667`. Three separate measurements now, 514 then
530 then 545 in total, with a red set identical in identity *and* reading each time. The clean
control on an idle machine is still owed.

**That run took two attempts, and the first attempt is the more useful record.** It died at 422
assertions with a fourth red and then a thirty-second `page.click` timeout on `#crop`, reporting
`crop {"there":true,"disabled":false,"visible":false}` — the control in the document, enabled,
and `display: none`. The cause was not a regression in the editor but a repair to one: a
generated panel group is built with `hidden` unset, and until `buildPanel` learned to re-apply
the active tab, every generated group was on screen whatever tab was up. `#crop` belongs to the
`framing` group, so it had been visible on the Record tab because the panel was leaking groups
across tabs, and the row pressing it had been standing on that leak. Fixing the leak reddened the
row. The repair is one line in the tool — put the Framing tab up before reading and pressing —
and the assertion, the reading and the population are otherwise untouched, which is what keeps
545 comparable with the two runs above.

**The shape is worth more than the instance**, and `web/main.js` had already half-written it:
the note beside `collapses` records that a *collapsible* framing group would turn this row into a
thirty-second timeout, because Playwright's click waits for visibility. The hazard was foreseen
for collapsing and not for tabs, and it arrived through the tab door. A crash carrying a
thirty-second timeout and no failed assertion is the shape `CLAUDE.md`'s third rule names — read
the assertion count, not the exit code.

**It arrived a third time through a door nobody had thought of: somebody else deleting the
control.** PR #99 took the effect rack's confirm step out, and section 1 waits for a `cancel`
button that is never coming — 15 assertions of about 720, then a timeout. **A tool this happens
to does not report the removal; it reports almost nothing**, and no hosted check can say so,
because `editor-check` needs a browser and a take and CI runs neither. So a merge that changes
the editor is a merge whose first proof is running this tool once, before believing a green CI
job means anything about those surfaces.

**Re-measured after the Phase C work, and the readings are byte-identical**: `530 assertions,
3 failed` on `--take fixture-1g --no-render` at load average 9.31, against the same three rows
— `1 fallbacks`, `3 keys left`, and `dragged from 0.3333 to 0.3333, against a neighbour at
0.1667`. **The total moved from 514 to 530 and the reason is known**: the correctness pass
before this one added rows to `tools/editor-check.mjs`, so the population grew while the red
set did not. That is the comparison worth making — a total that moves with a diff that explains
it, beside a red set that is identical in identity *and* in reading. It still says nothing
about whether the three are a regression or the rig; what it says is that nothing since has
touched them, and the clean control on an idle machine is still owed.

**Six runs this session settled it, and the variable is not the one three measurements above were
holding still.** `1 fallbacks` and `3 keys left` came back red in four runs against a 243.3s
`fixture-1g` and green in two runs against a 91.2s one, at loads that overlap in both
directions — red at load 42 and again at load 8, green at load 13 and again at load 8. So the
clean control on an idle machine those paragraphs keep asking for would not have answered
anything: run on the long take it is a fifth red run, and the load it controls for is the term
that does not move the verdict. What put duration on the list at all was a different family in
the same suite — the deselect rows, whose mechanism *was* found, and it is a press point written
in program time; `docs/instruments.md` carries it.

**`fixture-1g` is a name and not a length, which is how a term that large stayed invisible for
three measurements.** `npm run fixtures` builds it as eight loops of the 30.362s sample, which is
the 243.3s take; `make-fixture.js` run bare loops 32 times and `--minutes` is a third door, so two
checkouts hold two takes of that name and no run here has ever printed which. The 91.2s one is
three loops of the same sample, which the arithmetic gives rather than a build log. **Report a
take's duration beside its name whenever a row's verdict is being attributed** — the name is what
the invocation carries and the length is what the row is measured against.

**What this is not is a mechanism, and the gap is worth stating at its real size.** Two green runs
on one shorter take against four red ones on the longer is six observations and no explanation of
what either row does with the extra length, so the claim this page can carry is that on this rig
the fixture's duration predicts the verdict where the load does not, and nothing about why. A run
reddening only these two is a re-run against a shorter take before it is a finding.

**And the three rows this section groups are not one phenomenon.** Section 5's `dragged from
0.3333 to 0.3333, against a neighbour at 0.1667` was green in all six of those runs, the 243.3s
ones included — green on the very fixture that reddens the two beside it. They were grouped
because they came back red together three times, and a grouping that does not hold is how
somebody ends up looking for one cause behind three symptoms. What the page has now is two rows
that flip with the take's length, and a third that was red three times on this rig and is not any
more, with nothing recorded about what moved it.

**Measured again on the tree that carries the projects page: `739 assertions, 2 failed`**, on four
takes at full render against a server on 8511 with `--take fixture-1g`, which is the 243.3s eight-
loop fixture — the same two rows, with the same two readings, `1 fallbacks` and `3 keys left`. The
total moved from 530 because section 13's rewrite and the multi-select block added rows, which is
the comparison worth making: a total that moves with a diff that explains it, beside a red set
identical in identity *and* in reading. Load average during that run was 136, which does not
weaken the reading in the direction anybody would worry about — a contended machine is where this
file records extra rows appearing, and none did.

## `cpp-check`, and why one configuration would not have been a check

**It needs a C++ compiler and turbojpeg's headers, and nothing else** — no libfreenect2
prefix, no sensor, no port, no install. `config.h` and `export.h` are the two headers CMake
generates, and it templates both into a scratch directory rather than reading them out of a
build, because a gate that needed `vendor/prefix` would need exactly the thing it exists to
run without. `turbojpeg.h` is resolved through `pkg-config` first and then the two Homebrew
keg-only paths, in the same order `native/CMakeLists.txt` resolves it, so the two cannot
disagree about which headers the grabber is being checked against. Missing either is exit 2 —
the harness did not run — rather than a failed claim.

**Say what the tick means, because it is narrower than "the C++ is fine".** This parses and
typechecks. It does not link and nothing runs, so a call to a function that is declared in the
vendored headers and absent from the built library is as green here as a correct one. What it
catches is the class that otherwise costs a rebuild on hardware to discover: a broken
statement, an argument of the wrong type, a name that is not in the headers.

**A single configuration would have been a coverage claim rather than a check.**
`grabber.cpp` chooses its default pipeline off which processors the library was compiled with
and branches per processor in three more places, so parsed with OpenCL alone — the macOS
station's build, and the one the host would pick if the gate configured itself off the machine
— every OpenGL arm is text the compiler never reads. A break in the Pi's branch would sit
green here until somebody rebuilt on the Pi. So it runs the four combinations of the two
macros the file branches on, and the control that says so is `--mutate opengl-branch-broken`:
it plants a type name that does not exist inside that `#ifdef` arm, and **reddens two of the
four grabber rows rather than all four**. Read the rows. A run where it reddened all four
would mean the mutation had escaped its arm, and a run where it reddened none would mean the
matrix had collapsed to one configuration.

`--mutate grabber-type-error` is the row that separates this from a tokeniser, and it is worth
keeping separate from the two syntax mutations for that reason alone: a gate that only
tokenised would take `HdEncoder("high")` happily, and an argument in the wrong unit or a
pointer where a value belongs is most of what a C++ mistake in this file actually looks like.

The canary runs before any of it: a file with `int x = ;` in it is fed to the compiler and the
run refuses to continue unless it comes back rejected. `syntax-check` buys the same thing for
`node --check`, and it bought it after finding a tree state where `node --check` accepted a
broken file in silence — so this is a lesson already paid for once rather than a precaution.

## The supply-chain gate

**npm 12 is the version this repo uses.** CI installs `npm@12.0.2` explicitly in the gate job
rather than taking whatever `setup-node` bundles, because `release-gate-check` is the one thing
here whose answer depends on the npm running it.

**The gate is read out of npm's refusal, not out of its config.** npm derives its cutoff from
the age internally; npm 11.12.1 exposed the derived date through `before`, and 11.16.0 and
12.0.2 answer `null` there while enforcing the gate identically. A check reading `npm config
get before` therefore went red against a repository whose gate had never been open - bookkeeping
that had stopped tracking the resource. The check asks npm to resolve a package and reads the
cutoff out of the refusal, which is measured identical on all three versions.

**npm does not fail open on a value it cannot parse.** Measured on 11.12.1, 11.16.0 and 12.0.2:
`min-release-age=2d` warns `invalid config` and then stops with `npm error Invalid time value`,
exit 1, nothing installed. A wrong *unit* is loud. What is silent is an npm older than 11, which
does not know the key and installs ungated without a word, and a value npm accepts that nobody
meant - `0` puts the cutoff at this instant and `-1` puts it tomorrow, neither warning about
anything, which is what the tool's two bounds rows are for.

It masks the user and global config layers while it runs, and that is load-bearing rather than
tidiness: this machine carries the same gate in `~/.npmrc`, so an unmasked run inherits it and
proves nothing about the repo. Rewriting the check reproduced that exact mistake in a throwaway
probe - with the layers unmasked, the *no gate* arm came back carrying a cutoff.

## Fixtures and the registration corpus

`captures/` is gitignored; the generator is committed and the artifacts are not.

```
node tools/make-fixture.js captures/sample.knct captures/fixture-large.knct --loops 32
```

**The sample was captured on a degraded link — median gap 64ms, mean 107ms, about 9.3fps rather
than 30.** So size fixtures by *frame count*, not duration: five minutes of its source time is
1.38 GB where a real full-rate five-minute take is 4.42 GB. A fixture is the sample looped with
rewritten monotonic stamps — real depth and real JPEGs, only the u64 at payload offset 8 moves.
Say so whenever a number rests on one.

**And no page can tell you which sample a checkout has, which is why three tools now refuse a
take instead of assuming one.** `captures/` is gitignored, so every sentence written here about
"the sample" describes a file the next machine may not hold — and they have already disagreed.
The paragraph above says 9.3fps; `keyframe-check`'s header said 284 frames over 30.36s and its
section 6d said 49.79s; the file in this tree is 284 frames over **9.42s at 30.03fps**. One
frame count, four durations, all of them written down as facts.

The damage is not the prose. `timeline-check` targets 12s, `editor-check` seeks to 30s and
`keyframe-check` retimes through source 20s. On a 9.42s take every one clamps: one row reddens in
`timeline-check`, ten in `editor-check` and four in `keyframe-check` against a build with nothing
wrong with it. The quieter half is that two more `keyframe-check` rows *pass*, because the key they
drag has left the ruler and a gesture that never happened also never slid a key under its
neighbour. The long fixture makes those fixture failures go away with nothing in `web/` changed.

So all three declare a `NEEDS_TAKE_SEC` and exit 2 naming the shortfall, in the same direction and
for the same reason as `requireMutationDelivered`: a red row reads as a catch, so a fixture
that cannot hold the gesture has to be the harness declining. The declaration is held against
the file's own literal seek targets by a scan of its own source, so a row added later that
seeks deeper cannot quietly fall outside it. **The control for all three is `--take sample`**: exit
2 with nothing asserted, where the same command used to run to the end and report failures.

```
node tools/make-fixture.js captures/sample.knct captures/fixture-1g.knct --loops 8
node tools/timeline-check.mjs --url http://localhost:8080 --take fixture-1g
node tools/editor-check.mjs   --url http://localhost:8080 --take fixture-1g --no-render
node tools/keyframe-check.mjs --url http://localhost:8080 --take fixture-1g
```

**`fake-grabber` honours `--no-color` and `--no-low-light`, and reports any argument it does
not know.** It ignored both for its whole life, which mattered because they are not the
operator's flags — the server appends them to the grabber's argv out of `camera`, so eight of
`library-check`'s servers were running colour-off and being answered with a `"color":true`
hello over frames still carrying full JPEGs. That is a stream the real sensor cannot produce
under the arguments it was given, and the mirror image of it — a hello claiming colour over a
take with no JPEG — is a state the server treats as corruption. Under `--no-color` the hello
now says `"color":false`, and `"lowLight":false` with it: `native/grabber.cpp` reports
`lowLight` as the **conjunction**, so colour off makes it false whatever the second flag said,
and a fixture watching only for `--no-low-light` reproduces the same defect one field over
while looking fixed. Every payload is rewritten once at load — the `colorBytes` u32 at offset
4 zeroed and the payload truncated to `16 + depthBytes` — because `server/capture.js` refuses
a frame whose two declared lengths do not describe it, so both edits are needed or nothing
parses.

**The depth it emits is real recorded sensor depth under both flags**, which is the whole
value of this fixture. What it still deliberately does not do is simulate a sensor: the
cadence is a flag, colour is dropped rather than re-shot, and `--pipeline`, `--log`,
`--quality`, `--min-depth` and `--max-depth` are accepted and ignored because there is no
device here to apply them to. Anything else in argv gets one line on stderr naming it and the
stream runs on — **reported, never refused**, because `buildArgs` appends `--pipeline` on a
server that was given one and a fixture that rejected a legitimate spawn would break that
path. That line proves the fixture noticed a flag, never that it acted on one; the behavioural
claims belong to `monitor-check`'s colour-off section, which watches the wire and the page
separately.

The registration corpus is gitignored like every other capture. Regenerate it with the sensor
attached, and vary the scene while it runs - a hand near the lens, a person against a far wall,
something occluding something further - because the occlusion filter only does work at depth
discontinuities:

```
./native/build/grabber --dump-corpus captures/reg-corpus --dump-count 40 --dump-every 45
```

Coverage is measurable rather than assumed: `registration-check --mutate filter-never-rejects`
reports what fraction of pixels the filter actually rejects. The committed corpus's 72 frames
sit at 6.93%; a first capture of one static-ish scene managed 6.55%.

**`captures/sample.knct` is not in the repository and a synthesised stand-in is not the
same fixture.** It is gitignored like every other capture, so a fresh clone has none, and
`library-check` needs one — every take it builds is cut out of it.

**`tools/make-sample.mjs` is the thing that decision was waiting for, and it is built to
avoid the three rows this paragraph used to predict it would fail.** Each of those was a
prediction about a stand-in nobody had written, and each turned out to be a property of how
it is written rather than of it being synthetic:

- **A sample with no colour block fails the two decimation rows.** So this one carries a
  real JPEG per frame, encoded by the tool itself. Not by ffmpeg: a generator needing a
  system package fails exactly the person it exists for, and one that used ffmpeg *when
  present* would put different bytes on different machines, which is the gitignored-fixture
  problem with the term varying per host. The size matters rather than the presence — one of
  those rows asserts `colorBytes / total > 0.35` at divisor 4, where the decimated depth is
  27,136 bytes, so anything under about 14.6KB fails it however valid the file is. Measured:
  a flat synthetic room encoded to 13.7KB a frame and failed at 0.336; with per-pixel grain
  it is **54.0KB against the real capture's 58.7KB**, at 0.671.
- **A sample whose hello carries `startedAt` fails the file-date fallback row.** So this one
  carries no `startedAt`, and no `format` either — a nine-key hello, which is what the
  capture in this tree actually holds and therefore a generation-zero take, the thing every
  take shot before that field existed is. That shape was read off the real file rather than
  chosen.

**Measured end to end rather than argued: `library-check --capture <synthetic>` comes back at
481 assertions, none failed — the same verdict, at the same total, as the same tool against the
real 138MB capture on the same machine.** Both decimation rows pass, and the second reports
`80.5KB = 27KB depth + 54KB colour, so 21ms a position against 123ms a whole frame at
3.8 MB/s`, which lands on the same ~80KB and 21ms the note beside that row was originally
written against. So the three rows this paragraph used to promise a stand-in would fail are all
green, and the sentence about which rows it cannot answer is now: none of them, on this suite.

**The first synthetic run did not say that, and how it was settled is the point.** It ended at
458 of 481 with one failure reading `the run did not finish: page.goto: Timeout 30000ms
exceeded` on `/gallery` — a crash rather than a claim, with every row before it green, which is
the shape this page already records for that section's neighbours. Re-run in the same
conditions it came back 481 and none failed. That is the rule at the top of `CLAUDE.md` doing
its job: a single red run against a new fixture is exactly where somebody concludes the fixture
is at fault, and the control is the re-run, not the reasoning.

What it still is not is footage. There is no depth jitter, no confidence gate chattering on a
flat wall, no dropped frames and no colour camera halving its rate in dim light, so anything
measuring those needs the sensor. It is deterministic — same arguments, byte-identical file,
because `Math.random()` would make every checkout's fixture a different one — and it takes
about 14s for 284 frames, landing at 139.0MB against the real 138.1MB and 9.47s against 9.42s.
Say which sample a run used when reporting its verdict; a number taken against a stand-in that
does not say so is wrong in both directions.

**The total is not written down here any more, and that is deliberate.** This sentence used to
carry one — "317 of 319" — and it was stale by twenty-eight the day it was next read, because
the total moves whenever a section is added and nothing was walking it. The number to compare a
run against is the one a baseline on the same tree prints: **527 assertions on darwin against
the real 138MB sample**, measured on the tree that carries the projects page, which is the figure
to re-measure rather than to trust. It read 365 on the merge that brought section 4f alongside the
capture format's band, and 352 before that — five rows from one branch and thirteen from the
other, neither of which knew about the other — and that is the rate a total in prose goes stale at
when two sections land in the same week.
