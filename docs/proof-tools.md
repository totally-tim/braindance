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
  That is not hypothetical — two of its four mutations reddened their intended row and *then* died on
  Playwright's `Target page, context or browser has been closed`, and without the crash handler
  each would have exited non-zero having asserted the right thing for the wrong reason.
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
cannot be constructed at all — its anchor matches twice in `web/main.js` and the
match-exactly-once refusal stops it, a stale anchor that predates this and is tracked in #28.
The control for the delivery refusal is to stop staging `web/` files and run a page mutation:
it names the file, the URL and both byte counts, and exits 2 without printing an assertion.

## What each tool needs

**`determinism-check --clock`** refuses a rev whose `main.js` already contains the transport,
so it needs `--before` pointing at a commit before step 1.

**`export-check`** needs ffmpeg and ffprobe (`--ffmpeg`, `--ffprobe`; 8.1.1 at
`/opt/homebrew/bin`) and writes into `exports/`, which is gitignored.

**It is red at HEAD on ten rows, and that predates the mirror fix.** Measured with an
interleaved A/B/A on an idle machine against a private server on the fake grabber — baseline
taken by copying the modified files out and `git checkout --`, never `git stash` — the same ten
rows fail with and without the geometry change, and the two baseline arms reproduce each other
to three decimal places:

- five within-build resolution rows (`points`, `splat`, `noise`, `regionpush`, `regionmask`:
  *1920x1200 is 960x600 at twice the size*), failing on the coarse-mean term with the luminance
  ratio well inside tolerance — `splat` is the worst at 2.516 against a 1.2 bound;
- five cross-build rows against `f14b4be…^`, two Blackwall rebase arms failing on the ratio term
  at 1.026 and 1.022 against a 0.02 bound, and three preset rows failing wider.

**What is not known is when they went red**, and that is the next thing to establish rather than
a thing to assume: dating them needs a bisect over the commits that touched the look, and the
duotone and raster work is the obvious first suspect precisely because these rows read luminance
ratios and tile means. Do not read the ten as a finding about anything until that is done, and do
not read them as harmless either. Nothing in the mirror work touched them: with the historical
arm normalised for the sign, the two Blackwall arms read 1.21 and 1.12 of 255 on the worst of
forty tile means, against 1.02 and 0.95 for the same rows at HEAD — run-to-run noise — where an
un-normalised arm reports 22.19 and 22.14. The normalisation is what makes that comparison
possible at all, and it is why the sign appears in this tool as well as in `registry-check`.

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
badge and its Open button, the menu's sentence, and the editor's note and its refusal to open.
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
