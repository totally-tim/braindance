// Proves the gallery and the library: one manifest over a directory of takes, one
// library spanning two machines joined by content hash, a project that survives a
// round trip through a file, and the two removals doing what their names say.
//
// **This check owns its servers rather than taking one.** Every other proof tool
// here points at a running instance, and this one cannot: its central claim is
// about *two* machines reconciling, which needs two processes with separate
// capture directories, and three of its mutations are in server code that no
// served page can reach. So it builds a fixture directory, spawns a node and an
// editing machine against a copy of `server/`, and tears both down. What it points
// at is therefore exactly what it built, which is also what makes the fixture
// arms below possible at all.
//
// Six claims, checked apart because they fail for different reasons.
//
// The **manifest** has to report the hash step 2's scan produces, and has to stop
// reporting it the moment the bytes change. A gallery that served a stale hash
// would hand the reconciliation below a lie and hand a project file a take that is
// no longer the take it was authored against.
//
// **Reconciliation is by content hash and never by name.** Both directions: the
// same bytes under two different filenames are one take, and different bytes under
// the same filename are two.
//
// A **project round-trips through a file**. Save it, load it back, render the same
// program positions: the same images. That is the claim step 3 made for the
// registry, extended to the door a file arrives through - with the same
// falsification control, since an equality between two renders of the same live
// state would pass against a loader wired to nothing.
//
// The **load path refuses**. A project file is the first thing in this build that
// comes from outside the running page, and three known gaps converge on it: an
// unversioned document whose point size cannot be interpreted, a retime curve that
// falls, and a quaternion that is not of unit length. Each is a *silent* wrong
// image rather than a crash, which is why each is checked by name.
//
// **Reclaim and delete are different actions.** The falsification control is not
// that reclaim runs - it is that reclaim *refuses* when the copy it rests on is
// not the copy it thinks: the surviving take is corrupted on disk and the reclaim
// has to notice, which an implementation trusting a manifest that said `both` a
// moment ago cannot.
//
// And **the descriptor bound holds**, because step 2 left that debt to this step
// by name. Skimming a directory of takes must not accumulate open files.
//
// The arms sweep what the interface actually offers rather than what is convenient.
// Step 6 learned this the expensive way: every arm of `export-check` was aspect
// 1.6 while every size the export menu ships is 16:9, so a whole class of scaling
// bug was invisible however many arms agreed. The constants this tool sweeps are
// therefore checked against the constants the gallery and the server offer - the
// three states, the two divisors the tiles use plus both ends of the range the
// server accepts, zero, one and several marks, a mark at the very start and a mark
// past the end of the edit, a truncated take, a take with no hello, a take with
// one frame, and an empty library. Anything the UI can produce that this does not
// stand in front of is a hole until it is measured otherwise.
//
//   node tools/library-check.mjs
//   node tools/library-check.mjs --mutate reconcile-by-filename   # ... and must FAIL

import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, mkdirSync, readdirSync, rmSync, symlinkSync, existsSync, readFileSync, writeFileSync, appendFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createConnection } from 'node:net';
import { createServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { MessageParser, TYPE_HELLO, TYPE_FRAME, encodeMessage } from '../server/protocol.js';
// The shipped argument shape per platform, read rather than restated - see the reveal
// argv row for what a second copy of it cost.
import { REVEAL } from '../server/library.js';
// The format version, imported rather than written down. Every document these tools
// construct or assert on has to carry the one this build writes, and a literal here
// is a second copy of it - which is exactly what had to be hand-swept when the
// readings dissolved the mode and the version moved from 3 to 4.
import { PROJECT_VERSION, CAPTURE_FORMAT } from '../web/format.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SAMPLE = flag('--capture') ?? join(REPO, 'captures/sample.knct');
const NODE_PORT = Number(flag('--node-port', '8210'));
const MAC_PORT = Number(flag('--mac-port', '8211'));
// **How far above `--mac-port` this suite binds, declared rather than left to be
// discovered by collision.** Sections spawn their own servers at `MAC_PORT + n` for a
// scattered set of `n`, and the run instructions used to name only `+2/4/5` while the
// code had grown as far as `+16`. Two worktrees running this at once therefore did not
// collide loudly - they shared a server, because `startServer` polled until *something*
// answered `/library/takes` and a stranger answers that just as well as its own child.
//
// Observed rather than predicted: a run on this machine failed six recorder rows with
// `undefined counted, -1 on disk` because `MAC_PORT + 9` belonged to another worktree,
// and the failure reads exactly like a finding about the recorder. The span is checked
// end to end before anything spawns, and `startServer` asserts its port is inside it, so
// a section added later at `+17` is caught by arithmetic rather than by a wrong reading.
//
// **The span stayed at 16 and the collision inside it was fixed instead**, which is worth
// saying because widening was the first answer and it is the wrong one. Every worktree on
// this machine has to find the whole span free, so two more ports is a cost paid by
// everybody to route around a bug in the bookkeeping - and the bug is one offset naming
// two servers in `servers`, which `startServer` now drops the stale half of. Reuse is
// deliberate here rather than tolerated: `+14` is a rename server and later a
// broken-preset one, and an offset with a live holder cannot be taken at all, because the
// kernel refuses the bind.
const PORT_SPAN = 16;
const MUTATE = flag('--mutate');
const HEADED = argv.includes('--headed');
const WORK = flag('--work') ?? join(REPO, '.library-check');

let failures = 0;
let assertions = 0;
// Claims this run could not make a fixture for. Named in the verdict rather than
// left out of it: a check that quietly drops an assertion where the platform will
// not give it a fixture is a check reporting coverage it does not have.
const skipped = [];
const check = (ok, label, detail = '') => {
  assertions++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --------------------------------------------------------------------- mutations
//
// A mutation is a piece of source text, so it stops matching the moment the code it
// names is edited - and the exactly-once refusal below is the only warning anyone
// gets that an anchor has gone stale. A replacement that silently matched nothing
// would run the unmutated build and be recorded as this tool having missed a bug it
// was never shown.
//
// Server files and page files both appear here, in one table, and they are delivered the
// same single way: `stageServer` writes the mutated file into the copied tree, and the
// server spawned out of that tree is what serves it. Page files were once fulfilled
// separately, by a Playwright route interception, and that second mechanism is gone
// rather than dormant - see `stageServer` for why two paths delivering the same bytes was
// a hazard, and `requireMutationDelivered` for the refusal that replaced it. One
// namespace, because the safety property is the refusal and splitting it would make it
// possible to have two rules about it.

// **The reveal mutation has to break the branch this platform actually runs.** It
// edited the Darwin entry only, so on Linux or Windows the staged server kept its own
// unchanged branch, the argv assertion passed, and the control reported zero failures
// while proving nothing - a falsification control that cannot fire, which is the exact
// shape this file exists to refuse. Derived from `process.platform` so the anchor is
// the live line wherever it runs; an unknown platform falls back to Darwin, where the
// mutation at least refuses to match rather than passing quietly.
const REVEAL_EDITS = {
  darwin: [
    "  darwin: { program: 'open', label: 'Finder', args: (path) => ['-R', path] },",
    "  darwin: { program: 'open', label: 'Finder', args: () => ['-R'] },",
  ],
  linux: [
    "  linux: { program: 'xdg-open', label: 'the file manager', args: (path) => [dirname(path)] },",
    "  linux: { program: 'xdg-open', label: 'the file manager', args: () => [] },",
  ],
  win32: [
    "  win32: { program: 'explorer', label: 'Explorer', args: (path) => [`/select,${path}`] },",
    "  win32: { program: 'explorer', label: 'Explorer', args: () => ['/select,'] },",
  ],
};
const REVEAL_EDIT = REVEAL_EDITS[process.platform] ?? REVEAL_EDITS.darwin;

const MUTATIONS = {
  // The library joins on the filename instead of the hash. Two names for one take
  // become two takes, and the payoff of hash-referencing captures is gone.
  'reconcile-by-filename': { file: 'server/library.js', edits: [[
    "  const keyOf = (take, side) => take.hash ?? `${side}:${take.id}`;",
    '  const keyOf = (take) => take.id;',
  ]] },
  // The index cache stops testing whether the sidecar still describes the file, so
  // a take whose bytes changed keeps reporting the hash it had before.
  'manifest-trusts-cache': { file: 'server/capture.js', edits: [[
    '  if (held && held.bytes === st.size && held.mtimeMs === st.mtimeMs) return held;',
    '  if (held) return held;',
  ]] },
  // Reclaim trusts the listing instead of re-hashing the copy that is supposed to
  // survive. A take truncated since the last listing is then treated as the
  // verified copy this reclaim rests on, and the node's copy goes anyway.
  'reclaim-trusts-manifest': { file: 'server/index.js', edits: [[
    '    const verified = await hashFile(join(CAPTURES_DIR, mine.file));',
    '    const verified = mine.hash;',
  ]] },
  // Descriptors are never evicted, which is the shape step 2 shipped and named as
  // this step's debt: a library skimming a directory of takes hits EMFILE.
  'no-fd-eviction': { file: 'server/capture.js', edits: [[
    '  if (openCaptures.size <= MAX_OPEN_CAPTURES) return;',
    '  if (true) return;',
  ]] },
  // The replay's handle goes back to being evictable. It holds no lease and its
  // `usedAt` never moves, so it is not merely a candidate - it is the *first* one,
  // and a library skimmed while a replay is running closes the replay's own
  // descriptor underneath it.
  'replay-handle-evictable': { file: 'server/index.js', edits: [[
    '  capture.retain();',
    '  /* mutation: the replay holds no lease */',
  ]] },
  // The take file gets no hello, so the recording is complete and unopenable: its
  // intrinsics are unknown, and unprojecting it on the boot defaults is an error
  // nothing on screen can show. This is the falsification control for the
  // hello-at-head row, which would otherwise be an assertion that a `1` is a `1`.
  //
  // It replaced a mutation that deferred the take's opening by a microtask, and the
  // replacement is worth recording rather than quietly swapping. That mutation
  // **provably moved nothing**, twice, with the writer arranged as adversarially as
  // a pipe allows - hello and a ten-frame burst in a single `write`. The reason is
  // structural: one frame is 486KB and a pipe's buffer is 64KB, so a `data` event
  // carrying the hello can carry at most a fragment of the frame behind it, the
  // parser yields the hello alone, and the deferred open completes before any whole
  // frame arrives. The ordering was still made synchronous, because a property that
  // holds because of a buffer size is not a property - but it is hardening rather
  // than a measured fix, and a mutation that does nothing reads as a check that
  // found nothing.
  'recorder-skips-hello': { file: 'server/recorder.js', edits: [[
    '    stream.write(helloMessage);',
    '    /* mutation: the take begins at the first frame */',
  ]] },
  // A grabber restart no longer ends the take, so the next hello and a timestamp
  // discontinuity land in the middle of a take file - which every downstream
  // consumer assumes cannot happen.
  'restart-appends-to-take': { file: 'server/index.js', edits: [[
    "      recorder.split().catch((err) => console.error(`[recorder] ${err.message}`));",
    '      /* mutation: the take runs across the restart */',
  ]] },
  // A take starts however little room is left, so it dies partway through instead
  // of never starting.
  'recorder-ignores-space': { file: 'server/recorder.js', edits: [[
    '    if (left.secondsLeft < MIN_TAKE_SEC) {',
    '    if (false) {',
  ]] },
  // A name already taken disarms the recorder instead of stepping over it. This is
  // the shape that shipped for one round: a second writer on the same captures
  // directory silently stops a shooting node with one line in the log, which is
  // worse than refusing to start, because refusing to start is at least a decision
  // somebody can see.
  'eexist-disarms': { file: 'server/recorder.js', edits: [[
    `        console.warn(\`[recorder] \${id} is already taken, trying the next name\`);
        floor = n;`,
    `        console.warn(\`[recorder] \${id} is already taken\`);
        this.armed = false;
        this.onChange(this.state);
        return;`,
  ]] },
  // The depth divisor strides the flat byte array instead of sampling per axis, so
  // the count is right and the grid is not: every k-th sample along one row and
  // none at all along the column.
  'decimate-flat-stride': { file: 'server/capture.js', edits: [[
    `    for (let x = 0; x < w; x++) out.writeUInt16LE(payload.readUInt16LE(src + x * k * 2), dst + x * 2);`,
    `    for (let x = 0; x < w; x++) out.writeUInt16LE(payload.readUInt16LE(16 + ((y * w + x) * k) * 2), dst + x * 2);`,
  ]] },
  // The colour block is dropped from a decimated frame. Still smaller, still a
  // KNCT frame, and no longer the mechanism the 21ms-per-position number describes -
  // colour is 52KB of that 79KB.
  // Re-anchored when step 9 lifted the sampling loop out of `Capture.readFrame` and
  // into the module-level `decimatePayload` the live socket shares - the body is
  // unchanged and two spaces to the left, which is exactly the shape the
  // match-exactly-once rule exists to surface rather than swallow.
  'decimate-drops-colour': { file: 'server/capture.js', edits: [
    ['  out.writeUInt32LE(colorBytes, 4);', '  out.writeUInt32LE(0, 4);'],
    ['  payload.copy(out, 16 + w * h * 2, 16 + depthBytes);', '  /* mutation: colour dropped */'],
  ] },
  // The document version stops being checked, so a file whose point size is in the
  // old unit loads silently and draws 1.8x wrong at every output size.
  'accept-any-version': { file: 'web/main.js', edits: [[
    '  if (project.version !== PROJECT_VERSION) {',
    '  if (false) {',
  ]] },
  // **The capture format's band comes off.** A take whose hello declares a generation
  // this build has never read is opened on this build's assumptions instead of being
  // refused - which is the whole of the failure the format number exists to prevent,
  // arrived at from the inside: one geometry model applied to two archives, silently.
  //
  // The edit is the accepting branch rather than the sentence, so the refusal below it
  // survives as unreachable code and the mutated build still parses. It is in
  // `web/format.js` because that is where the one predicate lives, and the interesting
  // half of that is what it reaches: this file is imported by `server/library.js` on
  // Node *and* served to both pages, so a single edit here reddens the server's
  // `openable`, the gallery's badge and dead Open button, and the editor's own throw
  // together. If it reddened only some of them, the band would have stopped being one
  // predicate and become three that agree - which is what this control is for.
  'open-ignores-format': { file: 'web/format.js', edits: [[
    "  if (format === CAPTURE_FORMAT) return '';",
    "  return ''; /* mutation: every generation opens on this build's assumptions */",
  ]] },
  // The retime guard comes off the file door. This is the door step 5 named and
  // left open, and a descending region does not merely fail - it can pass the
  // residency guard vacuously and stop playback with the play button still lit.
  'load-skips-monotonic': { file: 'web/main.js', edits: [[
    '  retime.assertMonotonic(restoredRetime);',
    '  /* mutation: the curve arrives unchecked */',
  ]] },
  // The quaternion length check comes off, which is the gap step 5 carried: four
  // finite numbers accepted as a rotation, and a camera move nobody authored.
  'accept-any-quaternion': { file: 'web/main.js', edits: [[
    '    if (Math.abs(len - 1) > 1e-3) {',
    '    if (false) {',
  ]] },
  // Track key values stop going through the registry on the way in, so the
  // quaternion check above is never reached by the door a hand-edited camera track
  // actually comes through.
  'keys-bypass-registry': { file: 'web/main.js', edits: [[
    '      key.value = params.normalise(name, key.value);',
    '      /* mutation: the key value is taken as it arrived */',
  ]] },
  // **`preset-through-setmode` was here and is deleted rather than re-anchored,
  // because the bug it planted can no longer be written.**
  //
  // It applied a user's preset by writing its values and *then* selecting its mode
  // through `setMode`, which applied the hardcoded BLACKWALL look as part of selecting
  // mode 4 - so the user's own twelve values were overwritten on the way past and the
  // preset appeared to load while not being the preset. That required two things which
  // both stopped existing when the readings became registry parameters: a preset
  // carrying a mode beside its values, and a door that applied a look as a side effect
  // of selecting a reading. There is one door now and it writes what it is given.
  //
  // Re-anchoring it onto the nearest surviving line would have kept a red row that
  // tested a different property under an old name, which is how a suite ends up with
  // mutations nobody can map back to a hazard. The property it protected - that
  // applying a stored preset lands the user's own values and not somebody else's - is
  // still asserted, by the section that applies a preset and compares the look.
  // A save over a shipped look overwrites it instead of forking it. The control for
  // the built-in root: without it, "the shipped looks cannot be lost" is a claim the
  // check makes about itself, and every row of it would pass just as well against a
  // store with one directory. The write path is what is mutated rather than the read
  // path, because a read that fell back correctly and a write that landed in the
  // wrong place look identical from the listing.
  //
  // Narrow on purpose. A first pass routed *every* write through `readPathFor`, which
  // sends a name that exists in neither root to the shipped directory - so saving a
  // brand new preset landed somewhere nothing looked, the run died 135 assertions in
  // with an ENOENT, and the fork rows it was written for never executed. A mutation
  // that kills the harness before reaching its target is not a caught mutation. This
  // one moves only names that already ship, which is exactly the fork it must break.
  'write-overwrites-builtin': { file: 'server/library.js', edits: [[
    `    const path = this.pathFor(name);
    // Captured here, on the same tick as the increment.`,
    `    let path = this.pathFor(name);
    if (this.builtinDir) {
      const shipped = join(this.builtinDir, \`\${name}.json\`);
      try { await stat(shipped); path = shipped; } catch { /* not a shipped name */ }
    }
    // Captured here, on the same tick as the increment.`,
  ]] },
  // Marks are drawn at their source fraction rather than through the retime curve,
  // which is identical at rate 1 with no keys and wrong everywhere else.
  //
  // **It reaches the ruler strip, and that is the only site it could usefully reach.**
  // The rows below read `markTicks()`, which reads `#tMarks .tmk` - the strip `paintMarks`
  // fills - so the minimap's copy of this same conversion has no assertion over it and a
  // mutation landing there would redden nothing while looking identical from outside.
  //
  // Re-anchored: the conversion was copied to the minimap, so the bare line matched twice
  // and `mutatedSource` threw at module top level - a stack trace, exit 1 and no assertion
  // count at all, which is the failure shape that reads as a catch. It now carries the
  // following line, because the two sites differ only in indentation and the four-space
  // form is a substring of the six-space one. Two sites doing one conversion is the reason
  // this went stale; see `docs/instruments.md`.
  // **Disambiguated by the newline and the indent rather than by the line after it.**
  // The mini-map builds its own ticks from the identical expression, so the bare line
  // matches twice - and the pairing that separated them, `createElement('span')` on the
  // next line, stopped separating anything the moment the ruler's tick became a button
  // with a paragraph of comment between the two. An anchor that leans on its neighbour
  // is an anchor that goes stale when the neighbour is edited for an unrelated reason.
  // A leading `\n` plus four spaces cannot match the six-space line inside the
  // `miniMarks` map, so this is a property of the line itself.
  'marks-ignore-retime': { file: 'web/main.js', edits: [[
    '\n    const program = retime.programSecAt(mark.sourceMs / 1000);\n',
    '\n    const program = mark.sourceMs / 1000;\n',
  ]] },
  // The gallery skims a remote take at full resolution, promising a smoothness the
  // link does not have.
  // ---- the mutating routes, one term per mutation, so a failing row says which
  // term broke rather than that something did.
  //
  // A route reaches its handler only by being an entry in the table, and an entry
  // reaches a handler that changes something only through `requireMutation`. The two
  // guard mutations take the origin and content-type terms out one at a time.
  //
  // **The method one cannot be narrowed and its rows are not one per term, so it is
  // said here rather than left to read as if it were.** Letting a GET reach the write
  // branch on its own moves nothing: `requireMutation` is still in the path and still
  // answers 405 to a GET, so the page under test is unchanged and a mutation that
  // does nothing reads as a check that found nothing. The second edit is therefore
  // load-bearing, and it removes the gate rather than the method term - so this one
  // trips all three guard rows. The catch is real and the extra coverage is welcome;
  // what would be wrong is a comment claiming a diagnosis this mutation does not give.
  'writes-take-any-method': { file: 'server/index.js', edits: [
    ['    if (!reading && r.write) {', '    if (r.write) {'],
    ['      if (!requireMutation(req, res, r.write.methods)) return true;',
      '      /* mutation: whatever method arrived is fine */'],
  ] },
  'origin-unchecked': { file: 'server/http-guard.js', edits: [[
    'export function originAllowed(req) {\n  const origin = req.headers.origin;',
    'export function originAllowed(req) {\n  return true; /* mutation: any page may act on this server */\n  const origin = req.headers.origin;',
  ]] },
  'content-type-unchecked': { file: 'server/http-guard.js', edits: [[
    "const JSON_TYPE = /^application\\/json\\s*(?:;|$)/i;",
    'const JSON_TYPE = /^/; /* mutation: anything a no-cors fetch can send is fine */',
  ]] },
  // **The control for the enumeration itself: a mutating handler *added* in a `read`
  // slot.** This is the shape the rule names, and it is a different shape from
  // moving one - the sweep used to rest on a hardcoded floor,
  // `mutating.length >= 10 && writeOnly.length >= 7`, which moving a route trips
  // because the counts fall and which adding one cannot trip at all. Planted against
  // that build, this route went through the whole suite at 241 of 241, exit 0, with
  // `planted-by-a-read-route.json` on disk afterwards.
  //
  // It writes a *project*, deliberately, because that is the store the old sweep did
  // not watch: the shooting server was spawned with no `--projects`, so the document
  // stores lived outside the one directory being snapshotted. What catches it now is
  // the snapshot of all five stores taken across a drive of every read route.
  'read-route-writes': { file: 'server/index.js', edits: [[
    "  { path: '/library/routes', pattern: /^\\/library\\/routes$/, read: serveRoutes },",
    "  { path: '/library/routes', pattern: /^\\/library\\/routes$/, read: serveRoutes },\n"
    + "  { path: '/library/sweep-probe', pattern: /^\\/library\\/sweep-probe$/, read: (req, res) => {\n"
    + "    PROJECTS.write('planted-by-a-read-route', { planted: true })\n"
    + '      .then(() => sendJson(res, { planted: true }), (err) => sendJson(res, { error: err.message }, 500));\n'
    + '  } },',
  ]] },
  // **The plant a contents comparison cannot see, and the reason the write count is a
  // row of its own.** A read route that writes a document and removes it again inside
  // the same request. Both readings the sweep takes are outside the request, and what
  // they compare - the names, sizes and modification times of the files that are there
  // - is byte-for-byte what it was, because the file this wrote is gone by the time the
  // second reading happens and nothing that survived was touched. Only the monotonic
  // count moves, by two.
  //
  // Written this way after the obvious version was measured and found dishonest. That
  // one overwrote the seeded document and restored its timestamp with `utimesSync`, and
  // it failed *both* rows - because APFS keeps modification times to the nanosecond,
  // `utimesSync` takes a `Date` that keeps milliseconds, and the snapshot caught the
  // 0.13ms the restore could not put back. That is the filesystem's timestamp
  // resolution catching it rather than the sweep's design, and on a filesystem with
  // coarser stamps the same plant walks through - so a control resting on it would have
  // been asserting the platform. Write-then-remove needs no timestamp restored at all.
  'read-route-restores': { file: 'server/index.js', edits: [[
    "  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },",
    "  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },\n"
    + "  { path: '/library/sweep-probe', pattern: /^\\/library\\/sweep-probe$/, read: async (req, res) => {\n"
    + "    await PROJECTS.write('planted-then-removed', { version: PROJECT_VERSION, look: { params: {}, tracks: {} }, composition: { retime: { rate: 1, keys: [] }, camera: [] }, outputSize: '1920x1080', appliedPreset: null });\n"
    + "    await PROJECTS.remove('planted-then-removed');\n"
    + '    sendJson(res, { restored: true });\n'
    + '  } },',
  ]] },
  // **The plant that destroys the shoot.** A read route appending to the file the
  // recorder has open - the one place where three of this sweep's observations are
  // switched off at once, since the open take's size and modification time are out of
  // the snapshot by name, no write counter covers the captures directory, and the
  // recorder's state field does not move for a foreign append. Against the build
  // before this, it passed 251 assertions at exit 0 while ruining the take.
  //
  // Written through the recorder's own stream rather than appended through a second
  // descriptor. The old plant used `appendFileSync`, and the next recorder frame
  // wrote from the first descriptor's older offset and erased the plant before close
  // — so the mutation healed itself and passed 256 assertions. Through this stream
  // the foreign bytes stay ordered between two real frames. 0x07 rather than
  // anything structured makes the damage a desync the scan names rather than a
  // plausible frame, and 64KB makes it unambiguously more than in-flight noise.
  'plant-open-take': { file: 'server/index.js', edits: [
    ["  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },",
      "  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },\n"
      + "  { path: '/library/sweep-probe', pattern: /^\\/library\\/sweep-probe$/, read: (req, res) => {\n"
      + '    recorder.take.stream.write(Buffer.alloc(65536, 0x07));\n'
      + '    sendJson(res, { appended: true });\n'
      + '  } },'],
  ] },
  // The other half of the captures directory, and the reason it is a mutation rather
  // than a sentence: the open take is excluded from the snapshot *by name*, so every
  // other file in there should still be covered - and "should" is what this repo
  // measures. A read route unlinking a take that is not the one being recorded.
  'plant-unlink-closed-take': { file: 'server/index.js', edits: [
    ["import { createReadStream, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';",
      "import { createReadStream, mkdirSync, readdirSync, realpathSync, statSync, unlinkSync } from 'node:fs';"],
    ["  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },",
      "  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },\n"
      + "  { path: '/library/sweep-probe', pattern: /^\\/library\\/sweep-probe$/, read: (req, res) => {\n"
      + "    const victim = readdirSync(CAPTURES_DIR).find((f) => f.endsWith('.knct')\n"
      + '      && join(CAPTURES_DIR, f) !== recorder.openPath);\n'
      + '    if (victim) unlinkSync(join(CAPTURES_DIR, victim));\n'
      + '    sendJson(res, { removed: victim ?? null });\n'
      + '  } },'],
  ] },
  // A mutating handler *moved* behind a `read`. Kept beside the plant above rather
  // than described as the control, which it is not: what catches this one is the
  // recorder having moved, since a `GET /record/stop` ends the take.
  // The control for the namespace seam. It puts the derived set back to a written
  // list, one name short - which is exactly the state the dispatcher was in before
  // step 8, and exactly the state it would return to the next time somebody added
  // a namespace to a literal instead of to the table.
  //
  // `presets` is dropped rather than a name invented, so the mutation is testable
  // against today's tree rather than only once `jobs` exists. What must fail is the
  // shadowing row: with `presets` unowned, the file planted at web/presets/ is
  // served off disk with a 200 where the route table should have answered 404.
  // The health route answers from a branch ahead of the dispatcher instead of from a
  // `ROUTES` entry - which is exactly the shape no route sweep can see. The handler
  // still works and still touches nothing, so the read sweep's resource rows have
  // nothing to say about it; what goes is `/library/routes` publishing it, and with
  // that the enumeration that drives every route by existing.
  //
  // This is the general failure the table was built to end, aimed at the newest entry:
  // a branch beside the dispatch is a route that is real to a browser and invisible to
  // every check that walks the published list.
  'health-answers-beside-the-table': {
    file: 'server/index.js',
    edits: [
      ["  { path: '/sensor/health', pattern: /^\\/sensor\\/health$/, read: serveSensorHealth },\n", ''],
      [
        '  // The table first, the file tree second. `serveRoute` answers false only for a',
        '  if (urlPath === \'/sensor/health\') { serveSensorHealth(req, res); return; }\n\n'
        + '  // The table first, the file tree second. `serveRoute` answers false only for a',
      ],
    ],
  },

  // The health window's reset goes back below the early return, so a five-second window
  // that carried no frames is never closed and `stats.since` keeps its value across the
  // gap. The next window after a sixty-second USB drop is then measured over sixty-five
  // seconds - roughly a thirteenth of the true rate, into the log and into
  // `observedBytesPerSec`, which the remaining-time readout divides free space by.
  //
  // Must redden: the row reading the window length back off `/sensor/health` on a
  // server with no sensor, which reports about 5000ms closed and the server's whole
  // uptime open. The steady-delivery row stays green, because delivery never takes the
  // early return and a control that reddened it would be measuring a different fault.
  'empty-window-keeps-its-start': {
    file: 'server/index.js',
    edits: [
      [
        '  const closed = { ms: Date.now() - stats.since, frames: stats.frames, dropped: stats.dropped, bytes: stats.bytes };\n'
        + '  Object.assign(stats, { frames: 0, dropped: 0, bytes: 0, since: Date.now() });\n',
        '  const closed = { ms: Date.now() - stats.since, frames: stats.frames, dropped: stats.dropped, bytes: stats.bytes };\n',
      ],
      [
        '  console.log(`[server] ${fps} fps  ${mbs} MB/s  dropped=${closed.dropped}  clients=${wss.clients.size}`);\n}, 5000);',
        '  console.log(`[server] ${fps} fps  ${mbs} MB/s  dropped=${closed.dropped}  clients=${wss.clients.size}`);\n'
        + '  Object.assign(stats, { frames: 0, dropped: 0, bytes: 0, since: Date.now() });\n}, 5000);',
      ],
    ],
  },

  // The gallery's poll loses its change gate, so every tick calls `refresh()`. This is
  // the fault the gate exists to prevent rather than a way of switching the poll off:
  // the fetch still happens on the cadence, and `paint()` now closes every menu,
  // releases every skim and replaces every tile five seconds apart for as long as the
  // page is open.
  //
  // Must redden: the row asserting a tick that changed nothing leaves the tiles it
  // found. The row asserting a tick that *did* change the recording flag repaints has
  // to stay green, or the control is only proving the poll stopped running.
  'poll-refreshes-every-tick': { file: 'web/library.js', edits: [[
    '  if (!changed) return;\n', '',
  ]] },

  // The gallery's poll goes back to watching only the recorder on the machine serving
  // the page. On a station with a `--node` that recorder never moves - the sensor is on
  // the node - so the tick's answer is constant for the life of the page while the grid
  // it gates is drawn from both libraries, and a take finished on the node goes on
  // refusing Open until somebody reloads.
  //
  // The route's field and not the gallery's gate, because those are two different
  // claims and `poll-refreshes-every-tick` already takes the gate. Must redden section
  // 14's linked-topology rows and leave the direct-gallery rows above them green: the
  // failure is specific to the machine whose recorder is somewhere else, which is the
  // whole reason it survived a section that served the gallery from the recorder.
  'pulse-ignores-the-node': { file: 'server/index.js', edits: [[
    '    node: node ? await node.recordState() : null,\n', '',
  ]] },

  // Every start of a grabber counts as a respawn again, including the one a colour
  // toggle asks for - so a node an operator reconfigured twice reads as a node whose
  // sensor dropped twice, and the endpoint's own claim that a healthy node reads zero
  // stops being true of any node anybody has touched.
  //
  // The increment and not the subtraction, so `restarts` goes to zero in the same
  // breath as `respawns` goes to one: both halves of the reading are wrong, and a
  // mutation that only moved the total would leave the second number right by accident.
  'respawns-count-a-colour-toggle': { file: 'server/index.js', edits: [[
    'grabberRestarts++; ', '',
  ]] },

  // The requested restart is counted where it is learned rather than beside the spawn it
  // excuses, which is where it used to be. `respawns` is `grabberSpawns - 1 -
  // grabberRestarts`, so a restart counted on the exit runs the subtraction one ahead of
  // itself for the whole backoff - a quarter of a second after a clean stop, a second and
  // a half after a hard one - and a node that had genuinely lost its sensor reads one
  // respawn, then zero, then one again.
  //
  // Must redden only the monotonicity row. The totals this section already asserts are
  // right on both builds, because the reading is correct at both ends of the gap and
  // wrong only inside it: a control that moved the totals would be a different defect.
  'respawns-dip-before-the-spawn': { file: 'server/index.js', edits: [[
    'setTimeout(() => { grabberRestarts++; spawnGrabber(); }, delay);',
    'grabberRestarts++;\n        setTimeout(spawnGrabber, delay);',
  ]] },

  // `openPath` goes back to answering only for the take currently being written, so the
  // whole of a close - the flush, the marks, the index and the content hash - becomes
  // time in which this process says nobody owns a file it is still reading and writing.
  // `/library/all` calls that take finalised and the gallery offers Download, Rename and
  // Remove on a take with no hash yet.
  //
  // The getter rather than the field, because `finalizing` has a second reader in
  // `writingId`: clearing the field would move both, and a run could not then say which
  // of the two the gallery was actually following. Must redden section 14's finalisation
  // rows and leave the rows above them - the ones about a take that is genuinely still
  // recording - green.
  'openpath-drops-at-the-stop': { file: 'server/recorder.js', edits: [[
    'return this.take?.path ?? this.finalizing?.path ?? null;',
    'return this.take?.path ?? null;',
  ]] },

  // The gallery's poll goes back to a first tick that cannot disagree with anything. The
  // page reads `/library/all`, paints from it, and only then asks the recorder - so a
  // take that stops inside that gap is stopped in the first fingerprint and in every one
  // after it, none of them differ, and the tile goes on refusing to open a finished take
  // until somebody reloads.
  //
  // Must redden the row that stops a take with the first `/record/state` held, and leave
  // every other row in section 14 green: an unseeded poll is still a working poll for
  // every transition that happens after it has an observation to compare against, which
  // is why this survived a section built out of those.
  'poll-first-tick-is-blind': { file: 'web/library.js', edits: [[
    '}, believedFromLibrary());', '});',
  ]] },

  // The poll goes back to recording a tick as seen before the caller has managed to do
  // anything with it. One refresh losing its connection then advances the fingerprint
  // past the transition it failed on, every later tick matches, and the grid keeps a
  // finished take's actions disabled until some other transition happens along - the
  // same permanent staleness `poll-first-tick-is-blind` covers at the other end of the
  // page's life, reached by a different road.
  //
  // The module and not the gallery's `throw`, because those are two halves of one
  // arrangement and this is the half that decides. Must redden only the retry row.
  // The poll goes back to starting a tick whether or not the last one has finished. On
  // its own that is harmless; beside the retry it is not, because a handler that never
  // returns leaves `previous` where it was and every later tick then reports the same
  // change and starts another `/library/all` - which on a station with a `--node` is a
  // request and a connection to the other machine every five seconds, for as long as
  // the page is open.
  //
  // Must redden only the overlap row. The retry rows have to stay green, or the control
  // is proving that the guard broke the retry rather than that it bounded it.
  // The gallery's listing loses its bound, so a node that accepts a connection and never
  // answers hangs it - and single-flight then skips every later tick for as long as it
  // hangs. The pile-up guard and the timeout are two halves of one arrangement: without
  // the bound, the guard turns one dead listing into a gallery that has stopped.
  'listing-never-times-out': { file: 'web/library.js', edits: [[
    'signal: bound ? AbortSignal.timeout(LISTING_TIMEOUT_MS) : undefined,',
    'signal: undefined,',
  ]] },

  // The bound goes back onto the first listing, where a cold library is slow for a
  // legitimate reason and fifteen seconds is not enough to build 200 indexes.
  'first-load-bounded': { file: 'web/library.js', edits: [[
    'try {\n  await refresh();\n} catch (err) {\n  say(`the library could not be read',
    'try {\n  await refresh({ bound: true });\n} catch (err) {\n  say(`the library could not be read',
  ]] },

  // The first listing goes back to being unguarded, so anything it throws ends module
  // evaluation before the poll is started and before the page has a hook to drive.
  'first-load-strands-the-page': { file: 'web/library.js', edits: [[
    'try {\n  await refresh();\n} catch (err) {\n'
    + '  say(`the library could not be read: ${err.message}`);\n  paint();\n}',
    'await refresh();',
  ]] },

  // The listing goes back to being believed whatever the server said about it, which is
  // where it was until a JSON refusal was found walking straight past the catch above.
  // `res.json()` resolves on a 500 carrying `{ error }`, so `library` becomes an object
  // with no `takes` and no `storage`, `paint()` throws reading `library.storage.label`,
  // and the throw lands inside the catch that was supposed to recover from it.
  //
  // **Must redden all four rows of the first-load class, both arms, and that is not what
  // this comment predicted.** The guess was that the non-JSON arm would stay green, on
  // the reasoning that `res.json()` throws on a body that will not parse and so never
  // reaches the assignment. It does not any more: the parse failure is caught into
  // `null` beside the refusal now, so both doors arrive at the same check and removing
  // it strands the page through either. Written down rather than quietly narrowed,
  // because the run said something better than the prediction did - before the fix only
  // one of the two doors was shut, and it was shut by accident, by a `SyntaxError`
  // nobody chose escaping from `res.json()` with a message that named nothing.
  //
  // So this is not a revert to the build that shipped, and calling it one would be the
  // more useful-sounding claim: that build strands on a refusal that parses and survives
  // one that does not. What the mutation stages is the guard's absence, which is the
  // thing under test.
  'listing-takes-a-refusal-as-a-library': { file: 'web/library.js', edits: [[
    '  if (!res.ok || !Array.isArray(body?.takes)) {\n'
    + '    throw new Error(body?.error ?? `the library could not be listed: HTTP ${res.status}`);\n'
    + '  }\n  library = body;',
    '  library = body;',
  ]] },

  // The cancellation goes back to watching the request rather than the response. Every
  // call site still passes a signal and the source sweep still reads clean - which is
  // exactly what shipped - but on the two routes that await `readBody(req)` first the
  // request has already ended, so a listener attached afterwards can never fire.
  //
  // `res.req` rather than reordering the call sites, because the defect being staged is
  // *which object is watched* and reaching the request through the response leaves the
  // signature and all four callers untouched. Must redden the removal arm and leave the
  // listing arm green: the listing reads no body, so it worked on both builds and is
  // what makes this a control for the ordering rather than for cancellation at large.
  'cancel-watches-the-consumed-request': { file: 'server/index.js', edits: [[
    "  res.on('close', () => ctl.abort());",
    "  res.req.on('close', () => ctl.abort());",
  ]] },

  // The listing route stops telling the node that its caller has gone, so a browser that
  // gave up leaves the outbound fetch running here.
  'listing-ignores-client-abort': { file: 'server/index.js', edits: [[
    'await node.takes(untilCallerLeaves(res)) : null;\n  const takes = reconcile(',
    'await node.takes() : null;\n  const takes = reconcile(',
  ]] },

  // Delete goes back to being offered while the node is unreachable, where the copy count
  // it rests on came from a manifest read that failed rather than from a node with
  // nothing on it.
  'delete-guesses-past-an-unreachable-node': { file: 'web/library.js', edits: [[
    '  if (library.node && !library.node.reachable) {\n'
    + '    return `${library.node.name} cannot be reached, so whether this take has a second copy `\n'
    + "      + 'is unknown - delete is refused rather than guessed at';\n  }\n",
    '',
  ]] },

  'poll-ticks-overlap': { file: 'web/record-poll.js', edits: [[
    '  const tick = () => {\n'
    + '    if (running) {\n'
    + '      if (!rerun) rerun = running.then(() => { rerun = null; return tick(); });\n'
    + '      return rerun;\n    }\n'
    + '    running = run().finally(() => { running = null; });\n'
    + '    return running;\n  };\n'
    + '  const onCadence = () => { if (!running) tick(); };',
    '  const tick = () => run();\n  const onCadence = () => { tick(); };',
  ]] },

  // A caller asking during a tick gets the tick already in flight instead of a rerun -
  // which is the round-4 guard before it learned the difference between the two ways
  // in. The record button awaits this to repaint from the state its own POST produced,
  // and the in-flight request snapshotted `recorder.state` before the press, so the
  // surface paints the world as it was and the next click can choose start where it
  // meant stop.
  //
  // The returned promise and not the guard, because the guard is right: the cadence
  // must go on skipping. Must redden only the row counting the button's own read.
  'post-action-poll-discarded': { file: 'web/record-poll.js', edits: [[
    '      if (!rerun) rerun = running.then(() => { rerun = null; return tick(); });\n'
    + '      return rerun;',
    '      return running;',
  ]] },

  'poll-forgets-a-failed-refresh': { file: 'web/record-poll.js', edits: [[
    '    try {\n      await saw(state, changed);\n      previous = mark;\n'
    + '    } catch { /* not seen, so not recorded as seen - the next tick offers it again */ }',
    '    previous = mark;\n    saw(state, changed);',
  ]] },

  // One page's `--faint` goes back to the value that fails AA, which is the drift three
  // separate declarations of one token invite. Deliberately one page and not all three:
  // the rows are per page, so the run says *which* surface regressed rather than that
  // some surface did, and the two pages left alone are what makes that reading possible.
  'faint-fixed-in-one-page': { file: 'web/library.html', edits: [[
    '    --faint: #828c99;', '    --faint: #6d7683;',
  ]] },

  'namespaces-hardcoded': { file: 'server/index.js', edits: [[
    'export const OWNED_NAMESPACES = new Set(ROUTES.map((r) => {',
    // Two parens are open at the anchor (`new Set(` and `ROUTES.map(`), so the
    // replacement leaves two open too or the file does not parse - and a mutation
    // that fails to parse is a server that never starts, which this suite would
    // report as a catch without ever having run the check.
    "export const OWNED_NAMESPACES = new Set(['capture', 'library', 'projects', 'record']);\n"
    + 'const _unusedNamespaceDerivation = new Set([].map((r) => {',
  ]] },
  'stop-route-reads': { file: 'server/index.js', edits: [[
    "  { path: '/record/stop', pattern: /^\\/record\\/stop$/, write: { methods: ['POST'], run: serveRecordStop } },",
    "  { path: '/record/stop', pattern: /^\\/record\\/stop$/, read: serveRecordStop },",
  ]] },
  // **The rebuild that arrow-browsing causes stops moving focus to the replacement.**
  // The viewer's header button is cloned and swapped on every rebuild, so this removes
  // the node holding focus and leaves the caret on the body: the second arrow then
  // reaches nothing and browsing stops after exactly one take, with every pixel on
  // screen still correct. What must go red is the two-presses row, not the focus row -
  // the focus row alone would be an assertion about where a caret is, and this file's
  // rule is to read the consequence.
  'viewer-drops-focus-on-rebuild': { file: 'web/library.js', edits: [[
    `  if (focusWas) {
    const same = findControl(viewer, focusWas);
    (same && !same.disabled ? same : freshMore).focus();
  }`,
    '  void focusWas;',
  ]] },
  // **Hiding a menu stops putting focus back on the button that opened it.** Hiding an
  // ancestor of the focused element drops focus to the body, which inside the viewer
  // means outside the dialog - so choosing an item by keyboard ends with the arrows
  // dead. This lived at one caller before it was a rule; the mutation takes the rule
  // out, which is the only place it now exists.
  'menu-close-strands-focus': { file: 'web/library.js', edits: [[
    '    if (heldFocus && toggle && !toggle.disabled) toggle.focus();',
    '    void heldFocus;',
  ]] },
  // **`run` stops putting focus back after the action it held the surface down for.**
  // Disabling the focused control blurs it, so this is the half `openViewer` cannot
  // cover - it reads the focus that is live, and by then there is none. Removing it
  // strands focus on the body after any action pressed from the keyboard.
  'run-strands-focus': { file: 'web/library.js', edits: [[
    `    const back = findControl(host, wanted)
      ?? (host?.isConnected ? host.querySelector('[aria-haspopup="menu"]') : null);`,
    '    const back = null;',
  ]] },
  // **The viewer goes back to deciding for itself, and gets one rule wrong.** This is
  // the shape that shipped four times: the viewer's action row computed from something
  // slightly different from the tile's, which is invisible on the takes the two happen
  // to agree about and wrong on exactly the take in the state nobody drove.
  //
  // The rule it drops is the first of the four the review caught: the viewer believing
  // a take is here when it is only on the node. That surface then offers Open and a live
  // Delete on footage this machine does not have, with the confirm in front of Delete
  // reading "This is the only copy" - the most alarming sentence the page can show, on a
  // button that was never going to do anything.
  //
  // **Told as a lie about the take rather than as a second copy of the rule**, because
  // what has to be falsified is that the two surfaces cannot diverge, and re-deriving
  // the old duplicated block would test whether I retyped it faithfully.
  //
  // Aimed at the viewer's call and not at `availability`: a rule broken inside
  // `availability` breaks it for both surfaces, which leaves them agreeing. That is a
  // real bug and a different one, and it is what the per-take rows above already cover.
  //
  // `state` rather than `recording`, because the mutation has to move something in the
  // fixture this row actually walks. There is no take mid-shoot in the grid at that
  // point - the recorder rows run on their own server - so telling the viewer nothing is
  // recording changes nothing, and the row would have stayed green against a build with
  // the surfaces genuinely split. There is a node-only take, so this one moves.
  'viewer-decides-for-itself': { file: 'web/library.js', edits: [[
    '  paintActs(acts, take, hostOf);',
    "  paintActs(acts, { ...take, state: 'local' }, hostOf);",
  ]] },
  // Marks for a take that is not here, which created its sidecar in the captures
  // directory out of a caller's own JSON.
  //
  // **Two edits now, because there are two things enforcing this and removing one
  // leaves the other refusing.** The route grew a second check when marks were made to
  // survive a rename: it takes the capture's inode before awaiting the body and
  // compares it after, so a take that vanished - or was replaced by a different take
  // renamed into the freed id - is refused. That check also happens to cover the take
  // that was never there at all, since `sameTake(null, null)` is false.
  //
  // Removing only the 404 branch therefore does not produce the shape this mutation is
  // named for. It produces a 409 and no sidecar, and the row would still go red -
  // purely because its message no longer matches `nothing to mark|no take`. That is a
  // catch on the wording of an error rather than on the behaviour, which is the kind of
  // green-for-the-wrong-reason this file exists to refuse. Both gates come out, so what
  // is under test is the claim - a take that is not here gets no marks - against a
  // build with nothing left to enforce it. Both rows then fail: the refusal is gone and
  // `nosuchtake.marks.jsonl` is on disk.
  //
  // `const wasThere` stays, or the identity check below it is a ReferenceError and the
  // route crashes - which reads as a catch while proving only that a mutation broke the
  // build.
  'marks-without-a-take': { file: 'server/index.js', edits: [
    ['  const wasThere = takeIdentity(path);\n  if (wasThere === null) {\n    sendJson(res, { error: `no take ${id} here, so there is nothing to mark` }, 404);\n    return;\n  }',
      '  const wasThere = takeIdentity(path);'],
    ['  if (!sameTake(wasThere, takeIdentity(path))) {', '  if (false) {'],
  ] },
  // The document store restamps the version instead of checking it, so a project
  // from a build this one is not lands looking like one this build wrote.
  'store-restamps-version': { file: 'server/library.js', edits: [[
    '    if (body?.version !== undefined && body.version !== this.version) {',
    '    if (false) {',
  ]] },
  // A replay server records. The frames come off a file on a loop, so their stamps
  // repeat, and one take is one continuous stream with monotonic stamps.
  'replay-can-record': { file: 'server/index.js', edits: [[
    '  cannotRecord: () => (REPLAY\n    ?', '  cannotRecord: () => (false\n    ?',
  ]] },
  // The demonstrated failure, whole: recording a replay is allowed *and* the replay
  // hands `handleMessage` a payload with no framing. One open take then turns every
  // frame into a throw that lands in the replay tick's catch - no frame reaches any
  // client, the status flaps between lost and live, and `/record/state` reports a
  // healthy recording throughout.
  //
  // Both edits in one mutation on purpose. Removing the framing on its own moves
  // nothing, because the refusal above means `recorder.write` is never reached - a
  // mutation that does nothing, wearing the appearance of one that does, which is
  // the shape this repo has been caught by before. What the pair proves is that the
  // framing is load-bearing rather than decorative: with the door open, it is the
  // only thing between the replay loop and a throw per frame.
  'replay-records-a-bare-payload': { file: 'server/index.js', edits: [
    ['  cannotRecord: () => (REPLAY\n    ?', '  cannotRecord: () => (false\n    ?'],
    ['        handleMessage({ type: TYPE_FRAME, payload, raw: encodeMessage(TYPE_FRAME, payload) });',
      '        handleMessage({ type: TYPE_FRAME, payload });'],
  ] },
  // `forgetCapture` drops the map entry and leaves the descriptor to the collector,
  // which on this Node is a process death rather than an untidy count.
  'forget-leaks-descriptor': { file: 'server/capture.js', edits: [
    ['  pending?.then((capture) => {\n    capture.doomed = true;\n    if (capture.leases === 0) capture.close().catch(() => {});\n  }, () => {});',
      '  pending?.then((capture) => { if (capture.leases === 0) capture.close().catch(() => {}); }, () => {});'],
    ['    if (capture.doomed && capture.leases === 0) await capture.close().catch(() => {});',
      '    /* mutation: the last lease lets go and nothing closes anything */'],
  ] },
  // A take that dies mid-write drops the marks pressed during it.
  'mid-write-drops-marks': { file: 'server/recorder.js', edits: [[
    '        flushMarks(failed);', '        /* mutation: the marks go nowhere */',
  ]] },
  // The flush moves out of the `finally`, so a close that rejects loses them - the
  // second way the same orphaning arrived.
  // **This replaced `close-flush-outside-finally`, which had become vacuous rather
  // than merely misaimed.** That mutation moved the flush out of a `finally`, and the
  // `finally` no longer exists: closing a take now catches the stream error, records
  // it, closes the take out, and raises afterwards. Control reaches the flush either
  // way, so re-anchoring the old text would have bought a green row testing nothing -
  // which is worse than a refusal, because a refusal is at least loud.
  //
  // What is worth breaking now is the recovery itself. Throwing where the error is
  // recorded puts the code back to rejecting straight out of `close`, past the index,
  // the hash and the broadcast, which is the bug defect 4 was about: a take left with
  // no sidecar and no content hash while every monitor shows a recording that ended.
  'close-rethrows-before-indexing': { file: 'server/recorder.js', edits: [[
    '      console.error(`[recorder] take ${take.id}: the file did not close cleanly (${err.message}) - indexing what landed`);',
    '      throw err;',
  ]] },
  // The write stream's backpressure is discarded again, so a stalling card becomes
  // heap that grows until the process is killed.
  'recorder-ignores-backpressure': { file: 'server/recorder.js', edits: [[
    '    if (take.stream.writableLength > MAX_TAKE_BUFFER) {', '    if (false) {',
  ]] },
  // The counters go back to reporting what was accepted rather than what drained, so
  // the monitor reads healthy for exactly as long as the failure is invisible.
  'recorder-counts-accepted': { file: 'server/recorder.js', edits: [[
    '  const written = take.stream.bytesWritten;', '  const written = take.accepted;',
  ]] },
  // The in-flight queue is drained only when something asks for state, which is the
  // shape the previous round shipped: nothing removes an entry until an operator
  // opens the monitor, so the queue is bounded by the length of the take and the
  // drain that finally runs is quadratic in it. The stall is synchronous, so the
  // grabber sees backpressure and drops depth packets at the device.
  'settle-drains-on-poll-only': { file: 'server/recorder.js', edits: [[
    `    // Drained on the frame path rather than only when something asks for state, and
    // that placement is what makes the queue bounded by the ceiling below instead of
    // by the length of the take. \`settle\` carries the measurement and the mechanism.
    settle(take);`,
    '    /* mutation: the queue is drained only when something asks for state */',
  ]] },
  // The head advances and the array is never compacted, which leaves the depth
  // correct and the allocation growing with the take - and puts every operation over
  // that array back to scaling with the take's length.
  'settle-never-compacts': { file: 'server/recorder.js', edits: [[
    `  if (take.inFlightHead > 0 && take.inFlightHead * 2 >= take.inFlight.length) {
    take.inFlight.splice(0, take.inFlightHead);
    take.inFlightHead = 0;
  }`,
    '  /* mutation: the head moves and the array is never compacted */',
  ]] },
  // The transition into dropping goes back to being silent, so the only thing
  // carrying it is the panel's five-second poll - and after the queue drains on
  // every write, no monitor has to be open for the drop to happen at all.
  'drop-transition-silent': { file: 'server/recorder.js', edits: [[
    `        // stays green costs the take.
        this.onChange(this.state);`,
    '        /* mutation: the drop is left to the five-second poll */',
  ]] },
  // The push moves out from behind the transition flag and fires per dropped frame,
  // which is a socket write in the frame path on the one machine that cannot afford
  // one. Without this the "pushed once" row would only ever be exercised by the
  // mutation above, which fires it zero times.
  'drop-transition-per-frame': { file: 'server/recorder.js', edits: [[
    `      take.dropped++;
      if (!take.stalling) {`,
    `      take.dropped++;
      this.onChange(this.state);
      if (!take.stalling) {`,
  ]] },
  // The buffer ceiling shrinks to an eighth. Every row that reads the ceiling out of
  // the build still passes - which is the point - and the take now survives about
  // half a second of a stalled card rather than four and a half.
  'ceiling-too-small': { file: 'server/recorder.js', edits: [[
    'export const MAX_TAKE_BUFFER = 64 * 1024 * 1024;',
    'export const MAX_TAKE_BUFFER = 8 * 1024 * 1024;',
  ]] },
  // The manifest scans the take being written, which is a full read and a sha256 of
  // a growing multi-gigabyte file per request, against the recorder's own disk.
  // Anchored on the branch's condition alone. It used to carry the `return {` two lines
  // down with it, which put the refusal list between them the moment that was hoisted -
  // and `syntax-check` refused the control rather than letting it silently match nothing.
  'manifest-scans-open-take': { file: 'server/library.js', edits: [[
    '  if (recording) {\n', '  if (false) {\n',
  ]] },
  // The boot stops making the captures directory, which is the state a reflashed
  // node comes up in.
  'boot-without-captures-dir': { file: 'server/index.js', edits: [[
    '  mkdirSync(CAPTURES_DIR, { recursive: true });',
    '  /* mutation: the captures directory is assumed */',
  ]] },
  // Delete goes back to trusting the sidecar where reclaim re-hashes, so the
  // irreversible action carries the weaker check.
  'delete-trusts-sidecar': { file: 'server/library.js', edits: [[
    '  const actual = await hashFile(path);', '  const actual = (await cachedIndex(path)).hash;',
  ]] },
  // The decimation path stops checking that a frame's two declared lengths describe
  // the frame, so an overstated colour length returns the uninitialised tail of an
  // `allocUnsafe` buffer.
  // Re-anchored with `decimate-drops-colour` above, and for the same reason.
  'decimate-skips-length-check': { file: 'server/capture.js', edits: [[
    '  if (16 + depthBytes + colorBytes !== payload.length) {', '  if (false) {',
  ]] },
  // The registry's door goes back to testing truthiness on an object literal, which
  // accepts every name on `Object.prototype`.
  'registry-gate-by-truthiness': { file: 'web/main.js', edits: [[
    '  if (!Object.hasOwn(PARAMS, name)) throw new Error(`unknown parameter ${JSON.stringify(name)}`);',
    '  if (!PARAMS[name]) throw new Error(`unknown parameter ${JSON.stringify(name)}`);',
  ]] },
  // The delete confirm promises to remove a copy the server refuses to remove.
  'confirm-promises-both-delete': { file: 'web/library.js', edits: [[
    "  const alsoOnNode = take.state === 'both';", '  const alsoOnNode = false;',
  ]] },
  // The listing goes back to reading every failure as an absent directory, which is
  // how a user library the process cannot enumerate answers 200 carrying only the
  // looks that ship - the same page a fresh install draws.
  'list-swallows-unreadable': { file: 'server/library.js', edits: [[
    "    if (required || err?.code !== 'ENOENT') {", '    if (required) {',
  ]] },
  // The editor goes back to swallowing a library that will not load, which is the
  // empty picker an operator gets told nothing about.
  //
  // Re-anchored when the same loop started keeping each list rather than discarding
  // it - the resume offer reads the projects out of it. The mutated line still throws
  // the reason away, which is what this control is about, and still returns `null` for
  // the list, so the offer's own rows are not what goes red here.
  'open-take-swallows-library': { file: 'web/main.js', edits: [[
    '    listed[what] = await refresh().catch((err) => { unavailable.push(`${what} (${err.message})`); return null; });',
    '    listed[what] = await refresh().catch(() => null);',
  ]] },
  // Every version older than this build gets one sentence again, so a document with no
  // conversion path is told the thing that is true of a document from the future.
  'one-refusal-for-older-versions': { file: 'web/format.js', edits: [[
    '    : version === 1 || version === 2', '    : false',
  ]] },
  'skim-ignores-state': { file: 'web/library.js', edits: [[
    'const DIVISOR = { local: 1, both: 1, remote: 4 };',
    'const DIVISOR = { local: 1, both: 1, remote: 1 };',
  ]] },

  // ---- the tiles' geometry, one mutation per way a tile used to change size
  //
  // Both of these are the shipped bug put back rather than an invented one, and they
  // are two mutations rather than one because they moved different quantities: the
  // warnings moved a tile's *height* against its neighbours at every width, and the
  // poster's box moved its *ratio* only after a resize. A single mutation covering
  // both would leave a row unable to say which had broken.

  // The warnings go back under the poster as text, one row each - which is where they
  // were, and why `no-hello-take` stood 41.19px taller than a take with none at every
  // viewport width measured. The badges stay, so this moves the height and nothing
  // else: a mutation that also blanked the poster would redden rows about the picture
  // and the verdict would be about the mutation rather than about the check.
  'tile-height-follows-content': { file: 'web/library.js', edits: [[
    '  paintFlags(tile.querySelector(\'.flags\'), take);',
    `  paintFlags(tile.querySelector('.flags'), take);
  for (const w of warningsOf(take)) {
    const row = document.createElement('div');
    row.className = 'facts';
    row.style.height = 'auto';
    row.textContent = w.why;
    tile.querySelector('.meta').appendChild(row);
  }`,
  ]] },
  // The poster's height goes back into JavaScript, assigned once from the width it
  // measured on the first fit. Right at first paint and stale after every resize,
  // which is what a window dragged from 1512 to 700 measured at 2.496:1.
  //
  // **The `w > 0` guard is what makes this the shipped bug rather than a different
  // one, and the first version without it was worse than useless.** `fit` runs once
  // before the grid has laid the tile out, where the width is 0 - so the poster froze
  // at zero height, every ratio came back `Infinity`, the decimation row went red
  // because a canvas of no pixels has no picture to be sparser than, and the viewer
  // never drew a frame, which ended the run. That is a mutation whose rows say
  // "something broke" where the claim is about *which* quantity moved: the height was
  // right at first paint and drifted afterwards, and only the second half is the bug.
  'poster-height-in-js': { file: 'web/library.js', edits: [[
    `  const fit = () => {
    const r = surface.getBoundingClientRect();`,
    `  const fit = () => {
    if (!surface.dataset.frozen && surface.getBoundingClientRect().width > 0) {
      surface.dataset.frozen = '1';
      surface.style.aspectRatio = 'auto';
      surface.style.height = \`\${Math.round(surface.getBoundingClientRect().width * 9 / 16)}px\`;
    }
    const r = surface.getBoundingClientRect();`,
  ]] },
  // A depth sample goes back to covering exactly one pixel however large the canvas
  // is, which is what the viewer drew before it was looked at: the projection scales
  // with the height, so the samples spread and the same take that reads solid on its
  // tile came up a faint dot screen. Measured at this check's own viewport and device
  // pixel ratio: the stage falls to 0.28 of the tile's mean against 1.00, with the
  // *tile's* poster bit-identical either way, which is why this fails the ratio row
  // and leaves every other picture row alone.
  //
  // **It was NOT CAUGHT for one round and the reason is worth keeping**: the row's
  // threshold had been set from a measurement at devicePixelRatio 2, where the broken
  // build gives 0.07, and this runs at 1, where it gives 0.28 - one hundredth of a
  // margin above a 0.25 gate. The mutation was doing exactly what it claimed and the
  // check could not see it.
  'viewer-splat-one': { file: 'web/library.js', edits: [[
    '  const splat = Math.max(1, Math.round(scale / fxFull));',
    '  const splat = 1;',
  ]] },
  // The way out of the gallery goes away again, which is the state it shipped in: the
  // only exits were Open, which leaves for the editor, and a browser back button the
  // node's touch panel does not have.
  //
  // The application bar carries the same real anchor now. Removing that one line
  // leaves the status and filters working, so the mutation reddens the two navigation
  // rows without stopping the gallery before the rest of the suite can run.
  'gallery-has-no-way-back': { file: 'web/library.html', edits: [[
    '    <a class="appback" id="toMenu" href="/"><span class="arrow">&lt;</span><span aria-current="page">Gallery</span></a>',
    '    <!-- mutation: no way back -->',
  ]] },
  // **The falsification control for the enumeration**, and the only mutation here
  // that is not a bug being put back. A menu item nobody has taught this file to
  // drive has to be a failure rather than a control that quietly went unswept, or
  // "every control the gallery renders was tested" is a sentence this tool writes
  // about itself with nothing enforcing it. It is the shape `editor-check` already
  // needed for the same claim about the editor's controls.
  //
  // Planted **disabled**, and that is aim rather than timidity: `controls()` reads
  // every item the page renders whether or not it is pressable, so a disabled plant
  // exercises the enumeration exactly as well - and an enabled one also reddened "every
  // item in the menu is disabled while the take is recording", which is a true
  // statement about the plant and a neighbouring claim to the one under test.
  'plant-unswept-menu-item': { file: 'web/library.js', edits: [[
    "      item: 'reclaim',",
    `      item: 'planted',
      label: 'Planted item',
      enabled: false,
      why: 'planted by library-check',
      run: () => {},
    },
    {
      item: 'reclaim',`,
  ]] },

  // ---- rename, one mutation per thing the rename has to get right
  //
  // The hash gate and the marks are separate rows for the reason the grade terms are
  // in `export-check`: a cumulative row cannot say which term broke, and these two
  // fail differently - one lets a stale request through, the other loses what somebody
  // pressed in the room.
  'rename-ignores-hash': { file: 'server/library.js', edits: [[
    '  if (index.hash !== hash) {',
    '  if (false) {',
  ]] },
  // The marks log is left behind at the old name, where nothing lists it and nothing
  // will ever look for it again - the take arrives at its new name with no marks and
  // no error.
  'rename-orphans-marks': { file: 'server/library.js', edits: [[
    '  const marksMoved = await linkInto(marksPathFor(from), marksPathFor(target));',
    '  const marksMoved = false;',
  ]] },
  // The rename goes back to `rename(2)`, which replaces an existing file without a
  // word - so the collision check above it becomes check-then-act and two requests
  // aiming at one name both pass it. The sequential rows still pass, because the
  // reading is still true when it is acted on; the race row is the one that goes red.
  //
  // Two edits, and the second is not optional: `rename` has already moved the file, so
  // leaving the `unlink(from)` in place fails with ENOENT and the rollback beneath it
  // unlinks the *target* - destroying the take on every rename, which would redden
  // half the section for a reason that has nothing to do with the race. The mutated
  // build has to be the plausible wrong one, not a broken one.
  'rename-clobbers-under-a-race': {
    file: 'server/library.js',
    edits: [
      [
        '    if (!await linkInto(from, target)) throw new Error(`${id} is no longer in ${root}`);',
        '    await rename(from, target);',
      ],
      ['    await unlink(from);', '    /* mutation: rename moved it already */'],
    ],
  },
  // The take being recorded becomes renameable, which is the failure that cannot be
  // seen from the rename's own answer: `scanTakes` decides which take is open by
  // comparing paths, so the renamed one stops matching and every `/library/*` request
  // starts a full read plus sha256 of a file the recorder is still writing.
  //
  // **Aimed at `renameTake` and not at the route, and the first aim is worth
  // recording because it was NOT CAUGHT.** The route carried a second copy of this
  // test in identical words, so deleting one of the two moved nothing observable: 317
  // assertions, none failed, against a build with a guard removed - which reads as the
  // refusal working and was the other guard doing the refusing. The duplicate is gone
  // and this points at the one that decides.
  //
  // **Two rows fire and the second is the one carrying the claim.** The message row
  // goes red because the refusal that comes back instead is the hash gate - a take
  // mid-write advertises no hash, so nothing can name one - and the sidecar row goes
  // red because reaching that gate at all means `cachedIndex` has scanned the file the
  // recorder has open and left a `.idx` beside it. The scan is the harm; the message
  // is how it announces itself.
  'rename-during-a-shoot': { file: 'server/library.js', edits: [[
    '  if (recordingPath !== null && resolve(from) === resolve(recordingPath)) {',
    '  if (false) {',
  ]] },

  // ---- reveal
  //
  // The path is dropped from the arguments, so the file manager is started on nothing
  // - a route that answers 200 having done something that is not what it says. This is
  // the row a status code cannot carry, which is why the check reads the argv the
  // program was actually given rather than the answer the route wrote.
  'reveal-drops-the-path': { file: 'server/library.js', edits: [REVEAL_EDIT] },
  // **The gallery goes back to composing its own refusal**, which is the shape that
  // shipped: two derivations of one predicate twelve lines apart, disagreeing on the
  // take with a hello and no whole frame. The historical body rather than a minimal
  // edit, because what the row claims is that the page reads the reason it was sent
  // rather than that one branch of it is right.
  //
  // Anchored on the *post-fix* text on purpose. A mutation written against the code
  // the fix deletes matches nothing, the unmutated page loads, and the run is recorded
  // as this check having missed a bug it was never shown.
  'open-decides-its-own-reason': { file: 'web/library.js', edits: [[
    "const cannotOpen = (take) => take.openRefusals[0]?.why ?? '';",
    'const cannotOpen = (take) => {\n'
      + '  if (take.recording === true) return warningsOf(take)[0].why;\n'
      + "  if (take.hasHello === false) return 'this take carries no sensor hello, so its intrinsics are unknown';\n"
      + "  if (take.frames !== null && take.frames < 2) return 'a take needs two frames to bracket a position';\n"
      + "  return '';\n"
      + '};',
  ]] },
  // **The menu goes back to naming both causes at once**, which is the sentence that
  // shipped: a page holding an `openable` boolean and nothing telling it which half
  // fired, so a take with a hello and one frame was told it might have neither. A
  // second control beside `open-decides-its-own-reason` and not a widening of it,
  // because the claim is that *whichever surface asks* gets the server's sentence, and
  // a control that mutates only the gallery leaves the other surface free to derive its
  // own with every row still green - which is what it was doing.
  'menu-decides-its-own-reason': { file: 'web/menu.html', edits: [[
    '  if (!take.openable) {\n'
      + '    const why = take.openRefusals.map((r) => r.why).join(\'; \');\n'
      + '    return gallery(`${take.id} cannot be opened: ${why}`);\n'
      + '  }',
    '  if (!take.openable) return gallery(`${take.id} cannot be opened: no sensor hello, or under two frames`);',
  ]] },
  // **A refusal the server declares and no page can badge**, which is the drift the
  // two-table row exists to catch and could not see while it read the refusals a
  // fixture take happened to carry. Nothing here provokes this key - that is the
  // point: a reason that applies to a take shape this library does not hold is exactly
  // the one that would arrive unbadged, and a row deriving its list from
  // `/library/takes` would compare two keys against two keys and print green.
  'refusal-without-a-badge': { file: 'server/library.js', edits: [[
    'export const OPEN_REFUSALS = {\n',
    'export const OPEN_REFUSALS = {\n'
      + "  'wrong-format': () => 'this take was written by a generation of the format this build cannot read',\n",
  ]] },
  // **The badge table goes back to having a prototype**, which is where it was and
  // which answers `BADGES['__proto__']` with `Object.prototype` instead of `undefined`.
  // The `?.` then does not short-circuit and the call throws on a value that is not a
  // function, so a refusal key chosen by another machine kills the shelf - through the
  // one door the version gate is deliberately told to leave open, since the gate checks
  // the shape of a manifest and not its vocabulary.
  //
  // **Two anchors around the table rather than one across it**, and the first spelling
  // spanned the whole body - every entry, in order. That is a mutation whose anchor
  // moves whenever a badge is added, which is the one edit this file expects to keep
  // making: the format band landed and `syntax-check` refused the run because the
  // control could no longer find its own text. The claim is about the two lines that
  // construct the table, so those are what it anchors on, and a fourth badge added
  // between them changes nothing here.
  'badges-inherit-from-object': { file: 'web/library.js', edits: [
    ['const BADGES = Object.assign(Object.create(null), {\n', 'const BADGES = {\n'],
    // Anchored with the last entry above it, because `});` alone appears throughout the
    // page and `mutatedSource` requires a match exactly once.
    ["  short: (take) => (take.frames === 0 ? 'no frames' : '< 2 frames'),\n});",
      "  short: (take) => (take.frames === 0 ? 'no frames' : '< 2 frames'),\n};"],
  ] },
  // **The scanner forgets to push a refusal it declares**, which leaves `no-hello` in
  // `OPEN_REFUSALS`, in the page's `BADGES`, and on no take that exists - a reason and a
  // badge for it that nothing can ever wear. It is the direction the containment row
  // could not see while it only asked that what arrived was declared, and it is the
  // ordinary way this breaks: a refusal is added to the table and to the page, and the
  // branch that would produce it is written last or not at all.
  //
  // Aimed at the push rather than at the table. A mutation adding a key to the table
  // reddens the badge row as well - `refusal-without-a-badge` does, measured, both rows
  // - and two rows red for two different reasons cannot say which was carrying the
  // claim. Neither control is isolated, and this one is not either: five rows go, and
  // they are all one fact arriving in five places, which is the take with no hello no
  // longer saying it cannot be opened. Read them as one.
  'refusal-declared-but-never-pushed': { file: 'server/library.js', edits: [[
    "  if (!index.hello) openRefusals.push(refusal('no-hello'));\n",
    '',
  ]] },
  // **The take being written goes back to answering twice**, which is where it was: the
  // list on one line and a hardcoded `openable: false` on the next. Both edits together,
  // because a mutation that only hardcodes the boolean changes nothing observable - the
  // list is non-empty, so `false` is what deriving would have given and the run would
  // record a control that did nothing. Emptying the list beside it is what makes the two
  // disagree, and disagreeing is the whole subject: the manifest goes on reporting a take
  // that cannot be opened while `cannotOpen` has nothing to quote, so the Open button is
  // disabled with an empty explanation.
  'recording-decides-openable-itself': { file: 'server/library.js', edits: [
    ["    const openRefusals = [refusal('recording')];", '    const openRefusals = [];'],
    ['      openRefusals,\n      openable: openRefusals.length === 0,\n      recording: true,',
      '      openRefusals,\n      openable: false,\n      recording: true,'],
  ] },
  // **The capture-format band goes back to being a term in `openable` rather than a
  // refusal in the list**, which is the shape it arrived from `main` in and the shape the
  // merge changed. It is the control for that change, and the reason it needs one is that
  // the three rows `main` brought - the future-format take lists, names its generation and
  // says it cannot be opened - are all still true here. `openable` is false either way, so
  // every row asking `openable` passes a build where the band decides for itself again,
  // and the difference only shows in what the take *carries*: a refusal with a sentence
  // the tile can badge, or nothing, leaving a dead Open button with no reason on it.
  //
  // Two edits because the term and the push are two halves of one decision, and removing
  // only the push would leave `openable` reading a list the band no longer writes to,
  // which is a build that opens a take it cannot read rather than the one under test.
  //
  // Narrow on purpose: an empty `openRefusals` still satisfies `carriesRefusals`, so the
  // node link stays up and the rest of the suite still measures.
  // The second edit carries `openRefusals,` above it and `recording: false,` below,
  // because both branches of `describeTake` derive `openable` from the list now and the
  // line on its own matches twice. `recording: false` is what says which branch this is.
  'openable-recomputes-the-band': { file: 'server/library.js', edits: [
    ["  if (captureFormatRefusal('this take', format) !== '') openRefusals.push(refusal('format', format));\n", ''],
    ['    openRefusals,\n    openable: openRefusals.length === 0,\n    recording: false,',
      '    openRefusals,\n'
      + "    openable: Boolean(index.hello) && stamps.length >= 2 && captureFormatRefusal('this take', format) === '',\n"
      + '    recording: false,'],
  ] },
  // **One dimension of the grid stops being a literal while the other holds**, and the
  // value is deliberately unchanged - `DEPTH_W - 88` is still 424, so every page still
  // renders the same pixels and every message is still the same size. That is what
  // makes it a control for the declaration rows and for nothing else: the only thing it
  // can move is whether `424` is written down in the tree. A single regex over
  // `512|424` is answered by the `512` still sitting two lines above and reports the
  // grid as stated once, which is the row this splits in two.
  'grid-loses-a-dimension': { file: 'web/format.js', edits: [[
    'export const DEPTH_H = 424;',
    'export const DEPTH_H = DEPTH_W - 88;',
  ]] },
  // **The link demands that every take name a refusal**, which refuses a node for being
  // healthy: `openRefusals: []` is what an ordinary openable take sends, so this takes
  // the link off for every library that has nothing wrong with it. It reddens the
  // node's own rows and the arm holding the openable take, and it is the control for
  // the fixture rather than for the gate - a positive arm carrying only a *refused*
  // take passes this mutation while every real node goes dark.
  'refusals-must-be-nonempty': { file: 'server/library.js', edits: [[
    'const carriesRefusals = (take) => Array.isArray(take.openRefusals)\n',
    'const carriesRefusals = (take) => Array.isArray(take.openRefusals)\n  && take.openRefusals.length > 0\n',
  ]] },
  // **The link admits a manifest from the build before the refusals moved**, which is
  // the take that reconciles in looking like any other and then blanks the shelf while
  // the first remote tile paints. The gate rather than the sentence it sets, because
  // what the row claims is that nothing without refusals reaches a surface - a mutation
  // of the wording would redden a message row while the take still came through.
  'node-admits-an-old-manifest': { file: 'server/library.js', edits: [[
    '      const older = takes.find((t) => !carriesRefusals(t));\n      if (older) {',
    '      const older = takes.find((t) => !carriesRefusals(t));\n      if (false) {',
  ]] },

  // The same gate on the other route goes away: a `/record/state` with no `writingId`
  // in it is read as a recorder that owns no take, which is what `?? null` did before
  // the refusal existed. The field is still filtered for, so the mutation is the
  // conclusion drawn from it rather than the question - a build that stopped asking
  // would also stop the heal arm working and could not say which half was wrong.
  //
  // Must redden two rows and leave three green: the refusal itself and the listing that
  // carries it go red, while the node that carries the field, the takes that still list
  // beside it, and the heal all pass on both builds - the mutated build never refuses,
  // so it has nothing to recover from and the heal row reads as success. That
  // asymmetry is the point: a control reddening the whole section would not show that
  // absence and an idle recorder had stopped being told apart.
  'node-admits-an-old-record-state': { file: 'server/library.js', edits: [[
    '      const missing = POLLED_NODE_FIELDS.filter((f) => body[f] === undefined);',
    '      const missing = POLLED_NODE_FIELDS.filter((f) => body[f] === undefined) && [];',
  ]] },
  // **The monitor's cost line goes back to spelling the grid out inline**, which is
  // where it was for as long as the comment above it promised the opposite. It
  // computes exactly the same number, renders identical pixels and serves identical
  // bytes, so the only thing it can move is the single-declaration row - which is what
  // makes it a control for that row rather than for the gallery.
  //
  // Deliberately not written as an edit that replaces an import line. `web/main.js`
  // reaches `PROJECT_VERSION`, `versionRefusal` and the grid through one import and
  // `web/library.js` reaches `VALID_ID` and the grid through another, so a mutation
  // swapping either for local declarations takes an unrelated binding out with it and
  // reddens half the suite - a control that fails everything cannot say which row was
  // carrying the claim.
  'grid-declared-twice': { file: 'web/main.js', edits: [[
    '  const depthKB = Math.ceil(DEPTH_W / state.divisor) * Math.ceil(DEPTH_H / state.divisor) * 2 / 1000;',
    '  const depthKB = Math.ceil(512 / state.divisor) * Math.ceil(424 / state.divisor) * 2 / 1000;',
  ]] },
  // **The same second declaration, spelled so a search for the digits cannot see it.**
  // `0x200` is 512 and `4.24e2` is 424, so this is `grid-declared-twice` with nothing
  // changed but the notation - the line computes the same number and renders the same
  // pixels. It is the control for the row's matcher rather than for the row: the version
  // of this check that searched for decimal digits with boundary guards passes this
  // mutation and reports the grid as declared once, which is a second implementation of
  // the sensor's geometry under a green row. Its sibling above stays, because the two
  // fail differently - that one is caught by any matcher and this one only by a matcher
  // that compares values.
  'grid-declared-in-another-spelling': { file: 'web/main.js', edits: [[
    '  const depthKB = Math.ceil(DEPTH_W / state.divisor) * Math.ceil(DEPTH_H / state.divisor) * 2 / 1000;',
    '  const depthKB = Math.ceil(0x200 / state.divisor) * Math.ceil(4.24e2 / state.divisor) * 2 / 1000;',
  ]] },
  // **And the notation with no leading digit**, which is its own mutation rather than a
  // third number in the one above because a spelling is only covered where a control
  // plants it: hex and digit-leading scientific were, and `.512e3` was not, so the row's
  // claim to see any spelling was two-thirds measured. The scan entering only on a digit
  // passes this and reports the grid as declared once.
  'grid-declared-with-a-leading-dot': { file: 'web/main.js', edits: [[
    '  const depthKB = Math.ceil(DEPTH_W / state.divisor) * Math.ceil(DEPTH_H / state.divisor) * 2 / 1000;',
    '  const depthKB = Math.ceil(.512e3 / state.divisor) * Math.ceil(.424e3 / state.divisor) * 2 / 1000;',
  ]] },
  // The loopback gate comes off the one route in this program that starts a process,
  // so a browser across the link opens a window on a machine nobody is standing at.
  'reveal-answers-any-caller': { file: 'server/index.js', edits: [[
    '  if (!isLoopback(req)) {\n    const { label } = revealSupport();',
    '  if (false) {\n    const { label } = revealSupport();',
  ]] },

  // ---- the supervisor's reference to the grabber it is supervising
  //
  // The exit handler stops nulling the reference, so for the whole respawn backoff the
  // colour toggle finds a `ChildProcess` that has already exited, arms `restarting`
  // against it and calls `stopGrabber` on a pid that cannot be signalled. Nothing then
  // consumes the flag until the next genuine failure, which reads it as a requested
  // restart. Anchored on the comment above the line as well as the line itself, because
  // the identity test it copies appears verbatim in the spawn-`error` handler thirty
  // lines up and a bare anchor would match twice.
  'exit-keeps-the-child-reference': { file: 'server/index.js', edits: [[
    '      // restart branch returns before the rest of the handler runs.\n      if (child === proc) child = null;',
    '      // restart branch returns before the rest of the handler runs.',
  ]] },
};

function mutatedSource(name) {
  const spec = MUTATIONS[name];
  if (!spec) throw new Error(`unknown mutation ${name} - have ${Object.keys(MUTATIONS).join(', ')}`);
  let source = readFileSync(join(REPO, spec.file), 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`mutation ${name} matched ${hits} times in ${spec.file}, expected exactly 1: ${from}`);
    }
    source = source.replace(from, to);
  }
  return { file: spec.file, body: source };
}

const mutation = MUTATE ? mutatedSource(MUTATE) : null;
const pageMutation = mutation && mutation.file.startsWith('web/') ? mutation : null;
// The URL a page file is served at, which is not its filename. `server/index.js` 404s
// any `.html` under `web/` on purpose - a page has exactly one address - so
// `library.html` is reachable only at the `/gallery` its `PAGES` table names, while the
// modules beside it are served by name.
//
// This is unavoidably a second spelling of that table, and it is **checked rather than
// trusted**: `requireMutationDelivered` fetches this URL and requires the bytes back to
// be the ones this run staged, so a page that moved or stopped being served fails the run
// by name instead of loading unmutated. That is the whole difference from the mechanism
// this replaced, which could match nothing and say so to nobody.
//
// Moved or removed, and **not a second address gained**, which one fetch of one URL
// cannot see: `/gallery` would go on answering with the staged bytes and this would pass.
// The narrower claim is the true one and it is also the sufficient one, because every
// navigation in this file reaches the gallery through `galleryPage`, so the address this
// checks is the address under test - an alias nothing opens delivers nothing. Written out
// because the wider claim was here first, and a comment promising a guarantee its check
// does not make is the failure this file exists to refuse.
//
// **The menu is the second entry and it is the one that shows why this is a table.** It
// is served at `/`, which is not its filename and not a name a fallback could guess, so
// `menu-decides-its-own-reason` staged a mutated `menu.html` that a browser asking for
// the menu would never have received. The fallback below sends an unlisted page to
// `/menu.html`, the server 404s that on purpose, and `requireMutationDelivered` stops
// the run naming the file - which is the loud half of the same rule: a page mutation
// either arrives or the run refuses to be counted.
const PAGE_URLS = { 'library.html': '/gallery', 'menu.html': '/' };
const urlForPageFile = (file) => PAGE_URLS[file] ?? `/${file}`;
const serverMutation = mutation && mutation.file.startsWith('server/') ? mutation : null;

/**
 * A file of the staged tree as this run actually ships it.
 *
 * **One read, because there is one delivery.** This used to be a conditional -
 * `mutation.body` for the mutated file and the staged copy for everything else - and the
 * difference was load-bearing when `stageServer` wrote only *server* mutations into the
 * tree and a page mutation was fulfilled by intercepting its route in the browser. The
 * staged `web/main.js` on a `--mutate grid-declared-twice` run really was the clean file
 * then, so a source row reading it would have passed against every page mutation there
 * is: a falsification control that cannot fire, one layer further out than the
 * match-exactly-once rule that guards the anchor.
 *
 * `stageServer` writes every mutation now, whichever side of the wire it is on, so the
 * two branches returned identical bytes and the conditional was a second path that could
 * only ever agree. Kept as a named helper rather than inlined, because a row wants to say
 * it is reading what this run ships and not what the repo holds - but the answer to that
 * is the staged tree and nothing else.
 *
 * What holds the staging is the source rows' own controls: remove that write and
 * `grid-declared-twice` stops reddening, which is a mutation this suite already runs.
 *
 * `root` is read at call time rather than closed over at declaration, which is why this
 * can sit beside the mutation table it belongs to and above the tree it reads.
 */
const shippedSource = (rel) => readFileSync(join(root, rel), 'utf8');

/**
 * Every number a piece of JavaScript states as code, by value.
 *
 * **A scan rather than a pair of regexes, and it replaced two.** What a row about the
 * sensor grid needs is the numbers the *code* says, and the two things that are not code
 * are comments and literal text - so the question is what a JavaScript lexer would call a
 * numeric token, and nothing else is a reliable way to ask it. Four files in this tree
 * name the grid in prose (`web/format.js` explaining why it lives there, `web/main.js`
 * describing the band a mis-bound frame collapses into, `server/protocol.js` sizing a
 * message, `server/webcam.js` saying what the colour camera is not) and every one is a
 * comment doing its job; the string half is the same fact one layer in, where an
 * ordinary `throw new Error('expected 512 bytes')` added to any module would have been
 * counted as a second declaration of the sensor's width.
 *
 * The regexes this replaces each approximated one half and each carried a patch for the
 * other's territory - the line-comment rule skipped a `//` preceded by a colon, so that a
 * URL in a string would survive, which is a lexer being written one exception at a time.
 * One pass that knows what a literal is has no exceptions to accumulate.
 *
 * **Template expressions are scanned and template text is not**, which is the one place
 * the two can be interleaved: `${...}` is code by definition and the brace depth says
 * where it ends.
 *
 * **Where it guesses, it guesses toward reporting.** A `/` is division or the start of a
 * regex depending on what came before it, and there is no correct answer without a parse.
 * The unambiguous cases are decided by the previous significant token and skipped whole -
 * `= /[0-9a-f]{64}/` is a regex and its digits are not declarations of anything. What is
 * left ambiguous is `}`, which ends a block (a regex may follow) or an object (division
 * may), and this reads it as division. Wrong that way, a regex's contents get scanned as
 * code and a digit inside one is a holder reported that is not one, which fails loudly and
 * gets looked at. Wrong the other way, it skips to the next `/` and swallows whatever code
 * is in between, which is a declaration going unseen under a green row. Only one of those
 * two is safe to be wrong about.
 */
const numbersIn = (src) => {
  const values = [];
  // One entry per literal we are inside, innermost last. A backtick pushes `template`;
  // a `${` inside one pushes `code` remembering the brace depth to come back at.
  const stack = [];
  const inTemplate = () => stack[stack.length - 1]?.kind === 'template';
  let depth = 0;
  // The last significant character and the last identifier, which together decide the `/`
  // question. Not the last character alone: `return` ends in a letter and a letter ends a
  // value, so the character on its own calls every `return /re/` a division. `prevWord` is
  // cleared by every branch that is not an identifier, because a `return` left standing
  // across the string in `return 'x' / 2` would turn that division into a regex and
  // swallow the code up to the next slash - which is the silent direction.
  let prev = '';
  let prevWord = '';
  let i = 0;
  // The decimal form has two shapes because JavaScript does: digits first, or a leading
  // dot. `.512e3` is 512 and the first spelling of this scan could not see it, since it
  // entered only on a digit - a whole notation in which a second grid could be declared
  // under a green row, which is the direction that does not announce itself. A dot
  // followed by a digit is never a property access, because `a.512` is a SyntaxError, so
  // there is nothing to disambiguate here.
  const NUM = /^(?:0[xX][\dA-Fa-f](?:_?[\dA-Fa-f])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?|\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?)n?/;
  // The words after which a `/` is a pattern and never a quotient.
  const REGEX_AFTER = new Set(['return', 'throw', 'case', 'yield', 'typeof', 'instanceof',
    'in', 'of', 'delete', 'void', 'new', 'do', 'else', 'await']);
  // What may begin and continue a name, taken from the language rather than described.
  // `$` and `_` are named because they are the two the properties leave out.
  const ID_START = /[\p{ID_Start}$_]/u;
  // The two joiners are written as escapes on purpose - they are zero-width, and a
  // character class nobody can see the contents of is one nobody can review.
  const ID_PART = /[\p{ID_Continue}$\u200C\u200D]/u;
  while (i < src.length) {
    const c = src[i];
    if (inTemplate()) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); prev = '`'; prevWord = ''; i++; continue; }
      if (c === '$' && src[i + 1] === '{') {
        stack.push({ kind: 'code', depth });
        depth++;
        prev = '{';
        prevWord = '';
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      i++;
      prev = c;
      prevWord = '';
      continue;
    }
    if (c === '`') { stack.push({ kind: 'template' }); i++; prevWord = ''; continue; }
    // An identifier taken whole, because the `/` question below is about the previous
    // *token* and asking it of the previous character gets `return /512/` wrong - `n` ends
    // a word, a word ends a value, and a value means division. That reads the regex as
    // code and reports its digits, which is the loud direction but still a clean tree
    // failing over a module that returns a pattern.
    //
    // **`ID_Start` and `ID_Continue` rather than the ASCII classes**, which is the same
    // correction as taking HTML's MIME list instead of a pattern shaped like it: these
    // properties *are* the language's definition of an identifier, and `[A-Za-z_$]` is a
    // guess at one that happens to cover the letters this tree uses today. `pixelsπ` is a
    // perfectly good name; under the ASCII classes the `π` fell out of the identifier,
    // landed as punctuation, and the division behind it read as a regex that swallowed
    // the number - silently, and in a module the row is meant to be reading.
    // **Walked by code point, not by code unit.** `𐐀` is `ID_Continue` and lives outside
    // the basic plane, so a JavaScript string holds it as two surrogates - and a lone
    // surrogate is not `ID_Continue`, so indexing one character at a time stopped the
    // name in the middle of a letter. The rest of it then landed as punctuation and the
    // division behind it opened a regex over the number, which is the same silent ending
    // as every other way of not finishing a token.
    if (ID_START.test(String.fromCodePoint(src.codePointAt(i)))) {
      let j = i;
      while (j < src.length) {
        const letter = String.fromCodePoint(src.codePointAt(j));
        if (!ID_PART.test(letter)) break;
        j += letter.length;
      }
      prevWord = src.slice(i, j);
      prev = 'a';
      i = j;
      continue;
    }
    // **`++` and `--` are transparent to the value question**, and taking them one
    // character at a time got that wrong: each `+` left `prev` as `+`, which is not the
    // end of a value, so the slash in `counter++ / 512` read as a regex and swallowed the
    // rest of the line - the silent direction, and the whole point of a scan is that it is
    // not doing that. Leaving `prev` alone is what makes it right in both positions:
    // postfix keeps the value its operand already ended, and prefix keeps whatever came
    // before it, since the operand it binds to sets `prev` a moment later anyway.
    if ((c === '+' || c === '-') && src[i + 1] === c) { i += 2; continue; }
    // A regex only where a value cannot already have ended - or after one of the words
    // that cannot be followed by division, which is what makes `return /512/` a pattern
    // and `total / 512` a quotient. `}` stays the ambiguous case resolved toward
    // division, as the comment above says.
    if (c === '/' && (!/[\w$)\]}'"`]/.test(prev) || REGEX_AFTER.has(prevWord))) {
      i++;
      let klass = false;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === '[') klass = true;
        else if (src[i] === ']') klass = false;
        else if (src[i] === '/' && !klass) break;
        else if (src[i] === '\n') break;
        i++;
      }
      i++;
      // **A finished regex is a value**, and leaving `prev` as the slash that closed it
      // said the opposite - so `/x/ / 512` read the second slash as another opener and
      // swallowed the number. `)` stands for "a value ended here" the same way it does
      // after a call, which is what the question below actually asks.
      prev = ')';
      prevWord = '';
      continue;
    }
    if (c === '{') { depth++; prev = c; prevWord = ''; i++; continue; }
    if (c === '}') {
      depth--;
      const top = stack[stack.length - 1];
      if (top?.kind === 'code' && top.depth === depth) { stack.pop(); prevWord = ''; i++; continue; }
      prev = c;
      prevWord = '';
      i++;
      continue;
    }
    // A number, in either of the two shapes one can start in: a digit, or a dot with a
    // digit behind it. `x512` is a name and never reached here, because the identifier
    // branch above has already taken it whole.
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
      const [token] = NUM.exec(src.slice(i));
      // **Legacy octal, read as octal.** `01000` is 512 to a browser and 1000 to
      // `Number`, and the comment that used to sit here said the form could be ignored
      // because every file walked is a module and a module makes it a SyntaxError. That
      // stopped being true when this began reading `<script>` bodies: an untyped script is
      // a *classic* script, which is sloppy mode, where the form is legal and means 512.
      // A comment asserting a property the code no longer has is the failure this file
      // exists to refuse, so the form is handled rather than the sentence rewritten.
      //
      // Only a leading zero followed by octal digits: `08` and `09` are the legacy
      // *decimal* forms and mean eight and nine, `0` alone is zero, and anything carrying
      // a dot or an exponent is decimal - all three fall out of the pattern rather than
      // needing a case.
      const digits = token.replace(/n$/, '').replace(/_/g, '');
      values.push(/^0[0-7]+$/.test(digits) ? parseInt(digits, 8) : Number(digits));
      i += token.length;
      prev = '0';
      prevWord = '';
      continue;
    }
    if (!/\s/.test(c)) { prev = c; prevWord = ''; }
    i++;
  }
  return values;
};

// ----------------------------------------------------------------- the fixtures
//
// Every take here is built rather than downloaded, so its shape is a decision this
// file makes and can name. Sized by frame count and not by duration: the sample was
// captured on a degraded link at about 9.3fps, so its seconds are not a real take's
// seconds and a fixture measured in them would be measuring the wrong thing.

function sampleMessages() {
  const parser = new MessageParser();
  const frames = [];
  let hello = null;
  for (const msg of parser.push(readFileSync(SAMPLE))) {
    if (msg.type === TYPE_HELLO) hello ??= Buffer.from(msg.payload);
    else if (msg.type === TYPE_FRAME) frames.push(Buffer.from(msg.raw));
  }
  if (!hello) throw new Error(`${SAMPLE} carries no hello`);
  return { hello, frames };
}

const SRC = sampleMessages();

/**
 * Writes a take. `frames` is a count, `withHello` decides whether the sensor record
 * is there at all, `truncate` cuts the last message in half so the scan's
 * `truncated` flag has something to report - the flag has been computed since step
 * 2 and read by nothing until this gallery.
 */
function writeTake(dir, id, { frames = 8, withHello = true, truncate = false, startedAt = null, format = null } = {}) {
  const parts = [];
  if (withHello) {
    // The wall-clock capture date, which the frame stamps cannot supply: they are
    // `steady_clock`, monotonic since boot, right for frame spacing and useless for
    // sorting a library. And the capture format's generation, which is the same shape
    // of field for the same reason - the sample predates both, so a hello carried
    // through untouched is honestly a take from before either existed, which is the
    // shape most of this fixture wants and one the gallery has to keep opening.
    //
    // Re-serialised only when something was asked for, and the asked-for keys land in
    // this order, so a call that names neither writes the sample's own bytes back. The
    // takes both machines hold are compared by content hash, and a helper that
    // re-serialised unconditionally would leave that resting on `JSON.stringify` being
    // stable rather than on the two files being the same file.
    //
    // **`startedAt: false` strips the key, and that is not the same request as leaving
    // it alone.** Carrying the sample's hello through was how this fixture asked for a
    // take from before the field existed, which is only true while the sample on the
    // machine is one of those. `captures/` is gitignored and every current build stamps
    // a wall clock into the hello, so on a freshly shot sample the take meant to prove
    // the gallery falls back to the file date arrived carrying a date - and the row
    // reddened over a fixture that had quietly stopped being the shape it was named
    // for. Asked for explicitly, it is the same take on any sample.
    const stripped = startedAt === false;
    const stamped = {
      ...(startedAt === null || stripped ? {} : { startedAt }),
      ...(format === null ? {} : { format }),
    };
    const hello = Object.keys(stamped).length === 0 && !stripped
      ? SRC.hello
      : (() => {
        const parsed = { ...JSON.parse(SRC.hello.toString('utf8')), ...stamped };
        if (stripped) delete parsed.startedAt;
        return Buffer.from(JSON.stringify(parsed));
      })();
    parts.push(encodeMessage(TYPE_HELLO, hello));
  }
  for (let i = 0; i < frames; i++) parts.push(SRC.frames[i % SRC.frames.length]);
  let body = Buffer.concat(parts);
  if (truncate) body = body.subarray(0, body.length - 40000);
  const path = join(dir, `${id}.knct`);
  writeFileSync(path, body);
  return path;
}

/**
 * A take whose second frame declares more colour bytes than it carries.
 *
 * The reachable version is a writer that died between the header and the payload,
 * or a take truncated by a card pulled - the scan indexes what landed, and the
 * frame's own two lengths then no longer add up to the frame. The decimation path
 * builds a new buffer out of those two numbers with `allocUnsafe` and copies the
 * colour block into it, so an overstated length left the tail of the served frame
 * as whatever was in that memory: this process's own recycled heap, handed to
 * whoever asked for a frame.
 */
function writeBadLengthTake(dir, id) {
  const good = SRC.frames[0];
  const bent = Buffer.from(good);
  // The framing is untouched, so the scan walks the file cleanly and indexes the
  // frame - which is what makes this a bad *frame* rather than a bad file. Only the
  // colour length inside the payload moves, and it moves upward.
  const payloadAt = 12;
  const colorBytes = bent.readUInt32LE(payloadAt + 4);
  bent.writeUInt32LE(colorBytes + 4096, payloadAt + 4);
  const body = Buffer.concat([encodeMessage(TYPE_HELLO, SRC.hello), SRC.frames[1], bent, SRC.frames[2]]);
  const path = join(dir, `${id}.knct`);
  writeFileSync(path, body);
  return path;
}

const markLine = (rec) => `${JSON.stringify(rec)}\n`;

/**
 * A run of frame payloads for the deterministic drive, colour dropped so the page
 * parses them with the same field offsets the socket path uses and nothing waits on
 * an asynchronous JPEG decode. Real sensor depth and the capture's own timestamps -
 * only the colour block is absent.
 *
 * The image claim below runs on this rather than on the indexed source, and that is
 * a property rather than a convenience: the drive renders an exact program position
 * with no fetch between it and the pixels, so two runs differ because the look
 * differs and for no other reason.
 */
function pinFixture(count = 6, stride = 4) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const src = SRC.frames[(i * stride) % SRC.frames.length].subarray(12);
    const depthBytes = src.readUInt32LE(0);
    const payload = Buffer.alloc(16 + depthBytes);
    payload.writeUInt32LE(depthBytes, 0);
    payload.writeUInt32LE(0, 4);
    src.copy(payload, 8, 8, 16);
    src.copy(payload, 16, 16, 16 + depthBytes);
    out.push(payload);
  }
  return Buffer.concat(out);
}

function buildFixture() {
  rmSync(WORK, { recursive: true, force: true });
  const nodeCaps = join(WORK, 'node-captures');
  const macCaps = join(WORK, 'mac-captures');
  for (const d of [nodeCaps, macCaps, join(WORK, 'projects'), join(WORK, 'presets'), join(WORK, 'empty-captures')]) {
    mkdirSync(d, { recursive: true });
  }

  // The take both machines hold, under **different filenames**. This is the whole
  // of the reconciliation claim: nothing about these two names is comparable, and
  // the bytes are identical.
  writeTake(macCaps, 'mac-name-for-it', { frames: 12, startedAt: Date.UTC(2026, 6, 14, 9, 30) });
  writeTake(nodeCaps, 'node-name-for-it', { frames: 12, startedAt: Date.UTC(2026, 6, 14, 9, 30) });

  // The same *filename* on both machines with different bytes. The mirror claim:
  // a name shared is not a take shared.
  writeTake(macCaps, 'same-name', { frames: 6 });
  writeTake(nodeCaps, 'same-name', { frames: 9 });

  // Local only, and the take everything that needs a real clip uses.
  writeTake(macCaps, 'local-clip', { frames: 60, startedAt: Date.UTC(2026, 6, 15, 18, 5) });

  // The shapes the gallery has to survive rather than the shapes it likes.
  writeTake(macCaps, 'truncated-take', { frames: 6, truncate: true, startedAt: false });
  writeTake(macCaps, 'no-hello-take', { frames: 6, withHello: false });
  writeTake(macCaps, 'one-frame-take', { frames: 1 });
  // **A hello, and no whole frame - the one shape that could tell the gallery's two
  // openability sentences apart, and the take nobody planted.** `three-warning-take`
  // below reaches zero frames the same way but carries no hello, so the button's
  // refusal answered on the hello branch and never reached the frame one;
  // `one-frame-take` above has a hello and a frame, where the two sites agreed. Both
  // observations skipped this object, which is why the button could say a take "needs
  // two frames to bracket a position" - a sentence about a take with one - over a
  // poster correctly badged as having none, for as long as it did.
  writeTake(macCaps, 'hello-no-frames', { frames: 1, truncate: true });
  writeBadLengthTake(macCaps, 'bad-length-take');
  // **Three warnings at once, which is the tile the height rows need and none of the
  // takes above is.** Every fixture take carries at most one - truncated, or no
  // hello, or under two frames - so a uniform-height assertion measured across them
  // alone would agree on a build where each warning still added a row, because one
  // row against one row is the same height. The shape that used to differ is the take
  // that fires several, and until this existed the check could not stand in front of
  // it. Same reading as step 6's aspect ratio: a set of arms that agree about a
  // quantity cannot measure it however many of them there are.
  writeTake(macCaps, 'three-warning-take', { frames: 1, withHello: false, truncate: true });

  // **Both ends of the capture format's band, and the second one is why there are two.**
  //
  // The first declares a generation this build has never read. Everything about it is a
  // perfectly ordinary take - whole frames, a readable hello, intrinsics in range - and
  // the only thing wrong with it is that nothing here knows what its numbers mean, which
  // is exactly the case that has no other symptom.
  //
  // The second declares nothing at all, which is what `sample.knct` itself is and what
  // every take shot before the field existed is. It is planted under its own name rather
  // than left to the takes that happen to be generation zero for other reasons, because
  // it is a claim in its own right and a claim wants a row that names it: a band written
  // as "refuse anything unfamiliar" passes every assertion about the take above and
  // condemns the entire existing archive, and a control that refused both would be
  // proving only that the gallery can say no.
  writeTake(macCaps, 'future-format-take', { frames: 6, format: CAPTURE_FORMAT + 1 });
  writeTake(macCaps, 'generation-zero-take', { frames: 6 });

  // Mark counts the tile renders differently: none, exactly one, and several - plus
  // a mark at source zero and a mark past the end of the footage, which are the two
  // positions a fraction can get wrong without any of the middle ones noticing.
  writeFileSync(join(macCaps, 'local-clip.marks.jsonl'),
    markLine({ id: 'k0', sourceMs: 0, label: 'first frame', at: 1000 })
    + markLine({ id: 'k1', sourceMs: 1200, label: 'the drop', at: 1000 })
    + markLine({ id: 'k2', sourceMs: 3400, label: 'turn', at: 1000 })
    + markLine({ id: 'kBeyond', sourceMs: 900000, label: 'past the end', at: 1000 }));
  writeFileSync(join(macCaps, 'same-name.marks.jsonl'),
    markLine({ id: 'only', sourceMs: 500, label: 'sole mark', at: 1000 }));
  // The node's log for the shared take, which the download has to merge: one mark
  // the mac has never seen, one the mac will supersede, and one already tombstoned.
  writeFileSync(join(nodeCaps, 'node-name-for-it.marks.jsonl'),
    markLine({ id: 'n1', sourceMs: 700, label: 'node mark', at: 1000 })
    + markLine({ id: 'n2', sourceMs: 900, label: 'to be moved', at: 1000 })
    + markLine({ id: 'n3', sourceMs: 1100, label: 'doomed', at: 1000 })
    + markLine({ id: 'n3', deleted: true, at: 2000 }));

  return { nodeCaps, macCaps };
}

// ------------------------------------------------------------------- the servers
//
// Spawned out of a copy of `server/` with `web`, `node_modules` and `vendor`
// symlinked beside it, so a server-side mutation is a file in a scratch tree rather
// than an edit to the repo. A mutation applied in place and restored afterwards
// would leave a mutated working tree behind any crash, which is precisely the state
// a proof tool must never be able to produce.

function stageServer() {
  const root = join(WORK, 'root');
  mkdirSync(root, { recursive: true });
  cpSync(join(REPO, 'server'), join(root, 'server'), { recursive: true });
  // `web` is copied where the other two are symlinked, and the difference is not
  // cosmetic: the namespace-shadowing row plants files under it, and a symlink
  // would put those in the repo's own web/. A proof tool that writes into its
  // subject makes every later run untrustworthy, which is the same reason
  // mutations run against a staged copy rather than an edit-and-restore. It is
  // 312K, so the isolation costs nothing worth counting.
  cpSync(join(REPO, 'web'), join(root, 'web'), { recursive: true });
  // The looks that ship, copied where `--builtin-presets` points the mac server. Out
  // of the staged tree on purpose: it makes the fork rows independent of whether the
  // server happened to resolve its default correctly, which is a different claim, and
  // it means those rows are driving the flag rather than the fallback.
  cpSync(join(REPO, 'presets-builtin'), join(WORK, 'builtin-presets'), { recursive: true });
  // **And a second copy inside the staged tree, where the default resolves to.** The
  // copy above is deliberately outside it so the fork rows drive the flag rather than
  // the fallback, and that is still true - but it left every server spawned *without*
  // the flag resolving `presets-builtin` to a path in the staged root that nothing had
  // put there. That was invisible while a missing shipped-looks directory answered an
  // empty list, and it stopped being invisible the moment the store started reporting
  // it: the replay server, which names no preset flags at all, began answering 500 on
  // `/presets` and the viewer logged a page error. A staged tree is supposed to be an
  // install, and an install has the looks that ship in it.
  cpSync(join(REPO, 'presets-builtin'), join(root, 'presets-builtin'), { recursive: true });
  for (const name of ['node_modules', 'vendor']) {
    const from = join(REPO, name);
    if (existsSync(from) && !existsSync(join(root, name))) symlinkSync(from, join(root, name));
  }
  // **This is the one place a mutation is delivered, whichever side of the wire it is
  // on**, and it is worth saying how it got here because the two halves arrived a
  // release apart and the seam between them was a hazard rather than a redundancy.
  //
  // Server mutations were always staged. Page mutations were fulfilled by a Playwright
  // route interception in `openPage`, matched on a URL. `web/format.js` is what made
  // that untenable: `server/library.js` imports it by path - which is the entire reason
  // the constant lives under `web/`, since the browser can only reach what the server
  // serves and Node has no such constraint - so a mutation of it reached the page and
  // not the server, which went on deciding `openable` on the unmutated band. That
  // control reddened the page's rows and left the server's green, reading as a check
  // having found a partial break in the product rather than as the harness having broken
  // half the build.
  //
  // Staging everything fixed that and made the interception redundant in the same
  // breath, which is the state this replaces: `WEB_DIR` is `join(ROOT, 'web')` and
  // `web/` is copied here, so the staged file *is* what the server serves. Two
  // mechanisms delivering the same bytes is not defence in depth - it is a rule with
  // nothing measuring it, since no mutation can reach one without the other covering,
  // and the interception's own failure mode was silence: matched on a URL, it could
  // match nothing, load the unmutated page, and be recorded as this tool having missed a
  // bug it was never shown. `requireMutationDelivered` replaces it with the opposite
  // shape - it asks the server what it serves and stops the run when the answer is not
  // this file.
  //
  // Both roots here are copies, so this writes into the scratch tree and never into the
  // subject - the reason a mutation is a file in a staged tree rather than an edit
  // restored afterwards, which would leave a mutated working tree behind any crash.
  if (mutation) {
    writeFileSync(join(root, mutation.file), mutation.body);
  }
  return root;
}

const servers = [];
// Servers whose offset has since been claimed by another section. They are off `servers`
// so that a lookup by port answers with whoever is on it, and they are still here so the
// exit backstop has a list to walk rather than an argument to follow.
const retired = [];
// **Everything this run started, which is what anything sweeping rather than looking up
// wants.** Splitting the list gave the *lookups* a right answer and quietly gave the
// *sweeps* a short one: the end-of-run fatal-log scan read `servers` alone, so a server
// whose offset was later reused - three of them on a full run - could log `cannot open`
// and have it dropped from the verdict. A named set rather than `[...servers, ...retired]`
// spelled at each site, because the sites are two today and the bug was one of them being
// forgotten. `sweptEverything` below asserts this is still all of them.
const everyServer = () => [...servers, ...retired];
let serversStarted = 0;

/** Whether something already holds a port, asked of the kernel rather than of a fetch. */
const portHeld = (port) => new Promise((done) => {
  const sock = createConnection({ host: '127.0.0.1', port });
  const settle = (held) => { sock.destroy(); done(held); };
  sock.on('connect', () => settle(true));
  sock.on('error', () => settle(false));
  setTimeout(() => settle(false), 400);
});

/**
 * Refuses the run when any port this suite will bind is already taken.
 *
 * Up front and for the whole span, because the alternative is discovering it in section
 * 9 with the previous eight sections' claims already printed - and discovering it as a
 * wrong answer rather than as an error, since a stranger on the port answers the health
 * check. Exit 2 rather than 1: this is the suite declining to run, not a claim failing.
 */
async function reservePorts() {
  // **The node's port inside the mac span is a configuration this cannot serve**, and the
  // `new Set` below used to swallow it: both ports are free, every check passes, and the
  // run starts. The node comes up on it first and is still live when a section reaches
  // that offset, so the claim-a-taken-offset path in `startServer` retires a server that
  // is *running* - the replacement then dies on EADDRINUSE and the run ends on an error
  // about a port, several sections in, naming neither the overlap nor the node.
  //
  // Refused here instead, because it is a fact about the arguments and can be known before
  // anything spawns. Exit 2 with the other refusals: the suite declining to run.
  if (NODE_PORT >= MAC_PORT && NODE_PORT <= MAC_PORT + PORT_SPAN) {
    console.error(`[library] refusing to run: --node-port ${NODE_PORT} is inside the mac span `
      + `${MAC_PORT}..${MAC_PORT + PORT_SPAN}, so the node and a section would claim one port.`);
    console.error('[library] pass two ranges that do not overlap - the node needs one port and the mac side needs '
      + `${PORT_SPAN + 1} from --mac-port.`);
    process.exit(2);
  }
  const wanted = [NODE_PORT, ...Array.from({ length: PORT_SPAN + 1 }, (_, i) => MAC_PORT + i)];
  const held = [];
  for (const port of new Set(wanted)) if (await portHeld(port)) held.push(port);
  if (held.length === 0) return;
  console.error(`[library] refusing to run: ${held.join(', ')} already ${held.length === 1 ? 'has' : 'have'} a listener.`);
  console.error(`[library] this suite binds ${NODE_PORT} and ${MAC_PORT}..${MAC_PORT + PORT_SPAN}, all of which have to be free.`);
  console.error('[library] another worktree is the usual cause - pass --node-port and --mac-port a range nothing else holds.');
  process.exit(2);
}

async function startServer(root, args, port) {
  // A port outside the declared span would not have been checked by `reservePorts`, so
  // it is the one thing that could still attach to a stranger. Caught here rather than
  // trusted, which is what makes adding a section at `+17` a failure instead of a
  // silent hole.
  if (port !== NODE_PORT && (port < MAC_PORT || port > MAC_PORT + PORT_SPAN)) {
    throw new Error(`port ${port} is outside the reserved span ${MAC_PORT}..${MAC_PORT + PORT_SPAN}: `
      + 'raise PORT_SPAN and the note beside it, or this server is one nothing checked was free');
  }
  // **An offset this run has used before belongs to whoever is on it now**, and the entry
  // for the last holder is dropped rather than left beside the new one. Sections reuse an
  // offset on purpose - `+14` is a broken-preset server long after the rename server on it
  // has been killed - and two entries for one port make every `servers.find((s) => s.port
  // === n)` in this file answer with whichever was pushed first, which is the dead one.
  //
  // That is not hypothetical either: it read `0 exits` off a killed server's log while the
  // live one under test had died twenty-two times, and reported three rows about a
  // supervisor that was working. The reading was wrong rather than the code, which is the
  // worst way for a proof tool to be wrong - so the ambiguity is removed rather than
  // documented.
  //
  // Replaced and not refused, because two *live* servers on one port is a case the kernel
  // already rules out: the second would fail to bind, and the exit-instead-of-listening
  // throw below is what says so. Reaching here at all means the last holder let the port
  // go, which is the definition of it being the last one.
  // Retired rather than forgotten. Every stop in this file is a SIGKILL, so the dropped
  // child is genuinely dead and killing it again would be a no-op - but the exit backstop
  // below exists because a server this run leaks holds its port and turns every later run
  // in every worktree into an exit 2 naming an owner nobody can find, and "it is dead
  // because every current caller kills it" is a reasoning step standing where a list
  // would do.
  const stale = servers.findIndex((s) => s.port === port);
  if (stale !== -1) retired.push(...servers.splice(stale, 1));
  const child = spawn(process.execPath, [join(root, 'server/index.js'), '--port', String(port), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (c) => log.push(c.toString()));
  child.stderr.on('data', (c) => log.push(c.toString()));
  // **Our own child failing is a different answer from nothing listening yet.** Without
  // this the loop below polls on after an `EADDRINUSE` exit until something else
  // answers, and then returns that something else's URL.
  let exited = null;
  child.on('exit', (code, signal) => { exited = signal ?? code; });
  servers.push({ child, log, port });
  serversStarted++;
  for (let i = 0; i < 200; i++) {
    await new Promise((done) => { setTimeout(done, 100); });
    if (exited !== null) {
      throw new Error(`the server this run spawned on ${port} exited (${exited}) instead of listening, `
        + `so anything answering there is not ours:\n${log.join('')}`);
    }
    try {
      const res = await fetch(`http://localhost:${port}/library/takes`);
      if (res.ok) return `http://localhost:${port}`;
    } catch { /* not listening yet */ }
  }
  throw new Error(`server on ${port} never came up:\n${log.join('')}`);
}

function stopServers() {
  for (const { child } of everyServer()) child.kill('SIGKILL');
}

// **The backstop for every way out that does not reach the `finally`.** A spawned server
// is not killed by its parent leaving - it is reparented and goes on holding the port -
// and this suite is the one thing that cannot survive that, because `reservePorts` asks
// the kernel and refuses, so one orphan turns every later run in every worktree into an
// exit 2 naming a port nobody can find the owner of. The `finally` at the foot covers the
// checks; it does not cover the refusal in `requireMutationDelivered`, a `startServer`
// that throws with the node server already up, or a `chromium.launch` that fails before
// the `try` is entered. Registered here rather than at each of those, because the list is
// the wrong thing to maintain - the next exit added below is covered by existing.
// Synchronous, which `exit` requires, and killing an already-dead child is a no-op, so it
// costs nothing on the path that did run the `finally`.
process.on('exit', stopServers);

/**
 * Refuses the run when a page mutation did not reach the browser, and it is exit 2
 * rather than a failed assertion.
 *
 * **The direction matters more than the check.** A mutation that never arrived leaves
 * the unmutated page under test, every row passes, and the run is recorded as this tool
 * having missed a bug it was never shown - which is the same silence
 * `mutatedSource`'s match-exactly-once refusal exists to break one layer up, arriving
 * through the delivery instead of through the anchor. Counted as a failed assertion it
 * would be worse than nothing, because a suite that fails one row on a mutation run
 * reads as a catch. So this is the harness declining to run, which is what 2 means
 * everywhere else in the suite.
 *
 * Asked of the server over HTTP rather than of the staged file on disk, because the
 * disk is the half already known to be true - `stageServer` just wrote it - and the
 * question is whether that file is what a browser asking for this page receives. The
 * two come apart exactly where the URL is not the filename, which is the case that
 * produced this paragraph.
 */
async function requireMutationDelivered(base) {
  if (!pageMutation) return;
  const file = pageMutation.file.slice('web/'.length);
  const url = `${base}${urlForPageFile(file)}`;
  let served = null;
  let status = null;
  try {
    const res = await fetch(url);
    status = res.status;
    served = await res.text();
  } catch (err) {
    served = null;
    status = err.message;
  }
  // `Buffer.byteLength` and not `.length`, because a JavaScript string is counted in
  // UTF-16 code units and every page here is served as UTF-8: `library.html` is 25,206
  // bytes and 25,187 units, so the shorter number printed under the word *bytes* is one
  // nothing on the wire ever measured. The comparison above stays a string compare - the
  // round trip through UTF-8 is exact, so it already answers the question - and it is only
  // the evidence that had to stop mislabelling itself.
  if (served === pageMutation.body) {
    console.log(`[library] ${MUTATE} delivered: ${url} serves the mutated ${file} (${Buffer.byteLength(served)} bytes)`);
    return;
  }
  console.error(`[library] refusing to run: ${MUTATE} edits web/${file} and ${url} did not answer with it.`);
  console.error(`[library] the server answered ${status} with ${served === null ? 'nothing' : `${Buffer.byteLength(served)} bytes`}, `
    + `where the staged file is ${Buffer.byteLength(pageMutation.body)}.`);
  console.error('[library] a page mutation that does not arrive leaves the unmutated page under test and every row '
    + 'passing, which reads as this tool having missed a bug it was never shown - so the run stops here rather than '
    + 'reporting one. Either the page moved to a URL PAGE_URLS does not name, or the server stopped serving it.');
  process.exit(2);
}

/**
 * Waits until a frame has actually come off the sensor, and answers how long it took.
 *
 * **The socket, because nothing over HTTP says this.** `/record/state` reports armed
 * and recording, which are what the operator asked for rather than what the sensor is
 * doing, and a wait written against them is a wait on the wrong quantity - section 4c
 * had one keyed on `armed === false`, true from boot, which granted a fixed 255ms
 * while claiming to wait for the hello. A binary message on the live channel is a
 * frame that was captured, parsed and fanned out, which is the condition the sections
 * that call this actually need.
 */
async function liveFrame(url, timeoutMs = 20000) {
  const began = Date.now();
  const ws = new WebSocket(url.replace('http', 'ws'));
  try {
    await new Promise((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`no frame from ${url} within ${timeoutMs}ms`)), timeoutMs);
      const finish = (err) => { clearTimeout(timer); if (err) fail(err); else done(); };
      ws.on('message', (data, isBinary) => { if (isBinary) finish(); });
      ws.on('error', finish);
      ws.on('close', () => finish(new Error(`the live channel on ${url} closed before a frame arrived`)));
    });
  } finally {
    ws.close();
  }
  return Date.now() - began;
}

/**
 * A real filesystem with a few megabytes on it, or null where this tool does not
 * know how to make one.
 *
 * Real rather than simulated, because the claim is about what `statfs` says and a
 * number this tool handed the server would be testing its own arithmetic. macOS
 * only for now - `hdiutil` needs no privileges and takes about 1.3 seconds, where
 * the Linux equivalents all want root.
 */
async function smallFilesystem() {
  if (process.platform !== 'darwin') return null;
  const image = join(WORK, 'nearly-full.dmg');
  const mount = join(WORK, 'nearly-full');
  try {
    execFileSync('hdiutil', ['create', '-size', '8m', '-fs', 'APFS', '-volname', 'librarycheck', '-quiet', '-ov', image]);
    execFileSync('hdiutil', ['attach', image, '-mountpoint', mount, '-nobrowse', '-quiet']);
  } catch (err) {
    console.log(`  ...  no small filesystem: ${err.message.split('\n')[0]}`);
    return null;
  }
  return {
    mount,
    release() {
      try {
        execFileSync('hdiutil', ['detach', mount, '-quiet']);
      } catch {
        // Forced only as a second attempt: a volume still held by a process that has
        // not quite exited detaches a moment later, and forcing first would hide a
        // server this tool failed to stop.
        try { execFileSync('hdiutil', ['detach', mount, '-force', '-quiet']); } catch { /* gone already */ }
      }
    },
  };
}

/**
 * Whether a line in a server's log means this run went wrong.
 *
 * **The generic pattern cannot see the recorder's fatal line, and the allowlist was
 * hiding it twice over.** `!/refus|cannot open/i` dropped
 * `[recorder] cannot open <path>: <errno> - recording is off`, which is the single
 * message meaning a shooting node stopped - and it would have been dropped anyway,
 * because every errno that produces it (ENOSPC, EACCES, ENOENT, ENOTDIR) spells out
 * a message containing neither "Error" nor "throw" nor "unhandled". So removing it
 * from the allowlist is not enough; the line needs a pattern of its own.
 *
 * `recording is off` is that pattern, and it is the right one rather than a
 * convenient one: it is the phrase all three recorder failures end with - the open
 * that could not happen, the write that died mid-take, and the names that ran out -
 * and every one of them means footage stopped being written on a machine that
 * believed it was shooting.
 *
 * The two benign lines are anchored to their prefixes instead of matched by
 * substring, so `[server] cannot open` stays benign while `[recorder] cannot open`
 * does not.
 */
const BENIGN_LOG = [
  /^\[server\] cannot open /, // the replay reader saying the file it was pointed at is not there
  /refusing to start a take/, // the low-space gate, which is a decision rather than a failure
];
const FATAL_LOG = [
  /Error|throw|unhandled/i,
  /recording is off/, // every recorder failure ends here, and none of them says "Error"
  /no free take name/,
];
const looksFatal = (line) => FATAL_LOG.some((re) => re.test(line)) && !BENIGN_LOG.some((re) => re.test(line));

// The predicate's own falsification control, run before anything else so a sweep
// that has been quietly blinded says so in the first three lines rather than by
// passing a mutated tree. Every case here is a real line one of these servers emits.
function checkLogPredicate() {
  console.log('\n[library] the log sweep can see the line that matters');
  const cases = [
    ['[recorder] cannot open /caps/2026-07-31-take1.knct: ENOSPC: no space left on device - recording is off', true],
    ['[recorder] cannot open /caps/x.knct: EACCES: permission denied, open \'/caps/x.knct\' - recording is off', true],
    ['[recorder] take 2026-07-31-take2 failed mid-write: EIO: i/o error - recording is off', true],
    ['[recorder] no free take name after 64 tries - recording is off', true],
    ['[server] capture request failed: Error: short read at 4096', true],
    ['[server] cannot open /nope/missing.knct: ENOENT: no such file or directory', false],
    ['[recorder] refusing to start a take: 8s left at current settings, under the 2m minimum', false],
    ['[recorder] 2026-07-31-take1 is already taken, trying the next name', false],
    ['[server] 24.8 fps  12.2 MB/s  dropped=0  clients=1', false],
    ['[recorder] take 2026-07-31-take3 open', false],
  ];
  const wrong = cases.filter(([line, want]) => looksFatal(line) !== want);
  check(wrong.length === 0,
    'the sweep flags every recorder line that means a shooting node stopped, and none of the ordinary ones',
    wrong.length ? wrong.map(([l]) => l.slice(0, 52)).join(' | ') : `${cases.length} lines, ${cases.filter((c) => c[1]).length} fatal`);
  // Named on its own, because this is the one the old predicate dropped and the
  // reason it dropped it was two independent failures agreeing.
  check(looksFatal('[recorder] cannot open /caps/take1.knct: ENOTDIR: not a directory - recording is off'),
    'including `[recorder] cannot open`, which the old allowlist excluded by name and the old pattern could not have matched anyway');
}

const getJson = async (url, init) => (await fetch(url, init)).json();
// The method is a parameter because the document routes take three of them and the
// difference is the behaviour under test: a PUT to a shipped preset's name has to fork
// it and a DELETE of the fork has to bring the shipped one back, and neither claim can
// be made through a helper that can only POST.
const post = (url, body, method = 'POST') => getJson(url, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

// ------------------------------------------------------------------- playwright

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch { /* no global npm root: the local resolve below may still work */ }
  const candidates = [async () => import('playwright')];
  for (const root of roots) {
    for (const name of ['playwright', '@playwright/cli/node_modules/playwright']) {
      candidates.push(async () => import(pathToFileURL(require.resolve(join(root, name))).href));
    }
  }
  for (const load of candidates) {
    try {
      const mod = await load();
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  throw new Error('playwright not found - install it globally or in this project');
}

/**
 * Playwright drops the page's execution context on this rig, and it is not the
 * code: `docs/instruments.md` records it as a measured flake, with the server log
 * showing the work it happened during completing normally. Retried on that signature
 * alone and with the retry count printed, because a check that retried real failures
 * would report whichever attempt it liked.
 */
async function retryOnContextLoss(label, work) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await work();
    } catch (err) {
      // **Two messages, because the renderer going away here arrives under both.**
      // `Execution context was destroyed` was the one this was written for, and
      // `Resulting promise was garbage collected` is what Playwright says when the
      // page is torn down while an `await page.evaluate` of an async function is
      // outstanding - which is this call, since it awaits a fetch inside the page.
      // Measured on one sweep of nine mutation runs: five died here, all five on the
      // second message, all five with the mutation's own rows already correctly red.
      // A run that ends at 198 of 317 assertions has left a third of its claims
      // untested while exiting non-zero, which reads as a mutation caught rather than
      // as a harness that stopped - the failure mode this file's own header warns
      // about, arriving through the retry's pattern instead of through an anchor.
      //
      // Both are renderer lifetime rather than anything under test: neither can be
      // produced by a wrong answer, only by the page ceasing to exist. A retry that
      // covered a real failure would report whichever attempt it liked, which is why
      // this stays two exact strings rather than becoming a catch-all.
      const lost = /Execution context was destroyed|Resulting promise was garbage collected/.test(String(err));
      if (!lost || attempt === 3) throw err;
      console.log(`  ...  ${label}: the page went away, retrying (attempt ${attempt + 1} of 3)`);
    }
  }
  throw new Error('unreachable');
}

// The three pages, named once each rather than at the eight call sites below. `/`
// served the recorder, `/?take=` the editor and `/library.html` the gallery until the
// main menu took `/`, and a path spelled at every call site is eight chances to leave
// one behind - where the failure is silent for thirty seconds and then loud about the
// wrong thing, because the menu page defines neither `__kinect` nor `__library` and
// every wait below is for one of those.
const recorderPage = (base) => `${base}/record`;
const editorPage = (base, take) => `${base}/edit?take=${encodeURIComponent(take)}`;
const galleryPage = (base) => `${base}/gallery`;

async function openPage(browser, url, viewport = { width: 1100, height: 760 }) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { page, errors };
}

// ============================================================================ run

console.log(`[library] ${MUTATE ? `MUTATED: ${MUTATE} (${mutation.file})` : 'unmutated tree'}`);

await reservePorts();
const { nodeCaps, macCaps } = buildFixture();
const root = stageServer();
const nodeUrl = await startServer(root, ['--captures', nodeCaps, '--name', 'pi-01',
  '--presets', join(WORK, 'node-presets'), '--projects', join(WORK, 'node-projects')], NODE_PORT);
// `--builtin-presets` named explicitly rather than left to resolve beside the staged
// server, and for two reasons. It points the shipped-look rows at the repo's own
// `presets-builtin/`, so they sweep the looks the product offers rather than a copy
// that could have been staged wrong - the "compare what the tool tests against what
// the product ships" rule. And it is the only caller of the flag: a flag whose sole
// mention is the comment introducing it is a flag nothing proves does anything.
const macUrl = await startServer(root, ['--captures', macCaps, '--name', 'mac',
  '--node', nodeUrl, '--node-name', 'pi-01',
  '--presets', join(WORK, 'presets'), '--projects', join(WORK, 'projects'),
  '--builtin-presets', join(WORK, 'builtin-presets')], MAC_PORT);

// When this process last had a server with no sensor come up. Read by the sensor-health
// section far below, which asserts that a five-second window closes at five seconds
// rather than growing for as long as the sensor is away - and "rather than" needs the
// number it is not, or the row is a threshold with nothing behind it. Stamped here and
// not after the delivery check below, because the number it stands for is when the
// server started, and a refusal that spends seconds fetching a page would otherwise be
// subtracted from an uptime that did include it.
const bootedAt = Date.now();

// Before a browser opens anything, so a mutation that cannot arrive costs a server spawn
// rather than a full run ending in a verdict about the wrong build. One server answers
// for all of them: every server this suite spawns is spawned out of `root`, which is the
// tree `stageServer` wrote the mutation into.
await requireMutationDelivered(macUrl);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: !HEADED, args: ['--use-gl=angle', '--use-angle=default'] });

try {
  await runChecks();
} catch (err) {
  // Recorded rather than thrown. An exception out of here used to end the process
  // with no verdict line and no assertion count - which reads as a caught mutation
  // to anything counting exit codes and as nothing at all to anything counting rows.
  // Several of this step's own mutations end in a server that has died, and a dead
  // server is a failure this tool has to be able to *say*.
  console.log(`\n  FAIL  the run did not finish: ${err.message}`);
  assertions++;
  failures++;
} finally {
  await browser.close();
  stopServers();
}

// The verdict, and a skipped claim reaches all three of it: the count line, the
// word, and the status this process exits with.
//
// It used to reach only the count line. On any platform that cannot make a small
// filesystem - which is every platform but this one - the run printed an
// unqualified `[library] PASS` and exited 0 with the low-space refusal never
// exercised, so "it never silently passes" was a claim about macOS being read as a
// claim about the tool. A CI job checks the exit code and nothing else, so the
// status is where it has to land.
//
// Code 2 rather than 1, because "some claims were not tested here" and "a claim
// failed" are different answers and collapsing them would make an unprovable
// platform look like a broken build. Anything checking `!== 0` now treats a run with
// an unproven claim as not-a-pass, which is the intended reading.
const note = skipped.length ? `, ${skipped.length} claim${skipped.length === 1 ? '' : 's'} unproven here (${skipped.join(', ')})` : '';
if (failures) console.log(`\n[library] ${assertions} assertions, ${failures} failed${note}`);
else console.log(`\n[library] ${assertions} assertions, none failed${note}`);
const verdict = failures ? `FAIL (${failures})`
  : skipped.length ? `PASS WITH ${skipped.length} CLAIM${skipped.length === 1 ? '' : 'S'} UNPROVEN HERE (${skipped.join('; ')})`
    : 'PASS';
console.log(`[library] ${verdict}`);
process.exit(failures ? 1 : skipped.length ? 2 : 0);

async function runChecks() {
  checkLogPredicate();

  // ------------------------------------------------- 0. one grid, one declaration
  //
  // **The sensor grid is one number in one file, and this asks the tree rather than
  // the four places it used to be written.** It was declared four times in
  // JavaScript - twice inside `web/main.js` alone, under two different names 1,646
  // lines apart - and spelled out as bare literals a fifth time in the monitor's cost
  // line, under a comment promising the number was stated from the grid so it could
  // not drift. Nothing had bitten yet, which is the only reason this is a row and not
  // a bug report.
  //
  // It walks the directories rather than a list of the files that hold it today, so a
  // page or a server module added next year is asked by existing - the close-the-class
  // rule, where the enumeration *is* the check. Scoped to `web/` and `server/` and
  // deliberately not to `tools/`: every proof tool here states the grid independently,
  // and that is correct rather than sloppy, because a check that imported the constant
  // it asserts would be holding a `512` against itself.
  //
  // **It recurses, and the first spelling of it did not.** `web/` and `server/` are flat
  // today, so a walk of their direct children found every file there is and read as a
  // walk of the tree - with a `continue` on a directory that would have skipped the
  // first subdirectory anybody made, silently, leaving a module free to redeclare the
  // grid under a row still printing green. That is the close-the-class rule failing in
  // the shape it is meant to catch: the enumeration was the files that exist rather
  // than the tree, and nothing about the row said which.
  //
  // **Each dimension asked for separately, because one regex over both cannot see one
  // of them go missing.** A single `512|424` alternation answers "does this file
  // mention the grid", and `web/format.js` mentions it as long as *either* number is
  // still there - so a `DEPTH_H` that stopped being a literal, or drifted off 424 while
  // `DEPTH_W` held, leaves the holder list reading exactly `['web/format.js']` and the
  // row green over a build whose JavaScript no longer describes the sensor's frames.
  // The duplication half was never at risk, since a file redeclaring either number
  // lands in the list; it is the row's other half - its own failure message says "a
  // grid that went missing" - that only fired when both went at once.
  console.log('\n[library] the sensor grid is declared once, and the tree is what says so');
  {
    // **Every numeric literal, compared by value**, which `numbersIn` above is the scan
    // for. The first spelling of this searched for the decimal digits with guards either
    // side - `(?<![\d.])512(?![\d.])`, which keeps `512` out of `1512` and `4.24` - and
    // that is a matcher for one *spelling* of a number wearing the name of the number. A
    // module redeclaring the width as `512.0` is rejected by the trailing guard, `0x200`
    // and `5.12e2` are never looked at, and each of them is a second declaration of the
    // grid sitting under a row reporting one. The guards stopped being needed with the
    // comparison by value, because `1512` is one token and answers 1512.
    //
    // Bounded on purpose, and the boundary is where a reader would otherwise assume more:
    // this sees a literal in any spelling and does not see an *expression* that computes
    // the value. `256 * 2` is invisible to it and so is `DEPTH_W - 88`, which is what
    // `grid-loses-a-dimension` plants - that mutation is a control for the missing-grid
    // half of the row below rather than for this. A declaration written as arithmetic is
    // outside what this claims, and saying so is the difference between a bound and a
    // hole.
    //
    // Legacy octal - `01000`, which is 512 - **is** read, and this paragraph used to say
    // the opposite: that the form could be ignored because a module makes it a SyntaxError
    // and every file walked is a module. The second half stopped being true the day this
    // began reading `<script>` bodies, because an untyped script is a classic script and
    // classic scripts are sloppy mode. `numbersIn` handles it, and the case file records
    // that the sentence outlived its reason by one commit.
    const declares = (source, n) => numbersIn(source).includes(n);

    // **The JavaScript in a file, because this is a claim about JavaScript.** The walk
    // reaches every file under `web/` and `server/`, which is three HTML pages and a
    // stylesheet as well as the modules - and asking "is 512 a literal here" of markup
    // answers about prose and layout. A `width: 512px` in `nav.css`, or a paragraph in
    // `index.html` mentioning a 424-line budget, is not a second declaration of the
    // sensor's grid, and a row that failed on one would be blocking a copy change with a
    // proof failure. Bad in both directions, too: the alternative of trusting it makes
    // every future stylesheet a place the grid can hide.
    //
    // Restricting the *walk* to `.js` would close it by opening a hole, because the pages
    // here carry real code - `menu.html` holds `resolveResume` inline, which is a module
    // this suite mutates. So the walk stays wide and the question narrows: the whole of a
    // module, and the `<script>` bodies of a page.
    //
    // **Typed scripts are excluded by type and not by looking like data.** `index.html`
    // carries an importmap, which is JSON in a `<script>` tag - a version string in it is
    // not a declaration of anything, and it is skipped because its `type` says it is not
    // JavaScript rather than because this guessed.
    //
    // **The list is HTML's and not a shape**, which is the correction: the first spelling
    // matched `(text|application)/(java|ecma)script` and that is four of the sixteen
    // essences the spec calls a JavaScript MIME type. A page written with
    // `application/x-javascript` runs, and its body was being discarded - executable
    // JavaScript dropped from a row about what the JavaScript declares, silently, which is
    // the direction a missing spelling always fails in. There is no pattern behind the
    // sixteen; `text/livescript` and `text/jscript` are there for reasons that are
    // twenty-five years old, so the enumeration *is* the definition and a regex over it
    // was a guess at one.
    //
    // Parameters are stripped before the comparison because the spec matches the essence,
    // and that is also the safe way to be wrong: a `text/javascript; charset=utf-8` block
    // read as JavaScript is scanned, and scanning something that is not code over-reports
    // loudly, where skipping something that is code goes unseen.
    const JS_MIME = new Set([
      'application/ecmascript', 'application/javascript', 'application/x-ecmascript',
      'application/x-javascript', 'text/ecmascript', 'text/javascript', 'text/javascript1.0',
      'text/javascript1.1', 'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4',
      'text/javascript1.5', 'text/jscript', 'text/livescript', 'text/x-ecmascript',
      'text/x-javascript',
    ]);
    // **An unquoted attribute value ends at whitespace, and reading it to the `>` swallows
    // the attributes after it.** `<script type=text/javascript defer>` is valid markup that
    // every browser runs, and a capture stopping only at a quote or a bracket answered
    // `text/javascript defer`, which is in no list of anything - so the body was dropped.
    // The three quoting forms are matched as three alternatives rather than by stripping
    // afterwards, because a quoted value may legitimately contain a space and an unquoted
    // one may not, and that is exactly the difference a shared pattern cannot carry.
    // **A start tag ends at the first unquoted `>`.** Reading to the first `>` of any kind
    // ends the tag inside `<script data-note=">">`, which leaves the attribute's closing
    // quote at the head of the body - so the scan opens a string on it, runs to the next
    // quote, and eats the declaration behind it. Quoted runs are matched as units for the
    // same reason the type attribute is: a quoted value may contain the character that
    // would otherwise terminate what it sits in.
    const SCRIPT = /<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/script>/gi;
    // **Anchored on an attribute boundary and not on `\b`**, because a word boundary sits
    // between `-` and `type` as happily as it sits after `<script`. A page carrying
    // `<script data-type="application/json">` has no `type` attribute at all, so the
    // browser runs its body as a classic script - and the match found `data-type`, read
    // JSON, and dropped it. An attribute starts at whitespace or at the start of the
    // attribute list, and nowhere else.
    const TYPE_ATTR = /(?:^|\s)type\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]*))/i;
    const isJs = (attrs) => {
      const m = TYPE_ATTR.exec(attrs);
      const type = (m?.[1] ?? m?.[2] ?? m?.[3] ?? '').trim().toLowerCase();
      if (!type || type === 'module') return true;
      return JS_MIME.has(type.split(';')[0].trim());
    };
    const javascriptIn = (rel, source) => {
      if (rel.endsWith('.js') || rel.endsWith('.mjs')) return source;
      if (!rel.endsWith('.html')) return '';
      return [...source.matchAll(SCRIPT)].filter((m) => isJs(m[1])).map((m) => m[2]).join('\n');
    };
    const GRID = [['the depth width', 512], ['the depth height', 424]];
    // Relative paths under `base`, deepest last, as one flat list. Split out from the
    // row below so the falsification control underneath can run the same walker over a
    // tree it built, which is the only way to hold a traversal to its claim - a
    // recursion bug in this loop is invisible against a directory that has nothing in
    // it to recurse into.
    const sourcesUnder = (base, dir, prefix = '') => readdirSync(join(base, dir), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => (entry.isDirectory()
        ? sourcesUnder(base, `${dir}/${entry.name}`, `${prefix}${entry.name}/`)
        : [`${dir}/${entry.name}`]));

    // The control, run before the row it controls: a tree whose grids are one directory
    // down, one dimension per file. A walker that skips directories answers `[]` here
    // and this goes red, where against the real `web/` and `server/` it would answer
    // exactly what the rows below want and pass. Separate files rather than one so the
    // per-dimension search is exercised separately as well - a probe that planted both
    // numbers together would be answered by either of them. Built under
    // `.library-check` and left there with the rest of the run's scratch.
    //
    // **Each dimension is planted twice, once in decimal and once in a spelling that is
    // the same number**, because the walk is not the only thing this arm holds - it is
    // also the only control the matcher has, and a matcher that reads digits passes a
    // probe written in digits. Hex for the width and scientific notation for the height,
    // so a matcher handling one spelling and not the other reddens one row rather than
    // being covered by the dimension it does handle.
    //
    // And a file of near misses, which is what stops the value comparison from being
    // *looser* than the regex it replaced: `1512` and `4.24` are the two the old guards
    // existed for, and `0x201` is the same trap one spelling along. The rows below assert
    // the whole matched list rather than membership in it, so this file appearing in one
    // is a failure without needing a row of its own.
    const probeRoot = join(REPO, '.library-check', 'grid-probe');
    rmSync(probeRoot, { recursive: true, force: true });
    mkdirSync(join(probeRoot, 'web', 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(probeRoot, 'web', 'flat.js'), 'export const NOTHING = 1;\n');
    writeFileSync(join(probeRoot, 'web', 'near-misses.js'),
      'export const WIDE = 1512;\nexport const SMALL = 4.24;\nexport const HEX = 0x201;\n');
    writeFileSync(join(probeRoot, 'web', 'nested', 'buried.js'), 'export const W = 512;\n');
    writeFileSync(join(probeRoot, 'web', 'nested', 'hexadecimal.js'), 'export const W = 0x200;\n');
    // **Two forms that the scan needs a token for rather than a character.** `.512e3` is
    // 512 in the notation with no leading digit, and a scan entering only on a digit
    // cannot see it - a whole spelling in which a second grid ships under a green row.
    // `return /424/` is the other side: `return` ends in a letter, a letter ends a value,
    // and a value means the `/` is division, so the pattern gets read as code and its
    // digits reported. One file holds both, so it must land on the width list and not on
    // the height list - a scan that misses the first or falls for the second gets exactly
    // one of those wrong.
    writeFileSync(join(probeRoot, 'web', 'nested', 'edge-forms.js'),
      'export const W = .512e3;\n'
      + 'export const rows = () => { return /424/; };\n'
      // A postfix operator directly before a division, which is the other way the slash
      // question gets answered by a character instead of a token: `++` taken one `+` at a
      // time leaves the scan looking at an operator, an operator is not the end of a
      // value, and the division reads as a regex that swallows to the end of the line.
      // It sits in this file because that is the file whose 512 must be found - a scan
      // that swallows here loses the declaration two lines up as well.
      + 'export const step = (counter) => counter++ / 512;\n'
      // A finished regex divided by something, which is the third way the slash question
      // gets answered wrongly: the slash that *closed* a pattern is not the slash that
      // could open one, and treating it as the latter swallows what follows.
      + 'export const ratio = /x/ / 512;\n'
      // And a name the ASCII classes cannot finish reading. `π` is `ID_Continue`, so
      // `pixelsπ` is one identifier; a scan that stops at the `s` leaves the `π` standing
      // as punctuation, and the division behind it opens a regex over the number.
      + 'export const perRow = (pixelsπ) => pixelsπ / 512;\n');
    writeFileSync(join(probeRoot, 'web', 'nested', 'deeper', 'further.js'), 'export const H = 424;\n');
    writeFileSync(join(probeRoot, 'web', 'nested', 'deeper', 'scientific.js'), 'export const H = 4.24e2;\n');
    // **The literal text a module carries, which is the same fact as the paragraph in the
    // page one layer in.** An ordinary `throw new Error('expected 512 bytes')` is a
    // message and not a declaration, and a row that counted it would fail a clean suite
    // on a debug string. Every kind that can hold text is here because they are scanned
    // by different branches: a single-quoted string, a double-quoted one, an escaped
    // quote inside a string, a comment, and template text.
    //
    // **The last line is the one that has to be found**, and it is here because skipping
    // template *text* and skipping a template *expression* are one character apart in the
    // scan. `${}` is code by definition, so a declaration hiding in one is a declaration -
    // and a scan that swallowed the whole template would lose it silently, which is the
    // direction that does not announce itself.
    writeFileSync(join(probeRoot, 'web', 'nested', 'literals.js'),
      "export const A = 'expected 512 bytes';\n"
      + 'export const B = "a 424-line budget";\n'
      + "export const C = 'it\\'s 512 wide, they said';\n"
      + '// a comment saying 512 and 424\n'
      + 'export const D = `the grid is 512 by 424`;\n'
      + 'export const E = `computed ${424} rows`;\n');
    // A page and a stylesheet, which is what the tree actually holds beside the modules.
    // The page states both numbers three times over and only one of them is a
    // declaration: in prose, in a `<style>` rule, in an importmap that is a `<script>` of
    // the wrong type, and then in a module script, which is the one that counts. The
    // stylesheet states the height in a rule and must be found by nothing - a `424px`
    // column is a layout decision, and a row that called it a second grid would fail a
    // clean tree on a copy change.
    writeFileSync(join(probeRoot, 'web', 'page.html'),
      '<p>the sensor is 512 across and 424 down, which this paragraph says and does not declare</p>\n'
      + '<style>.tile { width: 512px; height: 424px; }</style>\n'
      + '<script type="importmap">{"imports":{"x":"/x-512-424.js"}}</script>\n'
      + '<script type="module">const W = 512;</script>\n');
    writeFileSync(join(probeRoot, 'web', 'sheet.css'), '.rail { height: 424px; width: 512px; }\n');
    // A second page whose executable code is under a `type` nobody writes any more and
    // every browser still runs, beside a block of JSON under a `type` that is not code at
    // all. It must be a holder of the height and not of the width, so a check that knows
    // only the four modern essences loses the first and a check that reads anything in a
    // `<script>` gains the second. The charset parameter is on it because the spec matches
    // the essence and a check comparing the whole attribute would drop this too.
    // The unquoted form with an attribute behind it is on the same page, because it fails
    // the same way and for the same reason - a value read past its end is a value that
    // matches nothing, and the body of a running script is dropped.
    // Four scripts and one of them is not code. The two below the first are the ways a
    // block that *runs* gets mistaken for one that does not: an attribute merely ending in
    // `type`, which a word boundary matches and an attribute boundary does not, and no
    // `type` at all, which is a classic script - sloppy mode, where `0650` is octal and
    // means 424. Every one of them declares the height, so the page has to hold it, and
    // the JSON block declares the width, so the page must not hold that.
    writeFileSync(join(probeRoot, 'web', 'legacy-page.html'),
      '<script type="application/x-javascript; charset=utf-8">const H = 424;</script>\n'
      + '<script type=text/javascript defer>const H2 = 424;</script>\n'
      + '<script data-type="application/json">const H3 = 424;</script>\n'
      + '<script>const H4 = 0650;</script>\n'
      // An attribute whose value contains the character that ends a start tag. A tag
      // matcher stopping at the first `>` of any kind hands the body a leading quote,
      // which opens a string that runs over the declaration behind it.
      + '<script data-note=">">const H5 = 424;</script>\n'
      + '<script type="application/json">{"width": 512}</script>\n');
    const walked = sourcesUnder(probeRoot, 'web');
    // Sorted per directory and depth-first, which is the order `sourcesUnder` produces
    // and the order these are written in.
    // **`literals.js` is on one list and not the other, which is the whole arm.** Its
    // 512s are all text - two strings, an escaped quote, a comment, a template - and its
    // 424 appears both as text and inside a `${}`. So a scan that reads strings puts it on
    // the 512 list and fails, and a scan that swallows template expressions takes it off
    // the 424 list and fails. One file, both directions.
    const WANT = {
      512: ['web/nested/buried.js', 'web/nested/edge-forms.js', 'web/nested/hexadecimal.js', 'web/page.html'],
      424: ['web/legacy-page.html', 'web/nested/deeper/further.js', 'web/nested/deeper/scientific.js',
        'web/nested/literals.js'],
    };
    for (const [what, n] of GRID) {
      const probed = walked.filter((rel) => declares(
        javascriptIn(rel, readFileSync(join(probeRoot, rel), 'utf8')), n,
      ));
      check(eq(probed, WANT[n]),
        `the walk this row uses reaches ${what} in every spelling and in a page's script, and in no string, comment, template text, stylesheet, paragraph or near miss`,
        probed.join(' ') || 'the walk found nothing');
    }

    // One row per dimension. The pair is what a grabber frame is, but "the grid is
    // declared once" is two claims and only one of them can be answered by a match on
    // either number.
    const holdersOf = (n) => ['web', 'server'].flatMap(
      (dir) => sourcesUnder(root, dir)
        .filter((rel) => declares(javascriptIn(rel, shippedSource(rel)), n)),
    );
    for (const [what, n] of GRID) {
      const holders = holdersOf(n);
      check(eq(holders, ['web/format.js']),
        `${n}, ${what}, is a literal in exactly one file across web/ and server/ however it is spelled, and it is web/format.js`,
        holders.join(' ') || `nothing holds ${n}, which is half a grid that went missing rather than a grid stated once`);
    }
  }

  // ------------------------------------------------------------- 1. the manifest
  console.log('\n[library] the manifest carries step 2\'s hash, and stops carrying a stale one');
  {
    const { buildIndex } = await import(pathToFileURL(join(REPO, 'server/capture.js')).href);
    const takes = (await getJson(`${macUrl}/library/takes`)).takes;
    const byId = Object.fromEntries(takes.map((t) => [t.id, t]));

    // The scan, run here, against the manifest the server produced. Not the
    // server's own answer read back - that would agree with itself whatever it did.
    let agreed = 0;
    for (const take of takes) {
      const scanned = await buildIndex(join(macCaps, take.file));
      if (scanned.hash === take.hash && scanned.frames.offset.length === take.frames) agreed++;
    }
    check(agreed === takes.length,
      `every take's manifest hash and frame count is what a fresh scan produces (${agreed}/${takes.length})`);

    // A take whose bytes changed. The sidecar on disk still says the old hash, so
    // this is exactly the case a cache that trusted itself would get wrong.
    const before = byId['same-name'].hash;
    // A whole extra frame rather than arbitrary bytes. The format is append-only,
    // so a take *growing* is the shape this actually happens in - a recorder still
    // writing while the gallery lists - and it leaves a file the scan can still
    // read, which is what makes the comparison below about the hash rather than
    // about a parse failure.
    appendFileSync(join(macCaps, 'same-name.knct'), SRC.frames[0]);
    const after = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'same-name');
    const rescanned = await buildIndex(join(macCaps, 'same-name.knct'));
    check(after.hash !== before, 'a take whose bytes changed is not served from a stale manifest',
      `${before.slice(7, 19)} then ${after.hash.slice(7, 19)}`);
    check(after.hash === rescanned.hash, 'and the hash it reports is the one the changed bytes actually have');

    // The shapes a gallery has to render rather than the ones it likes. Each of
    // these is a state the tile draws differently, and each was found by asking
    // what the interface can produce rather than what is convenient to build.
    check(byId['truncated-take'].truncated === true,
      'a take cut mid-frame is reported truncated - step 2 computed this flag and nothing read it until now');
    check(byId['local-clip'].truncated === false, 'and a whole take is not');
    check(byId['no-hello-take'].hasHello === false && byId['no-hello-take'].openable === false,
      'a take with no hello lists, and says it cannot be opened');
    check(byId['one-frame-take'].frames === 1 && byId['one-frame-take'].openable === false,
      'a one-frame take lists, and says it cannot be bracketed');
    check(byId['local-clip'].openable === true, 'and an ordinary take is openable');
    // The fixture the openability rows in section 6 rest on, asserted here rather than
    // assumed there: the truncation has to cut the single frame without cutting the
    // hello, and a sample regenerated at a different frame size could leave the frame
    // whole. A take that listed with one frame would send those rows looking at the
    // shape that never disagreed.
    check(byId['hello-no-frames'].hasHello === true && byId['hello-no-frames'].frames === 0,
      'a take can carry a hello and no whole frame at all, which is the shape the two client derivations disagreed about',
      `hasHello=${byId['hello-no-frames'].hasHello} frames=${byId['hello-no-frames'].frames}`);
    // The band, at the door the other three read. `format` is reported as the listing
    // found it rather than as a boolean, because the refusal has to be able to name the
    // generation - "unknown format" with no number is a sentence nobody can act on.
    check(byId['future-format-take'].format === CAPTURE_FORMAT + 1
      && byId['future-format-take'].openable === false,
      'a take from a format this build does not read lists, says which generation wrote it, and says it cannot be opened',
      `format ${JSON.stringify(byId['future-format-take'].format)}, openable ${byId['future-format-take'].openable}`);
    // The half that stops the band from being "refuse anything unfamiliar", which would
    // pass the row above while shutting every take on disk today out of the editor.
    check(byId['generation-zero-take'].format === null
      && byId['generation-zero-take'].openable === true,
      'while a take whose hello declares no format at all is generation zero and opens, which is the whole existing archive',
      `format ${JSON.stringify(byId['generation-zero-take'].format)}, openable ${byId['generation-zero-take'].openable}`);
    check(byId['local-clip'].format === null && byId['no-hello-take'].format === null,
      'and the field is null rather than absent on a take that carries no answer, so the page has one thing to read');
    // **The band arrives as a refusal and not only as a false `openable`**, which is the
    // half the three rows above cannot see: `openable` would read the same if the format
    // check had stayed a term in its own expression, and then the tile would have a dead
    // Open button and nothing on it saying why. The sentence is required to name the
    // generation, because a refusal reading "unknown format" with the number missing is
    // the exact shortening this branch removed from the page.
    const bandRefusals = byId['future-format-take'].openRefusals;
    check(bandRefusals.length === 1 && bandRefusals[0].key === 'format'
      && bandRefusals[0].why.includes(String(CAPTURE_FORMAT + 1)),
      'and it refuses under the format key, in a sentence that names the generation it found',
      JSON.stringify(bandRefusals));
    check(byId['generation-zero-take'].openRefusals.length === 0,
      'while the take the whole existing archive looks like carries no refusal at all',
      JSON.stringify(byId['generation-zero-take'].openRefusals));
    check(byId['local-clip'].dateSource === 'hello'
      && Math.abs(byId['local-clip'].capturedAt - Date.UTC(2026, 6, 15, 18, 5)) < 1,
      'the wall-clock capture date comes off the hello where the take carries one');
    check(byId['truncated-take'].dateSource === 'mtime',
      'and falls back to the file date where it does not, saying which it used');
    check(Math.abs(byId['local-clip'].marks.length) === 4, 'marks come with the take',
      `${byId['local-clip'].marks.length} on local-clip`);
    check(byId['same-name'].marks.length === 1 && byId['truncated-take'].marks.length === 0,
      'and the one-mark and no-mark cases are both real');
  }

  // ------------------------------------------------------- 2. reconciliation
  console.log('\n[library] one library, joined by content hash and never by name');
  {
    const lib = await getJson(`${macUrl}/library/all`);
    const byId = Object.fromEntries(lib.takes.map((t) => [t.id, t]));
    check(lib.node?.reachable === true, `the node is linked (${lib.node?.name})`);

    // The same bytes under two unrelated filenames.
    const shared = lib.takes.filter((t) => t.state === 'both');
    check(shared.length === 1 && shared[0].id === 'mac-name-for-it',
      'the same bytes under two different filenames are one take, in state both',
      shared.map((t) => t.id).join(' '));

    // The same filename holding different bytes.
    const sameName = lib.takes.filter((t) => t.id === 'same-name');
    check(sameName.length === 2 && new Set(sameName.map((t) => t.hash)).size === 2,
      'the same filename holding different bytes is two takes, not one',
      `${sameName.length} entries, ${new Set(sameName.map((t) => t.state)).size} states`);
    check(sameName.some((t) => t.state === 'local') && sameName.some((t) => t.state === 'remote'),
      'and they resolve to different states rather than collapsing');

    check(byId['local-clip'].state === 'local' && byId['node-name-for-it'] === undefined,
      'a take only here is local, and the node\'s name for a shared take is not a second entry');
    check(lib.takes.some((t) => t.state === 'remote'), 'a take only over there is remote');

    // Remaining time, reported as time. "94 GB free" is arithmetic under pressure.
    check(/^(\d+h \d+m|\d+m \d+s|\d+s|unbounded)$/.test(lib.storage.label),
      `remaining space is reported as time, not bytes (${lib.storage.label})`);
    check(lib.storage.secondsLeft > 0 && Number.isFinite(lib.storage.bytesPerSec),
      'and it is a duration derived from a rate rather than a byte count');
  }

  // ------------------------------------------- 2b. a node from another build
  //
  // **Two machines on one network are two builds**, and every fixture above has them
  // running the same one - which is the shape that cannot show this. The editing
  // machine is upgraded first because it is the one somebody is standing at, and the
  // node then answers `/library/takes` in the vocabulary of the build before: an
  // `openable` boolean, a `hasHello`, a frame count, and no refusals at all. That
  // manifest parses, survives the id and hash filters, and reconciles into the listing
  // looking like any other take, so the failure lands where nothing is watching for it
  // - the gallery iterating a field that is not there while painting the first remote
  // tile, and the whole shelf blank on a `TypeError`.
  //
  // The node is a stub rather than a second server, because what has to be tested is a
  // manifest this tree can no longer produce. Anything spawned out of `stageServer`
  // runs the build under test and answers correctly by construction, which is the same
  // trap as an oracle that agrees with itself.
  //
  // On a kernel-assigned port rather than one out of the reserved span. `reservePorts`
  // exists because two worktrees sharing a fixed port shared a server and asserted
  // against each other's fixtures; a port the kernel hands out on `listen(0)` cannot
  // be held by anybody, which answers the same worry without widening the span.
  console.log('\n[library] a node running an older build is refused at the link, not rendered');
  {
    const { NodeLink } = await import(pathToFileURL(join(root, 'server/library.js')).href);
    const stub = (takes) => new Promise((done) => {
      const srv = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ takes }));
      });
      srv.listen(0, '127.0.0.1', () => done({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
    });
    // The manifest the build before this one served, field for field. Written out here
    // rather than generated, because a fixture derived from today's shape by deleting a
    // key is a fixture that follows the code it is meant to outlive.
    const oldShape = {
      id: 'shot-on-an-old-node',
      file: 'shot-on-an-old-node.knct',
      bytes: 4096,
      hash: `sha256:${'ab'.repeat(32)}`,
      frames: 1,
      durationSec: 0,
      capturedAt: Date.UTC(2026, 5, 1),
      dateSource: 'mtime',
      truncated: false,
      hasHello: true,
      hello: { fx: 365, fy: 365, cx: 256, cy: 212 },
      openable: false,
      recording: false,
      marks: [],
    };
    const newShape = {
      ...oldShape,
      id: 'shot-on-this-build',
      hash: `sha256:${'cd'.repeat(32)}`,
      openRefusals: [{ key: 'short', why: 'a take needs two frames to bracket a position, so there is nothing here to play' }],
    };
    // **And the take that carries none, which is nearly every take there is.** A
    // refused take is the interesting shape and it is the wrong one to test a gate
    // with: `openRefusals: []` is what an ordinary openable take from a current node
    // sends, so a gate written as `length > 0` would take the link off for every
    // healthy library while a positive arm holding only the refused take stayed green.
    // The empty list is the case the code has to admit, so it is the case the fixture
    // has to contain.
    const openableShape = {
      ...oldShape,
      id: 'openable-on-this-build',
      hash: `sha256:${'ef'.repeat(32)}`,
      frames: 60,
      durationSec: 4,
      openable: true,
      openRefusals: [],
    };

    const old = await stub([oldShape]);
    const current = await stub([newShape, openableShape]);
    try {
      const oldLink = new NodeLink(old.url, 'old-node');
      const oldTakes = await oldLink.takes();
      check(oldTakes === null, 'a manifest with no refusals on it is refused whole rather than admitted take by take',
        oldTakes === null ? 'null' : `${oldTakes.length} takes came through`);
      check(/older build/.test(oldLink.lastError ?? '') && /shot-on-an-old-node/.test(oldLink.lastError ?? ''),
        'and the link says it is the node\'s build and which take arrived without them, rather than reporting a timeout',
        JSON.stringify(oldLink.lastError));

      // **The other arm, and the row is unfalsifiable without it.** A gate that
      // refused every manifest would pass both rows above while taking the link off
      // entirely, which is the same failure one build further along.
      const currentLink = new NodeLink(current.url, 'current-node');
      const currentTakes = await currentLink.takes();
      check(eq((currentTakes ?? []).map((t) => t.id), ['shot-on-this-build', 'openable-on-this-build']),
        'a manifest that carries them passes, so the gate is a version band rather than the link switched off',
        `${currentTakes === null ? 'null' : currentTakes.map((t) => t.id).join(' ')}, error ${JSON.stringify(currentLink.lastError)}`);
      // Named separately, because the two takes above fail for different reasons and a
      // combined row would report the wrong one. An empty list is a *take with nothing
      // wrong with it* rather than a take whose refusals went missing, and the gate has
      // to tell those apart or a healthy node is refused for being healthy.
      check(currentTakes?.some((t) => t.id === 'openable-on-this-build' && t.openRefusals.length === 0),
        'and an openable take, whose refusal list is correctly empty, is not read as a manifest with none',
        currentTakes === null ? `the whole manifest was refused: ${currentLink.lastError}` : 'it came through');

      // What the operator gets, which is the half a boundary test cannot see: the
      // gallery still paints, the local shelf is all there, and the line under the
      // header says what happened. With the gate off this is where the `TypeError`
      // lands and every tile goes with it, so the arm is here rather than assumed.
      const mixedUrl = await startServer(root, ['--captures', macCaps, '--name', 'mac', '--node', old.url,
        '--node-name', 'old-node', '--presets', join(WORK, 'presets'), '--projects', join(WORK, 'projects'),
        '--builtin-presets', join(WORK, 'builtin-presets')], MAC_PORT + 1);
      const { page, errors } = await openPage(browser, galleryPage(mixedUrl));
      // **Waited for behind a catch, because this is the arm the mutation kills.** With
      // the gate off, the remote take reconciles in and the page throws inside its
      // top-level paint, so `__library` is never assigned at all - and an unguarded
      // wait is twenty seconds of Playwright and then a throw that ends the whole run
      // at 29 of 363 assertions. Measured: that is what `--mutate
      // node-admits-an-old-manifest` did before this catch. A control is supposed to
      // redden the rows carrying its claim and leave every other claim still
      // measurable; one whose blast radius is the tool measures nothing else.
      const painted = await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 })
        .then(() => true).catch(() => false);
      const tiles = painted ? await page.evaluate('globalThis.__library.tiles()') : [];
      check(painted && tiles.length > 0 && errors.length === 0,
        'the gallery beside an older node still draws this machine\'s own takes, with no page error',
        `${painted ? `${tiles.length} tiles` : 'the page never finished painting'}, ${errors.length} errors: ${errors.join(' | ')}`);
      // `tiles.length > 0` and not just `every`, because an empty list satisfies every
      // predicate there is - and an empty list is exactly what the arm above reports
      // when the page has died.
      check(tiles.length > 0 && tiles.every((t) => t.state !== 'remote'),
        'and nothing from that node is on the shelf, because a shelf missing some of them silently is the worse answer',
        `${tiles.length} tiles, ${tiles.filter((t) => t.state === 'remote').length} of them remote`);
      const line = await page.evaluate('document.getElementById("note")?.textContent ?? ""');
      check(/old-node/.test(line) && /older build/.test(line),
        'and the page names the node and says its build is the reason', JSON.stringify(line));
      await page.close();
      for (const p of servers.filter((sv) => sv.port === MAC_PORT + 1)) p.child.kill('SIGKILL');

      // ---- and a node one build *ahead*, which is the door the gate leaves open
      //
      // **The gate is on the shape of a manifest and deliberately not on its
      // vocabulary**, so that a newer node can name a reason this build has never heard
      // of and have the tile badge the key as itself. That promise is what is tested
      // here, and it had a hole in it: `BADGES[key]?.(take)` on an ordinary object
      // literal answers `__proto__` with `Object.prototype`, so the `?.` does not
      // short-circuit and the call throws on a value that is not a function. The
      // gallery then dies painting the tile - the same blank shelf the version gate
      // exists to prevent, arriving through the door the gate was told to leave open.
      //
      // `__proto__` because it is the one that throws. `constructor`, `toString` and
      // `valueOf` are the quieter half of the same fault and badge a take
      // `[object Object]`, so the second row asks what the badge actually says rather
      // than only that the page survived.
      const ahead = await stub([{
        ...openableShape,
        id: 'shot-on-a-newer-build',
        hash: `sha256:${'12'.repeat(32)}`,
        openable: false,
        openRefusals: [{ key: '__proto__', why: 'this take is refused for a reason this build has never heard of' }],
      }]);
      try {
        const aheadUrl = await startServer(root, ['--captures', macCaps, '--name', 'mac', '--node', ahead.url,
          '--node-name', 'new-node', '--presets', join(WORK, 'presets'), '--projects', join(WORK, 'projects'),
          '--builtin-presets', join(WORK, 'builtin-presets')], MAC_PORT + 8);
        const { page: aheadPage, errors: aheadErrors } = await openPage(browser, galleryPage(aheadUrl));
        const alive = await aheadPage.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 })
          .then(() => true).catch(() => false);
        const aheadTiles = alive ? await aheadPage.evaluate('globalThis.__library.tiles()') : [];
        const strange = aheadTiles.find((t) => t.id === 'shot-on-a-newer-build');
        check(alive && strange !== undefined && aheadErrors.length === 0,
          'a refusal key this build has never heard of paints its tile rather than killing the shelf',
          `${alive ? `${aheadTiles.length} tiles` : 'the page never finished painting'}, `
            + `${aheadErrors.length} errors: ${aheadErrors.join(' | ')}`);
        const badge = strange?.badges.find((b) => b.key === '__proto__');
        check(badge?.short === '__proto__',
          'and the badge reads the key itself, which is what visibly unmapped was promised to mean',
          JSON.stringify(strange?.badges ?? null));
        await aheadPage.close();
        for (const p of servers.filter((sv) => sv.port === MAC_PORT + 8)) p.child.kill('SIGKILL');
      } finally {
        ahead.srv.close();
      }

      // ---- and a node one build behind on the *other* route, which the gate above
      //      cannot see
      //
      // The manifest gate asks `/library/takes` about its build and answers for the
      // whole link, but a node is two routes and they moved in different releases: the
      // build immediately before this one serves a manifest that carries `openRefusals`
      // - so it passes everything above - and a `/record/state` that predates
      // `writingId` entirely. Read with a `?? null` that node is a recorder sitting
      // idle, which is a legal state and therefore invisible: the fingerprint the
      // gallery's poll computes is constant from the first tick, no remote start or
      // stop can ever change it, and the shelf stops rereading the library for the
      // machine half its tiles come from. **The object every observation happened to
      // skip**, and it was skipped because the version question looked already asked.
      //
      // The stub routes on the path rather than answering everything alike, because
      // the whole shape of this defect is one route being current while the other is
      // not - a fixture that served one body to both could not stage it.
      const twoRoute = (recordState) => new Promise((done) => {
        const srv = createServer((req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(req.url.startsWith('/record/state')
            ? recordState()
            : { takes: [newShape, openableShape] }));
        });
        srv.listen(0, '127.0.0.1', () => done({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
      });
      // Written out rather than derived by deleting a key from the current one, for the
      // reason `oldShape` above is: a fixture built by subtracting from today's shape
      // follows the code it exists to outlive.
      let served = { recording: false, takeId: null };
      const behind = await twoRoute(() => served);
      const carries = await twoRoute(() => ({ recording: false, takeId: null, writingId: null }));
      try {
        const blind = new NodeLink(behind.url, 'behind-node');
        // Before the poll has said anything, because a link that has answered nothing
        // is not a link that has failed - and a gate that refused on a null would
        // refuse every node at boot while passing every row below it.
        check(Array.isArray(await blind.takes()),
          'a node is listed before the poll has spoken to it, since a link with no answer yet has not failed one',
          `${blind.lastError === null ? 'no error' : blind.lastError}`);

        const polled = await blind.recordState();
        check(polled.reachable === false,
          'a recorder state with no writingId in it is refused rather than read as a node that owns no take',
          `reachable ${polled.reachable}, writingId ${JSON.stringify(polled.writingId)}`);
        const refused = await blind.takes();
        check(refused === null && /older build/.test(blind.lastError ?? '') && /writingId/.test(blind.lastError ?? ''),
          'and the refusal reaches the listing, which is the only one of the two routes that draws anything',
          `${refused === null ? 'null' : `${refused.length} takes`}, ${JSON.stringify(blind.lastError)}`);

        // **The other arm, and the rows above are unfalsifiable without it.** A guard
        // that refused every node would satisfy both of them while taking the link off,
        // which is the same defect one build further along - and `writingId: null` is
        // the exact value the absent case was being confused with, so this is the arm
        // that says the gate reads absence rather than emptiness.
        const well = new NodeLink(carries.url, 'carrying-node');
        const wellPolled = await well.recordState();
        check(wellPolled.reachable === true && wellPolled.writingId === null,
          'a node carrying the field and simply not writing is not refused for it, so the gate reads absence rather than an idle recorder',
          `reachable ${wellPolled.reachable}, writingId ${JSON.stringify(wellPolled.writingId)}`);
        check(Array.isArray(await well.takes()),
          'and its takes still list, so this is a version band rather than the poll switched off',
          `${well.lastError === null ? 'no error' : well.lastError}`);

        // **The refusal has to be able to end, and nothing else here would notice if it
        // could not.** Parked in `lastError` it would either be wiped by the next
        // listing that succeeded - never surviving to be read - or latch, and a node
        // upgraded ten minutes later would stay refused until this process restarted.
        // Both failures pass every row above, which is why the heal is its own arm.
        served = { recording: false, takeId: null, writingId: null };
        await blind.recordState();
        const healed = await blind.takes();
        check(healed !== null && blind.lastError === null,
          'and a node upgraded under a running link is followed again within one tick, rather than staying refused until this process restarts',
          `${healed === null ? `still refused: ${blind.lastError}` : `${healed.length} takes`}`);
      } finally {
        behind.srv.close();
        carries.srv.close();
      }
    } finally {
      old.srv.close();
      current.srv.close();
    }
  }

  // ----------------------------------------------------------- 3. decimation
  console.log('\n[library] the decimation parameter: one mechanism, three callers');
  {
    const sizes = {};
    const bodies = {};
    // Both divisors the tiles use, and both ends of the range the server accepts -
    // the pair the UI ships plus the pair only the API can reach, because an arm
    // set that only covers what the page asks for cannot see a bound that is wrong.
    for (const k of [1, 2, 4, 16]) {
      const res = await fetch(`${macUrl}/capture/local-clip/frame/4?decimate=${k}`);
      const buf = Buffer.from(await res.arrayBuffer());
      bodies[k] = buf;
      sizes[k] = {
        header: res.headers.get('x-depth-divisor'),
        depthBytes: buf.readUInt32LE(0),
        colorBytes: buf.readUInt32LE(4),
        stamp: Number(buf.readBigUInt64LE(8)),
        total: buf.length,
      };
    }
    const grid = (k) => Math.ceil(512 / k) * Math.ceil(424 / k) * 2;
    check([1, 2, 4, 16].every((k) => sizes[k].depthBytes === grid(k)),
      'a divisor samples both axes, so the depth grid is ceil(512/k) by ceil(424/k)',
      [1, 2, 4, 16].map((k) => `k=${k}:${sizes[k].depthBytes}/${grid(k)}`).join(' '));
    check([1, 2, 4, 16].every((k) => sizes[k].colorBytes === sizes[1].colorBytes && sizes[k].colorBytes > 0),
      'the colour block is carried through untouched at every divisor',
      `${sizes[1].colorBytes} bytes each`);
    // The spec's own arithmetic: divisor 4 is 27KB of depth plus the whole colour
    // block, and on the capture that figure was taken from those are the ~80KB that
    // put a scrub position at 21ms over a 3.8 MB/s link against the 128ms a full frame
    // costs. Dropping colour would give ~7ms, which is a different mechanism wearing
    // this one's measured number.
    //
    // **So what is asserted is the composition, not the eighty.** A JPEG's size is a
    // property of what the camera was looking at, and `captures/` is gitignored - this
    // fixture's colour block is half the size of the one the note was written against,
    // and a literal total reddened over a room that photographs smaller. The property
    // that keeps the 21ms honest is that the colour block is still there and is most of
    // what a position costs, because that is exactly what a build dropping it at
    // decimation would break - it would take the share to zero. A third is the floor
    // rather than a half: this fixture's colour is 50% of the total against the 66% the
    // note was written on, and both are a long way from nothing. The cost on this
    // capture is printed rather than asserted.
    const LINK_MB_S = 3.8;
    const positionMs = (sizes[4].total / (LINK_MB_S * 1024 * 1024)) * 1000;
    const wholeFrameMs = (sizes[1].total / (LINK_MB_S * 1024 * 1024)) * 1000;
    check(sizes[4].colorBytes / sizes[4].total > 0.35 && sizes[4].depthBytes === grid(4),
      'divisor 4 is decimated depth plus the whole colour block, which is what the per-position figure is made of',
      `${(sizes[4].total / 1024).toFixed(1)}KB = ${(sizes[4].depthBytes / 1024).toFixed(0)}KB depth `
      + `+ ${(sizes[4].colorBytes / 1024).toFixed(0)}KB colour, so ${positionMs.toFixed(0)}ms a position `
      + `against ${wholeFrameMs.toFixed(0)}ms a whole frame at ${LINK_MB_S} MB/s`);
    check([1, 2, 4, 16].every((k) => sizes[k].stamp === sizes[1].stamp),
      'and the capture timestamp is the frame\'s own at every divisor');
    check(sizes[1].total === sizes[1].depthBytes + sizes[1].colorBytes + 16,
      'divisor 1 is the payload unchanged, so the editor\'s path is what it was');

    // A frame whose two declared lengths do not describe the frame. Only the depth
    // length was checked, so an overstated colour length sized a fresh
    // `allocUnsafe` buffer larger than the copy that follows fills - and what came
    // back past the copy was uninitialised memory rather than picture.
    const bentUrl = `${macUrl}/capture/bad-length-take/frame/1`;
    const bent = await fetch(`${bentUrl}?decimate=4`);
    check(bent.status >= 400,
      'a frame whose declared lengths overrun the payload is refused rather than sampled past',
      `${bent.status} ${(await bent.text()).slice(0, 80)}`);
    // The control, and it is what says this arm is about the *frame* rather than
    // about the take: the same take's other frames are fine, so the scan indexed
    // the file and the refusal is per frame.
    const beside = await fetch(`${bentUrl.replace('/frame/1', '/frame/0')}?decimate=4`);
    check(beside.ok, 'while the sound frames beside it in the same take still decimate',
      `frame 0 came back ${beside.status}`);
    // And at divisor 1 nothing is rebuilt, so the file's own bytes come back exactly
    // as the format promises - which is why the check lives on the decimation path.
    const verbatim = await fetch(bentUrl);
    check(verbatim.ok, 'and the undecimated read still returns the bytes the file holds, unchanged',
      `frame 1 undecimated came back ${verbatim.status}`);

    // **Which samples come back, not how many.** A byte count cannot tell a grid
    // sampled on both axes from one strided through the flat array: the count is
    // identical and the picture is not. So the expected grid is computed here, off
    // the full frame this tool already has, and compared sample for sample.
    for (const k of [2, 4, 16]) {
      const w = Math.ceil(512 / k);
      const h = Math.ceil(424 / k);
      const want = Buffer.allocUnsafe(w * h * 2);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          want.writeUInt16LE(bodies[1].readUInt16LE(16 + (y * k * 512 + x * k) * 2), (y * w + x) * 2);
        }
      }
      const got = bodies[k].subarray(16, 16 + w * h * 2);
      const wrong = [];
      for (let i = 0; i < want.length && wrong.length < 4; i += 2) {
        if (want.readUInt16LE(i) !== got.readUInt16LE(i)) wrong.push(i / 2);
      }
      check(wrong.length === 0,
        `at divisor ${k} every sample is the nearest-neighbour one, not a stride through the flat array`,
        wrong.length ? `first wrong samples at ${wrong.join(', ')}` : `${w}x${h} samples agree`);
    }
    // The colour bytes are the frame's own, not merely the right length.
    check(Buffer.compare(bodies[4].subarray(16 + sizes[4].depthBytes),
      bodies[1].subarray(16 + sizes[1].depthBytes)) === 0,
      'and the colour block is byte for byte the frame\'s own');

    for (const bad of ['0', '17', '1.5', 'lots']) {
      const res = await fetch(`${macUrl}/capture/local-clip/frame/4?decimate=${bad}`);
      check(res.status === 400, `a divisor of ${bad} is refused rather than clamped`, `status ${res.status}`);
    }
  }

  // -------------------------------------------------- 4. descriptors stay bounded
  //
  // **This section runs against a replay server, and that is the whole of what it
  // learned.** The first version of it spawned a server with no `--replay` at all,
  // so every arm agreed about a quantity none of them measured - which is the
  // failure `docs/instruments.md` names under "what do my arms agree about",
  // reproduced in a section written after reading it. Two hours is apparently not
  // long enough for a rule to stick, so the example lives here beside the code
  // rather than only in the document: the replay is the one reader that holds a
  // descriptor for the life of the process without any request bracketing it, so it
  // is exactly what an eviction policy gets wrong, and a bound measured without one
  // is a bound measured where nothing was at stake.
  console.log('\n[library] skimming a directory does not evict the replay out from under itself');
  {
    // Enough takes that an unbounded map is unmistakably over the cap, and small
    // enough that building them is not the measurement. Sized by frame count.
    const many = join(WORK, 'many-captures');
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 80; i++) writeTake(many, `bulk-${String(i).padStart(3, '0')}`, { frames: 3 });
    // The replayed take lives outside the directory being skimmed, so nothing the
    // skim touches is the file the replay is reading.
    const replaySource = join(WORK, 'replay-source');
    mkdirSync(replaySource, { recursive: true });
    const replaying = writeTake(replaySource, 'replayed-take', { frames: 40 });
    const manyUrl = await startServer(root,
      ['--captures', many, '--name', 'bulk', '--replay', replaying], MAC_PORT + 2);

    // A live client, because the failure this exists for is not visible from the
    // library at all: the replay's reads start throwing, the server reports a lost
    // sensor, and the descriptor count looks perfectly healthy the whole time.
    const seen = { frames: 0, statuses: [] };
    const ws = new WebSocket(manyUrl.replace('http', 'ws'));
    ws.on('message', (data, isBinary) => {
      if (isBinary) seen.frames++;
      else {
        try {
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.status) seen.statuses.push(msg.status);
        } catch { /* not a status message */ }
      }
    });
    await new Promise((done, fail) => { ws.on('open', done); ws.on('error', fail); });
    await new Promise((done) => { setTimeout(done, 1200); });
    const framesBefore = seen.frames;
    check(framesBefore > 0, 'the replay is streaming before the skim starts',
      `${framesBefore} frames in 1.2s`);

    const before = (await getJson(`${manyUrl}/library/descriptors`)).open;
    // A skim is a frame read per take, which is the gesture that opens them.
    for (let i = 0; i < 80; i++) {
      await fetch(`${manyUrl}/capture/bulk-${String(i).padStart(3, '0')}/frame/1`);
    }
    const after = (await getJson(`${manyUrl}/library/descriptors`)).open;
    // The status list is deliberately *not* cleared here. It was, and that threw
    // away the evidence: an eviction during the eighty fetches reports its lost
    // sensor while the skim is still running, so clearing afterwards discarded the
    // very message the assertion was looking for and the row passed on some runs and
    // failed on others. Nothing should report a lost sensor at any point in this
    // window, so the whole window is what gets asserted.
    const framesAtSkim = seen.frames;
    await new Promise((done) => { setTimeout(done, 1500); });
    const framesAfter = seen.frames - framesAtSkim;
    ws.close();

    // The bound is on descriptors left lying about, so a couple in flight and the
    // retained replay are honest. The point of the assertion is that it does not
    // track the number of takes touched.
    check(after <= 27, 'eighty takes skimmed leave the open-capture map bounded',
      `${before} before, ${after} after, cap 24 plus the retained replay`);
    check(after < 80, 'and the bound does not track the number of takes touched');
    check(framesAfter > 0, 'and the replay is still streaming afterwards - its descriptor survived',
      `${framesAfter} frames in the 1.5s after the skim`);
    check(!seen.statuses.includes('lost'),
      'with no lost-sensor report at any point, which is how a closed handle presents itself',
      seen.statuses.length ? `saw ${seen.statuses.join(' ')}` : 'no status changes');
  }

  // ------------------------------------------------ 4b. a take is a file
  //
  // Driven by `tools/fake-grabber.mjs`: real KNCT framing and real sensor depth on
  // stdout, with no Kinect in the room. Everything here is a behaviour of the
  // *writer*, so nothing short of something actually streaming exercises any of it -
  // which is why six implemented rules sat unproven until this instrument existed.
  console.log('\n[library] a take is a file, and a restart splits it');
  {
    const recDir = join(WORK, 'recorded');
    mkdirSync(recDir, { recursive: true });
    // A decoy at the name the recorder would otherwise reach for first. A take must
    // never append to or overwrite a file that is already there - two takes in one
    // file share a hash and a gallery entry, which the project model cannot express.
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const decoyPath = join(recDir, `${day}-take1.knct`);
    writeFileSync(decoyPath, Buffer.from('not a take, and must still not be one afterwards'));
    const decoyBefore = readFileSync(decoyPath);

    const EMITTED = 24;
    const recUrl = await startServer(root, [
      '--captures', recDir, '--name', 'shooting', '--record', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --die-after ${EMITTED} --burst 10 --fps 40`,
    ], MAC_PORT + 4);
    // Waited until the recorder has *closed* three takes, not until the library
    // lists three. Those are different conditions and the difference made this
    // assertion flaky: a listing counts the take still being written, so the loop
    // could exit with two closed and one open and the count assertion below would
    // fail on runs that had nothing to do with what was being tested. It fired on
    // four unrelated mutations before it was pinned, which is exactly the
    // one-in-five failure that teaches people to re-run a gating check until green.
    const closedSoFar = () => [...servers.find((s) => s.port === MAC_PORT + 4).log.join('')
      .matchAll(/\[recorder\] take (\S+) closed/g)].length;
    for (let i = 0; i < 90; i++) {
      if (closedSoFar() >= 3) break;
      await new Promise((done) => { setTimeout(done, 500); });
    }
    check(closedSoFar() >= 3, 'the writer ran, died and was respawned enough times to split three takes',
      `${closedSoFar()} closed`);
    // Closed takes only, and the recorder's own log is what says so. The obvious
    // test - "does a sidecar exist" - is wrong here and wrong in an instructive way:
    // listing the library scans every take in the directory, *including the one
    // still being written*, and the scan writes a sidecar. So the act of watching
    // for takes manufactures the evidence that they are finished, and the take that
    // was mid-recording gets counted against a frame total it was never going to
    // reach. Measured: it came in at 10 and at 11 on two runs, which is the burst
    // plus however long the last poll took.
    const recLog = servers.find((s) => s.port === MAC_PORT + 4).log.join('');
    const closed = new Set([...recLog.matchAll(/\[recorder\] take (\S+) closed/g)].map((m) => `${m[1]}.knct`));
    const recorded = readdirSync(recDir)
      .filter((f) => f.endsWith('.knct') && f !== `${day}-take1.knct` && closed.has(f))
      .sort();

    check(Buffer.compare(readFileSync(decoyPath), decoyBefore) === 0,
      'a take never appends to or overwrites a file that is already there',
      `${decoyPath.split('/').pop()} is byte-identical, ${decoyBefore.length} bytes`);
    check(recorded.length >= 3, 'a grabber that dies and respawns produces one take per run',
      recorded.join(' '));
    check(recorded[0] === `${day}-take2.knct`,
      'and the first of them steps over the name that was taken', recorded[0]);

    const scanned = recorded.map((file) => {
      const parser = new MessageParser();
      let helloes = 0;
      let frameCount = 0;
      let hello = null;
      const stamps = [];
      for (const msg of parser.push(readFileSync(join(recDir, file)))) {
        if (msg.type === TYPE_HELLO) { helloes++; hello ??= JSON.parse(msg.payload.toString('utf8')); }
        else if (msg.type === TYPE_FRAME) { frameCount++; stamps.push(Number(msg.payload.readBigUInt64LE(8))); }
      }
      return { file, helloes, frameCount, hello, stamps };
    });

    check(scanned.every((t) => t.helloes === 1),
      'one take is one continuous stream with exactly one hello at its head',
      scanned.map((t) => `${t.file}:${t.helloes}`).join(' '));
    // **Exact, not approximate.** The writer emits a known number of frames and then
    // exits, so a take that holds fewer lost some - and the ten of them behind the
    // hello are written back to back, which is where a recorder that opened its file
    // one turn late drops them.
    check(scanned.every((t) => t.frameCount === EMITTED),
      `and every frame the writer emitted is in it (${EMITTED} each)`,
      scanned.map((t) => `${t.file}:${t.frameCount}`).join(' '));
    check(scanned.every((t) => t.stamps.every((v, i) => i === 0 || v > t.stamps[i - 1])),
      'with strictly ascending timestamps, which a run across a restart seam would break');
    check(scanned.every((t) => Number.isFinite(t.hello?.startedAt)),
      'the hello carries a wall clock, which the frame stamps cannot supply');
    // Optional access for the same reason section 4c has it: a build with no hello at
    // the head of a take leaves `t.hello` null here, and reading through it ended the
    // run in this section - so `recorder-skips-hello` was caught on the two rows
    // above and then took every section after it out of the run, which is a mutation
    // whose real reach nobody was measuring.
    check(scanned.every((t, i) => i === 0 || t.hello?.startedAt > scanned[i - 1].hello?.startedAt),
      'and it advances take to take, so a library can sort by when it was shot',
      scanned.map((t) => t.hello?.startedAt ?? 'none').join(' '));

    const listed = (await getJson(`${recUrl}/library/takes`)).takes;
    const byFile = Object.fromEntries(listed.map((t) => [t.file, t]));
    check(scanned.every((t) => byFile[t.file]?.frames === EMITTED && byFile[t.file]?.dateSource === 'hello'),
      'and each closed take is a gallery entry, scanned, hashed and dated off its own hello');
    check(new Set(scanned.map((t) => byFile[t.file]?.hash)).size === scanned.length,
      'every take has its own hash, so nothing shares a gallery entry',
      scanned.map((t) => String(byFile[t.file]?.hash).slice(7, 15)).join(' '));
    for (const p of servers.filter((s) => s.port === MAC_PORT + 4)) p.child.kill('SIGKILL');
  }

  // ------------------------------------------- 4c. the mark button, while shooting
  console.log('\n[library] mark flags the moment while it is still happening');
  {
    const markDir = join(WORK, 'marking');
    mkdirSync(markDir, { recursive: true });
    const markUrl = await startServer(root, [
      '--captures', markDir, '--name', 'shooting', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
    ], MAC_PORT + 5);
    // Waited for rather than slept against: a start before the sensor has said hello
    // arms without opening a take, which is correct and is not what this measures.
    //
    // **The condition is a frame arriving, and it used to be the opposite of one.**
    // The loop here broke on `armed === false`, which is true from boot on a server
    // nobody has armed - so it left after a single 250ms tick while its comment
    // claimed it was waiting for the sensor. Measured 5 of 5: the loop returned at
    // 255ms and the first frame arrived at 257-506ms, negative margin every run, and
    // the row below then failed with `null` for reasons that had nothing to do with
    // what it tests. A gate that goes red for unrelated reasons is how people learn
    // to re-run until green.
    await liveFrame(markUrl, 20000);
    const started = await post(`${markUrl}/record/start`);
    check(started.recording === true && typeof started.takeId === 'string',
      'record opens a take on a running sensor', String(started.takeId));
    await new Promise((done) => { setTimeout(done, 900); });
    const mark = await post(`${markUrl}/record/mark`, { label: 'the moment' });
    await new Promise((done) => { setTimeout(done, 600); });
    const stopped = (await post(`${markUrl}/record/stop`)).stopped;

    check(mark.sourceMs > 0 && mark.label === 'the moment',
      'mark stamps the moment in source milliseconds from the take\'s start',
      `${mark.sourceMs}ms`);
    check(stopped?.frames > 0 && stopped.hash?.startsWith('sha256:'),
      'stop closes the take, scans it and gives it the hash a project would name it by',
      `${stopped?.frames} frames`);
    // Read through optional access from here down, and that is about the *tool*
    // rather than about the take. A mutation that stops `/record/stop` from working
    // leaves `stopped` undefined, and `stopped.id` then threw - which ended the run
    // in this section and left every section after it unrun, while the exit code
    // still looked like a mutation being caught. `stop-route-reads` was caught that
    // way, by a TypeError twelve hundred lines above the arm whose comment claimed
    // the credit.
    const listed = (await getJson(`${markUrl}/library/takes`)).takes.find((t) => t.id === stopped?.id);
    check(listed?.marks?.length === 1 && listed.marks[0].label === 'the moment',
      'and the mark is on the take in the library, not inside the capture',
      JSON.stringify(listed?.marks));
    // Marks are stamped raw and never pre-rolled - people press a few hundred
    // milliseconds after the thing happens, and a constant baked in at capture time
    // would be a guess. What is checked is that it lands inside the take.
    check(listed?.marks?.[0]?.sourceMs > 0 && listed.marks[0].sourceMs < listed.durationSec * 1000 + 500,
      'stamped inside the footage it flags rather than at an arbitrary offset',
      listed?.marks?.[0] ? `${listed.marks[0].sourceMs}ms into ${(listed.durationSec * 1000).toFixed(0)}ms` : 'no mark landed');
    check(Boolean(stopped?.id) && existsSync(join(markDir, `${stopped.id}.marks.jsonl`)),
      'in an append-only sidecar beside the take, which is byte-identical to what the writer produced');
    for (const p of servers.filter((s) => s.port === MAC_PORT + 5)) p.child.kill('SIGKILL');
  }

  // ------------------------------------ 4d. a name already taken is not a stop
  //
  // `wx` is what stops two takes sharing one file, and proving it needs a take whose
  // chosen name is *already there* - which a scan that picks the highest number plus
  // one never produces on its own. The reachable case is two writers on one captures
  // directory, and the deterministic version of it is a directory this process can
  // write but not list: `readdirSync` fails, the scan falls back to take one, and
  // the names it reaches for are taken. Both halves are real - a shared directory is
  // how it happens, an unlistable one is how it is made to happen every time.
  console.log('\n[library] a take name already taken is stepped over, not a stop');
  {
    const clash = join(WORK, 'clashing');
    mkdirSync(clash, { recursive: true });
    const now = new Date();
    const day = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const taken = [join(clash, `${day}-take1.knct`), join(clash, `${day}-take2.knct`)];
    for (const path of taken) writeTake(clash, basename(path, '.knct'), { frames: 4 });
    const before = taken.map((path) => readFileSync(path));
    chmodSync(clash, 0o300);

    let state = null;
    try {
      const clashUrl = await startServer(root, [
        '--captures', clash, '--name', 'shooting', '--record', '--no-color',
        '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40 --burst 4`,
      ], MAC_PORT + 6);
      for (let i = 0; i < 40; i++) {
        await new Promise((done) => { setTimeout(done, 250); });
        state = await getJson(`${clashUrl}/record/state`);
        if (state.recording) break;
      }
    } finally {
      for (const p of servers.filter((sv) => sv.port === MAC_PORT + 6)) p.child.kill('SIGKILL');
      // Restored before anything reads the directory again, including this run's own
      // teardown - a scratch tree that cannot be listed is a scratch tree that
      // cannot be deleted.
      chmodSync(clash, 0o700);
    }

    check(state?.recording === true && state?.armed === true,
      'a take whose name is taken keeps recording rather than disarming the node',
      JSON.stringify({ armed: state?.armed, recording: state?.recording, takeId: state?.takeId }));
    check(state?.takeId === `${day}-take3`,
      'and it steps to the next free name rather than the one it first reached for',
      String(state?.takeId));
    check(taken.every((path, i) => Buffer.compare(readFileSync(path), before[i]) === 0),
      'while both files that were already there are byte-identical - wx neither appended nor truncated',
      taken.map((p) => basename(p)).join(' '));
    const clashLog = servers.find((sv) => sv.port === MAC_PORT + 6).log.join('');
    // The arm has to have fired. Two names refused is what makes the three
    // assertions above about the retry rather than about a recorder that simply
    // picked a free name the ordinary way.
    // Corroboration, and labelled as corroboration. This is a `console.warn` scrape,
    // and an implementation that logged twice without retrying would satisfy it -
    // so it cannot be the thing that proves the retry happened. What proves that is
    // the row above: the recorder landed on `take3` while `take1` and `take2` sat
    // there byte-identical, which no implementation reaches without having been
    // refused by both and stepped past both.
    check((clashLog.match(/is already taken/g) ?? []).length === 2,
      'and the log agrees, with two refusals - corroboration for the take3 row above, which is what carries the claim',
      `${(clashLog.match(/is already taken/g) ?? []).length} refusals in the log`);
  }

  // ------------------------------- 4e. a take that cannot fit is refused up front
  console.log('\n[library] a take that cannot fit never starts');
  {
    // A real filesystem with almost nothing on it, because the gate is arithmetic on
    // free space and free space is the half of it an operator actually hits. The
    // alternative - driving the rate instead - would be testing a number this tool
    // supplied rather than the one the disk did.
    const room = await smallFilesystem();
    if (!room) {
      // Printed rather than silently passed. This claim is unproven on this
      // platform and the line says so, because a check that quietly drops an
      // assertion where it cannot make a fixture is a check that reports coverage it
      // does not have.
      console.log(`  SKIP  a take that cannot fit is refused - no way to make a small filesystem on ${process.platform}`);
      skipped.push('the low-space refusal');
    } else {
      try {
        const fullUrl = await startServer(root, [
          '--captures', room.mount, '--name', 'nearly-full', '--no-color',
          '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
        ], MAC_PORT + 7);
        const space = await getJson(`${fullUrl}/library/remaining`);
        check(space.secondsLeft < 120,
          'the volume under test genuinely has less than the minimum on it, which is what makes this a fixture',
          `${space.label} at ${(space.bytesPerSec / 1e6).toFixed(1)} MB/s`);
        const refused = await post(`${fullUrl}/record/start`);
        check(/refusing to start a take/.test(refused.error ?? ''),
          'a take that cannot fit a sensible minimum is refused rather than failing partway through',
          (refused.error ?? 'ACCEPTED').slice(0, 92));
        const after = await getJson(`${fullUrl}/record/state`);
        check(after.armed === false && after.recording === false,
          'and the recorder is left disarmed rather than half-armed');
        check(readdirSync(room.mount).filter((f) => f.endsWith('.knct')).length === 0,
          'and nothing is written - a take that never started is a decision, one that dies at eighty percent is a loss',
          readdirSync(room.mount).join(' ') || 'empty');
      } finally {
        for (const p of servers.filter((sv) => sv.port === MAC_PORT + 7)) p.child.kill('SIGKILL');
        await new Promise((done) => { setTimeout(done, 400); });
        room.release();
      }
    }
  }

  // ------------------- 4f. a grabber that has exited is not a grabber that is running
  //
  // **The window this aims at is between an exit and the respawn the backoff has
  // scheduled, and it exists because a colour toggle reads the supervisor's `child`
  // reference to decide whether there is anything to restart.** Nothing used to clear
  // that reference on exit, so for the whole backoff - `RESTART_DELAYS[attempt]`, a full
  // second after the first failure - `child` was a truthy `ChildProcess` that had
  // already gone. A toggle landing there armed `restarting` against the corpse and
  // called `stopGrabber` on something that can neither be signalled nor exit again, so
  // nothing consumed the flag; what eventually read it was the *next* grabber's genuine
  // failure, which then took the requested-restart branch and returned before the
  // backoff ever ran.
  //
  // Its own server rather than 4b's, because an extra restart moves that section's
  // closed-take count and this section's whole method is provoking extra restarts.
  //
  // **What can be observed is the branch that was taken, not the state that was
  // wrong.** The `attempt = 0` the toggle also does is invisible here - `fake-grabber`
  // handshakes, and a hello zeroes `attempt` anyway - and the record button is
  // unreachable for the same reason, since `everLive` is true so the node never reaches
  // `absent`. What is left is two absences on the next genuine death: no `lost` on the
  // status channel, and no `restarting grabber in ...ms` in the log. Those are the rows.
  //
  // **Both are read as a shape and not as a presence, and the note beside them says what
  // that cost to learn.** The defect does not remove either word from the log - it moves
  // them, because the toggle's own `stopGrabber` announces a `lost` of its own and the
  // respawn that follows still writes a line. A row asking whether the word appeared was
  // therefore true of the build with the bug in it.
  console.log('\n[library] a colour toggle during the respawn backoff does not eat the next failure');
  {
    const supDir = join(WORK, 'supervised');
    mkdirSync(supDir, { recursive: true });
    // Short-lived on purpose: the grabber says hello, streams a burst and dies
    // unrequested, which is the failure the backoff is for. A hello before each death
    // is also what pins the window - it puts `attempt` back to 0, so the delay that
    // follows is `RESTART_DELAYS[0]` and therefore 1000ms rather than a later and wider
    // entry in the table. The 250ms clean-respawn window is a different one and is not
    // what this aims at.
    const supUrl = await startServer(root, [
      '--captures', supDir, '--name', 'supervised', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --die-after 24 --burst 10 --fps 40`,
    ], MAC_PORT + 1);
    const supLog = () => servers.find((s) => s.port === MAC_PORT + 1).log.join('');
    const countIn = (text, re) => [...text.matchAll(re)].length;
    const EXITED = /\[server\] grabber exited/g;
    const BACKOFF = /\[server\] restarting grabber in \d+ms \(attempt \d+\)/g;

    // The status channel, held the way the descriptor section holds one: `lost` is
    // broadcast and never served, so nothing over HTTP can answer this.
    const statuses = [];
    const ws = new WebSocket(supUrl.replace('http', 'ws'));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(data.toString('utf8'));
        if (msg.status) statuses.push(msg.status);
      } catch { /* not a status message */ }
    });
    await new Promise((done, fail) => { ws.on('open', done); ws.on('error', fail); });

    // Polled finely rather than slept against, because the whole row is a message that
    // has to land inside a one-second window. 20ms against 1000ms is a margin of fifty.
    let died = false;
    for (let i = 0; i < 1500 && !died; i++) {
      await new Promise((done) => { setTimeout(done, 20); });
      died = countIn(supLog(), EXITED) >= 1;
    }
    check(died, 'the grabber handshook, streamed and died unrequested, which is the failure the backoff exists for',
      `${countIn(supLog(), EXITED)} exits`);

    // Everything after this point is counted from here, because the first death has
    // already produced a `lost` and a backoff line of its own and the claim is about
    // the *next* one.
    const statusesBefore = statuses.length;
    const backoffBefore = countIn(supLog(), BACKOFF);
    const spawnsBefore = countIn(supLog(), /\[server\] starting grabber:/g);
    ws.send(JSON.stringify({ camera: { color: true } }));
    // **Whether the message landed in the window is the instrument's own question, and
    // it is asked separately from the claim.** Both the fixed build and the broken one
    // take a toggle during the backoff; what differs is the branch. A toggle that
    // arrived late, after the respawn, is a legitimate restart on a live grabber in
    // either build - so it would leave the two rows below green on a build that has the
    // defect, and the run has to say the fixture missed rather than say the code passed.
    const spawnsAtToggle = countIn(supLog(), /\[server\] starting grabber:/g);
    check(spawnsAtToggle === spawnsBefore && spawnsBefore === 1,
      'and the toggle was sent while nothing was running - between the exit and the respawn, which is the window the whole section is about',
      `${spawnsAtToggle} spawns at the toggle, ${countIn(supLog(), EXITED)} exits`);

    // The next genuine death: a respawn, a hello, a burst, and an exit nobody asked
    // for. Waited for by the exit count rather than by a duration, since a spawn on a
    // contended machine is the one part of this with no fixed cost.
    for (let i = 0; i < 1500 && countIn(supLog(), EXITED) < 2; i++) {
      await new Promise((done) => { setTimeout(done, 20); });
    }
    // A moment past the exit, because the two things being read are written by the
    // handler that the exit runs and by the socket it broadcasts on.
    await new Promise((done) => { setTimeout(done, 400); });
    ws.close();

    // **The read has to land on the second death and not on a third, and on the broken
    // build a third is only 250ms away.** The requested-restart branch respawns at
    // `RESPAWN_AFTER_CLEAN_MS` rather than at the backoff, so a mutated run that
    // over-ran this window would see grabber #3 die, produce the `lost` and the backoff
    // line the two rows below are asserting the absence of, and pass - and this tool has
    // no `NOT CAUGHT` branch, so it would exit 0 and read as clean. Two on both sides:
    // under the fix the next respawn is a second out, and under the mutation a third
    // death here means the fixture over-ran rather than the code being right.
    const exitsAtRead = countIn(supLog(), EXITED);
    check(exitsAtRead === 2,
      'and exactly one further death has happened when the reading is taken, so this is the next failure rather than a later one',
      `${exitsAtRead} exits`);
    // Printed rather than asserted, because it is the diagnostic that tells a fixture
    // which missed the window from a control that is blind: `takes effect on the next
    // spawn` means the reference was clear when the toggle arrived, and
    // `restarting grabber` means it was not. Asserting it would be asserting the
    // mechanism rather than what the mechanism costs, and it would hand the mutation a
    // third row to redden.
    console.log(`  ...   ${supLog().match(/\[server\] colour camera .*/)?.[0] ?? 'no colour line in the log at all'}`);

    // **Both rows below assert a shape rather than a presence, and they do so because
    // the presence versions passed the mutated build.** Measured on the merge that
    // brought this section alongside the capture format's band, at a moment the machine
    // was carrying another worktree's suite: `--mutate exit-keeps-the-child-reference`
    // reddened *nothing*, and since this tool has no `NOT CAUGHT` branch it exited 0 and
    // read as a clean pass. The diagnostic line above is what said otherwise - it printed
    // `restarting grabber` where the fixed build prints `takes effect on the next spawn`,
    // so the mutation had applied and reached the branch, and the two rows had simply
    // agreed with it.
    const after = statuses.slice(statusesBefore);
    // The broken build emits a `lost` of its own the instant the toggle calls
    // `stopGrabber` on the corpse, so the word is in this list either way: the fixed
    // build said `starting live lost` and the mutated one said `lost starting live
    // starting`. What separates them is order rather than membership. The death this row
    // is about is the one that follows the respawn coming up, so the `lost` has to sit
    // after a `live` - which also makes the row robust against the first death's own
    // `lost` arriving late and landing inside this slice, since that one is still in
    // front of the `live` that follows it.
    const liveAfter = after.indexOf('live');
    check(liveAfter >= 0 && after.indexOf('lost', liveAfter) > liveAfter,
      'the next failure is still reported lost, rather than being read as the restart the toggle never got to ask for',
      after.length ? `saw ${after.join(' ')}` : 'no status changes at all');
    // One backoff line per death, rather than more lines than before. `> backoffBefore`
    // was true of both builds - the fixed one went 1 to 2 and the mutated one 0 to 1 -
    // so the row measured that the log had grown rather than that the failure had been
    // spent. `backoffBefore` is reported and not asserted on because it is a race in the
    // fixture: `scheduleRetry` writes its line just after the exit the poll loop above
    // watches for, so whether it has landed by the time the toggle goes out depends on
    // the machine. The count at the read is not, since the read is 400ms past the exit.
    // The invariant is the one the defect breaks: the requested-restart branch returns
    // before `scheduleRetry` runs, so a death that was eaten is a death with no line.
    const backoffAtRead = countIn(supLog(), BACKOFF);
    check(backoffAtRead === exitsAtRead,
      'and it still counts toward the backoff, which is the table a machine with no sensor has to be able to spend',
      `${backoffAtRead} backoff lines against ${exitsAtRead} deaths, ${backoffBefore} before the toggle`);
    for (const p of servers.filter((s) => s.port === MAC_PORT + 1)) p.child.kill('SIGKILL');
  }

  // ---------------------------------------------------------- 6. the gallery page
  console.log('\n[library] the tiles: states, marks, buttons and the skim');
  {
    const { page, errors } = await openPage(browser, galleryPage(macUrl));
    await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const tiles = await page.evaluate('globalThis.__library.tiles()');
    // Keyed by hash, because the fixture deliberately contains two different takes
    // under one filename and a map keyed by name would silently keep one of them -
    // which would then have this tool asserting about a tile it never looked at.
    const byId = Object.fromEntries(tiles.map((t) => [t.hash, t]));
    const idOf = (id) => tiles.filter((t) => t.id === id);
    const one = (id) => { const hits = idOf(id); return byId[hits.find((t) => t.state !== 'remote')?.hash ?? hits[0].hash]; };

    // Skimming is a pointer affordance and the library also runs on a touch panel,
    // so nothing may be gated behind it. Every tile, every state.
    const labels = (t) => t.acts.map((a) => a.label);
    check(tiles.every((t) => t.acts.length >= 2),
      `every tile carries its actions without hover (${tiles.length} tiles)`);
    check(tiles.filter((t) => t.state === 'remote').every((t) => labels(t).includes('Download')),
      'a remote tile offers Download');
    check(tiles.filter((t) => t.state === 'local').every((t) => labels(t).includes('Open')),
      'a local tile offers Open');
    check(tiles.every((t) => labels(t).includes('Delete')), 'every tile offers Delete');
    check(tiles.filter((t) => t.state !== 'both').every((t) => !labels(t).includes('Reclaim')),
      'and Reclaim appears only where a second copy exists');

    // A take that cannot be opened says so on a disabled button rather than
    // throwing when pressed.
    check(one('no-hello-take').acts.find((a) => a.label === 'Open')?.disabled === true,
      'the Open on a take with no hello is disabled rather than a throw waiting to happen');
    check(one('local-clip').acts.find((a) => a.label === 'Open')?.disabled === false,
      'and an ordinary take opens');
    // The same pair for the format band. Both, because a page that greyed every Open
    // would pass the first of these on its own and the second is the one that says the
    // refusal is about this take rather than about the button.
    check(one('future-format-take').acts.find((a) => a.label === 'Open')?.disabled === true,
      'the Open on a take from a format this build cannot read is disabled the same way');
    check(one('generation-zero-take').acts.find((a) => a.label === 'Open')?.disabled === false,
      'while a take that declares no format at all still opens');

    // **One take, one reason, whichever surface is asking.** The page used to derive
    // this twice, twelve lines apart, and the two derivations disagreed on exactly one
    // shape: a take with a hello and no whole frame. Measured on the build before the
    // reason moved to the server, with this fixture: the badge read "the scan found no
    // whole frame in this take, so there is nothing here to draw or to open" while the
    // button beside it read "a take needs two frames to bracket a position" - a
    // sentence about a take that has one, over a take that has none.
    //
    // Nothing had noticed because nothing had ever built this take. The zero-frame
    // fixture carried no hello, so the button answered on its hello branch and never
    // reached the frame one; the take with a hello had a frame, where the two agreed.
    // Both observations skipped the one object that could tell them apart.
    const refused = one('hello-no-frames');
    const badgeWhy = refused.badges.find((b) => b.key === 'short')?.why ?? '';
    const buttonWhy = refused.acts.find((a) => a.label === 'Open')?.why ?? '';
    check(badgeWhy !== '' && badgeWhy === buttonWhy,
      'a take with a hello and no whole frame is refused in one sentence, the same on its badge and on its button',
      `badge ${JSON.stringify(badgeWhy)} vs button ${JSON.stringify(buttonWhy)}`);
    check(/no whole frame/.test(buttonWhy) && !/bracket a position/.test(buttonWhy),
      'and it is the sentence about the frame it does not have rather than the one about bracketing a position',
      JSON.stringify(buttonWhy));

    // **The same take, asked of the other surface**, because "whichever surface asks"
    // is a claim about more than one of them and the two rows above are both the
    // gallery. The menu resolves the Resume tile against `/library/all` and used to
    // hold an `openable` boolean with nothing telling it which half had fired, so it
    // named both causes at once - "no sensor hello, or under two frames" over a take
    // with a hello and one of the two conditions. A reader of this file could have
    // reverted that line and watched every row here stay green, which is a claim
    // asserted rather than enforced; `--mutate menu-decides-its-own-reason` is the
    // control that closes it.
    const refusedHash = one('hello-no-frames').hash;
    {
      const { page: menu, errors: menuErrors } = await openPage(browser, `${macUrl}/`);
      // Seeded and then reloaded, because the page resolves its tile once at load out
      // of storage another surface writes. Setting it on a page already resolved would
      // be asserting against the answer for an empty machine.
      await menu.evaluate(`localStorage.setItem('kinect.lastOpened', ${JSON.stringify(JSON.stringify({
        takeHash: refusedHash, takeId: 'hello-no-frames', project: null,
      }))})`);
      await menu.reload({ waitUntil: 'domcontentloaded' });
      await menu.waitForFunction('globalThis.__menu !== undefined', null, { timeout: 20000 });
      const resume = await menu.evaluate('globalThis.__menu.resume()');
      check(resume.href === '/gallery' && (resume.reason ?? '').includes(buttonWhy),
        'the menu refuses the same take in the same sentence the gallery put on its button',
        `menu ${JSON.stringify(resume.reason)} against button ${JSON.stringify(buttonWhy)}`);
      check(!/no sensor hello, or under two frames/.test(resume.reason ?? ''),
        'and not in a sentence naming both causes over a take that has one of them',
        JSON.stringify(resume.reason));
      check(menuErrors.length === 0, 'and the menu raises no page error resolving it', menuErrors.join(' | '));
      await menu.close();
    }

    // **Every refusal the server can send has a badge on the page, asked of the two
    // tables rather than of the refusals that exist today.** The page decides its own
    // badge text - a 228px poster is a page constraint - so the two lists are
    // genuinely separate and a key added to one and not the other is the failure. The
    // first spelling of the page's side was a two-case conditional with an else, which
    // would have badged a third refusal "no hello" over a take that has one, and a
    // format-version band is exactly that third refusal arriving. `recording` is left
    // out by name: `warningsOf` returns its own four-verb warning before it reaches
    // this table, which is the one sentence the page still writes and why.
    //
    // **Read off `OPEN_REFUSALS` and not off `/library/takes`**, because the fixture
    // library is not an enumeration of anything. The first spelling of this row
    // flattened the refusals the fixture takes happened to carry, which covers a key
    // exactly as far as some take here provokes it - so the next refusal, which will
    // apply to a take shape nothing in `buildFixture` writes, would be absent from the
    // list, absent from the page's table, and the row would print green having compared
    // two keys against two keys. The claim is that a reason added later is asked by
    // existing, and only the server's own declaration can carry it.
    //
    // Imported out of the staged tree rather than through this file's static import of
    // `server/library.js`, which reaches the repo: a server mutation is written into
    // the stage, so a row reading the repo's copy would be answering about an
    // unmutated build and `--mutate refusal-without-a-badge` would pass.
    const { OPEN_REFUSALS } = await import(pathToFileURL(join(root, 'server/library.js')).href);
    const badgeKeys = await page.evaluate('globalThis.__library.badgeKeys()');
    const serverKeys = Object.keys(OPEN_REFUSALS).filter((k) => k !== 'recording');
    const unbadged = serverKeys.filter((k) => !badgeKeys.includes(k));
    check(serverKeys.length > 0 && unbadged.length === 0,
      'every refusal the server can send has a badge on the page, so a reason added later is asked by existing',
      `server ${serverKeys.join(' ')} against page ${badgeKeys.join(' ')}`);
    // **Both directions, because they are two different bugs and one of them was
    // claimed rather than checked.** The comment here used to promise that every key in
    // the table is one the scanner can produce and then assert the containment the
    // other way round, which proves only that what arrived was declared. Under that
    // row, a refusal added to `OPEN_REFUSALS` and to `BADGES` with the `describeTake`
    // branch that pushes it forgotten stays green forever - a declared reason and a
    // badge for it that no take can ever wear, which is the enumeration drifting off
    // the code in the direction the row above cannot see either.
    const liveKeys = [...new Set((await getJson(`${macUrl}/library/takes`)).takes
      .flatMap((t) => t.openRefusals.map((r) => r.key)))];
    // `Object.hasOwn` and not `in`, which walks the prototype chain and would call a
    // take arriving with `toString` or `constructor` a declared refusal. The same
    // reading that took the prototype off the page's table, applied to the row that
    // checks it: an instrument asking `in` about keys that come off a wire is asking a
    // question `Object.prototype` gets to answer.
    check(liveKeys.every((k) => Object.hasOwn(OPEN_REFUSALS, k)),
      'every refusal a take actually arrived with is one the table declares',
      `${liveKeys.join(' ')} against ${Object.keys(OPEN_REFUSALS).join(' ')}`);
    // And back the other way. `recording` is excluded by name and for a reason of fact
    // rather than convenience: no take on this server is being written, so this
    // response cannot carry that key however correct the scanner is. It is proven to
    // arrive where it can arrive - the section that stands a recorder up and reads the
    // tile it draws - and a row here pretending otherwise would be asserting against
    // the fixture rather than against the code.
    //
    // What this puts on whoever adds the next refusal is a fixture take that provokes
    // it, which is the intended cost: a reason nothing here can reach is a reason
    // nothing here is testing.
    const unreachable = Object.keys(OPEN_REFUSALS).filter((k) => k !== 'recording' && !liveKeys.includes(k));
    check(unreachable.length === 0,
      'and every refusal the table declares is one some take here actually arrives with, so a branch forgotten in the scanner is not a badge nobody can earn',
      unreachable.length ? `declared and never produced: ${unreachable.join(' ')}` : liveKeys.join(' '));

    // **The predicate against the list, on every take rather than on the branches.** The
    // whole argument for the table is that `openable` is "the list is empty" and not a
    // second expression of the same thing - and `describeTake` has two branches, one of
    // which derived it and one of which carried the list and a hardcoded `openable: false`
    // beside it. They agreed, so nothing was wrong yet; the failure waiting there is a
    // disabled Open button whose reason is the empty string, since `cannotOpen` quotes a
    // list that had gone while the boolean stayed.
    //
    // Asked of every take in the listing, which is what makes it a claim about the scanner
    // rather than about the takes this fixture happens to hold - a third branch added
    // later is asked by existing. The two rows above cannot reach it from either
    // direction: they compare *which keys* the tables know, and this is about a take whose
    // keys are all perfectly declared and whose boolean stopped following them.
    const disagreed = (await getJson(`${macUrl}/library/takes`)).takes
      .filter((t) => t.openable !== (t.openRefusals.length === 0));
    check(disagreed.length === 0,
      'and every take\'s openable is its refusal list being empty, rather than a second answer to the same question',
      disagreed.length
        ? disagreed.map((t) => `${t.id} openable=${t.openable} with ${t.openRefusals.length} refusals`).join(', ')
        : 'agreed on every take');

    // Marks on the tile's scrub bar, at their source fraction. The two that a
    // fraction gets wrong on its own are checked by name: source zero has to land
    // at the left edge rather than being falsy-dropped, and one past the end has to
    // clamp rather than run off the tile.
    const marks = one('local-clip').marks;
    check(marks.length === 4, 'a take\'s marks are on the tile\'s scrub bar', `${marks.length} ticks`);
    check(marks[0] === 0, 'a mark at source zero sits at the left edge rather than vanishing');
    check(marks[marks.length - 1] === 100, 'and a mark past the end clamps to the right edge');
    check(tiles.some((t) => t.marks.length === 1), 'the single-mark case renders',
      `${tiles.filter((t) => t.marks.length === 1).length} tiles with one mark`);
    check(tiles.some((t) => t.marks.length === 0), 'and so does the no-mark case');

    // Remote tiles decimate visibly and say so - a gallery that skimmed both
    // identically would promise a responsiveness the architecture does not have.
    check(tiles.filter((t) => t.state === 'remote').every((t) => /decimated/.test(t.coarse ?? '')),
      'a remote tile says it is decimated');
    check(tiles.filter((t) => t.state !== 'remote').every((t) => t.coarse === null),
      'and a local one does not');

    // The skim draws a frame from the take rather than a placeholder, and a
    // different position draws a different frame. Read off the canvas, because a
    // position readout that moved while the picture did not is exactly what a
    // state-only assertion would pass.
    const clipHash = one('local-clip').hash;
    await page.evaluate(`globalThis.__library.drawn(${JSON.stringify(clipHash)})`);
    const at0 = await page.evaluate(`globalThis.__library.poster(${JSON.stringify(clipHash)})`);
    await page.evaluate(`globalThis.__library.skimTo(${JSON.stringify(clipHash)}, 0.9)`);
    const at90 = await page.evaluate(`globalThis.__library.poster(${JSON.stringify(clipHash)})`);
    check(at0.mean > 1, 'the poster is a frame of the take rather than an empty canvas', `mean ${at0.mean.toFixed(1)}`);
    // The signature rather than the mean, and the reason is that the mean cannot
    // see this: two positions of one take are the same room a second apart, so
    // their average brightness agrees to within its own noise while every pixel
    // that a body moved across has changed. A threshold on the mean would be a
    // threshold on sampling residual.
    check(at90.signature !== at0.signature, 'and skimming to another position draws another frame',
      `${at0.signature} then ${at90.signature}, means ${at0.mean.toFixed(2)} and ${at90.mean.toFixed(2)}`);
    const remoteHash = tiles.find((t) => t.state === 'remote')?.hash;
    check(remoteHash !== undefined, 'a remote take is present to skim');
    // **Skipped, with the row still counted, when the link is down**, the same shape
    // the way-back anchor above already uses. Any mutation that takes the node off -
    // `refusals-must-be-nonempty` is the one that found this - leaves the shelf with no
    // remote tile, and `drawn(undefined)` then waits out its own timeout and throws
    // `tile undefined never drew 1 frames`, which ended the run at 105 of 366 with
    // eight rows correctly red and two hundred and sixty claims never measured. A
    // control is supposed to redden what carries its claim; one that stops the run has
    // the tool as its blast radius.
    if (remoteHash !== undefined) {
      await page.evaluate(`globalThis.__library.drawn(${JSON.stringify(remoteHash)})`);
      const remote = await page.evaluate(`globalThis.__library.poster(${JSON.stringify(remoteHash)})`);
      // Sixteen times fewer samples reach the canvas, so a decimated skim is
      // measurably sparser rather than merely labelled as such. This is the arm the
      // label alone cannot carry: a tile that said "decimated" and fetched a full
      // frame would pass every assertion above it.
      check(remote.mean > 0 && remote.mean < at0.mean * 0.5,
        'a decimated skim is measurably sparser than a local one, not just labelled',
        `local ${at0.mean.toFixed(1)} against remote ${remote.mean.toFixed(1)}`);
    } else {
      check(false, 'a decimated skim is measurably sparser than a local one, not just labelled',
        'there is no remote tile to skim');
    }

    // Every tab shows a count, and a count that disagreed with the tiles it filters
    // to would be the readout lying about the library rather than about a take.
    const counts = await page.evaluate(`(() => {
      const out = {};
      for (const tab of document.querySelectorAll('.tab')) {
        globalThis.__library.filter(tab.dataset.filter);
        out[tab.dataset.filter] = { label: tab.textContent, shown: document.querySelectorAll('.tile').length };
      }
      globalThis.__library.filter('all');
      return out;
    })()`);
    const agrees = Object.entries(counts).every(([, v]) => Number(v.label.match(/(\d+)$/)?.[1]) === v.shown);
    check(agrees, 'each tab\'s count is the number of tiles it filters to',
      Object.entries(counts).map(([k, v]) => `${k}:${v.label.trim()}=${v.shown}`).join(' '));
    check(Object.keys(counts).join(',') === 'all,local,remote,both',
      'and the tabs are exactly the states a take can be in', Object.keys(counts).join(','));

    // **What the confirm promises against what the server does.** A `both` take's
    // delete dialog offered "a copy exists on both machines; this removes the one
    // here", and `serveRemoval` answers that exact request with a 409 - delete is
    // the last copy, reclaim is a copy while another survives. It errs safe, which
    // is why it survived review, and a confirm that describes an outcome the server
    // declines is a confirm nobody can trust the next time it says something is
    // irreversible. So the page's own dialog is read here and the server is asked
    // the same question, and the two have to agree.
    const bothHash = tiles.find((t) => t.state === 'both')?.hash;
    const bothTakeId = tiles.find((t) => t.state === 'both')?.id;
    check(bothHash !== undefined, 'a take in state both is on screen to ask about', String(bothTakeId));
    const bothConfirm = await page.evaluate(`globalThis.__library.confirmFor(${JSON.stringify(bothHash)}, 'Delete')`);
    const serverSays = await post(`${macUrl}/library/delete/${bothTakeId}`,
      { hash: one(bothTakeId)?.hash ?? bothHash, confirm: true });
    check(/exists on .* as well|reclaim removes a copy/.test(serverSays.error ?? ''),
      'the server refuses to delete a take that exists in two places, which is the behaviour the dialog has to describe',
      (serverSays.error ?? 'ACCEPTED').slice(0, 70));
    check(!/removes the one here/.test(bothConfirm.warn) && /refused|two/.test(bothConfirm.warn),
      'and the confirm says so rather than promising to remove the copy here',
      bothConfirm.warn.slice(0, 90));
    check(bothConfirm.goDisabled === true,
      'with no destructive button to press, so the operator is not agreeing to something that will be declined');
    const localConfirm = await page.evaluate(`globalThis.__library.confirmFor(${JSON.stringify(one('local-clip').hash)}, 'Delete')`);
    // The control: the case delete *is* for still offers it, or the row above would
    // pass against a dialog that had simply been disabled everywhere.
    check(localConfirm.goDisabled === false && /only copy/.test(localConfirm.warn),
      'while a take that really is the last copy still warns and still offers the button',
      localConfirm.warn.slice(0, 70));
    // **And the disabled one looks disabled**, which every row above this passes
    // without. `dialog .row .act.confirm` is three classes and an element where
    // `.act:disabled` is one class and a pseudo-class, so the accent won on
    // specificity and both dialogs drew a lit, pressable-looking button beside the
    // sentence explaining why pressing it would be refused. Functionally disabled the
    // whole time - which is precisely why nothing caught it, since every assertion
    // here was about `disabled` being true and it was.
    check(bothConfirm.goPaint !== localConfirm.goPaint,
      'and it is painted as disabled rather than merely being disabled, which no assertion on the property can see',
      `refused: ${bothConfirm.goPaint} against offered: ${localConfirm.goPaint}`);

    // ---- 6a. the way out
    //
    // **The gallery shipped with none.** Open leaves for the editor, Download and
    // Delete stay here, and the browser's own back button is not on the node's touch
    // panel - so a kiosk that had reached the gallery had reached the end of the
    // program. An anchor rather than a button, and the row asserts the tag as well as
    // the destination: a button that assigns `location.href` is a place only the page
    // knows about, where an `<a href>` is a URL a browser can show, open in a second
    // tab and go back from.
    const back = await page.evaluate(`(() => {
      const a = document.getElementById('toMenu');
      return a ? { tag: a.tagName, href: a.getAttribute('href'), text: a.textContent.trim() } : null;
    })()`);
    check(back?.tag === 'A' && back.href === '/',
      'the gallery has a way back to the menu, and it is a real URL rather than a button that navigates',
      JSON.stringify(back));
    // And it goes where it says. Asserted by following it, because a href is a claim
    // and the menu answering is the fact - the same reading the confirm rows above
    // get, where the dialog's copy is checked against what the server actually does.
    //
    // **Skipped, with the row still counted, when there is no anchor to follow.** The
    // mutation that removes the way back reddens the row above and then leaves this
    // one clicking a selector that will never exist - thirty seconds of Playwright
    // timeout and then a throw that ends the whole run at 95 of 317 assertions. A
    // mutation is supposed to redden the rows that carry its claim and let every other
    // claim still be measured; a mutation that stops the run is one whose blast radius
    // is the tool.
    if (back) {
      await page.click('#toMenu');
      await page.waitForFunction('globalThis.__menu !== undefined', null, { timeout: 20000 });
      check(new URL(page.url()).pathname === '/', 'and following it arrives at the menu',
        `${page.url()} defines __menu`);
    } else {
      check(false, 'and following it arrives at the menu', 'there is no anchor to follow');
    }
    // Back to the gallery whichever branch ran, so every row below this starts from
    // one state rather than from whichever page the mutation happened to leave open.
    await page.goto(galleryPage(macUrl), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });

    // The surface name moved into the real back control. Geometry is read off the
    // rendered bar rather than inferred from its stylesheet, because a fixed rule
    // that lost its top edge would still leave a valid anchor in the document.
    const galleryShell = await page.evaluate(`(() => {
      const bar = document.getElementById('appBar');
      const back = document.getElementById('toMenu');
      const active = document.querySelector('.tab[aria-pressed="true"]');
      if (!bar || !back) return null;
      const r = bar.getBoundingClientRect();
      return {
        top: Math.round(r.top), height: Math.round(r.height),
        arrow: back.querySelector('.arrow')?.textContent.trim() ?? null,
        label: back.querySelector('span:last-child')?.textContent.trim() ?? null,
        active: active?.dataset.filter ?? null,
      };
    })()`);
    // 38 and not 32, which is the number this row carried until the shared bar grew.
    // `nav.css` owns the height - one `.appbar` rule for the editor, the recorder and
    // this page - and `editor-check`'s own bar row already reads 38 off the editor. Two
    // instruments naming one constant and disagreeing about it means one of them is
    // asserting a page nobody ships, and the sheet that draws the bar is the tiebreak.
    check(galleryShell?.top === 0 && galleryShell.height === 38
      && galleryShell.arrow === '<' && galleryShell.label === 'Gallery',
      'the gallery names itself in a fixed application bar at the top edge', JSON.stringify(galleryShell));
    const wasAt = page.url();
    await page.click('.tab[data-filter="all"]');
    await new Promise((done) => { setTimeout(done, 300); });
    check(page.url() === wasAt && await page.evaluate('document.querySelector(".tab[data-filter=all]").getAttribute("aria-pressed")') === 'true',
      'and the active filter marks the current view without navigating or reloading it', page.url());

    await page.evaluate('globalThis.__library.drawn(document.querySelector(".tile").dataset.hash)');

    // ---- 6b. every tile is the same size
    //
    // **Measured off `getBoundingClientRect`, never off the CSS.** The rule the
    // poster's height used to come from also looked like it should hold - it was a
    // width measured at first paint, correct then and 2.496:1 against the 16:9 it
    // draws after a window went from 1512 to 700. What a proof tool can read is the
    // box the browser produced.
    //
    // Two widths and a resize between them, including the narrow one-column layout
    // where the fixed desktop card becomes fluid. The two ways a tile changed size
    // showed up under different conditions: the warnings moved a tile's height
    // against its neighbours at every width, and the poster's box only drifted once
    // something changed the card's width. A single fixed-card arm passes on a build
    // carrying the second bug because every desktop column is deliberately 252px.
    const geometryAt = async (width) => {
      await page.setViewportSize({ width, height: 900 });
      // Two frames, so the grid has reflowed its columns and the ResizeObserver has
      // followed the boxes before anything is read.
      await page.evaluate('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))');
      return page.evaluate('globalThis.__library.geometry()');
    };
    const spreadOf = (boxes, of) => Math.max(...boxes.map(of)) - Math.min(...boxes.map(of));
    const overlapsIn = (boxes) => boxes.filter((b) => boxes.some(
      (o) => o !== b && o.top < b.bottom - 0.5 && o.bottom > b.top + 0.5 && Math.abs(o.top - b.top) > 0.5,
    ));
    for (const width of [900, 520]) {
      const boxes = await geometryAt(width);
      const flagged = boxes.filter((b) => ['three-warning-take', 'truncated-take', 'no-hello-take'].includes(b.id));
      check(flagged.length === 3,
        `the three shapes that used to differ in height are on screen at ${width}px`,
        flagged.map((b) => b.id).join(' '));
      check(spreadOf(boxes, (b) => b.height) < 0.5,
        `every tile is the same height at ${width}px, warnings and all`,
        `${boxes.length} tiles, spread ${spreadOf(boxes, (b) => b.height).toFixed(2)}px, `
        + `min ${Math.min(...boxes.map((b) => b.height)).toFixed(2)}`);
      check(boxes.every((b) => Math.abs(b.posterRatio - 16 / 9) < 0.02),
        `and every poster is 16:9 at ${width}px, which is the frame an export produces`,
        boxes.map((b) => b.posterRatio.toFixed(3)).join(' '));
      // The two ways a fixed-height row lies about what it holds. A row that wrapped
      // is a tile that grew; a row whose content overflows drew less than it has, and
      // the second is why the warnings are badges over the poster rather than text in
      // a row that would have had to clip them.
      check(boxes.every((b) => !b.factsOverflow && !b.actsWrapped),
        `no fact row is clipped and no action row has wrapped at ${width}px`,
        boxes.filter((b) => b.factsOverflow || b.actsWrapped).map((b) => b.id).join(' ') || 'all clear');
      check(overlapsIn(boxes).length === 0,
        `and no two rows overlap at ${width}px, which is what an intrinsic height nobody could rely on produced`,
        overlapsIn(boxes).map((b) => b.id).join(' ') || `${new Set(boxes.map((b) => Math.round(b.top))).size} rows`);
    }
    // The backing store follows the rendered box rather than being assigned once.
    // Compare both dimensions with the box at both widths: checking only that the
    // width changed would pass on a stale-height canvas stretched over the fluid
    // card, which is the bug this probe exists to distinguish.
    const wide = await geometryAt(900);
    const narrow = await geometryAt(520);
    const backingFits = (box) => box.canvasPixels.w === Math.round(box.width - 2)
      && box.canvasPixels.h === Math.round(box.posterHeight);
    check(backingFits(wide[0]) && backingFits(narrow[0])
      && wide[0].canvasPixels.w !== narrow[0].canvasPixels.w,
      'a resize moves both dimensions of the canvas backing store with the box it is shown in',
      `${wide[0].canvasPixels.w}x${wide[0].canvasPixels.h} over ${wide[0].width.toFixed(1)}x${wide[0].posterHeight.toFixed(1)}, then `
      + `${narrow[0].canvasPixels.w}x${narrow[0].canvasPixels.h} over ${narrow[0].width.toFixed(1)}x${narrow[0].posterHeight.toFixed(1)}`);
    await geometryAt(1100);

    // ---- 6c. the contextual menu
    //
    // Rendered into every tile hidden rather than built on the first press, which is
    // what lets the enumeration below read it out of the document. Opened by tap and
    // never by hover, because the panel this runs on has no pointer at all - the same
    // rule the action buttons have always been held to.
    const clipHash2 = one('local-clip').hash;
    const opened = await page.evaluate(`globalThis.__library.openMenu(${JSON.stringify(clipHash2)})`);
    check(opened.open === true, 'the ⋯ on a tile opens a menu on a tap',
      opened.items.map((i) => `${i.item}${i.disabled ? '(off)' : ''}`).join(' '));
    check(opened.items.some((i) => i.item === 'rename' && !i.disabled)
      && opened.items.some((i) => i.item === 'reveal' && !i.disabled),
      'a local take offers rename and reveal');
    check(opened.items.some((i) => i.item === 'reclaim' && i.disabled),
      'and offers reclaim disabled rather than absent, because a control that vanishes reads as the page being broken');
    const bothMenu = await page.evaluate(`globalThis.__library.openMenu(${JSON.stringify(bothHash)})`);
    check(bothMenu.items.some((i) => i.item === 'reclaim' && !i.disabled),
      'while a take in two places offers it for real - the positive twin, without which the row above passes on a menu disabled everywhere');
    const remoteHash2 = tiles.find((t) => t.state === 'remote').hash;
    const remoteMenu = await page.evaluate(`globalThis.__library.openMenu(${JSON.stringify(remoteHash2)})`);
    check(remoteMenu.items.filter((i) => ['rename', 'reveal'].includes(i.item)).every((i) => i.disabled),
      'a take that is only on the node offers neither: this side renames no files over there and has no file here to show',
      remoteMenu.items.map((i) => `${i.item}=${i.disabled}`).join(' '));
    // The sentences the poster's badges are short for. In the menu because a tap
    // reaches it and a hover does not, which is the whole reason the warnings could
    // not simply become tooltips when they came out of the layout.
    const warnMenu = await page.evaluate(`globalThis.__library.openMenu(${JSON.stringify(one('three-warning-take').hash)})`);
    const warnTile = one('three-warning-take');
    check(eq([...warnTile.flags].sort(), ['no-hello', 'short', 'truncated']),
      'a take with three warnings carries all three as badges over its poster', warnTile.flags.join(' '));
    check(/sensor hello/.test(warnMenu.note) && /no whole frame/.test(warnMenu.note) && /mid-frame/.test(warnMenu.note),
      'and the sentence behind each one is in the menu, where a finger can reach it',
      warnMenu.note.replace(/\n/g, ' | ').slice(0, 130));
    // **And the menu is on screen, which every row above this passes without.** The
    // items are in the document whether or not anything can be read, so "the menu
    // offers rename" and "the sentence is in the menu" are both true of a menu the
    // scroll container has cut the top off - which is what the three-warning tile had,
    // its first item clipped away because it is in the top row and the menu opened
    // upward into the grid's edge. The tallest menu on the tile most in need of it.
    const menuBoxes = [];
    for (const t of tiles) {
      const m = await page.evaluate(`globalThis.__library.openMenu(${JSON.stringify(t.hash)})`);
      if (!m.inside) {
        menuBoxes.push(`${t.id}(${t.state}) ${m.clipped.above > 0 ? `${m.clipped.above}px above` : `${m.clipped.below}px below`}`
          + ` of ${m.clipped.height}px, room ${m.room.above}/${m.room.below}, ${m.placed}`);
      }
      await page.mouse.click(4, 4);
    }
    check(menuBoxes.length === 0,
      'and every tile\'s menu opens inside the grid rather than under its edge, whichever row the tile is in',
      menuBoxes.join('; ') || `${tiles.length} tiles, every menu fully on screen`);
    // Zero frames and one frame are different facts, and the badge distinguishes
    // them. A take cut before its first whole frame draws nothing at all - the skim
    // never asks for a frame it does not have, which is how the 404 that surfaced
    // this was found - where a single-frame take has one and draws it.
    check(warnTile.flags.includes('short') && /no frames/.test(warnMenu.note.match(/^.*no frames.*$/m)?.[0] ?? ''),
      'and a take with no whole frame says so rather than saying it has fewer than two',
      warnMenu.note.split('\n').find((l) => /frame/.test(l)) ?? '');
    // The format band's badge and the sentence behind it, read the same way. The
    // sentence is asserted to carry the generation it found rather than merely to
    // mention a format, because the number is the only part of it an operator can do
    // anything with - and it is built from the constant rather than written down, so
    // this row moves with the band instead of having to be swept when it does.
    const fmtTile = one('future-format-take');
    const fmtMenu = await page.evaluate(`globalThis.__library.openMenu(${JSON.stringify(fmtTile.hash)})`);
    check(fmtTile.flags.includes('format'),
      'a take from a format this build cannot read carries a badge over its poster', fmtTile.flags.join(' ') || 'no badges');
    check(new RegExp(`capture format ${CAPTURE_FORMAT + 1}\\b`).test(fmtMenu.note)
      && new RegExp(`reads format ${CAPTURE_FORMAT}\\b`).test(fmtMenu.note),
      'and the sentence in the menu names the generation it found and the one this build reads',
      fmtMenu.note.replace(/\n/g, ' | ').slice(0, 130) || 'the menu says nothing');
    const zeroTile = one('generation-zero-take');
    check(!zeroTile.flags.includes('format'),
      'while a take that declares no format carries no such badge, so the badge is about the generation and not about the key being absent',
      zeroTile.flags.join(' ') || 'no badges');
    await page.mouse.click(4, 4);
    const oneFrameTile = one('one-frame-take');
    check(oneFrameTile.flags.includes('short'),
      'while the one-frame take still carries the badge, so the row above is about the wording rather than about the badge going away',
      oneFrameTile.flags.join(' '));
    await page.mouse.click(4, 4);
    check(await page.evaluate('globalThis.__library.menuOpen()') === 0,
      'a tap anywhere else closes it');

    // ---- 6d. the viewer
    //
    // A 228px tile is enough to recognise a take and not enough to look at one, so
    // the grid answers "which take" and this answers "what is in it". Driven through
    // the poster the way an operator opens it rather than through the function that
    // opens it, because a tap that scrubs and a tap that opens are told apart by four
    // pixels of travel and that is exactly the sort of rule a direct call walks past.
    const posterBox = await page.evaluate(`(() => {
      const sel = '.tile[data-hash="' + CSS.escape(${JSON.stringify(clipHash2)}) + '"] .skim';
      const r = document.querySelector(sel).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    await page.mouse.click(posterBox.x, posterBox.y);
    await page.evaluate('globalThis.__library.viewer.drawn(1)');
    const shown = await page.evaluate('globalThis.__library.viewer.state()');
    check(await page.evaluate('globalThis.__library.viewer.isOpen()') === true,
      'a tap on a tile\'s poster opens that take large', `${shown?.id}, ${shown?.frames} frames`);
    check(shown.stage.width > 700 && Math.abs(shown.stage.ratio - 16 / 9) < 0.02,
      'and the stage is materially bigger than a tile and the same 16:9',
      `${Math.round(shown.stage.width)}px at ${shown.stage.ratio.toFixed(3)}`);
    const vFirst = await page.evaluate('globalThis.__library.viewer.picture()');
    check(vFirst.mean > 1, 'it draws a frame of the take rather than an empty canvas',
      `mean ${vFirst.mean.toFixed(1)}`);
    // **A magnification of the tile and not a sparser copy of it.** Two adjacent depth
    // samples land `scale / fx` pixels apart on screen, and the scale follows the
    // canvas height - so one pixel each is dense at a 228px tile and threadbare four
    // times larger, and the viewer's first build drew the same take as a faint dot
    // screen. The ratio against the tile rather than a level, so the row survives a
    // fixture with a different scene in it.
    //
    // **The threshold is 0.7 and the first one was 0.25, which the broken build
    // cleared.** It was set from a measurement taken at devicePixelRatio 2, where a
    // one-pixel sample gives 0.07 - and this runs at 1, where the same build gives
    // 0.28. So the gate was calibrated on conditions that are not the run's and was
    // passed marginally by the run that matters, which this repo has recorded once
    // already about an fps floor. Measured here, at the ratio and the viewport this
    // check actually uses: 0.28 with a fixed one-pixel sample against 1.00 with the
    // sample sized from the spacing, and the tile's own poster bit-identical across
    // both - same mean, same signature - because the size floors at one where the tile
    // already covers.
    const tileMean = (await page.evaluate(`globalThis.__library.poster(${JSON.stringify(clipHash2)})`)).mean;
    check(vFirst.mean > tileMean * 0.7,
      'and it is a magnification of the tile rather than a sparser copy of it - the sample size follows the canvas',
      `tile ${tileMean.toFixed(1)}, stage ${vFirst.mean.toFixed(1)}, ratio ${(vFirst.mean / tileMean).toFixed(2)} (broken build measures 0.28 here)`);

    // **A frame and not a fraction of the duration.** This is why `createSkim` counts
    // in indices: a viewer stepping by a percentage lands between two frames and
    // rounds to whichever is nearer, so pressing right twice can show one picture
    // twice - which reads as a stuck viewer and is a rounding rule.
    const drawsBefore = await page.evaluate('globalThis.__library.viewer.draws()');
    await page.evaluate('globalThis.__library.viewer.key("ArrowRight")');
    await page.evaluate(`globalThis.__library.viewer.drawn(${drawsBefore + 1})`);
    const stepped = await page.evaluate('globalThis.__library.viewer.state()');
    check(stepped.index === shown.index + 1, 'an arrow key steps exactly one frame',
      `${shown.index} -> ${stepped.index} of ${stepped.frames}`);
    await page.evaluate('globalThis.__library.viewer.key("ArrowRight", true)');
    await page.evaluate(`globalThis.__library.viewer.drawn(${drawsBefore + 2})`);
    const jumped = await page.evaluate('globalThis.__library.viewer.state()');
    check(jumped.index === stepped.index + 10, 'and shift steps ten',
      `${stepped.index} -> ${jumped.index}`);
    await page.evaluate('globalThis.__library.viewer.key("End")');
    await page.evaluate(`globalThis.__library.viewer.drawn(${drawsBefore + 3})`);
    const atEnd = await page.evaluate('globalThis.__library.viewer.state()');
    const vLast = await page.evaluate('globalThis.__library.viewer.picture()');
    check(atEnd.index === atEnd.frames - 1, 'end goes to the last frame the take has',
      `${atEnd.index} of ${atEnd.frames}`);
    // Read off the canvas, because a readout that moved while the picture did not is
    // exactly what a state-only assertion passes - the same reason the tile's skim row
    // above compares signatures rather than positions.
    check(vLast.signature !== vFirst.signature,
      'and the picture on the stage is a different frame, not a readout that moved on its own',
      `${vFirst.signature} then ${vLast.signature}, means ${vFirst.mean.toFixed(2)} and ${vLast.mean.toFixed(2)}`);
    await page.evaluate('globalThis.__library.viewer.clickMark(0)');
    await page.evaluate(`globalThis.__library.viewer.drawn(${drawsBefore + 4})`);
    const atMark = await page.evaluate('globalThis.__library.viewer.state()');
    check(atMark.index !== atEnd.index && atMark.marks.length === 4,
      'a mark on the viewer\'s bar is a control rather than a decoration: pressing one seeks to it',
      `${atEnd.index} -> ${atMark.index}, ${atMark.marks.length} marks`);
    // Between takes without going back to the grid, which is what makes this a way of
    // browsing footage rather than a detail sheet.
    const drawsAtMark = await page.evaluate('globalThis.__library.viewer.draws()');
    await page.evaluate('globalThis.__library.viewer.key("ArrowDown")');
    await page.evaluate(`globalThis.__library.viewer.drawn(${drawsAtMark + 1})`);
    const nextTake = await page.evaluate('globalThis.__library.viewer.state()');
    check(nextTake.id !== atMark.id && await page.evaluate('globalThis.__library.viewer.isOpen()') === true,
      'and down moves to the next take without closing', `${atMark.id} -> ${nextTake.id}`);
    await page.keyboard.press('Escape');
    check(await page.evaluate('globalThis.__library.viewer.isOpen()') === false,
      'escape closes it, which is the dialog element\'s own behaviour rather than a second rule');

    // ---- 6d-ii. the two surfaces offer one take one set of things to do
    //
    // **The class behind four separate findings, closed here rather than one instance
    // at a time.** The tile and the viewer used to decide independently what a take
    // allowed, in two blocks that read almost identically, and they drifted four times:
    // Delete live on the viewer for a node-only take, the `VALID_ID` name rule known to
    // one surface and not the other, Download offered on a take still being recorded,
    // and Download surviving a reclaim. Each was fixed as an instance and the next one
    // arrived on the following round.
    //
    // What made it structural is that arrow-browsing reaches takes *without* going
    // through `buildTile`, so the viewer sees takes no tile was ever built for and any
    // rule living in the tile was a rule the viewer had never been told. The page now
    // has one `availability(take)` that both surfaces render, and this asserts the
    // consequence rather than the implementation: for **every take in the listing**, the
    // two surfaces agree on the actions, on which are disabled, and on the sentences the
    // menu gives for the disabled ones.
    //
    // Every take rather than a chosen one, because the disagreements were all about a
    // take in some particular state - being recorded, only on the node, named outside
    // the rule - and a row that picked one take would be a row that happened to pick the
    // agreeing case. The fixture deliberately holds all of those.
    {
      const listed = await page.evaluate('globalThis.__library.tiles()');
      check(listed.length >= 3, 'the grid holds several takes, so the comparison below has range',
        `${listed.length} tiles: ${listed.map((t) => t.state).join(' ')}`);
      const disagreed = [];
      for (const tile of listed) {
        await page.evaluate(`globalThis.__library.viewer.open(${JSON.stringify(tile.hash ?? tile.id)})`);
        // **Re-opened until it holds rather than waited on for a guessed interval.**
        // `close` on a dialog is dispatched as a queued task, so an open in the very
        // next turn can be torn down by the handler it beat and `state()` reads null.
        // That is a race in this loop rather than anything about the take - it showed up
        // as one tile in nine "not opening" on a run whose previous run had agreed on
        // all nine, and a fixed delay only moved how often. Retrying names the cause: if
        // a second open with a turn in between still reads null, something is actually
        // wrong with that take rather than with the timing.
        let seen = null;
        for (let attempt = 0; attempt < 3 && seen === null; attempt++) {
          await new Promise((r) => setTimeout(r, 120));
          seen = await page.evaluate('globalThis.__library.viewer.state()');
          if (seen === null) {
            await page.evaluate(`globalThis.__library.viewer.open(${JSON.stringify(tile.hash ?? tile.id)})`);
          }
        }
        if (seen === null) { disagreed.push(`${tile.id}: the viewer would not open on it`); continue; }
        const sameActs = JSON.stringify(tile.acts.filter((a) => a.label !== '⋯'))
          === JSON.stringify((seen.acts ?? []).filter((a) => a.label !== '⋯'));
        if (!sameActs) {
          disagreed.push(`${tile.id}: tile ${JSON.stringify(tile.acts)} vs viewer ${JSON.stringify(seen.acts)}`);
        }
        const menuOf = (m) => JSON.stringify((m ?? []).map((i) => [i.item, i.disabled, i.why]));
        if (menuOf(tile.menu) !== menuOf(seen.menu)) {
          disagreed.push(`${tile.id}: menu ${menuOf(tile.menu)} vs ${menuOf(seen.menu)}`);
        }
      }
      check(disagreed.length === 0,
        'every take is offered the same actions, the same disabling and the same reasons on both surfaces',
        disagreed.length ? disagreed[0].slice(0, 150) : `${listed.length} takes agree`);
      await page.evaluate('globalThis.__library.viewer.close()');
    }

    // ---- 6d-iii. the viewer stays reachable from a keyboard across its own rebuilds
    //
    // **Five findings on this branch were one property, and it had no durable control
    // until here.** The viewer rebuilds itself constantly - `#vActs` is emptied and
    // refilled and the ⋯ is cloned on every repaint - and each rebuild is a chance to
    // destroy the node holding focus. When that happens the caret falls to the body,
    // the viewer's keydown handler stops receiving anything, and browsing dies silently
    // after exactly one step. Silently is the problem: every pixel on screen still looks
    // right, so nothing short of pressing a second key can tell.
    //
    // The rows below press the second key. Each drives a different way of rebuilding,
    // because the ways are genuinely different mechanisms and each was fixed separately:
    // an arrow (the rebuild arrives with focus live), and a menu selection (the menu is
    // hidden first, which blurs whatever was inside it). What they share is the reading
    // taken afterwards, which is never "is focus somewhere plausible" but "does the next
    // key still do its job" - a state assertion would pass against focus parked on a
    // disabled button.
    //
    // Keys go to `document.activeElement` rather than to the dialog. Dispatching at the
    // dialog delivers them however focus is arranged, so an arm walking takes with the
    // arrows passed against a build a person could not have walked - the check was
    // measuring its own dispatch.
    {
      // **Opened at the top of the grid, because two presses need somewhere to go.**
      // Aiming this at a named fixture is how the first version failed: the grid sorts
      // newest first, the take it picked sat second from the bottom, and the second
      // arrow had nothing below it to move to. The row then read as focus being broken
      // while the build was fine - a mis-aimed row and a finding are indistinguishable
      // from the failure text, which is why this reads the order off the page instead.
      const walkable = await page.evaluate('globalThis.__library.tiles()');
      check(walkable.length >= 3, 'the grid has takes below the first, so two arrows have room',
        `${walkable.length} tiles`);
      await page.evaluate(`globalThis.__library.viewer.open(${JSON.stringify(walkable[0].hash ?? walkable[0].id)})`);
      await page.evaluate('globalThis.__library.viewer.drawn(1)');
      check(await page.evaluate('globalThis.__library.viewer.focusInside()') === true,
        'a viewer opened from the page puts focus inside itself, which is where a key has to land',
        await page.evaluate("document.activeElement?.dataset?.act ?? document.activeElement?.id ?? document.activeElement?.tagName"));

      // An arrow rebuilds the header for the next take, which removes the very node the
      // focus was on. Two presses rather than one: the first is what breaks focus and
      // the second is what notices.
      const firstId = (await page.evaluate('globalThis.__library.viewer.state()'))?.id;
      await page.evaluate('globalThis.__library.viewer.key("ArrowDown")');
      await new Promise((r) => setTimeout(r, 600));
      const secondId = (await page.evaluate('globalThis.__library.viewer.state()'))?.id;
      check(await page.evaluate('globalThis.__library.viewer.focusInside()') === true,
        'and focus is still inside it after the rebuild an arrow causes', `${firstId} -> ${secondId}`);
      await page.evaluate('globalThis.__library.viewer.key("ArrowDown")');
      await new Promise((r) => setTimeout(r, 600));
      const thirdId = (await page.evaluate('globalThis.__library.viewer.state()'))?.id;
      check(thirdId !== secondId && secondId !== firstId,
        'so a second arrow moves a second take, which is the reading a focus check cannot fake',
        `${firstId} -> ${secondId} -> ${thirdId}`);

      // Choosing a menu item hides the menu, and hiding an ancestor of the focused
      // element drops focus to the body. Reveal on purpose: it neither repaints nor
      // opens a dialog, so nothing else would put focus back and any path that did
      // would hide what this row is about.
      //
      // Back to the top first, so the arrow at the end of this has room for the same
      // reason the pair above does.
      await page.evaluate(`globalThis.__library.viewer.open(${JSON.stringify(walkable[0].hash ?? walkable[0].id)})`);
      await new Promise((r) => setTimeout(r, 400));
      await page.evaluate("document.getElementById('vMore').click()");
      const item = await page.evaluate(`(() => {
        const b = [...document.querySelectorAll('#viewer .mi')].find((x) => x.dataset.item === 'reveal' && !x.disabled);
        if (!b) return null;
        b.focus();
        return document.activeElement?.dataset?.item ?? null;
      })()`);
      check(item === 'reveal', 'a viewer menu item can hold focus before it is chosen', String(item));
      await page.evaluate("[...document.querySelectorAll('#viewer .mi')].find((b) => b.dataset.item === 'reveal')?.click()");
      await new Promise((r) => setTimeout(r, 900));
      check(await page.evaluate('globalThis.__library.viewer.focusInside()') === true,
        'and focus is back inside the viewer once the menu it was in closes',
        await page.evaluate("document.activeElement?.tagName + ':' + (document.activeElement?.dataset?.act ?? document.activeElement?.id ?? '')"));
      const beforeArrow = (await page.evaluate('globalThis.__library.viewer.state()'))?.id;
      await page.evaluate('globalThis.__library.viewer.key("ArrowDown")');
      await new Promise((r) => setTimeout(r, 500));
      check((await page.evaluate('globalThis.__library.viewer.state()'))?.id !== beforeArrow,
        'so the arrows still reach the viewer after a menu selection', `from ${beforeArrow}`);
      await page.evaluate('globalThis.__library.viewer.close()');
    }

    // ---- 6e. every control the gallery renders is one this file drives
    //
    // **Enumerated rather than listed**, which is the shape `editor-check` needed
    // after the clip in/out markers spent a feature's whole life detached from the
    // document with every proof tool passing: no tool referenced them, so nothing
    // looked. A list of the controls a reviewer happened to poke tests those
    // controls; a sweep that requires a driver for every control the page renders
    // tests the rule, and a control added later is asked about by existing.
    //
    // **Read with the viewer open on a take that has marks**, because half of these
    // controls are the viewer's and the mark ticks are the viewer's only control that
    // exists per take rather than per page. Enumerating after Escape - or on the take
    // the arrow key had landed on, which has none - reports `mark` as a driver naming
    // nothing, which is the reverse row firing for a reason that has nothing to do
    // with the page. So the surface is put back into the state the claim is about.
    await page.evaluate(`globalThis.__library.viewer.open(${JSON.stringify(clipHash2)})`);
    await page.evaluate('globalThis.__library.viewer.drawn(1)');
    const DRIVERS = new Set([
      'toMenu', 'all', 'local', 'remote', 'both',
      'open', 'download', 'delete', 'more',
      'rename', 'reveal', 'reclaim',
      'vMore', 'vClose', 'mark',
      'cCancel', 'cGo', 'rCancel', 'rGo', 'rName',
    ]);
    const rendered = await page.evaluate('globalThis.__library.controls()');
    const unswept = rendered.filter((c) => !DRIVERS.has(c.key));
    check(unswept.length === 0,
      `every interactive control the gallery renders has a driver in this file (${rendered.length} controls)`,
      unswept.length ? `no driver for ${[...new Set(unswept.map((c) => `${c.where}:${c.key}`))].join(' ')}`
        : [...new Set(rendered.map((c) => c.key))].join(' '));
    // And the other direction, which the row above cannot answer: a driver naming a
    // control that has gone is a test of nothing, reported as coverage.
    const present = new Set(rendered.map((c) => c.key));
    const missing = [...DRIVERS].filter((k) => !present.has(k));
    check(missing.length === 0,
      'and every control this file names is one the gallery still renders',
      missing.join(' ') || `${present.size} distinct controls on screen`);
    await page.evaluate('globalThis.__library.viewer.close()');

    check(errors.length === 0, 'the gallery raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  // ------------------------------------------- 6f. the fourth door, in the editor
  //
  // **The gallery greying a button is not the take being refused.** Three of the four
  // doors that read this band are on the listing - `openable` on the server, the badge
  // and the dead Open on the page - and all three can be satisfied without the editor
  // knowing anything, because a take is also reachable by typing its id into the URL,
  // by a stale bookmark and by the menu's resume. So the row that matters is the one
  // driven the way somebody arrives, and what it asserts is that the page did not enter
  // the editing state rather than that it said something: `showTimelineError` writes to
  // a note that a later message overwrites, and a take that opened *and* complained
  // would pass a row reading only the note.
  //
  // Both takes through the same door, because a build that refused every take would
  // pass the first of these and fail nobody's notice.
  console.log('\n[library] the capture format band at the door the editor opens');
  {
    const refusedAt = editorPage(macUrl, 'future-format-take');
    const { page: refused, errors: refusedErrors } = await openPage(browser, refusedAt, { width: 640, height: 400 });
    // Taken at the moment it matches rather than read again afterwards, for the reason
    // the preset rows below give: the note is one line and every later message
    // overwrites it.
    const held = await refused.waitForFunction(
      '(() => { const t = document.getElementById("tNote")?.textContent ?? ""; return t.includes("capture format") ? t : null; })()',
      null, { timeout: 30000 },
    ).catch(() => null);
    const note = held ? String(await held.jsonValue())
      : await refused.evaluate('document.getElementById("tNote")?.textContent ?? ""');
    check(new RegExp(`capture format ${CAPTURE_FORMAT + 1}\\b`).test(note),
      'an editor handed a take from a format this build does not read says which generation it found',
      note.slice(0, 140) || 'the note is empty');
    check(await refused.evaluate("document.body.classList.contains('editing')") === false,
      'and it does not open the take - the refusal is a door rather than a message beside an opened clip');
    // The throw is what this page is about, so counting it as a finding would be
    // asserting the scenario did not happen. Anything else still is one.
    const strayed = refusedErrors.filter((e) => !/capture format/.test(e) && !/Failed to load resource/.test(e));
    check(strayed.length === 0, 'and refusing it raises no page error beyond the refusal itself',
      strayed.slice(0, 2).join(' | ') || 'none beyond the refusal');
    await refused.close();

    const { page: opened, errors: openedErrors } = await openPage(
      browser, editorPage(macUrl, 'generation-zero-take'), { width: 640, height: 400 },
    );
    const editing = await opened.waitForFunction("document.body.classList.contains('editing')", null, { timeout: 30000 })
      .then(() => true, () => false);
    check(editing === true,
      'while a take whose hello declares no format at all opens in the same editor, which is every take shot before the field existed',
      editing ? 'editing' : await opened.evaluate('document.getElementById("tNote")?.textContent ?? "(no note)"'));
    check(openedErrors.filter((e) => !/Failed to load resource/.test(e)).length === 0,
      'and it opens without a page error', openedErrors.slice(0, 2).join(' | ') || 'none');
    await opened.close();
  }

  // A library with no takes at all.
  {
    const emptyUrl = await startServer(root, ['--captures', join(WORK, 'empty-captures'), '--name', 'fresh'], MAC_PORT + 3);
    const { page, errors } = await openPage(browser, galleryPage(emptyUrl));
    await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const line = await page.evaluate('globalThis.__library.emptyLine()');
    check(/No takes here yet/.test(line ?? ''), 'an empty library says so rather than rendering nothing',
      String(line));
    // A library with nothing in it says so whichever tab is selected, because that
    // is the fact - "no takes are local" on a machine with no takes at all would be
    // technically true and would send someone looking for a filter to clear.
    await page.evaluate('globalThis.__library.filter("local")');
    const filtered = await page.evaluate('globalThis.__library.emptyLine()');
    check(/No takes here yet/.test(filtered ?? ''),
      'and it keeps saying so under a filter rather than blaming the filter',
      String(filtered));
    check(errors.length === 0, 'and an empty library raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  // ------------------------------ 6f. renaming a take, and showing it where it lives
  //
  // **Its own captures directory and its own server, because this section moves
  // files.** Every other arm here reads the shared fixture, and a rename inside it
  // would leave later sections asserting about takes under names they do not use -
  // a proof tool whose arms depend on the order they happen to run in is one that
  // reports whichever ordering it was last run in.
  //
  // Renaming is the only operation in the program that changes a take's identity to
  // anything that goes by name, and the reason it is safe to offer is that nothing
  // here does: projects reference footage by content hash, the two-machine
  // reconciliation joins on the hash, and the menu resumes on the hash. So the
  // central row is not that the file moved - it is that the hash did not.
  console.log('\n[library] a take can be renamed, and a rename moves a label rather than a reference');
  {
    const renameDir = join(WORK, 'renaming');
    rmSync(renameDir, { recursive: true, force: true });
    mkdirSync(renameDir, { recursive: true });
    writeTake(renameDir, 'before-the-rename', { frames: 8, startedAt: Date.UTC(2026, 6, 20, 11, 0) });
    writeTake(renameDir, 'already-taken', { frames: 4 });
    // **A take of its own for the stale-listing probe, because the probe's whole point
    // is that it might succeed.** Driven at `before-the-rename` it did, under
    // `rename-ignores-hash`: the take went to a third name and every row after it
    // asserted about an id that no longer existed, so one mutation reddened five rows
    // and then ended the run 177 assertions early. A control whose failure takes its
    // neighbours with it cannot say what it caught.
    writeTake(renameDir, 'stale-listing-take', { frames: 5 });
    writeFileSync(join(renameDir, 'before-the-rename.marks.jsonl'),
      markLine({ id: 'r1', sourceMs: 40, label: 'the moment', at: 1000 }));

    // The stand-in file manager. `--reveal-with` substitutes the program and leaves
    // the platform's argument shape alone, so what this records is the argv Finder
    // would have been handed - which is the only reading that can tell a route that
    // opened the take from one that answered 200 having opened nothing.
    const revealLog = join(WORK, 'reveal-argv.log');
    const fakeOpener = join(WORK, 'fake-file-manager.sh');
    writeFileSync(fakeOpener, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(revealLog)}\n`);
    chmodSync(fakeOpener, 0o755);
    const argvSeen = () => (existsSync(revealLog) ? readFileSync(revealLog, 'utf8').trim().split('\n') : []);

    const renameUrl = await startServer(root, [
      '--captures', renameDir, '--name', 'renaming', '--reveal-with', fakeOpener,
      '--projects', join(WORK, 'rename-projects'), '--presets', join(WORK, 'rename-presets'),
    ], MAC_PORT + 14);

    const listed = async (id) => (await getJson(`${renameUrl}/library/takes`)).takes.find((t) => t.id === id);
    const before = await listed('before-the-rename');
    const idxBefore = statSync(join(renameDir, 'before-the-rename.idx'));

    // A request built against a listing that has gone stale. Refused, and - the half a
    // status code cannot carry - nothing moved.
    const stale = await post(`${renameUrl}/library/rename/stale-listing-take`,
      { hash: `sha256:${'0'.repeat(64)}`, to: 'renamed-on-a-stale-listing' });
    check(/the library moved underneath/.test(stale.error ?? ''),
      'a rename naming a hash the take no longer has is refused', (stale.error ?? 'ACCEPTED').slice(0, 60));
    check(existsSync(join(renameDir, 'stale-listing-take.knct'))
      && !existsSync(join(renameDir, 'renamed-on-a-stale-listing.knct')),
      'and nothing moved, which is the half of that refusal a status code cannot say',
      readdirSync(renameDir).sort().join(' '));

    const bad = await post(`${renameUrl}/library/rename/before-the-rename`,
      { hash: before.hash, to: '../outside' });
    check(/cannot be a take name/.test(bad.error ?? ''),
      'a name that is not a name is refused rather than joined to a path',
      (bad.error ?? 'ACCEPTED').slice(0, 60));
    const taken = await post(`${renameUrl}/library/rename/before-the-rename`,
      { hash: before.hash, to: 'already-taken' });
    const victim = statSync(join(renameDir, 'already-taken.knct'));
    check(/is taken/.test(taken.error ?? ''),
      'a name another take is already using is refused rather than renamed over',
      (taken.error ?? 'ACCEPTED').slice(0, 60));
    check(victim.size === statSync(join(renameDir, 'already-taken.knct')).size,
      'and the take that was in the way is still there');

    // **The same refusal under a race, which the row above cannot reach.** The
    // collision check reads the target and then acts on it, and `rename(2)` replaces
    // an existing file without a word - so two requests aiming at one name both pass
    // the reading and the second destroys a take. Two tabs is enough. The rows above
    // only ever drove them one after another, where the reading is still true when it
    // is acted on, and every one of them keeps passing on a build with the hole in it.
    //
    // **Driven against `renameTake` directly, because through the route it does not
    // reproduce and a row that cannot fail is not a row.** Four simultaneous POSTs
    // were tried first and a build using `rename(2)` passed them: each request scans
    // the whole captures directory before it reaches the rename, which is dozens of
    // awaits of different durations, and that is enough to keep the requests from ever
    // being inside the window together. So the HTTP arm measured the scan's timing and
    // reported it as the collision rule holding. The same four calls made straight at
    // the function - where the only thing between the reading and the act is three
    // `stat`s - clobber immediately: **four fulfilled, no rejections, and one file left
    // where four takes were.**
    //
    // Imported from the *staged* tree rather than from `../server/library.js`, or the
    // mutation would be applied to a copy this row never loads and every mutated run
    // would test the good code.
    const staged = await import(pathToFileURL(join(root, 'server/library.js')).href);
    const raceDir = join(WORK, 'rename-race');
    rmSync(raceDir, { recursive: true, force: true });
    mkdirSync(raceDir, { recursive: true });
    const racers = ['racer-one', 'racer-two', 'racer-three', 'racer-four'];
    // Different lengths, so they are four takes rather than four copies - a rename
    // that overwrote one with an identical one would lose nothing and prove nothing.
    for (const [i, id] of racers.entries()) writeTake(raceDir, id, { frames: 3 + i });
    const racerHashes = [];
    for (const id of racers) racerHashes.push(await staged.hashFile(join(raceDir, `${id}.knct`)));
    const answers = await Promise.allSettled(racers.map((id, i) => staged.renameTake(
      raceDir, id, 'the-contested-name', { hash: racerHashes[i] },
    )));
    const won = answers.filter((r) => r.status === 'fulfilled');
    const lost = answers.filter((r) => r.status === 'rejected');
    check(won.length === 1 && lost.length === racers.length - 1,
      `${racers.length} renames onto one name at once: exactly one wins and the rest are refused by the kernel rather than by a reading taken a moment earlier`,
      `${won.length} accepted, ${lost.length} refused - ${String(lost[0]?.reason?.message ?? '').slice(0, 60)}`);
    // The half a status code cannot say, and the only one that is about footage: every
    // loser's take is still on disk under the name it had.
    const survivors = readdirSync(raceDir).filter((f) => /^racer-.*\.knct$/.test(f));
    check(survivors.length === racers.length - 1 && existsSync(join(raceDir, 'the-contested-name.knct')),
      'and every one that lost still has its footage under its own name, which is what a silent overwrite takes away',
      `${survivors.length} of ${racers.length - 1} survived: ${survivors.join(' ') || 'nothing'}`);

    // The rename itself, with the extension typed - somebody who types `.knct` means
    // the take rather than a file called `x.knct.knct`.
    const done = await post(`${renameUrl}/library/rename/before-the-rename`,
      { hash: before.hash, to: 'after-the-rename.knct' });
    check(done.id === 'after-the-rename',
      'a typed extension is taken off rather than refused, because it is the same name',
      JSON.stringify(done.id));
    const after = await listed('after-the-rename');
    check(after !== undefined && !(await listed('before-the-rename')),
      'the take is listed under its new name and not its old one');
    // **The row this whole feature rests on.** A rename that changed the hash would
    // orphan every project built on the take while looking like it worked, because a
    // project resolves its footage by hash and would simply find nothing.
    check(after.hash === before.hash && after.frames === before.frames,
      'and its content hash is unchanged, so every project built on it still finds its footage',
      `${before.hash.slice(0, 20)}… ${before.frames} frames, still ${after.hash.slice(0, 20)}…`);
    check(after.marks.length === 1 && after.marks[0].label === 'the moment',
      'the marks came with it - the one artifact here nobody can regenerate, since it is what somebody pressed in the room',
      JSON.stringify(after.marks.map((m) => m.label)));
    check(!existsSync(join(renameDir, 'before-the-rename.marks.jsonl')),
      'and nothing is left at the old name for a later take to find beside it',
      readdirSync(renameDir).sort().join(' '));
    // Measured rather than assumed: the sidecar validates on the capture's size and
    // modification time, both of which `rename` preserves, so a moved index is a scan
    // that did not happen. A fresh sidecar would carry a new modification time.
    const idxAfter = statSync(join(renameDir, 'after-the-rename.idx'));
    check(idxAfter.mtimeMs === idxBefore.mtimeMs && idxAfter.size === idxBefore.size,
      'the index moved with it rather than being rebuilt, which is a full read of the take not taken',
      `${idxBefore.size} bytes at ${idxBefore.mtimeMs}, still ${idxAfter.size} at ${idxAfter.mtimeMs}`);

    // ---- reveal
    //
    // The one route in this program that starts a process, so what it is asked is
    // read off the program's own argv rather than off the answer the route wrote.
    const revealed = await post(`${renameUrl}/library/reveal/after-the-rename`);
    check(revealed.path === join(renameDir, 'after-the-rename.knct'),
      'reveal answers with the take\'s own path under the captures directory',
      String(revealed.path ?? revealed.error));
    // **What counts as the right argv is the platform's own shape, not the bare
    // path.** `revealTake` hands Finder `-R <path>`, `xdg-open` the *containing
    // directory* because no `-R` equivalent exists across the desktops it fronts, and
    // Explorer a single `/select,<path>`. Requiring the bare `.knct` path in the argv
    // therefore asserted the Darwin branch on every platform: the unmutated check
    // failed on Linux and Windows against a correct implementation, and
    // `reveal-drops-the-path` edits only the Darwin branch so it changed nothing
    // there either - a row that was red for the wrong reason next to a mutation that
    // could not go red at all.
    //
    // Derived from `revealSupport`'s own table rather than restated here, because a
    // second copy of the argument shape is the drift this repo keeps refusing.
    const takePath = join(renameDir, 'after-the-rename.knct');
    const wanted = REVEAL[process.platform]?.args(takePath) ?? [takePath];
    const sawWanted = () => wanted.every((arg) => argvSeen().includes(arg));
    for (let i = 0; i < 40 && !sawWanted(); i++) {
      await new Promise((r) => { setTimeout(r, 50); });
    }
    check(sawWanted(),
      'and the file manager really was started on that file - the argv it received, not the status it answered',
      `${process.platform} wants ${JSON.stringify(wanted)}, saw ${JSON.stringify(argvSeen())}`);
    const ghost = await post(`${renameUrl}/library/reveal/no-such-take`);
    check(/not on this machine/.test(ghost.error ?? ''),
      'a take that is not here reveals nothing rather than starting a file manager on a path that does not exist',
      (ghost.error ?? 'ACCEPTED').slice(0, 60));

    // **A browser across the link is refused, and proving it needs a second address
    // to arrive on.** `isLoopback` reads the peer off the socket, so the only way to
    // exercise it is genuinely to connect from somewhere else - which is what
    // `guard-check` already requires a non-internal IPv4 for. Where the machine has
    // none, this is recorded as unproven rather than passed: "not tested here" and
    // "tested and fine" are different answers.
    const lan = Object.values(networkInterfaces()).flat()
      .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? null;
    if (!lan) {
      skipped.push('the reveal refusal for a caller that is not on this machine');
      console.log('  ...   no non-internal IPv4 here, so the reveal-from-elsewhere refusal was not exercised');
    } else {
      const openUrl = await startServer(root, [
        '--captures', renameDir, '--name', 'renaming', '--host', '0.0.0.0', '--reveal-with', fakeOpener,
        '--projects', join(WORK, 'rename-projects'), '--presets', join(WORK, 'rename-presets'),
      ], MAC_PORT + 15);
      const port = new URL(openUrl).port;
      const beforeElsewhere = argvSeen().length;
      const elsewhere = await post(`http://${lan}:${port}/library/reveal/after-the-rename`);
      check(/nobody is standing at|not the machine this browser is on/.test(elsewhere.error ?? ''),
        'a browser that is not on this machine is refused, because the window would open where nobody is looking',
        (elsewhere.error ?? 'ACCEPTED').slice(0, 70));
      // The refusal is a decision rather than a status on something that already
      // happened - the same reading the GET of /record/stop gets in section 7.
      await new Promise((r) => { setTimeout(r, 300); });
      check(argvSeen().length === beforeElsewhere,
        'and no file manager was started, which is the half of the refusal a 409 cannot say',
        `${beforeElsewhere} arguments logged before, ${argvSeen().length} after`);
      // The positive twin on the same server: loopback still works, so the row above
      // is about who asked rather than about a route that had simply been switched off.
      const stillHere = await post(`${openUrl}/library/reveal/after-the-rename`);
      check(stillHere.path === join(renameDir, 'after-the-rename.knct'),
        'while the same server still reveals for a browser on this machine',
        String(stillHere.path ?? stillHere.error));
      // The page agrees with the server about which of those it is looking at, which
      // is what greys the menu item out rather than letting it be pressed and refused.
      const fromElsewhere = await getJson(`http://${lan}:${port}/library/all`);
      const fromHere = await getJson(`${openUrl}/library/all`);
      check(fromElsewhere.reveal?.available === false && fromHere.reveal?.available === true,
        'and the listing tells the page which of the two it is, per request, so the menu item can say why before it is pressed',
        `${JSON.stringify(fromElsewhere.reveal?.why ?? null).slice(0, 60)} against available`);
      for (const p of servers.filter((sv) => sv.port === MAC_PORT + 15)) p.child.kill('SIGKILL');
    }

    // ---- the take being shot is not renameable, and that is not a nicety
    //
    // `scanTakes` decides which take is open by comparing paths against
    // `recorder.openPath`, so a renamed one stops matching: `describeTake` drops out
    // of the unscanned branch and every `/library/*` request starts a full read plus
    // sha256 of a file the recorder is still writing to, on the disk it is writing to.
    // That is the contention section 11 exists to keep closed, reached by a door the
    // rename's own answer cannot show - so the row is the sidecar, which is the same
    // tell section 11 and the route sweep both use.
    const shootDir = join(WORK, 'rename-shooting');
    rmSync(shootDir, { recursive: true, force: true });
    mkdirSync(shootDir, { recursive: true });
    const shootUrl = await startServer(root, [
      '--captures', shootDir, '--name', 'rename-shooting', '--record', '--no-color',
      '--projects', join(WORK, 'rename-shoot-projects'), '--presets', join(WORK, 'rename-shoot-presets'),
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
    ], MAC_PORT + 16);
    let shooting = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => { setTimeout(r, 250); });
      shooting = await getJson(`${shootUrl}/record/state`);
      if (shooting.recording) break;
    }
    check(shooting?.recording === true, 'a take is open, which is what makes the next rows about behaviour',
      String(shooting?.takeId));
    const openTake = (await getJson(`${shootUrl}/library/takes`)).takes.find((t) => t.id === shooting.takeId);
    const refused = await post(`${shootUrl}/library/rename/${shooting.takeId}`,
      { hash: openTake?.hash, to: 'renamed-mid-shoot' });
    check(/being recorded right now/.test(refused.error ?? ''),
      'the take being recorded refuses to be renamed', (refused.error ?? 'ACCEPTED').slice(0, 60));
    check(existsSync(join(shootDir, `${shooting.takeId}.knct`))
      && !existsSync(join(shootDir, 'renamed-mid-shoot.knct')),
      'and it is still at the name the recorder has open', readdirSync(shootDir).sort().join(' '));
    // Read after the manifest has been asked again, because the scan this guards
    // against happens inside a listing rather than inside the rename.
    await fetch(`${shootUrl}/library/all`).catch(() => {});
    check(!existsSync(join(shootDir, `${shooting.takeId}.idx`)),
      'and the manifest still describes it without scanning it - no sidecar, which is what a full read of a growing take would leave',
      readdirSync(shootDir).sort().join(' '));
    // **And reveal is refused on it too, which is the least obvious of the three.**
    // Nothing about revealing writes - it stats a file and starts a window - so it
    // reads as harmless and the page had it enabled on a tile whose every other
    // control was off. What it hands over is the path, to a program that will size,
    // index and preview whatever it is pointed at, against the disk the recorder is
    // writing to. Found by the row above it in this file rather than by reading.
    const revealOpen = await post(`${shootUrl}/library/reveal/${shooting.takeId}`);
    check(/being recorded right now/.test(revealOpen.error ?? ''),
      'and so does showing it in a file manager, which would point one at the disk the recorder is writing to',
      (revealOpen.error ?? 'ACCEPTED').slice(0, 70));
    const stopped = await post(`${shootUrl}/record/stop`);
    check(!stopped.error && Number.isFinite(stopped.stopped?.frames),
      'and the take it refused to rename closes as one continuous stream',
      stopped.error ? String(stopped.error).slice(0, 80) : `${stopped.stopped?.frames} frames`);
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 16)) p.child.kill('SIGKILL');
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 14)) p.child.kill('SIGKILL');
  }

  // ------------------------------------------------ 7. the project round-trips
  console.log('\n[library] a project survives a round trip through a file');
  {
    // Two pages, and the split is not tidiness. The image comparison runs the
    // deterministic drive, which detaches the animation loop and binds its own
    // frames - and a page with a take open still has a transport answering
    // parameter writes with a seek, which would walk the *pinned* source backwards
    // from inside a repaint nobody asked for. So the document claims run on a page
    // with no take, where the drive owns the loop outright, and the two claims that
    // are genuinely about a take run on a page that has one.
    {
      const { page: takePage, errors: takeErrors } = await openPage(browser, editorPage(macUrl, 'local-clip'), { width: 640, height: 400 });
      await takePage.waitForFunction('globalThis.__kinect?.timeline?.transport() !== null', null, { timeout: 40000 });
      await takePage.evaluate('globalThis.__kinect.timeline.settled()');
      check(await takePage.evaluate('globalThis.__kinect.library.takeHash()')
        === (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'local-clip').hash,
        'the editor names its take by the hash the manifest reports');

      // A project built on other footage. The hash is what catches a take that was
      // truncated, re-recorded or swapped underneath an edit, which a path cannot.
      const otherHash = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'truncated-take').hash;
      await takePage.evaluate(`(async () => {
        const body = { ...globalThis.__kinect.library.serialiseProject(), take: { id: 'truncated-take', hash: ${JSON.stringify(otherHash)} } };
        await fetch('/projects/other-footage', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      })()`);
      const crossed = await takePage.evaluate(`(async () => {
        try { await globalThis.__kinect.library.loadProject('other-footage'); return 'ACCEPTED'; }
        catch (e) { return e.message; }
      })()`);
      check(/different footage/.test(crossed), 'a project built on other footage is refused against this take',
        crossed.slice(0, 80));

      // And the whole path end to end, seek included, onto the take it was built on.
      const own = await takePage.evaluate(`(async () => {
        const k = globalThis.__kinect;
        const body = { ...k.library.serialiseProject(), take: { id: k.library.takeId(), hash: k.library.takeHash() } };
        await fetch('/projects/own-footage', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        try { await k.library.loadProject('own-footage'); return 'ACCEPTED'; } catch (e) { return e.message; }
      })()`);
      check(own === 'ACCEPTED', 'and a project built on this take loads, seek and all', String(own).slice(0, 80));
      check(takeErrors.length === 0, 'the take page raises no page errors', takeErrors.slice(0, 2).join(' | '));
      await takePage.close();
    }

    const { page, errors } = await openPage(browser, recorderPage(macUrl), { width: 640, height: 400 });
    await page.waitForFunction('globalThis.__kinect !== undefined', null, { timeout: 40000 });

    // A look nothing defaults to, so a restore that did nothing cannot pass.
    const SCRAMBLE = {
      pointSize: 21.6, opacity: 0.62, exposure: 2.35, bloom: 1.35, trails: 0.62,
      rgbSplit: 2.4, scanlines: 0.44, grain: 0.31, scan: 0.62, rim: 0.28, fade: 340, wake: 720,
    };
    // The deterministic drive rather than the timeline: an image comparison needs a
    // program position rendered with nothing between the walk and the pixels, and
    // the indexed source would put a fetch there.
    const times = await page.evaluate(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(pinFixture().toString('base64'))}), (c) => c.charCodeAt(0));
      return globalThis.__kinect.drive.pin(bytes.buffer);
    })()`);
    // Positions between the pinned frames rather than on them, so the run crosses
    // brackets and interpolates rather than landing on the same six images however
    // many are asked for.
    const positions = [];
    for (let i = 0; i < times.length - 1; i++) {
      for (let r = 0; r < 3; r++) positions.push(times[i] + (times[i + 1] - times[i]) * (r / 3));
    }
    // The camera is pinned inside the run and not once outside it: the drive walks
    // the accumulators and the look is rewritten between runs, and a camera left to
    // whatever the page last did would make two runs differ for a reason that has
    // nothing to do with the file under test.
    const RENDER = `async (opts) => {
      const k = globalThis.__kinect;
      k.drive.reset();
      k.freeCamera.position.set(0, 0.1, 1.6);
      k.freeCamera.lookAt(0, 0, -2.2);
      k.freeCamera.updateMatrixWorld(true);
      const out = [];
      for (const t of opts.positions) {
        k.drive.stepTo(t);
        const pixels = k.drive.readPixels();
        const digest = await crypto.subtle.digest('SHA-256', pixels);
        out.push(Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''));
      }
      return out;
    }`;
    const render = () => page.evaluate(`(${RENDER})(${JSON.stringify({ positions })})`);

    await page.evaluate(`globalThis.__kinect.params.apply(${JSON.stringify(SCRAMBLE)})`);
    const authored = await render();

    // Through an actual file: the page saves it, the server writes it, the page
    // reads it back. An in-memory `serialise`/`restore` pair would prove the
    // registry and not the door.
    await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      const body = k.library.serialiseProject();
      const res = await fetch('/projects/round-trip', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return res.json();
    })()`);
    await page.evaluate('globalThis.__kinect.params.reset()');
    const defaults = await render();
    // Fetched and restored, which is the document half of the load path. The take
    // gate and the re-seek `loadProject` adds around it are transport rather than
    // document, and they are asserted separately below - putting a seek inside this
    // comparison would have the indexed source fetching underneath a pinned drive.
    await page.evaluate(`(async () => {
      const doc = await (await fetch('/projects/round-trip')).json();
      globalThis.__kinect.library.restoreProject(doc.body);
    })()`);
    const reloaded = await render();

    check(eq(authored, reloaded), 'the reloaded file reproduces the run image for image',
      eq(authored, reloaded) ? '' : `first divergence at image ${authored.findIndex((h, i) => h !== reloaded[i])}`);
    // The blunt control. Without it the equality above would be arithmetic rather
    // than evidence: two renders of an unchanged page agree whatever the loader did.
    check(!eq(authored, defaults),
      'and the defaults do not - the file is what the image depends on');
    check(new Set(authored).size > authored.length / 2, 'the run itself moves across its positions',
      `${new Set(authored).size} distinct of ${authored.length}`);

    // The saved file is a file on disk with a version on it, not a blob the page
    // interprets for itself.
    const saved = JSON.parse(readFileSync(join(WORK, 'projects/round-trip.json'), 'utf8'));
    check(saved.version === PROJECT_VERSION, 'the file carries the format version', `version ${saved.version}`);
    check(JSON.parse(readFileSync(join(WORK, 'projects/own-footage.json'), 'utf8')).take?.hash?.startsWith('sha256:'),
      'and a project saved from the editor names its footage by content hash rather than by path');

    // ---- the three refusals, built as source rather than through JSON, because
    // JSON.stringify turns NaN and undefined into null and a case labelled NaN
    // would silently be testing null a second time.
    const refuse = async (label, source) => page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const p = k.library.serialiseProject();
      ${source}
      try { k.library.restoreProject(p); return 'ACCEPTED'; } catch (e) { return e.message; }
    })()`).then((message) => ({ label, message }));

    const cases = [
      ['a project with no version', 'delete p.version;'],
      ['a project from an older version', 'p.version = 0;'],
      // Derived from the version this build writes rather than written down. A literal
      // here says "newer" only until the next bump makes it current, and this row went
      // ACCEPTED the moment the readings moved the format from 3 to 4.
      ['a project from a newer version', `p.version = ${PROJECT_VERSION + 1};`],
      ['a version that is not a number', 'p.version = "1";'],
      ['a retime curve that falls', 'p.composition.retime.keys = [{t:0,value:0},{t:1,value:2},{t:2,value:0.5}];'],
      ['a retime handle outside the unit box',
        'p.composition.retime.keys = [{t:0,value:0,easeOut:[0.4,1.9],easeIn:[0.6,0]},{t:2,value:1,easeOut:[0.4,0],easeIn:[0.6,0]}];'],
      ['a camera key whose quaternion is not unit length',
        'p.composition.camera = [{t:0,value:{position:[0,0,3],quaternion:[0,0,0,1.4],fov:55}},{t:1,value:{position:[1,0,3],quaternion:[0,0,0,1],fov:55}}];'],
      ['a camera key whose quaternion is all zeros',
        'p.composition.camera = [{t:0,value:{position:[0,0,3],quaternion:[0,0,0,0],fov:55}}];'],
      ['a camera key with a short position',
        'p.composition.camera = [{t:0,value:{position:[0,0],quaternion:[0,0,0,1],fov:55}}];'],
      ['a camera key whose fov is NaN',
        'p.composition.camera = [{t:0,value:{position:[0,0,3],quaternion:[0,0,0,1],fov:NaN}}];'],
      ['a scalar key that is a string', 'p.look.tracks.bloom = [{t:0,value:"0.5"}];'],
      ['a scalar key that is null', 'p.look.tracks.bloom = [{t:0,value:null}];'],
      ['a key at an undefined time', 'p.look.tracks.bloom = [{t:undefined,value:0.5}];'],
      // **The registry's door, probed where the answer is different.** The one name
      // this list used to try was `nosuchthing`, which is the case the code handled
      // correctly - a probe placed exactly where the wrong implementation agrees
      // with the right one. `PARAMS` is an object literal, so gating on
      // `PARAMS[name]` truthiness accepted every name `Object.prototype` answers
      // for: `__proto__` landed in `tracks`, `normalise` read min, max and step off
      // a function and made NaN out of undefined, and the page threw mid-render -
      // a failure inside the evaluator rather than a decision at the door, which is
      // the whole class the door exists for.
      ['a track the registry does not know', 'p.look.tracks.nosuchthing = [{t:0,value:1}];'],
      // `p.look.tracks.__proto__ = x` sets the *prototype* and creates no own property at
      // all, so `Object.entries` never sees it and the loader is handed an unchanged
      // document - a probe placed exactly where the wrong implementation and the
      // right one agree, which is the trap this repo already has two entries for.
      // `defineProperty` builds the own, enumerable property that `JSON.parse` puts
      // there when a file on disk literally contains `"__proto__": [...]`, which is
      // the shape this arrives in.
      ['a track named __proto__',
        "Object.defineProperty(p.look.tracks, '__proto__', { value: [{t:0,value:1}], enumerable: true, configurable: true, writable: true });"],
      ['a track named constructor', 'p.look.tracks.constructor = [{t:0,value:1}];'],
      ['a track named toString', 'p.look.tracks.toString = [{t:0,value:1}];'],
      ['a track named valueOf', 'p.look.tracks.valueOf = [{t:0,value:1}];'],
      ['a track named hasOwnProperty', 'p.look.tracks.hasOwnProperty = [{t:0,value:1}];'],
      ['a parameter named constructor in the values', 'p.look.params.constructor = 1;'],
      ['a parameter named __proto__ in the values',
        "Object.defineProperty(p.look.params, '__proto__', { value: 1, enumerable: true, configurable: true, writable: true });"],
      // The reading, which used to be `p.look.mode = 9` - refused by a bounds check the
      // loader wrote by hand for the one value the registry did not carry. There is no
      // such clause now and there should not be: a reading is a registry scalar, so it
      // meets `normalise` like every other look value. That changes what a corrupt file
      // does rather than whether it is caught - 9 is *clamped* to the declared 1, which
      // is what every slider does with an out-of-range number - so the row that means
      // something is the one the registry genuinely refuses. A first pass at this
      // asserted the clamp was a refusal and went ACCEPTED, which is the check being
      // wrong about the program rather than the other way round.
      ['a reading that is not a number', 'p.look.params.readBlackwall = "1";'],
      ['a retime rate of zero or less', 'p.composition.retime.rate = 0;'],
      ['a preset stamp that is not a name and a rev', 'p.appliedPreset = { name: 42 };'],
    ];
    const results = [];
    for (const [label, source] of cases) results.push(await refuse(label, source));
    for (const { label, message } of results) {
      check(message !== 'ACCEPTED', `refused: ${label}`, message === 'ACCEPTED' ? 'ACCEPTED' : message.slice(0, 64));
    }
    // The control the refusals need. A loader that threw at everything would pass
    // every row above and open nothing.
    const good = await refuse('an unmodified project', '');
    check(good.message === 'ACCEPTED', 'and an unmodified project still loads',
      good.message === 'ACCEPTED' ? '' : good.message.slice(0, 80));

    // Straight at the registry, because the load path is one of four doors into it
    // and the other three were gated the same wrong way. `spec`, `get`, `normalise`
    // and `set` each asked the question in their own words - three `PARAMS[name]`
    // and one `name in PARAMS`, which is one hole written two ways.
    const inherited = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const names = ['constructor', 'toString', '__proto__', 'valueOf', 'hasOwnProperty'];
      const out = {};
      for (const name of names) {
        out[name] = {};
        for (const door of ['spec', 'get', 'normalise', 'set']) {
          try {
            k.params[door](name, 0.5);
            out[name][door] = 'ACCEPTED';
          } catch (e) {
            out[name][door] = /unknown parameter/.test(e.message) ? 'refused' : 'threw: ' + e.message.slice(0, 40);
          }
        }
      }
      return out;
    })()`);
    const leaked = Object.entries(inherited)
      .flatMap(([name, doors]) => Object.entries(doors).filter(([, v]) => v !== 'refused').map(([d, v]) => `${name}.${d}=${v}`));
    check(leaked.length === 0,
      'every door into the registry refuses a name that only exists on Object.prototype, and refuses it as an unknown parameter rather than throwing somewhere inside',
      leaked.slice(0, 4).join(' ') || `${Object.keys(inherited).length} names x 4 doors, all refused`);
    // The control: a real parameter still goes through all four, or the row above
    // would pass against a registry that refused everything.
    const real = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      try {
        return { spec: typeof k.params.spec('bloom').max, normalised: k.params.normalise('bloom', 1.25), set: k.params.set('bloom', 1.25), got: k.params.get('bloom') };
      } catch (e) { return { error: e.message }; }
    })()`);
    check(real.spec === 'number' && Number.isFinite(real.normalised) && real.got === real.set,
      'while a parameter the registry does declare passes through all four unchanged',
      JSON.stringify(real));
    await page.evaluate('globalThis.__kinect.params.reset()');

    check(errors.length === 0, 'the document path raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  // ------------------------------------------------------- 8. the preset library
  console.log('\n[library] presets carry look and a provenance stamp');
  {
    const { page, errors } = await openPage(browser, editorPage(macUrl, 'local-clip'), { width: 640, height: 400 });
    await page.waitForFunction('globalThis.__kinect?.timeline?.transport() !== null', null, { timeout: 40000 });
    await page.evaluate('globalThis.__kinect.timeline.settled()');

    // A preset saved off a Blackwall clip whose values have then been moved away from
    // Blackwall's own. The hand-tuning is the point: a preset that happened to match the
    // shipped look could not tell "your values came back" from "the built-in look for
    // this reading was reapplied", which is the confusion a preset library exists to
    // avoid. The reading goes in through the registry with everything else now.
    const TUNED = { bloom: 2.4, trails: 0.11, rgbSplit: 4.2, grain: 0.77, pointSize: 30.5 };
    await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      k.params.apply({ readRgb: 0, readBlackwall: 1 });
      k.params.apply(${JSON.stringify(TUNED)});
      const res = await fetch('/presets/hand-tuned', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(k.library.presetFromCurrentLook()),
      });
      return res.json();
    })()`);

    const onDisk = readFileSync(join(WORK, 'presets/hand-tuned.json'), 'utf8');
    const doc = JSON.parse(onDisk);
    check(doc.version === 4, 'a preset carries the format version too');
    // The mode used to be a second field beside `values`, because the registry excluded
    // it and `values(names('look'))` would neither capture nor restore it. It is one of
    // those values now, so what this row asserts is that the subset really is the whole
    // preset - a build that still carried a separate field would fail the second half.
    check(doc.values.readBlackwall === 1 && doc.values.readRgb === 0,
      'the reading travels inside the values, like every other look parameter',
      `readBlackwall ${doc.values.readBlackwall} readRgb ${doc.values.readRgb}`);
    check(!('mode' in doc), 'and there is no mode field left beside them');
    check(doc.values.bloom === TUNED.bloom && doc.values.pointSize === TUNED.pointSize,
      'and the look values it was saved with');
    check(!('camera' in doc.values) && !('renderScale' in doc.values),
      'composition and view state stay out of it - applying a look must not move your camera');

    // Applied onto a clip that has been moved away from it. Wrapped, because this
    // is the evaluate the documented context-loss flake lands on here - twice in
    // one sweep, in two different mutation runs, always at this call.
    const applied = await retryOnContextLoss('applying the preset', () => page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      k.params.apply({ readBlackwall: 0, readRgb: 1 });
      k.params.apply({ bloom: 0, trails: 0, rgbSplit: 0, grain: 0, pointSize: 9 });
      const before = { pose: k.params.get('camera'), values: k.params.values(k.params.names('look')) };
      const docRes = await fetch('/presets/hand-tuned');
      k.library.applyStoredPreset(await docRes.json());
      return {
        before,
        after: k.params.values(k.params.names('look')),
        pose: k.params.get('camera'),
        stamp: k.library.appliedPreset(),
      };
    })()`));
    check(applied.after.bloom === TUNED.bloom && applied.after.rgbSplit === TUNED.rgbSplit
      && applied.after.grain === TUNED.grain && applied.after.pointSize === TUNED.pointSize,
      'applying a preset restores the values it was saved with, not a built-in look',
      `bloom ${applied.after.bloom} rgbSplit ${applied.after.rgbSplit} pointSize ${applied.after.pointSize}`);
    check(applied.after.readBlackwall === 1 && applied.after.readRgb === 0,
      'and it restores the reading, which needs no special case to travel',
      `readBlackwall ${applied.after.readBlackwall}`);
    check(eq(applied.pose, applied.before.pose), 'and it does not move the camera');

    // The stamp, hashed over the bytes on disk. A re-serialisation would hash
    // differently for the same meaning, and the provenance would drift for no
    // reason anyone could later find.
    const diskRev = `sha256:${createHash('sha256').update(onDisk).digest('hex')}`;
    check(applied.stamp?.name === 'hand-tuned' && applied.stamp?.rev === diskRev,
      'the provenance stamp is the hash of the preset\'s bytes on disk',
      `${applied.stamp?.rev?.slice(7, 19)} against ${diskRev.slice(7, 19)}`);

    const inProject = await page.evaluate('globalThis.__kinect.library.serialiseProject().appliedPreset');
    check(eq(inProject, applied.stamp), 'and it travels in the project, so drift across a set of clips is visible');

    // The copy is what keeps a project self-contained: the values are in the file,
    // so a worker needs the file and nothing else. Changing the preset must not
    // change what an already-saved project renders.
    await page.evaluate(`(async () => {
      await fetch('/presets/hand-tuned', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 4, values: { bloom: 0, pointSize: 9 } }),
      });
    })()`);
    const stillTuned = await page.evaluate("globalThis.__kinect.params.get('bloom')");
    check(stillTuned === TUNED.bloom,
      'editing the preset afterwards does not reach back into the clip - the values were copied in',
      `bloom ${stillTuned}`);

    // ------------------------------------------------- the looks that ship
    //
    // Five documents served out of a second, read-only root beside the user's own
    // library. The rows below are about the one behaviour that root has to get right:
    // **a save over a shipped name forks it rather than overwriting it.** Without
    // that, the first person to tweak Blackwall loses it for good, and "the shipped
    // looks cannot be lost" is a sentence the design writes about itself.
    //
    // Driven against the real `presets-builtin/` rather than a directory invented
    // here, so the check sweeps the looks the product actually offers. A tool holding
    // its own five constants would keep passing after somebody re-graded them.
    const shipped = JSON.parse(readFileSync(join(REPO, 'presets-builtin/blackwall.json'), 'utf8'));
    const shippedNames = readdirSync(join(REPO, 'presets-builtin'))
      .filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
    const listed = await getJson(`${macUrl}/presets`);
    const listedBuiltin = listed.presets.filter((d) => d.builtin).map((d) => d.name).sort();
    check(shippedNames.length > 0 && eq(listedBuiltin, shippedNames),
      'every look that ships is listed, and says it ships',
      `${listedBuiltin.join(' ')} against ${shippedNames.join(' ')}`);

    // The fork. Written through the same route a save uses, because the claim is about
    // that route rather than about a helper.
    // **The staged copy, not the repo's.** The server reads its built-in root out of
    // the tree it was started from, so asserting the repo's file is unchanged asserts
    // something the server could not have done under any implementation - a row that
    // passes by construction and reads exactly like a fork-on-write that works. The
    // file under test is the one the process can actually reach.
    const builtinPath = join(WORK, 'builtin-presets/blackwall.json');
    const bytesBefore = readFileSync(builtinPath, 'utf8');
    const forkBody = { version: PROJECT_VERSION, values: { ...shipped.values, bloom: 5.5 } };
    await post(`${macUrl}/presets/blackwall`, forkBody, 'PUT');
    check(readFileSync(builtinPath, 'utf8') === bytesBefore,
      'saving over a shipped look leaves the shipped file byte-identical',
      `${bytesBefore.length} bytes`);
    const forkPath = join(WORK, 'presets/blackwall.json');
    check(existsSync(forkPath), 'and the save landed in the user\'s own library instead',
      existsSync(forkPath) ? readdirSync(join(WORK, 'presets')).join(' ') : 'no fork on disk');
    const afterFork = await getJson(`${macUrl}/presets/blackwall`);
    check(afterFork.builtin === false && afterFork.body.values.bloom === 5.5,
      'and reading the name now answers the fork, not the look it was forked from',
      `builtin=${afterFork.builtin} bloom=${afterFork.body.values.bloom}`);

    // And the other direction, which is the same fact read backwards: removing the
    // fork brings the shipped look back rather than leaving a hole where a name was.
    await post(`${macUrl}/presets/blackwall`, null, 'DELETE');
    const afterRemove = await getJson(`${macUrl}/presets/blackwall`);
    check(afterRemove.builtin === true && afterRemove.body.values.bloom === shipped.values.bloom,
      'and removing the fork brings the shipped look back',
      `builtin=${afterRemove.builtin} bloom=${afterRemove.body.values.bloom}`);

    // ------------------------------------------- a library that cannot be read
    //
    // **An unreadable user directory is not an empty one, and the two answers are
    // indistinguishable unless the route refuses.** With the shipped root behind it,
    // a `/presets` that swallows the failure comes back 200 carrying exactly the five
    // looks - which is precisely what a fresh install looks like, so the picker shows
    // a healthy library with every fork and every grade the user ever saved missing
    // from it. Nothing on the page could tell them apart.
    //
    // The directory is a *file*, so `readdir` answers ENOTDIR: deterministic, needs no
    // `chmod`, and unlike a permission bit it behaves the same for a run as root. The
    // control is the condition in `listJsonNames` - with `err?.code !== 'ENOENT'`
    // removed it lists the five and answers 200, and both rows below go red.
    const brokenRoot = join(WORK, 'presets-that-are-a-file');
    writeFileSync(brokenRoot, 'a file where a directory should be\n');
    const brokenUrl = await startServer(root, ['--captures', macCaps, '--name', 'broken-library',
      '--presets', brokenRoot, '--builtin-presets', join(WORK, 'builtin-presets')], MAC_PORT + 14);
    const brokenRes = await fetch(`${brokenUrl}/presets`);
    const brokenText = await brokenRes.text();
    check(!brokenRes.ok, 'a preset directory that cannot be read is reported rather than listed as empty',
      `${brokenRes.status} ${brokenText.slice(0, 90)}`);
    // And the second half, because a 500 whose body still carried the five would be a
    // route that reported *and* served: the shipped looks must not stand in for a
    // user library nobody could read.
    let brokenListed = [];
    try { brokenListed = (JSON.parse(brokenText).presets ?? []).map((d) => d.name); } catch { /* not JSON is fine */ }
    check(brokenListed.length === 0,
      'and the shipped looks are not served in its place, which would read as a library with no forks',
      brokenListed.join(' ') || 'nothing listed');
    // Still absent, though, stays empty: that is the ordinary state of a fresh node
    // and the reason this rule is about ENOENT rather than about failing loudly.
    const freshUrl = await startServer(root, ['--captures', macCaps, '--name', 'fresh-library',
      '--presets', join(WORK, 'presets-never-made'), '--builtin-presets', join(WORK, 'builtin-presets')],
    MAC_PORT + 15);
    const fresh = await getJson(`${freshUrl}/presets`);
    check(fresh.presets.length > 0 && fresh.presets.every((d) => d.builtin),
      'while a user directory that was simply never made still lists the shipped looks and nothing else',
      `${fresh.presets.length} presets, ${fresh.presets.filter((d) => d.builtin).length} shipped`);
    // **And the same failure read where an operator would be standing.** The rows above
    // are the route's answer; this one is the editor's, and it is a different question:
    // the refusal reached the page and was thrown away by an empty `catch`, so a
    // `--builtin-presets` one directory too high drew a picker holding the placeholder
    // and nothing else, which is what a node with no presets legitimately looks like.
    // Driven against the broken server rather than simulated, so the message on screen
    // is the one the store wrote.
    {
      const { page: hurt, errors: hurtErrors } = await openPage(browser, editorPage(brokenUrl, 'local-clip'));
      // **`#tNote`, which is what `ui.note` is.** Written against `#note` first, and
      // that row read an element that does not exist: `?? ''` made every arm answer
      // "the note is empty", so it was red against a build that was reporting perfectly
      // and would have been red against one that reported nothing at all.
      //
      // The text is taken *at the moment it matches* rather than read again afterwards,
      // because the note is one line that every later message overwrites - a read taken
      // a beat too late measures whichever gesture came next.
      const held = await hurt.waitForFunction(
        '(() => { const t = document.getElementById("tNote")?.textContent ?? ""; return t.includes("library unavailable") ? t : null; })()',
        null, { timeout: 30000 },
      ).catch(() => null);
      const note = held ? String(await held.jsonValue())
        : await hurt.evaluate('document.getElementById("tNote")?.textContent ?? ""');
      check(/library unavailable/.test(note) && /presets/.test(note),
        'an editor whose preset library will not load says so instead of drawing an empty picker',
        note.slice(0, 120) || 'the note is empty');
      // The store's own sentence, not a paraphrase and not `list is not iterable`: the
      // path from `listJsonNames` to the note is what makes the failure actionable.
      check(/cannot be read/.test(note),
        'and the note carries the server\'s reason rather than the shape of the crash',
        note.slice(0, 120) || 'the note is empty');
      // The 500 itself is the subject of this page, so the console line the browser
      // writes for it is not a finding - asserting its absence would be asserting that
      // the scenario did not happen. An uncaught exception still is one: reporting a
      // failed library must not be a second way to break the editor.
      const thrown = hurtErrors.filter((e) => !/Failed to load resource/.test(e));
      check(thrown.length === 0, 'and reporting it raises no uncaught page errors',
        thrown.slice(0, 2).join(' | ') || 'none beyond the 500 this page is about');
      await hurt.close();
    }
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 14 || sv.port === MAC_PORT + 15)) {
      p.child.kill('SIGKILL');
    }

    // A preset from a version this build does not read - and **which** refusal it gets,
    // because the sentence is the whole value of the row. One version too old to have a
    // path and one from a build that does not exist yet: they are incompatible for
    // different reasons, and a single fallback sentence sent the first after a scale
    // factor that was never its problem while telling the second about a format four
    // versions behind it.
    const refusalFor = async (version) => page.evaluate(`(() => {
      try {
        globalThis.__kinect.library.applyStoredPreset({ name: 'old', rev: 'sha256:0', body: { version: ${version}, values: { bloom: 1 } } });
        return 'ACCEPTED';
      } catch (e) { return e.message; }
    })()`);
    const refusedOld = await refusalFor(2);
    const refusedFuture = await refusalFor(PROJECT_VERSION + 1);
    check(refusedOld !== 'ACCEPTED' && refusedFuture !== 'ACCEPTED',
      'a preset from another format version is refused', `${refusedOld.slice(0, 40)} / ${refusedFuture.slice(0, 40)}`);
    check(/no path from here/.test(refusedOld) && !/later build/.test(refusedOld),
      'a version this build has no conversion for says so rather than blaming the units',
      refusedOld.slice(0, 130));
    check(/later build/.test(refusedFuture) && !/no path from here/.test(refusedFuture),
      'and a version from a later build gets its own answer rather than the older one\'s',
      refusedFuture.slice(0, 130));

    check(errors.length === 0, 'the preset path raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  // --------------------------------------------------- 9. marks on the scrubber
  console.log('\n[library] marks on the editor\'s scrubber, through the retime curve');
  {
    const { page, errors } = await openPage(browser, editorPage(macUrl, 'local-clip'), { width: 1100, height: 700 });
    await page.waitForFunction('globalThis.__kinect?.timeline?.transport() !== null', null, { timeout: 40000 });
    await page.evaluate('globalThis.__kinect.timeline.settled()');

    // **`timeline.settled()` settles the transport, and the marks are not on it.**
    // They arrive on the library's own fetch, so a read taken the instant the render
    // queue drained came back `0 marks` beside `4 ticks` on a loaded machine - a row
    // red for a reason that has nothing to do with what it tests, which is the same
    // shape as section 4c's inverted wait. Waited for, and swallowed rather than
    // thrown, so a build that genuinely loads none fails the row below with its own
    // number instead of ending the section with a timeout.
    await page.waitForFunction('globalThis.__kinect.library.marks().length > 0', null, { timeout: 15000 })
      .catch(() => {});
    const marks = await page.evaluate('globalThis.__kinect.library.marks()');
    check(marks.length === 4, 'the take\'s marks are loaded with it', `${marks.length} marks`);
    check(marks.every((m, i) => i === 0 || m.sourceMs >= marks[i - 1].sourceMs),
      'and they arrive in source order');

    const flat = await page.evaluate('globalThis.__kinect.library.markTicks()');
    check(flat.length === marks.length, 'every mark draws a tick on the ruler', `${flat.length} ticks`);
    check(flat[0].left === 0, 'a mark at source zero ticks at the left edge');
    check(flat[flat.length - 1].beyond === true,
      'and a mark the edit never reaches is drawn at the edge as unreachable rather than dropped');

    // **The probe has to stand where a wrong implementation would disagree.** At
    // rate 1 with no keys, program time *is* source time, so a tick drawn from the
    // source fraction and a tick drawn through the curve land on the same pixel -
    // every assertion above would pass against an implementation that never looked
    // at the retime at all. So the curve gets a ramp, and the ticks have to move.
    const KEYS = [{ t: 0, value: 0 }, { t: 4, value: 0.6 }, { t: 6, value: 2.4 }];
    await page.evaluate(`globalThis.__kinect.keyframes.setRetime({ rate: 1, keys: ${JSON.stringify(KEYS)} })`);
    await page.evaluate('globalThis.__kinect.timeline.settled()');
    const retimed = await page.evaluate('globalThis.__kinect.library.markTicks()');
    const shown = await page.evaluate('globalThis.__kinect.timeline.read()');
    check(retimed.length === flat.length, 'a retime does not lose a tick');

    // **Asserted against positions computed here, not against "they moved".** A
    // retime changes the program duration as well as the mapping, so the ruler's
    // denominator moves too - and a build that drew ticks at the raw source
    // fraction would have every tick move for that reason alone and pass a
    // did-it-change test. The curve's inverse is therefore worked out in this file,
    // from the keys this file wrote, with the handles left linear so a straight
    // segment is a straight segment.
    const programOf = (sourceSec) => {
      if (sourceSec <= KEYS[0].value) return KEYS[0].t;
      for (let i = 0; i < KEYS.length - 1; i++) {
        if (KEYS[i + 1].value < sourceSec) continue;
        const span = (KEYS[i + 1].value - KEYS[i].value) / (KEYS[i + 1].t - KEYS[i].t);
        return KEYS[i].t + (sourceSec - KEYS[i].value) / span;
      }
      const last = KEYS.length - 1;
      const span = (KEYS[last].value - KEYS[last - 1].value) / (KEYS[last].t - KEYS[last - 1].t);
      return KEYS[last].t + (sourceSec - KEYS[last].value) / span;
    };
    const pct = (x) => Math.max(0, Math.min(1, x)) * 100;
    const expected = marks.map((m) => pct(programOf(m.sourceMs / 1000) / shown.duration));
    // Where the wrong implementation would draw each tick: the raw source fraction,
    // over the same denominator. Computed rather than assumed, because that is what
    // decides which of these marks is a probe and which is a coincidence - and the
    // comparison against the *pre-retime* layout cannot decide it, since a retime
    // moves the denominator too and every tick shifts for that reason alone.
    const naive = marks.map((m) => pct(m.sourceMs / 1000 / shown.duration));
    const off = retimed.map((t, i) => Math.abs(t.left - expected[i]));
    const discriminating = marks.map((_, i) => i).filter((i) => Math.abs(expected[i] - naive[i]) > 5);
    check(discriminating.length >= 2,
      'at least two marks land somewhere the source fraction cannot, which is what makes them probes',
      marks.map((m, i) => `${(m.sourceMs / 1000).toFixed(1)}s: curve ${expected[i].toFixed(1)}% against fraction ${naive[i].toFixed(1)}%`).join('; '));
    check(discriminating.every((i) => off[i] < 1.5),
      'and each tick sits where the curve puts it rather than where the fraction would',
      marks.map((m, i) => `${(m.sourceMs / 1000).toFixed(1)}s -> ${retimed[i].left.toFixed(1)}% (want ${expected[i].toFixed(1)}%)`).join('; '));

    // A mark written from the editor lands in the take's sidecar, in source
    // milliseconds, so it outlives this project.
    await page.evaluate('globalThis.__kinect.timeline.transport().seek(1.0)');
    await page.evaluate('globalThis.__kinect.timeline.settled()');
    await page.evaluate('globalThis.__kinect.library.markHere()');
    const written = (await getJson(`${macUrl}/capture/local-clip/marks`)).marks;
    check(written.length === 5, 'pressing mark writes to the take\'s sidecar', `${written.length} marks now`);
    const sourceAt1 = await page.evaluate('globalThis.__kinect.timeline.retime.sourceSecAt(1.0)');
    const fresh = written.find((m) => !['k0', 'k1', 'k2', 'kBeyond'].includes(m.id));
    check(Math.abs(fresh.sourceMs - sourceAt1 * 1000) < 40,
      'and it is stamped in source milliseconds rather than program time',
      `${fresh.sourceMs}ms against source ${(sourceAt1 * 1000).toFixed(0)}ms at program 1.0s`);

    check(errors.length === 0, 'the marks path raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  // ------------------------------------------------------------ 10. the recorder
  console.log('\n[library] a take is a file, and the remaining-time report is a duration');
  {
    const state = await getJson(`${macUrl}/record/state`);
    check(state.recording === false && state.armed === false, 'a server with no sensor is not recording');
    check(/^(\d+h \d+m|\d+m \d+s|\d+s|unbounded)$/.test(state.storage.label),
      `the monitor's space readout is a duration (${state.storage.label})`);
    check(state.storage.secondsLeft > 0, 'and it is derived from a rate rather than being a byte count');
    const marked = await post(`${macUrl}/record/mark`, {});
    check(/nothing is recording/.test(marked.error ?? ''),
      'pressing mark with no take open says so rather than writing a mark nowhere',
      (marked.error ?? 'ACCEPTED').slice(0, 60));
  }

  // ------------------------------------------- 5. download, reclaim and delete
  console.log('\n[library] download verifies, reclaim keeps a verified copy, delete is the last one');
  {
    // The remote take deliberately shares a *filename* with a different local take,
    // because that is the case a name-based implementation destroys footage in: the
    // library already lists them as two entries, and writing one at the other's name
    // would delete a take to satisfy a convention this design does not use.
    const remote = (await getJson(`${macUrl}/library/all`)).takes.find((t) => t.state === 'remote');
    const localSameName = readFileSync(join(macCaps, 'same-name.knct'));
    const pulled = await post(`${macUrl}/library/download/${remote.id}`);
    check(pulled.hash === remote.hash, `a download lands under the hash the node advertised (${remote.id})`,
      JSON.stringify(pulled).slice(0, 90));
    check(Buffer.compare(readFileSync(join(macCaps, 'same-name.knct')), localSameName) === 0,
      'and it does not overwrite a different local take that happens to share its filename',
      `landed as ${pulled.downloaded}`);
    check(pulled.downloaded !== 'same-name.knct' && /same-name-[0-9a-f]{8}\.knct/.test(pulled.downloaded),
      'the collision takes the hash into the name, which is what the join was already saying');

    // The marks came with it, merged rather than replaced, with the tombstone
    // holding: n1 and n2 survive, n3 does not.
    const shared = 'mac-name-for-it';
    await post(`${macUrl}/library/sync-marks/${shared}`, {});
    const merged = (await getJson(`${macUrl}/capture/${shared}/marks`)).marks;
    check(merged.length === 2 && merged.every((m) => m.id !== 'n3'),
      'a sync merges the node\'s log as a union and a tombstone stays dead',
      merged.map((m) => m.id).join(' '));
    // Last-write-wins per id, in the direction that matters: a later local edit of
    // a mark the node also holds.
    await post(`${macUrl}/capture/${shared}/marks`, { marks: [{ id: 'n2', sourceMs: 4242, label: 'moved here', at: 9e12 }] });
    await post(`${macUrl}/library/sync-marks/${shared}`, {});
    const afterSync = (await getJson(`${macUrl}/capture/${shared}/marks`)).marks;
    check(afterSync.find((m) => m.id === 'n2')?.sourceMs === 4242,
      'and a later edit wins over an older record with the same id even after a re-sync');

    // Delete refuses what reclaim is for, and reclaim refuses what delete is for.
    const bothTake = (await getJson(`${macUrl}/library/all`)).takes.find((t) => t.state === 'both');
    const wrongDelete = await post(`${macUrl}/library/delete/${bothTake.id}`, { hash: bothTake.hash, confirm: true });
    check(/exists on/.test(wrongDelete.error ?? ''), 'delete refuses a take that exists in two places',
      (wrongDelete.error ?? 'ACCEPTED').slice(0, 70));
    const noConfirm = await post(`${macUrl}/library/delete/local-clip`, { hash: 'sha256:x' });
    check(/confirm/.test(noConfirm.error ?? ''), 'delete refuses without an explicit confirm');
    const wrongHash = await post(`${macUrl}/library/delete/local-clip`, { hash: 'sha256:nope', confirm: true });
    check(/moved underneath|not the/.test(wrongHash.error ?? ''),
      'delete refuses a hash that is not the take\'s, so a stale listing cannot remove the wrong file');
    const badReclaim = await post(`${macUrl}/library/reclaim/local-clip`, {});
    check(/nothing to reclaim/.test(badReclaim.error ?? ''), 'reclaim refuses a take that exists in one place');

    // **The falsification control, and it has to be a substitution the manifest
    // cannot see.** Reclaim rests on a hash-verified copy surviving here, so the
    // copy is damaged and the reclaim has to notice - but damaging it in a way that
    // changes the file's size or its modification time only proves the index cache
    // invalidates, which is a different claim and is checked above. The case this
    // exists for is the one step 2's sidecar comment names: **same size, same
    // mtime, different bytes**, which is what a bad sync or a restored backup
    // produces. The sidecar then still says the old hash, the take still reconciles
    // against the node's, and the only thing standing between the operator and a
    // reclaim that destroys the last good copy is the re-hash on the removal path.
    //
    // Constructed through the sidecar rather than by holding the modification time
    // still, and that is a method note worth keeping: APFS records mtime to the
    // nanosecond while `utimesSync` takes a JavaScript Date, so restoring a time
    // that way lands a few hundred nanoseconds off and the scan notices - the same
    // precision mismatch that made `index-check`'s mtime assertion fail on its
    // first run. Writing the sidecar to describe the *new* file with the *old* hash
    // reaches the identical state deterministically: the size matches, the time
    // matches, and the hash on record is a lie.
    const localPath = join(macCaps, `${bothTake.id}.knct`);
    const sidecarPath = localPath.replace(/\.knct$/, '.idx');
    const good = readFileSync(localPath);
    const swapped = Buffer.from(good);
    swapped.fill(0, swapped.length - 5000);
    writeFileSync(localPath, swapped);
    const sidecar = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    writeFileSync(sidecarPath, JSON.stringify({
      ...sidecar, bytes: statSync(localPath).size, mtimeMs: statSync(localPath).mtimeMs,
    }));
    const stale = (await getJson(`${macUrl}/library/all`)).takes.find((t) => t.id === bothTake.id);
    check(stale?.hash === bothTake.hash,
      'the substitution is invisible to the manifest, which is what makes this a control',
      `listing still reports ${String(stale?.hash).slice(7, 19)}`);
    const refused = await post(`${macUrl}/library/reclaim/${bothTake.id}`, {});
    const nodeStillHasIt = (await getJson(`${nodeUrl}/library/takes`)).takes.some((t) => t.hash === bothTake.hash);
    check(/refusing to reclaim/.test(refused.error ?? ''),
      'reclaim re-hashes the surviving copy and refuses when the bytes are not what the library listed',
      (refused.error ?? 'ACCEPTED').slice(0, 90));
    check(nodeStillHasIt, 'and the node still holds its copy - nothing was removed on a stale belief');

    // Restored, and the lying sidecar removed with it so the next listing is a scan
    // of what is actually there.
    writeFileSync(localPath, good);
    rmSync(sidecarPath, { force: true });
    const fresh = (await getJson(`${macUrl}/library/all`)).takes.find((t) => t.id === bothTake.id);
    const done = await post(`${macUrl}/library/reclaim/${fresh.id}`, {});
    const nodeGone = !(await getJson(`${nodeUrl}/library/takes`)).takes.some((t) => t.hash === fresh.hash);
    check(done.reclaimed && done.keptHere === fresh.hash,
      'a reclaim against a verified copy removes the node\'s and names the survivor\'s hash');
    check(nodeGone && existsSync(localPath),
      'the node\'s copy is gone and the hash-verified one here is not');

    // **The same substitution, now on the delete path.** Reclaim re-derived the hash
    // and delete read it off the sidecar, which meant the irreversible action was
    // carrying the weaker check - and the technique that catches it was already
    // sitting in this tool twenty lines up, built as reclaim's falsification
    // control. Same size, same modification time, different bytes: the manifest
    // cannot see it, the listing keeps reporting the hash the sidecar remembers,
    // and a delete built on that listing removes a file whose bytes nobody looked at.
    {
      const victimPath = join(macCaps, 'no-hello-take.knct');
      const victimSidecar = victimPath.replace(/\.knct$/, '.idx');
      const listedBefore = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'no-hello-take');
      const original = readFileSync(victimPath);
      const substituted = Buffer.from(original);
      substituted.fill(0, substituted.length - 5000);
      writeFileSync(victimPath, substituted);
      const idx = JSON.parse(readFileSync(victimSidecar, 'utf8'));
      writeFileSync(victimSidecar, JSON.stringify({
        ...idx, bytes: statSync(victimPath).size, mtimeMs: statSync(victimPath).mtimeMs,
      }));
      const stillListed = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'no-hello-take');
      check(stillListed?.hash === listedBefore.hash,
        'the substitution is invisible to the manifest here too, which is what makes this the same control',
        `listing still reports ${String(stillListed?.hash).slice(7, 19)}`);
      const refusedDelete = await post(`${macUrl}/library/delete/no-hello-take`,
        { hash: listedBefore.hash, confirm: true });
      check(/not the .*this removal named|moved underneath/.test(refusedDelete.error ?? ''),
        'delete re-hashes the file it is about to unlink and refuses when the bytes are not what the library listed',
        (refusedDelete.error ?? 'ACCEPTED').slice(0, 90));
      check(existsSync(victimPath),
        'and the file is still there - the only irreversible action does not run on a hash nobody re-derived');
      // Restored, and the lying sidecar with it, so the delete below is a delete of
      // a take whose bytes are what the library says.
      writeFileSync(victimPath, original);
      rmSync(victimSidecar, { force: true });
      const honest = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'no-hello-take');
      const gone = await post(`${macUrl}/library/delete/no-hello-take`, { hash: honest.hash, confirm: true });
      check(gone.removed === 'no-hello-take.knct' && !existsSync(victimPath),
        'while a delete whose hash matches the bytes on disk goes through - the control that stops the row above being a delete that simply never works');
    }

    // Delete: the last copy, and it is genuinely the last one afterwards.
    const last = (await getJson(`${macUrl}/library/all`)).takes.find((t) => t.id === 'one-frame-take');
    const deleted = await post(`${macUrl}/library/delete/one-frame-take`, { hash: last.hash, confirm: true });
    check(deleted.removed === 'one-frame-take.knct' && !existsSync(join(macCaps, 'one-frame-take.knct')),
      'delete removes the last copy, and it is the file that goes');
    check(!(await getJson(`${macUrl}/library/all`)).takes.some((t) => t.id === 'one-frame-take'),
      'and the library no longer lists it');
  }

  // ------------------------------------------- 7. the routes that change something
  //
  // **Enumerated rather than named.** The review that produced this section found six
  // routes dispatching on the path alone - `GET /record/stop` ending a shoot,
  // `GET /library/reclaim/:id` destroying the node's copy - by poking them one at a
  // time, which makes six a floor rather than a total and leaves the next route
  // anybody adds outside whatever list gets written today. So the server serves its
  // own route table at `/library/routes`, derived from the array the dispatcher
  // walks rather than restated beside it, and this section iterates it: every route
  // that changes something is asked the same three questions, and a route added
  // later is asked them by existing.
  //
  // One row per term, because a cumulative row cannot say which term broke. The
  // method probe carries a JSON content type and no foreign origin, so only the
  // method is under test; the content-type probe carries the right method; the
  // origin probe carries both. Each of the three mutations below fails its own rows
  // and leaves the other two alone.
  //
  // And the fourth row is the falsification control: the same request in the shape
  // the capture-node link actually uses - correct method, JSON, and **no `Origin`
  // header at all**, because nothing in Node has an origin to declare - has to be
  // let through. Without it, a guard that refused everything would pass the first
  // three rows perfectly.
  console.log('\n[library] every route that changes something requires its method, its type and its origin');
  {
    const guardDir = join(WORK, 'guarded');
    mkdirSync(guardDir, { recursive: true });
    writeTake(guardDir, 'guard-take', { frames: 6 });
    // Given its own document directories rather than left on the defaults. The
    // control probe below is a *successful* write - that is what makes it a control -
    // so on the defaults it planted `no-such-document.json` in the staged tree's own
    // `projects/` on every run, clean runs included. A proof tool that leaves files
    // in a directory it did not make is a habit worth not starting.
    const guardDocs = join(WORK, 'guard-docs');
    const guardPresets = join(WORK, 'guard-presets');
    const guardUrl = await startServer(root, [
      '--captures', guardDir, '--name', 'guarded',
      '--projects', guardDocs, '--presets', guardPresets,
    ], MAC_PORT + 8);
    const table = (await getJson(`${guardUrl}/library/routes`)).routes;

    // **The file tree must not answer for a namespace the route table owns**, and
    // this is asked of every namespace in the table rather than of the five
    // somebody wrote down. The dispatcher used to hold that list as a literal, so
    // the day a namespace was added it was outside the list until someone noticed -
    // which is the "close the class, not the instance" rule, aimed at the seam step
    // 8 was about to add `jobs` to.
    //
    // It is deliberately NOT a traversal test. The handoff that asked for this said
    // `/jobs/../web/main.js` traverses, and it does not: `new URL()` removes dot
    // segments including `%2e%2e`, and `isInside` rejects whatever is left, so four
    // escape attempts all came back with nothing served. The real property is
    // shadowing, and it is worth one measured sentence rather than a story - a file
    // planted under an unowned namespace IS served, 200 with its contents, and the
    // same file under an owned one is the API's 404.
    const tableNamespaces = [...new Set(table.map((r) => r.path.split('/')[1]))];
    check(tableNamespaces.length >= 5, 'the route table declares its namespaces, so this row grows when a step adds one',
      tableNamespaces.join(', '));

    // **The probe is two segments deep, and the first version was not.** A file at
    // `/presets/shadow-probe.js` is claimed by `/presets/:name`, whose `([^/]+)`
    // matches it - so the table answered 404 out of `readDocument` and the
    // fallthrough this row is about was never reached. The mutation below ran the
    // whole suite and was NOT caught, at 255 assertions and none failed, which is
    // what a probe sitting in a dead zone looks like from the outside: indis-
    // tinguishable from a build with nothing wrong with it. A slash in the tail
    // puts it past every `([^/]+)` in the table.
    const PROBE = 'shadow-probe/leak.js';
    // The unowned twin. Without it the owned rows could all be 404 because nothing
    // is served from anywhere - a check that only asserts refusals passes happily
    // against a file server that is simply broken.
    const CONTROL_NS = 'not-a-declared-namespace';
    for (const ns of [...tableNamespaces, CONTROL_NS]) {
      mkdirSync(join(root, 'web', ns, 'shadow-probe'), { recursive: true });
      writeFileSync(join(root, 'web', ns, PROBE), `// planted under /${ns} by library-check\n`);
    }
    const control = await fetch(`${guardUrl}/${CONTROL_NS}/${PROBE}`);
    check(control.status === 200,
      'a file under a namespace the table does NOT declare is served off disk, which is what makes the next row mean something',
      `/${CONTROL_NS}/${PROBE} -> ${control.status}`);
    const shadowed = [];
    for (const ns of tableNamespaces) {
      const res = await fetch(`${guardUrl}/${ns}/${PROBE}`);
      if (res.status !== 404) shadowed.push(`${ns}:${res.status}`);
    }
    check(shadowed.length === 0,
      'and the identical file under every namespace the table DOES declare is the API\'s 404, not the file',
      shadowed.length ? `served: ${shadowed.join(' ')}` : `${tableNamespaces.length} namespaces, all 404`);
    // Removed again so the planted files cannot make any later row mean something
    // different from what it says.
    for (const ns of [...tableNamespaces, CONTROL_NS]) rmSync(join(root, 'web', ns), { recursive: true, force: true });

    const mutating = table.filter((r) => r.mutates);
    // A route that also answers GET is a legitimate read at that method, so the
    // method row below is about the ones where a GET can only be somebody else's
    // idea. What covers the rest is the read sweep further down: every route with a
    // read handler is driven with a plain GET and the recorder and the captures
    // directory have to be where they were.
    const writeOnly = mutating.filter((r) => !r.read);
    const readable = table.filter((r) => r.read);
    // **A count of registered routes cannot answer "did a read handler mutate
    // something", and this row used to be one.** It read
    // `mutating.length >= 10 && writeOnly.length >= 7`, today's values - which
    // *moving* a route into the read slot trips, because the counts fall, and which
    // **adding** one cannot trip at all, because adding a read route moves neither
    // number in the failing direction. So the floor was structurally blind to
    // exactly the shape the rule names, and a planted mutating read route went
    // through the whole suite at 241 of 241 with its file on disk afterwards.
    //
    // What replaces it is a coverage row further down - every entry in the table
    // driven, with any route this sweep cannot build a concrete URL for named rather
    // than skipped - and the resource rows beside it, which observe what moved.
    // Coverage in one place, behaviour in another.
    const swept = new Set();
    console.log(`  ...   ${table.length} routes, ${mutating.length} mutating, `
      + `${writeOnly.length} of those write-only, ${readable.length} answering GET`);

    // A concrete URL for a route pattern. Ids that do not exist on purpose: the
    // guard runs before the handler, so its verdict is visible either way, and a
    // refusal that comes from the handler is a refusal this section is not about.
    //
    // **A path this cannot make concrete comes back null rather than half-built.** A
    // route added later with a parameter nobody taught this about would otherwise be
    // driven at a URL still carrying a literal `:foo`, match no pattern, answer 404
    // and be recorded as swept - a route counted and not tested, which is the same
    // bookkeeping-instead-of-resource failure the sweep below exists to close.
    const concrete = (path, { id = 'no-such-take', name = 'no-such-document' } = {}) => {
      const built = path
        .replace(':id', id)
        .replace(':name', name)
        .replace(':a-:b', '0-1')
        .replace(':n', '0');
      return built.includes(':') ? null : built;
    };
    const urlFor = (path) => guardUrl + concrete(path);
    const status = async (path, init) => (await fetch(urlFor(path), init)).status;
    const GUARDED = new Set([403, 405, 415]);

    const wrongMethod = [];
    const wrongType = [];
    const wrongOrigin = [];
    const refusedOutright = [];
    for (const r of mutating) {
      swept.add(r.path);
      const method = r.methods[0];
      // Method: a GET that is otherwise perfectly formed. This is the shape a link
      // prefetch or an `<img src>` produces, which is how `GET /record/stop` was
      // reachable from any page anybody visited. Asked only of the routes that offer
      // nothing to read, since a GET of `/projects/:name` is a project being read.
      if (!r.read && await status(r.path, { headers: { 'Content-Type': 'application/json' } }) !== 405) wrongMethod.push(r.path);
      // Content type: the right method, declaring text/plain. This is the only shape
      // a cross-origin `no-cors` fetch can send, so it is the term that actually
      // stops a hostile page.
      if (await status(r.path, { method, headers: { 'Content-Type': 'text/plain' }, body: '{}' }) !== 415) wrongType.push(r.path);
      // Origin: everything right except the page it claims to come from.
      if (await status(r.path, {
        method,
        headers: { 'Content-Type': 'application/json', Origin: 'http://evil.invalid' },
        body: '{}',
      }) !== 403) wrongOrigin.push(r.path);
      // The control. No `Origin` at all, which is every call across the node link.
      if (GUARDED.has(await status(r.path, { method, headers: { 'Content-Type': 'application/json' }, body: '{}' }))) {
        refusedOutright.push(r.path);
      }
    }
    check(wrongMethod.length === 0,
      `every route that only changes things refuses a GET (${writeOnly.length} of ${mutating.length} mutating routes)`,
      wrongMethod.join(' ') || 'all 405');
    check(wrongType.length === 0,
      'every mutating route refuses a body that does not declare JSON', wrongType.join(' ') || 'all 415');
    check(wrongOrigin.length === 0,
      'every mutating route refuses a cross-origin caller', wrongOrigin.join(' ') || 'all 403');
    check(refusedOutright.length === 0,
      'and the shape the node link uses - right method, JSON, no Origin header - is let through, which is what stops this being a guard that refuses everything',
      refusedOutright.join(' ') || `${mutating.length} routes reached their handler`);

    // **A refusal has to mean the route did not act**, which a status code does not
    // say on its own. Driven on the two the reviewer demonstrated, against a server
    // that is genuinely recording, because "the take is still open afterwards" is
    // the assertion a 405 cannot make.
    const shootDir = join(WORK, 'guard-shooting');
    const shootProjects = join(WORK, 'guard-shooting-projects');
    const shootPresets = join(WORK, 'guard-shooting-presets');
    const shootDeliverables = join(WORK, 'guard-shooting-deliverables');
    for (const d of [shootDir, shootProjects, shootPresets, shootDeliverables]) {
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
    }
    // **All six stores, and a closed take beside the open one.** The read sweep
    // below used to spawn this server on the default document directories, which put
    // `projects/` and `presets/` outside the one directory it snapshotted - so three
    // of the library's five stores were unobserved, and a route registered as a
    // `read` whose handler wrote a project went through the entire suite at 241 of
    // 241 with its file sitting on disk afterwards. Two of five is not a sweep.
    //
    // The closed take is the other half. Substituting the *recording* take's id into
    // every `:id` looks like coverage and is not: `beingRecorded` answers 409 before
    // the handler runs, so `/capture/:id/hello`, `/index`, `/file`, `/frame/:n` and
    // `/frames/:a-:b` were driven and never executed - five routes counted as swept
    // and not swept, and a mutation inside `serveIndex` unreachable however closely
    // the directory was watched. Both ids are driven, and the row below asserts by
    // name that every route got past the 409.
    const closedTake = writeTake(shootDir, 'a-closed-take', { frames: 6 });
    // Seeded documents, so `/projects/:name` and `/presets/:name` run their found
    // path as well as their not-found one - a mutation in the branch that reads an
    // existing document is unreached by a name that does not exist.
    const SEEDED_PROJECT = {
      version: PROJECT_VERSION,
      look: { params: {}, tracks: {} },
      composition: { retime: { rate: 1, keys: [] }, camera: [] },
      outputSize: '1920x1080',
      appliedPreset: null,
    };
    writeFileSync(join(shootProjects, 'seeded-project.json'), `${JSON.stringify(SEEDED_PROJECT, null, 2)}\n`);
    writeFileSync(join(shootPresets, 'seeded-preset.json'), `${JSON.stringify({ version: PROJECT_VERSION, values: {} }, null, 2)}\n`);
    const shootUrl = await startServer(root, [
      '--captures', shootDir, '--name', 'shooting', '--record', '--no-color',
      '--projects', shootProjects, '--presets', shootPresets,
      '--deliverables', shootDeliverables,
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
    ], MAC_PORT + 9);
    let shooting = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      shooting = await getJson(`${shootUrl}/record/state`);
      if (shooting.recording) break;
    }
    check(shooting?.recording === true, 'a take is open, which is what makes the next two rows about behaviour rather than status codes',
      String(shooting?.takeId));
    const stopStatus = (await fetch(`${shootUrl}/record/stop`, { headers: { 'Content-Type': 'application/json' } })).status;
    const afterStop = await getJson(`${shootUrl}/record/state`);
    check(stopStatus === 405 && afterStop.recording === true && afterStop.takeId === shooting.takeId,
      'a GET of /record/stop is refused and the take is still open - the refusal is a decision, not a status on a thing that already happened',
      `${stopStatus}, still ${afterStop.takeId}`);

    // Every read route driven, and every store this server owns asserted not to have
    // moved. This is what stops a route hiding a mutation behind a `read` handler,
    // which is the only way left to add one the guard above never sees - and it is
    // the resources that are read, never a count of registered routes, because a
    // count cannot answer whether a handler wrote something.
    //
    // **Both methods.** `serveRoute` treats HEAD as reading, which is correct and is
    // why HEAD works at all - but a sweep that only sends GET is blind to a handler
    // that mutates on HEAD, and the dispatcher would carry it there just the same.
    //
    // The snapshot is name, size and modification time for every file in all three
    // directories, plus the document revisions the stores report, plus the recorder's
    // own state. Modification time is in it deliberately: a plant that rewrites the
    // same bytes leaves the name and the size where they were.
    //
    // **A before-and-after snapshot cannot see a write that is put back, so it is not
    // what the next row rests on.** A handler that writes and restores inside the same
    // request is invisible to any pair of readings taken outside it: the bytes match,
    // and the modification time is one `utimes` call away from matching too. So the
    // stores carry a monotonic write count, served at `/library/writes`, and that is
    // the row - a count is the one thing a restore cannot undo. The contents comparison
    // stays as the second opinion rather than the only one.
    //
    // One shape is still outside this, and it is outside the *drive* rather than the
    // snapshot: a handler that mutates only on a query parameter. This sweep sends
    // none, so any parameter at all is unswept, and no enumeration of the route table
    // can find one that is not declared. A hole until measured otherwise.
    //
    // **Two things move for reasons that are not a read route, and both are named
    // rather than left to weaken the row.** The take being recorded grows while this
    // runs - measured 4.89MB to 6.35MB across one sweep - so its own bytes are out of
    // the comparison while its presence stays in, and a sidecar appearing beside it is
    // a separate row below. And reading a capture legitimately opens and caches a
    // descriptor, which is the module's designed behaviour, so the count gets a bound
    // rather than an equality: 22 to 28 across the same sweep, which is caching, where
    // a route holding one per request would run away.
    const snapshotDir = (dir, growing = null) => readdirSync(dir).sort().map((f) => {
      if (f === growing) return `${f}:being-written`;
      const st = statSync(join(dir, f));
      return `${f}:${st.size}:${st.mtimeMs}`;
    }).join(' ');
    const snapshot = async () => JSON.stringify({
      captures: snapshotDir(shootDir, `${shooting.takeId}.knct`),
      projects: snapshotDir(shootProjects),
      presets: snapshotDir(shootPresets),
      deliverables: snapshotDir(shootDeliverables),
      // Revisions rather than names, and they are the stores' own: `DocumentStore.list`
      // hashes the bytes on disk, so a plant that overwrites a document that is
      // already there moves this where a listing of filenames would not.
      projectRevs: (await getJson(`${shootUrl}/projects`)).projects?.map((d) => `${d.name}=${d.rev}`) ?? null,
      presetRevs: (await getJson(`${shootUrl}/presets`)).presets?.map((d) => `${d.name}=${d.rev}`) ?? null,
      deliverableRevs: (await getJson(`${shootUrl}/deliverables`)).deliverables?.map((d) => `${d.name}=${d.rev}`) ?? null,
      recorder: await getJson(`${shootUrl}/record/state`).then((s) => `${s.recording}:${s.takeId}:${s.dropped}`),
    });
    const descriptorsNow = async () => (await getJson(`${shootUrl}/library/descriptors`)).real;

    // Warmed first, and only these two, because scanning a *closed* take and writing
    // its sidecar is what makes it a gallery entry - designed behaviour rather than a
    // read that mutates. Warming exactly the two calls that do it, by name, keeps the
    // snapshot below able to see a file appear: a blanket warm would have created the
    // planted document too, and then only its modification time would have moved.
    await fetch(`${shootUrl}/library/all`).catch(() => {});
    await fetch(`${shootUrl}/capture/a-closed-take/index`).catch(() => {});

    const before = await snapshot();
    const writesBefore = JSON.stringify(await getJson(`${shootUrl}/library/writes`));
    const fdBefore = await descriptorsNow();
    const reached = new Map();
    const unbuildable = [];
    for (const r of readable) {
      swept.add(r.path);
      for (const id of [shooting.takeId, 'a-closed-take']) {
        for (const name of ['seeded-project', 'nothing']) {
          const path = concrete(r.path, { id, name: r.path.startsWith('/presets') ? name.replace('project', 'preset') : name });
          if (path === null) { unbuildable.push(r.path); continue; }
          for (const method of ['GET', 'HEAD']) {
            const code = await fetch(shootUrl + path, { method }).then((x) => x.status).catch(() => 0);
            // 409 is `beingRecorded` answering before the handler runs. Anything else
            // means the handler executed - a 404 out of `readDocument` is the handler
            // having looked - so "not 409" is the reached predicate and a 200 is not.
            if (code !== 409) reached.set(r.path, `${code} on ${id === shooting.takeId ? 'the open take' : 'a closed take'}`);
          }
        }
      }
    }
    // The fallthrough, driven inside the same window: a static file, an unclaimed
    // path under every namespace the table owns, and a GET of a write-only route.
    // Nothing downstream of `ROUTES` may write, and this is that assertion observed
    // rather than assumed - the static server only reads today, and the day it does
    // not, this window is where it shows.
    const namespaces = [...new Set(table.map((r) => r.path.split('/')[1]))];
    for (const path of ['/main.js', '/', '/no-such-file.js', ...namespaces.map((ns) => `/${ns}/no-such-route-here`)]) {
      await fetch(shootUrl + path).catch(() => {});
    }
    await fetch(`${shootUrl}/record/stop`, { headers: { 'Content-Type': 'application/json' } }).catch(() => {});
    const after = await snapshot();
    const writesAfter = JSON.stringify(await getJson(`${shootUrl}/library/writes`));
    const fdAfter = await descriptorsNow();

    check(unbuildable.length === 0 && swept.size === table.length,
      `all ${table.length} routes the server declares are driven, so a route added later is swept by existing`,
      unbuildable.length ? `no concrete URL for ${unbuildable.join(' ')}`
        : `${swept.size} of ${table.length} driven, ${readable.length} of them with GET and HEAD against an open and a closed take`);
    check(reached.size === readable.length,
      'and every one of them actually runs its handler rather than stopping at a 409 the fixture caused',
      readable.filter((r) => !reached.has(r.path)).map((r) => r.path).join(' ')
        || `${reached.size} reached: ${[...reached].map(([p, c]) => `${p} ${c}`).join(', ')}`.slice(0, 150));
    // **The row a write-and-restore cannot pass.** Asserted before the contents
    // comparison because it is the stronger of the two: the counts are monotonic, so a
    // handler that writes a document and puts the bytes and the timestamp back still
    // moves them, where the snapshot below sees a store that never changed.
    check(writesAfter === writesBefore,
      'not one of them writes a store even momentarily - a count no restore can undo, which is what a handler that writes and puts it back defeats a contents comparison with',
      `${writesBefore} then ${writesAfter}`);
    check(after === before,
      'and none of it moves a byte in any of the five stores, their sidecars or the recorder',
      after === before ? `${namespaces.length} namespaces and the file tree swept alongside, nothing moved`
        : `${before}\n              then ${after}`);
    // **The descriptor count is deliberately not a row here, and that is a measurement
    // rather than an omission.** `/library/descriptors` reports `/dev/fd`, which counts
    // sockets as well as captures, and this arm opens about seventy connections - so
    // the delta came in at 6 on a clean run and at 9 under `origin-unchecked` and
    // `content-type-unchecked`, two mutations that touch no descriptor at all. A row
    // on it fired on five unrelated mutations, which is a gate going red for reasons
    // that have nothing to do with what it tests. The descriptor bound has a section
    // of its own further down, where a raw socket against a quiet server controls for
    // exactly what this arm cannot.
    console.log(`  ...   ${fdBefore} descriptors before the sweep, ${fdAfter} after `
      + '(sockets included, which is why it is not a row - see section 9)');
    // The sidecar is the tell, and it is the same one section 11 uses. `buildIndex`
    // writes a `.idx` beside the take, so a read route that scanned the file the
    // recorder has open would leave one - which is how this arm caught
    // `/capture/:id/index` reaching that scan by a shorter road than the manifest.
    check(!existsSync(join(shootDir, `${shooting.takeId}.idx`)),
      'and the take still being written has no sidecar - the closed one beside it was scanned and this one was not',
      readdirSync(shootDir).sort().join(' '));

    // ---- and the shoot itself survived the sweep
    //
    // **Three observations are switched off at once for the file being recorded, so
    // a read route appending to it passed every row above.** Its size and modification
    // time are out of the snapshot by name, because they move on their own; no write
    // counter covers the captures directory, since the counters are on the two document
    // stores and the marks log; and the recorder's own state field is
    // `recording:takeId:dropped`, which a foreign append does not move. Demonstrated:
    // a read route appending 64KB to `recorder.openPath` gave 251 assertions, none
    // failed, exit 0, with the take ruined - `stream desync at 6349028: expected magic
    // KNCT, got 0x7070707` and nine surviving 4096-byte runs of 0x07 in the file.
    //
    // **The identity is section 10's, applied after the take closes rather than during
    // it, and the timing is the whole reason.** Comparing the file's size against the
    // recorder's own `bytes` while it is still recording is very nearly exact and not
    // exact: measured 40 samples over two seconds on a 40fps take, `onDisk - bytes` was
    // 0 every time - but that zero is a syscall-width window, not a guarantee, since the
    // bytes reach the disk before the callback that moves `bytesWritten` runs. One
    // sample landing inside it reddens the row by one frame for no reason, which is a
    // gate that teaches people to re-run. After `close`, nothing is in flight and the
    // identity is exact, which is why section 10 can assert it with `===`.
    const shotPath = join(shootDir, `${shooting.takeId}.knct`);
    const stopped = await post(`${shootUrl}/record/stop`);
    const shotSize = existsSync(shotPath) ? statSync(shotPath).size : -1;
    check(!stopped.error && Number.isFinite(stopped.stopped?.frames),
      'the take the sweep ran alongside still scans as one continuous stream - foreign bytes in the middle of it are a desync rather than a frame',
      stopped.error ? `close refused: ${String(stopped.error).slice(0, 100)}` : `${stopped.stopped?.frames} frames`);
    check(stopped.stopped?.bytes === shotSize,
      'and the file is exactly the bytes the recorder put there, which is the one reading a route writing to the open take cannot leave alone',
      `${stopped.stopped?.bytes} counted, ${shotSize} on disk`);
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 9)) p.child.kill('SIGKILL');

    // Marks used to be creatable for a take that does not exist, which put an
    // attacker-chosen `nosuchtake.marks.jsonl` in the captures directory - up to
    // four megabytes a request, and tombstones waiting to delete real marks the
    // moment a take of that name existed.
    const ghost = await post(`${guardUrl}/capture/nosuchtake/marks`,
      { marks: [{ id: 'x', sourceMs: 1, at: 1, label: 'planted' }] });
    check(/nothing to mark|no take/.test(ghost.error ?? ''),
      'marks on a take that is not here are refused rather than creating its sidecar',
      (ghost.error ?? 'ACCEPTED').slice(0, 70));
    check(!existsSync(join(guardDir, 'nosuchtake.marks.jsonl')),
      'and nothing was written to the captures directory',
      readdirSync(guardDir).join(' '));

    // A document from a build this one is not. It came back stamped as version 1 with
    // its version 2 fields underneath, which is exactly what the version field was
    // chosen over an authored buffer height to prevent. The future is one past whatever
    // this build writes, derived rather than written down - a literal 4 here was the
    // future until the readings made 4 the present, at which point this row quietly
    // started asserting that the current version is refused and passed by ACCEPTING it.
    const FUTURE = PROJECT_VERSION + 1;
    const future = await post(`${guardUrl}/projects/from-the-future`, { version: FUTURE, tracks: {}, futureField: 'kept' });
    check(new RegExp(`version ${FUTURE}`).test(future.error ?? ''),
      'a document from a future format version is refused rather than restamped as this one',
      (future.error ?? 'ACCEPTED').slice(0, 80));
    const stored = await getJson(`${guardUrl}/projects/from-the-future`);
    check(stored.error !== undefined,
      'and nothing was written, so a project this build cannot interpret never enters the store at all');
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 8)) p.child.kill('SIGKILL');
    // The control probe above is a write that succeeds, which is the point of it, so
    // it leaves a document behind. Cleared here rather than left in a directory this
    // section made: a proof tool whose clean run adds files is one nobody can use the
    // filesystem to reason about.
    rmSync(guardDocs, { recursive: true, force: true });
    rmSync(guardPresets, { recursive: true, force: true });
  }

  // -------------------------------------------- 8. recording a replay is refused
  //
  // **This arm exists because no other arm crossed replay with record.** Every
  // recording section spawns a server with a grabber and every replay section spawns
  // one with no recorder, so both halves agreed about a combination neither of them
  // stood in front of - which is the same shape as the descriptor section's own
  // history two hundred lines up, and the reason that one carries its story beside
  // the code.
  //
  // The record button on the viewer is unconditional, so this was one click in the
  // setup this repo documents: the take opened, `recorder.write(undefined)` threw on
  // every frame into the replay tick's catch, no frame reached any client, the
  // status flapped between lost and live, and `/record/state` reported a healthy
  // recording the whole time.
  console.log('\n[library] a replay server refuses to record, and goes on streaming');
  {
    const replayCaps = join(WORK, 'replay-record-captures');
    mkdirSync(replayCaps, { recursive: true });
    const source = join(WORK, 'replay-source');
    mkdirSync(source, { recursive: true });
    const replaying = writeTake(source, 'replay-me', { frames: 40 });
    const url = await startServer(root,
      ['--captures', replayCaps, '--name', 'replaying', '--replay', replaying], MAC_PORT + 10);

    const seen = { frames: 0, statuses: [] };
    const ws = new WebSocket(url.replace('http', 'ws'));
    ws.on('message', (data, isBinary) => {
      if (isBinary) seen.frames++;
      else {
        try {
          const msg = JSON.parse(data.toString('utf8'));
          if (msg.status) seen.statuses.push(msg.status);
        } catch { /* not a status message */ }
      }
    });
    await new Promise((done, fail) => { ws.on('open', done); ws.on('error', fail); });
    await new Promise((done) => { setTimeout(done, 1200); });
    const before = seen.frames;
    check(before > 0, 'the replay is streaming before anything presses record', `${before} frames in 1.2s`);

    const state = await getJson(`${url}/record/state`);
    check(typeof state.cannotRecord === 'string' && /replay/i.test(state.cannotRecord),
      'the state says this server cannot record and why, which is what the button disables itself on',
      String(state.cannotRecord).slice(0, 80));

    const refused = await post(`${url}/record/start`);
    check(/replay/i.test(refused.error ?? ''),
      'pressing record on a replay is refused with the reason rather than opening a take',
      (refused.error ?? 'ACCEPTED').slice(0, 80));
    const during = await getJson(`${url}/record/state`);
    check(during.recording === false && during.armed === false,
      'and the recorder is left alone rather than half-armed',
      JSON.stringify({ armed: during.armed, recording: during.recording }));

    await new Promise((done) => { setTimeout(done, 1500); });
    const after = seen.frames - before;
    ws.close();
    check(after > 0, 'the live stream is untouched afterwards - the frames kept arriving',
      `${after} frames in the 1.5s after the refusal`);
    check(!seen.statuses.includes('lost'),
      'with no lost-sensor report, which is how the broken build presented itself',
      seen.statuses.length ? `saw ${seen.statuses.join(' ')}` : 'no status changes');
    check(readdirSync(replayCaps).filter((f) => f.endsWith('.knct')).length === 0,
      'and no take was written - a 163-byte file holding a hello and nothing else is not a take',
      readdirSync(replayCaps).join(' ') || 'empty');

    // The button itself, in the page. `web/index.html` carries an unconditional
    // record button, which is what made this one click away rather than one curl
    // away - so a state field saying the server cannot record is only half the fix
    // and the other half is visible or it is not there.
    {
      const { page, errors } = await openPage(browser, recorderPage(url), { width: 900, height: 700 });
      await page.waitForFunction('globalThis.__kinect !== undefined', null, { timeout: 40000 });
      await page.waitForFunction("document.getElementById('recGo')?.disabled === true", null, { timeout: 20000 })
        .catch(() => { /* asserted below, so a timeout is a failing row rather than a throw */ });
      const button = await page.evaluate(`(() => {
        const go = document.getElementById('recGo');
        return { disabled: go.disabled, title: go.title, note: document.getElementById('recNote').textContent };
      })()`);
      check(button.disabled === true, 'the record button on a replay server is disabled in the page rather than only refused by the server',
        JSON.stringify(button).slice(0, 90));
      check(/replay/i.test(button.note) || /replay/i.test(button.title),
        'and it says why, so the operator is not looking at a dead control with no explanation',
        (button.note || button.title).slice(0, 80));
      check(errors.length === 0, 'and the viewer raises no page errors on a server that cannot record',
        errors.slice(0, 2).join(' | '));
      await page.close();
    }
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 10)) p.child.kill('SIGKILL');
  }

  // --------------------------- 9. a descriptor outlives the map entry that held it
  //
  // **Counted off `/dev/fd` rather than off the module's own bookkeeping, and that
  // is the whole method of this section.** `openCaptures.size` is what
  // `/library/descriptors` used to report alone, and the bug here made that number
  // *fall* - `forgetCapture` dropped the map entry while the `FileHandle` stayed
  // open, so an arm watching the bookkeeping would have seen a descriptor being
  // released at the exact moment one leaked. The general form is worth stating:
  // **an assertion about a resource has to read the resource, not the accounting
  // that claims to track it.**
  //
  // The reachable gesture is one the gallery performs constantly. Skimming leases a
  // capture per pointer move, Delete is a button on the same tile, and on Node 26 a
  // `FileHandle` collected unclosed throws `ERR_INVALID_STATE` out of the garbage
  // collector at the top level - measured on v26.0.0, process gone, listener and
  // every socket with it.
  console.log('\n[library] a take removed while a reader holds it still gives its descriptor back');
  {
    const leaseDir = join(WORK, 'leased');
    mkdirSync(leaseDir, { recursive: true });
    // Big enough that the run cannot fit in socket buffers. At forty frames it did:
    // the whole nineteen megabytes drained before the delete, the lease was already
    // released, and the mutation that leaks a descriptor came back green because
    // there was never a descriptor being held. Sized by frame count, since the
    // sample was captured on a degraded link and its seconds are not a take's.
    writeTake(leaseDir, 'leased-take', { frames: 200 });
    const url = await startServer(root, ['--captures', leaseDir, '--name', 'leasing'], MAC_PORT + 11);
    const take = (await getJson(`${url}/library/takes`)).takes.find((t) => t.id === 'leased-take');
    const baseline = await getJson(`${url}/library/descriptors`);
    check(Number.isInteger(baseline.real),
      'the server reports the descriptors the kernel says it holds, not only the ones its own map remembers',
      `open ${baseline.open}, real ${baseline.real}`);

    // A reader that is genuinely mid-read: a raw socket asking for a long frame run
    // and then reading nothing, so TCP backpressure stalls the pipeline and the
    // lease is held for as long as this test wants it held.
    const sock = createConnection(MAC_PORT + 11, 'localhost');
    await new Promise((done, fail) => { sock.on('connect', done); sock.on('error', fail); });
    // Read exactly enough to know the response started, then stop reading, so TCP
    // backpressure stalls the pipeline and the lease stays held for as long as this
    // section wants it held. Left in flowing mode for even 700ms the whole 97MB
    // drained - Node's own socket buffering is larger than any of this - and the run
    // then finished, released its lease, and left nothing for the removal below to
    // happen underneath.
    let received = 0;
    sock.on('data', (c) => { received += c.length; sock.pause(); });
    sock.write(`GET /capture/leased-take/frames/0-${take.frames - 1} HTTP/1.1\r\nHost: localhost:${MAC_PORT + 11}\r\nConnection: close\r\n\r\n`);
    await new Promise((done) => { setTimeout(done, 1200); });
    const held = await getJson(`${url}/library/descriptors`);
    // **The precondition, asserted rather than assumed.** A run that finished has no
    // lease left to hold anything, and every row below would then be measuring a
    // capture nobody was reading. Partway through is the state this needs, and the
    // byte count is what says it is partway through.
    check(received > 0 && received < take.bytes * 0.9,
      'the reader is genuinely mid-run rather than finished, which is what the rows below rest on',
      `${(received / 1e6).toFixed(1)}MB of ${(take.bytes / 1e6).toFixed(1)}MB read, then stopped reading`);
    check(held.real > baseline.real && held.open === 1,
      'and it is holding the capture open, which is what the removal below has to happen underneath',
      `open ${held.open}, real ${held.real} against ${baseline.real}`);

    const removed = await post(`${url}/library/delete/leased-take`, { hash: take.hash, confirm: true });
    const afterDelete = await getJson(`${url}/library/descriptors`);
    check(removed.removed === 'leased-take.knct', 'the take is removed while the reader is still on it',
      JSON.stringify(removed).slice(0, 60));
    // **A precondition, and it was labelled a control, which it cannot be.** The
    // reading here - map empty, descriptor still open - is what the fixed build and
    // the leaking one both produce, because at this instant the reader still holds
    // its lease and the descriptor is legitimately open in either. So nothing about
    // this row can fail on the mutation beside it, and calling it the control
    // overstated an arm that rests on the two rows after `sock.destroy()`, where the
    // builds genuinely diverge.
    //
    // What it does say is why the arm reads `/dev/fd` at all: a check reading `open`
    // alone sees it fall to zero here and would record a descriptor being released
    // while the real count sat at 2. Stated as the precondition it is.
    check(afterDelete.open === 0 && afterDelete.real === held.real && held.real > baseline.real,
      'the module\'s own count drops to zero while the descriptor is genuinely still there - a precondition for the rows below rather than a catch, and the reason this arm reads /dev/fd',
      `open ${afterDelete.open}, real ${afterDelete.real} against a baseline of ${baseline.real}`);

    sock.destroy();
    // **Polled inside a catch, because the failure mode is the server going away.**
    // A leaked `FileHandle` does not sit there being counted: the collector finds it
    // and throws `ERR_INVALID_STATE` at the top level, and the process is gone -
    // measured here at between 300ms and one second after the reader let go. An
    // unguarded poll then throws out of `runChecks` and the run ends with an exit
    // code and *zero failed assertions*, which is the shape `docs/instruments.md`
    // records as a crash wearing a catch's status. This turns it back into rows.
    //
    // **One reading at a fixed delay, and deliberately not a poll-until-it-passes.**
    // A loop that retried until the count came back turned this into a race with the
    // garbage collector: it closes the leaked handle on its way to throwing, so
    // there is a window in which the count *has* returned to baseline and the
    // process has not died yet - and a patient loop finds that window and calls it a
    // pass. Measured flaky exactly that way, green on one run and two failed rows on
    // the next against an identical mutated tree.
    //
    // 250ms is three orders of magnitude more than the fixed build needs - the close
    // is one `fs.close` in a `finally` that runs when the socket errors - and it is
    // comfortably inside the 300ms-to-1s window the collector was measured to take.
    let settled = null;
    let died = null;
    await new Promise((done) => { setTimeout(done, 250); });
    try {
      settled = await getJson(`${url}/library/descriptors`);
    } catch (err) {
      died = err.message;
    }
    check(died === null,
      'the server is still answering afterwards - an unclosed FileHandle is a process death on this Node, taking the listener and every socket with it',
      died ?? 'still up');
    check(died === null && settled.real <= baseline.real,
      'and when the reader lets go the descriptor is closed rather than left for the collector to throw over',
      died ? 'the server did not survive to be asked' : `real ${settled.real} against a baseline of ${baseline.real}`);
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 11)) p.child.kill('SIGKILL');
  }

  // ------------------------------------------- 10. the recorder's own two failures
  //
  // **Driven in process rather than through a server, because both claims are about
  // what happens inside one synchronous turn** and nothing reachable over HTTP can
  // stand in the middle of one. The backpressure arm in particular needs frames
  // handed over faster than any disk can take them, and a synchronous loop is the
  // only thing that guarantees it: no I/O can complete while it runs, so every byte
  // written is still in memory when it ends. That is a fixture rather than a race.
  console.log('\n[library] the recorder holds its marks and bounds its buffer');
  {
    // A take whose sidecar was never written has no marks, which is a *failing*
    // answer rather than a missing file. Read through this, or the two mutations
    // that drop the flush take the whole run down with an ENOENT before any row is
    // recorded - and an exit code with zero failed assertions reads as a caught
    // mutation to anything counting statuses.
    const marksOf = (id) => {
      try {
        return readFileSync(join(WORK, 'recorder-unit', `${id}.marks.jsonl`), 'utf8').trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    };
    // **Imported out of the staged tree rather than out of the repo**, which is what
    // makes a server-file mutation reach this section at all. Pointed at `REPO` it
    // loaded the unmutated recorder while the mutation sat in the copy nothing here
    // was running, and five mutations came back green against code they never
    // touched - a check measuring a build that was not under test.
    const { Recorder, MAX_TAKE_BUFFER } = await import(pathToFileURL(join(root, 'server/recorder.js')).href);
    const recDir = join(WORK, 'recorder-unit');
    mkdirSync(recDir, { recursive: true });
    const hello = SRC.hello.toString('utf8');

    // ---- marks belong to the take, not to the recorder
    //
    // A take that dies mid-write used to null itself without flushing, and the marks
    // pressed during it were still on the recorder when the *next* take closed - so
    // take one lost the moment somebody flagged and take two gained one at a source
    // time that means nothing there.
    const one = new Recorder({ dir: recDir });
    await one.start(null);
    one.open(hello);
    const firstTake = one.state.takeId;
    one.write(SRC.frames[0]);
    one.mark(1234, 'the moment');
    // A card pulled mid-write, which is the reachable version of this: the stream
    // errors, the take ends, and there is no next name that would help.
    one.take.stream.destroy(new Error('the card was pulled'));
    await new Promise((done) => { setTimeout(done, 400); });
    check(one.state.recording === false && one.state.armed === false,
      'a take that fails mid-write ends and says so rather than looking like it is still recording',
      JSON.stringify({ armed: one.state.armed, recording: one.state.recording }));
    const firstMarks = marksOf(firstTake);
    check(firstMarks.length === 1 && JSON.parse(firstMarks[0]).sourceMs === 1234,
      'and the mark pressed during it is in that take\'s sidecar, written on the way down',
      firstMarks.join(' ').slice(0, 70));

    // The other half: the next take must not inherit it.
    const two = new Recorder({ dir: recDir });
    await two.start(null);
    two.open(hello);
    const secondTake = two.state.takeId;
    two.write(SRC.frames[1]);
    await two.stop();
    check(secondTake !== firstTake, 'the next take is a different file', `${firstTake} then ${secondTake}`);
    check(!existsSync(join(recDir, `${secondTake}.marks.jsonl`)),
      'and it carries no marks at all - the orphaned one did not travel forward into footage it does not describe');

    // ---- a close that rejects still flushes
    //
    // The same orphaning arrived a second way: `once(stream, "close")` rejects when
    // the stream errors during the flush, and the old shape had already nulled the
    // take by then, so the marks sat in a list nothing would read again.
    const three = new Recorder({ dir: recDir });
    await three.start(null);
    three.open(hello);
    const thirdTake = three.state.takeId;
    three.write(SRC.frames[2]);
    three.mark(777, 'flagged as it died');
    const stream = three.take.stream;
    const closing = three.close('testing a close that fails').catch((err) => err);
    stream.destroy(new Error('the card went away during the close'));
    const outcome = await closing;
    check(outcome instanceof Error, 'a close that fails partway through reports the failure rather than swallowing it',
      String(outcome?.message ?? outcome).slice(0, 60));
    const thirdMarks = marksOf(thirdTake);
    check(thirdMarks.length === 1 && JSON.parse(thirdMarks[0]).sourceMs === 777,
      'and the marks are still written, because the flush hangs off the take rather than off the close succeeding',
      thirdMarks.join(' ').slice(0, 70));

    // ---- backpressure, and numbers that mean durable
    //
    // **The requirement this arm holds the ceiling to is written down here rather
    // than imported.** `MAX_TAKE_BUFFER` is the number under test, so the row
    // bounding the observed peak against it passes at whatever ceiling the build
    // cares to name - demonstrated at 8MB and again at 1MB, the whole suite green,
    // the row printing "peak 1.5MB against a 1MB ceiling" while 297 of 300 frames
    // went on the floor. A build that rides out 0.6 seconds of a stalled card was
    // therefore indistinguishable from one that rides out 4.4.
    //
    // Two rows fix that, on two literals that are not the build's to move: the
    // ceiling the design settled on, and the full rate the ride-out requirement is
    // about. Both are written here as requirements the recorder must meet rather
    // than as facts read off it.
    //
    // The bytes are **observed** - accumulated from the frames actually handed over
    // and divided back out into a mean, rather than imported from `recorder.js` or
    // multiplied out of one frame's nominal size. That matters on this fixture: its
    // mean frame is about 475KB where the spec measured 486KB, so the shipped build
    // accepts 139 frames where the spec's arithmetic says 135, and a hardcoded frame
    // size would have made a correct build miss by 3%.
    //
    // **The 30 in the second row is the sensor's full rate, not the fixture's.** It
    // is legitimate here for the same reason `CLAUDE.md` forbids it elsewhere: the
    // requirement is "four seconds of a full-rate take", so 30 is what the claim is
    // *about*. Nothing here is sized by duration - the sample runs at about 9.3fps
    // and every fixture in this file is sized by frame count.
    const CEILING_REQUIRED = 64 * 1024 * 1024;
    const CEILING_TOLERANCE = 0.10;
    const FULL_RATE_FPS = 30;
    const RIDE_OUT_SEC = 4;

    // The recorder's own pushes, so the transition into dropping can be asked about
    // rather than assumed. Nothing here reads `state` - the getter drains the queue,
    // which is the very thing two arms below are measuring.
    const pushed = [];
    const four = new Recorder({ dir: recDir, onChange: (s) => pushed.push(s) });
    await four.start(null);
    four.open(hello);
    const burstTake = four.take.id;
    const burstPath = join(recDir, `${burstTake}.knct`);
    const BURST = 300;
    let peak = 0;
    let acceptedBytes = 0;
    let acceptedFrames = 0;
    const pushedBeforeBurst = pushed.length;
    // Synchronous from end to end. Nothing drains while this runs, so the buffer
    // grows monotonically and the ceiling is reached deterministically rather than
    // whenever the disk happens to be slow.
    for (let i = 0; i < BURST; i++) {
      const frame = SRC.frames[i % SRC.frames.length];
      four.write(frame);
      // Read off the take rather than through `state`, for the same reason. Drops
      // are contiguous once they start, because nothing can drain mid-turn, so this
      // is exactly the footage accepted before the first one.
      if (four.take.dropped === 0) {
        acceptedBytes += frame.length;
        acceptedFrames++;
      }
      peak = Math.max(peak, four.take.stream.writableLength);
    }
    const midBurst = four.state;
    const onDiskMid = statSync(burstPath).size;
    const meanFrameBytes = acceptedBytes / acceptedFrames;
    check(Math.abs(acceptedBytes - CEILING_REQUIRED) <= CEILING_TOLERANCE * CEILING_REQUIRED,
      `the buffer holds the 64MiB the design settled on, within ${(CEILING_TOLERANCE * 100).toFixed(0)}%`,
      `${acceptedFrames} frames x ${(meanFrameBytes / 1024).toFixed(0)}KB observed mean = `
      + `${(acceptedBytes / 1e6).toFixed(1)}MB accepted before the first drop, `
      + `${((acceptedBytes / CEILING_REQUIRED - 1) * 100).toFixed(1)}% off ${(CEILING_REQUIRED / 1e6).toFixed(1)}MB`);
    check(acceptedFrames / FULL_RATE_FPS >= RIDE_OUT_SEC,
      `which is at least the ${RIDE_OUT_SEC}s of a stalled card the recorder is required to ride out`,
      `${(acceptedFrames / FULL_RATE_FPS).toFixed(2)}s at the sensor's ${FULL_RATE_FPS}fps, `
      + `${RIDE_OUT_SEC}s required`);
    check(peak <= MAX_TAKE_BUFFER + SRC.frames[0].length,
      `${BURST} frames handed over in one turn never buffer past the stated ceiling`,
      `peak ${(peak / 1e6).toFixed(1)}MB against a ${(MAX_TAKE_BUFFER / 1e6).toFixed(0)}MB ceiling`);
    // The transition, pushed. Left to the five-second poll, a node with nobody
    // watching it drops footage for five seconds before anything says so - and after
    // the queue drains on every write, no monitor has to be open for the drop to
    // happen at all, so the poll is the only thing that would have carried it.
    const drops = pushed.slice(pushedBeforeBurst).filter((s) => s.dropped > 0);
    check(drops.length > 0,
      'the moment the recorder starts dropping is pushed rather than left to the panel\'s five-second poll',
      `${pushed.length - pushedBeforeBurst} pushes during the burst, ${drops.length} carrying a drop`);
    check(drops.length === 1,
      'and pushed once for the transition rather than once per dropped frame, which would put a socket write in the frame path',
      `${drops.length} pushes for ${midBurst.dropped} dropped frames`);
    check(midBurst.dropped > 0,
      'and the frames past it are dropped and counted rather than queued into heap that grows until the process is killed',
      `${midBurst.dropped} of ${BURST} dropped`);
    // The monitor's numbers. Mid-turn nothing has reached the file, so a recorder
    // reporting what it *accepted* reads healthy at exactly the moment it is holding
    // sixty-four megabytes it may be about to lose.
    check(midBurst.bytes === onDiskMid,
      'the bytes the monitor reports are the bytes that reached the file, not the ones this process is holding',
      `reports ${midBurst.bytes}, on disk ${onDiskMid}, buffered ${(midBurst.buffered / 1e6).toFixed(1)}MB`);
    check(midBurst.frames === 0 && midBurst.buffered > 0,
      'so a stalled card reads as stalled rather than as a healthy take',
      `${midBurst.frames} frames durable with ${(midBurst.buffered / 1e6).toFixed(1)}MB waiting`);

    const closed = await four.close('burst over');
    const finalSize = statSync(burstPath).size;
    check(closed.bytes === finalSize,
      'and once the take closes the count is the file, exactly',
      `${closed.bytes} against ${finalSize}`);
    check(closed.frames === BURST - midBurst.dropped,
      'with the frames that landed being the ones that were accepted - a dropped frame is a gap, not a miscount',
      `${closed.frames} scanned, ${BURST} offered, ${midBurst.dropped} dropped`);

    // ---- the in-flight queue is bounded by the ceiling, not by the take
    //
    // `write` pushes a frame end-offset per frame and `settle` is what removes them.
    // Drained only when something asked for state, the queue held every frame of the
    // take until an operator opened the monitor, and the drain that then ran was
    // `shift()` in a loop - 48.9ms at 27,000 frames, 3,677ms at 216,000, about 4.1x
    // per doubling. Synchronous, so stdin is not serviced while it runs, and the
    // grabber answers that backpressure by dropping depth packets at the device.
    //
    // **Depth is asserted, never a stopwatch.** Absolute timings on this rig move by
    // 2x with load - the same drain measured 3,677ms here and 7,632ms on the
    // reviewer's machine - so a threshold in milliseconds would be a flake. The
    // queue's depth is a count: bounded by what is not yet durable if the drain runs
    // per frame, and equal to the whole take if it does not.
    //
    // **And the array behind the head is asserted separately**, because a head index
    // that never compacts leaves the depth right and the allocation growing with the
    // take - which is also the only way per-frame work can go back to scaling with
    // the take's length. An array bounded by a constant bounds every operation over
    // it, for any implementation rather than for the ones a timing probe happened to
    // sample, so the bound is the cost claim rather than a proxy for it.
    //
    // Small frames on purpose, and the trade is worth naming: the queue records one
    // end-offset per message and never reads a payload byte, so this claim is about
    // message count, and 20,040 of the sample's own 486KB frames would be 9.7 GB of
    // disk to say the same thing. Real frames stay where the claim is about bytes -
    // the ceiling arm above.
    const PER_CHUNK = 500;
    const CHUNKS = 40;
    const smallFrame = (n) => {
      const payload = Buffer.alloc(1024);
      payload.writeUInt32LE(1008, 0);
      payload.writeUInt32LE(0, 4);
      payload.writeBigUInt64LE(BigInt(n * 33), 8);
      return encodeMessage(TYPE_FRAME, payload);
    };
    // Everything the stream is holding has reached the descriptor, so the next
    // `settle` has every queued frame to drain and the depth read afterwards is the
    // queue's own bookkeeping rather than a slow disk's backlog.
    const flushed = async (stream) => {
      for (let i = 0; i < 4000 && stream.writableLength > 0; i++) {
        await new Promise((done) => { setTimeout(done, 0); });
      }
      return stream.writableLength;
    };

    const five = new Recorder({ dir: recDir });
    await five.start(null);
    five.open(hello);
    const longTake = five.take.id;
    let deepest = 0;
    let longest = 0;
    let stillWaiting = 0;
    let written = 0;
    for (let c = 0; c < CHUNKS; c++) {
      for (let i = 0; i < PER_CHUNK; i++) five.write(smallFrame(written++));
      stillWaiting = Math.max(stillWaiting, await flushed(five.take.stream));
      // One more frame after the flush, because `settle` runs on the frame path: the
      // entries a chunk left behind are drained by the next `write` and not by the
      // disk finishing. Reading the depth before it would be reading a queue nothing
      // had been given the chance to drain, which would pass against a build that
      // never drains at all.
      five.write(smallFrame(written++));
      deepest = Math.max(deepest, five.take.inFlight.length - five.take.inFlightHead);
      longest = Math.max(longest, five.take.inFlight.length);
    }
    // Held past the close, which nulls the recorder's reference. The last frame's
    // entry is drained by the settle in `close`'s `finally` and not by the loop
    // above - the drain runs on the frame path, so nothing follows the final write
    // to run it - and a count read before that is one short of the file.
    const longTakeState = five.take;
    const droppedLong = five.take.dropped;
    const longClosed = await five.close('the long take is over');
    const counted = longTakeState.frames;
    check(droppedLong === 0 && stillWaiting === 0,
      `the disk kept up across all ${written} frames, which is what makes the next two rows about the queue rather than about the card`,
      `${droppedLong} dropped, ${stillWaiting} bytes still waiting at the deepest flush`);
    check(deepest <= 4,
      'the queue holds only the frames not yet durable, so it is bounded by the buffer ceiling rather than by the length of the take',
      `deepest ${deepest} live entries after ${written} frames`);
    check(longest <= 8,
      'and the array behind it is compacted rather than merely indexed past, so nothing grows with the take',
      `longest ${longest} slots for ${written} frames`);
    check(counted === written && longClosed.frames === written,
      'with every frame counted exactly once on its way through - a drain that skipped or double-counted would move this and leave the depth alone',
      `${counted} counted, ${longClosed.frames} scanned, ${written} written`);
    rmSync(join(recDir, `${longTake}.knct`), { force: true });
    rmSync(join(recDir, `${longTake}.idx`), { force: true });
  }

  // ---------------------------- 11. the manifest does not scan the take being written
  //
  // The staleness test `cachedIndex` uses is size and modification time, and both of
  // those move continuously on a take that is still being written - so every
  // `/library/*` request re-ran a full read plus sha256 over the in-progress take,
  // sequentially, with no concurrency guard. The gallery on the node's own panel is
  // the caller, and on a 4.4 GB take that is minutes of disk contention against the
  // recorder's own writes.
  //
  // **Measured by the sidecar rather than by a stopwatch.** `buildIndex` writes a
  // `.idx` beside the take, so "the manifest scanned it" leaves a file - which is
  // deterministic where a timing threshold would be a flake, and is the same
  // observer effect `docs/instruments.md` records from this step's own first draft.
  console.log('\n[library] listing a library does not scan the take still being written');
  {
    const liveDir = join(WORK, 'while-recording');
    mkdirSync(liveDir, { recursive: true });
    const url = await startServer(root, [
      '--captures', liveDir, '--name', 'shooting', '--record', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
    ], MAC_PORT + 12);
    let open = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      open = await getJson(`${url}/record/state`);
      if (open.recording) break;
    }
    check(open?.recording === true, 'a take is open', String(open?.takeId));

    // Polled the way the node's own gallery polls it.
    let listed = null;
    for (let i = 0; i < 8; i++) {
      listed = (await getJson(`${url}/library/takes`)).takes.find((t) => t.id === open.takeId);
      await new Promise((done) => { setTimeout(done, 120); });
    }
    check(!existsSync(join(liveDir, `${open.takeId}.idx`)),
      'eight listings while the take is open write it no sidecar - nothing scanned it',
      readdirSync(liveDir).join(' '));
    check(listed?.recording === true && listed.hash === null && listed.frames === null,
      'the take is listed and says it is being recorded, with no hash and no frame count - numbers over a growing file are not facts',
      JSON.stringify({ recording: listed?.recording, hash: listed?.hash, frames: listed?.frames }));
    check(listed?.openable === false,
      'and it says it cannot be opened, so the tile has something to draw rather than zeros');
    // **And it says *why*, which is the half a boolean cannot carry.** This branch of
    // `describeTake` used to hold the refusal list and a hardcoded `openable: false` beside
    // it - two answers to one question, written in by the commit whose whole subject is
    // that there should be one. They agreed, so nothing was wrong yet, and what waits at
    // the end of that is the quiet failure: `cannotOpen` quotes the list, so a list that
    // went while the boolean stayed leaves a disabled Open button explaining nothing.
    //
    // The row is here rather than beside its two-table siblings because this is the only
    // server in the suite with a take being written - those rows read a listing that
    // cannot contain one, and skip `recording` by name for exactly that reason. A probe
    // for this claim has to stand where the answer could be different.
    check(listed?.openRefusals?.length === 1 && listed.openRefusals[0].key === 'recording'
      && typeof listed.openRefusals[0].why === 'string' && listed.openRefusals[0].why !== ''
      && listed.openable === (listed.openRefusals.length === 0),
      'and the reason is on the take rather than only in the boolean, with openable following the list here too',
      JSON.stringify(listed?.openRefusals));
    // **The missing hash is load-bearing on the menu, so it is asserted as that too.**
    // `resolveResume` finds the take it was last opened on by hash and by nothing else,
    // and `lastOpened` refuses a saved entry whose `takeHash` is not a non-empty string
    // - so a take advertising no hash is one that lookup cannot reach, which is why the
    // menu has no branch for a take being recorded and does not need one. That used to
    // be a branch spelling its own sentence for the case, a third telling of a reason
    // the server declares. Read off `/library/all`, which is the response the menu
    // actually fetches, rather than off `/library/takes` above.
    const resolvable = (await getJson(`${url}/library/all`)).takes;
    const shooting = resolvable.filter((t) => t.recording === true);
    check(shooting.length > 0 && shooting.every((t) => t.hash === null),
      'and the response the menu resolves against gives it no hash, so nothing the menu can look up is a take being recorded',
      `${shooting.length} recording, hashes ${JSON.stringify(shooting.map((t) => t.hash))}`);

    // Neither removal can verify anything about a file that is still arriving, and
    // unlinking one underneath a running write stream loses the shoot in progress.
    const refusedDelete = await post(`${url}/library/delete/${open.takeId}`, { hash: 'sha256:whatever', confirm: true });
    check(/being recorded/.test(refusedDelete.error ?? ''),
      'delete refuses the take the recorder has open', (refusedDelete.error ?? 'ACCEPTED').slice(0, 70));
    check(existsSync(join(liveDir, `${open.takeId}.knct`)), 'and the file is still there');

    // The tile, drawn. A take with a null hash and a null frame count is a shape the
    // gallery had never been handed, and the fields it renders - the duration, the
    // frame count, the hash prefix, the scrub bar's own divisor - all read one of
    // them. So this is the page rather than the JSON: NaN in a tile is not something
    // a manifest assertion can see.
    {
      const { page, errors } = await openPage(browser, galleryPage(url));
      await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
      const tile = await page.evaluate(`(() => {
        const el = document.querySelector('.tile[data-recording="true"]');
        if (!el) return null;
        return {
          id: el.dataset.id,
          text: el.querySelector('.meta').textContent,
          acts: [...el.querySelectorAll('.acts .act')].map((b) => ({
            label: b.textContent, disabled: b.disabled, opensMenu: b.getAttribute('aria-haspopup') === 'menu',
          })),
          menu: [...el.querySelectorAll('.menu .mi')].map((b) => ({ item: b.dataset.item, disabled: b.disabled })),
          note: el.querySelector('.mnote').textContent,
          flags: [...el.querySelectorAll('.skim .flag')].map((f) => f.dataset.flag),
        };
      })()`);
      check(tile?.id === open.takeId, 'the take being recorded has a tile of its own', String(tile?.id));
      check(!/NaN|null|undefined/.test(tile?.text ?? 'NaN'),
        'and it renders no NaN, no null and no undefined where a scan\'s numbers would have gone',
        (tile?.text ?? '').replace(/\s+/g, ' ').slice(0, 110));
      check(/recording now/.test(tile?.text ?? ''), 'it says it is recording rather than showing zeros');
      // **Every control that would change something is disabled, and the one that
      // only explains is not.** That split is the row rather than a weakening of it:
      // the sentence saying why nothing can be done to a take mid-shoot lives in the
      // ⋯ menu, and a panel with no hover has nowhere else to read it - so disabling
      // the ⋯ as well would take the explanation off the surface that needs it most.
      // The two rows below are what makes that a claim rather than an exemption: the
      // menu opens, and everything inside it is off.
      const acting = (tile?.acts ?? []).filter((a) => !a.opensMenu);
      check(acting.length > 0 && acting.every((a) => a.disabled),
        'and every action on it is present and disabled - the library runs on a touch panel, where a control that vanishes reads as a broken page',
        JSON.stringify(tile?.acts));
      check((tile?.menu ?? []).length > 0 && tile.menu.every((m) => m.disabled),
        'the ⋯ still opens, and every item in it is disabled too, so nothing about the take can be acted on',
        JSON.stringify(tile?.menu));
      check(/still being written/.test(tile?.note ?? '') && (tile?.flags ?? []).includes('recording'),
        'with the reason on the poster as a badge and spelled out in the menu, which is a tap rather than a hover',
        (tile?.note ?? '').slice(0, 80));
      check(errors.length === 0, 'the gallery raises no page errors while a take is being written',
        errors.slice(0, 2).join(' | '));
      await page.close();
    }

    const stopped = (await post(`${url}/record/stop`)).stopped;
    const afterStop = (await getJson(`${url}/library/takes`)).takes.find((t) => t.id === open.takeId);
    check(existsSync(join(liveDir, `${open.takeId}.idx`)) && stopped?.hash?.startsWith('sha256:'),
      'and once it closes it is scanned exactly once, which is what makes it a gallery entry',
      `${stopped?.frames} frames, ${String(stopped?.hash).slice(7, 19)}`);
    check(afterStop?.recording === false && afterStop.hash === stopped?.hash && afterStop.frames === stopped?.frames,
      'the listing then carries the hash and the frame count the scan produced');
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 12)) p.child.kill('SIGKILL');
  }

  // ------------------------------ 12. a node whose captures directory does not exist
  //
  // The state a reflashed capture node boots in, which is what step 9 provisions
  // from. Without this the node came up disarmed and answered `/record/state` and
  // `/library/all` with a raw `ENOENT ... statfs`, so the panel in the room showed an
  // errno and nothing on it said the shoot could not start.
  console.log('\n[library] a node with no captures directory makes one and says so');
  {
    const fresh = join(WORK, 'never-existed', 'captures');
    rmSync(join(WORK, 'never-existed'), { recursive: true, force: true });
    check(!existsSync(fresh), 'the directory genuinely is not there, which is what makes this a fixture');
    const url = await startServer(root, [
      '--captures', fresh, '--name', 'reflashed', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
    ], MAC_PORT + 13);
    check(existsSync(fresh), 'the server creates it at boot rather than failing every request that needs it', fresh);

    const state = await getJson(`${url}/record/state`);
    check(state.storage?.error == null && /^(\d+h \d+m|\d+m \d+s|\d+s|unbounded)$/.test(state.storage?.label ?? ''),
      'and the remaining-time report is a duration rather than an errno',
      JSON.stringify(state.storage?.error ?? state.storage?.label));
    const lib = await getJson(`${url}/library/all`);
    check(Array.isArray(lib.takes) && lib.takes.length === 0 && lib.unreadable.length === 0,
      'the library answers with an empty shelf rather than an error, which is the honest report for a node nobody has shot on yet');

    let armed = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      armed = await post(`${url}/record/start`);
      if (armed.recording || armed.armed) break;
    }
    check(armed?.armed === true, 'and it can be armed, which is the whole point of provisioning it',
      JSON.stringify({ armed: armed?.armed, error: armed?.error }));
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 13)) p.child.kill('SIGKILL');
  }

  // --------------------------- 13. the sensor answers for its own health over HTTP
  //
  // **The point of the route is what reading it does not cost.** These numbers already
  // existed - the health interval computes them every five seconds and prints one line
  // to a console nobody is reading during a shoot - and the only way to find out
  // whether the sensor was delivering was to attach a monitor over the socket.
  // `consumersCostingTheTake` exists because an attached monitor can cost the take
  // frames, so the one instrument for "is this sensor well" made it less well.
  //
  // Two servers, because the two claims need opposite fixtures. `macUrl` has no sensor
  // and has never had one, so every window it closes is empty - which is the case the
  // window used to carry across a gap. The live server below has a fake grabber
  // delivering steadily, which is the case that must go on reporting a rate.
  console.log('\n[library] the sensor answers for its own health, and a window with no frames in it still closes');
  const liveDir = join(WORK, 'health-live');
  rmSync(liveDir, { recursive: true, force: true });
  mkdirSync(liveDir, { recursive: true });
  // Spawned here and killed at the end of section 14, because both sections need a
  // server that is genuinely delivering frames and recording, and the port span has
  // one slot left in it. Named at the two places that matter rather than left to be
  // noticed.
  const liveUrl = await startServer(root, [
    '--captures', liveDir, '--name', 'shooting-live', '--record', '--no-color',
    '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
  ], MAC_PORT + 1);
  {
    const table = (await getJson(`${macUrl}/library/routes`)).routes;
    const entry = table.find((r) => r.path === '/sensor/health');
    // **Published and answering, asked as one row.** A route that answers from a branch
    // beside the dispatcher is real to a browser and invisible to the sweep that drives
    // every entry by existing, and a route in the table with no handler is the mirror -
    // so both halves are here, and the mutation takes the first one.
    const health = await getJson(`${macUrl}/sensor/health`);
    check(Boolean(entry) && entry.read === true && entry.mutates === false && entry.live === false
      && typeof health.state === 'string',
      'the sensor health route is a ROUTES entry the table publishes, read-only and not a live sensor feed, and it answers',
      entry ? `published: read=${entry.read} mutates=${entry.mutates} live=${entry.live}, state ${health.state}`
        : `not in the table of ${table.length}`);
    check(typeof health.monitorDropped === 'number' && typeof health.respawns === 'number'
      && typeof health.fps === 'number' && typeof health.bytesPerSec === 'number',
      'and it carries the four numbers an operator would otherwise have attached a monitor to read',
      `monitorDropped=${health.monitorDropped} respawns=${health.respawns} fps=${health.fps} B/s=${health.bytesPerSec.toFixed(0)}`);
    // **And it does not offer a number that would be read as sensor loss.** The count
    // behind it moves inside `broadcastFrame`, once per socket that is over its buffer
    // ceiling - so under the old name a node whose sensor was struggling with nobody
    // watching read zero drops, and one frame two lagging monitors both missed read as
    // two. The row is written against the bare name rather than against the new one,
    // because what had to go is the word an operator would trust.
    check(health.dropped === undefined,
      'and nothing on it is called `dropped` unqualified, since the only count here is monitors failing to keep up with the output rather than the sensor failing to deliver',
      `dropped=${JSON.stringify(health.dropped)}, monitorDropped=${health.monitorDropped}`);
    // A machine with no sensor on it, said as a state rather than as silence. This is
    // also the reading that makes the window row below about an *empty* window.
    check(['lost', 'absent', 'starting'].includes(health.state) && health.respawns >= 1,
      'a server with no sensor says so and counts the grabbers it has been through, which is the flapping question the backoff\'s own counter cannot answer',
      `state ${health.state}, ${health.respawns} respawns`);

    // **The window that closed last, on a server where no window has ever carried a
    // frame.** The reset used to sit past the early return, so `stats.since` kept its
    // value for the life of the process and the first window after a gap was measured
    // over the gap. Read against this server's uptime, which by now is far longer than
    // one window - so the separation between "about five seconds" and "as long as the
    // server has been up" is what this row reads rather than a bare threshold.
    let closed = null;
    for (let i = 0; i < 24; i++) {
      closed = (await getJson(`${macUrl}/sensor/health`)).window;
      if (closed) break;
      await new Promise((done) => { setTimeout(done, 500); });
    }
    const uptimeMs = Date.now() - bootedAt;
    check(closed !== null && closed.frames === 0 && closed.ms > 3500 && closed.ms < 7500,
      'a five-second window that carried no frames still closes at about five seconds rather than growing for as long as the sensor is away',
      closed ? `${closed.ms}ms carrying ${closed.frames} frames, against ${(uptimeMs / 1000).toFixed(0)}s of server uptime`
        : 'no window had closed after 12s');
    // The other half of the same change, and the reason the rates are not in the row
    // above: a window with no frames has no rate in it, so the last honest measurement
    // is left standing rather than replaced by one computed over a window that never
    // happened. On this server there has never been one, so it is still zero.
    const rates = await getJson(`${macUrl}/sensor/health`);
    check(rates.fps === 0 && rates.bytesPerSec === 0,
      'and the rate is left alone by an empty window rather than recomputed over it - on this server there has never been one, so it is still nothing',
      `${rates.fps} fps, ${rates.bytesPerSec} B/s after ${(uptimeMs / 1000).toFixed(0)}s of empty windows`);

    // Steady delivery, which never takes the early return at all. The control for the
    // row above: a mutation that only breaks the empty-window path must leave this one
    // green, or what it caught was something else.
    //
    // **A second sample, taken a window after the first.** The grabber takes a few
    // seconds to come up, so the first window this server closes is usually an empty
    // one - and reading the very next window would be reading the boot transient,
    // which is a genuinely long window on a build with the fault and therefore a row
    // that goes red for the one reason it is supposed to control for.
    let delivering = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((done) => { setTimeout(done, 500); });
      delivering = await getJson(`${liveUrl}/sensor/health`);
      if (delivering.window?.frames > 0 && delivering.fps > 0) break;
    }
    await new Promise((done) => { setTimeout(done, 5500); });
    const settled = await getJson(`${liveUrl}/sensor/health`);
    check(settled?.window?.frames > 0 && settled.fps > 0 && settled.bytesPerSec > 0,
      'a server whose sensor is delivering reports a rate over a window that carried frames, which is the reading the empty-window fix must not have touched',
      `${settled?.fps?.toFixed(1)} fps over ${settled?.window?.ms}ms carrying ${settled?.window?.frames} frames`);
    check(Math.abs((settled?.window?.ms ?? 0) - 5000) <= 1500,
      'and its window is the same five seconds, so the two servers disagree about the frames rather than about the clock',
      `${settled?.window?.ms}ms`);

    // **A restart somebody asked for is not the sensor flapping.** Turning the colour
    // camera on stops a perfectly healthy grabber and spawns another, and counting that
    // with the failures makes the flapping number something an operator raises by
    // ticking a checkbox - which is worse than not reporting it, because the endpoint's
    // own claim is that a healthy node reads zero.
    //
    // A server of its own, and that is not tidiness: the delivering one above is
    // recording, `recorder.split()` runs on every grabber exit, and a restart here
    // would end the take section 14 is waiting on. Its own captures directory for the
    // same reason.
    const toggleDir = join(WORK, 'health-toggle');
    rmSync(toggleDir, { recursive: true, force: true });
    mkdirSync(toggleDir, { recursive: true });
    const toggleUrl = await startServer(root, [
      '--captures', toggleDir, '--name', 'toggling', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
    ], MAC_PORT + 13);
    // Waited for rather than slept against: `applyCamera` only restarts when there is a
    // grabber to restart, so a toggle sent before the first handshake lands on the
    // no-child branch, changes nothing, and leaves every row below asserting about an
    // event that did not happen. That is the vacuous pass this block is written against.
    let running = null;
    for (let i = 0; i < 60; i++) {
      running = await getJson(`${toggleUrl}/sensor/health`);
      if (running.state === 'live') break;
      await new Promise((done) => { setTimeout(done, 250); });
    }
    const totalSpawns = (h) => h.respawns + h.restarts + 1;
    const beforeToggle = await getJson(`${toggleUrl}/sensor/health`);
    check(running?.state === 'live' && beforeToggle.respawns === 0 && beforeToggle.restarts === 0,
      'a healthy grabber that has never failed reads zero respawns and zero restarts, which is what the toggle below has to move exactly one of',
      `state ${beforeToggle.state}, ${beforeToggle.respawns} respawns, ${beforeToggle.restarts} restarts`);

    const toggleWs = new WebSocket(toggleUrl.replace('http', 'ws'));
    await new Promise((done, fail) => { toggleWs.on('open', done); toggleWs.on('error', fail); });
    toggleWs.send(JSON.stringify({ camera: { color: true } }));
    let afterToggle = beforeToggle;
    for (let i = 0; i < 60; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      afterToggle = await getJson(`${toggleUrl}/sensor/health`);
      if (totalSpawns(afterToggle) > totalSpawns(beforeToggle)) break;
    }
    toggleWs.close();
    // The precondition, and it is the whole reason the row after it can fail. Without
    // it a build that simply never restarts on a colour toggle - or a toggle that
    // arrived before there was a child to stop - satisfies "respawns stayed at zero"
    // by nothing having happened, which is a green row about an event nobody caused.
    check(totalSpawns(afterToggle) === totalSpawns(beforeToggle) + 1,
      'the colour toggle really did stop the grabber and start another, so the rows below are about a restart that happened',
      `${totalSpawns(beforeToggle)} grabbers before, ${totalSpawns(afterToggle)} after`);
    check(afterToggle.respawns === 0,
      'and the health endpoint does not report it as the sensor having dropped, because a configuration change is not a fault',
      `${afterToggle.respawns} respawns after the toggle`);
    check(afterToggle.restarts === 1,
      'it is counted as the requested restart it is, beside the respawns rather than folded into them - or a node that restarted forty times for forty toggles would read as never having restarted at all',
      `${afterToggle.restarts} restarts`);

    // **And the number gets there without passing through a lie.** Both readings above
    // are taken at rest, and the subtraction they check is right at rest on a build that
    // counted the restart on the exit and on one that counts it beside the spawn. What
    // separates those two is the quarter-second to second and a half in between: a
    // restart counted when the old grabber died leaves `grabberRestarts` one ahead of
    // `grabberSpawns` for the whole backoff, so `respawns` reads one lower than it is,
    // and a node that had genuinely lost its sensor reports itself well to anyone who
    // looks in that window. A health number is read exactly when something feels wrong,
    // which is the worst possible moment for it to be briefly reassuring.
    //
    // A real fault first, because `Math.max(0, ...)` hides the whole defect below one.
    // From nought respawns the dip is negative and clamps to nought, which is what it
    // already reads - so the drop only becomes visible once there is a genuine failure
    // underneath it to hide, and that is also the only case anybody is harmed by.
    // Found by walking the tree rather than by asking for a direct child, because it is
    // not one: `pgrep -P` on the server returned nothing here and the row correctly said
    // it had measured nothing rather than passing on a kill that never happened. How
    // many processes sit between this suite and a grabber is a detail of how the server
    // is launched, and a row that depends on that number is a row that goes quiet the
    // next time it changes - so the whole subtree is walked and the grabber is picked
    // out by name.
    // A bug this row already paid for, and it is fixed one level down rather than here:
    // an earlier section starts and kills its own server on this same port, so looking
    // the offset up returned a process that had been dead since section 12. Its subtree
    // was empty, no grabber was ever found, and the row reported that it had measured
    // nothing - correctly, which is the only reason the mistake was visible at all.
    // `startServer` now moves a reclaimed offset's previous holder to `retired`, so
    // `servers` names one process per port and this is the live one by construction.
    const toggleProc = servers.find((sv) => sv.port === MAC_PORT + 13)?.child;
    const grabberUnder = (root) => {
      // `-ww` because macOS `ps` truncates the command at the terminal width by default,
      // and the grabber is named at the end of a long absolute path - so the match below
      // silently found nothing while the process was right there.
      const rows = execFileSync('ps', ['-ww', '-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim().split('\n');
      const parsed = rows.map((r) => r.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
      const family = new Set([root]);
      for (let grew = true; grew;) {
        grew = false;
        for (const m of parsed) {
          if (family.has(Number(m[2])) && !family.has(Number(m[1]))) { family.add(Number(m[1])); grew = true; }
        }
      }
      // **The server is excluded by name as well as by pid, because it also matches.**
      // `--grabber <path>/fake-grabber.mjs` is one of its own arguments, so a filter on
      // the word alone picks the server out of its own subtree - and this row then
      // SIGKILLs the process every remaining row in the block is talking to, which
      // arrives as `fetch failed` several rows later rather than as anything naming the
      // kill. The grabber is the descendant that runs the file rather than the one that
      // names it.
      return parsed
        .filter((m) => family.has(Number(m[1])) && Number(m[1]) !== root
          && /fake-grabber/.test(m[3]) && !/server\/index\.js/.test(m[3]))
        .map((m) => Number(m[1]));
    };
    // Retried, because `grabberSpawns` is incremented at the top of `spawnGrabber` and
    // the loop above breaks the instant that reading moves - which is microseconds
    // before there is a process to find. Waiting for `live` rather than sleeping a
    // fixed amount, so the row is about the kill rather than about a guess at how long
    // a handshake takes.
    let grabberPid = null;
    let lookupError = null;
    for (let i = 0; i < 40 && grabberPid === null; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      try {
        grabberPid = grabberUnder(toggleProc.pid)[0] ?? null;
      } catch (err) { lookupError = err.message; }
    }
    if (grabberPid) process.kill(grabberPid, 'SIGKILL');
    let faulted = afterToggle;
    for (let i = 0; i < 80; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      faulted = await getJson(`${toggleUrl}/sensor/health`);
      if (faulted.respawns >= 1 && faulted.state === 'live') break;
    }
    check(faulted.respawns === 1 && faulted.restarts === 1,
      'a grabber killed under the server is counted as the fault it is, which is the one respawn the reading below has to keep reporting',
      grabberPid ? `killed ${grabberPid}: ${faulted.respawns} respawns, ${faulted.restarts} restarts, state ${faulted.state}`
        : `no grabber found under the server after 10s, so this row measured nothing${lookupError ? ` (${lookupError})` : ''}`);

    // Sampled across the whole of the next restart rather than at its ends. The cadence
    // is what makes the row able to fail: the backoff is 250ms at its shortest, so a
    // sample every 40ms cannot miss it, and the widest gap between two samples is
    // reported so a run on a machine that stalled says so instead of passing.
    const toggleBack = new WebSocket(toggleUrl.replace('http', 'ws'));
    await new Promise((done, fail) => { toggleBack.on('open', done); toggleBack.on('error', fail); });
    const readings = [{ at: performance.now(), h: faulted }];
    toggleBack.send(JSON.stringify({ camera: { color: false } }));
    for (let i = 0; i < 150; i++) {
      await new Promise((done) => { setTimeout(done, 40); });
      readings.push({ at: performance.now(), h: await getJson(`${toggleUrl}/sensor/health`) });
      if (totalSpawns(readings.at(-1).h) > totalSpawns(faulted)) break;
    }
    toggleBack.close();
    const widest = Math.max(...readings.slice(1).map((r, i) => r.at - readings[i].at));
    const spanned = readings.at(-1).at - readings[0].at;
    check(totalSpawns(readings.at(-1).h) === totalSpawns(faulted) + 1 && widest <= 200 && spanned >= 250,
      'the second toggle really did stop and respawn the grabber, and the whole of it was sampled faster than the shortest backoff it can run at',
      `${readings.length} readings over ${Math.round(spanned)}ms, widest gap ${Math.round(widest)}ms`);
    const dip = readings.find((r, i) => i > 0 && r.h.respawns < readings[i - 1].h.respawns);
    check(dip === undefined,
      'and the respawn count never goes backwards while it happens - the failure this node really had stays reported for every moment of the restart it did not have',
      dip ? `fell to ${dip.h.respawns} at ${Math.round(dip.at - readings[0].at)}ms`
        : `held at ${readings.map((r) => r.h.respawns).join('')} throughout`);
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 13)) p.child.kill('SIGKILL');
  }

  // ------------------- 14. the gallery follows the recorder rather than the page load
  //
  // `refresh()` ran once at module load and nothing polled, so a tile went on saying a
  // take was still being written for as long as the page stayed open - and `cannotOpen`
  // reads that same warning out to disable Open, Download, Rename and Remove behind it.
  // Once the recorder stopped, every one of those was wrong until somebody reloaded:
  // the take is finished, hashed and openable, and the gallery refuses to open it.
  console.log('\n[library] the gallery follows the recorder rather than the moment it was loaded');
  {
    let shooting = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      shooting = await getJson(`${liveUrl}/record/state`);
      if (shooting.recording) break;
    }
    check(shooting?.recording === true,
      'a take is genuinely open, which is what makes the tile below a tile that is lying rather than one that is right',
      String(shooting?.takeId));

    const { page, errors } = await openPage(browser, galleryPage(liveUrl));
    await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    // Counted rather than assumed. Every row below is about what the poll *decides*,
    // and all of them would pass on a page that had stopped polling at all - which is
    // the opposite failure and the one a gate is most likely to be written into.
    let polls = 0;
    page.on('request', (req) => { if (req.url().endsWith('/record/state')) polls++; });

    const flagsOf = async (id) => page.evaluate(`(() => {
      const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(id)});
      return t ? { flags: t.flags, acts: t.acts } : null;
    })()`);
    const before = await flagsOf(shooting.takeId);
    check(before?.flags?.includes('recording') === true,
      'the tile of the take being written says so, and its Open is refused behind that',
      `flags ${before?.flags?.join(',')}, Open ${before?.acts?.find((a) => a.label === 'Open')?.disabled ? 'disabled' : 'enabled'}`);

    // **A property on the node itself, because that is what a repaint destroys.**
    // `paint()` calls `grid.replaceChildren()`, so a tile that survived a tick is the
    // same object and a tile that did not is a new one - which no reading of the
    // library's own state can tell apart, since both would report the same take.
    await page.evaluate("document.querySelector('.tile').__quietProbe = 'planted'");
    const pollsAtProbe = polls;
    // Comfortably longer than one cadence rather than barely, because this row's
    // meaning rests on a tick having happened: at 6.5s it came back with exactly one
    // request and no headroom, and a five-second timer on a machine three other agents
    // are also running checks on can drift further than that. A row whose control
    // depends on scheduling luck is a row that teaches people to re-run.
    await new Promise((done) => { setTimeout(done, 8500); });
    const quiet = await page.evaluate(`(() => ({
      probe: document.querySelector('.tile')?.__quietProbe ?? null,
      tiles: globalThis.__library.tiles().length,
    }))()`);
    check(polls > pollsAtProbe,
      'the poll is running, which is what makes the row below about the gate rather than about a page that stopped asking',
      `${polls - pollsAtProbe} requests to /record/state in 8.5s`);
    check(quiet.probe === 'planted',
      'and a tick in which the recorder did not move replaces no tile - the menu an operator has open and the skim under their pointer both survive it',
      quiet.probe === 'planted' ? `${quiet.tiles} tiles, the same nodes` : 'the grid was rebuilt');

    // **The same gallery on the machine it is actually used from**, which is not this
    // one. An editing station carries no sensor and runs with `--node`, so
    // `/library/all` reconciles the node's takes into its grid and draws a tile for a
    // take being written over there - and the recorder it polled to decide whether any
    // of that had changed was its own, which never moves. The tile went on refusing
    // Open, Download, Rename and Remove for as long as the page stayed open, on the one
    // machine somebody is standing at. The section that found none of this served the
    // gallery from the recorder, where the two are the same process.
    //
    // A captures directory of its own and empty, so every take in this grid is the
    // node's and a row about the remote tile cannot be answered by a local one.
    const linkedDir = join(WORK, 'linked-gallery');
    rmSync(linkedDir, { recursive: true, force: true });
    mkdirSync(linkedDir, { recursive: true });
    const linkedUrl = await startServer(root, [
      '--captures', linkedDir, '--name', 'mac-editing',
      '--node', liveUrl, '--node-name', 'shooting-live',
    ], MAC_PORT + 12);
    const linked = await openPage(browser, galleryPage(linkedUrl));
    await linked.page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    let linkedPolls = 0;
    linked.page.on('request', (req) => { if (req.url().endsWith('/record/state')) linkedPolls++; });
    const linkedFlags = async (id) => linked.page.evaluate(`(() => {
      const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(id)});
      return t ? { flags: t.flags, acts: t.acts } : null;
    })()`);
    // **The action a remote take offers is Download, and while it is being written it
    // is not offered at all.** `availability` gives a remote take a Download button
    // only once it has stopped, because a take mid-write has no settled hash and the
    // node answers 409 for it - so what a shooting remote tile carries is the same
    // disabled Open a local one does. That transition, disabled Open to enabled
    // Download, is what this station gets out of following the node's recorder, and it
    // is a different pair of buttons from the one the direct gallery below reads.
    const actLabels = (t) => (t?.acts ?? []).map((a) => `${a.label}${a.disabled ? ' (off)' : ''}`).join(' ') || '(none)';
    const remoteBefore = await linkedFlags(shooting.takeId);
    check(remoteBefore?.flags?.includes('recording') === true
      && remoteBefore?.acts?.find((a) => a.label === 'Open')?.disabled === true,
      'a station with no sensor of its own draws the node\'s open take into its grid, says it is being written, and refuses every action behind that',
      `flags ${remoteBefore?.flags?.join(',') ?? '(no tile)'}, acts ${actLabels(remoteBefore)}`);
    // This machine's own recorder, said out loud. It is the reading that makes the row
    // below a claim about following the *node* rather than about following anything:
    // a gallery here that polled only what this process holds would be polling a flag
    // that is false now and false for the life of the page.
    const linkedOwn = await getJson(`${linkedUrl}/record/state`);
    check(linkedOwn.recording === false && linkedOwn.node?.recording === true,
      'and its own recorder is idle while the node it names is shooting, which is the split that made the local flag useless here',
      `local ${linkedOwn.recording}, node ${linkedOwn.node?.name} ${linkedOwn.node?.recording} (reachable ${linkedOwn.node?.reachable})`);

    // **A take stops being recorded several seconds before it stops being the
    // recorder's, and everything below is about what the library says inside that gap.**
    // `close` gives up `this.take` at the front of it, because the marks and the
    // mid-write handler both need the open take gone the moment it stops - and then
    // flushes the stream, writes the sidecar and reads the whole file back to build the
    // index and the content hash, which are what make a take a gallery entry at all. On
    // a slow disk that is seconds. Answer "nobody is writing this" in there and
    // `/library/all` calls the take finalised, so the gallery offers Download on a take
    // with no hash and Remove on a file this process is mid-read of.
    //
    // Observed while it runs rather than reasoned about: `/record/stop` does not answer
    // until the close has finished, so every sample taken while that request is in
    // flight and reporting `recording: false` is a sample from inside the window.
    const stopping = post(`${liveUrl}/record/stop`);
    let stopSettled = false;
    stopping.then(() => { stopSettled = true; }, () => { stopSettled = true; });
    let insideSamples = 0;
    let askedInside = null;
    while (!stopSettled && insideSamples < 400) {
      const s = await getJson(`${liveUrl}/record/state`);
      if (s.recording !== false) continue;
      insideSamples++;
      if (askedInside !== null) continue;
      // **The frame API rather than the listing, because it is the cheap question and
      // the window is short.** Both doors are the same `beingRecorded` predicate over
      // the same `openPath`, but `/library/all` walks the directory and hashes what it
      // finds - and on the broken build that hash runs against the file `buildIndex` is
      // reading, so the listing took longer than the window it was meant to be read
      // inside and the row reddened for missing rather than for what it saw. This one
      // is a predicate and a 409.
      //
      // Confirmed inside the window by the stop not having answered yet: the response
      // below arrived first, and the window does not close until that request does.
      const asked = await fetch(`${liveUrl}/capture/${shooting.takeId}/index`);
      const body = await asked.json().catch(() => null);
      if (!stopSettled) askedInside = { status: asked.status, error: body?.error ?? null };
    }
    await stopping;
    check(insideSamples > 0,
      'the close was caught while it was still running, which is what makes the row below a reading from inside the window rather than one that missed it',
      `${insideSamples} samples taken inside the close`);
    check(askedInside?.status === 409,
      'and the take is still the recorder\'s for the whole of it - the frame API refuses a take whose index and hash do not exist yet, which is the same refusal every surface offering Download, Rename or Remove is drawn from',
      askedInside === null ? 'no answer came back inside the window at all, which on this route means the server went scanning a file it should have refused'
        : `HTTP ${askedInside.status}: ${askedInside.error ?? '(no refusal)'}`);

    // And the half the gate is not allowed to swallow. Stopping the take changes the
    // recording flag, which is exactly the fact a tile is drawn from - and it has to
    // reach both galleries, the one served by the recorder and the one a network away.
    await page.waitForFunction(
      `(() => { const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(shooting.takeId)});
        return t && !t.flags.includes('recording'); })()`,
      null, { timeout: 20000 },
    ).catch(() => {});
    await linked.page.waitForFunction(
      `(() => { const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(shooting.takeId)});
        return t && !t.flags.includes('recording'); })()`,
      null, { timeout: 25000 },
    ).catch(() => {});
    const remoteAfter = await linkedFlags(shooting.takeId);
    check(linkedPolls > 0,
      'the station is polling, which is what makes the row below about what the poll watches rather than about a page that stopped asking',
      `${linkedPolls} requests to /record/state`);
    check(remoteAfter?.flags?.includes('recording') === false
      && remoteAfter?.acts?.find((a) => a.label === 'Download')?.disabled === false,
      'and it follows the node\'s recorder rather than its own, so the finished take stops being refused and becomes downloadable without anybody reloading',
      `flags ${remoteAfter?.flags?.join(',') || '(none)'}, acts ${actLabels(remoteAfter)}`);
    check(linked.errors.length === 0, 'and the linked gallery raises no page error while it follows',
      linked.errors.slice(0, 2).join(' | '));
    await linked.page.close();
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 12)) p.child.kill('SIGKILL');

    const after = await flagsOf(shooting.takeId);
    check(after?.flags?.includes('recording') === false,
      'and a tick in which the recorder stopped repaints, so the tile stops claiming a finished take is still being written',
      `flags ${after?.flags?.join(',') || '(none)'}`);
    check(after?.acts?.find((a) => a.label === 'Open')?.disabled === false,
      'and its Open, Download, Rename and Remove come back without anybody reloading the page',
      after?.acts?.map((a) => `${a.label}${a.disabled ? ' (off)' : ''}`).join(' '));
    const probeAfter = await page.evaluate("document.querySelector('.tile')?.__quietProbe ?? null");
    check(probeAfter === null,
      'which is a genuine repaint rather than a tile edited in place, since the nodes the tick found are gone',
      String(probeAfter));

    check(errors.length === 0, 'and the gallery raises no page error while it follows', errors.slice(0, 2).join(' | '));
    await page.close();

    // **A node that did not answer is not a node with nothing on it.** `/library/all`
    // hands `reconcile` a null when the manifest read fails and null reads as an empty
    // array, so a dropped link removes every node-only tile and turns every `both` take
    // into a `local` one - and the delete confirmation that refuses to remove the last
    // copy is drawn from exactly that count. The tile then offers a delete whose safety
    // rests on a reading that says "no second copy" where what happened is "no answer".
    //
    // A station of its own pointed at a port nothing holds, so the node is unreachable
    // from the first listing rather than made so mid-run - there is no window here for a
    // successful read to have populated anything.
    const blindNodeUrl = await startServer(root, [
      '--captures', macCaps, '--name', 'mac-blind',
      // **Inside the reserved span, and that is the whole reason for the offset.** The
      // node has to be one nothing answers on, so a port outside the span would be a
      // port some other worktree is free to hold - and a stranger answering turns the
      // unreachable node this section is about into a reachable one. `+16` is reserved
      // like the rest and its only server was killed at the end of the rename section,
      // so it is dead by here. If a later section takes it in between, the precondition
      // row below reads a reachable node and says so rather than passing quietly.
      '--node', `http://127.0.0.1:${MAC_PORT + 16}`, '--node-name', 'a-node-that-is-not-there',
    ], MAC_PORT + 11);
    const dark = await openPage(browser, galleryPage(blindNodeUrl));
    await dark.page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const darkState = await dark.page.evaluate('globalThis.__library.state()');
    const darkTiles = await dark.page.evaluate('globalThis.__library.tiles()');
    check(darkState.node?.reachable === false && darkTiles.length > 0,
      'the station has a node it cannot reach and takes of its own on screen, which is the pair the row below needs',
      `node ${darkState.node?.name} reachable ${darkState.node?.reachable}, ${darkTiles.length} tiles`);
    // **Delete is an act, and the first draft of these two rows looked for it in the ⋯
    // menu.** `menu` holds rename, reveal and reclaim; there is no `delete` in it on any
    // build, so "not one of them offers Delete" was a filter over an empty match and
    // passed whatever the page did - the mutation restored the offer and the row went on
    // agreeing. The missing-Delete arm below is what stops that recurring: a lookup that
    // finds nothing now fails here rather than reading as a refusal.
    const deleteAct = (t) => t.acts.find((a) => a.item === 'delete');
    const noDelete = darkTiles.filter((t) => !deleteAct(t));
    const deletable = darkTiles.filter((t) => !deleteAct(t)?.disabled);
    check(noDelete.length === 0 && deletable.length === 0,
      'and not one of them offers Delete while the node is unreachable, because the copy count that would make it safe came from a read that failed rather than from a node with nothing on it',
      noDelete.length
        ? `${noDelete.length} of ${darkTiles.length} render no Delete at all, so this row would be reading nothing`
        : deletable.length ? `${deletable.length} of ${darkTiles.length} still deletable: ${deletable.map((t) => t.id).join(' ')}`
          : `${darkTiles.length} tiles, every Delete refused`);
    const why = darkTiles[0] ? deleteAct(darkTiles[0])?.why ?? '' : '';
    check(/cannot be reached/.test(why) && why.includes('a-node-that-is-not-there'),
      'and it says which node it could not reach, so the refusal is a fact about the link rather than a control that went dead',
      `"${why.slice(0, 90)}"`);
    check(dark.errors.length === 0, 'and that gallery raises no page error', dark.errors.slice(0, 2).join(' | '));
    await dark.page.close();
    for (const p2 of servers.filter((sv) => sv.port === MAC_PORT + 11)) p2.child.kill('SIGKILL');

    // **The gap between the listing a gallery paints and the first tick it compares
    // against.** The page reads `/library/all`, draws a take as being written, and only
    // then asks the recorder what it is doing. A first tick with nothing behind it
    // cannot report a change, so a take that stopped inside that gap was stopped in the
    // first fingerprint and in every one after it - none of them ever differed, the
    // library was never reread, and the tile refused to open a finished take for as long
    // as the page stayed up. It survived every row above because all of them watch a
    // transition that happens *after* the page has an observation to compare against.
    //
    // The gap is held open rather than raced for: the first `/record/state` is caught at
    // the page's edge and kept there while the take is stopped underneath, so the tick
    // that is finally allowed through is answering about a world that moved while it was
    // waiting. That is the same shape as the real failure and none of its timing.
    const second = await post(`${liveUrl}/record/start`);
    let shootingAgain = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      shootingAgain = await getJson(`${liveUrl}/record/state`);
      if (shootingAgain.recording) break;
    }
    check(shootingAgain?.recording === true && shootingAgain.takeId !== shooting.takeId,
      'a second take is open, so the page below paints a tile that is genuinely mid-write rather than one left over from the first',
      `${shootingAgain?.takeId} (was ${shooting.takeId}), start said ${JSON.stringify(second).slice(0, 60)}`);

    const blind = await browser.newPage();
    const blindErrors = [];
    blind.on('pageerror', (err) => blindErrors.push(String(err)));
    blind.on('console', (msg) => { if (msg.type() === 'error') blindErrors.push(msg.text()); });
    // **Every tick is held, not only the first, and that is the difference between a
    // control and a coincidence.** The poll re-asks on a five-second timer whatever the
    // held request is doing, so a second tick let through while the take was still
    // being written would give the unseeded build an observation to compare against -
    // and the tick after *that* would see the stop, report a change, and refresh. The
    // defect would have been repaired by the fixture rather than by the code, and this
    // row would have gone green on the build it exists to redden. Holding the lot means
    // every tick this page ever gets answers about the world after the stop, which is
    // precisely the state a first tick with nothing behind it cannot act on.
    const heldTicks = [];
    let releaseTicks = false;
    await blind.route('**/record/state', async (route) => {
      if (releaseTicks) { await route.continue(); return; }
      heldTicks.push(route);
    });
    await blind.goto(galleryPage(liveUrl), { waitUntil: 'domcontentloaded' });
    await blind.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const paintedMidWrite = await blind.evaluate(`(() => {
      const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(shootingAgain?.takeId)});
      return t ? t.flags.includes('recording') : null;
    })()`);
    check(paintedMidWrite === true && heldTicks.length > 0,
      'the page painted that take as being written and every tick it has asked for is held at the edge, which is the state the gap leaves a real gallery in',
      `painted mid-write ${paintedMidWrite}, ${heldTicks.length} /record/state held`);
    await post(`${liveUrl}/record/stop`);
    const restedAfter = await getJson(`${liveUrl}/record/state`);
    check(restedAfter.writingId === null,
      'and the take finished underneath it - index, hash and all - before the tick was let go, so the tick answers about a world that moved while it waited',
      `writingId ${restedAfter.writingId}, recording ${restedAfter.recording}`);
    releaseTicks = true;
    for (const route of heldTicks) await route.continue().catch(() => {});
    const cameBack = await blind.waitForFunction(
      `(() => { const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(shootingAgain?.takeId)});
        return t && !t.flags.includes('recording') && t.acts.find((a) => a.label === 'Open')?.disabled === false; })()`,
      null, { timeout: 25000 },
    ).then(() => true).catch(() => false);
    const blindTile = await blind.evaluate(`(() => {
      const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(shootingAgain?.takeId)});
      return t ? { flags: t.flags, acts: t.acts.map((a) => a.label + (a.disabled ? ' (off)' : '')) } : null;
    })()`);
    check(cameBack,
      'and the tile stops refusing a take that finished in the gap, because the first tick is compared against the grid that was painted rather than against nothing',
      blindTile === null ? 'no tile for that take' : `flags ${blindTile.flags.join(',') || '(none)'}, acts ${blindTile.acts.join(' ')}`);
    check(blindErrors.length === 0, 'and that page raises no error while it catches up', blindErrors.slice(0, 2).join(' | '));
    await blind.close();

    // **A refresh that fails is a transition the gallery has not seen yet.** The poll
    // used to record a tick as seen the moment it had one, so a single `/library/all`
    // losing its connection advanced the fingerprint past the very transition its
    // refresh had failed on - and since every later tick then matched, the gallery never
    // looked again and the tile kept a finished take's actions disabled for the life of
    // the page. One unlucky five-second window, permanent.
    //
    // The failure is injected at the page's edge and withdrawn after exactly one, which
    // is what separates "retries" from "kept trying forever": the row below wants the
    // next tick to succeed, not the fetch to be broken for the rest of the section.
    const third = await post(`${liveUrl}/record/start`);
    let shootingThird = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      shootingThird = await getJson(`${liveUrl}/record/state`);
      if (shootingThird.recording) break;
    }
    check(shootingThird?.recording === true,
      'a third take is open, so the page below has a transition to miss and then catch up on',
      `${shootingThird?.takeId}, start said ${JSON.stringify(third).slice(0, 50)}`);

    const flaky = await browser.newPage();
    const flakyErrors = [];
    flaky.on('pageerror', (err) => flakyErrors.push(String(err)));
    flaky.on('console', (msg) => { if (msg.type() === 'error') flakyErrors.push(msg.text()); });
    let listings = 0;
    let refused = 0;
    await flaky.route('**/library/all', async (route) => {
      listings++;
      // The first listing is the page's own load and has to succeed, or there is no
      // painted grid for the tick to disagree with and the row measures the wrong hole.
      // The second is the refresh the stop transition asks for, and it is the one that
      // fails.
      if (listings === 2) { refused++; await route.abort('connectionfailed'); return; }
      await route.continue();
    });
    await flaky.goto(galleryPage(liveUrl), { waitUntil: 'domcontentloaded' });
    await flaky.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const flakyPainted = await flaky.evaluate(`(() => {
      const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(shootingThird?.takeId)});
      return t ? t.flags.includes('recording') : null;
    })()`);
    check(flakyPainted === true,
      'that page painted the open take as being written, from a listing that was allowed through',
      `painted mid-write ${flakyPainted}, ${listings} listings so far`);
    await post(`${liveUrl}/record/stop`);
    const caughtUp = await flaky.waitForFunction(
      `(() => { const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(shootingThird?.takeId)});
        return t && !t.flags.includes('recording') && t.acts.find((a) => a.label === 'Open')?.disabled === false; })()`,
      null, { timeout: 30000 },
    ).then(() => true).catch(() => false);
    check(refused === 1,
      'and exactly one of its listings was refused - the refresh the stop asked for, so the tick after it is a retry rather than a first attempt',
      `${refused} refused of ${listings} listings`);
    const flakyTile = await flaky.evaluate(`(() => {
      const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(shootingThird?.takeId)});
      return t ? { flags: t.flags, acts: t.acts.map((a) => a.label + (a.disabled ? ' (off)' : '')) } : null;
    })()`);
    check(caughtUp,
      'and the gallery comes back from it on a later tick, because a refresh that failed leaves the transition unseen rather than spending it',
      flakyTile === null ? 'no tile for that take' : `flags ${flakyTile.flags.join(',') || '(none)'}, acts ${flakyTile.acts.join(' ')}`);
    await flaky.close();

    // **And the retry is bounded, which is the debt holding the fingerprint back took
    // on.** A handler that never returns leaves `previous` where it was, so without a
    // guard every later tick reports the same change and starts another `/library/all`
    // - and where a `--node` is linked that is a request and a connection to the other
    // machine every five seconds for as long as the page is open. The failure mode is
    // not a wrong answer but an unbounded one, so what this counts is requests.
    //
    // The listing is accepted and then never answered, which is the shape that matters:
    // a refused request returns and lets the handler finish, and the whole defect is
    // about a handler that does not.
    const fourth = await post(`${liveUrl}/record/start`);
    let shootingFourth = null;
    for (let i = 0; i < 40; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
      shootingFourth = await getJson(`${liveUrl}/record/state`);
      if (shootingFourth.recording) break;
    }
    check(shootingFourth?.recording === true,
      'a fourth take is open, so the page below has a transition whose refresh can be left hanging',
      `${shootingFourth?.takeId}, start said ${JSON.stringify(fourth).slice(0, 50)}`);

    const hung = await browser.newPage();
    let hungListings = 0;
    let ticksSeen = 0;
    const heldForever = [];
    const heldAt = [];
    await hung.route('**/library/all', async (route) => {
      hungListings++;
      // The first is the page's own load and has to answer, or there is no painted grid
      // and no transition to follow. Every one after it is held open for good.
      if (hungListings === 1) { await route.continue(); return; }
      heldForever.push(route);
      heldAt.push(Date.now());
    });
    await hung.route('**/record/state', async (route) => { ticksSeen++; await route.continue(); });
    await hung.goto(galleryPage(liveUrl), { waitUntil: 'domcontentloaded' });
    await hung.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    await post(`${liveUrl}/record/stop`);
    // Two cadences and change, so a poll that started a listing per tick would have
    // started two or three and a poll that waits for the one in flight has started
    // exactly one - and deliberately short of the fifteen-second listing timeout, which
    // the rows after this one are about. The margin keeps a slow machine from reading as
    // a catch without letting the bound fire early and change what is being counted.
    await new Promise((done) => { setTimeout(done, 11000); });
    const heldCount = heldForever.length;
    const listingsWhileHung = hungListings;
    check(heldCount === 1,
      'it has exactly one listing in flight however long that one takes - a refresh that has not come back is the question already being asked, not a reason to ask it again every five seconds',
      `${heldCount} listings left hanging, ${hungListings} requested in total`);
    // **The liveness half is that it comes back on its own, and nothing here clears the
    // hang for it.** The single-flight guard and the listing's timeout are two halves of
    // one arrangement: without the bound, the guard turns one dead listing into a gallery
    // that has stopped, since the guard holds for the whole tick and the tick is waiting
    // on a request that will never answer. The earlier version of this row aborted the
    // held listing itself and then checked that a new one went out, which proves the
    // retry works and says nothing about whether anything would ever have released it.
    // So the fixture now just waits: past fifteen seconds the page's own bound fails the
    // listing, the handler throws, the fingerprint stays where it was, and the next tick
    // offers the same transition again.
    //
    // **Timed from the held listing rather than from here, because the two are not a
    // fixed distance apart.** The transition is only noticed on the first tick after the
    // stop has flushed, indexed and hashed, so the listing that hangs goes out somewhere
    // in the first cadences rather than at a known moment - and the bound then runs
    // fifteen seconds from *it*, with the retry landing on the next five-second tick
    // after that. A flat twelve-second wait from here read twenty-three seconds against a
    // listing that went out at five and could not have been reasked before twenty-five,
    // which failed a correct build for being two seconds early. Polled to a deadline that
    // moves with the listing instead, and reported as the interval it actually took.
    const freeBy = (heldAt[0] ?? Date.now()) + 15000 + 5000 + 6000;
    while (Date.now() < freeBy && hungListings === listingsWhileHung) {
      await new Promise((done) => { setTimeout(done, 250); });
    }
    const freedAfter = heldAt[0] ? Date.now() - heldAt[0] : null;
    check(hungListings > listingsWhileHung,
      'and the page frees itself from a listing nothing was ever going to answer, so the single listing above is a poll waiting rather than a poll that has stopped',
      `${listingsWhileHung} listings while it hung, ${hungListings} ${freedAfter}ms after that listing went out,`
      + ` ${ticksSeen} ticks to /record/state throughout`);
    for (const route of heldForever) await route.abort('connectionfailed').catch(() => {});
    await hung.close();

    // **The other way into the same poll, which the guard above nearly closed.** The
    // cadence wants to be skipped while a tick runs; the record button wants the
    // opposite. It awaits the poll after its own POST so the surface repaints from the
    // world its press produced - and handing it the request already in flight hands it
    // a `recorder.state` snapshot taken before the press. The button re-enables against
    // that, and the next click chooses start or stop from it.
    //
    // Counted in requests rather than read off the painted surface, because the paint
    // is repaired by the next cadence tick a few seconds later: a row that waited to
    // read it would pass on both builds and only be measuring the interval. What
    // separates them is whether the press caused a read of its own at all.
    //
    // The response is fetched immediately and delivered late, which is what makes the
    // in-flight request one that snapshotted before the click. Delaying the request
    // instead would snapshot after it and there would be nothing to catch.
    const slow = await browser.newPage();
    let stateRequests = 0;
    await slow.route('**/record/state', async (route) => {
      stateRequests++;
      const answered = await route.fetch();
      const body = await answered.text();
      await new Promise((done) => { setTimeout(done, 3000); });
      await route.fulfill({ status: answered.status(), body, headers: answered.headers() });
    });
    await slow.goto(recorderPage(liveUrl), { waitUntil: 'domcontentloaded' });
    await slow.waitForFunction("document.getElementById('recGo') !== null", null, { timeout: 30000 });
    // Pressed while one is in flight, which is the whole condition. The first tick goes
    // out at load and takes three seconds to come back, so a click 1.2s in is inside it
    // without having to race anything.
    await new Promise((done) => { setTimeout(done, 1200); });
    const requestsBeforePress = stateRequests;
    await slow.click('#recGo');
    // **Long enough for the rerun to have gone out, and short enough that the cadence
    // has not.** The rerun is chained onto the request in flight, so it cannot be
    // observed before that one comes back - the first draft of this row measured 2.5s
    // after a press made 1s into a 4s response and found nothing on a correct build,
    // which is a fixture that closed its window before the thing it was watching for.
    // The in-flight response lands at about 3.2s and the rerun goes out behind it; the
    // interval's first fire is at 5s and skips anyway while that rerun runs.
    await new Promise((done) => { setTimeout(done, 3000); });
    const requestsAfterPress = stateRequests;
    const started = await getJson(`${liveUrl}/record/state`);
    check(started.recording === true,
      'the record button really did start a take, so the row below is about the read that followed a press rather than about a press that did nothing',
      `recording ${started.recording}, take ${started.takeId}`);
    check(requestsAfterPress > requestsBeforePress,
      'and pressing it asks the recorder again rather than settling for the answer already in flight, which was taken before the press and would repaint the world as it was',
      `${requestsBeforePress} requests before the press, ${requestsAfterPress} within 3s after it`);
    await post(`${liveUrl}/record/stop`);
    await slow.close();

    // **The bound belongs to the poll, and the first listing is the case it must not
    // reach.** A cold library is slow for a legitimate reason - `cachedIndex` scans each
    // file once and writes a `.idx` beside it, measured at 7m30s over 200 unindexed takes
    // against 2.4s for a second server off those sidecars - and the load is a top-level
    // await, so a bound that fires there ends module evaluation before the poll starts
    // and before `globalThis.__library` exists. What the operator gets is not a slow
    // gallery but a blank one that never recovers.
    //
    // Eighteen seconds because the bound is fifteen: long enough that a bounded load has
    // certainly given up, short enough not to pay for more than one of them. Held rather
    // than made genuinely slow, since what is under test is which listing carries a
    // deadline, not how fast an index builds.
    const cold = await browser.newPage();
    let coldListings = 0;
    await cold.route('**/library/all', async (route) => {
      coldListings++;
      if (coldListings === 1) await new Promise((done) => { setTimeout(done, 18000); });
      await route.continue();
    });
    await cold.goto(galleryPage(liveUrl), { waitUntil: 'domcontentloaded' });
    let coldInstalled = true;
    await cold.waitForFunction('globalThis.__library !== undefined', null, { timeout: 30000 })
      .catch(() => { coldInstalled = false; });
    const coldTiles = coldInstalled ? await cold.evaluate('globalThis.__library.tiles().length') : 0;
    check(coldInstalled && coldTiles > 0,
      'a first listing slower than the poll\'s own bound still paints, because a cold library is the case that listing exists to get through rather than a link to give up on',
      coldInstalled ? `held 18s, ${coldTiles} tiles` : 'the page never installed its hook - module evaluation ended on the load');
    await cold.close();

    // **And the class the bound was only one way into.** Anything the first listing
    // throws ends the module there, so a node that resets, a 500 out of `serveLibrary`
    // and a body that is not JSON all leave the same blank shelf with no error on it.
    // Answered with a 500 rather than aborted, because a refused request is the shape a
    // reader would least expect to be fatal.
    const broken = await browser.newPage();
    let brokenListings = 0;
    await broken.route('**/library/all', async (route) => {
      brokenListings++;
      if (brokenListings === 1) { await route.fulfill({ status: 500, body: 'the library is unavailable' }); return; }
      await route.continue();
    });
    await broken.goto(galleryPage(liveUrl), { waitUntil: 'domcontentloaded' });
    let brokenInstalled = true;
    await broken.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 })
      .catch(() => { brokenInstalled = false; });
    check(brokenInstalled,
      'and a first listing that fails outright leaves a page that still has its hook, rather than ending module evaluation on a top-level await',
      brokenInstalled ? 'installed after a 500' : 'the page never installed its hook');
    const repaired = brokenInstalled
      ? await broken.evaluate('globalThis.__library.refresh().then(() => globalThis.__library.tiles().length).catch(() => -1)')
      : -1;
    check(repaired > 0,
      'and it comes back on the next listing that works, so the failure costs a refresh rather than the session',
      repaired === -1 ? 'no working refresh was reachable' : `${repaired} tiles after the next refresh`);
    await broken.close();

    // **And the same refusal in the shape this server actually sends it.** The arm above
    // answers with a body that is not JSON, so `res.json()` throws before anything is
    // assigned and the intact default is what gets painted - a real door, and not the one
    // `serveLibrary` uses. What it writes is `sendJson(res, { error }, 500)`, and that
    // body parses: read straight through it landed in `library` whole, `paint()` went for
    // `library.storage.label` on an object with no storage, and the throw arrived *inside*
    // the catch added to recover from it - where a throw is uncaught, so module evaluation
    // ended anyway. A fixture is a claim about which failures were tried, and this one had
    // tried the half the server does not send.
    const refusedPage = await browser.newPage();
    let refusedListings = 0;
    await refusedPage.route('**/library/all', async (route) => {
      refusedListings++;
      if (refusedListings === 1) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'the captures directory cannot be read: ENOTDIR' }),
        });
        return;
      }
      await route.continue();
    });
    await refusedPage.goto(galleryPage(liveUrl), { waitUntil: 'domcontentloaded' });
    let refusedInstalled = true;
    await refusedPage.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 })
      .catch(() => { refusedInstalled = false; });
    check(refusedInstalled,
      'and a refusal that parses - the only kind this server sends - is not believed as a library, so the page still installs its hook',
      refusedInstalled ? 'installed after a JSON 500' : 'the page never installed its hook');
    // Asked separately, because a page that installed its hook over a blank shelf with no
    // sentence on it is the failure this surface is named for. The server took trouble to
    // say which directory and why, and that is the whole difference between a five-second
    // fix and a mystery.
    const refusedSaid = refusedInstalled
      ? await refusedPage.evaluate('document.getElementById("note")?.textContent ?? ""')
      : '';
    check(/ENOTDIR/.test(refusedSaid),
      'and the server\'s own sentence is what reaches the note, rather than a TypeError raised while painting the refusal',
      JSON.stringify(refusedSaid));
    await refusedPage.close();
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 1)) p.child.kill('SIGKILL');

    // **A node that stops answering must not leave this machine holding the pair.**
    // `serveLibrary` awaits `node.takes`, which crosses the network with no bound of its
    // own - and once the gallery's listing is bounded, every retry that gives up leaves
    // another handler here and another outbound socket over there, one pair per tick for
    // as long as the page is open. The browser's abort cancels its own request and
    // nothing else unless this process is told to pass it on.
    //
    // Driven with a plain `fetch` rather than through a page, because what is under test
    // is what this server does when its caller leaves - a browser would only add a second
    // place for the answer to come from. The node is a stub on a kernel-assigned port for
    // the same reason the older-build stub is: anything spawned from `stageServer` runs
    // the build under test and answers correctly by construction.
    const deafHeld = [];
    const deaf = await new Promise((done) => {
      const srv = createServer((req, res) => {
        if (req.url === '/library/takes') {
          const seen = { closedAt: null, answered: false };
          deafHeld.push(seen);
          // `close` fires for a request that ended either way, so what it answered is
          // recorded with it - a row that counted closes alone would read a completed
          // request as a cancelled one.
          req.on('close', () => { seen.closedAt = Date.now(); seen.answered = res.writableEnded; });
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"takes":[]}');
      });
      srv.listen(0, '127.0.0.1', () => done({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
    });
    const deafUrl = await startServer(root, [
      '--captures', macCaps, '--name', 'mac-deaf',
      '--node', deaf.url, '--node-name', 'a-node-that-never-answers',
    ], MAC_PORT + 11);
    const heldBefore = deafHeld.length;
    await fetch(`${deafUrl}/library/all`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
    const gaveUpAt = Date.now();
    check(deafHeld.length > heldBefore,
      'the listing really did reach the node and is being held there, which is what makes the row below about cancellation rather than about a request that never went out',
      `${deafHeld.length - heldBefore} held at the node`);
    const mine = deafHeld[deafHeld.length - 1];
    for (let i = 0; i < 24 && mine && mine.closedAt === null; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
    }
    const freed = mine?.closedAt === null ? null : mine.closedAt - gaveUpAt;
    check(mine != null && mine.closedAt !== null && mine.answered === false && freed < 1500,
      'and a caller giving up drops the node fetch with it, so a listing nobody is waiting for stops costing a handler here and a socket over there',
      mine?.closedAt === null ? 'the node still holds it 6s after the caller gave up'
        : `dropped ${freed}ms after the caller gave up, unanswered`);
    // **And the same question asked of a route that reads a body first**, which is where
    // the signal was structurally dead while every arm above stayed green. An
    // `IncomingMessage` is a stream and emits `close` when it *ends*, so once
    // `serveRemoval` has awaited `readBody(req)` the request is already destroyed and a
    // listener attached after it never fires again. The listing reads no body and so
    // worked, which is why one arm over one route could not see it - the two halves of
    // the class are the two shapes of handler, not the four route names, and the source
    // sweep below reads clean on both builds because the call really does carry a signal.
    const heldBeforePost = deafHeld.length;
    await fetch(`${deafUrl}/library/delete/a-take-this-machine-does-not-have`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hash: `sha256:${'ab'.repeat(32)}` }),
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
    const postGaveUpAt = Date.now();
    check(deafHeld.length > heldBeforePost,
      'a removal reaches the node too, so the row below is about a body-reading route rather than one that never asked',
      `${deafHeld.length - heldBeforePost} held at the node`);
    const posted = deafHeld[deafHeld.length - 1];
    for (let i = 0; i < 24 && posted && posted.closedAt === null; i++) {
      await new Promise((done) => { setTimeout(done, 250); });
    }
    const postFreed = posted?.closedAt === null ? null : posted.closedAt - postGaveUpAt;
    check(posted != null && posted.closedAt !== null && posted.answered === false && postFreed < 1500,
      'and a route that read its body before asking still drops the node fetch when its caller goes, rather than watching a request that had already ended',
      posted?.closedAt === null ? 'the node still holds it 6s after the caller gave up'
        : `dropped ${postFreed}ms after the caller gave up, unanswered`);
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 11)) p.child.kill('SIGKILL');
    deaf.srv.close();

    // **Every route that awaits the node, and not the one where it was noticed.** The
    // gallery is only the caller whose retry made the leak accumulate; a download, a
    // removal and a mark sync await the same unbounded fetch behind a browser that can
    // close at any point. Read off the source so a route added later is asked by
    // existing, rather than off the four that were found.
    const indexSrc = readFileSync(join(root, 'server/index.js'), 'utf8');
    const nodeCalls = [...indexSrc.matchAll(/await node\.takes\(([^)]*)\)/g)].map((m) => m[1]);
    const unsignalled = nodeCalls.filter((args) => !/untilCallerLeaves|signal/.test(args));
    check(nodeCalls.length >= 4 && unsignalled.length === 0,
      'and every route that awaits the node hands it the caller it is waiting for, so the next one written inherits the rule rather than being outside a list',
      unsignalled.length ? `${unsignalled.length} of ${nodeCalls.length} pass nothing`
        : `${nodeCalls.length} calls, all signalled`);
  }

  // ------------------------- 15. one token, three declarations, one shared stylesheet
  //
  // `--faint` is declared separately in every page and `web/nav.css` styles the current
  // surface with `var(--faint)` while declaring it nowhere - so the shared stylesheet
  // already depends on each page saying the same thing, and fixing one page's hex is
  // how the three drift apart.
  //
  // **The pages are enumerated rather than named**, so a fourth page that declares the
  // token is asked about by existing. Same for the surfaces: every `--paper` the page
  // declares is a background the token can end up on, and a floor that only covered the
  // ones somebody checked would be a floor with a hole the shape of the next design.
  console.log('\n[library] the faint token clears AA on every page that declares it');
  {
    const channel = (c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4);
    const luminance = (hex) => {
      const n = Number.parseInt(hex.slice(1), 16);
      return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
    };
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return (hi + 0.05) / (lo + 0.05);
    };
    // The floor WCAG AA sets for body text, and these are 9px readouts.
    const AA = 4.5;
    const tokenIn = (css, name) => (css.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)) ?? [])[1] ?? null;

    // **The build under test, which on a mutated run is not the repo's own tree.** Read
    // out of the staged root every server here is spawned from, because that is where
    // `stageServer` writes a mutation and therefore what a browser in this run receives.
    // A row reading `REPO` would measure the unmutated source on a mutated run, pass,
    // and have the run recorded as this check having missed a bug it was never shown -
    // the same failure the match-exactly-once rule exists for, arriving through the
    // delivery instead of the anchor. Named as the install rather than as a branch on
    // `pageMutation` so that it stays true of however the next mutation is delivered.
    const sourceOf = (rel) => readFileSync(join(root, rel), 'utf8');

    const pages = readdirSync(join(REPO, 'web')).filter((f) => f.endsWith('.html')).sort();
    const declaring = pages
      .map((file) => ({ file, css: sourceOf(`web/${file}`) }))
      .filter((p) => tokenIn(p.css, 'faint') !== null);
    check(declaring.length >= 3,
      `every page declaring --faint is measured rather than three being named (${pages.length} pages in web/, ${declaring.length} declaring it)`,
      declaring.map((p) => p.file).join(' '));

    // One row per page, and that split is the point: it makes a run say *which* surface
    // regressed rather than that some surface did.
    for (const { file, css } of declaring) {
      const faint = tokenIn(css, 'faint');
      const surfaces = [...css.matchAll(/--(paper(?:-\d)?):\s*(#[0-9a-fA-F]{6})/g)]
        .map((m) => ({ name: m[1], hex: m[2] }));
      const measured = surfaces.map((s) => ({ ...s, ratio: ratio(faint, s.hex) }));
      const worst = measured.reduce((a, b) => (a.ratio <= b.ratio ? a : b), measured[0]);
      check(measured.length >= 2 && worst.ratio >= AA,
        `${file}: --faint clears ${AA}:1 against every surface the page declares`,
        `${faint} - ${measured.map((m) => `${m.name} ${m.ratio.toFixed(2)}`).join(', ')}`);
    }

    // And the restating itself, which is the finding the contrast is a symptom of.
    const values = new Set(declaring.map((p) => tokenIn(p.css, 'faint')));
    check(values.size === 1,
      'and every page declares the same value, because nav.css reads the token without declaring one and cannot be right on two pages that disagree',
      declaring.map((p) => `${p.file} ${tokenIn(p.css, 'faint')}`).join(', '));
    const navCss = sourceOf('web/nav.css');
    check(/var\(--faint\)/.test(navCss) && tokenIn(navCss, 'faint') === null,
      'which is not a hypothetical: the shared stylesheet uses the token and declares none',
      `nav.css reads it, declares ${tokenIn(navCss, 'faint') ?? 'nothing'}`);
  }

  // **Every server this run started, and a row saying so.** The sweep read `servers`
  // alone, which stopped being all of them when a reclaimed offset started moving the
  // previous holder to `retired` - three servers on a full run, whose fatal lines were
  // dropped from the verdict while the tool reported a pass. That is the worst shape a
  // proof tool has: a detection it made and did not say.
  //
  // The count is checked rather than the collection, because what went wrong was not this
  // loop reading the wrong variable - it was a list being split somewhere else and one of
  // its two readers not being told. A row comparing what was swept against what was
  // started is red for either mistake, including the next collection somebody adds.
  //
  // **It has no `--mutate` entry and the reason is a limit worth knowing**: this row is
  // about the instrument, and the mutation machinery reaches only the subject. A spec
  // writes its body into the staged tree, and the stage is `server/` and `web/` - a
  // mutation naming a file under `tools/` would be delivered to a copy nothing runs, and
  // would be recorded as a control that passed. So this one was mutation-tested by hand:
  // `everyServer()` put back to `servers` reddens this row and nothing else, and the
  // commit message carries the numbers.
  const swept = everyServer();
  check(swept.length === serversStarted,
    'the fatal-log sweep reads every server this run started, including the ones whose port was later reclaimed',
    `swept ${swept.length} of ${serversStarted} started`);
  for (const { log } of swept) {
    const text = log.join('');
    const bad = text.split('\n').filter(looksFatal);
    if (bad.length) {
      console.log(`\n[library] server log:\n  ${bad.slice(0, 4).join('\n  ')}`);
      failures++;
    }
  }
}
