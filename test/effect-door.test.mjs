// The install door against the packages this build ships, under bare node. This is the
// must-accept control: a door that refused everything would satisfy every hostile-package row
// `effect-check` drives, and the shipped set is the one population that must get through.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_EFFECT_ID, RESERVED_EFFECT_IDS, doorRefusal, forkRefusal, reservedIdRefusal,
} from '../server/effect-door.js';
import {
  HOST_DRIVEN_UNIFORMS, EFFECT_GATED_TABLES, EFFECT_BOUNDED_TABLES,
} from '../web/effect-manifests.js';
import { snapScalar } from '../web/format.js';
import { cloudSpine } from '../web/cloud-shader.js';
import { gradeSpine } from '../web/grade-shader.js';
import { moshSpine } from '../web/mosh-shader.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILTIN = join(ROOT, 'effects-builtin');
const SPINES = { cloud: cloudSpine, grade: gradeSpine, mosh: moshSpine };

const load = (id) => {
  const dir = join(BUILTIN, id);
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const chunks = {};
  for (const c of manifest.chunks ?? []) chunks[c.file] = readFileSync(join(dir, c.file), 'utf8');
  return { id, manifest, chunks };
};

const shipped = () => readdirSync(BUILTIN, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => load(e.name));

/** The set as the store hands it over on an install. The candidate is excluded because a
 *  package replacing itself collides with itself on every slot and varying it declares. */
const beside = (all, id) => all.filter((p) => p.id !== id);

test('every shipped package gets through the door it is held to', () => {
  const all = shipped();
  assert.ok(all.length >= 16, `only ${all.length} packages on disk - this control would pass on almost nothing`);
  for (const pkg of all) {
    assert.equal(doorRefusal(pkg, { beside: beside(all, pkg.id), spines: SPINES }), null,
      `the shipped ${pkg.id} is refused by this build's own install door`);
  }
});

/** One shipped package with one field wrong, which is the shape a real broken package has and
 *  the shape a fixture built to fail never quite is. */
const brokenBy = (id, edit) => {
  const all = shipped();
  const pkg = all.find((p) => p.id === id);
  const candidate = { id, manifest: JSON.parse(JSON.stringify(pkg.manifest)), chunks: { ...pkg.chunks } };
  edit(candidate);
  return doorRefusal(candidate, { beside: beside(all, id), spines: SPINES });
};

test('the door names what it refuses, one rule at a time', () => {
  const cases = [
    ['a manifest declaring another id', 'thermal', (c) => { c.manifest.id = 'edges'; }, /declaring id "edges"/],
    ['a format from a later build', 'thermal', (c) => { c.manifest.format = 99; }, /package format 99/],
    ['no format at all', 'thermal', (c) => { delete c.manifest.format; }, /declares no package format/],
    ['a kind nothing normalises', 'thermal', (c) => { c.manifest.params.amount.kind = 'ramp'; }, /kind "ramp"/],
    ['a transform the applier has not got', 'thermal', (c) => { c.manifest.params.amount.bind.transform = 'toKelvin'; }, /transform "toKelvin"/],
    ['a master that is not inert', 'thermal', (c) => { c.manifest.params.amount.def = 0.5; }, /master and defaults to 0\.5/],
    // The second master is inert and in range, so the row reaches the master count rather than
    // being answered by the bounds rule above it.
    ['a second master', 'rain', (c) => { Object.assign(c.manifest.params.speed, { role: 'master', def: 0, min: 0 }); }, /2 parameters with the role master/],
    ['a reading flag that is not boolean', 'ghost', (c) => { c.manifest.params.amount.reading = 'yes'; }, /declares reading as "yes"/],
    ['a reading that is not the inert master', 'ghost', (c) => { c.manifest.params.rim.reading = true; }, /declares itself a reading/],
    ['a dependent row naming no valid parent', 'ghost', (c) => { c.manifest.params.rim.under = 'missing'; }, /not a valid parent in ghost/],
    ['a binding no program declares', 'thermal', (c) => { c.manifest.params.amount.bind.uniform = 'thermalll'; }, /declares no such uniform/],
    ['a uniform no parameter writes', 'rain', (c) => { c.chunks['decl.frag.glsl'] += 'uniform float rainStray;\n'; }, /"rainStray" and binds no parameter/],
    ['a chunk file naming a path', 'thermal', (c) => { c.manifest.chunks[0].file = '../out.glsl'; c.chunks['../out.glsl'] = ''; }, /"\.\.\/out\.glsl"/],
    ['a joint no spine holds', 'thermal', (c) => { c.manifest.chunks[0].stage = 'f.elsewhere'; }, /does not assemble/],
    ['an identifier that is nowhere', 'thermal', (c) => { c.chunks['heat.frag.glsl'] += '  col = vec3(qqNotHere);\n'; }, /"qqNotHere"/],
    ['a varying init that reads state', 'rain', (c) => { c.manifest.varyings[0].init = 'rainPhase'; }, /initialises to "rainPhase"/],
    ['a panel group anchored nowhere named', 'rain', (c) => { delete c.manifest.panelGroups[0].after; }, /anchors after undefined/],
    ['a file the manifest never names', 'thermal', (c) => { c.chunks['spare.glsl'] = ''; }, /"spare\.glsl" and its manifest names no chunk/],
    ['a chunk whose text did not arrive', 'thermal', (c) => { delete c.chunks['heat.frag.glsl']; }, /its text did not arrive/],
  ];
  for (const [what, id, edit, matches] of cases) {
    const refusal = brokenBy(id, edit);
    assert.ok(refusal, `the door accepted ${what}`);
    assert.match(refusal, matches, `the door refused ${what} for the wrong reason: ${refusal}`);
  }
});

test('a chunk may not redeclare a local the spine holds in the same scope', () => {
  const edit = (prefix) => brokenBy('glyph', (c) => { c.chunks['size.vert.glsl'] = prefix + c.chunks['size.vert.glsl']; });
  // The two the vertex spine computes just above the size slot: a package written against a
  // build without them compiled then and links against nothing now.
  for (const name of ['zoom', 'k']) {
    const refusal = edit(`  float ${name} = 1.0;\n`);
    assert.match(refusal ?? '', new RegExp(`"${name}" is declared twice`), `a chunk redeclaring ${name} got through`);
    assert.match(refusal, /size\.vert\.glsl/, 'the refusal does not name the chunk that declares it');
  }
  // A nested block may shadow, which the shipped ripple does with dist, so a block is not a refusal.
  assert.equal(edit('  { float zoom = 1.0; }\n'), null);
  // A name that is only the chunk's own, declared once, is what every shipped chunk does.
  assert.equal(edit('  float lensed = zoom;\n'), null);
});

test('a chunk may not carry a preprocessor directive, which could declare past the scope walk', () => {
  const edit = (prefix) => brokenBy('glyph', (c) => { c.chunks['size.vert.glsl'] = prefix + c.chunks['size.vert.glsl']; });
  // The macro reaches the compiler as `float zoom` beside the spine's own, and no text scan expands it.
  assert.match(edit('#define OLD_LOCAL float zoom = 1.0;\n  OLD_LOCAL\n') ?? '', /preprocessor directive/);
  assert.match(edit('  #define ONE 1.0\n') ?? '', /preprocessor directive/);
  assert.match(edit('#ifdef GL_ES\n#endif\n') ?? '', /preprocessor directive/);
  // A hash inside a comment is text, not a directive.
  assert.equal(edit('  // #define is not allowed here\n'), null);
});

test('a manifest field that is a list is refused when it is not one', () => {
  const fields = [['thermal', 'chunks'], ['rain', 'varyings'], ['rain', 'panelGroups'], ['rain', 'hostDriven']];
  for (const [id, field] of fields) {
    assert.equal(brokenBy(id, () => {}), null, `the shipped ${id} is refused before this row changes anything`);
    // `null` is in the list on purpose: `?? []` reads it as "no chunks at all", so a manifest
    // that meant none and typed one would quietly have been taken.
    for (const value of [{}, 'one', 3, null, true]) {
      const refusal = brokenBy(id, (c) => { c.manifest[field] = value; });
      assert.ok(refusal, `the door accepted ${id}'s ${field} as ${JSON.stringify(value)}`);
      assert.match(refusal, new RegExp(`declares ${field} as `),
        `the door refused ${id}'s ${field} as ${JSON.stringify(value)} for the wrong reason: ${refusal}`);
    }
  }
});

test('the door bounds how much of a package it will take', () => {
  const wide = (n) => brokenBy('thermal', (c) => {
    for (let i = 0; i < n; i++) {
      c.manifest.chunks.push({ stage: 'f.tone', order: 500 + i, file: `pad${i}.frag.glsl` });
      c.chunks[`pad${i}.frag.glsl`] = '\n';
    }
  });
  // Sized around the bound rather than far past it, so a build whose bound had drifted anywhere
  // at all fails one of the two rows. The same shape is used for every bound below.
  assert.equal(wide(60), null, 'a package inside the file bound is not refused by it');
  assert.match(wide(64), /carries 65 files/, 'a package past the file bound is refused by name');

  const heavy = (bytes) => brokenBy('thermal', (c) => {
    c.chunks['heat.frag.glsl'] += `\n// ${'x'.repeat(bytes)}\n`;
  });
  assert.equal(heavy(1024), null, 'a package inside the byte bound is not refused by it');
  assert.match(heavy(256 * 1024), /bytes of chunk text/, 'a package past the byte bound is refused by name');

  // A file counts once in both bounds above while the assembler emits a chunk once per
  // descriptor naming it, so the carried size and the assembled size come apart on a repeat.
  const spliced = (times) => brokenBy('thermal', (c) => {
    for (let i = 0; i < 60; i++) {
      c.chunks[`pad${i}.frag.glsl`] = `// ${'x'.repeat(3000)}\n`;
      for (let t = 0; t < times; t++) {
        c.manifest.chunks.push({ stage: t === 0 ? 'f.tone' : 'f.decl', order: 500 + i, file: `pad${i}.frag.glsl` });
      }
    }
  });
  assert.equal(spliced(1), null, 'the same bytes spliced once are inside every bound this door has');
  assert.match(spliced(2), /splices \d+ bytes of chunk text/,
    'and the same bytes spliced twice are refused, which is the multiplier the carried size cannot show');

  assert.match(brokenBy('thermal', (c) => {
    c.manifest.chunks.push({ ...c.manifest.chunks[0], order: 900 });
  }), /heat\.frag\.glsl is spliced into "f\.tone" twice/,
  'one joint naming one file twice is refused, whatever the orders say');
  assert.equal(brokenBy('thermal', (c) => {
    c.manifest.chunks.push({ stage: 'f.decl', order: 900, file: 'heat.frag.glsl' });
  }), null, 'and two different joints naming one file is not, which is what the rule above is a distinction from');
});

test('an id is a directory name, so the door bounds how long it may be', () => {
  const all = shipped();
  const donor = all.find((p) => p.id === 'thermal');
  // The donor is dropped from `beside`: leaving the original standing next to its own copy
  // collides on every slot and varying, and would refuse the candidate for the wrong reason.
  const renamed = (id) => doorRefusal(
    { id, manifest: { ...JSON.parse(JSON.stringify(donor.manifest)), id }, chunks: { ...donor.chunks } },
    { beside: beside(all, 'thermal'), spines: SPINES },
  );
  assert.equal(renamed('t'.repeat(MAX_EFFECT_ID)), null,
    `an id of exactly ${MAX_EFFECT_ID} characters is inside the bound and must not be refused by it`);
  assert.match(renamed('t'.repeat(MAX_EFFECT_ID + 1)), new RegExp(`declares an id of ${MAX_EFFECT_ID + 1} characters`),
    'and one character past it is refused by name, before it is a rename that cannot be made');
  for (const pkg of all) {
    assert.ok(pkg.id.length <= MAX_EFFECT_ID,
      `the shipped ${pkg.id} is ${pkg.id.length} characters, which this build's own door would refuse`);
  }
});

test('a binding is checked against the program its own table names', () => {
  assert.match(brokenBy('rain', (c) => { c.manifest.params.amount.bind.on = 'grade'; }),
    /rain\.amount binds the uniform "rain" and the assembled grade program declares no such uniform/,
    'a binding moved to the other table is refused, because the chunk declaring it feeds the cloud');
  assert.equal(brokenBy('rain', (c) => { c.manifest.params.amount.bind.on = 'points'; }), null,
    'and the shipped binding is not, which is what says the rule is about the program rather than the name');
});

test('a package may not declare one panel group key twice', () => {
  assert.match(brokenBy('rain', (c) => {
    c.manifest.panelGroups.push({ ...c.manifest.panelGroups[0], label: 'Rain again', order: 200 });
  }), /declares the panel group "rain" twice/, 'one key declared twice is refused by name');
});

test('a binding has to be the shape of the uniform it writes', () => {
  assert.match(
    brokenBy('raster', (c) => { delete c.manifest.params.angle.bind.transform; }),
    /declares as vec2.*needs a float/s,
    'a plain binding onto a two-component uniform is refused',
  );
  assert.match(
    brokenBy('thermal', (c) => { c.manifest.params.amount.bind.transform = 'axisDeg'; }),
    /declares as float.*needs a vec2/s,
    'an axisDeg binding onto a one-component uniform is refused',
  );
});

test('a step has to be a grid this build can snap to', () => {
  assert.match(brokenBy('thermal', (c) => { c.manifest.params.amount.step = 1e-7; }),
    /declares step 1e-7 and the finest grid/, 'a step below the floor is refused by name');
  assert.equal(brokenBy('thermal', (c) => { c.manifest.params.amount.step = 1e-6; }), null,
    'a step at the floor is not refused by it');
});

test('a bound off its own step grid is a number the registry never holds', () => {
  assert.match(brokenBy('noise', (c) => { c.manifest.params.speed.def = 0.72; }),
    /declares def 0\.72 and the registry would hold it at 0\.7/,
    'a default between two positions is refused, naming where it would actually land');
  assert.equal(brokenBy('noise', (c) => { c.manifest.params.speed.def = 0.75; }), null,
    'and a default on the grid is not - which is what says this rule is about the grid rather than about the value');

  // `snapScalar` clamps, so a `max` the snap steps past is put back onto itself. The door lifts
  // the ceiling by a step to ask with the clamp out of the way, and this row says that works.
  assert.match(brokenBy('noise', (c) => { c.manifest.params.speed.max = 2.98; }),
    /runs to 2\.98, which is not on the 0\.05 grid 0 anchors/,
    'a ceiling off the grid is refused even though a value clamped to it is the ceiling');
  assert.equal(brokenBy('noise', (c) => { c.manifest.params.speed.max = 2.95; }), null,
    'and a ceiling on the grid is not');

  // `min` anchors the grid, so a grid rule asking about it could never go red - the place count
  // is what asks. What a too-fine `min` breaks is every other value, asserted two rows down.
  assert.match(brokenBy('noise', (c) => { c.manifest.params.speed.min = 1e-101; }),
    /declares min as 1e-101, which needs 100 decimal places/,
    'a floor finer than the rounding this build can express is refused by name rather than through its symptom');
  assert.match(brokenBy('noise', (c) => { c.manifest.params.speed.min = 1e-101; c.manifest.params.speed.def = 1e-101; }),
    /declares min as 1e-101/,
    'and a default sitting exactly on such a floor is refused too, which is the residual this rule closed');
  assert.equal(snapScalar({ min: 1e-101, max: 3, step: 0.05 }, 0.7), 0.7000000000000001,
    'a floor past the rounding cap moves every other value, which is what the refusal is about');
  assert.equal(snapScalar({ min: 0, max: 3, step: 0.05 }, 0.7), 0.7,
    'and the same value on an ordinary floor does not, so the reading above is about the floor');

  assert.equal(brokenBy('noise', (c) => { c.manifest.params.speed.min = 0.000001; c.manifest.params.speed.step = 0.000001; c.manifest.params.speed.def = 0.000002; c.manifest.params.speed.max = 0.000005; }), null,
    'a parameter at the finest grid this build snaps to is not refused by the place rule');
  assert.match(brokenBy('noise', (c) => { c.manifest.params.speed.max = 2.9500001; }),
    /declares max as 2\.9500001, which needs 7 decimal places/,
    'and one place past it is refused, naming the field and the count');
});

test('a package may only put its rows in a group that exists, and may not claim one twice', () => {
  assert.match(brokenBy('thermal', (c) => { c.manifest.params.amount.panel.group = 'stlye'; }),
    /asks for the panel group "stlye"/, 'a parameter naming no group anybody holds is refused');
  assert.equal(brokenBy('rain', (c) => { c.manifest.params.amount.panel.group = 'post'; }), null,
    'a parameter may name a core group: the escape hatch the door deliberately keeps open for a '
    + 'term that belongs beside the spine\'s, which no shipped package uses now that each owns a group');
  assert.equal(brokenBy('rain', (c) => { c.manifest.params.amount.panel.group = 'rain'; }), null,
    'and a parameter naming its own package\'s group is what all twenty-two shipped packages do');

  assert.match(brokenBy('rain', (c) => {
    c.manifest.panelGroups[0].key = 'post';
    for (const p of Object.values(c.manifest.params)) p.panel.group = 'post';
  }), /already\s+holds one under that key/, 'a package group colliding with a core group is refused');
  assert.match(brokenBy('rain', (c) => {
    c.manifest.panelGroups[0].key = 'glitch';
    for (const p of Object.values(c.manifest.params)) p.panel.group = 'glitch';
  }), /effect glitch already declares/, 'a package group colliding with another package\'s is refused, naming the other package');
});

test('a binding may not aim at an array, whichever side the dimension is written on', () => {
  const arrayed = (declaration) => brokenBy('thermal', (c) => {
    c.manifest.chunks.push({ stage: 'f.decl', order: 700, file: 'weights.frag.glsl' });
    c.chunks['weights.frag.glsl'] = `${declaration}\n`;
    c.manifest.params.weights = {
      kind: 'scalar', label: 'Weights', def: 0, min: 0, max: 1, step: 0.05,
      panel: { group: 'colour' }, bind: { on: 'points', uniform: 'thermalWeights' },
    };
  });
  assert.match(arrayed('uniform float thermalWeights[4];'), /declares as float\[4\].*no array kind/s,
    'a scalar bound to an array declared after the name is refused, naming the dimension it found');
  assert.match(arrayed('uniform float[4] thermalWeights;'), /declares as float\[4\].*no array kind/s,
    'and the type-level spelling of the same declaration is refused identically, which is the half that used to declare nothing at all');
  assert.equal(arrayed('uniform float thermalWeights;'), null,
    'and the same declaration without a dimension is not refused, which is what says this rule is about the array');
});

test('an id the route table has claimed is not an id a package may have', () => {
  const all = shipped();
  const donor = all.find((p) => p.id === 'thermal');
  const named = (id) => doorRefusal(
    { id, manifest: { ...JSON.parse(JSON.stringify(donor.manifest)), id }, chunks: { ...donor.chunks } },
    { beside: beside(all, 'thermal'), spines: SPINES },
  );
  // The live list is empty today, so a row driven over it runs zero times. The rule is asked
  // directly with a reserved id in hand instead, through the path `doorRefusal` itself calls.
  assert.match(reservedIdRefusal('verify', ['verify']),
    /effect verify takes an id this build's HTTP surface has already claimed/,
    'the reserved-id rule does not refuse an id on the list it was handed, so nothing here proves it works');
  assert.match(reservedIdRefusal('verify', ['verify', 'check']), /The reserved names are verify, check/,
    'and it names the whole set, because an author who trips it needs to know which names are gone');
  assert.equal(reservedIdRefusal('verifier', ['verify']), null, 'an id that merely starts with a reserved one is not reserved');
  assert.equal(reservedIdRefusal('verif', ['verify']), null, 'and neither is one a reserved name starts with');

  for (const id of RESERVED_EFFECT_IDS) {
    assert.match(named(id), new RegExp(`effect ${id} takes an id this build's HTTP surface has already claimed`),
      `a package at the reserved id ${id} is accepted, so the store will list one the page cannot read`);
  }
  for (const pkg of all) {
    assert.equal(named(pkg.id) && reservedIdRefusal(pkg.id), null,
      `the shipped ${pkg.id} sits on a reserved id, so this build refuses its own package`);
  }
});

test('RESERVED_EFFECT_IDS is what the route table actually claims', () => {
  const claimedIn = (paths) => [...new Set(
    paths.map((p) => p.match(/^\/effects\/([^/:]+)$/)?.[1]).filter((s) => s !== undefined),
  )].sort();

  const server = readFileSync(join(ROOT, 'server/index.js'), 'utf8');
  const paths = [...server.matchAll(/path:\s*'(\/effects\/[^']*)'/g)].map((m) => m[1]);
  assert.ok(paths.includes('/effects/:id'),
    `the scan found ${paths.length} effect route paths and none of them is the per-id read, so it is not reading the table`);
  assert.deepEqual(claimedIn(paths), [...RESERVED_EFFECT_IDS].sort(),
    'the route table claims a different set of effect ids than the door reserves - a package under a claimed id '
    + 'is listed by GET /effects and refused when the page fetches it, which is a page that does not boot');

  // The extraction shown to find something, because both sides of the comparison above are
  // empty on this build and would pass just as well on a scan that was reading nothing.
  assert.deepEqual(claimedIn(['/effects', '/effects/:id', '/effects/verify', '/effects/:id/file/:name']),
    ['verify'],
    'the extraction does not pick a literal segment out of the route paths, so the comparison above '
    + 'is between two empty lists whatever the table holds');
});

test('a gating binding has to be something the gate can read', () => {
  assert.match(brokenBy('raster', (c) => { c.manifest.params.angle.bind.gates = true; }),
    /declares gates beside the axisDeg transform/,
    'a gate on a two-component direction is refused, because there is no zero for it to be at');
  assert.match(brokenBy('rain', (c) => { c.manifest.params.amount.bind.gates = true; }),
    /declares gates and binds on "points"/,
    'a gate on the point cloud\'s table is refused, because nothing collects it');

  assert.equal(brokenBy('raster', (c) => { c.manifest.params.amount.bind.gates = true; }), null,
    'a plain grade binding that gates is what the shipped set already does');
  // A parameter of its own rather than a repointed `angle`: moving `angle` off `scanAxis` leaves
  // that uniform declared with nothing binding it, so the fixture is refused by another rule.
  assert.equal(brokenBy('raster', (c) => {
    c.manifest.params.tilt = {
      def: 0, min: 0, max: 1, step: 0.05, kind: 'scalar', label: 'raster tilt',
      panel: { group: 'raster', tab: 'look' },
      bind: { on: 'grade', uniform: 'scanTilt', transform: 'degToRad', gates: true },
      under: 'amount',
    };
    c.chunks['decl.grade.glsl'] = `${c.chunks['decl.grade.glsl']}uniform float scanTilt;\n`;
  }), null, 'and degToRad lands a number, so it gates like any other scalar');
  assert.equal(brokenBy('raster', () => {}), null,
    'and the shipped raster, whose angle is axisDeg with no gate on it, is untouched by this rule');

  for (const pkg of shipped()) {
    for (const [short, spec] of Object.entries(pkg.manifest.params)) {
      if (!spec.bind?.gates) continue;
      assert.ok(EFFECT_GATED_TABLES.includes(spec.bind.on),
        `the shipped ${pkg.id}.${short} gates on ${spec.bind.on}, which holds no pass open`);
      assert.equal(spec.bind.transform, undefined,
        `the shipped ${pkg.id}.${short} gates through the ${spec.bind.transform} transform`);
    }
  }
});

test('a pass that remembers is told how long for, exactly once', () => {
  assert.match(brokenBy('datamosh', (c) => { delete c.manifest.params.refresh.bind.bounds; }),
    /declares 0 of them as its bounds/,
    'a mosh package with no period is a feedback pass no seek could reproduce');
  assert.match(brokenBy('datamosh', (c) => { c.manifest.params.grain.bind.bounds = true; }),
    /declares 2 of them as its bounds/,
    'and two periods is two answers to where the last refresh was');
  assert.match(brokenBy('raster', (c) => { c.manifest.params.pitch.bind.bounds = true; }),
    /declares bounds and binds on "grade"/,
    'a period on a pass with no memory bounds nothing');
  assert.match(brokenBy('datamosh', (c) => {
    c.manifest.params.refresh.kind = 'step';
    c.manifest.params.refresh.def = false;
    delete c.manifest.params.refresh.min;
    delete c.manifest.params.refresh.max;
    delete c.manifest.params.refresh.step;
  }), /declares bounds and is a step binding/,
  'and a period that is a switch is not a length of time');
  assert.equal(brokenBy('datamosh', () => {}), null, 'the shipped datamosh passes the rule');

  // The census, so a second package binding on a pass with memory is asked by existing.
  for (const pkg of shipped()) {
    const onBounded = Object.values(pkg.manifest.params)
      .filter((spec) => EFFECT_BOUNDED_TABLES.includes(spec.bind?.on));
    if (onBounded.length === 0) continue;
    assert.equal(onBounded.filter((spec) => spec.bind.bounds).length, 1,
      `the shipped ${pkg.id} binds on a pass with memory and does not name exactly one period`);
  }
});

test('hostDriven names a uniform this build really drives, not any uniform at all', () => {
  assert.equal(brokenBy('rain', () => {}), null, 'the shipped rain is accepted before this row changes anything');
  assert.match(brokenBy('rain', (c) => {
    c.chunks['decl.vert.glsl'] += 'uniform float rainOwnClock;\n';
    c.manifest.hostDriven.push('rainOwnClock');
  }), /lists "rainOwnClock" as host-driven and this build's render loop writes "rainPhase"/,
  'a package inventing its own host-driven uniform is refused, naming what the host does write');
  assert.deepEqual([...HOST_DRIVEN_UNIFORMS], ['rainPhase'],
    'the host-driven set is the one name the rain needs - a set that had grown would need this row read again');

  const main = readFileSync(join(ROOT, 'web/main.js'), 'utf8');
  const written = new Set(
    [...main.matchAll(/\buniforms\.([A-Za-z_][A-Za-z0-9_]*)\.value\s*(?:=[^=]|\.set\b)/g)].map((m) => m[1]),
  );

  for (const name of HOST_DRIVEN_UNIFORMS) {
    assert.ok(written.has(name),
      `${name} is listed as host-driven and nothing in web/main.js writes it, so the door is excusing a uniform that reads zero`);
  }

  // Comments stripped first. Two chunks quote the spine's own uniforms in prose, and a
  // declaration pattern running to the next semicolon walks straight through a paragraph - which
  // produced a false finding naming `readDepth` on a build with nothing wrong with it.
  const withoutComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
  const declaredByPackages = new Set();
  for (const pkg of shipped()) {
    for (const raw of Object.values(pkg.chunks)) {
      const text = withoutComments(raw);
      for (const m of text.matchAll(/\buniform\s+(?:(?:highp|mediump|lowp)\s+)?[A-Za-z_][A-Za-z0-9_]*\s+([^;]*);/g)) {
        for (const part of m[1].split(',')) {
          const nm = part.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)/);
          if (nm) declaredByPackages.add(nm[1]);
        }
      }
    }
  }
  const unlisted = (writes, declared, listed) => [...writes]
    .filter((n) => declared.has(n) && !listed.includes(n));
  assert.deepEqual(unlisted(written, declaredByPackages, HOST_DRIVEN_UNIFORMS), [],
    'web/main.js writes a uniform a shipped package declares that HOST_DRIVEN_UNIFORMS does not name - '
    + 'that is a host clock wired up without the door being told, and the door will refuse the package that declares it');

  // The predicate shown to fire, because on this build no real input can redden it: the only
  // name in both scans is `rainPhase`, and it is on the list.
  assert.deepEqual(
    unlisted(new Set(['rainPhase', 'someClock']), new Set(['someClock']), ['rainPhase']),
    ['someClock'],
    'the direction-two rule does not flag a name that is written, package-declared and unlisted, so the row above proves nothing');

  assert.ok(declaredByPackages.size > 0 && written.size > 0,
    `this row read ${declaredByPackages.size} package-declared uniforms and ${written.size} writes in web/main.js - `
    + 'either being empty means the scan found nothing and both directions above were vacuous');
});

test('the door bounds the manifest as well as the chunks it names', () => {
  const withParams = (n) => brokenBy('thermal', (c) => {
    for (let i = 0; i < n; i++) {
      c.manifest.params[`k${i}`] = {
        kind: 'scalar', label: `Knob number ${i} of a manifest nobody wrote by hand`,
        def: 0, min: 0, max: 1, step: 0.05,
        panel: { group: 'colour' }, bind: { on: 'points', uniform: 'thermal' },
      };
    }
  });
  assert.equal(withParams(95), null, 'a manifest inside the bound is not refused by it');
  assert.match(withParams(115), /carries a manifest of \d+ bytes/,
    'and one past it is refused by name, counting the bytes the store would write');
  assert.match(withParams(12000), /carries a manifest of \d+ bytes/,
    'the twelve thousand parameters that fit in a request body are refused');

  for (const pkg of shipped()) {
    const bytes = Buffer.byteLength(`${JSON.stringify(pkg.manifest, null, 2)}\n`, 'utf8');
    assert.ok(bytes <= 32 * 1024,
      `the shipped ${pkg.id} carries a ${bytes}-byte manifest, which this build's own door would refuse`);
  }
});

test('a fork may add and retune, and may not drop', () => {
  const all = shipped();
  const noise = all.find((p) => p.id === 'noise');
  const whole = { id: 'noise', manifest: JSON.parse(JSON.stringify(noise.manifest)), chunks: noise.chunks };
  whole.manifest.version = '2.0.0';
  whole.manifest.params.amount.max = 2;
  assert.equal(forkRefusal(whole, noise), null, 'a fork that keeps every key is what forking is for');

  const short = { id: 'noise', manifest: JSON.parse(JSON.stringify(noise.manifest)), chunks: noise.chunks };
  delete short.manifest.params.speed;
  assert.match(forkRefusal(short, noise), /drops noise\.speed/,
    'a fork short of a placed name is a registry that cannot assemble');
});
