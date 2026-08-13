# Working in this repo

**The shipped program is the design.** There was a long design document and a set of HTML
studies, and they were deleted when the thing they described was finished and working —
a drawing of a surface that now exists is a second representation that can only drift out
of step with the first. `README.md` carries the usage path and nothing else, because a
README that opened on the architecture was a README nobody read to the part that says how
to shoot a take. What survived of the design lives in three pages beside it:
`docs/architecture.md` (the four surfaces, program time, the wire format),
`docs/reference.md` (the command line, the controls, the readings, presets) and
`docs/performance.md` (the measurements and the negative results worth not re-deriving).
The reasoning that used to live in the design doc now lives where it is enforced — in the
code's comments, which are long on purpose, and in the proof tools.

What has not changed is what to do when reality disagrees with an intention: **report the
contradiction rather than silently redesigning**. That has happened repeatedly and
reporting was the right move every time.

## Where the rest of this lives

This file is the part that has to be in your head before you touch anything. The case files
behind each rule — what was measured, what the instrument got wrong, and how it was closed —
are three documents deep, and each one has a condition attached rather than an invitation:

- **`docs/instruments.md`** — read it **before writing or modifying any proof tool**. Every
  way a check in this repo has claimed a property it was not testing.
- **`docs/measurement.md`** — read it **before reporting a number**. Which runs get thrown
  away, and the rig's two pieces of hardware that read differently from how they measure.
- **`docs/proof-tools.md`** — read it **before running or editing a specific tool**. What
  each needs, what its exit codes mean, and the fixtures.

**New lessons go in those files, not in this one.** A correction learned during a session
belongs beside its neighbours in the relevant document, with this file gaining a line only
if an agent would get the *next* task wrong without it. The version of this file that
absorbed everything reached 704 lines and stopped being read.

That chain is enforced rather than trusted: `syntax-check` walks every `docs/*.md` path this
repo's prose and source cite and fails on one that does not exist, because a pointer that
outlives its target teaches a document nobody can read. Its control is moving one of the
three away and running it. **The same walk resolves every `web/….js` a comment or a page
cites**, and a `file:line` form fails when the file has fewer lines than the citation names —
which is what the browser bundle's split into modules needed, because fourteen citations were
left naming that bundle for code that had moved out of it. Cite a function by name rather
than by a line: a path is checked for resolving and never for being *right*, so a line that
has drifted into the middle of something else passes here.

**Both walks read every file this repo ships, which they did not at first.** The citing set
was a list — root markdown, `docs/**.md`, and the code under four directories — so a citation
written anywhere else was never looked at while the row went on printing that every cited
module resolves. Three were outside it and all three name a module: `native/grabber.cpp`,
`presets-builtin/README.md` and the CI workflow. The set is now a walk of the whole tree
minus what `.gitignore` declares this repo does not ship, so a source tree added next year is
read by existing rather than by somebody remembering to add it. `--mutate
citation-outside-the-prose` is the control, and it is a control the old walk could not fail:
with the mutation declared and the old citing set in place the run came back 0 failed.

## Measurement culture

This repo measures rather than reasons. Several inherited estimates turned out ~40% wrong when
finally profiled - `Registration::apply` was carried as 4.5ms against a measured 6.3 - and the
corrections are recorded beside the numbers rather than replacing them silently.

- **"This should be faster" is not evidence.** Measure it.
- **Interleaved A/B, never sequential before/after.** A sequential comparison on this rig
  once produced a 23% figure that was really 12.9%.
- **State the method with every number**: window length, sample count, warmup discarded, and
  whether the page cache was warm.
- **Proxy evidence does not close a user-visible change.** Drive the real UI with
  `playwright-cli` and show it working. A passing unit test is not a rendered frame.
- **Read a health number the measurement itself reports, and throw the run away when it is
  wrong.** Delivered fps is that number for anything using the grabber - a run that does not
  sustain ~30.0 was competing for the machine and its per-segment timings are noise.
- **An offline harness is for correctness; `grabber --profile` on the sensor is for cost.** A
  screening measurement that removes the effect will confidently report its absence.

## Writing a check

The five rules that survive out of context. `docs/instruments.md` carries the case file for
each, and there is a case file for each because every one of them was learned by shipping the
mistake.

1. **An instrument must enforce its claims, not assert them.** Ask what a broken
   implementation would have to do to still pass, and close that. **Every proof tool needs a
   falsification control**: something that must FAIL if the thing under test were not doing
   the work.
2. **Mutation-test the instrument rather than reasoning about it.** Report which mutations you
   ran and what each caught. Before believing a mutation was *missed*, confirm the mutation
   did something; before believing one was *caught*, confirm it was caught for the reason
   claimed.
3. **Count failed assertions, never exit codes, and read which assertions fired.** The tools
   disagree about what a caught mutation exits and the disagreement runs the dangerous way. A
   run with zero failed assertions and a non-zero exit is a crash to investigate, not a catch
   to record.
4. **Place a probe where its answer would be different, not where it is convenient** — and ask
   what all of your probes agree about, because a set of arms that agree on a quantity cannot
   measure it however many of them there are.
5. **Ask whether there is an object here that every observation happens to skip**, and be most
   suspicious where the skipping was deliberate: a deliberate exclusion comes with a
   justification that stops anybody looking twice. This has now cost three separate holes —
   the take being recorded, and the editor's picture twice.

**Close the class, not the instance.** Fixing the six routes that were found leaves the
seventh outside the list; making the route table *be* the dispatch and having the check walk
it means a route added later is asked by existing.

**Before believing a proof tool caught your change, re-run the baseline in the conditions the
failure happened in**, not the conditions the baseline happened in. A contended machine makes
a check fail in ways that read as a finding — this cost five reproductions against an innocent
change, with a clean control taken on an idle machine.

## Proof tools

Each exits non-zero on failure. What a tool needs before it will run varies — a server already
listening, one it spawns for itself, or nothing at all — and the notes under the list say which
is which. `docs/proof-tools.md` says what else each one needs.

```
node tools/determinism-check.mjs                    # step 1: same program time, same image
node tools/determinism-check.mjs --clock --before HEAD~1
node tools/index-check.mjs --url http://localhost:8123   # step 2: index, hash, frame API
node tools/registry-check.mjs --url http://localhost:8080 # step 3: one registry, sliders as views
node tools/registry-check.mjs --mutate mix-ignores-normalisation  # ... and must FAIL mutated
node tools/registry-check.mjs --mutate rgb-contributes-no-alpha   # ... and must FAIL mutated
node tools/registry-check.mjs --mutate duotone-ignored            # ... the tonal transform the rest of the look sits on
node tools/registry-check.mjs --mutate duotone-ignores-depth      # ... and that it is keyed on depth, which is the whole claim
node tools/registry-check.mjs --mutate duotone-span-ignored       # ... the width of that key, promoted back to the literal it replaced
node tools/registry-check.mjs --mutate duotone-span-against-a-frozen-range # ... and that the width is metres, which only two clip ranges at once can see
node tools/registry-check.mjs --mutate duotone-hue-in-degrees     # ... a unit no picture comparison can see the shape of
node tools/registry-check.mjs --mutate vspeed-ignored             # ... the motion half of the same transform, and the speed it keys on
node tools/registry-check.mjs --mutate vspeed-unnormalised        # ... that the speed is a rate, which only two planted spans can see
node tools/registry-check.mjs --mutate vspeed-ignores-the-gate    # ... and that a jump past the snap threshold is a surface, not motion
node tools/registry-check.mjs --mutate vspeed-reads-one-texel     # ... and that it is a value per point, which a uniformly moving plant cannot see
node tools/registry-check.mjs --mutate motion-leaks-at-zero       # ... the default, which is the one place this term has to be exactly absent
node tools/registry-check.mjs --mutate spansec-nominal            # ... the gap it is divided by, taken off the transport rather than assumed
node tools/registry-check.mjs --mutate crush-ignored              # ... the toe, promoted to the literal it defaults to
node tools/registry-check.mjs --mutate crush-gates-the-grade      # ... and the one term in that pass that must not gate it
node tools/registry-check.mjs --mutate raster-recomputes-the-default # ... the raster's default path reached rather than recomputed, at the value the shipped look names
node tools/registry-check.mjs --mutate raster-ignores-angle       # ... the axis a raster runs along
node tools/registry-check.mjs --mutate raster-pitch-fixed         # ... its line frequency, promoted from the literal it defaults to
node tools/registry-check.mjs --mutate raster-hard-ignored        # ... and the duty cycle, without which an angle only buys rotated softness
node tools/registry-check.mjs --mutate glitch-axis-ignored        # ... the axis a tear's bands are cut along
node tools/registry-check.mjs --mutate lattice-ignored            # ... the grid the volume is rebuilt on
node tools/registry-check.mjs --mutate ripple-ignored             # ... the region's fourth reading
node tools/registry-check.mjs --mutate ripple-outside-the-gate    # ... and the gate that decides whether it is inert, which the sweep cannot see
node tools/registry-check.mjs --mutate ripple-clock-continuous    # ... its clock, which steps rather than breathes
node tools/registry-check.mjs --mutate streak-ignored             # ... the bleed, and whether it reaches a pixel at all
node tools/registry-check.mjs --mutate streak-ignores-angle       # ... and which way it runs, which the drop-one sweep cannot see
node tools/registry-check.mjs --mutate streak-angle-in-degrees    # ... in the unit no picture comparison can see the shape of
node tools/timeline-check.mjs --url http://localhost:8080 # step 4: seek equals playback
node tools/timeline-check.mjs --mutate preroll-constant   # ... and must FAIL mutated
node tools/timeline-check.mjs --mutate draft-always-resets # ... and must FAIL mutated
node tools/timeline-check.mjs --mutate reading-write-skips-repaint # ... and must FAIL mutated
node tools/keyframe-check.mjs --url http://localhost:8080 --take fixture-1g # step 5: tracks, retime curve, undo
node tools/keyframe-check.mjs --mutate pose-linear        # ... and must FAIL mutated
node tools/keyframe-check.mjs --mutate pose-ignores-ease  # ... the camera's handles, which shape when it arrives and never
                                                          #     where it goes. Separable from `pose-linear` on purpose and the
                                                          #     counts are how you tell: 4 rows here against that one's 6, and
                                                          #     every route row stays green, because a camera ignoring its
                                                          #     handles still travels the same curve at the wrong times
node tools/export-check.mjs --url http://localhost:8080   # step 6: resolution, export, the file
node tools/export-check.mjs --mutate pointsize-absolute   # ... and must FAIL mutated
node tools/export-check.mjs --mutate cropoutside-reaches-the-export # ... the crop box's faint pass, one edit from being in a deliverable
node tools/export-check.mjs --mutate faint-survives-at-zero # ... and a cut point kept at alpha zero, invisible and still occluding
node tools/export-check.mjs --mutate bloom-buffer-sized   # ... the glow's chain following the buffer, which is the only live catcher
                                                          #     in this suite for the reference the chain is frozen at. Its sibling
                                                          #     `bloom-reference-1080` is NOT caught by anything here and is not a
                                                          #     regression - `test/bloom-chain.test.mjs` is what holds that half,
                                                          #     and docs/instruments.md has the measurement
node tools/library-check.mjs                              # step 7: library, recorder, routes
node tools/library-check.mjs --mutate plant-open-take     # ... and must FAIL
node tools/library-check.mjs --mutate open-decides-its-own-reason  # ... one take, one refusal, whichever surface asks
node tools/library-check.mjs --mutate menu-decides-its-own-reason  # ... and the menu is a surface too
node tools/library-check.mjs --mutate refusal-without-a-badge      # ... a reason the server declares and no page can badge
node tools/library-check.mjs --mutate refusal-declared-but-never-pushed # ... and one nothing can ever earn
node tools/library-check.mjs --mutate openable-recomputes-the-band # ... and a band that decides for itself beside the table
node tools/library-check.mjs --mutate recording-decides-openable-itself # ... and the take being written, which answered twice
node tools/library-check.mjs --mutate node-admits-an-old-manifest  # ... a node one build behind, refused at the link
node tools/library-check.mjs --mutate node-admits-an-old-record-state # ... and behind on the other route, whose absent field is not an idle recorder
node tools/library-check.mjs --mutate badges-inherit-from-object   # ... and one build ahead, whose reason still badges
node tools/library-check.mjs --mutate refusals-must-be-nonempty    # ... and a healthy node not refused for being healthy
                                                                   #     (wide: takes the link off, so it stops at 125 of 392 -
                                                                   #      read the rows, not the total. docs/instruments.md says why)
node tools/library-check.mjs --mutate grid-declared-twice          # ... and the sensor grid stated once
node tools/library-check.mjs --mutate grid-declared-in-another-spelling # ... whatever notation the second one is in
node tools/library-check.mjs --mutate grid-declared-with-a-leading-dot # ... including the one with no leading digit
node tools/library-check.mjs --mutate grid-loses-a-dimension       # ... both halves of it, each asked for on its own
node tools/library-check.mjs --mutate tile-height-follows-content  # ... the gallery's geometry
node tools/library-check.mjs --mutate poster-height-in-js          # ... and its poster's box
node tools/library-check.mjs --mutate viewer-splat-one             # ... and the viewer's density
node tools/library-check.mjs --mutate gallery-has-no-way-back      # ... the way out
node tools/library-check.mjs --mutate plant-unswept-menu-item      # ... every control has a driver
node tools/library-check.mjs --mutate rename-ignores-hash          # ... rename, one term per mutation
node tools/library-check.mjs --mutate rename-orphans-marks         # ...
node tools/library-check.mjs --mutate rename-during-a-shoot        # ...
node tools/library-check.mjs --mutate rename-clobbers-under-a-race  # ... and two at once
node tools/library-check.mjs --mutate viewer-decides-for-itself    # ... one take, one set of actions, whichever surface
node tools/library-check.mjs --mutate viewer-drops-focus-on-rebuild # ... the arrows survive the rebuild they cause
node tools/library-check.mjs --mutate menu-close-strands-focus     # ... and a menu selection
node tools/library-check.mjs --mutate run-strands-focus            # ... and an action that held the surface down
node tools/library-check.mjs --mutate reveal-drops-the-path        # ... what the file manager was told
node tools/library-check.mjs --mutate reveal-answers-any-caller    # ... and who may start a process
node tools/library-check.mjs --mutate poll-refreshes-every-tick     # ... the gallery follows the recorder rather than the page load
node tools/library-check.mjs --mutate pulse-ignores-the-node        # ... and the recorder it follows is the one holding the sensor
node tools/library-check.mjs --mutate health-answers-beside-the-table # ... a route answering outside the table is one no sweep can see
node tools/library-check.mjs --mutate empty-window-keeps-its-start  # ... a window with no frames in it still closes
node tools/library-check.mjs --mutate respawns-count-a-colour-toggle # ... and a restart somebody asked for is not the sensor flapping
node tools/library-check.mjs --mutate respawns-dip-before-the-spawn  # ... and the count does not read low while that restart is in flight
node tools/library-check.mjs --mutate openpath-drops-at-the-stop     # ... a take is the recorder's until its index exists, not until it stops
node tools/library-check.mjs --mutate poll-first-tick-is-blind       # ... and the first tick answers against the grid already painted
node tools/library-check.mjs --mutate poll-forgets-a-failed-refresh  # ... and a refresh that failed leaves its transition unseen
node tools/library-check.mjs --mutate poll-ticks-overlap             # ... while one that has not come back is not asked again
node tools/library-check.mjs --mutate post-action-poll-discarded     # ... and a press asks again rather than taking the answer in flight
node tools/library-check.mjs --mutate listing-never-times-out        # ... and a listing nothing will answer frees itself
node tools/library-check.mjs --mutate delete-guesses-past-an-unreachable-node # ... a node that did not answer is not a node with nothing on it
node tools/library-check.mjs --mutate first-load-bounded       # ... a cold library is slow for a reason, and the load is not the poll
node tools/library-check.mjs --mutate first-load-strands-the-page  # ... and a first listing that fails leaves a page that still works
node tools/library-check.mjs --mutate listing-ignores-client-abort # ... a caller that gave up takes the node fetch with it
node tools/library-check.mjs --mutate cancel-watches-the-consumed-request # ... including on a route that read its body before asking
node tools/library-check.mjs --mutate listing-takes-a-refusal-as-a-library # ... and a refusal that parses is not a library
node tools/library-check.mjs --mutate faint-fixed-in-one-page       # ... one token, and the page that drifts is named
node tools/library-check.mjs --mutate extent-reads-one-frame        # ... the cloud's reach measured over the take rather than its first frame
node tools/library-check.mjs --mutate extent-cache-ignores-the-range # ... and cached against the depth range it was computed for
node tools/library-check.mjs --mutate write-overwrites-builtin # ... and must FAIL
node tools/library-check.mjs --mutate list-swallows-unreadable # ... and must FAIL
node tools/library-check.mjs --mutate open-take-swallows-library # ... and must FAIL
node tools/library-check.mjs --mutate one-refusal-for-older-versions # ... and must FAIL
node tools/library-check.mjs --mutate open-ignores-format          # ... the capture's generation, at all four doors at once
node tools/library-check.mjs --mutate shipped-look-drops-a-value   # ... a shipped look with a hole in it, which is the last look staying under the next one
node tools/library-check.mjs --mutate complete-look-drops-a-group  # ... and the definition those documents are written against, which is code where they are data
node tools/editor-check.mjs --url http://localhost:8080 --take fixture-1g # the editor's controls: that they exist, that pressing them changes something
node tools/editor-check.mjs --mutate export-name-not-taken --no-render # ... the output name read out of a deliverable
                                                                       #     and never written into one, which is the
                                                                       #     defect this branch shipped: the row walks it
                                                                       #     out to the server and back through an
                                                                       #     adoption, because a field read straight back
                                                                       #     proves only that an input holds text
node tools/editor-check.mjs --mutate aspect-skips-the-letterbox --no-render # ... the shape written into the document
                                                                       #     and the stage not framed to it, which is the
                                                                       #     one thing putting the shape on the document
                                                                       #     was for. Reads the stage's own box rather than
                                                                       #     the button that was just pressed, so a build
                                                                       #     that lights the control and reframes nothing
                                                                       #     fails here and passes on the attribute
node tools/editor-check.mjs --mutate lanes-clear-siblings --no-render  # ... and must FAIL
node tools/editor-check.mjs --mutate plant-unswept-control --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate ends-reaches-the-selection --no-render # ... `ends` shaping the selected key instead of the
                                                                       #     move's two ends, which is `smooth` under another
                                                                       #     name and halts the camera at an interior key
node tools/editor-check.mjs --mutate ends-skips-the-arrival --no-render # ... and reaching only the departure, which is half the
                                                                       #     reported defect surviving the fix for it
node tools/editor-check.mjs --mutate glide-is-a-cubic --no-render      # ... the quintic dropped to a cubic, whose rate still
                                                                       #     reaches zero at the key - so every velocity row stays
                                                                       #     green and only the degree is gone with the
                                                                       #     acceleration claim resting on it
node tools/editor-check.mjs --mutate elevation-moves-the-curve --no-render # ... `+pt` appending a control point rather than
                                                                       #     elevating, which is the one wrong implementation
                                                                       #     that leaves the count right and moves the camera.
                                                                       #     Only the sampled-curve row can see it, which is why
                                                                       #     that row samples the render instead of reading the
                                                                       #     handles back - every handle is meant to move
node tools/editor-check.mjs --mutate handle-clamped-to-the-segment --no-render # ... a control point clamped to the segment's ends
                                                                       #     rather than to its own neighbours, which was
                                                                       #     complete while a side held one point - then the
                                                                       #     neighbours *were* the ends - and lets two cross
                                                                       #     once a side holds more. Only a drag of a point
                                                                       #     that is not index 0 can see it
node tools/editor-check.mjs --mutate points-reach-the-retime --no-render # ... and the point controls offered on the retime,
                                                                       #     whose unit-box monotonicity proof is a proof about
                                                                       #     a cubic and nothing else
node tools/editor-check.mjs --mutate ease-gate-hardcodes-scalar --no-render # ... the ease gate naming one kind instead of asking
                                                                       #     the table, which is what locked the camera out
node tools/editor-check.mjs --mutate pose-segments-never-shaped --no-render # ... and a pose segment that never has a shape to
                                                                       #     edit, which is the NaN the old subtraction returned
node tools/editor-check.mjs --mutate pose-lane-draws-flat --no-render  # ... the lane's drawn curve, which every other pose row
                                                                       #     reads past on its way to the evaluator
node tools/editor-check.mjs --mutate pose-handle-overshoots --no-render # ... a pose handle leaving the unit box, which sends the
                                                                       #     camera past the pose it was keyed at
node tools/editor-check.mjs --mutate beads-evenly-spaced --no-render   # ... and the path's beads marking distance rather than
                                                                       #     time, which is an overlay that redraws the route
node tools/editor-check.mjs --mutate import-skips-normalise --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate import-saves-before-validating --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate picker-ignores-the-boxes --no-render # ... the subset a preset is written with
node tools/editor-check.mjs --mutate readings-tick-alone --no-render   # ... and the five weights that move as one
node tools/editor-check.mjs --mutate group-never-reveals --no-render      # ... a panel group is open because the clip says so
node tools/editor-check.mjs --mutate reveal-ignores-tracks --no-render    # ... and a keyframe counts where the value does not
node tools/editor-check.mjs --mutate override-prunes-only-on-toggle --no-render # ... and the override the document, not the toggle, has caught up with
node tools/editor-check.mjs --mutate panel-row-skips-parameter --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate nav-at-the-foot --no-render       # ... and must FAIL
node tools/editor-check.mjs --mutate panel-tabs-show-everything --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate dialog-close-strands-focus --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate obs-forgets-custom-resolution --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate orbit-pumps-on-change --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate camera-motion-keeps-history --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate orbit-uses-scrub-draft --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate orbit-arms-into-playback --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate orbit-arms-stale-position --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate release-seeks-past-target --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate pin-keeps-orbit-armed --no-render  # ... and must FAIL
node tools/editor-check.mjs --mutate camkey-takes-the-passing-pose --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate rate-holds-cuts --no-render       # ... and must FAIL
node tools/editor-check.mjs --mutate rate-holds-keys --no-render       # ... and must FAIL
node tools/editor-check.mjs --mutate undo-skips-cuts --no-render       # ... and must FAIL
node tools/editor-check.mjs --mutate zoom-about-centre --no-render     # ... and must FAIL
node tools/editor-check.mjs --mutate pointer-ignores-view --no-render  # ... and must FAIL
node tools/editor-check.mjs --mutate marks-ignore-view --no-render     # ... and must FAIL
node tools/editor-check.mjs --mutate mini-ignores-edges --no-render    # ... and must FAIL
node tools/editor-check.mjs --mutate splitter-unclamped --no-render    # ... and must FAIL
node tools/editor-check.mjs --mutate rail-ignores-scroll --no-render   # ... and must FAIL
node tools/editor-check.mjs --mutate splitter-forgets --no-render      # ... and must FAIL
node tools/editor-check.mjs --mutate mini-wheel-uses-ruler --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate shortcuts-ignore-consumed --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate rate-ends-on-change --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate takeover-ignored --no-render      # ... and must FAIL
node tools/editor-check.mjs --mutate wheel-ignores-deltamode --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate pan-keys-unbound --no-render      # ... and must FAIL
node tools/editor-check.mjs --mutate lanes-eat-touch --no-render       # ... and must FAIL
node tools/editor-check.mjs --mutate keys-yield-touch --no-render      # ... and must FAIL
node tools/editor-check.mjs --mutate deliverable-keeps-gesture --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate window-clamp-ratchets --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate detent-eats-loaded-rate --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate anchor-floors-to-frame --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate keyup-ends-any-gesture --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate pause-keeps-resume --no-render   # ... and must FAIL
node tools/editor-check.mjs --mutate bounds-compare-off-grid --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate detent-in-rate-units --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate zoom-pans-at-the-clamp --no-render # ... and must FAIL
node tools/editor-check.mjs --mutate tick-seeks-source-seconds --no-render # ... a mark tick seeks where it is drawn
node tools/editor-check.mjs --mutate offer-ignores-take-hash --no-render # ... the resume offer joins on footage, not on a name
node tools/editor-check.mjs --mutate resume-waits-for-every-list --no-render # ... and a broken neighbouring library does not strand it
node tools/editor-check.mjs --mutate resume-fetches-the-moving-name --no-render # ... and restores the document it offered, not what the name holds by then
node tools/editor-check.mjs --mutate resume-restores-without-keeping --no-render # ... and keeps it, so the recovery outlives the tab
node tools/editor-check.mjs --mutate shortcuts-reject-altgr --no-render # ... the mark keys work on the layouts that need AltGr to type them
node tools/editor-check.mjs --mutate marks-ignore-the-clip-range --no-render # ... and offer only the marks a trimmed clip can reach
node tools/editor-check.mjs --mutate tick-seeks-outside-the-trim --no-render # ... the ruler's ticks obey the same rule the keys do
node tools/editor-check.mjs --mutate beyond-mark-loses-focus --no-render # ... a mark past the end still answers a keyboard
node tools/editor-check.mjs --mutate clip-range-unclamped --no-render # ... a trim the program cannot hold
node tools/editor-check.mjs --mutate clip-bound-coerces-nonnumeric --no-render # ... and a trim that is not a time at all
node tools/editor-check.mjs --mutate refusal-strands-the-picker --no-render # ... and the menu that named what was refused
node tools/editor-check.mjs --mutate resize-skips-repaint --no-render # ... and the picture a resize clears
node tools/editor-check.mjs --mutate resume-races-the-autosave --no-render # ... the recovery is written after the edits already on the wire
node tools/editor-check.mjs --mutate restore-accepts-view-track --no-render # ... and a track the writer never writes
node tools/editor-check.mjs --mutate prune-ignores-movement --no-render # ... a stored collapse, against the boot it has to survive
node tools/editor-check.mjs --mutate panel-rederives-per-write --no-render # ... and what the panel costs the render path
node tools/editor-check.mjs --mutate envelope-unchecked --no-render     # ... the half of a preset document nothing used to read
node tools/editor-check.mjs --mutate reset-missing-on-a-row --no-render # ... a reset per look scalar, enumerated off the registry
node tools/editor-check.mjs --mutate reset-skips-a-tab --no-render      # ... and a whole inspector that lost them
node tools/editor-check.mjs --mutate reset-remembers-its-own-state --no-render # ... what a row offers, re-read rather than remembered
node tools/editor-check.mjs --mutate reset-collapses-the-slot --no-render # ... and the slot kept for it, so the row does not move
node tools/editor-check.mjs --mutate reset-strands-focus --no-render    # ... the caret after the press that removed its own control
node tools/editor-check.mjs --mutate reset-writes-around-the-registry --no-render # ... and a press that is a registry write rather than an assignment
node tools/editor-check.mjs --mutate format-segments-paint-the-press --no-render # ... the export format shown, read off the deliverable rather than off the last click
node tools/editor-check.mjs --mutate box-drag-pumps-renders --no-render # ... a crop face dragged out of the animation loop rather than out of its own handler
node tools/editor-check.mjs --mutate resize-ignores-the-dock --no-render # ... the picture drawn full height under a bar drawn over its last 72px
node tools/editor-check.mjs --mutate collapse-by-display --no-render   # ... and the panel a touchscreen could shut and never reopen
node tools/editor-check.mjs --mutate collapsed-keeps-the-editor-height --no-render # ... the collapsed panel's box, which two rules of equal weight decided by source order
node tools/editor-check.mjs --mutate collapsed-keeps-the-tab-rail --no-render # ... and the half of that a lower rule cannot fix, because `:not()` carries its argument's weight
node tools/editor-check.mjs --mutate dock-sensor-takes-the-centre --no-render # ... a dock button forwarding faithfully to the neighbouring control
node tools/editor-check.mjs --mutate dock-offers-the-take-on-the-editor --no-render # ... and `record` offered on the surface that never polls a recorder to paint it
node tools/editor-check.mjs --mutate fit-lands-after-history-begins --no-render # ... the box a take opens with, which is the clip rather than the first thing you can undo
node tools/editor-check.mjs --mutate fit-outlives-a-restored-project --no-render # ... and a document's own box, which only the ordering still protects
node tools/monitor-check.mjs                              # step 9: the monitor's decimation, the take it must not touch, and the picture it shows
node tools/monitor-check.mjs --mutate decimate-reaches-recorder  # ... and must FAIL mutated
node tools/monitor-check.mjs --mutate bind-ignores-grid          # ... and must FAIL mutated
node tools/monitor-check.mjs --mutate expand-shifts-by-a-block   # ... and must FAIL mutated
node tools/monitor-check.mjs --mutate colour-off-keeps-the-texture # ... the cloud stops wearing the last JPEG
node tools/sensor-view-check.mjs                          # the intrinsics a take was shot with, against a build that assumes them
node tools/sensor-view-check.mjs --mutate fov-hardcoded   # ... and must FAIL mutated
node tools/sensor-view-check.mjs --mutate no-repaint      # ... and must FAIL mutated
node tools/level-check.mjs                                # levelling: the room turns, and the crop, the top-down and the sensor view keep their meaning
node tools/level-check.mjs --mutate tilt-ignored          # ... and must FAIL mutated
node tools/level-check.mjs --mutate crop-follows-tilt     # ... and must FAIL mutated
node tools/level-check.mjs --mutate plan-ignores-tilt     # ... and must FAIL mutated
node tools/level-check.mjs --mutate plan-skips-vertical-crop # ... and must FAIL mutated
node tools/level-check.mjs --mutate region-follows-tilt   # ... and must FAIL mutated
node tools/level-check.mjs --mutate sensor-view-ignores-tilt # ... and must FAIL mutated
node tools/level-check.mjs --mutate level-order-swapped   # ... the pair's composition order, seen by the one surface that leans both ways
node tools/level-check.mjs --mutate reset-keeps-roll      # ... and must FAIL mutated
node tools/level-check.mjs --mutate plan-box-ignores-tilt # ... the crop box drawn in the room the shader deliberately does not test in
node tools/level-check.mjs --mutate crop-switch-reaches-only-the-shader # ... and the switch over it, asked of the reader that is not the shader
node tools/level-check.mjs --mutate x-not-mirrored        # the sensor's frames arrive mirrored, and the one fixture in the suite that is not symmetric about the optical axis
node tools/level-check.mjs --mutate plan-x-not-mirrored   # ... asked of the top-down too, because a sign fixed in the shader alone leaves the plan reflected
node tools/vcam-check.mjs                                 # the output to OBS: the colour camera, the take it must not touch, and the source's picture
node tools/vcam-check.mjs --mutate hd-upscales-registered # ... and must FAIL mutated
node tools/vcam-check.mjs --mutate hd-reencodes-in-flight # ... the bytes, where the picture is right
node tools/vcam-check.mjs --mutate hd-reaches-recorder    # ... and must FAIL mutated
node tools/vcam-check.mjs --mutate refusal-ignores-webcam # ... what the take is told the stream costs
node tools/guard-check.mjs                                # the socket's origin rule, the bind, and the rebinding rule
node tools/guard-check.mjs --mutate upgrade-skips-origin  # ... and must FAIL mutated
node tools/guard-check.mjs --mutate host-accepts-a-name   # ... and must FAIL mutated
node tools/jobs-check.mjs                                 # step 8: the queue, the pin, a real render, and a job
                                                          #   whose deliverable this build cannot read, which has to
                                                          #   come back failed rather than rendered - the batch path
                                                          #   adopted past the version gate until it did
node tools/jobs-check.mjs --mutate claim-ignores-renderer # ... and must FAIL mutated
node tools/module-check.mjs                               # the boundaries in web/: the import graph, what an import names, what crosses it
node tools/module-check.mjs --mutate cycle-planted        # ... the import web/scene.js's own header says does not exist
node tools/module-check.mjs --mutate cycle-through-a-second-spelling # ... and the same ring written the way the other page writes its imports
node tools/module-check.mjs --mutate import-of-a-missing-file # ... a specifier this server answers 404 for, which is a module that never evaluates
node tools/module-check.mjs --mutate import-names-a-missing-export # ... and a name the other side does not export, which fails before anything evaluates
node tools/module-check.mjs --mutate one-spelling-for-every-module # ... the fold onto one node, which only two spellings of one file exercise
node tools/module-check.mjs --mutate exported-mutable-object # ... a state object handed across a boundary with nothing saying why
node tools/module-check.mjs --mutate state-crosses-as-a-live-let # ... the same object under the one keyword that used to excuse it
node tools/module-check.mjs --mutate state-crosses-as-a-default # ... and in the export form that used to contribute nothing at all
node tools/module-check.mjs --mutate export-form-nothing-claims # ... an export spelling nobody thought of, named rather than dropped
node tools/module-check.mjs --mutate a-barrel-re-export        # ... and the barrel the one-implementation rule already refuses
node tools/module-check.mjs --mutate imported-object-written-across-the-boundary # ... and the write itself, into a binding this module does not own
node tools/module-check.mjs --mutate write-through-a-namespace # ... the same write where the far-side name is a property rather than a binding
node tools/module-check.mjs --mutate write-through-a-rename    # ... and under the rename a name collision is ordinarily resolved with
node tools/module-check.mjs --mutate write-from-a-page         # ... and from a page's inline module, which is a module like any other
node tools/module-check.mjs --mutate exemption-outlives-its-export # ... and the exemption table's own rot, which is what a list has instead of a bug
node tools/module-check.mjs --mutate exemption-covers-nothing  # ... its other half, which is the only thing standing over both rule 3 classifiers
node tools/module-check.mjs --mutate import-nothing-uses       # ... a name brought across a boundary that no line on this side reads, which is the defect this tool shipped
node tools/module-check.mjs --mutate import-used-under-its-far-side-name # ... asked of the binding an import makes rather than the name it asks for, which a rename separates
node tools/module-check.mjs --mutate export-nothing-imports    # ... and the other direction, a name let out that nothing anywhere asks for
node tools/module-check.mjs --mutate consumer-outside-web-drops-the-name # ... where the only reader is outside web/, and the join is per name rather than per module
node tools/module-check.mjs --mutate dead-import-is-not-a-consumer # ... and the two halves joined, so a dead import stops holding up the export on the far side of it
node tools/module-check.mjs --mutate outside-consumer-imports-a-name-it-never-reads # ... the use question asked of the importers outside web/, which used to enter the join unasked
node tools/module-check.mjs --mutate dead-bare-import          # ... and asked of a package name, the half of that row nothing controlled
node tools/module-check.mjs --mutate import-used-only-in-a-string # ... a use read at a code position rather than anywhere in the text
node tools/module-check.mjs --mutate import-used-only-as-an-object-key # ... and not in the one position this file is full of, a property key
node tools/module-check.mjs --mutate namespace-hides-a-dead-export # ... a namespace import asking for the names it reaches rather than for all of them
node tools/module-check.mjs --mutate namespace-reach-cannot-be-named # ... and a reach that names none of them, which costs an assertion rather than a blind module
```

`jobs-check` needs a GPU browser and ffprobe and renders one real job through
`tools/render-worker.mjs`; `--no-render` drops that row. **Six spawn their own servers and need
none running** — `guard-check` on 8321, `jobs-check` on 8231, `level-check` on 8377,
`monitor-check` on 8341, `vcam-check` on 8361, and `library-check` across the span described
below — so what each of those needs is a free port rather than a server, and the distinction is
not bookkeeping: a tool that finds a stranger already listening on its port is answered by the
stranger, and asserts against whatever fixture that process staged rather than the one this run
staged, which is a green run proving nothing. `sensor-view-check` does both — it takes `--url`
against a running server for most of its run and spawns a private one on 8131 for the section
that needs its own capture. `library-check` is the only one of any of them that asks the kernel
first and refuses, so everywhere else the `pgrep` below is the check. `export-check` needs
ffmpeg and ffprobe.
`level-check` needs neither a sensor nor a capture — it plants analytic planes straight into
the depth texture, which is what lets it grade the plane fit against a normal it chose.
**`module-check` needs nothing at all** — no port, no browser, no install — because every
failure it is about is a failure to *boot*, and an instrument that needs the page running
cannot see one. It reads `web/` off disk and refuses a tree with an import cycle in it, an
import naming a file or an exported name that is not there, state crossing a boundary as an
object anybody can write into, or a name crossing one that only one end wanted - a dead
import, or an export nothing imports. That last pair reads **every JavaScript file in the
checkout** rather than only `web/`, because seven of this tree's exports have their only
reader in `server/`, `tools/` or `test/` and a row scoped to `web/` reddens all seven on a
healthy tree — and it asks its use question of those outside importers too, because the two
halves are one question and **a dead import is not a consumer**, which is the shape that let
`web/curve.js::easeSlopeAt` sit exported to nothing while the tool printed the export row
green. **What it does not test is the intra-module dead zone**,
which is the fault `web/main.js` has actually shipped twice: that reach runs through property
dispatch and is not statically decidable, so it belongs to a post-boot state diff rather than
to a source scan, and the tool says so in its own output rather than leaving it to be
assumed.

**`library-check` binds a span of fixed ports** — `--node-port`, and `--mac-port` through
`--mac-port + 16`, which default to 8210 and 8211..8227. It checks the whole span before it
spawns anything and **exits 2 naming what is held**, because the old failure was silent: two
worktrees running at once did not collide, they shared a server, and the suite asserted
against the other tree's fixture. Pass a range nothing else holds, and check
`pgrep -f "tools/.*-check.mjs"` first, because on this machine another agent's run is the
normal state.

The two below need no server, and `registration-check` needs no sensor either - it runs on a
corpus of `Registration::apply` inputs dumped by `grabber --dump-corpus`.

```
node tools/vendor-check.mjs                          # third_party is upstream v0.2.1 + declared edits
node tools/vendor-check.mjs --mutate oracle-drift    # ... and must FAIL mutated
node tools/registration-check.mjs                    # our registration == upstream's, bit for bit
node tools/registration-check.mjs --mutate one-lsb   # ... and must FAIL mutated
```

The two below are two of CI's three jobs. `syntax-check` needs nothing at all;
`release-gate-check` needs the registry and exits 2 when it cannot reach it, because it proves
the gate by npm's refusal rather than by reading a config key. The third is `npm run test:unit`,
which is `test/` rather than `tools/` and so is not in the arithmetic below — it needs no server,
no sensor and no browser, but it **does need `npm ci`**, and that changed with the extraction
rather than being true all along. Four of the modules taken out of `web/main.js` return
three.js types they exist to build — `world-tilt` a Quaternion, `plan-geometry` a Vector3,
`gpu-textures` a DataTexture, `bloom-pass` a Pass — so a node test of them cannot resolve
`three` out of a tree holding only source. Measured on the first push after the extraction:
`ERR_MODULE_NOT_FOUND: Cannot find package 'three'`, 47 tests, 4 failed, on all four CI arms
while the same suite ran 68 green locally against an installed tree. `test/runner-control.test.mjs`
is its control:

```
node tools/syntax-check.mjs                          # every JS file this repo ships parses, and the two
                                                     #   constants the two languages cannot share agree
node tools/syntax-check.mjs --mutate spec-drifts     # ... and the .knct decoder specification must FAIL when a constant moves under it
node tools/syntax-check.mjs --mutate shell-id-renamed # ... and a surface whose shell drives an id the markup stopped declaring
node tools/syntax-check.mjs --mutate shell-key-undeclared # ... and the other direction, which is the one a merge produces
node tools/syntax-check.mjs --mutate web-citation-outlives-its-module # ... and a module this repo's own prose names, renamed to something the tree does not hold
node tools/syntax-check.mjs --mutate line-citation-past-the-end # ... and the line half of that, which rots without the path rotting
node tools/syntax-check.mjs --mutate citation-outside-the-prose # ... and one written in the C++, which is the half of the tree the walk used to skip
node tools/release-gate-check.mjs                    # the .npmrc supply-chain gate is actually armed
node tools/release-gate-check.mjs --mutate wrong-unit # ... and must FAIL (also: no-gate, absent)
```

And the ones that are not proof tools, listed because a tool nobody documented is a tool
nobody runs. **`syntax-check` enforces that list**: anything in `tools/` this file does not
mention fails it, so a tool added next year is asked by existing. The arithmetic, written
down because a count nobody adds up is how this list rotted the first time: `tools/` holds
**29** files, of which **19** are `*-check` proof tools and **10** are the block below.

```
node tools/convert-presets.mjs presets projects jobs # version 3 documents -> version 4, in place
node tools/build-native.mjs        # builds libfreenect2 into vendor/prefix, then the grabber
node tools/fake-grabber.mjs        # a grabber that needs no sensor, for driving the server
node tools/make-fixture.js         # loops one short capture into an arbitrarily long one
node tools/sweep-all.mjs           # every mutation of four tools; needs a server and hours
node tools/settle-probe.mjs        # does settle()'s drain scale with the take or the ceiling
node tools/prof-summary.mjs        # reads grabber --profile output, flags contended runs
node tools/render-worker.mjs       # renders one queued job; jobs-check drives it
tools/monitor-cost-ab.mjs          # the monitor's cost on a capture node, over SSH
tools/pi-registration-ab.sh        # the threading A/B runbook for a capture node
```

`captures/` is gitignored; `make-fixture` regenerates what the suite needs, and **the sample it
loops was shot on a degraded link at about 9.3fps**, so size fixtures by frame count rather
than by duration. **`editor-check` and `keyframe-check` need a take of at least 32s and 24s and
exit 2 naming the shortfall**, because on the short sample they redden ten rows and four about
a build with nothing wrong with it, and green two more against a gesture that never happened.
Their control is `--take sample`. The `--take fixture-1g` those two command lines name is not in
a checkout either — make it first, and the two of them are the only reason it is 8 loops:

```
node tools/make-fixture.js captures/sample.knct captures/fixture-1g.knct --loops 8
```

See `docs/proof-tools.md`.

## Three things that are easy to get backwards

**A render moves the camera, so rendering in answer to a camera event is a loop.**
`renderProgramFrame` runs `advanceNavigation`, which calls `controls.update()`, which fires
`change` on a damped control that moved — so a handler that renders on `change` has asked for
the next render, and with the playhead parked there is no frame clock to pace it. That shipped:
one pointer move on a paused orbit cost 34 rebuilds and the drag ran at 12fps while rendering
190. Arm a redraw request and let the animation loop pump it; **nothing may start a redraw except
the loop**. `editor-check` section 9 counts navigation redraws against animation frames, with
`--mutate orbit-pumps-on-change` as its control.


**`nearClip`/`farClip` versus `--min-depth`/`--max-depth`.** The first pair are viewer
uniforms that hide points which already arrived. The second pair are grabber flags that clip
on the GPU before the frame is built, so they decide what exists at all. The recorder's
preview range drives the first and **must never reach the second** — getting it backwards
silently destroys footage in the one situation where nobody is watching for it.

**`fs.readFileSync` throws above 2 GiB** (`ERR_FS_FILE_TOO_LARGE`; 2,147,483,647 reads,
2,147,483,648 throws). Anything that reads a capture streams. `server/capture.js` is the only
thing that should be touching capture bytes.

## Conventions

- **No emojis in debug or console messages.**
- **One implementation only.** No legacy path left beside a new one, no compatibility flag to
  switch between them — a second path that drifts is the failure this design keeps rejecting.
- Comments explain *why*, usually by naming the failure mode being avoided, in flowing prose.
  Match the density and voice already in the file.
- Commits: imperative subject, then a body explaining the why and carrying the measurements
  with their methods.
- **`pointSize` is pixels at 1080p**, and every screen-space term with it. A project saved
  before step 6 needs its point size scaled by the buffer height it was authored at, and
  `registry-check` asserts the 1080/600 rebase factor rather than skipping the value, so a
  preset re-tuned by hand to something near it fails.
- **1080p is the unit; 600 is bloom's frozen chain; both are correct and do not reconcile
  them.** Every screen-space term is *expressed* against 1080p, which is why the cloud's
  shaders in `web/cloud-shader.js` read `bufferHeight / 1080.0`. Bloom has no parameter to
  express, because `UnrealBloomPass` bakes its tap count in at construction, so its mip chain
  is instead frozen at the 600-tall buffer the look was graded on: `bloomChainSize` computes
  `refWidth = (bufferWidth / bufferHeight) * 600` and then sets the chain at half of it,
  `setSize(aspect * 300, 300)`. Neither reference is a typo for the other, and the mechanism
  is the reason - the halo's width is a tap count over a texel count, so a chain with 1.8x
  the texels has a halo 1.8x tighter, constant at last and constant at a glow nobody tuned.
  Measured: a 1080-frozen chain lands 7.16/255 off the graded look on the worst of forty
  tile means where the 600-frozen one lands 1.10. The comment above `bloomChainSize` in
  `web/bloom-pass.js` carries the rest, including the undersampling gap above 1200 that
  nothing has measured, and `test/bloom-chain.test.mjs` holds the arithmetic to it under
  bare node.

## Process hygiene

Kill only your own listener, and **by PID resolved as a listener**:

```
for p in $(lsof -ti tcp:8080 -sTCP:LISTEN); do kill "$p"; done
```

A bare `lsof -ti tcp:8080` also matches processes *connected to* the port, and `pkill -f`
matches the shell running your own command.

**Never `git stash` in a worktree of this repo.** The stash is a single ref in the shared
`.git`, so every worktree pushes onto one stack. A session here stashed to take a baseline
measurement, a concurrent session in `ridgehead` stashed ninety seconds later, and the pop
restored *ridgehead's* `server/index.js` into this tree while orphaning six files of this
one's — silently, because the pop was redirected to `/dev/null` and only its exit code would
have said so. Nothing is lost when it happens, since the stash commits survive as unreachable
objects (`git fsck --unreachable`, then read `%s` for `On <branch>:` and take `^3` for the
untracked file), but the recovery is long and the interference runs both ways. To take a
baseline, copy the modified files somewhere outside the repo, `git checkout --` them, measure,
and copy them back.
