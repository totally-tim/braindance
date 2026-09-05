// What a second, third and fourth overlapping clip cost, interleaved against one clip.
//
// Three arms plus a fourth that adds a warming clip to four visible ones, rotated round-robin so
// a machine that drifts during the run drifts across all of them. Every timed block renders a
// fixed run of output frames with its bytes already resident, so what is measured is the draw,
// the texture upload and the surface-memory step - the fetch and the decode are measured
// separately, on the pass that makes the block resident.
//
// Three readings decide whether a block is believable, and a block failing any of them is
// discarded rather than reported. It rendered every frame it was asked for - a short block means
// the cache did not hold the window, and its timing is a fact about the fetch instead. It drew
// and warmed the clips its arm declares, counted per frame, so a block that quietly measured
// four clips where the arm asked for four and a warming fifth cannot be averaged in. And the
// page reported nothing: an error mid-block is a fact about that frame, not about layering.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const URL_BASE = flag('--url', 'http://localhost:8080');
const TAKE = flag('--take', 'sample');
const ROUNDS = Number(flag('--rounds', '16'));
const WARMUP = Number(flag('--warmup', '4'));
const BLOCK = Number(flag('--block', '15'));
const OUT_FPS = 30;
const STAGE = { width: 1280, height: 720 };

// Where the timed block runs. Far enough into every clip that none of them is still warming.
const WINDOW_SEC = 3;

// One clip per source offset, so each of them consumes a source frame of its own on every output
// frame - which is the layering an editor actually produces and the one that decodes N times.
const OFFSETS = [0.5, 2.5, 4.5, 6.5];

// A look that sheds. The registry's default fade is 120ms with no wake, which puts the geometry
// on one vertex per point instead of two - half the draw - and a warming clip a tenth of a second
// ahead of its in-point instead of a full second. Neither is the case this budget is about.
// Persistence long enough that the warming clip below is warming for the whole timed block, and
// short enough that the block plus its pre-roll still fits one take's cache at five clips.
const LOOK = { fade: 300, wake: 300, trails: 0, additive: false };

// The persistence the cap below is measured at. A second of it is an ordinary look and it is
// what four clips of one take cannot have: the pre-roll it asks for plus the block behind it is
// more of one take than its cache holds.
const LONG_LOOK = { fade: 500, wake: 1500, trails: 0, additive: false };
const ARMS = [
  { label: '1 clip', live: 1, warming: 0 },
  { label: '2 clips', live: 2, warming: 0 },
  { label: '4 clips', live: 4, warming: 0 },
  { label: '4 live + 1 warming', live: 4, warming: 1 },
];

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

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const quantile = (xs, q) => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};

const index = await (await fetch(`${URL_BASE}/capture/${TAKE}/index`)).json();
const stamps = index.frames.stampMs;
const DURATION = (stamps[stamps.length - 1] - stamps[0]) / 1000;
const NEEDS_TAKE_SEC = 12;
if (!(DURATION >= NEEDS_TAKE_SEC)) {
  console.log(`\n[layering] DID NOT RUN - the take "${TAKE}" holds ${DURATION.toFixed(2)}s and these `
    + `arms need ${NEEDS_TAKE_SEC}s, because the four clips are cut at four offsets into it.`);
  process.exit(2);
}

// One output frame past the end of the timed block, which is where a clip has to start for its
// warm window to cover every frame of that block.
const WARM_START = WINDOW_SEC + (BLOCK + 1) / OUT_FPS;
// What the look asks the warm to be, which has to reach back over the whole block or the arm
// measures four clips and an idle one.
const WARM_FRAMES = Math.ceil(((LOOK.fade + LOOK.wake) / 1000) * OUT_FPS);
if (WARM_FRAMES < BLOCK + 1) {
  console.log(`\n[layering] DID NOT RUN - a warm window of ${WARM_FRAMES} frames does not cover a `
    + `${BLOCK}-frame block, so the fifth clip would be idle for most of it and the arm would `
    + 'measure four clips twice. Shorten --block or lengthen the look.');
  process.exit(2);
}

const widest = Math.max(...ARMS.map((a) => a.live + a.warming));

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ channel: 'chromium', headless: true });
const context = await browser.newContext({ viewport: STAGE, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (err) => errors.push(String(err)));
page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

await page.goto(`${URL_BASE}/edit?take=${encodeURIComponent(TAKE)}`, { waitUntil: 'load' });
await page.waitForFunction(() => !!globalThis.__kinect);
await page.waitForFunction(() => !!globalThis.__kinect.timeline.transport(), null, { timeout: 20000 });
// The lane stack is built when the open finishes, not when the transport appears, and a strip
// measured before it has its rows grows under the viewport that was just sized to it. The loop
// below cannot recover from that on its own: it breaks out the moment the buffer matches, and a
// pre-lane measurement can match. So the open is waited for first, and the loop is left in place
// for the resize itself.
await page.waitForFunction(() => globalThis.__kinect.takeOpened(), null, { timeout: 60000 });
// The stage is the viewport less the furniture, and the furniture is only there once the take has
// opened - so it is measured after the transport exists and the viewport grown to suit. Twice,
// because the lane stack is built after that and a strip read before its rows grows underneath.
let stageLanded = false;
for (let attempt = 0; attempt < 3; attempt++) {
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
  stageLanded = await page.waitForFunction((want) => {
    const gl = globalThis.__kinect?.renderer?.getContext?.();
    return !!gl && gl.drawingBufferWidth === want.w && gl.drawingBufferHeight === want.h;
  }, { w: STAGE.width, h: STAGE.height }, { timeout: 15000 }).then(() => true).catch(() => false);
  if (stageLanded) break;
}
if (!stageLanded) {
  console.log(`\n[layering] DID NOT RUN - the drawing buffer did not reach ${STAGE.width}x${STAGE.height} after 3 attempts.`);
  await browser.close();
  process.exit(2);
}

// A timed block has to be resident before it is timed, so the widest arm's clips have to fit one
// take's cache between them - a block that does not fit stalls on the first step and times
// nothing. Read off the page rather than restated here, because the ceiling is derived from a
// memory budget and a copy of the number it currently comes to would drift from it.
const CACHE_SPAN = await page.evaluate(() => globalThis.__kinect.timeline.cache().span);
if ((BLOCK + 1) * widest > CACHE_SPAN) {
  console.log(`\n[layering] DID NOT RUN - a block of ${BLOCK} frames across ${widest} clips wants `
    + `${(BLOCK + 1) * widest} frames of one take at once and the cache holds ${CACHE_SPAN}. The `
    + `block would stall rather than be timed. Pass --block ${Math.floor(CACHE_SPAN / widest) - 1} `
    + 'or fewer.');
  await browser.close();
  process.exit(2);
}

const gpu = await page.evaluate(() => {
  const gl = globalThis.__kinect.renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    buffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
  };
});
if (/swiftshader|software|llvmpipe/i.test(gpu.renderer)) {
  throw new Error(`software rasteriser (${gpu.renderer}) - the numbers would mean nothing`);
}

await page.evaluate(`(() => {
  const k = globalThis.__kinect;
  globalThis.__ab = {
    /** The arm's document: as many clips over the window as it asks for, plus a warming one. */
    async load(arm, offsets, windowSec, look, warmStart) {
      const base = k.library.serialiseProjectBody();
      const one = base.clips[0];
      // Written into each clip's own block rather than applied afterwards: a look applied through
      // the registry lands on the selected clip alone now, so an arm that did that would time one
      // clip at this look and the rest at the registry's defaults - which is half the draw.
      const scoped = (want, scope) => Object.fromEntries(
        Object.entries(want).filter(([n]) => k.params.spec(n).scope === scope),
      );
      const mine = scoped(look, 'clip');
      const clips = [];
      for (let i = 0; i < arm.live; i++) {
        clips.push({ ...one, id: 'v' + i, start: 0, length: 12, speed: 1, sourceStart: offsets[i],
          params: { ...one.params, ...mine } });
      }
      for (let i = 0; i < arm.warming; i++) {
        // Placed one frame past the end of the timed block, so it is inside its own warm window
        // for every frame of that block rather than idle for most of it and warming for the last
        // few. Its head is real footage, so what it costs is a real warm.
        clips.push({
          ...one,
          id: 'w' + i,
          start: warmStart,
          length: 6,
          speed: 1,
          sourceStart: offsets[offsets.length - 1] + 1,
          params: { ...one.params, ...mine },
        });
      }
      await k.library.loadProject('layering ab', {
        ...base,
        look: { ...base.look, params: { ...base.look.params, ...scoped(look, 'project') } },
        clips,
      });
      await k.timeline.settled();
      return {
        clips: k.timeline.clips().map((c) => ({ id: c.id, warm: c.warmFrames })),
        // Read back off the clips rather than trusted: an arm whose look reached one clip and not
        // the others would time two different draws and average them.
        additive: k.timeline.clips().map((c) => c.additive),
        // Two vertices per point while the surface memory is shedding and one otherwise, so this
        // says which of the two draws the numbers below are about.
        drawRange: k.geometry.drawRange.count,
      };
    },

    /** A run of frames nothing has fetched yet, so the clock is on the fetch and the decode. */
    async cold(windowSec, frames) {
      const t = k.timeline.transport();
      await t.seek(windowSec);
      const before = { ...k.timeline.counters };
      const began = performance.now();
      await t.runTo(t.frameAt(windowSec) + frames);
      const ms = performance.now() - began;
      return {
        ms,
        fetched: k.timeline.counters.framesFetched - before.framesFetched,
        decoded: k.timeline.counters.bitmapDecodes - before.bitmapDecodes,
        requests: k.timeline.counters.requests - before.requests,
      };
    },

    /** One timed block: made resident first, then rendered with the clock on it. */
    async block(windowSec, frames) {
      const t = k.timeline.transport();
      const from = t.frameAt(windowSec);
      // The residency pass, and where the fetch and the decode are measured.
      await t.seek(windowSec);
      const fetchBefore = { ...k.timeline.counters };
      const fetchBegan = performance.now();
      await t.runTo(from + frames);
      const fetchMs = performance.now() - fetchBegan;
      const fetched = k.timeline.counters.framesFetched - fetchBefore.framesFetched;
      const decoded = k.timeline.counters.bitmapDecodes - fetchBefore.bitmapDecodes;

      // Back to the head of the window, with everything it walks already in the cache.
      await t.seek(windowSec);
      const before = { ...k.timeline.counters };
      const began = performance.now();
      let rendered = 0;
      for (let i = 0; i < frames; i++) {
        if (!t.step()) break;
        rendered++;
      }
      // Reads the buffer back, which is what makes the wall clock above include the GPU rather
      // than only the calls that queued the work.
      k.drive.readPixels();
      const ms = performance.now() - began;
      const after = k.timeline.counters;
      return {
        ms,
        rendered,
        asked: frames,
        drawn: after.clipsDrawn - before.clipsDrawn,
        warmed: after.clipsWarmed - before.clipsWarmed,
        refetched: after.framesFetched - before.framesFetched,
        fetchMs,
        fetched,
        decoded,
      };
    },
  };
  return true;
})()`);

console.log(`[layering] ${gpu.renderer}`);
console.log(`[layering] stage ${gpu.buffer.join('x')}, take ${TAKE}: ${stamps.length} frames, `
  + `${DURATION.toFixed(2)}s source`);
console.log(`[layering] ${ROUNDS} rounds of ${BLOCK} output frames per arm, first ${WARMUP} `
  + 'discarded, arms rotated each round so a drifting machine drifts across all of them');

const samples = new Map(ARMS.map((a) => [a.label, []]));
// Measured clip-draws per frame, so the column that reports them is a reading rather than a
// restatement of what the arm was configured to do.
const drawnPerFrame = new Map(ARMS.map((a) => [a.label, []]));
const shortBlocks = [];
const unexercised = [];
let refetches = 0;
let drawRange = 0;
let warmWindow = 0;
const warmedPerBlock = [];

// The fetch and the decode, measured once on a window nothing has touched. It is a cost per
// source frame rather than per clip, which is the whole point: two clips wanting one frame pay
// it once, and two clips at different offsets pay it twice.
await page.evaluate(
  `globalThis.__ab.load(${JSON.stringify(ARMS[0])}, ${JSON.stringify(OFFSETS)}, ${WINDOW_SEC}, ${JSON.stringify(LOOK)}, ${WARM_START})`,
);
const COLD_SEC = 8;
const cold = await page.evaluate(`globalThis.__ab.cold(${COLD_SEC}, 40)`);

for (let round = 0; round < ROUNDS + WARMUP; round++) {
  // Rotated rather than shuffled: every arm sits in every position across the run, so an arm
  // never keeps the place in the round where the machine happens to be busiest.
  for (let k = 0; k < ARMS.length; k++) {
    const arm = ARMS[(round + k) % ARMS.length];
    const loaded = await page.evaluate(
      `globalThis.__ab.load(${JSON.stringify(arm)}, ${JSON.stringify(OFFSETS)}, ${WINDOW_SEC}, `
      + `${JSON.stringify(LOOK)}, ${WARM_START})`,
    );
    drawRange = loaded.drawRange;
    warmWindow = loaded.clips.find((c) => c.id.startsWith('w'))?.warm ?? warmWindow;
    if (new Set(loaded.additive).size !== 1) {
      console.log(`\n[layering] DID NOT RUN - ${arm.label} came up with ${loaded.additive.join(', ')} `
        + 'for its clips\' blend, so the look reached some of them and not others and the arm '
        + 'would be timing two different draws.');
      process.exit(2);
    }
    const out = await page.evaluate(`globalThis.__ab.block(${WINDOW_SEC}, ${BLOCK})`);
    if (out.rendered !== out.asked || out.refetched > 0) {
      shortBlocks.push(`${arm.label} round ${round}: ${out.rendered}/${out.asked} rendered, `
        + `${out.refetched} frames fetched inside the block`);
      refetches += out.refetched;
      continue;
    }
    // Every clip the arm declares had to be drawn, or warmed, on every frame of the block. The
    // counters increment once per clip per frame, so the arm's own numbers are the expectation -
    // and without this the fifth clip can idle through the block while the row reads as though it
    // warmed throughout, which is the one arm the whole harness exists to price.
    const wantDrawn = arm.live * out.rendered;
    const wantWarmed = arm.warming * out.rendered;
    if (out.drawn !== wantDrawn || out.warmed !== wantWarmed) {
      unexercised.push(`${arm.label} round ${round}: drew ${out.drawn} of ${wantDrawn} `
        + `clip-frames and warmed ${out.warmed} of ${wantWarmed}`);
      continue;
    }
    if (round >= WARMUP) {
      samples.get(arm.label).push(out.ms / out.rendered);
      drawnPerFrame.get(arm.label).push(out.drawn / out.rendered);
      if (arm.warming > 0) warmedPerBlock.push(out.warmed);
    }
  }
}

console.log(`\n  look: fade ${LOOK.fade}ms, wake ${LOOK.wake}ms, no trails, depth-writing. `
  + `${drawRange} vertices per cloud per frame (two per point, the shedding draw). The warming `
  + `clip's window is ${warmWindow} output frames, and it warmed a median of `
  + `${warmedPerBlock.length ? median(warmedPerBlock) : 0} clip-frames per ${BLOCK}-frame block, `
  + `which has to be ${BLOCK} for the fifth clip to have been warming throughout.`);
console.log('\n  arm                     ms/frame   p25     p75    n   clip-draws/frame');
const rows = [];
for (const arm of ARMS) {
  const xs = samples.get(arm.label);
  if (xs.length === 0) {
    console.log(`  ${arm.label.padEnd(22)} no clean block`);
    continue;
  }
  const row = { arm, med: median(xs), lo: quantile(xs, 0.25), hi: quantile(xs, 0.75), n: xs.length };
  rows.push(row);
  const drew = drawnPerFrame.get(arm.label);
  console.log(`  ${arm.label.padEnd(22)} ${row.med.toFixed(3).padStart(7)} `
    + `${row.lo.toFixed(3).padStart(7)} ${row.hi.toFixed(3).padStart(7)} ${String(row.n).padStart(4)}`
    + `   ${drew.length ? median(drew) : '-'}`);
}

// The health reading: the one-clip arm measured over the first half of the rounds against the
// second, held against that arm's own interquartile range rather than against a percentage. A
// fixed percentage is a claim about how noisy this rig is, and the spread the run just measured
// is the honest version of that claim - a machine that stayed quiet drifts inside its own noise.
const one = samples.get('1 clip');
const half = Math.floor(one.length / 2);
const spread = quantile(one, 0.75) - quantile(one, 0.25);
const moved = half > 0 ? Math.abs(median(one.slice(0, half)) - median(one.slice(half))) : Infinity;
// A run with no accepted block cannot have drifted, and saying it did misattributes a gate's
// refusal to the machine. The gates below discard blocks, so an empty arm is now a state worth
// distinguishing rather than a division nobody reaches.
const measured = one.length > 0;
const drifted = measured && !(moved <= spread);
console.log(`\n  health: the 1-clip arm reads ${median(one.slice(0, half)).toFixed(3)} ms/frame over `
  + `the first half of the rounds and ${median(one.slice(half)).toFixed(3)} over the second, `
  + `${moved.toFixed(3)} ms apart against its own ${spread.toFixed(3)} ms interquartile spread`);
if (shortBlocks.length) {
  console.log(`  ${shortBlocks.length} block(s) discarded for not rendering the whole run or `
    + `fetching inside it (${refetches} frames):`);
  for (const line of shortBlocks.slice(0, 6)) console.log(`    ${line}`);
}

const base = rows.find((r) => r.arm.label === '1 clip');
if (base) {
  console.log('');
  for (const row of rows) {
    const perClip = (row.med - base.med) / Math.max(1, row.arm.live + row.arm.warming - 1);
    console.log(`  ${row.arm.label.padEnd(22)} ${(row.med / base.med).toFixed(2)}x one clip, `
      + `${(row.med - base.med >= 0 ? '+' : '')}${(row.med - base.med).toFixed(3)} ms `
      + `(${perClip.toFixed(3)} ms per extra cloud)`);
  }
}
{
  console.log(`\n  fetch and decode, cold: ${cold.fetched} source frames in ${cold.ms.toFixed(0)} ms `
    + `over ${cold.requests} request(s), ${(cold.ms / cold.fetched).toFixed(2)} ms per source frame `
    + `(${cold.decoded} JPEGs decoded). It is a cost per source frame and not per clip: two clips `
    + 'wanting one frame pay it once and two at different offsets pay it twice, and the prefetch '
    + 'runs it ahead of the playhead rather than inside a rendered frame.');
}

// What the cache does under the same arms at an ordinary persistence, which is the bound this
// step actually runs into: a plan is per clip and the cache is per take, so four clips of one
// take ask for four times the window and the seek gets walked in until it fits.
const capped = [];
for (const arm of ARMS) {
  await page.evaluate(
    `globalThis.__ab.load(${JSON.stringify(arm)}, ${JSON.stringify(OFFSETS)}, ${WINDOW_SEC}, `
    + `${JSON.stringify(LONG_LOOK)}, ${WARM_START})`,
  );
  const seek = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const t = k.timeline.transport();
    const out = await t.seek(${WINDOW_SEC});
    return out && {
      asked: out.plan.frames, rendered: out.frames, capped: out.capped, shortfall: out.shortfall,
      sourceFrames: out.sourceFrames,
    };
  })()`);
  capped.push({ arm, seek });
}
console.log(`\n  at fade ${LONG_LOOK.fade}ms plus wake ${LONG_LOOK.wake}ms, all clips on one take:`);
for (const { arm, seek } of capped) {
  if (!seek) {
    console.log(`  ${arm.label.padEnd(22)} the seek stood down`);
    continue;
  }
  console.log(`  ${arm.label.padEnd(22)} pre-roll ${String(seek.asked).padStart(3)} frames asked, `
    + `${String(seek.rendered).padStart(3)} rendered, ${seek.sourceFrames} source frames wanted`
    + `${seek.capped ? ` - CAPPED by the cache, ${seek.shortfall} short` : ''}`);
}

const budget = 1000 / 30;
const four = rows.find((r) => r.arm.label === '4 clips');
const plusWarm = rows.find((r) => r.arm.label === '4 live + 1 warming');
console.log(`\n  the budget is four overlapping clips at ${budget.toFixed(1)} ms per output frame.`);
for (const row of [four, plusWarm].filter(Boolean)) {
  console.log(`  ${row.arm.label.padEnd(22)} ${row.med.toFixed(2)} ms/frame `
    + `= ${(row.med / budget * 100).toFixed(0)}% of it, `
    + `${row.med <= budget ? 'inside' : 'OVER'}`);
}
// An arm with no accepted block cannot take part in the comparison the harness exists to make,
// so a run missing one is not a run with a gap - it is a run that did not answer its question.
// Found by the control that empties the warming arm alone: the other three arms survived, the
// run printed their rows and exited 0, and the one comparison it is for was silently absent.
const armsEmpty = ARMS.filter((a) => samples.get(a.label).length === 0).map((a) => a.label);
if (measured && armsEmpty.length) {
  console.log(`\n[layering] THROW THIS RUN AWAY - ${armsEmpty.join(' and ')} came back with no `
    + 'block the gates would accept, so the arms cannot be compared and the rows that did print '
    + 'are about a question nobody asked. The discards below say why.');
}
if (!measured) {
  console.log('\n[layering] THROW THIS RUN AWAY - not one block survived the gates, so there is no '
    + 'reading here at all and nothing above is about layering. The discards below say why.');
} else if (drifted) {
  console.log('\n[layering] THROW THIS RUN AWAY - the 1-clip arm moved further across the run than '
    + 'its own spread, so the machine was competing and the ratios above are a fact about that.');
}
if (errors.length) {
  console.log('\n[layering] THROW THIS RUN AWAY - the page reported an error, so at least one '
    + 'frame in this run did something other than draw the arm, and which frame is not recorded:'
    + `\n  ${errors.join('\n  ')}`);
}
if (unexercised.length) {
  console.log(`\n[layering] ${unexercised.length} block(s) discarded for not exercising their arm:`
    + `\n  ${unexercised.slice(0, 6).join('\n  ')}`);
}

await browser.close();
process.exit(!measured || armsEmpty.length > 0 || drifted || errors.length > 0 ? 1 : 0);
