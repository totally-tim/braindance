// The product timers a proof tool may shorten, so a check runs the real code path without waiting
// out the shipped delay. A normal launch plants neither carrier, so every timer keeps the value it
// ships with: a Node process reads JSON from the `BRAINDANCE_TEST_TIMERS` environment variable, and
// a page reads the same JSON from its `test-timers` query parameter.

// Every timer that reads through `testTimer`, so a planted name that none of them answers to is
// refused rather than leaving the shipped value running under a check that believes it shortened it.
const NAMES = new Set([
  'record-poll', 'listing-timeout',
  'linger',
  'idle-tick', 'restart-delays', 'absent-delay', 'standby-grace',
  'renderer-idle',
  'store-read-gap',
]);

const planted = globalThis.process?.env?.BRAINDANCE_TEST_TIMERS
  ?? (globalThis.location ? new URLSearchParams(globalThis.location.search).get('test-timers') : null);

const substitutes = planted ? JSON.parse(planted) : {};
if (substitutes === null || typeof substitutes !== 'object' || Array.isArray(substitutes)) {
  throw new Error(`test timers must be a JSON object of names to milliseconds, not ${planted}`);
}
const unknown = Object.keys(substitutes).filter((name) => !NAMES.has(name));
if (unknown.length) {
  throw new Error(`no timer answers to the test timer ${unknown.join(', ')}; the timers are ${[...NAMES].join(', ')}`);
}

const isDelay = (ms) => typeof ms === 'number' && Number.isFinite(ms) && ms >= 0;

/**
 * The value timer `name` runs at: `shipped`, unless a proof run planted a substitute. A substitute
 * has the shipped value's shape, a delay or a list of delays, and says so on the log once.
 */
export function testTimer(name, shipped) {
  if (!NAMES.has(name)) throw new Error(`test timer ${name} is not in the list of timers a run may shorten`);
  if (!Object.hasOwn(substitutes, name)) return shipped;
  const value = substitutes[name];
  const fits = Array.isArray(shipped)
    ? Array.isArray(value) && value.length > 0 && value.every(isDelay)
    : isDelay(value);
  if (!fits) throw new Error(`test timer ${name} must be shaped like ${JSON.stringify(shipped)}, not ${JSON.stringify(value)}`);
  console.info(`[timers] ${name} runs at ${JSON.stringify(value)}ms for a proof run; it ships at ${JSON.stringify(shipped)}ms`);
  return value;
}
