// Every uniform each assembled program declares, against the object that feeds it. Both
// halves of a mismatch are silent: a declaration with no key reads zero, and a key with no
// declaration is a write per frame that reaches no pixel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { cloudSpine } from '../web/cloud-shader.js';
import { gradeSpine } from '../web/grade-shader.js';
import { moshSpine } from '../web/mosh-shader.js';
import { assembleShaders } from '../web/shader-assembly.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WEB = join(ROOT, 'web');
const BUILTIN = join(ROOT, 'effects-builtin');

// The indents in `key` are the tables' positions in their own files, not a formatting
// preference: the cloud's literal sits one scope in and the grade's at the top level.
const TABLES = {
  cloud: { file: 'point-cloud.js', open: '\n  const uniforms = {\n', close: '\n  };\n', key: /^ {4}([A-Za-z_]\w*):/gm, floor: 60 },
  grade: { file: 'post-chain.js', open: '\nconst GRADE_UNIFORMS = {\n', close: '\n};\n', key: /^ {2}([A-Za-z_]\w*):/gm, floor: 8 },
  mosh: { file: 'post-chain.js', open: '\nconst MOSH_UNIFORMS = {\n', close: '\n};\n', key: /^ {2}([A-Za-z_]\w*):/gm, floor: 4 },
};

const shippedPackages = () => readdirSync(BUILTIN, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort()
  .map((id) => {
    const manifest = JSON.parse(readFileSync(join(BUILTIN, id, 'manifest.json'), 'utf8'));
    const chunks = {};
    for (const c of manifest.chunks ?? []) chunks[c.file] = readFileSync(join(BUILTIN, id, c.file), 'utf8');
    return { id, manifest, chunks };
  });

const PROGRAMS = assembleShaders(
  { cloud: cloudSpine, grade: gradeSpine, mosh: moshSpine }, shippedPackages(),
);

/** Every name a `uniform` line declares, split on commas because one line carries several. */
const declaredInGlsl = (program) => {
  const names = new Set();
  for (const source of [PROGRAMS[program].vertexShader, PROGRAMS[program].fragmentShader]) {
    for (const line of source.matchAll(/^\s*uniform\s+\w+\s+([^;]+);/gm)) {
      for (const name of line[1].split(',')) names.add(name.trim());
    }
  }
  return names;
};

/** Every key of one program's table, taken at exactly one level in from the literal. */
const keysInTable = (program) => {
  const { file, open, close, key } = TABLES[program];
  const source = readFileSync(join(WEB, file), 'utf8');
  const start = source.indexOf(open);
  assert.notEqual(start, -1, `web/${file} no longer declares ${JSON.stringify(open.trim())}, so this scan reads nothing`);
  const end = source.indexOf(close, start);
  assert.notEqual(end, -1, `web/${file}'s ${program} uniform literal has no terminator at its own indent`);
  const names = new Set();
  for (const line of source.slice(start, end).matchAll(key)) names.add(line[1]);
  return names;
};

for (const program of Object.keys(TABLES)) {
  test(`the ${program} scan finds both lists, so an equality below cannot pass on two empty sets`, () => {
    const { floor } = TABLES[program];
    assert.ok(declaredInGlsl(program).size > floor, `only ${declaredInGlsl(program).size} uniforms found in the ${program} GLSL`);
    assert.ok(keysInTable(program).size > floor, `only ${keysInTable(program).size} keys found in the ${program} uniforms literal`);
  });

  test(`every uniform the ${program} program declares has a key, so none of them reads a silent zero`, () => {
    const keys = keysInTable(program);
    const missing = [...declaredInGlsl(program)].filter((name) => !keys.has(name));
    assert.deepEqual(missing, [], `declared in the ${program} GLSL with no key in web/${TABLES[program].file}: ${missing.join(', ')}`);
  });

  test(`and every ${program} key is declared, so none of them is written to nothing`, () => {
    const declared = declaredInGlsl(program);
    const orphan = [...keysInTable(program)].filter((name) => !declared.has(name));
    assert.deepEqual(orphan, [], `keys in web/${TABLES[program].file} the ${program} GLSL never declares: ${orphan.join(', ')}`);
  });
}

// The crop box's two functions are spliced into the vertex spine out of `web/crop-box.js`. GLSL
// wants a function defined above the call, and a segment moved below `main` would still assemble
// here - it would fail on the driver, as a viewport drawing nothing and a log nobody reads.
test('the crop box is defined above main and called from inside it', () => {
  const vert = PROGRAMS.cloud.vertexShader;
  for (const [signature, call] of [
    ['bool outsideDepthPair(float z) {', 'outsideDepthPair(z)'],
    ['bool outsideLateral(vec2 xy) {', 'outsideLateral(pos.xy)'],
  ]) {
    const defined = vert.indexOf(signature);
    const called = vert.indexOf(call);
    assert.notEqual(defined, -1, `the assembled vertex program does not define ${signature}`);
    assert.notEqual(called, -1, `the assembled vertex program never calls ${call}`);
    assert.ok(defined < called, `${signature} is assembled below the call that needs it`);
    assert.ok(called > vert.indexOf('void main() {'), `${call} is called above main rather than in it`);
  }
});
