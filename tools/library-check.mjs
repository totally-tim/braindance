// Proves the library page and its store: one manifest over a directory of takes, one library
// spanning two machines joined by content hash, a project that survives a round trip through
// a file, and the two removals doing what their names say.
//
// This check owns its servers rather than taking one, because its central claim is about two
// machines reconciling and three of its mutations are in server code no served page reaches.
// It builds a fixture directory, spawns a node and an editing machine against a copy of
// `server/`, and tears both down.
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
// The depth grid, read from the one place that owns it rather than restated here.
import { DEPTH_H, DEPTH_W } from '../web/format.js';
// The shipped argument shape per platform, read rather than restated.
import { REVEAL } from '../server/library.js';
// The format version, imported rather than written down: a literal here is a second copy of
// the one this build writes.
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
// How far above `--mac-port` this suite binds. Sections spawn their own servers at
// `MAC_PORT + n`, and `startServer` asserts its port is inside the span, so a section added
// later at `+17` is caught by arithmetic rather than by a wrong reading. `startServer` polls
// until something answers `/library/takes`, and a stranger on the port answers just as well.
const PORT_SPAN = 16;
const MUTATE = flag('--mutate');
const HEADED = argv.includes('--headed');
const WORK = flag('--work') ?? join(REPO, '.library-check');

let failures = 0;
let assertions = 0;
// Claims this run could not make a fixture for, named in the verdict: a check that quietly
// drops an assertion is a check reporting coverage it does not have.
const skipped = [];
const check = (ok, label, detail = '') => {
  assertions++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// A mutation is a piece of source text, so it stops matching the moment the code it names is
// edited, and the exactly-once refusal below is the only warning that an anchor went stale.
// Server files and page files are delivered the same way: `stageServer` writes the mutated
// file into the copied tree, and the server spawned out of that tree is what serves it.

// The reveal mutation has to break the branch this platform actually runs. Editing the Darwin
// entry only left Linux and Windows with an unchanged branch and a control that cannot fire.
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
  // The library joins on the filename instead of the hash.
  'reconcile-by-filename': { file: 'server/library.js', edits: [[
    "  const keyOf = (take, side) => take.hash ?? `${side}:${take.id}`;",
    '  const keyOf = (take) => take.id;',
  ]] },
  // The index cache stops testing whether the sidecar still describes the file, so a take whose
  // bytes changed keeps reporting the hash it had before.
  'manifest-trusts-cache': { file: 'server/capture.js', edits: [[
    '  if (held && held.bytes === st.size && held.mtimeMs === st.mtimeMs) return held;',
    '  if (held) return held;',
  ]] },
  // Reclaim trusts the listing instead of re-hashing the copy that is supposed to survive.
  'reclaim-trusts-manifest': { file: 'server/index.js', edits: [[
    '    const verified = await hashFile(join(CAPTURES_DIR, mine.file));',
    '    const verified = mine.hash;',
  ]] },
  // Descriptors are never evicted, which is the shape step 2 shipped and named as this step's
  // debt: a library skimming a directory of takes hits EMFILE.
  'no-fd-eviction': { file: 'server/capture.js', edits: [[
    '  if (openCaptures.size <= MAX_OPEN_CAPTURES) return;',
    '  if (true) return;',
  ]] },
  // The replay's handle goes back to being evictable.
  'replay-handle-evictable': { file: 'server/index.js', edits: [[
    '  capture.retain();',
    '  /* mutation: the replay holds no lease */',
  ]] },
  // The take file gets no hello, so the recording is complete and unopenable: its intrinsics
  // are unknown and nothing can unproject it.
  'recorder-skips-hello': { file: 'server/recorder.js', edits: [[
    '    stream.write(helloMessage);',
    '    /* mutation: the take begins at the first frame */',
  ]] },
  // A grabber restart no longer ends the take, so the next hello and a timestamp discontinuity
  // land in the middle of a take file - which every downstream consumer assumes cannot happen.
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
  // A name already taken disarms the recorder instead of stepping over it.
  'eexist-disarms': { file: 'server/recorder.js', edits: [[
    `        console.warn(\`[recorder] \${id} is already taken, trying the next name\`);
        floor = n;`,
    `        console.warn(\`[recorder] \${id} is already taken\`);
        this.armed = false;
        this.onChange(this.state);
        return;`,
  ]] },
  // The depth divisor strides the flat byte array instead of sampling per axis.
  'decimate-flat-stride': { file: 'server/capture.js', edits: [[
    `    for (let x = 0; x < w; x++) out.writeUInt16LE(payload.readUInt16LE(src + x * k * 2), dst + x * 2);`,
    `    for (let x = 0; x < w; x++) out.writeUInt16LE(payload.readUInt16LE(16 + ((y * w + x) * k) * 2), dst + x * 2);`,
  ]] },
  // The colour block is dropped from a decimated frame.
  'decimate-drops-colour': { file: 'server/capture.js', edits: [
    ['  out.writeUInt32LE(colorBytes, 4);', '  out.writeUInt32LE(0, 4);'],
    ['  payload.copy(out, 16 + w * h * 2, 16 + depthBytes);', '  /* mutation: colour dropped */'],
  ] },
  // The document version stops being checked, so a file whose point size is in the old unit
  // loads silently and draws 1.8x wrong at every output size.
  'accept-any-version': { file: 'web/main.js', edits: [[
    '  if (project.version !== PROJECT_VERSION) {',
    '  if (false) {',
  ]] },
  // The parked pool never reaches the file again, so a save drops what the clip could not load.
  'save-forgets-the-parked-pool': { file: 'web/main.js', edits: [
    [
      '      params: { ...values, ...parked.params },',
      '      params: { ...values },',
    ],
    [
      '        ...parked.tracks,\n      },',
      '      },',
    ],
  ],
    fails: 'a document opened on a machine without one of its effects and saved back with that '
      + 'effect\'s values gone, which is the destructive shape parking exists to prevent. '
      + 'Reddens 6: the reopen row, the two value rows, the row about which block each key '
      + 'came back in, the row asking what else is under the prefix, and the second-trip row. '
      + 'The requires row stays green - this mutation keeps the entry - and so do the two '
      + 'load rows, because the load half is untouched - read the rows',
  },
  // The pool stops recording which block a key arrived in, which is the one thing a build
  // without the effect cannot work out for itself.
  'park-forgets-its-block': { file: 'web/main.js', edits: [[
    '  const parked = {\n'
    + '    clip: { params: {}, tracks: {} },\n'
    + '    project: { params: {}, tracks: {} },\n'
    + '    requires: [],\n'
    + '  };',
    '  const oneBlock = { params: {}, tracks: {} };\n'
    + '  const parked = { clip: oneBlock, project: oneBlock, requires: [] };',
  ]],
    fails: 'which block each parked key arrived in, which is the one thing a build without the '
      + 'effect cannot work out for itself: the pool\'s two blocks become one object, so '
      + 'every parked key is saved into both. Reddens the which-block row alone - the value '
      + 'rows read across both blocks and still find everything',
  },
  // The other half of the same merge, with its own control because the row about the
  // `requires` entry stays green under the one above.
  'save-forgets-the-parked-requires': { file: 'web/main.js', edits: [[
    '    ...writableRequires(),\n  ];',
    '  ];',
  ]],
    fails: 'and the same merge\'s other half, keeping the values and dropping the claim. Reddens '
      + 'the entry row, the reopen row, and the second-trip row that stands on it',
  },
  // The version a document was authored against, compared with nothing.
  'skew-goes-unreported': { file: 'web/main.js', edits: [[
    '    .filter((e) => e.wanted !== e.installed);',
    '    .filter(() => false);',
  ]],
    fails: 'the version a document was authored against, compared with nothing, which is how it '
      + 'shipped. Reddens the two rows about the mismatched document - the hook and the '
      + 'sentence on the bar - and leaves the matched control green, since a build reporting '
      + 'nothing agrees with a correct one about a document with nothing to report',
  },
  // The completeness rule reading the values and not the tracks.
  'completeness-reads-the-values-only': { file: 'web/main.js', edits: [[
    '  for (const id of effectIdsIn(names).filter((n) => effectInstalled(n))) {',
    '  for (const id of effectIdsIn(Object.keys(block.params)).filter((n) => effectInstalled(n))) {',
  ]],
    fails: 'the per-effect completeness rule asked of the values and not the tracks, so a clip '
      + 'whose only use of an effect is a keyframe track loaded and was rewritten on save. '
      + 'Reddens the track-only refusal alone; the values-truncation row beside it stays '
      + 'green, because that document reaches the loop either way',
  },
  // The capture format's band comes off.
  'open-ignores-format': { file: 'web/format.js', edits: [[
    "  if (format === CAPTURE_FORMAT) return '';",
    "  return ''; /* mutation: every generation opens on this build's assumptions */",
  ]] },
  // The retime guard comes off the file door.
  'load-skips-monotonic': { file: 'web/main.js', edits: [[
    '    retime.assertMonotonic(keys);',
    '  /* mutation: the curve arrives unchecked */',
  ]] },
  // The quaternion length check comes off, which is the gap step 5 carried: four finite numbers
  // accepted as a rotation, and a camera move nobody authored.
  'accept-any-quaternion': { file: 'web/main.js', edits: [[
    '    if (Math.abs(len - 1) > 1e-3) {',
    '    if (false) {',
  ]] },
  // Track key values stop going through the registry on the way in, so the quaternion check
  // above is never reached by the door a hand-edited camera track actually comes through.
  'keys-bypass-registry': { file: 'web/main.js', edits: [[
    '      key.value = params.normalise(name, key.value);',
    '      /* mutation: the key value is taken as it arrived */',
  ]] },
  // `preset-through-setmode` was here and is deleted rather than re-anchored, because the bug
  // it planted can no longer be written.
  // Two edits because `path` is a const outside the queue closure now, and the redirect has to
  // land inside the serialised section. `const path = this.pathFor(name)` is in `remove` too, so
  // the first anchor carries the two lines below it to stay unique.
  'write-overwrites-builtin': { file: 'server/library.js', edits: [
    [`    const path = this.pathFor(name);
    return this.#serialise([name], async () => {
      await this.#heldToRev(name, rev, 'write');`,
    `    let path = this.pathFor(name);
    return this.#serialise([name], async () => {
      await this.#heldToRev(name, rev, 'write');`],
    [`      await mkdir(this.dir, { recursive: true });`,
    `      if (this.builtinDir) {
        const shipped = join(this.builtinDir, \`\${name}.json\`);
        try { await stat(shipped); path = shipped; } catch { /* not a shipped name */ }
      }
      await mkdir(this.dir, { recursive: true });`],
  ] },
  // Marks are drawn at their source fraction rather than through the retime curve, which is
  // identical at rate 1 with no keys and wrong everywhere else.
  'marks-ignore-retime': { file: 'web/main.js', edits: [[
    '\n    const program = programSecOfSource(mark.sourceMs / 1000);\n',
    '\n    const program = mark.sourceMs / 1000;\n',
  ]] },
  // The library skims a remote take at full resolution, promising a smoothness the
  // link does not have.
  'writes-take-any-method': { file: 'server/index.js', edits: [
    ['    if (!reading && r.write) {', '    if (r.write) {'],
    ['      if (!requireMutation(req, res, r.write.methods, r.write.contentType)) return true;',
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
  // The control for the enumeration itself: a mutating handler *added* in a `read` slot.
  'read-route-writes': { file: 'server/index.js', edits: [[
    "  { path: '/library/routes', pattern: /^\\/library\\/routes$/, read: serveRoutes },",
    "  { path: '/library/routes', pattern: /^\\/library\\/routes$/, read: serveRoutes },\n"
    + "  { path: '/library/sweep-probe', pattern: /^\\/library\\/sweep-probe$/, read: (req, res) => {\n"
    + "    PROJECTS.write('planted-by-a-read-route', { planted: true })\n"
    + '      .then(() => sendJson(res, { planted: true }), (err) => sendJson(res, { error: err.message }, 500));\n'
    + '  } },',
  ]] },
  // The plant a contents comparison cannot see, and the reason the write count is a row of its own.
  'read-route-restores': { file: 'server/index.js', edits: [[
    "  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },",
    "  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },\n"
    + "  { path: '/library/sweep-probe', pattern: /^\\/library\\/sweep-probe$/, read: async (req, res) => {\n"
    + "    await PROJECTS.write('planted-then-removed', { version: PROJECT_VERSION, clips: [], look: { params: {}, tracks: {} }, composition: { camera: [] }, outputSize: '1920x1080' });\n"
    + "    await PROJECTS.remove('planted-then-removed');\n"
    + '    sendJson(res, { restored: true });\n'
    + '  } },',
  ]] },
  // The plant that destroys the shoot.
  'plant-open-take': { file: 'server/index.js', edits: [
    ["  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },",
      "  { path: '/library/writes', pattern: /^\\/library\\/writes$/, read: serveWriteCounts },\n"
      + "  { path: '/library/sweep-probe', pattern: /^\\/library\\/sweep-probe$/, read: (req, res) => {\n"
      + '    recorder.take.stream.write(Buffer.alloc(65536, 0x07));\n'
      + '    sendJson(res, { appended: true });\n'
      + '  } },'],
  ] },
  // The other half of the captures directory: a read route unlinking a take that is closed.
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
  // A mutating handler *moved* behind a `read`.
  'health-answers-beside-the-table': {
    file: 'server/index.js',
    edits: [
      ["  { path: '/sensor/health', pattern: /^\\/sensor\\/health$/, read: serveSensorHealth },\n", ''],
      [
        '  let handledByTable = true;',
        '  if (urlPath === \'/sensor/health\') { serveSensorHealth(req, res); return; }\n'
        + '  let handledByTable = true;',
      ],
    ],
  },

  // The health window's reset goes back below the early return, so a five-second window that
  // carried no frames is never closed and `stats.since` keeps its value across the gap.
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

  // The library's poll loses its change gate, so every tick calls `refresh()`.
  'poll-refreshes-every-tick': { file: 'web/library.js', edits: [[
    '  if (!changed) return;\n', '',
  ]] },

  // The library's poll goes back to watching only the recorder on the machine serving the page.
  'pulse-ignores-the-node': { file: 'server/index.js', edits: [[
    '    node: node ? await node.recordState() : null,\n', '',
  ]] },

  // Every start of a grabber counts as a respawn again.
  'respawns-count-a-colour-toggle': { file: 'server/index.js', edits: [[
    'grabberRestarts++; ', '',
  ]] },

  // The requested restart is counted where it is learned rather than beside the spawn it
  // excuses, which is where it used to be.
  'respawns-dip-before-the-spawn': { file: 'server/index.js', edits: [[
    'setTimeout(() => { grabberRestarts++; spawnGrabber(); }, delay);',
    'grabberRestarts++;\n        setTimeout(spawnGrabber, delay);',
  ]] },

  // `openPath` goes back to answering only for the take currently being written.
  'openpath-drops-at-the-stop': { file: 'server/recorder.js', edits: [[
    'return this.take?.path ?? this.finalizing?.path ?? null;',
    'return this.take?.path ?? null;',
  ]] },

  // The library's poll goes back to a first tick that cannot disagree with anything.
  'poll-first-tick-is-blind': { file: 'web/library.js', edits: [[
    '}, believedFromLibrary());', '});',
  ]] },

  // The poll goes back to recording a tick as seen before the caller has managed to do
  // anything with it.
  'listing-never-times-out': { file: 'web/library.js', edits: [[
    'signal: bound ? AbortSignal.timeout(LISTING_TIMEOUT_MS) : undefined,',
    'signal: undefined,',
  ]] },

  // The bound goes back onto the first listing, where a cold library is slow for a legitimate
  // reason and fifteen seconds is not enough to build 200 indexes.
  'first-load-bounded': { file: 'web/library.js', edits: [[
    'try {\n  await refresh();\n} catch (err) {\n  say(`the media library could not be read',
    'try {\n  await refresh({ bound: true });\n} catch (err) {\n  say(`the media library could not be read',
  ]] },

  // The first listing goes back to being unguarded, so anything it throws ends module
  // evaluation before the poll is started and before the page has a hook to drive.
  'first-load-strands-the-page': { file: 'web/library.js', edits: [[
    'try {\n  await refresh();\n} catch (err) {\n'
    + '  say(`the media library could not be read: ${err.message}`);\n  paint();\n}',
    'await refresh();',
  ]] },

  // The listing goes back to being believed whatever the server said about it, which is where
  // it was until a JSON refusal was found walking straight past the catch above.
  'listing-takes-a-refusal-as-a-library': { file: 'web/library.js', edits: [[
    '  if (!res.ok || !Array.isArray(body?.takes)) {\n'
    + '    throw new Error(body?.error ?? `the media library could not be listed: HTTP ${res.status}`);\n'
    + '  }\n',
    '',
  ]] },

  // The cancellation goes back to watching the request rather than the response.
  'cancel-watches-the-consumed-request': { file: 'server/index.js', edits: [[
    "  res.on('close', () => ctl.abort());",
    "  res.req.on('close', () => ctl.abort());",
  ]] },

  // The node's manifest goes back to being trusted on two fields.
  'manifest-trusted-past-id-and-hash': { file: 'server/library.js', edits: [[
    '      for (const t of takes) {\n'
    + '        const why = manifestRefusal(t);\n',
    '      for (const t of []) {\n'
    + '        const why = manifestRefusal(t);\n',
  ]],
    fails: 'a peer\'s manifest checked on every field rather than on the two that reach a path, '
      + 'because the rest are spread into the listing and drawn. Reddens the field row and '
      + 'leaves the two build-gate rows green',
  },

  // The library goes back to ending a press only on `pointerup`, which is how it shipped: the
  // editor handles `pointercancel` in nine places and this page handled it in zero.
  'press-survives-a-cancelled-gesture': { file: 'web/library.js', edits: [[
    "  skimEl.addEventListener('pointercancel', () => { pressX = null; dragged = false; });\n",
    '',
  ]],
    fails: 'a press the browser took back, ended - the editor handles `pointercancel` in nine '
      + 'places and the library handled it in none. The tap row after it stays green',
  },

  // The library goes back to assigning whatever listing comes back last.
  'refresh-paints-a-stale-listing': { file: 'web/library.js', edits: [[
    '  if (mine !== refreshGeneration) return newestRefresh;\n',
    '',
  ]],
    fails: 'and a slow listing does not paint over a newer one, which is a second caller rather '
      + 'than the poll twice - the three rows above it stay green, and that is the split',
  },

  // The superseded caller goes back to reporting success on its own authority.
  'superseded-refresh-reports-success': { file: 'web/library.js', edits: [[
    '  if (mine !== refreshGeneration) return newestRefresh;\n',
    '  if (mine !== refreshGeneration) return undefined;\n',
  ]],
    fails: 'and the discarded caller is told the newer one\'s answer rather than a success of '
      + 'its own - the poll acts on that sentence, so a success nothing earned advanced its '
      + 'fingerprint past a transition no paint ever showed',
  },

  // The download stops asking the volume and goes back to asking only the node.
  'download-ignores-the-volume': { file: 'server/library.js', edits: [[
    '  const space = await remaining(dir);\n'
    + '  if (take.bytes > space.freeBytes - space.bytesPerSec * 60) {\n'
    + '    throw new Error(`downloading ${take.id}: it advertises ${take.bytes} bytes and the volume under `\n'
    + '      + `${dir} has ${space.freeBytes} free - refused before a byte moved, keeping a minute of `\n'
    + "      + 'recording headroom for the shoot this disk may be carrying');\n"
    + '  }\n',
    '',
  ]],
    fails: 'a download asked against the disk before a byte moves, because the byte ceiling '
      + 'holds the node to its claim and a truthful take larger than the free space breaks '
      + 'the shoot recording to the same volume',
  },

  // The signal put back where it shipped: after the directory walk rather than before it.
  'signal-bound-after-an-await': { file: 'server/index.js', edits: [
    [
      '  const left = untilCallerLeaves(res);\n  if (!node) {\n'
      + "    sendJson(res, { error: 'no capture node is linked' }, 409);",
      '  if (!node) {\n'
      + "    sendJson(res, { error: 'no capture node is linked' }, 409);",
    ],
    [
      '    const here = (await localTakes()).takes.find((t) => t.id === id);\n',
      '    const here = (await localTakes()).takes.find((t) => t.id === id);\n'
      + '    const left = untilCallerLeaves(res);\n',
    ],
  ],
    fails: 'and bound before the walk rather than after it, which is the shape three of the four '
      + 'routes shipped: every call site passes a signal and the presence row stays green, '
      + 'because what is wrong is when it was created. Reddens the ordering row alone - read '
      + 'the rows',
  },

  // The listing route stops telling the node that its caller has gone, so a browser that gave
  // up leaves the outbound fetch running here.
  'listing-ignores-client-abort': { file: 'server/index.js', edits: [[
    'await node.takes(left) : null;\n  const takes = reconcile(',
    'await node.takes() : null;\n  const takes = reconcile(',
  ]] },

  // Delete goes back to being offered while the node is unreachable, where the copy count it
  // rests on came from a manifest read that failed rather than from a node with nothing on it.
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

  // A caller asking during a tick gets the tick already in flight instead of a rerun - which is
  // the round-4 guard before it learned the difference between the two ways in.
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
  // separate declarations of one token invite.
  'faint-fixed-in-one-page': { file: 'web/library.html', edits: [[
    '    --faint: #828c99;', '    --faint: #6d7683;',
  ]] },

  'namespaces-hardcoded': { file: 'server/index.js', edits: [[
    'export const OWNED_NAMESPACES = new Set(ROUTES.map((r) => {',
    // Two parens are open at the anchor (`new Set(` and `ROUTES.map(`), so the replacement
    // leaves two open too or the file does not parse.
    "export const OWNED_NAMESPACES = new Set(['capture', 'library', 'projects', 'record']);\n"
    + 'const _unusedNamespaceDerivation = new Set([].map((r) => {',
  ]] },
  'stop-route-reads': { file: 'server/index.js', edits: [[
    "  { path: '/record/stop', pattern: /^\\/record\\/stop$/, write: { methods: ['POST'], run: serveRecordStop } },",
    "  { path: '/record/stop', pattern: /^\\/record\\/stop$/, read: serveRecordStop },",
  ]] },
  // The rebuild that arrow-browsing causes stops moving focus to the replacement.
  'viewer-drops-focus-on-rebuild': { file: 'web/library.js', edits: [[
    `  if (focusWas) {
    const same = findControl(viewer, focusWas);
    (same && !same.disabled ? same : freshMore).focus();
  }`,
    '  void focusWas;',
  ]] },
  // Hiding a menu stops putting focus back on the button that opened it.
  'menu-close-strands-focus': { file: 'web/library.js', edits: [[
    '    if (heldFocus && toggle && !toggle.disabled) toggle.focus();',
    '    void heldFocus;',
  ]] },
  // `run` stops putting focus back after the action it held the surface down for.
  'run-strands-focus': { file: 'web/library.js', edits: [[
    `    const back = findControl(host, wanted)
      ?? (host?.isConnected ? host.querySelector('[aria-haspopup="menu"]') : null);`,
    '    const back = null;',
  ]] },
  // The viewer goes back to deciding for itself, and gets one rule wrong.
  'viewer-decides-for-itself': { file: 'web/library.js', edits: [[
    '  paintActs(acts, take, hostOf);',
    "  paintActs(acts, { ...take, state: 'local' }, hostOf);",
  ]] },
  // Marks for a take that is not here, which created its sidecar in the captures directory out
  // of a caller's own JSON.
  'marks-without-a-take': { file: 'server/index.js', edits: [
    ['  const wasThere = takeIdentity(path);\n  if (wasThere === null) {\n    sendJson(res, { error: `no take ${id} here, so there is nothing to mark` }, 404);\n    return;\n  }',
      '  const wasThere = takeIdentity(path);'],
    ['  if (!sameTake(wasThere, takeIdentity(path))) {', '  if (false) {'],
  ] },
  // The document store restamps the version instead of checking it, so a project from a build
  // this one is not lands looking like one this build wrote.
  'store-restamps-version': { file: 'server/library.js', edits: [[
    '    if (body?.version !== undefined && body.version !== this.version) {',
    '    if (false) {',
  ]] },
  // A replay server records.
  'replay-can-record': { file: 'server/index.js', edits: [[
    '  cannotRecord: () => (REPLAY\n    ?', '  cannotRecord: () => (false\n    ?',
  ]] },
  // The demonstrated failure, whole: recording a replay is allowed *and* the replay hands
  // `handleMessage` a payload with no framing.
  'replay-records-a-bare-payload': { file: 'server/index.js', edits: [
    ['  cannotRecord: () => (REPLAY\n    ?', '  cannotRecord: () => (false\n    ?'],
    ['        handleMessage({ type: TYPE_FRAME, payload, raw: encodeMessage(TYPE_FRAME, payload) });',
      '        handleMessage({ type: TYPE_FRAME, payload });'],
  ] },
  // `forgetCapture` drops the map entry and leaves the descriptor to the collector, which on
  // this Node is a process death rather than an untidy count.
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
  // The flush moves out of the `finally`, so a close that rejects loses them - the second way
  // the same orphaning arrived.
  'close-rethrows-before-indexing': { file: 'server/recorder.js', edits: [[
    '      console.error(`[recorder] take ${take.id}: the file did not close cleanly (${err.message}) - indexing what landed`);',
    '      throw err;',
  ]] },
  // The write stream's backpressure is discarded again, so a stalling card becomes heap that
  // grows until the process is killed.
  'recorder-ignores-backpressure': { file: 'server/recorder.js', edits: [[
    '    if (take.stream.writableLength > MAX_TAKE_BUFFER) {', '    if (false) {',
  ]] },
  // The counters go back to reporting what was accepted rather than what drained, so the
  // monitor reads healthy for exactly as long as the failure is invisible.
  'recorder-counts-accepted': { file: 'server/recorder.js', edits: [[
    '  const written = take.stream.bytesWritten;', '  const written = take.accepted;',
  ]] },
  // The in-flight queue is drained only when something asks for state.
  'settle-drains-on-poll-only': { file: 'server/recorder.js', edits: [[
    '\n    settle(take);\n',
    '\n    /* mutation: the queue is drained only when something asks for state */\n',
  ]] },
  // The head advances and the array is never compacted.
  'settle-never-compacts': { file: 'server/recorder.js', edits: [[
    `  if (take.inFlightHead > 0 && take.inFlightHead * 2 >= take.inFlight.length) {
    take.inFlight.splice(0, take.inFlightHead);
    take.inFlightHead = 0;
  }`,
    '  /* mutation: the head moves and the array is never compacted */',
  ]] },
  // The transition into dropping goes back to being silent.
  'drop-transition-silent': { file: 'server/recorder.js', edits: [[
    '        this.onChange(this.state);\n      }\n      return;',
    '        /* mutation: the drop is left to the five-second poll */\n      }\n      return;',
  ]] },
  // The push moves out from behind the transition flag and fires per dropped frame, which is a
  // socket write in the frame path on the one machine that cannot afford one.
  'drop-transition-per-frame': { file: 'server/recorder.js', edits: [[
    `      take.dropped++;
      if (!take.stalling) {`,
    `      take.dropped++;
      this.onChange(this.state);
      if (!take.stalling) {`,
  ]] },
  // The buffer ceiling shrinks to an eighth.
  'ceiling-too-small': { file: 'server/recorder.js', edits: [[
    'export const MAX_TAKE_BUFFER = 64 * 1024 * 1024;',
    'export const MAX_TAKE_BUFFER = 8 * 1024 * 1024;',
  ]] },
  // The manifest scans the take being written, which is a full read and a sha256 of a growing
  // multi-gigabyte file per request, against the recorder's own disk.
  'manifest-scans-open-take': { file: 'server/library.js', edits: [[
    '  if (recording) {\n', '  if (false) {\n',
  ]] },
  // The boot stops making the captures directory, which is the state a reflashed node comes up in.
  'boot-without-captures-dir': { file: 'server/index.js', edits: [[
    '  mkdirSync(CAPTURES_DIR, { recursive: true });',
    '  /* mutation: the captures directory is assumed */',
  ]] },
  // Delete goes back to trusting the sidecar where reclaim re-hashes, so the irreversible
  // action carries the weaker check.
  'delete-trusts-sidecar': { file: 'server/library.js', edits: [[
    '  const actual = await hashFile(path);', '  const actual = (await cachedIndex(path)).hash;',
  ]] },
  // The decimation path stops checking that a frame's two declared lengths describe the frame,
  // so an overstated colour length returns the uninitialised tail of an `allocUnsafe` buffer.
  'decimate-skips-length-check': { file: 'server/capture.js', edits: [[
    '  if (16 + depthBytes + colorBytes !== payload.length) {', '  if (false) {',
  ]] },
  // The registry's door goes back to testing truthiness on an object literal, which accepts
  // every name on `Object.prototype`.
  'registry-gate-by-truthiness': { file: 'web/main.js', edits: [[
    '  if (!Object.hasOwn(PARAMS, name)) throw new Error(`unknown parameter ${JSON.stringify(name)}`);',
    '  if (!PARAMS[name]) throw new Error(`unknown parameter ${JSON.stringify(name)}`);',
  ]] },
  // The delete confirm promises to remove a copy the server refuses to remove.
  'confirm-promises-both-delete': { file: 'web/library.js', edits: [[
    "  const alsoOnNode = take.state === 'both';", '  const alsoOnNode = false;',
  ]] },
  // The listing goes back to reading every failure as an absent directory.
  'list-swallows-unreadable': { file: 'server/library.js', edits: [[
    "    if (required || err?.code !== 'ENOENT') {", '    if (required) {',
  ]] },
  // The editor goes back to swallowing a library that will not load, which is the empty picker
  // an operator gets told nothing about.
  'open-take-swallows-library': { file: 'web/main.js', edits: [[
    '    listed[what] = await refresh().catch((err) => { unavailable.push(`${what} (${err.message})`); return null; });',
    '    listed[what] = await refresh().catch(() => null);',
  ]] },
  // Every version older than this build gets one sentence again, so a document with no
  // conversion path is told the thing that is true of a document from the future.
  'one-refusal-for-older-versions': { file: 'web/format.js', edits: [[
    '    : version > PROJECT_VERSION', '    : false',
  ]],
    fails: 'one sentence for every version, which collapses the three bands `versionRefusal` '
      + 'still keeps now the migration is gone: older, later, and a version field that is not '
      + 'a number at all',
  },
  'skim-ignores-state': { file: 'web/take-draw.js', edits: [[
    'const DIVISOR = { local: 1, both: 1, remote: 4 };',
    'const DIVISOR = { local: 1, both: 1, remote: 1 };',
  ]] },


  // The warnings go back under the poster as text.
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
  // The poster's height goes back into JavaScript, assigned once from the width it measured
  // on the first fit.
  'poster-height-in-js': { file: 'web/take-draw.js', edits: [[
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
  // A depth sample goes back to covering exactly one pixel however large the canvas is.
  'viewer-splat-one': { file: 'web/take-draw.js', edits: [[
    '  const splat = Math.max(1, Math.round(scale / fxFull));',
    '  const splat = 1;',
  ]] },
  // The way out to the menu goes away again. Aimed at `toMenu` alone and not at the whole bar:
  // the surface links beside it lead to the other page rather than out, so removing them would
  // redden a different claim than the one this control is named for.
  'library-has-no-way-to-the-menu': { file: 'web/library.html', edits: [[
    '  <a class="appback" id="toMenu" href="/"><span class="arrow">&lt;</span><span>Menu</span></a>',
    '  <!-- mutation: no way back -->',
  ]] },
  // The falsification control for the enumeration, and the only mutation here that is not a
  // bug being put back.
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

  // The hash gate and the marks are separate rows for the reason the grade terms are
  // in `export-check`.
  'rename-ignores-hash': { file: 'server/library.js', edits: [[
    '  if (index.hash !== hash) {',
    '  if (false) {',
  ]] },
  // The marks log is left behind at the old name, where nothing lists it and nothing will ever
  // look for it again - the take arrives at its new name with no marks and no error.
  'rename-orphans-marks': { file: 'server/library.js', edits: [[
    '  const marksMoved = await linkInto(marksPathFor(from), marksPathFor(target));',
    '  const marksMoved = false;',
  ]] },
  // The rename goes back to `rename(2)`.
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
  // The take being recorded becomes renameable.
  'rename-during-a-shoot': { file: 'server/library.js', edits: [[
    '  if (recordingPath !== null && resolve(from) === resolve(recordingPath)) {',
    '  if (false) {',
  ]] },

  // The path is dropped from the arguments, so the file manager is started on nothing - a route
  // that answers 200 having done something that is not what it says.
  'reveal-drops-the-path': { file: 'server/library.js', edits: [REVEAL_EDIT] },
  // The library page goes back to composing its own refusal.
  'open-decides-its-own-reason': { file: 'web/library.js', edits: [[
    "const cannotOpen = (take) => take.openRefusals[0]?.why ?? '';",
    'const cannotOpen = (take) => {\n'
      + '  if (take.recording === true) return warningsOf(take)[0].why;\n'
      + "  if (take.hasHello === false) return 'this take carries no sensor hello, so its intrinsics are unknown';\n"
      + "  if (take.frames !== null && take.frames < 2) return 'a take needs two frames to bracket a position';\n"
      + "  return '';\n"
      + '};',
  ]] },
  // The media picker goes back to naming the causes it knows about, which is the same fault the
  // library's half of this pair guards. It moved here from `web/menu.html` when the EDITOR tile
  // went: the menu stopped composing a refusal sentence at all, and the picker started - it draws
  // the library's warning badges now, so it is the second surface that has to quote the server
  // rather than write its own copy. The class is every surface that badges a refusal, and it has
  // two members again.
  'picker-decides-its-own-reason': { file: 'web/take-picker.js', edits: [[
    "  return take.openRefusals[0]?.why ?? '';",
    '  if (take.recording === true) return warningsOf(take)[0].why;\n'
      + "  if (take.hasHello === false) return 'this take carries no sensor hello, so its intrinsics are unknown';\n"
      + "  if (take.frames !== null && take.frames < 2) return 'a take needs two frames to bracket a position';\n"
      + "  return '';",
  ]],
    fails: 'the picker\'s note quoting the server, in the refusal section: the picker is opened '
      + 'from /projects, the tile of a take the server refuses is pressed, and the sentence on '
      + '.tp-note is held against the one the library put on its own button. Reddens that row '
      + 'alone - the badge row beside it reads the chip\'s title, which this edit does not touch',
  },
  // A refusal the server declares and no page can badge.
  'refusal-without-a-badge': { file: 'server/library.js', edits: [[
    'export const OPEN_REFUSALS = {\n',
    'export const OPEN_REFUSALS = {\n'
      + "  'wrong-format': () => 'this take was written by a generation of the format this build cannot read',\n",
  ]] },
  // The badge table goes back to having a prototype, which is where it was and which answers
  // `BADGES['__proto__']` with `Object.prototype` instead of `undefined`.
  'badges-inherit-from-object': { file: 'web/library.js', edits: [
    ['const BADGES = Object.assign(Object.create(null), {\n', 'const BADGES = {\n'],
    // Anchored with the last entry above it, because `});` alone appears throughout the page
    // and `mutatedSource` requires a match exactly once.
    ["  short: (take) => (take.frames === 0 ? 'no frames' : '< 2 frames'),\n});",
      "  short: (take) => (take.frames === 0 ? 'no frames' : '< 2 frames'),\n};"],
  ] },
  // The scanner forgets to push a refusal it declares.
  'refusal-declared-but-never-pushed': { file: 'server/library.js', edits: [[
    "  if (!index.hello) openRefusals.push(refusal('no-hello'));\n",
    '',
  ]] },
  // The take being written goes back to answering twice, which is where it was: the list on one
  // line and a hardcoded `openable: false` on the next.
  'recording-decides-openable-itself': { file: 'server/library.js', edits: [
    ["    const openRefusals = [refusal('recording')];", '    const openRefusals = [];'],
    ['      openRefusals,\n      openable: openRefusals.length === 0,\n      recording: true,',
      '      openRefusals,\n      openable: false,\n      recording: true,'],
  ] },
  // The capture-format band goes back to being a term in `openable` rather than a refusal in
  // the list, which is the shape it arrived from `main` in and the shape the merge changed.
  'openable-recomputes-the-band': { file: 'server/library.js', edits: [
    ["  if (captureFormatRefusal('this take', format) !== '') openRefusals.push(refusal('format', format));\n", ''],
    ['    openRefusals,\n    openable: openRefusals.length === 0,\n    recording: false,',
      '    openRefusals,\n'
      + "    openable: Boolean(index.hello) && stamps.length >= 2 && captureFormatRefusal('this take', format) === '',\n"
      + '    recording: false,'],
  ] },
  // One dimension of the grid stops being a literal while the other holds.
  'grid-loses-a-dimension': { file: 'web/format.js', edits: [[
    'export const DEPTH_H = 424;',
    'export const DEPTH_H = DEPTH_W - 88;',
  ]] },
  // The link demands that every take name a refusal.
  'refusals-must-be-nonempty': { file: 'server/library.js', edits: [[
    'const carriesRefusals = (take) => Array.isArray(take.openRefusals)\n',
    'const carriesRefusals = (take) => Array.isArray(take.openRefusals)\n  && take.openRefusals.length > 0\n',
  ]],
    fails: 'and a healthy node not refused for being healthy (wide: takes the link off, so it '
      + 'stops at 125 of 392 - read the rows, not the total. docs/instruments.md says why)',
  },
  // The link admits a manifest from the build before the refusals moved.
  'node-admits-an-old-manifest': { file: 'server/library.js', edits: [[
    '      const older = takes.find((t) => !carriesRefusals(t));\n      if (older) {',
    '      const older = takes.find((t) => !carriesRefusals(t));\n      if (false) {',
  ]] },

  // The same gate on the other route goes away: a `/record/state` with no `writingId` in it is
  // read as a recorder that owns no take, which is what `??
  'node-admits-an-old-record-state': { file: 'server/library.js', edits: [[
    '      const missing = POLLED_NODE_FIELDS.filter((f) => body[f] === undefined);',
    '      const missing = POLLED_NODE_FIELDS.filter((f) => body[f] === undefined) && [];',
  ]] },
  // The monitor's cost line goes back to spelling the grid out inline, which is where it was
  // for as long as the comment above it promised the opposite.
  'grid-declared-twice': { file: 'web/main.js', edits: [[
    '  const depthKB = Math.ceil(DEPTH_W / state.divisor) * Math.ceil(DEPTH_H / state.divisor) * 2 / 1000;',
    '  const depthKB = Math.ceil(512 / state.divisor) * Math.ceil(424 / state.divisor) * 2 / 1000;',
  ]] },
  // The same second declaration, spelled so a search for the digits cannot see it.
  'grid-declared-in-another-spelling': { file: 'web/main.js', edits: [[
    '  const depthKB = Math.ceil(DEPTH_W / state.divisor) * Math.ceil(DEPTH_H / state.divisor) * 2 / 1000;',
    '  const depthKB = Math.ceil(0x200 / state.divisor) * Math.ceil(4.24e2 / state.divisor) * 2 / 1000;',
  ]] },
  // A grid dimension declared with no leading digit, which a search for the digits misses.
  'grid-declared-with-a-leading-dot': { file: 'web/main.js', edits: [[
    '  const depthKB = Math.ceil(DEPTH_W / state.divisor) * Math.ceil(DEPTH_H / state.divisor) * 2 / 1000;',
    '  const depthKB = Math.ceil(.512e3 / state.divisor) * Math.ceil(.424e3 / state.divisor) * 2 / 1000;',
  ]] },
  // The loopback gate comes off the one route in this program that starts a process, so a
  // browser across the link opens a window on a machine nobody is standing at.
  'reveal-answers-any-caller': { file: 'server/index.js', edits: [[
    '  if (!isLoopback(req)) {\n    const { label } = revealSupport();',
    '  if (false) {\n    const { label } = revealSupport();',
  ]] },

  // The exit handler stops nulling the reference.
  // The only anchor in this table that still quotes a comment, and it cannot be helped: the
  // `error` handler and the `exit` handler both end on the same `if (child === proc)` line, and
  // the code either side of it is comments. One line of the comment below picks the exit one.
  'exit-keeps-the-child-reference': { file: 'server/index.js', edits: [[
    '      if (child === proc) child = null;\n      // The hello goes with',
    '      // The hello goes with',
  ]] },


  // A hole in a shipped look, which is the defect itself: `voxel` stops naming `bloom`, so
  // picking it after a look that raised the bloom leaves the bloom where it was.
  'shipped-look-drops-a-value': { file: 'presets-builtin/voxel.json', edits: [[
    '    "bloom": 0.45,\n', '',
  ]] },
  // A fit that reads the take's first frame and calls it the take.
  'extent-reads-one-frame': { file: 'server/capture.js', edits: [[
    'for (let n = 0; n < capture.frameCount; n += EXTENT_FRAME_STRIDE) {',
    'for (let n = 0; n < capture.frameCount; n += Math.max(1, capture.frameCount)) {',
  ]] },
  // And a cache that keys on the take and not on the range it was asked about.
  'extent-cache-ignores-the-range': { file: 'server/index.js', edits: [[
    'const key = `${capture.index.hash}|${near}|${far}`;',
    'const key = `${capture.index.hash}`;',
  ]] },
  // And the other side of the comparison: the definition, narrowed by one group.
  'complete-look-drops-a-group': { file: 'web/main.js', edits: [[
    'const coreLookNames = () => presetValueNames().filter((name) => effectOf(name) === null);',
    "const coreLookNames = () => presetValueNames()\n  .filter((name) => PARAMS[name].group !== 'post' && effectOf(name) === null);",
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
// The URL a page file is served at, which is not its filename.
const PAGE_URLS = { 'library.html': '/library', 'menu.html': '/', 'projects.html': '/projects' };
const urlForPageFile = (file) => PAGE_URLS[file] ?? `/${file}`;
const serverMutation = mutation && mutation.file.startsWith('server/') ? mutation : null;
// A mutation of one of the twelve documents the picker offers, which is the third kind of file
// this tree stages and the only one that is data rather than code.
const documentMutation = mutation && mutation.file.startsWith('presets-builtin/') ? mutation : null;

// A file of the staged tree as this run actually ships it. One read, because there is one
// delivery: a second way of producing these bytes is a second thing to keep in step.
const shippedSource = (rel) => readFileSync(join(root, rel), 'utf8');

// Every number a piece of JavaScript states as code, by value.
const numbersIn = (src) => {
  const values = [];
  // One entry per literal we are inside, innermost last.
  const stack = [];
  const inTemplate = () => stack[stack.length - 1]?.kind === 'template';
  let depth = 0;
  // The last significant character and the last identifier, which together decide the `/` question.
  let prev = '';
  let prevWord = '';
  let i = 0;
  // The decimal form has two shapes because JavaScript does: digits first, or a leading dot.
  const NUM = /^(?:0[xX][\dA-Fa-f](?:_?[\dA-Fa-f])*|0[oO][0-7](?:_?[0-7])*|0[bB][01](?:_?[01])*|\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?(?:[eE][+-]?\d(?:_?\d)*)?|\.\d(?:_?\d)*(?:[eE][+-]?\d(?:_?\d)*)?)n?/;
  // The words after which a `/` is a pattern and never a quotient.
  const REGEX_AFTER = new Set(['return', 'throw', 'case', 'yield', 'typeof', 'instanceof',
    'in', 'of', 'delete', 'void', 'new', 'do', 'else', 'await']);
  // What may begin and continue a name, taken from the language rather than described.
  const ID_START = /[\p{ID_Start}$_]/u;
  // The two joiners are written as escapes on purpose - they are zero-width, and a character
  // class nobody can see the contents of is one nobody can review.
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
  // An identifier taken whole, because the `/` question below is about the previous token:
  // `n` ends a word and a word ends a value, which gets `return /512/` wrong.
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
  // `++` and `--` are transparent to the value question, so they are taken two at a time:
  // one `+` at a time leaves `prev` as `+`, which is not the end of a value.
    if ((c === '+' || c === '-') && src[i + 1] === c) { i += 2; continue; }
    // A regex only where a value cannot already have ended - or after one of the words that
    // cannot be followed by division.
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
  // A finished regex is a value. Leaving `prev` as the slash that closed it read the second
  // slash of `/x/ / 512` as another opener and swallowed the number.
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
    // digit behind it.
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
      const [token] = NUM.exec(src.slice(i));
  // Legacy octal, read as octal: `01000` is 512 to a browser and 1000 to `Number`.
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

// Every take here is built rather than downloaded, so its shape is a decision this file
// makes and can name.
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

// Writes a take. `frames` is a count, `withHello` decides whether the sensor record is there
// at all, and `truncate` cuts the last message in half so the scan has something to report.
function writeTake(dir, id, { frames = 8, withHello = true, truncate = false, startedAt = null, format = null } = {}) {
  const parts = [];
  if (withHello) {
  // The wall-clock capture date, which the frame stamps cannot supply: they are `steady_clock`,
  // monotonic since boot, right for frame spacing and useless for sorting a library.
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

// A take whose cloud is narrow in its first frame and wide in every frame after it.
const PLANTED_WALL_MM = 2000;
function writeWideningTake(dir, id, frames = 24) {
  const grid = DEPTH_W * DEPTH_H;
  const wall = (fromCol, toCol) => {
    const depth = new Uint16Array(grid);
    for (let row = 0; row < DEPTH_H; row++) {
      for (let col = fromCol; col < toCol; col++) depth[row * DEPTH_W + col] = PLANTED_WALL_MM;
    }
    // A frame payload is the two lengths, the capture stamp and the depth block.
    const payload = Buffer.alloc(16 + depth.byteLength);
    payload.writeUInt32LE(depth.byteLength, 0);
    payload.writeUInt32LE(0, 4);
    Buffer.from(depth.buffer).copy(payload, 16);
    return encodeMessage(TYPE_FRAME, payload);
  };
  const narrow = wall(Math.round(DEPTH_W * 5 / 12), Math.round(DEPTH_W * 7 / 12));
  const wide = wall(0, DEPTH_W);
  const parts = [encodeMessage(TYPE_HELLO, SRC.hello), narrow];
  for (let i = 1; i < frames; i++) parts.push(wide);
  const path = join(dir, `${id}.knct`);
  writeFileSync(path, Buffer.concat(parts));
  return path;
}

// A take whose second frame declares more colour bytes than it carries.
function writeBadLengthTake(dir, id) {
  const good = SRC.frames[0];
  const bent = Buffer.from(good);
  // The framing is untouched, so the scan walks the file cleanly and indexes the frame - which
  // is what makes this a bad *frame* rather than a bad file.
  const payloadAt = 12;
  const colorBytes = bent.readUInt32LE(payloadAt + 4);
  bent.writeUInt32LE(colorBytes + 4096, payloadAt + 4);
  const body = Buffer.concat([encodeMessage(TYPE_HELLO, SRC.hello), SRC.frames[1], bent, SRC.frames[2]]);
  const path = join(dir, `${id}.knct`);
  writeFileSync(path, body);
  return path;
}

const markLine = (rec) => `${JSON.stringify(rec)}\n`;

// A run of frame payloads for the deterministic drive.
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

  // The take both machines hold, under different filenames.
  writeTake(macCaps, 'mac-name-for-it', { frames: 12, startedAt: Date.UTC(2026, 6, 14, 9, 30) });
  writeTake(nodeCaps, 'node-name-for-it', { frames: 12, startedAt: Date.UTC(2026, 6, 14, 9, 30) });

  // The same *filename* on both machines with different bytes.
  writeTake(macCaps, 'same-name', { frames: 6 });
  writeTake(nodeCaps, 'same-name', { frames: 9 });

  // Local only, and the take everything that needs a real clip uses.
  writeTake(macCaps, 'local-clip', { frames: 60, startedAt: Date.UTC(2026, 6, 15, 18, 5) });

  // The take whose cloud widens after its first frame - see `writeWideningTake` for why it is
  // written rather than found.
  writeWideningTake(macCaps, 'widening-take', 24);

  // The shapes the library has to survive rather than the shapes it likes.
  writeTake(macCaps, 'truncated-take', { frames: 6, truncate: true, startedAt: false });
  writeTake(macCaps, 'no-hello-take', { frames: 6, withHello: false });
  writeTake(macCaps, 'one-frame-take', { frames: 1 });
  // A hello, and no whole frame - the one shape that could tell the library's two openability
  // sentences apart, and the take nobody planted.
  writeTake(macCaps, 'hello-no-frames', { frames: 1, truncate: true });
  writeBadLengthTake(macCaps, 'bad-length-take');
  // Three warnings at once, which is the tile the height rows need and none of the takes above is.
  writeTake(macCaps, 'three-warning-take', { frames: 1, withHello: false, truncate: true });

  // Both ends of the capture format's band, and the second one is why there are two.
  writeTake(macCaps, 'future-format-take', { frames: 6, format: CAPTURE_FORMAT + 1 });
  writeTake(macCaps, 'generation-zero-take', { frames: 6 });

  // Mark counts the tile renders differently.
  writeFileSync(join(macCaps, 'local-clip.marks.jsonl'),
    markLine({ id: 'k0', sourceMs: 0, label: 'first frame', at: 1000 })
    + markLine({ id: 'k1', sourceMs: 1200, label: 'the drop', at: 1000 })
    + markLine({ id: 'k2', sourceMs: 3400, label: 'turn', at: 1000 })
    + markLine({ id: 'kBeyond', sourceMs: 900000, label: 'past the end', at: 1000 }));
  writeFileSync(join(macCaps, 'same-name.marks.jsonl'),
    markLine({ id: 'only', sourceMs: 500, label: 'sole mark', at: 1000 }));
  // The node's log for the shared take, which the download has to merge: one mark the mac has
  // never seen, one the mac will supersede, and one already tombstoned.
  writeFileSync(join(nodeCaps, 'node-name-for-it.marks.jsonl'),
    markLine({ id: 'n1', sourceMs: 700, label: 'node mark', at: 1000 })
    + markLine({ id: 'n2', sourceMs: 900, label: 'to be moved', at: 1000 })
    + markLine({ id: 'n3', sourceMs: 1100, label: 'doomed', at: 1000 })
    + markLine({ id: 'n3', deleted: true, at: 2000 }));

  return { nodeCaps, macCaps };
}

// Spawned out of a copy of `server/` with `web`, `node_modules` and `vendor` symlinked beside
// it, so a server-side mutation is a file in a scratch tree rather than an edit to the repo.
function stageServer() {
  const root = join(WORK, 'root');
  mkdirSync(root, { recursive: true });
  cpSync(join(REPO, 'server'), join(root, 'server'), { recursive: true });
  // `web` is copied where the other two are symlinked.
  cpSync(join(REPO, 'web'), join(root, 'web'), { recursive: true });
  // The looks that ship, inside the staged tree where the default `presets-builtin` resolves to.
  cpSync(join(REPO, 'presets-builtin'), join(root, 'presets-builtin'), { recursive: true });
// The effects that ship. The effect store refuses to BOOT on a missing builtin root rather
// than answering an empty list, so a broken install cannot read as a tree with no effects.
  cpSync(join(REPO, 'effects-builtin'), join(root, 'effects-builtin'), { recursive: true });
  for (const name of ['node_modules', 'vendor']) {
    const from = join(REPO, name);
    if (existsSync(from) && !existsSync(join(root, name))) symlinkSync(from, join(root, name));
  }
  // This is the one place a mutation is delivered, whichever side of the wire it is on.
  if (mutation) {
    writeFileSync(join(root, mutation.file), mutation.body);
  }
  // The second staging of the shipped looks, where `--builtin-presets` points the mac server.
  cpSync(join(root, 'presets-builtin'), join(WORK, 'builtin-presets'), { recursive: true });
  return root;
}

const servers = [];
// Servers whose offset has since been claimed by another section.
const retired = [];
// Everything this run started, which is what anything sweeping rather than looking up wants.
const everyServer = () => [...servers, ...retired];
let serversStarted = 0;

// Whether something already holds a port, asked of the kernel rather than of a fetch.
const portHeld = (port) => new Promise((done) => {
  const sock = createConnection({ host: '127.0.0.1', port });
  const settle = (held) => { sock.destroy(); done(held); };
  sock.on('connect', () => settle(true));
  sock.on('error', () => settle(false));
  setTimeout(() => settle(false), 400);
});

// Refuses the run when any port this suite will bind is already taken.
async function reservePorts() {
  // The node's port inside the mac span is a configuration this cannot serve, and the `new Set`
  // below used to swallow it: both ports are free, every check passes, and the run starts.
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
  // A port outside the declared span would not have been checked by `reservePorts`, so it is
  // the one thing that could still attach to a stranger.
  if (port !== NODE_PORT && (port < MAC_PORT || port > MAC_PORT + PORT_SPAN)) {
    throw new Error(`port ${port} is outside the reserved span ${MAC_PORT}..${MAC_PORT + PORT_SPAN}: `
      + 'raise PORT_SPAN and the note beside it, or this server is one nothing checked was free');
  }
  // An offset this run has used before belongs to whoever is on it now, and the entry for the
  // last holder is dropped rather than left beside the new one.
  const stale = servers.findIndex((s) => s.port === port);
  if (stale !== -1) retired.push(...servers.splice(stale, 1));
  const child = spawn(process.execPath, [join(root, 'server/index.js'), '--port', String(port), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  child.stdout.on('data', (c) => log.push(c.toString()));
  child.stderr.on('data', (c) => log.push(c.toString()));
  // Our own child failing is a different answer from nothing listening yet.
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

// The backstop for every way out that does not reach the `finally`.
process.on('exit', stopServers);

// Refuses the run when a page mutation did not reach the browser, and it is exit 2 rather than
// a failed assertion.
async function requireMutationDelivered(base) {
  if (documentMutation) { await requireDocumentDelivered(base); return; }
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
  // `Buffer.byteLength` and not `.length`: a JavaScript string is counted in UTF-16 code units
  // and every page here is served as UTF-8.
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

// The same refusal for a mutation of a shipped look, which arrives as a document rather than as
// a file the browser fetches.
async function requireDocumentDelivered(base) {
  const name = basename(documentMutation.file, '.json');
  const url = `${base}/presets/${name}`;
  const want = `sha256:${createHash('sha256').update(documentMutation.body).digest('hex')}`;
  let served = null;
  let status = null;
  try {
    const res = await fetch(url);
    status = res.status;
    served = await res.json();
  } catch (err) {
    served = null;
    status = err.message;
  }
  if (served?.rev === want && served?.builtin === true) {
    console.log(`[library] ${MUTATE} delivered: ${url} serves the mutated ${basename(documentMutation.file)} `
      + `(${Buffer.byteLength(documentMutation.body)} bytes, ${want.slice(7, 19)})`);
    return;
  }
  console.error(`[library] refusing to run: ${MUTATE} edits ${documentMutation.file} and ${url} did not answer with it.`);
  console.error(`[library] the server answered ${status} with rev ${served?.rev?.slice(7, 19) ?? 'nothing'} `
    + `and builtin=${served?.builtin}, where the staged document hashes to ${want.slice(7, 19)}.`);
  console.error('[library] a document mutation that does not arrive leaves the shipped look unmutated under a '
    + 'completeness arm that then passes, which reads as this tool having missed a bug it was never shown - so the '
    + 'run stops here rather than reporting one. Either the shipped looks stopped being copied out of the staged '
    + 'tree, or a fork of this name is shadowing the built-in root.');
  process.exit(2);
}

// Waits until a frame has actually come off the sensor, and answers how long it took.
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

// A real filesystem with a few megabytes on it, or null where this tool does not know
// how to make one.
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
    // Forced only as a second attempt, so a volume still held by a server this tool failed to
    // stop is not hidden by the force.
        try { execFileSync('hdiutil', ['detach', mount, '-force', '-quiet']); } catch { /* gone already */ }
      }
    },
  };
}

// Whether a line in a server's log means this run went wrong.
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

// The predicate's own falsification control, run before anything else so a sweep that has been
// quietly blinded says so in the first three lines rather than by passing a mutated tree.
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
  // Named on its own, because this is the one the old predicate dropped and the reason it
  // dropped it was two independent failures agreeing.
  check(looksFatal('[recorder] cannot open /caps/take1.knct: ENOTDIR: not a directory - recording is off'),
    'including `[recorder] cannot open`, which the old allowlist excluded by name and the old pattern could not have matched anyway');
}

const getJson = async (url, init) => (await fetch(url, init)).json();
// The method is a parameter because the document routes take three of them and the difference
// is the behaviour under test.
const post = (url, body, method = 'POST') => getJson(url, {
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

// Every document write carries the revision it was made against, and a write carrying none at all
// is refused - so a fixture staged without one is a section that never runs. The revision is read
// off the listing rather than off the name, because a read of a name with no file behind it is a
// 404 this run then has to explain, and `absent` is what a create claims.
const revOf = async (base, kind, name) => {
  const listed = await getJson(`${base}/${kind === 'projects' ? 'projects/all' : kind}`);
  return (listed[kind] ?? []).find((doc) => doc.name === name)?.rev ?? 'absent';
};
const writeDoc = async (base, kind, name, body, method = 'PUT') => {
  const rev = await revOf(base, kind, name);
  return getJson(`${base}/${kind}/${encodeURIComponent(name)}?rev=${encodeURIComponent(rev)}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === null ? {} : { body: JSON.stringify(body) }),
  });
};
// The same read, for the page-side writes that fetch relative to their own origin.
const REV_IN_PAGE_INSTALL = () => {
  globalThis.__rev = async (kind, name) => {
    const listed = await (await fetch(kind === 'projects' ? '/projects/all' : `/${kind}`)).json();
    return (listed[kind] ?? []).find((doc) => doc.name === name)?.rev ?? 'absent';
  };
};


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

// Playwright drops the page's execution context on this rig, and it is not the code:
// `docs/instruments.md` records it as a measured flake. Retried on that signature alone and
// with the count printed, because a check that retried real failures would report whichever
// attempt it liked.
async function retryOnContextLoss(label, work) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await work();
    } catch (err) {
      // Two messages, because the renderer going away here arrives under both.
      const lost = /Execution context was destroyed|Resulting promise was garbage collected/.test(String(err));
      if (!lost || attempt === 3) throw err;
      console.log(`  ...  ${label}: the page went away, retrying (attempt ${attempt + 1} of 3)`);
    }
  }
  throw new Error('unreachable');
}

// The four pages, named once each rather than at the call sites below. Each spelling has to be
// the URL `PAGES` serves it at and not its filename, because a page mutation is delivered by
// fetching the page's own URL - `PAGE_URLS` above is the same fact written for the delivery.
const recorderPage = (base) => `${base}/record`;
const editorPage = (base, take) => `${base}/edit?take=${encodeURIComponent(take)}`;
const libraryPage = (base) => `${base}/library`;
const projectsPage = (base) => `${base}/projects`;

async function openPage(browser, url, viewport = { width: 1100, height: 760 }) {
  const page = await browser.newPage({ viewport });
  // Installed on every page this file opens rather than at the four sites that write a document,
  // because a write missing its revision is refused and a fixture that never landed is a section
  // that never ran.
  await page.addInitScript(REV_IN_PAGE_INSTALL);
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  return { page, errors };
}


console.log(`[library] ${MUTATE ? `MUTATED: ${MUTATE} (${mutation.file})` : 'unmutated tree'}`);

await reservePorts();
const { nodeCaps, macCaps } = buildFixture();
const root = stageServer();
const nodeUrl = await startServer(root, ['--captures', nodeCaps, '--name', 'pi-01',
  '--presets', join(WORK, 'node-presets'), '--projects', join(WORK, 'node-projects')], NODE_PORT);
  // `--builtin-presets` named explicitly rather than left to resolve beside the staged server,
  // so the shipped-look rows sit on a directory the flag chose.
const macUrl = await startServer(root, ['--captures', macCaps, '--name', 'mac',
  '--node', nodeUrl, '--node-name', 'pi-01',
  '--presets', join(WORK, 'presets'), '--projects', join(WORK, 'projects'),
  '--builtin-presets', join(WORK, 'builtin-presets')], MAC_PORT);

  // When this process last had a server with no sensor come up. Read by the sensor-health
  // section, which asserts a five-second window closes at five seconds rather than growing.
const bootedAt = Date.now();

// Before a browser opens anything, so a mutation that cannot arrive costs a server spawn rather
// than a full run ending in a verdict about the wrong build.
await requireMutationDelivered(macUrl);

const { chromium } = await loadPlaywright();
const browser = await chromium.launch({ headless: !HEADED, args: ['--use-gl=angle', '--use-angle=default'] });

try {
  await runChecks();
} catch (err) {
    // Recorded rather than thrown: an exception out of here used to end the process with no
    // verdict line and no assertion count, which reads as a caught mutation to a caller.
  console.log(`\n  FAIL  the run did not finish: ${err.message}`);
  assertions++;
  failures++;
} finally {
  await browser.close();
  stopServers();
}

// The verdict, and a skipped claim reaches all three of it: the count line, the word, and the
// status this process exits with.
const note = skipped.length ? `, ${skipped.length} claim${skipped.length === 1 ? '' : 's'} unproven here (${skipped.join(', ')})` : '';
if (failures) console.log(`\n[library] ${assertions} assertions, ${failures} failed${note}`);
else console.log(`\n[library] ${assertions} assertions, none failed${note}`);
const verdict = failures ? `FAIL (${failures})`
  : skipped.length ? `PASS WITH ${skipped.length} CLAIM${skipped.length === 1 ? '' : 'S'} UNPROVEN HERE (${skipped.join('; ')})`
    : 'PASS';
console.log(`[library] ${verdict}`);
if (MUTATE && MUTATIONS[MUTATE]?.fails) console.log(`[library] it should redden: ${MUTATIONS[MUTATE].fails}`);
process.exit(failures ? 1 : skipped.length ? 2 : 0);

async function runChecks() {
  checkLogPredicate();

  console.log('\n[library] the sensor grid is declared once, and the tree is what says so');
  {
    // Every numeric literal, compared by value, which `numbersIn` above is the scan for.
    const declares = (source, n) => numbersIn(source).includes(n);

    // The JavaScript in a file, because this is a claim about JavaScript.
    const JS_MIME = new Set([
      'application/ecmascript', 'application/javascript', 'application/x-ecmascript',
      'application/x-javascript', 'text/ecmascript', 'text/javascript', 'text/javascript1.0',
      'text/javascript1.1', 'text/javascript1.2', 'text/javascript1.3', 'text/javascript1.4',
      'text/javascript1.5', 'text/jscript', 'text/livescript', 'text/x-ecmascript',
      'text/x-javascript',
    ]);
    const SCRIPT = /<script\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/script>/gi;
    // Anchored on an attribute boundary and not on `\b`.
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
    // Relative paths under `base`, deepest last, as one flat list.
    const sourcesUnder = (base, dir, prefix = '') => readdirSync(join(base, dir), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => (entry.isDirectory()
        ? sourcesUnder(base, `${dir}/${entry.name}`, `${prefix}${entry.name}/`)
        : [`${dir}/${entry.name}`]));

    const probeRoot = join(REPO, '.library-check', 'grid-probe');
    rmSync(probeRoot, { recursive: true, force: true });
    mkdirSync(join(probeRoot, 'web', 'nested', 'deeper'), { recursive: true });
    writeFileSync(join(probeRoot, 'web', 'flat.js'), 'export const NOTHING = 1;\n');
    writeFileSync(join(probeRoot, 'web', 'near-misses.js'),
      'export const WIDE = 1512;\nexport const SMALL = 4.24;\nexport const HEX = 0x201;\n');
    writeFileSync(join(probeRoot, 'web', 'nested', 'buried.js'), 'export const W = 512;\n');
    writeFileSync(join(probeRoot, 'web', 'nested', 'hexadecimal.js'), 'export const W = 0x200;\n');
    // Two forms that the scan needs a token for rather than a character.
    writeFileSync(join(probeRoot, 'web', 'nested', 'edge-forms.js'),
      'export const W = .512e3;\n'
      + 'export const rows = () => { return /424/; };\n'
      + 'export const step = (counter) => counter++ / 512;\n'
      + 'export const ratio = /x/ / 512;\n'
      // And a name the ASCII classes cannot finish reading.
      + 'export const perRow = (pixelsπ) => pixelsπ / 512;\n');
    writeFileSync(join(probeRoot, 'web', 'nested', 'deeper', 'further.js'), 'export const H = 424;\n');
    writeFileSync(join(probeRoot, 'web', 'nested', 'deeper', 'scientific.js'), 'export const H = 4.24e2;\n');
    writeFileSync(join(probeRoot, 'web', 'nested', 'literals.js'),
      "export const A = 'expected 512 bytes';\n"
      + 'export const B = "a 424-line budget";\n'
      + "export const C = 'it\\'s 512 wide, they said';\n"
      + '// a comment saying 512 and 424\n'
      + 'export const D = `the grid is 512 by 424`;\n'
      + 'export const E = `computed ${424} rows`;\n');
    // A page and a stylesheet, which is what the tree actually holds beside the modules.
    writeFileSync(join(probeRoot, 'web', 'page.html'),
      '<p>the sensor is 512 across and 424 down, which this paragraph says and does not declare</p>\n'
      + '<style>.tile { width: 512px; height: 424px; }</style>\n'
      + '<script type="importmap">{"imports":{"x":"/x-512-424.js"}}</script>\n'
      + '<script type="module">const W = 512;</script>\n');
    writeFileSync(join(probeRoot, 'web', 'sheet.css'), '.rail { height: 424px; width: 512px; }\n');
  // A second page whose executable code is under a `type` nobody writes any more.
    writeFileSync(join(probeRoot, 'web', 'legacy-page.html'),
      '<script type="application/x-javascript; charset=utf-8">const H = 424;</script>\n'
      + '<script type=text/javascript defer>const H2 = 424;</script>\n'
      + '<script data-type="application/json">const H3 = 424;</script>\n'
      + '<script>const H4 = 0650;</script>\n'
      // An attribute whose value contains the character that ends a start tag.
      + '<script data-note=">">const H5 = 424;</script>\n'
      + '<script type="application/json">{"width": 512}</script>\n');
    const walked = sourcesUnder(probeRoot, 'web');
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

  console.log('\n[library] the manifest carries step 2\'s hash, and stops carrying a stale one');
  {
    const { buildIndex } = await import(pathToFileURL(join(REPO, 'server/capture.js')).href);
    const takes = (await getJson(`${macUrl}/library/takes`)).takes;
    const byId = Object.fromEntries(takes.map((t) => [t.id, t]));

    // The scan, run here, against the manifest the server produced.
    let agreed = 0;
    for (const take of takes) {
      const scanned = await buildIndex(join(macCaps, take.file));
      if (scanned.hash === take.hash && scanned.frames.offset.length === take.frames) agreed++;
    }
    check(agreed === takes.length,
      `every take's manifest hash and frame count is what a fresh scan produces (${agreed}/${takes.length})`);

    const before = byId['same-name'].hash;
    // A whole extra frame rather than arbitrary bytes.
    appendFileSync(join(macCaps, 'same-name.knct'), SRC.frames[0]);
    const after = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'same-name');
    const rescanned = await buildIndex(join(macCaps, 'same-name.knct'));
    check(after.hash !== before, 'a take whose bytes changed is not served from a stale manifest',
      `${before.slice(7, 19)} then ${after.hash.slice(7, 19)}`);
    check(after.hash === rescanned.hash, 'and the hash it reports is the one the changed bytes actually have');

    check(byId['truncated-take'].truncated === true,
      'a take cut mid-frame is reported truncated - step 2 computed this flag and nothing read it until now');
    check(byId['local-clip'].truncated === false, 'and a whole take is not');
    check(byId['no-hello-take'].hasHello === false && byId['no-hello-take'].openable === false,
      'a take with no hello lists, and says it cannot be opened');
    check(byId['one-frame-take'].frames === 1 && byId['one-frame-take'].openable === false,
      'a one-frame take lists, and says it cannot be bracketed');
    check(byId['local-clip'].openable === true, 'and an ordinary take is openable');
    check(byId['hello-no-frames'].hasHello === true && byId['hello-no-frames'].frames === 0,
      'a take can carry a hello and no whole frame at all, which is the shape the two client derivations disagreed about',
      `hasHello=${byId['hello-no-frames'].hasHello} frames=${byId['hello-no-frames'].frames}`);
    check(byId['future-format-take'].format === CAPTURE_FORMAT + 1
      && byId['future-format-take'].openable === false,
      'a take from a format this build does not read lists, says which generation wrote it, and says it cannot be opened',
      `format ${JSON.stringify(byId['future-format-take'].format)}, openable ${byId['future-format-take'].openable}`);
    check(byId['generation-zero-take'].format === null
      && byId['generation-zero-take'].openable === true,
      'while a take whose hello declares no format at all is generation zero and opens, which is the whole existing archive',
      `format ${JSON.stringify(byId['generation-zero-take'].format)}, openable ${byId['generation-zero-take'].openable}`);
    check(byId['local-clip'].format === null && byId['no-hello-take'].format === null,
      'and the field is null rather than absent on a take that carries no answer, so the page has one thing to read');
    // The band arrives as a refusal and not only as a false `openable`.
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

  console.log('\n[library] one library, joined by content hash and never by name');
  {
    const lib = await getJson(`${macUrl}/library/all`);
    const byId = Object.fromEntries(lib.takes.map((t) => [t.id, t]));
    check(lib.node?.reachable === true, `the node is linked (${lib.node?.name})`);

    const shared = lib.takes.filter((t) => t.state === 'both');
    check(shared.length === 1 && shared[0].id === 'mac-name-for-it',
      'the same bytes under two different filenames are one take, in state both',
      shared.map((t) => t.id).join(' '));

    const sameName = lib.takes.filter((t) => t.id === 'same-name');
    check(sameName.length === 2 && new Set(sameName.map((t) => t.hash)).size === 2,
      'the same filename holding different bytes is two takes, not one',
      `${sameName.length} entries, ${new Set(sameName.map((t) => t.state)).size} states`);
    check(sameName.some((t) => t.state === 'local') && sameName.some((t) => t.state === 'remote'),
      'and they resolve to different states rather than collapsing');

    check(byId['local-clip'].state === 'local' && byId['node-name-for-it'] === undefined,
      'a take only here is local, and the node\'s name for a shared take is not a second entry');
    check(lib.takes.some((t) => t.state === 'remote'), 'a take only over there is remote');

    check(/^(\d+h \d+m|\d+m \d+s|\d+s|unbounded)$/.test(lib.storage.label),
      `remaining space is reported as time, not bytes (${lib.storage.label})`);
    check(lib.storage.secondsLeft > 0 && Number.isFinite(lib.storage.bytesPerSec),
      'and it is a duration derived from a rate rather than a byte count');
  }

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
    // The manifest the build before this one served, field for field.
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
    // And the take that carries none, which is nearly every take there is.
    const openableShape = {
      ...oldShape,
      id: 'openable-on-this-build',
      hash: `sha256:${'ef'.repeat(32)}`,
      frames: 60,
      durationSec: 4,
      openable: true,
      openRefusals: [],
    };

    const scriptish = '<img src=x onerror="globalThis.__owned = true">';
    const hostileShapes = [
      ['frames', { ...openableShape, id: 'markup-in-frames', frames: scriptish }],
      ['marks', { ...openableShape, id: 'markup-in-marks', marks: { length: scriptish } }],
      ['durationSec', { ...openableShape, id: 'markup-in-duration', durationSec: scriptish }],
      ['dateSource', { ...openableShape, id: 'a-date-source-that-is-not-one', dateSource: scriptish }],
      ['hello', { ...openableShape, id: 'a-hello-that-is-not-intrinsics', hello: { fx: scriptish, fy: 1, cx: 1, cy: 1 } }],
      // The key as markup rather than as a key this build has not heard of - a node one build.
      ['open refusal', { ...openableShape, id: 'a-refusal-key-that-is-markup', openRefusals: [{ key: scriptish, why: 'x' }] }],
      ['open-refusal list', { ...openableShape, id: 'a-refusal-list-that-is-not-one', openRefusals: { length: scriptish } }],
    ];

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

      // The other arm, and the row is unfalsifiable without it.
      const currentLink = new NodeLink(current.url, 'current-node');
      const currentTakes = await currentLink.takes();
      check(eq((currentTakes ?? []).map((t) => t.id), ['shot-on-this-build', 'openable-on-this-build']),
        'a manifest that carries them passes, so the gate is a version band rather than the link switched off',
        `${currentTakes === null ? 'null' : currentTakes.map((t) => t.id).join(' ')}, error ${JSON.stringify(currentLink.lastError)}`);
      check(currentTakes?.some((t) => t.id === 'openable-on-this-build' && t.openRefusals.length === 0),
        'and an openable take, whose refusal list is correctly empty, is not read as a manifest with none',
        currentTakes === null ? `the whole manifest was refused: ${currentLink.lastError}` : 'it came through');

      const admitted = [];
      for (const [field, shape] of hostileShapes) {
        const link = new NodeLink((await stub([shape])).url, `hostile-${field}`);
        const got = await link.takes();
        if (got !== null) admitted.push(`${field} came through`);
        else if (!new RegExp(field).test(link.lastError ?? '')) {
          admitted.push(`${field} was refused without being named: ${link.lastError}`);
        }
      }
      check(admitted.length === 0,
        'a node manifest is refused whole when any field is not the thing it is meant to be, and the refusal names the field',
        admitted.length ? admitted.join('; ') : `${hostileShapes.length} fields, each refused by name`);

      const mixedUrl = await startServer(root, ['--captures', macCaps, '--name', 'mac', '--node', old.url,
        '--node-name', 'old-node', '--presets', join(WORK, 'presets'), '--projects', join(WORK, 'projects'),
        '--builtin-presets', join(WORK, 'builtin-presets')], MAC_PORT + 1);
      const { page, errors } = await openPage(browser, libraryPage(mixedUrl));
      // Waited for behind a catch, because this is the arm the mutation kills.
      const painted = await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 })
        .then(() => true).catch(() => false);
      const tiles = painted ? await page.evaluate('globalThis.__library.tiles()') : [];
      check(painted && tiles.length > 0 && errors.length === 0,
        'the library beside an older node still draws this machine\'s own takes, with no page error',
        `${painted ? `${tiles.length} tiles` : 'the page never finished painting'}, ${errors.length} errors: ${errors.join(' | ')}`);
      check(tiles.length > 0 && tiles.every((t) => t.state !== 'remote'),
        'and nothing from that node is on the shelf, because a shelf missing some of them silently is the worse answer',
        `${tiles.length} tiles, ${tiles.filter((t) => t.state === 'remote').length} of them remote`);
      const line = await page.evaluate('document.getElementById("note")?.textContent ?? ""');
      check(/old-node/.test(line) && /older build/.test(line),
        'and the page names the node and says its build is the reason', JSON.stringify(line));
      await page.close();
      for (const p of servers.filter((sv) => sv.port === MAC_PORT + 1)) p.child.kill('SIGKILL');

      // The gate is on the shape of a manifest and deliberately not on its vocabulary.
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
        const { page: aheadPage, errors: aheadErrors } = await openPage(browser, libraryPage(aheadUrl));
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

  // The manifest gate asks `/library/takes` about its build, which a contents
  // comparison cannot see.
      const twoRoute = (recordState) => new Promise((done) => {
        const srv = createServer((req, res) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(req.url.startsWith('/record/state')
            ? recordState()
            : { takes: [newShape, openableShape] }));
        });
        srv.listen(0, '127.0.0.1', () => done({ srv, url: `http://127.0.0.1:${srv.address().port}` }));
      });
      // Written out rather than derived by deleting a key from the current one.
      let served = { recording: false, takeId: null };
      const behind = await twoRoute(() => served);
      const carries = await twoRoute(() => ({ recording: false, takeId: null, writingId: null }));
      try {
        const blind = new NodeLink(behind.url, 'behind-node');
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

        // The other arm, and the rows above are unfalsifiable without it.
        const well = new NodeLink(carries.url, 'carrying-node');
        const wellPolled = await well.recordState();
        check(wellPolled.reachable === true && wellPolled.writingId === null,
          'a node carrying the field and simply not writing is not refused for it, so the gate reads absence rather than an idle recorder',
          `reachable ${wellPolled.reachable}, writingId ${JSON.stringify(wellPolled.writingId)}`);
        check(Array.isArray(await well.takes()),
          'and its takes still list, so this is a version band rather than the poll switched off',
          `${well.lastError === null ? 'no error' : well.lastError}`);

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

  console.log('\n[library] the decimation parameter: one mechanism, three callers');
  {
    const sizes = {};
    const bodies = {};
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

    // A frame whose two declared lengths do not describe the frame.
    const bentUrl = `${macUrl}/capture/bad-length-take/frame/1`;
    const bent = await fetch(`${bentUrl}?decimate=4`);
    check(bent.status >= 400,
      'a frame whose declared lengths overrun the payload is refused rather than sampled past',
      `${bent.status} ${(await bent.text()).slice(0, 80)}`);
    const beside = await fetch(`${bentUrl.replace('/frame/1', '/frame/0')}?decimate=4`);
    check(beside.ok, 'while the sound frames beside it in the same take still decimate',
      `frame 0 came back ${beside.status}`);
    const verbatim = await fetch(bentUrl);
    check(verbatim.ok, 'and the undecimated read still returns the bytes the file holds, unchanged',
      `frame 1 undecimated came back ${verbatim.status}`);

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
    check(Buffer.compare(bodies[4].subarray(16 + sizes[4].depthBytes),
      bodies[1].subarray(16 + sizes[1].depthBytes)) === 0,
      'and the colour block is byte for byte the frame\'s own');

    for (const bad of ['0', '17', '1.5', 'lots']) {
      const res = await fetch(`${macUrl}/capture/local-clip/frame/4?decimate=${bad}`);
      check(res.status === 400, `a divisor of ${bad} is refused rather than clamped`, `status ${res.status}`);
    }
  }

  console.log('\n[library] where a take\'s cloud reaches, over the whole take');
  {
    const extentOf = async (id, near, far) => {
      const res = await fetch(`${macUrl}/capture/${id}/extent?near=${near}&far=${far}`);
      return { status: res.status, body: res.status === 200 ? await res.json() : null };
    };

    const wide = await extentOf('widening-take', 0.05, 6);
    check(wide.status === 200 && wide.body?.x !== null,
      'the planted take answers with a lateral extent, so the rows below are reading one',
      `status ${wide.status}, ${wide.body?.samples ?? 0} samples over ${wide.body?.frames ?? 0} frames`);

    const hello = JSON.parse(SRC.hello.toString('utf8'));
    const atCol = (col) => (-(col + 0.5 - hello.cx) / hello.fx) * (PLANTED_WALL_MM / 1000);
    const narrowEdge = Math.abs(atCol(Math.round(DEPTH_W * 5 / 12)));
    const wideEdge = Math.abs(atCol(0));
    check(wide.body?.x && Math.abs(wide.body.x[1]) > narrowEdge * 2,
      'and it reaches past the first frame\'s wall, so the scan covered more than frame zero',
      `x [${wide.body?.x?.map((v) => v.toFixed(2)).join(', ')}] against a first frame that `
      + `stops at +/-${narrowEdge.toFixed(2)}m and later frames that reach +/-${wideEdge.toFixed(2)}m`);

    check(wide.body?.y && Math.abs(wide.body.y[0]) > 0.5 && Math.abs(wide.body.y[1]) > 0.5,
      'while the vertical extent is the same in every frame, so the row above is about coverage',
      `y [${wide.body?.y?.map((v) => v.toFixed(2)).join(', ')}]`);

    // The range is an input and the cache has to key on it.
    const shut = await extentOf('widening-take', 0.05, 1.5);
    check(shut.status === 200 && shut.body?.x === null && shut.body?.samples === 0,
      'a range with no points inside it answers with nothing rather than the last range\'s box',
      `status ${shut.status}, ${shut.body?.samples} samples, x ${JSON.stringify(shut.body?.x)}`);

    const again = await extentOf('widening-take', 0.05, 6);
    check(eq(again.body, wide.body),
      'and the range it was computed for comes back unchanged when it is asked for again',
      `${JSON.stringify(again.body?.x)} against ${JSON.stringify(wide.body?.x)}`);

    for (const [query, why] of [
      ['', 'names no range at all'],
      ['?near=0.05', 'names only a near plane'],
      ['?near=3&far=1', 'puts its far plane in front of its near one'],
      ['?near=lots&far=6', 'names a range that is not a number'],
    ]) {
      const res = await fetch(`${macUrl}/capture/widening-take/extent${query}`);
      check(res.status === 400, `a request that ${why} is refused rather than given a default`,
        `status ${res.status}`);
    }
    const missing = await fetch(`${macUrl}/capture/no-such-take/extent?near=0.05&far=6`);
    check(missing.status === 404, 'and a take that is not here is a 404 like every other capture route',
      `status ${missing.status}`);
  }

  console.log('\n[library] skimming a directory does not evict the replay out from under itself');
  {
    // Enough takes that an unbounded map is unmistakably over the cap.
    const many = join(WORK, 'many-captures');
    mkdirSync(many, { recursive: true });
    for (let i = 0; i < 80; i++) writeTake(many, `bulk-${String(i).padStart(3, '0')}`, { frames: 3 });
    // The replayed take lives outside the directory being skimmed.
    const replaySource = join(WORK, 'replay-source');
    mkdirSync(replaySource, { recursive: true });
    const replaying = writeTake(replaySource, 'replayed-take', { frames: 40 });
    const manyUrl = await startServer(root,
      ['--captures', many, '--name', 'bulk', '--replay', replaying], MAC_PORT + 2);

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
    // The status list is deliberately *not* cleared here.
    const framesAtSkim = seen.frames;
    await new Promise((done) => { setTimeout(done, 1500); });
    const framesAfter = seen.frames - framesAtSkim;
    ws.close();

    check(after <= 27, 'eighty takes skimmed leave the open-capture map bounded',
      `${before} before, ${after} after, cap 24 plus the retained replay`);
    check(after < 80, 'and the bound does not track the number of takes touched');
    check(framesAfter > 0, 'and the replay is still streaming afterwards - its descriptor survived',
      `${framesAfter} frames in the 1.5s after the skim`);
    check(!seen.statuses.includes('lost'),
      'with no lost-sensor report at any point, which is how a closed handle presents itself',
      seen.statuses.length ? `saw ${seen.statuses.join(' ')}` : 'no status changes');
  }

  console.log('\n[library] a take is a file, and a restart splits it');
  {
    const recDir = join(WORK, 'recorded');
    mkdirSync(recDir, { recursive: true });
    // A decoy at the name the recorder would otherwise reach for first.
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
    // Waited until the recorder has *closed* three takes, not until the library lists three.
    const closedSoFar = () => [...servers.find((s) => s.port === MAC_PORT + 4).log.join('')
      .matchAll(/\[recorder\] take (\S+) closed/g)].length;
    for (let i = 0; i < 90; i++) {
      if (closedSoFar() >= 3) break;
      await new Promise((done) => { setTimeout(done, 500); });
    }
    check(closedSoFar() >= 3, 'the writer ran, died and was respawned enough times to split three takes',
      `${closedSoFar()} closed`);
    // Closed takes only, and the recorder's own log is what says so.
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
    check(scanned.every((t) => t.frameCount === EMITTED),
      `and every frame the writer emitted is in it (${EMITTED} each)`,
      scanned.map((t) => `${t.file}:${t.frameCount}`).join(' '));
    check(scanned.every((t) => t.stamps.every((v, i) => i === 0 || v > t.stamps[i - 1])),
      'with strictly ascending timestamps, which a run across a restart seam would break');
    check(scanned.every((t) => Number.isFinite(t.hello?.startedAt)),
      'the hello carries a wall clock, which the frame stamps cannot supply');
    check(scanned.every((t, i) => i === 0 || t.hello?.startedAt > scanned[i - 1].hello?.startedAt),
      'and it advances take to take, so a library can sort by when it was shot',
      scanned.map((t) => t.hello?.startedAt ?? 'none').join(' '));

    const listed = (await getJson(`${recUrl}/library/takes`)).takes;
    const byFile = Object.fromEntries(listed.map((t) => [t.file, t]));
    check(scanned.every((t) => byFile[t.file]?.frames === EMITTED && byFile[t.file]?.dateSource === 'hello'),
      'and each closed take is a library entry, scanned, hashed and dated off its own hello');
    check(new Set(scanned.map((t) => byFile[t.file]?.hash)).size === scanned.length,
      'every take has its own hash, so nothing shares a library entry',
      scanned.map((t) => String(byFile[t.file]?.hash).slice(7, 15)).join(' '));
    for (const p of servers.filter((s) => s.port === MAC_PORT + 4)) p.child.kill('SIGKILL');
  }

  console.log('\n[library] mark flags the moment while it is still happening');
  {
    const markDir = join(WORK, 'marking');
    mkdirSync(markDir, { recursive: true });
    const markUrl = await startServer(root, [
      '--captures', markDir, '--name', 'shooting', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
    ], MAC_PORT + 5);
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
    const listed = (await getJson(`${markUrl}/library/takes`)).takes.find((t) => t.id === stopped?.id);
    check(listed?.marks?.length === 1 && listed.marks[0].label === 'the moment',
      'and the mark is on the take in the library, not inside the capture',
      JSON.stringify(listed?.marks));
    check(listed?.marks?.[0]?.sourceMs > 0 && listed.marks[0].sourceMs < listed.durationSec * 1000 + 500,
      'stamped inside the footage it flags rather than at an arbitrary offset',
      listed?.marks?.[0] ? `${listed.marks[0].sourceMs}ms into ${(listed.durationSec * 1000).toFixed(0)}ms` : 'no mark landed');
    check(Boolean(stopped?.id) && existsSync(join(markDir, `${stopped.id}.marks.jsonl`)),
      'in an append-only sidecar beside the take, which is byte-identical to what the writer produced');
    for (const p of servers.filter((s) => s.port === MAC_PORT + 5)) p.child.kill('SIGKILL');
  }

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
      // Restored before anything reads the directory again.
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
    check((clashLog.match(/is already taken/g) ?? []).length === 2,
      'and the log agrees, with two refusals - corroboration for the take3 row above, which is what carries the claim',
      `${(clashLog.match(/is already taken/g) ?? []).length} refusals in the log`);
  }

  console.log('\n[library] a take that cannot fit never starts');
  {
    const room = await smallFilesystem();
    if (!room) {
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

  console.log('\n[library] a colour toggle during the respawn backoff does not eat the next failure');
  {
    const supDir = join(WORK, 'supervised');
    mkdirSync(supDir, { recursive: true });
    const supUrl = await startServer(root, [
      '--captures', supDir, '--name', 'supervised', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --die-after 24 --burst 10 --fps 40`,
    ], MAC_PORT + 1);
    const supLog = () => servers.find((s) => s.port === MAC_PORT + 1).log.join('');
    const countIn = (text, re) => [...text.matchAll(re)].length;
    const EXITED = /\[server\] grabber exited/g;
    const BACKOFF = /\[server\] restarting grabber in \d+ms \(attempt \d+\)/g;

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

    let died = false;
    for (let i = 0; i < 1500 && !died; i++) {
      await new Promise((done) => { setTimeout(done, 20); });
      died = countIn(supLog(), EXITED) >= 1;
    }
    check(died, 'the grabber handshook, streamed and died unrequested, which is the failure the backoff exists for',
      `${countIn(supLog(), EXITED)} exits`);

    // Everything after this point is counted from here.
    const statusesBefore = statuses.length;
    const backoffBefore = countIn(supLog(), BACKOFF);
    const spawnsBefore = countIn(supLog(), /\[server\] starting grabber:/g);
    ws.send(JSON.stringify({ camera: { color: true } }));
    // Whether the message landed in the window is the instrument's own question.
    const spawnsAtToggle = countIn(supLog(), /\[server\] starting grabber:/g);
    check(spawnsAtToggle === spawnsBefore && spawnsBefore === 1,
      'and the toggle was sent while nothing was running - between the exit and the respawn, which is the window the whole section is about',
      `${spawnsAtToggle} spawns at the toggle, ${countIn(supLog(), EXITED)} exits`);

    // The next genuine death: a respawn, a hello, a burst, and an exit nobody asked for.
    for (let i = 0; i < 1500 && countIn(supLog(), EXITED) < 2; i++) {
      await new Promise((done) => { setTimeout(done, 20); });
    }
    await new Promise((done) => { setTimeout(done, 400); });
    ws.close();

    // The read has to land on the second death and not on a third.
    const exitsAtRead = countIn(supLog(), EXITED);
    check(exitsAtRead === 2,
      'and exactly one further death has happened when the reading is taken, so this is the next failure rather than a later one',
      `${exitsAtRead} exits`);
    console.log(`  ...   ${supLog().match(/\[server\] colour camera .*/)?.[0] ?? 'no colour line in the log at all'}`);

    // Both rows below assert a shape rather than a presence.
    const after = statuses.slice(statusesBefore);
    // The broken build emits a `lost` of its own the instant the toggle calls `stopGrabber`.
    const liveAfter = after.indexOf('live');
    check(liveAfter >= 0 && after.indexOf('lost', liveAfter) > liveAfter,
      'the next failure is still reported lost, rather than being read as the restart the toggle never got to ask for',
      after.length ? `saw ${after.join(' ')}` : 'no status changes at all');
    // One backoff line per death, rather than more lines than before.
    const backoffAtRead = countIn(supLog(), BACKOFF);
    check(backoffAtRead === exitsAtRead,
      'and it still counts toward the backoff, which is the table a machine with no sensor has to be able to spend',
      `${backoffAtRead} backoff lines against ${exitsAtRead} deaths, ${backoffBefore} before the toggle`);
    for (const p of servers.filter((s) => s.port === MAC_PORT + 1)) p.child.kill('SIGKILL');
  }

  console.log('\n[library] the tiles: states, marks, buttons and the skim');
  {
    const { page, errors } = await openPage(browser, libraryPage(macUrl));
    await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const tiles = await page.evaluate('globalThis.__library.tiles()');
    const byId = Object.fromEntries(tiles.map((t) => [t.hash, t]));
    const idOf = (id) => tiles.filter((t) => t.id === id);
    const one = (id) => { const hits = idOf(id); return byId[hits.find((t) => t.state !== 'remote')?.hash ?? hits[0].hash]; };

    // Skimming is a pointer affordance and the library also runs on a touch panel.
    const labels = (t) => t.acts.map((a) => a.label);
    const items = (t) => t.acts.map((a) => a.item);
    const newProjectOn = (id) => one(id).acts.find((a) => a.item === 'new-project');
    check(tiles.every((t) => t.acts.length >= 2),
      `every tile carries its actions without hover (${tiles.length} tiles)`);
    check(tiles.filter((t) => t.state === 'remote').every((t) => labels(t).includes('Download')),
      'a remote tile offers Download');
    // Found by `item` and not by `label`: the act that mints a document is `new-project` and its
    // copy has already moved once, from `Open` - which said nothing about which of the two things
    // it did. A row keyed to the words goes quiet the next time somebody rewords a button.
    check(tiles.filter((t) => t.state === 'local').every((t) => items(t).includes('new-project')),
      'a local tile offers New project from this take');
    check(tiles.every((t) => labels(t).includes('Delete')), 'every tile offers Delete');
    check(tiles.filter((t) => t.state !== 'both').every((t) => !labels(t).includes('Reclaim')),
      'and Reclaim appears only where a second copy exists');

    check(newProjectOn('no-hello-take')?.disabled === true,
      'New project on a take with no hello is disabled rather than a throw waiting to happen');
    check(newProjectOn('local-clip')?.disabled === false,
      'and an ordinary take can be made into one');
    check(newProjectOn('future-format-take')?.disabled === true,
      'New project on a take from a format this build cannot read is disabled the same way');
    check(newProjectOn('generation-zero-take')?.disabled === false,
      'while a take that declares no format at all still offers it');

    // One take, one reason, whichever surface is asking.
    const refused = one('hello-no-frames');
    const badgeWhy = refused.badges.find((b) => b.key === 'short')?.why ?? '';
    const buttonWhy = refused.acts.find((a) => a.item === 'new-project')?.why ?? '';
    check(badgeWhy !== '' && badgeWhy === buttonWhy,
      'a take with a hello and no whole frame is refused in one sentence, the same on its badge and on its button',
      `badge ${JSON.stringify(badgeWhy)} vs button ${JSON.stringify(buttonWhy)}`);
    check(/no whole frame/.test(buttonWhy) && !/bracket a position/.test(buttonWhy),
      'and it is the sentence about the frame it does not have rather than the one about bracketing a position',
      JSON.stringify(buttonWhy));

    // The second surface that badges a refusal, and the reason there has to be one is in
    // `docs/instruments.md`: the refusal moved to the server so that one take gets one sentence
    // everywhere, and a control mutating a single surface left the other one's hard-coded copy
    // uncaught. The menu used to be that second surface and no longer composes a sentence at all;
    // the media picker draws the library's warning badges now, so the class has two members again
    // and this is the member's row. Driven through `/projects`, because the picker is built when
    // it opens and removed when it closes - there is nothing in the markup at rest to read.
    {
      const { page: picker, errors: pickerErrors } = await openPage(browser, projectsPage(macUrl));
      await picker.waitForFunction('globalThis.__projects !== undefined', null, { timeout: 20000 });
      await picker.evaluate('globalThis.__projects.newProject()');
      await picker.waitForSelector('#takePicker .tp-tile[data-take="hello-no-frames"]', { timeout: 20000 });
      const pickerSays = await picker.evaluate(`(() => {
        const tile = document.querySelector('#takePicker .tp-tile[data-take="hello-no-frames"]');
        tile.querySelector('.tp-meta').click();
        return {
          note: document.querySelector('#takePicker .tp-note').textContent,
          pressed: tile.getAttribute('aria-pressed'),
          disabled: tile.getAttribute('aria-disabled'),
          flags: [...tile.querySelectorAll('.tp-flag')].map((f) => ({ key: f.dataset.flag, why: f.title })),
          go: document.querySelector('#takePicker .tp-act.go').disabled,
        };
      })()`);
      check(pickerSays.note === buttonWhy,
        'the media picker refuses the same take in the same sentence the library put on its button, '
        + 'word for word rather than in a copy of its own',
        `picker ${JSON.stringify(pickerSays.note)} against button ${JSON.stringify(buttonWhy)}`);
      check(!/no sensor hello, or under two frames/.test(pickerSays.note ?? ''),
        'and not in a sentence naming both causes over a take that has one of them',
        JSON.stringify(pickerSays.note));
      check(pickerSays.pressed === 'false' && pickerSays.disabled === 'true' && pickerSays.go === true,
        'and the press said why instead of picking it, so the sentence above is a refusal rather '
        + 'than a note beside a take that went in anyway',
        `pressed ${pickerSays.pressed}, disabled ${pickerSays.disabled}, confirm ${pickerSays.go ? 'off' : 'on'}`);
      // The badge over the poster is the other half of the same rule: the chip's own title is the
      // server's sentence, so a build that quoted the server on the note and composed its own on
      // the badge fails here rather than passing on the row above.
      const badged = pickerSays.flags.find((f) => f.key === 'short');
      check(badged !== undefined && badged.why === badgeWhy,
        'and the warning chip over its poster carries the same sentence, which is the badge half '
        + 'of the rule rather than the note half',
        badged === undefined ? `flags ${JSON.stringify(pickerSays.flags.map((f) => f.key))}`
          : `chip ${JSON.stringify(badged.why)} against badge ${JSON.stringify(badgeWhy)}`);
      check(pickerErrors.length === 0, 'and the picker raises no page error drawing it', pickerErrors.join(' | '));
      await picker.close();
    }

    // Every refusal the server can send has a badge on the page.
    const { OPEN_REFUSALS } = await import(pathToFileURL(join(root, 'server/library.js')).href);
    const badgeKeys = await page.evaluate('globalThis.__library.badgeKeys()');
    const serverKeys = Object.keys(OPEN_REFUSALS).filter((k) => k !== 'recording');
    const unbadged = serverKeys.filter((k) => !badgeKeys.includes(k));
    check(serverKeys.length > 0 && unbadged.length === 0,
      'every refusal the server can send has a badge on the page, so a reason added later is asked by existing',
      `server ${serverKeys.join(' ')} against page ${badgeKeys.join(' ')}`);
    const liveKeys = [...new Set((await getJson(`${macUrl}/library/takes`)).takes
      .flatMap((t) => t.openRefusals.map((r) => r.key)))];
    check(liveKeys.every((k) => Object.hasOwn(OPEN_REFUSALS, k)),
      'every refusal a take actually arrived with is one the table declares',
      `${liveKeys.join(' ')} against ${Object.keys(OPEN_REFUSALS).join(' ')}`);
    const unreachable = Object.keys(OPEN_REFUSALS).filter((k) => k !== 'recording' && !liveKeys.includes(k));
    check(unreachable.length === 0,
      'and every refusal the table declares is one some take here actually arrives with, so a branch forgotten in the scanner is not a badge nobody can earn',
      unreachable.length ? `declared and never produced: ${unreachable.join(' ')}` : liveKeys.join(' '));

    // The predicate against the list, on every take rather than on the branches.
    const disagreed = (await getJson(`${macUrl}/library/takes`)).takes
      .filter((t) => t.openable !== (t.openRefusals.length === 0));
    check(disagreed.length === 0,
      'and every take\'s openable is its refusal list being empty, rather than a second answer to the same question',
      disagreed.length
        ? disagreed.map((t) => `${t.id} openable=${t.openable} with ${t.openRefusals.length} refusals`).join(', ')
        : 'agreed on every take');

    // Marks on the tile's scrub bar, at their source fraction.
    const marks = one('local-clip').marks;
    check(marks.length === 4, 'a take\'s marks are on the tile\'s scrub bar', `${marks.length} ticks`);
    check(marks[0] === 0, 'a mark at source zero sits at the left edge rather than vanishing');
    check(marks[marks.length - 1] === 100, 'and a mark past the end clamps to the right edge');
    check(tiles.some((t) => t.marks.length === 1), 'the single-mark case renders',
      `${tiles.filter((t) => t.marks.length === 1).length} tiles with one mark`);
    check(tiles.some((t) => t.marks.length === 0), 'and so does the no-mark case');

    check(tiles.filter((t) => t.state === 'remote').every((t) => /decimated/.test(t.coarse ?? '')),
      'a remote tile says it is decimated');
    check(tiles.filter((t) => t.state !== 'remote').every((t) => t.coarse === null),
      'and a local one does not');

    // The skim draws a frame from the take rather than a placeholder.
    const clipHash = one('local-clip').hash;
    await page.evaluate(`globalThis.__library.drawn(${JSON.stringify(clipHash)})`);
    const at0 = await page.evaluate(`globalThis.__library.poster(${JSON.stringify(clipHash)})`);
    await page.evaluate(`globalThis.__library.skimTo(${JSON.stringify(clipHash)}, 0.9)`);
    const at90 = await page.evaluate(`globalThis.__library.poster(${JSON.stringify(clipHash)})`);
    check(at0.mean > 1, 'the poster is a frame of the take rather than an empty canvas', `mean ${at0.mean.toFixed(1)}`);
    check(at90.signature !== at0.signature, 'and skimming to another position draws another frame',
      `${at0.signature} then ${at90.signature}, means ${at0.mean.toFixed(2)} and ${at90.mean.toFixed(2)}`);
    const remoteHash = tiles.find((t) => t.state === 'remote')?.hash;
    check(remoteHash !== undefined, 'a remote take is present to skim');
    if (remoteHash !== undefined) {
      await page.evaluate(`globalThis.__library.drawn(${JSON.stringify(remoteHash)})`);
      const remote = await page.evaluate(`globalThis.__library.poster(${JSON.stringify(remoteHash)})`);
      check(remote.mean > 0 && remote.mean < at0.mean * 0.5,
        'a decimated skim is measurably sparser than a local one, not just labelled',
        `local ${at0.mean.toFixed(1)} against remote ${remote.mean.toFixed(1)}`);
    } else {
      check(false, 'a decimated skim is measurably sparser than a local one, not just labelled',
        'there is no remote tile to skim');
    }

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

    // What the confirm promises against what the server does.
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
    check(localConfirm.goDisabled === false && /only copy/.test(localConfirm.warn),
      'while a take that really is the last copy still warns and still offers the button',
      localConfirm.warn.slice(0, 70));
    check(bothConfirm.goPaint !== localConfirm.goPaint,
      'and it is painted as disabled rather than merely being disabled, which no assertion on the property can see',
      `refused: ${bothConfirm.goPaint} against offered: ${localConfirm.goPaint}`);

    const back = await page.evaluate(`(() => {
      const a = document.getElementById('toMenu');
      return a ? { tag: a.tagName, href: a.getAttribute('href'), text: a.textContent.trim() } : null;
    })()`);
    check(back?.tag === 'A' && back.href === '/',
      'the library has a way back to the menu, and it is a real URL rather than a button that navigates',
      JSON.stringify(back));
    if (back) {
      await page.click('#toMenu');
      await page.waitForFunction('globalThis.__menu !== undefined', null, { timeout: 20000 });
      check(new URL(page.url()).pathname === '/', 'and following it arrives at the menu',
        `${page.url()} defines __menu`);
    } else {
      check(false, 'and following it arrives at the menu', 'there is no anchor to follow');
    }
    await page.goto(libraryPage(macUrl), { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });

    // The bar carries the way out and the way across, and they are different claims: `toMenu`
    // leaves for the menu, and the two `.surface` anchors are the pair of pages this one is one
    // of. Read off the markup on both pages rather than on one, because a header written per page
    // rather than shared is exactly a page that names itself right and its neighbour wrong.
    const barOn = (where) => where.evaluate(`(() => {
      const bar = document.getElementById('appBar');
      const back = document.getElementById('toMenu');
      const surfaces = [...document.querySelectorAll('#navRow .surface')];
      if (!bar || !back) return null;
      const r = bar.getBoundingClientRect();
      return {
        top: Math.round(r.top), height: Math.round(r.height),
        arrow: back.querySelector('.arrow')?.textContent.trim() ?? null,
        label: back.querySelector('span:last-child')?.textContent.trim() ?? null,
        surfaces: surfaces.map((a) => ({
          id: a.id, href: a.getAttribute('href'), text: a.textContent.trim(),
          current: a.getAttribute('aria-current'),
        })),
      };
    })()`);
    const libraryShell = await barOn(page);
    check(libraryShell?.top === 0 && libraryShell.height === 38
      && libraryShell.arrow === '<' && libraryShell.label === 'Menu',
      'the way out of the library is the menu and it says so, in a fixed application bar at the top edge',
      JSON.stringify(libraryShell));
    const surfacesOn = (shell) => (shell?.surfaces ?? []).map((s) => `${s.id}=${s.href}`).join(' ');
    check(surfacesOn(libraryShell) === 'toProjects=/projects toLibrary=/library',
      'and beside it the two surfaces are named as real URLs rather than as a control that navigates',
      surfacesOn(libraryShell) || 'no surface anchors');
    check(libraryShell?.surfaces.find((s) => s.id === 'toLibrary')?.current === 'page'
      && libraryShell.surfaces.find((s) => s.id === 'toProjects')?.current === null,
      'with the page you are on marked and the one you are not left unmarked, which is the only thing '
      + 'in the bar that differs between the two surfaces',
      (libraryShell?.surfaces ?? []).map((s) => `${s.id}:${s.current ?? 'none'}`).join(' '));
    // Followed rather than read: the control sweep below credits these two to this row, and a
    // credit nothing joins to a press is a sentence somebody wrote once.
    await page.click('#toProjects');
    await page.waitForFunction('globalThis.__projects !== undefined', null, { timeout: 20000 })
      .catch(() => { /* the row below says so */ });
    const acrossShell = await barOn(page);
    check(new URL(page.url()).pathname === '/projects'
      && acrossShell?.surfaces.find((s) => s.id === 'toProjects')?.current === 'page'
      && acrossShell.surfaces.find((s) => s.id === 'toLibrary')?.current === null,
      'and following the other one arrives at that page with the mark moved, so the bar is one '
      + 'header on both surfaces rather than a copy per page that agrees today',
      `${page.url()} - ${(acrossShell?.surfaces ?? []).map((s) => `${s.id}:${s.current ?? 'none'}`).join(' ')}`);
    await page.click('#toLibrary');
    await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const wasAt = page.url();
    await page.click('.tab[data-filter="all"]');
    await new Promise((done) => { setTimeout(done, 300); });
    check(page.url() === wasAt && await page.evaluate('document.querySelector(".tab[data-filter=all]").getAttribute("aria-pressed")') === 'true',
      'and the active filter marks the current view without navigating or reloading it', page.url());

    await page.evaluate('globalThis.__library.drawn(document.querySelector(".tile").dataset.hash)');

    // Measured off `getBoundingClientRect`, never off the CSS.
    const geometryAt = async (width) => {
      await page.setViewportSize({ width, height: 900 });
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
      check(boxes.every((b) => !b.factsOverflow && !b.actsWrapped),
        `no fact row is clipped and no action row has wrapped at ${width}px`,
        boxes.filter((b) => b.factsOverflow || b.actsWrapped).map((b) => b.id).join(' ') || 'all clear');
      check(overlapsIn(boxes).length === 0,
        `and no two rows overlap at ${width}px, which is what an intrinsic height nobody could rely on produced`,
        overlapsIn(boxes).map((b) => b.id).join(' ') || `${new Set(boxes.map((b) => Math.round(b.top))).size} rows`);
    }
    // The backing store follows the rendered box rather than being assigned once.
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

    // Rendered into every tile hidden rather than built on the first press.
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
    // The sentences the poster's badges are short for.
    const warnMenu = await page.evaluate(`globalThis.__library.openMenu(${JSON.stringify(one('three-warning-take').hash)})`);
    const warnTile = one('three-warning-take');
    check(eq([...warnTile.flags].sort(), ['no-hello', 'short', 'truncated']),
      'a take with three warnings carries all three as badges over its poster', warnTile.flags.join(' '));
    check(/sensor hello/.test(warnMenu.note) && /no whole frame/.test(warnMenu.note) && /mid-frame/.test(warnMenu.note),
      'and the sentence behind each one is in the menu, where a finger can reach it',
      warnMenu.note.replace(/\n/g, ' | ').slice(0, 130));
    // And the menu is on screen, which every row above this passes without.
    const menuBoxes = [];
    for (const t of tiles) {
      const m = await page.evaluate(`globalThis.__library.openMenu(${JSON.stringify(t.hash)})`);
      if (!m.inside) {
        menuBoxes.push(`${t.id}(${t.state}) ${m.clipped.above > 0 ? `${m.clipped.above}px above` : `${m.clipped.below}px below`}`
          + ` of ${m.clipped.height}px, room ${m.room.above}/${m.room.below}, ${m.placed}`);
      }
      // Escape, which is the page's own way out of a menu, rather than a press at a corner that
      // used to be empty. It was `page.mouse.click(4, 4)`: the shared header made `#toMenu` a
      // direct child of `.appbar`, so `align-self: stretch` now reaches it against a 38px bar
      // where it used to be centred inside `#navRow` and left the top few pixels dead. The click
      // navigated to the menu and the run died `Execution context was destroyed` with the rows
      // below unasked. A dismissal aimed at whitespace is aimed at whatever moves into it.
      await page.keyboard.press('Escape');
    }
    check(menuBoxes.length === 0,
      'and every tile\'s menu opens inside the grid rather than under its edge, whichever row the tile is in',
      menuBoxes.join('; ') || `${tiles.length} tiles, every menu fully on screen`);
    check(warnTile.flags.includes('short') && /no frames/.test(warnMenu.note.match(/^.*no frames.*$/m)?.[0] ?? ''),
      'and a take with no whole frame says so rather than saying it has fewer than two',
      warnMenu.note.split('\n').find((l) => /frame/.test(l)) ?? '');
    // The format band's badge and the sentence behind it, read the same way.
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
    await page.keyboard.press('Escape');
    const oneFrameTile = one('one-frame-take');
    check(oneFrameTile.flags.includes('short'),
      'while the one-frame take still carries the badge, so the row above is about the wording rather than about the badge going away',
      oneFrameTile.flags.join(' '));
    // The row below is about a tap in empty space, so the point is hit-tested rather than
    // guessed: (4, 4) was empty until the shared header stretched `#toMenu` to the full height of
    // the bar, and a tap that navigates closes the menu for the wrong reason and takes the run
    // with it. `elementFromPoint` at the press coordinate is what separates the two.
    await page.evaluate(`globalThis.__library.openMenu(${JSON.stringify(clipHash2)})`);
    const empty = await page.evaluate(`(() => {
      // Down the right-hand gutter, which is page background at every viewport this file uses.
      for (let y = 60; y < innerHeight - 8; y += 20) {
        const hit = document.elementFromPoint(innerWidth - 6, y);
        if (hit && !hit.closest('#appBar') && !hit.closest('.tile') && !hit.closest('dialog')) {
          return { x: innerWidth - 6, y, what: hit.id || hit.className || hit.tagName };
        }
      }
      return null;
    })()`);
    check(empty !== null, 'there is a point on this page that belongs to neither the bar nor a tile, '
      + 'which is what the row below has to press for its claim to be about a tap in empty space',
      empty === null ? 'every probed point belonged to the bar or to a tile' : `(${empty.x}, ${empty.y}) is ${empty.what}`);
    if (empty) await page.mouse.click(empty.x, empty.y);
    check(await page.evaluate('globalThis.__library.menuOpen()') === 0,
      'a tap anywhere else closes it');

    // A 228px tile is enough to recognise a take and not enough to look at one.
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
    // A magnification of the tile and not a sparser copy of it.
    const tileMean = (await page.evaluate(`globalThis.__library.poster(${JSON.stringify(clipHash2)})`)).mean;
    check(vFirst.mean > tileMean * 0.7,
      'and it is a magnification of the tile rather than a sparser copy of it - the sample size follows the canvas',
      `tile ${tileMean.toFixed(1)}, stage ${vFirst.mean.toFixed(1)}, ratio ${(vFirst.mean / tileMean).toFixed(2)} (broken build measures 0.28 here)`);

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
    check(vLast.signature !== vFirst.signature,
      'and the picture on the stage is a different frame, not a readout that moved on its own',
      `${vFirst.signature} then ${vLast.signature}, means ${vFirst.mean.toFixed(2)} and ${vLast.mean.toFixed(2)}`);
    await page.evaluate('globalThis.__library.viewer.clickMark(0)');
    await page.evaluate(`globalThis.__library.viewer.drawn(${drawsBefore + 4})`);
    const atMark = await page.evaluate('globalThis.__library.viewer.state()');
    check(atMark.index !== atEnd.index && atMark.marks.length === 4,
      'a mark on the viewer\'s bar is a control rather than a decoration: pressing one seeks to it',
      `${atEnd.index} -> ${atMark.index}, ${atMark.marks.length} marks`);
    const drawsAtMark = await page.evaluate('globalThis.__library.viewer.draws()');
    await page.evaluate('globalThis.__library.viewer.key("ArrowDown")');
    await page.evaluate(`globalThis.__library.viewer.drawn(${drawsAtMark + 1})`);
    const nextTake = await page.evaluate('globalThis.__library.viewer.state()');
    check(nextTake.id !== atMark.id && await page.evaluate('globalThis.__library.viewer.isOpen()') === true,
      'and down moves to the next take without closing', `${atMark.id} -> ${nextTake.id}`);
    await page.keyboard.press('Escape');
    check(await page.evaluate('globalThis.__library.viewer.isOpen()') === false,
      'escape closes it, which is the dialog element\'s own behaviour rather than a second rule');

    // The class behind four separate findings, closed here rather than one instance at a time.
    {
      const listed = await page.evaluate('globalThis.__library.tiles()');
      check(listed.length >= 3, 'the grid holds several takes, so the comparison below has range',
        `${listed.length} tiles: ${listed.map((t) => t.state).join(' ')}`);
      const disagreed = [];
      for (const tile of listed) {
        await page.evaluate(`globalThis.__library.viewer.open(${JSON.stringify(tile.hash ?? tile.id)})`);
        // Re-opened until it holds rather than waited on for a guessed interval.
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

    // Five findings on this branch were one property, and it had no durable control until here.
    {
      // Opened at the top of the grid, because two presses need somewhere to go.
      const walkable = await page.evaluate('globalThis.__library.tiles()');
      check(walkable.length >= 3, 'the grid has takes below the first, so two arrows have room',
        `${walkable.length} tiles`);
      await page.evaluate(`globalThis.__library.viewer.open(${JSON.stringify(walkable[0].hash ?? walkable[0].id)})`);
      await page.evaluate('globalThis.__library.viewer.drawn(1)');
      check(await page.evaluate('globalThis.__library.viewer.focusInside()') === true,
        'a viewer opened from the page puts focus inside itself, which is where a key has to land',
        await page.evaluate("document.activeElement?.dataset?.act ?? document.activeElement?.id ?? document.activeElement?.tagName"));

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

    await page.mouse.move(posterBox.x, posterBox.y);
    await page.mouse.down();
    await page.evaluate(`(() => {
      const sel = '.tile[data-hash="' + CSS.escape(${JSON.stringify(clipHash2)}) + '"] .skim';
      document.querySelector(sel).dispatchEvent(new PointerEvent('pointercancel', {
        bubbles: true, pointerId: 1, pointerType: 'mouse',
      }));
    })()`);
    await page.mouse.up();
    await page.mouse.move(posterBox.x + 40, posterBox.y);
    await page.mouse.move(posterBox.x, posterBox.y);
    const openedByCancel = await page.evaluate('globalThis.__library.viewer.isOpen()');
    check(openedByCancel === false,
      'a press the browser cancels leaves no press behind it, so a later move over the tile is not a drag and does not open the take',
      `viewer ${openedByCancel ? 'opened' : 'stayed shut'}`);
    // Put back if the mutated build opened it, so what this row catches stays this row's.
    if (openedByCancel) {
      await page.evaluate('globalThis.__library.viewer.close()');
      await page.waitForFunction('globalThis.__library.viewer.isOpen() === false', null, { timeout: 5000 })
        .catch(() => {});
    }

    await page.evaluate(`globalThis.__library.viewer.open(${JSON.stringify(clipHash2)})`);
    await page.evaluate('globalThis.__library.viewer.drawn(1)');
    const DRIVERS = new Set([
      'toMenu', 'toProjects', 'toLibrary', 'all', 'local', 'remote', 'both',
      'new-project', 'download', 'delete', 'more',
      'rename', 'reveal', 'reclaim',
      'vMore', 'vClose', 'mark',
      'cCancel', 'cGo', 'rCancel', 'rGo', 'rName',
    ]);
    const rendered = await page.evaluate('globalThis.__library.controls()');
    const unswept = rendered.filter((c) => !DRIVERS.has(c.key));
    check(unswept.length === 0,
      `every interactive control the library renders has a driver in this file (${rendered.length} controls)`,
      unswept.length ? `no driver for ${[...new Set(unswept.map((c) => `${c.where}:${c.key}`))].join(' ')}`
        : [...new Set(rendered.map((c) => c.key))].join(' '));
    const present = new Set(rendered.map((c) => c.key));
    const missing = [...DRIVERS].filter((k) => !present.has(k));
    check(missing.length === 0,
      'and every control this file names is one the library still renders',
      missing.join(' ') || `${present.size} distinct controls on screen`);
    await page.evaluate('globalThis.__library.viewer.close()');

    check(errors.length === 0, 'the library raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  console.log('\n[library] the capture format band at the door the editor opens');
  {
    const refusedAt = editorPage(macUrl, 'future-format-take');
    const { page: refused, errors: refusedErrors } = await openPage(browser, refusedAt, { width: 640, height: 400 });
    // Taken at the moment it matches rather than read again afterwards.
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

  {
    const emptyUrl = await startServer(root, ['--captures', join(WORK, 'empty-captures'), '--name', 'fresh'], MAC_PORT + 3);
    const { page, errors } = await openPage(browser, libraryPage(emptyUrl));
    await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const line = await page.evaluate('globalThis.__library.emptyLine()');
    check(/^No takes\.$/.test(line ?? ''), 'an empty media library says so rather than rendering nothing',
      String(line));
    // A library with nothing in it says so whichever tab is selected.
    await page.evaluate('globalThis.__library.filter("local")');
    const filtered = await page.evaluate('globalThis.__library.emptyLine()');
    check(/^No takes\.$/.test(filtered ?? ''),
      'and it keeps saying so under a filter rather than blaming the filter',
      String(filtered));
    check(errors.length === 0, 'and an empty library raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  console.log('\n[library] a take can be renamed, and a rename moves a label rather than a reference');
  {
    const renameDir = join(WORK, 'renaming');
    rmSync(renameDir, { recursive: true, force: true });
    mkdirSync(renameDir, { recursive: true });
    writeTake(renameDir, 'before-the-rename', { frames: 8, startedAt: Date.UTC(2026, 6, 20, 11, 0) });
    writeTake(renameDir, 'already-taken', { frames: 4 });
    writeTake(renameDir, 'stale-listing-take', { frames: 5 });
    writeFileSync(join(renameDir, 'before-the-rename.marks.jsonl'),
      markLine({ id: 'r1', sourceMs: 40, label: 'the moment', at: 1000 }));

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

    // A request built against a listing that has gone stale.
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

    // The same refusal under a race, which the row above cannot reach.
    const staged = await import(pathToFileURL(join(root, 'server/library.js')).href);
    const raceDir = join(WORK, 'rename-race');
    rmSync(raceDir, { recursive: true, force: true });
    mkdirSync(raceDir, { recursive: true });
    const racers = ['racer-one', 'racer-two', 'racer-three', 'racer-four'];
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
    const survivors = readdirSync(raceDir).filter((f) => /^racer-.*\.knct$/.test(f));
    check(survivors.length === racers.length - 1 && existsSync(join(raceDir, 'the-contested-name.knct')),
      'and every one that lost still has its footage under its own name, which is what a silent overwrite takes away',
      `${survivors.length} of ${racers.length - 1} survived: ${survivors.join(' ') || 'nothing'}`);

    const done = await post(`${renameUrl}/library/rename/before-the-rename`,
      { hash: before.hash, to: 'after-the-rename.knct' });
    check(done.id === 'after-the-rename',
      'a typed extension is taken off rather than refused, because it is the same name',
      JSON.stringify(done.id));
    const after = await listed('after-the-rename');
    check(after !== undefined && !(await listed('before-the-rename')),
      'the take is listed under its new name and not its old one');
    check(after.hash === before.hash && after.frames === before.frames,
      'and its content hash is unchanged, so every project built on it still finds its footage',
      `${before.hash.slice(0, 20)}… ${before.frames} frames, still ${after.hash.slice(0, 20)}…`);
    check(after.marks.length === 1 && after.marks[0].label === 'the moment',
      'the marks came with it - the one artifact here nobody can regenerate, since it is what somebody pressed in the room',
      JSON.stringify(after.marks.map((m) => m.label)));
    check(!existsSync(join(renameDir, 'before-the-rename.marks.jsonl')),
      'and nothing is left at the old name for a later take to find beside it',
      readdirSync(renameDir).sort().join(' '));
    const idxAfter = statSync(join(renameDir, 'after-the-rename.idx'));
    check(idxAfter.mtimeMs === idxBefore.mtimeMs && idxAfter.size === idxBefore.size,
      'the index moved with it rather than being rebuilt, which is a full read of the take not taken',
      `${idxBefore.size} bytes at ${idxBefore.mtimeMs}, still ${idxAfter.size} at ${idxAfter.mtimeMs}`);

    // The one route in this program that starts a process.
    const revealed = await post(`${renameUrl}/library/reveal/after-the-rename`);
    check(revealed.path === join(renameDir, 'after-the-rename.knct'),
      'reveal answers with the take\'s own path under the captures directory',
      String(revealed.path ?? revealed.error));
    // What counts as the right argv is the platform's own shape, not the bare path.
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

    // A browser across the link is refused, and proving it needs a second address to arrive on.
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
  // The refusal is a decision rather than a status on something that already happened.
      await new Promise((r) => { setTimeout(r, 300); });
      check(argvSeen().length === beforeElsewhere,
        'and no file manager was started, which is the half of the refusal a 409 cannot say',
        `${beforeElsewhere} arguments logged before, ${argvSeen().length} after`);
      const stillHere = await post(`${openUrl}/library/reveal/after-the-rename`);
      check(stillHere.path === join(renameDir, 'after-the-rename.knct'),
        'while the same server still reveals for a browser on this machine',
        String(stillHere.path ?? stillHere.error));
      // The page agrees with the server about which of those it is looking at.
      const fromElsewhere = await getJson(`http://${lan}:${port}/library/all`);
      const fromHere = await getJson(`${openUrl}/library/all`);
      check(fromElsewhere.reveal?.available === false && fromHere.reveal?.available === true,
        'and the listing tells the page which of the two it is, per request, so the menu item can say why before it is pressed',
        `${JSON.stringify(fromElsewhere.reveal?.why ?? null).slice(0, 60)} against available`);
      for (const p of servers.filter((sv) => sv.port === MAC_PORT + 15)) p.child.kill('SIGKILL');
    }

    // `scanTakes` decides which take is open by comparing paths against `recorder.openPath`.
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
    await fetch(`${shootUrl}/library/all`).catch(() => {});
    check(!existsSync(join(shootDir, `${shooting.takeId}.idx`)),
      'and the manifest still describes it without scanning it - no sidecar, which is what a full read of a growing take would leave',
      readdirSync(shootDir).sort().join(' '));
    // And reveal is refused on it too, which is the least obvious of the three.
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

  console.log('\n[library] the projects page lists the edits, and says which of them are dark');
  {
    // The page a project is opened from, which this file had no coverage of at all - and a page
    // `PAGE_URLS` does not name has its mutations delivered nowhere, so the first row here is the
    // one that makes every later mutation of `projects.html` mean anything.
    const PRESENT = 'projects-page-present';
    const DARK = 'projects-page-dark';
    const localHash = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'local-clip').hash;
    // Built off a document the editor wrote rather than composed here: `checkProject` demands a
    // weight for every reading and `READINGS` is built at run time out of the installed effect
    // manifests, so a body this file authored would be refused by the loader for reasons that
    // have nothing to do with the page.
    const seed = await (async () => {
      const { page: mint, errors: mintErrors } = await openPage(browser, editorPage(macUrl, 'local-clip'), { width: 640, height: 400 });
      await mint.waitForFunction('globalThis.__kinect?.library?.opened() === true', null, { timeout: 40000 });
      const body = await mint.evaluate('globalThis.__kinect.library.serialiseProjectBody()');
      check(mintErrors.length === 0, 'a document written by the editor is what the rows below are drawn from',
        mintErrors.slice(0, 2).join(' | ') || `${body.clips.length} clip, cut on ${body.clips[0]?.take?.id}`);
      await mint.close();
      return body;
    })();
    const one = JSON.parse(JSON.stringify(seed));
    one.clips = [{ ...one.clips[0], start: 0 }];
    one.clips[0].take = { id: 'local-clip', hash: localHash };
    const gone = JSON.parse(JSON.stringify(one));
    // Both clips carry their own length, and the missing one has to: `spanOf` falls back to the
    // take's duration, which is precisely what a machine that has not got the take cannot read.
    // So a dark clip with `length: null` occupies no width and the hole it costs is invisible -
    // the design's "its width says how much of the edit the hole costs" holds for a clip that
    // names its own length and cannot hold for one that does not. Measured, not reasoned: a
    // fixture built without these lengths drew one segment where the row expects two.
    gone.clips = [
      { ...JSON.parse(JSON.stringify(one.clips[0])), id: 'here', start: 0, length: 4 },
      {
        ...JSON.parse(JSON.stringify(one.clips[0])),
        id: 'nowhere',
        start: 4,
        length: 6,
        take: { id: 'reclaimed-take', hash: `sha256:${'a'.repeat(64)}` },
      },
    ];
    await writeDoc(macUrl, 'projects', PRESENT, one);
    await writeDoc(macUrl, 'projects', DARK, gone);

    const { page, errors } = await openPage(browser, projectsPage(macUrl));
    await page.waitForFunction('globalThis.__projects !== undefined', null, { timeout: 20000 });
    await page.waitForFunction(
      `globalThis.__projects.rows().some((r) => r.name === ${JSON.stringify(DARK)})`,
      null, { timeout: 20000 },
    ).catch(() => { /* the row below says so */ });
    const rows = await page.evaluate('globalThis.__projects.rows()');
    const named = (n) => rows.find((r) => r.name === n);
    check(named(PRESENT) !== undefined && named(DARK) !== undefined,
      'the page is served at /projects and lists what the store holds, which is what makes an '
      + 'interception of projects.html land somewhere rather than nowhere',
      rows.map((r) => r.name).join(', ') || 'the listing was empty');
    // Newest written first, and nothing is stored to know it: the dark one was written second.
    check(rows[0]?.name === DARK,
      'and it is ordered by when each project was last written, newest first',
      rows.map((r) => r.name).join(' then '));
    check(named(PRESENT)?.missing === 0 && named(PRESENT)?.clips === 1,
      'a project whose footage is here says nothing about missing takes',
      `${named(PRESENT)?.clips} clip, ${named(PRESENT)?.missing} missing`);
    check(named(DARK)?.missing === 1 && /reclaimed-take/.test(named(DARK)?.dark ?? ''),
      'and one whose footage is not here says so on its own row, naming the take it wants',
      `${named(DARK)?.missing} missing, "${named(DARK)?.dark ?? 'nothing said'}"`);
    check(/library/i.test(named(DARK)?.darkAct ?? ''),
      'and the control on it goes to the library rather than fetching, because the download and '
      + 'the two-machine state live there and a second copy of them here is the duplicated path',
      String(named(DARK)?.darkAct));
    // The span the missing clip covers is drawn as a hole rather than skipped, so its width is
    // how much of the edit the hole costs.
    const holes = (named(DARK)?.segments ?? []).filter((s) => s.dark);
    check(holes.length === 1 && holes[0].clip === 'nowhere' && parseFloat(holes[0].width) > 55,
      'and the span it covers is drawn at the width it costs rather than closed up - 6s of a 10s '
      + 'edit, so the block is more than half the bar rather than merely present',
      JSON.stringify(named(DARK)?.segments ?? []));
    // Printed rather than asserted, because it is a limit and not a claim: the width of a dark
    // clip that carries no length of its own cannot be derived from the document, so that hole is
    // drawn at no width at all. The row above uses a fixture that names its lengths.
    console.log(`  ...   a dark clip with a length of its own draws ${holes.length} block of `
      + `${holes[0]?.width ?? 'no width'}; one without a length draws none, because its span is the `
      + 'take\'s duration and the take is what is missing');
    check(errors.length === 0, 'the projects page raises no page error drawing either of them',
      errors.slice(0, 2).join(' | '));
    await page.close();
    await writeDoc(macUrl, 'projects', PRESENT, null, 'DELETE');
    await writeDoc(macUrl, 'projects', DARK, null, 'DELETE');
  }

  console.log('\n[library] a project survives a round trip through a file');
  {
    {
      const { page: takePage, errors: takeErrors } = await openPage(browser, editorPage(macUrl, 'local-clip'), { width: 640, height: 400 });
      // `!== null` here was vacuously true and the wait returned before the page had booted.
      await takePage.waitForFunction('Boolean(globalThis.__kinect?.timeline?.transport())', null, { timeout: 40000 });
      await takePage.evaluate('globalThis.__kinect.timeline.settled()');
      check(await takePage.evaluate('globalThis.__kinect.library.takeHash()')
        === (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'local-clip').hash,
        'the editor names its take by the hash the manifest reports');

      // The project owns the take list, so other footage is opened rather than refused. What is
      // refused is footage this machine has not got, and it is named.
      const otherHash = (await getJson(`${macUrl}/library/takes`)).takes.find((t) => t.id === 'truncated-take').hash;
      const cutOnto = async (name, take) => takePage.evaluate(`(async () => {
        const body = globalThis.__kinect.library.serialiseProjectBody();
        body.clips[0].take = ${JSON.stringify(take)};
        await fetch('/projects/${name}?rev=' + await globalThis.__rev('projects', '${name}'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        try { await globalThis.__kinect.library.loadProject('${name}'); return 'ACCEPTED'; }
        catch (e) { return e.message; }
      })()`);
      const absent = await cutOnto('absent-footage', { id: 'not-on-this-machine', hash: `sha256:${'0'.repeat(64)}` });
      check(/no take on this machine hashes it/.test(absent),
        'a project whose clip names footage this machine has not got is refused, and the refusal names the take',
        absent.slice(0, 120));
      check(await takePage.evaluate('globalThis.__kinect.library.takeId()') === 'local-clip',
        'and the refusal left the editor on the take it had, rather than half onto one it could not open',
        String(await takePage.evaluate('globalThis.__kinect.library.takeId()')));
      const crossed = await cutOnto('other-footage', { id: 'truncated-take', hash: otherHash });
      check(crossed === 'ACCEPTED'
        && await takePage.evaluate('globalThis.__kinect.library.takeHash()') === otherHash,
        'a project cut on other footage opens that footage, because the clips are what name the take',
        `${String(crossed).slice(0, 80)}, now on ${String(await takePage.evaluate('globalThis.__kinect.library.takeId()'))}`);
      // Back onto the take the rows below are about.
      await takePage.goto(editorPage(macUrl, 'local-clip'), { waitUntil: 'load' });
      await takePage.waitForFunction('globalThis.__kinect?.library?.opened() === true', null, { timeout: 40000 });

      // And the whole path end to end, seek included, onto the take it was built on.
      const own = await takePage.evaluate(`(async () => {
        const k = globalThis.__kinect;
        const body = k.library.serialiseProjectBody();
        await fetch('/projects/own-footage?rev=' + await globalThis.__rev('projects', 'own-footage'), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
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
      pointSize: 21.6, opacity: 0.62, exposure: 2.35, bloom: 0.85, trails: 0.62,
      'rgbsplit.amount': 2.4, 'raster.amount': 0.44, 'grain.amount': 0.31,
      'blackwall.scan': 0.62, rim: 0.28, fade: 340, wake: 720,
    };
    // The deterministic drive rather than the timeline.
    const times = await page.evaluate(`(() => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(pinFixture().toString('base64'))}), (c) => c.charCodeAt(0));
      return globalThis.__kinect.drive.pin(bytes.buffer);
    })()`);
    // Positions between the pinned frames rather than on them.
    const positions = [];
    for (let i = 0; i < times.length - 1; i++) {
      for (let r = 0; r < 3; r++) positions.push(times[i] + (times[i + 1] - times[i]) * (r / 3));
    }
    // The camera is pinned inside the run and not once outside it.
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

    // Through an actual file: the page saves it, the server writes it, the page reads it back.
    await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      const body = k.library.serialiseProjectBody();
      const res = await fetch('/projects/round-trip?rev=' + await globalThis.__rev('projects', 'round-trip'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      return res.json();
    })()`);
    await page.evaluate('globalThis.__kinect.params.reset()');
    const defaults = await render();
    // Fetched and restored, which is the document half of the load path.
    await page.evaluate(`(async () => {
      const doc = await (await fetch('/projects/round-trip')).json();
      globalThis.__kinect.library.restoreProject(doc.body);
    })()`);
    const reloaded = await render();

    check(eq(authored, reloaded), 'the reloaded file reproduces the run image for image',
      eq(authored, reloaded) ? '' : `first divergence at image ${authored.findIndex((h, i) => h !== reloaded[i])}`);
    check(!eq(authored, defaults),
      'and the defaults do not - the file is what the image depends on');
    check(new Set(authored).size > authored.length / 2, 'the run itself moves across its positions',
      `${new Set(authored).size} distinct of ${authored.length}`);

    // The saved file is a file on disk with a version on it.
    const saved = JSON.parse(readFileSync(join(WORK, 'projects/round-trip.json'), 'utf8'));
    check(saved.version === PROJECT_VERSION, 'the file carries the format version', `version ${saved.version}`);
    check(JSON.parse(readFileSync(join(WORK, 'projects/own-footage.json'), 'utf8')).clips?.[0]?.take?.hash?.startsWith('sha256:'),
      'and a project saved from the editor names its footage by content hash rather than by path');

    // The round trip that has to be lossless is the one this build cannot read.
    const installedIds = await page.evaluate(`(() => [...new Set(globalThis.__kinect.params.names('look')
      .filter((n) => n.includes('.')).map((n) => n.slice(0, n.indexOf('.'))))])()`);
    check(!installedIds.includes('sparkle'),
      'sparkle is not an effect this build has, which is what makes the rows below about a missing one',
      `${installedIds.length} installed: ${installedIds.join(', ')}`);

    // Split across the two blocks on purpose. A build without the effect cannot know where its
    // values belong - the manifest declaring it is the thing this build has not got - so the
    // document's own placement is the only statement of it, and each half has to come back where
    // it went or a load and save on this machine would move a grade effect into a clip.
    const CLIP_VALUES = { 'sparkle.amount': 0.6, 'sparkle.size': 3.25 };
    const LOOK_VALUES = { 'sparkle.hue': 210, 'sparkle.jitter': 0.125 };
    const PARKED_VALUES = { ...CLIP_VALUES, ...LOOK_VALUES };
    const CLIP_TRACKS = {
      'sparkle.amount': [
        { t: 0, value: 0, easeOut: [[0.42, 0]], easeIn: [[0.58, 1]] },
        { t: 2, value: 0.9, easeOut: [[0.42, 0]], easeIn: [[0.58, 1]] },
      ],
    };
    const LOOK_TRACKS = {
      'sparkle.hue': [{ t: 0.5, value: 10, easeOut: [[0.1, 0.2]], easeIn: [[0.3, 0.4]] }],
    };
    const PARKED_TRACKS = { ...CLIP_TRACKS, ...LOOK_TRACKS };
    const parkedFixture = {
      clipValues: CLIP_VALUES,
      lookValues: LOOK_VALUES,
      clipTracks: CLIP_TRACKS,
      lookTracks: LOOK_TRACKS,
      id: 'sparkle',
      version: '1.0.0',
    };
    const parked = await page.evaluate(`(async (f) => {
      const k = globalThis.__kinect;
      const clean = k.library.serialiseProjectBody();
      const doc = JSON.parse(JSON.stringify(clean));
      Object.assign(doc.clips[0].params, f.clipValues);
      Object.assign(doc.clips[0].tracks, f.clipTracks);
      Object.assign(doc.look.params, f.lookValues);
      Object.assign(doc.look.tracks, f.lookTracks);
      doc.requires = [...(doc.requires ?? []), { id: f.id, version: f.version }];
      const out = { clean };
      try {
        k.library.restoreProject(doc);
        out.loaded = true;
        out.missing = k.library.missingEffects();
      } catch (e) { out.loaded = false; out.loadError = String(e.message ?? e); return out; }
      const body = k.library.serialiseProjectBody();
      out.put = (await fetch('/projects/parked-round-trip?rev=' + await globalThis.__rev('projects', 'parked-round-trip'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).status;
      // And straight back in, so what the rows below compare is a document that has been
      // through the loader twice rather than one the serialiser happened to hand back.
      const again = await (await fetch('/projects/parked-round-trip')).json();
      try {
        k.library.restoreProject(again.body);
        out.reloaded = true;
        out.second = k.library.serialiseProjectBody();
      } catch (e) { out.reloaded = false; out.reloadError = String(e.message ?? e); }
      return out;
    })(${JSON.stringify(parkedFixture)})`);

    check(parked.loaded === true,
      'a document with values and tracks under an effect this build has not got loads rather than being refused',
      parked.loadError ?? `PUT ${parked.put}`);
    check(JSON.stringify(parked.missing) === JSON.stringify([{
      id: 'sparkle', version: '1.0.0', values: 4, tracks: 2, suppressed: false,
    }]),
    'and what it could not read is parked rather than dropped - four values, two tracks, at the version the document asked for',
    JSON.stringify(parked.missing ?? null));
    check(parked.reloaded === true,
      'and the file it saves is a document this build can open again',
      parked.reloadError ?? 'reopened');

    const parkedFile = JSON.parse(readFileSync(join(WORK, 'projects/parked-round-trip.json'), 'utf8'));
    const pick = (from, keys) => JSON.stringify(Object.fromEntries(keys.map((k) => [k, from?.[k]])));
    const valueKeys = Object.keys(PARKED_VALUES);
    const trackKeys = Object.keys(PARKED_TRACKS);
    // Read across both blocks, because what the rows below are about is the values surviving; the
    // row after them is the one about which block each landed in.
    const bothOf = (doc, kind) => Object.assign({}, doc?.look?.[kind], ...(doc?.clips ?? []).map((c) => c[kind]));
    check(pick(bothOf(parkedFile, 'params'), valueKeys) === pick(PARKED_VALUES, valueKeys),
      'every parked value comes back out of the saved file holding exactly what went in, key for key',
      pick(bothOf(parkedFile, 'params'), valueKeys));
    check(pick(bothOf(parkedFile, 'tracks'), trackKeys) === pick(PARKED_TRACKS, trackKeys),
      'and so does every parked track, key times, values and ease handles alike',
      pick(bothOf(parkedFile, 'tracks'), trackKeys).slice(0, 120));
    // And in the block it arrived in. A build without the effect cannot ask where its values
    // belong, so a pool that merged the two would save a grade effect into a clip, and the build
    // that does have it would then refuse the document on its own scope rule.
    const keysIn = (o) => Object.keys(o ?? {}).filter((k) => k.startsWith('sparkle.')).sort();
    const landed = {
      clipParams: keysIn(parkedFile.clips?.[0]?.params),
      clipTracks: keysIn(parkedFile.clips?.[0]?.tracks),
      lookParams: keysIn(parkedFile.look?.params),
      lookTracks: keysIn(parkedFile.look?.tracks),
    };
    const wanted = {
      clipParams: Object.keys(CLIP_VALUES).sort(),
      clipTracks: Object.keys(CLIP_TRACKS).sort(),
      lookParams: Object.keys(LOOK_VALUES).sort(),
      lookTracks: Object.keys(LOOK_TRACKS).sort(),
    };
    check(JSON.stringify(landed) === JSON.stringify(wanted),
      'and each one comes back in the block it was written in, so a pool that lost which block a key came from would move it',
      `${JSON.stringify(landed)} against ${JSON.stringify(wanted)}`);
    // And nothing under the pool's prefixes was invented on the way through.
    check(JSON.stringify(keysIn(bothOf(parkedFile, 'params'))) === JSON.stringify(valueKeys.slice().sort())
      && JSON.stringify(keysIn(bothOf(parkedFile, 'tracks'))) === JSON.stringify(trackKeys.slice().sort()),
    'and the file carries those keys and no others under that prefix, so nothing was added beside them either',
    `${JSON.stringify(keysIn(bothOf(parkedFile, 'params')))} / ${JSON.stringify(keysIn(bothOf(parkedFile, 'tracks')))}`);
    check(JSON.stringify((parkedFile.requires ?? []).find((e) => e.id === 'sparkle')) === '{"id":"sparkle","version":"1.0.0"}',
      'and the requires entry stays with them, at the version the document was authored against',
      JSON.stringify(parkedFile.requires ?? null));
    check(pick(bothOf(parked.second, 'params'), valueKeys) === pick(PARKED_VALUES, valueKeys)
      && pick(bothOf(parked.second, 'tracks'), trackKeys) === pick(PARKED_TRACKS, trackKeys),
    'and a second trip through the loader moves them no further than the first did',
    pick(bothOf(parked.second, 'params'), valueKeys));

    // And the page goes back to a document with nothing parked in it.
    const cleaned = await page.evaluate(`(async (clean) => {
      globalThis.__kinect.library.restoreProject(clean);
      return globalThis.__kinect.library.missingEffects();
    })(${JSON.stringify(parked.clean ?? null)})`);
    check(Array.isArray(cleaned) && cleaned.length === 0,
      'and putting the clip back leaves nothing parked, so the rows below serialise a document with no missing effect in it',
      JSON.stringify(cleaned));

  // `JSON.stringify` turns NaN and undefined into null, so a case labelled NaN would
  // silently be a case about null.
    const refuse = async (label, source) => page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const p = k.library.serialiseProjectBody();
      ${source}
      try { k.library.restoreProject(p); return 'ACCEPTED'; } catch (e) { return e.message; }
    })()`).then((message) => ({ label, message }));

    const cases = [
      ['a project with no version', 'delete p.version;'],
      ['a project from an older version', 'p.version = 0;'],
      // Derived from the version this build writes rather than written down.
      ['a project from a newer version', `p.version = ${PROJECT_VERSION + 1};`],
      ['a version that is not a number', 'p.version = "1";'],
      ['a retime curve that falls', 'p.clips[0].retime.keys = [{t:0,value:0},{t:1,value:2},{t:2,value:0.5}];'],
      ['a retime handle outside the unit box',
        'p.clips[0].retime.keys = [{t:0,value:0,easeOut: [[0.4, 1.9]],easeIn: [[0.6, 0]]},{t:2,value:1,easeOut: [[0.4, 0]],easeIn: [[0.6, 0]]}];'],
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
      // The registry's door, probed where the answer is different.
      ['a track the registry does not know', 'p.look.tracks.nosuchthing = [{t:0,value:1}];'],
      // `p.look.tracks.__proto__ = x` sets the *prototype* and creates no own property at all.
      ['a track named __proto__',
        "Object.defineProperty(p.look.tracks, '__proto__', { value: [{t:0,value:1}], enumerable: true, configurable: true, writable: true });"],
      ['a track named constructor', 'p.look.tracks.constructor = [{t:0,value:1}];'],
      ['a track named toString', 'p.look.tracks.toString = [{t:0,value:1}];'],
      ['a track named valueOf', 'p.look.tracks.valueOf = [{t:0,value:1}];'],
      ['a track named hasOwnProperty', 'p.look.tracks.hasOwnProperty = [{t:0,value:1}];'],
      ['a parameter named constructor in the values', 'p.look.params.constructor = 1;'],
      ['a parameter named __proto__ in the values',
        "Object.defineProperty(p.look.params, '__proto__', { value: 1, enumerable: true, configurable: true, writable: true });"],
      ['a reading that is not a number', 'p.clips[0].params["blackwall.amount"] = "1";'],
      // The scope split, from each side. A value in the wrong block would be applied at the wrong
      // scope on restore and written back to the wrong one on save.
      ['a project value in a clip block', 'p.clips[0].params.bloom = 0;'],
      ['a clip value in the project block', 'p.look.params.pointSize = 9;'],
      ['a view parameter in a clip block', 'p.clips[0].params.renderScale = 100;'],
      ['a retime rate of zero or less', 'p.clips[0].retime.rate = 0;'],
      ['a preset stamp that is not a name and a rev', 'p.clips[0].appliedPreset = { name: 42 };'],
      // The record a deliverable's embedded document carries.
      ['a suppressed list that is not a list', 'p.suppressed = "sparkle";'],
      ['a suppressed entry with no version', 'p.suppressed = [{ id: "sparkle" }];'],
      ['a suppressed entry whose id could not be an effect id', 'p.suppressed = [{ id: "Sparkle!", version: "1.0.0" }];'],
      // The completeness rule asked of the half of the document it used to skip.
      ['a project naming part of an effect in its values',
        "p.clips[0].params['glyph.amount'] = 0.5; p.clips[0].params['glyph.tone'] = 0.2; p.clips[0].params['glyph.hash'] = 1;"
        + " p.requires = [...(p.requires ?? []).filter((e) => e.id !== 'glyph'), { id: 'glyph', version: '1.0.0' }];"],
      ['a project whose only use of an effect is a track',
        "p.clips[0].tracks['glyph.tone'] = [{ t: 0, value: 0.2 }, { t: 1, value: 0.6 }];"
        + " p.requires = [...(p.requires ?? []).filter((e) => e.id !== 'glyph'), { id: 'glyph', version: '1.0.0' }];"],
    ];
    const results = [];
    for (const [label, source] of cases) results.push(await refuse(label, source));
    for (const { label, message } of results) {
      check(message !== 'ACCEPTED', `refused: ${label}`, message === 'ACCEPTED' ? 'ACCEPTED' : message.slice(0, 64));
    }
    const good = await refuse('an unmodified project', '');
    check(good.message === 'ACCEPTED', 'and an unmodified project still loads',
      good.message === 'ACCEPTED' ? '' : good.message.slice(0, 80));

    // The control the two truncation rows need, and it is not the row above.
    const wholeEffect = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const clean = k.library.serialiseProjectBody();
      const p = k.library.serialiseProjectBody();
      const names = k.params.names('look').filter((n) => n.startsWith('glyph.'));
      // Read off the live registry rather than off \`spec\`, which answers with a projection
      // carrying \`default\` and not \`def\` - a probe pointed at a field that has never existed
      // reads \`undefined\` on a correct build, which is the shape docs/instruments.md files
      // under a reading that is not a finding. \`get\` cannot answer with anything the
      // parameter could not hold.
      // Into the clip's block, because glyph binds the cloud - the two refused cases above
      // are one key short of this document and have to be short of it in the same block.
      for (const n of names) p.clips[0].params[n] = k.params.get(n);
      p.clips[0].tracks['glyph.tone'] = [{ t: 0, value: 0.2 }, { t: 1, value: 0.6 }];
      // Replaced rather than appended, for the reason the two cases above carry: a mutation
      // of this rule leaves an earlier case's document on the page, and an appended entry
      // would then be a duplicate refused by a different rule entirely.
      p.requires = [...(p.requires ?? []).filter((e) => e.id !== 'glyph'), { id: 'glyph', version: '1.0.0' }];
      let threw = null;
      try { k.library.restoreProject(p); } catch (e) { threw = String(e.message ?? e); }
      k.library.restoreProject(clean);
      return { threw, names };
    })()`);
    check(wholeEffect.threw === null && wholeEffect.names.length >= 4,
      'while a project naming a whole effect and keying one of its parameters loads, which is what the two rows above are each one key short of',
      wholeEffect.threw ?? `${wholeEffect.names.length} glyph parameters named: ${wholeEffect.names.join(', ')}`);

    // A document authored against another build of an effect this machine does have.
    const skew = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const chip = () => ({
        hidden: document.getElementById('tMissing')?.hidden ?? null,
        notices: [...document.querySelectorAll('#tMissing .missingfx[data-skew]')]
          .map((e) => e.querySelector('b').textContent),
      });
      const clean = k.library.serialiseProjectBody();
      k.params.set('glyph.amount', 0.5);
      const matched = k.library.serialiseProjectBody();
      const authored = (matched.requires ?? []).find((e) => e.id === 'glyph')?.version ?? null;
      const skewed = JSON.parse(JSON.stringify(matched));
      skewed.requires = skewed.requires.map((e) => (e.id === 'glyph' ? { ...e, version: '0.9.0' } : e));
      const out = { authored };
      k.library.restoreProject(skewed);
      out.mismatched = { hook: k.library.effectVersionSkew(), ...chip() };
      k.library.restoreProject(matched);
      out.matched = { hook: k.library.effectVersionSkew(), ...chip() };
      k.library.restoreProject(clean);
      return out;
    })()`);
    check(JSON.stringify(skew.mismatched?.hook) === JSON.stringify([
      { id: 'glyph', wanted: '0.9.0', installed: skew.authored },
    ]),
    'a document naming an effect at a version this build has not got loads, and says which pair it is',
    JSON.stringify(skew.mismatched?.hook ?? null));
    check(skew.mismatched?.hidden === false
      && JSON.stringify(skew.mismatched?.notices) === JSON.stringify([
        `document requires glyph 0.9.0, installed is ${skew.authored}`,
      ]),
    'and the bar carries that sentence, one entry for the effect, where a person can read it',
    `hidden ${skew.mismatched?.hidden}, ${JSON.stringify(skew.mismatched?.notices ?? null)}`);
    check(JSON.stringify(skew.matched?.hook) === '[]'
      && skew.matched?.hidden === true
      && JSON.stringify(skew.matched?.notices) === '[]',
    'while the same document at the version this build has says nothing, so the notice is about the disagreement rather than about the effect',
    `hook ${JSON.stringify(skew.matched?.hook ?? null)}, hidden ${skew.matched?.hidden}, ${JSON.stringify(skew.matched?.notices ?? null)}`);

    // The other half of the `suppressed` rule, and it is the half with no throw in it.
    const adopted = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const p = k.library.serialiseProjectBody();
      p.suppressed = [{ id: 'sparkle', version: '1.0.0' }];
      try { k.library.restoreProject(p); } catch (e) { return { threw: String(e.message ?? e) }; }
      return {
        threw: null,
        suppressed: k.library.missingEffects().filter((m) => m.suppressed).length,
        body: Object.hasOwn(k.library.serialiseProjectBody(), 'suppressed'),
      };
    })()`);
    check(adopted.threw === null && adopted.suppressed === 0 && adopted.body === false,
      'a well-formed suppressed record loads and is not adopted - it says what a render went without, not what this editor may skip',
      adopted.threw ?? `${adopted.suppressed} suppressed on the page, key written back: ${adopted.body}`);

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
    const real = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      try {
        return { spec: typeof k.params.spec('bloom').max, normalised: k.params.normalise('bloom', 0.75), set: k.params.set('bloom', 0.75), got: k.params.get('bloom') };
      } catch (e) { return { error: e.message }; }
    })()`);
    check(real.spec === 'number' && Number.isFinite(real.normalised) && real.got === real.set,
      'while a parameter the registry does declare passes through all four unchanged',
      JSON.stringify(real));
    await page.evaluate('globalThis.__kinect.params.reset()');

    check(errors.length === 0, 'the document path raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  console.log('\n[library] presets carry look and a provenance stamp');
  {
    const { page, errors } = await openPage(browser, editorPage(macUrl, 'local-clip'), { width: 640, height: 400 });
    await page.waitForFunction('Boolean(globalThis.__kinect?.timeline?.transport())', null, { timeout: 40000 });
    await page.evaluate('globalThis.__kinect.timeline.settled()');

    // A preset saved off a Blackwall clip whose values have then been moved away from.
    const TUNED = { bloom: 0.9, trails: 0.11, 'rgbsplit.amount': 2.7, 'grain.amount': 0.77, pointSize: 30.5 };
    await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      k.params.apply({ readRgb: 0, 'blackwall.amount': 1 });
      k.params.apply(${JSON.stringify(TUNED)});
      const res = await fetch('/presets/hand-tuned?rev=' + await globalThis.__rev('presets', 'hand-tuned'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(k.library.presetFromCurrentLook()),
      });
      return res.json();
    })()`);

    const onDisk = readFileSync(join(WORK, 'presets/hand-tuned.json'), 'utf8');
    const doc = JSON.parse(onDisk);
    check(doc.version === PROJECT_VERSION, 'a preset carries the format version too',
      `version ${doc.version}`);
    check(doc.values['blackwall.amount'] === 1 && doc.values.readRgb === 0,
      'the reading travels inside the values, like every other look parameter',
      `blackwall.amount ${doc.values['blackwall.amount']} readRgb ${doc.values.readRgb}`);
    check(!('mode' in doc), 'and there is no mode field left beside them');
    check(doc.values.bloom === TUNED.bloom && doc.values.pointSize === TUNED.pointSize,
      'and the look values it was saved with');
    check(!('camera' in doc.values) && !('renderScale' in doc.values),
      'composition and view state stay out of it - applying a look must not move your camera');

    // Applied onto a clip that has been moved away from it.
    const applied = await retryOnContextLoss('applying the preset', () => page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      k.params.apply({ 'blackwall.amount': 0, readRgb: 1 });
      k.params.apply({ bloom: 0, trails: 0, 'rgbsplit.amount': 0, 'grain.amount': 0, pointSize: 9 });
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
    check(applied.after.bloom === TUNED.bloom && applied.after['rgbsplit.amount'] === TUNED['rgbsplit.amount']
      && applied.after['grain.amount'] === TUNED['grain.amount'] && applied.after.pointSize === TUNED.pointSize,
      'applying a preset restores the values it was saved with, not a built-in look',
      `bloom ${applied.after.bloom} rgbsplit.amount ${applied.after['rgbsplit.amount']} pointSize ${applied.after.pointSize}`);
    check(applied.after['blackwall.amount'] === 1 && applied.after.readRgb === 0,
      'and it restores the reading, which needs no special case to travel',
      `blackwall.amount ${applied.after['blackwall.amount']}`);
    check(eq(applied.pose, applied.before.pose), 'and it does not move the camera');

    const diskRev = `sha256:${createHash('sha256').update(onDisk).digest('hex')}`;
    check(applied.stamp?.name === 'hand-tuned' && applied.stamp?.rev === diskRev,
      'the provenance stamp is the hash of the preset\'s bytes on disk',
      `${applied.stamp?.rev?.slice(7, 19)} against ${diskRev.slice(7, 19)}`);

    // On the clip, because a preset is a look and a look is the clip's.
    const inProject = await page.evaluate('globalThis.__kinect.library.serialiseProjectBody().clips[0].appliedPreset');
    check(eq(inProject, applied.stamp), 'and it travels in the project, so drift across a set of clips is visible');

    // The copy is what keeps a project self-contained.
    await page.evaluate(`(async () => {
      await fetch('/presets/hand-tuned?rev=' + await globalThis.__rev('presets', 'hand-tuned'), {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: ${PROJECT_VERSION}, values: { bloom: 0, pointSize: 9 } }),
      });
    })()`);
    const stillTuned = await page.evaluate("globalThis.__kinect.params.get('bloom')");
    check(stillTuned === TUNED.bloom,
      'editing the preset afterwards does not reach back into the clip - the values were copied in',
      `bloom ${stillTuned}`);

    // Five documents served out of a second, read-only root beside the user's own library.
    const shipped = JSON.parse(readFileSync(join(REPO, 'presets-builtin/blackwall.json'), 'utf8'));
    const shippedNames = readdirSync(join(REPO, 'presets-builtin'))
      .filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')).sort();
    const listed = await getJson(`${macUrl}/presets`);
    const listedBuiltin = listed.presets.filter((d) => d.builtin).map((d) => d.name).sort();
    check(shippedNames.length > 0 && eq(listedBuiltin, shippedNames),
      'every look that ships is listed, and says it ships',
      `${listedBuiltin.join(' ')} against ${shippedNames.join(' ')}`);

    // Applying a preset writes only the keys it names, and that is deliberate.
    const core = await page.evaluate('globalThis.__kinect.coreLookNames()');
    const shippedDocs = [];
    for (const name of shippedNames) {
      let values = null;
      let requires;
      try {
        const doc = await getJson(`${macUrl}/presets/${name}`);
        if (doc?.body?.values && typeof doc.body.values === 'object') {
          values = doc.body.values;
          requires = doc.body.requires;
        }
      } catch { /* an answer that is not a document is a document that did not come back */ }
      shippedDocs.push({ name, values, requires });
    }
    const readable = shippedDocs.filter((d) => d.values !== null);
    check(readable.length === shippedNames.length && readable.length > 0,
      'and each of them comes back through the route the picker reads, so the rows below compare something',
      `${readable.length} of ${shippedNames.length} documents read, against ${core.length} core values every look owes`);

    // One evaluate over the whole readable set rather than one per document.
    const analysis = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const core = k.coreLookNames();
      const docs = ${JSON.stringify(readable.map((d) => ({ name: d.name, values: d.values, requires: d.requires ?? [] })))};
      return docs.map((d) => {
        const names = Object.keys(d.values);
        const usedIds = [...new Set(names.map((n) => k.effectOf(n)).filter(Boolean))];
        const requiresIds = d.requires.map((r) => r.id);
        const required = [...core, ...requiresIds.flatMap((id) => k.effectParamNames(id))];
        return {
          name: d.name,
          missing: required.filter((n) => !names.includes(n)),
          extra: names.filter((n) => !required.includes(n)),
          touchedNotRequired: usedIds.filter((id) => !requiresIds.includes(id)),
          requiredNotTouched: requiresIds.filter((id) => !usedIds.includes(id)),
        };
      });
    })()`);

    const say = (rows) => rows.map((r) => `${r.name}: ${r.keys.slice(0, 6).join(' ')}`
      + `${r.keys.length > 6 ? ` (+${r.keys.length - 6} more)` : ''}`).join('; ');
    const missing = analysis.map((d) => ({ name: d.name, keys: d.missing })).filter((d) => d.keys.length > 0);
    check(missing.length === 0,
      "every look that ships names every value coreLookNames() and its own requires say it owes",
      missing.length ? say(missing) : `all ${readable.length} name everything they claim`);
    const extra = analysis.map((d) => ({ name: d.name, keys: d.extra })).filter((d) => d.keys.length > 0);
    check(extra.length === 0,
      'and none of them names a value that is not one of those',
      extra.length ? say(extra) : `all ${readable.length} name nothing beyond what they claim`);

    const requiresMismatch = analysis
      .map((d) => ({
        name: d.name,
        keys: [...d.touchedNotRequired.map((id) => `+${id}`), ...d.requiredNotTouched.map((id) => `-${id}`)],
      }))
      .filter((d) => d.keys.length > 0);
    check(requiresMismatch.length === 0,
      "and each one's requires list names exactly the effects its own values touch",
      requiresMismatch.length ? say(requiresMismatch) : `all ${readable.length} requires lists agree with their values`);

    const builtinPath = join(WORK, 'builtin-presets/blackwall.json');
    const bytesBefore = readFileSync(builtinPath, 'utf8');
    const forkBody = { version: PROJECT_VERSION, requires: shipped.requires, values: { ...shipped.values, bloom: 0.95 } };
    await writeDoc(macUrl, 'presets', 'blackwall', forkBody);
    check(readFileSync(builtinPath, 'utf8') === bytesBefore,
      'saving over a shipped look leaves the shipped file byte-identical',
      `${bytesBefore.length} bytes`);
    const forkPath = join(WORK, 'presets/blackwall.json');
    check(existsSync(forkPath), 'and the save landed in the user\'s own library instead',
      existsSync(forkPath) ? readdirSync(join(WORK, 'presets')).join(' ') : 'no fork on disk');
    const afterFork = await getJson(`${macUrl}/presets/blackwall`);
    check(afterFork.builtin === false && afterFork.body.values.bloom === 0.95,
      'and reading the name now answers the fork, not the look it was forked from',
      `builtin=${afterFork.builtin} bloom=${afterFork.body.values.bloom}`);

    await writeDoc(macUrl, 'presets', 'blackwall', null, 'DELETE');
    const afterRemove = await getJson(`${macUrl}/presets/blackwall`);
    check(afterRemove.builtin === true && afterRemove.body.values.bloom === shipped.values.bloom,
      'and removing the fork brings the shipped look back',
      `builtin=${afterRemove.builtin} bloom=${afterRemove.body.values.bloom}`);

    // An unreadable user directory is not an empty one.
    const brokenRoot = join(WORK, 'presets-that-are-a-file');
    writeFileSync(brokenRoot, 'a file where a directory should be\n');
    const brokenUrl = await startServer(root, ['--captures', macCaps, '--name', 'broken-library',
      '--presets', brokenRoot, '--builtin-presets', join(WORK, 'builtin-presets')], MAC_PORT + 14);
    const brokenRes = await fetch(`${brokenUrl}/presets`);
    const brokenText = await brokenRes.text();
    check(!brokenRes.ok, 'a preset directory that cannot be read is reported rather than listed as empty',
      `${brokenRes.status} ${brokenText.slice(0, 90)}`);
    let brokenListed = [];
    try { brokenListed = (JSON.parse(brokenText).presets ?? []).map((d) => d.name); } catch { /* not JSON is fine */ }
    check(brokenListed.length === 0,
      'and the shipped looks are not served in its place, which would read as a library with no forks',
      brokenListed.join(' ') || 'nothing listed');
    const freshUrl = await startServer(root, ['--captures', macCaps, '--name', 'fresh-library',
      '--presets', join(WORK, 'presets-never-made'), '--builtin-presets', join(WORK, 'builtin-presets')],
    MAC_PORT + 15);
    const fresh = await getJson(`${freshUrl}/presets`);
    check(fresh.presets.length > 0 && fresh.presets.every((d) => d.builtin),
      'while a user directory that was simply never made still lists the shipped looks and nothing else',
      `${fresh.presets.length} presets, ${fresh.presets.filter((d) => d.builtin).length} shipped`);
    // And the same failure read where an operator would be standing.
    {
      const { page: hurt, errors: hurtErrors } = await openPage(browser, editorPage(brokenUrl, 'local-clip'));
  // `#tNote` is what `ui.note` is, so the sentence an operator reads is the one asserted.
      const held = await hurt.waitForFunction(
        '(() => { const t = document.getElementById("tNote")?.textContent ?? ""; return t.includes("library unavailable") ? t : null; })()',
        null, { timeout: 30000 },
      ).catch(() => null);
      const note = held ? String(await held.jsonValue())
        : await hurt.evaluate('document.getElementById("tNote")?.textContent ?? ""');
      check(/library unavailable/.test(note) && /presets/.test(note),
        'an editor whose preset library will not load says so instead of drawing an empty picker',
        note.slice(0, 120) || 'the note is empty');
      check(/cannot be read/.test(note),
        'and the note carries the server\'s reason rather than the shape of the crash',
        note.slice(0, 120) || 'the note is empty');
      const thrown = hurtErrors.filter((e) => !/Failed to load resource/.test(e));
      check(thrown.length === 0, 'and reporting it raises no uncaught page errors',
        thrown.slice(0, 2).join(' | ') || 'none beyond the 500 this page is about');
      await hurt.close();
    }
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 14 || sv.port === MAC_PORT + 15)) {
      p.child.kill('SIGKILL');
    }

    // A preset from a version this build does not read - and which refusal it gets.
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
      'a version older than this build says so rather than blaming the units',
      refusedOld.slice(0, 130));
    check(/later build/.test(refusedFuture) && !/no path from here/.test(refusedFuture),
      'and a version from a later build gets its own answer rather than the older one\'s',
      refusedFuture.slice(0, 130));
    const refusedJunk = await refusalFor('\'not-a-version\'');
    check(refusedJunk !== 'ACCEPTED' && /absent or is not a number/.test(refusedJunk)
      && !/no path from here/.test(refusedJunk) && !/later build/.test(refusedJunk),
      'and a version field that is not a number is placed as neither',
      refusedJunk.slice(0, 130));

    check(errors.length === 0, 'the preset path raises no page errors', errors.slice(0, 2).join(' | '));
    await page.close();
  }

  console.log('\n[library] marks on the editor\'s scrubber, through the retime curve');
  {
    const { page, errors } = await openPage(browser, editorPage(macUrl, 'local-clip'), { width: 1100, height: 700 });
    await page.waitForFunction('Boolean(globalThis.__kinect?.timeline?.transport())', null, { timeout: 40000 });
    await page.evaluate('globalThis.__kinect.timeline.settled()');

    // `timeline.settled()` settles the transport, and the marks are not on it.
    await page.waitForFunction('globalThis.__kinect.library.marks().length > 0', null, { timeout: 15000 })
      .catch(() => {});
    const marks = await page.evaluate('globalThis.__kinect.library.marks()');
    check(marks.length === 4, 'the take\'s marks are loaded with it', `${marks.length} marks`);
    check(marks.every((m, i) => i === 0 || m.sourceMs >= marks[i - 1].sourceMs),
      'and they arrive in source order');

    const flat = await page.evaluate('globalThis.__kinect.library.markTicks()');
    check(flat.length === marks.length, 'every mark draws a tick on the ruler', `${flat.length} ticks`);
    check(flat[0]?.left === 0, 'a mark at source zero ticks at the left edge');
    check(flat[flat.length - 1]?.beyond === true,
      'and a mark the edit never reaches is drawn at the edge as unreachable rather than dropped');

    // The probe has to stand where a wrong implementation would disagree.
    const KEYS = [{ t: 0, value: 0 }, { t: 4, value: 0.6 }, { t: 6, value: 2.4 }];
    await page.evaluate(`globalThis.__kinect.keyframes.setRetime({ rate: 1, keys: ${JSON.stringify(KEYS)} })`);
    await page.evaluate('globalThis.__kinect.timeline.settled()');
    const retimed = await page.evaluate('globalThis.__kinect.library.markTicks()');
    const shown = await page.evaluate('globalThis.__kinect.timeline.read()');
    check(retimed.length === flat.length, 'a retime does not lose a tick');

    // Asserted against positions computed here, not against "they moved".
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
    // Where the wrong implementation would draw each tick.
    const naive = marks.map((m) => pct(m.sourceMs / 1000 / shown.duration));
    const off = marks.map((_, i) => Math.abs((retimed[i]?.left ?? Infinity) - expected[i]));
    const discriminating = marks.map((_, i) => i).filter((i) => Math.abs(expected[i] - naive[i]) > 5);
    check(discriminating.length >= 2,
      'at least two marks land somewhere the source fraction cannot, which is what makes them probes',
      marks.map((m, i) => `${(m.sourceMs / 1000).toFixed(1)}s: curve ${expected[i].toFixed(1)}% against fraction ${naive[i].toFixed(1)}%`).join('; '));
    check(discriminating.every((i) => off[i] < 1.5),
      'and each tick sits where the curve puts it rather than where the fraction would',
      marks.map((m, i) => `${(m.sourceMs / 1000).toFixed(1)}s -> ${retimed[i]?.left?.toFixed(1) ?? 'missing'}% (want ${expected[i].toFixed(1)}%)`).join('; '));

    // A mark written from the editor lands in the take's sidecar.
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

  console.log('\n[library] download verifies, reclaim keeps a verified copy, delete is the last one');
  {
    // The remote take deliberately shares a *filename* with a different local take.
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

    const stagedLib = await import(pathToFileURL(join(root, 'server/library.js')).href);
    const { freeBytes } = await stagedLib.remaining(macCaps);
    const tooBig = await stagedLib.downloadTake({ url: 'http://127.0.0.1:9' },
      { id: 'a-take-too-big-to-land', bytes: freeBytes * 2, hash: `sha256:${'ab'.repeat(32)}` }, macCaps)
      .then(() => null, (err) => String(err.message));
    check(tooBig !== null && /free/.test(tooBig)
      && !existsSync(join(macCaps, 'a-take-too-big-to-land.knct.part')),
      'a download that cannot fit on the capture volume is refused before a byte moves, with the recording headroom kept out of it',
      (tooBig ?? 'IT DOWNLOADED').slice(0, 90));
    const fits = await stagedLib.downloadTake({ url: 'http://127.0.0.1:9' },
      { id: 'a-take-that-fits', bytes: 1024, hash: `sha256:${'cd'.repeat(32)}` }, macCaps)
      .then(() => null, (err) => String(err.message));
    check(fits !== null && !/free/.test(fits),
      '  while one that fits is stopped only by the node stub being unreachable, so the gate is a gate rather than downloads switched off',
      (fits ?? 'IT DOWNLOADED').slice(0, 90));

    const shared = 'mac-name-for-it';
    await post(`${macUrl}/library/sync-marks/${shared}`, {});
    const merged = (await getJson(`${macUrl}/capture/${shared}/marks`)).marks;
    check(merged.length === 2 && merged.every((m) => m.id !== 'n3'),
      'a sync merges the node\'s log as a union and a tombstone stays dead',
      merged.map((m) => m.id).join(' '));
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

    // The falsification control, and it has to be a substitution the manifest cannot see.
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

    writeFileSync(localPath, good);
    rmSync(sidecarPath, { force: true });
    const fresh = (await getJson(`${macUrl}/library/all`)).takes.find((t) => t.id === bothTake.id);
    const done = await post(`${macUrl}/library/reclaim/${fresh.id}`, {});
    const nodeGone = !(await getJson(`${nodeUrl}/library/takes`)).takes.some((t) => t.hash === fresh.hash);
    check(done.reclaimed && done.keptHere === fresh.hash,
      'a reclaim against a verified copy removes the node\'s and names the survivor\'s hash');
    check(nodeGone && existsSync(localPath),
      'the node\'s copy is gone and the hash-verified one here is not');

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

  console.log('\n[library] every route that changes something requires its method, its type and its origin');
  {
    const guardDir = join(WORK, 'guarded');
    mkdirSync(guardDir, { recursive: true });
    writeTake(guardDir, 'guard-take', { frames: 6 });
    // Given its own document directories rather than left on the defaults.
    const guardDocs = join(WORK, 'guard-docs');
    const guardPresets = join(WORK, 'guard-presets');
    const guardUrl = await startServer(root, [
      '--captures', guardDir, '--name', 'guarded',
      '--projects', guardDocs, '--presets', guardPresets,
    ], MAC_PORT + 8);
    const table = (await getJson(`${guardUrl}/library/routes`)).routes;

    // The file tree must not answer for a namespace the route table owns.
    const tableNamespaces = [...new Set(table.map((r) => r.path.split('/')[1]))];
    check(tableNamespaces.length >= 5, 'the route table declares its namespaces, so this row grows when a step adds one',
      tableNamespaces.join(', '));

    // The probe is two segments deep, and the first version was not.
    const PROBE = 'shadow-probe/leak.js';
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
    // Removed again so the planted files cannot make any later row mean something different.
    for (const ns of [...tableNamespaces, CONTROL_NS]) rmSync(join(root, 'web', ns), { recursive: true, force: true });

    const mutating = table.filter((r) => r.mutates);
    // A route that also answers GET is a legitimate read at that method.
    const writeOnly = mutating.filter((r) => !r.read);
    const readable = table.filter((r) => r.read);
    // A count of registered routes cannot answer "did a read handler mutate something".
    const swept = new Set();
    console.log(`  ...   ${table.length} routes, ${mutating.length} mutating, `
      + `${writeOnly.length} of those write-only, ${readable.length} answering GET`);

    const concrete = (path, { id = 'no-such-take', name = 'no-such-document' } = {}) => {
      const built = path
        .replace(':id', id)
        .replace(':name', name)
        .replace(':hash', '0'.repeat(64))
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
      const contentType = r.contentType;
      // Method: a GET that is otherwise perfectly formed.
      if (!r.read && await status(r.path, { headers: { 'Content-Type': contentType } }) !== 405) wrongMethod.push(r.path);
      // Content type: the right method, declaring text/plain.
      if (await status(r.path, { method, headers: { 'Content-Type': 'text/plain' }, body: '{}' }) !== 415) wrongType.push(r.path);
      // Origin: everything right except the page it claims to come from.
      if (await status(r.path, {
        method,
        headers: { 'Content-Type': contentType, Origin: 'http://evil.invalid' },
        body: '{}',
      }) !== 403) wrongOrigin.push(r.path);
      if (GUARDED.has(await status(r.path, { method, headers: { 'Content-Type': contentType }, body: '{}' }))) {
        refusedOutright.push(r.path);
      }
    }
    check(wrongMethod.length === 0,
      `every route that only changes things refuses a GET (${writeOnly.length} of ${mutating.length} mutating routes)`,
      wrongMethod.join(' ') || 'all 405');
    check(wrongType.length === 0,
      'every mutating route refuses a body with a simple content type', wrongType.join(' ') || 'all 415');
    check(wrongOrigin.length === 0,
      'every mutating route refuses a cross-origin caller', wrongOrigin.join(' ') || 'all 403');
    check(refusedOutright.length === 0,
      'and the shape the node link uses - right method, declared content type, no Origin header - is let through, which is what stops this being a guard that refuses everything',
      refusedOutright.join(' ') || `${mutating.length} routes reached their handler`);

    // A refusal has to mean the route did not act, which a status code does not say on its own.
    const shootDir = join(WORK, 'guard-shooting');
    const shootProjects = join(WORK, 'guard-shooting-projects');
    const shootPresets = join(WORK, 'guard-shooting-presets');
    const shootDeliverables = join(WORK, 'guard-shooting-deliverables');
    for (const d of [shootDir, shootProjects, shootPresets, shootDeliverables]) {
      rmSync(d, { recursive: true, force: true });
      mkdirSync(d, { recursive: true });
    }
    // All six stores, and a closed take beside the open one.
    const closedTake = writeTake(shootDir, 'a-closed-take', { frames: 6 });
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

    // Every read route driven, and every store this server owns asserted not to have moved.
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
      // `/projects` is the page; the listing under it is `/projects/all`, so a read of the bare
      // namespace here answered with HTML and the snapshot died parsing it.
      projectRevs: (await getJson(`${shootUrl}/projects/all`)).projects?.map((d) => `${d.name}=${d.rev}`) ?? null,
      presetRevs: (await getJson(`${shootUrl}/presets`)).presets?.map((d) => `${d.name}=${d.rev}`) ?? null,
      deliverableRevs: (await getJson(`${shootUrl}/deliverables`)).deliverables?.map((d) => `${d.name}=${d.rev}`) ?? null,
      recorder: await getJson(`${shootUrl}/record/state`).then((s) => `${s.recording}:${s.takeId}:${s.dropped}`),
    });
    const descriptorsNow = async () => (await getJson(`${shootUrl}/library/descriptors`)).real;

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
            // 409 is `beingRecorded` answering before the handler runs.
            if (code !== 409) reached.set(r.path, `${code} on ${id === shooting.takeId ? 'the open take' : 'a closed take'}`);
          }
        }
      }
    }
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
    check(writesAfter === writesBefore,
      'not one of them writes a store even momentarily - a count no restore can undo, which is what a handler that writes and puts it back defeats a contents comparison with',
      `${writesBefore} then ${writesAfter}`);
    check(after === before,
      'and none of it moves a byte in any of the five stores, their sidecars or the recorder',
      after === before ? `${namespaces.length} namespaces and the file tree swept alongside, nothing moved`
        : `${before}\n              then ${after}`);
    // The descriptor count is deliberately not a row here.
    console.log(`  ...   ${fdBefore} descriptors before the sweep, ${fdAfter} after `
      + '(sockets included, which is why it is not a row - see section 9)');
    check(!existsSync(join(shootDir, `${shooting.takeId}.idx`)),
      'and the take still being written has no sidecar - the closed one beside it was scanned and this one was not',
      readdirSync(shootDir).sort().join(' '));

    // Three observations are switched off at once for the file being recorded.
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

    // Marks used to be creatable for a take that does not exist.
    const ghost = await post(`${guardUrl}/capture/nosuchtake/marks`,
      { marks: [{ id: 'x', sourceMs: 1, at: 1, label: 'planted' }] });
    check(/nothing to mark|no take/.test(ghost.error ?? ''),
      'marks on a take that is not here are refused rather than creating its sidecar',
      (ghost.error ?? 'ACCEPTED').slice(0, 70));
    check(!existsSync(join(guardDir, 'nosuchtake.marks.jsonl')),
      'and nothing was written to the captures directory',
      readdirSync(guardDir).join(' '));

    const FUTURE = PROJECT_VERSION + 1;
    const future = await writeDoc(guardUrl, 'projects', 'from-the-future', { version: FUTURE, tracks: {}, futureField: 'kept' });
    check(new RegExp(`version ${FUTURE}`).test(future.error ?? ''),
      'a document from a future format version is refused rather than restamped as this one',
      (future.error ?? 'ACCEPTED').slice(0, 80));
    const stored = await getJson(`${guardUrl}/projects/from-the-future`);
    check(stored.error !== undefined,
      'and nothing was written, so a project this build cannot interpret never enters the store at all');
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 8)) p.child.kill('SIGKILL');
    // The control probe above is a write that succeeds.
    rmSync(guardDocs, { recursive: true, force: true });
    rmSync(guardPresets, { recursive: true, force: true });
  }

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

  console.log('\n[library] a take removed while a reader holds it still gives its descriptor back');
  {
    const leaseDir = join(WORK, 'leased');
    mkdirSync(leaseDir, { recursive: true });
    // Big enough that the run cannot fit in socket buffers.
    writeTake(leaseDir, 'leased-take', { frames: 200 });
    const url = await startServer(root, ['--captures', leaseDir, '--name', 'leasing'], MAC_PORT + 11);
    const take = (await getJson(`${url}/library/takes`)).takes.find((t) => t.id === 'leased-take');
    const baseline = await getJson(`${url}/library/descriptors`);
    check(Number.isInteger(baseline.real),
      'the server reports the descriptors the kernel says it holds, not only the ones its own map remembers',
      `open ${baseline.open}, real ${baseline.real}`);

    const sock = createConnection(MAC_PORT + 11, 'localhost');
    await new Promise((done, fail) => { sock.on('connect', done); sock.on('error', fail); });
    // Read exactly enough to know the response started.
    let received = 0;
    sock.on('data', (c) => { received += c.length; sock.pause(); });
    sock.write(`GET /capture/leased-take/frames/0-${take.frames - 1} HTTP/1.1\r\nHost: localhost:${MAC_PORT + 11}\r\nConnection: close\r\n\r\n`);
    await new Promise((done) => { setTimeout(done, 1200); });
    const held = await getJson(`${url}/library/descriptors`);
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
    check(afterDelete.open === 0 && afterDelete.real === held.real && held.real > baseline.real,
      'the module\'s own count drops to zero while the descriptor is genuinely still there - a precondition for the rows below rather than a catch, and the reason this arm reads /dev/fd',
      `open ${afterDelete.open}, real ${afterDelete.real} against a baseline of ${baseline.real}`);

    sock.destroy();
    // Polled inside a catch, because the failure mode is the server going away.
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

  console.log('\n[library] the recorder holds its marks and bounds its buffer');
  {
    // A take whose sidecar was never written has no marks.
    const marksOf = (id) => {
      try {
        return readFileSync(join(WORK, 'recorder-unit', `${id}.marks.jsonl`), 'utf8').trim().split('\n').filter(Boolean);
      } catch {
        return [];
      }
    };
    // Imported out of the staged tree rather than out of the repo.
    const { Recorder, MAX_TAKE_BUFFER } = await import(pathToFileURL(join(root, 'server/recorder.js')).href);
    const recDir = join(WORK, 'recorder-unit');
    mkdirSync(recDir, { recursive: true });
    const hello = SRC.hello.toString('utf8');

    // A take that dies mid-write used to null itself without flushing.
    const one = new Recorder({ dir: recDir });
    await one.start(null);
    one.open(hello);
    const firstTake = one.state.takeId;
    one.write(SRC.frames[0]);
    one.mark(1234, 'the moment');
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

    // The requirement this arm holds the ceiling to is written down here rather than imported.
    const CEILING_REQUIRED = 64 * 1024 * 1024;
    const CEILING_TOLERANCE = 0.10;
    const FULL_RATE_FPS = 30;
    const RIDE_OUT_SEC = 4;

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
    for (let i = 0; i < BURST; i++) {
      const frame = SRC.frames[i % SRC.frames.length];
      four.write(frame);
      // Read off the take rather than through `state`, for the same reason.
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

    // `write` pushes a frame end-offset per frame and `settle` is what removes them.
    const PER_CHUNK = 500;
    const CHUNKS = 40;
    const smallFrame = (n) => {
      const payload = Buffer.alloc(1024);
      payload.writeUInt32LE(1008, 0);
      payload.writeUInt32LE(0, 4);
      payload.writeBigUInt64LE(BigInt(n * 33), 8);
      return encodeMessage(TYPE_FRAME, payload);
    };
    // Everything the stream is holding has reached the descriptor.
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
      five.write(smallFrame(written++));
      deepest = Math.max(deepest, five.take.inFlight.length - five.take.inFlightHead);
      longest = Math.max(longest, five.take.inFlight.length);
    }
    // Held past the close, which nulls the recorder's reference.
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
    check(listed?.openRefusals?.length === 1 && listed.openRefusals[0].key === 'recording'
      && typeof listed.openRefusals[0].why === 'string' && listed.openRefusals[0].why !== ''
      && listed.openable === (listed.openRefusals.length === 0),
      'and the reason is on the take rather than only in the boolean, with openable following the list here too',
      JSON.stringify(listed?.openRefusals));
    // The missing hash is load-bearing on the menu, so it is asserted as that too.
    const resolvable = (await getJson(`${url}/library/all`)).takes;
    const shooting = resolvable.filter((t) => t.recording === true);
    check(shooting.length > 0 && shooting.every((t) => t.hash === null),
      'and the response the menu resolves against gives it no hash, so nothing the menu can look up is a take being recorded',
      `${shooting.length} recording, hashes ${JSON.stringify(shooting.map((t) => t.hash))}`);

    // Neither removal can verify anything about a file that is still arriving.
    const refusedDelete = await post(`${url}/library/delete/${open.takeId}`, { hash: 'sha256:whatever', confirm: true });
    check(/being recorded/.test(refusedDelete.error ?? ''),
      'delete refuses the take the recorder has open', (refusedDelete.error ?? 'ACCEPTED').slice(0, 70));
    check(existsSync(join(liveDir, `${open.takeId}.knct`)), 'and the file is still there');

    {
      const { page, errors } = await openPage(browser, libraryPage(url));
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
      // Every control that would change something is disabled.
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
      check(errors.length === 0, 'the library raises no page errors while a take is being written',
        errors.slice(0, 2).join(' | '));
      await page.close();
    }

    const stopped = (await post(`${url}/record/stop`)).stopped;
    const afterStop = (await getJson(`${url}/library/takes`)).takes.find((t) => t.id === open.takeId);
    check(existsSync(join(liveDir, `${open.takeId}.idx`)) && stopped?.hash?.startsWith('sha256:'),
      'and once it closes it is scanned exactly once, which is what makes it a library entry',
      `${stopped?.frames} frames, ${String(stopped?.hash).slice(7, 19)}`);
    check(afterStop?.recording === false && afterStop.hash === stopped?.hash && afterStop.frames === stopped?.frames,
      'the listing then carries the hash and the frame count the scan produced');
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 12)) p.child.kill('SIGKILL');
  }

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

  console.log('\n[library] the sensor answers for its own health, and a window with no frames in it still closes');
  const liveDir = join(WORK, 'health-live');
  rmSync(liveDir, { recursive: true, force: true });
  mkdirSync(liveDir, { recursive: true });
  // Spawned here and killed at the end of section 14.
  const liveUrl = await startServer(root, [
    '--captures', liveDir, '--name', 'shooting-live', '--record', '--no-color',
    '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
  ], MAC_PORT + 1);
  {
    const table = (await getJson(`${macUrl}/library/routes`)).routes;
    const entry = table.find((r) => r.path === '/sensor/health');
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
    check(health.dropped === undefined,
      'and nothing on it is called `dropped` unqualified, since the only count here is monitors failing to keep up with the output rather than the sensor failing to deliver',
      `dropped=${JSON.stringify(health.dropped)}, monitorDropped=${health.monitorDropped}`);
    check(['lost', 'absent', 'starting'].includes(health.state) && health.respawns >= 1,
      'a server with no sensor says so and counts the grabbers it has been through, which is the flapping question the backoff\'s own counter cannot answer',
      `state ${health.state}, ${health.respawns} respawns`);

    // The window that closed last, on a server where no window has ever carried a frame.
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
    const rates = await getJson(`${macUrl}/sensor/health`);
    check(rates.fps === 0 && rates.bytesPerSec === 0,
      'and the rate is left alone by an empty window rather than recomputed over it - on this server there has never been one, so it is still nothing',
      `${rates.fps} fps, ${rates.bytesPerSec} B/s after ${(uptimeMs / 1000).toFixed(0)}s of empty windows`);

    // Steady delivery, which never takes the early return at all.
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

    // A restart somebody asked for is not the sensor flapping.
    const toggleDir = join(WORK, 'health-toggle');
    rmSync(toggleDir, { recursive: true, force: true });
    mkdirSync(toggleDir, { recursive: true });
    const toggleUrl = await startServer(root, [
      '--captures', toggleDir, '--name', 'toggling', '--no-color',
      '--grabber', `${join(REPO, 'tools/fake-grabber.mjs')} --source ${SAMPLE} --fps 40`,
    ], MAC_PORT + 13);
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
    check(totalSpawns(afterToggle) === totalSpawns(beforeToggle) + 1,
      'the colour toggle really did stop the grabber and start another, so the rows below are about a restart that happened',
      `${totalSpawns(beforeToggle)} grabbers before, ${totalSpawns(afterToggle)} after`);
    check(afterToggle.respawns === 0,
      'and the health endpoint does not report it as the sensor having dropped, because a configuration change is not a fault',
      `${afterToggle.respawns} respawns after the toggle`);
    check(afterToggle.restarts === 1,
      'it is counted as the requested restart it is, beside the respawns rather than folded into them - or a node that restarted forty times for forty toggles would read as never having restarted at all',
      `${afterToggle.restarts} restarts`);

    // And the number gets there without passing through a lie.
    const toggleProc = servers.find((sv) => sv.port === MAC_PORT + 13)?.child;
    const grabberUnder = (root) => {
  // `-ww` because macOS `ps` truncates the command at the terminal width by default.
      const rows = execFileSync('ps', ['-ww', '-Ao', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim().split('\n');
      const parsed = rows.map((r) => r.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean);
      const family = new Set([root]);
      for (let grew = true; grew;) {
        grew = false;
        for (const m of parsed) {
          if (family.has(Number(m[2])) && !family.has(Number(m[1]))) { family.add(Number(m[1])); grew = true; }
        }
      }
      // The server is excluded by name as well as by pid, because it also matches.
      return parsed
        .filter((m) => family.has(Number(m[1])) && Number(m[1]) !== root
          && /fake-grabber/.test(m[3]) && !/server\/index\.js/.test(m[3]))
        .map((m) => Number(m[1]));
    };
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

    // Sampled across the whole of the next restart rather than at its ends.
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

  console.log('\n[library] the library page follows the recorder rather than the moment it was loaded');
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

    const { page, errors } = await openPage(browser, libraryPage(liveUrl));
    await page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    let polls = 0;
    page.on('request', (req) => { if (req.url().endsWith('/record/state')) polls++; });

    const flagsOf = async (id) => page.evaluate(`(() => {
      const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(id)});
      return t ? { flags: t.flags, acts: t.acts } : null;
    })()`);
    const before = await flagsOf(shooting.takeId);
    check(before?.flags?.includes('recording') === true,
      'the tile of the take being written says so, and its Open is refused behind that',
      `flags ${before?.flags?.join(',')}, Open ${before?.acts?.find((a) => a.item === 'new-project')?.disabled ? 'disabled' : 'enabled'}`);

    // A property on the node itself, because that is what a repaint destroys.
    await page.evaluate("document.querySelector('.tile').__quietProbe = 'planted'");
    const pollsAtProbe = polls;
    // Comfortably longer than one cadence rather than barely.
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

    // The same page on the machine it is actually used from, which is not this one.
    const linkedDir = join(WORK, 'linked-library');
    rmSync(linkedDir, { recursive: true, force: true });
    mkdirSync(linkedDir, { recursive: true });
    const linkedUrl = await startServer(root, [
      '--captures', linkedDir, '--name', 'mac-editing',
      '--node', liveUrl, '--node-name', 'shooting-live',
    ], MAC_PORT + 12);
    const linked = await openPage(browser, libraryPage(linkedUrl));
    await linked.page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    let linkedPolls = 0;
    linked.page.on('request', (req) => { if (req.url().endsWith('/record/state')) linkedPolls++; });
    const linkedFlags = async (id) => linked.page.evaluate(`(() => {
      const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(id)});
      return t ? { flags: t.flags, acts: t.acts } : null;
    })()`);
    const actLabels = (t) => (t?.acts ?? []).map((a) => `${a.label}${a.disabled ? ' (off)' : ''}`).join(' ') || '(none)';
    const remoteBefore = await linkedFlags(shooting.takeId);
    check(remoteBefore?.flags?.includes('recording') === true
      && remoteBefore?.acts?.find((a) => a.item === 'new-project')?.disabled === true,
      'a station with no sensor of its own draws the node\'s open take into its grid, says it is being written, and refuses every action behind that',
      `flags ${remoteBefore?.flags?.join(',') ?? '(no tile)'}, acts ${actLabels(remoteBefore)}`);
    const linkedOwn = await getJson(`${linkedUrl}/record/state`);
    check(linkedOwn.recording === false && linkedOwn.node?.recording === true,
      'and its own recorder is idle while the node it names is shooting, which is the split that made the local flag useless here',
      `local ${linkedOwn.recording}, node ${linkedOwn.node?.name} ${linkedOwn.node?.recording} (reachable ${linkedOwn.node?.reachable})`);

    // A take stops being recorded several seconds before it stops being the recorder's.
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

    // And the half the gate is not allowed to swallow.
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
    check(linked.errors.length === 0, 'and the linked library raises no page error while it follows',
      linked.errors.slice(0, 2).join(' | '));
    await linked.page.close();
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 12)) p.child.kill('SIGKILL');

    const after = await flagsOf(shooting.takeId);
    check(after?.flags?.includes('recording') === false,
      'and a tick in which the recorder stopped repaints, so the tile stops claiming a finished take is still being written',
      `flags ${after?.flags?.join(',') || '(none)'}`);
    check(after?.acts?.find((a) => a.item === 'new-project')?.disabled === false,
      'and its Open, Download, Rename and Remove come back without anybody reloading the page',
      after?.acts?.map((a) => `${a.label}${a.disabled ? ' (off)' : ''}`).join(' '));
    const probeAfter = await page.evaluate("document.querySelector('.tile')?.__quietProbe ?? null");
    check(probeAfter === null,
      'which is a genuine repaint rather than a tile edited in place, since the nodes the tick found are gone',
      String(probeAfter));

    check(errors.length === 0, 'and the library raises no page error while it follows', errors.slice(0, 2).join(' | '));
    await page.close();

    // A node that did not answer is not a node with nothing on it.
    const blindNodeUrl = await startServer(root, [
      '--captures', macCaps, '--name', 'mac-blind',
      // Inside the reserved span, and that is the whole reason for the offset.
      '--node', `http://127.0.0.1:${MAC_PORT + 16}`, '--node-name', 'a-node-that-is-not-there',
    ], MAC_PORT + 11);
    const dark = await openPage(browser, libraryPage(blindNodeUrl));
    await dark.page.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const darkState = await dark.page.evaluate('globalThis.__library.state()');
    const darkTiles = await dark.page.evaluate('globalThis.__library.tiles()');
    check(darkState.node?.reachable === false && darkTiles.length > 0,
      'the station has a node it cannot reach and takes of its own on screen, which is the pair the row below needs',
      `node ${darkState.node?.name} reachable ${darkState.node?.reachable}, ${darkTiles.length} tiles`);
    // Delete is an act, and the first draft of these two rows looked for it in the ⋯ menu.
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
    check(dark.errors.length === 0, 'and that library raises no page error', dark.errors.slice(0, 2).join(' | '));
    await dark.page.close();
    for (const p2 of servers.filter((sv) => sv.port === MAC_PORT + 11)) p2.child.kill('SIGKILL');

    // The gap between the listing the page paints and the first tick it compares against.
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
    const heldTicks = [];
    let releaseTicks = false;
    await blind.route('**/record/state', async (route) => {
      if (releaseTicks) { await route.continue(); return; }
      heldTicks.push(route);
    });
    await blind.goto(libraryPage(liveUrl), { waitUntil: 'domcontentloaded' });
    await blind.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const paintedMidWrite = await blind.evaluate(`(() => {
      const t = globalThis.__library.tiles().find((x) => x.id === ${JSON.stringify(shootingAgain?.takeId)});
      return t ? t.flags.includes('recording') : null;
    })()`);
    check(paintedMidWrite === true && heldTicks.length > 0,
      'the page painted that take as being written and every tick it has asked for is held at the edge, which is the state the gap leaves a real library in',
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
        return t && !t.flags.includes('recording') && t.acts.find((a) => a.item === 'new-project')?.disabled === false; })()`,
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

    // A refresh that fails is a transition the library has not seen yet.
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
      // The first listing is the page's own load and has to succeed.
      if (listings === 2) { refused++; await route.abort('connectionfailed'); return; }
      await route.continue();
    });
    await flaky.goto(libraryPage(liveUrl), { waitUntil: 'domcontentloaded' });
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
        return t && !t.flags.includes('recording') && t.acts.find((a) => a.item === 'new-project')?.disabled === false; })()`,
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
      'and the library comes back from it on a later tick, because a refresh that failed leaves the transition unseen rather than spending it',
      flakyTile === null ? 'no tile for that take' : `flags ${flakyTile.flags.join(',') || '(none)'}, acts ${flakyTile.acts.join(' ')}`);
    await flaky.close();

    // And the retry is bounded, which is the debt holding the fingerprint back took on.
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
      // The first is the page's own load and has to answer.
      if (hungListings === 1) { await route.continue(); return; }
      heldForever.push(route);
      heldAt.push(Date.now());
    });
    await hung.route('**/record/state', async (route) => { ticksSeen++; await route.continue(); });
    await hung.goto(libraryPage(liveUrl), { waitUntil: 'domcontentloaded' });
    await hung.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    await post(`${liveUrl}/record/stop`);
    await new Promise((done) => { setTimeout(done, 11000); });
    const heldCount = heldForever.length;
    const listingsWhileHung = hungListings;
    check(heldCount === 1,
      'it has exactly one listing in flight however long that one takes - a refresh that has not come back is the question already being asked, not a reason to ask it again every five seconds',
      `${heldCount} listings left hanging, ${hungListings} requested in total`);
    // The liveness half is that it comes back on its own.
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

    // The three rows above pin the poll against itself.
    const racer = await browser.newPage();
    const STALE_MARK = 'stale-listing-that-must-not-paint';
    let raceListings = 0;
    const heldOld = [];
    let realBody = null;
    await racer.route('**/library/all', async (route) => {
      raceListings++;
      if (raceListings === 1) {
        const answered = await route.fetch();
        realBody = await answered.text();
        await route.fulfill({ status: answered.status(), body: realBody, headers: answered.headers() });
        return;
      }
      if (raceListings === 2) { heldOld.push(route); return; }
      await route.continue();
    });
    await racer.goto(libraryPage(macUrl), { waitUntil: 'domcontentloaded' });
    await racer.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const older = racer.evaluate('__library.refresh()').catch(() => {});
    for (let i = 0; i < 40 && heldOld.length === 0; i++) await new Promise((d) => { setTimeout(d, 50); });
    check(heldOld.length === 1,
      'an older listing is genuinely in flight, which is what makes the newer one below a second caller rather than a sequence',
      `${heldOld.length} held, ${raceListings} listings so far`);
    // The newer caller, which answers normally and is the state the grid must end on.
    await racer.evaluate('__library.refresh()');
    const idsAfterNew = await racer.evaluate('__library.state().takes.map((t) => t.id ?? t.local?.id ?? t.remote?.id)');
    const stale = JSON.parse(realBody);
    stale.takes = [...stale.takes, { id: STALE_MARK, hash: `sha256:${'cd'.repeat(32)}`, local: null, remote: null }];
    await heldOld[0].fulfill({
      status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify(stale),
    });
    await older;
    await new Promise((done) => { setTimeout(done, 800); });
    const grid = await racer.evaluate('JSON.stringify(__library.state().takes.map((t) => t.id ?? t.local?.id ?? t.remote?.id))');
    check(!grid.includes(STALE_MARK),
      'and a listing that resolves after a newer one is discarded rather than painted, because two callers refreshing is not the same question as the poll refreshing twice',
      `${idsAfterNew.length} takes after the newer listing, and the grid holds ${grid.slice(0, 90)}`);
    await racer.close();

    // The row above proves the stale body is discarded.
    const chained = await browser.newPage();
    let chainListings = 0;
    const heldChain = [];
    await chained.route('**/library/all', async (route) => {
      chainListings++;
      if (chainListings === 1) { await route.continue(); return; }
      if (chainListings === 2) { heldChain.push(route); return; }
      await route.fulfill({
        status: 500, headers: { 'content-type': 'application/json' },
        body: '{"error":"the linked node dropped out mid-listing"}',
      });
    });
    await chained.goto(libraryPage(macUrl), { waitUntil: 'domcontentloaded' });
    await chained.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 });
    const olderOutcome = chained.evaluate(
      '__library.refresh().then(() => "resolved", (err) => `rejected: ${err.message}`)');
    for (let i = 0; i < 40 && heldChain.length === 0; i++) await new Promise((d) => { setTimeout(d, 50); });
    const newerOutcome = await chained.evaluate(
      '__library.refresh().then(() => "resolved", (err) => `rejected: ${err.message}`)');
    if (heldChain.length === 1) {
      await heldChain[0].fulfill({
        status: 200, headers: { 'content-type': 'application/json' }, body: realBody,
      });
    }
    const olderSaid = heldChain.length === 1 ? await olderOutcome : 'the listing was never held';
    check(heldChain.length === 1 && newerOutcome.startsWith('rejected') && olderSaid.startsWith('rejected'),
      'a superseded refresh reports the newer one\'s failure rather than a success of its own, so the poll leaves the transition unseen and offers it again',
      `held ${heldChain.length}; the newer caller was told "${newerOutcome.slice(0, 55)}" and the held one "${olderSaid.slice(0, 55)}"`);
    await chained.close();

    // The other way into the same poll, which the guard above nearly closed.
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
    // Pressed while one is in flight, which is the whole condition.
    await new Promise((done) => { setTimeout(done, 1200); });
    const requestsBeforePress = stateRequests;
    await slow.click('#recGo');
    // Long enough for the rerun to have gone out, and short enough that the cadence has not.
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

    // The bound belongs to the poll, and the first listing is the case it must not reach.
    const cold = await browser.newPage();
    let coldListings = 0;
    await cold.route('**/library/all', async (route) => {
      coldListings++;
      if (coldListings === 1) await new Promise((done) => { setTimeout(done, 18000); });
      await route.continue();
    });
    await cold.goto(libraryPage(liveUrl), { waitUntil: 'domcontentloaded' });
    let coldInstalled = true;
    await cold.waitForFunction('globalThis.__library !== undefined', null, { timeout: 30000 })
      .catch(() => { coldInstalled = false; });
    const coldTiles = coldInstalled ? await cold.evaluate('globalThis.__library.tiles().length') : 0;
    check(coldInstalled && coldTiles > 0,
      'a first listing slower than the poll\'s own bound still paints, because a cold library is the case that listing exists to get through rather than a link to give up on',
      coldInstalled ? `held 18s, ${coldTiles} tiles` : 'the page never installed its hook - module evaluation ended on the load');
    await cold.close();

    const broken = await browser.newPage();
    let brokenListings = 0;
    await broken.route('**/library/all', async (route) => {
      brokenListings++;
      if (brokenListings === 1) { await route.fulfill({ status: 500, body: 'the library is unavailable' }); return; }
      await route.continue();
    });
    await broken.goto(libraryPage(liveUrl), { waitUntil: 'domcontentloaded' });
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

    // And the same refusal in the shape this server actually sends it.
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
    await refusedPage.goto(libraryPage(liveUrl), { waitUntil: 'domcontentloaded' });
    let refusedInstalled = true;
    await refusedPage.waitForFunction('globalThis.__library !== undefined', null, { timeout: 20000 })
      .catch(() => { refusedInstalled = false; });
    check(refusedInstalled,
      'and a refusal that parses - the only kind this server sends - is not believed as a library, so the page still installs its hook',
      refusedInstalled ? 'installed after a JSON 500' : 'the page never installed its hook');
    const refusedSaid = refusedInstalled
      ? await refusedPage.evaluate('document.getElementById("note")?.textContent ?? ""')
      : '';
    check(/ENOTDIR/.test(refusedSaid),
      'and the server\'s own sentence is what reaches the note, rather than a TypeError raised while painting the refusal',
      JSON.stringify(refusedSaid));
    await refusedPage.close();
    for (const p of servers.filter((sv) => sv.port === MAC_PORT + 1)) p.child.kill('SIGKILL');

    // A node that stops answering must not leave this machine holding the pair.
    const deafHeld = [];
    const deaf = await new Promise((done) => {
      const srv = createServer((req, res) => {
        if (req.url === '/library/takes') {
          const seen = { closedAt: null, answered: false };
          deafHeld.push(seen);
          // `close` fires for a request that ended either way.
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
    // And the same question asked of a route that reads a body first.
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

    // Every route that awaits the node, and not the one where it was noticed.
    const indexSrc = readFileSync(join(root, 'server/index.js'), 'utf8');
    const handlers = (() => {
      const found = [];
      const heads = [...indexSrc.matchAll(/\n(?:async function|const) (\w+)\s*(?:=\s*async\s*)?\(/g)];
      for (let i = 0; i < heads.length; i++) {
        const to = i + 1 < heads.length ? heads[i + 1].index : indexSrc.length;
        found.push({ name: heads[i][1], body: indexSrc.slice(heads[i].index, to) });
      }
      return found;
    })();
    const CALL = /await node\.(?:takes|fetchJson)\(((?:[^()]|\([^()]*\))*)\)/gs;
    const reaching = handlers.filter((h) => { CALL.lastIndex = 0; return CALL.test(h.body); });
    const unsignalled = [];
    const late = [];
    let nodeCalls = 0;
    for (const h of reaching) {
      const bound = /const (\w+) = untilCallerLeaves\(/.exec(h.body)?.[1] ?? null;
      const names = new RegExp(`untilCallerLeaves|signal${bound ? `|\\b${bound}\\b` : ''}`);
      for (const m of h.body.matchAll(CALL)) {
        nodeCalls++;
        if (!names.test(m[1])) unsignalled.push(`${h.name} passes ${JSON.stringify(m[1].trim().slice(0, 24))}`);
      }
      // And a signal present at the call says nothing about when it was created.
      const at = h.body.indexOf('untilCallerLeaves(');
      if (at < 0) { late.push(`${h.name} binds none`); continue; }
      const stmt = Math.max(h.body.lastIndexOf(';', at), h.body.lastIndexOf('{', at));
      if (/\bawait\b/.test(h.body.slice(0, stmt < 0 ? at : stmt))) late.push(`${h.name} binds after an await`);
    }
    check(nodeCalls >= 6 && unsignalled.length === 0,
      'and every route that awaits the node hands it the caller it is waiting for, so the next one written inherits the rule rather than being outside a list',
      unsignalled.length ? `${unsignalled.length} of ${nodeCalls}: ${unsignalled.join(', ')}`
        : `${nodeCalls} calls over ${reaching.length} handlers, all signalled`);
    check(reaching.length >= 4 && late.length === 0,
      'and it is bound before anything is awaited, because a response emits close once and a listener attached after the caller left can never fire',
      late.length ? late.join(', ') : `${reaching.length} handlers, all bound ahead of their first await`);
  }

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

    // The build under test, which on a mutated run is not the repo's own tree.
    const sourceOf = (rel) => readFileSync(join(root, rel), 'utf8');

    const pages = readdirSync(join(REPO, 'web')).filter((f) => f.endsWith('.html')).sort();
    const declaring = pages
      .map((file) => ({ file, css: sourceOf(`web/${file}`) }))
      .filter((p) => tokenIn(p.css, 'faint') !== null);
    check(declaring.length >= 3,
      `every page declaring --faint is measured rather than three being named (${pages.length} pages in web/, ${declaring.length} declaring it)`,
      declaring.map((p) => p.file).join(' '));

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

  // Every server this run started, and a row saying so.
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
