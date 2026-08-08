# Writing a proof tool that means something

Read this before writing or modifying any proof tool. It is the case file behind the
short rules in `CLAUDE.md`, and every entry is something that was found by running the
thing rather than by reading it.

Two neighbouring documents, and the seam between them is worth stating so a new lesson
lands in the right one. **This file is about a check that must fail when the thing under
test is broken.** `docs/measurement.md` is about a number you would report. And
`docs/proof-tools.md` is the suite reference — what each tool needs and what its exit
codes mean.

## An instrument must enforce its claims, not assert them

This is the failure mode this repo keeps producing, so check for it by name. Twice now a
proof tool has stated a condition in its header while doing nothing to bring it about:

- `determinism-check --clock` claimed "no frame ever arriving" but left the socket to
  whatever the server was doing, and returned FAIL/PASS/PASS on an unchanged tree.
- `index-check` claimed the scan never holds the file, while an implementation that appended
  every chunk to an array would have passed every assertion it made.

Both are fixed and both now enforce the condition — the first intercepts the socket and
*verifies the interception held*, the second asserts resident memory against a ceiling and a
growth bound. When you write a proof tool, ask what a broken implementation would have to do
to still pass it, and close that. **Every proof tool needs a falsification control**:
something that must FAIL if the thing under test were not actually doing the work.

### A rule with two terms, driven only through the term the code already handled

The sharpest version of "an instrument must enforce its claims" yet, because the row was
honest, the gesture was real, and the check was still blind by construction.

The panel's store rule is a comparison: an override is kept where it disagrees with what the
document derives, and dropped where the two agree. Two terms, and either can move. The check
drove one of them — press a toggle to collapse a live group, press it again to reopen it,
assert the entry is gone — and reported the rule holding. It did hold, on that path, because
`toggleGroup` compares the two *at the instant of the press* and pressing back is the one
gesture where they agree by construction. **The path the check drove was the only path that
never needed the fix.** The other term moves without anybody pressing anything — a value set,
a look applied, a project opened — and nothing in the section moved it, so a build whose prune
lived entirely inside the toggle passed 22 assertions with a group pinned open over an empty
document, and the comment beside that code claimed self-healing behaviour the code had never
had.

Two things generalise. **When a claim is a comparison, ask which side your fixture moves**, and
write a row for each — a check that only ever changes the term the handler is written around is
asserting the handler rather than the rule. And the tell was in the prose before it was in the
behaviour: the section's own comment said the entry goes "the moment the derivation catches up",
while every gesture under it moved the *override* and left the derivation alone. A sentence
naming a term no arm touches is a hole with a label on it.

`override-prunes-only-on-toggle` is the control, and it restores the pre-fix build exactly
rather than breaking the feature some other way — the prune moves out of `refreshGroups` and
back into `toggleGroup` in one edit. That matters for the reason the whole document keeps
repeating: a mutation that also failed the toggle rows would redden a path this build gets
right, and a control that fails everything cannot say which question it was asking.

### The passthrough row that hashed a served part against the set of served parts

`vcam-check` section 2 claimed "the bytes served are the bytes emitted", with a comment above
it saying in as many words that anything decoding and re-encoding on the way through would fail
it. It could not. `frame` was taken off the end of `sub.parts`, `jpegHash` was the hash of
`frame`, and the row then asked whether anything in `sub.parts` hashed to `jpegHash` — which
`frame` does, being one of them. The other half of the conjunction was `served.length === 64`,
true of every sha256 hex digest there has ever been. The whole row reduced to "the emit log is
not empty", and the log was read and then never compared against anything.

The reason it was written that way was real and was even stated in the comment: the emit log's
third column hashes the whole payload, which for a colour message is a u64 stamp then the JPEG,
and the stamp moves per frame, so the logged hash can never equal the hash of a served part.
Faced with two sides that could not be compared, the row hashed one side against itself. **When
the two ends of a comparison do not share a quantity, make the writer log one — do not hash
around the problem.** The fix was a fourth column carrying the sha256 of the part body, passed
in at the call site because the wire layout belongs there and `note` should not have to know
that type 3 puts a stamp before its JPEG.

`hd-reencodes-in-flight` is the control, and it was written *before* the fix and run against the
unfixed row on purpose: `[vcam] 22 assertions, 0 failed`, `NOT CAUGHT`, with every row in
section 2 green including both of the ones that exist to catch it. That output is the finding.
Two things it taught that generalise. The mutation has to be memoised, because a synchronous
1920x1080 re-encode per message starves the stream until `a frame was served at all` reddens
instead — a control that fires for a neighbouring reason is not a control. And its ffmpeg
fallback means an ffmpeg that failed to run prints NOT CAUGHT too, so what discriminates a real
catch is the *pair*: NOT CAUGHT against the old row, `caught, as required` against the new one.
A single run in either direction would not have said which.

### A defect that moves a word rather than removing it, and two rows that asked whether it was there

`library-check`'s colour-toggle-during-the-backoff section asserts that the *next* genuine
grabber death is still reported `lost` and still counts toward the backoff table. Both rows read
for a presence: `after.includes('lost')`, and the backoff line count being greater than the count
taken before the toggle. Both passed the mutated build, so `--mutate exit-keeps-the-child-reference`
reddened nothing at all — and `library-check` has no `NOT CAUGHT` branch, so it exited 0 and read
as a clean pass rather than as the check being blind.

What made the rows wrong is that the defect does not delete either signal. It **moves** them. The
toggle landing on a stale `child` reference calls `stopGrabber` on a process that has already
exited, and that announces a `lost` of its own; the respawn that follows still writes a backoff
line. Measured side by side, the fixed build's status slice was `starting live lost` and the
mutated build's was `lost starting live starting`, and the backoff counts went 1→2 fixed against
0→1 mutated. Membership is true of both. "Greater than before" is true of both.

The two fixes are the same fix in different clothes. The `lost` row now asks for **order** — the
`lost` has to sit after the `live` that the respawn produced — which is what "the *next* failure"
meant all along and which is incidentally robust against the previous death's `lost` arriving late
and landing in the slice. The backoff row now asks for **one line per death**, `backoffAtRead ===
exitsAtRead`, rather than for growth; the count taken before the toggle turned out to be a race in
the fixture and is now reported rather than asserted on, since `scheduleRetry` writes its line just
after the exit the poll loop watches for.

Two things worth carrying forward. **When the thing under test is a sequence, a row that asks
whether a value appears anywhere in that sequence has thrown away the only axis that discriminates**
— ask where it appears relative to the event it is supposed to follow. And the diagnostic that had
been deliberately left un-asserted is what caught this: the section prints the server's own
`colour camera on - ...` line, and reading `restarting grabber` where a fixed build prints `takes
effect on the next spawn` is what said the mutation had applied and reached the branch while the
rows agreed with it. **A printed-not-asserted probe beside a claim is how you tell a control that
missed from a fixture that never ran** — the two are indistinguishable from the assertion count.

### An A/B where one arm cleans up after the other measures nothing

The version of that failure worth naming separately, because both arms run, both produce a
real image, and the comparison is still empty.

Section 3c's change lets a draft skip the accumulator reset when the playhead has not moved,
and the claim it rests on is that the surface memory cannot reach the image while fade and
wake are held at zero. The first test of it alternated the two arms back to back — reset,
skip, reset, skip — and reported bit-identity over four pairs and three million bytes, which
sounds like a strong result and was worth nothing. **A resetting draft clears the
accumulators and then writes nothing back into them**: no steps, so no state advance, and
trails at zero, so the afterimage pass is off. Every skipping arm therefore ran on buffers the
resetting arm had just emptied, and the one case the change actually affects — a draft landing
on top of an accurate seek, whose pre-roll has just loaded those buffers — never occurred in
the test at all.

The tell is structural rather than numeric, so it can be looked for: **ask whether arm A
leaves the state that arm B is supposed to inherit, and in what condition.** If A's job
includes resetting something, alternating A and B hands B a reset every time. The fix was to
re-establish the state at the head of each arm — each one re-seeks now — and to add the
control that says the state was there to inherit: the seek's own image differs from its draft
over 2.21M bytes at worst 170/255, so the buffers held something. A second control on the
readback itself, because a comparison of two identical zero-filled arrays also reports
bit-identity: holding the camera still gives 0 differing bytes and nudging it 0.25m gives
383,769 at worst 255/255.

### A flag that the right answer and the wrong one both set

Section 9's release row asserted `(await read()).drafted === false` and called that "the
release still lands the accurate image". It does not. `seekNow` clears `drafted` whatever
position it was handed, so a release that seeked *accurately to the wrong moment* — the
mutation is `timeline.programSec + 1` — set the flag to false and passed the row, while the
viewport visibly sat a second away from where the hand let go. The row read the transport's
bookkeeping and named the rendered result.

The tell is one word doing two jobs. "Accurate" in the flag means *a seek ran rather than a
draft*; "accurate" in the claim means *the seek went where it should have*. **Ask which of the
readings a broken build would also produce** — here, every one of them, because the only thing
the flag can distinguish is which method ran.

What replaced it compares pictures, and it takes two rows rather than one: a comparison that
cannot separate two moments would pass on every build there is, so the row that says it *can*
has to come first. The statistic is forty tile means over the stage rather than one lit count
over it, because a cloud a second along mostly redistributes its brightness instead of changing
how much of it there is, and a scalar can come out equal for two genuinely different pictures.
Measured, one screenshot per arm on an idle machine: the released picture sits 0.24/255 from an
accurate seek to the same moment on the worst of the forty tiles, where a seek one second away
sits 4.48 — an eighteen-fold separation, and the claim row asks for a fourfold one.
`release-seeks-past-target` is the control, and it moves that worst tile to 4.50.

### A floor stated in the wrong units stops being able to fail when the selector under it widens

`editor-check` section 1 sweeps the controls the editor renders and demands a driver for each,
and the row under it is what stops that claim being satisfied by having nothing left to cover:
`check(sweep.length > 60, 'and the sweep found the panel, not an empty page')`. It meant what it
said for as long as everything the selector could reach was the strip or the panel.

The preset subset dialog is a body-level `<dialog>`, so the sweep was widened to
`dialog input, dialog select, dialog button, dialog a` — correctly, because a modal outside every
observation is the deliberate exclusion this document already records costing three holes. That
put 68 more controls inside the same count. **68 clears 60 on its own**, so from that commit a
build whose panel had gone entirely would have passed a row whose entire sentence is that the
panel was found, and passed it green, in a run with nothing else red. Measured either side: 160
controls at the commit before, of which 131 were the panel; 228 after, of which 131 are still the
panel and 68 are the dialog.

**And the same failure has a second form, where the population does not grow but the thing being
counted stops being the thing the sentence is about.** `sensor-view-check` section 6 asserted
"and open on the editor, where grading is the job - 9 look groups, all 9 visible", counting group
*nodes* through `checkVisibility`. Then the panel learned to collapse a group that the document
says nothing is in — and collapse hides a group's **rows**, not the box around them, so the node
goes on answering `true` with nothing gradeable underneath it. The row passed, correctly by its
own arithmetic, on a recorder showing four of its nine look groups as a heading and a chevron.
It was found by pressing `extended settings` on the recorder, which nothing else in the pass
covered: every screenshot and every `editor-check` row is `/edit`, and a recorder has no clip, so
every look parameter sits at its default and all four collapsible groups derive shut at once.

The repair is to count the controls rather than the containers — `input, select` inside each
block, hit-tested the same way — and to say which groups the collapse rule shut in the detail
line, so the split between "hidden by the surface" and "collapsed by the document" is legible
instead of averaged away. **A container is visible for a different reason than its contents
are**, so a row about whether something is on screen has to name which of the two it means and
count that one. Which groups collapse stays `editor-check` section 13's subject, because a
collapse derived from the document is a different feature from a surface that hides the grade,
and one row asserting both would go red for either.

Nothing would have caught it. The row it protects — every control has a driver — went on working
perfectly, because that one ranges over the same widened set and *should*; only the floor was
stated in units of what the selector happened to return rather than in units of the thing it
protects. The repair is one line, `sweep.filter((r) => r.groups.includes('#panel')).length > 60`,
and it reports `131 of 228 controls are the panel's` so the two numbers stay visible.

**When you widen what a count ranges over, re-read every threshold on that count against its own
sentence.** A floor is denominated in the thing it is defending, and a selector is not. This is
the vacuous-conjunction failure at the top of this document arriving from the other direction:
there, a row compared a quantity against a set containing it; here, a row kept comparing the same
quantity while the set underneath it grew a second population that satisfies the comparison alone.

**And the repair for that second form arrived carrying the first failure this document names,
which is the part worth reading twice.** The row that replaced it read
`edFixed.length > 0 && edFixed.every((b) => b.controls > 0 && b.controlsOnScreen === b.controls)
&& sum(edLook, 'controlsOnScreen') > 0` — and the last conjunct cannot fail while the one before
it holds, since a group showing all of its controls with a positive control count *is* a positive
sum. A vacuous conjunction, written into the change whose commit message cites the vacuous
conjunction at the top of this file. The floor beside it was denominated wrongly in the same way
the `sweep.length > 60` one was: `edFixed` is the look groups that do not declare `collapses`, so
it narrows towards one as more of them do and would reach zero without a word, while the claim
underneath it is about the grade being reachable at all.

The repair is to partition rather than to floor. The look groups are split by the `shut` class
the panel sets, every group the collapse rule leaves open has to show *all* of its controls,
every group it has shut has to show none, and there has to be at least one of the first — which
is checked from both sides, so a build marking everything shut fails the floor and one marking
everything open fails the controls. **A conjunct earns its place by being able to fail while its
neighbours hold**, and the cheapest way to find out is to ask what would have to break for that
term alone to go red. The same row on the recorder had the weaker version of the same problem:
`after.controlsOnScreen > before.controlsOnScreen` with the row above pinning `before` at zero,
so "controls included" was graded at one control appearing anywhere on a surface with fifty of
them, and it now asks the recorder's revealed groups exactly what the editor's row asks.

Two smaller things from the same change, recorded because each is a rule already here landing
somewhere new. The dialog's rule in `covered()` has to be tested **before** the panel's, since the
panel rule matches any `#panel` checkbox and would have credited 54 dialog checkboxes to
`registry-check`'s drop-one slider sweep, which has never heard of them — the misattribution the
`DRIVER_RULES` re-keying was done to stop, reappearing as an ordering rather than as an index. And
the row asserting that unticking a group heading takes its whole group out was first written as
`after.length === before.length - off.length`, which is true by construction of a set difference:
a row that cannot fail, in the middle of a section about rows that cannot fail. It reads the
panel's own group out of the DOM now and requires the two groupings to be the same grouping.

### A driver rule keyed to a container covers whatever the container grows next

`editor-check`'s `appbar` rule claimed that "section 1 opens every menu, drives the commands that
stay on this page, and asserts the two real navigation destinations in the markup" — an accurate
sentence about the menus. It matched on `inGroup(row, '#appBar')`, which is not the menus but the
bar they happen to sit in, and for as long as the bar held only menus the two were the same set.

Then the status slot moved into the application bar, and the bar stopped being only menus without
the rule noticing that its sentence had narrowed under it. `--mutate plant-unswept-control` plants
a bare button beside `#tNote`, which is in that slot: the sweep found it through `.appbar button`,
`DRIVER_IDS` did not name it, and then the container rule matched it on the strength of sharing an
ancestor with the File menu. **The run reported 420 assertions, 0 failed, and NOT CAUGHT** — the
falsification control for the whole "enumerate rather than list" claim, passing. Nothing else was
red, so section 1 went on reading green while enforcing nothing about any control the bar might
grow.

The narrowing is to `#navRow` plus a button-or-anchor test, because the nav row is what section 1
actually walks, and the back link — which sits outside it — moved into `DRIVER_IDS` beside the
assertion that reads its href. **The general form: a rule's `match` has to name the class its `by`
describes, and a container is a different claim from the controls that were in it when the rule
was written.** A rule matching an ancestor is a rule that silently adopts every control added to
that ancestor afterwards, which is the opposite of what a coverage rule is for. There is already a
row asserting that no rule matches *nothing*; the mirror of it — that no rule matches more than
its sentence — is the harder one, and this is the case that says why it is worth having.

### A colour filter whose comment named the exception it did not exclude

`planExtent` in `level-check` reads the top-down inset off the overlay's own backing store and
keeps pixels that are bright and near-neutral, with a comment saying why: the path is drawn in
teal and the frustum in orange, "and the cloud is the only near-neutral thing in there." That
sentence is the assertion, and it was never true. The inset's TOP-DOWN caption is `#6d7683` —
red 109 against a floor of 90, and 9 and 13 apart on the two neutrality bounds against a
tolerance of 26 — so the caption cleared every term of the filter and was counted as cloud from
the day the filter was written.

It cost nothing for years because every row using it measured an **extent**, and a caption
sitting in a fixed corner perturbs a 159x118px bounding box by a few pixels. The first row to
ask for a **position** found it immediately, and found it as a wrong answer rather than as a
red row: with the caption in the average, two bands planted on opposite sides of the optical
axis both reported left of centre and 0.017 apart, which reads as a real measurement of a real
displacement and is a measurement of the caption.

The fix is subtraction rather than a tighter threshold, and the distinction is worth keeping.
Raising the brightness floor to exclude 109 would have put the floor within about twenty of
what a single splat of `rgba(232, 236, 241, 0.55)` composites to, so the filter would have
started deciding between the caption and a thin cloud on a margin nobody measured. Reading the
inset once with an **empty depth grid** and subtracting that reading is exact instead: the
furniture is whatever the box contains with no cloud in it, and it cancels term by term.

**The general form: a filter's comment enumerating what it excludes is an assertion about the
whole drawing, and it dates the moment it was written.** Anything added to that canvas
afterwards — or already there and never checked against the predicate — is admitted silently.
Where the reading is a position rather than an extent, measure the baseline and subtract it,
because a position has no tolerance to hide a passenger in.

## Mutation-test the instrument, don't just reason about it

Deliberately break the thing under test, run the check, and confirm it fails on the
assertions it should. This is the method that turns the rule above from an intention into a
result, and it has now caught two flaws that reading the code did not:

- A serialisation check whose `||` clause let it pass on key count alone.
- A malformed-value table that passed its cases into the page through `JSON.stringify` —
  which turns `NaN` and `undefined` into `null`, so three cases labelled as NaN were silently
  testing null a second and third time. **If you send test values into a browser, send them
  as source, not as JSON**, or your labels will claim coverage you do not have.

Report which mutations you ran and what each one caught. A check nobody has broken on purpose
is a check nobody knows the sensitivity of.

### A source row that reads the staged tree cannot be falsified by a page mutation

The match-exactly-once rule guards the *anchor*. This is the same hole one layer further
out, in the **delivery**, where nothing refused it — and it was almost shipped as the
falsification control for a row about the sensor grid being declared once.

`library-check` applied its two kinds of mutation by two different mechanisms, and only one
of them touched the tree. `stageServer` wrote a **server** mutation into the copied tree,
so a row reading `join(root, 'server/…')` saw it. A **page** mutation never landed on disk
at all: `openPage` installed a Playwright route interception, so the browser got the
mutated body and the staged `root/web/main.js` was still the clean file. A row that walked
the staged tree looking for a literal would therefore have passed against every page
mutation there is, while looking exactly like a row with a control behind it.

**The tool now has one delivery, and this section is kept for the shape rather than for
the mechanism.** `stageServer` writes every mutation, whichever side of the wire it is on,
and `requireMutationDelivered` then asks the server over HTTP whether the bytes it serves
are the ones this run staged — `docs/proof-tools.md` carries that collapse in full,
including why two mechanisms delivering the same bytes was a rule with nothing measuring
it. The `shippedSource(rel)` helper written to close this therefore lost its conditional
in the same breath: `mutation.body` and the staged copy became the same bytes, so the
branch was a second path that could only ever agree, and it is one read now.

Two things survive the mechanism that produced them, and they are why this is still here.

**A source row and a behaviour row are falsified by different things**, and it is worth
asking which you have. The row that catches a page mutation by driving the page is safe
from this entirely; the row that greps the tree depends on a delivery it does not name.
When the delivery changed, only the second kind had to be re-examined.

**What holds the staging is the source rows' own controls.** Remove the write in
`stageServer` and `grid-declared-twice` stops reddening — that is the arm, and it is
already in the suite. A helper that guarantees the bytes independently of the staging
would have been the second gate again: nothing could reach one without the other covering,
so neither could be tested and one of them would be doing all the work.

Measured when the conditional came out, which is the check that it was genuinely
redundant rather than merely looking it: `--mutate grid-declared-twice` still reddens both
dimension rows naming `web/format.js web/main.js`, and `grid-declared-in-another-spelling`
still reddens its two, over a baseline of 392 assertions with none failed.

### A known intermittent in `library-check` section 9, written down with its signature

`and it is stamped in source milliseconds rather than program time` goes red now and then,
always reporting exactly `0ms against source 150ms at program 1.0s`. The row seeks the
transport to program time 1.0, awaits `settled()`, presses mark, and compares the sidecar's
`sourceMs` against `retime.sourceSecAt(1.0)`. `0ms` is not a near miss — it is the mark
being taken with the playhead still at the start, so the seek had not been applied when
`markHere` ran.

Seen five times in about eleven runs while the refusal work was going through: four of them
under back-to-back mutation sweeps, and **once in an unmutated baseline**, which is the part
worth recording, because "only ever under load" was the reading until it was not. Two
baselines run immediately afterwards on a machine with nothing else on it came back at 367
assertions, none failed. Nothing in the diff that was being measured touches the retime
curve, the transport or the mark sidecar, which is this file's own tell for flake rather
than regression - a `git diff` rather than a judgement.

It is recorded rather than diagnosed. The constant `0` and the constant `150` say the
failure is discrete rather than noisy, so whatever it is has a single shape and is worth an
hour when somebody has one: **the suspicion is that `settled()` can return before the seek
it was waiting on has been applied**, which would make every row in that section that seeks
and then reads a candidate rather than just this one.

### One regex over two constants cannot see one of them go missing

The grid row asks whether the sensor's `512x424` is declared once, and its first spelling
asked with a single `512|424` alternation. A file "holds the grid" if it matches, and
`web/format.js` matches for as long as *either* number is still written down there — so a
`DEPTH_H` that stopped being a literal, or drifted off 424 while `DEPTH_W` held, leaves the
holder list reading exactly `['web/format.js']` and the row green over a tree whose
JavaScript no longer describes the frames the grabber sends.

The duplication half was never at risk: a second file redeclaring either number lands in
the list and the row fails. It is the row's *other* half that could not fire — its own
failure message says "a grid that went missing", and it only said that when both went at
once. Two rows now, one per dimension, and `--mutate grid-loses-a-dimension` turns
`DEPTH_H = 424` into `DEPTH_H = DEPTH_W - 88`: the value is unchanged, so every page draws
the same pixels and every message is the same size, and the only thing it can move is
whether `424` is written down. Measured: 366 assertions, exactly one failed, the height
row, with the width row still green — which is the split being necessary rather than
tidy. **When a row's subject is a pair, ask for each half separately, or the half that is
still there answers for the one that is not.**

### A search for a number that searches for its digits is a search for one spelling

The third thing wrong with the same row, found by review rather than by a failure. Having
split the alternation into one regex per dimension, each was still
`(?<![\d.])512(?![\d.])` — decimal digits with guards either side to keep `512` out of
`1512` and `4.24`. That is a matcher for a *spelling* wearing the name of the number. A
module redeclaring the width as `512.0` is rejected by the trailing guard, and `0x200`,
`5.12e2`, `0b1000000000` and `5_12` are never looked at at all. Each of them is a second
declaration of the sensor's geometry sitting under a row reporting one, which is exactly
the drift the row exists to refuse.

Closed by tokenising every JavaScript numeric literal and comparing its **value**, so the
spellings stop being a list to keep up with — the boundary guards go with it, because
`1512` tokenises whole and answers 1512. The bound is stated in the code rather than left
to be discovered: this sees a literal in any notation and does not see an *expression* that
computes the value, so `256 * 2` and `DEPTH_W - 88` are invisible to it. Legacy octal
`01000` is left out because it is a SyntaxError in a module and `syntax-check` holds that.

**The control is the part worth copying.** `grid-declared-in-another-spelling` plants the
same second declaration as `grid-declared-twice` with nothing changed but the notation —
`0x200` and `4.24e2` — and both mutations are kept, because they fail differently: one is
caught by any matcher and the other only by one that compares values. Verified rather than
argued, by running both matchers over both planted lines: the old one catches
`grid-declared-twice` on both dimensions and misses `grid-declared-in-another-spelling` on
both, where the new one catches all four. A control every version of the instrument passes
is not a control for the change.

The probe tree gained the same treatment, one file per dimension per spelling plus a file
of near misses — `1512`, `4.24`, `0x201` — and the rows assert the whole matched list
rather than membership, so a matcher that grew *looser* than the regex it replaced fails
without needing a row of its own.

### A JavaScript question asked of every file in the tree gets answered by prose and CSS

The other end of the same row, and the two corrections pull in opposite directions, which is
what makes the pair worth reading together. The walk is deliberately wide — every file under
`web/` and `server/`, so a page added next year is asked by existing — and `web/` holds three
HTML pages and a stylesheet as well as the modules. Asking "is 512 a literal here" of markup
answers about layout and copy: a `width: 512px` rule in `nav.css`, or a paragraph mentioning
a 424-line budget, would have made that file a second grid owner and failed a clean suite on
a change that redeclared nothing.

Narrowing the *walk* to `.js` closes it by opening a hole, because the pages here carry real
code — `menu.html` holds `resolveResume` inline and this suite mutates it. So the walk stays
wide and the **question** narrows: the whole of a module, and the `<script>` bodies of a
page. Typed scripts are excluded by their `type` rather than by looking like data, because
`index.html` carries an importmap, and a version string in a JSON blob is not a declaration
of anything.

The probe tree carries a page stating both numbers four times over — in prose, in a
`<style>` rule, in the importmap, and finally in a module script — and a stylesheet stating
both in a rule. Exactly one of those five is a declaration, and the rows assert the whole
matched list, so either mistake fails: reading the paragraph, or no longer reading the
script.

**The general rule is that a scope has two halves and they are set separately.** What the
enumeration reaches and what the question is asked of are different decisions, and collapsing
them means every widening of one silently widens the other.

**And the same fact one layer further in: a string is not code either.** Narrowing to the
JavaScript left `throw new Error('expected 512 bytes')` counting as a declaration of the
sensor's width, so an ordinary debug message added to any module would have failed a clean
suite. Comments were already excluded, by a regex; strings were not, and the two are the
same exclusion — what the row wants is what a lexer would call a numeric token.

The pair of regexes went, replaced by one scan. They were each approximating half of a
lexer and each carrying a patch for the other's territory: the line-comment rule skipped a
`//` preceded by a colon, which exists so that a URL *in a string* survives comment
stripping. That is a lexer being written one exception at a time, and the exceptions only
stop arriving when the thing knows what a literal is.

Two decisions in it are worth copying. **Template expressions are scanned and template text
is not**, because `${...}` is code by definition and swallowing the whole template would
lose a declaration inside one silently. And **where it has to guess, it guesses toward
reporting**: a `/` after `}` is division here, so a regex in that position is scanned as
code and its digits are over-reported, which fails loudly. The other reading skips to the
next `/` and swallows the code in between, which is a declaration going unseen under a
green row. When an instrument must be wrong sometimes, choose the direction that announces
itself.

The probe carries one file that is on one list and off the other. Its 512s are all
text — two strings, an escaped quote, a comment, a template — and its 424 appears both as
text and inside a `${}`. A scan that reads strings puts it on the 512 list and fails; a
scan that swallows template expressions takes it off the 424 list and fails. One file,
both directions, which is what an arm for a scanner has to do.

**Then the scan itself needed the same treatment twice, and both were about a token being
asked of a character.** It entered its numeric branch only on a digit, so `.512e3` — 512,
in the notation with no leading digit — was invisible: a whole spelling in which a second
grid could ship under a green row. And it decided the `/` question from the previous
*character*, so `return /512/` left it looking at the `n` of `return`, called that a value,
called the slash division, and read the pattern's digits as code. A scan now takes an
identifier whole and keeps it, because the question was always about the previous token.

Two details in that are worth carrying. **A dot followed by a digit needs no
disambiguation**, since `a.512` is a SyntaxError and property access can never look like
this — the guard the first version had was protecting against a case the language does not
have. And **the kept word has to be cleared by every branch that is not an identifier**,
or a `return` left standing across the string in `return 'x' / 512` turns that division
into a regex and swallows the code to the next slash. That is the silent direction, so the
clearing is the part to get right rather than the keeping.

**A spelling is only covered where a control plants it.** The mutation for notations
planted hex and digit-leading scientific, so the row's claim to see *any* spelling was
two-thirds measured and read as whole. `grid-declared-with-a-leading-dot` is its own
mutation rather than a third number in that one, because the two fail differently and a
control that covers a case is the only thing that says the case is covered.

**And the last of them: a regex over an enumeration is a guess at it.** Deciding which
`<script>` blocks hold JavaScript, the check matched `(text|application)/(java|ecma)script`
— a shape, and a reasonable-looking one. HTML defines *sixteen* JavaScript MIME type
essences, and that pattern is four of them. A page written with `application/x-javascript`
runs in every browser and had its body discarded, so executable JavaScript was being
dropped from a row about what the JavaScript declares. Silently, which is how a missing
spelling always fails.

There is no shape behind the sixteen — `text/livescript` and `text/jscript` are there for
reasons twenty-five years old — so the enumeration *is* the definition, and the fix is to
write it down rather than to describe it. **When a set is defined by a list somebody else
maintains, copy the list; a pattern that covers today's members is a claim about the
future that nothing checks.** Parameters are stripped before the comparison, because the
spec matches the essence and because reading `text/javascript; charset=utf-8` as
JavaScript over-reports loudly where dropping it goes unseen.

The probe's second page carries executable code under a type nobody writes any more and a
JSON block under a type that is not code, so it has to be a holder of one number and not
the other: a check knowing only the modern four loses the first, and a check reading
anything inside a `<script>` gains the second. It also carries the unquoted form with an
attribute behind it — `<script type=text/javascript defer>` — because an unquoted
attribute value ends at whitespace and a capture reading it to the `>` answers
`text/javascript defer`, which is in no list of anything. Same failure as the missing MIME
types and from the same direction: a running script's body dropped.

### Nine rounds of one seam, and what that says about hand-rolling a lexer

The scan that answers "is this number written in the code" has now been corrected nine
times, and every correction was the same sentence: a question about a *token* answered
with a *character*. Leading-dot numbers, `return /re/`, postfix `++`, legacy octal,
`\btype` inside `data-type`, an unquoted attribute running past its end, a quoted `>`
ending a start tag, a finished regex divided by something, and an identifier the ASCII
classes could not finish reading. Each was real, each was silent, and each was found by
review rather than by a run.

**Three of the nine had the same *fix*, and that is the pattern worth taking away**: the
language or the spec already publishes the set, and the code had a description of it
instead. HTML's sixteen JavaScript MIME essences against `(text|application)/(java|ecma)script`;
`\p{ID_Start}`/`\p{ID_Continue}` against `[A-Za-z_$]`; and the numeric grammar's two decimal
shapes against the one that starts with a digit. In each case the enumeration *is* the
definition, and a pattern that covers today's members is a claim about the future that
nothing checks. **Reach for the published set before writing a character class that means
"names" or "types" or "numbers".**

**That is the honest cost of a hand-rolled lexer, and it is worth stating rather than
hiding behind the fixes.** The alternative was never a regex — a regex over a language is
strictly worse — it was a dependency, and this repo has no parser and adds packages under
a supply-chain gate. The scan is a hundred lines and every failure it has had is in the
loud-or-silent taxonomy already written here, so the choice is defensible. But a reader
arriving next year should know the shape: the property is easy to state, and the *scanner*
is the part that is hard, and it will keep having edges.

Two things make the cost bearable, and both are worth copying to any similar instrument:

**The failures divide into loud and silent, and the design leans one way on purpose.** A
misread that scans something which is not code over-reports and fails a clean tree, which
somebody sees. A misread that skips something which *is* code goes unseen under a green
row. Every ambiguous decision in the scan is resolved toward the first, and the one case
left genuinely ambiguous — a `/` after `}` — is documented as such.

**The probe files are the real arm, not the mutation table.** Most of these forms cannot be
planted in the tree the mutations edit: octal is a SyntaxError in a module, no page here
carries a `data-type` attribute, and a mutation of a file under `tools/` would be staged
where nothing runs. So the probe carries them, it asserts the *whole matched list* rather
than membership, and each planted file sits on one dimension's list and off the other's —
which makes both a missed form and an over-read form fail, with no row of its own for
either.

### A comment that was true when written, and false one commit later

The scan's own paragraph said legacy octal could be ignored: `01000` is 512, it is a
SyntaxError in a module, and every file walked here is a module. Both halves were true when
that was written. The second stopped being true the day the same check began reading
`<script>` bodies out of pages — an **untyped** script is a *classic* script, classic
scripts are sloppy mode, and there the form is legal and means 512. So a page could declare
the width as `01000`, the browser would agree it was 512, and the scan would record 1000
and report the grid as stated once.

Nothing announced it. The comment was not edited into being wrong; the *code around it*
grew a case its premise excluded, which is the version of documentation drift that no
amount of care while writing prevents. **When you widen what a check accepts, re-read the
exclusions it already carries — each one is a claim about the old input set.**

The fix is to read the form rather than to rewrite the sentence, since the excuse for
skipping it is gone. Only a leading zero followed by octal digits: `08` and `09` are the
legacy *decimal* forms and mean eight and nine, `0` alone is zero, and anything with a dot
or an exponent is decimal — all three fall out of the pattern rather than needing a case of
their own.

Its neighbour in the same round is the same shape one layer out. `\btype` was matching the
`type` in `data-type`, because a word boundary sits between `-` and `type` as happily as
after `<script` — so a page carrying `<script data-type="application/json">` had its body
read as JSON and dropped, while the browser, seeing no `type` attribute at all, ran it. An
attribute begins at whitespace or at the start of the attribute list, and `\b` is not that
boundary however much it looks like one.

### The grid that is declared twice on purpose, in two languages that cannot share one

Everything above is about the sensor grid being stated once. It cannot be. `native/grabber.cpp`
holds `DW`/`DH` and is C++, so it cannot import `web/format.js` — the second declaration
has to exist, and every row in `library-check` is structurally unable to see it, because
that walk is `web/` and `server/` and could not honestly be anything else.

**Two unavoidable declarations are not a drift problem solved by deleting one; they are a
drift problem solved by comparing them.** `syntax-check` already did exactly this for
`CAPTURE_FORMAT` and the grid is the same shape, so it is the same eight lines. What drift
costs is worth naming, because it is not a wrong picture: the grabber emits a depth block
of its own size, `server/capture.js` measures every frame against `DEPTH_W * DEPTH_H`, and
so every frame is refused at the parser with the sensor working perfectly — a node that
starts and serves nothing.

Anchored on the *declaration* in each language and never on a mention, which matters more
here than it did for the format constant: `grabber.cpp` also holds `char hello[512]`, a
buffer with nothing to do with the sensor, and a search for the number would find it.
Falsified by hand, since this row is in `syntax-check` and that tool carries no mutation
table: `DH` moved to 423 fails with `DEPTH_H is 424 in web/format.js and DH is 423 in
native/grabber.cpp`, and restoring it returns the run to 39 files and 0 failed.

**The general form is worth more than the instance.** When a row proves a property within
one language, ask what the same property looks like at the edge of that language — and
whether the thing on the other side is a copy that must agree, rather than a copy that
should not exist.

### An enumeration that walks a flat tree is the files that exist, not the tree

The grid row above walks `web/` and `server/` rather than a list of the files that hold the
number today, which is the close-the-class rule: a page added next year is asked by
existing. Its first spelling walked the *direct children* of each and skipped anything that
`statSync` said was a directory. Both directories are flat, so the walk found every file
there is, the row was green for the right reason, and nothing about it said that the first
subdirectory anybody made would be skipped silently — with a module inside it free to
redeclare the grid under a row still printing green.

The mistake is not the missing recursion. It is that the enumeration was **the files that
exist** while the comment above it claimed the enumeration was **the tree**, and the two are
the same list right up until they are not. A traversal cannot be falsified by the tree it
walks when that tree has nothing in it to recurse into, so the control is a tree the row
builds: `web/flat.js` with no grid and `web/nested/buried.js` with one, run through the same
walker, asserting it answers `['web/nested/buried.js']`. A walker that stops at the top
answers `[]` and the row goes red, where against the real `web/` it would answer exactly
what the row wants. **When a row's claim is about a shape the subject does not currently
have, build the shape and run the same code over it** — a mutation of the subject cannot
reach a case the subject does not contain.

### A row comparing two tables must compare the declarations, not the instances

The gallery badges each refusal the server can send, and the two lists are genuinely
separate — the sentence is the server's, the badge over a 228px poster is the page's — so a
key added to one and not the other is the failure. The row's first spelling read the
server's side by flattening the refusals the fixture takes happened to carry. That covers a
key exactly as far as some fixture provokes it, which is the reverse of the guarantee: the
next refusal will apply to a take shape `buildFixture` does not write, so it would be absent
from the derived list, absent from the page's table, and the row would compare two keys
against two keys and pass. Fixed by exporting `OPEN_REFUSALS` from `server/library.js` and
reading `Object.keys` off it, with `--mutate refusal-without-a-badge` adding a declared key
no take provokes and no page badges — a mutation the old row could not have caught, because
nothing it read would have changed. **A row asserting two enumerations agree has to reach
both enumerations; a sample of one of them is a row about the sample.**

**Its neighbour was written as the other direction and asserted the same one**, which is the
part worth keeping. The comment promised that every key in the table is one the scanner can
produce, and the code asked that every key a take arrived with is declared. Those are
opposite containments, and only the second was being checked — so a refusal added to
`OPEN_REFUSALS` and to the page's `BADGES` with the `describeTake` branch that pushes it
forgotten would stay green forever: a declared reason, a badge for it, and no take that can
ever wear either. A comment that describes a stronger check than the line under it is worse
than no comment, because it is the thing a reader checks instead of the code.

Both directions now, and `recording` is excluded from the second by a fact rather than for
convenience: no take on that server is being written, so the response cannot carry that key
however correct the scanner is, and it is proven where it can be proven — in the section that
stands a recorder up. The cost is deliberate and belongs to whoever adds the next refusal: it
now needs a fixture take that provokes it, because a reason nothing here can reach is a reason
nothing here is testing. `--mutate refusal-declared-but-never-pushed` deletes the `no-hello`
push and leaves the key declared and badged; 368 assertions, five failed, and they are one
fact arriving in five places.

### A claim about "whichever surface asks" needs a control per surface

The refusal moved to the server so that one take gets one sentence on every surface, and the
commit changed the gallery and the menu together. The control mutated only the gallery. So
reverting the menu to its old hard-coded "no sensor hello, or under two frames" — or adding
any new local derivation there — left every row green, and the claim was asserted rather
than enforced for half of what it claimed.

Adding the second control found the delivery hole underneath it. A page mutation is
delivered by intercepting its route, and `openPage` knew one page: `library.html` at
`/gallery`, with a throw for anything else. That throw is why the miss was loud rather than
silent, and it is worth keeping in that shape — the table now names `menu.html` at `/` and
still throws for a file with no URL. The glob went with it: `**${target}` for a page served
at `/` is `**/`, which matches every directory-shaped URL the page requests, so the mutated
menu would have been fulfilled for requests that are not the menu. It matches on the
pathname now. **A claim that names more than one surface is not controlled until each
surface has a mutation of its own, and the second control is usually what discovers that the
delivery only ever worked for the first.**

### A positive arm built from the interesting shape misses the ordinary one

The version-skew row above has a second arm because a gate that refused every manifest
would satisfy the refusal arm while taking the link off entirely. The first spelling of
that arm served one take, and it was the *refused* one — a take carrying a nonempty
`openRefusals`, because that is the shape the row is about. It is the wrong shape to test
a gate with. `openRefusals: []` is what an ordinary openable take sends, which is nearly
every take there is, so a gate written as `length > 0` would take the link off for every
healthy library while an arm holding only the refused take stayed green. The fixture
carries both now, and the empty-list case has a row that names it, because the two takes
fail for different reasons and a combined row would report the wrong one.

**The control for it is `--mutate refusals-must-be-nonempty`, and it is deliberately not
a well-behaved one.** It reddens both arm rows, and then it reddens the node's own rows
across the suite, because the bug it plants is exactly "every healthy node goes dark" and
that is what that looks like from here — 125 assertions, 11 failed, where a clean run
reaches 392. That is the blast-radius rule being broken knowingly rather than by accident:
several sections assume a linked node holding remote takes, and the first of them,
`drawn(undefined)`, waited out its own timeout and threw at 105. That one is guarded now,
the same way the way-back anchor is; the next is the confirm dialog for a take in state
`both`, and the ones after that are download, reclaim and delete. Guarding the class —
**every section that needs the node surviving a node that is not there** — is worth doing
and is not done. Until it is, read this control by which rows went red and not by the
assertion total, which is the rule this repo already states for every check.

### A table indexed by a string off the wire has `Object.prototype` answering for it

The version gate on `NodeLink` checks the *shape* of a node's manifest and deliberately not
its vocabulary, so that a newer node can name a refusal this build has never heard of and
have the tile badge the key as itself — visibly unmapped beating confidently wrong. That
door is the point of the design, and the page's badge table was an ordinary object literal
behind it. `BADGES['__proto__']` answers with `Object.prototype` rather than `undefined`, so
the `?.` does not short-circuit, the call throws on a value that is not a function, and the
gallery dies painting the tile — the same blank shelf the gate exists to prevent, arriving
through the one door the gate was told to leave open. `constructor`, `toString` and
`valueOf` are the quieter half: they are callable, so they badge a take `[object Object]`
under a promise that an unmapped key reads as itself.

`Object.create(null)` at the table, not a guard at the lookup, because the lookup is one
today and the property that makes it safe belongs to the table. The same reading then
applied to the instrument that checks it: the containment row asked `k in OPEN_REFUSALS`,
and `in` walks the prototype chain, so a take arriving with `toString` would have been
called a declared refusal. It is `Object.hasOwn` now. **An instrument asking `in` about keys
that came off a wire is asking a question `Object.prototype` gets to answer.**

The control drives it rather than reasoning about it: a stub node one build *ahead*, serving
a take whose refusal key is `__proto__`, with a real server pointed at it and the real page
loaded. `--mutate badges-inherit-from-object` puts the plain literal back and the row reports
`TypeError: BADGES[refusal.key] is not a function`, the page never finishing its paint. Two
rows, because surviving is not the claim — the second asks what the badge actually says, and
that arm is the one the quieter half of the fault would fail.

### Two machines on one network are two builds, and a rig that stages both cannot see it

`library-check` spawns its node and its editing machine out of one staged tree, so both
speak the build under test and every wire-format claim between them is an oracle agreeing
with itself. The failure that shape cannot show is a version skew: the editing machine gets
upgraded first, because it is the one somebody is standing at, and the node goes on serving
the manifest of the build before. That manifest parses, survives the id and hash filters,
and reconciles into the listing looking like any other take — so a field the pages now
require is simply absent, and the gallery blanks on a `TypeError` while painting the first
remote tile.

The node in that row is a stub `http` server serving a manifest written out by hand, on a
kernel-assigned port rather than one out of the reserved span, because a port `listen(0)`
hands back cannot be held by another worktree. Written out field for field rather than
generated by deleting a key from today's shape: a fixture derived from the code it is meant
to outlive follows that code. And the row has two arms, because a gate that refused every
manifest would pass the refusal arm while taking the link off entirely. **When a claim is
about two builds talking, one of them has to be a fixture — anything the rig spawns is the
build under test.**

### The branch that carried the argument against second answers, and then gave one

`OPEN_REFUSALS` exists so that `openable` is "the refusal list is empty" and never a second
expression of the same predicate, and the paragraph saying so sits directly above a
`describeTake` whose two branches did not both do it. The settled-take branch derived.
The take-being-written branch carried `openRefusals: [refusal('recording')]` and a hardcoded
`openable: false` on the next line — two answers to one question, written in by the commit
whose entire subject is that there should be one.

Nothing was wrong yet, which is the whole difficulty: both said the take cannot be opened,
so they agreed, and they would go on agreeing until one moved. What waits at the end of that
is the quiet failure rather than a loud one — `cannotOpen` quotes the list, so a list that
went while the boolean stayed leaves a *disabled* Open button explaining nothing, which
looks like a take that simply cannot be opened rather than like a bug.

**Every existing row was structurally unable to see it.** The two-table rows compare which
keys the tables know and skip `recording` by name, for a reason of fact — no take on that
server is being written, so the response cannot carry the key. The row that does watch a live
recording take asked `openable === false`, which is true in both builds. So the exclusion
that was correct in one place became the reason nothing covered the branch, which is rule 5
arriving through a justification nobody had cause to look at twice.

Two rows now. One asks every take in the listing whether `openable` is its list being empty
— a claim about the scanner rather than about the fixture, so a third branch added later is
asked by existing. The other stands where the recording take actually is and asks for the
sentence, not the boolean. `--mutate recording-decides-openable-itself` empties the list and
hardcodes the boolean together, because hardcoding alone changes nothing observable and
would have been a control that did nothing: 1 failed assertion of 392, the row that carries
the claim and no other.

### Splitting a list gave the lookups a right answer and the sweeps a short one

The tail of the port-collision fix below, and the reason it is its own entry is that the
fix was correct and still broke something. Moving a reclaimed offset's previous holder to
a `retired` list is what makes `servers.find((s) => s.port === n)` answer with whoever is
on the port. It also silently changed what `servers` *means*: it stopped being every
server this run started, and the end-of-run fatal-log sweep had been reading it on the
old meaning.

Measured when the row went in: **four** servers are retired on a full run, so four
servers' logs were outside the scan. A `cannot open` from any of them would have been a
failure this tool detected and did not say, which is the worst shape a proof tool has —
worse than not looking, because the verdict claims it looked.

**The lesson is about the readers rather than the list.** Every consumer of a collection
is either a *lookup*, which wants the one that is current, or a *sweep*, which wants all
of them — and splitting a collection to fix a lookup gives every sweep a new bug at the
same moment. The fix is a named `everyServer()` used by both sweeps, rather than
`[...servers, ...retired]` spelled at each site, because there were two sites and the bug
was one of them being forgotten.

The row checks the *count* against a counter incremented where a server is started, not
the collection the loop reads. What went wrong was never this loop naming the wrong
variable; it was a list splitting somewhere else and one of its two readers not being
told, so the row has to be red for that, including for the next collection somebody adds.

**It has no `--mutate` entry, and that limit is worth knowing before you write a row about
the instrument.** A mutation spec writes its body into the staged tree, and the stage is
`server/` and `web/` — a mutation naming a file under `tools/` would be delivered to a
copy nothing runs and would be recorded as a control that passed, which is the
silent-delivery failure this file already carries two entries about. So it was
mutation-tested by hand: `everyServer()` put back to `servers` reddens that row and
nothing else, reporting `swept 18 of 22 started` against a clean `22 of 22`.

### Two sections on one port, and the one that read a log read the wrong one

The sibling of the `MAC_PORT + 9` case above, with this file on both ends of it instead of
another worktree. `library-check` keeps its spawned servers in one `servers` array and
finds them by port — `servers.find((s) => s.port === MAC_PORT + 1).log.join('')` is how a
section reads what its server printed. Two sections claimed `+1`. The first killed its
server long before the second started, so the bind succeeded and nothing failed; what was
left was two entries for one port, and `find` answers with whichever was pushed first,
which is the dead one.

The respawn-backoff section therefore counted grabber exits in an empty log and reported
`0 exits`, three rows red, against a supervisor that was working correctly — and the log
it should have read carried twenty-two deaths, which the corroborating row beside it
printed in full. **The reading was wrong rather than the code**, which is the worst way for
a proof tool to be wrong: it is a finding about the instrument wearing the shape of a
finding about the program, and the merge that surfaced it looked exactly like a
regression. What settled it was a control run of the same tool on `main`, on a port span
nothing else held: 365 assertions, none failed, against 390 with 3 failed here, with the
three sections' code byte-identical between the two trees.

Fixed by dropping the stale entry when an offset is claimed again, so a lookup by port
answers with the server that is on it. Not by refusing the reuse and not by widening the
span: reuse is deliberate — `+14` is a rename server and later a broken-preset one — and
two more ports is a cost every worktree on the machine pays to route around a bug in the
bookkeeping. Two *live* servers on one port is a case the kernel already rules out, so
reaching the claim at all means the last holder let go.

**The general shape is rule 4 read backwards.** A probe placed where its answer would be
different is no good if something else can answer for it, and an array searched by a key
two things share is exactly that. `find` on a non-unique key is a silent choice.

### A mutation that removes a precondition reddens the rows built on it, and that is the mutation working

The rule above says to report which rows fired, and the rule two sections down says the next
agent re-derives that set from scratch rather than trusting a docstring. Put together they make
an undocumented extra red row read as a second defect to investigate — so a `Must redden` line
that undercounts costs somebody a hunt for a bug that is not there.

The shape that produces the undercount is always the same. A section builds a fixture with one
gesture and then asserts several things about it; a mutation that destroys the *gesture*
destroys the fixture, and every row standing on it goes red for a reason that is about the
fixture rather than about that row's own claim. `editor-check`'s preset section has three
mutations of exactly this shape and only one of them said so: `picker-ignores-the-boxes` was
documented at two rows and fires three, `readings-tick-alone` at one and fires three, while
`detail-ignores-the-reading` carried the sentence "three more go with it and they are the
fixture rather than the claim" from the day it was written. Nothing was wrong with any of the
three mutations. Two docstrings were wrong about them.

So a `Must redden` line has two parts and needs both: **the rows carrying the claim, and the
rows that redden because the mutation took their fixture away.** Naming the first without the
second is not brevity, because the reader's job is to check the set they got against the set
they were promised, and a promise that is a subset fails that check every time it is kept.

The tell that a red row is a cascade rather than a finding is that it asserts about a state the
section had to *establish* — a partial document, a live reading, a value planted off its
default — and the mutation is what establishes it. Where the two cannot be told apart by
reading, the discriminator is the same one this document keeps returning to: read the detail
line, which prints the quantity, and ask whether it moved in the direction the mutation moves it
or simply went absent.

### A mutation that does nothing reads as a check that found nothing

Step 5 produced one: a mutation meant to draw editor furniture into the rendered frame
reached for `gl.scissor` and `gl.clear` directly, which three's own state cache overrode, so
the pixels never changed and the check reported a clean pass. Rewritten through
`renderer.setScissor` it fails at `max 189/255`. **Before believing a mutation was missed,
confirm the mutation did something** - have it move a number the check already prints, or the
verdict is about the mutation rather than about the check.

### Before believing a mutation was *caught*, confirm it was caught for the reason claimed

This is the converse of the rule above and it is worse, because it reads as coverage. Step 7
built a plant for the route sweep - a read route that writes a document and puts it back
inside the same request, which a before-and-after comparison of the contents cannot see by
construction, since both readings are taken outside the request. It failed two rows, and one
of them was the contents comparison it was written to walk past. The reason had nothing to do
with the property under test: APFS keeps modification times to the nanosecond, `utimesSync`
takes a `Date` carrying milliseconds, and the 0.13ms the restore could not put back is what
failed the row - `1785523816453.8726` against `1785523816454`. On a filesystem with coarser
stamps the identical plant walks straight through, so the control was asserting the platform
rather than the design, while looking exactly like a control that works.

**This was found by measuring, not by reading** - the mutation was run and the two snapshots
diffed field by field, which is the only thing that distinguishes a row that went red for its
own reason from one that went red for a neighbouring one. The fix was to rebuild the plant so
nothing about it depends on the filesystem: write-then-remove touches nothing that survives,
leaves the listing identical, and moves only the monotonic write count. It now fails that one
row and leaves the contents row passing, which is what makes the count load-bearing rather
than a second way of saying the same thing.

### A mutation run that exits non-zero with zero failed assertions did not run

Every tool that carries mutations refuses one whose anchor text it cannot find, and
Playwright occasionally dies with `Execution context was destroyed` partway through a run -
and all three outcomes exit 1, which reads as a caught mutation to anything checking only the
exit code. Seen twice on step 5, on two different mutations in two different suite runs.
**Count failed assertions, not exit codes**, and treat `fails=0` as a crash to investigate
rather than a success to record.

### And `fails=1` can be the same crash wearing the count

Counting assertions is not enough on its own if the harness's own failure is one of the
things it counts. `monitor-check` caught its `catch` in `failed++`, so
`expand-shifts-by-a-block` on a machine busy with an unrelated export timed out waiting for
the take, fired exactly one assertion — that timeout — and printed `caught, as required
(1 assertion fired)`. Nothing about sample placement had been tested. Run again on a settled
machine it fires eight, all of them the intended row. So a throw is now `crashed` rather than
`failed`, and the verdict is `DID NOT RUN` with exit **2**, checked before the mutation
verdict and before `untested`. **Read which assertions fired, not how many** — and a proof
tool must never count its own crash as a finding in either direction.

### Reverting a probe with `git checkout --` deletes the thing under test when it is uncommitted

Found while mutation-testing the `.knct` specification row in `syntax-check`. The row was new
and so was the specification it reads, both of them uncommitted, and each probe ended in
`git checkout -- server/protocol.js` to undo the damage. That restores the file to `HEAD`, which
in this state means restoring the version with no specification in it at all. So the first probe
was valid, the revert silently removed the feature, and the two probes after it ran against a
file that no longer had anything to check — both went red, both for the wrong reason, and both
would have been recorded as catches by anybody reading only the count. One of them additionally
reported `Identifier 'MAGIC' has already been declared`, which is the shape of a probe whose
own edit is malformed rather than a finding, and is the tell that should stop the run.

`git stash` is already forbidden here for a different reason, and the same replacement covers
this one: **copy the file outside the repository, probe, and restore from the copy**, then
`diff` the restore against it and re-run the clean arm to confirm it is green again. The rule
in `CLAUDE.md` about taking a baseline is written for a measurement, and it applies unchanged to
mutating an instrument you have not committed yet. The cheaper version of the same protection is
to commit the instrument before probing it, so that a revert has something to revert to.

### A mutation is source text, and nothing was checking that the text still existed

Three declared controls could not run at all, and had not been able to for a long time.
`editor-check --mutate space-unbound` anchored on `if (timeline.playing) timeline.pause();`
where the branch now reads `pauseTransport()` — renamed in `51c7c9d`, sixty commits before
this was found. `keyframe-check --mutate undo-on-input` anchored on a listener whose local
was renamed `el` to `input`; one word killed the control that proves a slider drag is one
undo step rather than two hundred. `library-check --mutate marks-ignore-retime` anchored on
the line converting a mark through the retime curve, which had been *copied* to the minimap,
so it matched twice and the tool refused it.

**The two shapes of refusal disagree, and the disagreement runs the dangerous way.**
`editor-check` resolves its mutation inside a `try` and reports `DID NOT RUN` with exit 2,
which is the honest answer. `keyframe-check` and `library-check` call `mutatedSource` at
module top level with nothing catching it, so a run prints a stack trace and exits 1 with no
`FAIL` row, no assertion count and no verdict line — which is indistinguishable from a caught
mutation to anything reading exit codes, and `keyframe-check`'s throw happens after
`chromium.launch`, so it leaves a browser behind as well.

**Neither is the real lesson.** `timeline.pause()` had not vanished from the tree; it moved
off the line the mutation cared about, and still exists elsewhere in `web/main.js`. Nothing
casual would have spotted any of the three. The class is that every anchor in this suite is
one rename away from the same silence, and the only thing that would have noticed was
`sweep-all`, which needs a server, a browser and hours — the right verdict at the wrong
latency, since it is what a merge waits on rather than what tells you your control is dead
while you are leaning on it.

**This had already happened once and was closed as an instance.** The comment above
`undo-includes-view` in `tools/keyframe-check.mjs` records a previous re-anchoring in these
words: the line it named moved, "so the old text matched nothing and the tool refused the
mutation - correctly, and silently as far as anything reading only the exit code was
concerned." That instance was fixed and the class was left open, and three more went stale
behind it.

So `syntax-check` now walks every tool's `MUTATIONS` table and asserts each anchor matches
its target file **exactly once**. It costs nothing, needs no server and runs in CI. The table
is read without executing the tool, by cutting the source at the end of the declaration,
appending an export and importing that prefix from inside `tools/` so the tool's own relative
imports still resolve; a prefix that does not import fails the row rather than being read as
"this tool has no table". Targets resolve by the entry's *shape*, never by the tool's name,
and an unrecognised seventh shape fails naming the tool instead of being skipped. Measured at
`907b87f`: 239 anchors across 13 tables, of 15 declared.

**A duplicate is as stale as a miss, and that is the half a naive row drops.** The real defect
here was `marks-ignore-retime` matching *two* sites, so a row asking "does this text appear"
rather than "exactly once" sails straight past the thing that prompted the work while looking
thorough. Both controls exist for that reason: `anchor-matches-twice` duplicates an anchored
line into its target file, and `anchor-goes-stale` changes one character inside a `from`
string. Each must redden the anchor row **and nothing else** — a control that reddens the
whole tool says nothing about which question the tool was asking.

**One thing this does not close.** `library-check`'s `reveal-drops-the-path` resolves its edit
through `process.platform`, so a macOS developer and a Linux CI run check different strings
and neither checks the third. And the minimap's copy of the mark conversion still has no
control over it at all: `markTicks()` only ever reads the ruler strip, so that second site
could stop going through the retime curve entirely and every row in the suite would stay
green. Two sites doing one conversion is what made this anchor stale in the first place.

**And reading a table by importing the tool's prefix made this row need what the tool needs,
which CI found and a developer's machine cannot.** The cut ran from the top of the file so that a
table referencing a const beside it would still resolve, and it dragged two things with it: the
tool's own `import ... from 'ws'`, which CI has not installed because this tool is documented as
needing nothing at all, and the tool's top-level *work* - `export-check` and `registry-check` both
resolve a commit with `git log -S` while their module body runs, so reading their tables walked the
whole history of `web/main.js` and threw outright in a tree extracted without its `.git`. Four
tables went unread on CI, at 137 anchors against 248 here.

The row was loud about it, four FAIL lines and the fallen count, which is why the count is in the
summary line at all - but the summary still read `all 137 ... match once`, true of what it read and
indistinguishable from a clean row. **A count is only honest beside what it could not count**, so
an unread table is now named in that same sentence. The cut itself is the declaration alone, which
reads fifteen of the sixteen with no imports and no side effects at all, falling back to the
package-stripped prefix for the one table that references a neighbouring const. Verified where it
failed: a tree extracted with neither `node_modules` nor `.git` reads all 248 in 14 tables, in 5.7s
against minutes.

**And the shape inference was wrong within days, which is the argument for normalising rather
than for a better guess.** A bare `{ from, to }` had a single declarer, `registry-check`, which
edits the browser bundle - so the resolver read the shape as meaning `web/main.js`. Then
`syntax-check` grew a `spec-drifts` control of its own in the same shape against
`server/protocol.js`, and the row went looking for `export const TYPE_COLOR = 3;` in the bundle,
found nothing, and reported a control that works perfectly as an anchor that had gone stale. The
merge that brought the two together is what surfaced it, and it is a false positive rather than a
missed defect, so it is the cheap direction of the same mistake. The fix is `spec-drifts` moving
to `{ file, edits }` and declaring its own target, not the resolver learning a second tool's
name: a resolver that knows which tool is asking is the hardcoded list this row exists to
replace.

### A mutation can erase its own evidence

`plant-open-take` originally appended its foreign bytes through a second file descriptor.
After the recorder moved onto `createWriteStream`, that descriptor and the recorder's
descriptor had independent offsets: the append extended the file, then the next real frame
wrote from the recorder's older offset and overwrote all 64KB before the take closed. The
mutated build passed 256 assertions because it no longer contained the damage the control
claimed to plant. The control now writes through the recorder's own stream, between two real
frames, so the foreign bytes survive to the scan. When a mutation is unexpectedly green,
inspect the mutated artifact before weakening the assertion; the code change may have undone
itself rather than escaped the observation.

**And a run that stopped two thirds of the way through is the same lie told quietly.** One
sweep of nine mutations against the gallery had five runs end at 95, 117, 140 and twice 198 of
317 assertions, every one of them non-zero, every one with the mutation's own rows already
correctly red — so read line by line each looked like a catch, and read as a whole a third of
the suite's claims had not been measured against that build at all. Three causes, and none of
them was the code under test. `retryOnContextLoss` named `Execution context was destroyed` when
Playwright says `Resulting promise was garbage collected` for the same renderer going away
under an outstanding async `evaluate`; a mutation that deletes a control left `page.click` on
that control timing out for thirty seconds and then throwing; and a probe that renames a take
was pointed at the take five later rows assert about, so one red row became five and then an
undefined. **A mutation must redden the rows carrying its claim and leave the run able to
finish** — give a probe that might succeed its own fixture, guard any drive of a control the
mutation can remove, and print the assertion total beside the failure count so a run that
ended early is visible rather than implied.

**A race probe driven through the HTTP route measured the route's own latency and reported
the rule holding.** `renameTake` checked its target with `stat` and then acted on it, and
`rename(2)` replaces an existing file without a word — so two requests aiming at one name
both pass the reading and the second destroys a take. Four simultaneous POSTs against a build
with that hole came back one winner and three refusals, every loser intact, twice: each
request scans the whole captures directory before it reaches the rename, dozens of awaits of
differing durations, and that is enough that the requests are never inside the window
together. The identical four calls made straight at the function — where the only thing
between the reading and the act is three `stat`s — clobber immediately: **four fulfilled, no
rejections, one file left where four takes were.** So the row is a direct call into the
staged module, not a fetch. **When a probe is about an interval of a few microtasks, every
await between the caller and it is a widening of the thing being measured**, and a green row
means the harness could not get close rather than that the interval is closed. The fix under
it is `link(2)` then `unlink`, which fails EEXIST atomically, with the `stat` kept only for
the sentence it produces.

**Two gates that agree cannot be tested apart, and one of them will be doing all the work.**
The rename route refused the take being recorded and so did `renameTake` underneath it, in
identical words. `library-check` ran all 317 assertions against a build with the route's guard
deleted and reported the refusal working — 317 assertions, none failed, NOT CAUGHT — because
the second guard refused instead. This is not defence in depth; it is a rule with nothing
measuring it, since no mutation can reach one gate without the other covering. The duplicate
is gone and the check is aimed at the one that decides. **Before writing a second check of the
same condition, ask which mutation would tell the two apart** — if the answer is none, there
is one gate and a comment saying where it lives.

**A mutation that zeroes a quantity has not moved it.** `poster-height-in-js` was meant to
restore the shipped bug where a poster's height was assigned once from a measured width and
went stale on resize. Written without a `width > 0` guard it froze at the first fit, before
the grid had laid the tile out, so every poster came back zero-height: the aspect rows failed
with `Infinity`, the decimation row failed because a canvas of no pixels has no picture to be
sparser than, and the viewer never drew, which ended the run. Rows saying "something broke"
where the claim is about *which* quantity moved. This is the converse of the mutation that
does nothing already recorded above, and it fails the same test — confirm the mutation moved
the number the check prints, in the direction the bug moved it.

**Check the ports before a measurement run, not the results afterwards.** An earlier attempt
at the same sweep had eight of nine runs die in section 1 with an `ENOENT` on a
download-collision filename. A server leaked from a crashed run still held 8210 and 8211, so
`startServer` connected to *that* rather than to the one it had just spawned, and every run
was measuring a stale process against a fixture directory it was rebuilding underneath it.
Eight runs, one failed assertion each, all of them the harness crashing — which is `fails=1`
wearing a crash again, at sweep scale. The sweep resolves listeners by port and kills them
before each run now, and prints when it did.

### A mutation whose only effect is that the page refuses to boot is not a usable mutation

Step 2 replaced a boot invariant that had become a tautology — it looked a panel control up by
id and threw when there was none, which stops being able to fail once the same pass creates the
control it then looks for — with a count assertion: rows emitted against parameters declared.
That refusal is right for whoever is looking at a blank panel and useless as evidence, because
a page that throws during module evaluation publishes nothing, every tool reports DID NOT RUN,
and an exit code with no assertions behind it is the thing this repo twice records being
written down as a bug found.

So `panel-row-skips-parameter` skips a parameter **and moves the build's own tripwire out of
the way in the same breath**, which is the sharper question anyway: if the generator filtered
wrongly and the build's own count agreed with it, would anything notice? It has to be answered
by a count the *tool* recomputes from the registry — `editor-check` section 1 diffs
`params.names()` against the ids its sweep found, and fails naming the parameter. Reading a
count the page reports would be the mutation editing its way past the check. The one-edit form
was measured separately and by hand: it refuses to boot with `emitted 53 rows for 54
parameters` and never publishes `__kinect`.

## Where a probe stands

### A cumulative table hides which term is wrong

Step 6 measured the look at two output sizes down one pipeline - points, then trails, then
"grade" - and reverting any single grade term moved that row by less than the row's own
sampling residual, so three mutations passed. One row per term fixed it: `rgbsplit-absolute`
now fails the rgbsplit row and leaves the grain and scanline rows alone, which is a check
saying *what* broke rather than *that* something did.

### Three of step 6's probes were standing in dead zones

Each for its own reason, and each was found by mutation rather than by reading. The additive
normalisation is clamped to 1 beyond 0.83m, so at the default framing a mutation of it
changed nothing at all - the probe needed a camera inside the cloud. Grain at the preset's
0.22 is about one part in 255, so reverting its reference grid moved every number by 4% - the
probe needed the slider at full. And an export at the editor's own buffer size cannot tell an
output size that reached the renderer from one that did not - that probe needed a size the
editor is not.

### A fourth dead zone, and this one was written into a design decision as a fact

Step 3 of the effects rework added `rgbSaturation`, and the spec said a probe for the
colourless-take path would stand in a dead zone because `captures/sample.knct` carries real
JPEGs, so `hasColor == 1` in every arm of every tool. The first half is right and the second is
false of the one tool that matters here: `registry-check` builds its own fixture with the
colour block dropped, because a JPEG decode is asynchronous and a pinned run that raced it
would hash a frame whose colour had or had not landed — and `drive.pin` therefore sets
`hasColor = 0` itself. Every point in every arm draws a flat `vec3(0.7)`, and **saturation of a
uniform grey is the identity at every value**, so the drop-one sweep would have recorded a new
look parameter as one that cannot touch a pixel.

The answer was to move the probe rather than to write the name into `NO_PIXEL_EFFECT`:
`drive.plantColor` takes four saturated pixels from the check, and the arm asserts `hasColor`
came back 1, because a plant that silently failed leaves the grey behind and the sweep then
reports a dead zone as a measurement. **A tool's own synthetic fixture is not the take the
program ships with, and a claim about "every arm" has to be read off the arms.**

### Two bounds on one number means a probe has to be placed where the one under test is the binding one

The splitter's clamp keeps the stage a third of the window, and `--tlanes-h` is
`min(stacked, min(asked, ceiling))` - two limits on the same value. The arm stacked eight
lanes at 280px against a 415px ceiling, so the height was decided by the *content* and the row
asserting the clamp passed with the clamp deleted: `splitter-unclamped` came back NOT CAUGHT
with every row green. Fourteen lanes stack 443px, the ceiling binds, and the same mutation
drags the stage to 31.9% and reddens that one row. This is the dead-zone rule with the two
terms in a `min` rather than in a sum, and the tell was in the row's own detail line - it
printed a strip height that was neither the ceiling nor anywhere near it.

### Place a probe where its answer would be different, not where it is convenient

A third flaw came out of this on step 5: a mutation replacing the pre-roll's window query
with the tangent it replaced was caught by only one of five probe positions, because four of
them sat inside a single straight segment of the retime curve where the tangent *is* the
curve. The probes were moved onto the knees and onto an eased ramp and the same mutation now
fails four. Ask what the wrong implementation would agree with, and probe somewhere it
cannot.

### A probe can be in the right place and still start one link past the break

`level-check` section 5 graded floor selection on a frame with two different planes planted
in it, pressed each side, and checked the two rotations differed — which is the probe placed
exactly where its answer is different, and it was still blind to half of what it was named
for. Every one of those arms called `levelAtStagePoint` directly and passed its own
coordinate, so all of them began *after* the step that turns a press into a coordinate. The
sole gesture through the real control pressed the exact centre of a frame carrying one plane,
and a frame of one plane answers the same whatever point reaches it. So a `pointerdown`
handler that computed `view` and then handed the middle of the frame to a correct hook passed
the whole section: measured, on the shipped tool, at 33 assertions and 0 failed.

The existing `level-selection-ignores-point` did not cover it either, and the reason is worth
keeping. That mutation discards the coordinate *inside* the hook, one link below where the
arms attach, so they see it; the handler sits one link above them, where nothing was looking.
**A hook exposed for testing is a seam, and a seam has two sides — arms that all attach on
the same side of it measure one of them.** The fix drove the split plant through `#camLevel`
and `#stage` at 0.35 and 0.65 of the stage's own width, graded which plane each press landed,
and added `pointer-levels-the-centre` as the control: it now reddens 2 of 36 and the run still
finishes, the left press writing the right plane's `32/45` because the seam between the two
planted planes falls on the right half.

One row of that set passes under the mutation and is kept anyway. The *right*-side press is
answered correctly by a centre-passing build, since the centre lands on that plane by
construction — so the left-side row and the two-presses-differ row are what carry the claim,
and the right-side row exists to say the gesture works on both ends rather than to catch
anything. **Ask of a control set which member would still be green under the mutation, and do
not mistake it for redundancy: it is measuring a different thing.**

Written in the past tense on purpose: floor selection was removed on 2026-08-08, and with it
`levelAtStagePoint`, both mutations named above, and the split plant. Nothing in this section
can be re-run. It is kept because the lesson is about seams and not about levelling — the same
shape is live wherever a proof tool reaches a hook the shipped surface reaches through a
handler, and `editor-check`'s driver map exists to make that reach visible.

### `nav-at-the-foot` stood in a dead zone and then moved the page it measured

Both flaws at once, in one probe, and both were found by running the mutation and reading
which rows fired rather than by reading the probe. It is the control for section 1's second
claim in `editor-check`, that the way out of the editor is *reachable* rather than merely
present — it was under thirteen groups of sliders at the end of a column that scrolls, which
is being in the document and nowhere on the screen.

**The dead zone**: the first version scrolled the column to its end and asked whether the nav
was inside the panel, and the end of the travel is precisely where a nav at the foot *is*
visible — the mutation came back 683px down and comfortably in view, reddening only the
structural half of the row. The end a foot-nav fails is the top, where the panel sits when you
arrive, so both ends are read now and the mutated build answers 1958px.

**The observer effect**: the probe is the one thing in section 1 that moves the page it
measures, and leaving the column scrolled put section 8's crop sliders under different pointer
coordinates — the crop rows went from 0.005% apart to 0.446% and read as a rendering regression
the change had caused. It restores the scroll position now.

**And the mutation's own anchor moved when the panel started generating its grade**, which is
the ordinary half of the story and worth recording beside the two flaws because it is the half
that recurs. The second edit used to re-insert the nav after the Viewer lookgroup's closing
tag, and there is no static lookgroup left to close — the panel's whole grade is built from the
registry at boot now. It anchors on the end of `#panelBody` instead, which is the position that
survives that change and is still the foot the bug had: the generated groups are placed against
`#extendedRow` and walk down from there, so a nav written in last stays under every slider. The
mutation was re-run rather than reasoned about and reddens both geometric rows, reporting `in
the scrolling body: true` — which is what says it failed for its own reason rather than a
neighbouring one.

### A persistence row that went red because it had found the bug, and was re-polarised instead

**This entry previously drew the opposite conclusion and was wrong. It is kept with the
correction on it rather than replaced, because the wrong reading is the one that recurs.**

`editor-check` 13i asks whether a collapsed panel group survives a reload. It shut `Reading ·
detail` while a reading was live, reloaded, put the reading back, and read the group. It went
red the round the override's prune moved into `refreshGroups`, reporting `shut=false, 7 of 7
rows on screen`, as the only red row in the run.

The reading taken at the time was that the row had become ambiguous. On a document at its
defaults the group derives shut; the page boots *before* the reading goes back; so at the
instant the store is read the stored `false` and the derived `false` agree, and an entry that
agrees is indistinguishable from one that was forgotten. Every sentence of that is true, and
the conclusion drawn from it — reverse the polarity to a group pinned *open* on a quiet
document, which is a disagreement nothing can prune — does not follow, because **the row does
not read its answer at that instant.** It puts the value back afterwards, and with the value
back the two builds part company: the entry kept renders the group shut, the entry pruned
renders it open. The row was discriminating, it was red, and the thing it had found was a real
defect in the code the same change had just written — the prune comparing two terms for
equality on the boot pass, where the derivation is not a statement about the document but about
there not being one yet. Collapsing a group that was in use never survived a reload. Pinning
one open always did, so re-polarising the row onto the pin moved it onto the one direction the
defect cannot reach, and the suite went green over a shipped bug for a second round.

Three things to carry, in the order they bite.

**A row that goes red on a build you have just changed is evidence about the change first.**
This is the same failure the review found in `library-check`'s route sweep and it has now cost
two rounds here: the instrument was adjusted to accommodate the code rather than the code
fixed, and the adjustment came with a written justification, which is what stopped anybody
looking twice. Before re-polarising, re-weakening or re-siting a red row, work out what the
build would have to be doing for it to be red, and check whether that is happening.

**The general form is still sound; the answer to it was wrong.** *Ask what the page would do
with the entry missing, and if the answer is the same thing, the row is not about the entry* —
ask it of the moment the row **reads**, not of the moment the page boots. A fixture rebuilt
after the reload is not automatically a tell that the row is reaching: here it is the step that
creates the difference, because the stored opinion only becomes visible once the document
disagrees with it again.

**Both polarities are worth a row and they are not the same claim.** The pin proves an override
survives a reload at all; the collapse proves nothing pruned it against a document that had not
loaded yet. 13i drives both across one reload now, and its strongest row is neither of those —
it reads `kinect.panelGroupsOpen` straight back after the reload and before anything touches
the panel, which is the defect at its own scale rather than through its consequence.
`prune-ignores-movement` is the control, restoring the equality comparison and reddening those
two rows and no others.

### A probe that changes the state it samples proves whatever it did to it

This is a distinct failure from the two above - not a probe in a dead zone and not a vacuous
assertion, but an observer effect inside the instrument, and it is easy to write because the
sampling call looks passive. Step 7's recorder check waited for takes by polling the library,
then asserted each closed take held all the frames its writer emitted. Listing the library
scans every capture in the directory *including the one still being written*, and the scan
writes a sidecar - so "does a sidecar exist" stopped meaning "the take is finished" the moment
something asked the question, and the take that was mid-recording was counted against a total
it was never going to reach. It came in at 10 frames and at 11 on two runs, which is the burst
plus however long the last poll took, and it fired on four unrelated mutations before it was
pinned - a check red for reasons that have nothing to do with what is under test, which is how
a gating check teaches people to re-run until green. The fix was to take "closed" from the
writer's own log rather than from an artifact the reader creates. **Before polling for a
condition, ask what the polling call itself writes, opens or caches** - anything that lists,
scans or indexes a directory something else is writing is a candidate.

### A fix can be a probe with an observer effect, and the same rule catches it

The section above is about an instrument that disturbs what it samples. The same failure has
a second home nobody looks for it in — **a fix placed at a door, where the disturbance is the
fix**. `resize()` reallocates the drawing buffer and never drew into it, so a parked editor's
stage went black on every path that resized it, and the fix is a `requestRepaint()` on
`resize()`'s last line: at the door rather than at the seven callers, which is this repo's own
rule about closing the class.

It was still wrong as first written, and by exactly the mechanism above. **Most calls to
`resize()` do not resize anything.** `rebuildLanes` runs it on every lane rebuild, so every
rate change reaches it through `timingChanged` -> `lanesChanged` with the strip the height it
already was — and asking for a repaint there is a second accurate seek on top of the one the
gesture's own release issues. Measured: 2 seeks for one held arrow key against 1, which is the
seek storm the speed control was rewritten to avoid, arriving through a door opened for
something else. It cost the take as well, three runs out of three, because the release resumes
playback behind its seek and the repaint's seek put the playhead back on the frame the resume
had just left.

Two things are worth keeping from how it was found. The row that caught it was **not** either
of the new rows written for the fix — it was section 4's existing play-intent row, which went
red in a `--no-render` run and green in the full one, and read exactly like a flake. What
settled it was the row *above* it printing a number rather than a verdict: `2 seeks for 6
repeats` against HEAD's `1`. **A row that reports a count beside its pass is what lets the
neighbouring boolean be diagnosed instead of re-run.**

And the guard that fixed it rests on a fact about a browser rather than about this build — a
same-size `setSize` reallocates nothing, so a conditional repaint is safe. That is the shape of
premise that quietly stops being true, so it is asserted rather than trusted: `editor-check`
section 13 fires a `resize` event with the window unchanged and requires the picture to still
be there. Measured, 158,247 lit pixels before and exactly 158,247 after, against 0 across a
resize that moved the buffer 1298x730 -> 1084x610. **When a fix is conditional on a platform
behaviour, the condition is a claim and needs its own row.**

**A fixture that has never held the shape under test cannot measure it, and the gallery's
tile heights are the plainest case of that yet.** Every take in `library-check`'s fixture
carried at most one warning — truncated, or no hello, or under two frames — so a
uniform-height assertion measured across all of them would have agreed on a build where each
warning still added a row: one row against one row is the same height. The shape that
differed was the take that fires several, and it did not exist until it was written.
Measured on a fixture that has one: 41.19px of spread at every viewport width before, 0.00px
after. That same take, cut before its first whole frame, then surfaced a defect nothing else
had: a take whose scan indexes no frames still asked the server for frame 0 and got a 404,
swallowed by the skim's own catch and visible only as a failed request in the console.
**Before asserting that a set of things agree, check the fixture contains the one that would
not.**

**A quantity assigned once in JavaScript from a measured box is right at first paint and
wrong afterwards, and a check that never resizes cannot see it.** The gallery's poster height
came from `canvas.parentElement.clientWidth` at the first draw, so a window dragged from 1512
to 700 left a 332px-wide tile with a 133px poster — 2.496:1 against the 16:9 it draws.
Measured, not read off the CSS: the rule that produced it also looked like it should hold.
The box is one `aspect-ratio` declaration now with the canvas taken out of flow, its backing
store follows through a `ResizeObserver`, and the geometry rows measure at two widths with a
resize between them because the two ways a tile changed size showed up under different
conditions — the warnings at every width, the poster only after something resized.

**Arithmetic about where a thing should go is not a measurement of where it went, and a
proof tool can hold the second where it cannot hold the first.** The gallery's ⋯ menu picks
its side from the room above and below the button inside the scrolling grid, and the tile in
the top row had its first item clipped away — the tallest menu, on the take whose three
warnings most needed reading. Fixing the branch was not enough: a tile in a row below the
fold has a button the grid is not showing at all, so "the room above it" is a number about a
position nothing can see and the menu lands wholly outside, which came back as six pixels of
a 98px menu on the one fixture tile whose menu carries no warnings under it — the shortest
menu there is, and therefore the one whose overflow a height cap cannot explain. The box is
measured after placement and shifted by whatever is left over now, and the row asserts
`inside` rather than asserting the reasoning. **Every assertion about what a menu offers
passes on a menu nobody can see**, because the items are in the document either way.

**A thing that draws one pixel per sample is dense at one size and threadbare at another.**
The gallery's viewer is the same projection as its tile at four times the area, and the
scale follows the height — so the gap between neighbouring depth samples on screen follows
it too, and a take that reads solid on its 228px tile came up a faint dot screen. The
spacing is exactly `scale / fx` pixels and not a proxy for it, because the depth cancels out
of the unprojection, so the sample size is derived rather than tuned. Taken from the
sensor's own focal length and never the decimated one: dividing by the divisor as well would
give a coarse remote frame four-times-larger samples and make it look identical to a local
one, erasing a signal the gallery carries on purpose. Measured: local 76.4 against remote
22.8, so a decimated skim is still visibly what it is, and the **tile's own poster is
bit-identical** to what it always drew — same mean, same signature — because the size floors
at one where the tile already covers.

**And the row that proves it was NOT CAUGHT for a round, because its threshold came from the
wrong conditions.** The ratio gate was set at 0.25 from a measurement taken at
devicePixelRatio 2, where the broken build gives 0.07 — and `library-check` runs at 1, where
the same build gives 0.28. One hundredth of a margin, and the mutation ran the full suite
reporting nothing wrong while doing exactly what it claimed. This is the fps-floor paragraph
above arriving in a different instrument: **calibrate a gate at the viewport, the pixel ratio
and the fixture the check actually runs with**, and record the broken build's value beside
the threshold so the margin is visible rather than implied.

**`el.id ?? fallback` never reaches the fallback.** The DOM answers an absent id, dataset key
or attribute with `''` rather than with undefined, so `??` keeps the empty string and `||` is
the operator that means what was intended. In the gallery's control enumeration this gave
every tab the key `''`: the sweep reported four controls it could not name and four drivers
naming nothing, both rows red, neither of them about the page. It looks exactly like a real
enumeration failure.

### A row that provokes a refusal writes into a channel a later row sweeps

The third variant of the two sections above, and the one that arrives by post rather than in
person: the probe does not disturb what *it* samples, it disturbs what something fifteen
sections away samples. `editor-check` ends by asserting that the page said nothing at all -
`errors.length === 0`, fed by both `pageerror` and `console` at type `error`. Section 7 then
grew a block that hands the deliverable menu a document whose `in` point is not a time, which
is the whole point of it, and `showTimelineError` writes every refusal it shows the operator to
`console.error` as well. Every row the new block wrote was green and the sweep went red: 252
assertions, one failure, and the failure quoting the string the new block had just planted.

**The repair is a drain that asserts, not an exemption that does not.** A filter at the sweep is
the obvious move and it is the one rule 5 is about - a deliberate exclusion, carrying its own
justification, that stops anybody looking twice. It would also be *standing* rather than local:
it would go on covering whatever the page said next that happened to match, and a build where
the refusal stopped happening would take the exemption with it in complete silence, because a
filter that removes nothing is indistinguishable from a filter that removed the thing it was
written for. The block takes its own entry out instead and asserts that it took exactly one,
which turns the noise into a claim about the refusal: `clip-bound-coerces-nonnumeric` reddens
that row too, `0 drained: nothing`, because a build that does not refuse says nothing to the
console.

The temptation next door is to stop driving the door. Section 14 hands `restoreProject` a
document it must reject from inside a page-side `try`/`catch`, so the throw never reaches the
console at all - and copying that here would have made the problem disappear along with the
test. The menu is the door a document from another build actually arrives through, and writing
to the console is part of what arriving through it does. **When an instrument's own noise
collides with a sweep, move the noise, never the sweep.**

## What do my arms agree about

**When one probe turns out to be blind to something, ask what all of them are blind to
together.** Step 6 got the first half of this right and stopped one question short, which is
why it is a rule rather than a note. Its commit reasons that `pointsize-absolute` passes the
1728x1080 arm because the scale factor is exactly 1 there, and keeps a second arm at 1920x1200
for that reason - correct, and it never asked what every arm agreed about at once. The answer
was the aspect ratio. Every arm in `export-check` was 1.6 - 960x600, 1920x1200, 1728x1080, the
640x400 stage - and at 1.6 `bufferWidth / 1728` and `bufferHeight / 1080` are not close but
*identical*, so a build referencing the width was bit-identical on every arm and would have
passed all 30 assertions while drawing 11.1% too large on every size the export menu offers. A
set of probes that agree about a quantity cannot measure it however many of them there are,
and the agreement is invisible precisely because each arm confirms the others.

**The tell was there to be read: the values the instrument tested were not the values the
product ships** - four sizes in the menu, all 16:9, and not one of them in the check. Compare
the constants a tool sweeps against the constants the UI offers, and treat a disjoint pair as
a hole until measured otherwise. The fix was one cross-build arm at 1920x1080 and a
`scale-by-width` mutation, which now fails that row and leaves every other assertion in the
file passing.

### The second form: an object every observation happens to skip

The rule above has a second form, and it hides better: not every arm agreeing about one
quantity, but every observation of a single *object* switched off at once, each for its own
locally defensible reason. It has now produced three failures in a row.

**Step 7, and the skipped object was the take being shot.** The route sweep watched five
stores, a write counter and the recorder's own state, and a read route appending 64KB to the
take being recorded passed all 251 assertions at exit 0 — leaving nine 4096-byte runs of 0x07
in the file and `stream desync at 6349028: expected magic KNCT, got 0x7070707` when it finally
closed. Three decisions assembled into that hole and every one of them is right on its own:
the open take's size and modification time are excluded from the snapshot **by name**, because
they move on their own and comparing them would flake; no write counter covers the captures
directory, because the counters were built for the document stores; and the recorder's state
field tracks the recorder rather than the file, which is what it is for. Reading any one of
them finds nothing wrong. The file they all skipped was the most valuable thing in the system,
excluded on purpose, for a good reason.

So ask the question in both directions. Not only "what do my arms agree about", but
**"is there an object here that every observation happens to skip"**
— and be most suspicious where
the skipping was deliberate, because a deliberate exclusion comes with a justification that
stops anybody looking twice. The fix was to assert the identity `bytes === on-disk size` after
the take closes, where nothing is in flight and it is exact, with `plant-open-take` as the
control.

**The sensor view button produced it a second time, where the skipped object was the picture
and the excuse was that the camera is easier to read.** `sensor-view-check` had six sections
asserting `freeCamera.position`, `fov`, the fit and the stores, and not one pixel: the pose is
set several lines before `sensorView` asks for an image, so deleting `requestRepaint()` from
it leaves **all 125 assertions green** while the editor's picture does not move until the next
pointer gesture happens to render it. Section 7 and `--mutate no-repaint` are that gap closed,
and what makes them worth reading is that the comparison was vacuous twice before it worked,
both times reporting a picture that moved when nothing had rendered at all:

- **The chrome overlay is a second canvas sitting exactly over the picture**, and `drawChrome`
  repaints the path and the frustum from the new pose on the next animation frame whether or
  not the renderer drew anything. A stage compared with it visible says CHANGED against the
  mutated build.
- **The panel is translucent over the picture's left edge**, so a comparison clipped to the
  canvas rectangle contains the button being pressed - and the pixel row passed under
  `no-repaint` on the *hover highlight of the button itself*. The rect is now hit-tested with
  `elementFromPoint` on a grid and shrunk until every probe lands on the canvas, which is a
  region defined by what is on top of it rather than by anybody's bounds.

There is a third thing that had to be arranged and it is not furniture: **OrbitControls runs
with damping, and `advanceNavigation` calls `controls.update()` inside every render**, so
while the controls hold momentum two renders of one position genuinely differ - measured, as
the section's own control row. Any before/after of the picture is therefore about the coasting
camera unless the residual is spent first. **Anything comparing two frames of this editor
needs all three: the overlay off, the region hit-tested, and the damping drained.**

**Step 9 produced the same shape a third time, and the skipped object was again the picture.**
`monitor-check` had four sections and every arm in all four watched the server — what it
grants, what it puts on the wire, what it writes to disk — so a viewer that rendered a ÷4 frame
as a *different scene* passed all 49 assertions. It did: `bindDepth` wrote the smaller grid
into the head of the 512x424 texture, because `TypedArray.set` only objects to a source that is
too **long**, and 93.8% of the grid then held the last full-rate frame while the live cloud
collapsed into a band a metre above the optical axis. Nothing was excluded on purpose here —
the monitor's own output simply never occurred to anyone as a thing to measure, which is the
harder version, since there is no justification to argue with. **A tool named after a
user-facing surface should have at least one arm pointed at that surface.** Section 5 drives a
browser; `bind-ignores-grid` and `expand-shifts-by-a-block` are one control each, and the
second exists because the first reddens every row and a control that fails everything cannot
say which row carries the claim.

**A fourth, and this time the skipped object was a kind of client no tool had ever created.**
The recorder refuses to start a take while a webcam subscriber is pulling ~50Mbit/s over the
same radio the depth packets are competing for, and the rule implementing that refusal had no
arm anywhere in the suite. Not because anybody excluded it — because every proof tool in this
repo subscribes over `127.0.0.1` to a server started with no `--host`, so `Webcam.isLoopback`
was true by construction and the filter picking out costing subscribers ran against the empty
array in every run of every check. Deleting the rule outright would have changed nothing any of
them observed, and it had in fact already half-happened: the predicate shipped twice, and the
copy carrying the whole docstring about the exemption being inherited by argument rather than
measured had no callers at all.

That is the shape worth taking away. The first three skipped objects were things nobody looked
at; this one was a *state of the system* nobody could reach, because the way every tool
connects made one branch unreachable. **Ask what your fixtures make impossible, not only what
your probes omit** — a constant that every arm happens to share is an exclusion nobody wrote
down. `guard-check` and `monitor-check` had both already solved it for their own claims, by
widening the server with `--host 0.0.0.0` and connecting over this machine's own non-internal
IPv4, so the technique was in the repo and simply had not been pointed here. `vcam-check`
section 6 does that now, with `refusal-ignores-webcam` as the control and an operator accepting
the cost as the positive twin, since an arm built only out of refusals passes against a server
that refuses everything. On a machine with no second address it exits 2 as UNPROVEN rather than
passing, because the arm cannot mean anything there.

**A fifth, and this time the skipped object was reachable through a hook that answers a
neighbouring question.** `editor-check`'s deliverable block drove exactly the shape that
freezes the transport — a saved trim adopted from the menu — and asserted through
`__kinect.editor.clipRange()`, which returns the raw `clipIn`/`clipOut` document fields. The
transport does not move on those. It reads `clipInSec` and `clipOutSec`, two getters that were
not symmetric, so a trim past the program's end made the pair cross and `frameAt` composed to a
constant: every position the editor could ask for came back as one frame, and `exportClip`
computed both of its bounds through it and wrote a one-frame file. The block passed identically
either way, because the fields it read were the ones the document held rather than the ones the
picture came from.

The tell is that `clipRange()` is not wrong. It returns what it is named for, and the fix left
it alone — the new rows read the transport instead, because the two are different questions.
**A hook that answers a question adjacent to the claim is worse than no hook**, since it makes
the row look grounded: the arm is reading live state through a real seam, and the state it
reads simply is not the one the behaviour depends on. Ask what the *subject* reads, not what is
convenient to read about it.

### The third form: a fixture symmetric under the very transform you are testing

The two forms above are about arms agreeing and about an object nobody looks at. There is a
third, and it is the quietest of the three: **every fixture in the rig invariant under the
thing that is wrong.** No arm is switched off, no object is skipped, and every assertion is
measuring exactly what it says — the fixture simply cannot hold the property.

**The cloud was a mirror image of the room from the first commit, and the entire suite passed
it for two years.** `web/main.js` ported `Registration::getPointXYZ` faithfully, which is the
bug: libfreenect2 hands out depth, IR and colour horizontally flipped on purpose to match the
Microsoft SDK's selfie-view convention, and Microsoft pairs that mirrored image with a camera
space whose x grows to the sensor's *left*, so their 3D output is chirally correct while
`getPointXYZ`'s is a reflection. Copy the formula and you get a room with its left and right
exchanged. Nothing was switched off and nothing was excluded. Ask instead what the fixtures
had in common:

- `level-check` plants analytic **planes**. Reflect a plane and it is the same plane, so every
  section in the file drew a bit-identical picture either way round.
- `sensor-view-check`'s intrinsics and fov arms measure **half-angles** — `(DEPTH_W / 2) / fx`.
  A half-angle has no side.
- `cropReach` returns `max(cx, W - cx) / fx * z`, a **magnitude**, so it is invariant too, and
  the row holding it against the intrinsics was correct at every stage of this.
- `registration-check` grades `Registration::apply`, which is the colour resample and not the
  unprojection, and both streams are mirrored the same way in any case.
- `monitor-check` and section 3 of `level-check` measure **extents** — `maxX - minX`. A width
  is invariant under a reflection where a position is not.

A mirror has determinant −1, and every one of those quantities is a scalar invariant of the
transform. So the tell is not a missing arm, it is a **missing asymmetry**: the whole rig was
built out of quantities that a reflection preserves. What closed it was one deliberately
asymmetric fixture — a band of constant depth in a column range off to one side of the
principal point, which `level-check` section 8 plants, with `x-not-mirrored` and
`plan-x-not-mirrored` as the controls. Adding it to `SURFACES` would not have worked, because
that list is a list of planes and planes are the thing that could not see it.

**Ask what group your fixtures are invariant under.** Reflections, translations, uniform
scales and 180-degree rotations are the ones that bite, because each of them leaves some
natural-looking measurement unchanged — and a suite assembled from extents, magnitudes,
half-angles and symmetric shapes is invariant under all four at once without any single
decision looking wrong.

**It also took a physical measurement to settle, and no offline fixture could have.** Section
8 pins the sign; it cannot see the room. What established which way the flip ran was the
colour camera's own 1920x1080 frame off `/camera.mjpg`, where branded text on a subject's
shirt reads only after one horizontal flip — on a JPEG carrying a JFIF APP0 marker and no EXIF
segment, so no orientation tag downstream could have been applying it. **Record the
measurement next to the sign it fixed**, because the check can only say the sign has not moved
since; it cannot say the sign is right.

## Close the class, not the instance — and have the check enumerate it

A review of step 7 found six HTTP routes that changed something while dispatching on the path
alone, one at a time, which makes six a floor rather than a total. Fixing them individually
would have left the next route anybody adds outside the list. The routes are now one table
that *is* the dispatch, served at `/library/routes`, and `library-check` walks it: every route
with a write handler is asked for its method, its content type and its origin, so a route
added later is asked by existing. Enumerating turned up four mutating routes the individual
poking missed - `/library/delete/:id`, `/library/sync-marks/:id`, `/record/mark` and
`/presets/:name`, ten against six.

**The falsification control has to be a mutation that adds a mutating route without
registering it.** For one round the document said so while the suite had no such mutation.
What it had was `stop-route-reads`, which *moves* `/record/stop`'s handler into the `read`
slot, caught by a hardcoded floor on the route counts (`mutating.length >= 10 &&
writeOnly.length >= 7`). Moving a route drops both counts and trips the floor; **adding** one
moves neither in the failing direction, so the floor was blind by construction to the shape
the rule names. A planted read route writing a project passed the whole suite at 241 of 241,
exit 0, with its file on disk afterwards. `read-route-writes` is the control now, and what
catches it is a snapshot of every store rather than a count of registered routes — because a
count cannot answer "did a read handler mutate something".

**Two agreements made that sweep blind, and both are the same question as step 6's aspect
ratio.** The shooting server was spawned with **no `--projects` and no `--presets`**, so three
of the library's five stores sat outside the one directory being snapshotted — which is the
mechanical reason the plant was invisible. And the **recording** take's id was substituted into
every `:id`, where `beingRecorded` answers 409 before the handler runs: five capture routes
were driven and never executed, counted as swept and not swept. The sweep now drives an open
take and a closed one, GET and HEAD, document names that exist and names that do not, and
asserts by name that every route got past the 409 — with any route it cannot build a concrete
URL for named rather than silently driven at a URL still carrying a literal `:foo`.

### The half measured by hand is the half the next round finds

`readPathFor` used to treat every `stat` failure as "there is no fork" and fall back to the
shipped look. That was fixed with the rule stated in its comment — only `ENOENT` is an
absence — and the fix was **measured by hand**, two `curl`s against a server spawned for the
purpose, and asserted nowhere. `DocumentStore.list` was the same rule at the other end of the
same file, went on turning `EACCES`, `ENOTDIR` and an I/O error into an empty directory, and
came back in the next review round: a user library the process cannot enumerate answered 200
carrying exactly the five shipped looks, which is the page a fresh install draws.

Two things to take from it. A rule with two call sites wants **one implementation** that both
call — `listJsonNames` now, which the render queue's `list` also uses, so a third caller
inherits the rule by calling it rather than by somebody remembering. And a hand measurement
is not a row: it proves the instance on the day and leaves the class unwatched.
`list-swallows-unreadable` is the control, and the directory it points at is a **file**, so
`readdir` answers `ENOTDIR` deterministically without a `chmod` that a run as root would
ignore. The row asserts both halves — that the route refuses, *and* that it does not serve
the shipped looks in place of a library nobody could read.

## Assert against the resource, not against the bookkeeping that claims to track it

`/library/descriptors` reported `openCaptures.size`, and the bug underneath it dropped the map
entry while leaving the `FileHandle` open - so the number *fell* while the real count rose, and
an arm reading it watched a descriptor leak and recorded a descriptor being released, 0 against
a real 2. It reports `readdirSync('/dev/fd').length` beside it now and the arm asserts on that.
The same question is worth asking of any count a proof tool reads back from the thing under
test.

## Things that bite in a browser

**`p.x.__proto__ = v` in a probe is not what a file on disk does.** Assignment invokes the
`__proto__` setter and creates no own property at all, so `Object.entries` never sees it and
the document handed to the loader is unchanged - two rows labelled `__proto__` passed against a
build that accepted `__proto__`, because the probe never contained one. `JSON.parse` and
`Object.defineProperty` both create the own, enumerable property that a real file produces.
This is the mirror of the `JSON.stringify` trap recorded above: values sent as source survive,
except this one key, where source is the shape that does not.

**A mean absolute difference cannot see noise that moved.** Grain that has shifted is as
different from grain that has not as grain that has thinned, so both grade mutations survived
every difference-based threshold the sampling residual left room for. What catches them is a
correlation: high-pass both images and correlate, and a structure quantised onto a shared
reference grid correlates 0.94 where a continuously sampled one correlates 0.77.

**A feature that serialises gestures makes every driver's press conditional, and the DOM
observable for "the last one finished" is a task early.** The preset controls grew an
in-flight guard, so a press landing while the previous gesture is still unwinding is
correctly ignored — which turns four existing lines of `editor-check` from "click the
button" into "click the button and hope". The wait that looks right is the one already
beside them, `dialog.open === false`, and it is wrong by construction: `close()` clears
`open` synchronously and fires its `close` event in a later task, and the promise the
handler awaits settles from that event. So a driver can pass the wait, do a whole
Node-side `fetch` round trip, and still press into a gesture that has not finished. It
arrives as a ten-second `waitForFunction` timeout with **zero failed assertions** — a
crash wearing the shape of a catch, which is the outcome this document already names
twice. Measured once, at 238 of 274 on a mutation run whose own rows had not been reached.

Two things to carry. **When a build learns to refuse a repeated gesture, every driver of
that gesture becomes a race**, and the fix is not more waiting but waiting on the right
thing: the guard's own state, published for the purpose, because nothing in the DOM is
that state. And the repair goes to **all** the call sites rather than the one that failed
— `openPicker` is now the only way this section presses either control, so the fifth
gesture somebody adds inherits the wait by existing instead of by being remembered.

**And it came back a round later at the other end: the guard was scoped to the controls
that share the dialog rather than to the value it protects.** Its own docstring named the
failure — "a second door added later would otherwise be a second way in with no guard on
it" — and then listed two of the four doors onto `appliedPreset`. Press save, confirm, and
apply a whole-look preset while the PUT is unanswered: the apply stamps first and the save
lands on top of it with the older revision, which is the same corruption the guard exists
to close arriving through a door outside it. **A guard named after a gesture drifts from
the value it defends; ask which writes it, not which controls look alike.** The choice
against the obvious alternative is worth recording too — a sequence number on the stamp
would be a second gate agreeing with the first, and this document already has the entry
about two gates that cannot be tested apart.

Two things the fix needed that the shape did not make obvious. The guard belongs on the
**handlers** and not inside `applyStoredPreset`, because that function and `restoreProject`
beside it are exposed raw for the proof tools to drive, and a guard pushed down there
starts silently dropping calls that are not gestures. And each door keeps **its own
`catch`**: the recorder's apply writes `ui.recLookNote` deliberately, since
`showTimelineError` targets a strip that surface does not show, so a shared catch in the
wrapper would move that sentence somewhere nobody can see it.

**The same guard stranded the caret its comment said it preserved**, which is the smaller
half and the one a row can hold. `pickPresetSubset` hands focus to the control that opened
the dialog on the `close` event and resolves in the same breath, so the button is holding
the caret when the write span disables that same button a microtask later — which blurs it
onto the body, and re-enabling does not undo that. The comment argued that the narrow span
avoided exactly this, and the ordering made it false. Measuring it needs the driver
changed as well: a programmatic `element.click()` leaves the caret on the body, where a
build that stranded it and a build that never had it read identically, so `openPicker`
focuses before it clicks.

**A contended machine fails a check in a way that reads as a finding.** Two worktrees running
proof tools at once produced four failed runs, and the quiet one is the dangerous one: under
contention the preset-apply evaluate dies with `Resulting promise was garbage collected`, a
sibling of the `Execution context was destroyed` the call is already wrapped against, and
`library-check` stops at 139 of 256 assertions. That reproduced **five times** against a
change while a baseline taken on an idle machine passed twice - a regression with a clean
control, and the change was innocent. What settled it was running the *unmodified* tree back
to back in the same conditions, where it crashed identically. **Re-run the baseline in the
conditions the failure happened in**, and check `pgrep -f "tools/.*-check.mjs"` first. The
loud half of the same collision is in `docs/proof-tools.md`: `library-check` binds fixed
ports, so two runs get each other's server rather than an address-in-use error.

**Playwright drops the page's execution context here, and it is not the code.** A second live
WebGL page while an export is reading pixels back will sometimes take the renderer process
down, and it arrives as `Execution context was destroyed` - with the server log showing the
export it happened during completing normally, all frames present. `export-check` runs one
browser at a time and retries that specific error up to three times, printing the retry count;
anything else propagates on the first attempt, because a check that retried real failures would
report whichever attempt it liked.

**A comment containing a backtick inside a template literal ends the literal.** The shader
source, `timeline-check`'s page ARM and `export-check`'s `EDITOR_ARM` are all backtick strings,
and prose written into them in this repo's house style reaches for backticks around identifiers
by reflex. Three times in one step the file stopped parsing at a word in a comment —
`SyntaxError: Unexpected identifier 'opacity'` — which reads as a code error at a line
containing no code. Inside a template literal, name things in plain words. It happened a fourth
time in step 3 of the effects rework, `Unexpected identifier 'rgb'`, at a comment explaining why
a mix is guarded.

**It arrives under a second message, which is why the retry missed it for a while.**
`Resulting promise was garbage collected` is the same thing - a pending `page.evaluate` whose
context went away - and it was seen twice in about ten runs of `export-check`, both times in
section 4 and both times green on the very next run with the tree unchanged. That is the shape
that teaches people to re-run a gating check until it passes, so it is retried on the same
terms rather than left as folklore. The tell for "flake rather than regression" is not the
message either, since the paragraph above has it arriving from contention as well: it is that
nothing the failing section tests had changed between the red run and the green one, which is
a `git diff` rather than a judgement.

**`page.evaluate(fnSourceString, arg)` does not call the function.** Playwright evaluates the
string as an expression, so the arrow function is created, never invoked, and `undefined` comes
back - which surfaced three helpers later as a missing shot rather than as a call that did not
happen. The house pattern is `page.evaluate(\`(${FN})(${JSON.stringify(opts)})\`)`, and it is
what the other tools already do.

**Adding rows to the panel broke a check that never mentioned the panel.** `#panel` is
`position: fixed` at z-index 10 over the stage with `overflow-y: auto`, so `editor-check`'s
`lit()` — a screenshot clipped to `#stage` — had always been counting panel pixels alongside the
cloud. That was invisible while the panel never moved. Five new sliders made it taller,
`#cropReset` fell below the fold, Playwright scrolled it into view before clicking, and the
"open the box" row compared a frame against the same frame with the panel shifted a few pixels:
386 differing pixels in 202 thousand, reading exactly like the cloud failing to come back.
Hiding the panel for the length of the screenshot takes that row to **0.000%**, where the
pre-change build measured 0.014% — so the repair is better than the state it restored. This is
the letterboxing rule below in its second form: **a change to the panel's height is a change to
where every fixed overlay sits, and any tool screenshotting a region that overlay covers is
measuring it.**

**Feeding today's look into a historical build is a units error, and it reads as the feature
under test having failed.** `export-check`'s cross-build arm plays a pre-rebase revision where
`pointSize` is pixels at the drawing buffer rather than at 1080p. Merging today's Blackwall
document into every arm — so that both builds "end up at the same twelve numbers" — wrote 8.1
into a build for which 8.1 means something 1.8 times larger: the old arm drew 1.82..3.8px where
it should draw 1.02..2.1px, and both rebase rows came back at luminance ratio 0.342 against an
expected 1.0. That is the whole look appearing not to rebase, caused entirely by the instrument.
**Each build applies its own graded values**; the one that still has `setMode` is left to.
Caught by A/B against a worktree at the previous commit, which is the only thing that separates
"my change broke this" from "this was already red".

**A control whose `value` stops meaning the quantity it is named after retargets every tool
that writes it, silently and in the passing direction.** The speed slider's travel became
logarithmic, so `#tRate.value` is a position now and not a rate - and three proof sites wrote a
rate straight into it. `el.value = '1'` had meant 1x and now means 4x, the top of the range.
Every assertion downstream would have gone on passing, because holding the source frame is true
at *any* rate: the arms would have measured 4x while their labels said 1x, and nothing would
ever have said so. What closes it is not remembering to convert - it is that each site now asks
the page where a rate lives (`__kinect.editor.rateSlider`) and then **checks the rate that came
out against the rate that went in**. The conversion alone would have been one more thing to
keep in step; the assertion is what makes a wrong one loud. Ask this of any control whose scale
you change, and of any `.value` a tool sets by hand.

**And a detent has to be measured against the control, not chosen as a round number - and
that mistake was made twice in the same place, the second time by the fix for the first.**
1.00x snaps because `slopeAt` reports it to the audio gate and 0.9995 reads as retimed. The
band started at +/-1.5% of rate, which on a travel spanning a factor of 40 is
`ln(1.015)/ln(40)` of the slider - so the one value the detent existed to make reachable was
not reachable, and the row asserting the snap went red on a build whose arithmetic was
perfectly correct.

It was widened to +/-3% and the comment recorded that as "about 3px", **and that number came
from arithmetic against a ~380px control while the stylesheet ships
`.tchip input[type=range] { width: 92px }`**. So the real band was 0.74px each side: the fix
restored the same unusable state it was written to remove, and every row asserting it passed,
because they all assign `el.value` and none of them touch the rendered control. A band in
*rate* is not a band in anything a finger can find, so it is `DETENT_PX = 3` now, converted
against the element as rendered.

The row that finally measures it is worth copying, because the obvious version does not
work. Sweeping the control a pixel at a time and counting the pixels that land on 1.00x
reported **8px with the band and 8px without** - a probe answering the same number either way
measures neither, for two reasons at once: a range input's track is shorter than its box by
the thumb, so pixel arithmetic from `width` is off by however wide that is, and clicking is
itself a gesture whose detent arming gets in the way of reading the band off it. Taken apart
into two separately measured terms - the band in travel, bisected through the page's own
mapping, and the travel a pixel is worth, taken from two clicks far apart - it reports 76px of
track inside a 92px box and 2.48px each side, and the mutation reddens it at 0.61px.
**Whenever a constant is stated in one unit and lived in another, measure both terms
separately; a single number that comes out the same on both builds is not a measurement.**

**A tool holding its own copy of a layout constant is a copy that goes stale, and it fails
looking exactly like a regression in the product.** Adding one 22px row to the timeline took
`--timeline-h` from 148 to 170, and `export-check` carried `TIMELINE_H_GUESS = 148` as the
height it added to the viewport. So its stage came out 22px short, the editor arm rendered at
the fitted size while the export beside it wrote 640x400, and the row that went red was "every
frame that crossed the wire is byte-identical to the editor's own image" - nine of nine
mismatched, on a build whose export was perfect. The same row had caught the same *shape* once
before, when the letterbox arrived, and the comment beside it says so.

Bumping the constant would close the instance and leave the class: the next row added to the
strip breaks it again, identically. `keyframe-check` had the answer already - its
`CHROME_H_GUESS` is documented as a first guess and the real height is measured after load and
the viewport corrected - so `openPage` now goes through `setStage`, which measures. **When a
tool needs a number the page owns, have it ask the page once rather than agree with it in a
comment.**

**Letterboxing the editor stage moved every pointer coordinate and every buffer-size
expectation, and four proof tools found out one at a time.** `export-check` needed two separate
fixes, `registry-check` failed its render-scale row, and `keyframe-check` failed four rows in a
way that read as a missing feature — `camera.project()` answers in canvas coordinates and
`page.mouse` takes viewport ones, which were the same number only while the canvas sat at the
window's corner. **When a change moves where the canvas is, the tools that drive it by
coordinate are all suspect, not just the ones that mention size.**

**A table of rules where the rule bodies are never called is a table of claims nothing
enforces.** `editor-check` section 1 sweeps every control the editor renders and requires each
to be covered by a `DRIVER_RULES` entry. Every entry carried a `match` written against a DOM
element — and `covered()` re-spelled the same condition against the serialized row, so no
`match` in the file was ever executed. The field read as the implementation and was decoration.

What that cost: a rule added for the ruler's mark ticks matched nothing, said nothing, and the
sweep went on reporting every control covered. The ticks were not in the selector either, so
the class was outside the enumeration twice over — a pressable control the page renders, with a
driver entry written for it, and a sweep that could not see either. Both halves passed, and
each half is the reason the other was invisible.

`match` is the implementation now and `covered()` walks the table, so a rule with no branch is
impossible rather than silent. The row that would have caught it is the new one: **every rule
in the table matches at least one control the page renders.** A rule is a claim that a class of
control exists and is driven, so a rule with no instance is either a control that has been
removed — delete the rule and the section it names — or a sweep that cannot see it. Ordering
became precedence in the same change, with the widest rule last, because a table walked in
order credits a control to the first rule that claims it and the panel-wide rule would
otherwise take controls three narrower rules are the honest attribution for.

**Generalise: when a check has a table of rules and a dispatcher, ask which one the running
code reads.** If the answer is "the dispatcher", the table is documentation, and documentation
that looks like enforcement is worse than none — somebody will add a rule to it and believe the
class is closed.

### The widest rule in the table is not the last resort, and its own predicate says so

Its neighbour above is about rule bodies that never execute. This is the opposite situation
and worth reading beside it: every body runs, the walk is honest, `covered()` consults the
table exactly as it claims to — and a whole class of control still lands outside it.

`DRIVER_RULES` is ordered with the widest entry last, and the widest is `look`:
`inGroup(row, '#panel') && (row.type === 'range' || row.type === 'checkbox')`. Sitting at the
foot of an ordered table, under a comment explaining that ordering is precedence, it reads
like the panel's fallback. It is not one. The group test is the half a reader sees and the
type test is the half that decides, and joined by `&&` the narrower one is the rule — so it
covers two of the values a panel control's `type` can hold and is silent about every other.
Sliders and the generated step rows are those two, which is why it looked total for as long
as the panel held nothing else.

Then the per-parameter resets arrived, one per look scalar, and a reset is a `<button>`:
`el.type` answers `submit`, which is neither of the two. None of them matched `look`, none
matched `keyframe`, which wants `row.kf`, and none matched a group rule, because they sit in
`#panel` and in no narrower group. `covered()` returned null for every one and the sweep
named them. **That is the loud direction, and it is the whole reason this cost a red run
rather than a hole** — a control the table cannot attribute fails by name, where a control
the table attributes *wrongly* is silently counted as driven by a section that has never
touched it, which is the misattribution the dialog-before-panel ordering already exists to
stop. The repair is a `reset` rule keyed on `Boolean(row.reset)`.

**Ask what a control would have to *be* to fall through the last row of the table.** If the
answer is "anything the enumeration does not list", the table has no last row, whatever its
ordering suggests. And **key a rule on the property that makes the control that kind of
control**, not on a DOM attribute that happens to sort today's population correctly: `type`
separated sliders from checkboxes for exactly as long as those were the only two things in
the panel, and it was never the reason a slider is a look parameter.

**A section that stages its subject one way cannot see a defect that only exists the other
way.** The gallery's five-second poll was proved by a section that opened the gallery on the
server holding the recorder, where "this machine's recorder" and "the recorder that owns the
take" are the same process. On an editing station — `--node`, no sensor — they are not, and the
poll watched a flag that never moves while the grid it gates was drawn from both libraries. The
section passed every row on a build where the feature did nothing on the machine it is used
from. The fix is a second gallery in the same section, served by a station whose captures
directory is empty and whose `--node` is the recording server, so every take in that grid is
the node's and a row about the remote tile cannot be answered by a local one. **When a feature
spans two machines, staging both of them on one is not a simplification of the fixture, it is a
different fixture.**

Its own trap, worth writing down because it read as a defect: a remote take that has stopped
offers **Download**, not Open. `availability` gives Open to a remote take only while it is
shooting, because a take mid-write has no settled hash and the node answers 409 for it. So the
transition the linked station gets out of following the node is disabled Open to enabled
Download, and a row copied from the local gallery asserts `find('Open').disabled === false`
against an `undefined` and fails on a build that works perfectly. **`?.field === false` on a
`find` that returned nothing is a missing element reported as a wrong value.**

## A refusal nobody can read is measured as a fault somewhere else entirely

`web/main.js` built its application shell as an object literal of bare
`document.getElementById` calls and then dereferenced every entry unguarded a few hundred
lines below. `getElementById` answers `null`, so an id that stopped existing did not fail
where it was looked up — it failed at whichever consumer touched it first, as
`Uncaught TypeError: Cannot read properties of undefined (reading 'addEventListener')`
against a line number and nothing else.

What that costs is the whole surface, and it costs it in a shape that points away from
itself. `connect()` is called *below* the shell wiring, so the socket is never opened: the
header sits on "connecting…" indefinitely, the viewport stays black, and the server — which
takes `/record/start` over HTTP and has no opinion about whether a browser is attached —
records a take perfectly happily with `clients=0` beside it in the log. An operator reading
that sees a sensor or a network problem. The session this came from spent its first hour on
libfreenect2 packet-loss warnings, which were `[Debug]`-level noise from a link running at
30.0fps with `dropped=0`, because those were the only lines that looked like a complaint.

Two things generalise, and the second is the one worth carrying:

**A component whose absence is fatal must say which component it was.** The repair is to
build the shell through a lookup that collects every id that did not resolve and refuses
once, by name, at construction — and to put the refusal on the status line as well as the
console, because the console is not where the operator is looking. Refusing stays right; a
page that boots with half its wiring gone is worse than one that will not boot. Only the
legibility of the refusal changed.

**`editor-check` could not have caught this, and its own notes said so.** A missing control
makes the module refuse, `openEditor` never sees `globalThis.__kinect`, and the run reports
DID NOT RUN with zero assertions — which is the exit-code-without-a-failed-assertion that
this repo has now written down three times as a bug found. The comment beside
`panel-row-skips-parameter` already recorded that "a plain omission is caught by `main.js`
refusing to boot, which is the right behaviour for a user and useless as evidence here",
and then nothing was placed anywhere else to catch it. **A defect a tool has documented
itself as unable to see needs a home, not a note.** It went to `syntax-check`, which needs
no browser and therefore cannot be defeated by the page failing to start, as
`--mutate shell-id-renamed`.

The row reads the ids out of the module's own `shellElements({...})` literal rather than
from a list kept beside the check, because a hand-copied set drifts and drifts silently: an
id added next year would simply not be checked, and the row would go on printing a clean
line about the ones it still knew. Parsing the literal is what makes a shell entry added
later asked by existing. It carries its own floor for the same reason — an extraction that
matched nothing would print `all 0 ids` and read as a pass.

## A rule that walks a table outwards cannot see what the table never held

The row above — every id the application shell drives is one `web/index.html` declares —
went in to close the class, and then failed to catch the very next instance of it, while
printing a green line the whole time. It was not wrong. It was answering the other
question.

A fork of this branch had made *stats for nerds* a dialog on the record surface and an
overlay in the editor, against a tree where the dialog had been deliberately deleted:
`index.html` says in as many words that the `#stateDialog` "is gone rather than kept beside
what replaced it". Merging brought back three references to it, including a *top-level*
`shell.stateDialog.addEventListener`, so both surfaces threw during module evaluation and
`connect()` — which runs below that wiring — never opened the socket. Git reported no
conflict, correctly: one side added consumers, the other left the shell table alone, and
every line was individually fine.

**The shell row stayed green because `stateDialog` was not in the table to be walked.**
The rule iterates the declared ids and asks the page about each, so a key the table never
declares is outside its domain by construction. The distinction that matters is between
the two absences: an id in the table that the markup dropped resolves to `null` and is
caught at the lookup, while a key the table never mentions is never looked up at all and
is plain `undefined` — the same `Cannot read properties of undefined` crash, arriving
through a door the check was not watching. Both directions are now asserted, with
`--mutate shell-id-renamed` and `--mutate shell-key-undeclared` as their controls.

Two things to carry past this instance:

**When a rule enumerates one side of a correspondence, ask what the other side can hold
that the enumeration cannot reach.** A table-driven check is only as wide as its table,
and the failure it cannot see is the one where the table itself is short. That is not a
gap you find by reading the rule, because the rule is correct; you find it by asking what
would have to be true for the rule to pass on a broken tree.

**The scan needed comments stripped, and found that out by reddening on its own
explanation.** The paragraph documenting the rule names `shell.stateDialog` while
discussing it, and a raw source scan counted that prose as a dereference. A check that
fires when somebody writes *about* the thing it guards is a false positive, and false
positives are how a check stops being read. Stripping can only remove text, so its failure
mode is a miss rather than a phantom — which is why the rule carries a floor that fails
when the scan matches nothing at all.

## A modal ends a run the way a healthy suite ends

`editor-check` section 7 typed a name into the export field and then clicked `#tSetIn` on
the strip to set the range for the render it was about to run. That order was fine while
the export was a row of chips in the timeline bar. The rework made it a `<dialog>`, and a
modal dialog is exactly a thing the browser refuses pointer events behind — so the click
retried against `<dialog open>` for thirty seconds and the process died there.

**What it printed was `160 assertions ran, 0 failed`.** Sections 8 through 20 — the crop,
the parked orbit, the ruler's window, the splitter, the look round trip, the panel groups,
the resets, the key walk, the picker and the pinned drive — did not run, and nothing in
that line says so. The suite's own rule covers this and it is worth restating with a
second instance behind it: **count failed assertions and read which ones fired, because a
zero-failure non-zero exit is a crash to investigate rather than a pass.** The number that
would have caught it immediately is the section count, not the assertion count.

Two things to carry:

**Drive the surface in the order the surface allows.** The README says set in and out on
the timeline bar, then open Output → Export. A check walking it the other way is not
testing a stricter path, it is testing a path that does not exist, and the failure it
produces reads as a hang rather than as a finding.

**A control that moves behind a modal takes every later section with it**, so the cost of
this class is not one row. It is everything downstream of the first click the modal eats.

## A fixture that is gitignored is a term in the assertion

Two rows failed on this tree and passed for whoever wrote them, and neither was about the
code under test:

- `editor-check` section 10 plants keys at `t: 2`, `6` and `20`, zooms the ruler to 30–42%
  of the clip, and asserts that markers outside the window are hidden rather than drawn
  off the edge. The key at 20 seconds is only outside that window while the capture is
  shorter than about 48 seconds. On the 49.79s sample this tree holds it lands at 85% of
  the window — inside it — and the row reddens over a marker that is not outside.
- `keyframe-check` 6d drags a retime key down by 3, 6, 9 and 12 pixels. The retime lane
  draws zero to the capture's own length across forty pixels, so those twelve pixels are
  worth `12 * duration / 40` seconds: fifteen of them here, which takes a key sitting at
  fifteen to exactly zero. A retime curve flat at zero never advances the source, so the
  program length falls back to the last key's own time — and the row asserting that
  slowing a clip makes the program longer read that collapse as the clip failing to slow.

`captures/` is gitignored and `make-fixture` loops the sample to whatever length is asked
for, so the capture a check runs against is a property of the machine. **A literal in
seconds or in pixels, measured against a capture nobody committed, is an assertion about
that machine's `captures/` directory.** Both are fractions of the measured duration now,
and `keyframe-check` reads the lane's own scale back off where the page drew the key
rather than assuming it.

The tell for this class is a row that fails on a value *near* a boundary — 85% of a
window, a value of exactly zero — rather than one that fails by a mile. A build that
genuinely lost the window would put the marker nowhere near the edge of it.

## A probe placed where both builds answer the same thing

Four instruments written for the crop box in one session were each aimed somewhere the
correct build and the broken one would have agreed. All four were caught by running the
mutation rather than by reading the code, which is the argument for the rule that a proof
tool is mutation-tested rather than reasoned about.

**A counter that is zero in both builds.** The face drag had to be shown to arm a redraw
rather than render out of its own handler, and the first counter reached for was
`navigationRedraws` — the one section 9 uses for the same claim about orbiting. A face
drag moves no camera, so that counter sits at zero whether the handler renders or not, and
*any* ceiling passes. `counters.renders` is the one that separates them, because the bug is
an extra frame drawn per pointer move.

**A count taken against a stack with a ceiling.** "One undo snapshot for the gesture" was
first asserted as `depth === before + 1`. The undo stack is capped, and the session reached
the cap: a build committing twenty-four times and a build committing once both leave the
depth at 100. Pressing undo and reading the face back is the assertion that means
something, and it is a smaller edit than the one that was wrong.

**A ratio measured where the ratio is small.** The row proving a hidden box culls rather
than fading to alpha zero counts pixels revealed behind cut foreground — an invisible
occluder cannot reveal anything. At a near plane of 1.5 m the correct build revealed 225
pixels and the mutated one 154, which no threshold divides. At 2.5 m with the lateral faces
open it is 3776 against 993. The claim was right at both settings; only the second one can
be asserted on. A cloud is sprites rather than a surface, so rays get through a stack of
invisible points and this will never be presence-versus-absence.

**An arm lit by a single source.** `registry-check`'s row proving the crop switch reaches
`near`/`far` rendered with everything but the depth pair at its defaults — which leaves
`readRgb` carrying the whole image alone. `--mutate rgb-contributes-no-alpha` renders black
on both arms, they compare identical, and the row fired against a mutation with nothing to
do with the crop. Carrying the scrambled readings into the arm fixes it: a probe lit by five
sources cannot be switched off by one of them. **This is the reason to re-run a tool's
existing mutations after editing the tool**, not only after editing what it tests.

The shape they share is the one this file keeps arriving at from different directions: ask
what the broken build would have to do to still pass, and check the probe is somewhere the
answer differs. Three of the four still measured the right quantity — they measured it where
it had no range.
