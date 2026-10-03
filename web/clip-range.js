// Which part of the program a deliverable covers, and what a trim is allowed to be.
//
// Two numbers and the one door that writes them. The numbers are program seconds rather
// than frames, so they survive an output-fps change, and `out` is `null` when the clip
// runs to the end of the program - a statement rather than a time, because "to the end"
// has to survive a speed change that lengthens the program and a duration written down here
// would freeze it at today's length.
//
// **The door is a file because the claim it makes could not be true inside one.** The
// comment this header replaces said `setClipInOut` was the one door every writer of the
// pair passes, so there was no second clamp to keep in step with it. That was an intention
// rather than a description: the two ruler markers' `pointermove` assigned the bindings
// directly, with a clamp of their own, and reached the door only when the pointer came up.
// Measured on the build before this split: dragging `#tOut` left of the in point while the
// out point was `null` drew the marker where the pointer was, and the release then clamped
// it back up to the in point - a drag showing a trim its own release refused. Nothing in
// the suite could see it, because a marker drag is asserted after `pointerup`.
//
// Here the bindings are module-private in the only sense that matters: an importer can
// read them and cannot assign to them, so the door is the one way in because the language
// says so rather than because a comment does. What used to be a second clamp is now the
// same call with a different tail - `main.js` decides whether the write also moves the
// deliverable, commits an undo step and seeks the transport, and the arithmetic that
// decides what the pair may hold is asked once, here.
//
// The program's current length arrives as an argument rather than being read, and `null`
// is how the caller says there is no take open yet. That is what lets the clamp be a node
// test instead of a browser with a capture in it: the rule is "hold the trim inside the
// program that is open", and a transport is not needed to state it.

// What a clip bound is allowed to be, asked in one place because two callers need the
// same answer and a second copy of it is the drift this design keeps refusing.
//
// `null` is a statement rather than a time, and it is only ever legal at the out point:
// there it means "to the end", which has to survive a speed change that lengthens the program
// and so cannot be written down as a number. At the in point, and for anything else that
// is not a finite number, there is no reading to recover - so it is refused.
export function clipBoundOrThrow(value, which) {
  if (value === null && which === 'out') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  throw new Error(
    `the clip's ${which} point is ${JSON.stringify(value) ?? String(value)}, which is not a program `
    + 'time: a trim carries finite seconds, and holding a value that is not one inside the program '
    + 'spreads it through both bounds and leaves the transport no range at all',
  );
}

// Clip in/out points are program seconds, not frames, so they survive an output-fps
// change. `out` is null when the clip runs to the end of the program. The transport
// and the export read these directly; the UI drags them on the ruler.
export let clipIn = 0;
export let clipOut = null;

/**
 * The pair, written: refused if it is not a time, then held inside the program that is
 * open. `dur` is the program's length in seconds, or `null` when no take is open.
 *
 * A field left `undefined` keeps whatever it held, which is how the two marker drags say
 * which end they mean. Nothing here paints, seeks or records an undo step - what a write
 * means to the rest of the editor is the caller's, and the two callers differ in exactly
 * that: a drag in progress previews, a drag that has ended commits.
 */
export function writeClipRange(values, dur) {
  const { in: inn, out } = values;
  // **Refused before either binding is written, because the clamp below is arithmetic and
  // arithmetic on something that is not a number does not fail - it spreads.** An `in` of
  // `"start"` makes `Math.min(clipIn, dur)` NaN, and the `Math.max(clipIn, ...)` that holds
  // the out point up then carries that NaN into a bound which was perfectly good: both ends
  // are gone, the transport's `clipOutSec` answers NaN, and its `frameAt` resolves every
  // position to NaN. The getter this clamp was put in front of coerced instead -
  // `Number(clipIn) || 0` read a malformed `in` as zero and left a valid `out` alone - so
  // clamping without refusing first is strictly worse than what it replaced, on exactly the
  // documents it exists to survive.
  //
  // `undefined` is not that case and must not be refused: it is how the two marker drags say
  // which end they mean, and a drag writes one bound while the other keeps whatever it held.
  // A document has no such reading, which is why `applyDeliverable` asks the same question
  // about both of its fields and gets a refusal where this gets a pass.
  const nextIn = inn === undefined ? undefined : clipBoundOrThrow(inn, 'in');
  const nextOut = out === undefined ? undefined : clipBoundOrThrow(out, 'out');
  if (nextIn !== undefined) clipIn = nextIn;
  if (nextOut !== undefined) clipOut = nextOut;
  // **Held inside the program that is open, because the two getters the transport reads
  // this through are not symmetric.** `clipOutSec` is bounded above by the take's
  // duration and `clipInSec` is bounded below by zero and above by nothing, so an `in`
  // past the program's end makes `clipInSec` the larger of the two and `frameAt`
  // composes to a constant: its inner `Math.min` can never exceed the out point, so its
  // outer `Math.max` always answers the in point. Every position the editor can ask for
  // then comes back as the same frame - seek, draft, redraw, `goTo`, Home, End, the
  // arrow steps and the scrubber's release alike - while the readout goes on naming a
  // range that has nothing in it.
  //
  // A deliverable is how that arrives. `applyDeliverable` writes a saved document's
  // program times as they stand rather than into the rate the clip happens to be in, so
  // a trim authored at 1x lands past the end of the same take played at 2x, and nothing
  // upstream of here compares it against the take that is open.
  //
  // **Here rather than in those getters, and here rather than at `applyDeliverable`.**
  // This is the only thing that can write the pair - the two marker drags, the rate
  // rescale in `reparameteriseProgramTime`, the deliverable and the two buttons that set
  // a bound from the playhead all come through it - so there is no second clamp to keep in
  // step with this one, and the writer added next year is held by existing. The markers
  // still clamp themselves at their own ends, which is a different rule: it decides where
  // a *pointer* may put a marker, where this decides what the pair may be at all.
  //
  // What it deliberately does not do is make an empty range usable. A trim that lands
  // wholly past the end has nothing in it, so it collapses to a point at the end - which
  // is the state the two markers dragged together already reach, and it is explained by
  // the same picture rather than by a frozen transport nothing on screen accounts for.
  if (dur !== null) {
    clipIn = Math.max(0, Math.min(clipIn, dur));
    // `null` still means "to the end", which is a different statement from a number that
    // happens to equal the duration: "whole clip" has to survive a speed change that lengthens
    // the program, and a duration written in here would freeze it at today's length.
    if (clipOut !== null) clipOut = Math.max(clipIn, Math.min(clipOut, dur));
  }
}
