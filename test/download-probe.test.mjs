// A download's name probe against the recorder opening a take under that name, called directly: the
// recorder has to open the file after the probe has started and before the probe reads it, which no
// wire drive can order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pbkdf2 } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder } from '../server/recorder.js';
import { downloadTake } from '../server/library.js';
import { encodeMessage, TYPE_FRAME } from '../server/protocol.js';

test('the probe never reads the take the recorder opened under the name it probes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'braindance-probe-'));
  const recorder = new Recorder({ dir });
  try {
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const take = { id: `${day}-take1`, hash: `sha256:${'b'.repeat(64)}`, bytes: 1000 };
    // A node nothing answers at: the transfer fails after the probe, which is all this reads.
    const node = { url: 'http://127.0.0.1:9', name: 'pi', fetchJson: async () => { throw new Error('not reached'); } };
    // Four slow jobs fill the file-system thread pool, so the probe's first call runs after the
    // recorder has opened its take below.
    const busy = Array.from({ length: 4 }, () => new Promise((done) => { pbkdf2('x', 'y', 300_000, 64, 'sha512', done); }));
    const downloading = downloadTake(node, take, dir, { ownsFile: (identity) => recorder.ownsFile(identity) })
      .then(() => null, (err) => err.message);
    recorder.open(Buffer.from(JSON.stringify({ fx: 366, fy: 366, cx: 256, cy: 212 })));
    const payload = Buffer.alloc(64);
    for (let n = 0; n < 8; n++) {
      payload.writeBigUInt64LE(BigInt(1000 + n * 33), 8);
      recorder.write(encodeMessage(TYPE_FRAME, payload));
    }
    assert.equal(recorder.take?.id, take.id, 'the recorder opened its take under the name the download probes');
    const answer = await downloading;
    await Promise.all(busy);
    assert.equal(existsSync(join(dir, `${take.id}.idx`)), false,
      `nothing scanned the take being recorded - the download answered: ${answer}`);
  } finally {
    if (recorder.take) await recorder.close('done');
    await rm(dir, { recursive: true, force: true });
  }
});
