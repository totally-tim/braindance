#!/usr/bin/env node
// Installing an effect: the store's revisions, the door a package has to get through, and what
// happens on a page that is already up when one lands. The failure this whole surface is built
// around is a page that will not boot - a package is GLSL spliced into two programs and a table of
// parameters spliced into the registry, both assembled while `web/main.js` is still evaluating, so
// a package that does not assemble fails the *next* page load rather than its own install,
// publishing no `globalThis.__kinect` and leaving every tool in the suite reporting DID NOT RUN.
//
//   node tools/effect-check.mjs
//
// It spawns its own server and needs none running: a GPU browser, a free port 8281, no capture, no
// sensor, no ffmpeg. `docs/proof-tools.md` carries every `--mutate` control it must fail under.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const at = argv.indexOf(name);
  return at === -1 ? fallback : argv[at + 1];
};
const PORT = Number(flag('--port', '8281'));
const MUTATE = argv.includes('--mutate') ? flag('--mutate') : null;
const WORK = join(REPO, '.effect-check');
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Each mutation is a way of doing this feature that would look correct, and names source text that
 * must match exactly once. `docs/proof-tools.md` says what each one does.
 */
const MUTATIONS = {
  'temporaries-are-visible': {
    file: 'server/effect-store.js',
    edits: [[
      '.filter((e) => e.isDirectory() && VALID_EFFECT_ID.test(e.name))',
      '.filter((e) => e.isDirectory())',
    ]],
    fails: 'the id filter the store lists directories through, widened, so a crashed install\'s '
      + '`<id>.<seq>.tmp` becomes a package `/effects` lists and `rootFor` resolves. Reddens '
      + '**six** rows, measured: the two of section 10 that are about a half-written package, '
      + 'section 12\'s page-boot row, and section 14\'s three, which need a page that came '
      + 'up. Section 10 is late for the reason those first two are the ones it is *about* - '
      + 'staged earlier it would redden every section after it with a fault five sections '
      + 'away. **It reddened two and ended early at 110 before this round**, measured in a '
      + 'detached worktree at `5d8cd33` with the unmutated control green at 119/0 there: the '
      + 'mutated store\'s gate ran in the constructor and the server never came up at section '
      + '11\'s restart, so a third of the tool was never put to that build. Running the gate '
      + 'after the bind, and a `setAside` that logs a rename it cannot make instead of '
      + 'throwing, is what turned a truncated run into four more measured rows',
  },
  'rebuild-skips-the-panel': {
    file: 'web/main.js',
    edits: [['\n  buildPanel();\n', '\n  if (!panelControls.size) buildPanel();\n']],
    fails: 'the panel built on the first run and never again, which is the rebuild somebody '
      + 'writes who thinks of the panel as boot furniture. `boot-check` stays green, because '
      + 'boot is the run that builds it; six rows redden, one in section 3 and the rest '
      + 'across 7, 8 and 9 - everything downstream of a panel that is not the registry',
  },
  'install-skips-the-uniform-cells': {
    file: 'web/main.js',
    edits: [[
      "    table[bind.uniform] = {\n"
        + "      value: effectBindUniformType(bind.transform) === 'vec2' ? new THREE.Vector2() : 0,\n"
        + '    };',
      '    if (Object.hasOwn(table, bind.uniform)) table[bind.uniform] = { value: 0 };',
    ]],
    fails: 'the JavaScript cell a new binding needs, never minted. No shipped package notices - '
      + 'every one of the sixteen binds a uniform some hand-written table already holds - and '
      + 'a seventeenth throws inside the value walk. Reddens six rows of section 3 and ends '
      + 'the run early; the count is a floor',
  },
  'reinstall-leaves-it-parked': {
    file: 'web/main.js',
    edits: [[
      '  return id !== null && !effectInstalled(id);',
      '  return id !== null;',
    ]],
    fails: 'the parking predicate widened to every dotted name, so a value belonging to an '
      + 'installed effect parks anyway. The badge still appears on the uninstall, which is '
      + 'what makes it worth having: nine rows redden, four across sections 4 and 5 and five '
      + 'more in section 6, and the badge-appeared row stays green. The document it leaves '
      + 'behind is one the loader refuses in both directions, so section 6\'s rebuild reddens '
      + 'on the rollback\'s own refusal rather than on the install\'s. **It ends the run '
      + 'early and always has**, which this line did not say: the document it leaves behind '
      + 'makes section 7\'s first unguarded `reload()` throw. Measured 2026-08-24 at both '
      + 'ends of this round\'s changes - 52 of the 91 assertions the tool had at `4b63f80`, '
      + 'and 55 of 111 now, nine red either way. The count is a floor and the tool says so',
  },
  'rollback-keeps-the-new-registry': {
    file: 'web/main.js',
    edits: [[
      '      adoptEffectPackages(heldPackages, heldPrograms, held);',
      '      adoptEffectPackages(fetched, programs, held);',
    ]],
    fails: 'the rollback runs the loader again and runs it against the packages that just '
      + 'arrived rather than the ones this page had - the half-rollback somebody writes who '
      + 'reads the failure as being about the document. Reddens six rows: four in section 6 - '
      + 'the sentence, the registry\'s contents, the signature, and what a save writes - and '
      + 'the two rollbacks of section 9. The picture cannot see it, because the parameter the '
      + 'fork adds is inert at its default and the image is identical either way, which is '
      + 'why a pixel row is not enough to hold this. **Ten now, measured 2026-08-24**: the '
      + 'four extra are the two blocks at the end of section 9, which are second rollback '
      + 'fixtures and go red with the first. Six at `4b63f80`, so the four are this round\'s '
      + 'and the line above was right about its own tree',
  },

  'rebuild-remakes-the-buttons': {
    file: 'web/main.js',
    edits: [
      ["    before: panelOnce(() => [\n      panelButtonRow(['camSensor', 'sensor view']),",
        "    before: () => [\n      panelButtonRow(['camSensor', 'sensor view']),"],
      ["      panelButtonRow(['camLevelReset', 'reset rotation']),\n    ]),\n    after: panelOnce(() => [",
        "      panelButtonRow(['camLevelReset', 'reset rotation']),\n    ],\n    after: () => ["],
      ["      panelNote('recRange', 'preview only'),\n    ]),", "      panelNote('recRange', 'preview only'),\n    ],"],
    ],
    fails: 'the memo taken off the two closures that emit the framing group\'s hand-written '
      + 'rows, so every rebuild makes fresh buttons carrying the right ids and none of the '
      + 'wiring. Reddens three rows of section 7: the control pressed and the node the status '
      + 'was written into carry the claim, and the precondition above them goes red because '
      + 'the status write it builds the fixture out of is the very thing the mutation stops '
      + 'landing',
  },

  'rebuild-forgets-the-tab': {
    file: 'web/main.js',
    edits: [['\n  hideOffTab();\n\n', '\n\n']],
    fails: 'the showing tab not re-applied to the groups the generator has just made, so one '
      + 'install puts every tab\'s groups on screen at once. Reddens one row of section 7',
  },

  'rebuild-keeps-the-paint': {
    file: 'web/main.js',
    edits: [['\n  groupPainted.clear();', '']],
    fails: '`groupPainted` left holding state strings written against elements the rebuild threw '
      + 'away, so a group whose values did not move is skipped by the first refresh and comes '
      + 'back open with no `aria-expanded`. Reddens two rows of section 7: the claim, and the '
      + 'precondition above it, which is the group the mutation prevents from being shut in '
      + 'the first place. Measured 2026-08-24; one run also reddened section 8\'s '
      + 'read-across-two-revisions row and a re-run on the same tree did not, so that one is '
      + 'the intermittent that row\'s own poll is about rather than a cascade',
  },

  'rebuild-keeps-the-picker': {
    file: 'web/main.js',
    edits: [['\n  buildPresetPicker();\n}', '\n  if (!presetPickBoxes.size) buildPresetPicker();\n}']],
    fails: 'the preset subset dialog built once and never again. An installed effect gets no '
      + 'checkbox and an uninstalled one leaves a box whose handler reads `PARAMS` for a name '
      + 'that is gone. Reddens two rows of section 7, one per direction',
  },

  'gates-are-frozen-at-boot': {
    file: 'web/main.js',
    edits: [['  PASS_GATES = passGatesOf(packages);\n', '  PASS_GATES ??= passGatesOf(packages);\n']],
    fails: 'the grade gate list computed once, off the packages installed while the module '
      + 'evaluated. All sixteen shipped effects are in it, so nothing about them notices; a '
      + 'grade effect installed afterwards writes into a pass that stays shut. Reddens one '
      + 'row of section 8',
  },

  'every-reload-warms': {
    file: 'web/main.js',
    edits: [['    if (!sameProgram) warmPrograms();', '    warmPrograms();']],
    fails: 'the warm run whether or not the programs moved, so a package that changed only its '
      + 'manifest clears the accumulators a page mid-playback is holding. Reddens one row of '
      + 'section 8, and the control beside it stays green because that one must warm',
  },

  'swap-keeps-the-old-program': {
    file: 'web/point-cloud.js',
    edits: [[
      '  if (material.vertexShader === program.vertexShader\n'
      + '    && material.fragmentShader === program.fragmentShader) return;\n'
      + '  material.dispose();\n',
      '',
    ]],
    fails: 'the program swap put back to `needsUpdate` alone. Three releases a program only from '
      + 'a material\'s `dispose` event, so every GLSL-changing install leaves one linked and '
      + 'cached. Reddens one row of section 8',
  },

  'poll-checks-once': {
    file: 'web/main.js',
    edits: [[
      '  const blocked = effectRebuildBlocked();\n  if (blocked) return null;',
      '  const blocked = null;\n  if (blocked) return null;',
    ]],
    fails: 'the stand-down asked on the way into the tick and never again, so a rebuild lands '
      + 'inside a gesture that opened while it was reading. Reddens one row of section 8',
  },

  'requested-reload-skips-the-poll-lock': {
    file: 'web/main.js',
    edits: [['    reload: requestEffectReload,', '    reload: reloadEffects,']],
    fails: 'the rebuild exposed to an installer no longer waits for the periodic poll to release '
      + 'the effect set. Reddens one row of section 8: with the poll\'s listing held open, the '
      + 'requested rebuild starts a second listing instead of waiting',
  },

  /**
   * The whole statement is anchored rather than its first line: the throw is a marked one, and
   * swapping only the first line leaves a live call to the minter standing under a `void`.
   */
  'a-broken-shader-is-warm': {
    file: 'web/main.js',
    edits: [[
      "    throw shaderLinkFailure(\n"
      + "      `this build's shaders did not compile after the effects changed - ${linkFailures[0]}`,\n"
      + '      linkFailures[0],\n'
      + '    );',
      '    console.warn(`shaders did not compile: ${linkFailures[0]}`);',
    ]],
    fails: 'the throw dropped from the end of the warm, leaving a link failure where three.js '
      + 'puts it: a console line. The install succeeds, the poll announces success, and the '
      + 'cloud draws nothing. Reddens **six** rows, measured, all in section 9: the two the '
      + 'mutation is about - the rebuild reporting success and the broken line reaching the '
      + 'assembled program - and the four under them, which are the quarantine not happening '
      + 'because there is no longer a link failure to mark',
  },

  /** Aimed at the `if (bind.gates)` guarding both halves, so one mutation takes the whole rule. */
  'door-takes-a-gates-nothing-reads': {
    file: 'server/effect-door.js',
    edits: [[
      '    if (bind.gates) {\n      if (!EFFECT_GATED_TABLES',
      '    if (false) {\n      if (!EFFECT_GATED_TABLES',
    ]],
  },

  /**
   * Reddens four rows, measured, all in section 9, and the third is the point: the fresh page comes
   * back with no `__kinect` published, which a build that called the route and did
   * nothing would not.
   */
  'a-link-failure-is-not-quarantined': {
    file: 'web/main.js',
    edits: [[
      '  const setAside = failure?.shaderLinkFailure\n'
      + '    ? await setAsideUnlinkable(heldPackages, fetched, failure.linkLog)\n'
      + '    : null;',
      '  const setAside = null;',
    ]],
    fails: 'the throw and its mark left exactly where they are and the one call that acts on '
      + 'them dropped, which is the build this replaced. The page still refuses the package, '
      + 'still rolls back and still says which shader did not compile - and the package sits '
      + 'in the store afterwards, so the next browser to open compiles it at boot, outside '
      + 'any transaction, and dies there. Reddens **four** rows, measured, all in section 9, '
      + 'and the third is the point: the fresh page comes back `no __kinect published`',
  },

  /**
   * Reddens three rows, measured, and only the first is the finding - section 6's, where a package
   * nothing is wrong with is renamed aside for a fault in a clip. The other two are section 9's
   * fixture count seeing a second `probe.*.incompatible`.
   */
  'any-failure-is-quarantined': {
    file: 'web/main.js',
    edits: [[
      '  const setAside = failure?.shaderLinkFailure\n',
      '  const setAside = failure\n',
    ]],
    fails: 'the mark test dropped and the call kept, so every failure the rollback catches '
      + 'reaches the refusal route. This is the direction the fix does damage in rather than '
      + 'merely fails in, and the page reads correctly through all of it - the refusal is '
      + 'right, the sentence is right, the rollback is right, and a package nothing is wrong '
      + 'with has been renamed out of the way behind them. Reddens **three** rows, measured, '
      + 'and only the first is a finding: section 6 asks the store whether the fork the '
      + 'completeness rule refused is still installed, and it answers 404. The two under it '
      + 'are section 9\'s aside count seeing two where it expects one',
  },

  'adopt-outside-the-transaction': {
    file: 'web/main.js',
    edits: [
      ['  let failure = null;\n  try {',
        '  adoptEffectPackages(fetched, programs, held);\n  let failure = null;\n  try {'],
      ['    adoptEffectPackages(fetched, programs, held);\n', ''],
    ],
    fails: 'the adoption put back outside the `try` the rollback hangs off, so a throw out of '
      + 'the adoption itself - a package written into the store past the door, naming a panel '
      + 'group nothing holds - walks past it and leaves a registry with no panel drawn from '
      + 'it. Reddens one row of section 9',
  },

  'the-sweep-eats-the-last-copy': {
    file: 'server/effect-store.js',
    edits: [
      ["      if (entry.name.endsWith('.old') && !liveHere) continue;\n", ''],
      ['    this.recoverInterruptedInstalls();\n', ''],
    ],
    fails: 'the sweep removing every aside it finds and the recovery pass removed with it, so a '
      + 'crash between an install\'s two renames loses the package to the next install of '
      + 'that id. Reddens **three** rows of section 11, measured 2026-08-24 at `4b63f80` as '
      + 'well as here: the copy that does not come back, the aside left beside nothing, and '
      + 'the uninstall row under them, which needs a package to have been there to remove. '
      + 'This line said two for as long as nobody had counted',
  },

  'package-files-follow-links': {
    file: 'server/effect-store.js',
    edits: [['    if (!existsSync(path) || !lstatSync(path).isFile()) return null;',
      '    if (!existsSync(path) || !statSync(path).isFile()) return null;']],
    fails: '`statSync` back where `lstatSync` is, so the file route asks what a name points at '
      + 'rather than what it is. Reddens one row of section 10, and the ordinary file beside '
      + 'it stays green',
  },

  'poll-takes-any-body': {
    file: 'web/main.js',
    edits: [
      ['  if (!body || !Array.isArray(body.effects) || !Number.isFinite(body.generation)) {', '  if (body === undefined) {'],
      ['  for (const entry of body.effects) {', '  for (const entry of body.effects ?? []) {'],
    ],
    fails: '`GET /effects` no longer held to the shape its readers assume, so a 200 carrying '
      + 'anything else reaches the signature comparison and throws out of the interval '
      + 'callback. Reddens one row of section 8. Two edits, because defusing the array check '
      + 'alone leaves the entry loop throwing inside the poll\'s own catch - which is '
      + 'handled, so the mutation reproduced nothing and the run came back NOT CAUGHT',
  },

  'poll-guards-late': {
    file: 'web/main.js',
    edits: [
      ['  if (effectReloading || effectRebuildBlocked()) return;\n  effectReloading = true;\n  try {',
        '  if (effectReloading || effectRebuildBlocked()) return;\n  try {'],
      ['    if (listedSignature === refusedEffectSignature) return;\n    await pollRebuild(listedSignature);',
        '    if (listedSignature === refusedEffectSignature) return;\n    effectReloading = true;\n    await pollRebuild(listedSignature);'],
    ],
    fails: 'the reentrancy guard raised after the list comes back rather than on the way in, so '
      + 'two ticks overlap and the older read can win. Reddens one row of section 8',
  },

  'reads-need-not-agree': {
    file: 'web/main.js',
    edits: [['    if (closed.generation === opened.generation && revSignature(closed.effects) === revSignature(opened.effects)) return packages;',
      '    if (opened) return packages;']],
    fails: 'the verification read taken off the end of the package fetch, so a set read across '
      + 'an install is one package from before it beside another from after. Reddens **two** '
      + 'rows of section 8, measured 2026-08-24: it takes the whole comparison out, so both '
      + 'the moved-revision row and the generation row below it go. This line read "one row" '
      + 'for as long as there was one term to remove',
  },

  /**
   * A separate spec rather than a second edit of `reads-need-not-agree`: only this half sees a
   * change that is undone, where every rev in both listings is identical across the window.
   */
  'list-reads-need-not-agree-on-generation': {
    file: 'web/main.js',
    edits: [['    if (closed.generation === opened.generation && revSignature(closed.effects) === revSignature(opened.effects)) return packages;',
      '    if (revSignature(closed.effects) === revSignature(opened.effects)) return packages;']],
    fails: 'the generation term dropped from that same comparison, leaving the contents term it '
      + 'had before. A revision is a hash of bytes, so a change that is *undone* hashes back '
      + 'to what it was: a fork installed and deleted again restores the shipped package, and '
      + 'both listings are then identical across a window the page read some of its chunks '
      + 'out of. Its own spec rather than a second edit of the row above, because no '
      + 'comparison and the wrong comparison fail differently. Reddens one row of section 8',
  },

  'package-read-need-not-match-the-list': {
    file: 'web/main.js',
    edits: [['    if (pkg?.rev !== rev) {', '    if (false) {']],
    fails: 'and the same window one request further in, where neither listing can reach: a '
      + 'package answering for a revision the list did not name hands this page that '
      + 'package\'s manifest and file index out of the other revision. Reddens one row of '
      + 'section 8',
  },

  'door-takes-any-expansion': {
    file: 'server/effect-door.js',
    edits: [['  if (expandedBytes > MAX_PACKAGE_BYTES) {', '  if (false) {']],
    fails: 'the bound on how much text a manifest asks to have spliced, leaving the two that '
      + 'count what it carries. A file counts once in each of those and once per descriptor '
      + 'in the assembler, so the two numbers come apart without limit. Reddens two rows of '
      + 'section 2 - the refusal and the residue, because the package now lands on disk - and '
      + 'the sweep after them is what keeps it to two rather than carrying a sixty-file '
      + 'fixture into every section below',
  },

  'seeding-skips-existing-cells': {
    file: 'web/main.js',
    edits: [['    if (uniformCellFits(table[bind.uniform], bind)) continue;',
      '    if (Object.hasOwn(table, bind.uniform)) continue;']],
    fails: 'the uniform seeding back to minting only what is missing, so a cell whose binding '
      + 'changed shape keeps the shape from the build before. Reddens four rows at the end of '
      + 'section 9 and the run still finishes: the rollback dies inside the table it is '
      + 'rolling back through and prints the reload-the-page sentence, `probeShapeAxis is a '
      + 'number` where the registry demands a vector, and three values are left parked by a '
      + 'page that never got its document back',
  },

  'departed-uniforms-keep-their-value': {
    file: 'web/main.js',
    edits: [['  restoreDepartedUniforms(wasBound, boundUniforms(EFFECT_PARAMS));',
      '  void wasBound;']],
    fails: 'a uniform the registry has stopped binding left holding whatever the slider last put '
      + 'there. Nothing else ever writes those cells and the chunk reading it does not stop, '
      + 'so the term runs on with no control anywhere that can move it. Reddens three rows of '
      + 'section 8, and the third is the one worth reading: with every control back at its '
      + 'default the picture is the one the raised term drew, hash for hash. The first is the '
      + 'grade gate\'s uninstall row',
  },

  'poll-retries-a-refused-set': {
    file: 'web/main.js',
    edits: [['    if (listedSignature === refusedEffectSignature) return;\n', '']],
    fails: 'the block on a set this page has already failed to adopt. A rollback puts the old '
      + 'signature back on purpose, so the tick\'s own comparison goes on saying the store '
      + 'has moved and the same rebuild is attempted every six seconds forever - every '
      + 'package refetched, both programs reassembled, the material disposed, the '
      + 'accumulators reset. Reddens two rows, measured: the one at the end of section 9 and '
      + 'section 14\'s, which is the same block asked about a shape refusal rather than an '
      + 'assembly one',
  },

  /**
   * Only the read-error pair at the end of section 9 may redden; a genuine refusal is
   * still remembered.
   */
  'every-failure-is-final': {
    file: 'web/main.js',
    edits: [[
      '    if (err.effectRefusal) refusedEffectSignature = listedSignature;',
      '    refusedEffectSignature = listedSignature;',
    ]],
    fails: 'the block on a refused set put back on *every* way a rebuild can fail, which is how '
      + 'it shipped: a refusal and a read error are the same three lines from the poll\'s '
      + 'side, so one server restart between the listing and a package fetch blocked a '
      + 'revision that was never anything but good until something else moved the store. '
      + 'Reddens **one** row, measured - the read error\'s "next tick adopts it" - and leaves '
      + 'the two refusal rows beside it green, which is what makes the pair a discrimination '
      + 'rather than two rows about one thing. `poll-retries-a-refused-set` is its mirror and '
      + 'fires the other row, measured, so the two terms separate exactly',
  },

  /**
   * Aimed at the call rather than at the method body, so the gate is still there and simply is not
   * asked. Section 12's last row is the one that matters - the four before it are about a store.
   */
  'boot-adopts-a-stale-fork': {
    file: 'server/effect-store.js',
    edits: [['    this.refuseIncompatiblePackages();', '    void this.refuseIncompatiblePackages;']],
    fails: 'the store\'s boot gate never asked, which is every build before it existed: a '
      + 'package that got through the door once is served forever, whatever this build\'s '
      + 'spines have done since, so a fork naming a joint an upgrade removed goes on '
      + 'shadowing the builtin it forks. Aimed at the call rather than at the method body, '
      + 'because the defect was that nothing re-validated rather than that something '
      + 'validated wrongly. Reddens **ten** rows, measured: seven in section 12 and the three '
      + 'of section 14, which need a page that came up. The staging row stays green and so '
      + 'does the must-accept row - a gate that never ran serves the healthy fork too, which '
      + 'is what makes that row a control for over-refusal rather than for this. The one the '
      + 'finding is about is the page: it publishes no `__kinect` at all, because '
      + '`assembleShaders` throws while `web/main.js` is still evaluating',
  },

  /**
   * Section 12's must-accept pair must redden - the healthy fork of `rain` quarantined for its
   * neighbour's joint. Everything else there stays green.
   */
  'the-gate-doors-a-package-against-its-neighbours': {
    file: 'server/effect-store.js',
    edits: [[
      '        const standing = new Map([...builtins, ...survivors]);\n'
      + '        standing.delete(candidate.id);\n'
      + '        const beside = [...standing.values()].sort((a, b) => (a.id < b.id ? -1 : 1));',
      '        const beside = this.loaded(candidate.id);',
    ]],
    fails: 'the boot gate\'s second pass back to asking the door about each candidate with every '
      + 'other package beside it, checked or not, which is how it shipped. The door assembles '
      + '`[...beside, candidate]` and reports what fails under the *candidate\'s* name, so '
      + 'one fork this build cannot assemble made its innocent neighbours come back "does not '
      + 'assemble" - and which was blamed depended on the lexical order the walk reached them '
      + 'in. Reddens **two** rows, measured: the healthy fork staged beside the broken one, '
      + 'and the count of what is left standing. Every other row of section 12 stays green, '
      + 'because a store that quarantines too much still hands the id back to the builtin and '
      + 'still boots',
  },

  /** The call in `listen` still stands, so only the last row of section 13 may redden. */
  'the-gate-runs-before-the-bind': {
    file: 'server/effect-store.js',
    edits: [['    this.generation = 0;\n  }', '    this.generation = 0;\n    this.claimUserRoot();\n  }']],
    fails: 'the recovery and the gate back at construction, which is where they were: every '
      + 'process that got as far as building a store ran them, including one about to die on '
      + '`EADDRINUSE` over a root another server was already serving. The call in `listen` is '
      + 'left standing, so the winner still gates once and nothing else moves. Reddens '
      + '**one** row, measured - section 13\'s last - and the two before it stay green, '
      + 'because the loser still loses the bind and still exits either way',
  },

  /**
   * Section 12's over-long directory row must redden. The server still comes up, because the rename
   * is caught, which is why that row reads both ends of the name.
   */
  'the-aside-keeps-the-whole-name': {
    file: 'server/effect-store.js',
    edits: [['    const stem = id.slice(0, MAX_EFFECT_ID);', '    const stem = id;']],
    fails: 'the truncation dropped from the stem an aside is built from, which is how it shipped '
      + 'when nothing bounded an id\'s length. `NAME_MAX` is 255 and the suffix is about '
      + 'thirty characters, so a directory from that build cannot be renamed at all. Reddens '
      + '**two** rows, measured: the over-long directory and the count of what is left '
      + 'standing. The server still comes up, which is the other half of the repair - the '
      + 'rename is caught and the package left where it is. **The fixture is 240 characters '
      + 'and the first one was 100**, which proved nothing: 100 renames to 128 and lands '
      + 'inside the 255 a filesystem takes, so the mutated build renamed it perfectly well '
      + 'and the row stayed green on a build with the defect in it. A fixture has to sit '
      + 'outside the bound it is about',
  },

  /**
   * Aimed at the frame rather than at a throw site, because the frame is where all three shape
   * refusals pass. Section 14's second row is the one that matters.
   */
  'a-refused-body-is-a-failed-read': {
    file: 'web/main.js',
    edits: [[
      '    const framed = `the installed effects changed and this page could not read them: ${err.message}`;\n'
      + '    throw err.effectRefusal ? effectRefusal(framed) : new Error(framed);',
      '    throw new Error(`the installed effects changed and this page could not read them: ${err.message}`);',
    ]],
    fails: 'the frame that erases the refusal mark on its way out of the fetch. Every '
      + 'deterministic shape refusal a read can make - a listing that is not a list, a '
      + 'manifest that is not an object, a `chunks` that arrived as a string - is minted as a '
      + 'refusal at its throw site, and a plain `new Error` at that frame threw the '
      + 'classification away, so the set the store is serving was refetched whole every six '
      + 'seconds forever. Aimed at the frame rather than at a throw site, because every one '
      + 'of them passes through it. Reddens **one** row, measured: section 14\'s second. The '
      + 'first stays green, because both builds refuse the package - what differs is whether '
      + 'they go on asking',
  },

  /**
   * Reddens five rows, measured: four in section 15, the last of them the finding, plus a cascade
   * into 16, which drives the refusal route against a store 15 was meant to have cleaned up.
   */
  'the-gate-never-re-asks-the-set': {
    file: 'server/effect-store.js',
    edits: [[
      '        if (!refusal) {\n          const resulting = new Map([...builtins, ...survivors]);',
      '        if (false) {\n          const resulting = new Map([...builtins, ...survivors]);',
    ]],
  },

  /**
   * Aimed at the refusal rather than at the reading that finds the dimension. Reddens one row,
   * measured, and the residue row beside it stays green.
   */
  'door-takes-an-array-binding': {
    file: 'server/effect-door.js',
    edits: [['    if (arrayed.length) {', '    if (false) {']],
  },

  /**
   * Reddens two rows of section 2, measured - the refusal and the residue, since the package lands.
   */
  'hostdriven-takes-any-name': {
    file: 'server/effect-door.js',
    edits: [['    if (!HOST_DRIVEN_UNIFORMS.includes(u)) {', '    if (false) {']],
  },

  /**
   * Reddens two rows of section 2, measured - the refusal and the residue, since the package lands.
   */
  'door-takes-any-manifest': {
    file: 'server/effect-door.js',
    edits: [['  if (manifestBytes > MAX_MANIFEST_BYTES) {', '  if (false) {']],
  },

  /**
   * Reddens one row of section 16 and leaves three green. Anchored on the assignment beside the
   * rename, which keeps it distinct from `store-generation-never-moves`'s two edits.
   */
  'a-refusal-moves-no-generation': {
    file: 'server/effect-store.js',
    edits: [[
      "    if (!this.setAside(id, reason)) return 'stuck';\n    this.generation += 1;",
      "    if (!this.setAside(id, reason)) return 'stuck';",
    ]],
  },

  'store-generation-never-moves': {
    file: 'server/effect-store.js',
    edits: [
      ['    this.generation += 1;\n    return { ...this.read(id), replaced };',
        '    return { ...this.read(id), replaced };'],
      ['    this.generation += 1;\n    return { removed: id, restored: existsSync(join(this.builtinDir, id)) };',
        '    return { removed: id, restored: existsSync(join(this.builtinDir, id)) };'],
    ],
    fails: 'the store no longer counting its own changes, which is the control neither '
      + 'client-side mutation above can be: the arm that drives them fabricates a moved '
      + 'generation in an interception, so a store that never moved the number would satisfy '
      + 'every one of them while the coherent read compared equal numbers forever. Reddens '
      + 'the two rows of section 2 that read it off the real store, and must leave section '
      + '8\'s arm green - the two measure opposite ends of one wire',
  },
};

if (argv.includes('--mutate') && !MUTATIONS[MUTATE]) {
  console.log(`[effect] DID NOT RUN - no mutation named ${MUTATE ?? '(nothing was given)'};`
    + ` this tool knows ${Object.keys(MUTATIONS).join(', ')}`);
  process.exit(2);
}

// A mutation applied in place and restored afterwards leaves a mutated tree behind any crash, so
// `server/`, `web/` and `effects-builtin/` are copied rather than linked. Both store roots are
// handed to the server by name: this is the only tool that writes packages.
const portHeld = await new Promise((resolve) => {
  const probe = spawn('lsof', ['-ti', `tcp:${PORT}`, '-sTCP:LISTEN'], { stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  probe.stdout.on('data', (c) => { out += c; });
  probe.on('close', () => resolve(out.trim()));
  probe.on('error', () => resolve(''));
});
if (portHeld) {
  console.log(`[effect] DID NOT RUN - something is already listening on ${PORT} (pid ${portHeld.split('\n').join(', ')}). `
    + 'A run answered by a stranger asserts against whatever that process staged.');
  process.exit(2);
}

// `native/` is deliberately absent, so the server spawns no grabber and the depth textures stay
// whatever this tool plants in them - a live socket wipes a plant in well under a second.
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
for (const dir of ['server', 'tools', 'web', 'effects-builtin', 'presets-builtin']) {
  cpSync(join(REPO, dir), join(WORK, dir), { recursive: true });
}
mkdirSync(join(WORK, 'effects'), { recursive: true });
for (const name of ['node_modules', 'vendor']) {
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
      console.log(`[effect] DID NOT RUN - the ${MUTATE} anchor matched ${hits} times in ${spec.file}, `
        + 'expected exactly 1, so nothing was mutated and this run would prove nothing');
      process.exit(2);
    }
    source = source.replace(from, to);
  }
  writeFileSync(path, source);
}

const USER_ROOT = join(WORK, 'effects');
const BUILTIN_ROOT = join(WORK, 'effects-builtin');

let checked = 0;
let failed = 0;
let crashed = null;
let untested = null;
const fired = [];
const ok = (label, pass, detail = '') => {
  checked++;
  if (!pass) { failed++; fired.push(label); }
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const servers = [];
// What the last start said, kept where a row can read it: the store's boot gate announces a
// package it refused, and that announcement is half of what section 12 asserts. Reset per start.
let serverLog = '';
const start = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    join(WORK, 'server/index.js'), '--port', String(PORT),
    '--effects', USER_ROOT, '--builtin-effects', BUILTIN_ROOT,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  servers.push(child);
  const log = [];
  serverLog = '';
  const onData = (c) => {
    log.push(c.toString());
    serverLog = log.join('');
    if (log.join('').includes('viewer on')) setTimeout(resolve, 200);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  setTimeout(() => reject(new Error(`server never came up:\n${log.join('')}`)), 15000);
});
const stopAll = async () => {
  for (const c of servers) c.kill('SIGKILL');
  servers.length = 0;
  await wait(150);
};

const getJson = async (path) => {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, body: await res.json() };
};
const put = async (id, body) => {
  const res = await fetch(`${BASE}/effects/${encodeURIComponent(id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};
const del = async (id) => {
  const res = await fetch(`${BASE}/effects/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
  });
  return { status: res.status, body: await res.json() };
};

/** Everything sitting in the user root, temporaries included - the residue test. */
const userRootHolds = () => (existsSync(USER_ROOT) ? readdirSync(USER_ROOT).sort() : []);

// The package this tool installs, a whole effect rather than a stub: a master inert at zero, its
// own panel group, a declaration chunk and a chunk that reaches a pixel. A fixture with parameters
// and no GLSL would leave the program swap, the minted cell and the pixel identity untested.
const probeManifest = () => ({
  format: 1,
  id: 'probe',
  version: '1.0.0',
  title: 'Probe',
  params: {
    amount: {
      def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', label: 'probe',
      panel: { group: 'probe', tab: 'look' },
      bind: { on: 'points', uniform: 'probeAmount' },
      role: 'master',
    },
    hue: {
      def: 0.5, min: 0, max: 1, step: 0.01, kind: 'scalar', label: 'probe hue',
      panel: { group: 'probe', tab: 'look' },
      bind: { on: 'points', uniform: 'probeHue' },
      under: 'amount',
    },
  },
  panelGroups: [
    { key: 'probe', label: 'Probe', tab: 'look', lookgroup: true, collapses: true, after: 'post', order: 900 },
  ],
  chunks: [
    { stage: 'f.decl', order: 900, file: 'decl.frag.glsl' },
    { stage: 'f.tone', order: 900, file: 'tone.frag.glsl' },
  ],
});
const probeChunks = () => ({
  'decl.frag.glsl': 'uniform float probeAmount, probeHue;\n',
  'tone.frag.glsl':
    '  if (probeAmount > 0.0) {\n'
    + '    col = mix(col, vec3(probeHue, 1.0 - probeHue, probeHue * 0.5), probeAmount);\n'
    + '  }\n',
});
const probePackage = () => ({ manifest: probeManifest(), chunks: probeChunks() });

/**
 * The same effect with one parameter more - the install a page holding this effect's values cannot
 * be carried onto, since a document names every parameter of every effect it touches. The added
 * parameter reaches a pixel and is inert at its default, so the rollback's image is comparable.
 */
const forkedProbe = () => {
  const pkg = probePackage();
  pkg.manifest.version = '2.0.0';
  pkg.manifest.params.glow = {
    def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', label: 'probe glow',
    panel: { group: 'probe', tab: 'look' },
    bind: { on: 'points', uniform: 'probeGlow' },
    under: 'amount',
  };
  pkg.chunks['decl.frag.glsl'] = 'uniform float probeAmount, probeHue, probeGlow;\n';
  pkg.chunks['tone.frag.glsl'] =
    '  if (probeAmount > 0.0) {\n'
    + '    col = mix(col, vec3(probeHue, 1.0 - probeHue, probeHue * 0.5), probeAmount);\n'
    + '    col += vec3(probeGlow * 0.25);\n'
    + '  }\n';
  return pkg;
};
const bent = (edit) => {
  const pkg = probePackage();
  edit(pkg);
  return pkg;
};

/**
 * A package holding one uniform cell of each shape there is, and the fork that swaps them: a
 * binding writes either a bare number or, under `axisDeg`, `.value.set(sin, cos)`. Its own id and
 * uniform names, because section 7 primes state on top of what is left.
 */
const shapedProbe = () => ({
  manifest: {
    format: 1,
    id: 'probeshape',
    version: '1.0.0',
    title: 'Probe Shape',
    params: {
      amount: {
        def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', label: 'probe shape',
        panel: { group: 'post', tab: 'look' },
        bind: { on: 'points', uniform: 'probeShapeAmount' },
        role: 'master',
      },
      angle: {
        def: 0, min: 0, max: 360, step: 1, kind: 'scalar', label: 'probe shape angle',
        panel: { group: 'post', tab: 'look' },
        bind: { on: 'points', uniform: 'probeShapeAxis', transform: 'axisDeg' },
        under: 'amount',
      },
      tone: {
        def: 0.5, min: 0, max: 1, step: 0.01, kind: 'scalar', label: 'probe shape tone',
        panel: { group: 'post', tab: 'look' },
        bind: { on: 'points', uniform: 'probeShapeTone' },
        under: 'amount',
      },
    },
    chunks: [
      { stage: 'f.decl', order: 910, file: 'decl.frag.glsl' },
      { stage: 'f.tone', order: 910, file: 'tone.frag.glsl' },
    ],
  },
  chunks: {
    'decl.frag.glsl': 'uniform float probeShapeAmount, probeShapeTone;\nuniform vec2 probeShapeAxis;\n',
    'tone.frag.glsl':
      '  if (probeShapeAmount > 0.0) {\n'
      + '    col = mix(col, vec3(probeShapeTone, probeShapeAxis.x, probeShapeAxis.y), probeShapeAmount);\n'
      + '  }\n',
  },
});

/**
 * The same package with its two shapes exchanged and a parameter added. The swap corrupts the table
 * mid-walk; the added `glow` is what makes the fixed build reach the rollback at all. Both uniforms
 * are redeclared at the type their new binding writes, or the door refuses the pairing.
 */
const reshapedProbe = () => {
  const pkg = shapedProbe();
  const p = pkg.manifest;
  p.version = '2.0.0';
  delete p.params.angle.bind.transform;
  Object.assign(p.params.angle, { min: 0, max: 1, step: 0.01, def: 0 });
  p.params.tone.bind.transform = 'axisDeg';
  Object.assign(p.params.tone, { min: 0, max: 360, step: 1, def: 0 });
  p.params.glow = {
    def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', label: 'probe shape glow',
    panel: { group: 'post', tab: 'look' },
    bind: { on: 'points', uniform: 'probeShapeGlow' },
    under: 'amount',
  };
  pkg.chunks['decl.frag.glsl'] = 'uniform float probeShapeAmount, probeShapeAxis, probeShapeGlow;\nuniform vec2 probeShapeTone;\n';
  pkg.chunks['tone.frag.glsl'] =
    '  if (probeShapeAmount > 0.0) {\n'
    + '    col = mix(col, vec3(probeShapeTone.x, probeShapeAxis, probeShapeTone.y), probeShapeAmount);\n'
    + '    col += vec3(probeShapeGlow * 0.25);\n'
    + '  }\n';
  return pkg;
};

/**
 * The same package at a new version with byte-identical chunks - a rev that moves and two programs
 * that do not. What the rebuild must therefore not do is warm, because the warm
 * resets accumulators.
 */
const retunedProbe = () => {
  const pkg = probePackage();
  pkg.manifest.version = '1.0.1';
  pkg.manifest.params.hue.label = 'probe hue, retuned';
  return pkg;
};

/**
 * A third revision for an arm that needs the store to move again after `retunedProbe` has landed.
 * A label and nothing else, so the arm is about whether the page noticed, not what a warm costs.
 */
const relabelledProbe = () => {
  const pkg = probePackage();
  pkg.manifest.version = '1.0.2';
  pkg.manifest.params.hue.label = 'probe hue, once more';
  return pkg;
};

/**
 * The same package with one more line of GLSL, so the assembled programs genuinely move. `n` makes
 * each call a different program, which the row about released programs needs.
 */
const recompiledProbe = (n) => {
  const pkg = probePackage();
  pkg.manifest.version = `1.1.${n}`;
  pkg.chunks['tone.frag.glsl'] =
    '  if (probeAmount > 0.0) {\n'
    + `    col = mix(col, vec3(probeHue, 1.0 - probeHue, probeHue * ${(0.5 + n * 0.01).toFixed(2)}), probeAmount);\n`
    + '  }\n';
  return pkg;
};

/**
 * A package whose every identifier this build has and whose GLSL does not compile - the shape the
 * door cannot see and must not be asked to. Assigning a `float` to a `vec3` is a driver-time error.
 */
const brokenProbe = () => {
  const pkg = probePackage();
  pkg.manifest.version = '9.0.0';
  pkg.chunks['tone.frag.glsl'] = '  col = probeAmount;\n';
  return pkg;
};

/**
 * A grade effect, because the pass the grade runs in is gated and the gate is a list computed off
 * the packages. Its group is `post`, one of this build's own, so this is about the
 * pass not the panel.
 */
const gradeProbeManifest = () => ({
  format: 1,
  id: 'probegrade',
  version: '1.0.0',
  title: 'Probe Grade',
  params: {
    amount: {
      def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', label: 'probe grade',
      panel: { group: 'post', tab: 'look' },
      bind: { on: 'grade', uniform: 'probeGradeAmount', gates: true },
      role: 'master',
    },
  },
  chunks: [
    { stage: 'g.decl', order: 900, file: 'decl.grade.glsl' },
    { stage: 'g.body', order: 900, file: 'body.grade.glsl' },
  ],
});
const gradeProbePackage = () => ({
  manifest: gradeProbeManifest(),
  chunks: {
    'decl.grade.glsl': 'uniform float probeGradeAmount;\n',
    'body.grade.glsl': '      col *= mix(1.0, 0.5, probeGradeAmount);\n',
  },
});

/**
 * A pinned run with no capture and no sensor: the wire's own frame payload, which `drive.pin`
 * parses. Colour is left at zero bytes because a JPEG decode is asynchronous. The surface leans so
 * the picture has depth in it, and the frames differ so three track positions have three images.
 *
 * The stamps are 250ms apart rather than 33 so the run spans `POSITIONS` rather than ending
 * inside it. It used to end at 0.165s with two of the three positions past it, and the two images
 * were different only because the clock reached the shader - the frames behind them were the same
 * held pair. Past a clip's out-point the composite is now empty, so those two were the same black
 * frame and the control below said so.
 */
const DEPTH_W = 512;
const DEPTH_H = 424;
const pinnedBuffer = () => {
  const FRAMES = 6;
  const depthBytes = DEPTH_W * DEPTH_H * 2;
  const out = Buffer.alloc(FRAMES * (16 + depthBytes));
  for (let f = 0; f < FRAMES; f++) {
    const at = f * (16 + depthBytes);
    out.writeUInt32LE(depthBytes, at);
    out.writeUInt32LE(0, at + 4);
    out.writeBigUInt64LE(BigInt(f * 250), at + 8);
    for (let y = 0; y < DEPTH_H; y++) {
      for (let x = 0; x < DEPTH_W; x++) {
        // Drifting 40mm per frame, so successive frames are genuinely different geometry.
        const mm = 1200 + Math.round((x / DEPTH_W) * 900 + (y / DEPTH_H) * 500) + f * 40;
        out.writeUInt16LE(mm, at + 16 + (y * DEPTH_W + x) * 2);
      }
    }
  }
  return out;
};

const POSITIONS = [0.1, 0.6, 1.2];

console.log(`[effect] ${MUTATE ? `MUTATED: ${MUTATE} (${MUTATIONS[MUTATE].file})` : 'unmutated tree'}\n`);

let browser = null;
try {
  let chromium;
  try {
    ({ chromium } = await import(join(REPO, 'node_modules/playwright/index.mjs')));
  } catch {
    untested = 'playwright is not installed, and three of the five sections are about a page';
    throw new Error(untested);
  }

  await start();

  console.log('[effect] 1. the store\'s revisions, and a half-written package');

  const listed = await getJson('/effects');
  ok('the store lists the shipped packages', listed.status === 200 && listed.body.effects?.length >= 16,
    `${listed.body.effects?.length ?? 0} packages`);
  if (listed.status !== 200) throw new Error('the store would not list at all, so nothing below could be measured');

  // The oracle: hashes computed off the staged tree, the only reading independent of the thing
  // under test. A row comparing the store's rev against its own recomputation agrees with anything.
  let fileRevs = 0;
  let packageRevs = 0;
  let revMismatch = null;
  for (const entry of listed.body.effects) {
    const dir = join(BUILTIN_ROOT, entry.id);
    for (const file of entry.files) {
      const want = sha(readFileSync(join(dir, file.name)));
      if (file.rev !== want) revMismatch ??= `${entry.id}/${file.name}`;
      fileRevs++;
    }
    const want = sha(entry.files.map((f) => `${f.name} ${f.rev}\n`).join(''));
    if (entry.rev !== want) revMismatch ??= `${entry.id} (the package)`;
    packageRevs++;
  }
  ok('every file revision is the sha256 of the bytes on disk, and every package revision the hash over its file lines',
    revMismatch === null, revMismatch ? `first disagreement at ${revMismatch}` : `${fileRevs} files across ${packageRevs} packages`);

  // The control. A rev that was a name, a timestamp or a cached number would satisfy every
  // row above on a tree nobody had touched.
  const victim = join(BUILTIN_ROOT, 'thermal/heat.frag.glsl');
  const original = readFileSync(victim);
  const beforeFlip = await getJson('/effects/thermal');
  const witnessBefore = await getJson('/effects/edges');
  writeFileSync(victim, Buffer.concat([original, Buffer.from('\n')]));
  const afterFlip = await getJson('/effects/thermal');
  const witnessAfter = await getJson('/effects/edges');
  const revOf = (pkg, name) => pkg.body.files.find((f) => f.name === name)?.rev;
  ok('one byte changed on disk moves that file\'s revision',
    revOf(beforeFlip, 'heat.frag.glsl') !== revOf(afterFlip, 'heat.frag.glsl'),
    `${revOf(beforeFlip, 'heat.frag.glsl')?.slice(7, 19)} -> ${revOf(afterFlip, 'heat.frag.glsl')?.slice(7, 19)}`);
  ok('and its package\'s revision with it', beforeFlip.body.rev !== afterFlip.body.rev,
    `${beforeFlip.body.rev.slice(7, 19)} -> ${afterFlip.body.rev.slice(7, 19)}`);
  ok('and leaves every other package where it was, so a revision is about its own bytes',
    witnessBefore.body.rev === witnessAfter.body.rev, witnessAfter.body.rev.slice(7, 19));
  const genAfterFlip = (await getJson('/effects')).body.generation;
  ok('and the generation beside them does not move, because nothing this store did made that byte change',
    genAfterFlip === listed.body.generation,
    `generation ${listed.body.generation} before the flip and ${genAfterFlip} after it`);
  writeFileSync(victim, original);
  const restored = await getJson('/effects/thermal');
  ok('and putting the byte back puts the revision back', restored.body.rev === beforeFlip.body.rev,
    restored.body.rev.slice(7, 19));

  console.log('\n[effect] 2. the door, and the package that has to get through it');

  const beforeInstall = (await getJson('/effects')).body;
  const accepted = await put('probe', probePackage());
  const afterInstall = (await getJson('/effects')).body;
  ok('a well-formed package lands - the row that stops every refusal below passing on a door that refuses everything',
    accepted.status === 200 && accepted.body.id === 'probe', `answered ${accepted.status}: ${accepted.body.error ?? 'installed'}`);
  const onDisk = existsSync(join(USER_ROOT, 'probe')) ? readdirSync(join(USER_ROOT, 'probe')).sort() : [];
  ok('and its files are the ones it sent, in the user root',
    onDisk.join(',') === 'decl.frag.glsl,manifest.json,tone.frag.glsl', onDisk.join(', ') || 'nothing');
  const shadowCheck = await getJson('/effects/probe');
  ok('and the store answers for it as a user package rather than a shipped one',
    shadowCheck.status === 200 && shadowCheck.body.builtin === false, `builtin=${shadowCheck.body.builtin}`);

  await del('probe');
  const afterRemove = (await getJson('/effects')).body;
  const cleanRoot = userRootHolds();
  ok('and removing it leaves the user root empty, so the refusals below start from nothing',
    cleanRoot.length === 0, cleanRoot.join(', ') || 'empty');

  const listingSignature = (body) => (body.effects ?? []).map((e) => `${e.id} ${e.rev}`).join('\n');
  ok('an install moves the store\'s generation and so does an uninstall',
    afterInstall.generation > beforeInstall.generation && afterRemove.generation > afterInstall.generation,
    `${beforeInstall.generation} -> ${afterInstall.generation} -> ${afterRemove.generation}`);
  ok('and the pair leaves every revision exactly where it was, which is the reading the generation exists to carry',
    listingSignature(afterRemove) === listingSignature(beforeInstall)
      && afterRemove.generation !== beforeInstall.generation,
    listingSignature(afterRemove) === listingSignature(beforeInstall)
      ? `${beforeInstall.effects.length} packages hashing identically across a change and its undo, `
        + `generation ${beforeInstall.generation} against ${afterRemove.generation}`
      : 'the revisions moved, so this pair is not the change-and-undo the row is about');

  // The shipped noise, whole, for the fork row: two earlier rules stand in front of the one this
  // row is about and `noise` trips neither. Picking `rain` here produced a green row for
  // the wrong reason.
  const noiseDir = join(BUILTIN_ROOT, 'noise');
  const noiseManifest = JSON.parse(readFileSync(join(noiseDir, 'manifest.json'), 'utf8'));
  const noiseChunks = Object.fromEntries((noiseManifest.chunks ?? []).map((c) => [c.file, readFileSync(join(noiseDir, c.file), 'utf8')]));
  const forkedNoise = (edit) => {
    const manifest = JSON.parse(JSON.stringify(noiseManifest));
    edit(manifest);
    return { manifest, chunks: { ...noiseChunks } };
  };

  // One hostile package per rule, each the well-formed one with a single field wrong - a fixture
  // written to fail is a fixture that can fail for a reason nobody intended.
  const hostile = [
    ['an id nothing could be', 'Probe1', probePackage(), /is not an effect id/],
    ['a manifest declaring another id', 'probe', bent((p) => { p.manifest.id = 'other'; }), /declaring id "other"/],
    ['a package format from a later build', 'probe', bent((p) => { p.manifest.format = 2; }), /package format 2/],
    ['a package that says no format at all', 'probe', bent((p) => { delete p.manifest.format; }), /declares no package format/],
    ['a chunk name that is a path', 'probe', bent((p) => {
      p.manifest.chunks[0].file = '../escape.glsl';
      p.chunks['../escape.glsl'] = p.chunks['decl.frag.glsl'];
      delete p.chunks['decl.frag.glsl'];
    }), /"\.\.\/escape\.glsl"/],
    ['two parameters claiming the role master', 'probe', bent((p) => {
      Object.assign(p.manifest.params.hue, { role: 'master', def: 0 });
    }), /2 parameters with the role master/],
    ['a master that is not inert at its default', 'probe', bent((p) => { p.manifest.params.amount.def = 0.5; }), /master and defaults to 0\.5/],
    ['a kind this registry does not implement', 'probe', bent((p) => { p.manifest.params.hue.kind = 'ramp'; }), /kind "ramp"/],
    ['a transform the applier has never heard of', 'probe', bent((p) => { p.manifest.params.hue.bind.transform = 'toKelvin'; }), /transform "toKelvin"/],
    ['a binding whose uniform no program declares', 'probe', bent((p) => { p.manifest.params.hue.bind.uniform = 'probeHueee'; }), /declares no such uniform/],
    ['a uniform declared and bound by nothing', 'probe', bent((p) => {
      p.chunks['decl.frag.glsl'] = 'uniform float probeAmount, probeHue, probeStray;\n';
    }), /"probeStray" and binds no parameter/],
    ['a chunk naming a joint no spine holds', 'probe', bent((p) => { p.manifest.chunks[1].stage = 'f.elsewhere'; }), /does not assemble/],
    ['an identifier that exists nowhere in this build', 'probe', bent((p) => {
      p.chunks['tone.frag.glsl'] = '  col = mix(col, vec3(qqNotHere), probeAmount);\n';
    }), /"qqNotHere"/],
    ['a varying whose initial value reads state', 'probe', bent((p) => {
      p.manifest.varyings = [{ name: 'vProbe', type: 'float', init: 'probeAmount', order: 900 }];
    }), /initialises to "probeAmount"/],
    ['a chunk the manifest names and did not send', 'probe', bent((p) => { delete p.chunks['tone.frag.glsl']; }), /its text did not arrive/],
    ['a file the manifest never names', 'probe', bent((p) => { p.chunks['spare.glsl'] = '// nothing\n'; }), /"spare\.glsl" and its manifest names no chunk/],
    ['a fork of a shipped package that drops one of its parameters', 'noise', forkedNoise((m) => {
      m.version = '2.0.0';
      delete m.params.speed;
    }), /drops noise\.speed/],
    ['one joint naming one file over and over', 'probe', bent((p) => {
      for (let i = 0; i < 50; i++) p.manifest.chunks.push({ stage: 'f.tone', order: 500 + i, file: 'tone.frag.glsl' });
    }), /spliced into "f\.tone" twice/],
    ['a manifest asking for more assembled text than it carries', 'probe', bent((p) => {
      for (let i = 0; i < 60; i++) {
        p.chunks[`pad${i}.frag.glsl`] = `// ${'x'.repeat(3000)}\n`;
        p.manifest.chunks.push({ stage: 'f.tone', order: 600 + i, file: `pad${i}.frag.glsl` });
        p.manifest.chunks.push({ stage: 'f.decl', order: 600 + i, file: `pad${i}.frag.glsl` });
      }
    }), /splices \d+ bytes of chunk text/],
    ['a binding checked against the program its own table does not name', 'probe', bent((p) => {
      p.manifest.params.hue.bind.on = 'grade';
    }), /assembled grade program declares no such uniform/],
    ['a package declaring one panel group key twice', 'probe', bent((p) => {
      p.manifest.panelGroups.push({ ...p.manifest.panelGroups[0], label: 'Probe again', order: 901 });
    }), /declares the panel group "probe" twice/],
    ['a bound finer than this build\'s own rounding can write', 'probe', bent((p) => {
      p.manifest.params.hue.min = 1e-101;
    }), /declares min as 1e-101, which needs 100 decimal places/],
    ['a parameter bound to an array uniform', 'probe', bent((p) => {
      p.chunks['decl.frag.glsl'] = 'uniform float probeAmount, probeHue;\nuniform float probeWeights[4];\n';
      p.manifest.params.weights = {
        def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', label: 'probe weights',
        panel: { group: 'probe', tab: 'look' },
        bind: { on: 'points', uniform: 'probeWeights' },
        under: 'amount',
      };
    }), /no array kind/],
    ['a host-driven uniform this build\'s render loop does not write', 'probe', bent((p) => {
      p.chunks['decl.frag.glsl'] = 'uniform float probeAmount, probeHue, probeClock;\n';
      p.manifest.hostDriven = ['probeClock'];
    }), /this build's render loop writes "rainPhase"/],
    ['a manifest that is enormous and carries almost no GLSL', 'probe', bent((p) => {
      for (let i = 0; i < 200; i++) {
        p.manifest.params[`k${i}`] = {
          def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', label: `probe knob number ${i}`,
          panel: { group: 'probe', tab: 'look' },
          bind: { on: 'points', uniform: 'probeHue' },
          under: 'amount',
        };
      }
    }), /carries a manifest of \d+ bytes/],
    // A `gates` the gate can never read, in both shapes that reach it: one binds on the point
    // cloud, which `gradeGatesOf` never collects, and one lands a `Vector2`, which is never
    // strictly equal to zero. Neither reading of the comparison is wrong, which is why the pair is
    // refused at the door.
    ['a gating binding on a table the gate never reads', 'probe', bent((p) => {
      p.manifest.params.hue.bind.gates = true;
    }), /declares gates and binds on "points"/],
    ['a gating binding whose value is a direction rather than an amount', 'probe', bent((p) => {
      p.manifest.params.hue.bind = {
        on: 'grade', uniform: 'scanAxis', transform: 'axisDeg', gates: true,
      };
      p.chunks['decl.frag.glsl'] = 'uniform float probeAmount;\n';
    }), /declares gates beside the axisDeg transform/],
  ];

  let refusedCount = 0;
  const wrongReasons = [];
  let residue = null;
  for (const [what, id, body, matches] of hostile) {
    const answer = await put(id, body);
    if (answer.status === 409 && matches.test(answer.body.error ?? '')) refusedCount++;
    else wrongReasons.push(`${what}: ${answer.status} ${(answer.body.error ?? JSON.stringify(answer.body)).slice(0, 120)}`);
    const held = userRootHolds();
    if (held.length !== 0) residue ??= `${what} left ${held.join(', ')}`;
  }
  ok(`every hostile package is refused with the sentence for its own rule - ${hostile.length} rules`,
    refusedCount === hostile.length,
    wrongReasons.length
      ? `${wrongReasons.length} of ${hostile.length} answered with the wrong rule - ${wrongReasons.join(' | ')}`
      : `${refusedCount} of ${hostile.length}`);
  ok('and none of them reaches the filesystem: no package, no .tmp, no .old left behind',
    residue === null, residue ?? `user root ${userRootHolds().join(', ') || 'empty'}`);
  // Swept after the row that measures it, so a caught mutation cannot become a crash five sections
  // away. On a build whose door stopped refusing something the finding is already recorded above,
  // and what is left would redden rows about a page behaving correctly given what it was handed.
  for (const held of userRootHolds()) rmSync(join(USER_ROOT, held), { recursive: true, force: true });

  const stillShipped = await getJson('/effects');
  ok('and the shipped set is exactly what it was before the door was pushed at',
    stillShipped.body.effects?.length === listed.body.effects.length,
    `${stillShipped.body.effects?.length ?? 'no'} packages`);

  const refuseBuiltin = await del('noise');
  ok('a builtin nothing is forking refuses to be removed, by name',
    refuseBuiltin.status === 409 && /shipped with this build/.test(refuseBuiltin.body.error ?? ''),
    `${refuseBuiltin.status}: ${(refuseBuiltin.body.error ?? '').slice(0, 60)}`);

  console.log('\n[effect] 3. a page that is already up, adopting an install');

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 760 } });
  const pageErrors = [];
  // Whether a package read is being failed on purpose right now. One arm in section 9 plants a
  // transport failure to stage a read error, and the browser logs a failed request as a console
  // error whatever the page does with it. A window the arm opens and closes, not a widened rule.
  let failingPackageRead = false;
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const where = m.location()?.url ?? '';
    if (failingPackageRead && /\/effects\//.test(where)) return;
    if (/\/effects\//.test(where) && /status of 404/.test(m.text())) return;
    pageErrors.push(where ? `${m.text()} (${where})` : m.text());
  });
  await page.goto(`${BASE}/record`, { waitUntil: 'load' });
  await page.waitForFunction('Boolean(globalThis.__kinect)', null, { timeout: 20000 });

  const before = await page.evaluate(() => ({
    params: globalThis.__kinect.params.names().length,
    groups: document.querySelectorAll('#panelBody > [data-group]').length,
    probeRows: document.querySelectorAll('[data-group="probe"] .row').length,
  }));
  ok('the page is up with no probe on it, so what happens below is the install rather than the page',
    before.probeRows === 0 && before.params > 0, `${before.params} parameters, ${before.groups} generated groups`);

  const installed = await put('probe', probePackage());
  ok('the package installs while that page is open', installed.status === 200,
    `${installed.status}: ${installed.body.error ?? 'installed'}`);

  const adopted = await page.evaluate(async () => {
    try {
      await globalThis.__kinect.effects.reload();
    } catch (err) {
      return { threw: String(err.message) };
    }
    const k = globalThis.__kinect;
    return {
      params: k.params.names().length,
      groups: document.querySelectorAll('#panelBody > [data-group]').length,
      probeRows: document.querySelectorAll('[data-group="probe"] .row').length,
      probeRowsHidden: [...document.querySelectorAll('[data-group="probe"] .row')]
        .filter((row) => row.hidden).length,
      probeRackEmpty: document.querySelector('[data-group="probe"]')?.classList.contains('rackempty') ?? null,
      groupLabel: document.querySelector('[data-group="probe"] .grouphead label')?.textContent ?? null,
      knows: k.params.names().includes('probe.amount') && k.params.names().includes('probe.hue'),
      cell: Object.hasOwn(k.uniforms, 'probeAmount') && Object.hasOwn(k.uniforms, 'probeHue'),
      inShader: k.effects.programs().cloud.fragmentShader.includes('probeHue'),
      appended: k.params.names('look').slice(-2),
    };
  });
  ok('the rebuild ran through the product\'s own path', !adopted.threw, adopted.threw ?? 'no throw');
  ok('the registry grew exactly the package\'s two parameters',
    adopted.params === before.params + 2 && adopted.knows, `${before.params} -> ${adopted.params}`);
  ok('and they are at the end of the look order, which is where the placement rule puts a package nothing has a layout for',
    JSON.stringify(adopted.appended) === JSON.stringify(['probe.amount', 'probe.hue']), JSON.stringify(adopted.appended));
  ok('the panel grew the package\'s own group and rows, but keeps a newly installed idle effect out of the sidebar',
    adopted.groups === before.groups + 1 && adopted.probeRows === 2
      && adopted.probeRowsHidden === adopted.probeRows && adopted.probeRackEmpty === true,
    `${adopted.groups} groups, ${adopted.probeRowsHidden} of ${adopted.probeRows} probe rows hidden, `
    + `rack empty=${adopted.probeRackEmpty}, heading ${JSON.stringify(adopted.groupLabel)}`);
  ok('the uniform cells its bindings need were minted, because no hand-written table holds them',
    adopted.cell === true, `probeAmount and probeHue ${adopted.cell ? 'present' : 'missing'}`);
  ok('and the assembled program carries its chunk text', adopted.inShader === true);

  await page.locator('.paneltab[data-panel-tab="look"]').click();
  await page.locator('#effectRackOpen').click();
  await page.locator('[data-effect-add="probe"]').click();
  const racked = await page.evaluate(() => {
    const row = document.getElementById('probe.amount')?.closest('.row, .checkrow');
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem('kinect.rackedEffects') ?? '[]'); } catch {}
    return {
      hidden: row?.hidden ?? null,
      stored,
      focused: document.activeElement?.id ?? null,
      pickerOpen: !document.getElementById('effectRackPanel').hidden,
    };
  });
  ok('and Add makes that hot-loaded effect available without a reload or a value change',
    racked.hidden === false && racked.stored.includes('probe') && racked.pickerOpen,
    `hidden=${racked.hidden}, stored=${JSON.stringify(racked.stored)}, `
    + `focused=${JSON.stringify(racked.focused)}, picker open=${racked.pickerOpen}`);
  if (racked.pickerOpen) await page.locator('[data-effect-remove="probe"]').click();
  else await page.evaluate("document.querySelector('[data-effect-remove=probe]')?.click()");
  if (await page.locator('#effectRackPanel').isVisible()) await page.locator('#effectRackClose').click();
  await page.locator('.paneltab[data-panel-tab="record"]').click();

  // Then `boot-check`'s own three rows, asked of a page that got here by hotload rather than by
  // boot. This is the row an install is most likely to break silently: a rebuild that replaced the
  // registry and repainted nothing draws a normal panel showing the values from before it.
  const diff = await page.evaluate(() => {
    const k = globalThis.__kinect;
    const rows = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) continue;
      const registry = k.params.get(name);
      const control = el.type === 'checkbox' ? el.checked : Number(el.value);
      rows.push({ name, registry, control, agrees: String(registry) === String(control) });
    }
    return rows;
  });
  const diverge = diff.filter((r) => !r.agrees);
  ok('every control on the rebuilt page shows the value the registry holds for it',
    diff.length > 0 && diverge.length === 0,
    diverge.length
      ? `${diverge.length} of ${diff.length} diverge: ${diverge.slice(0, 5).map((r) => `${r.name} registry ${r.registry} vs control ${r.control}`).join('; ')}`
      : `${diff.length} of ${diff.length} agree`);

  const drive = await page.evaluate(() => {
    const k = globalThis.__kinect;
    let moved = 0;
    let followed = 0;
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) continue;
      const want = el.type === 'checkbox'
        ? !k.params.get(name)
        : (String(k.params.get(name)) === el.min ? Number(el.max) : Number(el.min));
      k.params.set(name, want);
      moved++;
      const shown = el.type === 'checkbox' ? el.checked : Number(el.value);
      if (String(shown) === String(k.params.get(name))) followed++;
    }
    return { moved, followed };
  });
  ok('and the comparison can separate two states: a write through the registry moves the control it belongs to',
    drive.moved === diff.length && drive.followed === drive.moved,
    `${drive.followed} of ${drive.moved} followed`);

  console.log('\n[effect] 4. an uninstall parks the edit, and a reinstall gives it back');

  const buffer = pinnedBuffer();
  await page.route('**/__effect-pinned.bin', (route) => route.fulfill({
    status: 200, contentType: 'application/octet-stream', body: buffer,
  }));
  await page.evaluate(async () => {
    const res = await fetch('/__effect-pinned.bin');
    globalThis.__kinect.drive.pin(await res.arrayBuffer());
  });

  const authored = await page.evaluate(async (positions) => {
    const k = globalThis.__kinect;
    k.params.reset();
    k.params.set('probe.amount', 0.7);
    k.params.set('probe.hue', 0.3);
    k.keyframes.setTracks({ 'probe.amount': [{ t: 0, value: 0.15 }, { t: 1.4, value: 0.95 }] });
    const sha256 = async (bytes) => {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    };
    k.drive.reset();
    const hashes = [];
    for (const t of positions) {
      k.drive.stepTo(t);
      hashes.push(await sha256(k.drive.readPixels()));
    }
    return { hashes, track: k.keyframes.valueAt('probe.amount', 0.7), hue: k.params.get('probe.hue') };
  }, POSITIONS);
  ok('an edit is authored on the installed effect: two values and a track with keys',
    authored.hue === 0.3 && authored.track !== null,
    `hue ${authored.hue}, the track reads ${authored.track?.toFixed?.(3) ?? authored.track} at 0.7s`);
  ok('and the three program positions render three different images, so the identity below is about something',
    new Set(authored.hashes).size === POSITIONS.length,
    authored.hashes.map((h) => h.slice(0, 8)).join(' '));

  const removed = await del('probe');
  ok('the package is removed', removed.status === 200 && removed.body.removed === 'probe',
    `${removed.status}: ${removed.body.error ?? 'removed'}`);

  const parked = await page.evaluate(async () => {
    try {
      await globalThis.__kinect.effects.reload();
    } catch (err) {
      return { threw: String(err.message) };
    }
    const k = globalThis.__kinect;
    const badge = document.getElementById('tMissing');
    return {
      knows: k.params.names().includes('probe.amount'),
      groups: document.querySelectorAll('[data-group="probe"]').length,
      // The pool is kept per clip and per project; these rows count what is parked, whichever
      // block it is in, so they take the union across every clip and the project block.
      pool: (({ clips, project }) => ({
        params: Object.assign({}, ...clips.map((c) => c.params), project.params),
        tracks: Object.assign({}, ...clips.map((c) => c.tracks), project.tracks),
      }))(k.library.parkedLook()),
      missing: k.library.missingEffects(),
      badgeHidden: badge?.hidden ?? null,
      badgeText: badge?.textContent ?? '',
    };
  });
  ok('the rebuild after the removal ran', !parked.threw, parked.threw ?? 'no throw');
  ok('the registry and the panel no longer carry the effect',
    parked.knows === false && parked.groups === 0, `${parked.groups} probe groups`);
  ok('its values and its track are parked rather than dropped',
    Object.keys(parked.pool?.params ?? {}).length === 2
      && Object.keys(parked.pool?.tracks ?? {}).length === 1,
    `${Object.keys(parked.pool?.params ?? {}).length} values, ${Object.keys(parked.pool?.tracks ?? {}).length} tracks: `
    + `${JSON.stringify(parked.pool?.params)}`);
  ok('and the badge says so, quoting the version the edit was authored against',
    parked.badgeHidden === false && /probe/.test(parked.badgeText) && /1\.0\.0/.test(parked.badgeText),
    `hidden=${parked.badgeHidden}, "${parked.badgeText.trim().slice(0, 70)}"`);
  ok('and the pool\'s counts are what the badge is drawn from',
    parked.missing?.length === 1 && parked.missing[0].values === 2 && parked.missing[0].tracks === 1,
    JSON.stringify(parked.missing));

  const reinstalled = await put('probe', probePackage());
  ok('the package is installed again', reinstalled.status === 200,
    `${reinstalled.status}: ${reinstalled.body.error ?? 'installed'}`);

  const restoredRun = await page.evaluate(async (positions) => {
    try {
      await globalThis.__kinect.effects.reload();
    } catch (err) {
      return { threw: String(err.message) };
    }
    const k = globalThis.__kinect;
    const sha256 = async (bytes) => {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    };
    k.drive.reset();
    const hashes = [];
    for (const t of positions) {
      k.drive.stepTo(t);
      hashes.push(await sha256(k.drive.readPixels()));
    }
    const badge = document.getElementById('tMissing');
    return {
      hashes,
      // The pool is kept per clip and per project; these rows count what is parked, whichever
      // block it is in, so they take the union across every clip and the project block.
      pool: (({ clips, project }) => ({
        params: Object.assign({}, ...clips.map((c) => c.params), project.params),
        tracks: Object.assign({}, ...clips.map((c) => c.tracks), project.tracks),
      }))(k.library.parkedLook()),
      hue: k.params.get('probe.hue'),
      track: k.keyframes.valueAt('probe.amount', 0.7),
      badgeHidden: badge?.hidden ?? null,
    };
  }, POSITIONS);
  ok('the rebuild after the reinstall ran', !restoredRun.threw, restoredRun.threw ?? 'no throw');
  ok('the parked pool is empty again, so nothing was left behind by the effect coming back',
    Object.keys(restoredRun.pool?.params ?? {}).length === 0
      && Object.keys(restoredRun.pool?.tracks ?? {}).length === 0,
    JSON.stringify(restoredRun.pool?.params ?? {}));
  ok('the values and the track came back through the registry\'s own door',
    restoredRun.hue === 0.3 && Math.abs((restoredRun.track ?? 0) - (authored.track ?? -1)) < 1e-9,
    `hue ${restoredRun.hue}, the track reads ${restoredRun.track?.toFixed?.(6)} against ${authored.track?.toFixed?.(6)}`);
  ok('and the three positions render the same three images they rendered before the uninstall',
    JSON.stringify(restoredRun.hashes) === JSON.stringify(authored.hashes),
    restoredRun.hashes.map((h, i) => `${h.slice(0, 8)}${h === authored.hashes[i] ? '=' : '!='}${authored.hashes[i].slice(0, 8)}`).join(' '));

  console.log('\n[effect] 5. a document with everything it needs says nothing');

  const quiet = await page.evaluate(() => {
    const k = globalThis.__kinect;
    const badge = document.getElementById('tMissing');
    return {
      missing: k.library.missingEffects(),
      hidden: badge?.hidden ?? null,
      entries: document.querySelectorAll('#tMissing .missingfx').length,
    };
  });
  ok('with every effect the document names installed, the badge is not on screen',
    quiet.hidden === true && quiet.missing.length === 0 && quiet.entries === 0,
    `hidden=${quiet.hidden}, ${quiet.missing.length} missing, ${quiet.entries} entries drawn`);

  // The install that succeeds on the server and cannot be adopted by this page. What must not
  // happen is the page keeping the registry it just swapped in while its parked pool describes the
  // build before last. Driven through the poll, because the note is asserted and the poll
  // is what writes it.
  console.log('\n[effect] 6. an install this page cannot carry the open document onto');

  const readPage = async (positions) => {
    const k = globalThis.__kinect;
    const sha256 = async (bytes) => {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    };
    k.drive.reset();
    const hashes = [];
    for (const t of positions) {
      k.drive.stepTo(t);
      hashes.push(await sha256(k.drive.readPixels()));
    }
    const badge = document.getElementById('tMissing');
    const note = document.getElementById('tNote');
    return {
      hashes,
      names: k.params.names(),
      signature: k.effects.signature(),
      // The pool is kept per clip and per project; these rows count what is parked, whichever
      // block it is in, so they take the union across every clip and the project block.
      pool: (({ clips, project }) => ({
        params: Object.assign({}, ...clips.map((c) => c.params), project.params),
        tracks: Object.assign({}, ...clips.map((c) => c.tracks), project.tracks),
      }))(k.library.parkedLook()),
      body: k.library.serialiseProjectBody(),
      badgeHidden: badge?.hidden ?? null,
      badgeText: badge?.textContent ?? '',
      note: note?.textContent ?? '',
    };
  };

  /** Everything a document says about the parked effect, as one comparable string. */
  const parkedKeysOf = (body) => {
    // Both blocks, because a parked key comes back in the one the document wrote it in.
    const blocks = [body.look, ...body.clips];
    const under = (kind) => Object.fromEntries(
      blocks.flatMap((b) => Object.entries(b[kind]).filter(([n]) => n.startsWith('probe.'))),
    );
    return JSON.stringify({
      params: under('params'),
      tracks: under('tracks'),
      requires: (body.requires ?? []).filter((e) => e.id === 'probe'),
    });
  };

  await del('probe');
  const reParked = await page.evaluate(async () => {
    try {
      await globalThis.__kinect.effects.reload();
      return { threw: null };
    } catch (err) {
      return { threw: String(err.message) };
    }
  });
  ok('the effect comes off again and the page rebuilds without it', reParked.threw === null,
    reParked.threw ?? 'no throw');
  const beforeFork = await page.evaluate(readPage, POSITIONS);

  ok('the effect is uninstalled again, so the document is holding it parked when the install below lands',
    beforeFork.names.includes('probe.amount') === false
      && Object.keys(beforeFork.pool.params).length === 2
      && Object.keys(beforeFork.pool.tracks).length === 1
      && beforeFork.badgeHidden === false,
    `${Object.keys(beforeFork.pool.params).length} values and ${Object.keys(beforeFork.pool.tracks).length} tracks parked, `
    + `badge hidden=${beforeFork.badgeHidden}`);
  // The control for the identity row below, cross-state rather than section 4's
  // three-distinct-images row: parked, 0.6s and 1.2s both show the last frame. So these are held
  // against the raised state.
  ok('and the parked picture is not the picture the installed effect drew, so these hashes read the look rather than the frame',
    JSON.stringify(beforeFork.hashes) !== JSON.stringify(authored.hashes),
    `${beforeFork.hashes.map((h) => h.slice(0, 8)).join(' ')} against ${authored.hashes.map((h) => h.slice(0, 8)).join(' ')}`);

  const fork = await put('probe', forkedProbe());
  const forkServed = await getJson('/effects/probe');
  ok('the fork installs: the server takes a package that is this effect with one parameter more',
    fork.status === 200 && forkServed.status === 200 && forkServed.body.manifest?.version === '2.0.0',
    `${fork.status}: ${fork.body.error ?? 'installed'}, the store now serves version ${forkServed.body.manifest?.version}`);

  // Driven by the poll and then waited for, because the interval is still running and can be
  // mid-read when this line arrives, at which point the reentrancy guard sends this call back. What
  // has to be true either way is that the page reports the refusal, so that is what is waited for.
  await page.evaluate(() => globalThis.__kinect.effects.pollNow());
  await page.waitForFunction(
    `(() => {
      const note = document.getElementById('tNote')?.textContent ?? '';
      return note.includes('probe.glow') && note.includes('still running the effects it had');
    })()`, null, { timeout: 20000 },
  ).catch(() => {});
  const afterFork = await page.evaluate(readPage, POSITIONS);

  ok('the page reports the refusal by name, and says which set it is still running',
    /probe\.glow/.test(afterFork.note) && /still running the effects it had/.test(afterFork.note),
    `"${afterFork.note.trim().slice(0, 120)}"`);
  ok('and the registry is the one this page had rather than the one the server is serving',
    JSON.stringify(afterFork.names) === JSON.stringify(beforeFork.names),
    afterFork.names.includes('probe.glow')
      ? 'probe.glow reached the registry, so the swap was kept'
      : `${afterFork.names.length} parameters, the same ${beforeFork.names.length} as before the install`);
  ok('and the signature with it, so nothing is left claiming to be assembled from a set it refused',
    afterFork.signature === beforeFork.signature,
    afterFork.signature === beforeFork.signature ? 'unchanged' : 'the page moved to the new set');
  // And the fork is still installed, the one thing here about the store: the completeness rule is a
  // fact about *this document*, so this refusal must never reach the set-aside route.
  const forkStanding = await getJson('/effects/probe');
  ok('and the fork is still installed, because a page that could not carry its document across has said nothing about the package',
    forkStanding.status === 200 && forkStanding.body.builtin === false
      && !userRootHolds().some((name) => /^probe\..+\.incompatible$/.test(name)),
    `GET /effects/probe answered ${forkStanding.status}, user root holds ${userRootHolds().join(', ') || 'nothing'}`);
  ok('the parked pool is exactly what it was: the same values, the same track, the same entry',
    JSON.stringify(afterFork.pool) === JSON.stringify(beforeFork.pool),
    `${Object.keys(afterFork.pool.params).length} values, ${Object.keys(afterFork.pool.tracks).length} tracks`);
  ok('and the badge still quotes the version the edit was authored against rather than the one that just landed',
    afterFork.badgeHidden === false && /probe 1\.0\.0/.test(afterFork.badgeText),
    `hidden=${afterFork.badgeHidden}, "${afterFork.badgeText.trim().slice(0, 60)}"`);
  ok('the three positions render the same three images they rendered before the install',
    JSON.stringify(afterFork.hashes) === JSON.stringify(beforeFork.hashes),
    afterFork.hashes.map((h, i) => `${h.slice(0, 8)}${h === beforeFork.hashes[i] ? '=' : '!='}${beforeFork.hashes[i].slice(0, 8)}`).join(' '));
  ok('and a save afterwards writes the parked keys exactly as it wrote them before',
    parkedKeysOf(afterFork.body) === parkedKeysOf(beforeFork.body) && /probe\.amount/.test(parkedKeysOf(beforeFork.body)),
    parkedKeysOf(afterFork.body).slice(0, 110));

  const reloadable = await page.evaluate(() => {
    const k = globalThis.__kinect;
    try {
      k.library.restoreProject(k.library.serialiseProjectBody());
      return { threw: null };
    } catch (err) {
      return { threw: String(err.message) };
    }
  });
  ok('and the document it writes is one this same page will take back', reloadable.threw === null,
    reloadable.threw ?? 'loaded');

  await del('probe');
  const converged = await page.evaluate(async () => {
    await globalThis.__kinect.effects.pollNow();
    return { signature: globalThis.__kinect.effects.signature() };
  });
  const storeNow = await getJson('/effects');
  const storeSignature = storeNow.body.effects.map((e) => `${e.id} ${e.rev}`).join('\n');
  ok('and with the fork taken back off, the page and the store are holding one set again',
    converged.signature === storeSignature, converged.signature === storeSignature ? 'agreed' : 'still apart');

  // Everything on the panel that is not a parameter row, which is where a rebuild goes wrong
  // invisibly - dead buttons, an unapplied tab, stale collapse paint, a stale preset dialog.
  console.log('\n[effect] 7. the panel a rebuild leaves behind, beside the rows it rebuilt');

  const primed = await page.evaluate(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    // A stamp on the note the framing group emits: the question is whether the element in the
    // document after the rebuild is the element `ui` is holding, and an attribute nothing else
    // writes answers it directly. A rebuilt node carries the generator's bare default instead.
    const note = document.getElementById('recRange');
    note.dataset.effectCheckWitness = 'before-the-install';
    // A group the panel has painted shut, so `groupPainted` holds a state string for it. `post`
    // because it is a core group surviving every install below, and the toggle is pressed only
    // where the panel already shows it open, so the click is not what decides the state.
    const post = document.querySelector('[data-group="post"]');
    if (!post.classList.contains('shut')) document.querySelector('[data-group-toggle="post"]').click();
    return {
      shown: k.cropBoxShown(),
      note: note.textContent,
      postShut: post.classList.contains('shut'),
      postExpanded: post.querySelector('.grouptoggle').getAttribute('aria-expanded'),
      lookNames: k.params.names('look').length,
      boxes: document.querySelectorAll('#ppGroups input[id^="pp-"]').length,
    };
  });
  ok('the page is in a state a rebuild can damage: a group shut by hand, a note carrying a status write, a stamp on it',
    primed.postShut === true && primed.postExpanded === 'false' && /capture keeps/.test(primed.note),
    `post shut=${primed.postShut} aria-expanded=${primed.postExpanded}, note ${JSON.stringify(primed.note.slice(0, 40))}`);

  await put('probe', probePackage());
  const rebuilt = await page.evaluate(async () => {
    await globalThis.__kinect.effects.reload();
    const k = globalThis.__kinect;
    const before = k.cropBoxShown();
    document.getElementById('cropBox').click();
    const after = k.cropBoxShown();
    const note = document.getElementById('recRange');
    const post = document.querySelector('[data-group="post"]');
    const active = document.querySelector('.paneltab[aria-selected="true"]')?.dataset.panelTab ?? null;
    const visible = [...document.querySelectorAll('#panelBody > [data-panel-tab]')]
      .filter((g) => !g.hidden);
    return {
      pressed: before !== after,
      pressedShows: after,
      aria: document.getElementById('cropBox').getAttribute('aria-pressed'),
      witness: note?.dataset.effectCheckWitness ?? null,
      noteText: note?.textContent ?? '',
      active,
      visibleTabs: [...new Set(visible.map((g) => g.dataset.panelTab))],
      offTab: visible.filter((g) => g.dataset.panelTab !== active)
        .map((g) => g.dataset.group || g.id),
      probeGroupHidden: document.querySelector('[data-group="probe"]')?.hidden ?? null,
      postShut: post.classList.contains('shut'),
      postExpanded: post.querySelector('.grouptoggle').getAttribute('aria-expanded'),
      boxes: [...document.querySelectorAll('#ppGroups input[type="checkbox"]')].map((b) => b.id),
      presetNames: k.presetValueNames(),
    };
  });

  ok('a hand-written control inside a rebuilt group still works: pressing show crop box moves what the chrome draws from',
    rebuilt.pressed === true && rebuilt.aria === String(rebuilt.pressedShows),
    `the flag ${rebuilt.pressed ? 'moved' : 'did not move'}, the button reads aria-pressed=${rebuilt.aria}`);
  ok('and the node the page writes its status into is the node in the document, carrying what was written before the install',
    rebuilt.witness === 'before-the-install' && rebuilt.noteText === primed.note,
    `witness ${JSON.stringify(rebuilt.witness)}, note ${JSON.stringify(rebuilt.noteText.slice(0, 40))}`);

  ok('the tab that was showing is still the only one showing, over groups the rebuild has just made',
    rebuilt.offTab.length === 0 && rebuilt.probeGroupHidden === true,
    rebuilt.offTab.length
      ? `${rebuilt.offTab.length} groups from another tab are on screen: ${rebuilt.offTab.slice(0, 6).join(', ')}`
      : `${rebuilt.visibleTabs.join(', ')} showing under the ${rebuilt.active} tab, the probe's look group hidden`);

  ok('a group shut before the install is still shut after it, in the class the panel draws from and the attribute a reader hears',
    rebuilt.postShut === true && rebuilt.postExpanded === 'false',
    `shut=${rebuilt.postShut}, aria-expanded=${rebuilt.postExpanded}`);

  const pickedNames = rebuilt.boxes.filter((id) => id.startsWith('pp-')).map((id) => id.slice(3));
  ok('the preset subset dialog is a statement of the registry that exists now: the installed effect has its boxes',
    pickedNames.includes('probe.amount') && pickedNames.includes('probe.hue')
      && JSON.stringify([...pickedNames].sort()) === JSON.stringify([...rebuilt.presetNames].sort()),
    `${pickedNames.length} boxes against ${rebuilt.presetNames.length} preset values, `
    + `probe ${pickedNames.filter((n) => n.startsWith('probe.')).join(' and ') || 'absent'}`);

  await del('probe');
  const unpicked = await page.evaluate(async () => {
    await globalThis.__kinect.effects.reload();
    const k = globalThis.__kinect;
    const boxes = [...document.querySelectorAll('#ppGroups input[type="checkbox"]')];
    let threw = null;
    for (const box of boxes) {
      try {
        box.checked = !box.checked;
        box.dispatchEvent(new Event('change'));
      } catch (err) { threw ??= `${box.id}: ${err.message}`; }
    }
    return {
      names: boxes.filter((b) => b.id.startsWith('pp-')).map((b) => b.id.slice(3)),
      threw,
      count: document.getElementById('ppCount')?.textContent ?? '',
      presetNames: k.presetValueNames(),
    };
  });
  ok('and the uninstalled effect has none, with every box left in the dialog still pressable',
    unpicked.names.includes('probe.amount') === false && unpicked.threw === null
      && JSON.stringify([...unpicked.names].sort()) === JSON.stringify([...unpicked.presetNames].sort()),
    unpicked.threw ?? `${unpicked.names.length} boxes against ${unpicked.presetNames.length} preset values, readout "${unpicked.count}"`);

  // Four claims about the rebuild rather than about its result: the grade gate has to be
  // re-derived, a package that changed no GLSL must not warm, one that did must release the program
  // it replaced, and a rebuild must ask whether it may land at the moment it lands.
  console.log('\n[effect] 8. the grade gate, the warm that must not happen, the program that must be let go, and the gesture that stands a rebuild down');

  const gradeInstall = await put('probegrade', gradeProbePackage());
  ok('a grade effect installs - one this build did not boot with, binding its own gating uniform',
    gradeInstall.status === 200, `${gradeInstall.status}: ${gradeInstall.body.error ?? 'installed'}`);

  const gated = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    await k.effects.reload();
    const atDefault = k.grade.enabled;
    k.params.set('probegrade.amount', 0.6);
    const raised = k.grade.enabled;
    return { atDefault, raised, value: k.grade.uniforms.probeGradeAmount?.value ?? null };
  });
  ok('the pass is shut with the new effect at its default, which is what a master being inert at zero means',
    gated.atDefault === false, `grade.enabled=${gated.atDefault}`);
  ok('and raising the installed effect opens it, so a package that arrived after boot is counted by existing',
    gated.raised === true && gated.value === 0.6,
    `grade.enabled=${gated.raised} with the uniform at ${gated.value}`);

  await del('probegrade');
  const ungated = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    await k.effects.reload();
    return { enabled: k.grade.enabled, value: k.grade.uniforms.probeGradeAmount?.value ?? null };
  });
  // The other direction, a correctness row rather than a discriminating one. The second half is a
  // live reading of the cell: nothing writes a uniform except the parameter bound to it.
  ok('and taking it off shuts the pass again, on a uniform cell put back to the value it started at',
    ungated.enabled === false && ungated.value === 0,
    `grade.enabled=${ungated.enabled}, probeGradeAmount reads ${ungated.value}`);

  // The warm is read off `counters.resets` rather than off frames rendered, which is not
  // deterministic here. The counter moves only where `resetAccumulators` runs, and on this path the
  // only thing that runs it is `warmPrograms`.
  await put('probe', probePackage());
  await page.evaluate(async () => { await globalThis.__kinect.effects.reload(); });

  await put('probe', retunedProbe());
  const quietReload = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    const before = k.timeline.counters.resets;
    await k.effects.reload();
    return {
      resets: k.timeline.counters.resets - before,
      label: document.getElementById('probe.hue')?.closest('.row')?.querySelector('span')?.textContent ?? null,
      knows: k.params.names().includes('probe.hue'),
    };
  });
  ok('a package that changed only its manifest is adopted - the label the rebuild is about did move',
    quietReload.label === 'probe hue, retuned' && quietReload.knows,
    `the registry reads ${JSON.stringify(quietReload.label)}`);
  ok('and it threw no accumulator away doing it, because the assembled programs are the ones already compiled',
    quietReload.resets === 0,
    `${quietReload.resets} accumulator resets across a rebuild that changed no GLSL`);

  await put('probe', recompiledProbe(1));
  const loudReload = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    const before = k.timeline.counters.resets;
    await k.effects.reload();
    return {
      resets: k.timeline.counters.resets - before,
      inShader: k.effects.programs().cloud.fragmentShader.includes('probeHue * 0.51'),
    };
  });
  ok('and a package that did change its GLSL does warm, which is what makes the row above a distinction rather than a build that stopped rebuilding',
    loudReload.resets === 1 && loudReload.inShader === true,
    `${loudReload.resets} resets, the new chunk text ${loudReload.inShader ? 'reached' : 'did not reach'} the assembled program`);

  const beforeGrowth = await page.evaluate(() => {
    // Rendered first, so the count is taken after the driver has compiled what the page holds.
    globalThis.__kinect.drive.stepTo(0.4);
    return globalThis.__kinect.renderer.info.programs.length;
  });
  const growthCounts = [];
  for (let n = 2; n <= 4; n++) {
    await put('probe', recompiledProbe(n));
    growthCounts.push(await page.evaluate(async () => {
      const k = globalThis.__kinect;
      await k.effects.reload();
      k.drive.stepTo(0.4);
      return k.renderer.info.programs.length;
    }));
  }
  ok('three GLSL-changing installs do not grow the renderer\'s program cache, because the swap releases what it replaced',
    growthCounts.every((n) => n <= beforeGrowth),
    `${beforeGrowth} programs before, ${growthCounts.join(' then ')} after each of three installs`);

  // The gesture goes up while the rebuild is reading: a rebuild that only asked on its way in would
  // pass a check that raised the flag first. The three conditions are one predicate.
  await put('probe', recompiledProbe(9));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  await page.route('**/effects/probe', async (route) => {
    await held;
    await route.continue();
  });
  const deferred = page.evaluate(async () => {
    const k = globalThis.__kinect;
    const was = k.effects.signature();
    const answer = await k.effects.reload();
    return { answer, was, now: k.effects.signature(), names: k.params.names().length };
  });
  // Long enough for the reload to have reached the held request and not so long that a slow machine
  // reads as a finding - a gesture up before the fetch started is the poll's entry check instead.
  await wait(400);
  const gestureUp = await page.evaluate(() => {
    document.getElementById('tPresetSave').click();
    return globalThis.__kinect.library.presetGestureRunning();
  });
  release();
  const stoodDown = await deferred;
  await page.unroute('**/effects/probe');
  ok('a gesture opening while the rebuild was reading is a gesture the rebuild stands down for',
    gestureUp === true && stoodDown.answer === null && stoodDown.now === stoodDown.was,
    `the gesture was ${gestureUp ? 'up' : 'down'}, the rebuild answered ${JSON.stringify(stoodDown.answer)}, `
    + `the signature ${stoodDown.now === stoodDown.was ? 'did not move' : 'moved'}`);

  // Waited for rather than counted in turns of the loop: the flag comes down in a `finally` several
  // hops after the dialog's `close` event, so a `setTimeout(0)` read it on its way down about half
  // the time. The gesture being over is a precondition to wait for rather than a step to assume.
  await page.evaluate(() => { document.getElementById('ppCancel').click(); });
  const gestureDown = await page.waitForFunction(
    'globalThis.__kinect.library.presetGestureRunning() === false', null, { timeout: 10000 },
  ).then(() => true).catch(() => false);
  const storeAfterGesture = await getJson('/effects');
  const wantSignature = storeAfterGesture.body.effects.map((e) => `${e.id} ${e.rev}`).join('\n');
  // The same reason section 6 waits for its note: `pollNow` can be answered by its own reentrancy
  // guard while the tick holding it does the work a moment later.
  const resumedConverged = await page.evaluate(async () => { await globalThis.__kinect.effects.pollNow(); })
    .then(() => page.waitForFunction(
      (want) => globalThis.__kinect.effects.signature() === want, wantSignature, { timeout: 20000 },
    ))
    .then(() => true).catch(() => false);
  ok('and the same rebuild lands as soon as the gesture is over, so standing down deferred it rather than dropping it',
    gestureDown === true && resumedConverged === true,
    gestureDown ? (resumedConverged ? 'the page converged on the store' : 'the page never converged on the store')
      : 'the gesture never came down');

  // Three ways the converging read goes wrong that have nothing to do with the packages being
  // wrong, and all three are silent: a body that is not a list of ids and revs, two ticks
  // overlapping so the older read wins, and a package set read across an install.
  console.log('    (and what the poll does with an answer it cannot use)');

  await page.route('**/effects', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ nope: 'this is not a store' }),
  }));
  const nonsense = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    const was = { signature: k.effects.signature(), names: k.params.names().length };
    let threw = null;
    try { await k.effects.pollNow(); } catch (err) { threw = String(err.message); }
    return { threw, was, signature: k.effects.signature(), names: k.params.names().length };
  });
  await page.unroute('**/effects');
  ok('a 200 carrying a body this build cannot read is a tick that does nothing rather than a rejection every six seconds',
    nonsense.threw === null && nonsense.signature === nonsense.was.signature
      && nonsense.names === nonsense.was.names,
    nonsense.threw ? `the poll threw: ${nonsense.threw.slice(0, 90)}` : `the page kept its ${nonsense.names} parameters and its signature`);

  // Two ticks at once, with the list held open. The read in flight is waited for rather than
  // started: the interval is still going, so `pollNow` can be answered by the very guard
  // this row is about.
  let listCalls = 0;
  let releaseList;
  const listHeld = new Promise((resolve) => { releaseList = resolve; });
  await page.route('**/effects', async (route) => {
    listCalls += 1;
    if (listCalls === 1) await listHeld;
    await route.continue();
  });
  const firstTick = page.evaluate(() => globalThis.__kinect.effects.pollNow()).catch(() => {});
  // Up to one whole interval plus the read, since the tick being waited for may be
  // the driver's own.
  let inFlight = false;
  for (let waited = 0; waited < 9000 && !inFlight; waited += 100) {
    inFlight = listCalls >= 1;
    if (!inFlight) await wait(100);
  }
  const secondTick = page.evaluate(() => globalThis.__kinect.effects.pollNow()).catch(() => {});
  await wait(400);
  const duringOverlap = listCalls;
  releaseList();
  await Promise.all([firstTick, secondTick]);
  await page.unroute('**/effects');
  ok('a second tick arriving while the first is still reading does not read too: the guard is up before the fetch rather than after it',
    inFlight === true && duringOverlap === 1,
    inFlight
      ? `${duringOverlap} reads of the store were in flight at once${listCalls > duringOverlap ? `, ${listCalls} in all` : ''}`
      : 'no read of the store ever went out, so nothing was held and this row measured nothing');

  // A requested rebuild uses the same lock as the periodic poll. Without that lock, the request
  // can adopt a stale package set after the poll has already adopted the newer one.
  let lockedListCalls = 0;
  let releaseLockedList;
  const lockedListHeld = new Promise((resolve) => { releaseLockedList = resolve; });
  await page.route('**/effects', async (route) => {
    lockedListCalls += 1;
    if (lockedListCalls === 1) await lockedListHeld;
    await route.continue();
  });
  const lockedPoll = page.evaluate(() => globalThis.__kinect.effects.pollNow()).catch(() => {});
  let lockedPollInFlight = false;
  for (let waited = 0; waited < 9000 && !lockedPollInFlight; waited += 100) {
    lockedPollInFlight = lockedListCalls >= 1;
    if (!lockedPollInFlight) await wait(100);
  }
  const requestedReload = page.evaluate(() => globalThis.__kinect.effects.reload()).catch(() => {});
  await wait(400);
  const readsBeforeRelease = lockedListCalls;
  releaseLockedList();
  await Promise.all([lockedPoll, requestedReload]);
  await page.unroute('**/effects');
  ok('a requested rebuild waits for a poll that is already reading instead of rebuilding beside it',
    lockedPollInFlight === true && readsBeforeRelease === 1 && lockedListCalls === 3,
    lockedPollInFlight
      ? `${readsBeforeRelease} listing read before release, ${lockedListCalls} after both operations finished`
      : 'no poll read went out, so nothing was held and this row measured nothing');

  await put('probe', recompiledProbe(5));
  // The closing read is the first listing after a package read, not "every second one": the page's
  // interval shares this route, so parity shifts and this row reddens on a clean build. The marker
  // is cleared as each closing read passes, so every attempt opens on an untouched listing.
  let listReads = 0;
  let closingReads = 0;
  let listAfterPackages = false;
  await page.route('**/effects/probe', async (route) => { listAfterPackages = true; await route.continue(); });
  await page.route('**/effects', async (route) => {
    listReads += 1;
    const res = await route.fetch();
    const body = await res.json();
    if (listAfterPackages) {
      body.effects[0].rev = `${body.effects[0].rev}-moved`;
      listAfterPackages = false;
      closingReads += 1;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const incoherent = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    const was = k.effects.signature();
    let threw = null;
    try { await k.effects.reload(); } catch (err) { threw = String(err.message); }
    return { threw, held: k.effects.signature() === was, knows: k.params.names().includes('probe.hue') };
  });
  await page.unroute('**/effects');
  await page.unroute('**/effects/probe');
  ok('a store that moves while the page is reading it is refused rather than assembled from both halves',
    incoherent.threw !== null && /moved while this page was reading them/.test(incoherent.threw ?? '')
      && incoherent.held === true && closingReads === 2,
    incoherent.threw ? `"${incoherent.threw.slice(0, 100)}", the signature ${incoherent.held ? 'held' : 'moved'}, `
      + `${closingReads} of ${listReads} listings moved`
      : `the rebuild reported success on a set read across two revisions (${closingReads} of ${listReads} listings moved)`);
  const coherent = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    await k.effects.reload();
    return k.effects.programs().cloud.fragmentShader.includes('probeHue * 0.55');
  });
  ok('and the same set read with nothing moving is adopted, so the rule above is a distinction rather than a refusal to read at all',
    coherent === true, coherent ? 'the fifth recompiled chunk reached the assembled program' : 'the page did not adopt it');

  // A revision is a hash of bytes, so a change that is undone hashes back: both listings agree
  // across a window the store answered as something else. What the store gained for it is a count
  // of how many times it changed, staged here on every read, since the page's interval
  // shifts any parity.
  let genReads = 0;
  const generationRoute = async (route) => {
    genReads += 1;
    const res = await route.fetch();
    const body = await res.json();
    body.generation += genReads;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  };
  await page.route('**/effects', generationRoute);
  const undone = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    const was = k.effects.signature();
    let threw = null;
    try { await k.effects.reload(); } catch (err) { threw = String(err.message); }
    return { threw, held: k.effects.signature() === was };
  });
  await page.unroute('**/effects', generationRoute);
  ok('a change the store made and unmade while the page was reading is refused, though every revision on both sides of it is identical',
    /moved while this page was reading them/.test(undone.threw ?? '')
      && /generation/.test(undone.threw ?? '') && undone.held === true,
    undone.threw ? `"${undone.threw.slice(-90)}", the signature ${undone.held ? 'held' : 'moved'}`
      : 'the rebuild reported success on a set read across a change and its undo');

  const movedRevRoute = async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    body.rev = `${body.rev}-moved`;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  };
  await page.route('**/effects/probe', movedRevRoute);
  const strayPackage = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    const was = k.effects.signature();
    let threw = null;
    try { await k.effects.reload(); } catch (err) { threw = String(err.message); }
    return { threw, held: k.effects.signature() === was };
  });
  await page.unroute('**/effects/probe', movedRevRoute);
  ok('and a package answering for a revision the listing did not name is refused too, naming the package and both revisions',
    /moved while this page was reading them/.test(strayPackage.threw ?? '')
      && /effect probe was listed at revision/.test(strayPackage.threw ?? '') && strayPackage.held === true,
    strayPackage.threw ? `"${strayPackage.threw.slice(-110)}", the signature ${strayPackage.held ? 'held' : 'moved'}`
      : 'the rebuild reported success on a package from another revision');

  const passThroughList = async (route) => {
    const res = await route.fetch();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(await res.json()) });
  };
  await page.route('**/effects', passThroughList);
  await page.route('**/effects/probe', passThroughList);
  const untouched = await page.evaluate(async () => {
    let threw = null;
    try { await globalThis.__kinect.effects.reload(); } catch (err) { threw = String(err.message); }
    return { threw, knows: globalThis.__kinect.params.names().includes('probe.hue') };
  });
  await page.unroute('**/effects', passThroughList);
  await page.unroute('**/effects/probe', passThroughList);
  ok('while the same two reads with nothing moved are adopted, so both refusals are about the disagreement rather than about being read through',
    untouched.threw === null && untouched.knows === true,
    untouched.threw ?? 'the page adopted the set it was handed');

  // A binding is a manifest field, so an install can move one, and nothing writes a uniform except
  // the parameter bound to it. The shipped `thermal` is the fixture because the failure needs a
  // uniform the *spine* declares.
  console.log('    (and a rebinding that leaves the uniform it moved off)');
  const thermalDir = join(BUILTIN_ROOT, 'thermal');
  const thermalManifest = JSON.parse(readFileSync(join(thermalDir, 'manifest.json'), 'utf8'));
  const reboundThermal = () => {
    const manifest = JSON.parse(JSON.stringify(thermalManifest));
    manifest.version = '2.0.0';
    manifest.params.amount.bind.uniform = 'edges';
    return {
      manifest,
      chunks: Object.fromEntries((thermalManifest.chunks ?? [])
        .map((c) => [c.file, readFileSync(join(thermalDir, c.file), 'utf8')])),
    };
  };

  const atRest = await page.evaluate(async (positions) => {
    globalThis.__kinect.params.reset();
    globalThis.__kinect.drive.reset();
    return globalThis.__kinect.drive.hashes(positions);
  }, POSITIONS);
  const raisedThermal = await page.evaluate(async (positions) => {
    globalThis.__kinect.params.set('thermal.amount', 0.6);
    globalThis.__kinect.drive.reset();
    return {
      hashes: await globalThis.__kinect.drive.hashes(positions),
      uniform: globalThis.__kinect.uniforms.thermal.value,
    };
  }, POSITIONS);
  ok('the term this rebinding abandons is one the picture can see, raised and reading its uniform',
    raisedThermal.uniform === 0.6 && JSON.stringify(raisedThermal.hashes) !== JSON.stringify(atRest),
    `thermal at ${raisedThermal.uniform}, ${raisedThermal.hashes.map((h) => h.slice(0, 8)).join(' ')} `
    + `against ${atRest.map((h) => h.slice(0, 8)).join(' ')} at rest`);

  await put('thermal', reboundThermal());
  const rebound = await page.evaluate(async (positions) => {
    const k = globalThis.__kinect;
    let threw = null;
    try { await k.effects.reload(); } catch (err) { threw = String(err.message); }
    k.params.set('thermal.amount', 0);
    const departed = k.uniforms.thermal.value;
    const arrived = k.uniforms.edges.value;
    k.drive.reset();
    return { threw, departed, arrived, hashes: await k.drive.hashes(positions) };
  }, POSITIONS);
  ok('the fork that rebinds one parameter onto another live uniform installs and is adopted',
    !rebound.threw && rebound.arrived === 0, rebound.threw ?? `edges reads ${rebound.arrived}`);
  ok('the uniform the binding left reads the value the spine declared it with, rather than the one the slider last put there',
    rebound.departed === 0, `thermal reads ${rebound.departed} after the binding moved off it`);
  ok('and the picture follows the registry: with every control back at its default it is the picture the defaults drew',
    JSON.stringify(rebound.hashes) === JSON.stringify(atRest),
    rebound.hashes.map((h, i) => `${h.slice(0, 8)}${h === atRest[i] ? '=' : '!='}${atRest[i].slice(0, 8)}`).join(' '));

  await del('thermal');
  const thermalBack = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    let threw = null;
    try { await k.effects.reload(); } catch (err) { threw = String(err.message); }
    k.params.reset();
    return { threw, uniform: k.uniforms.thermal.value };
  });
  ok('and the shipped package comes back when the fork is removed, with its own uniform driven again',
    thermalBack.threw === null && thermalBack.uniform === 0, thermalBack.threw ?? `thermal reads ${thermalBack.uniform}`);

  // The door is not a compiler and this is the gap that leaves: every identifier in the chunk below
  // is one this build has, so the door has nothing to refuse it for, and it is a type error the
  // driver rejects at link time - reported through a log rather than an exception.
  console.log('\n[effect] 9. a package this build can store and cannot use');

  const broken = await put('probe', brokenProbe());
  ok('the server takes it: every name in it is one this build has, which is all the door can ask',
    broken.status === 200, `${broken.status}: ${broken.body.error ?? 'installed'}`);
  const stored = await getJson('/effects');

  const refused = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    const before = { names: k.params.names(), signature: k.effects.signature() };
    let threw = null;
    try {
      await k.effects.reload();
    } catch (err) { threw = String(err.message); }
    return {
      threw,
      names: k.params.names(),
      same: JSON.stringify(k.params.names()) === JSON.stringify(before.names),
      signature: k.effects.signature(),
      signatureHeld: k.effects.signature() === before.signature,
      note: document.getElementById('tNote')?.textContent ?? '',
      shader: k.effects.programs().cloud.fragmentShader.includes('col = probeAmount;'),
    };
  });
  ok('the page refuses it rather than adopting it, and says the shaders did not compile',
    refused.threw !== null && /did not compile/.test(refused.threw ?? ''),
    refused.threw ? `"${refused.threw.slice(0, 130)}"` : 'the rebuild reported success');
  ok('and it is back on the programs it was drawing with: the registry it had, the signature it had, and none of the broken text',
    refused.same === true && refused.signatureHeld === true && refused.shader === false,
    `${refused.names.length} parameters, the signature ${refused.signatureHeld ? 'held' : 'moved'}, `
    + `the broken line ${refused.shader ? 'reached the assembled program' : 'did not'}`);

  // And the half that is not about this page: rolling back leaves the package where it was, so the
  // next browser compiles it at boot, outside any transaction. Only a link failure may quarantine,
  // which is what the mark on the throw is for.
  const afterRefusal = await getJson('/effects');
  const asides = userRootHolds().filter((name) => /^probe\..+\.incompatible$/.test(name));
  ok('the page has the store set the package aside, so the id stops answering with something that will not compile',
    (afterRefusal.body.effects ?? []).every((e) => e.id !== 'probe')
      && afterRefusal.body.generation === stored.body.generation + 1
      && asides.length === 1,
    `${(afterRefusal.body.effects ?? []).length} packages, generation ${stored.body.generation} -> `
    + `${afterRefusal.body.generation}, user root holds ${userRootHolds().join(', ') || 'nothing'}`);
  ok('and renamed rather than deleted, with every file it arrived with still in it',
    asides.length === 1
      && readdirSync(join(USER_ROOT, asides[0])).sort().join(', ') === 'decl.frag.glsl, manifest.json, tone.frag.glsl',
    asides.length === 1
      ? `${asides[0]} holds ${readdirSync(join(USER_ROOT, asides[0])).sort().join(', ')}`
      : `${asides.length} asides in the user root`);
  // The row the two above exist for: the fresh load that was dying, asked of a browser rather than
  // of a route. Without it a build that called the route and achieved nothing passes both of them.
  const freshPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const freshErrors = [];
  freshPage.on('pageerror', (e) => freshErrors.push(String(e)));
  await freshPage.goto(`${BASE}/record`, { waitUntil: 'load' }).catch(() => {});
  const freshBooted = await freshPage.waitForFunction('Boolean(globalThis.__kinect)', null, { timeout: 20000 })
    .then(() => freshPage.evaluate(() => !globalThis.__kinect.params.names().includes('probe.amount')))
    .catch(() => null);
  ok('and a page opened fresh on that store boots, which is what the package surviving the rollback used to stop',
    freshBooted === true,
    freshBooted === null
      ? `no __kinect published: ${freshErrors[0]?.slice(0, 130) ?? 'nothing arrived on the page error channel'}`
      : `__kinect published, probe.amount ${freshBooted ? 'absent from' : 'in'} the registry`);
  await freshPage.close();

  const mended = await del('probe');
  const mendedPage = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    let threw = null;
    try { await k.effects.reload(); } catch (err) { threw = String(err.message); }
    return { threw, knows: k.params.names().includes('probe.amount') };
  });
  ok('and the page rebuilds from what is left, so a build that cannot compile is a state to leave rather than one to be stuck in',
    mended.status === 404 && mendedPage.threw === null && mendedPage.knows === false,
    `DELETE answered ${mended.status}, ${mendedPage.threw ?? 'the page rebuilt without it'}`);
  if (asides.length === 1) rmSync(join(USER_ROOT, asides[0]), { recursive: true, force: true });

  // The rollback has to cover the adoption itself. A package written into the user root by hand
  // assembles fine and makes `buildPanel` throw *after* the registry and programs are replaced.
  const outside = join(USER_ROOT, 'probebad');
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, 'manifest.json'), `${JSON.stringify({
    format: 1,
    id: 'probebad',
    version: '1.0.0',
    title: 'Probe Bad',
    params: {
      amount: {
        def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', label: 'probe bad',
        panel: { group: 'nosuchgroup', tab: 'look' },
        bind: { on: 'points', uniform: 'probeBadAmount' },
        role: 'master',
      },
    },
  }, null, 2)}\n`);
  const unusable = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    const before = { names: k.params.names(), signature: k.effects.signature() };
    let threw = null;
    try { await k.effects.reload(); } catch (err) { threw = String(err.message); }
    const rows = [...document.querySelectorAll('#panelBody [data-group] input')].map((i) => i.id);
    return {
      threw,
      same: JSON.stringify(k.params.names()) === JSON.stringify(before.names),
      signatureHeld: k.effects.signature() === before.signature,
      knows: k.params.names().includes('probebad.amount'),
      rowsMatchRegistry: k.params.names().filter((n) => rows.includes(n)).length === rows.length && rows.length > 0,
    };
  });
  ok('a package written past the door is refused by the page, and the refusal comes out of the adoption rather than out of the document',
    unusable.threw !== null && /nosuchgroup|name no panel group/.test(unusable.threw ?? ''),
    unusable.threw ? `"${unusable.threw.slice(0, 120)}"` : 'the rebuild reported success');
  ok('and the page is whole afterwards: the registry it had, the signature it had, and a panel whose rows are that registry',
    unusable.same === true && unusable.signatureHeld === true && unusable.knows === false
      && unusable.rowsMatchRegistry === true,
    `the registry ${unusable.same ? 'held' : 'moved'}, the signature ${unusable.signatureHeld ? 'held' : 'moved'}, `
    + `the panel's rows ${unusable.rowsMatchRegistry ? 'are all registry names' : 'do not match the registry'}`);
  rmSync(outside, { recursive: true, force: true });
  const afterOutside = await page.evaluate(async () => {
    let threw = null;
    try { await globalThis.__kinect.effects.reload(); } catch (err) { threw = String(err.message); }
    return { threw, names: globalThis.__kinect.params.names().length };
  });
  ok('and removing it lets the page rebuild again, so the refusal is a state to leave rather than one to be stuck in',
    afterOutside.threw === null, afterOutside.threw ?? `${afterOutside.names} parameters`);

  // A rollback puts the old signature back, so the poll goes on saying the store moved - not a
  // reason to try the same rebuild ten times a minute. Placed here rather than in section 6,
  // measured: there `reinstall-leaves-it-parked` ended the run at 60 of 107 assertions.
  const refusedFork = await put('probe', forkedProbe());
  await page.evaluate(() => globalThis.__kinect.effects.pollNow());
  await page.waitForFunction(
    "/probe\\.glow/.test(document.getElementById('tNote')?.textContent ?? '')", null, { timeout: 20000 },
  ).catch(() => {});
  const refusedNote = await page.evaluate(() => document.getElementById('tNote')?.textContent ?? '');
  ok('the fork the page cannot carry its document onto is installed again and refused again, which is the state the block is about',
    refusedFork.status === 200 && /probe\.glow/.test(refusedNote),
    `${refusedFork.status}: ${refusedFork.body.error ?? 'installed'}, the note reads "${refusedNote.trim().slice(0, 70)}"`);

  let refusedListReads = 0;
  let refusedPackageReads = 0;
  await page.route('**/effects', async (route) => { refusedListReads += 1; await route.continue(); });
  await page.route('**/effects/probe', async (route) => { refusedPackageReads += 1; await route.continue(); });
  await page.evaluate(() => globalThis.__kinect.effects.pollNow());
  // Two listings rather than a fixed pause, because the interval is six seconds and the driver's
  // own call can be answered by the guard.
  for (let waited = 0; waited < 20000 && refusedListReads < 2; waited += 100) await wait(100);
  await page.evaluate(() => globalThis.__kinect.effects.pollNow());
  await wait(500);
  await page.unroute('**/effects');
  await page.unroute('**/effects/probe');
  ok('a set this page has already refused is not fetched again on every tick, while the poll itself goes on running',
    refusedListReads >= 2 && refusedPackageReads === 0,
    `${refusedListReads} listings read and ${refusedPackageReads} package reads in the window`);

  await put('probe', retunedProbe());
  const unblocked = await page.evaluate(() => globalThis.__kinect.effects.pollNow())
    .then(() => page.waitForFunction(
      "globalThis.__kinect.params.names().includes('probe.hue')", null, { timeout: 20000 },
    ))
    .then(() => true).catch(() => false);
  ok('and a revision it has not refused is adopted, so the block is keyed to the set rather than latched on the page',
    unblocked === true, unblocked ? 'the page adopted the next revision' : 'the page never adopted it');

  // A refusal is this build saying it cannot use what the store holds; a read that did not work
  // says nothing about the other side. Planted on the package route and not on the listing, since
  // the page's own interval would spend a one-shot failure planted there on a tick.
  const signatureNow = async () => {
    const listed = await getJson('/effects');
    return (listed.body.effects ?? []).map((e) => `${e.id} ${e.rev}`).join('\n');
  };
  const moved = await put('probe', relabelledProbe());
  const movedSignature = await signatureNow();
  let failedReads = 0;
  failingPackageRead = true;
  const failOnce = async (route) => {
    if (failedReads === 0) { failedReads += 1; return route.abort('failed'); }
    return route.continue();
  };
  await page.route('**/effects/probe', failOnce);
  await page.evaluate(() => globalThis.__kinect.effects.pollNow());
  const afterFailedRead = await page.evaluate(() => globalThis.__kinect.effects.signature());
  await page.unroute('**/effects/probe', failOnce);
  failingPackageRead = false;
  ok('a revision this page has not seen is installed and one package read of it is failed, so the tick below follows a read error rather than a refusal',
    moved.status === 200 && failedReads === 1 && afterFailedRead !== movedSignature,
    `${moved.status}: ${moved.body.error ?? 'installed'}, ${failedReads} package read failed, and the page `
    + `${afterFailedRead === movedSignature ? 'adopted the revision anyway' : 'held the set it had'}`);
  await page.evaluate(() => globalThis.__kinect.effects.pollNow());
  const retried = await page.waitForFunction(
    (sig) => globalThis.__kinect.effects.signature() === sig, movedSignature, { timeout: 20000 },
  ).then(() => true).catch(() => false);
  ok('and the next tick adopts it, because a fetch that did not work is no evidence about the set on the other side of it',
    retried === true,
    retried ? 'the page came back to the store\'s current signature' : 'the page never came back to the store\'s signature');

  // A uniform cell is a number for a plain binding and a two-component vector for an `axisDeg` one,
  // so a fork exchanging two bindings' shapes throws mid-walk with the registry already swapped.
  // An adoption that minted only missing cells then died in the rollback on the number it had left.
  const cellShapes = () => page.evaluate(() => {
    const shape = (cell) => {
      if (!cell) return 'missing';
      if (typeof cell.value === 'number') return 'number';
      return cell.value && typeof cell.value.set === 'function' ? 'vector' : 'other';
    };
    const k = globalThis.__kinect;
    return {
      axis: shape(k.uniforms.probeShapeAxis),
      tone: shape(k.uniforms.probeShapeTone),
      names: k.params.names().filter((n) => n.startsWith('probeshape.')),
    };
  });

  await put('probeshape', shapedProbe());
  const shaped = await page.evaluate(async () => {
    try { await globalThis.__kinect.effects.reload(); } catch (err) { return { threw: String(err.message) }; }
    const k = globalThis.__kinect;
    k.params.set('probeshape.amount', 0.4);
    k.params.set('probeshape.angle', 90);
    k.params.set('probeshape.tone', 0.25);
    return { threw: null, held: k.library.serialiseProjectBody().clips[0].params['probeshape.angle'] ?? null };
  });
  const shapesBefore = await cellShapes();
  ok('a package binding one cell of each shape installs and is adopted, with the document holding its values',
    !shaped.threw && shaped.held === 90 && shapesBefore.names.length === 3,
    shaped.threw ?? `${shapesBefore.names.length} parameters, the document holds angle at ${shaped.held}`);
  ok('and the two cells are the two shapes this arm is about, which is what makes the swap below a swap',
    shapesBefore.axis === 'vector' && shapesBefore.tone === 'number',
    `probeShapeAxis is a ${shapesBefore.axis}, probeShapeTone is a ${shapesBefore.tone}`);

  await put('probeshape', reshapedProbe());
  const reshaped = await page.evaluate(async () => {
    const k = globalThis.__kinect;
    const before = k.params.names();
    let threw = null;
    try { await k.effects.reload(); } catch (err) { threw = String(err.message); }
    return { threw, same: JSON.stringify(k.params.names()) === JSON.stringify(before) };
  });
  const shapesAfter = await cellShapes();
  ok('the fork that swaps both shapes is refused by the document rather than by the table, so the rollback is what ran',
    /probeshape\.glow/.test(reshaped.threw ?? '') && /still running the effects it had/.test(reshaped.threw ?? ''),
    reshaped.threw ? `"${reshaped.threw.slice(0, 130)}"` : 'the rebuild reported success');
  ok('and the rollback finished rather than dying in the table it was rolling back through',
    !/reload the page/.test(reshaped.threw ?? '') && reshaped.same === true,
    reshaped.same ? 'the registry is the one this page had' : 'the registry moved');
  ok('the cells are the shapes the registry this page is holding demands, which is what a rollback through them has to leave',
    shapesAfter.axis === 'vector' && shapesAfter.tone === 'number',
    `probeShapeAxis is a ${shapesAfter.axis}, probeShapeTone is a ${shapesAfter.tone}`);

  await page.evaluate(() => {
    const k = globalThis.__kinect;
    for (const name of k.params.names().filter((n) => n.startsWith('probeshape.'))) {
      k.params.set(name, k.params.spec(name).default);
    }
  }).catch(() => {});
  await del('probeshape');
  const unshaped = await page.evaluate(async () => {
    let threw = null;
    try { await globalThis.__kinect.effects.reload(); } catch (err) { threw = String(err.message); }
    const k = globalThis.__kinect;
    return {
      threw,
      knows: k.params.names().some((n) => n.startsWith('probeshape.')),
      parked: Object.keys((({ clips, project }) => Object.assign(
        {}, ...clips.map((c) => c.params), project.params,
      ))(k.library.parkedLook()))
        .filter((n) => n.startsWith('probeshape.')).length,
    };
  });
  ok('and taking it back off leaves the page rebuilding cleanly with nothing of it parked',
    unshaped.threw === null && unshaped.knows === false && unshaped.parked === 0,
    unshaped.threw ?? `${unshaped.parked} probeshape values parked`);

  // Last, and the position is the finding rather than housekeeping: everything here leaves a
  // directory that is not a package, and under `temporaries-are-visible` the store then cannot list
  // at all - staged in section 1 it would have reddened every row of every section after it.
  console.log('\n[effect] 10. and what a crashed install leaves behind is invisible until it is swept');

  const beforeStale = await getJson('/effects');
  const stale = join(USER_ROOT, 'probe.99999.tmp');
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'manifest.json'), '{"this is": "not a package"}');
  ok('a half-written package is on disk, so the rows under this are about something',
    existsSync(stale), 'probe.99999.tmp staged in the user root');
  const withStale = await getJson('/effects');
  ok('a half-written package is in no listing - its name carries a dot and an effect id may not',
    withStale.status === 200
      && withStale.body.effects?.length === beforeStale.body.effects?.length
      && !withStale.body.effects.some((e) => e.id.includes('.')),
    `answered ${withStale.status} with ${withStale.body.effects?.length ?? 'no'} packages, `
    + `${beforeStale.body.effects?.length ?? 'no'} before it was staged`);
  const staleRead = await getJson('/effects/probe.99999.tmp');
  ok('and no read resolves it', staleRead.status === 404, `answered ${staleRead.status}`);
  const sweeping = await put('probe', probePackage());
  ok('and the next install of that id sweeps it, so a machine that crashed mid-install does not accumulate copies',
    sweeping.status === 200 && !existsSync(stale),
    `${sweeping.status}: ${sweeping.body.error ?? 'installed'}, user root ${userRootHolds().join(', ') || 'empty'}`);

  ok('the page reported no error through any of it', pageErrors.length === 0,
    pageErrors.slice(0, 2).join(' | '));

  // The one place this store can lose work, and it is three lines wide: between `install`'s two
  // renames the id resolves to nothing, so a machine losing power there comes back with the only
  // copy in `<id>.<seq>.old`. Driven by restarting the server, with the browser closed first.
  console.log('\n[effect] 11. an install interrupted between its two renames, and what the next start does about it');

  await browser.close();
  browser = null;

  // The name rule stops a path in the request and says nothing about a path already on disk, so a
  // link called `leak.txt` was a path the route would build, follow and serve from
  // wherever it aimed.
  const secret = join(WORK, 'not-a-package-file.txt');
  writeFileSync(secret, 'this text is outside both effect roots\n');
  const linkRoot = join(USER_ROOT, 'probelink');
  mkdirSync(linkRoot, { recursive: true });
  writeFileSync(join(linkRoot, 'manifest.json'), `${JSON.stringify({
    format: 1, id: 'probelink', version: '1.0.0', title: 'Probe Link', params: {},
  }, null, 2)}\n`);
  writeFileSync(join(linkRoot, 'notes.txt'), 'an ordinary file in a package directory\n');
  symlinkSync(secret, join(linkRoot, 'leak.txt'));
  const leaked = await fetch(`${BASE}/effects/probelink/file/leak.txt`);
  const leakedText = await leaked.text();
  ok('a symlink planted in a package directory is not a package file, whatever it points at',
    leaked.status === 404 && !leakedText.includes('outside both effect roots'),
    `answered ${leaked.status}${leakedText.includes('outside both effect roots') ? ' with the bytes it pointed at' : ''}`);
  const served = await fetch(`${BASE}/effects/probelink/file/notes.txt`);
  const servedText = await served.text();
  ok('and an ordinary file in the same directory still serves, so the rule above is about the kind rather than about the route',
    served.status === 200 && servedText.includes('an ordinary file in a package directory'),
    `answered ${served.status} with ${servedText.length} bytes`);
  const listedWithLink = await getJson('/effects/probelink');
  ok('and it is in no file index either, so nothing anywhere offers it',
    listedWithLink.status === 200
      && listedWithLink.body.files.some((f) => f.name === 'notes.txt')
      && !listedWithLink.body.files.some((f) => f.name === 'leak.txt'),
    listedWithLink.body.files?.map((f) => f.name).join(', ') ?? 'no index');
  rmSync(linkRoot, { recursive: true, force: true });

  await stopAll();

  const crashedAside = join(USER_ROOT, 'probe.4711.tmpseq.old');
  rmSync(join(USER_ROOT, 'probe'), { recursive: true, force: true });
  rmSync(crashedAside, { recursive: true, force: true });
  mkdirSync(crashedAside, { recursive: true });
  writeFileSync(join(crashedAside, 'manifest.json'), `${JSON.stringify(probeManifest(), null, 2)}\n`);
  for (const [name, text] of Object.entries(probeChunks())) writeFileSync(join(crashedAside, name), text);
  writeFileSync(join(crashedAside, 'witness.marker'), 'the copy that was live when the machine went down\n');
  ok('a crashed install is staged: the package is in its aside and the id resolves to nothing',
    existsSync(crashedAside) && !existsSync(join(USER_ROOT, 'probe')),
    `user root holds ${userRootHolds().join(', ')}`);

  await start();
  const recovered = await getJson('/effects/probe');
  ok('the next start puts it back, so the copy a crash orphaned is the copy the store comes up on',
    recovered.status === 200 && recovered.body.builtin === false
      && existsSync(join(USER_ROOT, 'probe', 'witness.marker')),
    `answered ${recovered.status}, builtin=${recovered.body.builtin}, user root ${userRootHolds().join(', ')}`);
  ok('and the aside is gone rather than left beside the copy it became, so nothing accumulates',
    !existsSync(crashedAside), `user root ${userRootHolds().join(', ')}`);

  const removedForGood = await del('probe');
  const goneAsides = userRootHolds();
  await stopAll();
  await start();
  const stillGone = await getJson('/effects/probe');
  ok('an uninstall is not a crashed install: the package stays removed across a restart',
    removedForGood.status === 200 && stillGone.status === 404,
    `after the restart the store answers ${stillGone.status} for probe, `
    + `user root ${userRootHolds().join(', ') || 'empty'} (was ${goneAsides.join(', ') || 'empty'})`);

  // A package gets through the door once, against the build running that day, and a fork outlives
  // it. The gate is the install door asked a second time rather than a second gate, so
  // nothing can drift.
  console.log('\n[effect] 12. a fork from an earlier build, met at the next start');

  await stopAll();

  // A fork of a shipped package rather than of `probe`, because the reading that says the gate did
  // something is the id going back to answering with the builtin. The joint is renamed, not broken.
  const doctored = JSON.parse(readFileSync(join(BUILTIN_ROOT, 'thermal/manifest.json'), 'utf8'));
  doctored.version = '2.0.0';
  doctored.chunks = doctored.chunks.map((c) => ({ ...c, stage: 'f.thisjointwentaway' }));
  const staleFork = join(USER_ROOT, 'thermal');
  rmSync(staleFork, { recursive: true, force: true });
  mkdirSync(staleFork, { recursive: true });
  writeFileSync(join(staleFork, 'manifest.json'), `${JSON.stringify(doctored, null, 2)}\n`);
  writeFileSync(join(staleFork, 'heat.frag.glsl'), readFileSync(join(BUILTIN_ROOT, 'thermal/heat.frag.glsl'), 'utf8'));
  writeFileSync(join(staleFork, 'witness.marker'), 'the author\'s own copy of a package this build cannot use\n');

  // A second fork with nothing wrong with it, which is the control this section did not have: a
  // gate that renamed every user package aside would satisfy every row below. `rain` because it
  // sorts before `thermal`, which is the order that made the blame land on the wrong package.
  const healthy = JSON.parse(readFileSync(join(BUILTIN_ROOT, 'rain/manifest.json'), 'utf8'));
  healthy.version = '2.0.0';
  const healthyFork = join(USER_ROOT, 'rain');
  rmSync(healthyFork, { recursive: true, force: true });
  mkdirSync(healthyFork, { recursive: true });
  writeFileSync(join(healthyFork, 'manifest.json'), `${JSON.stringify(healthy, null, 2)}\n`);
  for (const c of healthy.chunks ?? []) {
    writeFileSync(join(healthyFork, c.file), readFileSync(join(BUILTIN_ROOT, 'rain', c.file), 'utf8'));
  }

  // A directory with a name longer than an id may be, which used to stop the server booting: every
  // aside is the id plus about thirty characters, so a rename of one throws `ENAMETOOLONG` out of
  // the gate. 240 rather than 100, measured - 100 renames to 128 and stays inside `NAME_MAX`.
  const overlong = 'z'.repeat(240);
  const overlongDir = join(USER_ROOT, overlong);
  rmSync(overlongDir, { recursive: true, force: true });
  mkdirSync(overlongDir, { recursive: true });
  writeFileSync(join(overlongDir, 'manifest.json'), `${JSON.stringify({
    format: 1, id: overlong, version: '1.0.0', title: 'A name from a build with no bound on one', params: {},
  }, null, 2)}\n`);

  ok('a fork this build can no longer assemble is staged where a fork installed by an earlier build would be, beside a healthy one and a name too long to rename',
    existsSync(join(staleFork, 'manifest.json')) && existsSync(join(healthyFork, 'manifest.json'))
      && existsSync(join(overlongDir, 'manifest.json')),
    `user root holds ${userRootHolds().map((n) => (n.length > 20 ? `${n.slice(0, 12)}…(${n.length})` : n)).join(', ')}`);

  await start();

  const servedRain = await getJson('/effects/rain');
  ok('the healthy fork beside it is still served, so the gate refuses a package rather than everything standing next to one',
    servedRain.status === 200 && servedRain.body.builtin === false
      && servedRain.body.manifest?.version === '2.0.0',
    `answered ${servedRain.status}, builtin=${servedRain.body.builtin}, `
    + `version ${JSON.stringify(servedRain.body.manifest?.version)}`);
  ok('and it is the only user package left standing, so exactly one of the three staged directories is serving',
    userRootHolds().filter((n) => !n.includes('.')).join(',') === 'rain',
    `user root holds ${userRootHolds().map((n) => (n.length > 20 ? `${n.slice(0, 12)}…(${n.length})` : n)).join(', ')}`);

  const overlongAsides = userRootHolds().filter((n) => n.startsWith('z') && n.endsWith('.incompatible'));
  ok('the directory whose name is longer than an id is set aside under a truncated one, rather than throwing out of the gate and taking the boot with it',
    !existsSync(overlongDir) && overlongAsides.length === 1 && overlongAsides[0].length < 255,
    `${existsSync(overlongDir) ? `it still holds its own ${overlong.length}-character name` : 'its own name is gone'}, `
    + `and the user root holds ${overlongAsides.length} aside for it${overlongAsides[0] ? ` at ${overlongAsides[0].length} characters` : ''}`);

  const servedThermal = await getJson('/effects/thermal');
  ok('the next start hands the id back to the package this build ships, rather than serving a fork it cannot assemble',
    servedThermal.status === 200 && servedThermal.body.builtin === true
      && servedThermal.body.manifest?.version === '1.0.0',
    `answered ${servedThermal.status}, builtin=${servedThermal.body.builtin}, `
    + `version ${JSON.stringify(servedThermal.body.manifest?.version)}`);

  const setAsides = userRootHolds().filter((n) => /^thermal\..*\.incompatible$/.test(n));
  ok('and the fork is renamed aside rather than deleted, with its files exactly as they were',
    setAsides.length === 1
      && existsSync(join(USER_ROOT, setAsides[0], 'witness.marker'))
      && readFileSync(join(USER_ROOT, setAsides[0], 'manifest.json'), 'utf8').includes('f.thisjointwentaway'),
    `user root holds ${userRootHolds().join(', ') || 'empty'}`);

  const asideRead = await getJson(`/effects/${setAsides[0] ?? 'thermal.0.incompatible'}`);
  const listedAfterAside = await getJson('/effects');
  ok('and the aside is a name no read resolves and no listing carries, by the rule that hides a half-written install',
    setAsides.length === 1 && asideRead.status === 404
      && !(listedAfterAside.body.effects ?? []).some((e) => e.id.includes('.')),
    `the aside answered ${asideRead.status}, and the listing carries `
    + `${(listedAfterAside.body.effects ?? []).length} ids, none of them dotted`);

  ok('and the start said so, carrying the door\'s own sentence rather than a summary of it',
    /effect thermal was installed by an earlier build/.test(serverLog)
      && /does not assemble/.test(serverLog) && /\.incompatible/.test(serverLog),
    (serverLog.split('\n').find((l) => /^effect thermal/.test(l))
      ?? `nothing about thermal in ${serverLog.length} bytes of server log`).slice(0, 160));

  // The row the four above exist for: a store answering perfectly is beside the point if the
  // surface it feeds does not come up, so the last thing asked is the first thing that broke.
  browser = await chromium.launch();
  const bootPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const bootErrors = [];
  bootPage.on('pageerror', (e) => bootErrors.push(String(e)));
  await bootPage.goto(`${BASE}/record`, { waitUntil: 'load' }).catch(() => {});
  const booted = await bootPage.waitForFunction('Boolean(globalThis.__kinect)', null, { timeout: 20000 })
    .then(() => bootPage.evaluate(() => globalThis.__kinect.params.names().includes('thermal.amount')))
    .catch(() => null);
  ok('and a page opened on that store boots, with the shipped package in its registry - which is the failure the whole gate is about',
    booted === true,
    booted === null
      ? `no __kinect published: ${bootErrors[0]?.slice(0, 130) ?? 'nothing arrived on the page error channel'}`
      : `__kinect published, thermal.amount ${booted ? 'in' : 'missing from'} the registry`);

  // The gate renames directories and used to do it at construction, before the port is held. The
  // port is the lock: the gate runs inside `listen`'s callback and everything it does is
  // synchronous `fs`.
  console.log('\n[effect] 13. a second server on a held port renames nothing');

  const loserRoot = join(WORK, 'effects-loser');
  rmSync(loserRoot, { recursive: true, force: true });
  const loserFork = join(loserRoot, 'thermal');
  mkdirSync(loserFork, { recursive: true });
  writeFileSync(join(loserFork, 'manifest.json'), `${JSON.stringify(doctored, null, 2)}\n`);
  writeFileSync(join(loserFork, 'heat.frag.glsl'), readFileSync(join(BUILTIN_ROOT, 'thermal/heat.frag.glsl'), 'utf8'));
  writeFileSync(join(loserFork, 'witness.marker'), 'the copy a process that never served must not touch\n');
  ok('a second effects root is staged holding a fork this build refuses, and a server is already listening on the port',
    existsSync(join(loserFork, 'witness.marker')) && readdirSync(loserRoot).join(',') === 'thermal',
    `the loser's root holds ${readdirSync(loserRoot).join(', ')}`);

  const loser = spawn(process.execPath, [
    join(WORK, 'server/index.js'), '--port', String(PORT),
    '--effects', loserRoot, '--builtin-effects', BUILTIN_ROOT,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const loserOut = [];
  loser.stdout.on('data', (c) => loserOut.push(c.toString()));
  loser.stderr.on('data', (c) => loserOut.push(c.toString()));
  let loserDeadline = null;
  const loserCode = await Promise.race([
    new Promise((done) => { loser.on('close', done); }),
    new Promise((done) => { loserDeadline = setTimeout(() => { loser.kill('SIGKILL'); done('never exited'); }, 20000); }),
  ]);
  clearTimeout(loserDeadline);
  const loserSaid = loserOut.join('');
  ok('the second server loses the port and exits without serving, which is the only reason it must not have gated anything',
    loserCode !== 0 && loserCode !== 'never exited' && /EADDRINUSE/.test(loserSaid),
    `exited ${loserCode}, and its output ${/EADDRINUSE/.test(loserSaid) ? 'names EADDRINUSE' : `does not name EADDRINUSE: ${loserSaid.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 110) ?? '(nothing)'}`}`);
  ok('and the fork in its root is exactly where it was, because a process that never held the port never gated anything',
    existsSync(join(loserFork, 'witness.marker')) && readdirSync(loserRoot).join(',') === 'thermal',
    `the loser's root holds ${readdirSync(loserRoot).join(', ') || 'nothing'}`);

  // A refusal and a read error are told apart by whether asking again could answer differently, and
  // that line does not run along "the fetch worked". Written straight into the user root while the
  // server is up, because the install door refuses this manifest and so does the boot gate.
  console.log('\n[effect] 14. a package the store serves and this page refuses, asked once');

  const shapeless = join(USER_ROOT, 'shapeless');
  rmSync(shapeless, { recursive: true, force: true });
  mkdirSync(shapeless, { recursive: true });
  writeFileSync(join(shapeless, 'manifest.json'), `${JSON.stringify({
    format: 1,
    id: 'shapeless',
    version: '1.0.0',
    title: 'Shapeless',
    params: {
      amount: {
        def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', label: 'shapeless',
        panel: { group: 'style', tab: 'look' }, bind: { on: 'points', uniform: 'thermal' }, role: 'master',
      },
    },
    chunks: 'this is not a list of chunks',
  }, null, 2)}\n`);
  const listedShapeless = await getJson('/effects');
  const shapelessListed = (listedShapeless.body.effects ?? []).some((e) => e.id === 'shapeless');
  // Every driver call here is guarded: a mutation elsewhere can leave the page with no `__kinect`,
  // and an unguarded `evaluate` then ends the run, turning rows that would have gone red into rows
  // nobody measured. Caught, the rows below read a page that answered nothing and redden.
  const poll = () => bootPage.evaluate(() => globalThis.__kinect.effects.pollNow()).catch(() => {});
  await poll();
  const shapelessNote = await bootPage.waitForFunction(
    "/shapeless/.test(document.getElementById('tNote')?.textContent ?? '')", null, { timeout: 20000 },
  ).then(() => bootPage.evaluate(() => document.getElementById('tNote')?.textContent ?? '')).catch(() => '');
  ok('the store is serving a package whose manifest this page refuses, and the page says so rather than adopting it',
    shapelessListed && /shapeless/.test(shapelessNote),
    `the listing ${shapelessListed ? 'carries' : 'does not carry'} shapeless, and the note reads "${shapelessNote.trim().slice(0, 90)}"`);

  let shapelessListReads = 0;
  let shapelessPackageReads = 0;
  await bootPage.route('**/effects', async (route) => { shapelessListReads += 1; await route.continue(); });
  await bootPage.route('**/effects/shapeless', async (route) => { shapelessPackageReads += 1; await route.continue(); });
  await poll();
  for (let waited = 0; waited < 20000 && shapelessListReads < 2; waited += 100) await wait(100);
  await poll();
  await wait(500);
  await bootPage.unroute('**/effects');
  await bootPage.unroute('**/effects/shapeless');
  ok('and it is not fetched again on every tick, because a body this build refuses is served content rather than a read that did not work',
    shapelessListReads >= 2 && shapelessPackageReads === 0,
    `${shapelessListReads} listings read and ${shapelessPackageReads} package reads in the window`);

  rmSync(shapeless, { recursive: true, force: true });
  const afterShapeless = await put('probe', probePackage());
  const adoptedAfter = await poll()
    .then(() => bootPage.waitForFunction(
      "globalThis.__kinect.params.names().includes('probe.amount')", null, { timeout: 20000 },
    ))
    .then(() => true).catch(() => false);
  ok('and a revision this page has not refused is still adopted afterwards, so the block is keyed to the set rather than latched on the page',
    afterShapeless.status === 200 && adoptedAfter === true,
    `${afterShapeless.status}: ${afterShapeless.body.error ?? 'installed'}, and the page `
    + `${adoptedAfter ? 'adopted it' : 'never adopted it'}`);

  await browser.close();
  browser = null;

  // Section 12 asks whether the gate refuses a package this build cannot assemble; this asks the
  // half that is not about the package at all - a `rain` fork with `vRain` gone that is correct
  // about itself, while the builtin glyph goes on reading `vRain` with nothing declaring it.
  console.log('\n[effect] 15. a fork that is correct about itself and takes its neighbour down');

  await stopAll();
  for (const held of userRootHolds()) rmSync(join(USER_ROOT, held), { recursive: true, force: true });

  // The healthy fork is `glyph` because it is the package the rain fork actually breaks, so a gate
  // with the attribution backwards blames it. It has to be standing at the end.
  const healthyGlyph = JSON.parse(readFileSync(join(BUILTIN_ROOT, 'glyph/manifest.json'), 'utf8'));
  healthyGlyph.version = '2.0.0';
  const glyphFork = join(USER_ROOT, 'glyph');
  mkdirSync(glyphFork, { recursive: true });
  writeFileSync(join(glyphFork, 'manifest.json'), `${JSON.stringify(healthyGlyph, null, 2)}\n`);
  for (const c of healthyGlyph.chunks ?? []) {
    writeFileSync(join(glyphFork, c.file), readFileSync(join(BUILTIN_ROOT, 'glyph', c.file), 'utf8'));
  }

  const strippedRain = JSON.parse(readFileSync(join(BUILTIN_ROOT, 'rain/manifest.json'), 'utf8'));
  strippedRain.version = '2.0.0';
  strippedRain.varyings = [];
  const rainFork = join(USER_ROOT, 'rain');
  mkdirSync(rainFork, { recursive: true });
  writeFileSync(join(rainFork, 'manifest.json'), `${JSON.stringify(strippedRain, null, 2)}\n`);
  for (const c of strippedRain.chunks ?? []) {
    const shipped = readFileSync(join(BUILTIN_ROOT, 'rain', c.file), 'utf8');
    writeFileSync(join(rainFork, c.file), c.file === 'cell.vert.glsl'
      ? shipped.replace(/^.*\bvRain\b.*$/gm, '  // the varying this fork dropped')
      : shipped.replace(/fract\(vRain\)/g, '0.5'));
  }
  writeFileSync(join(rainFork, 'witness.marker'), 'the author\'s own copy of a fork this build cannot keep\n');

  ok('a fork with nothing wrong with it and a fork that drops a varying its neighbour reads are both staged',
    existsSync(join(rainFork, 'manifest.json')) && existsSync(join(glyphFork, 'manifest.json'))
      && !/vRain/.test(readFileSync(join(rainFork, 'cell.vert.glsl'), 'utf8')),
    `user root holds ${userRootHolds().join(', ')}`);

  await start();

  const settledRain = await getJson('/effects/rain');
  ok('the fork that broke its neighbour is the one set aside, and the id answers from the shipped package again',
    settledRain.status === 200 && settledRain.body.builtin === true,
    `answered ${settledRain.status}, builtin=${settledRain.body.builtin}, `
    + `version ${JSON.stringify(settledRain.body.manifest?.version)}`);
  const settledGlyph = await getJson('/effects/glyph');
  ok('and the fork it broke is left exactly where it was, because the package that changed is the package that goes',
    settledGlyph.status === 200 && settledGlyph.body.builtin === false
      && settledGlyph.body.manifest?.version === '2.0.0',
    `answered ${settledGlyph.status}, builtin=${settledGlyph.body.builtin}, `
    + `version ${JSON.stringify(settledGlyph.body.manifest?.version)}`);
  const rainAsides = userRootHolds().filter((n) => /^rain\..*\.incompatible$/.test(n));
  ok('the fork is renamed aside rather than deleted, with the author\'s own file still in it',
    rainAsides.length === 1 && existsSync(join(USER_ROOT, rainAsides[0], 'witness.marker')),
    `user root holds ${userRootHolds().join(', ') || 'empty'}`);
  ok('and the start said which package it could no longer assemble, rather than only which one it moved',
    /effect rain was installed by an earlier build/.test(serverLog)
      && /can no longer assemble glyph/.test(serverLog) && /vRain/.test(serverLog),
    (serverLog.split('\n').find((l) => /^effect rain/.test(l))
      ?? `nothing about rain in ${serverLog.length} bytes of server log`).slice(0, 170));

  // The row the four above exist for, on section 12's argument: a store that answered perfectly and
  // a page that never published `__kinect` is the build this whole surface is arranged to prevent.
  browser = await chromium.launch();
  const settledPage = await browser.newPage({ viewport: { width: 800, height: 600 } });
  const settledErrors = [];
  settledPage.on('pageerror', (e) => settledErrors.push(String(e)));
  await settledPage.goto(`${BASE}/record`, { waitUntil: 'load' }).catch(() => {});
  const settledBoot = await settledPage.waitForFunction('Boolean(globalThis.__kinect)', null, { timeout: 20000 })
    .then(() => settledPage.evaluate(() => globalThis.__kinect.params.names().includes('rain.speed')))
    .catch(() => null);
  ok('and a page opened on the store the gate settled boots, which is the failure the whole pass is about',
    settledBoot === true,
    settledBoot === null
      ? `no __kinect published: ${settledErrors[0]?.slice(0, 130) ?? 'nothing arrived on the page error channel'}`
      : `__kinect published, rain.speed ${settledBoot ? 'in' : 'missing from'} the registry`);

  // This build has no GLSL compiler and the door is not one, so the only thing that ever learns a
  // package cannot be compiled is a page that tried. Section 9 is the page half; these rows are the
  // route's own contract, driven over HTTP, since its skipped and refused answers have
  // no other reader.
  console.log('\n[effect] 16. the route a page uses to say a package would not compile');

  const beforeRefuse = await getJson('/effects');
  const quarantined = await fetch(`${BASE}/effect-refusals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: ['glyph', 'thermal', 'nosuchpackage'], reason: 'link failed:\n  not a compiler' }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  ok('a page naming a package it could not compile has the user copy set aside, and the id answers from the builtin again',
    quarantined.status === 200 && quarantined.body.setAside?.join(',') === 'glyph'
      && (await getJson('/effects/glyph')).body.builtin === true,
    `${quarantined.status}: set aside ${JSON.stringify(quarantined.body.setAside)}`);
  ok('and a builtin and a name that is nowhere are each skipped with a reason rather than refusing the whole call',
    quarantined.body.skipped?.length === 2
      && quarantined.body.skipped.every((s) => /no copy of it in the user root/.test(s.why))
      && quarantined.body.skipped.map((s) => s.id).sort().join(',') === 'nosuchpackage,thermal',
    `skipped ${JSON.stringify(quarantined.body.skipped?.map((s) => s.id))}`);
  const afterRefuse = await getJson('/effects');
  ok('the store counts it as a change of its own, because what every open page is holding a listing of has moved',
    afterRefuse.body.generation === beforeRefuse.body.generation + 1,
    `generation ${beforeRefuse.body.generation} -> ${afterRefuse.body.generation}`);
  ok('and the shipped set is all still there, so a route that renames one directory renamed one directory',
    afterRefuse.body.effects?.length === beforeRefuse.body.effects.length
      && (afterRefuse.body.effects ?? []).every((e) => e.builtin),
    `${afterRefuse.body.effects?.length ?? 'no'} packages, `
    + `${(afterRefuse.body.effects ?? []).filter((e) => !e.builtin).length} of them from the user root`);
  ok('the page\'s reason reaches the log as one line rather than as whatever a driver emitted',
    /a page that adopted it reports that it does not compile: link failed: not a compiler/.test(serverLog),
    (serverLog.split('\n').find((l) => /does not compile/.test(l)) ?? 'nothing in the log about it').slice(0, 150));

  const noList = await fetch(`${BASE}/effect-refusals`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: 'x' }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  const tooMany = await fetch(`${BASE}/effect-refusals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: new Array(afterRefuse.body.effects.length + 1).fill('glyph') }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  ok('a body with no list and a list longer than the store has packages are both refused by name',
    noList.status === 400 && tooMany.status === 400 && /not about this store/.test(tooMany.body.error ?? ''),
    `${noList.status} and ${tooMany.status}: ${(tooMany.body.error ?? '').slice(0, 80)}`);
  const getRefuse = await fetch(`${BASE}/effect-refusals`);
  const getRefuseSaid = (await getRefuse.json()).error ?? '';
  const putRefuse = await fetch(`${BASE}/effect-refusals`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(probePackage()),
  });
  ok('the namespace answers for itself: a GET says what it takes, and a PUT does not install a package into it',
    getRefuse.status === 405 && /takes POST/.test(getRefuseSaid)
      && putRefuse.status === 405 && !userRootHolds().includes('effect-refusals'),
    `GET ${getRefuse.status} "${getRefuseSaid.slice(0, 70)}", PUT ${putRefuse.status}, `
    + `user root holds ${userRootHolds().join(', ') || 'nothing'}`);
  const asRefuse = await put('refuse', bent((p) => { p.manifest.id = 'refuse'; }));
  const readRefuse = await getJson('/effects/refuse');
  const listsRefuse = ((await getJson('/effects')).body.effects ?? []).some((e) => e.id === 'refuse');
  const dropRefuse = await del('refuse');
  ok('and a package genuinely called refuse installs, serves, lists and uninstalls, because nothing under /effects/ is claimed',
    asRefuse.status === 200 && readRefuse.status === 200 && readRefuse.body.manifest?.id === 'refuse'
      && listsRefuse === true && dropRefuse.status === 200 && !userRootHolds().includes('refuse'),
    `PUT ${asRefuse.status}, GET ${readRefuse.status} for id ${JSON.stringify(readRefuse.body.manifest?.id)}, `
    + `${listsRefuse ? 'listed' : 'not listed'}, DELETE ${dropRefuse.status}, `
    + `user root holds ${userRootHolds().join(', ') || 'nothing'}`);

  await browser.close();
  browser = null;
} catch (err) {
  crashed = err;
  console.log(`\n  FAIL  the run did not finish: ${err.stack ?? err.message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await stopAll();
  rmSync(WORK, { recursive: true, force: true });
}

console.log(`\n[effect] ${checked} assertions, ${failed} failed`);
if (untested) {
  console.log(`[effect] UNTESTED - ${untested}.`);
  process.exit(2);
}
/**
 * The count decides, and before the crash does: a mutation can leave the page half-adopted and a
 * driver reaching into it throws, so crash-first reports DID NOT RUN over assertions that had
 * fired. With no failures, crashed means DID NOT RUN and finishing means the
 * mutation was not caught.
 */
if (MUTATE && failed > 0) {
  console.log(`[effect] caught, as required (${failed} assertion${failed === 1 ? '' : 's'} fired)`);
  if (crashed) console.log(`[effect] and the run ended early: ${crashed.message.split('\n')[0]} - the count is a floor`);
  console.log(`[effect] rows that fired: ${fired.join(' | ')}`);
  process.exit(1);
}
if (crashed) {
  console.log(`[effect] DID NOT RUN - ${crashed.message.split('\n')[0]}. Nothing here is a finding: re-run it.`);
  process.exit(2);
}
if (MUTATE) {
if (MUTATIONS[MUTATE]?.fails) console.log(`[effect] it should redden: ${MUTATIONS[MUTATE].fails}`);
  console.log('[effect] NOT CAUGHT - the check passed a build it should have rejected');
  process.exit(1);
}
if (failed) { console.log('[effect] FAIL'); process.exit(1); }
console.log('[effect] PASS');
process.exit(0);
