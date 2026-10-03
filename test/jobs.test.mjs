// The render queue's store, driven in process: cancellation, the heartbeat decision, the version
// record and the refusal of a job file this build did not write. No server and no browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BEAT_BUDGET, JOB_VERSION, JobStore, beatVerdict, environmentRefusal, versionDifferences,
} from '../server/jobs.js';

const METAL = 'ANGLE Metal / Apple M2 Max';
const V3D = 'ANGLE (Broadcom, V3D 7.1.10.2, OpenGL ES 3.1)';
const HASH = `sha256:${'a'.repeat(64)}`;
const PROJECT = {
  version: 9,
  look: { params: { 'rain.amount': 1 } },
  requires: [{ id: 'rain', version: '1.0.0' }],
  clips: [{ take: { hash: HASH } }],
};
const STALE_MS = 1000;

const environment = (over = {}) => ({
  app: 'a'.repeat(64), effects: { rain: '1.0.0', ghost: '2.0.0' }, renderer: METAL, ffmpeg: '7.1', ...over,
});

// A store over a scratch directory, with a clock and an environment the test moves by hand.
async function harness() {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-jobs-'));
  const exportsDir = join(dir, 'exports');
  await mkdir(exportsDir);
  const clock = { t: 1_000_000 };
  const current = { record: environment(), problems: [] };
  const store = new JobStore(join(dir, 'jobs'), {
    exportsDir,
    environment: async (renderer) => ({ record: { ...current.record, renderer }, problems: current.problems }),
    now: () => clock.t,
    staleMs: STALE_MS,
  });
  let n = 0;
  const enqueue = (over = {}) => store.enqueue({
    project: PROJECT, captures: [HASH], output: `out${++n}`, width: 64, height: 36, fps: 30, ...over,
  });
  // The file an export leaves, so a finish has a sidecar to amend.
  const artifact = async (name) => {
    const folder = join(exportsDir, `${name}.1-1`);
    await mkdir(folder);
    const path = join(folder, `${name}.mp4`);
    await writeFile(path, 'video');
    await writeFile(`${path}.job.json`, `${JSON.stringify({ output: name, frames: 3 })}\n`);
    return path;
  };
  return { dir, exportsDir, clock, current, store, enqueue, artifact, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const claimOne = async (h, renderer = METAL) => (await h.store.claim({ worker: 'w', renderer })).job;

test('six failed heartbeats are survived and the seventh gives the claim up', () => {
  let missed = 0;
  for (let beat = 1; beat < BEAT_BUDGET; beat++) {
    const heard = beatVerdict(missed, { error: 'connection refused' });
    assert.equal(heard.verdict, 'continue', `failure ${beat} of ${BEAT_BUDGET}`);
    assert.equal(heard.missed, beat);
    assert.match(heard.reason, /connection refused/);
    missed = heard.missed;
  }
  const last = beatVerdict(missed, { error: 'connection refused' });
  assert.equal(last.verdict, 'abandon');
  assert.match(last.reason, new RegExp(`${BEAT_BUDGET} heartbeats failed in a row`));
});

test('one answered heartbeat clears the failures before it', () => {
  assert.deepEqual(beatVerdict(BEAT_BUDGET - 1, { status: 200, body: { cancelRequested: null } }),
    { missed: 0, verdict: 'continue', reason: null });
  const next = beatVerdict(0, { error: 'x' });
  assert.equal(next.verdict, 'continue', 'the count restarts from nothing');
});

test('an error status counts as a failed heartbeat, like no answer at all', () => {
  const heard = beatVerdict(BEAT_BUDGET - 1, { status: 500, body: {} });
  assert.equal(heard.verdict, 'abandon');
  assert.match(heard.reason, /answered 500/);
});

test('a refused lease stops the worker at once and leaves the count alone', () => {
  const heard = beatVerdict(2, { status: 409, body: { error: 'job is done' } });
  assert.equal(heard.verdict, 'lost');
  assert.equal(heard.missed, 2);
  assert.match(heard.reason, /job is done/);
});

test('a heartbeat that carries a cancel request says cancel, and one that carries none does not', () => {
  assert.equal(beatVerdict(0, { status: 200, body: { cancelRequested: 1234 } }).verdict, 'cancel');
  assert.equal(beatVerdict(0, { status: 200, body: { cancelRequested: null } }).verdict, 'continue');
  assert.equal(beatVerdict(0, { status: 200, body: {} }).verdict, 'continue');
});

test('a queued job is cancelled where it stands, frees its output name and is never claimed', async () => {
  const h = await harness();
  try {
    const queued = await h.enqueue({ output: 'wanted' });
    const cancelled = await h.store.cancel(queued.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.finished, h.clock.t);
    assert.equal((await h.store.read(queued.id)).state, 'cancelled', 'on disk, not just in the answer');
    assert.equal((await h.store.claim({ worker: 'w', renderer: METAL })).job, null);
    await h.enqueue({ output: 'wanted' });
  } finally {
    await h.cleanup();
  }
});

test('cancelling a running job marks it, and the worker that sees the mark reports cancelled', async () => {
  const h = await harness();
  try {
    await h.enqueue();
    const job = await claimOne(h);
    const marked = await h.store.cancel(job.id);
    assert.equal(marked.state, 'running', 'the render is still going until its worker stops it');
    assert.equal(marked.cancelRequested, h.clock.t);
    const beat = await h.store.heartbeat(job.id, { lease: job.lease });
    assert.equal(typeof beat.cancelRequested, 'number', 'the heartbeat is how the worker finds out');
    const done = await h.store.finish(job.id, { state: 'cancelled', lease: job.lease });
    assert.equal(done.state, 'cancelled');
    assert.equal(done.lease, null);
    assert.equal(done.artifactPath, null, 'a cancelled render names no artifact');
  } finally {
    await h.cleanup();
  }
});

test('a worker cannot report cancelled for a job nobody asked to cancel', async () => {
  const h = await harness();
  try {
    await h.enqueue();
    const job = await claimOne(h);
    await assert.rejects(h.store.finish(job.id, { state: 'cancelled', lease: job.lease }), /not asked to cancel/);
    assert.equal((await h.store.read(job.id)).state, 'running');
  } finally {
    await h.cleanup();
  }
});

test('a running job whose worker has gone quiet is cancelled directly, and its lease dies with it', async () => {
  const h = await harness();
  try {
    await h.enqueue();
    const job = await claimOne(h);
    h.clock.t += STALE_MS;
    const cancelled = await h.store.cancel(job.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.lease, null);
    await assert.rejects(h.store.finish(job.id, { state: 'done', lease: job.lease }), /already cancelled/);
  } finally {
    await h.cleanup();
  }
});

test('cancelling twice writes once, and a finished job cannot be cancelled', async () => {
  const h = await harness();
  try {
    await h.enqueue();
    const job = await claimOne(h);
    await h.store.cancel(job.id);
    const writes = h.store.writes;
    await h.store.cancel(job.id);
    assert.equal(h.store.writes, writes, 'the second request changes nothing');
    await h.store.finish(job.id, { state: 'cancelled', lease: job.lease });
    assert.equal((await h.store.cancel(job.id)).state, 'cancelled', 'asking again for what is so is not an error');

    await h.enqueue();
    const next = await claimOne(h);
    await h.store.finish(next.id, { state: 'failed', error: 'x', lease: next.lease });
    await assert.rejects(h.store.cancel(next.id), /already failed/);
  } finally {
    await h.cleanup();
  }
});

test('a render that finished before its worker saw the cancel is reported done', async () => {
  const h = await harness();
  try {
    await h.enqueue();
    const job = await claimOne(h);
    await h.store.cancel(job.id);
    const done = await h.store.finish(job.id, { state: 'done', output: await h.artifact('late'), frames: 3, lease: job.lease });
    assert.equal(done.state, 'done');
  } finally {
    await h.cleanup();
  }
});

test('a cancelled job can be queued again, with the cancel request gone', async () => {
  const h = await harness();
  try {
    const queued = await h.enqueue();
    await h.store.cancel(queued.id);
    const again = await h.store.requeue(queued.id);
    assert.equal(again.state, 'queued');
    assert.equal(again.cancelRequested, null);
    assert.equal((await claimOne(h)).id, queued.id);

    // The mark of a worker that died before it saw it is not a cancel of the next claim.
    await h.store.cancel(queued.id);
    h.clock.t += STALE_MS;
    const revived = await h.store.requeue(queued.id);
    assert.equal(revived.cancelRequested, null);
  } finally {
    await h.cleanup();
  }
});

test('a claim records what it will render on, and says nothing when there is nothing to compare', async () => {
  const h = await harness();
  try {
    await h.enqueue();
    const job = await claimOne(h);
    assert.deepEqual(job.versions.claimed, environment());
    assert.equal(job.versions.recorded, null);
    assert.deepEqual(job.warnings, []);
  } finally {
    await h.cleanup();
  }
});

test('a job whose recorded environment differs still claims, and says what differs', async () => {
  const h = await harness();
  try {
    await h.enqueue({ recorded: environment({
      app: 'b'.repeat(64), effects: { rain: '0.9.0', ghost: '1.0.0' }, renderer: V3D, ffmpeg: '6.0',
    }) });
    const job = await claimOne(h, METAL);
    assert.equal(job.state, 'running', 'the render goes ahead');
    assert.deepEqual(job.warnings.map((w) => w.field).sort(), ['app', 'effects.rain', 'ffmpeg', 'renderer']);
    for (const w of job.warnings) assert.equal(w.at, 'claim');
    const app = job.warnings.find((w) => w.field === 'app');
    assert.equal(app.was, 'b'.repeat(64));
    assert.equal(app.now, 'a'.repeat(64));
    assert.match(app.text, /app build changed from bbbbbbbbbbbb to aaaaaaaaaaaa/);
    assert.match(job.warnings.find((w) => w.field === 'effects.rain').text, /rain changed from 0\.9\.0 to 1\.0\.0/);
    assert.deepEqual((await h.store.read(job.id)).warnings, job.warnings, 'the warning is in the job on disk');
  } finally {
    await h.cleanup();
  }
});

test('an effect the job does not use cannot warn', async () => {
  const h = await harness();
  try {
    await h.enqueue({ recorded: environment({ effects: { rain: '1.0.0', ghost: '0.1.0', extra: '1.0.0' } }) });
    const job = await claimOne(h);
    assert.deepEqual(job.warnings, []);
  } finally {
    await h.cleanup();
  }
});

test('a render that ran on a different environment than it started on warns at finish and in its sidecar', async () => {
  const h = await harness();
  try {
    await h.enqueue();
    const job = await claimOne(h);
    h.current.record = environment({ app: 'c'.repeat(64), effects: { rain: '2.0.0', ghost: '2.0.0' } });
    const output = await h.artifact('moved');
    const done = await h.store.finish(job.id, { state: 'done', output, frames: 3, lease: job.lease });
    assert.deepEqual(done.warnings.map((w) => [w.at, w.field]), [['finish', 'app'], ['finish', 'effects.rain']]);
    assert.equal(done.versions.finished.app, 'c'.repeat(64));
    assert.equal(done.versions.claimed.app, 'a'.repeat(64), 'the claim keeps what it saw');

    const sidecar = JSON.parse(await readFile(`${output}.job.json`, 'utf8'));
    assert.equal(sidecar.output, 'moved', 'what the export wrote is kept');
    assert.deepEqual(sidecar.versions, done.versions);
    assert.deepEqual(sidecar.warnings, done.warnings);
    assert.deepEqual(await readdir(join(h.exportsDir, 'moved.1-1')), ['moved.mp4', 'moved.mp4.job.json'], 'no scratch file is left');
  } finally {
    await h.cleanup();
  }
});

test('a sidecar outside the exports directory is not written, and the job says so', async () => {
  const h = await harness();
  try {
    await h.enqueue();
    const job = await claimOne(h);
    const stray = join(h.dir, 'elsewhere.mp4');
    await writeFile(`${stray}.job.json`, '{"output":"stray"}\n');
    const done = await h.store.finish(job.id, { state: 'done', output: stray, frames: 3, lease: job.lease });
    assert.equal(done.state, 'done', 'the render itself is not failed for it');
    assert.match(done.warnings.find((w) => w.field === 'sidecar').text, /outside the exports directory/);
    assert.equal(await readFile(`${stray}.job.json`, 'utf8'), '{"output":"stray"}\n', 'the file is untouched');
  } finally {
    await h.cleanup();
  }
});

test('a sidecar that is missing is a warning on a job that is still done', async () => {
  const h = await harness();
  try {
    await h.enqueue();
    const job = await claimOne(h);
    const done = await h.store.finish(job.id, {
      state: 'done', output: join(h.exportsDir, 'nowhere', 'gone.mp4'), frames: 3, lease: job.lease,
    });
    assert.equal(done.state, 'done');
    assert.match(done.warnings.find((w) => w.field === 'sidecar').text, /could not take the version record/);
  } finally {
    await h.cleanup();
  }
});

test('a part of the environment that could not be read is a warning, not a failed claim', async () => {
  const h = await harness();
  try {
    await h.enqueue();
    h.current.record = environment({ ffmpeg: null });
    h.current.problems = [{ field: 'ffmpeg', text: 'ffmpeg could not be resolved: no ffmpeg on PATH' }];
    const job = await claimOne(h);
    assert.equal(job.state, 'running');
    assert.equal(job.versions.claimed.ffmpeg, null);
    assert.deepEqual(job.warnings.map((w) => [w.at, w.field, w.text]),
      [['claim', 'ffmpeg', 'ffmpeg could not be resolved: no ffmpeg on PATH']]);
  } finally {
    await h.cleanup();
  }
});

test('a finished render is what the next one is compared against, and a failed one is not', async () => {
  const h = await harness();
  try {
    await h.enqueue();
    const first = await claimOne(h);
    await h.store.finish(first.id, { state: 'done', output: await h.artifact('first'), frames: 3, lease: first.lease });
    h.current.record = environment({ app: 'd'.repeat(64) });
    const again = await h.store.requeue(first.id);
    assert.equal(again.versions.recorded.app, 'a'.repeat(64));
    assert.deepEqual(again.warnings, []);
    const second = await claimOne(h);
    assert.deepEqual(second.warnings.map((w) => w.field), ['app'], 'the build moved between the two renders');

    await h.store.finish(second.id, { state: 'failed', error: 'x', lease: second.lease });
    h.current.record = environment({ app: 'e'.repeat(64) });
    const retried = await h.store.requeue(second.id);
    assert.equal(retried.versions.recorded.app, 'a'.repeat(64), 'a failed attempt did not become the reference');
  } finally {
    await h.cleanup();
  }
});

test('versionDifferences compares ffmpeg only when both sides could read it', () => {
  assert.deepEqual(versionDifferences(environment({ ffmpeg: null }), environment({ ffmpeg: '7.1' })), []);
  assert.deepEqual(versionDifferences(environment({ ffmpeg: '7.1' }), environment({ ffmpeg: null })), []);
  assert.deepEqual(versionDifferences(null, environment()), []);
  assert.equal(versionDifferences(environment({ effects: {} }), environment(), ['rain'])[0].text,
    'effect rain changed from not installed to 1.0.0');
});

test('a recorded environment of the wrong shape is refused at enqueue', async () => {
  const h = await harness();
  try {
    await assert.rejects(h.enqueue({ recorded: { app: 'x' } }), /recorded versions/);
    await assert.rejects(h.enqueue({ recorded: { ...environment(), effects: { rain: 1 } } }), /effects as \{ id: version \}/);
    assert.equal(environmentRefusal('x', environment()), null);
  } finally {
    await h.cleanup();
  }
});

test('a job file of another version is listed as refused with a reason and is never claimed', async () => {
  const h = await harness();
  try {
    const live = await h.enqueue({ output: 'current' });
    const old = `job-${'9a'.repeat(8)}`;
    await writeFile(join(h.dir, 'jobs', `${old}.json`), `${JSON.stringify({
      id: old, version: JOB_VERSION - 1, state: 'queued', created: 1, renderer: null, output: 'old', attempts: 0,
    })}\n`);
    await writeFile(join(h.dir, 'jobs', `job-${'7c'.repeat(8)}.json`), '{ not json');

    const { jobs, refused } = await h.store.scan();
    assert.deepEqual(jobs.map((j) => j.id), [live.id]);
    assert.equal(refused.length, 2);
    const stale = refused.find((r) => r.id === old);
    assert.equal(stale.version, JOB_VERSION - 1);
    assert.match(stale.reason, new RegExp(`envelope version ${JOB_VERSION - 1} and this build reads version ${JOB_VERSION}`));
    assert.match(stale.reason, /no conversion/);
    assert.match(refused.find((r) => r.id !== old).reason, /not readable as a job record/);

    await assert.rejects(h.store.read(old), /no conversion/);
    await assert.rejects(h.store.cancel(old), /no conversion/);
    assert.equal((await claimOne(h)).id, live.id, 'the queue behind it still drains');
    assert.equal((await h.store.claim({ worker: 'w', renderer: METAL })).job, null, 'and the old file was not handed out');
  } finally {
    await h.cleanup();
  }
});
