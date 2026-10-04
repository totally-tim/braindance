import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

const SHIPPED = /\.(js|html|json)$/;

// The last digest per root pair, keyed by every hashed file's path, size, mtime and ctime: a
// request pays a stat walk, and only a file that changed on disk pays the read. ctime is in the
// key because a copy that preserves mtime cannot preserve it.
const known = new Map();

async function shippedFiles(web, three, server) {
  const files = [];
  async function walk(root, prefix = '') {
    const entries = await readdir(join(root, prefix), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(prefix, entry.name);
      if (entry.isDirectory()) await walk(root, file);
      else if (SHIPPED.test(file)) files.push([file, join(root, file)]);
    }
  }
  await walk(web);
  await walk(join(three, 'build'));
  await walk(join(three, 'examples', 'jsm'));
  files.push(['package.json', join(three, 'package.json')]);
  for (const path of server) files.push([`server/${basename(path)}`, path]);
  return files;
}

/** A renderer change cannot reuse images made by older code in the browser's cache. */
export async function renderVersion(web, three, server = []) {
  const files = await shippedFiles(web, three, server);
  const stats = await Promise.all(files.map(([, path]) => stat(path)));
  const fingerprint = files.map(([file], at) => `${file}\0${stats[at].size}\0${stats[at].mtimeMs}\0${stats[at].ctimeMs}`).join('\n');
  const slot = [web, three, ...server].join('\0');
  const cached = known.get(slot);
  if (cached?.fingerprint === fingerprint) return cached.digest;
  const hash = createHash('sha256');
  for (const [file, path] of files) hash.update(file).update('\0').update(await readFile(path)).update('\0');
  const digest = hash.digest('hex');
  known.set(slot, { fingerprint, digest });
  return digest;
}

/**
 * What a render ran: the renderer's files, and the server code that writes the export's encoder
 * arguments and audio mux, which no browser file or ffmpeg version identifies.
 */
export const appVersion = (root, three) => renderVersion(join(root, 'web'), three, [join(root, 'server', 'export.js')]);

/** The version token off the first line `ffmpeg -version` prints, or null. */
export function parseFfmpegVersion(text) {
  return /^ffmpeg version (\S+)/.exec(text ?? '')?.[1] ?? null;
}

/**
 * The version of the ffmpeg the export will run, as `{ version, problem }`. `resolveBinary` throws
 * when no ffmpeg resolves. Whatever stops a version coming back is a `problem` sentence beside a
 * null `version`, so the job that asked warns rather than fails.
 */
export async function ffmpegVersion(resolveBinary) {
  let binary;
  try {
    binary = resolveBinary();
  } catch (err) {
    return { version: null, problem: `ffmpeg could not be resolved: ${err.message}` };
  }
  let stdout;
  try {
    ({ stdout } = await run(binary, ['-version'], { timeout: 5000 }));
  } catch (err) {
    return { version: null, problem: `ffmpeg at ${binary} did not report a version: ${err.message}` };
  }
  const version = parseFfmpegVersion(stdout);
  if (version === null) {
    return { version: null, problem: `ffmpeg at ${binary} printed ${JSON.stringify(stdout.split('\n')[0])} for -version, which is not a version line` };
  }
  return { version, problem: null };
}
