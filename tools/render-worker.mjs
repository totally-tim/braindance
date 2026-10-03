#!/usr/bin/env node
// The headless worker: claim a job, render it in a real browser, report back. It renders through
// the page's own export door and encodes through the server's own socket, so neither is
// reimplemented here. The renderer class is read from the browser this worker will actually render
// in, never configured.
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { JOB_VERSION } from '../server/jobs.js';
import { testTimer } from '../web/test-timers.js';

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const has = (name) => argv.includes(name);

const URL_ = flag('--url', 'http://localhost:8080');
const NAME = flag('--name', 'worker');
const MAX = Number(flag('--max', has('--once') ? '1' : '16'));
const IDLE_EXIT = has('--drain');
const POLL_MS = Number(flag('--poll', '2000'));
const BEAT_MS = Number(flag('--beat', '15000'));

if (has('--help')) {
  console.log(`usage: render-worker.mjs [--url URL] [--name NAME] [--once | --max N]
                        [--drain] [--poll MS] [--beat MS]

  Claims render jobs and runs them in headless Chrome, reporting each outcome
  back to the queue. The renderer class it claims with is read out of the
  browser it will render in, so it cannot be told a class it does not have.

  --drain exits as soon as the queue has nothing for this worker, rather than
  polling. A queue holding work pinned to another renderer class is NOT nothing:
  it is reported and exits non-zero, because an idle worker beside a queue that
  never drains is the failure the class pinning exists to make visible.`);
  process.exit(0);
}

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [async () => import('playwright')];
  try {
    const root = execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim();
    for (const name of ['playwright', '@playwright/cli/node_modules/playwright']) {
      candidates.push(async () => import(pathToFileURL(require.resolve(join(root, name))).href));
    }
  } catch { /* the local resolve above may still work */ }
  for (const load of candidates) {
    try {
      const mod = await load();
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  throw new Error('playwright not found - install it globally or in this project');
}

// A heartbeat unanswered by the time the next one is due has already failed, while a claim or a
// finish report is worth waiting out. undici's default header timeout is around 300s, so an outage
// that drops packets without an RST would leave the budget below counting something
// other than seconds.
const post = async (path, body, { timeoutMs = null } = {}) => {
  const res = await fetch(URL_ + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const { chromium } = await loadPlaywright();
// `channel: 'chromium'` and not the bundled headless shell, which has no GPU and falls back to
// SwiftShader - the software rasteriser the class guard below refuses.
const browser = await chromium.launch({ channel: 'chromium', headless: !has('--headed') });

let claimed = 0;
let failed = 0;
let blockedExit = false;

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The recorder rather than the root, which is the main menu now. This load exists only to read
  // the renderer class off a page with a WebGL context, and the menu has none.
  await page.goto(`${URL_}/record`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => globalThis.__kinect?.export?.rendererClass, null, { timeout: 30000 });

  const renderer = await page.evaluate(() => globalThis.__kinect.export.rendererClass());

  /**
   * One of the queue server's own listings, read and held to a shape, or a sentence saying the
   * read failed. Both readings below go through here, so a store that cannot be reached says so
   * in one voice however many routes a job needs.
   *
   * A read that did not work is never an empty store: `.json()` on a 500 parses `{"error":"..."}`
   * perfectly well and `?? []` read that as nothing installed, so the effects gate below refused
   * the job naming a package the machine has. Status and shape are both checked, and anything
   * short of a listing throws.
   *
   * Retried, because this runs inside the claim, so a transport failure here is a job going
   * terminal as `failed`. Four attempts about ten seconds of trying, comfortably inside the queue's
   * two-minute silence window, with a timeout per attempt for the reason the heartbeat has one.
   *
   * Its own sentence, and the one thing it must never be is either of the two sentences below -
   * about a package this worker has not got, or about footage it has not got. Those three send
   * whoever reads the queue to three different machines.
   */
  const STORE_READ_TRIES = 4;
  const STORE_READ_GAP_MS = testTimer('store-read-gap', 2500);
  const readStore = async (path, what, held) => {
    let last = null;
    for (let attempt = 0; attempt < STORE_READ_TRIES; attempt++) {
      if (attempt) await new Promise((r) => { setTimeout(r, STORE_READ_GAP_MS); });
      try {
        const res = await fetch(`${URL_}${path}`, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`it answered ${res.status}`);
        return held(await res.json());
      } catch (err) {
        last = err;
      }
    }
    throw new Error(
      `this worker could not read ${URL_}${path} in ${STORE_READ_TRIES} attempts `
      + `${STORE_READ_GAP_MS / 1000}s apart, so it does not know ${what} and will `
      + `not guess: ${last?.message ?? 'no attempt reported why'}. This is a failure to read the queue's own server `
      + 'rather than anything about the job, the look it names or the footage it is cut on',
    );
  };

  /**
   * The effect packages this worker's server holds, read once per job - off `/effects`, which is
   * the route the registry itself assembles from.
   *
   * Per job and not once at start: a worker takes up to sixteen jobs, `PUT /effects/:id` happens to
   * a running server, and a package retuned mid-drain would have the skew line quote a build that
   * was replaced an hour ago into the log somebody reads to decide whether a file is a render of
   * what they asked for.
   */
  const readInstalledEffects = () => readStore(
    '/effects', 'which effect packages this machine holds',
    (body) => {
      if (!body || !Array.isArray(body.effects)) {
        throw new Error('it answered a body that is not a list of installed packages');
      }
      for (const e of body.effects) {
        if (!e || typeof e.id !== 'string') throw new Error(`it listed the entry ${JSON.stringify(e)}, which names no id`);
      }
      return {
        installed: new Set(body.effects.map((e) => e.id)),
        versions: new Map(body.effects.map((e) => [e.id, e.version])),
      };
    },
  );

  /** The footage this worker's server holds, as the take id behind each content hash. */
  const readLibraryTakes = () => readStore(
    '/library/takes', 'which footage this machine holds',
    (body) => {
      if (!body || !Array.isArray(body.takes)) {
        throw new Error('it answered a body that is not a list of takes');
      }
      const byHash = new Map();
      for (const t of body.takes) {
        if (!t || typeof t.id !== 'string' || typeof t.hash !== 'string') {
          throw new Error(`it listed the entry ${JSON.stringify(t)}, which names no id and hash`);
        }
        // One take's bytes under two names is one entry: either id fetches the same frames, and
        // the first is the one the listing puts first.
        if (!byHash.has(t.hash)) byHash.set(t.hash, t.id);
      }
      return byHash;
    },
  );

  /**
   * Whether this worker can render a job at all, answered off the job envelope before a page is
   * opened. A second gate over the condition `exportClip` refuses on, and what it buys is the
   * sentence and the cost: a refusal here names the effects and versions the envelope declares,
   * before a minute of GPU produces the identical refusal from the other end. `jobs-check` asserts
   * which refusal a job came back with, so the two are separable by a run. An absent `requires` is
   * nothing required.
   */
  const cannotResolve = (job, installed) => {
    const allowed = new Set(job.suppressEffects ?? []);
    return (job.requires ?? []).filter((e) => !installed.has(e.id) && !allowed.has(e.id));
  };

  /**
   * The take id behind each hash a job names, in the order the job names them. By hash and never
   * by id: an id is a filename, two machines can hold different footage under the same one, and a
   * lookup by id would render whatever happened to be called that and look like it worked.
   *
   * Every hash and not the first: `sourcesFor` refuses the same document from the other end, so a
   * job whose second clip is on footage this machine lacks would otherwise fail in the page's
   * sentence where a job whose first clip is fails in this one - two sentences for one condition.
   */
  const takesForCaptures = async (captures) => {
    const byHash = await readLibraryTakes();
    const missing = [...new Set(captures)].filter((hash) => !byHash.has(hash));
    if (missing.length) {
      // Every hash that is missing, counted against every hash the job names: a partial
      // resolution is the ordinary case for a composite, and "some of this footage is not here"
      // is a different errand from "none of it is".
      throw new Error(
        `no take on this worker hashes ${missing.map((h) => `${h.slice(0, 22)}…`).join(', ')}, so `
        + 'the footage this job was authored against is not here - '
        + `${byHash.size} take(s) present, and ${missing.length} of the ${new Set(captures).size} `
        + `this job names ${missing.length === 1 ? 'is' : 'are'} missing`,
      );
    }
    return captures.map((hash) => byHash.get(hash));
  };
  if (/swiftshader|software|llvmpipe/i.test(renderer)) {
    throw new Error(`this browser is on a software rasteriser (${renderer}), so anything it rendered would be pinned to a class nothing else can reproduce`);
  }
  console.log(`[worker] ${NAME} on ${renderer}`);

  while (claimed < MAX) {
    const claim = await post('/jobs/claim', { worker: NAME, renderer });
    if (claim.status === 409 || claim.status >= 500) {
      // Work exists and none of it is ours, or the queue itself failed. Reported rather than slept
      // on: a worker that quietly polled forever would turn the scheduling failure
      // back into silence.
      console.error(`[worker] ${claim.status} from claim: ${claim.body?.error ?? '(no body)'}`);
      for (const b of claim.body?.blocked ?? []) console.error(`[worker]   ${b.id} wants ${b.wants}`);
      blockedExit = true;
      break;
    }
    if (!claim.body.job) {
      if (IDLE_EXIT) { console.log('[worker] queue empty, draining out'); break; }
      await new Promise((r) => { setTimeout(r, POLL_MS); });
      continue;
    }

    const job = claim.body.job;
    claimed++;
    console.log(`[worker] ${job.id} ${job.width}x${job.height} @${job.fps} -> ${job.output}`);
    errors.length = 0;
    let beat = null;
    let leaseLost = false;
    const stopBeating = () => { if (beat) { clearInterval(beat); beat = null; } };
    const BEAT_BUDGET = 7;
    let missed = 0;
    const heartbeat = async () => {
      if (leaseLost) return;
      const res = await post(`/jobs/${job.id}/heartbeat`, { lease: job.lease }, { timeoutMs: BEAT_MS });
      if (res.status === 409) {
        leaseLost = true;
        stopBeating();
        console.error(`[worker] ${job.id} heartbeat refused: ${res.body?.error ?? 'lease lost'}`);
        page.goto('about:blank').catch(() => { /* the page may already be gone */ });
        return;
      }
      if (res.status !== 200) throw new Error(`the queue answered ${res.status}`);
      missed = 0;
    };
    const missedBeat = (message) => {
      missed++;
      console.error(`[worker] ${job.id} heartbeat failed (${missed}/${BEAT_BUDGET}): ${message}`);
      if (missed < BEAT_BUDGET) return;
      stopBeating();
      console.error(`[worker] ${job.id} ${BEAT_BUDGET} heartbeats failed in a row - this claim now goes quiet while it renders, and a requeue would put a second worker on it`);
    };
    const beatOnce = () => { heartbeat().catch((err) => missedBeat(err.message)); };
    const startBeating = () => {
      beat = setInterval(beatOnce, BEAT_MS);
      beat.unref?.();
      beatOnce();
    };
    try {
      // Inside the try, so a server that cannot be read is this job coming back `failed` naming the
      // read rather than the worker dying before its first claim.
      //
      // The envelope first, before a field is read out of it: a record from another version names
      // its footage somewhere else, and reading it would fail in a sentence about a field that is
      // not there rather than about a job this build cannot run.
      if (job.version !== JOB_VERSION) {
        throw new Error(
          `job ${job.id} is envelope version ${JSON.stringify(job.version)} and this worker runs `
          + `version ${JOB_VERSION}: this repo ships no conversion, so it is refused rather than `
          + 'rendered on a guess about which field holds the footage',
        );
      }
      // Opening every take can exceed the queue's stale window, so the lease starts speaking now.
      startBeating();
      const { installed, versions } = await readInstalledEffects();
      const unresolved = cannotResolve(job, installed);
      if (unresolved.length) {
        throw new Error(
          `this worker has no ${unresolved.map((e) => `${e.id} ${e.version}`).join(', ')}, which `
          + `${unresolved.length === 1 ? 'is' : 'are'} required by this job's look: the values under `
          + `${unresolved.length === 1 ? 'it' : 'them'} would be parked and nothing would draw them, `
          + 'so the render would be a file missing part of the look with nothing in it to say so. '
          + 'Install the package on this worker, or queue the job with suppressEffects naming '
          + `${unresolved.length === 1 ? 'it' : 'each of them'}.`,
        );
      }
      // Said out loud and then rendered anyway: a version is a string a package author writes,
      // nothing in it says which direction is compatible, and refusing here would make every retune
      // a wall in front of every queued job. The silence is what is not acceptable.
      const skewed = (job.requires ?? [])
        .filter((e) => installed.has(e.id) && versions.get(e.id) !== e.version);
      if (skewed.length) {
        console.log(`[worker] ${job.id} renders with ${skewed.map((e) => `${e.id} ${versions.get(e.id)} where the job asks for ${e.version}`).join(', ')} - proceeding on the installed version`);
      }
      // Reopened per job rather than once, because two jobs in a queue are two edits and nothing
      // says they are against the same footage.
      const takeIds = await takesForCaptures(job.captures);
      // The editor has no entry that comes up on nothing - `/edit` with neither a take nor a
      // project redirects to the projects page - so it is brought up on the first clip's footage and the
      // project opens the rest. `openTakes` is keyed by id, so the second open is not a second
      // fetch of that index.
      await page.goto(`${URL_}/edit?take=${encodeURIComponent(takeIds[0])}`, { waitUntil: 'load' });
      // `opened()` rather than the transport: the transport exists a moment before `openTake` has
      // finished fitting the crop box, and a fit still in flight lands on the restored document.
      await page.waitForFunction(() => globalThis.__kinect?.library?.opened() === true, null, { timeout: 60000 });
      errors.length = 0;

      // The project travels in the job rather than by name: a name would resolve to whatever is in
      // the store when the worker gets round to it, which is the opposite of reproducing an edit.
      // `loadProject` and not `restoreProject`: the second is the synchronous door and refuses a
      // clip whose take is not already open, because opening footage is a fetch. This one resolves
      // each clip's take by hash and opens it.
      await page.evaluate(async (j) => {
        await globalThis.__kinect.library.loadProject(j.id, j.project);
      }, job);

      // Attest the footage and renderer before rendering: the job names its footage by content
      // hash, and the renderer class is pinned on the claim.
      const [opened, actualRenderer] = await page.evaluate(() => [
        globalThis.__kinect.library.serialiseProjectBody().clips.map((c) => c.take?.hash ?? null),
        globalThis.__kinect.export.rendererClass(),
      ]);
      // Clip by clip and in order, never as a set: two clips whose footage is swapped hold the same
      // hashes between them and are a different edit, and a set would call that render the one
      // that was asked for. What is read is what the page opened rather than what the document
      // claimed - `clip.take` is written only by `adoptSource`, off the index it actually opened.
      const short = (h) => (typeof h === 'string' ? `${h.slice(0, 22)}…` : 'no take');
      if (opened.length !== job.captures.length || opened.some((h, at) => h !== job.captures[at])) {
        throw new Error(
          `the page opened ${opened.map(short).join(', ')} but the job names `
          + `${job.captures.map(short).join(', ')}, so this render would not be the edit the job asks for`,
        );
      }
      if (actualRenderer !== renderer) {
        throw new Error(`the rendering browser is ${actualRenderer} but the claim was made on ${renderer}`);
      }

      const result = await page.evaluate(async (j) => {
        // Through `applyDeliverable`, which is the door, rather than `setActiveDeliverable` past
        // it: the bare assignment skips the version gate and the refusal of a stored size belonging
        // to another shape. Older jobs carry explicit width/height/fps/codec, so those override
        // when no deliverable is present.
        if (j.deliverable) globalThis.__kinect.library.applyDeliverable(j.deliverable);
        // Settled before exporting, or the deliverable's own repaint lands inside the export's
        // first seek: `ExportTransport` throws on any program position reaching the sink more than
        // once, and it showed up as `the render at 0.000000s reached the export 2 times` on some
        // runs and not others. Then a seek, because the transport is left where it was rather than
        // where the loaded document says - awaiting `settled()` alone narrowed nothing.
        const transport = globalThis.__kinect.timeline.transport();
        await transport.seek(transport.programSec);
        await globalThis.__kinect.timeline.settled();
        return globalThis.__kinect.export.run({
          name: j.output,
          width: j.width,
          height: j.height,
          fps: j.fps,
          codec: j.codec,
          in: j.deliverable?.in,
          out: j.deliverable?.out,
          suppressEffects: j.suppressEffects ?? [],
        });
      }, job);
      if (errors.length) throw new Error(`the page errored during the render: ${errors[0]}`);
      if (!result?.output) throw new Error('the export did not return an output path');
      if (leaseLost) throw new Error('the lease was lost during the render, so the outcome is not accepted');

      // The frame count travels with the outcome, and `server/export.js` refuses a stream whose
      // count differs from the one the export declared. Stopped before the report rather than after
      // it: a beat still in the air when `finish` lands reads the job as `done` and is answered
      // 409, which this loop treats as a revoked lease.
      stopBeating();
      const fin = await post(`/jobs/${job.id}/finish`, {
        state: 'done', output: result.output, frames: result?.frames ?? null, lease: job.lease,
      });
      if (fin.status !== 200) throw new Error(`the queue refused the report: ${fin.body.error}`);
      console.log(`[worker] ${job.id} done ${result.output} ${result?.frames ?? ''} frames`);
    } catch (err) {
      failed++;
      const message = String(err.message ?? err);
      stopBeating();
      console.error(`[worker] ${job.id} failed: ${message}`);
      await post(`/jobs/${job.id}/finish`, { state: 'failed', error: message, lease: job.lease }).catch(() => {});
    }
  }
} finally {
  await browser.close();
}

console.log(`[worker] ${claimed} claimed, ${failed} failed`);
if (blockedExit) process.exit(2);
process.exit(failed ? 1 : 0);
