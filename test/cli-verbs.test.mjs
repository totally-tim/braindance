import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parse, format, VERBS, MUTATION_EXEMPTIONS } from '../bin/verbs.js';
import { Output } from '../server/output.js';
import { DOCUMENT_VERSIONS } from '../web/format.js';

test('every verb parses its arguments through the command table', () => {
  const argumentsFor = { 'camera color': ['on'], 'camera low-light': ['off'], 'output mode': ['mirror'],
    'output size': ['1920x1080'], 'output preset': ['my look'], 'output set': ['exposure=2'] };
  for (const row of VERBS) {
    const parsed = parse([...row.verb.split(' '), ...(argumentsFor[row.verb] ?? []), '--json']);
    assert.equal(parsed.route, row.route);
    assert.equal(parsed.method, row.method);
    assert.equal(parsed.json, true);
  }
});
test('arguments refuse malformed input and URL overrides environment', () => {
  for (const words of [[], ['sensor'], ['record', 'stop', 'extra'], ['camera', 'color', 'maybe'],
    ['output', 'size', '-1x3'], ['output', 'mode', 'bad'], ['output', 'set', 'x='],
    ['output', 'set', 'x=NaN'], ['status', '--wait'], ['status', '--unknown'], ['status', '--url']]) {
    assert.throws(() => parse(words));
  }
  assert.equal(parse(['status'], { BRAINDANCE_URL: 'http://localhost:1234' }).url, 'http://localhost:1234');
  assert.equal(parse(['--url', 'http://localhost:5678', 'status'], { BRAINDANCE_URL: 'http://localhost:1234' }).url, 'http://localhost:5678');
  assert.equal(parse(['--url=https://studio.example/braindance/', 'status']).url, 'https://studio.example/braindance');
  assert.equal(parse(['output', 'preset', '--', '--dark']).body.preset, '--dark');
  assert.throws(() => parse(['--url', 'http://localhost:5678/?x=1', 'status']), /query or hash/);
  assert.throws(() => parse(['--url', 'http://localhost:5678/#frag', 'status']), /query or hash/);
  assert.deepEqual(parse(['output', 'set', 'camera={"fov":50}', 'crop=false']).body.params, { camera: { fov: 50 }, crop: false });
  assert.equal(format({ state: 'standby', consumers: { webcam: 0 } }), 'state: standby\nconsumers.webcam: 0');
});

function checkVerbsAndRoutes(routes, verbs, exemptions) {
  const mutating = routes.filter((r) => r.mutates);
  assert.ok(mutating.length >= 20, `expected at least 20 mutating routes, saw ${mutating.length}`);
  for (const verb of verbs) {
    assert.ok(
      routes.some((route) => route.path === verb.route
        && (verb.method === 'GET' ? route.read : route.methods.includes(verb.method))),
      `verb ${verb.verb} (${verb.method} ${verb.route}) has no matching route in ROUTES`,
    );
    if (verb.read) {
      assert.ok(
        routes.some((route) => route.path === verb.read && route.read),
        `verb ${verb.verb} reads ${verb.read}, which has no read route in ROUTES`,
      );
    }
  }
  for (const route of mutating) {
    assert.ok(
      exemptions.includes(route.path)
        || verbs.some((verb) => verb.route === route.path && route.methods.includes(verb.method)),
      `mutating route ${route.path} has neither a CLI verb nor a MUTATION_EXEMPTIONS entry`,
    );
  }
  assert.equal(new Set(exemptions).size, exemptions.length, 'MUTATION_EXEMPTIONS contains duplicate entries');
  for (const exempted of exemptions) {
    assert.ok(
      mutating.some((route) => route.path === exempted),
      `MUTATION_EXEMPTIONS entry ${exempted} names no mutating route in ROUTES`,
    );
    assert.ok(
      !verbs.some((verb) => verb.route === exempted && verb.method !== 'GET'),
      `MUTATION_EXEMPTIONS entry ${exempted} is already covered by a mutating verb in VERBS`,
    );
  }
}

test('every verb and mutating route in server/index.js agrees with bin/verbs.js, and cli-check reads the staged copy', () => {
  const src = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const block = /const ROUTES = \[([\s\S]*?)\n\];/.exec(src)?.[1] ?? '';
  const routes = [];
  for (const entry of block.split(/\n  \{(?=\s*path:)/)) {
    const path = /path:\s*'([^']+)'/.exec(entry)?.[1];
    if (!path) continue;
    const read = /\bread:\s/.test(entry);
    const mutates = /\bwrite:\s*\{/.test(entry);
    const methods = [...(/methods:\s*\[([^\]]*)\]/.exec(entry)?.[1] ?? '').matchAll(/'([A-Z]+)'/g)].map((m) => m[1]);
    routes.push({ path, read, mutates, methods });
  }
  checkVerbsAndRoutes(routes, VERBS, MUTATION_EXEMPTIONS);

  assert.throws(
    () => checkVerbsAndRoutes(routes, VERBS, MUTATION_EXEMPTIONS.filter((p) => p !== '/library/remove-name/:id')),
    /mutating route \/library\/remove-name\/:id has neither a CLI verb nor a MUTATION_EXEMPTIONS entry/,
  );
  assert.throws(
    () => checkVerbsAndRoutes(
      routes,
      VERBS,
      MUTATION_EXEMPTIONS.map((p) => (p === '/capture/:hash/marks' ? '/capture/:id/marks' : p)),
    ),
    /mutating route \/capture\/:hash\/marks has neither a CLI verb nor a MUTATION_EXEMPTIONS entry/,
  );
  assert.throws(
    () => checkVerbsAndRoutes(routes, VERBS, [...MUTATION_EXEMPTIONS, '/capture/:id/marks']),
    /MUTATION_EXEMPTIONS entry \/capture\/:id\/marks names no mutating route in ROUTES/,
  );
  assert.throws(
    () => checkVerbsAndRoutes(routes, VERBS, [...MUTATION_EXEMPTIONS, MUTATION_EXEMPTIONS[0]]),
    /MUTATION_EXEMPTIONS contains duplicate entries/,
  );
  assert.throws(
    () => checkVerbsAndRoutes(routes, VERBS, [...MUTATION_EXEMPTIONS, '/sensor/standby']),
    /MUTATION_EXEMPTIONS entry \/sensor\/standby is already covered by a mutating verb in VERBS/,
  );
  assert.throws(
    () => checkVerbsAndRoutes(
      routes,
      VERBS.map((v) => (v.verb === 'takes' ? { ...v, route: '/library/missing' } : v)),
      MUTATION_EXEMPTIONS,
    ),
    /verb takes \(GET \/library\/missing\) has no matching route in ROUTES/,
  );
  assert.throws(
    () => checkVerbsAndRoutes(
      routes,
      VERBS.map((v) => (v.verb === 'output size' ? { ...v, route: '/output/missing' } : v)),
      MUTATION_EXEMPTIONS,
    ),
    /verb output size \(POST \/output\/missing\) has no matching route in ROUTES/,
  );
  assert.throws(
    () => checkVerbsAndRoutes(
      routes,
      VERBS.map((v) => (v.verb === 'sensor standby' ? { ...v, method: 'PUT' } : v)),
      MUTATION_EXEMPTIONS,
    ),
    /verb sensor standby \(PUT \/sensor\/standby\) has no matching route in ROUTES/,
  );
  assert.throws(
    () => checkVerbsAndRoutes(
      routes,
      VERBS.map((v) => (v.verb === 'sensor standby' ? { ...v, read: '/library/download/:id' } : v)),
      MUTATION_EXEMPTIONS,
    ),
    /verb sensor standby reads \/library\/download\/:id, which has no read route in ROUTES/,
  );

  const cliCheckSrc = readFileSync(new URL('../tools/cli-check.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(
    cliCheckSrc,
    /from\s+['"]\.\.\/bin\/verbs\.js['"]/,
    'cli-check must read VERBS and MUTATION_EXEMPTIONS from the staged WORK tree rather than ../bin/verbs.js',
  );
});

test('CLI reports HTTP status cleanly on non-JSON error responses instead of V8 SyntaxError', async (t) => {
  let status = 502;
  let body = '<html><body>502 Bad Gateway</body></html>';
  const srv = createServer((_req, res) => {
    res.writeHead(status, { 'Content-Type': 'text/html' });
    res.end(body);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => srv.close(resolve)));
  const url = `http://127.0.0.1:${srv.address().port}`;
  const cliBin = fileURLToPath(new URL('../bin/braindance.mjs', import.meta.url));
  const runCli = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [cliBin, '--url', url, 'status']);
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, err: err.trim() }));
  });
  const badGateway = await runCli();
  assert.equal(badGateway.code, 1);
  assert.match(badGateway.err, /^HTTP 502\b/);
  assert.doesNotMatch(badGateway.err, /Unexpected token/);

  status = 200;
  body = 'plain text that is not json';
  const unexpectedOk = await runCli();
  assert.equal(unexpectedOk.code, 2);
  assert.match(unexpectedOk.err, /non-JSON response/);
});
const store = () => new Output({ effects: { list: () => [{ id: 'bloom' }] },
  presets: { read: async (name) => ({ body: { version: DOCUMENT_VERSIONS.preset - (name === 'old' ? 1 : 0),
    requires: name === 'missing' ? [{ id: 'gone' }] : [], values: { exposure: 1 } } }) } });
test('preset clears look edits while preserving composition and tags', async () => {
  const output = store();
  await output.write({ params: { exposure: 2, left: -2, camera: { fov: 50 }, futureComposition: 3 }, tags: { futureComposition: 'composition' } });
  await output.write({ preset: 'look' });
  assert.deepEqual(output.state.params, { left: -2, camera: { fov: 50 }, futureComposition: 3 });
  assert.deepEqual(output.messages().map((patch) => Object.keys(patch)), [['mode', 'size'], ['preset'], ['params']]);
});
test('invalid patch leaves the whole output intact', async () => {
  const output = store();
  for (const patch of [null, [], { mode: 'x' }, { size: { w: 999999, h: 1 } }, { params: [] }, { preset: 'old', mode: 'mirror' }, { preset: 'missing' }, { view: 'x' }]) {
    const before = structuredClone(output.state);
    await assert.rejects(output.write(patch));
    assert.deepEqual(output.state, before);
  }
});
const LOOKED = { position: [1.5, -2.25, 3], quaternion: [0.1, 0.2, 0.3, 0.92], fov: 55 };
const ELSEWHERE = { position: [0, 1.75, -4], quaternion: [0, 0.7071, 0, 0.7071], fov: 62 };
test('concurrent preset and parameter writes retain request order, and the pose is not a field of the output', async () => {
  const output = store();
  await Promise.all([output.write({ preset: 'look' }), output.write({ params: { exposure: 2 }, view: LOOKED })]);
  assert.equal(output.state.params.exposure, 2);
  assert.equal('view' in output.state, false);
});
test('the last relayed pose is waiting for a source that connects while the operator is still', async () => {
  const output = store();
  // Nothing relayed yet, in either mode: a pose nobody sent is not a pose to hand out.
  assert.deepEqual(output.messages().map((patch) => Object.keys(patch)), [['mode', 'size']]);
  await output.write({ mode: 'mirror' });
  assert.deepEqual(output.messages().map((patch) => Object.keys(patch)), [['mode', 'size']]);
  await output.write({ view: LOOKED });
  await output.write({ view: ELSEWHERE });
  assert.deepEqual(output.messages().at(-1).view, ELSEWHERE);
  // The program camera is what `camera` mode draws, so the operator's view is not what that source
  // should be told, and a stale pose must not come back on the next switch.
  await output.write({ mode: 'camera' });
  assert.deepEqual(output.messages().map((patch) => Object.keys(patch)), [['mode', 'size']]);
  await output.write({ mode: 'mirror' });
  assert.deepEqual(output.messages().at(-1).view, ELSEWHERE);
});
test('a malformed pose is refused whole and never reaches the sources that connect after it', async () => {
  const output = store();
  await output.write({ mode: 'mirror', view: LOOKED });
  for (const view of [{}, { fov: 80 }, { position: [1, 2], quaternion: [0, 0, 0, 1], fov: 55 },
    { position: [1, 2, 3], quaternion: [0, 0, 0], fov: 55 }, { position: ['1', 2, 3], quaternion: [0, 0, 0, 1], fov: 55 },
    { position: [1, 2, 3], quaternion: [0, 0, 0, 1] }, { position: [1, 2, NaN], quaternion: [0, 0, 0, 1], fov: 55 }]) {
    await assert.rejects(output.write({ view }), /view must be/);
  }
  assert.deepEqual(output.messages().at(-1).view, LOOKED);
});
