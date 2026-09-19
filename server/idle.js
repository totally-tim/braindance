// The deadline an idle sensor keeps, for the five-second tick that decides whether it stands down.
// Held here rather than inline in `server/index.js` because the states worth waiting through are
// fewer than the states a sensor passes through, and a tick that starts the count again on each of
// the extras sets it back often enough that a flapping link never stands down at all.

import { testTimer } from '../web/test-timers.js';

// How often the server asks the deadline, so a sensor stands down less than two of these late.
export const IDLE_TICK_MS = testTimer('idle-tick', 5000);

// An absent sensor is excluded by the design and a standby one has already stood down, so neither
// carries a deadline.
const HOLDS_NO_DEADLINE = new Set(['absent', 'standby']);

export class IdleDeadline {
  /** `afterMs` is `--standby-after`; the tick that asks it is the server's five-second one. */
  constructor({ afterMs }) {
    this.afterMs = afterMs;
    this.since = null;
  }

  /** A wake begins the count again. */
  reset() { this.since = null; }

  /**
   * One observation of the sensor, and what it does to the deadline. `idle` says nothing is being
   * served, `state` is the sensor's own, and the answer says how long has been waited and whether
   * it has run out.
   */
  ask({ idle, state, now = Date.now() }) {
    if (!idle || HOLDS_NO_DEADLINE.has(state)) {
      this.since = null;
      return { waitingMs: 0, expired: false };
    }
    // `starting` is the gap between two retry attempts. It neither begins a count of its own nor
    // interrupts one already running, so the deadline a flapping link is held to is the one it
    // started when the sensor was last seen live or lost.
    if (this.since === null) {
      if (state !== 'starting') this.since = now;
      return { waitingMs: 0, expired: false };
    }
    const waitingMs = now - this.since;
    return { waitingMs, expired: waitingMs >= this.afterMs };
  }
}
