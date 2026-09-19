import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HOOK = pathToFileURL(join(ROOT, 'web/test-timers.js')).href;

// Everything a normal launch runs: the server, the pages, the command line and the render worker.
const SHIPPED_SOURCES = ['server', 'web', 'bin', 'tools/render-worker.mjs'];

function sources(entry) {
  const path = join(ROOT, entry);
  if (!statSync(path).isDirectory()) return [path];
  return readdirSync(path, { recursive: true }).map((name) => join(path, name))
    .filter((file) => /\.(m?js|html)$/.test(file));
}

// Every `testTimer` call site, read off disk so a timer added later is walked by existing.
function callSites() {
  const sites = [];
  for (const file of SHIPPED_SOURCES.flatMap(sources)) {
    if (file.endsWith('web/test-timers.js')) continue;
    const text = readFileSync(file, 'utf8');
    for (const call of text.matchAll(/testTimer\(([^)]*)\)/g)) {
      const literal = /^'([a-z-]+)',\s*(\[[\d_,\s]+\]|[\d_]+)$/.exec(call[1].trim());
      assert.ok(literal, `${relative(ROOT, file)}: testTimer(${call[1]}) names its timer and shipped value as literals`);
      sites.push({ file: relative(ROOT, file), name: literal[1], shipped: JSON.parse(literal[2].replace(/_/g, '')) });
    }
  }
  return sites;
}

// Asks the hook in a fresh process, whose environment carries only what `planted` says.
function ask(sites, { env = null, search = null } = {}) {
  const clean = { ...process.env };
  delete clean.BRAINDANCE_TEST_TIMERS;
  if (env !== null) clean.BRAINDANCE_TEST_TIMERS = env;
  const script = `${search === null ? '' : `globalThis.location = { search: ${JSON.stringify(search)} };`}
    const { testTimer } = await import(${JSON.stringify(HOOK)});
    const sites = ${JSON.stringify(sites)};
    console.log(JSON.stringify(sites.map((s) => testTimer(s.name, s.shipped))));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: clean, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = out.trim().split('\n');
  return { values: JSON.parse(lines.at(-1)), logged: lines.slice(0, -1) };
}

test('every hooked timer answers its shipped value when a launch plants nothing', () => {
  const sites = callSites();
  assert.ok(sites.length > 0, 'the walk found the call sites');
  const { values, logged } = ask(sites);
  sites.forEach((site, i) => assert.deepEqual(values[i], site.shipped, `${site.name} in ${site.file}`));
  assert.deepEqual(logged, [], 'and says nothing about a substitute');
});

test('each timer has one site, one name the hook accepts and one row in the proof-tools table', () => {
  const names = callSites().map((s) => s.name);
  assert.equal(new Set(names).size, names.length, `one site per name: ${names.join(' ')}`);
  const hook = readFileSync(join(ROOT, 'web/test-timers.js'), 'utf8');
  const accepted = [...hook.split('const NAMES = new Set([')[1].split(']);')[0].matchAll(/'([a-z-]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...accepted].sort(), [...names].sort(), 'the names the hook accepts are the names a site reads');
  const doc = readFileSync(join(ROOT, 'docs/proof-tools.md'), 'utf8');
  const section = doc.split('## Shortened product timers')[1].split('\n## ')[0];
  const rows = [...section.matchAll(/^\| `([a-z-]+)` \|/gm)].map((m) => m[1]);
  assert.deepEqual([...rows].sort(), [...names].sort());
});

test('nothing a launch runs plants either carrier', () => {
  const planting = SHIPPED_SOURCES.flatMap(sources)
    .filter((file) => !file.endsWith('web/test-timers.js'))
    .filter((file) => /BRAINDANCE_TEST_TIMERS|test-timers=|['"`]test-timers['"`]/.test(readFileSync(file, 'utf8')));
  assert.deepEqual(planting.map((file) => relative(ROOT, file)), []);
});

test('a planted substitute replaces each timer, through either carrier, and says so', () => {
  const sites = callSites();
  const planted = Object.fromEntries(sites.map((s, i) => [s.name, Array.isArray(s.shipped) ? s.shipped.map(() => i + 1) : i + 1]));
  for (const carrier of [{ env: JSON.stringify(planted) }, { search: `?test-timers=${encodeURIComponent(JSON.stringify(planted))}` }]) {
    const { values, logged } = ask(sites, carrier);
    sites.forEach((site, i) => assert.deepEqual(values[i], planted[site.name], `${site.name} through ${Object.keys(carrier)[0]}`));
    assert.equal(logged.length, sites.length, logged.join('\n'));
  }
});

test('a planted name that no timer answers to is refused, through either carrier', () => {
  const sites = callSites();
  const typo = JSON.stringify({ [`${sites[0].name}x`]: 250 });
  for (const carrier of [{ env: typo }, { search: `?test-timers=${encodeURIComponent(typo)}` }]) {
    assert.throws(() => ask(sites, carrier), (err) => /no timer answers to the test timer/.test(err.stderr), typo);
  }
});

test('a carrier that is not a JSON object of timers is refused', () => {
  const [site] = callSites();
  // Read for the reason, because a child that failed to run at all would throw here too.
  for (const env of ['{', '[1000]', 'null']) {
    assert.throws(() => ask([site], { env }), (err) => /test timers must|in JSON|JSON at position/.test(err.stderr), env);
  }
});

test('a substitute that is not a delay shaped like the shipped one is refused', () => {
  const sites = callSites();
  const refused = (site, value) => {
    const env = JSON.stringify({ [site.name]: value });
    assert.throws(() => ask([site], { env }), (err) => new RegExp(`test timer ${site.name} must`).test(err.stderr), env);
  };
  const scalar = sites.find((s) => !Array.isArray(s.shipped));
  for (const value of [-1, '1000', [1000], null]) refused(scalar, value);
  // A list-shaped timer, where the tree has one.
  const list = sites.find((s) => Array.isArray(s.shipped));
  if (list) for (const value of [1000, [], [1000, -1]]) refused(list, value);
});
