import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const SHIPPED = /\.(js|html|json)$/;

// The last digest per root pair, keyed by every hashed file's path, size, mtime and ctime: a
// request pays a stat walk, and only a file that changed on disk pays the read. ctime is in the
// key because a copy that preserves mtime cannot preserve it.
const known = new Map();

async function shippedFiles(web, three) {
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
  return files;
}

/** A renderer change cannot reuse images made by older code in the browser's cache. */
export async function renderVersion(web, three) {
  const files = await shippedFiles(web, three);
  const stats = await Promise.all(files.map(([, path]) => stat(path)));
  const fingerprint = files.map(([file], at) => `${file}\0${stats[at].size}\0${stats[at].mtimeMs}\0${stats[at].ctimeMs}`).join('\n');
  const slot = `${web}\0${three}`;
  const cached = known.get(slot);
  if (cached?.fingerprint === fingerprint) return cached.digest;
  const hash = createHash('sha256');
  for (const [file, path] of files) hash.update(file).update('\0').update(await readFile(path)).update('\0');
  const digest = hash.digest('hex');
  known.set(slot, { fingerprint, digest });
  return digest;
}
