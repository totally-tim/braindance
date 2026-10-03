// Every document kind's version comes from the one table in web/format.js, so a literal anywhere in
// shipped source is a second number that can disagree with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DOCUMENT_VERSIONS, versionRefusal } from '../web/format.js';
import { DocumentStore } from '../server/library.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SHIPPED = ['server', 'web', 'bin'];

async function sourceFiles() {
  const files = [];
  for (const top of SHIPPED) {
    for (const entry of await readdir(join(REPO, top), { recursive: true, withFileTypes: true })) {
      if (entry.isFile() && /\.m?js$/.test(entry.name)) files.push(join(entry.parentPath, entry.name));
    }
  }
  return files;
}

// The arguments of every `new DocumentStore(...)`, split at the commas of its own parentheses.
function storeCalls(text) {
  const calls = [];
  for (let at = text.indexOf('new DocumentStore('); at >= 0; at = text.indexOf('new DocumentStore(', at + 1)) {
    const args = [];
    let depth = 0;
    let quote = null;
    let current = '';
    for (let i = at + 'new DocumentStore('.length; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === quote && text[i - 1] !== '\\') quote = null;
      } else if (c === "'" || c === '"' || c === '`') {
        quote = c;
      } else if (c === '(' || c === '[' || c === '{') {
        depth++;
      } else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) { args.push(current.trim()); break; }
        depth--;
      } else if (c === ',' && depth === 0) {
        args.push(current.trim());
        current = '';
        continue;
      }
      current += c;
    }
    calls.push({ line: text.slice(0, at).split('\n').length, args: args.filter(Boolean) });
  }
  return calls;
}

const constantNames = Object.keys(DOCUMENT_VERSIONS).map((kind) => `${kind.toUpperCase()}_VERSION`);
// Whole-file patterns, because `\s` spans a line break and a literal split across lines is the same literal.
const LITERALS = [
  { what: 'a version key holding a number', re: /\bversion\s*:\s*-?\d/g },
  { what: 'a version compared with a number', re: /\.version\s*[!=]==?\s*-?\d|-?\d+\s*[!=]==?\s*[\w.?]*\.version\b/g },
  { what: 'a per-kind version constant', re: new RegExp(`\\b(?:${constantNames.join('|')})\\s*=\\s*-?\\d`, 'g') },
];

/** Every document version literal in one source text, by line. */
function literalsIn(name, text) {
  const found = [];
  for (const { what, re } of LITERALS) {
    for (const m of text.matchAll(re)) {
      found.push(`${name}:${text.slice(0, m.index).split('\n').length} ${what}: ${m[0].replace(/\s+/g, ' ')}`);
    }
  }
  for (const { line, args } of storeCalls(text)) {
    if (args.some((arg) => /^-?\d+$/.test(arg))) found.push(`${name}:${line} a DocumentStore given a numeric version: ${args.join(', ')}`);
    const kind = /^'([a-z]+)'$/.exec(args[1] ?? '')?.[1];
    if (!Object.hasOwn(DOCUMENT_VERSIONS, kind ?? '')) found.push(`${name}:${line} a DocumentStore whose kind is not a table entry: ${args[1]}`);
  }
  return found;
}

test('the table names each document kind once, at a positive integer', () => {
  assert.deepEqual(Object.keys(DOCUMENT_VERSIONS).sort(), ['deliverable', 'preset', 'project']);
  for (const [kind, version] of Object.entries(DOCUMENT_VERSIONS)) {
    assert.ok(Number.isInteger(version) && version > 0, `${kind} is version ${version}`);
  }
  assert.ok(Object.isFrozen(DOCUMENT_VERSIONS));
});

test('each kind\'s store and refusal read that kind\'s entry, and an undeclared kind is refused', async () => {
  const root = await mkdtemp(join(tmpdir(), 'document-versions-'));
  try {
    for (const [kind, version] of Object.entries(DOCUMENT_VERSIONS)) {
      assert.equal(new DocumentStore(join(root, kind), kind).version, version, kind);
      const older = versionRefusal(kind, version - 1);
      assert.match(older, new RegExp(`^this ${kind} is version ${version - 1} and this build reads version ${version}:`));
      assert.match(versionRefusal(kind, version + 1), /later build/);
    }
    assert.throws(() => new DocumentStore(join(root, 'job'), 'job'), /no document version/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('no shipped source writes or compares a document version as a literal', async () => {
  const found = [];
  for (const file of await sourceFiles()) found.push(...literalsIn(relative(REPO, file), await readFile(file, 'utf8')));
  assert.deepEqual(found, []);
});

test('the scan sees a literal split across lines, in the real serialiser and in a comparison', async () => {
  const main = await readFile(join(REPO, 'web/main.js'), 'utf8');
  const stamp = '    version: DOCUMENT_VERSIONS.project,\n';
  assert.equal(main.split(stamp).length, 2, 'the project serialiser stamps the table entry once');
  assert.equal(literalsIn('web/main.js', main.replace(stamp, '    version:\n      9,\n')).length, 1);
  assert.equal(literalsIn('snippet', 'if (deliverable.version\n  !== 2) refuse();').length, 1);
  assert.equal(literalsIn('snippet', 'const DELIVERABLE_VERSION =\n  2;').length, 1);
  assert.equal(literalsIn('snippet', "new DocumentStore(dir,\n  'deliverable',\n  2)").length, 1);
});

test('the shipped presets carry the preset entry', async () => {
  const dir = join(REPO, 'presets-builtin');
  const names = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  assert.ok(names.length > 0);
  for (const f of names) {
    const { version } = JSON.parse(await readFile(join(dir, f), 'utf8'));
    assert.equal(version, DOCUMENT_VERSIONS.preset, f);
  }
});
