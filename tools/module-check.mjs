#!/usr/bin/env node
// The module boundaries in `web/`: the import graph has no cycle, every import names a file
// this server can serve and a binding that file exports, mutable state crosses a boundary as a
// live `let` or a setter rather than as an object anybody may write into, and a name crosses
// only because both ends wanted it. No server, no browser, no dependencies - every failure it
// is about is a failure to boot, so an instrument that needs the page running cannot see one.
// The intra-module dead zone is out of scope and the run says so: it needs the call graph.
//
//   node tools/module-check.mjs [--root <dir>] [--mutate <name>]
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = argv.includes('--root') ? argv[argv.indexOf('--root') + 1] : REPO;

// Entries are `{ file, edits }`; four land outside `web/`, since rule 4 reads the whole checkout.
const MUTATIONS = {
  // A side-effect import rather than a named one, so the only row that can redden is the cycle row.
  'cycle-planted': {
    file: 'web/scene.js',
    edits: [["import * as THREE from 'three';", "import * as THREE from 'three';\nimport './main.js';"]],
  },

  'cycle-through-a-second-spelling': {
    file: 'web/scene.js',
    edits: [["import * as THREE from 'three';", "import * as THREE from 'three';\nimport '/main.js';"]],
  },

  'import-of-a-missing-file': {
    file: 'web/main.js',
    edits: [["import { pollRecordState } from './record-poll.js';", "import { pollRecordState } from './record-poll-moved.js';"]],
  },

  'import-names-a-missing-export': {
    file: 'web/main.js',
    edits: [["import { pollRecordState } from './record-poll.js';", "import { pollRecordState, pollRecorderState } from './record-poll.js';"]],
  },

  'one-spelling-for-every-module': {
    file: 'web/library.js',
    edits: [
      ["import { VALID_ID } from '/format.js';", "import { VALID_ID } from './format.js';"],
      ["import { pollRecordState } from '/record-poll.js';", "import { pollRecordState } from './record-poll.js';"],
    ],
  },

  // This and the two below redden two rows: the shape row here, and rule 4's export row, because
  // a planted export nothing imports is also a name only one end wanted.
  'exported-mutable-object': {
    file: 'web/format.js',
    edits: [['export const DEPTH_W = 512;', 'export const DEPTH_W = 512;\nexport const SENSOR_STATE = { frames: 0 };']],
  },

  // Aimed at somebody else's function rather than at an exported object: every object this tree
  // exports is exempt, so a plant aimed at one of those comes back excused.
  'imported-object-written-across-the-boundary': {
    file: 'web/main.js',
    edits: [['let openedProjectName = null;', 'let openedProjectName = null;\nscalarAt.cache = new Map();']],
  },

  'state-crosses-as-a-live-let': {
    file: 'web/format.js',
    edits: [['export const DEPTH_H = 424;', 'export const DEPTH_H = 424;\nexport let SENSOR_STATE = { frames: 0 };']],
  },

  'state-crosses-as-a-default': {
    file: 'web/format.js',
    edits: [['export const CAPTURE_FORMAT = 1;', 'export const CAPTURE_FORMAT = 1;\nexport default { frames: 0 };']],
  },

  'export-form-nothing-claims': {
    file: 'web/format.js',
    edits: [['export const PROJECT_VERSION = 8;', 'export const PROJECT_VERSION = 8;\nexport const { major, minor } = { major: 1, minor: 0 };']],
  },

  'a-barrel-re-export': {
    file: 'web/record-poll.js',
    edits: [["export const POLLED_NODE_FIELDS = ['writingId'];", "export const POLLED_NODE_FIELDS = ['writingId'];\nexport { DEPTH_W } from '/format.js';"]],
  },

  'write-through-a-namespace': {
    file: 'web/main.js',
    edits: [
      ["import { pollRecordState } from './record-poll.js';", "import { pollRecordState } from './record-poll.js';\nimport * as recordPoll from './record-poll.js';"],
      ['let openedProjectName = null;', 'let openedProjectName = null;\nrecordPoll.pollRecordState.cache = new Map();'],
    ],
  },

  'write-through-a-rename': {
    file: 'web/main.js',
    edits: [
      ["import { pollRecordState } from './record-poll.js';", "import { pollRecordState as poll } from './record-poll.js';"],
      ['let openedProjectName = null;', 'let openedProjectName = null;\npoll.cache = new Map();'],
    ],
  },

  // Re-anchored when the EDITOR tile went and took `LAST_OPENED` with it. The subject is the rule
  // that a page cannot write into an imported binding, and the anchor is only a stable top-level
  // line to hang the plant on - it has to be top level, because an `import` cannot be anywhere else.
  'write-from-a-page': {
    file: 'web/menu.html',
    edits: [[
      "const tiles = [...document.querySelectorAll('.entry')];",
      "const tiles = [...document.querySelectorAll('.entry')];\nimport { pollRecordState } from '/record-poll.js';\npollRecordState.cache = new Map();",
    ]],
  },

  // The keyword comes off rather than the name changing: a rename reddens a second row as well.
  'exemption-outlives-its-export': {
    file: 'web/record-poll.js',
    edits: [["export const POLLED_NODE_FIELDS = ['writingId'];", "const POLLED_NODE_FIELDS = ['writingId'];"]],
  },

  // Promoted to the number it is made of, so the entry still names an export and covers nothing.
  'exemption-covers-nothing': {
    file: 'web/curve.js',
    edits: [['const EASE_IN_LINEAR = [[2 / 3, 2 / 3]];', 'const EASE_IN_LINEAR = 2 / 3;']],
  },

  'import-nothing-uses': {
    file: 'web/main.js',
    edits: [["import { pollRecordState } from './record-poll.js';", "import { pollRecordState, POLLED_NODE_FIELDS } from './record-poll.js';"]],
  },

  // The alias is `recordPoll` and not `poll` because `gpuTimer` defines a `poll` method, and a use
  // question asked of a name rather than of a scope cannot tell that from a reference.
  'import-used-under-its-far-side-name': {
    file: 'web/main.js',
    edits: [["import { pollRecordState } from './record-poll.js';", "import { pollRecordState as recordPoll } from './record-poll.js';"]],
  },

  'export-nothing-imports': {
    file: 'web/format.js',
    edits: [['export const CAPTURE_FORMAT = 1;', 'export const CAPTURE_FORMAT = 1;\nexport const SENSOR_EPOCH = 0;']],
  },

  // Reddens two rows on purpose: the substituted name is dead in `server/library.js` too, and the
  // export it stopped holding up is now let out to nothing.
  'consumer-outside-web-drops-the-name': {
    file: 'server/library.js',
    edits: [["import { POLLED_NODE_FIELDS } from '../web/record-poll.js';", "import { pollRecordState } from '../web/record-poll.js';"]],
  },

  // The same two rows from the other direction - the import stays and its one reader stops.
  'dead-import-is-not-a-consumer': {
    file: 'server/library.js',
    edits: [[
      'const missing = POLLED_NODE_FIELDS.filter((f) => body[f] === undefined);',
      "const missing = ['writingId'].filter((f) => body[f] === undefined);",
    ]],
  },

  'outside-consumer-imports-a-name-it-never-reads': {
    file: 'tools/fake-grabber.mjs',
    edits: [["import { CAPTURE_FORMAT } from '../web/format.js';", "import { CAPTURE_FORMAT, DEPTH_W } from '../web/format.js';"]],
  },

  'dead-bare-import': {
    file: 'web/post-chain.js',
    edits: [[
      "import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';",
      "import { OutputPass, ClearPass } from 'three/addons/postprocessing/OutputPass.js';",
    ]],
  },

  'import-used-only-in-a-string': {
    file: 'web/main.js',
    edits: [["import { pollRecordState } from './record-poll.js';", "import { pollRecordState as duotone } from './record-poll.js';"]],
  },

  'import-used-only-as-an-object-key': {
    file: 'web/main.js',
    edits: [["import { pollRecordState } from './record-poll.js';", "import { pollRecordState as fov } from './record-poll.js';"]],
  },

  'namespace-hides-a-dead-export': {
    file: 'web/clip-range.js',
    edits: [['export let clipOut = null;', 'export let clipOut = null;\nexport const CLIP_EPSILON = 1e-6;']],
  },

  'namespace-reach-cannot-be-named': {
    file: 'test/clip-range.test.mjs',
    edits: [[
      'const { clipBoundOrThrow, writeClipRange } = clip;',
      'const { clipBoundOrThrow, writeClipRange } = clip;\nconst reached = Object.keys(clip);',
    ]],
  },
};

const mutateAt = argv.indexOf('--mutate');
const MUTATE = mutateAt === -1 ? null : argv[mutateAt + 1];
if (mutateAt !== -1 && !MUTATIONS[MUTATE]) {
  console.log(`DID NOT RUN - no mutation named ${MUTATE ?? '(nothing was given)'}; this tool knows ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// The one door every read goes through, so a mutated run differs in the substitution and in
// nothing else. An anchor that no longer matches is exit 2, never a failed assertion.
let mutationApplied = 0;
const read = (rel) => {
  const file = join(ROOT, rel);
  if (!existsSync(file)) return null;
  let src = readFileSync(file, 'utf8');
  if (!MUTATE || MUTATIONS[MUTATE].file !== rel) return src;
  for (const [from, to] of MUTATIONS[MUTATE].edits) {
    if (!src.includes(from)) {
      console.log(`DID NOT RUN - the ${MUTATE} anchor "${from}" is not in ${rel}, so nothing was mutated and this run would prove nothing`);
      process.exit(2);
    }
    src = src.replace(from, to);
    mutationApplied++;
  }
  return src;
};

let checked = 0;
let failed = 0;
const ok = (claim, cond, detail) => {
  checked++;
  if (cond) console.log(`  ok    ${claim}${detail === undefined ? '' : ` - ${detail}`}`);
  else { failed++; console.log(`  FAIL  ${claim}${detail === undefined ? '' : ` - ${detail}`}`); }
};

// One pass producing a mask saying what each character is, and a rewrite with everything that is
// neither code nor a string body blanked to spaces, newlines kept. A comment has to be removed
// before the match and not tested after it: prose carrying the word `import` above a real
// declaration makes a leftmost-first match begin inside the prose and the edge leaves the graph.
const CODE = 1;
const STRING_BODY = 2;
const codeMask = (src) => {
  const mask = new Uint8Array(src.length);
  const depths = new Uint16Array(src.length);
  const stack = [];
  const inTemplate = () => stack[stack.length - 1]?.kind === 'template';
  const ID_START = /[\p{ID_Start}$_]/u;
  const ID_PART = /[\p{ID_Continue}$\u200C\u200D]/u;
  const REGEX_AFTER = new Set(['return', 'throw', 'case', 'yield', 'typeof', 'instanceof',
    'in', 'of', 'delete', 'void', 'new', 'do', 'else', 'await']);
  let depth = 0;
  let prev = '';
  let prevWord = '';
  let i = 0;
  const code = (from, to) => { for (let k = from; k < to; k++) mask[k] = 1; };
  while (i < src.length) {
    const c = src[i];
    depths[i] = depth;
    if (inTemplate()) {
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { stack.pop(); mask[i] = 1; prev = '`'; prevWord = ''; i++; continue; }
      if (c === '$' && src[i + 1] === '{') {
        stack.push({ kind: 'code', depth });
        depth++;
        code(i, i + 2);
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
      mask[i] = 1;
      i++;
      const from = i;
      while (i < src.length && src[i] !== c) i += src[i] === '\\' ? 2 : 1;
      for (let k = from; k < i && k < src.length; k++) mask[k] = STRING_BODY;
      mask[i] = 1;
      i++;
      prev = c;
      prevWord = '';
      continue;
    }
    if (c === '`') { stack.push({ kind: 'template' }); mask[i] = 1; i++; prevWord = ''; continue; }
    if (ID_START.test(String.fromCodePoint(src.codePointAt(i)))) {
      let j = i;
      while (j < src.length) {
        const letter = String.fromCodePoint(src.codePointAt(j));
        if (!ID_PART.test(letter)) break;
        j += letter.length;
      }
      code(i, j);
      prevWord = src.slice(i, j);
      prev = 'a';
      i = j;
      continue;
    }
    // Transparent to the value question in both positions, so `counter++ / 2` is not a pattern.
    if ((c === '+' || c === '-') && src[i + 1] === c) { code(i, i + 2); i += 2; continue; }
    if (c === '/' && (!/[\w$)\]}'"`]/.test(prev) || REGEX_AFTER.has(prevWord))) {
      mask[i] = 1;
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
      mask[i] = 1;
      i++;
      // A finished pattern is a value, so the next slash is a quotient.
      prev = ')';
      prevWord = '';
      continue;
    }
    if (c === '{') { depth++; mask[i] = 1; prev = c; prevWord = ''; i++; continue; }
    if (c === '}') {
      depth--;
      const top = stack[stack.length - 1];
      mask[i] = 1;
      if (top?.kind === 'code' && top.depth === depth) { stack.pop(); prevWord = ''; i++; continue; }
      prev = c;
      prevWord = '';
      i++;
      continue;
    }
    mask[i] = 1;
    if (!/\s/.test(c)) { prev = c; prevWord = ''; }
    i++;
  }
  return { mask, depths };
};

// Code and string bodies as written, everything else a space, newlines kept.
const parsed = new Map();
const parse = (src) => {
  if (parsed.has(src)) return parsed.get(src);
  const { mask, depths } = codeMask(src);
  const out = new Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = mask[i] === 0 ? (src[i] === '\n' ? '\n' : ' ') : src[i];
  }
  const answer = { scan: out.join(''), mask, depths };
  parsed.set(src, answer);
  return answer;
};

const lineAt = (src, index) => src.slice(0, index).split('\n').length;

// Depth is what tells a declaration from a property called `export`, so a counter that drifts
// once skips every later top-level keyword without a row. No property key here is at column 0.
const atColumnZero = (src, index) => index === 0 || src[index - 1] === '\n';

// A declaration is read for the bindings it makes and not for the names it asks for: `{ a as b }`
// binds `b`, `* as ns` binds one object, `import d from` binds `default` under a local name.
const IMPORT_RE = /\bimport\s*(?:([^'";()]*?)\bfrom\s*)?(['"])([^'"]*)\2/g;
const REEXPORT_RE = /\bexport\s+([^'";]*?)\bfrom\s*(['"])([^'"]*)\2/g;
const DYNAMIC_RE = /\bimport\s*\(\s*(?:(['"])([^'"]*)\1)?/g;
// The two keywords, counted so a form no parse below claimed is named rather than dropped.
const IMPORT_TOKEN_RE = /(?<![.\w$])import\b/g;
const IMPORT_META_RE = /(?<![.\w$])import\s*\.\s*meta\b/g;

/**
 * The bindings an import clause makes: everything between `import` and `from`. `imported` is the
 * far-side name the target has to export and `local` is the name this module's own text uses; a
 * namespace import has no far-side name at all, only an object of the target's exports.
 */
const clauseBindings = (raw) => {
  const out = [];
  let rest = (raw ?? '').trim();
  if (!rest) return out;
  const named = /\{([\s\S]*?)\}/.exec(rest);
  if (named) {
    for (const part of named[1].split(',').map((p) => p.trim()).filter(Boolean)) {
      const [imported, local = imported] = part.split(/\s+as\s+/).map((p) => p.trim());
      if (!imported || !local) continue;
      out.push({ imported, local, kind: imported === 'default' ? 'default' : 'named' });
    }
    rest = `${rest.slice(0, named.index)} ${rest.slice(named.index + named[0].length)}`;
  }
  const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(rest);
  if (ns) {
    out.push({ imported: '*', local: ns[1], kind: 'namespace' });
    rest = `${rest.slice(0, ns.index)} ${rest.slice(ns.index + ns[0].length)}`;
  }
  for (const part of rest.split(',').map((p) => p.trim()).filter(Boolean)) {
    if (/^[A-Za-z_$][\w$]*$/.test(part)) out.push({ imported: 'default', local: part, kind: 'default' });
  }
  return out;
};

/**
 * The bindings a re-export clause names: `export { a as b } from './x'` asks the target for `a`
 * and binds nothing here. `export *` names nothing and is refused by a row of its own.
 */
const reexportBindings = (raw) => {
  const text = (raw ?? '').trim();
  if (/^\*/.test(text)) return [{ imported: '*', local: null, kind: 'star' }];
  return clauseBindings(text).map((b) => ({ ...b, local: null }));
};

const importsIn = (source) => {
  const { scan: src, mask, depths } = parse(source);
  const out = [];
  const claimed = new Set();
  for (const [re, bindingsOf] of [[IMPORT_RE, clauseBindings], [REEXPORT_RE, reexportBindings]]) {
    re.lastIndex = 0;
    for (const m of src.matchAll(re)) {
      if (mask[m.index] !== CODE) continue;
      if (re === IMPORT_RE) claimed.add(m.index);
      out.push({
        spec: m[3],
        bindings: bindingsOf(m[1]),
        line: lineAt(src, m.index),
        dynamic: false,
        // Where the declaration sits: a local name is written inside its own clause, so rule 4
        // has to blank the clause before asking whether the name is read anywhere.
        span: [m.index, m.index + m[0].length],
      });
    }
  }
  DYNAMIC_RE.lastIndex = 0;
  for (const m of src.matchAll(DYNAMIC_RE)) {
    if (mask[m.index] !== CODE) continue;
    claimed.add(m.index);
    out.push({ spec: m[2] ?? null, bindings: [], line: lineAt(src, m.index), dynamic: true, span: [m.index, m.index + m[0].length] });
  }
  IMPORT_META_RE.lastIndex = 0;
  for (const m of src.matchAll(IMPORT_META_RE)) if (mask[m.index] === CODE) claimed.add(m.index);
  const unclaimed = [];
  const drifted = [];
  IMPORT_TOKEN_RE.lastIndex = 0;
  for (const m of src.matchAll(IMPORT_TOKEN_RE)) {
    if (mask[m.index] !== CODE) continue;
    // An unclaimed token inside braces is a property called `import`, unless it is at column zero.
    if (depths[m.index] !== 0) {
      if (!claimed.has(m.index) && atColumnZero(src, m.index)) drifted.push(lineAt(src, m.index));
      continue;
    }
    if (!claimed.has(m.index)) unclaimed.push(lineAt(src, m.index));
  }
  return { imports: out, unclaimed, drifted };
};

// Root-relative throughout: `join(WEB_DIR, urlPath)` in `server/index.js` is the whole mapping.
const resolveSpec = (spec, from) => {
  if (spec === null) return { kind: 'unreadable' };
  if (!spec.startsWith('.') && !spec.startsWith('/')) return { kind: 'bare' };
  const base = spec.startsWith('/') ? [] : from.split('/').slice(0, -1);
  const parts = [...base];
  for (const part of spec.replace(/^\//, '').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (parts.length === 0) return { kind: 'escapes' }; parts.pop(); continue; }
    parts.push(part);
  }
  return { kind: 'in-tree', path: parts.join('/') };
};

// Three colours rather than one `visited` set, because with one set a diamond reads as a cycle.
// A ring is a list of edges carrying the specifier each was written as, not a list of modules.
const cyclesIn = (edges) => {
  const out = new Map();
  const bySource = new Map();
  for (const e of edges) {
    if (!bySource.has(e.from)) bySource.set(e.from, []);
    bySource.get(e.from).push(e);
  }
  const state = new Map();
  const nodeStack = [];
  // `edgeStack[i]` is the edge this walk took out of `nodeStack[i]`, so a closing ring is a slice.
  const edgeStack = [];
  const visit = (node) => {
    state.set(node, 'open');
    nodeStack.push(node);
    for (const edge of bySource.get(node) ?? []) {
      if (state.get(edge.to) === 'open') {
        const at = nodeStack.indexOf(edge.to);
        const ring = [...edgeStack.slice(at), edge];
        const key = ringText(ring);
        if (!out.has(key)) out.set(key, ring);
      } else if (!state.has(edge.to)) {
        edgeStack.push(edge);
        visit(edge.to);
        edgeStack.pop();
      }
    }
    nodeStack.pop();
    state.set(node, 'done');
  };
  for (const node of new Set([...bySource.keys(), ...edges.map((e) => e.to)])) {
    if (!state.has(node)) visit(node);
  }
  return [...out.values()];
};

const ringText = (ring, prefix = '') => ring
  .map((e) => `${prefix}${e.from} -> ${prefix}${e.to} via ${JSON.stringify(e.spec)}`)
  .join(', ');

// An exported name is resolved back to its own declaration before anything is said about shape.
const DECLARATION_RE = /^(?:export\s+)?(?:(const|let|var)\s+([A-Za-z_$][\w$]*)|(?:async\s+)?(function)\s*\*?\s*([A-Za-z_$][\w$]*)|(class)\s+([A-Za-z_$][\w$]*))/gm;
// Nothing below matches an export form until this has found the token, so a form nothing
// recognises is a failed assertion rather than a name that quietly never existed.
const EXPORT_TOKEN_RE = /(?<![.\w$])export\b/g;

// What a binding holds, from the first thing its initializer starts with. Anything this cannot
// place is classified as a writable object, which guesses toward reporting.
const shapeOfInit = (src, from, to) => {
  let i = from;
  while (i < to && /\s/.test(src[i])) i++;
  if (i >= to) return 'unset';
  const rest = src.slice(i, to);
  if (/^Object\s*\.\s*freeze\s*\(/.test(rest)) return 'frozen';
  if (/^(?:async\s+)?function\b/.test(rest) || /^class\b/.test(rest)) return 'behaviour';
  if (/^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(rest)) return 'behaviour';
  if (/^(?:new|await)\b/.test(rest)) return 'object';
  const c = src[i];
  if (c === '{' || c === '[' || c === '/') return 'object';
  if (c === "'" || c === '"' || c === '`') return 'primitive';
  if (/[\d.]/.test(c)) return 'primitive';
  if (/^(?:true|false|null|undefined|NaN|Infinity)\b/.test(rest)) return 'primitive';
  return 'object';
};

const declarationsIn = (src, mask) => {
  const out = new Map();
  DECLARATION_RE.lastIndex = 0;
  for (const m of src.matchAll(DECLARATION_RE)) {
    if (mask[m.index] !== CODE) continue;
    const kind = m[1] ?? m[3] ?? m[5];
    const name = m[2] ?? m[4] ?? m[6];
    if (out.has(name)) continue;
    let shape = 'behaviour';
    if (m[1]) {
      // A declaration list with two declarators is classified by its first name,
      // which over-reports.
      let i = m.index;
      let depth = 0;
      let eq = -1;
      let end = src.length;
      for (; i < src.length; i++) {
        if (mask[i] !== CODE) continue;
        const c = src[i];
        if ('([{'.includes(c)) depth++;
        else if (')]}'.includes(c)) depth--;
        else if (c === '=' && depth === 0 && eq === -1 && src[i + 1] !== '=' && src[i + 1] !== '>') eq = i + 1;
        else if (c === ';' && depth === 0) { end = i; break; }
      }
      shape = eq === -1 ? 'unset' : shapeOfInit(src, eq, end);
    }
    out.set(name, { kind, shape, line: lineAt(src, m.index) });
  }
  return out;
};

/**
 * The declarators of one `const`/`let`/`var` statement, split at the commas at depth zero, each
 * with the shape of its own initializer. The declaration scan above keys on the first name of a
 * statement, so `export const a = 1, b = {};` would have said one export, silently.
 */
const declaratorsIn = (src, mask, from, to) => {
  const out = [];
  const cuts = [];
  let depth = 0;
  let start = from;
  for (let i = from; i < to; i++) {
    if (mask[i] !== CODE) continue;
    const c = src[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { cuts.push([start, i]); start = i + 1; }
  }
  cuts.push([start, to]);
  for (const [a, b] of cuts) {
    const head = /^\s*([A-Za-z_$][\w$]*)\s*/.exec(src.slice(a, b));
    // A destructuring declarator binds names this scan does not take apart, so it is reported.
    if (!head) { out.push({ name: null, shape: null, line: lineAt(src, a), text: src.slice(a, b).trim() }); continue; }
    let eq = -1;
    let d = 0;
    for (let i = a + head[0].length; i < b; i++) {
      if (mask[i] !== CODE) continue;
      const c = src[i];
      if ('([{'.includes(c)) d++;
      else if (')]}'.includes(c)) d--;
      else if (c === '=' && d === 0 && src[i + 1] !== '=' && src[i + 1] !== '>') { eq = i + 1; break; }
    }
    out.push({ name: head[1], shape: eq === -1 ? 'unset' : shapeOfInit(src, eq, b), line: lineAt(src, a + head[0].indexOf(head[1])) });
  }
  return out;
};

/**
 * Everything a module lets out, by walking the `export` keyword and asking what follows it. The
 * five forms are the five the language has; anything else comes back in `unclaimed` and reddens a
 * row, because a form no regular expression matched used to contribute nothing at all.
 */
const exportsOf = (source) => {
  const { scan: src, mask, depths } = parse(source);
  const declared = declarationsIn(src, mask);
  const out = [];
  const unclaimed = [];
  const drifted = [];
  const tokens = [];
  EXPORT_TOKEN_RE.lastIndex = 0;
  for (const m of src.matchAll(EXPORT_TOKEN_RE)) {
    if (mask[m.index] !== CODE) continue;
    if (depths[m.index] !== 0) {
      if (atColumnZero(src, m.index)) drifted.push(lineAt(src, m.index));
      continue;
    }
    tokens.push(m.index);
  }
  // A statement runs to the `;` at depth zero and never past the next `export`, so one omitted
  // semicolon cannot swallow the rest of the file.
  const statementEnd = (from, ceiling) => {
    let depth = 0;
    for (let i = from; i < ceiling; i++) {
      if (mask[i] !== CODE) continue;
      const c = src[i];
      if ('([{'.includes(c)) depth++;
      else if (')]}'.includes(c)) depth--;
      else if (c === ';' && depth === 0) return i;
    }
    return ceiling;
  };
  const braceEnd = (from) => {
    let depth = 0;
    for (let i = from; i < src.length; i++) {
      if (mask[i] !== CODE) continue;
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) return i; }
    }
    return src.length;
  };
  for (let t = 0; t < tokens.length; t++) {
    const at = tokens[t];
    const ceiling = tokens[t + 1] ?? src.length;
    const line = lineAt(src, at);
    let i = at + 'export'.length;
    while (i < src.length && /\s/.test(src[i])) i++;
    const rest = src.slice(i, ceiling);
    const decl = /^(const|let|var)\s+/.exec(rest);
    if (decl) {
      const end = statementEnd(i, ceiling);
      for (const d of declaratorsIn(src, mask, i + decl[0].length, end)) {
        if (d.name === null) { unclaimed.push(`${line} (a destructuring declarator this scan does not take apart: ${d.text.slice(0, 40)})`); continue; }
        out.push({ name: d.name, local: d.name, kind: decl[1], shape: d.shape, line: d.line, form: 'declaration' });
      }
      continue;
    }
    const fn = /^(?:(?:async\s+)?function\s*\*?\s*|class\s+)([A-Za-z_$][\w$]*)/.exec(rest);
    if (fn) {
      out.push({ name: fn[1], local: fn[1], kind: /^class\b/.test(rest) ? 'class' : 'function', shape: 'behaviour', line, form: 'declaration' });
      continue;
    }
    if (/^default\b/.test(rest)) {
      const from = i + 'default'.length;
      out.push({ name: 'default', local: null, kind: 'default', shape: shapeOfInit(src, from, statementEnd(from, ceiling)), line, form: 'default' });
      continue;
    }
    if (rest.startsWith('{')) {
      const close = braceEnd(i);
      const after = src.slice(close + 1, ceiling);
      const from = /^\s*from\s*['"]([^'"]*)['"]/.exec(after);
      for (const part of src.slice(i + 1, close).split(',').map((p) => p.trim()).filter(Boolean)) {
        const [local, exported = local] = part.split(/\s+as\s+/).map((p) => p.trim());
        if (!local || !exported) continue;
        if (from) { out.push({ name: exported, local: null, kind: null, shape: null, line, form: 're-export', spec: from[1] }); continue; }
        out.push({ name: exported, local, ...(declared.get(local) ?? { kind: null, shape: null, line }), form: 'list' });
      }
      continue;
    }
    if (rest.startsWith('*')) {
      const as = /^\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(rest);
      const spec = /from\s*['"]([^'"]*)['"]/.exec(rest.slice(0, statementEnd(i, ceiling) - i));
      out.push({ name: as ? as[1] : '*', local: null, kind: null, shape: null, line, form: 're-export', spec: spec ? spec[1] : null, star: true });
      continue;
    }
    unclaimed.push(`${line} (export ${rest.slice(0, 24).replace(/\s+/g, ' ').trim()})`);
  }
  return { names: out, unclaimed, drifted };
};

// A write into a property of a binding this module imported. A method call is not this - it is
// the API the object publishes. A local shadowing an imported name is attributed to the import.
const OPS = String.raw`(?:\+\+|--|=(?![=>])|\+=|-=|\*=|\/=|%=|\*\*=|\?\?=|\|\|=|&&=|<<=|>>=|>>>=|&=|\|=|\^=)`;
// `$` is legal in an identifier and is an anchor in a pattern, so a name spelled into one
// unescaped matches nothing and says nothing about having matched nothing.
const rxName = (name) => name.replace(/\$/g, '\\$');
const writesInto = (source, name) => {
  const { scan: src, mask } = parse(source);
  const member = String.raw`(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]\n]*\])`;
  const re = new RegExp(String.raw`(?<![.\w$])${rxName(name)}(?:${member})+\s*${OPS}`, 'g');
  const hits = [];
  for (const m of src.matchAll(re)) {
    if (mask[m.index] !== CODE) continue;
    hits.push(lineAt(src, m.index));
  }
  const del = new RegExp(String.raw`(?<![.\w$])delete\s+${rxName(name)}(?:${member})+`, 'g');
  for (const m of src.matchAll(del)) {
    if (mask[m.index] !== CODE) continue;
    hits.push(lineAt(src, m.index));
  }
  return [...new Set(hits)].sort((a, b) => a - b);
};

/**
 * The same question through a namespace import, where the far-side name is in the first property
 * rather than in the binding: `ns.state.frames = 1` writes into the target's `state`. A computed
 * reach is reported under `*`, which no exemption can hold, so it fails rather than passes.
 */
const writesThroughNamespace = (source, ns) => {
  const { scan: src, mask } = parse(source);
  const member = String.raw`(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\[[^\]\n]*\])`;
  const found = new Map();
  const note = (name, line) => {
    if (!found.has(name)) found.set(name, new Set());
    found.get(name).add(line);
  };
  // Zero members is `ns.state = x`, which is a write across the boundary either way.
  const named = new RegExp(String.raw`(?<![.\w$])${rxName(ns)}\s*\.\s*([A-Za-z_$][\w$]*)(?:${member})*\s*${OPS}`, 'g');
  for (const m of src.matchAll(named)) {
    if (mask[m.index] !== CODE) continue;
    note(m[1], lineAt(src, m.index));
  }
  const deleted = new RegExp(String.raw`(?<![.\w$])delete\s+${rxName(ns)}\s*\.\s*([A-Za-z_$][\w$]*)(?:${member})+`, 'g');
  for (const m of src.matchAll(deleted)) {
    if (mask[m.index] !== CODE) continue;
    note(m[1], lineAt(src, m.index));
  }
  const computed = new RegExp(String.raw`(?<![.\w$])${rxName(ns)}\s*\[[^\]\n]*\](?:${member})*\s*${OPS}`, 'g');
  for (const m of src.matchAll(computed)) {
    if (mask[m.index] !== CODE) continue;
    note('*', lineAt(src, m.index));
  }
  return [...found.entries()].map(([name, lines]) => ({ name, lines: [...lines].sort((a, b) => a - b) }));
};

// Keyed on the module that owns the binding, so an exemption follows the declaration rather than
// the import site. Every entry has to still name an export and still cover something flagged.
const EXEMPTIONS = [
  {
    module: 'web/scene.js',
    binding: 'renderer',
    why: "three.js's own renderer. Configuring it - the drawing buffer, the pixel ratio, where its canvas sits - is the interface three.js publishes, and there is no setter-shaped alternative that is not a wrapper around the same writes.",
  },
  {
    module: 'web/scene.js',
    binding: 'scene',
    why: 'The scene graph. `scene.add(cloud)` is the publication channel three.js defines, and a scene nobody may add to is not a scene.',
  },
  {
    module: 'web/scene.js',
    binding: 'freeCamera',
    why: 'A three.js camera. Its pose and its field of view are written by the navigation and by the sensor view, which is what a camera object is for.',
  },
  {
    module: 'web/scene.js',
    binding: 'programCamera',
    why: 'The same, for the camera the transport poses from program time rather than from a hand.',
  },
  {
    module: 'web/scene.js',
    binding: 'viewCamera',
    why: 'Whichever of the two cameras above the viewport is drawing, moved by `useViewCamera` because an importer cannot assign to what it imports. The binding is live and the object it holds is a three.js camera, which is exactly what the two entries above say is the channel.',
  },
  {
    module: 'web/scene.js',
    binding: 'controls',
    why: 'OrbitControls, built after the canvas exists. Damping and `enabled` are switched by the surfaces that take the pointer over, which is the only way that library offers.',
  },
  {
    module: 'web/scene.js',
    binding: 'WORLD_UP',
    why: 'A three.js Vector3 naming the room vertical. Read-only in practice and a constant by intent, but a Vector3 cannot be frozen without breaking every three.js call that takes one as scratch.',
  },
  {
    module: 'web/scene.js',
    binding: 'DEFAULT_POSE',
    why: 'The pose a camera reset returns to, built by a call this scan cannot see inside. Copied out of rather than written into, and it is here because the classification guesses toward reporting rather than because a write was found.',
  },
  {
    module: 'web/format.js',
    binding: 'POINTS',
    why: 'The product of `DEPTH_W` and `DEPTH_H`, which is a number. Nothing writes it and nothing could - it is here because an initializer that opens on an identifier falls to this scan\'s report-rather-than-drop default, the same reason `web/scene.js::DEFAULT_POSE` is listed.',
  },
  {
    module: 'web/format.js',
    binding: 'VALID_ID',
    why: 'A regular expression with no `g` or `y` flag, so it carries no `lastIndex` between calls and there is no state in it to share.',
  },
  {
    module: 'web/curve.js',
    binding: 'EASE_OUT_LINEAR',
    why: 'A two-element control-point pair, read as a constant by every caller. An array literal rather than two exported numbers because it is passed straight into the easing functions as a pair.',
  },
  {
    module: 'web/curve.js',
    binding: 'EASE_IN_LINEAR',
    why: 'The same pair for the other side of a segment.',
  },
  {
    module: 'web/record-poll.js',
    binding: 'POLLED_NODE_FIELDS',
    why: 'The list of node fields a poll compares, read by `server/library.js` to decide which ones a manifest must carry. A list, iterated and never written.',
  },
  {
    module: 'web/export-sizes.js',
    binding: 'EXPORT_SIZES',
    why: 'Every output resolution the product offers, grouped by ratio. The whole point of the file is that this is one list rather than two - the menu, the ratio buttons and the export all read it and none of them writes it, and a build that wanted a different size would be adding an entry here rather than assigning one at run time.',
  },
  {
    module: 'web/view-window.js',
    binding: 'TICK_STEPS',
    why: 'The ladder a ruler picks its spacing from, in seconds. Searched with `find` by the one function that builds ticks and written by nothing - the property the array carries is that every rung divides the one above it, which a build wanting different gradations would change here rather than assign at run time.',
  },
  {
    module: 'web/plan-geometry.js',
    binding: 'INSET',
    why: 'Where the top-down inset sits and how big it is, in stage pixels. Read by the rect it is built into and by the stats overlay stacked under it; a literal that has never been written since the plan view was drawn.',
  },
  {
    module: 'web/plan-geometry.js',
    binding: 'TOP_CENTRE',
    why: 'The world x/z the plan view is centred on. Read by the two directions of the same coordinate change and by nothing else, and a pair of numbers rather than a point because it is not a place in three dimensions.',
  },
  // One entry per binding, because an exemption follows a binding rather than a kind.
  {
    module: 'web/post-chain.js',
    binding: 'renderPass',
    why: "three.js's own RenderPass. `camera` is repointed by the one function that decides which of the two cameras the viewport draws, which is what that field is for.",
  },
  {
    module: 'web/post-chain.js',
    binding: 'afterimage',
    why: 'The trails pass. `enabled` and `uniforms.damp` are written by the trails parameter\'s apply, together and in one line, because a damp of zero is a pass not worth running.',
  },
  {
    module: 'web/post-chain.js',
    binding: 'mosh',
    why: 'The feedback pass. `enabled` is written by the datamosh master the way the trails\' is, `uniforms.time` and `uniforms.moshIFrame` by the render loop once a frame, and `uniforms.resolution` by the resize - and its two history targets are read out by name where the accumulator reset clears them.',
  },
  // Four entries rather than three, because the fourth pass arrived with the same interface.
  {
    module: 'web/post-chain.js',
    binding: 'bloom',
    why: 'The glow. `strength` and `enabled` are written by the bloom parameter the same way, and `setSize` is called by `resize` with what `bloomChainSize` answers.',
  },
  {
    module: 'web/post-chain.js',
    binding: 'grade',
    why: 'The one combined grade pass. Eighteen look parameters write their term into `uniforms` and seven of them gate `enabled` on whether any term is up - which seven read off the packages\' `gates` bindings rather than listed - and that is the reason the pass is one rather than four.',
  },
  // A uniform is a cell the GPU reads and `.value =` is the only mechanism three.js offers, so a
  // setter per term would be the registry spelled twice. The other four exports need no entry.
  {
    module: 'web/point-cloud.js',
    binding: 'uniforms',
    why: "The cloud's uniform table. A uniform is a cell the GPU reads and writing `.value` on one is the whole of the interface three.js publishes for driving a shader, so the registry's look parameters land here directly; the alternative is a setter per parameter, which is the registry declared a second time in the module it drives.",
  },
  {
    module: 'web/point-cloud.js',
    binding: 'levelAngles',
    why: "The selected clip's two levelling angles, in degrees. The `tilt` and `roll` parameters write one member each and then recompose both into the clip's levelling group, so the pair is a two-cell table this module owns and `web/main.js` drives, exactly as it drives the uniform table above; a setter per angle would be those two parameters declared a second time. It is here rather than derived from the group because a quaternion does not say which of the two angles produced it.",
  },
];

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
};

const WEB = join(ROOT, 'web');
if (!existsSync(WEB) || !existsSync(join(ROOT, 'package.json'))) {
  console.log(`DID NOT RUN - ${ROOT} has no web/ or no package.json, so this is not a checkout of this repo`);
  process.exit(2);
}

console.log('[module] the modules under web/, and the pages that start them');

const files = walk(WEB).map((p) => relative(WEB, p).split('\\').join('/')).sort();
const jsFiles = files.filter((f) => /\.m?js$/.test(f));
const htmlFiles = files.filter((f) => /\.html$/.test(f));

// `type="module"` is one exact spelling in the HTML specification, so there is no list to keep.
const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const ATTR = (attrs, name) => {
  const m = new RegExp(String.raw`(?:^|\s)${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};

const scriptsIn = (page, html) => {
  const entries = [];
  const inline = [];
  SCRIPT_RE.lastIndex = 0;
  let n = 0;
  for (const m of html.matchAll(SCRIPT_RE)) {
    const type = (ATTR(m[1], 'type') ?? '').trim().toLowerCase();
    if (type !== 'module') continue;
    const src = ATTR(m[1], 'src');
    if (src) entries.push({ page, spec: src, line: lineAt(html, m.index) });
    else inline.push({ id: `${page}#module${n++}`, page, body: m[2], line: lineAt(html, m.index) });
  }
  return { entries, inline };
};

const sources = new Map();
for (const rel of jsFiles) sources.set(rel, read(`web/${rel}`));

const inlineModules = [];
const entryPoints = [];
const pageText = new Map();
let moduleScripts = 0;
for (const page of htmlFiles) {
  const html = read(`web/${page}`);
  pageText.set(page, html);
  const { entries, inline } = scriptsIn(page, html);
  moduleScripts += entries.length + inline.length;
  entryPoints.push(...entries);
  inlineModules.push(...inline);
}

ok('the walk found the modules web/ ships', jsFiles.length > 0, `${jsFiles.length}: ${jsFiles.join(', ')}`);
ok('and the pages that start them', htmlFiles.length > 0, `${htmlFiles.length}: ${htmlFiles.join(', ')}`);
ok('and every page was read for its module scripts, so a page that starts one is asked by existing',
  moduleScripts > 0, `${moduleScripts} script elements of type=module, ${entryPoints.length} with a src and ${inlineModules.length} inline`);

console.log('\n[module] rule 1: the relative-import graph is acyclic');

const newSink = () => ({
  edges: [], bareSpecs: [], unresolved: [], escaping: [], unreadable: [], unclaimedImports: [],
  drifted: [], spellings: new Map(), relativeSpecs: 0, dynamicSeen: 0, staticDeclarations: 0,
  // Not an edge in this graph, but the bindings it makes can go dead the way an in-tree one can.
  bareEdges: [],
  // Every import declaration in a body. Rule 4 blanks all of them before asking whether a name is
  // read - all, because two imports of one name would each read as a use of the other.
  importSpans: new Map(),
});
// The populations the prohibitions range over, counted where the walk happens rather than filtered
// out afterwards: a floor over a collection the sweep then skips part of reads as a wider sweep.
// One collector for a module body and for a page's inline module, and `inline` is the honest
// difference - a page has as many base URLs as `PAGES` gives it.
const collect = (fromId, src, sink, known, { inline = false } = {}) => {
  const { imports, unclaimed, drifted } = importsIn(src);
  for (const line of unclaimed) sink.unclaimedImports.push(`${fromId}:${line}`);
  for (const line of drifted) sink.drifted.push(`${fromId}:${line} import`);
  for (const imp of imports) {
    if (imp.dynamic) sink.dynamicSeen++;
    else sink.staticDeclarations++;
    if (!sink.importSpans.has(fromId)) sink.importSpans.set(fromId, []);
    sink.importSpans.get(fromId).push(imp.span);
    if (imp.spec !== null && imp.spec.startsWith('.')) sink.relativeSpecs++;
    if (inline && imp.spec !== null && imp.spec.startsWith('.')) {
      sink.unresolved.push(`${fromId}:${imp.line} ${imp.spec} (relative, and an inline module has no single base URL)`);
      continue;
    }
    const where = resolveSpec(imp.spec, fromId);
    if (where.kind === 'bare') {
      sink.bareSpecs.push(`${fromId}:${imp.line} ${imp.spec}`);
      sink.bareEdges.push({ from: fromId, to: null, spec: imp.spec, line: imp.line, bindings: imp.bindings });
      continue;
    }
    if (where.kind === 'unreadable') { sink.unreadable.push(`${fromId}:${imp.line}`); continue; }
    if (where.kind === 'escapes') { sink.escaping.push(`${fromId}:${imp.line} ${imp.spec}`); continue; }
    if (!known.has(where.path)) sink.unresolved.push(`${fromId}:${imp.line} ${imp.spec}`);
    if (!sink.spellings.has(where.path)) sink.spellings.set(where.path, new Set());
    sink.spellings.get(where.path).add(imp.spec);
    sink.edges.push({ from: fromId, to: where.path, spec: imp.spec, line: imp.line, bindings: imp.bindings });
  }
};

// Every text this run holds, keyed the way an edge names its source, so a missing body is named.
const bodies = new Map(sources);
for (const inline of inlineModules) bodies.set(inline.id, inline.body);
for (const [page, html] of pageText) bodies.set(page, html);

const tree = newSink();
const { edges, bareSpecs, unresolved, escaping, unreadable, unclaimedImports, spellings } = tree;
for (const [rel, src] of sources) collect(rel, src, tree, sources);
for (const inline of inlineModules) collect(inline.id, inline.body, tree, sources, { inline: true });
for (const entry of entryPoints) {
  const where = resolveSpec(entry.spec, entry.page);
  if (where.kind !== 'in-tree' || !sources.has(where.path)) {
    unresolved.push(`${entry.page}:${entry.line} ${entry.spec} (a page's own module script)`);
    continue;
  }
  if (!spellings.has(where.path)) spellings.set(where.path, new Set());
  spellings.get(where.path).add(entry.spec);
  edges.push({ from: entry.page, to: where.path, spec: entry.spec, line: entry.line, bindings: [], entry: true });
}

const inTree = edges.filter((e) => sources.has(e.to));
ok('the graph ranges over real edges rather than passing on an empty one',
  inTree.length > 0, `${inTree.length} in-tree edges, ${bareSpecs.length} bare specifiers left outside it`);

const cycles = cyclesIn(edges);
ok('no module under web/ imports its way back to itself',
  cycles.length === 0,
  cycles.length === 0
    ? `${new Set(edges.map((e) => e.from)).size} importers over ${sources.size} modules`
    : cycles.map((ring) => ringText(ring, 'web/')).join(' | '));

const reachable = new Set();
const reach = (node) => {
  if (reachable.has(node)) return;
  reachable.add(node);
  for (const e of edges) if (e.from === node) reach(e.to);
};
for (const entry of entryPoints) reach(entry.page);
for (const inline of inlineModules) reach(inline.id);
const orphans = [...sources.keys()].filter((rel) => !reachable.has(rel));
ok('and every module under web/ is reached from a page, directly or through another module',
  orphans.length === 0 && reachable.size > 0,
  orphans.length ? `nothing loads ${orphans.map((o) => `web/${o}`).join(', ')}` : `${[...sources.keys()].length} modules, all reached`);

// `web/` is acyclic, holds no dynamic `import()` and no specifier that climbs out of the tree, so
// nothing in it can falsify the detector or either prohibition. Asserted as exact rings.
{
  const probe = mkdtempSync(join(tmpdir(), 'module-check-probe-'));
  try {
    mkdirSync(join(probe, 'nested'), { recursive: true });
    const write = (name, body) => writeFileSync(join(probe, name), body);
    write('a.js', "import { b } from './b.js';\n");
    write('b.js', "import { c } from './nested/c.js';\n");
    write('nested/c.js', "import { a } from '../a.js';\n");
    write('self.js', "import './self.js';\n");
    write('d1.js', "import './d2.js';\nimport './d3.js';\n");
    write('d2.js', "import './d4.js';\n");
    write('d3.js', "import './d4.js';\n");
    write('d4.js', 'export const leaf = 1;\n');
    write('x.js', "import '/y.js';\n");
    write('y.js', "import './x.js';\n");
    // `import` lines inside a comment and a template, which separates a scan from a grep.
    write('quiet.js', "// import './a.js';\nconst doc = `\\nimport './b.js';\\n`;\nexport const quiet = doc;\n");
    // A literal specifier is an edge; a name is a node this graph cannot know it is missing.
    write('dyn.js', "const which = './b.js';\nimport(which);\nimport('./a.js');\nexport const where = import.meta.url;\n");
    write('out.js', "import '../outside.js';\n");
    // A form nobody thought of. Without it the prohibition ranges over an empty population.
    write('unread.js', 'import { a } from 0;\n');

    const probeFiles = walk(probe).map((p) => relative(probe, p).split('\\').join('/')).sort();
    const probeSources = new Map(probeFiles.map((rel) => [rel, readFileSync(join(probe, rel), 'utf8')]));
    const probeSink = newSink();
    for (const [rel, src] of probeSources) collect(rel, src, probeSink, probeSources);
    const probeEdges = probeSink.edges;
    const rings = cyclesIn(probeEdges).map((r) => ringText(r)).sort();
    ok('the search finds a three-module ring, a self-loop and a ring spelled through the server root, and calls the diamond acyclic',
      rings.length === 3
      && rings.includes('a.js -> b.js via "./b.js", b.js -> nested/c.js via "./nested/c.js", nested/c.js -> a.js via "../a.js"')
      && rings.includes('self.js -> self.js via "./self.js"')
      && rings.includes('x.js -> y.js via "/y.js", y.js -> x.js via "./x.js"'),
      rings.join(' | ') || 'no cycle found at all');
    ok('and the diamond contributes edges rather than a ring, so the search is not a single visited set',
      probeEdges.some((e) => e.from === 'd2.js' && e.to === 'd4.js')
      && probeEdges.some((e) => e.from === 'd3.js' && e.to === 'd4.js')
      && !rings.some((r) => r.includes('d4.js')),
      `${probeEdges.length} edges over ${probeFiles.length} probe files`);
    ok('and an import written inside a comment or a template is not an edge',
      !probeEdges.some((e) => e.from === 'quiet.js'),
      probeEdges.filter((e) => e.from === 'quiet.js').map((e) => e.to).join(', ') || 'none, as required');
    ok('and a dynamic import() is read: the literal one is an edge and the one whose specifier is a name is refused as unreadable',
      probeSink.dynamicSeen === 2
      && probeEdges.some((e) => e.from === 'dyn.js' && e.to === 'a.js' && e.spec === './a.js')
      && probeSink.unreadable.length === 1 && probeSink.unreadable[0].startsWith('dyn.js:'),
      `${probeSink.dynamicSeen} dynamic imports, unreadable: ${probeSink.unreadable.join(', ') || 'none, which is the failure this row exists for'}`);
    ok('and a specifier that climbs out of the tree is refused rather than resolved to a path outside it',
      probeSink.escaping.length === 1 && probeSink.escaping[0].startsWith('out.js:'),
      probeSink.escaping.join(', ') || 'nothing escaped, so the branch that decides it never ran');
    ok('and the one import keyword no form claimed is named, while import.meta and a dynamic import beside it are not',
      probeSink.unclaimedImports.length === 1 && probeSink.unclaimedImports[0].startsWith('unread.js:'),
      `${probeSink.unclaimedImports.join(', ') || 'nothing was named, so the branch that names it never ran'} - over ${probeSink.staticDeclarations} declarations and ${probeSink.dynamicSeen} dynamic imports`);
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
}

console.log('\n[module] rule 2: every import resolves, and names something the other side exports');

ok('every relative or root-relative specifier names a file this tree holds',
  unresolved.length === 0, unresolved.length ? unresolved.join('; ') : `${inTree.length} checked`);
ok('and every import keyword in the tree opened a form this scan claimed rather than one it walked past',
  unclaimedImports.length === 0,
  unclaimedImports.length
    ? unclaimedImports.join('; ')
    : `none unclaimed, over ${tree.staticDeclarations} declarations and ${tree.dynamicSeen} dynamic imports`);
ok('and none of them escapes web/, which this server answers 403 for rather than serving',
  escaping.length === 0, escaping.length ? escaping.join('; ') : `none, over ${tree.relativeSpecs} relative specifiers`);
ok('and no dynamic import() carries a specifier nothing can read, which would be a node outside this graph',
  unreadable.length === 0, unreadable.length ? unreadable.join('; ') : `none, over ${tree.dynamicSeen} dynamic import${tree.dynamicSeen === 1 ? '' : 's'} - a prohibition this tree has an empty population for, which is why the probe above carries one of each`);

// The fold that lets `./format.js` and `/format.js` be one node has to be exercised by the tree.
const folded = [...spellings.entries()].filter(([, s]) => s.size > 1);
ok('at least one module is imported under two spellings, so the fold onto one node is exercised rather than assumed',
  folded.length > 0,
  folded.length
    ? folded.map(([path, s]) => `web/${path} as ${[...s].join(' and ')}`).join('; ')
    : 'every module is imported one way only, so a resolver that folded nothing would pass this run');

const exportsByModule = new Map();
const unclaimedExports = [];
for (const [rel, src] of sources) {
  const { names, unclaimed, drifted } = exportsOf(src);
  exportsByModule.set(rel, names);
  for (const u of unclaimed) unclaimedExports.push(`web/${rel}:${u}`);
  for (const d of drifted) tree.drifted.push(`web/${rel}:${d} export`);
}
for (const inline of inlineModules) {
  const { unclaimed, drifted } = exportsOf(inline.body);
  for (const u of unclaimed) unclaimedExports.push(`${inline.id}:${u}`);
  for (const d of drifted) tree.drifted.push(`${inline.id}:${d} export`);
}

const missingNames = [];
let importedBindings = 0;
let bindingDeclarations = 0;
for (const edge of inTree) {
  const has = new Set((exportsByModule.get(edge.to) ?? []).map((e) => e.name));
  let any = false;
  for (const b of edge.bindings) {
    // A namespace names nothing on the far side. The write sweep is where it is asked.
    if (b.kind === 'namespace' || b.kind === 'star') continue;
    importedBindings++;
    any = true;
    if (!has.has(b.imported)) {
      missingNames.push(`web/${edge.from}:${edge.line} imports ${b.kind === 'default' ? 'the default of' : b.imported} from`
        + ` web/${edge.to}, which does not export ${b.kind === 'default' ? 'one' : 'it'}`);
    }
  }
  if (any) bindingDeclarations++;
}
ok('every named import is a name the module it comes from exports',
  missingNames.length === 0 && importedBindings > 0,
  missingNames.length
    ? missingNames.join('; ')
    : `${importedBindings} bindings across ${bindingDeclarations} declarations`);

ok('and every export keyword in the tree opened a form this scan claimed, so a spelling nobody thought of costs an assertion rather than an export',
  unclaimedExports.length === 0,
  unclaimedExports.length
    ? unclaimedExports.join('; ')
    : `none unclaimed, over ${[...exportsByModule.values()].reduce((n, l) => n + l.length, 0)} exported names`);

// A barrel is refused rather than followed: resolving one needs a second resolver, and the
// one-implementation rule forbids the shape anyway.
const barrels = [];
for (const [rel, list] of exportsByModule) {
  for (const e of list) {
    if (e.form !== 're-export') continue;
    barrels.push(`web/${rel}:${e.line} re-exports ${e.star ? '*' : e.name}${e.spec ? ` from ${e.spec}` : ''}`);
  }
}
ok('and no module re-exports another module\'s binding, which is the barrel the one-implementation rule refuses',
  barrels.length === 0,
  barrels.length ? barrels.join('; ') : `none, over ${[...exportsByModule.values()].reduce((n, l) => n + l.length, 0)} exported names`);

// The audit above decides "declaration or property key" by brace depth, so a drifted counter
// would skip a real declaration without a row. Column zero is the cross-check.
ok('and no import or export written at column zero was read as nested, which is what a drifted brace counter looks like',
  tree.drifted.length === 0,
  tree.drifted.length ? tree.drifted.join('; ') : `none, over ${sources.size} modules and ${inlineModules.length} inline module${inlineModules.length === 1 ? '' : 's'}`);

console.log('  note  the intra-module dead zone is NOT tested here - a top-level statement reaching, through property dispatch,');
console.log('        a const declared further down the same module is not statically decidable, and this tool needs nothing.');
console.log('        That is the fault the comments above groupRevealChanged and transportWriting in web/main.js record, and');
console.log('        it belongs to the post-boot state diff rather than to a source scan. See the header for why.');

console.log('\n[module] rule 3: mutable state crosses as a live let or a setter, never as a writable object');

/**
 * Both halves of rule 3 over one tree: which exports are objects an importer can write into, and
 * which modules write into a binding they did not declare. A function taking its tree as an
 * argument because `web/` cannot falsify either half - every object it exports is exempt - so the
 * probe below runs this same function over a tree holding one of every spelling.
 */
const rule3 = ({ bodies: text, edges: graph, exportsByModule: exported, exemptions, prefix }) => {
  const exempt = new Map(exemptions.map((e) => [`${e.module}::${e.binding}`, e]));
  const used = new Set();
  const buckets = { primitive: 0, behaviour: 0, 'live-let': 0, frozen: 0, exempted: 0, 're-exported': 0, unresolved: 0 };
  const writable = [];
  const crossWrites = [];
  const skipped = [];
  let totalExports = 0;
  let sweptBindings = 0;
  let sweptDeclarations = 0;
  for (const [rel, list] of exported) {
    for (const e of list) {
      totalExports++;
      const key = `${prefix}${rel}::${e.name}`;
      if (e.form === 're-export') { buckets['re-exported']++; continue; }
      if (e.kind === null) { buckets.unresolved++; writable.push({ key, text: `${key} is exported with no declaration this scan could find, so nothing here knows what crosses` }); continue; }
      if (e.kind === 'function' || e.kind === 'class' || e.shape === 'behaviour') { buckets.behaviour++; continue; }
      if (e.shape === 'primitive') { buckets.primitive++; continue; }
      if (e.shape === 'frozen') { buckets.frozen++; continue; }
      // The shape decides before the keyword does: an importer cannot assign to what it imports,
      // but writing a property on the object a live `let` holds is the same fault.
      if (e.shape === 'object') {
        if (exempt.has(key)) { buckets.exempted++; used.add(key); continue; }
        writable.push({
          key,
          text: `${key} is ${e.kind === 'default' ? 'the default export,' : `a ${e.kind}`} holding an object (${prefix}${rel}:${e.line}), and no exemption declares why that is the channel`,
        });
        continue;
      }
      // A binding with no initializer to read. The object it ends up holding is the sweep's job.
      if (e.kind === 'let' || e.kind === 'var') { buckets['live-let']++; continue; }
      if (exempt.has(key)) { buckets.exempted++; used.add(key); continue; }
      writable.push({ key, text: `${key} is a ${e.kind} this scan reads as ${e.shape} (${prefix}${rel}:${e.line}), and no exemption declares why that is the channel` });
    }
  }
  for (const edge of graph) {
    const src = text.get(edge.from);
    // An edge whose importing text this run does not hold is a hole in the population.
    if (src === undefined) { skipped.push(`${prefix}${edge.from}:${edge.line} -> ${prefix}${edge.to}`); continue; }
    let any = false;
    for (const b of edge.bindings) {
      if (!b.local) continue;
      sweptBindings++;
      any = true;
      const direct = b.kind === 'namespace' ? null : writesInto(src, b.local);
      const hits = b.kind === 'namespace'
        ? writesThroughNamespace(src, b.local)
        : (direct.length ? [{ name: b.imported, lines: direct }] : []);
      for (const hit of hits) {
        const key = `${prefix}${edge.to}::${hit.name}`;
        if (exempt.has(key)) { used.add(key); continue; }
        const how = b.kind === 'namespace'
          ? `reaches through the namespace ${b.local} it imports from`
          : `imports${b.local === b.imported ? '' : ` as ${b.local}`} from`;
        crossWrites.push({
          from: edge.from,
          to: edge.to,
          name: hit.name,
          text: `${prefix}${edge.from} writes into ${hit.name === 'default' ? 'the default export of' : hit.name}, which it ${how} ${prefix}${edge.to}, at ${hit.lines.join(', ')}`,
        });
      }
    }
    if (any) sweptDeclarations++;
  }
  return { buckets, writable, crossWrites, skipped, used, totalExports, sweptBindings, sweptDeclarations };
};

/**
 * What each exemption is still doing: naming an export this tree has, and covering something a
 * rule flagged. The second conjunct is the one with teeth - an entry that covers nothing is a
 * filter that has quietly stopped filtering.
 */
const auditExemptions = (entries, exported, used, prefix, moduleExists) => entries.map((entry) => {
  const key = `${entry.module}::${entry.binding}`;
  const rel = entry.module.startsWith(prefix) ? entry.module.slice(prefix.length) : entry.module;
  const known = (exported.get(rel) ?? []).some((e) => e.name === entry.binding);
  const covers = used.has(key);
  const said = entry.why.trim().length > 0;
  return {
    key,
    pass: known && covers && said,
    detail: !moduleExists(entry.module)
      ? `${entry.module} is gone, so this entry is about a module that no longer exists`
      : !known
        ? `${entry.module} no longer exports ${entry.binding}, so this entry names nothing`
        : !covers
          ? 'nothing was flagged that it exempts, so it is a filter that would go on covering whatever matched it next'
          : entry.why.slice(0, 96),
  };
});

const r3 = rule3({ bodies, edges: inTree, exportsByModule, exemptions: EXEMPTIONS, prefix: 'web/' });
ok('the classification ranges over the exports this tree has rather than passing on an empty set',
  r3.totalExports > 0,
  `${r3.totalExports} exports: ${Object.entries(r3.buckets).map(([k, v]) => `${v} ${k}`).join(', ')}`);
ok('no module exports a writable object without an exemption saying why that is the channel',
  r3.writable.length === 0, r3.writable.length ? r3.writable.map((w) => w.text).join('; ') : 'none');
ok('and every in-tree edge was swept from a body this run holds, so the count below is what was walked',
  r3.skipped.length === 0,
  r3.skipped.length ? r3.skipped.join('; ') : `${bodies.size} bodies for ${inTree.length} edges, none skipped`);
ok('and no module writes a property or an element of a binding it imported, outside the same table',
  r3.crossWrites.length === 0,
  r3.crossWrites.length
    ? r3.crossWrites.map((c) => c.text).join('; ')
    : `${r3.sweptBindings} bindings across ${r3.sweptDeclarations} declarations swept`);

ok('the exemption table has entries in it, so the two rows above are not exempting everything by holding nothing',
  EXEMPTIONS.length > 0, `${EXEMPTIONS.length} entries`);
for (const verdict of auditExemptions(EXEMPTIONS, exportsByModule, r3.used, 'web/', (m) => existsSync(join(ROOT, m)))) {
  ok(`the exemption for ${verdict.key} still names an export this tree has, and still covers something`,
    verdict.pass, verdict.detail);
}

// `web/` cannot falsify rule 3: every object it exports is in the table, and it exports nothing
// as a default and imports nothing under a rename or a namespace. Asserted as exact sets rather
// than counts, since a sweep that flagged four things where these five are would pass a floor.
{
  const S = [
    'export default { frames: 0 };',
    'export let live = { n: 0 };',
    'export const cursor = { at: 0 };',
    'export const sealed = Object.freeze({ a: 1 });',
    'export const count = 3;',
    'export function fn() { return count; }',
    'const HANDLE = { a: 1 };',
    'export { HANDLE as handle }',
    '',
  ].join('\n');
  const W = [
    "import d from './s.js';",
    "import * as ns from './s.js';",
    "import { handle as h, count, cursor } from './s.js';",
    'd.frames = 1;',
    'ns.live.n = 2;',
    'h.a = 3;',
    'ns.fn.memo = 4;',
    'const seen = cursor.at + count;',
    'cursor.toString();',
    'ns.fn(seen);',
    '',
  ].join('\n');
  const PAGE = [
    '<body>',
    '<script type="module">',
    "import { handle } from '/s.js';",
    'handle.a = 9;',
    '</script>',
    '</body>',
    '',
  ].join('\n');

  const probeSources = new Map([['s.js', S], ['w.js', W]]);
  const { inline } = scriptsIn('p.html', PAGE);
  const probeBodies = new Map(probeSources);
  for (const m of inline) probeBodies.set(m.id, m.body);
  const sink = newSink();
  for (const [rel, src] of probeSources) collect(rel, src, sink, probeSources);
  for (const m of inline) collect(m.id, m.body, sink, probeSources, { inline: true });
  const probeExports = new Map([...probeSources].map(([rel, src]) => [rel, exportsOf(src).names]));

  const bare = rule3({ bodies: probeBodies, edges: sink.edges, exportsByModule: probeExports, exemptions: [], prefix: '' });
  const flagged = bare.writable.map((w) => w.key).sort();
  ok('every shape of exported object is flagged: a default, a live let holding one, a const, and one let out under a rename by a list with no semicolon',
    flagged.length === 4
    && flagged.join(' | ') === 's.js::cursor | s.js::default | s.js::handle | s.js::live',
    `${flagged.join(', ') || 'nothing was flagged at all'} - and beside them ${bare.buckets.primitive} primitive, ${bare.buckets.behaviour} behaviour, ${bare.buckets.frozen} frozen`);

  const written = bare.crossWrites.map((c) => `${c.from}::${c.name}`).sort();
  ok('and the write sweep sees every spelling an import brings a binding in under - a rename, a namespace, a default, and a page\'s inline module',
    written.join(' | ') === 'p.html#module0::handle | w.js::default | w.js::fn | w.js::handle | w.js::live',
    written.join(', ') || 'nothing was flagged at all');
  ok('and a read or a method call through those same bindings is not a write',
    !written.some((w) => w.endsWith('::cursor') || w.endsWith('::count')),
    `cursor is read and called and count is read, and neither is flagged: ${written.filter((w) => w.endsWith('::cursor') || w.endsWith('::count')).join(', ') || 'none'}`);
  ok('and no edge of that tree was skipped for want of a body, which is what the count over the real tree means',
    bare.skipped.length === 0 && bare.sweptDeclarations === 4,
    `${bare.sweptBindings} bindings across ${bare.sweptDeclarations} declarations, ${bare.skipped.length} skipped`);
  // The same run with the page's inline module out of the map of bodies. The row above means what
  // it says only if this one names what went missing.
  const blind = rule3({
    bodies: probeSources, edges: sink.edges, exportsByModule: probeExports, exemptions: [], prefix: '',
  });
  ok('and an edge whose text this run does not hold is named rather than dropped out of the count',
    blind.skipped.length === 1 && blind.skipped[0].startsWith('p.html#module0')
    && blind.sweptDeclarations === bare.sweptDeclarations - 1,
    `${blind.skipped.join(', ') || 'nothing was named, so the branch that names it never ran'} - ${blind.sweptDeclarations} declarations swept where the whole map gives ${bare.sweptDeclarations}`);

  // The audit's three verdicts, each fired by an entry written to earn it.
  const probeTable = [
    { module: 's.js', binding: 'handle', why: 'names a real export and covers both a flagged shape and a flagged write' },
    { module: 's.js', binding: 'count', why: 'names a real export and covers nothing, because a primitive is never flagged' },
    { module: 's.js', binding: 'departed', why: 'names nothing this tree exports' },
  ];
  const held = rule3({ bodies: probeBodies, edges: sink.edges, exportsByModule: probeExports, exemptions: probeTable, prefix: '' });
  const verdicts = auditExemptions(probeTable, probeExports, held.used, '', () => true);
  ok('and the exemption audit separates an entry that covers something from one that covers nothing and one that names nothing',
    verdicts[0].pass === true
    && verdicts[1].pass === false && /nothing was flagged that it exempts/.test(verdicts[1].detail)
    && verdicts[2].pass === false && /no longer exports/.test(verdicts[2].detail),
    verdicts.map((v) => `${v.key}: ${v.pass ? 'covers something' : v.detail.slice(0, 44)}`).join(' | '));
  // The brace counter's control, and the case this lexer leaves ambiguous on purpose: a `/` after
  // `}` is division, so the pattern's body is scanned as code and the `{` inside it counted.
  const drifting = 'if (a) { b(); }\n/x{/.test(a);\nexport const after = 1;\n';
  const shifted = exportsOf(drifting);
  ok('and an export at column zero that the brace counter puts inside braces is named rather than skipped',
    shifted.drifted.length === 1 && shifted.names.length === 0,
    shifted.drifted.length
      ? `line ${shifted.drifted.join(', ')}, and ${shifted.names.length} exports read off a file that has one`
      : 'nothing was named, so either the counter did not drift or the cross-check did not fire');

  ok('and an exemption answers the write it was written for rather than the run at large',
    held.crossWrites.every((c) => c.name !== 'handle') && held.writable.every((w) => w.key !== 's.js::handle')
    && held.crossWrites.some((c) => c.name === 'live'),
    `${held.writable.length} shapes and ${held.crossWrites.length} writes left after one entry, where the bare table left ${bare.writable.length} and ${bare.crossWrites.length}`);
}

console.log('\n[module] rule 4: every import is read, and every export is asked for');

// One question, asked once of every declaration that carries a name across this directory's edge,
// and both halves of the rule read the same answer: does the file that wrote it read the name it
// binds? Unjoined, a dead import reddens the import row and is then counted as the reader
// keeping the far side's export alive. The population includes declarations outside `web/`.

// The text a use is looked for in and the mask saying what each position is - comments blanked,
// string bodies kept - with every import declaration blanked on top. All of them, because two
// imports of one name from two modules would each read as a use of the other.
const surfaces = new Map();
const useSurface = (key, src, spans) => {
  if (surfaces.has(key)) return surfaces.get(key);
  const { scan, mask } = parse(src);
  const chars = scan.split('');
  for (const [from, to] of spans) {
    for (let i = from; i < to && i < chars.length; i++) if (chars[i] !== '\n') chars[i] = ' ';
  }
  const answer = { text: chars.join(''), mask };
  surfaces.set(key, answer);
  return answer;
};

// A use is a hit in code position that is not a property key. String bodies survive the blanking,
// so the mask is asked instead of the text. A property key is decided by its neighbours - `{` or
// `,` before, `:` after - rather than by a lookahead, which called twelve live imports dead. Still
// open is the method shorthand `{ poll(gl) { ... } }`, which a search cannot tell from a call.
const codeAt = (surface, i) => (i >= 0 && i < surface.text.length && surface.mask[i] === CODE);
const nextCode = (surface, from, step) => {
  let i = from;
  while (i >= 0 && i < surface.text.length && /\s/.test(surface.text[i])) i += step;
  return i;
};
const isPropertyKey = (surface, at, name) => {
  const before = nextCode(surface, at - 1, -1);
  if (!codeAt(surface, before) || (surface.text[before] !== '{' && surface.text[before] !== ',')) return false;
  const after = nextCode(surface, at + name.length, 1);
  return codeAt(surface, after) && surface.text[after] === ':';
};
const readsName = (surface, name) => {
  const re = new RegExp(String.raw`(?<![.\w$])${rxName(name)}(?![\w$])`, 'g');
  for (const m of surface.text.matchAll(re)) {
    if (surface.mask[m.index] !== CODE) continue;
    if (isPropertyKey(surface, m.index, name)) continue;
    return lineAt(surface.text, m.index);
  }
  return null;
};

/**
 * Which exports a namespace binding reaches, and where it reaches the module in a way this scan
 * cannot name. Taking a namespace as a request for every export switched the export row off for
 * `web/clip-range.js` entirely. So a dotted reach asks for that one name, a destructure for the
 * names in its pattern, and everything else - `Object.keys(ns)`, `{ ...ns }`, a `for...in`, the
 * binding handed to a function - consumes them all and says so in a row of its own.
 */
const readsThroughNamespace = (surface, ns) => {
  const names = new Set();
  const opaque = [];
  const re = new RegExp(String.raw`(?<![.\w$])${rxName(ns)}(?![\w$])`, 'g');
  for (const m of surface.text.matchAll(re)) {
    if (surface.mask[m.index] !== CODE) continue;
    const dotted = /^\s*\.\s*([A-Za-z_$][\w$]*)/.exec(surface.text.slice(m.index + ns.length, m.index + ns.length + 120));
    if (dotted) { names.add(dotted[1]); continue; }
    const pattern = /\{([^{}]*)\}\s*=\s*$/.exec(surface.text.slice(0, m.index));
    if (pattern && !pattern[1].includes('...')) {
      for (const part of pattern[1].split(',')) {
        const key = part.split(':')[0].split('=')[0].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(key)) names.add(key);
      }
      continue;
    }
    opaque.push(lineAt(surface.text, m.index));
  }
  return { names, opaque };
};

// The consumer set is the repository and not `web/`, because seven of this tree's exports have no
// importer inside it. The walk is wide and the read is narrow: a directory missed reddens a live
// export, where one walked that should not be manufactures a consumer and hides a dead one.
const OUTSIDE_SKIP = new Set(['node_modules', 'vendor', 'third_party', 'web']);
const outsideFiles = [];
const walkOutside = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) { if (!OUTSIDE_SKIP.has(entry.name)) walkOutside(p); continue; }
// JavaScript only: running the module scan over arbitrary HTML would invent consumers.
    if (/\.[mc]?js$/.test(entry.name)) outsideFiles.push(relative(ROOT, p).split('\\').join('/'));
  }
};
walkOutside(ROOT);
outsideFiles.sort();

// Every declaration the use question is asked of, gathered before any of it is asked, with `kind`
// per declaration because the row below counts its population where the sweep happens.
const crossings = [];
const unsweptEdges = [];
for (const edge of [...inTree, ...tree.bareEdges]) {
  const src = bodies.get(edge.from);
  // An edge asked of a body this run does not hold would be a name silently not asked about.
  if (src === undefined) { unsweptEdges.push(`web/${edge.from}:${edge.line}`); continue; }
  crossings.push({
    kind: edge.to === null ? 'bare' : 'in-tree',
    where: `web/${edge.from}`,
    surface: useSurface(edge.from, src, tree.importSpans.get(edge.from) ?? []),
    target: edge.to,
    spec: edge.spec,
    line: edge.line,
    bindings: edge.bindings,
  });
}
let outsideImports = 0;
for (const rel of outsideFiles) {
  const src = read(rel);
  if (src === null) continue;
  const { imports } = importsIn(src);
  const surface = useSurface(rel, src, imports.map((imp) => imp.span));
  for (const imp of imports) {
    if (imp.spec === null || (!imp.spec.startsWith('.') && !imp.spec.startsWith('/'))) continue;
    const where = resolveSpec(imp.spec, rel);
    if (where.kind !== 'in-tree' || !where.path.startsWith('web/')) continue;
    const target = where.path.slice('web/'.length);
    if (!sources.has(target)) continue;
    outsideImports++;
    crossings.push({
      kind: 'outside', where: rel, surface, target, spec: imp.spec, line: imp.line, bindings: imp.bindings,
    });
  }
}

const consumers = new Map();
const consumeName = (rel, name, where) => {
  const key = `${rel}::${name}`;
  if (!consumers.has(key)) consumers.set(key, new Set());
  consumers.get(key).add(where);
};
const consumeEverything = (rel, where) => {
  for (const e of exportsByModule.get(rel) ?? []) consumeName(rel, e.name, where);
};

const unusedImports = [];
const opaqueReaches = [];
const asked = { 'in-tree': 0, bare: 0, outside: 0 };
let sweptImportNames = 0;
let liveBindings = 0;
let deadBindings = 0;
let namespaceBindings = 0;
for (const c of crossings) {
  let any = false;
  const exported = c.target === null ? null : new Set((exportsByModule.get(c.target) ?? []).map((e) => e.name));
  for (const b of c.bindings) {
    // A re-export binds nothing here and does ask the far side for a name; the barrel row refuses
    // both, and this branch keeps that mutation reddening one claim rather than two.
    if (!b.local) {
      if (c.target === null) continue;
      if (b.kind === 'star') consumeEverything(c.target, c.where);
      else consumeName(c.target, b.imported, c.where);
      continue;
    }
    // A name the other side does not export is already named by rule 2's row. For a declaration
    // outside `web/` that skip is a scope boundary: rule 2 ranges over the in-tree edges only.
    if (exported && b.kind !== 'namespace' && !exported.has(b.imported)) continue;
    any = true;
    sweptImportNames++;
    if (readsName(c.surface, b.local) === null) {
      deadBindings++;
      unusedImports.push(`${c.where}:${c.line} imports ${b.kind === 'namespace' ? `the namespace ${b.local}` : b.local}`
        + ` from ${c.target === null ? c.spec : `web/${c.target}`}, and no line of ${c.where} reads it`);
      // The join: a binding no line reads asks the far side for nothing, so it holds nothing up.
      continue;
    }
    liveBindings++;
    if (c.target === null) continue;
    if (b.kind === 'namespace') {
      namespaceBindings++;
      const { names, opaque } = readsThroughNamespace(c.surface, b.local);
      if (opaque.length) {
        opaqueReaches.push(`${c.where}:${opaque.join(', ')} reaches web/${c.target} through ${b.local} without naming an export`);
        consumeEverything(c.target, c.where);
        continue;
      }
      for (const name of names) consumeName(c.target, name, c.where);
      continue;
    }
    consumeName(c.target, b.imported, c.where);
  }
  if (any) asked[c.kind]++;
}
ok('no module imports a name it does not use',
  unusedImports.length === 0 && unsweptEdges.length === 0 && sweptImportNames > 0,
  unusedImports.length || unsweptEdges.length
    ? [...unusedImports, ...unsweptEdges.map((e) => `${e} was asked of a body this run does not hold`)].join('; ')
    : `${sweptImportNames} names across ${asked['in-tree']} in-tree, ${asked.bare} bare and ${asked.outside} outside-web declarations, each counted where it was asked`);

ok('and every namespace import reaches its target by name, so no module\'s exports go unasked behind one',
  opaqueReaches.length === 0,
  opaqueReaches.length
    ? opaqueReaches.join('; ')
    : `${namespaceBindings} namespace binding${namespaceBindings === 1 ? '' : 's'} into web/, and every reach through one of them names an export`);

const unconsumed = [];
const outsideOnly = [];
let consideredExports = 0;
for (const [rel, list] of exportsByModule) {
  for (const e of list) {
    if (e.form === 're-export') continue;
    consideredExports++;
    const by = consumers.get(`${rel}::${e.name}`);
    if (!by) { unconsumed.push(`web/${rel}:${e.line} exports ${e.name}, and nothing in this checkout imports it and reads it`); continue; }
    if (![...by].some((w) => w.startsWith('web/'))) outsideOnly.push(`web/${rel}::${e.name} from ${[...by].join(', ')}`);
  }
}
ok('no module exports a name nothing imports',
  unconsumed.length === 0 && consideredExports > 0,
  unconsumed.length
    ? unconsumed.join('; ')
    : `${consideredExports} exports, every one of them asked for by one of ${liveBindings} bindings that read what they bring across`
      + `, with ${deadBindings} dead one${deadBindings === 1 ? '' : 's'} counting for nothing`);

ok('and the consumers counted include the ones outside web/, which is where the only reader of some of these exports lives',
  outsideImports > 0 && outsideOnly.length > 0,
  outsideOnly.length
    ? `${outsideFiles.length} files outside web/ walked, ${outsideImports} of their declarations import out of web/,`
      + ` and ${outsideOnly.length} exports have no reader inside it: ${outsideOnly.join('; ')}`
    : `${outsideImports} imports out of web/ from ${outsideFiles.length} files outside it, and no export depends on them -`
      + ' so a scan that stopped at web/ would pass this run and the widening is untested');

console.log(`\n[module] ${checked} assertions, ${failed} failed`);
if (MUTATE && mutationApplied === 0) {
  console.log(`[module] DID NOT RUN - ${MUTATE} names ${MUTATIONS[MUTATE].file}, which nothing in this run read, so nothing was mutated`);
  process.exit(2);
}
if (MUTATE) {
if (MUTATIONS[MUTATE]?.fails) console.log(`[module] it should redden: ${MUTATIONS[MUTATE].fails}`);
  // Exit code alone cannot tell a caught mutation from a tool that fell over before asserting.
  if (failed === 0) { console.log('[module] NOT CAUGHT - the check passed a tree it should have refused'); process.exit(1); }
  console.log(`[module] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
if (failed) { console.log('[module] FAIL'); process.exit(1); }
console.log('[module] PASS');
process.exit(0);
