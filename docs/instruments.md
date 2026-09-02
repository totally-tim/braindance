# Writing a proof tool that means something

Read this before writing or modifying any proof tool. It is the case file behind the short
rules in `CLAUDE.md`, and every entry was found by running the thing rather than by reading it.

The seam between the three documents, so a new lesson lands in the right one. **This file is
about a check that must fail when the thing under test is broken.** `docs/measurement.md` is
about a number you would report. `docs/proof-tools.md` is the suite reference — how to run each
tool, what it needs and what its exit codes mean.

## An instrument must enforce its claims, not assert them

This is the failure mode this repo keeps producing, so check for it by name. Twice a proof tool
has stated a condition in its header while doing nothing to bring it about:

- `determinism-check --clock` claimed "no frame ever arriving" but left the socket to whatever
  the server was doing, and returned FAIL/PASS/PASS on an unchanged tree.
- `index-check` claimed the scan never holds the file, while an implementation that appended
  every chunk to an array would have passed every assertion it made.

Both enforce the condition now — the first intercepts the socket and *verifies the interception
held*, the second asserts resident memory against a ceiling and a growth bound. Ask what a
broken implementation would have to do to still pass, and close that. **Every proof tool needs a
falsification control**: something that must FAIL if the thing under test were not doing the work.

### A rule with two terms, driven only through the term the code already handled

The panel's store rule is a comparison: an override is kept where it disagrees with what the
document derives, and dropped where the two agree. Either term can move. The check drove one —
press a toggle to collapse a live group, press it again to reopen it, assert the entry is gone —
and reported the rule holding. It did hold on that path, because `toggleGroup` compares the two
*at the instant of the press* and pressing back is the one gesture where they agree by
construction. **The path the check drove was the only path that never needed the fix.** The
other term moves without anybody pressing anything — a value set, a look applied, a project
opened — and nothing in the section moved it, so a build whose prune lived entirely inside the
toggle passed 22 assertions with a group pinned open over an empty document.

**When a claim is a comparison, ask which side your fixture moves**, and write a row for each. A
check that only changes the term the handler is written around is asserting the handler rather
than the rule. The tell was in the prose before it was in the behaviour: the section's comment
said the entry goes "the moment the derivation catches up", while every gesture under it moved
the *override*. A sentence naming a term no arm touches is a hole with a label on it.

`override-prunes-only-on-toggle` is the control, and it restores the pre-fix build exactly rather
than breaking the feature some other way — the prune moves out of `refreshGroups` and back into
`toggleGroup` in one edit. A mutation that also failed the toggle rows would redden a path this
build gets right, and a control that fails everything cannot say which question it was asking.

### The passthrough row that hashed a served part against the set of served parts

`vcam-check` section 2 claimed "the bytes served are the bytes emitted", with a comment saying
that anything decoding and re-encoding on the way through would fail it. It could not. `frame`
was taken off the end of `sub.parts`, `jpegHash` was the hash of `frame`, and the row asked
whether anything in `sub.parts` hashed to `jpegHash` — which `frame` does, being one of them. The
other half of the conjunction was `served.length === 64`, true of every sha256 hex digest there
has ever been. The row reduced to "the emit log is not empty".

The reason was real and was stated in the comment: the emit log's third column hashes the whole
payload, which for a colour message is a u64 stamp then the JPEG, and the stamp moves per frame,
so the logged hash can never equal the hash of a served part. Faced with two sides that could not
be compared, the row hashed one side against itself. **When the two ends of a comparison do not
share a quantity, make the writer log one — do not hash around the problem.** The fix was a
fourth column carrying the sha256 of the part body, passed in at the call site because the wire
layout belongs there and `note` should not have to know that type 3 puts a stamp before its JPEG.

`hd-reencodes-in-flight` is the control, written *before* the fix and run against the unfixed row
on purpose: `[vcam] 22 assertions, 0 failed`, `NOT CAUGHT`, with every row in section 2 green
including both of the ones that exist to catch it. That output is the finding. The mutation has
to be memoised, because a synchronous 1920x1080 re-encode per message starves the stream until
`a frame was served at all` reddens instead — a control that fires for a neighbouring reason is
not a control. And its ffmpeg fallback means an ffmpeg that failed to run prints NOT CAUGHT too,
so what discriminates a real catch is the *pair*: NOT CAUGHT against the old row, `caught, as
required` against the new one.

### A defect that moves a word rather than removing it, and two rows that asked whether it was there

`library-check`'s colour-toggle-during-the-backoff section asserts that the *next* genuine
grabber death is still reported `lost` and still counts toward the backoff table. Both rows read
for a presence: `after.includes('lost')`, and the backoff line count being greater than the count
taken before the toggle. Both passed the mutated build, so `--mutate exit-keeps-the-child-reference`
reddened nothing — and `library-check` has no `NOT CAUGHT` branch, so it exited 0 and read as a
clean pass rather than as the check being blind.

The defect does not delete either signal. It **moves** them. The toggle landing on a stale
`child` reference calls `stopGrabber` on a process that has already exited, and that announces a
`lost` of its own; the respawn that follows still writes a backoff line. Measured side by side,
the fixed build's status slice was `starting live lost` and the mutated build's was `lost
starting live starting`, and the backoff counts went 1→2 fixed against 0→1 mutated. Membership is
true of both. "Greater than before" is true of both.

Both fixes are the same fix. The `lost` row now asks for **order** — the `lost` has to sit after
the `live` the respawn produced — which is what "the *next* failure" meant all along. The backoff
row asks for **one line per death**, `backoffAtRead === exitsAtRead`, rather than for growth; the
count taken before the toggle turned out to be a race in the fixture and is reported rather than
asserted on, since `scheduleRetry` writes its line just after the exit the poll loop watches for.

**When the thing under test is a sequence, a row asking whether a value appears anywhere in it
has thrown away the only axis that discriminates** — ask where it appears relative to the event it
is supposed to follow. And the diagnostic deliberately left un-asserted is what caught this: the
section prints the server's own `colour camera on - ...` line, and reading `restarting grabber`
where a fixed build prints `takes effect on the next spawn` is what said the mutation had applied
and reached the branch while the rows agreed with it. **A printed-not-asserted probe beside a
claim is how you tell a control that missed from a fixture that never ran** — the two are
indistinguishable from the assertion count.

### An A/B where one arm cleans up after the other measures nothing

Both arms run, both produce a real image, and the comparison is still empty.

Section 3c's change lets a draft skip the accumulator reset when the playhead has not moved, and
the claim it rests on is that the surface memory cannot reach the image while fade and wake are
held at zero. The first test alternated the arms back to back — reset, skip, reset, skip — and
reported bit-identity over four pairs and three million bytes, which sounds strong and was worth
nothing. **A resetting draft clears the accumulators and then writes nothing back into them**: no
steps, so no state advance, and trails at zero, so the afterimage pass is off. Every skipping arm
ran on buffers the resetting arm had just emptied, and the one case the change affects — a draft
landing on top of an accurate seek, whose pre-roll has just loaded those buffers — never occurred.

The tell is structural rather than numeric, so it can be looked for: **ask whether arm A leaves
the state arm B is supposed to inherit, and in what condition.** If A's job includes resetting
something, alternating A and B hands B a reset every time. The fix re-establishes the state at
the head of each arm — each one re-seeks — plus the control saying the state was there to
inherit: the seek's own image differs from its draft over 2.21M bytes at worst 170/255. A second
control on the readback itself, because a comparison of two identical zero-filled arrays also
reports bit-identity: holding the camera still gives 0 differing bytes and nudging it 0.25m gives
383,769 at worst 255/255.

### A flag that the right answer and the wrong one both set

Section 9's release row asserted `(await read()).drafted === false` and called that "the release
still lands the accurate image". It does not. `seekNow` clears `drafted` whatever position it was
handed, so a release that seeked *accurately to the wrong moment* — the mutation is
`timeline.programSec + 1` — set the flag to false and passed the row, while the viewport visibly
sat a second away from where the hand let go.

The tell is one word doing two jobs. "Accurate" in the flag means *a seek ran rather than a
draft*; "accurate" in the claim means *the seek went where it should have*. **Ask which of the
readings a broken build would also produce** — here, every one of them, because the only thing the
flag can distinguish is which method ran.

What replaced it compares pictures, and it takes two rows rather than one: a comparison that
cannot separate two moments would pass on every build there is, so the row saying it *can* has to
come first. The statistic is forty tile means over the stage rather than one lit count, because a
cloud a second along mostly redistributes its brightness instead of changing how much of it there
is, and a scalar can come out equal for two genuinely different pictures. Measured, one
screenshot per arm on an idle machine: the released picture sits 0.24/255 from an accurate seek
to the same moment on the worst of the forty tiles, where a seek one second away sits 4.48 — an
eighteen-fold separation, and the claim row asks for a fourfold one. `release-seeks-past-target`
is the control, and it moves that worst tile to 4.50.

### A floor stated in the wrong units stops being able to fail when the selector under it widens

`editor-check` section 1 sweeps the controls the editor renders and demands a driver for each,
and the row under it stops that claim being satisfied by having nothing left to cover:
`check(sweep.length > 60, 'and the sweep found the panel, not an empty page')`. It meant what it
said for as long as everything the selector could reach was the strip or the panel.

The preset subset dialog is a body-level `<dialog>`, so the sweep was widened to `dialog input,
dialog select, dialog button, dialog a` — correctly, because a modal outside every observation is
the deliberate exclusion this document records costing three holes. That put 68 more controls
inside the same count. **68 clears 60 on its own**, so from that commit a build whose panel had
gone entirely would have passed a row whose entire sentence is that the panel was found.
Measured either side: 160 controls at the commit before, of which 131 were the panel; 228 after,
of which 131 are still the panel and 68 are the dialog.

**The same failure has a second form, where the population does not grow but the thing being
counted stops being the thing the sentence is about.** `sensor-view-check` section 6 asserted "and
open on the editor, where grading is the job - 9 look groups, all 9 visible", counting group
*nodes* through `checkVisibility`. Then the panel learned to collapse a group the document says
nothing is in — and collapse hides a group's **rows**, not the box around them, so the node goes
on answering `true` with nothing gradeable underneath it. The row passed, correctly by its own
arithmetic, on a recorder showing four of its nine look groups as a heading and a chevron. It was
found by pressing `extended settings` on the recorder, which nothing else covered: every
screenshot and every `editor-check` row is `/edit`, and a recorder has no clip, so every look
parameter sits at its default and all four collapsible groups derive shut at once.

The repair is to count the controls rather than the containers — `input, select` inside each
block, hit-tested the same way — and to say which groups the collapse rule shut, so the split
between "hidden by the surface" and "collapsed by the document" is legible instead of averaged
away. **A container is visible for a different reason than its contents are**, so a row about
whether something is on screen has to name which of the two it means. Which groups collapse stays
`editor-check` section 13's subject, because a collapse derived from the document is a different
feature from a surface that hides the grade, and one row asserting both would go red for either.

That count gained a third term when the effect rack and `under` metadata began withholding rows.
An open group can correctly show fewer controls than it built: the missing controls are not
collapsed, they are unavailable in the current document. `sensor-view-check` therefore records
the built, available and on-screen counts separately. An open group must show every available
control, while a shut group must show none. Comparing on-screen controls with the built total
would turn correct row hiding into a failed collapse assertion.

Nothing would have caught it. The row it protects — every control has a driver — went on working,
because that one ranges over the same widened set and *should*; only the floor was stated in
units of what the selector happened to return. The repair is one line,
`sweep.filter((r) => r.groups.includes('#panel')).length > 60`, reporting `131 of 228 controls
are the panel's` so the two numbers stay visible.

**When you widen what a count ranges over, re-read every threshold on that count against its own
sentence.** A floor is denominated in the thing it is defending, and a selector is not. This is
the vacuous-conjunction failure at the top of this document arriving from the other direction:
there, a row compared a quantity against a set containing it; here, a row kept comparing the same
quantity while the set underneath it grew a second population that satisfies the comparison alone.

**The repair for that second form arrived carrying the first failure this document names.** The
replacement row read `edFixed.length > 0 && edFixed.every((b) => b.controls > 0 &&
b.controlsOnScreen === b.controls) && sum(edLook, 'controlsOnScreen') > 0` — and the last
conjunct cannot fail while the one before it holds, since a group showing all of its controls
with a positive control count *is* a positive sum. A vacuous conjunction, written into the change
whose commit message cites the vacuous conjunction at the top of this file. The floor beside it
was denominated wrongly the same way: `edFixed` is the look groups that do not declare
`collapses`, so it narrows towards one as more of them do and would reach zero without a word,
while the claim underneath it is about the grade being reachable at all.

The repair is to partition rather than to floor. The look groups are split by the `shut` class
the panel sets, every group the collapse rule leaves open has to show *all* of its controls,
every group it has shut has to show none, and there has to be at least one of the first — checked
from both sides, so a build marking everything shut fails the floor and one marking everything
open fails the controls. **A conjunct earns its place by being able to fail while its neighbours
hold**, and the cheapest way to find out is to ask what would have to break for that term alone
to go red. The same row on the recorder had the weaker version: `after.controlsOnScreen >
before.controlsOnScreen` with the row above pinning `before` at zero, so "controls included" was
graded at one control appearing anywhere on a surface with fifty of them.

Two smaller things from the same change. The dialog's rule in `covered()` has to be tested
**before** the panel's, since the panel rule matches any `#panel` checkbox and would have
credited 54 dialog checkboxes to `registry-check`'s drop-one slider sweep, which has never heard
of them — the misattribution the `DRIVER_RULES` re-keying was done to stop, reappearing as an
ordering rather than as an index. And the row asserting that unticking a group heading takes its
whole group out was first written as `after.length === before.length - off.length`, which is true
by construction of a set difference: a row that cannot fail, in the middle of a section about
rows that cannot fail. It reads the panel's own group out of the DOM now.

### A driver rule keyed to a container covers whatever the container grows next

`editor-check`'s `appbar` rule claimed that "section 1 opens every menu, drives the commands that
stay on this page, and asserts the two real navigation destinations in the markup" — an accurate
sentence about the menus. It matched on `inGroup(row, '#appBar')`, which is not the menus but the
bar they sit in, and for as long as the bar held only menus the two were the same set.

Then the status slot moved into the application bar, and the bar stopped being only menus without
the rule noticing its sentence had narrowed. `--mutate plant-unswept-control` plants a bare button
beside `#tNote`, which is in that slot: the sweep found it through `.appbar button`, `DRIVER_IDS`
did not name it, and the container rule matched it on the strength of sharing an ancestor with the
File menu. **The run reported 420 assertions, 0 failed, and NOT CAUGHT** — the falsification
control for the whole "enumerate rather than list" claim, passing.

The narrowing is to `#navRow` plus a button-or-anchor test, because the nav row is what section 1
walks, and the back link — outside it — moved into `DRIVER_IDS` beside the assertion reading its
href. **A rule's `match` has to name the class its `by` describes, and a container is a different
claim from the controls that were in it when the rule was written.** A rule matching an ancestor
silently adopts every control added to that ancestor afterwards, which is the opposite of what a
coverage rule is for. There is already a row asserting that no rule matches *nothing*; the mirror
of it — that no rule matches more than its sentence — is the harder one.

### A colour filter whose comment named the exception it did not exclude

`planExtent` in `level-check` reads the top-down inset off the overlay's own backing store and
keeps pixels that are bright and near-neutral, with a comment saying why: the path is drawn in
teal and the frustum in orange, "and the cloud is the only near-neutral thing in there." That
sentence is the assertion, and it was never true. The inset's TOP-DOWN caption is `#6d7683` — red
109 against a floor of 90, and 9 and 13 apart on the two neutrality bounds against a tolerance of
26 — so the caption cleared every term of the filter and was counted as cloud from the day it was
written.

It cost nothing for years because every row using it measured an **extent**, and a caption in a
fixed corner perturbs a 159x118px bounding box by a few pixels. The first row to ask for a
**position** found it immediately, and found it as a wrong answer rather than as a red row: with
the caption in the average, two bands planted on opposite sides of the optical axis both reported
left of centre and 0.017 apart, which reads as a real measurement of a real displacement and is a
measurement of the caption.

The fix is subtraction rather than a tighter threshold. Raising the brightness floor to exclude
109 would have put it within about twenty of what a single splat of `rgba(232, 236, 241, 0.55)`
composites to, so the filter would have started deciding between the caption and a thin cloud on
a margin nobody measured. Reading the inset once with an **empty depth grid** and subtracting
that reading is exact: the furniture is whatever the box contains with no cloud in it, and it
cancels term by term.

**A filter's comment enumerating what it excludes is an assertion about the whole drawing, and it
dates the moment it was written.** Anything added to that canvas afterwards — or already there and
never checked against the predicate — is admitted silently. Where the reading is a position rather
than an extent, measure the baseline and subtract it, because a position has no tolerance to hide
a passenger in.

### A control that clears three accumulators cannot say which one it was about

`timeline-check` section 7 asks whether the mosh pass really reads the frame it drew last time,
and the obvious control is the one every section above it uses: render the target with no
pre-roll at all and require the picture to differ. It does differ — and it differs on a build
whose mosh reads no history whatsoever. `--mutate mosh-no-history` points the pass's fetch at
the incoming frame instead of its own last output, and the run came back **87 passed, 0 failed**.

The reason is that a pre-roll is not one accumulator's. `resetAccumulators` clears the surface
memory's state texture too, and that texture reads differently on its first frame whatever the
fade and wake say, so the arm parts from a playback for a reason that has nothing to do with the
pass under test. Putting fade, wake and trails to zero was not enough: the state texture is
written on every arriving frame regardless of what the look does with it.

What isolates the pass is a **short** pre-roll rather than no pre-roll — long enough for every
other accumulator to have converged, short of the refresh by enough that the only thing missing
is the smear's own history. Measured: 35 frames short of a 60-frame pre-roll parts from the
playback by 20/255 across 57.9% of the frame with the pass intact, and by **exactly zero** under
the same mutation. The separation is total, so the floor only has to sit between them.

Beside it, the same section had a second arm that could not fail. `--mutate mosh-never-refreshes`
removes the periodic I-frame, which should leave a playback carrying unbounded history against a
seek that starts from a reset — and it reddened nothing, because the look under the section used
the shipped decay of 0.88 a frame. 0.88^60 is 0.05%: the decay had already bounded the memory the
refresh was supposed to bound, so removing the refresh changed no pixel. The section now names
0.99, where the refresh is what binds.

**Both are the same shape: a probe placed where its answer is the same either way.** Ask what the
arm would read on a build with the defect, not what it reads on the build in front of you.

### A search across two named programs cannot find a third program's text

`effect-conformance-check` hollows each installed package in turn, checks that its GLSL has left
the assembled shaders, puts it back and checks that it returns. The search was written as

```js
`${p.cloud.vertexShader}${p.cloud.fragmentShader}${p.grade.vertexShader}${p.grade.fragmentShader}`
```

which is every program this build had when the tool was written. A pass with its own spine
arrived, and the row for the package that fills it read `while hollow: gone; after: missing` —
the text was never in the string being searched, so its absence proved nothing and its return
could not be seen. The fix is `Object.values(programs)`: the page already answers with every
program it compiled, and reading them all means a fourth spine is asked by existing rather than
by somebody remembering to add it here.
### A viewport sized to a strip that had not finished growing

Four tools open the editor, measure the timeline strip, and grow the viewport by it so the stage
comes out at the size their figures are written for. All four measured it as soon as
`timeline.transport()` existed, which is before the lane stack is built - so the strip grew
afterwards and the stage came out smaller than asked. It stayed invisible for as long as a fresh
take had no lanes at all: with no keys and no retime keys the stack was empty, the strip never
moved, and the race had nothing to expose it. Giving the stack a row per clip made every take
open with lanes, and the same race then reddened four different things - `keyframe-check` and
`timeline-check` threw on the stage size, and `export-check`'s section 4 quietly reported **0 of 9
exported frames byte-identical to the editor's**, because the editor was reading a 638x359 buffer
while the export rendered 640x360. The last of those reads exactly like a rendering regression and
is a measurement taken at the wrong size.

`setOutputSize` does not pin the buffer against a later resize - measured, on one page: 640x360
with the stack empty, 576x324 with one keyed track, 638x359 with the track removed again. So the
fix is to settle before measuring and to read the buffer back after the wait, looping until the
size the tool asked for is the size it still has. **A wait that says "the buffer reached this
size" is not the same claim as "the buffer is this size", and the gap between them is whatever the
page does next.**

**The loop is not enough on its own, and the second round of this proved it.** `timeline-check`
threw `the stage came out 548x308` against a change that moved no layout, and the same tree
produced both outcomes on consecutive runs: the loop breaks the moment the buffer matches, and a
strip measured before the lane stack exists can match by luck - 170px of strip, no lanes, resize,
640x360, break - and then the lanes appear and the stage moves under the guard that reads it
next. Driven both ways through a served revert, the pre-change build landed at 548x308 and the
post-change build at 640x360, which is the opposite of the run that reported the finding. The fix
is one line before the loop: wait for `takeOpened()`, which is the last thing the open does and
therefore the point after which the stack has its rows. **A retry loop cannot recover from
landing on a transient, because landing is what ends it** - so the wait belongs before the loop
rather than inside it.

### A fixture that writes into a read-only snapshot stages nothing

`editor-check` section 22's two-undo sequence needs one edit made on top of a delete, so the undo
of the delete is not the top of the stack. It made it with
`k.timeline.clips()[0].start = 0.75`, and `timeline.clips()` builds a fresh array of fresh objects
on every call - the write landed on an object nothing reads again, `serialiseProjectBody()` did
not move, and the `commit()` under it pushed nothing. The two rows below then asserted against a
stack one entry shorter than the sequence they describe, and whether they passed came down to
whatever unrelated difference the settle happened to leave behind.

It was driven both ways to be sure the finding was the fixture and not the change that surfaced
it: on the current build and on one with `deleteSelectedClip` reverted to its pre-clip-row shape,
`undo.commit()` returned false either way. The fixture goes through the document now -
`serialiseProjectBody`, move the clip, `restoreProject` - and the row's own prose is what says it
should have.

**A handle named for what it reads is not a handle for writing through**, and a snapshot is the
normal shape of one: `clips()`, `read()`, `parkedLook()` and `markTicks()` all copy on the way
out, deliberately, so that a reader cannot accidentally hold a live object. The tell is that the
staging step and the assertion never meet - nothing between them reads the field that was written
- so the row's premise is never checked by the row.

### A row that reads the value under test on both sides of its own comparison

`editor-check` section 22 asserts a mark ticks where the selected clip's placement and curve put
it. The first version read the drawn tick's position and compared it against
`markProgramSec(source)` - the very reading the row exists to check - so `marks-ignore-the-placement`
moved both sides together and the row passed on the defect. Recomputing the expectation from the
clip's `start` and the mark's source second, which the row already has, makes the mutation fire
both mark rows instead of one. **An expectation derived from the thing under test is not an
expectation.**

## Mutation-test the instrument, don't just reason about it

Deliberately break the thing under test, run the check, and confirm it fails on the assertions it
should. This turns the rule above from an intention into a result, and it has caught two flaws
that reading the code did not:

- A serialisation check whose `||` clause let it pass on key count alone.
- A malformed-value table that passed its cases into the page through `JSON.stringify` — which
  turns `NaN` and `undefined` into `null`, so three cases labelled as NaN were silently testing
  null a second and third time. **If you send test values into a browser, send them as source,
  not as JSON**, or your labels will claim coverage you do not have.

Report which mutations you ran and what each one caught. A check nobody has broken on purpose is
a check nobody knows the sensitivity of.

### A "caught" verdict on a tree that was already red

`editor-check` declares a mutation caught when the run ends with any failures at all, and on this
tree three rows about `datamosh.refresh` have been red since `4d711ef`. So a mutation that nothing
tests still reports `caught ... as required`, and the row count in the verdict line does not
distinguish the three that were already failing from the one that was supposed to fire.

That is not hypothetical: `pick-rehomes-reset` was recorded as caught, and reading the fired
labels showed only the three pre-existing rows. The Reset row it was aimed at read the home pose
*after* the presses, so on the mutated build it compared `target0` against itself. Rule 3 - count
the failed assertions and read which ones fired - is what found it, and the fix was to read the
home pose before the section's first press.

The general shape: **whenever a suite has a standing failure, its own catch verdict is a false
positive generator, and a baseline run is the only thing that separates the two populations.**
Run the tool once unmutated first and note which rows are red, then read every mutation run
against that list rather than against zero.

**That paragraph asked the reader to do it and the tool went on comparing against zero, which is
the version of this failure that survives being written down.** Two rows track the length of the
take rather than the build, so on the 243.3s `fixture-1g` every `--mutate` run of `editor-check`
printed `caught, as required (2 assertions fired)` whichever rows fired — measured on
`commit-ignores-null-baseline`, which was recorded as caught off exactly those two and reddened
nothing of its own. **A rule stated in prose is a rule the next run does not inherit**, which this
page says about a floor two sections up and is just as true of a verdict.

So the standing set is declared in the tool as a table of row labels with the reason each stands,
the verdict is computed over the fired set minus that table, and the line says which of the reds
were red either way. Two properties keep the table from becoming the standing exemption this page
warns about everywhere else. A declared row that comes back **green** is reported loudly rather
than failed, because these two flip with the fixture's duration and failing would cry wolf on a
short take — and the report says to delete the entry if it stays green. And the table is
denominated in row labels, so a row that is renamed stops matching and reappears in the verdict
rather than staying quietly excused. Measured after the change: `commit-ignores-null-baseline`
reads `739 assertions, 3 failed`, `2 of those 3 are red on this tree either way`, and
`caught ... (1 assertions fired beyond the standing set)` naming the row it is about.
### A generator reports what it meant to do, and only an oracle reports what it did

Moving the invocation list's prose into the tools' `MUTATIONS` tables was three scripted passes,
and all three reported success while changing nothing or changing the wrong thing. The first
located an entry's end by counting `{` and `}`, which reads the braces inside an edit's source
strings as structure — the lexer trap this file already carries four rounds of. The second
dropped the comma after `]]` when it split an inline literal, so six tables stopped importing
while every file still parsed and still looked plausible to a reader. The third built its
replacement against a body cut one character short of the newline it matched on, so
`String.replace` found nothing, returned the original, and the script counted twenty successes.

**A migration is believed from the artefact and never from the run log.** What caught all three
was re-importing every table from both trees and requiring them equal but for the added field,
and then reading one migrated value back out of the imported table — not any count the scripts
printed about themselves.

**And the fourth instance was in the oracle**, which is the half worth keeping. The check that
says the moved prose is the page's prose is a containment test, and its first version asked
whether the page contained the text in front of a field that already had one. For a field nobody
had touched that head is the empty string, `includes('')` is true of every string, and
thirty-four fields passed a branch that could not fail. **An oracle with a branch that cannot
fail reports nothing while looking like it reports everything** — rule 1 arriving inside the
instrument written to make a deletion provable. Ask of an oracle what you ask of the thing under
test: what would a broken version have to do to still pass. What found this one was counting the
populations separately — moved, merged, untouched — rather than reading the predicate, because
three numbers that have to sum to the total cannot all be silently empty.

### A stale claim has no token to search for, and a busy tree has no honest reading

Two more from the same refactor as the entry above, and it is worth saying that all three arrived
together: each one is an instrument measuring something other than what its reader thought.

**A claim goes stale without leaving anything to grep for.** The census sentence lived twice — in
`docs/proof-tools.md`'s invocation-list heading and in the paragraph forty lines above it — and
the prune corrected the heading and left the paragraph promising "every `--mutate` control it must
FAIL under" about a page that by then listed almost none. It stood through two commits. The same
round's `serialiseProject` rename is the shape from the other direction: a count of call sites
taken before the edit missed an export list entry, a property table entry, and a refusal message
inside a string in `server/jobs.js` naming a function that would no longer exist. **A name is a
token you can search for; a claim is a sentence somebody has to read.** What catches the first is
the grep for the old name run *after* the edit and required to come back empty — a check whose
passing state is nothing rather than a number anybody has to agree with. What catches the second
is asking, at the moment of the deletion, which sentences on this page are now false. That is a
question and not a search, and no walker will ever ask it for you.

**And a check run across a tree somebody else is writing reports about nothing.** `syntax-check`
came back `625 checked ... 1 not matching exactly once` on an anchor into `web/main.js` while
another agent was editing that file and its tool together. Counting the anchor text by hand a
minute later found it present, and a second run was clean. The tell generalises past the busy
tree: **a reading that disagrees with a direct measurement of the same bytes is a reading about a
file that changed between the two.** Noticing that the tree is busy only works if you happen to
look; noticing that two measurements of one file disagree is a property of the readings. A
mutation control makes this worse rather than better, because it writes to the tree and reverts
it — so it must never be run against files an agent holds, and a run that was is void rather than
interesting. The rule is about a reading rather than about a file: the instance that produced it
here was a *directory listing*, counted at six entries while it held thirty-three, and bytes are
only the commonest shape it takes. **And check that an explanation accounts for the quantity that
was actually read** — a preserved-timestamp theory was offered for that listing and it explains
modification times, which nobody had measured, while a count of twenty-seven missing files it
cannot explain at all; an explanation that survives its own scrutiny because it was never asked
the right question is more comfortable than being wrong, and therefore harder to catch.

### A source row that reads the staged tree cannot be falsified by a page mutation

The match-exactly-once rule guards the *anchor*. This is the same hole one layer out, in the
**delivery**, where nothing refused it — and it was almost shipped as the falsification control
for a row about the sensor grid being declared once.

`library-check` applied its two kinds of mutation by two different mechanisms, and only one
touched the tree. `stageServer` wrote a **server** mutation into the copied tree, so a row
reading `join(root, 'server/…')` saw it. A **page** mutation never landed on disk at all:
`openPage` installed a Playwright route interception, so the browser got the mutated body and the
staged `root/web/main.js` was still the clean file. A row walking the staged tree for a literal
would have passed against every page mutation there is, while looking exactly like a row with a
control behind it.

**The tool has one delivery now, and this section is kept for the shape rather than for the
mechanism.** `stageServer` writes every mutation, whichever side of the wire it is on, and
`requireMutationDelivered` asks the server over HTTP whether the bytes it serves are the ones this
run staged — `docs/proof-tools.md` carries that collapse in full. The `shippedSource(rel)` helper
written to close this lost its conditional in the same breath: `mutation.body` and the staged copy
became the same bytes, so the branch was a second path that could only ever agree.

**A source row and a behaviour row are falsified by different things**, and it is worth asking
which you have. The row catching a page mutation by driving the page is safe from this entirely;
the row that greps the tree depends on a delivery it does not name. When the delivery changed,
only the second kind had to be re-examined.

**What holds the staging is the source rows' own controls.** Remove the write in `stageServer`
and `grid-declared-twice` stops reddening — that is the arm, and it is already in the suite. A
helper guaranteeing the bytes independently of the staging would have been the second gate again:
nothing could reach one without the other covering, so neither could be tested.

Measured when the conditional came out: `--mutate grid-declared-twice` still reddens both
dimension rows naming `web/format.js web/main.js`, and `grid-declared-in-another-spelling` still
reddens its two, over a baseline of 392 assertions with none failed.

### A known intermittent in `library-check` section 9, written down with its signature

`and it is stamped in source milliseconds rather than program time` goes red now and then, always
reporting exactly `0ms against source 150ms at program 1.0s`. The row seeks the transport to
program time 1.0, awaits `settled()`, presses mark, and compares the sidecar's `sourceMs` against
`retime.sourceSecAt(1.0)`. `0ms` is not a near miss — it is the mark being taken with the playhead
still at the start, so the seek had not been applied when `markHere` ran.

Seen five times in about eleven runs: four under back-to-back mutation sweeps, and **once in an
unmutated baseline**, which is the part worth recording, because "only ever under load" was the
reading until it was not. Two baselines run immediately afterwards on an idle machine came back at
367 assertions, none failed. Nothing in the diff being measured touches the retime curve, the
transport or the mark sidecar, which is this file's own tell for flake rather than regression — a
`git diff` rather than a judgement.

It is recorded rather than diagnosed. The constants `0` and `150` say the failure is discrete
rather than noisy, so it has a single shape and is worth an hour when somebody has one: **the
suspicion is that `settled()` can return before the seek it was waiting on has been applied**,
which would make every row in that section that seeks and then reads a candidate.

### A second known intermittent, in `timeline-check`, wearing the exit code of a catch

`timeline-check` now and then dies before its first assertion with `the stage came out 533x300 and
this file's figures are 640x360: the strip height or the letterbox moved and every number below
would be measured somewhere else`. That guard is right to exist — every figure in the file is in
stage pixels — but what it catches here is a race rather than a moved letterbox, because **533x300
is not the shape the message implies**: 533 over 640 and 300 over 360 are both 0.833, so the whole
stage was measured uniformly small rather than reframed, which is a page read before it finished
laying out.

**The reason to write it down is the exit code, not the crash.** It throws, so the run exits
non-zero having printed **zero failed assertions**, and a mutation sweep scoring catches by exit
code records it as the tool catching the mutation. That is the shape CLAUDE.md's third rule names
and this file has recorded twice before; it is here a third time because it now has a second
signature to recognise. **`timeline-check` has no crash handler**, so nothing in its own output
distinguishes this from a catch — read the assertion count off every result this tool produces.

**2 of 19 runs**, tallied across one day of `timeline-check` invocations on 2026-08-23 against a
server on the default port. **What that is a rate over is a working day on a shared machine rather
than a controlled sample** — the load during the individual runs was not recorded, and the entry
below is the one with an idle-machine arm under it. The suspicion worth an hour is the same one as
above: a settle that returns before the thing it was waiting on has been applied.

**A second signature, and the arithmetic in it names the mechanism.** On 2026-08-24 the same
guard fired reading `the stage came out 338x190`, four times across one session at load averages
of 9 to 13. It is the same uniform-scaling tell — 338 over 640 and 190 over 360 are both 0.528 —
but the numbers say more than that. The tool sizes its viewport as `360 + strip + shell` after
measuring the furniture, and 190 is exactly `398 − 208`, where 398 is `360 + 0 + 38` and 208 is
the furniture the run then actually had. So the strip measured **zero** and the shell measured 38:
the timeline strip is hidden until the take opens, the furniture is read between `__kinect`
publishing and the transport existing, and a take that opens a beat late leaves the strip hidden
at exactly that moment. The recorded 533x300 is the same subtraction with the other term missing —
`508 − 208`, where 508 is the *initial* `360 + TIMELINE_H_GUESS` viewport, so there the resize had
not landed rather than the strip being absent. **One guard, two ways for the furniture to be read
at the wrong moment**, and both of them are a race between the measurement and the take.

That makes the fix a wait rather than a constant: measure the furniture after the strip is on
screen, which is after the transport exists, rather than before it.

**Made, and it needed a second half the arithmetic above does not name.** The wait fixes the
`338x190` signature, where the strip really was absent; `533x300` is the other term, where the
viewport had been set correctly and the *drawing buffer* had not caught up. So the furniture is
measured after the transport wait and a bounded `waitForFunction` then holds for the buffer to
reach the stage before the guard is asked. The wait is the accommodation and the throw stays the
guard — a timeout falls through to it rather than replacing it, so a run that genuinely cannot
reach this stage still dies naming the size it got. The predicate answers `false` on a page with
no renderer rather than throwing, because a throw inside `waitForFunction` is not caught by it
and the timeout is then never spent, which this page records costing a round elsewhere.

**And the same race was live in `keyframe-check` with a worse consequence, because that tool had
no guard at all.** It measured the strip before the transport wait *and* never measured the
application bar, so both subtract from the same place: the stage came out `360 - strip - shell`
letterboxed to 16:9, measured on this rig at **270x152**, which is 0.42 of the size every figure
in that file is written in. Nothing failed for it, because every image there is compared against
another image from the same run — what failed was section 6b, whose drag into the top-down inset
is arithmetic in stage pixels, and it failed reporting a working feature as gone. Three rows,
byte-identical across four runs and reproduced on a tree one commit older, which is what said it
was not a regression and never said what it *was*. With the wait, the bar included and the same
buffer wait, the tool reads `stage 640x360` and **139 assertions, 0 failed**.

**The general shape is the one worth carrying: a guard that fires is worth more than three rows
that describe the consequence.** `timeline-check` had this assertion from the start and it is
what made its version of the fault a loud crash to be chased; `keyframe-check` had the identical
fault for its whole life and spent it measuring in the wrong units under a green-looking header
that printed the wrong stage size on line two. The header was not lying and nobody was reading
it, which is the difference between a number a tool prints and a number a tool enforces.

### A control that used to fire more rows, because the product got more robust

`timeline-check`'s `no-reset` removes the clear inside `resetAccumulators`. It used to redden more
rows than it does now; it reddens **2**, and the reason is worth writing down because a shrinking
catch reads as a weakening instrument to the next person and is not one here.

Surface memory became per cloud, and a clip now clears its own on the frame it enters. So a build
with the project-wide reset removed still gets a correct surface path, and what leaks is the
afterimage alone - which is conductor-level, one screen-space buffer over the composite, and still
the reset's job. Section 1b catches both halves directly by reading `stateStats()` with no render
in between, which is the strongest form of catch there is: it observes the state rather than
inferring it from a picture. **The claim the control protects is still enforced. What got smaller
is the claim, not the enforcement.** The project-wide reset has not become dead code either - the
2 rows that survive are exactly the afterimage half that only it can clear.

### A build that skips the work entirely is self-consistent, so the equality row cannot see it

`timeline-check`'s section 7 asks whether a clip entered under playback is the clip a seek lands
on. Every entry row went **byte-identical**, which was the result wanted - and then the
`warm-skipped` mutation, which makes `clipShowingAt` never answer `'warming'`, was **caught by
nothing but the two counter rows**. The image rows stayed green under a build with the feature
removed.

The reason is the shape rule 1 names. Both arms lose the warm together: the seek's pre-roll walks
the same frames playback does, so with the warm gone both paths enter cold and **agree with each
other while both being wrong**. An equality between two paths is a claim about the paths, never
about the thing they are both doing, and a feature that either path could drop and stay equal is
outside what the equality can see.

What closed it is a reading of the state the warm exists to build, taken through
`__kinect.stateStats()` with the clip selected. **The first version of that reading was two
positions of one clip and it was wrong**: it compared a clip 0.1s past its cut against the same
clip two seconds in, which is two different pieces of footage, so the ratio it measured was the
take's own motion rather than the warm - 1.57% against 9.32% on a build with nothing wrong with
it, against a threshold of 0.6 that no correct build could have met.

The fixture already held the arm the reading needed. `c1` and `c5` are cut on one take at
placements offset so that they stand on the same source frame at every program position they
share, so at 2.1s they are the same footage, the same look and the same frame - and the only thing
that differs is that `c1` has been playing since the head of the edit while `c5` entered a tenth
of a second ago behind a 30-frame warm. They read **1.57% and 1.57%**. Under `warm-skipped` the
entering one collapses to **0.29%** and the row fires. **When an A/B is an equality between two
paths, ask what both paths would do if the feature were deleted, put a probe on the quantity
rather than on the agreement - and then check the two arms differ in the one thing you mean and
not in the footage as well.**

### The clip that was not warming during the block that measured warming clips

`layering-ab.mjs`'s fourth arm is four visible clips plus one warming, and it first read **+0.05
ms** over four clips alone - a suspiciously round nothing. The tool was printing the reading that
explained it and nobody had asked for it: the warming clip warmed a median of **0 clip-frames per
block**. Its window is `fade + wake` in output frames, the harness had not set a look at all, and
the registry's default fade of 120ms with no wake gives 4 frames - so the clip was idle for 16 of
the block's 20 frames and warming for the last few. The arm was measuring four clips twice.

Two things fell out of fixing it. The default look also puts the geometry on **one vertex per
point instead of two**, because `updateDrawRange` halves the draw when nothing is shedding, so
every number in the run was of the cheap draw rather than the one an edit uses. And the placement
has to be derived rather than guessed: the warming clip starts one output frame past the end of
the block, and the tool now **refuses to run** when the look's warm window is shorter than the
block, naming the arithmetic. With that, the arm warms 15 of 15 frames and the warming clip costs
**+0.02 ms** - the same answer as the accident, arrived at by a run that was measuring it.

**That repair was a precondition and the enforcement arrived later, which this entry read as
though it had closed the case.** `WARM_FRAMES < BLOCK + 1` refuses a look whose warm window
*could not* cover the block; nothing checked that a block *did* warm, and "the arm warms 15 of 15
frames" above is an observation from the run that verified the fix, sitting where a reader takes
it for a property of the tool. The block's own counters were being taken and thrown away -
`clipsDrawn` and `clipsWarmed` are differenced per block and the acceptance test read neither, so
a recurrence would have been averaged in exactly as the first one was. The harness now discards
any block whose drawn and warmed counts are not its arm's declared clips on every frame, which is
what makes the sentence above a reading rather than a hope. **A guard on the configuration and a
check on the run are different instruments, and a page that records the first while stating the
second's conclusion invites the next reader to trust a number nothing was watching.**

**And the tool's exit answered whether the run broke rather than whether it measured.** Closing
the two readings above cost a third, because a discard is only as good as what notices it: with
the warming arm's every block discarded and the other three surviving, the harness printed their
rows, printed `4 clips 10.86 ms/frame = 33% of it, inside`, and exited 0. The one comparison the
tool exists to make was absent and every row that did print was correct, which is the worst shape
a green run can have. A run where any arm has no accepted block now names that arm and exits
non-zero. **An instrument's exit code is a claim about the question it was asked and not about
whether it crashed** - all three gaps found here in one sitting were that same substitution, which
is the tool-side face of this page's rule about counting assertions rather than exit codes.

**The `+0.02 ms` above is withdrawn.** Three runs with all three readings armed put the warming
clip's difference from the four-clip arm at -0.190, +0.060 and +0.120 ms: the sign flips, and each
of them sits inside the arm's own interquartile spread. The figure was never resolvable at the
precision it was published to, and it agreeing with the accident it replaced was luck rather than
corroboration. `docs/performance.md` carries the bound and the noise it was read against.

### A trim that keeps the run in front of it evicts the run behind it

Splitting the fetch cache per take and the walk per clip meant several clips fetch into one cache
in one plan, serialised behind each other. `IndexedTake.trim` kept `[from, to]` of the run it had
just fetched and evicted everything else outside it, which was correct while one clip fetched at a
time and is a **use-after-evict** the moment two do: the third clip's trim dropped the frames the
first clip's fetch had put there a moment earlier, `resident()` came back false, and the seek stood
down twice and returned null. It arrives as `seek()` answering null rather than as a wrong image,
which reads like a transport fault and is a cache fault.

The fix is that a trim keeps the union of every window a caller has asked for and not yet had -
`ensure` claims its span and drops the claim when its fetch settles. The lesson generalises past
this cache: **a resource shared by several readers cannot be reclaimed against the request in
front of it**, and the tell is that the failure only appears at more than one reader.

### A mutation aimed at a call site the rest of the design already covers

`warm-without-reset` was first written to delete the `clearFeedback` inside `enterClip` alone, and
it caught **nothing**. Every path this build can reach clears that same pair a moment earlier:
`resetAccumulators` clears every clip's targets and marks every clip idle, and a clip only enters
from idle. Measured rather than argued - a `clipReEntries` counter counts entries where the clip
had drawn since the last reset, and a walk over the whole multi-clip fixture reports **0** - which
says the clip state machine really is monotone within one walk: off, warming, live, off, with
every move that breaks that order going through a reset first.

So the entry clear is a second clear of something already clear on every reachable path, and it is
kept anyway because it is what makes "a clip holds nothing on the frame it enters" true of the
clip rather than true of the caller. The mutation had to be widened to remove both clears to be a
mutation at all, and it then fires nine rows. **A mutation of one call site is a mutation of the
program only when that call site is the only one that does the work** - and the way to find out is
a counter, not a reading of the code.

### A control that was unfalsifiable for one step, and what made it falsifiable

Section 7 asserts the draw order is depth-writing clips first and additive ones after, with ties
on the clip id. For one step the tie-break half was provable and the split half was not, because
`additive` was one look value broadcast to every clip and no document the build could hold put
clips on both sides of it. The rows said so rather than implying coverage, and this entry recorded
what they did not cover.

**Making a clip's look its own closed it in the step after the one that wrote it down.** The
fixture gives one clip `additive: true` in its own block and leaves four writing depth, so the
split has an arm: the highest render order among the depth clips is asserted below the lowest
among the additive ones, and a row beside it asserts the fixture really does put clips on both
sides - without that, the claim would be a description of one group. `look-broadcast` reddens it
by flattening the fixture to five depth-writing clips, which is the shape the row exists to
refuse. **The lesson is about the writing down rather than about the fix**: the gap was recorded
as a gap, so the step that could close it knew there was something to close.

A second thing came out of the same section. The first version of the fixture ran on Blackwall,
which is additive, and `draw-order-by-array` moved **1.6% of pixels at a maximum of 1/255** -
because additive blending is commutative, so the order it was mutating barely reached the picture.
On a depth-writing look the same mutation moves **69.97% at 22/255**. An order claim measured
under a blend that does not care about order is a claim about nothing.

### A sweep that cannot see a name reached through a spread

Not this file's tool, but the same class as the entry above it. `module-check`'s read sweep
matches `(?<![.\w$])name`, and a spread call - `held.push(...boundColorImages(x))` - puts a `.`
immediately before the name, so the lookbehind rejects it and the import reads as dead. It cost a
false `no module imports a name it does not use` on a line that plainly reads it. Worked around in
`web/main.js` rather than in the tool, because a change to that regex needs its own mutation pass;
recorded here so the next person to meet it knows it is the sweep and not the import.

### A fourth intermittent in `timeline-check`, unresolved, and a dead end recorded with it

**About 1 run in 3 dies mid-evaluate with `page.evaluate: Resulting promise was garbage
collected`, printing zero failed assertions on a non-zero exit.** Measured at **3 of 6** and then
**2 of 6** on the same tree at a load average around 4.5, with the section-7 fixture in the tool.
It reads as a crash at section 1b because that is where the pending evaluate is when the process
goes, but the stdout tail is lost on the abrupt exit, so the row count and the last header printed
are not where it happened - **a run that ends this way tells you nothing about where**.

What is known. No page error, no renderer crash and no navigation: `page.on('crash')`,
`page.on('close')` and `page.on('framenavigated')` were all wired and only the close fired, after
the fact. **Registering `process.on('uncaughtException')` and `process.on('unhandledRejection')`
makes it stop**, which says node is exiting on an unhandled rejection and taking the browser with
it - and neither handler ever printed a reason, which says the reason is being lost the same way
the stdout tail is.

**The dead end, recorded so nobody spends the afternoon again.** `page.route('**/favicon.ico', …)`
called `route.fulfill()` without holding the promise, and a `fulfill` that loses its race rejects
with nobody handling it - a textbook unhandled rejection in exactly the right place. Guarded with
`.catch(() => {})` it ran **6 of 6 clean**, which looked decisive and was not: at a rate around a
third, six clean runs happen 12% of the time, and the very next six on the real tool aborted
twice. The guard is kept, because a floating rejection in a proof tool is a latent fault whatever
else is going on, but **it is not the cause and must not be recorded as one**. This is rule 2 read
the other way round: before believing a fix was the fix, count how often the failure happens
without it.

Practical reading, until it is found: **a `timeline-check` run that ends in `Resulting promise was
garbage collected` did not run.** It is not a catch, it is not a finding, and its assertion count
is not a baseline. Re-run it.

### A third intermittent in the same tool, and this one may not be the instrument at all

**3 of 19**, and it gets its own entry because the first reading of it was wrong in the way this
file exists to catch. It had been put down to contention from another agent writing files mid-run
— the ordinary explanation here. Re-run on an idle machine it reproduces at about one in five, so
contention is not it.

**The signature is discrete every single time**, which is what says there is one mechanism rather
than noise. `timeline-check`'s section 1 prints how many output frames each arm rendered and how
many times it advanced surface memory, then holds the playback arm to `played.delta.renders ===
seeked.seek.target + 1`. A good run reads 361 renders and 122 state advances. A failing run reads
**362 and 124**, the row says `362 of 361`, and the picture comparison behind it goes to max
230/255 at a mean of 19.4845 over 29.743% of pixels. One extra render, two extra state advances,
never any other number.

The extra render happens inside the playback arm's `runTo`, so **this may be a finding about the
transport rather than about the check**: `runTo` occasionally lands one output frame past the frame
it was asked for, and an editor that overshoots a target by one frame is a product defect wearing a
red row. It is unresolved and out of this branch's scope, written down so the next person to see
`362 of 361` starts from the measurement — and so that nobody closes it by widening the row, which
would delete the only thing currently able to see it.

**That last paragraph was wrong, and the correction is left beside it rather than written over it,
because how the reading was wrong is the lesson.** `runTo` lands on its target every time. Two
things the original reading never asked for say so. The sample capture has **no source stamp
between 12.0000s and 12.0333s** — the take stalls there — so a step to output frame 361 crosses no
source frame and could not have produced the +2 state advances that are half the signature. And a
failing run ends with **the playhead at frame 0 and the rain clock reading 0.00000**, which a run
that stepped one frame *past* 12.0s cannot do. The extra render is not inside `runTo` at all: it
arrives afterwards.

**What it is.** `openTake` ended with `await timeline.seek(0)` — the take's first accurate frame —
and everything above that line is awaited: three library listings over the network, the
deliverable, the undo baseline. The editor is on screen and drivable throughout, and
`__kinect.timeline.transport()` has been answering since the transport was built several hundred
lines earlier, which is exactly what every tool in this suite waits for before it starts driving.
So the boot seek arrives *after* the tool's first arm has begun, queues behind the `runTo`, and
lands last: one render at program 0, two source-frame advances, and `this.frame = 0` over the
position the run had reached. The same window is reachable by hand — a person who scrubs while the
listings are still in flight has their position taken away the same way.

**Measured, interleaved, on the build with the fix and the build without it served through the same
page route** so the two arms differ by nothing but the file the page fetched: six probe streams
contending for the machine, six pairs each, **28 measured runs per arm — 10 overshoots before, 0
after**. On an idle machine the same probe reads about 1 in 119, which is why the 3-of-19 above is
consistent rather than contradictory: it was tallied on a shared working day, and contention is the
whole amplifier. The op log names `openTake`'s seek every time — enqueued 57ms into the run, queued
1761ms behind it, one render at target 0.

**The fix, and the shape of it is the reusable part.** That line is a *repaint* rather than a move:
the take is open and configured, so make the image true unless it already is. `seekHere` was the
obvious repair and is the wrong one — it renders the true image at wherever the playhead got to,
which is correct and costs a whole 21-frame pre-roll, so the row that caught this would still be
red and the work would still be wasted. `repaintHere` stands down when an accurate render has
happened since it was asked for, which is what a repaint means. `pumpRepaint` had the same defect
in its own right and goes through the same door: it read the playhead when it pumped and handed
that number to a `seek` that ran whenever the queue reached it. **A guard that stood down on every
repaint would pass every render-count row in this file**, so the control that separates the two is
`timeline-check`'s own `dragging a look slider rebuilds the image`: an over-dropping build reddens
that row and four others, 5 failed assertions of 75.

**One practical consequence, because it has already corrupted a record.** A run caught by this
inflates the fired-row count of whatever else is running: `preroll-constant` was recorded as
reddening 11 rows pre-rebase, and its honest count is **8**. Re-running settled it at 8, 8, then
11, the 11 being a run this intermittent was inside. **The names of the rows that fired are the
claim and the total is not.**

### One regex over two constants cannot see one of them go missing

The grid row asks whether the sensor's `512x424` is declared once, and its first spelling asked
with a single `512|424` alternation. A file "holds the grid" if it matches, and `web/format.js`
matches for as long as *either* number is still written there — so a `DEPTH_H` that stopped being
a literal, or drifted off 424 while `DEPTH_W` held, leaves the holder list reading exactly
`['web/format.js']` and the row green over a tree whose JavaScript no longer describes the frames
the grabber sends.

The duplication half was never at risk: a second file redeclaring either number lands in the list
and the row fails. It is the row's *other* half that could not fire — its failure message says "a
grid that went missing", and it only said that when both went at once. Two rows now, one per
dimension, and `--mutate grid-loses-a-dimension` turns `DEPTH_H = 424` into `DEPTH_H = DEPTH_W -
88`: the value is unchanged, so every page draws the same pixels, and the only thing it can move
is whether `424` is written down. Measured: 366 assertions, exactly one failed, the height row,
with the width row still green. **When a row's subject is a pair, ask for each half separately, or
the half that is still there answers for the one that is not.**

### A search for a number that searches for its digits is a search for one spelling

The third thing wrong with the same row, found by review rather than by a failure. Having split
the alternation into one regex per dimension, each was still `(?<![\d.])512(?![\d.])` — decimal
digits with guards either side to keep `512` out of `1512` and `4.24`. That is a matcher for a
*spelling* wearing the name of the number. A module redeclaring the width as `512.0` is rejected
by the trailing guard, and `0x200`, `5.12e2`, `0b1000000000` and `5_12` are never looked at.

Closed by tokenising every JavaScript numeric literal and comparing its **value**, so the
spellings stop being a list to keep up with — the boundary guards go with it, because `1512`
tokenises whole and answers 1512. The bound is stated in the code rather than left to be
discovered: this sees a literal in any notation and does not see an *expression* that computes the
value, so `256 * 2` and `DEPTH_W - 88` are invisible to it. Legacy octal `01000` is left out
because it is a SyntaxError in a module and `syntax-check` holds that.

**The control is the part worth copying.** `grid-declared-in-another-spelling` plants the same
second declaration as `grid-declared-twice` with nothing changed but the notation — `0x200` and
`4.24e2` — and both mutations are kept, because they fail differently: one is caught by any
matcher and the other only by one that compares values. Verified by running both matchers over
both planted lines: the old one catches `grid-declared-twice` on both dimensions and misses
`grid-declared-in-another-spelling` on both, where the new one catches all four. **A control every
version of the instrument passes is not a control for the change.**

The probe tree gained the same treatment, one file per dimension per spelling plus a file of near
misses — `1512`, `4.24`, `0x201` — and the rows assert the whole matched list rather than
membership, so a matcher that grew *looser* than the regex it replaced fails without a row of its
own.

### A JavaScript question asked of every file in the tree gets answered by prose and CSS

The other end of the same row, and the two corrections pull in opposite directions. The walk is
deliberately wide — every file under `web/` and `server/`, so a page added next year is asked by
existing — and `web/` holds three HTML pages and a stylesheet as well as the modules. Asking "is
512 a literal here" of markup answers about layout and copy: a `width: 512px` rule in `nav.css`,
or a paragraph mentioning a 424-line budget, would have made that file a second grid owner and
failed a clean suite on a change that redeclared nothing.

Narrowing the *walk* to `.js` closes it by opening a hole, because the pages carry real code —
`menu.html` holds `resolveResume` inline and this suite mutates it. So the walk stays wide and the
**question** narrows: the whole of a module, and the `<script>` bodies of a page. Typed scripts
are excluded by their `type` rather than by looking like data, because `index.html` carries an
importmap, and a version string in a JSON blob is not a declaration of anything.

The probe tree carries a page stating both numbers four times over — in prose, in a `<style>`
rule, in the importmap, and in a module script — and a stylesheet stating both in a rule. Exactly
one of those five is a declaration, and the rows assert the whole matched list, so either mistake
fails: reading the paragraph, or no longer reading the script.

**A scope has two halves and they are set separately.** What the enumeration reaches and what the
question is asked of are different decisions, and collapsing them means every widening of one
silently widens the other.

**And the same fact one layer further in: a string is not code either.** Narrowing to the
JavaScript left `throw new Error('expected 512 bytes')` counting as a declaration of the sensor's
width, so an ordinary debug message added to any module would have failed a clean suite. Comments
were already excluded, by a regex; strings were not, and the two are the same exclusion — what the
row wants is what a lexer would call a numeric token.

The pair of regexes went, replaced by one scan. They were each approximating half of a lexer and
each carrying a patch for the other's territory: the line-comment rule skipped a `//` preceded by
a colon, which exists so that a URL *in a string* survives comment stripping. That is a lexer
being written one exception at a time, and the exceptions only stop arriving when the thing knows
what a literal is.

Two decisions in it are worth copying. **Template expressions are scanned and template text is
not**, because `${...}` is code by definition and swallowing the whole template would lose a
declaration inside one silently. And **where it has to guess, it guesses toward reporting**: a `/`
after `}` is division here, so a regex in that position is scanned as code and its digits are
over-reported, which fails loudly. The other reading skips to the next `/` and swallows the code
in between, which is a declaration going unseen under a green row. When an instrument must be
wrong sometimes, choose the direction that announces itself.

The probe carries one file that is on one list and off the other. Its 512s are all text — two
strings, an escaped quote, a comment, a template — and its 424 appears both as text and inside a
`${}`. A scan that reads strings puts it on the 512 list and fails; a scan that swallows template
expressions takes it off the 424 list and fails. One file, both directions.

**Then the scan itself needed the same treatment twice, and both were about a token being asked of
a character.** It entered its numeric branch only on a digit, so `.512e3` — 512, in the notation
with no leading digit — was invisible: a whole spelling in which a second grid could ship under a
green row. And it decided the `/` question from the previous *character*, so `return /512/` left
it looking at the `n` of `return`, called that a value, called the slash division, and read the
pattern's digits as code. A scan takes an identifier whole and keeps it now, because the question
was always about the previous token.

Two details worth carrying. **A dot followed by a digit needs no disambiguation**, since `a.512`
is a SyntaxError and property access can never look like this. And **the kept word has to be
cleared by every branch that is not an identifier**, or a `return` left standing across the string
in `return 'x' / 512` turns that division into a regex and swallows the code to the next slash.
That is the silent direction, so the clearing is the part to get right rather than the keeping.

**A spelling is only covered where a control plants it.** The mutation for notations planted hex
and digit-leading scientific, so the row's claim to see *any* spelling was two-thirds measured and
read as whole. `grid-declared-with-a-leading-dot` is its own mutation rather than a third number
in that one, because the two fail differently.

**And the last of them: a regex over an enumeration is a guess at it.** Deciding which `<script>`
blocks hold JavaScript, the check matched `(text|application)/(java|ecma)script` — a shape, and a
reasonable-looking one. HTML defines *sixteen* JavaScript MIME type essences, and that pattern is
four of them. A page written with `application/x-javascript` runs in every browser and had its
body discarded, so executable JavaScript was being dropped from a row about what the JavaScript
declares.

There is no shape behind the sixteen — `text/livescript` and `text/jscript` are there for reasons
twenty-five years old — so the enumeration *is* the definition, and the fix is to write it down
rather than to describe it. **When a set is defined by a list somebody else maintains, copy the
list; a pattern that covers today's members is a claim about the future that nothing checks.**
Parameters are stripped before the comparison, because the spec matches the essence and because
reading `text/javascript; charset=utf-8` as JavaScript over-reports loudly where dropping it goes
unseen.

The probe's second page carries executable code under a type nobody writes any more and a JSON
block under a type that is not code, so it has to be a holder of one number and not the other. It
also carries the unquoted form with an attribute behind it — `<script type=text/javascript defer>`
— because an unquoted attribute value ends at whitespace and a capture reading it to the `>`
answers `text/javascript defer`, which is in no list of anything. Same failure as the missing MIME
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
planted in the tree the mutations edit: octal is a SyntaxError in a module, no page here carries a
`data-type` attribute, and a mutation of a file under `tools/` would be staged where nothing runs.
So the probe carries them, it asserts the *whole matched list* rather than membership, and each
planted file sits on one dimension's list and off the other's — which makes both a missed form and
an over-read form fail, with no row of its own for either.

### A tenth round, in a second instrument: a mask consulted after the match is consulted too late

`module-check` carries a lexer of its own for the same reason `numbersIn` does, and it took the
same shape of correction on its first run — with one difference, because it is not about a token
being asked of a character. Everything about the mask was right. It was *used* at the wrong moment.

The scan matched `import ... from '<specifier>'` over the raw source and then asked the mask
whether the match had begun in code. A regular expression matches **leftmost-first**, and
`web/main.js` carries a paragraph containing the word `import` a few lines above a real import
declaration — so the engine started at the word in the prose, stretched the clause across the
comment to the `from` on the declaration below, and returned one match whose index is inside a
comment. The mask answered honestly, the match was discarded, and the declaration underneath it
was never matched at all. Measured before the fix: `web/scene.js` and `web/curve.js` lost their
edges and the run reported them as modules nothing loads, which reads as a finding about the tree
rather than about the instrument.

**A filter on where a match *landed* cannot undo a match that started somewhere else.** The repair
is to remove the comment from the text before matching rather than to test the match afterwards,
which needs a third state: a comment is blanked to spaces, and a string **body** is kept, because
the specifier lives in one. Newlines survive the blanking so every line number still means what it
says.

### A control aimed at something the exemption table already covers is answered by the table

The falsification control for "no module writes into a binding it imported" was first written as
`EASE_OUT_LINEAR[0] = 1 / 3;` planted in `web/main.js` — a real cross-boundary write, into a real
imported array, and the run came back **30 assertions, 0 failed, NOT CAUGHT** with the tool working
perfectly. `web/curve.js::EASE_OUT_LINEAR` is in the exemption table, so the write was found,
matched, and excused.

The tell is that every object this tree exports is exempted, by construction: the table was written
from what the tree holds, so *any* plant aimed at an object is aimed at an entry. The control has to
be aimed somewhere the table is not, which here is a memo hung on an imported **function** — and
that is the stronger claim as well, since it says the sweep ranges over every name an import brings
in rather than over the ones the table already knows about. **When an instrument has an exemption
list, ask whether your control lands inside it.**

### The population a floor counts has to be the population that was walked

`module-check`'s write sweep printed its own floor as `inTree.filter(e => e.names.length).length` —
every in-tree edge carrying a named import — while the sweep itself began `const src =
sources.get(edge.from); if (src === undefined) continue;`. An edge out of a page's inline module is
keyed `page.html#module0`, which is never in the map of *files*, so every inline module was skipped
and the floor counted it as swept. Measured: a write planted in `web/menu.html`'s inline module came
back green with the row reading `7 import declarations swept` where the clean tree reads 6 — the
number went **up** as the sweep went blind, which in a log reads as the sweep having widened.

A filter that resembles the walked set is not the walked set. The repair is to increment a counter
at the point of the work, and to make an edge with no body a **failed assertion of its own** rather
than a `continue` — folding it into the sweep's message would make one row mean two faults. Every
other floor in that tool was recomputed the same way at the same time, because fixing the sweep's
would have left the other five outside the list.

### A rule whose exemption list is written from the subject cannot be falsified by the subject

Rule 3 of `module-check` has two classifiers — `shapeOfInit`, which decides whether an export is an
object somebody can write into, and `writesInto`, which finds the writes. Neither had a control.
Every object `web/` exports is in the exemption table by construction, so a mutation aimed at any of
them is answered by the table and comes back NOT CAUGHT with the tool working perfectly. What was
left standing over both classifiers was a single conjunct in the exemption audit: an entry that
covers nothing fails, so a classifier that flagged nothing would eventually redden *those* rows.

Measured, and this is the shape to recognise: forcing `const covers = true;` left the clean run
green **and left all eight declared mutations still catching**, because each of them falsifies
something else as well. Compose the forcing with either classifier stubbed and the tool goes blind
while staying green — `covers=true` plus `writesInto` returning `[]`, or plus `shapeOfInit`
answering `'primitive'`, both PASS. The declared control that looks like it covers this,
`exemption-outlives-its-export`, cannot: un-exporting the binding falsifies `known` and `covers` at
once and the row reports the `known` branch.

Two repairs, both needed. A mutation that falsifies `covers` **alone** — `exemption-covers-nothing`
promotes an exempted control-point pair to the number it is made of, so the entry still names a real
export and covers nothing, one row. And a probe tree carrying one of every export and import
spelling, asserted as exact sets, so both classifiers are falsified on every run rather than
backstopped by a filter. With both in place, forcing `covers` true now reddens the clean run by
itself.

### A sweep ranges over the names an import binds, not the names it asks for

The same tool's sweep took `p.split(/\s+as\s+/)[0]` off every import clause — the **exported**
spelling, which is correct for asking whether the target exports the name and wrong for searching
the importing file, which contains the *local* one. Three spellings of one defect sat outside the
swept population: a renamed import (`{ scalarAt as scalarAtLocal }`, where the sweep searched for
`scalarAt`), a namespace import (`import * as curve`, where the clause parse returned no names at
all), and a default import. Measured, each against the unaliased spelling of the identical write
which the sweep does redden: all three came back `30 assertions, 0 failed, NOT CAUGHT`.

This is one population gap rather than three bugs, and the tell is in the row's own text — it
claimed to range over "every name an import brings in", which is a claim about bindings while the
code held far-side names. **When a row's sentence and its variable disagree about which side of a
boundary a name is on, the sentence is usually the design and the variable is the defect.**
Renaming on import is the ordinary way a fifteen-thousand-line split resolves a name collision, so
this was the spelling most likely to appear in exactly the work the tool was written for.

### A comment that was true when written, and false one commit later

The scan's own paragraph said legacy octal could be ignored: `01000` is 512, it is a SyntaxError in
a module, and every file walked here is a module. Both halves were true when that was written. The
second stopped being true the day the same check began reading `<script>` bodies out of pages — an
**untyped** script is a *classic* script, classic scripts are sloppy mode, and there the form is
legal and means 512. So a page could declare the width as `01000`, the browser would agree it was
512, and the scan would record 1000 and report the grid as stated once.

Nothing announced it. The comment was not edited into being wrong; the *code around it* grew a case
its premise excluded, which is the version of documentation drift that no amount of care while
writing prevents. **When you widen what a check accepts, re-read the exclusions it already carries —
each one is a claim about the old input set.**

The fix is to read the form rather than to rewrite the sentence. Only a leading zero followed by
octal digits: `08` and `09` are the legacy *decimal* forms and mean eight and nine, `0` alone is
zero, and anything with a dot or an exponent is decimal — all three fall out of the pattern rather
than needing a case of their own.

Its neighbour in the same round is the same shape one layer out. `\btype` was matching the `type` in
`data-type`, because a word boundary sits between `-` and `type` as happily as after `<script` — so
a page carrying `<script data-type="application/json">` had its body read as JSON and dropped, while
the browser, seeing no `type` attribute at all, ran it. An attribute begins at whitespace or at the
start of the attribute list, and `\b` is not that boundary however much it looks like one.

### The grid that is declared twice on purpose, in two languages that cannot share one

Everything above is about the sensor grid being stated once. It cannot be. `native/grabber.cpp`
holds `DW`/`DH` and is C++, so it cannot import `web/format.js` — the second declaration has to
exist, and every row in `library-check` is structurally unable to see it, because that walk is
`web/` and `server/`.

**Two unavoidable declarations are not a drift problem solved by deleting one; they are a drift
problem solved by comparing them.** `syntax-check` already did exactly this for `CAPTURE_FORMAT` and
the grid is the same eight lines. What drift costs is worth naming, because it is not a wrong
picture: the grabber emits a depth block of its own size, `server/capture.js` measures every frame
against `DEPTH_W * DEPTH_H`, and so every frame is refused at the parser with the sensor working
perfectly — a node that starts and serves nothing.

Anchored on the *declaration* in each language and never on a mention, which matters more here than
it did for the format constant: `grabber.cpp` also holds `char hello[512]`, a buffer with nothing to
do with the sensor. Falsified by hand, since this row is in `syntax-check` and that tool carries no
mutation table: `DH` moved to 423 fails with `DEPTH_H is 424 in web/format.js and DH is 423 in
native/grabber.cpp`, and restoring it returns the run to 39 files and 0 failed.

**The general form is worth more than the instance.** When a row proves a property within one
language, ask what the same property looks like at the edge of that language — and whether the thing
on the other side is a copy that must agree, rather than a copy that should not exist.

### An enumeration that walks a flat tree is the files that exist, not the tree

The grid row above walks `web/` and `server/` rather than a list of the files that hold the number
today, which is the close-the-class rule. Its first spelling walked the *direct children* of each
and skipped anything `statSync` said was a directory. Both directories are flat, so the walk found
every file there is, the row was green for the right reason, and nothing about it said that the
first subdirectory anybody made would be skipped silently — with a module inside it free to
redeclare the grid under a row still printing green.

The mistake is not the missing recursion. It is that the enumeration was **the files that exist**
while the comment above it claimed the enumeration was **the tree**, and the two are the same list
right up until they are not. A traversal cannot be falsified by the tree it walks when that tree has
nothing in it to recurse into, so the control is a tree the row builds under a probe root of its
own: a `flat.js` with no grid and a `nested/buried.js` with one, run through the same walker,
asserting it answers the buried one alone. Those two paths are relative to the probe root and never
to a checkout, which is why they are written without the directory the walker is handed — a path
spelled the way this repo cites its own modules is a citation, and `syntax-check` resolves those.
**When a row's claim is about a shape the subject does not currently have, build the shape and run
the same code over it.**

### A row comparing two tables must compare the declarations, not the instances

The library badges each refusal the server can send, and the two lists are genuinely separate — the
sentence is the server's, the badge over a 228px poster is the page's — so a key added to one and
not the other is the failure. The row's first spelling read the server's side by flattening the
refusals the fixture takes happened to carry. That covers a key exactly as far as some fixture
provokes it, which is the reverse of the guarantee: the next refusal will apply to a take shape
`buildFixture` does not write, so it would be absent from the derived list, absent from the page's
table, and the row would compare two keys against two keys and pass. Fixed by exporting
`OPEN_REFUSALS` from `server/library.js` and reading `Object.keys` off it, with `--mutate
refusal-without-a-badge` adding a declared key no take provokes and no page badges — a mutation the
old row could not have caught, because nothing it read would have changed. **A row asserting two
enumerations agree has to reach both enumerations; a sample of one of them is a row about the
sample.**

**Its neighbour was written as the other direction and asserted the same one.** The comment promised
that every key in the table is one the scanner can produce, and the code asked that every key a take
arrived with is declared. Those are opposite containments, and only the second was being checked —
so a refusal added to `OPEN_REFUSALS` and to the page's `BADGES` with the `describeTake` branch that
pushes it forgotten would stay green forever: a declared reason, a badge for it, and no take that
can ever wear either. A comment describing a stronger check than the line under it is worse than no
comment, because it is the thing a reader checks instead of the code.

Both directions now, and `recording` is excluded from the second by a fact rather than for
convenience: no take on that server is being written, so the response cannot carry that key however
correct the scanner is, and it is proven where it can be — in the section that stands a recorder up.
The cost belongs to whoever adds the next refusal: it needs a fixture take that provokes it, because
a reason nothing here can reach is a reason nothing here is testing. `--mutate
refusal-declared-but-never-pushed` deletes the `no-hello` push and leaves the key declared and
badged; 368 assertions, five failed, and they are one fact arriving in five places.

### A claim about "whichever surface asks" needs a control per surface

The refusal moved to the server so that one take gets one sentence on every surface, and the commit
changed the gallery and the menu together. The control mutated only the gallery. So reverting the
menu to its old hard-coded "no sensor hello, or under two frames" — or adding any new local
derivation there — left every row green.

Adding the second control found the delivery hole underneath it. A page mutation is delivered by
intercepting its route, and `openPage` knew one page: `library.html` at `/gallery`, with a throw for
anything else. That throw is why the miss was loud rather than silent, and it is worth keeping in
that shape — the table now names `menu.html` at `/` and still throws for a file with no URL. The
glob went with it: `**${target}` for a page served at `/` is `**/`, which matches every
directory-shaped URL the page requests, so the mutated menu would have been fulfilled for requests
that are not the menu. It matches on the pathname now. **A claim that names more than one surface is
not controlled until each surface has a mutation of its own, and the second control is usually what
discovers that the delivery only ever worked for the first.**

**The class then lost a member and gained one, and moving the control rather than deleting it is
the whole of the lesson's second episode.** The menu stopped composing a refusal sentence at all
when the EDITOR tile went, so `menu-decides-its-own-reason` had nothing left to mutate — and the
media picker started drawing the same warning badges, which makes it the second surface now.
Deleting the control would have shrunk the class to one member on a change that added one, so it
moved to `web/take-picker.js` as `picker-decides-its-own-reason`. It arrived pointed at a surface
no section opened, carrying a `fails:` line that said so, which is this entry's own delivery hole
wearing a different coat: an anchor that matches, a mutation that is delivered, and nothing that
reads the sentence it rewrites. The row that closes it opens the picker from `/projects`, presses
the tile of a take the server refuses, and holds `.tp-note` against the sentence the library put on
its own button. Measured: 527 assertions, **1 failed**, that row alone, reading `a take needs two
frames to bracket a position` against the server's `the scan found no whole frame in this take`.
The badge row beside it stays green, because the mutation edits `cannotPick` and the chip's title
comes from `warningsOf`.

### A positive arm built from the interesting shape misses the ordinary one

The version-skew row above has a second arm because a gate that refused every manifest would satisfy
the refusal arm while taking the link off entirely. The first spelling of that arm served one take,
and it was the *refused* one — a take carrying a nonempty `openRefusals`, because that is the shape
the row is about. It is the wrong shape to test a gate with. `openRefusals: []` is what an ordinary
openable take sends, which is nearly every take there is, so a gate written as `length > 0` would
take the link off for every healthy library while an arm holding only the refused take stayed green.
The fixture carries both now, and the empty-list case has a row that names it, because the two takes
fail for different reasons and a combined row would report the wrong one.

**The control for it is `--mutate refusals-must-be-nonempty`, and it is deliberately not a
well-behaved one.** It reddens both arm rows, and then it reddens the node's own rows across the
suite, because the bug it plants is exactly "every healthy node goes dark" — 125 assertions, 11
failed, where a clean run reaches 392. That is the blast-radius rule being broken knowingly rather
than by accident: several sections assume a linked node holding remote takes, and the first of them,
`drawn(undefined)`, waited out its own timeout and threw at 105. That one is guarded now, the same
way the way-back anchor is; the next is the confirm dialog for a take in state `both`, and the ones
after that are download, reclaim and delete. Guarding the class — **every section that needs the
node surviving a node that is not there** — is worth doing and is not done. Until it is, read this
control by which rows went red and not by the assertion total.

### A table indexed by a string off the wire has `Object.prototype` answering for it

The version gate on `NodeLink` checks the *shape* of a node's manifest and deliberately not its
vocabulary, so that a newer node can name a refusal this build has never heard of and have the tile
badge the key as itself — visibly unmapped beating confidently wrong. That door is the point of the
design, and the page's badge table was an ordinary object literal behind it. `BADGES['__proto__']`
answers with `Object.prototype` rather than `undefined`, so the `?.` does not short-circuit, the
call throws on a value that is not a function, and the gallery dies painting the tile — the same
blank shelf the gate exists to prevent, arriving through the one door the gate was told to leave
open. `constructor`, `toString` and `valueOf` are the quieter half: they are callable, so they badge
a take `[object Object]` under a promise that an unmapped key reads as itself.

`Object.create(null)` at the table, not a guard at the lookup, because the lookup is one today and
the property that makes it safe belongs to the table. The same reading then applied to the
instrument that checks it: the containment row asked `k in OPEN_REFUSALS`, and `in` walks the
prototype chain, so a take arriving with `toString` would have been called a declared refusal. It is
`Object.hasOwn` now. **An instrument asking `in` about keys that came off a wire is asking a question
`Object.prototype` gets to answer.**

The control drives it rather than reasoning about it: a stub node one build *ahead*, serving a take
whose refusal key is `__proto__`, with a real server pointed at it and the real page loaded.
`--mutate badges-inherit-from-object` puts the plain literal back and the row reports `TypeError:
BADGES[refusal.key] is not a function`, the page never finishing its paint. Two rows, because
surviving is not the claim — the second asks what the badge actually says, and that arm is the one
the quieter half of the fault would fail.

### Two machines on one network are two builds, and a rig that stages both cannot see it

`library-check` spawns its node and its editing machine out of one staged tree, so both speak the
build under test and every wire-format claim between them is an oracle agreeing with itself. The
failure that shape cannot show is a version skew: the editing machine gets upgraded first, because
it is the one somebody is standing at, and the node goes on serving the manifest of the build
before. That manifest parses, survives the id and hash filters, and reconciles into the listing
looking like any other take — so a field the pages now require is simply absent, and the gallery
blanks on a `TypeError` while painting the first remote tile.

The node in that row is a stub `http` server serving a manifest written out by hand, on a
kernel-assigned port rather than one out of the reserved span, because a port `listen(0)` hands back
cannot be held by another worktree. Written out field for field rather than generated by deleting a
key from today's shape: a fixture derived from the code it is meant to outlive follows that code.
**When a claim is about two builds talking, one of them has to be a fixture — anything the rig spawns
is the build under test.**

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

### A mutation designed on paper against a line the code had not written yet

The glyph field's design document specified its own mutations before the shader existed, and
one of them was a no-op the day it was built. `glyph-hash-on-the-displaced-point` is meant to
reproduce the defect the probe this feature came out of actually shipped — a character hashed
off the point *after* the noise, the ripple, the region push and the lattice have moved it, so
the field boils the moment any of those is raised. The document wrote it as swapping `p0` for
`pos` in the line that takes the hash source. In the shader as built, that line sits before any
displacement runs, so `p0` and `pos` hold the same vector there and the swap changes nothing at
all: a mutation delivered, an anchor matched exactly once, and a bit-identical picture.

The shipped mutation inlines the noise displacement into the hash source instead, which is the
same defect reached through the code that exists rather than through the code the document
imagined. It takes the row that grades it from 11.537 of 255 over 6.37% of the frame down to
0.000 — `registry-check`'s turbulence section, a planted wall at 2500mm inside a 25cm cell on
the tool's own 640x360 canvas, one arm at noise clock 0 against one at 3 — so the mutation is
now doing something before the check is asked whether it noticed.

**A mutation named in a design document is a hypothesis about source text that has not been
written**, and it inherits the ordinary rule with the odds worse: before believing the check
missed it, confirm the mutation did anything. The general tell is that the two sides of the
edit are the same value at the point the anchor lands, which is invisible from the document and
obvious from the file.

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

### A tool whose fixture never existed here had never been exercised here

`index-check` ran green in this worktree all session and proved less than that read. Its fixture
list wants three captures and the third, `fixture-large.knct`, was never built here, so the tool
came back "did not run" and nobody looked further. Two things were true underneath that. The
absence arrived as a crash rather than a refusal — ENOENT when the file was missing, and
`walk.frames[-1]` reading as undefined when the file was merely *too small*, both with **zero
failed assertions and a non-zero exit**, which is the shape rule 3 says to read as a crash to
investigate. And the tool had **no `--mutate` controls at all**, so the row it exists for — a
frame served from an offset past 2 GiB, the hazard `server/capture.js` opens by naming — had
never been shown to fail against a build that could not serve it. It had only ever been read.

**A green run of a tool that cannot run is indistinguishable from a green run of one that did**,
unless the tool refuses. It now exits 2 naming the path or the byte count, the way
`timeline-check` and its neighbours do on a short take, and it carries two controls: one that
takes the frame read back to reading the file whole, and one that wraps the read offset at 32
bits. The second is the sharp one and the reason is worth keeping — it serves the wrong bytes
**with a 200**, so the row can only redden through its own comparison, where a mutation that made
the server error would have proved no more than that the check reads status codes.

Two smaller things fell out of building it, both of the same family. The check's `getBytes` threw
on any non-200, so the broad mutation would have ended the run instead of reddening the rows it
reddens — hardened in the frame section only, since the four rows there are the ones a mutation
aims at. And the run still ends early, in the victim section where a whole-file read meets a
deleted file: that is fine and is reported as `caught, and the count is a floor`, which is the
line between this and `capacity-ignores-demand` further down — that one fired *nothing* before it
died, and was removed rather than kept.

### A needle that also matches the refusal next door is invisible to every green run

The rule above is about a row that reddened for somebody else's reason. This is the same
mistake with the sign flipped, and it is worse again, because there is no red row to inspect:
the row goes on passing under the mutation and nothing anywhere says so.

`jobs-check` asserts refusals by a substring of what the queue said, and its take-id row asked
for `'content hash'`. When `job.capture` became `job.captures`, `enqueue` grew a second refusal
beside the first - the shape check on the caller's own list, and the derivation that refuses a
document whose clips name no content hash to be cut on. `enqueue-accepts-any-capture` removes
only the first. The document then reaches the second, which answers 400 with *"a job's project
has 1 clip(s) naming no content hash to be cut on"* - a different rule, about a different half
of the job, and it contains the words `content hash`. The row passed the mutation. Tightened to
`'names its captures by content hash'` it fires, and the mutated run reports exactly one row.

**A needle has to name the sentence, not a phrase the sentence happens to share with its
neighbours.** The trap is not carelessness about wording: the words overlap *because* the two
refusals are about the same subject, so the closer a new refusal sits to an existing one, the
likelier it is to answer for it. What makes this class its own entry is that neither a green
suite nor a caught mutation can show it - the row is green on the unmutated build for the right
reason and green on the mutated build for the wrong one, and the two look identical. The only
thing that finds it is running the control and reading *which* sentence came back, which is the
same instrument as the rule above and has to be pointed at the passing rows too. **Adding a
refusal beside an existing one is a reason to re-run the existing one's control**, and the run
after the change is where that happens rather than the review.

### A discriminator that both implementations satisfy, worked out on paper and never evaluated

The same design document specified the harder half of the same family and got it wrong in a
way no amount of care about *delivery* would have caught, because the mutation works fine and
the assertion is the empty thing. The glyph field's three keys add into one index and wrap.
The wrong implementation mixes them the way the five readings mix, normalising by the sum of
the weights, and it draws a completely plausible wrong character in every cell — so nothing
asking whether the frame changed can separate the two. The document's discriminator, quoted
exactly because the document is gone and this is the only record of it: "What separates them is
that a mix of two keys at half weight each must land on a character that is *neither* of the two
the keys name alone, where the wrap-sum lands on a third one deterministically." Read it twice.
It assigns a third character to **both** sides, so even taken at face value it separates nothing.

And the arithmetic underneath agrees. A sum gives `fract(0.5a + 0.5b)`; a mix normalising by the
weights gives
`(0.5a + 0.5b) / 1.0`. **They are the same number**, and the sum never exceeds 1 so the wrap
that was supposed to do the separating never fires. Both builds draw the same third character,
both pass, and the row would have been recorded as holding a claim it could not hold — the
worse direction, because it looks like coverage.

What separates them is the property the section next door already rests on, read backwards: a
ratio has no scale. Double every weight and a normalising mix renders the identical image while
a sum walks the index. The shipped row hashes the field at `glyph.tone`/`glyph.hash` of 0.35 each
against the same pair at 0.70 each and requires the two frames to differ, with the two keys
also asserted to draw something on their own so that a difference cannot come from a field that
is blank either way.

**The lesson is not "check the arithmetic", it is where the arithmetic hides.** A discriminator
is a claim that two implementations produce different outputs on one chosen input, and a claim
of that form is falsifiable at a desk in about a minute — substituting the input into both and
seeing whether the two expressions reduce to each other. That minute was not spent because the
sentence describing it was persuasive prose.

### A comment naming which rows catch a mutation is a claim, and this one was wrong

`export-check`'s threshold note ends by pricing what its two bloom mutations cost the bands it
widened, and it used to say that `bloom-reference-1080` — the chain frozen at the wrong
reference — "is not caught on these rows at either band, which is not a gap, and the two
cross-build rows further down are what catch it". Read that way for as long as it stood: the
one number CLAUDE.md states twice had a named catcher, so nobody looked.

Measured on 2026-08-11, both arms against a server replaying `fixture-1g`, once on the module
split and once on `84084b0` before it with the mutation still in `web/main.js`: **50 of 50
passed and 0 failed on both.** Nothing catches it. And the mutation is delivered rather than
absent, which is the distinction that makes this a coverage hole rather than a harness one —
the numbers move, the bloom row's luminance ratio going 1.0006 to 1.0038 and the two
`whole look rebases` rows going 0.410 to 0.382 and 0.371 to 0.345 on the worst of forty tile
means. They move *toward* agreement, which is why no threshold notices.

Two things worth keeping. The first is that this was found by running the mutation on both
sides of a refactor for an unrelated reason: the specs were re-pointed at
`web/bloom-pass.js`, and the run at HEAD was taken only to prove the re-pointing had not
broken a control that turned out never to have worked. **Re-running the baseline in the
conditions the failure happened in is what separated "I broke it" from "it was never there",
and it is the whole of why that rule is in `CLAUDE.md`.** The second is where the coverage went
instead: `test/bloom-chain.test.mjs` asserts the arithmetic directly and reddens four of its
six rows on exactly this mutation, in milliseconds and with no GPU. A picture comparison
between two output sizes cannot see a chain that is wrong by a constant factor, because both
sizes agree about it — so the instrument that can see it is a different kind of instrument, not
a tighter band on this one.

### A mutation run that exits non-zero with zero failed assertions did not run

Every tool that carries mutations refuses one whose anchor text it cannot find, and
Playwright occasionally dies with `Execution context was destroyed` partway through a run -
and all three outcomes exit 1, which reads as a caught mutation to anything checking only the
exit code. Seen twice on step 5, on two different mutations in two different suite runs.
**Count failed assertions, not exit codes**, and treat `fails=0` as a crash to investigate
rather than a success to record.

### And a tool that says `DID NOT RUN` on every run says it to nobody

`level-check` reported `0 assertions, 0 failed` and exit 2 on every invocation for three commits,
and the reason was one line: its staged tree copies `server`, `tools` and `web`, and the effect
store refuses to *boot* without `effects-builtin` — deliberately, so that a broken install cannot
read as nothing-installed. So from the commit that made the effects packages onward, the server it
spawns could not start. The verdict was loud, correct and unread, because the tool is run when
somebody is about to touch levelling and nobody was.

Two things worth keeping. **The exit-2 convention did its job and it is not enough on its own** —
`DID NOT RUN` distinguishes "the harness did not run" from "the harness found something" for a
reader who is there, and a check nobody ran this week has no reader. **And one staging list was
updated while four were not.** `library-check` and `guard-check` name `effects-builtin` in theirs,
each with its own comment saying why; `level-check`, `vcam-check`, `monitor-check` and
`jobs-check` do not, and nothing joins the five lists together. The commit that made the store
refuse could not have known which trees it broke, which is the argument for the refusal being
checked rather than for the lists being remembered.

**All four lists name it now, and unblocking the last three cost one more finding.** `vcam-check`
came back 41 assertions and `jobs-check` 56, both clean the first time either of them booted.
`monitor-check` reached its rows and reddened one, and the row it reddened was a precondition
that had not run since the packages arrived — the entry under "Things that bite in a browser"
below carries it. That is the second half of the argument above stated as a measurement: a tool
that cannot boot is not a tool that is passing, and what four commits of silence were holding was
not nothing. The sweep behind the count is worth writing down too, because the number is smaller
than it looks — six tools in `tools/` stage a tree and spawn a server out of it, and
`sensor-view-check` and `boot-check` spawn from the checkout itself, so they were never exposed.

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

### A filter on the file identity is the same hole as a route that was never installed

The rule above guards the *anchor*: the text a mutation edits still exists, exactly once. This
is the next question along, asked of the same spec — the file that text lives in is one the
tool can still deliver. `editor-check` chose the bytes it would serve by comparing the
mutation's file against the two names it had always carried:

```
const mutatedJs   = mutation?.file === 'web/main.js'    ? mutation.body : null;
const mutatedHtml = mutation?.file === 'web/index.html' ? mutation.body : null;
```

All ninety-nine of its specs satisfied that, eighty-nine naming `web/main.js` and ten naming
`web/index.html`, so it was true by coincidence rather than by construction — and the
coincidence had a date on it, because `web/main.js` is being split into modules and the first
spec to land on one of them leaves both bodies null. Neither route is then installed, and the
two delivery guards were written against those same two names — `if (mutatedJs &&
!servedModule) throw` — so neither of them can fire either. The run prints `MUTATED BUILD` at
the top, drives the tree's own source through twenty-two sections, and ends `NOT CAUGHT`, which
is the verdict this suite reserves for a check that is blind to a real bug rather than for a
harness that never tried.

**Measured rather than reasoned about.** A temporary spec pointed at `web/scene.js` — a module
`main.js` imports, so every surface loads it — came back at 461 assertions with 0 failed and
`NOT CAUGHT`, against an unmutated baseline of 461 assertions with 0 failed on the same server
and the same fixture. Identical to the assertion, which is what the tree's own source running
looks like from outside. Delivered by file identity, the same spec fires one row: `and the
release still owed it movement when the key went in`, at `0.000 m still to travel`, which is
the drift the damping it removes is what produces.

**It is the hole the tool's own comment already recorded, entered from the other end.** That
comment — "a route that was declared and never installed ran the tree's own source and came
back NOT CAUGHT with every row green" — closed the case where the route is missing. This is the
case where the route is written and correct and unreachable, because the selection in front of
it does not recognise the file. The general shape is worth more than either instance: **a
delivery and the check that it was delivered must not be conditioned on the same term.** A
guard reading `mutatedJs` cannot see the failure of a selection that computed `mutatedJs`, and
a count of the requests the page actually made is independent of both.

The fix is one `servedAt(file, documentPath)` resolving any file under `web/` to the path a
browser asks for it at, one `serveMutation` installing that route on every page the tool opens,
and a guard of `MUTATE && served() === 0` — a third branch would have left the fourth file
outside the list. Two refusals fall out of it, and both are exit 2 rather than a red row,
because a red row on a mutation run reads as a catch. A file no page here is served from is
refused before a browser launches: `web/menu.html` exits 2 with "neither a module or stylesheet
under `web/` nor the document `/edit` is served from", zero assertions run. A file that is
served but never requested is refused after the page has loaded: `web/library.js`, staged at
`/library.js` and never asked for, exits 2 naming both. Before the fix that second spec was the
silent one — 461 assertions, 0 failed, `NOT CAUGHT`.

**Stylesheets are in the mapping because the page asks for one, and the arm was measured
rather than assumed.** `web/index.html` links `/nav.css`, so a spec naming it is delivered:
a temporary one moving `.appstatus`'s `margin-left: auto` to `0` came back 461 assertions, 0
failed, `NOT CAUGHT` — and the `served() === 0` guard stayed silent, which is the reading that
separates the two ways of arriving at that verdict. The bytes were handed over and no row in
this tool measures anything the change moves, which is "a mutation that does nothing reads as a
check that found nothing" three sections up rather than the delivery hole this case is about.
The content type is the one the server itself sends for that extension, checked against
`curl -I` rather than chosen: a stylesheet answered with the wrong MIME is refused by the
browser outright, so the page would lose `nav.css` entirely and the run would be measuring an
unstyled build.

**Keying the document on its suffix is where the class would have stayed open.** A rule reading
"ends in `.html`, so serve it as this page" takes `web/menu.html` — a real file this server
really serves, at `/` — and hands its bytes over as the editor's document, whereupon the route
fires, the counter counts it, the guard is satisfied, and every row below asserts against a page
nobody wrote. That is `registry-check`'s recorded failure one level out. So the mapping is an
identity test against the two entries of `server/index.js`'s `PAGES` map that name the surfaces
this tool opens, and anything else falls through to being refused.

**What this does not close.** `web/` holds a fifth kind of file this mapping has no branch
for — nothing here serves an image or a font — and that is deliberate rather than forgotten:
the refusal is loud, and a branch no page exercises is a path nothing has measured.

**And the routing for a third file is exercised now, which it was not when this case was
written.** The paragraph here used to say every remaining spec named `web/main.js` or
`web/index.html` and that the first spec landing on an extracted module would be what tried
it. That happened when the cloud's two GLSL programs became `web/cloud-shader.js`:
`crop-axes-swapped` and `crop-in-image-space` name that file, and `crop-in-image-space` runs
461 assertions with 1 failed and prints `MUTATED BUILD: crop-in-image-space in
web/cloud-shader.js at /cloud-shader.js`, the fired row being the one its spec names — the cut
walking with depth in the direction the plane sits. So the fix above is measured on the case
it was built for rather than on the case that prompted it.

**And the same filter is still standing in `sensor-view-check`**, at its lines 779-780, in the
same two comparisons. It is the safe half of this shape rather than the silent one — that tool
refuses a third file at exit 2 before opening a page, and its own comment says why — so what it
loses to a split is a control rather than a verdict. It is written down here because the two
were one defect with two outcomes, and the loud one is the one nobody goes back for.

**`registry-check` was the other loud one, and a split is what came for it.** It staged the
edit into whichever file its spec named and then returned a fixed pair — `web/main.js` and
`web/index.html`, the module and the panel it has to be paired with — so a spec naming a third
file had its staged bytes discarded at that last line while the route still resolved to that
module's own path. Its comment said as much and refused the whole run at exit 2, with the note
that fixing the pairing was out of scope until something needed it. Eighteen specs needed it at
once: every mutation of the cloud's shaders moved to `web/cloud-shader.js`, and a refusal there
is eighteen falsification controls that cannot run, which is worse than the failure the refusal
was protecting against. The fix is the same shape as the one above — the staged file is carried
beside the pair and served at its own path, registered after the module's route so it wins when
the two paths are the same, and `mutantServed` counts on that route rather than on the file — and
it is falsified rather than argued: serving `main.js`'s bytes at `/cloud-shader.js`, which is
exactly what the discarded staging would have done, takes the run to `DID NOT RUN` at exit 2
with zero assertions and a 30-second `waitForFunction` timeout, because a module answering with
another module's text exports none of the names its importer asks for. With the fix,
`mix-ignores-normalisation` fires 2 assertions and the row it names is the one that reddens,
and `crush-ignored`, which still names `web/main.js`, fires 3 and reddens the drop-one sweep on
`crush` — so neither path was traded for the other.

**And the third file stopped being a module.** When the glyph field's and the rain's GLSL moved
into their packages, sixteen anchors moved with it onto files no browser requests as a script:
`effects-builtin/glyph/index.frag.glsl` and its neighbours are fetched out of
`/effects/:id/file/:name` and spliced into the material by `assembleShaders`. Three tools grew the
same branch — `servedAt` maps a package path to that route, and the fulfilment answers
`text/plain` because that is what `server/index.js` answers, rather than inventing a second
promise about one route. Two properties of the fix are worth having written down rather than
rediscovered. **A mutation now edits more than one file, and two of them span two packages**:
`rain-ignored` patches the rain's own colour lift and the glyph field's index block, because the
rain key is read where the character is chosen — so `registry-check` stages per edit, honouring
the third element of an edit pair the way `export-check` already did and `syntax-check` always
read, and its delivery guard counts per file. A total would be satisfied by one of two chunks
arriving, which is half a mutation measured under the whole one's name. And **`export-check`'s
"is this a page mutation" filter was `file.startsWith('web/')`**, which silently sorted a chunk
into the server-mutation bucket where nothing serves it and nothing counts it — the filter is a
predicate now, and it is the same class as the `**/main.js` glob one level up.

**The one that syntax-check could not see, and now can.** `v.pointSize` and
`f.mark` are slots: the spine carries the text to use when nothing claims them, and the glyph
package's chunk carries an `else` branch that is the same statement again. So
`export-check`'s `pointsize-absolute`, whose anchor is `gl_PointSize = clamp(pointSize * k /
max(0.15, -mv.z), 1.0, 64.0);` with no leading whitespace, went on matching **exactly once** in
`web/cloud-shader.js` after the split — against the fallback, which is text nothing compiles while
the glyph package is installed. The anchor row is green either way, because "matches once in the
file it names" is true of a line nobody reaches. It was repointed at the chunk by reading the
anchor map rather than by running the tool, and what would find the next one was the same
reading: a slot's fallback is a second copy of the shipped text, and an anchor is only in the
right one of the two if somebody decided which.

**Closing it took two rules and not one, and the second is the one that works.** The obvious
rule — every anchor into the spine or a chunk appears exactly once in the *assembled* pair, which
`web/shader-assembly.js` will build under bare node because it imports nothing — is green on
exactly this defect. The glyph chunk's `else` branch carries the old clamp statement verbatim, on
purpose and with its own comment saying so, so the anchor appears once in the assembled text
whichever copy it names and the count cannot tell them apart. What separates them is applying the
edit: staged against the fallback the two programs come back byte-identical, because nothing
emits it. So `syntax-check` asks both, and they catch different things — the count finds an anchor
over two live sites, where a mutation reaches one and is recorded under the whole one's name, and
the move finds an anchor over none. `--mutate anchor-in-dead-fallback` repoints
`pointsize-absolute` back at `web/cloud-shader.js` and is the control for the second;
`--mutate anchor-duplicated-into-a-second-chunk` copies `lattice-ignored`'s anchored line into a
neighbouring package's chunk — a *different* file, since a duplicate inside its own is already
refused one rule up — and is the control for the first.

**The count had to grow a third control the moment there were two spines, and the reason is
that both plants above sit inside one program.** Cutting the grade pass out of
`web/post-chain.js` gave this build four assembled strings rather than two, and the tempting
shape for the count is to ask each program about the anchors of the files that feed *it* —
which reads as tidier, keeps every existing control catching, and stops testing the thing the
rule now claims. A line living in two programs at once counts one in each, so a per-program
count sees nothing. `--mutate anchor-duplicated-into-a-second-program` plants
`streak-ignored`'s guard, which belongs to the grade, in the thermal package's tone chunk,
which feeds the cloud's fragment program: its own file still matches once and the sum is two.
Measured rather than argued — with the count rewritten as a maximum over the four strings
instead of a sum, `anchor-duplicated-into-a-second-chunk` still comes back 1 failed and this
one comes back 0, which is what makes it an arm rather than a fourth way of saying the same
thing.

**`web/shader-assembly.js` is inside the rule as well, and the count is not asked of it.** An
anchor on a branch the emit never takes is the same dead control wearing JavaScript, so the move
half covers it; its anchors are JavaScript and the two programs are GLSL, so the count half would
be asking a question with no answer. `registry-check`'s `ripple-outside-the-gate` is the first
spec to land there, because the region's gate is generated from its consumers' `when` clauses and
there is no longer a line of GLSL anybody wrote to anchor on.

**And the seam this rule needed cost a round of its own.** The row above reads its targets off
disk while these read through the mutation substitution, which looks like an inconsistency and is
the opposite: reading a staged file in the anchor-existence row makes every control report *its
own* anchor as stale, since a control's whole job is to replace the line it anchors on. Written
that way it added one red row to four of `syntax-check`'s seven controls, none of them findings.

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

### A mutation that cannot be told apart from the one beside it

Sizing a take's cache by demand has two numbers in it: what a plan may ask one take for, and what
that take's cache then holds. `cache-is-a-constant` takes both back to the old constant and fires
nine rows. A second control, `capacity-ignores-demand`, was written to take only the cache back -
and it does not redden anything, because it hangs the page instead: a cache smaller than the span
a fetch is allowed to request evicts the frames that fetch has just put in it, `resident()` never
comes true, and the run dies in an unrelated section with **zero failed assertions and a non-zero
exit**, which rule 3 says to read as a crash. It was removed rather than kept as a catch. **Two
numbers that cannot be moved apart in the product cannot be mutated apart in the instrument**, and
the invariant that says so - capacity is never below the span a plan may ask for - is worth a
comment where it is enforced rather than a control that cannot exist.

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

**The content clamp has since gone, and the lesson is what tells you where to probe now.**
`applyLaneHeight` writes `max(0, min(asked, ceiling))`, so the ceiling is the only bound left,
and the fourteen-lane arm cannot tell a build that clamps to the content from one that does not
- both answer with the ceiling there. So section 11 clears the tracks at the end and drags the
splitter open again, which is the arrangement where the stack is shorter than the ceiling and
the two builds disagree. `splitter-unclamped` deletes the ceiling clamp instead, because that is
the clamp there is left to delete.

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
proof tool can hold the second where it cannot hold the first.** The library's ⋯ menu picks
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
The library's viewer is the same projection as its tile at four times the area, and the
scale follows the height — so the gap between neighbouring depth samples on screen follows
it too, and a take that reads solid on its 228px tile came up a faint dot screen. The
spacing is exactly `scale / fx` pixels and not a proxy for it, because the depth cancels out
of the unprojection, so the sample size is derived rather than tuned. Taken from the
sensor's own focal length and never the decimated one: dividing by the divisor as well would
give a coarse remote frame four-times-larger samples and make it look identical to a local
one, erasing a signal the library carries on purpose. Measured: local 76.4 against remote
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

### The one parameter a symmetric ease provably cannot move

`test/curve.test.mjs` gained a row asserting that easing a segment is a different traversal
of it rather than a no-op — without one, the whole "handles shape the timing" test passes
against a build whose ease does nothing at all. The probe went at the midpoint, which is the
obvious place to stand and the only place in the unit interval where the answer is fixed:
`smooth` is `[0.42, 0]` and `[0.58, 1]`, symmetric about the centre, so `easeAt(0.5)` is
0.5 for it and for linear alike. The row failed against a correct build, reporting a midpoint
that had not moved because a correct build does not move it.

A quarter of the way in is where an ease-out has actually done something, and the repair kept
both samples rather than swapping one for the other: the quarter point is the claim, and the
midpoint is now asserted to be *unchanged*, which turns an accident into the statement that
the ease is symmetric. **Rule 4 again, in its purest form — the convenient place to stand and
the fixed point of the thing being measured were the same place.**

### The rain has no room-wide band, and three probes for it were built before that was noticed

Kept because the obvious probe for a falling wave is the wrong one and costs an afternoon to
discover. The rain reads as a drop head descending a column, so the instinct is to plant a flat
wall, work out where a head should be at a given program time, and compare mean brightness
above the band against below it. **That measures flat**, and it is not the rain failing: the
per-column phase is a hash of the cell's own `xz`, so at a fine `latticeCell` every column of
the wall starts its drop somewhere else and the frame averages the whole cycle at every height.
There is no band across a room to find. A fixture that can see one needs a single column, or a
cell coarse enough that neighbouring columns share a phase.

**Direction had to be measured by advancing the phase rather than by reading the sign.** The
probe holds one frame of footage still — `fixture-1g` seeked to program time 12.000s on `/edit`,
in a 1280x800 page, `lattice.amount` 1 on the 5.5cm cell with `glyph.amount` 0 over a depth reading — and moves
nothing but `rainPhase`, because two program times would move the footage as well and a
difference between the frames could then be a person walking. The depth box is shut onto an 0.8m
slab, 2.0 to 2.8 metres, so that one metre of world descent is one number of pixels: over the
whole room it is not, since 0.55 m/s projects to about seven hundred rows at 0.9m and a hundred
and fifty at 4m, and a single vertical shift describes none of that. Cross-correlating two frames
at increasing `dt` then puts the best vertical alignment at a
positive — downward — shift growing linearly: 0, 34 and 76 rows at 0.25, 0.5 and 1.0 seconds,
while the zero-shift self-correlation collapses 0.39 to 0.027 to 0.001, which is what says the
alignment is a translation rather than the frames simply decorrelating. About 76 rows a second
against a predicted 87. The gap is not explained and the prediction is the part to be careful
with: at 0.55 m/s the rows per second depend on the **view** distance to the slab and the camera
sits at z = +1.6, so predicting from sensor depth instead lands about a factor of two out.

**And the lift a pixel actually receives is not the parameter.** At `rain.amount` 0.8 the largest
per-pixel lift measured is 0.383 against the 0.8 the expression suggests, from multiple cells
contributing to one pixel and from clipping — a mechanism that has not itself been verified.
**The clip range and cell size that number was taken at were not recorded with it**, so it is
an order of magnitude and a direction rather than a figure to calibrate against.
Whatever the cause, a future threshold calibrated to 0.8 is calibrated to a number this build
does not produce. **All three probes were one-off scripts rather than tools in `tools/`**, so
the conditions written here are the whole of the record and nothing in the checkout re-runs
them; a number wanted at a different slab, cell or clip range has to be taken again.

### A drop-one sweep proves the parameter is read, not that the code path under it runs

`registry-check`'s sweep takes each look parameter off in turn and asks whether the picture
moved, and its line reads "86 of 89 parameters proven to reach the pixels". Run
`--mutate lattice-ignored`, which closes the guard around the snap so a cell quantises nothing,
and the sweep prints exactly the same 86 of 89. The `lattice.amount` row is green over a shader whose
lattice does not exist.

The mechanism is that the sweep's question and the mutation's subject are two different things.
`lattice.amount` reaches the pixels down more than one path now: the glyph field's energy
compensation crosses as `vCellNorm` and reads the `lattice` uniform directly, above the guard,
and the cell seed and the sprite size read `latticeCell` outside it too, because the rain rides those columns whatever the
lattice is doing. So the parameter still moves the image with the snap dead, which is all the
sweep ever asked. **A drop-one sweep is an existence proof over the whole shader, and a mutation
is about one branch of it. The two coincide only while the parameter has exactly one reader, and
nothing tells you the day it gains a second.**

This entry was written when the snap *was* the only reader, so the row was honest when it
shipped and rotted without anybody touching it — the same shape as a comment that was true when
written, one section up, and the reason to prefer a control that fails to a control that reasons.

Two things about the state it is in now are worth being uncomfortable about. What catches
`lattice-ignored` today is six planted glyph rows that cannot draw one character per cell
without the snap, which is a claim about the glyph field standing in for a claim about the
lattice — a real catcher in the wrong place, and one that goes away with the feature it belongs
to. And before those rows existed the only thing red was the streak's 45-degree row, which is
collateral off the scrambled fixture this mutation unquantises rather than a lattice claim of
any kind. **A mutation whose only catcher is collateral is indistinguishable, from the run, from
a mutation that is caught** — which is why the fails text names the seven rows and says which of
them is the fixture rather than the subject.

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

**A sixth, and the skipped object was a name that answers *yes* to every question its
neighbours ask.** `module-check` ran **57 assertions, 0 failed, PASS** on a `web/main.js`
carrying six imports nothing in the file used — `vertexShader` and `fragmentShader` from
`./cloud-shader.js`, `BloomPass` from `./bloom-pass.js`, and `easeParam`, `easeAt` and
`easeSlopeAt` from `./curve.js`. Three went dead when their callers moved out one commit after
their module was made and three were dead at the branch point, and they were found by a person
grepping rather than by the tool built to hold that boundary.

What makes this worth writing down is *why* three rules missed it, because the answer is not
that anybody scoped them badly. A dead import is a green answer to every question the tool
asks: the graph is still acyclic through it, the specifier still resolves, the file is still
reached from a page so it is not an orphan, the name is still a name the other side exports, and
nothing writes into it because nothing touches it at all. The tool had a row for an orphan
*file* and a row for an import naming a *missing* name — the two questions on either side of
this one — and the shape between them is the one where every observation comes back healthy.
**When two rows sit either side of a gap, the gap is where the fault will be**, because a fault
that reddened either of them would have been fixed already.

Two things came out of closing it. The first: the consumer set for "does anything import this
export" **cannot be the directory under test**. Seven of `web/`'s exports have no importer inside
`web/` — `server/library.js` reads `POLLED_NODE_FIELDS`, `tools/fake-grabber.mjs` and
`tools/library-check.mjs` read `CAPTURE_FORMAT`, and five more are held only by `test/` — and
measured by commenting the outside walk out, a row scoped to `web/` reddens all seven on a
healthy tree. A check that cries wolf on its first run is deleted rather than fixed, so the
scoping decision is the row surviving or not. The direction the walk is allowed to be wrong in
follows from the same argument: a directory it misses costs a consumer and reddens a live
export, which somebody sees, while a directory it should not have walked manufactures a consumer
and keeps a dead export green.

The second: the use question is asked of a **name** and not of a scope, and it took a control
coming back NOT CAUGHT to find where that bites. `--mutate import-used-under-its-far-side-name`
renamed `pollRecordState` to `poll` on import, leaving the file full of the far-side name and
holding no reference to the binding it makes — and the row stayed green, because
`gpuTimer` in `web/main.js` defines a method called `poll` in an object literal, which is a name written
in code position with no dot in front of it and so indistinguishable from a reference. The
control now uses an alias nothing else spells; the limitation is in the tool's header beside the
other one, that a name appearing only inside a string body reads as used. Both are false
negatives, which is the direction an instrument may be wrong in — but the rule is that a
limitation lives in a comment, never inside a control, where it reads as the rule not working.

**And the row written to close that hole shipped six of its own**, found by reading the rule
rather than by running it, which is the part worth keeping. `module-check` came back **60
assertions, 0 failed, PASS** while every one of the following was true of the tree it passed.
They are one family: each is a place where the run *held* the fact and did not *ask* it.

**Two halves computed in one run and never joined.** Rule 4 asks whether an import is read and
whether an export is asked for, and the second half took the import declaration as its evidence
without consulting the first. So the same run reddened `web/main.js` for not reading
`easeSlopeAt` and, five lines further down, counted that identical dead line as the consumer
keeping `web/curve.js`'s export of it alive. Measured against `883f070^` rather than forced:
that is what it printed. The dead export became findable only because a person had removed the
import by hand in the commit before — and a name moved out of a module leaves exactly that pair
behind, so unjoined they conceal each other indefinitely. With the halves joined, the same tree
reddens both rows in one run and names all six imports and the export. **When one row's answer
is another row's input, join them or the run can be right twice and say so once.**

**A population walked for one purpose and trusted for another.** The consumer set had already
been widened to the whole checkout, for the good reason that seven of `web/`'s exports are read
only from `server/`, `tools/` and `test/`. But the widening carried 55 name-level bindings into
the join that were never asked the use question the tool exists to ask, because that question
was scoped to `web/`. An export whose only importer was outside `web/` and itself dead therefore
read as asked-for — the same defect, one directory over, in the machinery built to close it.
**A row that reaches outside its subject to collect evidence has to apply its own standard to
what it collects.**

**A binding that stands in for a whole module, with nothing saying it had.** A namespace import
consumed every export of its target, so the single `import * as clip` in
`test/clip-range.test.mjs` switched the export row off for `web/clip-range.js` entirely: an
export nothing wanted reddened the row when it was appended to `web/view-window.js` and did not
when it was appended there. What makes it the worst of the six is that the passing output said
nothing about a module having gone blind. The repair is narrowing plus disclosure — a dotted
reach asks for one name, a destructure asks for its pattern's names, and **everything else is
one bucket that consumes the module and fails a row of its own**. Enumerating the opaque cases
instead would have been the mistake: `ns[k]` is the one that comes to mind, and `Object.keys`,
`{ ...ns }`, `for (const k in ns)` and passing the binding to a function are the ones that do
not, and a narrowing that consumed nothing for them would redden a clean tree.

**A limitation written down is not a limitation measured.** The header named two false negatives
in the use question and was wrong about the shape of both. It said a name mentioned only inside a
GLSL template literal would read as used; template text is left at mask 0 by the lexer and blanked
to spaces, so that plant was caught the whole time and the surviving case was the quoted string.
It named the property-key case as unclosable, on a measurement of a lookahead over `:` or `(` at
the head of a line that cost twelve false positives — but the narrower question, are the nearest
code characters either side of the hit a `{` or `,` and a `:`, costs none on this tree and closes
the object-literal key outright. Both closures were free, and both had been sitting behind a
paragraph confident enough to stop anybody re-measuring. The method shorthand `{ poll(gl) { … } }`
really is open, and it was re-measured afterwards rather than inherited: the `poll` alias still
comes back NOT CAUGHT. **Re-run the measurement a limitation rests on when you touch the thing it
is about**, because a limitation is a claim about the instrument like any other.

**And the floor lesson two sections up, repeated in a new row by the same author in the same
week.** Rule 4's import row printed `118 names across 28 in-tree and 17 bare declarations` with
the bare count taken off the collection rather than off the sweep, so a version that iterated
`inTree` alone — measured by forcing exactly that — left the clean run green at 60 assertions,
every one of the twenty controls then declared still catching, and the row still claiming its 17.
The counts are now incremented where the question is asked, and `--mutate dead-bare-import` is
the arm that half never had. **A rule you have written down about one row is not a rule the next
row inherits**; the only version that holds is the one where the count cannot be computed anywhere
but at the point of the work.

Two notes for anybody re-running those forcings. A scratch copy of the tool needs
`--root <checkout>`, because `ROOT` is derived from `import.meta.url` and a copy living in a
temporary directory otherwise exits 2 with "no web/ or no package.json" — which reads as the
forcing having broken something when it is the copy looking in the wrong place. And the in-tree
declaration count the import row prints is two below rule 2's edge count on this tree: those two
are the pages' `<script src>` edges, which bind no name, so the gap is the count being taken
where the question is asked rather than a population going missing.

**A seventh, and the skipped object was a value one line of every planted look sets to
zero.** `registry-check`'s two-surface section holds one claim — a fragment at exactly zero
alpha must not write depth on the hard-edged path — and it was built for the glyph margins,
which is one of the three ways a fragment gets there. The other two are older than the glyph
field: a point born this frame carries `vFade` of exactly 0 while its sprite rasterises, and
the disc's falloff reaches 0 at exactly `r2 == 0.25`. Neither could reach any arm in that
file, and the reason is a single key. Every planted look there carries `fade: 0`, which sends
the vertex stage down the `fadeTime > 0.0 ? … : 1.0` branch and makes the crossfade the
constant 1 — so no planted point in the file is ever at zero alpha for any reason except a
character's margin, and the section built to hold the class held exactly the instance it was
written for. `fade: 0` is in those looks for a good reason, which is the shape this page keeps
arriving at: an exclusion with a justification stops anybody looking twice.

The measurement is what settled it rather than the reading. A discard-only A/B against the
shipped looks — the widened condition served by route interception, everything else identical,
over the fifteen pinned program positions — moves contour, depth, ghost and rgb by 847, 915,
931 and 901 pixels and leaves all six additive documents byte-identical, and splitting the
condition apart attributes 835/903/919/889 of those to births and 12 apiece to the rim, which
sum to the whole on every arm. So the class is three, the section covered one, and the two it
missed are 100% of the pixels the repair moves.

**Closing it needed a fixture the section's own idiom cannot build**, and that is the part
worth keeping. `field()` injects a depth grid straight into the texture and writes
`sinceFrameSec` by hand, and the crossfade reads `st.g + sinceFrameSec` — so with the surface
memory cleared every point in the frame carries the same age, and a fade window blanks the
whole cloud or none of it. There is no setting of that helper in which one surface is faded in
and another is not. The pinned drive has the per-texel age instead, because the memory zeroes
`.g` on a swap and adds the gap to it otherwise: three synthetic frames, the far surface twice
and then both surfaces, stepped to the second frame's own time. The near texels were born on
the last step and sit at age 0; the far ones never swapped and sit at the gap. The near cloud
is then invisible and the claim is byte-identity over the whole frame with no threshold in it.
`--mutate margins-confined-to-glyphs` reddens that row alone at 365 of 184184 while every row
of the character section stays green, which is the section's own coverage stated as a control.

**What is still not held is the rim, and it is not held because it cannot be planted.**
Whether a rasterised sprite lands a sample on `r2 == 0.25` at all depends on its fractional
size, so the condition is real — 12 pixels per shipped look over the fifteen positions, at
nine of them — and there is no camera or cell size that produces it on demand.
`--mutate margins-miss-the-newborn` is the control for a repair written from that end, and
what refuses it is section 1b rather than a planted arm: that section renders this build
against one with no zero-alpha discard at all, and a condition reaching the rim alone moves
five of its six frames by 3 to 12 bytes of 921600. **A claim can be held by the comparison
that spans the change rather than by a fixture**, and saying which one holds it is the
difference between a covered claim and a claim somebody assumes is covered.

**One number on this page was wrong and is corrected rather than replaced.**
`glyph-ignored`'s entry read that its two-surface claim row goes red at 17 pixels of 9922
because "with no character anywhere what is left writing depth at exactly zero alpha is the
disc's own rim". The rim is discarded outright on this build and the row still reads 17 of
9922, to the pixel — so the attribution was a reading rather than a measurement. What those
pixels are is bloom spreading the near cloud's own light past the pixels it drew on, which
that comparison excludes by drawn pixel and not by halo.

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

### A class closed over the rows that were red, with the green ones exempted by the diagnosis

`export-check` compares one look through two builds in five places, and the episode that
produced `sameChain` — two builds silently running different post chains, reported for as long
as those rows existed as a luminance ratio — put the guard on three of them. The two it skipped
are the `rebase-full` pair, and the reason they were skipped is written down in
`docs/proof-tools.md`: they spread nothing, so Blackwall's own `rgbsplit.amount`, `raster.amount` and
`grain.amount` survive on both sides and both builds run the grade, which is why they stayed green
while the other three went red. The commit that landed all this then claimed in prose that
**every** cross-build row required a matching chain. It was three of five.

The exemption is the investigation's own conclusion used as the next investigation's
precondition. "Both builds run the grade" is a true statement about the pair of builds this row
spans today; whether a pass runs is derived from a *set* of parameter names, and the defect the
guard exists for is a future build changing that set. So the exempted rows are exactly the rows
that would go on reporting a chain divergence as a ratio — the failure the guard was written
after an hour of chasing.

**The thing worth taking is where the exemption was.** It was on the two rows that were passing.
A red row gets an explanation and the explanation gets read; a green row gets one sentence in a
document and nothing ever looks at it again, because nothing is drawing attention to it until
the build it was wrong about arrives. An external reviewer found this, on a diff that had been
read by the author and by a panel, and what it had to notice was not a defect in the code but a
gap between a list of three call sites and the word "every" one paragraph away.

Underneath all five sat a second hole with the shape this file records most often. `chainOf`
reads `arm.passes ?? []` and joins, so an arm off a page that stopped publishing its composer
answers `''` — and `'' === ''` is a match, so a failed readback passed as agreement and would
have kept passing. The first repair put a non-empty requirement inside `sameChain` and claimed
in its comment that this closed the class; it does not, because a row that reads `chainOf`
directly never calls the predicate and inherits the hole untouched. **The failure belongs to
the readback, so the guard belongs there**: `armAt` is the one funnel every arm in the file goes
through, it now records each arm under its label, and a row near the foot asks the whole
population whether every arm published the chain it rendered through. That one names the arm
that came back silent, fires whether the silence was ever compared or not, and asserts the
population size beside it — because a row over a list is a row that passes on an empty list, and
this same file already shipped one of those. The narrower term stayed in `sameChain` to stop a
*comparison* being believed on two silences. The floor is a chain of at least one name, and no
correct build can trip over it: `RenderPass` and `OutputPass` are added in `web/post-chain.js`
and neither is ever disabled — only the afterimage, the bloom and the grade are.

**The control is a probe, and the mutation that was supposed to replace it was built, run and
thrown away.** A control for the chain term has to diverge the two builds' chains without moving
the picture, or the row it reddens cannot say which of its terms did the work. The candidate was
`trail-gate-admits-zero`: the trail's gate is `damp > 0`, so admitting zero puts
`AfterimagePass:on` in this build's chain and nowhere in the pinned build's, and three's
`AfterimageShader` is `max(texelNew, texelOld * damp * when_gt(texelOld, 0.1))`, which at a damp
of zero is `max(new, 0)` — the pass returning its input. The shader source was read rather than
recalled, and the algebra is right.

It was still wrong. Measured, the chain half worked exactly as designed —
`RenderPass+AfterimagePass+OutputPass` against `RenderPass+OutputPass` on the three arms whose
trail is zero — and the worst of forty tile means went from 0.602, 0.070 and 0.071 of 255 to
**42.502, 22.141 and 27.607**, at a luminance ratio of 1.64. An enabled pass is another
ping-pong through the composer's render targets whatever its shader computes, so an identity
shader is not a free pass, and each of those rows then failed on the tolerances as well as on the
chain: a mutation caught twice over, which proves nothing about either catcher. **The
generalisation is the useful part — no product edit can diverge the chain and leave the pixels,
because the divergence is a pass appearing or disappearing and the composer charges for the pass
rather than for what it computes.** So this is a claim whose falsification cannot be a source
mutation, and saying that is better than shipping a mutation that reddens the right rows for the
wrong reason.

The probes are the control. Filtering `ShaderPass` out of the old build's full arm gives 48 of
50, failing exactly the two whole-look rows and no others, **with the luminance ratio at 1.00883
and the worst tile at 0.410/255, unchanged from the clean run to five figures.** That is the
reading that justifies the whole repair — the pixel tolerances see a chain divergence as nothing
at all, so on those rows `sameChain` is not a second opinion, it is the only one. A second probe
emptying every arm's pass list gives 45 of 50, failing exactly the five cross-build rows, which
is the vacuity the population row now catches at its source. Both are recorded here with their
numbers because that is the whole of what stands behind those rows.

### And the same guard then normalised away the one difference that mattered

`sameChain` shipped with an exemption written into `chainOf`: a leading `Unreal` was
stripped off a pass name, so `UnrealBloomPass` and `BloomPass` compared equal. The reasoning
in the comment was that the change was a rename inside the range the cross-build arms span
and the pass was the same pass. It was a rename in the source and a **replacement in the
picture** — `124a90b` put our down-and-up chain where three's Gaussian-per-mip one had been —
and the two do not deliver the same light. So the one guard written to say "these two arms
are not comparable" was the guard taught to say they were, on the same two rows the section
above had just finished exempting for a different reason.

The rows went red at that commit and stayed red for fifteen days, reporting a luminance
ratio and nothing else. Measured 2026-08-24, this file's `export-check` at consecutive
revisions on one machine with one capture: `124a90b^` reads **0.99312 and 0.99403** and
passes, `124a90b` reads **0.40978 and 0.40931** with worst tiles of 45.923 and 45.962 and
fails, and the same numbers come back unchanged to five figures at `ad7c806`, `6ad2433` and
at the tip. Isolated at a single 960x600 buffer so resolution is out of the comparison: at
`bloom` 0.5 the mean luminance is 7.1614 here against 17.3797 there, ratio 0.41205; at
`bloom` 0 it is 5.0925 against 5.0581, ratio 1.00679 and a worst tile of 0.337. One term
carried all of it.

**Three things worth keeping.** The first is the shape: an instrument may exempt a term from
a comparison, but it may not exempt a term from a *predicate whose job is to notice the
term*. Normalising two names together is the same move as widening a band until a row
passes, and it is harder to see because it reads as tidying. The prefix is compared like
every other part of a name now, and the arms that have to span the swap take bloom out of
the look instead — so a future pass swap fails the row with both names printed rather than
arriving as a ratio.

The second is that a term taken out of a comparison has to **leave a number behind**. The two
rows render the same scene a second time with the glow up and print that ratio in their own
message whether they pass or fail, because this file's most expensive habit is an object
every observation skips and a comment is not an observation. The judged rows now read 1.00475
and 1.00378 at worst tiles of 0.219 and 0.244, and the printed glow pair reads 0.40978 and
45.923 beside them.

The third is what the exclusion did **not** cost, checked rather than argued.
`bloom-buffer-sized` reddens the sweep's own `bloom` and `full` rows — 2 assertions, coarse
means 6.651 and 6.498 against 1.6 and 2.6 — so the reference the chain is frozen at keeps its
catcher and never depended on this pair. `pointsize-absolute` still reddens the 1920x1200 row
with bloom off, at ratio 0.88296 and a worst tile of 5.435 against bands of 0.02 and 2.0,
and still leaves the 1728x1080 row green where the scale factor is exactly 1, which is the
asymmetry those two arms exist for. `bloom-reference-1080` is uncaught before and after, at
51 of 51, which is what this page already says of it.

**Two records here disagree with all of that and are left standing rather than edited.**
`docs/performance.md` credits the replacement with turning these two rows green, and the
probe note above this one quotes a clean run at ratio 1.00883 and worst tile 0.410 on
2026-08-12. Neither reproduces: `6ad2433` measures 0.40978 and 45.923 like every other
revision after the swap. The A/B that dates the flip is two consecutive commits minutes
apart on one machine, so the direction is not in doubt whatever those numbers were taken on —
but the disagreement is a fact about this repository's records and belongs on the page rather
than in a commit message.

**And a fourth, found on 2026-08-24 when somebody finally asked what the one term was.** It
was three terms, one of which is a bug rather than arithmetic: `BloomPass` never dropped
`renderer.autoClear`, so its additive up chain drew onto targets the renderer wiped between
draws and four of the halo's five octaves were thrown away every frame. **Nothing in this
suite could see it, and the reason is a class rather than an oversight.** Every arm that
touches bloom compares two renders and judges a *ratio* — 960x600 against 1920x1200, this
tree against a pinned revision, one mutation against none — and a chain missing four octaves
draws a halo of the right width in the right places at one fifth the brightness, so it
divides out of every one of them. `bloom-buffer-sized` still caught its mutation, the two
rebase rows were already exempt, and `registry-check`'s section 1b runs at `bloom` 0. **Ask
of any quantity a suite only ever compares whether anything measures it, and not only whether
something moves with it.**

What now holds it is `test/bloom-chain.test.mjs`, which had the cheap half of this already
and gains three rows: the weight set sums to 3.0 at every radius and comes out
`[0.44, 0.52, 0.60, 0.68, 0.76]` at the graded 0.7, the per-step ratios telescope back into
`3.0 * strength * sum(w * octave)`, and **the pass drops `autoClear` and hands it back**. That
last one needs no GPU, which is the point: the pass reaches for exactly five things on a
renderer — the bound target, `autoClear`, `setRenderTarget`, `clear` and `render` — so a
five-property stub records the discipline and reads the uniform the pass has just bound, which
is what stops the two arithmetic rows being a formula the test believes rather than the one
the pass performs. Its falsification control is a renderer whose `autoClear` will not go down,
which puts every draw in exactly the position `124a90b` left them in.

Mutation-tested rather than reasoned about, seven of seven caught and each read for the
assertion that fired: `autoClear` never dropped, never handed back, the up chain unweighted,
the blend without its gain, `BLOOM_COMPAT_GAIN` at 1.0, the weights flattened to one and the
factor set reversed. The first four and the sixth land on the `autoClear` row, the seventh on
the weight-set row, and the fifth reddens three. The baseline was re-run after each and comes
back 9 of 9.

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
`catch`**: the recorder's apply wrote `ui.recLookNote` deliberately, since
`showTimelineError` targets a strip that surface does not show, so a shared catch in the
wrapper would have moved that sentence somewhere nobody can see it. Past tense on that one
door: the record view gained tabs on 2026-08-05 and the recorder's apply went with them,
taking its note. The guard, `applyStoredPreset` and the editor's doors onto `appliedPreset`
are all still here, so the argument holds and one of the doors it was made about does not.

**The same guard stranded the caret its comment said it preserved**, which is the smaller
half and the one a row can hold. `pickPresetSubset` hands focus to the control that opened
the dialog on the `close` event and resolves in the same breath, so the button is holding
the caret when the write span disables that same button a microtask later — which blurs it
onto the body, and re-enabling does not undo that. The comment argued that the narrow span
avoided exactly this, and the ordering made it false. Measuring it needs the driver
changed as well: a programmatic `element.click()` leaves the caret on the body, where a
build that stranded it and a build that never had it read identically, so `openPicker`
focuses before it clicks.

**`waitUntil: 'load'` stopped meaning the page is up when the effect packages moved onto the
wire.** Boot fetches them over HTTP now, so `globalThis.__kinect` publishes *after* the event
`page.goto` waits for — measured at 366ms to `load` against 398ms to the handle, on loopback with
a warm page cache. Every driver that reaches straight through that handle on the line after a
`goto` is a race from that commit onward, and it does not arrive looking like one: a predicate
raising `TypeError: Cannot read properties of undefined` inside `waitFor` is not caught by it, so
the twenty seconds the wait was given are never spent. `monitor-check`'s colour precondition did
exactly that — it reddened saying no colour ever bound, against a build whose colour binds 451ms
after the same `goto`, and skipped the viewer row beneath it as unmeasurable. **A red that
arrives instantly out of a wait that was given seconds is a throw rather than a timeout**, and
the timestamp on the line is the cheapest thing that tells those apart; here the failed row and
the section heading above it carry the same second. The repair is a guarded read that leaves the
timeout reachable and reports "the page never published `__kinect`" apart from "colour never
arrived", because those are different findings. What it is *not* is a fixed `wait()` after the
`goto` — the two sections above it in the same tool survived on one until the entry below, which
is the silent-pass shape their own comments refuse, and a sleep tuned on this machine is a pass
waiting for a slower one.

**Then those two sleeps were measured, and the measurement is the entry: a sleep sixty-five
times longer than what it waits for and a sleep a tenth as long read exactly the same on the
machine doing the measuring.** `monitor-check` drove the recorder from three places and only
the third had the guard, so the repair was one wait — `published`, beside `waitFor` in that
file — which all three call after their own `goto` and which each hands the expression its
own section reaches through. What the sleeps had been covering, printed by the wait itself
rather than assumed: 15 to 18ms from `load` to the handle, where one section waited 1200, and
92 to 94ms to the first depth frame, where the next waited 2000. Six runs, two clean and four
mutated, on an idle Mac over loopback with a warm page cache and a warm capture sidecar. Both
margins were real and nothing was reading either, which is the failure rather than a detail
beside it: the tool passed all 91 rows with the race in it, and would have gone on passing
until a contended machine turned a margin negative and reddened a decimation row about a
viewer that had not finished booting.

**Then a run came in at 1050ms and the margin was 150ms — and the cause is a cold start rather
than a busy machine, which took a replication to establish.** The entry above closes by saying
nobody had produced a run where the old sleep would have failed. One turned up: the first
`monitor-check` of a session printed **1050ms to the handle, 235ms to the first depth frame and
62ms to the colour uniform**, against the sleeps of 1200 and 2000 the repair replaced. So the
first section cleared its old fixed wait by about 150ms.

**The obvious explanation was wrong and was written down here before it was checked.** Six
agents were working the repo at the time and this page briefly said the figure was a margin
measured under load. Replicated deliberately at loadavg 6.24 and 5.84 with 27 to 31 processes
alive, the first wait came back at **16ms and 18ms** — inside the idle band. Contention at that
level does not move this number, so the six agents were not the cause. What distinguishes the
slow run is that it was the session's first: cold Chromium launch, cold page cache over a 139MB
capture, cold module cache. n=4 with the cold run discarded by the usual convention leaves n=1
for the cold figure, the comparison is sequential rather than interleaved, and all four runs
carried the health number at 91 assertions and 0 failed.

**Which is a better argument for the repair than the one it replaced**, because a cold first run
is a condition anybody can reproduce and a machine that happened to be busy is not. The residual
is that a proper cold-versus-warm A/B needs a quiet machine and a dropped page cache; the number
above is the observation that prompted it, not that experiment. **The cause of a number is part
of the number** — this one was one replication away from being filed under the wrong mechanism,
and the replication was run by the person who took the reading rather than the one who wanted it
to mean something.

**The second sleep was covering something a boot probe would not have found**, and that is
the half worth carrying to the next tool. That section drives the real divisor control, and
`sendMonitor` in `web/main.js` returns without sending unless the socket is `OPEN` — so a
page that has published `__kinect` and not yet connected takes the drag, sends nothing, and
the ÷4 arm becomes a second ÷1 arm read under a ÷4 label, which is the misattribution the
whole negotiation exists to prevent. A wait on the handle alone is green for that. What it
waits for instead is a depth texel that is no longer zero: `createTextures` in
`web/gpu-textures.js` builds both depth textures zero-filled deliberately, so that every
point leaves at the empty-sample test until a real frame binds — which means that on a page
nobody has injected into, the only thing that can write a non-zero texel is a frame off that
socket, and one clause settles the handle, the socket and the stream together. **Ask a
readiness wait what its own section reaches, never what publishes first**: the earliest thing
that happens to be there is a probe whose answer cannot differ from the next probe's.

**A readiness wait earns a falsification control like anything else on this page, and it is
cheap** — point one at a name that never publishes and read what the run says. The two
sections whose subject is decimation let the timeout out, so that control ends at 53
assertions with **none failed** and `DID NOT RUN` naming what never arrived, which is the
answer that matters under `--mutate`: a red row there would have been counted as the mutation
being caught. The colour section catches it onto its own row instead, for the reason above,
and its control reddens exactly that row, leaves the respawn rows green and skips the viewer
row beneath it. Both were run against the repaired tool, because a wait nobody has watched
time out is a wait nobody has tested.

**And the same publish race has a second door, where the guard is vacuous rather than
absent.** `library-check` waited on
`globalThis.__kinect?.timeline?.transport() !== null` after opening the editor. Read it
against a page that has not published the handle: the optional chain answers `undefined`, and
`undefined !== null` is **true**, so the wait resolves on its first tick having proved nothing
and the unguarded read on the next line throws `Cannot read properties of undefined (reading
'timeline')`. It was harmless for exactly as long as `load` meant the page was up. Measured
when it bit: the run ended at 234 assertions with the section's own rows unasked, on a machine
that had just finished two other proof tools, and `Boolean(...)` in place of the comparison
took the same tool to 495 with none failed. Three waits in that file were written the same way
and all three moved together.

`editor-check` had the absent-guard form of it at one of its three reloads, and the two
neighbours are what said so: the other two wait for `!!globalThis.__kinect` and *then* for the
transport, and the third went straight at the transport. It died at 475 of 545 assertions,
taking sections 16 through 22 with it, and printed `DID NOT RUN` — the honest verdict, and an
expensive one, since the run before it had cost twenty minutes.

**The general shape is worth more than either instance: a guard written with `?.` and compared
against `null` is not a guard.** `?.` short-circuits to `undefined`, and every comparison
except `== null` and `!= null` treats that as a value like any other — so the operator that
looks like it is protecting the read is the operator that makes the predicate pass before the
thing exists. Ask of any wait whether its predicate is *false* on a page that has not booted;
if it is true, the timeout is unreachable and the wait is a comment.

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
from. The fix is a second library page in the same section, served by a station whose captures
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

Three more arrived together in a full replay run. `timeline-check` targeted 12 seconds
while its documented default opened the 9.43-second sample. The transport clamped correctly
and the rain-clock row alone failed at 9.43 against 12, which read as a product defect. It now
refuses a take shorter than `NEEDS_TAKE_SEC` before it opens Chromium, and the documented run
names `fixture-1g`.

That refusal also closed the door on `sweep-all` before it could enumerate timeline mutations:
enumeration was a child run too, and still inherited `sample`. Take selection now belongs to the
common child-command path, so enumeration and the mutation it names cannot use different
fixtures. With that path disabled, the focused sweep stopped before its first assertion. With it
enabled, `preroll-constant` ran on `fixture-1g` and reddened 13 rows.

`keyframe-check` compared the transport's source-frame bracket at the page's computed source
time against a bracket computed at the tool's source time. Those times agreed to 1.1ns, but one
probe sat exactly on a capture stamp and the rounding put the two readings on opposite sides of
it. The source-time row already holds the mapping. The bracket row now feeds the page's exact
source time through an independent walk of the capture index, so it asks only whether the
transport chose the indexed pair for the value it used. A temporary off-by-one mutation still
reddened both bracket rows at 25 of 25, plus two downstream refusals.

The trails control in the same tool had the other fixture failure: the wrong closed-form
pre-roll differed from playback by only 3/255 over 0.021% of pixels under Blackwall, below the
control's own 16/255 floor. Lowering the floor would have calibrated the row to the failure.
The same frame under the shipped RGB look differs by 71/255 over 0.336%, while the correct
window remains byte-identical. `trails-damp-at-target` then reddens exactly the two claim rows.
**A fixture includes the look as well as the take**; a correct arithmetic difference is not a
falsification control until the picture makes that difference observable.

## A probe placed where both builds answer the same thing

Four instruments written for the crop box in one session were each aimed somewhere the
correct build and the broken one would have agreed. All four were caught by running the
mutation rather than by reading the code, which is the argument for the rule that a proof
tool is mutation-tested rather than reasoned about.

**A sort whose subject is already sorted.** The shader assembler places each stage's chunks by
the `order` their manifests declare, and `test/shader-assembly.test.mjs` held the assembled
programs byte for byte against the monolith — so taking `stages.sort(byOrder)` out of the
assembler entirely ought to redden it. It does not. The packages are read in directory order and
every shipped stage's declared order *is* that order: glitch before lattice on `v.displace`,
glyph before rain on both declaration stages and on `f.tone`, noise before push before ripple on
`v.regionDisplace`. Six stages, six coincidences, and each arrived honestly, because a package is
named after its effect and the effects were written roughly in the order they run. A build that
lost the sort would draw today's picture exactly and a different one the first time somebody adds
a package whose name sorts the wrong way, which is a defect that ships and then waits.

This was found by running the mutation and then obeying the rule about a mutation that seems to
have been missed: the count of caught defects was 13 of 14, and the fourteenth turned out to have
changed no byte of either program. What holds it now is a fixture rather than the shipped set,
because the property under test is that the *numbers* decide and the shipped numbers agree with
the alphabet: two synthetic packages named against their orders — the one that goes first called
`zeta`, the one that goes second `alpha` — with the same inversion put through a service's
`gateOrder`. The gate's half is live on the shipped set as well, since the region's push consumes
at 100 where its noise consumes at 200; the stage's half exists only in the fixture, and saying so
is the point.

**And the fixture became the only thing holding it when the byte-for-byte arm was retired**, which
is worth writing down because the reason generalises past this one rule. That arm compared against
a string the assembler did not produce, so it could see a rule the assembler had *stopped applying*.
Its neighbour, the flip control, cannot: it assembles the tree, perturbs one chunk, assembles again
and compares the two, and a rule dropped from the assembler is dropped from both sides of that
comparison. Measured at the retirement rather than argued — taking `stages.sort(byOrder)` out again
leaves the flip control green and reddens the fixture arm alone, with the message naming the arrival
order. **A differential arm reads what a change did; only an external reference reads what the code
no longer does.** So when a historical reference is dropped, the question to ask of every arm left
standing is which of the two it is, and any rule that had only the reference holding it needs a
fixture built for it before the reference goes.

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

## A comparison that only ever ran at the defaults

`registry-check`'s cross-build section renders both revisions at parameter defaults and hashes
the frames. Every default in the glitch block was chosen to be the literal the one-slider
version baked, and three separate comments said so — one of them as a universal, "Every default
is exactly the literal it replaced", sitting directly above an enumeration of *four* numbers
where there are five parameters. `glitch.tint` was the fifth, and it is 1.8 where the old line
baked 3.0.

Nothing caught it for the plainest possible reason: **`glitch.amount` defaults to 0, so the block never
executed on either arm.** The one shipped look that switches it on, `blackwall.json` at
`glitch.amount: 0.18`, was never rendered by the comparison that exists to protect it. The claim and
the instrument were arranged so that the claim's only counterexample was outside what the
instrument looked at.

It came out by adding `glitch.amount: 0.18` to both arms and getting 6 of 6 frames differing, then
bisecting: at `glitch.tint: 0` the colour, depth and contour readings come back byte for byte
identical, which proves `pos.x += shove` — the block's geometry — really is bit-exact, and the
four defended terms really do hold. The flare alone moved. Measured against the pinned build on
`readBlackwall`, 1.8 lands 30 of 255 off at worst against 3.0's 5, so the compensating default
is six times further from the look it was chosen to preserve than simply keeping the literal
would have been.

Two lessons, and the second is the one that generalises:

- **A default justified as "exactly the literal it replaced" is a claim, and a claim needs an
  arm.** Five parameters, four enumerated, and the missing one was the wrong one — which is
  `CLAUDE.md` rule 5 arriving through arithmetic rather than through a deliberate exclusion.
- **A cross-build comparison rendered at defaults tests the build nobody ships.** The values a
  shipped preset names are exactly the ones a drift would reach first, and exactly the ones a
  defaults-only arm cannot see. The raster arm above it already stands at the shipped
  `raster.amount: 0.35` for this reason; the glitch had no such arm because nobody had asked what
  the shipped document turns on. **Ask what the shipped look names, and render there.**

### The same shape one level up: the difference between two registries was a parameter at its default

`effect-check`'s section 6 holds a page that refused an install to the state it was in before
it: the registry it had, the signature it had, the pool it was holding, and the three pinned
positions rendering the images they rendered. The pixel rows are the ones that read like proof,
and they are the ones that cannot see the defect. `rollback-keeps-the-new-registry` — the
rollback that reloads the document and reloads it against the packages that just arrived — leaves
the page assembled from the fork, and the fork differs from what it forks by exactly one added
parameter, which is inert at its default because the door refuses a master that is not. So the
program has a chunk more in it, and the chunk draws nothing, and the three hashes are identical
on both builds.

What separates them is the registry's own contents, the signature, and what a save writes — the
last of those because the serialiser drops a parked key the moment its prefix reads installed, so
a page holding the new registry writes a document with the parked work missing from it. Three
rows about bookkeeping catch what three rows about pixels cannot, which inverts this repo's usual
order and is worth remembering as an order rather than a rule: **a pixel is the right probe for a
value, and the wrong one for which set of parameters exists**, because the parameters that
distinguish two sets are exactly the ones a well-behaved package leaves at zero.

The section's own control had the same defect one layer down and was found by running it rather
than by reading it. It was written as section 4's row — the three positions render three
different images — and it went red on a correct build. With the effect parked there is nothing
keyed left to separate the positions: the pinned run is six frames at 33ms, so 0.6s and 1.2s
both show the last of them. Section 4's three images differ because `probe.amount` is ramping
across them, which is a fact about section 4's state and not about the reading. The control that
means something here is a cross-state one — the parked hashes against the hashes the same
positions gave while the effect was installed and raised.

## A number written into a document does not fail

The nine shipped looks each named a different subset of the look values, so picking one
after another left the previous look's terms standing — `voxel` was the only document
naming `lattice.amount`, and picking `ember` next drew amber over a lattice nobody had asked for.
That was reported as a bug and it is one.

**It had already been measured.** The README beside those files carried the sentence "all
four render a different frame in the sequence from the frame they render alone", with four
pairs of frame hashes to prove it, taken at 22.000s of `2026-08-07-take2`. The measurement
was correct, it was current, and it sat two paragraphs above a note explaining why the
files ship this way anyway. Nothing failed, because nothing was asking.

The whole gap is the difference between a proof tool and a paragraph. The suite had arms
for what a preset *is* — that the reading weights are all or none, that a partial document
may not stamp the clip, that saving over a shipped name forks it — and no arm at all for
what happens when you apply two of them in a row, which is the only thing a picker of looks
is for. The hashes went into prose instead of into a check, and prose has no exit code.

Re-measured across every ordered pair rather than the four that had been sampled, it was 33
of 72 contaminated, not 4 — so even the recorded number understated it, which is the second
half of the same failure: a measurement nobody has to keep passing is also a measurement
nobody re-runs at the width the claim actually needs.

- **When a measurement shows a defect, the output is an arm, not a sentence.** Writing the
  finding down beside the thing that has it feels like disclosure and reads, six weeks later,
  as a decision somebody made on purpose. If it is genuinely intended, the arm asserts the
  intended behaviour and the next person arguing with it has to break a check rather than
  win an argument with a comment.
- **Ask what a surface is for, and check that, not only what its documents are.** Every
  existing preset arm asked about one document in isolation. The property a user has is a
  sequence of presses.

### A ratio read linearly through a grade that is not linear, and the headroom that leaves

The glyph field's energy compensation darkens exactly one shipped look — `voxel` — and the
re-grade that buys it back was done the way the section above says: search the value, read it out
of the registry with the look on screen, do not type it. **The narrow claim is true and the
obvious reason for it is false**, which is worth separating before the case file starts. `voxel`
is not the only document that raises `lattice.amount`: `cascade` ships it at 1.0 against `voxel`'s 0.55
and the correction never reaches it, because the factor is exactly 1 wherever the sprite already
covers the cell, and full `glyph.amount` is what makes it that size. What the compensation acts on is a
lattice underneath a sprite *smaller* than its cell, and of the ten documents only `voxel` is in
that state — 0.55 with `glyph.amount` 0 and a `pointSize` of 6.5 against a 3.5cm cell. What is worth a
case file is the number the search would have been given if anybody had worked it out on paper
instead.

Measured over 15 pinned program positions of `captures/sample.knct` running 0 to 0.9933s, drawn
into a 572x322 buffer inside a 640x360 viewport at device scale 1, the compensation takes
`voxel`'s mean channel from 12.685 to 2.023, a darkening ratio of **0.1595** against the 0.2025
the factor `(1 - 0.55)²` predicts. Read that
ratio linearly and the exposure that undoes it is 1.15 / 0.1595 = **7.21, which is outside the
parameter's own 0.05 to 6.0 range** — so the paper answer is that the look cannot be recovered
at all. The search says otherwise: sweeping 43 candidates from 0.05 to 6.00 and minimising mean
absolute deviation per RGB channel over 0-255, against 15 pre-implementation reference frames
taken at those same positions, lands on an interior minimum at **5.65**, at a MAD of 0.2559
against 10.6625 for the unchanged document, a factor of 41.7, with
the worst channel down from 138/255 to 51/255.

The two disagree because the grade between exposure and the pixel is not a multiply. **4.91x of
exposure buys 6.36x of output mean**, and the gain is in the crush toe and the Reinhard curve:
lifting a picture whose faint half sits under the toe brings fragments back over it, so raising
exposure adds coverage as well as brightness. Any prediction that treats an exposure as a scalar
on the output is wrong in that direction, and it is wrong by enough here to have argued a correct
implementation out of the tree.

**Two things to carry forward, and the second is the one with a date on it.** A MAD minimum is a
match of means and not of pixels — the restored look reads mean channel 12.870 against the
reference's 12.685 and 21.36% lit against 21.18%, because the compensation redistributes energy
inside the frame rather than scaling it, so nothing downstream should ever assert `voxel`
byte-identical to a pre-compensation render. And `voxel` now sits at 5.65 of a maximum of 6.0,
which is **0.35 of headroom**: the next change that darkens this look cannot be bought back with
exposure, and will need either a wider parameter or a different answer. That is a sentence worth
finding before the change rather than after it.

## A pointer check that walked one kind of pointer and never noticed the other

`syntax-check` had a block whose comment said the disclosure chain is load-bearing and nothing
was checking it, and it closed exactly the pointers it was written for: every `docs/*.md` path
cited from `CLAUDE.md` or from `tools/`, resolved against the tree. It was right about the
class it named and blind to the neighbour in the same sentence. The documents and the tools
cite **modules** far more often than they cite each other — thirty `web/….js` paths against six
`docs/` ones — and none of those was being asked anything at all.

Nothing was wrong until the browser bundle split. Then `web/main.js` went from 15,449 lines to
13,206 with twelve modules beside it, and **fourteen** citations were left naming the bundle for
code that had been carried out of it. Eight of them are one sentence copied around the suite —
the unprojection's mirror correction, which is in `web/cloud-shader.js` and which
`web/library.js`, `export-check` twice, `registry-check`, `monitor-check` twice, `level-check`
and `server/protocol.js` all sent a reader to the bundle for. The rest are `CROP_LIMIT`, which was
declared in `web/point-cloud.js` then (it is in `web/crop-box.js` now) while the prose told a
reader to raise it in the bundle,
`setNavigationUp` in `web/scene.js`, the boot uniform block in `web/point-cloud.js` with two
tools still naming the bundle for it, the GLSL one lexer's ambiguity is argued from, and the
`readGhost` comment this suite quotes. Every one of those paths still resolves, which is the
second lesson below.

Four more claims went with them without naming a wrong file at all — a mutation table described
as "most live in `web/main.js`" when nine of its twenty-two do, a paragraph saying every entry in
another table names the bundle, a header calling it fifteen thousand lines, and a mutation
recorded as unbuildable because its anchor matched twice, which a re-anchoring in `c757210` fixed
without the note above it hearing about it. **A count is a citation of a file's contents**, and it
rots on the same edit as a path does with nothing to resolve it against.

**The audit that found the first five could not have found the other eight, and the reason is
worth copying.** It was a script: for every citation, take the backticked identifiers within two
lines and ask whether each is declared in a *different* `web/` module. That reaches a citation
whose subject is a **name** and is blind to one whose subject is a **phrase** — "the uniform
block", "twelve hundred lines of GLSL", "most of these live here" — and blind again to a name
written without backticks, which is how three copies of one sentence about `unproject` survived
the first pass. What closed it was enumerating every mention of the bundle in prose and comments,
about thirty-five sites, and reading the sentence at each. **A heuristic over a citation's
neighbours is a way to rank the reading, not a way to skip it.**

**The enumeration and the question are set separately, and widening one is not widening the
other.** This document already carries that rule from `library-check`'s grid scan, where the
walk stayed wide and the question narrowed to the JavaScript; here it arrives as two decisions
made in the same block. The **citing** set had to widen from two files to every prose page and
every source file this repo ships, because the documents cite each other and the modules cite
each other and a scan reading only the two files that point at `docs/` saw four of the thirty.
The **question** had to narrow at the same time: a path in a string is data and a path in a
comment is a citation, which is the mirror of the rule `numbersIn` already applies when it
refuses to read a declaration out of a debug message. Dropping the strings loses the `file:`
target of a mutation table and the `module:` of `module-check`'s exemption table, and both of
those are answered better elsewhere — the anchor row fails a mutation anchoring into a file that
is not there, and `module-check` audits its own table for an entry naming a module that is gone.

**The exclusion is load-bearing and was measured rather than argued.** Taken out, the row goes
red on a clean tree with seven paths: six are the fixture paths `library-check` builds its probe
tree out of, which are relative to a temporary root and name nothing in any checkout, and the
seventh is the module name this check's own mutation table plants for being absent. A row
falsified by its own controls on every clean run is the failure this whole document is about,
arriving from the direction where the instrument is the subject.

**And the bound has to be said out loud, because the check is weaker than it reads.** A citation
is checked for resolving and never for being *right*. All fourteen of the stale ones above name a
file that exists, so the tool that now guards this class would not have caught a single one of
them — they were found by reading, and the arm that exists after them is for the next split
rather than for this one. The line form is the same bound one step in: a citation past the end
of the file fails, and a line that has drifted into the middle of something else does not.
`server/capture.js` had already reached the only answer that works and wrote it down —
`handleFrame` is cited by name because the line it used to name had drifted nine hundred lines
into the middle of a shader with nothing failing. **Cite a function, not a line**, and read the
sentence around a citation rather than trusting that the path resolved.

## A mirroring assertion on a surface where the painter never runs

The panel's collapsed dock repeats two of the recorder's controls, and it repeats them by
pressing them rather than by re-deriving what they do — `paintRecord` writes `#recGo` and
then writes `#dockRec` from it, in one place, so the two cannot drift. The obvious way to
enforce that is to read them against each other: same `disabled`, same `title`, same text,
same `aria-pressed`. Three rows of `editor-check` section 21 did exactly that and all three
passed on the first run.

They were comparing nothing. `paintRecord` is called by the recorder's poll, and
`askRecordState` is assigned only on the live branch of the boot block — the comment above it
says an editor has no recorder to ask about. So on the editor surface the mirroring code
**never executes once**, both buttons sit at whatever their markup gave them, and the
comparison is `record` against `record`, `""` against `""`, `null` against `null`. Deleting
the paint entirely would not have moved a single one of those rows.

What gave it away was a detail printed beside a passing row rather than a failing one:
`pressed null/null`. `paintRecord` sets `aria-pressed` on both, so neither being *absent* is
only possible if the function has not run. A row that passes while reporting a value the
build under test should make impossible is worth more than a row that fails.

Two lessons:

- **A mirroring assertion is a claim about a writer, so ask whether the writer ran.** Two
  fields agreeing is evidence of one paint only if a paint happened; otherwise it is evidence
  that two defaults were authored to match, which they were. The falsification question —
  what would a broken build have to do to still pass this — answers itself here: nothing.
  It would have to do nothing at all.
- **The surface is a term in the assertion.** This program draws two surfaces from one
  document, and half of what `main.js` sets up is behind `EDITING`. A row moved from one
  surface to the other keeps its wording and loses its meaning, and the wording is what gets
  read later. The repair was not a better comparison: it was noticing that the two controls
  should not have been on that surface at all, which is what the section asserts now.

The bug underneath was the same shape. The editor hides the entire Record tab, so its panel
offers neither `record` nor `mark` — and the dock, which is that panel collapsed, offered
both, over a `recordState` frozen at the object it was declared as, with the click still
reaching `POST /record/start`. A control with no state behind it, on the surface where nobody
is watching the sensor. `--mutate dock-offers-the-take-on-the-editor` is that bug put back.

## A settled flag that could not see the end of what it was settling

`editor-check` section 9 compares the picture a released orbit leaves against the picture an
accurate seek to the same moment gives. Its control demanded that the signature be able to
tell *two moments of the capture* apart by more than 2 of 255 on the worst of forty tile
means. That row had already gone red once, been diagnosed as "the subject had not moved" and
patched by walking outwards through candidate moments; it went red again at 0.32.

**The control's answer was a property of what happened in the room, not of the build.** No
pair among nine moments spread over a 75.6s fixture reads further than 0.32 apart, and the
widest pair anywhere in the take is 0.19. The seeks all landed — program time exact, every
frame index distinct, the render and frame-fetch counters climbing at each one — and the
pictures genuinely do differ: up to 76/255 on individual pixels, with 0.18–0.26% of pixels
more than 8/255 apart. The subject moved. A mean over a fortieth of the region is a low-pass
filter and averaged it away. Every fixture this repo can build is that capture looped, so no
walk outwards can ever answer it, and a band re-derived to suit today's footage would have
been the same defect with a newer number in it.

The repair was to stop asking one question through two instruments. The **moment** comes off
the transport, which knows it exactly; the **picture** becomes an equality against an accurate
seek to that same moment, which is enforceable because the renderer is bit-deterministic at a
settled program time; and the falsification control becomes a scrub draft of that moment,
which is a property of the renderer rather than of the room and reads 16.46/255 here.

**Chasing the residual is what found the real bug, and the residual was the finding.** The
released picture sat 0.03 from the accurate one where a deterministic renderer owes 0.0000.
It was not the release: two *consecutive* clean seeks to the identical program time disagreed
by the same amount, and the disagreement accumulated with the number of intervening seeks.
`orbitSettling` and `orbitRedrawWanted` both come off OrbitControls' `change` event, which is
raised on a displacement threshold; damping is asymptotic, so below that threshold the camera
goes on creeping and nothing says so. Every `seekNow` then runs `advanceNavigation`, which is
another `controls.update()`, which moves it again — so each seek rendered from a slightly
different pose. Measured at the shipped `dampingFactor` of 0.07: after `settled()` returns,
hand-driving `update(0)` moved the camera 8.376e-4, 7.789e-4 then 7.243e-4 m, a ratio of
0.92993 every step — exactly `1 - dampingFactor` — and it took 356 to 496 further updates to
reach a pose that renders bit-identical twice.

`finishOrbitDrift` is the door this file already had for it, and five gestures already used
it; its own comment says the loop's settle branch "now seeks to a pose that has finished
moving instead of one that is still travelling", which was true of every caller except that
branch. With the call in, `landed` reads 0.0000.

Three lessons, and the second is the one that generalises:

- **A flag named for a state usually names an event.** `settled` meant "the controls stopped
  telling us they were moving". The gap between that and "stopped moving" was invisible
  because it was below the threshold of the thing doing the telling — which is where every
  such gap lives, by construction.
- **Ask whether a control's answer is a property of the build or of the fixture.** A control
  whose value the footage decides cannot fail a build; it can only fail a shoot. The
  repository already knows this shape for looks and sizes, and this is the same thing in the
  time axis.
- **A residual an order of magnitude below the band is worth explaining before the band is
  chosen.** The 0.03 would have been covered by any tolerance anybody picked, and the picking
  is what would have buried it. It was the whole bug.

## A residual that is the instrument, and how to tell it from one that is the build

`keyframe-check` section 1c asserts that easing the camera remaps *when* it arrives and leaves
the route it takes alone. The measure is the distance from each pose the eased run visits to
the nearest point on the unmapped curve, and the first version of it took that distance to the
nearest *sample* of a densely sampled curve. It read **6.26e-3 m** against a correct build.

Six millimetres is a number that could plausibly be either a genuine displacement of the path
or a picture of how far apart the samples are, and nothing about the reading says which. Two
things separated them:

- **The samples were uniform in time, and the camera is not uniform in speed.** So the sparsest
  samples sat on the fast stretch between the 1.2s and 6.2s keys, which is exactly where a real
  path shift would hide. Projecting onto the segment between two samples rather than onto the
  samples themselves took that floor out and the reading fell to **2.03e-5 m**, a factor of 300
  for a change that touched no build code.
- **What was left was then made to prove which kind of thing it was.** Chord error against a
  polyline falls with the square of the density, so quadrupling the sample count has to divide
  it by about 16 while a real displacement would not move at all. Measured: 2.03e-5 at 800
  samples and **1.36e-6** at 3200, a factor of **14.9** against a predicted 16.

**The scaling test is the point, not the smaller number.** Tightening a threshold until a row
goes green is indistinguishable, from the outside, from having measured something — and this
repo's own history is mostly of bands re-derived to suit the reading in front of somebody. A
residual that responds to the instrument the way theory says it should is an instrument
artefact; one that does not is a finding. Ask the residual to move before deciding it is noise.

The fov row in the same section is the smaller sibling of the same lesson and is left at a
looser tolerance than its neighbours on purpose. Both sides solve the same cubic by different
routes — the page runs Newton with a bisection fallback, the tool bisects throughout — so they
agree in the eased fraction to about 1.4e-10. Position spans about a metre and does not notice;
fov spans 18 units across that fixture, so the same disagreement arrives eighteen times larger
at 2.5e-9 and lands just outside the 1e-9 the positions get. **The threshold is set against the
control rather than against the result**: ignoring the handles entirely reads 0.93 fov out, so
1e-7 sits six orders inside the gap it has to separate rather than being the number that let
the run through.

## A mutation that disables a control hangs the check that presses it

`editor-check`'s `ease-gate-hardcodes-scalar` puts the ease gate back to naming one kind, which
shuts the preset row for pose keys. The section that presses those five buttons did what every
other press in the file does — `page.locator(...).click()` — and Playwright's click waits for a
control to become actionable rather than failing on one that is not. So the mutated run sat for
the full 30s timeout and reported **`DID NOT RUN`, exit 2, with zero failed assertions**.

That is a crash wearing the shape of a catch, and the two are distinguishable only by reading
which assertions fired. CLAUDE.md's rule 3 is the general form and this is its browser-shaped
instance: the tools disagree about what a caught mutation exits, and a run with no failed
assertions and a non-zero exit is something to investigate rather than a catch to record. It is
also the same lesson `lanes-clear-siblings` taught — a check has to survive the fault it checks
for, or a caught mutation reads as an untested one.

The repair is to read the disabled state and assert on it instead of walking into it: the dead
preset row *is* the finding, so the row now fails with `the preset row is dead for a pose key,
so nothing could be pressed` and the run continues. The handle-drag rows needed the same
treatment for the same reason — `pose-segments-never-shaped` leaves no handle on the lane, and
a `boundingBox()` of null dereferenced is another exit 2 where a clean red was owed.

**Any mutation that removes a control, rather than changing what a control does, has this
shape.** When adding one, ask what the check does when the thing it reaches for is not there.

**And the paragraph above did not stop it happening again**, which is the part worth keeping.
A row added to the same section later that session — the one asserting a pose handle cannot
be dragged out of the unit box — reached for `.first().boundingBox()` with no count in front
of it, and `pose-segments-never-shaped` went straight back to DID NOT RUN and exit 2 with
eight clean reds owed. Two guarded call sites and a written-up case file were sitting a few
hundred lines away. A lesson recorded in prose is not a lesson the next row inherits: what
would have caught this is the guard being the only shape this file reaches for a handle in,
so the unguarded version has nowhere to be copied from.

## A sweep that reads its coverage domain off the thing under test

The camera track gaining ease handles replaced five scattered `row.kind !== 'scalar'`
comparisons with one `KINDS` table, and `editor-check` section 5 was rewritten to enumerate
that table through a page hook — `easedKinds()` — so that a fourth track kind added later
would be asked about by existing rather than by somebody remembering. Both of section 5's
loops then ranged over the returned list, and a row asserted that every kind in it had a
fixture in the tool.

**That row is one-directional, and the direction it does not cover is the reported bug.**
Flip a single token — `eases: false` on the pose entry — and `easedKinds()` returns
`['scalar']`. Both loops silently stop producing pose rows. The fixture-completeness row
passes, because nothing is unfixtured when nothing is claimed. `keyframe-check` stays green
too, because the evaluator never consults the table. The result is the original defect back
in the product — preset buttons dead on a camera key, no handles, no lane curve — with the
entire suite green and one word changed.

The general shape is worth naming, because "have the check enumerate it" is otherwise good
advice this repository gives itself: **an enumeration that closes the class must not be read
from the subject.** A sweep driven by the subject's own declaration of what it does can be
switched off by editing the declaration, and it will report full coverage of the empty set.
Enumerating from the *tool* is not the answer either — that is the hand-maintained list the
enumeration was introduced to replace. Both directions together are:

- every kind the page declares easable has a fixture here (the tool cannot fall behind the
  page), and
- every kind the tool has a fixture for is still declared easable (the page cannot shrink
  its own coverage).

The second is the one that carries the falsification, and it works because the fixture table
lives in a file the mutation cannot reach.

A related trap sat in the comment beside the mutation aimed at this area. It justified
aiming at one call site rather than at the table by claiming a table edit "would redden every
kind-dependent row at once", which is true of most of the table's fields and exactly false of
the one that gates the sweep: editing `eases` reddens **zero** rows. A plausible-sounding
reason for a scoping decision is worth re-deriving against the specific field, because the
comment was what stopped anybody looking.

## A driver credit is prose, and nothing joins it to a press

`editor-check` covers its control sweep two ways: a rule that claims a class by container,
and `DRIVER_IDS`, a table naming one control at a time and crediting the driver that presses
it. The table's own comments already record two entries that credited a driver which did not
drive, and say in as many words that this is the shape the table exists to refuse.

Three more were found at once, and finding them was an accident of the shape and the rate
moving surfaces. `tFps` was credited to "timeline-check and export-check change the output
rate and count frames": both of those write `transport().outputFps` directly and neither has
ever referenced the element. `tDeliverable` and `tDeliverableNew` were credited to
`library-check`, which writes deliverable directories on the server, reads `#tNote`, and
touches neither control. So of five entries read closely, three were false and two of those
were false in both halves.

**The mechanism is that a credit is a string.** Nothing joins `DRIVER_IDS['tFps']` to a
press of `#tFps` anywhere — the sweep asks whether the key exists, not whether the sentence
is true — so an entry is exactly as good as the last person to read it. That is not an
argument for deleting the table, because the alternative is the container rule, which is
worse in the same direction: it claims everything the container grows. It is an argument for
treating an entry as a claim with an owner. When a control moves, the entry moves with it and
is re-derived rather than carried across, and the honest repair for a credit with no true
answer is to make one true — section 1 presses those three now.

**And a container rule widened to a new container is the same failure with a bigger blast
radius.** `shelldialogs` was widened from two dialogs to three when the shape and the rate
moved into a new modal, which is a rule claiming every enabled control in a container the
tool had never opened. The `appbar` rule's comment records that exact mistake twice. The
repair is to make the claim true — the new dialog is opened, both of its controls are driven,
and both of its ways out are pressed — and then to run `plant-unswept-control` and read
*which* assertion fires, rather than trusting the exit code. It fired naming
`tPlantedControl`, which is the row doing its job; a widening that swallowed the planted
control would have read green at 488 assertions.

## A loop ordered by whether a parent exists collapses every level below the first

`editor-check` section 17e presses all 104 resets, and a tuning row declared `under` a master is
hidden while that master reads zero, so the section drives tuning rows before their masters. It
ordered them on `Boolean(p.under)`, which sorts a hierarchy into two buckets and leaves every
level below the first sharing one: `datamosh.refresh` is under `cycleRefresh`, which is itself
under `amount`, so pressing the middle row's reset put it back to `false` and hid the bottom row
before its own drag reached it. **An ordering rule over a hierarchy is denominated in the depth of
the data, not in a boolean about whether a parent exists** — the sort runs on the length of the
`under` chain now, so a chain three deep is ordered by existing rather than by somebody
remembering. The press waits on `!disabled && checkVisibility`, so the row nothing reached times
out and is reported as never offered, and the two rows after it name a real parameter holding 1.25
against a default of 1.2: three reds about the panel, for a fault that was the drive order.

## A hook renamed under a tool that deliberately boots two builds

`registry-check` renders this tree against a `web/main.js` pulled out of history with `git
show`, so it is the one tool in the suite holding two builds at once. Renaming a page hook —
`setTargetSize` to `setOutputSize`, because the name referred to a variable that no longer
existed — left the old arm answering to a name nothing asked it. Reached as
`globalThis.__kinect.setOutputSize?.("640x400")`, which is how five of that hook's six
callers spell it, the miss is silent by construction: the arm kept its default 16:9 letterbox
at 640x360 while this tree framed 1.6 at 640x400, and **all six cross-build rows went red
naming pixels that differ.** Six findings about readings, produced by a rename.

Two things are worth keeping out of this.

**An optional call on a probe hook is a resize that can quietly not happen.** `?.` is right
where the absence is meaningful and wrong where it stands in for "this build might spell it
differently" — the first is a fact about the build, the second is a rename nobody has
noticed yet. A cross-build tool has to address each build in the language it speaks, which is
what `git show` already commits it to, so asking by both names is the accommodation rather
than the smell. It is not a compatibility path inside the program, which is the thing this
repo refuses.

**But do not then throw when neither name answers**, which is the obvious next step and is
wrong here. One of this tool's two arms predates letterboxing entirely, publishes neither
name, and arrives at the right buffer by having nothing to fit — so a throw turns a correct
no-op into `DID NOT RUN` for the whole file. It did, on the first attempt at the repair. The
absence is meaningful on one arm and a rename on the other, and only reading what each arm
actually publishes tells them apart.

**And the control that settles it is the baseline in the failing conditions, not reasoning
about the diff.** Five of the six rows went green with the accommodation in place and one did
not — `readGhost`, two of six frames rather than six of six, which is a different shape and
so a different cause. A worktree at the commit before the branch's work, served on its own
port and checked from its own tree, produced the identical row with identical hashes. That
row is older than the change sitting on top of it, and ten minutes of `git worktree` is what
separates "pre-existing" from "mine" when both readings fit.

## A row that has always been red is measuring something it never claimed

`registry-check` section 1b renders each of the five readings at 1.0 against the pinned
build's numbered shading mode and asserted the two came back bit-identical over six frames.
Four rows passed. `readGhost` disagreed at frames 2 and 3, and had done since the section was
written — carried as a known standing failure, calibrated into `crush-gates-the-grade`'s
expected-failure string as "widening from its own standing 2 of 6 frames to 6 of 6", and
recorded twice in `web/cloud-shader.js` as reproducing unchanged across shader rewrites.

**Nobody had measured how much it differed by.** One byte out of the frame, by exactly 1 —
one colour channel of one fragment, on each of two frames. Everything else was identical.
That is not a reading rendering differently; it is two independently compiled shaders
rounding one fragment the other way, which is the effect `web/cloud-shader.js` already had
two case files about: adding a branch the shader never takes reddened three of these rows,
because a branch in the common path costs the compiler the contractions it was making either
side. The row claimed "this reading renders what its mode rendered" and enforced "these two
compilations agree", which is a claim about a driver and not one this product can keep.

The general shape: **an exact-equality assertion across two independently built artifacts is
measuring the toolchain as well as the thing.** That is fine while it passes and worthless the
moment it does not, because the standing failure cannot be told from a new one — and a row
already red is exactly where a new defect hides, which this repository says out loud in the
comment beside the mutation that was calibrated against it.

Two things made the repair safe rather than a loosening.

**The threshold came from both ends, measured.** Noise is 1 byte at delta 1. The quietest true
positive the row must catch is `ghost-alpha-term-dropped`, one term removed from the ghost's
alpha: 156,247 to 159,539 bytes — 17.0 to 17.3% of the frame — at deltas of 47 to 52. Sixty-four
bytes sits 64x above the noise and about 2,400x below the defect, and no value in between is
arguable. Two conditions rather than one, because a defect can be loud in either dimension:
many fragments moved one step trips the count, a few moved far trips the delta. What neither
catches is one fragment moved one step, and that is stated in the tool rather than left to be
discovered — such a change is by construction indistinguishable from the noise the row had
been printing since it shipped.

**Both of those figures are corrections, and the reason is worth more than the numbers.** This
section carried 187,245 to 191,215 bytes, about 18.6% of the frame, and a byte count of
1,024,000 — every one of them taken while the comparison arm rendered 640x400. The arm renders
640x360 now, so 921,600 bytes is the frame, and a count of bytes over a different pixel
population is a different quantity rather than the same one at a new scale: re-measured, the
defect moves 156,247 to 159,539, and even its *share* of the frame lands at 17.0 to 17.3%
against the 18.3 to 18.7% the old absolute figures work out to. A byte count carried across a
resolution change is the same class of rot as a line citation carried across an extraction, and
it is quieter, because nothing resolves it.

**The passing line names what it absorbed.** It reads `6 frames, 1 within tolerance (worst 1
bytes of 921600, delta 1)`, the same line on all 13 clean runs of the tool recorded on this
branch — one frame absorbed today where the historical failure was two, which was measured at
the old frame size and has not been re-derived at this one. A tolerance that reports nothing is
a blindfold: the day that line says 6 frames, or the worst byte count climbs, is a day to come
back and look, and a bare `PASS` would never say so.

The result is worth recording because it runs against the intuition that relaxing a check
weakens it. Before, `ghost-alpha-term-dropped` was caught against a row that was already red,
so its claim to redden "the readGhost row of 1b, alone" could not be read off a run. After,
it fires exactly one assertion and that row is green at baseline. Every mutation that touches
the section got sharper: `rgb-contributes-no-alpha` now shows the other four readings visibly
passing, and `mix-ignores-normalisation` — whose whole point is that 1b keeps passing while 8b
fails — can finally demonstrate it.

### And a standing red can go green because the fixture moved under it, which is not a fix

The other way a long-red row misleads. `registry-check`'s three streak-direction rows ask that
the light a streak adds at one angle lands on the far side of the frame from the light it adds
at the opposite angle: `along > 3%` of the frame with `across < 0.4 * along`. The 45-degree pair
had been failing the floor at **2.65% along, 1.35% across**, measured twice interleaved at this
branch's point, on the tool's own 640x360 canvas over its planted scrambled look. After the
glyph field went in it reads **4.48 / 1.71** and passes, and its two
neighbours moved with it, 4.04 to 5.60 and 4.17 to 6.75.

Nothing touched the streak, the rows or their thresholds. What moved is the fixture they are
measured over: the scrambled look raises `lattice.amount` to 1 on an 11cm cell with `additive` on, which
piled every point in a cell onto one position and rendered a white field, and the glyph field's
energy compensation now divides that pile-up back down. The frame stopped being saturated, a
gradient the row needs became readable, and three rows changed verdict. **A row can pass because
the thing under test was fixed, or because the picture it is read off finally has contrast in it,
and the run says the same word either way.**

Two consequences worth keeping. The first is that any row measured over the scrambled cloud now
inherits the compensation, so a comparison against a figure recorded before this branch is a
comparison across two fixtures and not two builds. The second is a caution rather than a finding:
the 45-degree row clears the ceiling at 1.71 against 4.48 times 0.4, which is **0.382 against
0.400** — under four and a half percent of margin, on a row that was red a commit ago for a
reason nobody has diagnosed. It is green and it is not settled, and the difference between those
two is the sentence this file exists to keep making.

### A press point computed from a duration is a press point the fixture's length moves

The third way a long-red row misleads, and this one is a defect in the check rather than a
property of what it reads. `editor-check`'s deselect rows press the empty head of a clip's own
lane, and the width of that whitespace is written in program time rather than in pixels: the clip
starts at 4s, so the gap is whatever 4s of the take comes to and the press goes at its midpoint.
The lane's width covers the whole take, so 4s is **22.6px on a 243.3s take against 58.7px on a
91.2s one**, which puts the press at 11.3px against 29.4px. The in-point marker's grab zone
reaches 12px inward over exactly that whitespace, so the long take lands the press inside the
marker by seven tenths of a pixel and the gesture the row meant to make never happens. Nothing
about the build differs between the two runs.

**A check whose press point is computed from a duration is a check whose result depends on the
fixture's length**, and that is worse than an ordinary miscalibration because of what it looks
like from outside. A row that comes and goes with no diff to blame gets read as the machine under
load, which is the explanation this file hands out to pointer rows more than to any other kind —
and both stories predict the same thing, so the load reading survives every re-run that happens
to keep the same fixture. The way to tell them apart is to change the fixture rather than the
load: two takes of different lengths at the same load say in one pass what a dozen re-runs at one
length cannot. **Press an offset measured off the element the gesture has to land on**, so the
target holds still while the fixture grows.

## An assertion that reads back what the edit was allowed to move

`+pt` on a key is Bezier degree elevation, and the property worth having is that the picture
does not change: the extra control point appears, every other one shifts to the place that
keeps the curve where it was, and no rendered frame moves. That is what lets the control be an
ordinary undoable press rather than something a take has to be judged after.

**The obvious row for that claim is the wrong row, and it is wrong in the dangerous
direction.** Reading the handles back and requiring them to be unchanged fails against a
correct build — every control point is *supposed* to move — and passes against the one
implementation this needs to catch: an `elevate` that appends a point and leaves the others
alone keeps the earlier handles exactly where they were and bends the curve. So the row that
looks like the tightest statement is satisfied by the defect and reddened by the fix.

The row that works samples the *rendered* curve through `valueAt` at seven points inside the
segment and requires the two sets to agree. In the browser it agrees to `0.000e+0`, and
`--mutate elevation-moves-the-curve` — which appends a control point at (0.5, 0.5) instead of
elevating — moves it by `3.590e-2`. The lesson generalises past this control: when an edit is
*defined* as moving its own representation while preserving what the representation means, the
assertion belongs downstream of the meaning. Asserting on the representation asks whether the
edit happened, which is the question the count already answers.

**The same shape one layer up.** `editor-check`'s preset sweep compared `got.easeOut[0]`
against `want.out[0]`, which read the first control point of each. That was a complete
comparison while a handle *was* one control point and became a prefix comparison the moment it
became a list — so `glide` writing only its first point would have passed, leaving a cubic
wearing a quintic's first handle. `--mutate glide-is-a-cubic` is the control, and it is worth
keeping because everything else about that mutation stays green: the ordinates are still 0 and
1, so the camera's *rate* still reaches zero at the key and every velocity assertion in the
suite passes. What goes is only the degree, and with it the acceleration claim that was the
whole reason for the second point.

## A parse that only ever ran in one configuration

`native/grabber.cpp` had no compile gate of any kind — 64 JavaScript files got `node --check`
on two Node versions every push and the one file that writes the artifact this program exists
to produce got a regex in a citation walk. So the first version of `cpp-check` was going to be
one invocation of `c++ -fsyntax-only`, which is a real check and would have carried a claim it
could not support.

The file chooses its default pipeline off which processors libfreenect2 was compiled with, and
branches per processor in three more places. Configure the gate off whatever the host has and
the macOS station gives it OpenCL, so **every OpenGL arm is text the compiler never reads** —
the Pi's `pipeline = new libfreenect2::OpenGLPacketPipeline()` and the two refusals beside it.
A break there would sit green on every push until somebody rebuilt on the Pi, which is the
machine that is hardest to get to and the one where a broken build costs a shoot. Worse, the
coverage would move with the host: the same tool on a Linux box with no OpenCL would check the
opposite half and report the same green.

So the gate runs the four combinations of the two macros the file branches on, and the control
that says it does is `--mutate opengl-branch-broken` — a type name that does not exist, planted
inside that `#ifdef` arm. **It must redden two of the four grabber rows and not all four**, and
both halves of that are the assertion: all four would mean the mutation escaped its arm and is
really testing something else, none would mean the matrix had collapsed back to one
configuration. The count is the reading, not the exit code.

Two smaller things came out of building it, both of which are the same rule pointed at the
instrument rather than at the subject. `--mutate grabber-type-error` is kept separate from the
two syntax mutations because `-fsyntax-only` is a semantic pass and nothing was asserting that:
a gate that merely tokenised would take `HdEncoder("high")` for `HdEncoder(int)`, and an
argument in the wrong unit is most of what a C++ mistake in this file looks like. And the tool
feeds the compiler `int x = ;` before it checks anything real, refusing to continue unless that
comes back rejected — the same canary `syntax-check` grew after finding a tree state where
`node --check` accepted a broken file in silence, which is a lesson this repository has now
paid for twice and should not pay for a third time.

## A row that passes on both builds, found by running the mutation rather than by reading it

`pauseTransport` is `takeTransport()` and then `timeline.pause()`, and its docstring is
unambiguous about why: a pause is a claim on the transport, and a resume queued behind an
older gesture only asks whether anybody has claimed it since. Every pause on the editor
went through it except the play button, which called `timeline.pause()` directly - so the
fix is one word and the finding reads as obvious.

The row written for it was not. Two presses of `#tPlay`, the second inside the first's
pre-roll, then a wait past any pre-roll and an assertion that the take is stopped. It
passed. It also passed against `--mutate play-button-skips-pausetransport`, which is the
whole defect put back, and the tool still printed `caught, as required (3 assertions
fired)` - because three unrelated rows are red on this tree and the verdict counts
failures rather than reading them. **That is this repository's own rule catching its
author**: count the failed assertions and read which ones fired.

Two things came out of chasing it, and the second is the one that matters.

**The window was measured with the driver in it.** From Playwright the transport reported
`playing` 71ms after the click and the clip first moved at 92ms, which reads as a 21ms
window to aim at. Both numbers are round trips: `page.locator().click()` does not return
until the page has processed the event, so what was being timed was the driver. Read from
inside the page, `playing` is true synchronously in the handler - the window opens at 0ms.
`docs/measurement.md` already says a figure derived from how long the driver's own loop
took is a measurement of the driver; this is that, one layer further in. The row now finds
its window by state - the transport playing and the clip not yet moved - rather than by a
number that is a fact about this machine.

**And with the window found, the mutation still is not caught, because the defect may not
be reachable through this control.** A pause pressed inside a play's *own* pre-roll holds
on both builds: nothing else has claimed the transport, so there is no queued resume for
the generation to invalidate. The cases the docstring names - a rate release, an undo, a
seek from another gesture - all pause first, so at the moment their resume is queued
`timeline.playing` is false and the button is a *play* rather than a pause. No sequence
was found where the button is the pause and a foreign resume is pending.

So the change stays and the claim shrinks to what was shown: it is consistency with the
helper this file's own comment mandates, not a defect anybody has reproduced. The mutation
stays too, named in `docs/proof-tools.md` as one this suite does not catch - the same treatment
`bloom-reference-1080` already has, and for the same reason. A mutation quietly deleted is
a question that gets asked again in a year; a mutation left in a list of things that must
FAIL, that does not, is worse than either.

A round of review later, the same button *did* have a demonstrated defect - a different
one, on the stretch this row's window opens after. The case below has it; the shrunken
claim above was right to shrink, because what was eventually reproduced was not the
generation guard failing but the toggle not seeing a pending play at all.

## The window a row finds by `playing` opens after the stretch the defect lives in

The row above finds its pre-roll window by state: the transport playing and the clip not
yet moved. That window is real and the row is honest about it - and it begins where
`play()` assigns `playing = true`, which on a drafted or out-of-range playhead is *after*
an awaited accurate seek. The stretch before that assignment is also real time, `playing`
reads false for the whole of it, and the toggle read `playing` alone: a second press
inside that stretch was taken as another play rather than as the stop it meant. Neither
pending invocation rechecked anything after its await, so both resolved into a rolling
take over the top of the press. An external review found it by reading the proof arm: the
second click waits for `t.playing` to go true, so the arm exercises only the later window
and the earlier one was never driven.

The fix is a `pendingPlay` flag the toggle reads beside `playing`, and a generation inside
the transport that `pause()` bumps and `play()` rechecks after its awaits. The rows that
hold it enter the pending state synchronously - `draft(4.0)`, then both clicks in one
page-side task, because the first click's handler sets `pendingPlay` before its first
await and the same task is the only place a driver is *certain* the state still holds. A
precondition row reads `drafted`, `playing` and `pendingPlay` at the second click, or the
outcome row passes vacuously on any build the moment the draft clears early.

The wait after the presses is for the transport's chain to drain - `!pendingPlay &&
!working`, then a beat - rather than a constant, and that choice is the mutation's doing:
the mutated builds start the clip only *after* the pending seek resolves, so a constant
shorter than the seek reads the defect as a pass. That is the same lesson the row above
learned about windows measured with the driver in them, arriving one stage earlier.

Two mutations guard it, `toggle-plays-over-a-pending-play` and
`play-resolves-past-its-pause`, and they redden the same outcome row - two ways to break
one claim that needs both halves standing. The toggle mutation leaves the pending-window
row green, because the mutated build still enters the pending state; what it loses is the
press that ends it.

## An instrument asserting the sufficient condition pins the code to refusing legal states

`restorekey-skips-handle-invariants` asserted, by name and fixture, that `easeOut
[[0.8, 0], [0.2, 0]]` is refused for descending control x. Descending x is *sufficient*
for a fold and never necessary, and with the default `easeIn` beside it that fixture's
curve is single-valued - minimum dx/du +0.277. So the instrument was holding the loader to
a rule that refuses legal documents: `elevate` produces crossed polygons out of ordinary
handles (`easeOut [[0.9, 0.1]]` / `easeIn [[0.1, 0.9]]` elevates to x = 0.675, 0.5, curve
unchanged), the editor saved them, and the next reload refused its own document. The same
per-side rule was simultaneously too loose - `previous` reset to 0 per side, so a fold
spanning the `easeOut`/`easeIn` join (`easeOut [[0.9, 0]]` / `easeIn [[0.05, 0.5],
[0.1, 1]]`, ascending within each side, minimum dx/du -0.41) loaded and rendered the move
at the wrong times, silently. One rule, wrong in both directions, and the instrument's
fixture is what kept it that way: fixing the code meant rewriting what the mutation
claimed to redden, which is why it went to the author rather than into a commit.

The replacement asks the real question of the real object - `foldRefusal` in
`web/curve.js`, whole-curve x-monotonicity once per segment with both handles in hand,
decided exactly by convex-hull pruning and de Casteljau subdivision rather than by a
sample count. The new fixture is the genuine fold above, the legal-crossed row beside it
is the exact polygon `elevate` produces - the half that fails on the build this replaced -
and `restore-skips-the-fold-check` reddens the fold row alone while the per-side rows
stay green, which is the split that says the two checks are different claims.

Two things came out of building it that the next check of this shape will want. **The
drag needed the same rule, and a seeded search is what said so**: `handleSpan`'s
neighbour clamp is the ordering rule again, and from the twice-elevated legal polygon an
adversarial sequence of in-span drags reached a genuine fold in six moves - 7,005 folded
states across the search, 1,184 of them ascending within each side, so no per-side
reading of any strictness catches them. `foldFreeX` now slides a dragged x to the last
fold-free point, and the search re-runs in `test/curve.test.mjs` with a wider adversary
and a positive control - the unguarded run must fold, or the guarded run asking nothing
would read as it holding. **And the exact decision procedure needs its tolerance on both
tests, not one**: the strict hull test cannot terminate cheaply on a segment sitting
exactly on the boundary - which is the state the clamp's own bisection produces - and one
such call measured 1.4s against microseconds for every ordinary one. The hull bounds the
curve from below by its least coefficient, so clearing -1e-9 everywhere is dx/du above
-1e-9 everywhere: a plateau in every sense that renders, pruned in one look.

## A census of exit codes that did not say what a miss exits

`docs/proof-tools.md` opens on the rule this whole suite is built around - count failed
assertions, never exit codes - and the census under it described its largest group as "seven
exit non-zero on a catch and say `NOT CAUGHT` when they miss". Every word of that is true. What
it does not say is what a *miss* exits, and the natural reading of the sentence is that a miss
must therefore look like something else.

It does not. Measured across all seven, plus `module-check` which had never been in the census
at all: the `NOT CAUGHT` branch is `process.exit(1)` and the `caught, as required` branch beside
it is `process.exit(1)`. Within that group the exit code carries **no information whatsoever**,
and the printed sentence is the only thing separating a catch from the check being blind.

**The cost was a round of this work.** Wiring `syntax-check` and `module-check`'s thirty-three
mutations into CI needed a loop, and `module-check` was written up as a fifth shape of its own -
"the worst of the set", with a paragraph about it - purely because the census's wording implied
the other seven behaved differently. Reading their code took two minutes and the write-up was
wrong. The correction is in the census now, stated as the miss exit rather than as the catch
exit, because the thing a reader needs is the half that was missing.

Two things generalise. **A census of behaviours has to state the behaviour that is dangerous,
not the one that is interesting** - what a catch exits is the memorable fact and what a miss
exits is the one a gate is written against. And **a group somebody has not measured is a group
you are quoting**, which is the same rule this file states about counts in prose, arriving in a
document whose entire subject is not trusting them.

## Two loop shapes already in this repo, each of which scores a miss as a catch

The step that runs those thirty-three had two obvious models sitting in the same workflow, and
neither is usable, which was measured rather than argued by running both against a stub that
misses on purpose:

- **The `cpp-check` job's shape**, `if node ... ; then echo NOT CAUGHT; exit 1`, treats a zero
  exit as the miss. Against the stub it printed `caught` and exited 0. That is right for
  `cpp-check`, whose miss really is exit 0, and it is exactly backwards for the eight tools
  above.
- **The gate job's shape**, `set -e` with a bare invocation, treats a non-zero exit as the
  miss. It fails on the stub - and it also fails on all thirty-three runs that *work*, because
  a catch in both of these tools is a non-zero exit too.

What discriminates on every tool is the number each already prints in its own summary line, so
the step parses `, N failed$` and requires it above zero, with exit 2 kept apart from a miss
because a stale anchor and a name the tool does not know both answer 2 having asserted nothing.

**The loop has three falsification controls of its own**, and they are the shape this file
recommends for a mechanism the subject cannot break: a probe tree of stub tools, one per
failure branch. A tool enumerating no mutations fires the floor; a tool declaring one and
missing it fires `NOT CAUGHT`; a tool refusing its own anchor fires `DID NOT RUN`. Each fails
the step with its own sentence, and the identical loop text is run against them by `cd`-ing to
the probe root, so what is graded is the shipped text rather than a copy of it.

**What CI cannot claim, and it is worth stating beside the step.** The rule is "read which
assertions fired", and a workflow cannot: a per-mutation row table in a YAML file is the
hand-maintained list the enumeration exists to replace. Measured, so the bound is real rather
than admitted: with `module-check`'s cycle detector stubbed out, `--mutate cycle-planted` still
printed `caught, as required (1 assertion fired)` and exited 1 - off the probe tree's own row,
not the row the mutation names. What catches *that* is the unmutated run in the same job, which
the same stub reddens. The two steps are one claim in two halves and neither is worth much
alone.

## The registry was right and the controls were lying, so the obvious diff finds nothing

The post-boot state diff had been deferred to by three documents and built by none, and the
audit that asked for it sketched the comparison as "read every registry value back after first
paint, compare against the registry's declared defaults". That cannot catch the fault it is for,
and the reason is one line:

    function writeControl(name, value) {
      const el = panelControls.get(name);
      if (!el) return;

`params.reset()` landing before the panel generator has filled that map writes every value into
the registry, reaches no control, and returns silently. So the registry ends up holding
perfectly correct values - it is the *controls* that show what the markup left them at - and a
diff against declared defaults compares defaults to defaults and reports nothing at all.
Measured with the fault restored: **73 of 80 controls diverge and the registry is right about
all 80.**

**Ask which side of a comparison the fault actually moves.** This is the two-terms rule already
in this file, arriving from the direction where the wrong term is the one that looks
authoritative: the registry is the source of truth, so comparing against it feels like the
strong check, and it is the half the bug leaves untouched.

### And what an unwritten control reads is measured, not derived

The coverage row beside it - which parameters the diff cannot separate, because their stored
value equals whatever an unwritten control shows - was first written against `(min + max) / 2`,
the value an HTML range input is commonly said to default to. That is wrong here on **75 of 75**
range controls: `pointSize` spans 0.5 to 64, whose midpoint is 32.25, and the element reads
50.5. The predicted blind set named thirteen parameters where the fault leaves seven, and the
two lists overlap on two.

The repair is to build a detached input carrying the same `min`, `max` and `step` and read its
`value` - the browser answering the question instead of the check predicting it. It then agrees
exactly with the set observed surviving the mutation, which is what says the two halves mean the
same thing by "indistinguishable". **A number that reads like a measurement and is a picture of
a formula is the failure this file keeps recording**; the tell was that it was computed rather
than observed, in a check that had a browser open the whole time.

## A one-way migration whose two gates cannot be told apart

**Written in the past tense: `tools/convert-presets.mjs` was deleted the same week this was
found, and nothing in this section can be re-run.** It is kept for the reason the floor-
selection entry above is kept - the lesson is about gates that agree, not about migrations -
and because the way it was found is the transferable part.

That tool converted a document's undo history in two places: `convert`'s version 3 branch
called `convertHistory` and then handed the result to `toVersion5`, which called it again. The
tool's own comment called this out as costing a walk and changing nothing, and it was right.

The consequence is that a version 3 project reached both, so neither could be falsified.
Measured on a test written for it: removing `convert`'s call reddened nothing, removing
`toVersion5`'s call reddened nothing, and only removing **both** reddened the row. That is the
two-gates-that-agree shape this file already records against the rename route, found this time
by mutation-testing a *new test* rather than by reviewing old code - which is the part worth
carrying. **A test written against code nobody has broken on purpose has unknown sensitivity,
and the cheapest way to find its blind spot is to break the subject six ways and read which
rows move.** Five of the six reddened exactly the row they named; the sixth reddened nothing
and that was the finding.

The fixture that separated them was a *version 4* project carrying history, which skipped the
version 3 branch entirely - so its history was converted by `toVersion5`'s call site alone.
`convert`'s own call stayed genuinely unfalsifiable and was reported rather than repaired,
because removing it was an edit to a tool whose successful outcome is destroying the original.
The whole question then went away with the tool, which is the outcome a report makes possible
and a quiet repair does not.

## An export added where the rule does not look

A plan that adds exports to a tool and expects `module-check`'s dead-export rule to keep them
honest is relying on a scope the rule does not have, on the strength of its consumer walk being
the whole checkout. The rule's **subject** is `web/` - it walks `web/` for modules and asks who
imports what they export - while the whole-checkout walk is only the **consumer** side. An
export added under `tools/`, `server/` or `test/` is in neither population, in either direction.

Measured rather than reasoned about, and re-measured on a file that still exists: a dead export
planted in `tools/make-sample.mjs` passes a clean run at 61 assertions, 0 failed. So an export
outside `web/` carries no coverage from that rule at all, and saying so is the honest report -
widening the subject set is separate work needing controls of its own, and it would be a change
with a blast radius across every tool in the tree.

**The general form: a rule with two populations has two scopes, and the wider one is the easier
to remember.** "It reads every JavaScript file in the checkout" is true of `module-check` and is
a sentence about its consumers, not about its subjects - and a plan built on the sentence rather
than on the split gets a safety net that is not there.

## A driver that presses a control the page is already pressing on a timer

`effect-check` calls `__kinect.effects.pollNow()` because waiting out a six-second interval
would make every row six seconds longer and turn a rebuild that threw into a timeout with
nothing to read. What that call *is*, though, is the interval's own body - and the interval is
still running. So a tick that started six seconds ago can be mid-read when the driver arrives,
the reentrancy guard sends the driver's call straight back having done nothing, and the row
after it reads page state that the tick will not have written for another second.

It cost two rows, and they failed in the two shapes this is worth remembering by. Section 6 read
`#tNote` the moment `pollNow` resolved and found it empty - **while every other row of that
section passed**, because they read state a rollback restores and a poll that did nothing leaves
in exactly the same place. One red row in a green section is the signature: the rows that can
see "nothing happened" and the rows that can see "the wrong thing happened" are different rows,
and only the first kind is a clock problem. Section 8 read `presetGestureRunning()` one
`setTimeout(0)` after clicking cancel and got `true` about half the time, because the dialog's
`close` event and the `finally` that lowers the flag are several hops apart.

**Both are the same rule: a driver that shares a control with the product waits for the state
rather than for its own call to return.** `waitForFunction` on the condition the row is about -
the note being non-empty, the flag being down, the signature having converged - keeps the claim
intact, because a build that never gets there still fails, one interval later. Counting turns of
the event loop does not: it encodes a guess about how many hops a DOM event takes, and the guess
is wrong on a machine under load.

The tempting alternative is to expose a handle that stops the interval for the length of a run.
It would make the rows deterministic and it would make them rows about a build nobody ships,
which is the trade `docs/measurement.md` records under screening measurements that remove the
effect they are measuring.

**And the same interval is what makes a row asserting that nothing happened need a second
number.** The arm for "a set this page has already refused is not fetched again" counts package
reads in a window and requires zero — which is satisfied perfectly by a build that has stopped
polling, by a `pollNow` the reentrancy guard turned away, and by a page that has crashed. So the
row counts the *listing* reads in the same window and requires at least two of them, and the
window is bounded by waiting for that count rather than by a pause. **A row whose subject is an
absence has to name something present in the same breath**, or the strongest evidence for it is
the tool having stopped working.

## `params.spec` answers with the bounds and not the words

A row asserting that a retuned package's new label reached the registry read
`k.params.spec('probe.hue').label` and got `undefined` - on a build where the label had arrived
perfectly well and the panel was drawing it. `spec` returns a projection: `default`, `min`,
`max`, `step`, `kind`, `tag`, and nothing else. The row was not measuring a wrong label, it was
measuring a field that has never existed on that object, and `undefined !== 'probe hue, retuned'`
is a red row on every build there has ever been.

**A reading that is `undefined` on a correct build is not a finding, it is a probe pointed at
nothing** - and the direction it fails in is the dangerous one only when the assertion is
negative. Here it was positive and failed loudly; had the row asserted the label had *not*
changed, it would have passed forever.

The fix is the one this repo keeps arriving at from other directions: read the thing on screen.
The label the row is about is the `<span>` in the panel row, which is what a person sees, what
`registry-check` builds its view of the panel out of, and a reading that cannot come back
`undefined` without something being genuinely wrong.

## A mutation neutralised by a guard downstream of the line it edits

`poll-takes-any-body` was written to put back a shipped defect: `GET /effects` answering a body
with no `effects` array in it, reaching the signature comparison, and throwing out of an interval
callback once every six seconds for the life of the page. The edit defused the array check that
now stands in front of it, the run came back **NOT CAUGHT**, and the first reading was that the
row was too weak.

It was not. The rule the edit removed is one of two: the array check and, right after it, a loop
over the entries checking that each is an id and a rev. With the first gone the second iterates
`undefined`, which is a `TypeError` thrown from inside `listEffects` — where the poll's own
`catch` is, and where it is handled exactly as a restarting server is. **The mutated build
behaved identically to the fixed one**, so the row had nothing to see and was right to stay
green.

Two edits reproduce it, and only two: the array check defused *and* the entry loop made
tolerant, at which point `listEffects` answers `undefined` and the comparison a line later is
outside every catch there is. `CLAUDE.md` says to confirm a mutation did something before
believing it was missed; the specific shape worth naming is **a rule that is really two rules,
where the second one catches what the first was edited to let through**. A guard downstream of
the line you edited makes a mutation a no-op, and a no-op mutation is indistinguishable in the
output from an instrument that cannot see.

**And the same entry took a third edit when the listing grew a field.** The shape rule now asks
for a generation as well as an array, and writing that as a second `if` would have put a fresh
guard downstream of the line this mutation edits — the nonsense body would be refused by the new
condition, the mutated build would behave like the fixed one again, and the run would come back
`NOT CAUGHT` for the third time on a mutation that had reproduced nothing. It is one condition
for that reason rather than for tidiness. **When a rule gains a term, ask which mutation anchors
on it**, because the cheapest place to put the term is usually in front of the thing the control
is aimed at.

## An interception that counts reads is sharing the route with whatever else reads it

`effect-check`'s coherent-read arm stages an install landing mid-read by intercepting
`GET /effects` and moving a revision in the *closing* listing, and it identified that listing by
parity — every second read. The page's own six-second interval fetches the same URL through the
same interception, so a tick landing between the driver's two reads shifts the count and the
closing read comes back untouched: the rebuild succeeds and the row reddens on a build with
nothing wrong with it. Seen as a second red row under `--mutate rebuild-forgets-the-tab`, five
sections away from anything that mutation touches, which is the tell — **a red row in a section
the mutation has no business in is a fixture problem before it is a finding.**

The handle that works is the order *inside* one read rather than a count across the run: the
opening listing is asked before any package is and the closing one after all of them, so a flag
set by the package route marks the next listing as the closing one.

**And the first version of that repair was wrong in the more interesting way, which is that the
row went green for the wrong rule.** The read retries once, so "every listing after a package
read" moves the *opening* listing of the second attempt too — and a moved rev in an opening
listing is caught one request later by the package that answers for a revision the listing did
not name, which is a different rule entirely. Measured: the row was green on a clean build for
the neighbouring rule's reason and went **red under `package-read-need-not-match-the-list`**, a
mutation about the rule next door. Clearing the marker as each closing read passes puts every
attempt back on an untouched opening listing, and the three terms then separate exactly:
`reads-need-not-agree` reddens two rows, `list-reads-need-not-agree-on-generation` one, and
`package-read-need-not-match-the-list` one, each of them the row its own sentence names.

The row carries its delivery beside its claim now — `closingReads === 2`, because the read
retries once, so a run that refused for this reason moved a rev in exactly two closing listings.
**A count that says where the fixture landed is what separates a refusal for the right reason
from a refusal**, and this row had neither until a mutation about something else went red.

## A verification of content is a refusal of every harness that substitutes content

An external review asked for the tighter of two possible fixes to a coherent read: have the page
hash every chunk it fetched, with `crypto.subtle`, against the per-file `sha256` the store's own
file index declares. That verifies content rather than timestamps, so it closes the window
completely, and it is the right instinct. It cannot ship here, for two independent reasons and
neither of them is about the rule.

**The first is the boot path, and it was measured rather than reasoned about.** `crypto.subtle`
is undefined outside a secure context; `--host 0.0.0.0` with a browser reaching a capture node
at an address literal is this program's documented two-machine shape, and its origin guard
*requires* an address rather than a name, so the LAN case is never a secure context by
construction. The read in question runs inside `web/main.js`'s top-level await. So the page
would have thrown while evaluating on exactly the deployment the design is built around,
published no `__kinect`, and taken every tool in this suite to DID NOT RUN. Measured on this
build, one server on `0.0.0.0` and two origins: `http://127.0.0.1:8506/record` reads
`isSecureContext true` with `crypto.subtle` an object, and `http://10.31.158.148:8506/record`
reads `false` and `undefined`, both pages otherwise booting cleanly.

**The second is the one worth the entry, because no amount of care about the API would have
found it.** Three tools in this suite deliver mutations by *serving altered chunk bytes* at
`/effects/:id/file/:name` — `registry-check` stages about twenty specs into
`effects-builtin/<id>/<file>` and serves them through `servedAt`, `export-check` three more, and
`effect-conformance-check` intercepts every chunk fetch on every run, mutated or not, so that
the two paths differ in one function call rather than in whether a route exists. A page that
hashed those bytes against the index would refuse all of them. The rule would have been correct,
the tools would have been correct, and about thirty falsification controls would have stopped
running — in the loudest possible way for `conformance`, which would never boot a page again,
and as `DID NOT RUN` for the rest.

**So the question to ask before adding any check on the content of something fetched is who else
is allowed to rewrite that content.** A proof harness is a legitimate rewriter by design, and it
is invisible from the code being hardened. The general form is the delivery entries above read
from the other end: those are about a mutation that fails to arrive, and this is about a mutation
that arrives and is *refused by the product* — same silence, opposite cause, and the second one
gets worse the more thorough the check is.

What shipped instead closes the same window from outside the bytes: the store carries a
generation it bumps on install and remove, the two listings either side of a read must agree on
it as well as on their contents, and each package read must answer for the revision the listing
named it at. Neither is a claim about bytes, so no interception can trip either — and the pair
catches what the contents comparison structurally cannot, which is a change that was *undone*
while the page was reading. `list-reads-need-not-agree-on-generation` and
`package-read-need-not-match-the-list` are the two controls, and they are separate specs because
a build with no comparison and a build comparing the wrong thing fail differently.

**The residual is stated rather than closed, and it is narrower than the obvious wording.** A
change made to the package directories by something that is *not* this store moves no counter,
so an edit and its undo are invisible to it — but only where the sole requests answered out of
the changed state are chunk fetches. A listing landing there disagrees on the revisions and a
package read landing there answers for a revision the opening listing did not name, so both of
those are caught by the terms above. The hole is one window, between a package's manifest and
its chunks, on directories nothing in the product writes to. `effect-check` asserts the
behaviour rather than describing it: section 1 flips a byte on disk, the revisions move and the
generation does not, which is this paragraph as a row.

**And the arm for the whole term had a hole of its own that the clean run could not show.** The
change-and-undo is staged by moving the generation inside a route interception, which measures
what the *client* does with the number and is perfectly satisfied by a store that never moves
it — at which point every listing agrees forever and the read is back to comparing bytes. Two
rows now read it off the real store across the real install and uninstall section 2 already
performs, and the second is the design in one measurement: `probe` is not a builtin, so removing
it leaves the store holding the identical packages at the identical revisions, and the only
thing separating that moment from the one before the install is a number that went up twice.
`store-generation-never-moves` is the control, and what makes it a control rather than a fourth
way of saying the same thing is that it must leave the interception-fed arm green — the two
measure opposite ends of one wire.

## A row whose message described the defect, agreeably, for as long as it passed

`effect-check`'s grade-gate section ends by uninstalling a grade effect and asking that the pass
shuts again. The row read:

```
and taking it off shuts the pass again, on a uniform cell that is still carrying the value it
was raised to      grade.enabled=false, probeGradeAmount still 0.6
```

The claim that row carries is about the *gate* — a build that derived its gate list once at boot
leaves the pass open over a term the registry no longer has — and that half was right and had its
own mutation. The other half of the predicate, `ungated.value === 0.6`, was written from what the
tool observed the build doing, and what the build was doing was the defect: nothing writes a
uniform except the parameter bound to it, so a package coming off leaves its term standing at
whatever the slider last put there, and the chunk that reads it does not stop. It is one line of
GLSL from a grade nobody can switch off, and the instrument had it written down as expected
behaviour, in a sentence, in the passing message.

Nothing was going to find that by reading the row, because the row is about something else and
its sentence is accurate. What found it was a review asking a different question — what happens
to a uniform a *rebinding* abandons — and the uninstall turning out to be the same question with
a plainer fixture.

Two things to carry. **A conjunct added because it was true when the row was written is a claim
about the build, and it needs the same "should this be true" that the row's own subject got.**
The tell here is that the two halves of the predicate are about different subjects: one names the
pass and one names a cell, and only the first is in the row's sentence.

And the shape of the repair matters, because the tempting one is to drop the conjunct. The value
is worth reading — it is the plainest observable of a departed binding there is — so it stays and
its expectation inverts, which turns the row into a second live arm for the new rule rather than
a row with a term deleted out of it. **A conjunct you cannot justify is either wrong or is a claim
nobody has made yet; deleting it loses the reading either way.**

## A new arm lengthens the fixture chain it is dropped into, and an old mutation pays for it

Two arms went into `effect-check` section 6, next to the fixture they wanted: a page holding an
install it had refused. They belong there by subject and the placement was wrong, and the reading
that said so is one nobody would get from the clean run, which was 107 of 107.

Section 6 leaves the page carrying a document, and the sections after it drive `reload()` at six
call sites with no `try` around any of them — so a mutation that makes a rebuild throw ends the
run at the first of those rather than reddening a row. Three existing mutations break exactly
that. With the two new blocks in, `reinstall-leaves-it-parked` had more parked wreckage to leave
behind and went from **nine red rows to fourteen**, the five extra being cascades off a document
its own defect had already made unloadable. `rollback-keeps-the-new-registry` went from six to
ten on the same reasoning — the new arms are second rollback fixtures — but that one is the
honest cascade and this one was not, because nine is the number its Must-redden line promises.

**The first reading of it was wrong, and it is worth keeping the wrong version visible because
it is the reading a diff invites.** It looked as though the new blocks had stopped that mutation
surviving section 7, which the run supports: 60 assertions of the 107 the tool had at that
moment. They had not. A worktree at `4b63f80` under the same mutation ends at **52 of 91 with
nine red**, so it has always ended early at exactly the same place and no line anywhere said so.
Ten minutes of `git worktree` is what separates "my change did this" from "this was always here"
— a rule this page states about a red row, and just as true of a *number* that moved.

**The cost is the sections that stop being measured, and that cost was there before and after.**
A truncated mutation run is the shape this page already records twice: every row read
individually looks like a catch, and a third of the suite's claims were never put to that build
at all. What the placement changed is how many rows go red on the way there, which is the part a
reader checks against the promise.

Both blocks moved to the end of section 9, which is two short sections from the end and one of
those closes the browser. The fixture is re-staged there rather than inherited — the fork is
installed again and driven through `pollNow` — which costs one precondition row and buys back the
old blast radius exactly.

**The rule is worth stating on its own, because "put the arm next to its fixture" is otherwise
good advice.** *A block's position is a claim about what it costs every mutation that has to
survive it*, and the way to check it is to re-run the mutations whose fixture chain now runs
through the new block, not the ones the new block is about. The repair that would make position
stop mattering is the one this page already prescribes and this tool has not had: guard every
driver call a mutation can make throw, at all six sites rather than at the one that failed.

## Every row in a section read a store that had quarantined something

`effect-check` section 12 stages a fork this build cannot assemble, restarts the server, and asks
five things: the id answers with the shipped package, the fork is renamed aside with its files
intact, the aside is in no listing and no read, the start said so in the door's own sentence, and
a page opened on that store boots. Every one of those is satisfied by a gate that renames *every*
user package aside. A wall passes the whole section, and the section is the only place the gate
is driven at all.

That is not hypothetical, which is the part worth keeping. The gate handed the door
`loaded(candidate)` — every other package on disk, validated or not — and the door assembles
`[...beside, candidate]` and reports the assembler's message under the *candidate's* name. So a
healthy fork doored beside a broken one came back "does not assemble" and both were quarantined,
and which of the two was blamed depended on the lexical order the walk reached them in. The
section could not see it: thermal went back to the builtin either way.

**The population that says a gate is a gate rather than a wall is the one it must keep**, and it
is the same argument `test/effect-door.test.mjs` opens with about the sixteen shipped packages —
made there against the door and not made here against the gate, on a surface where the two are
meant to be one rule asked twice. The row that closes it is a second fork staged beside the
broken one, verbatim at a new version so nothing about it can be refused except by contamination
from its neighbour, with an id that sorts *first* so a lexical walk meets it while the broken one
is still unchecked. It reads that the id still answers from the user root, and a second row reads
that it is the only user package still standing.

**A refusing gate has this shape wherever it appears**: a section whose rows all read the state
after a refusal is blind to over-refusal, however many rows it has. Ask what a rule that refused
everything would fail here, and if the answer is nothing, the missing row is a must-accept.

## A new rule placed ahead of an old one takes that one's fixture away

A hostile fixture reaches the rule it is named after by being the only thing wrong with it.
Add a rule that fires earlier and the fixture still gets refused, the row still goes green on
a good build, and nothing anywhere says the probe has stopped arriving where it was aimed.

Three of these landed in one change and they are the same shape read at three distances.
`effect-check` section 2's `one joint naming one file over and over` probe pushed a thousand
chunk descriptors, which is a 90,623-byte manifest — so a new 32 KiB manifest bound refused it
by size, several rules ahead of the assembler's repeat rule, and the row reddened naming the
manifest on a build where both rules were working. Cut to fifty descriptors it is about 6KB,
inside every bound and outside none, and it reaches its own rule again. In the same change a
near-miss fixture built to prove the new `gates` rule does not refuse a legal `degToRad`
binding was written by repointing the shipped `angle` off `scanAxis`, which left that uniform
declared and bound to nothing — so it came back refused by the two-ended binding rule two
hundred lines away, and the row would have been green on a build carrying no gate rule at all.
It is a new parameter now. And the scan behind the second half of `HOST_DRIVEN_UNIFORMS` read
declarations without stripping comments, so it walked through the glitch's flare chunk and the
duotone's tone chunk, which both quote `readRgb, readDepth, readContour` in prose from a
pinned build, and failed naming `readDepth` on a build with nothing wrong with it. The door's
own `withoutComments` is the two substitutions that fix it.

**Every hostile fixture is a claim that one rule refuses it, and the claim decays whenever a
rule is added.** The cheap enforcement is the row `effect-check` already has: every hostile
package is refused *by the sentence for its own rule*, not merely refused — which is what
turned the first of these from a silent decay into a red row somebody had to read. A suite
that only asserted refusal would have carried all three. When a refusal is added ahead of
others, re-read what the existing probes now trip on rather than only what the new one does,
and make the new refusal's message name which rule fired, so the next person reads the
attribution instead of running both arms to work it out.

## An exclusion with a reason attached is the one nobody looks at twice

`keyframe-check` asked whose clock a clip's keys are on, and it asked about exactly one
parameter. Section 6f proved a clip's placement travels with a dragged clip, and beside it
`docs/architecture.md` wrote the exclusion out in full: "a clip's *look* keys are still
absolute, so dragging a clip leaves its keyed grade behind". Both halves were accurate. The
suite ran green for the whole life of the split, and the object nobody had a probe on was
the larger of the two - every clip-scope parameter except the one that had a section.

**A stated exclusion reads as a decision that was made rather than as a hole that is open**,
which is the trap rule 5 names, and it is worse in prose than in source: the sentence argues
for itself, so a reader who arrives asking "is the look covered" gets an answer and stops. The
same sentence with the word *yet* in it, or with a line saying which row would go red if it
stopped being true, is a hole somebody eventually closes.

Section 6g is what closing it costs, and the shape is worth copying because two of its rows
would have been green on the build it was written against. The one that reads a keyed grade
after the clip has been dragged cannot see the fault on its own: with the keys clamped at their
ends, a build reading the track at program time answers with the last key at both positions and
agrees with itself, which is the equality this page already records twice. What discriminates is
a probe on the *program second the grade used to sit at*, asserting it no longer holds it - the
negative half of "travels with the clip", which nothing else in the section states. The other
half is the write: `keyPlayhead` stamps a key from the panel, and only a section holding a clip
that does not start at zero can tell a key stamped on the clip's clock from one stamped on the
edit's. 6e keys `bloom` at the head of the edit, where the two clocks are the same number, so it
was green under every version of this rule and always will be.
