// The render queue's store, driven in process: cancellation, the heartbeat decision, the version
// record and the refusal of a job file this build did not write. No server and no browser.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fsp, { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
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
async function harness(options = {}) {
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
    ...options,
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

// A job claimed and finished `done` over `output`, which is the report a worker sends.
const reportDone = async (h, output) => {
  await h.enqueue();
  const job = await claimOne(h);
  return h.store.finish(job.id, { state: 'done', output, frames: 3, lease: job.lease });
};

// What a done report that could not be recorded looks like, on the answer and on disk.
const assertNotDone = async (h, job, cause, output) => {
  assert.equal(job.state, 'failed', 'the answer says failed');
  assert.equal((await h.store.read(job.id)).state, 'failed', 'and so does the record on disk');
  assert.equal(job.lease, null, 'the lease is spent either way');
  assert.equal(job.artifactPath, output, 'the artifact stays named on the record');
  assert.ok(job.error.includes(JSON.stringify(output)), `the reason names the artifact path: ${job.error}`);
  assert.match(job.error, cause);
};

// A directory elsewhere with a movie and its sidecar in it, which nothing in `exports/` may touch.
const outsideMovie = async (h) => {
  const elsewhere = join(h.dir, 'elsewhere');
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, 'movie.mp4'), 'video');
  await writeFile(join(elsewhere, 'movie.mp4.job.json'), '{"output":"stray"}\n');
  return elsewhere;
};

test('a sidecar outside the exports directory is not written, and the job is failed for it', async () => {
  const h = await harness();
  try {
    const stray = join(h.dir, 'elsewhere.mp4');
    await writeFile(stray, 'video');
    await writeFile(`${stray}.job.json`, '{"output":"stray"}\n');
    const job = await reportDone(h, stray);
    await assertNotDone(h, job, /outside the exports directory/, stray);
    assert.equal(await readFile(`${stray}.job.json`, 'utf8'), '{"output":"stray"}\n', 'the file is untouched');
    assert.equal(await readFile(stray, 'utf8'), 'video', 'and so is the artifact');
  } finally {
    await h.cleanup();
  }
});

test('a done report with no artifact path is failed rather than recorded as done', async () => {
  const h = await harness();
  try {
    for (const output of [null, '']) {
      const job = await reportDone(h, output);
      assert.equal(job.state, 'failed');
      assert.match(job.error, /names no artifact path/);
      assert.equal(job.artifactPath, null);
    }
  } finally {
    await h.cleanup();
  }
});

test('a sidecar that is missing fails the job, and the artifact is left where it is', async () => {
  const h = await harness();
  try {
    const output = await h.artifact('lost');
    await rm(`${output}.job.json`);
    const job = await reportDone(h, output);
    await assertNotDone(h, job, /sidecar cannot be read: ENOENT/, output);
    assert.equal(await readFile(output, 'utf8'), 'video', 'the encoded file is not removed');
    assert.deepEqual(await readdir(join(h.exportsDir, 'lost.1-1')), ['lost.mp4'], 'and nothing is made in its place');
  } finally {
    await h.cleanup();
  }
});

test('an artifact that is not there fails the job', async () => {
  const h = await harness();
  try {
    const output = join(h.exportsDir, 'nowhere', 'gone.mp4');
    await assertNotDone(h, await reportDone(h, output), /no such file or directory/, output);
    const bare = join(h.exportsDir, 'bare.mp4');
    await writeFile(`${bare}.job.json`, '{}\n');
    await assertNotDone(h, await reportDone(h, bare), /artifact cannot be read: ENOENT/, bare);
  } finally {
    await h.cleanup();
  }
});

test('a sidecar that is not a JSON object, or not a file, fails the job and is left as it was', async () => {
  const h = await harness();
  try {
    for (const [name, body, cause] of [
      ['torn', '{ not json', /is not JSON/],
      ['list', '[1]\n', /is not a JSON object/],
    ]) {
      const output = await h.artifact(name);
      await writeFile(`${output}.job.json`, body);
      await assertNotDone(h, await reportDone(h, output), cause, output);
      assert.equal(await readFile(`${output}.job.json`, 'utf8'), body);
      assert.deepEqual((await readdir(join(h.exportsDir, `${name}.1-1`))).sort(), [`${name}.mp4`, `${name}.mp4.job.json`]);
    }
    const output = await h.artifact('folder');
    await rm(`${output}.job.json`);
    await mkdir(`${output}.job.json`);
    await assertNotDone(h, await reportDone(h, output), /not a regular file/, output);
  } finally {
    await h.cleanup();
  }
});

test('a directory that is a symlink out of the exports directory is not read or written through', async () => {
  const h = await harness();
  try {
    const elsewhere = await outsideMovie(h);
    await symlink(elsewhere, join(h.exportsDir, 'linked'));
    const output = join(h.exportsDir, 'linked', 'movie.mp4');
    const job = await reportDone(h, output);
    await assertNotDone(h, job, /resolves to .*outside the exports directory/, output);
    assert.equal(await readFile(join(elsewhere, 'movie.mp4.job.json'), 'utf8'), '{"output":"stray"}\n', 'the outside sidecar is byte for byte what it was');
    assert.deepEqual((await readdir(elsewhere)).sort(), ['movie.mp4', 'movie.mp4.job.json'], 'and nothing was made beside it');
  } finally {
    await h.cleanup();
  }
});

test('a symlinked directory that stays inside the exports directory is refused too', async () => {
  const h = await harness();
  try {
    const output = await h.artifact('real');
    await symlink(join(h.exportsDir, 'real.1-1'), join(h.exportsDir, 'alias'));
    const job = await reportDone(h, join(h.exportsDir, 'alias', 'real.mp4'));
    await assertNotDone(h, job, /reached through a symlink/, join(h.exportsDir, 'alias', 'real.mp4'));
    assert.deepEqual(JSON.parse(await readFile(`${output}.job.json`, 'utf8')), { output: 'real', frames: 3 }, 'the sidecar under the real name is unamended');
  } finally {
    await h.cleanup();
  }
});

test('an exports directory that is itself a symlink works, because the root is resolved too', async () => {
  const h = await harness();
  try {
    const linked = join(h.dir, 'exports-link');
    await symlink(h.exportsDir, linked);
    const store = new JobStore(join(h.dir, 'jobs-linked'), {
      exportsDir: linked,
      environment: async (renderer) => ({ record: { ...h.current.record, renderer }, problems: [] }),
      now: () => h.clock.t,
      staleMs: STALE_MS,
    });
    const output = await h.artifact('rooted');
    await store.enqueue({ project: PROJECT, captures: [HASH], output: 'rooted', width: 64, height: 36, fps: 30 });
    const job = (await store.claim({ worker: 'w', renderer: METAL })).job;
    const done = await store.finish(job.id, {
      state: 'done', output: join(linked, 'rooted.1-1', 'rooted.mp4'), frames: 3, lease: job.lease,
    });
    assert.equal(done.state, 'done');
    assert.deepEqual(JSON.parse(await readFile(`${output}.job.json`, 'utf8')).versions, done.versions);
  } finally {
    await h.cleanup();
  }
});

test('a sidecar that is a symlink is refused and the file it points at is not touched', async () => {
  const h = await harness();
  try {
    const elsewhere = await outsideMovie(h);
    const output = await h.artifact('swapped');
    await rm(`${output}.job.json`);
    await symlink(join(elsewhere, 'movie.mp4.job.json'), `${output}.job.json`);
    const job = await reportDone(h, output);
    await assertNotDone(h, job, /sidecar .* is a symlink/, output);
    assert.equal(await readFile(join(elsewhere, 'movie.mp4.job.json'), 'utf8'), '{"output":"stray"}\n');
    assert.equal((await lstat(`${output}.job.json`)).isSymbolicLink(), true, 'the link is left for whoever put it there');

    const linkedArtifact = join(h.exportsDir, 'ghost.mp4');
    await symlink(join(elsewhere, 'movie.mp4'), linkedArtifact);
    await writeFile(`${linkedArtifact}.job.json`, '{}\n');
    await assertNotDone(h, await reportDone(h, linkedArtifact), /artifact .* is a symlink/, linkedArtifact);
  } finally {
    await h.cleanup();
  }
});

test('the scratch file is created exclusively, so a link planted at its name is not written through', async () => {
  const h = await harness({ tempSuffix: () => 'fixed' });
  try {
    const elsewhere = await outsideMovie(h);
    const victim = join(elsewhere, 'victim.txt');
    await writeFile(victim, 'precious');
    const output = await h.artifact('planted');
    const planted = `${output}.job.json.fixed.tmp`;
    await symlink(victim, planted);
    const job = await reportDone(h, output);
    await assertNotDone(h, job, /EEXIST/, output);
    assert.equal(await readFile(victim, 'utf8'), 'precious', 'what the link points at is untouched');
    assert.equal((await lstat(planted)).isSymbolicLink(), true, 'and the link is not the queue\'s to remove');
    assert.deepEqual(JSON.parse(await readFile(`${output}.job.json`, 'utf8')), { output: 'planted', frames: 3 }, 'the sidecar is as the export left it');
  } finally {
    await h.cleanup();
  }
});

// Fails one of the store's own file calls for as long as `body` runs. `exercise` is an fs function
// and `when` picks the call, because the job record is written through the same ones.
async function failing(exercise, when, how, body) {
  const real = fsp[exercise];
  mock.method(fsp, exercise, async (...args) => (when(args) ? how(real, args) : real(...args)));
  syncBuiltinESMExports();
  try {
    return await body();
  } finally {
    mock.restoreAll();
    syncBuiltinESMExports();
  }
}

test('a write that fails after the scratch file exists removes it and fails the job', async () => {
  const h = await harness({ tempSuffix: () => 'half' });
  try {
    const output = await h.artifact('full');
    const job = await failing('open', ([, flags]) => flags === 'wx', async (real, args) => {
      const handle = await real(...args);
      handle.writeFile = async () => { throw new Error('ENOSPC: no space left on device'); };
      return handle;
    }, () => reportDone(h, output));
    await assertNotDone(h, job, /ENOSPC/, output);
    assert.deepEqual((await readdir(join(h.exportsDir, 'full.1-1'))).sort(), ['full.mp4', 'full.mp4.job.json'], 'no scratch file is left');
    assert.deepEqual(JSON.parse(await readFile(`${output}.job.json`, 'utf8')), { output: 'full', frames: 3 });
  } finally {
    await h.cleanup();
  }
});

test('a rename that fails removes the scratch file and fails the job', async () => {
  const h = await harness({ tempSuffix: () => 'late' });
  try {
    const output = await h.artifact('stuck');
    const job = await failing('rename', ([, to]) => String(to).endsWith('.job.json'), async () => {
      throw new Error('EXDEV: cross-device link not permitted');
    }, () => reportDone(h, output));
    await assertNotDone(h, job, /EXDEV/, output);
    assert.deepEqual((await readdir(join(h.exportsDir, 'stuck.1-1'))).sort(), ['stuck.mp4', 'stuck.mp4.job.json'], 'no scratch file is left');
    assert.deepEqual(JSON.parse(await readFile(`${output}.job.json`, 'utf8')), { output: 'stuck', frames: 3 });
    const again = await h.store.requeue(job.id);
    assert.equal(again.state, 'queued', 'a failed job is what a retry is for');
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
