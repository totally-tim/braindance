#!/usr/bin/env node
// The plugin contract, as an instrument: every installed effect, asked whether it is really absent
// when it is off. A build with sixteen effects installed and every value at its default has to draw
// exactly what a build with none of them installed draws. Three renders per package - the defaults,
// the master at zero with everything the manifest says it gates raised, and the package served
// hollow so it contributes no GLSL - must be the same image byte for byte, and a fourth with the
// package's own parameters raised must differ, or an effect reaching no pixel would satisfy the
// equality perfectly. The population comes off `GET /effects`, so a seventeenth package is asked by
// existing. Needs a running server and a GPU browser.

import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
};
const URL_BASE = flag('--url', 'http://localhost:8080');
const MUTATE = argv.includes('--mutate') ? flag('--mutate') : null;

/**
 * `leaks-at-zero` is served rather than written: this tool runs `--url` against a server somebody
 * else started, so there is no staged tree to edit and editing the checkout would leave a mutated
 * working tree behind any crash. A function rather than a `{ file, edits }` table, which is the
 * shape `syntax-check`'s anchor row recognises as redirecting the oracle - so the run itself
 * asserts the served text changed. It reddens the third arm alone, because `vRain` is computed
 * under `rain > 0.0` and the sub-keys are genuinely dead at zero. That is the whole argument for
 * having the third arm.
 */
const MUTATIONS = {
  'leaks-at-zero': (text, path) => (
    path.endsWith('/effects/rain/file/lift.frag.glsl')
      ? text.replace('col *= 1.0 + rain * rainLift;', 'col *= 1.0 + max(rain, 0.08) * rainLift;')
      : text
  ),
};

if (argv.includes('--mutate') && !MUTATIONS[MUTATE]) {
  console.log(`[conformance] DID NOT RUN - no mutation named ${MUTATE ?? '(nothing was given)'};`
    + ` this tool knows ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

let checked = 0;
let failed = 0;
let crashed = null;
let untested = null;
// Which effect each failed row belongs to: the claim of the method control is that a leak in one
// package reddens that package's rows and no other's, and a count cannot say that.
const firedFor = new Map();
const ok = (label, pass, detail = '', effect = null) => {
  checked++;
  if (!pass) {
    failed++;
    if (effect) firedFor.set(effect, [...(firedFor.get(effect) ?? []), label]);
  }
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const DEPTH_W = 512;
const DEPTH_H = 424;
const POSITIONS = [0.15, 0.7, 1.3];

/**
 * The frames every arm renders, planted here rather than taken off a capture. A leaning plane, so
 * the picture has range in it: on a flat wall every depth-keyed term writes the same value at every
 * pixel, which two builds can agree about for reasons unrelated to the term being read.
 */
const pinnedBuffer = () => {
  const FRAMES = 8;
  const depthBytes = DEPTH_W * DEPTH_H * 2;
  const out = Buffer.alloc(FRAMES * (16 + depthBytes));
  for (let f = 0; f < FRAMES; f++) {
    const at = f * (16 + depthBytes);
    out.writeUInt32LE(depthBytes, at);
    out.writeUInt32LE(0, at + 4);
    // 200ms apart, so the eight span 1.4 seconds and every position below sits inside the run. A
    // pinned source clamps past its last stamp, so positions beyond the end are the
    // same frame twice.
    out.writeBigUInt64LE(BigInt(f * 200), at + 8);
    for (let y = 0; y < DEPTH_H; y++) {
      for (let x = 0; x < DEPTH_W; x++) {
        const mm = 1100 + Math.round((x / DEPTH_W) * 1400 + (y / DEPTH_H) * 700) + f * 60;
        out.writeUInt16LE(mm, at + 16 + (y * DEPTH_W + x) * 2);
      }
    }
  }
  return out;
};

/**
 * A colour image with structure in it, for the terms that key on one. `drive.pin` switches colour
 * off because a JPEG decode is asynchronous and a hash across one would be a hash of whether it had
 * landed yet; a flat grey would put four packages in a dead zone the vacuity guard
 * would blame them for.
 */
const COLOR_W = 64;
const COLOR_H = 48;
const plantedColour = () => {
  const rgba = new Array(COLOR_W * COLOR_H * 4);
  for (let y = 0; y < COLOR_H; y++) {
    for (let x = 0; x < COLOR_W; x++) {
      const i = (y * COLOR_W + x) * 4;
      rgba[i] = (x * 4) % 256;
      rgba[i + 1] = (y * 5) % 256;
      rgba[i + 2] = ((x + y) * 3) % 256;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
};

/**
 * A line of a package's own GLSL that nothing else in the build writes: the longest line of its
 * chunks with the comments taken out. A package with no chunks at all has no such line, and its
 * rows say so rather than asserting against an empty string that every program contains.
 */
const markerOf = (pkg) => {
  const lines = Object.values(pkg.chunks ?? {}).join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 16 && !l.startsWith('//'));
  return lines.sort((a, b) => b.length - a.length)[0] ?? null;
};

/**
 * A value clearly off the default and inside the bounds: three quarters of the way to whichever end
 * is further from the default. Not the bound itself - several shipped bounds are degenerate on
 * purpose, so a raise landing on one can be inert for a reason about the bound rather than
 * about the parameter.
 */
const raisedValue = (spec) => {
  if (typeof spec.default === 'boolean') return !spec.default;
  const far = (spec.default - spec.min) > (spec.max - spec.default) ? spec.min : spec.max;
  return spec.default + (far - spec.default) * 0.75;
};

console.log(`[conformance] ${MUTATE ? `MUTATED: ${MUTATE} (served, not written)` : 'unmutated tree'}`);
console.log(`[conformance] against ${URL_BASE}\n`);

let browser = null;
// Which package `/effects/:id` is answering hollow for, and the body it answers with. Module state
// rather than a closure argument: the one route handler installed below outlives every
// package it serves.
let hollowFor = null;
let hollowBody = null;
try {
  let chromium;
  try {
    ({ chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs')));
  } catch {
    untested = 'playwright is not installed, and every claim here is about a rendered frame';
    throw new Error(untested);
  }

  // The population, off the store rather than off the page: the question below is whether the page
  // is assembled from what the server holds, and a list taken from the page would be the page
  // agreeing with itself.
  const listed = await fetch(`${URL_BASE}/effects`);
  if (!listed.ok) throw new Error(`GET /effects answered ${listed.status} - there is no population to check`);
  const { effects } = await listed.json();
  const packages = [];
  for (const { id } of effects) {
    const res = await fetch(`${URL_BASE}/effects/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`GET /effects/${id} answered ${res.status}`);
    const pkg = await res.json();
    // The chunk text as well as the manifest, because the marker below is a line of the package's
    // own GLSL and the manifest only names the files.
    pkg.chunks = {};
    for (const name of [...new Set((pkg.manifest.chunks ?? []).map((c) => c.file))]) {
      const chunk = await fetch(`${URL_BASE}/effects/${encodeURIComponent(id)}/file/${encodeURIComponent(name)}`);
      if (!chunk.ok) throw new Error(`GET /effects/${id}/file/${name} answered ${chunk.status}`);
      pkg.chunks[name] = await chunk.text();
    }
    packages.push(pkg);
  }

  // The full chromium build rather than the headless shell, which lands on SwiftShader.
  browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  // No socket, so nothing overwrites the planted frames: a live sensor wipes a plant in
  // well under a second.
  await page.routeWebSocket(/.*/, () => {});

  // Every chunk fetch goes through here whatever the mutation is, so the unmutated path and the
  // mutated one differ in one function call rather than in whether an interception is
  // installed at all.
  let mutatedText = 0;
  await page.route((url) => /\/effects\/[^/]+\/file\//.test(url.pathname), async (route) => {
    const res = await route.fetch();
    const text = await res.text();
    const next = MUTATE ? MUTATIONS[MUTATE](text, route.request().url()) : text;
    if (next !== text) mutatedText++;
    await route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', body: next });
  });

  // One handler consulting a variable: which package is served hollow changes sixteen times in a
  // run, and a route added and removed per package cannot be removed at all, because `page.unroute`
  // matches the matcher by reference.
  await page.route((url) => /^\/effects\/[a-z][a-z0-9]*$/.test(url.pathname), async (route) => {
    const id = new URL(route.request().url()).pathname.split('/')[2];
    if (id !== hollowFor) return route.continue();
    return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: hollowBody });
  });

  await page.goto(`${URL_BASE}/record`, { waitUntil: 'load' });
  await page.waitForFunction('Boolean(globalThis.__kinect)', null, { timeout: 20000 });

  /** All four assembled shader strings, as one, for the marker rows. */
  // Every program the page reports rather than the two it used to have. A chunk belongs to one
  // spine and the spines are a set this build can grow: naming them here meant the mosh pass's
  // text was searched for in the two programs it can never be in, and the row asking whether a
  // hollowed package's text comes back said it never did.
  const assembled = () => page.evaluate(() => {
    const p = globalThis.__kinect.effects.programs();
    return Object.values(p).map((x) => `${x.vertexShader}${x.fragmentShader}`).join('');
  });

  if (MUTATE) {
    // Before believing a mutation was missed, confirm it did something: a served mutation whose
    // target text has moved changes nothing, and a run of it reports the check as
    // having found nothing.
    ok(`the ${MUTATE} mutation reached the text it is about`, mutatedText > 0,
      `${mutatedText} served chunk${mutatedText === 1 ? '' : 's'} rewritten`);
  }

  const buffer = pinnedBuffer();
  await page.route('**/__conformance-pinned.bin', (route) => route.fulfill({
    status: 200, contentType: 'application/octet-stream', body: buffer,
  }));
  await page.evaluate(() => { document.getElementById('panel').style.display = 'none'; });
  await page.evaluate(async () => {
    const res = await fetch('/__conformance-pinned.bin');
    globalThis.__kinect.drive.pin(await res.arrayBuffer());
  });
  await page.evaluate(({ rgba, w, h }) => globalThis.__kinect.drive.plantColor(rgba, w, h),
    { rgba: plantedColour(), w: COLOR_W, h: COLOR_H });

  /**
   * One render of one look, hashed at three program positions. The camera is written every time
   * because the arms that drop a package rebuild the whole page in between, and `drive.reset`
   * rewinds the pinned source and clears both accumulators - which is what makes three renders
   * comparable at all.
   */
  const renderLook = (values, positions) => page.evaluate(async ({ v, ts }) => {
    const k = globalThis.__kinect;
    const sha256 = async (bytes) => {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    };
    k.params.reset();
    if (Object.keys(v).length) k.params.apply(v);
    k.drive.reset();
    k.freeCamera.position.set(0, 0.1, 1.6);
    k.freeCamera.lookAt(0, 0, -2.2);
    k.freeCamera.updateMatrixWorld(true);
    const hashes = [];
    for (const t of ts) {
      k.drive.stepTo(t);
      hashes.push(await sha256(k.drive.readPixels()));
    }
    // What the registry actually stored, handed back with the hashes: an arm that asked for a raise
    // and got a clamp renders the defaults and looks exactly like an effect that
    // cannot move a pixel.
    return { hashes, stored: Object.fromEntries(Object.keys(v).map((n) => [n, k.params.get(n)])) };
  }, { v: values, ts: positions });

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const brief = (hs) => hs.map((h) => h.slice(0, 8)).join(' ');

  const { hashes: defaults } = await renderLook({}, POSITIONS);
  ok('the defaults render, and the three positions are three different images',
    new Set(defaults).size === POSITIONS.length, brief(defaults));

  // Bounds off the page rather than off the manifests read above: asking the page is what makes a
  // raise land inside the bounds the page will clamp it to.
  const specs = await page.evaluate(() => Object.fromEntries(
    globalThis.__kinect.params.names('look').map((n) => [n, globalThis.__kinect.params.spec(n)]),
  ));

  console.log('');
  const raiseless = [];
  const vacuous = [];
  for (const pkg of packages) {
    const id = pkg.id;
    const own = Object.keys(pkg.manifest.params).map((short) => `${id}.${short}`);
    const masterShort = Object.entries(pkg.manifest.params).find(([, s]) => s.role === 'master')?.[0];
    const master = masterShort ? `${id}.${masterShort}` : null;
    const known = own.filter((n) => specs[n]);
    if (known.length !== own.length) {
      ok(`${id}: every parameter it declares is in this build's registry`, false,
        `${known.length} of ${own.length}: ${own.filter((n) => !specs[n]).join(', ')}`, id);
      continue;
    }

    const mark = markerOf(pkg);

    // Only the keys the manifest says the master gates, which is `under`. Raising every non-master
    // parameter is wrong about one shipped package: `noise.region` declares no `under` because it
    // is a second amplitude in the same namespace, and raising it under a master at zero correctly
    // moves the picture. The parameters that are neither the master nor under it are named in the
    // row's own detail rather than quietly skipped.
    const under = known.filter((n) => pkg.manifest.params[n.split('.').slice(1).join('.')].under === masterShort);
    const ungated = known.filter((n) => n !== master && !under.includes(n));
    const held = Object.fromEntries(under.map((n) => [n, raisedValue(specs[n])]));
    for (const n of [...(master ? [master] : []), ...ungated]) held[n] = specs[n].default;
    const { hashes: atZero } = await renderLook(held, POSITIONS);
    if (under.length === 0) raiseless.push(id);
    ok(`${id} at its inert master draws exactly what the defaults draw`
      + `${under.length === 0 ? ' (nothing declares itself under the master, so this arm is the defaults arm)' : ` (${under.length} key${under.length === 1 ? '' : 's'} raised under it)`}`,
    same(atZero, defaults), `${same(atZero, defaults) ? brief(defaults) : `${brief(atZero)} against ${brief(defaults)}`}`
      + `${ungated.length ? ` - held at its default beside the master: ${ungated.join(', ')}` : ''}`, id);

    // Served hollow rather than dropped from the list: the client's declaration order places every
    // shipped parameter by name, so a package missing from the list is a registry that cannot
    // assemble. What absent means for a shader is that the package contributes no GLSL - the chunks
    // go and the services they consume go with them, while the parameters and varyings stay, pinned
    // at the inert value the prologue writes.
    hollowFor = id;
    hollowBody = JSON.stringify({ ...pkg, manifest: { ...pkg.manifest, chunks: [], consumes: [] } });
    const rebuilt = await page.evaluate(async () => {
      try {
        await globalThis.__kinect.effects.reload();
        return null;
      } catch (err) { return String(err.message); }
    });
    let dropped = null;
    let goneWhileHollow = null;
    if (rebuilt === null) {
      goneWhileHollow = mark ? !(await assembled()).includes(mark) : null;
      dropped = (await renderLook({}, POSITIONS)).hashes;
    }
    hollowFor = null;
    const back = await page.evaluate(async () => {
      try {
        await globalThis.__kinect.effects.reload();
        return null;
      } catch (err) { return String(err.message); }
    });
    const backWhileWhole = mark && back === null ? (await assembled()).includes(mark) : null;

    ok(`${id} can be taken out of the served set and put back, so the arm above is about a rebuild rather than a refusal`,
      rebuilt === null && back === null, [rebuilt, back].filter(Boolean).join(' | ') || 'both rebuilds ran', id);
    // Assert against the program, not against the interception: a route that did not fire, a
    // hollowing that did not hollow and an unroute that did not restore all render a picture equal
    // to the defaults.
    if (mark) {
      ok(`${id}'s own text really does leave the assembled program while it is hollow, and comes back after`,
        goneWhileHollow === true && backWhileWhole === true,
        `while hollow: ${goneWhileHollow === true ? 'gone' : 'still there'}; after: ${backWhileWhole === true ? 'back' : 'missing'}`, id);
    }
    if (dropped) {
      ok(`${id} contributing no GLSL at all draws exactly what the defaults draw`,
        same(dropped, defaults), same(dropped, defaults) ? brief(defaults) : `${brief(dropped)} against ${brief(defaults)}`, id);
    }

    const raised = Object.fromEntries(known.map((n) => [n, raisedValue(specs[n])]));
    const { hashes: loud, stored } = await renderLook(raised, POSITIONS);
    // The raise has to have landed before its picture means anything: a value the registry clamped,
    // snapped away or refused renders the defaults, and a vacuity row reading only the picture
    // would blame the effect.
    const short = Object.keys(raised).filter((n) => Math.abs(stored[n] - raised[n]) > (specs[n].step ?? 0) + 1e-9);
    ok(`${id}'s raise reaches the registry, so the row under it is about the effect rather than about the raise`,
      short.length === 0,
      short.length ? short.map((n) => `${n} asked ${raised[n]} and holds ${stored[n]}`).join('; ')
        : Object.entries(stored).map(([n, x]) => `${n.split('.')[1]}=${x}`).join(' '), id);
    const moves = !same(loud, defaults);
    if (!moves) vacuous.push(id);
    ok(`${id} raised off its defaults moves the picture, so the three equalities above are not about a dead effect`,
      moves, moves ? `${brief(loud)} against ${brief(defaults)}` : `${brief(loud)} - identical to the defaults`, id);
  }

  const { hashes: restored } = await renderLook({}, POSITIONS);
  ok('and after every drop and restore the defaults still render what they rendered at the start',
    same(restored, defaults), same(restored, defaults) ? brief(defaults) : `${brief(restored)} against ${brief(defaults)}`);

  console.log('');
  if (raiseless.length) {
    console.log(`[conformance] ${raiseless.length} package${raiseless.length === 1 ? ' has' : 's have'} no sub-key, `
      + `so their inert-master arm is the defaults arm and only the drop arm can see a leak: ${raiseless.join(', ')}`);
  }
  if (vacuous.length) {
    console.log(`[conformance] ${vacuous.length} package${vacuous.length === 1 ? '' : 's'} could not move a pixel from `
      + `this fixture, so their equalities prove nothing: ${vacuous.join(', ')}`);
  }

  ok('the page reported no error through any of it', pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '));
} catch (err) {
  crashed = err;
  console.log(`\n  FAIL  the run did not finish: ${err.stack ?? err.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
}

console.log(`\n[conformance] ${checked} assertions, ${failed} failed`);
if (untested) {
  console.log(`[conformance] UNTESTED - ${untested}.`);
  process.exit(2);
}
// The count decides before the crash does: a mutation that half-breaks a page takes the driver down
// with it, and reporting DID NOT RUN over rows that had already fired is a caught mutation recorded
// as a run that proved nothing.
if (MUTATE && failed > 0) {
  console.log(`[conformance] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  if (crashed) console.log(`[conformance] and the run ended early: ${crashed.message.split('\n')[0]} - the count is a floor`);
  for (const [effect, rows] of firedFor) console.log(`[conformance] ${effect}: ${rows.join(' | ')}`);
  console.log(`[conformance] effects with a red row: ${[...firedFor.keys()].join(', ') || 'none'}`);
  process.exit(1);
}
if (crashed) {
  console.log(`[conformance] DID NOT RUN - ${crashed.message.split('\n')[0]}. Nothing here is a finding: re-run it.`);
  process.exit(2);
}
if (MUTATE) {
if (MUTATIONS[MUTATE]?.fails) console.log(`[conformance] it should redden: ${MUTATIONS[MUTATE].fails}`);
  console.log('[conformance] NOT CAUGHT - the check passed a build it should have rejected');
  process.exit(1);
}
if (failed) {
  for (const [effect, rows] of firedFor) console.log(`[conformance] ${effect}: ${rows.join(' | ')}`);
  console.log('[conformance] FAIL');
  process.exit(1);
}
console.log('[conformance] PASS');
process.exit(0);
