// Proves the sensor view: the button puts the free camera where the Kinect physically is, the
// angles it opens come from the take's own intrinsics rather than from a constant, the frame it
// fits is the sensor's frame on every shape the export menu offers, and pressing it writes nothing.
//
// Every take carries the same intrinsics, so a build that hardcoded the angle and one that computes
// it agree on every take anybody can open. The intrinsics claim runs on three arms, two of them
// answered by an intercepted hello, and arm C is anamorphic so `fx` and `fy` differ. The fit is
// judged geometrically rather than by re-deriving the formula, and section 7 is the one arm pointed
// at the picture rather than at the camera object.
//
//   node server/index.js --port 8080 &
//   node tools/sensor-view-check.mjs --url http://localhost:8080
//   node tools/sensor-view-check.mjs --mutate fov-hardcoded            # must FAIL
//   node tools/sensor-view-check.mjs --mutate tanv-uses-fx             # must FAIL
//   node tools/sensor-view-check.mjs --mutate sensor-view-keys-camera  # must FAIL
//   node tools/sensor-view-check.mjs --mutate keyframes-on-every-surface # must FAIL
//   node tools/sensor-view-check.mjs --mutate no-repaint               # must FAIL
//
// Exit 2 means the harness did not run - a stale anchor, a browser that never came up, or the
// record arm with no sensor hello - because untested is not passed.

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
const EDITOR_PATH = '/edit';
const RECORDER_PATH = '/record';
const TAKE = flag('--take', 'sample');
const HEADED = argv.includes('--headed');
const MUTATE = flag('--mutate');
const HELLO_MS = Number(flag('--hello-timeout', '25000'));
// The writes-nothing arm gets a server of its own, so a planted write lands where it can be seen
const PRIVATE_PORT = Number(flag('--private-port', '8131'));
const CAPTURES_DIR = resolve(flag('--captures', join(REPO, 'captures')));

const DW = 512;
const DH = 424;

const BOOT_DEFAULTS = { fx: 366, fy: 366, cx: 256, cy: 212 };

// Floating point dust rather than a threshold: everything asserted here is an
// exact-arithmetic identity.
const DUST = 1e-9;

// The one place the dust is not dust: an update taken while auto-orbit runs leaves
// most of that step.
const ORBIT_RESIDUAL = 0.01;

// Arm B moves the magnitude and holds the ratio; arm C moves the ratio, so `fx` and `fy` differ.
const ARMS = [
  { name: 'A take', intrinsics: null },
  { name: 'B f=500', intrinsics: { fx: 500, fy: 500 } },
  { name: 'C 500/300', intrinsics: { fx: 500, fy: 300 } },
];

const MUTATIONS = {
  // The constant is right for this rig wherever the vertical binds, so only the
  // synthetic arms see it.
  'fov-hardcoded': {
    file: 'web/main.js',
    edits: [[
      '  const fovV = binding === \'vertical\' ? 2 * Math.atan(tanV) : 2 * Math.atan(tanH / aspect);',
      '  const fovV = THREE.MathUtils.degToRad(60.15756974606831);',
    ]],
  },
  // Bit-identical on every take and on arm B, so this is the control that says arm C
  // is load-bearing.
  'tanv-uses-fx': {
    file: 'web/main.js',
    edits: [[
      '  const tanV = (DEPTH_H / 2) / fy;',
      '  const tanV = (DEPTH_H / 2) / fx;',
    ]],
    fails: 'the vertical half-angle taken off `fx` rather than `fy`, which is the one '
      + 'substitution a square sensor would hide. Bit-identical on every take and on arm B, '
      + 'so it is the control saying arm C is load-bearing',
  },
  // It must redden the recorder rows and leave the editor's alone, or it cannot say which broke.
  'keyframes-on-every-surface': {
    file: 'web/main.js',
    edits: [[
      '      const keyButton = EDITING ? makeKeyButton(name) : null;',
      '      const keyButton = makeKeyButton(name);',
    ]],
    fails: 'the key button built whether or not the surface is the editor. It must redden the '
      + 'recorder rows and leave the editor\'s alone, or it cannot say which of the two broke',
  },
  // Anchored on the `controls.update()` pair, since two mutations sharing one text
  // go stale together.
  'no-repaint': {
    file: 'web/main.js',
    edits: [[
      '  controls.update();\n  paintLens();\n  requestRepaint();',
      '  controls.update();\n  paintLens();',
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
    fails: 'the sensor-view button writing a camera key as well as moving the view, so a look at '
      + 'the intrinsics becomes an edit to the clip',
  },
};

/**
 * The mutated source of whichever file the named mutation edits. The exactly-once refusal is the
 * point: a replacement matching nothing would run the unmutated build and read as a missed bug.
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

/**
 * Where a file under `web/` is reached from a browser, matched on the whole pathname rather than
 * with a basename glob: two modules could end in the same name and the wrong one be served.
 */
function servedAt(file) {
  if (!file.startsWith('web/')) {
    throw new Error(`${file} is not served to a browser, so a page mutation cannot reach it`);
  }
  return `/${file.slice('web/'.length)}`;
}

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

let failures = 0;
let checks = 0;
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
let crashed = null;
let untested = null;

// Wrapped, because an unhandled `ECONNREFUSED` exits 1 - the code reserved for a
// claim having failed.
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
// The capture routes name a take by its content hash, never by its name.
const TAKE_KEY = encodeURIComponent(onDisk.hash);
let hello;
try {
  hello = await (await fetch(`${URL_BASE}/capture/${TAKE_KEY}/hello`)).json();
} catch (err) {
  console.log(`[sensor-view] DID NOT RUN - the take's hello could not be read (${err.message})`);
  process.exit(2);
}

/**
 * The half-tangents the sensor's own frame subtends, and where the fit has to bind. Comparing
 * ratios of tangents makes "contains" and "touches" one arithmetic instead of two.
 */
const frame = (fx, fy) => ({ tanH: (DW / 2) / fx, tanV: (DH / 2) / fy });

// Nothing here computes an expectation: every number is read off the page and judged in Node.
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

    // One stage shape at a time, applied and then read. \`setOutputSize\` resizes
    // synchronously, so the camera's aspect is already the new one when
    // \`sensorView\` reads it and there is nothing to wait for.
    at(size) {
      k.setOutputSize(size);
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
        // A control can be in the group without being available for this document.
        // Rack membership and \`under\` both set \`hidden\` on the control's row, while
        // collapse hides otherwise available rows through the group's \`shut\` class.
        // Keep those two mechanisms separate: the assertion below asks collapse to
        // hide the available controls, not to resurrect rows the document withheld.
        controlsAvailable: [...el.querySelectorAll('input, select')]
          .filter((control) => !control.closest('.row, .checkrow')?.hidden).length,
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

const { chromium } = await loadPlaywright();
let mutation = null;
try {
  mutation = MUTATE ? mutatedSource(MUTATE) : null;
} catch (err) {
  // An anchor that no longer matches is the harness not running, so exit 2 rather than 1.
  console.log(`[sensor-view] DID NOT RUN - ${err.message}`);
  process.exit(2);
}
if (MUTATE) console.log(`[sensor-view] MUTATED BUILD: ${MUTATE} in ${mutation.file} - this run is expected to FAIL`);
const mutatedJs = mutation?.file === 'web/main.js' ? mutation.body : null;
const mutatedHtml = mutation?.file === 'web/index.html' ? mutation.body : null;
// A mutation whose file is neither of the two this function serves is not delivered rather
// than not caught.
if (mutation && mutation.file !== 'web/main.js' && mutation.file !== 'web/index.html') {
  console.log(`[sensor-view] DID NOT RUN - ${MUTATE} edits ${mutation.file}, which this tool has no route `
    + 'for yet (only web/main.js and web/index.html) - it would never reach a page');
  process.exit(2);
}
const mutantJsPath = mutatedJs !== null ? servedAt(mutation.file) : null;

const pageErrors = [];

/**
 * A page on one surface, with the hello answered by this tool when an arm asks for one and its
 * interception proved rather than assumed. One browser per page: two live WebGL2 contexts here
 * reliably take the renderer process down.
 */
async function openPage({ path = EDITOR_PATH, take = TAKE, intrinsics = null, base = PRIVATE_BASE } = {}) {
  // Local Network Access is off: a document served through `route.fulfill` has its
  // WebSocket refused.
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
  page.on('request', (req) => {
    if (req.method() === 'GET' || req.method() === 'HEAD') return;
    wrote.push(`${req.method()} ${new URL(req.url()).pathname}`);
  });

  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

  // The interception is proved below: the route was once declared and never installed.
  let servedModule = false;
  if (mutatedJs) {
    await page.route((url) => url.pathname === mutantJsPath, (route) => {
      servedModule = true;
      route.fulfill({ contentType: 'text/javascript; charset=utf-8', body: mutatedJs });
    });
  }
  let servedHtml = false;
  if (mutatedHtml) {
    await page.route((url) => url.pathname === path, (route) => {
      servedHtml = true;
      route.fulfill({ contentType: 'text/html; charset=utf-8', body: mutatedHtml });
    });
  }

  let servedHello = false;
  if (intrinsics) {
    // The take's own hello with two numbers replaced, so this arm differs from A in
    // those two alone.
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
  // Enforced rather than stated: a predicate that stops matching leaves the arm on arm A's numbers.
  if (intrinsics && !servedHello) {
    throw new Error('the hello was never intercepted - this arm ran on the take\'s own intrinsics');
  }
  if (mutatedJs && !servedModule) {
    throw new Error(`the mutated module was staged for ${mutantJsPath} and never requested on ${path} - `
      + 'this page ran the tree\'s own build');
  }
  if (mutatedHtml && !servedHtml) {
    throw new Error(`the mutated markup was never served on ${path} - this page ran the tree's own panel`);
  }
  await page.evaluate(PROBE);
  return { page, errors, wrote, close: () => browser.close() };
}

/**
 * Runs a block on a page of its own, retrying a destroyed execution context - Playwright and the
 * GPU process rather than anything under test. No assertion fires inside the block: an attempt that
 * died having failed three rows and then succeeded would leave those three in the totals.
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

async function clickSensorView(page) {
  const framingTab = page.locator('#panelTabFraming');
  if (await framingTab.isVisible()) await framingTab.click();
  await page.click('#camSensor');
}

async function stores(base) {
  const get = async (path) => JSON.stringify(await (await fetch(`${base}${path}`)).json());
  return {
    writes: await get('/library/writes'),
    projects: await get('/projects'),
    presets: await get('/presets'),
    deliverables: await get('/deliverables'),
    marks: await get(`/capture/${TAKE_KEY}/marks/log`),
  };
}

// Every store in a temporary directory and the take reached by symlink. Every editor arm runs here,
// not only the writes-nothing one: under `sensor-view-keys-camera` the pose arm auto-saved the
// mutated clip over the shooting server's `__working__`. The recorder arm is the exception, since
// the sensor is attached there and `history.commit` returns early with no clip.
const WORK = mkdtempSync(join(tmpdir(), 'sensor-view-'));
const PRIVATE_BASE = `http://localhost:${PRIVATE_PORT}`;
let server = null;

async function startPrivateServer() {
  const caps = join(WORK, 'captures');
  mkdirSync(caps, { recursive: true });
  const source = join(CAPTURES_DIR, onDisk.file);
  if (!existsSync(source)) throw new Error(`no capture at ${source} to link into the private server`);
  symlinkSync(source, join(caps, onDisk.file));
  const child = spawn(process.execPath, [join(REPO, 'server/index.js'), '--standby-after', '0',
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
      const r = await fetch(`${PRIVATE_BASE}/capture/${TAKE_KEY}/hello`);
      if (r.ok) return;
    } catch { /* not up yet */ }
  }
  throw new Error(`the private server never came up on ${PRIVATE_PORT}:\n${log.join('')}`);
}

console.log(`[sensor-view] ${URL_BASE} - take ${TAKE}, ${onDisk.frames} frames`);
console.log(`[sensor-view] the library's intrinsics: `
  + takes.map((t) => `${t.id} ${t.hello ? `${t.hello.fx}/${t.hello.fy}` : 'none'}`).join(', '));

try {
  await startPrivateServer();
  console.log(`[sensor-view] the editor arms run on a private server at ${PRIVATE_BASE}, stores under ${WORK}`);

  console.log('\n[0] every take on disk carries one set of intrinsics');
  const withHello = takes.filter((t) => t.hello);
  const distinct = new Set(withHello.map((t) => `${t.hello.fx}/${t.hello.fy}`));
  check(withHello.length >= 2 && distinct.size === 1,
    'the library cannot distinguish a computed angle from a constant on its own',
    `${withHello.length} takes, ${distinct.size} distinct fx/fy: ${[...distinct].join(' ')}`);
  note('so the intrinsics claim below is driven on two arms that do not exist on disk',
    ARMS.slice(1).map((a) => `${a.name} fx=${a.intrinsics.fx} fy=${a.intrinsics.fy}`).join(', '));

  console.log('\n[1] the pose is the sensor\'s: the origin, looking down -Z');
  const poseRun = await onFreshPage('the pose', { }, async ({ page }) => {
    const before = await page.evaluate('globalThis.__sv.displace({})');
    const applied = await page.evaluate('globalThis.__sv.at("1920x1080")');
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
    // The falsification control: a `sensorView` that did nothing at all fails here.
    check(Math.hypot(...before.position) > 1 && before.fov !== returned.fov,
      'the camera was displaced first, so a button that did nothing cannot pass',
      `from [${before.position.map((v) => fixed(v, 2)).join(', ')}] fov ${fixed(before.fov, 1)}`);
    const residual = Math.hypot(...spunPose.position);
    check(spun.spin === true && spunPose.spin === false,
      'a press while the view is auto-orbiting switches the orbit off',
      `spin ${spun.spin} before, ${spunPose.spin} after`);
    check(residual < ORBIT_RESIDUAL,
      `and lands within ${ORBIT_RESIDUAL * 1000}mm of the origin, the damping residual being spent by the press`,
      `|position| = ${residual.toExponential(2)} m against the idle arm's ${Math.hypot(...pose.position).toExponential(2)}`);
  }

  console.log('\n[2] the angles come from the take\'s intrinsics, on three arms');

  const sizeRun = await onFreshPage('the export menu', { }, async ({ page }) =>
    page.evaluate('globalThis.__sv.sizes()'));
  if (!sizeRun.ok) throw new Error(`the size sweep did not run: ${sizeRun.error}`);
  const SHIPPED = sizeRun.value;
  note(`the export menu ships ${SHIPPED.length} sizes`,
    [...new Set(SHIPPED.map((s) => s.ratio))].join(', '));

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

  // The cross-arm row, which the three-arm shape exists for: a constant cannot pass it.
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
  // Judged from the frustum the page reports rather than from the formula that made it. `sV` and
  // `sH` are how many times wider the frustum is than the frame, so containment is both at least 1
  // and tightness is one of them being exactly 1 - containment alone a 179 degree frustum passes.
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
  check(sawVertical > 0 && sawHorizontal > 0,
    'the shipped sizes exercise both branches of the fit on the take\'s own intrinsics',
    `${sawVertical} vertical, ${sawHorizontal} horizontal of ${SHIPPED.length}`);

  // Navigation leaves no trace, and the observation is deliberately not one thing: the page's own
  // requests, the server's monotonic per-store counters, and the bodies of the stores. This answers
  // "is there an object here that every observation happens to skip".
  console.log('\n[4] pressing it writes nothing: no key, no undo entry, no document change');
  const beforeStores = await stores(PRIVATE_BASE);
  const writeRun = await onFreshPage('the writes-nothing arm', { }, async ({ page }) => {
    await page.evaluate('globalThis.__sv.at("1920x1080")');
    await page.evaluate('globalThis.__sv.settled()');
    await page.waitForTimeout(1200);
    const displaced = await page.evaluate('globalThis.__sv.displace({})');
    const before = await page.evaluate('globalThis.__sv.document()');
    await clickSensorView(page);
    await page.evaluate('globalThis.__sv.settled()');
    // The auto-save is fire-and-forget, so a read taken as the click resolves records a
    // pending absence.
    await page.waitForTimeout(1500);
    const after = await page.evaluate('globalThis.__sv.document()');
    const pose = await page.evaluate('globalThis.__sv.pose()');
    return { displaced, before, after, pose };
  });
  if (!writeRun.ok) throw new Error(`the writes-nothing arm did not run: ${writeRun.error}`);
  const afterStores = await stores(PRIVATE_BASE);
  {
    const { displaced, before, after, pose } = writeRun.value;
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

  // The recorder's intrinsics arrive over the socket, a different path through the same button.
  console.log('\n[5] the same button on the recorder, on the attached sensor\'s own hello');
  const recRun = await onFreshPage('the recorder arm', { path: RECORDER_PATH, base: URL_BASE }, async ({ page }) => {
    // The uniform block boots at exactly 366 and this sensor reports 366.031494.
    await page.waitForFunction('globalThis.__kinect.uniforms.focal.value.x !== 366', null, { timeout: HELLO_MS });
    const surface = await page.evaluate('globalThis.__sv.surface()');
    const displaced = await page.evaluate('globalThis.__sv.displace({})');
    // This arm runs against the shooting server, so "it wrote nothing" cannot compare that
    // server's stores.
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
    // No sensor, no claim: untested rather than failed, and the verdict says so.
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

  // The recorder surface had no committed check at all, and this is the only tool that drives both.
  // The claims are rules over every block in the panel rather than a list of ids, closing with:
  // everything the other rules do not name has to be reachable on both surfaces.
  console.log('\n[6] the recorder and the editor are different panels, in the ways claimed');
  // One walk, used by both surfaces, because an arm that walked its tabs differently would put a
  // difference in the instrument exactly where the claim is about the product. Filtered by
  // `checkVisibility`, since each surface hides one tab outright and clicking a zero-by-zero box
  // spends Playwright's thirty seconds and arrives as "the arm did not run".
  const walkTabs = async (page) => {
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
  // A package group is built only for an effect somebody has added, so both arms add every
  // installed effect through the rack dialog first: the rows below ask about reachability, not
  // rack membership.
  const rackEveryEffect = async (page) => {
    const racked = [];
    await page.click('#panelTabs [role="tab"][data-panel-tab="look"]');
    const door = await page.evaluate(`(() => {
      const b = document.getElementById('effectRackOpen');
      return b !== null && b.checkVisibility({ checkVisibilityCSS: true });
    })()`);
    if (!door) throw new Error('the rack door is not on this surface, so no package group can be added');
    if (await page.evaluate('document.getElementById("effectRackPanel").hidden')) {
      await page.click('#effectRackOpen');
    }
    for (let guard = 0; guard <= 40; guard += 1) {
      const next = await page.evaluate(`(() => {
        const add = document.querySelector('#effectRackList button[data-effect-add]');
        return add === null ? null : add.dataset.effectAdd;
      })()`);
      if (next === null) {
        await page.click('#effectRackClose');
        return racked;
      }
      await page.click(`#effectRackList button[data-effect-add="${next}"]`);
      racked.push(next);
    }
    throw new Error(`the rack still offered an effect after ${racked.length} were added: ${racked.join(' ')}`);
  };
  const panelRun = await onFreshPage('the panel arms', { }, async ({ page }) => {
    // Which groups the panel leaves open derives from the clip, so an ungraded take derives every
    // collapsible group shut and the row below has nothing left to ask about. One look parameter is
    // written off its default first and put back after, and the nudge is asserted
    // rather than trusted.
    const nudge = await page.evaluate(`(() => {
      const name = __kinect.params.names('look')[0];
      const was = __kinect.params.get(name);
      __kinect.params.set(name, was === 0 ? 1 : was * 1.7);
      return { name, was, now: __kinect.params.get(name) };
    })()`);
    const racked = await rackEveryEffect(page);
    const walked = await walkTabs(page);
    await page.evaluate(`__kinect.params.reset([${JSON.stringify(nudge.name)}])`);
    return { ...walked, nudge, racked };
  });
  const recPanelRun = await onFreshPage('the recorder panel arm', { path: RECORDER_PATH },
    async ({ page }) => { await rackEveryEffect(page); return walkTabs(page); });
  if (!panelRun.ok) throw new Error(`the editor panel arm did not run: ${panelRun.error}`);
  if (!recPanelRun.ok) throw new Error(`the recorder panel arm did not run: ${recPanelRun.error}`);
  {
    const edStates = panelRun.value.states;
    const recStates = recPanelRun.value.states;
    const recTabs = recPanelRun.value.tabs;
    /**
     * What a surface reaches, which is the union over the tabs it shows. The tab a surface happens
     * to open on is not the surface: reading one was how four rows came to describe a panel that
     * had stopped existing, measured on the one tab holding neither thing they claimed was absent.
     */
    const across = (states) => {
      const each = Object.values(states);
      const at = (state, key) => state.blocks.find((b) => b.key === key);
      return {
        ...each[0],
        blocks: each[0].blocks.map((block) => ({
          ...block,
          visible: each.some((state) => at(state, block.key)?.visible),
          controlsAvailable: Math.max(...each.map((state) => at(state, block.key)?.controlsAvailable ?? 0)),
          controlsOnScreen: Math.max(...each.map((state) => at(state, block.key)?.controlsOnScreen ?? 0)),
        })),
        recRange: each.some((state) => state.recRange),
      };
    };
    const ed = across(edStates);
    const rec = across(recStates);
    // Without this every visibility row below is about a function that returned undefined.
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
    const nudge = panelRun.value.nudge;
    check(nudge.now !== nudge.was,
      'the editor arm moved a look parameter off its default, so the collapse rule has something to leave open',
      `${nudge.name} ${nudge.was} -> ${nudge.now}`);

    check(rec.kfButtons === 0 && rec.keyed === 0,
      'the recorder has no keyframe control at all: a key is a position on a clip and it has none',
      `${rec.kfButtons} buttons in #panel, ${rec.keyed} of ${rec.lookNames} parameters carrying one`);
    check(ed.kfButtons === ed.lookNames && ed.keyed === ed.lookNames && ed.lookNames > 0,
      'and the editor has exactly one per look parameter, each sharing its parameter\'s row',
      `${ed.kfButtons} buttons and ${ed.keyed} rows against ${ed.lookNames} look parameters`);

    // The registry throws at boot when a look parameter has no control, so this asserts the throw.
    check(ed.missingControl.length === 0 && rec.missingControl.length === 0,
      'every look parameter has a panel control on both surfaces, hidden or not',
      `${ed.lookNames} parameters, missing on the editor [${ed.missingControl.join(' ')}], on the recorder [${rec.missingControl.join(' ')}]`);
    check(ed.lookNames === rec.lookNames && ed.blocks.length === rec.blocks.length,
      'and both surfaces are built from one registry and one panel',
      `${ed.lookNames}/${rec.lookNames} parameters, ${ed.blocks.length}/${rec.blocks.length} blocks`);

    // These were two lists of ids and the lists went stale twice. The mechanism they approximated
    // is one sentence: each surface hides exactly one inspector tab outright, and what it cannot
    // reach is exactly what lives on that tab - both halves measured, so a group added later is
    // asked by existing.
    const listed = (blocks) => blocks.map((b) => b.key);
    const cannotReach = (surface) => listed(surface.blocks.filter((b) => !b.visible));
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
    // Both sets have to be non-empty or the comparison is two empties agreeing.
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
    // Counted in controls as well as in headings: a group's node stays visible when the collapse
    // rule shuts it, so "9 look groups, all 9 visible" was true of a panel with four showing
    // nothing gradeable. The look groups are split by the `shut` class the panel itself sets and
    // both halves are asserted, so marking everything shut fails the floor and everything open
    // fails the controls.
    const sum = (list, key) => list.reduce((n, b) => n + b[key], 0);
    const hiddenTabBlocks = new Set([...recShould, ...edShould]);
    const recLook = rec.blocks.filter((b) => b.look && !hiddenTabBlocks.has(b.key));
    const edLook = ed.blocks.filter((b) => b.look && !hiddenTabBlocks.has(b.key));
    const edOpen = edLook.filter((b) => !b.shut);
    const edShut = edLook.filter((b) => b.shut);
    // This row said the grade was hidden on the recorder and now says the opposite -
    // a claim inverted.
    check(recLook.length > 0 && recLook.every((b) => b.visible),
      'the grade is reachable on the recorder too, through the tab the rework put it on',
      `${recLook.length} look groups off the hidden tab, ${recLook.filter((b) => b.visible).length} reachable, `
      + `unreachable [${recLook.filter((b) => !b.visible).map((b) => b.key).join(' ') || 'none'}]`);
    check(edLook.length > 0 && edLook.every((b) => b.visible)
      && edOpen.length > 0
      && edOpen.every((b) => b.controlsAvailable > 0 && b.controlsOnScreen === b.controlsAvailable)
      && edShut.every((b) => b.controlsOnScreen === 0),
      'and reachable through the editor inspectors, where grading is the job - measured in controls on screen rather than in headings',
      `${edLook.length} look groups, all ${edLook.filter((b) => b.visible).length} reachable, `
      + `${sum(edLook, 'controlsOnScreen')} of ${sum(edLook, 'controlsAvailable')} available controls on screen `
      + `(${sum(edLook, 'controls')} built); `
      + `${edOpen.length} left open by the collapse rule show ${sum(edOpen, 'controlsOnScreen')} of `
      + `${sum(edOpen, 'controlsAvailable')} available; shut by it: ${edShut.map((b) => b.key).join(' ') || 'none'}`);
    // The closer: everything the rules above do not name is common furniture and has to be on both.
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

    // "The recorder builds no keyframe control" is a claim about the surface rather than about what
    // happens to be on screen, so the count is asked at every tab.
    const kfTabs = recTabs.filter((id) => recStates[id].kfButtons > 0);
    check(recTabs.length > 0 && kfTabs.length === 0,
      'no inspector tab on the recorder builds a keyframe control, because there is still no clip',
      `${recTabs.length} tabs walked (${recTabs.join(' ')}), `
      + `keyframe controls under [${kfTabs.join(' ') || 'none'}]`);
    // The row above passes on a page where every click silently did nothing, so this is the
    // companion that makes the walk itself the thing under test.
    const lookVisible = recTabs.filter((id) => recStates[id].blocks.some((b) => b.look && b.visible));
    check(lookVisible.length > 0 && lookVisible.length < recTabs.length,
      '  and the walk moved the surface, so that count is a measurement rather than a page that ignored every click',
      `look groups visible under [${lookVisible.join(' ') || 'none'}] of ${recTabs.length} tabs`);
    check(rec.surface === 'record' && ed.surface === 'edit',
      'and each arm is the surface it claims, so neither table is about the other page',
      `${rec.surface} and ${ed.surface}`);
  }

  // Every section above asserts against the camera object, which is not what anybody presses the
  // button to see. Two things make the comparison mean anything, both found by measuring: the
  // overlay has to be off, since it redraws the frustum whether or not the picture did, and the
  // damping has to be drained, since two renders of one position genuinely differ while it holds.
  console.log('\n[7] the press puts the sensor\'s view on the screen, not only on the camera');
  const pictureRun = await onFreshPage('the picture arm', {}, async ({ page }) => {
    const overlayHidden = await page.evaluate('globalThis.__sv.hideChrome()');
    const drainedAfter = await page.evaluate('globalThis.__sv.drain()');
    const picture = await page.evaluate('globalThis.__sv.picture()');
    const clip = { x: picture.x, y: picture.y, width: picture.width, height: picture.height };

    await page.evaluate('globalThis.__sv.forceSeek()');
    const ctrlA = await page.screenshot({ clip });
    await page.evaluate('globalThis.__sv.forceSeek()');
    const ctrlB = await page.screenshot({ clip });

    const displaced = await page.evaluate('globalThis.__sv.displace({})');
    // Rendered, and load-bearing: `displace` asks for no image, so without this `before` is still
    // the boot camera's picture and the row below compares the default pose rather than
    // the displaced one.
    await page.evaluate('globalThis.__sv.forceSeek()');
    const before = await page.screenshot({ clip });
    const rendersBefore = await page.evaluate('globalThis.__sv.renders()');

    // The button, clicked, and then nothing at all - a person who presses it and sits still.
    await clickSensorView(page);
    await page.waitForTimeout(2000);
    const after = await page.screenshot({ clip });
    const rendersAfter = await page.evaluate('globalThis.__sv.renders()');
    const pose = await page.evaluate('globalThis.__sv.pose()');

    // The tightening row: the image the press produced is already the settled one.
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
    // The two conditions this comparison rests on, enforced rather than stated in a header.
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
  // A run that threw did not finish, which is a different answer from a claim that failed.
  crashed = err;
  console.log(`\n  ....  the run did not finish: ${err.message}`);
} finally {
  server?.kill('SIGKILL');
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n[sensor-view] ${checks} assertions, ${failures} failed`);
if (fired.length) {
  console.log('[sensor-view] the rows that fired:');
  for (const label of fired) console.log(`    - ${label}`);
}
if (crashed) {
  console.log(`[sensor-view] DID NOT RUN - ${crashed.message}. Nothing here is a finding: re-run it.`);
  process.exit(2);
}
if (untested) {
  console.log(`[sensor-view] UNTESTED - ${untested}. Attach the sensor, or read this as "some claims were not tested here".`);
  process.exit(2);
}
if (MUTATE) {
if (MUTATIONS[MUTATE]?.fails) console.log(`[sensor-view] it should redden: ${MUTATIONS[MUTATE].fails}`);
  // The exit code alone cannot tell a caught mutation from a tool that fell over before asserting.
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
