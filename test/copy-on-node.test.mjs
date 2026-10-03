// Which of the node's takes is the copy of one here, called directly. The marks sync refuses the
// take being recorded before it asks, so no wire drive reaches the rule for a take with no hash.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyOnNode } from '../server/library.js';

const node = { name: 'pi', lastError: null };
const HASH = `sha256:${'a'.repeat(64)}`;
const open = { id: '2026-09-18-take2', hash: null, recording: true };
const finished = { id: '2026-09-18-take1', hash: HASH, recording: false };

test('a take with no hash is the copy of nothing on the node, not even of its open take', () => {
  assert.equal(copyOnNode(node, [open, finished], null), null);
  assert.equal(copyOnNode(node, [open, finished], undefined), null);
});

test('and a hashed take still finds its copy by hash, so the rule above is not a join switched off', () => {
  assert.equal(copyOnNode(node, [open, finished], HASH), finished);
});
