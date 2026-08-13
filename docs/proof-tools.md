# The proof-tool suite in detail

`CLAUDE.md` carries the invocation list — what exists and how to run it. This file is what
each tool needs, what its exit codes mean, and the per-tool facts that are only worth having
when you are about to run or edit that tool.

For the method behind the suite, see `docs/instruments.md`.

## Exit codes, and why reading them is a trap

**The tools disagree about what a caught mutation exits,
the disagreement runs the dangerous way, so read the assertion count and never the code.**
Counted rather than recalled:

- **Seven exit non-zero on a catch and say `NOT CAUGHT` when they miss**: `guard-check`,
  `jobs-check`, `editor-check`, `monitor-check`, `sensor-view-check`, `level-check`,
  `vcam-check`.
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
- **Four have no `NOT CAUGHT` branch at all** and simply exit on their failure count:
  `timeline-check`, `export-check`, `keyframe-check`, `library-check`. **A mutation these four
  fail to catch exits 0**, which reads as a clean pass rather than as the check being blind.
  That is the same direction as the inverting group above and it is silent rather than merely
  confusing, so it is the worse of the two shapes.

Which is why the rule is worded the way it is: count failed assertions, never exit codes — and
read *which* assertions fired, because a tool that counts its own crash as a failure reports a
catch it never made.

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

**That qualifier is load-bearing, because the exit-code census above has fifteen entries and
this list has fourteen names.** `release-gate-check` is the difference, and it carries three
mutations — `wrong-unit`, `no-gate` and `absent` — by a third mechanism: each is a whole
`.npmrc`, written into a scratch directory npm is then asked to resolve a package from, so there
is no source text to match and nothing for the refusal above to be about. Both numbers are
right because they count different things, so do not reconcile them — a fifteenth name in this
list would claim a delivery that tool does not use, and dropping it from the census leaves the
tool whose convention is easiest to read backwards as the one nothing documents.

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
and it is served at `/gallery`, so an interception written as `**/library.html` matches
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
named with the URL and the byte count, `gallery-has-no-way-back` among them at `/gallery`,
which is the case the interception existed for. The twentieth is `marks-ignore-retime`, which
could not be constructed at all — its anchor matched twice in `web/main.js` and the
match-exactly-once refusal stopped it, a stale anchor that predated this and was tracked in #28.
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

**`determinism-check --clock`** refuses a rev whose `main.js` already contains the transport,
so it needs `--before` pointing at a commit before step 1.

**`export-check`** needs ffmpeg and ffprobe (`--ffmpeg`, `--ffprobe`; 8.1.1 at
`/opt/homebrew/bin`) and writes into `exports/`, which is gitignored.

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
baked `0.55` inside the pass rather than a parameter. Blackwall carries `vignette: 0.55`,
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
Blackwall's own `rgbSplit`/`scanlines`/`grain` survive on both sides, so both builds run the
grade — and that table came out that way rather than being fitted, which is the reason to
believe the diagnosis.

**The class is closed rather than the instance.** Whether a pass runs is *derived*, so a
build that adds one name to a gate silently changes which arms are comparable and the only
symptom is a ratio. `RES_ARM` now returns the composer's own pass list, and every cross-build
row requires the two builds to have run the same chain — printed in the row's message either
way. `UnrealBloomPass` becoming `BloomPass` is normalised by name rather than skipped, so a
rename nobody knew about fails loudly instead of passing quietly.

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

**`registry-check` is red on one row, `readGhost`, and it predates this branch.** The claim is
that `readGhost` at 1.0 is bit-identical to the old `mode 2` at `f49c8339…^`. Measured at the
branch point `6e1be6f` it fails on one frame of six; at HEAD it fails on two, frames 2 and 3.
So it is not something this branch introduced, and it did get worse here — both halves of that
sentence matter, and neither was written down anywhere until now, which is how a known-red row
becomes a row nobody re-derives. A comment in `web/cloud-shader.js` calls it "the pre-existing
readGhost failure" and that comment arrived in `40ab241`, which is testimony rather than a measurement;
the two runs above are the measurement. Nothing has dated the one-frame-to-two change, and the
same bisect harness that dated the `export-check` rows would do it.

**`keyframe-check`** runs its cheapest claim first, on a 60-second budget, and stops the run if
it fails. That is not ordering by cost: an evaluator that announces its writes schedules a seek
per frame, each of which renders a pre-roll which evaluates, so the page never answers and
never errors - it runs out of memory some minutes later, somewhere else. A bounded probe turns
that into a sentence.

**Its section 6e stands on something nobody wrote down until it nearly broke.** The two
`page.click('.kf[aria-label="bloom keyframe"]')` calls need that diamond *visible*, and `bloom`
lives in the `optical` panel group, which collapses when every parameter in it is at its
default. They work only because 6e applies the Blackwall look first and that look moves `bloom`,
`rgbSplit`, `scanlines` and `grain` off their defaults, so the group has derived itself open by
the time the click lands. Nothing in either file says so, and the two ends can move
independently: a look re-graded to leave `optical` alone, or a change to the reveal predicate,
turns those clicks into thirty-second timeouts - which arrive as a crash with **zero failed
assertions**, the shape this repo has twice recorded being written down as a bug found. If you
touch either end, run `keyframe-check`; `editor-check` section 13c is the row that grades the
mechanism itself.

**`jobs-check`** spawns its own server and renders two real jobs through
`tools/render-worker.mjs`, so it needs a GPU browser and ffprobe. `--no-render` drops both rows
and says so - the queue rows are seconds, each render is about a minute.

**Its mutation runs are no longer all `--no-render`, and reading them as though they were is
how a control gets recorded as green without running.** Every one but `heartbeat-stops-on-first-error`
is queue semantics and wants `--no-render`; that one names a line in the worker's beat, is
reached only by a render, and needs the browser and about two minutes. Take the names from the
tool's own refusal rather than from a count written here - this sentence used to carry one and
it was wrong, which is what a count in prose beside a list that grows does to itself, and
enumerating from the refusal is what `sweep-all` already does for the same reason. That the
split is by *which* mutation rather than by a number is the same argument arriving one level
down: a reader who takes "its mutation runs use `--no-render`" as a rule runs the one that
needs a render without one, and it passes.

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
`describeTake` and the gallery's badge and dead Open button were three separate comparisons, and
the last two now quote `openRefusals` instead. What is left is `OPEN_REFUSALS.format`, which
delegates the sentence, and `openTake` in the editor, which is handed a hello and never a
manifest — so `format.js` is still where the band lives, and a comparison inlined at either door
would still pass every row here and drift the first time the band gains a member.

So the assertion the mutation really carries is the *count*: it reddens **8 of 392** — the
listing's `openable`, the refusal the take carries, the two-table containment row, the gallery's
badge and its Open button, the menu's sentence, and the editor's console line and its refusal
to open.
The count grew when the surfaces stopped deriving, which is the right direction: quoting one
sentence in five places means a band that stops refusing is visible in five places rather than in
one. The takes that must stay green stay green — both `no-hello-take` rows, `local-clip`'s
`dateSource === 'hello'`, and all four generation-zero rows. A mutation that reddened fewer would
mean the band had quietly become several predicates that agree.

**Its opposite number is `--mutate openable-recomputes-the-band`**, which puts the band back to
being a term in `openable` rather than an entry in the table, and it exists because
`openable` is false either way. Every row asking whether the future-format take opens passes a
build where the band decides for itself again — measured: 5 of 392, and the three rows that
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
This tool does carry a `--mutate` harness, but its table holds one entry and that entry belongs
to the specification row below, so nothing here has a named mutation — which is worth stating
rather than leaving to be inferred, since a reader who saw the flag would otherwise read a green
`--mutate spec-drifts` as a control over these assertions too. Add a key to the grabber literal
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

**Section 13's resume rows are flaky on a loaded machine, and they are written down here for
the same reason `library-check`'s three are.** The family is the autosave-and-recovery block —
`and the recovery is written after the auto-saves already in flight`, `a take opened with no
working document beside it offers nothing, which is what makes the rows below about the
document`, and `and neither is one that matches the clip on screen`. Measured across twelve
runs on two builds during one session: **6 red, 6 green, with the precondition row
(`toggled additive, 1 auto-save in flight, chip shown`) green every time**, so the fixture
builds and the ordering simply comes out differently. The block waits on a fixed 3000ms hold
and a fixed 6000ms settle.

What identifies it as the rows rather than the change under test is the same evidence
`library-check`'s entry rests on, in a sharper form: **which member of the family fires
rotates between windows.** Four different subsets were observed across two builds — the
recovery-ordering row, the matching-clip row, the no-working-document row, and none at all —
with the precondition green every time and both final baselines passing all of them. Three
subsets would already be suggestive; four is the statement, because **an ordering bug picks
the same row.** A run that reddens only these is a re-run, not a finding.

Two things make it worse than ordinary noise here. A polluted `projects/` store is the first
suspect and the cheapest to rule out, because anything that has been driving the editor by
hand against the same server leaves real autosaves and deliverables behind it; take the
re-run against a clean store rather than the one that just failed. And the same block can
**crash rather than fail**: observed once as `DID NOT RUN - page.selectOption: Timeout
30000ms exceeded` at 313 of 396, on `page.selectOption('#tProject', OTHER)` with Playwright
reporting `did not find some options` — section 13's own fixture stubs `/presets` to 500,
reopens twice, then expects the project picker to carry the name it planted. It was transient,
with four later runs through the same block on the same build going through. Per the rule at
the top of this file that is a crash to investigate and never a catch, and it is exactly the
shape that reads as a catch to anything counting exit codes.

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

**Section 15 grades a feature whose whole design is that it stores almost nothing**, and its
five controls exist because most of the ways it can be wrong are invisible from the panel.
Whether a parameter group is open is derived — a group is open when any parameter in it carries
keyframes or holds a value off its own default — and the only thing written down is a person
disagreeing with that, in `localStorage` under `kinect.panelGroupsOpen`, deleted again the
moment the derivation catches up with them.

- **`group-never-reveals`** is the falsification control for the derived half: the predicate
  answers "nobody has been here" whatever the document holds, so a group carrying live values
  renders shut. It reddens **14 rows** and the shape of that set is what to read. The rows that
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
- **`detail-ignores-the-reading`** puts `Reading · detail` back onto the default rule. It takes
  the *reading* terms out of that group's closure and leaves `revealsItself('detail')` standing,
  so tuning a parameter inside the group still opens it exactly as before — the loss is narrower
  than this document once claimed, and precisely so: the group's seven parameters sit at the
  shader literals they replaced, so on the default rule alone it stays shut whichever reading is
  live, which is the one case its closure exists for. It reddens **three rows**; the first
  carries the claim and the two below it are the fixture saying it could not establish a live
  `detail` to test the store rule against. It was four until 15i stopped needing a `detail` that a
  reading had opened: that block pins `detail` open while it is *quiet* now, which is a
  disagreement whether or not the closure reads the readings.

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
group open. It works because 6e applies the Blackwall look first, which moves `bloom`, `rgbSplit`,
`scanlines` and `grain` off their defaults — so the per-write refresh that opens a group is
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
in the suite pointed at the recorder's panel** — 20 blocks, 54 parameters on both surfaces, the
nine look groups hidden and then revealed by `extended settings` — so a change to the panel is
still graded on both surfaces on a sensorless rig, and that section is what to read. One row in
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
is named in `CLAUDE.md`, which is why the invocation list lives there rather than here — a tool
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
names `web/curve.js:194` and `web/scene.js:152`, which are the two `export { … }` lists that
would otherwise have vanished.

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
has no dot in front of it either, which is what `web/main.js:9860` is and what made an alias of
`poll` look read. That one will not close with a lookahead, and the measurement says so rather
than the argument — excluding a hit followed by `:` or by `(` at the head of a line calls twelve
live imports unused, `writeClipRange`, `tiltQuaternion` and `pollRecordState` among them, because
a call written as its own statement is at the head of a line too. Re-measured after the two
closures above, the `poll` alias still comes back NOT CAUGHT, so the limitation is exactly this
wide: it is a false negative, costing a dead import this row does not find rather than a clean
tree it fails, and telling a definition from a reference needs a scope analysis rather than a
search.

**Its first catch was real, and it arrived one commit late.** On the tree as it stood after the
six imports came off, the export half reddened `web/curve.js:66`: `easeSlopeAt` was let out
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

**And no page can tell you which sample a checkout has, which is why two tools now refuse a
take instead of assuming one.** `captures/` is gitignored, so every sentence written here about
"the sample" describes a file the next machine may not hold — and they have already disagreed.
The paragraph above says 9.3fps; `keyframe-check`'s header said 284 frames over 30.36s and its
section 6d said 49.79s; the file in this tree is 284 frames over **9.42s at 30.03fps**. One
frame count, four durations, all of them written down as facts.

The damage is not the prose. `editor-check` seeks to 30s and `keyframe-check` retimes through
source 20s, and on a 9.42s take every one of those clamps: **ten rows redden in `editor-check`
and four in `keyframe-check` against a build with nothing wrong with it**, and — the half worth
fearing — two more `keyframe-check` rows *pass*, because the key they drag has left the ruler
and a gesture that never happened also never slid a key under its neighbour. Seven of the ten
and all four of the four go green on a 75.6s fixture with nothing in `web/` changed.

So both declare a `NEEDS_TAKE_SEC` and exit 2 naming the shortfall, in the same direction and
for the same reason as `requireMutationDelivered`: a red row reads as a catch, so a fixture
that cannot hold the gesture has to be the harness declining. The declaration is held against
the file's own literal seek targets by a scan of its own source, so a row added later that
seeks deeper cannot quietly fall outside it. **The control for both is `--take sample`**: exit
2 with nothing asserted, where the same command used to run to the end and report failures.

```
node tools/make-fixture.js captures/sample.knct captures/fixture-1g.knct --loops 8
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
`library-check` needs one — every take it builds is cut out of it. A synthetic one is enough
to run the whole suite and it is worth knowing exactly which rows it cannot answer: **a
sample with no colour block fails the two decimation rows by construction** (`the colour
block is carried through untouched` and `divisor 4 lands at the ~80KB`), because those
measure a JPEG the stand-in does not contain, and a sample whose hello carries `startedAt`
fails the file-date fallback row, because the fixture depends on some takes having no wall
clock. Neither is a defect in the build. Say which sample a run used when reporting its
verdict — a run against a stand-in fails the rows named above by construction, and reporting it
as a pass or as unexplained failures without naming the fixture is wrong in both directions.

**The total is not written down here any more, and that is deliberate.** This sentence used to
carry one — "317 of 319" — and it was stale by twenty-eight the day it was next read, because
the total moves whenever a section is added and nothing was walking it. The number to compare a
run against is the one a baseline on the same tree prints: **365 assertions on darwin against
the real 138MB sample**, measured on the merge that brought section 4f alongside the capture
format's band, which is the figure to re-measure rather than to trust. It went from 352 to 365
in that merge alone — five rows from one branch and thirteen from the other, neither of which
knew about the other — and that is the rate a total in prose goes stale at when two sections
land in the same week.
