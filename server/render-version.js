import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** A renderer change cannot reuse images made by older code in the browser's cache. */
export async function renderVersion(web, three) {
  const hash = createHash('sha256');
  async function walk(root, prefix = '') {
    const entries = await readdir(join(root, prefix), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(prefix, entry.name);
      if (entry.isDirectory()) await walk(root, file);
      else if (/\.(js|html|json)$/.test(file)) {
        hash.update(file).update('\0').update(await readFile(join(root, file))).update('\0');
      }
    }
  }
  await walk(web);
  await walk(join(three, 'build'));
  await walk(join(three, 'examples', 'jsm'));
  hash.update(await readFile(join(three, 'package.json')));
  return hash.digest('hex');
}
