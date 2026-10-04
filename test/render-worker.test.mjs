// The render worker's claim loop, driven in process against a scripted queue and a scripted
// browser: heartbeats that outlive their claim, a render that must stop after seven failed beats,
// a cancel, and a report the queue would not record as done. No server, no browser, no GPU.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runQueue } from '../tools/render-worker.mjs';
import { BEAT_BUDGET } from '../server/jobs.js';

const BASE = 'http://queue.test';
const HASH = `sha256:${'a'.repeat(64)}`;
const RENDERER = 'ANGLE Metal / Apple M2 Max';
const BEAT_MS = 1000;
const CONTINUE = { status: 200, body: { cancelRequested: null } };

const deferred = () => {
  const out = {};
  out.promise = new Promise((resolve, reject) => { out.resolve = resolve; out.reject = reject; });
  return out;
};
const turn = () => new Promise((done) => { setImmediate(done); });
const settle = async () => { for (let i = 0; i < 8; i++) await turn(); };
// Bounded, so a worker that never reaches the state a test waits for fails the test rather than
// hanging it.
async function until(what, ready, ms = 10_000) {
  for (const began = Date.now(); !ready();) {
    if (Date.now() - began > ms) throw new Error(`gave up waiting for ${what}`);
    await turn();
  }
}

const makeJob = (name) => ({
  id: `job-${name}`,
  lease: `lease-${name}`,
  width: 64,
  height: 36,
  fps: 30,
  codec: 'h264',
  output: name,
  warnings: [],
  requires: [],
  suppressEffects: [],
  captures: [HASH],
  deliverable: null,
  project: { version: 9, clips: [{ take: { hash: HASH } }] },
});

const withSignal = (promise, signal) => (!signal ? promise : new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  promise.then(resolve, reject);
}));

/**
 * A queue server in a function. `beat({ id, count })` answers the `count`th heartbeat of a job with
 * `{ status, body }`, or a promise of it; one that never settles is a connection that goes silent.
 * `finish` answers a report the same way. A request carrying a signal fails when it aborts, as
 * undici's does, unless `honorsSignal` is false: that is a reply arriving after its request was
 * given up on, which a claim must be able to ignore for itself.
 */
function fakeQueue(jobs, { beat = () => CONTINUE, finish = null, honorsSignal = true } = {}) {
  const queue = { waiting: [...jobs], finishes: [], beats: [] };
  const counts = new Map();
  const send = ({ status, body }) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  queue.fetch = async (url, init = {}) => {
    const path = url.slice(BASE.length);
    if (init.method === undefined) {
      if (path === '/effects') return send({ status: 200, body: { effects: [] } });
      if (path === '/library/takes') return send({ status: 200, body: { takes: [{ id: 'take', hash: HASH }] } });
      throw new Error(`the scripted queue has no GET ${path}`);
    }
    const body = JSON.parse(init.body);
    if (path === '/jobs/claim') {
      return send({ status: 200, body: { job: queue.waiting.shift() ?? null } });
    }
    const [, id, verb] = path.match(/^\/jobs\/([^/]+)\/(heartbeat|finish)$/) ?? [];
    if (verb === 'heartbeat') {
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      queue.beats.push({ id, count, signal: init.signal });
      const answer = Promise.resolve(beat({ id, count })).then(send);
      return honorsSignal ? withSignal(answer, init.signal) : answer;
    }
    if (verb === 'finish') {
      queue.finishes.push({ id, body });
      return send(finish ? await finish({ id, body }) : { status: 200, body: { id, state: body.state } });
    }
    throw new Error(`the scripted queue has no POST ${path}`);
  };
  return queue;
}

/**
 * A browser whose pages answer what the worker asks of them. An export started in a page stays
 * pending until the test resolves it, or the page closes, which rejects it the way a closed
 * target does.
 */
function fakeBrowser() {
  const browser = { pages: [] };
  browser.newPage = async () => {
    const page = { closed: false, runs: [], project: null };
    const alive = async () => {
      if (page.closed) throw new Error('Target page, context or browser has been closed');
    };
    page.on = () => {};
    page.isClosed = () => page.closed;
    page.goto = alive;
    page.waitForFunction = alive;
    page.close = async () => {
      page.closed = true;
      for (const run of page.runs) run.reject(new Error('page.evaluate: Target page, context or browser has been closed'));
    };
    const kinect = {
      export: {
        rendererClass: () => RENDERER,
        run: (options) => new Promise((resolve, reject) => { page.runs.push({ options, resolve, reject }); }),
      },
      library: {
        loadProject: async (id, project) => { page.project = project; },
        applyDeliverable: () => {},
        opened: () => true,
        serialiseProjectBody: () => ({ clips: page.project.clips }),
      },
      timeline: { transport: () => ({ programSec: 0, seek: async () => {} }), settled: async () => {} },
    };
    // Runs the worker's own in-page function against this page's stand-in for the editor.
    page.evaluate = async (fn, arg) => {
      await alive();
      globalThis.__kinect = kinect;
      return fn(arg);
    };
    browser.pages.push(page);
    return page;
  };
  return browser;
}

/**
 * A run of the worker over `jobs`, with the clock for its heartbeats in the test's hands. The mocks
 * belong to the test `t`, which puts them back when it ends.
 */
function drive(t, jobs, queueOptions = {}, { max = jobs.length, beatMs = BEAT_MS } = {}) {
  const browser = fakeBrowser();
  const queue = fakeQueue(jobs, queueOptions);
  const lines = [];
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(console, 'log', (...a) => lines.push(a.join(' ')));
  t.mock.method(console, 'error', (...a) => lines.push(a.join(' ')));
  t.after(() => { delete globalThis.__kinect; });
  const run = runQueue({
    browser, fetch: queue.fetch, url: BASE, name: 'worker', max, drain: true, pollMs: 1, beatMs,
  });
  // A worker that threw is the finding, and what a wait would otherwise time out on.
  let crash = null;
  run.catch((err) => { crash = err; });
  const wait = (what, ready, ms) => until(what, () => {
    if (crash) throw crash;
    return ready();
  }, ms);
  return { browser, queue, lines, run, wait, beat: () => t.mock.timers.tick(beatMs) };
}

const rendered = (name) => ({ output: `/exports/${name}.1-1/${name}.mp4`, frames: 3 });

for (const honorsSignal of [false, true]) {
  test(`replies to a finished job's heartbeats cannot touch the next job (${honorsSignal ? 'requests aborted' : 'replies ignored'})`, async (t) => {
    const [a, b] = [makeJob('a'), makeJob('b')];
    // Two of A's heartbeats stay in the air, to be answered once B is rendering: the cancel the
    // queue sent before it saw A finish, and a refusal of the lease A has by then spent.
    const held = [];
    const w = drive(t, [a, b], {
      honorsSignal,
      beat: ({ id }) => {
        if (id !== a.id) return CONTINUE;
        const reply = deferred();
        held.push(reply);
        return reply.promise;
      },
    });
    await w.wait('A to be rendering', () => w.browser.pages[0]?.runs.length === 1);
    w.beat();
    await settle();
    assert.equal(held.length, 2, 'two heartbeats of A are in flight');
    const page = w.browser.pages[0];
    page.runs[0].resolve(rendered('a'));
    await w.wait('B to be rendering', () => page.runs.length === 2);
    assert.ok(w.queue.beats.filter((beat) => beat.id === a.id).every((beat) => beat.signal.aborted),
      'A\'s requests were given up on when A ended, answered or not');
    held[0].resolve({ status: 200, body: { cancelRequested: 1 } });
    held[1].resolve({ status: 409, body: { error: 'job job-a is already done' } });
    await settle();
    assert.equal(page.closed, false, 'B\'s page is still open');
    page.runs[1].resolve(rendered('b'));
    assert.deepEqual(await w.run, { claimed: 2, failed: 0, cancelled: 0, blockedExit: false });
    assert.deepEqual(w.queue.finishes.map((f) => [f.id, f.body.state]), [[a.id, 'done'], [b.id, 'done']],
      'B finished normally, and nothing was reported about A a second time');
  });
}

test('seven failed heartbeats stop the render and report failure, and six do not', async (t) => {
  const [a, b] = [makeJob('a'), makeJob('b')];
  const w = drive(t, [a, b], {
    beat: ({ id }) => (id === a.id ? { status: 500, body: {} } : CONTINUE),
  });
  await w.wait('A to be rendering', () => w.browser.pages[0]?.runs.length === 1);
  const first = w.browser.pages[0];
  await settle();
  for (let failed = 1; failed < BEAT_BUDGET; failed++) {
    assert.equal(w.queue.beats.length, failed);
    assert.equal(first.closed, false, `the render goes on after ${failed} failed heartbeat${failed === 1 ? '' : 's'}`);
    w.beat();
    await settle();
  }
  assert.equal(first.closed, true, `the ${BEAT_BUDGET}th failure closes the page the export runs in`);
  await w.wait('B to be rendering', () => w.browser.pages[1]?.runs.length === 1);
  assert.equal(w.queue.finishes[0].id, a.id);
  assert.equal(w.queue.finishes[0].body.state, 'failed');
  assert.match(w.queue.finishes[0].body.error, new RegExp(`${BEAT_BUDGET} heartbeats failed in a row`));
  assert.equal(w.queue.finishes[0].body.lease, a.lease);
  assert.equal(w.queue.beats.filter((beat) => beat.id === a.id).length, BEAT_BUDGET, 'and A is not beaten for again');
  const second = w.browser.pages[1];
  second.runs[0].resolve(rendered('b'));
  const result = await w.run;
  assert.deepEqual(result, { claimed: 2, failed: 1, cancelled: 0, blockedExit: false },
    'the next claim renders on a page of its own');
  assert.equal(w.queue.finishes[1].body.state, 'done');
});

test('seven heartbeats that never answer fail by timeout and stop the render too', async (t) => {
  const a = makeJob('a');
  // A connection that went quiet: nothing comes back, so only the request's own timeout ends it.
  const w = drive(t, [a], { beat: () => new Promise(() => {}) }, { beatMs: 20 });
  await w.wait('A to be rendering', () => w.browser.pages[0]?.runs.length === 1);
  for (let beat = 1; beat < BEAT_BUDGET; beat++) w.beat();
  const page = w.browser.pages[0];
  await w.wait('the worker to give the claim up', () => page.closed);
  const result = await w.run;
  assert.deepEqual(result, { claimed: 1, failed: 1, cancelled: 0, blockedExit: false });
  assert.equal(w.queue.finishes.length, 1);
  assert.equal(w.queue.finishes[0].body.state, 'failed');
  assert.match(w.queue.finishes[0].body.error, new RegExp(`${BEAT_BUDGET} heartbeats failed in a row, the last because .*timeout`));
});

test('an answered heartbeat clears the count, so failures with answers between them never add up', async (t) => {
  const a = makeJob('a');
  const w = drive(t, [a], {
    beat: ({ count }) => (count === BEAT_BUDGET ? CONTINUE : { status: 500, body: {} }),
  });
  await w.wait('A to be rendering', () => w.browser.pages[0]?.runs.length === 1);
  for (let beat = 1; beat < 2 * BEAT_BUDGET - 1; beat++) {
    w.beat();
    await settle();
  }
  const page = w.browser.pages[0];
  assert.equal(w.queue.beats.length, 2 * BEAT_BUDGET - 1);
  assert.equal(page.closed, false, 'six failures, an answer, six more: the render is still going');
  page.runs[0].resolve(rendered('a'));
  assert.deepEqual(await w.run, { claimed: 1, failed: 0, cancelled: 0, blockedExit: false });
  assert.equal(w.queue.finishes[0].body.state, 'done');
});

test('a cancel request in a heartbeat stops the render and reports cancelled', async (t) => {
  const a = makeJob('a');
  const w = drive(t, [a], { beat: ({ count }) => (count === 2 ? { status: 200, body: { cancelRequested: 5 } } : CONTINUE) });
  await w.wait('A to be rendering', () => w.browser.pages[0]?.runs.length === 1);
  await settle();
  w.beat();
  assert.deepEqual(await w.run, { claimed: 1, failed: 0, cancelled: 1, blockedExit: false });
  assert.equal(w.browser.pages[0].closed, true);
  assert.deepEqual(w.queue.finishes.map((f) => [f.body.state, f.body.lease]), [['cancelled', a.lease]]);
});

test('a refused lease stops the render and reports nothing', async (t) => {
  const a = makeJob('a');
  const w = drive(t, [a], { beat: ({ count }) => (count === 2 ? { status: 409, body: { error: 'held by another claim' } } : CONTINUE) });
  await w.wait('A to be rendering', () => w.browser.pages[0]?.runs.length === 1);
  await settle();
  w.beat();
  assert.deepEqual(await w.run, { claimed: 1, failed: 1, cancelled: 0, blockedExit: false });
  assert.equal(w.queue.finishes.length, 0, 'there is no claim left to report against');
  assert.ok(w.lines.some((l) => /heartbeat refused: held by another claim/.test(l)));
});

test('a claim is not over until its page has closed, so the next one never starts beside it', async (t) => {
  const [a, b] = [makeJob('a'), makeJob('b')];
  const w = drive(t, [a, b], { beat: ({ id }) => (id === a.id ? { status: 500, body: {} } : CONTINUE) });
  const closed = deferred();
  await w.wait('A to be rendering', () => w.browser.pages[0]?.runs.length === 1);
  const first = w.browser.pages[0];
  const close = first.close;
  first.close = async () => { await close(); await closed.promise; };
  for (let beat = 1; beat < BEAT_BUDGET; beat++) w.beat();
  await w.wait('the worker to give A up', () => first.closed);
  await settle();
  assert.equal(w.queue.waiting.length, 1, 'B has not been claimed while A\'s page is still closing');
  assert.equal(w.browser.pages.length, 1);
  closed.resolve();
  await w.wait('B to be rendering', () => w.browser.pages[1]?.runs.length === 1);
  w.browser.pages[1].runs[0].resolve(rendered('b'));
  assert.deepEqual(await w.run, { claimed: 2, failed: 1, cancelled: 0, blockedExit: false });
});

test('a done report the queue records as failed is a failed job, and is not reported twice', async (t) => {
  const a = makeJob('a');
  const w = drive(t, [a], {
    finish: ({ id }) => ({ status: 200, body: { id, state: 'failed', error: 'the render reported done but its artifact "/x" could not take the version record' } }),
  });
  await w.wait('A to be rendering', () => w.browser.pages[0]?.runs.length === 1);
  w.browser.pages[0].runs[0].resolve(rendered('a'));
  assert.deepEqual(await w.run, { claimed: 1, failed: 1, cancelled: 0, blockedExit: false });
  assert.equal(w.queue.finishes.length, 1, 'the queue already has the outcome');
  assert.ok(w.lines.some((l) => /job-a failed: the render reported done but its artifact/.test(l)), 'and the reason is printed');
  assert.ok(!w.lines.some((l) => /job-a done /.test(l)), 'where the worker would otherwise have said done');
});
