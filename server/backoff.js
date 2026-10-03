// How long a grabber that failed to run waits before the next start, and when the server decides
// there is no sensor here at all. Held apart from `server/index.js` so the ladder can be run
// against a clock in a test.

import { testTimer } from '../web/test-timers.js';

// The Kinect v2 drops off the bus under sustained load on a marginal USB link, so a dead grabber
// is an expected condition rather than a fatal one.
export const RESTART_DELAYS = testTimer('restart-delays', [1000, 2000, 4000, 8000]);

// How long to leave between attempts once the conclusion is that there is no sensor here. Long,
// because the enumeration will not find one - but not never, so a sensor plugged in
// later is picked up.
export const ABSENT_DELAY = testTimer('absent-delay', 30000);

/**
 * The wait before the next start, after `attempt` failed ones since the last clean handshake.
 * `everLive` says whether a sensor has ever handshaken with this process, and `absent` is the
 * conclusion that none is plugged in.
 */
export function retryAfter({ attempt, everLive }) {
  // A grabber that has *never* handshaken is a machine with no sensor rather than the flaky USB
  // link this backoff is for. The full table is spent first, because a node whose sensor is slow
  // to enumerate at boot is the same shape for a few seconds.
  const absent = !everLive && attempt >= RESTART_DELAYS.length;
  return { absent, delayMs: absent ? ABSENT_DELAY : RESTART_DELAYS[Math.min(attempt, RESTART_DELAYS.length - 1)] };
}
