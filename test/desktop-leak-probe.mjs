// Run as a process of its own by test/desktop-service.test.mjs. It starts the stub that ignores the
// stop line, writes the stub's pid to LEAK_PID_FILE, says when it is ready, and then ends the way
// LEAK_CASE names: a failed assertion, a test that times out, or nothing, for the parent to kill.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startStub } from './desktop-stub.mjs';

const where = { dir: process.env.LEAK_DIR, stub: join(process.env.LEAK_DIR, 'stub-service.mjs') };
const kind = process.env.LEAK_CASE;

test(`a test that ends by ${kind} with the stub running`, { timeout: kind === 'timeout' ? 1500 : undefined }, async (t) => {
  const service = startStub(t, where, 'deaf', { stopGraceMs: 700 });
  writeFileSync(process.env.LEAK_PID_FILE, String(service.pid));
  await service.ready;
  process.stderr.write('the service is ready\n');
  if (kind === 'assertion') assert.fail('forced failure with the service running');
  await new Promise(() => {});
});
