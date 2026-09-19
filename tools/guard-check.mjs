#!/usr/bin/env node
// Proves the two things the security commit claims: that a socket is held to the same origin
// rule the mutating routes stand behind, and that nothing is on the network unless somebody
// typed a flag saying so. Every refusal row has a positive twin, or a server that refused every
// upgrade would pass. The bind half asks the real network interface, and is UNPROVEN without one.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { WebSocket } = createRequire(join(REPO, 'package.json'))('ws');

const argv = process.argv.slice(2);
const flag = (name, dflt = null) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const PORT = Number(flag('--port', '8321'));
const MUTATE = flag('--mutate');
const WORK = join(REPO, '.guard-check');

// Each names source text and must match exactly once. One row per term, so a red row
// names the claim.
const MUTATIONS = {
  // The reads answer another origin again. It must redden the cross-origin read row alone, and
  // leave the same-origin, absent and navigation rows green.
  'reads-answer-any-page': {
    file: 'server/index.js',
    edits: [[
      '      if (!r.embeddable && !sameOriginBrowser(req)) {',
      '      if (!r.embeddable && false) {',
    ]],
    fails: 'the reads a cross-origin `<img>` can start, which `originAllowed` cannot see: an '
      + '`<img>` sends no Origin at all, so the header that separates it from the capture '
      + 'node is `sec-fetch-site`. Reddens the cross-origin row and leaves the same-origin, '
      + 'absent and navigation rows green',
  },

  'upgrade-skips-origin': { file: 'server/index.js', edits: [[
    `  if (!originAllowed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\\r\\nConnection: close\\r\\n\\r\\n');
    socket.destroy();
    return;
  }
`, '']] },
  'listen-any-host': { file: 'server/index.js', edits: [[
    "const HOST = flag('--host', LOOPBACK);", "const HOST = flag('--host', '0.0.0.0');"]] },
  // The scheme half, as the predicate was first written: a parsed origin host against a
  // raw Host string.
  'origin-ignores-scheme': { file: 'server/http-guard.js', edits: [[
    "  return originUrl.protocol === 'http:' && originUrl.host === hostUrl.host;",
    '  return originUrl.host === rawHost;',
  ]] },
  // The authority-shape check, which is the hole the scheme fix opened and this closed.
  'host-parsed-loosely': { file: 'server/http-guard.js', edits: [[
    '  if (/[@/?#\\s\\\\]/.test(rawHost)) return false;',
    '  if (false) return false;',
  ]] },
  // Node's parser accepts a second Host line and keeps the first, so this line is all that
  // refuses one.
  'host-accepts-a-duplicate': {
    file: 'server/http-guard.js',
    edits: [['  if (hostCount > 1) return false;', '  if (false) return false;']],
    fails: 'the duplicate-Host row alone: the server answers 101, and the single-Host twin beside '
      + 'it stays green',
  },
  // The rebinding rule reverted to comparing the two headers against each other, which a rebound
  // browser satisfies by construction. It must leave the address rows alone.
  'host-accepts-a-name': { file: 'server/http-guard.js', edits: [[
    `  const isAddress = /^\\d{1,3}(\\.\\d{1,3}){3}$/.test(hostname) || hostname.startsWith('[');
  if (!isAddress && hostname !== 'localhost' && !hostname.endsWith('.local')) return false;`,
    '  if (false) return false;',
  ]] },
  // A `file://` page and a sandboxed iframe both send the literal string `null`,
  // which is not a URL.
  'origin-allows-null': { file: 'server/http-guard.js', edits: [[
    `  } catch {
    // \`null\` is what a sandboxed iframe and a \`file://\` page send, and it is not a
    // URL. Neither is same-origin with anything.
    return false;
  }`, `  } catch {
    return true;
  }`]] },
};
if (MUTATE && !MUTATIONS[MUTATE]) {
  console.error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// Copied out of `server/` with the siblings symlinked: a mutation applied in place leaves a mutated
// working tree behind any crash.
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(join(REPO, 'server'), join(WORK, 'server'), { recursive: true });
// `effects-builtin` is in the list because the effect store refuses to boot without its shipped
// root, so a staged tree without it will not start.
for (const name of ['web', 'node_modules', 'vendor', 'captures', 'effects-builtin']) {
  const from = join(REPO, name);
  if (existsSync(from)) symlinkSync(from, join(WORK, name));
}
if (MUTATE) {
  const spec = MUTATIONS[MUTATE];
  const path = join(WORK, spec.file);
  let source = readFileSync(path, 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      console.error(`mutation ${MUTATE} matched ${hits} times in ${spec.file}, expected exactly 1 - refusing to run an unmutated server`);
      process.exit(2);
    }
    source = source.replace(from, to);
  }
  writeFileSync(path, source);
}

let checked = 0, failed = 0, unproven = 0;
const fired = [];
const ok = (label, pass, detail = '') => {
  checked++;
  if (!pass) { failed++; fired.push(label); }
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};

const servers = [];
const start = (args) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [join(WORK, 'server/index.js'), '--standby-after', '0', '--port', String(PORT), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servers.push(child);
  const log = [];
  const onData = (c) => {
    log.push(c.toString());
    if (log.join('').includes('viewer on')) setTimeout(() => resolve(() => log.join('')), 150);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  setTimeout(() => reject(new Error(`server never came up:\n${log.join('')}`)), 15000);
});
const stopAll = () => { for (const c of servers) c.kill('SIGKILL'); servers.length = 0; };

// A WebSocket upgrade carrying whatever Origin we choose; `null` means send no header at all.
const upgrade = (origin, path = '/') => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}${path}`, origin === null ? {} : { headers: { Origin: origin } });
  const done = (r) => { try { ws.terminate(); } catch { /* already gone */ } resolve(r); };
  ws.on('open', () => done('open'));
  ws.on('unexpected-response', (_req, res) => done(`refused ${res.statusCode}`));
  ws.on('error', (e) => done(`error ${e.message}`));
  setTimeout(() => done('timeout'), 5000);
});

// An upgrade carrying a chosen Host as well: a row varying only one of them tests
// half the predicate.
const upgradeWithHost = (origin, host) => new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/`, { headers: { Origin: origin, Host: host } });
  const done = (r) => { try { ws.terminate(); } catch { /* already gone */ } resolve(r); };
  ws.on('open', () => done('open'));
  ws.on('unexpected-response', (_req, res) => done(`refused ${res.statusCode}`));
  ws.on('error', (e) => done(`error ${e.message}`));
  setTimeout(() => done('timeout'), 5000);
});

// A hand-built upgrade writing one Host line per entry, which the `ws` client cannot send twice.
// Resolves the status line, or `timeout` or `error`, and a row names the status it wants.
const rawUpgrade = (hosts) => new Promise((resolve) => {
  const s = new Socket();
  let seen = '';
  const done = (r) => { s.destroy(); resolve(r); };
  s.setTimeout(5000);
  s.once('timeout', () => done('timeout'));
  s.once('error', (e) => done(`error ${e.message}`));
  s.on('data', (c) => {
    seen += c.toString();
    if (seen.includes('\r\n')) done(seen.split('\r\n')[0]);
  });
  s.connect(PORT, '127.0.0.1', () => {
    s.write([
      'GET / HTTP/1.1',
      ...hosts.map((h) => `Host: ${h}`),
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + Buffer.from('0123456789abcdef').toString('base64'),
      'Sec-WebSocket-Version: 13',
      'Origin: http://127.0.0.1:' + PORT,
      '', '',
    ].join('\r\n'));
  });
});

const reachable = (host) => new Promise((resolve) => {
  const s = new Socket();
  const done = (r) => { s.destroy(); resolve(r); };
  s.setTimeout(3000);
  s.once('connect', () => done(true));
  s.once('timeout', () => done(false));
  s.once('error', () => done(false));
  s.connect(PORT, host);
});

const LAN = Object.values(networkInterfaces()).flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? null;
const SAMPLE = join(REPO, 'captures', 'sample.knct');
// The take id the server lists that capture under - the same derivation `server/capture.js` makes.
const SAMPLE_ID = 'sample';

let crashed = null;
try {
  console.log(`[guard] ${MUTATE ? `MUTATED: ${MUTATE} (${MUTATIONS[MUTATE].file})` : 'unmutated tree'}`);
  console.log(`[guard] lan address ${LAN ?? '(none - the bind rows cannot be tested here)'}\n`);

  console.log('[guard] the socket is held to the same origin rule the mutating routes are');
  await start(['--replay', SAMPLE]);
  ok('a page on this server may open the viewer socket', await upgrade(`http://127.0.0.1:${PORT}`) === 'open');
  ok('a page somewhere else may not, and WebSocket has no preflight to stop it first',
    await upgrade('http://evil.example') === 'refused 403');
  ok('a `file://` page or sandboxed iframe sending literal `null` is refused too',
    await upgrade('null') === 'refused 403');
  ok('a request with no Origin still opens, which is what every capture-node fetch is',
    await upgrade(null) === 'open');
  ok('the export socket is behind the same answer, not just the viewer one',
    await upgrade('http://evil.example', '/export') === 'refused 403');
  ok('and an unknown socket path is still a 404 rather than a 403, so the guard did not swallow the router',
    await upgrade(`http://127.0.0.1:${PORT}`, '/nope') === 'refused 404');

  // An origin is a scheme, a host and a port, and comparing a parsed host against a raw header
  // compared one of the three. These rows send spellings, not values.
  ok('an https origin is not this http server, even though the host and port match exactly',
    await upgrade(`https://127.0.0.1:${PORT}`) === 'refused 403');
  ok('and neither is a ws: or wss: origin, which is the same hole spelled differently',
    await upgrade(`wss://127.0.0.1:${PORT}`) === 'refused 403');
  // The other direction: a refusal this strict would break the product, so canonicalising
  // cases must open.
  const hostVariants = await Promise.all([
    upgradeWithHost(`http://127.0.0.1:${PORT}`, `127.0.0.1:${PORT}`),
    upgradeWithHost('http://localhost', 'localhost:80'),
    upgradeWithHost('http://LOCALHOST', 'localhost'),
  ]);
  ok('while spellings of one authority still open - a default port written out, and a host in capitals',
    hostVariants.every((r) => r === 'open'), hostVariants.join(', '));
  // A Host header is an authority and nothing else, and `new URL('http://' + host)` consumes
  // userinfo, a path, a query or a fragment and normalises what is left. One row per spelling, so
  // a control that reddens one names the spelling that reached the predicate.
  const malformed = [
    ['userinfo', `evil.example@127.0.0.1:${PORT}`],
    ['a path', `127.0.0.1:${PORT}/path`],
    ['a query', `127.0.0.1:${PORT}?q`],
    ['a fragment', `127.0.0.1:${PORT}#f`],
  ];
  const malformedAnswers = await Promise.all(
    malformed.map(([, host]) => upgradeWithHost(`http://127.0.0.1:${PORT}`, host)));
  malformed.forEach(([carries, host], i) => ok(
    `a Host carrying ${carries} is refused by the guard - it is an authority or it is not a Host`,
    malformedAnswers[i] === 'refused 403', `${host} -> ${malformedAnswers[i]}`));
  const single = await rawUpgrade([`127.0.0.1:${PORT}`]);
  ok('a hand-built upgrade with one Host opens, so the request the next row sends is one this server accepts',
    /^HTTP\/1\.1 101/.test(single), single.slice(0, 40));
  const dup = await rawUpgrade([`127.0.0.1:${PORT}`, 'evil.example']);
  ok('and the same upgrade with a second Host is refused by the guard - `req.headers.host` keeps only the first, so the one checked is not necessarily the one anything downstream believes',
    /^HTTP\/1\.1 403/.test(dup), dup.slice(0, 40));

  // Host equality alone cannot survive DNS rebinding: the attacker re-resolves a name they control
  // onto this address, so both headers carry it. These rows are about loopback
  // rather than `--host`.
  const rebound = await Promise.all([
    upgradeWithHost(`http://evil.example.com:${PORT}`, `evil.example.com:${PORT}`),
    upgradeWithHost('http://evil.example.com', 'evil.example.com'),
    upgradeWithHost(`http://sub.attacker.test:${PORT}`, `sub.attacker.test:${PORT}`),
  ]);
  ok('a Host that is a name the attacker could have pointed here does not upgrade, however exactly the Origin agrees with it - agreement is what rebinding manufactures',
    rebound.every((r) => r !== 'open'), rebound.join(', '));

  // The positive twin: a guard refusing every authority would pass the row above and break every
  // way this program is reached.
  const stillReachable = await Promise.all([
    upgradeWithHost(`http://127.0.0.1:${PORT}`, `127.0.0.1:${PORT}`),
    upgradeWithHost(`http://[::1]:${PORT}`, `[::1]:${PORT}`),
    upgradeWithHost(`http://localhost:${PORT}`, `localhost:${PORT}`),
    upgradeWithHost(`http://capture-node.local:${PORT}`, `capture-node.local:${PORT}`),
    ...(LAN ? [upgradeWithHost(`http://${LAN}:${PORT}`, `${LAN}:${PORT}`)] : []),
  ]);
  ok('while an address literal, IPv6 loopback, `localhost` and an mDNS name all still open - the rule discriminates by the kind of authority, and a guard that refused everything would fail here rather than pass quietly',
    stillReachable.every((r) => r === 'open'), stillReachable.join(', '));

  // The reads, and the header that is the only thing able to tell them apart: a cross-origin
  // `<img>` sends no `Origin` at all, and several of these reads are expensive. `sec-fetch-site` is
  // set by the browser and cannot be set by a page, so absent must pass or the peer
  // link stops working.
  const read = (site, path = `/capture/${SAMPLE_ID}/hello`) => fetch(`http://127.0.0.1:${PORT}${path}`, {
    headers: site === null ? {} : { 'sec-fetch-site': site },
  }).then((r) => r.status).catch(() => 'threw');
  const sameOrigin = await read('same-origin');
  const absent = await read(null);
  ok('a read from the page this server served is answered, which is every read the product makes',
    sameOrigin === 200, `same-origin -> ${sameOrigin}`);
  ok('and one with no fetch metadata at all is answered too - that is the capture node, the render worker and curl, and refusing it would take the link off',
    absent === 200, `absent -> ${absent}`);
  const crossSite = await read('cross-site');
  const sameSite = await read('same-site');
  ok('while a read a page on another origin started is refused, which is the `<img src=…/capture/…/file>` an operator only has to visit a page to run',
    crossSite === 403 && sameSite === 403, `cross-site -> ${crossSite}, same-site -> ${sameSite}`);
  const navigation = await read('none');
  ok('and a top-level navigation is not refused, because typing the URL is not an attack and OBS opening a browser source is one of these',
    navigation === 200, `none -> ${navigation}`);
  // Route-by-route would close the six that were found; the table's default is what
  // closes the seventh.
  const expensive = await Promise.all([
    read('cross-site', `/capture/${SAMPLE_ID}/extent?near=0.5&far=6`),
    read('cross-site', '/library/all'),
    read('cross-site', `/capture/${SAMPLE_ID}/index`),
  ]);
  ok('every read is refused by default rather than the ones somebody thought of, so a route added later is asked by existing',
    expensive.every((r) => r === 403), expensive.join(', '));
  const webcam = await read('cross-site', '/camera.mjpg');
  ok('and the one route that declares itself embeddable still answers, because it exists to be consumed by another program',
    webcam !== 403, `camera.mjpg -> ${webcam}`);

  console.log('\n[guard] nothing is on the network unless somebody typed a flag');
  ok('the server is up on loopback', await reachable('127.0.0.1'));
  if (LAN) {
    ok('and is NOT reachable on this machine\'s own LAN address by default', (await reachable(LAN)) === false, LAN);
  } else {
    unproven++;
    console.log(`  UNPROVEN  no non-internal IPv4 on this machine, so "not on the network" has no second address to mean anything`);
  }
  stopAll();

  const log = await start(['--replay', SAMPLE, '--host', '0.0.0.0']);
  ok('--host widens it, so a capture node is still reachable from the Mac', LAN ? await reachable(LAN) : true, LAN ?? 'loopback only');
  ok('and it says so on stdout rather than widening quietly', /reachable from the network/.test(log()));
  ok('the origin guard is unchanged by widening - the bind is not the thing protecting the socket',
    await upgrade('http://evil.example') === 'refused 403');
} catch (err) {
  // Apart from the assertions: counted as a failed one, a crash reads under --mutate as a catch.
  crashed = err;
} finally {
  stopAll();
  rmSync(WORK, { recursive: true, force: true });
}

if (crashed) {
  console.log(`\n[guard] DID NOT RUN - ${crashed.message}`);
  console.log(`[guard] ${checked} assertions ran, ${failed} failed before the crash`);
  if (fired.length) console.log(`[guard] rows that had already fired: ${fired.join('; ')}`);
  process.exit(2);
}

console.log(`\n[guard] ${checked} assertions, ${failed} failed${unproven ? `, ${unproven} unproven` : ''}`);
if (MUTATE) {
if (MUTATIONS[MUTATE]?.fails) console.log(`[guard] it should redden: ${MUTATIONS[MUTATE].fails}`);
  // Exit code alone cannot tell "the mutation was caught" from "the tool crashed before asserting".
  if (failed === 0) { console.log('[guard] NOT CAUGHT - the check passed a server it should have rejected'); process.exit(1); }
  console.log(`[guard] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  process.exit(1);
}
if (failed) { console.log('[guard] FAIL'); process.exit(1); }
if (unproven) { console.log('[guard] PASS, with claims untested here'); process.exit(2); }
console.log('[guard] PASS');
process.exit(0);
