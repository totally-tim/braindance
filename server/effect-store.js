// The effect packages on disk, read the way the preset store reads documents: a shipped root and
// a user root over it, the user's copy shadowing the shipped one by id. Install writes only into
// the user root, so there is always a shipped package to fall back to. What lands is what
// `server/effect-door.js` passed, and the same door is asked again at every start - see
// `refuseIncompatiblePackages`.

import { createHash } from 'node:crypto';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { MAX_EFFECT_ID, doorRefusal, forkRefusal } from './effect-door.js';

// The same shape `VALID_ID` enforces for takes, restated for effect ids and package file names:
// an id is the namespace prefix a parameter carries, so nothing in it can read as a path.
const VALID_EFFECT_ID = /^[a-z][a-z0-9]*$/;
const VALID_FILE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export class EffectStore {
  // The builtin root and the spines are demanded at construction: a server booting without its
  // shipped effects would answer `/effects` with a list that reads as "nothing installed", and the
  // boot gate below runs the assembler against the spines, so a gate that cannot ask is
  // worse than no gate.
  constructor(dir, builtinDir, spines) {
    if (!existsSync(builtinDir) || !statSync(builtinDir).isDirectory()) {
      throw new Error(`the shipped effect directory ${builtinDir} does not exist - `
        + 'this build cannot serve a build without its builtin effects, so it refuses to boot '
        + 'rather than answer an empty list that reads as nothing installed');
    }
    if (!spines || typeof spines !== 'object' || Object.keys(spines).length === 0) {
      throw new Error('the effect store is constructed with the spines this build assembles from - '
        + 'they are what the install door runs the assembler against, so a store without them could '
        + 'not re-ask that door of the packages already on disk, and a boot gate that cannot ask is '
        + 'one nothing may be written as though it had');
    }
    this.dir = dir;
    this.builtinDir = builtinDir;
    this.spines = spines;
    // How many times this store has changed, which is the one thing a revision cannot say: a rev
    // is a hash of bytes, so a change and its undo produce identical revisions on both sides, and
    // a page whose read straddled that pair assembled chunks from both packages.
    this.generation = 0;
  }

  // The two things this store does *to* its user root, run once and only by the process that will
  // serve out of it. Both calls rename directories, and at construction they ran in every process
  // that got that far, including one about to die on EADDRINUSE - so the port is the lock and this
  // is called from inside `listen`'s callback, where everything below is synchronous `fs`.
  claimUserRoot() {
    this.recoverInterruptedInstalls();
    // After the recovery: a package it puts back is one this gate has to ask about. Neither moves
    // the generation, because both run before anything can read this store.
    this.refuseIncompatiblePackages();
  }

  /**
   * Every persisted user package asked the install door again, against *this* build, and whatever
   * it now refuses renamed aside rather than served. One gate asked twice rather than a second
   * gate: `doorRefusal` and `forkRefusal` are what `PUT /effects/:id` runs, and an aside carries a
   * dot, which `VALID_EFFECT_ID` makes invisible to every read.
   *
   * Pass one asides anything `packageOf` cannot read, so a corpse cannot throw while the door is
   * asked about an innocent package. Pass two asks one candidate at a time against what has
   * already been validated, repeating while it is still promoting anybody - a package may
   * legitimately read another's varying, and one lexical sweep would refuse what the door accepts.
   * A promotion is allowed only if the resulting set still stands.
   */
  refuseIncompatiblePackages() {
    // Pass one has no rule about the length of a name: a directory longer than `MAX_EFFECT_ID` is
    // refused by the door below under the door's own sentence.
    const readable = [];
    for (const id of this.idsIn(this.dir)) {
      try {
        const userManifest = join(this.dir, id, 'manifest.json');
        if (!existsSync(userManifest) || !lstatSync(userManifest).isFile()) {
          throw new Error(`effect ${id} at ${join(this.dir, id)} has no manifest.json - a package without its manifest is not a package`);
        }
        readable.push(this.packageOf(id));
      } catch (err) {
        this.setAside(id, `it cannot be read as a package at all: ${err.message}`);
      }
    }

    // Every pass below walks a set built out of the user root, so a machine with no
    // forks stops here.
    if (!readable.length) return;

    // Read from the shipped root by name: `packageOf` resolves through `rootFor`, which would hand
    // back the unvalidated neighbour shadowing the builtin this pass refuses to trust.
    const builtins = new Map(this.idsIn(this.builtinDir).map((id) => [id, this.builtin(id)]));

    // What one member of a standing set is doored against: everything else in it,
    // in `list()` order.
    const besideIn = (standing, id) => [...standing.values()]
      .filter((p) => p.id !== id)
      .sort((a, b) => (a.id < b.id ? -1 : 1));

    // This build's own packages asked of each other, with no fork in the room. Anything refused
    // here is a fault in the build, or the first fork on such a machine is quarantined for it.
    const bornRefused = new Set();
    for (const [id, pkg] of builtins) {
      const refusal = doorRefusal(pkg, { beside: besideIn(builtins, id), spines: this.spines });
      if (!refusal) continue;
      bornRefused.add(pkg);
      console.warn(`effect ${id} is shipped with this build and this build's own install door refuses it: `
        + `${refusal} - nothing here can set a builtin aside, so it goes on being served; what this line `
        + 'exists for is that a fork standing beside it must not be quarantined in its place');
    }

    const survivors = new Map();
    const refusals = new Map();
    let pending = readable;
    let promoted = true;
    while (promoted && pending.length) {
      promoted = false;
      const stillPending = [];
      for (const candidate of pending) {
        // The candidate's own id goes entirely, because the question is what the build looks like
        // with it *in place of* whatever holds that id. Sorted by id, since a stage concatenates
        // its chunks in the order the packages arrive.
        const standing = new Map([...builtins, ...survivors]);
        standing.delete(candidate.id);
        const beside = [...standing.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
        const shadowed = builtins.get(candidate.id) ?? null;
        let refusal;
        try {
          refusal = doorRefusal(candidate, { beside, spines: this.spines })
            ?? (shadowed ? forkRefusal(candidate, shadowed) : null);
        } catch (err) {
          refusal = `the install door threw on this package: ${err.message}`;
        }
        // The other direction: everything above asks whether the candidate works beside the set,
        // this asks whether the set still works beside the candidate.
        if (!refusal) {
          const resulting = new Map([...builtins, ...survivors]);
          resulting.set(candidate.id, candidate);
          for (const id of [...resulting.keys()].sort()) {
            const member = resulting.get(id);
            if (member === candidate || bornRefused.has(member)) continue;
            let broke;
            try {
              broke = doorRefusal(member, { beside: besideIn(resulting, id), spines: this.spines });
            } catch (err) {
              broke = `the install door threw on ${id}: ${err.message}`;
            }
            if (!broke) continue;
            refusal = `with it installed this build can no longer assemble ${id}: ${broke}. Nothing is `
              + `wrong with ${id} on its own - it stood a moment ago and stands again once ${candidate.id} `
              + 'is out of the way, so the package being set aside is the one that changed';
            break;
          }
        }
        if (refusal) {
          refusals.set(candidate.id, refusal);
          stillPending.push(candidate);
          continue;
        }
        survivors.set(candidate.id, candidate);
        promoted = true;
      }
      pending = stillPending;
    }
    for (const candidate of pending) this.setAside(candidate.id, refusals.get(candidate.id));
  }

  /**
   * One package set aside on a client's word, with the generation moved to match - the whole of
   * what this adds over `setAside`, which the boot gate calls directly because it runs before the
   * socket has dispatched a request. Three outcomes rather than a boolean: `absent` is what a
   * builtin looks like from here, `stuck` would not move.
   */
  setAsideForClient(id, reason) {
    if (!this.idsIn(this.dir).includes(id)) return 'absent';
    if (!this.setAside(id, reason)) return 'stuck';
    this.generation += 1;
    return 'aside';
  }

  setAside(id, refusal) {
    const stem = id.slice(0, MAX_EFFECT_ID);
    const seq = `${process.pid}.${Date.now().toString(36)}`;
    let lastErr = null;
    for (let bump = 0; bump < 16; bump++) {
      const aside = join(this.dir, `${stem}.${seq}${bump ? `.${bump}` : ''}.incompatible`);
      if (existsSync(aside)) continue;
      try {
        renameSync(join(this.dir, id), aside);
      } catch (err) {
        lastErr = err;
        if (err.code === 'EEXIST' || err.code === 'ENOTEMPTY') continue;
        break;
      }
      console.warn(`effect ${id} was installed by an earlier build of this program and this one refuses it: `
        + `${refusal} - the package has been renamed to ${basename(aside)} rather than deleted, so it is still `
        + `there to be repaired and moved back, and ${existsSync(join(this.builtinDir, id))
          ? 'the shipped package answers for that id again'
          : 'nothing answers for that id now, so a document holding its values parks them'}`);
      return true;
    }
    console.warn(`effect ${id} was installed by an earlier build of this program and this one refuses it: `
      + `${refusal} - and it could not be renamed out of the way either: ${lastErr?.message ?? 'every name this store tried was taken'}. `
      + 'It is still where it was and this server is still serving it, because a build that comes up with a package '
      + 'it has said it cannot use is one somebody can read this line on. Move the directory by hand');
    return false;
  }

  /**
   * The one window in `install` where a crash loses a package: between swapping the old copy aside
   * and swapping the new one in, the id resolves to nothing. A `.old` whose live id is missing is
   * by construction a crashed install, because `remove` names its aside `.gone`.
   */
  recoverInterruptedInstalls() {
    if (!existsSync(this.dir)) return;
    const asides = new Map();
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith('.old')) continue;
      const id = entry.name.slice(0, entry.name.indexOf('.'));
      if (!VALID_EFFECT_ID.test(id) || existsSync(join(this.dir, id))) continue;
      if (!asides.has(id)) asides.set(id, []);
      asides.get(id).push(entry.name);
    }
    for (const [id, names] of asides) {
      // The newest, because a machine that crashed twice left two and the second was live.
      const newest = names
        .map((name) => ({ name, at: statSync(join(this.dir, name)).mtimeMs }))
        .sort((a, b) => (b.at - a.at) || (a.name < b.name ? 1 : -1))[0].name;
      renameSync(join(this.dir, newest), join(this.dir, id));
      console.warn(`effect ${id} was left with no installed copy and ${newest} beside it - `
        + 'an install was interrupted between swapping the old package aside and swapping the new one in, '
        + 'and the old package has been put back');
    }
  }

  /** The ids one root holds: every directory whose name is a valid effect id. */
  idsIn(root) {
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && VALID_EFFECT_ID.test(e.name))
      .map((e) => e.name)
      .sort();
  }

  /** Where one id resolves from: the user's copy wins, then the builtin, then null. */
  rootFor(id) {
    if (!VALID_EFFECT_ID.test(id)) return null;
    // A real directory and not a link to one: `idsIn` already drops a link, and resolving by name
    // here would answer for a package that is in no listing. Require `manifest.json` so a
    // half-created folder in the user root does not crash `list()` or shadow a shipped package.
    const real = (path) => existsSync(path) && lstatSync(path).isDirectory()
      && existsSync(join(path, 'manifest.json')) && lstatSync(join(path, 'manifest.json')).isFile();
    if (real(join(this.dir, id))) return { root: this.dir, builtin: false };
    if (real(join(this.builtinDir, id))) return { root: this.builtinDir, builtin: true };
    return null;
  }

  /** One package, whole. Never a re-serialisation, because provenance is about bytes. */
  read(id) {
    const where = this.rootFor(id);
    if (!where) return null;
    const dir = join(where.root, id);
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && VALID_FILE_NAME.test(e.name))
      .map((e) => e.name)
      .sort();
    if (!names.includes('manifest.json')) {
      return null;
    }
    let manifestBytes = null;
    const files = names.map((name) => {
      const bytes = readFileSync(join(dir, name));
      if (name === 'manifest.json') manifestBytes = bytes;
      return { name, rev: `sha256:${sha256(bytes)}` };
    });
    const rev = `sha256:${sha256(files.map((f) => `${f.name} ${f.rev}\n`).join(''))}`;
    let manifest;
    try {
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch (err) {
      throw new Error(`effect ${id}'s manifest.json does not parse: ${err.message}`);
    }
    if (manifest.id !== id) {
      throw new Error(`effect ${id}'s manifest declares id ${JSON.stringify(manifest.id)} - `
        + 'the directory name is the namespace parameters carry, so the two disagreeing means '
        + 'one of them is wrong and this store cannot know which');
    }
    return { id, manifest, files, rev, builtin: where.builtin };
  }

  /**
   * Read whole so the answer carries revisions. Shadowing is stated per entry: which root answered
   * is the difference between the shipped effect and a fork.
   */
  list() {
    const ids = [...new Set([...this.idsIn(this.builtinDir), ...this.idsIn(this.dir)])].sort();
    const out = [];
    for (const id of ids) {
      const pkg = this.read(id);
      if (!pkg && VALID_EFFECT_ID.test(id)) continue;
      const { manifest, files, rev, builtin } = pkg;
      out.push({ id, version: manifest.version, title: manifest.title, rev, builtin, files });
    }
    return out;
  }

  /**
   * One file's bytes, or null. `lstat` and not `stat`: `statSync` follows a symlink, so a link
   * planted in the user root - the one directory a client can write into - answered `isFile()` for
   * whatever it aimed at and this route served it.
   */
  file(id, name) {
    if (!VALID_FILE_NAME.test(name)) return null;
    const where = this.rootFor(id);
    if (!where) return null;
    const path = join(where.root, id, name);
    if (!existsSync(path) || !lstatSync(path).isFile()) return null;
    return readFileSync(path);
  }

  /**
   * The one read that skips the user root, because a fork has to be held against what it forks.
   */
  builtin(id) {
    if (!VALID_EFFECT_ID.test(id) || !existsSync(join(this.builtinDir, id))) return null;
    const dir = join(this.builtinDir, id);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    const chunks = {};
    for (const c of manifest.chunks ?? []) chunks[c.file] = readFileSync(join(dir, c.file), 'utf8');
    return { id, manifest, chunks };
  }

  /** `except` drops one id, or the old package would be assembled beside the new one. */
  loaded(except = null) {
    return this.list()
      .filter((e) => e.id !== except)
      .map((e) => this.packageOf(e.id));
  }

  /**
   * The chunk map is built from what the manifest names: off disk an undeclared file is one to
   * leave alone, where on the way in it is a stale copy somebody sent.
   */
  packageOf(id) {
    const { manifest } = this.read(id);
    const chunks = {};
    for (const c of manifest.chunks ?? []) {
      const bytes = this.file(id, c.file);
      // `file` answers null for a name that is not an ordinary file. Named, because a door that
      // crashed would refuse nothing.
      if (!bytes) {
        throw new Error(`effect ${id} names the chunk ${JSON.stringify(c.file)} and there is no ordinary `
          + 'file of that name in its directory - a package file is what the install door wrote, and a link '
          + 'or a directory standing in for one is not something this store will read');
      }
      chunks[c.file] = bytes.toString('utf8');
    }
    return { id, manifest, chunks };
  }

  /**
   * A package into the user root, atomically: no reader ever sees a directory that is neither the
   * old package nor the new one. Build under a name no reader resolves, swap the old one aside,
   * swap the new one in - the temporary names carry dots, which `idsIn` and `rootFor` refuse.
   */
  install(id, manifest, chunks) {
    if (!VALID_EFFECT_ID.test(id)) throw new Error(`${JSON.stringify(id)} is not an effect id`);
    mkdirSync(this.dir, { recursive: true });
    this.sweepTemporaries(id);
    const seq = `${process.pid}.${Date.now().toString(36)}`;
    const tmp = join(this.dir, `${id}.${seq}.tmp`);
    const aside = join(this.dir, `${id}.${seq}.old`);
    const live = join(this.dir, id);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp);
    try {
      // Written from the object, because `read` parses this file and the door checked the object.
      writeFileSync(join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      for (const [name, text] of Object.entries(chunks)) {
        if (!VALID_FILE_NAME.test(name)) throw new Error(`${JSON.stringify(name)} is not a package file name`);
        writeFileSync(join(tmp, name), text);
      }
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    let replaced = false;
    try { lstatSync(live); replaced = true; } catch { /* absent */ }
    if (replaced) renameSync(live, aside);
    try {
      renameSync(tmp, live);
    } catch (err) {
      // The one window worth unwinding: the new copy did not go in, so the old one goes back
      // rather than leaving the id resolving to nothing.
      if (replaced) renameSync(aside, live);
      rmSync(tmp, { recursive: true, force: true });
      throw err;
    }
    if (replaced) rmSync(aside, { recursive: true, force: true });
    // Bumped after the swap, so the number a reader sees never claims a change that has not landed.
    this.generation += 1;
    return { ...this.read(id), replaced };
  }

  /**
   * Only ever the user's copy, so deleting a fork restores the shipped package. A builtin with no
   * fork is refused by name, because "nothing of yours to remove" is a different answer.
   */
  remove(id) {
    if (!VALID_EFFECT_ID.test(id)) return { error: `${JSON.stringify(id)} is not an effect id`, status: 400 };
    const mine = join(this.dir, id);
    let mineHere = false;
    try { lstatSync(mine); mineHere = true; } catch { /* absent */ }
    if (!mineHere) {
      if (existsSync(join(this.builtinDir, id))) {
        return {
          error: `effect ${id} is shipped with this build and nothing is forking it - `
            + 'a builtin is what an install falls back to, so removing one would leave an id that '
            + 'this build can never answer again',
          status: 409,
        };
      }
      return { error: `no effect ${id} here - GET /effects lists what is installed`, status: 404 };
    }
    this.sweepTemporaries(id);
    const seq = `${process.pid}.${Date.now().toString(36)}`;
    // `.gone` and not `.old`: `recoverInterruptedInstalls` puts a `.old` back when its live id is
    // missing, which is exactly the state a crash here leaves.
    const aside = join(this.dir, `${id}.${seq}.gone`);
    renameSync(mine, aside);
    rmSync(aside, { recursive: true, force: true });
    // The id stops resolving at the rename above, so the generation moves with it.
    this.generation += 1;
    return { removed: id, restored: existsSync(join(this.builtinDir, id)) };
  }

  /**
   * Swept before the next install starts. `.old` is swept only while the live directory is there,
   * because a `.old` with nothing at its live id is the last copy of that package.
   */
  sweepTemporaries(id) {
    if (!existsSync(this.dir)) return;
    const liveHere = existsSync(join(this.dir, id));
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (!entry.name.startsWith(`${id}.`)) continue;
      if (!/\.(tmp|old|gone)$/.test(entry.name)) continue;
      if (entry.name.endsWith('.old') && !liveHere) continue;
      rmSync(join(this.dir, entry.name), { recursive: true, force: true });
    }
  }
}
