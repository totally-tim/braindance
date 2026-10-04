// Loaded into a server with `node --import`, so a test can close an export socket while the export
// creates its scratch: `mkdir` of a `.part` path writes a line to the events file and waits until
// the release file exists. `rm` of a `.part` path that exists fails, so the removal that follows that
// `mkdir` cannot finish. `node:fs/promises` is patched and its named exports synced before the
// server loads.

import { appendFileSync, existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';

const { BRAINDANCE_PROBE_EVENTS: events, BRAINDANCE_PROBE_RELEASE: release } = process.env;
const { mkdir, rm } = fsp;
const scratch = (path) => typeof path === 'string' && path.endsWith('.part');

fsp.mkdir = async function heldMkdir(path, ...rest) {
  if (scratch(path)) {
    appendFileSync(events, `mkdir-held ${path}\n`);
    while (!existsSync(release)) await new Promise((wake) => setTimeout(wake, 10));
  }
  return mkdir.call(this, path, ...rest);
};
fsp.rm = async function refusedRm(path, ...rest) {
  if (scratch(path) && existsSync(path)) {
    throw Object.assign(new Error(`EACCES: permission denied, rm '${path}'`), { code: 'EACCES' });
  }
  return rm.call(this, path, ...rest);
};
syncBuiltinESMExports();
