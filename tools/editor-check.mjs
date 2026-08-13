// Proves the editor's interaction layer: that its controls exist, that pressing them
// changes something, and that the set of controls it has is the set this file knows
// how to drive.
//
// **This tool exists because the suite tested the model and never the control.** The
// clip in/out markers - `#tIn` and `#tOut`, the only way to trim what an export
// contains - were being detached from the document during boot. `rebuildLanes`
// cleared `#tBeds` of every child that was neither `.ruler` nor the playhead, and the
// two markers were neither, so they went on the first rebuild and never came back.
// Nothing noticed for the length of the feature's life: `clipIn`/`clipOut`,
// `setClipInOut`, `activeDeliverable.in/out` and the frame arithmetic in `exportClip`
// were all correct, `export-check` drove in/out through `activeDeliverable`, and
// `paintTimeline` went on writing `style.left` onto two nodes no document contained.
// **No proof tool in this repo referenced `#tIn`, `#tOut` or `.tcut` at all.** That is
// `docs/instruments.md`'s "is there an object here that every observation happens to
// skip", one step further on than the version already recorded there - here the
// skipped object was not an excluded file but a control the interface tells the user
// it has.
//
// So the organising rule of this file is two things at once:
//
//   1. **Drive the real control and assert an observable consequence.** Not "the
//      button is in the DOM" - the playhead moved, the key count fell, the range
//      changed, the bytes on disk match. A row that asserts DOM state after an
//      interaction would pass on a build where the interaction did nothing.
//
//   2. **Enumerate rather than list.** Section 1 walks every interactive control the
//      editor actually renders and requires each to be covered by an entry in
//      `DRIVERS`. A control with no entry is a failure, not a skip, so a control
//      added later is asked about by existing. `library-check` reached the same shape
//      for HTTP routes after individual poking found six mutating routes out of ten.
//      The falsification control for that claim is `plant-unswept-control`, which
//      adds a button and must redden section 1 - without it, "every control was
//      tested" is an assertion this file makes about itself.
//
//   3. **And enumerate from both ends, because the panel is generated now.** The rule
//      above catches a control nothing drives. It cannot catch a control that is
//      *missing*: the sweep is over what the page renders, so a parameter whose row
//      never got built is not an uncovered control, it is an absence, and every row
//      here would go on passing while a look value had no way to be reached. `main.js`
//      refuses to boot when the generator's row count comes out short - but a build's
//      own tripwire cannot be the only evidence its own generator is right, so the
//      count is recomputed here from the registry and diffed against the sweep by name.
//      `panel-row-skips-parameter` is that claim's control.
//
//   node server/index.js &
//   node tools/editor-check.mjs --url http://localhost:8080 --take sample
//   node tools/editor-check.mjs --mutate plant-unswept-control --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate panel-row-skips-parameter --no-render # must FAIL
//   node tools/editor-check.mjs --mutate lanes-clear-siblings  --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate rate-holds-program    --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate space-unbound         --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate delete-ignores-selection --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate ease-handles-on-flat  --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate ease-preset-ignored   --no-render  # must FAIL
//   node tools/editor-check.mjs --mutate ease-gate-hardcodes-scalar --no-render # must FAIL
//   node tools/editor-check.mjs --mutate pose-segments-never-shaped --no-render # must FAIL
//   node tools/editor-check.mjs --mutate pose-handle-overshoots --no-render # must FAIL
//   node tools/editor-check.mjs --mutate beads-evenly-spaced --no-render # must FAIL
//   node tools/editor-check.mjs --mutate pose-lane-draws-flat --no-render # must FAIL
//   node tools/editor-check.mjs --mutate scroller-cannot-shrink --no-render # must FAIL
//   node tools/editor-check.mjs --mutate camera-motion-keeps-history --no-render # must FAIL
//   node tools/editor-check.mjs --mutate orbit-uses-scrub-draft --no-render # must FAIL
//   node tools/editor-check.mjs --mutate orbit-arms-stale-position --no-render # must FAIL
//   node tools/editor-check.mjs --mutate release-seeks-past-target --no-render # must FAIL
//   node tools/editor-check.mjs --mutate pin-keeps-orbit-armed  --no-render # must FAIL
//   node tools/editor-check.mjs --mutate note-skips-title       --no-render # must FAIL
//   node tools/editor-check.mjs --mutate tick-seeks-source-seconds --no-render # must FAIL
//   node tools/editor-check.mjs --mutate offer-ignores-take-hash --no-render # must FAIL
//   node tools/editor-check.mjs --mutate resume-waits-for-every-list --no-render # must FAIL
//   node tools/editor-check.mjs --mutate shortcuts-reject-altgr --no-render # must FAIL
//   node tools/editor-check.mjs --mutate clip-range-unclamped   --no-render # must FAIL
//   node tools/editor-check.mjs --mutate clip-bound-coerces-nonnumeric --no-render # must FAIL
//   node tools/editor-check.mjs --mutate refusal-strands-the-picker --no-render # must FAIL
//   node tools/editor-check.mjs --mutate resize-skips-repaint   --no-render # must FAIL
//   node tools/editor-check.mjs --mutate restore-accepts-view-track --no-render # must FAIL
//   node tools/editor-check.mjs --mutate dialog-close-strands-focus --no-render # must FAIL
//   node tools/editor-check.mjs --mutate obs-forgets-custom-resolution --no-render # must FAIL
//   node tools/editor-check.mjs --mutate reset-missing-on-a-row --no-render # must FAIL
//   node tools/editor-check.mjs --mutate reset-skips-a-tab      --no-render # must FAIL
//   node tools/editor-check.mjs --mutate reset-remembers-its-own-state --no-render # must FAIL
//   node tools/editor-check.mjs --mutate reset-collapses-the-slot --no-render # must FAIL
//   node tools/editor-check.mjs --mutate reset-strands-focus     --no-render # must FAIL
//   node tools/editor-check.mjs --mutate reset-writes-around-the-registry --no-render # must FAIL
//   node tools/editor-check.mjs --mutate export-ignores-name              # must FAIL
//
// `--no-render` drops the real-export rows and says so in the verdict, the way
// `jobs-check` does. The queue-shaped mutations do not touch the encoder, so their
// runs are seconds instead of a minute.
//
// Exit 1 means a claim failed. Exit **2** means the harness did not run - no server,
// a mutation whose anchor no longer matches, a mutation the page never asked for, a
// crash. That split is not decoration:
// a stale anchor exiting 1 reads identically to a mutation caught, and this repo has
// already recorded a tool exiting non-zero with zero failed assertions being written
// down as a bug found. **Count the failed assertions and read which ones fired.**

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { PROJECT_VERSION } from '../web/format.js';
// The server's own validator, imported rather than re-stated. The export dialog's
// format segments carry their codec in an attribute, and the question "is this a codec
// the encoder will take" has exactly one answer in this repo - `validateExport`, which
// both the socket's `begin` and `POST /jobs` call. A list of codec names retyped here
// would be a third copy that can drift from both, and a typo in the markup would then
// be discovered a minute into a render instead of by this row.
import { validateExport } from '../server/export.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const REPO = fileURLToPath(new URL('..', import.meta.url));
// Section 9 writes preset files and catches a download. Outside the repo, because a
// proof tool that writes into its own subject makes every later run untrustworthy -
// the same reason the staged tree exists in `library-check`.
const TMP = mkdtempSync(join(tmpdir(), 'editor-check-'));
const URL_BASE = flag('--url', 'http://localhost:8080');
const EDITOR_PATH = '/edit';
// `sample` rather than a dated take id, because the default has to name something
// that can exist on a machine that is not this one. A recorder-issued id carries
// the day it was shot - `2026-08-02-take1` was the default here, and it resolves
// only on the machine that recorded it, on that date. Everywhere else the tool
// spent thirty seconds waiting for a take the server answers 404 for and then
// exited 2, which is the honest code but a wasted run and a confusing message.
// `sample` is the name `npm run replay` and `make-fixture.js` already assume.
const TAKE = flag('--take', 'sample');
const HEADED = argv.includes('--headed');
const MUTATE = flag('--mutate');
const NO_RENDER = argv.includes('--no-render');
// The window every layout row is measured at. 1512 is the laptop this is documented
// to run on and the width at which the render button was measured 82px off the right
// edge; the other two are there because one width cannot tell a bar that fits from a
// bar that happens to fit.
const WIDTHS = [1512, 1280, 1100];
const VIEWPORT = { width: 1512, height: 900 };

// ------------------------------------------------------------------- mutations

const MUTATIONS = {
  // ---- section 21, the collapsed panel and its dock ----
  //
  // The picture drawn full height under a bar drawn over it. `resize()` stops taking the
  // dock off the available height, so the frame keeps the size it had and the buttons
  // are composited on top of its last 72px - which reads as working, because the panel
  // collapses, the dock appears and every control still answers. Only the geometry says
  // otherwise, and the bottom of the frame is the part an operator framing a shot is
  // most likely to be looking at.
  //
  // Must redden: 'the picture ends exactly where the dock begins'.
  'resize-ignores-the-dock': {
    file: 'web/main.js',
    edits: [["    ? document.getElementById('panelDock')?.offsetHeight ?? 0\n", '    ? 0\n']],
  },

  // The panel that did not come back, which is the bug the class replaced rather than a
  // hypothetical: `H` sets an inline `display: none` on `#panel` and nothing else can
  // read it, so the bar's toggle no longer shares a state with the key and a touchscreen
  // - which has no key to press a second time - is left with the settings gone for good.
  //
  // Must redden: the H round trip, and the row that reads the toggle's `aria-pressed`
  // after the key moved the panel. Note the collapse *itself* still appears to work from
  // the toggle, which is what made this survivable long enough to ship.
  'collapse-by-display': {
    file: 'web/main.js',
    edits: [[
      "    setPanelCollapsed(!document.body.classList.contains('panelcollapsed'));\n    return;",
      "    const p = document.getElementById('panel');\n"
      + "    p.style.display = p.style.display === 'none' ? '' : 'none';\n    return;",
    ]],
  },

  // The cascade bug as its own control, and it is a bug being put back rather than
  // invented: the editor's expanded-column height matches `body.panelcollapsed #panel`
  // at exactly the same weight, so with this rule gone the later one wins and a
  // collapsed editor keeps a 692px panel - reaching from y=208 to the foot of the
  // window, translucent over two thirds of the picture, with the dock's buttons floating
  // in the middle of the stage. Measured at 1512x900 on the build that shipped it.
  //
  // Must redden three, and the third was not predicted when this was written. The two
  // expected ones are the box rows - 'the picture ends exactly where the dock begins'
  // and 'it clears the timeline strip'. The third is 'a press at the middle of a dock
  // button reaches that button', which names `tRuler` as what takes the press instead,
  // and it is the one that says what the bug costs an operator rather than what it
  // measures: the timeline is written later at the same `z-index`, so it is on top, and
  // the dock is a row of buttons nothing can press. Before that row existed this
  // mutation ended the file as a crash - a real click on a covered element retries for
  // thirty seconds and throws - which is a catch that reads as a broken harness.
  'collapsed-keeps-the-editor-height': {
    file: 'web/index.html',
    edits: [[
      '  body.editing.panelcollapsed #panel {\n    height: auto;\n'
      + '    bottom: calc(var(--timeline-h) + var(--tlanes-h));\n  }\n', '',
    ]],
  },

  // The other half of the same cascade, and the one that cannot be fixed by moving a
  // rule: `body.editing #panelTabs:not([hidden])` carries the weight of its `:not`
  // argument, so a one-class mode rule loses to it wherever either sits. Weakened back,
  // the collapsed panel keeps the inspector's 30px tab rail in a strip above the dock,
  // over the bottom of the frame - a control the operator did not ask for and cannot use
  // with the inspector shut.
  //
  // Must redden: 'with nothing but the dock left in the collapsed panel', at 31px slack.
  'collapsed-keeps-the-tab-rail': {
    file: 'web/index.html',
    edits: [[
      '  body.panelcollapsed #panelTabs:not([hidden]) { display: none; }',
      '  body.panelcollapsed #panelTabs { display: none; }',
    ]],
  },

  // The take pair back on the surface that has no recorder, which is the bug this diff
  // shipped rather than one invented for a control. The editor hides the whole Record
  // tab, so its panel offers neither button; the dock offered both, and offered them
  // over a `recordState` nothing on that surface ever writes - `askRecordState` is
  // assigned only on the live branch. So the button says `record` for the session
  // whatever the node is doing, no refusal ever reaches it, and pressing it still posts
  // `/record/start`.
  //
  // Must redden: 'offers neither of the two that act on the take'. It must NOT redden
  // the row above it, which is what says the two view controls are still there - a
  // mutation that took the whole dock away would redden both and would not be this.
  'dock-offers-the-take-on-the-editor': {
    file: 'web/index.html',
    edits: [['  body.editing #dockRec,\n  body.editing #dockMark { display: none; }\n', '']],
  },

  // A dock button wired to the wrong control, which is the failure a forwarding
  // assertion cannot see: the press is forwarded faithfully, to the neighbour. `sensor`
  // is the one that matters for the thing the dock was built for - it is the pose you
  // frame a shot from - and centring instead leaves the operator looking at the room
  // from the outside while the button reports having worked.
  //
  // Must redden: 'the dock\'s sensor lands the pose Framing\'s own sensor view lands'.
  'dock-sensor-takes-the-centre': {
    file: 'web/main.js',
    edits: [[
      "shell.dockSensor.addEventListener('click', () => ui.camSensor.click());",
      "shell.dockSensor.addEventListener('click', () => shell.cameraReset.click());",
    ]],
  },

  // The falsification control for section 1, and the only one that is not a bug being
  // put back. A button nobody has taught this file to drive must be a failure rather
  // than a control that quietly went unswept, or "every control was tested" is a
  // sentence this tool writes about itself with nothing enforcing it.
  // Import writes the file's values straight at the uniforms instead of through the
  // registry. The control for section 9's two refusal rows: a file is the one door
  // into this program that nothing upstream validates, so "a hand-edited preset cannot
  // put a wrong image on screen" rests entirely on `params.apply` meeting every value.
  // The mutated build accepts a string where a scalar belongs and accepts a key called
  // `__proto__`, and both rows have to go red - a build that only caught one of them
  // would mean the other row was being carried by the first.
  // Both anchors moved when the import path was split into a refusal taken before the
  // PUT and an apply taken after it, and the mutation has to remove *both* halves to
  // still be the bypass it names: dropping only the apply leaves `refusePresetBody`
  // normalising every value ahead of the store, which is the check under test wearing
  // a different name. So the guard goes and the apply becomes a raw walk onto the
  // uniforms, which is the shape a build that never learned about the registry has.
  'import-skips-normalise': {
    file: 'web/main.js',
    edits: [
      ['  refusePresetBody(name, body);\n', ''],
      [
        '  applyStoredPreset({ name: saved.name, rev: saved.rev, body });',
        '  for (const [k, v] of Object.entries(body.values ?? {})) {\n'
        + '    if (globalThis.__kinect?.uniforms?.[k]) globalThis.__kinect.uniforms[k].value = v;\n'
        + '  }\n'
        + '  appliedPreset = { name: saved.name, rev: saved.rev };',
      ],
    ],
  },

  // The control for the row that asks the *store* rather than the page. It keeps the
  // refusal and only moves it: the console still names the wrong key and the look still
  // does not move - both of the observations that row used to be surrounded by - while
  // the malformed preset is now a document in the library. That is what makes it the
  // right control rather than a second copy of `import-skips-normalise`, which removes
  // validation altogether and therefore reddens the rows that read the refusal instead.
  //
  // Must redden: the two rows that ask the store after a refusal - "a refused file never
  // reaches the library" for the malformed one, and the same question asked of the file
  // carrying a stray top-level key. Both, and only those. The second arrived with the
  // envelope check and is the same claim at a second door rather than a cascade: this
  // mutation moves the refusal after the PUT for every refused file at once, so a row
  // that asks the store about any of them has to notice. Measured: `caught, as required
  // (2 assertions fired)`.
  // The second anchor is the whole three-line tail rather than the `res.json()` line it
  // used to name: that line appears four times in `main.js` and the tool refused the
  // mutation outright, which is the refusal doing its job and worth not weakening.
  'import-saves-before-validating': {
    file: 'web/main.js',
    edits: [
      ['  refusePresetBody(name, body);\n', ''],
      [
        '  const saved = await res.json();\n'
        + '  if (saved.error) throw new Error(saved.error);\n'
        + '  applyStoredPreset({ name: saved.name, rev: saved.rev, body });',
        '  const saved = await res.json();\n'
        + '  if (saved.error) throw new Error(saved.error);\n'
        + '  refusePresetBody(name, body);\n'
        + '  applyStoredPreset({ name: saved.name, rev: saved.rev, body });',
      ],
    ],
  },

  // A mark tick seeks to the mark's own source second instead of the program second
  // the drawing code clamped it to, which undoes the retime the tick was positioned
  // through. The two coincide exactly at rate 1 with no keys, so the row that drives
  // this **must** establish a non-unity rate first or the mutation is invisible and
  // the control proves nothing - section 13 asserts the separation before it presses.
  //
  // The click handler alone, so `markSecondsInOrder` is untouched and the two keys go
  // on jumping correctly. A mutation that took the whole control away would redden the
  // key rows and the section 1 sweep as well, and then "the seek is wrong" would not
  // be what the run had shown.
  'tick-seeks-source-seconds': {
    file: 'web/main.js',
    edits: [[
      '      goTo(at);',
      '      goTo(mark.sourceMs / 1000);',
    ]],
  },

  // The resume offer joins the working document to a take by id rather than by hash.
  // A rename frees the old id and a later take can be renamed into it (#13), so an id
  // match is a claim about a name where a hash match is a claim about footage - and
  // the offer this makes is somebody's edit put back on top of material it was never
  // authored against.
  //
  // Must redden: section 13's "no offer for a working document belonging to different
  // footage". The row asserting the offer *is* made on a hash match stays green, since
  // a mutation that suppressed the offer outright would pass the first row for exactly
  // the wrong reason.
  'offer-ignores-take-hash': {
    file: 'web/main.js',
    edits: [[
      '  if (!openTakeHash || working.body?.take?.hash !== openTakeHash) return;',
      '  if (!openTakeId || working.body?.take?.id !== openTakeId) return;',
    ]],
  },

  // The autosave offer goes back to being withheld whenever any part of the library
  // failed to list. That gate was right while the offer was a sentence on the application
  // bar's message chip, which would have painted over the sentence naming what broke - and
  // wrong the moment it became a button, since a button overwrites nothing and what the gate now
  // does is throw away the only control that reaches `__working__`, a document the
  // project picker deliberately does not show, because an unrelated presets directory
  // was pointed one level too high.
  //
  // Must redden only the row about a broken neighbour. Every other row in section 13
  // lists cleanly, so the gate and the fix agree across all of them - which is exactly
  // how this survived a section that had already asserted the offer twelve ways.
  // The resume chip goes back to fetching `__working__` when it is pressed, rather than
  // restoring the document it was offering. That name is rewritten by `history.commit()`
  // on every edit, so a nudge of any control between the offer appearing and the button
  // being pressed means the press restores the nudge and reports it as a recovery - with
  // the work it was advertising already overwritten.
  //
  // Must redden only the row that moves the document under the offer. Every other resume
  // row presses the chip with nothing having touched the store in between, where fetching
  // the name and holding the body give the same answer - which is how this survived a
  // section that already presses the chip and reads the restored document back.
  'resume-fetches-the-moving-name': {
    file: 'web/main.js',
    edits: [[
      '    await loadProjectNamed(WORKING_PROJECT, accepted);',
      '    await loadProjectNamed(WORKING_PROJECT);',
    ]],
  },

  // The accepted snapshot is applied and then dropped without being written back, so the
  // recovery lives only in the tab: `__working__` still holds the edit that overwrote the
  // offer, and a reload after being told "restored" loads that edit back.
  //
  // The write and not the capture, because `resume-fetches-the-moving-name` already takes
  // the capture. Must redden only the row that reads the store after the press.
  // The recovery write goes back to racing the auto-saves instead of queueing behind
  // them, so an edit still on the wire can land after it and put itself back.
  'resume-races-the-autosave': { file: 'web/main.js', edits: [[
    'const kept = await writeWorking(accepted);',
    "const kept = await fetch(`/projects/${WORKING_PROJECT}`, {\n"
    + "      method: 'PUT',\n      headers: { 'Content-Type': 'application/json' },\n"
    + '      body: JSON.stringify(accepted),\n    });',
  ]] },

  'resume-restores-without-keeping': {
    file: 'web/main.js',
    edits: [[
      '    const kept = await writeWorking(accepted);\n'
      + "    if (!kept.ok) throw new Error(`restored on screen, but the auto-save could not be rewritten: ${(await kept.text().catch(() => '')).slice(0, 80)}`);\n",
      '',
    ]],
  },

  'resume-waits-for-every-list': {
    file: 'web/main.js',
    edits: [[
      '  if (listed.projects) offerWorkingDocument(listed.projects);',
      '  if (!unavailable.length) offerWorkingDocument(listed.projects);',
    ]],
  },

  // AltGr goes back to being read as the ctrl+alt it arrives as. On a German, Nordic or
  // Polish layout `[` and `]` are AltGr presses and Windows delivers AltGr by setting
  // both of those bits, so the modifier guard returns before the mark-stepping keys can
  // run and this program advertises two shortcuts nobody on those layouts can press.
  //
  // Must redden the AltGr row and leave the row beside it - plain ctrl+alt on a layout
  // that needs no composing, which is still not ours - green. A mutation that only
  // widened the guard would pass the first and fail the second, which is why both are
  // there.
  'shortcuts-reject-altgr': {
    file: 'web/main.js',
    edits: [[
      "  const composed = e.key.length === 1 && e.getModifierState('AltGraph');\n"
      + '  if ((e.metaKey || e.ctrlKey || e.altKey) && !composed) return;',
      '  if (e.metaKey || e.ctrlKey || e.altKey) return;',
    ]],
  },

  // The mark keys go back to offering every mark on the take, including the ones the
  // trim puts out of reach. `Transport.frameAt` clamps every seek into in..out, so the
  // press lands back where it started - and at the in point, which is where somebody
  // steps backwards from, the key reads as unbound.
  //
  // Must redden only the row about a trimmed clip. Every other mark row in section 13
  // runs on the whole take, where the clamp cannot change the answer, which is exactly
  // how the defect survived a section that already pressed both keys four times.
  'marks-ignore-the-clip-range': {
    file: 'web/main.js',
    edits: [[
      '      const seconds = markSecondsInOrder().filter(reachableInClip);',
      '      const seconds = markSecondsInOrder();',
    ]],
  },

  // The ruler's ticks go back to seeking wherever they are drawn, trim or no trim. The
  // seek is clamped into in..out, so pressing a diamond that sits inside the shading
  // moves the playhead to the boundary instead - a control doing something other than
  // what it shows, which is worse than one that declines.
  //
  // The click and not the predicate, because the predicate is shared with the keys now:
  // removing it would redden the key rows as well and the run could no longer say which
  // surface was broken. Must redden only the click rows.
  'tick-seeks-outside-the-trim': {
    file: 'web/main.js',
    edits: [['        if (!reachableInClip(at)) return;\n', '']],
  },

  // `.tmk.beyond` goes back under the two interaction states. Same specificity, so the
  // later rule wins and a beyond tick keeps its resting colour while hovered and while
  // focused - and since `:focus-visible` turns the native outline off on the grounds
  // that the colour change describes the same thing, the keyboard gets no answer at all.
  //
  // The order and not the colour, because the colour is right in both builds at rest.
  // Must redden the focused-beyond row and leave the focused-ordinary row green: a
  // mutation that broke focus everywhere would take both, and this defect is specific to
  // the one state that was written last.
  // Both halves of the move, because putting `.tmk.beyond` back between the two states
  // would restore the hover defect and not the focus one - and focus is the half that
  // leaves the keyboard with no answer at all.
  'beyond-mark-loses-focus': {
    file: 'web/index.html',
    edits: [
      ['  .tmk.beyond { color: var(--faint); }\n  .tmk:hover', '  .tmk:hover'],
      [
        '  .tmk:focus-visible { outline: 0; color: var(--ink); }',
        '  .tmk:focus-visible { outline: 0; color: var(--ink); }\n'
        + '  .tmk.beyond { color: var(--faint); }',
      ],
    ],
  },

  // The control for section 12's subset rows, and it is the shape the feature had
  // before the dialog existed rather than an invention: a preset is the whole look tag
  // whatever anybody ticked. The boxes still tick, the headings still go
  // indeterminate, the count still counts - everything you can see about the dialog is
  // correct - and the document written behind it names all fifty-odd values. That is
  // the reason it anchors on the *answer* rather than on either writer: one edit takes
  // the save and the export together, which is the class, where mutating the export's
  // own call would leave a build whose library and whose files disagree about what a
  // preset can be and would still pass the save half by never being asked.
  //
  // Must redden: **five rows - two claims, one at each door, and three standing on the
  // fixture the mutation destroys.** The claims are the row reading the exported
  // document's keys and the row reading what the *save* put in the library: both ask
  // whether what came out is what was left ticked, and they are separate rows because
  // they are separate writers over one picker. The three that follow are provenance rows,
  // and they go red for a reason about the fixture rather than about themselves - a
  // picker ignoring the boxes writes the *whole* look, so the sparse document those rows
  // exist to reason about no longer exists, the import stamps the clip, the apply leaves a
  // stamp naming the document it just applied, and the save moves the stamp it should have
  // left alone. None is a second defect. This said "the two rows that read the exported
  // document's keys" and undercounted, which under this suite's rule that the next agent
  // re-derives the fired set from scratch reads as a bug to chase. Measured, settled
  // machine, 278 assertions: `caught, as required (5 assertions fired)`.
  //
  // **Re-measured at 508 assertions after the application bar's message chip was removed**,
  // because one of the three provenance rows read that chip and two replaced it: what was a
  // row about the apply's note is now a row about the stamp the apply leaves. The count is
  // unchanged at five and the fired set is the same five claims, which is the answer that
  // had to be checked rather than assumed.
  //
  // The rows about what the dialog offers and how it ticks stay green, deliberately -
  // they are about the control and this mutation does not touch it.
  'picker-ignores-the-boxes': {
    file: 'web/main.js',
    edits: [[
      '      picked = { name: chosen, names: presetPickNames() };',
      "      picked = { name: chosen, names: params.names('look') };",
    ]],
  },

  // The reading rule, put back to the state a per-parameter checkbox has by default:
  // each box writes itself and nothing else, so unticking `depth` authors a document
  // naming four of the five weights. It is the sharper half of the same claim the
  // format makes - `refusePresetBody` refuses that file on the way back in, so a build
  // with this mutation lets you assemble a preset it will then refuse to read, and the
  // gesture is only discovered to be impossible after it is finished.
  //
  // Must redden: **three rows - two claims and one that stands on what they broke.** The
  // control's own row is the first: untick one weight and count what came off with it.
  // The second is the format's opinion of the document that came out, which is a claim of
  // its own rather than a cascade and is why that row exists at all - a file naming four
  // of the five weights is exactly what `refusePresetBody` refuses, so the import is
  // refused and the row reading the picker's name back says so. The third follows from the
  // second mechanically: with the import refused the sparse document was never written, so
  // it is not an entry in the picker and the row that applies it goes red about a preset
  // that does not exist. That one is the fixture, not a finding - and it is a *row* rather
  // than a crash only because `applyByChoosing` answers whether the entry was there, which
  // it did not until this mutation killed the run at a click waiting for one. Measured on an idle machine: `caught, as required (3 assertions fired)`,
  // against a docstring that had promised one.
  'readings-tick-alone': {
    file: 'web/main.js',
    edits: [[
      '  for (const n of (PARAMS[name].reading ? READINGS : [name])) presetPickBoxes.get(n).checked = on;',
      '  presetPickBoxes.get(name).checked = on;',
    ]],
  },

  // The falsification control for the derived half of section 16: every collapsible
  // group answers "nobody has been here" whatever the document holds, so a group
  // carrying live values renders shut and stays shut.
  //
  // Written as a branch at the head of the predicate rather than as `return false` in
  // place of its body, because the body is what the second control below edits and two
  // mutations rewriting one region cannot both be anchored. `key` is always a truthy
  // string here - every caller passes a group key - so the branch is unconditional in
  // practice while leaving the loop underneath it intact and readable.
  //
  // Must redden: 14 rows, and the shape of that set is the thing to read rather than the
  // count. The three carrying the claim are the ones that move a value, key a parameter,
  // or move a reading and expect the group to open. **The mark rows go with them**, and
  // that is right rather than collateral: the mark is keyed on the same rule the open
  // state is, so a build that cannot tell whether a group is in use cannot mark it as in
  // use either. An earlier draft widened the mark to a condition of its own and those
  // rows stayed green here, which read as precision and was really the second rule
  // covering for the first.
  //
  // **The store rows go with them too, for the same reason one link further out.** Both
  // halves of the store rule are comparisons against the derivation - an entry is written
  // where it disagrees and pruned where the document has caught up - so a predicate that
  // answers `false` whatever the document holds makes the second comparison unreachable
  // and the first one always true. On this build a group pinned open is never overtaken,
  // so it never decays and never shuts again, and 15f-bis's two claim rows say so. They
  // are the decay's own claim rather than a cascade, which is why the precondition row
  // above them - that pinning a quiet group open is a disagreement at all - stays green
  // and is what says the fixture was built.
  //
  // **And 15i's three go with them, for the reason one step further out still.** That
  // block needs a group that is *in use* and then shut, which is the disagreement a person
  // actually forms - and on a build where nothing is ever in use, that fixture cannot be
  // built at all: the group is already shut, the conditional press does nothing, and no
  // override is written. Its precondition row says so, and the two rows across the reload
  // go with it. The pinned-open half of the same block stays green throughout, because
  // pinning a quiet group open is a disagreement on this build too - which is what says
  // these three are about the predicate rather than about reloading.
  //
  // It reddened one more for one round, and that one was a leak rather than a finding:
  // 15f-bis left `post` pinned open on this build, and 15g four rows later asks every
  // collapsible group but `style` to be shut. The block puts the pin back now, so this
  // control fails rows about the predicate and none about a neighbour's fixture.
  //
  // The rows that stay green are the ones about the toggle itself - it still presses, and
  // the rows still hide and show - and the count on a shut header, which walks
  // `paramTouched` rather than this predicate. That is what says this mutation is about
  // the predicate and not about the panel having stopped working.
  'group-never-reveals': {
    file: 'web/main.js',
    edits: [[
      'function revealsItself(key) {\n  return (panelGroupParams.get(key) ?? []).some(paramTouched);',
      'function revealsItself(key) {\n  if (key) return false;\n  return (panelGroupParams.get(key) ?? []).some(paramTouched);',
    ]],
  },

  // The control for the keyframe term, and it is the whole reason that term exists.
  // The evidence test keeps its value half and loses its track half, so a group whose
  // only evidence is a keyed parameter sitting on its own default at the parked frame
  // reads as untouched and stays shut - which is the state the panel would be in for
  // every frame a curve happens to cross its default, and a group that breathes open and
  // shut under a moving playhead is unreadable while anything is playing.
  //
  // It edits `paramTouched`, which is the one place that test lives, so the count on a
  // shut header loses the same half with it. That is the honest shape of this bug rather
  // than a widening: a build that had never learned to read a track would not read one
  // for the mark either. It reddens no mark row all the same, because every mark row
  // here is set up with a value off its default rather than with a key.
  //
  // The sharper half is that this mutation is invisible to every other row here: a
  // parameter that is keyed *and* off its default opens the group either way, so the
  // section has to plant a track whose keys are all at the default and assert the value
  // really is there before the row means anything.
  //
  // Must redden: the keyed-at-default row, and that row alone.
  'reveal-ignores-tracks': {
    file: 'web/main.js',
    edits: [[
      '  if ((tracks.get(name)?.keys.length ?? 0) > 0) return true;\n'
      + '  return params.get(name) !== groupDefaults.get(name);',
      '  return params.get(name) !== groupDefaults.get(name);',
    ]],
  },


  // The store rule's own control, and the reason it exists is that the section did not
  // have one and could not have noticed. 15f pressed a toggle, pressed it back, and
  // reported that an override agreeing with the derivation stops existing - which is a
  // true sentence about the only path that never needed the fix. `toggleGroup` compares
  // the two terms at the moment of the press, so re-pressing is the one gesture where
  // they agree by construction. The term that actually moves afterwards is the
  // *derivation*, and nothing drove that: a value set, a look applied, a project opened
  // never touched the store, so a group pinned open while quiet stayed open forever with
  // nothing in it and 22 assertions in the section went green over it.
  //
  // This mutation is the pre-fix build restored exactly rather than a break invented for
  // the occasion, which is what makes it say something: the prune comes out of
  // `refreshGroups` and goes back into `toggleGroup` in the same edit, so the toggle path
  // keeps working perfectly. A build that only removed the first half would also fail
  // 15f, and a control that reddens the rows a working feature would pass cannot say
  // which question it was asking.
  //
  // Must redden: 2 rows, both in 15f-bis, and no others. The one that reads the store
  // after a value moves into the group, and the one that resets the look afterwards and
  // finds the group still pinned open with nothing inside it. 15f above stays green,
  // which is the whole point - it is the path this mutation leaves intact - and so does
  // 15f-bis's own first row, because pinning a quiet group open is a disagreement on
  // either build.
  'override-prunes-only-on-toggle': {
    file: 'web/main.js',
    edits: [
      [
        '    const pair = `${want}/${inUse}`;\n'
        + '    const settled = groupSeen.get(key);\n'
        + '    if (settled !== undefined && settled !== pair && want === inUse) {\n'
        + '      groupOverride.delete(key);\n'
        + '      groupOverrideDirty = true;\n'
        + '    }\n'
        + '    groupSeen.set(key, `${groupOverride.get(key)}/${inUse}`);\n',
        '',
      ],
      [
        '  groupOverride.set(key, !groupIsOpen(entry.group));\n',
        '  const want = !groupIsOpen(entry.group);\n'
        + '  if (want === groupRevealed(entry.group)) groupOverride.delete(key);\n'
        + '  else groupOverride.set(key, want);\n',
      ],
    ],
  },

  // The other half of the store rule's control set, and it restores the build the *first*
  // attempt at the prune shipped rather than a break invented for the occasion: the
  // comparison of the two terms stays where it is and loses only its condition that one
  // of them has moved.
  //
  // That condition is what the state a page boots into needs. Before the take is open
  // every look parameter sits at its default and `tracks` is empty, so the derivation
  // answers `false` for every group - a statement about there being no document yet
  // rather than about the document - and a build pruning on agreement alone deletes every
  // stored collapse on its way past that reading, then lets the take load and derive the
  // group open again. It is one-directional and it fails in the direction people use: a
  // pin stores `true` against a derived `false`, which is a disagreement at boot and
  // survives, while a collapse stores `false` against the same `false` and does not.
  //
  // Must redden: 2 rows, both in 15i, and no others. The one that reads the store back
  // after the reload and finds the collapse gone, and the one that puts the value back and
  // finds the group open. 15i's pin row stays green on this build, which is the whole
  // point - it is the direction this defect cannot touch, and a control that reddens both
  // could not say which of the two was being asked about. 15f and 15f-bis stay green as
  // well, because pruning *more* eagerly is still pruning where those rows press.
  'prune-ignores-movement': {
    file: 'web/main.js',
    edits: [[
      '    if (settled !== undefined && settled !== pair && want === inUse) {\n',
      '    if (want === inUse) {\n',
    ]],
  },

  // The gate on the panel's re-derivation, taken off in the two places it lives, which
  // between them are the build from before it existed. `params.set` announces every write
  // to the panel unconditionally again, and `withoutRepaint` stops asking once on the way
  // out - so the evaluator's per-frame bulk write costs one re-derivation per keyed
  // parameter instead of one for the whole write.
  //
  // Both edits or neither, and that is what makes the arm measurable rather than
  // approximate. Removing only the condition would leave the `finally` asking as well, at
  // one more pass per frame than the build this restores, and the figure would then be
  // about a build nobody ever shipped.
  //
  // Must redden: 13k's cost row, and that row alone. Nothing else in the file counts
  // re-derivations, and the panel goes on deriving correctly - this is a mutation about
  // what a feature costs rather than about whether it works, which is the only kind of
  // mutation a performance row can have.
  'panel-rederives-per-write': {
    file: 'web/main.js',
    edits: [
      ['    if (!transportWriting) groupRevealChanged();\n', '    groupRevealChanged();\n'],
      ['    if (!outer) groupRevealChanged();\n', ''],
    ],
  },

  // The envelope check, removed while everything inside `values` goes on being validated.
  // A version 3 document's `mode` field then walks straight through: it is semantically
  // active in the version it belongs to, the file's author believes this build reads it,
  // and answering that file with silence is the failure the version gate one line above
  // exists to prevent arriving through the one part of the document nobody was reading.
  //
  // Must redden: 2 rows, both about the stray key - that it is refused by name, and that
  // it never became a document. The `__proto__` row is untouched on purpose and is what
  // says this mutation is about the envelope: that fixture puts its key inside `values`,
  // where the registry walk refuses it on either build.
  'envelope-unchecked': {
    file: 'web/main.js',
    edits: [[
      '  const stray = Object.keys(body).filter((k) => !PRESET_KEYS.includes(k));\n',
      '  const stray = [];\n',
    ]],
  },

  // The face drag renders from inside its own pointer handler instead of arming the
  // loop, which is the shape section 9's orbit bug had: `renderProgramFrame` advances
  // navigation, so a handler that renders has asked for the next render. Section 20
  // measures it against the same twenty-four registry writes with no pointer, so the
  // transport's own drafts are in both arms and only the extra render is left.
  'box-drag-pumps-renders': {
    file: 'web/main.js',
    edits: [[
      '  params.set(cropDrag.param, cropDrag.from + (face.flip ? -coord : coord));\n'
      + '  chromeStale = true;',
      '  params.set(cropDrag.param, cropDrag.from + (face.flip ? -coord : coord));\n'
      + '  chromeStale = true;\n'
      + '  renderProgramFrame(timeline ? timeline.programSec : 0);',
    ]],
  },

  // **The fit moved to the other side of `history.begin`**, which is an ordering failure
  // rather than a logic one: the box is identical, and it is now the first entry on the
  // undo stack. One ctrl-Z at the start of a session throws the box back to its bounds,
  // and the auto-save's baseline is a document that differs from the one on screen before
  // anything has been edited.
  //
  // The gate this mutation's neighbour used to attack is gone from the build rather than
  // from this table. It asked whether the document had authored its faces, which is the
  // right rule and a state `openTake` cannot be in - one call per page load, off a
  // registry at its defaults, with any named project restored by the `.then` after it. A
  // mutation removing a condition that is false on every reachable path changes no
  // behaviour, and this file reported it NOT CAUGHT with 456 green rows, which is how the
  // dead branch was found.
  // **The fit run once more after everything has settled**, which is the tempting shape:
  // the take is open, the project is on, so fit the box now that there is something to
  // fit it to. What it destroys is the only rule left protecting a document's own box -
  // a clip cropped tight around a subject reopens with the box pushed back out to the
  // whole room, silently, because the fit had the last word. The ordering is all that
  // enforces it now that the gate is gone, and this is the mutation that attacks it.
  'fit-outlives-a-restored-project': {
    file: 'web/main.js',
    edits: [[
      '    .then(() => (REQUESTED_PROJECT ? loadProjectNamed(REQUESTED_PROJECT) : null))',
      '    .then(() => (REQUESTED_PROJECT ? loadProjectNamed(REQUESTED_PROJECT) : null))\n'
      + '    .then(() => fitCropToTake(REQUESTED_TAKE, params.get(\'near\'), params.get(\'far\')).catch(() => {}))',
    ]],
  },
  'fit-lands-after-history-begins': {
    file: 'web/main.js',
    edits: [
      // Lifted out of its place above the marks...
      ['  await fitCropToTake(id, params.get(\'near\'), params.get(\'far\')).catch(showTimelineError);\n'
        + '  // Awaited, so the first paint of the ruler already has the ticks on it. A take',
      '  // Awaited, so the first paint of the ruler already has the ticks on it. A take'],
      // ...and put back on the far side of the baseline, committing like any other edit,
      // which is exactly what it must not be. The comment above `begin` is part of the
      // anchor because `history.begin()` alone appears twice in this file.
      ['  // The stack starts from whatever the clip already is, so the first undo has\n'
        + '  // somewhere honest to land rather than an empty document.\n'
        + '  history.begin();',
      '  // The stack starts from whatever the clip already is, so the first undo has\n'
        + '  // somewhere honest to land rather than an empty document.\n'
        + '  history.begin();\n'
        + '  await fitCropToTake(id, params.get(\'near\'), params.get(\'far\')).catch(showTimelineError);\n'
        + '  history.commit();'],
    ],
  },
  // **The shape is written and the stage is not letterboxed to it.** `setProjectAspect`
  // adopts the pair, brings the deliverable's size along and repaints the buttons - and
  // then does not `resize()`, so the document says 4:3 and the picture is still the 16:9
  // it was. That is the exact failure the split has to make impossible, because the whole
  // argument for putting the shape on the document is that a composition and the frame it
  // was composed for are one thing.
  //
  // It is here rather than as a picture comparison because a letterbox is geometry, not
  // pixels: the stage's own box is what changes, and reading it is a stronger question
  // than a render diff would ask - a build that reframed to *some* other shape would pass
  // a "did the picture change" test and fail this one.
  //
  // **Separable from the read rows on purpose, and the counts are how you tell.** The
  // three rows that read the dialog stay green under this, because the buttons really are
  // painted and the document really does hold the new shape; the resolution menu really is
  // rebuilt, so that row stays green too. What reddens is the press row, which asks the
  // stage. One failed assertion, and if this ever catches with two the second one is
  // telling you the mutation did something else as well.
  // **The output name is read out of the deliverable and never written back into it.**
  // This is the shipped defect, not a hypothetical: `applyDeliverable` copied
  // `deliverable.name` into the field and `ensureActiveDeliverable` seeded it empty, and
  // nothing carried the other direction - so typing a name and pressing `new` stored the
  // empty string, and every deliverable of one take went on proposing the same filename.
  // The comment on `applyDeliverable` claims that field is what stops two of them writing
  // over each other's file, which is a claim a check has to be able to falsify.
  //
  // Aimed at the listener rather than at the assignment, because the assignment is what a
  // reader would fix and the listener is what was missing. It leaves `paintExportName`
  // alone, so the field still validates and the export button still disables on a bad
  // name - a build under this mutation looks completely healthy until a document is saved
  // and read back, which is the whole reason the row walks a round trip.
  'export-name-not-taken': {
    file: 'web/main.js',
    edits: [[
      'ui.exportName.addEventListener(\'input\', () => {\n  takeExportName();\n  paintExportName();\n});',
      'ui.exportName.addEventListener(\'input\', () => {\n  paintExportName();\n});',
    ]],
  },

  'aspect-skips-the-letterbox': {
    file: 'web/main.js',
    edits: [[
      '  void fromDocument;\n  paintDeliverable();\n  resize();\n  return true;',
      '  void fromDocument;\n  paintDeliverable();\n  return true;',
    ]],
  },

  // The button is planted in the application bar's status slot, which is deliberate and is
  // the whole history of this control: the slot is inside `.appbar` and outside `#navRow`,
  // and for as long as the rule keyed on the bar rather than on the nav row a control
  // planted here was adopted by a coverage rule written about the menus - 420 assertions,
  // 0 failed, NOT CAUGHT. `docs/instruments.md` carries that case.
  //
  // It anchored on `#tNote`, the message chip that used to open this slot, and moved onto
  // the slot's opening tag when the chip was removed. The anchor being the container rather
  // than a sibling is the better of the two anyway: the position it has to occupy is "in
  // this slot", and a sibling anchor is a second thing that has to still be there.
  'plant-unswept-control': {
    file: 'web/index.html',
    edits: [[
      '    <div class="appstatus" id="appStatusSlot">',
      '    <div class="appstatus" id="appStatusSlot">\n'
      + '      <button id="tPlantedControl" type="button">planted</button>',
    ]],
  },

  // The mirror of the one above: a panel that is *missing* a control rather than
  // carrying one nobody drives. The generator skips one registry entry, and the build's
  // own count assertion is moved out of the way in the same breath - deliberately, and
  // it is the whole point of the mutation. A plain omission is caught by `main.js`
  // refusing to boot, which is the right behaviour for a user and useless as evidence
  // here: the page never publishes anything, every tool reports DID NOT RUN, and an
  // exit code with no assertions behind it is what this repo has twice written down as a
  // bug found. So the mutation asks the sharper question - if the generator filtered
  // wrongly *and* the build's own tripwire agreed with it, would anything notice? The
  // answer has to be a failed assertion, and it has to come from a count this file
  // recomputes rather than one the page reports.
  //
  // `ghostFill` rather than the first parameter of its group, because a group left with
  // no rows at all trips a different refusal and the run would end as a crash again.
  //
  // Must redden: section 1's row "every parameter the registry declares has a control on
  // the panel" - and that row alone, naming ghostFill. Nothing else here touches the
  // panel's contents, so a run that reddens anything more is measuring something else.
  'panel-row-skips-parameter': {
    file: 'web/main.js',
    edits: [
      ['    if (spec.group !== group.key) continue;',
        "    if (spec.group !== group.key || name === 'ghostFill') continue;"],
      ['  if (panelRowsEmitted !== owned.length) {', '  if (panelRowsEmitted !== owned.length - 1) {'],
    ],
  },

  // The control for the application-bar placement rows in section 1. It moves the
  // working bar into the scrolling inspector after the registry has built the whole
  // column, restoring the original failure at the new shell boundary: all commands and
  // both destinations still exist, but they are below the controls when the page opens.
  'nav-at-the-foot': {
    file: 'web/index.html',
    edits: [[
      '  </div><!-- #panelBody -->',
      '    <script>\n'
      + "      const plantedBar = document.getElementById('appBar');\n"
      + "      plantedBar.style.position = 'static';\n"
      + "      document.getElementById('panelBody').append(plantedBar);\n"
      + '    </script>\n'
      + '  </div><!-- #panelBody -->',
    ]],
  },

  // The outer inspector switch stops hiding inactive groups. Every registry row still
  // exists and every group collapse still works, so only the four tab-visibility rows
  // must redden; a wider failure would be testing the panel generator instead.
  'panel-tabs-show-everything': {
    file: 'web/main.js',
    edits: [[
      '    group.hidden = group.dataset.panelTab !== tab;',
      '    group.hidden = false;',
    ]],
  },

  // ------------------------------------------------------ the per-parameter reset
  //
  // Six controls for section 17, and they are six rather than one because the reset is
  // four claims wearing one button: that every look scalar has one, that what it offers
  // is re-read off the registry rather than remembered, that hiding it costs the row no
  // layout, and that pressing it is an ordinary registry write which leaves the caret
  // somewhere a hand can use. A single break would redden most of the section and say
  // which of the four had gone.

  // One row emitted without its reset, and the parameter is chosen for being one
  // nothing else in the section touches: `noiseSpeed` sits in `displacement`, which is
  // on the region inspector, so no press row, no geometry row and no preset row reads
  // it. The existence row is the only thing that can see it go.
  //
  // Must redden: **two rows**, and the second is what makes the driver rule honest.
  // `every look parameter the registry declares as a scalar carries exactly one reset
  // naming itself` reports `noiseSpeed`, and `every reset the panel renders was pressed
  // here` reports it too - the press sweep drags the parameter, waits for a reset that
  // never appears, and says so rather than pressing nothing quietly. The stray row stays
  // green on purpose: it asks whether every reset that exists is in the right row, which
  // a missing one does not affect, and a count folded into it would make two rows one row
  // written twice.
  //
  // Measured at `web/main.js` 09567ae2: `396 assertions, 3 failed`, the third being the
  // export dialog's `and the format segments follow the document ...`, which is red on
  // that tree on its own account. Read the fired list and subtract it.
  'reset-missing-on-a-row': {
    file: 'web/main.js',
    edits: [[
      '      const beside = [...(keyButton ? [keyButton] : []), makeResetButton(name)];',
      "      const beside = name === 'noiseSpeed' ? [...(keyButton ? [keyButton] : [])]\n"
        + "        : [...(keyButton ? [keyButton] : []), makeResetButton(name)];",
    ]],
  },

  // The same hole one class wider: the generator emits the reset only for the groups on
  // the look inspector, so the framing and region tabs lose theirs entirely. It is kept
  // beside the mutation above rather than folded into it because the two fail
  // differently - one parameter going missing is a filter with a typo in it, a whole
  // inspector going missing is a condition somebody wrote on purpose - and the existence
  // row prints its count per tab, so the reader can tell which of the two happened
  // without running anything else.
  //
  // Must redden: **two rows** - the same existence row, naming the twenty-three
  // parameters on the framing and region inspectors, eight and fifteen, and the press
  // sweep beside it for the same twenty-three. Everything else in the section reads rows
  // on the look inspector, so a wider failure would mean the section had stopped being
  // able to say which tab lost them.
  //
  // Measured at `web/main.js` 09567ae2: `396 assertions, 4 failed`, the other two being
  // the export dialog's format-door row and section 13's auto-save ordering row, both red
  // on that tree for their own reasons.
  'reset-skips-a-tab': {
    file: 'web/main.js',
    edits: [[
      '      const beside = [...(keyButton ? [keyButton] : []), makeResetButton(name)];',
      "      const beside = group.tab === 'look'\n"
        + "        ? [...(keyButton ? [keyButton] : []), makeResetButton(name)]\n"
        + "        : [...(keyButton ? [keyButton] : [])];",
    ]],
  },

  // The control for the claim the whole feature rests on: what a row offers is the
  // registry's opinion, re-read after every write, and never a note the panel keeps
  // about its own gestures. This restores the shape that is easiest to write and wrong
  // for every door but one - a set the slider's own handler adds to and the reset's
  // click removes from, with `refreshReset` reading the set instead of comparing the
  // value against its default.
  //
  // It is deliberately *right* for the slider, which is what makes it a control rather
  // than a break: drag a parameter and the reset appears, press it and the reset goes,
  // exactly as on the shipped build. What it cannot follow is the registry being reached
  // by anything else - a preset, a project, an undo, step 5's tracks - and that is a
  // whole class of door with one arm pointed at it.
  //
  // Must redden: **one row** - section 17's `a preset applied from the picker moves
  // which rows offer a reset, with no reset pressed`. The press rows and the geometry
  // rows stay green because they establish their state through the control, which is the
  // one path this build gets right, and a control that reddened them too could not say
  // which door it had closed. **That is also why the preset block runs before them**: a
  // sticky flag set by the geometry block's fourteen drags would still be set when the
  // preset landed, and the row would then be red about the leftovers rather than about
  // the door.
  //
  // Measured at `web/main.js` 09567ae2: `396 assertions, 3 failed`, the other two being
  // the export dialog's format-door row and section 13's auto-save ordering row.
  'reset-remembers-its-own-state': {
    file: 'web/main.js',
    edits: [
      ['const resetButtons = new Map();', 'const resetButtons = new Map();\nconst resetTouched = new Set();'],
      ['  const modified = value !== resetTarget(name);', '  const modified = resetTouched.has(name);'],
      [
        'function writeFromControl(name, value) {\n  const applied = params.set(name, value);',
        'function writeFromControl(name, value) {\n  resetTouched.add(name);\n  const applied = params.set(name, value);',
      ],
      [
        '    params.set(name, resetTarget(name));\n    history.commit();',
        '    resetTouched.delete(name);\n    params.set(name, resetTarget(name));\n    history.commit();',
      ],
    ],
  },

  // The stylesheet's half of the contract, and the one edit that looks like a tidy-up.
  // A reset that is not being offered is taken out of the flow instead of merely being
  // made invisible, so the row it was in reflows the moment a parameter leaves its
  // default - which is to say in the middle of the drag that moved it.
  //
  // **Nothing about the two states looks different in a screenshot of either one**, which
  // is why the row that catches this measures both and compares them: `checkVisibility`
  // answers false under both spellings, so a row asking whether the hidden button is on
  // the screen passes this mutation with everything green.
  //
  // Must redden: **two rows** - `the reset keeps its box while it is not being offered`
  // and `and nothing else in the row moved between the two states`. The first is the
  // mechanism and the second is the harm; they are separate because a layout where
  // nothing downstream of the reset could move would leave the second unable to fail, and
  // this one is not that layout. Measured on the shipped panel at 1512px: the slider goes
  // 39px wide to 64px, the readout from x=145 to x=170 and the keyframe diamond from
  // x=194 to x=219, against a clean build where all three are identical to the hundredth
  // of a pixel across the same pair of states.
  //
  // Measured at `web/index.html` a242d097: `396 assertions, 4 failed`, the two named
  // above plus the export dialog's format-door row and section 13's auto-save ordering
  // row, both red on that tree for their own reasons.
  'reset-collapses-the-slot': {
    file: 'web/index.html',
    edits: [[
      '  .reset[data-modified=no] { visibility: hidden; }',
      '  .reset[data-modified=no] { display: none; }',
    ]],
  },

  // The press stops handing the caret anywhere, which is the state the shipped code's
  // own comment describes and exists to avoid: writing the default makes the row
  // unmodified, `refreshReset` disables the button while it is the focused element, and
  // focus falls to the body with no way back into the panel short of tabbing from the
  // top.
  //
  // **Both halves in one mutation, and the second half is the one this control was
  // re-anchored for.** The handler reaches for the slider and then, where the write shut
  // the group and took the slider out of the display, falls back to the group's own
  // toggle. Removing only the first leaves the fallback catching the caret on exactly
  // the case that matters, so the mutation would be green on the row that carries the
  // claim - which is the two-gates-that-agree shape read from the other side: a control
  // that cannot reach both terms is a control for neither.
  //
  // `const slider` is left standing and unused rather than taken with them, because a
  // mutation that also has to keep a declaration in step with its uses is a mutation
  // that goes stale twice as fast.
  //
  // Must redden: **two rows** - `pressing a reset leaves the caret on that row's own
  // slider` and `a press that shuts the group it was in still leaves the caret somewhere
  // in the panel`. The two are separate rows because the two paths through the handler
  // are separate code, and this build answers both; the second was red on the build
  // before the fallback existed and is what said so - `the caret is on body` there,
  // `the caret is on opticalToggle` once the fallback landed.
  //
  // Measured at `web/main.js` 09567ae2: `396 assertions, 4 failed`, the two named above
  // plus the export dialog's format-door row and section 13's auto-save ordering row.
  'reset-strands-focus': {
    file: 'web/main.js',
    edits: [
      ['    slider.focus();\n', ''],
      [
        "    if (document.activeElement !== slider) {\n"
        + "      const toggle = button.closest('.group')?.querySelector('.grouptoggle');\n"
        + '      if (toggle) toggle.focus();\n'
        + '    }\n',
        '',
      ],
    ],
  },

  // The press writes the value straight into the map instead of going through the
  // registry's one door. It is the failure `makeResetButton`'s own docstring enumerates:
  // no `apply`, so the image keeps the old value; no `writeControl`, so the slider and
  // the readout go on showing what was there; no `paramWritten`, so nothing downstream
  // rebuilds; and no group reveal, so a group open only because this parameter was
  // carrying something stays open over a parameter that is no longer carrying anything.
  //
  // `values.set` rather than deleting the call, because a press that did nothing at all
  // would be caught by a row asking whether the value moved - and that row would pass a
  // build that moved the value and told nobody, which is the one this mutation is about.
  //
  // Must redden: **three rows** - the press row reading the registry, the slider and the
  // readout back, the row saying the press stops the reset being offered, and the row
  // saying the group the parameter was in re-derives shut. Each is a different thing
  // `params.set` does on the way out, so between them they say *which* of the write's
  // effects went missing rather than that one did.
  //
  // **The two focus rows pass under it, and that is the mutation being precise rather
  // than the rows being weak.** Nothing about this edit touches the focus handling: the
  // group never shuts, so the slider is still rendered when the handler reaches for it
  // and the fallback is never needed. A control that also reddened those could not tell
  // a write that went nowhere from a caret that went nowhere.
  //
  // Measured at `web/main.js` 09567ae2: `396 assertions, 4 failed`, the three named above
  // plus the export dialog's format-door row.
  'reset-writes-around-the-registry': {
    file: 'web/main.js',
    edits: [[
      '    params.set(name, resetTarget(name));',
      '    values.set(name, resetTarget(name));',
    ]],
  },

  // The export dialog's format segments paint themselves from the last press instead of
  // from the deliverable, which is the same defect `reset-remembers-its-own-state` plants
  // one surface over and is worth a control of its own because the two are different code
  // reached by different doors. `paintExportFormats` keeps its own note of what was
  // clicked; pressing a segment still looks perfect, and a deliverable adopted from the
  // picker leaves the dialog showing a codec the document does not have.
  //
  // Must redden: **one row** - section 1's `and the format segments follow the document
  // rather than the press that last touched them`. The press row above it stays green,
  // deliberately: a control that reddened both could not tell a button that is not wired
  // from a button wired only to itself.
  //
  // **It cannot be shown to discriminate on the tree it was written against, and that is
  // stated rather than left to be discovered.** The shipped build already fails that row
  // for a neighbouring reason - `paintDeliverable` never calls `paintExportFormats`, so
  // nothing repaints the segments when the document moves - so this mutation reddens
  // exactly the rows that were already red. Re-run it once the paint follows the document
  // and it must redden that row and no other.
  'format-segments-paint-the-press': {
    file: 'web/main.js',
    edits: [
      [
        "const EXPORT_CODECS = ['h264', 'prores', 'pngseq'];",
        "const EXPORT_CODECS = ['h264', 'prores', 'pngseq'];\nlet formatPressed = null;",
      ],
      ["  const codec = activeDeliverable?.codec ?? 'h264';", "  const codec = formatPressed ?? 'h264';"],
      [
        '  button.addEventListener(\'click\', () => setExportCodec(button.dataset.codec));',
        '  button.addEventListener(\'click\', () => { formatPressed = button.dataset.codec; setExportCodec(button.dataset.codec); });',
      ],
    ],
  },

  // A modal opened from a menu closes back onto the body instead of the visible menu
  // trigger. The command it came from is already hidden, so native dialog restoration
  // cannot provide a usable target on its own. Only the focus row in section 1 should
  // redden: the dialog still opens, changes OBS state and closes normally.
  'dialog-close-strands-focus': {
    file: 'web/main.js',
    edits: [['      returnFocus?.focus();', '      document.body.focus();']],
  },

  // The OBS dialog forgets a valid custom size accepted by the existing output control.
  // Assigning a value with no option leaves the select blank, which looks like no output
  // size is active even while the source is rendering one. The custom-resolution row is
  // the intended and only failure.
  'obs-forgets-custom-resolution': {
    file: 'web/main.js',
    edits: [[
      "  if (![...shell.obsResolution.options].some((option) => option.value === progSizeEl.value)) {\n"
      + "    const option = document.createElement('option');\n"
      + '    option.value = progSizeEl.value;\n'
      + '    option.textContent = `${progSizeEl.value} · current`;\n'
      + "    option.dataset.current = '';\n"
      + '    shell.obsResolution.appendChild(option);\n'
      + '  }',
      '',
    ]],
  },

  // The bug that started this file. The rebuild goes back to clearing its columns of
  // everything it does not recognise, which takes the in/out markers with it. Both
  // append sites move back too, so the mutated build is a working editor with no way
  // to trim a clip - a faithful restoration rather than a tree that throws on load,
  // because a mutation that crashes tests nothing.
  'lanes-clear-siblings': {
    file: 'web/main.js',
    edits: [
      [
        '  counters.laneRebuilds++;\n  ui.railLanes.replaceChildren();\n  ui.lanes.replaceChildren();',
        '  counters.laneRebuilds++;\n  for (const el of [...ui.rail.children, ...ui.beds.children]) {\n'
        + "    if (!el.classList.contains('ruler') && el !== ui.playhead) el.remove();\n  }",
      ],
      ['    ui.railLanes.appendChild(rail);', '    ui.rail.appendChild(rail);'],
      ['    ui.lanes.appendChild(bed);', '    ui.beds.insertBefore(bed, ui.playhead);'],
    ],
  },

  // The control for section 9: a finishing navigation redraw immediately starts
  // whatever the redraw armed while it ran. The accurate image is still produced,
  // but OrbitControls damping advances at rebuild rate instead of display rate. The
  // row it must redden is therefore the page-side count, not the picture.
  // The caret stranded by the rebuild a delete causes. The delete itself keeps working and
  // the entry still goes, so the row about the library is untouched and only the focus row
  // reddens - which is the split that says which of the two claims this control tested.
  'picker-drops-focus-on-rebuild': {
    file: 'web/main.js',
    edits: [[
      '  if (back) back.focus();\n  else closePicker(picker, { restoreFocus: true });',
      '  if (back) picker.list.blur();',
    ]],
  },
  // A delete drawn on every entry, shipped looks included. The server refuses one on a
  // builtin, so this is a control that is always refused wearing the shape of a control -
  // the row asks which entries carry the glyph rather than what happens when it is pressed,
  // because the refusal is the server's and this claim is the page's.
  'picker-offers-a-builtin-delete': {
    file: 'web/main.js',
    edits: [[
      '    if (!doc.builtin) {\n      const remove = document.createElement(\'button\');',
      '    if (true) {\n      const remove = document.createElement(\'button\');',
    ]],
  },
  // `EXPORT_CODECS` gone stale against the markup it validates. One entry dropped, and
  // `pngseq` rather than `h264` because h264 is the fallback every other row falls back
  // to - dropping it would redden half of section 1 for reasons that have nothing to do
  // with the drift row. The button stays in the markup, so the sweep still finds three
  // segments and only the press raises.
  'export-codecs-drops-an-entry': {
    file: 'web/main.js',
    edits: [[
      "const EXPORT_CODECS = ['h264', 'prores', 'pngseq'];",
      "const EXPORT_CODECS = ['h264', 'prores'];",
    ]],
  },
  // The two halves of section 18, one control each, because a mutation that reddened
  // both could not say which of the two claims it had tested. The first leaves the walk
  // working and only stops the control going quiet; the second leaves the quiet correct
  // and only sends the walk the wrong way.
  'keynav-never-disables': {
    file: 'web/main.js',
    edits: [[
      "  ui.prevKey.disabled = neighbourKeyTime(-1) === null;\n"
      + '  ui.nextKey.disabled = neighbourKeyTime(1) === null;',
      '  ui.prevKey.disabled = false;\n  ui.nextKey.disabled = false;',
    ]],
  },
  // The walk lands on the far end of the track rather than on the neighbour, which is
  // the wrong key while still being a key on the right side of the playhead. The filter
  // is untouched on purpose, so "is there anything that way" keeps its correct answer and
  // the three disabled rows stay green - a mutation that emptied the list would redden
  // them too and could not then say which half of the section it had tested. Three keys
  // at 1, 5 and 9 are what make it visible: with two, the nearest and the farthest are
  // the same key and this edit would change nothing.
  'keynav-walks-to-the-far-key': {
    file: 'web/main.js',
    edits: [[
      '  return direction < 0 ? Math.max(...times) : Math.min(...times);',
      '  return direction < 0 ? Math.min(...times) : Math.max(...times);',
    ]],
  },
  'orbit-pumps-on-change': {
    file: 'web/main.js',
    edits: [[
      '      .finally(() => { draftBusy = false; });',
      '      .finally(() => {\n        draftBusy = false;\n'
      + '        if (orbitRedrawWanted) pumpParkedDraft();\n      });',
    ]],
  },

  // The parked orbit goes back through the scrub preview. The pointer still moves
  // the camera and the release still performs an accurate seek, so a release-only
  // check passes. The picture sampled while the pointer is held must fail because
  // the draft deliberately zeros fade, wake and trails.
  'orbit-uses-scrub-draft': {
    file: 'web/main.js',
    edits: [[
      '    draftBusy = true;\n'
      + '    timeline.redrawHere()\n'
      + '      .catch(showTimelineError)\n'
      + '      .finally(() => { draftBusy = false; });',
      '    draftWanted = timeline.programSec;\n    pumpDraft();',
    ]],
  },

  // The renderer keeps the afterimage produced by the previous camera pose. The
  // next frame is otherwise valid, which makes this the exact old failure: Three's
  // component-wise maximum overlays the old projection and raises luminance while
  // navigation is moving.
  'camera-motion-keeps-history': {
    file: 'web/main.js',
    edits: [[
      '    if (renderedCameraChanged()) {',
      '    if (false && renderedCameraChanged()) {',
    ]],
  },

  // The second control for section 9, and the one that costs the most if it is
  // missed: an armed position is left standing in a state that will never pump it,
  // so `settled()` runs out its iterations and throws. Nothing about the picture is
  // wrong in that build - the orbit is fast, the release is accurate, and every tool
  // in this suite hangs on the call it uses to know when to look.
  'orbit-arms-into-playback': {
    file: 'web/main.js',
    edits: [[
      '  if (!timeline || timeline.playing || exporting) {\n'
      + '    draftWanted = null;\n    orbitRedrawWanted = false;\n    orbitSettling = false;\n    return;\n  }',
      '  if (!timeline || timeline.playing || exporting) return;',
    ]],
  },

  // The control for the release row, and it is the mutation that row was written to
  // answer: a release that seeks *accurately* to the wrong moment. Nothing about the
  // transport's bookkeeping notices - `seekNow` clears `drafted` whatever position it
  // was handed - so the old row, which read that flag, passed this build while the
  // viewport visibly sat a second away from where the hand let go.
  'release-seeks-past-target': {
    file: 'web/main.js',
    edits: [[
      '    timeline.seekHere().catch(showTimelineError);',
      '    timeline.seek(timeline.programSec + 1).catch(showTimelineError);',
    ]],
  },

  // The control for the navigation row. Puts back the write this fix removed: the
  // orbit arms a *position* read from inside a render rather than a flag the loop
  // resolves at pump time. `programSec` is `frame / outputFps` and the transport
  // assigns `frame` only after its render loop, so the armed value names the position
  // being left rather than the one being travelled to - and a seek raised while the
  // release is still settling gets pulled back to where the orbit was.
  'orbit-arms-stale-position': {
    file: 'web/main.js',
    edits: [[
      '  if ((!orbiting && !orbitSettling) || !timeline || timeline.playing) return;\n'
      + '  orbitRedrawWanted = true;',
      '  if ((!orbiting && !orbitSettling) || !timeline || timeline.playing) return;\n'
      + '  draftWanted = timeline.programSec;',
    ]],
  },

  // The control for the drift row. Takes the finish back out of the camera key, so
  // the pose recorded is whatever the camera happened to be passing through - which
  // is what a hand reaching from the release to the button got before the fix.
  'camkey-takes-the-passing-pose': {
    file: 'web/main.js',
    edits: [[
      '  finishOrbitDrift();\n  freeCamera.updateMatrixWorld(true);',
      '  freeCamera.updateMatrixWorld(true);',
    ]],
  },

  // The control for the pinned-drive row. Takes the loop away with orbit state still
  // standing, which is the one stranding this file cannot catch from inside
  // `pumpParkedDraft` - the mutated build never calls it again.
  'pin-keeps-orbit-armed': {
    file: 'web/main.js',
    edits: [[
      '      draftWanted = null;\n      orbitRedrawWanted = false;\n      orbitSettling = false;\n'
      + '      renderer.setAnimationLoop(null);',
      '      renderer.setAnimationLoop(null);',
    ]],
  },

  // Speed goes back to holding program time, which is what moved the frame you were
  // looking at by ten source seconds on a 1x to 2x change.
  'rate-holds-program': {
    file: 'web/main.js',
    edits: [[
      'return Math.max(0, Math.min(retime.programSecAt(rateGesture.source), timeline.duration));',
      'return Math.max(0, Math.min(timeline.programSec, timeline.duration));',
    ]],
  },

  // The cuts stop being carried across a speed change, which is the bug the user
  // photographed: at 1.20x the out marker sat at 50.3% of the ruler and at 2.35x the
  // same `out` sat at 99.5%, because the ruler halved and the marker did not. Only the
  // cut term is reverted, so this must redden the two cut rows and the two shade rows
  // and leave the key rows and the mark row passing - a mutation that failed everything
  // could not say which term it was about.
  'rate-holds-cuts': {
    file: 'web/main.js',
    edits: [[
      '  setClipInOut({ in: was.clipIn * k, out: was.clipOut === null ? null : was.clipOut * k });',
      '  setClipInOut({ in: was.clipIn, out: was.clipOut });',
    ]],
  },

  // The other term: keyframes stop being carried, so a bloom ramp graded against one
  // moment of the take points at another the moment the speed moves. Reddens the key
  // rows and leaves the cut rows alone, which is the pair that makes either one
  // diagnostic.
  'rate-holds-keys': {
    file: 'web/main.js',
    edits: [[
      '  for (const [key, t] of was.keys) key.t = t * k;',
      '  for (const [key, t] of was.keys) key.t = t;',
    ]],
  },

  // Undo restores the keys from the snapshot and leaves the cuts where the rate it is
  // undoing put them. Half a strip restored, which is worse than none: the markers and
  // the keys disagree about which footage the edit is on, and nothing says so.
  'undo-skips-cuts': {
    file: 'web/main.js',
    edits: [[
      '    if (retime.rate !== wasRate) {\n'
      + '      reparameteriseProgramTime(wasRate / retime.rate, { clipIn: wasIn, clipOut: wasOut, keys: [] });\n'
      + '    }',
      '    // the cuts are left where the rate being undone put them',
    ]],
  },

  // The wheel zooms about the middle of the window instead of about the pointer. The
  // window still zooms, the ruler still relabels and every other row in section 9 goes
  // on passing - which is what makes it the right control for that one claim, and what
  // makes a check with a single centred arm blind to it.
  'zoom-about-centre': {
    file: 'web/main.js',
    edits: [[
      '    if (!view.zoomAbout(clipFractionAt(surface, e.clientX), factor)) return;',
      '    if (!view.zoomAbout((view.a + view.b) / 2, factor)) return;',
    ]],
  },

  // Pointer-to-time goes back to reading the whole clip. This is the shape a site the
  // conversion missed would have: everything draws through the window and one place
  // still divides by the duration, so the strip looks right and the pointer is wrong by
  // a whole window.
  // Re-anchored when the window moved into `web/view-window.js`. Two things about its text
  // changed and neither is this control: the object literal is inside a factory now, so
  // every line in it carries two more spaces, and the bed's box arrives as the `bedRect`
  // supplier the factory was given rather than being read off `ui` from inside. The
  // mutation itself is the same one - the pointer's fraction is taken against the clip and
  // not against the window.
  'pointer-ignores-view': {
    file: 'web/view-window.js',
    edits: [[
      '    timeAt(clientX) {\n'
      + '      const r = bedRect();\n'
      + '      const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;\n'
      + '      return Math.max(0, Math.min(this.duration, (this.a + f * (this.b - this.a)) * this.duration));',
      '    timeAt(clientX) {\n'
      + '      const r = bedRect();\n'
      + '      const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;\n'
      + '      return f * this.duration;',
    ]],
  },

  // One term of the seam, reverted on its own: the marks are placed against the clip
  // while everything else is placed against the window. It must redden the culling row
  // and leave the key, cut, playhead and ruler rows passing - a mutation that reddened
  // everything would say something is broken without saying what.
  'marks-ignore-view': {
    file: 'web/main.js',
    edits: [[
      '    el.style.left = `${view.pct(at)}%`;\n    el.hidden = !view.holds(at);',
      '    el.style.left = `${(at / total) * 100}%`;',
    ]],
  },

  // The overview's edge handles stop resizing the window and pan it instead, which is
  // what the box does when the `edge` branch is gone. The pan row and the centring row
  // both still pass, so a red run names the zoom half specifically - and a handler that
  // was wholly dead would redden all three, which is why this is the one control the
  // three rows need rather than two.
  'mini-ignores-edges': {
    file: 'web/main.js',
    edits: [[
      "  const edge = e.target.classList.contains('w') ? 'w' : e.target.classList.contains('e') ? 'e' : null;",
      '  const edge = null;',
    ]],
  },

  // The splitter loses its clamp, so it can be dragged until the stage is a sliver.
  // A bound that can be dragged past is not a bound, and this is the one row that says
  // so - everything else about the splitter goes on working, which is what makes the
  // clamp row diagnostic rather than a second way of saying "the splitter drags".
  'splitter-unclamped': {
    file: 'web/main.js',
    edits: [[
      '  const height = Math.min(laneStackHeight, Math.max(0, Math.min(wanted, laneHeightCeiling())));',
      '  const height = Math.min(laneStackHeight, Math.max(0, wanted));',
    ]],
  },

  // The rail stops following the lanes, so every lane is labelled with a neighbour the
  // moment the strip is short enough to scroll. Reddens exactly the mirror row.
  'rail-ignores-scroll': {
    file: 'web/main.js',
    edits: [[
      "ui.lanes.addEventListener('scroll', () => {\n  ui.railLanes.scrollTop = ui.lanes.scrollTop;\n});",
      "ui.lanes.addEventListener('scroll', () => {});",
    ]],
  },

  // The overview's wheel reads its x through the ruler's mapping, so it zooms about a
  // window position while the pointer is over a clip position. The ruler's own two
  // wheel rows go on passing, which is what makes this diagnostic of the branch rather
  // than of zooming.
  'mini-wheel-uses-ruler': {
    file: 'web/main.js',
    edits: [[
      '  return surface === ui.mini ? f : view.a + f * (view.b - view.a);',
      '  return view.a + f * (view.b - view.a);',
    ]],
  },

  // The height is applied but never stored, so it is gone on the next load. Reddens
  // only the reload row - every other splitter row runs inside one page and cannot
  // tell.
  // Re-anchored when the splitter grew keyboard operation: the drag's inline storage
  // write became `rememberLaneHeight`, shared with the arrow keys, so the line this
  // names moved and lost two spaces of indent. The refusal is what surfaced that -
  // it matched 0 times and the run reported DID NOT RUN rather than passing quietly.
  // Mutating the shared writer is a strictly stronger mutation than mutating the
  // drag's own copy was, because now it forgets whichever gesture set the height.
  'splitter-forgets': {
    file: 'web/main.js',
    edits: [[
      '    localStorage.setItem(LANES_HEIGHT, String(userLaneHeight));',
      '    void LANES_HEIGHT;',
    ]],
  },

  // The global shortcuts stop asking whether a key was already consumed, so the
  // splitter's Home and End resize the strip and then seek as well. Reddens the two
  // "seeks nowhere" rows and leaves the resize rows beside them green, which is what
  // makes it diagnostic of the guard rather than of the keys.
  'shortcuts-ignore-consumed': {
    file: 'web/main.js',
    edits: [['  if (e.defaultPrevented) return;\n', '']],
  },

  // The rate gesture goes back to reading the generation at release rather than the one
  // it took, so a takeover it was held across reads as itself. Reddens only the
  // interrupted arm - the uninterrupted one applies identically either way, which is
  // the whole reason that arm is there.
  // The transport takeover stops reaching the gesture at all: the one door stops
  // dropping it, and the release goes back to reading the generation at the moment it
  // runs rather than the one it took. That is the pre-fix build exactly, so it reddens
  // both halves - the release writing over the new document and resuming it, and the
  // slider event after the takeover rescaling a snapshot of the old one.
  'takeover-ignored': {
    file: 'web/main.js',
    edits: [
      ['  dropRateGesture();\n  return transportGen;', '  return transportGen;'],
      ['  const { wasPlaying, applied, rate: began, gen } = rateGesture;',
        '  const { wasPlaying, applied, rate: began } = rateGesture;\n  const gen = transportGen;'],
    ],
  },

  // The window's clamp goes back to being applied to its own previous output, so it
  // ratchets outward and a round trip never comes back. Reddens only the last of the four
  // round-trip rows - the three above it are about the trip happening at all, which this
  // leaves alone.
  'window-clamp-ratchets': {
    file: 'web/main.js',
    edits: [['  view.reclamp();', '  view.set(view.a, view.b);']],
  },

  // The detent goes back to acting on every position whatever the gesture began at, so a
  // loaded 1.02x is eaten by the first nudge. Reddens the nudge row and leaves the load
  // row and the two aiming rows green, which is what separates a detent that is too eager
  // from one that has stopped working.
  'detent-eats-loaded-rate': {
    file: 'web/main.js',
    edits: [[
      '  const holding = rateGesture ? rateGesture.detentArmed === false : false;\n'
      + '  return !holding && insideDetent(v) ? 1 : Number(rawRateFromSlider(v).toFixed(3));',
      '  return insideDetent(v) ? 1 : Number(rawRateFromSlider(v).toFixed(3));',
    ]],
  },

  // The anchor takes the frame below instead of the nearest one, which doubles what the
  // grid costs. Reddens the bound row of the off-grid arm and leaves its own "the anchor
  // does move" row green, plus the three on-grid arms above it - they land on the grid
  // either way, which is exactly why they could not see this.
  'anchor-floors-to-frame': {
    file: 'web/main.js',
    edits: [[
      'return Math.max(0, Math.min(this.lastFrame, Math.round(programSec * this.outputFps)));',
      'return Math.max(0, Math.min(this.lastFrame, Math.floor(programSec * this.outputFps)));',
    ]],
  },

  // A release of any key ends the gesture again, so tapping Shift while an arrow is
  // repeating splits one adjustment into several and loses the play intent. Reddens the
  // held-key block's commit, seek and resume rows.
  'keyup-ends-any-gesture': {
    file: 'web/main.js',
    edits: [[
      "ui.rate.addEventListener('keyup', (e) => {\n"
      + '  if (rateGesture && rateGesture.fromKey === e.key) endRateGesture();\n'
      + '});',
      "ui.rate.addEventListener('keyup', endRateGesture);",
    ]],
  },

  // A navigation pause stops announcing itself, so a resume queued behind an older rate
  // release still finds its own generation current and starts the take playing under a
  // gesture that had deliberately stopped it. Reddens the navigation row in section 4.
  'pause-keeps-resume': {
    file: 'web/main.js',
    edits: [['const pauseTransport = () => {\n  takeTransport();\n  timeline.pause();\n};',
      'const pauseTransport = () => {\n  timeline.pause();\n};']],
  },

  // The clip bounds go back to being compared in seconds against a playhead that is a
  // frame, so a playhead sitting on a cut reads as outside it after every rescale.
  // Reddens the boundary seek-count row and leaves the interior one green.
  // The clip range goes back to being written through unchecked, so a deliverable whose
  // `in` lands past the end of the program leaves `clipInSec` above `clipOutSec` and
  // `frameAt` composing to a constant. Reddens the three rows in section 7's deliverable
  // block that adopt `editor-check-past` and read the pair off the transport. The three
  // rows above them stay green on purpose: they are about the menu applying a trim and
  // about a held gesture, both of which this leaves working, and a control that reddened
  // them too would be naming a different defect. Rows further down the file can go red
  // behind it - a frozen `frameAt` is frozen for whatever seeks next - which is why the
  // rows are read rather than counted.
  // Re-anchored when the pair moved into `web/clip-range.js`. The clamp is handed the
  // program's length rather than reading a transport it can no longer see, so the block's
  // opening line is a test on that argument and the `const dur` that read it is gone. The
  // three lines the mutation is actually about are unchanged, and so is what removing them
  // does.
  'clip-range-unclamped': {
    file: 'web/clip-range.js',
    edits: [[
      '  if (dur !== null) {\n'
      + '    clipIn = Math.max(0, Math.min(clipIn, dur));\n'
      + '    // `null` still means "to the end", which is a different statement from a number that\n'
      + '    // happens to equal the duration: "whole clip" has to survive a retime that lengthens\n'
      + '    // the program, and a duration written in here would freeze it at today\'s length.\n'
      + '    if (clipOut !== null) clipOut = Math.max(clipIn, Math.min(clipOut, dur));\n'
      + '  }\n',
      '',
    ]],
  },

  // The program stops asking what a clip bound is, at both of the places that ask, so a
  // bound that is not a number is clamped instead of refused - which is arithmetic, so it
  // spreads: the in point becomes NaN and the `Math.max` holding the out point up carries
  // it into that one too. Reddens the five `editor-check-bad` rows in section 7 and nothing
  // else in the block - the fifth being the drain, which finds nothing to take out of the
  // page-error sweep because a build that does not refuse says nothing to the console.
  // The three `editor-check-past` rows above them stay green on purpose,
  // and that is the separation this control exists to make: the clamp itself still works,
  // and what is missing is the refusal in front of it.
  //
  // **Re-anchored onto the predicate itself when `clip-range.js` was extracted, and that is
  // a change of shape rather than of position.** It used to be two edits - the pair of
  // questions `applyDeliverable` asks, and the pair `setClipInOut` asks - and one of those
  // two call sites is in `web/main.js` while the other is now in `web/clip-range.js`. A
  // spec names one file, so two edits across two files cannot be written down here at all;
  // and mutating the answer instead of the two questions is the stronger mutation anyway,
  // because it takes the refusal away from every caller at once rather than from the two
  // that existed when this was written. The mutated build is the same one: both askers get
  // whatever they were handed back, unchecked, and the clamp then spreads it.
  'clip-bound-coerces-nonnumeric': {
    file: 'web/clip-range.js',
    edits: [
      [
        "  if (value === null && which === 'out') return null;\n"
        + '  if (typeof value === \'number\' && Number.isFinite(value)) return value;\n',
        "  if (value === null && which === 'out') return null;\n"
        + '  return value;\n',
      ],
    ],
  },

  // The refusal goes back to leaving the picker on the document it just refused, so the menu
  // names a configuration the clip is not on while the readout beside it names the one it is.
  // Reddens *both* picker rows in section 7, and the first draft of this comment claimed it
  // reddened only the first - measured 2 assertions, not 1, which is worth leaving written
  // down. Removing the revert leaves the picker sitting on the refused name, and that fails
  // both questions at once: it is the refused one, and it is not the adopted one. The second
  // row still earns its place, because it is aimed at a different wrong build - one that
  // reverts the picker to *something*, which would pass the first row while naming a
  // deliverable the clip is not on. No mutation here produces that build; the row is the
  // standing guard against a fix written that way later.
  //
  // The five `editor-check-bad` rows above stay green, because the refusal itself still
  // happens - this control removes what the page *says* about it, not the refusing.
  'refusal-strands-the-picker': {
    file: 'web/main.js',
    edits: [[
      "    ui.deliverable.value = ui.deliverable.dataset.adopted ?? '';\n",
      '',
    ]],
  },

  // `resize()` goes back to reallocating the drawing buffer and drawing nothing into it,
  // which leaves a parked stage black behind the chrome overlay. Reddens the three
  // resize rows in section 14 and nothing in section 9 or 11 - and that pair staying
  // green is the point of the control rather than a bonus: green section 9 says the call
  // did not become a per-frame pump, and green section 11 says it did not un-throttle
  // the splitter drag. Section 13's same-size row stays green too, and that is the third
  // thing this separates: a `resize()` that reallocates nothing needs no repaint either
  // way, so a control that reddened that row would be naming the guard rather than the
  // repaint.
  'resize-skips-repaint': {
    file: 'web/main.js',
    edits: [[
      '  const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());\n'
      + '  if (buffer.x !== wasBuffer.x || buffer.y !== wasBuffer.y) requestRepaint();\n',
      '',
    ]],
  },

  // `restoreProject` goes back to calling `params.spec` for its throw and discarding the
  // spec, so a document carrying a track on a view parameter opens - and `evaluateTracks`
  // has no tag filter, so that track calls `resize()` once per rendered frame. Reddens
  // the first row of section 15 and the empty-view-track row below it, which is the same
  // claim asked about the shape that used to walk past the check entirely. The two look
  // rows beside them stay green, which is what separates "the reader now reads the tag"
  // from "the reader stopped taking tracks", and the two unknown-name refusals stay green
  // too because this mutation leaves `params.spec`'s own throw where it is.
  //
  // Anchored on the `const spec =` binding and the `if` that reads it rather than on
  // the bare call the revert produces: `params.spec(name);` on its own appears twice in
  // `main.js` - once here and once in the parameter-value walk below it - so a mutation
  // written the other way round would match twice and refuse to run.
  'restore-accepts-view-track': {
    file: 'web/main.js',
    edits: [
      [
        '    const spec = params.spec(name);',
        '    params.spec(name);',
      ],
      [
        "    if (spec.tag !== 'look') {\n"
        + '      throw new Error(\n'
        + '        `the track on ${JSON.stringify(name)} is on a ${spec.tag} parameter: a project carries `\n'
        + "        + 'look tracks only, which is what this build writes and the only kind it can evaluate '\n"
        + "        + 'without resizing the drawing buffer from inside the render loop',\n"
        + '      );\n'
        + '    }\n',
        '',
      ],
    ],
  },

  'bounds-compare-off-grid': {
    file: 'web/main.js',
    edits: [[
      '    if (timeline.frame < frameIn) timeline.seek(clipIn).catch(showTimelineError);\n'
      + '    else if (frameOut !== null && timeline.frame > frameOut) timeline.seek(clipOut).catch(showTimelineError);',
      '    if (timeline.programSec < clipIn) timeline.seek(clipIn).catch(showTimelineError);\n'
      + '    else if (clipOut !== null && timeline.programSec > clipOut) timeline.seek(clipOut).catch(showTimelineError);',
    ]],
  },

  // The detent goes back to a band of rate rather than of pixels, which on the shipped
  // 92px control is 0.74px each side. Reddens the swept hit-target rows and leaves the
  // two value-driven rows green - which is exactly the pair that let this ship.
  'detent-in-rate-units': {
    file: 'web/main.js',
    edits: [[
      '  const width = ui.rate.getBoundingClientRect().width || 92;\n'
      + '  return Math.abs(Number(v) - sliderFromRate(1)) <= DETENT_PX / Math.max(1, width);',
      '  return Math.abs(rawRateFromSlider(v) - 1) <= 0.03;',
    ]],
  },

  // The zoom goes back to deriving its start from a span the clamp then refuses, so a
  // notch at the minimum window pans instead of doing nothing. Reddens the two clamp rows
  // and leaves every other zoom row green - they all start from a window with room.
  // Re-anchored when the window moved into `web/view-window.js`. The only thing that
  // changed in the text is the indent - the object literal is inside a factory now, so
  // every line in it carries two more spaces - and the mutation is the pre-fix zoom exactly
  // as it was.
  'zoom-pans-at-the-clamp': {
    file: 'web/view-window.js',
    edits: [[
      '      const span = Math.min(1, Math.max(this.minSpan(), (this.b - this.a) / factor));\n'
      + '      // Where the anchor sits in the window now, kept where it is in the window after.\n'
      + '      const held = (at - this.a) / Math.max(1e-9, this.b - this.a);\n'
      + '      const start = at - held * span;',
      '      const span = (this.b - this.a) / factor;\n'
      + '      const start = at - (at - this.a) / factor;',
    ]],
  },

  // The deliverable stops being a document replacement, so a gesture held across one
  // rescales the trim it began in and writes it back over the one just chosen. Reddens
  // only the last of the three deliverable rows - the two above it are about the menu
  // working at all, which this mutation leaves alone.
  'deliverable-keeps-gesture': {
    file: 'web/main.js',
    edits: [['  dropRateGesture();\n  setActiveDeliverable(deliverable);', '  setActiveDeliverable(deliverable);']],
  },

  // The keys and handles go back to inheriting the lane's `pan-y`, so a vertical touch
  // drag on one is claimed by the browser for scrolling. Reddens the two rows about them
  // and leaves the lane's own row green, which is the difference between the surface that
  // scrolls and the controls that must not.
  'keys-yield-touch': {
    file: 'web/index.html',
    edits: [['  .tkey, .thandle { touch-action: none; }', '  .tkey, .thandle { touch-action: pan-y; }']],
  },

  // The wheel goes back to reading its deltas as pixels whatever the browser said they
  // were. Reddens only the line-mode rows - a pixel-mode notch is unchanged by this,
  // which is what makes those rows about the unit rather than about zooming.
  'wheel-ignores-deltamode': {
    file: 'web/main.js',
    edits: [[
      "  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {\n"
      + '    return { x: e.deltaX * LANE_KEY_STEP, y: e.deltaY * LANE_KEY_STEP };\n'
      + '  }\n',
      '',
    ]],
  },

  // The keyboard loses the only gesture that moves a window without resizing it, which
  // is what the overview's pointer-only handlers left it needing. Zoom, fit and frame
  // stay, so the rows beside it stay green.
  'pan-keys-unbound': {
    file: 'web/main.js',
    edits: [[
      "    case ',': case '<': e.preventDefault(); if (view.panBy(-0.25)) viewChanged(); return;\n"
      + "    case '.': case '>': e.preventDefault(); if (view.panBy(0.25)) viewChanged(); return;\n",
      '',
    ]],
  },

  // A lane goes back to swallowing the vertical axis, so a touch swipe cannot reach a
  // lane below the fold. Reddens only the touch-action row - the wheel rows beside it
  // are unaffected, which is the difference between the two ways into the same scroller.
  'lanes-eat-touch': {
    file: 'web/index.html',
    edits: [[
      '.tlane { position: relative; height: 100%; touch-action: pan-y; }',
      '.tlane { position: relative; height: 100%; touch-action: none; }',
    ]],
  },

  // `change` goes back to ending every gesture, so a held arrow key is one gesture per
  // repeat again. Reddens the commit, seek and resume rows of the held-key block and
  // leaves its "the speed moved" row green, which is what separates a control that
  // stopped working from one that works six times over.
  'rate-ends-on-change': {
    file: 'web/main.js',
    edits: [[
      "ui.rate.addEventListener('change', () => { if (!rateGesture?.fromKey) endRateGesture(); });",
      "ui.rate.addEventListener('change', endRateGesture);",
    ]],
  },

  // The space bar stops reaching the transport. Everything else about the keyboard
  // stays, so this reddens the transport rows and leaves the stepping and range rows
  // alone - which is what makes it diagnostic of its own term.
  //
  // Re-anchored: the pause half of this branch became `pauseTransport()` in `51c7c9d`,
  // and `timeline.pause()` did not vanish from the tree, it moved off the line this
  // mutation cared about - so nothing casual would have spotted it while the control sat
  // dead for sixty commits. `syntax-check`'s anchor row is what now asks the question
  // cheaply; see `docs/instruments.md`.
  'space-unbound': {
    file: 'web/main.js',
    edits: [[
      '      // Or the page scrolls under the strip.\n      e.preventDefault();\n'
      + '      if (timeline.playing) pauseTransport();\n'
      + '      else timeline.play().catch(showTimelineError);\n      return;',
      '      // Or the page scrolls under the strip.\n      e.preventDefault();\n      return;',
    ]],
  },

  // Deleting a key goes back to being impossible - which it was, by every gesture
  // anybody tried: Delete, Backspace and a double click all left the count where it
  // was.
  'delete-ignores-selection': {
    file: 'web/main.js',
    edits: [[
      'function deleteSelectedKey() {\n  if (!timeline || !selection) return false;',
      'function deleteSelectedKey() {\n  if (!timeline || !selection || timeline) return false;',
    ]],
  },

  // Handles come back on flat segments - the dead affordance that made "the bezier
  // curves do not work" true. Both flat checks go, not just the drawing one: leaving
  // the check in `repositionLanes` would make every pointer move fall back to a
  // rebuild, and section 4's fallback row would go red for a reason that has nothing
  // to do with handles. A mutation has to redden its own row and leave its
  // neighbours green, or the table cannot say which term broke.
  'ease-handles-on-flat': {
    file: 'web/main.js',
    edits: [
      [
        '    // A flat segment gets none, for the reason `segmentHasShape` gives.\n'
        + '    if (!segmentHasShape(keys, seg, row.kind)) continue;\n',
        '',
      ],
      [
        '      // A segment that went flat under the drag has no shape left to edit, so its\n'
        + '      // handle has to go rather than be moved - which is a rebuild, not a move.\n'
        + '      if (!segmentHasShape(keys, seg, row.kind)) return false;\n',
        '',
      ],
    ],
  },

  // The gate goes back to naming one kind instead of asking the table - the shape the
  // camera track was locked out by, and the reason `KINDS` exists at all.
  //
  // **Aimed at one site rather than at the table**, so that what reddens is exactly the
  // pose preset rows and the scalar ones beside them stay green as the control. It
  // leaves the handles drawing and the lane drawn, and takes away only the preset row's
  // permission.
  //
  // An earlier version of this comment justified that by claiming a table edit "would
  // redden every kind-dependent row at once". For the `eases` flag the truth is the
  // exact opposite and worth stating, because it is the trap: flipping `eases` to false
  // reddens **zero** rows, since both sweeps in section 5 read their coverage domain out
  // of `easedKinds()`. That is what the reverse-inclusion row up there is for, and it is
  // the assertion that makes this mutation's scoping a choice rather than a hole.
  //
  // Measured: 5 assertions, all five `... on a pose key`. Its neighbour below fires 8
  // - the same five plus the three handle rows - and the difference is the point: two
  // mutations that both "break the camera's ease" have to be tellable apart, or the
  // table cannot say which term broke.
  'ease-gate-hardcodes-scalar': {
    file: 'web/main.js',
    edits: [[
      '  if (!row || !KINDS[row.kind].eases) return null;',
      "  if (!row || row.kind !== 'scalar') return null;",
    ]],
  },

  // A pose handle gets the scalar overshoot band back, which is what it inherited
  // before anybody asked what overshoot means on an axis that is already a fraction.
  // The handle leaves the unit box, the eased fraction goes past 1, and `hermite`
  // continues the segment's own cubic past the key - so the camera sails through the
  // pose it was keyed at and swings back to it.
  'pose-handle-overshoots': {
    file: 'web/main.js',
    edits: [[
      "    if (row.owner === 'retime' || !KINDS[row.kind].overshoots) h[1] = Math.min(1, Math.max(0, h[1]));",
      "    if (row.owner === 'retime') h[1] = Math.min(1, Math.max(0, h[1]));",
    ]],
  },

  // The pose lane draws a flat line through the middle of the strip - a lane that is
  // there, is the right height, holds its diamonds and says nothing. Every other pose
  // row in section 5 reads the evaluator, the handle geometry or the presets, so this
  // is the only mutation any of them can see the drawn curve through.
  'pose-lane-draws-flat': {
    file: 'web/main.js',
    edits: [[
      '    at: (owner, t) => poseLaneFraction(keysOf(owner), t),',
      '    at: () => 0.5,',
    ]],
  },

  // The beads stop being drawn, so the path says where the camera goes and nothing
  // about when it gets there. Kept as a named mutation after the row that was supposed
  // to catch it was measured NOT CAUGHT and replaced - see section 5's comment for what
  // a pixel diff of this canvas actually measures.
  // The beads mark equal *distances* along the path instead of equal times - the
  // plausible wrong version, and a much more convincing one than drawing none at all,
  // because the overlay still looks like an overlay. What it loses is the only thing
  // it was for: evenly spaced dots are a second drawing of the route, which the line
  // already gives, and they say nothing about when the camera is anywhere. Their
  // spacing stops responding to the handles, so section 5's spread ratio collapses
  // towards 1 on both arms.
  'beads-evenly-spaced': {
    file: 'web/main.js',
    edits: [[
      '  const out = [];\n'
      + '  for (let i = 0; i < points.length; i += BEAD_EVERY) out.push(points[i]);\n'
      + '  return out;',
      '  const seg = [];\n'
      + '  let total = 0;\n'
      + '  for (let i = 1; i < points.length; i++) {\n'
      + '    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1],\n'
      + '      points[i][2] - points[i - 1][2]);\n'
      + '    total += d;\n'
      + '    seg.push(total);\n'
      + '  }\n'
      + '  const want = Math.ceil(points.length / BEAD_EVERY);\n'
      + '  const out = [];\n'
      + '  for (let n = 0; n < want; n++) {\n'
      + '    const target = (total * n) / Math.max(1, want - 1);\n'
      + '    let i = seg.findIndex((s) => s >= target);\n'
      + '    if (i < 0) i = points.length - 2;\n'
      + '    out.push(points[i]);\n'
      + '  }\n'
      + '  return out;',
    ]],
  },

  // The NaN that a pose value's subtraction used to produce, restored as its honest
  // consequence: `segmentHasShape` answers false for every camera segment, so a pose
  // lane draws no handle and the preset row goes dead beside keys that plainly differ.
  // This is the defect the kind-aware `segmentHasShape` was written for, and it is
  // worth its own mutation because it fails *quietly* - a lane with no handles reads
  // as a lane with nothing to edit.
  //
  // Measured: 8 assertions - the five pose preset rows, and the three handle rows that
  // report `no handle drawn on the pose lane at all` and a drag that moved the value
  // from 0.8313 to 0.8313. Every scalar row stays green.
  'pose-segments-never-shaped': {
    file: 'web/main.js',
    edits: [[
      '    moved: (a, b) => poseMoved(a.value, b.value),',
      '    moved: () => false,',
    ]],
  },

  // The preset buttons stay live, stay enabled and write nothing - the shape of a
  // control that looks like it works.
  // The x clamp written against the segment's ends rather than against the dragged
  // point's neighbours - which is exactly the clamp that shipped, and was complete while
  // a side held one control point, because then the neighbours *were* the ends. With two
  // a side it lets them cross, and a crossed pair folds the timing curve back on itself
  // so the segment holds two values at one instant. Only a drag of a point that is not
  // index 0 can see it.
  'handle-clamped-to-the-segment': {
    file: 'web/main.js',
    edits: [[
      `    const span = handleSpan(keys, laneDrag.seg, laneDrag.side, laneDrag.index);
    h[0] = Math.min(span.hi, Math.max(span.lo, (laneProgramAt(e.clientX) - a.t) / dt));`,
      '    h[0] = Math.min(1, Math.max(0, (laneProgramAt(e.clientX) - a.t) / dt));',
    ]],
  },

  // `+pt` appends a control point instead of elevating the curve, which is the obvious
  // wrong implementation and the one this control exists to be safe from: the count goes
  // up, the lane draws the new handle, and the camera moves. Only the sampled-curve row
  // can see it, which is why that row samples rather than reading handles back.
  'elevation-moves-the-curve': {
    file: 'web/curve.js',
    edits: [[
      `  const cut = side === 'easeOut' ? a.length + 1 : a.length;
  return { easeOut: raised.slice(0, cut), easeIn: raised.slice(cut) };`,
      `  const grown = side === 'easeOut' ? { easeOut: [...a, [0.5, 0.5]], easeIn: b } : { easeOut: a, easeIn: [[0.5, 0.5], ...b] };
  return raised.length ? grown : grown;`,
    ]],
  },

  // `ends` writes the selected key rather than the track's two outer ones - which is
  // `smooth` wearing another name, and is exactly the edit that halts the camera at an
  // interior key. The `keepsSelected` half of the preset row is what sees it.
  'ends-reaches-the-selection': {
    file: 'web/main.js',
    edits: [[
      `  if (spec.firstOut && segmentHasShape(keys, 0, kind)) {
    keys[0].easeOut = copyHandle(spec.firstOut);
  }`,
      `  if (spec.firstOut && segmentHasShape(keys, 0, kind)) {
    keys[i].easeOut = copyHandle(spec.firstOut);
  }`,
    ]],
  },

  // ... and reaches only the departure, leaving the arrival unshaped. Separable from the
  // row above on purpose: a build that got the first key right and forgot the last is a
  // move that eases away and stops dead, which is half the reported defect surviving the
  // fix for it.
  'ends-skips-the-arrival': {
    file: 'web/main.js',
    edits: [[
      `  if (spec.lastIn && segmentHasShape(keys, keys.length - 2, kind)) {
    keys[keys.length - 1].easeIn = copyHandle(spec.lastIn);
  }`,
      '  if (false && spec.lastIn) { /* mutated */ }',
    ]],
  },

  // The glide dropped to a cubic. Its ordinates still read 0 and 1 so the *rate* still
  // reaches zero at the key and every velocity row stays green - what goes is the
  // second control point, and with it the acceleration claim and the degree. The preset
  // row's list comparison is what catches it, which is why that comparison walks the
  // whole list rather than element zero.
  'glide-is-a-cubic': {
    file: 'web/main.js',
    edits: [[
      "  glide: { out: [[0.2, 0], [0.4, 0]], in: [[0.6, 1], [0.8, 1]] },",
      "  glide: { out: [[0.2, 0]], in: [[0.8, 1]] },",
    ]],
  },

  // The point controls offered on the retime, where the unit-box monotonicity proof does
  // not hold. `assertMonotonic` would refuse the document afterwards, which is the loud
  // half - this control is about the editor not walking into it in the first place.
  'points-reach-the-retime': {
    file: 'web/main.js',
    edits: [[
      "  if (!state || selection.owner === 'retime') return [];",
      '  if (!state) return [];',
    ]],
  },

  'ease-preset-ignored': {
    file: 'web/main.js',
    edits: [[
      '  if (spec.out) keys[i].easeOut = copyHandle(spec.out);\n'
      + '  if (spec.in) keys[i].easeIn = copyHandle(spec.in);\n'
      + '  if (spec.nextIn && i < keys.length - 1) keys[i + 1].easeIn = copyHandle(spec.nextIn);',
      '  void spec;',
    ]],
  },

  // The chip scroller loses its ability to shrink, which is what lets the row's
  // contents push everything after them off the right edge.
  //
  // **It took three attempts to aim this one, and the two misses are worth recording
  // because each looked exactly like a control that works.** `pin-min-width-auto`
  // removed the `min-width: 0` rules from `.tpin` and was NOT CAUGHT: those were the
  // fix for the *old* single-row bar, where the deliverable select sat in the pinned
  // end and one long name set a floor the 46% box could not shrink under - and the
  // deliverable moved into the scroller when the bar became two rows, so nothing with
  // a variable intrinsic width is pinned any more. `export-not-pinned` then moved the
  // export chip back into the scroller and was *also* NOT CAUGHT, because row two
  // holds so much less than the old single row did that the button stays on screen
  // even unpinned.
  //
  // Both misses say the same thing, which is worth knowing about the fix: the two-row
  // split is what made the button reachable, and the pin is belt-and-braces on top of
  // it. What is still load-bearing underneath both is that the scroller can give
  // ground - a flex child with visible overflow takes `min-width: auto`, refuses to
  // shrink below its content, and pushes whatever follows it out of the box. That is
  // one line, it is the mechanism the layout actually rests on, and removing it
  // reddens the reachability rows and nothing else.
  'scroller-cannot-shrink': {
    file: 'web/index.html',
    edits: [[
      '  .tchips { flex: 1; display: flex; gap: 8px; flex-wrap: nowrap; align-items: center;\n'
      + '    justify-content: center; min-width: 0; overflow-x: auto; scrollbar-width: none; }',
      '  .tchips { flex: 1; display: flex; gap: 8px; flex-wrap: nowrap; align-items: center;\n'
      + '    justify-content: center; }',
    ]],
  },

  // The lateral crop reads the wrong axis: `left`/`right` become the vertical pair and
  // `bottom`/`top` the horizontal one. Every plane still culls, the same number of
  // points still disappear, and the four sliders are wired to the wrong sides - which
  // is invisible to any row that only counts what was removed.
  'crop-axes-swapped': {
    file: 'web/cloud-shader.js',
    edits: [[
      '  if (cropOn == 1.0 && (pos.x < cropL || pos.x > cropR || pos.y < cropB || pos.y > cropT)) {',
      '  if (cropOn == 1.0 && (pos.y < cropL || pos.y > cropR || pos.x < cropB || pos.x > cropT)) {',
    ]],
  },

  // The box becomes a wedge - the crop is read as an angle rather than a position, so
  // it widens with depth the way the sensor's own frame does. Rigged to agree with the
  // box exactly at 2m, because a mutation that disagreed everywhere would also be
  // caught by rows that are not about this, and the claim under test is specifically
  // that a plane stays where it was put as the subject walks away from the sensor.
  'crop-in-image-space': {
    file: 'web/cloud-shader.js',
    edits: [[
      '  if (cropOn == 1.0 && (pos.x < cropL || pos.x > cropR || pos.y < cropB || pos.y > cropT)) {',
      '  float wedge = 2.0 / max(0.001, z);\n'
      + '  if (cropOn == 1.0 && (pos.x * wedge < cropL || pos.x * wedge > cropR\n'
      + '   || pos.y * wedge < cropB || pos.y * wedge > cropT)) {',
    ]],
  },

  // The name field stops reaching the export, which is where it was before there was
  // a field: every render was named after the take and overwrote the last one.
  'export-ignores-name': {
    file: 'web/main.js',
    edits: [['      name: options.name ?? exportBaseName(),', '      name: options.name ?? timeline.source.id,']],
  },
};

/**
 * The mutated source, refused loudly when an anchor no longer matches exactly once.
 *
 * A mutation is a piece of source text, so it goes stale the moment the code it names
 * is edited - and a replacement that silently matched nothing would run the unmutated
 * build and be recorded as this tool having missed a bug it was never shown.
 */
function mutatedSource(name) {
  const spec = MUTATIONS[name];
  if (!spec) throw new Error(`unknown mutation ${name} - have ${Object.keys(MUTATIONS).join(', ')}`);
  let source = readFileSync(join(REPO, spec.file), 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`mutation ${name} matched ${hits} times in ${spec.file}, expected exactly 1: `
        + `${JSON.stringify(from.slice(0, 90))}`);
    }
    source = source.replace(from, to);
  }
  return { file: spec.file, body: source };
}

// ------------------------------------------------------------------- playwright

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch { /* no global npm root: the local resolve below may still work */ }
  const candidates = [async () => import('playwright')];
  for (const root of roots) {
    for (const name of ['playwright', '@playwright/cli/node_modules/playwright']) {
      candidates.push(async () => import(pathToFileURL(require.resolve(join(root, name))).href));
    }
  }
  for (const load of candidates) {
    try {
      const mod = await load();
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  throw new Error('playwright not found - install it globally or in this project');
}

// --------------------------------------------------------------------- reporting

let failures = 0;
let checks = 0;
// The labels, not only the count. "3 assertions fired" cannot be checked for having
// fired *for the reason claimed*, and a row that goes red for a neighbouring reason
// looks exactly like a control that works.
const fired = [];
const check = (ok, label, detail = '') => {
  checks++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
  if (!ok) { failures++; fired.push(label); }
};
const note = (label, detail = '') => console.log(`  ....  ${label}${detail ? `   ${detail}` : ''}`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A throw is the harness not running rather than a finding in either direction.
// `monitor-check` counted its own timeout in `failed` and printed "caught, as
// required (1 assertion fired)" having tested nothing at all about the thing under
// test. This is that fix applied before the tool has a chance to earn the mistake.
let crashed = null;
let untested = null;

// ------------------------------------------------------------------- the drivers
//
// Every interactive control the editor renders has to be covered here, and coverage
// means "this file, or a named file, drives it and watches something change". The
// rules come before the names because most of the panel is one rule - but a rule is
// still an entry, so nothing is covered by silence.
//
// **Keyed rather than indexed, and that is a repair.** `covered()` below used to reach
// for `DRIVER_RULES[2]`, `[3]`, `[4]` by position, so removing a rule from the middle of
// this array silently re-pointed every attribution after it: the sweep would still pass,
// with each remaining group credited to the wrong driver. Deleting the `#modes` rule
// when the shading modes became registry parameters is exactly that edit, and nothing
// would have failed. A key cannot slide.
//
// **`match` is the implementation and `covered()` walks it, which is the second repair
// on this array.** Every rule here used to carry a `match` written against a DOM element
// and `covered()` re-spelled the same condition against the serialized row, so the field
// was decoration: adding a rule with a `match` and no matching branch below produced a
// rule that matched nothing and said nothing, which is exactly what the mark rule did
// when it arrived. Two spellings of one condition where only one is executed is not a
// cross-check, it is a place to write a rule that does not exist. So a match takes the
// serialized row, and the row carries whatever a rule needs to ask about.
//
// Order is precedence, and `look` is last on purpose: it is the widest rule and would
// otherwise claim controls the narrower ones are the honest attribution for. That only
// moves which driver a covered control is credited to, and crediting a program-out
// select to the look sweep is a wrong answer that reads like a right one.
const DRIVER_RULES = [
  {
    key: 'keyframe',
    what: 'a keyframe toggle',
    by: 'keyframe-check, and section 5 here deletes what it creates',
    match: (row) => row.kf && row.id !== 'tRateKey',
  },
  {
    key: 'recorder',
    what: 'a recorder-surface control',
    by: 'sensor-view-check section 6 and library-check',
    match: (row) => inGroup(row, '#recordGroup', '#recLookGroup', '#sensorGroup', '#monitorGroup'),
  },
  {
    key: 'subset',
    what: 'a control in the dialog that asks which look values a preset carries',
    // Named because section 12 drives it end to end - it opens the dialog from export,
    // reads what it offers against the registry, unticks a heading and a reading,
    // confirms, and reads the keys of the file the browser wrote - and because it
    // presses cancel and asserts nothing was written. A rule naming a control nobody
    // touches is the coverage claim this section exists to refuse.
    by: 'section 12 opens it from export and from save, unticks, confirms, cancels, '
      + 'and reads the document that came out',
    // Against the serialized row like every rule beside it, and that is the merge doing
    // what the comment above this array asks for rather than a tidy-up: this rule
    // arrived written against a DOM element, back when `covered()` re-spelled the same
    // condition itself and the field was decoration. Walked rather than re-spelled, an
    // element-shaped match is handed a row with no `closest` and the dialog's fifty-odd
    // boxes fall through to the panel rule - credited to a sweep that has never opened
    // this dialog, which is the misattribution the re-keying exists to stop.
    match: (row) => inGroup(row, '#presetPick'),
  },
  {
    key: 'shelldialogs',
    what: 'a control in the Project settings, Export, OBS, or state dialog',
    by: 'section 1 opens each application dialog, drives every enabled control, and '
      + 'asserts every format the export dialog offers is one the server encodes',
    match: (row) => inGroup(row, '#projectDialog', '#exportDialog', '#obsDialog'),
  },
  {
    key: 'paneltabs',
    what: 'an inspector tab',
    by: 'section 1 presses all four tabs and reads which declared panel groups remain on screen',
    match: (row) => inGroup(row, '#panelTabs'),
  },
  {
    key: 'groupreveal',
    what: 'the control that shuts or opens a panel group',
    // Named because section 16 enumerates them off the page and presses every one it
    // finds, rather than pressing the four that exist today. That distinction is the
    // whole value of the rule: a group gains a toggle by declaring `collapses` in
    // `PANEL_GROUPS`, so a fifth one appears here without anybody editing this file,
    // and a rule crediting a control no section drives is `plant-unswept-control`
    // wearing a rule's clothes.
    by: 'section 16 reads every collapsible group off the page, presses each one, and '
      + 'asserts the rows under it changed visibility',
    // `row.groupToggle` rather than `el.dataset.groupToggle`, for the reason spelled
    // out on the subset rule above. A row carries no `dataset`, so the element spelling
    // reads `undefined` and matches nothing - and a rule matching nothing is the shape
    // the barren-rule row below exists to catch, which is where this would have surfaced
    // if the sweep had been the thing that caught it.
    match: (row) => Boolean(row.groupToggle),
  },
  {
    key: 'reset',
    what: 'the control that puts one look parameter back on its default',
    // A rule and not fifty-one ids, for the reason the group toggle above is a rule:
    // a parameter gains one of these by being a look scalar in the registry, so the
    // fifty-second appears here without anybody editing this file. **This entry arrived
    // late and the sweep is what said so** - the reset shipped as a `type=button` inside
    // `#panel`, which the look rule below does not match because that rule is about a
    // range and a checkbox, so section 1 was red with fifty-one uncovered controls the
    // first time it was run against the feature. That is the sweep doing its job, and it
    // is worth knowing that no amount of driving the buttons by hand would have said it.
    by: 'section 17 presses every one of them - the list is the registry\'s, walked per '
      + 'inspector - and reads the registry, the slider and the readout back afterwards; '
      + 'two of the presses are read further, for the group they shut and the caret they left',
    match: (row) => Boolean(row.reset),
  },
  {
    key: 'output',
    what: 'a program-out control',
    // Named because it is driven, not because it is exempt. `vcam-check` section 5
    // opens the operator surface and the source together, moves both of these, and
    // asserts the source's drawing buffer and its camera actually followed - which is
    // the only place they can be checked, since what they change is a different page.
    by: 'vcam-check section 5 sets both from the operator page and reads the source',
    match: (row) => inGroup(row, '#programOutGroup'),
  },
  {
    key: 'camera',
    what: 'a camera-composition control',
    by: 'keyframe-check drives the path; sensor-view-check drives `sensor view`',
    match: (row) => inGroup(row, '#cameraGroup') || row.id === 'camSensor',
  },
  {
    key: 'mark',
    what: 'a mark tick on the ruler',
    // A rule rather than an id, because there is one of these per mark on the take
    // and the fixture decides how many. Section 14 presses one and reads the playhead
    // back, which is the row that matters here: the sweep can only say the control is
    // covered, and a tick that seeks to the wrong second is a covered control that
    // does the wrong thing.
    by: 'section 13 presses a tick under a non-unity rate and reads where the playhead landed',
    match: (row) => row.mark,
  },
  {
    key: 'appbar',
    what: 'an application-bar command or navigation link',
    by: 'section 1 opens every menu, drives the commands that stay on this page, and '
      + 'asserts the two real navigation destinations in the markup',
    // `#navRow` and not `#appBar`, and the narrowing is the whole point of the entry.
    // Written as the container, this rule covered anything anywhere in the application
    // bar - and the bar stopped being only menus when the status slot moved into it, so
    // `plant-unswept-control` planted its button in that slot, matched here on the
    // strength of sharing an ancestor with the File menu, and the mutation went NOT
    // CAUGHT while reporting 420 assertions and 0 failures. A falsification control that
    // passes is worse than none, because the row it guards goes on reading green.
    //
    // What section 1 actually enumerates is the menus, so that is what the rule may
    // claim: the nav row, and a button or a link inside it. The back link sits outside
    // the nav row and is named in `DRIVER_IDS` instead, beside the assertion that reads
    // its href. Anything else the bar grows - a chip, a field, a button in the status
    // slot - is now uncovered until something drives it, which is the answer this rule
    // was supposed to be giving all along.
    //
    // **Narrowed a second time, by the same failure arriving through a different door.**
    // The row above was already the repair for a button planted in the status slot; written
    // as "a `BUTTON` in `#navRow`" it went on covering every button the *row* grew, and
    // the row stopped being only menus the moment the panel's collapse toggle was put in
    // it. `panelToggle` matched here on nothing but sharing an ancestor with the File
    // menu, and section 1 has never pressed it - so of the five controls the dock work
    // added, four went red and the fifth went green. The green one is the worse half:
    // four uncovered controls are a list of work to do, and a rule crediting a driver
    // that does not drive is a control reported as tested for as long as nobody reads
    // the attribution. Caught by running the sweep and counting, not by reading it.
    //
    // A menu is now what the rule may claim: a trigger or a command inside an `.appmenu`
    // wrapper, plus the links, which is precisely what section 1 opens and drives. A
    // bare button dropped in the row beside them is uncovered until something drives it.
    //
    // The collapse control has since moved off the row and into the View menu as
    // `menuShowSidebar` (fb03887), so it is inside `.appmenu` and this rule would now
    // claim it. It stays in `DRIVER_IDS` anyway, for the reason given there: it is the
    // one command in that popover whose press moves the layout every later section reads.
    match: (row) => inGroup(row, '#navRow') && (inGroup(row, '.appmenu') || row.tag === 'A'),
  },
  {
    key: 'preset',
    what: 'an entry, its delete, or the add button inside the preset picker',
    // Before the panel-wide rule below it, because that one is the widest and ordering is
    // precedence. These have no ids to name them one at a time - an option is built per
    // document in the library, so the set is the library's length and not a list anything
    // here could write down - which is exactly the case a rule is for.
    by: 'section 19 opens the picker, walks it with the keyboard, applies an entry, '
      + 'and deletes one and reads where the caret went',
    match: (row) => inGroup(row, '#lookPresetGroup')
      && (row.tag === 'DIV' || row.label.startsWith('Delete preset') || row.id === 'tPresetAdd'),
  },
  {
    key: 'look',
    what: 'a look parameter slider or checkbox',
    by: "registry-check's drop-one sweep proves each one reaches the pixels",
    match: (row) => inGroup(row, '#panel') && (row.type === 'range' || row.type === 'checkbox'),
  },
];

/** Whether a swept control sits inside any of these ancestors. */
// Above the rules rather than beside `covered()`, because the rules call it and a
// `const` read before its own declaration is a TDZ error rather than a hoisted function.
// Hoisted for that reason and no other.
function inGroup(row, ...groups) {
  return groups.some((g) => row.groups.includes(g));
}

// Named one at a time, because each of these is a control this file presses itself.
const DRIVER_IDS = {
  tPlay: 'section 2 - toggles playback and the state is read back',
  tRate: 'section 4 - the anchor rows and the seek-storm row',
  tCamView: 'section 1 - looks through the program camera and reads the orbit back',
  tRateKey: 'section 5 - plants and removes a retime key',
  // `tFps` is deliberately not here. It moved into Project settings with the rate itself,
  // so the `shelldialogs` rule covers it and section 1 drives it - which is a credit that
  // names a press. The entry it replaces read "timeline-check and export-check change the
  // output rate and count frames", and both of those write `transport().outputFps`
  // directly: true of the model, false of the control, and this file exists because the
  // suite once tested the first and never the second.
  tSetIn: 'section 3 - sets the range from the playhead',
  tSetOut: 'section 3 - sets the range from the playhead',
  tClearRange: 'section 3 - puts the range back to the whole clip',
  tMark: 'library-check writes a mark and reads the sidecar back',
  tDeleteKey: 'section 5 - removes the selected key',
  tAddPoint: 'section 5 - grows a segment\'s degree and reads the curve back unmoved',
  tDropPoint: 'section 5 - shrinks it again, and both are read dead on the retime',
  tPrevKey: 'section 18 - walks the selected track and reads which key the playhead landed on',
  tNextKey: 'section 18 - walks the selected track and reads which key the playhead landed on',
  tPreset: 'library-check applies a preset and compares the look',
  // Both credited to `library-check` and neither pressed by it, which is how they came
  // to be deleted when the rework took the controls away - and they are back because
  // section 13 presses them, which is a driver naming what actually drives.
  tProject: 'section 13 - selects the project built on other footage and opens it, which is what makes the refusal',
  tProjectOpen: 'section 13 - the press that produces the longest refusal this program writes',
  // `tPresetApply` was named here, credited to `library-check`, and both halves were
  // false at once in the way the two project entries above used to be: the picker
  // applies on choice now, so no such button is rendered, and `library-check` has never
  // referenced it. Applying belongs to the `preset` rule, which sections 12 and 19 drive
  // through the list the way a hand does - `applyByChoosing` in the first and the two
  // clicks before the reset sweep in the second.
  tPresetSave: 'library-check',
  tPresetExport: 'section 9 - exports the look and reads the file the browser wrote',
  tPresetImport: 'section 9 - opens the picker the file input is the other half of',
  tPresetFile: 'section 9 - a file is set on it and the look it names arrives',
  // The project picker and its two buttons used to be named here, credited to
  // `library-check`. Both halves of that stopped being true at once: the rework routes
  // opening through the gallery and Save as through the application bar, so none of the
  // three elements exists - and `library-check` never pressed them anyway, it reads the
  // page's refusals and drives the take. An id crediting a driver that does not drive it is the
  // shape this table exists to refuse, so they are gone rather than left as three lines
  // that would silently cover a control if one came back under the same name.
  tResumeOpen: 'section 13 - plants an autosave, presses it, and reads the restored document back',
  // The back link, named here because it sits in the application bar but outside the nav
  // row the `appbar` rule was narrowed to. Section 1 reads its href alongside the
  // library link's rather than following it, which is the assertion that matters for a
  // control whose whole behaviour is where it points.
  toMenu: 'section 1 - reads the href it navigates to, beside the library link',
  // **Both of these were credited to `library-check`, and it presses neither.** It writes
  // deliverable *directories* on the server and reads the page's refusals; it has never referenced
  // either control. The picker's other half was true - section 6 does plant a name in it
  // and read the refusal back - so that half is what is left. The `new` button had nothing
  // true said about it at all, which is the shape the two project entries above record,
  // arriving a third time. Section 1 presses it now, so the credit names a press.
  tDeliverable: 'section 6 - plants a long name in it and reads back which one the picker is left on',
  tDeliverableNew: 'section 1 - presses it and reads the prompt it opens, the way Save as is driven',
  tExportName: 'section 7 - names the file and refuses a path',
  tExportSize: 'export-check sweeps every size the menu offers',
  tExport: 'section 6 asserts it is reachable, section 7 renders with it',
  tExportSave: 'section 7 - the saved copy, against a stubbed picker',
  cropReset: 'section 8 - opens the crop box again and the planes are read back',
  cropFit: 'section 8b - presses it on a document opened out to +/-6 and reads back both the '
    + 'planes it restores and the undo entry it makes',
  cropBox: 'section 20 - presses it, reads the handles it puts on screen, drags one of them '
    + 'and counts what the gesture cost the animation loop',
  camLevelReset: 'level-check section 5 - clicks this element and reads both axes and both sliders at neutral',
  // The collapse and the four controls it uncovers. Named one at a time rather than
  // given a rule over `#panelDock`, and the difference matters: a rule would cover a
  // fifth dock button the day somebody added one, and the dock is four buttons because
  // four is what a thumb can find without looking. A new one should arrive here red.
  // Named here rather than left to the `.appmenu` rule above, even though the control
  // now sits inside that wrapper and the rule would claim it. The rule's claim is that
  // section 1 opens a menu and drives its commands, and this is the one command in the
  // popover whose press changes the page's layout - crediting it to a sweep that presses
  // every entry it finds would have section 1 collapsing the panel underneath the twenty
  // sections after it. Section 21 drives it deliberately, and says so.
  menuShowSidebar: 'section 21 - collapses the panel from the View menu and restores it from the key, '
    + 'and reads the class, the control and the buffer back across the round trip',
  dockCentre: 'section 21 - presses it and reads the pose against the one the View menu\'s own reset lands',
  dockSensor: 'section 21 - presses it and reads the pose against the one Framing\'s own sensor view lands',
  // Named for the one assertion this surface can honestly make about them, in the shape
  // `toMenu` above is named: that entry is credited to reading the href rather than to
  // following the link, because reading it is what section 1 does. These two are the
  // recorder's controls and the editor withholds them, so what section 21 enforces is
  // that the dock withholds them too. Crediting a recorder-surface tool instead would be
  // a driver that does not drive, which is the entry directly above this comment block
  // in the rules - and the reason four of these five arrived uncovered and one did not.
  dockMark: 'section 21 - asserts the editor does not offer it, which is all this surface '
    + 'should show of a control the recorder owns',
  dockRec: 'section 21 - asserts the editor does not offer it, which is all this surface '
    + 'should show of a control the recorder owns',
};

// ------------------------------------------------------------------- the page

const { chromium } = await loadPlaywright();

/**
 * Which file each surface this tool opens is served from.
 *
 * The two entries `server/index.js`'s `PAGES` map holds for the two surfaces below, and
 * an identity test rather than a rule about a suffix. The question a mutation's file has
 * to answer is "are you the document this page is", not "do you look like markup": a
 * suffix rule would take a spec naming `web/menu.html` - a real file this server really
 * serves, at `/` - and hand its bytes over as the editor's document, at which point the
 * interception fires, the delivery counter counts it and the guard below is satisfied by
 * a page nobody wrote. `registry-check` records that shape at its own boundary. Here a
 * file no page requests stays unserved and is refused, which is the honest failure.
 */
const SURFACE_DOCUMENTS = {
  '/edit': 'web/index.html',
  '/record': 'web/index.html',
};

/**
 * Where the file a mutation names is asked for by a page opened at `documentPath`, and
 * what it is handed back as.
 *
 * Matched on the whole pathname rather than with a `**​/name.js` glob, because a glob on
 * the basename is a claim about a filename where the server's rule is about a path - two
 * modules could end in the same name and the wrong one would be served without anything
 * failing. `export-check`, `keyframe-check`, `timeline-check` and `sensor-view-check`
 * carry the same function for the same reason. This copy also has a document to place,
 * because `web/index.html` is not served at `/index.html` - it is what `/edit` and
 * `/record` are.
 */
function servedAt(file, documentPath) {
  if (file === SURFACE_DOCUMENTS[documentPath]) {
    return { path: documentPath, contentType: 'text/html; charset=utf-8' };
  }
  const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const ext = file.slice(file.lastIndexOf('.'));
  if (file.startsWith('web/') && TYPES[ext]) {
    return { path: `/${file.slice('web/'.length)}`, contentType: TYPES[ext] };
  }
  throw new Error(`${file} is neither a module or stylesheet under web/ nor the document `
    + `${documentPath} is served from, so no page this tool opens would ever request it`);
}

let mutation = null;
try {
  mutation = MUTATE ? mutatedSource(MUTATE) : null;
  // Resolved before a browser is launched rather than at the first route, so a file no
  // page could request is refused the way an anchor that stopped matching is refused two
  // lines above - and by the same branch, which is why it is inside this `try`.
  if (mutation) servedAt(mutation.file, EDITOR_PATH);
} catch (err) {
  console.log(`[editor] DID NOT RUN - ${err.message}`);
  process.exit(2);
}
if (MUTATE) {
  console.log(`[editor] MUTATED BUILD: ${MUTATE} in ${mutation.file} at `
    + `${servedAt(mutation.file, EDITOR_PATH).path} - this run is expected to FAIL`);
}

/**
 * Install the active mutation on one page, and hand back the count of times that page
 * actually asked for it.
 *
 * **Keyed on the file the spec names, rather than filtered against the list of files this
 * tool used to know.** What this replaces was a pair of bodies selected by
 * `mutation.file === 'web/main.js'` and `=== 'web/index.html'` - true of every spec here
 * by coincidence, and true right up until the module began splitting. A spec naming a
 * third file matched neither, so neither route was installed, and the two delivery guards
 * were written against those same two names, so they could not fire either. The run then
 * completed against the tree's own source with every row green and printed NOT CAUGHT,
 * which is the verdict this suite reserves for a check that is blind to a real bug rather
 * than for a harness that never tried. Measured on a spec pointed at `web/scene.js`, a
 * module `main.js` imports: 461 assertions, 0 failed, which is the unmutated baseline to
 * the assertion.
 *
 * One helper for both surfaces rather than the routes written out at each of them,
 * because `page.route` is installed per page: a page that missed one runs the tree's own
 * build beside a page running the mutated one, and the two arms of one comparison are
 * then measuring two programs.
 */
async function serveMutation(page, documentPath) {
  if (!mutation) return { path: null, served: () => 0 };
  const { path, contentType } = servedAt(mutation.file, documentPath);
  let served = 0;
  await page.route((url) => url.pathname === path, (route) => {
    served++;
    route.fulfill({ contentType, body: mutation.body });
  });
  return { path, served: () => served };
}

// The picker stub, installed before the module evaluates rather than after.
//
// `main.js` reads `typeof globalThis.showSaveFilePicker === 'function'` once at load
// to decide whether the button can work at all, so a stub installed after the page
// exists would arrive to find the control already disabled and the row would test the
// disabling rather than the saving. It also records `navigator.userActivation.isActive`
// at the moment it is called, which is the only way to see the ordering the feature
// depends on: awaiting the fetch before opening the sheet spends the transient
// activation the API requires, and the sheet then never opens.
// Chunks are kept whole and joined at the end rather than spread into an array as
// they arrive. `push(...chunk)` on a 64KB chunk passes 65,536 arguments and throws
// `Maximum call stack size exceeded` - which the page catches and reports as
// `save failed`, so the *stub* failing looked exactly like the feature failing.
// Measured on the first run of this row: the picker had been called, the activation
// was live and the suggested name was right, and the row still went red.
const PICKER_STUB = `(() => {
  globalThis.__saved = { called: false, suggestedName: null, hadActivation: null, chunks: [], closed: false };
  globalThis.showSaveFilePicker = async (opts) => {
    globalThis.__saved.called = true;
    globalThis.__saved.suggestedName = opts?.suggestedName ?? null;
    globalThis.__saved.hadActivation = navigator.userActivation ? navigator.userActivation.isActive : null;
    return {
      createWritable: async () => new WritableStream({
        write(chunk) { globalThis.__saved.chunks.push(chunk); },
        close() { globalThis.__saved.closed = true; },
      }),
    };
  };
})()`;

/**
 * The console settled, so a mark taken after this cannot be overtaken by what came before.
 *
 * Playwright delivers console events over CDP asynchronously, so a line written just before
 * a mark is sampled can land in the array just after it. Section 12 provokes five refusals
 * in a row and reads each one back, which is exactly the shape that race spoils: the fifth
 * read returns the fourth sentence, the row about three documents getting three distinct
 * sentences goes red, and it does so intermittently. Waiting for a quiet stretch before
 * marking is what makes "past this index" mean "caused by what I do next".
 *
 * Bounded, because a page that never goes quiet must not hang the run - it returns the
 * index it has and the row downstream reddens on the content instead.
 */
async function consoleSettled(errors, quietMs = 250, ms = 5000) {
  const until = Date.now() + ms;
  let seen = -1;
  let since = Date.now();
  for (;;) {
    if (errors.length !== seen) { seen = errors.length; since = Date.now(); }
    if (Date.now() - since >= quietMs || Date.now() >= until) return errors.length;
    await new Promise((done) => { setTimeout(done, 50); });
  }
}

/**
 * The first thing the page said past `at` matching `re`, waited for rather than sampled.
 *
 * The editor's refusals were read off a chip in its application bar until that chip was
 * removed; `showTimelineError` is a console line now, so the refusals that are still worth
 * asserting - the four sentences a hand-edited preset file gets back, the take-hash refusal,
 * the library that would not list - are read out of the array `openEditor` fills from
 * `pageerror` and `console` for the end-of-run sweep.
 *
 * **It matches rather than waiting for the array to grow, and the difference is a defect
 * this shipped with.** Written as "wait until `errors.length !== at`" it returned whatever
 * arrived first, which on this page is as likely to be a `Failed to load resource` 404 as
 * the refusal - so a content row read a string about something else and went red about a
 * build with nothing wrong with it. `library-check`'s copy of this helper was written the
 * matching way from the start and the two spellings should not have been allowed to differ.
 *
 * The pattern callers pass names the *channel* rather than the sentence - `[timeline]` is
 * what `showTimelineError` prefixes, `[library]` is the listing report - so this waits for
 * the right kind of line without presupposing which sentence is in it, which is the whole
 * question the rows downstream are asking.
 *
 * A Node-side poll and not `waitForFunction`, because the array being waited on is in this
 * process rather than in the page. **It resolves to the empty string on a timeout rather
 * than throwing**, for the reason every wait in this file has a `.catch`: a build where the
 * refusal never happens has to redden the row that asked for it, where a throw here arrives
 * as `DID NOT RUN` and reports nothing about the mutation that caused it.
 *
 * Module scope rather than a closure inside `openEditor`, because that is where it started
 * and the whole run died at `saidOnConsole is not defined` 364 assertions in - the sections
 * that read refusals are outside that function, and only `page` and `errors` come out of it.
 */
async function saidOnConsole(errors, at, re, ms = 15000) {
  const until = Date.now() + ms;
  for (;;) {
    const hit = errors.slice(at).find((e) => re.test(e));
    if (hit !== undefined) return hit;
    if (Date.now() >= until) return '';
    await new Promise((done) => { setTimeout(done, 50); });
  }
}

async function openEditor() {
  // Local Network Access is off, and it is an artifact of how a markup mutation has
  // to be delivered rather than anything about the build: serving the document
  // through `route.fulfill` puts the page in a context Chromium treats as external,
  // so its WebSocket back to localhost is refused and the run ends having tested
  // nothing. Passed on every launch rather than only the mutated ones, because two
  // browsers configured differently is two things being measured.
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: !HEADED,
    args: ['--disable-features=LocalNetworkAccessChecks'],
  });
  // Downloads accepted, because section 9 catches one: a look leaves this program as a
  // file the browser writes, and a context that discards downloads would fail that row
  // for a reason that is about Playwright rather than about the export.
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, acceptDownloads: true });
  await context.addInitScript(PICKER_STUB);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

  // The interception is proved below rather than assumed. A route that was declared
  // and never installed ran the tree's own source and came back NOT CAUGHT with every
  // row green - a mutation that did nothing, reported as a check that found nothing.
  const mutant = await serveMutation(page, EDITOR_PATH);

  await page.goto(`${URL_BASE}${EDITOR_PATH}?take=${encodeURIComponent(TAKE)}`, { waitUntil: 'load' });
  const waitFor = async (expr, what, timeout = 30000) => {
    try {
      await page.waitForFunction(expr, null, { timeout });
    } catch (err) {
      throw new Error(`${what}: ${err.message.split('\n')[0]}`
        + (errors.length ? ` - the page said: ${errors.slice(0, 3).join(' | ')}` : ' - the page reported nothing'));
    }
  };
  await waitFor('!!globalThis.__kinect', 'the module never finished booting');
  await waitFor('!!globalThis.__kinect.timeline.transport()', 'the take never opened');
  // **And then for the open to be over, which is not the same moment.** The transport
  // exists partway through `openTake`; the marks, the three library listings and the crop
  // box's fit all land after it. Waiting on the weaker signal meant every section raced
  // whatever was still arriving - which showed up as section 8b reading a box that had
  // not been fitted yet and reporting the planes at their bounds, a finding about the
  // check rather than about the build.
  await waitFor('globalThis.__kinect.takeOpened()', 'the take opened but never finished opening');
  // Gated on a mutation having been asked for rather than on a body this file recognised,
  // which is the other half of the same hole: a guard whose condition is the same file
  // name the route was selected by cannot fire for the file that selected no route.
  if (MUTATE && mutant.served() === 0) {
    throw new Error(`${MUTATE} was staged for ${mutation.file} at ${mutant.path} and the page never `
      + "requested it, so every row below would have measured the tree's own build");
  }
  return { page, errors, close: () => browser.close() };
}

// ------------------------------------------------------------------- the run

let page;
let errors;
let close = async () => {};

try {
  const opened = await openEditor();
  ({ page, errors, close } = opened);
} catch (err) {
  console.log(`[editor] DID NOT RUN - ${err.message}`);
  process.exit(2);
}

/**
 * How much footage this file's own rows need under them, and the refusal when the take
 * handed to `--take` does not hold it.
 *
 * **This is a precondition on the fixture, not a claim about the build, and the direction
 * is the whole point.** A take shorter than the moments these rows reach does not make
 * them fail honestly - the transport clamps the seek into the clip, every row downstream
 * reads a playhead somewhere it did not ask for, and the run comes back with red rows
 * that name real features and mean nothing. Measured on exactly that: against the 9.42s
 * `sample` this tree ships, ten rows redden, and pointing the same build at a 75.6s
 * fixture takes seven of them green with no code changed. Four more sit in
 * `keyframe-check` for the same reason, and two of *its* rows pass against a drag that
 * never happened - which is the worse half, because a fixture gap that reddens a row gets
 * investigated and one that greens it does not. So the run declines rather than asserts,
 * the way it already declines a mutation that was staged and never served: a red row on a
 * suite reads as a catch, and a fixture that cannot hold the gesture is not a catch.
 *
 * The number is **checked rather than trusted**, which is what stops it becoming a second
 * spelling of the rows that drifts away from them. The scan below reads this file's own
 * literal seek targets - the same text the run executes - and refuses if any of them is
 * deeper than what is declared here, so a row added later that seeks to 45s cannot
 * quietly reintroduce the clamp. It cannot see a seek computed from a variable, and that
 * is why the declared number is a little above the deepest literal rather than equal to
 * it. The control for the whole mechanism is to run with `--take sample`: it must exit 2
 * naming the shortfall, where before it ran to the end and reported ten failures.
 */
const NEEDS_TAKE_SEC = 32;
const ownSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
const literalSeeks = [...ownSource.matchAll(/\.seek\(\s*(\d+(?:\.\d+)?)\s*\)/g)].map((m) => Number(m[1]));
const deepestSeek = Math.max(...literalSeeks);
if (deepestSeek > NEEDS_TAKE_SEC) {
  console.log(`[editor] DID NOT RUN - a row seeks to ${deepestSeek}s while NEEDS_TAKE_SEC is ${NEEDS_TAKE_SEC}`
    + ' - raise it and point --take at a fixture that holds it, or the clamp will redden rows about the build');
  await close();
  process.exit(2);
}
const takeSec = await page.evaluate('__kinect.timeline.transport().duration');
if (!(takeSec >= NEEDS_TAKE_SEC)) {
  console.log(`[editor] DID NOT RUN - the take "${TAKE}" holds ${takeSec.toFixed(2)}s and these rows reach `
    + `${deepestSeek}s, so ${NEEDS_TAKE_SEC}s is the shortest take they can be asked about. `
    + 'Every seek past the end clamps, and the rows downstream would redden about the fixture rather than '
    + 'about the build. Point --take at a longer capture (tools/make-fixture.js loops a short one).');
  await close();
  process.exit(2);
}

const settle = () => page.evaluate('__kinect.timeline.settled()');
const read = () => page.evaluate('__kinect.timeline.read()');
const range = () => page.evaluate('__kinect.editor.clipRange()');
const lanes = () => page.evaluate('__kinect.keyframes.lanes()');
const keyCount = async (owner) => ((await lanes()).find((l) => l.owner === owner)?.keys ?? 0);
const text = (sel) => page.locator(sel).textContent();
/** Focus somewhere with no claim on the keyboard, so the window handler gets the key. */
// Takes the focus off whatever has it, which is what the name claimed and what the
// eight call sites below were relying on - and it did none of it. Neither `#stage` nor
// `<body>` carries a tabindex, so `focus()` on either is a no-op and the focus stayed
// exactly where the previous gesture left it. It never showed because every earlier
// caller followed an `el.blur()` of its own, until section 4 grew a block that begins a
// gesture on `#tRate` the way a keyboard user does: an `INPUT` still focused two
// sections later means the window handler's typing guard skips every key press, and
// section 5's Delete row went red as a missing feature on a build that deletes keys
// perfectly well. `blur()` is the call that moves focus, so it is the one here.
const focusStage = () => page.evaluate(`(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  document.getElementById('stage')?.focus?.();
})()`);

try {
  await settle();

  // =====================================================================
  console.log('\n[1] every control the editor renders is one this file knows how to drive');
  // =====================================================================
  //
  // The sweep is over what the page actually contains rather than over a list kept
  // here, which is the only version of this that survives somebody adding a button.
  //
  // **One mark first, because a mark tick is a control that exists only when the take
  // has a mark.** The fixture take carries none, so a sweep taken as the page loads
  // finds no tick, and "no instance of this class" and "this class is not swept" are
  // the same reading - which is exactly how a rule written for the ticks sat here
  // matching nothing. Planting one makes the class observable, and it is the same
  // door sections 4, 10 and 13 already use: `setMarks` writes no sidecar, so this
  // does not edit the take it measures.
  await page.evaluate("__kinect.editor.setMarks([{ id: 'sweep', sourceMs: 2000, label: 'sweep' }])");
  const sweep = await page.evaluate(`(${((rules) => {
    // Anchors are in the list because the way out of this surface is two of them.
    // They were buttons calling `location.href` until the nav moved into the panel
    // head, and a selector naming only the form controls would have watched them
    // leave the sweep rather than fail - the "passes by disappearing" shape this
    // file's own section 1 exists to refuse.
    // `.tlanes` is in the list because the ruler's mark ticks are buttons and live
    // there. A selector naming only the strip and the panel swept neither of them, so
    // the rule written for them matched nothing and the sweep went on reporting every
    // control covered - a control the page renders, pressable, and outside the
    // enumeration entirely. That is the same "passes by disappearing" shape the
    // anchors above are in the list for, arriving through the container instead of
    // through the element name.
    //
    // Dialogs are in the list by element rather than by id, which is the difference
    // between covering the one this editor has and covering the ones it grows. A modal
    // is in neither `.tbar` nor `#panel` - it is a child of the body - so a selector
    // naming only those two watches every control inside one escape the sweep while
    // reporting a clean row, which is the deliberate-exclusion shape `docs/instruments.md`
    // records costing three separate holes. Two containers arriving from two directions
    // at once is the argument for the shape rather than against it: the enumeration is
    // one place, so a surface added outside it is a row that goes missing here.
    // `[role=option]` is in the list because the preset picker's entries are `<div>`s -
    // a native `<option>` cannot hold the mark and the delete the design draws, so the
    // control that replaced the `<select>` renders elements this selector had no reason
    // to name. A pressable control the page renders and the sweep cannot see is the
    // sweep claiming a coverage it never had, which `docs/instruments.md` records
    // costing a rule that matched nothing and said nothing.
    const els = [...document.querySelectorAll('.appbar input, .appbar select, .appbar button, .appbar a, '
      + '.tbar input, .tbar select, .tbar button, .tbar a, '
      + '#panel input, #panel select, #panel button, #panel a, #panel [role=option], '
      + '.tlanes input, .tlanes select, .tlanes button, .tlanes a, '
      + 'dialog input, dialog select, dialog button, dialog a')];
    return els.map((el) => ({
      id: el.id || null,
      tag: el.tagName,
      type: el.type || null,
      ease: el.dataset ? el.dataset.ease ?? null : null,
      // Serialised for the same reason `ease` above is: attribution happens out here
      // on these fields alone, so a rule that wanted to recognise a group toggle by
      // its class or by a `closest()` would have nothing to recognise it with. The
      // group key rather than a boolean, so the row below can say which group had no
      // driver instead of saying that one of them did not.
      groupToggle: el.dataset ? el.dataset.groupToggle || null : null,
      // The parameter a reset puts back, serialised for the same reason the group key
      // above is - and `||` rather than `??`, because the DOM answers an absent dataset
      // key with the empty string, so `??` keeps it and every reset would be credited
      // under the name of every other one.
      reset: el.dataset ? el.dataset.reset || null : null,
      inTbar: Boolean(el.closest('.tbar')),
      // `.appmenu` is a class where the rest are ids, and it is here because the
      // `appbar` rule below needs to tell a menu from a button that merely shares the
      // nav row with one. There is no id to ask that question with - the bar draws one
      // wrapper per menu - so the container is the class, and a rule that could only
      // name ids had to fall back to "anywhere in the row", which is exactly how it came
      // to cover a control nothing drives.
      // `#projectDialog` is here because the shape and the rate moved onto the document
      // and out of the deliverable, taking their two controls into a third modal. A
      // container this list does not name gives every control inside it an empty
      // `groups`, so nothing in the rule table can match one and they arrive as unknown -
      // which is the honest direction, and is how the two the split created were noticed.
      groups: ['#appBar', '#panel', '#panelTabs', '#lookPresetGroup', '#cameraGroup', '#navRow',
        '#recordGroup', '#recLookGroup', '#sensorGroup', '#monitorGroup',
        '#programOutGroup', '#presetPick', '#projectDialog', '#exportDialog', '#obsDialog',
        '#panelDock', '.appmenu']
        .filter((g) => el.closest(g)),
      kf: el.classList.contains('kf'),
      mark: el.classList.contains('tmk'),
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
    }));
  }).toString()})()`);

  const covered = (row) => {
    if (row.id && DRIVER_IDS[row.id]) return `named: ${DRIVER_IDS[row.id]}`;
    if (row.ease) return 'rule: an ease preset, section 5 presses all five on every easable kind';
    return DRIVER_RULES.find((rule) => rule.match(row))?.by ?? null;
  };

  // **A rule that matches nothing on the page it is written for.** The mark rule
  // arrived like that and nothing said so: `covered()` never consulted it, the ticks
  // were outside the selector, and the entry read as coverage while enforcing none.
  // A rule is a claim that a class of control exists and is driven, so a rule with no
  // instance is either a control that has been removed - in which case delete the rule
  // and the section it names - or a sweep that cannot see it, which is the case this
  // row was written by. Asked of every key rather than of the one that broke, because
  // the next rule added is asked by existing.
  const barren = DRIVER_RULES.filter((rule) => !sweep.some((row) => rule.match(row)));
  check(barren.length === 0,
    'every rule in the driver table matches a control the page actually renders, so a rule cannot claim coverage it never reaches',
    barren.length ? `${barren.length} matching nothing: ${barren.map((r) => r.key).join(', ')}`
      : DRIVER_RULES.map((r) => `${r.key} ${sweep.filter((row) => r.match(row)).length}`).join(', '));

  const unknown = sweep.filter((row) => !covered(row));
  // Counted in three places rather than two, because the third arrived and the line
  // went on saying "in the panel" about sixty-odd controls in a modal - a diagnostic
  // that names the wrong surface is how a reader stops being able to tell a sweep that
  // grew from one that moved.
  const DIALOG_GROUPS = ['#presetPick', '#exportDialog', '#obsDialog'];
  const inDialog = sweep.filter((r) => DIALOG_GROUPS.some((group) => r.groups.includes(group))).length;
  const inTbar = sweep.filter((r) => r.inTbar).length;
  note(`${sweep.length} interactive controls on the editor`,
    `${inTbar} in the strip, ${sweep.length - inTbar - inDialog} in the panel, ${inDialog} in a dialog`);
  for (const row of unknown) {
    note('  no driver for', `${row.tag}${row.id ? `#${row.id}` : ''} "${row.label}"`);
  }
  check(unknown.length === 0,
    'every control the page renders is covered by a driver or a stated rule',
    unknown.length ? `${unknown.length} uncovered: ${unknown.map((r) => r.id || r.label).join(', ')}` : `${sweep.length} controls`);
  // The rule half of the claim, so a build that removed every panel control could not
  // satisfy the row above by having nothing left to cover.
  //
  // **Counted over the panel rather than over the sweep, which is a repair the subset
  // dialog forced.** The floor was `sweep.length > 60` while everything swept was the
  // strip or the panel; the dialog put 68 more controls in reach of the same selector,
  // and 68 clears 60 on its own - so a build whose panel had gone entirely would have
  // passed a row whose whole sentence is that the panel was found. The number the claim
  // is about is the panel's, so that is the number the floor reads.
  //
  // Measured at each step rather than at two, because a recorded number that has since
  // moved reads as a baseline and is worse than none: **160 swept and 131 in the panel**
  // before the subset dialog, **228 and the same 131** with it, and **232 and 135** once
  // the panel groups grew a collapse toggle each. The dialog added 68 controls and no
  // panel control; the toggles added four of both, which is why only the second step
  // leaves the panel count alone. What has not moved at any step is the number of *rows*
  // in the panel - 66 throughout - and that is the one to reach for when asking whether a
  // change to this surface dropped a control, because a collapsed group hides its rows
  // with CSS and every one of them is still in the document and still swept here.
  const inPanel = sweep.filter((r) => r.groups.includes('#panel')).length;
  check(inPanel > 60, 'and the sweep found the panel, not an empty page',
    `${inPanel} of ${sweep.length} controls are the panel's`);

  // The other direction, and the panel being generated is what makes it necessary. Every
  // row above asks whether the controls the page renders are driven; none of them can ask
  // whether the controls the page *should* render are there. A generator that filtered one
  // parameter out builds a smaller panel that works perfectly, and the look value it
  // dropped simply has no way to be reached - which is the same class of hole as the
  // in/out markers this file was written for, arriving through a different door.
  //
  // The expectation is recomputed here from the registry rather than read back from
  // anything the page says about itself, because the failure being guarded against is a
  // build whose own arithmetic is what went wrong. `main.js` throws at boot on this too,
  // and that refusal is for whoever is looking at a blank panel; this row is the evidence.
  const owned = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    return k.params.names().filter((n) => k.params.spec(n).tag !== 'composition');
  })()`);
  const swept = new Set(sweep.map((row) => row.id).filter(Boolean));
  const absent = owned.filter((name) => !swept.has(name));
  check(absent.length === 0,
    `every parameter the registry declares has a control on the panel (${owned.length})`,
    absent.length ? `no control for ${absent.join(', ')}` : `${owned.length} of ${owned.length}`);

  // And the composition half, which is the same claim from the other side: a camera path
  // is edited in the world, so a slider named after it means the look/composition split
  // has been crossed. The registry refuses it at boot; this asks the rendered page.
  const composition = await page.evaluate("globalThis.__kinect.params.names('composition')");
  const withControls = composition.filter((name) => swept.has(name));
  check(composition.length > 0 && withControls.length === 0,
    'and no composition parameter has one, because composition is edited in the world',
    withControls.length ? `${withControls.join(', ')} has a control` : `${composition.length} checked: ${composition.join(', ')}`);
  check(sweep.some((r) => r.id === 'tPlay') && sweep.some((r) => r.id === 'tSetIn'),
    'the strip is among what was swept', `${sweep.filter((r) => r.inTbar).map((r) => r.id).filter(Boolean).slice(0, 6).join(', ')}...`);

  // Being in the document is not the same as being reachable, which is the whole of
  // what was wrong with this control before it moved. It sat under thirteen groups of
  // sliders at the foot of a column that scrolls, so on any window the panel filled it
  // was off screen until somebody scrolled for it - swept by this file, covered by a
  // rule, and invisible to the person using the editor.
  //
  // **Measured at both ends of the travel, because one end is a dead zone.** The first
  // version of this scrolled the column to its end and asked whether the nav was inside
  // the panel, which is precisely where a nav at the foot of the column *is* inside the
  // panel - `nav-at-the-foot` came back 683px down and comfortably visible, and the row
  // only reddened on the structural half of its condition. The end a foot-nav fails is
  // the top, where the panel sits when you arrive. So both are read.
  // Stand on the longest inspector. Camera is deliberately short, so moving the bar
  // to its foot there can leave it visible and put the falsification control in a
  // dead zone. Look has enough declared groups for both ends of the scroll to differ.
  await page.locator('.paneltab[data-panel-tab="look"]').click();
  // **And the inspector is opened before it is measured, because a collapsed one does
  // not scroll.** Every group derives shut on a document nobody has touched, which is
  // the panel's own rule and not a state to work around - but it leaves `panelBody`
  // shorter than its box, `scrollHeight - clientHeight` at zero, and the two rows below
  // reading a bar that is trivially on screen at both ends of a travel that does not
  // exist. So the groups this tab holds are opened first, which is the state a person
  // is in when the reachability of the bar is a question at all, and the store they
  // wrote is cleared afterwards so the sections downstream still boot into a document
  // that has been touched by nothing.
  const openedForTravel = await page.evaluate(`(() => {
    const shut = [...document.querySelectorAll('#panelBody > [data-panel-tab] .grouptoggle')]
      .filter((b) => b.getAttribute('aria-expanded') === 'false' && b.checkVisibility());
    shut.forEach((b) => b.click());
    return shut.length;
  })()`);
  const nav = await page.evaluate(`(${(() => {
    const el = document.getElementById('appBar');
    const body = document.getElementById('panelBody');
    if (!el || !body) return { present: false, hasBody: !!body };
    const was = body.scrollTop;
    const at = (to) => {
      body.scrollTop = to;
      const r = el.getBoundingClientRect();
      return {
        scrolled: Math.round(body.scrollTop),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        inside: r.top >= -0.5 && r.bottom <= innerHeight + 0.5,
      };
    };
    const travel = body.scrollHeight - body.clientHeight;
    const top = at(0);
    const end = at(body.scrollHeight);
    body.scrollTop = was;
    return {
      present: true,
      hasBody: true,
      travel: Math.round(travel),
      inBody: !!el.closest('#panelBody'),
      top,
      end,
      height: Math.round(el.getBoundingClientRect().height),
      surface: document.getElementById('surfaceName')?.textContent?.trim(),
      hrefs: ['toMenu', 'toLibrary'].map((id) => document.getElementById(id)?.getAttribute('href') ?? null),
    };
  }).toString()})()`);

  check(nav.present, 'the editor has one application bar carrying its navigation and commands',
    nav.present ? `${nav.height}px high, surface ${nav.surface}` : `appBar/panelBody present: ${nav.hasBody}`);
  check(nav.travel > 0, 'and the panel body genuinely scrolls, so the rows below are measuring something',
    `${nav.travel}px of travel with the tab's ${openedForTravel} groups opened`);
  check(nav.present && nav.top.inside && nav.end.inside && nav.top.top === 0 && nav.end.top === 0,
    'the application bar stays on screen at both ends of the inspector travel',
    nav.present ? `top ${nav.top.top}px at rest, ${nav.end.top}px at the end` : 'absent');
  check(nav.present && !nav.inBody,
    'and it is outside the scrolling inspector rather than merely near its top',
    `in the scrolling body: ${nav.inBody}`);
  check(nav.present && nav.surface === 'Editor' && nav.hrefs.join(' ') === '/ /gallery',
    'and it names the surface while both exits remain real URLs in the markup',
    `${nav.surface}: ${nav.hrefs.join(' ')}`);
  // The overrides those presses wrote, taken back off the page and out of storage. A
  // group pinned open here is a disagreement section 16 would find already sitting in
  // the store it is about to make claims about.
  await page.evaluate(`(() => {
    [...document.querySelectorAll('#panelBody > [data-panel-tab] .grouptoggle')]
      .filter((b) => b.getAttribute('aria-expanded') === 'true' && b.checkVisibility())
      .forEach((b) => b.click());
    localStorage.removeItem('kinect.panelGroupsOpen');
  })()`);

  // The tabs are an outer visibility layer over one registry-built panel. Each group
  // remains in the document, and pressing a tab must leave only the groups declared
  // for that view on screen. One row per tab makes `panel-tabs-show-everything`
  // discriminate at every state instead of passing on whichever tab happens to own
  // most of the panel.
  for (const tab of ['camera', 'framing', 'look', 'region']) {
    await page.locator(`.paneltab[data-panel-tab="${tab}"]`).click();
    const state = await page.evaluate(`(${((name) => {
      const groups = [...document.querySelectorAll('#panelBody > [data-panel-tab]')];
      const visible = groups.filter((group) => group.getClientRects().length > 0);
      return {
        active: document.querySelector('.paneltab[aria-selected="true"]')?.dataset.panelTab ?? null,
        visible: visible.map((group) => group.dataset.group || group.id),
        wrong: visible.filter((group) => group.dataset.panelTab !== name)
          .map((group) => group.dataset.group || group.id),
        total: groups.length,
      };
    }).toString()})(${JSON.stringify(tab)})`);
    check(state.active === tab && state.visible.length > 0 && state.wrong.length === 0,
      `the ${tab} inspector shows only the groups declared for it`,
      `${state.visible.join(', ')}; wrong: ${state.wrong.join(', ') || 'none'}; ${state.total} groups remain in the document`);
  }
  await page.locator('.paneltab[data-panel-tab="camera"]').click();

  await page.locator('#fileMenuButton').click();
  const fileMenu = await page.evaluate(`(() => ({
    open: !document.getElementById('fileMenu').hidden,
    items: [...document.querySelectorAll('#fileMenu [role=menuitem]')].map((el) => el.textContent.trim()),
  }))()`);
  // Three, since the shape and the rate became the edit's rather than a deliverable's and
  // needed a door. Counted rather than listed, and the count is the assertion: this row
  // went red on the commit that added Project settings, which is the number doing its job
  // - a menu that grows an entry nobody decided to add is a surface drifting from its
  // design, and that is what a literal here catches that a `>= 2` would not.
  check(fileMenu.open && fileMenu.items.length === 3,
    'File opens from the fixed bar and offers the three designed commands', fileMenu.items.join(' | '));
  let savePrompt = '';
  page.once('dialog', async (dialog) => { savePrompt = dialog.message(); await dialog.dismiss(); });
  await page.locator('#menuSaveProject').click();
  await new Promise((r) => setTimeout(r, 100));
  check(savePrompt.startsWith('save this edit as'), 'Save as reaches the existing project writer', savePrompt || 'no prompt');

  // `Output > Export`, which is the whole of that menu's editing half now. It was two
  // commands - `Render` opened this dialog and `Export` jumped past it into the save when
  // there was a file to hand over - and one menu item doing two unrelated things according
  // to state the menu did not show is what the merge removed. There is no `#menuRender` to
  // click any more, and clicking the one that is left has to reach the dialog directly.
  await page.locator('#outputMenuButton').click();
  await page.locator('#menuExport').click();
  const exportDialog = await page.evaluate(`(() => ({
    open: document.getElementById('exportDialog').open,
    // The resolutions this dialog offers, where the ratio segments used to be read. The
    // segments moved to Project settings with the shape itself, and what is left here is
    // the pixel count - so this reads the menu that is now the deliverable's own choice,
    // and the row below asserts every entry in it is the shape the stage is letterboxed
    // to. That is the claim the split rests on: a resolution is not a reframe.
    resolutions: [...(document.getElementById('tExportSize')?.options ?? [])].map((o) => o.value),
    chosenSize: document.getElementById('tExportSize')?.value ?? '',
    aspect: globalThis.__kinect.outputSize().aspect,
    // The format segments, read as a set rather than by id. This row used to name
    // exportFormatMov and exportFormatPng and assert both were disabled, which encoded
    // a claim that has since stopped being true - the server grew prores and an image
    // sequence, so a row pinning them as unavailable would have been holding the dialog
    // to a limitation nobody has any more. Worse, it read disabled off the result of
    // getElementById without a guard, so when the segments were rebuilt around a codec
    // attribute the two ids went and the read threw: 17 assertions ran, 0 failed, exit 2,
    // for every mutation of every section. That is the crash wearing the shape of a catch
    // this repo has three entries about, and while it lasted no mutation in this file
    // could be reported as missed, because the count it is missed by was never zero.
    // Enumerated off the attribute so a fourth format is asked by existing.
    // No backticks in this comment on purpose - it lives inside a template literal, and
    // one here ends the literal. That is the fifth time in this repo.
    formats: [...document.querySelectorAll('#exportFormats button[data-codec]')].map((button) => ({
      codec: button.dataset.codec, disabled: button.disabled,
      pressed: button.getAttribute('aria-pressed') === 'true',
    })),
  }))()`);
  // **One claim per row, because the five that were folded together could not say which
  // of them had gone.** The conjunction here was `open && a ratio selected && formats
  // offered && none disabled && exactly one pressed && no stranger codecs`, which is red
  // for any of six reasons and names none of them - the shape `docs/instruments.md` calls
  // out where a conjunct has to be able to fail while its neighbours hold.
  //
  // **And the codec table is asked of the function that enforces it, not of its source.**
  // The previous spelling sliced `const CODECS = {` out of `server/export.js` and read the
  // keys back with a regex, which is a guess at a table wearing the shape of a reading -
  // the same mistake this repo spent nine rounds on when it tried to answer "is this
  // number written here" with a pattern. `validateExport` is exported precisely so that
  // the socket's `begin` and the job queue share one answer, so a third caller inherits
  // the rule by calling it. It also asks a stronger question than key membership: an
  // entry demanding even dimensions refuses an odd frame here rather than inside ffmpeg.
  //
  // The containment is deliberately one-way and the note says so. `lossless` is declared
  // by the server and not offered by the dialog, which is a choice about what an operator
  // is shown rather than drift, so a row demanding the two sets be equal would be red
  // over a build that is correct.
  const offered = exportDialog.formats.map((format) => format.codec);
  const codecRefused = offered.map((codec) => {
    try {
      validateExport({ name: 'editor-check-codec', width: 1920, height: 1080, fps: 30, codec });
      return null;
    } catch (err) {
      return `${codec || '(unnamed)'}: ${err.message}`;
    }
  }).filter(Boolean);
  // **The resolution menu is every size of the project's shape, and only those.** Read as
  // two claims rather than one, because they fail for different reasons and the fix is
  // different: a menu that is empty is a shape the table has nothing for, and a menu
  // holding a size of another shape is the reframe-through-a-deliverable this split
  // exists to make impossible - `exportClip` refuses that pair at the press, so an option
  // offering it is a control that leads to a refusal.
  const offShape = exportDialog.resolutions.filter((value) => {
    const [w, h] = value.split('x').map(Number);
    if (!(w > 0 && h > 0)) return true;
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const d = gcd(w, h);
    return w / d !== exportDialog.aspect[0] || h / d !== exportDialog.aspect[1];
  });
  check(exportDialog.open && exportDialog.resolutions.length > 0,
    'Export opens the designed dialog with a resolution menu built from the authoritative size table',
    `${exportDialog.resolutions.length} sizes: ${exportDialog.resolutions.join(', ') || 'none'}`);
  check(offShape.length === 0,
    `  and every size it offers is the ${exportDialog.aspect.join(':')} the stage is framed at, so choosing one cannot reframe the clip`,
    offShape.length ? `off-shape: ${offShape.join(', ')}` : `all of ${exportDialog.resolutions.join(', ')}`);
  check(exportDialog.resolutions.includes(exportDialog.chosenSize),
    '  and the size it shows as chosen is one of them, rather than a value the menu cannot display',
    `chosen ${JSON.stringify(exportDialog.chosenSize)} of ${exportDialog.resolutions.join(', ')}`);
  check(offered.length >= 2 && exportDialog.formats.every((format) => !format.disabled),
    'and it offers a format per codec with every one of them enabled, rather than showing a refusal the encoder no longer makes',
    exportDialog.formats.map((f) => `${f.codec}${f.disabled ? ' DISABLED' : ''}`).join(', ') || 'no format segments');
  check(offered.length > 0 && codecRefused.length === 0,
    "and every codec it offers is one the server's own validator accepts, so the dialog cannot drift from the encoder",
    codecRefused.length ? codecRefused.join('; ') : `${offered.join(', ')} all pass validateExport`);
  check(exportDialog.formats.filter((format) => format.pressed).length === 1,
    'and exactly one of them shows as chosen, because a format is a choice among them rather than a set of them',
    `pressed ${exportDialog.formats.filter((f) => f.pressed).map((f) => f.codec).join(', ') || 'none'}`);

  // **Pressed rather than looked at.** Every row above is about what the dialog contains,
  // and this whole file exists because the suite once tested the model and never the
  // control - three segments that are present, enabled and correctly painted are three
  // segments a build could render while wiring none of them. The codec pressed is the one
  // that is not already chosen, so a build that painted the press and wrote nothing fails
  // on the document rather than passing on the paint.
  const liveDeliverable = await page.evaluate('({ ...__kinect.library.activeDeliverable() })');
  // Guarded rather than indexed into, because the rows above are what say this exists and
  // a `undefined.codec` here would be a TypeError inside section 1 - which is exactly how
  // this block's predecessor took the whole tool down at 17 assertions with none failed.
  // A dialog with no unchosen segment is a failed row naming what it found.
  const other = exportDialog.formats.find((format) => !format.pressed);
  if (!other) {
    check(false, 'pressing a format writes it into the deliverable the render reads, and shows itself as the one chosen',
      `no unchosen segment to press: ${exportDialog.formats.map((f) => `${f.codec}=${f.pressed}`).join(', ') || 'no segments'}`);
  } else {
    await page.locator(`#exportFormats button[data-codec="${other.codec}"]`).click();
    const afterPress = await page.evaluate(`(() => ({
      pressed: [...document.querySelectorAll('#exportFormats button[data-codec]')]
        .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.codec),
      codec: globalThis.__kinect.library.activeDeliverable()?.codec ?? null,
    }))()`);
    check(afterPress.codec === other.codec && afterPress.pressed.join(',') === other.codec,
      'pressing a format writes it into the deliverable the render reads, and shows itself as the one chosen',
      `pressed ${other.codec}: the document reads ${afterPress.codec}, the dialog shows ${afterPress.pressed.join(',') || 'none'}`);

    // **Every segment, not the one that happened to be unchosen.** The row above proves a
    // press is wired; it presses exactly one, so two of the three formats the dialog offers
    // could be wired to nothing and it would still be green. This walks all of them and
    // asks each to write *its own* codec, which is the claim the row above makes about one.
    //
    // It needs no page hook, and the reason is worth stating because it is what makes the
    // row cheap: `setExportCodec` refuses a codec `EXPORT_CODECS` does not carry, by
    // throwing. So a table that has gone stale against the markup does not paint a wrong
    // format - the press raises, `pageerror` records it, and the codec never moves. The
    // discriminator is the codec the document reads back, and the throw is what guarantees
    // a missing entry cannot quietly succeed. `export-codecs-drops-an-entry` is the control.
    const drift = [];
    for (const format of exportDialog.formats) {
      await page.locator(`#exportFormats button[data-codec="${format.codec}"]`).click();
      const got = await page.evaluate(`(() => ({
        codec: globalThis.__kinect.library.activeDeliverable()?.codec ?? null,
        pressed: [...document.querySelectorAll('#exportFormats button[data-codec]')]
          .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.codec).join(','),
      }))()`);
      drift.push({ asked: format.codec, ...got });
    }
    const wrong = drift.filter((d) => d.codec !== d.asked || d.pressed !== d.asked);
    check(drift.length >= 2 && wrong.length === 0,
      'and every format the dialog offers writes its own codec when pressed, so a segment cannot be markup with nothing behind it',
      wrong.length
        ? wrong.map((d) => `${d.asked} -> document ${d.codec}, shown ${d.pressed || 'none'}`).join('; ')
        : drift.map((d) => `${d.asked} -> ${d.codec}`).join(', '));

  // **The other door, and it is the same argument the panel's row resets rest on.** The
  // deliverable is reached by a project file, by the autosave and by the deliverable
  // picker as well as by these three buttons - `paintExportFormats` says so in its own
  // docstring - so a control painted from its own clicks is right for the clicks and
  // silently wrong for every other way the document moves. The document is changed here
  // with no segment pressed, and the segments have to follow it.
  //
  // The planted deliverable differs from the live one in its codec and in nothing else,
  // on purpose: adopting one runs `setClipInOut`, and a trim arriving here would move the
  // playhead under section 8's crop rows seven sections later. This file already carries
  // two scars from a probe in section 1 changing what a later section measured.
    const codecDoor = `ec${process.pid}-codec`;
    const doorCodec = offered.find((codec) => codec !== afterPress.codec);
    const doorBody = JSON.stringify({ ...liveDeliverable, name: codecDoor, codec: doorCodec });
    await page.evaluate(`(async () => {
      const res = await fetch('/deliverables/' + encodeURIComponent(${JSON.stringify(codecDoor)}), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: ${JSON.stringify(doorBody)},
      });
      return res.ok;
    })()`);
    await page.evaluate(`(() => {
      const el = document.getElementById('tDeliverable');
      if (![...el.options].some((o) => o.value === ${JSON.stringify(codecDoor)})) {
        el.append(new Option(${JSON.stringify(codecDoor)}, ${JSON.stringify(codecDoor)}));
      }
      el.value = ${JSON.stringify(codecDoor)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterDoor = await page.evaluate(`(() => ({
      pressed: [...document.querySelectorAll('#exportFormats button[data-codec]')]
        .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.codec),
      codec: globalThis.__kinect.library.activeDeliverable()?.codec ?? null,
      name: globalThis.__kinect.library.activeDeliverable()?.name ?? null,
    }))()`);
    check(afterDoor.codec === doorCodec && afterDoor.name === codecDoor,
      'a stored deliverable naming another codec really was adopted, or the row below tests nothing',
      `the document reads ${afterDoor.codec} under the name ${afterDoor.name}`);
    check(afterDoor.pressed.join(',') === doorCodec,
      'and the format segments follow the document rather than the press that last touched them',
      `the document reads ${afterDoor.codec}, the dialog shows ${afterDoor.pressed.join(',') || 'none'}`);

    // Put the deliverable back as this block found it and take the planted document off
    // the server, because every section from 3 onward reads the live one. The repaint goes
    // through whichever segment carries the live codec if there is one - `lossless` is a
    // codec the server encodes and the dialog does not offer, so a deliverable holding it
    // would otherwise leave this line waiting thirty seconds for a button that does not
    // exist, which is a crash where a restore was meant.
    await page.evaluate(`(() => {
      globalThis.__kinect.library.setActiveDeliverable(${JSON.stringify(liveDeliverable)});
      const el = document.getElementById('tDeliverable');
      const planted = [...el.options].find((o) => o.value === ${JSON.stringify(codecDoor)});
      if (planted) planted.remove();
      el.value = '';
      const segment = document.querySelector('#exportFormats button[data-codec=' + CSS.escape(${JSON.stringify(liveDeliverable.codec ?? '')}) + ']');
      if (segment) segment.click();
    })()`);
    const codecCleanup = await page.evaluate(`(async () => {
      const res = await fetch('/deliverables/' + encodeURIComponent(${JSON.stringify(codecDoor)}), {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      });
      return res.ok;
    })()`);
    check(codecCleanup, 'and the deliverable this block planted was removed again',
      codecCleanup ? `${codecDoor} deleted` : `DELETE refused for ${codecDoor}`);
  }
  // **The output name, round-tripped through a document rather than read off the field it
  // was typed into.** Typing a name and reading it straight back proves only that an input
  // holds text. What the deliverable claims is that the name *travels with it* - that is
  // the whole reason the field exists on the document - so the only assertion worth making
  // walks it out to the server and back through an adoption.
  //
  // It shipped broken in exactly the gap a field-only row would have missed: the name was
  // read out of a document on adoption and never written into one, so a saved deliverable
  // carried the empty string and every deliverable of one take proposed the same filename.
  // `export-name-not-taken` is the control.
  //
  // Restored to what it found afterwards, because section 7 renders with this field and a
  // name left here would name that file.
  const nameBefore = await page.evaluate('document.getElementById("tExportName").value');
  const nameDoc = `ec${process.pid}-name`;
  const nameTrip = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const el = document.getElementById('tExportName');
    el.value = 'round-trip-probe';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const inDocument = k.library.activeDeliverable()?.name ?? null;
    const put = await fetch('/deliverables/' + encodeURIComponent(${JSON.stringify(nameDoc)}), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(k.library.activeDeliverable()),
    });
    if (!put.ok) return { failed: 'PUT ' + put.status };
    const stored = (await (await fetch('/deliverables/' + encodeURIComponent(${JSON.stringify(nameDoc)}))).json()).body?.name ?? null;
    // Typed over before the adoption, so what comes back cannot be what is already there.
    el.value = 'a-different-name';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const sel = document.getElementById('tDeliverable');
    if (![...sel.options].some((o) => o.value === ${JSON.stringify(nameDoc)})) {
      sel.append(new Option(${JSON.stringify(nameDoc)}, ${JSON.stringify(nameDoc)}));
    }
    sel.value = ${JSON.stringify(nameDoc)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return { inDocument, stored, afterAdoption: el.value };
  })()`);
  check(nameTrip.inDocument === 'round-trip-probe',
    'the name typed for the output reaches the deliverable that is supposed to remember it',
    nameTrip.failed ?? `the document reads ${JSON.stringify(nameTrip.inDocument)}`);
  check(nameTrip.stored === 'round-trip-probe',
    '  and the deliverable written to the server carries it, rather than the empty one it was seeded with',
    `stored ${JSON.stringify(nameTrip.stored)}`);
  check(nameTrip.afterAdoption === 'round-trip-probe',
    '  and adopting that deliverable puts it back, which is what makes two of them name two files',
    `the field reads ${JSON.stringify(nameTrip.afterAdoption)} after adopting over ${JSON.stringify('a-different-name')}`);
  await page.evaluate(`(async () => {
    const el = document.getElementById('tExportName');
    el.value = ${JSON.stringify(nameBefore)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('tDeliverable').value = '';
    // The header is not decoration on a DELETE here - this server answers 415 without it,
    // and a rejected cleanup leaves the document behind and reddens the page-errors row.
    await fetch('/deliverables/' + encodeURIComponent(${JSON.stringify(nameDoc)}), {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    });
  })()`);

  // **The deliverable's `new` button, driven the way Save as is driven.** It came into
  // this dialog with the picker and was credited to `library-check`, which has never
  // referenced it - so nothing pressed it, and the `shelldialogs` rule's claim to drive
  // every enabled control in this dialog was false for one of them.
  //
  // Dismissed rather than accepted, and that is the whole assertion rather than a
  // shortcut: what this control does first is ask for a name, so a build that had lost
  // the handler opens no prompt and this row is red. Accepting would write a document to
  // the server in the middle of section 1 and leave the picker on it, which is the class
  // of side effect two comments in this file already record. Save as is driven exactly
  // this way twenty lines above.
  let newPrompt = null;
  page.once('dialog', async (dialog) => { newPrompt = dialog.message(); await dialog.dismiss(); });
  await page.locator('#tDeliverableNew').click();
  await new Promise((r) => setTimeout(r, 150));
  check(typeof newPrompt === 'string' && /deliverable/i.test(newPrompt),
    'the deliverable\'s new button reaches the writer that names one, rather than being markup in the dialog',
    newPrompt === null ? 'no prompt opened' : `prompt: ${JSON.stringify(newPrompt)}`);

  await page.locator('#exportClose').click();

  // **File > Project settings, which is the third application dialog and the one the
  // shape moved into.** The row this replaces asserted that `Output > Export` opened the
  // same dialog `Render` did before a render existed - a claim about two commands that
  // were two doors onto one thing, and there is one command now, so the row had become
  // the click above repeated. What is worth asserting in its place is the dialog that did
  // not exist: the shape and the rate are the edit's, and the controls that write them
  // have to be reachable and have to work.
  await page.locator('#fileMenuButton').click();
  await page.locator('#menuProjectSettings').click();
  const projectDialog = await page.evaluate(`(() => ({
    open: document.getElementById('projectDialog').open,
    aspects: [...document.querySelectorAll('#projectAspects button')].map((button) => ({
      label: button.textContent, aspect: button.dataset.aspect,
      selected: button.getAttribute('aria-pressed'),
    })),
    // Read off the control rather than off a list written here, for the reason the markup
    // gives for leaving it empty: restoreProject refuses a rate this build does not
    // offer, and a tool spelling the rates out again would be a third statement of a list
    // that is supposed to have one.
    // No backticks in this comment on purpose - it lives inside a template literal, and
    // one here ends the literal. That is the sixth time in this repo, and the fifth is
    // noted twenty lines up in this same section.
    rates: [...(document.getElementById('tFps')?.options ?? [])].map((o) => o.value),
    rate: document.getElementById('tFps')?.value ?? '',
  }))()`);
  check(projectDialog.open && projectDialog.aspects.length >= 5,
    'Project settings opens the designed dialog with a shape per group in the authoritative size table',
    `${projectDialog.aspects.length} shapes: ${projectDialog.aspects.map((a) => a.label).join(', ') || 'none'}`);
  check(projectDialog.aspects.filter((a) => a.selected === 'true').length === 1,
    '  and exactly one of them is lit, because the clip is framed at one shape rather than at a set of them',
    `lit: ${projectDialog.aspects.filter((a) => a.selected === 'true').map((a) => a.label).join(', ') || 'none'}`);
  check(projectDialog.rates.length >= 2 && projectDialog.rates.includes(projectDialog.rate),
    '  and the rate it shows is one the control offers, so the list the document is validated against is the list on screen',
    `${projectDialog.rate} of ${projectDialog.rates.join(', ') || 'none'}`);

  // **Pressed, and put back.** Reading five buttons says nothing about whether any of them
  // is wired - the argument the format segments above are driven for - so one that is not
  // already lit is pressed and the stage is asked whether it followed. It is pressed back
  // immediately afterwards, because the shape is the letterbox: every section from 8
  // onward reads the stage at pointer coordinates, and this file already carries two scars
  // from a probe in section 1 leaving a later section measuring something else.
  //
  // The stage's own aspect is the discriminator rather than the button's `aria-pressed`,
  // which is the press describing itself. A build that lit the button and reframed nothing
  // would pass on the attribute and fail here.
  const stageAspect = () => page.evaluate(`(() => {
    const r = document.getElementById('stage').getBoundingClientRect();
    return r.height > 0 ? r.width / r.height : 0;
  })()`);
  const wasLit = projectDialog.aspects.find((a) => a.selected === 'true');
  const toPress = projectDialog.aspects.find((a) => a.selected !== 'true');
  if (!wasLit || !toPress) {
    check(false, 'pressing a shape reframes the stage and rebuilds the resolution menu under it',
      `nothing to press: lit ${wasLit?.label ?? 'none'}, unlit ${toPress?.label ?? 'none'}`);
  } else {
    const before = await stageAspect();
    // The resolution the deliverable is on before the shape moves, because a shape change
    // has to replace a size it cannot keep and must not lose the one it displaced. Without
    // a memory that replacement is one-way: pick a size, change the shape, come back, and
    // the size the operator chose has become whatever the shape opens on - a per-file
    // setting silently downgraded by an edit that claims to move only the frame. Undo is
    // the sharpest way in, because it advertises that it puts things back.
    // **Moved off the size this shape opens on first, or the row below cannot fail.** The
    // opening size for 16:9 is the table's default, so a round trip that starts there ends
    // there whether the displaced size is remembered or recomputed - the first version of
    // this row read `1920x1080 -> replaced -> 1920x1080` and would have passed against a
    // build with no memory at all. Picking any other size of the same shape is what makes
    // the two answers different.
    const otherSize = await page.evaluate(`(() => {
      const sel = document.getElementById('tExportSize');
      const other = [...sel.options].map((o) => o.value).find((v) => v !== sel.value);
      if (!other) return null;
      sel.value = other;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return other;
    })()`);
    const sizeBefore = await page.evaluate('__kinect.outputSize().size');
    check(otherSize !== null && sizeBefore === otherSize,
      '  and this shape offers a second size to sit on, or the round trip below proves nothing',
      `moved to ${JSON.stringify(otherSize)}, the deliverable reads ${JSON.stringify(sizeBefore)}`);
    await page.locator(`#projectAspects button[data-aspect="${toPress.aspect}"]`).click();
    await settle();
    const pressed = await page.evaluate(`(() => ({
      aspect: globalThis.__kinect.outputSize().aspect.join('x'),
      sizes: [...document.getElementById('tExportSize').options].map((o) => o.value),
    }))()`);
    const after = await stageAspect();
    const wanted = toPress.aspect.split('x').map(Number);
    check(pressed.aspect === toPress.aspect
      && Math.abs(after - wanted[0] / wanted[1]) / (wanted[0] / wanted[1]) < 0.02,
      'pressing a shape writes it into the document and the stage is letterboxed to it',
      `pressed ${toPress.label}: the document reads ${pressed.aspect}, the stage is `
      + `${after.toFixed(4)} where ${(wanted[0] / wanted[1]).toFixed(4)} was asked for `
      + `(it was ${before.toFixed(4)})`);
    check(pressed.sizes.length > 0 && pressed.sizes.join(',') !== exportDialog.resolutions.join(','),
      '  and the resolution menu was rebuilt under it, rather than going on offering the old shape\'s sizes',
      `${pressed.sizes.join(', ') || 'none'} where the old shape offered ${exportDialog.resolutions.join(', ')}`);
    await page.locator(`#projectAspects button[data-aspect="${wasLit.aspect}"]`).click();
    await settle();
    const restored = await stageAspect();
    check(Math.abs(restored - before) < 1e-6,
      '  and pressing the shape it came in on puts the stage back, so no later section reads a frame this block moved',
      `${before.toFixed(6)} -> ${after.toFixed(6)} -> ${restored.toFixed(6)}`);
    const sizeRestored = await page.evaluate('__kinect.outputSize().size');
    const opens = await page.evaluate('__kinect.outputSize().size');
    check(sizeRestored === sizeBefore,
      '  and the resolution that shape was on comes back with it, rather than the one it opens on',
      `${sizeBefore} -> ${pressed.sizes[0]} -> ${sizeRestored}`
      + (sizeRestored === opens && sizeRestored !== sizeBefore ? ' (the opening size, so the displaced one was lost)' : ''));
    // Put the deliverable back on the size this section found it on, for the reason the
    // shape is put back: section 7 renders with it.
    await page.evaluate(`(() => {
      const sel = document.getElementById('tExportSize');
      if (sel.value !== ${JSON.stringify(exportDialog.chosenSize)}) {
        sel.value = ${JSON.stringify(exportDialog.chosenSize)};
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
  }
  // **The rate, driven through the control rather than through the transport.** It was
  // credited in `DRIVER_IDS` to `timeline-check` and `export-check`, and neither of them
  // has ever touched it: both write `transport().outputFps` directly, which is the model
  // this file exists to stop standing in for the control. That credit was true of nothing
  // and would have gone on reading as coverage, so the entry is gone and the dialog rule
  // covers it - which obliges section 1 to drive it, and this is that.
  //
  // Restored to the rate it came in on for the reason the shape above is: `timeline.frame`
  // counts output frames, so a rate left changed here moves the playhead under every
  // section after it.
  const rateBack = projectDialog.rate;
  const rateOther = projectDialog.rates.find((r) => r !== rateBack);
  if (!rateOther) {
    check(false, 'setting the output rate writes it into the transport the playhead is counted in',
      `only one rate offered: ${projectDialog.rates.join(', ') || 'none'}`);
  } else {
    const heldSec = await page.evaluate('__kinect.timeline.transport().programSec');
    await page.selectOption('#tFps', rateOther);
    await settle();
    const moved = await page.evaluate(`(() => ({
      fps: globalThis.__kinect.timeline.transport().outputFps,
      sec: globalThis.__kinect.timeline.transport().programSec,
    }))()`);
    check(moved.fps === Number(rateOther),
      'setting the output rate writes it into the transport the playhead is counted in',
      `asked ${rateOther}, the transport reads ${moved.fps}`);
    // The playhead is held across the change, which is the half a rate control gets wrong.
    // A frame index reinterpreted at a new rate lands somewhere else in the clip - frame
    // 300 is 10s at 30 and 5s at 60 - so the assertion is about the second, not the frame.
    check(Math.abs(moved.sec - heldSec) < 1 / Math.min(...projectDialog.rates.map(Number)),
      '  and the playhead is held in seconds across it, rather than being reinterpreted at the new rate',
      `${heldSec.toFixed(4)}s -> ${moved.sec.toFixed(4)}s across ${rateBack} -> ${rateOther}fps`);
    await page.selectOption('#tFps', rateBack);
    await settle();
    const restoredRate = await page.evaluate('__kinect.timeline.transport().outputFps');
    check(restoredRate === Number(rateBack),
      '  and the rate it came in on goes back, so no later section counts frames at another one',
      `${rateBack} -> ${rateOther} -> ${restoredRate}`);
  }
  // **Both ways out, because the rule claims both.** `shelldialogs` says section 1 drives
  // every enabled control in this dialog, and `done` and the `x` are two controls with one
  // job - so shutting it with only one of them would leave the other claimed by a rule and
  // pressed by nothing, which is the attribution failure three entries in `DRIVER_IDS`
  // were just corrected for. Asked as two rows rather than one because they fail
  // separately: a `done` that does not close is a different build from an `x` that does
  // not.
  await page.locator('#projectDone').click();
  check(await page.evaluate('!document.getElementById("projectDialog").open'),
    '  and done shuts it, rather than being a button that only looks like the way out');
  await page.locator('#fileMenuButton').click();
  await page.locator('#menuProjectSettings').click();
  await page.locator('#projectClose').click();
  check(await page.evaluate('!document.getElementById("projectDialog").open'),
    '  and so does the close corner, so the dialog has two ways out and both of them work');

  // **The two refusals the whole split rests on, and nothing in this suite reached either
  // of them.** `applyDeliverable` throws when a stored size belongs to another shape, and
  // `exportClip` throws when the size a render will actually use does - and every document
  // and every job any tool here builds is internally consistent, so both `if` blocks could
  // be deleted and the suite would stay green. A completeness pass found that, and it is
  // the shape `docs/instruments.md` names: the rows above prove the menu cannot *offer* an
  // off-shape size, which is a different claim from the backstop firing when something
  // arrives past the menu. The job queue is exactly that something.
  //
  // Driven through the hooks rather than through the UI, deliberately and for the reason
  // `restoreProject` is exposed raw: no gesture can build these documents, so a check that
  // could only reach them by clicking could never hand them over at all.
  //
  // The whole block restores the document it found, because everything after section 1
  // reads it.
  const liveProject = await page.evaluate('__kinect.keyframes.project()');
  const liveSize = await page.evaluate('__kinect.outputSize().size');
  const refusals = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const out = {};
    const shape = k.outputSize().aspect.join(':');
    // A deliverable this build *can* read - version 2, everything else valid - whose only
    // fault is a size of another shape. Version 1 would be refused a line earlier by the
    // version gate, which is why the row that queues one cannot reach this.
    const wrongShape = shape === '16:9' ? '1080x1080' : '1920x1080';
    try {
      k.library.applyDeliverable({
        version: 2, in: 0, out: null, outputSize: wrongShape, codec: 'h264', name: '',
      });
      out.deliverable = 'adopted';
    } catch (err) { out.deliverable = err.message; }
    // And the size a render will use, handed over the way a queued job hands it over.
    // exportClip reads width and height ahead of the deliverable's own size, so this is the
    // only door that can be asked this question. No backticks in this comment on purpose -
    // it lives inside a template literal, and one here ends the literal. Eighth time.
    const [w, h] = wrongShape.split('x').map(Number);
    try {
      await k.export.run({ from: 0, to: 0, width: w, height: h, name: 'ec-shape-probe' });
      out.render = 'rendered';
    } catch (err) { out.render = err.message; }
    out.shape = shape;
    out.asked = wrongShape;
    return out;
  })()`);
  check(/framed at/.test(refusals.deliverable) && /not the/.test(refusals.deliverable),
    'a stored deliverable whose size is another shape is refused, which is the reframe a deliverable is not allowed to perform',
    `${refusals.shape} clip, ${refusals.asked} deliverable: ${String(refusals.deliverable).slice(0, 90)}`);
  check(/framed at/.test(refusals.render),
    'and a render handed a size of another shape is refused at the press, which is the backstop the job queue arrives through',
    `${refusals.shape} clip, asked for ${refusals.asked}: ${String(refusals.render).slice(0, 90)}`);

  // **The path every project saved before this branch takes on its next open, and nothing
  // drove it.** A legacy document carries `outputSize` and no `aspect`, so the shape is
  // derived from it and the size is handed to the deliverable in the same breath - which is
  // new logic rather than a refactor, and the completeness pass found it reached by no row
  // at all. Both halves are asked: the shape came out right, and the pixels survived.
  //
  // `1600x900` rather than a size the table lists, because the interesting case is a
  // hand-typed size the menu never offered - that is what a pre-branch document could hold,
  // and keeping its exact pixels is the whole promise of reading the legacy field.
  const legacy = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const doc = JSON.parse(JSON.stringify(${JSON.stringify(liveProject)}));
    delete doc.aspect;
    delete doc.outputFps;
    doc.outputSize = '1600x900';
    try {
      k.library.restoreProject(doc);
      return {
        ok: true, aspect: k.outputSize().aspect.join(':'), size: k.outputSize().size,
        fps: k.timeline.transport().outputFps,
      };
    } catch (err) { return { ok: false, error: err.message }; }
  })()`);
  check(legacy.ok && legacy.aspect === '16:9',
    'a project carrying only the legacy outputSize is framed at the shape that size is',
    legacy.ok ? `1600x900 gives ${legacy.aspect}` : `refused: ${String(legacy.error).slice(0, 80)}`);
  check(legacy.size === '1600x900',
    '  and the pixels it named survive onto the deliverable, so it renders what it rendered before',
    `the deliverable reads ${legacy.size}`);
  check(legacy.fps === 30,
    '  and a document with no rate reads as 30, which is what absent has to mean for every project written before the rate moved',
    `${legacy.fps}fps`);

  // And the other half of the same rule: a legacy size whose *shape* the table cannot serve
  // is refused rather than opened into a state with no resolution to render at.
  const legacyOff = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const doc = JSON.parse(JSON.stringify(${JSON.stringify(liveProject)}));
    delete doc.aspect;
    doc.outputSize = '1600x1000';
    try { k.library.restoreProject(doc); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  })()`);
  check(!legacyOff.ok && /offers no resolution for/.test(String(legacyOff.error)),
    '  while one whose shape this build has no size for is refused, rather than opened onto an export that cannot run',
    legacyOff.ok ? 'adopted 8:5' : String(legacyOff.error).slice(0, 100));

  await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.library.restoreProject(${JSON.stringify(liveProject)});
    k.setOutputSize(${JSON.stringify(liveSize)});
  })()`);
  await settle();

  const cameraBefore = await page.evaluate('__kinect.freeCamera.position.toArray()');
  await page.evaluate('__kinect.freeCamera.position.x += 2; __kinect.controls.update()');
  await page.locator('#viewMenuButton').click();
  await page.locator('#menuCameraReset').click();
  const cameraReset = await page.evaluate('__kinect.freeCamera.position.toArray()');
  check(cameraReset.every((value, i) => Math.abs(value - cameraBefore[i]) < 1e-6),
    'Default camera position reaches OrbitControls reset', `${cameraBefore.join(',')} -> ${cameraReset.join(',')}`);

  // The strip's look-through-the-program-camera toggle. It arrived with the rework as a
  // second control for an action the panel already had - both call `toggleCameraView` -
  // and it was the one control on the whole editor with nothing driving it, which is
  // what section 1's sweep is for.
  //
  // **Read back through `controls.enabled` rather than through the attribute that was
  // just written.** `setViewCamera` switches the orbit off while the program camera is
  // on screen, because a drag would otherwise move the free camera somewhere nobody can
  // see; that is a consequence of being on the program camera, where `aria-pressed` is
  // the press describing itself. A build that moved the attribute and left the view
  // where it was would satisfy the second reading and fail this one.
  const orbitBefore = await page.evaluate('__kinect.controls.enabled');
  await page.locator('#tCamView').click();
  const looking = await page.evaluate(`(() => ({
    orbit: __kinect.controls.enabled,
    strip: document.getElementById('tCamView').getAttribute('aria-pressed'),
    panel: document.getElementById('camView').getAttribute('aria-pressed'),
  }))()`);
  check(orbitBefore && looking.orbit === false && looking.strip === 'true' && looking.panel === 'true',
    'the strip looks through the program camera, and the panel copy of the toggle agrees',
    `orbit ${orbitBefore} -> ${looking.orbit}, strip ${looking.strip}, panel ${looking.panel}`);
  await page.locator('#tCamView').click();
  const handedBack = await page.evaluate('__kinect.controls.enabled');
  check(handedBack === true, 'and pressing it again hands the orbit back', `orbit ${handedBack}`);

  await page.locator('#viewMenuButton').click();
  await page.locator('#menuTopView').click();
  check(await page.evaluate('__kinect.keyframes.chrome.topView()') === false,
    'Show top view turns the plan overlay off through the View command');
  await page.locator('#viewMenuButton').click();
  await page.locator('#menuTopView').click();
  check(await page.evaluate('__kinect.keyframes.chrome.topView()') === true,
    'and the same command turns it back on');

  const fileChooser = page.waitForEvent('filechooser');
  await page.locator('#viewMenuButton').click();
  await page.locator('#menuLookImport').click();
  check(Boolean(await fileChooser), 'Import Look reaches the existing file input');
  await page.locator('#viewMenuButton').click();
  await page.locator('#menuLookExport').click();
  await page.waitForFunction('document.getElementById("presetPick").open');
  check(await page.evaluate('document.getElementById("presetPick").open'),
    'Export Look reaches the existing subset dialog');
  await page.locator('#ppCancel').click();

  // **Read off the chrome canvas, because that is where the numbers are.** This asked a
  // `#stateDialog` for a JSON dump until the overlay replaced it, and the dialog stayed
  // in the markup with nothing opening it - so the row went on passing against a second
  // representation while the one that ships was never looked at, and then crashed on an
  // empty `<pre>` the moment the dump stopped being written. Pixels rather than a
  // serialised object is the cost of measuring the thing itself: the overlay is drawn,
  // so what it puts on screen is the only evidence it works.
  //
  // The two samples are the whole assertion. `before` is taken where the panel lands and
  // has to be the empty stage; a single sample after the press could be satisfied by
  // anything already painted there, including the top-down view the overlay sits under.
  // The box the overlay fills, sampled for opaque pixels. `dpr` comes off the canvas
  // itself - `drawChrome` writes both the backing size and the CSS size, so their ratio
  // is the scale it drew at rather than a `devicePixelRatio` this process would be
  // guessing on the browser's behalf. The region sits below the top-down inset, which
  // the two rows above this leave switched on.
  const nerdSample = `(() => {
    const c = document.getElementById('chrome');
    if (!c || !c.width) return null;
    const ctx = c.getContext('2d');
    const dpr = c.width / parseFloat(c.style.width || c.width);
    const px = (n) => Math.round(n * dpr);
    const cssW = c.width / dpr;
    const d = ctx.getImageData(px(cssW - 178), px(140), px(164), px(140)).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) lit++;
    return lit;
  })()`;
  await page.locator('#viewMenuButton').click();
  const nerdBefore = await page.evaluate(nerdSample);
  await page.locator('#menuState').click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const nerdAfter = await page.evaluate(nerdSample);
  const nerdChecked = await page.getAttribute('#menuState', 'aria-checked');
  // **Both samples, because one of them is what makes the other mean anything.** A row
  // that only read `after` would be satisfied by whatever was already painted there, and
  // the top-down view is eight pixels above this box. `before` being empty is the half
  // that says the pixels counted afterwards are the ones this press put down.
  check(nerdBefore === 0 && nerdAfter > 0 && nerdChecked === 'true',
    'Stats for nerds paints the running editor onto the chrome overlay and marks itself on',
    `${nerdBefore} opaque pixels before, ${nerdAfter} after, aria-checked ${nerdChecked}`);
  // Off again, because every section below this measures a stage the overlay would be
  // sitting on top of - and section 8 compares two pictures of one clip for equality,
  // which a live fps counter in the corner would decide for it.
  await page.locator('#viewMenuButton').click();
  await page.locator('#menuState').click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const nerdOff = await page.evaluate(nerdSample);
  check(nerdOff === 0 && await page.getAttribute('#menuState', 'aria-checked') === 'false',
    'and the same command takes it off again, so every section below inherits a clean stage',
    `${nerdOff} opaque pixels left`);

  await page.evaluate(`(() => {
    globalThis.__obsCopied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => { globalThis.__obsCopied.push(value); } },
    });
    globalThis.__openedObs = null;
    globalThis.open = (...args) => { globalThis.__openedObs = args; return null; };
    const size = document.getElementById('progSize');
    size.value = '1440x900';
    size.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.locator('#outputMenuButton').click();
  await page.locator('#menuObs').click();
  const customObsSize = await page.evaluate(`(() => ({
    value: document.getElementById('obsResolution').value,
    option: [...document.getElementById('obsResolution').options]
      .find((entry) => entry.value === '1440x900')?.textContent ?? null,
  }))()`);
  check(customObsSize.value === '1440x900' && customObsSize.option?.includes('current'),
    'Output to OBS reflects a valid custom size the existing control already accepted',
    JSON.stringify(customObsSize));
  await page.locator('#obsViewportMode').click();
  await page.locator('#obsResolution').selectOption('1280x720');
  await page.locator('#obsCopyBrowser').click();
  await page.locator('#obsCopyWebcam').click();
  await page.locator('#obsOpen').click();
  const obs = await page.evaluate(`(() => ({
    open: document.getElementById('obsDialog').open,
    mode: document.getElementById('progMode').value,
    size: document.getElementById('progSize').value,
    copied: globalThis.__obsCopied,
    opened: globalThis.__openedObs,
  }))()`);
  check(obs.open && obs.mode === 'mirror' && obs.size === '1280x720'
      && obs.copied.length === 2 && obs.opened?.[0] === obs.copied[0],
    'Output to OBS drives the existing mode and size and exposes both real source URLs', JSON.stringify(obs));
  await page.locator('#obsProgramMode').click();
  await page.locator('#obsDone').click();
  // The close event is queued after close(), so yield once before reading focus.
  // Keep this bounded: the mutation must fail an assertion rather than time out.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const obsReturnFocus = await page.evaluate('document.activeElement?.id');
  check(obsReturnFocus === 'outputMenuButton',
    'closing the OBS dialog returns focus to the visible Output trigger', obsReturnFocus || 'body');

  // =====================================================================
  console.log('\n[2] the keyboard, and the guard that has to come with it');
  // =====================================================================
  await page.evaluate('__kinect.timeline.transport().seek(6)');
  await settle();
  await focusStage();

  const playingBefore = (await read()).playing;
  await page.keyboard.press(' ');
  await new Promise((r) => setTimeout(r, 500));
  const playingAfter = (await read()).playing;
  check(!playingBefore && playingAfter, 'space starts playback', `${playingBefore} -> ${playingAfter}`);
  await page.keyboard.press(' ');
  await new Promise((r) => setTimeout(r, 400));
  check(!(await read()).playing, 'and space stops it again - the toggle is driven both ways');
  await page.evaluate('__kinect.timeline.transport().pause()');
  await settle();

  const f0 = (await read()).frame;
  await page.keyboard.press('ArrowRight');
  await settle();
  const f1 = (await read()).frame;
  check(f1 === f0 + 1, 'right arrow steps exactly one output frame', `${f0} -> ${f1}`);
  await page.keyboard.press('ArrowLeft');
  await settle();
  check((await read()).frame === f0, 'and left steps exactly one back', `${f1} -> ${(await read()).frame}`);
  const fps = (await read()).outputFps;
  await page.keyboard.press('Shift+ArrowRight');
  await settle();
  check((await read()).frame === f0 + fps, 'shift-right steps one second, which is the rate rather than a constant',
    `${f0} -> ${(await read()).frame} at ${fps}fps`);

  await page.keyboard.press('Home');
  await settle();
  const home = (await read()).programSec;
  await page.keyboard.press('End');
  await settle();
  const end = (await read()).programSec;
  check(near(home, 0, 0.05) && end > home + 1, 'home and end park at the two ends of the clip',
    `${home.toFixed(3)}s and ${end.toFixed(3)}s`);

  await page.evaluate('__kinect.timeline.transport().seek(5)');
  await settle();
  await page.keyboard.press('i');
  await settle();
  await page.evaluate('__kinect.timeline.transport().seek(18)');
  await settle();
  await page.keyboard.press('o');
  await settle();
  const keyed = await range();
  check(near(keyed.in, 5, 0.1) && near(keyed.out, 18, 0.1), 'i and o set the range at the playhead',
    JSON.stringify(keyed));
  await page.evaluate('__kinect.timeline.transport().seek(12)');
  await settle();
  await page.keyboard.press('Shift+i');
  await settle();
  const jumped = await read();
  const afterJump = await range();
  check(near(jumped.programSec, 5, 0.1), 'shift-i jumps the playhead to in', `${jumped.programSec.toFixed(3)}s`);
  check(near(afterJump.in, keyed.in, 1e-6) && near(afterJump.out, keyed.out, 1e-6),
    'and moves the range not at all, which is the difference between the two gestures',
    JSON.stringify(afterJump));

  // The typing guard. `i`, `o` and `m` are all letters somebody has to be able to put
  // in a filename, so a shortcut handler with no guard makes the one text field in
  // the export dialog unusable while quietly editing the clip.
  await page.locator('#outputMenuButton').click();
  await page.locator('#menuExport').click();
  await page.evaluate(`(() => { const el = document.getElementById('tExportName'); el.value = ''; el.focus(); })()`);
  const beforeTyping = await range();
  const keysBeforeTyping = await lanes();
  await page.keyboard.type('iom');
  await new Promise((r) => setTimeout(r, 250));
  const typed = await page.locator('#tExportName').inputValue();
  const afterTyping = await range();
  check(typed === 'iom', 'the three shortcut letters can be typed into the name field', `"${typed}"`);
  check(JSON.stringify(beforeTyping) === JSON.stringify(afterTyping),
    'and typing them changed no clip range', `${JSON.stringify(beforeTyping)} then ${JSON.stringify(afterTyping)}`);
  check(JSON.stringify(keysBeforeTyping) === JSON.stringify(await lanes()),
    'and deleted no key');
  await page.evaluate(`(() => { const el = document.getElementById('tExportName'); el.value = ''; el.blur(); })()`);
  await page.locator('#exportClose').click();
  await focusStage();

  // =====================================================================
  console.log('\n[3] the in and out markers, which is the claim nothing was making');
  // =====================================================================
  const markersPresent = async () => page.evaluate(`(() => {
    const box = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, x: r.x, y: r.y };
    };
    return { in: box('tIn'), out: box('tOut') };
  })()`);
  const boxes = await markersPresent();
  check(boxes.in !== null && boxes.out !== null,
    'both markers are in the document at all - this is the row that was missing',
    `in ${boxes.in ? 'present' : 'ABSENT'}, out ${boxes.out ? 'present' : 'ABSENT'}`);
  check(Boolean(boxes.in && boxes.in.h > 10 && boxes.out && boxes.out.h > 10),
    'and both have a real box rather than a collapsed one',
    boxes.in ? `${boxes.in.w}x${boxes.in.h} and ${boxes.out.w}x${boxes.out.h}` : 'n/a');

  // The reach, probed by what is under the pointer rather than by the box. The drawn
  // line is 1px and the grab zone is a pseudo-element, so a box measurement would
  // report the wrong number in the reassuring direction.
  const grabWidth = async (id) => page.evaluate(`(${((elId) => {
    const el = document.getElementById(elId);
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    const mid = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    let n = 0;
    for (let dx = -18; dx <= 18; dx++) {
      const hit = document.elementFromPoint(mid.x + dx, mid.y);
      if (hit === el) n++;
    }
    return n;
  }).toString()})(${JSON.stringify(id)})`);
  await page.locator('#tClearRange').click();
  await settle();
  const grabOutAtEnd = await grabWidth('tOut');
  const grabIn = await grabWidth('tIn');
  check(grabOutAtEnd >= 10, 'out is grabbable where it is hardest to be - at "end", on the strip\'s right edge',
    `${grabOutAtEnd}px of reach`);
  check(grabIn >= 10, 'and in is grabbable at zero, on the left edge', `${grabIn}px of reach`);

  // The drag itself, with the marker away from either edge.
  //
  // **Guarded on the markers existing, because the whole point of this section is a
  // build where they do not.** The first run of `--mutate lanes-clear-siblings`
  // reddened its four rows correctly and then died dereferencing a null `#tOut` -
  // which this file reports as DID NOT RUN with exit 2, the code reserved for the
  // harness failing. A mutation that is caught and then crashes reads as a mutation
  // that was never tested, the same confusion `docs/instruments.md` records under
  // "a mutation run that exits non-zero with zero failed assertions did not run",
  // arriving from the other direction. A check has to survive the fault it checks for.
  const markersUsable = boxes.in !== null && boxes.out !== null;
  await page.evaluate('__kinect.timeline.transport().seek(30)');
  await settle();
  await page.locator('#tSetOut').click();
  await settle();
  const beforeDrag = await range();
  let afterDrag = beforeDrag;
  if (!markersUsable) {
    check(false, 'dragging the out marker left shortens the export range', 'there is no marker to drag');
    check(false, 'and the numeric readout followed it', 'not reached - the marker is absent');
    check(false, 'and what the export leaves out is drawn, in proportion to what it leaves out',
      'not reached - the marker is absent');
  } else {
    const outMid = await page.evaluate(`(() => {
      const r = document.getElementById('tOut').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await page.mouse.move(outMid.x, outMid.y);
    await page.mouse.down();
    await page.mouse.move(outMid.x - 300, outMid.y, { steps: 8 });
    await page.mouse.up();
    await settle();
    afterDrag = await range();
    check(afterDrag.out < beforeDrag.out - 1, 'dragging the out marker left shortens the export range',
      `${beforeDrag.out.toFixed(3)}s -> ${afterDrag.out.toFixed(3)}s`);
    check((await text('#tOutOut')).trim() !== 'end' && (await text('#tOutOut')).includes(':'),
      'and the numeric readout followed it', `out reads ${(await text('#tOutOut')).trim()}, length ${(await text('#tClipLen')).trim()}`);

    // The shading, measured as a fraction rather than looked at. A near-black wash
    // over a near-black strip is exactly the kind of thing a reader confirms by
    // expecting it.
    const shade = await page.evaluate(`(() => {
      const bed = document.getElementById('tBeds').getBoundingClientRect();
      const outEl = document.getElementById('tShadeOut');
      if (!outEl) return null;
      const r = outEl.getBoundingClientRect();
      return { bedW: bed.width, outW: r.width };
    })()`);
    const dur = (await read()).duration;
    const expectedFraction = 1 - (afterDrag.out / dur);
    check(shade !== null && near(shade.outW / shade.bedW, expectedFraction, 0.02),
      'and what the export leaves out is drawn, in proportion to what it leaves out',
      shade ? `${(shade.outW / shade.bedW * 100).toFixed(1)}% shaded against ${(expectedFraction * 100).toFixed(1)}% excluded`
        : 'the shading element is not in the document either');
  }

  // The regression that started this file: a lane appearing must not take the markers
  // with it. Driven through the same door a user would - a track gaining its first key.
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [{ t: 1, value: 0.2 }, { t: 6, value: 0.9 }] })`);
  await settle();
  const afterLanes = await markersPresent();
  check(afterLanes.in !== null && afterLanes.out !== null && afterLanes.out.h > 10,
    'and both markers survive a lane being built, which is when they used to disappear',
    `${(await lanes()).length} lanes, in ${afterLanes.in ? 'present' : 'GONE'}, out ${afterLanes.out ? 'present' : 'GONE'}`);
  check(near((await range()).out ?? -1, afterDrag.out ?? -1, 1e-6),
    'and the range they show is unchanged by it', JSON.stringify(await range()));
  await page.locator('#tClearRange').click();
  await settle();
  check((await range()).out === null && (await range()).in === 0,
    '"whole clip" puts the range back, and back to null rather than to the duration',
    JSON.stringify(await range()));

  // =====================================================================
  console.log('\n[4] the speed control holds the frame you are looking at');
  // =====================================================================
  //
  // This block runs at the head of the section rather than at its tail, and that is a
  // placement rather than a preference. At the tail it left section 5's ease-handle drag
  // dead - the drag registered nothing, on a page whose state at that instant was
  // byte-identical to a passing run's: same handle box, same selection, same focus, same
  // transport, measured side by side. Whatever the block perturbs is not anything either
  // run can read, so it goes where the rows that follow rebuild the document from scratch
  // before they measure anything. Recorded rather than tidied away, because a
  // reordering that fixes a failure nobody can explain is a fact about this file that the
  // next person moving a block needs.
  // **A held arrow key is one gesture to the user and was six to the control.** Chromium
  // fires `keydown -> input -> change` on every auto-repeat and a single `keyup` at the
  // end, so a `change` handler that ended the gesture unconditionally ended and restarted
  // it per repeat - measured at six undo commits and six accurate pre-roll seeks for one
  // held key, which is the seek storm this control was rewritten to avoid, surviving on
  // the one gesture nobody watches. It lost the take as well: each repeat read
  // `timeline.playing` off a transport the previous repeat had just paused.
  //
  // Driven as the OS delivers it - one real keydown, repeats carrying `repeat: true` with
  // their `input`, and one keyup at the end. Both counters are read because they are two
  // different costs of the same fault, and a row that reported only the commits would say
  // nothing about the seeks a user actually waits for.
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await settle();
  await page.evaluate("document.getElementById('tRate').focus()");
  await page.evaluate('__kinect.timeline.transport().play()');
  await new Promise((r) => setTimeout(r, 300));
  const heldBefore = await page.evaluate(`(() => ({
    playing: __kinect.timeline.transport().playing,
    depth: __kinect.keyframes.undo.depth(),
    seeks: __kinect.timeline.counters.seeks,
    rate: __kinect.timeline.retime.rate,
  }))()`);
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    const step = 0.01;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    for (let i = 1; i <= 6; i++) {
      el.value = String(Number(el.value) + step);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true }));
      // A modifier tapped in the middle of the hold, which a hand on a keyboard does
      // constantly and which used to end the gesture on its release - the arrow was still
      // repeating, so the next repeat opened a second gesture against a transport the
      // first had already paused. Without this the drive is a clean hold that no stray
      // release ever interrupts, and the rule about *which* key ends a gesture is
      // asserted by nothing.
      if (i === 3) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      }
    }
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  })()`);
  await settle();
  for (let i = 0; i < 60 && !(await page.evaluate('__kinect.timeline.transport().playing')); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const heldAfter = await page.evaluate(`(() => ({
    playing: __kinect.timeline.transport().playing,
    depth: __kinect.keyframes.undo.depth(),
    seeks: __kinect.timeline.counters.seeks,
    rate: __kinect.timeline.retime.rate,
  }))()`);
  check(heldBefore.playing && heldAfter.rate > heldBefore.rate,
    'a held arrow key moves the speed, so the two counters below are counting a gesture that happened',
    `${heldBefore.rate}x -> ${heldAfter.rate}x, take was running ${heldBefore.playing}`);
  check(heldAfter.depth - heldBefore.depth === 1,
    '  and costs one undo step for the whole hold, not one per repeat',
    `depth ${heldBefore.depth} -> ${heldAfter.depth}`);
  check(heldAfter.seeks - heldBefore.seeks <= 2,
    '  and one accurate seek, which is the storm this control exists to avoid',
    `${heldAfter.seeks - heldBefore.seeks} seeks for 6 repeats`);
  check(heldAfter.playing,
    '  and gives the take back, rather than losing the play intent on the first repeat',
    `playing ${heldBefore.playing} -> ${heldAfter.playing}`);

  // Stopped and put back to 1x before the rows below drive rates of their own. Leaving
  // the take running at 1.248x here reddened the page-errors row at the very end of the
  // file with `the retime curve runs backwards`: the accumulators walk forward one source
  // frame at a time, so a rate driven underneath a playhead that is still moving asks the
  // source to go back. The take being *running* is the whole point of the rows above, so
  // this is the price of them rather than something to move.
  await focusStage();
  await page.evaluate('__kinect.timeline.transport().pause()');
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate('__kinect.timeline.transport().seek(0)');
  await settle();

  // **A rate release plays again after a seek, and that seek is long enough to press
  // space in.** The resume asks only whether anybody has taken the transport since - and
  // pausing was not taking it, so the space bar stopped the take and the queued resume
  // started it again a moment later. Every navigation that pauses for its own purposes
  // announces it now; the space bar is the plainest of them and the one this drives.
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await settle();
  await page.evaluate('__kinect.timeline.transport().play()');
  await new Promise((r) => setTimeout(r, 300));
  const runningBefore = await page.evaluate('__kinect.timeline.transport().playing');
  // The release and the navigation go in one task, with no round trip between them. That
  // is the whole of the row: the resume rides the release's pre-roll, so a navigation
  // arriving after the pre-roll has finished has nothing left to invalidate and the
  // mutation walks past. A first version pressed the key through Playwright and did
  // exactly that - it reported the fix working on a build without it.
  //
  // `Home` rather than the space bar, and for a reason worth naming: at this instant the
  // gesture has already paused the take, so space would *start* it rather than stop it.
  // `goTo` pauses unconditionally, which is what makes "is it playing a second later" a
  // clean read of whether the queued resume fired.
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    el.value = String(__kinect.editor.rateSlider.toValue(1.6));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    // Out of the control first, or the window handler's typing guard skips the key.
    el.blur();
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  })()`);
  await settle();
  await new Promise((r) => setTimeout(r, 1500));
  const afterNav = await page.evaluate('__kinect.timeline.transport().playing');
  check(runningBefore,
    'a take is running when the speed gesture starts, so the release below has a resume to queue',
    `playing ${runningBefore}`);
  check(afterNav === false,
    '  and a navigation arriving inside its pre-roll keeps it stopped, rather than the resume starting it again',
    `playing ${runningBefore} -> ${afterNav}`);
  await page.evaluate('__kinect.timeline.transport().pause()');
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await settle();



  // Two positions and two directions, because program and source time agree
  // trivially at program 0 and a single arm cannot tell holding one from holding the
  // other. `docs/instruments.md` has this failure twice already under "what do my
  // arms agree about".
  // **The slider's `value` is a position, not a rate.** Its travel is logarithmic, so
  // writing `2.35` into it asks for the top of the range and every row below would go
  // on asserting about 4x while claiming to be about 2.35x - a check retargeted
  // invisibly, which is the shape `docs/instruments.md` records twice. The rate goes
  // through the page's own mapping, and the rate that came out is checked against the
  // one that went in rather than assumed.
  const driveRate = async (rate) => {
    await page.evaluate(`(() => {
      const el = document.getElementById('tRate');
      el.value = String(__kinect.editor.rateSlider.toValue(${rate}));
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    })()`);
    await settle();
    const landed = await page.evaluate('__kinect.timeline.retime.rate');
    check(near(landed, rate, 1e-6), `  the slider went to ${rate}x when it was asked for ${rate}x`,
      `landed at ${landed}x`);
    return landed;
  };

  const rateArm = async (parkAt, to) => {
    await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
    await driveRate(1);
    await page.evaluate(`__kinect.timeline.transport().seek(${parkAt})`);
    await settle();
    const before = await read();
    const leftBefore = await page.evaluate(`document.getElementById('tPlayhead').style.left`);
    await driveRate(to);
    const after = await read();
    const leftAfter = await page.evaluate(`document.getElementById('tPlayhead').style.left`);
    return { before, after, leftBefore, leftAfter };
  };

  for (const [parkAt, to] of [[10, 2], [10, 0.5], [24, 2]]) {
    const arm = await rateArm(parkAt, to);
    check(near(arm.after.sourceSec, arm.before.sourceSec, 1e-3),
      `at ${parkAt}s, changing speed to ${to}x holds the source frame`,
      `source ${arm.before.sourceSec.toFixed(4)}s -> ${arm.after.sourceSec.toFixed(4)}s`);
    check(near(parseFloat(arm.leftAfter), parseFloat(arm.leftBefore), 0.05),
      '  and holds the playhead at the same place on a ruler that rescaled under it',
      `${arm.leftBefore} -> ${arm.leftAfter}, duration ${arm.before.duration.toFixed(2)}s -> ${arm.after.duration.toFixed(2)}s`);
    check(!near(arm.after.programSec, arm.before.programSec, 1e-3),
      '  by moving program time, which is what proves it held the other one',
      `program ${arm.before.programSec.toFixed(3)}s -> ${arm.after.programSec.toFixed(3)}s`);
  }

  // **The three arms above agree about something, and it is the output grid.** 10s and 24s
  // are frames 300 and 720 at 30fps, and 2x and 0.5x take those to 150, 600 and 360 -
  // every one exactly on the grid, so all three measure a drift of 0.0ms and the 1e-3
  // above passes without ever exercising the rounding. Measured that way rather than
  // reasoned: the same arithmetic at 2.35x moves the source moment 26.7ms.
  //
  // So this arm parks at the same 10s and asks for a rate the grid cannot represent. What
  // it asserts is the *bound* rather than equality, because equality is not available: the
  // transport shows a frame, and with `source = program * rate` the frame nearest in
  // program time is already the frame nearest in source time - `Math.round` is the
  // minimiser and the residual is the grid itself, up to half a frame of program time,
  // which is `rate / (2 * outputFps)` of source.
  //
  // Both halves are asserted. The bound alone would pass on a build that held the source
  // exactly, which is impossible but would also pass on one that had stopped rescaling at
  // all - so the drift is required to be non-zero as well, which is what makes this arm
  // measure the grid rather than agree with the three above.
  const offGrid = await rateArm(10, 2.35);
  const drift = Math.abs(offGrid.after.sourceSec - offGrid.before.sourceSec);
  const bound = 2.35 / (2 * offGrid.before.outputFps);
  check(drift > 1e-3,
    'at a rate the output grid cannot represent, the anchor does move - which the three arms above never showed',
    `source ${offGrid.before.sourceSec.toFixed(4)}s -> ${offGrid.after.sourceSec.toFixed(4)}s, `
    + `${(drift * 1000).toFixed(1)}ms at 2.35x`);
  check(drift <= bound + 1e-9,
    '  and no further than half an output frame, which is the whole of what the grid costs',
    `${(drift * 1000).toFixed(1)}ms against a bound of ${(bound * 1000).toFixed(1)}ms `
    + `at ${offGrid.before.outputFps}fps`);

  // ---------------------------------------------------------------------
  // And the rest of the strip, which held the same bug for longer.
  //
  // The playhead rows above are one term of a class that has four. `in`, `out`, the
  // deliverable's copy of them and every keyframe's `t` are all program times, and a
  // speed change rescales the ruler underneath all of them. Measured on the user's own
  // numbers before the fix: source ~960s, so the ruler ends at 800s at 1.20x and 408s
  // at 2.35x while `in`/`out` stayed pinned at 234.509/407.612, which walked the out
  // cut from 50.3% of the ruler to 99.5% - and took what the export contained with it.
  //
  // **Both arms are away from 1x, and that is the whole design of this row.** At rate 1
  // program time *is* source time, so a build that never rescales anything is
  // bit-identical to one that rescales correctly, and an arm touching 1x would pass on
  // either. 1.20 -> 2.35 is the pair from the report.
  //
  // One row per marker kind rather than one boolean over all of them, because a
  // cumulative assertion says something broke and not which term - `docs/instruments.md`
  // has that as its own rule after step 6 measured three grade terms down one row. The
  // mark is the odd one and belongs here for it: it is stored in source milliseconds and drawn
  // through the curve, so it must hold still *without* being rescaled, which is what
  // separates "every term was carried" from "the ruler never moved at all".
  const STRIP = () => {
    // Every read goes through a guard, including the two shades - and that is not
    // tidiness. `lanes-clear-siblings` empties `#tBeds` of everything that is not the
    // ruler or the playhead, which takes the shades with the markers, so an unguarded
    // `.style` here throws inside a `page.evaluate` two sections after the mutation has
    // already been caught. The run then exits 2 as DID NOT RUN with its eight correct
    // red rows discarded, which reads as a mutation nobody tested rather than one that
    // was caught. Measured: this branch exits 2 at 46 assertions where `origin/main`
    // exits 1 at 86, on the same mutation.
    const left = (sel) => { const el = document.querySelector(sel); return el ? el.style.left : null; };
    const box = (sel) => {
      const el = document.querySelector(sel);
      return el ? `${el.style.left}+${el.style.width}` : null;
    };
    return {
      playhead: left('#tPlayhead'),
      tIn: left('#tIn'),
      tOut: left('#tOut'),
      shadeIn: box('#tShadeIn'),
      shadeOut: box('#tShadeOut'),
      keys: [...document.querySelectorAll('.tlane[data-owner=bloom] .tkey')].map((k) => k.style.left).join(' '),
      marks: [...document.querySelectorAll('#tMarks .tmk')].map((m) => m.style.left).join(' '),
      // What proves the sameness above was carried rather than merely undisturbed.
      keyTimes: (__kinect.keyframes.project().look.tracks.bloom ?? []).map((k) => k.t.toFixed(4)).join(' '),
      // The camera track, read separately because it is serialised separately - it
      // lives under `composition` rather than under `look.tracks`, and a rescale that
      // walked only the look tracks would pass every row above while sliding the whole
      // camera move against the footage. One track kind cannot carry a claim about all
      // of them.
      cameraTimes: (__kinect.keyframes.project().composition.camera ?? []).map((k) => k.t.toFixed(4)).join(' '),
      clip: __kinect.editor.clipRange(),
      duration: __kinect.timeline.transport().duration,
    };
  };
  const strip = () => page.evaluate(`(${STRIP})()`);

  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [ { t: 2, value: 0.2 }, { t: 6, value: 0.9 } ] })`);
  // A camera key as well as a look key, because the two are serialised down different
  // branches and a rescale could plausibly walk one list and not the other.
  await page.evaluate(`(() => {
    __kinect.timeline.transport().pause();
    __kinect.setViewCamera(__kinect.viewCamera());
    __kinect.keyframes.toggle('camera');
  })()`);
  await page.evaluate(`__kinect.editor.setMarks([{ id: 'm1', sourceMs: 3000, label: 'probe' }])`);
  await settle();
  await page.evaluate(`__kinect.timeline.transport().seek(1.5)`);
  await settle();
  await page.locator('#tSetIn').click();
  await page.evaluate(`__kinect.timeline.transport().seek(7)`);
  await settle();
  await page.locator('#tSetOut').click();
  await page.evaluate(`__kinect.timeline.transport().seek(4)`);
  await settle();

  await driveRate(1.2);
  const at120 = await strip();
  await driveRate(2.35);
  const at235 = await strip();
  // Read after the second rate change rather than before it. The slider's `change`
  // commits, so a depth taken before it is a level short and the row reads 9 -> 9 on a
  // pop that worked perfectly - a red row about the check's own bookkeeping rather than
  // about undo.
  const undoBefore = await page.evaluate('__kinect.keyframes.undo.depth()');

  check(at235.duration < at120.duration - 1e-6,
    'the ruler really did rescale from 1.20x to 2.35x, or none of the rows below mean anything',
    `${at120.duration.toFixed(3)}s -> ${at235.duration.toFixed(3)}s`);
  for (const [term, label] of [
    ['tIn', 'the in cut holds its place on the ruler'],
    ['tOut', 'the out cut holds its place on the ruler'],
    ['shadeIn', 'and the shading before it does'],
    ['shadeOut', 'and the shading after it does'],
    ['keys', 'every keyframe holds its place on the ruler'],
    ['marks', "the take's marks hold theirs, without being rescaled to do it"],
  ]) {
    check(at120[term] === at235[term], `  ${label}`, `${at120[term]} -> ${at235[term]}`);
  }
  check(near(parseFloat(at235.playhead), parseFloat(at120.playhead), 0.05),
    '  and so does the playhead', `${at120.playhead} -> ${at235.playhead}`);
  // The other direction. Holding still because nothing was carried is the failure this
  // separates out: at 1.20 -> 2.35 the times must fall by 1.20/2.35, and a build that
  // left them alone would hold the numbers and move every marker.
  check(at120.keyTimes !== at235.keyTimes && at120.clip.in !== at235.clip.in,
    '  by rescaling the times underneath, which is what proves it carried them',
    `keys ${at120.keyTimes} -> ${at235.keyTimes}, in ${at120.clip.in.toFixed(4)} -> ${at235.clip.in.toFixed(4)}`);
  check(at120.cameraTimes !== '' && at120.cameraTimes !== at235.cameraTimes,
    '  including the camera track, which is serialised down a different branch',
    `camera ${at120.cameraTimes} -> ${at235.cameraTimes}`);
  const k = 1.2 / 2.35;
  check(near(at235.clip.in, at120.clip.in * k, 1e-6) && near(at235.clip.out, at120.clip.out * k, 1e-6),
    '  by exactly the ratio of the two rates, which is what keeps the export on the same footage',
    `in ${at120.clip.in.toFixed(4)} -> ${at235.clip.in.toFixed(4)}, wanted ${(at120.clip.in * k).toFixed(4)}`);

  // Undo across a speed change. `clipIn`/`clipOut` are deliverable state and
  // deliberately outside the snapshot, so the keys come back from the document and the
  // cuts have to be carried by the same map the gesture used - otherwise undo restores
  // half the strip and leaves the markers where the new rate put them.
  await page.evaluate(`__kinect.keyframes.undo.pop()`);
  await settle();
  const undone = await strip();
  const undoAfter = await page.evaluate('__kinect.keyframes.undo.depth()');
  check(undoAfter < undoBefore,
    '  undo actually popped a level, so the rows below are about a restore',
    `depth ${undoBefore} -> ${undoAfter}`);
  check(near(undone.duration, at120.duration, 1e-6),
    '  undoing a speed change puts the ruler back', `${undone.duration.toFixed(3)}s against ${at120.duration.toFixed(3)}s`);
  check(undone.tIn === at120.tIn && undone.tOut === at120.tOut,
    '  and puts the cuts back with it, which the snapshot alone cannot do',
    `in ${at120.tIn} -> ${undone.tIn}, out ${at120.tOut} -> ${undone.tOut}`);
  check(undone.keys === at120.keys, '  and the keys', `${at120.keys} -> ${undone.keys}`);

  // The detent at 1.00x, which is the one rate that has to be reachable *exactly*
  // rather than approximately: `slopeAt` reports it to the audio gate, and a take
  // playing at 0.9995 is a take the gate reads as retimed. A logarithmic grid has no
  // reason to land on 1 at all, so a band around it snaps.
  //
  // Both sides, because a band that snapped everything would pass the first row alone
  // and quietly make every nearby rate unreachable - the same shape as a probe standing
  // in a dead zone. The offsets are in slider travel: 0.005 is inside the band and 0.05
  // is a tenth of the whole control away from it.
  const atSlider = async (offset) => {
    await page.evaluate(`(() => {
      const el = document.getElementById('tRate');
      el.value = String(__kinect.editor.rateSlider.toValue(1) + ${offset});
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    })()`);
    await settle();
    return page.evaluate('__kinect.timeline.retime.rate');
  };
  // **Driven by pixel as well as by value, because a detent is a hit target.** The arms
  // below assign `el.value`, which exercises the arithmetic and not the affordance - and
  // the affordance is the whole point: the band was stated as +/-3% of rate, which on a
  // travel spanning a factor of 40 is `ln(1.03)/ln(40)` of the control, or 0.74px each
  // side of the 92px slider the stylesheet ships. Sub-pixel, so the one value the detent
  // exists to make reachable was unreachable by pointer, on a build whose value-driven
  // rows all passed. The band is stated in pixels now and this row clicks them.
  const rateBox = await page.locator('#tRate').boundingBox();
  check(rateBox.width < 200,
    'the speed slider is the narrow one the stylesheet ships, which is what the band has to fit',
    `${rateBox.width.toFixed(0)}px`);
  // **Measured in pixels of the rendered control, and both terms of that are measured.**
  // A first version swept the box a pixel at a time and reported 8px on a build with the
  // band and 8px on one without, which is a probe that answers the same number either way
  // and therefore measures neither - a range input's track is shorter than its box by the
  // thumb, and clicking is a gesture whose own detent arming gets in the way of reading
  // the band off it. So the two terms are taken apart: how wide the band is in travel,
  // asked of the page's own mapping, and how much travel a pixel is worth, taken from two
  // clicks far apart.
  const bandInTravel = await page.evaluate(`(() => {
    const one = __kinect.editor.rateSlider.toValue(1);
    let lo = 0;
    let hi = 1;
    // The largest offset from the 1.00x position that still comes back as exactly 1.
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (__kinect.editor.rateSlider.toRate(one + mid) === 1) lo = mid; else hi = mid;
    }
    return lo;
  })()`);
  const travelPerPixel = await (async () => {
    const read = async (dx) => {
      await page.mouse.click(rateBox.x + dx, rateBox.y + rateBox.height / 2);
      return page.evaluate("Number(document.getElementById('tRate').value)");
    };
    const near = await read(10);
    const far = await read(Math.round(rateBox.width) - 10);
    return (far - near) / (Math.round(rateBox.width) - 20);
  })();
  await settle();
  const bandPx = bandInTravel / Math.max(1e-9, travelPerPixel);
  check(travelPerPixel > 0,
    '  and a pixel of it is worth a measurable amount of travel, or the row below divides by noise',
    `${(1 / travelPerPixel).toFixed(1)}px of track across a ${rateBox.width.toFixed(0)}px box`);
  check(bandPx >= 2,
    '  and exactly 1.00x is reachable across at least two pixels either side of it',
    `${bandPx.toFixed(2)}px each side, from a band of ${bandInTravel.toFixed(5)} travel`);

  const inBand = await atSlider(0.005);
  check(inBand === 1, 'a slider position just off 1.00x snaps to exactly 1, not to 0.99-something',
    `landed at ${inBand}`);
  const outOfBand = await atSlider(0.05);
  check(outOfBand !== 1 && outOfBand > 1,
    '  and a position clear of the detent is left alone, so the band is a detent and not a floor',
    `landed at ${outOfBand}`);

  // **And a detent is for a value you are aiming at, not one you already had.** A project
  // can carry 1.02x - `restoreProject` takes any positive finite rate - and the thumb is
  // placed there correctly. The first small input in the same neighbourhood then came
  // through the band and returned exactly 1.00: two percent off every cut and every key
  // and a different rendered file, before the pointer had meaningfully moved.
  //
  // Driven as a gesture rather than through `driveRate`, because the rule is about a
  // gesture that *begins* inside the band, and `driveRate`'s `change` ends one per event.
  const nudged = await page.evaluate(`(async () => {
    __kinect.keyframes.setRetime({ rate: 1.02, keys: [] });
    await __kinect.timeline.settled();
    const el = document.getElementById('tRate');
    const loaded = { rate: __kinect.timeline.retime.rate, value: Number(el.value) };
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    el.value = String(loaded.value + 0.001);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await __kinect.timeline.settled();
    const nudge = __kinect.timeline.retime.rate;
    // Out of the band and back in, which is a gesture that aimed at 1.00x rather than one
    // that started next to it - the snap has to still happen there or the band is gone.
    el.value = String(__kinect.editor.rateSlider.toValue(1.5));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await __kinect.timeline.settled();
    const away = __kinect.timeline.retime.rate;
    el.value = String(__kinect.editor.rateSlider.toValue(1.005));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await __kinect.timeline.settled();
    const returned = __kinect.timeline.retime.rate;
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    el.blur();
    await __kinect.timeline.settled();
    return { loaded: loaded.rate, nudge, away, returned };
  })()`);
  check(near(nudged.loaded, 1.02, 1e-9),
    'a project carrying 1.02x loads at 1.02x, which is a rate no slider could have made',
    `${nudged.loaded}x`);
  check(nudged.nudge !== 1 && Math.abs(nudged.nudge - 1.02) < 0.02,
    '  and a small nudge beside it moves it a little rather than snapping two percent to 1.00x',
    `${nudged.loaded}x -> ${nudged.nudge}x`);
  check(near(nudged.away, 1.5, 1e-3),
    '  the same gesture can still leave the band', `${nudged.away}x`);
  check(nudged.returned === 1,
    '  and coming back into it from outside still snaps, which is what the band is for',
    `landed at ${nudged.returned}x`);
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await settle();

  // The seek storm. A slider drag is dozens of `input` events and one `change`, and
  // each accurate seek renders a whole pre-roll before it can show anything. The sweep
  // below is arbitrary travel - only the seek count is under test - but it does cross
  // the 1.00x detent, which is worth knowing if this row ever goes red for a reason
  // that has nothing to do with seeking.
  await page.evaluate('__kinect.timeline.counters.seeks = 0');
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    for (let i = 0; i < 20; i++) { el.value = String(0.4 + i * 0.02); el.dispatchEvent(new Event('input')); }
    el.dispatchEvent(new Event('change'));
  })()`);
  await settle();
  const seeks = await page.evaluate('__kinect.timeline.counters.seeks');
  check(seeks <= 2, 'twenty slider steps cost one accurate seek, not twenty', `${seeks} seeks`);

  // And the same discipline on a lane drag, read off the counters rather than timed -
  // a stopwatch here would pass on a fast machine that rebuilt every move.
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [
    { t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 } ] })`);
  await settle();
  const beforeCounters = await page.evaluate('({ ...__kinect.timeline.counters })');
  const kb = await page.locator('.tlane[data-owner=bloom] .tkey').nth(1).boundingBox();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(kb.x + kb.width / 2 + i * 4, kb.y + kb.height / 2);
  await page.mouse.up();
  await settle();
  const afterCounters = await page.evaluate('({ ...__kinect.timeline.counters })');
  const moved = afterCounters.laneRepositions - beforeCounters.laneRepositions;
  const fellBack = afterCounters.laneFallbacks - beforeCounters.laneFallbacks;
  check(moved >= 8, 'a ten-move key drag takes the cheap path on every move', `${moved} repositions`);
  check(fellBack === 0, 'and never falls back to a rebuild, which is what resized the drawing buffer',
    `${fellBack} fallbacks`);

  // **A gesture lasts as long as a finger or a key is down, which is long enough for a
  // load started before it to land in the middle of it.** The gesture pauses the
  // transport and captures the document it began in; `loadProjectNamed` and
  // `history.undo` both take the transport and put a *different* document underneath
  // it. A release that read `transportGen` fresh read the taker's generation, found it
  // equal to itself, and passed a check written to catch exactly this - rewriting every
  // key and both cuts of the new document from a snapshot of the old one, and resuming
  // a take the taker had deliberately paused.
  //
  // Driven through undo rather than through a project load because undo takes the
  // transport by the same call and needs no file on disk. The gesture is driven
  // keydown/input/keyup rather than through `driveRate`, because `change` is what
  // `driveRate` ends on and a `change` fires before anything can interrupt - the whole
  // failure lives in the window between the first `input` and the release.
  //
  // Two arms, and the uninterrupted one is what stops this being a row that passes on a
  // build whose release does nothing at all.
  // The take is running when each gesture starts, because the resume is the other half
  // of the finding and it lives on `wasPlaying`. Undo reads a transport this gesture has
  // already paused, so it does not restart it - which makes "playing after the release"
  // a clean read of whether the release resumed something it no longer owned.
  // Everything the release could write, read in one go and compared side by side either
  // side of it - because which term a stale write lands on is not obvious from reading
  // the code and turned out not to be the one this row first asserted on. `retime.rate`
  // cannot see it: the restore puts the *control* back too, so the release re-applies
  // the rate the document already has, and `t * (began / rate)` off a snapshot taken at
  // `began` is exactly `t` again - a no-op by arithmetic rather than by the fix. What
  // does move is the stack, because a release that thinks it changed something commits.
  // `keyTimes` is the one term below that can tell a gesture rescaling the document that
  // is open from one rescaling a snapshot of the document that was. Everything else here
  // is rate-covariant and cannot: `t * (began / rate)` off a snapshot taken at `began` is
  // exactly `t` again, so a stale rescale of the *same* document is a no-op by arithmetic
  // and rate, cuts and undo depth all agree either way - measured, after the first
  // version of these rows came back green on a mutated build for that reason. What does
  // not survive is a takeover that *replaces* the key objects, which undo does by
  // deserialising new ones: the stale snapshot then holds references to orphans and
  // writes into nothing while the ruler rescales under the live keys.
  //
  // Written out here rather than beside the field, because a backtick inside a template
  // literal ends it - a comment carrying prose about `rate` closed this expression and
  // the file stopped parsing.
  const snap = () => page.evaluate(`(() => ({
    rate: __kinect.timeline.retime.rate,
    depth: __kinect.keyframes.undo.depth(),
    lanes: JSON.stringify(__kinect.keyframes.lanes()),
    range: JSON.stringify(__kinect.editor.clipRange()),
    keyTimes: (__kinect.keyframes.project().look.tracks.bloom ?? []).map((k) => k.t.toFixed(3)).join(' '),
  }))()`);

  const heldGesture = async ({ interrupt }) => {
    await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
    await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [{ t: 2, value: 0.2 }, { t: 6, value: 0.9 }] })`);
    await settle();
    // A committed baseline at 1x, so what the undo below restores is stated here rather
    // than inherited from whatever the section left on the stack.
    await page.evaluate('__kinect.keyframes.undo.commit()');
    await driveRate(2);
    const committed = await page.evaluate('__kinect.timeline.retime.rate');
    await page.evaluate('__kinect.timeline.transport().play()');
    await new Promise((r) => setTimeout(r, 250));
    const wasPlaying = await page.evaluate('__kinect.timeline.transport().playing');
    await page.evaluate(`(() => {
      const el = document.getElementById('tRate');
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      el.value = String(__kinect.editor.rateSlider.toValue(0.5));
      el.dispatchEvent(new Event('input'));
    })()`);
    await settle();
    const held = await page.evaluate('__kinect.timeline.retime.rate');
    if (interrupt) {
      await page.evaluate('__kinect.keyframes.undo.pop()');
      await settle();
    }
    const afterInterrupt = await page.evaluate('__kinect.timeline.retime.rate');
    const before = await snap();
    // One more slider event after the takeover, which is the half the release guard
    // never covered: `applyRate` runs per `input` and had nothing to check. The rate is
    // deliberately a third value, so what lands can be told apart from both the rate the
    // gesture began in and the rate the undo restored.
    if (interrupt === 'then-more-input') {
      await page.evaluate(`(() => {
        const el = document.getElementById('tRate');
        el.value = String(__kinect.editor.rateSlider.toValue(0.8));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await settle();
    }
    await page.evaluate(`document.getElementById('tRate')
      .dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))`);
    await settle();
    // The resume rides a seek's pre-roll, so it arrives some frames after the release.
    // Polled rather than read once, and the poll runs on both arms so neither is given a
    // different amount of time to be wrong in. Six seconds rather than two, because the
    // seek is not always the cheap one.
    //
    // Six is not enough for `rate-holds-cuts` and that was measured rather than waited
    // out: with the cuts left unrescaled the playhead ends up outside the range the
    // release seeks into, and the take does not come back at all. So this row reddens on
    // that mutation as well as on its own, which is recorded here rather than tuned away
    // - a take that will not resume after a speed change is a true thing to say about
    // that build, and the eleventh red row beside its ten is the shape of a consequence
    // rather than of a second bug.
    for (let i = 0; i < 60 && !(await page.evaluate('__kinect.timeline.transport().playing')); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const out = {
      committed, wasPlaying, held, afterInterrupt, before,
      after: await snap(),
      playing: await page.evaluate('__kinect.timeline.transport().playing'),
    };
    await page.evaluate('__kinect.timeline.transport().pause()');
    await settle();
    return out;
  };

  const uninterrupted = await heldGesture({ interrupt: false });
  check(uninterrupted.wasPlaying && uninterrupted.held === 0.5 && uninterrupted.after.rate === 0.5,
    'a speed gesture held over a key press and released applies the rate it was left at',
    `committed ${uninterrupted.committed}x, held ${uninterrupted.held}x, released ${uninterrupted.after.rate}x`);
  check(uninterrupted.playing,
    '  and puts a take that was running back, which is what the interrupted arm below must not do',
    `playing ${uninterrupted.playing}`);

  // Undo pops the *previous* committed state, which is the 1x baseline above rather
  // than the 2x the gesture began in - so the number this asserts is 1, and it differs
  // from both the 2 the gesture began in and the 0.5 the slider is left holding, which
  // is what makes the two rows below able to see a release that acted.
  const interrupted = await heldGesture({ interrupt: true });
  check(interrupted.afterInterrupt === 1,
    '  and an undo arriving mid-gesture puts the document back, which is the state under test',
    `began ${interrupted.committed}x, held ${interrupted.held}x, undo restored ${interrupted.afterInterrupt}x`);
  const wrote = Object.keys(interrupted.before)
    .filter((k) => interrupted.before[k] !== interrupted.after[k]);
  check(wrote.length === 0,
    '  so the release writes nothing over the document that took the transport',
    wrote.length
      ? wrote.map((k) => `${k} ${interrupted.before[k]} -> ${interrupted.after[k]}`).join(', ')
      : `rate ${interrupted.after.rate}x, undo depth ${interrupted.after.depth}, cuts and lanes unmoved`);
  check(interrupted.playing === false,
    '  and does not resume a take the thing that took the transport had paused',
    `playing ${interrupted.playing}`);

  // And the other half of the same door: a slider event arriving *after* the takeover.
  // Guarding the release alone left this open, because `applyRate` runs per `input` and
  // had nothing to check - so the event rescaled a snapshot of a document that was no
  // longer open. The gesture is dropped at `takeTransport` now, so this event simply
  // starts a fresh one on the document that is, and the keys move because they are the
  // keys it is holding.
  const continued = await heldGesture({ interrupt: 'then-more-input' });
  check(continued.after.rate === 0.8,
    '  a slider event after the takeover still moves the speed, rather than going dead',
    `undo left ${continued.afterInterrupt}x, the event left ${continued.after.rate}x`);
  const wantTimes = continued.before.keyTimes.split(' ')
    .map((t) => (Number(t) * (continued.afterInterrupt / 0.8)).toFixed(3)).join(' ');
  check(continued.after.keyTimes === wantTimes,
    '  and rescales the keys the open document has, not the ones the old snapshot held',
    `${continued.before.keyTimes} -> ${continued.after.keyTimes}, wanted ${wantTimes}`);

  // Put the document, the stack, the transport and the focus back, so section 5 does not
  // plant its keys into a clip this block left at half speed with a take running under
  // it. The focus is the one that bit: the gesture has to be begun on the control the
  // way a keyboard user begins it, and leaving it there left `#tRate` focused - an
  // `INPUT`, which the window handler's typing guard skips - so section 5's Delete
  // press reached nothing and its row read as a missing feature.
  await focusStage();
  await page.evaluate('__kinect.timeline.transport().pause()');
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate('__kinect.keyframes.setTracks({})');
  await page.evaluate('__kinect.keyframes.undo.begin()');
  await page.evaluate('__kinect.timeline.transport().seek(0)');
  await settle();

  // =====================================================================
  console.log('\n[5] keys can be removed, and ease can be shaped');
  // =====================================================================
  const plant = async (spec) => {
    await page.evaluate(`__kinect.keyframes.setTracks(${JSON.stringify(spec)})`);
    await settle();
  };
  const clickKey = async (owner, i) => {
    const b = await page.locator(`.tlane[data-owner=${owner}] .tkey`).nth(i).boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await new Promise((r) => setTimeout(r, 200));
    return b;
  };

  await plant({ bloom: [{ t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 }] });
  await clickKey('bloom', 1);
  check(Boolean(await page.evaluate('__kinect.editor.selection()')), 'clicking a key selects it');
  await page.keyboard.press('Delete');
  await settle();
  check(await keyCount('bloom') === 2, 'Delete removes the selected key', `${await keyCount('bloom')} keys left`);

  await plant({ bloom: [{ t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 }] });
  await clickKey('bloom', 1);
  await page.locator('#tDeleteKey').click();
  await settle();
  check(await keyCount('bloom') === 2, 'and so does the delete button, for anybody without a keyboard',
    `${await keyCount('bloom')} keys left`);

  // Two clicks inside the double-click window rather than `page.mouse.dblclick`, and
  // the distinction is load-bearing. The first click rebuilds the lane, so the second
  // lands on a different element and the browser dispatches `dblclick` at their common
  // ancestor - which is why this gesture is tracked by key identity in `pointerdown`
  // rather than by a `dblclick` listener.
  await plant({ bloom: [{ t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 }] });
  const dbl = await page.locator('.tlane[data-owner=bloom] .tkey').nth(1).boundingBox();
  await page.mouse.click(dbl.x + dbl.width / 2, dbl.y + dbl.height / 2);
  await page.mouse.click(dbl.x + dbl.width / 2, dbl.y + dbl.height / 2);
  await settle();
  check(await keyCount('bloom') === 2, 'and a double click on a key removes it', `${await keyCount('bloom')} keys left`);

  // The retime origin. A delete gesture is what made this reachable, so the rule that
  // protects it is asserted from the gesture rather than from the function.
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [
    { t: 0, value: 0 }, { t: 10, value: 8 }, { t: 20, value: 20 } ] })`);
  await settle();
  await page.evaluate(`__kinect.editor.select('retime', 0)`);
  await settle();
  await page.keyboard.press('Delete');
  await settle();
  const retimeKeys = () => page.evaluate('__kinect.timeline.retime.keys.length');
  check(await retimeKeys() === 3, 'the retime origin will not delete while keys follow it',
    `${await retimeKeys()} keys`);
  // There was a row here reading the refusal off the message chip - "and it says why
  // rather than doing nothing quietly". The chip is gone and `removeRetimeKey` returns
  // `false` and says nothing, so the row went with it rather than being re-pointed at the
  // console: what is left to assert is that the key survives, which the row above does,
  // and the two rows below saying the same delete works once the followers have gone are
  // what keep this from passing on a build where the gesture is broken outright.
  await page.evaluate(`__kinect.editor.select('retime', 2)`);
  await page.keyboard.press('Delete');
  await settle();
  await page.evaluate(`__kinect.editor.select('retime', 1)`);
  await page.keyboard.press('Delete');
  await settle();
  check(await retimeKeys() === 0, 'and the curve empties once the last one after it has gone',
    `${await retimeKeys()} keys`);

  // Ease presets, each pressed and each read back. Five rows rather than one, because
  // a cumulative row cannot say which preset stopped writing.
  //
  // **Two of these reach past the selected key and one of those two reaches backwards**,
  // so what a row reads is part of what it asserts. `nextIn` is `hold` flattening the far
  // end of the segment it holds across. `firstOut` and `lastIn` are `ends`, which is
  // about the *track* rather than about the selection - it shapes the move's departure
  // and its arrival whichever key happens to be selected - so this table names key 0 as
  // well, and the fixtures below are three keys deep, which makes key 2 the last one.
  //
  // `keepsSelected` is the other half of that claim and the half a naive row would miss:
  // `ends` has to leave the keys between the two ends exactly as it found them, because
  // a preset that quietly smoothed an interior key would bring the camera to a halt as
  // it passed - which is the documented trap this preset exists to route around. The
  // fixtures all start bent, so "unchanged" here is a positive statement about a shape
  // nothing else in the table writes.
  const EXPECTED = {
    linear: { out: [[1 / 3, 1 / 3]], in: [[2 / 3, 2 / 3]] },
    in: { in: [[0.58, 1]] },
    out: { out: [[0.42, 0]] },
    smooth: { out: [[0.42, 0]], in: [[0.58, 1]] },
    glide: { out: [[0.2, 0], [0.4, 0]], in: [[0.6, 1], [0.8, 1]] },
    ends: {
      firstOut: [[0.2, 0], [0.4, 0]],
      lastIn: [[0.6, 1], [0.8, 1]],
      keepsSelected: true,
    },
    hold: { out: [[1, 0]], nextIn: [[1, 0]] },
  };
  const presetNames = await page.evaluate('__kinect.editor.easePresets()');
  check(presetNames.length === Object.keys(EXPECTED).length,
    'the preset row offers exactly the presets this file knows', presetNames.join(', '));

  // **One fixture per kind that claims to be easable, enumerated off the page's own
  // table.** This used to press the five presets on `bloom` and nothing else, while
  // `covered()` credited every `data-ease` button with "section 5 presses all five" -
  // true of scalars and, the day the camera track gained handles, a coverage claim
  // nothing satisfied for the new kind. Asking `easedKinds()` means the claim is true
  // by construction, and a fourth kind added next year fails the row below until
  // somebody gives it a fixture, which is the right answer rather than a nuisance:
  // an untested kind should be loud, not absent.
  //
  // Every key starts bent, and `linear` is why. A key created plain already carries the
  // linear handles, so pressing `linear` on it agrees with a build that writes nothing
  // at all - the row would be green against a preset row that had been disconnected.
  // Measured: `--mutate ease-preset-ignored` fired four of the five preset rows and
  // left this one passing. Starting from a shape none of the five produces gives every
  // preset something to undo.
  const BENT = { easeOut: [[0.9, 0.1]], easeIn: [[0.1, 0.9]] };
  const KIND_FIXTURES = {
    scalar: {
      owner: 'bloom',
      keys: [
        { t: 1, value: 0.2, ...BENT },
        { t: 5, value: 0.9, ...BENT },
        { t: 9, value: 0.3, ...BENT },
      ],
      // Inside the segment the selected key's `easeOut` shapes, and inside the one it
      // does not - see the drag rows below for why the pair matters.
      inside: 7,
      outside: 3,
      read: (v) => v,
    },
    pose: {
      owner: 'camera',
      // Three poses that differ in every channel, so `segmentHasShape` has something to
      // find whichever term a broken build drops. Unevenly spaced for the same reason
      // `keyframe-check`'s own path is.
      keys: [[-1.1, 0.9, 50], [0.2, 1.15, 44], [1.3, 0.8, 58]].map(([x, z, fov], i) => ({
        t: 1 + i * 4,
        value: { position: [x, 0.35, z], quaternion: [0, 0, 0, 1], fov },
        ...BENT,
      })),
      inside: 7,
      outside: 3,
      read: (v) => v.position[0],
    },
  };
  const easedKinds = await page.evaluate('__kinect.editor.easedKinds()');
  const unfixtured = easedKinds.filter((k) => !KIND_FIXTURES[k]);
  check(unfixtured.length === 0,
    'every kind the page declares easable has a fixture here, so a kind added later is asked about by existing',
    unfixtured.length ? `nothing drives ${unfixtured.join(', ')}` : `${easedKinds.join(', ')} all driven`);
  // **And the reverse inclusion, which is the half that stops this section being
  // circular.** The row above enumerates the page's own declaration and then loops over
  // it, so both loops take their coverage from the thing under test: flipping `eases`
  // to false on `pose` shrinks `easedKinds()` to `['scalar']`, every pose row below
  // silently stops existing, that row passes because nothing is unfixtured, and
  // `keyframe-check` stays green too because `poseAt` never consults the table. One
  // token would have put the reported bug back - preset buttons dead on a camera key -
  // with the whole suite green. This table is the independent statement of which kinds
  // must ease, and it is in a file the page cannot edit.
  const undeclared = Object.keys(KIND_FIXTURES).filter((k) => !easedKinds.includes(k));
  check(undeclared.length === 0,
    'and every kind this file has a fixture for is still declared easable, so the page cannot shrink its own coverage',
    undeclared.length ? `the page no longer eases ${undeclared.join(', ')}` : `${Object.keys(KIND_FIXTURES).join(', ')} all declared`);

  for (const kind of easedKinds.filter((k) => KIND_FIXTURES[k])) {
    const fx = KIND_FIXTURES[kind];
    for (const name of presetNames) {
      await plant({ [fx.owner]: fx.keys });
      await page.evaluate(`__kinect.editor.select('${fx.owner}', 1)`);
      await settle();
      // **Asked before it is pressed, and this is not defensive coding.** Playwright's
      // `click` waits for a control to become actionable, so pressing a *disabled*
      // button does not fail - it hangs for the full 30s timeout and takes the whole
      // run down with it. Measured: `--mutate ease-gate-hardcodes-scalar` shuts the
      // preset row for pose keys, and the first version of this loop reported
      // `DID NOT RUN` with **zero** failed assertions, which is a crash wearing the
      // shape of a catch - and by this file's own verdict block, exit 2 rather than
      // exit 1. A check has to survive the fault it checks for, or a caught mutation
      // reads as an untested one; the dead row is the finding, so it is read rather
      // than walked into.
      const live = await page.evaluate(
        `document.querySelector('#tEase button[data-ease=${name}]').disabled`,
      ) === false;
      if (live) {
        await page.locator(`#tEase button[data-ease=${name}]`).click();
        await settle();
      }
      const got = await page.evaluate(`__kinect.editor.easeOf('${fx.owner}', 1)`);
      const next = await page.evaluate(`__kinect.editor.easeOf('${fx.owner}', 2)`);
      const first = await page.evaluate(`__kinect.editor.easeOf('${fx.owner}', 0)`);
      const want = EXPECTED[name];
      // Compared point by point over the whole list, because a preset names a *degree*
      // as well as a shape now - `glide` writing only its first control point would
      // leave a cubic wearing a quintic's first handle, which a comparison of element
      // zero alone would have called a pass.
      const sameList = (a, b) => Array.isArray(a) && a.length === b.length
        && a.every((p, i) => near(p[0], b[i][0], 1e-9) && near(p[1], b[i][1], 1e-9));
      const okOut = !want.out || sameList(got.easeOut, want.out);
      const okIn = !want.in || sameList(got.easeIn, want.in);
      const okNext = !want.nextIn || sameList(next.easeIn, want.nextIn);
      const okFirst = !want.firstOut || sameList(first.easeOut, want.firstOut);
      const okLast = !want.lastIn || sameList(next.easeIn, want.lastIn);
      // The selected key untouched, for the presets that are about the track. Compared
      // against the bend every fixture key is planted with rather than against a
      // remembered read, so this cannot be satisfied by the press having done nothing
      // at all - `okFirst` and `okLast` are what say it did something.
      const okKept = !want.keepsSelected
        || (sameList(got.easeOut, BENT.easeOut) && sameList(got.easeIn, BENT.easeIn));
      check(live && okOut && okIn && okNext && okFirst && okLast && okKept,
        `the "${name}" preset writes the handles it names on a ${kind} key`,
        live
          ? `out ${JSON.stringify(got.easeOut)} in ${JSON.stringify(got.easeIn)}`
            + (want.nextIn ? ` next-in ${JSON.stringify(next.easeIn)}` : '')
            + (want.firstOut ? ` first-out ${JSON.stringify(first.easeOut)}` : '')
            + (want.lastIn ? ` last-in ${JSON.stringify(next.easeIn)}` : '')
          : `the preset row is dead for a ${kind} key, so nothing could be pressed`);
    }
  }

  // **The point count, which is the degree of the segments either side of a key.**
  //
  // `+pt` is Bezier degree elevation and the claim it makes is unusual for a control:
  // pressing it changes *nothing* about the picture. That is what makes it safe to
  // offer - a press that handed over another handle and also moved the camera would be
  // two edits wearing one button, and the one nobody asked for is the one that ruins a
  // take. So the row below reads the rendered curve on both sides of the press and
  // requires it to be the same curve, which is the opposite of what a control is
  // usually asked to prove and the only thing worth asserting here.
  //
  // Sampled through `valueAt` rather than through the handle numbers, because the
  // handles are *supposed* to move: every control point shifts to the position that
  // keeps the curve where it was. A row comparing handles would fail against a correct
  // build and pass against one that appended a point and left the others alone, which
  // is precisely the wrong implementation this is here to catch.
  await plant({ bloom: [{ t: 1, value: 0.2, ...BENT }, { t: 5, value: 0.9, ...BENT }] });
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  const AT = [1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5];
  const sampleBloom = () => page.evaluate(
    `${JSON.stringify(AT)}.map((t) => globalThis.__kinect.keyframes.valueAt('bloom', t))`,
  );
  const pointsOn = (i) => page.evaluate(
    `(() => { const e = __kinect.editor.easeOf('bloom', ${i}); return [e.easeOut.length, e.easeIn.length]; })()`,
  );
  const curveBeforeGrow = await sampleBloom();
  const countBeforeGrow = await pointsOn(0);
  await page.locator('#tAddPoint').click();
  await settle();
  const countAfterGrow = await pointsOn(0);
  const curveAfterGrow = await sampleBloom();
  const grewBy = countAfterGrow[0] - countBeforeGrow[0];
  check(grewBy === 1, 'the add-point control grows the selected key\'s outgoing side by one',
    `easeOut went from ${countBeforeGrow[0]} control points to ${countAfterGrow[0]}`);
  const elevationDrift = Math.max(...curveAfterGrow.map((v, i) => Math.abs(v - curveBeforeGrow[i])));
  check(elevationDrift < 1e-9,
    'and the curve it grew is the same curve, which is the whole reason the control can be offered',
    `worst departure over ${AT.length} samples inside the segment: ${elevationDrift.toExponential(3)}`);
  // And the handles really did move, so the row above is a statement about elevation
  // rather than about a press that did nothing at all. Without this, a `+pt` wired to
  // no-op would satisfy both rows above except the count - and a count is the one thing
  // a broken implementation finds easiest to get right.
  const grownHandles = await page.locator('.tlane[data-owner=bloom] .thandle').count();
  check(grownHandles === countAfterGrow[0] + countAfterGrow[1] - 1,
    'and the lane draws one handle per control point, so the new one can be reached',
    `${grownHandles} handles for ${countAfterGrow[0]} out and ${countAfterGrow[1]} in on the first key`);

  await page.locator('#tDropPoint').click();
  await settle();
  const countAfterDrop = await pointsOn(0);
  check(countAfterDrop[0] === countBeforeGrow[0],
    'and the drop-point control takes it back off again',
    `easeOut went from ${countAfterGrow[0]} control points to ${countAfterDrop[0]}`);
  // The floor, pressed into. A segment with no control points is not a cubic with fewer
  // handles, it is a curve this file's own evaluator has no shape for.
  for (let i = 0; i < 4; i++) {
    if (await page.evaluate(`document.getElementById('tDropPoint').disabled`)) break;
    await page.locator('#tDropPoint').click();
    await settle();
  }
  const floored = await pointsOn(0);
  check(floored[0] === 1 && await page.evaluate(`document.getElementById('tDropPoint').disabled`),
    'and it stops at one point a side rather than emptying the handle',
    `easeOut holds ${floored[0]}, and the control is ${await page.evaluate(`document.getElementById('tDropPoint').disabled`) ? 'dead' : 'still live'}`);

  // **The second control point, dragged.** Every other handle gesture in this file grabs
  // the first `.thandle` in DOM order, which is `easeOut[0]` - index 0, the case that
  // shipped before a handle was a list. So the indexed drag and `handleSpan` had nothing
  // asking about them: a `handleSpan` that ignored its index entirely, or a clamp still
  // written against the unit range, would pass every row above. What makes index 1
  // different is that its neighbours are not the segment's ends, so the clamp has a
  // narrower box to hold it in and that box is the thing under test.
  //
  // Planted through `ends` first, and that is the finding rather than tidiness. `BENT` is
  // `easeOut [0.9, ...]` against `easeIn [0.1, ...]`, whose control abscissae already
  // descend - a legal cubic, because descending control x is sufficient for a fold and
  // never necessary, and that one bottoms out at a derivative of 0.15. `elevate` carries
  // the crossing across faithfully, so a span asserted from an inherited crossing is a
  // row about the fixture rather than about the clamp.
  //
  // **`ends` rather than `glide`, because a segment's polygon is owned by two keys.**
  // `glide` writes the selected key only, so pressing it on key 0 leaves key 1's `easeIn`
  // at BENT and the segment reads 0, 0.2, 0.4, 0.1, 1 - still crossed, and crossed in a
  // way that looks fixed. `ends` writes the departure and the arrival, which is the whole
  // polygon: 0, 0.2, 0.4, 0.6, 0.8, 1.
  // **Planted mid-clip, and that is not arbitrary either.** Section 3 leaves the clip's
  // in-marker parked over the head of the strip, and a `.tcut` is a full-height element
  // that takes the press before a handle sitting under it ever sees one - so the same
  // gesture that works on a fresh page silently lands on the marker here. The first
  // version of this row put its keys at 1s and 5s and read a handle that had never been
  // touched, which is a clamp row greened by a press that hit something else entirely.
  // `document.elementFromPoint` at the press coordinate is how that was found and is the
  // thing to reach for when a synthetic drag does nothing.
  await plant({ bloom: [{ t: 30, value: 0.2, ...BENT }, { t: 38, value: 0.9, ...BENT }] });
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  await page.locator('#tEase button[data-ease=ends]').click();
  await page.locator('#tAddPoint').click();
  await settle();
  const twoPoints = await page.evaluate(`__kinect.editor.easeOf('bloom', 0)`);
  // The handles are drawn `easeOut` first and in index order, so the lane's second
  // `.thandle` is `easeOut[1]` - the one whose x is fenced by its two neighbours rather
  // than by 0 and 1.
  const handles = page.locator('.tlane[data-owner=bloom] .thandle');
  const first = await handles.nth(0).boundingBox();
  const second = await handles.nth(1).boundingBox();
  const dragY = second.y + second.height / 2;
  await page.mouse.move(second.x + second.width / 2, dragY);
  await page.mouse.down();
  // **Nothing is awaited between the press and the throw, and that is load-bearing.** The
  // press captures the pointer on the handle element, and `settle()` lets a lane rebuild
  // run - which replaces that element, so every later move is delivered to a node no
  // longer in the document and the handle sits exactly where it started. A row reading
  // the handle back then reports a clamp holding when nothing was ever dragged. Measured:
  // with a settle here the point stayed at 0.3333 against a neighbour at 0.1667; without
  // one it lands on the neighbour.
  //
  // Aimed past the point before it rather than at a fixed pixel offset. The segment is
  // four seconds of a seventy-five second clip, so it is a few dozen pixels wide and a
  // round "drag 600px left" lands at a negative page coordinate that goes undelivered -
  // the same failure wearing the other hat.
  await page.mouse.move(first.x - 24, dragY, { steps: 8 });
  await page.mouse.up();
  await settle();
  const afterPointDrag = await page.evaluate(`__kinect.editor.easeOf('bloom', 0)`);
  check(afterPointDrag.easeOut.length === twoPoints.easeOut.length
    && afterPointDrag.easeOut[0][0] === twoPoints.easeOut[0][0],
    'dragging the second control point leaves the first one where it was, so the drag found its own index',
    `first ${JSON.stringify(afterPointDrag.easeOut[0])}, second ${JSON.stringify(afterPointDrag.easeOut[1])}`);
  // **Asserted on where the handle landed rather than on how far the curve moved**, and
  // that is the fixture rather than a preference. Both of these control points sit at an
  // ordinate of 0, so sliding one along x while its neighbour holds the same y is a
  // change the *value* curve barely registers - a "the curve moved" row would be asking
  // this drag for evidence it cannot produce. Landing exactly on the neighbour says both
  // things at once: the gesture was delivered, and the thing that stopped it was the
  // point before it rather than the segment start, which is 0 and is where the clamp
  // this replaced would have put it.
  const landed = afterPointDrag.easeOut[1][0];
  const neighbour = afterPointDrag.easeOut[0][0];
  check(landed !== twoPoints.easeOut[1][0] && Math.abs(landed - neighbour) < 1e-9,
    'and it stops on the point before it rather than at the segment start, because the timing '
    + 'curve has to stay single-valued in time and a crossed pair folds it',
    `dragged from ${twoPoints.easeOut[1][0].toFixed(4)} to ${landed.toFixed(4)}, `
    + `against a neighbour at ${neighbour.toFixed(4)}`);

  // **The two-key move, which is the shape the reported defect arrived as.** Every ease
  // fixture above is three keys deep, and on a two-key track `ends` writes both of its
  // handles onto the *same* segment - `keys.length - 2` is 0, so the departure and the
  // arrival are the two ends of one span. That is the arithmetic most likely to be got
  // wrong by an off-by-one and the one case no other row here visits.
  await plant({ bloom: [{ t: 1, value: 0.2, ...BENT }, { t: 6, value: 1.4, ...BENT }] });
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  await page.locator('#tEase button[data-ease=ends]').click();
  await settle();
  const pairFirst = await page.evaluate(`__kinect.editor.easeOf('bloom', 0)`);
  const pairLast = await page.evaluate(`__kinect.editor.easeOf('bloom', 1)`);
  const glideOut = JSON.stringify([[0.2, 0], [0.4, 0]]);
  const glideIn = JSON.stringify([[0.6, 1], [0.8, 1]]);
  check(JSON.stringify(pairFirst.easeOut) === glideOut && JSON.stringify(pairLast.easeIn) === glideIn,
    'on a two-key move `ends` shapes both ends of the one segment there is',
    `first-out ${JSON.stringify(pairFirst.easeOut)}, last-in ${JSON.stringify(pairLast.easeIn)}`);

  // **The retime is refused, and the reason is a proof rather than a preference.**
  // `assertMonotonic` argues that a handle anywhere in the unit box cannot run source
  // time backwards, and that argument is about a *cubic* - a quintic with ordinates
  // 0,1,0,1,0,1, every one inside the box, oscillates. So the retime keeps one control
  // point a side, and the place that is enforced is here, at the control.
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [
    { t: 0, value: 0 }, { t: 6, value: 4 }, { t: 12, value: 11 } ] })`);
  await page.evaluate(`__kinect.editor.select('retime', 1)`);
  await settle();
  const retimePoints = await page.evaluate(`(() => {
    const add = document.getElementById('tAddPoint').disabled;
    const drop = document.getElementById('tDropPoint').disabled;
    const smooth = document.querySelector('#tEase button[data-ease=smooth]').disabled;
    return { add, drop, smooth };
  })()`);
  check(retimePoints.add && retimePoints.drop && !retimePoints.smooth,
    'both point controls are dead on a retime key while the ordinary presets stay live, '
    + 'because the monotonicity proof the retime rests on is a proof about a cubic',
    `add ${retimePoints.add ? 'dead' : 'LIVE'}, drop ${retimePoints.drop ? 'dead' : 'LIVE'}, `
    + `smooth ${retimePoints.smooth ? 'DEAD' : 'live'}`);

  // The flat-segment rule. A segment whose two keys hold the same value renders the
  // same value whatever its handles say - so a handle there is a control that moves
  // and changes nothing, which is worse than an absent one.
  await plant({ bloom: [{ t: 1, value: 0.5 }, { t: 5, value: 0.5 }, { t: 9, value: 0.9 }] });
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  const flatHandles = await page.locator('.tlane[data-owner=bloom] .thandle').count();
  check(flatHandles === 0, 'a key whose only segment is flat gets no ease handle at all',
    `${flatHandles} handles`);
  await page.evaluate(`__kinect.editor.select('bloom', 1)`);
  await settle();
  const mixedHandles = await page.locator('.tlane[data-owner=bloom] .thandle').count();
  check(mixedHandles === 1, 'and a key between a flat and a shaped segment gets exactly the shaped one',
    `${mixedHandles} handles`);
  check(await page.evaluate(`document.querySelector('#tEase button[data-ease=linear]').disabled`) === false,
    'the preset row is live for that key, because one of its sides can be shaped');
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  check(await page.evaluate(`document.querySelector('#tEase button[data-ease=linear]').disabled`) === true,
    'and goes dead for the key that has nothing to shape, rather than writing into nothing');

  // And a handle that does exist still moves the curve - asked of every easable kind,
  // for the reason the preset loop above is. The pose arm is the one that would have
  // caught the shape this repo already shipped once on scalars: a handle that draws,
  // drags and writes a number nothing reads. `segmentHasShape` answered `NaN > 1e-9`
  // for every camera segment before it took the kind, which is `false` - so a pose
  // lane would have drawn no handle at all and the whole feature would have been a
  // preset row with nothing under it.
  for (const kind of easedKinds.filter((k) => KIND_FIXTURES[k])) {
    const fx = KIND_FIXTURES[kind];
    await plant({ [fx.owner]: fx.keys.map(({ easeOut, easeIn, ...rest }) => rest) });
    await page.evaluate(`__kinect.editor.select('${fx.owner}', 1)`);
    await settle();
    // **The first handle drawn on a key is its `easeOut`**, which shapes the segment
    // *after* it - `drawLane` walks `['easeOut', 'easeIn']` in that order. So the curve
    // is sampled at 7s, inside 5s..9s, and not at 3s. Sampling at 3s is what this row
    // did first and it failed against a working build: the handle had moved, the curve
    // it shapes had moved, and the probe was sitting in the neighbouring segment where
    // the answer is the same either way. That is `docs/instruments.md`'s "place a probe
    // where its answer would be different" arriving one more time.
    //
    // Both samples are kept, which makes the row say more than it used to: the handle
    // shapes its own segment *and leaves its neighbour alone*, which is two claims a
    // single sample cannot separate.
    // Counted before it is reached for, for the reason the preset loop above states: a
    // build with no handle to drag has to redden these rows rather than throw out of the
    // run. `--mutate pose-segments-never-shaped` is exactly that build - it puts back the
    // `NaN` the old subtraction returned for a pose, so the lane draws nothing - and a
    // `boundingBox()` of null dereferenced is a crash, which this file reports as
    // DID NOT RUN and exit 2 rather than as the catch it actually is.
    const drawn = await page.locator(`.tlane[data-owner=${fx.owner}] .thandle`).count();
    const hb = drawn > 0
      ? await page.locator(`.tlane[data-owner=${fx.owner}] .thandle`).first().boundingBox()
      : null;
    check(hb !== null && hb.width >= 10 && hb.height >= 10, `a ${kind} ease handle is big enough to hit`,
      hb ? `${hb.width}x${hb.height}px` : `no handle drawn on the ${kind} lane at all`);
    const at = (t) => page.evaluate(`__kinect.keyframes.valueAt('${fx.owner}', ${t})`).then(fx.read);
    const easeBefore = await page.evaluate(`__kinect.editor.easeOf('${fx.owner}', 1)`);
    const ownBefore = await at(fx.inside);
    const neighbourBefore = await at(fx.outside);
    if (hb) {
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move(hb.x + hb.width / 2 - 40, hb.y + hb.height / 2 - 20, { steps: 5 });
      await page.mouse.up();
      await settle();
    }
    const easeAfter = await page.evaluate(`__kinect.editor.easeOf('${fx.owner}', 1)`);
    const ownAfter = await at(fx.inside);
    const neighbourAfter = await at(fx.outside);
    check(JSON.stringify(easeBefore.easeOut) !== JSON.stringify(easeAfter.easeOut),
      `dragging a ${kind} handle rewrites it`,
      `easeOut ${JSON.stringify(easeBefore.easeOut)} -> ${JSON.stringify(easeAfter.easeOut)}`);
    check(Math.abs(ownAfter - ownBefore) > 1e-4,
      `  and the ${kind} value inside the segment it shapes follows, which is the only thing a handle is for`,
      `${ownBefore.toFixed(4)} -> ${ownAfter.toFixed(4)} at ${fx.inside}s`);
    check(Math.abs(neighbourAfter - neighbourBefore) < 1e-9,
      '  and the segment on the other side of the key does not move',
      `${neighbourBefore.toFixed(4)} -> ${neighbourAfter.toFixed(4)} at ${fx.outside}s`);
  }

  // **A pose handle stays inside the box, however hard it is dragged.** A scalar's may
  // leave it - a value that swings past its key and comes back is an ordinary creative
  // choice - and the pose lane inherited that band without anybody noticing what it
  // meant there. Its axis is already a fraction of the segment, so a handle above the
  // box asks `hermite` for a fraction past 1, and `hermite` obliges by continuing the
  // segment's own cubic past the key: the camera overshoots the pose it was keyed at
  // and swings back. That is precisely the thing easing a camera is promised not to do,
  // in `poseAt`'s comment and in `docs/reference.md` in as many words, so the promise
  // needs a row rather than a sentence.
  //
  // Dragged well past the lane's own height, because the clamp is only interesting at
  // the extreme - a gentle drag lands inside the box whether or not anything clamps.
  await plant({ camera: KIND_FIXTURES.pose.keys.map(({ easeOut, easeIn, ...rest }) => rest) });
  await page.evaluate(`__kinect.editor.select('camera', 1)`);
  await settle();
  // Counted before it is reached for. `.first().boundingBox()` on a lane with no handle
  // does not fail, it waits the full 30s and takes the run down with it - which this
  // row did against `--mutate pose-segments-never-shaped`, reporting DID NOT RUN and
  // exit 2 where eight clean reds were owed. That is the same trap the preset loop and
  // the drag rows above already carry a guard for, walked into once more by a row added
  // after them, which is the argument for the guard being the house pattern rather than
  // a note in one place.
  const poseHandles = await page.locator('.tlane[data-owner=camera] .thandle').count();
  const poseHandle = poseHandles > 0
    ? await page.locator('.tlane[data-owner=camera] .thandle').first().boundingBox()
    : null;
  if (poseHandle) {
    await page.mouse.move(poseHandle.x + poseHandle.width / 2, poseHandle.y + poseHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(poseHandle.x + poseHandle.width / 2, poseHandle.y - 400, { steps: 6 });
    await page.mouse.up();
    await settle();
  }
  const dragged = await page.evaluate(`__kinect.editor.easeOf('camera', 1)`);
  check(poseHandle !== null && dragged.easeOut[0][1] <= 1 + 1e-9 && dragged.easeOut[0][1] >= -1e-9,
    'a pose handle dragged far past the lane stays inside the unit box, so the camera cannot overshoot its own key',
    // The two ways this fails say different things and the detail has to as well. Under
    // `pose-segments-never-shaped` there is no handle to drag, so the y sits at its
    // untouched default - and a bare number here read as "0.3333 is outside the box",
    // which is a row blaming the clamp for a lane that drew nothing.
    poseHandle === null
      ? `no handle on the pose lane to drag, so the clamp was never exercised (y still ${dragged.easeOut[0][1].toFixed(4)})`
      : `easeOut y ${dragged.easeOut[0][1].toFixed(4)} after a 400px drag`);

  // **The world half of the ease: the beads on the path.** `pathPoints` samples
  // `poseAt` at equal intervals of program time, so the gaps between consecutive
  // samples *are* the camera's speed, and drawing them puts back what the stroke that
  // joins them throws away - the timing, visible as spacing, where a camera move has
  // always been judged.
  //
  // **The first version of this row measured pixels and was NOT CAUGHT**, which is
  // worth recording because it looked like the stronger test. It diffed the chrome
  // canvas between a linear and an eased build of one path, on the reasoning that the
  // route is unchanged so the stroke is unchanged and every moved pixel is a bead.
  // The reasoning is wrong: `strokePolyline` joins the samples, easing moves where the
  // samples fall along the curve, so the chord distribution changes and the line
  // redraws by itself. Against a build whose bead loop drew nothing at all the row
  // still read 312 moved pixels and still passed - it was measuring the stroke. A count
  // of ink cannot be narrowed to rescue it either: 21,000 pixels of this canvas sit
  // above alpha 225 before the path contributes anything, because the point cloud and
  // the range rings are drawn on it too.
  //
  // So the claim is asked of the geometry instead, through the same function the
  // drawing walks. What the beads have to be is uniform in *time* and therefore
  // non-uniform in *space* whenever the camera changes speed - which is exactly what
  // `beads-evenly-spaced` takes away.
  const beads = await page.evaluate(`(() => {
    const P = (x, z) => ({ position: [x, 0.35, z], quaternion: [0, 0, 0, 1], fov: 50 });
    const LIN_O = [[1 / 3, 1 / 3]];
    const LIN_I = [[2 / 3, 2 / 3]];
    const mk = (out0, in2) => [
      { t: 2, value: P(-1.4, 1.5), easeOut: out0, easeIn: LIN_I },
      { t: 5, value: P(0.2, 1.0), easeOut: LIN_O, easeIn: LIN_I },
      { t: 8, value: P(1.6, 1.4), easeOut: LIN_O, easeIn: in2 },
    ];
    const gaps = () => {
      const pts = __kinect.editor.pathBeads();
      const out = [];
      for (let i = 1; i < pts.length; i++) {
        out.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
      }
      return out;
    };
    __kinect.keyframes.setTracks({ camera: mk(LIN_O, LIN_I) });
    const flat = gaps();
    __kinect.keyframes.setTracks({ camera: mk([[0.42, 0]], [[0.58, 1]]) });
    const eased = gaps();
    const spread = (g) => Math.max(...g) / Math.max(1e-9, Math.min(...g));
    return { count: eased.length + 1, flatSpread: spread(flat), easedSpread: spread(eased) };
  })()`);
  // The count comes off the same two constants the drawing uses, so a thinning that
  // changed would be caught here rather than silently drawing more or fewer dots.
  check(beads.count === 30, 'the path overlay beads every fourth of its 120 samples',
    `${beads.count} beads`);
  // The eased path has to spread much wider than the unshaped one, because `smooth` on
  // the outer keys is precisely a demand that the camera crawl at both ends. The
  // unshaped arm is the control and is not itself uniform - a Catmull-Rom through
  // unevenly spaced keys varies in speed on its own - so the claim is the ratio between
  // them rather than flatness.
  check(beads.easedSpread > beads.flatSpread * 3,
    'and their spacing follows the easing, which is what makes the overlay a picture of the timing',
    `widest-to-narrowest gap ${beads.easedSpread.toFixed(1)}x when eased against ${beads.flatSpread.toFixed(1)}x unshaped`);

  // **The lane's own drawn curve**, which nothing else in this file looks at. Every
  // other pose row reads the evaluator through `valueAt`, the handle geometry through
  // `ends` or the presets through `easeOf` - so a build whose pose lane drew a flat
  // line through the middle of the strip would pass all of them, and the lane is
  // exactly what `docs/reference.md` promises draws the remap directly.
  //
  // Two claims, because a curve that merely exists is not the claim: it has to cross
  // the lane, and it has to change when the easing does.
  const lane = await page.evaluate(`(() => {
    const P = (x, z) => ({ position: [x, 0.35, z], quaternion: [0, 0, 0, 1], fov: 50 });
    const LIN_O = [[1 / 3, 1 / 3]];
    const LIN_I = [[2 / 3, 2 / 3]];
    const mk = (out0, in2) => [
      { t: 2, value: P(-1.4, 1.5), easeOut: out0, easeIn: LIN_I },
      { t: 5, value: P(0.2, 1.0), easeOut: LIN_O, easeIn: LIN_I },
      { t: 8, value: P(1.6, 1.4), easeOut: LIN_O, easeIn: in2 },
    ];
    const ys = () => document.querySelector('.tlane[data-owner=camera] polyline')
      .getAttribute('points').split(' ').map((p) => Number(p.split(',')[1]));
    __kinect.keyframes.setTracks({ camera: mk(LIN_O, LIN_I) });
    const flat = ys();
    __kinect.keyframes.setTracks({ camera: mk([[0.42, 0]], [[0.58, 1]]) });
    const eased = ys();
    const span = (a) => Math.max(...a) - Math.min(...a);
    const worstShift = Math.max(...eased.map((y, i) => Math.abs(y - flat[i])));
    return { span: span(flat), worstShift };
  })()`);
  check(lane.span > 80,
    'the camera lane draws a curve that crosses it, rather than a line through the middle',
    `the drawn points span ${lane.span.toFixed(1)} of the lane's 100`);
  check(lane.worstShift > 5,
    '  and that curve is redrawn when the easing changes, which is the whole of what it is for',
    `worst ${lane.worstShift.toFixed(1)} of 100 between the unshaped and eased curves`);

  // =====================================================================
  console.log('\n[6] the strip stays a fixed height and the render dialog stays reachable');
  // =====================================================================
  // A long option in every select the *scroller* holds, which is the realistic stress
  // and the one the product can actually produce: a deliverable, a project and a look
  // are all user-named. The export size select is deliberately left alone - its
  // options come from `EXPORT_SIZES` and are all of the form 1920x1080, so planting a
  // long one there would be measuring a string this build cannot make. That is the
  // "compare the constants a tool sweeps against the constants the UI offers" rule
  // pointed at option text, and it caught this row inventing a scenario: with a long
  // option forced into the pinned select, the *unmutated* build failed at 1100px.
  //
  // Appended rather than substituted, so the selected values are untouched and
  // section 7 still renders at the size it chose.
  const LONG_OPTION = 'client-cut-2026-08-02-final-v3-graded-for-delivery';
  await page.evaluate(`(${((label) => {
    globalThis.__planted = [];
    for (const sel of document.querySelectorAll('.tbar .tchips select')) {
      const opt = new Option(label, '__planted__');
      sel.appendChild(opt);
      globalThis.__planted.push(opt);
    }
    return globalThis.__planted.length;
  }).toString()})(${JSON.stringify(LONG_OPTION)})`);
  note('a long option planted in every select the scroller holds',
    `${await page.evaluate('globalThis.__planted.length')} selects`);
  await page.locator('#outputMenuButton').click();
  await page.locator('#menuExport').click();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: VIEWPORT.height });
    await new Promise((r) => setTimeout(r, 250));
    const geom = await page.evaluate(`(() => {
      const btn = document.getElementById('tExport').getBoundingClientRect();
      const hit = document.elementFromPoint((btn.left + btn.right) / 2, (btn.top + btn.bottom) / 2);
      const strip = document.getElementById('timeline');
      // Read off the strip, not off the root element. --timeline-h is declared on
      // the root and --tlanes-h is written by rebuildLanes onto the strip itself, so
      // asking the root for the second answers 0 - which made this row compare a real
      // 183px strip against a declared 148 and fail against a correct build.
      const css = getComputedStyle(strip);
      const px = (name) => parseFloat(css.getPropertyValue(name));
      return {
        hit: hit ? (hit.id || hit.tagName) : 'nothing',
        right: btn.right,
        stripH: Math.round(strip.getBoundingClientRect().height),
        declared: Math.round(px('--timeline-h') + px('--tlanes-h')),
        wrapped: [...document.querySelectorAll('.tbar')].map((b) => b.scrollHeight > b.clientHeight + 1),
      };
    })()`);
    check(geom.hit === 'tExport', `the render button is what the pointer finds at ${width}px`,
      `hits "${geom.hit}", right edge at ${geom.right.toFixed(0)} of ${width}`);
    check(geom.stripH === geom.declared,
      `  and the strip is exactly the height the stage was sized against at ${width}px`,
      `${geom.stripH}px measured, ${geom.declared}px declared`);
    check(!geom.wrapped.some(Boolean),
      `  and neither bar row wrapped at ${width}px, which is what would push the lanes out of it`,
      geom.wrapped.map((w, i) => `row ${i + 1} ${w ? 'WRAPPED' : 'ok'}`).join(', '));
  }
  await page.evaluate('globalThis.__planted.forEach((o) => o.remove())');
  await page.setViewportSize(VIEWPORT);
  await new Promise((r) => setTimeout(r, 250));

  // =====================================================================
  console.log('\n[7] the export is named, and a copy of it can be saved');
  // =====================================================================
  //
  // The field is written through the element rather than through `fill`, deliberately.
  // `--mutate pin-min-width-auto` pushes the pinned chips off the right edge, and a
  // Playwright click that had to scroll to reach the field would fail there - which
  // would redden a naming row for a layout reason. Layout is section 6's claim; this
  // section is about what the name does.
  const setName = async (value) => page.evaluate(`(${((v) => {
    const el = document.getElementById('tExportName');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }).toString()})(${JSON.stringify(value)})`);

  await setName('rooftop-wide-v3');
  await new Promise((r) => setTimeout(r, 150));
  check((await page.evaluate('__kinect.editor.exportName()')).base === 'rooftop-wide-v3',
    'a name typed into the field is the name the export will use',
    (await page.evaluate('__kinect.editor.exportName()')).base);
  check(await page.evaluate(`document.getElementById('tExport').disabled`) === false,
    '  and a legal name leaves the render button live');

  await setName('../etc/passwd');
  await new Promise((r) => setTimeout(r, 150));
  check(await page.evaluate(`document.getElementById('tExport').disabled`) === true,
    'a name shaped like a path refuses to render',
    'the regex is mirrored from server/export.js, which is the copy that is enforced');
  check(await page.evaluate(`document.getElementById('tExportNameChip').classList.contains('bad')`),
    '  and says so on the field rather than only when the server rejects it');

  await setName('');
  await new Promise((r) => setTimeout(r, 150));
  check((await page.evaluate('__kinect.editor.exportName()')).base === TAKE,
    'an empty field falls back to the take id, which is what it did before there was a field',
    (await page.evaluate('__kinect.editor.exportName()')).base);

  if (NO_RENDER) {
    note('the real export was skipped', '--no-render: the naming rows above are all that ran here');
  } else {
    // A real render, at the smallest size the menu offers and a range of a few frames,
    // then the file compared byte for byte against what came through the picker. A row
    // that asserted the button existed would pass on a build that saved nothing.
    const sizes = await page.evaluate('__kinect.exportSizes()');
    const smallest = sizes.slice().sort((a, b) => (a.w * a.h) - (b.w * b.h))[0];
    await page.evaluate(`__kinect.setOutputSize(${JSON.stringify(`${smallest.w}x${smallest.h}`)})`);
    await settle();
    // **The trim is set with the dialog shut, because that is the only order the
    // surface allows.** The export is a modal now, so while it is open the browser
    // correctly refuses every pointer event aimed at the strip behind it - and
    // `#tSetIn` sits on the strip. Driving them in the other order cost this file
    // sections 8 to 20 outright: the click retried against `<dialog open>` for
    // thirty seconds and the run died with 160 assertions passed and none failed,
    // which reads as a healthy suite right up until you count the sections. The
    // page's own path is the one the README gives - set in and out on the timeline
    // bar, *then* open Output -> Export - so the check walks it the same way and
    // reopens the dialog through the menu for the render itself.
    await page.locator('#exportClose').click();
    await page.waitForFunction('!document.getElementById("exportDialog").open');
    await page.evaluate('__kinect.timeline.transport().seek(0)');
    await settle();
    await page.locator('#tSetIn').click();
    await page.evaluate('__kinect.timeline.transport().seek(0.2)');
    await settle();
    await page.locator('#tSetOut').click();
    await settle();
    await page.locator('#outputMenuButton').click();
    await page.locator('#menuExport').click();
    await page.waitForFunction('document.getElementById("exportDialog").open');
    await setName('editor-check-copy');
    await new Promise((r) => setTimeout(r, 150));
    note(`rendering ${smallest.w}x${smallest.h}`, `range ${JSON.stringify(await range())}`);

    await page.locator('#tExport').click();
    await page.waitForFunction('!!globalThis.__kinect.editor.lastExport()', null, { timeout: 180000 });
    const last = await page.evaluate('__kinect.editor.lastExport()');
    check(last.file.startsWith('editor-check-copy'),
      'the file the render produced carries the name that was typed', last.file);

    const res = await fetch(`${URL_BASE}${last.href}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const serverHash = createHash('sha256').update(bytes).digest('hex');
    check(res.ok && bytes.length > 0, 'and the server serves it back at the href it reported',
      `HTTP ${res.status}, ${bytes.length} bytes`);
    const onDisk = join(REPO, 'exports', last.href.replace('/exports/', ''));
    check(existsSync(onDisk) && statSync(onDisk).size === bytes.length,
      '  and it is on disk under exports/ at that size',
      existsSync(onDisk) ? `${statSync(onDisk).size} bytes` : 'not found');

    await page.locator('#tExportSave').click();
    await page.waitForFunction('globalThis.__saved.closed === true', null, { timeout: 120000 });
    const saved = await page.evaluate(`(async () => {
      const s = globalThis.__saved;
      const total = s.chunks.reduce((n, c) => n + c.byteLength, 0);
      const buf = new Uint8Array(total);
      let at = 0;
      for (const c of s.chunks) { buf.set(c, at); at += c.byteLength; }
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return {
        called: s.called,
        suggestedName: s.suggestedName,
        hadActivation: s.hadActivation,
        length: buf.length,
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      };
    })()`);
    check(saved.called && saved.suggestedName === last.file,
      'the save sheet is opened, and offered the render\'s own filename', saved.suggestedName);
    check(saved.hadActivation === true,
      '  while the click\'s activation was still live, which is why the picker comes before the fetch',
      `navigator.userActivation.isActive was ${saved.hadActivation}`);
    check(saved.sha256 === serverHash && saved.length === bytes.length,
      '  and what went through it is byte-identical to the file on the server',
      `${saved.length} bytes, ${saved.sha256.slice(0, 16)}… against ${bytes.length} bytes, ${serverHash.slice(0, 16)}…`);
  }

  // The export surface is a modal now, so leave it through the same control a person
  // uses before the rest of the editor proof reaches back into the timeline. Keeping
  // it open would make the browser correctly refuse those pointer events, which is a
  // harness failure rather than a product failure.
  if (await page.evaluate('document.getElementById("exportDialog").open')) {
    await page.locator('#exportClose').click();
  }

  // **A deliverable chosen from the menu replaces the trim, and a speed gesture holds a
  // snapshot of the trim it began in.** The menu's handler awaits a fetch, so a gesture
  // can start inside that window and still be live when the new deliverable lands - and
  // its next slider event then wrote the *previous* deliverable's cuts back through
  // `setClipInOut`, over the trim the user had just selected. The export takes its range
  // from there, so the file would have been the wrong length with nothing on screen
  // saying so.
  //
  // Driven through the real `<select>` and its `change` handler rather than through a
  // hook, because the fetch is where the window is. Two saved deliverables with cuts far
  // apart, so the row can tell which of them the gesture wrote - and they are deleted
  // afterwards through the same route that made them.
  const putDeliverable = (name, body) => page.evaluate(`(async () => {
    const res = await fetch('/deliverables/' + encodeURIComponent(${JSON.stringify(name)}), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(${JSON.stringify(body)}),
    });
    return res.json();
  })()`);

  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [{ t: 2, value: 0.2 }, { t: 6, value: 0.9 }] })`);
  await settle();
  // **The far trim is read off the take rather than written down, and the third one is
  // written to miss it deliberately.** `setClipInOut` holds a trim inside the program
  // that is open, so the flat 20s..40s this block used to plant came back as
  // 20s..30.362s on the sample and the row below would have been asserting the clamp
  // where it means to assert the menu. Two thirds and nine tenths of the way along keep
  // it as far from the near one's 2s..8s as the old pair were - which is all the swap
  // rows need of it - and keep it inside the program at every rate this block reaches,
  // including the 2x the gesture holds, where 40s would have been clamped mid-gesture.
  //
  // `editor-check-past` is the one that misses: a trim starting half a program past the
  // end, which is what a deliverable authored against a longer take or a slower rate
  // looks like when it arrives here. It is planted with the other two rather than in a
  // block of its own so that it is cleaned up by the same loop.
  const takeDur = (await read()).duration;
  const farIn = takeDur * (2 / 3);
  const farOut = takeDur * 0.9;
  const pastIn = takeDur * 1.5;
  const pastOut = takeDur * 2;
  const baseDeliverable = await page.evaluate('({ ...__kinect.library.activeDeliverable() })');
  await putDeliverable('editor-check-near', { ...baseDeliverable, name: 'editor-check-near', in: 2, out: 8 });
  await putDeliverable('editor-check-far', { ...baseDeliverable, name: 'editor-check-far', in: farIn, out: farOut });
  await putDeliverable('editor-check-past', { ...baseDeliverable, name: 'editor-check-past', in: pastIn, out: pastOut });
  // And one whose `in` is not a time at all, which is the other thing a document written by
  // a build this one cannot read looks like. It carries a *valid* `out` on purpose: the
  // failure this separates is not that a bad bound is bad, it is that clamping one spreads
  // it - `Math.max(clipIn, ...)` holds the out point up against the in point, so a single
  // unusable field takes a perfectly good one with it.
  await putDeliverable('editor-check-bad', { ...baseDeliverable, name: 'editor-check-bad', in: 'start', out: farOut });
  await page.evaluate('__kinect.editor.refreshDeliverables?.()');
  // What the menu looked like before this block touched it. Restored at the end, because
  // the selected name is drawn in a chip on the two-row bar and a longer one reflows it -
  // which moves section 8's crop sliders under different pointer coordinates and reddens
  // its rows as a rendering change. This file already has that scar once, from the nav
  // probe leaving the panel scrolled, and it is the same failure by a different route.
  const menuBefore = await page.evaluate(`(() => {
    const el = document.getElementById('tDeliverable');
    return { value: el.value, options: [...el.options].map((o) => o.value) };
  })()`);
  // And where the playhead was. `setClipInOut` seeks when the new trim excludes it, so
  // choosing a deliverable two thirds of the way along moves it - and section 8 renders
  // its crop rows at the playhead, so a different frame there is a different depth slab
  // and its numbers move. They moved: the near-slab row printed 0.337 before this block
  // existed and 0.123 after, on a build whose cropping had not changed at all.
  const playheadBefore = await page.evaluate('__kinect.timeline.transport().programSec');
  const pick = async (name) => {
    await page.evaluate(`(() => {
      const el = document.getElementById('tDeliverable');
      if (![...el.options].some((o) => o.value === ${JSON.stringify(name)})) {
        el.append(new Option(${JSON.stringify(name)}, ${JSON.stringify(name)}));
      }
      el.value = ${JSON.stringify(name)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settle();
    await new Promise((r) => setTimeout(r, 250));
    return page.evaluate('__kinect.editor.clipRange()');
  };

  const far = await pick('editor-check-far');
  check(near(far.in ?? -1, farIn, 1e-6) && near(far.out ?? -1, farOut, 1e-6),
    'choosing a deliverable puts its trim on the clip',
    `${JSON.stringify(far)}, wanted in ${farIn.toFixed(4)} out ${farOut.toFixed(4)}`);
  // The gesture begins here, holding `far`'s cuts, and the near one lands under it.
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    el.value = String(__kinect.editor.rateSlider.toValue(2));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle();
  const heldRate = await page.evaluate('__kinect.timeline.retime.rate');
  const swapped = await pick('editor-check-near');
  // The stored numbers, unscaled: a deliverable's trim is program time and
  // `applyDeliverable` writes it as it stands rather than into the rate the clip happens
  // to be in. Asserted rather than assumed, because the first version of this row divided
  // by the rate and went red against a build doing exactly the right thing.
  check(near(swapped.in ?? -1, 2, 1e-3) && near(swapped.out ?? -1, 8, 1e-3),
    '  even while a speed gesture is held, and as the stored program times rather than rescaled',
    `${JSON.stringify(swapped)} at ${heldRate}x`);
  // One more slider event, which is the door the release guard never covered.
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    el.value = String(__kinect.editor.rateSlider.toValue(1.25));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  })()`);
  await settle();
  const afterSwap = await page.evaluate('__kinect.editor.clipRange()');
  // A fresh gesture rescales the *near* trim out of the rate the clip is in - 2 and 8
  // times `heldRate / 1.25`. A gesture that survived the swap would rescale the *far*
  // one out of the rate it began in, which is 20 and 40 times `1 / 1.25` - a different
  // number by more than a factor of four, and the far end of the clip rather than the
  // near one.
  const wantIn = 2 * (heldRate / 1.25);
  const wantOut = 8 * (heldRate / 1.25);
  check(near(afterSwap.in ?? -1, wantIn, 1e-3) && near(afterSwap.out ?? -1, wantOut, 1e-3),
    '  and the gesture that continues rescales that trim rather than writing the old one back',
    `${JSON.stringify(afterSwap)}, wanted in ${wantIn.toFixed(4)} out ${wantOut.toFixed(4)}`);

  // **A trim the program cannot hold, read off the transport rather than off the
  // document.** `clipRange()` returns the raw `clipIn`/`clipOut` fields, and those are
  // not what the transport moves on: it reads `clipInSec` and `clipOutSec`, and those
  // two getters were not symmetric. `clipOutSec` was held down to the take's duration
  // and `clipInSec` was held up to zero and to nothing else, so a deliverable whose
  // `in` landed past the program's end made the pair cross - and `frameAt`, which is
  // `frameOf(max(clipInSec, min(clipOutSec, t)))`, then composed to a constant. Every
  // position the editor can ask for came back as one frame, and `exportClip` computed
  // both of its bounds through it, so the file it wrote was one frame long with the
  // `if (to < from)` guard unable to fire and the readout still naming a range.
  //
  // The rows below therefore go through `transport()` for the pair and through
  // `clipRange()` only where the raw field is the thing being asserted. The old rows in
  // this block pass identically on a build with the clamp removed, which is what makes
  // this one worth its own three assertions rather than an extra term on one of theirs.
  //
  // The rate goes back to 1 first so the numbers are about the take rather than about
  // the gesture two rows above: a slower rate only makes the program shorter, so the
  // trim would miss either way, but a row whose precondition depends on where the last
  // one left the slider is a row that reads as a different failure when it moves.
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await settle();
  const pastDur = (await read()).duration;
  check(pastIn > pastDur,
    'the planted trim really does begin past the end of the program, or nothing below is about it',
    `in ${pastIn.toFixed(3)}s against a ${pastDur.toFixed(3)}s program`);
  await pick('editor-check-past');
  const adopted = await page.evaluate(`(() => {
    const t = __kinect.timeline.transport();
    return {
      in: t.clipInSec,
      out: t.clipOutSec,
      duration: t.duration,
      readout: document.getElementById('tInOut').textContent.trim(),
    };
  })()`);
  check(adopted.in <= adopted.out,
    '  and adopting it leaves the transport a range that runs forwards, which is the pair frameAt reads',
    `clipInSec ${adopted.in.toFixed(3)}s, clipOutSec ${adopted.out.toFixed(3)}s, program ${adopted.duration.toFixed(3)}s`);
  const pastRange = await range();
  check((pastRange.in ?? -1) <= adopted.duration + 1e-6 && (pastRange.out ?? -1) <= adopted.duration + 1e-6,
    '  and the document it wrote names times the take has, both ends of it',
    `${JSON.stringify(pastRange)} against a ${adopted.duration.toFixed(3)}s program`);
  // The operator's half of the same fact. `paintStripPositions` clamps where it *draws*
  // the two markers, so both of them sit at the right-hand end either way and the strip
  // cannot tell you which build you are on - the numeric readout beside it is the one
  // surface where the document's claim is printed rather than clipped.
  const readoutSec = (text) => {
    const [m, s] = text.split(':');
    return Number(m) * 60 + Number(s);
  };
  // A millisecond of slack rather than a float epsilon: `timecode` rounds to three
  // decimals, so a duration that rounds *up* would fail an exact comparison against a
  // build doing exactly the right thing. The number this separates from is fifteen
  // seconds away.
  check(readoutSec(adopted.readout) <= adopted.duration + 1e-3,
    '  and the readout beside the markers names a time the take has, rather than one it does not',
    `#tInOut reads ${adopted.readout} of a ${adopted.duration.toFixed(3)}s program`);

  // **A bound that is not a program time, refused rather than clamped into one.** The clamp
  // above is arithmetic, and arithmetic does not refuse a value that is not a number - it
  // spreads it. An `in` of `"start"` clamps to NaN, the `Math.max` that holds the out point
  // up against it carries the NaN into a bound that was good, and `clipOutSec` and `frameAt`
  // both stop answering with numbers. That is worse than the getter the clamp was put in
  // front of, which coerced a malformed `in` to zero and left `out` alone, so the clamp had
  // to learn to refuse before it clamps.
  //
  // The range is cleared first because the block above deliberately leaves it collapsed at
  // the end of the program, where `frameAt` is a constant for a reason that is correct. A
  // row about a frozen `frameAt` run from there would be green on every build.
  await page.locator('#tClearRange').click();
  await settle();
  const beforeBad = await page.evaluate(`(() => {
    const t = __kinect.timeline.transport();
    return { in: t.clipInSec, out: t.clipOutSec };
  })()`);
  await pick('editor-check-bad');
  // The two probe positions come off the *duration*, not off the clip range, so they are
  // still two distinct program times on a build where the range has gone to NaN. Reading
  // them off `clipOutSec` would have made the row assert nothing there: NaN times anything
  // is NaN, and both probes would land on the same non-answer for the same reason.
  const bad = await page.evaluate(`(() => {
    const t = __kinect.timeline.transport();
    return {
      in: t.clipInSec,
      out: t.clipOutSec,
      early: t.frameAt(t.duration * 0.25),
      late: t.frameAt(t.duration * 0.75),
    };
  })()`);
  check(Number.isFinite(bad.in) && Number.isFinite(bad.out),
    '  and a deliverable whose in point is not a number leaves the transport a range that is still two times',
    `clipInSec ${bad.in}, clipOutSec ${bad.out}`);
  check(near(bad.out, beforeBad.out, 1e-6),
    '  and the out point it keeps is the one the clip already had, so the document was refused rather than repaired',
    `clipOutSec ${bad.out} against ${beforeBad.out} before the document was chosen`);
  // The composed function rather than its inputs, because that is what the transport moves
  // on and it is what a bound reading NaN actually breaks. Two positions half a program
  // apart resolving to one frame is the freeze this whole block is named for.
  check(Number.isFinite(bad.early) && Number.isFinite(bad.late) && bad.early !== bad.late,
    '  and frameAt still resolves two positions half a program apart to two different frames',
    `frameAt(0.25) ${bad.early}, frameAt(0.75) ${bad.late}`);
  // The operator's half used to be a row here reading the sentence off the application
  // bar's message chip, on the argument that a document refused in silence is a menu
  // selection that appears to have worked. The chip is gone, and the two things left
  // saying a refusal happened are the picker snapping back - below - and the console line
  // this block already drains. So the drain stopped being bookkeeping and became the
  // assertion: it is now the only place the *reason* is stated at all.
  //
  // `showTimelineError` writes the refusal to `console.error`, and the sweep at the end
  // of this file asserts the page said nothing at all - so this block has to take its own
  // noise back out or it reddens a row fifteen sections away that is about something else.
  //
  // **Drained here and asserted on the way out, rather than excused at the sweep.** A filter
  // added down there would be a standing exemption: it would go on covering whatever the
  // page said next that happened to match, and a refusal that stopped happening would take
  // the exemption with it silently. Taking exactly what this block provoked, and failing if
  // that is not exactly one thing, means the drain is a claim about the refusal rather than
  // a hole in the sweep - and everything else the page said stays in for the sweep to find.
  //
  // This is also why the block drives the deliverable menu rather than calling
  // `applyDeliverable` behind it the way section 15 drives `restoreProject`. The menu is the
  // door a document from another build actually arrives through, and the console write is
  // part of what arriving through it does.
  // **And the control that names the selection is put back on what the clip is on.** The
  // refusal happens before `applyDeliverable` replaces anything, so the trim, the export size
  // and the readout beside the picker all still describe the deliverable that was already
  // there - which left the picker as the one surface naming the refused one. Two surfaces
  // disagreeing is worse than either being wrong: a render afterwards matches the readout
  // while the menu shows the name of a configuration that was never adopted.
  //
  // Read off `#tDeliverable` rather than off any hook, because the element is the claim.
  const picker = await page.evaluate(`(() => {
    const el = document.getElementById('tDeliverable');
    return { value: el.value, adopted: el.dataset.adopted ?? '' };
  })()`);
  check(picker.value !== 'editor-check-bad',
    '  and the picker is not left naming the deliverable that was refused',
    `#tDeliverable reads ${JSON.stringify(picker.value)}`);
  check(picker.value === picker.adopted,
    '  and it names the one the clip is actually on, rather than merely something else',
    `#tDeliverable ${JSON.stringify(picker.value)} against the adopted ${JSON.stringify(picker.adopted)}`);
  const drained = errors.filter((e) => /not a program time/.test(e));
  for (const e of drained) errors.splice(errors.indexOf(e), 1);
  check(drained.length === 1,
    '  and the reason reaches the console exactly once, which is the only surface left saying why the menu did not take',
    `${drained.length} drained: ${drained.map((e) => e.slice(0, 60)).join(' | ') || 'nothing'}`);

  await focusStage();
  await page.evaluate(`(async () => {
    for (const n of ['editor-check-near', 'editor-check-far', 'editor-check-past', 'editor-check-bad']) {
      // The content type is required on every write route, delete included - the origin
      // rule refuses a request that does not declare one, which is a 200 carrying an
      // error rather than a network failure, so a cleanup without it fails silently.
      await fetch('/deliverables/' + n, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      });
    }
  })()`);
  await page.evaluate(`(${((before) => {
    const el = document.getElementById('tDeliverable');
    for (const o of [...el.options]) if (!before.options.includes(o.value)) o.remove();
    el.value = before.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }).toString()})(${JSON.stringify(menuBefore)})`);
  await settle();
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate('__kinect.keyframes.setTracks({})');
  // And the trim, which nothing below resets: leaving it at the near deliverable's range
  // moved section 8's crop numbers, and those rows read as a rendering change rather than
  // as a leftover from up here.
  await page.locator('#tClearRange').click();
  await page.evaluate(`__kinect.timeline.transport().seek(${playheadBefore})`);
  await settle();

  // =====================================================================
  console.log('\n[8] the crop box crops what it says, where it says');
  // =====================================================================
  //
  // Driven from the sensor's own view, so world +x is screen right and world +y is
  // screen up and "did the left face cull the left" is a question a picture can
  // answer. `registry-check` already proves each of these four reaches the pixels;
  // what it cannot say is which side each one takes, or whether the thing they make
  // is a box at all.
  //
  // **The bounding box of what survives is the wrong observable and this file used it
  // first.** A metre crop leaves near-field points at extreme image positions - a
  // point 0.29m left of the axis at 0.5m depth is still near the left edge of the
  // frame - so cropping `left` hard removed 40% of the cloud and moved the leftmost
  // lit pixel by nothing at all. Counts split by half-frame are what carry the
  // direction; the bounding box was a probe standing where the answer is the same
  // either way.
  await page.locator('#panelTabFraming').click();
  // **The scene is put back to a plain one first, and that is not tidiness.** The
  // sections above leave an animated `bloom` track behind, and bloom lifts most of the
  // frame over any sensible threshold - so the first run of these rows measured 903477
  // lit pixels against the 194911 the same shot gives with a default look, and the
  // four directional rows came back at losses of 0.0% to 18.3% where the signal is
  // 58% to 81%. Nothing was wrong with the crop; the haze was being counted as cloud.
  // The clip range and the stage shape go back too, and those two are not cosmetic.
  // Section 7's real export sets a 0.2s range and the smallest size the menu offers,
  // and `frameAt` clamps a seek into the clip range - so this section's `seek(12)`
  // landed on frame 6 of a 16:9 stage instead. Measured: the near slab's cut came back
  // at 0.366 against the 0.585 the same arm gives with the range open, and the row went
  // red on a build with nothing wrong with it. `--no-render` skipped section 7 and hid
  // it, which is the worst version of this - a row that passes in the fast mode and
  // fails in the full one.
  await page.locator('#tClearRange').click();
  await page.evaluate('__kinect.setOutputSize("1920x1080")');
  await page.evaluate('__kinect.keyframes.setTracks({})');
  await page.evaluate('__kinect.keyframes.setRetime({ rate: 1, keys: [] })');
  await page.evaluate("__kinect.params.reset(__kinect.params.names('look'))");
  await page.evaluate('__kinect.sensorView()');
  await page.evaluate('__kinect.keyframes.chrome.set(false)');
  await page.evaluate('__kinect.timeline.transport().seek(12)');
  await settle();

  const CROP_OPEN = { left: -7, right: 7, bottom: -7, top: 7 };
  const setCrop = async (o) => {
    await page.evaluate(`__kinect.params.apply(${JSON.stringify(o)})`);
    await settle();
    await new Promise((r) => setTimeout(r, 120));
  };
  // The panel is hidden for the length of the screenshot, and that is a repair rather
  // than tidiness.
  //
  // `#panel` is `position: fixed` at z-index 10 with `overflow-y: auto`, so it sits on
  // top of the stage and a screenshot clipped to the stage's box has always contained
  // it. That was invisible while the panel never moved - and it moved the moment the
  // shading modes became five sliders, because `#cropReset` then sat below the fold and
  // Playwright scrolls a control into view before clicking it. So the "open the box"
  // row below compared a frame against the same frame with the panel scrolled a few
  // pixels, reported 386 differing pixels in 202 thousand, and read exactly like the
  // cloud failing to come back. Measured against the commit before the readings landed,
  // the same row is 28 pixels - so what changed was the height of the panel and nothing
  // about the crop at all.
  //
  // `visibility` rather than `display`, deliberately: it takes the panel out of the
  // picture without reflowing anything, so every coordinate this file has calibrated
  // stays exactly where it was. What is left in the clip is the frame, which is what
  // the row always claimed to be counting.
  const lit = async () => {
    const box = await page.locator('#stage').boundingBox();
    await page.evaluate("document.getElementById('panel').style.visibility = 'hidden'");
    const shot = await page.screenshot({ clip: box });
    await page.evaluate("document.getElementById('panel').style.visibility = ''");
    return page.evaluate(`(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, img.width, img.height).data;
      const n = { all: 0, l: 0, r: 0, t: 0, b: 0 };
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] < 18) continue;
          n.all++;
          if (x < img.width / 2) n.l++; else n.r++;
          // Image y grows downward and world +y is up, so the image's top half is
          // the world's positive y and belongs to the "top" face.
          if (y < img.height / 2) n.t++; else n.b++;
        }
      }
      return n;
    })(${JSON.stringify(`data:image/png;base64,${shot.toString('base64')}`)})`);
  };

  /** The rightmost lit column, as a fraction of the stage. */
  const litEdge = async () => {
    const box = await page.locator('#stage').boundingBox();
    // The same reason as `lit` above, and it matters less here only by luck: this one
    // scans right to left and the panel is on the left, so it would have been reached
    // last. Left uncovered anyway is a probe waiting for the panel to grow one column
    // wider than the letterbox.
    await page.evaluate("document.getElementById('panel').style.visibility = 'hidden'");
    const shot = await page.screenshot({ clip: box });
    await page.evaluate("document.getElementById('panel').style.visibility = ''");
    return page.evaluate(`(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, img.width, img.height).data;
      // Scanned right to left and stopped at the first column carrying more than a
      // handful of lit pixels, because a single stray splat at the far right would
      // otherwise be the answer to every arm.
      for (let x = img.width - 1; x >= 0; x--) {
        let n = 0;
        for (let y = 0; y < img.height; y++) {
          const i = (y * img.width + x) * 4;
          if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] >= 18) n++;
        }
        if (n > 4) return x / img.width;
      }
      return 0;
    })(${JSON.stringify(`data:image/png;base64,${shot.toString('base64')}`)})`);
  };

  const reachAt = await page.evaluate('__kinect.cropReach(9.5)');
  check(reachAt.limit > reachAt.x && reachAt.limit > reachAt.y,
    'the planes open wider than the sensor can see at the furthest depth a slider allows',
    `sensor x +/-${reachAt.x.toFixed(2)}m y +/-${reachAt.y.toFixed(2)}m, planes +/-${reachAt.limit}m`);

  await setCrop(CROP_OPEN);
  const litDefault = await lit();
  await page.evaluate(`(() => { const u = __kinect.uniforms;
    u.cropL.value = -100; u.cropB.value = -100; u.cropR.value = 100; u.cropT.value = 100; })()`);
  await settle();
  await new Promise((r) => setTimeout(r, 150));
  const litWide = await lit();
  check(litDefault.all === litWide.all && litDefault.all > 1000,
    'and the defaults therefore cull nothing, which is what keeps an older clip loading uncropped',
    `${litDefault.all} lit with the defaults, ${litWide.all} with the planes at 100m`);

  for (const [name, val, own, opposite] of [['right', 0.3, 'r', 'l'], ['left', -0.3, 'l', 'r'],
    ['top', 0.3, 't', 'b'], ['bottom', -0.3, 'b', 't']]) {
    await setCrop(CROP_OPEN);
    const before = await lit();
    await setCrop({ [name]: val });
    const after = await lit();
    const lostOwn = 1 - after[own] / Math.max(1, before[own]);
    const lostOther = 1 - after[opposite] / Math.max(1, before[opposite]);
    check(lostOwn > 0.15 && lostOwn > lostOther * 2,
      `${name} culls from its own side of the frame and not the other`,
      `its half lost ${(lostOwn * 100).toFixed(1)}%, the opposite half ${(lostOther * 100).toFixed(1)}% `
      + `(lit ${before.all} -> ${after.all})`);
  }

  // A box, not a wedge, and **the observable here is where the cut lands rather than
  // how much it took.** The fraction removed cannot tell the two apart: a wedge rigged
  // to agree with the box at 2m removed 1.2% of a near slab and 66.2% of a far one
  // against the box's 1.2% and 71.6%, and `crop-in-image-space` passed every row.
  //
  // What separates them is the boundary's *position*. A plane at a fixed R metres is
  // crossed at image column `cx + R*fx/z`, which walks left as the subject moves away;
  // a crop read as an angle cuts the same column at every depth. So the right edge of
  // what survives is measured in two slabs, and R is 0.3 rather than 0.6 because at
  // 0.6 the near slab's content ends before the boundary and neither build cuts it -
  // a probe standing where the answer is the same either way.
  // **Which two slabs, asked of the capture rather than written down here.** The bands
  // were `1.0-1.6m` and `3.0-3.6m`, and a room is only obliged to have a wall in one of
  // them. `captures/` is gitignored, so on a sample whose nearest surface is past 1.6m
  // the near slab renders an empty stage, `litEdge` answers 0.000 for want of a lit
  // column, and the row reads that as the cut landing at the far left - a fixture with
  // nothing to say arriving as a build that crops in image space. So the depth range is
  // swept first and the two slabs are the nearest and the furthest that actually hold
  // something, which is the same question the literals were a guess at.
  const SLAB = 0.6;
  const occupied = [];
  for (let near = 0.6; near + SLAB <= 6.0; near += SLAB) {
    await setCrop({ ...CROP_OPEN, near, far: near + SLAB });
    const count = (await lit()).all;
    if (count > 500) occupied.push({ near, far: near + SLAB, count });
  }
  note('depth bands carrying something at 0.6m thickness',
    occupied.map((b) => `${b.near.toFixed(1)}-${b.far.toFixed(1)}m:${b.count}`).join(' ') || 'none');
  const slabs = [occupied[0], occupied[occupied.length - 1]];
  // The precondition, and it is a row rather than a bail-out because a fixture that
  // cannot separate two depths is a thing to be told about. The two bands have to be
  // genuinely apart, or "the near cut sits right of the far one" is a claim about one
  // slab measured twice.
  check(occupied.length >= 2 && slabs[1].near - slabs[0].near >= 1.2,
    'the capture holds content at two depths far enough apart to tell a plane from an angle',
    occupied.length >= 2
      ? `${slabs[0].near.toFixed(1)}m and ${slabs[1].near.toFixed(1)}m, `
        + `${(slabs[1].near - slabs[0].near).toFixed(1)}m apart`
      : `${occupied.length} band(s) with content - nothing below can be measured`);
  // **And where to put the plane, asked of the capture as well.** The author's own note
  // on the old literal says why: at 0.6m "the near slab's content ends before the
  // boundary and neither build cuts it - a probe standing where the answer is the same
  // either way". 0.3 was that value one band nearer; on a room whose near content stops
  // short of it the near arm reports its own content edge, the far arm reports a real
  // cut, and the comparison comes out backwards while both numbers are honest readings
  // of different things. So each slab's uncropped edge is measured first, and the plane
  // walks inwards until it is demonstrably biting into both.
  const openEdge = [];
  for (const { near, far } of slabs) {
    await setCrop({ ...CROP_OPEN, near, far });
    openEdge.push(await litEdge());
  }
  const BITE = 0.02;
  let plane = null;
  let edge = [];
  // Both signs and a wide walk, because where a room's content sits across the sensor
  // axis is not something to assume: this capture's near band lies entirely left of it,
  // so every positive plane stands outside the thing it is supposed to cut.
  // Zero is not in the walk, and leaving it out is the point rather than tidiness: a
  // plane on the sensor axis is crossed at the principal point at every depth, so the
  // two slabs cut at the same column and a build cropping in image space gives the
  // identical answer. It is the one value where the probe cannot tell them apart.
  for (const r of [0.6, 0.45, 0.3, 0.15, -0.15, -0.3, -0.45, -0.6, -0.75, -0.9, -1.1, -1.3]) {
    const cuts = [];
    for (const [i, { near, far }] of slabs.entries()) {
      await setCrop({ ...CROP_OPEN, near, far });
      await setCrop({ right: r });
      cuts.push(await litEdge());
      if (openEdge[i] - cuts[i] < BITE) break;
    }
    if (cuts.length === slabs.length && cuts.every((c, i) => openEdge[i] - c >= BITE)) {
      plane = r;
      edge = cuts;
      break;
    }
  }
  check(plane !== null,
    'a right plane can be found that cuts into both slabs rather than standing outside one',
    plane === null
      ? `no plane between 0.3m and -0.3m moved both edges by ${BITE} of the stage from `
        + `${openEdge.map((e) => e.toFixed(3)).join(' and ')}`
      : `right at ${plane}m, from open edges ${openEdge.map((e) => e.toFixed(3)).join(' and ')}`);
  if (plane !== null) {
    for (const [i, { near, far }] of slabs.entries()) {
      note(`slab ${near.toFixed(1)}-${far.toFixed(1)}m with right at ${plane}m`,
        `the surviving right edge sits at ${edge[i].toFixed(3)} of the stage, `
        + `against ${openEdge[i].toFixed(3)} uncropped`);
    }
  }
  // The band is measured from both sides rather than picked: this build separates the
  // two slabs by 0.038 of the stage and `crop-in-image-space` separates them by 0.001,
  // so 0.015 sits fifteen times clear of the wedge and at 40% of the box's margin.
  // Conditional on the row above, and it is a skip rather than a red: two open edges
  // compared to each other is a reading about where the room's furniture is, and
  // reporting that as the crop behaving like an angle would be a finding invented out
  // of a probe that never fired. The row above is the one that goes red.
  if (plane !== null) {
    // **Which way the two cuts should be apart depends on the sign of the plane**, and
    // the row read it one way because the literal it was written against was positive.
    // A plane at R metres is crossed at image column `cx + R*fx/z`, so its distance
    // from the principal point shrinks with depth *in R's own direction*: a plane to
    // the right of the axis cuts the near slab further right, and a plane to the left
    // cuts the near slab further left. Only the magnitude is the claim - an angle cuts
    // the same column at every depth either way - so a walk that lands on a negative
    // plane, which this capture forces because its near content is all left of the
    // axis, must read the difference the other way round or report the geometry
    // working as the geometry being broken.
    const apart = plane > 0 ? edge[0] - edge[1] : edge[1] - edge[0];
    check(apart > 0.015,
      'and the cut walks with depth in the direction the plane sits, which is what a plane in metres does and an angle does not',
      `${edge[0].toFixed(3)} against ${edge[1].toFixed(3)} at a plane of ${plane}m, `
      + `${apart.toFixed(3)} of the stage apart in the direction that plane predicts`);
  }
  await setCrop({ near: 0.05, far: 6 });

  // The way back. Four planes closed by hand are four numbers to remember, and a box
  // shut past its own subject looks exactly like a take that failed to load - so the
  // button is the difference between a reversible experiment and a scare.
  await setCrop({ left: -0.4, right: 0.4, bottom: -0.4, top: 0.4 });
  const litClosed = await lit();
  await page.locator('#cropReset').click();
  await settle();
  await new Promise((r) => setTimeout(r, 150));
  const litReopened = await lit();
  const planes = await page.evaluate(`(() => {
    const u = __kinect.uniforms;
    return [u.cropL.value, u.cropR.value, u.cropB.value, u.cropT.value];
  })()`);
  // The planes are checked exactly and the cloud within a tenth of a percent. Two
  // screenshots of the same clip taken minutes apart are not bit-identical - the
  // transport re-fetches and re-interpolates, and point splatting aliases - so this
  // row measured 288614 against 288586, a difference of 28 pixels in 288 thousand. An
  // exact equality there would be asserting determinism, which is `determinism-check`'s
  // claim and not this one's; the claim here is that the cloud came back.
  const backWithin = Math.abs(litReopened.all - litDefault.all) / litDefault.all;
  check(planes.join() === [-7, 7, -7, 7].join() && backWithin < 0.001,
    '"open the box" puts all four planes back and the whole cloud with them',
    `planes ${planes.join(', ')}; lit ${litClosed.all} -> ${litReopened.all} against `
    + `${litDefault.all} open, ${(backWithin * 100).toFixed(3)}% apart`);

  // ---------------------------------------------- 8b. the box a take opens with
  //
  // The four faces open at the bound because the bound is what an unauthored document
  // has to mean, and what that hands you is a box three to seven times the size of any
  // cloud with all twelve edges off screen. So opening a take fits them - and the two
  // things that can go wrong with that are not both about the planes.
  //
  // **What this section cannot see is whether the scan covered the take**, which is the
  // failure that would crop footage. That claim is `library-check`'s, where a server can
  // be staged with a planted take whose cloud widens after its first frame; the take
  // this file opens is a static room whose frame-zero fit is its whole-take fit to the
  // centimetre, so a row here would be green on a build that read one frame. Saying so
  // is better than writing a row that cannot fail.
  console.log('\n[8b] a take opens with the box around its own cloud');
  {
    // A page of its own, because the section above ends with the planes put back at
    // their bounds by `#cropReset` - so what "the box a take opens with" is cannot be
    // read off this page at all. A second load is the only honest place to ask.
    const fresh = await openEditor();
    const atOpen = await fresh.page.evaluate(`(() => {
      const k = globalThis.__kinect;
      return {
        planes: ['left', 'right', 'bottom', 'top'].map((n) => k.params.get(n)),
        bounds: ['left', 'right', 'bottom', 'top'].map((n) => k.params.spec(n).default),
        undo: k.undoDepth(),
      };
    })()`);

    const atBound = atOpen.planes.every((v, i) => v === atOpen.bounds[i]);
    check(!atBound,
      'the four lateral faces come in off their bounds, so the box is the take\'s and not the registry\'s',
      `${atOpen.planes.map((v) => v.toFixed(2)).join(', ')} against bounds `
      + `${atOpen.bounds.join(', ')}`);
    // Inside the bound on every face and not collapsed onto the subject either - a fit
    // that returned a point would satisfy the row above and be a box that crops
    // everything. The floor is deliberately generous: what is being asserted is that
    // this is a room-sized box rather than that it is any particular room.
    const inside = atOpen.planes.every((v, i) => Math.abs(v) < Math.abs(atOpen.bounds[i]));
    const wide = (atOpen.planes[1] - atOpen.planes[0]) > 0.5 && (atOpen.planes[3] - atOpen.planes[2]) > 0.5;
    check(inside && wide,
      'and they land inside the bounds without collapsing, so it is a room rather than a point',
      `${(atOpen.planes[1] - atOpen.planes[0]).toFixed(2)}m across, `
      + `${(atOpen.planes[3] - atOpen.planes[2]).toFixed(2)}m up`);

    // **And it is not an edit.** The fit runs before `history.begin`, so the box a take
    // opens with is part of the baseline rather than the first thing on the stack -
    // which is what stops the first undo of a session from being a box nobody dragged,
    // and what keeps the autosave comparing against the document on screen. Read off the
    // stack the keyboard pops, not off the source order.
    check(atOpen.undo === 0,
      'and the fit is not on the undo stack, so the first undo is not a box nobody dragged',
      `undo depth ${atOpen.undo} on a freshly opened take`);
    // ....  what this section deliberately does not test, because there is nothing there
    //
    // The fit was written behind a gate asking whether the document had authored its four
    // faces - the right rule, protecting a box somebody dragged from being replaced on
    // open. It is gone, and this note is where the reasoning went: `openTake` runs once
    // per page load against a registry at its defaults, opening a take from the gallery
    // is a navigation rather than a second call, and a project named in the query is
    // restored by the `.then` after the open. The condition was false on every path that
    // could reach it. This file is how that was found - `--mutate fit-overwrites-an-
    // authored-box` removed the gate and came back NOT CAUGHT with every row green, which
    // is a branch nothing can take rather than a control nothing covers.
    //
    // What still has to hold is that a document's own box beats the measurement, and that
    // is decided by ordering rather than by a condition: `openTake` fits, and the project
    // named in the query is restored by the `.then` after it. So it is driven here rather
    // than argued - a project is planted carrying faces at plus and minus six and a half,
    // a number no fit of this take produces and no default is, and the page is opened on
    // both at once. A build that fitted after the restore would answer with the fit.
    const PLANTED = '__editor-check-crop__';
    const planted = await fresh.page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const doc = k.keyframes.project();
      for (const n of ['left', 'right', 'bottom', 'top']) {
        doc.look.params[n] = n === 'left' || n === 'bottom' ? -6.5 : 6.5;
      }
      return doc;
    })()`);
    await fetch(`${URL_BASE}/projects/${encodeURIComponent(PLANTED)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(planted),
    });
    const both = await openEditor();
    await both.page.goto(`${URL_BASE}${EDITOR_PATH}?take=${encodeURIComponent(TAKE)}`
      + `&project=${encodeURIComponent(PLANTED)}`, { waitUntil: 'load' });
    await both.page.waitForFunction('globalThis.__kinect?.takeOpened?.()', null, { timeout: 60000 });
    // The restore is a second promise after the open, so the planes it writes can land a
    // beat later than `takeOpened`. Waited for rather than slept on, and a build that
    // never restores falls out of the wait into the row below with the fit's own numbers
    // rather than into a timeout.
    await both.page.waitForFunction(
      `globalThis.__kinect.params.get('left') !== ${atOpen.planes[0]}`, null, { timeout: 15000 },
    ).catch(() => {});
    const withProject = await both.page.evaluate(
      `['left','right','bottom','top'].map((n) => globalThis.__kinect.params.get(n))`);
    check(withProject.join() === [-6.5, 6.5, -6.5, 6.5].join(),
      'a project named beside the take keeps its own box, because the restore lands after the fit',
      `${withProject.join(', ')} against the project's -6.5, 6.5, -6.5, 6.5 and the fit's `
      + `${atOpen.planes.map((v) => v.toFixed(2)).join(', ')}`);
    await both.close();
    await fetch(`${URL_BASE}/projects/${encodeURIComponent(PLANTED)}`, { method: 'DELETE' }).catch(() => {});

    // The button, which is the other half: an explicit press refits whatever the faces
    // are, and unlike the open it *does* commit - it is a drag on four faces at once.
    //
    // **The box is opened out through `#cropReset` rather than by writing the values**,
    // and that is the row working rather than a detour. A write through `params.set`
    // leaves the undo baseline where it was, so the press below would restore the
    // document to exactly its baseline and `commit` would correctly decline to record a
    // change that is not one - which reads as the press failing to commit. Pressing the
    // real control first makes the wide box the baseline, so the refit is a genuine edit
    // from it and the row is asking what it says it is asking.
    await fresh.page.locator('#panelTabFraming').click();
    await fresh.page.locator('#cropReset').click();
    const undoBefore = await fresh.page.evaluate('globalThis.__kinect.undoDepth()');
    const openedOut = await fresh.page.evaluate(
      `['left','right','bottom','top'].map((n) => globalThis.__kinect.params.get(n)).join()`);
    check(openedOut === atOpen.bounds.join() && undoBefore > 0,
      'and opening the box back out is itself an edit, so the press below has a baseline to differ from',
      `planes ${openedOut}, undo depth ${undoBefore}`);
    await fresh.page.locator('#cropFit').click();
    await fresh.page.waitForFunction(
      `['left','right','bottom','top'].map((n) => globalThis.__kinect.params.get(n)).join() !== `
      + `${JSON.stringify(atOpen.bounds.join())}`,
      null, { timeout: 30000 },
    ).catch(() => {});
    const refitted = await fresh.page.evaluate(`(() => {
      const k = globalThis.__kinect;
      return { planes: ['left', 'right', 'bottom', 'top'].map((n) => k.params.get(n)), undo: k.undoDepth() };
    })()`);
    check(refitted.planes.join() === atOpen.planes.join(),
      'pressing "fit box to take" puts the same box back over a document that had been opened out',
      `${refitted.planes.map((v) => v.toFixed(2)).join(', ')} against the fit at open `
      + `${atOpen.planes.map((v) => v.toFixed(2)).join(', ')}`);
    check(refitted.undo > undoBefore,
      'and that press is on the undo stack, because a press is an edit where an open is not',
      `undo depth ${undoBefore} before the press, ${refitted.undo} after`);
    await fresh.close();
  }

  // ================ 9. orbiting the parked viewport costs frames, not settles

  console.log('\n[9] a parked orbit keeps its temporal look and redraws once per frame');

  // The control the editor gives you for looking at the cloud is the drag itself, and
  // it is the one control in this file whose scheduling failure is a *rate* rather
  // than a wrong answer. The old temporal path also produced a wrong picture while
  // the pointer was held; the picture rows below keep those two claims separate.
  // Before the scheduling fix one pointer move could cause dozens of redraws,
  // because `renderProgramFrame` runs `advanceNavigation`, which
  // calls `controls.update()`, which fires `change` on a damped control that moved -
  // so the render asked for the next render and the damping settle ran at whatever
  // rate the machine could rebuild a frame. Measured before the fix: one pointer move
  // raised 35 `change` events, 34 of them from inside a render, and cost 34 drafts.
  //
  // So this is a counted claim rather than a timed one. A threshold in milliseconds
  // would pass on a fast enough machine while the amplification was still there, and
  // the amplification is the bug. `orbit-pumps-on-change` is the control.
  {
    await page.locator('#panelTabCamera').click();
    await page.evaluate('__kinect.timeline.transport().pause()');
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    // The page counts its own animation frames. A driver-side clock cannot see this:
    // a saturated main thread starves rAF, which is exactly the symptom, and a
    // stopwatch out here would report the wall time either build takes rather than
    // how many turns the compositor was given.
    await page.evaluate(`(() => {
      globalThis.__orbitFrames = 0;
      const tick = () => { globalThis.__orbitFrames++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    })()`);

    const stage = await page.evaluate(`(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    const poseOf = () => page.evaluate('(() => { const p = __kinect.freeCamera.position;'
      + ' return [p.x, p.y, p.z]; })()');

    // ---- the drift a released orbit still owes, and the actions that read through it
    //
    // `finishOrbitDrift` exists because three things read the camera's pose and one
    // of them is reached for straight out of a release: the camera key copies the
    // pose, `sensorView` assigns one, and the node drag projects through it. Keyed
    // mid-drain, the pose recorded is one the viewport then glides away from, so the
    // shot that was keyed is not the shot that was framed.
    //
    // **First in this section, and the position is a precondition rather than a
    // preference.** `controls.enabled` is restored as `viewCamera === freeCamera`, so
    // a section that leaves the view on the program camera leaves the orbit inert for
    // every row after it - written later in the file, this row's drag moved the camera
    // 0.000 m and the whole thing passed on a build with the fix deleted. The travel
    // assertion below is what caught that, and it stays whatever else moves.
    {
      const dampingShipped = await page.evaluate('__kinect.controls.dampingFactor');
      const poseAtStart = await poseOf();
      // The whole view, saved to be put back. This block orbits nearly three metres,
      // and the rows below compare two moments of the clip against each other through
      // whatever camera they inherit - at the pose this leaves behind, a second of
      // footage separates by 1.29/255 where it separates by 4.48 at the pose section 8
      // ends on, and their own control says so by failing. Restoring is what keeps
      // this row from deciding what the next ones can see.
      const viewSaved = await page.evaluate(`(() => {
        const c = __kinect.freeCamera;
        const t = __kinect.controls.target;
        return { p: c.position.toArray(), q: c.quaternion.toArray(), t: [t.x, t.y, t.z] };
      })()`);
      // Slow enough that the drain is still owed when the button is pressed, and no
      // slower: `OrbitControls` stops dispatching `change` once a step falls under a
      // millimetre, and a window with no events in it is not a window.
      await page.evaluate('__kinect.controls.dampingFactor = 0.02');
      await page.mouse.move(stage.x - 60, stage.y - 30);
      await page.mouse.down();
      await page.mouse.move(stage.x + 40, stage.y + 20);
      await page.mouse.move(stage.x + 95, stage.y + 48);
      await page.mouse.up();
      // Read before the click, not after. On a build with the fix in, the click
      // *finishes* the drift - so a pose sampled afterwards has nothing left owed and
      // the control below would report that the window was shut when it was open. The
      // first version of this row did exactly that and failed its own control, which
      // is the control working.
      const posePressed = await poseOf();
      await page.locator('#camKey').click();
      const keyedAt = (await read()).programSec;
      const keyed = await page.evaluate(
        `__kinect.keyframes.valueAt('camera', ${keyedAt}).position`);
      // Closed the instant the click is in. Left open it outlasts `settled()`'s two
      // hundred turns and every row below fails as a timeout.
      await page.evaluate(`__kinect.controls.dampingFactor = ${dampingShipped}`);
      await settle();
      const poseRested = await poseOf();

      const dragged = Math.hypot(...posePressed.map((v, i) => v - poseAtStart[i]));
      const owed = Math.hypot(...poseRested.map((v, i) => v - posePressed[i]));
      const keyError = Math.hypot(...poseRested.map((v, i) => v - keyed[i]));
      note('the camera key pressed while the release still owed the camera movement',
        `dragged ${dragged.toFixed(3)} m, still owed ${owed.toFixed(3)} m at the press, `
        + `key ${keyError.toFixed(4)} m from where it came to rest`);
      // Two controls before the claim, and each closes a different way of passing
      // without testing anything: a drag that never moved the camera, and a press that
      // arrived after the drain had already finished.
      check(dragged > 0.05, 'the drag before the camera key moved the camera',
        `${dragged.toFixed(3)} m`);
      check(owed > 0.02, 'and the release still owed it movement when the key went in',
        `${owed.toFixed(3)} m still to travel`);
      check(keyError < 0.01,
        'so the camera key records the shot that was framed rather than one the glide leaves behind',
        `${keyError.toFixed(4)} m between the keyed pose and the resting pose`);
      await page.evaluate("__kinect.keyframes.setTracks({})");
      await page.evaluate(`(() => {
        const v = ${JSON.stringify(viewSaved)};
        const c = __kinect.freeCamera;
        c.position.fromArray(v.p);
        c.quaternion.fromArray(v.q);
        __kinect.controls.target.set(v.t[0], v.t[1], v.t[2]);
        __kinect.controls.update(0);
        c.updateMatrixWorld(true);
      })()`);
      await settle();
    }

    const poseBefore = await poseOf();
    const before = await page.evaluate(
      '({ redraws: __kinect.timeline.counters.navigationRedraws, frames: globalThis.__orbitFrames })');
    // Where the playhead is parked before the hand touches anything, read rather than
    // written down. The rows about the released picture compare against this, and a
    // second spelling of the seek at the head of this block is a number that drifts
    // away from the seek the moment either one is edited.
    const releaseTarget = await read();
    const RELEASE_AT = releaseTarget.programSec;
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.down();
    const MOVES = 24;
    for (let i = 0; i < MOVES; i++) {
      await page.mouse.move(stage.x + Math.sin(i / 5) * 110, stage.y + Math.cos(i / 7) * 55);
      await page.evaluate('new Promise(requestAnimationFrame)');
    }
    await page.mouse.up();
    await settle();
    const after = await page.evaluate(
      '({ redraws: __kinect.timeline.counters.navigationRedraws, frames: globalThis.__orbitFrames })');
    const poseAfter = await poseOf();

    const redraws = after.redraws - before.redraws;
    const frames = after.frames - before.frames;
    const travelled = Math.hypot(...poseAfter.map((v, i) => v - poseBefore[i]));
    note(`${MOVES} pointer moves across the stage`,
      `${redraws} navigation redraws over ${frames} animation frames, camera moved ${travelled.toFixed(3)} m`);

    // The control for the row below, and it has to come first: a drag that rendered
    // nothing would satisfy any ceiling at all, and so would one that never moved
    // the camera.
    check(redraws > 0 && travelled > 0.05, 'the drag renders, and it moves the camera',
      `${redraws} navigation redraws, ${travelled.toFixed(3)} m`);
    // The invariant rather than a threshold: the animation loop is the only thing
    // that starts a redraw while the playhead is parked, so it cannot start more than
    // one per frame. The slack is one frame, for the turn this counter was installed
    // on relative to the loop's.
    check(redraws <= frames + 1, 'and never more than one redraw per frame the display was given',
      `${redraws} navigation redraws against ${frames} frames`);
    // The largest part of the renderer that nothing is drawn over, established by
    // what is actually on top rather than by the stage's bounds. The panel is fixed
    // over the stage and its cost readout changes between a draft and an accurate
    // seek, so a stage screenshot can distinguish the UI while the renderer agrees.
    // `elementFromPoint` closes that false-positive path, and the two rows below make
    // the conditions of every following picture comparison assertions of the tool.
    const picture = await page.evaluate(`(() => {
      const canvas = __kinect.renderer.domElement;
      const r = canvas.getBoundingClientRect();
      const clean = (rect) => {
        let covered = 0;
        const over = new Set();
        for (let i = 0; i <= 4; i++) {
          for (let j = 0; j <= 4; j++) {
            const at = document.elementFromPoint(
              rect.x + (rect.width * i) / 4, rect.y + (rect.height * j) / 4,
            );
            if (at !== canvas) {
              covered++;
              over.add(at ? (at.id ? '#' + at.id : at.tagName.toLowerCase()) : 'nothing');
            }
          }
        }
        return { covered, over: [...over].join(' ') };
      };
      let rect = {
        x: Math.ceil(r.x) + 1, y: Math.ceil(r.y) + 1,
        width: Math.floor(r.width) - 2, height: Math.floor(r.height) - 2,
      };
      let hits = clean(rect);
      for (let step = 0;
        step < 40 && hits.covered > 0 && rect.width > 64 && rect.height > 64;
        step++) {
        const dx = Math.max(2, Math.round(rect.width * 0.05));
        const dy = Math.max(2, Math.round(rect.height * 0.05));
        rect = {
          x: rect.x + dx, y: rect.y + dy,
          width: rect.width - 2 * dx, height: rect.height - 2 * dy,
        };
        hits = clean(rect);
      }
      return {
        ...rect, covered: hits.covered, over: hits.over,
        chromeHidden: document.getElementById('chrome')?.hidden === true,
      };
    })()`);
    check(picture.chromeHidden,
      'the chrome overlay is off, so temporal signatures contain the renderer rather than annotations',
      '#chrome hidden');
    check(picture.covered === 0 && picture.width > 200 && picture.height > 200,
      'and nothing is drawn over the temporal signature region, hit-tested rather than assumed',
      `${picture.width}x${picture.height} at ${picture.x},${picture.y}, `
      + `${picture.covered} of 25 probes covered${picture.over ? ` by ${picture.over}` : ''}`);

    // Forty tile means across that renderer-only region rather than one lit count
    // over it, and the reason is the same one `docs/measurement.md` records for the
    // bloom rebase: a scalar over the whole frame can come out equal for two genuinely
    // different pictures, because a cloud that has moved a second along mostly
    // *redistributes* its brightness rather than changing how much of it there is. A
    // spatial signature cannot be fooled that way, and the row below needs it to not
    // be.
    const signature = async () => {
      const shot = await page.screenshot({
        clip: { x: picture.x, y: picture.y, width: picture.width, height: picture.height },
      });
      return page.evaluate(`(async (dataUrl) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, img.width, img.height).data;
        const COLS = 8;
        const ROWS = 5;
        const sums = new Array(COLS * ROWS).fill(0);
        const counts = new Array(COLS * ROWS).fill(0);
        for (let y = 0; y < img.height; y++) {
          for (let x = 0; x < img.width; x++) {
            const i = (y * img.width + x) * 4;
            const tile = Math.min(ROWS - 1, Math.floor(y / (img.height / ROWS))) * COLS
              + Math.min(COLS - 1, Math.floor(x / (img.width / COLS)));
            sums[tile] += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
            counts[tile]++;
          }
        }
        return sums.map((s, k) => s / counts[k]);
      })(${JSON.stringify(`data:image/png;base64,${shot.toString('base64')}`)})`);
    };
    /** The worst of the forty tiles, in 0-255 luma. */
    const apart = (a, b) => Math.max(...a.map((v, k) => Math.abs(v - b[k])));

    // The falsification control for the region itself. The panel's composited pixels
    // change conspicuously while the renderer does nothing. A screenshot that went
    // back to the stage's bounds would redden this row even if it kept asserting a
    // different hit-tested rectangle, which is the exact split that let the panel
    // contaminate the first version of these signatures.
    const panelControlBefore = await signature();
    await page.evaluate("document.getElementById('panel').style.background = '#fff'");
    await page.evaluate('new Promise(requestAnimationFrame)');
    const panelControlAfter = await signature();
    await page.evaluate("document.getElementById('panel').style.background = ''");
    await page.evaluate('new Promise(requestAnimationFrame)');
    const panelApart = apart(panelControlBefore, panelControlAfter);
    check(panelApart < 0.01,
      'control: changing only the panel changes no temporal signature pixels',
      `worst tile ${panelApart.toFixed(2)}/255`);

    // The picture the release actually left on the stage, read before anything else
    // moves the transport. The rows below ask whether it is the picture an accurate
    // seek to the moment the hand let go of would have given.
    //
    // **This used to read `drafted` alone, and that assertion did not enforce its
    // claim.** `seekNow` clears the flag whatever position it was handed, so a
    // release that seeked accurately to the wrong moment - a second past the one the
    // playhead was parked at - set `drafted` to false and passed, while the viewport
    // visibly sat somewhere else. `release-seeks-past-target` is that build, and it
    // is the control for the comparison rather than for the flag.
    const releasedSig = await signature();
    const released = await read();
    check(released.drafted === false, 'and the release leaves no draft standing on the stage',
      `drafted ${released.drafted}, playhead ${released.programSec.toFixed(3)}s`);

    // **The moment is asserted as a number and the picture as a picture, and splitting
    // them is what took this block off the footage.**
    //
    // It used to ask both through pixels: find some other moment in the capture whose
    // picture differs, then require the released picture to be four times closer to an
    // accurate seek than that other moment is. The control for it demanded the two
    // moments read more than 2/255 apart on the worst of forty tile means - and that
    // number is a property of *what happened in the room*, not of the build. It had
    // already gone red once for that reason and been patched by walking outwards
    // through candidate moments; it went red again at 0.32.
    //
    // Measured on a 75.6s fixture: no pair among 4, 5, 6, 8, 12, 20, 32, 2 and 0.5
    // seconds reads further than 0.32 apart, and the widest pair anywhere in the take
    // is 0.19. The seeks all landed - program time exact, every frame index distinct,
    // the render and frame-fetch counters climbing each time - and the pictures do
    // differ: up to 76/255 on individual pixels, with 0.18-0.26% of pixels more than
    // 8/255 apart. The subject moved; a mean over a fortieth of the region is a
    // low-pass filter and averaged it away. Every fixture this repo can build is that
    // capture looped, so no walk outwards can ever answer it, and a band re-derived to
    // suit today's footage would be the same defect with a newer number in it.
    //
    // So the moment comes off the transport, which knows it exactly, and the picture
    // question becomes equality: the release must leave *the same picture* an accurate
    // seek to the same moment leaves. That is enforceable because the renderer is
    // bit-deterministic at a settled program time - the claim `determinism-check`
    // exists for - and measured here rather than assumed: `sameMomentTwice` seeks away
    // and back and reads 0.0000. The falsification control is a scrub draft at that
    // same moment, which is a property of the renderer instead of the room and reads
    // ~30/255 on any footage.
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const intendedSig = await signature();
    await page.evaluate('__kinect.timeline.transport().seek(20.0)');
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const sameMomentTwice = apart(intendedSig, await signature());
    // The wrong picture at the *right* moment, which is the failure this block is
    // actually about: a release that leaves the degraded scrub preview standing.
    //
    // **Under a look with temporal content in it, and that is the control rather than
    // dressing.** A scrub draft differs from an accurate render by skipping the
    // accumulation pre-roll, so with `fade`, `wake` and `trails` all at zero there is
    // nothing for it to skip and the two are the same picture: measured at the shipped
    // defaults, a draft of this moment sits 0.07/255 from an accurate seek to it, which
    // is a control that would have passed nothing. The neighbouring block applies the
    // same three for the same reason. They are applied here and put straight back, so
    // the equality rows above are measured at the look the release happened under and
    // this one is measured where the difference it is about can exist at all.
    const temporalBefore = await page.evaluate("__kinect.params.values(['fade', 'wake', 'trails'])");
    await page.evaluate('__kinect.params.apply({ fade: 400, wake: 900, trails: 0.5 })');
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const accurateUnderTemporal = await signature();
    await page.evaluate('__kinect.timeline.transport().draft(4.0)');
    await settle();
    const draftSig = await signature();
    await page.evaluate(`__kinect.params.apply(${JSON.stringify(temporalBefore)})`);
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();

    const draftCosts = apart(draftSig, accurateUnderTemporal);
    const landed = apart(releasedSig, intendedSig);
    note('the released picture against an accurate seek to the same moment',
      `worst tile ${landed.toFixed(4)}/255, where the same moment read twice differs by `
      + `${sameMomentTwice.toFixed(4)} and a scrub draft of it by ${draftCosts.toFixed(2)}`);
    // Where the release actually parked, asked of the transport rather than of the
    // pixels. `release-seeks-past-target` is the build this refuses: it seeks
    // accurately to the wrong moment, which clears `drafted` and leaves the row above
    // green while the viewport sits somewhere else.
    check(near(released.programSec, RELEASE_AT, 1e-6) && released.frame === releaseTarget.frame,
      'and it parked on the moment the hand let go of, read off the transport rather than guessed from pixels',
      `playhead ${released.programSec.toFixed(6)}s against ${RELEASE_AT.toFixed(6)}s before the drag, `
      + `frame ${released.frame} against ${releaseTarget.frame}`);
    // The control for the row below, and it has to come first for the same reason the
    // drafts row's does: a signature blind to the difference between a draft and the
    // real image would make the comparison below pass on every build there is.
    check(draftCosts > 1,
      'the renderer signature can tell a scrub draft of this moment from the accurate picture of it',
      `worst tile ${draftCosts.toFixed(2)}/255, against ${sameMomentTwice.toFixed(4)} for the same picture twice`);
    // The floor is a row rather than a term inside the band below, because it is a claim
    // and not a tolerance: the renderer is bit-deterministic at a settled program time,
    // so a moment read twice has to come back *identical*, and a build where it does not
    // has broken the property the equality below rests on. It reads 0.0000 - which is why
    // the band below is the panel control's 0.01 and that number binds, every time.
    check(sameMomentTwice < 0.01,
      'the same moment renders the same picture twice, which is what makes the row below an equality',
      `worst tile ${sameMomentTwice.toFixed(4)}/255 over a seek away to 20.0s and back`);
    check(landed < 0.01,
      'and the release lands the picture an accurate seek to that moment gives, not merely an accurate seek',
      `worst tile ${landed.toFixed(4)}/255 against a ${sameMomentTwice.toFixed(4)} floor and the `
      + `${draftCosts.toFixed(2)} a draft would cost`);

    // The renderer-level half of the bug, separated from the editor transport. A
    // camera change is rendered once through the live seam with trails enabled, then
    // the same pose and source position are rendered after an explicit afterimage
    // clear. Surface memory and the trails parameter stay untouched in both arms. The
    // first enabled frame has no legitimate old screen pixel to contribute: after the
    // camera-history clear it is `max(current, 0)`, so the two pictures must agree.
    // `camera-motion-keeps-history` removes only that clear. It leaves the camera move,
    // render and look intact and must redden the picture row below.
    const historyProbe = await page.evaluate(`(() => {
      const k = __kinect;
      const c = k.freeCamera;
      const t = k.controls.target;
      return {
        look: k.params.values(['fade', 'wake', 'trails', 'bloom']),
        view: { p: c.position.toArray(), q: c.quaternion.toArray(), t: [t.x, t.y, t.z] },
        clears: k.timeline.counters.navigationHistoryClears,
      };
    })()`);
    await page.evaluate(`__kinect.params.apply({ fade: 0, wake: 0, trails: 0.75, bloom: 0 })`);
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const cameraBeforeHistoryMove = await poseOf();
    await page.evaluate(`(() => {
      const k = __kinect;
      const c = k.freeCamera;
      const t = k.controls.target;
      const offset = c.position.clone().sub(t).applyAxisAngle(c.up, 0.24);
      c.position.copy(t).add(offset);
      c.lookAt(t);
      k.controls.update(0);
      k.drive.stepTo(4.0);
    })()`);
    const movedWithTrails = await signature();
    const cameraAfterHistoryMove = await poseOf();
    const historyClears = await page.evaluate(
      `__kinect.timeline.counters.navigationHistoryClears - ${historyProbe.clears}`);
    await page.evaluate(`(() => {
      __kinect.drive.clearAfterimage();
      __kinect.drive.stepTo(4.0);
    })()`);
    const movedWithoutHistory = await signature();
    const historyTravel = Math.hypot(...cameraAfterHistoryMove.map(
      (v, i) => v - cameraBeforeHistoryMove[i]));
    const historyApart = apart(movedWithTrails, movedWithoutHistory);
    note('the first frame at a new camera pose against the same frame with no old screen history',
      `worst tile ${historyApart.toFixed(2)}/255 after ${historyTravel.toFixed(3)} m and ${historyClears} history clears`);
    check(historyTravel > 0.05 && historyClears > 0,
      'the camera-history probe moves the camera and exercises the clear',
      `${historyTravel.toFixed(3)} m, ${historyClears} clears`);
    check(historyApart < 0.5,
      'and camera motion carries no pixels from the previous view into the new one',
      `worst tile ${historyApart.toFixed(2)}/255`);
    await page.evaluate(`(() => {
      const k = __kinect;
      const v = ${JSON.stringify(historyProbe.view)};
      const c = k.freeCamera;
      c.position.fromArray(v.p);
      c.quaternion.fromArray(v.q);
      k.controls.target.set(v.t[0], v.t[1], v.t[2]);
      k.controls.update(0);
      k.params.apply(${JSON.stringify(historyProbe.look)});
    })()`);
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();

    // Now sample the actual editor gesture before release. Damping is disabled for
    // this one move so the pose is stationary while the two pictures are read; the
    // rate row above exercises the shipped damped path. The first picture is what the
    // orbit redraw left while the pointer is still held. The second is an explicit
    // accurate seek at that unchanged pose. A deliberately requested scrub draft is
    // the falsification control: it must differ, or this look cannot tell whether the
    // orbit reused the degraded preview.
    const orbitLook = await page.evaluate(`(() => ({
      look: __kinect.params.values(['fade', 'wake', 'trails']),
      damping: __kinect.controls.enableDamping,
    }))()`);
    await page.evaluate('__kinect.params.apply({ fade: 400, wake: 900, trails: 0.5 })');
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    await page.evaluate('__kinect.controls.enableDamping = false');
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.down();
    await page.mouse.move(stage.x + 95, stage.y + 45);
    await page.evaluate('new Promise(requestAnimationFrame)');
    await settle();
    const heldSig = await signature();
    const heldState = await read();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const heldAccurateSig = await signature();
    await page.evaluate('__kinect.timeline.transport().draft(4.0)');
    await settle();
    const scrubDraftSig = await signature();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const heldApart = apart(heldSig, heldAccurateSig);
    const draftApart = apart(scrubDraftSig, heldAccurateSig);
    note('the picture while the orbit is held against an accurate seek at its pose',
      `worst tile ${heldApart.toFixed(2)}/255; a scrub draft differs by ${draftApart.toFixed(2)}`);
    check(draftApart > 1,
      'the temporal look can distinguish the scrub draft from the accurate image',
      `worst tile ${draftApart.toFixed(2)}/255`);
    check(heldState.drafted === false && heldApart < draftApart / 4,
      'and the held orbit keeps the accurate temporal look instead of substituting the scrub draft',
      `drafted ${heldState.drafted}; ${heldApart.toFixed(2)}/255 against ${draftApart.toFixed(2)}`);
    await page.mouse.up();
    await page.evaluate(`(() => {
      __kinect.controls.enableDamping = ${orbitLook.damping};
      __kinect.params.apply(${JSON.stringify(orbitLook.look)});
    })()`);
    await settle();

    // An armed position means something only while something will consume it, and
    // hitting play mid-drag is a state where nothing will - the loop's first act is
    // to hand the frame to `tick`. That was harmless while nothing read the flag. It
    // stopped being harmless when `settled()` started to, and `settled()` is what
    // every tool in this suite waits on, so the failure would not have been a slow
    // orbit but a hang everywhere. Driven through the real controls because the
    // sequence is a real one: a hand lets go of the cloud and reaches for play.
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.down();
    await page.mouse.move(stage.x + 60, stage.y + 30);
    await page.mouse.up();
    await page.evaluate('__kinect.timeline.transport().play()');
    let settledAfterPlay = true;
    let why = '';
    try {
      await settle();
    } catch (err) {
      settledAfterPlay = false;
      why = err.message.split('\n')[0];
    }
    check(settledAfterPlay, 'and a drag interrupted by playback leaves nothing armed behind it', why);
    await page.evaluate('__kinect.timeline.transport().pause()');
    await settle();

    // The release settles for about a third of a second after the pointer comes up,
    // and a hand does not wait for it - the next thing it does is scrub, or reach for
    // a key. That navigation renders, its render runs `advanceNavigation`, and the
    // damped control still draining fires `change` from inside it, so whatever the
    // orbit arms there is armed while the transport is part-way between two
    // positions. Driven with Home rather than an arrow because it is the largest move
    // the keyboard offers: the position being left and the position being travelled
    // to are then a whole clip apart instead of one frame, and a row that reads them
    // apart cannot be passing on rounding. `orbit-arms-stale-position` is the control.
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    // **The window is widened rather than raced, and that is the whole design of this
    // row.** What it has to arrive inside is the damping still owing the camera
    // movement, because that is what raises `change` from inside the seek's render.
    // At the shipped `dampingFactor` of 0.07 that window is about a third of a second,
    // and a driver round-trip is a real fraction of it: the first version of this row
    // caught `orbit-arms-stale-position` on one tree and reported NOT CAUGHT on a
    // heavier one, then caught it once in three runs on the same tree. A flaky control
    // is worse than no control, because the run that passes reads as a build that is
    // fine. A slower drain makes arriving inside the window certain rather than lucky.
    //
    // **0.02 rather than something far smaller, and the bound below it is the reason
    // this number is written down.** `OrbitControls` only dispatches `change` when the
    // camera moved more than its own `EPS` since the last update - `distanceToSquared`
    // above 1e-6, which is a millimetre. The factor is the fraction of the remaining
    // delta applied per update, so pushing it low enough makes each step land under
    // that millimetre and the event stops being raised at all: the window is open by
    // the flag and empty of the thing it was opened to catch. Tried at 0.002 first,
    // and the row went from flaky to reliably NOT CAUGHT, which is the worse failure
    // of the two because it looks settled. At 0.02 a residual of about a metre moves
    // twenty millimetres an update, clear of the threshold, and the window is some
    // three and a half times the shipped one.
    const shippedDamping = await page.evaluate('__kinect.controls.dampingFactor');
    await page.evaluate('__kinect.controls.dampingFactor = 0.02');
    // Focused ahead of the drag, so no round-trip sits between the release and the key.
    await focusStage();
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.down();
    await page.mouse.move(stage.x + 70, stage.y + 35);
    // **The pointer stays down, and that is what makes this row deterministic rather
    // than merely likely.** The handler under test admits both halves of the same
    // window through one guard - `orbiting` while the pointer is down, `orbitSettling`
    // after it lifts - and the mechanism is identical either side: a `change` raised
    // by `advanceNavigation` from inside the seek's own render arms a position the
    // transport has not moved to yet. Driven through the release first, it caught the
    // mutation two runs in three: `orbitSettling` is cleared by the loop's settle
    // branch the moment a frame finds nothing armed, so a keypress that arrives on
    // that frame tests a build with the window already shut, and no precondition read
    // from out here can close a gap that opens between the read and the seek. Held
    // down, `orbiting` cannot flip underneath the row.
    //
    // Deliberately no `settle()` either: arriving while the damping is still draining
    // is the entire case, and waiting first would test the state that already worked.
    // **Five gestures rather than one, and the repetition is the instrument rather
    // than padding.** Whether the stale arm happens turns on where the damping's
    // residual sits relative to `OrbitControls`' own change threshold at the instant
    // the seek renders, and that is a race no read from out here can close: driven
    // once, the mutation was caught two runs in three, and a control that reports a
    // clean build a third of the time is worse than no control, because the run that
    // passes is the one that gets believed. The claim is "a seek raised during an
    // orbit is never pulled back", so asking it five times is a stronger reading of
    // the same claim, and one pull-back in five is a failure.
    const landings = [];
    let midSettle = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await page.evaluate('__kinect.timeline.transport().seek(4.0)');
        await settle();
        await page.evaluate('__kinect.controls.dampingFactor = 0.02');
        await page.mouse.move(stage.x, stage.y);
        await page.mouse.down();
        await page.mouse.move(stage.x + 70 - attempt * 8, stage.y + 35 + attempt * 6);
      }
      midSettle = await read();
      await page.keyboard.press('Home');
      await page.evaluate(`__kinect.controls.dampingFactor = ${shippedDamping}`);
      await page.mouse.up();
      await settle();
      landings.push((await read()).programSec);
    }
    const clipIn = await page.evaluate('__kinect.timeline.transport().clipInSec');
    const worst = Math.max(...landings.map((s) => Math.abs(s - clipIn)));
    note('Home pressed five times with the orbit still live',
      `landed ${landings.map((s) => s.toFixed(3)).join(', ')}s against ${clipIn.toFixed(3)}s asked for`);
    check(midSettle.programSec === 4, 'the orbit had not moved the playhead before the key went in',
      `playhead ${midSettle.programSec.toFixed(3)}s`);
    check(worst < 0.05,
      'and a seek raised while the orbit is still live keeps the position it asked for, every time',
      `worst landing ${worst.toFixed(3)}s from ${clipIn.toFixed(3)}s`);

  }

  // =====================================================================
  console.log('\n[10] the ruler shows a window, and the window can be driven');
  // =====================================================================
  //
  // **Every arm here is zoomed and panned, and that is the design of the section
  // rather than thoroughness.** With the window at the whole clip, `(t - start)/span`
  // and the old `t/duration` are the same expression - so an arm at fit-zoom passes
  // identically on a build that has no window at all, and would report coverage for
  // the one thing it cannot see. This is the mirror of section 4's rate-1 dead zone
  // and the same rule `docs/instruments.md` states after step 6's aspect ratio.
  //
  // The window is deliberately off-centre as well as narrow, because a window centred
  // on the clip is a second agreement: zooming about the centre and zooming about the
  // pointer give the same answer when the pointer is at the centre.
  //
  // A note on what section 1 does and does not cover, since it would otherwise read as
  // covering this. Its sweep enumerates *form controls* - `input`, `select`, `button` -
  // so the overview strip and its window box are no more enumerated by it than `#tIn`
  // and `#tOut` are, and they are driven by name below for the same reason the cuts are
  // driven by name in section 3.
  // **The three keys and the two marks are placed as fractions of this capture, not as
  // seconds.** The window below is set at 30% to 42% of the clip, and the rows further
  // down need two markers before it and one past it - which a literal `t: 20` only
  // satisfies while the fixture is shorter than about 48 seconds. `captures/` is
  // gitignored and `make-fixture` loops the sample to whatever length is asked for, so
  // that literal made the section's verdict a property of the machine it ran on: on a
  // 49.79s sample the 20-second key lands at 85% of the window, inside it, and the row
  // saying markers outside the window are hidden reddens over a marker that is not
  // outside it. Fractions of the duration ask the same question of any capture.
  const clipSec = await page.evaluate('__kinect.timeline.transport().duration');
  const at = (f) => +(clipSec * f).toFixed(3);
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [ { t: ${at(0.04)}, value: 0.2 }, `
    + `{ t: ${at(0.12)}, value: 0.9 }, { t: ${at(0.55)}, value: 0.4 } ] })`);
  await page.evaluate("__kinect.editor.setMarks(["
    + `{ id: 'm1', sourceMs: ${Math.round(clipSec * 0.06 * 1000)} }, `
    + `{ id: 'm2', sourceMs: ${Math.round(clipSec * 0.50 * 1000)} }])`);
  await page.evaluate('__kinect.editor.view.set(0.30, 0.42)');
  await settle();
  const win = await page.evaluate('__kinect.editor.view.window()');
  check(!win.whole && win.spanSec < win.duration / 4,
    'the strip can be zoomed into a window that is a fraction of the clip',
    `${win.startSec.toFixed(2)}s..${win.endSec.toFixed(2)}s of ${win.duration.toFixed(2)}s`);

  // The mapping and its inverse, at that window. Both directions are read off the page
  // rather than one being recomputed here, because a check that reimplemented `pct` to
  // test `secAtPct` would be comparing this file's arithmetic against itself.
  const roundTrip = await page.evaluate(`(() => {
    const out = [];
    for (const p of [0, 12.5, 50, 87.5, 100]) {
      const t = __kinect.editor.view.secAtPct(p);
      out.push({ p, t, back: __kinect.editor.view.pct(t) });
    }
    return out;
  })()`);
  check(roundTrip.every((r) => near(r.back, r.p, 1e-6)),
    '  and a percentage across it survives a round trip through program seconds',
    roundTrip.map((r) => `${r.p}%->${r.t.toFixed(3)}s->${r.back.toFixed(3)}%`).join(' '));
  check(near(roundTrip[0].t, win.startSec, 1e-6) && near(roundTrip[4].t, win.endSec, 1e-6),
    '  and 0% and 100% are the edges of the window rather than the edges of the clip',
    `0% is ${roundTrip[0].t.toFixed(3)}s, 100% is ${roundTrip[4].t.toFixed(3)}s, clip is 0..${win.duration.toFixed(2)}s`);

  // The claim that matters to a pointer: clicking the ruler seeks to what the ruler
  // says is there. This is the row a build that forgot the window fails, and it fails
  // it by a whole window - which is why the tolerance is an output frame rather than
  // anything looser.
  const bedBox = await page.locator('#tBed').boundingBox();
  const wantedAt25 = await page.evaluate('__kinect.editor.view.secAtPct(25)');
  await page.mouse.click(bedBox.x + bedBox.width * 0.25, bedBox.y + bedBox.height / 2);
  await settle();
  const landedAt25 = await page.evaluate('__kinect.timeline.transport().programSec');
  check(near(landedAt25, wantedAt25, 1 / 30 + 1e-6),
    '  and a click a quarter of the way across it seeks to the time it names there',
    `clicked 25%, wanted ${wantedAt25.toFixed(4)}s, landed ${landedAt25.toFixed(4)}s`);

  // Markers outside the window. Hidden rather than removed, because `repositionLanes`
  // refuses to run when the node count and the key count disagree.
  const culled = await page.evaluate(`(() => {
    const keys = [...document.querySelectorAll('.tlane[data-owner=bloom] .tkey')];
    const marks = [...document.querySelectorAll('#tMarks .tmk')];
    return {
      keys: keys.length, keysShown: keys.filter((n) => !n.hidden).length,
      marks: marks.length, marksShown: marks.filter((n) => !n.hidden).length,
      lefts: keys.map((n) => parseFloat(n.style.left)),
    };
  })()`);
  check(culled.keys === 3 && culled.keysShown === 0 && culled.marksShown === 0,
    '  a marker the window does not hold is hidden rather than drawn off the edge',
    `${culled.keysShown}/${culled.keys} keys and ${culled.marksShown}/${culled.marks} marks shown, `
    + `key lefts ${culled.lefts.map((l) => `${l.toFixed(0)}%`).join(', ')}`);
  check(culled.lefts.some((l) => l < 0) && culled.lefts.some((l) => l > 100),
    '  and its node still carries the position it would have had, on both sides',
    culled.lefts.map((l) => `${l.toFixed(0)}%`).join(', '));

  // The ruler's own spacing. A window forty times narrower has to relabel, or the
  // zoom bought nothing: the whole complaint was placing a key against 20-second
  // gradations on an 800-second clip.
  const ticksAt = () => page.evaluate(`[...document.querySelectorAll('#tRuler .ttick label')].map((l) => l.textContent)`);
  const zoomedTicks = await ticksAt();
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();
  const fitTicks = await ticksAt();
  check(zoomedTicks.join() !== fitTicks.join() && zoomedTicks.length > 2 && fitTicks.length > 2,
    'the ruler picks its spacing from the window, not from the clip',
    `fit: ${fitTicks.slice(0, 6).join(' ')} | zoomed: ${zoomedTicks.slice(0, 6).join(' ')}`);

  // The overview, which is the only surface that must *not* go through the window.
  await page.evaluate('__kinect.editor.view.set(0.30, 0.42)');
  await settle();
  const box = await page.evaluate(`({
    left: document.getElementById('tMiniWin').style.left,
    width: document.getElementById('tMiniWin').style.width,
  })`);
  check(near(parseFloat(box.left), 30, 0.5) && near(parseFloat(box.width), 12, 0.5),
    'the overview draws the window on the whole clip, which is what says where you are',
    `box at ${box.left} wide ${box.width}`);

  // And it is *driven*, not merely drawn. The row above reads DOM state after no
  // interaction at all, which this file's own header rules out - a build whose
  // pointerdown handler never fires would paint that box correctly forever and pass
  // it. That is the in/out markers again with a newer node, and section 1's sweep does
  // not reach here to catch it: it enumerates form controls, and this is three divs.
  const miniBox = await page.locator('#tMini').boundingBox();
  const dragMini = async (fromF, toF, target) => {
    await page.evaluate('__kinect.editor.view.set(0.30, 0.42)');
    await settle();
    const before = await page.evaluate('__kinect.editor.view.window()');
    const y = miniBox.y + miniBox.height / 2;
    // Aimed at the box's own edge handle rather than at a fraction of the strip, so
    // the row fails when the handle moves rather than when the arithmetic does.
    const grab = target ? await page.locator(target).boundingBox() : null;
    const fromX = grab ? grab.x + grab.width / 2 : miniBox.x + miniBox.width * fromF;
    await page.mouse.move(fromX, y);
    await page.mouse.down();
    await page.mouse.move(miniBox.x + miniBox.width * toF, y, { steps: 4 });
    await page.mouse.up();
    await settle();
    return { before, after: await page.evaluate('__kinect.editor.view.window()') };
  };

  const panned = await dragMini(0.36, 0.56, '#tMiniWin');
  check(near(panned.after.a - panned.before.a, 0.2, 0.02)
    && near(panned.after.spanSec, panned.before.spanSec, 1e-6),
    '  dragging the window box pans by what the pointer moved, and does not resize it',
    `a ${panned.before.a.toFixed(3)} -> ${panned.after.a.toFixed(3)}, `
    + `span ${panned.before.spanSec.toFixed(3)}s -> ${panned.after.spanSec.toFixed(3)}s`);

  const stretched = await dragMini(0, 0.62, '#tMiniWin .e');
  check(stretched.after.spanSec > stretched.before.spanSec * 1.4
    && near(stretched.after.a, stretched.before.a, 0.01),
    '  and dragging its right edge zooms out from that edge, holding the left one',
    `span ${stretched.before.spanSec.toFixed(3)}s -> ${stretched.after.spanSec.toFixed(3)}s, `
    + `a ${stretched.before.a.toFixed(3)} -> ${stretched.after.a.toFixed(3)}`);

  await page.evaluate('__kinect.editor.view.set(0.30, 0.42)');
  await settle();
  const beforeCentre = await page.evaluate('__kinect.editor.view.window()');
  await page.mouse.click(miniBox.x + miniBox.width * 0.8, miniBox.y + miniBox.height / 2);
  await settle();
  const afterCentre = await page.evaluate('__kinect.editor.view.window()');
  check(near((afterCentre.a + afterCentre.b) / 2, 0.8, 0.02)
    && near(afterCentre.spanSec, beforeCentre.spanSec, 1e-6),
    '  and a click on open track centres the window there rather than moving one edge to it',
    `centre ${((beforeCentre.a + beforeCentre.b) / 2).toFixed(3)} -> ${((afterCentre.a + afterCentre.b) / 2).toFixed(3)}, `
    + `span ${afterCentre.spanSec.toFixed(3)}s`);

  // Zooming about the pointer. Two positions, because a zoom about the centre holds
  // the centre still and so does a zoom about a pointer that is at the centre - one
  // arm cannot tell them apart, and the wrong build is the one that reads better.
  const zoomAtFraction = async (f) => {
    await page.evaluate('__kinect.editor.view.set(0.2, 0.8)');
    await settle();
    const before = await page.evaluate(`__kinect.editor.view.secAtPct(${f * 100})`);
    const bb = await page.locator('#tBed').boundingBox();
    await page.mouse.move(bb.x + bb.width * f, bb.y + bb.height / 2);
    await page.mouse.wheel(0, -300);
    await settle();
    const after = await page.evaluate(`__kinect.editor.view.secAtPct(${f * 100})`);
    return { before, after };
  };
  for (const f of [0.2, 0.8]) {
    const held = await zoomAtFraction(f);
    check(near(held.after, held.before, 0.05),
      `a wheel zoom ${Math.round(f * 100)}% across the bed holds the program time under the pointer`,
      `${held.before.toFixed(3)}s -> ${held.after.toFixed(3)}s`);
  }

  // The overview's own wheel, which is a different mapping rather than the same
  // handler on a second element: an x on the ruler is a position in the *window* and an
  // x here is a position in the *clip*, so reading both through one of the two is how a
  // wheel over the overview zooms somewhere the cursor is not. Nothing else drives that
  // branch - `zoom-about-centre` replaces the line both surfaces share.
  // The observable is *not* "the cursor still points at the same moment" - over the
  // overview that is true by construction, since the overview never zooms. It is that
  // the moment the cursor is over keeps its place inside the window, which is what an
  // anchor means, and it is the thing the two mappings disagree about: through the
  // ruler's mapping, 30% of the overview is read as 30% *of the window*, and the moment
  // actually under the cursor falls out of the window entirely.
  await page.evaluate('__kinect.editor.view.set(0.2, 0.8)');
  await settle();
  const miniWheelBox = await page.locator('#tMini').boundingBox();
  const beforeMiniWheel = await page.evaluate('__kinect.editor.view.window()');
  const clipAt30 = beforeMiniWheel.duration * 0.3;
  const placeInWindow = (w) => (clipAt30 - w.startSec) / w.spanSec;
  await page.mouse.move(miniWheelBox.x + miniWheelBox.width * 0.3, miniWheelBox.y + miniWheelBox.height / 2);
  await page.mouse.wheel(0, -300);
  await settle();
  const afterMiniWheel = await page.evaluate('__kinect.editor.view.window()');
  check(near(placeInWindow(afterMiniWheel), placeInWindow(beforeMiniWheel), 0.02)
    && afterMiniWheel.spanSec < beforeMiniWheel.spanSec * 0.8,
    '  a wheel over the overview anchors on the clip position under the pointer, not on the window one',
    `30% of the clip is ${clipAt30.toFixed(2)}s, at ${(placeInWindow(beforeMiniWheel) * 100).toFixed(1)}% `
    + `of the window before and ${(placeInWindow(afterMiniWheel) * 100).toFixed(1)}% after, `
    + `span ${beforeMiniWheel.spanSec.toFixed(2)}s -> ${afterMiniWheel.spanSec.toFixed(2)}s`);

  // The cost of it. A zoom is dozens of events and the structural path calls `resize()`,
  // so this is the same claim the key-drag row makes, read off the same counters.
  await page.evaluate('__kinect.timeline.counters.laneRebuilds = 0; __kinect.timeline.counters.laneRepositions = 0');
  const wheelBox = await page.locator('#tBed').boundingBox();
  await page.mouse.move(wheelBox.x + wheelBox.width / 2, wheelBox.y + wheelBox.height / 2);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100);
  await settle();
  const zoomCounters = await page.evaluate('({ ...__kinect.timeline.counters })');
  check(zoomCounters.laneRepositions >= 6 && zoomCounters.laneRebuilds === 0,
    '  and eight wheel notches take the cheap path every time, never the one that resizes the buffer',
    `${zoomCounters.laneRepositions} repositions, ${zoomCounters.laneRebuilds} rebuilds`);

  // The keys, pressed rather than trusted. Three rows in this section used to read a
  // `SHORTCUTS` string back through `__probe` and assert the legend named the key just
  // pressed - the legend was what `?` printed onto the application bar's message chip.
  // The chip went, so `?` prints nothing, so the string had no reader but those rows and
  // came out; a constant kept alive by checks about a display that does not exist is the
  // shape `exemption-outlives-its-export` is named for. The presses below are the half
  // that was always the point.
  // **The playhead is put inside the window rather than at a second written down here.**
  // This was `seek(15)` against a window set at 0.2..0.8 of the clip, and the two numbers
  // are only compatible for a take between about 19s and 75s long: on the 9.4s sample the
  // seek clamps to the end and on the 75.6s fixture 0.2 of the clip is 15.12s, so the
  // playhead sat 0.12s to the *left* of the window before the zoom ever ran. `zoomAbout`
  // holds its anchor where it is in the window, so an anchor outside stays outside, and
  // the row below reddened reporting a build that had done exactly what it should. A
  // constant second and a fractional window are two spellings of one position and only
  // agree on the take somebody happened to have open; taking the position off the window
  // that was just set asks the question this row means on any take long enough to hold it.
  await page.evaluate('__kinect.editor.view.set(0.2, 0.8)');
  const zoomWindow = await page.evaluate('__kinect.editor.view.window()');
  await page.evaluate(`__kinect.timeline.transport().seek(${(zoomWindow.startSec + zoomWindow.endSec) / 2})`);
  await settle();
  const beforeKeyZoom = await page.evaluate('__kinect.editor.view.window()');
  const parkedFor = await page.evaluate('__kinect.timeline.transport().programSec');
  check(parkedFor > beforeKeyZoom.startSec && parkedFor < beforeKeyZoom.endSec,
    'the playhead is inside the window before the zoom, which is what the row below is about',
    `playhead ${parkedFor.toFixed(2)}s in ${beforeKeyZoom.startSec.toFixed(2)}s..${beforeKeyZoom.endSec.toFixed(2)}s`);
  await focusStage();
  await page.keyboard.press('=');
  await settle();
  const afterIn = await page.evaluate('__kinect.editor.view.window()');
  await page.keyboard.press('-');
  await settle();
  const afterOut = await page.evaluate('__kinect.editor.view.window()');
  check(afterIn.spanSec < beforeKeyZoom.spanSec * 0.95 && near(afterOut.spanSec, beforeKeyZoom.spanSec, 1e-6),
    '+ zooms the ruler in and - takes it back, both about the playhead',
    `${beforeKeyZoom.spanSec.toFixed(3)}s -> ${afterIn.spanSec.toFixed(3)}s -> ${afterOut.spanSec.toFixed(3)}s`);
  const held = await page.evaluate('__kinect.timeline.transport().programSec');
  check(afterIn.startSec < held && afterIn.endSec > held,
    '  and the playhead is still inside the window after zooming in, which is what "about" means',
    `playhead ${held.toFixed(2)}s in ${afterIn.startSec.toFixed(2)}s..${afterIn.endSec.toFixed(2)}s`);

  // Panning a window of the width you already have, which is the one thing the keyboard
  // could not do. Zoom, fit and frame all *resize*; moving a narrow window along a long
  // clip was reachable only by dragging the overview box, and the box and its two edges
  // are `div` and `i` elements with no tabindex and nothing but pointer handlers - so at
  // a close zoom there was no keyboard route from one end of the clip to the other.
  //
  // The span is asserted alongside the position, because a "pan" that also resized would
  // move the start and pass a row reading the start alone - and resizing is what every
  // other key on this surface already does.
  await page.evaluate('__kinect.editor.view.set(0.4, 0.5)');
  await settle();
  const beforePan = await page.evaluate('__kinect.editor.view.window()');
  await focusStage();
  await page.keyboard.press('.');
  await settle();
  const keyPanned = await page.evaluate('__kinect.editor.view.window()');
  await page.keyboard.press(',');
  await settle();
  const panBack = await page.evaluate('__kinect.editor.view.window()');
  check(near(keyPanned.startSec - beforePan.startSec, beforePan.spanSec * 0.25, 1e-3),
    '. pans the window a quarter of itself along the clip',
    `${beforePan.startSec.toFixed(3)}s -> ${keyPanned.startSec.toFixed(3)}s, a quarter is `
    + `${(beforePan.spanSec * 0.25).toFixed(3)}s`);
  check(near(keyPanned.spanSec, beforePan.spanSec, 1e-6),
    '  without resizing it, which is what every other key on this surface does',
    `${beforePan.spanSec.toFixed(4)}s -> ${keyPanned.spanSec.toFixed(4)}s`);
  check(near(panBack.startSec, beforePan.startSec, 1e-3) && near(panBack.spanSec, beforePan.spanSec, 1e-6),
    '  and , brings it back', `${keyPanned.startSec.toFixed(3)}s -> ${panBack.startSec.toFixed(3)}s`);

  // **A round trip has to come back.** The window is stored as fractions and its minimum
  // is in seconds, so the two disagree the moment the duration moves - and a clamp applied
  // to its own previous output only ratchets outward. At 0.1x the clip is 480s and the
  // 0.25s minimum is a fraction of 0.00052; at 4x that fraction is 0.00625s of a 12s clip,
  // the clamp widens it, and coming back to 0.1x the widened fraction is 10s. The document
  // returns exactly and commits no undo step, so a ruler forty times wider than it started
  // is the one thing the speed control claims not to do.
  //
  // The rate goes through the page's own mapping and the rate that came out is checked
  // against the one that went in, because the slider's travel is logarithmic and its
  // `value` is a position rather than a rate.
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await settle();
  const slowRate = await driveRate(0.1);
  await page.evaluate('__kinect.editor.view.set(0.5, 0.5)');
  await settle();
  const atMin = await page.evaluate('__kinect.editor.view.window()');
  const fastRate = await driveRate(4);
  const atFast = await page.evaluate('__kinect.editor.view.window()');
  const backRate = await driveRate(0.1);
  const atBack = await page.evaluate('__kinect.editor.view.window()');
  check(near(slowRate, 0.1, 1e-6) && near(fastRate, 4, 1e-6) && near(backRate, 0.1, 1e-6),
    'the round trip really went 0.1x -> 4x -> 0.1x, or the rows below mean nothing',
    `${slowRate}x, ${fastRate}x, ${backRate}x`);
  check(near(atMin.spanSec, 0.25, 1e-6),
    '  and the window was at the 0.25s minimum before it', `${atMin.spanSec.toFixed(6)}s`);
  check(atFast.spanSec >= 0.25 - 1e-9,
    '  and never went below the minimum in the middle of it, which is what the clamp is for',
    `${atFast.spanSec.toFixed(6)}s at 4x`);
  check(near(atBack.spanSec, atMin.spanSec, 1e-6),
    '  and comes back to exactly the window it started at, rather than to what the clamp left',
    `${atMin.spanSec.toFixed(6)}s -> ${atBack.spanSec.toFixed(6)}s`);
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();

  // **A control at the end of its travel should do nothing, not something else.** At the
  // minimum window another notch inward asks for a span the clamp refuses - and the clamp
  // could only widen the span, so it kept the start computed for the narrower one and the
  // window slid sideways instead. A gesture that could not zoom panned, and the time under
  // the pointer walked away a notch at a time.
  //
  // Probed at the clamp rather than from a wide window, which is where the existing zoom
  // rows sit and why they never saw this: at 0.2..0.8 every notch has room to zoom.
  await page.evaluate('__kinect.editor.view.set(0.5, 0.5)');
  await settle();
  const atFloor = await page.evaluate('__kinect.editor.view.window()');
  const underPointer = (win) => win.startSec + win.spanSec * 0.25;
  const anchorSec = underPointer(atFloor);
  // Driven by the wheel over the bed, which is the path the report names and the one a
  // user has - the window hook exposes `set` and `fit` but not the zoom.
  const floorBed = await page.locator('#tBed').boundingBox();
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(floorBed.x + floorBed.width * 0.25, floorBed.y + floorBed.height / 2);
    await page.mouse.wheel(0, -120);
    await new Promise((r) => setTimeout(r, 80));
  }
  await settle();
  const stillAtFloor = await page.evaluate('__kinect.editor.view.window()');
  check(near(atFloor.spanSec, 0.25, 1e-6),
    'the window really is at the minimum before the notches, or the clamp is not the thing under test',
    `${atFloor.spanSec.toFixed(6)}s`);
  check(near(stillAtFloor.spanSec, atFloor.spanSec, 1e-9),
    '  and three more zoom-ins at the clamp leave the width where it is',
    `${atFloor.spanSec.toFixed(6)}s -> ${stillAtFloor.spanSec.toFixed(6)}s`);
  check(near(stillAtFloor.startSec, atFloor.startSec, 1e-6),
    '  and leave the window where it is rather than panning it out from under the pointer',
    `${anchorSec.toFixed(4)}s under the pointer, window `
    + `${atFloor.startSec.toFixed(4)}s -> ${stillAtFloor.startSec.toFixed(4)}s`);
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();

  // **The seek storm has one more door, and it is a playhead sitting on a cut.** After a
  // rescale the boundary is a float and the playhead is a frame, so a playhead that was
  // exactly on `clipIn` can land a fraction of a frame outside the rescaled one - and
  // `setClipInOut` buys a full accurate seek for it, on every `input` event of a drag.
  // The count row further up parks the playhead in the interior and cannot see this.
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await settle();
  await page.evaluate('__kinect.timeline.transport().seek(10)');
  await settle();
  await page.locator('#tSetIn').click();
  await settle();
  const onCut = await page.evaluate(`(() => ({
    programSec: __kinect.timeline.transport().programSec,
    in: __kinect.editor.clipRange().in,
  }))()`);
  check(near(onCut.programSec, onCut.in ?? -1, 1e-9),
    'the playhead is sitting exactly on the in point, which is the case the count row never drives',
    `playhead ${onCut.programSec.toFixed(4)}s, in ${(onCut.in ?? -1).toFixed(4)}s`);
  await page.evaluate('__kinect.timeline.counters.seeks = 0');
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    for (let i = 0; i < 12; i++) {
      el.value = String(__kinect.editor.rateSlider.toValue(2.3 + i * 0.01));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await settle();
  const boundarySeeks = await page.evaluate('__kinect.timeline.counters.seeks');
  check(boundarySeeks <= 2,
    '  and twelve slider steps from there still cost one accurate seek, not one per step',
    `${boundarySeeks} seeks`);
  await page.locator('#tClearRange').click();
  await page.evaluate(`__kinect.keyframes.setRetime({ rate: 1, keys: [] })`);
  await settle();

  // **A wheel notch is not three pixels, and on Firefox that is what it reports.**
  // `deltaMode` is `DOM_DELTA_LINE` there and on some Linux mice, so a rule dividing by
  // 100 turned a full notch into 3% of one and the zoom read as a control that does
  // nothing. Driven as the two arms of the same gesture: one notch in lines against the
  // same notch already in pixels, which must land in the same place.
  //
  // The pixel arm is the control. Without it this is a row about zooming rather than
  // about the unit, and would go green on a build that ignored the wheel entirely.
  const wheelArm = (mode, dy) => page.evaluate(`(async () => {
    __kinect.editor.view.set(0.2, 0.8);
    const bed = document.getElementById('tBed');
    const r = bed.getBoundingClientRect();
    bed.dispatchEvent(new WheelEvent('wheel', {
      deltaY: ${dy}, deltaMode: ${mode}, bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    await __kinect.timeline.settled();
    return __kinect.editor.view.window();
  })()`);
  const inPixels = await wheelArm(0, -66);
  const inLines = await wheelArm(1, -3);
  const openSpan = inPixels.duration * 0.6;
  check(inPixels.spanSec < openSpan * 0.95,
    'a wheel notch reported in pixels zooms the ruler',
    `${openSpan.toFixed(3)}s -> ${inPixels.spanSec.toFixed(3)}s`);
  check(near(inLines.spanSec, inPixels.spanSec, 1e-6),
    '  and the same notch reported in lines zooms it by exactly as much',
    `pixels ${inPixels.spanSec.toFixed(4)}s, lines ${inLines.spanSec.toFixed(4)}s`);
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();

  // The way back, and the way to the edit. Both are keys because a window you can only
  // leave with a wheel is a window somebody gets stuck in.
  await focusStage();
  await page.keyboard.press('f');
  await settle();
  check((await page.evaluate('__kinect.editor.view.window()')).whole,
    'f fits the whole clip back on the ruler', JSON.stringify(await page.evaluate('__kinect.editor.view.window()')));
  await page.evaluate('__kinect.timeline.transport().seek(4)');
  await settle();
  await page.locator('#tSetIn').click();
  await page.evaluate('__kinect.timeline.transport().seek(9)');
  await settle();
  await page.locator('#tSetOut').click();
  await focusStage();
  await page.keyboard.press('z');
  await settle();
  const framed = await page.evaluate('__kinect.editor.view.window()');
  check(framed.startSec < 4 && framed.endSec > 9 && framed.spanSec < framed.duration / 2,
    'z frames the trimmed range, which is the window an edit is actually made in',
    `${framed.startSec.toFixed(2)}s..${framed.endSec.toFixed(2)}s around in 4s / out 9s`);
  await page.locator('#tClearRange').click();
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();

  // =====================================================================
  console.log('\n[11] the strip is bounded, and the splitter is what bounds it');
  // =====================================================================
  //
  // Every keyed parameter used to add a permanent row and take that height off the
  // stage with nothing to give it back - eight lanes is 280px of a 900px window gone,
  // and the only way to reclaim it was to delete keys.
  //
  // Section 6 asserts the strip is exactly the height the stage was sized against, and
  // it still does. This is the other half of that: the height is now a number a person
  // sets, and the rows below are about the two bounds on what they can set it to.
  // **Enough lanes to stack past the ceiling, and that is the arm rather than the
  // scenery.** Eight came to 280px against a ceiling of 415, so the height was limited
  // by the content and not by the clamp - and the clamp row below passed on a build
  // with the clamp removed, because `min(stacked, ...)` was still holding it. A probe
  // standing where both answers agree, measured rather than reasoned: `splitter-
  // unclamped` came back NOT CAUGHT at eight lanes and reddens the row at fourteen.
  // Look parameters only - `spin` was in this list and is tagged `view`, so it took no
  // lane and the count assertion read one short.
  const LANED = ['bloom', 'grain', 'scanlines', 'rgbSplit', 'glitch', 'trails', 'rim',
    'thermal', 'edges', 'scan', 'noise', 'denoise', 'exposure'];
  // The value each key holds is asked of the registry rather than assumed, because
  // `denoise` is a step parameter and a key holding 0.2 makes `normalise` throw the
  // moment anything evaluates the track. This list carried 0.2 and 0.5 into all
  // thirteen from the day it was written and nothing ever said so: every arm below
  // measured heights, and a height is read off the layout without a frame being
  // rendered. It surfaced the first time a row here seeked - which is the plainest
  // form of a fixture that is wrong in a direction nothing in its section can see.
  const plantLanes = () => page.evaluate(`(() => {
    const spec = {};
    for (const n of ${JSON.stringify(LANED)}) {
      spec[n] = typeof __kinect.params.spec(n).default === 'boolean'
        ? [{ t: 1, value: false }, { t: 5, value: true }]
        : [{ t: 1, value: 0.2 }, { t: 5, value: 0.5 }];
    }
    __kinect.keyframes.setTracks(spec);
  })()`);
  await plantLanes();
  await settle();
  const manyLanes = await page.evaluate('__kinect.editor.strip()');
  check(manyLanes.stacked > manyLanes.ceiling && (await lanes()).length === LANED.length,
    'enough keyed parameters and the lanes want more height than the stage can spare',
    `${(await lanes()).length} lanes stacking ${manyLanes.stacked}px against a ${manyLanes.ceiling}px ceiling, `
    + `strip ${manyLanes.height}px`);

  const gripAt = () => page.locator('#tGrip').boundingBox();
  const dragGrip = async (by) => {
    const g = await gripAt();
    await page.mouse.move(g.x + g.width / 2, g.y + 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + 2 + by, { steps: 6 });
    await page.mouse.up();
    await settle();
    return page.evaluate('__kinect.editor.strip()');
  };

  const shrunk = await dragGrip(150);
  check(shrunk.lanes < manyLanes.lanes - 100 && shrunk.height < manyLanes.height - 100,
    'dragging the splitter down gives the height back to the stage',
    `lanes ${manyLanes.lanes}px -> ${shrunk.lanes}px, strip ${manyLanes.height}px -> ${shrunk.height}px`);
  check(shrunk.lanes < shrunk.stacked && shrunk.scrollable,
    '  and the lanes it no longer has room for scroll rather than being cut off',
    `${shrunk.lanes}px of ${shrunk.stacked}px stacked, scrollable ${shrunk.scrollable}`);

  // Optional-chained, like every other reach into the strip below it. A mutation that
  // empties the strip must be able to redden these rows without taking the run down with
  // it - `lanes-clear-siblings` removes `#tLanes` along with everything else it clears,
  // and a raw dereference here discarded 140 correct assertions as DID NOT RUN.
  await page.evaluate("(() => { const el = document.getElementById('tLanes'); if (el) el.scrollTop = 60; })()");
  await new Promise((r) => setTimeout(r, 120));
  const scrolled = await page.evaluate('__kinect.editor.strip()');
  check(scrolled.railScrollTop === scrolled.scrollTop && scrolled.scrollTop === 60,
    '  and the rail follows them, or every lane would be labelled with its neighbour',
    `lanes at ${scrolled.scrollTop}px, rail at ${scrolled.railScrollTop}px`);

  // And the other way into the same scroller, which the wheel rows cannot speak for. A
  // lane covers its row and declared `touch-action: none`, so on a touchscreen the
  // browser could not pan the stack natively and a lane below the fold was unreachable -
  // the delegated pointer handler returns on anything that is not a key or a handle, so
  // nothing picked the gesture up either.
  //
  // Read up the whole ancestor chain rather than off the lane alone, because
  // `touch-action` is intersected along it: a `none` on any ancestor between the lane and
  // the scroller defeats a `pan-y` on the lane, silently and while the one rule anybody
  // would read still says the right thing.
  // A handle only exists for a selected key with a shaped segment either side of it, so
  // one is selected here rather than the row reading `null` and calling it a failure.
  // `bloom` is planted at 0.2 -> 0.5 above, which is a segment with a shape to edit.
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  const touch = await page.evaluate(`(() => {
    const lane = document.querySelector('.tlane');
    if (!lane) return null;
    const chain = [];
    for (let el = lane; el && el.id !== 'tLanes'; el = el.parentElement) {
      chain.push(\`\${el.tagName.toLowerCase()}\${el.id ? '#' + el.id : ''}=\${getComputedStyle(el).touchAction}\`);
    }
    const of = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).touchAction : null;
    };
    return {
      chain, blocked: chain.filter((c) => /=(none|pan-x)$/.test(c)),
      key: of('.tlane .tkey'), handle: of('.tlane .thandle'),
    };
  })()`);
  check(touch !== null && touch.blocked.length === 0,
    '  and a touch swipe can reach them, which no wheel row above can speak for',
    touch === null ? 'no lane to read' : touch.chain.join('  '));
  // The other side of the same rule, and it has to be here or the row above is an
  // instruction to break something else. A scalar key's *value* and an ease handle's
  // vertical component both come from `clientY`, so those two elements need the axis the
  // lane just gave away - inheriting `pan-y` lets the browser claim a vertical drag on a
  // key for scrolling and cancel the pointer sequence, which does not make that edit
  // awkward by touch, it removes it.
  check(touch !== null && touch.key === 'none',
    '  while a key keeps both axes, because its value is the vertical one',
    `key touch-action ${touch?.key}`);
  check(touch !== null && touch.handle === 'none',
    '  and so does an ease handle, for the same reason',
    `handle touch-action ${touch?.handle}`);

  // The clamp. Dragging to the top of the window must not be a way to lose the picture,
  // which is the failure a splitter introduces if nothing bounds it.
  const g = await gripAt();
  await page.mouse.move(g.x + g.width / 2, g.y + 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, 4, { steps: 8 });
  await page.mouse.up();
  await settle();
  const maxed = await page.evaluate('__kinect.editor.strip()');
  const stageShare = (VIEWPORT.height - maxed.height) / VIEWPORT.height;
  check(stageShare >= 0.35,
    '  and dragging it to the top of the window still leaves the stage a third of it',
    `strip ${maxed.height}px of ${VIEWPORT.height}px leaves the stage ${(stageShare * 100).toFixed(1)}%`);
  check(maxed.lanes <= maxed.stacked,
    '  and never taller than the lanes it actually has, so content still cannot grow it',
    `${maxed.lanes}px against ${maxed.stacked}px stacked`);

  // The cost. `resize()` reallocates the drawing buffer and the composer's targets, so
  // a drag that ran it per pointer event is the failure `repositionLanes` was split out
  // to avoid - and Playwright cannot outpace an animation frame, so real mouse moves
  // measure nothing here. The burst is dispatched inside one task and the counter is
  // read inside the same one, which is the only place "did not run synchronously" can
  // be observed. The pointerdown is real, because `setPointerCapture` on a pointer id
  // that never existed throws.
  const gd = await gripAt();
  await page.mouse.move(gd.x + gd.width / 2, gd.y + 2);
  await page.mouse.down();
  const burst = await page.evaluate(`(() => {
    const el = document.getElementById('tGrip');
    if (!el) return { before: -1, afterSync: -1, lanes: -1 };
    const y0 = ${Math.round(gd.y + 2)};
    const before = __kinect.editor.stageResizes();
    for (let i = 1; i <= 40; i++) {
      el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 100, clientY: y0 - i, bubbles: true }));
    }
    return { before, afterSync: __kinect.editor.stageResizes(), lanes: __kinect.editor.strip().lanes };
  })()`);
  await page.mouse.up();
  await settle();
  const afterFrame = await page.evaluate('__kinect.editor.stageResizes()');
  check(burst.afterSync === burst.before,
    'forty splitter moves in one task resize the drawing buffer no times, not forty',
    `${burst.afterSync - burst.before} resizes during the burst`);
  check(afterFrame - burst.before <= 3,
    '  and at most a frame\'s worth once the frame runs, which is what the throttle is for',
    `${afterFrame - burst.before} resizes in total for 40 moves`);

  // The same splitter from the keyboard, and the claim worth asserting is not that the
  // keys work but that they do *only* their own job. `#tGrip` is a `role=separator`
  // carrying a tabindex rather than a form field, so the window handler's `isTyping`
  // guard does not cover it - and Home and End are both the two ends of the splitter's
  // travel and the two clip boundaries the global shortcuts seek to. A keyboard user
  // collapsing the strip got the collapse, a pause and an accurate seek out of one
  // press, which is one gesture reading as two.
  //
  // The playhead is parked at 20s first, away from both cuts, because the stray seek
  // this is looking for lands on a boundary - a probe already sitting on one would
  // watch the seek happen and call it holding still. Section 2 drives the same two keys
  // with the stage focused and asserts that they *do* seek, which is what keeps this
  // from passing on a build whose shortcuts stopped working altogether.
  await page.evaluate('__kinect.timeline.transport().seek(20)');
  await settle();
  await page.evaluate("document.getElementById('tGrip')?.focus()");
  const gripFocused = await page.evaluate("document.activeElement === document.getElementById('tGrip')");
  const parked = await read();
  check(gripFocused && parked.programSec > 1 && parked.programSec < parked.duration - 1,
    'the splitter takes focus, with the playhead parked clear of both ends so a stray seek would show',
    `focused ${gripFocused}, playhead ${parked.programSec.toFixed(3)}s of ${parked.duration.toFixed(2)}s`);
  await page.keyboard.press('Home');
  await settle();
  const homeStrip = await page.evaluate('__kinect.editor.strip()');
  const homeRead = await read();
  check(homeStrip.lanes === 0, 'Home on the splitter collapses the strip', `${homeStrip.lanes}px`);
  check(near(homeRead.programSec, parked.programSec, 1e-3),
    '  and seeks nowhere, because a key another control consumed is not a shortcut',
    `${parked.programSec.toFixed(3)}s -> ${homeRead.programSec.toFixed(3)}s`);
  await page.keyboard.press('End');
  await settle();
  const endStrip = await page.evaluate('__kinect.editor.strip()');
  const endRead = await read();
  check(endStrip.lanes > homeStrip.lanes,
    'End reaches the other end of the splitter\'s travel', `${homeStrip.lanes}px -> ${endStrip.lanes}px`);
  check(near(endRead.programSec, parked.programSec, 1e-3),
    '  and seeks nowhere either', `${parked.programSec.toFixed(3)}s -> ${endRead.programSec.toFixed(3)}s`);
  await focusStage();

  // The height outlives the page, which is the only reason it is in `localStorage` at
  // all - and a build that never called `setItem` would pass every row above. Same
  // shape as the overview box: painted correctly forever, driven by nothing. The
  // reload is the whole test, so it is worth the take opening a second time.
  // Dragged well clear of the default rather than a little way from it. The first
  // version moved 90px and landed at 325 against a 315px default, so `splitter-forgets`
  // was caught by a 10px margin - a row that would have gone quiet the moment somebody
  // changed `DEFAULT_LANES_SHARE`, which is a control passing by coincidence.
  const askedFor = await dragGrip(200);
  const defaulted = Math.round(VIEWPORT.height * 0.35);
  check(Math.abs(askedFor.lanes - defaulted) > 60,
    'the dragged height is nowhere near the default, so the reload row below means something',
    `dragged to ${askedFor.lanes}px against a ${defaulted}px default`);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('!!globalThis.__kinect', null, { timeout: 30000 });
  await page.waitForFunction('!!globalThis.__kinect.timeline.transport()', null, { timeout: 30000 });
  await settle();
  await plantLanes();
  await settle();
  const reloaded = await page.evaluate('__kinect.editor.strip()');
  check(near(reloaded.lanes, askedFor.lanes, 2),
    'the height survives a reload, which is the only reason it is stored at all',
    `${askedFor.lanes}px before, ${reloaded.lanes}px after`);

  // Put it back, so nothing below inherits a strip somebody dragged.
  await page.evaluate('__kinect.keyframes.setTracks({})');
  await page.evaluate("localStorage.removeItem('kinect.lanesHeight')");
  await settle();

  check(errors.length === 0, 'the page reported no errors while any of this happened',
    errors.length ? errors.slice(0, 3).join(' | ') : '');

  // =========================================== 12. a look leaves and arrives as a file
  //
  // The one part of the preset library that is not HTTP: a look goes out through a
  // browser download and comes back through a file input. Neither can be reached from
  // `library-check`, which drives the routes - the download is a Blob the page makes
  // and never sends anywhere, and the import checks the file against the registry
  // *before* the PUT and applies it only after, so both the refusal and the ordering
  // are page-side. That ordering is the half that decides whether a hand-edited preset
  // can put a wrong image on screen or leave a document in the library it was refused
  // from, which is what `import-saves-before-validating` moves. So it is driven here,
  // where there is a browser.
  console.log('\n[12] a look leaves as a file and comes back as one');
  // **This section writes to the real preset library, so it writes only names nobody
  // else could own.** The import goes through the actual `/presets` route and takes the
  // document's name from the file's name, and this file's invocation line points at an
  // ordinary server - so fixed names meant a document called `edited-outside` appearing
  // in somebody's picker for good, and replacing a look of theirs if they had one.
  //
  // The first attempt at fixing that snapshotted the three names, deleted them, and put
  // them back afterwards. That is worse than what it replaced, and only in the case that
  // matters: the store refuses a write whose version is not current, so a user holding a
  // *version 3* preset under one of these names would have it deleted, the restoring PUT
  // rejected, and the run report PASS over the loss. Restoring is a promise that can
  // fail; not touching anything cannot.
  //
  // So the names carry the pid and a timestamp, they cannot collide with a document a
  // person made, and the run asserts they were absent to begin with rather than assuming
  // it - which is also what makes "a refused file never reaches the library" below a
  // statement about this run. Cleanup deletes only what this run created, and a delete
  // that does not answer ok is a failed row rather than a silent leak.
  await page.locator('#panelTabLook').click();
  const nonce = `ec${process.pid}-${Date.now().toString(36)}`;
  const NAME_EDITED = `${nonce}-edited-outside`;
  const NAME_BAD = `${nonce}-not-a-look`;
  const NAME_PROTO = `${nonce}-proto`;
  // The sparse look this run authors through the dialog. It is a name of its own rather
  // than a reuse of the one above because it becomes a document - the import path PUTs
  // what it reads - and a run that wrote two different shapes under one name would be
  // asserting about whichever landed last.
  const NAME_PART = `${nonce}-part-of-a-look`;
  // The document the two-saves-at-once rows write. It is a whole look, so its own save
  // stamps the clip - which is the value the race corrupts and therefore the one those
  // rows have to be able to read afterwards.
  const NAME_RACE = `${nonce}-two-at-once`;
  // The sparse look the *save* button authors, which is a different door from the one
  // `NAME_PART` goes through and needs a name of its own so the store can be asked what
  // each of them actually wrote.
  const NAME_SAVED_PART = `${nonce}-saved-part`;
  // The five documents that must never become documents. They are named here with the
  // rest rather than left anonymous because the free-before-the-run check and the cleanup
  // are what make "a refused file never reaches the library" a statement about this run -
  // and `envelope-unchecked` is a mutation that makes one of them land, so the cleanup
  // has to know about it.
  const NAME_NO_VALUES = `${nonce}-no-values`;
  const NAME_EMPTY_VALUES = `${nonce}-empty-values`;
  const NAME_LIST_VALUES = `${nonce}-list-values`;
  const NAME_PART_READINGS = `${nonce}-part-readings`;
  const NAME_STRAY_KEY = `${nonce}-stray-key`;
  const MADE = [NAME_EDITED, NAME_BAD, NAME_PROTO, NAME_PART, NAME_RACE, NAME_SAVED_PART,
    NAME_NO_VALUES, NAME_EMPTY_VALUES, NAME_LIST_VALUES, NAME_PART_READINGS, NAME_STRAY_KEY];
  for (const n of MADE) {
    const r = await fetch(`${URL_BASE}/presets/${n}`);
    check(!r.ok, `the fixture name ${n} is free before the run, or nothing below is about this run`,
      r.ok ? 'a document already exists under it' : 'absent');
  }
  const cleanupPresets = async () => {
    for (const n of MADE) {
      const probe = await fetch(`${URL_BASE}/presets/${n}`);
      if (!probe.ok) continue;
      // The content type is required even here: `/presets/:name` is a mutating route and
      // the step 7 write guard refuses a request that does not declare JSON, DELETE
      // included. A bare one comes back 415 and leaves the document exactly where it was,
      // which reads as a delete that worked.
      const res = await fetch(`${URL_BASE}/presets/${n}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      }).catch((err) => ({ ok: false, status: err.message }));
      check(res.ok, `and the fixture ${n} this run created was removed again`,
        res.ok ? 'deleted' : `DELETE answered ${res.status}`);
    }
  };
  try {
    const known = { bloom: 2.75, grain: 0.66, readBlackwall: 1, readRgb: 0 };
    await page.evaluate(`globalThis.__kinect.applyPreset(${JSON.stringify(known)})`);
    // Moved again *after* the apply and never saved, which is what makes the row below
    // able to fail. `exportPresetFile` takes its name from the picker and its values
    // from the live look, and the whole of that distinction is invisible to a probe
    // whose look and whose stored document agree - a build exporting the picker's
    // document instead of the screen would write a file containing `known` and pass.
    // 3.9 exists in neither the picker's document nor any shipped look.
    const onlyOnScreen = 3.9;
    await page.evaluate(`globalThis.__kinect.params.set('bloom', ${onlyOnScreen})`);
    await settle();

    // **The dialog stands between the button and the file now, so this drives it rather
    // than reaching past it.** Everything below goes through the rendered controls -
    // the export button, the checkboxes, the confirm - because the picker is a seam
    // with two sides, and a probe that called `pickPresetSubset` or handed a name list
    // to `presetFromCurrentLook` would attach below it and pass on a build whose boxes
    // are wired to nothing. That is `level-check` section 5's lesson arriving in a
    // different instrument: arms that all attach on the same side of a seam measure one
    // of them.
    //
    // **Every one of those gestures starts through `openPicker`, and the waiting it does
    // first is not politeness.** These controls hold one gesture at a time now, so a
    // press that lands while the previous one is still unwinding is correctly dropped -
    // and the obvious thing to wait for, the dialog reporting `open === false`, is a
    // task too early: `close()` clears that flag synchronously and queues its `close`
    // event, and the promise the handler is awaiting settles from that event. So a
    // driver can be past the wait, through a Node-side fetch, and still pressing into a
    // gesture that has not finished. It cost a whole run to find - a mutation run died
    // at 238 of 274 with zero failed assertions, which is a crash reading as a catch.
    // The page publishes the guard's own state and this waits on that, which
    // is the only observable that means what the sentence means.
    //
    // **And the guard covers every preset control now, not only the two that share the
    // dialog**, because the value it protects is the provenance stamp and the apply and
    // the import write that too. So the same wait goes in front of the file input and the
    // apply button as well - `presetIdle` below - or a driver that pressed straight after
    // an import would be dropped by a build that is working exactly as designed.
    const presetIdle = () => page.waitForFunction(
      '!globalThis.__kinect.library.presetGestureRunning()', null, { timeout: 15000 });
    // Focused before it is clicked, which is what a hand does and what a programmatic
    // `click()` does not - and the caret has to start on the control or the row below
    // asserting it comes back is asserting that the body still has it.
    const openPicker = async (id) => {
      await presetIdle();
      await page.focus(`#${id}`);
      await page.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
      await page.waitForFunction("document.getElementById('presetPick').open === true", null, { timeout: 10000 });
    };
    // **Applying is choosing now, and this drives the entry rather than a button.** The
    // look control stopped being a `<select>` with an `apply` beside it and became a
    // picker that applies what is chosen, so `#tPresetApply` is not a control that is
    // disabled or hidden - it is one the design retired, and every row below that used to
    // press it comes through here instead.
    //
    // Through the option the way a hand reaches it, and not by calling `choosePicker`.
    // The gesture guard sits on the path from the press: a probe that called the function
    // would be exercising the applying and reporting on the gesture, which is the shape
    // `docs/instruments.md` records as a check testing its own helper. `#tPresetList` is
    // the listbox and `.pickeroption[data-name]` is how every reader of it finds an entry,
    // including `main.js`.
    //
    // **It answers whether the entry was there rather than waiting thirty seconds for one
    // that will not arrive.** Every name this helper is asked for got into the library by
    // being imported earlier in the section, so a mutation that makes an import refuse
    // takes the entry with it - and `page.click` on a selector matching nothing waits out
    // its whole default timeout and then throws, which arrives as `DID NOT RUN` with the
    // rows that had already reddened thrown away. Measured on exactly that:
    // `readings-tick-alone` reddened its two rows and then killed the run at the click.
    // A tool that crashes where it should redden reports nothing about the build.
    const applyByChoosing = async (name) => {
      await presetIdle();
      await page.click('#tPreset');
      await page.waitForFunction("document.getElementById('tPresetList').hidden === false",
        null, { timeout: 10000 });
      const entry = page.locator(`#tPresetList .pickeroption[data-name=${JSON.stringify(name)}]`);
      const there = await entry.count() > 0;
      // Shut again through the trigger, which is the toggle `definePicker` binds - a list
      // left open would take the pointer for every row after this one.
      if (there) await entry.click();
      else await page.click('#tPreset');
      return there;
    };
    // Every import in this section goes through here for the same reason.
    const importFile = async (path) => {
      await presetIdle();
      await page.setInputFiles('#tPresetFile', path);
    };
    await openPicker('tPresetExport');
    const offered = await page.evaluate(`(() => {
      const boxes = [...document.querySelectorAll('#ppGroups input[id^="pp-"]')];
      const heads = [...document.querySelectorAll('#ppGroups input[id^="ppg-"]')];
      return {
        named: boxes.map((b) => b.id.slice(3)),
        ticked: boxes.filter((b) => b.checked).length,
        heads: heads.length,
        whole: heads.filter((h) => h.checked && !h.indeterminate).length,
      };
    })()`);
    const lookNames = await page.evaluate("globalThis.__kinect.params.names('look')");
    const noBox = lookNames.filter((n) => !offered.named.includes(n));
    const extraBox = offered.named.filter((n) => !lookNames.includes(n));
    // Recomputed from the registry rather than read off the dialog's own count, for the
    // reason section 1 recomputes the panel's: the failure being guarded against is a
    // build whose idea of the look tag is what went wrong, and a count it reports about
    // itself agrees with it by construction.
    check(noBox.length === 0 && extraBox.length === 0,
      `the dialog offers every look parameter and only those (${lookNames.length})`,
      noBox.length || extraBox.length ? `no box for ${noBox.join(', ') || 'none'}; not a look value: ${extraBox.join(', ') || 'none'}`
        : `${offered.named.length} boxes`);
    check(offered.ticked === offered.named.length && offered.whole === offered.heads,
      'and every box starts ticked, so the gesture that existed before this dialog writes what it wrote before',
      `${offered.ticked} of ${offered.named.length} ticked, ${offered.whole} of ${offered.heads} headings whole`);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate("document.getElementById('ppGo').click()"),
    ]);
    const saved = join(TMP, download.suggestedFilename());
    await download.saveAs(saved);
    const exported = JSON.parse(readFileSync(saved, 'utf8'));
    check(/\.braindance-preset\.json$/.test(download.suggestedFilename()),
      'export writes a named file the browser actually downloaded', download.suggestedFilename());
    // The bytes are the document, so the assertion is on the values rather than on a
    // shape this file invents: what came out has to be the look that was on screen.
    const expected = { ...known, bloom: onlyOnScreen };
    const wrong = Object.entries(expected).filter(([n, v]) => exported.values?.[n] !== v);
    check(exported.version === PROJECT_VERSION && wrong.length === 0,
      'and what it wrote is the look on screen rather than the document the picker names',
      wrong.length ? wrong.map(([n, v]) => `${n} ${exported.values?.[n]} not ${v}`).join(' ') : `version ${exported.version}, bloom ${exported.values.bloom}`);

    // Edited outside the program, which is the whole point of a file: a look you can
    // put in a repository, mail to somebody, or change in a text editor.
    const edited = join(TMP, `${NAME_EDITED}.braindance-preset.json`);
    const nextBody = { ...exported, values: { ...exported.values, bloom: 4.4, grain: 0.13 } };
    writeFileSync(edited, `${JSON.stringify(nextBody, null, 2)}\n`);
    await page.evaluate("globalThis.__kinect.params.reset(globalThis.__kinect.params.names('look'))");
    await settle();
    await importFile(edited);
    // Waited on the picker's rendered name rather than on a message, because the message
    // is gone and a wait is not decoration - the three rows below read values the import
    // writes, and without something to wait on they would race the fetch and pass on a
    // build that imported nothing. `showPickerChoice` runs on the far side of the apply
    // and paints the trigger, so this is the last thing the gesture does and none of the
    // rows below assert it.
    await page.waitForFunction(
      `document.querySelector('#tPreset .pickervalue')?.textContent === ${JSON.stringify(NAME_EDITED)}`,
      null, { timeout: 15000 });
    await settle();
    const back = await page.evaluate("(() => { const k = globalThis.__kinect; return JSON.stringify({ bloom: k.params.get('bloom'), grain: k.params.get('grain'), readBlackwall: k.params.get('readBlackwall'), stamp: k.library.appliedPreset() }); })()");
    const landed = JSON.parse(back);
    check(landed.bloom === 4.4 && landed.grain === 0.13 && landed.readBlackwall === 1,
      'and importing it puts the edited look on screen', `bloom ${landed.bloom} grain ${landed.grain}`);
    check(landed.stamp?.name === NAME_EDITED,
      'and stamps the clip with where it came from', JSON.stringify(landed.stamp?.name));

    // ---- a look that is deliberately part of one
    //
    // The same door again with boxes unticked, and the rows below are the three claims
    // a subset makes: what the boxes said is what the file carries, the five reading
    // weights move as one, and a document that does not say what the whole look is
    // cannot claim to be where the clip came from. The stamp row is the one that needs
    // the ordering above - the clip is wearing `NAME_EDITED` at this point, so "the
    // stamp did not move" is a statement about a value that is there to move, where the
    // same row taken on a fresh page would pass on a build that had simply not stamped
    // anything yet.
    const ticksNow = `(() => [...document.querySelectorAll('#ppGroups input[id^="pp-"]')]
      .filter((b) => b.checked).map((b) => b.id.slice(3)))()`;
    await openPicker('tPresetExport');
    await page.fill('#ppName', NAME_PART);
    // A heading, pressed as the control it is: one press has to take its whole group
    // out, or the affordance is decoration over fifty individual boxes.
    //
    // **Graded against the panel's own group rather than against a count**, and the
    // first version of this row was the count - `after.length === before.length -
    // off.length`, which is true by construction of a set difference and was therefore
    // a row that could not fail. What "its whole group" means is the parameters the
    // panel puts under that heading, so that is what is read: the two groupings have to
    // be the same grouping, which is the whole reason the dialog derives its headings
    // from `PANEL_GROUPS` instead of listing them again.
    const panelPoints = await page.evaluate(`(() => {
      const group = [...document.querySelectorAll('#panel .group')]
        .find((g) => g.querySelector('label')?.textContent.trim() === 'Points');
      return group ? [...group.querySelectorAll('input')].map((i) => i.id).filter(Boolean).sort() : null;
    })()`);
    const beforeGroup = await page.evaluate(ticksNow);
    await page.click('#ppg-points');
    const afterGroup = await page.evaluate(ticksNow);
    const groupOff = beforeGroup.filter((n) => !afterGroup.includes(n)).sort();
    check(panelPoints !== null && panelPoints.length > 0 && groupOff.join() === panelPoints.join(),
      'unticking a group heading takes exactly the parameters the panel puts under that heading',
      `${groupOff.length} off: ${groupOff.join(', ')}; the panel's Points holds ${(panelPoints ?? ['(no such group)']).join(', ')}`);
    // And one reading, which has to take four others with it. The count is the row's
    // claim; `readings-tick-alone` reduces it to one.
    await page.click('#pp-readDepth');
    const afterReading = await page.evaluate(ticksNow);
    const readingOff = afterGroup.filter((n) => !afterReading.includes(n));
    check(readingOff.length === 5 && readingOff.includes('readDepth'),
      'and unticking one reading weight unticks all five, because half a blend is not a look',
      `${readingOff.length} off: ${readingOff.join(', ')}`);

    const [partDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate("document.getElementById('ppGo').click()"),
    ]);
    const partFile = join(TMP, partDownload.suggestedFilename());
    await partDownload.saveAs(partFile);
    const partBody = JSON.parse(readFileSync(partFile, 'utf8'));
    // Compared against what the boxes actually said rather than against a list of group
    // members kept here, which is the same reasoning the dialog itself is built on: a
    // tool holding its own copy of which parameter sits under which heading is a copy
    // that goes stale, and it would fail looking exactly like the feature breaking.
    const wroteExtra = Object.keys(partBody.values ?? {}).filter((n) => !afterReading.includes(n));
    const wroteNone = afterReading.filter((n) => !Object.hasOwn(partBody.values ?? {}, n));
    check(wroteExtra.length === 0 && wroteNone.length === 0,
      'and the file that comes out names exactly the values that were left ticked',
      wroteExtra.length || wroteNone.length
        ? `${wroteExtra.length} it should not name (${wroteExtra.slice(0, 4).join(', ')}), ${wroteNone.length} missing`
        : `${Object.keys(partBody.values).length} of ${lookNames.length} look values`);

    // Back in through the file input, which is where the format meets the document this
    // dialog just authored. A build whose reading boxes move one at a time writes four
    // of the five weights, and `refusePresetBody` refuses exactly that file - so this
    // row is the format's own opinion of what came out, taken without this file needing
    // to know which parameters are readings.
    //
    // **Read off the picker's rendered name, and the wait cannot end the run.** A build
    // whose reading boxes move one at a time writes a file this program refuses, so
    // waiting for a sign of success is waiting for something that is never going to
    // arrive - fifteen seconds and a throw, which arrives as `DID NOT RUN` and reports
    // nothing about a mutation that had already reddened the row above it. Measured on
    // exactly that: `readings-tick-alone` crashed the run at 231 of 241 assertions before
    // this was a catch and a row.
    //
    // The sign used to be the word `imported` on the application bar's message chip. With
    // the chip gone the discriminator is the trigger's own text: `showPickerChoice` runs
    // only on the far side of a successful `importPresetFile`, so a refused document
    // leaves the picker still naming the previous one. That is the exact difference this
    // row is about, and no row below reads it.
    await importFile(partFile);
    await page.waitForFunction(
      `document.querySelector('#tPreset .pickervalue')?.textContent === ${JSON.stringify(NAME_PART)}`,
      null, { timeout: 15000 }).catch(() => {});
    await settle();
    const importedName = await text('#tPreset .pickervalue');
    check(importedName === NAME_PART,
      'and the format accepts the document this dialog authored, which is the file rule reading back what the control wrote',
      `the picker names ${JSON.stringify(importedName)}, where a refused import would leave ${JSON.stringify(NAME_EDITED)}`);
    const afterPart = await page.evaluate("(() => { const k = globalThis.__kinect; return JSON.stringify({ stamp: k.library.appliedPreset(), grain: k.params.get('grain') }); })()");
    const part = JSON.parse(afterPart);
    check(part.stamp?.name === NAME_EDITED,
      'a preset that is part of a look leaves the clip\'s provenance alone - it did not say what the look is',
      `stamp ${JSON.stringify(part.stamp?.name)}, where the file just imported was ${NAME_PART}`);
    check(part.grain === 0.13,
      'while the values it does name are applied like any other look',
      `grain ${part.grain}`);

    // The same document through the apply button, which is the second door onto
    // `applyStoredPreset` and the one a person uses. It used to be checked by its note -
    // a partial apply reported the count of values it wrote, where naming the stamp's
    // revision would have named a document this gesture did not apply. The note is gone
    // and the rule it was reporting is not, so what is asserted here now is the rule
    // itself at this door: the values land and the provenance does not move.
    // **The name that went in, checked against the name that came out.** The picker stopped
    // being a `<select>`, and `value` on the button that replaced it is a real IDL
    // attribute - so this assignment still means what it always meant. That is exactly the
    // shape `docs/instruments.md` records going wrong silently and in the passing
    // direction, so it is asserted here rather than assumed: a build where the trigger's
    // `value` stopped naming the chosen preset fails on this row instead of on whatever it
    // confused seven rows later.
    const wroteName = await page.evaluate(`(() => {
      const el = document.getElementById('tPreset');
      el.value = ${JSON.stringify(NAME_PART)};
      return el.value;
    })()`);
    check(wroteName === NAME_PART, 'the picker holds the preset name that was written to it',
      `wrote ${JSON.stringify(NAME_PART)}, the control reads ${JSON.stringify(wroteName)}`);
    // Moved off a default first, so "the value landed" is a claim about this apply rather
    // than about what the clip happened to be wearing already - `grain` is 0.13 from the
    // import above and the document about to be applied names it, so without this the row
    // below passes on a build that applies nothing at all.
    await page.evaluate("globalThis.__kinect.params.set('grain', 0.02)");
    await settle();
    const chosePart = await applyByChoosing(NAME_PART);
    await page.waitForFunction("globalThis.__kinect.params.get('grain') === 0.13", null, { timeout: 15000 })
      .catch(() => {});
    await settle();
    const applied = JSON.parse(await page.evaluate(
      "(() => { const k = globalThis.__kinect; return JSON.stringify({ grain: k.params.get('grain'), stamp: k.library.appliedPreset() }); })()"));
    check(chosePart && applied.grain === 0.13,
      'applying a document that names part of a look writes the values it does name',
      chosePart ? `grain ${applied.grain}` : `${NAME_PART} is not in the library to be chosen`);
    check(applied.stamp?.name === NAME_EDITED,
      'and leaves the provenance on the last document that said what the whole look is, rather than claiming this one',
      `stamp ${JSON.stringify(applied.stamp?.name)}, where the document just applied was ${NAME_PART}`);

    // ---- the same subset through the *save*, read back out of the library
    //
    // **Every row above about a sparse document went through the export button**, which
    // downloads a file, and the only thing the save button had been asked to do was open
    // the dialog and be cancelled. The two share `pickPresetSubset` and nothing else: one
    // hands its names to `presetFromCurrentLook` and builds a blob, the other hands the
    // same names to the same function and PUTs the result. A regression in which saved
    // library presets carried the whole look while exported files stayed correct would
    // have passed this entire section, and `picker-ignores-the-boxes` does not close it -
    // that mutation changes the shared answer, so both doors move together and neither is
    // proved against the other.
    //
    // Read back out of the store, which was already the rule here for the reason the
    // cancel row below gives about the same store: a build that reported a save and wrote
    // something else satisfies every row that reads a message. And graded against the
    // boxes as they stood rather than a list kept here, which is the rule the export rows
    // already follow - a tool holding its own copy of which parameter sits under which
    // heading is a copy that goes stale and fails looking like the feature breaking.
    const stampBeforeSave = await page.evaluate('globalThis.__kinect.library.appliedPreset()');
    await openPicker('tPresetSave');
    await page.fill('#ppName', NAME_SAVED_PART);
    await page.click('#ppg-points');
    await page.click('#pp-readDepth');
    const savedTicks = await page.evaluate(ticksNow);
    await page.evaluate("document.getElementById('ppGo').click()");
    // The entry appearing in the picker's own list, which is what `refreshPresets` does on
    // the far side of the PUT - so it is the page saying the write came back, in place of
    // the message the bar used to carry. Read from the list rather than from the server,
    // because the fetch below is the assertion and a wait that fetched the same route
    // would be the row waiting for itself.
    await page.waitForFunction(
      `Boolean(document.querySelector('#tPresetList .pickeroption[data-name="${NAME_SAVED_PART}"]'))`,
      null, { timeout: 15000 }).catch(() => {});
    await settle();
    const savedDoc = await (await fetch(`${URL_BASE}/presets/${encodeURIComponent(NAME_SAVED_PART)}`)).json();
    const savedKeys = Object.keys(savedDoc.body?.values ?? {});
    const savedExtra = savedKeys.filter((n) => !savedTicks.includes(n));
    const savedMissing = savedTicks.filter((n) => !savedKeys.includes(n));
    check(savedTicks.length > 0 && savedTicks.length < lookNames.length
      && savedExtra.length === 0 && savedMissing.length === 0,
      'saving a subset puts exactly the ticked values in the library, which no export row can say',
      savedExtra.length || savedMissing.length
        ? `${savedExtra.length} it should not name (${savedExtra.slice(0, 4).join(', ')}), ${savedMissing.length} missing`
        : `${savedKeys.length} of ${lookNames.length} look values, matching the ${savedTicks.length} boxes left ticked`);
    // And the stamp, which is the save path's own half of the whole-look rule and the
    // half the export cannot have: a file that leaves the program stamps nothing, while
    // a save writes the clip's provenance whenever the document describes the whole
    // look. This one does not, so the clip has to be wearing what it was wearing.
    const stampAfterSave = await page.evaluate('globalThis.__kinect.library.appliedPreset()');
    check(stampAfterSave?.name === stampBeforeSave?.name && stampAfterSave?.rev === stampBeforeSave?.rev,
      'and saving part of a look leaves the clip\'s provenance where it was, because the file does not say what the look is',
      `stamp ${JSON.stringify(stampBeforeSave?.name)} before, ${JSON.stringify(stampAfterSave?.name)} after`);

    // Cancelling writes nothing, and the library is what is asked rather than the note:
    // a build that wrote the document and then said nothing about it would satisfy any
    // row reading the strip.
    const presetsBefore = (await (await fetch(`${URL_BASE}/presets`)).json()).presets.map((d) => d.name);
    await openPicker('tPresetSave');
    await page.fill('#ppName', `${nonce}-never-written`);
    await page.click('#ppCancel');
    await page.waitForFunction("document.getElementById('presetPick').open === false", null, { timeout: 10000 });
    const presetsAfter = (await (await fetch(`${URL_BASE}/presets`)).json()).presets.map((d) => d.name);
    check(presetsAfter.length === presetsBefore.length && !presetsAfter.includes(`${nonce}-never-written`),
      'and cancelling the dialog writes nothing at all',
      `${presetsBefore.length} documents before, ${presetsAfter.length} after`);

    // ---- two saves at once, which the dialog made possible and the `prompt` had not
    //
    // `pickPresetSubset` closes before the PUT it authorised has been answered, so from
    // that instant both controls are live with a write still in flight. Two saves whose
    // responses come back out of order run the stale handler last and leave
    // `appliedPreset` naming the older revision - the provenance stamp saying a look
    // this clip is not wearing, which is the one thing the stamp exists to be right
    // about.
    //
    // **The window is held open rather than aimed at.** `docs/instruments.md` records
    // the rename race measured through its HTTP route coming back one winner and three
    // refusals on a build with the hole, because every await between the driver and the
    // interval widens it - four Playwright clicks would be that mistake again with more
    // moving parts. So the PUT is intercepted and parked, which makes the in-flight
    // state last as long as these rows need instead of microseconds, and the second
    // gesture is attempted inside a state the build cannot get out of on its own.
    //
    // **And the second gesture is tried at every door rather than only at the one that
    // races itself.** Four controls write the provenance stamp - save, apply, import, and
    // the apply on the recorder - and a guard scoped to the two that share the dialog
    // leaves the other two live with the write unanswered. That is the same corruption
    // through a door the guard does not cover: press save, confirm, and apply a whole
    // look while the PUT is parked, and the apply's stamp lands first with the save's
    // overwriting it, so the clip ends up wearing the older revision. Each door needs an
    // observable of its own, so the reads are the requests each one would have to make -
    // a GET for the apply, a second PUT for the import.
    let releasePut = () => {};
    let putsSeen = 0;
    let getsSeen = 0;
    const holdPut = async (route) => {
      if (route.request().method() !== 'PUT') {
        if (route.request().method() === 'GET') getsSeen += 1;
        await route.continue();
        return;
      }
      putsSeen += 1;
      if (putsSeen === 1) await new Promise((resolve) => { releasePut = resolve; });
      await route.continue();
    };
    await page.route('**/presets/**', holdPut);
    try {
      const until = async (ready, what, ms = 15000) => {
        const began = Date.now();
        while (!ready()) {
          if (Date.now() - began > ms) throw new Error(what);
          await new Promise((r) => { setTimeout(r, 20); });
        }
      };
      await openPicker('tPresetSave');
      await page.fill('#ppName', NAME_RACE);
      await page.evaluate("document.getElementById('ppGo').click()");
      await page.waitForFunction("document.getElementById('presetPick').open === false", null, { timeout: 10000 });
      await until(() => putsSeen === 1, 'the save never reached the network, so nothing below is about a write in flight');

      // Three writers and not four, and the missing fourth is the point rather than an
      // omission: the apply door is the picker now, and a picker cannot be disabled the
      // way a button can - its trigger and its entries stay live and the refusal happens
      // on the way in. That is the shape `withPresetGesture`'s own comment argues for, in
      // its words: the guard "is a flag on the program rather than a state of a control,
      // because what has to be true is that there is one gesture, not that a particular
      // button is unpressable". So this row asks the three that carry a disable, and the
      // row below asks the fourth by choosing an entry and finding nothing happens.
      const busy = await page.evaluate(`(() => ({
        save: document.getElementById('tPresetSave').disabled,
        exported: document.getElementById('tPresetExport').disabled,
        imported: document.getElementById('tPresetImport').disabled,
        dialog: document.getElementById('presetPick').open,
      }))()`);
      check(busy.save && busy.exported && busy.imported && !busy.dialog,
        'a preset write in flight disables every control that could start a second one, with the dialog already gone',
        `save disabled=${busy.save}, export disabled=${busy.exported}, `
        + `import disabled=${busy.imported}, dialog open=${busy.dialog}`);

      // The disabled attribute taken off by hand, which is the row that is about the
      // rule rather than about the paint. A guard that lives only on the control is one
      // `removeAttribute` from being absent, and it says nothing about a third writer
      // added later - so what has to hold is that the *gesture* refuses to start.
      const second = await page.evaluate(`(() => {
        const button = document.getElementById('tPresetSave');
        button.disabled = false;
        button.click();
        return { dialog: document.getElementById('presetPick').open };
      })()`);
      check(!second.dialog && putsSeen === 1,
        'and a second save pressed with the disable removed opens no dialog and puts no second write on the wire',
        `dialog open=${second.dialog}, ${putsSeen} PUT reached the network`);

      // The apply door, which is the one the finding came in through: a whole-look
      // document applied while the save is unanswered stamps `appliedPreset`, and the
      // save's own stamp then lands on top of it carrying the older revision. Graded on
      // the request rather than on the stamp, because both builds end this block with the
      // save's name on the clip and only one of them fetched a second document to get
      // there - the corruption is transient and the gesture is what the rule is about.
      // **And there is no disable to take off here, which makes this the stronger half.**
      // The row above had to remove an attribute to reach the rule underneath it; the
      // picker never had one, so choosing an entry mid-write is the gesture arriving at
      // the guard exactly as a hand delivers it. Nothing is staged and nothing is
      // un-disabled - the entry is clicked in the list and the question is whether the
      // program went and fetched it.
      const stampMidRace = await page.evaluate('globalThis.__kinect.library.appliedPreset()');
      const getsBefore = getsSeen;
      await page.click('#tPreset');
      await page.waitForFunction("document.getElementById('tPresetList').hidden === false",
        null, { timeout: 10000 });
      await page.click(`#tPresetList .pickeroption[data-name=${JSON.stringify(NAME_EDITED)}]`);
      await settle();
      const stampAfterApply = await page.evaluate('globalThis.__kinect.library.appliedPreset()');
      const offered = await page.evaluate("document.getElementById('tPreset').value");
      check(offered === NAME_EDITED && getsSeen === getsBefore
        && stampAfterApply?.rev === stampMidRace?.rev,
        'and an entry chosen with a write in flight fetches no document and moves no stamp, so the write cannot be overtaken',
        `${getsSeen - getsBefore} GET on the wire, stamp ${JSON.stringify(stampMidRace?.name)} before `
        + `and ${JSON.stringify(stampAfterApply?.name)} after, offering ${offered}`);
      // **The caret put back where the disable left it, because this probe moved it.**
      // Pressing an entry is a real click and it takes the focus, which the button this
      // door replaced never did - the old probe called `click()` from `page.evaluate` and
      // left the caret on the body. That difference decides the focus row at the end of
      // this block: `whileWriting` restores only from a *stranded* caret, so a picker
      // still holding it means the restore correctly does not fire and the row goes red
      // over the probe rather than over the build. Restoring the precondition, not the
      // answer - the caret goes back to the body the disable dropped it to, and getting
      // it from there onto `#tPresetSave` is still entirely `whileWriting`'s to do.
      await page.evaluate('document.activeElement?.blur?.()');

      // And the import door, on the same reasoning. Its observable is a second PUT: an
      // import writes the file into the library before it applies it, so a build that let
      // this gesture start would have two writes in flight at once and stamp from
      // whichever answered last.
      await page.setInputFiles('#tPresetFile', edited);
      await settle();
      check(putsSeen === 1,
        'and a file chosen with a write in flight starts no second one either, which is the third door onto the same stamp',
        `${putsSeen} PUT reached the network`);

      releasePut();
      // The gesture flag falling, which is `withPresetGesture`'s `finally` and so the last
      // thing the whole gesture does - and the only observable left for "the write came
      // back", now that nothing writes a sentence anywhere when it does. `.catch` for the
      // reason every wait in this file has one: a build where the guard never releases has
      // to redden a row rather than end the run fifteen seconds later with DID NOT RUN.
      await page.waitForFunction('globalThis.__kinect.library.presetGestureRunning() === false',
        null, { timeout: 15000 }).catch(() => {});
      await settle();
      const done = await page.evaluate(`(() => ({
        save: document.getElementById('tPresetSave').disabled,
        exported: document.getElementById('tPresetExport').disabled,
        imported: document.getElementById('tPresetImport').disabled,
        gesture: globalThis.__kinect.library.presetGestureRunning(),
        focus: document.activeElement ? document.activeElement.id || document.activeElement.tagName : null,
        stamp: globalThis.__kinect.library.appliedPreset(),
      }))()`);
      check(done.stamp?.name === NAME_RACE,
        'the write the guard let through finishes and stamps the clip, so the guard refuses a second gesture rather than the first',
        `the stamp names ${JSON.stringify(done.stamp?.name)}`);
      // The flag as well as the three disables, because the picker is the door that has
      // no disable to come back: a build that re-enabled the buttons and left the gesture
      // flag set would satisfy a row reading only attributes, and every later choice in
      // the list would be refused for a write answered minutes ago.
      check(!done.save && !done.exported && !done.imported && done.gesture === false,
        'and every control comes back the moment the write is answered, so the guard is a span rather than a state to get stuck in',
        `save disabled=${done.save}, export disabled=${done.exported}, import disabled=${done.imported}, `
        + `gesture running=${done.gesture}`);
      // The caret, which the guard's own comment claimed it never took and did.
      // `pickPresetSubset` hands focus back to the control that opened the dialog on the
      // `close` event and resolves in the same breath, so the button is holding it when
      // the write span disables that same button a microtask later - which blurs it onto
      // the body, and re-enabling does not undo that. `openPicker` focuses before it
      // clicks for this row's sake: a programmatic `click()` leaves the caret on the body,
      // where a build that stranded it and a build that never had it read identically.
      check(done.focus === 'tPresetSave',
        'and the caret is back on the control that opened the dialog rather than on the body the disable dropped it to',
        `focus is on ${JSON.stringify(done.focus)}`);
    } finally {
      // Unrouted whatever happened above, because a parked PUT handler left installed
      // would hold the first write of every row after this one.
      releasePut();
      await page.unroute('**/presets/**', holdPut);
    }

    // The refusal, and it is the row that matters most: a file is the one door into
    // this program that nothing else validates. `params.apply` meets every value, so a
    // scalar carrying a string throws at that key rather than writing a plausible look
    // - and the image must not have moved on the way to finding out.
    const bad = join(TMP, `${NAME_BAD}.braindance-preset.json`);
    writeFileSync(bad, `${JSON.stringify({ version: PROJECT_VERSION, values: { bloom: 'loud' } }, null, 2)}\n`);
    // **The sentence is read off the console, which is where a refusal lands now.** It was
    // read off the application bar's message chip until that chip was removed, and the
    // sentence itself did not go with it: `refusePresetBody` still throws it and
    // `showTimelineError` still writes it. `page.on('console')` already feeds `errors` for
    // the end-of-run sweep, so the wait is a Node-side poll on that array - there is
    // nothing in the DOM to wait on, which is exactly what changed.
    const badAt = await consoleSettled(errors);
    await importFile(bad);
    const badSaid = await saidOnConsole(errors, badAt, /\[timeline\]/);
    const afterBad = await page.evaluate("globalThis.__kinect.params.get('bloom')");
    check(/bloom/.test(badSaid) && afterBad === 4.4,
      'a malformed file is refused at the key that is wrong, and leaves the look alone',
      `"${badSaid}" with bloom still ${afterBad}`);

    // **And it never became a document**, which the two observations above cannot see.
    // They read the error text and the live look, and a build that PUT the file first
    // and validated afterwards satisfies both while leaving the malformed preset in the
    // library, sitting in the picker looking like a look until somebody chooses it. The
    // whole claim of the import path is that the refusal happens before the store is
    // touched, so the store is what has to be asked. `import-saves-before-validating` is
    // the control: it moves the refusal after the PUT and must fail this row and only
    // this row, because the error still arrives and the look still does not move.
    const storeAfterBad = await (await fetch(`${URL_BASE}/presets`)).json();
    const landedBad = storeAfterBad.presets.find((d) => d.name === NAME_BAD && !d.builtin);
    check(!landedBad,
      'and a refused file never reaches the library, which neither the sentence nor the look can tell you',
      landedBad ? `${NAME_BAD} is in /presets` : `${NAME_BAD} is absent from /presets`);

    // And the prototype question, which a file can ask and an assignment cannot.
    // `JSON.parse` creates `__proto__` as an own enumerable property where
    // `p.x.__proto__ = v` invokes the setter and creates nothing - so this is the one
    // shape that has to be sent as source rather than built in JS, and it is the exact
    // inverse of the JSON.stringify trap this repo already records.
    const proto = join(TMP, `${NAME_PROTO}.braindance-preset.json`);
    writeFileSync(proto, `{ "version": ${PROJECT_VERSION}, "values": { "__proto__": { "polluted": true }, "bloom": 1 } }\n`);
    const parsedHasOwn = Object.keys(JSON.parse(readFileSync(proto, 'utf8')).values).includes('__proto__');
    check(parsedHasOwn, 'the probe really contains __proto__ as an own key, or the row below tests nothing');
    const protoAt = await consoleSettled(errors);
    await importFile(proto);
    const protoSaid = await saidOnConsole(errors, protoAt, /\[timeline\]/);
    const afterProto = await page.evaluate("(() => ({ polluted: ({}).polluted ?? null, bloom: globalThis.__kinect.params.get('bloom') }))()");
    check(/__proto__/.test(protoSaid) && afterProto.polluted === null && afterProto.bloom === 4.4,
      'and a file carrying __proto__ is refused as an unknown parameter, polluting nothing',
      `"${protoSaid}" polluted=${afterProto.polluted}`);

    // ---- the refusals whose *words* are the feature, driven at last
    //
    // Every row above about a refusal reads that a refusal happened - the sentence names
    // `bloom`, the sentence names `__proto__` - and three of this program's refusals were
    // rewritten on the strength of an argument about what they say, with no fixture
    // anywhere driving the shapes they were rewritten for. A message is the whole of what
    // a hand-edited file gets back, so a sentence that fits one document and is read by
    // three is a defect this suite could not see. These rows send the documents and read
    // the sentences.
    //
    // **What "gets back" means has narrowed and the rows have not.** The sentences reached
    // a chip in the application bar and now reach the developer console alone, which is a
    // real loss for the person hand-editing the file - but the words are still written and
    // are still the only account of what was wrong with the document, so they are still
    // worth holding to. Deleting these rows because the display went would leave three
    // refusals free to collapse back into one sentence unnoticed.
    //
    // Sent as files rather than as objects handed to a page function, for the reason the
    // `__proto__` row states one direction and this states the other: the import path is
    // the door, and a probe attaching below it measures a build whose file input is
    // wired to nothing.
    const refuse = async (label, body) => {
      const path = join(TMP, `${label}.braindance-preset.json`);
      writeFileSync(path, `${body}\n`);
      // Settled *before* the mark, so the sentence this read returns is the one this
      // import caused rather than the one the import above it caused arriving late.
      const at = await consoleSettled(errors);
      await importFile(path);
      const said = await saidOnConsole(errors, at, /\[timeline\]/);
      await settle();
      return said;
    };

    // Three documents with no look in them, and they are three different mistakes. One
    // sentence used to serve all three: a file with no `values` key, a file whose `values`
    // is empty, and a file with a list where the object belongs all came back "carries no
    // values object", which is accurate for the first and false on its face for the
    // second. Somebody who has just deleted the last entry out of `values` was sent
    // looking for a key that is in front of them.
    const noValues = await refuse(NAME_NO_VALUES, `{ "version": ${PROJECT_VERSION} }`);
    const emptyValues = await refuse(NAME_EMPTY_VALUES, `{ "version": ${PROJECT_VERSION}, "values": {} }`);
    const listValues = await refuse(NAME_LIST_VALUES, `{ "version": ${PROJECT_VERSION}, "values": [1, 2, 3] }`);
    const distinct = new Set([noValues, emptyValues, listValues]).size === 3;
    check(distinct
      && /no values object/.test(noValues)
      && /nothing in it/.test(emptyValues) && /scope is nothing/.test(emptyValues)
      && /a list where its values should be/.test(listValues),
      'three documents with no look in them get three sentences, each about the shape that arrived',
      `no values key: "${noValues}" | empty values: "${emptyValues}" | a list: "${listValues}"`);

    // The reading rule, whose refusal names *both* ways out. A file carrying two of the
    // five weights can name the other three or delete the two it has, and for a while the
    // sentence named only the exit that adds keys - so somebody who had deliberately cut
    // the blend down to two was told to put three back rather than told that taking two
    // out is the other answer and probably the one they meant. Which readings this build
    // has is read off the page, so the row does not carry a copy of the five names.
    const readings = await page.evaluate('__kinect.readings()');
    const namedTwo = readings.slice(0, 2);
    const missingThree = readings.slice(2);
    const partReadings = await refuse(NAME_PART_READINGS,
      JSON.stringify({
        version: PROJECT_VERSION,
        values: { bloom: 1.2, ...Object.fromEntries(namedTwo.map((n) => [n, 1])) },
      }));
    check(missingThree.every((n) => partReadings.includes(n))
      && namedTwo.every((n) => partReadings.includes(n))
      && partReadings.includes(`Name the other ${missingThree.length}`)
      && partReadings.includes(`take all ${namedTwo.length} it has out`),
      'a file naming some of the reading weights is refused with both ways out of it, not only the one that adds keys',
      `"${partReadings}" against ${namedTwo.join(', ')} named and ${missingThree.join(', ')} missing`);

    // The envelope, which is the half of the document nothing used to read. Every key
    // inside `values` is put to the registry and the keys *around* them were never looked
    // at, so a version 3 field walks through: `mode` is exactly what version 4 dissolved
    // into the five reading weights, it means something specific in the version it
    // belongs to, and answering a file that carries it with silence is the failure the
    // version gate one line above exists to prevent. `bloom` is what it names, at the
    // value already on screen, so a build that accepts it moves no pixel and this row is
    // about the envelope rather than about a look changing.
    const strayKey = await refuse(NAME_STRAY_KEY,
      JSON.stringify({ version: PROJECT_VERSION, mode: 4, values: { bloom: 4.4 } }));
    check(/mode/.test(strayKey) && /preset/.test(strayKey),
      'a document carrying a key beside version and values is refused by name, so a field an older version had is answered rather than ignored',
      `"${strayKey}"`);
    // And it never became a document, which the sentence above cannot tell you: the
    // refusal happens before the PUT, so a build without the envelope check leaves the
    // file in the library looking like a look until somebody picks it.
    const storeAfterStray = await (await fetch(`${URL_BASE}/presets`)).json();
    const landedStray = storeAfterStray.presets.find((d) => d.name === NAME_STRAY_KEY && !d.builtin);
    check(!landedStray,
      'and it never reached the library either, because the envelope is read before the store is touched',
      landedStray ? `${NAME_STRAY_KEY} is in /presets` : `${NAME_STRAY_KEY} is absent from /presets`);
  } finally {
    // In a `finally` rather than after the last row, because a section that threw is
    // exactly when the library is most likely to be left with a fixture in it.
    await cleanupPresets();
  }

  // ============== 13. a refusal is made, the ticks seek, and the auto-save comes back

  console.log('\n[13] a refusal is made with its reason, a ruler tick seeks, and the auto-save is offered back');
  //
  // Three claims that share a shape rather than a subsystem: in each of them the
  // editor already knew the right answer and had no way to say it. The tick knew the
  // program second to seek to and was a `span`; the auto-save was on disk under a name
  // the picker deliberately hides, with nothing offering it back; and the refusal knew
  // the whole reason and had a chip too narrow to show it.
  //
  // **That third one has changed shape rather than been fixed.** The chip was removed
  // from the application bar, so the refusals in this section reach the console and
  // nothing else. Three rows about how the sentence was *drawn* went with it; the rows
  // that remain assert the sentence is produced with its reason in it, which is the half
  // still worth holding a build to.
  //
  // **Before section 13's pin**, because every row here needs the animation loop and
  // the transport, and pinning the drive takes both away for good.
  {
    // A project built on footage this take is not, so pressing Open produces the
    // longest refusal this program writes - which is the one the chip could not fit.
    // A real document through the real store, driven by the real button:
    // a `showTimelineError` called from `page.evaluate` would test the helper and
    // leave the path an operator actually takes unmeasured.
    const OTHER = 'editor-check-other-footage';
    const WORKING = '__working__';
    const putDoc = async (name, body) => {
      const res = await fetch(`${URL_BASE}/projects/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    };
    const dropDoc = (name) => fetch(`${URL_BASE}/projects/${encodeURIComponent(name)}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});

    // Every page error this section is answerable for, and the mark moves once more
    // below. Counted from here rather than from zero because section 12 refuses two
    // malformed presets on purpose and both refusals reach the console, so a row
    // asserting the array is empty would report another section's deliberate work as
    // this one's fault.
    let errorsBefore = errors.length;
    // **Waits for the open to have finished, not for the transport to exist.** The two
    // are two fetches apart: `timeline` is assigned less than halfway through
    // `openTake`, before the library is listed and before the resume offer is decided,
    // so a wait on the transport reads the page before anything has finished writing it -
    // and `settled()` does not close the gap, because a transport with nothing queued is
    // idle in exactly that window. Measured back when this read a message chip: it came
    // back empty here while the identical sequence on a fresh page reported the offer
    // every time.
    const reopen = async () => {
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction('globalThis.__kinect?.library?.opened() === true', null, { timeout: 30000 });
      await settle();
    };

    // ---- what a fresh open of this take actually gives
    //
    // **Measured rather than assumed, and that is the repair this block is.** The
    // documents below have to differ from the clip a fresh open produces, and the first
    // draft built them by toggling `outputSize` on whatever twelve sections of edits
    // had left on screen - which lands on the fresh value roughly half the time and
    // turns the offer's silence into a pass for the wrong reason. So the fresh document
    // is read first and everything else is derived from it.
    await dropDoc(WORKING);
    await reopen();
    const fresh = await page.evaluate('__kinect.keyframes.project()');
    const openHash = await page.evaluate('__kinect.library.takeHash()');
    const openId = await page.evaluate('__kinect.library.takeId()');
    check(typeof openHash === 'string' && openHash.length > 20,
      'the open take has a content hash, which is what the resume offer joins on', String(openHash).slice(0, 24));
    // The offer as an operator meets it: a chip that is either there or not, with the
    // stamp that decides whether they want it. Read as the pair rather than as the
    // text, because a chip left on screen carrying nothing and a chip correctly hidden
    // are the same string and opposite states.
    const offerState = () => page.evaluate(`(() => {
      const chip = document.getElementById('tResume');
      return {
        shown: !chip.hidden && chip.getBoundingClientRect().width > 0,
        when: document.getElementById('tResumeWhen').textContent,
        button: Boolean(document.getElementById('tResumeOpen')),
      };
    })()`);

    const noDocument = await offerState();
    check(!noDocument.shown,
      'a take opened with no working document beside it offers nothing, which is what makes the rows below about the document',
      `chip ${noDocument.shown ? 'shown' : 'hidden'}, "${noDocument.when}"`);

    // The working document as the auto-save writes it: the whole project, stamped with
    // the take. `differ` changes one field away from the value a fresh open gives, and
    // the row below asserts that it did - the offer is deliberately silent when the two
    // agree, so a document that accidentally matched would test the wrong branch.
    // **The field these rows tell two documents apart by, which used to be `outputSize`.**
    // The shape moved onto the document as `aspect` and the pixel count moved onto the
    // deliverable, so `outputSize` is no longer written by `serialiseProjectBody` - and
    // every row below read `undefined` on the restored side the moment it went. They
    // failed rather than passing, which is the arrangement working: the comment further
    // down records that the first draft of one of these moved a field the project does
    // not carry, both sides read `undefined`, and the row passed on every build.
    //
    // Compared joined rather than with `===`, and that is not a detail: `aspect` is an
    // array, so two documents holding the same shape are two objects and `===` is false
    // for every pair. A row that is always red is better than one that is always green
    // and worse than one that asks the question, which is what the join makes it ask.
    const shapeOf = (doc) => (doc?.aspect ?? []).join(':') || 'none';
    const workingBody = (stamp, differ = true) => {
      const body = JSON.parse(JSON.stringify(fresh));
      if (differ) body.aspect = shapeOf(fresh) === '4:3' ? [16, 9] : [4, 3];
      return { ...body, take: stamp };
    };
    // Long enough that it cannot be read off a chip, and different footage besides.
    const foreignHash = `sha256:${'0'.repeat(64)}`;

    // ---- reload one: the offer is made, and then a refusal has to be made with it
    const differing = workingBody({ id: openId, hash: openHash });
    check(shapeOf(differing) !== shapeOf(fresh),
      'the document about to be planted differs from what a fresh open puts on screen, or there is nothing for the offer to be about',
      `${shapeOf(differing)} against ${shapeOf(fresh)}`);
    await putDoc(WORKING, differing);
    await putDoc(OTHER, { ...JSON.parse(JSON.stringify(fresh)), take: { id: 'some-other-take', hash: foreignHash } });
    await reopen();

    const offered = await offerState();
    check(offered.shown && offered.button && /autosaved/.test(offered.when),
      'a working document stamped with this take\'s hash is offered back when it differs from the clip on screen',
      `chip ${offered.shown ? 'shown' : 'hidden'}, "${offered.when}"`);
    // The precondition, in its own row and asked of the list rather than of the chip.
    // Read off the chip it would pass on a hidden one, which is the answer a red row
    // above produces - so it would agree with any failure instead of ruling one out.
    const listedWorking = await page.evaluate(`(async () => {
      const list = (await (await fetch('/projects')).json()).projects ?? [];
      const w = list.find((d) => d.name === '${WORKING}');
      return { there: Boolean(w), stamped: w?.body?.take?.hash ?? null };
    })()`);
    check(listedWorking.there && listedWorking.stamped === openHash,
      'and the library listed the working document carrying this take\'s hash, so the row above is about the offer rather than about a store that answered nothing',
      `${listedWorking.there ? 'listed' : 'absent'}, stamped ${String(listedWorking.stamped).slice(0, 24)}`);

    // **And pressing it puts the work back, which is the only thing the offer is for.**
    // This is the row the first version of the feature could not have passed: the offer
    // was a sentence naming `?project=__working__`, and following it literally replaces
    // the query the editor boots on, drops the `take`, and lands on the gallery. An
    // offer whose recovery path leaves the page is worse than no offer, so what is
    // asserted here is the document on screen afterwards rather than the words.
    await page.click('#tResumeOpen');
    await settle();
    const restored = await page.evaluate('__kinect.keyframes.project()');
    check(shapeOf(restored) === shapeOf(differing),
      'and pressing it restores the autosaved document onto the open take, without leaving the page for a URL that would drop the take',
      `${shapeOf(restored)} against the autosave's ${shapeOf(differing)} and the fresh clip's ${shapeOf(fresh)}`);
    // **And the offer survives the store moving under it.** `__working__` is the one
    // name in this library that rewrites itself: `history.commit()` autosaves over it on
    // every edit, so between the chip appearing and somebody pressing it the document it
    // was offering can already be gone. Fetching the name at that point restores the
    // edit made *since* the offer and calls it a recovery, with the work the operator
    // was looking at overwritten and unrecoverable.
    //
    // The store is moved by writing it directly rather than by driving an edit, because
    // what the defect turns on is that the contents changed between the offer and the
    // press - `history.commit()` is one way to change them and not the property under
    // test. Writing it makes the row say which document came back rather than depend on
    // which control happened to autosave.
    await putDoc(WORKING, differing);
    await reopen();
    const offeredBeforeMove = await offerState();
    // Three distinguishable values, and that is the whole arrangement: the clip a fresh
    // open gives, the document the chip is offering, and what the name holds by the time
    // it is pressed. The first draft of this row moved a field the project does not
    // carry, so both sides read `undefined`, the row passed on every build and the tool
    // reported NOT CAUGHT - which is the honest reading of a row testing nothing.
    const moved = workingBody({ id: openId, hash: openHash }, false);
    await putDoc(WORKING, moved);
    check(offeredBeforeMove.shown && shapeOf(moved) !== shapeOf(differing),
      'the offer is on screen and then the document behind its name is replaced by a different one, which is what an edit made while the chip is up does to it',
      `chip ${offeredBeforeMove.shown ? 'shown' : 'hidden'}, offered ${shapeOf(differing)} against the store's new ${shapeOf(moved)}`);
    await page.click('#tResumeOpen');
    await settle();
    const restoredAfterMove = await page.evaluate('__kinect.keyframes.project()');
    check(shapeOf(restoredAfterMove) === shapeOf(differing),
      'and pressing it restores the document that was offered rather than whatever the name holds by then, since the work it was advertising is the work being recovered',
      `${shapeOf(restoredAfterMove)} against the offered ${shapeOf(differing)} and the store's ${shapeOf(moved)}`);

    // **And the store holds it afterwards, or the recovery lasted only as long as the
    // tab.** Holding the offered body fixed which document the press restores; it did
    // not make the restore survive a reload. `__working__` still held the edit that
    // overwrote the offer, the retained snapshot was the only other copy, and nothing
    // rewrites that slot until the next edit - so closing the page after being told
    // "restored the autosaved edit" loaded the overwriting edit straight back.
    const storedAfterRestore = await page.evaluate(`(async () => {
      const doc = await (await fetch('/projects/${WORKING}')).json();
      return doc.body?.aspect ?? null;
    })()`);
    check(shapeOf({ aspect: storedAfterRestore }) === shapeOf(differing),
      'and the auto-save is rewritten with what was restored, so a reload after the recovery loads the recovered work rather than the edit that had overwritten it',
      `stored ${shapeOf({ aspect: storedAfterRestore })} against the restored ${shapeOf(differing)} and the ${shapeOf(moved)} it had been overwritten with`);

    const afterRestore = await offerState();
    check(!afterRestore.shown,
      'and the offer withdraws once it has been taken, since restoring what is already on screen is a button that does nothing',
      `chip ${afterRestore.shown ? 'still shown' : 'hidden'}`);

    // **And it is the last write, not merely a later one.** The auto-save is
    // fire-and-forget and `DocumentStore.write` gives every write its own numbered
    // scratch file before renaming, so two puts to one document both succeed and the one
    // on disk is whichever `rename` finished last - which has nothing to do with which
    // was asked for first. An edit made just before the operator presses Restore is
    // exactly that case: it can still be on the wire, land after the recovery, and put
    // the overwriting document straight back - after the page has said "restored the
    // autosaved edit" and dropped the only other copy.
    //
    // The competing write is a real auto-save from a real control rather than a put from
    // here, because what has to be ordered is the page's own write path. Held three
    // seconds at the browser so it is unambiguously still in flight when the press lands:
    // the mutated build's restore goes out immediately, finishes first, and the held
    // auto-save then overwrites it.
    await putDoc(WORKING, differing);
    await reopen();
    const armedOffer = await offerState();
    let workingPuts = 0;
    await page.route('**/projects/__working__', async (route) => {
      if (route.request().method() !== 'PUT') { await route.continue(); return; }
      workingPuts++;
      if (workingPuts === 1) await new Promise((done) => { setTimeout(done, 3000); });
      await route.continue();
    });
    // Any control that commits will do, so it is found rather than named - a row keyed to
    // one parameter's id goes quiet the day that parameter is renamed, and what it needs
    // is an auto-save on the wire rather than a particular edit.
    //
    // **Found off the registry rather than off the panel's order**, and that distinction
    // is what this row got wrong first. `#panelBody input[type="checkbox"]` took whatever
    // the panel happened to render first, which was a look value when the row was written
    // and became `colorCam` when the panel gained its groups - a sensor toggle that
    // changes the sensor rather than the document, so it commits nothing and puts no
    // auto-save on the wire. The row caught it, because it asserts the condition it built
    // instead of assuming it; a fixture selected by position is one an unrelated edit to
    // the page silently re-points, which is the same "arrives through the container"
    // shape section 1's selector is written the way it is for.
    //
    // A `step` parameter is the checkbox kind - `panelRow` gives the input the parameter's
    // own name for an id - so this asks the look registry which of its values render as
    // one and takes the first that is on the page.
    const toggled = await page.evaluate(`(() => {
      const steps = __kinect.params.names('look')
        .filter((n) => __kinect.params.spec(n).kind === 'step');
      for (const name of steps) {
        const box = document.getElementById(name);
        if (!box || box.type !== 'checkbox' || !box.closest('#panelBody')) continue;
        box.checked = !box.checked;
        box.dispatchEvent(new Event('change', { bubbles: true }));
        return box.id;
      }
      return null;
    })()`);
    for (let i = 0; i < 12 && workingPuts === 0; i++) {
      await new Promise((done) => { setTimeout(done, 100); });
    }
    // The fixture says whether it built the condition, because a press with nothing in
    // flight is a press both builds survive - the row above it would then be reporting
    // the ordering of one write.
    check(toggled !== null && workingPuts === 1 && armedOffer.shown,
      'an edit\'s auto-save is on the wire and the offer is up, which is the pair the row below needs rather than a press with nothing to race',
      `toggled ${toggled ?? 'nothing - no committing control was found'}, ${workingPuts} auto-save in flight, chip ${armedOffer.shown ? 'shown' : 'hidden'}`);
    await page.click('#tResumeOpen');
    // Past the three-second hold and the write that follows it, so both have landed.
    await new Promise((done) => { setTimeout(done, 6000); });
    await page.unroute('**/projects/__working__');
    const storedAfterRace = await page.evaluate(`(async () => {
      const doc = await (await fetch('/projects/${WORKING}')).json();
      return doc.body?.aspect ?? null;
    })()`);
    check(shapeOf({ aspect: storedAfterRace }) === shapeOf(differing),
      'and the recovery is written after the auto-saves already in flight, so an edit still on the wire cannot land behind it and put back the document the operator just recovered from',
      `stored ${shapeOf({ aspect: storedAfterRace })} against the restored ${shapeOf(differing)}`);

    // **A neighbour that will not list must not take the recovery with it.** Opening a
    // take refreshes three libraries and lets all three fail softly, and the offer used
    // to be withheld unless every one of them came back. That was right while the offer
    // was a sentence on the application bar's message chip, which would have painted over
    // the sentence naming what broke - and it stopped being right the moment the offer
    // became a button, because a button overwrites nothing. What the gate did instead was strand
    // the only control that reaches `__working__`, which the project picker deliberately
    // does not list, on a station whose `--builtin-presets` pointed one directory too
    // high. The autosave was there, intact, stamped with this take, and unreachable.
    //
    // The presets route is refused at the page's edge rather than by misconfiguring a
    // server, so the failure is exactly one list and the row can say which.
    await putDoc(WORKING, workingBody({ id: openId, hash: openHash }));
    await page.route('**/presets', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: '{"error":"the presets directory is not there"}',
    }));
    const brokenAt = await consoleSettled(errors);
    await reopen();
    const brokenSaid = await saidOnConsole(errors, brokenAt, /\[library\]/);
    const offeredAnyway = await offerState();
    await page.unroute('**/presets');
    check(/unavailable/.test(brokenSaid) && /presets/.test(brokenSaid),
      'a presets list that refuses is reported by name, which is what makes the row below about the gate rather than about a request that quietly worked',
      `console said "${brokenSaid.slice(0, 100)}"`);
    errorsBefore = errors.length;
    check(offeredAnyway.shown && offeredAnyway.button,
      'and the autosave is offered anyway, because the projects list is the only one the offer is made of and a broken neighbour is not a reason to hide the work',
      `chip ${offeredAnyway.shown ? 'shown' : 'hidden'}, "${offeredAnyway.when}"`);
    await reopen();

    // **Three rows here were about the box the sentence was drawn in and are gone.** They
    // measured `scrollWidth` against `clientWidth` on the message chip, asserted its
    // `title` carried the whole refusal, and asserted the cut was an ellipsis rather than
    // the sentence pushing the sensor readout off the end of the bar. Every one of them
    // was a claim about a surface that has been removed, and there is no second surface to
    // re-point them at - so the claim they shared, that a long refusal stays readable, is
    // simply not true of this build any more and is recorded as lost rather than restated
    // somewhere it would be trivially satisfied.
    //
    // What is asserted instead is the half that survives: the refusal is *made*, with the
    // reason in it. A project built on other footage must not open, and the console is the
    // only account of why.
    const footageAt = await consoleSettled(errors);
    await page.selectOption('#tProject', OTHER);
    await page.click('#tProjectOpen');
    const footageSaid = await saidOnConsole(errors, footageAt, /\[timeline\]/);
    check(/different footage/.test(footageSaid) && footageSaid.length > 120,
      'a project built on other footage is refused with the whole reason in it rather than a bare failure',
      `${footageSaid.length} characters: "${footageSaid.slice(0, 90)}..."`);
    check(await page.evaluate('globalThis.__kinect.library.opened() === true'),
      'and the editor stays up with the take it already had, because footage that will not open is exactly when somebody needs to see the page',
      `opened ${await page.evaluate('globalThis.__kinect.library.opened()')}`);
    // The refusal above is this section's own doing and `showTimelineError` logs it, so the
    // mark moves past it. Left where it was, the page-error row at the foot of the section
    // would be reporting the fixture it was handed.
    errorsBefore = errors.length;

    // ---- reload two: different footage under the same name
    //
    // The id is deliberately the take's own. A rename frees an id and a later take can
    // be renamed into it, so this is the document that an id comparison accepts and a
    // hash comparison refuses - and accepting it puts somebody's edit on top of
    // material it was never authored against.
    await putDoc(WORKING, workingBody({ id: openId, hash: foreignHash }));
    await reopen();
    const wrongFootage = await offerState();
    check(!wrongFootage.shown,
      'a working document carrying this take\'s id and different footage\'s hash is not offered',
      `chip ${wrongFootage.shown ? 'shown' : 'hidden'}, "${wrongFootage.when}"`);

    // ---- reload three: the same document that is already on screen
    await putDoc(WORKING, workingBody({ id: openId, hash: openHash }, false));
    await reopen();
    const sameAsScreen = await offerState();
    check(!sameAsScreen.shown,
      'and neither is one that matches the clip on screen, since restoring what is already there is not an offer',
      `chip ${sameAsScreen.shown ? 'shown' : 'hidden'}, "${sameAsScreen.when}"`);

    await dropDoc(WORKING);
    await dropDoc(OTHER);

    // ---- the ruler's marks are controls
    //
    // **Under a non-unity rate, and that is the whole of what makes these rows able to
    // fail.** A mark is stored in source milliseconds and drawn in program seconds, and
    // at rate 1 with no keys the two are the same number - so a tick that seeks to the
    // source second would land exactly where a correct one does and the control would
    // prove nothing. The separation is asserted before anything is pressed.
    const RATE = 0.5;
    const MARKS = [
      { id: 'em0', sourceMs: 1000, label: 'first' },
      { id: 'em1', sourceMs: 3000, label: 'second' },
      { id: 'em2', sourceMs: 5000, label: 'third' },
    ];
    await page.evaluate('__kinect.keyframes.setRetime({ rate: 1, keys: [] })');
    await page.evaluate(`(() => {
      const el = document.getElementById('tRate');
      el.value = String(__kinect.editor.rateSlider.toValue(${RATE}));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await focusStage();
    await settle();
    await page.evaluate(`__kinect.editor.setMarks(${JSON.stringify(MARKS)})`);
    await page.evaluate('__kinect.editor.view.fit()');
    await settle();

    const geometry = await page.evaluate(`(() => {
      const total = __kinect.editor.view.window().duration;
      return {
        rate: __kinect.timeline.retime.rate,
        total,
        program: ${JSON.stringify(MARKS)}.map((m) => Math.max(0, Math.min(total,
          __kinect.timeline.retime.programSecAt(m.sourceMs / 1000)))),
        source: ${JSON.stringify(MARKS)}.map((m) => m.sourceMs / 1000),
        ticks: __kinect.library.markTicks().length,
      };
    })()`);
    const TOL = 0.08;
    const separated = geometry.program
      .map((p, i) => Math.abs(p - geometry.source[i]))
      .filter((d) => d > TOL * 4);
    check(geometry.rate !== 1 && separated.length >= 2,
      'the fixture runs at a rate where a mark\'s program second and its source second are different numbers, or nothing below can fail',
      `rate ${geometry.rate}, program ${geometry.program.map((p) => p.toFixed(2)).join('/')}`
      + ` against source ${geometry.source.map((s) => s.toFixed(2)).join('/')}`);
    check(geometry.ticks === MARKS.length, 'every mark drew a tick on the ruler', `${geometry.ticks} ticks`);

    // Pressing the tick. The middle one, so a build that seeked to either end would
    // land somewhere this row can tell apart from the answer.
    await page.evaluate('__kinect.timeline.transport().seek(0)');
    await settle();
    await page.locator('#tMarks .tmk').nth(1).click();
    await settle();
    const pressed = (await read()).programSec;
    check(near(pressed, geometry.program[1], TOL),
      'pressing a mark tick parks the playhead on the program second the tick is drawn at',
      `playhead ${pressed.toFixed(3)}s against the tick's ${geometry.program[1].toFixed(3)}s`
      + ` (the source second is ${geometry.source[1].toFixed(3)}s)`);
    check(!near(pressed, geometry.source[1], TOL),
      'and not on the mark\'s own source second, which is where the retime would be undone',
      `${pressed.toFixed(3)}s against ${geometry.source[1].toFixed(3)}s`);

    // And the keyboard, which is the half that is actually usable on a five-pixel
    // diamond. Through `goTo` like Home and End, so a jump pauses and clamps.
    await page.evaluate('__kinect.timeline.transport().seek(0)');
    await settle();
    await focusStage();
    await page.keyboard.press(']');
    await settle();
    const forward = (await read()).programSec;
    check(near(forward, geometry.program[0], TOL),
      'the next-mark key jumps to the first mark ahead of the playhead',
      `${forward.toFixed(3)}s against ${geometry.program[0].toFixed(3)}s`);
    await page.keyboard.press(']');
    await settle();
    const forwardAgain = (await read()).programSec;
    check(near(forwardAgain, geometry.program[1], TOL),
      'and pressing it again steps to the next one rather than finding the mark it is standing on',
      `${forwardAgain.toFixed(3)}s against ${geometry.program[1].toFixed(3)}s`);
    await page.keyboard.press('[');
    await settle();
    const back = (await read()).programSec;
    check(near(back, geometry.program[0], TOL),
      'and the previous-mark key walks back the way it came',
      `${back.toFixed(3)}s against ${geometry.program[0].toFixed(3)}s`);

    // **And the layouts those two keys are actually typed on.** `[` and `]` are
    // unmodified only on a US or UK keyboard. On German, Nordic and Polish layouts they
    // are AltGr presses, and Windows delivers AltGr by setting ctrl and alt together -
    // so the guard that rejects command modifiers rejected the character as well, and
    // the two keys this section just asserted were unreachable for most of Europe. The
    // rows above cannot see it, because Playwright presses the US key.
    //
    // Dispatched rather than pressed, because that is the only way to say AltGr from
    // here: `page.keyboard` has no modifier for it, while `KeyboardEventInit` carries
    // `modifierAltGraph` and Chromium reports it back through `getModifierState`. Both
    // halves are asserted - the composed press has to work and the bare ctrl+alt press
    // has to go on being refused - because a guard simply deleted would pass the first.
    const pressComposed = async (key, altGraph) => {
      await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)}, ctrlKey: true, altKey: true,
        modifierAltGraph: ${altGraph}, bubbles: true, cancelable: true,
      }))`);
      await settle();
      return (await read()).programSec;
    };
    await page.evaluate('__kinect.timeline.transport().seek(0)');
    await settle();
    await focusStage();
    const altGr = await pressComposed(']', true);
    check(near(altGr, geometry.program[0], TOL),
      'the next-mark key works when it is typed with AltGr, which is how a German, Nordic or Polish keyboard types it at all',
      `${altGr.toFixed(3)}s against ${geometry.program[0].toFixed(3)}s`);
    const plainCtrlAlt = await pressComposed(']', false);
    check(near(plainCtrlAlt, altGr, TOL),
      'and the same two bits without AltGraph behind them move nothing, so the guard still hands ctrl+alt to the browser it belongs to',
      `${plainCtrlAlt.toFixed(3)}s, unmoved from ${altGr.toFixed(3)}s`);
    // The other half of the guard, in the direction the widening could have broken it:
    // AltGr held over a key that is a command rather than a character is the right-hand
    // Alt being used as a modifier, and that is still not ours.
    const altGrArrow = await page.evaluate(`(() => {
      const before = __kinect.timeline.transport().programSec;
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight', ctrlKey: true, altKey: true, modifierAltGraph: true,
        bubbles: true, cancelable: true,
      }));
      return before;
    })()`);
    await settle();
    check(near((await read()).programSec, altGrArrow, TOL),
      'and a named key under the same modifier is still the browser\'s, since AltGr only composes characters and there is no character here',
      `${(await read()).programSec.toFixed(3)}s against ${altGrArrow.toFixed(3)}s`);

    // **And a trimmed clip, which is the case every row above is blind to.** The rows
    // so far run on the whole take, where `Transport.frameAt`'s clamp into in..out
    // cannot change where a press lands - so a key offering marks outside the trim
    // looked identical to one that did not. With an in point at 5s and a mark at 2s,
    // pressing `[` from inside asks to go to 2 and arrives back at 5: the playhead
    // teleports to the edge, and at the edge itself the key reads as unbound.
    await page.evaluate(`__kinect.editor.setMarks([
      { id: 'outside', sourceMs: 2000, label: 'outside' },
      { id: 'inside', sourceMs: 8000, label: 'inside' },
    ])`);
    await settle();
    // **Where the trim goes is derived from where the marks landed, never assumed.**
    // This section deliberately runs at a rate where a mark's program second and its
    // source second are different numbers - which is the whole point of the rows above -
    // so a trim written as two constants put both marks on the same side of it and the
    // liveness row below failed against a correct build. The boundaries are computed
    // from the curve the page is actually holding.
    const trim = await page.evaluate(`(() => {
      const window0 = __kinect.editor.view.window();
      const total = window0.duration;
      const at = (s) => Math.max(0, Math.min(total, __kinect.timeline.retime.programSecAt(s)));
      const outside = at(2);
      const inside = at(8);
      const inAt = (outside + inside) / 2;
      // **The out point goes a distance on screen past the kept mark rather than a fixed
      // second past it.** The out cut's grab zone reaches 12px to the left of its line and
      // sits two stacking levels above the marks, so a second is far enough only while a
      // second is wide. On a 75s take at rate 0.5 the program is 151s across the bed and
      // one second is about six pixels, which put the out handle on top of the very tick
      // the rows below have to press: the click retried for thirty seconds and took the
      // run down as DID NOT RUN at 347 assertions, against a build with nothing wrong
      // with it. Thirty-two pixels is twice the handle's reach, computed from the window
      // actually on screen rather than assumed from the take.
      const perPx = window0.spanSec / Math.max(1, document.getElementById('tBed').getBoundingClientRect().width);
      const clearOfTheHandle = Math.max(1, 32 * perPx);
      return {
        total, outside, inside, inAt, clearOfTheHandle,
        park: (inAt + inside) / 2,
        outAt: Math.min(total, inside + clearOfTheHandle),
      };
    })()`);
    // Set through the buttons the operator uses rather than through a hook, because a
    // hook that set the trim directly would be a second road to a value the keys have to
    // agree with - and the rows below are about exactly that agreement.
    await page.evaluate(`__kinect.timeline.transport().seek(${trim.inAt})`);
    await settle();
    await page.click('#tSetIn');
    await page.evaluate(`__kinect.timeline.transport().seek(${trim.outAt})`);
    await settle();
    await page.click('#tSetOut');
    await settle();
    const trimmed = await page.evaluate('({ in: __kinect.timeline.transport().clipInSec, out: __kinect.timeline.transport().clipOutSec })');
    const marksNow = await page.evaluate('__kinect.library.markTicks().length');
    check(marksNow === 2 && trim.outside < trimmed.in - TOL && trimmed.in < trim.park
      && trim.park < trim.inside - TOL && trim.inside < trimmed.out + TOL,
      'the clip is trimmed with one mark outside it and one inside, and the playhead parks between the in point and the mark it keeps - which is the arrangement the clamp can be seen through',
      `outside ${trim.outside.toFixed(2)}s | in ${trimmed.in?.toFixed(2)}s | park ${trim.park.toFixed(2)}s`
      + ` | inside ${trim.inside.toFixed(2)}s | out ${trimmed.out?.toFixed(2)}s, ${marksNow} ticks`);
    // **Both ticks are reachable by a pointer, hit-tested rather than assumed, before
    // anything below aims at one.** The rows below press ticks, and a tick with another
    // control drawn over it does not fail those rows - `locator.click` waits for the
    // element to become clickable, retries for thirty seconds and then takes the whole
    // run down as `DID NOT RUN`, which reports nothing about the build and loses every
    // section after it. That is the failure this row converts into a sentence naming what
    // is on top, and it is the one the trim's own geometry above was arranged to avoid.
    const tickCover = await page.evaluate(`(() => {
      return [...document.querySelectorAll('#tMarks .tmk')].map((tick) => {
        const r = tick.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          title: tick.title,
          clear: at === tick || tick.contains(at),
          over: at ? (at.id ? '#' + at.id : at.tagName.toLowerCase() + '.' + at.className) : 'nothing',
        };
      });
    })()`);
    const covered = tickCover.filter((t) => !t.clear);
    check(tickCover.length === 2 && covered.length === 0,
      'and a pointer reaches both of them, so a tick with the out handle drawn over it is a red row rather than a timeout that ends the run',
      covered.length
        ? covered.map((t) => `"${t.title}" is under ${t.over}`).join('; ')
        : `${tickCover.length} ticks, ${trim.clearOfTheHandle.toFixed(2)}s of program between the kept mark and the out point`);
    await page.evaluate(`__kinect.timeline.transport().seek(${trim.park})`);
    await settle();
    await focusStage();
    await page.keyboard.press('[');
    await settle();
    const backFromPark = (await read()).programSec;
    check(near(backFromPark, trim.park, TOL),
      'stepping back from inside the trim past a mark the trim excludes moves nothing at all, rather than throwing the playhead onto the in point it can never get past',
      `${backFromPark.toFixed(3)}s, parked at ${trim.park.toFixed(3)}s with the in point at ${trimmed.in?.toFixed(2)}s`);
    // The liveness half. Without it the row above passes against a key that does
    // nothing whatever, which is the same reading and the opposite defect.
    await page.keyboard.press(']');
    await settle();
    const forwardInTrim = (await read()).programSec;
    check(near(forwardInTrim, trim.inside, TOL),
      'and the key is working while it declines, because the same press forward still reaches the mark the trim does keep',
      `${forwardInTrim.toFixed(3)}s against the kept mark at ${trim.inside.toFixed(3)}s`);

    // **The same rule, pressed rather than typed.** The keys were taught to refuse a
    // mark the trim excludes and the ruler's own ticks were not, so the diamond drawn
    // inside the shading still seeked - and the seek was clamped to the boundary, which
    // is a control doing something other than what it shows. Both go through
    // `reachableInClip` now; this row is the half that had no coverage at all.
    //
    // The tick is found by its drawn position rather than by index, because the ticks
    // are sorted by where they land and an index would be a second claim about the
    // ordering that the row does not want to be making.
    const outsideTickIndex = await page.evaluate(`(() => {
      const ticks = globalThis.__kinect.library.markTicks();
      const lefts = ticks.map((t) => t.left);
      return lefts.indexOf(Math.min(...lefts));
    })()`);
    await page.evaluate(`__kinect.timeline.transport().seek(${trim.park})`);
    await settle();
    await page.locator('#tMarks .tmk').nth(outsideTickIndex).click();
    await settle();
    const afterClickingOutside = (await read()).programSec;
    check(near(afterClickingOutside, trim.park, TOL),
      'pressing a tick the trim excludes moves the playhead nowhere, rather than seeking to a boundary the diamond is not drawn at',
      `${afterClickingOutside.toFixed(3)}s, parked at ${trim.park.toFixed(3)}s with the in point at ${trimmed.in?.toFixed(2)}s`);
    // There was a row here reading "outside the clip range" off the application bar, on
    // the argument that a key stepping past nothing has nothing to report while a diamond
    // somebody aimed at does. That argument still holds and the surface it needed is gone,
    // so the press is now silent and the row went with the sentence. The tick stays
    // focusable and the one below still seeks, which is what keeps this from reading as a
    // control that was removed.
    // The liveness half again, on the click path this time: the tick the trim keeps has
    // to still seek, or the row above passes against a ruler whose ticks are all dead.
    const insideTickIndex = await page.evaluate(`(() => {
      const ticks = globalThis.__kinect.library.markTicks();
      const lefts = ticks.map((t) => t.left);
      return lefts.indexOf(Math.max(...lefts));
    })()`);
    await page.evaluate(`__kinect.timeline.transport().seek(${trim.park})`);
    await settle();
    await page.locator('#tMarks .tmk').nth(insideTickIndex).click();
    await settle();
    const afterClickingInside = (await read()).programSec;
    check(near(afterClickingInside, trim.inside, TOL),
      'and the tick the trim keeps still seeks to itself, so the refusal above is about reachability rather than about a ruler that stopped working',
      `${afterClickingInside.toFixed(3)}s against the kept mark at ${trim.inside.toFixed(3)}s`);

    // **A mark the edit never reaches still answers a keyboard.** `.tmk.beyond` and
    // `.tmk:hover` have equal specificity, so the one written last wins - and with the
    // beyond rule underneath, a beyond tick kept its resting colour through both states
    // while `:focus-visible` had already turned the native outline off on the grounds
    // that the colour change said the same thing. The net effect was a focused control
    // with no focus indication of any kind, which no row here had looked for because the
    // existing presses are all on ordinary ticks.
    await page.evaluate(`__kinect.editor.setMarks([
      { id: 'ordinary', sourceMs: 3000, label: 'ordinary' },
      { id: 'past', sourceMs: 9000000, label: 'past the end' },
    ])`);
    await settle();
    const ticks = await page.evaluate('__kinect.library.markTicks()');
    check(ticks.length === 2 && ticks.some((t) => t.beyond) && ticks.some((t) => !t.beyond),
      'one tick is a beyond mark and one is ordinary, so the two rows below are a comparison rather than two readings of the same thing',
      ticks.map((t) => (t.beyond ? 'beyond' : 'ordinary')).join(' '));
    // Focus arrives by Tab rather than by `.focus()`, because `:focus-visible` is a
    // claim about how focus got there - a programmatic focus does not match it in
    // Chromium, so a row built that way would read the resting colour on both builds
    // and agree with the defect.
    // **`color` and not `backgroundColor`, because that is what the tick is drawn with.**
    // The mark became an inline SVG stroked with `currentColor`, so `.tmk.beyond` and
    // `.tmk:focus-visible` set `color` where they used to set a background - and a row
    // reading the background read `rgba(0, 0, 0, 0)` at rest and `rgba(0, 0, 0, 0)`
    // focused, which is two readings of a property nothing writes agreeing with each
    // other. It could not pass on any build, and it could not have failed for the reason
    // it is named for either. `beyond-mark-loses-focus` moves the `color` declaration, so
    // the control and the assertion have to be reading the same property or the
    // falsification proves nothing.
    const focusColours = async (selector) => page.evaluate(`(async () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const rest = getComputedStyle(el).color;
      return { rest, el: Boolean(el) };
    })()`);
    const beforeFocus = await focusColours('#tMarks .tmk.beyond');
    await page.evaluate("document.querySelector('#tMarks .tmk:not(.beyond)').focus()");
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(`(() => {
      const el = document.activeElement;
      return {
        isBeyond: el?.classList?.contains('beyond') ?? false,
        visible: el?.matches(':focus-visible') ?? false,
        colour: el ? getComputedStyle(el).color : null,
        outline: el ? getComputedStyle(el).outlineStyle : null,
      };
    })()`);
    check(focused.isBeyond && focused.visible,
      'tabbing off the ordinary tick lands keyboard focus on the beyond one, which is what makes the row below about the colour rather than about where focus went',
      `beyond ${focused.isBeyond}, :focus-visible ${focused.visible}`);
    check(focused.colour !== beforeFocus.rest,
      'and a focused beyond mark looks different from a resting one - the outline is off on the grounds that the colour says it instead, so the colour has to say it',
      `resting ${beforeFocus.rest}, focused ${focused.colour}, outline ${focused.outline}`);


    check(errors.length === errorsBefore, 'none of it raises a page error',
      errors.slice(errorsBefore, errorsBefore + 2).join(' | '));
  }


  // ================================ 14. a reallocated drawing buffer still has a picture in it

  console.log('\n[14] resizing the stage while the playhead is parked leaves a picture on it');

  // **`resize()` reallocates the drawing buffer, which clears it, and a parked editor
  // has no clock that would draw into it again.** `tickNow` returns immediately on
  // `!playing` and `pumpParkedDraft` returns with nothing armed, so the stage stayed
  // black until something unrelated happened to seek - the window resize, the three
  // splitter entries, the render-scale slider, the export-size menu and `rebuildLanes`
  // all reached it, and none of them asked for a repaint. `resize-skips-repaint` is the
  // control, and it deletes the one call at the end of `resize()` rather than any
  // caller, because the fix is at the door.
  //
  // **Chrome is taken off first, and that is the row rather than tidiness.** The camera
  // path and the top-down inset live on a separate 2D canvas that `placeChrome` goes on
  // repainting perfectly happily, which is exactly what the operator sees on the broken
  // build: an overlay floating over an opaque black stage. Left on, that overlay is lit
  // pixels inside the stage's box and it would carry this row on a build whose picture
  // is gone. Section 8 already left it off; this says so rather than inheriting it.
  //
  // Measured as a density rather than a count, because the two arms change the box: a
  // narrower window is a smaller letterbox, so the same picture is fewer pixels and a
  // raw count would read the shrink as a loss. Against the pre-resize frame rather than
  // for bit-equality, for the reason section 8 records - two screenshots of one clip are
  // not bit-identical, and asserting that they are would be asserting determinism, which
  // is another tool's claim.
  {
    await page.evaluate('__kinect.keyframes.chrome.set(false)');
    await page.evaluate('__kinect.timeline.transport().pause()');
    await page.evaluate('__kinect.timeline.transport().seek(12)');
    // The picture this section counts is put there rather than inherited, and pressing
    // "sensor view" is how: it poses the camera at the sensor's own origin with a
    // frustum fitted to the sensor's rectangle, so the whole cloud is in frame by
    // construction. Inherited, it was whatever twelve sections of orbiting, exporting
    // and preset importing happened to leave - 1543 lit pixels of 947 thousand on one
    // run against 89 thousand on another, which is a row whose margin depends on what
    // ran before it rather than on the claim it makes.
    await page.locator('#panelTabFraming').click();
    await page.locator('#camSensor').click();
    await settle();
    await new Promise((r) => setTimeout(r, 150));
    const density = async () => {
      const box = await page.locator('#stage').boundingBox();
      const n = await lit();
      return { all: n.all, per: n.all / Math.max(1, box.width * box.height), box };
    };
    // Waited on rather than slept through: `setViewportSize` returns before the page's
    // own `resize` listener has run, and a `settled()` that arrives first finds nothing
    // scheduled and reports an idle page one macrotask before the work starts. Watching
    // the counter the door increments is what closes that, and it doubles as evidence
    // the arm went through the door it names.
    const throughResize = async (label, act) => {
      const was = await page.evaluate('__kinect.editor.stageResizes()');
      await act();
      await page.waitForFunction(`__kinect.editor.stageResizes() > ${was}`, null, { timeout: 15000 })
        .catch(() => { throw new Error(`${label} never reached resize()`); });
      await settle();
      await new Promise((r) => setTimeout(r, 150));
    };

    // The bar is set from measurement rather than from what a full frame would look
    // like, and it is set low on purpose. **The blank build measures exactly 0.00%**, so
    // the separation this row needs is not a matter of degree - what the threshold is
    // for is that a section arriving on an empty view reports the absence as its own
    // precondition failing rather than as the stage rows passing on nothing. Measured
    // from the sensor-view pose at 12s: 0.84% on a full run and 9.46% under
    // `--no-render`, where section 7's export has not been through the look. The order
    // of magnitude between those two is why this is not written any tighter.
    const beforeResize = await density();
    check(beforeResize.per > 0.001,
      'the parked stage carries a picture before anything resizes, or nothing below is about a resize',
      `${beforeResize.all} lit pixels at ${(beforeResize.per * 100).toFixed(2)}% of `
      + `${Math.round(beforeResize.box.width)}x${Math.round(beforeResize.box.height)}, `
      + `on the ${await page.evaluate('__kinect.viewCamera() === __kinect.freeCamera ? "free" : "program"')} camera`);

    // **The premise the repaint's guard rests on, asserted rather than trusted.**
    // `resize()` only asks for the picture back when the drawing buffer's size actually
    // moved, because most calls do not move it - `rebuildLanes` runs it on every lane
    // rebuild, so every rate change reaches it with the strip the height it already was,
    // and a repaint there is a second accurate seek on top of the one the gesture's own
    // release issues. That guard is only safe while a same-size `setSize` reallocates
    // nothing, which is a fact about `WebGLRenderTarget` and about Chrome's canvas
    // rather than about this build. So it is measured here: a `resize` event with the
    // window unchanged, and the picture has to still be there afterwards. The day this
    // row goes red the guard is wrong and the stage goes black on the paths nothing
    // else covers.
    const bufferOf = () => page.evaluate(`(() => {
      const gl = __kinect.renderer.getContext();
      return { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight, resizes: __kinect.editor.stageResizes() };
    })()`);
    const bufBefore = await bufferOf();
    await page.evaluate('window.dispatchEvent(new Event("resize"))');
    await settle();
    await new Promise((r) => setTimeout(r, 150));
    const bufSame = await bufferOf();
    const sameSize = await density();
    check(bufSame.resizes > bufBefore.resizes && bufSame.w === bufBefore.w && bufSame.h === bufBefore.h
      && sameSize.all === beforeResize.all,
      '  and a resize that reallocates nothing leaves it alone, which is what lets the repaint be conditional',
      `${bufSame.resizes - bufBefore.resizes} resizes, buffer ${bufBefore.w}x${bufBefore.h} -> `
      + `${bufSame.w}x${bufSame.h}, lit ${beforeResize.all} -> ${sameSize.all}`);

    await throughResize('the window resize', () => page.setViewportSize({
      width: VIEWPORT.width - 220, height: VIEWPORT.height - 120,
    }));
    const afterWindow = await density();
    check(afterWindow.per > beforeResize.per * 0.5,
      'a window resize with the playhead parked leaves the stage drawn rather than blank',
      `${afterWindow.all} lit pixels at ${(afterWindow.per * 100).toFixed(2)}% density `
      + `against ${beforeResize.all} at ${(beforeResize.per * 100).toFixed(2)}%`);
    await throughResize('the window restore', () => page.setViewportSize(VIEWPORT));

    // The render-scale slider, and it is the subtle half. It is tagged `view`, and
    // `paramWritten` deliberately withholds the repaint every other parameter gets -
    // so the registry's single write path ran `apply`, which destroyed the buffer, and
    // then took the early return that was written on the premise that resizing the
    // buffers was already the work. Driven through `params.set` because that is the
    // door the slider's own `input` listener uses.
    const scaleWas = await page.evaluate("__kinect.params.get('renderScale')");
    await throughResize('the render-scale write', () => page.evaluate("__kinect.params.set('renderScale', 130)"));
    const afterScale = await density();
    check(afterScale.per > beforeResize.per * 0.5,
      '  and so does a render-scale write, which is the one door that asks for no repaint of its own',
      `${afterScale.all} lit pixels at ${(afterScale.per * 100).toFixed(2)}% density, render % 130`);
    await throughResize('the render-scale restore',
      () => page.evaluate(`__kinect.params.set('renderScale', ${scaleWas})`));
    const restored = await density();
    check(restored.per > beforeResize.per * 0.5,
      '  and the stage the next section inherits is a drawn one',
      `${restored.all} lit pixels at ${(restored.per * 100).toFixed(2)}%, render % back to ${scaleWas}`);
  }

  // ================================ 15. a project carries look tracks and nothing else

  console.log('\n[15] a project is refused a track on a parameter it must not carry');

  // **The writer filtered the track set and the reader did not, and the tag was sitting
  // in the reader's hand unread.** `serialiseProjectBody` writes
  // `params.names('look').filter(...)`, so a track on `renderScale` or `spin` is a shape
  // no build of this program has ever written - but `restoreProject` called
  // `params.spec(name)` purely for its throw-on-unknown side effect and discarded the
  // spec it got back, and both of those are names the registry knows.
  //
  // What accepting one cost is why this row exists rather than a note about tidiness.
  // `evaluateTracks` has no tag filter and runs inside `renderProgramFrame`, so a
  // `renderScale` track is `resize()` once per rendered frame - and where the value
  // moves, `composer.setSize` disposes and recreates the render targets and, through
  // `AfterimagePass`, the trails accumulator, between two consecutive frames of a
  // pre-roll that exists to build exactly that accumulator up. The seek stops
  // reproducing the playback it is defined to reproduce, and the document quietly stops
  // round-tripping at the same time, because the serialiser filters the track back out
  // on the next commit.
  //
  // Driven straight at `restoreProject`, which is exposed raw and deliberately for this:
  // reaching it through a successful save-and-load could never hand it a document the
  // serialiser refuses to write. The body is the *current* document with one track added
  // rather than a fixture built here, so that a build which accepts it is left holding
  // the clip it already had plus the track - which is the damage this names, and nothing
  // else that a later section would report as its own failure.
  {
    const original = await page.evaluate('JSON.stringify(__kinect.library.serialiseProjectBody())');
    // The keys are a parameter rather than a literal because the shape that walked past
    // both refusals is an *empty* track, and a helper that can only plant a populated one
    // cannot ask about it. Defaulted to the populated pair so the rows written before this
    // was known say exactly what they said.
    const handTo = (name, keys = [{ t: 0, value: 100 }, { t: 4, value: 140 }]) => page.evaluate(`(() => {
      const body = JSON.parse(${JSON.stringify(original)});
      body.look.tracks[${JSON.stringify(name)}] = ${JSON.stringify(keys)};
      try {
        __kinect.library.restoreProject(body);
        return { threw: false, message: null };
      } catch (err) {
        return { threw: true, message: String(err?.message ?? err) };
      }
    })()`);
    const viewTrack = await handTo('renderScale');
    check(viewTrack.threw && /view/.test(viewTrack.message ?? ''),
      'a project carrying a track on a view parameter is refused, and the refusal names the tag',
      viewTrack.threw ? `"${viewTrack.message}"` : 'it was accepted');
    // The other half of the same claim, and the reason the refusal reads the tag rather
    // than a list of names: a track on a look parameter is the shape the serialiser
    // writes, and it has to keep loading. A build that had simply stopped accepting
    // tracks would pass the row above and fail this one.
    const look = await handTo('bloom');
    check(!look.threw, '  and one on a look parameter still loads, which is the shape the serialiser writes',
      look.threw ? `"${look.message}"` : 'accepted');
    // **The same document with no keys in it, which is the shape that walked past both
    // refusals.** `restoreProject` skipped an empty track before it asked the two
    // questions, so `{"renderScale": []}` and a track under a name the registry has never
    // heard of were both accepted by a reader that had just promised to refuse them - and
    // accepted is the wrong word for what happened to them, because `serialiseProjectBody`
    // filters the entry back out on the next commit. The document stopped saying what it
    // said when it was opened, through the one shape with no edit in it to notice missing.
    //
    // Three rows rather than one, because "refuses an empty view track" on its own is also
    // satisfied by a build that refuses every empty track: the name row says the older
    // refusal still reaches this shape too, and the look row says empty is not itself what
    // is being refused.
    const emptyView = await handTo('renderScale', []);
    check(emptyView.threw && /view/.test(emptyView.message ?? ''),
      '  and an empty track on a view parameter is refused too, rather than skipped for being cheap to skip',
      emptyView.threw ? `"${emptyView.message}"` : 'it was accepted');
    const emptyUnknown = await handTo('notAParameterThisBuildKnows', []);
    check(emptyUnknown.threw,
      '  and so is an empty one under a name the registry has never heard of',
      emptyUnknown.threw ? `"${emptyUnknown.message}"` : 'it was accepted');
    const emptyLook = await handTo('bloom', []);
    check(!emptyLook.threw,
      '  while an empty one on a look parameter still loads, because empty is not what is being refused',
      emptyLook.threw ? `"${emptyLook.message}"` : 'accepted');
    // Whatever the two above left behind, put back - and asserted rather than assumed,
    // because the build this matters on is the one that is deliberately wrong. On this
    // build the first is refused with nothing touched and the second replaces the
    // document with itself plus a bloom track; on the mutated build the first one lands
    // too, and a `renderScale` track surviving into the next section is `resize()` once
    // per rendered frame there. A cleanup that silently failed would hand that to
    // section 16 as a hang nobody could attribute to this block.
    const cleaned = await page.evaluate(`(() => {
      try {
        __kinect.library.restoreProject(JSON.parse(${JSON.stringify(original)}));
        return { threw: null, tracks: __kinect.keyframes.names() };
      } catch (err) {
        return { threw: String(err?.message ?? err), tracks: __kinect.keyframes.names() };
      }
    })()`);
    await settle();
    check(cleaned.threw === null && !cleaned.tracks.includes('renderScale'),
      '  and the document this section handed over is put back, carrying neither track it planted',
      cleaned.threw ? `the restore threw "${cleaned.threw}"` : `tracks: ${cleaned.tracks.join(', ') || 'none'}`);
  }

  // ================================ 16. a panel group is open because the clip says so

  console.log('\n[16] which panel groups are open is derived, and only disagreements are stored');

  // The claim is that no group carries a stored open/closed state: it is open when the
  // document holds evidence that somebody has been inside it, and shut otherwise, with
  // a person's disagreement the only thing written down. So every row here reads a
  // consequence - which rows are on the screen, what the header says, what came back
  // out of storage - rather than reading a flag the page keeps about itself.
  //
  // **The rows are still in the document while they are hidden**, which is the half a
  // sweep cannot notice and the half that keeps this feature checkable. Section 1 counts
  // a control per registry parameter with a plain `querySelectorAll`, blind to
  // visibility by construction, so a build that collapsed by *rebuilding* the panel
  // would pass every row above and quietly stop being the registry. Each row below reads
  // the count in the document beside the count on the screen for that reason.
  {
    const GROUP_STATE = `(() => {
      const vis = (el) => Boolean(el) && el.checkVisibility({ checkVisibilityCSS: true });
      const rows = (g) => [...g.querySelectorAll('.row, .checkrow, .check')];
      return [...document.querySelectorAll('#panel .group[data-group]')].map((g) => {
        const toggle = g.querySelector(':scope > .grouphead > .grouptoggle');
        const mark = g.querySelector(':scope > .grouphead > .groupmark');
        return {
          key: g.dataset.group,
          collapsible: Boolean(toggle),
          shut: g.classList.contains('shut'),
          expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
          markVisible: vis(mark),
          mark: mark ? mark.textContent : null,
          tab: g.dataset.panelTab,
          inDom: rows(g).length,
          onScreen: rows(g).filter(vis).length,
        };
      });
    })()`;
    const groups = () => page.evaluate(GROUP_STATE);
    const groupOf = async (key) => (await groups()).find((g) => g.key === key);
    const showGroup = async (key) => {
      const group = await groupOf(key);
      if (group?.tab) await page.click(`#panelTabs [data-panel-tab="${group.tab}"]`);
      await settle();
      return groupOf(key);
    };
    const stored = () => page.evaluate("localStorage.getItem('kinect.panelGroupsOpen')");
    // Back to a document nobody has touched. `params.reset` over the look tag is what
    // `restoreProject` itself uses, so this is the state a fresh project arrives in
    // rather than an approximation of it.
    const freshLook = async () => {
      await page.evaluate("__kinect.keyframes.setTracks({})");
      await page.evaluate("__kinect.params.reset(__kinect.params.names('look'))");
      await settle();
    };

    // The registry's own answer for what a fresh project holds, so every row below
    // compares against the same number the page derives from rather than against a
    // literal copied out of `PARAMS` that would go stale the day somebody re-grades a
    // default. `normalise` is in it because that is what the predicate compares
    // against - a default off its own step would be a value the slider cannot express.
    const defaultOf = (name) => page.evaluate(
      `__kinect.params.normalise(${JSON.stringify(name)}, __kinect.params.spec(${JSON.stringify(name)}).default)`);

    // The store cleared once, here, where it is the only safe place to do it: nothing has
    // pressed a toggle yet, so the page is holding no overrides in memory and the two
    // cannot come apart. Later in the section they would - clearing the entry behind the
    // page's back leaves the in-memory map intact, and the next write puts the leftovers
    // straight back - so every row below establishes the state it needs by pressing.
    await freshLook();
    await page.evaluate("localStorage.removeItem('kinect.panelGroupsOpen')");
    await page.evaluate('__kinect.timeline.transport().seek(3)');
    await settle();

    // ---- 15a. the set of collapsible groups, off the page rather than out of a list
    //
    // Enumerated because the driver rule above claims this section presses *every*
    // group toggle the editor renders, and a rule crediting four ids while a section
    // pressed three of them is the coverage claim `plant-unswept-control` exists to
    // refuse. The names are printed and not asserted: which groups collapse is a design
    // decision that may gain a fifth member, where "the ones on the page are the ones
    // driven" is the invariant.
    const all = await groups();
    const collapsible = all.filter((g) => g.collapsible);
    note(`${collapsible.length} of ${all.length} generated groups collapse`,
      collapsible.map((g) => g.key).join(', '));
    check(collapsible.length > 0 && collapsible.every((g) => g.inDom > 0),
      'every collapsible group is a group that actually holds rows',
      collapsible.map((g) => `${g.key}:${g.inDom}`).join(' '));

    // `framing` by name, and it is the one group this row is worth spending an
    // assertion on. Its `after()` emits `#cropReset`, section 8 clicks that button, and
    // Playwright's click waits for the element to be visible - so a `framing` that
    // could be shut turns a row eight sections back into a thirty-second timeout, which
    // arrives as a crash carrying no failed assertion rather than as a finding.
    const framing = await showGroup('framing');
    check(Boolean(framing) && !framing.collapsible && framing.onScreen === framing.inDom,
      'framing is not collapsible, because the crop button under it is one section 8 has to click',
      framing ? `collapsible: ${framing.collapsible}, ${framing.onScreen} of ${framing.inDom} rows on screen` : 'no framing group');
    await showGroup('post');

    // ---- 15b. a document nobody has touched renders them shut
    const fresh = (await groups()).filter((g) => g.collapsible);
    check(fresh.every((g) => g.shut && g.expanded === 'false' && g.onScreen === 0),
      'a project at its defaults renders every collapsible group shut',
      fresh.map((g) => `${g.key}:${g.shut ? 'shut' : 'OPEN'}/${g.onScreen}`).join(' '));
    // The other half, and the one that separates hiding from rebuilding. A build that
    // emitted a subset would satisfy the row above perfectly.
    check(fresh.every((g) => g.inDom > 0),
      'and their rows are hidden rather than absent, so the panel is still the whole registry',
      `${fresh.reduce((n, g) => n + g.inDom, 0)} rows in the document, ${fresh.reduce((n, g) => n + g.onScreen, 0)} on screen`);
    check(fresh.every((g) => !g.markVisible),
      'with nothing marked, because a group at its defaults has nothing to announce',
      fresh.map((g) => `${g.key}:${g.markVisible}`).join(' '));

    // ---- 15c. moving a value opens the group that holds it
    //
    // `bloom` because it is in `optical`, which is one of the four, and because
    // `keyframe-check` clicks its keyframe diamond - a control Playwright will only
    // press when it is visible. That tool applies a look that moves `bloom` before it
    // clicks, so the group is open by the time it gets there; this row is what says the
    // mechanism it relies on is working.
    await page.evaluate("__kinect.params.set('bloom', 1.5)");
    await settle();
    const opened = await groupOf('post');
    check(!opened.shut && opened.expanded === 'true' && opened.onScreen === opened.inDom,
      'moving one parameter off its default opens the group that holds it',
      `post: shut=${opened.shut}, ${opened.onScreen} of ${opened.inDom} rows on screen`);
    // And its neighbours did not move, because a build that opened everything the
    // moment anything changed would satisfy the row above while saying nothing.
    const neighbours = (await groups()).filter((g) => g.collapsible && g.key !== 'post');
    check(neighbours.every((g) => g.shut),
      'and only that group, so the rule is about the parameter rather than about the write',
      neighbours.map((g) => `${g.key}:${g.shut ? 'shut' : 'OPEN'}`).join(' '));

    // ---- 15c-bis. a style tuning parameter opens the style group
    //
    // The row that holds the invariant the whole feature rests on: which groups are open
    // is the look's diff against its defaults, so what a look is made of is a thing you
    // read off the panel. Every group derives from its own parameters by construction.
    await freshLook();
    await settle();
    const rimDefault = await defaultOf('ghostRim');
    const rimSpec = await page.evaluate("__kinect.params.spec('ghostRim')");
    // Whichever end of the travel the default is not, so this cannot become a write of
    // the value that was already there - which would leave the group untouched and the
    // row below asserting the state it started in.
    await page.evaluate(`__kinect.params.set('ghostRim', ${rimDefault === rimSpec.max ? rimSpec.min : rimSpec.max})`);
    await settle();
    const rimNow = await page.evaluate("__kinect.params.get('ghostRim')");
    // Off `__kinect.readings()` rather than a list spelled out here, so this asks about
    // the readings this build has rather than the ones whoever wrote the row remembered.
    const readingsQuiet = await page.evaluate(`__kinect.readings().every((n) =>
      __kinect.params.get(n) === __kinect.params.normalise(n, __kinect.params.spec(n).default))`);
    check(rimNow !== rimDefault && readingsQuiet,
      'one style parameter moved with every reading left at its default, or the row below tests nothing',
      `ghostRim reads ${rimNow} against a default of ${rimDefault}, readings untouched: ${readingsQuiet}`);
    const tuned = await groupOf('style');
    check(!tuned.shut && tuned.onScreen === tuned.inDom,
      'moving a style parameter opens the style group, so the open set is the whole diff',
      `style: shut=${tuned.shut}, ${tuned.onScreen} of ${tuned.inDom} rows on screen`);

    // ---- 15d. a keyframe counts even where the value does not
    //
    // The whole reason the predicate has a keyframe term, and the one row
    // `reveal-ignores-tracks` can reach. The track's keys are all at `grain`'s own
    // default, so the evaluator writes the default into the registry at every position
    // and the value test says untouched at every frame - a parameter that is being
    // animated, on a curve, with the group holding it shut.
    await freshLook();
    const grainDefault = await defaultOf('grain');
    await page.evaluate(`__kinect.keyframes.setTracks({ grain: [
      { t: 1, value: ${grainDefault} }, { t: 6, value: ${grainDefault} }] })`);
    await page.evaluate('__kinect.timeline.transport().seek(3)');
    await settle();
    // The probe's own control, and without it the row below is an assertion about
    // nothing: if the planted keys had moved the value off its default, the group would
    // open through the term this row is trying to isolate and `reveal-ignores-tracks`
    // would come back NOT CAUGHT for a reason that is about the fixture.
    const parked = await page.evaluate("__kinect.params.get('grain')");
    check(parked === grainDefault,
      'the keyed parameter really is sitting on its default at the parked frame, or the row below tests nothing',
      `grain reads ${parked} against a default of ${grainDefault}`);
    const keyed = await groupOf('post');
    check(!keyed.shut && keyed.onScreen === keyed.inDom,
      'a keyframe opens the group even where the value it holds is the default',
      `post: shut=${keyed.shut}, ${keyed.onScreen} of ${keyed.inDom} rows on screen`);

    // ---- 15e. a shut group that is in use says so
    //
    // Pressed rather than assumed shut, because the state it starts in is exactly what
    // `group-never-reveals` changes: on that build every group is already shut and a
    // blind press would open one, which is a row failing for the wrong reason and a
    // section that stops measuring what it is named for.
    await freshLook();
    await page.evaluate("__kinect.params.set('bloom', 1.5)");
    await settle();
    const shut = async (key) => {
      if (!(await groupOf(key)).shut) await page.click(`[data-group-toggle=${key}]`);
      await settle();
      return groupOf(key);
    };
    const marked = await shut('post');
    check(marked.shut && marked.markVisible && marked.mark === '1',
      'a shut group carrying a value says how many of its parameters are set',
      `post: shut=${marked.shut}, mark visible=${marked.markVisible}, reads "${marked.mark}"`);
    // Two parameters, so the mark is a count rather than a light that came on. A mark
    // reading "1" whatever is underneath it would pass the row above on every build.
    await page.evaluate("__kinect.params.set('grain', 0.4)");
    await settle();
    const marked2 = await groupOf('post');
    check(marked2.mark === '2',
      'and it is a count of them rather than a lamp, so the header says how much is hidden',
      `two parameters set, the mark reads "${marked2.mark}"`);

    // ---- 15f. the override is a disagreement, and a toggle that agrees writes none
    //
    // Half of the store rule, and **only the half a toggle can reach** - which is worth
    // stating plainly because for a while this block claimed the whole of it. The group
    // above was collapsed while its values justified being open, so that disagreement is
    // written down; opening it again puts the two back into agreement, and what has to
    // happen then is that the entry *goes*, not that it flips to true.
    //
    // What that cannot see is the other term. A toggle compares the two at the instant
    // it is pressed, so pressing it back is the one gesture where they agree by
    // construction - a build that only ever pruned there would pass every row here while
    // an override the *document* had caught up with sat pinning a group open forever.
    // That is exactly the build this repo shipped, through a green suite. 15f-bis below
    // is the other term, and `override-prunes-only-on-toggle` is what makes the pair
    // falsifiable rather than asserted.
    const disagreeing = JSON.parse((await stored()) ?? '{}');
    check(disagreeing.post === false,
      'collapsing a group that derives open writes the disagreement down',
      JSON.stringify(disagreeing));
    await page.click('[data-group-toggle=post]');
    await settle();
    const agreeing = JSON.parse((await stored()) ?? '{}');
    const reopened = await groupOf('post');
    check(!reopened.shut && !Object.hasOwn(agreeing, 'post'),
      'and opening it again removes the entry rather than storing the agreement',
      `open=${!reopened.shut}, stored ${JSON.stringify(agreeing)}`);

    // ---- 15f-bis. the term that moves afterwards is the document, not the toggle
    //
    // The row above presses the same control twice, so the two sides agree at the
    // instant a toggle is pressed and the entry can go on the way past. That is the
    // easy half and for a while it was the only half implemented, while the comment
    // beside it claimed the whole rule: an override "decays instead of accumulating".
    // It did not. The other term of the comparison is the *derivation*, and the
    // derivation moves without anybody pressing anything - a value set, a look applied,
    // a project opened - so an override that the document has caught up with sat there
    // winning over a rule it now agreed with.
    //
    // These three rows are that failure in the order it happens to somebody. Pin a
    // group open while it is quiet, put something in it, take that something away
    // again: on a build whose prune only runs at the toggle, the last row finds a group
    // held open by an opinion the person formed about a different document. That is the
    // stored panel layout this whole design exists to refuse, arriving through the one
    // door left open.
    //
    // `optical` because 15f just left it with no entry, so this establishes its own
    // state by pressing rather than by clearing the store behind the page's back.
    await freshLook();
    await settle();
    const quiet = await groupOf('post');
    if (quiet.shut) await page.click('[data-group-toggle=post]');
    await settle();
    const pinned = await groupOf('post');
    const pinnedStore = JSON.parse((await stored()) ?? '{}');
    check(!pinned.shut && pinned.onScreen === pinned.inDom && pinnedStore.post === true,
      'pinning a quiet group open is a disagreement and is written down, or the two rows below test nothing',
      `open=${!pinned.shut}, ${pinned.onScreen} of ${pinned.inDom} rows on screen, stored ${JSON.stringify(pinnedStore)}`);
    await page.evaluate("__kinect.params.set('bloom', 1.5)");
    await settle();
    const caughtUp = await groupOf('post');
    const caughtStore = JSON.parse((await stored()) ?? '{}');
    check(!caughtUp.shut && !Object.hasOwn(caughtStore, 'post'),
      'and the document catching up with it takes the entry away, with nothing on screen changing',
      `open=${!caughtUp.shut}, stored ${JSON.stringify(caughtStore)}`);
    await freshLook();
    await settle();
    const decayed = await groupOf('post');
    check(decayed.shut && decayed.onScreen === 0,
      'so taking the value away again shuts it, rather than leaving it pinned open with nothing in it',
      `shut=${decayed.shut}, ${decayed.onScreen} of ${decayed.inDom} rows on screen, stored ${await stored()}`);
    // Put back as it was found, and this is the fixture rather than a claim. On a build
    // that prunes, the group is already shut and this presses nothing; on
    // `override-prunes-only-on-toggle` it is still pinned, and a pin that outlived this
    // block is a group the rows below would read as in use - 15g asks every collapsible
    // group but `style` to be shut. Without this the control reddens its own two rows
    // *and* a neighbour's fixture, and a mutation that fails a row it has nothing to say
    // about cannot tell you which question it was answering.
    if (!(await groupOf('post')).shut) await page.click('[data-group-toggle=post]');
    await settle();

    // ---- 15g. moving a treatment opens the style group
    //
    // `readGhost` rather than `readRgb`, and the difference is the whole trap: `readRgb`
    // defaults to 1, so "open when a reading is non-zero" fires on a page nobody has
    // touched. Comparing against the defaults is what keeps a fresh project shut, and
    // 15b above is the row that says it does.
    // No `localStorage.removeItem` here, deliberately. Clearing the store behind the
    // page's back desynchronises it from the overrides the page is holding in memory, so
    // the next write puts the leftovers back and the rows below would be reading a state
    // this section did not establish. Nothing has pressed `style` yet, so it has no
    // override to clear.
    await freshLook();
    await settle();
    const styleQuiet = await groupOf('style');
    await page.evaluate("__kinect.params.set('readGhost', 0.7)");
    await settle();
    const styleLive = await groupOf('style');
    check(styleQuiet.shut && !styleLive.shut && styleLive.onScreen === styleLive.inDom,
      'moving a treatment (readGhost) opens the style group',
      `shut with the readings at their defaults: ${styleQuiet.shut}, after readGhost moved: ${styleLive.shut}`);
    // The other direction: the parameter that opened `style` belongs to `style`, so
    // the other collapsible groups should be unmoved by it.
    const untouched = (await groups()).filter((g) => g.collapsible && g.key !== 'style');
    check(untouched.every((g) => g.shut),
      'and leaves the three groups the reading has nothing to do with shut',
      untouched.map((g) => `${g.key}:${g.shut ? 'shut' : 'OPEN'}`).join(' '));

    // ---- 15h. shutting a live style group sticks
    //
    // The row that separates the store rule from the obvious spelling of it. The group
    // was opened by a parameter write, so shutting it creates a disagreement between
    // what the user asked for (shut) and what the derivation says (open). That
    // disagreement is written down and survives.
    await page.click('[data-group-toggle=style]');
    await settle();
    const styleShut = await groupOf('style');
    const styleStored = JSON.parse((await stored()) ?? '{}');
    check(styleShut.shut && styleStored.style === false,
      'shutting a group while it is in use stays shut and is written down',
      `shut=${styleShut.shut}, stored ${JSON.stringify(styleStored)}`);
    // And it is marked, because it is still in use - the treatment that opened it has
    // not moved. The header carries the dot with a count of how many of the group's own
    // parameters are off their defaults, which here is the one treatment that was
    // moved.
    //
    // **It reads a number and not an empty dot, and the difference is a group that no
    // longer exists.** This row was about `detail`, which was revealed by a `reveals`
    // closure over two *other* groups - so it could be in use with none of its own
    // parameters touched, and the header showed the dot with no number rather than a
    // misleading zero. The rework folded that group into `style` and took the last
    // `reveals` closure with it, so every group now derives from its own parameters
    // alone and a marked group always has something to count. Carrying the old
    // expectation across the rename made this row agree with a build that had stopped
    // writing the count at all.
    check(styleShut.markVisible && styleShut.mark === '1',
      'and it is marked as in use with a count of what it is holding',
      `mark visible=${styleShut.markVisible}, reads "${styleShut.mark}"`);

    // ---- 15i. the override outlives the page that wrote it
    //
    // This page reloaded rather than a second page opened beside it, and the reason is
    // the mutated module: `page.route` is installed per page, so a second page would
    // take the tree's own `main.js` and put two different builds inside one
    // measurement. Reloading re-runs the interception `openEditor` already proved held,
    // and a reload is a fresh module evaluation either way - the store is read back
    // from scratch rather than answered by anything the page was holding.
    //
    // **Both directions across one reload, and the collapse is the one that matters.**
    // A round of this suite had the collapse row go red on a build whose panel was
    // working, diagnosed the ambiguity correctly, and then reversed the row's polarity to
    // pin-open - the one direction the defect underneath it cannot reach. The reasoning
    // written down at the time was that a page booting with a stored `false` against a
    // document at its defaults reads two terms that agree, and an entry that agrees is
    // indistinguishable from one that was forgotten. That is true of the instant the page
    // boots and it is not true of the row, because the row *re-establishes the value
    // afterwards*: with the entry gone the group opens, with the entry kept it stays shut.
    // The red row had found the bug. `docs/instruments.md` carries the correction.
    //
    // So the fixture is a group shut while it is genuinely in use - the disagreement
    // somebody actually forms - plus a quiet group pinned open beside it, which is the
    // direction that always worked and is kept because a reload that carried neither
    // would fail this section for a reason that is about reloading.
    await freshLook();
    await page.evaluate("__kinect.params.set('bloom', 1.5)");
    await settle();
    if (!(await groupOf('post')).shut) await page.click('[data-group-toggle=post]');
    if ((await groupOf('style')).shut) await page.click('[data-group-toggle=style]');
    await settle();
    const beforeReload = JSON.parse((await stored()) ?? '{}');
    check(beforeReload.post === false && beforeReload.style === true,
      'a group shut while it is in use and a quiet one pinned open are two disagreements to survive, or the rows below test nothing',
      `stored ${JSON.stringify(beforeReload)}`);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('!!globalThis.__kinect.timeline.transport()', null, { timeout: 30000 });
    await settle();
    // Read straight out of storage, before anything else touches the page. This is the
    // defect at its own scale rather than through its consequence: a build that prunes on
    // agreement rather than on movement deletes the collapse during the boot pass, when
    // the look is at its defaults because no document has arrived yet, and writes the
    // pruned map back. The entry is gone from `localStorage` at this line on that build
    // and present on this one, with nothing about the panel involved either way.
    const carriedStore = JSON.parse((await stored()) ?? '{}');
    check(carriedStore.post === false && carriedStore.style === true,
      'the store the page booted from still holds both, so nothing pruned them against a document that had not loaded yet',
      `stored ${JSON.stringify(carriedStore)}`);
    // The pin, read off the page: it is open on a document holding nothing that would
    // open it, so it is open *because of the store*. A group whose parameters had come
    // back off their defaults would derive open on its own and pass on a build that had
    // forgotten the entry entirely.
    const pinCarried = await showGroup('style');
    const quietAfter = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const known = new Set(k.params.names());
      const group = [...document.querySelectorAll('#panel .group[data-group]')].find((g) => g.dataset.group === 'style');
      const names = [...group.querySelectorAll('input')].map((i) => i.id).filter((n) => known.has(n));
      return { names: names.length, quiet: names.every((n) => k.params.get(n) === k.params.normalise(n, k.params.spec(n).default)) };
    })()`);
    check(!pinCarried.shut && pinCarried.onScreen === pinCarried.inDom
      && quietAfter.names > 0 && quietAfter.quiet,
      'and the page reloaded still finds the pinned one open, on a document holding nothing that would open it',
      `open=${!pinCarried.shut}, ${pinCarried.onScreen} of ${pinCarried.inDom} rows on screen, `
      + `${quietAfter.names} parameters in the group and all at their defaults: ${quietAfter.quiet}`);
    // And the collapse, read the way it is felt: the value goes back, the document says
    // the group is in use, and the group stays shut with the mark saying what is hidden.
    // The reload does not restore the look - this page is opened on a take with no
    // project - so putting the value back is what makes the derivation `true` again and
    // the stored `false` a disagreement again. That is the step whose absence made the
    // earlier reading of this row ambiguous, and it is the step that discriminates: with
    // the entry pruned at boot the group opens here.
    await page.evaluate("__kinect.params.set('bloom', 1.5)");
    await settle();
    const collapseCarried = await groupOf('post');
    check(collapseCarried.shut && collapseCarried.onScreen === 0
      && collapseCarried.markVisible && collapseCarried.mark === '1',
      'and the collapse survives it too, so a group shut while it was in use is still shut when the value comes back',
      `shut=${collapseCarried.shut}, ${collapseCarried.onScreen} of ${collapseCarried.inDom} rows on screen, `
      + `mark visible=${collapseCarried.markVisible} reading "${collapseCarried.mark}", stored ${await stored()}`);

    // ---- 13j. every toggle the page renders is one this section has driven
    //
    // The reverse of the driver rule above, asked of the page rather than of this file.
    // The rule claims section 16 presses every collapsible group; this presses whatever
    // is left and asserts the rows under it answered, so a group declared after today is
    // driven by existing rather than by being remembered here.
    //
    // **What it asserts is that the press changed something and that the header agrees
    // with what it changed - never that the group ends up open.** Which way a press goes
    // depends on the state the group was in, and that state is exactly what
    // `group-never-reveals` alters: the first version of this row demanded
    // `aria-expanded=true` after every press, so on that build the two groups that
    // happened to start open failed a row about the *toggle* while the toggle was
    // working perfectly. A row whose answer depends on the mutation it is not the
    // control for is a row that cannot say what it found.
    await freshLook();
    await settle();
    const driven = [];
    for (const g of (await groups()).filter((x) => x.collapsible)) {
      await showGroup(g.key);
      const before = await groupOf(g.key);
      await page.click(`[data-group-toggle=${g.key}]`);
      await settle();
      const after = await groupOf(g.key);
      driven.push({
        key: g.key,
        from: before.onScreen,
        to: after.onScreen,
        moved: before.onScreen !== after.onScreen,
        // The header and the rows have to be telling the same story, which is the half
        // a screen reader gets and a pixel comparison cannot see.
        honest: after.expanded === String(after.onScreen > 0),
      });
    }
    check(driven.length === collapsible.length && driven.every((d) => d.moved && d.honest),
      'every collapsible group the page renders was pressed here and its rows answered',
      driven.map((d) => `${d.key}:${d.from}->${d.to}${d.honest ? '' : ' (aria disagrees)'}`).join(' '));

    // ---- 13k. one re-derivation per bulk write, not one per value in it
    //
    // The panel is re-derived from `params.set`, which is the door the evaluator writes
    // every keyed parameter through on every rendered frame - so without a gate the cost
    // of this feature scales with the number of keys on the clip, on the render path,
    // where this repo has been bitten before. `paramWritten` beside it has skipped
    // itself during a transport write since it existed; this is the same skip, with
    // `withoutRepaint` asking once on the way out for the whole write.
    //
    // **Counted rather than timed**, because a duration taken around a gesture
    // Playwright is pacing is a measurement of Playwright - `docs/measurement.md` states
    // that about the paused orbit and it applies unchanged here. The page keeps the
    // count and this reads a delta across a seek.
    //
    // **The claim is that the cost is fixed rather than proportional, so the arm varies
    // the thing it would be proportional to.** A single arm can only be graded against a
    // threshold somebody chose, and the threshold this row started with was
    // `perFrame < keyedLook.length` - fewer than 8, against an ungated build measured at
    // 8.02. A quarter of one percent of margin on a figure the machine has no say in is
    // luck rather than a gate, and anything between 1.02 and 8.02 would have satisfied it
    // equally. Keying four parameters and then eight and comparing the two per-frame
    // counts asks the question the sentence asks: a gated build answers the same number
    // twice, an ungated one answers half as much for half as many keys.
    //
    // The ceiling stays beside it and both conjuncts carry weight, which is the thing to
    // check before adding a second term to a row. The proportionality test alone passes a
    // build costing a constant eight passes per frame; the ceiling alone is the chosen
    // threshold again. Neither implies the other.
    //
    // Measured over two rounds per arm, four arms, one seek of four program seconds each
    // and five rendered frames per seek: **1.00 per frame at four keys and 1.00 at eight,
    // against 4.00 and 8.00 under `panel-rederives-per-write`.** Every figure came out
    // exact and repeated, which is the property that makes a count worth reading where a
    // rate is not - the two mutated rounds were taken at load average 8.8 and reported the
    // same numbers as the clean rounds taken at 6.6.
    //
    // **Those figures are also what reconciles the arithmetic**, and the earlier reading
    // of this row did not. An ungated build costing one pass per keyed parameter *and* one
    // for `withoutRepaint`'s way out would answer 9 at eight keys; it answers 8.00, so the
    // arm is the build from before the gate existed - `params.set` announcing every write
    // with no `finally` beside it - rather than the condition alone removed. The mutation
    // makes both edits for that reason, and the gated arm's 1.00 is exactly the `finally`
    // it takes away. An earlier figure of 8.02 against 1.02 came from a window that
    // included the seek's own re-derivation spread across 121 frames; this one starts
    // after the seek has settled, so the remainder is zero.
    //
    // **Counted rather than timed**, for the reason stated above.
    const costOfKeying = async (count) => {
      await freshLook();
      const names = (await page.evaluate("__kinect.params.names('look')")).slice(0, count);
      const spec = Object.fromEntries(await Promise.all(names.map(async (name) => {
        const at = await defaultOf(name);
        return [name, [{ t: 0, value: at }, { t: 8, value: at }]];
      })));
      await page.evaluate(`__kinect.keyframes.setTracks(${JSON.stringify(spec)})`);
      await page.evaluate('__kinect.timeline.transport().seek(1)');
      await settle();
      const before = await page.evaluate(
        '({ refreshes: __kinect.groupRefreshes(), renders: __kinect.timeline.counters.renders })');
      await page.evaluate('__kinect.timeline.transport().seek(5)');
      await settle();
      const after = await page.evaluate(
        '({ refreshes: __kinect.groupRefreshes(), renders: __kinect.timeline.counters.renders })');
      await page.evaluate('__kinect.keyframes.setTracks({})');
      const frames = after.renders - before.renders;
      return { keys: names.length, frames, perFrame: frames > 0 ? (after.refreshes - before.refreshes) / frames : NaN };
    };
    // Interleaved rather than one after the other, because a sequential pair on a machine
    // that got busy between them is a comparison of the machine. Two rounds is enough
    // here - the quantity is a count the page keeps rather than a rate, so it does not
    // move - and the detail line prints both rounds so a pair that disagreed is visible.
    const cheap = [await costOfKeying(4), await costOfKeying(4)];
    const dear = [await costOfKeying(8), await costOfKeying(8)];
    const worst = (runs) => Math.max(...runs.map((r) => r.perFrame));
    const ran = [...cheap, ...dear].every((r) => r.frames > 0 && Number.isFinite(r.perFrame));
    check(ran && worst(dear) <= worst(cheap) + 0.5 && worst(dear) < 2,
      'a rendered frame re-derives the panel a fixed number of times rather than once per keyed parameter',
      `${cheap.map((r) => r.perFrame.toFixed(2)).join('/')} per frame with ${cheap[0].keys} parameters keyed, `
      + `${dear.map((r) => r.perFrame.toFixed(2)).join('/')} with ${dear[0].keys}, `
      + `over ${[...cheap, ...dear].map((r) => r.frames).join('/')} rendered frames`);

    // Put the panel and the document back. The rows after this drive a pointer over the
    // stage and pin the drive, and a panel left with four groups open is a different
    // page from the one they were measured on - this is the same rule section 1's nav
    // probe follows about the scroll position it moves.
    await page.evaluate("localStorage.removeItem('kinect.panelGroupsOpen')");
    await freshLook();
  }

  // =====================================================================
  console.log('\n[17] a parameter can be put back, and the offer to put it back is the registry speaking');
  // =====================================================================
  //
  // The reset beside each look slider is four claims wearing one button, and they fail
  // apart rather than together: that every look scalar has one, that whether it is
  // offered is re-read off the registry rather than remembered from the panel's own
  // gestures, that hiding it costs the row no layout, and that pressing it is an
  // ordinary registry write which leaves the caret somewhere a hand can carry on from.
  //
  // **The rows are enumerated from the registry and never from the panel.** A list of
  // the rows that have a reset today is a list that stops covering the row somebody adds
  // next year, which is the failure this whole file exists to refuse - and the panel is
  // generated, so asking the panel what it emitted is asking the thing under test to
  // grade itself.
  //
  // **And the state is driven through a second door on purpose.** Every row here could
  // be satisfied by a button that remembered its own clicks, because a click is the one
  // write a panel-local flag follows correctly. So the block that decides whether this
  // control reads the registry drives the registry from somewhere else entirely - the
  // preset picker - and presses nothing.
  {
    // One shape, read for every parameter the registry declares, and the comparison it
    // carries is against `normalise(default)` rather than against the declared literal.
    // Several defaults are not values a slider can hold - rim is declared 0.55 against a
    // 0.01 step and exposure 1.15 against 0.05 - so a row comparing against the literal
    // would call a parameter modified while it sits exactly where a reset would leave
    // it, and would go on saying so after the press.
    const RESET_STATE = `(() => {
      const k = globalThis.__kinect;
      const vis = (el) => Boolean(el) && el.checkVisibility({ checkVisibilityCSS: true });
      const rowOf = (input) => input.closest('.row') || input.closest('.checkrow') || input.closest('.check');
      const params = k.params.names().map((name) => {
        const spec = k.params.spec(name);
        const input = document.getElementById(name);
        const row = input ? rowOf(input) : null;
        const own = row ? [...row.querySelectorAll('.reset')] : [];
        const button = own.length === 1 ? own[0] : null;
        const group = row ? row.closest('.group[data-group]') : null;
        const scalar = spec.kind !== 'pose';
        const value = scalar ? k.params.get(name) : null;
        const def = scalar ? k.params.normalise(name, spec.default) : null;
        return {
          name,
          tag: spec.tag,
          kind: spec.kind,
          control: input ? input.type : null,
          tab: group ? group.dataset.panelTab || null : null,
          group: group ? group.dataset.group || null : null,
          collapsible: Boolean(group && group.querySelector(':scope > .grouphead > .grouptoggle')),
          // Every reset in the row and the name each one claims, so a row carrying two
          // of them, or one carrying its neighbour's name, is visible here rather than
          // counted as one.
          claims: own.map((b) => b.dataset.reset || ''),
          offered: button ? button.dataset.modified : null,
          disabled: button ? button.disabled : null,
          onScreen: button ? vis(button) : null,
          rowOnScreen: vis(row),
          offDefault: scalar ? value !== def : null,
          value,
          def,
          // A checkbox answers .value with the string "on" whatever its state is, so
          // reading it that way says the same thing about a row that was just put back
          // and a row that was not. .checked is where a step parameter's state is.
          slider: input ? (input.type === 'checkbox' ? input.checked : input.value) : null,
          readout: row ? (row.querySelector('output') ? row.querySelector('output').textContent : null) : null,
        };
      });
      // Asked of the whole document rather than of the rows the walk above expects, so a
      // reset planted in a group head, in the strip, or beside a control that is not a
      // parameter at all is seen. A sweep that only looks where it expects to find
      // something cannot report one anywhere else.
      const planted = [...document.querySelectorAll('.reset')].map((b) => {
        const row = b.closest('.row') || b.closest('.checkrow') || b.closest('.check');
        const input = row ? row.querySelector('input') : null;
        return { claims: b.dataset.reset || '', inRowOf: input ? input.id : null };
      });
      return { params, planted };
    })()`;
    const resetState = () => page.evaluate(RESET_STATE);
    // The state a fresh project arrives in, spelled the way `restoreProject` spells it.
    const freshLook = async () => {
      await page.evaluate('__kinect.keyframes.setTracks({})');
      await page.evaluate("__kinect.params.reset(__kinect.params.names('look'))");
      await settle();
    };
    // The control's own path and never `params.set`, because half of what this section
    // is about is which door a write came through - and the value that came out is read
    // back against the value that went in, which is this repo's rule for any `.value` a
    // tool assigns by hand.
    const driveSlider = async (name, value) => page.evaluate(`(() => {
      const el = document.getElementById(${JSON.stringify(name)});
      if (el.type === 'checkbox') el.checked = Boolean(${JSON.stringify(value)});
      else el.value = String(${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return globalThis.__kinect.params.get(${JSON.stringify(name)});
    })()`);
    // One step off the default, taken off the registry's own grid rather than chosen,
    // so this cannot become a write of the value that was already there - which would
    // leave every row below asserting the state it started in.
    const oneStepOff = (name) => page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const spec = k.params.spec(${JSON.stringify(name)});
      const def = k.params.normalise(${JSON.stringify(name)}, spec.default);
      // A step parameter has one other state and no grid to walk along, so "one step
      // off its default" is the negation. Asking a checkbox for def plus a step
      // answers with a number it cannot hold.
      if (spec.kind === 'step') return !def;
      return def + spec.step <= spec.max ? def + spec.step : def - spec.step;
    })()`);

    await freshLook();
    await page.locator('.paneltab[data-panel-tab="look"]').click();
    await settle();

    // ---- 17a. the set of rows that carry one, computed from the registry
    const rest = await resetState();
    // **Every look parameter the panel gives a control to, which is the scalars and the
    // three checkboxes.** The reset started life as a slider's affordance and the rule
    // here named `scalar` for that reason; the panel now offers one on a step row too,
    // and a rule still spelling `scalar` would have said the checkbox rows were
    // carrying a control they were not entitled to while saying nothing at all about
    // whether pressing it worked. `pose` is the one kind left out, because the camera
    // is not a row.
    const scalars = rest.params.filter((p) => p.tag === 'look'
      && (p.kind === 'scalar' || p.kind === 'step'));
    const missing = scalars.filter((p) => p.claims.length !== 1 || p.claims[0] !== p.name);
    const tabs = [...new Set(scalars.map((p) => p.tab))];
    const perTab = tabs.map((t) => {
      const on = scalars.filter((p) => p.tab === t);
      return `${t} ${on.filter((p) => p.claims.length === 1).length}/${on.length}`;
    }).join(', ');
    check(scalars.length > 0 && missing.length === 0,
      `every look parameter the panel renders a control for carries exactly one reset naming itself (${scalars.length})`,
      missing.length ? `${missing.length} wrong: ${missing.map((p) => `${p.name}[${p.tab}] ${p.claims.join('+') || 'none'}`).join(', ')}`
        : `per inspector: ${perTab}, of which `
          + `${scalars.filter((p) => p.kind === 'step').length} are checkboxes`);

    // The set above is the registry's `scalar`, and the generator's condition is the
    // rendered control not being a checkbox. Those are two spellings of one rule and
    // nothing made them agree, so a `kind` that stopped implying its control would leave
    // the row above asserting about the wrong population while reading perfectly.
    const looks = rest.params.filter((p) => p.tag === 'look');
    const splitWrong = looks.filter((p) => (p.kind === 'scalar') !== (p.control === 'range'));
    check(looks.length > 0 && splitWrong.length === 0,
      'and the registry kind that decides it is the control the panel renders, so the row above is about the set it names',
      splitWrong.length ? splitWrong.map((p) => `${p.name} is ${p.kind} on a ${p.control}`).join(', ')
        : `${looks.filter((p) => p.kind === 'scalar').length} scalars on ranges, `
          + `${looks.filter((p) => p.kind === 'step').length} steps on checkboxes`);

    // The other direction. A row is missing a reset or a row has one it should not, and
    // only the first has been asked so far - so this asks whether every reset that
    // exists is in the row of a parameter entitled to one. No count in it, deliberately:
    // a count here would redden for a row that lost its reset as well, and two rows
    // failing for one reason is one row written twice.
    const entitled = new Set(scalars.map((p) => p.name));
    const strayButton = rest.planted.filter((b) => !entitled.has(b.claims) || b.inRowOf !== b.claims);
    const strayRow = rest.params.filter((p) => !entitled.has(p.name) && p.claims.length > 0);
    check(rest.planted.length > 0 && strayButton.length === 0 && strayRow.length === 0,
      'and nothing else carries one: not a view parameter, and not a control that is no parameter at all',
      strayButton.length || strayRow.length
        ? `${strayButton.map((b) => `${b.claims || '(unnamed)'} sits in the row of ${b.inRowOf || 'nothing'}`).join(', ')} `
          + `${strayRow.map((p) => `${p.name} (${p.kind}/${p.tag}) carries ${p.claims.join('+')}`).join(', ')}`
        : `${rest.planted.length} resets, each in its own parameter's row`);

    // ---- 17b. a look nobody has touched offers nothing
    const carried = (state) => state.params.filter((p) => p.claims.length === 1 && p.claims[0] === p.name);
    const quiet = carried(rest);
    const offeredAtRest = quiet.filter((p) => p.offered !== 'no' || p.disabled !== true);
    check(quiet.length > 0 && quiet.every((p) => !p.offDefault) && offeredAtRest.length === 0,
      'a look sitting at its defaults offers no reset anywhere, and every one of them is disabled',
      offeredAtRest.length
        ? offeredAtRest.map((p) => `${p.name} offered=${p.offered} disabled=${p.disabled} value ${p.value} against ${p.def}`).join(', ')
        : `${quiet.length} rows, all unoffered and disabled, all on their defaults`);

    // The attribute against the rendered result, because the attribute is only the half
    // this file can read cheaply and the stylesheet is the half a person sees. A build
    // that set `data-modified` perfectly with the rule that hides it deleted would pass
    // every other row in this section.
    const shownAtRest = quiet.filter((p) => p.rowOnScreen);
    check(shownAtRest.length >= 10 && shownAtRest.every((p) => p.onScreen === false),
      'and a reset that is not offered is not on the screen either, so the attribute is the rendered state',
      `${shownAtRest.filter((p) => p.onScreen === false).length} of ${shownAtRest.length} rows on screen show nothing`);

    // ---- 17c. the door this control has to read, and it is not its own
    //
    // **The row this whole section turns on.** Everything above and below could be
    // satisfied by a button that remembered its own clicks, because a click is exactly
    // the write a panel-local flag follows correctly. The registry is reached by a
    // preset, by a project file, by undo and by step 5's tracks as well as by the
    // slider, so the question is whether the offer follows a write that arrived through
    // one of those - and the answer has to be taken with nothing pressed.
    //
    // Driven through the rendered picker rather than through `applyStoredPreset`, for
    // the reason section 12 states about the subset dialog: a probe attached below the
    // control passes on a build whose control is wired to nothing.
    const presetIdle = () => page.waitForFunction(
      '!globalThis.__kinect.library.presetGestureRunning()', null, { timeout: 15000 });
    // Whichever look the library holds, preferring the one this repo grades against.
    // A name written down here would be a name that has to exist on somebody else's
    // server, and the row cares only that applying it moves several parameters.
    // Read off the picker's own entries rather than off `.options`. The control stopped
    // being a `<select>` when it grew the mark and the per-entry delete Pencil draws, so
    // `options` is undefined on it and `selectOption` has nothing to select - both threw
    // here, which is the loud direction and is why this row is the one that found it.
    const presetName = await page.evaluate(`(() => {
      const values = [...document.querySelectorAll('#tPresetList .pickeroption')]
        .map((o) => o.dataset.name).filter(Boolean);
      return values.includes('blackwall') ? 'blackwall' : (values[0] ?? null);
    })()`);
    const beforeApply = carried(await resetState()).filter((p) => p.offered === 'yes').map((p) => p.name);
    await presetIdle();
    // Through the control rather than by assignment, because a picker whose entries had
    // stopped being pressable would still take a written `value` and this row would go on
    // measuring the apply behind a menu nobody could operate.
    // And the choice is the whole gesture - there is no `apply` to press after it. The
    // picker applies what is chosen, which is why the two lines above are the driver and
    // a third pressing a button would be pressing one the design retired.
    await page.click('#tPreset');
    await page.click(`#tPresetList .pickeroption[data-name="${presetName}"]`);
    await presetIdle();
    await settle();
    const applied = await resetState();
    const withReset = carried(applied);
    const moved = withReset.filter((p) => p.offDefault);
    const disagree = withReset.filter((p) => (p.offered === 'yes') !== p.offDefault);
    check(Boolean(presetName) && beforeApply.length === 0 && moved.length >= 3 && disagree.length === 0,
      'a preset applied from the picker moves which rows offer a reset, with no reset pressed',
      disagree.length
        ? `${disagree.length} disagree: ${disagree.slice(0, 8).map((p) => `${p.name} offered=${p.offered} value ${p.value} against ${p.def}`).join(', ')}`
        : `${presetName} moved ${moved.length} of ${withReset.length} rows off their defaults, `
          + `${beforeApply.length} were offered before it`);

    // The half that keeps a hidden control unreachable rather than merely unseen, asked
    // over both populations at once because this state has both in it - a `visibility`
    // rule takes the button out of the tab order, and `disabled` is what makes that true
    // of a build whose stylesheet somebody rewrites.
    const enabledWrong = withReset.filter((p) => p.disabled !== (p.offered === 'no'));
    check(withReset.length > 0 && moved.length > 0 && moved.length < withReset.length && enabledWrong.length === 0,
      'and disabled agrees with it on every row, so a reset nobody is being offered cannot be pressed or tabbed to',
      enabledWrong.length
        ? enabledWrong.map((p) => `${p.name} offered=${p.offered} disabled=${p.disabled}`).join(', ')
        : `${moved.length} offered and enabled, ${withReset.length - moved.length} unoffered and disabled`);

    // ---- 17d. the slot is reserved, so a row does not move when the offer appears
    //
    // Measured over the rows that are on screen and in a group nothing can collapse, so
    // the two snapshots differ in the reset's own state and in nothing else. A
    // collapsible group would open or shut somewhere between them and the comparison
    // would be about the panel's height.
    //
    // The readout is not a confound here and it was worth checking rather than assuming:
    // `<output>` is `flex: 0 0 42px` with tabular numerals, so a value going from one
    // character to three moves nothing. Both strings are printed for that reason.
    await freshLook();
    await settle();
    // **The inspector holding the non-collapsing group is selected first**, because
    // "on screen" is now a fact about which tab is showing. The panel became four tabs
    // over one registry-built body, and the rows this measurement needs - in a group
    // nothing collapses, so the two snapshots differ in the reset alone - are all in
    // `framing`, which is on its own tab. Measured from the `look` tab this filter
    // answers with an empty list, and the three rows below then compare nothing while
    // reporting that they compared nothing identically.
    const steadyTab = (await resetState()).params
      .find((p) => p.tag === 'look' && p.kind === 'scalar' && !p.collapsible && p.tab)?.tab;
    if (steadyTab) {
      await page.locator(`.paneltab[data-panel-tab="${steadyTab}"]`).click();
      await settle();
    }
    const stable = (await resetState()).params
      .filter((p) => p.tag === 'look' && p.kind === 'scalar' && p.rowOnScreen && !p.collapsible)
      .map((p) => p.name);
    const GEOM = (names) => `(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return [Math.round(r.x * 100) / 100, Math.round(r.width * 100) / 100];
      };
      return ${JSON.stringify(names)}.map((name) => {
        const input = document.getElementById(name);
        const row = input.closest('.row');
        const button = row.querySelector('.reset');
        return {
          name,
          offered: button.dataset.modified,
          resetBox: box(button),
          children: [...row.children].map((c) => [c.tagName + '.' + (c.className || ''), ...box(c)]),
          readout: row.querySelector('output').textContent,
        };
      });
    })()`;
    const hiddenGeom = await page.evaluate(GEOM(stable));
    for (const name of stable) await driveSlider(name, await oneStepOff(name));
    await settle();
    const shownGeom = await page.evaluate(GEOM(stable));
    const shownOf = (name) => shownGeom.find((s) => s.name === name);
    // The precondition, and without it "identical" is what a page where nothing happened
    // also reports. Both snapshots have to be the states they are named after - which is
    // also the round trip on every `value` written above, since a write that did not land
    // leaves the row still reading unoffered.
    const bothStates = stable.length >= 8
      && hiddenGeom.every((r) => r.offered === 'no') && shownGeom.every((r) => r.offered === 'yes');
    check(bothStates,
      'the two snapshots really are the hidden state and the shown state, or the two rows below compare nothing',
      `${stable.length} rows in a group nothing collapses: ${stable.join(', ')}`);
    const boxLost = hiddenGeom.filter((r) => r.resetBox[1] !== shownOf(r.name).resetBox[1] || r.resetBox[1] === 0);
    check(bothStates && boxLost.length === 0,
      'the reset keeps its box on the row while it is not being offered, rather than being taken out of the flow',
      boxLost.length ? boxLost.map((r) => `${r.name} ${r.resetBox.join('x')} against ${shownOf(r.name).resetBox.join('x')}`).join(', ')
        : `${hiddenGeom.length} rows, every reset ${hiddenGeom.length ? hiddenGeom[0].resetBox[1] : '?'}px wide in both states`);
    const reflowed = hiddenGeom.filter((r) => JSON.stringify(r.children) !== JSON.stringify(shownOf(r.name).children));
    check(bothStates && reflowed.length === 0,
      'and nothing else in the row moved between the two states, so a drag that moves a value does not move the control under the pointer',
      reflowed.length
        ? reflowed.slice(0, 3).map((r) => `${r.name} ${JSON.stringify(r.children)} -> ${JSON.stringify(shownOf(r.name).children)}`).join(' | ')
        : `${hiddenGeom.length} rows identical to the hundredth of a pixel, readouts `
          + `${hiddenGeom.length ? `${hiddenGeom[0].readout} -> ${shownGeom[0].readout}` : 'none'}`);

    // ---- 17e. the press, and what a press is
    //
    // Three observables rather than one, because the registry agreeing with itself is
    // exactly what a build writing around the registry produces: the value the registry
    // holds, the position the slider is at, and the number the row prints are three
    // things a single write path keeps level and a bypass does not.
    //
    // **Every press below is arm-then-check-then-click, and the middle step is the one
    // that keeps a broken build reportable.** Playwright waits for a control to be
    // visible and enabled before it clicks, so a build where the drag stopped offering
    // the reset turns each of these into a thirty-second timeout - which arrives as a
    // crash carrying no failed assertion, the shape this repo has three entries about. A
    // bounded wait turns it into a row.
    const armReset = async (name) => {
      await driveSlider(name, await oneStepOff(name));
      await settle();
      const armed = await page.waitForFunction(
        `(() => { const b = document.querySelector('.reset[data-reset=${name}]');
          return Boolean(b) && !b.disabled && b.checkVisibility({ checkVisibilityCSS: true }); })()`,
        null, { timeout: 2500 }).then(() => true, () => false);
      if (armed) await page.click(`.reset[data-reset=${name}]`);
      await settle();
      return armed;
    };

    // **Every one of them, and the count is what makes the driver rule honest.** Section
    // 1 credits all fifty-one of these controls to this section by their `data-reset`
    // attribute, and a rule crediting fifty-one while a section pressed three is the
    // sweep claiming coverage it does not have - the same failure the mark rule had when
    // it matched nothing, arriving from the other direction. So the loop is over the
    // registry's own list: drag the parameter off its default, wait for the row to offer
    // the reset, press it, and move on. A parameter added next year is pressed here by
    // existing rather than by being remembered.
    //
    // Grouped by inspector because a reset in a hidden tab cannot be clicked, and the
    // press is a real click rather than a synthesised event - Playwright waits for the
    // control to be visible and enabled, which is the same waiting a hand does.
    await freshLook();
    await settle();
    const unarmed = [];
    const byTab = new Map();
    for (const p of scalars) {
      if (!byTab.has(p.tab)) byTab.set(p.tab, []);
      byTab.get(p.tab).push(p.name);
    }
    for (const [tab, names] of byTab) {
      await page.locator(`.paneltab[data-panel-tab="${tab}"]`).click();
      await settle();
      for (const name of names) if (!(await armReset(name))) unarmed.push(name);
    }
    check(unarmed.length === 0 && scalars.length > 0,
      `every reset the panel renders was pressed here, each offered by its own drag first (${scalars.length})`,
      unarmed.length ? `${unarmed.length} never offered after the drag, so they were never pressed: ${unarmed.join(', ')}`
        : `${scalars.length} of ${scalars.length} across ${[...byTab.keys()].join(', ')}`);

    // One read after the whole sweep rather than one per press, because the claim is
    // about the state each press left and every one of them has now happened. Three
    // observables and not one: a build writing around the registry keeps the value map
    // right and leaves the slider and the readout showing what was there.
    const afterPresses = carried(await resetState());
    // Three observables on a slider row and two on a checkbox row, because a checkrow
    // has no `<output>` to disagree with - the checkbox is its own readout. Comparing a
    // missing readout against the default would redden all three step rows for the one
    // thing they cannot have.
    const notBack = afterPresses.filter((p) => p.value !== p.def
      || (p.kind === 'step'
        ? p.slider !== p.def
        : p.slider !== String(p.def) || p.readout !== String(p.def)));
    check(afterPresses.length > 0 && notBack.length === 0,
      'pressing a reset puts the registry, the slider and the readout back on the normalised default together',
      notBack.length
        ? `${notBack.length} of ${afterPresses.length} did not: `
          + notBack.slice(0, 4).map((p) => `${p.name} registry ${p.value}, slider ${p.slider}, readout ${p.readout}, default ${p.def}`).join('; ')
        : `${afterPresses.length} rows, including pointSize ${afterPresses.find((p) => p.name === 'pointSize')?.value}, `
          + `rim ${afterPresses.find((p) => p.name === 'rim')?.value}, exposure ${afterPresses.find((p) => p.name === 'exposure')?.value}`);
    const stillOffered = afterPresses.filter((p) => p.offered !== 'no' || p.disabled !== true);
    check(stillOffered.length === 0,
      'and the row stops offering it, because the offer is the comparison and the comparison has just become an equality',
      stillOffered.length
        ? `${stillOffered.length} still offered: ${stillOffered.slice(0, 6).map((p) => `${p.name} offered=${p.offered} disabled=${p.disabled}`).join(', ')}`
        : `${afterPresses.length} rows unoffered and disabled again`);
    await page.locator('.paneltab[data-panel-tab="look"]').click();
    await settle();

    // The press is a registry write and not an assignment, and the group is where that
    // shows: the group holding `bloom` is open only because `bloom` is carrying
    // something, so putting `bloom` back has to reach the reveal rule as well as the
    // value map. A build writing straight into the map leaves the group open over a
    // parameter that is no longer carrying anything, with the value correct and nothing
    // downstream told.
    //
    // **Which group that is comes off the row, not out of a name written here.** It was
    // `optical` and the rework renamed it, so both reads below became
    // `querySelector(...).classList` on null and took sections 18, 19 and 20 with them -
    // a crash carrying no failed assertion, which is the reading `docs/instruments.md`
    // warns is not a catch. Asking the parameter's own row which group contains it is
    // the same question with nothing to go stale.
    await freshLook();
    await settle();
    await driveSlider('bloom', await oneStepOff('bloom'));
    await settle();
    const bloomGroup = await page.evaluate(
      "document.getElementById('bloom').closest('.group[data-group]').dataset.group");
    const groupShut = (key) => page.evaluate(
      `document.querySelector('.group[data-group=${key}]').classList.contains('shut')`);
    const openedBy = (await resetState()).params.find((p) => p.name === 'bloom');
    const opticalOpen = !(await groupShut(bloomGroup));
    check(openedBy.offered === 'yes' && opticalOpen,
      'a value moved into a collapsible group opens it and offers the reset, or the three rows below test nothing',
      `bloom offered=${openedBy.offered}, ${bloomGroup} open=${opticalOpen}`);
    // Conditional for the reason `armReset` above is bounded: a press into a control the
    // build is not offering is a thirty-second timeout rather than a finding, and the row
    // above has just said whether it is being offered.
    if (openedBy.offered === 'yes') await page.click('.reset[data-reset=bloom]');
    await settle();
    const bloomDefault = await page.evaluate(
      "__kinect.params.normalise('bloom', __kinect.params.spec('bloom').default)");
    const afterBloom = await page.evaluate(`(() => ({
      shut: document.querySelector('.group[data-group=${bloomGroup}]').classList.contains('shut'),
      value: globalThis.__kinect.params.get('bloom'),
      focus: document.activeElement === null ? 'null'
        : (document.activeElement.id || document.activeElement.tagName.toLowerCase()),
      onBody: document.activeElement === null || document.activeElement === document.body,
    }))()`);
    check(afterBloom.shut && afterBloom.value === bloomDefault,
      'and the group re-derives shut behind it, so the press reached everything a registry write reaches',
      `${bloomGroup} shut=${afterBloom.shut}, bloom reads ${afterBloom.value} against a default of ${bloomDefault}`);

    // ---- 17f. where the caret is afterwards
    //
    // The press removes its own control: writing the default makes the row unmodified,
    // which disables the button while it is the focused element, and focus falls to the
    // body with no way back into the panel short of tabbing from the top. This repo
    // already polices that class in three places - `dialog-close-strands-focus`,
    // `viewer-drops-focus-on-rebuild` and `menu-close-strands-focus` - so it is a row
    // here rather than a detail.
    //
    // **Two rows, because the two cases are answered by different code and only one of
    // them is answered.** Outside a collapsible group the slider is still rendered when
    // the handler reaches for it and the caret lands there. Inside one, the write shuts
    // the group on its way out - `params.set` runs `groupRevealChanged` before the
    // handler gets its turn - so the slider is `display: none` by then, `focus()` is a
    // no-op on it, and the caret is on the body. That is the row below and it is red on
    // this tree: twenty-six of the fifty-one parameters live in a group that collapses.
    // It is written as "not stranded" and prints where the caret landed, rather than
    // demanding the slider by name, because focusing the group's own toggle would be a
    // perfectly good answer and a row naming the input would stay red over it.
    check(!afterBloom.onBody,
      'a press that shuts the group it was in still leaves the caret somewhere in the panel',
      `the caret is on ${afterBloom.focus}`);
    await freshLook();
    await settle();
    // **A parameter whose group cannot collapse, and it is chosen rather than named.**
    // This row is the other half of the pair above: the caret lands on the slider only
    // where the slider is still rendered when the handler reaches for it, which is a
    // group that does not shut behind the write. It named `pointSize`, and `points`
    // collapses - so the honest answer here is the fallback and the row was asking the
    // question the row above already answers. `stable` is the set the geometry rows
    // were measured on, which is exactly "a look scalar in a group nothing collapses".
    const steady = stable[0];
    if (steadyTab) {
      await page.locator(`.paneltab[data-panel-tab="${steadyTab}"]`).click();
      await settle();
    }
    await armReset(steady);
    const caret = await page.evaluate(`(() => (document.activeElement === null ? 'null'
      : (document.activeElement.id || document.activeElement.tagName.toLowerCase())))()`);
    check(caret === steady,
      "pressing a reset leaves the caret on that row's own slider, which is the control the press was about",
      `the caret is on ${caret}`);

    // Put the look, the store and the inspector back. The section after this drags a
    // pointer across the stage and pins the drive, and a panel left with a group open
    // and a value planted is a different page from the one that row was measured on.
    //
    // **The tab is part of that state**, because the rows above stand on whichever
    // inspector holds the group nothing collapses and the preset picker is on `look`.
    // A section leaving another tab selected costs the next one a click on an element
    // that is `display: none`, which arrives as a thirty-second timeout naming a
    // control that is plainly in the document.
    await page.evaluate("localStorage.removeItem('kinect.panelGroupsOpen')");
    await freshLook();
    await page.locator('.paneltab[data-panel-tab="look"]').click();
    await settle();
  }

  // ================================ 18. walking the selected parameter's own keys

  console.log('\n[18] prev and next walk the selected track, and go quiet at its ends');

  // The pair the design draws beside the ease presets. Two claims, and they are separated
  // because they fail for different reasons: where the playhead *lands*, and whether the
  // control offers a press at all when there is nothing that way.
  //
  // The disabled half is deliberately first and carries the weight, because it is
  // decided by arithmetic over a planted track and is the same answer on a loaded
  // machine as on an idle one. The landing half is a seek, and a seek on this rig can
  // resolve without moving - so it asserts the playhead against *the time of the key it
  // was walking to* and prints both, rather than asking whether the playhead changed.
  // "It moved" is true of a build that walks to the wrong key.
  {
    const setTracks = async (spec) => {
      await page.evaluate(`__kinect.keyframes.setTracks(${JSON.stringify(spec)})`);
      await settle();
    };
    const at = async () => page.evaluate('__kinect.timeline.transport().programSec');
    const navState = async () => page.evaluate(`(() => ({
      prev: document.getElementById('tPrevKey').disabled,
      next: document.getElementById('tNextKey').disabled,
    }))()`);
    const park = async (t) => {
      await page.evaluate(`__kinect.timeline.transport().pause()`);
      await page.evaluate(`__kinect.timeline.transport().seek(${t})`);
      await settle();
    };

    // Three keys at distinct times, so a build that walks to the *nearest* key rather
    // than the next one in the asked direction, or one that always lands on the first,
    // disagrees with this fixture. A two-key track answers the same either way.
    const KEYS = [1, 5, 9];
    await setTracks({ bloom: KEYS.map((t, i) => ({ t, value: 0.2 + i * 0.3 })) });
    await page.evaluate(`__kinect.editor.select('bloom', 0)`);
    await park(0);

    const atHead = await navState();
    check(atHead.prev === true && atHead.next === false,
      'parked before every key, there is nowhere back and somewhere forward',
      `prev disabled ${atHead.prev}, next disabled ${atHead.next}`);

    // Read before pressing, and fail the row rather than driving a control that is not
    // there to drive. A build that walks to the wrong key arrives at the end of the track
    // early, which leaves the next press aimed at a disabled button - and an unguarded
    // `click` on one waits out its full timeout and ends the run as a crash, with the rows
    // after it never reached. `keynav-walks-to-the-far-key` did exactly that before this
    // guard: 397 of 404 with one failure, which reads as a catch and is a run that stopped.
    const walk = async (button, want, label) => {
      const before = await navState();
      const armed = button === '#tNextKey' ? !before.next : !before.prev;
      if (!armed) {
        check(false, label, `the control was disabled before the press, so the walk stopped short of ${want}s`);
        return false;
      }
      await page.locator(button).click();
      await settle();
      const landed = await at();
      check(near(landed, want, 1e-3), label,
        `landed ${landed.toFixed(4)}s against the key's ${want.toFixed(4)}s`);
      return true;
    };

    for (const want of KEYS) await walk('#tNextKey', want, `next walks to the key at ${want}s`);

    const atTail = await navState();
    check(atTail.next === true && atTail.prev === false,
      'and on the last key there is nowhere further forward',
      `prev disabled ${atTail.prev}, next disabled ${atTail.next}`);

    for (const want of [5, 1]) await walk('#tPrevKey', want, `prev walks back to the key at ${want}s`);

    // A track with nothing on it is the other end of the same rule, and it is the row a
    // build that decided the state from the selection rather than from the keys would
    // fail: something is still selected here, and there is nothing to walk to.
    await setTracks({ bloom: [] });
    await park(4);
    const empty = await navState();
    check(empty.prev === true && empty.next === true,
      'a track with no keys offers neither direction',
      `prev disabled ${empty.prev}, next disabled ${empty.next}`);
  }

  // ================================ 19. the preset picker the design draws

  console.log('\n[19] the preset picker: roles, a keyboard, and a delete that leaves a caret somewhere');

  // The control that replaced the `<select>`. What a native one gave away for free is
  // what this section is about - the roles, the arrow keys, the type-ahead - because
  // owning the widget means owning all of it, and the half nobody writes is the half that
  // only a keyboard finds.
  {
    const trigger = '#tPreset';
    const list = '#tPresetList';
    const shape = async () => page.evaluate(`(() => {
      const t = document.getElementById('tPreset');
      const l = document.getElementById('tPresetList');
      const options = [...l.querySelectorAll('.pickeroption')];
      return {
        role: t.getAttribute('role'),
        popup: t.getAttribute('aria-haspopup'),
        expanded: t.getAttribute('aria-expanded'),
        listRole: l.getAttribute('role'),
        hidden: l.hidden,
        value: t.value,
        shown: t.querySelector('.pickervalue').textContent,
        names: options.map((o) => o.dataset.name),
        optionRoles: [...new Set(options.map((o) => o.getAttribute('role')))],
        deletable: options.filter((o) => o.querySelector('.pickerdelete')).map((o) => o.dataset.name),
        builtin: options.filter((o) => o.dataset.builtin === 'true').map((o) => o.dataset.name),
        add: (() => { const a = document.getElementById('tPresetAdd'); return a ? [a.offsetWidth, a.offsetHeight] : null; })(),
        // Or-else and not nullish-coalescing. The DOM answers an absent id or dataset key
        // with the empty string, which is not nullish, so nullish-coalescing stops there
        // and reports it - and a row asking whether focus is off the body then passes on a
        // caret that is exactly on it. Measured: the drops-focus control came back NOT
        // CAUGHT at 415 assertions and none failed while this line coalesced. The suite
        // notes carry the same trap costing the gallery two red rows about nothing.
        focus: document.activeElement?.dataset?.name
          || document.activeElement?.id || document.activeElement?.tagName || 'nothing',
      };
    })()`);

    const shut = await shape();
    check(shut.role === 'combobox' && shut.popup === 'listbox' && shut.listRole === 'listbox'
      && shut.optionRoles.length === 1 && shut.optionRoles[0] === 'option' && shut.names.length > 1,
      'the picker announces itself as a listbox and every entry in it as an option',
      `trigger ${shut.role}/${shut.popup}, list ${shut.listRole}, `
      + `${shut.names.length} entries as ${shut.optionRoles.join('/') || 'nothing'}`);
    await page.click(trigger);
    const open = await shape();
    // Measured with the list open, and that is not a detail. The add button lives inside
    // the list, a shut list is `hidden`, and a hidden element's box is 0x0 - so the first
    // spelling of this row read the button while nothing could see it and reported `0x0`
    // against a control that is exactly the size it should be. A geometric row taken where
    // the geometry does not exist is the dead-zone rule in its plainest form.
    check(open.add && open.add[0] === 24 && open.add[1] === 24,
      'and it carries the 24x24 add button the design draws',
      open.add ? `${open.add[0]}x${open.add[1]}` : 'no add button');
    check(open.hidden === false && open.expanded === 'true' && open.names.includes(open.focus),
      'opening it says so and hands the caret to an entry rather than leaving it on the trigger',
      `expanded ${open.expanded}, focus on ${open.focus}`);

    await page.keyboard.press('ArrowDown');
    const down = (await shape()).focus;
    await page.keyboard.press('ArrowUp');
    const up = (await shape()).focus;
    check(down !== up && open.names.includes(down) && open.names.includes(up),
      'the arrow keys walk the entries, which is the whole of what a native option gave away',
      `down to ${down}, back up to ${up}`);

    // Type-ahead against an entry that is not the one already focused, or the row cannot
    // tell a search from standing still. Two characters, because one is answered by any
    // build that jumps to the first entry beginning with a letter.
    const wanted = open.names.find((n) => n !== up && n.length > 1) ?? open.names[0];
    for (const ch of wanted.slice(0, 2)) await page.keyboard.press(ch);
    const typed = (await shape()).focus;
    check(typed === wanted, 'and typing a name reaches it, so a long library is navigable without the pointer',
      `typed ${JSON.stringify(wanted.slice(0, 2))} and landed on ${typed}, wanted ${wanted}`);

    await page.keyboard.press('Escape');
    const escaped = await shape();
    check(escaped.hidden === true && escaped.focus === 'tPreset',
      'Escape shuts it and puts the caret back on the trigger rather than on the body',
      `hidden ${escaped.hidden}, focus ${escaped.focus}`);

    // A library of shipped looks alone cannot show what a delete does, and the fixture has
    // only those - so one is planted through the real route. `builtin` is the server's word
    // for "in a directory the store reads and never writes", which is what decides whether
    // an entry gets a delete at all.
    const PLANTED = `ec${process.pid}-picker`;
    const seed = await (await fetch(`${URL_BASE}/presets/${encodeURIComponent(shut.names[0])}`)).json();
    await fetch(`${URL_BASE}/presets/${encodeURIComponent(PLANTED)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: seed.version, values: seed.values }),
    });
    await page.evaluate('__kinect.library.refreshPresets()');
    const planted = await shape();
    // The list is the shipped looks, whatever has been saved, **and the `none` row at
    // the top**, which is an entry with no name and no file behind it - so it is
    // neither shipped nor deletable, and a rule reading "everything but the planted one
    // is builtin" counts it as a shipped look that lost its badge. That is what this
    // row reddened over: seven entries, five shipped, and the sixth was `none`.
    const named = planted.names.filter((n) => n !== '');
    check(planted.names.includes(PLANTED) && planted.deletable.join(',') === PLANTED
      && planted.builtin.length === named.length - 1,
      'a delete is drawn on the entries that have one and on no others, which is the shipped looks left alone',
      `${planted.names.length} entries, ${planted.builtin.length} shipped, deletable: `
      + `${planted.deletable.join(', ') || 'none'}`);

    // The claim the class `viewer-drops-focus-on-rebuild` already polices, arriving here:
    // the row holding the caret is the row being removed, so the list that comes back has
    // no element the browser could have kept it on.
    await page.click(trigger);
    await page.focus(`${list} .pickeroption[data-name="${PLANTED}"]`);
    await page.click(`${list} .pickeroption[data-name="${PLANTED}"] .pickerdelete`);
    await page.waitForFunction(
      '!globalThis.__kinect.library.presetGestureRunning()', null, { timeout: 15000 },
    );
    const after = await shape();
    check(!after.names.includes(PLANTED),
      'deleting an entry takes it out of the library the picker is drawn from',
      `${after.names.length} entries: ${after.names.join(', ')}`);
    // Asked positively - the caret is on one of the entries that are left, or back on the
    // trigger - rather than as "not the body". A negative row is satisfied by every value
    // the probe could report by mistake, which is how the first spelling of this one passed
    // against a build that stranded focus exactly as its mutation intended.
    check(after.names.includes(after.focus) || after.focus === 'tPreset',
      'and the caret survives the rebuild the delete causes, landing on an entry or the trigger',
      `focus landed on ${after.focus}, of ${after.names.join(', ')} or the trigger`);
  }

  // ================================ 20. the pinned drive takes the loop away with it

  console.log('\n[20] the crop box: shown, dragged, and paid for out of the animation loop');

  // Six numbers describing a box, with the box drawn and its faces draggable. Three
  // claims, and the third is the one that would ship broken quietly.
  //
  // The box lives on the chrome canvas, so nothing here can read a pixel of it - what
  // it reads is the geometry the drawing is built from, which is the same array the
  // edges and the handles come out of rather than a second computation agreeing with
  // itself. `plan-box-ignores-tilt` in `level-check` is what holds that array to the
  // room's frame; this section is about the control, the gesture and its cost.
  {
    await page.locator('#panelTabFraming').click();
    await page.evaluate('__kinect.timeline.transport().pause()');
    await settle();

    const handles = (plan) => page.evaluate(`__kinect.cropHandles(${plan})`);
    const shownBefore = await page.evaluate('__kinect.cropBoxShown()');
    const beforePress = await handles(false);
    check(shownBefore === false && beforePress.length === 0,
      'the box is off until it is asked for, and offers nothing to grab',
      `shown ${shownBefore}, ${beforePress.length} handles`);

    await page.locator('#cropBox').click();
    await settle();
    const pressed = await page.locator('#cropBox').getAttribute('aria-pressed');
    check(await page.evaluate('__kinect.cropBoxShown()') === true && pressed === 'true',
      'pressing it turns the box on and says so on the control', `aria-pressed ${pressed}`);

    // The faint pass rides on the same press, and this is the row that says so. What it
    // must not do is leave the editor: `cropoutside-reaches-the-export` in `export-check`
    // is that half, and it is a different tool because only an export can see it.
    check(await page.evaluate('__kinect.cropOutside()') > 0,
      'and what the box is cutting draws faintly instead of vanishing while it is on');

    // Faces placed against this fixture rather than at round numbers, on the same terms
    // `registry-check`'s scrambled set is placed: the cloud runs x [-2.31, 2.97] and
    // y [-2.26, 1.63], so a box at +/-0.8 has something to cull on every side and a
    // handle on each face has cloud behind it rather than empty stage.
    await page.evaluate(`(() => {
      for (const [n, v] of [['left', -0.8], ['right', 0.8], ['bottom', -0.8], ['top', 0.8], ['far', 3]]) {
        __kinect.params.set(n, v);
      }
    })()`);
    await settle();

    // **Which faces can be dragged is a measurement, not a list**, and the two views
    // disagreeing about it is the evidence. A face pointing along the line of sight
    // projects its own movement onto nothing, so the pointer has nothing to resolve a
    // distance against - which is why the top-down, which looks straight down, offers
    // the four upright faces and refuses `bottom` and `top`. A build that hardcoded
    // "the plan owns left, right, near and far" would agree with this row and stop
    // agreeing the moment the room was levelled, where the rotation gives the vertical
    // faces real plan leverage and this rule hands them a handle unprompted.
    const planHandles = await handles(true);
    const planNames = planHandles.map((h) => h.param).sort();
    check(!planNames.includes('bottom') && !planNames.includes('top')
      && planNames.includes('near') && planNames.includes('far'),
      'the top-down offers the faces it can show the movement of, and refuses the two it cannot',
      `plan offers ${planNames.join(' ') || 'nothing'}`);
    check(planHandles.every((h) => Math.hypot(h.sx, h.sy) > 0),
      'and every handle it does offer carries a screen scale for the drag to divide by');

    // ---- the drag itself
    const grab = (await handles(false)).find((h) => h.param === 'right');
    check(Boolean(grab), 'the right face is grabbable in the picture');
    if (grab) {
      const canvas = await page.evaluate(`(() => {
        const r = __kinect.renderer.domElement.getBoundingClientRect();
        return { x: r.x, y: r.y };
      })()`);
      const from = await page.evaluate("__kinect.params.get('right')");
      // The setup above wrote through the registry without committing, so the drag's own
      // commit would otherwise be the first snapshot since the section started and one
      // undo would walk back past the box this row is about.
      await page.evaluate('__kinect.keyframes.undo.commit()');

      // Installed before the counters are read, or the first read is of a variable that
      // does not exist yet and every count below comes out NaN - which reads as a row
      // that fired rather than one that never measured anything.
      await page.evaluate(`(() => {
        globalThis.__cropFrames = 0;
        const tick = () => { globalThis.__cropFrames++; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      })()`);
      // **The control the row below is measured against, and it has to be taken here
      // rather than reasoned about.** Every pointer move writes a registry value, and a
      // registry write on a parked playhead is a draft the transport renders - so
      // counting renders across a drag counts the transport's work as well as the
      // handler's, and both builds do the same amount of it. Twenty-four writes with no
      // pointer anywhere near them is exactly the part that is not the gesture, and what
      // the drag is then allowed is that plus a margin.
      const MOVES = 24;
      const writeOnly = await page.evaluate(`(async () => {
        const start = __kinect.timeline.counters.renders;
        for (let i = 1; i <= ${MOVES}; i++) {
          __kinect.params.set('right', 0.8 - i * 0.01);
          await new Promise(requestAnimationFrame);
        }
        return __kinect.timeline.counters.renders - start;
      })()`);
      await page.evaluate("__kinect.params.set('right', 0.8)");
      await settle();

      const before = await page.evaluate(
        '({ renders: __kinect.timeline.counters.renders, frames: globalThis.__cropFrames })');

      const x0 = canvas.x + grab.x;
      const y0 = canvas.y + grab.y;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let i = 1; i <= MOVES; i++) {
        await page.mouse.move(x0 - i * 4, y0);
        await page.evaluate('new Promise(requestAnimationFrame)');
      }
      const during = await page.evaluate("__kinect.params.get('right')");
      const shownDuring = await page.evaluate("document.getElementById('right').value");
      // Read at the release rather than after `settle()`, which drains an accurate seek
      // and renders a pre-roll nobody asked this row about.
      const after = await page.evaluate(
        '({ renders: __kinect.timeline.counters.renders, frames: globalThis.__cropFrames })');
      await page.mouse.up();
      await settle();
      const moved = from - during;
      // Where the pointer went, in the face's own units, from the scale the handle
      // reported before the press. Predicted rather than merely "it changed", because a
      // drag that moved the face the wrong way, or by an arbitrary amount, changes it
      // just as well - and the step is 0.05, so the tolerance is a step either side.
      const predicted = (MOVES * 4) / Math.abs(grab.sx);
      note('dragging the right face', `${from} -> ${during} m over ${MOVES * 4} px `
        + `at ${Math.abs(grab.sx).toFixed(1)} px/m, predicted ${predicted.toFixed(3)} m`);
      check(Math.abs(moved - predicted) <= 0.06,
        'the face follows the pointer by the scale its handle reported, in the face\'s own metres',
        `moved ${moved.toFixed(3)} m against ${predicted.toFixed(3)} m predicted`);
      check(String(during) === shownDuring,
        'and the write goes through the registry, so the slider beside it reads the drag',
        `parameter ${during}, slider ${shownDuring}`);
      // Asserted by undoing rather than by counting the stack, because the stack has a
      // ceiling: a session at its cap grows by nothing whatever a gesture pushed, so a
      // depth comparison reads a build that committed twenty-four times as one that
      // committed once. One press has to put the face all the way back.
      await page.evaluate('__kinect.keyframes.undo.pop()');
      await settle();
      const undone = await page.evaluate("__kinect.params.get('right')");
      check(undone === from,
        'one snapshot for the whole gesture, so one undo puts the face back where it started',
        `undo left it at ${undone}, started at ${from}`);
      await page.evaluate("__kinect.params.set('right', 0.8)");

      // **The row this section exists for.** A handler that rendered would be asking for
      // the next render itself: `renderProgramFrame` runs `advanceNavigation`, which
      // calls `controls.update()`, which fires `change` on a damped control - so the
      // drag would pace itself off its own output. Counted rather than timed, for the
      // reason section 9 gives, and `box-drag-pumps-renders` is the control.
      //
      // **Renders and not `navigationRedraws`**, which was the first counter reached for
      // and would have made this row worthless: a face drag moves no camera, so that
      // counter sits at zero on the correct build and on a build rendering out of the
      // handler alike, and any ceiling at all passes. What separates them is how many
      // frames were drawn for the turns the compositor gave - one apiece when the loop
      // pumps the request, two or more when the handler renders and then asks for
      // another.
      const renders = after.renders - before.renders;
      const frames = after.frames - before.frames;
      note(`${MOVES} pointer moves on a crop handle`,
        `${renders} renders over ${frames} animation frames, against ${writeOnly} `
        + `for the same ${MOVES} writes with no pointer`);
      check(frames > 0, 'the animation loop ran during the drag', `${frames} frames`);
      check(renders > 0, 'and the drag was drawn at all', `${renders} renders`);
      // A handler that rendered would add one render per move on top of the writes it is
      // already making, so the mutated build lands a full `MOVES` above the control. Half
      // of that is the ceiling: comfortably clear of the jitter between two runs of the
      // same twenty-four writes, and half a gesture short of what the bug costs.
      check(renders <= writeOnly + MOVES / 2,
        'and it asked the loop for those renders rather than rendering out of the handler',
        `${renders} renders against ${writeOnly} for the writes alone`);
    }

    await page.evaluate("__kinect.params.reset(['left', 'right', 'bottom', 'top', 'near', 'far'])");
    await page.locator('#cropBox').click();
    await settle();
    check(await page.evaluate('__kinect.cropOutside()') === 0
      && (await handles(false)).length === 0,
      'pressing it again takes the box, its handles and the faint pass back off');
  }

  // =====================================================================
  console.log('\n[21] the panel collapses, and what it collapses to is a fact about the surface');
  // =====================================================================
  //
  // **The enumeration was never the hole here, and that is worth stating because it was
  // predicted to be one.** The dock's buttons are drawn only while the panel is
  // collapsed, which has exactly the shape of the object every observation skips - so
  // the warning was that section 1's sweep would have to visit the collapsed state to
  // see them. It does not: the sweep is a `querySelectorAll` over `#panel` and friends
  // with no visibility filter, so a `display: none` button is enumerated like any other,
  // and the four uncovered rows this feature produced on its first run are the proof
  // that they were seen. The first row below pins that down rather than trusting it,
  // because the property it depends on is that the dock lives *inside* `#panel` - move
  // it out to a bar of its own and the sweep stops seeing it while every other row here
  // still passes, which is the "passes by disappearing" shape section 1 exists to refuse.
  //
  // **What the dock is has since become a question with two answers, and this section is
  // built on the difference.** The dock is the panel's collapsed form rather than a
  // second set of controls, so a surface with no panel has no dock: 2727dfb takes the
  // whole bar off the editor in one rule and gives the picture back the 72px it was
  // occupying, where the recorder - whose panel is most of what is on screen - goes on
  // collapsing to the bar it was designed as. Every row about the bar therefore has to
  // say which surface it is asking about, and the two are driven here as two pages of
  // one build.
  //
  // **The recorder arm is not a convenience, and that is the load-bearing part.** The
  // editor's rows here are *absences*, and an absence measured on one surface alone is
  // satisfied by a build with no dock in the markup at all - the row goes on printing
  // green straight through the deletion of the feature it is watching. Asked of the same
  // five ids, in the same build, under the same collapse, the recorder answers with five
  // controls drawn. So the editor's five withheld ones are a difference between the two
  // surfaces rather than a dock that nothing anywhere has.
  //
  // What still needs the collapsed state is the *driving*. A `display: none` button
  // cannot be pressed the way a thumb presses it, so the rows that press one collapse
  // first and use a real click rather than `el.click()` - the second would fire the
  // handler on a button no operator could have reached, and a control that works only
  // when driven by something no hand can do is the row passing for the wrong reason.
  //
  // The two view buttons are read as outcomes and the two recorder buttons are not, and
  // the asymmetry is about what is reachable rather than about what is worth asking.
  // `centre` and `sensor` have poses to land, so each is pressed and the pose compared
  // against the one its own control lands - a dock wired to the wrong element fails that
  // however faithfully it forwards. The recorder pair have no outcome this file can
  // reach without either writing a take into `captures/` or driving the server into a
  // refusal, and the note at the end of the section says what that costs.
  {
    const DOCK_IDS = ['menuShowSidebar', 'dockCentre', 'dockSensor', 'dockMark', 'dockRec'];
    const swept = DOCK_IDS.filter((id) => sweep.some((row) => row.id === id));
    check(swept.length === DOCK_IDS.length,
      'the collapse and its dock are inside the enumeration section 1 sweeps',
      `${swept.length} of ${DOCK_IDS.length}: ${swept.join(', ') || 'none'}`);

    // One reader for both pages. The recorder arm at the foot of the section asks the
    // same questions of the same ids, and a second copy of this evaluate is a second
    // thing to keep in step - which is how two arms of one comparison end up measuring
    // two different quantities and agreeing about it.
    const BAR_IDS = ['panelDock', 'dockCentre', 'dockSensor', 'dockRec', 'dockMark'];
    const GEOMETRY = `(() => {
      const box = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom),
                 w: Math.round(r.width), h: Math.round(r.height) };
      };
      // Whether a control is drawn, and separately what its own cascade says about it.
      // Those are two questions and this section needs both, because everything inside a
      // hidden bar is undrawn whatever its own rules say - so a row asking only the first
      // cannot tell a control the surface withholds from one the bar took away with it.
      // The take-pair row below is that distinction and nothing else.
      const isDrawn = (id) => {
        const el = document.getElementById(id);
        return Boolean(el) && el.checkVisibility({ checkVisibilityCSS: true });
      };
      const displayOf = (id) => {
        const el = document.getElementById(id);
        return el ? getComputedStyle(el).display : 'absent';
      };
      const ids = ${JSON.stringify(BAR_IDS)};
      const canvas = document.querySelector('canvas');
      const r = canvas.getBoundingClientRect();
      const panel = document.getElementById('panel');
      return {
        collapsed: document.body.classList.contains('panelcollapsed'),
        // aria-checked on the View menu's entry, and it reads the opposite way round to
        // the aria-pressed this used to ask for. The control moved off the app bar into
        // the menu in fb03887 and became a checkbox item saying whether the sidebar is
        // shown, where the button it replaced said whether the panel was shut - main.js
        // sets it as String(!collapsed). Reading the old id here threw on null and took
        // the rest of this file down with it, so the two states are named apart rather
        // than left to a reader to invert. No backticks anywhere in this evaluate: it is
        // a template literal and one would end the string early.
        shown: document.getElementById('menuShowSidebar').getAttribute('aria-checked'),
        drawn: Object.fromEntries(ids.map((id) => [id, isDrawn(id)])),
        display: Object.fromEntries(ids.map((id) => [id, displayOf(id)])),
        panel: box('panel'), dock: box('panelDock'), timeline: box('timeline'),
        // What a collapsed editor's panel is allowed to be and no more, read off the
        // panel rather than written down as a 1 - a border drawn a pixel wider would
        // otherwise fail a row about the inspector's tab rail for a reason that is
        // about the border.
        panelBorder: Math.round(parseFloat(getComputedStyle(panel).borderTopWidth) || 0),
        canvasBottom: Math.round(r.bottom), buffer: canvas.height,
      };
    })()`;
    const geometry = () => page.evaluate(GEOMETRY);

    const open = await geometry();
    check(open.collapsed === false && open.shown === 'true' && open.dock.h === 0,
      'the panel opens as the column it has always been, with no dock drawn',
      `panel ${open.panel.w}x${open.panel.h}, dock ${open.dock.h}px, aria-checked ${open.shown}`);

    // Through the menu it now lives in, which is two presses rather than one. Driven the
    // way section 1 drives every other entry in this popover rather than with a synthetic
    // click on a hidden item: a command inside a closed menu is one no operator can reach,
    // and pressing it anyway is the row passing for a reason that is not the feature.
    await page.locator('#viewMenuButton').click();
    await page.locator('#menuShowSidebar').click();
    await settle();
    const shut = await geometry();
    check(shut.collapsed === true && shut.shown === 'false',
      'the menu\'s entry shuts it, and the control says which way it is',
      `aria-checked ${shut.shown}, body reads ${shut.collapsed ? 'collapsed' : 'expanded'}`);

    // ---- what the editor collapses to, which is nothing ----
    //
    // `body.editing.panelcollapsed #panelDock { display: none }`, and the sentence
    // 2727dfb wrote above it: the dock is the panel's collapsed form, so an editor with
    // no panel has no dock either. This row is the whole of that rule, and it is an
    // absence - what stops it being satisfied by a build with no dock at all is the
    // recorder arm at the foot of the section, which asks these same ids and gets five
    // controls back.
    check(shut.display.panelDock === 'none',
      'the collapsed editor draws no dock at all, because the dock is the panel collapsed and this surface has no panel',
      `#panelDock computes to ${shut.display.panelDock}, box ${shut.dock.h}px`);

    // ---- the two that act on the take, withheld by a rule of their own ----
    //
    // **This row replaced three that passed by comparing nothing.** They read `#dockRec`
    // against `#recGo` - disabled, title, text, pressed - on the theory that a dock
    // painted from one place cannot drift from what it mirrors. Every one of them passed
    // on a build where the mirroring never executed: `paintRecord` is called by the
    // recorder's poll and `askRecordState` is assigned only on the live surface, so on
    // the editor both buttons sit at the values their markup gave them and the
    // comparison is `record` against `record`, `null` against `null`. A row that reads
    // two defaults and finds them equal is a row that would survive the paint being
    // deleted, which is the whole of what it claimed to be watching.
    //
    // **What replaced it then died the day the whole bar came off, and in the quiet
    // direction.** It asked whether the editor *draws* the pair. Everything inside a
    // hidden container is undrawn, so from 2727dfb the row was measuring the container
    // and reporting the pair, printing green over a question nothing was asking -
    // and `--mutate dock-offers-the-take-on-the-editor`, which deletes the rule that
    // withholds them, had nothing left it could move. A row that cannot fail, sitting
    // under a comment about rows that cannot fail.
    //
    // The rule is still there and still doing work of its own, and computed style is
    // where that work can be seen: `display` is not inherited, so an element inside a
    // `display: none` subtree still computes the value its own cascade gives it. The
    // take pair compute to `none` on this surface and the two view buttons do not, which
    // is exactly the difference between a control the editor withholds and a control the
    // bar took away with it. Both halves are asserted because both can move, measured
    // across three builds at 1512x900: this one reads none/none against
    // inline-block/inline-block, the mutation reads inline-block on all four, and a
    // build with `body.editing.panelcollapsed #panelDock` deleted reads none/none
    // against block/block - so neither half can answer for the other.
    const withheld = ['dockRec', 'dockMark'].every((id) => shut.display[id] === 'none');
    const kept = ['dockCentre', 'dockSensor'].every((id) => shut.display[id] !== 'none'
      && shut.display[id] !== 'absent');
    check(withheld && kept,
      'and the two that act on the take are withheld by a rule of their own rather than by the bar being gone',
      `record ${shut.display.dockRec} and mark ${shut.display.dockMark}, against `
      + `centre ${shut.display.dockCentre} and sensor ${shut.display.dockSensor}`);

    // ---- and the picture takes the height back ----
    //
    // The other half of 2727dfb, and the half a rule about `display` does not state.
    // `resize()` subtracts `#panelDock`'s `offsetHeight` from the height available to
    // the stage while the body is collapsed, which is what stops a frame being rendered
    // full height under a bar drawn over its last 72px - the bottom of the frame is
    // where a subject's feet are, and it is the occlusion the timeline's own comment
    // refuses for the same reason. A bar that is not drawn measures 0, so on this
    // surface the subtraction is a no-op and the picture runs the whole way down to the
    // strip. Asserted as the box rather than as that zero: a build that put the bar back
    // takes those pixels off the frame again, and this is the row that says so.
    check(shut.canvasBottom === shut.timeline.top,
      'and the picture runs down to the timeline strip, taking back the height a dock would have occupied',
      `canvas bottom ${shut.canvasBottom}, strip top ${shut.timeline.top}`);
    // The collapsed panel's own box, which is the cascade rather than the arithmetic.
    // The panel and the strip are both `position: fixed` at the foot of the window at
    // the same `z-index`, so the one that wins is the one written later, and
    // `body.editing.panelcollapsed #panel` is what lifts the panel clear of the strip.
    // Exact rather than "at most", because a panel that had gone entirely also sits
    // above the strip - the "passes by disappearing" reading this file refuses
    // everywhere else, and it would arrive here as a green row.
    check(shut.panel.bottom === shut.timeline.top,
      'the collapsed panel stops exactly where the timeline strip starts rather than over it',
      `panel bottom ${shut.panel.bottom}, strip top ${shut.timeline.top}`);
    // And there is nothing left inside it. Collapsed, `#panel` hides its head, its body,
    // its inspector tab rail and its dock, so what remains is the line along its top
    // edge - which is why this compares against the border rather than against a 1, and
    // why it is an equality: 31px is the tab rail surviving the collapse and 0px is the
    // panel itself having gone.
    check(shut.panel.h === shut.panelBorder,
      'with nothing left in the collapsed editor panel but the line along the top of it',
      `panel ${shut.panel.h}px against a ${shut.panelBorder}px border`);

    // The round trip, and the reason the collapse is a class rather than an inline
    // `display`. The version that shipped set `#panel.style.display` from the key
    // handler alone: nothing else could read which way it was, and on a touchscreen -
    // where there is no key to press a second time - it was a panel that did not come
    // back at all.
    await focusStage();
    await page.keyboard.press('h');
    await settle();
    const back = await geometry();
    check(back.collapsed === false && back.shown === 'true',
      'the H key drives the same state, and the entry it never touched agrees about it',
      `aria-checked ${back.shown}`);
    check(back.panel.w === open.panel.w && back.panel.h === open.panel.h
      && back.buffer === open.buffer,
      'and the panel and the buffer come back to exactly what they were',
      `panel ${back.panel.w}x${back.panel.h} buffer ${back.buffer}, `
      + `against ${open.panel.w}x${open.panel.h} and ${open.buffer}`);

    await page.keyboard.press('h');
    await settle();
    const shutAgain = await geometry();
    check(shutAgain.collapsed === true && shutAgain.shown === 'false',
      'and the key shuts it as well as opens it, so the two controls are one state',
      `aria-checked ${shutAgain.shown}`);

    // ---- the same collapse on the surface the dock was built for ----
    //
    // A second page rather than a navigation, because the editor page has to survive
    // into section 22 with its take open and its transport where the rows above left it.
    // A second *context* rather than a second page in this one, so nothing the recorder
    // writes to storage lands under the editor's origin halfway through a file that
    // spends section 15 reading exactly that.
    //
    // **The page carries the mutation's route of its own, and that is the part to get
    // right rather than the part that is bookkeeping.** `page.route` is installed per
    // page, so a recorder opened without it runs the tree's own build while the editor
    // beside it runs the mutated one - two arms of one comparison measuring two
    // programs, and a mutation of the markup silently reaching only half of the section
    // it was written for. `web/index.html` serves both surfaces, which is why the path
    // the document is placed at is what `serveMutation` takes its second argument for.
    // Delivery is verified rather than assumed, for the reason `openEditor` verifies it:
    // a route that was declared and never installed ran the tree's own source and came
    // back NOT CAUGHT with every row green. So a file this surface never asks for takes
    // the whole run to UNTESTED and exit 2 even when the editor arm caught the mutation -
    // honest while the two surfaces are one page in two modes, and the line to revisit on
    // the day a module reaches only one of them.
    //
    // `?panel=collapsed` rather than the menu, because it is a shipped path - the Pi's
    // kiosk unit opens the recorder exactly this way - and because the gesture that
    // collapses is already driven twice above, on the surface whose rows are about it.
    // What this arm is for is the bar, not the switch.
    const RECORDER_PATH = '/record';
    const recErrors = [];
    let recorder = null;
    let recWhy = '';
    try {
      const recContext = await page.context().browser().newContext({
        viewport: VIEWPORT, deviceScaleFactor: 1,
      });
      const recPage = await recContext.newPage();
      recPage.on('pageerror', (err) => recErrors.push(String(err)));
      recPage.on('console', (msg) => { if (msg.type() === 'error') recErrors.push(msg.text()); });
      await recPage.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
      const recMutant = await serveMutation(recPage, RECORDER_PATH);
      await recPage.goto(`${URL_BASE}${RECORDER_PATH}?panel=collapsed`, { waitUntil: 'load' });
      await recPage.waitForFunction('!!globalThis.__kinect', null, { timeout: 30000 });
      await recPage.evaluate('__kinect.timeline.settled()');
      if (MUTATE && recMutant.served() === 0) {
        throw new Error(`${MUTATE} was staged for ${mutation.file} at ${recMutant.path} and the `
          + "recorder page never requested it, so this arm ran the tree's own build");
      }
      recorder = { page: recPage, close: () => recContext.close() };
    } catch (err) {
      recWhy = err.message.split('\n')[0];
    }

    if (!recorder) {
      // Not a finding, and not a pass either. Every row in the arm below is about the
      // recorder, so a page that never opened leaves them untested rather than failed -
      // counting a harness failure as a finding is the mistake `monitor-check` made and
      // `docs/instruments.md` keeps, and reddening a row here would be exactly that
      // mistake. But the shape this branch shipped with was the other one: it printed a
      // note and let the file run on to `PASS`, so a build where `/record` cannot boot
      // reports a green baseline with six of section 21's rows silently absent, and the
      // only thing standing between a reader and that reading was an instruction to add
      // up the total by hand.
      //
      // `untested` is what this file already has for it and had never once been set -
      // exit 2, `docs/proof-tools.md`'s third code, "the harness did not run, or a claim
      // went unproven". The run finishes so the sections after this one still answer;
      // the verdict at the foot is what refuses.
      untested = 'the recorder arm never opened, so the six dock rows section 21 owns did not run'
        + ` - ${recWhy}`
        + (recErrors.length ? ` - the page said: ${recErrors.slice(0, 3).join(' | ')}` : '');
      note('the recorder arm did not run', recWhy
        + (recErrors.length ? ` - the page said: ${recErrors.slice(0, 3).join(' | ')}` : ''));
    } else {
      try {
        const rec = await recorder.page.evaluate(GEOMETRY);
        // The positive half of every absence above, and the reason those absences mean
        // anything. Five ids, one build, one collapse, and the surface is the only thing
        // that differs.
        check(BAR_IDS.every((id) => rec.drawn[id]),
          'the same collapse on the recorder draws the dock and all four of its buttons, so the editor\'s absences are a difference between the surfaces',
          `${BAR_IDS.map((id) => `${id} ${rec.drawn[id]}`).join(', ')}, `
          + `body reads ${rec.collapsed ? 'collapsed' : 'expanded'}`);
        // The subtraction `resize()` makes, asked on the only surface that still has
        // something to subtract. It reads as working without this row - the panel
        // collapses, the dock appears and every button answers - and only the geometry
        // says the frame is being drawn full height with its last 72px behind the
        // buttons. The recorder hides its timeline strip, so the dock's own top is what
        // the picture has to end at here.
        check(rec.canvasBottom === rec.dock.top,
          'and there the picture ends exactly where the dock begins, rather than continuing behind it',
          `canvas bottom ${rec.canvasBottom}, dock top ${rec.dock.top}`);

        // Pressable, and asked at the point a finger actually lands rather than inferred
        // from the boxes above. A dock underneath something else measures as exactly the
        // right size in exactly the right place while answering no thumb at all, and
        // `elementFromPoint` is the only reading that can tell those apart.
        //
        // It also keeps the rows below from discovering the same thing as a timeout.
        // They press with a real click, on purpose: `el.click()` fires the handler on a
        // button no operator could have reached, which is a row passing for a reason
        // that has nothing to do with the feature. So an occluded dock has to be a red
        // row here and a skip below, rather than a click that retries for thirty seconds
        // and takes the rest of the file down with it as a crash.
        const onTop = await recorder.page.evaluate(`(() => {
          const el = document.getElementById('dockCentre');
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { what: hit ? (hit.id || hit.className || hit.tagName) : null,
                   own: hit === el || el.contains(hit) };
        })()`);
        check(onTop.own,
          'and a press at the middle of a dock button reaches that button',
          `the point belongs to ${onTop.what}`);

        // ---- the dock presses the panel's own controls, read as the pose each lands ----
        const recSettle = () => recorder.page.evaluate('__kinect.timeline.settled()');
        const pose = `(() => { const c = __kinect.freeCamera;
          return [+c.position.x.toFixed(4), +c.position.y.toFixed(4), +c.position.z.toFixed(4)]; })()`;
        const flick = async () => {
          const stage = await recorder.page.evaluate(`(() => {
            const r = document.getElementById('stage').getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          })()`);
          await recorder.page.mouse.move(stage.x, stage.y);
          await recorder.page.mouse.down();
          await recorder.page.mouse.move(stage.x + 60, stage.y + 30);
          await recorder.page.mouse.up();
          await recSettle();
        };

        if (!onTop.own) {
          // Skipped rather than attempted, and said out loud. A `click()` on a covered
          // element retries for thirty seconds and then throws, which ends the file as a
          // crash - `monitor-check` counting its own timeout as a catch is the case
          // `docs/instruments.md` keeps for exactly this, and the row above has already
          // said the true thing about this build.
          note('the two pose comparisons did not run, nor the row that separates them',
            'nothing can press a dock that whatever is over it is taking the presses for - '
            + 'three rows short, and the row above carries what this build is');
        } else {
          // The two reference controls are pressed synthetically and the two dock
          // buttons are not, and the asymmetry is deliberate: `#menuCameraReset` is
          // inside a closed menu and `#camSensor` is inside the panel this arm has
          // collapsed, so neither is reachable by a hand right now. They are the
          // *reading* the dock is compared against rather than the thing under test,
          // and the thing under test is pressed the way an operator presses it.
          await recorder.page.evaluate("document.getElementById('menuCameraReset').click()");
          await recSettle();
          const centreByMenu = await recorder.page.evaluate(pose);
          await flick();
          await recorder.page.locator('#dockCentre').click();
          await recSettle();
          const centreByDock = await recorder.page.evaluate(pose);
          check(JSON.stringify(centreByDock) === JSON.stringify(centreByMenu),
            'the dock\'s centre lands the pose the View menu\'s own reset lands',
            `dock ${centreByDock.join(', ')} against menu ${centreByMenu.join(', ')}`);

          await recorder.page.evaluate("document.getElementById('camSensor').click()");
          await recSettle();
          const sensorByPanel = await recorder.page.evaluate(pose);
          check(JSON.stringify(sensorByPanel) !== JSON.stringify(centreByMenu),
            'and the sensor\'s pose is a different place from the centred one, so the row below can tell them apart',
            `sensor ${sensorByPanel.join(', ')} against centre ${centreByMenu.join(', ')}`);
          await recorder.page.evaluate("document.getElementById('menuCameraReset').click()");
          await recSettle();
          await recorder.page.locator('#dockSensor').click();
          await recSettle();
          const sensorByDock = await recorder.page.evaluate(pose);
          check(JSON.stringify(sensorByDock) === JSON.stringify(sensorByPanel),
            'and the dock\'s sensor lands the pose Framing\'s own sensor view lands',
            `dock ${sensorByDock.join(', ')} against panel ${sensorByPanel.join(', ')}`);
        }
      } finally {
        // Closed before the editor is put back, so the last gesture of this section goes
        // to the page section 22 inherits and nothing is left holding a socket on the
        // shooting server.
        await recorder.close().catch(() => {});
      }
    }

    note('what this section cannot catch',
      'what the take pair do once pressed. `record` and `mark` forward to `#recGo` and '
      + '`#recMark`, whose outcome is a take written into `captures/` or a refusal from '
      + 'the server, and neither is reachable from here without editing the library this '
      + 'file measures. What is enforced is where they are: the recorder draws them and '
      + 'the editor withholds them by a rule this section reads');

    // Left the way the sections after this one expect to find it.
    await focusStage();
    await page.keyboard.press('h');
    await settle();
  }


  console.log('\n[22] pinning the drive drops what the loop was going to serve');

  // The third state that strands an armed position, and the only one `pumpParkedDraft`
  // cannot notice on its own: `drive.pin` calls `setAnimationLoop(null)`, so that
  // function stops being called and no condition written inside it ever runs again.
  // Every tool in this suite waits on `settled()`, so a drag left armed across a pin
  // is not a slow orbit anywhere - it is a hang in all of them.
  //
  // **Last in the file, and that position is load-bearing rather than tidy.** Pinning
  // detaches the animation loop and the stream for good, and there is no hook that
  // puts them back - so every row after this one would run against a page with no
  // clock. It sat inside section 9 first, which was fine until a section was appended
  // after it: on the mutated build the stranded flags made the *next* section's
  // `settled()` throw, and the run ended as a crash with one assertion fired rather
  // than as a catch. `pin-keeps-orbit-armed` is the control.
  {
    const stage = await page.evaluate(`(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await page.evaluate('__kinect.timeline.transport().pause()');
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.down();
    await page.mouse.move(stage.x + 50, stage.y + 25);
    await page.mouse.up();
    // The smallest payload the pinned drive will accept: two frames, because
    // `StampedPairSource` refuses one - it interpolates between a pair, and a pair is
    // what it is named for. Each is a 16-byte header carrying its depth length, its
    // colour length and its stamp, then the two bytes of depth it claims. Nothing
    // renders from them; the loop is gone by the time they exist and this row asks
    // about the flags rather than the picture, so a run of real capture frames here
    // would only make the row slower to reach its answer.
    await page.evaluate(`__kinect.drive.pin((() => {
      const b = new ArrayBuffer(36);
      const v = new DataView(b);
      for (let k = 0; k < 2; k++) {
        const off = k * 18;
        v.setUint32(off, 2, true);
        v.setUint32(off + 4, 0, true);
        v.setBigUint64(off + 8, BigInt(k * 33), true);
      }
      return b;
    })())`);
    let settledAfterPin = true;
    let pinWhy = '';
    try {
      await settle();
    } catch (err) {
      settledAfterPin = false;
      pinWhy = err.message.split('\n')[0];
    }
    check(settledAfterPin,
      'a drag the pinned drive interrupts leaves nothing armed behind it either', pinWhy);
  }
} catch (err) {
  crashed = err;
} finally {
  await close().catch(() => {});
}

// --------------------------------------------------------------------- the verdict

if (crashed) {
  console.log(`\n[editor] DID NOT RUN - ${crashed.message}`);
  console.log(`[editor] ${checks} assertions ran, ${failures} failed before the crash`);
  if (fired.length) console.log(`[editor] rows that had already fired: ${fired.join('; ')}`);
  process.exit(2);
}
// Above the mutation verdict on purpose, and it prints what that verdict would have.
// A run missing rows is not a verdict on a mutation - the rows it is short of may be
// the rows that answer it, and "caught" claimed off the others is a catch recorded for
// a reason nobody checked. So it says neither caught nor missed. What it must not also
// do is swallow the reading `CLAUDE.md` asks for: count failed assertions, never exit
// codes, and read which ones fired. This branch was written printing only its reason,
// which is the one verdict path in this file a reader could not count, so it carries
// the same three lines the crash branch above carries.
if (untested) {
  console.log(`\n[editor] UNTESTED - ${untested}`);
  console.log(`[editor] ${checks} assertions ran, ${failures} failed`);
  if (fired.length) console.log(`[editor] rows that fired: ${fired.join('; ')}`);
  if (MUTATE) console.log(`[editor] ${MUTATE} is neither caught nor missed here - the run never reached every row that answers it`);
  process.exit(2);
}

console.log(`\n[editor] ${checks} assertions, ${failures} failed`);
if (NO_RENDER) console.log('[editor] --no-render: the real export and the saved copy were not driven');

if (MUTATE) {
  if (failures === 0) {
    console.log(`[editor] NOT CAUGHT - ${MUTATE} passed every assertion, so nothing here tests it`);
    process.exit(1);
  }
  console.log(`[editor] caught ${MUTATE}, as required (${failures} assertions fired)`);
  for (const label of fired) console.log(`           ${label}`);
  process.exit(1);
}
if (failures) { console.log('[editor] FAIL'); process.exit(1); }
console.log('[editor] PASS');
process.exit(0);
