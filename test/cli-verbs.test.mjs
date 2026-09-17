import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, format, VERBS } from '../bin/verbs.js';
import { Output } from '../server/output.js';

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
  assert.deepEqual(parse(['output', 'set', 'camera={"fov":50}', 'crop=false']).body.params, { camera: { fov: 50 }, crop: false });
  assert.equal(format({ state: 'standby', consumers: { webcam: 0 } }), 'state: standby\nconsumers.webcam: 0');
});
const store = () => new Output({ version: 7, effects: { list: () => [{ id: 'bloom' }] },
  presets: { read: async (name) => ({ body: { version: name === 'old' ? 6 : 7,
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
  for (const patch of [null, [], { mode: 'x' }, { size: { w: 999999, h: 1 } }, { params: [] }, { preset: 'old', mode: 'mirror' }, { preset: 'missing' }]) {
    const before = structuredClone(output.state);
    await assert.rejects(output.write(patch));
    assert.deepEqual(output.state, before);
  }
});
test('concurrent preset and parameter writes retain request order and view is ephemeral', async () => {
  const output = store();
  await Promise.all([output.write({ preset: 'look' }), output.write({ params: { exposure: 2 }, view: { fov: 80 } })]);
  assert.equal(output.state.params.exposure, 2);
  assert.equal('view' in output.state, false);
});
