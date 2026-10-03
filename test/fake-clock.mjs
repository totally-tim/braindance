// A clock a test winds by hand, built on mock.method because node:test's own
// mock.timers landed after the oldest Node the checks run. tick(ms) fires every
// timer whose time came, in the order they were due; an interval keeps cadence
// and can fire more than once inside a single tick.
export function fakeClock(t) {
  let now = 0;
  const timers = [];
  const add = (fn, ms, every) => {
    const timer = { fn, at: now + Math.max(ms ?? 0, 0), every };
    timers.push(timer);
    return timer;
  };
  const drop = (timer) => {
    const i = timers.indexOf(timer);
    if (i !== -1) timers.splice(i, 1);
  };
  t.mock.method(globalThis, 'setTimeout', (fn, ms) => add(fn, ms, 0));
  t.mock.method(globalThis, 'setInterval', (fn, ms) => add(fn, ms, ms));
  t.mock.method(globalThis, 'clearTimeout', drop);
  t.mock.method(globalThis, 'clearInterval', drop);
  return {
    tick(ms) {
      now += Math.max(ms, 0);
      for (;;) {
        let due = null;
        for (const timer of timers) {
          if (timer.at <= now && (!due || timer.at < due.at)) due = timer;
        }
        if (!due) return;
        if (due.every) due.at += due.every;
        else drop(due);
        due.fn();
      }
    },
    get pending() {
      return timers.length;
    },
  };
}
