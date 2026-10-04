// Loaded into a server with `node --import`, so a test can stop a take's close inside its scan: a
// read stream opened on a `.knct` file by path delivers nothing until the release file exists, and
// with no release file named it never does. The events file gets one line per such stream. That
// is where a host's stop deadline lands on a long take. The server's code is untouched; `node:fs`
// is patched and its named exports synced before the server loads.

import fs, { appendFileSync, existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough } from 'node:stream';

const { BRAINDANCE_PROBE_EVENTS: events, BRAINDANCE_PROBE_RELEASE: release } = process.env;
const { createReadStream } = fs;

fs.createReadStream = function heldCreateReadStream(path, ...rest) {
  if (typeof path !== 'string' || !path.endsWith('.knct')) return createReadStream.call(this, path, ...rest);
  appendFileSync(events, `scan-held ${path}\n`);
  const held = new PassThrough();
  if (release) {
    const poll = setInterval(() => {
      if (!existsSync(release)) return;
      clearInterval(poll);
      createReadStream.call(this, path, ...rest).on('error', (err) => held.destroy(err)).pipe(held);
    }, 10);
  }
  return held;
};
syncBuiltinESMExports();
