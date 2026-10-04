// Which paths the bridge may show in the OS file manager. Nothing here imports Electron, so the
// unit tests and the shell run the same code.
import { realpath } from 'node:fs/promises';
import { sep } from 'node:path';

// Compared as written, because both sides are real paths in the file system's own spelling, and a
// folded comparison would take `CAPTURES` for `captures` where the two are different folders.
export const within = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * The path to reveal, or null. `picked` holds what the user chose in a native dialog, and each of
 * those is revealed as given. Any other path must exist and have a real path inside one of `roots`,
 * so a `..` or a symlink cannot lead out of one. A real path is what gets revealed, so a link
 * swapped after this check shows nothing else.
 */
export async function revealable(path, { picked, roots }) {
  if (picked.has(path)) return path;
  let real;
  try { real = await realpath(path); } catch { return null; }
  for (const root of roots) {
    const realRoot = await realpath(root).catch(() => null);
    if (realRoot && within(realRoot, real)) return real;
  }
  return null;
}
