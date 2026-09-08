// The door an effect package has to get through before a byte of it lands on disk. A package is
// GLSL spliced into two programs plus a table of parameters spliced into the registry, both
// assembled while `web/main.js` is still evaluating - so a package that does not assemble fails
// the next page load rather than the install. The door does not reimplement assembly: it runs
// `assembleShaders` against the set that would exist after the install, and writes out only what
// assembly cannot see. Pure and synchronous, so the store can call it before it has a directory.

import {
  MANIFEST_FORMAT, EFFECT_PARAM_KINDS, EFFECT_BIND_TABLES, EFFECT_BIND_TRANSFORMS,
  EFFECT_GATED_TABLES, EFFECT_BOUNDED_TABLES,
  CORE_PANEL_GROUP_KEYS, HOST_DRIVEN_UNIFORMS, effectBindUniformType,
} from '../web/effect-manifests.js';
import { assembleShaders } from '../web/shader-assembly.js';
import { decimalsOf, snapScalar } from '../web/format.js';

// How much of one package this build will take. Every other rule is about one entry, so nothing
// else refuses twenty thousand correct chunks. Both bounds are eight to fifteen times the widest
// package that ships.
const MAX_PACKAGE_FILES = 64;
const MAX_PACKAGE_BYTES = 256 * 1024;

// And how much of the *manifest*, which the two above leave free: they count chunk text, and a
// package can repeat a correct parameter instead. Serialised bytes rather than a cap per
// collection, so a field somebody adds next year is inside it by construction.
const MAX_MANIFEST_BYTES = 32 * 1024;

// Below this is a grid neither the rounding nor a 32-bit float can resolve. Refused rather than
// clamped, or the manifest is silently reinterpreted.
const MIN_PARAM_STEP = 1e-6;

// `decimalsOf` caps its count at the hundred `toFixed` takes, so a finer bound is not refused by
// the arithmetic, it is quietly rewritten. Derived from the step floor rather than written again.
const MIN_PARAM_PLACES = decimalsOf(MIN_PARAM_STEP);

// Restated rather than imported: the door runs before the store has anything to read, and the
// store runs on what is already on disk.
const VALID_EFFECT_ID = /^[a-z][a-z0-9]*$/;
const VALID_FILE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

// A fact about the filesystem, exported because the store builds a longer name out of it: every
// aside is the id plus about thirty characters against a 255-byte `NAME_MAX`, so a long id
// installs cleanly and can never be moved out of the way. 64 rather than the 225 the arithmetic
// allows, because an id is the namespace every parameter carries.
export const MAX_EFFECT_ID = 64;

// The ids no package may have, because the HTTP surface has already claimed them: a literal
// segment under `/effects/` outranks the `:id` pattern beside it, so a package at that name is
// listed by `GET /effects` and then answered 405. Empty and kept armed - the block below `ROUTES`
// in `server/index.js` refuses to boot if the two lists disagree.
export const RESERVED_EFFECT_IDS = Object.freeze([]);

// Written as a function taking the list, so `test/effect-door.test.mjs` can prove the rule on a
// reserved id while the live list is empty.
export const reservedIdRefusal = (id, reserved = RESERVED_EFFECT_IDS) => {
  if (!reserved.includes(id)) return null;
  return `effect ${id} takes an id this build's HTTP surface has already claimed - `
    + `/effects/${id} is a route rather than a package, so a package under that name is listed by `
    + 'GET /effects and then refused when the page fetches it, and a page that cannot read a package '
    + 'the store just listed does not boot at all. '
    + `${reserved.length === 1 ? 'The reserved name is' : 'The reserved names are'} `
    + `${reserved.join(', ')}`;
};

// A GLSL name, which is what a uniform binding, a varying and an identifier all are.
const GLSL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

// No dot of its own, because `effectOf` in `web/main.js` splits on the first one and
// `rain.head.gap` would read as two different names to two halves of one program.
const VALID_PARAM_KEY = /^[a-z][A-Za-z0-9]*$/;

// Vocabulary rather than grammar - this is not a parser. The lists are generous: a missing name
// is a false refusal an author can report, where a name GLSL has not got costs nothing.
const GLSL_TYPES = [
  'void', 'bool', 'int', 'uint', 'float', 'double',
  'vec2', 'vec3', 'vec4', 'bvec2', 'bvec3', 'bvec4', 'ivec2', 'ivec3', 'ivec4',
  'uvec2', 'uvec3', 'uvec4', 'dvec2', 'dvec3', 'dvec4',
  'mat2', 'mat3', 'mat4', 'mat2x2', 'mat2x3', 'mat2x4',
  'mat3x2', 'mat3x3', 'mat3x4', 'mat4x2', 'mat4x3', 'mat4x4',
  'sampler2D', 'isampler2D', 'usampler2D', 'sampler3D', 'samplerCube',
  'sampler2DArray', 'sampler2DShadow', 'samplerCubeShadow',
];

const GLSL_KEYWORDS = [
  'if', 'else', 'for', 'while', 'do', 'return', 'break', 'continue', 'discard',
  'const', 'uniform', 'in', 'out', 'inout', 'attribute', 'varying',
  'flat', 'smooth', 'noperspective', 'centroid', 'layout', 'location', 'precision',
  'highp', 'mediump', 'lowp', 'struct', 'switch', 'case', 'default', 'true', 'false',
  'define', 'ifdef', 'ifndef', 'endif', 'version', 'else', 'elif', 'undef', 'error',
];

const GLSL_BUILTINS = [
  'radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan',
  'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt',
  'abs', 'sign', 'floor', 'trunc', 'round', 'roundEven', 'ceil', 'fract', 'mod', 'modf',
  'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'isnan', 'isinf',
  'floatBitsToInt', 'floatBitsToUint', 'intBitsToFloat', 'uintBitsToFloat', 'fma',
  'length', 'distance', 'dot', 'cross', 'normalize', 'faceforward', 'reflect', 'refract',
  'matrixCompMult', 'outerProduct', 'transpose', 'determinant', 'inverse',
  'lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual', 'equal', 'notEqual',
  'any', 'all', 'not',
  'texture', 'textureProj', 'textureLod', 'textureOffset', 'texelFetch', 'texelFetchOffset',
  'textureGrad', 'textureSize', 'textureGather', 'textureQueryLod',
  // The ES 1.00 spellings: the cloud's pair is GLSL3 and the grade pass is what three.js compiles
  // a `ShaderPass` as, so shipped chunks call both `texture` and `texture2D`.
  'texture2D', 'texture2DProj', 'texture2DLod', 'textureCube', 'textureCubeLod',
  'dFdx', 'dFdy', 'fwidth',
  'packSnorm2x16', 'unpackSnorm2x16', 'packUnorm2x16', 'unpackUnorm2x16',
  'bitfieldExtract', 'bitfieldInsert', 'bitCount', 'findLSB', 'findMSB', 'uaddCarry', 'usubBorrow',
  'gl_Position', 'gl_PointSize', 'gl_VertexID', 'gl_InstanceID',
  'gl_FragCoord', 'gl_FrontFacing', 'gl_PointCoord', 'gl_FragDepth',
];

const LANGUAGE = new Set([...GLSL_TYPES, ...GLSL_KEYWORDS, ...GLSL_BUILTINS]);
const TYPE_SET = new Set(GLSL_TYPES);

// GLSL with its comments taken out, so a name mentioned in prose is not a name used in code.
const withoutComments = (text) => text
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/\/\/[^\n]*/g, ' ');

// A match after a dot is a swizzle and a match after a digit is the tail of a literal, and
// counting either refuses the shipped set.
const identifiersIn = (text) => {
  const src = withoutComments(text);
  const found = new Set();
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const before = m.index === 0 ? '' : src[m.index - 1];
    if (before === '.' || /[0-9]/.test(before)) continue;
    found.add(m[0]);
  }
  return found;
};

// Vocabulary and not scope: a name declared inside `main` counts as declared, so a chunk reaching
// an invisible local passes here and fails in the driver. What this closes is a name that exists
// nowhere in the build at all.
const declaredIn = (text) => {
  const src = withoutComments(text);
  const names = new Set();
  for (const m of src.matchAll(/#\s*define\s+([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
  const qualified = /\b(?:uniform|in|out|attribute|varying)\b(?:\s+(?:flat|smooth|noperspective|centroid|highp|mediump|lowp))*\s+[A-Za-z_][A-Za-z0-9_]*\s+([^;]*);/g;
  for (const m of src.matchAll(qualified)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
      if (name) names.add(name[1]);
    }
  }
  // A type followed by a name is a declaration or a function head, written against the type list
  // rather than against a grammar.
  const typed = new RegExp(`\\b(?:${GLSL_TYPES.join('|')})\\s+([A-Za-z_][A-Za-z0-9_]*)`, 'g');
  for (const m of src.matchAll(typed)) names.add(m[1]);
  return names;
};

// With the type it was declared as, because a binding promises a place to put the value *and*
// that the place is the shape of it. The array dimension is part of the type: three.js picks its
// uploader off the declared uniform, so `float weights[4]` read as plain `float` gets the array
// setter handed one number. Both spellings carry it, since ES 3.00 takes either side of the name.
const uniformTypesIn = (text) => {
  const src = withoutComments(text);
  const types = new Map();
  const decl = /\buniform\s+(?:(?:highp|mediump|lowp)\s+)?([A-Za-z_][A-Za-z0-9_]*)((?:\s*\[[^\]]*\])*)\s+([^;]*);/g;
  for (const m of src.matchAll(decl)) {
    for (const part of m[3].split(',')) {
      const declared = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)((?:\s*\[[^\]]*\])*)/);
      if (!declared) continue;
      // Whitespace out, so `float [4]` and `float[4]` are one string.
      const type = `${m[1]}${m[2]}${declared[2]}`.replace(/\s+/g, '');
      if (!types.has(declared[1])) types.set(declared[1], new Set());
      types.get(declared[1]).add(type);
    }
  }
  return types;
};

const uniformsIn = (text) => new Set(uniformTypesIn(text).keys());

// GLSL refuses two declarations of one name in one scope, and a chunk spliced into a function
// body shares that scope with the spine's own locals. Scope-aware, because a nested block may
// shadow an outer name and the shipped ripple does. Returns the first name declared twice.
const GLSL_QUALIFIER = /^(?:const|highp|mediump|lowp|precise|invariant|flat|smooth|centroid|in|out|inout|uniform)\s+/;
const GLSL_NOT_A_TYPE = new Set(['return', 'precision', 'else', 'discard', 'break', 'continue', 'struct', 'layout', 'if', 'for', 'while', 'do', 'switch', 'case']);
const declaredNamesIn = (statement) => {
  let src = statement.trim();
  while (GLSL_QUALIFIER.test(src)) src = src.replace(GLSL_QUALIFIER, '');
  const head = src.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s*\[[^\]]*\])*\s+([A-Za-z_][A-Za-z0-9_]*)/);
  if (!head || GLSL_NOT_A_TYPE.has(head[1])) return [];
  const names = [];
  let depth = 0;
  let part = '';
  const parts = [];
  for (const ch of src.slice(head[0].length - head[2].length)) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { parts.push(part); part = ''; } else part += ch;
  }
  parts.push(part);
  for (const p of parts) {
    const m = p.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*([\[=]|$)/);
    // A name followed by a parenthesis is a function, and a prototype may be repeated.
    if (m) names.push(m[1]);
  }
  return names;
};
const redeclaredIn = (text) => {
  const src = withoutComments(text).replace(/^\s*#[^\n]*/gm, ' ');
  const scopes = [new Set()];
  const declare = (name) => {
    const scope = scopes[scopes.length - 1];
    if (scope.has(name)) return name;
    scope.add(name);
    return null;
  };
  let buffer = '';
  let parens = 0;
  for (const ch of src) {
    if (ch === '(') parens++;
    else if (ch === ')') parens--;
    if (ch === ';' && parens === 0) {
      for (const name of declaredNamesIn(buffer)) if (declare(name)) return name;
      buffer = '';
    } else if (ch === '{') {
      const head = buffer.trim();
      scopes.push(new Set());
      const loop = head.match(/^for\s*\(([^;]*);/);
      const fn = head.match(/^(?:[A-Za-z_][A-Za-z0-9_]*\s+)+[A-Za-z_][A-Za-z0-9_]*\s*\(([^)]*)\)$/);
      const inner = loop ? [loop[1]] : fn ? fn[1].split(',') : [];
      for (const stmt of inner) for (const name of declaredNamesIn(stmt)) if (declare(name)) return name;
      buffer = '';
    } else if (ch === '}') {
      scopes.pop();
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return null;
};

// Whether a chunk declares the name anywhere, so the refusal can point at the file.
const declaresName = (text, name) => {
  const src = withoutComments(text).replace(/^\s*#[^\n]*/gm, ' ');
  return src.split(/[;{}]/).some((statement) => declaredNamesIn(statement).includes(name));
};

const spineTextByProgram = (spines) => Object.fromEntries(
  Object.entries(spines).map(([name, spine]) => [
    name,
    [...spine.vertex, ...spine.fragment]
      .map((entry) => [entry.text, entry.fallback, entry.open, entry.body, entry.close].filter((t) => typeof t === 'string').join('\n'))
      .join('\n'),
  ]),
);

// Which assembled program a binding's table writes into - the one place the two vocabularies meet.
const PROGRAM_OF_TABLE = { points: 'cloud', grade: 'grade', mosh: 'mosh' };

// Read off the spines rather than decided here: a chunk names a joint and never a program, so the
// spine holding the joint is what says where it lands.
const programByJoint = (spines) => {
  const where = {};
  for (const [program, spine] of Object.entries(spines)) {
    for (const stage of [spine.vertex, spine.fragment]) {
      for (const entry of stage) {
        const joint = entry.stage ?? entry.service ?? entry.slot;
        if (joint !== undefined) where[joint] = program;
      }
    }
  }
  return where;
};

const isInert = (value) => value === 0 || value === false;

// The init sits above the early returns, so it is what a shed point carries - one reading a
// uniform would make that depend on a slider.
const isConstantExpression = (init) => {
  if (typeof init !== 'string' || init.trim().length === 0) return false;
  const src = init.trim();
  if (/^[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?[uf]?$/.test(src)) return true;
  const call = src.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(([^()]*)\)$/);
  if (!call || !TYPE_SET.has(call[1])) return false;
  return call[2].split(',').every((arg) => /^\s*[-+]?[0-9]*\.?[0-9]+([eE][-+]?[0-9]+)?[uf]?\s*$/.test(arg));
};

// The one entry point: a sentence saying why this package is refused, or null. The rules are in
// the order they can be asked in - shape before vocabulary, vocabulary before assembly - because
// each reads something the one before it established is there.
export function doorRefusal(candidate, { beside = [], spines }) {
  const { id, manifest, chunks } = candidate;

  // ---- the id and the envelope
  if (typeof id !== 'string' || !VALID_EFFECT_ID.test(id)) {
    return `${JSON.stringify(id)} is not an effect id - an id is the namespace its parameters carry, `
      + 'so it is lowercase letters and digits with nothing in it that could read as a path';
  }
  // An id with no room for a suffix installs and can never be set aside, which is `ENAMETOOLONG`
  // out of the boot gate written to survive a broken package.
  if (id.length > MAX_EFFECT_ID) {
    return `effect ${id.slice(0, 24)}… declares an id of ${id.length} characters and this build takes `
      + `${MAX_EFFECT_ID} - an id is a directory name, and every copy this program renames out of the way `
      + 'is that name with a suffix on it, so an id with no room for one is a package nothing could set '
      + 'aside once it was in place';
  }
  // Asked with the shape rules, because it is a fact about the id and the boot gate reaches it on
  // a package whose manifest may be anything at all.
  const claimed = reservedIdRefusal(id);
  if (claimed) return claimed;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return `effect ${id} arrives with no manifest object - a package is a manifest and its chunks, and half of that is not a package`;
  }
  if (!chunks || typeof chunks !== 'object' || Array.isArray(chunks)) {
    return `effect ${id} arrives with no chunks map - a package with no chunks section still sends an empty one, because "no chunks" and "the chunks did not arrive" are different packages`;
  }
  if (manifest.id !== id) {
    return `effect ${id} carries a manifest declaring id ${JSON.stringify(manifest.id)} - the id is the namespace `
      + 'its parameters carry, so the two disagreeing means one of them is wrong and this door cannot know which';
  }

  // ---- the format, refused rather than adapted
  //
  // A field this build reads as a number that a later build reads as a range is a look rendering
  // as something nobody authored, and there is no reader to write for a format that does not exist.
  if (!Number.isInteger(manifest.format) || manifest.format < 1) {
    return `effect ${id} declares no package format - this build reads generation ${MANIFEST_FORMAT}, `
      + 'and a package that does not say which generation it is written in is one this door cannot place';
  }
  if (manifest.format > MANIFEST_FORMAT) {
    return `effect ${id} is package format ${manifest.format} and this build reads ${MANIFEST_FORMAT} - `
      + 'a package from a later build is refused rather than adapted, because a field this build '
      + 'thinks it understands may mean something else there';
  }
  if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
    return `effect ${id} declares no version - a document's \`requires\` quotes it and the badge on a `
      + 'machine without this package prints it, so a package with no version is one nobody can be told to install';
  }
  if (typeof manifest.title !== 'string' || manifest.title.length === 0) {
    return `effect ${id} declares no title - the package list is what a person picks from, and an entry with no name is a row nobody can read`;
  }

  // ---- the fields that are lists, asked before anything walks one
  //
  // Every reader below reaches these as `?? []` or a `for ... of`, so a non-list threw a TypeError
  // out of a function whose whole contract is to answer a sentence - and out of the boot gate,
  // which is a server that will not start. An explicit `null` is refused too, or `?? []` reads it
  // as "none at all".
  for (const field of ['chunks', 'varyings', 'panelGroups', 'hostDriven']) {
    if (manifest[field] === undefined || Array.isArray(manifest[field])) continue;
    return `effect ${id} declares ${field} as ${JSON.stringify(manifest[field])} - a manifest's ${field} is a `
      + 'list, and a package that has none of them leaves the key out rather than putting something else '
      + 'there. Every reader of this field walks it, so a value that is not a list is a crash inside this '
      + 'door instead of a refusal by it';
  }

  // ---- the file names, held before any path is built out of them
  //
  // The store validates what it reads and this validates what it is about to write, which decides
  // whether a name with a separator in it ever reaches `join`.
  const declaredFiles = new Set((manifest.chunks ?? []).map((c) => c?.file));
  for (const file of [...declaredFiles, ...Object.keys(chunks)]) {
    if (typeof file !== 'string' || !VALID_FILE_NAME.test(file) || file.includes('..')) {
      return `effect ${id} names the chunk file ${JSON.stringify(file)} - a package file is a bare name `
        + 'in the package\'s own directory, and anything carrying a separator or a parent step is a write outside it';
    }
  }
  if (Object.hasOwn(chunks, 'manifest.json')) {
    return `effect ${id} sends a chunk called manifest.json - the manifest travels in its own field, and a second one `
      + 'in the chunk map would be the file the store reads back disagreeing with the one this door checked';
  }
  for (const file of declaredFiles) {
    if (typeof chunks[file] !== 'string') {
      return `effect ${id} declares the chunk ${JSON.stringify(file)} and its text did not arrive - `
        + 'a package assembled without one of its chunks is a program with a block missing';
    }
    // A macro can expand to a declaration the scope walk below never sees, and a conditional can
    // hide one from it, so the compiler would be the first thing to read what the door accepted.
    if (/^\s*#/m.test(withoutComments(chunks[file]))) {
      return `effect ${id}'s ${file} carries a preprocessor directive - a chunk is spliced into a program the spine `
        + 'writes, and a directive can produce or hide a declaration this door cannot see, so none is accepted';
    }
  }
  for (const file of Object.keys(chunks)) {
    if (!declaredFiles.has(file)) {
      return `effect ${id} sends the file ${JSON.stringify(file)} and its manifest names no chunk for it - `
        + 'a file nothing splices is text this build would store, serve and never compile, which is the shape a stale copy has';
    }
  }

  // ---- how much of it there is, which no rule above asks
  //
  // The manifest first, because the bounds under it all count chunk text and a package can repeat
  // a correct parameter instead. Asked before the parameter walk, or the bound is one the walk has
  // already paid for.
  const manifestBytes = Buffer.byteLength(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  if (manifestBytes > MAX_MANIFEST_BYTES) {
    return `effect ${id} carries a manifest of ${manifestBytes} bytes and this build takes ${MAX_MANIFEST_BYTES} - `
      + 'the widest manifest that ships is under three kilobytes, and this one is written to disk, hashed on '
      + 'every read of the store and turned into a control per parameter on every page that adopts it, so a '
      + 'manifest is bounded by what all of those cost rather than by what a request body can hold';
  }
  const fileCount = new Set([...declaredFiles, ...Object.keys(chunks)]).size;
  if (fileCount > MAX_PACKAGE_FILES) {
    return `effect ${id} carries ${fileCount} files and this build takes ${MAX_PACKAGE_FILES} - `
      + 'the widest package that ships holds eight, and every read of the store hashes every file of '
      + 'every package, so a package is bounded by what a reader can afford rather than by what a writer can send';
  }
  const totalBytes = Object.values(chunks)
    .reduce((sum, text) => sum + Buffer.byteLength(text, 'utf8'), 0);
  if (totalBytes > MAX_PACKAGE_BYTES) {
    return `effect ${id} carries ${totalBytes} bytes of chunk text and this build takes ${MAX_PACKAGE_BYTES} - `
      + 'the largest package that ships is under 17 kilobytes, and this text is spliced into two programs '
      + 'a driver has to compile on every page that adopts the install';
  }
  // And how much there would be once *assembled*: the bounds above count a file once, while the
  // assembler emits a chunk once per descriptor naming it, and what a driver compiles is the
  // expansion rather than the archive.
  const expandedBytes = (manifest.chunks ?? [])
    .reduce((sum, c) => sum + Buffer.byteLength(chunks[c?.file] ?? '', 'utf8'), 0);
  if (expandedBytes > MAX_PACKAGE_BYTES) {
    return `effect ${id} splices ${expandedBytes} bytes of chunk text into this build's shaders and this build `
      + `takes ${MAX_PACKAGE_BYTES} - a chunk is emitted once for every descriptor naming it, so a manifest can `
      + 'ask for far more assembled text than it carries, and the assembled text is what a driver compiles';
  }

  // ---- the parameters
  if (!manifest.params || typeof manifest.params !== 'object' || Array.isArray(manifest.params)
      || Object.keys(manifest.params).length === 0) {
    return `effect ${id} declares no parameters - an effect with nothing to move is a package the registry `
      + 'would assemble no control from, and the panel group it asks for would be a heading with nothing under it';
  }
  let masters = 0;
  let bounds = 0;
  let onBounded = 0;
  for (const [short, spec] of Object.entries(manifest.params)) {
    const name = `${id}.${short}`;
    if (!VALID_PARAM_KEY.test(short)) {
      return `effect ${id} declares the parameter key ${JSON.stringify(short)} - a key becomes the half of a `
        + 'dotted registry name after the dot, so a key carrying a dot of its own is a name that means two different things to two halves of this program';
    }
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      return `${name} is not a parameter declaration - the registry reads a bounds, a kind and a binding off it`;
    }
    if (!EFFECT_PARAM_KINDS.includes(spec.kind)) {
      return `${name} is kind ${JSON.stringify(spec.kind)} and this registry implements ${EFFECT_PARAM_KINDS.join(' and ')} - `
        + 'a kind nothing normalises would take the scalar branch and turn whatever arrived into a number nobody meant';
    }
    if (typeof spec.label !== 'string' || spec.label.length === 0) {
      return `${name} carries no label - the panel draws the row from it, and a row with no words on it is a slider nobody can name`;
    }
    if (!spec.panel || typeof spec.panel.group !== 'string' || spec.panel.group.length === 0) {
      return `${name} names no panel group - the generator builds a row for every parameter that names one, `
        + 'so a parameter naming none is a look term with no control anywhere';
    }
    if (spec.kind === 'step') {
      if (typeof spec.def !== 'boolean') {
        return `${name} is a step parameter and its default is ${JSON.stringify(spec.def)} - a step takes a boolean, `
          + 'and a number here would be stored as a boolean by one door and refused by another';
      }
    } else {
      for (const field of ['def', 'min', 'max', 'step']) {
        if (!Number.isFinite(spec[field])) {
          return `${name} declares ${field} as ${JSON.stringify(spec[field])} - a scalar's bounds are finite numbers, `
            + 'and a missing one makes every value the registry snaps NaN';
        }
      }
      if (!(spec.min < spec.max)) {
        return `${name} declares min ${spec.min} and max ${spec.max} - a range that does not open is a slider that cannot move`;
      }
      if (!(spec.step > 0)) {
        return `${name} declares step ${spec.step} - the registry snaps every value onto this grid, and a step of zero divides by it`;
      }
      if (spec.step < MIN_PARAM_STEP) {
        return `${name} declares step ${spec.step} and the finest grid this build snaps to is ${MIN_PARAM_STEP} - `
          + 'the value is rounded to the decimals this step implies and then written into a 32-bit float, '
          + 'so a finer grid is one neither the arithmetic nor the uniform can tell the positions of apart';
      }
      // A bound the rounding cannot express, which the step floor cannot ask: the floor is about
      // the gap between positions, this is about the numbers naming them. Asked first, because it
      // names the cause where the grid rules below name a symptom.
      for (const field of ['min', 'max', 'def']) {
        const places = decimalsOf(spec[field]);
        if (places > MIN_PARAM_PLACES) {
          return `${name} declares ${field} as ${spec[field]}, which needs ${places} decimal places and this `
            + `build rounds a value to at most ${MIN_PARAM_PLACES} - every value of this parameter is rounded `
            + `to the places ${spec.min} and ${spec.step} imply, so a bound finer than that is not the grid it `
            + 'says it is: it is that grid rounded, and the number the manifest states is one the program never holds';
        }
      }
      if (spec.def < spec.min || spec.def > spec.max) {
        return `${name} defaults to ${spec.def}, outside its own ${spec.min}..${spec.max} - a default the bounds `
          + 'clamp is a parameter that never sits where its own manifest says it starts';
      }
      // The bounds asked whether this build would move them, by moving them: a default off its own
      // grid reads as modified from the first paint, so the save rule writes a `requires` entry
      // for an effect nobody raised into every document saved after the install.
      const landed = snapScalar(spec, spec.def);
      if (landed !== spec.def) {
        return `${name} declares def ${spec.def} and the registry would hold it at ${landed} - `
          + `every value is snapped onto the ${spec.step} grid ${spec.min} anchors and rounded to the `
          + 'decimals that implies, so a default off its own grid is a number the manifest states and '
          + 'the program never has: the parameter reads as modified from the first paint, and the '
          + 'save rule then writes an effect nobody touched into the document';
      }
      // `max` needs the ceiling lifted to be asked at all: `snapScalar` clamps back into bounds,
      // so a `max` the snap steps past is put onto itself and answers that it did not move.
      const toppedOut = snapScalar({ ...spec, max: spec.max + spec.step }, spec.max);
      if (toppedOut !== spec.max) {
        return `${name} runs to ${spec.max}, which is not on the ${spec.step} grid ${spec.min} anchors - `
          + `the nearest position is ${toppedOut}, so a range input stops short of the top of this `
          + 'parameter while a value set from a document clamps to it, and the same look renders '
          + 'two ways depending on which one wrote it';
      }
    }
    const bind = spec.bind;
    if (!bind || typeof bind !== 'object') {
      return `${name} carries no binding - a parameter that writes no uniform is a control that moves nothing`;
    }
    if (!EFFECT_BIND_TABLES.includes(bind.on)) {
      return `${name} binds on ${JSON.stringify(bind.on)} and this build holds ${EFFECT_BIND_TABLES.join(' and ')} - `
        + 'a table nothing resolves is a write into undefined on the first slider move';
    }
    if (typeof bind.uniform !== 'string' || !GLSL_NAME.test(bind.uniform)) {
      return `${name} binds the uniform ${JSON.stringify(bind.uniform)}, which is not a GLSL name`;
    }
    if (bind.transform !== undefined && !EFFECT_BIND_TRANSFORMS.includes(bind.transform)) {
      return `${name} names the transform ${JSON.stringify(bind.transform)} and the applier implements `
        + `${EFFECT_BIND_TRANSFORMS.join(' and ')} - an unknown transform throws on the first write rather than `
        + 'landing the value unconverted, so this is the same refusal one door earlier';
    }
    if (bind.gates !== undefined && typeof bind.gates !== 'boolean') {
      return `${name} declares gates as ${JSON.stringify(bind.gates)} - it says whether this term holds its pass open, which is a yes or a no`;
    }
    // `gates` is a promise about the *uniform*: `gradeNeeded` walks the gating bindings and reads
    // the cell each names, so one on another table is collected by nothing, and one beside a
    // vector transform asks whether a direction or pair of edges is zero.
    if (bind.gates) {
      if (!EFFECT_GATED_TABLES.includes(bind.on)) {
        return `${name} declares gates and binds on ${JSON.stringify(bind.on)} - gates says this term holds `
          + `its pass open, and the tables with a pass to hold are ${EFFECT_GATED_TABLES.join(' and ')}, so a `
          + 'gating binding anywhere else is a claim no pass ever sees: the control moves, the term is '
          + 'collected by nothing, and the passes open and shut on the parameters that did bind there';
      }
      if (effectBindUniformType(bind.transform) !== 'float') {
        return `${name} declares gates beside the ${bind.transform} transform - that transform writes a two-component value `
          + 'and the gate asks whether the term is zero, which a vector never is. That pair has no reading: '
          + 'it held the pass shut for the life of the page under the comparison this build used to make, and '
          + 'holds it open forever under the one it makes now, so it is refused rather than given a meaning '
          + 'that changes when the comparison does';
      }
    }
    if (bind.bounds !== undefined && typeof bind.bounds !== 'boolean') {
      return `${name} declares bounds as ${JSON.stringify(bind.bounds)} - it says whether this term is how `
        + 'long its pass remembers, which is a yes or a no';
    }
    if (EFFECT_BOUNDED_TABLES.includes(bind.on)) onBounded += 1;
    if (bind.bounds) {
      bounds += 1;
      if (!EFFECT_BOUNDED_TABLES.includes(bind.on)) {
        return `${name} declares bounds and binds on ${JSON.stringify(bind.on)} - bounds says this term is the `
          + `seconds its pass remembers for, and the passes with memory are ${EFFECT_BOUNDED_TABLES.join(' and ')}. `
          + 'On any other table it bounds nothing: the render loop would read it for a refresh that never has to '
          + 'happen, and the seek would compute a pre-roll for a pass that never needed one';
      }
      if (spec.kind !== 'scalar' || effectBindUniformType(bind.transform) !== 'float') {
        return `${name} declares bounds and is a ${spec.kind} binding writing `
          + `${effectBindUniformType(bind.transform)} - a memory is a length of time, which is one number of `
          + 'seconds. A step or a two-component value has no reading the pre-roll could divide by';
      }
    }
    if (spec.role !== undefined) {
      if (spec.role !== 'master') {
        return `${name} declares the role ${JSON.stringify(spec.role)} - the only role this build knows is master, `
          + 'which is the term an effect is absent at';
      }
      masters += 1;
      if (!isInert(spec.def)) {
        return `${name} is ${id}'s master and defaults to ${JSON.stringify(spec.def)} - a master is what the effect `
          + 'is absent at, so a build with the package installed and every value at default has to draw exactly what a build without it draws';
      }
    }
    if (spec.reading !== undefined && typeof spec.reading !== 'boolean') {
      return `${name} declares reading as ${JSON.stringify(spec.reading)} - reading membership is a yes or a no`;
    }
    if (spec.reading && (spec.kind !== 'scalar' || spec.role !== 'master' || bind.on !== 'points'
        || spec.def !== 0 || spec.min !== 0 || spec.max !== 1)) {
      return `${name} declares itself a reading, but a package reading is a scalar point-uniform master on the `
        + '0..1 weight range with an inert default of 0 - the five reading weights are summed as a ratio, so a '
        + 'different shape would not have the meaning the registry gives it';
    }
    if (spec.under !== undefined) {
      if (typeof spec.under !== 'string' || !VALID_PARAM_KEY.test(spec.under)) {
        return `${name} declares under as ${JSON.stringify(spec.under)} - it names another parameter key in the same package`;
      }
      const parent = manifest.params[spec.under];
      // A step defaulting to false is absent at false, so its children hide when it is unchecked.
      const validParent = parent && parent !== spec
        && (parent.role === 'master' || (parent.kind === 'step' && parent.def === false));
      if (!validParent) {
        return `${name} declares itself under ${JSON.stringify(spec.under)}, which is not a valid parent in ${id} - `
          + 'the parent is a master or a step defaulting to false, whose non-zero value reveals this row';
      }
    }
  }
  if (masters > 1) {
    return `effect ${id} declares ${masters} parameters with the role master - one package is absent at one term, `
      + 'and two of them is two answers to whether this effect is contributing';
  }
  // A pass with memory has to say how long it remembers, once. Nothing else in this program can
  // supply that number: a seek reproduces a feedback pass by decoding from the last frame that
  // refreshed it, so a package that binds there and names no period is a pass no seek can land
  // in, and two periods is two answers to where the last refresh was.
  if (onBounded > 0 && bounds !== 1) {
    return `effect ${id} binds ${onBounded} parameter${onBounded === 1 ? '' : 's'} on a pass that carries a `
      + `frame of memory and declares ${bounds} of them as its bounds - it declares exactly one, in seconds. `
      + `${bounds === 0
        ? 'With none, the memory has no ceiling and no length of pre-roll reproduces it, so every seek into '
        + 'this look lands somewhere playback never was'
        : 'With two, the refresh the pre-roll decodes from is whichever one the page happened to collect first'}`;
  }

  // ---- where the rows would land, which nothing before the swap asks
  //
  // Both blow up inside `buildPanel`, after the registry has already been replaced, so the page
  // reports it as a document it could not carry across. A group a parameter may name is a core one
  // or one this package declares - not another package's, which would break on its uninstall.
  const ownGroupKeys = new Set((manifest.panelGroups ?? []).map((g) => g?.key));
  const besideGroupKeys = new Set(
    beside.flatMap((p) => (p.manifest?.panelGroups ?? []).map((g) => g?.key)),
  );
  for (const [short, spec] of Object.entries(manifest.params)) {
    const group = spec.panel.group;
    if (CORE_PANEL_GROUP_KEYS.includes(group) || ownGroupKeys.has(group)) continue;
    return `${id}.${short} asks for the panel group ${JSON.stringify(group)}, which is neither one of this `
      + `build's own (${CORE_PANEL_GROUP_KEYS.join(', ')}) nor one ${id} declares - the generator builds a `
      + 'row for every parameter and then refuses a row whose group nothing holds, which it does after the '
      + 'registry has already swapped';
  }
  // A package colliding with *itself*, which the two collisions below cannot see: `ownGroupKeys`
  // is a set, so one key declared twice reads as one group here and splices as two.
  const declaredGroupKeys = new Set();
  for (const g of manifest.panelGroups ?? []) {
    if (!g || typeof g.key !== 'string') continue;
    if (declaredGroupKeys.has(g.key)) {
      return `effect ${id} declares the panel group ${JSON.stringify(g.key)} twice - a group key is how the `
        + 'panel finds its rows, so two entries under one key are spliced as two groups and every row of that '
        + 'group is emitted twice';
    }
    declaredGroupKeys.add(g.key);
    if (CORE_PANEL_GROUP_KEYS.includes(g.key)) {
      return `effect ${id} declares the panel group ${JSON.stringify(g.key)} and this build's own spine already `
        + 'holds one under that key - two groups under one key are spliced as two entries, so every row of that '
        + 'group would be emitted twice and the generator refuses the count';
    }
    if (besideGroupKeys.has(g.key)) {
      const owner = beside.find((p) => (p.manifest?.panelGroups ?? []).some((o) => o?.key === g.key))?.id;
      return `effect ${id} declares the panel group ${JSON.stringify(g.key)} and effect ${owner} already declares `
        + 'one under that key - a group key is how the panel finds its rows, so two packages claiming one is two '
        + 'headings the page cannot tell apart';
    }
  }

  // ---- the varyings and the panel groups, which the assembler does not read for shape
  for (const v of manifest.varyings ?? []) {
    if (!v || !GLSL_NAME.test(v.name ?? '')) {
      return `effect ${id} declares a varying named ${JSON.stringify(v?.name)}, which is not a GLSL name`;
    }
    if (!TYPE_SET.has(v.type)) {
      return `effect ${id}'s ${v.name} is declared ${JSON.stringify(v.type)}, which is not a GLSL type - `
        + 'the same word is written into the vertex `out` and the fragment `in`, so a type nothing knows is a link error at boot';
    }
    if (!isConstantExpression(v.init)) {
      return `effect ${id}'s ${v.name} initialises to ${JSON.stringify(v.init)} - the init is written above the `
        + 'early returns, so it is what a shed point carries, and anything but a constant makes that depend on state the prologue has not computed';
    }
    if (!Number.isFinite(v.order)) {
      return `effect ${id}'s ${v.name} carries no numeric order, and where a varying sits decides the register layout of both stages`;
    }
  }
  for (const g of manifest.panelGroups ?? []) {
    if (!g || typeof g.key !== 'string' || !g.key.length) {
      return `effect ${id} declares a panel group with no key - the group's rows are found by it`;
    }
    if (typeof g.after !== 'string' || !g.after.length) {
      return `effect ${id}'s ${g.key} group anchors after ${JSON.stringify(g.after)} - a group with no anchor `
        + 'would be appended wherever the splice happened to end, which is a package author\'s placement decision quietly overridden';
    }
    if (!Number.isFinite(g.order)) {
      return `effect ${id}'s ${g.key} group carries no numeric order - two packages anchored at one place `
        + 'would then be laid out by whichever was fetched first';
    }
  }

  // ---- assembly, asked of the assembler
  //
  // Every joint rule in one call, against the set that would exist *after* the install, because
  // half of them are collisions and a collision is a property of the set rather than the package.
  const packages = [...beside, candidate];
  let programs;
  try {
    programs = assembleShaders(spines, packages);
  } catch (err) {
    return `effect ${id} does not assemble into this build's shaders: ${err.message}`;
  }
  for (const [program, { vertexShader, fragmentShader }] of Object.entries(programs)) {
    for (const [half, text] of [['vertex', vertexShader], ['fragment', fragmentShader]]) {
      const twice = redeclaredIn(text);
      if (twice === null) continue;
      const own = Object.entries(chunks).filter(([, t]) => declaresName(t, twice)).map(([f]) => f);
      return `effect ${id} does not assemble into this build's shaders: ${JSON.stringify(twice)} is declared `
        + `twice in one scope of the ${program} ${half} program${own.length ? `, and ${own.join(', ')} of ${id} declares it` : ''} - `
        + 'a chunk is spliced into the spine\'s own function body, so a local the spine already holds is a link error at boot';
    }
  }

  // ---- the two ends of every uniform, per program
  //
  // A binding no program declares is a slider that moves nothing; a uniform nothing binds is a
  // shader reading zero forever. The first is asked against the assembled program rather than the
  // package's own chunks, because most shipped packages declare no GLSL at all.
  const declaredHere = new Set();
  for (const text of Object.values(chunks)) for (const u of uniformsIn(text)) declaredHere.add(u);
  const spineText = spineTextByProgram(spines);
  const programUniforms = {};
  const absorb = (program, text) => {
    for (const [name, types] of uniformTypesIn(text)) {
      if (!programUniforms[program].has(name)) programUniforms[program].set(name, new Set());
      for (const t of types) programUniforms[program].get(name).add(t);
    }
  };
  for (const [program, text] of Object.entries(spineText)) {
    programUniforms[program] = new Map();
    absorb(program, text);
  }
  // A chunk's uniforms are credited to the one program its joint belongs to. Crediting them to
  // every program let a binding pass both halves while the slider wrote into a table
  // no shader reads.
  const jointProgram = programByJoint(spines);
  for (const pkg of packages) {
    for (const c of pkg.manifest?.chunks ?? []) {
      const text = pkg.chunks?.[c?.file];
      const program = jointProgram[c?.slot ?? c?.stage];
      if (typeof text !== 'string' || program === undefined) continue;
      absorb(program, text);
    }
  }
  const boundHere = new Set();
  for (const [short, spec] of Object.entries(manifest.params)) {
    const program = PROGRAM_OF_TABLE[spec.bind.on];
    const declaredAs = programUniforms[program]?.get(spec.bind.uniform);
    if (!declaredAs) {
      return `${id}.${short} binds the uniform ${JSON.stringify(spec.bind.uniform)} and the assembled `
        + `${program} program declares no such uniform - the control would move, the value would be written, and nothing would read it`;
    }
    // An array is a place with room for the value and still not somewhere to put it: three.js
    // takes the array uploader off the declaration and hands it one cell. Asked before the shape
    // rule below, which would otherwise refuse this for needing a float.
    const arrayed = [...declaredAs].filter((t) => t.includes('['));
    if (arrayed.length) {
      return `${id}.${short} binds the uniform ${JSON.stringify(spec.bind.uniform)}, which the assembled `
        + `${program} program declares as ${arrayed.join(' and ')} - this build's binding vocabulary has no `
        + 'array kind in it, so every parameter writes a single cell and three.js would take the array '
        + 'uploader off that declaration and hand it one value. The control moves, the write succeeds and '
        + 'the shader goes on reading whatever the array was initialised with';
    }
    // Whether the place is the *shape* of the value, which nothing else here or downstream checks:
    // The transform vocabulary is also the one statement of the value shape each transform
    // writes. Keeping that answer beside the vocabulary prevents the door and applier drifting.
    const wants = effectBindUniformType(spec.bind.transform);
    if (!declaredAs.has(wants)) {
      const writes = wants === 'vec2'
        ? `the ${spec.bind.transform} transform writes a two-component value`
        : 'a plain binding writes one number';
      return `${id}.${short} binds the uniform ${JSON.stringify(spec.bind.uniform)}, which the assembled `
        + `${program} program declares as ${[...declaredAs].join(' and ')}, and `
        + `${writes} - `
        + `so this binding needs a ${wants}. The mismatch is not caught anywhere downstream: it is a value `
        + 'uploaded through the wrong setter, on a control that moves and a picture that does not';
    }
    boundHere.add(spec.bind.uniform);
  }
  for (const u of declaredHere) {
    if (boundHere.has(u)) continue;
    // The one legitimate shape of the other end: a uniform this package reads and the host writes,
    // like the rain's phase, which the render loop advances once a frame.
    if ((manifest.hostDriven ?? []).includes(u)) continue;
    return `effect ${id} declares the uniform ${JSON.stringify(u)} and binds no parameter to it - `
      + 'nothing on this side would ever write it, so the shader reads zero for the life of the page. '
      + 'A uniform this build\'s own render loop drives goes in `hostDriven`';
  }
  // The exemption held to what the host actually implements, or it is self-issued: a package could
  // list a clock this build has not got and read zero for the life of the page.
  for (const u of manifest.hostDriven ?? []) {
    if (!HOST_DRIVEN_UNIFORMS.includes(u)) {
      return `effect ${id} lists ${JSON.stringify(u)} as host-driven and this build's render loop writes `
        + `${HOST_DRIVEN_UNIFORMS.map((n) => JSON.stringify(n)).join(' and ')} - the list is an exemption from `
        + 'the rule that something has to write every uniform a package declares, so a name the host does not '
        + 'actually drive is that rule excused by a claim nobody checked: the shader reads zero for the life '
        + 'of the page, and there is no control anywhere that could have moved it';
    }
    if (!declaredHere.has(u)) {
      return `effect ${id} lists ${JSON.stringify(u)} as host-driven and declares no such uniform - `
        + 'the list says which of this package\'s own declarations the host writes, so a name not among them is a claim about nothing';
    }
  }

  // ---- every identifier a chunk reaches for
  //
  // The last thing between a package and a page that will not boot. The core vocabulary is read
  // out of the spine text rather than listed, and from *usage*, because three.js injects
  // `position` and `modelMatrix` into a `ShaderMaterial` at compile time and they are declared
  // nowhere in this repo. Usage for the spine and declarations for the candidate, or a package
  // would authorise every name it misspells.
  const spineNames = new Set();
  for (const text of Object.values(spineText)) for (const n of identifiersIn(text)) spineNames.add(n);
  const ownNames = new Set([
    ...(manifest.varyings ?? []).map((v) => v.name),
    ...Object.keys(manifest.params).map((short) => manifest.params[short].bind.uniform),
    ...(manifest.hostDriven ?? []),
  ]);
  // A package's chunks see each other, so its vocabulary is not split per file.
  for (const text of Object.values(chunks)) for (const n of declaredIn(text)) ownNames.add(n);
  // And every *other* package's varyings, because a chunk may read one - a varying is a declared
  // channel with a name the manifest states, where another package's locals are an accident.
  for (const pkg of beside) {
    for (const v of pkg.manifest?.varyings ?? []) ownNames.add(v.name);
  }
  for (const [file, text] of Object.entries(chunks)) {
    for (const name of identifiersIn(text)) {
      if (LANGUAGE.has(name) || spineNames.has(name) || ownNames.has(name)) continue;
      return `effect ${id}'s ${file} uses ${JSON.stringify(name)}, which is not one of its own declarations, `
        + 'not a name this build\'s shaders declare and not part of GLSL - a chunk naming something that is not '
        + 'there does not fail this install, it fails the next page load with nothing on screen to say why';
    }
  }

  return null;
}

/**
 * What a package would have to keep to be a fork of another. A fork must not drop a parameter:
 * the registry's declaration order places every shipped name by hand, and a name it places that no
 * installed package declares is a registry that cannot assemble at all.
 */
export function forkRefusal(candidate, shadowed) {
  const dropped = Object.keys(shadowed.manifest.params)
    .filter((short) => !Object.hasOwn(candidate.manifest.params, short));
  if (dropped.length === 0) return null;
  return `effect ${candidate.id} forks the shipped package and drops `
    + `${dropped.map((s) => `${candidate.id}.${s}`).join(', ')} - the registry's declaration order places `
    + `${dropped.length === 1 ? 'that name' : 'those names'} by hand, so a fork short of `
    + `${dropped.length === 1 ? 'it' : 'them'} is a build whose registry cannot assemble at all. A fork adds and retunes; it does not remove`;
}
