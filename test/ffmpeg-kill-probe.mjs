// Loaded into a server with `node --import`, so a test can decide how `kill` answers for a child
// spawned from `FFMPEG`. A child with no pid never spawned: the call is recorded and answered false,
// and never reaches Node's own `kill`, which would pass kill(2) a pid libuv never set. For any other
// FFMPEG child BRAINDANCE_PROBE_KILL says what `kill` does:
// - `refuse`: what Node does when kill(2) fails with EPERM. It emits `error`, returns false and
//   leaves the child running.
// - `gone`: the child is killed, and `kill` returns false with no `error`, as Node does for ESRCH.
// - `stray-error`: `kill` returns true and sends nothing, and an `error` follows before any exit.
// Each call adds a line to the events file when one is named. The server's code is untouched.

import { appendFileSync } from 'node:fs';
import { ChildProcess } from 'node:child_process';

const { BRAINDANCE_PROBE_EVENTS: events, BRAINDANCE_PROBE_KILL: mode } = process.env;
const { kill } = ChildProcess.prototype;

ChildProcess.prototype.kill = function probedKill(signal) {
  if (this.pid === undefined) {
    if (events) appendFileSync(events, `kill-without-pid ${this.spawnfile} ${signal}\n`);
    return false;
  }
  if (this.spawnfile !== process.env.FFMPEG) return kill.call(this, signal);
  if (events) appendFileSync(events, `kill ${this.pid} ${signal}\n`);
  if (mode === 'refuse') {
    this.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM', errno: -1, syscall: 'kill' }));
    return false;
  }
  if (mode === 'gone') {
    kill.call(this, signal);
    return false;
  }
  if (mode === 'stray-error') {
    setImmediate(() => this.emit('error', new Error('a stray error before the exit')));
    return true;
  }
  throw new Error(`BRAINDANCE_PROBE_KILL is ${mode}, not refuse, gone or stray-error`);
};
