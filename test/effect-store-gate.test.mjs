// The boot gate against a user root somebody has put packages into, under bare node. The
// user root is a fresh temporary directory each time and the builtin root is the repo's own
// `effects-builtin/`, which is only ever read.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EffectStore } from '../server/effect-store.js';
import { cloudSpine } from '../web/cloud-shader.js';
import { gradeSpine } from '../web/grade-shader.js';
import { moshSpine } from '../web/mosh-shader.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUILTIN = join(ROOT, 'effects-builtin');
const SPINES = { cloud: cloudSpine, grade: gradeSpine, mosh: moshSpine };

const builtinManifest = (id) => JSON.parse(readFileSync(join(BUILTIN, id, 'manifest.json'), 'utf8'));

/** One package written into a user root the way an install would have left it. Chunk text
 *  defaults to the builtin's, so a fixture states only what it changed. */
const stageFork = (dir, id, manifest, chunkEdits = {}) => {
  const at = join(dir, id);
  rmSync(at, { recursive: true, force: true });
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const c of manifest.chunks ?? []) {
    const shipped = readFileSync(join(BUILTIN, id, c.file), 'utf8');
    writeFileSync(join(at, c.file), chunkEdits[c.file] ? chunkEdits[c.file](shipped) : shipped);
  }
  return at;
};

/** The ids a user root is serving: directories, minus every aside, which carries a dot. */
const standing = (dir) => readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !e.name.includes('.'))
  .map((e) => e.name)
  .sort();

const asides = (dir) => readdirSync(dir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && e.name.endsWith('.incompatible'))
  .map((e) => e.name)
  .sort();

/** A fork that changes nothing but the version, which every row here needs as its control. */
const verbatim = (id) => ({ ...builtinManifest(id), version: '2.0.0' });

/** The `rain` fork this file is about: `vRain` dropped, and the rain's own reads of it edited
 *  out, so nothing about the package itself is wrong and only its neighbours break. */
const rainWithoutTheVarying = () => {
  const manifest = verbatim('rain');
  manifest.varyings = [];
  return { manifest, chunkEdits: {
    'cell.vert.glsl': (text) => text.replace(/^.*\bvRain\b.*$/gm, '  // the varying this fork dropped'),
    'lift.frag.glsl': (text) => text.replace(/fract\(vRain\)/g, '0.5'),
  } };
};

const withStore = (stage, assertions) => {
  const dir = mkdtempSync(join(tmpdir(), 'effect-store-gate-'));
  try {
    stage(dir);
    const store = new EffectStore(dir, BUILTIN, SPINES);
    store.claimUserRoot();
    assertions(store, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test('a fork that takes a neighbour down with it is set aside, and the neighbour is not', () => {
  const { manifest, chunkEdits } = rainWithoutTheVarying();
  withStore((dir) => stageFork(dir, 'rain', manifest, chunkEdits), (store, dir) => {
    assert.deepEqual(standing(dir), [],
      'the fork is set aside: nothing is left serving out of the user root');
    assert.equal(asides(dir).length, 1, `one aside, and the user root holds ${asides(dir).join(', ')}`);
    assert.match(asides(dir)[0], /^rain\./, 'and the aside is the fork rather than anything else');
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, asides(dir)[0], 'manifest.json'), 'utf8')).version, '2.0.0',
      'the fork is still on disk under its aside, whole, to be repaired and moved back');
    assert.equal(store.read('rain').builtin, true, 'the id is handed back to the package this build ships');
    assert.equal(store.list().length, readdirSync(BUILTIN).length,
      'and every shipped package is still listed - the gate refused one package, not everything near it');
  });
});

test('a fork that changes nothing is left exactly where it is', () => {
  withStore((dir) => stageFork(dir, 'rain', verbatim('rain')), (store, dir) => {
    assert.deepEqual(standing(dir), ['rain'], 'the healthy fork is still serving out of the user root');
    assert.deepEqual(asides(dir), [], 'and nothing was renamed aside');
    assert.equal(store.read('rain').builtin, false, 'the store answers for it as the user\'s copy');
    assert.equal(store.read('rain').manifest.version, '2.0.0', 'at the version the fork declares');
  });
});

test('the fork that changed is the one set aside, not the one it broke', () => {
  const { manifest, chunkEdits } = rainWithoutTheVarying();
  withStore((dir) => {
    stageFork(dir, 'glyph', verbatim('glyph'));
    stageFork(dir, 'rain', manifest, chunkEdits);
  }, (store, dir) => {
    assert.deepEqual(standing(dir), ['glyph'], 'the glyph fork survives and the rain fork does not');
    assert.equal(asides(dir).length, 1, `one aside, and the user root holds ${asides(dir).join(', ')}`);
    assert.match(asides(dir)[0], /^rain\./, 'and it is the rain, which is the package that changed');
    assert.equal(store.read('glyph').manifest.version, '2.0.0', 'the glyph fork is what the store answers with');
    assert.equal(store.read('rain').builtin, true, 'and the rain answers from the shipped package');
  });
});

test('a package called refuse is an ordinary package again', () => {
  // The id `refuse` specifically, because that is the one the old routing collision was
  // about; a row using any other id would pass on the build that had the defect.
  // The donor's group key travels with the fork, so it is renamed too: every builtin owns a
  // group now, and a fork keeping the donor's key collides with the donor rather than standing.
  const donor = builtinManifest('thermal');
  const named = {
    ...donor,
    id: 'refuse',
    title: 'A package named for what was once a route',
    panelGroups: donor.panelGroups.map((g) => ({ ...g, key: 'refuse', label: 'Refuse' })),
    params: Object.fromEntries(Object.entries(donor.params)
      .map(([short, spec]) => [short, { ...spec, panel: { ...spec.panel, group: 'refuse' } }])),
  };
  withStore((dir) => {
    const at = join(dir, 'refuse');
    mkdirSync(at, { recursive: true });
    writeFileSync(join(at, 'manifest.json'), `${JSON.stringify(named, null, 2)}\n`);
    for (const c of named.chunks ?? []) {
      writeFileSync(join(at, c.file), readFileSync(join(BUILTIN, 'thermal', c.file), 'utf8'));
    }
    writeFileSync(join(at, 'witness.marker'), 'somebody\'s package, under a name this build once took\n');
    stageFork(dir, 'rain', verbatim('rain'));
  }, (store, dir) => {
    assert.deepEqual(standing(dir), ['rain', 'refuse'], 'both packages stand: nothing about either id is refused');
    assert.deepEqual(asides(dir), [], 'and nothing was renamed aside, because there is no reserved name any more');
    assert.equal(store.read('refuse')?.manifest.title, named.title, 'the store answers for it as an ordinary package');
    assert.ok(store.list().some((e) => e.id === 'refuse'),
      'and the listing carries it, which is what the page fetches next — the request that used to be answered 405');
    assert.ok(existsSync(join(dir, 'refuse', 'witness.marker')), 'with its files exactly where they were');
  });
});

test('a fork is not quarantined for a builtin this build was already refusing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'effect-store-gate-'));
  const brokenBuiltins = mkdtempSync(join(tmpdir(), 'effect-store-builtin-'));
  try {
    // A copied builtin root, because on a correct build this condition is unreachable and a
    // row using the repo's own `effects-builtin/` could not go red whatever the code did.
    cpSync(BUILTIN, brokenBuiltins, { recursive: true });
    const heat = join(brokenBuiltins, 'thermal/heat.frag.glsl');
    writeFileSync(heat, `${readFileSync(heat, 'utf8')}  col = vec3(qqNotHere);\n`);

    const at = join(dir, 'rain');
    mkdirSync(at, { recursive: true });
    const manifest = verbatim('rain');
    writeFileSync(join(at, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    for (const c of manifest.chunks ?? []) {
      writeFileSync(join(at, c.file), readFileSync(join(BUILTIN, 'rain', c.file), 'utf8'));
    }

    const store = new EffectStore(dir, brokenBuiltins, SPINES);
    store.claimUserRoot();
    assert.deepEqual(standing(dir), ['rain'],
      'the fork is standing, because the fault was in the build rather than in the fork');
    assert.deepEqual(asides(dir), [], 'and nothing was renamed aside');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(brokenBuiltins, { recursive: true, force: true });
  }
});

test('a fork reading a name only another fork declares is promoted on the second pass', () => {
  const rain = verbatim('rain');
  // The varying has to be a name the shipped set has not got. This row said `vRain` first and
  // passed on a single sweep, because the builtin rain declares it.
  rain.varyings = [...rain.varyings, { name: 'vDrizzle', type: 'float', init: '0.0', order: 210 }];
  const glyph = verbatim('glyph');
  withStore((dir) => {
    stageFork(dir, 'glyph', glyph, {
      // Multiplied by zero, so the fork reads the name and draws what the shipped glyph draws.
      'index.frag.glsl': (text) => `${text}  falloff *= 1.0 - 0.0 * vDrizzle;\n`,
    });
    stageFork(dir, 'rain', rain);
  }, (store, dir) => {
    assert.deepEqual(standing(dir), ['glyph', 'rain'], 'both forks are standing');
    assert.deepEqual(asides(dir), [], 'and neither was renamed aside');
    assert.equal(store.list().filter((e) => !e.builtin).length, 2,
      'and the store is serving both of them as user packages');
  });
});

test('a half-authored directory missing manifest.json does not crash list() or read()', () => {
  withStore(() => {}, (store, dir) => {
    mkdirSync(join(dir, 'halfwritten'), { recursive: true });
    mkdirSync(join(dir, 'rain'), { recursive: true });
    assert.doesNotThrow(() => store.list());
    assert.equal(store.read('halfwritten'), null);
    assert.equal(store.list().some((e) => e.id === 'halfwritten'), false);
    assert.equal(store.read('rain')?.builtin, true);
  });
});
