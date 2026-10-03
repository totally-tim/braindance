/**
 * The one poll of `/record/state`, shared by the two surfaces that need it.
 *
 * **What is shared is the fetch and the change detection, and deliberately not the
 * painting.** The editor's `pollRecord` was welded to `paintRecord`, `recordState`
 * and the recorder's own elements, none of which exist on the gallery page - so
 * lifting the whole thing would have brought a pile of `null` element writes with
 * it, and copying the fetch into `library.js` would have been the second drifting
 * path this design keeps rejecting. What both surfaces genuinely have in common is
 * "ask the recorder what it is doing, on a cadence, and say whether it moved".
 *
 * **The gate lives at the caller, and that is not an accident of layering.** The two
 * surfaces want opposite things from the same tick. The editor paints on every one,
 * because the remaining-space readout changes on its own - another process writing,
 * a card filling - and a number that only moved when the recorder did would be stale
 * in the one direction that matters. The gallery must repaint on almost none of them:
 * `paint()` closes every menu, releases every skim and replaces every tile, so a
 * gallery that repainted every five seconds would fight the operator's pointer. A
 * module that decided this would have to be wrong for one of them.
 *
 * `/record/state` rather than `/library/all`, because it is the cheap question, and
 * that is measured rather than assumed. The library listing walks the captures
 * directory, reads a marks sidecar per take, and where a node is linked crosses the
 * network to have the same thing done over there; the recorder's state is memory the
 * process already holds, plus one small request to the node. Interleaved A/B on this
 * rig, 20 pairs against a 200-take library with both indexes warm and the first eight
 * pairs discarded as the page cache settling: **1.2ms for `/record/state` against
 * 145ms for `/library/all`**, so polling the listing itself would spend two hundred
 * sidecar reads every five seconds on both machines to answer a question that is
 * almost always no. The gallery pays for a listing only when the answer has changed.
 *
 * Not under a `record/` directory: `/record` is a namespace the server's route table
 * owns, and the dispatcher answers for every path under an owned namespace before the
 * file server gets a turn - so a module living there would be a 404 with a very
 * confusing shape. A flat name at the web root has no namespace to collide with.
 */

import { testTimer } from './test-timers.js';

// Five seconds, which is what the editor's own poll ran at and is short enough that a
// gallery tile stops lying within one of them. Not a parameter: two surfaces polling
// the same route at two cadences is two behaviours to reason about, and neither of
// them has a reason to want a different one.
const EVERY_MS = testTimer('record-poll', 5000);

/**
 * The fields of a node's `/record/state` this fingerprint is computed from, named once
 * so the link that admits a node can require exactly them.
 *
 * **A list rather than a spelling inside the expression below, because the boundary is
 * on the other machine's build and had no way to know what this reads.** A missing
 * field read as empty is right for a node that is simply not writing and wrong for one
 * that has never heard of the field: a build one older than this one answers
 * `/record/state` without `writingIds` at all, passes the manifest gate
 * `takes()` applies, and then reads as an idle recorder on every tick forever - so the
 * fingerprint is constant, no remote start or stop ever changes it, and the gallery
 * stops following the recorder it is drawing. Exported, so `server/library.js` requires
 * what this actually reads rather than a copy of it somebody has to remember to widen.
 */
export const POLLED_NODE_FIELDS = ['writingIds'];

/**
 * What a tick has to differ in for the answer drawn from it to be worth redrawing.
 *
 * The take each recorder still owns, on both machines - the one fact that decides what
 * a gallery tile is allowed to say about a take. Frame counts and free space move
 * constantly and are deliberately not in it, or the flag would be true on every tick
 * and mean nothing.
 *
 * **`writingIds` rather than the recording flag and the take id, and the difference is
 * the several seconds between them.** A take stops being recorded well before it stops
 * being the recorder's: the stream still has to flush, the marks still have to land and
 * the index and the content hash - which are what make the take a gallery entry at all
 * - are built after that. The flag went false at the front of that window, so a gallery
 * following it reread the library into the middle of a close and drew Download, Rename
 * and Remove over a take with no hash yet. `writingIds` spans the whole of it, so the
 * one repaint this poll pays for lands where the answer actually changed.
 *
 * **Every id rather than one, because a grabber restart owns two takes.** One id names
 * the new take and does not move when the old one's close finishes, so the old tile
 * would go on refusing every action until the new take stopped.
 *
 * **Both recorders, because the gallery is a view of both libraries.** A station with
 * a `--node` draws the node's takes into the same grid, and it is the machine the
 * gallery is actually used from - so a fingerprint over the local recorder alone was
 * constant for the life of that page and the remote tile never stopped claiming a
 * finished take was still being written. Whether the node can be reached is in it for
 * the same reason: the gallery prints "unreachable" beside the node's name, so a link
 * dropping or coming back changes what is on screen.
 */
const fingerprint = (state) => [
  String(state.writingIds ?? ''),
  state.node
    ? [state.node.reachable, ...POLLED_NODE_FIELDS.map((f) => String(state.node[f] ?? ''))].join(':')
    : '',
].join('|');

/**
 * Polls the recorder and hands every tick to `saw(state, changed)`.
 *
 * `changed` is true when this tick's fingerprint differs from the previous one's.
 *
 * **`believed` is what the caller has already drawn, and passing it is what makes the
 * first tick able to answer at all.** Without it the first tick has nothing to compare
 * against and must report `changed: false`, which is a hole rather than a caution: the
 * gallery reads `/library/all`, paints a take as being written, and only then asks the
 * recorder - so a take that stopped inside that gap is stopped in every fingerprint
 * this poll will ever compute, none of them differ, and the tile goes on refusing to
 * open a finished take until somebody reloads the page. Seeded, the first tick is a
 * comparison like every other one, against the world the caller actually drew.
 *
 * It is a state-shaped object rather than a fingerprint string, and it goes through
 * the same `fingerprint` above, so there is one expression of what counts as a change
 * rather than a caller's copy of it to drift.
 *
 * A caller with nothing painted yet passes nothing, and gets the old behaviour: the
 * first tick reports no change, because a first tick claiming one would make it do its
 * expensive thing once at load for no reason.
 *
 * **A tick counts as seen only once the caller has actually dealt with it, which is
 * what `await` and the missing assignment in the catch are for.** `previous` moving on
 * its own made a failed handler permanent: the gallery reads the library when this
 * reports a change, and one refresh losing its connection advanced the fingerprint past
 * the transition it failed on - so every later tick matched, reported no change, and the
 * grid kept a finished take's actions disabled until something else moved. A handler
 * that throws leaves `previous` where it was, so the next tick puts the same change in
 * front of it again and the retry costs nothing to arrange.
 *
 * Swallowed here rather than left to reject, because `tick` is what the interval calls:
 * an async function rejecting into a timer is an unhandled rejection and a console the
 * page's own error sweep would then fail on. The caller has already said whatever it
 * wants to say about its own failure - this only decides whether to ask again.
 *
 * Returns the tick itself, so a caller that has just changed something - pressing
 * record is the case - can ask again immediately instead of waiting out the cadence.
 * That is the same poll rather than a second one: it updates the same `previous`, so
 * the tick it displaces cannot report a change that has already been seen.
 */
export function pollRecordState(saw, believed = null) {
  let previous = believed === null ? null : fingerprint(believed);
  // **One tick at a time, which is the debt the retry above took on.** Holding
  // `previous` back until the handler finishes is what lets a failed refresh be offered
  // again - and it also means a handler that never finishes leaves every later tick
  // still reporting the same change. The interval does not care: it would start another
  // `/library/all` every five seconds for as long as the first one hung, and where the
  // library spans a linked node that is a request and a connection to the other machine
  // each time, accumulating for as long as the page is open. A node that accepts a
  // connection and then says nothing is not hypothetical here - `recordState` carries a
  // three-second timeout for exactly that machine.
  //
  // Skipped rather than queued, because a tick is a question about what is true now: a
  // queue of them would answer with a backlog of stale moments, and the one still in
  // flight is already asking the question the skipped tick wanted answered.
  //
  // **A caller asking during one gets a rerun rather than a discarded question, and
  // that is the difference between the two ways in.** The cadence wants the guard: a
  // tick that is still running is the tick this one would have been. The record button
  // wants the opposite - it awaits this to repaint from the state its own POST just
  // produced, so returning the request already in flight hands it a snapshot taken
  // *before* the press, and on a station with a slow `--node` that snapshot is several
  // seconds old. The button then re-enables against stale state and the next click can
  // choose start where it meant stop.
  //
  // One rerun however many callers ask, and they all await the same one: the question
  // is "what is true after my action", and a single fresh read answers it for all of
  // them. The interval comes in through `onCadence` below, which skips instead, so a
  // handler that hangs still cannot stack listings behind it.
  let running = null;
  let rerun = null;
  const tick = () => {
    if (running) {
      if (!rerun) rerun = running.then(() => { rerun = null; return tick(); });
      return rerun;
    }
    running = run().finally(() => { running = null; });
    return running;
  };
  const onCadence = () => { if (!running) tick(); };
  const run = async () => {
    let state;
    try {
      state = await (await fetch('/record/state')).json();
    } catch {
      // A server that went away is the status line's problem, not this one's, and a
      // poll that stopped on the first failed fetch would never notice it come back.
      return;
    }
    const mark = fingerprint(state);
    const changed = previous !== null && previous !== mark;
    try {
      await saw(state, changed);
      previous = mark;
    } catch { /* not seen, so not recorded as seen - the next tick offers it again */ }
  };
  tick();
  setInterval(onCadence, EVERY_MS);
  return tick;
}
