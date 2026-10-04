// Loaded into a server with `node --import`, so a test can stop a take's close inside its scan: a
// read stream opened on a `.knct` file by path never delivers a byte, and the events file gets one
// line per such stream. That is where a host's stop deadline lands on a long take. The server's
// code is untouched; `node:fs` is patched and its named exports synced before the server loads.

import fs, { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Readable } from 'node:stream';

const { BRAINDANCE_PROBE_EVENTS: events } = process.env;
const { createReadStream } = fs;

fs.createReadStream = function heldCreateReadStream(path, ...rest) {
  if (typeof path !== 'string' || !path.endsWith('.knct')) return createReadStream.call(this, path, ...rest);
  appendFileSync(events, `scan-held ${path}\n`);
  return new Readable({ read() {} });
};
syncBuiltinESMExports();
