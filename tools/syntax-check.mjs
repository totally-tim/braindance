#!/usr/bin/env node
// Parses every JavaScript file this repo ships and asks the questions that need no server,
// browser or sensor: every tool documented, every citation resolving, the decoder spec
// agreeing with its module, the grabber's hello matching the wire format, and every shell id
// declared by the page that draws it.
//
//   node tools/syntax-check.mjs [--root <dir>]
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : REPO;

// Entries are `{ file, edits }`; the anchor row below resolves its target from that `file`.
const MUTATIONS = {
  'spec-drifts': {
    file: 'server/protocol.js',
    edits: [['export const TYPE_COLOR = 3;', 'export const TYPE_COLOR = 4;']],
  },

  'key-levels-drift': {
    file: 'web/key-stream.js',
    edits: [['export const KEY_DEPTH_LEVELS = 255;', 'export const KEY_DEPTH_LEVELS = 254;']],
    fails: 'and the two declarations of the keyed output\'s depth quantisation disagreeing, which '
      + 'puts every subject at the wrong distance in a picture that still looks like one',
  },

  'shell-id-renamed': {
    file: 'web/index.html',
    edits: [['id="menuCameraReset"', 'id="menuCameraResetRenamed"']],
  },

  'shell-key-undeclared': {
    file: 'web/main.js',
    edits: [[
      "shell.exportClose.addEventListener('click', () => ui.exportDialog.close());",
      "shell.exportCloseDialog.addEventListener('click', () => ui.exportDialog.close());",
    ]],
  },

  'web-citation-outlives-its-module': {
    file: 'CLAUDE.md',
    edits: [[
      'the reach through property dispatch inside `web/main.js`',
      'the reach through property dispatch inside `web/render-loop.js`',
    ]],
  },

  'line-citation-past-the-end': {
    file: 'docs/proof-tools.md',
    edits: [['`gpuTimer.poll` in\n`web/main.js` is that shape', '`gpuTimer.poll` in\n`web/main.js:98600` is that shape']],
  },

  'manifest-does-not-parse': {
    file: 'effects-builtin/rain/manifest.json',
    edits: [['{\n  "format": 1,', '{{\n  "format": 1,']],
  },

  'anchor-in-dead-fallback': {
    file: 'tools/export-check.mjs',
    edits: [[
      "  'pointsize-absolute': { file: 'effects-builtin/glyph/size.vert.glsl', edits: [[",
      "  'pointsize-absolute': { file: 'web/cloud-shader.js', edits: [[",
    ]],
    fails: 'and a shader anchor that matches its file exactly once while sitting in a slot\'s '
      + 'fallback, which is a second copy of the shipped text that nothing compiles',
  },

  'anchor-duplicated-into-a-second-chunk': {
    file: 'effects-builtin/glitch/tear.vert.glsl',
    edits: [['  vGlitch = 0.0;', '  vGlitch = 0.0;\n  if (lattice > 0.0) {']],
    fails: 'and the other half of the same row: one anchor over two sites in the assembled text, '
      + 'where the edit reaches one and the count reads whole',
  },

  'anchor-duplicated-into-a-second-program': {
    file: 'effects-builtin/thermal/heat.frag.glsl',
    edits: [['  if (thermal > 0.0) {', '  if (thermal > 0.0) {\n      if (streak > 0.0) {']],
    fails: 'and the same duplicate placed in the *other* program, which is the arm that says the '
      + 'count sums over every assembled string rather than asking each one on its own',
  },

  'citation-outside-the-prose': {
    file: 'native/grabber.cpp',
    edits: [['Node reads `web/format.js` by path', 'Node reads `web/capture-format.js` by path']],
  },

  // One per branch of the mutate/ row, because a branch no control can reach is a branch nobody
  // proved: a name nothing declares, a name declared somewhere else than where it is listed, and
  // the bullet form, which the first two cannot see.
  //
  // The first two anchor on `effect-conformance-check`'s `leaks-at-zero` line, which is the only
  // `--mutate` invocation left on the page. Their previous anchor was deleted with the entry it
  // sat on and both controls stopped being able to run, so the reason that entry stays is written
  // beside it in `docs/proof-tools.md` as well as here.
  'doc-invokes-an-undeclared-mutation': {
    file: 'docs/proof-tools.md',
    edits: [['--mutate leaks-at-zero', '--mutate leaks-at-nothing']],
    fails: 'and a `--mutate` this prose offers that no tool\'s table declares, which is a run '
      + 'nobody can make listed as one anybody can',
  },

  'doc-lists-a-mutation-under-the-wrong-tool': {
    file: 'docs/proof-tools.md',
    edits: [[
      'node tools/effect-conformance-check.mjs --mutate leaks-at-zero',
      'node tools/registry-check.mjs --mutate leaks-at-zero',
    ]],
    fails: 'and one listed under a tool that does not declare it, which the row above cannot see '
      + 'because the name resolves somewhere',
  },

  'doc-bullets-an-undeclared-mutation': {
    file: 'docs/proof-tools.md',
    edits: [['- **`reveal-ignores-tracks`**', '- **`reveal-ignores-nothing`**']],
    fails: 'and the other form the reference offers a control in, a bullet naming one nothing '
      + 'declares',
  },

  'doc-line-ends-in-whitespace': {
    file: 'docs/proof-tools.md',
    edits: [['Per tool, read from the source:', 'Per tool, read from the source: ']],
    fails: 'and a prose line ending in a space, which is invisible on the page and invisible to '
      + 'a clean `git diff --check`',
  },
};

// Reads a file, applying the mutation when the mutation names it. An anchor that no longer
// matches exits 2 rather than failing a row, because a run that changed nothing reads green.
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

const mutateAt = argv.indexOf('--mutate');
const mutation = mutateAt === -1 ? null : argv[mutateAt + 1];
if (mutateAt !== -1 && !MUTATIONS[mutation]) {
  console.log(`DID NOT RUN - no mutation named ${mutation ?? '(nothing was given)'}; this tool knows ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// A floor per directory rather than a total, so a tree that stopped being walked says so
// instead of being covered by another that grew. A tripwire against zero, not a manifest.
const FLOORS = { server: 5, test: 10, tools: 12, web: 18 };

// `PARSES` is what `node --check` can be handed and have its answer mean anything; `SHIPPED`
// is wider, because what is asked of `tools/` is about the file being ours, not about parsing.
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

// A missing root, or one with no package.json, is exit 2 - the check did not run.
const missing = ['package.json', ...Object.keys(FLOORS)].filter((name) => !existsSync(join(ROOT, name)));
if (missing.length) {
  console.log(`DID NOT RUN - ${ROOT} has no ${missing.join(', ')}, so this is not a checkout of this repo`);
  process.exit(2);
}

// The canary sits under this root's own `package.json`, so it proves the parse mode this run
// will get: `node --check` returns rc=0 for a broken ESM-shaped `.js` under a root with none.
// It is a `.js` and not a `.mjs` because a `.mjs` sails through that configuration.
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

// Symlinked directories are skipped rather than walked: in a worktree the heavy shared trees
// are symlinked back to the main checkout, and following one parses somebody else's library.
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
    if (err) fail(`${relative(ROOT, file)}\n          ${err.split('\n').filter((l) => l.trim()).slice(0, 4).join('\n          ')}`);
  }
  console.log(`  ${name}/  ${files.length} files parsed`);
}

// Every tool in `tools/` has to be named in CLAUDE.md, asked of the directory rather than of a
// list, and matched on basename because the file names tools both as a path and bare.
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

// Blanks every string and template literal body, leaving comments and every newline in place.
// A path in a string is data and a path in a comment is a citation, so this keeps mutation
// targets and fixture paths out of the citation walk.
const withoutStringBodies = (src) => {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '/' && (src[i + 1] === '/' || src[i + 1] === '*')) {
      const end = src[i + 1] === '/' ? src.indexOf('\n', i) : src.indexOf('*/', i + 2) + 1;
      const stop = end <= 0 ? src.length : end + (src[i + 1] === '/' ? 0 : 1);
      out += src.slice(i, stop);
      i = stop - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c || (c !== '`' && src[j] === '\n')) break;
        j++;
      }
      out += src.slice(i, j + 1).replace(/[^\n]/g, ' ');
      i = j;
      continue;
    }
    out += c;
  }
  return out;
};

// Every `docs/` page and every `web/` module anything cites has to exist. The targets are read
// out of what cites them, so a page added next year is checked by existing; a citation is
// checked for resolving and never for being right, hence citing a function rather than a line.
{
  // Read from `.gitignore` rather than from an allowlist of directories, because an allowlist
  // rots in the direction that reads as success: a tree added next year is simply not asked.
  const ignored = (() => {
    const names = new Set(['.git']);
    const paths = new Set();
    const globs = [];
    const raw = existsSync(join(ROOT, '.gitignore'))
      ? readFileSync(join(ROOT, '.gitignore'), 'utf8') : '';
    for (const line of raw.split('\n')) {
      const pattern = line.trim();
      if (!pattern || pattern.startsWith('#') || pattern.startsWith('!')) continue;
      const clean = pattern.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!clean) continue;
      if (clean.includes('*')) {
        globs.push(new RegExp(`^${clean.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`));
      } else if (clean.includes('/')) paths.add(clean);
      else names.add(clean);
    }
    return (rel, name) => names.has(name) || paths.has(rel) || globs.some((g) => g.test(name));
  })();
  const walkShipped = (dir, out = []) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const p = join(dir, entry.name);
      if (ignored(relative(ROOT, p), entry.name)) continue;
      if (entry.isDirectory()) walkShipped(p, out);
      else out.push(p);
    }
    return out;
  };
  const citing = walkShipped(ROOT).map((p) => relative(ROOT, p)).sort();

  const cited = new Set();
  const modules = new Map();
  let scanned = 0;
  for (const rel of citing) {
    const raw = sourceWithMutation(rel);
    if (raw === null) continue;
    // A NUL in the bytes is what "not text" means, sniffed rather than listed by extension.
    if (raw.includes('\u0000')) continue;
    scanned++;
    const text = /\.(js|mjs)$/.test(rel) ? withoutStringBodies(raw) : raw;
    for (const m of text.matchAll(/\bdocs\/[A-Za-z0-9._-]+\.md\b/g)) cited.add(m[0]);
    for (const m of text.matchAll(/\beffects-builtin\/[a-z][a-z0-9]*\/[A-Za-z0-9._-]+\.[a-z]+\b/g)) cited.add(m[0]);
    // A range takes its last line, since that is the bound the file has to reach.
    for (const m of text.matchAll(/\bweb\/[A-Za-z0-9._/-]+\.js\b(?::(\d+)(?:-(\d+))?)?/g)) {
      const at = `${rel}:${text.slice(0, m.index).split('\n').length}`;
      if (!modules.has(m[0])) modules.set(m[0], { path: m[0].split(':')[0], line: m[2] ?? m[1], at });
    }
  }

  const missing = [...cited].filter((p) => !existsSync(join(ROOT, p))).sort();
  if (cited.size === 0) {
    fail('nothing cites a docs/ page, so this assertion passed on nothing - the disclosure chain is gone or this scan is looking in the wrong place');
  } else if (missing.length) {
    fail(`${missing.join(', ')} is cited but does not exist - a pointer that outlives its target teaches a document nobody can read`);
  } else {
    console.log(`  docs/   all ${cited.size} cited pages exist, over ${citing.length} pages and source files`);
  }

  // The row's floor: a scan that matched nothing would print a clean line about zero citations.
  const byLine = [...modules.values()].filter((c) => c.line);
  const gone = [];
  const past = [];
  for (const [cite, { path, line, at }] of modules) {
    const full = join(ROOT, path);
    if (!existsSync(full)) { gone.push(`${cite} at ${at}`); continue; }
    if (!line) continue;
    const lines = readFileSync(full, 'utf8').split('\n').length;
    if (Number(line) > lines) past.push(`${cite} at ${at}, where ${path} has ${lines} lines`);
  }
  if (modules.size === 0) {
    fail('nothing cites a web/ module, so this assertion passed on nothing - either the prose stopped naming the modules or this scan is looking in the wrong place');
  } else {
    if (gone.length) {
      fail(`${gone.join('; ')} - the module is not there, so the citation sends a reader to a file this checkout does not have`);
    }
    if (past.length) {
      fail(`${past.join('; ')} - the line is past the end of the file, so whatever it named has moved`);
    }
    if (!gone.length && !past.length) {
      console.log(`  web/    all ${modules.size} cited modules exist, ${byLine.length} of them named by line`);
    }
  }
}

// Every shipped effect package has to parse, since a manifest that does not is a server that
// boots and then 500s on `/effects`. Zero packages is its own failure.
{
  const root = join(ROOT, 'effects-builtin');
  const ids = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()
    : [];
  if (ids.length === 0) {
    fail('effects-builtin/ holds no packages, so this build ships no effects - the directory is gone or this scan is looking in the wrong place');
  } else {
    const bad = [];
    for (const id of ids) {
      const path = join(root, id, 'manifest.json');
      if (!existsSync(path)) { bad.push(`${id} has no manifest.json`); continue; }
      try {
        const manifest = JSON.parse(sourceWithMutation(`effects-builtin/${id}/manifest.json`) ?? readFileSync(path, 'utf8'));
        if (manifest.id !== id) bad.push(`${id}/manifest.json declares id ${JSON.stringify(manifest.id)}`);
      } catch (err) {
        bad.push(`${id}/manifest.json does not parse: ${err.message}`);
      }
    }
    if (bad.length) fail(`${bad.join('; ')} - a package the store cannot read is a server that boots and then refuses /effects`);
    else console.log(`  effects/ all ${ids.length} shipped packages parse and name themselves`);
  }
}

// The `.knct` decoder specification has to agree with the module it specifies, enumerated from
// the module and read by importing it, because a computed constant does not survive a regex.
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

// The hello the grabber emits and the hello `docs/architecture.md` documents have to be the
// same set of keys, in both directions. Each side is cut to its anchor, and an empty
// extraction fails rather than passes, because a comparison that ran on nothing reads clean.
{
  const grabberPath = join(ROOT, 'native/grabber.cpp');
  const formatDocPath = join(ROOT, 'docs/architecture.md');
  if (!existsSync(grabberPath) || !existsSync(formatDocPath)) {
    fail('native/grabber.cpp or docs/architecture.md is missing, so the hello the format claims to have cannot be tested against the one it emits');
  } else {
    const grabber = readFileSync(grabberPath, 'utf8');
    const formatDoc = readFileSync(formatDocPath, 'utf8');

    // Anchored on the call rather than on the JSON's opening brace, which appears everywhere.
    const callAt = grabber.indexOf('std::snprintf(hello, sizeof(hello),');
    const literal = callAt === -1 ? '' : grabber.slice(callAt, grabber.indexOf(');', callAt));
    const emitted = new Set([...literal.matchAll(/\\"([A-Za-z][A-Za-z0-9]*)\\":/g)].map((m) => m[1]));

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

    // Anchored on the declaration in each language, so a mention is not a second reading.
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

    // The grabber is C++ and cannot import `web/format.js`, so its grid is a second declaration
    // that has to be compared. Drift is a node that starts and serves nothing, since
    // `server/capture.js` measures every frame against `DEPTH_W * DEPTH_H`.
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

    // The grabber quantises the keyed output's depth into a byte and the page at /key inverts it,
    // so the level count is a third declaration in C++. Drift is every subject at the wrong
    // distance in a picture that still looks like a picture, which is a fault nobody sees.
    const levelsJs = sourceWithMutation('web/key-stream.js')
      ?.match(/^export const KEY_DEPTH_LEVELS = (\d+);/m);
    const levelsCpp = grabber.match(/^static const uint32_t KEY_DEPTH_LEVELS = (\d+);/m);
    if (!levelsJs || !levelsCpp) {
      fail(`KEY_DEPTH_LEVELS is not declared where this looked: ${levelsJs ? '' : 'web/key-stream.js '}${levelsCpp ? '' : 'native/grabber.cpp'}`.trim()
        + ' - one of the two declarations moved, and an undeclared constant cannot be compared with anything');
    } else if (levelsJs[1] !== levelsCpp[1]) {
      fail(`KEY_DEPTH_LEVELS is ${levelsJs[1]} in web/key-stream.js and ${levelsCpp[1]} in native/grabber.cpp - `
        + 'the grabber would quantise against one scale and the keyed page invert it against another, '
        + 'so every reading comes back at the wrong distance');
    } else {
      console.log(`  key/    KEY_DEPTH_LEVELS is ${levelsJs[1]} in both languages`);
    }
  }
}

// Filled by the block below and read by the one after it, so the prose is asked against the
// tables themselves rather than against a second list of names kept beside them.
const declaredMutations = new Map();

// Every mutation's anchor text still has to exist in the tree, exactly once - a duplicate is as
// stale as a miss, and a stale anchor fails in the direction that reads as success. The target
// file comes from each entry's shape, and a shape nobody handles fails naming its tool.
{
  const DECLARATION = /^const MUTATIONS = \{$/m;
  const REGISTRATION = 'third_party/libfreenect2/src/registration.cpp';
  // One name reused for every extraction, so a crash leaks at most one file.
  const PROBE = join(ROOT, 'tools', '.mutation-table-probe.mjs');

  // The declaration alone, with the whole prefix only as a fallback: the prefix makes this row
  // need what the tool needs, a `ws` import CI has not installed or a top-level `git log`.
  const withoutPackages = (prefix) => prefix.replace(
    /^import\s[^;]*?from\s+'([^']+)';$/gm,
    (line, spec) => (/^[./]|^node:/.test(spec) ? line : ''),
  );

  // What a single entry anchors on, or why it anchors on nothing, or null for unknown. An edit
  // may name its own file, since one mutation's two edits can land in two files.
  const shapeOf = (spec) => {
    if (Array.isArray(spec)) {
      return typeof spec[0] === 'string' ? { anchors: [{ file: REGISTRATION, from: spec[0], to: spec[1] }] } : null;
    }
    if (typeof spec === 'function') return { anchorless: 'functions that redirect the oracle' };
    if (spec === null || typeof spec === 'string') return { anchorless: 'whole replacement file bodies' };
    if (typeof spec === 'object') {
      if (typeof spec.file === 'string' && Array.isArray(spec.edits)) {
        return {
          anchors: spec.edits.map(([from, to, where]) => ({ file: where ?? spec.file, from, to })),
        };
      }
    }
    return null;
  };

  // Off disk and deliberately not through the substitution: the question is whether the tree
  // still holds the text, and a control that stages source would report its own anchor stale.
  const targets = new Map();
  const targetSource = (path) => {
    if (!targets.has(path)) {
      const full = join(ROOT, path);
      targets.set(path, existsSync(full) ? readFileSync(full, 'utf8') : null);
    }
    return targets.get(path);
  };

  // The same anchors asked of the text the driver is handed. A file is not a program since the
  // shaders became a spine plus the packages' chunks, so each anchor must appear exactly once
  // summed over every assembled program - never per program - and the edit must move one.
  const SPINES = {
    cloud: 'web/cloud-shader.js', grade: 'web/grade-shader.js', mosh: 'web/mosh-shader.js',
  };
  const SPINE_EXPORT = { cloud: 'cloudSpine', grade: 'gradeSpine', mosh: 'moshSpine' };
  const ASSEMBLER = 'web/shader-assembly.js';
  const isSpine = (file) => Object.values(SPINES).includes(file);
  const isChunk = (file) => /^effects-builtin\/[^/]+\/[^/]+\.glsl$/.test(file);
  const buildsTheProgram = (file) => isSpine(file) || file === ASSEMBLER || isChunk(file);

  // A data: URL carries no base to resolve a relative import against, so every `./x.js` a spine
  // or the assembler names is rewritten to the file URL it points at before the text is handed to
  // the loader. Only the specifiers move; the source under test is otherwise the staged text. An
  // import reached this way is read off disk, so a mutation staged against one would not be seen.
  const moduleOf = (source, file) => {
    const base = pathToFileURL(join(ROOT, file));
    const absolute = source.replace(
      /(^\s*(?:import|export)\b[^;'"]*?\bfrom\s*)'(\.[^']*)'/gm,
      (_, head, spec) => `${head}'${new URL(spec, base).href}'`,
    );
    return import(`data:text/javascript;base64,${Buffer.from(absolute, 'utf8').toString('base64')}`);
  };
  // A string replacement, not a pattern one: `String.replace` reads `$&` out of a replacement.
  const swap = (body, from, to) => body.replace(from, () => to);

  let clean = null, spineSources = null, assemblerSource = null, basePackages = null;
  try {
    spineSources = Object.fromEntries(Object.entries(SPINES)
      .map(([name, file]) => [name, sourceWithMutation(file)]));
    assemblerSource = sourceWithMutation(ASSEMBLER);
    const builtin = join(ROOT, 'effects-builtin');
    // The manifests are read off disk even so, since `manifest-does-not-parse` owns that
    // question one block up.
    basePackages = readdirSync(builtin, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name).sort()
      .map((id) => {
        const manifest = JSON.parse(readFileSync(join(builtin, id, 'manifest.json'), 'utf8'));
        const chunks = {};
        for (const c of manifest.chunks ?? []) chunks[c.file] = sourceWithMutation(`effects-builtin/${id}/${c.file}`);
        return { id, manifest, chunks };
      });
  } catch (err) {
    fail(`the shipped packages could not be read for the assembled-program rule - ${String(err.message).split('\n')[0]}`);
  }

  const assembleStaged = async (staged = {}) => {
    const spines = {};
    for (const [name, source] of Object.entries(spineSources)) {
      spines[name] = (await moduleOf(staged.spines?.[name] ?? source, SPINES[name]))[SPINE_EXPORT[name]];
    }
    const { assembleShaders } = await moduleOf(staged.assembler ?? assemblerSource, ASSEMBLER);
    const packages = basePackages.map((p) => ({ ...p, chunks: { ...p.chunks } }));
    if (staged.chunk) {
      const [, id, name] = staged.chunk.file.split('/');
      const pkg = packages.find((p) => p.id === id);
      if (!pkg) throw new Error(`${staged.chunk.file} names an effect package this build does not ship`);
      pkg.chunks[name] = staged.chunk.text;
    }
    return assembleShaders(spines, packages);
  };

  const everyProgram = (built) => Object.values(built)
    .flatMap((p) => [p.vertexShader, p.fragmentShader]);
  const sameProgram = (a, b) => {
    const x = everyProgram(a), y = everyProgram(b);
    return x.length === y.length && x.every((s, i) => s === y[i]);
  };

  if (basePackages) {
    try {
      clean = await assembleStaged();
    } catch (err) {
      fail(`the spine and the shipped packages do not assemble at all, so no anchor could be checked against the programs - ${String(err.message).split('\n')[0]}`);
    }
  }

  let programChecked = 0, dead = 0, miscounted = 0;
  let tablesDeclared = 0, tablesWithAnchors = 0, anchorsChecked = 0, stale = 0, unreadable = 0;
  const anchorless = [];
  for (const name of readdirSync(join(ROOT, 'tools')).filter((f) => PARSES.test(f)).sort()) {
    const source = sourceWithMutation(`tools/${name}`);
    const declared = DECLARATION.exec(source);
    if (!declared) continue;
    tablesDeclared++;
    const end = source.indexOf('\n};', declared.index);
    if (end === -1) {
      fail(`${name} declares a MUTATIONS table with no terminator at column zero, so its anchors cannot be read`);
      continue;
    }
    let table = null;
    const cuts = [
      source.slice(declared.index, end + 3),
      withoutPackages(source.slice(0, end + 3)),
    ];
    for (const [attempt, cut] of cuts.entries()) {
      try {
        writeFileSync(PROBE, `${cut}\nexport { MUTATIONS };\n`);
        // Cache-busted, because sixteen tools import through one filename and Node would
        // otherwise hand back the first tool's table fifteen more times.
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
    declaredMutations.set(name, Object.keys(table));

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
      for (const { file, from, to } of shape.anchors) {
        const body = targetSource(file);
        if (body === null) {
          fail(`${name}/${mutation} anchors into ${file}, which does not exist`);
          continue;
        }
        carriesAnchors = true;
        anchorsChecked++;
        const hits = body.split(from).length - 1;
        if (hits !== 1) {
          stale++;
          fail(`${name}/${mutation} matches ${hits} times in ${file}, expected exactly 1`
            + ` - ${hits === 0 ? 'the text it anchors on has moved, so this control cannot run' : 'the text it anchors on appears more than once, so the tool refuses it'}`);
          continue;
        }
        if (!clean || !buildsTheProgram(file) || typeof to !== 'string') continue;
        programChecked++;
        if (file !== ASSEMBLER) {
          const inProgram = everyProgram(clean)
            .reduce((n, text) => n + text.split(from).length - 1, 0);
          if (inProgram !== 1) {
            miscounted++;
            fail(`${name}/${mutation} anchors on text appearing ${inProgram} times in the assembled programs, not once`
              + ` - ${inProgram === 0 ? 'it matches its file and reaches no program, so the edit lands in text nothing compiles'
                : 'the edit reaches one of those sites and the control would be recorded under the whole mutation\'s name'}`);
          }
        }
        const chunkOf = (rel) => {
          const [, id, chunk] = rel.split('/');
          return basePackages.find((p) => p.id === id)?.chunks[chunk] ?? '';
        };
        const spineNamed = Object.entries(SPINES).find(([, path]) => path === file)?.[0];
        let after = null;
        try {
          after = await assembleStaged(
            spineNamed ? { spines: { [spineNamed]: swap(spineSources[spineNamed], from, to) } }
              : file === ASSEMBLER ? { assembler: swap(assemblerSource, from, to) }
                : { chunk: { file, text: swap(chunkOf(file), from, to) } },
          );
        } catch (err) {
          dead++;
          fail(`${name}/${mutation} staged against ${file} and the programs would not assemble - ${String(err.message).split('\n')[0]}`);
        }
        if (after && sameProgram(after, clean)) {
          dead++;
          fail(`${name}/${mutation} edits ${file} and no assembled program moves`
            + ' - a slot carries a second copy of the shipped text, so an anchor can match its file exactly once'
            + ' and still sit in the copy nothing compiles');
        }
      }
    }
    if (carriesAnchors) tablesWithAnchors++;
  }

  for (const { name, why } of anchorless) {
    console.log(`  anchors/ ${name} declares ${why} rather than source anchors, so it has none to check`);
  }
  if (anchorsChecked === 0) {
    fail('no mutation anchors were checked at all, so this assertion passed on nothing - the tables moved or this scan is looking in the wrong place');
  } else if (stale || unreadable) {
    // Counted separately from the total, because the number that is missing is the point.
    const parts = [];
    if (stale) parts.push(`${stale} not matching exactly once`);
    if (unreadable) parts.push(`${unreadable} table${unreadable === 1 ? '' : 's'} unread, so this count is short by however many ${unreadable === 1 ? 'it' : 'they'} held`);
    console.log(`  anchors/ ${anchorsChecked} checked in ${tablesWithAnchors} tables of ${tablesDeclared} declared, ${parts.join(', ')}`);
  } else {
    console.log(`  anchors/ all ${anchorsChecked} in ${tablesWithAnchors} tables match once, of ${tablesDeclared} declared`);
  }

  if (clean === null) {
  } else if (programChecked === 0) {
    fail('no anchor was checked against the assembled shader programs, so that rule passed on nothing'
      + ' - either the mutations stopped naming the spine and the chunks, or this scan is looking in the wrong place');
  } else if (dead || miscounted) {
    console.log(`  program/ ${programChecked} shader anchors checked against the assembled programs, `
      + [dead && `${dead} reaching no program`, miscounted && `${miscounted} not appearing exactly once`].filter(Boolean).join(', '));
  } else {
    console.log(`  program/ all ${programChecked} shader anchors appear once across the assembled programs and move one when applied`);
  }
}

// Every mutation the prose *offers* has to be one a tool declares, asked of the tables above so
// there is no second list of names here to drift from them. Two forms offer a control: an
// invocation, and the control bullets `docs/proof-tools.md` describes each one with. A bare name
// in a sentence is a mention, not an offer, and is not asked.
{
  const declaredBy = new Map();
  for (const [tool, names] of declaredMutations) {
    for (const n of names) {
      if (!declaredBy.has(n)) declaredBy.set(n, new Set());
      declaredBy.get(n).add(tool);
    }
  }
  const lineOf = (text, index) => text.slice(0, index).split('\n').length;
  // Hyphenated only, and every declared name is: an unhyphenated capture is the English word
  // after a backticked `--mutate`. A mutation named in one word would go unasked here, which is
  // said rather than left to be assumed.
  const INVOKED = /--mutate[\s`]+([a-z0-9]+(?:-[a-z0-9]+)+)/g;
  const BULLET = /^[ \t]*- \*\*`([a-z0-9]+(?:-[a-z0-9]+)+)`\*\*/gm;
  // The tool a *command* names, so a control listed under the wrong one is caught as well as one
  // nothing declares at all. Anchored at the start of the line on purpose: a tool named anywhere
  // earlier on the line is as often the subject of the sentence as the thing being run, and the
  // looser form read `tools/fake-grabber.mjs` out of a clause about where a mutation plants.
  const UNDER = /^[ \t]*(?:\$ )?node tools\/([a-z-]+\.mjs)/;

  let invocations = 0;
  let bullets = 0;
  const wrong = [];
  for (const page of readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).sort()) {
    const rel = `docs/${page}`;
    const text = sourceWithMutation(rel);
    if (text === null) continue;
    for (const m of text.matchAll(INVOKED)) {
      invocations++;
      const at = `${rel}:${lineOf(text, m.index)}`;
      const owners = declaredBy.get(m[1]);
      if (!owners) {
        wrong.push(`${at} invokes --mutate ${m[1]}, which no tool declares`
          + ' - a control the prose offers and no table implements is a run nobody can make');
        continue;
      }
      const named = UNDER.exec(text.slice(text.lastIndexOf('\n', m.index) + 1, m.index));
      if (named && !owners.has(named[1])) {
        wrong.push(`${at} invokes --mutate ${m[1]} through ${named[1]}, which does not declare it`
          + ` - ${[...owners].join(', ')} does, so the line as written exits naming no such mutation`);
      }
    }
    if (rel !== 'docs/proof-tools.md') continue;
    for (const m of text.matchAll(BULLET)) {
      bullets++;
      if (!declaredBy.has(m[1])) {
        wrong.push(`${rel}:${lineOf(text, m.index)} offers \`${m[1]}\` as a control of its own`
          + ' - no table declares it, so the description stands for a run nobody can make');
      }
    }
  }

  if (invocations === 0 || bullets === 0) {
    fail(`the prose offers ${invocations} invocations and ${bullets} control bullets - one of those is zero, `
      + 'so that half passed on nothing and this scan is looking in the wrong place');
  } else if (wrong.length) {
    for (const line of wrong) fail(line);
  } else {
    console.log(`  mutate/ all ${invocations} invocations and ${bullets} control bullets name a declared mutation, `
      + `of ${declaredBy.size} declared across ${declaredMutations.size} tables`);
  }
}

// No prose line ends in whitespace. `git diff --check` says the same thing and cannot be relied
// on to: it compares the working tree against the index, so on a clean checkout it reads every
// page as unchanged and reports nothing at all.
{
  let lines = 0;
  const trailing = [];
  for (const page of readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).sort()) {
    const rel = `docs/${page}`;
    const text = sourceWithMutation(rel);
    if (text === null) continue;
    text.split('\n').forEach((line, i) => {
      lines++;
      if (/[ \t]+$/.test(line)) trailing.push(`${rel}:${i + 1}`);
    });
  }
  if (lines === 0) {
    fail('no prose line was read at all, so the trailing-whitespace row passed on nothing');
  } else if (trailing.length) {
    fail(`${trailing.join(', ')} ends in whitespace - invisible in the page and in `
      + 'a clean `git diff --check`, so it survives until something reads the bytes');
  } else {
    console.log(`  prose/  no trailing whitespace, over ${lines} lines`);
  }
}

// Every id the application shell drives has to exist on the page that draws it, and every
// `shell.` key the code reads has to be declared by the table. `web/main.js` dereferences that
// table unguarded, so a half-applied rename fails at whichever consumer touches it first.
{
  const rel = 'web/main.js';
  const page = 'web/index.html';
  const src = sourceWithMutation(rel);
  const html = sourceWithMutation(page);
  if (src === null || html === null) {
    fail(`${src === null ? rel : page} is missing, so the shell's ids could not be checked against the page`);
  } else {
    // The call, not the function: `shellElements(` also appears where it is declared.
    const open = src.indexOf('const shell = shellElements({');
    const shut = open === -1 ? -1 : src.indexOf('});', open);
    const table = open === -1 || shut === -1 ? '' : src.slice(open, shut);
    const ids = [...table.matchAll(/^\s*\w+:\s*'([^']+)',$/gm)].map((m) => m[1]);
    const present = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

    if (open === -1 || shut === -1) {
      fail(`${rel} no longer builds its shell through shellElements({...}), so this row cannot find the ids it is meant to check`
        + ' - if the shell moved, move this row with it rather than leaving it looking at nothing');
    } else if (ids.length === 0) {
      fail(`${rel} declares a shell table this row could not read a single id out of, so this assertion passed on nothing`);
    } else {
      const gone = ids.filter((id) => !present.has(id));
      for (const id of gone) {
        fail(`the application shell drives #${id}, which ${page} does not declare`
          + ' - the module refuses by name at boot, so this is a surface that will not start');
      }

      // The other direction, and the one that shipped: the rule above walks the table outwards
      // and is blind to a `shell.thing` the table never declares.
      const keys = new Set([...table.matchAll(/^\s*(\w+):\s*'[^']+',$/gm)].map((m) => m[1]));
      keys.add('menus');
      // Comments stripped first, because the prose here and in `main.js` names these keys while
      // discussing them, and scanning raw source reddened the build on its own explanation.
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
// Said out loud because `npm test` runs this. Two rows execute rather than parse: the
// specification row imports a copy of `server/protocol.js` for its constants, and the anchor
// row imports the two spines and calls `assembleShaders`. Everything else is `node --check`.

console.log('syntax only - no proof tool ran here; see CLAUDE.md "Proof tools" for the suite and what each of them needs');
if (mutation && MUTATIONS[mutation]?.fails) console.log(`it should redden: ${MUTATIONS[mutation].fails}`);
process.exit(failed ? 1 : 0);
