// Proves the timeline transport: that a seek lands where playback would have, that
// the pre-roll it costs is computed rather than assumed, and that an arbitrary
// output rate interpolates the capture instead of repeating it.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

// Resolved against this file rather than the working directory, so the tool can
// be run from anywhere the way the other two can.
const REPO = fileURLToPath(new URL('..', import.meta.url));

const URL_BASE = flag('--url', 'http://localhost:8080');
const TAKE = flag('--take', 'sample');
const HEADED = argv.includes('--headed');
const MUTATE = flag('--mutate');
const SAMPLES = Number(flag('--samples', '24'));
const WARMUP = Number(flag('--warmup', '4'));
const SHOTS = flag('--shots');

const STAGE = { width: 640, height: 360 };
const TIMELINE_H_GUESS = 148;

const SAME_MAX = 2;
const CONTROL_MIN = 16;
const CONTROL_MIN_PCT = 1.0;

// The isolating arm in section 7, which is a smaller signal than the no-pre-roll controls above
// because what it removes is the older half of one pass's history rather than every accumulator
// at once. Measured on this rig: 20/255 across 57.9% of the frame with the pass intact, and
// exactly 0 under `--mutate mosh-no-history`, so the separation is total and the floor only has
// to sit between them.
const MOSH_CUT_MIN = 12;
const MOSH_CUT_MIN_PCT = 10.0;

const RAIN_SAME_MAX = 2;
const RAIN_CONTROL_MIN = 64;
const RAIN_CONTROL_MIN_PCT = 0.8;
const RAIN_CONTROL_MIN_MEAN = 0.08;

const MUTATIONS = {
  // Every clip warms on the selected clip's persistence rather than on its own, so a take's
  // demand stops depending on what each clip cut on it actually asks for. Must redden section
  // 8b's rows and leave section 8's alone, where every clip carries the same look.
  'warm-reads-the-selection': { file: 'web/main.js', edits: [[
    `    const surfaceSec = (valueAtProgram('fade', this.start, this)
      + valueAtProgram('wake', this.start, this)) / 1000;`,
    `    const surfaceSec = (valueAtProgram('fade', this.start)
      + valueAtProgram('wake', this.start)) / 1000;`,
  ]],
    fails: 'every clip warming on the selected clip\'s persistence rather than on its own, so '
      + 'two clips at one instant stop differing in whether they touch the take there. '
      + 'Section 8b is the catch',
  },
  // The cache goes back to one constant however many clips share a take, which is what capped a
  // four-clip pre-roll at a quarter of what it computed. Must redden section 8's cache rows.
  'cache-is-a-constant': { file: 'web/main.js', edits: [[
    'const MAX_SPAN_FRAMES = CACHE_CEILING_FRAMES - CACHE_HEADROOM;',
    'const MAX_SPAN_FRAMES = CACHE_FRAMES - 16;',
  ]],
    fails: 'a take\'s cache back to one constant however many clips share it, which caps a '
      + 'four-clip pre-roll at 41 of the 60 frames it computed and an eight-clip one at 20. '
      + 'Section 8\'s cache rows are the catch, and it fires nine in all',
  },
  // A take outside the current plan keeps the demand and decoded frames of the last plan that
  // named it. Must redden section 8a's two release rows.
  'cache-keeps-absent-demand': { file: 'web/main.js', edits: [[
    `    for (const take of openTakes.values()) {
      if (load.has(take)) continue;
      take.setDemand(0);
    }`,
    '    /* mutation: absent takes keep the previous plan\'s demand */',
  ]],
    fails: 'a take outside the current plan keeping the demand and decoded frames of the last '
      + 'plan that named it. Section 8a\'s two release rows are the catch',
  },
  'prefetch-ignores-shared-take-demand': { file: 'web/main.js', edits: [[
    '    const fits = (spans) => [...this.frameLoad(spans).values()]\n'
      + '      .every((frames) => frames <= MAX_SPAN_FRAMES);',
    '    const fits = () => true;',
  ]],
    fails: 'prefetch keeping the full output horizon when the disjoint windows of eight clips '
      + 'overflow their shared take cache. Section 8c\'s bounded-plan row reddens alone',
  },
  // The pre-roll stops being a function of anything.
  'preroll-constant': { file: 'web/main.js', edits: [[
    'const frames = Math.max(surface, trails, back3.frames);',
    'const frames = 8;',
  ]] },
  // Nothing is rendered ahead of the target.
  'preroll-none': { file: 'web/main.js', edits: [[
    'let start = Math.max(0, target - asked);',
    'let start = target;',
  ]] },
  // A seek made after a later clip has started warming rebuilds none of the warm history already
  // elapsed. Must redden section 7f's equality and plan rows.
  'preroll-ignores-warming': { file: 'web/main.js', edits: [[
    `    for (const clip of clipsActiveAt(programSec)) {
      const showing = clipShowingAt(clip, programSec);`,
    `    for (const clip of clipsLiveAt(programSec)) {
      const showing = clipShowingAt(clip, programSec);`,
  ]],
    fails: 'a seek made inside a later clip\'s warm window rebuilding none of the warm history '
      + 'already elapsed. Section 7f\'s equality and plan rows are the catch',
  },
  // The clip's speed stops scaling its local time into source time.
  'rate-ignored': { file: 'web/clip-plan.js', edits: [[
    '  return sourceStart + localSec * speed;',
    '  return sourceStart + localSec;',
  ]] },
  'duplicate-frames': { file: 'web/main.js', edits: [[
    'const offset = Math.min(Math.max(sourceSec - times[i], 0), span);\n'
    + '    return { steps, mixT: offset / span, sinceFrameSec: offset, spanSec: span };',
    'const offset = Math.min(Math.max(sourceSec - times[i], 0), span);\n'
    + '    return { steps, mixT: Math.round(offset / span), sinceFrameSec: offset, spanSec: span };',
  ]] },
  // A draft stops bypassing the accumulators, so it inherits its history.
  'draft-keeps-accumulators': { file: 'web/main.js', edits: [[
    '    params.apply(BYPASS_ZERO);',
    '    /* mutation: the bypass is skipped */',
  ]] },
  'draft-always-resets': { file: 'web/main.js', edits: [[
    'const standing = target === this.frame && this.standingAt(t);',
    'const standing = false;',
  ]] },
  // The accumulators are not cleared before a pre-roll.
  'no-reset': { file: 'web/main.js', edits: [[
    '  clearFeedback(\n'
    + '    [...clipStateTargets(), afterimage._textureComp, afterimage._textureOld, ...mosh.history],\n'
    + "    'afterimage internals moved: the accumulator reset is no longer complete',\n"
    + '  );',
    '  /* mutation: accumulator reset skipped */',
  ]] },
  // The mosh pass stops reading the frame it drew last time, so it displaces the picture in
  // front of it instead of holding one back. A seek still equals a playback - there is nothing
  // to reproduce - and the control arm that renders with no pre-roll at all stops being able to
  // tell itself apart from the playback, which is the row that says the feedback is real.
  'mosh-no-history': { file: 'effects-builtin/datamosh/mosh.mosh.glsl', edits: [[
    'vec3 held = texture2D(tOld, vUv - vec2(0.0, reach * texel.y)).rgb * moshDecay;',
    'vec3 held = texture2D(tNew, vUv - vec2(0.0, reach * texel.y)).rgb * moshDecay;',
  ]] },
  // The refresh never fires on its period, so the memory has no ceiling: the pre-roll decodes
  // from a frame that was never a keyframe and lands somewhere playback never was.
  'mosh-never-refreshes': { file: 'web/main.js', edits: [[
    `    mosh.uniforms.moshIFrame.value = (moshFresh || !moshWasLive
      || (moshCycles && moshRefreshes(lastProgramTime, lastMoshPeriod, t, moshPeriod))) ? 1 : 0;`,
    '    mosh.uniforms.moshIFrame.value = (moshFresh || !moshWasLive) ? 1 : 0;',
  ]] },
  // The mosh contributes nothing to the pre-roll, so the seek starts wherever the surface memory
  // and the trails happen to want, and the smear arrives with the wrong history behind it.
  'mosh-preroll-zero': { file: 'web/main.js', edits: [[
    '    const back3 = this.moshFramesBack(programSec);',
    '    const back3 = { frames: 0, covered: true };',
  ]] },
  'age-clamp-low': { file: 'web/surface-memory.js', edits: [
    ['const MAX_AGE = 6.0;', 'const MAX_AGE = 4.0;'],
    ['  if (MAX_AGE < longestLife) {', '  if (false) {'],
  ] },
  // The registry stops announcing its writes, so a slider moved while the
  // playhead is parked changes neither the image nor the estimate.
  'no-repaint': { file: 'web/main.js', edits: [[
    '    paramWritten(name, spec.tag);',
    '    /* mutation: the write is not announced */',
  ]] },
  // The mode stops asking for one, so selecting a reading of the footage that
  // writes no parameter leaves the previous one on screen.
  'reading-write-skips-repaint': { file: 'web/main.js', edits: [[
    '    paramWritten(name, spec.tag);',
    '    if (!PARAMS[name].reading) paramWritten(name, spec.tag);',
  ]] },
  'rain-accumulates': { file: 'web/main.js', edits: [[
    '      uniforms.rainPhase.value = local;',
    '      uniforms.rainPhase.value += 1 / 30;',
  ]],
    fails: 'the rain integrated frame to frame, so a seek lands where playback never would. Its '
      + 'section applies a rain-raised look of its own, because every other arm in that file '
      + 'renders the term completely inert',
  },
  // A clip is shown the instant it starts, with whatever its ping-pong pair last drew still in
  // it. Section 7's entry rows are the only ones that can see it: with one clip there is no cut.
  'warm-skipped': { file: 'web/main.js', edits: [[
    "  return t >= clip.start - warmSec - CLIP_EDGE ? 'warming' : 'off';",
    "  return 'off';",
  ]],
    fails: 'a clip shown the instant it starts, with whatever its pair last drew still in it. '
      + 'Both arms lose it together, so the entry equality stays green: what reddens is the '
      + 'surface-memory reading and the counters',
  },
  // A clip warms and is shown without ever being put back to nothing, so it builds on whatever
  // its ping-pong pair last held. Both clears go, because on every path this build can reach the
  // reset clears the pair a moment before the entry does and either one alone still leaves it
  // empty.
  'warm-without-reset': { file: 'web/main.js', edits: [
    [
      '  clearFeedback(\n'
      + '    [statePrev, stateNext],\n'
      + "    'the surface memory moved: a clip can no longer be cleared on the frame it enters',\n"
      + '  );',
      '  /* mutation: the clip keeps whatever it last drew */',
    ],
    [
      '    [...clipStateTargets(), afterimage._textureComp, afterimage._textureOld, ...mosh.history],',
      '    [afterimage._textureComp, afterimage._textureOld, ...mosh.history],',
    ],
  ],
    fails: 'a clip warmed and shown without ever being put back to nothing. Removes both clears, '
      + 'because either one alone still leaves the pair empty on every path this build can '
      + 'reach',
  },
  // Every clip is written the first clip's look, which is the union `checkProject` used to build
  // and the silent wrong render that made a clip's look its own.
  'look-broadcast': { file: 'web/main.js', edits: [[
    '      params.apply(planned.look.applied);',
    '      params.apply(plan.clips[0].look.applied);',
  ]],
    fails: 'every clip written the first clip\'s look, which is the union `checkProject` used to '
      + 'build and the silent wrong render that made a clip\'s look its own',
  },
  // A clip value at a program position is read off the selected clip rather than off the clip
  // being asked about, so one clip's persistence decides every clip's pre-roll.
  'clip-look-reads-selection': { file: 'web/main.js', edits: [[
    "  const on = spec.scope === 'clip' ? (clip ?? clipOfLook()) : null;\n  const look = on ? on.look : homeOf(spec);",
    '  const on = null;\n  const look = homeOf(spec);',
  ]],
    fails: 'a clip value read off the selected clip rather than the clip being asked about, so '
      + 'one clip\'s persistence decides every clip\'s pre-roll',
  },
  // Draw order comes off the array rather than off the clip ids, so one document composites
  // differently depending on the order its clips happen to be listed in.
  'draw-order-by-array': { file: 'web/main.js', edits: [[
    '  for (const [at, clip] of order.entries()) clip.points.renderOrder = at;',
    '  for (const [at, clip] of clips.entries()) clip.points.renderOrder = at;',
  ]],
    fails: 'draw order off the array rather than the clip ids, so one document composites '
      + 'differently depending on the order its clips happen to be listed in',
  },
  // Every clip opens its own copy of its take, so two clips of one take carry two indexes, two
  // caches and two decodes of every frame they both want.
  'take-not-shared': { file: 'web/main.js', edits: [[
    '  const take = openTakes.get(id) ?? await IndexedTake.open(id);',
    '  const take = await IndexedTake.open(id);',
  ]],
    fails: 'every clip opening its own copy of its take, so two clips of one take carry two '
      + 'indexes, two caches and two decodes of every frame they both want',
  },
  'rain-phase-unread': { file: 'effects-builtin/rain/cell.vert.glsl', edits: [[
    '    vRain = (rainPhase * rainSpeed + room.y) / rainSpan + hash(dot(wc.xz, vec2(269.5, 183.3)));',
    '    vRain = (0.0 * rainSpeed + room.y) / rainSpan + hash(dot(wc.xz, vec2(269.5, 183.3)));',
  ]],
    fails: 'and the same clock written correctly and read by nothing, which both arms agree '
      + 'about perfectly. It is the control for the guard rather than for the claim: what '
      + 'reddens is the row that moves the clock alone under a still frame',
  },
};

// Returned with its file rather than as a bare string so the caller can install the
// route for the right URL and, below, refuse when that URL is never asked for.
function mutatedSource() {
  const spec = MUTATIONS[MUTATE];
  if (!spec) {
    throw new Error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  }
  let source = readFileSync(join(REPO, spec.file), 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`mutation ${MUTATE} matched ${hits} times in ${spec.file}, expected exactly 1: ${from}`);
    }
    source = source.replace(from, to);
  }
  return { file: spec.file, body: source };
}

/**
 * Where a file under `web/` is reached from a browser.
 */
function servedAt(file) {
  if (file.startsWith('effects-builtin/')) {
    const parts = file.split('/');
    if (parts.length !== 3) {
      throw new Error(`${file} is not an effect package file - a chunk is <id>/<name> under effects-builtin/`);
    }
    return `/effects/${parts[1]}/file/${parts[2]}`;
  }
  if (!file.startsWith('web/')) {
    throw new Error(`${file} is not served to a browser, so a page mutation cannot reach it`);
  }
  return `/${file.slice('web/'.length)}`;
}

function contentTypeFor(file) {
  return file.endsWith('.glsl') ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8';
}


// Playwright is not a dependency of this project - it is a tool the proofs reach
// for - so it is resolved from wherever it happens to be installed.
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


const index = await (await fetch(`${URL_BASE}/capture/${TAKE}/index`)).json();
const stamps = index.frames.stampMs;
const TIMES = stamps.map((s) => (s - stamps[0]) / 1000);
const DURATION = TIMES[TIMES.length - 1];
const NEEDS_TAKE_SEC = 12;

if (!(DURATION >= NEEDS_TAKE_SEC)) {
  console.log(`\n[timeline] DID NOT RUN - the take "${TAKE}" holds ${DURATION.toFixed(2)}s of source and `
    + `these rows need ${NEEDS_TAKE_SEC}s. Point --take at a longer capture `
    + '(tools/make-fixture.js loops a short one).');
  process.exit(2);
}

function bracketOf(sourceSec) {
  let lo = 0;
  let hi = TIMES.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (TIMES[mid] <= sourceSec) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

const pct = (xs, p) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const ms = (x) => `${x.toFixed(2)} ms`;

let assertions = 0;
let failures = 0;
const check = (ok, label, detail = '') => {
  assertions++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
  if (!ok) failures++;
};

// Pixels never cross back over the wire - a 640x360 frame is most of a megabyte
// and there are dozens per run - so every comparison is made in the page and only
// its summary comes back.
const INSTALL = `(() => {
  const k = globalThis.__kinect;
  globalThis.__tl = {
    shots: new Map(),

    async sha(bytes) {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    },

    // The free camera is what the viewport draws, and OrbitControls mutates it by
    // accumulation, so it is pinned identically at the head of every arm and read
    // back at the tail of each. If it ever drifted the images would differ for a
    // reason that has nothing to do with the transport, and the check would blame
    // the wrong thing.
    pinCamera() {
      const cam = k.freeCamera;
      k.controls.target.set(0, 0, -2.2);
      cam.position.set(0, 0.1, 1.6);
      cam.lookAt(0, 0, -2.2);
      k.controls.update(0);
      cam.updateMatrixWorld(true);
    },

    camera() {
      return [...k.freeCamera.position.toArray(), ...k.freeCamera.quaternion.toArray()]
        .map((v) => v.toFixed(9)).join(',');
    },

    // Awaits the transport going idle, because applying a look schedules a repaint
    // and a check that measured through one would be counting renders it did not
    // ask for.
    //
    // A mode used to be a second argument here, applied through setMode before the
    // look. It is gone rather than translated: a reading is a look value now, so it
    // arrives inside the look with everything else, and a separate door for it would
    // be a second write path to the same thing.
    async configure({ look, rate, fps }) {
      if (look) k.params.apply(look);
      k.keyframes.setSpeed(rate);
      k.timeline.transport().outputFps = fps;
      this.pinCamera();
      await k.timeline.settled();
      this.pinCamera();
    },

    counters() { return { ...k.timeline.counters }; },

    since(before) {
      const now = this.counters();
      return Object.fromEntries(Object.keys(now).map((key) => [key, now[key] - before[key]]));
    },

    // Must run in the same task as the render that produced the buffer: nothing
    // preserves it across a paint.
    grab(label) {
      const pixels = k.drive.readPixels();
      this.shots.set(label, pixels);
      return pixels;
    },

    brightest(label) {
      const px = this.shots.get(label);
      let max = 0;
      for (let i = 0; i < px.length; i += 4) {
        const d = Math.max(px[i], px[i + 1], px[i + 2]);
        if (d > max) max = d;
      }
      return max;
    },

    diff(a, b) {
      const x = this.shots.get(a);
      const y = this.shots.get(b);
      if (!x || !y) throw new Error('missing shot ' + (x ? b : a));
      let max = 0;
      let sum = 0;
      let differing = 0;
      for (let i = 0; i < x.length; i += 4) {
        const d = Math.max(
          Math.abs(x[i] - y[i]), Math.abs(x[i + 1] - y[i + 1]), Math.abs(x[i + 2] - y[i + 2]),
        );
        if (d > 0) {
          differing++;
          sum += d;
          if (d > max) max = d;
        }
      }
      const pixels = x.length / 4;
      return { max, mean: sum / pixels, differing, pixels, pct: (differing / pixels) * 100 };
    },
  };
  return true;
})()`;

// One arm: configure, reach a program position one of the two ways, read the
// image back. Everything the verdict rests on comes back with it - the counters
// the arm actually moved, the camera it ended on, and what the transport says
// about the seek it ran.
const ARM = `async (opts) => {
  const k = globalThis.__kinect;
  const tl = globalThis.__tl;
  const t = k.timeline.transport();
  await tl.configure(opts);

  const before = tl.counters();
  const rainPhaseBefore = k.uniforms.rainPhase.value;
  let seek = null;
  if (opts.kind === 'playback') {
    // From the head of the edit, every output frame in order.
    await t.seek(0);
    await t.runTo(t.frameAt(opts.targetSec));
  } else {
    seek = await t.seek(opts.targetSec, opts.frames === null ? {} : { frames: opts.frames });
  }
  const pixels = tl.grab(opts.label);
  return {
    hash: await tl.sha(pixels),
    delta: tl.since(before),
    camera: tl.camera(),
    seek,
    // The rain's clock, read at both ends of the arm rather than once at the end of the
    // section. Read once, it is a fact about whatever ran last: the phase is a uniform that
    // persists across arms, so a build integrating it per render arrives at the target
    // carrying everything every earlier arm drew, and a section that reads it after three
    // arms cannot say which of them put it there. Read per arm, the claim is per arm - this
    // one reached this program time and the phase says so, whatever it inherited.
    rainPhaseBefore,
    rainPhaseAfter: k.uniforms.rainPhase.value,
    state: k.timeline.read(),
  };
}`;


const { chromium } = await loadPlaywright();
// The full chromium build rather than the headless shell: the shell can land on
// SwiftShader, which has no EXT_color_buffer_float, and a run that silently fell
// back to a software rasteriser would agree with itself for the wrong reason.
const browser = await chromium.launch({ channel: 'chromium', headless: !HEADED });
const context = await browser.newContext({
  viewport: { width: STAGE.width, height: STAGE.height + TIMELINE_H_GUESS },
  deviceScaleFactor: 1,
});

await context.addInitScript(() => localStorage.setItem('braindance.preview.auto', 'off'));
const page = await context.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
page.on('response', (res) => { if (!res.ok()) errors.push(`${res.status()} ${res.url()}`); });
// The rejection is caught rather than left floating. A `fulfill` that loses its race - the page
// gone, the request already answered - rejects with nobody holding it, node takes an unhandled
// rejection as fatal, and the run dies mid-evaluate reporting `Resulting promise was garbage
// collected` with zero failed assertions on a non-zero exit.
await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }).catch(() => {}));

let mutantServed = 0;
let mutantPath = null;
if (MUTATE) {
  const { file, body } = mutatedSource();
  mutantPath = servedAt(file);
  await page.route((url) => url.pathname === mutantPath, (route) => {
    mutantServed++;
    route.fulfill({ contentType: contentTypeFor(file), body }).catch(() => {});
  });
  console.log(`[timeline] MUTATED BUILD: ${MUTATE} in ${file} at ${mutantPath} - this run is expected to FAIL`);
}

await page.goto(`${URL_BASE}/edit?take=${encodeURIComponent(TAKE)}`, { waitUntil: 'load' });
await page.waitForFunction(() => !!globalThis.__kinect);

if (MUTATE && mutantServed === 0) {
  console.log(`\n[timeline] DID NOT RUN - ${MUTATE} was staged for ${mutantPath} and the page never `
    + 'requested it, so this run would have measured the unmutated build');
  process.exit(2);
}
await page.evaluate('globalThis.__kinect.setOutputSize?.("640x360")');
await page.waitForFunction(() => !!globalThis.__kinect.timeline.transport(), null, { timeout: 20000 });
// The lane stack is built when the open finishes, not when the transport appears, and a strip
// measured before it has its rows grows under the viewport that was just sized to it. The loop
// below cannot recover from that on its own: it breaks out the moment the buffer matches, and a
// pre-lane measurement can match. So the open is waited for first, and the loop is left in place
// for the resize itself.
await page.waitForFunction(() => globalThis.__kinect.takeOpened(), null, { timeout: 60000 });
// Twelve attempts and not three, measured rather than chosen. The strip is a proportion of the
// window rather than a fixed height, so `360 + strip + shell` is a fixed point this loop has to
// converge on: the strip grows every time the viewport does, and each pass closes about two
// thirds of what is left. Probed on this rig from a 640x464 viewport, the buffer walks
// 270x152, 510x287, 594x334, 624x351, 635x357, 638x359 and reaches 640x360 on the seventh
// pass. At three it stopped at 626x352 and the guard below threw before the first assertion -
// on this branch and on a `git archive HEAD` tree alike, so it was never a regression and the
// only thing wrong was the iteration count.
for (let attempt = 0; attempt < 12; attempt++) {
  await page.evaluate('globalThis.__kinect.timeline.settled()').catch(() => {});
  const furniture = await page.evaluate(`(() => {
    const strip = document.getElementById('timeline');
    const appBar = document.getElementById('appBar');
    return {
      strip: strip && !strip.hidden ? Math.round(strip.getBoundingClientRect().height) : 0,
      shell: appBar && !appBar.hidden ? Math.round(appBar.getBoundingClientRect().height) : 0,
    };
  })()`);
  await page.setViewportSize({
    width: STAGE.width,
    height: STAGE.height + furniture.strip + furniture.shell,
  });
  // The predicate answers *false* on a page with no renderer rather than throwing, because
  // a throw inside `waitForFunction` is not caught by it: the twenty seconds a wait is
  // given are never spent, and the failure arrives instantly wearing the shape of a
  // finding.
  const landed = await page.waitForFunction((want) => {
    const gl = globalThis.__kinect?.renderer?.getContext?.();
    return !!gl && gl.drawingBufferWidth === want.w && gl.drawingBufferHeight === want.h;
  }, { w: STAGE.width, h: STAGE.height }, { timeout: 15000 }).then(() => true).catch(() => false);
  if (landed) break;
}
await page.evaluate(INSTALL);

const gpu = await page.evaluate(() => {
  const gl = globalThis.__kinect.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    colorBufferFloat: !!gl.getExtension('EXT_color_buffer_float'),
    buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
  };
});
if (/swiftshader|software|llvmpipe/i.test(gpu.renderer)) {
  throw new Error(`software rasteriser (${gpu.renderer}) - the result would prove nothing`);
}
if (!gpu.colorBufferFloat) throw new Error('no EXT_color_buffer_float: the surface memory is not running at float');
if (gpu.buffer[0] !== STAGE.width || gpu.buffer[1] !== STAGE.height) {
  throw new Error(
    `the stage came out ${gpu.buffer.join('x')} and this file's figures are ${STAGE.width}x${STAGE.height}: `
    + 'the strip height or the letterbox moved and every number below would be measured somewhere else',
  );
}

console.log(`[timeline] ${gpu.renderer}`);
console.log(`[timeline] stage ${gpu.buffer.join('x')}, take ${TAKE}: ${TIMES.length} frames, `
  + `${DURATION.toFixed(2)}s source, median gap ${(() => {
    const g = TIMES.slice(1).map((t, i) => t - TIMES[i]).sort((a, b) => a - b);
    return (g[g.length >> 1] * 1000).toFixed(0);
  })()}ms (${((TIMES.length - 1) / DURATION).toFixed(2)} fps mean)`);

const BLACKWALL_LOOK = JSON.parse(
  readFileSync(new URL('../presets-builtin/blackwall.json', import.meta.url), 'utf8'),
).values;
await page.evaluate(`globalThis.__kinect.applyPreset(${JSON.stringify(BLACKWALL_LOOK)})`);
const DEPTH_LOOK = JSON.parse(
  readFileSync(new URL('../presets-builtin/depth.json', import.meta.url), 'utf8'),
).values;
const RGB_LOOK = JSON.parse(
  readFileSync(new URL('../presets-builtin/rgb.json', import.meta.url), 'utf8'),
).values;
const BLACKWALL = { look: BLACKWALL_LOOK };

// Blackwall with the datamosh raised, stated here rather than read off a document: MOSH_SHORT_BY
// and the band beside it were measured against these exact values, so a document swapped in
// underneath would move the numbers this section asserts without touching the assertion.
const MOSH_LOOK = {
  ...BLACKWALL_LOOK,
  'datamosh.amount': 1,
  'datamosh.reach': 14,
  'datamosh.decay': 0.88,
  'datamosh.splay': 1,
  'datamosh.line': 0.55,
  'datamosh.grain': 3,
  'datamosh.cycleRefresh': true,
  'datamosh.refresh': 1.2,
};

const CASCADE_PATH = new URL('../presets-builtin/cascade.json', import.meta.url);
const CASCADE_SHIPPED = existsSync(CASCADE_PATH)
  ? JSON.parse(readFileSync(CASCADE_PATH, 'utf8')).values
  : { ...BLACKWALL_LOOK, 'rain.amount': 0.8, 'rain.speed': 0.55, 'rain.span': 1.3, 'rain.trail': 0.45 };

const CASCADE_LOOK = {
  ...CASCADE_SHIPPED,
  trails: BLACKWALL_LOOK.trails,
  cell: (CASCADE_SHIPPED.cell ?? 0.055) * 3,
};

// What a take's cache is sized against, read off the page rather than restated here: the
// ceiling is derived from a memory budget and a copy of the number it comes to would drift.
const CACHE = await page.evaluate(() => globalThis.__kinect.timeline.cache());
const CLIP_CEILING = await page.evaluate(() => globalThis.__kinect.library.CLIP_CEILING);

const arm = (opts) => page.evaluate(`(${ARM})(${JSON.stringify(opts)})`);
const diff = (a, b) => page.evaluate(`globalThis.__tl.diff(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
const show = (d) => `max ${d.max}/255, mean ${d.mean.toFixed(4)}, ${d.pct.toFixed(3)}% of pixels differ`;


console.log('\n== 1. the same program position, reached two ways ==');
const TARGET_SEC = NEEDS_TAKE_SEC;
{
  const config = { ...BLACKWALL, rate: 1, fps: 30, targetSec: TARGET_SEC, frames: null };
  const played = await arm({ ...config, kind: 'playback', label: 'played' });
  const seeked = await arm({ ...config, kind: 'seek', label: 'seeked' });
  const control = await arm({ ...config, kind: 'seek', frames: 0, label: 'control' });

  const plan = seeked.seek.plan;
  console.log(`  method: Blackwall, rate 1.00x, 30 fps out, target ${TARGET_SEC}s = output frame `
    + `${seeked.seek.target}. Pre-roll computed at ${plan.frames} frames `
    + `(surface ${plan.surface}, trails ${plan.trails}).`);
  console.log(`  playback rendered ${played.delta.renders} output frames and advanced the surface `
    + `memory ${played.delta.stateAdvances} times; the seek rendered ${seeked.delta.renders} and `
    + `advanced it ${seeked.delta.stateAdvances}; the control rendered ${control.delta.renders}.`);

  // The arms have to have done visibly different work, or "identical" is a
  // statement about one arm run twice.
  check(played.delta.renders === seeked.seek.target + 1,
    'playback rendered every output frame from the start of the edit',
    `${played.delta.renders} of ${seeked.seek.target + 1}`);
  check(seeked.delta.renders === plan.frames + 1,
    'the seek rendered the pre-roll and the target and nothing else',
    `${seeked.delta.renders} of ${plan.frames + 1}`);
  check(seeked.delta.resets === 1, 'the seek cleared both accumulators exactly once',
    `${seeked.delta.resets} resets`);
  check(seeked.seek.clamped === false, 'the pre-roll was not clipped by the head of the take',
    `start ${seeked.seek.start}, target ${seeked.seek.target}`);
  check(played.delta.renders > seeked.delta.renders * 4,
    'the two arms did substantially different amounts of work');
  check(played.camera === seeked.camera && played.camera === control.camera,
    'the camera is identical across all three arms', played.camera === seeked.camera ? '' : 'navigation drifted');

  const same = await diff('played', 'seeked');
  const apart = await diff('played', 'control');
  console.log(`\n  playback vs seek       ${show(same)}${same.max === 0 ? '  (byte-identical)' : ''}`);
  console.log(`  playback vs no pre-roll ${show(apart)}`);

  check(same.max <= SAME_MAX, `a seek lands within ${SAME_MAX}/255 of the playback`, show(same));
  check(apart.max >= CONTROL_MIN && apart.pct >= CONTROL_MIN_PCT,
    'the control lands somewhere else, so the equality above is about something',
    show(apart));
  check(apart.max > same.max * 8 + 8, 'the two verdicts are separated rather than adjacent',
    `control max ${apart.max} against ${same.max}`);
}


console.log('\n== 1b. clearing the accumulators empties both of them ==');
{
  const cleared = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const tl = globalThis.__tl;
    const t = k.timeline.transport();
    await tl.configure(${JSON.stringify({ look: BLACKWALL_LOOK, rate: 1, fps: 30 })});
    await t.seek(${TARGET_SEC});
    const before = k.stateStats();

    // Every point clipped away, so the cloud contributes nothing and whatever
    // comes out of the chain is the feedback paths on their own.
    k.params.apply({ near: 9.5, far: 9.5 });
    k.renderProgramFrame(t.programSec);
    tl.grab('stale');
    const stale = tl.brightest('stale');

    k.resetAccumulators();
    const after = k.stateStats();
    k.renderProgramFrame(t.programSec);
    tl.grab('blank');
    const blank = tl.brightest('blank');

    k.params.apply({ near: 0.05, far: 6 });
    return { before, after, stale, blank };
  })()`);

  console.log(`  surface memory: ${cleared.before.ghostsDrawn}% of pixels ghosting before the clear, `
    + `${cleared.after.ghostsDrawn}% after, and ${cleared.after.swappedLast50ms}% at age zero`);
  console.log(`  afterimage, rendered with every point clipped away: brightest channel `
    + `${cleared.stale}/255 before the clear, ${cleared.blank}/255 after`);
  check(cleared.before.ghostsDrawn > 0 && cleared.stale >= 48,
    'the control holds: both paths were carrying an image beforehand',
    `${cleared.before.ghostsDrawn}% ghosting, ${cleared.stale}/255`);
  check(cleared.after.ghostsDrawn === 0 && cleared.after.swappedLast50ms === 100,
    'the surface memory is empty afterwards');
  check(cleared.blank <= 16, 'and so is the afterimage', `${cleared.blank}/255`);
}


console.log('\n== 1c. the image at a program position is the frame the index names ==');
{
  // Depth mode with interpolation off, so the image is a function of the current
  // depth texture and nothing else - no colour, no blend against the previous
  // frame, no age term, no clock.
  const FLAT = { ...DEPTH_LOOK, fade: 0, wake: 0, trails: 0, bloom: 0, 'glitch.amount': 0, 'blackwall.scan': 0, 'noise.amount': 0, 'rgbsplit.amount': 0, 'raster.amount': 0, 'grain.amount': 0, 'vignette.amount': 0, 'duotone.amount': 0 };
  const look = { ...FLAT, interpolate: false };
  const PAIR = 100;
  const CURRENT = PAIR + 1;
  const sourceSec = TIMES[PAIR] + (TIMES[PAIR + 1] - TIMES[PAIR]) * 0.25;
  const programSec = sourceSec; // rate 1

  const golden = `async (n) => {
    const k = globalThis.__kinect;
    const tl = globalThis.__tl;
    // A bare request, not the source's cache: a shared fetch path could hand both
    // arms the same wrong frame.
    const buf = await (await fetch('/capture/${TAKE}/frame/' + n)).arrayBuffer();
    const depthBytes = new DataView(buf).getUint32(0, true);
    k.drive.injectDepth(new Uint16Array(buf.slice(16, 16 + depthBytes)));
    k.renderer.render(k.scene, k.viewCamera());
    return tl.sha(tl.grab('golden-' + n));
  }`;

  await page.evaluate(`globalThis.__tl.configure(${JSON.stringify({ look, rate: 1, fps: 30 })})`);
  const reached = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    await t.seek(${programSec});
    return { applied: t.clip.source.applied, hash: await globalThis.__tl.sha(globalThis.__tl.grab('reached')) };
  })()`);
  await page.evaluate(`(${golden})(${CURRENT})`);
  await page.evaluate(`(${golden})(${CURRENT - 1})`);

  const match = await diff('reached', `golden-${CURRENT}`);
  const neighbour = await diff('reached', `golden-${CURRENT - 1}`);
  console.log(`  source ${sourceSec.toFixed(4)}s brackets frames ${PAIR}/${PAIR + 1} by this tool's own `
    + `parse of the index; the page walked through frame ${reached.applied}`);
  console.log(`  against frame ${CURRENT}'s bytes pushed straight into the texture: ${show(match)}`);
  console.log(`  against its neighbour frame ${CURRENT - 1}: ${show(neighbour)}`);
  check(reached.applied === CURRENT, 'the walk consumed the frame the index says it should',
    `${reached.applied} against ${CURRENT}`);
  check(match.max === 0, 'and the pixels are the ones that frame\'s bytes produce', show(match));
  check(neighbour.max > SAME_MAX,
    'while the neighbouring frame produces a different image, so this can tell them apart',
    show(neighbour));
}


console.log('\n== 1d. the timeline binds colour, not just depth ==');
{
  const state = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    await globalThis.__tl.configure(${JSON.stringify({ look: RGB_LOOK, rate: 1, fps: 30 })});
    await k.timeline.transport().seek(${TARGET_SEC});
    return k.timeline.read();
  })()`);
  // Asserted because nothing else here would notice its absence: every comparison
  // is between two arms of the same page, so a timeline that never bound a JPEG
  // would pass all of them with both arms rendering grey.
  console.log(`  hasColor reads ${state.hasColor} after a seek to ${TARGET_SEC}s in RGB mode`);
  check(state.hasColor === 1, 'a decoded colour frame is bound after a seek');
}


console.log('\n== 2. pre-roll length is a function of fade, wake, damp and output fps ==');
const PREROLL_CASES = [
  { label: 'Blackwall, 30 fps, 1.00x', look: {}, rate: 1, fps: 30 },
  { label: 'Blackwall, 60 fps, 1.00x', look: {}, rate: 1, fps: 60 },
  { label: 'Blackwall, 30 fps, 0.50x', look: {}, rate: 0.5, fps: 30 },
  { label: 'trails 0.95, 30 fps, 1.00x', look: { trails: 0.95 }, rate: 1, fps: 30 },
  { label: 'trails 0.95, 60 fps, 1.00x', look: { trails: 0.95 }, rate: 1, fps: 60 },
  { label: 'trails 0, wake 0, 30 fps', look: { trails: 0, wake: 0 }, rate: 1, fps: 30 },
];
const plans = [];
{
  console.log('  method: read straight off the transport after configuring it, so what is');
  console.log('  tabulated is what a seek at that setting would actually run.');
  console.log('\n  configuration                surface  trails  = frames   program s');
  for (const c of PREROLL_CASES) {
    const plan = await page.evaluate(`(async (o) => {
      const k = globalThis.__kinect;
      await globalThis.__tl.configure(o);
      return k.timeline.transport().preroll(${TARGET_SEC});
    })(${JSON.stringify({ look: { ...BLACKWALL_LOOK, ...c.look }, rate: c.rate, fps: c.fps })})`);
    plans.push({ ...c, plan });
    console.log(`  ${c.label.padEnd(28)} ${String(plan.surface).padStart(6)}  `
      + `${String(plan.trails).padStart(6)}  ${String(plan.frames).padStart(8)}   ${plan.sec.toFixed(3)}`);
  }

  const at = (label) => plans.find((p) => p.label === label).plan;
  check(at('Blackwall, 30 fps, 1.00x').trails !== at('trails 0.95, 30 fps, 1.00x').trails,
    'the afterimage half moves with damp',
    `${at('Blackwall, 30 fps, 1.00x').trails} at 0.5 against ${at('trails 0.95, 30 fps, 1.00x').trails} at 0.95`);
  check(at('Blackwall, 30 fps, 1.00x').surface !== at('Blackwall, 60 fps, 1.00x').surface,
    'the fade-and-wake half moves with output frame rate',
    `${at('Blackwall, 30 fps, 1.00x').surface} at 30 fps against ${at('Blackwall, 60 fps, 1.00x').surface} at 60`);
  check(at('Blackwall, 30 fps, 1.00x').surface !== at('Blackwall, 30 fps, 0.50x').surface,
    'and with the clip speed, because fade and wake are source milliseconds',
    `${at('Blackwall, 30 fps, 1.00x').surface} at 1.00x against ${at('Blackwall, 30 fps, 0.50x').surface} at 0.50x`);
  check(at('trails 0, wake 0, 30 fps').frames < at('Blackwall, 30 fps, 1.00x').frames,
    'a look with less to remember costs less to seek to',
    `${at('trails 0, wake 0, 30 fps').frames} against ${at('Blackwall, 30 fps, 1.00x').frames}`);
  check(new Set(plans.map((p) => p.plan.frames)).size >= 4,
    'the six configurations do not all produce one number',
    `${new Set(plans.map((p) => p.plan.frames)).size} distinct lengths`);
}


async function smallestSufficient(config, played, ceiling) {
  const test = async (frames) => {
    await arm({ ...config, kind: 'seek', frames, label: 'bisect' });
    return (await diff(played, 'bisect')).max <= SAME_MAX;
  };
  if (await test(0)) return { needed: 0, below: null };
  let bad = 0;
  let good = ceiling;
  while (bad + 1 < good) {
    const mid = (bad + good) >> 1;
    if (await test(mid)) good = mid;
    else bad = mid;
  }
  return { needed: good, below: bad };
}

console.log('\n== 2b. the computed length suffices, and no one constant would ==');
const NEEDS = [];
for (const c of [
  { label: 'Blackwall, 30 fps', look: {}, rate: 1, fps: 30 },
  { label: 'Blackwall, 60 fps', look: {}, rate: 1, fps: 60 },
  { label: 'trails 0.95, 30 fps', look: { trails: 0.95 }, rate: 1, fps: 30 },
]) {
  const config = { look: { ...BLACKWALL_LOOK, ...c.look }, rate: c.rate, fps: c.fps, targetSec: TARGET_SEC };
  const played = await arm({ ...config, kind: 'playback', frames: null, label: `p-${c.label}` });
  const full = await arm({ ...config, kind: 'seek', frames: null, label: `f-${c.label}` });
  const same = await diff(`p-${c.label}`, `f-${c.label}`);
  const { needed, below } = await smallestSufficient(config, `p-${c.label}`, full.seek.plan.frames);
  NEEDS.push({ ...c, computed: full.seek.plan, needed, played: played.delta.renders });

  console.log(`\n  ${c.label}: computed ${full.seek.plan.frames} `
    + `(surface ${full.seek.plan.surface}, trails ${full.seek.plan.trails}); `
    + `playback rendered ${played.delta.renders}`);
  console.log(`    at the computed length ${show(same)}`);
  console.log(`    shortest that still reproduces it: ${needed} frames`
    + `${below === null ? '' : `, and ${below} does not`}`);
  check(same.max <= SAME_MAX, `${c.label}: the computed pre-roll reproduces the playback`, show(same));
  check(needed > 0, `${c.label}: a pre-roll is required at all`, `${needed} frames needed`);
  check(full.seek.plan.frames >= needed, `${c.label}: the computed length covers what is needed`,
    `${full.seek.plan.frames} computed against ${needed} needed`);
}
{
  const cheapest = Math.min(...NEEDS.map((n) => n.computed.frames));
  const dearest = Math.max(...NEEDS.map((n) => n.needed));
  check(dearest > cheapest,
    'no one constant would serve every configuration',
    `${dearest} frames genuinely needed at ${NEEDS.find((n) => n.needed === dearest).label}, `
    + `against a computed ${cheapest} at the cheapest`);
}


console.log('\n== 2c. the same equality at the longest persistence the sliders allow ==');
{
  const config = { look: { ...BLACKWALL_LOOK, ...{ fade: 1500, wake: 4000, trails: 0 } }, rate: 1, fps: 30, targetSec: TARGET_SEC };
  const played = await arm({ ...config, kind: 'playback', frames: null, label: 'p-longest' });
  const seeked = await arm({ ...config, kind: 'seek', frames: null, label: 'f-longest' });
  const past = await diff('p-longest', 'f-longest');
  const clamp = await page.evaluate('globalThis.__kinect.uniforms.fadeTime.value + 0');
  console.log(`  fade 1500 + wake 4000 = 5500ms of persistence, ${seeked.seek.plan.frames} pre-roll `
    + `frames computed against ${played.delta.renders} rendered by the playback`);
  console.log(`  ${show(past)}`);
  console.log(`  (Blackwall's 670ms, which every other equality here is proved at, is a `
    + `factor of eight inside it; fadeTime reads back at ${clamp}s so the look really was applied)`);
  check(clamp === 1.5, 'the longest fade the registry allows really was applied', `${clamp}s`);
  check(past.max <= SAME_MAX,
    'a seek reproduces a playback at the worst look the parameter space allows',
    show(past));
  check(seeked.seek.capped === false && seeked.seek.clamped === false,
    'and it did so on a full-length pre-roll, neither clipped by the head nor capped by the cache',
    JSON.stringify({ clamped: seeked.seek.clamped, capped: seeked.seek.capped, shortfall: seeked.seek.shortfall }));
}


console.log('\n== 2d. a pre-roll wider than the frame cache ==');
{
  const config = { look: { ...BLACKWALL_LOOK, ...{ trails: 0.97 } }, rate: 4, fps: 24, targetSec: 7.0 };
  const seeked = await arm({ ...config, kind: 'seek', frames: null, label: 'capped' });
  const state = seeked.state;
  console.log(`  trails 0.97 at 4.00x with 24 fps out: ${seeked.seek.plan.frames} frames computed, `
    + `${seeked.seek.frames} run, ${seeked.seek.shortfall} dropped`);
  console.log(`  ${seeked.seek.sourceFrames} source frames fetched, cache holding ${state.cached}`);
  check(seeked.seek.capped === true, 'the seek reports that the cache capped it',
    JSON.stringify({ capped: seeked.seek.capped, shortfall: seeked.seek.shortfall }));
  check(seeked.seek.shortfall > 0 && seeked.seek.frames < seeked.seek.plan.frames,
    'and it really did render fewer frames than it computed');
  check(state.cached <= state.capacity,
    'the cache stayed inside the capacity its demand bought',
    `${state.cached} frames against a capacity of ${state.capacity}`);
  check(state.capacity <= CACHE.ceiling,
    'and that capacity is inside the ceiling the memory budget buys, which is what bounds one '
    + 'take however much of it a plan asks for',
    `${state.capacity} against ${CACHE.ceiling}`);
  check(seeked.delta.renders === seeked.seek.frames + 1,
    'the seek completed rather than throwing', `${seeked.delta.renders} renders`);
}


console.log('\n== 3. draft scrub against accurate seek ==');
{
  await page.evaluate(`globalThis.__tl.configure(${JSON.stringify({ look: BLACKWALL_LOOK, rate: 1, fps: 30 })})`);

  // A fixed pseudo-random walk rather than evenly spaced positions: a drag lands
  // wherever the hand is, and evenly spaced targets would let a prefetch that
  // only ever reads forward look better than it is.
  let seed = 20260731;
  const nextSec = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return 1 + (seed / 4294967296) * (DURATION - 2);
  };
  const positions = Array.from({ length: SAMPLES + WARMUP }, nextSec);

  console.log(`  method: ${SAMPLES} samples per arm after ${WARMUP} discarded, the same position`);
  console.log('  given to both arms and the arms alternated sample by sample, so any drift on the');
  console.log('  machine lands on both. Timed inside the page around the whole operation - the');
  console.log('  fetch, the JPEG decode, the upload and the render - with the frame cache in');
  console.log('  whatever state the previous samples left it. Fetch counts are reported beside');
  console.log('  the times because a warm cache is most of the difference between two runs.');

  const timings = await page.evaluate(`(async (positions) => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    const out = { draft: [], seek: [], draftFetch: 0, seekFetch: 0, draftReq: 0, seekReq: 0 };
    for (let i = 0; i < positions.length; i++) {
      const at = positions[i];
      let before = globalThis.__tl.counters();
      let t0 = performance.now();
      await t.draft(at);
      const draftMs = performance.now() - t0;
      const draftDelta = globalThis.__tl.since(before);

      before = globalThis.__tl.counters();
      t0 = performance.now();
      await t.seek(at);
      const seekMs = performance.now() - t0;
      const seekDelta = globalThis.__tl.since(before);

      if (i >= ${WARMUP}) {
        out.draft.push(draftMs);
        out.seek.push(seekMs);
        out.draftFetch += draftDelta.framesFetched;
        out.seekFetch += seekDelta.framesFetched;
        out.draftReq += draftDelta.requests;
        out.seekReq += seekDelta.requests;
        out.renders = seekDelta.renders;
        out.draftRenders = draftDelta.renders;
      }
    }
    return out;
  })(${JSON.stringify(positions)})`);

  const n = timings.draft.length;
  console.log(`\n  draft scrub     p50 ${ms(pct(timings.draft, 50))}   p90 ${ms(pct(timings.draft, 90))}`
    + `   ${(timings.draftFetch / n).toFixed(1)} frames fetched per sample in `
    + `${(timings.draftReq / n).toFixed(1)} requests`);
  console.log(`  accurate seek   p50 ${ms(pct(timings.seek, 50))}   p90 ${ms(pct(timings.seek, 90))}`
    + `   ${(timings.seekFetch / n).toFixed(1)} frames fetched per sample in `
    + `${(timings.seekReq / n).toFixed(1)} requests`);
  console.log(`  a draft renders ${timings.draftRenders} frame, a seek renders ${timings.renders}`);

  check(timings.draftRenders === 1, 'a draft is one render with no pre-roll at all',
    `${timings.draftRenders} renders`);
  check(pct(timings.draft, 50) < pct(timings.seek, 50),
    'a draft costs less than an accurate seek at the same position');

  const parts = await page.evaluate(`(async (positions) => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    const out = { fetch: [], render: [], reset: [] };
    for (let i = 0; i < positions.length; i++) {
      const at = positions[i];
      const pair = t.clip.sourceFrameAt(at);
      // Cold on purpose: the two bracketing frames are dropped so the fetch and
      // the JPEG decode are both paid, which is what a drag onto a position it
      // has not been to costs.
      for (const k2 of [pair, pair + 1]) {
        t.clip.source.cache.get(k2)?.bitmap?.close();
        t.clip.source.cache.delete(k2);
      }
      let t0 = performance.now();
      await t.clip.source.ensure(pair, pair + 1);
      const fetchMs = performance.now() - t0;

      t0 = performance.now();
      k.resetAccumulators();
      const resetMs = performance.now() - t0;

      t.clip.source.seekTo(pair);
      t0 = performance.now();
      k.renderProgramFrame(at);
      k.drive.readPixels();          // forces the GPU to have finished
      const renderMs = performance.now() - t0;

      if (i >= ${WARMUP}) {
        out.fetch.push(fetchMs);
        out.reset.push(resetMs);
        out.render.push(renderMs);
      }
    }
    return out;
  })(${JSON.stringify(positions)})`);

  console.log('\n  step by step, cold cache, the two bracketing frames dropped before each sample');
  console.log('  and the render timed with a readback behind it so the GPU has actually finished:');
  console.log(`    fetch + decode, 2 frames   p50 ${ms(pct(parts.fetch, 50))}   p90 ${ms(pct(parts.fetch, 90))}`);
  console.log(`    clear both accumulators    p50 ${ms(pct(parts.reset, 50))}   p90 ${ms(pct(parts.reset, 90))}`);
  console.log(`    one render + readback      p50 ${ms(pct(parts.render, 50))}   p90 ${ms(pct(parts.render, 90))}`);
}


console.log('\n== 3b. a draft is independent of how the playhead got there ==');
{
  const HERE = 8.0;
  const configure = JSON.stringify({ look: BLACKWALL_LOOK, rate: 1, fps: 30 });
  const result = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const tl = globalThis.__tl;
    const t = k.timeline.transport();
    await tl.configure(${configure});

    // Reached from ahead of it, having played a long way.
    await t.seek(0);
    await t.runTo(t.frameAt(20.0));
    await t.draft(${HERE});
    tl.grab('draft-after-play');

    // And reached from behind it, off a bare seek to the head.
    await t.seek(1.0);
    await t.draft(${HERE});
    tl.grab('draft-after-seek');

    // The accurate image at the same place, for the other half of the claim.
    const seek = await t.seek(${HERE});
    tl.grab('accurate-here');

    // And the bypass stated as something that can fail: a draft holds fade, wake
    // and trails at zero for the length of its one frame, so a draft taken with
    // the three of them at their loudest has to be the same image as a draft
    // taken with them already at zero. Loudest rather than Blackwall's, because
    // Blackwall's 120ms fade is shorter than the gap the draft's two steps
    // advance and almost every point has finished ramping in by then - the
    // difference would be real but only a fraction of a percent of the frame.
    // At a 1500ms fade nothing has, so a draft that failed to bypass would come
    // back at a tenth of the brightness.
    await tl.configure(${JSON.stringify({ look: { ...BLACKWALL_LOOK, ...{ fade: 1500, wake: 4000, trails: 0.95 } }, rate: 1, fps: 30 })});
    await t.draft(${HERE});
    tl.grab('draft-loud');
    const restored = k.params.values(['fade', 'wake', 'trails']);
    await tl.configure(${JSON.stringify({ look: { ...BLACKWALL_LOOK, ...{ fade: 0, wake: 0, trails: 0 } }, rate: 1, fps: 30 })});
    await t.draft(${HERE});
    tl.grab('draft-zeroed');
    return { plan: seek.plan, restored };
  })()`);

  const history = await diff('draft-after-play', 'draft-after-seek');
  const versus = await diff('draft-after-seek', 'accurate-here');
  console.log(`  two drafts of ${HERE}s, one reached from 20.0s and one from 1.0s: ${show(history)}`);
  console.log(`  the draft against the accurate image at the same position: ${show(versus)}`);
  check(history.max === 0, 'a draft is byte-identical whatever the playhead did before it', show(history));
  check(versus.max >= CONTROL_MIN && versus.pct >= CONTROL_MIN_PCT,
    'and it is not the accurate image, so a pre-roll is being skipped', show(versus));

  const bypass = await diff('draft-loud', 'draft-zeroed');
  console.log('  a draft at fade 1500, wake 4000, trails 0.95 against one with all three at zero: '
    + `${show(bypass)}`);
  check(bypass.max === 0, 'a draft is the same image whatever the accumulator parameters say',
    show(bypass));
  check(result.restored.fade === 1500 && result.restored.wake === 4000 && result.restored.trails === 0.95,
    'and the registry is exactly where the draft found it afterwards',
    JSON.stringify(result.restored));
  console.log(`  (the accurate image there costs ${result.plan.frames} pre-roll frames)`);
}



console.log('\n== 3c. a draft that did not move the playhead rebuilds nothing ==');
{
  const HERE = 8.0;
  const result = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const tl = globalThis.__tl;
    const t = k.timeline.transport();
    await tl.configure(${JSON.stringify({ mode: 4, look: { fade: 400, wake: 900, trails: 0.85 }, rate: 1, fps: 30 })});

    // An accurate seek leaves the accumulators loaded, which is the state this is
    // about: the first draft of an orbit lands on top of one. A draft over a
    // freshly cleared set of buffers could not tell the two paths apart at all.
    await t.seek(${HERE});
    const parked = tl.counters();
    await t.draft(${HERE});
    const still = tl.since(parked);
    tl.grab('draft-stayed');

    // The same position again, this time arrived at, so the walk is genuinely
    // rebuilt. This is the control for the row above - without it, a build whose
    // counters never moved would read as the saving working perfectly.
    await t.draft(${HERE} - 0.5);
    const away = tl.counters();
    await t.draft(${HERE});
    const moved = tl.since(away);
    tl.grab('draft-arrived');

    return { still, moved, applied: t.clip.source.applied };
  })()`);

  console.log(`  a draft where the playhead already was: ${result.still.drafts} draft, `
    + `${result.still.stateAdvances} state advances, ${result.still.resets} resets`);
  console.log(`  a draft that arrived from 0.5s away:    ${result.moved.drafts} draft, `
    + `${result.moved.stateAdvances} state advances, ${result.moved.resets} resets`);
  check(result.still.drafts === 1 && result.still.stateAdvances === 0 && result.still.resets === 0,
    'a draft at the position the playhead is parked at walks nothing and clears nothing',
    `${result.still.stateAdvances} advances, ${result.still.resets} resets`);
  check(result.moved.stateAdvances === 2 && result.moved.resets === 1,
    'and one that moved still rebuilds the pair, so the row above is a saving not a hole',
    `${result.moved.stateAdvances} advances, ${result.moved.resets} resets`);

  const same = await diff('draft-stayed', 'draft-arrived');
  console.log(`  the two drafts of ${HERE}s, one that rebuilt the walk and one that skipped it: `
    + `${show(same)}`);
  check(same.max === 0, 'and it is the same image as one that did rebuild it', show(same));
}


console.log('\n== 4. playback at a rate lands on the source times it should ==');
for (const rate of [0.5, 1.0, 2.0]) {
  const fps = 30;
  const probes = [2.0, 5.0, 9.0].filter((sec) => sec * rate < DURATION - 0.5);
  const seen = await page.evaluate(`(async (o) => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    await globalThis.__tl.configure(o);
    await t.seek(0);
    const out = [];
    for (const sec of o.probes) {
      await t.runTo(t.frameAt(sec));
      out.push({
        programSec: t.programSec,
        applied: t.clip.source.applied,
        mixT: k.uniforms.mixT.value,
        sinceFrameSec: k.uniforms.sinceFrameSec.value,
      });
    }
    return out;
  })(${JSON.stringify({ look: BLACKWALL_LOOK, rate, fps, probes: [] })
    .replace('"probes":[]', `"probes":${JSON.stringify(probes)}`)})`);

  let worstT = 0;
  let worstMix = 0;
  for (const [i, got] of seen.entries()) {
    // Computed here from the index this tool fetched, never read off the page.
    const wantSource = got.programSec * rate;
    const b = bracketOf(wantSource);
    const wantMix = (wantSource - TIMES[b]) / (TIMES[b + 1] - TIMES[b]);
    worstT = Math.max(worstT, Math.abs(got.applied - (b + 1)));
    worstMix = Math.max(worstMix, Math.abs(got.mixT - wantMix));
    if (i === 0) {
      console.log(`  ${rate.toFixed(2)}x  program ${got.programSec.toFixed(3)}s -> source `
        + `${wantSource.toFixed(3)}s, frames ${b}/${b + 1} at mixT ${wantMix.toFixed(4)}; `
        + `the page holds frame ${got.applied} at mixT ${got.mixT.toFixed(4)}`);
    }
  }
  check(worstT === 0 && worstMix < 1e-6,
    `${rate.toFixed(2)}x reaches the source frames and blend the index says it should`,
    `${probes.length} probes, worst frame error ${worstT}, worst mixT error ${worstMix.toExponential(1)}`);
}


console.log('\n== 4b. 60 fps out of a capture whose median gap is 64ms ==');
{
  const FLAT = { ...DEPTH_LOOK, fade: 0, wake: 0, trails: 0, bloom: 0, 'glitch.amount': 0, 'blackwall.scan': 0, 'noise.amount': 0, 'rgbsplit.amount': 0, 'raster.amount': 0, 'grain.amount': 0, 'vignette.amount': 0, 'duotone.amount': 0 };
  const walk = `(async (o) => {
    const k = globalThis.__kinect;
    const tl = globalThis.__tl;
    const t = k.timeline.transport();
    await tl.configure(o);
    await t.seek(6.0);
    const out = [];
    for (let i = 0; i < 24; i++) {
      await t.runTo(t.frame + 1);
      const label = 'w' + i;
      out.push({
        applied: t.clip.source.applied,
        mixT: k.uniforms.mixT.value,
        programSec: t.programSec,
        hash: await tl.sha(tl.grab(label)),
      });
    }
    return out;
  })`;

  const on = await page.evaluate(`${walk}(${JSON.stringify({ look: { ...FLAT, interpolate: true }, rate: 1, fps: 60 })})`);
  const pairs = [];
  for (let i = 1; i < on.length; i++) {
    if (on[i].applied === on[i - 1].applied) pairs.push([i - 1, i]);
  }
  const distinct = pairs.filter(([a, b]) => on[a].hash !== on[b].hash).length;
  console.log(`  method: Depth mode with fade, wake, trails, bloom, glitch, Blackwall scan, noise and the whole`);
  console.log('  grade at zero, so the blend fraction is the only thing left that can move the image.');
  console.log(`  24 output frames at 60 fps from 6.0s: ${pairs.length} consecutive pairs land on the`);
  console.log(`  same two source frames, ${distinct} of them producing a different image.`);
  console.log(`  mixT walks ${on.slice(0, 6).map((f) => f.mixT.toFixed(3)).join(' ')} ...`);

  const off = await page.evaluate(`${walk}(${JSON.stringify({ look: { ...FLAT, interpolate: false }, rate: 1, fps: 60 })})`);
  const offPairs = [];
  for (let i = 1; i < off.length; i++) {
    if (off[i].applied === off[i - 1].applied) offPairs.push([i - 1, i]);
  }
  const offDistinct = offPairs.filter(([a, b]) => off[a].hash !== off[b].hash).length;
  console.log(`  the same walk with interpolation switched off: ${offDistinct} of ${offPairs.length} differ`);

  check(pairs.length >= 8, 'the output rate genuinely outruns the capture rate',
    `${pairs.length} of 23 steps stayed inside one source pair`);
  check(distinct === pairs.length, 'every output frame inside a source pair is its own image');
  check(offDistinct === 0,
    'and with interpolation off they repeat, so the measurement is sensitive to it',
    `${offDistinct} differed`);
  check(on.every((f) => f.mixT >= 0 && f.mixT <= 1) && on.some((f) => f.mixT > 0.02 && f.mixT < 0.98),
    'the blend fraction takes interior values rather than snapping to a frame');
}


console.log('\n== 5. a look change while paused rebuilds the image and the estimate ==');
{
  const canvas = page.locator('#stage');
  // Hash decoded stage pixels. Hashing the PNG itself includes its encoding, while reading the
  // WebGL buffer after presentation can return stale bytes because the buffer is not preserved.
  const image = async () => {
    const shot = await canvas.screenshot();
    return page.evaluate(`(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const context = canvas.getContext('2d');
      context.drawImage(img, 0, 0);
      return globalThis.__tl.sha(context.getImageData(0, 0, img.width, img.height).data);
    })(${JSON.stringify(`data:image/png;base64,${shot.toString('base64')}`)})`);
  };
  const planned = () => page.evaluate('globalThis.__kinect.timeline.transport().preroll()');
  const chip = async () => {
    const plan = await planned();
    return `${plan.frames} frames / ${plan.sec.toFixed(2)} s (surface ${plan.surface}, trails ${plan.trails})`;
  };
  const renders = () => page.evaluate('globalThis.__kinect.timeline.counters.renders');
  const slide = (id, value) => page.evaluate(`(async () => {
    const el = document.getElementById(${JSON.stringify(id)});
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
    await globalThis.__kinect.timeline.settled();
  })()`);

  // The speed slider needs its own, because its travel is logarithmic and its `value`
  // is therefore a position rather than a rate. Writing 1.20 into it lands at 4x - the
  // top of the range - and every assertion downstream would go on passing about a rate
  // nobody asked for. So the rate goes through the page's own mapping, and the rate
  // that came out is checked against the rate that went in rather than assumed.
  const slideRate = async (rate) => {
    const landed = await page.evaluate(`(async () => {
      const el = document.getElementById('tRate');
      el.value = String(__kinect.editor.rateSlider.toValue(${rate}));
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
      await globalThis.__kinect.timeline.settled();
      return globalThis.__kinect.timeline.read().speed;
    })()`);
    if (Math.abs(landed - rate) > 1e-6) {
      throw new Error(`asked the speed slider for ${rate}x and the page went to ${landed}x`);
    }
  };

  await page.evaluate(`(async () => {
    await globalThis.__tl.configure(${JSON.stringify({ look: RGB_LOOK, rate: 1, fps: 30 })});
    await globalThis.__kinect.timeline.transport().seek(8.0);
    await globalThis.__kinect.timeline.settled();
  })()`);
  const neutralImage = await image();
  const neutralChip = await chip();

  // (a) One registry write, and the image follows it.
  const beforeDepth = await renders();
  await page.evaluate(`(async () => {
    globalThis.__kinect.params.set('readDepth', 1);
    await globalThis.__kinect.timeline.settled();
  })()`);
  const depthRenders = (await renders()) - beforeDepth;
  const depthImage = await image();
  check(depthRenders > 0,
    'writing one reading rebuilds the image, like any other registry write',
    `${depthRenders} renders`);
  check(depthImage !== neutralImage, 'and the rebuilt image is a different one');

  // (b) A whole look at once, which is the reported reproduction exactly.
  await page.evaluate(`(async () => {
    globalThis.__kinect.applyPreset(${JSON.stringify(RGB_LOOK)});
    await globalThis.__kinect.timeline.settled();
  })()`);
  const beforeBlackwall = await renders();
  await page.evaluate(`(async () => {
    globalThis.__kinect.applyPreset(${JSON.stringify(BLACKWALL_LOOK)});
    await globalThis.__kinect.timeline.settled();
  })()`);
  const blackwallRenders = (await renders()) - beforeBlackwall;
  const blackwallImage = await image();
  const blackwallChip = await chip();
  const blackwallPlan = await planned();
  console.log(`  neutral at 8.0s reads "${neutralChip}"`);
  console.log(`  after applying the Blackwall look and touching nothing else: "${blackwallChip}"`);
  check(blackwallRenders > 0, 'applying a look rebuilds the image',
    `${blackwallRenders} renders`);
  // One image, not one per parameter: the Blackwall look is seventeen registry writes,
  // and repainting on each would render sixteen looks that never existed on the way to
  // the one that does.
  check(blackwallRenders === blackwallPlan.frames + 1,
    'and does it once for the whole look rather than once per parameter',
    `${blackwallRenders} renders against a ${blackwallPlan.frames}-frame pre-roll`);
  check(blackwallImage !== neutralImage, 'and the rebuilt image is a different one');
  check(blackwallChip !== neutralChip, 'and recomputes the pre-roll estimate',
    `"${neutralChip}" then "${blackwallChip}"`);

  // (c) The control that makes the above mean something. Nudging the rate away
  // and back was what used to correct both surfaces, so if the repaint really
  // happened it has already done everything the nudge would do.
  await slideRate(1.2);
  await slideRate(1);
  const nudgedImage = await image();
  const nudgedChip = await chip();
  check(nudgedImage === blackwallImage && nudgedChip === blackwallChip,
    'and a rate nudge afterwards changes neither, so nothing was left waiting for one',
    nudgedImage === blackwallImage ? '' : `${blackwallImage} then ${nudgedImage}`);

  // (d) The grading move itself: a slider, dragged on the panel. `wake` because
  // it moves both surfaces at once - the image through the surface memory and the
  // estimate through the fade-and-wake half of the pre-roll.
  await page.locator('#panelTabLook').click();
  const beforeWake = await renders();
  await slide('wake', 2500);
  const wakeRenders = (await renders()) - beforeWake;
  const wakeImage = await image();
  const wakeChip = await chip();
  const wakePlan = await planned();
  console.log(`  after dragging wake to 2500 on the panel: "${wakeChip}"`);
  check(wakeRenders > 0, 'dragging a look slider rebuilds the image', `${wakeRenders} renders`);
  check(wakeImage !== blackwallImage, 'and the rebuilt image is a different one');
  check(wakePlan.frames > blackwallPlan.frames,
    'and the estimate follows it up',
    `${blackwallPlan.frames} frames to ${wakePlan.frames}`);
}


console.log('\n== 6. the rain falls with the program clock, not with the frames drawn ==');
{
  const config = { look: CASCADE_LOOK, rate: 1, fps: 30, targetSec: TARGET_SEC, frames: null };
  const played = await arm({ ...config, kind: 'playback', label: 'rainPlayed' });
  const seeked = await arm({ ...config, kind: 'seek', label: 'rainSeeked' });
  const control = await arm({ ...config, kind: 'seek', frames: 0, label: 'rainControl' });

  const plan = seeked.seek.plan;
  console.log(`  method: ${existsSync(CASCADE_PATH) ? 'cascade.json' : 'Blackwall with the rain raised'}`
    + `, rate 1.00x, 30 fps out, target ${TARGET_SEC}s. Playback rendered ${played.delta.renders} `
    + `output frames, the seek ${seeked.delta.renders} (a ${plan.frames}-frame pre-roll), the `
    + `control ${control.delta.renders}.`);

  const raining = await page.evaluate('globalThis.__kinect.uniforms.rain.value');
  check(raining > 0.1, 'the look under this section actually has rain in it',
    `rain reads ${raining} at the uniform`);

  const reaches = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const tl = globalThis.__tl;
    const held = k.uniforms.rainPhase.value;
    k.uniforms.rainPhase.value = held + 0.37;
    k.renderer.render(k.scene, k.viewCamera());
    tl.grab('rainNudged');
    k.uniforms.rainPhase.value = held;
    k.renderer.render(k.scene, k.viewCamera());
    tl.grab('rainHeld');
    return { held, nudged: held + 0.37 };
  })()`);
  const nudge = await diff('rainHeld', 'rainNudged');
  console.log(`  the clock alone, moved ${(reaches.nudged - reaches.held).toFixed(2)}s under a `
    + `still frame: ${show(nudge)}`);
  check(nudge.max >= RAIN_CONTROL_MIN && nudge.pct >= 1.0,
    'moving the rain clock and nothing else moves this picture, so the equality below is '
    + 'about a term that reaches pixels rather than about two identical frames', show(nudge));

  const clocks = [['playback', played], ['seek', seeked], ['no pre-roll', control]];
  const off = clocks.filter(([, a]) => Math.abs(a.rainPhaseAfter - TARGET_SEC) > 1e-6);
  console.log(`  rain clock per arm: ${clocks.map(([n, a]) => `${n} ${a.rainPhaseBefore.toFixed(3)}`
    + ` -> ${a.rainPhaseAfter.toFixed(3)}`).join(', ')}`);
  check(off.length === 0,
    `every arm ends with the rain clock reading the program time it was asked for, ${TARGET_SEC}s, `
    + 'whatever it inherited from the arm before it',
    off.length ? off.map(([n, a]) => `${n} ended at ${a.rainPhaseAfter.toFixed(4)}`).join(', ')
      : `all three at ${TARGET_SEC.toFixed(3)}`);

  // The arms did different work, or "identical" is a statement about one arm run twice.
  check(played.delta.renders > seeked.delta.renders * 4,
    'the two arms did substantially different amounts of work',
    `${played.delta.renders} renders against ${seeked.delta.renders}`);
  check(played.delta.renders === seeked.seek.target + 1,
    'playback rendered every output frame from the start of the edit and no more',
    `${played.delta.renders} of ${seeked.seek.target + 1}`);
  check(seeked.delta.renders === plan.frames + 1,
    'and the seek rendered the pre-roll and the target and nothing else',
    `${seeked.delta.renders} of ${plan.frames + 1}`);
  check(played.camera === seeked.camera && played.camera === control.camera,
    'the camera is identical across all three arms');

  const same = await diff('rainPlayed', 'rainSeeked');
  const apart = await diff('rainPlayed', 'rainControl');
  console.log(`\n  playback vs seek        ${show(same)}${same.max === 0 ? '  (byte-identical)' : ''}`);
  console.log(`  playback vs no pre-roll ${show(apart)}`);

  check(same.max <= RAIN_SAME_MAX,
    `a seek lands within ${RAIN_SAME_MAX}/255 of the playback with the rain falling`, show(same));
  check(apart.max >= RAIN_CONTROL_MIN && apart.pct >= RAIN_CONTROL_MIN_PCT
    && apart.mean >= RAIN_CONTROL_MIN_MEAN,
    'the control lands somewhere else across the frame rather than at one pixel, so the '
    + 'equality above is about something', show(apart));
  check(apart.max > same.max * 8 + 8, 'the two verdicts are separated rather than adjacent',
    `control max ${apart.max} against ${same.max}`);
}

console.log('\n== 7. the mosh pass decodes from its own last refresh ==');
{
  // The refresh is 2.5s rather than the preset's, so the target is not on a boundary: at 12s
  // the last refresh was at 10, and the pass therefore has 60 frames of memory behind it - more
  // than the surface and the trails ask for between them, so the pre-roll below is the mosh's.
  const MOSH_REFRESH = 2.5;
  // **The surface memory and the trails are put down for this section, and that is the whole
  // reason the control arm below means anything.** With them up, an arm rendered with no
  // pre-roll differs from a playback whatever the mosh does - the shed points and the trail are
  // missing too - so the row saying "the control lands somewhere else" passes on a build whose
  // mosh reads no history at all. Measured: `--mutate mosh-no-history` reddened nothing under
  // the preset's own fade, wake and trails. Zeroed, the mosh is the only thing in the chain
  // that remembers, and the control is a statement about it.
  // **The decay is put up near 1 as well, and that is the other thing this section had wrong.**
  // The smear's memory is bounded twice over - by the refresh, and by the decay eating the trail
  // a percent at a time - and at the shipped 0.88 the second one wins long before the first:
  // 0.88^60 is 0.05%, so a build that never refreshed at all drew the same picture and
  // `--mutate mosh-never-refreshes` reddened nothing. At 0.99 the refresh is what bounds it.
  const MOSH_DECAY = 0.99;
  // How far short of the refresh the isolating arm starts. Measured: at 20 the arm parted from
  // the playback by 18/255, which clears the 16 this file asks for by too little to trust on a
  // contended machine; at 35 it is comfortable and every other accumulator still has 25 frames
  // to converge in.
  const MOSH_SHORT_BY = 35;
  const MOSH_ARM_LOOK = {
    ...MOSH_LOOK,
    fade: 0,
    wake: 0,
    trails: 0,
    'datamosh.decay': MOSH_DECAY,
    'datamosh.refresh': MOSH_REFRESH,
  };
  const config = { look: MOSH_ARM_LOOK, rate: 1, fps: 30, targetSec: TARGET_SEC, frames: null };
  const played = await arm({ ...config, kind: 'playback', label: 'moshPlayed' });
  const seeked = await arm({ ...config, kind: 'seek', label: 'moshSeeked' });
  const control = await arm({ ...config, kind: 'seek', frames: 0, label: 'moshControl' });

  const plan = seeked.seek.plan;
  console.log('  method: Blackwall with the datamosh raised'
    + `, refresh ${MOSH_REFRESH}s, rate 1.00x, 30 fps out, target ${TARGET_SEC}s. Pre-roll `
    + `${plan.frames} frames (surface ${plan.surface}, trails ${plan.trails}, mosh ${plan.mosh}). `
    + `Playback rendered ${played.delta.renders}, the seek ${seeked.delta.renders}, the control `
    + `${control.delta.renders}.`);

  const state = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    return {
      on: k.mosh.enabled,
      amount: k.mosh.uniforms.mosh.value,
      refresh: k.mosh.uniforms.moshRefresh.value,
      fade: k.uniforms.fadeTime.value,
      wake: k.uniforms.wakeTime.value,
      trails: k.afterimage.enabled,
    };
  })()`);
  check(state.on && state.amount > 0.1,
    'the look under this section actually has the mosh pass running',
    `amount ${state.amount}, pass ${state.on ? 'on' : 'OFF'}`);
  check(state.fade === 0 && state.wake === 0 && !state.trails,
    'and it is the only thing in the chain that remembers, so the control arm below is a '
    + 'statement about the mosh rather than about the two accumulators beside it',
    `fade ${state.fade}, wake ${state.wake}, trails ${state.trails ? 'ON' : 'off'}`);

  // The claim the whole design rests on: the memory has a ceiling, and it is the period the
  // package declares. Without it no length of pre-roll would reproduce a frame.
  const ceiling = Math.ceil(MOSH_REFRESH * 30);
  check(plan.mosh > 0 && plan.mosh <= ceiling && plan.moshCovered,
    `the mosh pre-roll is bounded by the refresh it declares, ${ceiling} frames at this period`,
    `${plan.mosh} frames, ${plan.moshCovered ? 'covered' : 'NOT covered'}`);
  check(plan.frames === plan.mosh && plan.mosh > plan.surface && plan.mosh > plan.trails,
    'and it is the mosh that sets the length here, the other two being down',
    `mosh ${plan.mosh} against surface ${plan.surface} and trails ${plan.trails}`);
  check(plan.mosh === Math.round((TARGET_SEC - Math.floor(TARGET_SEC / MOSH_REFRESH) * MOSH_REFRESH) * 30),
    'and the length is the distance back to the last refresh, which is where a decode starts',
    `${plan.mosh} frames back from ${TARGET_SEC}s`);

  // A target that is a refresh needs no mosh pre-roll at all, which is the same rule read from
  // the other end: 10s is four periods of 2.5, so the pass draws the frame it was handed.
  const onBoundary = await page.evaluate(
    `globalThis.__kinect.timeline.transport().preroll(${Math.floor(TARGET_SEC / MOSH_REFRESH) * MOSH_REFRESH})`);
  check(onBoundary.mosh === 0,
    'a target that lands on a refresh asks for no mosh pre-roll, because nothing behind it is read',
    `${onBoundary.mosh} frames at ${Math.floor(TARGET_SEC / MOSH_REFRESH) * MOSH_REFRESH}s`);

  check(played.delta.renders > seeked.delta.renders * 2,
    'the two arms did substantially different amounts of work',
    `${played.delta.renders} renders against ${seeked.delta.renders}`);
  check(seeked.delta.renders === plan.frames + 1,
    'the seek rendered the pre-roll and the target and nothing else',
    `${seeked.delta.renders} of ${plan.frames + 1}`);
  check(played.camera === seeked.camera && played.camera === control.camera,
    'the camera is identical across all three arms');

  // **The arm that says the pass reads its own history, and it is a short pre-roll rather than
  // no pre-roll.** The obvious control - render the target with nothing before it - is not about
  // the mosh: the surface memory's own state texture is cleared by the same reset and reads
  // differently on its first frame whatever the fade and wake say, so that arm parts from a
  // playback on a build whose mosh reads no history at all. Measured: `--mutate mosh-no-history`
  // left it at max 59/255 across 85% of the frame and the row passed. Twenty frames short of the
  // refresh, every other accumulator has long since converged and the only thing missing is
  // that many frames of the smear's own history.
  const short = await arm({ ...config, kind: 'seek', frames: Math.max(1, plan.mosh - MOSH_SHORT_BY), label: 'moshShort' });
  const same = await diff('moshPlayed', 'moshSeeked');
  const apart = await diff('moshPlayed', 'moshControl');
  const cut = await diff('moshPlayed', 'moshShort');
  console.log(`\n  playback vs seek         ${show(same)}${same.max === 0 ? '  (byte-identical)' : ''}`);
  console.log(`  playback vs ${MOSH_SHORT_BY} frames short ${show(cut)}`);
  console.log(`  playback vs no pre-roll  ${show(apart)}`);

  check(same.max <= SAME_MAX,
    `a seek lands within ${SAME_MAX}/255 of the playback with the mosh dragging the picture`, show(same));
  check(short.delta.renders === Math.max(1, plan.mosh - MOSH_SHORT_BY) + 1,
    'the short arm rendered the frames it was asked for, so it is the history that is missing '
    + 'rather than the arm', `${short.delta.renders} renders`);
  check(cut.max >= MOSH_CUT_MIN && cut.pct >= MOSH_CUT_MIN_PCT,
    `${MOSH_SHORT_BY} frames of pre-roll short of the refresh lands somewhere else, so the pass `
    + 'is reading what it drew rather than displacing the frame it was handed', show(cut));
  check(cut.max > same.max * 8 + 8, 'the two verdicts are separated rather than adjacent',
    `short max ${cut.max} against ${same.max}`);
  // Kept as a reading rather than as a claim about the mosh: it is every accumulator's absence
  // at once, and the row above is the one that isolates this pass.
  check(apart.max >= CONTROL_MIN,
    'and a seek with no pre-roll at all is further still', show(apart));
}



// The clips of the multi-clip fixture, in the order the document lists them - which is
// deliberately not the order of their ids, so a build assigning draw order by array position
// draws a different composite from one assigning it by id.
const FIXTURE_CLIPS = [
  // Half speed with an in-point 20s into the take, so its head affords far more than any look asks
  // for. It is also the clip the page comes up selected on, and its persistence is deliberately
  // the shortest here: a build that read the look off the selection rather than off each clip
  // would compute this clip's pre-roll for all of them.
  { id: 'c2', start: 3, length: 6, speed: 0.5, sourceStart: 20, second: false,
    look: { fade: 100, wake: 100 } },
  // In-point at source zero, so there is nothing before it to warm with. It enters cold, and a
  // seek to the same instant enters cold too, which is why the invariant holds here. Its
  // brightness is plainly not the others', which is what a broadcast look would flatten.
  { id: 'c4', start: 6, length: 4, speed: 1, sourceStart: 0, second: true,
    look: { exposure: 2.4 } },
  // A head shorter than the look asks for: 0.6s of source against a full second of persistence.
  { id: 'c1', start: 0, length: 8, speed: 1, sourceStart: 0.6, second: false, look: {} },
  // The same take as c1, placed elsewhere and offset so it stands on the same source frame at
  // every program position it shares with it. Two clips wanting one frame of one take is the
  // case the per-take half of the pipeline split is about.
  { id: 'c5', start: 2, length: 2.5, speed: 1, sourceStart: 2.6, second: false, look: {} },
  // A deep in-point and the only additive clip here, which is what puts a clip on each side of the
  // draw order's split.
  { id: 'c3', start: 5, length: 4, speed: 1, sourceStart: 40, second: false,
    look: { additive: true } },
];

// Persistence short enough that four clips of one take fit its cache with room, and long enough
// that a clip entering without a warm is a visibly different picture. Depth-writing, because
// additive blending is commutative and an order the composite is genuinely sensitive to is the
// only one the byte-identity row below is a claim about.
const MULTI_LOOK = { ...BLACKWALL_LOOK, fade: 300, wake: 700, trails: 0, additive: false };

const { takes: LIBRARY_TAKES = [] } = await (await fetch(`${URL_BASE}/library/takes`)).json();
const PRIMARY_TAKE = LIBRARY_TAKES.find((t) => t.id === TAKE) ?? null;
const SECOND_TAKE = LIBRARY_TAKES.find((t) => t.id !== TAKE && t.openable) ?? null;

const MULTI = `(() => {
  const k = globalThis.__kinect;
  const tl = globalThis.__tl;
  const primary = ${JSON.stringify(PRIMARY_TAKE
    ? { id: PRIMARY_TAKE.id, hash: PRIMARY_TAKE.hash }
    : null)};
  globalThis.__mc = {
    /**
     * The fixture loaded, with the clips listed in the order given.
     *
     * Built by serialising what the page already holds and editing the clip array, because a
     * clip block written by hand is refused: a document carries all five reading weights and
     * every parameter of every effect it names.
     */
    async load(spec, second, look) {
      const base = k.library.serialiseProjectBody();
      const one = base.clips[0];
      // Split by the registry's own answer rather than by a list here: a clip block carrying a
      // project value is refused by the scope door, and a hand-written split would drift.
      const scoped = (want, scope) => Object.fromEntries(
        Object.entries(want).filter(([n]) => k.params.spec(n).scope === scope),
      );
      const built = spec.map((c) => ({
        ...one,
        id: c.id,
        start: c.start,
        length: c.length,
        take: c.take ? { ...c.take }
          : (c.second && second ? { ...second } : (primary ? { ...primary } : one.take)),
        speed: c.speed,
        sourceStart: c.sourceStart,
        // This clip's own look, written into the document rather than applied afterwards - the
        // loader is the door a per-clip look actually comes through.
        params: { ...one.params, ...scoped(look, 'clip'), ...scoped(c.look ?? {}, 'clip') },
        tracks: {},
      }));
      await k.library.loadProject('multi-clip fixture', {
        ...base,
        look: {
          ...base.look,
          params: { ...base.look.params, ...scoped(look, 'project') },
          tracks: {},
        },
        clips: built,
      });
      await k.timeline.settled();
      tl.pinCamera();
      await k.timeline.settled();
      tl.pinCamera();
      return k.timeline.clips();
    },

    /** A program position reached by seeking, or by playing to it from a position before it. */
    async arm(kind, targetSec, fromSec, label, frames) {
      const t = k.timeline.transport();
      const before = tl.counters();
      let seek = null;
      if (kind === 'playback') {
        await t.seek(fromSec);
        await t.runTo(t.frameAt(targetSec));
      } else {
        // A seek answers null when it stood down for a repaint rather than landing. Asked again
        // rather than read as a result: null is "come back", and reading it as one is how a
        // stand-down would arrive here wearing the shape of a finding.
        for (let attempt = 0; attempt < 4 && seek === null; attempt++) {
          seek = await t.seek(targetSec, frames === null ? {} : { frames });
        }
        if (seek === null) throw new Error('the seek to ' + targetSec + 's stood down four times');
      }
      const pixels = tl.grab(label);
      return {
        hash: await tl.sha(pixels),
        delta: tl.since(before),
        camera: tl.camera(),
        seek,
        clips: k.timeline.clips(),
        showing: k.timeline.showingAt(t.programSec),
        takes: k.timeline.takes(),
        frame: t.frame,
        spans: t.planSeek(targetSec, frames === null ? undefined : frames).spans
          .map((span) => ({ id: span.clip.id, from: span.from, to: span.to })),
      };
    },
  };
  return true;
})()`;

console.log('\n== 7. more than one clip: the composite, the cut, and what a clip enters holding ==');
{
  await page.evaluate(MULTI);
  const order = FIXTURE_CLIPS.map((c) => c.id);
  const built = await page.evaluate(
    `globalThis.__mc.load(${JSON.stringify(FIXTURE_CLIPS)}, ${JSON.stringify(SECOND_TAKE
      ? { id: SECOND_TAKE.id, hash: SECOND_TAKE.hash } : null)}, ${JSON.stringify(MULTI_LOOK)})`,
  );
  console.log(`  ${built.length} clips, listed as ${order.join(', ')}, on `
    + `${SECOND_TAKE ? `${TAKE} and ${SECOND_TAKE.id}` : `${TAKE} alone (no second take in the library)`}`);
  for (const c of built) {
    console.log(`    ${c.id.padEnd(3)} ${String(c.start).padStart(5)}s +${String(c.length).padStart(4)}s  `
      + `draw ${c.renderOrder}  warm ${String(c.warmFrames).padStart(3)} frames  take ${c.take?.id ?? 'none'}`);
  }

  check(built.length === FIXTURE_CLIPS.length,
    `the build composites all ${FIXTURE_CLIPS.length} clips rather than refusing the document`,
    `${built.length} clips`);
  check(built.map((c) => c.id).join() === order.join(),
    'and holds them in the order the document listed them, which is not the order of their ids',
    built.map((c) => c.id).join(', '));

  // 7a. each clip's look is its own.
  const blocks = await page.evaluate(`(() => {
    const body = globalThis.__kinect.library.serialiseProjectBody();
    return body.clips.map((c) => ({ id: c.id, additive: c.params.additive,
      exposure: c.params.exposure, fade: c.params.fade, wake: c.params.wake }));
  })()`);
  console.log("  each clip's own look, off the document it would be saved as:");
  for (const b of blocks) {
    console.log(`    ${b.id.padEnd(3)} ${b.additive ? 'additive' : 'depth   '} `
      + `exposure ${String(b.exposure).padStart(5)}  fade ${String(b.fade).padStart(4)}  `
      + `wake ${String(b.wake).padStart(4)}`);
  }
  const looks = new Set(blocks.map((b) => `${b.additive}/${b.exposure}/${b.fade}/${b.wake}`));
  check(looks.size >= 3,
    'the clips carry looks of their own, and three of them are different looks rather than one '
    + 'look written five times', `${looks.size} distinct blocks across ${blocks.length} clips`);
  check(built.every((c) => c.additive === blocks.find((b) => b.id === c.id).additive),
    'and what each clip is actually blending with is what its own block says, so the values '
    + 'reached the clouds rather than only the tables',
    built.map((c) => `${c.id}:${c.additive ? 'a' : 'd'}`).join(' '));

  // 7b. draw order, now that a clip can be on either side of the split.
  const depth = built.filter((c) => !c.additive);
  const glow = built.filter((c) => c.additive);
  check(new Set(built.map((c) => c.renderOrder)).size === built.length,
    'every clip draws at a render order of its own rather than sharing one with another',
    built.map((c) => `${c.id}:${c.renderOrder}`).join(' '));
  check(depth.length >= 2 && glow.length >= 1,
    'the fixture puts clips on both sides of the additive split, which is what makes the row '
    + 'below a claim rather than a description of one group',
    `${depth.length} writing depth, ${glow.length} additive`);
  check(Math.max(...depth.map((c) => c.renderOrder)) < Math.min(...glow.map((c) => c.renderOrder)),
    'every clip that writes depth draws before every additive one, because an additive layer '
    + 'composited under one that writes depth is a different picture',
    built.map((c) => `${c.id}:${c.renderOrder}${c.additive ? 'a' : 'd'}`).join(' '));
  const inIdOrder = (half) => [...half].sort((a, b) => (a.id < b.id ? -1 : 1))
    .every((c, at, all) => at === 0 || all[at - 1].renderOrder < c.renderOrder);
  check(inIdOrder(depth) && inIdOrder(glow),
    'and inside each half the tie breaks on the clip id rather than on the array order, so two '
    + 'runs of one document write the same bytes however the array came to be built',
    built.map((c) => `${c.id}:${c.renderOrder}`).join(' '));

  const flipped = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const before = k.timeline.clips().map((c) => ({ id: c.id, ro: c.renderOrder, add: c.additive }));
    const held = before.find((c) => c.selected) ?? before[0];
    k.timeline.select('c1');
    k.params.apply({ additive: true });
    const after = k.timeline.clips().map((c) => ({ id: c.id, ro: c.renderOrder, add: c.additive }));
    k.params.apply({ additive: false });
    k.timeline.select(held.id);
    return { before, after };
  })()`);
  const movedOne = flipped.after.filter((c, at) => c.add !== flipped.before[at].add);
  check(movedOne.length === 1 && movedOne[0].id === 'c1',
    'turning one clip additive turns that clip additive and no other, because the switch is '
    + "that clip's look rather than the project's",
    movedOne.length ? movedOne.map((c) => c.id).join(', ') : 'none moved');
  check(flipped.after.find((c) => c.id === 'c1').ro
    > Math.max(...flipped.after.filter((c) => !c.add).map((c) => c.ro)),
  'and it crosses the draw order to sit with the additive half',
  flipped.after.map((c) => `${c.id}:${c.ro}${c.add ? 'a' : 'd'}`).join(' '));

  const FOUR_SEC = 6.5;
  const reversed = await page.evaluate(
    `globalThis.__mc.load(${JSON.stringify([...FIXTURE_CLIPS].reverse())}, ${JSON.stringify(SECOND_TAKE
      ? { id: SECOND_TAKE.id, hash: SECOND_TAKE.hash } : null)}, ${JSON.stringify(MULTI_LOOK)})`,
  );
  const reversedShot = await page.evaluate(
    `globalThis.__mc.arm('seek', ${FOUR_SEC}, 0, 'multiReversed', null)`,
  );
  await page.evaluate(
    `globalThis.__mc.load(${JSON.stringify(FIXTURE_CLIPS)}, ${JSON.stringify(SECOND_TAKE
      ? { id: SECOND_TAKE.id, hash: SECOND_TAKE.hash } : null)}, ${JSON.stringify(MULTI_LOOK)})`,
  );
  const forwardShot = await page.evaluate(
    `globalThis.__mc.arm('seek', ${FOUR_SEC}, 0, 'multiForward', null)`,
  );
  const orderSame = await diff('multiForward', 'multiReversed');
  console.log(`  the same four clips listed forwards and backwards: ${show(orderSame)}`);
  check(reversed.map((c) => c.id).reverse().join() === built.map((c) => c.id).join(),
    'the two loads really did list the clips in opposite orders',
    `${built.map((c) => c.id).join(',')} against ${reversed.map((c) => c.id).join(',')}`);
  check(orderSame.max === 0,
    'and the composite is byte-identical, so the array order reaches no pixel', show(orderSame));

  // 7b. four clips overlap here, and the idle ones cost nothing.
  const live = forwardShot.showing.filter((s) => s.showing === 'live');
  console.log(`  at ${FOUR_SEC}s: ${forwardShot.showing.map((s) => `${s.id} ${s.showing}`).join(', ')}`);
  check(live.length === 4, `four clips overlap at ${FOUR_SEC}s, which is the budget this step is `
    + 'measured against', `${live.length} live`);
  check(forwardShot.clips.every((c) => c.visible === (
    forwardShot.showing.find((s) => s.id === c.id).showing === 'live')),
  'and a clip is in the scene exactly while it is drawn, so an idle one costs no draw at all',
  forwardShot.clips.map((c) => `${c.id}:${c.visible ? 'on' : 'off'}`).join(' '));

  const ONE_SEC = 1.0;
  const alone = await page.evaluate(`globalThis.__mc.arm('seek', ${ONE_SEC}, 0, 'multiAlone', null)`);
  const aloneLive = alone.showing.filter((s) => s.showing === 'live');
  const versusAlone = await diff('multiForward', 'multiAlone');
  check(aloneLive.length === 1,
    `one clip alone at ${ONE_SEC}s, which is what makes the comparison below a control`,
    aloneLive.map((s) => s.id).join(', '));
  check(versusAlone.max >= CONTROL_MIN && versusAlone.pct >= CONTROL_MIN_PCT,
    'and the four-clip composite is a different picture from the one-clip one, so the clips '
    + 'whose order the rows above are about are contributing pixels', show(versusAlone));

  // 7c. the pipeline splits per take and per clip.
  const sameTake = forwardShot.clips.filter((c) => c.take?.id === TAKE);
  const cursors = sameTake.map((c) => c.applied);
  const slots = forwardShot.clips.map((c) => `${c.id}:${c.takeSlot}`);
  console.log(`  ${forwardShot.takes} take(s) open for ${forwardShot.clips.length} clips; `
    + `the ${sameTake.length} cut on ${TAKE} stand at source frames ${cursors.join(', ')}`);
  console.log(`  each clip's walk is over take slot ${slots.join(' ')}`);
  check(forwardShot.takes === (SECOND_TAKE ? 2 : 1),
    `the ${sameTake.length} clips cut on ${TAKE} share one open take, so its bytes, its index `
    + 'and its fetch cache are one of each rather than one per clip',
    `${forwardShot.takes} open`);
  check(new Set(sameTake.map((c) => c.takeSlot)).size === 1,
    'and they read it through one take object rather than one each, which is the identity the '
    + 'count above cannot see', slots.join(' '));
  check(new Set(cursors).size >= 2,
    'while standing on source frames of their own, so sharing the take did not put one '
    + "clip's frame in front of another's shader", cursors.join(', '));

  // At 4s, and not over the four-clip overlap: two clips of one take is what this row is about,
  // and this position has exactly that.
  const DECODE_SEC = 4;
  const decoded = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    await t.seek(0);
    const before = { ...k.timeline.counters };
    await t.seek(${DECODE_SEC});
    const moved = { ...k.timeline.counters };
    await t.seek(${DECODE_SEC});
    const again = { ...k.timeline.counters };
    return {
      live: k.timeline.showingAt(t.programSec).filter((s) => s.showing === 'live').map((s) => s.id),
      together: k.timeline.clips().filter((c) => c.id === 'c1' || c.id === 'c5').map((c) => c.applied),
      decodes: moved.bitmapDecodes - before.bitmapDecodes,
      repeat: again.bitmapDecodes - moved.bitmapDecodes,
      fetched: moved.framesFetched - before.framesFetched,
    };
  })()`);
  console.log(`  a seek to ${DECODE_SEC}s (${decoded.live.join(', ')} live) decoded ${decoded.decodes} `
    + `JPEGs (${decoded.fetched} frames fetched); seeking there again decoded ${decoded.repeat}`);
  check(decoded.live.length >= 2,
    `two clips of ${TAKE} are live at ${DECODE_SEC}s, which is what the two rows below are about`,
    decoded.live.join(', '));
  check(decoded.together.length === 2 && decoded.together[0] === decoded.together[1],
    'and two of them want the same source frame there, which is the case a per-clip cache would '
    + 'fetch and decode twice', `c1 and c5 at ${decoded.together.join(' and ')}`);
  check(decoded.repeat === 0,
    'a second seek to the same position decodes nothing, so the decode is cached rather than '
    + 'repeated per clip per frame', `${decoded.repeat} decodes`);
  check(decoded.decodes === decoded.fetched,
    'and a fetched frame is decoded once, not once per clip cut on the take it came from',
    `${decoded.decodes} decodes against ${decoded.fetched} frames`);

  // 7d. the claim: a clip entered under playback is the clip seeked to.
  console.log('\n  a clip entered under playback against the same clip seeked to');
  const ENTRIES = [
    { id: 'c2', targetSec: 3.3, fromSec: 0.5, why: 'half speed with a deep in-point' },
    { id: 'c3', targetSec: 5.3, fromSec: 3.4, why: 'an additive clip with a deep in-point' },
    { id: 'c4', targetSec: 6.3, fromSec: 4.9, why: 'no footage before its in-point' },
  ];
  for (const entry of ENTRIES) {
    const isolated = [FIXTURE_CLIPS.find((clip) => clip.id === entry.id)];
    await page.evaluate(
      `globalThis.__mc.load(${JSON.stringify(isolated)}, ${JSON.stringify(SECOND_TAKE
        ? { id: SECOND_TAKE.id, hash: SECOND_TAKE.hash } : null)}, ${JSON.stringify(MULTI_LOOK)})`,
    );
    const played = await page.evaluate(
      `globalThis.__mc.arm('playback', ${entry.targetSec}, ${entry.fromSec}, 'entryPlayed', null)`,
    );
    const seeked = await page.evaluate(
      `globalThis.__mc.arm('seek', ${entry.targetSec}, ${entry.fromSec}, 'entrySeeked', null)`,
    );
    const control = await page.evaluate(
      `globalThis.__mc.arm('seek', ${entry.targetSec}, ${entry.fromSec}, 'entryControl', 0)`,
    );
    const same = await diff('entryPlayed', 'entrySeeked');
    const apart = await diff('entryPlayed', 'entryControl');
    const entered = played.clips.find((c) => c.id === entry.id);
    const liveHere = played.showing.filter((s) => s.showing === 'live').map((s) => s.id);

    console.log(`\n  ${entry.id} at ${entry.targetSec}s (${entry.why}): warm ${entered.warmFrames} `
      + `frames, ${liveHere.length} clips live (${liveHere.join(', ')}), playback rendered `
      + `${played.delta.renders} and entered ${played.delta.clipEntries} clips, the seek `
      + `${seeked.delta.renders} over a ${seeked.seek.plan.frames}-frame pre-roll`);
    console.log(`    played vs seeked   ${show(same)}${same.max === 0 ? '  (byte-identical)' : ''}`);
    console.log(`    played vs no pre-roll ${show(apart)}`);

    check(liveHere.includes(entry.id),
      `${entry.id}: the clip under test is actually drawn at this position`, liveHere.join(', '));
    check(played.delta.renders !== seeked.delta.renders,
      `${entry.id}: the two arms did different amounts of work`,
      `${played.delta.renders} renders against ${seeked.delta.renders}`);
    check(played.delta.clipEntries > 0,
      `${entry.id}: the playback arm crossed a cut rather than starting inside the clip`,
      `${played.delta.clipEntries} clips entered`);
    check(same.max <= SAME_MAX,
      `${entry.id}: a clip entered under playback is the clip a seek lands on`, show(same));
    check(apart.max >= CONTROL_MIN && apart.pct >= CONTROL_MIN_PCT,
      `${entry.id}: and a build with no pre-roll at all lands somewhere else, so the equality `
      + 'above is about something', show(apart));
    check(apart.max > same.max * 8 + 8,
      `${entry.id}: the two verdicts are separated rather than adjacent`,
      `control max ${apart.max} against ${same.max}`);
  }

  // 7e. the warm itself: which clips have one, and what bounds it.
  await page.evaluate(
    `globalThis.__mc.load(${JSON.stringify(FIXTURE_CLIPS)}, ${JSON.stringify(SECOND_TAKE
      ? { id: SECOND_TAKE.id, hash: SECOND_TAKE.hash } : null)}, ${JSON.stringify(MULTI_LOOK)})`,
  );
  const warmed = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    await t.seek(0.5);
    const before = { ...k.timeline.counters };
    await t.runTo(t.frameAt(3.4));
    return {
      clips: k.timeline.clips(),
      warmedFrames: k.timeline.counters.clipsWarmed - before.clipsWarmed,
      showingBefore: k.timeline.showingAt(2.9),
    };
  })()`);
  const warmTable = Object.fromEntries(warmed.clips.map((c) => [c.id, c.warmFrames]));
  console.log(`\n  warm windows: ${Object.entries(warmTable).map(([id, n]) => `${id} ${n}`).join(', ')}`);
  check(warmTable.c2 > 0,
    'a clip whose head is real footage is warmed before its in-point', `c2 warms ${warmTable.c2} frames`);
  check(warmTable.c4 === 0,
    'a clip whose footage starts at source zero has nothing to warm with, so it enters cold - '
    + 'and so does a seek to that instant, which is why the rows above hold rather than break',
    `c4 warms ${warmTable.c4} frames`);
  check(warmTable.c5 > warmTable.c1,
    'and one of the same take with a longer head is warmed further, so the bound is the head '
    + 'rather than a constant', `c5 warms ${warmTable.c5} against c1's ${warmTable.c1}`);
  check(warmTable.c1 > 0 && warmTable.c1 < 30,
    'a clip whose head is shorter than the look asks for is warmed with what the head affords '
    + 'rather than off the front of the take', `c1 warms ${warmTable.c1} frames of 30 asked for`);
  check(warmed.warmedFrames > 0,
    'and playing up to a cut really does step a clip nobody can see yet',
    `${warmed.warmedFrames} warmed clip-frames`);
  check(warmed.showingBefore.some((s) => s.showing === 'warming'),
    'which is what the composite says it is doing just before the cut',
    warmed.showingBefore.map((s) => `${s.id} ${s.showing}`).join(', '));

  // 7f. A seek can begin after a later clip has already entered its warm window. It has to
  // rebuild the elapsed part of that invisible work before playback continues to the cut.
  const WARM_SEEK_SEC = 2.5;
  const WARM_CUT_SEC = 3.1;
  const warmClip = {
    ...FIXTURE_CLIPS.find((clip) => clip.id === 'c2'),
    look: { fade: MULTI_LOOK.fade, wake: MULTI_LOOK.wake },
  };
  const warmSeekLook = { ...MULTI_LOOK, 'datamosh.amount': 0 };
  const warmHeldDocument = await page.evaluate('__kinect.library.serialiseProjectBody()');
  await page.evaluate(
    `globalThis.__mc.load(${JSON.stringify([warmClip])}, ${JSON.stringify(SECOND_TAKE
      ? { id: SECOND_TAKE.id, hash: SECOND_TAKE.hash } : null)}, ${JSON.stringify(warmSeekLook)})`,
  );
  await page.evaluate(`globalThis.__mc.warmArm = async (kind, label, frames) => {
    const k = globalThis.__kinect;
    const tl = globalThis.__tl;
    const t = k.timeline.transport();
    const before = tl.counters();
    let seek;
    if (kind === 'playback') {
      await t.seek(0.5);
      await t.runTo(t.frameAt(${WARM_CUT_SEC}));
    } else {
      seek = await t.seek(${WARM_SEEK_SEC}, frames === null ? {} : { frames });
      await t.runTo(t.frameAt(${WARM_CUT_SEC}));
    }
    const pixels = tl.grab(label);
    return {
      hash: await tl.sha(pixels),
      delta: tl.since(before),
      seek,
      showingAtSeek: k.timeline.showingAt(${WARM_SEEK_SEC}),
      clip: k.timeline.clips()[0],
      fps: t.outputFps,
      look: { fade: k.params.get('fade'), wake: k.params.get('wake') },
      state: k.stateStats(),
    };
  }`);
  const warmPlayed = await page.evaluate("globalThis.__mc.warmArm('playback', 'warmPlayed', null)");
  const warmSeeked = await page.evaluate("globalThis.__mc.warmArm('seek', 'warmSeeked', null)");
  const warmControl = await page.evaluate("globalThis.__mc.warmArm('seek', 'warmControl', 0)");
  const warmSame = await diff('warmPlayed', 'warmSeeked');
  const warmApart = await diff('warmPlayed', 'warmControl');
  console.log(`\n  seek at ${WARM_SEEK_SEC}s inside c2's warm window, then run to ${WARM_CUT_SEC}s: `
    + `planned ${warmSeeked.seek.plan.surface} elapsed warm frames and rendered `
    + `${warmSeeked.seek.frames}; played vs seeked ${show(warmSame)}, played vs no elapsed warm `
    + `${show(warmApart)}`);
  console.log(`  at ${warmSeeked.fps} fps the clip reports ${warmSeeked.clip.warmFrames} warm frames; `
    + `the arm reads fade ${warmSeeked.look.fade}ms plus wake ${warmSeeked.look.wake}ms; its surface `
    + `reports ${warmSeeked.state.ghostsDrawn}% ghosting, `
    + `against ${warmControl.state.ghostsDrawn}% with elapsed warming omitted`);
  check(warmSeeked.showingAtSeek.length === 1
    && warmSeeked.showingAtSeek[0].showing === 'warming'
    && warmSeeked.clip.take?.id === TAKE,
  'the seek starts while the later clip is warming but still invisible',
  `${warmSeeked.showingAtSeek.map((clip) => `${clip.id} ${clip.showing}`).join(', ')}, `
    + `on ${warmSeeked.clip.take?.id ?? 'no take'}`);
  check(warmSeeked.seek.plan.surface > 0
    && warmSeeked.seek.frames >= warmSeeked.seek.plan.surface,
  'the seek plan includes the elapsed part of that warm window',
  `${warmSeeked.seek.plan.surface} elapsed warm frames inside ${warmSeeked.seek.frames} total pre-roll frames`);
  check(warmSame.max <= SAME_MAX,
    'continuing from the seek reaches the cut with the same picture as uninterrupted playback',
    show(warmSame));
  check(warmApart.max >= 4 && warmApart.pct >= 0.5,
    'and omitting the elapsed warm history reaches a different picture, so the equality above '
      + 'is about work the later clip did before it appeared',
    show(warmApart));
  check(warmApart.max > warmSame.max + 4,
    'the warm-window verdicts are separated rather than adjacent',
    `control max ${warmApart.max} against ${warmSame.max}`);

  await page.evaluate(async (body) => {
    globalThis.__kinect.library.restoreProject(body);
    await globalThis.__kinect.timeline.settled();
  }, warmHeldDocument);

  // What the warm actually buys, read off the surface memory rather than off the counters: a
  // build that skipped it renders a self-consistent picture - the seek and the playback both
  // enter cold and agree with each other - so the rows above cannot see it and this one can.
  //
  // c1 and c5 are the arms because they stand on the same source frame at every program position
  // they share. Same take, same frame, same look: the only thing that differs at 2.1s is that c1
  // has been playing since the head of the edit and c5 entered a tenth of a second ago.
  const shedding = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    await t.seek(2.1);
    const at = (id) => {
      k.timeline.select(id);
      return { stats: k.stateStats(), applied: k.timeline.clips().find((c) => c.id === id).applied };
    };
    const settled = at('c1');
    const entered = at('c5');
    k.timeline.select('c1');
    return { settled, entered };
  })()`);
  const shed = (a) => a.stats.ghostsDrawn;
  console.log(`\n  at 2.1s, both on source frame ${shedding.settled.applied}: c1 has been playing `
    + `since the head of the edit and sheds ${shed(shedding.settled)}% of the frame; c5 entered `
    + `0.1s ago with a ${warmTable.c5}-frame warm behind it and sheds ${shed(shedding.entered)}%`);
  // Within one frame rather than exactly equal: the cursor is where each clip's walk has got to,
  // and a clip that entered a tenth of a second ago has consumed one fewer pair than one that
  // has been walking since the head of the edit. One pair apart on a 9.3fps take is the same
  // footage, which is what this row is about.
  check(Math.abs(shedding.settled.applied - shedding.entered.applied) <= 1,
    'the two clips really are standing on the same footage, which is what makes this an A/B on '
    + 'the history rather than on the pictures',
    `${shedding.settled.applied} and ${shedding.entered.applied}`);
  check(shed(shedding.settled) > 1,
    'the reading is about something: the settled clip is shedding a real fraction of the frame',
    `${shed(shedding.settled)}%`);
  check(Math.abs(shed(shedding.entered) - shed(shedding.settled)) <= shed(shedding.settled) * 0.25,
    'and a clip a tenth of a second past its cut is shedding what the clip beside it has taken '
    + 'the whole edit to build, which is what the warm before its in-point buys',
    `${shed(shedding.entered)}% against ${shed(shedding.settled)}%`);

  const entries = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    const before = { ...k.timeline.counters };
    await t.seek(0);
    await t.runTo(t.frameAt(9.5));
    return {
      entered: k.timeline.counters.clipEntries - before.clipEntries,
      reEntered: k.timeline.counters.clipReEntries - before.clipReEntries,
    };
  })()`);
  console.log(`  a walk over the whole edit entered ${entries.entered} clips, `
    + `${entries.reEntered} of them holding something they had already drawn`);
  check(entries.entered >= FIXTURE_CLIPS.length,
    'a walk over the whole edit enters every clip in it', `${entries.entered} entries`);
  check(entries.reEntered === 0,
    'and none of them was re-entered holding an earlier pass, because a clip goes off, warming, '
    + 'live, off in that order and every move that breaks the order resets first',
    `${entries.reEntered} re-entries`);
}


// The persistence a cache is sized against here: two seconds of it, which is an ordinary look
// and 60 output frames of pre-roll at 30fps. `MULTI_LOOK` is deliberately shorter than this.
const STACK_LOOK = { ...BLACKWALL_LOOK, fade: 500, wake: 1500, trails: 0, additive: false };
// Where the stacked clips are seeked to, and how far apart their in-points are cut into the take.
const STACK_TARGET_SEC = 3;
const STACK_GAP_SEC = 1;
const STACK_LENGTH_SEC = 6;
const STACK_ARMS = [1, 2, 4, CLIP_CEILING];

const RELEASED_DEMAND_CLIPS = [
  { id: 'cached', start: 40, length: 8, speed: 4, sourceStart: 0, second: false,
    look: { fade: 2000, wake: 5000 } },
  { id: 'current', start: 0, length: 6, speed: 1, sourceStart: 0, second: true,
    look: { fade: 100, wake: 0 } },
];

/** N clips of one take, all live at the target, each cut a second further into the footage. */
const stackOf = (n) => Array.from({ length: n }, (_, i) => ({
  id: `s${i}`,
  start: 0,
  length: STACK_LENGTH_SEC,
  speed: 1,
  sourceStart: i * STACK_GAP_SEC,
  second: false,
  look: {},
}));

console.log('\n== 8. the frame cache is sized by the clips asking for it ==');
{
  console.log(`  ${STACK_ARMS.join(', ')} clips of ${TAKE} at fade ${STACK_LOOK.fade}ms plus wake `
    + `${STACK_LOOK.wake}ms, every one of them live at ${STACK_TARGET_SEC}s and cut `
    + `${STACK_GAP_SEC}s further into the take than the one before it.`);
  console.log(`  the cache: a floor of ${CACHE.floor} frames, a budget of `
    + `${(CACHE.budgetBytes / (1024 * 1024)).toFixed(0)} MB at ${CACHE.frameBytes} bytes a frame, `
    + `so a ceiling of ${CACHE.ceiling} and a span of ${CACHE.span}.`);

  // Loaded once before the measured arms, so every arm is built from a stack document rather
  // than the first one from whatever the section above it left on the page.
  await page.evaluate(
    `globalThis.__mc.load(${JSON.stringify(stackOf(1))}, null, ${JSON.stringify(STACK_LOOK)})`,
  );

  const stacked = [];
  for (const n of STACK_ARMS) {
    await page.evaluate(
      `globalThis.__mc.load(${JSON.stringify(stackOf(n))}, null, ${JSON.stringify(STACK_LOOK)})`,
    );
    const timings = await page.evaluate(`__kinect.library.serialiseProjectBody().clips.map((clip) => ({
      id: clip.id,
      speed: clip.speed,
      sourceStart: clip.sourceStart,
    }))`);
    const shot = await page.evaluate(
      `globalThis.__mc.arm('seek', ${STACK_TARGET_SEC}, 0, 'stack${n}', null)`,
    );
    stacked.push({ n, shot, timings });
    const s = shot.seek;
    console.log(`  ${String(n).padStart(2)} clip(s): pre-roll ${s.plan.frames} asked `
      + `(surface ${s.plan.surface}, trails ${s.plan.trails}), ${s.frames} `
      + `rendered${s.capped ? ` - CAPPED ${s.shortfall} short` : ''}; the take is asked for `
      + `${s.bound.frames} frames by ${s.bound.clips} clip(s), holds ${shot.clips[0].capacity}, `
      + `and has ${shot.clips[0].cached} decoded`);
    if (n === CLIP_CEILING) {
      console.log(`     spans ${shot.spans.map((span) => `${span.id}:${span.from}-${span.to}`).join(' ')}`);
    }
  }

  const one = stacked.find((a) => a.n === 1);
  const most = stacked[stacked.length - 1];
  console.log(`  the widest arm's clip timings: ${most.timings
    .map((timing) => `${timing.id}:${timing.sourceStart}@${timing.speed}x`).join(' ')}`);

  check(most.shot.clips.every((clip) => clip.take?.id === TAKE)
    && new Set(most.shot.clips.map((clip) => clip.applied)).size === CLIP_CEILING,
  'the stacked fixture stays on its named take and reaches a different source frame through every in-point it authored',
  most.shot.clips.map((clip) => `${clip.id}:${clip.take?.id ?? 'none'}@${clip.applied}`).join(' '));

  check(stacked.every(({ shot }) => shot.seek.frames === shot.seek.plan.frames),
    'every arm rendered the whole pre-roll it computed, however many clips of one take asked '
    + 'that one cache for a window of their own',
    stacked.map(({ n, shot }) => `${n}:${shot.seek.frames}/${shot.seek.plan.frames}`).join(' '));
  check(stacked.every(({ shot }) => shot.seek.capped === false),
    'and none of them reports itself capped', stacked.map(({ n, shot }) => `${n}:${shot.seek.capped}`).join(' '));
  check(stacked.every(({ shot }) => shot.seek.plan.frames === one.shot.seek.plan.frames),
    'the arms all computed the same pre-roll, so what differs between them is how many clips '
    + 'are asking for it and not how long it is',
    stacked.map(({ n, shot }) => `${n}:${shot.seek.plan.frames}`).join(' '));
  const staggerFrames = Math.round(STACK_GAP_SEC * 30);
  const unionFrames = one.shot.seek.bound.frames + (CLIP_CEILING - 1) * staggerFrames;
  check(most.shot.seek.bound.clips === CLIP_CEILING
    && most.shot.seek.bound.frames === unionFrames,
  `the widest arm puts all ${CLIP_CEILING} clips on one take and counts overlapping frame `
    + 'windows once',
  `${most.shot.seek.bound.clips} clips asking ${most.shot.seek.bound.frames} frames against `
    + `${unionFrames} in their union`);
  check(most.shot.seek.bound.frames > CACHE.floor,
    'and it asks for more of one take than the floor a single clip is sized at, so the arm is '
    + 'outside what a constant cache could have held',
    `${most.shot.seek.bound.frames} frames against a floor of ${CACHE.floor}`);
  check(one.shot.clips[0].capacity === CACHE.floor,
    'a one-clip project caches exactly what it always did, because the floor is what a take '
    + 'holds when one clip is asking',
    `${one.shot.clips[0].capacity} frames`);
  check(most.shot.clips[0].capacity > CACHE.floor
    && most.shot.clips[0].capacity >= most.shot.clips[0].demand,
  'and the widest arm bought a cache above that floor, big enough for what it asked for',
  `${most.shot.clips[0].capacity} frames for a demand of ${most.shot.clips[0].demand}`);
  check(most.shot.clips[0].cached > CACHE.floor,
    'which the take is actually holding: more frames are decoded than a constant cache would '
    + 'have kept, read off the cache rather than off the number that sizes it',
    `${most.shot.clips[0].cached} decoded against a floor of ${CACHE.floor}`);
  check(stacked.every(({ shot }) => shot.clips[0].capacity <= CACHE.ceiling),
    'and no arm went past the ceiling the memory budget buys',
    stacked.map(({ n, shot }) => `${n}:${shot.clips[0].capacity}`).join(' '));
  check(CACHE.span >= unionFrames,
    `the ceiling covers the union of all ${CLIP_CEILING} clips this build composites at `
    + `${(STACK_LOOK.fade + STACK_LOOK.wake) / 1000}s of persistence each`,
    `a span of ${CACHE.span} against a union of ${unionFrames}`);
  check(Math.floor(CACHE.budgetBytes / CACHE.frameBytes) === CACHE.ceiling,
    'and it is a memory budget with the frame count derived from it, rather than a frame count '
    + 'with a memory figure written beside it',
    `${(CACHE.budgetBytes / (1024 * 1024)).toFixed(0)} MB / ${CACHE.frameBytes} B = ${CACHE.ceiling}`);
}

console.log('\n== 8a. a take outside the current plan releases the previous plan\'s cache ==');
if (SECOND_TAKE) {
  const releaseClips = RELEASED_DEMAND_CLIPS.map((clip) => ({
    ...clip,
    take: clip.id === 'cached'
      ? { id: PRIMARY_TAKE.id, hash: PRIMARY_TAKE.hash }
      : { id: SECOND_TAKE.id, hash: SECOND_TAKE.hash },
  }));
  const stagedRelease = await page.evaluate(
    `globalThis.__mc.load(${JSON.stringify(releaseClips)}, null, ${JSON.stringify(STACK_LOOK)})`,
  );
  const held = await page.evaluate("globalThis.__mc.arm('seek', 47, 0, 'demandHeld', null)");
  const releasePlan = await page.evaluate(`(() => {
    const plan = __kinect.timeline.transport().planSeek(1);
    return plan.spans.map((span) => ({ clip: span.clip.id, take: span.take.id,
      from: span.from, to: span.to }));
  })()`);
  const released = await page.evaluate("globalThis.__mc.arm('seek', 1, 0, 'demandReleased', null)");
  await page.evaluate('new Promise((resolve) => { setTimeout(resolve, 250); })');
  released.clips = await page.evaluate('__kinect.timeline.clips()');
  const takeCaches = await page.evaluate('__kinect.timeline.takeCaches()');
  const before = held.clips.find((clip) => clip.id === 'cached');
  const after = released.clips.find((clip) => clip.id === 'cached');
  const current = released.clips.find((clip) => clip.id === 'current');
  console.log(`  ${TAKE}: demand ${before.demand}, capacity ${before.capacity}, cached ${before.cached}; `
    + `after the plan moves to ${SECOND_TAKE.id}: demand ${after.demand}, capacity `
    + `${after.capacity}, cached ${after.cached}`);
  console.log(`  release plan: ${releasePlan.map((span) => `${span.clip}/${span.take} ${span.from}-${span.to}`).join(', ')}`);
  console.log(`  staged slots: ${stagedRelease.map((clip) => `${clip.id}/${clip.take.id}:${clip.takeSlot}`).join(', ')}`);
  console.log(`  open takes: ${takeCaches.map((take) => `${take.id} d${take.demand} c${take.cached}`).join(', ')}`);
  check(releasePlan.length === 1 && releasePlan[0].clip === 'current'
    && releasePlan[0].take === SECOND_TAKE.id,
  'the release plan names only the current clip on the other take',
  releasePlan.map((span) => `${span.clip}/${span.take}`).join(', '));
  check(before.demand > CACHE.floor && before.cached > CACHE.floor,
    'the first plan made the parked take hold more than the cache floor, so the release below '
      + 'has memory to release rather than only a demand number to change',
    `demand ${before.demand}, cached ${before.cached}, floor ${CACHE.floor}`);
  check(current.demand > 0 && after.demand === 0,
    'when the current plan names only the other take, the parked take has no retained demand',
    `current demand ${current.demand}, parked demand ${after.demand}`);
  check(after.capacity === CACHE.floor && after.cached <= CACHE.floor,
    'and it trims the parked take back to the cache floor immediately',
    `capacity ${after.capacity}, cached ${after.cached}, floor ${CACHE.floor}`);
} else {
  console.log('  NOT RUN: the library holds no second take, so one take cannot leave the plan '
    + 'while remaining open in the document');
}



// Three clips of one take whose only difference is the persistence in their own look blocks. The
// long one is warming at the target and the short one is idle there, so what each clip asks its
// take for depends on that clip's own values and on nothing shared.
const MIXED_TARGET_SEC = 3;
const MIXED_CLIPS = [
  { id: 'live', start: 0, length: 12, speed: 1, sourceStart: 0, second: false, look: {} },
  { id: 'warmLong', start: 3.5, length: 4, speed: 1, sourceStart: 20, second: false,
    look: { fade: 1500, wake: 4000 } },
  { id: 'warmShort', start: 3.5, length: 4, speed: 1, sourceStart: 40, second: false,
    look: { fade: 100, wake: 0 } },
];

const PREFETCH_CLIPS = Array.from({ length: CLIP_CEILING }, (_, i) => ({
  id: `p${i}`,
  start: 0,
  length: 2,
  speed: 4,
  sourceStart: i * 5,
  second: false,
  look: {},
}));

console.log('\n== 8b. the demand is each clip\'s own, not one persistence for the project ==');
{
  await page.evaluate(
    `globalThis.__mc.load(${JSON.stringify(MIXED_CLIPS)}, null, ${JSON.stringify(STACK_LOOK)})`,
  );
  const shot = await page.evaluate(
    `globalThis.__mc.arm('seek', ${MIXED_TARGET_SEC}, 0, 'mixed', null)`,
  );
  const blocks = await page.evaluate(`(() => globalThis.__kinect.library.serialiseProjectBody()
    .clips.map((c) => ({ id: c.id, fade: c.params.fade, wake: c.params.wake })))()`);
  const warm = Object.fromEntries(shot.clips.map((c) => [c.id, c.warmFrames]));
  const showing = Object.fromEntries(shot.showing.map((s) => [s.id, s.showing]));

  for (const b of blocks) {
    console.log(`    ${b.id.padEnd(10)} fade ${String(b.fade).padStart(4)} wake `
      + `${String(b.wake).padStart(4)} -> warms ${String(warm[b.id]).padStart(3)} frames, `
      + `${showing[b.id]} at ${MIXED_TARGET_SEC}s`);
  }
  console.log(`  the take is asked for ${shot.seek.bound.frames} frames by `
    + `${shot.seek.bound.clips} of the ${blocks.length} clips cut on it`);

  check(new Set(blocks.map((b) => `${b.fade}/${b.wake}`)).size === 3,
    'the three clips really do carry three different persistences in their own blocks, which is '
    + 'what makes the rows below a claim rather than a description of one look',
    blocks.map((b) => `${b.id} ${b.fade}/${b.wake}`).join(', '));
  check(warm.warmLong > warm.warmShort * 10,
    'and each one warms for a window worked out from its own values',
    `${warm.warmLong} frames against ${warm.warmShort}`);
  check(showing.live === 'live' && showing.warmLong === 'warming' && showing.warmShort === 'off',
    'so two clips placed at the same instant differ in whether they are warming there at all',
    Object.entries(showing).map(([id, s]) => `${id}:${s}`).join(' '));
  check(shot.seek.bound.clips === 2,
    'and the take is asked for a window by the two clips that are touching it and not by the '
    + 'third, so the demand a cache is sized against is read per clip rather than from one '
    + 'persistence held for the project',
    `${shot.seek.bound.clips} of ${blocks.length} clips`);
  check(shot.seek.frames === shot.seek.plan.frames && shot.seek.capped === false,
    'and the seek still renders the whole pre-roll it computed',
    `${shot.seek.frames}/${shot.seek.plan.frames}, capped ${shot.seek.capped}`);
}

console.log('\n== 8c. playback prefetch is bounded by each shared take\'s combined demand ==');
{
  await page.evaluate(
    `globalThis.__mc.load(${JSON.stringify(PREFETCH_CLIPS)}, null, ${JSON.stringify(STACK_LOOK)})`,
  );
  const plan = await page.evaluate(`(async () => {
    const t = __kinect.timeline.transport();
    await t.seek(0);
    if (typeof t.planPrefetch !== 'function') return { available: false };
    const planned = t.planPrefetch();
    const load = Object.fromEntries([...planned.load].map(([take, frames]) => [take.id, frames]));
    const fullLoad = Object.fromEntries([...planned.fullLoad].map(([take, frames]) => [take.id, frames]));
    return {
      available: true,
      ahead: planned.ahead,
      target: planned.target,
      spans: planned.spans.map((span) => ({ id: span.clip.id, from: span.from, to: span.to })),
      load,
      fullLoad,
    };
  })()`);
  const full = plan.available ? Math.max(...Object.values(plan.fullLoad)) : 0;
  const held = plan.available ? Math.max(...Object.values(plan.load)) : 0;
  console.log(plan.available
    ? `  full horizon ${plan.ahead} asks ${full} frames; bounded horizon ${plan.target} asks ${held}`
    : '  the transport exposes no prefetch plan');
  check(plan.available && plan.spans.length === CLIP_CEILING && full > CACHE.span,
    `the fixture puts ${CLIP_CEILING} disjoint 4x windows on one take and overfills an uncapped prefetch`,
    plan.available ? `${plan.spans.length} spans asking ${full} frames against ${CACHE.span}` : 'no plan');
  check(plan.available && plan.target < plan.ahead && held <= CACHE.span,
    'prefetch shortens the common output horizon until the union fits the shared take cache',
    plan.available ? `target ${plan.target}/${plan.ahead}, ${held}/${CACHE.span} frames` : 'no plan');
}

if (SHOTS) {
  await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    await globalThis.__tl.configure(${JSON.stringify({ look: BLACKWALL_LOOK, rate: 1, fps: 30 })});
    await k.timeline.transport().seek(${TARGET_SEC});
  })()`);
  await page.screenshot({ path: join(SHOTS, 'timeline-check.png') });
  console.log(`\n[timeline] screenshot written to ${join(SHOTS, 'timeline-check.png')}`);
}


if (errors.length) console.log(`\n[timeline] page errors:\n  ${errors.join('\n  ')}`);
check(errors.length === 0, 'the page logged no errors');

await browser.close();
console.log(`\n[timeline] ${failures === 0
  ? `PASS (${assertions} assertions)`
  : `FAIL (${failures}/${assertions} assertions failed)`}`);
if (MUTATE && MUTATIONS[MUTATE]?.fails) console.log(`[timeline] it should redden: ${MUTATIONS[MUTATE].fails}`);
process.exit(failures === 0 ? 0 : 1);
