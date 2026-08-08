// Proves the sensor view: that the button puts the free camera where the Kinect
// physically is, that the angles it opens come from the take's own intrinsics
// rather than from a constant, that the frame it fits is the sensor's frame on
// every shape the export menu offers, and that pressing it writes nothing.
//
// Four claims, separated because they fail for different reasons.
//
// **The obvious mutation is dark by construction, and that is what this tool is
// shaped around.** Every take in the library carries the same intrinsics - this
// rig's Kinect, fx = fy = 366.031494, cx 257.775909, cy 206.784195, and the tool
// reads all of them off the server and says so rather than taking that on trust. A
// build that hardcoded 60.157 degrees and a build that computes from `fy` therefore
// agree on every take anybody can open, so a mutation replacing the computation
// with a constant would pass while the feature was entirely broken. This is the
// failure `docs/instruments.md` describes at length under "what do my arms agree
// about": a set of probes that agree about a quantity cannot measure it however
// many of them there are. So the intrinsics claim is driven on three arms, two of
// which do not exist on disk - the hello is intercepted and answered with numbers
// of this tool's own.
//
// The third arm exists for the second half of that question. `fx` and `fy` are equal
// on every take *and* on the obvious synthetic arm, so a build reading `fx` where it
// means `fy` is invisible to both of them; arm C is deliberately anamorphic
// (fx 500, fy 300) so the two focal lengths have separate consequences, and
// `--mutate tanv-uses-fx` is the control that says so.
//
// **The fit is checked geometrically rather than by recomputing the formula.** A
// tool that re-derives `2 * atan(tanV)` and compares is a tool that agrees with the
// implementation by construction. So the fit rows take the `fov` and `aspect` the
// page reports, turn them back into the half-tangents the frustum actually opens
// to, and ask two things of them: that both are at least the sensor's - containment
// - and that exactly one of them equals it - tightness. Containment alone is a
// one-sided test that a 179 degree frustum passes. Tightness is what makes it a fit.
//
// **Four sections asserted against the camera object and none against the picture,
// and that gap shipped as a bug.** The pose rows below read `freeCamera.position`,
// which is set several lines before `sensorView` asks for an image - so deleting
// `requestRepaint()` from it left all 125 assertions green while the editor's picture
// did not move until the next pointer gesture happened to render it. That is the
// repo's own rule arriving as a defect: a tool named after a user-facing surface
// should have at least one arm pointed at that surface. Section 7 is that arm and
// `no-repaint` is its control.
//
// It took two attempts to make the comparison mean anything, and both misses are
// recorded rather than tidied away, because each was a probe that reported a picture
// moving when the picture had not moved at all. The chrome overlay redraws the path
// and the frustum from the new pose on the next animation frame, so a stage compared
// with it visible says CHANGED against a build that rendered nothing. And the panel
// is translucent over the picture's left edge, so a comparison clipped to the canvas
// contains the button's own hover state - which passed the pixel row under
// `no-repaint` on the highlight of the button being pressed. The region is therefore
// hit-tested with `elementFromPoint` and shrunk until every probe lands on the
// canvas, rather than computed from anybody's bounds.
//
// **Writing nothing is asserted against the stores, not against the page's word for
// it.** The click window is watched three ways at once: every non-GET request the
// page makes, the server's own monotonic write counters per store, and the bodies of
// the projects, presets, deliverables and marks stores before and after. The
// auto-save is fire-and-forget, so the read happens after the transport has settled
// and after a fixed grace - an absence recorded too early is the one result nobody
// re-checks. And the button is made to demonstrably act first: the camera is
// displaced to a pose that is not the sensor's, so "nothing was written" cannot be
// satisfied by a button that did nothing at all.
//
// That arm runs against a server this tool spawns, with every store and the captures
// directory in a temporary directory of its own. A planted write has to land
// somewhere it can be seen - `library-check` records a sweep made blind by three
// stores sitting outside the watched directory - and it must not land on the
// shooting server's documents. It did once: the first run of
// `--mutate sensor-view-keys-camera` auto-saved the mutated clip over a live
// `__working__` and there was no copy of what had been there.
//
//   node server/index.js --port 8080 &
//   node tools/sensor-view-check.mjs --url http://localhost:8080
//   node tools/sensor-view-check.mjs --mutate fov-hardcoded            # must FAIL
//   node tools/sensor-view-check.mjs --mutate tanv-uses-fx             # must FAIL
//   node tools/sensor-view-check.mjs --mutate sensor-view-keys-camera  # must FAIL
//   node tools/sensor-view-check.mjs --mutate keyframes-on-every-surface # must FAIL
//   node tools/sensor-view-check.mjs --mutate no-repaint               # must FAIL
//
// Exit 1 means a claim failed. Exit **2** means the harness did not run - a mutation
// whose anchor text has gone stale, a browser that never came up, or the record arm
// with no sensor hello to read - on the same reading as `library-check`'s low-space
// row and `registration-check`'s build failure: untested is not passed, and it is a
// different answer from a claim that failed.
//
// **The two surfaces are two panels, and that claim had no check anywhere.** Delete
// the `EDITING ?` gate on the keyframe loop in `web/main.js` and nothing in this repo
// goes red. `registry-check` opens `/record` but writes slider values through the
// DOM, which works perfectly on a `display: none` element - so it reads the same
// whether the grade is on screen or not, and it never looks at a `.kf`.
// `keyframe-check` runs on `/edit`, where the buttons are supposed to exist.
// `library-check` reads two ids. This is the only tool that opens both surfaces, so
// section 6 is here rather than anywhere else, and it asserts the difference as rules
// over every block in the panel rather than as a list of ids - with a closing rule
// that every block the other rules do not name has to be on both surfaces, so a group
// added later is asked about by existing.
//
// **What the mutations catch, measured rather than reasoned.** Every count in this
// paragraph belongs to one rig - the real corpus with a sensor attached - and it was
// taken **before section 7 existed**, so the same rig should now read eight rows more
// throughout. That is arithmetic rather than a measurement and the numbers are left at
// what was actually observed rather than quietly incremented; section 7's own counts,
// on a different rig, are in the paragraph below.
//
// Clean: 125
// assertions, 0 failed. `fov-hardcoded`: 42 fired, and the split across them is the
// argument for the synthetic arms rather than a rhetorical one. On arm A - the only
// intrinsics any take carries - it reddens the two 1:1 sizes and *nothing else*: ten
// of twelve shipped sizes stay green, 1920x1080 among them, because at any aspect
// wider than the sensor's 1.2075 the constant is the right answer. What sees it
// everywhere are the arms that do not exist on disk, and the row that says the three
// arms open three different angles reads 60.158 / 60.158 / 60.158 under it.
// `tanv-uses-fx`: 19 fired, every one on arm C or on the cross-arm row, with arms A
// and B bit-identical to the clean run because `fx === fy` on both.
// `sensor-view-keys-camera`: 7 fired, all in section 4, the project growing 1391 to
// 2583 bytes and a `PUT /projects/__working__` appearing in the request log.
// `keyframes-on-every-surface`: 2 fired, both of them recorder rows - 52 buttons in a
// panel that should hold none, at every state of the extended toggle - with the
// editor's own row green beside them, which is the asymmetry that makes the pair
// worth having rather than one row saying something broke. That count was 36 when the
// buttons were patched on by a loop of their own and is 52 now that the generator emits
// one per look parameter, which is the same claim over a registry seven parameters
// larger.
//
// **Re-measured on the `ui-rework` branch, and the rig is a different one, so these
// numbers sit beside the paragraph above rather than replacing it.** No Kinect: the
// server was `--grabber "<node> tools/fake-grabber.mjs --hd"`, whose hello carries real
// intrinsics, which is what this file actually gates the record arm on. macOS, an idle
// machine at load average 4-10, one run each. Clean: **132 assertions, 0 failed**.
//
// The mutations, and the reason to read them as a set rather than one at a time: this
// round rewrote section 6's block rules, and a rewrite that quietly stopped asserting
// would show up here as a count falling rather than as anything going red. Four of the
// five land on exactly the counts the paragraph above recorded from the sensor rig -
// `fov-hardcoded` **42**, `tanv-uses-fx` **19**, `sensor-view-keys-camera` **7**,
// `keyframes-on-every-surface` **2** - which is the evidence that sections 1 to 5 were
// left alone and that the pair of recorder keyframe rows is still a pair.
// `no-repaint`: **3**.
//
// The keyframes count is worth one more sentence, because it moved and came back. It
// read 7 for one round: section 6 had five rows failing on the clean build, so the
// mutated run fired those five as well and the arithmetic hid the two that mattered.
// Those five were the block rules describing a panel that `988551e` had restructured
// under them, dead since then behind an arm that could not build itself. They are fixed
// rather than recorded now, and 7 back to 2 is what says the fix was a repair rather
// than a row quietly dropped.
//
// A third mutation stood here, `extended-always-open`, with 3 rows fired against a
// recorder showing the grade before any press. Its number is left written down and its
// entry is not, because the recorder no longer hides the grade at all - the surface
// grew inspector tabs and the Look tab holds it. A measurement of a property the
// program has stopped having is history rather than a baseline, and the distinction is
// worth one paragraph here so the next reader does not go looking for the mutation.
//
// `no-repaint` was measured on a different rig from the numbers above and the method is
// worth stating rather than folding in: a depth-only synthetic take, one take in the
// library and no sensor attached, so row 0 fires on the single-take library and the
// recorder arm reads UNTESTED. On that rig the clean run is 126 assertions with 1 failed
// - the library row - and `no-repaint` is 4, the same row plus **three, all of them
// section 7's**: `renders 3 then 3`, the picture unchanged, and the image the press
// produced differing from a forced seek taken after it. The pose, angle and fit rows are
// green beside them, which is the whole argument for a seventh section rather than a
// tighter tolerance somewhere in the first six.
//
// **And the specificity was checked in the other direction, because a row that reddens
// on everything says nothing.** Under `fov-hardcoded` 43 rows fire and section 7 is
// entirely green; under `sensor-view-keys-camera` 8 fire, all of them in section 4, and
// section 7 is entirely green again. So these rows answer "did the press reach the
// screen" rather than "did something change".
//
// The instrument's own refusals were mutation-tested too, since a guard nobody has
// broken on purpose is a guard nobody knows the sensitivity of. Breaking the hello
// predicate gives `DID NOT RUN - arm B f=500 did not run: the hello was never
// intercepted`, exit 2 on 10 assertions and 0 failures; breaking the module glob
// gives `the mutated module was never served on /edit`, exit 2 on 1 assertion and 0
// failures; breaking the markup predicate gives `the mutated markup was never served
// on /edit`, likewise exit 2 on 1 assertion and 0 failures; a stale anchor and an
// unknown mutation name both exit 2 before a browser starts. None of the five can be
// read as a mutation caught.

import { readFileSync, mkdirSync, mkdtempSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const REPO = fileURLToPath(new URL('..', import.meta.url));
const URL_BASE = flag('--url', 'http://localhost:8080');
// The two surfaces, named once each. `registry-check` and `export-check` both
// record what happens when a path is spelled in two places: the editor moved from
// `/` to `/edit` when the main menu took the root, and a predicate that kept the
// old spelling loads the tree's own page while the header claims otherwise.
const EDITOR_PATH = '/edit';
const RECORDER_PATH = '/record';
const TAKE = flag('--take', 'sample');
const HEADED = argv.includes('--headed');
const MUTATE = flag('--mutate');
// How long to wait for the attached sensor's hello on the recorder arm before
// giving up and calling that arm untested. Bounded rather than open, because "the
// angles are the attached sensor's" cannot be proven against the boot defaults and
// a run that hung there would report neither answer.
const HELLO_MS = Number(flag('--hello-timeout', '25000'));
// The writes-nothing arm gets a server of its own on this port, with every store
// in a temporary directory. Two reasons, and the second is the one that made it
// worth the forty lines. A planted write has to land somewhere it can be seen, and
// `library-check` records what happens when it does not - a server spawned with no
// `--projects` and no `--presets` put three of five stores outside the directory
// being watched, which is the mechanical reason a planted route was invisible. And
// a planted write must not land on the shooting server's own documents:
// `--mutate sensor-view-keys-camera` auto-saves the whole clip over `__working__`,
// and the first run of this tool did exactly that to a live one.
const PRIVATE_PORT = Number(flag('--private-port', '8131'));
const CAPTURES_DIR = resolve(flag('--captures', join(REPO, 'captures')));

// The depth grid the unprojection runs over, which is the frame the fit has to
// contain. Written here rather than read out of the page for the same reason the
// predictions below are: a tool that takes its expectations from the build cannot
// disagree with it.
const DW = 512;
const DH = 424;

// The boot defaults in `web/main.js`'s uniform block - what a page that fetched
// nothing would be unprojecting on. The recorder arm needs them, because "the
// intrinsics arrived" is only evidence if the numbers that did not arrive are
// different numbers.
const BOOT_DEFAULTS = { fx: 366, fy: 366, cx: 256, cy: 212 };

// Floating point dust rather than a threshold with a story. `controls.update()`
// recomputes the camera position from a spherical offset around the target, so the
// origin comes back as 1.35e-16 rather than as 0, and the degree-to-radian round
// trip through `freeCamera.fov` costs about the same. Everything asserted here is
// an identity in exact arithmetic, so the tolerance only has to clear the last few
// bits of a double.
const DUST = 1e-9;

// The one place the dust is not dust, measured rather than assumed. `controls`
// runs with `enableDamping` and a factor of 0.07, so an update taken while
// auto-orbit is running leaves 93% of that step's rotation sitting in
// `sphericalDelta`, and the next update - the one inside `sensorView` - spends part
// of it rotating the camera around the target it was just given. Pressing the
// button with the orbit running therefore lands near the origin rather than on it:
// 7.00e-4 m on this rig, from three updates at an auto-rotate speed of 0.6, against
// 1.35e-16 m on the idle arm the row beside it drives. Identical to the printed digit
// on two clean rounds, which is what a fixed rotation step through a fixed damping
// factor should give - no wall clock reaches this path, so the residual is arithmetic
// rather than a sample. That is
// a property of the control rather than of the button, so it gets a row and a bound
// of its own instead of being hidden inside the pose tolerance. The bound is a
// centimetre because that is smaller than the sensor's own body - a camera inside
// the Kinect's shell is at the Kinect - rather than a number fitted to one run.
const ORBIT_RESIDUAL = 0.01;

// ------------------------------------------------------------------- the arms
//
// Arm A is the take as it sits on disk. Arms B and C do not exist on disk and that
// is their entire purpose: every take carries one set of intrinsics, so the shipped
// arm cannot distinguish a build that reads them from a build that ignores them.
//
// B moves the magnitude and holds the ratio, which is the arm that catches a
// hardcoded angle. C moves the ratio as well - deliberately anamorphic, which no
// real Kinect is - which is the arm that catches `fx` used where `fy` was meant.
// Neither is a plausible camera and neither needs to be: the claim under test is
// that the angles are read from the hello, and a synthetic hello reads back exactly
// as clearly as a real one.
const ARMS = [
  { name: 'A take', intrinsics: null },
  { name: 'B f=500', intrinsics: { fx: 500, fy: 500 } },
  { name: 'C 500/300', intrinsics: { fx: 500, fy: 300 } },
];

// ------------------------------------------------------------------- mutations

const MUTATIONS = {
  // The angles stop coming from the take. The constant is the correct answer for
  // this rig at any stage the vertical binds on, which is what makes it the right
  // mutation: on the four of five shipped aspects wider than the sensor's 1.2075 it
  // is invisible to every geometric row in this file, and only the arms that were
  // never on disk can see it.
  'fov-hardcoded': {
    file: 'web/main.js',
    edits: [[
      '  const fovV = binding === \'vertical\' ? 2 * Math.atan(tanV) : 2 * Math.atan(tanH / aspect);',
      '  const fovV = THREE.MathUtils.degToRad(60.15756974606831);',
    ]],
  },
  // The vertical half-angle reads the horizontal focal length. Bit-identical on every
  // take in the library and on arm B, because `fx === fy` on all of them, so this is
  // the control that says arm C is load-bearing rather than a third way of spelling
  // the same measurement.
  'tanv-uses-fx': {
    file: 'web/main.js',
    edits: [[
      '  const tanV = (DEPTH_H / 2) / fy;',
      '  const tanV = (DEPTH_H / 2) / fx;',
    ]],
  },
  // Navigation that leaves a trace. Modelled on the `key here` handler beside it
  // rather than invented, because the bug this guards against is precisely the two
  // buttons being written to look alike.
  // The keyframe controls stop being the editor's. `toggleKey` would still build a
  // track and `playheadSec()` would still answer 0, so a click while shooting writes
  // a key at t=0 on a document that does not exist - and nothing on the recorder
  // draws a lane, so nothing shows it. The asymmetry is the whole point of the
  // control: it must redden the recorder rows and leave the editor's alone, because
  // a mutation that reddens both cannot say which surface broke.
  // Re-anchored when the panel became generated, and the refusal is what surfaced it:
  // the gate used to sit on a second loop that patched keyframe buttons onto rows the
  // markup already held, and that loop is gone because the row and its button are now
  // built in one pass. The mutation is the same mutation - the surface stops deciding
  // whether a look parameter gets a keyframe control - but the text it names moved, and
  // an anchor matching 0 times exits 2 rather than passing quietly.
  'keyframes-on-every-surface': {
    file: 'web/main.js',
    edits: [[
      '      const keyButton = EDITING ? makeKeyButton(name) : null;',
      '      const keyButton = makeKeyButton(name);',
    ]],
  },
  // `extended-always-open` was here, and it is gone with the claim it falsified rather
  // than repointed at something nearby. It flipped `body:not(.editing) .lookgroup` from
  // `none` to `block` to prove this file could tell a recorder hiding the grade from one
  // showing it - and the recorder does not hide the grade any more. The record surface
  // grew inspector tabs and reaches every look parameter through the Look tab, so both
  // the rule and the `#extendedRow` button that used to reveal it are out of the markup.
  //
  // A control whose claim has been retired is worse than no control: it reads as coverage
  // of a property nothing has, and the honest failure mode is the one that happened -
  // `syntax-check` went red because the anchor matched nothing, which is that tool asking
  // this question on this file's behalf.
  // The button stops asking for an image. Everything above it in `sensorView` still
  // runs, so the camera lands on the sensor exactly as before and every pose, angle
  // and fit row in this file stays green - which is the entire reason this mutation
  // exists. It was measured: with `requestRepaint()` deleted the suite passed 125 of
  // 125 while the editor's picture did not move until the next pointer gesture
  // rendered it, which is the bug as reported.
  //
  // The anchor is the `controls.update()` / `requestRepaint()` pair rather than the
  // click handler, because `sensor-view-keys-camera` already anchors on the handler
  // and two mutations sharing one piece of source text both go stale together.
  'no-repaint': {
    file: 'web/main.js',
    edits: [[
      '  controls.update();\n  requestRepaint();',
      '  controls.update();',
    ]],
  },
  'sensor-view-keys-camera': {
    file: 'web/main.js',
    edits: [[
      'ui.camSensor.addEventListener(\'click\', () => { sensorView(); });',
      `ui.camSensor.addEventListener('click', () => {
  sensorView();
  if (!timeline) return;
  const track = trackFor('camera');
  freeCamera.updateMatrixWorld(true);
  track.setKey(playheadSec(), {
    position: freeCamera.position.toArray(),
    quaternion: freeCamera.quaternion.toArray(),
    fov: freeCamera.fov,
  }, keyTolerance());
  lanesChanged();
  requestRepaint();
  history.commit();
});`,
    ]],
  },
};

/**
 * The mutated source of whichever file the named mutation edits.
 *
 * The exactly-once refusal is the point of the function, and it is the only warning
 * anybody gets that an anchor has gone stale: a mutation is a piece of source text,
 * so it stops matching the moment the code it names is edited, and a replacement
 * that silently matched nothing would run the unmutated build and be recorded as
 * this tool having missed a bug it was never shown.
 */
function mutatedSource(name) {
  const spec = MUTATIONS[name];
  if (!spec) {
    throw new Error(`unknown mutation ${name} - have ${Object.keys(MUTATIONS).join(', ')}`);
  }
  let source = readFileSync(join(REPO, spec.file), 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`mutation ${name} matched ${hits} times in ${spec.file}, expected exactly 1: ${from}`);
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
// The labels rather than only the count. A mutation run that says "3 assertions
// fired" cannot be checked for having been caught *for the reason claimed*, which
// is the distinction `docs/instruments.md` spends a paragraph on - a control that
// goes red for a neighbouring reason looks exactly like a control that works.
const fired = [];
const check = (ok, label, detail = '') => {
  checks++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
  if (!ok) { failures++; fired.push(label); }
};
const note = (label, detail = '') => console.log(`  ....  ${label}${detail ? `   ${detail}` : ''}`);
const fixed = (x, n = 4) => (Number.isFinite(x) ? x.toFixed(n) : String(x));
const DEG = 180 / Math.PI;

// A throw is the harness not running rather than a finding in either direction.
// `monitor-check` counted its own timeout in `failed` and printed "caught, as
// required (1 assertion fired)" having tested nothing about the thing under test;
// this is that fix, applied before the tool has a chance to earn the mistake.
let crashed = null;
let untested = null;

// ------------------------------------------------------------------- the library
//
// Read by the tool from the server's own routes, so every expectation below is a
// second reader's rather than the page confirming its own arithmetic.

// Wrapped, because a server that is not there is the harness not running and an
// unhandled `ECONNREFUSED` exits 1 - which is the code reserved for a claim having
// failed. It happened during this tool's own bring-up: the shooting server was
// restarted by another session mid-suite and two mutation runs ended in a Node stack
// trace that a gate reading exit codes would have recorded as mutations caught.
let takes;
try {
  takes = (await (await fetch(`${URL_BASE}/library/takes`)).json()).takes;
} catch (err) {
  console.log(`[sensor-view] DID NOT RUN - no server at ${URL_BASE} (${err.message})`);
  process.exit(2);
}
const onDisk = takes.find((t) => t.id === TAKE);
if (!onDisk) {
  console.log(`[sensor-view] DID NOT RUN - no take ${TAKE} in the library (have ${takes.map((t) => t.id).join(', ')})`);
  process.exit(2);
}
let hello;
try {
  hello = await (await fetch(`${URL_BASE}/capture/${encodeURIComponent(TAKE)}/hello`)).json();
} catch (err) {
  console.log(`[sensor-view] DID NOT RUN - the take's hello could not be read (${err.message})`);
  process.exit(2);
}

/**
 * The half-tangents the sensor's own frame subtends, and where the fit has to bind.
 *
 * Everything downstream is expressed against these two numbers rather than against
 * an angle, because a tangent is what a frustum is actually made of and comparing
 * ratios of tangents makes "contains" and "touches" one arithmetic instead of two.
 */
const frame = (fx, fy) => ({ tanH: (DW / 2) / fx, tanV: (DH / 2) / fy });

// ------------------------------------------------------------------- in-page
//
// Installed once per page. Nothing here computes an expectation - every number this
// returns is read straight off the page and judged in Node, so a helper cannot
// quietly agree with the build it is running inside.
const PROBE = `(() => {
  const k = globalThis.__kinect;
  globalThis.__sv = {
    surface: () => k.surface(),
    sizes: () => k.exportSizes().map((s) => ({ ratio: s.ratio, size: s.w + 'x' + s.h })),

    /**
     * Where the camera actually is and which way it actually points, taken off the
     * object rather than off what \`sensorView\` said it did. A return value that
     * described a pose the camera never adopted is exactly the shape of instrument
     * this repo has been burned by.
     */
    pose() {
      k.freeCamera.updateMatrixWorld(true);
      const dir = k.freeCamera.position.clone();
      k.freeCamera.getWorldDirection(dir);
      return {
        position: k.freeCamera.position.toArray(),
        target: k.controls.target.toArray(),
        direction: dir.toArray(),
        fov: k.freeCamera.fov,
        aspect: k.freeCamera.aspect,
        spin: k.params.get('spin'),
      };
    },

    // Somewhere that is not the sensor's, so a button that did nothing cannot be
    // recorded as a button that wrote nothing. The pose is deliberately off every
    // axis and the fov deliberately far from any angle the sensor subtends.
    //
    // \`spin\` decides whether OrbitControls is left holding damping momentum, which
    // is the difference between the two arms of the pose claim: an idle control has
    // an empty \`sphericalDelta\` and the sensor's position comes back exact, while
    // one that has been auto-rotating spends its residual inside \`sensorView\`'s own
    // \`controls.update()\`. Driving both is what keeps the tight row tight instead of
    // widening it to swallow an effect that belongs to a different object.
    displace({ spin = false, updates = 1 } = {}) {
      k.params.set('spin', spin);
      k.freeCamera.position.set(1.7, 0.9, 2.4);
      k.freeCamera.fov = 21;
      k.freeCamera.updateProjectionMatrix();
      k.controls.target.set(0.5, -0.3, 0.8);
      for (let i = 0; i < updates; i++) k.controls.update();
      return this.pose();
    },

    // One stage shape at a time, applied and then read. \`setTargetSize\` resizes
    // synchronously, so the camera's aspect is already the new one when
    // \`sensorView\` reads it and there is nothing to wait for.
    at(size) {
      k.setTargetSize(size);
      const returned = k.sensorView();
      return { returned, pose: this.pose() };
    },

    // The document, the stack and the lanes, as one object. Stringified here so a
    // comparison in Node is of bytes rather than of two structurally-equal objects
    // that a deep compare might disagree about for its own reasons.
    document() {
      return {
        project: JSON.stringify(k.keyframes.project()),
        depth: k.keyframes.undo.depth(),
        cameraKeys: k.keyframes.camera.keys().length,
        trackNames: k.keyframes.names().join(','),
        lanes: JSON.stringify(k.keyframes.lanes()),
      };
    },

    settled: () => k.timeline.settled(),

    /**
     * The overlay off, and answered rather than assumed.
     *
     * \`drawChrome\` paints the camera path, its nodes and the program camera's frustum
     * onto a second canvas sitting exactly over the picture, and it repaints them from
     * the new pose on the next animation frame whether or not the picture itself moved.
     * So a stage compared with it visible reports a change against a build that
     * rendered nothing at all - measured, not feared: the first version of section 7
     * said CHANGED against \`no-repaint\` for precisely this reason.
     */
    hideChrome() {
      k.keyframes.chrome.set(false);
      return document.getElementById('chrome')?.hidden === true;
    },

    /**
     * The largest part of the picture that nothing is drawn over, and the count that
     * proves nothing is.
     *
     * The canvas's own rectangle is not it. The panel is translucent and sits on top
     * of the picture's left edge, so a screenshot clipped to the canvas contains the
     * button being pressed - and \`no-repaint\` passed the pixel row on that button's
     * own hover state while the picture behind it had not moved at all. This is the
     * second time the same class caught this section: the first was the chrome
     * overlay, which \`hideChrome\` deals with.
     *
     * So the rect is taken to the right of the panel and then hit-tested on a grid,
     * because a rect computed from one element's bounds is a claim about that element
     * rather than about what happens to be over it. \`covered\` is what the arm asserts.
     */
    picture() {
      const canvas = k.renderer.domElement;
      const r = canvas.getBoundingClientRect();
      // The grid, and it is the definition rather than a check on one: a rect worked
      // out from another element's bounds is a claim about that element, and the two
      // things that have already fooled this section - the chrome overlay and the
      // panel - were both found by a picture that moved rather than by geometry.
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
      // Shrunk toward the middle until every probe lands on the canvas, so whatever
      // the furniture is and wherever it moves to, the region compared is picture.
      let rect = {
        x: Math.ceil(r.x) + 1, y: Math.ceil(r.y) + 1,
        width: Math.floor(r.width) - 2, height: Math.floor(r.height) - 2,
      };
      let hits = clean(rect);
      for (let step = 0; step < 40 && hits.covered > 0 && rect.width > 64 && rect.height > 64; step++) {
        const dx = Math.max(2, Math.round(rect.width * 0.05));
        const dy = Math.max(2, Math.round(rect.height * 0.05));
        rect = { x: rect.x + dx, y: rect.y + dy, width: rect.width - 2 * dx, height: rect.height - 2 * dy };
        hits = clean(rect);
      }
      return { ...rect, covered: hits.covered, over: hits.over };
    },

    renders: () => k.timeline.counters.renders,

    /**
     * Spends whatever damping momentum the controls are holding, and says how many
     * updates it took.
     *
     * OrbitControls runs with \`enableDamping\`, so a gesture leaves a residual in
     * \`sphericalDelta\` that every later \`controls.update()\` spends 7% of - and
     * \`advanceNavigation\` calls one inside every render. Two renders of one position
     * therefore disagree while any is left, which would leave the rows below unable to
     * tell a picture that moved because the button worked from one that moved because
     * the camera was still coasting. The control row proves the drain worked.
     */
    drain() {
      let last = k.freeCamera.position.clone();
      for (let i = 0; i < 500; i++) {
        k.controls.update();
        if (k.freeCamera.position.distanceTo(last) < 1e-12) return i;
        last = k.freeCamera.position.clone();
      }
      return -1;
    },

    /**
     * One render through the transport - the door the orbit's own \`end\` handler uses,
     * which consults none of the four flags \`requestRepaint\` consults.
     */
    async forceSeek() {
      const t = k.timeline.transport();
      await t.seek(t.programSec);
      await k.timeline.settled();
    },

    /**
     * The panel as the browser lays it out, rather than as the markup declares it.
     *
     * Visibility is \`checkVisibility\`, not the \`hidden\` attribute and not a
     * \`display\` string read off the element itself. Both of those answer about one
     * node: \`#cameraGroup\` carries \`hidden\` in the markup and has it removed by
     * \`openTake\`, while every other difference between the surfaces is a CSS rule on
     * an ancestor class, so an attribute check and a self-only style check each see
     * half the mechanism. That both halves exist is exactly why this section does.
     */
    panel() {
      const vis = (el) => !!el && el.checkVisibility({ checkVisibilityCSS: true });
      // The child combinator is doing real work and has to stay: a \`.btnrow\` also
      // lives inside half the groups, and a descendant selector would list those as
      // blocks of the panel. So when the scrolling column became \`#panelBody\` under a
      // head that does not scroll, this had to follow it - and \`.surfacenav\` is named
      // beside them because the nav moved into that head. Dropping it from the list
      // would have taken it out of the closing row below, which is what asserts every
      // block nothing else names is on both surfaces: the nav would have stopped being
      // covered here by disappearing rather than by failing.
      const blocks = [...document.querySelectorAll(
        '#panelBody > .group, #panelBody > .btnrow, #panelHead .surfacenav',
      )].map((el) => ({
        // The id where there is one, the group's own heading where there is not.
        // A heading that gets reworded fails the naming row loudly, which is the
        // right answer: this file was written the week the panel was regrouped.
        key: el.id || \`label:\${el.querySelector('label')?.textContent.trim() ?? '(unlabelled)'}\`,
        visible: vis(el),
        display: getComputedStyle(el).display,
        look: el.classList.contains('lookgroup'),
        // **The block's own controls, because a block is visible for a different reason
        // than its controls are.** Collapse puts \`shut\` on the group and the rule under
        // it hides the *rows*, so the node goes on passing \`checkVisibility\` with
        // nothing gradeable underneath it - which is what let "all 9 visible" mean "all
        // 9 have a heading" for a while. Counted off \`input, select\` rather than off
        // the row classes so this holds no second copy of a class list that could drift
        // from the generator's.
        controls: el.querySelectorAll('input, select').length,
        controlsOnScreen: [...el.querySelectorAll('input, select')].filter(vis).length,
        // Whether the collapse rule governs this one at all, so a group with no rows on
        // screen can be told from a group that has been shut.
        collapsible: !!el.querySelector(':scope > .grouphead > .grouptoggle'),
        // And whether it has been. Read off the class the panel sets rather than inferred
        // from the count, which is what lets the rows below partition the look groups and
        // then assert about the controls in each half - a build lying about this fails
        // both halves at once, since a group claiming to be open has to show its controls
        // and a group claiming to be shut has to show none.
        shut: el.classList.contains('shut'),
      }));
      const look = k.params.names('look');
      // A keyframe control belongs to a parameter when it shares a row with that
      // parameter's control. Counting buttons on their own would pass a build that
      // put three of them on one row and none on two others.
      const keyed = look.filter((name) => {
        const el = document.getElementById(name);
        if (!el) return false;
        const row = el.type === 'checkbox' ? el.parentElement?.parentElement : el.parentElement;
        return !!row?.querySelector(':scope > .kf');
      });
      return {
        blocks,
        surface: k.surface(),
        activeTab: document.querySelector('#panelTabs .paneltab[aria-selected="true"]')?.dataset.panelTab ?? null,
        kfButtons: document.querySelectorAll('#panel .kf').length,
        lookNames: look.length,
        keyed: keyed.length,
        // Named rather than counted: the registry throws at boot when one is
        // missing, so a count that disagreed would need to say which.
        missingControl: look.filter((name) => !document.getElementById(name)),
        recRange: vis(document.getElementById('recRange')),
        supported: typeof document.body.checkVisibility === 'function',
      };
    },

  };
})()`;

// --------------------------------------------------------------------- the pages

const { chromium } = await loadPlaywright();
let mutation = null;
try {
  mutation = MUTATE ? mutatedSource(MUTATE) : null;
} catch (err) {
  // An anchor that no longer matches is the harness not running. Exit 2 rather than
  // 1, because a stale mutation exiting 1 reads identically to a mutation caught.
  console.log(`[sensor-view] DID NOT RUN - ${err.message}`);
  process.exit(2);
}
if (MUTATE) console.log(`[sensor-view] MUTATED BUILD: ${MUTATE} in ${mutation.file} - this run is expected to FAIL`);
// The two files are served separately rather than as a pair, and that is the right
// call here rather than a shortcut. `registry-check` and `export-check` pair them
// because their other arm is an *older* module against today's panel, which throws
// at boot on the first parameter this tree has renamed. Every mutation here is this
// tree's own source with one line moved, so the file that was not touched is already
// the one the touched file expects.
const mutatedJs = mutation?.file === 'web/main.js' ? mutation.body : null;
const mutatedHtml = mutation?.file === 'web/index.html' ? mutation.body : null;

const pageErrors = [];

/**
 * A page on one surface, with the hello answered by this tool when an arm asks for
 * one and its interception proved rather than assumed.
 *
 * One browser per page rather than one browser with several pages: two live WebGL2
 * contexts here reliably take the renderer process down, and that arrives as
 * `Execution context was destroyed`, which is the shape of a run that exits
 * non-zero having tested nothing.
 *
 * Only `main.js` is served under `--mutate` and no markup goes with it. The
 * cross-build pairing `registry-check` and `export-check` need is for an *older*
 * module against today's panel; every mutation here is this tree's own source with
 * one line moved, so the markup it expects is the markup the server has.
 */
async function openPage({ path = EDITOR_PATH, take = TAKE, intrinsics = null, base = PRIVATE_BASE } = {}) {
  // Local Network Access is off for this tool, and the reason is an artifact of how a
  // markup mutation has to be delivered rather than anything about the build. Serving
  // the document through `route.fulfill` puts the page in a security context Chromium
  // treats as external, so its WebSocket back to localhost is refused with
  // `ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS` - the recorder then never sees a
  // sensor hello and the run ends UNTESTED while the rows the mutation targets have
  // already gone correctly red. Measured on `extended-always-open`, a mutation this file
  // no longer carries: it failed its three intended rows and still reported DID NOT RUN,
  // twice. The measurement outlives the mutation because it is about how a markup
  // mutation reaches the page rather than about which one, and every remaining markup
  // mutation arrives the same way. The flag is passed on every launch rather than only
  // the mutated ones, because two browsers configured differently is two things being
  // measured.
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: !HEADED,
    args: ['--disable-features=LocalNetworkAccessChecks'],
  });
  const context = await browser.newContext({ viewport: { width: 1100, height: 760 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  const wrote = [];
  page.on('pageerror', (err) => { errors.push(String(err)); pageErrors.push(String(err)); });
  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    errors.push(msg.text());
    pageErrors.push(msg.text());
  });
  // Every request that is not a read, kept with its method. This is the page's half
  // of the writes-nothing claim; the server's counters are the other half, and
  // neither is trusted on its own.
  page.on('request', (req) => {
    if (req.method() === 'GET' || req.method() === 'HEAD') return;
    wrote.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });

  // The tab icon, answered rather than left to 404. A console error names no URL,
  // so a missing favicon and a missing module read identically in `errors`.
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

  // The mutated build, and its interception is proved below for exactly the reason
  // the first run of this tool needed it to be: the route was declared and never
  // installed, so `fov-hardcoded` ran against the tree's own source and came back
  // NOT CAUGHT with 104 green rows - a mutation that did nothing, reported as a
  // check that found nothing.
  let servedModule = false;
  if (mutatedJs) {
    await page.route('**/main.js', (route) => {
      servedModule = true;
      route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: mutatedJs });
    });
  }
  // The markup, for the one mutation that lives in a stylesheet rather than in the
  // module. The predicate reads the same `path` the `goto` below does, because both
  // surfaces are served from `web/index.html` and a predicate naming one of them
  // would leave the other quietly running the tree's own page.
  let servedHtml = false;
  if (mutatedHtml) {
    await page.route((url) => url.pathname === path, (route) => {
      servedHtml = true;
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: mutatedHtml });
    });
  }

  let servedHello = false;
  if (intrinsics) {
    // The take's own hello with two numbers replaced, rather than a hello invented
    // whole. `openTake` refuses a centre outside the depth frame and a non-positive
    // focal, and it uses the range to paint the preview - so carrying the real
    // record forward means this arm differs from arm A in exactly the two fields
    // the claim is about and in nothing else.
    const body = { ...hello, ...intrinsics };
    await page.route(
      (url) => /^\/capture\/[^/]+\/hello$/.test(url.pathname),
      (route) => {
        servedHello = true;
        route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      },
    );
  }

  const query = path === EDITOR_PATH ? `?take=${encodeURIComponent(take)}` : '';
  await page.goto(`${base}${path}${query}`, { waitUntil: 'load' });
  // Both waits carry whatever the page said while they were waiting. A bare
  // `waitForFunction` timeout names nothing at all - it reports the condition that
  // did not arrive rather than the reason, which is how a boot throw reads as a
  // missing feature and how a wrong URL reads as a slow page. This tool has already
  // spent two runs on that.
  const waitFor = async (expr, what, timeout) => {
    try {
      await page.waitForFunction(expr, null, { timeout });
    } catch (err) {
      throw new Error(`${what} on ${base}${path}: ${err.message.split('\n')[0]}`
        + (errors.length ? ` - the page said: ${errors.slice(0, 3).join(' | ')}` : ' - the page reported nothing'));
    }
  };
  await waitFor('!!globalThis.__kinect', 'the module never finished booting', 30000);
  if (path === EDITOR_PATH) {
    await waitFor('!!globalThis.__kinect.timeline.transport()', 'the take never opened', 30000);
  }
  // The interception, enforced rather than stated. A predicate that stops matching
  // leaves the arm on the take's own intrinsics, which is arm A wearing arm B's
  // label - two columns of identical numbers under a heading that says they came
  // from different cameras, which is precisely the failure `determinism-check
  // --clock` shipped with.
  if (intrinsics && !servedHello) {
    throw new Error('the hello was never intercepted - this arm ran on the take\'s own intrinsics');
  }
  if (mutatedJs && !servedModule) {
    throw new Error(`the mutated module was never served on ${path} - this page ran the tree's own build`);
  }
  if (mutatedHtml && !servedHtml) {
    throw new Error(`the mutated markup was never served on ${path} - this page ran the tree's own panel`);
  }
  await page.evaluate(PROBE);
  return { page, errors, wrote, close: () => browser.close() };
}

/**
 * Runs a block on a page of its own, retrying a destroyed execution context.
 *
 * That failure is Playwright and the GPU process rather than anything under test,
 * and it has cost this repo two runs that exited non-zero having tested nothing. It
 * is retried rather than absorbed, and the retry count is printed. Anything that is
 * not that error propagates on the first attempt, because a check that retried real
 * failures would report whichever attempt it liked.
 *
 * **No assertion fires inside the block.** The work returns values and the rows are
 * judged after it returns: an attempt that died having already failed three rows and
 * then succeeded would otherwise leave those three in the totals, and under
 * `--mutate` an inflated failure count reads as the mutation having been caught.
 */
async function onFreshPage(what, open, work, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    let held = null;
    try {
      held = await openPage(open);
      const value = await work(held);
      if (attempt > 1) note(`${what} needed ${attempt} attempts`, 'the browser dropped its execution context');
      return { ok: true, value, errors: held.errors, wrote: held.wrote };
    } catch (err) {
      const message = String(err.message ?? err);
      if (!/Execution context was destroyed|Target (page|closed)|crashed/i.test(message) || attempt >= attempts) {
        return { ok: false, error: `${message}${attempt > 1 ? ` (${attempt} attempts)` : ''}` };
      }
    } finally {
      await held?.close().catch(() => {});
    }
  }
}

// The editor now keeps sensor navigation behind its Framing inspector tab, while
// the recorder uses the same control without tabs. Drive the visible surface first
// and then press the real button in both cases; a direct `sensorView()` call would
// skip the click-handler mutations this tool is responsible for catching.
async function clickSensorView(page) {
  const framingTab = page.locator('#panelTabFraming');
  if (await framingTab.isVisible()) await framingTab.click();
  await page.click('#camSensor');
}

// ------------------------------------------------------------------- the stores
//
// The resource rather than the bookkeeping that claims to track it, on both sides.
// `/library/writes` is a monotonic count per store - it catches a write to a store
// this tool did not think to name - and the bodies catch a write that put back what
// it found. Neither alone is enough: a counter cannot say what changed and a body
// comparison cannot see a write that was undone inside one request.
async function stores(base) {
  const get = async (path) => JSON.stringify(await (await fetch(`${base}${path}`)).json());
  return {
    writes: await get('/library/writes'),
    projects: await get('/projects'),
    presets: await get('/presets'),
    deliverables: await get('/deliverables'),
    marks: await get(`/capture/${encodeURIComponent(TAKE)}/marks/log`),
  };
}

// ------------------------------------------------------- the private server
//
// Every document store in a temporary directory and the take reached by symlink, so
// a write the button provokes lands somewhere this tool owns. The captures directory
// is private too rather than shared: a mark is written as a sidecar beside the take,
// and "the shooting server's own files" is exactly the object a deliberate exclusion
// would leave unwatched.
//
// **Every editor arm runs here, not only the writes-nothing one, and that took two
// runs to get right.** Isolating the arm that watches the stores looked sufficient
// and was not: the pose arm clicks the same button on a page of its own, so under
// `--mutate sensor-view-keys-camera` it auto-saved the mutated clip over the
// shooting server's `__working__` while the section built to catch exactly that
// write was busy watching a temporary directory. The recorder arm is the one
// exception and it has to be - the sensor is attached to the shooting server - and
// it is safe for a reason rather than by luck: `history.commit` returns early when
// there is no clip, so a recorder page cannot auto-save whatever is bolted to the
// handler. The run asserts that rather than assuming it.
const WORK = mkdtempSync(join(tmpdir(), 'sensor-view-'));
const PRIVATE_BASE = `http://localhost:${PRIVATE_PORT}`;
let server = null;

async function startPrivateServer() {
  const caps = join(WORK, 'captures');
  mkdirSync(caps, { recursive: true });
  const source = join(CAPTURES_DIR, onDisk.file);
  if (!existsSync(source)) throw new Error(`no capture at ${source} to link into the private server`);
  symlinkSync(source, join(caps, onDisk.file));
  const child = spawn(process.execPath, [join(REPO, 'server/index.js'),
    '--port', String(PRIVATE_PORT), '--captures', caps,
    '--projects', join(WORK, 'projects'), '--presets', join(WORK, 'presets'),
    '--deliverables', join(WORK, 'deliverables'), '--jobs', join(WORK, 'jobs')],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  server = child;
  const log = [];
  child.stdout.on('data', (c) => log.push(c.toString()));
  child.stderr.on('data', (c) => log.push(c.toString()));
  for (let i = 0; i < 300; i++) {
    await new Promise((done) => { setTimeout(done, 100); });
    try {
      const r = await fetch(`${PRIVATE_BASE}/capture/${encodeURIComponent(TAKE)}/hello`);
      if (r.ok) return;
    } catch { /* not up yet */ }
  }
  throw new Error(`the private server never came up on ${PRIVATE_PORT}:\n${log.join('')}`);
}

// ===========================================================================

console.log(`[sensor-view] ${URL_BASE} - take ${TAKE}, ${onDisk.frames} frames`);
console.log(`[sensor-view] the library's intrinsics: `
  + takes.map((t) => `${t.id} ${t.hello ? `${t.hello.fx}/${t.hello.fy}` : 'none'}`).join(', '));

try {
  // Started before anything opens a page, because every editor arm presses the
  // button and any of them can be made to write by a mutation.
  await startPrivateServer();
  console.log(`[sensor-view] the editor arms run on a private server at ${PRIVATE_BASE}, stores under ${WORK}`);

  // ===================================================== 0. why the arms exist
  //
  // Stated as an assertion rather than as a comment, because the whole shape of this
  // tool rests on it. If a take with different intrinsics ever lands in the library
  // this row goes green-to-red and the synthetic arms stop being the only way to see
  // a hardcoded angle - which is a fact worth being told rather than one to discover
  // by reading a header that has gone out of date.
  console.log('\n[0] every take on disk carries one set of intrinsics');
  const withHello = takes.filter((t) => t.hello);
  const distinct = new Set(withHello.map((t) => `${t.hello.fx}/${t.hello.fy}`));
  check(withHello.length >= 2 && distinct.size === 1,
    'the library cannot distinguish a computed angle from a constant on its own',
    `${withHello.length} takes, ${distinct.size} distinct fx/fy: ${[...distinct].join(' ')}`);
  note('so the intrinsics claim below is driven on two arms that do not exist on disk',
    ARMS.slice(1).map((a) => `${a.name} fx=${a.intrinsics.fx} fy=${a.intrinsics.fy}`).join(', '));

  // ================================================== 1. the pose is the sensor's
  //
  // First and cheapest. Everything below is about angles, and an angle opened from
  // the wrong place is not the sensor's view whatever its width.
  console.log('\n[1] the pose is the sensor\'s: the origin, looking down -Z');
  const poseRun = await onFreshPage('the pose', { }, async ({ page }) => {
    const before = await page.evaluate('globalThis.__sv.displace({})');
    const applied = await page.evaluate('globalThis.__sv.at("1920x1080")');
    // The second arm, and the reason it is separate: the control is left with
    // damping momentum in it, which the press then spends. Three updates rather
    // than one so the residual is a running orbit rather than a single step.
    const spun = await page.evaluate('globalThis.__sv.displace({ spin: true, updates: 3 })');
    await clickSensorView(page);
    const spunPose = await page.evaluate('globalThis.__sv.pose()');
    return { before, applied, spun, spunPose };
  });
  if (!poseRun.ok) throw new Error(`the pose arm did not run: ${poseRun.error}`);
  {
    const { before, applied, spun, spunPose } = poseRun.value;
    const { pose, returned } = applied;
    const norm = Math.hypot(...pose.position);
    check(norm < DUST, `the camera sits at the origin, within ${DUST}`,
      `|position| = ${norm.toExponential(2)} from [${pose.position.map((v) => v.toExponential(2)).join(', ')}]`);
    // The dust is real and it is why this is a tolerance rather than an equality:
    // `controls.update()` rebuilds the position from a spherical offset, so the
    // component that should be zero comes back around 1e-16.
    check(Math.abs(pose.direction[0]) < DUST && Math.abs(pose.direction[1]) < DUST
      && Math.abs(pose.direction[2] + 1) < DUST,
      `and looks down -Z, within ${DUST}`,
      `direction [${pose.direction.map((v) => v.toExponential(2)).join(', ')}]`);
    check(Math.abs(pose.target[0]) < DUST && Math.abs(pose.target[1]) < DUST && pose.target[2] < 0,
      'the orbit pivot is on the optical axis in front of the sensor',
      `target [${pose.target.map((v) => fixed(v, 3)).join(', ')}]`);
    check(returned.position.every((v, i) => Math.abs(v - pose.position[i]) < DUST)
      && returned.target.every((v, i) => Math.abs(v - pose.target[i]) < DUST)
      && Math.abs(returned.fov - pose.fov) < DUST,
      'and the return value describes the camera rather than an intention',
      `returned fov ${fixed(returned.fov)} against the camera's ${fixed(pose.fov)}`);
    // The falsification control for this section: the camera was somewhere else a
    // moment ago, so a `sensorView` that did nothing at all fails here rather than
    // passing three rows about a pose it never changed.
    check(Math.hypot(...before.position) > 1 && before.fov !== returned.fov,
      'the camera was displaced first, so a button that did nothing cannot pass',
      `from [${before.position.map((v) => fixed(v, 2)).join(', ')}] fov ${fixed(before.fov, 1)}`);
    // The auto-orbit arm. `sensorView` goes through the registry rather than onto
    // `controls` directly precisely so the checkbox stops claiming the view is
    // spinning, and a pose set underneath a running orbit slides back out - so both
    // halves are asserted here, on a control that was genuinely orbiting.
    const residual = Math.hypot(...spunPose.position);
    check(spun.spin === true && spunPose.spin === false,
      'a press while the view is auto-orbiting switches the orbit off',
      `spin ${spun.spin} before, ${spunPose.spin} after`);
    check(residual < ORBIT_RESIDUAL,
      `and lands within ${ORBIT_RESIDUAL * 1000}mm of the origin, the damping residual being spent by the press`,
      `|position| = ${residual.toExponential(2)} m against the idle arm's ${Math.hypot(...pose.position).toExponential(2)}`);
  }

  // ======================================= 2 and 3. the angles, and what they fit
  //
  // Driven together because they are one page load per arm and two readings of the
  // same sweep. The rows are separated: what the angle *is* comes from the arm's own
  // intrinsics, and what it *fits* is judged geometrically without recomputing it.
  console.log('\n[2] the angles come from the take\'s intrinsics, on three arms');

  const sizeRun = await onFreshPage('the export menu', { }, async ({ page }) =>
    page.evaluate('globalThis.__sv.sizes()'));
  if (!sizeRun.ok) throw new Error(`the size sweep did not run: ${sizeRun.error}`);
  const SHIPPED = sizeRun.value;
  // The constants the UI offers rather than a list of this tool's own. Step 6's hole
  // was exactly this: four arms that were all 1.6 against a menu that was all 16:9,
  // and every arm confirming the others made the agreement invisible.
  note(`the export menu ships ${SHIPPED.length} sizes`,
    [...new Set(SHIPPED.map((s) => s.ratio))].join(', '));

  // One aspect per ratio group for arms B and C, the whole menu for arm A. Arm A is
  // the intrinsics anything shipping actually has, so it sweeps what a user can pick;
  // the synthetic arms are about the intrinsics rather than about the menu, and the
  // sizes inside a ratio group differ only by the fit's integer rounding.
  const ONE_PER_RATIO = SHIPPED.filter((s, i) => SHIPPED.findIndex((o) => o.ratio === s.ratio) === i);

  const sweeps = new Map();
  for (const arm of ARMS) {
    const want = arm.intrinsics ?? { fx: hello.fx, fy: hello.fy };
    const list = arm.intrinsics ? ONE_PER_RATIO : SHIPPED;
    const run = await onFreshPage(`arm ${arm.name}`, { intrinsics: arm.intrinsics }, async ({ page }) => {
      const out = [];
      for (const s of list) out.push({ ...s, ...(await page.evaluate(`globalThis.__sv.at(${JSON.stringify(s.size)})`)) });
      return out;
    });
    if (!run.ok) throw new Error(`arm ${arm.name} did not run: ${run.error}`);
    sweeps.set(arm.name, { arm, want, rows: run.value });

    // The interception proved by reading back what the page unprojects on, which is
    // upstream of every angle below. Arm A's proof runs the other way: it has to
    // carry the take's own numbers and not the boot defaults.
    const got = run.value[0].returned.intrinsics;
    check(Math.abs(got.fx - want.fx) < DUST && Math.abs(got.fy - want.fy) < DUST,
      `arm ${arm.name}: the page unprojects on the intrinsics this arm asked for`,
      `fx ${got.fx} fy ${got.fy} cx ${fixed(got.cx, 3)} cy ${fixed(got.cy, 3)}`);
    if (arm.intrinsics) {
      check(Math.abs(got.fx - hello.fx) > 1 || Math.abs(got.fy - hello.fy) > 1,
        `arm ${arm.name}: and they are not the take's, so the interception held`,
        `against the take's ${hello.fx}/${hello.fy}`);
    } else {
      check(got.fx !== BOOT_DEFAULTS.fx && got.fy !== BOOT_DEFAULTS.fy,
        'arm A: and they are not the boot defaults, so the hello was read',
        `against the defaults ${BOOT_DEFAULTS.fx}/${BOOT_DEFAULTS.fy}`);
    }
  }

  // The angle itself, against the closed form the design states, on each arm's own
  // focal lengths. This is a restatement of the spec rather than an independent
  // measurement, which is why the fit rows below exist as well.
  for (const [name, { want, rows }] of sweeps) {
    for (const row of rows) {
      const { tanH, tanV } = frame(want.fx, want.fy);
      const aspect = row.returned.aspect;
      const wantBinding = aspect >= tanH / tanV ? 'vertical' : 'horizontal';
      const wantFov = (wantBinding === 'vertical' ? 2 * Math.atan(tanV) : 2 * Math.atan(tanH / aspect)) * DEG;
      check(Math.abs(row.returned.fov - wantFov) < 1e-9 * Math.max(1, wantFov)
        && row.returned.binding === wantBinding,
        `arm ${name} at ${row.size}: fov is 2 atan of this arm's own focal lengths`,
        `fov ${fixed(row.returned.fov)} against ${fixed(wantFov)}, ${row.returned.binding}/${wantBinding}, aspect ${fixed(aspect)}`);
    }
  }

  // The cross-arm row, which is the one the whole three-arm shape exists for. A
  // constant passes every per-arm row above on arm A and cannot pass this.
  {
    const at = (name, ratio) => sweeps.get(name).rows.find((r) => r.ratio === ratio);
    for (const ratio of [...new Set(ONE_PER_RATIO.map((s) => s.ratio))]) {
      const fovs = ARMS.map((a) => at(a.name, ratio)?.returned.fov);
      const spread = Math.max(...fovs) - Math.min(...fovs);
      check(new Set(fovs.map((f) => f.toFixed(6))).size === ARMS.length,
        `at ${ratio} the three arms open three different angles`,
        `${fovs.map((f) => fixed(f, 3)).join(' / ')} degrees, spread ${fixed(spread, 3)}`);
    }
  }

  console.log('\n[3] the fit contains the sensor\'s frame and touches it on one axis');
  // Judged from the frustum the page reports rather than from the formula that made
  // it: the achieved half-tangents against the sensor's. `sV` and `sH` are how many
  // times wider the frustum is than the frame on each axis, so containment is both
  // at least 1 and tightness is one of them being exactly 1. Containment on its own
  // is one-sided and a 179 degree frustum passes it.
  let sawVertical = 0;
  let sawHorizontal = 0;
  for (const [name, { want, rows }] of sweeps) {
    const { tanH, tanV } = frame(want.fx, want.fy);
    for (const row of rows) {
      const aspect = row.returned.aspect;
      const achievedV = Math.tan((row.pose.fov * (Math.PI / 180)) / 2);
      const achievedH = achievedV * aspect;
      const sV = achievedV / tanV;
      const sH = achievedH / tanH;
      const tight = Math.abs(sV - 1) < 1e-9 ? 'vertical' : (Math.abs(sH - 1) < 1e-9 ? 'horizontal' : 'neither');
      check(sV >= 1 - 1e-9 && sH >= 1 - 1e-9 && tight !== 'neither',
        `arm ${name} at ${row.size}: the sensor's frame is inside the frustum and touches it`,
        `sV ${fixed(sV, 6)} sH ${fixed(sH, 6)} tight on ${tight}`);
      check(row.returned.binding === tight,
        `arm ${name} at ${row.size}: and \`binding\` names the axis that actually bound`,
        `said ${row.returned.binding}, measured ${tight}, aspect ${fixed(aspect)} against tanH/tanV ${fixed(tanH / tanV)}`);
      if (name === 'A take') {
        if (tight === 'vertical') sawVertical++;
        if (tight === 'horizontal') sawHorizontal++;
      }
    }
  }
  // A sweep that only ever bound one way has not tested the other branch, however
  // many sizes it walked. The menu's 1:1 sizes are the only ones narrower than the
  // sensor's 1.2075, which is why they are in the sweep rather than a shape this
  // tool invented.
  check(sawVertical > 0 && sawHorizontal > 0,
    'the shipped sizes exercise both branches of the fit on the take\'s own intrinsics',
    `${sawVertical} vertical, ${sawHorizontal} horizontal of ${SHIPPED.length}`);

  // ==================================================== 4. it writes nothing
  //
  // Navigation, and the design's rule for navigation is that it leaves no trace. The
  // observation is deliberately not one thing: the page's own requests, the server's
  // monotonic per-store counters, and the bodies of the stores. The second form of
  // the agreement rule in `docs/instruments.md` is what this is answering - not "what
  // do my arms agree about" but "is there an object here that every observation
  // happens to skip".
  console.log('\n[4] pressing it writes nothing: no key, no undo entry, no document change');
  const beforeStores = await stores(PRIVATE_BASE);
  const writeRun = await onFreshPage('the writes-nothing arm', { }, async ({ page }) => {
    // The stage is set before the snapshot, because adopting an output size *is* a
    // document change - it is what the clip was composed for - and a snapshot taken
    // across it would be measuring the wrong gesture.
    await page.evaluate('globalThis.__sv.at("1920x1080")');
    await page.evaluate('globalThis.__sv.settled()');
    await page.waitForTimeout(1200);
    const displaced = await page.evaluate('globalThis.__sv.displace({})');
    const before = await page.evaluate('globalThis.__sv.document()');
    // The real gesture: the button, clicked. A direct call to `sensorView` would
    // walk straight past a handler that keys the camera around it, which is exactly
    // the shape `sensor-view-keys-camera` plants.
    await clickSensorView(page);
    await page.evaluate('globalThis.__sv.settled()');
    // The auto-save is fire-and-forget, so a read taken the moment the click resolves
    // records an absence the write is still on its way to filling. An absence is the
    // one result nobody re-checks.
    await page.waitForTimeout(1500);
    const after = await page.evaluate('globalThis.__sv.document()');
    const pose = await page.evaluate('globalThis.__sv.pose()');
    return { displaced, before, after, pose };
  });
  if (!writeRun.ok) throw new Error(`the writes-nothing arm did not run: ${writeRun.error}`);
  const afterStores = await stores(PRIVATE_BASE);
  {
    const { displaced, before, after, pose } = writeRun.value;
    // The control, again and for this section's own reason: a click that changed
    // nothing writes nothing trivially.
    check(Math.hypot(...displaced.position) > 1 && Math.hypot(...pose.position) < DUST,
      'the click moved the camera from where it was put to the sensor\'s position',
      `[${displaced.position.map((v) => fixed(v, 2)).join(', ')}] to |position| ${Math.hypot(...pose.position).toExponential(2)}`);
    check(before.project === after.project, 'the project serialisation is byte-identical across the click',
      `${before.project.length} bytes before, ${after.project.length} after`);
    check(before.depth === after.depth, 'the undo stack did not grow',
      `depth ${before.depth} then ${after.depth}`);
    check(before.cameraKeys === after.cameraKeys && after.cameraKeys === 0,
      'no key landed on the camera track', `${before.cameraKeys} then ${after.cameraKeys}`);
    check(before.trackNames === after.trackNames && before.lanes === after.lanes,
      'no track and no lane appeared', `tracks [${after.trackNames}]`);
    const wrote = writeRun.wrote ?? [];
    check(wrote.length === 0, 'and the page sent nothing that was not a read',
      wrote.length ? wrote.join(', ') : 'no non-GET request in the whole page lifetime');
    for (const key of Object.keys(beforeStores)) {
      check(beforeStores[key] === afterStores[key], `the ${key} store is unchanged on the server`,
        key === 'writes' ? `${beforeStores.writes} then ${afterStores.writes}` : `${beforeStores[key].length} bytes`);
    }
  }

  // ==================================================== 5. the recorder surface
  //
  // A tool named after a user-facing surface should have at least one arm pointed at
  // each surface it claims. The recorder's intrinsics arrive over the socket rather
  // than from a file, and that is a different path through the same button - so a
  // build that read the hello only in `openTake` would pass everything above.
  console.log('\n[5] the same button on the recorder, on the attached sensor\'s own hello');
  // The one arm on the shooting server, because the sensor is attached to it.
  const recRun = await onFreshPage('the recorder arm', { path: RECORDER_PATH, base: URL_BASE }, async ({ page }) => {
    // Bounded, and the bound is the point. The uniform block boots at exactly 366
    // and this sensor reports 366.031494, so the default still standing means the
    // hello has not landed - and "the angles are the attached sensor's" cannot be
    // proven against the defaults. A run that hung here would report neither answer.
    await page.waitForFunction('globalThis.__kinect.uniforms.focal.value.x !== 366', null, { timeout: HELLO_MS });
    const surface = await page.evaluate('globalThis.__sv.surface()');
    const displaced = await page.evaluate('globalThis.__sv.displace({})');
    // Before and after on the page's own document as well as on its requests. This
    // arm is the one running against the shooting server, so "it wrote nothing" has
    // to be answerable without comparing that server's stores - which another
    // session editing at the same time would move for reasons this tool is not
    // about.
    const before = await page.evaluate('globalThis.__sv.document()');
    await clickSensorView(page);
    const after = await page.evaluate('globalThis.__sv.document()');
    const pose = await page.evaluate('globalThis.__sv.pose()');
    const live = await page.evaluate(`(() => {
      const f = globalThis.__kinect.uniforms.focal.value;
      const c = globalThis.__kinect.uniforms.center.value;
      return { fx: f.x, fy: f.y, cx: c.x, cy: c.y };
    })()`);
    return { surface, displaced, pose, live, before, after };
  });
  if (!recRun.ok) {
    // No sensor, no claim. Untested rather than failed, and the verdict says so:
    // this is the same reading as `library-check`'s low-space row.
    untested = `the recorder arm never saw a sensor hello (${recRun.error})`;
    note('the recorder arm did not run', recRun.error);
  } else {
    const { surface, displaced, pose, live, before, after } = recRun.value;
    check(surface === 'record', 'the button is on the recorder too, and it is the recorder', surface);
    check(live.fx !== BOOT_DEFAULTS.fx && live.fy !== BOOT_DEFAULTS.fy,
      'the recorder unprojects on the attached sensor\'s hello, not the boot defaults',
      `fx ${live.fx} fy ${live.fy} against ${BOOT_DEFAULTS.fx}/${BOOT_DEFAULTS.fy}`);
    note('and that is the same camera the library was shot on',
      `live ${live.fx}/${live.fy} against the take's ${hello.fx}/${hello.fy}`);
    const { tanH, tanV } = frame(live.fx, live.fy);
    const wantBinding = pose.aspect >= tanH / tanV ? 'vertical' : 'horizontal';
    const wantFov = (wantBinding === 'vertical' ? 2 * Math.atan(tanV) : 2 * Math.atan(tanH / pose.aspect)) * DEG;
    check(Math.abs(pose.fov - wantFov) < 1e-9 * Math.max(1, wantFov),
      'and opens the angle those intrinsics subtend',
      `fov ${fixed(pose.fov)} against ${fixed(wantFov)} at aspect ${fixed(pose.aspect)}`);
    const achievedV = Math.tan((pose.fov * (Math.PI / 180)) / 2);
    check(achievedV / tanV >= 1 - 1e-9 && (achievedV * pose.aspect) / tanH >= 1 - 1e-9,
      'and the live sensor\'s frame is inside that frustum',
      `sV ${fixed(achievedV / tanV, 6)} sH ${fixed((achievedV * pose.aspect) / tanH, 6)}`);
    check(Math.hypot(...pose.position) < DUST && Math.hypot(...displaced.position) > 1,
      'and the click put the camera at the origin from somewhere else',
      `|position| ${Math.hypot(...pose.position).toExponential(2)}`);
    check(before.project === after.project && before.depth === after.depth
      && before.cameraKeys === after.cameraKeys,
      'and the recorder\'s document, stack and camera track are unmoved across the click',
      `${before.project.length} bytes, depth ${before.depth}, ${before.cameraKeys} keys`);
    const wrote = recRun.wrote ?? [];
    check(wrote.length === 0, 'and the recorder page sent nothing that was not a read',
      wrote.length ? wrote.join(', ') : 'no non-GET request in the whole page lifetime');
  }

  // ============================================= 6. the two panels are two panels
  //
  // **The recorder surface had no committed check at all, and this is where that
  // belongs because this is the only tool that drives both surfaces.** Delete the
  // `EDITING ?` gate on the keyframe loop and nothing in the repo goes red:
  // `registry-check` drives `/record` but writes slider values through the DOM,
  // which works perfectly well on a `display: none` element - so it passes
  // identically whether the look groups are on screen or not, and it never looks at
  // a `.kf`. `keyframe-check` runs on `/edit`, where the buttons are supposed to
  // exist. `library-check` reads two ids. The surface was unwatched in exactly the
  // way `monitor-check`'s picture was.
  //
  // The claims are asserted as rules over every block in the panel rather than as a
  // list of ids, because a check that names three of six is a check for those three.
  // The last rule is the closer: everything the first three do not name has to be
  // reachable on both surfaces, so a group added later is asked about by existing.
  console.log('\n[6] the recorder and the editor are different panels, in the ways claimed');
  // **One walk, used by both surfaces.** The asymmetry between them is this section's
  // whole subject, so an arm that walked its tabs differently from the other would put
  // a difference in the instrument exactly where the claim is about the product. The
  // editor's half of this was a literal `['camera', 'framing', 'look', 'region']`, which
  // is the same shape as the `#extended` driver that stood here until `988551e` deleted
  // the button under it: correct on the day and unable to notice the day it stopped
  // being. It also silently omitted the Record tab, so what the editor did with the tab
  // it hides was never read at all.
  //
  // The tabs are read off the page and **filtered by `checkVisibility`**, because each
  // surface hides one of them outright - `display: none`, in the markup and not on the
  // surface. Enumerating the nodes alone drives a click at a box of zero by zero and
  // spends Playwright's thirty seconds on it, which arrives as "the arm did not run"
  // rather than as anything about the claim. Keyed by the tab's own `data-panel-tab`
  // rather than by element id, because that is the name the panel answers with in
  // `activeTab` and the row below compares the two.
  const walkTabs = async (page) => {
    // Read before anything is clicked, so this is the surface as it opens rather than
    // as the walk leaves it.
    const opening = await page.evaluate('globalThis.__sv.panel()');
    const seen = await page.evaluate(`(() => {
      const all = [...document.querySelectorAll('#panelTabs [role="tab"]')];
      const vis = (b) => b.checkVisibility({ checkVisibilityCSS: true });
      const name = (b) => ({ id: b.id, tab: b.dataset.panelTab ?? b.id });
      return { shown: all.filter(vis).map(name), hidden: all.filter((b) => !vis(b)).map(name) };
    })()`);
    const states = {};
    for (const { id, tab } of seen.shown) {
      await page.click(`#${id}`);
      states[tab] = await page.evaluate('globalThis.__sv.panel()');
    }
    return {
      opening,
      states,
      tabs: seen.shown.map((t) => t.tab),
      hidden: seen.hidden.map((t) => t.tab),
    };
  };
  const panelRun = await onFreshPage('the panel arms', { }, async ({ page }) => {
    // **The collapse rule needs a document with something in it, and this arm was giving
    // it one with nothing.** Which groups the panel leaves open derives from the clip, so
    // a take nobody has graded puts every look parameter at its default and every
    // collapsible group derives `shut` - and the row below, which asks that the groups
    // left open show all of their controls, then has no groups left open to ask about.
    // It failed at `edOpen.length > 0`, which is the floor that row added on purpose so
    // that a build marking everything shut could not pass it. The floor was right and the
    // fixture was empty.
    //
    // So one look parameter is written off its default first, through the registry the
    // panel derives from, and put back afterwards - the value is set rather than assumed,
    // so the arm does not inherit whatever the last run left in `__working__`. The nudge
    // is asserted below rather than trusted: a `set` that clamped back to the default
    // would leave the row failing for a reason that reads exactly like the panel's.
    const nudge = await page.evaluate(`(() => {
      const name = __kinect.params.names('look')[0];
      const was = __kinect.params.get(name);
      __kinect.params.set(name, was === 0 ? 1 : was * 1.7);
      return { name, was, now: __kinect.params.get(name) };
    })()`);
    const walked = await walkTabs(page);
    await page.evaluate(`__kinect.params.reset([${JSON.stringify(nudge.name)}])`);
    return { ...walked, nudge };
  });
  const recPanelRun = await onFreshPage('the recorder panel arm', { path: RECORDER_PATH },
    async ({ page }) => walkTabs(page));
  if (!panelRun.ok) throw new Error(`the editor panel arm did not run: ${panelRun.error}`);
  if (!recPanelRun.ok) throw new Error(`the recorder panel arm did not run: ${recPanelRun.error}`);
  {
    const edStates = panelRun.value.states;
    const recStates = recPanelRun.value.states;
    const recTabs = recPanelRun.value.tabs;
    /**
     * What a surface reaches, which is the union over the tabs it shows.
     *
     * **The tab a surface happens to open on is not the surface**, and reading one was
     * how four rows below came to describe a panel that had stopped existing: the
     * recorder opens on Record, so "the grade is hidden on the recorder" and "the
     * preview-range warning is not there" were both measured on the one tab that holds
     * neither, and both went on passing while the Look and Framing tabs beside them
     * held exactly what the rows said was absent. The editor's half of this section
     * already worked this way; the recorder grew tabs in this rework and did not.
     */
    const across = (states) => {
      const each = Object.values(states);
      const at = (state, key) => state.blocks.find((b) => b.key === key);
      return {
        ...each[0],
        blocks: each[0].blocks.map((block) => ({
          ...block,
          visible: each.some((state) => at(state, block.key)?.visible),
          controlsOnScreen: Math.max(...each.map((state) => at(state, block.key)?.controlsOnScreen ?? 0)),
        })),
        // Reached the same way and for the same reason: it lives on the Framing tab.
        recRange: each.some((state) => state.recRange),
      };
    };
    const ed = across(edStates);
    const rec = across(recStates);
    // Without this every visibility row below is a row about a function that returned
    // undefined, which is falsy, which reads as "hidden" for everything.
    check(ed.supported && rec.supported,
      '`checkVisibility` exists, so the rows below are about layout rather than about undefined',
      `editor ${ed.supported}, recorder ${rec.supported}`);
    check(Object.keys(edStates).length > 0
      && Object.entries(edStates).every(([tab, state]) => state.activeTab === tab),
      'every editor inspector tab activates the panel view it names',
      Object.entries(edStates).map(([tab, state]) => `${tab}:${state.activeTab}`).join(' '));
    check(Object.keys(recStates).length > 0
      && Object.entries(recStates).every(([tab, state]) => state.activeTab === tab),
      'and so does every tab the recorder shows, which is the walk the rows below stand on',
      Object.entries(recStates).map(([tab, state]) => `${tab}:${state.activeTab}`).join(' '));
    // The fixture the collapse-rule row below stands on, asserted rather than assumed:
    // a `set` that clamped back to where it started would leave that row failing for a
    // reason that reads exactly like the panel's.
    const nudge = panelRun.value.nudge;
    check(nudge.now !== nudge.was,
      'the editor arm moved a look parameter off its default, so the collapse rule has something to leave open',
      `${nudge.name} ${nudge.was} -> ${nudge.now}`);

    // (a) the keyframe controls
    check(rec.kfButtons === 0 && rec.keyed === 0,
      'the recorder has no keyframe control at all: a key is a position on a clip and it has none',
      `${rec.kfButtons} buttons in #panel, ${rec.keyed} of ${rec.lookNames} parameters carrying one`);
    check(ed.kfButtons === ed.lookNames && ed.keyed === ed.lookNames && ed.lookNames > 0,
      'and the editor has exactly one per look parameter, each sharing its parameter\'s row',
      `${ed.kfButtons} buttons and ${ed.keyed} rows against ${ed.lookNames} look parameters`);

    // (b) every look parameter still has a control on both surfaces, visible or not.
    // The registry throws at boot when one does not, so this is asserting the throw
    // rather than assuming it - a build that stopped throwing would be caught here.
    check(ed.missingControl.length === 0 && rec.missingControl.length === 0,
      'every look parameter has a panel control on both surfaces, hidden or not',
      `${ed.lookNames} parameters, missing on the editor [${ed.missingControl.join(' ')}], on the recorder [${rec.missingControl.join(' ')}]`);
    check(ed.lookNames === rec.lookNames && ed.blocks.length === rec.blocks.length,
      'and both surfaces are built from one registry and one panel',
      `${ed.lookNames}/${rec.lookNames} parameters, ${ed.blocks.length}/${rec.blocks.length} blocks`);

    // (c) which blocks are on screen, as rules over the whole panel
    //
    // **These were two lists of ids and the lists went stale twice.** `9556663` took
    // `extendedRow` out of the recorder's after `988551e` deleted the button, and left
    // `recLookGroup` in it - a block the same commit had deleted - so the rule went on
    // naming something the panel no longer held. A list of ids cannot notice the day the
    // panel stops matching it, which is the failure this repo keeps closing by making
    // the check enumerate the thing instead.
    //
    // The mechanism the lists were approximating is one sentence: **each surface hides
    // exactly one inspector tab outright, and what it cannot reach is exactly what lives
    // on the tab it hides.** The recorder hides Camera, so the composition block and the
    // viewer's own settings are the two it cannot reach; the editor hides Record, so the
    // four shooting blocks are the four it cannot reach. Both halves are measured rather
    // than declared - the unreachable set off the surface itself, the population that
    // ought to be unreachable off the *other* surface, where that tab is on screen - so
    // a group added to either tab is asked about by existing.
    const listed = (blocks) => blocks.map((b) => b.key);
    const cannotReach = (surface) => listed(surface.blocks.filter((b) => !b.visible));
    // What lives on one tab and nowhere else, read on the surface that shows that tab.
    const onlyUnder = (states, tab) => listed(Object.values(states)[0].blocks).filter((key) => {
      const shows = (name) => !!states[name].blocks.find((b) => b.key === key)?.visible;
      return shows(tab) && Object.keys(states).every((name) => name === tab || !shows(name));
    });
    const recHides = recPanelRun.value.hidden;
    const edHides = panelRun.value.hidden;
    const same = (a, b) => a.length === b.length && [...a].sort().join(' ') === [...b].sort().join(' ');

    check(listed(rec.blocks).length === listed(ed.blocks).length,
      'the panel holds every block these rules name, so none of them is asserted about nothing',
      listed(rec.blocks).join(' '));
    check(recHides.length === 1 && edHides.length === 1 && recHides[0] !== edHides[0],
      'each surface hides exactly one inspector tab, and not the same one as the other',
      `the recorder hides [${recHides.join(' ') || 'nothing'}] of ${recTabs.concat(recHides).length}, `
      + `the editor hides [${edHides.join(' ') || 'nothing'}]`);
    // **Both sets have to be non-empty or the comparison is two empties agreeing.** That
    // is the shape a derived rule fails at: a walk that revealed nothing would make the
    // unreachable set everything and the population empty, and a union taken over a page
    // that ignored every click would make both empty and the row green.
    const recCannot = cannotReach(rec);
    const recShould = onlyUnder(edStates, recHides[0]);
    check(recShould.length > 0 && same(recCannot, recShould),
      'what the recorder cannot reach is exactly what lives on the tab it hides, and that is not nothing',
      `unreachable on the recorder [${recCannot.join(' ') || 'none'}], `
      + `on the editor's ${recHides[0]} tab alone [${recShould.join(' ') || 'none'}]`);
    const edCannot = cannotReach(ed);
    const edShould = onlyUnder(recStates, edHides[0]);
    check(edShould.length > 0 && same(edCannot, edShould),
      'and what the editor cannot reach is exactly what lives on the tab it hides',
      `unreachable on the editor [${edCannot.join(' ') || 'none'}], `
      + `on the recorder's ${edHides[0]} tab alone [${edShould.join(' ') || 'none'}]`);
    // **Counted in controls as well as in headings, and the pair is the point.** A
    // group's node stays visible when the collapse rule shuts it - `shut` hides the
    // rows, not the box around them - so "9 look groups, all 9 visible" went on being
    // true of a panel with four of the nine showing nothing gradeable at all. That is
    // the `sweep.length > 60` failure this repo already records, arriving in a second
    // instrument: the sentence stayed still while the population under it grew a way of
    // satisfying the comparison without satisfying the claim.
    //
    // Which groups are shut is `editor-check` section 13's subject and deliberately not
    // asserted here, because a collapse that derives from the document is a different
    // feature from a surface that hides the grade. What this row owes is that the two
    // surfaces differ in the *controls* on screen and not merely in their furniture, so
    // the non-collapsible look groups carry the assertion and the collapsible ones are
    // named in the detail where a change in them is visible rather than silent.
    //
    // **Partitioned by the collapse rule rather than floored at one group**, and the
    // difference is what a floor is denominated in. `every non-collapsible group shows
    // all its controls` was the first repair, and its guard against having nothing left
    // to say was `edFixed.length > 0` - a count of the groups that happen not to declare
    // `collapses`, which narrows towards one as more of them do and would reach zero
    // without a word. It sat beside `sum(edLook, 'controlsOnScreen') > 0`, which the
    // conjunct before it already implies: a group showing all of its controls, with a
    // positive control count, is a positive sum. That is the vacuous conjunction this
    // document opens with, added by the change that cites it.
    //
    // So the look groups are split by the `shut` class the panel itself sets, and both
    // halves are asserted: every group the rule leaves open shows *all* of its controls,
    // every group it has shut shows none, and at least one is open. The floor is now
    // about the claim - that the grade is reachable on this surface - rather than about
    // which groups happen to be collapsible, and the partition is checked from both sides,
    // so a build that marked everything shut fails the floor and one that marked
    // everything open fails the controls.
    const sum = (list, key) => list.reduce((n, b) => n + b[key], 0);
    const hiddenTabBlocks = new Set([...recShould, ...edShould]);
    const recLook = rec.blocks.filter((b) => b.look && !hiddenTabBlocks.has(b.key));
    const edLook = ed.blocks.filter((b) => b.look && !hiddenTabBlocks.has(b.key));
    const edOpen = edLook.filter((b) => !b.shut);
    const edShut = edLook.filter((b) => b.shut);
    // **This row said the grade was hidden on the recorder, and it now says the
    // opposite, which is a claim inverted rather than a threshold moved.** The authority
    // for inverting it is this file's own header, written by `9556663`: "the recorder no
    // longer hides the grade at all - the surface grew inspector tabs and the Look tab
    // holds it". That commit recorded the new truth in the paragraph and left the row
    // asserting the old one, and the row went on passing because it read the tab the
    // recorder opens on, which is the one tab the grade is not under. A claim that
    // survives by being measured in the one place it is still true is the failure this
    // section exists to catch, so it is restated rather than reworded.
    //
    // The look groups on the tab each surface hides are out of both lists: they are the
    // subject of the derived rule above, and asking them here would assert the same fact
    // twice and call the second one coverage.
    check(recLook.length > 0 && recLook.every((b) => b.visible),
      'the grade is reachable on the recorder too, through the tab the rework put it on',
      `${recLook.length} look groups off the hidden tab, ${recLook.filter((b) => b.visible).length} reachable, `
      + `unreachable [${recLook.filter((b) => !b.visible).map((b) => b.key).join(' ') || 'none'}]`);
    check(edLook.length > 0 && edLook.every((b) => b.visible)
      && edOpen.length > 0 && edOpen.every((b) => b.controls > 0 && b.controlsOnScreen === b.controls)
      && edShut.every((b) => b.controlsOnScreen === 0),
      'and reachable through the editor inspectors, where grading is the job - measured in controls on screen rather than in headings',
      `${edLook.length} look groups, all ${edLook.filter((b) => b.visible).length} reachable, `
      + `${sum(edLook, 'controlsOnScreen')} of ${sum(edLook, 'controls')} controls on screen; `
      + `${edOpen.length} left open by the collapse rule show ${sum(edOpen, 'controlsOnScreen')} of `
      + `${sum(edOpen, 'controls')}; shut by it: ${edShut.map((b) => b.key).join(' ') || 'none'}`);
    // The closer. Everything the rules above do not name is common furniture and has
    // to be on both surfaces, so a block added later is covered without being listed.
    const commonRec = rec.blocks.filter((b) => !hiddenTabBlocks.has(b.key) && !b.look);
    const commonEd = ed.blocks.filter((b) => !hiddenTabBlocks.has(b.key) && !b.look);
    check(commonRec.length > 0 && commonRec.every((b) => b.visible) && commonEd.every((b) => b.visible),
      'and every other block in the panel is visible on the recorder and reachable through an editor tab, named or not',
      `${commonRec.map((b) => b.key).join(' ')} - hidden on the recorder [`
      + `${commonRec.filter((b) => !b.visible).map((b) => b.key).join(' ')}], on the editor [`
      + `${commonEd.filter((b) => !b.visible).map((b) => b.key).join(' ')}]`);
    check(rec.recRange === true && ed.recRange === false,
      'the preview-range warning is on the recorder, where clipping the capture is a real confusion',
      `recorder ${rec.recRange}, editor ${ed.recRange}`);

    // (d) the inspector tabs, walked rather than reasoned about
    //
    // **This block asked the `extended settings` toggle until `988551e` took it out of
    // the markup**, and `9556663` retired the mutation that stood on it without
    // retiring the driver beside it - which read `#extended` while that cleanup was
    // chasing `#extendedRow`, so a grep for the name it removed could not find it. The
    // four rows about how that toggle behaved are gone with the control they described,
    // on the same reading `9556663` already applied to `extended-always-open`: a claim
    // the surface stopped making is retired rather than repointed at something nearby.
    //
    // What is not retired is the claim underneath them, because it was never about the
    // toggle - "the recorder builds no keyframe control" is a claim about the surface
    // rather than about what happens to be on screen, and the toggle was merely the one
    // gesture that could plausibly conjure some. The tabs are that gesture now, so the
    // count is asked at every one of them rather than at three states of one button,
    // which is a wider floor than the rows it replaces rather than a narrower one.
    const kfTabs = recTabs.filter((id) => recStates[id].kfButtons > 0);
    check(recTabs.length > 0 && kfTabs.length === 0,
      'no inspector tab on the recorder builds a keyframe control, because there is still no clip',
      `${recTabs.length} tabs walked (${recTabs.join(' ')}), `
      + `keyframe controls under [${kfTabs.join(' ') || 'none'}]`);
    // **The row above passes on a page where every click silently did nothing**, which
    // is the shape a walk-and-count row fails at: nothing was revealed, so nothing was
    // counted, so the count is zero and the claim reads proven. This is the companion
    // that makes the walk itself the thing under test - the surface has to move under
    // the clicks, and it moves in the way the tabs were built to move, with the grade
    // arriving on a tab rather than being present throughout.
    const lookVisible = recTabs.filter((id) => recStates[id].blocks.some((b) => b.look && b.visible));
    check(lookVisible.length > 0 && lookVisible.length < recTabs.length,
      '  and the walk moved the surface, so that count is a measurement rather than a page that ignored every click',
      `look groups visible under [${lookVisible.join(' ') || 'none'}] of ${recTabs.length} tabs`);
    check(rec.surface === 'record' && ed.surface === 'edit',
      'and each arm is the surface it claims, so neither table is about the other page',
      `${rec.surface} and ${ed.surface}`);
  }

  // ================================================ 7. the button reaches the picture
  //
  // Every section above this one asserts against the camera object, and the camera
  // object is not what anybody presses the button to see. That gap was open for the
  // whole life of the feature and it is what this section closes: delete
  // `requestRepaint()` from `sensorView` and the pose, the angles, the fit and the
  // writes-nothing rows all stay green while the editor's picture does not move until
  // the next pointer gesture happens to render it. `no-repaint` is that mutation, and
  // it is the reason this section exists rather than a hypothetical.
  //
  // **Two things make the comparison mean anything, and both were found by measuring
  // rather than by reading.** The overlay has to be off, because it redraws the
  // frustum from the new pose on the next animation frame whether or not the picture
  // did - with it visible, the first version of this section reported CHANGED against
  // the mutated build. And the damping has to be drained, because `advanceNavigation`
  // calls `controls.update()` inside every render, so while the controls hold momentum
  // two renders of one position genuinely differ and a difference proves nothing. The
  // control row drives exactly that pair and must agree before any row below is read.
  console.log('\n[7] the press puts the sensor\'s view on the screen, not only on the camera');
  const pictureRun = await onFreshPage('the picture arm', {}, async ({ page }) => {
    const overlayHidden = await page.evaluate('globalThis.__sv.hideChrome()');
    const drainedAfter = await page.evaluate('globalThis.__sv.drain()');
    const picture = await page.evaluate('globalThis.__sv.picture()');
    const clip = { x: picture.x, y: picture.y, width: picture.width, height: picture.height };

    // The instrument's own control: two renders of one state, nothing between them.
    // If these disagree this arm cannot attribute a difference to anything, and the
    // rows below are about the damping rather than about the button.
    await page.evaluate('globalThis.__sv.forceSeek()');
    const ctrlA = await page.screenshot({ clip });
    await page.evaluate('globalThis.__sv.forceSeek()');
    const ctrlB = await page.screenshot({ clip });

    // Somewhere that is not the sensor's, so "the picture moved" cannot be satisfied
    // by a button with nothing to do.
    const displaced = await page.evaluate('globalThis.__sv.displace({})');
    // Rendered, and this line is load-bearing rather than tidiness. `displace` writes
    // the camera and updates the controls but asks for no image - `params.set('spin')`
    // is tagged `view` and `paramWritten` returns on it - so without a render here
    // `before` is still the *boot* camera's picture and the row below compares the
    // default pose to the sensor rather than the displaced one. It would pass today,
    // because the default sits 1.6m back along the same axis, and it would go vacuous
    // the day somebody moves the boot pose, which is the silent direction.
    await page.evaluate('globalThis.__sv.forceSeek()');
    const before = await page.screenshot({ clip });
    const rendersBefore = await page.evaluate('globalThis.__sv.renders()');

    // The button, clicked, and then nothing at all - no settle, no seek, no pointer.
    // A person who presses it and sits still is what the report describes, so the
    // wait is the whole gesture rather than an await that would do the work for it.
    await clickSensorView(page);
    await page.waitForTimeout(2000);
    const after = await page.screenshot({ clip });
    const rendersAfter = await page.evaluate('globalThis.__sv.renders()');
    const pose = await page.evaluate('globalThis.__sv.pose()');

    // And the tightening row: the image the press produced is already the settled
    // one. Without this the section would pass a build whose repaint rendered a
    // stale camera and was corrected by whatever rendered next.
    await page.evaluate('globalThis.__sv.forceSeek()');
    const forced = await page.screenshot({ clip });

    return {
      overlayHidden,
      drainedAfter,
      picture,
      controlAgrees: ctrlA.equals(ctrlB),
      displaced,
      pose,
      rendersBefore,
      rendersAfter,
      moved: !before.equals(after),
      settledAlready: after.equals(forced),
    };
  });
  if (!pictureRun.ok) throw new Error(`the picture arm did not run: ${pictureRun.error}`);
  {
    const p = pictureRun.value;
    // The two conditions this section's comparison rests on, enforced rather than
    // stated - the failure this repo keeps producing is a tool that names a condition
    // in its header and does nothing to bring it about.
    check(p.overlayHidden, 'the chrome overlay is off, so what is compared is the picture and not the annotation',
      '#chrome hidden');
    check(p.picture.covered === 0 && p.picture.width > 200 && p.picture.height > 200,
      'and nothing at all is drawn over the region compared, hit-tested rather than assumed',
      `${p.picture.width}x${p.picture.height} at ${p.picture.x},${p.picture.y}, `
      + `${p.picture.covered} of 25 probes covered${p.picture.over ? ` by ${p.picture.over}` : ''}`);
    check(p.drainedAfter >= 0, 'the controls hold no damping momentum before anything is photographed',
      p.drainedAfter >= 0 ? `drained in ${p.drainedAfter} updates` : 'still moving after 500 updates');
    check(p.controlAgrees, 'control: two renders of one state agree, so a difference below is attributable',
      'forceSeek twice, nothing in between');

    // The claim.
    check(Math.hypot(...p.displaced.position) > 1 && Math.hypot(...p.pose.position) < DUST,
      'the press moved the camera off the displaced pose and onto the sensor',
      `[${p.displaced.position.map((v) => fixed(v, 2)).join(', ')}] to |position| ${Math.hypot(...p.pose.position).toExponential(2)}`);
    check(p.rendersAfter > p.rendersBefore, 'the press rendered a frame, with no pointer input to do it for the button',
      `renders ${p.rendersBefore} then ${p.rendersAfter}`);
    check(p.moved, 'and the picture itself changed',
      'the uncovered region of the renderer\'s canvas, before and after the click');
    check(p.settledAlready, 'the image the press produced is the settled one, not one a later render corrected',
      'identical to a forced seek taken after it');
  }

  check(pageErrors.length === 0, 'no page reported an error while any of this happened',
    pageErrors.slice(0, 3).join(' | '));
} catch (err) {
  // A run that threw did not finish, and that is a different answer from a claim
  // that failed. It matters most under `--mutate`, where a harness timeout counted
  // in `failures` would be printed as the mutation having been caught.
  crashed = err;
  console.log(`\n  ....  the run did not finish: ${err.message}`);
} finally {
  server?.kill('SIGKILL');
  rmSync(WORK, { recursive: true, force: true });
}

// --------------------------------------------------------------------- verdict

console.log(`\n[sensor-view] ${checks} assertions, ${failures} failed`);
if (fired.length) {
  console.log('[sensor-view] the rows that fired:');
  for (const label of fired) console.log(`    - ${label}`);
}
// Before every other verdict, because a run that threw has not earned any of them.
if (crashed) {
  console.log(`[sensor-view] DID NOT RUN - ${crashed.message}. Nothing here is a finding: re-run it.`);
  process.exit(2);
}
if (untested) {
  console.log(`[sensor-view] UNTESTED - ${untested}. Attach the sensor, or read this as "some claims were not tested here".`);
  process.exit(2);
}
if (MUTATE) {
  // The exit code alone cannot tell "the mutation was caught" from "the tool fell
  // over before asserting anything", and this repo has been bitten by exactly that
  // twice. The labels above are what makes "caught for the reason claimed" checkable.
  if (failures === 0) {
    console.log('[sensor-view] NOT CAUGHT - the check passed a build it should have rejected');
    process.exit(1);
  }
  console.log(`[sensor-view] caught, as required (${failures} assertion${failures === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
if (failures) { console.log('[sensor-view] FAIL'); process.exit(1); }
console.log('[sensor-view] PASS');
process.exit(0);
