#!/usr/bin/env node
// Parses every JavaScript file this repo ships, and asks the five questions about the
// tree that need nothing to answer: that every tool is documented, that every cited
// `docs/` page exists, that the `.knct` decoder specification still agrees with the
// module it specifies, that the hello the grabber emits is the hello the wire-format
// documents, and that every element id the application shell drives is one the page
// drawing it declares. No server, no browser, no sensor, no dependencies - which is what
// makes it the one thing CI can run on a fresh clone and mean it.
//
//   node tools/syntax-check.mjs [--root <dir>]
//
// A syntax checker that finds no files exits 0, and that is the whole reason this is a
// tool rather than a `find | xargs node --check` in package.json. Rename a directory,
// get a glob subtly wrong, run it from the wrong place, and the clean pass it prints is
// about nothing at all - the coverage claim that is an assertion rather than something
// enforced, which this repo keeps writing paragraphs about. So the roots have to exist,
// each has to yield files, the count has to clear a floor, and the count is printed
// beside the verdict so a number that has quietly halved is visible rather than implied.
//
// The floors are a tripwire and not a manifest. They are set well under what the tree
// holds, because a floor that tracks the real count exactly becomes a chore that gets
// bumped without being read, and the failure being guarded against is zero rather than
// one fewer than last week.
//
// **`node --check` can stop detecting syntax errors entirely, and it does it quietly.**
// Found by mutation rather than by reading, on the first control this tool was given: a
// copy of the tree with `const a = {` appended to `web/format.js` passed all 33 files,
// zero failed, exit 0. The copy had no `package.json`, so Node had nothing to say
// whether a `.js` file is a module - and in that state a `.js` file that *looks* like
// ESM and is also broken comes back rc=0 on v26.0.0, while the identical content as
// `.mjs`, or under either `"type"`, comes back rc=1. Measured all four ways. So the root
// must carry a `package.json`, and, because "must" is a word rather than a mechanism,
// the same broken file is fed through first and the run refuses to continue unless it is
// rejected. Without that canary this whole tool is a green light wired to nothing.
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : REPO;

// A literal source substitution in `server/protocol.js`, in the shape the other tools'
// mutation tables use. It is applied to the copy the specification row actually imports,
// so that row reads a genuinely moved constant rather than a comparison somebody nudged -
// and the specification's own prose is left alone, which is the drift being simulated:
// the code moved and the document did not.
//
// **`{ file, edits }` rather than the bare `{ from, to }` it was written as**, and the file
// is named here rather than left to the anchor row below to infer. That row resolves a
// target from the entry's *shape*, and a bare `{ from, to }` had exactly one declarer -
// `registry-check`, which edits `web/main.js` - so the shape was reading as "the browser
// bundle". This entry made that inference wrong the moment it landed: the row went looking
// for `export const TYPE_COLOR = 3;` in `web/main.js`, found none, and reported this
// control as an anchor that had gone stale. The shape says nothing about the file, so the
// entry has to, which is the normalisation the row's own header asks for.
const MUTATIONS = {
  'spec-drifts': {
    file: 'server/protocol.js',
    edits: [['export const TYPE_COLOR = 3;', 'export const TYPE_COLOR = 4;']],
  },

  // The shell row's control: one id the application shell drives, renamed in the markup
  // and left alone in the module - which is a rename that got half-applied, the exact
  // shape that shipped. `menuCameraReset` rather than a dialog's button because it is an
  // application-bar item, so the surface it breaks is the one an operator is looking at.
  'shell-id-renamed': {
    file: 'web/index.html',
    edits: [['id="menuCameraReset"', 'id="menuCameraResetRenamed"']],
  },

  // The control for the other direction, and it reproduces a merge rather than a typo:
  // code that reads a shell key the table never declares, which is what arrived when a
  // fork's `shell.stateDialog` met a table with no `stateDialog` in it. The distinction
  // the row cares about is that this key is never looked up at all, so it is `undefined`
  // rather than `null` - and `shell-id-renamed` cannot catch it, because a key absent
  // from the table is absent from the walk that rule does.
  'shell-key-undeclared': {
    file: 'web/main.js',
    edits: [[
      "shell.exportClose.addEventListener('click', () => ui.exportDialog.close());",
      "shell.exportCloseDialog.addEventListener('click', () => ui.exportDialog.close());",
    ]],
  },
};

// Reads a file, and applies the mutation to it when the mutation is one that names it.
//
// **Keyed on the mutation's own `file` rather than on which block is running.** The
// specification row was the only row with a control when this tool got one, so it took
// `MUTATIONS[mutation].edits` unconditionally and applied it to `server/protocol.js` -
// which is correct for exactly one entry and refuses every other with "the anchor is not
// in server/protocol.js". A second control would have read as a broken control rather
// than as this tool having one place that assumed there would never be two.
//
// Refusal is exit 2 and not a failed assertion, for the reason the row below it gives: a
// mutation whose anchor has moved changes nothing, and a run that changed nothing comes
// back green and gets recorded as the control passing.
const sourceWithMutation = (rel) => {
  const file = join(ROOT, rel);
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  if (!mutation || MUTATIONS[mutation].file !== rel) return src;
  const [[from, to]] = MUTATIONS[mutation].edits;
  if (!src.includes(from)) {
    console.log(`DID NOT RUN - the ${mutation} anchor "${from}" is not in ${rel}, so nothing was mutated and this run would prove nothing`);
    process.exit(2);
  }
  return src.replace(from, to);
};

// Resolved before anything runs, so a name nobody implemented costs a second rather than
// a full parse of the tree and a verdict about the wrong thing.
const mutateAt = argv.indexOf('--mutate');
const mutation = mutateAt === -1 ? null : argv[mutateAt + 1];
if (mutateAt !== -1 && !MUTATIONS[mutation]) {
  console.log(`DID NOT RUN - no mutation named ${mutation ?? '(nothing was given)'}; this tool knows ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// The server, the tools and the browser bundle. Everything else with a .js in it is
// either vendored, built or a capture, and none of those are ours to parse.
const FLOORS = { server: 5, tools: 12, web: 2 };

// **Two different questions, so two different sets, and the difference is the point.**
// `PARSES` is what `node --check` can be handed and have its answer mean anything - a
// shell script fed to it fails as a syntax error about JavaScript, which would be a red
// light wired to the wrong thing. `SHIPPED` is what counts as a tool this repo ships,
// and it is wider because the questions asked of `tools/` below - is it documented, does
// its citation resolve - are about the file being ours rather than about it parsing.
//
// Named once and used by both because the version where each block spelled its own set
// out drifted immediately: the documentation block already read `.sh` while the citation
// scan reused the JavaScript walker, so `pi-registration-ab.sh` was required to be named
// in CLAUDE.md and then never read for the `docs/` pages it might cite. A tool added in
// another language next year joins both questions at once by being added here.
const PARSES = /\.(js|mjs)$/;
const SHIPPED = /\.(js|mjs|sh)$/;

const check = (file) => {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (err) {
    return (err.stderr || err.message || '').toString().trim();
  }
};

let failed = 0;
const fail = (line) => { failed++; console.log(`  FAIL  ${line}`); };

// A missing root, or one with no package.json, is the operator pointing this at
// something that is not a checkout - "the check did not run" rather than "the check
// found something", which is the reading the rest of the suite gives exit 2.
const missing = ['package.json', ...Object.keys(FLOORS)].filter((name) => !existsSync(join(ROOT, name)));
if (missing.length) {
  console.log(`DID NOT RUN - ${ROOT} has no ${missing.join(', ')}, so this is not a checkout of this repo`);
  process.exit(2);
}

// The canary, in a directory of its own governed by this root's own `package.json`, so
// the thing being proved is the parse mode this run will actually get. It is a `.js`
// rather than a `.mjs` on purpose: `.mjs` is unambiguous and would sail through the
// exact configuration that swallows the error.
const scratch = mkdtempSync(join(tmpdir(), 'syntax-check-'));
try {
  copyFileSync(join(ROOT, 'package.json'), join(scratch, 'package.json'));
  const canary = join(scratch, 'canary.js');
  writeFileSync(canary, 'export const broken = {\n');
  if (check(canary) === null) {
    console.log('DID NOT RUN - node --check accepted a file that does not parse, so nothing below would have found one either');
    console.log(`  ${process.execPath} ${process.version}, root ${ROOT}`);
    process.exit(2);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// Symlinked directories are skipped rather than walked. In a git worktree the heavy
// shared trees are symlinked back to the main checkout - .gitignore's own header
// records vendor and node_modules arriving that way - and following one turns a
// six-second check into a parse of somebody else's library.
// Which files it yields is the caller's question rather than the walker's, so the two
// sets above stay one decision made in one place.
function walk(dir, matches, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, matches, out);
    else if (matches.test(entry.name)) out.push(p);
  }
  return out;
}

let total = 0;
for (const [name, floor] of Object.entries(FLOORS)) {
  const files = walk(join(ROOT, name), PARSES);
  total += files.length;
  if (files.length < floor) {
    fail(`${name}/ holds ${files.length} JavaScript files, under the floor of ${floor} - either the tree lost something or this walk stopped finding it`);
  }
  for (const file of files) {
    const err = check(file);
    // Node pads its report with blank lines around the offending source, and a plain
    // head of it printed four of them and cut the `SyntaxError:` line off the bottom -
    // a failure that named the file and nothing about what was wrong with it.
    if (err) fail(`${relative(ROOT, file)}\n          ${err.split('\n').filter((l) => l.trim()).slice(0, 4).join('\n          ')}`);
  }
  console.log(`  ${name}/  ${files.length} files parsed`);
}

// **Every tool has to be named in CLAUDE.md, and this is what makes that true rather
// than aspirational.** The list in that file is how anybody finds the suite, and the
// maintained-by-hand version of it had already rotted badly: it said "all six" tools
// refuse an unmatched mutation where eleven do, documented a `--url` flag
// `library-check` does not have, and omitted `sensor-view-check` altogether - a
// 1277-line proof tool that `editor-check` cites three times by name. A tool nobody
// documented is a tool nobody runs, and the file that was supposed to prevent that was
// itself the thing drifting.
//
// Fixing the names would have closed the instance and left the class open. So the
// question is asked of the directory rather than of a list: anything in `tools/` that
// CLAUDE.md does not mention fails here, and a tool added next year is asked by
// existing. The control is adding a file to `tools/` without documenting it.
//
// Checked by basename rather than by path, because the file refers to them both ways -
// `node tools/vendor-check.mjs` in the invocation blocks and bare `vendor-check` in the
// prose - and requiring one spelling would be a rule about formatting rather than about
// coverage.
const DOC = join(ROOT, 'CLAUDE.md');
if (!existsSync(DOC)) {
  fail('CLAUDE.md is missing, so the claim that every tool is documented cannot be tested');
} else {
  const doc = readFileSync(DOC, 'utf8');
  const shipped = readdirSync(join(ROOT, 'tools'))
    .filter((f) => SHIPPED.test(f))
    .sort();
  const undocumented = shipped.filter((f) => !doc.includes(f));
  if (shipped.length === 0) {
    fail('tools/ yielded no tools to check against CLAUDE.md, so this assertion passed on nothing');
  } else if (undocumented.length) {
    fail(`CLAUDE.md never mentions ${undocumented.join(', ')} - a tool nobody documented is a tool nobody runs`);
  } else {
    console.log(`  tools/  all ${shipped.length} named in CLAUDE.md`);
  }
}

// **And every `docs/*.md` anything points at has to exist**, for the same reason and by
// the same shape as the block above. `CLAUDE.md` was 704 lines and was split into three
// documents it now sends you to by name, with fourteen comments in `tools/` citing those
// documents by section - so the disclosure chain is load-bearing and nothing was checking
// it. Delete one of the three and every citation resolves to nothing while this tool stays
// green, which is a claim asserted in prose with nothing bringing it about.
//
// Enumerated rather than listed: the paths are read out of what actually cites them, so a
// document added next year is checked by existing and a pointer that outlives its
// target fails here. The control is `mv docs/instruments.md /tmp` and a run.
//
// **Every shipped tool, and not every parseable one.** The first version of this block
// reused the JavaScript walker, which is the same class of hole it was written to close:
// `pi-registration-ab.sh` is a documented tool that the scan could not read, so a `docs/`
// page cited from a shell runbook was covered by an assertion that printed "all N cited
// pages exist" and had never opened the file. Measured rather than argued - a citation of
// an absent page appended to that runbook left the check green, and fails here now that
// the walk asks for `SHIPPED`. That is the control, and running it takes a path this
// comment deliberately does not spell: the scan reads its own prose, so a filename
// written here as an example is a citation like any other and fails the run that quotes
// it. Append the line to the runbook, run, revert.
{
  const citing = [join(ROOT, 'CLAUDE.md'), ...walk(join(ROOT, 'tools'), SHIPPED)];
  const cited = new Set();
  for (const file of citing) {
    if (!existsSync(file)) continue;
    for (const m of readFileSync(file, 'utf8').matchAll(/\bdocs\/[A-Za-z0-9._-]+\.md\b/g)) cited.add(m[0]);
  }
  const missing = [...cited].filter((p) => !existsSync(join(ROOT, p))).sort();
  if (cited.size === 0) {
    fail('nothing cites a docs/ page, so this assertion passed on nothing - the disclosure chain is gone or this scan is looking in the wrong place');
  } else if (missing.length) {
    fail(`${missing.join(', ')} is cited but does not exist - a pointer that outlives its target teaches a document nobody can read`);
  } else {
    console.log(`  docs/   all ${cited.size} cited pages exist`);
  }
}

// **And the `.knct` decoder specification has to agree with the module it specifies.**
// Same family as the two blocks above - documentation checked against the tree rather than
// asserted beside it - and here for the same reason they are: this tool needs nothing at
// all, so the control costs a run of what CI already does.
//
// The take is the one irreplaceable artifact in the system, and issue #45 decided its exit
// from this program is that specification rather than a point-cloud export. That makes the
// specification load-bearing in a way prose usually is not here: it is the thing somebody
// writes a reader from once nothing in this tree runs any more, and a constant that moved
// while it did not would send them to a reader that is plausibly shaped and quietly wrong.
//
// **Enumerated from the module, not from a list.** Every numeric export has to appear in
// the specification with its exact value, so a constant added next year is asked by
// existing rather than added to a second table that drifts. The values come from importing
// the module rather than from a regex over its source, because a constant that is computed
// - `MAX_PAYLOAD_BYTES` is `8 * 1024 * 1024` - reads correctly one way and not the other.
//
// **Imported from a scratch copy in both arms, and that is not tidiness.** The clean run
// and the mutated run have to differ only in the substitution; a row that imported the live
// path when clean and a copy when mutated would be comparing two mechanisms and calling the
// difference a catch.
//
// The control is `--mutate spec-drifts`, which moves `TYPE_COLOR` and leaves the prose.
{
  const SPEC_OPEN = '// ---- the .knct decoder specification';
  const SPEC_SHUT = '// ---- end of the .knct decoder specification';
  const rel = 'server/protocol.js';
  const src = sourceWithMutation(rel);
  if (src === null) {
    fail(`${rel} is missing, so the decoder specification has nothing to be checked against`);
  } else {
    const open = src.indexOf(SPEC_OPEN);
    const shut = src.indexOf(SPEC_SHUT);
    let mod = null;
    const scratch = mkdtempSync(join(tmpdir(), 'syntax-check-spec-'));
    try {
      // `.mjs` rather than `.js` beside a copied package.json: the parse mode has to be
      // unambiguous here, and unlike the canary above this row is not trying to prove
      // anything about how Node decides it.
      const copy = join(scratch, 'protocol.mjs');
      writeFileSync(copy, src);
      mod = await import(pathToFileURL(copy).href);
    } catch (err) {
      fail(`${rel} could not be imported, so its exports could not be read: ${err.message}`);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    const numbers = mod ? Object.entries(mod).filter(([, v]) => typeof v === 'number') : [];
    if (open === -1 || shut === -1) {
      fail(`${rel} carries no decoder specification block, so the archive's only written description of its own format is gone`);
    } else if (numbers.length === 0) {
      fail(`${rel} exports no numeric constant, so this assertion passed on nothing`);
    } else {
      const spec = src.slice(open, shut);
      const wrong = [];
      for (const [name, value] of numbers) {
        const said = spec.match(new RegExp(`^//\\s+${name}\\s+(0x[0-9a-fA-F]+|\\d+)\\b`, 'm'));
        if (!said) {
          wrong.push(`${name} is exported as ${value} and the specification never gives it`);
        } else if (Number(said[1]) !== value) {
          wrong.push(`the specification says ${name} is ${said[1]} where the module exports ${value}`);
        }
      }
      if (wrong.length) {
        fail(`the .knct decoder specification disagrees with ${rel}: ${wrong.join('; ')}`);
      } else {
        console.log(`  spec/   all ${numbers.length} protocol constants match the .knct decoder specification`);
      }
    }
  }
}

// **The hello the grabber emits and the hello `docs/architecture.md` documents have to be
// the same set of keys, and the constant saying which generation wrote it has to be the
// same number in both languages.**
//
// That stanza lived in `README.md` until the README was cut back to the usage path. The
// anchor is the stanza rather than the file, so the move cost this block a path and
// nothing else - but the path is the thing that silently passes on nothing if it is
// wrong, which is why an empty extraction below is a failure and not a pass.
//
// The prose block was nine keys against the thirteen actually emitted for long enough
// that the four it omitted became the argument for this: `startedAt` is the only durable
// capture date a take has, and somebody implementing a second producer against the
// documented nine writes takes the library dates by file modification time instead - which
// changes the first time a take is copied off the node, and degrades *quietly*, because
// the fallback is legitimate and says `dateSource: 'mtime'` rather than failing.
//
// Three details decide whether this is an instrument or a green light wired to nothing,
// and all three are the same rule as the three blocks above.
//
// **Both directions.** A key emitted and not documented is the failure that already
// happened; a key documented and not emitted is somebody writing against a promise the
// grabber does not keep, which is the same reader misled by the opposite mistake.
//
// **Scoped anchors, and an empty extraction is a failure rather than a pass.** A bare
// `doc.includes('width')` is true of the word appearing anywhere in the page, so the
// document side is cut to the `type 1 hello` stanza and stops at `type 2`, and the
// grabber side to the one `snprintf` that builds the hello. Zero keys from either side
// means the anchor moved and the comparison ran on nothing, which is exactly the shape
// this tool's own header is about.
//
// **Read textually, never imported.** This tool takes `--root`, so an `import` would bind
// the assertion to this checkout while claiming to have checked another tree - and the C++
// constant could not be imported at all, which is the whole reason it needs watching: it
// is unavoidably a second spelling of a JavaScript number, and nothing else in the repo
// would notice the two drifting.
//
// The controls are run by hand, in the idiom the documentation and `docs/` blocks above
// use. `--mutate` does exist on this tool, but the table behind it carries one entry and
// that entry belongs to the specification row - so there is no named mutation for this
// block, and saying so is the point: a reader who saw the flag and assumed it covered
// every row here would take a green `--mutate spec-drifts` as a control over these
// assertions, which it is not. Add a key to the grabber literal and not to the stanza,
// then the other way round, then bump the constant in one language, and require a named
// failure each time.
{
  const grabberPath = join(ROOT, 'native/grabber.cpp');
  const formatDocPath = join(ROOT, 'docs/architecture.md');
  if (!existsSync(grabberPath) || !existsSync(formatDocPath)) {
    fail('native/grabber.cpp or docs/architecture.md is missing, so the hello the format claims to have cannot be tested against the one it emits');
  } else {
    const grabber = readFileSync(grabberPath, 'utf8');
    const formatDoc = readFileSync(formatDocPath, 'utf8');

    // The literal that builds the hello, from the call to its closing paren. Anchored on
    // the call rather than on the opening brace of the JSON, because the brace is a
    // character that appears everywhere and the call appears once.
    const callAt = grabber.indexOf('std::snprintf(hello, sizeof(hello),');
    const literal = callAt === -1 ? '' : grabber.slice(callAt, grabber.indexOf(');', callAt));
    // `\"name\":` as it is spelled in C++ source. The `%s` values between them cannot
    // match, because a conversion specifier does not start with a letter.
    const emitted = new Set([...literal.matchAll(/\\"([A-Za-z][A-Za-z0-9]*)\\":/g)].map((m) => m[1]));

    // The stanza, and only the stanza: from the type 1 line to the type 2 line, then the
    // braced list inside it. Splitting a brace on commas rather than scanning for words
    // keeps the prose around it - "UTF-8 JSON, once, before any frame" - out of the set.
    const stanzaAt = formatDoc.indexOf('type 1  hello');
    const stanza = stanzaAt === -1 ? '' : formatDoc.slice(stanzaAt, formatDoc.indexOf('type 2', stanzaAt));
    const braced = stanza.match(/\{([^}]*)\}/);
    const documented = new Set((braced?.[1] ?? '').split(',').map((k) => k.trim()).filter(Boolean));

    if (emitted.size === 0) {
      fail('no hello keys found in native/grabber.cpp - the snprintf anchor moved, so this comparison would have passed on nothing');
    } else if (documented.size === 0) {
      fail("no hello keys found in docs/architecture.md's type 1 hello stanza - the anchor moved, so this comparison would have passed on nothing");
    } else {
      const undocumented = [...emitted].filter((k) => !documented.has(k)).sort();
      const unemitted = [...documented].filter((k) => !emitted.has(k)).sort();
      // Two failures rather than one, because which direction it broke in is the whole
      // diagnosis: one is a writer that grew a key nobody was told about, the other is a
      // reader promised a key that never arrives.
      if (undocumented.length) {
        fail(`the grabber's hello emits ${undocumented.join(', ')} and docs/architecture.md's type 1 hello does not document ${undocumented.length === 1 ? 'it' : 'them'}`);
      }
      if (unemitted.length) {
        fail(`docs/architecture.md's type 1 hello documents ${unemitted.join(', ')} and the grabber does not emit ${unemitted.length === 1 ? 'it' : 'them'}`);
      }
      if (!undocumented.length && !unemitted.length) {
        console.log(`  hello/  all ${emitted.size} keys emitted are documented, and back`);
      }
    }

    // The format generation, in the two languages that have to agree about it. Anchored
    // on the declaration in each rather than on any mention, so a comment naming the
    // constant is not a second reading of its value.
    const inJs = readFileSync(join(ROOT, 'web/format.js'), 'utf8').match(/^export const CAPTURE_FORMAT = (\d+);/m);
    const inCpp = grabber.match(/^static const uint32_t CAPTURE_FORMAT = (\d+);/m);
    if (!inJs || !inCpp) {
      fail(`CAPTURE_FORMAT is not declared where this looked: ${inJs ? '' : 'web/format.js '}${inCpp ? '' : 'native/grabber.cpp'}`.trim()
        + ' - one of the two declarations moved, and an undeclared constant cannot be compared with anything');
    } else if (inJs[1] !== inCpp[1]) {
      fail(`CAPTURE_FORMAT is ${inJs[1]} in web/format.js and ${inCpp[1]} in native/grabber.cpp - `
        + 'the grabber would stamp a generation the band that reads it refuses, on every take shot after this');
    } else {
      console.log(`  format/ CAPTURE_FORMAT is ${inJs[1]} in both languages`);
    }

    // **The sensor grid, in the two languages that have to agree about it and cannot share
    // a declaration.** `library-check` proves the grid is stated once across `web/` and
    // `server/`, and that row is structurally unable to see the other side of the wire:
    // the grabber is C++ and cannot import `web/format.js`, so its `DW`/`DH` are a second
    // declaration that has to exist. Two unavoidable declarations are not a drift problem
    // solved by deleting one - they are a drift problem solved by comparing them, which is
    // exactly what `CAPTURE_FORMAT` above already does and for the same reason.
    //
    // What drift costs is a node that starts and then serves nothing: the grabber would
    // emit a depth block of its own size and `server/capture.js` measures every frame
    // against `DEPTH_W * DEPTH_H`, so every frame is refused at the parser with the sensor
    // working perfectly.
    //
    // Anchored on the declaration in each language and never on a mention, which matters
    // more here than it did for the format: `grabber.cpp` also holds `char hello[512]`,
    // a buffer that has nothing to do with the sensor and would answer a search for the
    // number.
    const GRID = [['DEPTH_W', 'DW'], ['DEPTH_H', 'DH']];
    const grid = GRID.map(([js, cpp]) => {
      const fromJs = readFileSync(join(ROOT, 'web/format.js'), 'utf8')
        .match(new RegExp(`^export const ${js} = (\\d+);`, 'm'));
      const fromCpp = grabber.match(new RegExp(`^static const int ${cpp} = (\\d+);`, 'm'));
      return { js, cpp, fromJs, fromCpp };
    });
    const undeclared = grid.filter(({ fromJs, fromCpp }) => !fromJs || !fromCpp);
    const disagreed = grid.filter(({ fromJs, fromCpp }) => fromJs && fromCpp && fromJs[1] !== fromCpp[1]);
    if (undeclared.length) {
      fail(`the sensor grid is not declared where this looked: ${undeclared
        .map(({ js, cpp, fromJs }) => (fromJs ? `${cpp} in native/grabber.cpp` : `${js} in web/format.js`))
        .join(', ')} - a declaration that moved cannot be compared with anything`);
    } else if (disagreed.length) {
      fail(`${disagreed.map(({ js, cpp, fromJs, fromCpp }) => `${js} is ${fromJs[1]} in web/format.js and ${cpp} is ${fromCpp[1]} in native/grabber.cpp`).join('; ')}`
        + ' - the grabber would emit a depth block that server/capture.js measures against the other number and refuses, '
        + 'so a node with a working sensor would serve no frames at all');
    } else {
      console.log(`  grid/   ${grid.map(({ fromJs }) => fromJs[1]).join('x')} in both languages`);
    }
  }
}

// **A mutation is a piece of source text, and until this row nothing checked that the
// text still existed.** Every claim this suite makes about the tree is proved by running
// a mutation and reading which assertions fired, so a mutation whose anchor no longer
// matches proves nothing at all - and it fails in the direction that reads as success.
// Of the three found when this row was written, two threw at module top level: a stack
// trace, a non-zero exit and **zero failed assertions**, which is precisely what a caught
// mutation looks like to anything reading exit codes instead of counting failures. The
// third refused politely with exit 2. `docs/instruments.md` carries the case file, and
// the previous instance of this same drift was closed at `keyframe-check`'s
// `undo-includes-view` without closing the class - which is how three more went stale.
//
// **A duplicate is as stale as a miss**, and that is the half a naive row drops. The
// defect that prompted this was an anchor matching *two* sites, because one conversion
// had been copied to a second place, and a row asking "does this text appear" rather than
// "exactly once" sails straight past it while looking thorough.
//
// Nothing here executes a tool. The table is read by cutting the tool's source at the end
// of the declaration, appending an export, and importing that prefix from inside `tools/`
// so the tool's own relative imports still resolve. Two properties of that cut were
// measured rather than assumed: no tool that declares a table does side-effectful
// top-level work above the declaration, and the terminator is the first `};` at column
// zero, because no table body contains a line starting there. The second is an invariant
// rather than a guarantee, so a prefix that does not import fails the row instead of being
// quietly read as "this tool has no table".
//
// The target file is resolved from each entry's *shape* rather than from the tool's name,
// because a hardcoded list of tools is the exact failure `sweep-all`'s header records from
// its own shell ancestor: four arrays that would have run 59 of 78 mutations and printed
// "all caught". There are six shapes, which is five more than there should be - and the
// honest fix is normalising them onto `{ file, edits }`, which this row is the regression
// test for. A seventh fails naming the tool rather than being skipped, because a
// deliberate exclusion arrives with a justification that stops anybody looking twice.
//
// Last of the three rows on purpose: it is the only one that writes a file into `tools/`,
// so a crash that leaks the prefix cannot make the same run's documentation row fail for a
// reason that has nothing to do with the tree.
{
  const DECLARATION = /^const MUTATIONS = \{$/m;
  // Where a shape that does not carry its own target points. Both are facts about the
  // shape rather than about any tool: a bare `[from, to]` pair is only ever the C++
  // registration mutation, and the three JavaScript shapes all edit the browser bundle.
  const MAIN = 'web/main.js';
  const REGISTRATION = 'third_party/libfreenect2/src/registration.cpp';
  // One name reused for every extraction, so a crash can leak at most one file, and
  // dotted-and-suffixed so the documentation row above catches it on the next run rather
  // than letting it sit in `tools/` looking like something this repo ships.
  const PROBE = join(ROOT, 'tools', '.mutation-table-probe.mjs');

  // **The declaration alone, and the whole prefix only when the declaration will not stand
  // up on its own.** Taking the prefix from the top of the file was the obvious cut and it
  // was wrong twice over, both of them found by running this somewhere other than a
  // developer's machine.
  //
  // It made the row need what the *tool* needs. This tool is documented as needing nothing
  // at all, and CI installs no dependencies, so `import ... from 'ws'` in the prefix meant
  // four tables could not be read there while all sixteen read here - 137 anchors against
  // 248. The row said so, four FAIL lines and the fallen count, which is the loud direction
  // and is why the count is in the summary line at all.
  //
  // Worse, it *executed* the tool's top-level work. `export-check` and `registry-check` both
  // resolve a commit with `git log -S` while their module body runs, so reading their tables
  // shelled out to git over the whole history of `web/main.js` - a walk this row has no
  // business doing, and one that throws outright in a tree extracted without its `.git`.
  //
  // So the declaration is cut on its own, which reads fifteen of the sixteen with no imports
  // and no side effects. The sixteenth is `library-check`, whose table references a
  // `REVEAL_EDIT` const beside it; that one falls back to the prefix with installed-package
  // imports struck out, because a `node:` builtin and a relative path both resolve in a tree
  // nobody ran `npm install` in and a bare package name does not. A table is data, so a
  // package is the one thing it can never legitimately need.
  const withoutPackages = (prefix) => prefix.replace(
    /^import\s[^;]*?from\s+'([^']+)';$/gm,
    (line, spec) => (/^[./]|^node:/.test(spec) ? line : ''),
  );

  /** What a single entry anchors on, or why it anchors on nothing, or null for unknown. */
  const shapeOf = (spec) => {
    if (Array.isArray(spec)) {
      // Both array shapes are pairs, so `Array.isArray` alone cannot tell them apart -
      // it is the first element that says which. Read it wrong and every registration
      // anchor reports hundreds of hits, which is loud and still wrong.
      if (typeof spec[0] === 'string') return { file: REGISTRATION, from: [spec[0]] };
      if (Array.isArray(spec[0])) return { file: MAIN, from: spec.map(([from]) => from) };
      return null;
    }
    if (typeof spec === 'function') return { anchorless: 'functions that redirect the oracle' };
    if (spec === null || typeof spec === 'string') return { anchorless: 'whole replacement file bodies' };
    if (typeof spec === 'object') {
      if (typeof spec.file === 'string' && Array.isArray(spec.edits)) {
        return { file: spec.file, from: spec.edits.map(([from]) => from) };
      }
      // `registry-check`'s shape, and it is the last entry in the tree that names no file.
      // It is left resolving to the bundle rather than made to declare one, because this
      // row's job is to report the shapes that exist rather than to require a rewrite of a
      // tool it is checking - but the inference is a guess about a tool, which is the thing
      // the rest of this resolver refuses to do, and it has already been wrong once.
      // Anything new belongs in `{ file, edits }`.
      if (typeof spec.from === 'string') return { file: MAIN, from: [spec.from] };
    }
    return null;
  };

  const targets = new Map();
  const targetSource = (path) => {
    if (!targets.has(path)) {
      const full = join(ROOT, path);
      targets.set(path, existsSync(full) ? readFileSync(full, 'utf8') : null);
    }
    return targets.get(path);
  };

  let tablesDeclared = 0, tablesWithAnchors = 0, anchorsChecked = 0, stale = 0, unreadable = 0;
  const anchorless = [];
  for (const name of readdirSync(join(ROOT, 'tools')).filter((f) => PARSES.test(f)).sort()) {
    const source = readFileSync(join(ROOT, 'tools', name), 'utf8');
    const declared = DECLARATION.exec(source);
    if (!declared) continue;
    tablesDeclared++;
    const end = source.indexOf('\n};', declared.index);
    if (end === -1) {
      fail(`${name} declares a MUTATIONS table with no terminator at column zero, so its anchors cannot be read`);
      continue;
    }
    let table = null;
    // The declaration on its own first, then the prefix behind it. Both attempts are the
    // same mechanism reading the same table, and only the first failing puts the tool's own
    // module body on the path - so a tool that grows a top-level `git log` or a package
    // import costs this row nothing until its table also starts needing a neighbour.
    const cuts = [
      source.slice(declared.index, end + 3),
      withoutPackages(source.slice(0, end + 3)),
    ];
    for (const [attempt, cut] of cuts.entries()) {
      try {
        writeFileSync(PROBE, `${cut}\nexport { MUTATIONS };\n`);
        // Cache-busted, because sixteen tools are imported through one filename and Node
        // would otherwise hand back the first tool's table fifteen more times - which
        // would read as every anchor matching and is the quietest possible way for this
        // row to pass on nothing. The attempt is in the key as well, so a fallback is not
        // answered by the cached failure of the cut it is falling back from.
        ({ MUTATIONS: table } = await import(`file://${PROBE}?tool=${encodeURIComponent(name)}&cut=${attempt}`));
        break;
      } catch (err) {
        if (attempt === cuts.length - 1) {
          unreadable++;
          fail(`${name}: its MUTATIONS table could not be read - ${String(err.message).split('\n')[0]}`);
        }
      } finally {
        rmSync(PROBE, { force: true });
      }
    }
    if (!table) continue;

    let carriesAnchors = false;
    for (const [mutation, spec] of Object.entries(table)) {
      const shape = shapeOf(spec);
      if (!shape) {
        fail(`${name}/${mutation} declares a MUTATIONS shape this row does not recognise, and a shape nobody checks is a control nobody proved`);
        continue;
      }
      if (shape.anchorless) {
        if (!anchorless.some((a) => a.name === name)) anchorless.push({ name, why: shape.anchorless });
        continue;
      }
      const body = targetSource(shape.file);
      if (body === null) {
        fail(`${name}/${mutation} anchors into ${shape.file}, which does not exist`);
        continue;
      }
      for (const from of shape.from) {
        carriesAnchors = true;
        anchorsChecked++;
        const hits = body.split(from).length - 1;
        if (hits !== 1) {
          stale++;
          fail(`${name}/${mutation} matches ${hits} times in ${shape.file}, expected exactly 1`
            + ` - ${hits === 0 ? 'the text it anchors on has moved, so this control cannot run' : 'the text it anchors on appears more than once, so the tool refuses it'}`);
        }
      }
    }
    if (carriesAnchors) tablesWithAnchors++;
  }

  // Printed rather than absorbed: a table with nothing to check is a real answer, and one
  // the count would otherwise hide behind a total that looks complete.
  for (const { name, why } of anchorless) {
    console.log(`  anchors/ ${name} declares ${why} rather than source anchors, so it has none to check`);
  }
  if (anchorsChecked === 0) {
    fail('no mutation anchors were checked at all, so this assertion passed on nothing - the tables moved or this scan is looking in the wrong place');
  } else if (stale || unreadable) {
    // Counted separately from the total rather than folded into it, because "239
    // checked" beside three FAIL lines is the number a reader needs and "all 239 match"
    // over the top of them would be this row asserting the very thing it just disproved.
    //
    // A table that could not be read at all belongs in the same sentence, and it took a
    // control to notice that it was not there: with `library-check` unreadable the line
    // above still said "all 174 match once", which is true of what it read and reads as a
    // clean row over a FAIL. The number that is missing is the point - it was 248.
    const parts = [];
    if (stale) parts.push(`${stale} not matching exactly once`);
    if (unreadable) parts.push(`${unreadable} table${unreadable === 1 ? '' : 's'} unread, so this count is short by however many ${unreadable === 1 ? 'it' : 'they'} held`);
    console.log(`  anchors/ ${anchorsChecked} checked in ${tablesWithAnchors} tables of ${tablesDeclared} declared, ${parts.join(', ')}`);
  } else {
    console.log(`  anchors/ all ${anchorsChecked} in ${tablesWithAnchors} tables match once, of ${tablesDeclared} declared`);
  }
}

// ---- every id the application shell drives exists on the page that draws it
//
// `web/main.js` builds its shell from a table of element ids and then dereferences every
// entry unguarded. An id that stopped existing therefore does not fail where it is
// looked up - it fails at whichever consumer touches it first, and because `connect()`
// runs below that wiring, the socket is never opened at all. What the operator gets is a
// header stuck on "connecting...", a black viewport, and a server recording a take
// perfectly well with `clients=0` beside it, which reads as a sensor or network fault
// and is neither. That shipped, and it cost most of a session before anyone opened a
// console.
//
// The module now refuses by name at the lookup, which is the runtime half. This is the
// half that means nobody meets it: the two files are compared offline, so a rename that
// takes the markup and not the module fails `npm test` rather than a shoot.
//
// **Read off the module's own table rather than a list kept here.** A hand-copied set of
// ids is a second representation that drifts, and the failure it drifts into is silent -
// an id added next year would simply not be checked, which is this repo's most-repeated
// mistake in a new place. Parsing the literal means a shell entry added later is asked
// by existing.
//
// The control is `--mutate shell-id-renamed`, which renames one id in the markup and
// must redden this row and only this row.
{
  const rel = 'web/main.js';
  const page = 'web/index.html';
  const src = sourceWithMutation(rel);
  const html = sourceWithMutation(page);
  if (src === null || html === null) {
    fail(`${src === null ? rel : page} is missing, so the shell's ids could not be checked against the page`);
  } else {
    // The call, not the function: `shellElements(` also appears where it is declared, and
    // matching that would read an empty table and call it a clean row.
    const open = src.indexOf('const shell = shellElements({');
    const shut = open === -1 ? -1 : src.indexOf('});', open);
    const table = open === -1 || shut === -1 ? '' : src.slice(open, shut);
    // The values, which are the ids. The keys are the module's own names for them and
    // the page knows nothing about those.
    const ids = [...table.matchAll(/^\s*\w+:\s*'([^']+)',$/gm)].map((m) => m[1]);
    const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

    if (open === -1 || shut === -1) {
      fail(`${rel} no longer builds its shell through shellElements({...}), so this row cannot find the ids it is meant to check`
        + ' - if the shell moved, move this row with it rather than leaving it looking at nothing');
    } else if (ids.length === 0) {
      // The row's own floor. An extraction that silently matched nothing would print a
      // clean line about zero ids, which is the shape of a green light wired to nothing
      // that the canary at the top of this file exists to refuse.
      fail(`${rel} declares a shell table this row could not read a single id out of, so this assertion passed on nothing`);
    } else {
      const gone = ids.filter((id) => !present.has(id));
      for (const id of gone) {
        fail(`the application shell drives #${id}, which ${page} does not declare`
          + ' - the module refuses by name at boot, so this is a surface that will not start');
      }

      // **The other direction, and it is the one that actually shipped.** The rule above
      // walks the table outwards and asks the page about each id; it is blind by
      // construction to a `shell.thing` the table never declares, because such a key is
      // not in the table to be walked. A fork of this branch merged in code reading
      // `shell.stateDialog` against a table with no `stateDialog` in it - so the lookup
      // was never made, the property was `undefined`, and a top-level `addEventListener`
      // on it killed both surfaces at boot. The row above stayed green throughout,
      // truthfully, about a question that was not the one being failed.
      //
      // Git had no conflict to report either: one side added consumers, the other left
      // the table alone, and every line was individually fine. That is the shape a merge
      // produces and neither reviewer sees, which is why it belongs to a check rather
      // than to attention.
      const keys = new Set([...table.matchAll(/^\s*(\w+):\s*'[^']+',$/gm)].map((m) => m[1]));
      // `shell.menus` is assigned beside the table rather than declared in it, being a
      // query with no id to miss, so it is a key this rule knows about without the table
      // saying so.
      keys.add('menus');
      // Comments stripped first, because the prose in this file and in `main.js` names
      // these keys while discussing them - the paragraph above names the very key this
      // rule was written for, and scanning raw source reddened the build on its own
      // explanation. A check that fires when somebody writes *about* a key is a false
      // positive, and false positives are how a check stops being read.
      //
      // Stripping can only ever remove text, so its failure mode is a miss rather than a
      // phantom - a `//` inside a string on the same line as a dereference would take the
      // dereference with it. The floor below is what stops that degrading silently into a
      // row that scans nothing and reports no problems.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
      const used = new Set([...code.matchAll(/\bshell\.(\w+)/g)].map((m) => m[1]));
      if (used.size === 0) {
        fail(`${rel} reads no shell keys at all once comments are stripped, so this rule scanned nothing`);
      }
      const undeclared = [...used].filter((k) => !keys.has(k));
      for (const key of undeclared) {
        fail(`${rel} reads shell.${key}, which the shell table does not declare`
          + ' - the lookup is never made, so it is undefined rather than missing, and a top-level'
          + ' use of it stops the surface booting');
      }

      if (gone.length === 0 && undeclared.length === 0) {
        console.log(`  shell/ all ${ids.length} ids the shell drives are declared by ${page},`
          + ` and all ${used.size} keys read off the shell are declared by the table`);
      }
    }
  }
}

console.log(`\n${total} JavaScript files, ${failed} failed`);
// Said out loud because `npm test` runs this, and a green `npm test` that meant "the
// suite passed" would be the most expensive wrong impression in the repo. **One thing here
// executes rather than parses**, and it is named rather than buried: the specification row
// imports a copy of `server/protocol.js`, which is a module of constants with no imports of
// its own, and reads its exported values. Nothing is called and no behaviour is exercised.
// Everything else is `node --check` and nothing runs.
console.log('syntax only - no proof tool ran here; see CLAUDE.md "Proof tools" for the suite and what each of them needs');
process.exit(failed ? 1 : 0);
