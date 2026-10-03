// The render queue: jobs on disk, claimed by workers, one at a time. A job is a project body, the
// captures its clips are cut on named by content hash, and output settings, so it is
// self-contained. It is pinned to the renderer class that ran it, because a different GPU draws a
// different picture, and a project names its footage by hash so that a re-render is cut from the
// same frames. The job records what it ran on, and a render that finds a different build, effect,
// GPU or encoder still renders and says so: the promise is a picture that looks the same.
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { validateExport } from './export.js';
import { listJsonNames } from './library.js';
import { effectIdsIn, requiresEntryRefusal, requiresListRefusal } from '../web/format.js';

// The store refuses a job file of another version, naming both, and ships no conversion: a file it
// reads is a file whose every field this build wrote.
export const JOB_VERSION = 3;

const VALID_JOB_ID = /^job-[0-9a-f]{16}$/;

/** What a capture may be named by. An id is a filename; only the hash names the bytes. */
const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

export const STATES = ['queued', 'running', 'done', 'failed', 'cancelled'];

const isTerminal = (state) => state === 'done' || state === 'failed' || state === 'cancelled';

// What a worker may report. `cancelled` answers a cancel request.
const OUTCOMES = ['done', 'failed', 'cancelled'];

// Whether a worker of class `have` may run a job pinned to `want`. Exact strings, because the
// failure guarded against is two rasterisers that nearly agree.
export const rendererMatches = (want, have) => want === null || want === undefined || want === have;

// The comparison above is `===`, so a non-string pins a job to something no worker can equal.
const MAX_RENDERER_CHARS = 256;
const validRenderer = (v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_RENDERER_CHARS;

// What expires is the silence rather than the job, because a render may run for hours.
export const STALE_MS = 120_000;

// How many heartbeats in a row a worker lets fail before it stops rendering. At the worker's 15s
// beat that is 105s, inside STALE_MS, so the worker gives the claim up before a requeue can put a
// second machine on the same render.
export const BEAT_BUDGET = 7;

/**
 * What a worker does with one heartbeat's outcome. `answer` is `{ status, body }` for a reply and
 * `{ error }` for a request that got none. `missed` is the failures in a row before this one.
 * Returns `{ missed, verdict, reason }`:
 *   continue  keep rendering; `reason` says why when the beat failed
 *   lost      the queue says this claim is no longer the worker's: stop, report nothing
 *   cancel    the job was cancelled: stop, report `cancelled`
 *   abandon   `budget` failures in a row: stop, report `failed`
 * Pure, because the worker script launches a browser on import and a test cannot drive it.
 */
export function beatVerdict(missed, answer, budget = BEAT_BUDGET) {
  if (answer.status === 409) {
    return { missed, verdict: 'lost', reason: `heartbeat refused: ${answer.body?.error ?? 'lease lost'}` };
  }
  if (answer.status === 200) {
    if (typeof answer.body?.cancelRequested === 'number') {
      return { missed: 0, verdict: 'cancel', reason: 'a cancel was requested for this job' };
    }
    return { missed: 0, verdict: 'continue', reason: null };
  }
  const why = answer.error ?? `the queue answered ${answer.status}`;
  if (missed + 1 >= budget) {
    return { missed: missed + 1, verdict: 'abandon', reason: `${budget} heartbeats failed in a row, the last because ${why}` };
  }
  return { missed: missed + 1, verdict: 'continue', reason: why };
}

const isMap = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * A sentence for what is wrong with a version record, or null. A record is what a render ran on:
 * the app build, each installed effect's version by id, the GPU renderer string and the ffmpeg
 * version, which is null when ffmpeg could not report one.
 */
export function environmentRefusal(what, env) {
  if (!isMap(env)) return `${what} is a record of { app, effects, renderer, ffmpeg }, got ${JSON.stringify(env)}`;
  if (typeof env.app !== 'string' || env.app === '') return `${what} names its app build as a non-empty string`;
  if (typeof env.renderer !== 'string' || env.renderer === '') return `${what} names its GPU renderer as a non-empty string`;
  if (env.ffmpeg !== null && typeof env.ffmpeg !== 'string') return `${what} names its ffmpeg version as a string or null`;
  if (!isMap(env.effects) || !Object.values(env.effects).every((v) => typeof v === 'string')) {
    return `${what} lists its effects as { id: version } with a string version for each`;
  }
  return null;
}

const shortHash = (hash) => String(hash).slice(0, 12);

/**
 * How `now` differs from `was`, as warnings. Effects are compared only for the ids the job
 * requires: an effect it never draws cannot change its picture, and a warning for every install on
 * the machine would teach whoever reads them to skip the lot. ffmpeg is compared only when both
 * records could read it, because an unreadable one is already a warning of its own.
 */
export function versionDifferences(was, now, effectIds = []) {
  if (!was) return [];
  const out = [];
  const differ = (field, before, after, text) => {
    if (before !== after) out.push({ field, was: before, now: after, text });
  };
  differ('app', was.app, now.app, `the app build changed from ${shortHash(was.app)} to ${shortHash(now.app)}`);
  differ('renderer', was.renderer, now.renderer, `the GPU renderer changed from ${JSON.stringify(was.renderer)} to ${JSON.stringify(now.renderer)}`);
  if (typeof was.ffmpeg === 'string' && typeof now.ffmpeg === 'string') {
    differ('ffmpeg', was.ffmpeg, now.ffmpeg, `ffmpeg changed from ${was.ffmpeg} to ${now.ffmpeg}`);
  }
  const versionOf = (env, id) => (Object.hasOwn(env.effects, id) ? env.effects[id] : null);
  for (const id of effectIds) {
    const before = versionOf(was, id);
    const after = versionOf(now, id);
    differ(`effects.${id}`, before, after,
      `effect ${id} changed from ${before ?? 'not installed'} to ${after ?? 'not installed'}`);
  }
  return out;
}

const warn = (at, items) => items.map((item) => ({ at, ...item }));

const requiredIds = (job) => (job.requires ?? []).map((e) => e.id);

// A cancel the queue has taken and the worker has not yet answered.
const cancelAsked = (job) => typeof job.cancelRequested === 'number';

// Why the file is no use to this build, said once for every reader of it.
const versionRefusal = (id, version) => (
  `job ${id} is envelope version ${JSON.stringify(version)} and this build reads version ${JOB_VERSION}: `
  + 'this repo ships no conversion, so the file is refused rather than read on a guess about which fields it holds'
);

export class JobStore {
  /**
   * `exportsDir` is the root a finished job's sidecar must sit inside. `environment(renderer)`
   * answers `{ record, problems }`: the version record of what a render would run on right now,
   * and a `{ field, text }` for each part of it that could not be read. It is asked only when a
   * job is claimed or finished, so an idle queue probes nothing. `tempSuffix()` names the scratch
   * file a sidecar is written through; a test fixes it to plant something at that name.
   */
  constructor(dir, {
    exportsDir, environment, now = Date.now, staleMs = STALE_MS,
    tempSuffix = () => randomBytes(8).toString('hex'),
  }) {
    if (typeof exportsDir !== 'string' || exportsDir === '') throw new Error('a job store is built with the exports directory its sidecars live in');
    if (typeof environment !== 'function') throw new Error('a job store is built with the function that reads the environment a render runs on');
    this.dir = dir;
    this.exportsDir = exportsDir;
    this.environment = environment;
    this.now = now;
    this.staleMs = staleMs;
    this.tempSuffix = tempSuffix;
    // Every state transition goes through here, one at a time: `claim` and `finish` both have
    // an `await` between the decision and the write, so without this two workers claim one job.
    this.gate = Promise.resolve();
    // The chain advances even when `fn` rejects, or one refused claim would wedge the queue.
    this.serialise = (fn) => {
      const run = this.gate.then(fn, fn);
      this.gate = run.then(() => {}, () => {});
      return run;
    };
    this.writes = 0;
  }

  pathFor(id) {
    if (!VALID_JOB_ID.test(id)) throw new Error(`unusable job id ${JSON.stringify(id)}`);
    return join(this.dir, `${id}.json`);
  }

    // Two enqueues inside one millisecond hash the same, which is why `enqueue` salts.
  idFor(record) {
    const h = createHash('sha256').update(JSON.stringify(record)).digest('hex');
    return `job-${h.slice(0, 16)}`;
  }

  // The jobs this build can read, and a reason for each file it cannot. A file of another version
  // is neither handed to a worker nor hidden: `refused` is what `GET /jobs` shows beside the queue.
  async scan() {
    // Absent really is empty, but only absent: swallowing every failure parked the worker on an
    // unreadable directory and let `enqueue` write a duplicate into it.
    const files = await listJsonNames(this.dir, { what: 'job queue directory' });
    const jobs = [];
    const refused = [];
    for (const file of files) {
      const id = file.replace(/\.json$/, '');
      try {
        const job = JSON.parse(await readFile(join(this.dir, file), 'utf8'));
        if (job?.version === JOB_VERSION) jobs.push(job);
        else refused.push({ id, version: job?.version ?? null, reason: versionRefusal(id, job?.version) });
      } catch (err) {
        refused.push({ id, version: null, reason: `job ${id} is not readable as a job record: ${err.message}` });
      }
    }
    return { jobs, refused };
  }

  async list() {
    return (await this.scan()).jobs;
  }

  async read(id) {
    const job = JSON.parse(await readFile(this.pathFor(id), 'utf8'));
    if (job.version !== JOB_VERSION) throw new Error(versionRefusal(id, job.version));
    return job;
  }

  // Written aside and renamed, or a crash leaves a file describing a job nobody enqueued.
  async #put(job) {
    const path = this.pathFor(job.id);
    this.writes++;
    await mkdir(this.dir, { recursive: true });
    const text = `${JSON.stringify(job, null, 2)}\n`;
    await writeFile(`${path}.tmp`, text);
    await rename(`${path}.tmp`, path);
    return job;
  }

  /** Enqueue a render. A capture named by anything but content hash is refused. */
  async enqueue({ project, deliverable = null, captures, renderer = null, output, width, height, fps, codec = 'h264', suppressEffects = [], recorded = null }) {
    // The document *body*, never the store's `{ name, rev, body }` envelope.
    if (!project || typeof project !== 'object' || Array.isArray(project)) {
      throw new Error('a job needs a project document body');
    }
    if (project.version === undefined) {
      throw new Error(
        'a job\'s project has no version, so it is the store envelope rather than the document body: '
        + 'pass what serialiseProjectBody() returns, not { name, rev, body }',
      );
    }
    if (!Array.isArray(captures) || captures.length === 0
      || !captures.every((h) => typeof h === 'string' && CONTENT_HASH.test(h))) {
      throw new Error(
        `a job names its captures by content hash, one per clip, got ${JSON.stringify(captures)}`,
      );
    }
    if (renderer !== null && renderer !== undefined && !validRenderer(renderer)) {
      throw new Error(
        `a job pins its renderer class as a string of at most ${MAX_RENDERER_CHARS} characters, `
        + `got ${JSON.stringify(renderer)} - and a pin nothing can equal is a job nothing can claim`,
      );
    }
    const clipList = Array.isArray(project.clips) ? project.clips : [];
    // Derived from the clips rather than copied from the caller, for the reason `requires` is:
    // the caller's list is a claim about the document rather than the document, and a claim that
    // disagrees with it is answered here by name rather than a browser and a minute of GPU later.
    // One entry per clip and in project order, repeats kept: two clips of one take is an edit this
    // list has to be able to spell, and two clips whose footage is swapped is a different edit that
    // has to read differently.
    const cut = clipList.map((clip) => (clip && typeof clip === 'object' && !Array.isArray(clip)
      ? clip.take?.hash : undefined));
    const takeless = cut
      .map((hash, at) => (typeof hash === 'string' && CONTENT_HASH.test(hash) ? null : at))
      .filter((at) => at !== null);
    if (clipList.length === 0 || takeless.length) {
      throw new Error(clipList.length === 0
        ? 'a job\'s project holds no clips, so there is no footage for this render to be against'
        : `a job's project has ${takeless.length} clip(s) naming no content hash to be cut on, at `
          + `position ${takeless.join(', ')}: a clip with nothing to draw is one the page refuses `
          + 'once the browser is already open, and the queue can say it before that costs anything');
    }
    const short = (hash) => `${String(hash).slice(0, 22)}…`;
    if (captures.length !== cut.length || captures.some((hash, at) => hash !== cut[at])) {
      throw new Error(
        'a job disagrees with its own project about the footage it renders, so the queue cannot say '
        + `what this render is against: the job names ${captures.map(short).join(', ')} and its `
        + `clips are cut on ${cut.map(short).join(', ')} - the list is one entry per clip in project `
        + 'order, so a different length or a different order is a hand edit to finish before the '
        + 'job is queued',
      );
    }
    // Derived from the look's own namespaces rather than copied from `project.requires`, which is
    // caller data - an empty list used to be recorded as one, and the refusal then arrived from
    // `restoreProject` a browser and a minute of GPU later.
    const shape = (o) => (o && typeof o === 'object' && !Array.isArray(o) ? Object.keys(o) : []);
    // Both blocks, because an effect binding the cloud is a clip's and one binding the grade is
    // the project's: reading `look` alone would call every point effect unclaimed.
    const blocks = [project.look, ...clipList];
    const used = effectIdsIn(blocks.flatMap((b) => [...shape(b?.params), ...shape(b?.tracks)]));
    if (project.requires !== undefined) {
      const listShape = requiresListRefusal('a job\'s project', project.requires);
      if (listShape) throw new Error(listShape);
      for (const entry of project.requires) {
        const bad = requiresEntryRefusal('a job\'s project', entry);
        if (bad) throw new Error(bad);
      }
    }
    const carried = project.requires ?? [];
    const claimed = carried.map((e) => (e && typeof e === 'object' ? e.id : undefined));
    // The comparisons below read membership and a set, so neither can see a repeated id.
    const duplicated = [...new Set(
      claimed.filter((id, at) => typeof id === 'string' && claimed.indexOf(id) !== at),
    )];
    if (duplicated.length) {
      throw new Error(
        `a job's project claims ${duplicated.join(', ')} more than once in its requires list, so there is no `
        + 'one answer to which version of ' + (duplicated.length === 1 ? 'that effect' : 'those effects')
        + ' this render needs - the list is derived from the values on save, one entry per effect, and a '
        + 'repeat is a hand edit to finish before the job is queued',
      );
    }
    const unlisted = used.filter((id) => !claimed.includes(id));
    const unclaimed = [...new Set(claimed)].filter((id) => typeof id === 'string' && !used.includes(id));
    if (unlisted.length || unclaimed.length) {
      throw new Error(
        'a job\'s project disagrees with its own requires list, so the queue cannot say what this '
        + `render needs: ${[
          unlisted.length ? `it names ${unlisted.join(', ')} values that the list does not claim` : null,
          unclaimed.length ? `the list claims ${unclaimed.join(', ')} and no value is named under ${unclaimed.length === 1 ? 'it' : 'them'}` : null,
        ].filter(Boolean).join(', and ')} - the list is derived from the values on save, so a gap `
        + 'between them is a hand edit to finish before the job is queued',
      );
    }
    const requires = used.map((id) => ({ ...carried.find((e) => e?.id === id) }));
    // Unlike `requires` this is the caller's, because it is a decision rather than a fact.
    if (!Array.isArray(suppressEffects)
      || !suppressEffects.every((id) => typeof id === 'string' && /^[a-z][a-z0-9]*$/.test(id))) {
      throw new Error(
        `a job's suppressEffects is a list of effect ids, got ${JSON.stringify(suppressEffects)} - `
        + 'an id is lowercase letters and digits, the prefix an effect\'s parameters carry',
      );
    }
    // What an earlier render of this edit ran on, which is `versions.finished` in its sidecar.
    // The claim compares against it, so a re-render built from a sidecar warns where it differs.
    if (recorded !== null) {
      const refusal = environmentRefusal('a job\'s recorded versions', recorded);
      if (refusal) throw new Error(refusal);
    }
    const { width: w, height: h, fps: f } = validateExport({ name: output, width, height, fps, codec });
    return this.serialise(async () => {
      const live = await this.list();
      // Two jobs writing one file is one job's work thrown away. A finished job's name is free
      // again, because replacing an export you already have is what re-exporting means.
      const holder = live.find((j) => j.output === String(output) && (j.state === 'queued' || j.state === 'running'));
      if (holder) {
        throw new Error(`output ${JSON.stringify(String(output))} is already reserved by ${holder.id} (${holder.state}), and two jobs writing one file is one render thrown away`);
      }
      const created = this.now();
      const body = {
        version: JOB_VERSION,
        project,
        deliverable,
        requires,
        suppressEffects: [...suppressEffects],
        captures: [...cut],
        renderer: renderer ?? null,
        output: String(output),
        artifactPath: null,
        width: w,
        height: h,
        fps: f,
        codec,
        state: 'queued',
        created,
        claimed: null,
        finished: null,
        worker: null,
        error: null,
        attempts: 0,
        lease: null,
        cancelRequested: null,
        versions: { recorded, claimed: null, finished: null },
        warnings: [],
      };
      // The salt is the collision counter rather than random, keeping the id a
      // function of the record.
      let id = this.idFor({ ...body, salt: 0 });
      for (let salt = 1; live.some((j) => j.id === id); salt++) id = this.idFor({ ...body, salt });
      return this.#put({ id, ...body });
    });
  }

  // Hand the oldest claimable job to a worker of this class, or a refusal naming what blocked it -
  // a queue this worker cannot run is a different answer from an empty queue.
  claim({ worker, renderer }) {
    if (!validRenderer(renderer)) {
      return Promise.reject(new Error(
        'a worker claims with the renderer class it will render on, as a string of at most '
        + `${MAX_RENDERER_CHARS} characters, not ${JSON.stringify(renderer ?? null)}`,
      ));
    }
    return this.serialise(async () => {
      const all = (await this.list()).filter((j) => j.state === 'queued').sort((a, b) => a.created - b.created);
      const mine = all.filter((j) => rendererMatches(j.renderer, renderer));
      if (mine.length === 0) {
        const blocked = all.map((j) => ({ id: j.id, wants: j.renderer }));
        return { job: null, blocked, queued: all.length };
      }
      const job = mine[0];
      job.state = 'running';
      job.claimed = this.now();
      // So a worker that dies before its first heartbeat still gets the full window.
      job.heartbeat = job.claimed;
      job.worker = worker ?? null;
      job.attempts += 1;
      // A token the finisher has to present, random rather than derived because the read routes
      // strip it and keep every other field a forger would need.
      job.lease = randomBytes(16).toString('hex');
      job.renderer = renderer;
      const { record, problems } = await this.environment(renderer);
      job.versions.claimed = record;
      job.warnings.push(
        ...warn('claim', problems),
        ...warn('claim', versionDifferences(job.versions.recorded, record, requiredIds(job))),
      );
      await this.#put(job);
      return { job, blocked: [], queued: all.length };
    });
  }

  // Report an outcome against the lease the claim handed out. Running inside the gate is what
  // stops two reports both passing the terminal-state guard.
  finish(id, { state, error = null, output = null, frames = null, lease = null }) {
    return this.serialise(async () => {
      if (!OUTCOMES.includes(state)) throw new Error(`a job finishes done, failed or cancelled, not ${state}`);
      if (output !== null && typeof output !== 'string') throw new Error('a job\'s output is a string or nothing');
      const job = await this.read(id);
      if (isTerminal(job.state)) {
        throw new Error(`job ${id} is already ${job.state}, so this report is from a worker that lost a race`);
      }
      if (job.state !== 'running') {
        throw new Error(`job ${id} is ${job.state}, so nothing is rendering it and there is no outcome to report`);
      }
      // `job.lease &&` accepted a report from anybody when the lease was missing, and a record is
      // a file a hand or an older build can write.
      if (typeof job.lease !== 'string' || job.lease === '') {
        throw new Error(`job ${id} says it is running with no lease, which is not a state a claim can produce - the record is unusable rather than finishable`);
      }
      if (lease !== job.lease) {
        throw new Error(`job ${id} is held by another claim, so this report is not the one running it`);
      }
      if (state === 'cancelled' && !cancelAsked(job)) {
        throw new Error(`job ${id} was not asked to cancel, so there is no cancellation for this worker to report`);
      }
      job.state = state;
      job.error = error;
      job.finished = this.now();
      job.lease = null;
      // Kept apart from `output` so the output *name* stays the base name a retry can ask for.
      if (typeof output === 'string' && output.length > 0) job.artifactPath = output;
      if (Number.isFinite(frames)) job.frames = frames;
      const { record, problems } = await this.environment(job.renderer);
      job.versions.finished = record;
      job.warnings.push(
        ...warn('finish', problems),
        ...warn('finish', versionDifferences(job.versions.claimed, record, requiredIds(job))),
      );
      // A render is done when the queue holds its record and the sidecar beside the artifact does
      // too. Anything less is a failed job that says why, and the artifact stays where it is.
      if (state === 'done') {
        try {
          await this.#amendSidecar(job);
        } catch (err) {
          job.state = 'failed';
          job.error = `the render reported done but its artifact ${JSON.stringify(job.artifactPath)} `
            + `could not take the version record, so it is not recorded as done: ${err.message}`;
        }
      }
      return this.#put(job);
    });
  }

  // The export wrote `<artifact>.job.json` beside the render. It gains the version record and the
  // warnings, written aside and renamed like every other write here. The artifact path is a lease
  // holder's word, so every path touched is held to the exports root by where the filesystem puts
  // it rather than how it is spelled, and none of them may be a symlink: a link under the
  // artifact would carry this read and write somewhere else. Throws, saying why, when it cannot.
  async #amendSidecar(job) {
    if (typeof job.artifactPath !== 'string' || job.artifactPath === '') {
      throw new Error('the report names no artifact path');
    }
    const artifact = resolve(job.artifactPath);
    const folder = dirname(artifact);
    const realRoot = await realpath(this.exportsDir);
    const realFolder = await realpath(folder);
    const inside = relative(realRoot, realFolder);
    if (inside === '..' || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new Error(`its directory resolves to ${realFolder}, outside the exports directory ${realRoot}`);
    }
    if (inside !== relative(resolve(this.exportsDir), folder)) {
      throw new Error(`its directory ${folder} is reached through a symlink`);
    }
    const real = join(realFolder, basename(artifact));
    const sidecar = `${real}.job.json`;
    let checked;
    for (const [what, path] of [['artifact', real], ['sidecar', sidecar]]) {
      const info = await lstat(path, { bigint: true }).catch((err) => { throw new Error(`the ${what} cannot be read: ${err.message}`); });
      if (info.isSymbolicLink()) throw new Error(`the ${what} ${path} is a symlink`);
      if (what === 'sidecar') {
        if (!info.isFile()) throw new Error(`the sidecar ${path} is not a regular file`);
        checked = info;
      }
    }
    // `O_NOFOLLOW` refuses a link swapped in after the checks where the platform has the flag. The
    // open file's device and inode must also be the checked ones, which covers Windows and a
    // regular file swapped in. A directory swapped above `folder` is not caught: Node cannot open
    // relative to a descriptor.
    const reading = await open(sidecar, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let text;
    try {
      const opened = await reading.stat({ bigint: true });
      if (opened.dev !== checked.dev || opened.ino !== checked.ino) {
        throw new Error(`the sidecar ${sidecar} was replaced between the check and the open`);
      }
      text = await reading.readFile('utf8');
    } finally {
      await reading.close();
    }
    let record;
    try {
      record = JSON.parse(text);
    } catch (err) {
      throw new Error(`the sidecar ${sidecar} is not JSON: ${err.message}`);
    }
    if (!isMap(record)) throw new Error(`the sidecar ${sidecar} is not a JSON object`);
    const amended = { ...record, versions: job.versions, warnings: job.warnings };
    // `wx` fails on anything already at the name, a link included, so the write cannot be
    // steered onto another file by planting one. Only what this call created is removed.
    const scratch = `${sidecar}.${this.tempSuffix()}.tmp`;
    const out = await open(scratch, 'wx');
    try {
      await out.writeFile(`${JSON.stringify(amended, null, 2)}\n`);
      await out.close();
      await rename(scratch, sidecar);
    } catch (err) {
      await out.close().catch(() => {});
      await unlink(scratch).catch(() => {});
      throw err;
    }
  }

  // Ask for a job to stop. A queued job is cancelled where it stands. A running job is marked,
  // and its worker sees the mark on its next heartbeat, stops, and reports `cancelled`; one whose
  // worker has gone quiet has nobody to see the mark, so it is cancelled directly.
  cancel(id) {
    return this.serialise(async () => {
      const job = await this.read(id);
      if (job.state === 'cancelled') return job;
      if (isTerminal(job.state)) throw new Error(`job ${id} is already ${job.state}, so there is nothing left to cancel`);
      if (job.state === 'running' && this.#quietFor(job) < this.staleMs) {
        if (!cancelAsked(job)) {
          job.cancelRequested = this.now();
          await this.#put(job);
        }
        return job;
      }
      job.state = 'cancelled';
      job.finished = this.now();
      job.lease = null;
      return this.#put(job);
    });
  }

  // Put a finished-or-running job back on the queue, still pinned to its renderer class.
  requeue(id) {
    return this.serialise(async () => {
      const job = await this.read(id);
      // A running job is refused unless it has gone quiet: refusing every one of them left a
      // worker killed mid-render holding its job and its output name forever.
      if (job.state === 'running') {
        const quietFor = this.#quietFor(job);
        if (quietFor < this.staleMs) {
          throw new Error(
            `job ${id} is running on ${job.worker ?? 'a worker'} and was heard from ${Math.round(quietFor / 1000)}s ago, `
            + `so requeueing it would put a second machine on the same render: let it finish, or wait for it to go quiet for ${Math.round(this.staleMs / 1000)}s`,
          );
        }
      }
      const live = await this.list();
      const holder = live.find((j) => j.id !== id && j.output === job.output
        && (j.state === 'queued' || j.state === 'running'));
      if (holder) {
        throw new Error(`output ${JSON.stringify(job.output)} is already reserved by ${holder.id} (${holder.state}), so this retry would collide`);
      }
      // A render that finished is what the next one is compared against. One that never did has
      // nothing to say about the picture, so the earlier record stands.
      job.versions = {
        recorded: job.state === 'done' ? job.versions.finished : job.versions.recorded,
        claimed: null,
        finished: null,
      };
      job.warnings = [];
      job.state = 'queued';
      job.claimed = null;
      job.finished = null;
      job.worker = null;
      job.error = null;
      job.lease = null;
      job.heartbeat = null;
      job.artifactPath = null;
      job.cancelRequested = null;
      return this.#put(job);
    });
  }

  #quietFor(job) {
    return this.now() - (job.heartbeat ?? job.claimed ?? 0);
  }

  // A claim saying it is still there, held to the same lease `finish` is.
  heartbeat(id, { lease = null } = {}) {
    return this.serialise(async () => {
      const job = await this.read(id);
      if (job.state !== 'running') throw new Error(`job ${id} is ${job.state}, so there is no claim to keep alive`);
      if (typeof job.lease !== 'string' || lease !== job.lease) {
        throw new Error(`job ${id} is held by another claim, so this is not the one rendering it`);
      }
      job.heartbeat = this.now();
      return this.#put(job);
    });
  }

  async remove(id) {
    const path = this.pathFor(id);
    this.writes++;
    await unlink(path);
    return { removed: id };
  }
}
