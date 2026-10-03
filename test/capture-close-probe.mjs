// Loaded into a replay server with `node --import`, so a test can see from outside what a shutdown
// does to the capture: one line per event in the events file, in order. The probe wraps the
// capture's own methods and the server's code is untouched. The mode is the test's to choose:
//   hold    the close waits for the release file, so a test can look at the server while it is pending
//   reject  the close finishes, then fails with a known message
//   (none)  the close runs as it is

import { appendFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const { BRAINDANCE_PROBE_CAPTURE: capture, BRAINDANCE_PROBE_EVENTS: events,
  BRAINDANCE_PROBE_MODE: mode, BRAINDANCE_PROBE_RELEASE: release } = process.env;

// The module the server will import, named by path: a staged copy of the server has its own.
const { Capture } = await import(pathToFileURL(capture).href);
const note = (event) => appendFileSync(events, `${event}\n`);

const { close, readFrame } = Capture.prototype;

Capture.prototype.readFrame = function probedReadFrame(...args) {
  note('frame-read');
  return readFrame.apply(this, args);
};

Capture.prototype.close = async function probedClose() {
  note('close-begun');
  if (mode === 'hold') while (!existsSync(release)) await sleep(10);
  try {
    await close.call(this);
    if (mode === 'reject') throw new Error('injected: the capture would not close');
  } catch (err) {
    note('close-rejected');
    throw err;
  }
  note('close-ended');
};
