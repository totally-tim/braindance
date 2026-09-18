// Proves that one registry drives the renderer and that the panel is a view on it:
// every value lands where the renderer reads it, the panel moves the registry and
// follows it back, a serialised set restores to the same pixels, and nothing moved
// against the revision before the registry existed.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { MessageParser, TYPE_FRAME } from '../server/protocol.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

// Resolved against this file rather than the working directory, so the tool can be
// run from anywhere.
const REPO = fileURLToPath(new URL('..', import.meta.url));

const URL_BASE = flag('--url', 'http://localhost:8080');
// The live recorder. Named once because the page is opened at it and the before-arm's
// markup is intercepted by it, and those two have to agree or the interception misses.
const RECORDER_PATH = '/record';
const CAPTURE = flag('--capture') ?? join(REPO, 'captures/sample.knct');
// Not HEAD, which is the registry itself, and not a literal hash: rewriting the history
// moves every hash after the first rewritten commit, where a marker is content and
// survives one. The refusal below is the control on the search.
const BEFORE_REV = flag('--before') ?? revBeforeMarker('const PARAMS');

function revBeforeMarker(marker) {
  const introduced = execFileSync(
    'git', ['log', '-S', marker, '--format=%H', '--reverse', '--', 'web/main.js'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 },
  ).split('\n')[0].trim();
  if (!introduced) {
    throw new Error(`no commit in this history introduces ${JSON.stringify(marker)} to web/main.js`);
  }
  return `${introduced}^`;
}
const MUTATIONS = {
  // The levelling pair goes back to being one pair the program shares rather than one per clip,
  // by pinning the binding to whichever cloud was selected first. Every clip's `tilt` and `roll`
  // then write the same two numbers, so a clip's tilt composes with another clip's roll - which
  // is what shipped. Only the two-clip section can see it.
  'levelling-shares-one-pair': {
    file: 'web/point-cloud.js',
    edits: [[
      '  levelAngles = points.levelAngles;',
      '  levelAngles = levelAngles ?? points.levelAngles;',
    ]],
    fails: 'the two levelling angles held as one pair the program shares rather than one pair '
      + 'per clip, so a clip\'s tilt composes with another clip\'s roll. Reddens exactly 1: the '
      + 'drawn-rotation row for the clip written last. Both clips go on serialising the right two '
      + 'angles and the clip written first is never rewritten, which is why the other two rows of '
      + 'that section stay green',
  },
  'rgb-contributes-no-alpha': {
    file: 'web/cloud-shader.js',
    edits: [[
      '    alphaFactor += readRgb;',
      '    alphaFactor += 0.0;',
    ]],
    fails: 'the readRgb row of 1b, alone - the other four readings are untouched',
  },
  'ghost-alpha-term-dropped': {
    file: 'effects-builtin/ghost/ghost.frag.glsl',
    edits: [[
      '    alphaFactor += (0.25 + 0.75 * rim + 0.25 * lum) * ghost;',
      '    alphaFactor += (0.25 + 0.75 * rim) * ghost;',
    ]],
    fails: 'the ghost.amount row of 1b, alone - so 1b compares alpha and not just colour',
  },
  'mix-ignores-normalisation': {
    file: 'web/cloud-shader.js',
    edits: [[
      'float norm = readSum > 0.0 ? 1.0 / readSum : 0.0;',
      'float norm = readSum > 0.0 ? 1.0 : 0.0;',
    ]],
    fails: 'the scale-cancels row of 8b, with every row of 1b still passing',
  },
  'contour-edges-round-in-float': {
    file: 'web/main.js',
    edits: [[
      "    write = (v) => { table()[bind.uniform].value.set(0.5 - v, 0.5 + v); };",
      "    write = (v) => { table()[bind.uniform].value.set(\n"
        + "      Math.fround(Math.fround(0.5) - Math.fround(v)),\n"
        + "      Math.fround(Math.fround(0.5) + Math.fround(v)),\n"
        + "    ); };",
    ]],
    fails: 'the two contour.width landing rows, naming the edges that must be computed in double',
  },
  'weight-ignored': {
    file: 'effects-builtin/ghost/ghost.frag.glsl',
    edits: [[
      '  if (ghost > 0.0) {',
      '  if (false) {',
    ]],
    fails: 'ghost.amount, ghost.rim and ghost.fill in the drop-one sweep, plus ghost.amount\'s 1b row',
  },
  'duotone-ignored': {
    file: 'effects-builtin/duotone/tone.frag.glsl',
    edits: [[
      '  if (duotoneDepth > 0.0) {',
      '  if (false) {',
    ]],
    fails: 'seven rows. The drop-one sweep names **five** - duotone.amount, duotone.hue, '
      + 'duotone.split, duotone.span and duotone.motion - and the count beneath it reads 81 of '
      + '89; the other five are the planted motion section losing its subject entire: the '
      + 'raised-speed row, the hot-pole direction row, the chequered per-point row, the '
      + 'half-moving mean row, and the span-widening row that keeps the section honest. '
      + '**This list said four names and two rows**; the span goes with the split for the '
      + 'structural reason above, and the planted section loses five rows rather than two '
      + 'because every one of them reads a colour this block no longer writes',
  },
  'duotone-ignores-depth': {
    file: 'effects-builtin/duotone/tone.frag.glsl',
    edits: [[
      '    float k = smoothstep(duotoneSplit - w * 0.5, duotoneSplit + w * 0.5, t);',
      '    float k = 0.5;',
    ]],
    fails: 'duotone.split and duotone.span in the drop-one sweep - the amount and the hue still '
      + 'reach pixels, and the span goes with the split because the ramp it widens is gone - '
      + 'plus the metre section\'s control row, since a ramp replaced by a constant cannot be '
      + 'widened either',
  },
  'duotone-span-ignored': {
    file: 'effects-builtin/duotone/tone.frag.glsl',
    edits: [[
      '    float w = duotoneSpan / max(0.001, farClip - nearClip);',
      '    float w = 1.0;',
    ]],
    fails: 'duotone.span in the drop-one sweep - every other duotone term still reaches pixels, '
      + 'since the ramp goes on running at the width it had before this parameter - and the whole '
      + 'of the metre section, whose two invariance rows read a ramp that is once again a share '
      + 'of the box and whose control row cannot widen it',
  },
  'duotone-span-against-a-frozen-range': {
    file: 'effects-builtin/duotone/tone.frag.glsl',
    edits: [[
      '    float w = duotoneSpan / max(0.001, farClip - nearClip);',
      '    float w = duotoneSpan / 5.95;',
    ]],
    fails: 'the duotone span\'s two invariance rows, which render the same take at two clip '
      + 'ranges and hold the graded band still in metres - and nothing else, because at the '
      + 'default range this mutation is the shipped arithmetic',
  },
  'vspeed-ignored': {
    file: 'web/cloud-shader.js',
    edits: [[
      '    vSpeed = paired ? abs(mmC - mmP) / spanSec : 0.0;',
      '    vSpeed = 0.0;',
    ]],
    fails: 'duotone.motion in the drop-one sweep and the proven-parameter count beneath it, '
      + 'plus the planted section\'s two motion rows - the one that says a planted pair moves '
      + 'the picture and the one that says it moves it toward the hot pole',
  },
  'vspeed-unnormalised': {
    file: 'web/cloud-shader.js',
    edits: [[
      '    vSpeed = paired ? abs(mmC - mmP) / spanSec : 0.0;',
      '    vSpeed = paired ? abs(mmC - mmP) : 0.0;',
    ]],
    fails: 'the same-speed-over-two-spans row of the planted section, alone - the drop-one '
      + 'sweep stays green, and so do the two rows either side of it',
  },
  'vspeed-ignores-the-gate': {
    file: 'web/cloud-shader.js',
    edits: [[
      '    vSpeed = paired ? abs(mmC - mmP) / spanSec : 0.0;',
      '    vSpeed = mmP > 0.0 ? abs(mmC - mmP) / spanSec : 0.0;',
    ]],
    fails: 'the row that says a jump past the snap threshold is a different surface, alone',
  },
  'vspeed-reads-one-texel': {
    file: 'web/cloud-shader.js',
    edits: [[
      '    vSpeed = paired ? abs(mmC - mmP) / spanSec : 0.0;',
      '    vSpeed = paired ? abs(mmC - depthAt(depthPrev, ivec2(0))) / spanSec : 0.0;',
    ]],
    fails: 'the two chequered-plant rows of the planted section - the one that says the '
      + 'chequer is neither of the uniform frames and the one that says its mean red sits '
      + 'between them',
  },
  'motion-leaks-at-zero': {
    file: 'effects-builtin/duotone/tone.frag.glsl',
    edits: [[
      '    k = mix(k, 1.0, duotoneMotion * smoothstep(0.0, 1200.0, vSpeed));',
      '    k = mix(k, 1.0, (duotoneMotion + 0.02) * smoothstep(0.0, 1200.0, vSpeed));',
    ]],
    fails: 'the motion-of-0-is-inert row, alone - every other row has the term raised on '
      + 'both sides or has nothing moving on either',
  },
  'spansec-nominal': {
    file: 'web/main.js',
    edits: [[
      '    return { steps, mixT: offset / span, sinceFrameSec: offset, spanSec: span };',
      '    return { steps, mixT: offset / span, sinceFrameSec: offset, spanSec: 1 / 30 };',
    ]],
    fails: 'the row that holds spanSec against the gaps between the pinned frames, alone',
  },
  'duotone-hue-in-degrees': {
    file: 'web/main.js',
    edits: [[
      '    write = (v) => { table()[bind.uniform].value = THREE.MathUtils.degToRad(v); };',
      '    write = (v) => { table()[bind.uniform].value = v; };',
    ]],
    fails: 'the duotone.hue row of the one-at-a-time landing sweep, reporting "landed 47 want '
      + '0.8203047484373349", and the all-at-once row beside it - that second one is the same '
      + 'comparison over the whole set rather than a separate finding',
  },
  'crush-ignored': {
    file: 'web/grade-shader.js',
    edits: [[
      '      col = max(col - crush, 0.0) * 1.12;',
      '      col = max(col - 0.018, 0.0) * 1.12;',
    ]],
    fails: 'crush in the drop-one sweep, alone',
  },
  'raster-recomputes-the-default': {
    file: 'effects-builtin/raster/lines.grade.glsl',
    edits: [[
      '        if (scanAxis.x == 0.0 && scanAxis.y == 1.0 && scanPitch == 1.3 && scanHard == 0.0) {',
      '        if (false) {',
    ]],
    fails: 'the raster-at-0.35 row against the pinned build, and nothing else',
  },
  'lattice-ignored': {
    file: 'effects-builtin/lattice/snap.vert.glsl',
    edits: [[
      '  if (lattice > 0.0) {',
      '  if (false) {',
    ]],
    fails: 'eight rows, and none of them is the drop-one sweep any more - see above. **All '
      + 'eight are the planted glyph sections**, which cannot draw one character per cell '
      + 'without the snap: the thinning equality, the turbulence control, the ripple and push '
      + 'control, the hash key\'s own ramp, both rows of the ink ramp, the two-surface '
      + 'section\'s box-against-ink guard and its far-surface guard. **The count was right and '
      + 'the composition was not**: this list used to give seven to the glyph sections and the '
      + 'eighth to the streak\'s 45-degree row, and measured, the streak row stays green while '
      + 'the two-surface section loses a second guard. A list that names the wrong eight is as '
      + 'expensive as one that names the wrong number, because the reader checks the names',
  },
  'ripple-ignored': {
    file: 'effects-builtin/ripple/wave.vert.glsl',
    edits: [[
      '  if (ripple > 0.0 && rw > 0.0) {',
      '  if (false) {',
    ]],
    fails: 'five rows. The drop-one sweep, naming ripple.amount, ripple.freq and ripple.speed '
      + 'unexplained, and the count beneath it at 83 of 89; the ripple-alone row, which is the '
      + 'one the gate is about; the clock row, since a ripple that is switched off renders the '
      + 'same frame either side of a step boundary; and the glyph section\'s hash-order row, '
      + 'which needs the ripple to move a point to tell "hashed before" from "hashed after". '
      + '**This list used to name the first and third of those and stop**, which read as two '
      + 'rows to anybody counting - the sweep is two rows rather than one, and the last two are '
      + 'planted fixtures losing their subject',
  },
  'ripple-outside-the-gate': {
    file: 'web/shader-assembly.js',
    edits: [[
      "        out += consumers.map((c) => c.when).join(' || ');",
      "        out += consumers.filter((c) => c.id !== 'ripple').map((c) => c.when).join(' || ');",
    ]],
    fails: 'the ripple-alone row, and nothing else - the drop-one sweep stays green',
  },
  'ripple-clock-continuous': {
    file: 'effects-builtin/ripple/wave.vert.glsl',
    edits: [[
      '      float cycles = dist * rippleFreq - floor(time * rippleSpeed * 8.0) * 0.125;',
      '      float cycles = dist * rippleFreq - time * rippleSpeed;',
    ]],
    fails: 'the stepped-clock row, and nothing else - the drop-one sweep stays green',
  },
  'glitch-axis-ignored': {
    file: 'effects-builtin/glitch/tear.vert.glsl',
    edits: [[
      '      ? floor(mix(position.y, position.x, glitchAxis) / glitchBands)',
      '      ? floor(position.y / glitchBands)',
    ]],
    fails: 'glitch.axis in the drop-one sweep, alone',
  },
  'streak-ignored': {
    file: 'effects-builtin/streak/fall.grade.glsl',
    edits: [[
      '      if (streak > 0.0) {',
      '      if (false) {',
    ]],
    fails: 'streak.amount and streak.angle in the drop-one sweep, the proven-parameter count '
      + 'beneath it, and all four rows of the direction section - the added-light guard '
      + 'reporting zero, and the three pair rows behind it, which are the fixture going '
      + 'rather than three findings about direction',
  },
  'streak-ignores-angle': {
    file: 'effects-builtin/streak/fall.grade.glsl',
    edits: [[
      '          vec3 tap = texture2D(tDiffuse, vUv + d * texel * streakAxis).rgb;',
      '          vec3 tap = texture2D(tDiffuse, vUv + vec2(0.0, d * texel.y)).rgb;',
    ]],
    fails: 'streak.angle in the drop-one sweep and the proven-parameter count beneath it, '
      + 'and all three of the direction section\'s pair rows - a nailed build renders the '
      + 'same frame at every angle, so each pair differs by exactly nothing',
  },
  'streak-angle-in-degrees': {
    file: 'web/main.js',
    edits: [[
      '      table()[bind.uniform].value.set(Math.sin(r), Math.cos(r));',
      '      table()[bind.uniform].value.set(Math.sin(v), Math.cos(v));',
    ]],
    fails: 'the streak.angle row of the one-at-a-time landing sweep, reporting "landed '
      + '[-0.097181906,0.995266636] want [0.920504853,-0.390731128]", and the all-at-once '
      + 'row beside it - that second one is the same comparison over the whole set rather '
      + 'than a separate finding. Nothing in the direction section moves: this is a unit '
      + 'error, and a streak running at the wrong angle is still a streak running at an '
      + 'angle. **And the raster.angle landing row with it**: the two angles share the one '
      + '`axisDeg` branch this now anchors, so the same wrong arithmetic reaches both - '
      + 'measured, raster.angle lands [0.1673557,0.985896582] against a want of '
      + '[0.891006524,0.4539905]. The repointing was first shipped with that row as a '
      + 'prediction, and the run confirmed it; the streak numbers above are unchanged '
      + 'because neither the test value nor the arithmetic moved',
  },
  'raster-ignores-angle': {
    file: 'effects-builtin/raster/lines.grade.glsl',
    edits: [[
      '          float coord = dot(vUv * ref, scanAxis);',
      '          float coord = vUv.y * ref.y;',
    ]],
    fails: 'raster.angle in the drop-one sweep, alone',
  },
  'raster-pitch-fixed': {
    file: 'effects-builtin/raster/lines.grade.glsl',
    edits: [[
      '          float wave = sin(coord * scanPitch + time * 2.0) * 0.5 + 0.5;',
      '          float wave = sin(coord * 1.3 + time * 2.0) * 0.5 + 0.5;',
    ]],
    fails: 'raster.pitch in the drop-one sweep, alone',
  },
  'raster-hard-ignored': {
    file: 'effects-builtin/raster/lines.grade.glsl',
    edits: [[
      '          line = mix(wave, smoothstep(0.5 - w, 0.5 + w, wave), scanHard);',
      '          line = wave;',
    ]],
    fails: 'raster.hard in the drop-one sweep, alone',
  },
  'crush-gates-the-grade': {
    file: 'web/main.js',
    edits: [[
      '  return PASS_GATES[table].some(',
      '  return (table === \'grade\' && grade.uniforms.crush.value > 0) || PASS_GATES[table].some(',
    ]],
    fails: 'seven rows: the pass-gate row for crush, all five reading rows of 1b (each at 6 of '
      + '6 frames and about three quarters of every frame), and the boot comparison, whose '
      + 'landing diff names rgbsplit.amount, raster.amount and grain.amount moving from '
      + '[0,false] to [0,true]. **`GRADE_GATES` holds seven terms and this line used to say '
      + 'four** - grain, scanlines, rgbSplit, streak, halation, stock and vignette, derived from the packages\' '
      + '`gates` bindings rather than counted by hand, which is the whole point of deriving '
      + 'them: the boot row names the three whose landing actually moves, and the number of '
      + 'gates is a fact about the installed set rather than about this comment',
  },
  'glyph-ignored': {
    file: 'effects-builtin/glyph/size.vert.glsl',
    edits: [
      ['  if (glyph > 0.0) {', '  if (false) {'],
      ['  if (glyphMix > 0.0) {', '  if (false) {', 'effects-builtin/glyph/index.frag.glsl'],
    ],
    fails: 'the mark the room is drawn out of, switched off at both of the stages it gates - one '
      + 'anchor leaves the characters still being drawn at the old sprite size. '
      + 'Twenty-two rows in total, on a tree that is otherwise green, counted out '
      + 'because a list that undercounts sends the next reader hunting a defect that is not '
      + 'there. **Two carry the claim**: the drop-one sweep, '
      + 'naming glyph.amount, glyph.tone, glyph.hash and glyph.rain unexplained, and the count beneath '
      + 'it at 81 of 89. **One is a neighbour**: the streak\'s right-angle row, which reads the '
      + 'scrambled set this mutation redraws. **Nineteen are the planted glyph sections losing their fixture** - '
      + 'the thinning section\'s guard and its equality, all three turbulence rows, both '
      + 'ripple rows, the index section\'s guard, its doubling row and its distinctness row, '
      + 'the hash ramp\'s strict row, the rain key\'s own row, the strict ink row, all three '
      + 'rows of the character two-surface section, the unit section\'s hard-bit reference row, '
      + 'the above-1080 section\'s companion arm, and the '
      + 'keys-move control. **This list said eighteen and nineteen fire**, and the one it left '
      + 'out is the above-1080 companion arm; that it fired before the discard was widened as '
      + 'well is a reading rather than a measurement - the mutation draws no character under '
      + 'either key setting, so the two arms are identical splats whatever the discard does - '
      + 'and it was not re-derived on the pre-widening tree, because this worktree was carrying '
      + 'other agents\' live runs at the time. That section\'s claim row is worth reading '
      + 'rather than counting: it goes red at 17 pixels of 9922 against the 19,765 of 75,239 '
      + '`glyph-margins-occlude` produces. **The 17 used to be written down here as the disc\'s '
      + 'own rim and they are not**, and the correction is recorded rather than quietly made: '
      + 'the rim is discarded outright on this build, and the number did not move by a pixel. '
      + 'What is left is bloom spreading the near cloud\'s own light past the pixels it drew '
      + 'on, which the comparison excludes by drawn pixel rather than by halo - a fixture that '
      + 'has lost its subject rather than a fault of any age. **One is a neighbour**: the '
      + 'streak\'s 90-degree '
      + 'row at 2.44/0.14, which reads the scrambled set this mutation emptied.\n'
      + '           The newborn section stays green throughout, correctly: its look draws no '
      + 'characters to begin with, so a mutation that stops characters being drawn is its '
      + 'shipped arithmetic.\n'
      + '           `bloom` is a fifth *name* inside the sweep row rather than a thirteenth '
      + 'row, and it is unexplained in both senses - why that pass in particular stops '
      + 'reaching a pixel here is a reading and not a measurement, presumably a frame with no '
      + 'characters in it having nothing left above the pass\'s own threshold. Recorded as the '
      + 'run printed it rather than as something anybody has confirmed.',
  },
  'glyph-hash-per-point': {
    file: 'effects-builtin/glyph/cell.vert.glsl',
    edits: [[
      '    vCellSeed = hash(dot(wc, vec3(127.1, 311.7, 74.7)));',
      '    vCellSeed = hash(dot(vec3(position.xy, 0.0), vec3(127.1, 311.7, 74.7)));',
    ]],
    fails: 'a character keyed on the point rather than on the cell it fell in, which draws '
      + 'characters either way and is the difference between a room made of code and a fog of '
      + 'it. '
      + 'Three rows. The claim is the thinning equality, at 1b30eba90301 against '
      + 'bc9087ff1fc0. With it go both of the turbulence section\'s claims - the noise one at '
      + '0.042/255 against a clean 11.565 and the ripple one at 0.000 against a clean 1.370 - '
      + 'and those are the mutation rather than two more defects: four hundred per-point '
      + 'characters overlaid in one cell cover the whole box, so exchanging a few of them '
      + 'moves nothing whichever displacement is doing the exchanging. The drop-one sweep '
      + 'stays green throughout, because a per-point hash is still a hash the weight reaches',
  },
  'glyph-hash-on-the-displaced-point': {
    file: 'web/cloud-shader.js',
    edits: [[
      '    vec3 room = mat3(modelMatrix) * p0;',
      '    vec3 room = mat3(modelMatrix) * (p0 + (noise + regionNoise * rw) '
        + '* vnoise3(p0 * noiseScale + time * noiseSpeed * vec3(0.7, 1.13, 0.31)));',
    ]],
    fails: 'and read after the turbulence moved the point, which is the defect the probe this '
      + 'came out of shipped and which is bit-identical to the fix wherever nothing is '
      + 'displacing. '
      + 'The row that says a character travels with its point through the turbulence, '
      + 'alone, and it collapses rather than drifting: 0.000/255 against a clean 11.537, with '
      + 'the control beside it still green at exactly 0. Nothing else moves - with the noise '
      + 'at zero, which is where every other arm in this file leaves it, this mutation is the '
      + 'shipped arithmetic',
  },
  'glyph-hash-after-the-region': {
    file: 'web/cloud-shader.js',
    edits: [[
      '    vec3 room = mat3(modelMatrix) * p0;',
      '    vec3 room = mat3(modelMatrix) * (p0 + (rw > 0.0 && length(p0 - regionCentre) > 1e-4 '
        + '? ((p0 - regionCentre) / length(p0 - regionCentre)) * (regionPush * rw '
        + '+ sin((length(p0 - regionCentre) * rippleFreq '
        + '- floor(time * rippleSpeed * 8.0) * 0.125) * 6.2831853) * ripple * rw) : vec3(0.0)));',
    ]],
    fails: 'and read after the other two displacements, which run before the turbulence and sat '
      + 'at zero in every arm - so the one above cannot see it. Both are inlined together, '
      + 'because the pair share a radial direction and a build hashing after them hashes the '
      + 'drawn position exactly. '
      + 'The ripple half of the turbulence section, alone: the row that says a character '
      + 'was hashed before the ripple and the push. Its control beside it stays green at '
      + 'exactly 0, so the two phases still hold every point inside its own cell and this is '
      + 'the characters going still rather than the geometry moving. The noise rows above it '
      + 'stay green, correctly - they run with the ripple and the push at zero, where this '
      + 'mutation is the shipped arithmetic',
  },
  'glyph-tone-per-point': {
    file: 'effects-builtin/glyph/index.frag.glsl',
    edits: [[
      '    float cellTone = 1.0 - vCellT;',
      '    float cellTone = clamp(dot(col, vec3(0.299, 0.587, 0.114)), 0.0, 1.0);',
    ]],
    fails: 'the thinning row of the heterogeneous section, alone. All three of its guards stay '
      + 'green - the occupants still land in one cell, they still paint many colours as '
      + 'splats, and the mask still moves when the key does - which is what says this is the '
      + 'character following the point rather than the fixture collapsing',
  },
  'glyph-index-averages': {
    file: 'effects-builtin/glyph/index.frag.glsl',
    edits: [[
      '    float f = fract(glyphTone * cellTone * (63.0 / 64.0) + glyphHash * vCellSeed + glyphRain * rainStep);',
      '    float f = (glyphTone * cellTone * (63.0 / 64.0) + glyphHash * vCellSeed + glyphRain * rainStep) '
        + '/ max(1e-4, glyphTone + glyphHash + glyphRain);',
    ]],
    fails: 'the three keys mixed rather than summed, caught on scale rather than on the '
      + 'character - the document\'s own discriminator is the same number under both '
      + 'compositions. '
      + 'Two rows: the one that says doubling two keys renders a different frame, and the '
      + 'fitted index row beneath it, where a normalising mix with the other two keys down '
      + 'draws one character at every tone and the painted count sits at 20104px across the '
      + 'whole sweep. The guard and the solo-key control stay green, because a mix still draws '
      + 'characters and still draws different ones for each key',
  },
  'glyph-index-squares': {
    file: 'effects-builtin/glyph/index.frag.glsl',
    edits: [[
      '    float f = fract(glyphTone * cellTone * (63.0 / 64.0) + glyphHash * vCellSeed + glyphRain * rainStep);',
      '    float s = glyphTone * cellTone * (63.0 / 64.0) + glyphHash * vCellSeed + glyphRain * rainStep;\n'
        + '    float f = fract(s * s);',
    ]],
    fails: 'the fitted index row of the index section, alone. Its guard stays green - the '
      + 'cloud is still unrotated and the predicted sweep still walks the table - and so do '
      + 'the doubling row and the hash sweep above it, which is the whole reason this control '
      + 'exists: a square is scale-sensitive and it is monotone, so every row that stood here '
      + 'before this one passes it',
  },
  'glyph-tone-ignored': {
    file: 'effects-builtin/glyph/index.frag.glsl',
    edits: [[
      '    float f = fract(glyphTone * cellTone * (63.0 / 64.0) + glyphHash * vCellSeed + glyphRain * rainStep);',
      '    float f = fract(0.0 * cellTone * (63.0 / 64.0) + glyphHash * vCellSeed + glyphRain * rainStep);',
    ]],
    fails: 'the tonal key, and the ink ordering under it that no comparison of two pictures can '
      + 'see. '
      + 'Four rows: glyph.tone unexplained in the drop-one sweep, the count beneath it one '
      + 'lower than the clean run\'s, the ink ramp\'s strict row at 1.55% to 1.55%, and the '
      + 'fitted index row, where every arm of the sweep draws index 0 and paints the same '
      + '2852px. The count is quoted as a delta rather than as a figure because the clean run '
      + 'moves with the parameter table. The non-decreasing row above the strict one stays '
      + 'green and that is why the strict one exists - four equal readings satisfy '
      + '"non-decreasing" perfectly. Both source rows stay green too, correctly: this '
      + 'mutation does not touch the table',
  },
  'rain-ignored': {
    file: 'effects-builtin/rain/lift.frag.glsl',
    edits: [
      ['  float rainLift = 1.0 - smoothstep(0.0, rainTrail / rainSpan, fract(vRain));',
        '  float rainLift = 0.0;'],
      ['    float rainStep = floor(vRain) * 0.6180339887498949;', '    float rainStep = 0.0;',
        'effects-builtin/glyph/index.frag.glsl'],
    ],
    fails: 'nine rows. The claim: glyph.rain, rain.amount, rain.speed, rain.span and rain.trail '
      + 'unexplained in the drop-one sweep, with the count at 81 of 89. The rest is the '
      + 'fixture going with it - the trail section finds no head in the column at any phase, '
      + 'so all four of its rows go together: the guard, the afterglow row reading 0.0000 '
      + 'both sides, the walk\'s own guard, and the descent row with no walk to read. Then '
      + 'the span section\'s control cannot widen a gap that reaches nothing, and the '
      + 'defaults section\'s rain-raised control has nothing to raise, and the index '
      + 'section\'s rain-key row has no counter left to step - that key reads the drop '
      + 'coordinate this mutation zeroes',
  },
  'rain-trail-below-the-head': {
    file: 'effects-builtin/rain/lift.frag.glsl',
    edits: [[
      '  float rainLift = 1.0 - smoothstep(0.0, rainTrail / rainSpan, fract(vRain));',
      '  float rainLift = 1.0 - smoothstep(0.0, rainTrail / rainSpan, 1.0 - fract(vRain));',
    ]],
    fails: 'and which side of the head its afterglow sits on, without which the wave reads as '
      + 'rising. '
      + 'The row that says the afterglow is above the head, alone, and it reads as the '
      + 'exact mirror of the clean run rather than as a collapse: 0.0000 above the head and '
      + '0.5282 below, against 0.5363 above and 0.0000 below. The guard above it stays green, '
      + 'so the column still carries a drop and this is a direction rather than an absence',
  },
  'rain-span-in-frames': {
    file: 'effects-builtin/rain/cell.vert.glsl',
    edits: [[
      '    vRain = (rainPhase * rainSpeed + room.y) / rainSpan + hash(dot(wc.xz, vec2(269.5, 183.3)));',
      '    vRain = (rainPhase * rainSpeed + room.y) / (rainSpan * spanSec * 30.0) '
        + '+ hash(dot(wc.xz, vec2(269.5, 183.3)));',
    ]],
    fails: 'its head gap in metres of room rather than in frames of whatever the link is doing, '
      + 'which only two link speeds see. '
      + 'Five rows. The claim is the link-speed equality, 8d8414c35504 at 33ms against '
      + '074d7390ee19 at 111ms. The other four are the whole trail section, which is fixture '
      + 'rather than finding: it renders at the default quarter-second span, so the mutated '
      + 'divisor multiplies its head gap by seven and a half, no head is left inside the '
      + 'planted column, and its guard, its afterglow row, its walk guard and its descent row '
      + 'all go at once. The span section\'s own control stays green, because a gap divided by '
      + 'a frame gap is still a gap that widening moves',
  },
  'crossfade-reads-the-reference': {
    file: 'effects-builtin/glyph/mark.frag.glsl',
    edits: [[
      '  float glyphMix = glyph * smoothstep(8.0, 16.0, vLegiblePx);',
      '  float glyphMix = glyph * smoothstep(8.0, 16.0, vSize);',
    ]],
    fails: 'the legibility band counted in reference pixels alone, which is the unit every other '
      + 'glyph arm agrees with and so the one none of them can refuse. '
      + 'Four rows, on a tree that is otherwise green. **Two carry the claim** and they '
      + 'are the two halves of it: the in-band '
      + 'cell coming back a hard bit at one colour, and the cut-away pair parting company - '
      + 'vSize is the un-halved reference size and carries no crop state at all, so a cut-away '
      + 'cell measures 72 reference pixels, sits well above the band, and draws the characters '
      + 'the crop asked it not to. That second half used to read as a colour count and reads as '
      + 'the keys reaching a pixel inside the crop now, which is the same mutation caught by a '
      + 'row a blend cannot satisfy. The hard-bit reference row above them stays green, which '
      + 'is what says the statistic still reads a one where it should. **Two are the two-surface '
      + 'section losing its fixture**, both guards: that section wants a far surface under '
      + 'the band drawing splats, and the reference reading puts it above at 30 pixels, so '
      + 'the far surface inks 1.71% of the frame instead of 41.42% and the at-risk '
      + 'population falls from 5875 to 264. Its claim row stays green, correctly - the near '
      + 'margins are still discarded. **This list said five and named a fifth that does not '
      + 'fire**: the streak\'s 45-degree row, predicted as a neighbour reading the scrambled '
      + 'set this mutation redraws. Measured, it stays green, so the mutation does not reach '
      + 'that fixture and the four above are the whole of it',
  },
  'crossfade-ignores-the-buffer-scale': {
    file: 'web/cloud-shader.js',
    edits: [[
      '  vLegiblePx = outsideCrop ? 0.0 : gl_PointSize / max(k, 1.0);',
      '  vLegiblePx = outsideCrop ? 0.0 : gl_PointSize;',
    ]],
    fails: 'and the same band counted in the buffer\'s pixels alone, which no arm below 1080 can '
      + 'refuse and which lets a view parameter move the graded look. '
      + 'The claim row of the above-1080 section, alone: the two key settings parting '
      + 'company at a cell the look asked to draw as a splat. Its guard row stays green - the '
      + 'buffer, the scale and the two readings are geometry and this mutation moves none of '
      + 'them - and so does the control beside it, because a cell above the band on both '
      + 'readings draws characters either way. Nothing else in the file moves at all, which '
      + 'is the coverage statement rather than luck: every other arm here renders at a third '
      + 'of the reference height, where the divisor this deletes is 1',
  },
  'crop-still-draws-characters': {
    file: 'web/cloud-shader.js',
    edits: [[
      '  vLegiblePx = outsideCrop ? 0.0 : gl_PointSize / max(k, 1.0);',
      '  vLegiblePx = gl_PointSize / max(k, 1.0);',
    ]],
    fails: 'the same reading with the crop taken out of it, so a cut-away point keeps a sprite '
      + 'above the legibility band and draws a smaller character where dust is promised. '
      + 'The cut-away row of the unit section, alone: the three keys parting company on a '
      + 'frame every point of which the crop has cut away. Its guard stays green, because the '
      + 'cut-away wall still paints, and so does the uncropped control beside it - that arm is '
      + 'inside no crop, so this mutation is the shipped expression there',
  },
  'rain-key-counts-whole-drops': {
    file: 'effects-builtin/glyph/index.frag.glsl',
    edits: [[
      '    float rainStep = floor(vRain) * 0.6180339887498949;',
      '    float rainStep = floor(vRain);',
    ]],
    fails: 'the drop counter handed to the index raw, which is inert at exactly the weight the '
      + 'key should be loudest at. '
      + 'Three rows, and it has two catchers because the scrambled set was moved onto this '
      + 'weight for it. The row that names it is the rain-key row of the index section - the '
      + 'key at exactly 1 drawing the picture it draws with the key at 0. Its nonblank guard '
      + 'stays green, because the frame is still full of characters; what has gone is the '
      + 'key\'s contribution to which ones. The other two are the drop-one sweep naming '
      + 'glyph.rain unexplained and the count beneath it at 85 of 89, which the sweep can only '
      + 'say because SCRAMBLE holds this key at 1 rather than at the 0.44 it used to - at any '
      + 'weight whose fraction is not zero a raw counter still scrambles and the sweep sees '
      + 'nothing wrong',
  },
  'rain-climbs': {
    file: 'effects-builtin/rain/cell.vert.glsl',
    edits: [[
      '    vRain = (rainPhase * rainSpeed + room.y) / rainSpan + hash(dot(wc.xz, vec2(269.5, 183.3)));',
      '    vRain = (-rainPhase * rainSpeed + room.y) / rainSpan + hash(dot(wc.xz, vec2(269.5, 183.3)));',
    ]],
    fails: 'and which way the whole pattern travels, which is a different claim from that one '
      + 'and which no single frame holds - the trail is still above a head going the wrong '
      + 'way. '
      + 'The descent row of the trail section, alone. Its guard above it stays green - the '
      + 'head is still found at all four phases and still clear of both ends of the column - '
      + 'and so does the afterglow row, which is the whole point of the pair: the trail is '
      + 'still on the upper side of the head in a wave that is going the wrong way',
  },
  'glyph-margins-occlude': {
    file: 'web/cloud-shader.js',
    edits: [[
      '  if (softEdge == 0 && alpha * falloff <= 0.0) discard;\n'
        + '  fragColor = vec4(col * exposure, alpha * falloff);',
      '  fragColor = vec4(col * exposure, alpha * falloff);',
    ]],
    fails: 'a fragment at exactly zero alpha writing depth, which is invisible geometry per '
      + 'point on the hard-edged path. Its two sections are the only ones here standing two '
      + 'surfaces up: every other plants one wall coincident with itself, where nothing is '
      + 'behind anything to be hidden. '
      + 'Eight rows. **Two carry the claim**, one from each two-surface section: the '
      + 'character section\'s is the far surface moving under pixels the near marks never drew '
      + 'on; the newborn section\'s is the frame with an invisible cloud in it no longer being '
      + 'the frame without it. Every guard beside them stays green, because both fixtures '
      + 'still render and the sparse mark still leaves its box empty; what changes is only '
      + 'whether an empty box is a surface. Those two sections are the only planted ones that '
      + 'can see it, and that is the coverage they exist to state: every other planted section '
      + 'here stands one wall coincident with itself, where there is nothing behind anything to '
      + 'hide.\n'
      + '           **The other six are section 1b, and this line used to say "nothing else".** '
      + 'It was true when the golden arm compared against a revision with no discard at all: '
      + 'removing the discard made this build agree with that revision, so those six went '
      + '*green* under this mutation and the count came out below the clean tree\'s. The arm '
      + 'has been handed the discard since, so the old source now carries it too - and a '
      + 'mutation that takes it out of this build makes the two disagree, at 6 of 6 frames. '
      + 'The direction inverted with the re-pin and the sentence did not follow it, which is '
      + 'the specific way a re-pinned baseline rots the prose around it',
  },
  'margins-confined-to-glyphs': {
    file: 'web/cloud-shader.js',
    edits: [[
      '  if (softEdge == 0 && alpha * falloff <= 0.0) discard;',
      '  if (softEdge == 0 && glyphMix > 0.0 && alpha * falloff <= 0.0) discard;',
    ]],
    fails: 'the same discard narrowed back to characters, which is the state one commit of this '
      + 'history was in and the wrong fix the character section cannot refuse. '
      + 'Seven rows. **The claim is the newborn section\'s**, at 365 of 184184 pixels moved '
      + 'with all 365 behind a newborn sprite. Both guards beside it stay green - the plant is '
      + 'geometry and a condition does not move it - and so does every row of the character '
      + 'section next door, which is the whole point of this control: that section holds the '
      + 'glyph margins and cannot hold anything else, so a build that repaired only them reads '
      + 'clean everywhere it used to be read. That is what separates this from '
      + '`glyph-margins-occlude`, which reddens the character section\'s claim row as well.\n'
      + '           **The other six are section 1b, and this line used to say the opposite.** '
      + 'While the golden arm compared against a revision with no discard at all, the confined '
      + 'condition *was* that revision\'s arithmetic on presets that draw no characters, so the '
      + 'five reading rows and the raster row went green under this mutation and a reader '
      + 'counting reds had to know it. The arm carries the discard now, so the confined '
      + 'condition disagrees with it wherever the widening reaches, and the six redden at 6 of '
      + '6 frames. Read the frame count to tell the three margin mutations apart: this one and '
      + '`glyph-margins-occlude` move all six frames, `margins-miss-the-newborn` moves five',
  },
  'margins-miss-the-newborn': {
    file: 'web/cloud-shader.js',
    edits: [[
      '  if (softEdge == 0 && alpha * falloff <= 0.0) discard;',
      '  if (softEdge == 0 && (glyphMix > 0.0 || falloff <= 0.0) && alpha * falloff <= 0.0) discard;',
    ]],
    fails: 'and narrowed the other way, to the disc\'s rim and not the point that has not faded '
      + 'in yet. '
      + 'Seven rows. The claim is the newborn section\'s, at the same 365 of 184184 - the '
      + 'two narrowings are indistinguishable on that fixture and that is correct rather than a '
      + 'gap, because on it every zero-alpha fragment is a birth. It is a separate control '
      + 'because it is a separate reachable mistake: this one is what a reader repairing the '
      + 'defect from the disc\'s end writes, and the fixture has to refuse both ends.\n'
      + '           **The other six are section 1b, and they are the one place in this suite '
      + 'the rim is visible at all.** That section renders this tree against a revision with no '
      + 'zero-alpha discard of any kind, so it sees whatever this condition reaches: the whole '
      + 'repair moves all six frames, five of them by 460 to 750 bytes of 921600, and a '
      + 'condition reaching the rim alone moves five of the six by 3 to 12. Both are past the '
      + 'tolerance - which asks for 64 bytes and a single step, and every one of these bytes is '
      + 'a couple of hundred - so the rows are red either way and the byte count is the reading '
      + 'rather than the verdict',
  },
  'normalisation-floor-restored': {
    file: 'web/cloud-shader.js',
    edits: [[
      '  if (softEdge == 1) alpha *= min(116.64 / (vSize * vSize), 1.0) * vCellNorm;',
      '  if (softEdge == 1) alpha *= clamp(116.64 / (vSize * vSize), 0.05, 1.0) * vCellNorm;',
    ]],
    fails: 'the pile-up fix, planted because no shipped look reaches the band - a sprite grown '
      + 'to a cell moves the floor from 19cm out to where a person stands. '
      + 'The energy-invariance row of the sprite-size section, alone, at a spread of '
      + '4.055 against a clean 1.046 and a band of 1.15 - the two arms past the floor carry '
      + '6391 and 13041 where every arm should carry about 3200. The guards either side stay '
      + 'green, so the sprites still render and still grow',
  },
  'glyph-leaks-at-zero': {
    file: 'effects-builtin/glyph/mark.frag.glsl',
    edits: [[
      '  float glyphMix = glyph * smoothstep(8.0, 16.0, vLegiblePx);',
      '  float glyphMix = glyph * smoothstep(8.0, 16.0, vLegiblePx) + 0.02;',
    ]],
    fails: 'and the master exactly absent at 0, which is what eleven of the twelve shipped looks '
      + 'rest on - cascade is the exception and the only one that draws a character at all. '
      + 'The ten-of- twelve population next door is a different set: that one is the '
      + 'lattice-zero looks the compensation has to leave alone. '
      + 'Eight rows, and they are one fact arriving in three places. The row that names it '
      + 'is the glyph-of-0-is-inert equality in the defaults section. **Six are '
      + 'section 1b** - all five readings at 6 of 6 frames, plus the raster\'s cross-build row - '
      + 'because 1b renders at parameter defaults against a build that predates the glyph '
      + 'field, and a crossfade that is not exactly zero mixes a bitmask into every point of '
      + 'every one of those frames. That 1b can see this is worth knowing rather than '
      + 'trimming: it is the only comparison here with an oracle outside the build. **The '
      + 'eighth is the above-1080 section\'s governing row**, which asks that a cell under the '
      + 'band in reference pixels draws no character at a taller buffer either - a leak of 0.02 '
      + 'draws one there too, so the smaller of the two readings stops governing. This list '
      + 'said seven and eight fire; the one it left out is that row',
  },
  'rain-leaks-at-zero': {
    file: 'effects-builtin/rain/lift.frag.glsl',
    edits: [[
      '  col *= 1.0 + rain * rainLift;',
      '  col *= 1.0 + (rain + 0.02) * rainLift;',
    ]],
    fails: 'twelve rows. The row that names it is the rain-of-0-is-inert equality, which sees '
      + 'the leak only because its arms hold the vertex gate open - see the comment there. '
      + 'Six more are section 1b\'s five readings and the raster cross-build row, for '
      + '`glyph-leaks-at-zero`\'s reason: a multiplier that is not exactly one moves every '
      + 'default-rendered frame. The last four are the glyph sections\' own equalities - the '
      + 'thinning row, the turbulence control, the ripple control and the ink ramp - which is '
      + 'the leak reaching them too, since those looks carry rain 0 with the glyph master up '
      + 'and so have a live drop coordinate for it to vary along. The twelfth is the unit '
      + 'section\'s hard-bit reference row, for the same reason stated the other way round: '
      + 'that row counts colours and a multiplier varying per point turns one into many, '
      + 'which is the failure its own comment predicts',
  },
  'compensation-leaks-at-lattice-zero': {
    file: 'effects-builtin/lattice/energy.vert.glsl',
    edits: [[
      '  vCellNorm = max((1.0 - lattice) * (1.0 - lattice), min(1.0, spriteCells * spriteCells));',
      '  vCellNorm = max((1.0 - lattice) * (1.0 - lattice), spriteCells * spriteCells);',
    ]],
    fails: 'and the energy correction, which rides no master at all and so is excused by neither. '
      + 'The cell-size-at-lattice-zero row of the defaults section, alone, at c4c44f0faac5 '
      + 'against 68f63ae52440. The control beside it stays green, so the two cell sizes still '
      + 'reach the picture with the lattice raised and this is the compensation failing to be '
      + 'one rather than a parameter going dark',
  },
  // The four below are about the render-target decision, and only the section that renders every
  // shipped preset on a smaller context can see them: this machine renders float at 16384.
  'targets-ignore-the-size-cap': {
    file: 'web/main.js',
    edits: [[
      '    : Math.min(Math.min(devicePixelRatio, 2) * renderScale, renderTargetCaps().maxSize / Math.max(width, height));',
      '    : Math.min(devicePixelRatio, 2) * renderScale;',
    ]],
    fails: 'ten rows of the 2048-cap arm, which is the reporter\'s: its buffer row, the eight '
      + 'composer presets drawing black, and its incomplete-framebuffer row. The four direct '
      + 'presets stay lit, which is the shape of the report',
  },
  'program-out-ignores-the-size-cap': {
    file: 'web/main.js',
    edits: [[
      '  const scale = Math.min(1, renderTargetCaps().maxSize / Math.max(programOutSize.w, programOutSize.h));',
      '  const scale = 1;',
    ]],
    fails: 'the 2048-cap arm\'s /program row alone: black at 3840x2160, with its buffer past the cap '
      + 'and its draws landing in framebuffers that cannot complete',
  },
  'chain-assumes-half-float': {
    file: 'web/post-chain.js',
    edits: [[
      '  chainType = targetType(THREE.HalfFloatType);',
      '  chainType = THREE.HalfFloatType;',
    ]],
    fails: 'eleven rows of the arm with neither colour-buffer extension: its decision row, the '
      + 'eight composer presets drawing black, its incomplete-framebuffer row, and its warning row, '
      + 'which loses the 8-bit clause',
  },
  'memory-assumes-half-float': {
    file: 'web/surface-memory.js',
    edits: [[
      '  const stateType = targetType(THREE.FloatType, THREE.HalfFloatType);',
      "  const stateType = renderer.getContext().getExtension('EXT_color_buffer_float')\n"
        + '    ? THREE.FloatType\n'
        + '    : THREE.HalfFloatType;',
    ]],
    fails: 'seven rows of the arm with neither colour-buffer extension: its decision row, its '
      + 'incomplete-framebuffer row, its warning row, which loses the ghost-and-wake clause, and the '
      + 'four direct presets, which draw no point at all - a memory that never completes reads as '
      + 'age zero, and a point of age zero has not faded in',
  },
  'types-read-from-extension-names': {
    file: 'web/render-targets.js',
    edits: [[
      '      types: Object.freeze(LADDER.filter(completes)),',
      '      types: Object.freeze(LADDER.filter((type) => type === THREE.UnsignedByteType\n'
        + "        || gl.getExtension(type === THREE.FloatType ? 'EXT_color_buffer_float' : 'EXT_color_buffer_half_float'))),",
    ]],
    fails: 'two rows of the Firefox-shaped arm: its decision row, which reads byte for a chain that '
      + 'renders half, and its warning row, which then says the chain runs at 8 bits',
  },
};

const MUTATE = flag('--mutate');
if (MUTATE && !Object.hasOwn(MUTATIONS, MUTATE)) {
  throw new Error(`unknown mutation ${JSON.stringify(MUTATE)} - have ${Object.keys(MUTATIONS).join(', ')}`);
}

// A run that died is not a run that found something: under --mutate a page that dropped
// its execution context exits non-zero with nothing asserted, which reads exactly like a
// caught mutation. So a crash gets its own verdict and its own code.
process.on('unhandledRejection', (err) => {
  console.log(`\n[registry] DID NOT RUN - ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(2);
});
process.on('uncaughtException', (err) => {
  console.log(`\n[registry] DID NOT RUN - ${err instanceof Error ? err.message : String(err)}`);
  if (err instanceof Error && err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
  process.exit(2);
});

// The mutated module, served into every page this file opens. Refused when the anchor is
// not found exactly once: a replacement that matched nothing would run the unmutated page
// and be recorded as the check having missed a bug it was never shown.
const mutatedSource = (() => {
  if (!MUTATE) return null;
  const spec = MUTATIONS[MUTATE];
  if (!spec) throw new Error(`unknown mutation ${MUTATE} - have ${Object.keys(MUTATIONS).join(', ')}`);
  const staged = new Map();
  const touched = [];
  const read = (rel) => {
    if (!staged.has(rel)) staged.set(rel, readFileSync(join(REPO, rel), 'utf8'));
    return staged.get(rel);
  };
  // An edit may name its own file, and two edits of one mutation may name two.
  for (const [from, to, where] of spec.edits) {
    const file = where ?? spec.file;
    const body = read(file);
    const hits = body.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`mutation ${MUTATE} matched its anchor ${hits} times in ${file}, not once: `
        + `${JSON.stringify(from)}`);
    }
    staged.set(file, body.replace(from, to));
    if (!touched.includes(file)) touched.push(file);
  }
  // The panel and the module, served as a pair because a build's `PARAMS` throws at boot on
  // a parameter with no control in the markup, and beside them every file the spec edited,
  // each at the URL a browser reaches it by.
  return {
    js: read('web/main.js'),
    html: read('web/index.html'),
    mutants: touched.map((file) => ({ file, path: servedAt(file), body: read(file), type: contentTypeFor(file) })),
  };
})();

/**
 * Where a file this repo ships is reached from a browser. Matched on the whole pathname
 * rather than on the basename, because two modules could end in the same name. An
 * effect's GLSL chunk has no URL under `web/` and is answered by `/effects/:id/file/:name`.
 */
function servedAt(file) {
  if (file.startsWith('effects-builtin/')) {
    const parts = file.split('/');
    if (parts.length !== 3) {
      throw new Error(`${file} is not an effect package file - a chunk is <id>/<name> under effects-builtin/`);
    }
    return `/effects/${parts[1]}/file/${parts[2]}`;
  }
  if (!file.startsWith('web/')) {
    throw new Error(`${file} is not served to a browser, so a page mutation cannot reach it`);
  }
  return `/${file.slice('web/'.length)}`;
}

/**
 * What the server answers a file with, restated here because the interception has to
 * answer the same way - a chunk is `text/plain` in `server/index.js`.
 */
function contentTypeFor(file) {
  return file.endsWith('.glsl') ? 'text/plain; charset=utf-8' : 'text/javascript; charset=utf-8';
}

const MAIN_PATH = servedAt('web/main.js');
// Counted per file rather than in total: a route that matches nothing fulfils nothing and
// throws no error, and a sum is satisfied by one of two chunks arriving.
const mutantServed = new Map((mutatedSource?.mutants ?? []).map((m) => [m.path, 0]));

const HEADED = argv.includes('--headed');
const SOURCE_FRAMES = Number(flag('--frames', '6'));
const STRIDE = Number(flag('--stride', '4'));
const SUBSTEPS = Number(flag('--substeps', '3'));

// 16:9, the shape the menu opens on by default, so the fit below has nothing to letterbox
// and the drawing buffer comes out at the viewport's own shape minus the application bar.
const VIEW = { width: 640, height: 360 };
// Measured off the page rather than declared, because it is a term in the golden
// comparison: historical pages have no shell, so their viewport is shortened by the same
// amount to give both arms the same content box.
let APP_BAR_HEIGHT = null;
let SHELL_CONTENT = null;
let COMPARISON_VIEW = null;
const shellGeometry = (barHeight) => {
  APP_BAR_HEIGHT = barHeight;
  SHELL_CONTENT = {
    width: Math.round(VIEW.width * ((VIEW.height - barHeight) / VIEW.height)),
    height: VIEW.height - barHeight,
  };
  COMPARISON_VIEW = { width: VIEW.width, height: VIEW.height + barHeight };
};
let RENDER_BUFFER = { width: VIEW.width, height: VIEW.height };
const POINTS = 512 * 424;
// THREE.NormalBlending and THREE.AdditiveBlending, by value, because the check
// reads the material rather than the registry.
const NORMAL_BLENDING = 1;
const ADDITIVE_BLENDING = 2;

let failures = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
  return ok;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const show = (x) => JSON.stringify(x);

// Playwright is not a dependency of this project - it is a tool the proofs reach
// for - so it is resolved from wherever it happens to be installed.
async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const roots = [];
  try {
    roots.push(execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim());
  } catch { /* no global npm root: the local resolve below may still work */ }

  const candidates = [async () => import('playwright')];
  for (const root of roots) {
    for (const name of ['playwright', '@playwright/cli/node_modules/playwright']) {
      candidates.push(async () => import(pathToFileURL(require.resolve(join(root, name))).href));
    }
  }
  for (const load of candidates) {
    try {
      const mod = await load();
      const pw = mod.chromium ? mod : mod.default;
      if (pw?.chromium) return pw;
    } catch { /* try the next one */ }
  }
  throw new Error('playwright not found - install it globally or in this project');
}

// Capture frame payloads back to back, wire format unchanged apart from the colour
// block being dropped, so the page parses them with the same field offsets the
// socket path uses and the depth is real sensor depth.
function buildFixture(path) {
  const parser = new MessageParser();
  const frames = [];
  for (const msg of parser.push(readFileSync(path))) {
    if (msg.type === TYPE_FRAME) frames.push(msg.payload);
  }
  if (frames.length < SOURCE_FRAMES * STRIDE) {
    throw new Error(`${path} has ${frames.length} frames, need ${SOURCE_FRAMES * STRIDE}`);
  }
  const out = [];
  for (let i = 0; i < SOURCE_FRAMES; i++) {
    const src = frames[i * STRIDE];
    const depthBytes = src.readUInt32LE(0);
    const payload = Buffer.alloc(16 + depthBytes);
    payload.writeUInt32LE(depthBytes, 0);
    payload.writeUInt32LE(0, 4); // colour dropped: JPEG decode is asynchronous
    src.copy(payload, 8, 8, 16); // the capture timestamp, verbatim
    src.copy(payload, 16, 16, 16 + depthBytes);
    out.push(payload);
  }
  return Buffer.concat(out);
}

// Where each value lands, written out independently of the registry. If `apply` stopped
// reaching one of these, every other check here would still pass and this one would not.

const LANDING = {
  pointSize: 'k.uniforms.pointSize.value',
  opacity: 'k.uniforms.opacity.value',
  exposure: 'k.uniforms.exposure.value',
  additive: '[k.material.blending, k.material.depthWrite, k.uniforms.softEdge.value]',
  'glyph.amount': 'k.uniforms.glyph.value',
  'glyph.tone': 'k.uniforms.glyphTone.value',
  'glyph.hash': 'k.uniforms.glyphHash.value',
  'glyph.rain': 'k.uniforms.glyphRain.value',
  near: 'k.uniforms.nearClip.value',
  far: 'k.uniforms.farClip.value',
  left: 'k.uniforms.cropL.value',
  right: 'k.uniforms.cropR.value',
  bottom: 'k.uniforms.cropB.value',
  top: 'k.uniforms.cropT.value',
  crop: 'k.uniforms.cropOn.value',
  interpolate: 'k.uniforms.interpolate.value',
  snapDelta: 'k.uniforms.snapDelta.value',
  fade: '[k.uniforms.fadeTime.value, k.geometry.drawRange.count]',
  wake: '[k.uniforms.wakeTime.value, k.geometry.drawRange.count]',
  'noise.amount': 'k.uniforms.noise.value',
  'noise.scale': 'k.uniforms.noiseScale.value',
  'noise.speed': 'k.uniforms.noiseSpeed.value',
  'lattice.amount': 'k.uniforms.lattice.value',
  cell: 'k.uniforms.latticeCell.value',
  regionX: 'k.uniforms.regionCentre.value.x',
  regionY: 'k.uniforms.regionCentre.value.y',
  regionZ: 'k.uniforms.regionCentre.value.z',
  regionW: 'k.uniforms.regionHalf.value.x',
  regionH: 'k.uniforms.regionHalf.value.y',
  regionD: 'k.uniforms.regionHalf.value.z',
  regionRound: 'k.uniforms.regionRound.value',
  regionSoft: 'k.uniforms.regionSoft.value',
  'push.amount': 'k.uniforms.regionPush.value',
  'noise.region': 'k.uniforms.regionNoise.value',
  'mask.amount': 'k.uniforms.regionMask.value',
  'ripple.amount': 'k.uniforms.ripple.value',
  'ripple.freq': 'k.uniforms.rippleFreq.value',
  'ripple.speed': 'k.uniforms.rippleSpeed.value',
  'glitch.amount': 'k.uniforms.glitch.value',
  'glitch.density': 'k.uniforms.glitchDensity.value',
  'glitch.shove': 'k.uniforms.glitchShove.value',
  'glitch.tint': 'k.uniforms.glitchTint.value',
  'glitch.bands': 'k.uniforms.glitchBands.value',
  'glitch.axis': 'k.uniforms.glitchAxis.value',
  'glitch.rate': 'k.uniforms.glitchRate.value',
  spin: 'k.controls.autoRotate',
  readRgb: 'k.uniforms.readRgb.value',
  readDepth: 'k.uniforms.readDepth.value',
  'ghost.amount': 'k.uniforms.ghost.value',
  'contour.amount': 'k.uniforms.contour.value',
  'blackwall.amount': 'k.uniforms.blackwall.value',
  rgbSaturation: 'k.uniforms.rgbSaturation.value',
  depthGamma: 'k.uniforms.depthGamma.value',
  'ghost.rim': 'k.uniforms.ghostRim.value',
  'ghost.fill': 'k.uniforms.ghostFill.value',
  'contour.bands': 'k.uniforms.contourBands.value',
  'contour.width': '[k.uniforms.contourEdges.value.x, k.uniforms.contourEdges.value.y]',
  'blackwall.sweep': 'k.uniforms.blackwallSweep.value',
  'blackwall.scan': 'k.uniforms.blackwallScan.value',
  rim: 'k.uniforms.rimAmount.value',
  'thermal.amount': 'k.uniforms.thermal.value',
  'edges.amount': 'k.uniforms.edges.value',
  'duotone.amount': 'k.uniforms.duotoneDepth.value',
  'duotone.hue': 'k.uniforms.duotoneHue.value',
  'duotone.split': 'k.uniforms.duotoneSplit.value',
  'duotone.span': 'k.uniforms.duotoneSpan.value',
  'duotone.motion': 'k.uniforms.duotoneMotion.value',
  'rain.amount': 'k.uniforms.rain.value',
  'rain.speed': 'k.uniforms.rainSpeed.value',
  'rain.span': 'k.uniforms.rainSpan.value',
  'rain.trail': 'k.uniforms.rainTrail.value',
  bloom: '[k.bloom.strength, k.bloom.enabled]',
  trails: '[k.afterimage.uniforms.damp.value, k.afterimage.enabled]',
  'rgbsplit.amount': '[k.grade.uniforms.rgbSplit.value, k.grade.enabled]',
  'raster.amount': '[k.grade.uniforms.scanlines.value, k.grade.enabled]',
  'raster.angle': '[k.grade.uniforms.scanAxis.value.x, k.grade.uniforms.scanAxis.value.y].map((v) => Number(v.toFixed(9)))',
  'raster.pitch': 'k.grade.uniforms.scanPitch.value',
  'raster.hard': 'k.grade.uniforms.scanHard.value',
  'grain.amount': '[k.grade.uniforms.grain.value, k.grade.enabled]',
  'streak.amount': '[k.grade.uniforms.streak.value, k.grade.enabled]',
  'streak.angle': '[k.grade.uniforms.streakAxis.value.x, k.grade.uniforms.streakAxis.value.y].map((v) => Number(v.toFixed(9)))',
  'halation.amount': '[k.grade.uniforms.halation.value, k.grade.enabled]',
  'halation.radius': 'k.grade.uniforms.halationRadius.value',
  'halation.threshold': 'k.grade.uniforms.halationThreshold.value',
  'halation.tint': 'k.grade.uniforms.halationTint.value',
  'stock.amount': '[k.grade.uniforms.stock.value, k.grade.enabled]',
  'stock.balance': 'k.grade.uniforms.stockBalance.value',
  'stock.split': 'k.grade.uniforms.stockSplit.value',
  'stock.latitude': 'k.grade.uniforms.stockLatitude.value',
  'vignette.amount': '[k.grade.uniforms.vignette.value, k.grade.enabled]',
  crush: 'k.grade.uniforms.crush.value',
  'datamosh.amount': '[k.mosh.uniforms.mosh.value, k.mosh.enabled]',
  'datamosh.reach': 'k.mosh.uniforms.moshReach.value',
  'datamosh.decay': 'k.mosh.uniforms.moshDecay.value',
  'datamosh.splay': 'k.mosh.uniforms.moshSplay.value',
  'datamosh.line': 'k.mosh.uniforms.moshLine.value',
  'datamosh.grain': 'k.mosh.uniforms.moshGrain.value',
  'datamosh.drift': 'k.mosh.uniforms.moshDrift.value',
  'datamosh.speed': 'k.mosh.uniforms.moshSpeed.value',
  'datamosh.cycleRefresh': 'k.mosh.uniforms.moshCycleRefresh.value',
  'datamosh.refresh': 'k.mosh.uniforms.moshRefresh.value',
  denoise: 'k.uniforms.denoise.value',
  edgeTol: 'k.uniforms.edgeTol.value',
  renderScale: 'k.renderer.getContext().drawingBufferWidth',
  tilt: 'k.worldTilt().map((v) => Number(v.toFixed(9)))',
  roll: 'k.worldTilt().map((v) => Number(v.toFixed(9)))',
  camera: '[...k.programCamera.position.toArray(), ...k.programCamera.quaternion.toArray(), k.programCamera.fov]',
  // The selected clip's own placement group, which is the node the registry's write moves.
  transform: '((c) => [...c.placement.position, ...c.placement.quaternion])'
    + '(k.timeline.clips().find((clip) => clip.selected))',
};

/**
 * The quaternion `tilt` and `roll` have to compose into: `Rx(tilt) * Rz(roll)`. Written out
 * here rather than read back from the page, which would agree with itself.
 */
function levellingQuaternion(tiltDeg, rollDeg) {
  const t = (tiltDeg * (Math.PI / 180)) / 2;
  const r = (rollDeg * (Math.PI / 180)) / 2;
  const st = Math.sin(t); const ct = Math.cos(t);
  const sr = Math.sin(r); const cr = Math.cos(r);
  return [st * cr, -st * sr, ct * sr, ct * cr].map((v) => Number(v.toFixed(9)));
}

// What that landing site must read, given the value the registry was handed. The
// ones taking `all` are the parameters that share a side effect with another.
const EXPECT = {
  pointSize: (v) => v,
  opacity: (v) => v,
  exposure: (v) => v,
  additive: (v) => [v ? ADDITIVE_BLENDING : NORMAL_BLENDING, !v, v ? 1 : 0],
  'glyph.amount': (v) => v,
  'glyph.tone': (v) => v,
  'glyph.hash': (v) => v,
  'glyph.rain': (v) => v,
  near: (v) => v,
  far: (v) => v,
  left: (v) => v,
  right: (v) => v,
  bottom: (v) => v,
  top: (v) => v,
  crop: (v) => (v ? 1 : 0),
  interpolate: (v) => (v ? 1 : 0),
  snapDelta: (v) => v,
  fade: (v, all) => [v / 1000, v > 0 || all.wake > 0 ? POINTS * 2 : POINTS],
  wake: (v, all) => [v / 1000, all.fade > 0 || v > 0 ? POINTS * 2 : POINTS],
  'noise.amount': (v) => v,
  'noise.scale': (v) => v,
  'noise.speed': (v) => v,
  'lattice.amount': (v) => v,
  cell: (v) => v,
  regionX: (v) => v,
  regionY: (v) => v,
  regionZ: (v) => v,
  regionW: (v) => v,
  regionH: (v) => v,
  regionD: (v) => v,
  regionRound: (v) => v,
  regionSoft: (v) => v,
  'push.amount': (v) => v,
  'noise.region': (v) => v,
  'mask.amount': (v) => v,
  'ripple.amount': (v) => v,
  'ripple.freq': (v) => v,
  'ripple.speed': (v) => v,
  'glitch.amount': (v) => v,
  'glitch.density': (v) => v,
  'glitch.shove': (v) => v,
  'glitch.tint': (v) => v,
  'glitch.bands': (v) => v,
  'glitch.axis': (v) => v,
  'glitch.rate': (v) => v,
  spin: (v) => v,
  readRgb: (v) => v,
  readDepth: (v) => v,
  'ghost.amount': (v) => v,
  'contour.amount': (v) => v,
  'blackwall.amount': (v) => v,
  rgbSaturation: (v) => v,
  depthGamma: (v) => v,
  'ghost.rim': (v) => v,
  'ghost.fill': (v) => v,
  'contour.bands': (v) => v,
  'contour.width': (v) => [0.5 - v, 0.5 + v],
  'blackwall.sweep': (v) => v,
  'blackwall.scan': (v) => v,
  rim: (v) => v,
  'thermal.amount': (v) => v,
  'edges.amount': (v) => v,
  'duotone.amount': (v) => v,
  'duotone.hue': (v) => v * (Math.PI / 180),
  'duotone.split': (v) => v,
  'duotone.span': (v) => v,
  'duotone.motion': (v) => v,
  'rain.amount': (v) => v,
  'rain.speed': (v) => v,
  'rain.span': (v) => v,
  'rain.trail': (v) => v,
  bloom: (v) => [v, v > 0],
  trails: (v) => [v, v > 0],
  'rgbsplit.amount': (v, all) => [v, v > 0 || all['raster.amount'] > 0 || all['grain.amount'] > 0
    || all['vignette.amount'] > 0 || all['streak.amount'] > 0 || all['halation.amount'] > 0
    || all['stock.amount'] > 0],
  'raster.amount': (v, all) => [v, all['rgbsplit.amount'] > 0 || v > 0 || all['grain.amount'] > 0
    || all['vignette.amount'] > 0 || all['streak.amount'] > 0 || all['halation.amount'] > 0
    || all['stock.amount'] > 0],
  'raster.angle': (v) => [Math.sin(v * (Math.PI / 180)), Math.cos(v * (Math.PI / 180))]
    .map((x) => Number(x.toFixed(9))),
  'raster.pitch': (v) => v,
  'raster.hard': (v) => v,
  'grain.amount': (v, all) => [v, all['rgbsplit.amount'] > 0 || all['raster.amount'] > 0 || v > 0
    || all['vignette.amount'] > 0 || all['streak.amount'] > 0 || all['halation.amount'] > 0
    || all['stock.amount'] > 0],
  'streak.amount': (v, all) => [v, all['rgbsplit.amount'] > 0 || all['raster.amount'] > 0
    || all['grain.amount'] > 0 || all['vignette.amount'] > 0 || v > 0
    || all['halation.amount'] > 0 || all['stock.amount'] > 0],
  'streak.angle': (v) => [Math.sin(v * (Math.PI / 180)), Math.cos(v * (Math.PI / 180))]
    .map((x) => Number(x.toFixed(9))),
  'halation.amount': (v, all) => [v, all['rgbsplit.amount'] > 0 || all['raster.amount'] > 0
    || all['grain.amount'] > 0 || all['vignette.amount'] > 0 || all['streak.amount'] > 0
    || v > 0 || all['stock.amount'] > 0],
  'halation.radius': (v) => v,
  'halation.threshold': (v) => v,
  'halation.tint': (v) => v,
  'stock.amount': (v, all) => [v, all['rgbsplit.amount'] > 0 || all['raster.amount'] > 0
    || all['grain.amount'] > 0 || all['vignette.amount'] > 0 || all['streak.amount'] > 0
    || all['halation.amount'] > 0 || v > 0],
  'stock.balance': (v) => v,
  'stock.split': (v) => v,
  'stock.latitude': (v) => v,
  'vignette.amount': (v, all) => [v, all['rgbsplit.amount'] > 0 || all['raster.amount'] > 0
    || all['grain.amount'] > 0 || v > 0 || all['streak.amount'] > 0
    || all['halation.amount'] > 0 || all['stock.amount'] > 0],
  crush: (v) => v,
  // The master is the only term on the mosh table that gates, so the pass is open exactly when
  // it is up - no `||` run like the grade's, where seven terms share one pass.
  'datamosh.amount': (v) => [v, v > 0],
  'datamosh.reach': (v) => v,
  'datamosh.decay': (v) => v,
  'datamosh.splay': (v) => v,
  'datamosh.line': (v) => v,
  'datamosh.grain': (v) => v,
  'datamosh.drift': (v) => v,
  'datamosh.speed': (v) => v,
  'datamosh.cycleRefresh': (v) => v,
  'datamosh.refresh': (v) => v,
  denoise: (v) => (v ? 1 : 0),
  edgeTol: (v) => v,
  // three floors width * pixelRatio, and the context runs at deviceScaleFactor 1.
  renderScale: (v) => Math.floor(RENDER_BUFFER.width * (v / 100)),
  // Both read the whole pair, because both land on the same rotation.
  tilt: (v, all) => levellingQuaternion(v, all.roll),
  roll: (v, all) => levellingQuaternion(all.tilt, v),
  camera: (v) => [...v.position, ...v.quaternion, v.fov],
  transform: (v) => [...v.position, ...v.quaternion],
};

// A scrambled but valid set: every value off its default and on its own step grid,
// every boolean flipped. This is what gets serialised, restored and hashed.
const SCRAMBLE = {
  pointSize: 9.5,
  opacity: 0.62,
  exposure: 2.05,
  additive: true,
  'glyph.amount': 0.5,
  'glyph.tone': 0.8,
  'glyph.hash': 0.9,
  'glyph.rain': 0.73,
  tilt: 13.5,
  roll: -21.5,
  near: 0.35,
  far: 4.2,
  crop: true,
  left: -1.5,
  right: 1.5,
  bottom: -1.5,
  top: 1,
  interpolate: false,
  snapDelta: 410,
  fade: 260,
  wake: 830,
  'noise.amount': 0.08,
  'noise.scale': 5.5,
  'noise.speed': 1.45,
  'lattice.amount': 1,
  cell: 0.11,
  'glitch.amount': 0.31,
  'glitch.density': 0.62,
  'glitch.shove': 1,
  'glitch.tint': 3,
  'glitch.bands': 27,
  'glitch.axis': 0.78,
  'glitch.rate': 13.5,
  regionX: 0.05,
  regionY: 0.15,
  regionZ: -1.9,
  regionW: 0.4,
  regionH: 0.4,
  regionD: 0.4,
  regionRound: 0.9,
  regionSoft: 0.6,
  'push.amount': 0.35,
  'noise.region': 0.25,
  'mask.amount': 0.4,
  'ripple.amount': 0.14,
  'ripple.freq': 6.3,
  'ripple.speed': 1.35,
  spin: true,
  readRgb: 0.4,
  readDepth: 0.3,
  'ghost.amount': 0.2,
  'ghost.rim': 1.4,
  'ghost.fill': 0.7,
  'contour.amount': 0.15,
  'contour.bands': 27,
  'contour.width': 0.2,
  'blackwall.amount': 0.6,
  'blackwall.sweep': 0.9,
  'blackwall.scan': 0.72,
  rgbSaturation: 1.6,
  depthGamma: 0.6,
  rim: 0.28,
  // Order matters here and nowhere else in this file: the comparison against the serialised
  // set is a JSON.stringify equality, so these keys sit in the order PARAMS declares them.
  'thermal.amount': 0.6,
  'edges.amount': 0.45,
  'duotone.amount': 0.65,
  'duotone.hue': 47,
  'duotone.split': 0.36,
  'duotone.span': 1.15,
  'duotone.motion': 0.83,
  'rain.amount': 0.6,
  'rain.speed': 1.35,
  'rain.span': 0.73,
  'rain.trail': 0.28,
  bloom: 1,
  trails: 0.44,
  'rgbsplit.amount': 2.3,
  'raster.amount': 0.61,
  'raster.angle': 63,
  'raster.pitch': 0.37,
  'raster.hard': 0.82,
  'grain.amount': 0.37,
  'streak.amount': 0.62,
  'streak.angle': 113,
  'halation.amount': 0.58,
  'halation.radius': 55,
  'halation.threshold': 0.21,
  'halation.tint': 0.86,
  'stock.amount': 0.66,
  'stock.balance': -0.74,
  'stock.split': 0.28,
  'stock.latitude': 0.14,
  'vignette.amount': 0.73,
  crush: 0.062,
  'datamosh.amount': 0.83,
  'datamosh.reach': 23.5,
  'datamosh.decay': 0.71,
  'datamosh.splay': 0.34,
  'datamosh.line': 0.38,
  'datamosh.grain': 7,
  'datamosh.drift': 1,
  'datamosh.speed': 4,
  'datamosh.cycleRefresh': true,
  'datamosh.refresh': 1.85,
  denoise: false,
  edgeTol: 340,
  renderScale: 85,
  // A unit quaternion, 30 degrees about Y, so the read-back is exact.
  camera: { position: [0.4, 0.9, 1.1], quaternion: [0, 0.25881904510252074, 0, 0.9659258262890683], fov: 42 },
  // Small on purpose: a placement that carried the cloud out of frame would make every other
  // row here a comparison of two black pictures. 10 degrees about Y, so the read-back is exact.
  transform: { position: [0.06, -0.03, 0.04], quaternion: [0, 0.08715574274765817, 0, 0.9961946980917455] },
};

// The closed list of parameters allowed to leave the image untouched when they are dropped
// from a restore, with the reason each one cannot reach the pixels here. Anything else
// landing in that bucket is a failure.
const NO_PIXEL_EFFECT = {
  bottom: 'the scrambled lower face is below this fixture - proven instead by the focused '
    + 'bottom-face arm below',
  snapDelta: 'the pinned frames do not straddle its threshold - proven instead by the planted '
    + '300mm jump below',
  crop: 'its scrambled value is its default, because releasing the box would make the '
    + 'six faces it gates unobservable - proven instead by the section below',
  spin: 'auto-orbit only advances when the animation loop calls controls.update, '
    + 'and a pinned run has replaced the loop',
  camera: 'nothing draws the program camera on the pinned run - the viewport is the '
    + 'free camera - so a pose reaches the camera object and no pixel',
  'datamosh.refresh': 'it is a period in seconds and this run is 0.622s long, so no refresh '
    + 'falls inside it at 1.2 or at 1.85 and the two values render the same frames. Measured '
    + 'rather than assumed - the run prints its own span two sections up. It reaches pixels in '
    + 'timeline-check section 7, where the arm is twelve seconds in and `--mutate '
    + 'mosh-never-refreshes` reddens two rows',
  'datamosh.cycleRefresh': 'the run is shorter than the scrambled refresh period - proven '
    + 'instead by the focused refresh-cycle arm below',
};

const PAGE_HELPERS = `
  const k = globalThis.__kinect;
  const sha256 = async (bytes) => {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  };
  const pinCamera = (cam) => {
    cam.position.set(0, 0.1, 1.6);
    cam.lookAt(0, 0, -2.2);
    cam.updateMatrixWorld(true);
  };
`;

// The generated keys are JSON-quoted because the dotted parameter names are not
// identifiers: an unquoted `glyph.tone:` is a syntax error inside `page.evaluate`.
const landingReader = `(() => {
  const k = globalThis.__kinect;
  return { ${Object.entries(LANDING).map(([n, e]) => `${JSON.stringify(n)}: (${e})`).join(', ')} };
})()`;

// The same reader with every expression allowed to come back undefined, used on exactly
// one page: the revision the golden comparison plays back, which predates some of these
// parameters. Deliberately not used for the current page, where a LANDING entry naming a
// uniform this build does not have is a real bug in the check.
const tolerantLandingReader = `(() => {
  const k = globalThis.__kinect;
  const at = (f) => { try { return f(); } catch { return undefined; } };
  return { ${Object.entries(LANDING).map(([n, e]) => `${JSON.stringify(n)}: at(() => (${e}))`).join(', ')} };
})()`;

const readLanding = (page) => page.evaluate(landingReader);

// Everything the two arms of the before/after comparison can both answer. No `k.params`
// here: the committed page has none, and a snapshot only the new page could produce would
// compare nothing.
const snapshotWith = (reader) => `(() => {
  const k = globalThis.__kinect;
  return {
    landing: ${reader},
    fog: k.scene.fog.color.getHex(),
    dom: Object.fromEntries([...document.querySelectorAll('#panel input')]
      .map((el) => [el.id, el.type === 'checkbox' ? el.checked : el.value])),
    // Range rows only. A readout is the number beside a slider, so a checkbox row has
    // none by design - and the monitor group added one in step 9, at which point this
    // map started calling .textContent on null and took the whole section down before
    // a single assertion ran. Filtering to the rows that are supposed to have a readout
    // is what the map always meant.
    //
    // The missing one is still reported rather than skipped: a *slider* that lost its
    // output is exactly the regression this map exists to catch, and it now shows up as
    // a differing value instead of as a crash.
    readouts: Object.fromEntries([...document.querySelectorAll('#panel .row')]
      .filter((r) => r.querySelector('input')?.type === 'range')
      .map((r) => [r.querySelector('input').id,
        r.querySelector('output')?.textContent ?? '(no output element)'])),
  };
})()`;

const { chromium } = await loadPlaywright();
// The full chromium build rather than the headless shell: the shell can land on
// SwiftShader, and a run that quietly fell back to a software rasteriser would
// agree with itself for the wrong reason.
const browser = await chromium.launch({ channel: 'chromium', headless: !HEADED });
const context = await browser.newContext({ viewport: VIEW, deviceScaleFactor: 1 });

const fixture = buildFixture(CAPTURE);

// A page with no source of its own is this tree's page, which under `--mutate` is the
// mutated one. The arms that name a source are the historical revisions and are left
// alone: mutating what a comparison is measured against moves both sides.
async function openPage({
  source = mutatedSource,
  pin = false,
  viewportSize = VIEW,
  comparisonShell = false,
  within = context,
  at = RECORDER_PATH,
} = {}) {
  const page = await within.newPage();
  if (viewportSize.width !== VIEW.width || viewportSize.height !== VIEW.height) {
    await page.setViewportSize(viewportSize);
  }
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(`${msg.text()} @ ${JSON.stringify(msg.location())}`); });
  // A console error names no URL, so the response is recorded beside it - a 404 on the
  // module and a 404 on the tab icon read identically otherwise.
  page.on('response', (res) => { if (!res.ok()) errors.push(`${res.status()} ${res.url()}`); });

  // No frame may arrive. The look values under test do not depend on the stream, and letting
  // the server decide whether one lands makes a verdict that flips between runs.
  await page.routeWebSocket(/.*/, () => { /* accepted, never connected */ });

  // The tab icon, answered rather than left to 404: the console error it produces is
  // indistinguishable from a real failure to load.
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

  let servedHtml = false;
  if (source) {
    // The panel and the module are served as one pair. The committed page reads its ranges
    // out of its own HTML, so pairing the old module with the new markup would boot it on
    // whatever a range input defaults to. The predicate and the `goto` below read one
    // constant rather than each spelling the path.
    await page.route((url) => url.pathname === at,
      (route) => { servedHtml = true; return route.fulfill({ contentType: 'text/html; charset=utf-8', body: source.html }); });
    await page.route((url) => url.pathname === MAIN_PATH, (route) => route.fulfill({
      contentType: 'text/javascript; charset=utf-8', body: source.js,
    }));
  }
  // The file the mutation actually edits, at its own path, and only ever for this tree's
  // own pages: the historical arms pass an explicit source, and mutating what a comparison
  // is measured against moves both sides. Registered after the `main.js` route so it wins
  // when the two paths are the same, which is what makes `mutantServed` count the delivery.
  if (mutatedSource && source === mutatedSource) {
    for (const mutant of mutatedSource.mutants) {
      await page.route((url) => url.pathname === mutant.path, (route) => {
        mutantServed.set(mutant.path, mutantServed.get(mutant.path) + 1);
        return route.fulfill({ contentType: mutant.type, body: mutant.body });
      });
    }
  }
  if (pin) {
    await page.route('**/__pinned.bin', (route) => route.fulfill({
      status: 200, contentType: 'application/octet-stream', body: fixture,
    }));
  }

  await page.goto(URL_BASE + at, { waitUntil: 'load' });
  // Proof the interception held. A predicate that stopped matching would pair the old module
  // with today's markup, which throws at boot and arrives as a timeout naming nothing.
  if (source && !servedHtml) {
    throw new Error(`the page markup was never intercepted - landed on ${new URL(page.url()).pathname}, `
      + `so the ${BEFORE_REV} arm loaded the tree's own page`);
  }
  await page.waitForFunction(() => !!globalThis.__kinect);
  if (comparisonShell) {
    // The comparison build predates the fixed application bar, so both revisions are
    // canonicalised onto its bottom-strip allocation and get the same 640x360 content box.
    await page.evaluate((height) => {
      const appBar = document.getElementById('appBar');
      if (appBar) appBar.style.display = 'none';
      const timeline = document.getElementById('timeline');
      timeline.hidden = false;
      timeline.style.height = `${height}px`;
      timeline.style.minHeight = `${height}px`;
      timeline.style.maxHeight = `${height}px`;
      dispatchEvent(new Event('resize'));
    }, APP_BAR_HEIGHT);
  }
  // The stage size, asked for under both builds' names for the hook, and optional after
  // both: the boot-state arm predates letterboxing, publishes neither, and arrives at this
  // size by having nothing to fit.
  await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    (k.setOutputSize ?? k.setTargetSize)?.('640x360');
  })()`);

  // Proof the interception held, independent of the readings it protects. The sensor's hello
  // carries fx as 366.031494 and the uniform defaults to exactly 366, so the default still
  // standing means nothing came over the socket.
  const focal = await page.evaluate('globalThis.__kinect.uniforms.focal.value.x');
  if (focal !== 366) throw new Error(`websocket interception failed - intrinsics arrived (focal.x=${focal})`);

  return { page, errors };
}

console.log(`[registry] nothing moved: boot state against ${BEFORE_REV}`);

const beforeSource = {
  js: execFileSync('git', ['show', `${BEFORE_REV}:web/main.js`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
  html: execFileSync('git', ['show', `${BEFORE_REV}:web/index.html`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
};
// A bare --before HEAD would serve the registry into both arms and print two matching
// columns under a heading that says they came from different code.
if (beforeSource.js.includes('const PARAMS')) {
  throw new Error(`${BEFORE_REV}:web/main.js already contains the registry - pass an earlier rev with --before`);
}

// The program pose at a few positions, read in the same task as the render so the live loop cannot
// re-render at 0 underneath the reading. Three orients cameras down -Z where it orients everything
// else down +Z, so a slip would be invisible until something drew the frustum.
const readPoses = `(() => {
  const k = globalThis.__kinect;
  const out = {};
  for (const t of [0.7, 1.9]) {
    k.renderProgramFrame(t);
    out[t] = {
      position: k.programCamera.position.toArray(),
      quaternion: k.programCamera.quaternion.toArray(),
      fov: k.programCamera.fov,
    };
  }
  return out;
})()`;

async function bootState(opts, reader = landingReader) {
  const { page, errors } = await openPage(opts);
  const out = { boot: await page.evaluate(snapshotWith(reader)) };
  const poses = await page.evaluate(readPoses);
  return { out, poses, errors, page };
}

// The after arm goes first because it is what says how tall the bar is: the before arm's
// viewport is derived from that measurement.
const afterArm = await bootState({});
// Exit 2 rather than a failed assertion: a suite that fails a row on a mutation run reads
// as a catch, so a mutation the page never asked for has to be the harness declining to run.
if (MUTATE) {
  const unserved = [...mutantServed].filter(([, n]) => n === 0).map(([path]) => path);
  if (unserved.length) {
    console.log(`\n[registry] DID NOT RUN - ${MUTATE} was staged for ${unserved.join(', ')} and the page never `
      + 'requested it, so this run would have measured a build the mutation did not fully reach');
    process.exit(2);
  }
}
const measuredBar = await afterArm.page.evaluate(
  "Math.round(document.getElementById('appBar').getBoundingClientRect().height)");
await afterArm.page.close();
if (!Number.isFinite(measuredBar) || measuredBar <= 0) {
  throw new Error(`the application bar measured ${measuredBar}px - the shell this arm is compared against is not on the page`);
}
shellGeometry(measuredBar);
console.log(`  the shell's application bar measures ${APP_BAR_HEIGHT}px, `
  + `so the content box both arms render is ${SHELL_CONTENT.width}x${SHELL_CONTENT.height}`);

const beforeArm = await bootState(
  { source: beforeSource, viewportSize: SHELL_CONTENT },
  tolerantLandingReader,
);
await beforeArm.page.close();

// The camera is left out of the landing comparison, alone among the twenty-five. Its landing
// site at the pinned revision was a placeholder orbit computed from `t`, so there is no
// earlier value an equality could be a regression test against.
const GOLDEN_SKIP = new Set(['camera']);

// The one value that legitimately moved, rescaled rather than skipped: `pointSize` is pixels
// at 1080p now, where it was pixels at the 600-tall buffer the look was authored on.
const POINT_SIZE_REBASE = 1080 / 600;
const GOLDEN_RESCALE = { pointSize: POINT_SIZE_REBASE };

// The rename, which is a fact about history on the rescale's terms: the committed page's
// control ids are the old spellings, and the `dom` and `readouts` halves are keyed by them.
const GOLDEN_RENAME = {
  'noise.amount': 'noise',
  'noise.scale': 'noiseScale',
  'noise.speed': 'noiseSpeed',
  'noise.region': 'regionNoise',
  'lattice.amount': 'lattice',
  cell: 'latticeCell',
  'glyph.amount': 'glyph',
  'glyph.tone': 'glyphTone',
  'glyph.hash': 'glyphHash',
  'glyph.rain': 'glyphRain',
  'ghost.amount': 'readGhost',
  'ghost.rim': 'ghostRim',
  'ghost.fill': 'ghostFill',
  'contour.amount': 'readContour',
  'contour.bands': 'contourBands',
  'contour.width': 'contourWidth',
  'blackwall.amount': 'readBlackwall',
  'blackwall.sweep': 'blackwallSweep',
  'blackwall.scan': 'scan',
  'rain.amount': 'rain',
  'rain.speed': 'rainSpeed',
  'rain.span': 'rainSpan',
  'rain.trail': 'rainTrail',
  'glitch.amount': 'glitch',
  'glitch.density': 'glitchDensity',
  'glitch.shove': 'glitchShove',
  'glitch.tint': 'glitchTint',
  'glitch.bands': 'glitchBands',
  'glitch.axis': 'glitchAxis',
  'glitch.rate': 'glitchRate',
  'push.amount': 'regionPush',
  'mask.amount': 'regionMask',
  'ripple.amount': 'ripple',
  'ripple.freq': 'rippleFreq',
  'ripple.speed': 'rippleSpeed',
  'thermal.amount': 'thermal',
  'edges.amount': 'edges',
  'duotone.amount': 'duotoneDepth',
  'duotone.hue': 'duotoneHue',
  'duotone.split': 'duotoneSplit',
  'duotone.span': 'duotoneSpan',
  'duotone.motion': 'duotoneMotion',
  'rgbsplit.amount': 'rgbSplit',
  'streak.amount': 'streak',
  'streak.angle': 'streakAngle',
  'raster.amount': 'scanlines',
  'raster.angle': 'scanAngle',
  'raster.pitch': 'scanPitch',
  'raster.hard': 'scanHard',
  'grain.amount': 'grain',
  'vignette.amount': 'vignette',
};
// The same fact read the other way, for folding the earlier arm's keys into the union.
const OLD_SPELLING = Object.fromEntries(
  Object.entries(GOLDEN_RENAME).map(([now, was]) => [was, now]));

// Parameters that did not exist at BEFORE_REV. A name is only excused here if the earlier
// arm answered undefined, so an excuse that has stopped being true fails rather than passes.
const GOLDEN_ABSENT = new Set([
  'noise.amount', 'noise.scale', 'noise.speed',
  'lattice.amount', 'cell',
  'regionX', 'regionY', 'regionZ', 'regionW', 'regionH', 'regionD',
  'regionRound', 'regionSoft', 'push.amount', 'noise.region', 'mask.amount',
  'ripple.amount', 'ripple.freq', 'ripple.speed',
  'thermal.amount', 'edges.amount',
  'left', 'right', 'bottom', 'top',
  'crop',
  'tilt', 'roll',
  'monDivisor', 'monStride', 'monAcceptCost',
  'readRgb', 'readDepth', 'ghost.amount', 'contour.amount', 'blackwall.amount',
  'rgbSaturation', 'depthGamma', 'ghost.rim', 'ghost.fill',
  'contour.bands', 'contour.width', 'blackwall.sweep', 'blackwall.scan',
  'glitch.density', 'glitch.shove', 'glitch.tint', 'glitch.bands', 'glitch.rate',
  'glitch.axis',
  'vignette.amount',
  'duotone.amount', 'duotone.hue', 'duotone.split', 'duotone.span', 'duotone.motion',
  'glyph.amount', 'glyph.tone', 'glyph.hash', 'glyph.rain',
  'rain.amount', 'rain.speed', 'rain.span', 'rain.trail',
  'crush',
  'raster.angle', 'raster.pitch', 'raster.hard',
  'streak.amount',
  'streak.angle',
  'halation.amount', 'halation.radius', 'halation.threshold', 'halation.tint',
  'stock.amount', 'stock.balance', 'stock.split', 'stock.latitude',
  'progSize',
  'tPresetFile',
  'datamosh.amount', 'datamosh.reach', 'datamosh.decay', 'datamosh.splay',
  'datamosh.line', 'datamosh.grain', 'datamosh.refresh',
  // The three added after the pass first shipped and missed here, which stopped the golden boot
  // comparison and took every assertion after it down with it: main ran 13 of 155. Checked
  // against the manifest rather than found one run at a time - all ten of its params are named
  // here now, so the next one added is a row that reddens rather than a tool that stops.
  'datamosh.drift', 'datamosh.speed', 'datamosh.cycleRefresh',
  'camLens',
  'transform',
]);
const absentBefore = (name, before) => GOLDEN_ABSENT.has(name) && before === undefined;

// The mirror, and it needs the mirrored evidence: `warp` and `warpSpeed` drove a sine field
// the noise field replaced, and no rescale recovers one from the other.
const GOLDEN_REMOVED = new Set(['warp', 'warpSpeed']);
const removedSince = (name, after) => GOLDEN_REMOVED.has(name) && after === undefined;

const rescaled = (name, before, after) => {
  const factor = GOLDEN_RESCALE[name];
  if (!factor) return false;
  const x = Number(before);
  const y = Number(after);
  return Number.isFinite(x) && Number.isFinite(y) && y === x * factor;
};

for (const stage of Object.keys(beforeArm.out)) {
  const a = beforeArm.out[stage];
  const b = afterArm.out[stage];
  // Which halves join through GOLDEN_RENAME: `dom` and `readouts` are keyed by the page's own
  // control ids, where `landing` is keyed by this file's LANDING table on both arms.
  const joined = (field) => field !== 'landing';
  const spelledThen = (field, sub) => (joined(field) ? (GOLDEN_RENAME[sub] ?? sub) : sub);
  const unexplained = (field) => (typeof a[field] === 'object' && a[field]
    // Keyed off the union rather than the earlier arm's keys, because a parameter this build
    // added is absent from `a` entirely.
    ? [...new Set([
      ...Object.keys(a[field]).map((k) => (joined(field) && OLD_SPELLING[k]) || k),
      ...Object.keys(b[field] ?? {})])]
      .filter((sub) => !eq(a[field][spelledThen(field, sub)], b[field][sub])
        && !GOLDEN_SKIP.has(sub)
        && !rescaled(sub, a[field][spelledThen(field, sub)], b[field][sub])
        && !absentBefore(sub, a[field][spelledThen(field, sub)])
        && !removedSince(sub, b[field][sub]))
    : []);
  const differing = Object.keys(a).filter((field) => {
    if (eq(a[field], b[field])) return false;
    if (typeof a[field] !== 'object' || !a[field]) return true;
    return unexplained(field).length > 0;
  });
  const detail = differing.map((field) => {
    const keys = unexplained(field);
    return keys.length
      ? `${field}{${keys.map((s) => `${s}: ${show(a[field][spelledThen(field, s)])} -> ${show(b[field][s])}`).join(', ')}}`
      : `${field}: ${show(a[field])} -> ${show(b[field])}`;
  }).join('; ');
  check(differing.length === 0, `${stage.padEnd(10)} identical to ${BEFORE_REV}`, detail);
}

{
  const wrong = [];
  const seen = [];
  for (const stage of Object.keys(beforeArm.out)) {
    for (const field of ['landing', 'dom', 'readouts']) {
      const x = Number(beforeArm.out[stage][field]?.pointSize);
      const y = Number(afterArm.out[stage][field]?.pointSize);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      if (field === 'landing') seen.push(`${stage} ${x}->${y}`);
      if (y !== x * POINT_SIZE_REBASE) wrong.push(`${stage}.${field} ${x} -> ${y}`);
    }
  }
  check(wrong.length === 0,
    `and pointSize moved by exactly 1080/600 everywhere it appears, because its unit did`,
    wrong.length ? wrong.join('; ') : seen.join(', '));
}

check(
  beforeArm.out.boot.landing.renderScale === SHELL_CONTENT.width
    && afterArm.out.boot.landing.renderScale === SHELL_CONTENT.width,
  'and renderScale lands on exactly the fixed shell content fit',
  `${beforeArm.out.boot.landing.renderScale}->${afterArm.out.boot.landing.renderScale}, `
    + `wanted ${SHELL_CONTENT.width}->${SHELL_CONTENT.width}`,
);

check(eq(afterArm.poses['0.7'], afterArm.poses['1.9']),
  'with no camera keys the program pose is the clip\'s single value at every program time',
  eq(afterArm.poses['0.7'], afterArm.poses['1.9']) ? '' : show(afterArm.poses));
console.log(`  pose at 0.7s ${show(afterArm.poses['0.7'].position.map((x) => +x.toFixed(6)))} `
  + `q ${show(afterArm.poses['0.7'].quaternion.map((x) => +x.toFixed(6)))}`);

if (beforeArm.errors.length || afterArm.errors.length) {
  console.log(`  page errors: ${[...beforeArm.errors, ...afterArm.errors].join(' | ')}`);
  failures++;
}

const AGAINST_REV = flag('--against')
  ?? (execFileSync('git', ['log', '-S', 'readBlackwall', '--format=%H', '--', 'web/main.js'],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }).trim()
    ? revBeforeMarker('readBlackwall')
    : 'HEAD');

// Each reading, and the mode it was. The old build selects by writing the integer uniform
// rather than by clicking its button: `setMode` applied a twelve-value preset on the way
// past, and what is under test is the reading.
const READING_WAS = {
  readRgb: 0,
  readDepth: 1,
  'ghost.amount': 2,
  'contour.amount': 3,
  'blackwall.amount': 4,
};

console.log(`\n[registry] each reading renders what its mode rendered, at ${AGAINST_REV}`);

{
  const againstSource = {
    js: execFileSync('git', ['show', `${AGAINST_REV}:web/main.js`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
    html: execFileSync('git', ['show', `${AGAINST_REV}:web/index.html`], { cwd: REPO, encoding: 'utf8', maxBuffer: 1 << 26 }),
  };
  // The mirror of section 1's refusal: serving today's page into both arms would print five
  // matching hashes under a heading claiming they came from different code.
  if (againstSource.js.includes('readBlackwall')) {
    throw new Error(`${AGAINST_REV}:web/main.js already contains the readings - pass an earlier rev with --against`);
  }
  if (!againstSource.js.includes('uniforms.mode.value')) {
    throw new Error(`${AGAINST_REV}:web/main.js has no mode uniform to compare against`);
  }

  // The old arm is the old readings, not the old geometry. The unprojection's x sign changed
  // after this rev, so left alone the pinned build draws the room reflected and every row
  // below reports a difference that has nothing to do with a reading. Guarded the way the
  // mutations are: the text has to appear exactly once or this refuses to run.
  const OLD_UNPROJECT_X = '     (pixel.x + 0.5 - center.x) / focal.x * z,';
  const MIRRORED_UNPROJECT_X = '    -(pixel.x + 0.5 - center.x) / focal.x * z,';
  const xHits = againstSource.js.split(OLD_UNPROJECT_X).length - 1;
  if (xHits !== 1) {
    throw new Error(`${AGAINST_REV}:web/main.js states the unprojection's x ${xHits} times, expected exactly 1`
      + ' - refusing to compare a mirrored build against an unmirrored one and report it as a reading');
  }
  againstSource.js = againstSource.js.replace(OLD_UNPROJECT_X, MIRRORED_UNPROJECT_X);

  // The second intentional divergence. The zero-alpha discard is an approved change to the picture
  // and the old arm has no such discard, so the patch hands it the same rule in its own source
  // rather than letting the approved movement arrive as a finding about the readings.
  const OLD_FRAG_OUTPUT = '  fragColor = vec4(col * exposure, alpha * falloff);';
  const DISCARDED_FRAG_OUTPUT = '  if (softEdge == 0 && alpha * falloff <= 0.0) discard;\n'
    + '  fragColor = vec4(col * exposure, alpha * falloff);';
  const outHits = againstSource.js.split(OLD_FRAG_OUTPUT).length - 1;
  if (outHits !== 1) {
    throw new Error(`${AGAINST_REV}:web/main.js states the fragment output ${outHits} times, expected exactly 1`
      + ' - refusing to compare an arm with the zero-alpha discard against one without it and report it as a reading');
  }
  againstSource.js = againstSource.js.replace(OLD_FRAG_OUTPUT, DISCARDED_FRAG_OUTPUT);

  // Both arms are pinned to the same frames and the same camera, so the only thing that
  // differs between them is the shader. `params.reset()` first on each, because a reading has
  // to be measured against the same defaults the other arm booted with.
  const hashesFor = async (opts, select, cases = READING_WAS, extra = '') => {
    const { page: p, errors } = await openPage({ ...opts, pin: true });
    await p.evaluate(async () => {
      const buffer = await (await fetch('/__pinned.bin')).arrayBuffer();
      globalThis.__kinect.drive.pin(buffer);
    });
    const at = await p.evaluate(`(() => {
      const times = globalThis.__kinect.drive.times();
      return times.slice(0, ${SOURCE_FRAMES});
    })()`);
    const meta = await p.evaluate(`(() => {
      const k = globalThis.__kinect;
      const gl = k.renderer.getContext();
      const box = k.renderer.domElement.getBoundingClientRect();
      return {
        window: [innerWidth, innerHeight],
        canvas: [gl.drawingBufferWidth, gl.drawingBufferHeight],
        css: [box.x, box.y, box.width, box.height],
        composer: [k.composer.renderTarget1.width, k.composer.renderTarget1.height],
        afterimage: [k.afterimage._textureComp.width, k.afterimage._textureComp.height],
        cameraAspect: k.freeCamera.aspect,
        bufferHeight: k.uniforms.bufferHeight.value,
      };
    })()`);
    const out = {};
    for (const [reading, mode] of Object.entries(cases)) {
      out[reading] = await p.evaluate(`(async () => {
        ${PAGE_HELPERS}
        k.params.reset();
        ${select}
        ${extra}
        k.drive.reset();
        pinCamera(k.freeCamera);
        // The frames themselves rather than digests of them, because the comparison
        // downstream is a measurement and a hash answers only "same or not". Base64 so
        // the bridge carries a string: five readings by six frames of 640x360 RGBA is
        // about 37MB per arm, which node holds without complaint and which buys the row
        // the ability to say *how* two builds differ rather than only that they do.
        // Chunked into the encoder because a single spread of a million-element typed
        // array overflows the argument list.
        const frames = [];
        for (const t of ${JSON.stringify(at)}) {
          k.drive.stepTo(t);
          const px = k.drive.readPixels();
          let bin = '';
          for (let i = 0; i < px.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, px.subarray(i, i + 0x8000));
          }
          frames.push(btoa(bin));
        }
        return frames;
      })()`.replace(/\$MODE/g, String(mode)).replace(/\$READING/g, JSON.stringify(reading)));
    }
    await p.close();
    return { out, errors, meta };
  };

  const oldArm = await hashesFor(
    { source: againstSource, viewportSize: COMPARISON_VIEW, comparisonShell: true },
    'k.uniforms.mode.value = $MODE;',
  );
  const newArm = await hashesFor(
    { viewportSize: COMPARISON_VIEW, comparisonShell: true },
    'k.readings().forEach((n) => k.params.set(n, 0)); k.params.set($READING, 1);',
  );
  console.log(`  comparison geometry old ${JSON.stringify(oldArm.meta)} new ${JSON.stringify(newArm.meta)}`);

  // The two arms are independently compiled shaders, so asking them for identical bytes asks
  // two compilations to agree. Measured noise at this frame size is 1 byte at delta 1, and the
  // smallest true positive this row has to catch moves about 17% of the frame at deltas of 47
  // to 52. Two conditions rather than one, because a defect can be loud in either dimension.
  const TOLERATED_BYTES = 64;
  const framePixels = (s) => Buffer.from(s, 'base64');
  const frameDelta = (x, y) => {
    const A = framePixels(x);
    const B = framePixels(y);
    if (A.length !== B.length) return { bytes: Infinity, max: Infinity, sized: [A.length, B.length] };
    let bytes = 0;
    let max = 0;
    for (let i = 0; i < A.length; i++) {
      const d = Math.abs(A[i] - B[i]);
      if (d) { bytes++; if (d > max) max = d; }
    }
    return { bytes, max, of: A.length };
  };

  for (const [reading, mode] of Object.entries(READING_WAS)) {
    const a = oldArm.out[reading];
    const b = newArm.out[reading];
    const deltas = a.map((frame, i) => frameDelta(frame, b[i]));
    const moved = deltas
      .map((d, i) => ({ ...d, frame: i }))
      .filter((d) => d.bytes > TOLERATED_BYTES || d.max > 1);
    const touched = deltas.filter((d) => d.bytes > 0).length;
    check(moved.length === 0,
      `${reading.padEnd(13)} at 1.0 renders the same picture as mode ${mode} at ${AGAINST_REV}`,
      moved.length === 0
        ? `${a.length} frames${touched ? `, ${touched} within tolerance `
          + `(worst ${Math.max(...deltas.map((d) => d.bytes))} bytes of ${deltas[0].of}, `
          + `delta ${Math.max(...deltas.map((d) => d.max))})` : ''}`
        : `${moved.length} of ${a.length} frames differ beyond ${TOLERATED_BYTES} bytes or 1 step: `
          + moved.map((d) => `f${d.frame} ${d.bytes} bytes of ${d.of} max ${d.max}`).join(', '));
  }

  // The grade term whose default is not zero, at the value `presets-builtin/blackwall.json`
  // uses: the five rows above render at defaults, where the whole raster block sits behind
  // `if (scanlines > 0.0)`. Blackwall rather than colour, so no reading's mutation can switch
  // this probe off, and the two arms are handed different values on purpose - the pinned build
  // bakes its corner falloff into the pass where this one reads `vignette.amount`.
  const RASTER_OLD_LOOK = "k.params.set('scanlines', 0.35);";
  const RASTER_NEW_LOOK = "k.params.set('raster.amount', 0.35); k.params.set('vignette.amount', 0.55);";
  {
    const rasterOld = await hashesFor(
      { source: againstSource, viewportSize: COMPARISON_VIEW, comparisonShell: true },
      'k.uniforms.mode.value = $MODE;',
      { 'blackwall.amount': 4 },
      RASTER_OLD_LOOK,
    );
    const rasterNew = await hashesFor(
      { viewportSize: COMPARISON_VIEW, comparisonShell: true },
      'k.readings().forEach((n) => k.params.set(n, 0)); k.params.set($READING, 1);',
      { 'blackwall.amount': 4 },
      RASTER_NEW_LOOK,
    );
    const a = rasterOld.out['blackwall.amount'];
    const b = rasterNew.out['blackwall.amount'];
    const first = a.findIndex((h, i) => h !== b[i]);
    check(eq(a, b),
      `and the raster at the shipped look's 0.35 is bit-identical to the one line it replaced, at ${AGAINST_REV}`,
      first < 0
        ? `${a.length} frames, angle 0 pitch 1.3 hardness 0`
        : `${a.filter((h, i) => h !== b[i]).length} of ${a.length} frames differ, first at `
          + `${first}: ${a[first].slice(0, 12)} vs ${b[first].slice(0, 12)}`);
    const flat = rasterNew.out['blackwall.amount'];
    const lit = (await hashesFor(
      { viewportSize: COMPARISON_VIEW, comparisonShell: true },
      'k.readings().forEach((n) => k.params.set(n, 0)); k.params.set($READING, 1);',
      { 'blackwall.amount': 4 },
      "k.params.set('raster.amount', 0.0); k.params.set('vignette.amount', 0.55);",
    )).out['blackwall.amount'];
    check(!eq(flat, lit),
      'and the raster is actually drawing at that value, so the equality above is about something',
      `${flat.filter((h, i) => h !== lit[i]).length} of ${flat.length} frames differ with the master off`);
  }

  for (const [armName, arm] of [['old', oldArm], ['new', newArm]]) {
    const distinct = new Set(Object.values(arm.out).map((hs) => hs.join('|'))).size;
    check(distinct === Object.keys(READING_WAS).length,
      `and the ${armName} arm's five readings are five different images`,
      `${distinct} distinct of ${Object.keys(READING_WAS).length}`);
  }

  if (oldArm.errors.length || newArm.errors.length) {
    console.log(`  page errors: ${[...oldArm.errors, ...newArm.errors].join(' | ')}`);
    failures++;
  }
}

const main = await openPage({ pin: true });
const { page } = main;
RENDER_BUFFER = await page.evaluate(`(() => {
  const gl = globalThis.__kinect.renderer.getContext();
  return { width: gl.drawingBufferWidth, height: gl.drawingBufferHeight };
})()`);

const declared = await page.evaluate(`(() => {
  const k = globalThis.__kinect;
  return Object.fromEntries(k.params.names().map((n) => [n, k.params.spec(n)]));
})()`);

{
  const missing = Object.keys(declared).filter((n) => !(n in SCRAMBLE));
  if (missing.length) {
    console.log(`[registry] DID NOT RUN - the registry declares ${missing.join(', ')} and SCRAMBLE has no `
      + 'value for them, so the scrambled set is not the whole registry. Add one on its own step grid, '
      + 'in the order PARAMS declares it - the serialised comparison below is a JSON.stringify equality '
      + 'and is sensitive to key order.');
    process.exit(2);
  }
}

console.log('\n[registry] the declaration');
{
  const names = Object.keys(declared);
  check(eq(names.sort(), Object.keys(LANDING).sort()),
    `every declared parameter has a landing site here (${names.length})`,
    show(names.filter((n) => !(n in LANDING))));

  // Every kind this build interpolates, and an unknown one is a failure by existing: a kind the
  // evaluators have no branch for would be read down the scalar path and stored as NaN.
  const kinds = { scalar: [], step: [], pose: [], placement: [] };
  const tags = { look: [], composition: [], view: [] };
  let bad = [];
  for (const [name, spec] of Object.entries(declared)) {
    if (!kinds[spec.kind]) bad.push(`${name} kind=${spec.kind}`);
    else kinds[spec.kind].push(name);
    if (!tags[spec.tag]) bad.push(`${name} tag=${spec.tag}`);
    else tags[spec.tag].push(name);
    // Lerping a boolean is meaningless, so a boolean declared scalar is a keyframe bug.
    if (typeof spec.default === 'boolean' && spec.kind !== 'step') bad.push(`${name} is boolean but kind=${spec.kind}`);
    // Keyed off the type of the default rather than off the kind: `normalise` sends every
    // non-boolean, non-pose value down the scalar branch, so a numeric step-kind parameter
    // declared without a range would clamp against undefined and store NaN.
    if (typeof spec.default === 'number' && !(spec.min < spec.max && spec.step > 0)) {
      bad.push(`${name} is numeric but has no usable range`);
    }
  }
  check(bad.length === 0, 'every parameter carries a usable kind, tag and range', bad.join('; '));
  check(Object.values(kinds).every((names) => names.length > 0),
    'all four interpolation kinds are in use',
    `scalar ${kinds.scalar.length}, step ${kinds.step.length} (${kinds.step.join(',')}), `
      + `pose ${kinds.pose.join(',')}, placement ${kinds.placement.join(',')}`);
  // A placement is a pose without a lens, and the pair of them is what the panel draws no row
  // for. Read off the registry rather than named here, so a third one added later is asked.
  const world = [...kinds.pose, ...kinds.placement];
  check(world.every((n) => declared[n].tag === 'composition'),
    'and every position-and-rotation value is composition rather than look, so no preset carries one',
    world.map((n) => `${n} ${declared[n].tag}`).join(', '));
  // The scope is what says which block of the document a value comes back out of, and a
  // placement without one would be stored nowhere and reload at the origin.
  check(kinds.placement.every((n) => declared[n].scope === 'clip'),
    'and a placement is scoped to the clip it places',
    kinds.placement.map((n) => `${n} scope=${declared[n].scope ?? 'none'}`).join(', '));
  console.log(`        look ${tags.look.length}: ${tags.look.join(' ')}`);
  console.log(`        composition ${tags.composition.length}: ${tags.composition.join(' ')}`);
  console.log(`        view ${tags.view.length}: ${tags.view.join(' ')}`);

  check(!('mode' in declared), 'there is no mode parameter left to keyframe against');
  const readings = await page.evaluate('globalThis.__kinect.readings()');
  const missing = readings.filter((n) => !(n in declared));
  check(readings.length > 0 && missing.length === 0,
    'every reading is a registry parameter',
    missing.length ? `not declared: ${missing.join(', ')}` : readings.join(' '));
  const wrongSpec = readings.filter((n) => declared[n].kind !== 'scalar' || declared[n].tag !== 'look');
  check(wrongSpec.length === 0,
    'and each one is a look-tagged scalar, so it presets and it dissolves',
    wrongSpec.length ? wrongSpec.map((n) => `${n} kind=${declared[n].kind} tag=${declared[n].tag}`).join('; ')
      : `${readings.length} readings`);
}

console.log('\n[registry] bad values are refused rather than coerced');
{
  // Each case is JS source evaluated in the page rather than a value serialised into it:
  // JSON.stringify turns NaN and undefined into null, so a table of literals would test null
  // three times over while its labels claimed otherwise.
  const REJECT = [
    ['camera', '{ position: [1, 2], quaternion: [0, 0, 0, 1], fov: 50 }', 'a short position'],
    ['camera', '{ position: [1, 2, 3], quaternion: [0, 0, 0], fov: 50 }', 'a short quaternion'],
    ['camera', '{ position: [1, 2, 3], quaternion: [0, 0, 0, 1] }', 'no fov at all'],
    ['camera', "{ position: ['1', '2', '3'], quaternion: [0, 0, 0, 1], fov: 50 }", 'strings for a position'],
    ['camera', '{ position: [1, 2, NaN], quaternion: [0, 0, 0, 1], fov: 50 }', 'a NaN component'],
    ['camera', '{ position: [1, 2, 3], quaternion: [0, 0, 0, 1], fov: NaN }', 'a NaN fov'],
    ['camera', 'null', 'null for a pose'],
    ['bloom', 'null', 'null for a scalar'],
    ['bloom', "''", 'an empty string for a scalar'],
    ['bloom', "'1.5'", 'a numeric string for a scalar'],
    ['bloom', 'NaN', 'NaN for a scalar'],
    ['bloom', 'undefined', 'a missing value for a scalar'],
    ['additive', 'null', 'null for a step'],
    ['additive', "'false'", 'the string "false" for a step'],
    ['additive', '1', 'a number for a step'],
    ['additive', 'undefined', 'a missing value for a step'],
  ];
  const ACCEPT = [
    ['camera', JSON.stringify(SCRAMBLE.camera)],
    ['bloom', '0.75'],
    ['additive', 'true'],
  ];
  const asCases = (rows) => rows
    .map(([name, expr]) => `{ name: ${JSON.stringify(name)}, value: ${expr} }`)
    .join(', ');

  const outcome = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const out = { rejected: [], leaked: [], accepted: [], camera: null };
    for (const { name, value } of [${asCases(REJECT)}]) {
      const before = JSON.stringify(k.params.get(name));
      let threw = false;
      try { k.params.set(name, value); } catch { threw = true; }
      out.rejected.push(threw);
      // A refusal that had already written half of itself would be worse than the
      // coercion it replaced, so the stored value has to be untouched.
      if (JSON.stringify(k.params.get(name)) !== before) out.leaked.push(name);
    }
    for (const { name, value } of [${asCases(ACCEPT)}]) {
      let ok = false;
      try { k.params.set(name, value); ok = true; } catch (e) { ok = String(e); }
      out.accepted.push(ok);
    }
    out.camera = [...k.programCamera.position.toArray(), k.programCamera.fov, k.programCamera.projectionMatrix.elements[0]];
    k.params.reset();
    return out;
  })()`);

  const missed = REJECT.filter((_, i) => !outcome.rejected[i]).map(([n, , why]) => `${n}: ${why}`);
  check(missed.length === 0, `all ${REJECT.length} malformed values throw`, missed.join('; '));
  check(outcome.leaked.length === 0, 'and a refusal writes nothing at all', outcome.leaked.join(' '));
  check(outcome.accepted.every((x) => x === true), 'while well-formed values still go through',
    outcome.accepted.filter((x) => x !== true).join('; '));
  // NaN reaching the pose never throws, it poisons the projection matrix, and live viewing
  // hides it because the next frame rewrites the pose from program time.
  check(outcome.camera.every(Number.isFinite), 'and nothing left NaN on the camera', show(outcome.camera));
}

console.log('\n[registry] a serialised project is document state, never view state');
{
  const sets = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    return {
      byDefault: Object.keys(k.params.values()),
      everything: Object.keys(k.params.values(k.params.names())),
      look: k.params.names('look'),
      view: k.params.names('view'),
      composition: k.params.names('composition'),
    };
  })()`);
  const leaked = sets.view.filter((n) => sets.byDefault.includes(n));
  check(leaked.length === 0,
    'values() leaves view state out, so an undo snapshot cannot swallow it', leaked.join(' '));
  check(sets.composition.every((n) => sets.byDefault.includes(n))
    && sets.look.every((n) => sets.byDefault.includes(n)),
    `and carries all ${sets.look.length} look and ${sets.composition.length} composition parameters`);
  check(sets.everything.length === sets.byDefault.length + sets.view.length,
    'while view state is still reachable by naming it', `${sets.everything.length} named explicitly`);
}

console.log('\n[registry] the panel carries no parameter data of its own');
{
  // The panel's rows are generated from the registry, so no registry-owned input appears in
  // the markup at all. The floor under the scan is there for `syntax-check`'s reason: a regex
  // that stopped matching `<input` would report a clean panel about nothing.
  const html = readFileSync(join(REPO, 'web/index.html'), 'utf8');
  const owned = new Set(Object.keys(declared));
  const tags = html.match(/<input[^>]*>/g) ?? [];
  const ids = tags.map((tag) => tag.match(/id="([^"]+)"/)?.[1]).filter(Boolean);
  const MARKUP_INPUT_FLOOR = 4;
  check(tags.length >= MARKUP_INPUT_FLOOR && ids.length === tags.length,
    `the markup scan found the inputs it is supposed to read (${tags.length} of at least ${MARKUP_INPUT_FLOOR}, all with ids)`,
    `${ids.join(' ')}`);
  const inMarkup = ids.filter((id) => owned.has(id));
  check(inMarkup.length === 0,
    `no registry-owned input is written in the markup at all - every one of the ${owned.size} `
    + 'is generated from the registry, so there is no second copy of a range to drift',
    inMarkup.join(' '));

  const stamped = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const out = {};
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) { out[name] = null; continue; }
      out[name] = el.type === 'checkbox'
        ? { checked: el.checked }
        : { min: el.min, max: el.max, step: el.step, value: el.value,
            out: el.parentElement.querySelector('output')?.textContent };
    }
    return out;
  })()`);
  const wrong = [];
  for (const [name, spec] of Object.entries(declared)) {
    const el = stamped[name];
    if (spec.tag === 'composition') {
      if (el !== null) wrong.push(`${name} is composition but has a control`);
      continue;
    }
    if (el === null) { wrong.push(`${name} has no control`); continue; }
    if ('checked' in el) {
      if (el.checked !== spec.default) wrong.push(`${name} checked=${el.checked} want ${spec.default}`);
      continue;
    }
    if (el.min !== String(spec.min) || el.max !== String(spec.max) || el.step !== String(spec.step)) {
      wrong.push(`${name} range ${el.min}..${el.max}/${el.step} want ${spec.min}..${spec.max}/${spec.step}`);
    }
    if (el.value !== String(spec.default)) wrong.push(`${name} value=${el.value} want ${spec.default}`);
    if (el.out !== String(spec.default)) wrong.push(`${name} readout=${el.out} want ${spec.default}`);
  }
  check(wrong.length === 0, 'every control has its range, default and readout stamped from the registry', wrong.join('; '));
}

console.log('\n[registry] every parameter round-trips to where the renderer reads it');
{
  const probe = async (values) => page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    k.params.apply(${JSON.stringify(values)});
    k.renderer.render(k.scene, k.freeCamera);
    return { values: k.params.values(k.params.names()), landing: ${landingReader} };
  })()`);

  const wrong = [];
  for (const [name, value] of Object.entries(SCRAMBLE)) {
    const { values, landing } = await probe({ [name]: value });
    if (!eq(values[name], value)) {
      wrong.push(`${name} stored ${show(values[name])} not ${show(value)}`);
      continue;
    }
    const want = EXPECT[name](values[name], values);
    if (!eq(landing[name], want)) wrong.push(`${name} landed ${show(landing[name])} want ${show(want)}`);
  }
  check(wrong.length === 0, `all ${Object.keys(SCRAMBLE).length} parameters land one at a time`, wrong.join('; '));

  const { values, landing } = await probe(SCRAMBLE);
  const together = Object.keys(SCRAMBLE)
    .filter((n) => !eq(landing[n], EXPECT[n](values[n], values)))
    .map((n) => `${n}=${show(landing[n])}`);
  check(together.length === 0, 'and all of them at once', together.join('; '));
}

console.log('\n[registry] the side effects that are not a uniform write');
{
  const setAndRead = async (values) => page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    k.params.apply(${JSON.stringify(values)});
    k.renderer.render(k.scene, k.freeCamera);
    return {
      drawRange: k.geometry.drawRange.count,
      bloom: k.bloom.enabled, trails: k.afterimage.enabled, grade: k.grade.enabled,
      blending: k.material.blending, depthWrite: k.material.depthWrite, softEdge: k.uniforms.softEdge.value,
      buffer: [k.renderer.getContext().drawingBufferWidth, k.renderer.getContext().drawingBufferHeight],
    };
  })()`);

  const range = [];
  for (const [fade, wake, want] of [[0, 0, POINTS], [10, 0, POINTS * 2], [0, 10, POINTS * 2], [120, 550, POINTS * 2]]) {
    const r = await setAndRead({ fade, wake });
    if (r.drawRange !== want) range.push(`fade=${fade} wake=${wake} -> ${r.drawRange} want ${want}`);
  }
  check(range.length === 0, 'fade and wake move the draw range together', range.join('; '));

  const gates = [];
  for (const [values, want] of [
    [{ bloom: 0, trails: 0, 'rgbsplit.amount': 0, 'raster.amount': 0, 'grain.amount': 0, 'vignette.amount': 0 },
      { bloom: false, trails: false, grade: false }],
    [{ bloom: 0.05 }, { bloom: true, trails: false, grade: false }],
    [{ trails: 0.01 }, { bloom: false, trails: true, grade: false }],
    [{ 'rgbsplit.amount': 0.05 }, { bloom: false, trails: false, grade: true }],
    [{ 'raster.amount': 0.01 }, { bloom: false, trails: false, grade: true }],
    [{ 'grain.amount': 0.01 }, { bloom: false, trails: false, grade: true }],
    [{ 'vignette.amount': 0.01 }, { bloom: false, trails: false, grade: true }],
    [{ 'streak.amount': 0.02 }, { bloom: false, trails: false, grade: true }],
    [{ crush: 0.5 }, { bloom: false, trails: false, grade: false }],
    [{ 'raster.angle': 90 }, { bloom: false, trails: false, grade: false }],
    [{ 'raster.pitch': 0.3 }, { bloom: false, trails: false, grade: false }],
    [{ 'raster.hard': 1 }, { bloom: false, trails: false, grade: false }],
    [{ 'streak.angle': 90 }, { bloom: false, trails: false, grade: false }],
    [{ 'halation.amount': 0.02 }, { bloom: false, trails: false, grade: true }],
    [{ 'stock.amount': 0.02 }, { bloom: false, trails: false, grade: true }],
    [{ 'halation.radius': 60 }, { bloom: false, trails: false, grade: false }],
    [{ 'halation.threshold': 0.9 }, { bloom: false, trails: false, grade: false }],
    [{ 'halation.tint': 1 }, { bloom: false, trails: false, grade: false }],
    [{ 'stock.balance': -1 }, { bloom: false, trails: false, grade: false }],
    [{ 'stock.split': 0.9 }, { bloom: false, trails: false, grade: false }],
    [{ 'stock.latitude': 1 }, { bloom: false, trails: false, grade: false }],
  ]) {
    const r = await setAndRead(values);
    const got = { bloom: r.bloom, trails: r.trails, grade: r.grade };
    if (!eq(got, want)) gates.push(`${show(values)} -> ${show(got)} want ${show(want)}`);
  }
  check(gates.length === 0, 'a zero value switches its pass off rather than running it as a no-op', gates.join('; '));

  const blend = [];
  for (const on of [true, false]) {
    const r = await setAndRead({ additive: on });
    const want = { blending: on ? ADDITIVE_BLENDING : NORMAL_BLENDING, depthWrite: !on, softEdge: on ? 1 : 0 };
    const got = { blending: r.blending, depthWrite: r.depthWrite, softEdge: r.softEdge };
    if (!eq(got, want)) blend.push(`additive=${on} -> ${show(got)} want ${show(want)}`);
  }
  check(blend.length === 0, 'additive drives blending, depth write and the sprite falloff together', blend.join('; '));

  const scales = [];
  for (const v of [40, 100, 200]) {
    const r = await setAndRead({ renderScale: v });
    const want = [
      Math.floor(RENDER_BUFFER.width * v / 100),
      Math.floor(RENDER_BUFFER.height * v / 100),
    ];
    if (!eq(r.buffer, want)) scales.push(`renderScale=${v} -> ${show(r.buffer)} want ${show(want)}`);
  }
  check(scales.length === 0, 'render scale resizes the drawing buffer', scales.join('; '));

  await page.evaluate('globalThis.__kinect.params.reset()');
}

console.log('\n[registry] the panel is a view, in both directions');
{
  const fromControl = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const wrong = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) continue;
      const spec = k.params.spec(name);
      if (el.type === 'checkbox') {
        el.checked = !spec.default;
        el.dispatchEvent(new Event('change'));
        if (k.params.get(name) !== !spec.default) wrong.push(name + ' -> ' + k.params.get(name));
        continue;
      }
      const target = ${JSON.stringify(SCRAMBLE)}[name];
      el.value = String(target);
      el.dispatchEvent(new Event('input'));
      if (k.params.get(name) !== target) wrong.push(name + ' -> ' + k.params.get(name));
    }
    return wrong;
  })()`);
  check(fromControl.length === 0, 'moving a control writes the registry', fromControl.join('; '));

  const fromRegistry = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const wrong = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el) continue;
      const value = ${JSON.stringify(SCRAMBLE)}[name];
      k.params.set(name, value);
      if (el.type === 'checkbox') {
        if (el.checked !== value) wrong.push(name + ' checkbox=' + el.checked);
        continue;
      }
      if (el.value !== String(value)) wrong.push(name + ' slider=' + el.value + ' want ' + value);
      const out = el.parentElement.querySelector('output');
      if (out && out.textContent !== String(value)) wrong.push(name + ' readout=' + out.textContent);
    }
    return wrong;
  })()`);
  check(fromRegistry.length === 0, 'writing the registry moves the control and its readout', fromRegistry.join('; '));

  const clamped = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const wrong = [];
    for (const name of k.params.names()) {
      const el = document.getElementById(name);
      if (!el || el.type === 'checkbox') continue;
      const spec = k.params.spec(name);
      // Below, above, a value that rounds down, and a tie that has to round up -
      // the tie is the one where the registry's arithmetic and the browser's
      // step alignment could part company without either looking wrong.
      for (const raw of [spec.min - 1000, spec.max + 1000, spec.min + spec.step * 0.4, spec.min + spec.step * 6.5]) {
        const stored = k.params.set(name, raw);
        if (stored < spec.min || stored > spec.max) wrong.push(name + ' ' + raw + ' -> ' + stored);
        else if (el.value !== String(stored)) wrong.push(name + ' ' + raw + ' -> registry ' + stored + ', slider ' + el.value);
      }
    }
    return wrong;
  })()`);
  check(clamped.length === 0, 'out-of-range and off-grid values clamp and snap the same way the slider does', clamped.join('; '));

  await page.evaluate('globalThis.__kinect.params.reset()');
}

console.log('\n[registry] a preset can only be applied by a user action');
{
  const A_LOOK = { bloom: 0.5, trails: 0.5 };

  const guard = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();

    // Outside evaluation it has to work, or the check below would pass on a
    // preset path that was simply broken.
    let outside = 'applied';
    try { k.applyPreset(${JSON.stringify(A_LOOK)}); } catch (e) { outside = String(e); }
    const applied = k.params.get('bloom');
    k.params.reset();

    // Inside one, it has to refuse. The probe rides three's own pre-render hook,
    // which fires from inside renderProgramFrame, so this is the timeline calling
    // rather than the check pretending to be it.
    const seen = {};
    k.scene.onBeforeRender = () => {
      k.scene.onBeforeRender = () => {};
      try { k.applyPreset(${JSON.stringify(A_LOOK)}); seen.preset = 'applied'; }
      catch (e) { seen.preset = 'refused'; }
      // An ordinary parameter write must stay legal: that is exactly what step 5's
      // tracks do every frame, and what the camera already does.
      try { k.params.set('bloom', 0.25); seen.param = 'written'; }
      catch (e) { seen.param = String(e); }
      // And a reading is one of those writes now. This row used to be its opposite -
      // "selecting a mode during evaluation is refused" - and the inversion is the
      // capability rather than a relaxed guard: a mode was refused *because* selecting
      // one applied a twelve-value preset behind it, so it could never be a track. A
      // reading writes one number, which is what a track does every frame, so refusing
      // it here would be refusing the dissolve this change exists to allow.
      try { k.params.set('blackwall.amount', 1); seen.reading = 'written'; }
      catch (e) { seen.reading = String(e); }
    };
    k.drive.stepTo(0);
    k.scene.onBeforeRender = () => {};

    return { outside, applied, seen, bloomAfter: k.params.get('bloom'), readingAfter: k.params.get('blackwall.amount') };
  })()`);

  check(guard.outside === 'applied' && guard.applied === 0.5,
    'applying a preset outside evaluation writes it', `bloom=${guard.applied}`);
  check(guard.seen.preset === 'refused', 'applying a preset during evaluation is refused', show(guard.seen.preset));
  check(guard.seen.param === 'written' && guard.bloomAfter === 0.25,
    'an ordinary parameter write during evaluation still works', `bloom=${guard.bloomAfter}`);
  check(guard.seen.reading === 'written' && guard.readingAfter === 1,
    'and a reading is an ordinary write, so a track can dissolve one under the playhead',
    `blackwall.amount=${guard.readingAfter}`);

  const selection = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.reset();
    const chosen = k.params.names('look');
    k.params.set('camera', ${JSON.stringify(SCRAMBLE.camera)});
    k.params.set('renderScale', 60);
    const captured = k.params.values(chosen);

    // Move everything, then apply the captured look back. A preset that moved the
    // camera would not be a preset, it would be a saved project.
    k.params.apply(${JSON.stringify(SCRAMBLE)});
    k.applyPreset(captured);
    return {
      chosen,
      captured: Object.keys(captured),
      camera: k.params.get('camera'),
      renderScale: k.params.get('renderScale'),
      bloom: k.params.get('bloom'),
      near: k.params.get('near'),
    };
  })()`);

  check(!selection.captured.includes('camera') && !selection.captured.includes('spin')
    && !selection.captured.includes('renderScale'),
    'the default preset selection is the look tag, so composition and view stay out',
    `${selection.captured.length} parameters`);
  check(selection.captured.includes('near') && selection.captured.includes('far'),
    'and the depth clip is in it, as a look control whose default selection can be unpicked');
  check(eq(selection.camera, SCRAMBLE.camera),
    'applying a look leaves the camera exactly where it was', show(selection.camera.position));
  check(selection.renderScale === 85, 'and leaves view state to the viewer', `renderScale=${selection.renderScale}`);
  check(selection.bloom === 0 && selection.near === 0.05,
    'while the look values it does carry are written', `bloom=${selection.bloom} near=${selection.near}`);

  await page.evaluate('globalThis.__kinect.params.reset()');
}

console.log('\n[registry] the camera pose goes in through the registry, not around it');
{
  const camera = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const wild = ${JSON.stringify(SCRAMBLE.camera)};
    k.params.set('camera', wild);
    const written = [k.params.get('camera'), k.programCamera.position.toArray()];

    const q = [0, 0, 0, 1];
    k.keyframes.setTracks({ camera: [
      { t: 0, value: { position: [-1, 0.2, 1], quaternion: q, fov: 50 } },
      { t: 2, value: { position: [1, 0.2, 1], quaternion: q, fov: 50 } },
    ] });

    k.drive.reset();
    k.drive.stepTo(0.4);
    const stored = k.params.get('camera');
    const onCamera = {
      position: k.programCamera.position.toArray(),
      quaternion: k.programCamera.quaternion.toArray(),
      fov: k.programCamera.fov,
    };
    k.drive.stepTo(0.9);
    const later = k.params.get('camera');
    k.keyframes.setTracks({});
    return { written, stored, onCamera, later };
  })()`);

  check(eq(camera.written[0], SCRAMBLE.camera) && eq(camera.written[1], SCRAMBLE.camera.position),
    'a pose written through the registry reaches the camera object');
  check(eq(camera.stored, camera.onCamera),
    'after a render the registry holds the pose the camera is actually at',
    `${show(camera.stored.position)} vs ${show(camera.onCamera.position)}`);
  check(!eq(camera.stored.position, SCRAMBLE.camera.position),
    'and it is the pose the track asked for, not the one the check wrote');
  check(!eq(camera.stored.position, camera.later.position),
    'and it moves with program time', `${show(camera.stored.position)} -> ${show(camera.later.position)}`);
}

console.log('\n[registry] serialise, restore, and the image comes back byte for byte');

await page.evaluate(async () => {
  const buffer = await (await fetch('/__pinned.bin')).arrayBuffer();
  globalThis.__kinect.drive.pin(buffer);
});

// And a colour image, because one parameter is only observable through one. `pin` above
// switches colour off, so it is planted rather than waited for.
await page.evaluate(`globalThis.__kinect.drive.plantColor(${JSON.stringify([
  220, 30, 40, 255, 30, 200, 90, 255,
  40, 70, 230, 255, 230, 200, 40, 255,
])}, 2, 2)`);
{
  const planted = await page.evaluate('globalThis.__kinect.uniforms.hasColor.value');
  check(planted === 1,
    'the sweep runs against a colour image, so a colour term is not measured on grey',
    `hasColor ${planted}`);
}

const positions = await page.evaluate(`(() => {
  const times = globalThis.__kinect.drive.times();
  const out = [];
  for (let i = 0; i < times.length - 1; i++) {
    for (let r = 0; r < ${SUBSTEPS}; r++) out.push(times[i] + (times[i + 1] - times[i]) * (r / ${SUBSTEPS}));
  }
  return out;
})()`);

const runWith = `async ({ values, positions }) => {
  ${PAGE_HELPERS}
  k.params.reset();
  k.params.apply(values);
  k.drive.reset();
  pinCamera(k.freeCamera);
  const out = [];
  for (const t of positions) {
    k.drive.stepTo(t);
    out.push(await sha256(k.drive.readPixels()));
  }
  return out;
}`;
const run = (values) => page.evaluate(`(${runWith})(${JSON.stringify({ values, positions })})`);

const serialised = await page.evaluate(`(() => {
  const k = globalThis.__kinect;
  k.params.reset();
  k.params.apply(${JSON.stringify(SCRAMBLE)});
  return JSON.parse(JSON.stringify(k.params.values(k.params.names())));
})()`);

const defaults = await page.evaluate(
  "(() => { const k = globalThis.__kinect; k.params.reset(); return JSON.parse(JSON.stringify(k.params.values(k.params.names()))); })()");

const scrambledRun = await run(SCRAMBLE);
const defaultRun = await run(defaults);
const restoredRun = await run(serialised);

console.log(`  ${positions.length} images per run over `
  + `${positions[0].toFixed(3)}s to ${positions[positions.length - 1].toFixed(3)}s, `
  + `${new Set(scrambledRun).size} of them distinct`);

check(eq(scrambledRun, restoredRun),
  'the restored set reproduces the run exactly',
  eq(scrambledRun, restoredRun) ? '' : `first divergence at image ${scrambledRun.findIndex((h, i) => h !== restoredRun[i])}`);
check(eq(serialised, JSON.parse(JSON.stringify(SCRAMBLE))),
  `the serialised set is the scrambled set, value for value (${Object.keys(serialised).length} parameters)`,
  Object.keys(SCRAMBLE).filter((n) => !eq(serialised[n], SCRAMBLE[n]))
    .map((n) => `${n}: ${show(serialised[n])} not ${show(SCRAMBLE[n])}`).join('; '));
check(!eq(scrambledRun, defaultRun), 'and the defaults do not - the registry is what the image depends on');
check(new Set(scrambledRun).size > positions.length / 2, 'the input moves across the run');

console.log('\n[registry] the readings mix as a ratio, so their scale cancels');
{
  const RATIO = {
    readRgb: 0.4,
    readDepth: 0.3,
    'ghost.amount': 0.2,
    'contour.amount': 0,
    'blackwall.amount': 0,
  };
  const scaled = (k) => Object.fromEntries(Object.entries(RATIO).map(([n, v]) => [n, v * k]));

  const atOne = await run(scaled(1));
  const atTwo = await run(scaled(2));
  check(eq(atOne, atTwo),
    'doubling every weight renders the identical image, because a ratio has no scale',
    eq(atOne, atTwo) ? `${atOne.length} frames` : `first divergence at image ${atOne.findIndex((h, i) => h !== atTwo[i])}`);

  const solo = {};
  for (const name of Object.keys(RATIO)) {
    solo[name] = await run({ ...Object.fromEntries(Object.keys(RATIO).map((n) => [n, 0])), [name]: 1 });
  }
  const sameAsSolo = Object.keys(RATIO).filter((n) => eq(atOne, solo[n]));
  check(sameAsSolo.length === 0,
    'and the mix is none of the readings it is made of',
    sameAsSolo.length ? `identical to ${sameAsSolo.join(', ')} alone` : 'distinct from all five');
}

console.log('\n[registry] the falsification control: each parameter left out of the restore in turn');
{
  const noEffect = [];
  const changed = [];
  for (const name of Object.keys(serialised)) {
    const partial = { ...serialised };
    delete partial[name];
    const hashes = await run(partial);
    if (eq(hashes, scrambledRun)) noEffect.push(name);
    else changed.push(name);
  }
  console.log(`  omitting any of these changed the image: ${changed.join(' ')}`);
  const unexplained = noEffect.filter((n) => !(n in NO_PIXEL_EFFECT));
  for (const name of noEffect.filter((n) => n in NO_PIXEL_EFFECT)) {
    console.log(`  ${name} left the image unchanged, as declared: ${NO_PIXEL_EFFECT[name]}`);
  }
  check(unexplained.length === 0,
    `every parameter outside the declared exceptions changes the image when it is dropped`,
    unexplained.length ? `unexplained: ${unexplained.join(' ')}` : '');
  check(changed.length > 0 && noEffect.length === Object.keys(NO_PIXEL_EFFECT).length,
    `${changed.length} of ${Object.keys(serialised).length} parameters are proven to reach the pixels`);
}

console.log('\n[registry] the crop switch, which the sweep above cannot see');
{
  const released = await run({ ...SCRAMBLE, crop: false });
  check(!eq(scrambledRun, released),
    'releasing the crop changes the image, against the six faces the scrambled set authors',
    eq(scrambledRun, released) ? 'identical' : `first divergence at image ${scrambledRun.findIndex((h, i) => h !== released[i])}`);

  const depthOnly = {
    ...SCRAMBLE,
    left: defaults.left,
    right: defaults.right,
    bottom: defaults.bottom,
    top: defaults.top,
    near: 1.5,
    far: 2.5,
  };
  const depthBiting = await run(depthOnly);
  const depthReleased = await run({ ...depthOnly, crop: false });
  check(!eq(depthBiting, depthReleased),
    'and it reaches the depth pair, not only the four lateral faces',
    eq(depthBiting, depthReleased) ? 'identical with only near/far authored' : 'the box releases in depth too');

  const bottomOnly = { ...defaults, crop: true, bottom: 0.5 };
  const bottomBiting = await run(bottomOnly);
  const bottomReleased = await run({ ...bottomOnly, crop: false });
  check(!eq(bottomBiting, bottomReleased),
    'and the lower face reaches the image when it crosses this fixture',
    eq(bottomBiting, bottomReleased) ? 'identical with bottom at 0.5m' : 'the lower face cuts the cloud');

  const landing = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.params.set('near', ${SCRAMBLE.near});
    k.params.set('far', ${SCRAMBLE.far});
    k.params.set('crop', false);
    const off = [k.uniforms.nearClip.value, k.uniforms.farClip.value];
    k.params.set('crop', true);
    return { off, on: [k.uniforms.nearClip.value, k.uniforms.farClip.value] };
  })()`);
  check(eq(landing.off, landing.on) && eq(landing.on, [SCRAMBLE.near, SCRAMBLE.far]),
    'and it releases by not testing rather than by moving the planes, so the depth ramp is unchanged',
    `nearClip/farClip released ${JSON.stringify(landing.off)}, applied ${JSON.stringify(landing.on)}`);
}

console.log('\n[registry] the datamosh refresh switch crosses a cycle boundary');
{
  const cycling = await run({ ...SCRAMBLE, 'datamosh.refresh': 0.2, 'datamosh.cycleRefresh': true });
  const continuous = await run({ ...SCRAMBLE, 'datamosh.refresh': 0.2, 'datamosh.cycleRefresh': false });
  check(!eq(cycling, continuous),
    'cycle refresh changes the image after the first refresh boundary',
    eq(cycling, continuous) ? 'identical across a 0.2s boundary' : 'the histories diverge');
}

console.log('\n[registry] the streak goes where the angle points');
{
  const fall = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    const gl = k.renderer.getContext();
    const lum = (px, i) => px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722;
    // The same program position the runs above use, so this is measured on a frame the
    // rest of the section has already shown to carry a picture rather than on one picked
    // here for being convenient.
    const at = ${JSON.stringify(positions[positions.length - 1])};
    const shot = (over) => {
      k.params.reset();
      k.params.apply(${JSON.stringify(SCRAMBLE)});
      k.params.apply(over);
      k.drive.reset();
      pinCamera(k.freeCamera);
      k.drive.stepTo(at);
      return k.drive.readPixels();
    };
    // The size is taken after the first render rather than before it, because the
    // scrambled set carries a render scale: a buffer read before anything applied it
    // describes a drawing buffer this block never looks at, and every index below would be
    // out by the ratio between the two. It used to be read at the top and was right only
    // because a neighbouring section happened to leave the page scrambled.
    const base = shot({ 'streak.amount': 0 });
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    // The luminance-weighted mean position of the light in a that is not in b, so one
    // helper reads the light a term adds and the light a crop face takes away.
    const meanPos = (a, b) => {
      let sr = 0, sc = 0, weight = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = (y * W + x) * 4;
          const v = b ? Math.max(0, lum(a, i) - lum(b, i)) : lum(a, i);
          sr += v * y;
          sc += v * x;
          weight += v;
        }
      }
      return { row: weight > 0 ? sr / weight : -1, col: weight > 0 ? sc / weight : -1, weight };
    };
    // The scrambled crop window runs -1.5 to 1 in y and -1.5 to 1.5 in x, so each face
    // brought to the value below takes roughly half the room off its own side of the
    // picture and leaves the other half standing.
    const cut = (over) => meanPos(base, shot({ 'streak.amount': 0, ...over }));
    const added = {};
    for (const a of [0, 180, 90, -90, 45, -135]) {
      added[a] = meanPos(shot({ 'streak.amount': 0.9, 'streak.angle': a }), base);
    }
    return {
      added,
      upper: cut({ top: -0.2 }),
      lower: cut({ bottom: -0.2 }),
      starboard: cut({ right: 0 }),
      port: cut({ left: 0 }),
      width: W,
      height: H,
    };
  })()`);

  check(fall.added[0].weight > 0,
    'the streak adds light at all, so the rows below are about something',
    `added luminance ${fall.added[0].weight.toFixed(0)} at an angle of 0`);

  const upSpread = fall.upper.row - fall.lower.row;
  check(fall.upper.weight > 0 && fall.lower.weight > 0 && Math.abs(upSpread) > fall.height * 0.05,
    'cropping the room\'s top and its bottom take light from opposite ends, so the rows are calibrated',
    `top cut removes light at row ${fall.upper.row.toFixed(1)}, bottom cut at `
    + `${fall.lower.row.toFixed(1)} of ${fall.height}`);

  const acrossSpread = fall.starboard.col - fall.port.col;
  check(fall.starboard.weight > 0 && fall.port.weight > 0 && Math.abs(acrossSpread) > fall.width * 0.05,
    'and its right and its left do the same across the frame, so the columns are as well',
    `right cut removes light at column ${fall.starboard.col.toFixed(1)}, left cut at `
    + `${fall.port.col.toFixed(1)} of ${fall.width}`);

  const up = Math.sign(upSpread);
  const rightward = Math.sign(acrossSpread);
  for (const [a, b, sentence] of [
    [0, 180, 'the light at 0 lands below the light at 180, so an angle of zero is straight down'],
    [90, -90, 'and the light at 90 lands to the left of the light at -90, so a right angle runs across the frame'],
    [45, -135, 'and the light at 45 lands on the diagonal between them, so this is an angle rather than four choices'],
  ]) {
    const sx = ((fall.added[a].col - fall.added[b].col) / fall.width) * rightward;
    const sy = ((fall.added[a].row - fall.added[b].row) / fall.height) * up;
    const r = a * (Math.PI / 180);
    const ex = -Math.sin(r); const ey = -Math.cos(r);
    const along = sx * ex + sy * ey;
    const across = Math.abs(sx * ey - sy * ex);
    check(along > 0.03 && across < along * 0.4, sentence,
      `${a} against ${b}: ${(100 * along).toFixed(2)}% of the frame along the angle, `
      + `${(100 * across).toFixed(2)}% across it, with screen-up at `
      + `${up > 0 ? 'rising' : 'falling'} rows and screen-right at `
      + `${rightward > 0 ? 'rising' : 'falling'} columns`);
  }
}

console.log('\n[registry] a clip-scope write lands on the clip it was made on and on no other');
{
  // Levelling, because it is the one clip-scope value composed out of two parameters: `tilt` and
  // `roll` each write one member of a pair and then compose both, so a pair the program shares
  // rather than a pair per clip makes one clip's tilt compose with another clip's roll. Every
  // other clip value writes one uniform cell and cannot be caught this way.
  const TILT = 30;
  const ROLL = 45;
  const staged = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const doc = k.library.serialiseProjectBody();
    const one = doc.clips[0];
    // Two clips of the one take this page holds, which is an edit the document can spell. Both
    // levelled at nothing in the document rather than wherever the sections above left them, so
    // the two angles each clip ends up holding are the two written below and nothing else.
    const flat = { ...one.params, tilt: 0, roll: 0 };
    doc.clips = [
      { ...one, id: 'c1', start: 0, params: flat },
      { ...one, id: 'c2', start: 0, params: flat },
    ];
    k.library.restoreProject(doc);
    await k.timeline.settled();
    // The order that separates a pair per clip from a pair per program: one clip is given a
    // roll, and then the other is given only a tilt. A shared pair still holds the roll.
    k.timeline.select('c2');
    k.params.set('roll', ${ROLL});
    k.timeline.select('c1');
    k.params.set('tilt', ${TILT});
    // Off every clip's own group rather than through the selection: the worldTilt handle answers
    // for the selected clip alone, so a leak into an unselected clip is invisible to it, and
    // selecting each clip in turn to read it would pass a build that reloaded on selection.
    const drawn = Object.fromEntries(k.timeline.clips()
      .map((c) => [c.id, c.level.map((v) => Number(v.toFixed(9)))]));
    const body = k.library.serialiseProjectBody();
    const held = Object.fromEntries(body.clips
      .map((c) => [c.id, { tilt: c.params.tilt, roll: c.params.roll }]));
    return { drawn, held, ids: body.clips.map((c) => c.id) };
  })()`);

  const wantC1 = levellingQuaternion(TILT, 0);
  const wantC2 = levellingQuaternion(0, ROLL);
  console.log(`  c1 holds tilt ${staged.held.c1?.tilt} roll ${staged.held.c1?.roll} and draws `
    + `${show(staged.drawn.c1)}; c2 holds tilt ${staged.held.c2?.tilt} roll ${staged.held.c2?.roll} `
    + `and draws ${show(staged.drawn.c2)}`);

  check(eq(staged.ids, ['c1', 'c2']),
    'the edit holds two clips, which is the only fixture where the rows below can be false',
    show(staged.ids));
  check(!eq(wantC1, wantC2),
    'and the two rotations they should be drawing are different, so the two rows below are not '
    + 'one row asked twice',
    `${show(wantC1)} against ${show(wantC2)}`);
  check(eq(staged.held.c1, { tilt: TILT, roll: 0 }) && eq(staged.held.c2, { tilt: 0, roll: ROLL }),
    'each clip serialises the two angles it was written with and not the other clip\'s',
    `c1 ${show(staged.held.c1)}, c2 ${show(staged.held.c2)}`);
  check(eq(staged.drawn.c1, wantC1),
    'and the clip written last draws the rotation its own two angles compose to, so a write made '
    + 'on it did not pick up the roll standing on another clip',
    `${show(staged.drawn.c1)} against ${show(wantC1)}`);
  check(eq(staged.drawn.c2, wantC2),
    'and the clip written first still draws its own, so the later write on another clip did not '
    + 'reach back into it',
    `${show(staged.drawn.c2)} against ${show(wantC2)}`);

  // Back to one clip, because every section after this one is written against a single-clip
  // edit and a second clip left standing would draw into all of them.
  await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const doc = k.library.serialiseProjectBody();
    doc.clips = [{ ...doc.clips[0], id: 'c1', start: 0 }];
    k.library.restoreProject(doc);
    await k.timeline.settled();
  })()`);
}

console.log('\n[registry] the ripple opens the region by itself');
{
  const alone = { ...SCRAMBLE, 'push.amount': 0, 'noise.region': 0, 'mask.amount': 0 };
  const still = await run({ ...alone, 'ripple.amount': 0 });
  const moving = await run(alone);
  check(!eq(still, moving),
    'raising the ripple alone moves the picture, so the gate names it',
    eq(still, moving)
      ? 'identical with every other region effect at zero - the gate does not name the ripple'
      : `${still.filter((h, i) => h !== moving[i]).length} of ${still.length} frames differ`);
}

console.log('\n[registry] the cloud carries a rotation and a placement and nothing else');
{
  const m = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    let cloud = null;
    k.scene.traverse((o) => { if (o.geometry === k.geometry) cloud = o; });
    if (!cloud) return { found: false };
    cloud.updateMatrixWorld(true);
    const pos = new (cloud.position.constructor)();
    const quat = new (cloud.quaternion.constructor)();
    const scale = new (cloud.scale.constructor)();
    cloud.matrixWorld.decompose(pos, quat, scale);
    return {
      found: true,
      position: [pos.x, pos.y, pos.z].map((v) => Number(v.toFixed(9))),
      scale: [scale.x, scale.y, scale.z].map((v) => Number(v.toFixed(9))),
    };
  })()`);
  check(m.found, 'the point cloud is reachable from the scene, so the row below is about it');
  // The scale term alone is what the shaders rest on: `mat3(modelMatrix)` drops the fourth
  // column, so a translation cannot break the transpose and a scale or a shear can. The origin
  // used to be asserted with it and no longer can be - a clip carries a placement now - so the
  // translation is asked against what the registry holds for it rather than dropped.
  check(m.found && eq(m.scale, [1, 1, 1]),
    'and its world matrix carries no scale, so the lattice\'s transpose is its inverse',
    m.found ? `scale ${JSON.stringify(m.scale)}` : '');
  const placed = await page.evaluate(
    "globalThis.__kinect.params.get('transform').position.map((v) => Number(v.toFixed(9)))");
  check(m.found && eq(m.position, placed),
    'and the translation in it is the placement the registry holds for this clip and nothing else',
    `group ${JSON.stringify(m.position)} against registry ${JSON.stringify(placed)}`);
}

console.log('\n[registry] the ripple advances in steps, not smoothly');
{
  const AT = 0.5;
  const at = async (speed) => page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    k.params.reset();
    k.params.apply(${JSON.stringify(SCRAMBLE)});
    k.params.set('ripple.speed', ${speed});
    k.drive.reset();
    pinCamera(k.freeCamera);
    k.drive.stepTo(${AT});
    return await sha256(k.drive.readPixels());
  })()`);

  // floor(0.5 * speed * 8) is 4 at both 1.00 and 1.20, and 5 at 1.30.
  const inStep = await at(1.0);
  const alsoInStep = await at(1.2);
  const nextStep = await at(1.3);
  check(inStep === alsoInStep,
    'two speeds inside one step render the same frame, so the phase is quantised',
    inStep === alsoInStep ? `both ${inStep.slice(0, 12)} at 1.00 and 1.20`
      : `${inStep.slice(0, 12)} vs ${alsoInStep.slice(0, 12)} - the phase slid inside a step`);
  check(inStep !== nextStep,
    'and a speed in the next step renders a different one, so the clock is running',
    inStep === nextStep ? 'identical across a step boundary at 1.30' : 'differs at 1.30');
}

console.log('\n[registry] a pair planted with a known speed in it');
{
  const CURR_MM = 1100;
  const LOOK = { 'duotone.amount': 1, fade: 0, wake: 0 };

  // The previous frame is built from a rule rather than filled with a value, so one helper
  // plants both a uniform wall and a chequered one: a block size of 0 is the plane.
  const shot = ({ prevMm, spanSec, motion, block = 0, snapDelta = 250 }) => page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    k.params.reset();
    k.params.apply(${JSON.stringify(LOOK)});
    k.params.set('duotone.motion', ${motion});
    k.params.set('snapDelta', ${snapDelta});
    k.drive.reset();
    pinCamera(k.freeCamera);
    const plane = (mm) => new Uint16Array(512 * 424).fill(mm);
    const previous = () => {
      const block = ${block};
      if (block === 0) return plane(${prevMm});
      const a = new Uint16Array(512 * 424);
      for (let row = 0; row < 424; row++) {
        for (let col = 0; col < 512; col++) {
          const moving = (((col / block) | 0) + ((row / block) | 0)) % 2 === 0;
          a[row * 512 + col] = moving ? ${prevMm} : ${CURR_MM};
        }
      }
      return a;
    };
    k.drive.injectDepth(previous());
    k.drive.injectDepth(plane(${CURR_MM}));
    k.uniforms.mixT.value = 1;
    k.uniforms.sinceFrameSec.value = 0;
    k.uniforms.spanSec.value = ${spanSec};
    k.renderer.render(k.scene, k.freeCamera);
    const px = k.drive.readPixels();
    let red = 0, lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      red += px[i];
      if (px[i] + px[i + 1] + px[i + 2] > 12) lit++;
    }
    const n = px.length / 4;
    return { hash: await sha256(px), red: red / n, lit: lit / n };
  })()`);

  const QUARTER = 0.25, SIXTEENTH = 0.0625;
  const still = { prevMm: CURR_MM, spanSec: QUARTER };
  // 240mm across a quarter of a second, which is inside the 250mm snap threshold.
  const fast = { prevMm: CURR_MM - 240, spanSec: QUARTER };
  const brief = { prevMm: CURR_MM - 60, spanSec: SIXTEENTH };
  // 300mm, which is past the threshold, so the pair is two surfaces rather than one that moved.
  const jumped = { prevMm: CURR_MM - 300, spanSec: QUARTER };
  const chequer = { prevMm: CURR_MM - 240, spanSec: QUARTER, block: 16 };

  const off = { still: await shot({ ...still, motion: 0 }), fast: await shot({ ...fast, motion: 0 }) };
  const on = {
    still: await shot({ ...still, motion: 1 }),
    fast: await shot({ ...fast, motion: 1 }),
    brief: await shot({ ...brief, motion: 1 }),
    jumped: await shot({ ...jumped, motion: 1 }),
    joined: await shot({ ...jumped, motion: 1, snapDelta: 410 }),
    chequer: await shot({ ...chequer, motion: 1 }),
  };

  check(on.still.lit > 0.2 && on.still.red > 0,
    'the planted wall renders, so the rows below are comparing pictures rather than black',
    `${(100 * on.still.lit).toFixed(1)}% of the frame is lit, mean red ${on.still.red.toFixed(2)}`);

  check(off.still.hash === off.fast.hash,
    'at a motion of 0 a fast pair and a still one are bit-identical, so the default is inert',
    off.still.hash === off.fast.hash ? `both ${off.still.hash.slice(0, 12)}`
      : `${off.still.hash.slice(0, 12)} vs ${off.fast.hash.slice(0, 12)}`);

  check(on.still.hash !== on.fast.hash,
    'and raised, the same two pairs render differently, so the speed reaches the colour',
    on.still.hash === on.fast.hash ? 'identical with a planted 960 mm/s'
      : `${on.still.hash.slice(0, 12)} vs ${on.fast.hash.slice(0, 12)}`);

  check(on.fast.red > on.still.red * 1.2,
    'and it moves toward the hot pole rather than merely somewhere else',
    `mean red ${on.fast.red.toFixed(2)} moving against ${on.still.red.toFixed(2)} still`);

  check(on.fast.hash === on.brief.hash,
    'the same speed over two different spans renders the same frame, so the varying is mm/s',
    on.fast.hash === on.brief.hash
      ? `240mm over ${QUARTER}s and 60mm over ${SIXTEENTH}s both ${on.fast.hash.slice(0, 12)}`
      : `${on.fast.hash.slice(0, 12)} vs ${on.brief.hash.slice(0, 12)} - a per-frame difference, `
        + 'not a rate');

  check(on.jumped.hash === on.still.hash,
    'a jump past the snap threshold reads as a different surface, not as fast motion',
    on.jumped.hash === on.still.hash ? `both ${on.still.hash.slice(0, 12)} at a 300mm jump`
      : `${on.jumped.hash.slice(0, 12)} vs ${on.still.hash.slice(0, 12)} - the gate is off the speed`);

  check(on.joined.hash !== on.still.hash && on.joined.hash !== on.jumped.hash,
    'raising the snap threshold joins the same 300mm pair into a moving surface',
    on.joined.hash === on.still.hash ? 'still treated as two surfaces at 410mm'
      : `${on.joined.hash.slice(0, 12)} at 410mm vs ${on.jumped.hash.slice(0, 12)} at 250mm`);

  check(on.chequer.hash !== on.fast.hash && on.chequer.hash !== on.still.hash,
    'a chequered pair is neither of the uniform frames, so the speed is per point',
    on.chequer.hash === on.fast.hash ? 'identical to the all-moving frame - one speed for everybody'
      : on.chequer.hash === on.still.hash ? 'identical to the still frame - the speed reached nobody'
        : `${on.chequer.hash.slice(0, 12)}, distinct from both`);

  check(on.still.red < on.chequer.red && on.chequer.red < on.fast.red,
    'and its mean red sits between them, because half the wall is moving',
    `still ${on.still.red.toFixed(2)}, chequer ${on.chequer.red.toFixed(2)}, `
    + `moving ${on.fast.red.toFixed(2)}`);
}

console.log('\n[registry] and the span it is divided by is the gap between the bound frames');
{
  const spans = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    k.params.reset();
    k.drive.reset();
    pinCamera(k.freeCamera);
    const times = k.drive.times();
    const out = [];
    for (let i = 0; i < times.length - 1; i++) {
      k.drive.stepTo(times[i] + (times[i + 1] - times[i]) * 0.5);
      out.push({ want: times[i + 1] - times[i], got: k.uniforms.spanSec.value });
    }
    return out;
  })()`);

  const wrong = spans.filter((s) => s.got !== s.want);
  check(spans.length > 1 && wrong.length === 0,
    'every pair the fixture holds hands the shader its own gap',
    wrong.length
      ? wrong.map((s) => `wanted ${s.want.toFixed(6)}s, got ${s.got.toFixed(6)}s`).join('; ')
      : `${spans.length} pairs at ${spans.map((s) => (s.want * 1000).toFixed(0)).join('/')}ms`);
  check(new Set(spans.map((s) => s.want)).size > 1,
    'and no two of those gaps are the same, so a constant cannot satisfy the row above',
    `${new Set(spans.map((s) => s.want)).size} distinct gaps in ${spans.length} pairs`);
}

console.log('\n[registry] the duotone span is metres, held across two clip ranges');
{
  const PLANE_M = 1.5;
  const SPAN_M = 1;
  const RANGES = [
    { near: 0.5, far: 2.5 },
    { near: 0.5, far: 4.5 },
  ].map((r) => ({ ...r, split: (PLANE_M - r.near) / (r.far - r.near) }));
  const WALLS_MM = [1250, 1750];

  const wallAt = ({ mm, near, far, split, span }) => page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    k.params.reset();
    k.params.apply({ 'duotone.amount': 1, fade: 0, wake: 0,
      near: ${near}, far: ${far}, 'duotone.split': ${split}, 'duotone.span': ${span} });
    k.drive.reset();
    pinCamera(k.freeCamera);
    const plane = new Uint16Array(512 * 424).fill(${mm});
    k.drive.injectDepth(plane);
    k.drive.injectDepth(plane);
    k.uniforms.mixT.value = 1;
    k.uniforms.sinceFrameSec.value = 0;
    k.uniforms.spanSec.value = 0.25;
    k.renderer.render(k.scene, k.freeCamera);
    const px = k.drive.readPixels();
    let red = 0, lit = 0;
    for (let i = 0; i < px.length; i += 4) {
      red += px[i];
      if (px[i] + px[i + 1] + px[i + 2] > 12) lit++;
    }
    const n = px.length / 4;
    return { hash: await sha256(px), red: red / n, lit: lit / n };
  })()`);

  const shots = [];
  for (const range of RANGES) {
    const row = [];
    for (const mm of WALLS_MM) row.push(await wallAt({ mm, ...range, span: SPAN_M }));
    shots.push(row);
  }

  const dimmest = Math.min(...shots.flat().map((s) => s.lit));
  check(dimmest > 0.2,
    'both walls render at both ranges, so the rows below are comparing pictures rather than black',
    `${shots.map((row, i) => row.map((s, j) => `${WALLS_MM[j]}mm at far ${RANGES[i].far}: `
      + `${(100 * s.lit).toFixed(1)}% lit, red ${s.red.toFixed(2)}`).join('; ')).join(' | ')}`);

  const [nearWall, farWall] = shots[0];
  check(farWall.red - nearWall.red > 2 && nearWall.red > 0 && farWall.red < 255,
    'and the two walls land either side of the crossing without saturating, so the ramp is being read',
    `1250mm mean red ${nearWall.red.toFixed(2)}, 1750mm ${farWall.red.toFixed(2)}`);

  for (const [j, mm] of WALLS_MM.entries()) {
    const a = shots[0][j], b = shots[1][j];
    check(a.hash === b.hash,
      `a wall ${((mm / 1000 - PLANE_M) * 100).toFixed(0)}cm from the crossing renders the same `
      + `through a ${(RANGES[0].far - RANGES[0].near).toFixed(1)}m range and a `
      + `${(RANGES[1].far - RANGES[1].near).toFixed(1)}m one`,
      a.hash === b.hash
        ? `mean red ${a.red.toFixed(2)} at both, ${a.hash.slice(0, 12)}`
        : `${a.hash.slice(0, 12)} at far ${RANGES[0].far} against ${b.hash.slice(0, 12)} at far `
          + `${RANGES[1].far}; mean red ${a.red.toFixed(2)} against ${b.red.toFixed(2)}, so the `
          + 'ramp is a share of the box rather than a distance');
  }

  const wide = await wallAt({ mm: WALLS_MM[1], ...RANGES[0], span: 3 });
  check(wide.hash !== shots[0][1].hash,
    'while widening the ramp at one range does move it, so the equalities above are not '
    + 'a parameter that reaches nothing',
    `${SPAN_M}m gives mean red ${shots[0][1].red.toFixed(2)}, 3m gives ${wide.red.toFixed(2)}`);
}

// The glyph field plants a condition rather than sweeping a parameter: the drop-one sweep
// can say a term reaches a pixel and cannot say what it means. The plant is the section
// above's idiom, plus a pose and the two clocks this branch introduced, and nothing may
// call `drive.stepTo` afterwards or the transport binds real frames over it. This renderer
// does not clear to black, so each section renders its own empty frame and reads against it.
const FIELD_HELPERS = `
  const empty = () => new Uint16Array(512 * 424);
  const plane = (mm) => new Uint16Array(512 * 424).fill(mm);
  // Every second texel in each axis dropped. At the cell sizes below this leaves every
  // occupied cell still occupied and a quarter of the points inside it, which is the
  // redundancy a per-cell identity is invariant under and a per-point one is not.
  const thinned = (mm) => {
    const a = new Uint16Array(512 * 424);
    for (let r = 0; r < 424; r += 2) for (let c = 0; c < 512; c += 2) a[r * 512 + c] = mm;
    return a;
  };
  // One column of the room. The rain's phase is offset per column by a hash of the cell's
  // own x and z, so neighbouring columns are deliberately out of step - which is what makes
  // a full wall useless for reading the shape of a single drop, since the frame holds a
  // dozen columns at a dozen phases and their profiles average out. A strip narrow enough
  // to fall inside one cell is one column, and a column has one profile.
  const column = (mm, halfWidth) => {
    const a = new Uint16Array(512 * 424);
    for (let r = 0; r < 424; r++) {
      for (let c = 256 - halfWidth; c < 256 + halfWidth; c++) a[r * 512 + c] = mm;
    }
    return a;
  };
  const oneTexel = (mm) => { const a = new Uint16Array(512 * 424); a[212 * 512 + 256] = mm; return a; };
  // **A wall whose texels sit at different depths inside one cell**, which is the fixture
  // every other glyph section here deliberately is not. A flat wall hands every occupant of
  // a cell the same colour, so a character keyed on the point and a character keyed on the
  // cell draw the same picture and no thinning can tell them apart - which is exactly why
  // the tone key shipped broken. The spread is bounded under half a cell so the occupants
  // stay inside one cell rather than becoming several: what this fixture is about is many
  // *different* sources in one cell, not more cells.
  const hetero = (baseMm, ampMm) => {
    const a = new Uint16Array(512 * 424);
    const span = 2 * ampMm + 1;
    for (let r = 0; r < 424; r++) {
      for (let c = 0; c < 512; c++) a[r * 512 + c] = baseMm - ampMm + ((r * 7 + c * 11) % span);
    }
    return a;
  };
  // Every second texel in each axis dropped out of whatever was planted, which the thinned
  // helper above does for a constant plane and this does for a fixture that varies.
  const thin = (src) => {
    const a = new Uint16Array(512 * 424);
    for (let r = 0; r < 424; r += 2) for (let c = 0; c < 512; c += 2) a[r * 512 + c] = src[r * 512 + c];
    return a;
  };
  // Which pixels a frame painted at all, as one hash, and it is the only comparison a
  // heterogeneous cell admits. The *colour* of a painted pixel is the colour of whichever
  // occupant won the depth test, and at full lattice every occupant of a cell is at the same
  // snapped depth - so which one that is depends on attribute order and changes when the
  // sources are thinned, on a build with nothing wrong with it. Which pixels got painted is
  // a different quantity: a set bit of the character paints and a clear bit discards, so the
  // mask is the bitmask the cell chose and nothing else.
  const maskHash = (px, bg) => {
    const m = new Uint8Array(px.length / 4);
    for (let i = 0, j = 0; i < px.length; i += 4, j++) {
      m[j] = (px[i] !== bg[i] || px[i + 1] !== bg[i + 1] || px[i + 2] !== bg[i + 2]) ? 1 : 0;
    }
    return sha256(m);
  };
  // A near surface standing in front of a far one, which one depth image cannot hold
  // twice over: a texel is one range, so the two surfaces have to be cut out of the same
  // grid rather than stacked along one ray. Every step-th texel in each axis is the near
  // surface and every other one is the far surface, and what makes that enough is the
  // sprite - a near cell projects several times larger than a far one, so its mark spills
  // across screen the far surface is drawing into.
  //
  // **Three fixtures out of one mask, and the union of the last two is exactly the first,
  // point for point.** The far-only frame carries holes where the near points are rather
  // than a wall written behind them, because a far point that exists in one frame and not
  // the other is a difference the comparison would read as occlusion. Interleaved rather
  // than banded so that the two surfaces alternate in the attribute order as well as on
  // screen: a near sprite only hides a far point the driver reaches *after* it, and a
  // block of near texels would leave that dependent on which side of the block the far
  // rows sat.
  const twoSurfaces = (nearMm, farMm, step) => {
    const both = new Uint16Array(512 * 424);
    const near = new Uint16Array(512 * 424);
    const far = new Uint16Array(512 * 424);
    for (let r = 0; r < 424; r++) {
      for (let c = 0; c < 512; c++) {
        const i = r * 512 + c;
        if (r % step === 0 && c % step === 0) { both[i] = nearMm; near[i] = nearMm; }
        else { both[i] = farMm; far[i] = farMm; }
      }
    }
    return { both, near, far };
  };
  // Whether a frame put anything at all on a pixel, against the empty frame this renderer
  // draws when no point survives. Exact rather than thresholded, because the question is
  // "did a fragment land here" and a fragment either did or did not.
  const drew = (px, bg, i) => px[i] !== bg[i] || px[i + 1] !== bg[i + 1] || px[i + 2] !== bg[i + 2];
  // How many distinct colours a frame put on the pixels the empty frame did not. At full
  // glyph on a flat wall this is the sharpest statement there is about the mark: every cell
  // sits at one depth so the reading hands them all one colour, and a hard bit either
  // replaces a pixel with that colour or leaves it alone - one value. A mark part way
  // through the crossfade is the round splat's gradient blended toward the bitmask, so it
  // paints a spread of them. No threshold, and nothing to calibrate.
  const levels = (px, bg) => {
    const seen = new Set();
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] !== bg[i] || px[i + 1] !== bg[i + 1] || px[i + 2] !== bg[i + 2]) {
        seen.add(px[i] * 65536 + px[i + 1] * 256 + px[i + 2]);
      }
    }
    return seen.size;
  };
  const field = ({ look, depth, eye = [0, 0.1, 1.6], at = [0, 0, -2.2],
    spanSec = 0.25, rainPhase = 0, time = 0, cropOutside = null }) => {
    k.params.reset();
    k.params.apply(look);
    k.drive.reset();
    k.freeCamera.position.set(eye[0], eye[1], eye[2]);
    k.freeCamera.lookAt(at[0], at[1], at[2]);
    k.freeCamera.updateMatrixWorld(true);
    k.drive.injectDepth(depth);
    k.drive.injectDepth(depth);
    k.uniforms.mixT.value = 1;
    k.uniforms.sinceFrameSec.value = 0;
    k.uniforms.spanSec.value = spanSec;
    k.uniforms.rainPhase.value = rainPhase;
    k.uniforms.time.value = time;
    // The crop's faint pass is not a look value - the editor writes it from whether the box
    // is on screen - so an arm that needs cut-away points alive has to say so here, the way
    // the two clocks above do. Left alone it is whatever the page last set, which on this
    // surface is 0, and 0 is the hard cull.
    if (cropOutside !== null) k.uniforms.cropOutside.value = cropOutside;
    k.renderer.render(k.scene, k.freeCamera);
    return k.drive.readPixels();
  };
  const above = (px, bg) => {
    let energy = 0, peak = 0, lit = 0, painted = 0;
    for (let i = 0; i < px.length; i += 4) {
      const d = (px[i] + px[i + 1] + px[i + 2]) - (bg[i] + bg[i + 1] + bg[i + 2]);
      if (d > 0) energy += d;
      if (d > 12) lit++;
      if (d > 2) painted++;
      const m = Math.max(px[i] - bg[i], px[i + 1] - bg[i + 1], px[i + 2] - bg[i + 2]);
      if (m > peak) peak = m;
    }
    const n = px.length / 4;
    return { energy: energy / n, peak, lit: lit / n, painted };
  };
  const apart = (a, b) => {
    let sum = 0, differing = 0;
    for (let i = 0; i < a.length; i += 4) {
      const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]));
      sum += d;
      if (d > 0) differing++;
    }
    const n = a.length / 4;
    return { mean: sum / n, pct: (100 * differing) / n };
  };
`;

// The look every glyph section below is read through, and the three choices in it that are
// not incidental. Normal blending at an opacity of exactly 1, so a fragment's alpha is 0 or
// 1 and drawing the same character over itself is idempotent - which is what lets a row ask
// for bit-identity between a wall and a quarter of it. The depth reading alone, because the
// planted colour is a 2x2 image and points inside one cell would draw different colours. And
// a cell of 0.25m, which rasterises to 24 pixels at this stage height, so the mask is a hard
// bit rather than a blend between a bitmask and a disc.
const GLYPH_LOOK = {
  additive: false, denoise: false, fade: 0, wake: 0, opacity: 1, exposure: 1, pointSize: 64,
  'lattice.amount': 1, cell: 0.25, 'glyph.amount': 1, 'glyph.tone': 0, 'glyph.hash': 1,
  'glyph.rain': 0, 'rain.amount': 0,
  readRgb: 0, readDepth: 1, 'ghost.amount': 0, 'contour.amount': 0,
  'blackwall.amount': 0, near: 0.5, far: 4,
};

console.log('\n[registry] one cell, one character: the mark is a fact about the room');
{
  const shots = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    const look = ${JSON.stringify(GLYPH_LOOK)};
    const bg = field({ look, depth: empty() }).slice();
    const out = {};
    for (const [fixture, depth] of [['whole', plane(2400)], ['thinned', thinned(2400)]]) {
      for (const master of [1, 0]) {
        const px = field({ look: { ...look, 'glyph.amount': master }, depth });
        out[fixture + (master ? 'Glyph' : 'Dots')] = { hash: await sha256(px), ...above(px, bg) };
      }
    }
    return out;
  })()`);

  check(shots.wholeGlyph.lit > 0.03 && shots.wholeGlyph.energy > 5,
    'the planted wall draws characters, so the rows below are comparing marks rather than black',
    `${(100 * shots.wholeGlyph.lit).toFixed(2)}% of the frame is inked, energy `
    + `${shots.wholeGlyph.energy.toFixed(2)}`);

  check(shots.wholeGlyph.hash === shots.thinnedGlyph.hash,
    'thinning the wall to a quarter of its points draws the identical marks, so the '
    + 'character belongs to the cell',
    shots.wholeGlyph.hash === shots.thinnedGlyph.hash
      ? `both ${shots.wholeGlyph.hash.slice(0, 12)}`
      : `${shots.wholeGlyph.hash.slice(0, 12)} against ${shots.thinnedGlyph.hash.slice(0, 12)} - `
        + 'the mark follows the points rather than the cell');

  check(shots.wholeDots.hash !== shots.thinnedDots.hash,
    'while at a glyph of 0 the same thinning does change the picture, so the equality above '
    + 'is not a fixture nothing can move',
    shots.wholeDots.hash === shots.thinnedDots.hash
      ? 'identical as round splats too - the thinning reached nothing'
      : `${(100 * shots.wholeDots.lit).toFixed(2)}% inked, ${shots.wholeDots.hash.slice(0, 12)} `
        + `against ${shots.thinnedDots.hash.slice(0, 12)}`);
}

console.log('\n[registry] and a cell whose occupants disagree still draws one character');
{
  const hetero = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    const look = { ...${JSON.stringify(GLYPH_LOOK)}, cell: 0.25, 'glyph.tone': 1,
      'glyph.hash': 0, 'glyph.rain': 0, near: 2, far: 3 };
    const wall = hetero(2500, 120);
    const bg = field({ look, depth: empty() }).slice();
    const at = async (over, depth) => {
      const px = field({ look: { ...look, ...over }, depth });
      return { mask: await maskHash(px, bg), levels: levels(px, bg), ...above(px, bg) };
    };
    return {
      whole: await at({}, wall),
      thinned: await at({}, thin(wall)),
      // The same wall drawn as round splats, which is what says the occupants really do
      // differ: a flat wall at one depth paints one colour and this paints many.
      dots: await at({ 'glyph.amount': 0 }, wall),
      flatDots: await at({ 'glyph.amount': 0 }, plane(2500)),
      // The key moved on the same geometry, so the mask is shown to be able to see a
      // character before it is asked to prove one did not change.
      toneDown: await at({ 'glyph.tone': 0 }, wall),
      cell: k.uniforms.latticeCell.value,
    };
  })()`);

  const cellOf = (mm) => Math.floor(-(mm / 1000) / hetero.cell + 0.5);
  const oneCell = cellOf(2380) === cellOf(2620);
  check(oneCell && hetero.whole.lit > 0.005,
    'the planted occupants span 0.24m and all of it falls in one cell, and the wall draws '
    + 'characters - so the rows below are about disagreeing occupants rather than about '
    + 'more cells',
    `2.380m and 2.620m both snap to cell ${cellOf(2380)} at a ${hetero.cell}m grid, `
    + `${(100 * hetero.whole.lit).toFixed(2)}% inked`);

  check(hetero.dots.levels > hetero.flatDots.levels * 4,
    'and as round splats those occupants paint many colours where a flat wall paints few, so '
    + 'the cell genuinely holds sources a per-point key would read differently',
    `${hetero.dots.levels} distinct colours on the ramped wall against `
    + `${hetero.flatDots.levels} on a flat one at the same depth`);

  check(hetero.whole.mask !== hetero.toneDown.mask,
    'and dropping the tone key repaints the frame, so the mask is an observable that reads '
    + 'which character was chosen',
    `${hetero.whole.mask.slice(0, 12)} at a tone of 1 against `
    + `${hetero.toneDown.mask.slice(0, 12)} at 0`);

  check(hetero.whole.mask === hetero.thinned.mask,
    'thinning a cell whose occupants sit at different depths paints the identical pixels, so '
    + 'the tone key is a fact about the cell rather than about whichever point got there',
    hetero.whole.mask === hetero.thinned.mask
      ? `both ${hetero.whole.mask.slice(0, 12)} over ${hetero.whole.painted}px painted`
      : `${hetero.whole.mask.slice(0, 12)} against ${hetero.thinned.mask.slice(0, 12)} - the `
        + `cell is painting the union of its occupants' characters, `
        + `${hetero.whole.painted}px against ${hetero.thinned.painted}px`);
}

console.log('\n[registry] and a character travels with its point through the turbulence');
{
  // The wall sits at a cell centre in depth and the turbulence is bounded inside that cell: a
  // displacement larger than half a cell moves every point into a neighbouring depth cell at once,
  // which changes the occupied set and is the one thing a build hashing the
  // displaced point can see.
  const NOISE = { 'noise.amount': 0.1, 'noise.scale': 1.5, 'noise.speed': 1 };
  const RIPPLE = {
    'noise.amount': 0, 'ripple.amount': 0.05, 'ripple.freq': 4, 'ripple.speed': 0.5,
    'push.amount': 0.06,
    regionX: 0, regionY: 0, regionZ: -2.5, regionW: 1, regionH: 1, regionD: 1,
  };
  const moved = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    const look = { ...${JSON.stringify(GLYPH_LOOK)}, cell: 0.25, ...${JSON.stringify(NOISE)} };
    const ripple = ${JSON.stringify(RIPPLE)};
    const wall = plane(2500);
    const bg = field({ look, depth: empty() }).slice();
    const at = (over, time) => field({ look: { ...look, ...over }, depth: wall, time });
    const out = {};
    for (const [label, over] of [['characters', {}], ['cells', { 'glyph.hash': 0 }],
      ['dots', { 'glyph.amount': 0 }],
      ['rippleCharacters', ripple], ['rippleCells', { ...ripple, 'glyph.hash': 0 }]]) {
      const first = at(over, 0).slice();
      const second = at(over, 3);
      out[label] = { ...apart(first, second), ...above(first, bg) };
    }
    return out;
  })()`);

  check(moved.characters.lit > 0.03,
    'the planted wall draws characters under the turbulence, so the rows below are about marks',
    `${(100 * moved.characters.lit).toFixed(2)}% inked, energy ${moved.characters.energy.toFixed(2)}`
    + `; as round splats the same two phases sit ${moved.dots.mean.toFixed(3)}/255 apart`);

  check(moved.cells.mean === 0,
    'with the hash key down the two phases are bit-identical, so the turbulence moves no '
    + 'point out of the cell it started in',
    `mean ${moved.cells.mean.toFixed(3)}/255 over ${moved.cells.pct.toFixed(2)}% of pixels, at `
    + `${(100 * moved.cells.lit).toFixed(2)}% inked`);

  check(moved.characters.mean > 1,
    'and with it up they move anyway, so a character is carried in by its point rather than '
    + 'read off where the point landed',
    `characters ${moved.characters.mean.toFixed(3)}/255 over ${moved.characters.pct.toFixed(2)}% `
    + `of pixels, against ${moved.cells.mean.toFixed(3)} for the cell set alone`);

  check(moved.rippleCharacters.lit > 0.03,
    'the wall draws characters under the ripple and the push too, so the pair below is '
    + 'about marks rather than about an empty frame',
    `${(100 * moved.rippleCharacters.lit).toFixed(2)}% inked, energy `
    + `${moved.rippleCharacters.energy.toFixed(2)}`);
  check(moved.rippleCells.mean === 0,
    'with the hash key down the ripple and the push move no point out of the cell it '
    + 'started in either, so the two phases are bit-identical',
    `mean ${moved.rippleCells.mean.toFixed(3)}/255 over ${moved.rippleCells.pct.toFixed(2)}% `
    + 'of pixels');
  check(moved.rippleCharacters.mean > 1,
    'and with it up they move, so the character was hashed before the ripple and the push '
    + 'rather than after them',
    `characters ${moved.rippleCharacters.mean.toFixed(3)}/255 over `
    + `${moved.rippleCharacters.pct.toFixed(2)}% of pixels, against `
    + `${moved.rippleCells.mean.toFixed(3)} for the cell set alone`);
}

console.log('\n[registry] the three keys add and wrap, so doubling two of them is a different picture');
{
  const keys = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    const look = { ...${JSON.stringify(GLYPH_LOOK)}, cell: 0.25, 'glyph.hash': 0, 'glyph.tone': 0 };
    const wall = plane(2400);
    const bg = field({ look, depth: empty() }).slice();
    const at = async (toneKey, hashKey, rainKey = 0) => {
      const px = field({ look: { ...look, 'glyph.tone': toneKey, 'glyph.hash': hashKey,
        'glyph.rain': rainKey }, depth: wall });
      return { hash: await sha256(px), ...above(px, bg) };
    };
    // The hash key swept on its own, for the sign row below. With the other two keys down
    // the index argument is the fraction of the weight times the cell seed, and a seed is
    // under 1, so nothing wraps and the sweep walks the table out of its sparse end.
    const ramp = [];
    for (const hashKey of [0, 0.25, 0.5, 0.75, 1]) {
      ramp.push({ hashKey, ...(await at(0, hashKey)) });
    }
    return {
      half: await at(0.35, 0.35),
      doubled: await at(0.7, 0.7),
      toneAlone: await at(0.7, 0),
      hashAlone: await at(0, 0.7),
      neither: await at(0, 0),
      // The rain key alone, and at exactly 1 rather than near it. The key reads whole drops
      // gone past - an integer - and the fraction of an integer is zero, so a build using
      // that counter raw contributes nothing to the index at precisely the weight where the
      // key should be loudest. Every other arm here holds it at a weight whose fraction is
      // not zero, where a raw counter still scrambles and the defect cannot be seen.
      rainAlone: await at(0, 0, 1),
      ramp,
    };
  })()`);

  check(keys.half.lit > 0.03,
    'the two keys together draw characters, so the rows below are comparing marks rather than black',
    `${(100 * keys.half.lit).toFixed(2)}% inked, energy ${keys.half.energy.toFixed(2)}`);

  check(keys.half.hash !== keys.doubled.hash,
    'doubling both keys draws different characters, so the index is a sum and not a ratio',
    keys.half.hash === keys.doubled.hash
      ? `identical at 0.35/0.35 and 0.70/0.70, ${keys.half.hash.slice(0, 12)} - the keys normalise`
      : `${keys.half.hash.slice(0, 12)} at 0.35/0.35 against ${keys.doubled.hash.slice(0, 12)} at 0.70/0.70`);

  const soloes = { toneAlone: keys.toneAlone, hashAlone: keys.hashAlone, neither: keys.neither };
  const blank = Object.keys(soloes).filter((n) => !(soloes[n].lit > 0.005));
  check(blank.length === 0,
    'each key on its own, and the picture with both of them off, draws characters - so the '
    + 'row below is separating marks rather than empty frames',
    Object.keys(soloes).map((n) => `${n} ${(100 * soloes[n].lit).toFixed(2)}%`).join(', ')
      + (blank.length ? ` - ${blank.join(', ')} inked nothing` : ''));
  const same = Object.keys(soloes).filter((n) => soloes[n].hash === keys.half.hash);
  check(same.length === 0,
    'and the pair is neither of the keys alone, nor the picture with both of them off',
    same.length ? `identical to ${same.join(', ')}` : 'distinct from all three');

  const ramp = keys.ramp;
  const inks = ramp.map((r) => r.lit);
  const descents = ramp.filter((r, i) => i > 0 && r.lit < ramp[i - 1].lit);
  check(descents.length === 0,
    'and raising the hash key alone only ever draws more ink, so it walks the table out of '
    + 'the sparse end rather than into it',
    ramp.map((r) => `${r.hashKey} -> ${(100 * r.lit).toFixed(2)}%`).join(', '));
  check(inks[inks.length - 1] > inks[0] * 1.5,
    'and the far end of that sweep is substantially inkier than the near one, so the row '
    + 'above is a ramp rather than five equal readings',
    `${(100 * inks[0]).toFixed(2)}% at a hash of 0 against `
    + `${(100 * inks[inks.length - 1]).toFixed(2)}% at 1`);

  check(keys.rainAlone.lit > 0.005,
    'the rain key on its own draws characters, so the row below is separating marks rather '
    + 'than empty frames',
    `${(100 * keys.rainAlone.lit).toFixed(2)}% inked, energy ${keys.rainAlone.energy.toFixed(2)}`);
  check(keys.rainAlone.hash !== keys.neither.hash,
    'and at a weight of exactly 1 it still chooses the character, so the counter it reads is '
    + 'stepped by something irrational rather than handed over whole',
    keys.rainAlone.hash === keys.neither.hash
      ? `identical to the picture with every key down, ${keys.neither.hash.slice(0, 12)} - the `
        + 'whole-number counter is inert at this weight'
      : `${keys.rainAlone.hash.slice(0, 12)} against ${keys.neither.hash.slice(0, 12)} with `
        + 'every key down');

  // An oracle for the composition rather than another property of it. At full glyph on a flat
  // wall with lattice 1 the sprite is exactly the cell, so the painted fraction of the covered
  // region is the character's popcount over 64 and seven measurements are fitted against one
  // free constant. The prediction reimplements the snap rather than reading it, and the guard
  // under it enforces the premise that rests on: the cloud carries no rotation.
  const oracle = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    const look = { ...${JSON.stringify(GLYPH_LOOK)}, cell: 0.25, 'glyph.hash': 0,
      'glyph.rain': 0, near: 0.5, far: 8 };
    const wall = plane(2400);
    const bg = field({ look: { ...look, 'glyph.tone': 0 }, depth: empty() }).slice();
    // Exact rather than thresholded: at full glyph the mark is a hard bit at one colour, so
    // a pixel was either painted by a set bit or left as the empty frame.
    const painted = (px) => {
      let n = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] !== bg[i] || px[i + 1] !== bg[i + 1] || px[i + 2] !== bg[i + 2]) n++;
      }
      return n;
    };
    let cloud = null;
    k.scene.traverse((o) => { if (o.geometry === k.geometry) cloud = o; });
    cloud.updateMatrixWorld(true);
    const rows = [];
    for (const tone of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 1]) {
      rows.push({ tone, painted: painted(field({ look: { ...look, 'glyph.tone': tone }, depth: wall })) });
    }
    return {
      rows,
      cloudMatrix: Array.from(cloud.matrixWorld.elements).map((v) => Number(v.toFixed(9))),
      near: k.uniforms.nearClip.value,
      far: k.uniforms.farClip.value,
      cell: k.uniforms.latticeCell.value,
      shader: k.material.fragmentShader,
    };
  })()`);

  {
    const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const levelled = oracle.cloudMatrix.every((v, i) => v === IDENTITY[i]);
    const table = oracle.shader.match(/const uvec2 GLYPHS\[64\] = uvec2\[64\]\(([\s\S]*?)\n\);/);
    const popcount = (n) => { let c = 0; for (let x = n >>> 0; x; x >>>= 1) c += x & 1; return c; };
    const inks = table
      ? [...table[1].matchAll(/uvec2\(0x([0-9a-fA-F]{8})u,\s*0x([0-9a-fA-F]{8})u\)/g)]
        .map(([, a, b]) => popcount(parseInt(a, 16)) + popcount(parseInt(b, 16)))
      : [];
    // The snap, the clip position and the index, written out here rather than asked of the
    // page. -2.4 is the planted wall in metres of scene, which unproject puts down -z.
    const cellZ = Math.floor(-2.4 / oracle.cell + 0.5) * oracle.cell;
    const cellTone = 1 - Math.min(1, Math.max(0,
      (-cellZ - oracle.near) / Math.max(0.001, oracle.far - oracle.near)));
    const predicted = oracle.rows.map((r) => {
      const f = (r.tone * cellTone * (63 / 64)) % 1;
      const idx = Math.min(Math.floor(f * 64), 63);
      return { ...r, idx, ink: inks[idx] ?? 0 };
    });

    const spread = Math.max(...predicted.map((p) => p.ink)) / Math.min(...predicted.map((p) => p.ink));
    check(levelled && inks.length === 64 && spread > 2,
      'the cloud is unrotated and the predicted sweep walks the table from sparse to dense, '
      + 'so the fit below has a premise and something to fit',
      `${levelled ? 'identity' : 'rotated'} cloud, ${inks.length} characters read off the `
      + `compiled shader, cell centre at ${(-cellZ).toFixed(3)}m giving a tone of `
      + `${cellTone.toFixed(4)}, predicted ink ${predicted.map((p) => p.ink).join('/')}`);

    const num = predicted.reduce((s, p) => s + p.painted * p.ink, 0);
    const den = predicted.reduce((s, p) => s + p.ink * p.ink, 0);
    const perBit = den > 0 ? num / den : 0;
    const residuals = predicted.map((p) => Math.abs(p.painted - perBit * p.ink) / Math.max(1, perBit * p.ink));
    const worst = Math.max(...residuals);
    check(worst < 0.08,
      'the ink a cell paints is the popcount of the character the wrapped sum names, at every '
      + 'step of the sweep - so the three keys add into an index rather than into anything '
      + 'else that rises with them',
      predicted.map((p, i) => `tone ${p.tone}: index ${p.idx}, ink ${p.ink}, ${p.painted}px `
        + `against ${Math.round(perBit * p.ink)} (${(100 * residuals[i]).toFixed(1)}%)`).join('; '));
  }
}

console.log('\n[registry] the alphabet is sorted by ink, and the tone key reads it as a ramp');
{
  const ramp = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    const look = { ...${JSON.stringify(GLYPH_LOOK)}, cell: 0.25, 'glyph.hash': 0, 'glyph.rain': 0 };
    const wall = plane(2400);
    const rows = [];
    for (const far of [8, 4, 3, 2.6]) {
      const range = { near: 0.5, far };
      const bg = field({ look: { ...look, ...range, 'glyph.tone': 0 }, depth: empty() }).slice();
      // The base arm draws one character in every cell - index 0, the apostrophe - so its
      // coverage is identical at every range and the colour it draws in is the reading's.
      // That is what lets the luminance be measured off the picture rather than assumed
      // from the clip arithmetic.
      const flat = field({ look: { ...look, ...range, 'glyph.tone': 0 }, depth: wall });
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < flat.length; i += 4) {
        if ((flat[i] + flat[i + 1] + flat[i + 2]) - (bg[i] + bg[i + 1] + bg[i + 2]) > 12) {
          r += flat[i] - bg[i]; g += flat[i + 1] - bg[i + 1]; b += flat[i + 2] - bg[i + 2]; n++;
        }
      }
      const inked = field({ look: { ...look, ...range, 'glyph.tone': 1 }, depth: wall });
      rows.push({
        far,
        lum: n ? (0.299 * r + 0.587 * g + 0.114 * b) / n / 255 : 0,
        flat: above(flat, bg),
        ink: above(inked, bg).lit,
      });
    }
    return rows;
  })()`);

  const dimmest = Math.min(...ramp.map((r) => r.flat.lit));
  check(dimmest > 0.005,
    'every arm draws its cells, so the ink fractions below are measured on a picture',
    ramp.map((r) => `far ${r.far}: ${(100 * r.flat.lit).toFixed(2)}% at luminance `
      + `${r.lum.toFixed(3)}`).join('; '));

  const lums = ramp.map((r) => r.lum);
  check(Math.max(...lums) > Math.min(...lums) * 1.5,
    'and the four arms genuinely sit at different luminances, so the ramp has something to '
    + 'be read against',
    `${Math.min(...lums).toFixed(3)} to ${Math.max(...lums).toFixed(3)}`);

  const byLum = ramp.slice().sort((a, b) => a.lum - b.lum);
  const descents = byLum.filter((r, i) => i > 0 && r.ink < byLum[i - 1].ink);
  check(descents.length === 0,
    'a brighter cell draws a denser character, at every step of the ramp',
    byLum.map((r) => `${r.lum.toFixed(3)} -> ${(100 * r.ink).toFixed(2)}% ink`).join(', '));

  check(byLum[byLum.length - 1].ink > byLum[0].ink * 1.25,
    'and the brightest arm is substantially denser than the dimmest, so the key is doing '
    + 'the work rather than the row being flat',
    `${(100 * byLum[0].ink).toFixed(2)}% to ${(100 * byLum[byLum.length - 1].ink).toFixed(2)}%`);

  // Read off the shader the page compiled rather than off the file on disk, because that is
  // the artifact the pixels came from.
  const shader = await page.evaluate('globalThis.__kinect.material.fragmentShader');
  const table = shader.match(/const uvec2 GLYPHS\[64\] = uvec2\[64\]\(([\s\S]*?)\n\);/);
  const popcount = (n) => { let c = 0; for (let x = n >>> 0; x; x >>>= 1) c += x & 1; return c; };
  const inks = table
    ? [...table[1].matchAll(/uvec2\(0x([0-9a-fA-F]{8})u,\s*0x([0-9a-fA-F]{8})u\)/g)]
      .map(([, a, b]) => popcount(parseInt(a, 16)) + popcount(parseInt(b, 16)))
    : [];
  const outOfOrder = (list) => list.map((v, i) => (i > 0 && v < list[i - 1] ? i : -1)).filter((i) => i >= 0);
  check(inks.length === 64,
    'the alphabet the page compiled is sixty-four characters, read out of the shader itself',
    `${inks.length} bitmask pairs${table ? '' : ' - the table did not parse'}`);
  check(inks.length === 64 && outOfOrder(inks).length === 0 && inks[63] > inks[0],
    'and it is sorted by ink, sparsest first, which is what lets one table be a ramp and a '
    + 'noise source at once',
    inks.length === 64
      ? `${inks[0]} bits at the sparse end to ${inks[63]} at the dense one`
      + `${outOfOrder(inks).length ? `, descending at ${outOfOrder(inks).join(',')}` : ''}`
      : '');
  const shuffled = inks.slice();
  if (shuffled.length === 64) { [shuffled[3], shuffled[60]] = [shuffled[60], shuffled[3]]; }
  check(shuffled.length === 64 && outOfOrder(shuffled).length > 0,
    'while exchanging two of the sixty-four is found, so the row above is a test rather than '
    + 'a statement',
    `${outOfOrder(shuffled).length} descents once entries 3 and 60 are swapped`);
}

console.log('\n[registry] and the band is counted in the pixels the buffer actually has');
{
  const unit = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    const base = { ...${JSON.stringify(GLYPH_LOOK)}, 'glyph.hash': 0, 'glyph.tone': 0, 'glyph.rain': 0 };
    const wall = plane(2400);
    const bg = field({ look: base, depth: empty() }).slice();
    const at = async (over, cropOutside = null) => {
      const px = field({ look: { ...base, ...over }, depth: wall, cropOutside });
      return { hash: await sha256(px), levels: levels(px, bg), ...above(px, bg) };
    };
    // The three keys raised together, for the two rows that ask whether a key can reach a
    // pixel at all. Which characters they choose does not matter to either row - only that
    // the answer is a different picture where the mark is a character and the same picture
    // where it is a splat.
    const LOUD = { 'glyph.hash': 1, 'glyph.tone': 0.7 };
    // Every point outside the box, by the depth pair rather than by a lateral face: the wall
    // is at 2.4m and the far face is at 1.0, so the whole frame is cut away and the faint
    // pass is what keeps it on screen to be measured.
    const CUT = { cell: 0.25, crop: true, near: 0.5, far: 1.0 };
    return {
      // 0.25m: 24 framebuffer pixels, 72 reference. Above the band on both readings, so
      // the mark is a hard bit whichever one the shader takes - this is the arm that says
      // the statistic can read a one.
      above: await at({ cell: 0.25 }),
      // 0.125m: 12 framebuffer pixels, 36 reference. The two readings disagree here.
      inside: await at({ cell: 0.125 }),
      // The crop's own half, and it is a different claim from the two above rather than a
      // third reading of theirs: a cut-away point is scaffolding, so it draws the round mask
      // whatever size it came out at. Both arms are the same geometry at the same cell with
      // the keys down and up.
      croppedQuiet: await at(CUT, 0.6),
      croppedLoud: await at({ ...CUT, ...LOUD }, 0.6),
      // The control, which is that same pair with nothing cut away. Without it the equality
      // above would pass on a page where the keys reach nothing anywhere.
      wholeQuiet: await at({ cell: 0.25 }),
      wholeLoud: await at({ cell: 0.25, ...LOUD }),
    };
  })()`);

  check(unit.above.lit > 0.005 && unit.inside.lit > 0.005 && unit.croppedQuiet.painted > 500,
    'all three arms draw their marks, so the counts below are taken on pictures',
    `above ${(100 * unit.above.lit).toFixed(2)}% inked, inside `
    + `${(100 * unit.inside.lit).toFixed(2)}%, cut away ${unit.croppedQuiet.painted}px painted`);

  // The reference the other two rows are read against: a hard bit is one colour, so an arm
  // that stops reading one has stopped meaning what those rows take it to mean.
  check(unit.above.levels === 1,
    'a cell well above the band on both readings paints exactly one colour, so the mark is '
    + 'a hard bit and the count can say so',
    `${unit.above.levels} distinct colours`);

  check(unit.inside.levels > 1,
    'a cell inside the band in framebuffer pixels and above it in reference pixels is a '
    + 'blend, so the crossfade is counted in the pixels the buffer has',
    `${unit.inside.levels} distinct colours at 12 framebuffer pixels against `
    + `${unit.above.levels} at 24`);

  check(unit.croppedQuiet.hash === unit.croppedLoud.hash,
    'a cut-away cell draws the round mask, so the three keys reach no pixel inside the crop '
    + 'and cut geometry reads as dust rather than as smaller text',
    unit.croppedQuiet.hash === unit.croppedLoud.hash
      ? `both ${unit.croppedQuiet.hash.slice(0, 12)} with the keys down and up, over `
        + `${unit.croppedQuiet.painted}px painted`
      : `${unit.croppedQuiet.hash.slice(0, 12)} against ${unit.croppedLoud.hash.slice(0, 12)} - `
        + 'the crop is still drawing characters');

  check(unit.wholeQuiet.hash !== unit.wholeLoud.hash,
    'while the same two key settings on the same cell outside no crop do draw different '
    + 'characters, so the equality above is not a fixture the keys cannot move',
    unit.wholeQuiet.hash === unit.wholeLoud.hash
      ? `identical uncropped too, ${unit.wholeQuiet.hash.slice(0, 12)} - the keys reached nothing`
      : `${unit.wholeQuiet.hash.slice(0, 12)} against ${unit.wholeLoud.hash.slice(0, 12)}`);
}

console.log('\n[registry] and above 1080 the same band is counted in the look\'s own pixels');
{
  const wide = await openPage({ viewportSize: { width: 3840, height: 2380 } });
  const over = await wide.page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    const base = { ...${JSON.stringify(GLYPH_LOOK)}, 'glyph.hash': 0, 'glyph.tone': 0, 'glyph.rain': 0 };
    const wall = plane(2400);
    const bg = field({ look: base, depth: empty() }).slice();
    const gl = k.renderer.getContext();
    const buffer = [gl.drawingBufferWidth, gl.drawingBufferHeight];
    const scale = buffer[1] / 1080;
    // The projection's own cotangent rather than a baked fifty degrees, and the view
    // distance is the pinned pose's: the camera sits at z = +1.6 and the wall at z = -2.4.
    const p11 = k.freeCamera.projectionMatrix.elements[5];
    const readings = (cell) => {
      const reference = (cell * p11 * 540) / 4.0;
      return { cell, reference, drawn: reference * scale };
    };
    const at = async (cell, keys) => {
      const px = field({ look: { ...base, cell, ...keys }, depth: wall });
      return { hash: await sha256(px), ...above(px, bg) };
    };
    const LOUD = { 'glyph.hash': 1, 'glyph.tone': 0.7 };
    return {
      buffer,
      scale,
      small: readings(0.02),
      large: readings(0.09),
      smallQuiet: await at(0.02, {}),
      smallLoud: await at(0.02, LOUD),
      largeQuiet: await at(0.09, {}),
      largeLoud: await at(0.09, LOUD),
    };
  })()`);

  console.log(`  buffer ${over.buffer.join('x')}, scale ${over.scale.toFixed(3)}: the 2cm cell `
    + `rasterises into ${over.small.drawn.toFixed(1)} framebuffer pixels and measures `
    + `${over.small.reference.toFixed(1)} reference ones; the 9cm cell `
    + `${over.large.drawn.toFixed(1)} and ${over.large.reference.toFixed(1)}`);

  check(over.scale > 1.5 && over.small.drawn > 8 && over.small.reference < 8
    && over.smallQuiet.lit > 0.002,
    'the arm stands where the two readings disagree - above 1080, with the cell inside the '
    + 'band in framebuffer pixels and below it in reference pixels',
    `scale ${over.scale.toFixed(3)}, drawn ${over.small.drawn.toFixed(1)}, reference `
    + `${over.small.reference.toFixed(1)}, ${(100 * over.smallQuiet.lit).toFixed(2)}% inked`);

  check(over.smallQuiet.hash === over.smallLoud.hash,
    'a cell under the band in reference pixels draws no character above 1080 either, so the '
    + 'smaller of the two readings governs and the boundary between text and texture is a '
    + 'property of the look rather than of the output size',
    over.smallQuiet.hash === over.smallLoud.hash
      ? `both ${over.smallQuiet.hash.slice(0, 12)} with the keys down and up`
      : `${over.smallQuiet.hash.slice(0, 12)} against ${over.smallLoud.hash.slice(0, 12)} - the `
        + 'keys are choosing a character the look asked not to draw');

  check(over.largeQuiet.hash !== over.largeLoud.hash,
    'while at a cell above the band on both readings the same two settings do draw different '
    + 'characters, so the equality above is not a page where the keys reach nothing',
    `${over.largeQuiet.hash.slice(0, 12)} against ${over.largeLoud.hash.slice(0, 12)} at `
    + `${over.large.drawn.toFixed(0)} framebuffer pixels`);

  check(wide.errors.length === 0, 'and the wide page logged no errors',
    wide.errors.slice(0, 2).join('; '));
  await wide.page.close();
}

console.log('\n[registry] and the margin around a character is not a surface');
{
  const occl = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    // The keys are all down on purpose, so every cell draws index 0 - the sparsest
    // character in a table sorted by ink, and therefore the largest margin the alphabet
    // has. The dense arm below is the same geometry with the hash key up, which is what
    // measures how much of the box the sparse mark is leaving empty.
    //
    // **The two depths and the cell size are one choice with two ends to it**, because the
    // legibility crossfade is now in framebuffer pixels and the two surfaces want opposite
    // sides of its band. A camera at z = +1.6 puts 1.2m at a view distance of 2.8m and 4.0m
    // at 5.6m, and a 0.15m cell rasterises into about 21 pixels at the first and 10 at the
    // second. The near number has to clear 16, where the crossfade is exactly 1: there the
    // mark is a hard bit, an off bit's alpha is exactly zero rather than nearly zero, and
    // the whole square is either ink or nothing. The far number wants to be well under it,
    // where the mark is mostly the round splat it falls back to, because a far surface that
    // also drew sparse characters would be 1.5% of the frame - almost nothing to hide, and
    // the section would be asking its question of a nearly empty room. Measured while
    // getting this wrong: at the shared 0.25m cell both surfaces sat above the band and the
    // population fell from 5881 pixels to 291.
    const look = { ...${JSON.stringify(GLYPH_LOOK)},
      cell: 0.15, near: 0.5, far: 4.5, 'glyph.hash': 0, 'glyph.tone': 0, 'glyph.rain': 0 };
    const { both, near, far } = twoSurfaces(1200, 4000, 16);
    const bg = field({ look, depth: empty() }).slice();
    const C = field({ look, depth: both }).slice();
    const F = field({ look, depth: far }).slice();
    const N = field({ look, depth: near }).slice();
    const D = field({ look: { ...look, 'glyph.hash': 1 }, depth: near }).slice();
    let population = 0, atRisk = 0, moved = 0, movedAtRisk = 0, nearInk = 0, farLit = 0;
    for (let i = 0; i < C.length; i += 4) {
      if (drew(N, bg, i)) { nearInk++; continue; }
      if (!drew(F, bg, i)) continue;
      farLit++;
      population++;
      const inBox = drew(D, bg, i);
      if (inBox) atRisk++;
      if (C[i] !== F[i] || C[i + 1] !== F[i + 1] || C[i + 2] !== F[i + 2]) {
        moved++;
        if (inBox) movedAtRisk++;
      }
    }
    const n = C.length / 4;
    return { population, atRisk, moved, movedAtRisk, nearInk, farLit, n,
      sparse: above(N, bg), dense: above(D, bg), combined: above(C, bg), farOnly: above(F, bg) };
  })()`);

  check(occl.farOnly.lit > 0.1 && occl.sparse.lit > 0.002,
    'both surfaces render, so the rows below are comparing pictures rather than black',
    `the far surface alone inks ${(100 * occl.farOnly.lit).toFixed(2)}% of the frame and the `
    + `near marks ${(100 * occl.sparse.lit).toFixed(2)}%`);

  check(occl.atRisk > 2000 && occl.dense.painted > occl.sparse.painted * 4,
    'and the sparse mark leaves most of its own box empty with the far surface showing '
    + 'through it, so there is something for a margin to hide',
    `${occl.atRisk} pixels of far surface sit inside a near sprite with no near mark on them, `
    + `out of ${occl.population} the near cloud left alone; the same cells at a hash of 1 `
    + `paint ${occl.dense.painted}px against ${occl.sparse.painted}px`);

  check(occl.moved === 0,
    'every pixel the near marks did not draw on is the far surface untouched, so a character '
    + 'occludes with its ink and not with its box',
    occl.moved === 0
      ? `0 of ${occl.population} pixels moved, ${occl.atRisk} of them inside a near sprite`
      : `${occl.moved} of ${occl.population} pixels moved without a near mark on them, `
        + `${occl.movedAtRisk} of those inside a near sprite - the margin is writing depth`);
}

console.log('\n[registry] and a point that has not faded in yet is not a surface either');
{
  const born = await openPage();
  const occl = await born.page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    const W = 512, H = 424, N = W * H;
    // The same interleave the section above uses and for the same reason: a near sprite only
    // hides a far point the driver reaches after it, and a block of near texels would leave
    // that dependent on which side of the block the far rows sat.
    const mask = (withNear) => {
      const a = new Uint16Array(N);
      for (let r = 0; r < H; r++) {
        for (let c = 0; c < W; c++) {
          const near = r % 16 === 0 && c % 16 === 0;
          a[r * W + c] = near ? (withNear ? 1200 : 0) : 4000;
        }
      }
      return a;
    };
    // The pinned wire shape, which is the one \`PinnedPairSource\` parses: depth byte count,
    // colour byte count, the capture stamp, then the depth. A hundred milliseconds apart, so
    // the far surface's age clears the fade window below with room to spare.
    const pack = (grids) => {
      const per = 16 + N * 2;
      const buf = new ArrayBuffer(per * grids.length);
      const view = new DataView(buf);
      grids.forEach((g, i) => {
        view.setUint32(i * per, N * 2, true);
        view.setUint32(i * per + 4, 0, true);
        view.setBigUint64(i * per + 8, BigInt(i * 100), true);
        new Uint16Array(buf, i * per + 16, N).set(g);
      });
      return buf;
    };
    const far = mask(false);
    const both = mask(true);
    const none = new Uint16Array(N);
    // No characters anywhere: this is the older half of the class and it belongs to looks
    // that draw no glyph at all, so a fixture drawing them would be asking the question the
    // section above already answers.
    const look = { additive: false, denoise: false, wake: 0, opacity: 1, exposure: 1,
      pointSize: 64, 'lattice.amount': 1, cell: 0.15, 'glyph.amount': 0, 'rain.amount': 0,
      interpolate: false, readRgb: 0, readDepth: 1, 'ghost.amount': 0, 'contour.amount': 0,
      'blackwall.amount': 0, near: 0.5, far: 4.5 };
    const shot = (grids, fade) => {
      const times = k.drive.pin(pack(grids));
      k.params.reset();
      k.params.apply({ ...look, fade });
      k.drive.reset();
      pinCamera(k.freeCamera);
      k.drive.stepTo(times[1]);
      return { px: k.drive.readPixels().slice(), since: k.uniforms.sinceFrameSec.value };
    };
    // This renderer does not clear to black, so every "is anything lit here" reading taken
    // against zero comes back saying the whole frame is lit. Each arm is read against a frame
    // of the same fixture with no depth in it at all.
    const bg = shot([none, none, none], 60).px;
    const F = shot([far, far, far], 60);
    const C = shot([far, far, both], 60);
    // The same pair with no fade window, which is what says the near cloud is present and
    // held at zero alpha rather than simply absent - without it the equality below would be
    // satisfied perfectly by a plant that failed.
    const Flit = shot([far, far, far], 0).px;
    const Clit = shot([far, far, both], 0).px;
    const drew = (px, i) => px[i] !== bg[i] || px[i + 1] !== bg[i + 1] || px[i + 2] !== bg[i + 2];
    const lit = (px) => { let n = 0; for (let i = 0; i < px.length; i += 4) if (drew(px, i)) n++; return n / (px.length / 4); };
    let moved = 0, atRisk = 0, movedAtRisk = 0;
    for (let i = 0; i < C.px.length; i += 4) {
      const inSprite = Clit[i] !== Flit[i] || Clit[i + 1] !== Flit[i + 1] || Clit[i + 2] !== Flit[i + 2];
      if (inSprite && drew(F.px, i)) atRisk++;
      if (C.px[i] !== F.px[i] || C.px[i + 1] !== F.px[i + 1]
        || C.px[i + 2] !== F.px[i + 2] || C.px[i + 3] !== F.px[i + 3]) {
        moved++;
        if (inSprite) movedAtRisk++;
      }
    }
    return { moved, atRisk, movedAtRisk, since: C.since, sinceFar: F.since,
      pixels: C.px.length / 4, farLit: lit(F.px), combinedLit: lit(C.px),
      farPaint: lit(Flit), nearPaint: lit(Clit) };
  })()`);

  check(occl.farLit > 0.02 && occl.nearPaint > occl.farPaint * 1.2,
    'the far surface renders and the near cloud is really in front of it, so the equality '
    + 'below is comparing pictures rather than two empty frames',
    `the far surface inks ${(100 * occl.farLit).toFixed(2)}% of the frame, and with the fade `
    + `window off the same pair inks ${(100 * occl.nearPaint).toFixed(2)}% against the far `
    + `surface's ${(100 * occl.farPaint).toFixed(2)}%`);

  check(occl.since === 0 && occl.atRisk > 300,
    'and the near cloud is at zero alpha because its points were born on this frame, with lit '
    + 'far surface behind them, so there is something for an invisible sprite to hide',
    `sinceFrameSec ${occl.since} at the plant and ${occl.sinceFar} on the far-only arm; `
    + `${occl.atRisk} pixels of lit far surface sit inside a near sprite's footprint`);

  check(occl.moved === 0,
    'and the frame with the newborn cloud in it is the frame without it, byte for byte, so a '
    + 'point that has not faded in yet occludes nothing',
    occl.moved === 0
      ? `0 of ${occl.pixels} pixels moved, ${occl.atRisk} of them behind a newborn sprite`
      : `${occl.moved} of ${occl.pixels} pixels moved, ${occl.movedAtRisk} of those behind a `
        + `newborn sprite - a point at zero alpha is writing depth`);

  check(born.errors.length === 0, 'and the page it ran on logged no errors',
    born.errors.slice(0, 2).join('; '));
  await born.page.close();
}

console.log('\n[registry] the rain falls, and its afterglow is above the head');
{
  const trail = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    // The span is wide and the trail long so that exactly one head is inside the planted
    // slab: a column carrying three of them has no unambiguous peak to measure either side
    // of. Round splats and no lattice, because the rain is a colour term that works over
    // dots and this section is not about characters.
    const look = { additive: false, denoise: false, fade: 0, wake: 0, opacity: 1, exposure: 1,
      pointSize: 12, 'lattice.amount': 0, cell: 0.5, 'glyph.amount': 0,
      readRgb: 0, readDepth: 1, 'ghost.amount': 0, 'contour.amount': 0,
      'blackwall.amount': 0, near: 0.5, far: 4,
      'rain.amount': 0.9, 'rain.speed': 0.55, 'rain.span': 4, 'rain.trail': 1.2 };
    const strip = column(2400, 30);
    const off = field({ look: { ...look, 'rain.amount': 0 }, depth: strip }).slice();
    // The lift is read as a ratio against the same column with the rain down, so the base
    // picture divides out and what is left is the term itself.
    let lo = 360, hi = -1;
    for (let y = 0; y < 360; y++) {
      let n = 0;
      for (let x = 0; x < 640; x++) {
        const i = (y * 640 + x) * 4;
        if (off[i] + off[i + 1] + off[i + 2] > 30) n++;
      }
      if (n > 20) { if (y < lo) lo = y; if (y > hi) hi = y; }
    }
    const profileAt = (rainPhase) => {
      const px = field({ look, depth: strip, rainPhase });
      const rows = new Array(360).fill(null);
      for (let y = lo; y <= hi; y++) {
        let sum = 0, n = 0;
        for (let x = 0; x < 640; x++) {
          const i = (y * 640 + x) * 4;
          const base = off[i] + off[i + 1] + off[i + 2];
          if (base > 30) { sum += Math.max(0, (px[i] + px[i + 1] + px[i + 2]) - base) / base; n++; }
        }
        if (n > 20) rows[y] = sum / n;
      }
      return rows;
    };
    const middle = (lo + hi) / 2;
    const window = Math.floor((hi - lo) / 6);
    let best = null;
    for (let rainPhase = 0; rainPhase < 8; rainPhase += 0.5) {
      const rows = profileAt(rainPhase);
      let head = -1, lift = -1;
      for (let y = lo; y <= hi; y++) if (rows[y] !== null && rows[y] > lift) { lift = rows[y]; head = y; }
      if (head - window < lo || head + window > hi) continue;
      if (best === null || Math.abs(head - middle) < Math.abs(best.head - middle)) {
        const mean = (from, to) => {
          let sum = 0, n = 0;
          for (let y = from; y <= to; y++) if (rows[y] !== null) { sum += rows[y]; n++; }
          return n ? sum / n : 0;
        };
        best = { rainPhase, head, lift,
          aboveHead: mean(head + 3, head + window), belowHead: mean(head - window, head - 3) };
      }
    }
    // The head found again at three further phases, for the descent row. The step is a
    // choice about this fixture rather than a round number: the column stands 2.4m from
    // the sensor and so 4.0m from the camera, where a metre of room is about 96
    // framebuffer rows, and a phase step of 0.5 moves a head 0.55 * 0.5 metres - about 27
    // rows, which is far enough to be unambiguous against a profile sampled per row and
    // near enough that four samples stay inside a column 267 rows tall. The span is 4m and
    // the strip holds under 3, so there is one head to follow and no second one arriving
    // from above to be mistaken for it.
    const descent = [];
    if (best !== null) {
      for (const step of [0, 0.5, 1.0, 1.5]) {
        const rows = profileAt(best.rainPhase + step);
        let head = -1, lift = -1;
        for (let y = lo; y <= hi; y++) if (rows[y] !== null && rows[y] > lift) { lift = rows[y]; head = y; }
        descent.push({ step, head, lift });
      }
    }
    return { lo, hi, window, best, descent, rows: hi - lo + 1 };
  })()`);

  check(trail.best !== null && trail.best.lift > 0.05,
    'the planted column carries a drop, so the two readings below are of a wave rather than '
    + 'of a flat picture',
    trail.best
      ? `${trail.rows} rows of column, head at row ${trail.best.head} at phase `
        + `${trail.best.rainPhase}, lifting ${trail.best.lift.toFixed(3)} of the base there`
      : `no phase in the sweep put a head clear of the ends of a ${trail.rows}-row column`);

  const dir = trail.best ?? { aboveHead: 0, belowHead: 0, head: -1, window: 0 };
  check(trail.best !== null && dir.aboveHead > dir.belowHead * 4 + 0.05,
    'and the afterglow is above the head rather than below it',
    `mean lift ${dir.aboveHead.toFixed(4)} over the ${trail.window} rows above the head, `
    + `${dir.belowHead.toFixed(4)} over the ${trail.window} below`);

  const walk = trail.descent ?? [];
  const inside = walk.filter((s) => s.head > trail.lo && s.head < trail.hi && s.lift > 0.05);
  check(walk.length === 4 && inside.length === 4,
    'the head stays inside the planted column across the whole walk, so the row below is '
    + 'reading a head rather than an end of the strip',
    walk.length
      ? walk.map((s) => `+${s.step}: row ${s.head} lifting ${s.lift.toFixed(3)}`).join(', ')
        + ` in rows ${trail.lo}..${trail.hi}`
      : 'no phase in the sweep put a head clear of the ends of the column');
  const climbs = walk.filter((s, i) => i > 0 && s.head >= walk[i - 1].head);
  check(walk.length === 4 && climbs.length === 0,
    'and the head is lower in the room at every later phase, so the wave falls',
    walk.length
      ? `rows ${walk.map((s) => s.head).join(' -> ')} at phases `
        + `${walk.map((s) => (trail.best.rainPhase + s.step).toFixed(2)).join(', ')}`
        + ` (${((walk[0].head - walk[3].head) / 1.5).toFixed(1)} rows per unit of phase, downward)`
      : 'no walk was taken');
}

console.log('\n[registry] and the rain\'s head gap is metres of room, not the link\'s frame gap');
{
  const link = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    const look = { additive: false, denoise: false, fade: 0, wake: 0, opacity: 1, exposure: 1,
      pointSize: 12, 'lattice.amount': 0, cell: 0.5, 'glyph.amount': 0,
      readRgb: 0, readDepth: 1, 'ghost.amount': 0, 'contour.amount': 0,
      'blackwall.amount': 0, near: 0.5, far: 4,
      'rain.amount': 0.9, 'rain.speed': 0.55, 'rain.span': 1.3, 'rain.trail': 0.45 };
    const wall = plane(2400);
    const bg = field({ look, depth: empty() }).slice();
    const at = async (spanSec, span) => {
      const px = field({ look: { ...look, 'rain.span': span }, depth: wall, spanSec, rainPhase: 7 });
      return { hash: await sha256(px), ...above(px, bg) };
    };
    return {
      nominal: await at(1 / 30, 1.3),
      degraded: await at(1 / 9, 1.3),
      widened: await at(1 / 30, 2.6),
    };
  })()`);

  check(link.nominal.lit > 0.05,
    'the wall renders with the rain on it, so the equality below is comparing pictures',
    `${(100 * link.nominal.lit).toFixed(2)}% lit, energy ${link.nominal.energy.toFixed(2)}`);

  check(link.nominal.hash === link.degraded.hash,
    'a 30fps link and a 9fps one render the same frame, so the head gap is metres and not frames',
    link.nominal.hash === link.degraded.hash
      ? `both ${link.nominal.hash.slice(0, 12)} at spans of 33ms and 111ms`
      : `${link.nominal.hash.slice(0, 12)} at 33ms against ${link.degraded.hash.slice(0, 12)} at `
        + '111ms - the spacing follows the link');

  check(link.widened.hash !== link.nominal.hash,
    'while doubling the gap at one link speed does move it, so the equality above is not a '
    + 'parameter that reaches nothing',
    `1.3m gives energy ${link.nominal.energy.toFixed(2)}, 2.6m gives ${link.widened.energy.toFixed(2)}`);
}

console.log('\n[registry] a splat\'s energy is its own, whatever size the sprite is');
{
  // The distances are the parameter rather than the point size, because `pointSize` tops out
  // at 64 and the pinned pose is four metres from the plant.
  const DISTANCES = [2.6, 1.9, 0.94, 0.66];
  const sprite = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    // Additive, because the normalisation this is about is on that path alone. The colour
    // reading is the planted 2x2 rather than the depth ramp, for exposure headroom: the
    // dimmest arm spreads one point's energy over a thousand pixels and an eight-bit
    // readback throws away whatever rounds to zero.
    const look = { additive: true, denoise: false, fade: 0, wake: 0, opacity: 1, exposure: 6,
      pointSize: 64, 'lattice.amount': 0, 'glyph.amount': 0, 'rain.amount': 0,
      readRgb: 1, readDepth: 0, 'ghost.amount': 0, 'contour.amount': 0,
      'blackwall.amount': 0, near: 0.5, far: 2.6 };
    const point = oneTexel(2400);
    const rows = [];
    for (const dist of ${JSON.stringify(DISTANCES)}) {
      const pose = { eye: [0, 0, -2.4 + dist], at: [0, 0, -2.4] };
      const bg = field({ look, depth: empty(), ...pose }).slice();
      const px = field({ look, depth: point, ...pose });
      const s = above(px, bg);
      rows.push({ dist, vSize: 64 / dist, energy: s.energy * 640 * 360, peak: s.peak, painted: s.painted });
    }
    return rows;
  })()`);

  const energies = sprite.map((r) => r.energy);
  const spread = Math.max(...energies) / Math.max(1, Math.min(...energies));
  const painted = sprite.map((r) => r.painted);

  check(Math.min(...sprite.map((r) => r.peak)) >= 3 && Math.max(...sprite.map((r) => r.peak)) < 250,
    'every arm draws a sprite and none of them saturates, so the totals below are the shader\'s',
    sprite.map((r) => `vSize ${r.vSize.toFixed(1)}: peak ${r.peak}/255 over ${r.painted}px`).join('; '));

  check(Math.max(...painted) > Math.min(...painted) * 4,
    'and the sprite grows across the arms, so the invariance is over a range rather than over '
    + 'one size four times',
    `${Math.min(...painted)}px to ${Math.max(...painted)}px of footprint`);

  check(spread < 1.15,
    'and one point contributes the same total light at every sprite size, so the '
    + 'normalisation has no floor under it',
    sprite.map((r) => `vSize ${r.vSize.toFixed(1)}: ${r.energy.toFixed(0)}`).join(', ')
      + ` - spread ${spread.toFixed(3)}`);
}

console.log('\n[registry] the two masters are exactly absent at zero, and so is the cell at lattice 0');
{
  const inert = await page.evaluate(`(async () => {
    ${PAGE_HELPERS}
    ${FIELD_HELPERS}
    const look = { additive: true, denoise: false, fade: 0, wake: 0, opacity: 1, exposure: 1,
      pointSize: 40, 'lattice.amount': 0, cell: 0.15, 'glyph.amount': 0, 'rain.amount': 0,
      readRgb: 0, readDepth: 1, 'ghost.amount': 0, 'contour.amount': 0,
      'blackwall.amount': 0, near: 0.5, far: 4 };
    const wall = plane(2400);
    const bg = field({ look, depth: empty() }).slice();
    const at = async (over) => {
      const px = field({ look: { ...look, ...over }, depth: wall, rainPhase: 7 });
      return { hash: await sha256(px), ...above(px, bg) };
    };
    // Two settings of the three lengths, and two of the three keys, chosen wide apart so
    // that a term leaking by a hundredth still separates them.
    const SLOW = { 'rain.speed': 0.3, 'rain.span': 0.6, 'rain.trail': 0.2 };
    const FAST = { 'rain.speed': 2.4, 'rain.span': 3.4, 'rain.trail': 1.7 };
    const QUIET = { 'glyph.tone': 0, 'glyph.hash': 0, 'glyph.rain': 0 };
    // The rain key sits at exactly 1 rather than near it, which is where a build handing
    // the whole-drop counter to the index raw goes inert - the fraction of an integer is
    // zero. It buys this pair nothing on its own and that is worth saying rather than
    // implying: the two arms here still part company through the other two keys, so the
    // equality would hold either way. What closes the whole-number counter is the
    // rain-key-alone row in the index section, and this value is here so that no reader
    // takes 0.7 for coverage of it.
    const LOUD = { 'glyph.tone': 0.8, 'glyph.hash': 0.9, 'glyph.rain': 1 };
    // **The rain arms raise the glyph master, and that is not incidental.** The vertex
    // stage computes the drop coordinate under a gate naming both masters, so with both of
    // them down the coordinate is zero, the lift collapses to a constant, and the three
    // lengths cannot reach a pixel however leaky the term is - a row asked there is a row
    // that cannot fail. Measured while getting this wrong: with the gate shut the leak
    // control came back green while section 1b reddened on all five readings. With the
    // gate open the lift is a value per point again and a term that is not exactly absent
    // separates the two settings. The rain key stays at zero, or the lengths would reach
    // the character index and the arms would differ on a build with nothing wrong with it.
    const GATED = { 'glyph.amount': 0.6, 'glyph.rain': 0, 'glyph.tone': 0, 'glyph.hash': 1 };
    return {
      rainOffSlow: await at({ 'rain.amount': 0, ...GATED, ...SLOW }),
      rainOffFast: await at({ 'rain.amount': 0, ...GATED, ...FAST }),
      rainOnSlow: await at({ 'rain.amount': 0.8, ...GATED, ...SLOW }),
      rainOnFast: await at({ 'rain.amount': 0.8, ...GATED, ...FAST }),
      glyphOffQuiet: await at({ 'glyph.amount': 0, ...QUIET }),
      glyphOffLoud: await at({ 'glyph.amount': 0, ...LOUD }),
      glyphOnQuiet: await at({ 'glyph.amount': 1, 'lattice.amount': 1, ...QUIET }),
      glyphOnLoud: await at({ 'glyph.amount': 1, 'lattice.amount': 1, ...LOUD }),
      flatFine: await at({ pointSize: 64, cell: 0.005 }),
      flatCoarse: await at({ pointSize: 64, cell: 0.5 }),
      snappedFine: await at({ 'lattice.amount': 0.5, pointSize: 64, cell: 0.005 }),
      snappedCoarse: await at({ 'lattice.amount': 0.5, pointSize: 64, cell: 0.5 }),
    };
  })()`);

  check(inert.rainOffSlow.lit > 0.1,
    'the planted wall renders, so the six equalities below are comparing pictures rather than black',
    `${(100 * inert.rainOffSlow.lit).toFixed(2)}% lit, energy ${inert.rainOffSlow.energy.toFixed(2)}`);

  const pair = (a, b, label, detail) => check(inert[a].hash === inert[b].hash, label,
    inert[a].hash === inert[b].hash ? `both ${inert[a].hash.slice(0, 12)}` : `${detail}: `
      + `${inert[a].hash.slice(0, 12)} against ${inert[b].hash.slice(0, 12)}`);
  const moves = (a, b, label, detail) => check(inert[a].hash !== inert[b].hash, label,
    inert[a].hash === inert[b].hash ? `identical, ${inert[a].hash.slice(0, 12)} - ${detail}`
      : `${inert[a].hash.slice(0, 12)} against ${inert[b].hash.slice(0, 12)}`);

  pair('rainOffSlow', 'rainOffFast',
    'at a rain of 0 the speed, the gap and the trail reach no pixel, so a look with no rain '
    + 'in it draws what it always drew', 'the multiplier is not exactly one');
  moves('rainOnSlow', 'rainOnFast',
    'while raised, those same three lengths do move the picture', 'the lengths reach nothing at all');

  pair('glyphOffQuiet', 'glyphOffLoud',
    'at a glyph of 0 the three keys reach no pixel, so a look drawing no characters draws '
    + 'what it always drew', 'the crossfade is not exactly zero');
  moves('glyphOnQuiet', 'glyphOnLoud',
    'while raised, those same three keys do move the picture', 'the keys reach nothing at all');

  pair('flatFine', 'flatCoarse',
    'at a lattice of 0 the cell size reaches no pixel, so the ten shipped looks that never '
    + 'snap are untouched by the energy compensation', 'the compensation is not exactly one');
  moves('snappedFine', 'snappedCoarse',
    'while with the lattice raised the same two cell sizes do move it',
    'the cell size reaches nothing at all');
}

console.log('\n[registry] every shipped preset draws on a context that renders less than this one');
{
  const { presets: listed } = await (await fetch(`${URL_BASE}/presets`)).json();
  const shipped = listed.filter((p) => p.builtin);

  // Installed before the page's first script: every draw and clear asks whether the framebuffer
  // it lands in can complete. A target allocated anywhere, at a type or a size the context cannot
  // render, is counted by being drawn into rather than by being named here.
  const COUNT_INCOMPLETE = `(() => {
    const seen = { draws: 0, incomplete: 0, statuses: {} };
    globalThis.__incomplete = seen;
    for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
      for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'clear']) {
        const real = C.prototype[name];
        if (!real) continue;
        C.prototype[name] = function (...args) {
          const status = this.checkFramebufferStatus(this.FRAMEBUFFER);
          seen.draws++;
          if (status !== this.FRAMEBUFFER_COMPLETE) {
            seen.incomplete++;
            const key = '0x' + status.toString(16);
            seen.statuses[key] = (seen.statuses[key] ?? 0) + 1;
          }
          return real.apply(this, args);
        };
      }
    }
  })();`;
  const HIDE = (names) => `(() => {
    const hide = new Set(${JSON.stringify(names)});
    for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
      const get = C.prototype.getExtension;
      C.prototype.getExtension = function (n) { return hide.has(n) ? null : get.call(this, n); };
      const list = C.prototype.getSupportedExtensions;
      C.prototype.getSupportedExtensions = function () { return (list.call(this) ?? []).filter((n) => !hide.has(n)); };
    }
  })();`;
  // Firefox's privacy.resistFingerprinting, which LibreWolf ships on: both size limits read 2048
  // and an allocation past them is refused, leaving the attachment with no storage at all. The
  // canvas is not held to it, which is why the direct presets kept drawing.
  const CAP = (cap) => `(() => {
    const cap = ${cap};
    const over = (w, h) => w > cap || h > cap;
    for (const C of [WebGLRenderingContext, WebGL2RenderingContext]) {
      const P = C.prototype;
      const getParameter = P.getParameter;
      P.getParameter = function (p) {
        return p === this.MAX_TEXTURE_SIZE || p === this.MAX_RENDERBUFFER_SIZE ? cap : getParameter.call(this, p);
      };
      const texImage2D = P.texImage2D;
      P.texImage2D = function (...a) { return a.length >= 8 && over(a[3], a[4]) ? undefined : texImage2D.apply(this, a); };
      const texStorage2D = P.texStorage2D;
      if (texStorage2D) P.texStorage2D = function (...a) { return over(a[3], a[4]) ? undefined : texStorage2D.apply(this, a); };
      const storage = P.renderbufferStorage;
      P.renderbufferStorage = function (...a) { return over(a[2], a[3]) ? undefined : storage.apply(this, a); };
      const multisample = P.renderbufferStorageMultisample;
      if (multisample) P.renderbufferStorageMultisample = function (...a) { return over(a[3], a[4]) ? undefined : multisample.apply(this, a); };
    }
  })();`;

  // The cap arm is the reporter's and comes first. Its stage is wide enough at a pixel ratio of 2
  // that an unclamped buffer passes 2048, or the clamp would be proved on a buffer already under it.
  // The last two arms differ in one extension each, and they are where a decision read off
  // extension names instead of off a framebuffer comes apart: Firefox renders half-float through
  // EXT_color_buffer_float and never lists EXT_color_buffer_half_float.
  const ARMS = [
    {
      name: 'a 2048 texture cap', script: CAP(2048), dpr: 2, viewport: { width: 1400, height: 800 },
      cap: 2048, want: { maxSize: 2048, chain: 'half', memory: 'float' }, line: null, every: true,
    },
    {
      name: 'neither colour-buffer extension',
      script: HIDE(['EXT_color_buffer_float', 'EXT_color_buffer_half_float']), dpr: 1, viewport: VIEW,
      want: { chain: 'byte', memory: null }, line: /ghost and wake are off, and trails, bloom and the grade run at 8 bits/, every: true,
    },
    {
      name: 'no EXT_color_buffer_float', script: HIDE(['EXT_color_buffer_float']), dpr: 1, viewport: VIEW,
      want: { chain: 'half', memory: 'half' }, line: null, every: false,
    },
    {
      name: 'no EXT_color_buffer_half_float, as Firefox lists it',
      script: HIDE(['EXT_color_buffer_half_float']), dpr: 1, viewport: VIEW,
      want: { chain: 'half', memory: 'float' }, line: null, every: false,
    },
  ];
  // The two a narrower arm renders: one through the post chain and one that reads the memory.
  const SAMPLED = ['blackwall', 'ghost'];

  for (const arm of ARMS) {
    const within = await browser.newContext({ viewport: arm.viewport, deviceScaleFactor: arm.dpr });
    await within.addInitScript(arm.script + COUNT_INCOMPLETE);
    const opened = await openPage({ pin: true, viewportSize: arm.viewport, within });
    const armPage = opened.page;
    const decided = await armPage.evaluate(`(async () => {
      const k = globalThis.__kinect;
      k.drive.pin(await (await fetch('/__pinned.bin')).arrayBuffer());
      const stage = k.renderer.domElement.getBoundingClientRect();
      const line = document.getElementById('tGpu');
      return {
        caps: k.renderCaps(),
        wanted: Math.max(stage.width, stage.height) * Math.min(devicePixelRatio, 2),
        line: line && !line.hidden ? line.textContent : '',
      };
    })()`);
    const got = { maxSize: decided.caps.maxSize, chain: decided.caps.chain, memory: decided.caps.memory };
    const wrong = Object.keys(arm.want).filter((key) => got[key] !== arm.want[key]);
    check(wrong.length === 0, `under ${arm.name} the page decides what the context renders`,
      `${show(got)}${wrong.length ? ` against ${show(arm.want)}` : ''}`);
    if (arm.cap) {
      const biggest = Math.max(...decided.caps.buffer, ...decided.caps.chainSize.map(Math.floor));
      check(decided.wanted > arm.cap && biggest <= arm.cap,
        'and the stage asks for more than the cap, so the buffer and the chain are held to it',
        `asked ${decided.wanted.toFixed(0)}, buffer ${decided.caps.buffer.join('x')}, `
          + `chain ${decided.caps.chainSize.map(Math.floor).join('x')}`);
    }

    for (const preset of shipped.filter((p) => arm.every || SAMPLED.includes(p.name))) {
      // A black canvas reads zero everywhere, where the scene's own background alone reads ten.
      const drawn = await armPage.evaluate(`(() => {
        const k = globalThis.__kinect;
        k.params.reset();
        k.applyPreset(${JSON.stringify(preset.body.values)});
        k.drive.reset();
        k.freeCamera.position.set(0, 0.1, 1.6);
        k.freeCamera.lookAt(0, 0, -2.2);
        k.freeCamera.updateMatrixWorld(true);
        k.drive.stepTo(0.2);
        k.drive.stepTo(0.4);
        const px = k.drive.readPixels();
        let lit = 0;
        for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 1], px[i + 2]) > 16) lit++;
        return {
          lit: lit / (px.length / 4),
          post: k.bloom.enabled || k.afterimage.enabled || k.mosh.enabled || k.grade.enabled,
        };
      })()`);
      check(drawn.lit > 0.001, `${preset.name} draws under ${arm.name}`,
        `${(100 * drawn.lit).toFixed(2)}% lit, ${drawn.post ? 'through the post chain' : 'straight to the canvas'}`);
    }

    if (arm.cap) {
      // The OBS source at a 4K setting, which has no bar to say anything: it draws the whole shot
      // smaller rather than a black frame.
      const source = await openPage({ pin: true, viewportSize: arm.viewport, within, at: '/program' });
      const drawn = await source.page.evaluate(`(async () => {
        const k = globalThis.__kinect;
        k.drive.pin(await (await fetch('/__pinned.bin')).arrayBuffer());
        k.applyProgramOut({ size: { w: 3840, h: 2160 } });
        k.applyPreset(${JSON.stringify(shipped.find((p) => p.name === 'blackwall').body.values)});
        k.drive.reset();
        k.drive.stepTo(0.2);
        k.drive.stepTo(0.4);
        const px = k.drive.readPixels();
        let lit = 0;
        for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 1], px[i + 2]) > 16) lit++;
        return {
          lit: lit / (px.length / 4),
          buffer: k.renderCaps().buffer,
          source: document.body.classList.contains('program-out'),
          incomplete: globalThis.__incomplete.incomplete,
        };
      })()`);
      check(drawn.source && drawn.lit > 0.001 && drawn.incomplete === 0 && Math.max(...drawn.buffer) <= arm.cap
        && Math.abs(drawn.buffer[0] / drawn.buffer[1] - 16 / 9) < 0.01,
      `and /program set to 3840x2160 draws Blackwall under ${arm.name}, scaled whole to fit`,
      `${(100 * drawn.lit).toFixed(2)}% lit, buffer ${drawn.buffer.join('x')}, `
        + `${drawn.incomplete} draws into an incomplete framebuffer${drawn.source ? '' : ', not the source page'}`);
      await source.page.close();
    }

    const counted = await armPage.evaluate('globalThis.__incomplete');
    check(counted.draws > 0 && counted.incomplete === 0,
      `and no draw under ${arm.name} lands in a framebuffer that cannot complete`,
      `${counted.incomplete} of ${counted.draws}${counted.incomplete ? ` ${show(counted.statuses)}` : ''}`);
    check(arm.line ? arm.line.test(decided.line) : decided.line === '',
      arm.line ? 'and the page says what it cannot draw' : 'and the page says nothing, because it draws everything',
      show(decided.line));
    if (opened.errors.length) {
      check(false, `and the page under ${arm.name} reported no error`, opened.errors.slice(0, 2).join(' | '));
    }
    await within.close();
  }
}

if (main.errors.length) {
  console.log(`\n[registry] page errors:\n  ${main.errors.join('\n  ')}`);
  failures++;
}

await browser.close();

if (MUTATE) {
  // Three outcomes, three exit codes, because two of them are routinely confused: a mutation
  // that failed to compile, or a page that died, is not a mutation that was caught. Read which
  // rows fired rather than how many.
  const caught = failures > 0;
  console.log(`\n[registry] mutation ${MUTATE} ${caught
    ? `caught, as required (${failures} assertions fired)`
    : 'NOT CAUGHT'}`);
  console.log(`           it should redden: ${MUTATIONS[MUTATE].fails}`);
  process.exit(caught ? 0 : 1);
}

console.log(`\n[registry] ${failures ? `FAIL (${failures})` : 'PASS'}`);
process.exit(failures ? 1 : 0);
