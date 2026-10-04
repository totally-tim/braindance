// Loaded into a server with `node --import`, so a test can stop a server whose ffmpeg does not take
// its kill. `kill` on a child spawned from `FFMPEG` does what Node's own does when kill(2) fails with
// EPERM: it emits `error`, returns false and leaves the child running. The server's code is
// untouched.

import { ChildProcess } from 'node:child_process';

const { kill } = ChildProcess.prototype;

ChildProcess.prototype.kill = function refusedKill(signal) {
  if (this.spawnfile !== process.env.FFMPEG) return kill.call(this, signal);
  this.emit('error', Object.assign(new Error('kill EPERM'), { code: 'EPERM', errno: -1, syscall: 'kill' }));
  return false;
};
