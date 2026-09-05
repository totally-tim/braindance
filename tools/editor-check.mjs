// Proves the editor's interaction layer: that its controls exist, that pressing them changes
// something, and that the set of controls it has is the set this file knows how to drive.

import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { CLIP_CEILING, PROJECT_VERSION } from '../web/format.js';
// The server's own validator, imported rather than re-stated: `validateExport` is what both the
// socket's `begin` and `POST /jobs` call, so a list of codec names retyped here would be a third
// copy that can drift from both.
import { validateExport } from '../server/export.js';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback;
};

const REPO = fileURLToPath(new URL('..', import.meta.url));
// Section 9 writes preset files and catches a download. Outside the repo, because a proof tool
// that writes into its own subject makes every later run untrustworthy.
const TMP = mkdtempSync(join(tmpdir(), 'editor-check-'));
const URL_BASE = flag('--url', 'http://localhost:8080');
const EDITOR_PATH = '/edit';
// `sample` rather than a dated take id, because the default has to name something that can exist
// on a machine that is not this one - a recorder-issued id resolves only on the machine that
// recorded it, on that date.
const TAKE = flag('--take', 'sample');
const HEADED = argv.includes('--headed');
const MUTATE = flag('--mutate');
const NO_RENDER = argv.includes('--no-render');
// The window every layout row is measured at. 1512 is the laptop this is documented to run on; the
// other two are there because one width cannot tell a bar that fits from a bar that happens to fit.
const WIDTHS = [1512, 1280, 1100];
const VIEWPORT = { width: 1512, height: 900 };

// ------------------------------------------------------------------- mutations

const MUTATIONS = {
  // ---- section 22, the orbit pivot and the depth under the pointer ----
  // Must redden: the on-axis row, which is the whole reason this can hang off a plain press.
  'pick-moves-the-camera': {
    file: 'web/main.js',
    edits: [[
      '  freeCamera.getWorldDirection(pivotForward);\n'
      + '  controls.target.copy(freeCamera.position).addScaledVector(pivotForward, d);',
      '  freeCamera.getWorldDirection(pivotForward);\n'
      + '  controls.target.copy(freeCamera.position).addScaledVector(pivotForward, d);\n'
      + '  controls.target.x += 0.35;',
    ]],
  },

  // Must redden: the cropped-press row, alone. The pivot then lands on geometry the renderer
  // threw away, which is a pivot on something nobody can see.
  'pick-ignores-the-crop': {
    file: 'web/depth-pick.js',
    edits: [['      if (croppedOut(scratch.x, scratch.y, z)) continue;\n', '']],
  },

  // Must redden: the Reset row, alone. `saveState` re-homes Reset on the picked pivot, so the one
  // control for getting un-lost stops going anywhere known.
  'pick-rehomes-reset': {
    file: 'web/main.js',
    edits: [[
      '  controls.target.copy(freeCamera.position).addScaledVector(pivotForward, d);\n  return d;',
      '  controls.target.copy(freeCamera.position).addScaledVector(pivotForward, d);\n'
      + '  controls.saveState();\n  return d;',
    ]],
  },

  // Must redden: the empty-press row, alone. A pick that answers on a hole in the returns pivots
  // on nothing, and the plan inset's own presses start moving the pivot too.
  'pick-answers-on-nothing': {
    file: 'web/main.js',
    edits: [[
      '  if (!hit) return;\n  setPivotDistance(hit.distance);',
      '  setPivotDistance(hit ? hit.distance : 2.2);',
    ]],
  },

  // Must redden: the singleton row, alone. One isolated return is sensor noise, not a surface.
  'pick-accepts-a-singleton': {
    file: 'web/depth-pick.js',
    edits: [[
      '  if (cluster === null) return null;',
      '  if (cluster === null) cluster = [0, 0];',
    ]],
  },

  // Must redden: the modified-left row, alone. OrbitControls assigns this press to pan.
  'pick-rehomes-modified-pan': {
    file: 'web/main.js',
    edits: [[
      '  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey\n'
      + '    || e.target !== renderer.domElement) return;',
      '  if (e.button !== 0 || e.target !== renderer.domElement) return;',
    ]],
  },

  // ---- section 24, flying, looking and the lens ----
  // The pivot left behind, so the flight changes the orbit's radius instead of the standpoint.
  'fly-leaves-the-pivot': {
    file: 'web/main.js',
    edits: [[
      '  freeCamera.position.add(flyMove);\n'
      + '  // The pivot travels with the camera. `update()` rebuilds the position out of the target, so\n'
      + '  // moving the camera alone would change the orbit\'s radius instead of where you are standing.\n'
      + '  controls.target.add(flyMove);',
      '  freeCamera.position.add(flyMove);',
    ]],
    fails: 'the pivot flies with it, so what moves is the standpoint and not the orbit\'s radius',
    mustFail: 'the pivot flies with it, so what moves is the standpoint and not the orbit\'s radius',
  },

  // Q and E off the camera's own vertical rather than the room's, which is right only while the
  // camera is level and wrong the moment anything is being looked down at.
  'fly-up-is-the-cameras-up': {
    file: 'web/fly.js',
    edits: [[
      '    if (push.pole) out.addScaledVector(flyAxis.copy(up).normalize(), push.pole);',
      '    if (push.pole) out.addScaledVector(flyAxis.set(0, 1, 0).applyQuaternion(quaternion), push.pole);',
    ]],
    fails: 'E climbs the room\'s vertical rather than the camera\'s, however the camera is aimed',
    mustFail: 'E climbs the room\'s vertical rather than the camera\'s, however the camera is aimed',
  },

  // The fly read before the typing guard, so a name with a w in it flies the camera while it is
  // being typed. The shift gate travels with the block, or the row would redden about the gate.
  'fly-moves-while-typing': {
    file: 'web/main.js',
    edits: [
      [
        '  // The recorder\'s viewport orbits the same camera, so this sits above the clip guard below.\n'
        + '  // A repeat is harmless: the set already holds the code. The key is recorded whether or not\n'
        + '  // shift is down, so pressing shift onto a key already held starts the flight rather than\n'
        + '  // waiting for the key to be pressed again; shift is what *takes* the key, so without it the\n'
        + '  // key goes on to whatever else is bound to it.\n'
        + '  if (isFlyKey(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey) {\n'
        + '    changeFlyKeys(() => flyHeld.add(e.code));\n'
        + '    if (e.shiftKey) {\n      e.preventDefault();\n      return;\n    }\n  }\n',
        '',
      ],
      [
        '  changeFlyKeys(() => { flyShift = e.shiftKey; });\n'
        + '  if (controlKeeps(e.target, e.key)) return;',
        '  changeFlyKeys(() => { flyShift = e.shiftKey; });\n'
        + '  if (isFlyKey(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey) {\n'
        + '    changeFlyKeys(() => flyHeld.add(e.code));\n'
        + '    if (e.shiftKey) {\n      e.preventDefault();\n      return;\n    }\n  }\n'
        + '  if (controlKeeps(e.target, e.key)) return;',
      ],
    ],
    fails: 'a fly key does nothing while a text field holds the keyboard',
    mustFail: 'a fly key does nothing while a text field holds the keyboard',
  },

  // The guard back to the tag name, which is the build that shipped: a focused slider swallowed
  // every shortcut in the editor, so a lens nudged by hand left the keyboard dead until
  // something else took the focus back.
  'typing-guard-takes-every-control': {
    file: 'web/main.js',
    edits: [[
      '  if (controlKeeps(e.target, e.key)) return;',
      "  if (e.target instanceof HTMLElement\n"
      + "    && ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;",
    ]],
    fails: 'and a fly key still flies while a slider holds the keyboard, because a slider takes no text',
    mustFail: 'and a fly key still flies while a slider holds the keyboard, because a slider takes no text',
  },

  'typing-guard-takes-adjustment-keys': {
    file: 'web/main.js',
    edits: [['  return SELF_OPERATING_KEYS.has(key);', '  return false;']],
    mustFail: 'control: a focused slider still takes its own arrow key, which is what it is left holding',
  },

  'fly-survives-text-focus': {
    file: 'web/main.js',
    edits: [["document.addEventListener('focusin', (e) => { if (takesText(e.target)) clearFlyKeys(); });\n", '']],
    mustFail: 'focusing a text field stops a flight already in progress',
  },

  // A key released outside the page never arrives, so without this the camera flies for ever.
  'fly-survives-blur': {
    file: 'web/main.js',
    edits: [["addEventListener('blur', clearFlyKeys);\n", '']],
    fails: 'and losing the page releases the key, so a held fly key stops',
    mustFail: 'and losing the page releases the key, so a held fly key stops',
  },

  // The half of the gate that is the program camera, a gizmo drag, a node drag and a crop drag at
  // once. Both terms go, because `lookDrag` on its own still refuses under the program camera and
  // the row would pass on a build with the gate gone.
  'fly-ignores-the-program-camera': {
    file: 'web/main.js',
    edits: [[
      'const flying = () => flyInputActive() && (controls.enabled || lookDrag !== null) && !exporting;',
      'const flying = () => flyInputActive() && !exporting;',
    ]],
    fails: 'and nothing flies under the program camera, whose pose is the document\'s',
    mustFail: 'and nothing flies under the program camera, whose pose is the document\'s',
  },

  // The other half: a look drag turns the orbit off, and it is the one reason for that which must
  // not stop the flight. Without the term, flying while you turn is the one thing the mode is not.
  'fly-stops-during-a-look': {
    file: 'web/main.js',
    edits: [[
      'const flying = () => flyInputActive() && (controls.enabled || lookDrag !== null) && !exporting;',
      'const flying = () => flyInputActive() && controls.enabled && !exporting;',
    ]],
    fails: 'and the flight carries on through a look drag, so you fly the way you are turning',
    mustFail: 'and the flight carries on through a look drag, so you fly the way you are turning',
  },

  // Held keys can cancel exactly. They ask for no movement, so they must not keep the redraw
  // loop alive merely because the set is non-empty.
  'fly-redraws-cancelled-keys': {
    file: 'web/main.js',
    edits: [[
      '  flyShift && flyDirection(flyHeld, freeCamera.quaternion, freeCamera.up, flyMove).lengthSq() > 0\n',
      '  flyShift && flyHeld.size > 0\n',
    ]],
    fails: 'opposite fly keys do not keep the redraw loop alive because their requested move is zero',
    mustFail: 'opposite fly keys do not keep the redraw loop alive because their requested move is zero',
  },

  // The gate itself. Without it the six keys fly bare, which is the whole of what the redesign
  // took away and what the unshifted control below is for.
  'fly-ignores-the-shift-gate': {
    file: 'web/main.js',
    edits: [[
      '  flyShift && flyDirection(flyHeld, freeCamera.quaternion, freeCamera.up, flyMove).lengthSq() > 0',
      '  flyDirection(flyHeld, freeCamera.quaternion, freeCamera.up, flyMove).lengthSq() > 0',
    ]],
    fails: 'control: an unshifted fly key moves nothing at all, which is the gate every row above is held by',
    mustFail: 'control: an unshifted fly key moves nothing at all, which is the gate every row above is held by',
  },

  // The gate keyed on the keydown rather than on the shift state: the key is only recorded while
  // shift is already down, so shift arriving onto a key already held finds an empty set.
  'fly-takes-the-key-only-with-shift': {
    file: 'web/main.js',
    edits: [[
      '  if (isFlyKey(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey) {\n'
      + '    changeFlyKeys(() => flyHeld.add(e.code));\n'
      + '    if (e.shiftKey) {\n      e.preventDefault();\n      return;\n    }\n  }',
      '  if (isFlyKey(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey) {\n'
      + '    if (e.shiftKey) {\n      changeFlyKeys(() => flyHeld.add(e.code));\n'
      + '      e.preventDefault();\n      return;\n    }\n  }',
    ]],
    fails: 'and shift arriving onto a key already held starts the flight',
    mustFail: 'and shift arriving onto a key already held starts the flight',
  },

  // A release and new press can both land between animation frames. Without the event-side reset,
  // the new hold inherits the old hold's clock and takes the stall cap as its first step.
  'fly-reuses-old-clock': {
    file: 'web/main.js',
    edits: [['  if (!wasActive || !flyInputActive()) flyLastAt = 0;\n', '']],
    fails: 'a new hold starts a new clock even when its release and press land between frames',
    mustFail: 'a new hold starts a new clock even when its release and press land between frames',
  },

  // The release never arms the accurate seek, so the flight ends on a draft-quality frame.
  'fly-never-settles': {
    file: 'web/main.js',
    edits: [['  else if (flyWasHeld) orbitSettling = true;\n', '']],
    fails: 'and releasing the last key lands the accurate frame',
    mustFail: 'and releasing the last key lands the accurate frame',
  },

  // Reset re-homed on wherever the flight ended, which is the same defect `pick-rehomes-reset`
  // plants through the pivot: the one control for getting un-lost stops going anywhere known.
  'fly-rehomes-reset': {
    file: 'web/main.js',
    edits: [[
      '  controls.target.add(flyMove);\n}',
      '  controls.target.add(flyMove);\n  controls.saveState();\n}',
    ]],
    fails: 'and Reset still goes home after a flight rather than to wherever the flight ended',
    mustFail: 'and Reset still goes home after a flight rather than to wherever the flight ended',
  },

  // The look written as an orbit about a pivot that happens to be near. The view turns by exactly
  // the same angle and the radius survives, so position is the only reading that can see it.
  'look-orbits-the-camera': {
    file: 'web/main.js',
    edits: [[
      '  controls.target.copy(freeCamera.position).add(lookPivot);',
      '  freeCamera.position.copy(controls.target).sub(lookPivot);',
    ]],
    fails: 'the camera stands still through a look, so what turns is the view and not the standpoint',
    mustFail: 'the camera stands still through a look, so what turns is the view and not the standpoint',
  },

  // The pivot pulled in rather than rotated, so the turn is right and the orbit afterwards is not.
  'look-shrinks-the-pivot': {
    file: 'web/main.js',
    edits: [[
      '  controls.target.copy(freeCamera.position).add(lookPivot);',
      '  controls.target.copy(freeCamera.position).addScaledVector(lookPivot, 0.5);',
    ]],
    fails: 'and the pivot rides a sphere about the camera, so the orbit radius survives the turn',
    mustFail: 'and the pivot rides a sphere about the camera, so the orbit radius survives the turn',
  },

  // A rate of its own rather than the lens's, which is the figure this started out as. Right at
  // the default lens and wrong everywhere else: at 300mm the frame is four degrees tall and six
  // pixels of drag would sweep the picture out of view.
  'look-ignores-the-lens': {
    file: 'web/fly.js',
    edits: [[
      '  const perPixel = THREE.MathUtils.degToRad(fovDeg) / Math.max(1, heightPx);',
      '  const perPixel = (2 * Math.PI) / Math.max(1, heightPx);',
    ]],
    fails: '  and a quarter field of view turns a quarter as far for the same pixels',
    mustFail: '  and a quarter field of view turns a quarter as far for the same pixels',
  },

  // The wheel read off the vertical alone. Chrome delivers shift plus a physical wheel as
  // `deltaX`, so this is the gesture dead on a real mouse and live under every driver.
  'lens-wheel-reads-only-the-vertical': {
    file: 'web/main.js',
    edits: [[
      '  const pixels = Math.abs(delta.x) > Math.abs(delta.y) ? delta.x : delta.y;',
      '  const pixels = delta.y;',
    ]],
    fails: 'and a wheel that reports its notch sideways moves the lens by the same amount, which is '
      + 'the axis a real mouse sends under shift',
    mustFail: 'and a wheel that reports its notch sideways moves the lens by the same amount, which is '
      + 'the axis a real mouse sends under shift',
  },

  // The yaw the other way, which is an orbit's sign rather than a look's.
  'look-drags-backwards': {
    file: 'web/fly.js',
    edits: [[
      '  out.applyAxisAngle(lookPole, -dxPx * perPixel);',
      '  out.applyAxisAngle(lookPole, dxPx * perPixel);',
    ]],
    fails: 'dragging right turns the view right, which puts the scene to the left of where it was',
    mustFail: 'dragging right turns the view right, which puts the scene to the left of where it was',
  },

  // And the pitch the other way. A separate control because a build can get one axis right.
  'look-pitches-backwards': {
    file: 'web/fly.js',
    edits: [[
      '    Math.PI - LOOK_POLE_EPS, Math.max(LOOK_POLE_EPS, polar + dyPx * perPixel),',
      '    Math.PI - LOOK_POLE_EPS, Math.max(LOOK_POLE_EPS, polar - dyPx * perPixel),',
    ]],
    fails: 'dragging down looks down, at the same radians per pixel as across',
    mustFail: 'dragging down looks down, at the same radians per pixel as across',
  },

  // The clamp removed, so a drag past the pole rotates through it and comes back facing the
  // other way. Driven as one pointer move, because a stepped drag on this build oscillates back
  // towards the pole it went through and a row reading the end of it sees nothing wrong.
  'look-tips-past-the-pole': {
    file: 'web/fly.js',
    edits: [[
      '  const wanted = Math.min(\n'
      + '    Math.PI - LOOK_POLE_EPS, Math.max(LOOK_POLE_EPS, polar + dyPx * perPixel),\n'
      + '  );',
      '  const wanted = polar + dyPx * perPixel;',
    ]],
    fails: 'and the pitch stops just short of either pole rather than tipping over it',
    mustFail: 'and the pitch stops just short of either pole rather than tipping over it',
  },

  // The look's release never arms the accurate seek, so a turn ends on the draft frame the drag
  // was redrawing. `fly-never-settles` through the second door the redesign opened.
  'look-never-settles': {
    file: 'web/main.js',
    edits: [[
      '  controls.enabled = viewCamera === freeCamera;\n  orbitSettling = true;\n}',
      '  controls.enabled = viewCamera === freeCamera;\n}',
    ]],
    fails: 'and letting the pointer up lands the accurate frame',
    mustFail: 'and letting the pointer up lands the accurate frame',
  },

  'look-survives-blur': {
    file: 'web/main.js',
    edits: [["addEventListener('blur', stopLookDrag);\n", '']],
    mustFail: 'editor: blur ends a look drag and rejects its remaining input',
  },
  'look-survives-capture-loss': {
    file: 'web/main.js',
    edits: [["['pointerup', 'pointercancel', 'lostpointercapture']", "['pointerup', 'pointercancel']"]],
    mustFail: 'editor: lostpointercapture ends a look drag and rejects its remaining input',
  },
  'look-survives-camera-switch': {
    file: 'web/main.js',
    edits: [['function setViewCamera(cam) {\n  stopLookDrag();', 'function setViewCamera(cam) {']],
    mustFail: 'editor: program camera ends a look drag and rejects its remaining input',
  },

  // The wheel's clamp removed. A wheel has no value to type, so nothing else stops it: the band
  // is what the gesture is bounded by rather than only measured against.
  'lens-wheel-ignores-the-band': {
    file: 'web/main.js',
    edits: [[
      '  freeCamera.fov = verticalFovForFocalLength(\n'
      + '    Math.min(LENS_MAX_MM, Math.max(LENS_MIN_MM, mm)), aspect,\n'
      + '  );',
      '  freeCamera.fov = verticalFovForFocalLength(mm, aspect);',
    ]],
    fails: 'and the wheel stops at each end of the band, at a reading the row can hold',
    mustFail: 'and the wheel stops at each end of the band, at a reading the row can hold',
  },

  // The band read off the raw number rather than off the figure the row prints. A lens the wheel
  // clamped to exactly 8mm comes back through `fov` as 7.9999999999999982 at 16:9, so the row
  // says it is wider than the band it is standing in.
  'showlens-reads-the-raw-number': {
    file: 'web/main.js',
    edits: [[
      '  const shown = Number(mm.toFixed(1));\n'
      + '  if (shown < LENS_MIN_MM) ui.camLensOut.textContent = `wider than ${LENS_MIN_MM}mm`;\n'
      + '  else if (shown > LENS_MAX_MM) ui.camLensOut.textContent = `longer than ${LENS_MAX_MM}mm`;',
      '  if (mm < LENS_MIN_MM) ui.camLensOut.textContent = `wider than ${LENS_MIN_MM}mm`;\n'
      + '  else if (mm > LENS_MAX_MM) ui.camLensOut.textContent = `longer than ${LENS_MAX_MM}mm`;',
    ]],
    fails: 'and the wheel stops at each end of the band, at a reading the row can hold',
    mustFail: 'and the wheel stops at each end of the band, at a reading the row can hold',
  },

  // ---- section 22, the clip a person adds, selects and deletes ----
  // A head trim that moves the clip and lets the footage travel with it, which is a slip and not
  // a trim. Must redden 'the footage under what is left holds still', alone.
  'head-trim-slides-the-footage': {
    file: 'web/main.js',
    edits: [[
      '  const sourceDuration = clip.source.streaming ? Infinity : clip.source.duration;\n'
        + '  Object.assign(clip, headTrim(clip, wantStart, holdEnd, MIN_CLIP_SEC, sourceDuration));',
      '  const priorStart = clip.start;\n'
        + '  const sourceDuration = clip.source.streaming ? Infinity : clip.source.duration;\n'
        + '  Object.assign(clip, headTrim(clip, wantStart, holdEnd, MIN_CLIP_SEC, sourceDuration));\n'
        + '  if (clip.start > priorStart) clip.sourceStart += 0.25;',
    ]],
    fails: 'a head trim that moves the clip and lets the footage travel with it, which is a slip '
      + 'and not a trim',
  },

  // A clip lands at the head of the edit rather than under the playhead. Must redden 'it lands
  // at the playhead' and, with it, the row that says the mark arm has a placement to be about -
  // which is that row working rather than a second catch.
  'add-clip-ignores-the-playhead': {
    file: 'web/main.js',
    edits: [['  const start = timeline ? timeline.programSec : 0;', '  const start = 0;']],
    fails: 'a clip landing at the head of the edit rather than under the playhead. Two rows: the '
      + 'placement, and the row that says the mark arm has a placement to be about at all',
  },

  'add-clip-needs-selection': {
    file: 'web/main.js',
    edits: [[
      '  ui.addClip.disabled = clips.length + pendingClipAdds >= CLIP_CEILING;',
      '  ui.addClip.disabled = !selected || clips.length + pendingClipAdds >= CLIP_CEILING;',
    ]],
    fails: 'the stack add control becoming disabled when no clip row is selected',
  },

  'add-clip-uses-hidden-selection': {
    file: 'web/main.js',
    edits: [[
      '  const initiating = selectedClipRow() ?? clips[0];',
      '  const initiating = selectedClipRow() ?? selectedClip;',
    ]],
    fails: 'an add with no selection copying the hidden last selection instead of the first clip',
  },

  'add-clip-stays-with-selected-clip-commands': {
    file: 'web/main.js',
    edits: [[
      "  rows.push({ owner: 'clip-add', label: '', kind: 'clip-add', height: CLIP_ADD_H });",
      '',
    ], [
      'ui.clipOptions.append(ui.deleteClip, ui.moveClip, ui.rotateClip, ui.keyClip);',
      'ui.clipOptions.append(ui.addClip, ui.deleteClip, ui.moveClip, ui.rotateClip, ui.keyClip);',
    ]],
    fails: 'the plus control returning to the dynamic controls area beside commands that need a selected clip',
  },

  'add-clip-skips-post-open-export-guard': {
    file: 'web/main.js',
    edits: [[
      "  if (generation !== documentGeneration || !clips.includes(initiating)) return null;\n  if (refuseEdit('adding a clip')) return null;\n  if (clips.length >= CLIP_CEILING) {",
      "  if (generation !== documentGeneration || !clips.includes(initiating)) return null;\n  if (clips.length >= CLIP_CEILING) {",
    ]],
    fails: 'an Add Clip request completing after export took the document. The export-race clip '
      + 'row reddens when the continuation appends the take and commits it mid-render',
  },

  'preset-apply-skips-post-fetch-export-guard': {
    file: 'web/main.js',
    edits: [[
      "  if (refuseEdit('applying a stored preset')) return null;\n  refuseDuringEvaluation('a stored preset applied');",
      "  refuseDuringEvaluation('a stored preset applied');",
    ]],
    fails: 'a fetched preset applying and stamping after export took the document. The export-race '
      + 'preset row reddens on the changed document and commit',
  },

  'preset-none-skips-export-guard': {
    file: 'web/main.js',
    edits: [[
      "      if (refuseEdit('resetting the selected clip to defaults')) {\n"
        + "        showPickerChoice(picker, target.appliedPreset?.name ?? '');\n"
        + '        return;\n'
        + '      }\n',
      '',
    ]],
    fails: 'choosing preset none during export clearing the stamp and committing while its value '
      + 'resets are refused. The preset-none export row reddens alone',
  },

  'output-rate-skips-export-guard': {
    file: 'web/main.js',
    edits: [[
      "  if (refuseEdit('changing the output rate')) {\n"
        + '    ui.fps.value = String(timeline.outputFps);\n'
        + '    return;\n'
        + '  }\n',
      '',
    ]],
    fails: 'changing the output rate during export moving the timeline grid and committing. Two '
      + 'rows: the changed output-rate state and the real export it invalidates',
  },

  'keyed-control-skips-export-guard': {
    file: 'web/main.js',
    edits: [[
      "  if (refuseEdit(`a change to ${name}`)) {\n"
        + '    writeControl(name, params.get(name));\n'
        + '    return;\n'
        + '  }\n',
      '',
    ]],
    fails: 'a keyed slider inserting a key while export owns the document. The keyed-control '
      + 'export row reddens alone',
  },

  'camera-delete-skips-export-guard': {
    file: 'web/main.js',
    edits: [[
      "ui.camClear.addEventListener('click', () => {\n"
        + "  if (refuseEdit('deleting a camera key')) return;",
      "ui.camClear.addEventListener('click', () => {",
    ]],
    fails: 'the camera delete button removing a key while export owns the document. The camera '
      + 'delete export row reddens alone',
  },

  'deselected-source-clock-stays-live': {
    file: 'web/main.js',
    edits: [[
      "  ui.source.textContent = EDITING && clipRow === null\n"
        + "    ? '\\u2014' : timecode(sourceSecOfProgram(program));",
      '  ui.source.textContent = timecode(sourceSecOfProgram(program));',
    ]],
    fails: 'the source clock continuing to read the hidden render binding after the strip has '
      + 'deselected every clip. The deselected source-clock row reddens alone',
  },

  'import-applies-to-response-time-selection': {
    file: 'web/main.js',
    edits: [[
      '  const applied = applyStoredPreset({ name: saved.name, rev: saved.rev, body }, target);',
      '  const applied = applyStoredPreset({ name: saved.name, rev: saved.rev, body });',
    ]],
    fails: 'an imported preset applying to the clip selected when its PUT finishes instead of the '
      + 'clip that initiated the import. The import target row reddens alone',
  },

  'preset-save-stamps-response-time-selection': {
    file: 'web/main.js',
    edits: [[
      '      stampPreset(target, { name: saved.name, rev: saved.rev });',
      '      stampPreset(EDITING ? selectedClipRow() : selectedClip, { name: saved.name, rev: saved.rev });',
    ]],
    fails: 'a whole-look save stamping the clip selected when its PUT finishes instead of the '
      + 'clip whose look was written. The save target row reddens alone',
  },

  'zero-length-clip-draws-endpoint': {
    file: 'web/main.js',
    edits: [[
      '    const hasSpan = clip.end > clip.start;',
      '    const hasSpan = true;',
    ]],
    fails: 'a zero-length clip drawing one endpoint frame. The imported zero-length clip row '
      + 'reddens alone',
  },

  'project-allows-unsafe-frame-range': {
    file: 'web/main.js',
    edits: [[
      '    const lastFrame = Math.floor(end * fps);\n'
        + '    if (!Number.isSafeInteger(lastFrame)) {\n'
        + '      throw new Error(\n'
        + '        `clip ${planned.id} ends at ${end}s, output frame ${lastFrame} at ${fps}fps: the timeline `\n'
        + "        + 'enumerates frames as JavaScript integers, so its last frame must be a safe integer',\n"
        + '      );\n'
        + '    }\n',
      '',
    ]],
    fails: 'a project whose last output frame cannot advance as a JavaScript integer. The unsafe '
      + 'frame-range refusal row reddens alone',
  },

  'ruler-stops-scaling-beyond-hour': {
    file: 'web/view-window.js',
    edits: [[
      '    step = Number.isFinite(scaled) ? scaled : wantedSec;',
      '    step = top;',
    ]],
    fails: 'the ruler falling back to one-hour ticks for an enormous finite program. The huge '
      + 'project row reddens on a capped tick set instead of one sized to the viewport',
  },

  // A mark is drawn through the clip-local map and not through where that clip sits.
  // Must redden both mark rows of 22 and nothing else there.
  'marks-ignore-the-placement': {
    file: 'web/main.js',
    edits: [[
      'const programSecOfSource = (sourceSec) => selectedClip.start\n'
      + '  + clipProgramSecAt(selectedClip, sourceSec);',
      'const programSecOfSource = (sourceSec) => clipProgramSecAt(selectedClip, sourceSec);',
    ]],
    fails: 'a mark drawn through its clip-local map and not through where that clip sits, so two '
      + 'clips of one take draw their marks on top of each other',
  },

  // A completed write from the previous take replaces the marks loaded for the take selected
  // while it was in flight. Must redden the response-order row of 22.
  'mark-response-follows-selection': {
    file: 'web/main.js',
    edits: [['  if (openTakeId() !== id) return false;\n  takeMarks = marks;',
             '  takeMarks = marks;']],
    fails: 'a mark write started on one take replacing the mark list after another take was '
      + 'selected. The response-order row of section 22 is the catch',
  },

  // A mark planted or dragged before the selected clip is written as a negative source time.
  // Must redden the two source-bound rows of 22.
  'marks-write-outside-the-take': {
    file: 'web/main.js',
    edits: [[
      `const markSourceSecOfProgram = (programSec) => Math.max(
  0, Math.min(selectedClip.source.duration, sourceSecOfProgram(programSec)),
);`,
      'const markSourceSecOfProgram = (programSec) => sourceSecOfProgram(programSec);',
    ]],
    fails: 'a mark planted or dragged before a placed clip writing a negative source second. '
      + 'The two source-bound rows of section 22 are the catch',
  },

  // Selecting a row moves the strip's idea of the selection and not the page's.
  // Must redden 'the panel and speed binding follow it' and the mark rows with it.
  'select-row-does-not-select-the-clip': {
    file: 'web/main.js',
    edits: [['  clipRow = clip;\n  selectClip(clip);',
             '  clipRow = clip;']],
    fails: 'a row selection the page never follows, which leaves the panel and the marks on '
      + 'whatever clip the editor opened with',
  },

  // Evaluating a keyed value for an unselected clip paints the shared inspector with it. Must
  // redden 22b's selected-control and reset rows.
  'nonselected-track-paints-control': {
    file: 'web/main.js',
    edits: [[
      `    const paintControl = spec.scope !== 'clip'
      || evaluatingClip === null || evaluatingClip === selectedClip;`,
      '    const paintControl = true;',
    ]],
    fails: 'a keyed value evaluated for an unselected clip repainting the shared inspector. '
      + 'Section 22b\'s selected-control and reset rows are the catch',
  },

  // The door a restore comes through refuses a slot that grew back, which is what an undo of a
  // delete is. Must redden the two undo rows of 22.
  'restore-refuses-a-regrown-slot': {
    file: 'web/main.js',
    edits: [[
      '    const open = planned.take ? takeOpenedAs(planned.take.hash) : null;',
      '    const open = null;',
    ]],
    fails: 'the synchronous restore refusing a clip slot that grew back, which is what the undo '
      + 'of a delete is',
  },

  // ---- section 15b, the badge for an effect this build has not got ----
  // Must redden: the exact-sentence row of 15b, alone.
  'badge-counts-the-registry': {
    file: 'web/main.js',
    edits: [[
      "  values: Object.keys(parkedWhole('params')).filter((n) => effectOf(n) === entry.id).length,\n"
      + "  tracks: Object.keys(parkedWhole('tracks')).filter((n) => effectOf(n) === entry.id).length,",
      '  values: effectParamNames(entry.id).length,\n'
      + '  tracks: effectParamNames(entry.id).filter((n) => tracks.has(n)).length,',
    ]],
    fails: 'the badge for a missing effect counting off the registry rather than off the parked '
      + 'pool, which prints `0 values, 0 tracks parked` - the same line a build that '
      + '*dropped* them would print. Reddens the exact-sentence row of 15b',
  },

  // Must redden: the press-it-again row of 15b, alone.
  'suppress-toggle-is-a-latch': {
    file: 'web/main.js',
    edits: [[
      '  if (suppressedEffects.has(id)) suppressedEffects.delete(id);\n  else suppressedEffects.add(id);',
      '  suppressedEffects.add(id);',
    ]],
    fails: 'and the toggle beside it going only one way, so a decision about one render becomes '
      + 'a decision about the session. Reddens the press-it-again row alone',
  },

  // ---- section 21, the collapsed panel and its dock ----
  // Must redden: 'the picture ends exactly where the dock begins'.
  'resize-ignores-the-dock': {
    file: 'web/main.js',
    edits: [["    ? document.getElementById('panelDock')?.offsetHeight ?? 0\n", '    ? 0\n']],
  },

  // Must redden: the H round trip, and the row that reads the toggle's `aria-pressed` after the
  // key moved the panel.
  'collapse-by-display': {
    file: 'web/main.js',
    edits: [[
      "    setPanelCollapsed(!document.body.classList.contains('panelcollapsed'));\n    return;",
      "    const p = document.getElementById('panel');\n"
      + "    p.style.display = p.style.display === 'none' ? '' : 'none';\n    return;",
    ]],
  },

  // Must redden: 'the picture ends exactly where the dock begins', 'it clears the timeline
  // strip', and 'a press at the middle of a dock button reaches that button'.
  'collapsed-keeps-the-editor-height': {
    file: 'web/index.html',
    edits: [[
      '  body.editing.panelcollapsed #panel {\n    height: auto;\n'
      + '    bottom: calc(var(--timeline-h) + var(--tlanes-h));\n  }\n', '',
    ]],
  },

  // Must redden: 'with nothing but the dock left in the collapsed panel', at 31px slack.
  'collapsed-keeps-the-tab-rail': {
    file: 'web/index.html',
    edits: [[
      '  body.panelcollapsed #panelTabs:not([hidden]) { display: none; }',
      '  body.panelcollapsed #panelTabs { display: none; }',
    ]],
  },

  // Must redden: 'offers neither of the two that act on the take'.
  'dock-offers-the-take-on-the-editor': {
    file: 'web/index.html',
    edits: [['  body.editing #dockRec,\n  body.editing #dockMark { display: none; }\n', '']],
  },

  // Must redden: 'the dock\'s sensor lands the pose Framing\'s own sensor view lands'.
  'dock-sensor-takes-the-centre': {
    file: 'web/main.js',
    edits: [[
      "shell.dockSensor.addEventListener('click', () => ui.camSensor.click());",
      "shell.dockSensor.addEventListener('click', () => shell.cameraReset.click());",
    ]],
  },

  // Must redden the two slot rows in section 13 and nothing else: the depth row, which is the
  // press being recorded at all, and the stamp row, which is what it destroyed.
  'commit-ignores-null-baseline': {
    file: 'web/main.js',
    edits: [['    if (this.baseline === null) return false;\n', '']],
    fails: 'a press on a live control of a take that never opened, recorded as an edit. The '
      + '`!EDITING` guard beside it is about the surface and cannot see this: `begin()` is the '
      + 'last thing `openTake` does, so a failed open leaves `/edit` interactive with a null '
      + 'baseline. Reddens **one** row in section 13, the press being recorded. It said two '
      + 'until the working document went: the second was the recovery slot the press destroyed, '
      + 'and there is no slot to spend now, so the surviving half is what it is asked to hold. '
      + 'Measured on the rewritten section - 739 assertions, 3 failed, two of them the standing '
      + 'pair this file declares',
  },

  // Must redden the two pre-roll rows and leave the space-bar rows above them green: the key was
  // never the control that was wrong, and a build that had broken pausing at large would
  // take those with it.
  'play-button-skips-pausetransport': {
    file: 'web/main.js',
    edits: [[
      '  if (timeline.playing || timeline.pendingPlay) pauseTransport();\n  else timeline.play().catch(showTimelineError);',
      '  if (timeline.playing || timeline.pendingPlay) timeline.pause();\n  else timeline.play().catch(showTimelineError);',
    ]],
    fails: 'the one pause on this surface that did not take the transport. **NOT caught by this '
      + 'suite**, and that is recorded rather than left to be rediscovered: the two pre-roll '
      + 'rows beside it pass on both builds, because a pause pressed inside a play\'s own '
      + 'pre-roll holds either way. The generation guard protects a resume queued by '
      + '*another* gesture, and in each of those the transport is already paused, so the '
      + 'button is a play rather than a pause. The fix is consistency with the helper this '
      + 'file\'s own comment mandates, not a demonstrated defect',
  },

  // Must redden the pending-play outcome row and leave the pending-window row above it green,
  // because the mutated build still enters the pending state - what it loses is the
  // press that ends it.
  'toggle-plays-over-a-pending-play': {
    file: 'web/main.js',
    edits: [[
      '  if (timeline.playing || timeline.pendingPlay) pauseTransport();\n  else timeline.play().catch(showTimelineError);',
      '  if (timeline.playing) pauseTransport();\n  else timeline.play().catch(showTimelineError);',
    ]],
    fails: 'the *demonstrated* defect on the same button: the toggle reading `playing` alone, '
      + 'which is false for the whole stretch a play spends awaiting the accurate seek a '
      + 'draft forces, so the press that meant stop started a second play. Reddens the '
      + 'pending-outcome row and leaves the pending-window row above it green - read the rows',
  },

  // Must redden the pending-play outcome row alone, same as the toggle mutation - two ways to
  // break one claim, and the claim needs both halves standing.
  'play-resolves-past-its-pause': {
    file: 'web/main.js',
    edits: [[
      '    if (gen !== this.playGen) {\n      this.paint();\n      return;\n    }\n',
      '',
    ]],
    fails: 'and the transport\'s half of that claim: a pending play that never rechecks its '
      + 'generation resolves into `playing` over the pause that landed inside it. Same row - '
      + 'two ways to break one claim, and it needs both halves standing',
  },

  // Must redden the revert row and leave the row above it green, since the refusal
  // itself is unchanged.
  'picker-keeps-a-refused-look': {
    file: 'web/main.js',
    edits: [[
      "        } catch (err) {\n          showPickerChoice(picker, appliedPreset()?.name ?? '');\n          showTimelineError(err);",
      "        } catch (err) {\n          showTimelineError(err);",
    ]],
    fails: 'and the picker left naming a look the apply refused, which the deliverable menu '
      + 'forty lines away already reverts. The refusal itself is unchanged, so only the '
      + 'revert row reddens',
  },

  // Must redden the two per-side refusal rows - a point outside the segment, a camera handle
  // above the box - and leave the overshoot row green.
  'restorekey-skips-handle-invariants': {
    file: 'web/main.js',
    edits: [[
      '    const why = handleRefusal(points, loY, hiY);\n'
      + '    if (why) {\n'
      + "      throw new Error(`${owner}'s key at ${k.t}s has a ${side} handle with ${why}`);\n"
      + '    }\n',
      '',
    ]],
    fails: 'the ease-handle invariants asked of the drag that makes a value and never of the '
      + 'loader that reads one back, though the docstring over it claimed them. Reddens the '
      + 'two per-side refusal rows and leaves the look-overshoot and fold rows green, because '
      + 'the bound is per kind and the fold is the segment\'s own check',
  },

  // Must redden the fold row alone and leave the per-side rows and the legal-crossed row green.
  'restore-skips-the-fold-check': {
    file: 'web/main.js',
    edits: [
      ['    refuseFolds(owner, ready);\n', ''],
      ["  refuseFolds('track camera', camera);\n", ''],
    ],
    fails: 'that check: whole-curve monotonicity asked once per segment with both handles in '
      + 'hand. The per-side ordering rule it replaced refused the legal crossed polygons '
      + '`elevate` produces - the editor could save a document its own reload declined - and '
      + 'could not see a fold spanning the join at all. Reddens the fold row alone; the '
      + 'legal-crossed row beside it is the half that fails on the build this replaced',
  },

  // Must redden the descending-times row alone and leave the fold and legal-crossed rows green.
  'restore-admits-descending-times': {
    file: 'web/main.js',
    edits: [[
      '    if (keys[i + 1].t < keys[i].t) {\n'
      + '      throw new Error(`${owner} holds a key at ${keys[i + 1].t}s after one at ${keys[i].t}s: keys are `\n'
      + "        + 'stored ascending, and the binary search the evaluators run over this track answers '\n"
      + "        + 'wrongly rather than failing on one that is not');\n"
      + '    }\n'
      + '    if (keys[i + 1].t === keys[i].t) continue;\n',
      '    if (!(keys[i + 1].t > keys[i].t)) continue;\n',
    ]],
    fails: 'the walk\'s other question: a pair whose times descend skipped as merely coincident, '
      + 'so a damaged track installs unsorted and keyBefore\'s binary search selects segments '
      + 'nobody authored. Reddens the descending-times row alone',
  },

  // Must redden the two pivot rows and leave `Default camera position reaches
  // OrbitControls reset` green.
  'reset-forgets-the-pivot': {
    file: 'web/scene.js',
    edits: [
      ['    controls.target0.copy(previous.target0);\n'
       + '    controls.position0.copy(previous.position0);\n'
       + '    controls.zoom0 = previous.zoom0;\n', ''],
      ['    controls.saveState();\n', ''],
    ],
    fails: 'the orbit\'s home aim, which `OrbitControls` captures in its constructor before the '
      + 'target is written and which no rebuild carried across. Reddens the two pivot rows '
      + 'and leaves the position row green, because the position was never the half that was '
      + 'broken - read the rows',
  },

  'import-skips-normalise': {
    file: 'web/main.js',
    edits: [
      ['  refusePresetBody(name, body);\n', ''],
      [
        '  if (generation !== documentGeneration || (target && !clips.includes(target))) {\n'
        + '    return { ...saved, applied: false };\n'
        + '  }\n'
        + '  const applied = applyStoredPreset({ name: saved.name, rev: saved.rev, body }, target);\n'
        + '  return { ...saved, applied: applied !== null };',
        '  for (const [k, v] of Object.entries(body.values ?? {})) {\n'
        + '    if (globalThis.__kinect?.uniforms?.[k]) globalThis.__kinect.uniforms[k].value = v;\n'
        + '  }\n'
        + '  stampPreset(target, { name: saved.name, rev: saved.rev });\n'
        + '  return { ...saved, applied: true };',
      ],
    ],
  },

  // Must redden: the two rows that ask the store after a refusal, for the malformed file and
  // for the file carrying a stray top-level key.
  'import-saves-before-validating': {
    file: 'web/main.js',
    edits: [
      ['  refusePresetBody(name, body);\n', ''],
      [
        "  const saved = await writeDocumentAtCurrentRev('presets', name, { body });\n"
        + '  if (generation !== documentGeneration || (target && !clips.includes(target))) {\n'
        + '    return { ...saved, applied: false };\n'
        + '  }\n'
        + '  const applied = applyStoredPreset({ name: saved.name, rev: saved.rev, body }, target);\n'
        + '  return { ...saved, applied: applied !== null };',
        "  const saved = await writeDocumentAtCurrentRev('presets', name, { body });\n"
        + '  refusePresetBody(name, body);\n'
        + '  if (generation !== documentGeneration || (target && !clips.includes(target))) {\n'
        + '    return { ...saved, applied: false };\n'
        + '  }\n'
        + '  const applied = applyStoredPreset({ name: saved.name, rev: saved.rev, body }, target);\n'
        + '  return { ...saved, applied: applied !== null };',
      ],
    ],
  },

  // Must redden: section 13's "the whole of a long refusal is reachable off the note's title",
  // and that row alone.
  'note-skips-title': {
    file: 'web/main.js',
    edits: [['  ui.note.title = text;\n', '']],
  },

  'tick-seeks-source-seconds': {
    file: 'web/main.js',
    edits: [[
      '      goTo(at);',
      '      goTo(mark.sourceMs / 1000);',
    ]],
  },

  // Five controls stood here and they are removed rather than re-anchored. What each guaranteed
  // is recorded in `docs/proof-tools.md` beside the section that drove them.
  //
  // `offer-ignores-take-hash`         - the offer joined on the take's content hash and not on
  //                                     its id, so a renamed id could not resurrect an edit cut
  //                                     on different footage.
  // `resume-fetches-the-moving-name`  - pressing the chip restored the document that had been
  //                                     offered rather than re-reading the name, which the
  //                                     auto-save moves under it between the offer and the press.
  // `resume-restores-without-keeping` - a restore that could not be written back threw rather
  //                                     than leaving the screen and the file disagreeing.
  // `resume-waits-for-every-list`     - a neighbouring listing that refused did not hide the
  //                                     offer, since only the projects listing is what it is
  //                                     made of.
  // `apply-says-nothing`              - the note for an applied preset said what was applied.

  'project-load-keeps-renamed-take-id': {
    file: 'web/main.js',
    edits: [[
      '      && (planned.take.hash !== (clips[at]?.source?.index?.hash ?? null)\n'
      + '        || planned.take.id !== (clips[at]?.take?.id ?? null)));',
      '      && planned.take.hash !== (clips[at]?.source?.index?.hash ?? null));',
    ]],
    fails: 'the renamed-take project row in section 22: the document loads against the right '
      + 'bytes but leaves the clip fetching and marking through the name that no longer exists',
  },

  // The successor to `resume-races-the-autosave`, which was about a write going through the
  // ordered writer rather than through a bare fetch. Auto-save is still serialised, and what the
  // ordering now has to carry is the revision: read it where the call is made and every write in
  // a burst names the revision the first of them replaced, so the second is refused as somebody
  // else's work and the tab stops writing over its own shoulder.
  'autosave-reads-the-revision-outside-the-queue': {
    file: 'web/main.js',
    edits: [[
      'function writeOpenProject(body) {\n'
      + '  return queueProjectWrite(async () => {\n'
      + '    const res = await fetch(\n'
      + '      `/projects/${encodeURIComponent(openedProjectName)}?rev=${encodeURIComponent(openedProjectRev)}`,',
      'function writeOpenProject(body) {\n'
      + '  const revAtCall = openedProjectRev;\n'
      + '  return queueProjectWrite(async () => {\n'
      + '    const res = await fetch(\n'
      + '      `/projects/${encodeURIComponent(openedProjectName)}?rev=${encodeURIComponent(revAtCall)}`,',
    ]],
    fails: 'the burst row in section 13 - two commits in one turn, where the second carries the '
      + 'revision the first replaced and is refused against its own predecessor. The refusal row '
      + 'beside it goes red the other way, because the banner then stands over a divergence '
      + 'nobody else caused',
  },

  // Must redden the AltGr row and leave the plain ctrl+alt row beside it green.
  'shortcuts-reject-altgr': {
    file: 'web/main.js',
    edits: [[
      "  const composed = e.key.length === 1 && e.getModifierState('AltGraph');\n"
      + '  if ((e.metaKey || e.ctrlKey || e.altKey) && !composed) return;',
      '  if (e.metaKey || e.ctrlKey || e.altKey) return;',
    ]],
  },

  // Must redden only the row about a trimmed clip.
  'marks-ignore-the-clip-range': {
    file: 'web/main.js',
    edits: [[
      '      const seconds = markSecondsInOrder().filter(reachableInClip);',
      '      const seconds = markSecondsInOrder();',
    ]],
  },

  // Must redden only the click rows.
  'tick-seeks-outside-the-trim': {
    file: 'web/main.js',
    edits: [[
      "        if (!reachableInClip(at)) {\n"
      + "          say('that mark is outside the clip range, so the edit cannot reach it');\n"
      + '          return;\n        }\n',
      '',
    ]],
  },

  // Must redden the focused-beyond row and leave the focused-ordinary row green.
  'beyond-mark-loses-focus': {
    file: 'web/index.html',
    edits: [
      ['  .tmk.beyond { color: var(--faint); }\n  .tmk:hover', '  .tmk:hover'],
      [
        '  .tmk:focus-visible { outline: 0; color: var(--ink); }',
        '  .tmk:focus-visible { outline: 0; color: var(--ink); }\n'
        + '  .tmk.beyond { color: var(--faint); }',
      ],
    ],
  },

  // Must redden five rows: the row reading the exported document's keys, the row reading what
  // the save put in the library, and three standing on the fixture the mutation destroys.
  'picker-ignores-the-boxes': {
    file: 'web/main.js',
    edits: [[
      '      picked = { name: chosen, names: presetPickNames() };',
      "      picked = { name: chosen, names: params.names('look') };",
    ]],
  },

  // Must redden three rows: the control's own row - untick one weight and count what came off
  // with it - and two that stand on what it broke.
  'readings-tick-alone': {
    file: 'web/main.js',
    edits: [[
      '  for (const n of (PARAMS[name].reading ? READINGS : [name])) presetPickBoxes.get(n).checked = on;',
      '  presetPickBoxes.get(name).checked = on;',
    ]],
  },

  // Must redden eight rack rows: fresh absence; the value and track leaving again; search and Add;
  // focus after Add; confirmed removal making the row leave; and the final
  // local-preference equality.
  'effect-rack-shows-every-effect': {
    file: 'web/main.js',
    edits: [[
      'function effectPresent(id) {\n  return rackedEffects.has(id) || effectTouched(id);\n}',
      'function effectPresent(id) {\n  return true;\n}',
    ]],
  },

  // Must redden: three rack rows - the value reveal, the track reveal, and undo restoring work
  // without restoring visibility.
  'effect-rack-ignores-touched': {
    file: 'web/main.js',
    edits: [[
      'function effectPresent(id) {\n  return rackedEffects.has(id) || effectTouched(id);\n}',
      'function effectPresent(id) {\n  return rackedEffects.has(id);\n}',
    ]],
  },

  // Must redden: the row proving a racked effect's group stays open at its default.
  'effect-rack-ignores-racked': {
    file: 'web/main.js',
    edits: [[
      "  return names.some((name) => {\n"
        + "    const id = effectOf(name);\n"
        + "    return id !== null && rackedEffects.has(id);\n"
        + "  });",
      '  return false;',
    ]],
  },

  // Must redden: the zero-master row in section 17. The attribute remains true, but the CSS
  // exposes the row, which is the failure the row reads separately from the DOM state.
  'under-rows-ignore-hidden': {
    file: 'web/index.html',
    edits: [[
      '  .row[hidden], .checkrow[hidden] { display: none; }\n',
      '',
    ]],
  },

  // Must redden: both user paths in section 3 retain the narrowed range.
  'whole-clip-does-nothing': {
    file: 'web/main.js',
    edits: [[
      // The guard line is quoted with the rest because this anchor is the whole function body,
      // so anything added inside it moves the anchor. The mutation still removes exactly the two
      // writes: the range and the record of it.
      'function clearClipRange() {\n'
        + '  if (refuseEdit(\'clearing the trim\')) return;\n'
        + '  // `null` rather than the duration, so the range still means to the end if the program grows.\n'
        + '  setClipInOut({ in: 0, out: null });\n'
        + '  history.commit();\n'
        + '}',
      'function clearClipRange() {\n  if (refuseEdit(\'clearing the trim\')) return;\n  history.commit();\n}',
    ]],
  },

  // Must redden section 3's lane hit tests and, when the press lands inside the zone, section 22's
  // deselect cluster. Only the below-ruler probes distinguish a full-height marker hit zone.
  'grab-zone-over-the-lanes': {
    file: 'web/index.html',
    edits: [
      ['  .tcut { position: absolute; top: 0; height: 2px; width: 1px; background: var(--dim);\n'
        + '    pointer-events: none; z-index: 4; }',
      '  .tcut { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--dim);\n'
        + '    pointer-events: none; z-index: 4; }'],
      ['  .tcut::after { content: ""; position: absolute; top: 0; height: var(--ruler-h);\n'
        + '    pointer-events: auto; cursor: ew-resize; }',
      '  .tcut::after { content: ""; position: absolute; top: 0; bottom: 0;\n'
        + '    pointer-events: auto; cursor: ew-resize; }'],
    ],
    fails: 'the markers\' grab zone running the whole column again, so lane whitespace beside the '
      + 'line belongs to the marker and a press aimed at a lane trims the range instead',
  },

  // Must redden: the Escape row in section 1. Other focus transfers stay intact, so the failure
  // names the return path rather than making every rack action lose its caret.
  'effect-rack-strands-focus': {
    file: 'web/main.js',
    edits: [[
      '  if (restore) shell.effectRackOpen.focus();',
      '  void restore;',
    ]],
  },

  // Must redden: the narrow-viewport and collapsed-panel geometry rows in section 1.
  'effect-rack-keeps-fixed-left': {
    file: 'web/index.html',
    edits: [[
      '  body.panelcollapsed #effectRackPanel { left: 16px; }\n'
        + '  @media (max-width: 562px) {\n'
        + '    #effectRackPanel, body.panelcollapsed #effectRackPanel {\n'
        + '      left: 16px; right: 16px; width: auto; z-index: 11;\n'
        + '    }\n'
        + '  }\n',
      '',
    ]],
  },

  // Must redden: one rack row, the confirmed removal's joined value/track/presence assertion.
  'effect-rack-remove-keeps-tracks': {
    file: 'web/main.js',
    edits: [['        look.tracks.delete(name);\n', '']],
  },

  // Must redden: one rack row, the reset-retains assertion.
  'effect-rack-reset-forgets-effect': {
    file: 'web/main.js',
    edits: [[
      "  button.addEventListener('click', () => {\n    retainEffectFor(name);\n    params.set(name, resetTarget(name));",
      "  button.addEventListener('click', () => {\n    params.set(name, resetTarget(name));",
    ]],
  },

  // Must redden: 20 rows, and the shape of that set is the thing to read rather than the count.
  'group-never-reveals': {
    file: 'web/main.js',
    edits: [[
      'function revealsItself(key) {\n  const names = panelGroupParams.get(key) ?? [];',
      'function revealsItself(key) {\n  if (key) return false;\n  const names = panelGroupParams.get(key) ?? [];',
    ]],
  },

  // Must redden: the keyed-at-default row in 15d and the rack's own track row, because both
  // read the keyframe term through `paramTouched`. Measured on this tree and on HEAD.
  'reveal-ignores-tracks': {
    file: 'web/main.js',
    edits: [[
      '  if ((tracks.get(name)?.keys.length ?? 0) > 0) return true;\n'
      + '  return params.get(name) !== groupDefaults.get(name);',
      '  return params.get(name) !== groupDefaults.get(name);',
    ]],
  },


  // Must redden: 2 rows, both in 15f-bis, and no others.
  'override-prunes-only-on-toggle': {
    file: 'web/main.js',
    edits: [
      [
        '    const pair = `${want}/${inUse}`;\n'
        + '    const settled = groupSeen.get(key);\n'
        + '    if (settled !== undefined && settled !== pair && want === inUse) {\n'
        + '      groupOverride.delete(key);\n'
        + '      groupOverrideDirty = true;\n'
        + '    }\n'
        + '    groupSeen.set(key, `${groupOverride.get(key)}/${inUse}`);\n',
        '',
      ],
      [
        '  groupOverride.set(key, !groupIsOpen(entry.group));\n',
        '  const want = !groupIsOpen(entry.group);\n'
        + '  if (want === groupRevealed(entry.group)) groupOverride.delete(key);\n'
        + '  else groupOverride.set(key, want);\n',
      ],
    ],
  },

  // Must redden: 2 rows, both in 15i, and no others.
  'prune-ignores-movement': {
    file: 'web/main.js',
    edits: [[
      '    if (settled !== undefined && settled !== pair && want === inUse) {\n',
      '    if (want === inUse) {\n',
    ]],
  },

  // Must redden: 13k's cost row, and that row alone.
  'panel-rederives-per-write': {
    file: 'web/main.js',
    edits: [
      ['    if (!transportWriting) groupRevealChanged();\n', '    groupRevealChanged();\n'],
      ['    if (!outer) groupRevealChanged();\n', ''],
    ],
  },

  // Must redden: 2 rows, both about the stray key - that it is refused by name, and that it
  // never became a document.
  'envelope-unchecked': {
    file: 'web/main.js',
    edits: [[
      '  const stray = Object.keys(body).filter((k) => !PRESET_KEYS.includes(k));\n',
      '  const stray = [];\n',
    ]],
  },

  'box-drag-pumps-renders': {
    file: 'web/main.js',
    edits: [[
      '  params.set(cropDrag.param, cropDrag.from + (face.flip ? -coord : coord));\n'
      + '  chromeStale = true;',
      '  params.set(cropDrag.param, cropDrag.from + (face.flip ? -coord : coord));\n'
      + '  chromeStale = true;\n'
      + '  renderProgramFrame(timeline ? timeline.programSec : 0);',
    ]],
  },

  'fit-outlives-a-restored-project': {
    file: 'web/main.js',
    edits: [[
      '  door.open()',
      '  door.open()\n'
      + '    .then(() => fitCropToTake(openTakeId(), params.get(\'near\'), params.get(\'far\')).catch(() => {}))',
    ]],
    fails: 'and a document\'s own box, which the entry point protects by structure: the fit '
      + 'belongs to opening a bare take and a named project never runs it. The mutation puts '
      + 'one back into the boot chain, and reddens 4 - the planted-box row plus the three '
      + 'reset rows on a page the late fit lands on. The box row reads its planes twice, '
      + 'because a fit is a fetch and one landing after a single read passes on nothing',
  },
  'fit-lands-after-history-begins': {
    file: 'web/main.js',
    edits: [
      ['  await fitCropToTake(id, params.get(\'near\'), params.get(\'far\'))\n'
        + '    .catch((err) => { say(`the crop box could not be fitted to this take: ${err.message}`); });\n',
      ''],
      // Anchored through the comment above it rather than on the call alone: a load starts its
      // own stack now, so `history.begin()` appears twice and the bare line names both.
      ['  // somewhere to land.\n  history.begin();\n',
      '  // somewhere to land.\n  history.begin();\n'
        + '  await fitCropToTake(id, params.get(\'near\'), params.get(\'far\'))\n'
        + '    .catch((err) => { say(`the crop box could not be fitted to this take: ${err.message}`); });\n'
        + '  history.commit();\n'],
    ],
  },
  'export-name-not-taken': {
    file: 'web/main.js',
    edits: [[
      'ui.exportName.addEventListener(\'input\', () => {\n  takeExportName();\n  paintExportName();\n});',
      'ui.exportName.addEventListener(\'input\', () => {\n  paintExportName();\n});',
    ]],
    fails: 'the output name read out of a deliverable and never written into one, which is the '
      + 'defect this branch shipped: the row walks it out to the server and back through an '
      + 'adoption, because a field read straight back proves only that an input holds text',
  },

  'aspect-skips-the-letterbox': {
    file: 'web/main.js',
    edits: [[
      '  void fromDocument;\n  paintDeliverable();\n  resize();\n  return true;',
      '  void fromDocument;\n  paintDeliverable();\n  return true;',
    ]],
    fails: 'the shape written into the document and the stage not framed to it, which is the one '
      + 'thing putting the shape on the document was for. Reads the stage\'s own box rather '
      + 'than the button that was just pressed, so a build that lights the control and '
      + 'reframes nothing fails here and passes on the attribute',
  },

  'plant-unswept-control': {
    file: 'web/index.html',
    edits: [[
      '      <span class="tchip" id="tNote"></span>',
      '      <span class="tchip" id="tNote"></span>\n'
      + '      <button id="tPlantedControl" type="button">planted</button>',
    ]],
  },

  // Must redden: eight rows. The claim-carrying one is section 1's "every parameter the registry
  // declares has a control on the panel", naming ghost.fill; the rack, reset and under rows are
  // the dependent actions that can no longer find the deliberately missing control.
  'panel-row-skips-parameter': {
    file: 'web/main.js',
    edits: [
      ['    if (spec.group !== group.key) continue;',
        "    if (spec.group !== group.key || name === 'ghost.fill') continue;"],
      ['  if (panelRowsEmitted !== owned.length) {', '  if (panelRowsEmitted !== owned.length - 1) {'],
    ],
  },

  'nav-at-the-foot': {
    file: 'web/index.html',
    edits: [[
      '  </div><!-- #panelBody -->',
      '    <script>\n'
      + "      const plantedBar = document.getElementById('appBar');\n"
      + "      plantedBar.style.position = 'static';\n"
      + "      document.getElementById('panelBody').append(plantedBar);\n"
      + '    </script>\n'
      + '  </div><!-- #panelBody -->',
    ]],
  },

  'panel-tabs-show-everything': {
    file: 'web/main.js',
    edits: [[
      '    group.hidden = group.dataset.panelTab !== tab;',
      '    group.hidden = false;',
    ]],
  },

  // ------------------------------------------------------ the per-parameter reset

  // Must redden: two rows, and the second is what makes the driver rule honest.
  'reset-missing-on-a-row': {
    file: 'web/main.js',
    edits: [[
      '      const beside = [...(keyButton ? [keyButton] : []), makeResetButton(name)];',
      "      const beside = name === 'noise.speed' ? [...(keyButton ? [keyButton] : [])]\n"
        + "        : [...(keyButton ? [keyButton] : []), makeResetButton(name)];",
    ]],
  },

  // Must redden two rows: the existence row naming the twenty-three parameters on the framing
  // and region inspectors, and the press sweep beside it.
  'reset-skips-a-tab': {
    file: 'web/main.js',
    edits: [[
      '      const beside = [...(keyButton ? [keyButton] : []), makeResetButton(name)];',
      "      const beside = group.tab === 'look'\n"
        + "        ? [...(keyButton ? [keyButton] : []), makeResetButton(name)]\n"
        + "        : [...(keyButton ? [keyButton] : [])];",
    ]],
  },

  // Must redden: one row - section 17's `a preset applied from the picker moves which rows
  // offer a reset, with no reset pressed`.
  'reset-remembers-its-own-state': {
    file: 'web/main.js',
    edits: [
      ['const resetButtons = new Map();', 'const resetButtons = new Map();\nconst resetTouched = new Set();'],
      ['  const modified = value !== resetTarget(name);', '  const modified = resetTouched.has(name);'],
      [
        'function writeFromControl(name, value) {\n  if (refuseEdit(`a change to ${name}`)) {\n    writeControl(name, params.get(name));\n    return;\n  }\n  retainEffectFor(name);\n  const applied = params.set(name, value);',
        'function writeFromControl(name, value) {\n  if (refuseEdit(`a change to ${name}`)) {\n    writeControl(name, params.get(name));\n    return;\n  }\n  retainEffectFor(name);\n  resetTouched.add(name);\n  const applied = params.set(name, value);',
      ],
      [
        '    retainEffectFor(name);\n    params.set(name, resetTarget(name));\n    history.commit();',
        '    retainEffectFor(name);\n    resetTouched.delete(name);\n    params.set(name, resetTarget(name));\n    history.commit();',
      ],
    ],
  },

  // Must redden: two rows - `the reset keeps its box while it is not being offered` and `and
  // nothing else in the row moved between the two states`.
  'reset-collapses-the-slot': {
    file: 'web/index.html',
    edits: [[
      '  .reset[data-modified=no] { visibility: hidden; }',
      '  .reset[data-modified=no] { display: none; }',
    ]],
  },

  // Must redden: two rows - `pressing a reset leaves the caret on that row's own slider` and `a
  // press that shuts the group it was in still leaves the caret somewhere in the panel`.
  'reset-strands-focus': {
    file: 'web/main.js',
    edits: [
      ['    slider.focus();\n', ''],
      [
        "    if (document.activeElement !== slider) {\n"
        + "      const toggle = button.closest('.group')?.querySelector('.grouptoggle');\n"
        + '      if (toggle) toggle.focus();\n'
        + '    }\n',
        '',
      ],
    ],
  },

  // Must redden three rows: the press row reading the registry, the slider and the readout back;
  // the row saying the press stops the reset being offered; and the row saying the group
  // re-derives shut.
  'reset-writes-around-the-registry': {
    file: 'web/main.js',
    edits: [[
      '    params.set(name, resetTarget(name));',
      '    values.set(name, resetTarget(name));',
    ]],
  },

  // Must redden: one row - section 1's `and the format segments follow the document rather than
  // the press that last touched them`.
  'format-segments-paint-the-press': {
    file: 'web/main.js',
    edits: [
      [
        "const EXPORT_CODECS = ['h264', 'prores', 'pngseq'];",
        "const EXPORT_CODECS = ['h264', 'prores', 'pngseq'];\nlet formatPressed = null;",
      ],
      ["  const codec = activeDeliverable?.codec ?? 'h264';", "  const codec = formatPressed ?? 'h264';"],
      [
        '  button.addEventListener(\'click\', () => setExportCodec(button.dataset.codec));',
        '  button.addEventListener(\'click\', () => { formatPressed = button.dataset.codec; setExportCodec(button.dataset.codec); });',
      ],
    ],
  },

  'dialog-close-strands-focus': {
    file: 'web/main.js',
    edits: [['      returnFocus?.focus();', '      document.body.focus();']],
  },

  'obs-forgets-custom-resolution': {
    file: 'web/main.js',
    edits: [[
      "  if (![...shell.obsResolution.options].some((option) => option.value === progSizeEl.value)) {\n"
      + "    const option = document.createElement('option');\n"
      + '    option.value = progSizeEl.value;\n'
      + '    option.textContent = `${progSizeEl.value} · current`;\n'
      + "    option.dataset.current = '';\n"
      + '    shell.obsResolution.appendChild(option);\n'
      + '  }',
      '',
    ]],
  },

  'lanes-clear-siblings': {
    file: 'web/main.js',
    edits: [
      [
        '  counters.laneRebuilds++;\n  ui.railLanes.replaceChildren();\n  ui.lanes.replaceChildren();',
        '  counters.laneRebuilds++;\n  for (const el of [...ui.rail.children, ...ui.beds.children]) {\n'
        + "    if (!el.classList.contains('ruler') && el !== ui.playhead) el.remove();\n  }",
      ],
      ['    ui.railLanes.appendChild(rail);', '    ui.rail.appendChild(rail);'],
      ['    ui.lanes.appendChild(bed);', '    ui.beds.insertBefore(bed, ui.playhead);'],
    ],
  },

  'picker-drops-focus-on-rebuild': {
    file: 'web/main.js',
    edits: [[
      '  if (back) back.focus();\n  else closePicker(picker, { restoreFocus: true });',
      '  if (back) picker.list.blur();',
    ]],
  },
  'picker-offers-a-builtin-delete': {
    file: 'web/main.js',
    edits: [[
      '    if (!doc.builtin) {\n      const remove = document.createElement(\'button\');',
      '    if (true) {\n      const remove = document.createElement(\'button\');',
    ]],
  },
  'export-codecs-drops-an-entry': {
    file: 'web/main.js',
    edits: [[
      "const EXPORT_CODECS = ['h264', 'prores', 'pngseq'];",
      "const EXPORT_CODECS = ['h264', 'prores'];",
    ]],
  },
  'keynav-never-disables': {
    file: 'web/main.js',
    edits: [[
      "  ui.prevKey.disabled = neighbourKeyTime(-1) === null;\n"
      + '  ui.nextKey.disabled = neighbourKeyTime(1) === null;',
      '  ui.prevKey.disabled = false;\n  ui.nextKey.disabled = false;',
    ]],
  },
  'keynav-walks-to-the-far-key': {
    file: 'web/main.js',
    edits: [[
      '  return direction < 0 ? Math.max(...times) : Math.min(...times);',
      '  return direction < 0 ? Math.min(...times) : Math.max(...times);',
    ]],
  },
  'orbit-pumps-on-change': {
    file: 'web/main.js',
    edits: [[
      '      .finally(() => { draftBusy = false; });',
      '      .finally(() => {\n        draftBusy = false;\n'
      + '        if (orbitRedrawWanted) pumpParkedDraft();\n      });',
    ]],
  },

  'orbit-uses-scrub-draft': {
    file: 'web/main.js',
    edits: [[
      '    draftBusy = true;\n'
      + '    timeline.redrawHere()\n'
      + '      .catch(showTimelineError)\n'
      + '      .finally(() => { draftBusy = false; });',
      '    draftWanted = timeline.programSec;\n    pumpDraft();',
    ]],
  },

  'camera-motion-keeps-history': {
    file: 'web/main.js',
    edits: [[
      '    if (renderedCameraChanged()) {',
      '    if (false && renderedCameraChanged()) {',
    ]],
  },

  // The rule this program has already broken once: a pointer move that starts a redraw instead
  // of arming one. Must redden the two rebuild rows of 22b and nothing else.
  // The pre-clip-row build of the delete: the strip left holding nothing, which greys the panel's
  // clip half over an edit that still has clips to edit. Must redden section 22's
  // "puts the strip on whatever took its place".
  'delete-leaves-nothing-selected': {
    file: 'web/main.js',
    edits: [[
      "  clipLanesShut.delete(clip.id);\n"
      + "  // Onto whatever took its place rather than onto nothing: the panel's clip half greys when the\n"
      + "  // strip holds no clip, and an edit that still has clips has one under the panel.\n"
      + '  selectClipRow(clips[Math.min(at, clips.length - 1)]);',
      '  selection = null;\n'
      + '  // Before the cloud goes, because the render core is pointed at whatever is selected.\n'
      + '  if (selectedClip === clip) selectClip(clips[Math.min(at, clips.length - 1)]);',
    ]],
    fails: 'the delete leaving the strip on no clip at all, which greys the panel\'s clip half '
      + 'over an edit that still has clips to edit. Reddens section 22\'s "puts the strip on '
      + 'whatever took its place"',
  },
  'live-delete-skips-reseek': {
    file: 'web/main.js',
    edits: [
      [
        '  const gen = takeTransport();\n'
        + '  const wasPlaying = timeline.playing || timeline.pendingPlay;\n'
        + '  const held = timeline.programSec;\n'
        + '  timeline.pause();\n'
        + '  const at = clips.indexOf(clip);',
        '  const at = clips.indexOf(clip);',
      ],
      [
        '  timeline.seek(Math.min(held, timeline.duration))\n'
        + '    .then(() => { if (wasPlaying && gen === transportGen) return timeline.play(); })\n'
        + '    .catch(showTimelineError);\n',
        '',
      ],
    ],
    fails: 'the live-delete row in section 22: deleting a clip during playback does not reseek '
      + 'the surviving composite before it resumes',
  },
  // The project loader choosing the clip the page happened to be on, which is a guess wearing
  // the shape of an answer. Must redden exactly 22b's "loading a project selects no clip" - the
  // take half is a different door and is untouched by this.
  'project-load-keeps-the-selection': {
    file: 'web/main.js',
    edits: [[
      "  // A document does not record which clip was being worked on - two people's saves of one edit\n"
      + '  // would differ over nothing - so loading one selects none, and the panel\'s clip half greys\n'
      + '  // until somebody says which clip they mean. That is the case the split is worth showing in:\n'
      + '  // a project is where there is a choice to make.\n'
      + '  deselectClipRow();\n',
      '',
    ]],
    fails: 'the project loader keeping whichever clip the page happened to be on, which is a '
      + 'guess wearing the shape of an answer. Reddens 22b\'s "loading a project selects no '
      + 'clip"; the take half is a different door and is untouched by it',
  },
  'deselected-clip-gestures-stay-live': {
    file: 'web/main.js',
    edits: [[
      'const clipGestureLive = () => !EDITING || clipRow !== null;',
      'const clipGestureLive = () => true;',
    ]],
    fails: 'the clip gesture gate held open after the strip deselects every clip. Section 22b '
      + 'reddens the crop furniture, an actual drag at its old handle, the M shortcut and the '
      + 'hidden navigation shortcuts',
  },
  'deselected-mark-delete-stays-live': {
    file: 'web/main.js',
    edits: [
      [[
        '  clipRow = null;',
        '  selectedMark = null;',
        '  selection = null;',
      ].join('\n'), [
        '  clipRow = null;',
        '  selection = null;',
      ].join('\n')],
      [[
        'async function deleteMark(mark) {',
        '  if (!clipGestureLive()) {',
        "    say('select a clip before deleting a mark');",
        '    return false;',
        '  }',
        '  const id = openTakeId();',
      ].join('\n'), [
        'async function deleteMark(mark) {',
        '  const id = openTakeId();',
      ].join('\n')],
    ],
    fails: 'deselection keeping the mark object selected and the delete door accepting it. '
      + 'Section 22b reddens the hidden Delete POST row',
  },
  'gizmo-renders-from-the-pointer': {
    file: 'web/main.js',
    edits: [[
      "  gizmo.addEventListener('objectChange', () => { gizmoWriteWanted = true; });",
      "  gizmo.addEventListener('objectChange', () => { gizmoWriteWanted = true; pumpGizmo(); lanesChanged(); });",
    ]],
    fails: 'the clip handles writing and rebuilding the lane stack from the pointer event rather '
      + 'than arming a redraw the animation loop pumps. Reddens the two rebuild rows of 22b: '
      + '30 rebuilds for 30 moves, against the 34-for-one this program has shipped',
  },
  'gizmo-drag-keeps-orbit-ownership': {
    file: 'web/main.js',
    edits: [[
      "    if (e.value) {\n"
        + '      // Orbit sees the shared pointerdown first; the gizmo owns this gesture from here.\n'
        + '      orbiting = false;\n'
        + '      orbitSettling = false;\n'
        + '      orbitRedrawWanted = false;\n'
        + '      return;\n'
        + '    }',
      '    if (e.value) return;',
    ]],
    fails: 'the move handles leaving the orbit gesture armed after claiming the pointer. '
      + 'Section 22b reddens the before-release render row',
  },
  'gizmo-runs-through-the-look': {
    file: 'web/main.js',
    edits: [['  gizmoScene.add(gizmoHelper);', '  scene.add(gizmoHelper);']],
    fails: 'the clip handles drawn into the scene before the post chain rather than over its '
      + 'finished picture. Reddens 22b\'s neutral-versus-Blackwall axis-pixel row',
  },
  'gizmo-stays-enabled-during-export': {
    file: 'web/main.js',
    edits: [[
      '  const on = gizmoMode !== null && clipRow !== null && !exporting;',
      '  const on = gizmoMode !== null && clipRow !== null;',
    ]],
    fails: 'the export-ownership row reading the transform picker itself: the helper is hidden '
      + 'but its invisible hit target stays enabled for the export',
  },
  'preset-includes-framing': {
    file: 'web/main.js',
    edits: [[
      "function presetValueNames() {\n  return params.names('look').filter((name) => presetCarriesLookName(name, PARAMS[name].group));\n}",
      "function presetValueNames() {\n  return params.names('look');\n}",
    ]],
    fails: 'framing admitted into the preset contract. The export-ownership arm loses its '
      + 'whole-look stamp, and section 22b reddens the None reset, subset-picker and '
      + 'stored-document refusal rows',
  },
  // A preset's cloud half written to every clip rather than to the selected one, which is the
  // whole of what makes a look a clip's own. Must redden 22b's "and on no other clip".
  'preset-writes-every-clip': {
    file: 'web/main.js',
    edits: [['  if (target) withClip(target, () => params.apply(clipValues));',
      '  if (target) forEachLook(() => params.apply(clipValues));']],
    fails: 'a preset\'s cloud half written to every clip rather than to the selected one, which '
      + 'is the whole of what makes a look a clip\'s own. Reddens 22b\'s "and on no other '
      + 'clip"',
  },
  'orbit-arms-into-playback': {
    file: 'web/main.js',
    edits: [[
      '  if (!timeline || timeline.playing || exporting) {\n'
      + '    draftWanted = null;\n    orbitRedrawWanted = false;\n    orbitSettling = false;\n'
      + '    flyWasHeld = false;\n    gizmoWriteWanted = false;\n    return;\n  }',
      '  if (!timeline || timeline.playing || exporting) return;',
    ]],
  },

  'release-seeks-past-target': {
    file: 'web/main.js',
    edits: [[
      '    timeline.seekHere().catch(showTimelineError);',
      '    timeline.seek(timeline.programSec + 1).catch(showTimelineError);',
    ]],
  },

  'orbit-arms-stale-position': {
    file: 'web/main.js',
    edits: [[
      '  if ((!orbiting && !orbitSettling) || !timeline || timeline.playing) return;\n'
      + '  orbitRedrawWanted = true;',
      '  if ((!orbiting && !orbitSettling) || !timeline || timeline.playing) return;\n'
      + '  draftWanted = timeline.programSec;',
    ]],
  },

  'camkey-takes-the-passing-pose': {
    file: 'web/main.js',
    edits: [[
      '  finishOrbitDrift();\n  freeCamera.updateMatrixWorld(true);',
      '  freeCamera.updateMatrixWorld(true);',
    ]],
  },

  'pin-keeps-orbit-armed': {
    file: 'web/main.js',
    edits: [[
      '      draftWanted = null;\n      orbitRedrawWanted = false;\n      orbitSettling = false;\n'
      + '      renderer.setAnimationLoop(null);',
      '      renderer.setAnimationLoop(null);',
    ]],
  },

  'rate-holds-program': {
    file: 'web/main.js',
    edits: [[
      'return Math.max(0, Math.min(programSecOfSource(rateGesture.source), timeline.duration));',
      'return Math.max(0, Math.min(timeline.programSec, timeline.duration));',
    ]],
  },

  'rate-rescales-cuts': {
    file: 'web/main.js',
    edits: [[
      '  rescaleClipKeys(was.keys, k, was.pivot);',
      '  rescaleClipKeys(was.keys, k, was.pivot);\n  setClipInOut({ in: clipIn * k, out: clipOut === null ? null : clipOut * k });',
    ]],
  },

  'rate-holds-keys': {
    file: 'web/main.js',
    edits: [[
      '  rescaleClipKeys(was.keys, k, was.pivot);',
      '  rescaleClipKeys(was.keys, 1, was.pivot);',
    ]],
  },

  'rate-window-stays-fractional': {
    file: 'web/main.js',
    edits: [[
      "    window: clips.length === 1 && selectedClipRow()?.start === 0\n"
      + "      ? null : { startSec: view.startSec, endSec: view.endSec },",
      '    window: null,',
    ]],
    fails: 'the multi-clip ruler row in section 22b: its 10s start moves to about 5.6s when the '
      + 'selected clip shortens the project under stale fractions',
  },

  'clip-drag-keeps-playing': {
    file: 'web/main.js',
    edits: [[
      '    const wasPlaying = timeline.playing || timeline.pendingPlay;\n'
      + '    timeline.pause();\n    clipDrag = {',
      '    const wasPlaying = timeline.playing || timeline.pendingPlay;\n    clipDrag = {',
    ]],
    fails: 'the live clip-drag pause row in section 22b: playback stays live while the mapping '
      + 'moves instead of yielding the accumulator state first',
  },

  'added-clip-skips-reseek': {
    file: 'web/main.js',
    edits: [
      [[
        '  const gen = takeTransport();',
        '  const wasPlaying = timeline.playing || timeline.pendingPlay;',
        '  const held = timeline.programSec;',
        '  timeline.pause();',
        '  const clip = new Clip(mintClipId(), livePairs, createClipCloud());',
      ].join('\n'), [
        '  const gen = transportGen;',
        '  const wasPlaying = timeline.playing;',
        '  const held = timeline.programSec;',
        '  const clip = new Clip(mintClipId(), livePairs, createClipCloud());',
      ].join('\n')],
      [[
        '  history.commit();',
        '  await timeline.seek(Math.min(held, timeline.duration));',
        '  if (wasPlaying && gen === transportGen) await timeline.play();',
      ].join('\n'), '  history.commit();'],
    ],
    fails: 'the delayed-add pre-roll row in section 22: the new clip enters behind a live '
      + 'playhead without yielding and rebuilding its accumulator history',
  },

  'zoom-about-centre': {
    file: 'web/main.js',
    edits: [[
      '    if (!view.zoomAbout(clipFractionAt(surface, e.clientX), factor)) return;',
      '    if (!view.zoomAbout((view.a + view.b) / 2, factor)) return;',
    ]],
  },

  'pointer-ignores-view': {
    file: 'web/view-window.js',
    edits: [[
      '    timeAt(clientX) {\n'
      + '      const r = bedRect();\n'
      + '      const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;\n'
      + '      return Math.max(0, Math.min(this.duration, (this.a + f * (this.b - this.a)) * this.duration));',
      '    timeAt(clientX) {\n'
      + '      const r = bedRect();\n'
      + '      const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0;\n'
      + '      return f * this.duration;',
    ]],
  },

  'marks-ignore-view': {
    file: 'web/main.js',
    edits: [[
      '    el.style.left = `${view.pct(at)}%`;\n    el.hidden = !view.holds(at);',
      '    el.style.left = `${(at / total) * 100}%`;',
    ]],
  },

  // The out-point stops the take whether or not the loop is armed, which is the whole of what
  // the button does. Reddens the armed row and leaves the unarmed one green.
  'loop-never-wraps': {
    file: 'web/main.js',
    edits: [[
      '      if (this.looping) this.seek(this.clipInSec).catch(showTimelineError);\n      else this.pause();',
      '      this.pause();',
    ]],
  },

  // The mark gesture plants and never removes, which is what the key did before both doors were
  // made one edit: the second press leaves two marks stacked at one source second.
  'mark-never-toggles': {
    file: 'web/main.js',
    edits: [[
      '  return onMark ? deleteMark(onMark) : markHere();',
      '  return markHere();',
    ]],
  },

  // The cross on a group's header is drawn and does nothing, which a sweep counting controls
  // cannot see: it is there, it is pressable, and the press is the part that is missing.
  'group-head-remove-inert': {
    file: 'web/main.js',
    edits: [[
      "    remove.addEventListener('click', () => removeEffectFromRack(owner));",
      "    remove.addEventListener('click', () => {});",
    ]],
  },

  'splitter-unclamped': {
    file: 'web/main.js',
    edits: [[
      '  const height = Math.max(0, Math.min(wanted, laneHeightCeiling()));',
      '  const height = Math.max(0, wanted);',
    ]],
  },

  'rail-ignores-scroll': {
    file: 'web/main.js',
    edits: [[
      "ui.lanes.addEventListener('scroll', () => {\n  ui.railLanes.scrollTop = ui.lanes.scrollTop;\n});",
      "ui.lanes.addEventListener('scroll', () => {});",
    ]],
  },

  'mini-wheel-uses-ruler': {
    file: 'web/main.js',
    edits: [[
      '  return surface === ui.mini ? f : view.a + f * (view.b - view.a);',
      '  return view.a + f * (view.b - view.a);',
    ]],
  },

  'splitter-forgets': {
    file: 'web/main.js',
    edits: [[
      '    localStorage.setItem(LANES_HEIGHT, String(userLaneHeight));',
      '    void LANES_HEIGHT;',
    ]],
  },

  'shortcuts-ignore-consumed': {
    file: 'web/main.js',
    edits: [['  if (e.defaultPrevented) return;\n', '']],
  },

  'takeover-ignored': {
    file: 'web/main.js',
    edits: [
      ['  dropRateGesture();\n  return transportGen;', '  return transportGen;'],
      ['  const { wasPlaying, applied, rate: began, gen } = rateGesture;',
        '  const { wasPlaying, applied, rate: began } = rateGesture;\n  const gen = transportGen;'],
    ],
  },

  'window-clamp-ratchets': {
    file: 'web/main.js',
    edits: [['  view.reclamp();', '  view.set(view.a, view.b);']],
  },

  'detent-eats-loaded-rate': {
    file: 'web/main.js',
    edits: [[
      '  const holding = rateGesture ? rateGesture.detentArmed === false : false;\n'
      + '  return !holding && insideDetent(v) ? 1 : Number(rawRateFromSlider(v).toFixed(3));',
      '  return insideDetent(v) ? 1 : Number(rawRateFromSlider(v).toFixed(3));',
    ]],
  },

  'anchor-floors-to-frame': {
    file: 'web/main.js',
    edits: [[
      'return Math.max(0, Math.min(this.lastFrame, Math.round(programSec * this.outputFps)));',
      'return Math.max(0, Math.min(this.lastFrame, Math.floor(programSec * this.outputFps)));',
    ]],
  },

  'keyup-ends-any-gesture': {
    file: 'web/main.js',
    edits: [[
      "ui.rate.addEventListener('keyup', (e) => {\n"
      + '  if (rateGesture && rateGesture.fromKey === e.key) endRateGesture();\n'
      + '});',
      "ui.rate.addEventListener('keyup', endRateGesture);",
    ]],
  },

  'pause-keeps-resume': {
    file: 'web/main.js',
    edits: [['const pauseTransport = () => {\n  takeTransport();\n  timeline.pause();\n};',
      'const pauseTransport = () => {\n  timeline.pause();\n};']],
  },

  'clip-range-unclamped': {
    file: 'web/clip-range.js',
    edits: [[
      '  if (dur !== null) {\n'
      + '    clipIn = Math.max(0, Math.min(clipIn, dur));\n'
      + '    // `null` still means "to the end", which is a different statement from a number that\n'
      + '    // happens to equal the duration: "whole clip" has to survive a speed change that lengthens\n'
      + '    // the program, and a duration written in here would freeze it at today\'s length.\n'
      + '    if (clipOut !== null) clipOut = Math.max(clipIn, Math.min(clipOut, dur));\n'
      + '  }\n',
      '',
    ]],
  },

  'clip-bound-coerces-nonnumeric': {
    file: 'web/clip-range.js',
    edits: [
      [
        "  if (value === null && which === 'out') return null;\n"
        + '  if (typeof value === \'number\' && Number.isFinite(value)) return value;\n',
        "  if (value === null && which === 'out') return null;\n"
        + '  return value;\n',
      ],
    ],
  },

  'refusal-strands-the-picker': {
    file: 'web/main.js',
    edits: [[
      "    ui.deliverable.value = ui.deliverable.dataset.adopted ?? '';\n",
      '',
    ]],
  },

  'resize-skips-repaint': {
    file: 'web/main.js',
    edits: [[
      '  const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());\n'
      + '  if (buffer.x !== wasBuffer.x || buffer.y !== wasBuffer.y) requestRepaint();\n',
      '',
    ]],
  },

  'restore-accepts-view-track': {
    file: 'web/main.js',
    edits: [
      [
        '    const spec = params.spec(name);\n    if (spec.scope !== scope) {',
        '    const spec = params.spec(name);\n    if (spec.scope !== scope && spec.tag === \'look\') {',
      ],
    ],
  },

  'bounds-compare-off-grid': {
    file: 'web/main.js',
    edits: [[
      '    if (timeline.frame < frameIn) timeline.seek(clipIn).catch(showTimelineError);\n'
      + '    else if (frameOut !== null && timeline.frame > frameOut) timeline.seek(clipOut).catch(showTimelineError);',
      '    if (timeline.programSec < clipIn) timeline.seek(clipIn).catch(showTimelineError);\n'
      + '    else if (clipOut !== null && timeline.programSec > clipOut) timeline.seek(clipOut).catch(showTimelineError);',
    ]],
  },

  'detent-in-rate-units': {
    file: 'web/main.js',
    edits: [[
      '  const width = ui.rate.getBoundingClientRect().width || 92;\n'
      + '  return Math.abs(Number(v) - sliderFromRate(1)) <= DETENT_PX / Math.max(1, width);',
      '  return Math.abs(rawRateFromSlider(v) - 1) <= 0.03;',
    ]],
  },

  'zoom-pans-at-the-clamp': {
    file: 'web/view-window.js',
    edits: [[
      '      const span = Math.min(1, Math.max(this.minSpan(), (this.b - this.a) / factor));\n'
      + '      // Where the anchor sits in the window now, kept where it is in the window after.\n'
      + '      const held = (at - this.a) / Math.max(1e-9, this.b - this.a);\n'
      + '      const start = at - held * span;',
      '      const span = (this.b - this.a) / factor;\n'
      + '      const start = at - (at - this.a) / factor;',
    ]],
  },

  'deliverable-keeps-gesture': {
    file: 'web/main.js',
    edits: [['  dropRateGesture();\n  setActiveDeliverable(deliverable);', '  setActiveDeliverable(deliverable);']],
  },

  'keys-yield-touch': {
    file: 'web/index.html',
    edits: [['  .tkey, .thandle { touch-action: none; }', '  .tkey, .thandle { touch-action: pan-y; }']],
  },

  'wheel-ignores-deltamode': {
    file: 'web/main.js',
    edits: [[
      "  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {\n"
      + '    return { x: e.deltaX * LANE_KEY_STEP, y: e.deltaY * LANE_KEY_STEP };\n'
      + '  }\n',
      '',
    ]],
  },

  'pan-keys-unbound': {
    file: 'web/main.js',
    edits: [[
      "    case ',': case '<': e.preventDefault(); if (view.panBy(-0.25)) viewChanged(); return;\n"
      + "    case '.': case '>': e.preventDefault(); if (view.panBy(0.25)) viewChanged(); return;\n",
      '',
    ]],
  },

  'lanes-eat-touch': {
    file: 'web/index.html',
    edits: [[
      '.tlane { position: relative; height: 100%; touch-action: pan-y; }',
      '.tlane { position: relative; height: 100%; touch-action: none; }',
    ]],
  },

  'rate-ends-on-change': {
    file: 'web/main.js',
    edits: [[
      "ui.rate.addEventListener('change', () => { if (!rateGesture?.fromKey) endRateGesture(); });",
      "ui.rate.addEventListener('change', endRateGesture);",
    ]],
  },

  'space-unbound': {
    file: 'web/main.js',
    edits: [[
      '      if (timeline.playing || timeline.pendingPlay) pauseTransport();\n'
      + '      else timeline.play().catch(showTimelineError);\n      return;',
      '      return;',
    ]],
  },

  'delete-ignores-selection': {
    file: 'web/main.js',
    edits: [[
      'function deleteSelectedKey() {\n  if (!timeline || !selection) return false;',
      'function deleteSelectedKey() {\n  if (!timeline || !selection || timeline) return false;',
    ]],
  },

  'ease-handles-on-flat': {
    file: 'web/main.js',
    edits: [
      ['    if (!segmentHasShape(keys, seg, row.kind)) continue;\n', ''],
      ['      if (!segmentHasShape(keys, seg, row.kind)) return false;\n', ''],
    ],
  },

  'ease-gate-hardcodes-scalar': {
    file: 'web/main.js',
    edits: [[
      '  if (!row || !KINDS[row.kind].eases) return null;',
      "  if (!row || row.kind !== 'scalar') return null;",
    ]],
    fails: 'the ease gate naming one kind instead of asking the table, which is what locked the '
      + 'camera out',
  },

  'pose-handle-overshoots': {
    file: 'web/main.js',
    edits: [[
      "    if (KINDS[row.kind].overshoots) h[1] = Math.min(2, Math.max(-1, h[1]));\n"
        + '    else h[1] = Math.min(1, Math.max(0, h[1]));',
      "    if (KINDS[row.kind].overshoots || row.kind === 'pose') h[1] = Math.min(2, Math.max(-1, h[1]));\n"
        + '    else h[1] = Math.min(1, Math.max(0, h[1]));',
    ]],
    fails: 'a pose handle leaving the unit box, which sends the camera past the pose it was '
      + 'keyed at',
  },

  'pose-lane-draws-flat': {
    file: 'web/main.js',
    edits: [[
      '  at: (owner, t) => poseLaneFraction(keysOf(owner), t),',
      '  at: () => 0.5,',
    ]],
    fails: 'the lane\'s drawn curve, which every other pose row reads past on its way to the '
      + 'evaluator',
  },

  'beads-evenly-spaced': {
    file: 'web/main.js',
    edits: [[
      '  const out = [];\n'
      + '  for (let i = 0; i < points.length; i += BEAD_EVERY) out.push(points[i]);\n'
      + '  return out;',
      '  const seg = [];\n'
      + '  let total = 0;\n'
      + '  for (let i = 1; i < points.length; i++) {\n'
      + '    const d = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1],\n'
      + '      points[i][2] - points[i - 1][2]);\n'
      + '    total += d;\n'
      + '    seg.push(total);\n'
      + '  }\n'
      + '  const want = Math.ceil(points.length / BEAD_EVERY);\n'
      + '  const out = [];\n'
      + '  for (let n = 0; n < want; n++) {\n'
      + '    const target = (total * n) / Math.max(1, want - 1);\n'
      + '    let i = seg.findIndex((s) => s >= target);\n'
      + '    if (i < 0) i = points.length - 2;\n'
      + '    out.push(points[i]);\n'
      + '  }\n'
      + '  return out;',
    ]],
    fails: 'and the path\'s beads marking distance rather than time, which is an overlay that '
      + 'redraws the route',
  },

  'pose-segments-never-shaped': {
    file: 'web/main.js',
    edits: [[
      '  moved: (a, b) => poseMoved(a.value, b.value),',
      '  moved: () => false,',
    ]],
    fails: 'and a pose segment that never has a shape to edit, which is the NaN the old '
      + 'subtraction returned',
  },

  'handle-clamped-to-the-segment': {
    file: 'web/main.js',
    edits: [[
      `    h[0] = foldFreeX(a.easeOut, b.easeIn, laneDrag.side, laneDrag.index, h[0],
      Math.min(span.hi, Math.max(span.lo,
        (programToLane(row.owner, laneProgramAt(e.clientX)) - a.t) / dt)));`,
      `    h[0] = Math.min(1, Math.max(0,
      (programToLane(row.owner, laneProgramAt(e.clientX)) - a.t) / dt));`,
    ]],
    fails: 'a control point clamped to the segment\'s ends rather than to its own neighbours, '
      + 'which was complete while a side held one point - then the neighbours *were* the ends '
      + '- and lets two cross once a side holds more. Only a drag of a point that is not '
      + 'index 0 can see it',
  },

  'elevation-moves-the-curve': {
    file: 'web/curve.js',
    edits: [[
      `  const cut = side === 'easeOut' ? a.length + 1 : a.length;
  return { easeOut: raised.slice(0, cut), easeIn: raised.slice(cut) };`,
      `  const grown = side === 'easeOut' ? { easeOut: [...a, [0.5, 0.5]], easeIn: b } : { easeOut: a, easeIn: [[0.5, 0.5], ...b] };
  return raised.length ? grown : grown;`,
    ]],
    fails: '`+pt` appending a control point rather than elevating, which is the one wrong '
      + 'implementation that leaves the count right and moves the camera. Only the '
      + 'sampled-curve row can see it, which is why that row samples the render instead of '
      + 'reading the handles back - every handle is meant to move',
  },

  'ends-reaches-the-selection': {
    file: 'web/main.js',
    edits: [[
      `  if (spec.firstOut && segmentHasShape(keys, 0, kind)) {
    keys[0].easeOut = copyHandle(spec.firstOut);
  }`,
      `  if (spec.firstOut && segmentHasShape(keys, 0, kind)) {
    keys[i].easeOut = copyHandle(spec.firstOut);
  }`,
    ]],
    fails: '`ends` shaping the selected key instead of the move\'s two ends, which is `smooth` '
      + 'under another name and halts the camera at an interior key',
  },

  'ends-skips-the-arrival': {
    file: 'web/main.js',
    edits: [[
      `  if (spec.lastIn && segmentHasShape(keys, keys.length - 2, kind)) {
    keys[keys.length - 1].easeIn = copyHandle(spec.lastIn);
  }`,
      '  if (false && spec.lastIn) { /* mutated */ }',
    ]],
    fails: 'and reaching only the departure, which is half the reported defect surviving the fix '
      + 'for it',
  },

  'glide-is-a-cubic': {
    file: 'web/main.js',
    edits: [[
      "  glide: { out: [[0.2, 0], [0.4, 0]], in: [[0.6, 1], [0.8, 1]] },",
      "  glide: { out: [[0.2, 0]], in: [[0.8, 1]] },",
    ]],
    fails: 'the quintic dropped to a cubic, whose rate still reaches zero at the key - so every '
      + 'velocity row stays green and only the degree is gone with the acceleration claim '
      + 'resting on it',
  },

  'ease-preset-ignored': {
    file: 'web/main.js',
    edits: [[
      '  if (spec.out) keys[i].easeOut = copyHandle(spec.out);\n'
      + '  if (spec.in) keys[i].easeIn = copyHandle(spec.in);\n'
      + '  if (spec.nextIn && i < keys.length - 1) keys[i + 1].easeIn = copyHandle(spec.nextIn);',
      '  void spec;',
    ]],
  },

  'scroller-cannot-shrink': {
    file: 'web/index.html',
    edits: [[
      '  .tchips { flex: 1; display: flex; gap: 8px; flex-wrap: nowrap; align-items: center;\n'
      + '    justify-content: center; min-width: 0; overflow-x: auto; scrollbar-width: none; }',
      '  .tchips { flex: 1; display: flex; gap: 8px; flex-wrap: nowrap; align-items: center;\n'
      + '    justify-content: center; }',
    ]],
  },

  'crop-axes-swapped': {
    file: 'web/cloud-shader.js',
    edits: [[
      '  if (cropOn == 1.0 && (pos.x < cropL || pos.x > cropR || pos.y < cropB || pos.y > cropT)) {',
      '  if (cropOn == 1.0 && (pos.y < cropL || pos.y > cropR || pos.x < cropB || pos.x > cropT)) {',
    ]],
  },

  'crop-in-image-space': {
    file: 'web/cloud-shader.js',
    edits: [[
      '  if (cropOn == 1.0 && (pos.x < cropL || pos.x > cropR || pos.y < cropB || pos.y > cropT)) {',
      '  float wedge = 2.0 / max(0.001, z);\n'
      + '  if (cropOn == 1.0 && (pos.x * wedge < cropL || pos.x * wedge > cropR\n'
      + '   || pos.y * wedge < cropB || pos.y * wedge > cropT)) {',
    ]],
  },

  'export-ignores-name': {
    file: 'web/main.js',
    edits: [['      name: options.name ?? exportBaseName(),', '      name: options.name ?? timeline.clip.source.id,']],
  },

  'project-load-skips-export-recheck': {
    file: 'web/main.js',
    edits: [[
      '  const sources = await sourcesFor(plan);\n'
        + '  if (refuseEdit(`opening ${name}`)) return null;\n'
        + '  refuseResolvedDurations(plan, sources);',
      '  const sources = await sourcesFor(plan);\n'
        + '  refuseResolvedDurations(plan, sources);',
    ]],
    fails: 'two rows: removing the ownership check after footage resolution lets the delayed '
      + 'continuation replace the document, and that replacement also makes the active real '
      + 'export miss the frame its original document owned',
  },
};

/** The mutated source, refused loudly when an anchor no longer matches exactly once. */
function mutatedSource(name) {
  const spec = MUTATIONS[name];
  if (!spec) throw new Error(`unknown mutation ${name} - have ${Object.keys(MUTATIONS).join(', ')}`);
  let source = readFileSync(join(REPO, spec.file), 'utf8');
  for (const [from, to] of spec.edits) {
    const hits = source.split(from).length - 1;
    if (hits !== 1) {
      throw new Error(`mutation ${name} matched ${hits} times in ${spec.file}, expected exactly 1: `
        + `${JSON.stringify(from.slice(0, 90))}`);
    }
    source = source.replace(from, to);
  }
  return { file: spec.file, body: source };
}

// ------------------------------------------------------------------- playwright

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

// --------------------------------------------------------------------- reporting

/**
 * The rows that are red on this tree for reasons that are not the build's, by label.
 *
 * This exists because the mutation verdict below used to compare the failure count against zero.
 * With any standing red, every `--mutate` run reported `caught, as required (2 assertions fired)`
 * whether the control reddened anything or not - measured on `commit-ignores-null-baseline`, which
 * reddens nothing and was recorded as caught off these two rows. A suite with a standing failure
 * is a false-positive generator for its own catch verdict, and the only thing that separates the
 * two populations is knowing which rows were already red.
 *
 * `docs/proof-tools.md` carries the case: both track the length of the take rather than the load
 * on the machine, red on the 243.3s `fixture-1g` and green on a 91.2s one. So a declared row
 * coming back green is reported rather than failed - on a shorter fixture that is the honest
 * reading and not a stale entry - and the report is loud, because an exemption nobody looks at
 * twice is what this table would otherwise become.
 */
const STANDING_RED = new Map([
  ['and never falls back to a rebuild, which is what resized the drawing buffer',
    'flips with the take\'s length; red on the 243.3s fixture-1g, green on a 91.2s one'],
  ['and a double click on a key removes it',
    'flips with the take\'s length; red on the 243.3s fixture-1g, green on a 91.2s one'],
]);

let failures = 0;
let checks = 0;
const fired = [];
const check = (ok, label, detail = '') => {
  checks++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `   ${detail}` : ''}`);
  if (!ok) { failures++; fired.push(label); }
};
const note = (label, detail = '') => console.log(`  ....  ${label}${detail ? `   ${detail}` : ''}`);
const near = (a, b, tol) => Math.abs(a - b) <= tol;

// A throw is the harness not running rather than a finding in either direction.
let crashed = null;
let untested = null;

// ------------------------------------------------------------------- the drivers
// Every interactive control the editor renders has to be covered here, and coverage means "this
// file, or a named file, drives it and watches something change".
const DRIVER_RULES = [
  {
    key: 'keyframe',
    what: 'a keyframe toggle',
    by: 'keyframe-check, and section 5 here deletes what it creates',
    match: (row) => row.kf,
  },
  {
    key: 'recorder',
    what: 'a recorder-surface control',
    by: 'sensor-view-check section 6 and library-check',
    match: (row) => inGroup(row, '#recordGroup', '#recLookGroup', '#sensorGroup', '#monitorGroup'),
  },
  {
    key: 'subset',
    what: 'a control in the dialog that asks which look values a preset carries',
    by: 'section 12 opens it from export and from save, unticks, confirms, cancels, '
      + 'and reads the document that came out',
    // Matched against the serialized row like every rule beside it - an element-shaped match is
    // handed a row with no `closest`, so the dialog's boxes fall through to the panel rule.
    match: (row) => inGroup(row, '#presetPick'),
  },
  {
    // Ahead of `shelldialogs`, because ordering is precedence here and this dialog is driven
    // somewhere else: section 1 walks a page opened on a take, where Rename is greyed and the
    // modal cannot be opened at all. A rule crediting a section that could not reach it would be
    // a claim nothing joins to a press.
    key: 'renamedialog',
    what: 'a control in the modal a project is renamed through',
    by: 'section 13 opens it from the File menu on a page that holds a project, types the name '
      + 'it already has and reads the refusal, then types a new one and follows the file',
    match: (row) => inGroup(row, '#renameDialog'),
  },
  {
    key: 'shelldialogs',
    what: 'a control in the Project settings, Export, OBS, or state dialog',
    by: 'section 1 opens each application dialog, drives every enabled control, and '
      + 'asserts every format the export dialog offers is one the server encodes',
    match: (row) => inGroup(row, '#projectDialog', '#exportDialog', '#obsDialog'),
  },
  {
    key: 'effectrack',
    what: 'a control in the effect rack sidebar',
    by: 'section 1 opens the effect rack, searches, adds every effect, and removes one',
    match: (row) => inGroup(row, '#effectRackPanel'),
  },
  {
    key: 'paneltabs',
    what: 'an inspector tab',
    by: 'section 1 presses all four tabs and reads which declared panel groups remain on screen',
    match: (row) => inGroup(row, '#panelTabs'),
  },
  {
    key: 'groupreveal',
    what: 'the control that shuts or opens a panel group',
    by: 'section 16 reads every collapsible group off the page, presses each one, and '
      + 'asserts the rows under it changed visibility',
    // `row.groupToggle` and not `el.dataset.groupToggle`: a row carries no `dataset`, so the
    // element spelling reads `undefined` and matches nothing.
    match: (row) => Boolean(row.groupToggle),
  },
  {
    key: 'reset',
    what: 'the control that puts one look parameter back on its default',
    by: 'section 17 presses every one of them - the list is the registry\'s, walked per '
      + 'inspector - and reads the registry, the slider and the readout back afterwards; '
      + 'two of the presses are read further, for the group they shut and the caret they left',
    match: (row) => Boolean(row.reset),
  },
  {
    key: 'suppress',
    what: 'the control that lets a render go without an effect this build has not got',
    by: 'section 15b stages a document naming a missing effect, presses this, and reads '
      + 'the suppression back off the page and off the note',
    match: (row) => Boolean(row.suppress),
  },
  {
    key: 'output',
    what: 'a program-out control',
    by: 'vcam-check section 5 sets both from the operator page and reads the source',
    match: (row) => inGroup(row, '#programOutGroup'),
  },
  {
    key: 'camera',
    what: 'a camera-composition control',
    by: 'keyframe-check drives the path; sensor-view-check drives `sensor view`',
    match: (row) => inGroup(row, '#cameraGroup') || row.id === 'camSensor',
  },
  {
    key: 'mark',
    what: 'a mark tick on the ruler',
    by: 'section 13 presses a tick under a non-unity rate and reads where the playhead landed',
    match: (row) => row.mark,
  },
  {
    key: 'appbar',
    what: 'an application-bar command or navigation link',
    by: 'section 1 opens every menu, drives the commands that stay on this page, and '
      + 'asserts the two real navigation destinations in the markup',
    // `#navRow` plus a menu wrapper, not `#appBar`: written as the container this rule covered any
    // button the bar grew, and `plant-unswept-control` passed while planting one beside `#tNote`.
    match: (row) => inGroup(row, '#navRow') && (inGroup(row, '.appmenu') || row.tag === 'A'),
  },
  {
    key: 'preset',
    what: 'an entry, its delete, or the add button inside the preset picker',
    // Before the panel-wide rule below it, because that one is the widest and
    // ordering is precedence.
    by: 'section 19 opens the picker, walks it with the keyboard, applies an entry, '
      + 'and deletes one and reads where the caret went',
    match: (row) => inGroup(row, '#lookPresetGroup')
      && (row.tag === 'DIV' || row.label.startsWith('Delete preset') || row.id === 'tPresetAdd'),
  },
  {
    key: 'groupremove',
    what: "the remove button in an effect group's own header",
    by: "section 1 presses one and reads the effect leaving the sidebar, then adds it back",
    match: (row) => Boolean(row.groupRemove),
  },
  {
    key: 'look',
    what: 'a look parameter slider or checkbox',
    by: "registry-check's drop-one sweep proves each one reaches the pixels",
    match: (row) => inGroup(row, '#panel') && (row.type === 'range' || row.type === 'checkbox'),
  },
];

/** Whether a swept control sits inside any of these ancestors. */
// Hoisted above the rules, because they call it and a `const` read before its own
// declaration is a TDZ error.

// This tool's own document writes, each carrying the revision the store is at: every change
// to a document names the one it was made against, and these are creates and cleanups
// against a store this run owns.
async function writeProjectDoc(name, init) {
  const at = `${URL_BASE}/projects/${encodeURIComponent(name)}`;
  const read = await fetch(at);
  const held = read.ok ? (await read.json().catch(() => null))?.rev : null;
  return fetch(`${at}?rev=${encodeURIComponent(held ?? 'absent')}`, init);
}

async function writePresetDoc(name, init) {
  const at = `${URL_BASE}/presets/${encodeURIComponent(name)}`;
  const read = await fetch(at);
  const held = read.ok ? (await read.json().catch(() => null))?.rev : null;
  return fetch(`${at}?rev=${encodeURIComponent(held ?? 'absent')}`, init);
}

async function armDocumentWrites(target) {
  await target.addInitScript(() => {
    globalThis.__ecWrite = async (at, init) => {
      // Off the listing, so a name with no file behind it does not answer a 404 this run then
      // has to explain to its own page-error sweep.
      const kind = at.split('/')[1];
      // `/projects` is the page; the listing under it is `/projects/all`.
      const listed = await (await fetch(kind === 'projects' ? '/projects/all' : `/${kind}`)).json();
      const held = (listed[kind] ?? []).find((doc) => at.endsWith(encodeURIComponent(doc.name)))?.rev;
      return fetch(`${at}?rev=${encodeURIComponent(held ?? 'absent')}`, init);
    };
  });
}

function inGroup(row, ...groups) {
  return groups.some((g) => row.groups.includes(g));
}

const DRIVER_IDS = {
  tPreviewRender: 'preview-check renders a range and reads the cached pixels during playback',
  tPreviewAuto: 'preview-check starts idle rendering and interrupts it through this checkbox',
  tPreviewClear: 'preview-check clears during a render and refuses late results',
  tAddClip: 'section 22 - opens the picker, chooses a take, and reads the clip that landed',
  tDeleteClip: 'section 22 - deletes the selected clip and undoes it',
  tMoveClip: 'section 22b - arms the move handles, drags them and reads where the clip went',
  tRotateClip: 'section 22b - arms the turn handles and reads that the mode moved with the press',
  tKeyClip: 'section 22b - keys the placement at two playheads and scrubs between them',
  tPlay: 'section 2 - toggles playback and the state is read back',
  tLoop: 'section 2 - runs playback into the out-point with it off and with it armed, and reads '
    + 'where the playhead ended up each time',
  tRate: 'section 4 - the anchor rows and the seek-storm row',
  tCamView: 'section 1 - looks through the program camera and reads the orbit back',
  effectRackOpen: 'section 1 - opens the installed-effect search, adds every effect, and removes one',
  menuWholeClip: 'section 3 - clears the range through both its menu command and keyboard shortcut',
  // `tFps` is deliberately not here: it moved into Project settings with the rate itself, so
  // the `shelldialogs` rule covers it and section 1 drives it.
  tMark: 'library-check writes a mark and reads the sidecar back',
  tDeleteKey: 'section 5 - removes the selected key',
  tAddPoint: 'section 5 - grows a segment\'s degree and reads the curve back unmoved',
  tDropPoint: 'section 5 - shrinks it again',
  tPrevKey: 'section 18 - walks the selected track and reads which key the playhead landed on',
  tNextKey: 'section 18 - walks the selected track and reads which key the playhead landed on',
  tPreset: 'library-check applies a preset and compares the look',
  tPresetSave: 'library-check',
  tPresetExport: 'section 9 - exports the look and reads the file the browser wrote',
  tPresetImport: 'section 9 - opens the picker the file input is the other half of',
  tPresetFile: 'section 9 - a file is set on it and the look it names arrives',
  toMenu: 'section 1 - reads the href it navigates to, beside the library link',
  tDeliverable: 'section 6 - plants a long name in it and reads back which one the picker is left on',
  tDeliverableNew: 'section 1 - presses it and reads the prompt it opens, the way Save as is driven',
  tExportName: 'section 7 - names the file and refuses a path',
  tExportSize: 'export-check sweeps every size the menu offers',
  tExport: 'section 6 asserts it is reachable, section 7 renders with it',
  tExportSave: 'section 7 - the saved copy, against a stubbed picker',
  cropReset: 'section 8 - opens the crop box again and the planes are read back',
  cropFit: 'section 8b - presses it on a document opened out to +/-6 and reads back both the '
    + 'planes it restores and the undo entry it makes',
  cropBox: 'section 20 - presses it, reads the handles it puts on screen, drags one of them '
    + 'and counts what the gesture cost the animation loop',
  camLevelReset: 'level-check section 5 - clicks this element and reads both axes and both sliders at neutral',
  menuShowSidebar: 'section 21 - collapses the panel from the View menu and restores it from the key, '
    + 'and reads the class, the control and the buffer back across the round trip',
  dockCentre: 'section 21 - presses it and reads the pose against the one the View menu\'s own reset lands',
  dockSensor: 'section 21 - presses it and reads the pose against the one Framing\'s own sensor view lands',
  dockMark: 'section 21 - asserts the editor does not offer it, which is all this surface '
    + 'should show of a control the recorder owns',
  dockRec: 'section 21 - asserts the editor does not offer it, which is all this surface '
    + 'should show of a control the recorder owns',
};

// ------------------------------------------------------------------- the page

const { chromium } = await loadPlaywright();

/**
 * Which file each surface this tool opens is served from. An identity test rather than a rule about
 * a suffix, which would hand `web/menu.html`'s bytes over as the editor's own document.
 */
const SURFACE_DOCUMENTS = {
  '/edit': 'web/index.html',
  '/record': 'web/index.html',
};

/**
 * Where the file a mutation names is asked for by a page opened at `documentPath`, and what it is
 * handed back as. Matched on the whole pathname rather than on the basename, because two modules
 * can end in the same name and the wrong one would be served without anything failing.
 */
function servedAt(file, documentPath) {
  if (file === SURFACE_DOCUMENTS[documentPath]) {
    return { path: documentPath, contentType: 'text/html; charset=utf-8' };
  }
  const TYPES = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  const ext = file.slice(file.lastIndexOf('.'));
  if (file.startsWith('web/') && TYPES[ext]) {
    return { path: `/${file.slice('web/'.length)}`, contentType: TYPES[ext] };
  }
  throw new Error(`${file} is neither a module or stylesheet under web/ nor the document `
    + `${documentPath} is served from, so no page this tool opens would ever request it`);
}

let mutation = null;
try {
  mutation = MUTATE ? mutatedSource(MUTATE) : null;
  if (mutation) servedAt(mutation.file, EDITOR_PATH);
} catch (err) {
  console.log(`[editor] DID NOT RUN - ${err.message}`);
  process.exit(2);
}
if (MUTATE) {
  console.log(`[editor] MUTATED BUILD: ${MUTATE} in ${mutation.file} at `
    + `${servedAt(mutation.file, EDITOR_PATH).path} - this run is expected to FAIL`);
}

/**
 * Install the active mutation on one page, and hand back the count of times that page actually
 * asked for it. Keyed on the file the spec names rather than filtered against a list of known
 * files, and one helper for both surfaces, because `page.route` is installed per page.
 */
async function serveMutation(page, documentPath) {
  if (!mutation) return { path: null, served: () => 0 };
  const { path, contentType } = servedAt(mutation.file, documentPath);
  let served = 0;
  await page.route((url) => url.pathname === path, (route) => {
    served++;
    route.fulfill({ contentType, body: mutation.body });
  });
  return { path, served: () => served };
}

// The picker stub, installed before the module evaluates: `main.js` reads `typeof
// globalThis.showSaveFilePicker === 'function'` once at load, so a stub installed afterwards
// would find the control already disabled.
const PICKER_STUB = `(() => {
  globalThis.__saved = { called: false, suggestedName: null, hadActivation: null, chunks: [], closed: false };
  globalThis.showSaveFilePicker = async (opts) => {
    globalThis.__saved.called = true;
    globalThis.__saved.suggestedName = opts?.suggestedName ?? null;
    globalThis.__saved.hadActivation = navigator.userActivation ? navigator.userActivation.isActive : null;
    return {
      createWritable: async () => new WritableStream({
        write(chunk) { globalThis.__saved.chunks.push(chunk); },
        close() { globalThis.__saved.closed = true; },
      }),
    };
  };
})()`;

async function openEditor() {
  // Local Network Access is off because serving the document through `route.fulfill` puts the page
  // in a context Chromium treats as external, and its socket back to localhost is then refused.
  const browser = await chromium.launch({
    channel: 'chromium',
    headless: !HEADED,
    args: ['--disable-features=LocalNetworkAccessChecks'],
  });
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1, acceptDownloads: true });
  await context.addInitScript(PICKER_STUB);
  await context.addInitScript(() => localStorage.setItem('braindance.preview.auto', 'off'));
  await armDocumentWrites(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (err) => errors.push(String(err)));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  await page.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));

  // The interception is proved below rather than assumed: a route declared and never installed
  // ran the tree's own source and came back NOT CAUGHT with every row green.
  const mutant = await serveMutation(page, EDITOR_PATH);

  await page.goto(`${URL_BASE}${EDITOR_PATH}?take=${encodeURIComponent(TAKE)}`, { waitUntil: 'load' });
  const waitFor = async (expr, what, timeout = 30000) => {
    try {
      await page.waitForFunction(expr, null, { timeout });
    } catch (err) {
      throw new Error(`${what}: ${err.message.split('\n')[0]}`
        + (errors.length ? ` - the page said: ${errors.slice(0, 3).join(' | ')}` : ' - the page reported nothing'));
    }
  };
  await waitFor('!!globalThis.__kinect', 'the module never finished booting');
  await waitFor('!!globalThis.__kinect.timeline.transport()', 'the take never opened');
  // And then for the open to be over, which is not the same moment - the transport exists partway
  // through `openTake`, and the marks, the library listings and the crop fit all land after it.
  await waitFor('globalThis.__kinect.takeOpened()', 'the take opened but never finished opening');
  // Gated on a mutation having been asked for rather than on a body this file recognised: a guard
  // keyed on the same file name the route was selected by cannot fire for the file that
  // selected no route.
  if (MUTATE && mutant.served() === 0) {
    throw new Error(`${MUTATE} was staged for ${mutation.file} at ${mutant.path} and the page never `
      + "requested it, so every row below would have measured the tree's own build");
  }
  return { page, errors, close: () => browser.close() };
}

// ------------------------------------------------------------------- the run

let page;
let errors;
let close = async () => {};

try {
  const opened = await openEditor();
  ({ page, errors, close } = opened);
} catch (err) {
  console.log(`[editor] DID NOT RUN - ${err.message}`);
  process.exit(2);
}

/**
 * How much footage this file's own rows need under them, and the refusal when the take
 * handed to `--take` does not hold it. A precondition on the fixture rather than a claim
 * about the build: a short take clamps every seek into the clip, and the run comes back with
 * red rows that name real features and mean nothing.
 *
 * Checked rather than trusted - the scan below reads this file's own literal seek targets and
 * refuses if any is deeper than what is declared here. It cannot see a seek computed from a
 * variable, which is why the number sits a little above the deepest literal.
 */
const NEEDS_TAKE_SEC = 32;
const ownSource = readFileSync(fileURLToPath(import.meta.url), 'utf8');
const literalSeeks = [...ownSource.matchAll(/\.seek\(\s*(\d+(?:\.\d+)?)\s*\)/g)].map((m) => Number(m[1]));
const deepestSeek = Math.max(...literalSeeks);
if (deepestSeek > NEEDS_TAKE_SEC) {
  console.log(`[editor] DID NOT RUN - a row seeks to ${deepestSeek}s while NEEDS_TAKE_SEC is ${NEEDS_TAKE_SEC}`
    + ' - raise it and point --take at a fixture that holds it, or the clamp will redden rows about the build');
  await close();
  process.exit(2);
}
const takeSec = await page.evaluate('__kinect.timeline.transport().duration');
if (!(takeSec >= NEEDS_TAKE_SEC)) {
  console.log(`[editor] DID NOT RUN - the take "${TAKE}" holds ${takeSec.toFixed(2)}s and these rows reach `
    + `${deepestSeek}s, so ${NEEDS_TAKE_SEC}s is the shortest take they can be asked about. `
    + 'Every seek past the end clamps, and the rows downstream would redden about the fixture rather than '
    + 'about the build. Point --take at a longer capture (tools/make-fixture.js loops a short one).');
  await close();
  process.exit(2);
}

const settle = () => page.evaluate('__kinect.timeline.settled()');
const read = () => page.evaluate('__kinect.timeline.read()');
const range = () => page.evaluate('__kinect.editor.clipRange()');
const lanes = () => page.evaluate('__kinect.keyframes.lanes()');
// The lanes that carry keys. The stack also holds the clip bar and a row per clip, which are
// structure rather than animation and are counted by section 22 instead.
const keyedLanes = async () => (await lanes())
  .filter((l) => l.kind !== 'clips' && l.kind !== 'clip' && l.kind !== 'clip-add');
const keyCount = async (owner) => ((await lanes()).find((l) => l.owner === owner)?.keys ?? 0);
const text = (sel) => page.locator(sel).textContent();
/** Focus somewhere with no claim on the keyboard, so the window handler gets the key. */
// `blur()` and not `focus()` on `#stage`: neither it nor `<body>` carries a tabindex, so the
// focus would stay exactly where the previous gesture left it and the window handler's typing
// guard would skip every key press.
const focusStage = () => page.evaluate(`(() => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  document.getElementById('stage')?.focus?.();
})()`);

async function proveRecorderNavigation(page) {
  const pose = () => page.evaluate(() => {
    const k = __kinect, c = k.freeCamera;
    return { p: c.position.toArray(), t: k.controls.target.toArray(), fov: c.fov };
  });
  const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  await page.evaluate(() => { document.activeElement?.blur(); });
  const before = await pose();
  await page.keyboard.down('w');
  await page.waitForTimeout(250);
  const bare = await pose();
  await page.keyboard.down('Shift');
  await page.waitForTimeout(350);
  await page.keyboard.up('w');
  await page.keyboard.up('Shift');
  const flown = await pose();
  check(distance(before.p, bare.p) < 1e-6 && distance(bare.p, flown.p) > 0.1,
    'recorder: Shift enables flight on a key already held',
    `bare ${distance(before.p, bare.p)}, shifted ${distance(bare.p, flown.p)}`);
  const box = await page.locator('#stage').boundingBox();
  const x = box.x + box.width * 0.4, y = box.y + box.height * 0.5;
  await page.keyboard.down('Shift');
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(50);
  const looked = await pose();
  check(distance(flown.p, looked.p) < 1e-6 && distance(flown.t, looked.t) > 0.05,
    'recorder: Shift-drag turns the view without moving the camera');
  await page.keyboard.down('Shift');
  await page.mouse.wheel(-100, 0);
  await page.waitForTimeout(50);
  await page.keyboard.up('Shift');
  const wheeled = await pose();
  check(wheeled.fov < looked.fov * 0.95 && distance(looked.p, wheeled.p) < 1e-6,
    'recorder: a horizontal Shift-wheel changes the lens without dollying');
  await proveLookInterruptions(page, 'recorder');
}

async function proveLookInterruptions(page, label) {
  const pose = () => page.evaluate(() => {
    const k = __kinect;
    return { p: k.freeCamera.position.toArray(), t: k.controls.target.toArray(), enabled: k.controls.enabled };
  });
  const distance = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
  for (const reason of ['blur', 'pointercancel', 'lostpointercapture', 'program camera']) {
    await page.evaluate(() => { document.activeElement?.blur(); __kinect.setViewCamera(__kinect.freeCamera); });
    const box = await page.locator('#stage').boundingBox();
    const x = box.x + box.width * 0.4, y = box.y + box.height * 0.5;
    await page.evaluate(() => {
      addEventListener('pointerdown', (e) => {
        globalThis.__proofPointer = e.pointerId;
      }, { capture: true, once: true });
    });
    await page.keyboard.down('Shift');
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 30, y, { steps: 3 });
    const held = await pose();
    check(!held.enabled, `${label}: ${reason} starts with a live look drag`);
    await page.evaluate((reason) => {
      const stage = document.getElementById('stage');
      if (reason === 'blur') dispatchEvent(new Event('blur'));
      else if (reason === 'program camera') __kinect.setViewCamera(__kinect.programCamera);
      else if (reason === 'lostpointercapture') stage.releasePointerCapture(globalThis.__proofPointer);
      else stage.dispatchEvent(new PointerEvent('pointercancel', { pointerId: globalThis.__proofPointer }));
    }, reason);
    // Capture loss is delivered before the next pointer event, which can outlive a timed wait.
    if (reason === 'lostpointercapture') await page.mouse.move(x + 30, y);
    await page.waitForTimeout(50);
    const stopped = await pose();
    await page.mouse.move(x + 80, y + 30, { steps: 3 });
    if (reason === 'program camera') await page.keyboard.down('w');
    await page.waitForTimeout(200);
    const later = await pose();
    if (reason === 'program camera') await page.keyboard.up('w');
    await page.mouse.up();
    await page.keyboard.up('Shift');
    check(stopped.enabled === (reason !== 'program camera')
      && distance(stopped.p, later.p) < 1e-6 && distance(stopped.t, later.t) < 1e-6,
    `${label}: ${reason} ends a look drag and rejects its remaining input`,
    `enabled ${stopped.enabled}, camera ${distance(stopped.p, later.p)}, pivot ${distance(stopped.t, later.t)}`);
  }
  await page.evaluate(() => {
    __kinect.setViewCamera(__kinect.freeCamera);
    document.getElementById('menuCameraReset').click();
  });
}

try {
  await settle();

  console.log('\n[1] every control the editor renders is one this file knows how to drive');
  const rackFresh = await page.evaluate(() => {
    const k = globalThis.__kinect;
    const ids = k.effectIds();
    const rowFor = (name) => document.getElementById(name)?.closest('.row, .checkrow') ?? null;
    const packageGroups = [...document.querySelectorAll('#panelBody > [data-group]')]
      .filter((group) => {
        const names = [...group.querySelectorAll('input[id]')]
          .map((input) => input.id).filter((name) => k.params.names().includes(name));
        return names.length > 0 && names.every((name) => k.effectOf(name) !== null);
      });
    const effectRows = ids.flatMap((id) => k.effectParamNames(id).map(rowFor)).filter(Boolean);
    const coreRows = k.params.names('look').filter((name) => k.effectOf(name) === null)
      .map(rowFor).filter(Boolean);
    return {
      ids,
      effectRows: effectRows.length,
      hiddenEffectRows: effectRows.filter((row) => row.hidden).length,
      coreRows: coreRows.length,
      hiddenCoreRows: coreRows.filter((row) => row.hidden).length,
      packageGroups: packageGroups.length,
      emptyPackageGroups: packageGroups.filter((group) => group.classList.contains('rackempty')).length,
    };
  });
  check(rackFresh.ids.length > 0
    && rackFresh.effectRows === rackFresh.hiddenEffectRows
    && rackFresh.packageGroups === rackFresh.emptyPackageGroups,
  'a fresh clip keeps every installed package effect out of the sidebar',
  `${rackFresh.hiddenEffectRows} of ${rackFresh.effectRows} effect rows hidden, `
    + `${rackFresh.emptyPackageGroups} of ${rackFresh.packageGroups} package groups empty`);
  check(rackFresh.coreRows > 0 && rackFresh.hiddenCoreRows === 0,
    'and the basic clip controls remain in it',
    `${rackFresh.coreRows - rackFresh.hiddenCoreRows} of ${rackFresh.coreRows} core rows retained`);

  await page.evaluate("__kinect.params.set('grain.amount', 0.4)");
  await settle();
  const valueRevealed = await page.evaluate(`(() => {
    const row = document.getElementById('grain.amount')?.closest('.row, .checkrow');
    return row ? !row.hidden : false;
  })()`);
  check(valueRevealed,
    'a value restored without an Add gesture reveals the effect that owns it',
    `grain row visible=${valueRevealed}`);
  await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const spec = k.params.spec('grain.amount');
    k.params.set('grain.amount', k.params.normalise('grain.amount', spec.default));
  })()`);
  await settle();
  const valueCleared = await page.evaluate(`(() => {
    const row = document.getElementById('grain.amount')?.closest('.row, .checkrow');
    return row ? row.hidden : false;
  })()`);
  check(valueCleared,
    'and it leaves again when that programmatic value carries no work and was never added',
    `grain row hidden=${valueCleared}`);

  await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.keyframes.setTracks({ 'grain.amount': [{ t: 0, value: k.params.get('grain.amount') }] });
  })()`);
  await settle();
  const trackRevealed = await page.evaluate(`(() => {
    const row = document.getElementById('grain.amount')?.closest('.row, .checkrow');
    return row ? !row.hidden : false;
  })()`);
  check(trackRevealed,
    'a keyframe track reveals its effect even where the parked value equals the default',
    `grain row visible=${trackRevealed}`);
  await page.evaluate('__kinect.keyframes.setTracks({})');
  await settle();
  const trackCleared = await page.evaluate(`(() => {
    const row = document.getElementById('grain.amount')?.closest('.row, .checkrow');
    return row ? row.hidden : false;
  })()`);
  check(trackCleared,
    'and clearing that track removes the otherwise idle effect again',
    `grain row hidden=${trackCleared}`);

  await page.locator('#effectRackOpen').click();
  check(await page.evaluate('!document.getElementById("effectRackPanel").hidden'),
    'the add button opens the installed-effect search');
  const rackOpened = await page.evaluate(`(() => {
    const open = document.getElementById('effectRackOpen');
    const panel = document.getElementById('effectRackPanel');
    return {
      expanded: open.getAttribute('aria-expanded'),
      controls: open.getAttribute('aria-controls'),
      labelledBy: panel.getAttribute('aria-labelledby'),
      focus: document.activeElement?.id ?? null,
    };
  })()`);
  check(rackOpened.expanded === 'true' && rackOpened.controls === 'effectRackPanel'
    && rackOpened.labelledBy === 'effectRackTitle' && rackOpened.focus === 'effectRackSearch',
  'the open rack identifies its trigger, label, state, and first keyboard control',
  JSON.stringify(rackOpened));

  await page.keyboard.press('Escape');
  const rackEscaped = await page.evaluate(`(() => ({
    hidden: document.getElementById('effectRackPanel').hidden,
    expanded: document.getElementById('effectRackOpen').getAttribute('aria-expanded'),
    focus: document.activeElement?.id ?? null,
  }))()`);
  check(rackEscaped.hidden && rackEscaped.expanded === 'false' && rackEscaped.focus === 'effectRackOpen',
    'Escape closes the rack and returns the caret to its trigger', JSON.stringify(rackEscaped));
  await page.locator('#effectRackOpen').click();

  await page.setViewportSize({ width: 520, height: 800 });
  await settle();
  const narrowRack = await page.evaluate(`(() => {
    const panel = document.getElementById('effectRackPanel').getBoundingClientRect();
    const buttons = [...document.querySelectorAll('#effectRackList button')]
      .map((button) => button.getBoundingClientRect());
    return {
      viewport: innerWidth,
      left: Math.round(panel.left),
      right: Math.round(panel.right),
      buttonRight: Math.round(Math.max(0, ...buttons.map((box) => box.right))),
      front: document.elementFromPoint(panel.left + 8, panel.top + 8)?.closest('#effectRackPanel')?.id ?? null,
    };
  })()`);
  check(narrowRack.left >= 0 && narrowRack.right <= narrowRack.viewport
    && narrowRack.buttonRight <= narrowRack.viewport && narrowRack.front === 'effectRackPanel',
  'the rack and every action stay inside a 520px viewport', JSON.stringify(narrowRack));
  await page.setViewportSize(VIEWPORT);
  await settle();

  await focusStage();
  await page.keyboard.press('h');
  await settle();
  const collapsedRack = await page.evaluate(`(() => {
    const rack = document.getElementById('effectRackPanel').getBoundingClientRect();
    return { collapsed: document.body.classList.contains('panelcollapsed'), left: Math.round(rack.left) };
  })()`);
  check(collapsedRack.collapsed && collapsedRack.left <= 32,
    'when H collapses the inspector, the open rack moves beside the viewport instead of floating at the old edge',
    JSON.stringify(collapsedRack));
  await page.keyboard.press('h');
  await settle();

  await page.locator('#effectRackSearch').fill('halation');
  const searched = await page.evaluate(`(() => ({
    rows: [...document.querySelectorAll('#effectRackList [data-effect-rack]')]
      .map((row) => row.dataset.effectRack),
    add: document.querySelector('[data-effect-add="halation"]')?.dataset.effectAdd ?? null,
  }))()`);
  check(JSON.stringify(searched.rows) === JSON.stringify(['halation']) && searched.add === 'halation',
    'search narrows the installed list to the matching effect and offers Add',
    `${searched.rows.join(', ') || 'no rows'}, add=${searched.add}`);
  const halationAdd = page.locator('[data-effect-add="halation"]');
  const couldAddHalation = await halationAdd.count() === 1;
  if (couldAddHalation) await halationAdd.click();
  else {
    await page.locator('#effectRackOpen').click();
    await page.evaluate("document.querySelector('[data-group-toggle=halation]')?.click()");
  }
  await page.waitForTimeout(50);
  const halationAdded = await page.evaluate(`(() => {
    const row = document.getElementById('halation.amount')?.closest('.row, .checkrow');
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem('kinect.rackedEffects') ?? '[]'); } catch {}
    return {
      hidden: row?.hidden ?? null,
      stored,
      rackOpen: !document.getElementById('effectRackPanel').hidden,
    };
  })()`);
  check(couldAddHalation && halationAdded.hidden === false
    && halationAdded.stored.includes('halation') && halationAdded.rackOpen,
  'Add retains the effect in the sidebar with the picker still open',
  `add=${couldAddHalation}, hidden=${halationAdded.hidden}, stored=${JSON.stringify(halationAdded.stored)}`);
  check(await page.evaluate('document.activeElement?.id === "effectRackSearch"'),
    'and Add leaves the caret on a stable control in the open rack');

  await page.evaluate(`(() => {
    const input = document.getElementById('halation.amount');
    input.value = '0.7';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  if (couldAddHalation) {
    await page.locator('button[aria-label="halation.amount keyframe"]').click();
  } else {
    await page.evaluate(`document.querySelector('button[aria-label="halation.amount keyframe"]').click()`);
  }
  if (await page.evaluate('document.getElementById("effectRackPanel").hidden')) {
    if (couldAddHalation) await page.locator('#effectRackOpen').click();
    else await page.evaluate("document.getElementById('effectRackOpen').click()");
  }
  await page.locator('#effectRackSearch').fill('halation');
  // Remove destroys the values and the tracks on one press and asks nothing first, so the undo
  // row below is the whole of what stands between a stray click and the work. This arm reads what
  // is there to destroy before pressing, because a removal from an effect already at its defaults
  // would pass the two rows under it having reset and deleted nothing.
  const beforeRemoveDepth = await page.evaluate('__kinect.keyframes.undo.depth()');
  const carried = await page.evaluate(`(() => ({
    value: globalThis.__kinect.params.get('halation.amount'),
    keyed: globalThis.__kinect.keyframes.names().includes('halation.amount'),
  }))()`);
  check(carried.value === 0.7 && carried.keyed,
    'the effect about to be removed carries a value and a track, so the removal has something to destroy',
    `value=${carried.value}, keyed=${carried.keyed}`);
  await page.locator('[data-effect-remove="halation"]').click();
  await settle();
  const removedEffect = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const row = document.getElementById('halation.amount')?.closest('.row, .checkrow');
    const spec = k.params.spec('halation.amount');
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem('kinect.rackedEffects') ?? '[]'); } catch {}
    return {
      atDefault: k.params.get('halation.amount') === k.params.normalise('halation.amount', spec.default),
      keyed: k.keyframes.names().includes('halation.amount'),
      hidden: row?.hidden ?? null,
      stored,
      depth: k.keyframes.undo.depth(),
    };
  })()`);
  check(removedEffect.atDefault && !removedEffect.keyed && removedEffect.hidden
    && !removedEffect.stored.includes('halation'),
  'one press on Remove resets every value, deletes every track, and takes the effect out of the sidebar',
  `default=${removedEffect.atDefault}, keyed=${removedEffect.keyed}, hidden=${removedEffect.hidden}, `
    + `stored=${JSON.stringify(removedEffect.stored)}`);
  check(removedEffect.depth === beforeRemoveDepth + 1,
    'and all of that is one undoable edit',
    `history ${beforeRemoveDepth} -> ${removedEffect.depth}`);
  await page.locator('#effectRackClose').click();
  await page.evaluate('__kinect.keyframes.undo.pop()');
  await settle();
  const undoRemoval = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const row = document.getElementById('halation.amount')?.closest('.row, .checkrow');
    return {
      value: k.params.get('halation.amount'),
      keyed: k.keyframes.names().includes('halation.amount'),
      hidden: row?.hidden ?? null,
    };
  })()`);
  check(undoRemoval.value === 0.7 && undoRemoval.keyed && undoRemoval.hidden === false,
    'undo restores the value, the track, and the visible effect together',
    `value=${undoRemoval.value}, keyed=${undoRemoval.keyed}, hidden=${undoRemoval.hidden}`);

  await page.evaluate('__kinect.keyframes.setTracks({})');
  if (undoRemoval.hidden === true) {
    await page.evaluate(`document.querySelector('button[aria-label="halation.amount reset to default"]').click()`);
  } else {
    await page.locator('button[aria-label="halation.amount reset to default"]').click();
  }
  await settle();
  const resetRetained = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const row = document.getElementById('halation.amount')?.closest('.row, .checkrow');
    const spec = k.params.spec('halation.amount');
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem('kinect.rackedEffects') ?? '[]'); } catch {}
    return {
      atDefault: k.params.get('halation.amount') === k.params.normalise('halation.amount', spec.default),
      hidden: row?.hidden ?? null,
      stored,
    };
  })()`);
  check(resetRetained.atDefault && resetRetained.hidden === false
    && resetRetained.stored.includes('halation'),
  'resetting the last touched value keeps the effect in the sidebar until Remove is pressed',
  `default=${resetRetained.atDefault}, hidden=${resetRetained.hidden}, stored=${JSON.stringify(resetRetained.stored)}`);
  const rackedDefaultGroup = await page.evaluate(`(() => {
    let stored = {};
    try { stored = JSON.parse(localStorage.getItem('kinect.panelGroupsOpen') ?? '{}'); } catch {}
    const button = document.querySelector('[data-group-toggle="halation"]');
    return { expanded: button?.getAttribute('aria-expanded') ?? null, stored };
  })()`);
  check(rackedDefaultGroup.expanded === 'true'
    && !Object.hasOwn(rackedDefaultGroup.stored, 'halation'),
  'a racked effect keeps its group open after its last value returns to default, without leaving an override behind',
  JSON.stringify(rackedDefaultGroup));

  let rackAdds = 0;
  for (let i = 0; i <= rackFresh.ids.length; i++) {
    if (await page.evaluate('document.getElementById("effectRackPanel").hidden')) {
      await page.locator('.paneltab[data-panel-tab="look"]').click();
      await page.locator('#effectRackOpen').click();
    }
    const next = page.locator('[data-effect-add]').first();
    if (await next.count() === 0) break;
    await next.click();
    rackAdds++;
  }
  if (await page.evaluate('document.getElementById("effectRackPanel").hidden')) {
    await page.locator('.paneltab[data-panel-tab="look"]').click();
    await page.locator('#effectRackOpen').click();
  }
  const rackComplete = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem('kinect.rackedEffects') ?? '[]'); } catch {}
    const unavailable = k.effectIds().filter((id) => k.effectParamNames(id).every((name) => {
      const row = document.getElementById(name)?.closest('.row, .checkrow');
      return !row || row.hidden;
    }));
    return {
      ids: [...k.effectIds()].sort(),
      stored: [...stored].sort(),
      unavailable,
      removes: document.querySelectorAll('#effectRackList [data-effect-remove]').length,
    };
  })()`);
  check(JSON.stringify(rackComplete.stored) === JSON.stringify(rackComplete.ids)
    && rackComplete.unavailable.length === 0 && rackComplete.removes === rackComplete.ids.length,
  'adding the remaining installed effects makes every one available to the sidebar and the control sweep',
  `${rackAdds} added in the loop, ${rackComplete.unavailable.length} unavailable, `
    + `${rackComplete.removes} remove controls for ${rackComplete.ids.length} effects`);

  // The remove in a group's own header is a second door onto `removeEffectFromRack`, and the only
  // one reached without opening the rack at all. Driven here because the loop above racked every
  // effect, so the header exists; halation is put back afterwards, or the sweep below would be one
  // control short and say so as a coverage failure rather than as the removal it really was.
  await page.locator('.paneltab[data-panel-tab="look"]').click();
  const headRemove = page.locator('#panel .group[data-group="halation"] .grouphead .groupremove');
  const headRemoveCount = await headRemove.count();
  if (headRemoveCount === 1) await headRemove.click();
  await settle();
  const headRemoved = await page.evaluate(`(() => {
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem('kinect.rackedEffects') ?? '[]'); } catch {}
    const row = document.getElementById('halation.amount')?.closest('.row, .checkrow');
    return { stored, hidden: row?.hidden ?? null };
  })()`);
  check(headRemoveCount === 1 && !headRemoved.stored.includes('halation') && headRemoved.hidden === true,
    'the remove in a group\'s own header takes that effect out of the sidebar',
    `${headRemoveCount} button in the header, row hidden=${headRemoved.hidden}, `
    + `stored ${JSON.stringify(headRemoved.stored)}`);
  if (await page.evaluate('document.getElementById("effectRackPanel").hidden')) {
    await page.locator('#effectRackOpen').click();
  }
  await page.locator('#effectRackSearch').fill('halation');
  // Conditional so that a build where the cross did nothing dies on the row below rather than on
  // a thirty-second wait for an Add button a still-racked effect does not have: the mutation's
  // blast radius is one row, and a run that stops at 22 assertions cannot say that.
  const addBack = page.locator('[data-effect-add="halation"]');
  if (await addBack.count() === 1) await addBack.click();
  await page.locator('#effectRackSearch').fill('');
  await settle();
  check(await page.evaluate(`(() => {
    const row = document.getElementById('halation.amount')?.closest('.row, .checkrow');
    return row ? row.hidden === false : false;
  })()`), '  and adding it back leaves the sweep below the full set of effects to enumerate');

  // One mark planted first, because a mark tick is a control that exists only when the take has a
  // mark: "no instance of this class" and "this class is not swept" read the same.
  await page.evaluate("__kinect.editor.setMarks([{ id: 'sweep', sourceMs: 2000, label: 'sweep' }])");
  const sweptClean = await page.evaluate('JSON.stringify(__kinect.library.serialiseProjectBody())');
  await page.evaluate(`(() => {
    const body = JSON.parse(${JSON.stringify(sweptClean)});
    body.look.params['sparkle.amount'] = 0.6;
    body.requires = [...(body.requires ?? []), { id: 'sparkle', version: '1.0.0' }];
    __kinect.library.restoreProject(body);
  })()`);
  const sweep = await page.evaluate(`(${((rules) => {
    // Anchors, `.tlanes`, the dialogs by element and `[role=option]` are each in the list because
    // a selector naming only the strip and the panel let them out of the sweep - a control the
    // page renders, pressable, and outside the enumeration entirely.
    const els = [...document.querySelectorAll('.appbar input, .appbar select, .appbar button, .appbar a, '
      + '.tbar input, .tbar select, .tbar button, .tbar a, '
      + '#panel input, #panel select, #panel button, #panel a, #panel [role=option], '
      + '#effectRackPanel input, #effectRackPanel select, #effectRackPanel button, '
      + '#effectRackPanel a, #effectRackPanel [role=option], '
      + '.tlanes input, .tlanes select, .tlanes button, .tlanes a, '
      + 'dialog input, dialog select, dialog button, dialog a')];
    return els.map((el) => ({
      id: el.id || null,
      tag: el.tagName,
      type: el.type || null,
      ease: el.dataset ? el.dataset.ease ?? null : null,
      groupToggle: el.dataset ? el.dataset.groupToggle || null : null,
      // `||` rather than `??`, because the DOM answers an absent dataset key with the empty string.
      reset: el.dataset ? el.dataset.reset || null : null,
      suppress: el.dataset ? el.dataset.suppress || null : null,
      inTbar: Boolean(el.closest('.tbar')),
      // `.appmenu` is a class where the rest are ids, because the `appbar` rule has to tell a
      // menu from a button that merely shares the nav row with one.
      groups: ['#appBar', '#panel', '#panelTabs', '#lookPresetGroup', '#cameraGroup', '#navRow',
        '#recordGroup', '#recLookGroup', '#sensorGroup', '#monitorGroup',
        '#programOutGroup', '#presetPick', '#projectDialog', '#exportDialog', '#obsDialog',
        '#renameDialog',
        '#effectRackPanel', '#panelDock', '.appmenu']
        .filter((g) => el.closest(g)),
      kf: el.classList.contains('kf'),
      mark: el.classList.contains('tmk'),
      groupRemove: el.classList.contains('groupremove'),
      label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24),
    }));
  }).toString()})()`);

  const covered = (row) => {
    if (row.id && DRIVER_IDS[row.id]) return `named: ${DRIVER_IDS[row.id]}`;
    if (row.ease) return 'rule: an ease preset, section 5 presses all five on every easable kind';
    return DRIVER_RULES.find((rule) => rule.match(row))?.by ?? null;
  };

  const barren = DRIVER_RULES.filter((rule) => !sweep.some((row) => rule.match(row)));
  check(barren.length === 0,
    'every rule in the driver table matches a control the page actually renders, so a rule cannot claim coverage it never reaches',
    barren.length ? `${barren.length} matching nothing: ${barren.map((r) => r.key).join(', ')}`
      : DRIVER_RULES.map((r) => `${r.key} ${sweep.filter((row) => r.match(row)).length}`).join(', '));

  const unknown = sweep.filter((row) => !covered(row));
  const DIALOG_GROUPS = ['#presetPick', '#exportDialog', '#obsDialog', '#clipPick'];
  const inDialog = sweep.filter((r) => DIALOG_GROUPS.some((group) => r.groups.includes(group))).length;
  const inTbar = sweep.filter((r) => r.inTbar).length;
  note(`${sweep.length} interactive controls on the editor`,
    `${inTbar} in the strip, ${sweep.length - inTbar - inDialog} in the panel, ${inDialog} in a dialog`);
  for (const row of unknown) {
    note('  no driver for', `${row.tag}${row.id ? `#${row.id}` : ''} "${row.label}"`);
  }
  check(unknown.length === 0,
    'every control the page renders is covered by a driver or a stated rule',
    unknown.length ? `${unknown.length} uncovered: ${unknown.map((r) => r.id || r.label).join(', ')}` : `${sweep.length} controls`);

  // Asserted rather than assumed: a left-behind pool shows up twenty sections down as a
  // `requires` entry in a document some other row is asserting about.
  await page.evaluate(`__kinect.library.restoreProject(JSON.parse(${JSON.stringify(sweptClean)}))`);
  check(await page.evaluate('__kinect.library.missingEffects().length') === 0,
    'and the missing effect staged for that sweep is off the page again, so no later section serialises it',
    'nothing parked');
  // Counted over the panel rather than over the sweep - the subset dialog put 68 more controls in
  // reach of the same selector, so a floor on the sweep would pass a build whose panel
  // had gone entirely.
  const inPanel = sweep.filter((r) => r.groups.includes('#panel')).length;
  check(inPanel > 60, 'and the sweep found the panel, not an empty page',
    `${inPanel} of ${sweep.length} controls are the panel's`);

  const owned = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    return k.params.names().filter((n) => k.params.spec(n).tag !== 'composition');
  })()`);
  const swept = new Set(sweep.map((row) => row.id).filter(Boolean));
  const absent = owned.filter((name) => !swept.has(name));
  check(absent.length === 0,
    `every parameter the registry declares has a control on the panel (${owned.length})`,
    absent.length ? `no control for ${absent.join(', ')}` : `${owned.length} of ${owned.length}`);

  const composition = await page.evaluate("globalThis.__kinect.params.names('composition')");
  const withControls = composition.filter((name) => swept.has(name));
  check(composition.length > 0 && withControls.length === 0,
    'and no composition parameter has one, because composition is edited in the world',
    withControls.length ? `${withControls.join(', ')} has a control` : `${composition.length} checked: ${composition.join(', ')}`);
  check(sweep.some((r) => r.id === 'tPlay') && sweep.some((r) => r.id === 'tRate'),
    'the strip is among what was swept', `${sweep.filter((r) => r.inTbar).map((r) => r.id).filter(Boolean).slice(0, 6).join(', ')}...`);

  // The census racks every installed effect so its generated controls exist for the sweep. That
  // is local panel state, not project state, and leaving it behind changes every later claim about
  // a fresh inspector. Remove through the real controls so the cleanup also proves that an idle
  // effect needs no destructive confirmation.
  let rackRemoves = 0;
  while (await page.locator('[data-effect-remove]').count() > 0) {
    await page.locator('[data-effect-remove]').first().click();
    rackRemoves++;
  }
  const rackClean = await page.evaluate(`(() => {
    let stored = [];
    try { stored = JSON.parse(localStorage.getItem('kinect.rackedEffects') ?? '[]'); } catch {}
    return {
      stored,
      visible: globalThis.__kinect.effectIds().filter((id) =>
        globalThis.__kinect.effectParamNames(id).some((name) => {
          const row = document.getElementById(name)?.closest('.row, .checkrow');
          return row && !row.hidden;
        })),
    };
  })()`);
  check(rackRemoves === rackComplete.ids.length && rackClean.stored.length === 0
    && rackClean.visible.length === 0,
  'the sweep removes every idle effect through the rack and leaves later sections a fresh sidebar',
  `${rackRemoves} removed, stored ${JSON.stringify(rackClean.stored)}, `
    + `${rackClean.visible.length} effects still visible`);

  await page.locator('#effectRackClose').click();
  check(await page.evaluate('document.getElementById("effectRackPanel").hidden'),
    'the effect search closes after its generated controls were swept');

  // Measured at both ends of the travel, because one end is a dead zone - a nav at the foot of
  // the column is visible there and fails only at the top.
  await page.locator('.paneltab[data-panel-tab="look"]').click();
  // The inspector is opened before it is measured, because a collapsed one does not scroll:
  // `scrollHeight - clientHeight` is zero and both rows below would read a bar trivially on
  // screen at both ends of a travel that does not exist.
  const openedForTravel = await page.evaluate(`(() => {
    const shut = [...document.querySelectorAll('#panelBody > [data-panel-tab] .grouptoggle')]
      .filter((b) => b.getAttribute('aria-expanded') === 'false' && b.checkVisibility());
    shut.forEach((b) => b.click());
    return shut.length;
  })()`);
  const nav = await page.evaluate(`(${(() => {
    const el = document.getElementById('appBar');
    const body = document.getElementById('panelBody');
    if (!el || !body) return { present: false, hasBody: !!body };
    const was = body.scrollTop;
    const at = (to) => {
      body.scrollTop = to;
      const r = el.getBoundingClientRect();
      return {
        scrolled: Math.round(body.scrollTop),
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        inside: r.top >= -0.5 && r.bottom <= innerHeight + 0.5,
      };
    };
    const travel = body.scrollHeight - body.clientHeight;
    const top = at(0);
    const end = at(body.scrollHeight);
    body.scrollTop = was;
    return {
      present: true,
      hasBody: true,
      travel: Math.round(travel),
      inBody: !!el.closest('#panelBody'),
      top,
      end,
      height: Math.round(el.getBoundingClientRect().height),
      surface: document.getElementById('surfaceName')?.textContent?.trim(),
      hrefs: ['toMenu', 'toLibrary'].map((id) => document.getElementById(id)?.getAttribute('href') ?? null),
    };
  }).toString()})()`);

  check(nav.present, 'the editor has one application bar carrying its navigation and commands',
    nav.present ? `${nav.height}px high, surface ${nav.surface}` : `appBar/panelBody present: ${nav.hasBody}`);
  check(nav.travel > 0, 'and the panel body genuinely scrolls, so the rows below are measuring something',
    `${nav.travel}px of travel with the tab's ${openedForTravel} groups opened`);
  check(nav.present && nav.top.inside && nav.end.inside && nav.top.top === 0 && nav.end.top === 0,
    'the application bar stays on screen at both ends of the inspector travel',
    nav.present ? `top ${nav.top.top}px at rest, ${nav.end.top}px at the end` : 'absent');
  check(nav.present && !nav.inBody,
    'and it is outside the scrolling inspector rather than merely near its top',
    `in the scrolling body: ${nav.inBody}`);
  check(nav.present && nav.surface === 'Editor' && nav.hrefs.join(' ') === '/ /projects',
    'and it names the surface while both exits remain real URLs in the markup',
    `${nav.surface}: ${nav.hrefs.join(' ')}`);
  await page.evaluate(`(() => {
    [...document.querySelectorAll('#panelBody > [data-panel-tab] .grouptoggle')]
      .filter((b) => b.getAttribute('aria-expanded') === 'true')
      .forEach((b) => b.click());
    localStorage.removeItem('kinect.panelGroupsOpen');
  })()`);

  for (const tab of ['camera', 'framing', 'look', 'region']) {
    await page.locator(`.paneltab[data-panel-tab="${tab}"]`).click();
    const state = await page.evaluate(`(${((name) => {
      const groups = [...document.querySelectorAll('#panelBody > [data-panel-tab]')];
      const visible = groups.filter((group) => group.getClientRects().length > 0);
      return {
        active: document.querySelector('.paneltab[aria-selected="true"]')?.dataset.panelTab ?? null,
        visible: visible.map((group) => group.dataset.group || group.id),
        wrong: visible.filter((group) => group.dataset.panelTab !== name)
          .map((group) => group.dataset.group || group.id),
        total: groups.length,
      };
    }).toString()})(${JSON.stringify(tab)})`);
    check(state.active === tab && state.visible.length > 0 && state.wrong.length === 0,
      `the ${tab} inspector shows only the groups declared for it`,
      `${state.visible.join(', ')}; wrong: ${state.wrong.join(', ') || 'none'}; ${state.total} groups remain in the document`);
  }
  await page.locator('.paneltab[data-panel-tab="camera"]').click();

  await page.locator('#fileMenuButton').click();
  const fileMenu = await page.evaluate(`(() => ({
    open: !document.getElementById('fileMenu').hidden,
    items: [...document.querySelectorAll('#fileMenu [role=menuitem]')].map((el) => el.textContent.trim()),
  }))()`);
  check(fileMenu.open && fileMenu.items.length === 4,
    'File opens from the fixed bar and offers the four designed commands', fileMenu.items.join(' | '));
  const documentItems = await page.evaluate(`(() => ({
    rename: document.getElementById('menuRenameProject').disabled,
    duplicate: document.getElementById('menuDuplicateProject').disabled,
    why: document.getElementById('menuRenameProject').title,
    modal: Boolean(document.getElementById('renameDialog')),
  }))()`);
  check(documentItems.rename && documentItems.duplicate && documentItems.modal
    && /holds no project/.test(documentItems.why),
  'Rename and Duplicate are greyed on a page opened by a take, because it holds no document to act on',
  `rename ${documentItems.rename}, duplicate ${documentItems.duplicate}, "${documentItems.why}"`);
  await page.keyboard.press('Escape');

  await page.locator('#outputMenuButton').click();
  await page.locator('#menuExport').click();
  const exportDialog = await page.evaluate(`(() => ({
    open: document.getElementById('exportDialog').open,
    // The resolutions this dialog offers, where the ratio segments used to be read. The
    // segments moved to Project settings with the shape itself, and what is left here is
    // the pixel count - so this reads the menu that is now the deliverable's own choice,
    // and the row below asserts every entry in it is the shape the stage is letterboxed
    // to. That is the claim the split rests on: a resolution is not a reframe.
    resolutions: [...(document.getElementById('tExportSize')?.options ?? [])].map((o) => o.value),
    chosenSize: document.getElementById('tExportSize')?.value ?? '',
    aspect: globalThis.__kinect.outputSize().aspect,
    // The format segments, read as a set rather than by id. This row used to name
    // exportFormatMov and exportFormatPng and assert both were disabled, which encoded
    // a claim that has since stopped being true - the server grew prores and an image
    // sequence, so a row pinning them as unavailable would have been holding the dialog
    // to a limitation nobody has any more. Worse, it read disabled off the result of
    // getElementById without a guard, so when the segments were rebuilt around a codec
    // attribute the two ids went and the read threw: 17 assertions ran, 0 failed, exit 2,
    // for every mutation of every section. That is the crash wearing the shape of a catch
    // this repo has three entries about, and while it lasted no mutation in this file
    // could be reported as missed, because the count it is missed by was never zero.
    // Enumerated off the attribute so a fourth format is asked by existing.
    // No backticks in this comment on purpose - it lives inside a template literal, and
    // one here ends the literal. That is the fifth time in this repo.
    formats: [...document.querySelectorAll('#exportFormats button[data-codec]')].map((button) => ({
      codec: button.dataset.codec, disabled: button.disabled,
      pressed: button.getAttribute('aria-pressed') === 'true',
    })),
  }))()`);
  const offered = exportDialog.formats.map((format) => format.codec);
  const codecRefused = offered.map((codec) => {
    try {
      validateExport({ name: 'editor-check-codec', width: 1920, height: 1080, fps: 30, codec });
      return null;
    } catch (err) {
      return `${codec || '(unnamed)'}: ${err.message}`;
    }
  }).filter(Boolean);
  const offShape = exportDialog.resolutions.filter((value) => {
    const [w, h] = value.split('x').map(Number);
    if (!(w > 0 && h > 0)) return true;
    const gcd = (a, b) => (b ? gcd(b, a % b) : a);
    const d = gcd(w, h);
    return w / d !== exportDialog.aspect[0] || h / d !== exportDialog.aspect[1];
  });
  check(exportDialog.open && exportDialog.resolutions.length > 0,
    'Export opens the designed dialog with a resolution menu built from the authoritative size table',
    `${exportDialog.resolutions.length} sizes: ${exportDialog.resolutions.join(', ') || 'none'}`);
  check(offShape.length === 0,
    `  and every size it offers is the ${exportDialog.aspect.join(':')} the stage is framed at, so choosing one cannot reframe the clip`,
    offShape.length ? `off-shape: ${offShape.join(', ')}` : `all of ${exportDialog.resolutions.join(', ')}`);
  check(exportDialog.resolutions.includes(exportDialog.chosenSize),
    '  and the size it shows as chosen is one of them, rather than a value the menu cannot display',
    `chosen ${JSON.stringify(exportDialog.chosenSize)} of ${exportDialog.resolutions.join(', ')}`);
  check(offered.length >= 2 && exportDialog.formats.every((format) => !format.disabled),
    'and it offers a format per codec with every one of them enabled, rather than showing a refusal the encoder no longer makes',
    exportDialog.formats.map((f) => `${f.codec}${f.disabled ? ' DISABLED' : ''}`).join(', ') || 'no format segments');
  check(offered.length > 0 && codecRefused.length === 0,
    "and every codec it offers is one the server's own validator accepts, so the dialog cannot drift from the encoder",
    codecRefused.length ? codecRefused.join('; ') : `${offered.join(', ')} all pass validateExport`);
  check(exportDialog.formats.filter((format) => format.pressed).length === 1,
    'and exactly one of them shows as chosen, because a format is a choice among them rather than a set of them',
    `pressed ${exportDialog.formats.filter((f) => f.pressed).map((f) => f.codec).join(', ') || 'none'}`);

  const liveDeliverable = await page.evaluate('({ ...__kinect.library.activeDeliverable() })');
  // Guarded rather than indexed into: an `undefined.codec` here would be a TypeError inside
  // section 1, which is how this block's predecessor took the whole tool down at 17 assertions
  // with none failed.
  const other = exportDialog.formats.find((format) => !format.pressed);
  if (!other) {
    check(false, 'pressing a format writes it into the deliverable the render reads, and shows itself as the one chosen',
      `no unchosen segment to press: ${exportDialog.formats.map((f) => `${f.codec}=${f.pressed}`).join(', ') || 'no segments'}`);
  } else {
    await page.locator(`#exportFormats button[data-codec="${other.codec}"]`).click();
    const afterPress = await page.evaluate(`(() => ({
      pressed: [...document.querySelectorAll('#exportFormats button[data-codec]')]
        .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.codec),
      codec: globalThis.__kinect.library.activeDeliverable()?.codec ?? null,
    }))()`);
    check(afterPress.codec === other.codec && afterPress.pressed.join(',') === other.codec,
      'pressing a format writes it into the deliverable the render reads, and shows itself as the one chosen',
      `pressed ${other.codec}: the document reads ${afterPress.codec}, the dialog shows ${afterPress.pressed.join(',') || 'none'}`);

    const drift = [];
    for (const format of exportDialog.formats) {
      await page.locator(`#exportFormats button[data-codec="${format.codec}"]`).click();
      const got = await page.evaluate(`(() => ({
        codec: globalThis.__kinect.library.activeDeliverable()?.codec ?? null,
        pressed: [...document.querySelectorAll('#exportFormats button[data-codec]')]
          .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.codec).join(','),
      }))()`);
      drift.push({ asked: format.codec, ...got });
    }
    const wrong = drift.filter((d) => d.codec !== d.asked || d.pressed !== d.asked);
    check(drift.length >= 2 && wrong.length === 0,
      'and every format the dialog offers writes its own codec when pressed, so a segment cannot be markup with nothing behind it',
      wrong.length
        ? wrong.map((d) => `${d.asked} -> document ${d.codec}, shown ${d.pressed || 'none'}`).join('; ')
        : drift.map((d) => `${d.asked} -> ${d.codec}`).join(', '));

  // The other door: the deliverable is also reached by a project file, by the autosave and by the
  // picker, so a control painted from its own clicks is silently wrong for every other way
  // the document moves.
    const codecDoor = `ec${process.pid}-codec`;
    const doorCodec = offered.find((codec) => codec !== afterPress.codec);
    const doorBody = JSON.stringify({ ...liveDeliverable, name: codecDoor, codec: doorCodec });
    await page.evaluate(`(async () => {
      const res = await __ecWrite('/deliverables/' + encodeURIComponent(${JSON.stringify(codecDoor)}), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: ${JSON.stringify(doorBody)},
      });
      return res.ok;
    })()`);
    await page.evaluate(`(() => {
      const el = document.getElementById('tDeliverable');
      if (![...el.options].some((o) => o.value === ${JSON.stringify(codecDoor)})) {
        el.append(new Option(${JSON.stringify(codecDoor)}, ${JSON.stringify(codecDoor)}));
      }
      el.value = ${JSON.stringify(codecDoor)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settle();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const afterDoor = await page.evaluate(`(() => ({
      pressed: [...document.querySelectorAll('#exportFormats button[data-codec]')]
        .filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.dataset.codec),
      codec: globalThis.__kinect.library.activeDeliverable()?.codec ?? null,
      name: globalThis.__kinect.library.activeDeliverable()?.name ?? null,
    }))()`);
    check(afterDoor.codec === doorCodec && afterDoor.name === codecDoor,
      'a stored deliverable naming another codec really was adopted, or the row below tests nothing',
      `the document reads ${afterDoor.codec} under the name ${afterDoor.name}`);
    check(afterDoor.pressed.join(',') === doorCodec,
      'and the format segments follow the document rather than the press that last touched them',
      `the document reads ${afterDoor.codec}, the dialog shows ${afterDoor.pressed.join(',') || 'none'}`);

    await page.evaluate(`(() => {
      globalThis.__kinect.library.setActiveDeliverable(${JSON.stringify(liveDeliverable)});
      const el = document.getElementById('tDeliverable');
      const planted = [...el.options].find((o) => o.value === ${JSON.stringify(codecDoor)});
      if (planted) planted.remove();
      el.value = '';
      const segment = document.querySelector('#exportFormats button[data-codec=' + CSS.escape(${JSON.stringify(liveDeliverable.codec ?? '')}) + ']');
      if (segment) segment.click();
    })()`);
    const codecCleanup = await page.evaluate(`(async () => {
      const res = await __ecWrite('/deliverables/' + encodeURIComponent(${JSON.stringify(codecDoor)}), {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      });
      return res.ok;
    })()`);
    check(codecCleanup, 'and the deliverable this block planted was removed again',
      codecCleanup ? `${codecDoor} deleted` : `DELETE refused for ${codecDoor}`);
  }
  const nameBefore = await page.evaluate('document.getElementById("tExportName").value');
  const nameDoc = `ec${process.pid}-name`;
  const nameTrip = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const el = document.getElementById('tExportName');
    el.value = 'round-trip-probe';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const inDocument = k.library.activeDeliverable()?.name ?? null;
    const put = await __ecWrite('/deliverables/' + encodeURIComponent(${JSON.stringify(nameDoc)}), {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(k.library.activeDeliverable()),
    });
    if (!put.ok) return { failed: 'PUT ' + put.status };
    const stored = (await (await fetch('/deliverables/' + encodeURIComponent(${JSON.stringify(nameDoc)}))).json()).body?.name ?? null;
    // Typed over before the adoption, so what comes back cannot be what is already there.
    el.value = 'a-different-name';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    const sel = document.getElementById('tDeliverable');
    if (![...sel.options].some((o) => o.value === ${JSON.stringify(nameDoc)})) {
      sel.append(new Option(${JSON.stringify(nameDoc)}, ${JSON.stringify(nameDoc)}));
    }
    sel.value = ${JSON.stringify(nameDoc)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 400));
    return { inDocument, stored, afterAdoption: el.value };
  })()`);
  check(nameTrip.inDocument === 'round-trip-probe',
    'the name typed for the output reaches the deliverable that is supposed to remember it',
    nameTrip.failed ?? `the document reads ${JSON.stringify(nameTrip.inDocument)}`);
  check(nameTrip.stored === 'round-trip-probe',
    '  and the deliverable written to the server carries it, rather than the empty one it was seeded with',
    `stored ${JSON.stringify(nameTrip.stored)}`);
  check(nameTrip.afterAdoption === 'round-trip-probe',
    '  and adopting that deliverable puts it back, which is what makes two of them name two files',
    `the field reads ${JSON.stringify(nameTrip.afterAdoption)} after adopting over ${JSON.stringify('a-different-name')}`);
  await page.evaluate(`(async () => {
    const el = document.getElementById('tExportName');
    el.value = ${JSON.stringify(nameBefore)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    document.getElementById('tDeliverable').value = '';
    // The header is not decoration on a DELETE here - this server answers 415 without it,
    // and a rejected cleanup leaves the document behind and reddens the page-errors row.
    await __ecWrite('/deliverables/' + encodeURIComponent(${JSON.stringify(nameDoc)}), {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    });
  })()`);

  let newPrompt = null;
  page.once('dialog', async (dialog) => { newPrompt = dialog.message(); await dialog.dismiss(); });
  await page.locator('#tDeliverableNew').click();
  await new Promise((r) => setTimeout(r, 150));
  check(typeof newPrompt === 'string' && /deliverable/i.test(newPrompt),
    'the deliverable\'s new button reaches the writer that names one, rather than being markup in the dialog',
    newPrompt === null ? 'no prompt opened' : `prompt: ${JSON.stringify(newPrompt)}`);

  await page.locator('#exportClose').click();

  await page.locator('#fileMenuButton').click();
  await page.locator('#menuProjectSettings').click();
  const projectDialog = await page.evaluate(`(() => ({
    open: document.getElementById('projectDialog').open,
    aspects: [...document.querySelectorAll('#projectAspects button')].map((button) => ({
      label: button.textContent, aspect: button.dataset.aspect,
      selected: button.getAttribute('aria-pressed'),
    })),
    // Read off the control rather than off a list written here, for the reason the markup
    // gives for leaving it empty: restoreProject refuses a rate this build does not
    // offer, and a tool spelling the rates out again would be a third statement of a list
    // that is supposed to have one.
    // No backticks in this comment on purpose - it lives inside a template literal, and
    // one here ends the literal. That is the sixth time in this repo, and the fifth is
    // noted twenty lines up in this same section.
    rates: [...(document.getElementById('tFps')?.options ?? [])].map((o) => o.value),
    rate: document.getElementById('tFps')?.value ?? '',
  }))()`);
  check(projectDialog.open && projectDialog.aspects.length >= 5,
    'Project settings opens the designed dialog with a shape per group in the authoritative size table',
    `${projectDialog.aspects.length} shapes: ${projectDialog.aspects.map((a) => a.label).join(', ') || 'none'}`);
  check(projectDialog.aspects.filter((a) => a.selected === 'true').length === 1,
    '  and exactly one of them is lit, because the clip is framed at one shape rather than at a set of them',
    `lit: ${projectDialog.aspects.filter((a) => a.selected === 'true').map((a) => a.label).join(', ') || 'none'}`);
  check(projectDialog.rates.length >= 2 && projectDialog.rates.includes(projectDialog.rate),
    '  and the rate it shows is one the control offers, so the list the document is validated against is the list on screen',
    `${projectDialog.rate} of ${projectDialog.rates.join(', ') || 'none'}`);

  const stageAspect = () => page.evaluate(`(() => {
    const r = document.getElementById('stage').getBoundingClientRect();
    return r.height > 0 ? r.width / r.height : 0;
  })()`);
  const wasLit = projectDialog.aspects.find((a) => a.selected === 'true');
  const toPress = projectDialog.aspects.find((a) => a.selected !== 'true');
  if (!wasLit || !toPress) {
    check(false, 'pressing a shape reframes the stage and rebuilds the resolution menu under it',
      `nothing to press: lit ${wasLit?.label ?? 'none'}, unlit ${toPress?.label ?? 'none'}`);
  } else {
    const before = await stageAspect();
    // Moved off the size this shape opens on first, or the row below cannot fail: the opening
    // size for 16:9 is the table's default, so a round trip that starts there ends there whether
    // the displaced size is remembered or recomputed.
    const otherSize = await page.evaluate(`(() => {
      const sel = document.getElementById('tExportSize');
      const other = [...sel.options].map((o) => o.value).find((v) => v !== sel.value);
      if (!other) return null;
      sel.value = other;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return other;
    })()`);
    const sizeBefore = await page.evaluate('__kinect.outputSize().size');
    check(otherSize !== null && sizeBefore === otherSize,
      '  and this shape offers a second size to sit on, or the round trip below proves nothing',
      `moved to ${JSON.stringify(otherSize)}, the deliverable reads ${JSON.stringify(sizeBefore)}`);
    await page.locator(`#projectAspects button[data-aspect="${toPress.aspect}"]`).click();
    await settle();
    const pressed = await page.evaluate(`(() => ({
      aspect: globalThis.__kinect.outputSize().aspect.join('x'),
      sizes: [...document.getElementById('tExportSize').options].map((o) => o.value),
    }))()`);
    const after = await stageAspect();
    const wanted = toPress.aspect.split('x').map(Number);
    check(pressed.aspect === toPress.aspect
      && Math.abs(after - wanted[0] / wanted[1]) / (wanted[0] / wanted[1]) < 0.02,
      'pressing a shape writes it into the document and the stage is letterboxed to it',
      `pressed ${toPress.label}: the document reads ${pressed.aspect}, the stage is `
      + `${after.toFixed(4)} where ${(wanted[0] / wanted[1]).toFixed(4)} was asked for `
      + `(it was ${before.toFixed(4)})`);
    check(pressed.sizes.length > 0 && pressed.sizes.join(',') !== exportDialog.resolutions.join(','),
      '  and the resolution menu was rebuilt under it, rather than going on offering the old shape\'s sizes',
      `${pressed.sizes.join(', ') || 'none'} where the old shape offered ${exportDialog.resolutions.join(', ')}`);
    await page.locator(`#projectAspects button[data-aspect="${wasLit.aspect}"]`).click();
    await settle();
    const restored = await stageAspect();
    check(Math.abs(restored - before) < 1e-6,
      '  and pressing the shape it came in on puts the stage back, so no later section reads a frame this block moved',
      `${before.toFixed(6)} -> ${after.toFixed(6)} -> ${restored.toFixed(6)}`);
    const sizeRestored = await page.evaluate('__kinect.outputSize().size');
    const opens = await page.evaluate('__kinect.outputSize().size');
    check(sizeRestored === sizeBefore,
      '  and the resolution that shape was on comes back with it, rather than the one it opens on',
      `${sizeBefore} -> ${pressed.sizes[0]} -> ${sizeRestored}`
      + (sizeRestored === opens && sizeRestored !== sizeBefore ? ' (the opening size, so the displaced one was lost)' : ''));
    await page.evaluate(`(() => {
      const sel = document.getElementById('tExportSize');
      if (sel.value !== ${JSON.stringify(exportDialog.chosenSize)}) {
        sel.value = ${JSON.stringify(exportDialog.chosenSize)};
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
  }
  const rateBack = projectDialog.rate;
  const rateOther = projectDialog.rates.find((r) => r !== rateBack);
  if (!rateOther) {
    check(false, 'setting the output rate writes it into the transport the playhead is counted in',
      `only one rate offered: ${projectDialog.rates.join(', ') || 'none'}`);
  } else {
    const heldSec = await page.evaluate('__kinect.timeline.transport().programSec');
    await page.selectOption('#tFps', rateOther);
    await settle();
    const moved = await page.evaluate(`(() => ({
      fps: globalThis.__kinect.timeline.transport().outputFps,
      sec: globalThis.__kinect.timeline.transport().programSec,
    }))()`);
    check(moved.fps === Number(rateOther),
      'setting the output rate writes it into the transport the playhead is counted in',
      `asked ${rateOther}, the transport reads ${moved.fps}`);
    // The playhead is held across the change, which is the half a rate control gets wrong: frame
    // 300 is 10s at 30 and 5s at 60, so the assertion is about the second and not the frame.
    check(Math.abs(moved.sec - heldSec) < 1 / Math.min(...projectDialog.rates.map(Number)),
      '  and the playhead is held in seconds across it, rather than being reinterpreted at the new rate',
      `${heldSec.toFixed(4)}s -> ${moved.sec.toFixed(4)}s across ${rateBack} -> ${rateOther}fps`);
    await page.selectOption('#tFps', rateBack);
    await settle();
    const restoredRate = await page.evaluate('__kinect.timeline.transport().outputFps');
    check(restoredRate === Number(rateBack),
      '  and the rate it came in on goes back, so no later section counts frames at another one',
      `${rateBack} -> ${rateOther} -> ${restoredRate}`);
  }
  await page.locator('#projectDone').click();
  check(await page.evaluate('!document.getElementById("projectDialog").open'),
    '  and done shuts it, rather than being a button that only looks like the way out');
  await page.locator('#fileMenuButton').click();
  await page.locator('#menuProjectSettings').click();
  await page.locator('#projectClose').click();
  check(await page.evaluate('!document.getElementById("projectDialog").open'),
    '  and so does the close corner, so the dialog has two ways out and both of them work');

  const liveProject = await page.evaluate('__kinect.keyframes.project()');
  const liveSize = await page.evaluate('__kinect.outputSize().size');
  const refusals = await page.evaluate(`(async () => {
    const k = globalThis.__kinect;
    const out = {};
    const shape = k.outputSize().aspect.join(':');
    // A deliverable this build *can* read - version 2, everything else valid - whose only
    // fault is a size of another shape. Version 1 would be refused a line earlier by the
    // version gate, which is why the row that queues one cannot reach this.
    const wrongShape = shape === '16:9' ? '1080x1080' : '1920x1080';
    try {
      k.library.applyDeliverable({
        version: 2, in: 0, out: null, outputSize: wrongShape, codec: 'h264', name: '',
      });
      out.deliverable = 'adopted';
    } catch (err) { out.deliverable = err.message; }
    // And the size a render will use, handed over the way a queued job hands it over.
    // exportClip reads width and height ahead of the deliverable's own size, so this is the
    // only door that can be asked this question. No backticks in this comment on purpose -
    // it lives inside a template literal, and one here ends the literal. Eighth time.
    const [w, h] = wrongShape.split('x').map(Number);
    try {
      await k.export.run({ from: 0, to: 0, width: w, height: h, name: 'ec-shape-probe' });
      out.render = 'rendered';
    } catch (err) { out.render = err.message; }
    out.shape = shape;
    out.asked = wrongShape;
    return out;
  })()`);
  check(/framed at/.test(refusals.deliverable) && /not the/.test(refusals.deliverable),
    'a stored deliverable whose size is another shape is refused, which is the reframe a deliverable is not allowed to perform',
    `${refusals.shape} clip, ${refusals.asked} deliverable: ${String(refusals.deliverable).slice(0, 90)}`);
  check(/framed at/.test(refusals.render),
    'and a render handed a size of another shape is refused at the press, which is the backstop the job queue arrives through',
    `${refusals.shape} clip, asked for ${refusals.asked}: ${String(refusals.render).slice(0, 90)}`);

  const legacy = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const doc = JSON.parse(JSON.stringify(${JSON.stringify(liveProject)}));
    delete doc.aspect;
    delete doc.outputFps;
    doc.outputSize = '1600x900';
    try {
      k.library.restoreProject(doc);
      return {
        ok: true, aspect: k.outputSize().aspect.join(':'), size: k.outputSize().size,
        fps: k.timeline.transport().outputFps,
      };
    } catch (err) { return { ok: false, error: err.message }; }
  })()`);
  check(legacy.ok && legacy.aspect === '16:9',
    'a project carrying only the legacy outputSize is framed at the shape that size is',
    legacy.ok ? `1600x900 gives ${legacy.aspect}` : `refused: ${String(legacy.error).slice(0, 80)}`);
  check(legacy.size === '1600x900',
    '  and the pixels it named survive onto the deliverable, so it renders what it rendered before',
    `the deliverable reads ${legacy.size}`);
  check(legacy.fps === 30,
    '  and a document with no rate reads as 30, which is what absent has to mean for every project written before the rate moved',
    `${legacy.fps}fps`);

  const legacyOff = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    const doc = JSON.parse(JSON.stringify(${JSON.stringify(liveProject)}));
    delete doc.aspect;
    doc.outputSize = '1600x1000';
    try { k.library.restoreProject(doc); return { ok: true }; } catch (err) { return { ok: false, error: err.message }; }
  })()`);
  check(!legacyOff.ok && /offers no resolution for/.test(String(legacyOff.error)),
    '  while one whose shape this build has no size for is refused, rather than opened onto an export that cannot run',
    legacyOff.ok ? 'adopted 8:5' : String(legacyOff.error).slice(0, 100));

  await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.library.restoreProject(${JSON.stringify(liveProject)});
    k.setOutputSize(${JSON.stringify(liveSize)});
  })()`);
  await settle();

  const cameraBefore = await page.evaluate('__kinect.freeCamera.position.toArray()');
  await page.evaluate('__kinect.freeCamera.position.x += 2; __kinect.controls.update()');
  await page.locator('#viewMenuButton').click();
  await page.locator('#menuCameraReset').click();
  const cameraReset = await page.evaluate('__kinect.freeCamera.position.toArray()');
  check(cameraReset.every((value, i) => Math.abs(value - cameraBefore[i]) < 1e-6),
    'Default camera position reaches OrbitControls reset', `${cameraBefore.join(',')} -> ${cameraReset.join(',')}`);

  // And the pivot, which the row above cannot see: `OrbitControls` captures `target0` in its
  // constructor and `buildControls` copies the target in afterwards, so the home aim can be a fresh
  // `(0, 0, 0)` while the cloud sits at `(0, 0, -2.2)` and the position alone still reads restored.
  const pivot = await page.evaluate('__kinect.controls.target.toArray()');
  check(Math.hypot(pivot[0] - 0, pivot[1] - 0, pivot[2] - (-2.2)) < 1e-6,
    '  and the orbit pivot comes back with it, rather than the world origin the constructor captured before the target was written',
    `target ${pivot.map((v) => v.toFixed(4)).join(', ')} against the cloud's 0, 0, -2.2`);

  // The other half, which levelling reaches every time: the up vector cannot be reassigned, so
  // `setNavigationUp` rebuilds the object, and a rebuild that did not carry the home state over
  // would re-home Reset on wherever the camera happened to be.
  const movedTo = await page.evaluate(`(() => {
    const k = globalThis.__kinect;
    k.freeCamera.position.set(3, 2, 4);
    k.controls.update();
    // Through the parameter rather than by calling the rebuild directly, because what has
    // to survive is the rebuild an operator actually causes.
    k.params.set('tilt', 12);
    k.controls.update();
    return k.freeCamera.position.toArray();
  })()`);
  await settle();
  await page.locator('#viewMenuButton').click();
  await page.locator('#menuCameraReset').click();
  const afterRebuild = await page.evaluate(`(() => ({
    target: __kinect.controls.target.toArray(),
    position: __kinect.freeCamera.position.toArray(),
  }))()`);
  check(Math.hypot(afterRebuild.target[0], afterRebuild.target[1], afterRebuild.target[2] + 2.2) < 1e-6
    && afterRebuild.position.every((v, i) => Math.abs(v - cameraBefore[i]) < 1e-6),
    '  and a rebuild of the controls carries the home pose across, so levelling the room does not re-home Reset on wherever the camera was standing',
    `moved to ${movedTo.map((v) => v.toFixed(2)).join(', ')}, reset to `
    + `${afterRebuild.position.map((v) => v.toFixed(4)).join(', ')} aiming ${afterRebuild.target.map((v) => v.toFixed(4)).join(', ')}`);
  await page.evaluate("__kinect.params.set('tilt', 0)");
  await settle();

  // Read back through `controls.enabled` rather than through the attribute that was just written:
  // `setViewCamera` switches the orbit off while the program camera is on screen, so a build that
  // moved `aria-pressed` and left the view where it was would satisfy the attribute and fail this.
  const orbitBefore = await page.evaluate('__kinect.controls.enabled');
  await page.locator('#tCamView').click();
  const looking = await page.evaluate(`(() => ({
    orbit: __kinect.controls.enabled,
    strip: document.getElementById('tCamView').getAttribute('aria-pressed'),
    panel: document.getElementById('camView').getAttribute('aria-pressed'),
  }))()`);
  check(orbitBefore && looking.orbit === false && looking.strip === 'true' && looking.panel === 'true',
    'the strip looks through the program camera, and the panel copy of the toggle agrees',
    `orbit ${orbitBefore} -> ${looking.orbit}, strip ${looking.strip}, panel ${looking.panel}`);
  await page.locator('#tCamView').click();
  const handedBack = await page.evaluate('__kinect.controls.enabled');
  check(handedBack === true, 'and pressing it again hands the orbit back', `orbit ${handedBack}`);

  await page.locator('#viewMenuButton').click();
  await page.locator('#menuTopView').click();
  check(await page.evaluate('__kinect.keyframes.chrome.topView()') === false,
    'Show top view turns the plan overlay off through the View command');
  await page.locator('#viewMenuButton').click();
  await page.locator('#menuTopView').click();
  check(await page.evaluate('__kinect.keyframes.chrome.topView()') === true,
    'and the same command turns it back on');

  const fileChooser = page.waitForEvent('filechooser');
  await page.locator('#viewMenuButton').click();
  await page.locator('#menuLookImport').click();
  check(Boolean(await fileChooser), 'Import Look reaches the existing file input');
  await page.locator('#viewMenuButton').click();
  await page.locator('#menuLookExport').click();
  await page.waitForFunction('document.getElementById("presetPick").open');
  check(await page.evaluate('document.getElementById("presetPick").open'),
    'Export Look reaches the existing subset dialog');
  await page.locator('#ppCancel').click();

  const nerdSample = `(() => {
    const c = document.getElementById('chrome');
    if (!c || !c.width) return null;
    const ctx = c.getContext('2d');
    const dpr = c.width / parseFloat(c.style.width || c.width);
    const px = (n) => Math.round(n * dpr);
    const cssW = c.width / dpr;
    const d = ctx.getImageData(px(cssW - 178), px(140), px(164), px(140)).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) lit++;
    return lit;
  })()`;
  await page.locator('#viewMenuButton').click();
  const nerdBefore = await page.evaluate(nerdSample);
  await page.locator('#menuState').click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const nerdAfter = await page.evaluate(nerdSample);
  const nerdChecked = await page.getAttribute('#menuState', 'aria-checked');
  check(nerdBefore === 0 && nerdAfter > 0 && nerdChecked === 'true',
    'Stats for nerds paints the running editor onto the chrome overlay and marks itself on',
    `${nerdBefore} opaque pixels before, ${nerdAfter} after, aria-checked ${nerdChecked}`);
  await page.locator('#viewMenuButton').click();
  await page.locator('#menuState').click();
  await new Promise((resolve) => setTimeout(resolve, 200));
  const nerdOff = await page.evaluate(nerdSample);
  check(nerdOff === 0 && await page.getAttribute('#menuState', 'aria-checked') === 'false',
    'and the same command takes it off again, so every section below inherits a clean stage',
    `${nerdOff} opaque pixels left`);

  await page.evaluate(`(() => {
    globalThis.__obsCopied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (value) => { globalThis.__obsCopied.push(value); } },
    });
    globalThis.__openedObs = null;
    globalThis.open = (...args) => { globalThis.__openedObs = args; return null; };
    const size = document.getElementById('progSize');
    size.value = '1440x900';
    size.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await page.locator('#outputMenuButton').click();
  await page.locator('#menuObs').click();
  const customObsSize = await page.evaluate(`(() => ({
    value: document.getElementById('obsResolution').value,
    option: [...document.getElementById('obsResolution').options]
      .find((entry) => entry.value === '1440x900')?.textContent ?? null,
  }))()`);
  check(customObsSize.value === '1440x900' && customObsSize.option?.includes('current'),
    'Output to OBS reflects a valid custom size the existing control already accepted',
    JSON.stringify(customObsSize));
  await page.locator('#obsViewportMode').click();
  await page.locator('#obsResolution').selectOption('1280x720');
  await page.locator('#obsCopyBrowser').click();
  await page.locator('#obsCopyWebcam').click();
  await page.locator('#obsOpen').click();
  const obs = await page.evaluate(`(() => ({
    open: document.getElementById('obsDialog').open,
    mode: document.getElementById('progMode').value,
    size: document.getElementById('progSize').value,
    copied: globalThis.__obsCopied,
    opened: globalThis.__openedObs,
  }))()`);
  check(obs.open && obs.mode === 'mirror' && obs.size === '1280x720'
      && obs.copied.length === 2 && obs.opened?.[0] === obs.copied[0],
    'Output to OBS drives the existing mode and size and exposes both real source URLs', JSON.stringify(obs));
  await page.locator('#obsProgramMode').click();
  await page.locator('#obsDone').click();
  // The close event is queued after close(), so yield once before reading focus.
  // Keep this bounded: the mutation must fail an assertion rather than time out.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const obsReturnFocus = await page.evaluate('document.activeElement?.id');
  check(obsReturnFocus === 'outputMenuButton',
    'closing the OBS dialog returns focus to the visible Output trigger', obsReturnFocus || 'body');

  console.log('\n[2] the keyboard, and the guard that has to come with it');
  await page.evaluate('__kinect.timeline.transport().seek(6)');
  await settle();
  await focusStage();

  const playingBefore = (await read()).playing;
  await page.keyboard.press(' ');
  await new Promise((r) => setTimeout(r, 500));
  const playingAfter = (await read()).playing;
  check(!playingBefore && playingAfter, 'space starts playback', `${playingBefore} -> ${playingAfter}`);
  await page.keyboard.press(' ');
  await new Promise((r) => setTimeout(r, 400));
  check(!(await read()).playing, 'and space stops it again - the toggle is driven both ways');

  // ---- and the button, which was pausing without taking the transport
  await page.evaluate('__kinect.timeline.transport().seek(6)');
  await settle();
  // The window is found rather than timed, because timing it missed: measured on this rig with
  // `fixture-1g` the transport reports `playing` at 71ms and the clip first moves at 92ms, so the
  // window is about twenty milliseconds wide and a 60ms wait in the driver passed on
  // the mutated build.
  const pressedInPreRoll = await page.evaluate(`(async () => {
    const t = __kinect.timeline.transport();
    const button = document.getElementById('tPlay');
    const at = t.programSec;
    button.click();
    for (let i = 0; i < 500; i++) {
      if (t.playing && Math.abs(t.programSec - at) < 1e-6) {
        button.click();
        return { found: true, waited: i * 2 };
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    return { found: false, waited: 1000 };
  })()`);
  check(pressedInPreRoll.found,
    'the pause is pressed while the pre-roll is genuinely in flight, which is what makes the row below about the guard rather than about a take that had already started',
    `found the window ${pressedInPreRoll.waited}ms after the play press`);
  await new Promise((r) => setTimeout(r, 3000));
  const afterPress = await read();
  check(!afterPress.playing,
    'a pause pressed while the pre-roll is still running leaves the take stopped, rather than the play resuming behind the button',
    `playing ${afterPress.playing} at ${afterPress.programSec.toFixed(3)}s`);
  const glyph = await page.evaluate("document.getElementById('tPlay').getAttribute('aria-label')");
  check(glyph === 'Play', '  and the button says so, so the control and the transport agree about what is happening', String(glyph));

  // ---- and the earlier stretch of the same pre-roll, where `playing` is still false
  // A play from a drafted playhead is awaiting an accurate seek before it is a play at all, so
  // `playing` is deliberately false for that stretch.
  await page.evaluate('__kinect.timeline.transport().draft(4.0)');
  const pendingPress = await page.evaluate(`(() => {
    const t = __kinect.timeline.transport();
    const button = document.getElementById('tPlay');
    const before = { drafted: t.drafted, playing: t.playing };
    button.click();
    const within = { playing: t.playing, pending: t.pendingPlay };
    button.click();
    return { before, within };
  })()`);
  check(pendingPress.before.drafted && !pendingPress.within.playing && pendingPress.within.pending,
    'the second press lands while the play is still pending - drafted start, playing still false - which is what makes the row below about the pending state rather than about a rolling take',
    `drafted ${pendingPress.before.drafted}, playing ${pendingPress.within.playing}, pending ${pendingPress.within.pending}`);
  const afterPending = await page.evaluate(`(async () => {
    const t = __kinect.timeline.transport();
    for (let i = 0; i < 2000; i++) {
      if (!t.pendingPlay && !t.working) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 300));
    return { playing: t.playing, pending: t.pendingPlay };
  })()`);
  check(!afterPending.playing && !afterPending.pending,
    'a stop pressed inside the pending stretch leaves the take stopped once the seek resolves, rather than two plays resolving into a rolling take',
    `playing ${afterPending.playing}, pending ${afterPending.pending}`);

  await page.evaluate('__kinect.timeline.transport().pause()');
  await settle();

  const f0 = (await read()).frame;
  await page.keyboard.press('ArrowRight');
  await settle();
  const f1 = (await read()).frame;
  check(f1 === f0 + 1, 'right arrow steps exactly one output frame', `${f0} -> ${f1}`);
  await page.keyboard.press('ArrowLeft');
  await settle();
  check((await read()).frame === f0, 'and left steps exactly one back', `${f1} -> ${(await read()).frame}`);
  const fps = (await read()).outputFps;
  await page.keyboard.press('Shift+ArrowRight');
  await settle();
  check((await read()).frame === f0 + fps, 'shift-right steps one second, which is the rate rather than a constant',
    `${f0} -> ${(await read()).frame} at ${fps}fps`);

  await page.keyboard.press('Home');
  await settle();
  const home = (await read()).programSec;
  await page.keyboard.press('End');
  await settle();
  const end = (await read()).programSec;
  check(near(home, 0, 0.05) && end > home + 1, 'home and end park at the two ends of the clip',
    `${home.toFixed(3)}s and ${end.toFixed(3)}s`);

  await page.evaluate('__kinect.timeline.transport().seek(5)');
  await settle();
  await page.keyboard.press('i');
  await settle();
  await page.evaluate('__kinect.timeline.transport().seek(18)');
  await settle();
  await page.keyboard.press('o');
  await settle();
  const keyed = await range();
  check(near(keyed.in, 5, 0.1) && near(keyed.out, 18, 0.1), 'i and o set the range at the playhead',
    JSON.stringify(keyed));
  await page.evaluate('__kinect.timeline.transport().seek(12)');
  await settle();
  await page.keyboard.press('Shift+i');
  await settle();
  const jumped = await read();
  const afterJump = await range();
  check(near(jumped.programSec, 5, 0.1), 'shift-i jumps the playhead to in', `${jumped.programSec.toFixed(3)}s`);
  check(near(afterJump.in, keyed.in, 1e-6) && near(afterJump.out, keyed.out, 1e-6),
    'and moves the range not at all, which is the difference between the two gestures',
    JSON.stringify(afterJump));

  // The typing guard: `i`, `o` and `m` are letters somebody has to be able to put in a filename,
  // so a shortcut handler with no guard makes the export dialog's one text field unusable while
  // quietly editing the clip.
  await page.locator('#outputMenuButton').click();
  await page.locator('#menuExport').click();
  await page.evaluate(`(() => { const el = document.getElementById('tExportName'); el.value = ''; el.focus(); })()`);
  const beforeTyping = await range();
  const keysBeforeTyping = await lanes();
  await page.keyboard.type('iom');
  await new Promise((r) => setTimeout(r, 250));
  const typed = await page.locator('#tExportName').inputValue();
  const afterTyping = await range();
  check(typed === 'iom', 'the three shortcut letters can be typed into the name field', `"${typed}"`);
  check(JSON.stringify(beforeTyping) === JSON.stringify(afterTyping),
    'and typing them changed no clip range', `${JSON.stringify(beforeTyping)} then ${JSON.stringify(afterTyping)}`);
  check(JSON.stringify(keysBeforeTyping) === JSON.stringify(await lanes()),
    'and deleted no key');
  await page.evaluate(`(() => { const el = document.getElementById('tExportName'); el.value = ''; el.blur(); })()`);
  await page.locator('#exportClose').click();
  await focusStage();

  // ---- the loop, which is the only control that changes what reaching the out-point does
  // Driven over a two-second trim rather than over the clip, because a loop is visible only where
  // playback reaches an end and this take is a quarter of an hour long. Both halves are here on
  // purpose: a build that never loops passes the armed row if the unarmed one is not asserted
  // first, because a playhead that simply never got to the out-point reads the same as one that
  // wrapped back from it.
  const rangeBeforeLoop = await range();
  await page.evaluate('__kinect.editor.setClipRange(8, 10)');
  const LOOP_IN = 8;
  const LOOP_OUT = 10;
  /** Runs playback from just before the out-point and reports where it ended up. */
  const runToOutPoint = async () => {
    await page.evaluate('__kinect.timeline.transport().seek(9.6)');
    await settle();
    await page.locator('#tPlay').click();
    return page.evaluate(`(async () => {
      const t = __kinect.timeline.transport();
      for (let i = 0; i < 600; i++) {
        if (!t.playing && t.pendingPlay !== true) break;
        if (t.programSec < 9.4) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      return { playing: t.playing, programSec: t.programSec, looping: t.looping };
    })()`);
  };

  const loopOff = await page.evaluate(`(() => ({
    pressed: document.getElementById('tLoop').getAttribute('aria-pressed'),
    looping: __kinect.timeline.transport().looping,
  }))()`);
  check(loopOff.pressed === 'false' && loopOff.looping === false,
    'the loop button starts off, and the transport agrees with the button about that',
    `aria-pressed ${loopOff.pressed}, looping ${loopOff.looping}`);
  const unlooped = await runToOutPoint();
  check(!unlooped.playing && unlooped.programSec > LOOP_OUT - 0.1,
    '  and with it off, playback stops at the out-point rather than carrying on',
    `playing ${unlooped.playing} at ${unlooped.programSec.toFixed(3)}s of a ${LOOP_IN}-${LOOP_OUT}s range`);

  await page.locator('#tLoop').click();
  const loopOn = await page.evaluate(`(() => ({
    pressed: document.getElementById('tLoop').getAttribute('aria-pressed'),
    looping: __kinect.timeline.transport().looping,
  }))()`);
  check(loopOn.pressed === 'true' && loopOn.looping === true,
    '  pressing it arms the transport, and the button says so',
    `aria-pressed ${loopOn.pressed}, looping ${loopOn.looping}`);
  const looped = await runToOutPoint();
  check(looped.playing && looped.programSec < 9.4,
    '  and armed, the out-point sends the playhead back to the in-point with the take still running',
    `playing ${looped.playing} at ${looped.programSec.toFixed(3)}s of a ${LOOP_IN}-${LOOP_OUT}s range`);

  await page.evaluate('__kinect.timeline.transport().pause()');
  await page.locator('#tLoop').click();
  await page.evaluate(`__kinect.editor.setClipRange(${rangeBeforeLoop.in}, ${rangeBeforeLoop.out})`);
  await settle();
  await focusStage();

  console.log('\n[3] the in and out markers, which is the claim nothing was making');
  const markersPresent = async () => page.evaluate(`(() => {
    const box = (id) => {
      const el = document.getElementById(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: r.width, h: r.height, x: r.x, y: r.y };
    };
    return { in: box('tIn'), out: box('tOut') };
  })()`);
  const boxes = await markersPresent();
  check(boxes.in !== null && boxes.out !== null,
    'both markers are in the document at all - this is the row that was missing',
    `in ${boxes.in ? 'present' : 'ABSENT'}, out ${boxes.out ? 'present' : 'ABSENT'}`);
  check(Boolean(boxes.in && boxes.in.h > 10 && boxes.out && boxes.out.h > 10),
    'and both have a real box rather than a collapsed one',
    boxes.in ? `${boxes.in.w}x${boxes.in.h} and ${boxes.out.w}x${boxes.out.h}` : 'n/a');

  // Probed by what is under the pointer rather than by the box: the drawn line is 1px and the
  // grab zone is a pseudo-element, so a box measurement reports the wrong number in the
  // reassuring direction.
  const grabWidth = async (id) => page.evaluate(`(${((elId) => {
    const el = document.getElementById(elId);
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    // The ruler row's mid-height rather than the marker's. The marker box still runs the whole
    // column, so its own middle is deep in the lanes where the zone deliberately does not reach.
    const bed = document.getElementById('tBed');
    if (!bed) return 0;
    const bedR = bed.getBoundingClientRect();
    const mid = { x: r.x + r.width / 2, y: bedR.y + bedR.height / 2 };
    let n = 0;
    for (let dx = -18; dx <= 18; dx++) {
      const hit = document.elementFromPoint(mid.x + dx, mid.y);
      if (hit === el) n++;
    }
    return n;
  }).toString()})(${JSON.stringify(id)})`);
  await page.evaluate('__kinect.editor.setClipRange(0, null)');
  await settle();
  const grabOutAtEnd = await grabWidth('tOut');
  const grabIn = await grabWidth('tIn');
  check(grabOutAtEnd >= 10, 'out is grabbable where it is hardest to be - at "end", on the strip\'s right edge',
    `${grabOutAtEnd}px of reach`);
  check(grabIn >= 10, 'and in is grabbable at zero, on the left edge', `${grabIn}px of reach`);

  // Guarded on the markers existing, because the whole point of this section is a build where
  // they do not - an unguarded dereference here exits 2 as DID NOT RUN and discards the red rows
  // that had already caught the mutation.
  const markersUsable = boxes.in !== null && boxes.out !== null;
  await page.evaluate('__kinect.timeline.transport().seek(30)');
  await settle();
  await focusStage();
  await page.keyboard.press('o');
  await settle();
  const beforeDrag = await range();
  let afterDrag = beforeDrag;
  if (!markersUsable) {
    check(false, 'dragging the out marker left shortens the export range', 'there is no marker to drag');
    check(false, 'and what the export leaves out is drawn, in proportion to what it leaves out',
      'not reached - the marker is absent');
  } else {
    const outMid = await page.evaluate(`(() => {
      const r = document.getElementById('tOut').getBoundingClientRect();
      const bedR = document.getElementById('tBed').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: bedR.y + bedR.height / 2 };
    })()`);
    await page.mouse.move(outMid.x, outMid.y);
    await page.mouse.down();
    await page.mouse.move(outMid.x - 300, outMid.y, { steps: 8 });
    await page.mouse.up();
    await settle();
    afterDrag = await range();
    check(afterDrag.out < beforeDrag.out - 1, 'dragging the out marker left shortens the export range',
      `${beforeDrag.out.toFixed(3)}s -> ${afterDrag.out.toFixed(3)}s`);

    const shade = await page.evaluate(`(() => {
      const bed = document.getElementById('tBeds').getBoundingClientRect();
      const outEl = document.getElementById('tShadeOut');
      if (!outEl) return null;
      const r = outEl.getBoundingClientRect();
      return { bedW: bed.width, outW: r.width };
    })()`);
    const dur = (await read()).duration;
    const expectedFraction = 1 - (afterDrag.out / dur);
    check(shade !== null && near(shade.outW / shade.bedW, expectedFraction, 0.02),
      'and what the export leaves out is drawn, in proportion to what it leaves out',
      shade ? `${(shade.outW / shade.bedW * 100).toFixed(1)}% shaded against ${(expectedFraction * 100).toFixed(1)}% excluded`
        : 'the shading element is not in the document either');
  }

  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [{ t: 1, value: 0.2 }, { t: 6, value: 0.9 }] })`);
  await settle();
  const afterLanes = await markersPresent();
  check(afterLanes.in !== null && afterLanes.out !== null && afterLanes.out.h > 10,
    'and both markers survive a lane being built, which is when they used to disappear',
    `${(await keyedLanes()).length} keyed lanes, in ${afterLanes.in ? 'present' : 'GONE'}, out ${afterLanes.out ? 'present' : 'GONE'}`);
  check(near((await range()).out ?? -1, afterDrag.out ?? -1, 1e-6),
    'and the range they show is unchanged by it', JSON.stringify(await range()));
  await page.locator('#outputMenuButton').click();
  await page.locator('#menuWholeClip').click();
  await settle();
  const menuCleared = await range();
  check(menuCleared.out === null && menuCleared.in === 0,
    'the Output menu restores the whole clip, with null rather than the current duration at its end',
    JSON.stringify(menuCleared));

  await page.evaluate('__kinect.timeline.transport().seek(10)');
  await settle();
  await focusStage();
  await page.keyboard.press('i');
  await page.evaluate('__kinect.timeline.transport().seek(30)');
  await settle();
  await focusStage();
  await page.keyboard.press('o');
  await settle();
  const narrowedForShortcut = await range();
  check(narrowedForShortcut.in > 0 && narrowedForShortcut.out < takeSec,
    'the keyboard planted a narrower range before its reset shortcut is asked',
    JSON.stringify(narrowedForShortcut));
  await focusStage();
  await page.keyboard.press('Alt+x');
  await settle();
  const shortcutCleared = await range();
  check(shortcutCleared.out === null && shortcutCleared.in === 0,
    'Option-X restores the whole clip through the same user action', JSON.stringify(shortcutCleared));
  // Where the zone must not reach. `elementFromPoint` rather than a box measurement, for the same
  // reason the reach probe uses one: the zone is a pseudo-element and no box reports it. The walk
  // steps past a key, an ease handle or a clip box, because all three sit at or above the markers
  // and a probe under one cannot see this zone at all - what it is looking for is bare lane.
  await page.evaluate('__kinect.editor.setClipRange(0, null)');
  await settle();
  const laneProbe = await page.evaluate(`(${(() => {
    const beds = document.getElementById('tBeds');
    const bed = document.getElementById('tBed');
    if (!beds || !bed) return null;
    const bedsR = beds.getBoundingClientRect();
    const rulerR = bed.getBoundingClientRect();
    const lanes = document.getElementById('tLanes');
    const lanesR = lanes ? lanes.getBoundingClientRect() : null;
    const ys = [];
    if (lanesR && lanesR.height > 2) {
      for (const lane of document.querySelectorAll('#tLanes .tlane')) {
        const r = lane.getBoundingClientRect();
        const y = r.y + r.height / 2;
        if (y > lanesR.y + 1 && y < lanesR.bottom - 1) ys.push({ y, from: 'a keyed lane' });
      }
    }
    // Then every row of the column below the ruler, so a run whose lanes are all covered still
    // has somewhere bare to ask about rather than declining to ask.
    for (let y = rulerR.bottom + 4; y < bedsR.bottom - 2; y += 8) ys.push({ y, from: 'below the ruler' });
    const name = (el) => (el ? (el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${el.getAttribute('class') || '(no class)'}`) : 'nothing');
    const probe = (elId, inward) => {
      const el = document.getElementById(elId);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const x = r.x + r.width / 2 + inward;
      let last = null;
      for (const cand of ys) {
        const hit = document.elementFromPoint(x, cand.y);
        const isMarker = Boolean(hit && hit.closest('.tcut'));
        const covered = Boolean(hit && !isMarker && hit.closest('.tkey, .thandle, .tclip'));
        last = { x, y: cand.y, from: cand.from, isMarker, covered, what: name(hit),
          whitespace: Boolean(hit && !isMarker && !covered && hit.closest('#tBeds')) };
        // A marker answering is the finding; bare lane is the answer this wants. Anything drawn
        // over the zone is neither, so the walk carries on to the next row.
        if (isMarker || last.whitespace) return last;
      }
      return last;
    };
    return { in: probe('tIn', 8), out: probe('tOut', -8) };
  }).toString()})()`);
  const laneReach = (side) => {
    const at = laneProbe && laneProbe[side];
    if (!at) return 'there is no marker to probe';
    return `at (${Math.round(at.x)}, ${Math.round(at.y)}) ${at.from}, the press reaches ${at.what}`;
  };
  check(Boolean(laneProbe && laneProbe.in && !laneProbe.in.isMarker),
    'the in marker answers no press 8px inward of its line once the ruler row has ended',
    laneReach('in'));
  check(Boolean(laneProbe && laneProbe.out && !laneProbe.out.isMarker),
    'and neither does the out marker, on the side its own zone reaches',
    laneReach('out'));

  // Asked only where the press would land on bare lane. On a clip it would be a clip drag, which
  // moves the edit and poisons every section after this one - named and skipped rather than run.
  if (laneProbe && laneProbe.in && laneProbe.in.whitespace) {
    const heldSelection = await page.evaluate('__kinect.editor.clipSelection()');
    const beforeLaneDrag = await range();
    await page.mouse.move(laneProbe.in.x, laneProbe.in.y);
    await page.mouse.down();
    await page.mouse.move(laneProbe.in.x + 300, laneProbe.in.y, { steps: 8 });
    await page.mouse.up();
    await settle();
    const afterLaneDrag = await range();
    check(near(afterLaneDrag.in, beforeLaneDrag.in, 1e-6) && afterLaneDrag.out === beforeLaneDrag.out,
      'and a 300px drag from that lane point leaves the export range where it was',
      `${JSON.stringify(beforeLaneDrag)} -> ${JSON.stringify(afterLaneDrag)}`);
    // The press deselects, which is the gesture this change hands back to the lane. Put the
    // selection and the range back so the sections after this one get the fixture they expect.
    await page.evaluate(`(${((id) => {
      __kinect.editor.setClipRange(0, null);
      if (id) __kinect.editor.selectClipRow(id);
    }).toString()})(${JSON.stringify(heldSelection)})`);
    await settle();
  } else {
    note('a drag from that point is not asked',
      `it reaches ${laneProbe && laneProbe.in ? laneProbe.in.what : 'nothing'} rather than bare lane, `
      + 'and dragging a clip there would move the edit under the sections after this one');
  }

  // Cleanup is not another claim. On `whole-clip-does-nothing` both user paths have already
  // reddened; leave the later transport sections their ordinary whole-clip fixture rather than
  // turning one missing action into unrelated speed and playback failures.
  await page.evaluate('__kinect.editor.setClipRange(0, null)');
  await settle();

  console.log('\n[4] the speed control holds the frame you are looking at');
  // This block runs at the head of the section rather than at its tail, and the placement is
  // load-bearing: at the tail it left section 5's ease-handle drag dead on a page whose state was
  // byte-identical to a passing run's.
  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await settle();
  await page.evaluate("document.getElementById('tRate').focus()");
  await page.evaluate('__kinect.timeline.transport().play()');
  await new Promise((r) => setTimeout(r, 300));
  const heldBefore = await page.evaluate(`(() => ({
    playing: __kinect.timeline.transport().playing,
    depth: __kinect.keyframes.undo.depth(),
    seeks: __kinect.timeline.counters.seeks,
    rate: __kinect.timeline.read().speed,
  }))()`);
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    const step = 0.01;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    for (let i = 1; i <= 6; i++) {
      el.value = String(Number(el.value) + step);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', repeat: true, bubbles: true }));
      // A modifier tapped in the middle of the hold, which a hand on a keyboard does
      // constantly and which used to end the gesture on its release - the arrow was still
      // repeating, so the next repeat opened a second gesture against a transport the
      // first had already paused. Without this the drive is a clean hold that no stray
      // release ever interrupts, and the rule about *which* key ends a gesture is
      // asserted by nothing.
      if (i === 3) {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', bubbles: true }));
      }
    }
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  })()`);
  await settle();
  for (let i = 0; i < 60 && !(await page.evaluate('__kinect.timeline.transport().playing')); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  const heldAfter = await page.evaluate(`(() => ({
    playing: __kinect.timeline.transport().playing,
    depth: __kinect.keyframes.undo.depth(),
    seeks: __kinect.timeline.counters.seeks,
    rate: __kinect.timeline.read().speed,
  }))()`);
  check(heldBefore.playing && heldAfter.rate > heldBefore.rate,
    'a held arrow key moves the speed, so the two counters below are counting a gesture that happened',
    `${heldBefore.rate}x -> ${heldAfter.rate}x, take was running ${heldBefore.playing}`);
  check(heldAfter.depth - heldBefore.depth === 1,
    '  and costs one undo step for the whole hold, not one per repeat',
    `depth ${heldBefore.depth} -> ${heldAfter.depth}`);
  check(heldAfter.seeks - heldBefore.seeks <= 2,
    '  and one accurate seek, which is the storm this control exists to avoid',
    `${heldAfter.seeks - heldBefore.seeks} seeks for 6 repeats`);
  check(heldAfter.playing,
    '  and gives the take back, rather than losing the play intent on the first repeat',
    `playing ${heldBefore.playing} -> ${heldAfter.playing}`);

  // Stopped and put back to 1x before the rows below drive rates of their own: the accumulators
  // walk forward one source frame at a time, so a rate driven underneath a moving playhead asks
  // the source to go back, which reddens the page-errors row at the end of the file.
  await focusStage();
  await page.evaluate('__kinect.timeline.transport().pause()');
  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await page.evaluate('__kinect.timeline.transport().seek(0)');
  await settle();

  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await settle();
  await page.evaluate('__kinect.timeline.transport().play()');
  await new Promise((r) => setTimeout(r, 300));
  const runningBefore = await page.evaluate('__kinect.timeline.transport().playing');
  // The release and the navigation go in one task with no round trip between them: the resume
  // rides the release's pre-roll, so a navigation arriving after the pre-roll has finished has
  // nothing left to invalidate and the mutation walks past.
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    el.value = String(__kinect.editor.rateSlider.toValue(1.6));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    // Out of the control first, or the window handler's typing guard skips the key.
    el.blur();
    globalThis.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  })()`);
  await settle();
  await new Promise((r) => setTimeout(r, 1500));
  const afterNav = await page.evaluate('__kinect.timeline.transport().playing');
  check(runningBefore,
    'a take is running when the speed gesture starts, so the release below has a resume to queue',
    `playing ${runningBefore}`);
  check(afterNav === false,
    '  and a navigation arriving inside its pre-roll keeps it stopped, rather than the resume starting it again',
    `playing ${runningBefore} -> ${afterNav}`);
  await page.evaluate('__kinect.timeline.transport().pause()');
  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await settle();



  const driveRate = async (rate) => {
    await page.evaluate(`(() => {
      const el = document.getElementById('tRate');
      el.value = String(__kinect.editor.rateSlider.toValue(${rate}));
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    })()`);
    await settle();
    const landed = await page.evaluate('__kinect.timeline.read().speed');
    check(near(landed, rate, 1e-6), `  the slider went to ${rate}x when it was asked for ${rate}x`,
      `landed at ${landed}x`);
    return landed;
  };

  const rateArm = async (parkAt, to) => {
    await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
    await driveRate(1);
    await page.evaluate(`__kinect.timeline.transport().seek(${parkAt})`);
    await settle();
    const before = await read();
    const leftBefore = await page.evaluate(`document.getElementById('tPlayhead').style.left`);
    await driveRate(to);
    const after = await read();
    const leftAfter = await page.evaluate(`document.getElementById('tPlayhead').style.left`);
    return { before, after, leftBefore, leftAfter };
  };

  for (const [parkAt, to] of [[10, 2], [10, 0.5], [24, 2]]) {
    const arm = await rateArm(parkAt, to);
    check(near(arm.after.sourceSec, arm.before.sourceSec, 1e-3),
      `at ${parkAt}s, changing speed to ${to}x holds the source frame`,
      `source ${arm.before.sourceSec.toFixed(4)}s -> ${arm.after.sourceSec.toFixed(4)}s`);
    check(near(parseFloat(arm.leftAfter), parseFloat(arm.leftBefore), 0.05),
      '  and holds the playhead at the same place on a ruler that rescaled under it',
      `${arm.leftBefore} -> ${arm.leftAfter}, duration ${arm.before.duration.toFixed(2)}s -> ${arm.after.duration.toFixed(2)}s`);
    check(!near(arm.after.programSec, arm.before.programSec, 1e-3),
      '  by moving program time, which is what proves it held the other one',
      `program ${arm.before.programSec.toFixed(3)}s -> ${arm.after.programSec.toFixed(3)}s`);
  }

  // The three arms above agree about the output grid: 10s and 24s are frames 300 and 720 at
  // 30fps, and 2x and 0.5x take those to 150, 600 and 360 - all exactly on the grid, so the 1e-3
  // tolerance never exercises the rounding.
  const offGrid = await rateArm(10, 2.35);
  const drift = Math.abs(offGrid.after.sourceSec - offGrid.before.sourceSec);
  const bound = 2.35 / (2 * offGrid.before.outputFps);
  check(drift > 1e-3,
    'at a rate the output grid cannot represent, the anchor does move - which the three arms above never showed',
    `source ${offGrid.before.sourceSec.toFixed(4)}s -> ${offGrid.after.sourceSec.toFixed(4)}s, `
    + `${(drift * 1000).toFixed(1)}ms at 2.35x`);
  check(drift <= bound + 1e-9,
    '  and no further than half an output frame, which is the whole of what the grid costs',
    `${(drift * 1000).toFixed(1)}ms against a bound of ${(bound * 1000).toFixed(1)}ms `
    + `at ${offGrid.before.outputFps}fps`);

  // ------------------------------- and the rest of the strip, which held the same bug longer
  const STRIP = () => {
    // Every read goes through a guard, because `lanes-clear-siblings` takes the shades with the
    // markers and an unguarded `.style` here throws inside a `page.evaluate` two sections after the
    // mutation was already caught - exit 2 as DID NOT RUN, with its correct red rows discarded.
    const left = (sel) => { const el = document.querySelector(sel); return el ? el.style.left : null; };
    const box = (sel) => {
      const el = document.querySelector(sel);
      return el ? `${el.style.left}+${el.style.width}` : null;
    };
    return {
      playhead: left('#tPlayhead'),
      tIn: left('#tIn'),
      tOut: left('#tOut'),
      shadeIn: box('#tShadeIn'),
      shadeOut: box('#tShadeOut'),
      clipKeys: [...document.querySelectorAll('.tlane[data-owner$="/pointSize"] .tkey')]
        .map((k) => k.style.left).join(' '),
      projectKeys: [...document.querySelectorAll('.tlane[data-owner=bloom] .tkey')]
        .map((k) => k.style.left).join(' '),
      marks: [...document.querySelectorAll('#tMarks .tmk')].map((m) => m.style.left).join(' '),
      clipKeyTimes: (__kinect.keyframes.project().clips[0].tracks.pointSize ?? [])
        .map((k) => k.t.toFixed(4)).join(' '),
      projectKeyTimes: (__kinect.keyframes.project().look.tracks.bloom ?? [])
        .map((k) => k.t.toFixed(4)).join(' '),
      cameraTimes: (__kinect.keyframes.project().composition.camera ?? []).map((k) => k.t.toFixed(4)).join(' '),
      clip: __kinect.editor.clipRange(),
      duration: __kinect.timeline.transport().duration,
    };
  };
  const strip = () => page.evaluate(`(${STRIP})()`);

  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [ { t: 2, value: 0.2 }, { t: 6, value: 0.9 } ] })`);
  await page.evaluate(`(() => {
    const body = __kinect.library.serialiseProjectBody();
    body.clips[0].tracks.pointSize = [ { t: 2, value: 4 }, { t: 6, value: 12 } ];
    __kinect.library.restoreProject(body);
  })()`);
  await page.evaluate(`(() => {
    __kinect.timeline.transport().pause();
    __kinect.setViewCamera(__kinect.viewCamera());
    __kinect.keyframes.toggle('camera');
  })()`);
  await page.evaluate(`__kinect.editor.setMarks([{ id: 'm1', sourceMs: 3000, label: 'probe' }])`);
  await settle();
  await page.evaluate(`__kinect.timeline.transport().seek(1.5)`);
  await settle();
  await focusStage();
  await page.keyboard.press('i');
  await page.evaluate(`__kinect.timeline.transport().seek(7)`);
  await settle();
  await page.keyboard.press('o');
  await page.evaluate(`__kinect.timeline.transport().seek(4)`);
  await settle();

  await driveRate(1.2);
  const at120 = await strip();
  await driveRate(2.35);
  const at235 = await strip();
  // Read after the second rate change rather than before it: the slider's `change` commits, so a
  // depth taken before it is a level short and the row reads 9 -> 9 on a pop that worked.
  const undoBefore = await page.evaluate('__kinect.keyframes.undo.depth()');

  check(at235.duration < at120.duration - 1e-6,
    'the ruler really did rescale from 1.20x to 2.35x, or none of the rows below mean anything',
    `${at120.duration.toFixed(3)}s -> ${at235.duration.toFixed(3)}s`);
  for (const [term, label] of [
    ['clipKeys', "the selected clip's keyframes hold their place on the ruler"],
    ['marks', "the take's marks hold theirs, without being rescaled to do it"],
  ]) {
    check(at120[term] === at235[term], `  ${label}`, `${at120[term]} -> ${at235[term]}`);
  }
  check(near(parseFloat(at235.playhead), parseFloat(at120.playhead), 0.05),
    '  and so does the playhead', `${at120.playhead} -> ${at235.playhead}`);
  check(at120.clipKeyTimes !== at235.clipKeyTimes,
    '  by rescaling the clip-local times underneath, which is what proves it carried them',
    `keys ${at120.clipKeyTimes} -> ${at235.clipKeyTimes}`);
  check(at120.projectKeyTimes === at235.projectKeyTimes && at120.projectKeys !== at235.projectKeys,
    'the project effect keys keep their authored program times and therefore move on the shorter ruler',
    `times ${at120.projectKeyTimes} -> ${at235.projectKeyTimes}, positions ${at120.projectKeys} -> ${at235.projectKeys}`);
  check(at120.cameraTimes !== '' && at120.cameraTimes === at235.cameraTimes,
    'and the camera track keeps its authored program times, although it is serialised down a different branch',
    `camera ${at120.cameraTimes} -> ${at235.cameraTimes}`);
  check(at120.clip.in === at235.clip.in && at120.clip.out === at235.clip.out
      && at120.tIn !== at235.tIn && at120.tOut !== at235.tOut,
    'the project cuts keep their authored times and move on the shorter ruler with the camera',
    `range ${at120.clip.in.toFixed(4)}-${at120.clip.out.toFixed(4)} -> `
      + `${at235.clip.in.toFixed(4)}-${at235.clip.out.toFixed(4)}, positions ${at120.tIn}/${at120.tOut} -> ${at235.tIn}/${at235.tOut}`);
  const k = 1.2 / 2.35;
  check(at235.clipKeyTimes.split(' ').every((t, i) => near(
    Number(t), Number(at120.clipKeyTimes.split(' ')[i]) * k, 1e-4,
  )),
  'the selected clip keys move by exactly the ratio of the two rates',
  `${at120.clipKeyTimes} -> ${at235.clipKeyTimes}, ratio ${k.toFixed(4)}`);

  await page.evaluate(`__kinect.keyframes.undo.pop()`);
  await settle();
  const undone = await strip();
  const undoAfter = await page.evaluate('__kinect.keyframes.undo.depth()');
  check(undoAfter < undoBefore,
    '  undo actually popped a level, so the rows below are about a restore',
    `depth ${undoBefore} -> ${undoAfter}`);
  check(near(undone.duration, at120.duration, 1e-6),
    '  undoing a speed change puts the ruler back', `${undone.duration.toFixed(3)}s against ${at120.duration.toFixed(3)}s`);
  check(undone.tIn === at120.tIn && undone.tOut === at120.tOut,
    '  and puts the cuts back with it, which the snapshot alone cannot do',
    `in ${at120.tIn} -> ${undone.tIn}, out ${at120.tOut} -> ${undone.tOut}`);
  check(undone.clipKeys === at120.clipKeys && undone.clipKeyTimes === at120.clipKeyTimes,
    "  and the selected clip's keys", `${at120.clipKeyTimes} -> ${undone.clipKeyTimes}`);

  // The detent at 1.00x, the one rate that has to be reachable exactly rather than approximately:
  // the audio gate reads it too, and a take playing at 0.9995 is not normal speed.
  const atSlider = async (offset) => {
    await page.evaluate(`(() => {
      const el = document.getElementById('tRate');
      el.value = String(__kinect.editor.rateSlider.toValue(1) + ${offset});
      el.dispatchEvent(new Event('input'));
      el.dispatchEvent(new Event('change'));
    })()`);
    await settle();
    return page.evaluate('__kinect.timeline.read().speed');
  };
  // Driven by pixel as well as by value, because a detent is a hit target: the band was stated as
  // +/-3% of rate, which on a travel spanning a factor of 40 is 0.74px each side of the 92px
  // slider - sub-pixel, on a build whose value-driven rows all passed.
  const rateBox = await page.locator('#tRate').boundingBox();
  check(rateBox.width < 200,
    'the speed slider is the narrow one the stylesheet ships, which is what the band has to fit',
    `${rateBox.width.toFixed(0)}px`);
  // The two terms are taken apart rather than swept: a range input's track is shorter than its
  // box by the thumb, and clicking arms the detent, so a pixel-at-a-time sweep answers the same
  // number with the band and without it.
  const bandInTravel = await page.evaluate(`(() => {
    const one = __kinect.editor.rateSlider.toValue(1);
    let lo = 0;
    let hi = 1;
    // The largest offset from the 1.00x position that still comes back as exactly 1.
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (__kinect.editor.rateSlider.toRate(one + mid) === 1) lo = mid; else hi = mid;
    }
    return lo;
  })()`);
  const travelPerPixel = await (async () => {
    const read = async (dx) => {
      await page.mouse.click(rateBox.x + dx, rateBox.y + rateBox.height / 2);
      return page.evaluate("Number(document.getElementById('tRate').value)");
    };
    const near = await read(10);
    const far = await read(Math.round(rateBox.width) - 10);
    return (far - near) / (Math.round(rateBox.width) - 20);
  })();
  await settle();
  const bandPx = bandInTravel / Math.max(1e-9, travelPerPixel);
  check(travelPerPixel > 0,
    '  and a pixel of it is worth a measurable amount of travel, or the row below divides by noise',
    `${(1 / travelPerPixel).toFixed(1)}px of track across a ${rateBox.width.toFixed(0)}px box`);
  check(bandPx >= 2,
    '  and exactly 1.00x is reachable across at least two pixels either side of it',
    `${bandPx.toFixed(2)}px each side, from a band of ${bandInTravel.toFixed(5)} travel`);

  const inBand = await atSlider(0.005);
  check(inBand === 1, 'a slider position just off 1.00x snaps to exactly 1, not to 0.99-something',
    `landed at ${inBand}`);
  const outOfBand = await atSlider(0.05);
  check(outOfBand !== 1 && outOfBand > 1,
    '  and a position clear of the detent is left alone, so the band is a detent and not a floor',
    `landed at ${outOfBand}`);

  // A detent is for a value you are aiming at, not one you already had: a project can carry 1.02x
  // and the first small input in the same neighbourhood came through the band and
  // returned exactly 1.00.
  const nudged = await page.evaluate(`(async () => {
    (__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1.02));
    await __kinect.timeline.settled();
    const el = document.getElementById('tRate');
    const loaded = { rate: __kinect.timeline.read().speed, value: Number(el.value) };
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    el.value = String(loaded.value + 0.001);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await __kinect.timeline.settled();
    const nudge = __kinect.timeline.read().speed;
    // Out of the band and back in, which is a gesture that aimed at 1.00x rather than one
    // that started next to it - the snap has to still happen there or the band is gone.
    el.value = String(__kinect.editor.rateSlider.toValue(1.5));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await __kinect.timeline.settled();
    const away = __kinect.timeline.read().speed;
    el.value = String(__kinect.editor.rateSlider.toValue(1.005));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await __kinect.timeline.settled();
    const returned = __kinect.timeline.read().speed;
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
    el.blur();
    await __kinect.timeline.settled();
    return { loaded: loaded.rate, nudge, away, returned };
  })()`);
  check(near(nudged.loaded, 1.02, 1e-9),
    'a project carrying 1.02x loads at 1.02x, which is a rate no slider could have made',
    `${nudged.loaded}x`);
  check(nudged.nudge !== 1 && Math.abs(nudged.nudge - 1.02) < 0.02,
    '  and a small nudge beside it moves it a little rather than snapping two percent to 1.00x',
    `${nudged.loaded}x -> ${nudged.nudge}x`);
  check(near(nudged.away, 1.5, 1e-3),
    '  the same gesture can still leave the band', `${nudged.away}x`);
  check(nudged.returned === 1,
    '  and coming back into it from outside still snaps, which is what the band is for',
    `landed at ${nudged.returned}x`);
  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await settle();

  await page.evaluate('__kinect.timeline.counters.seeks = 0');
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    for (let i = 0; i < 20; i++) { el.value = String(0.4 + i * 0.02); el.dispatchEvent(new Event('input')); }
    el.dispatchEvent(new Event('change'));
  })()`);
  await settle();
  const seeks = await page.evaluate('__kinect.timeline.counters.seeks');
  check(seeks <= 2, 'twenty slider steps cost one accurate seek, not twenty', `${seeks} seeks`);

  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [
    { t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 } ] })`);
  await settle();
  const beforeCounters = await page.evaluate('({ ...__kinect.timeline.counters })');
  const kb = await page.locator('.tlane[data-owner=bloom] .tkey').nth(1).boundingBox();
  await page.mouse.move(kb.x + kb.width / 2, kb.y + kb.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(kb.x + kb.width / 2 + i * 4, kb.y + kb.height / 2);
  await page.mouse.up();
  await settle();
  const afterCounters = await page.evaluate('({ ...__kinect.timeline.counters })');
  const moved = afterCounters.laneRepositions - beforeCounters.laneRepositions;
  const fellBack = afterCounters.laneFallbacks - beforeCounters.laneFallbacks;
  check(moved >= 8, 'a ten-move key drag takes the cheap path on every move', `${moved} repositions`);
  check(fellBack === 0, 'and never falls back to a rebuild, which is what resized the drawing buffer',
    `${fellBack} fallbacks`);

  // A gesture lasts as long as a finger or a key is down, which is long enough for a load started
  // before it to land in the middle of it.
  const snap = () => page.evaluate(`(() => ({
    rate: __kinect.timeline.read().speed,
    depth: __kinect.keyframes.undo.depth(),
    lanes: JSON.stringify(__kinect.keyframes.lanes()),
    range: JSON.stringify(__kinect.editor.clipRange()),
    keyTimes: (__kinect.keyframes.project().clips
      .find((clip) => clip.id === __kinect.editor.clipSelection())?.tracks.pointSize ?? [])
      .map((k) => k.t.toFixed(3)).join(' '),
  }))()`);

  const heldGesture = async ({ interrupt }) => {
    await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
    await page.evaluate(`(() => {
      const body = __kinect.library.serialiseProjectBody();
      const clip = body.clips.find((entry) => entry.id === __kinect.editor.clipSelection());
      clip.tracks.pointSize = [{ t: 2, value: 4 }, { t: 6, value: 12 }];
      __kinect.library.restoreProject(body);
    })()`);
    await settle();
    await page.evaluate('__kinect.editor.setClipRange(0, null)');
    await page.evaluate('__kinect.keyframes.undo.commit()');
    await driveRate(2);
    const committed = await page.evaluate('__kinect.timeline.read().speed');
    await page.evaluate('__kinect.timeline.transport().seek(2)');
    await settle();
    await page.evaluate('__kinect.timeline.transport().play()');
    await new Promise((r) => setTimeout(r, 250));
    const wasPlaying = await page.evaluate('__kinect.timeline.transport().playing');
    await page.evaluate(`(() => {
      const el = document.getElementById('tRate');
      el.focus();
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      el.value = String(__kinect.editor.rateSlider.toValue(0.5));
      el.dispatchEvent(new Event('input'));
    })()`);
    await settle();
    const held = await page.evaluate('__kinect.timeline.read().speed');
    if (interrupt) {
      await page.evaluate('__kinect.keyframes.undo.pop()');
      await settle();
    }
    const afterInterrupt = await page.evaluate('__kinect.timeline.read().speed');
    const before = await snap();
    if (interrupt === 'then-more-input') {
      await page.evaluate(`(() => {
        const el = document.getElementById('tRate');
        el.value = String(__kinect.editor.rateSlider.toValue(0.8));
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await settle();
    }
    await page.evaluate(`document.getElementById('tRate')
      .dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }))`);
    await settle();
    for (let i = 0; i < 60 && !(await page.evaluate('__kinect.timeline.transport().playing')); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const out = {
      committed, wasPlaying, held, afterInterrupt, before,
      after: await snap(),
      playing: await page.evaluate('__kinect.timeline.transport().playing'),
    };
    await page.evaluate('__kinect.timeline.transport().pause()');
    await settle();
    return out;
  };

  const uninterrupted = await heldGesture({ interrupt: false });
  check(uninterrupted.wasPlaying && uninterrupted.held === 0.5 && uninterrupted.after.rate === 0.5,
    'a speed gesture held over a key press and released applies the rate it was left at',
    `committed ${uninterrupted.committed}x, held ${uninterrupted.held}x, released ${uninterrupted.after.rate}x`);
  check(uninterrupted.playing,
    '  and puts a take that was running back, which is what the interrupted arm below must not do',
    `playing ${uninterrupted.playing}`);

  const interrupted = await heldGesture({ interrupt: true });
  check(interrupted.afterInterrupt === 1,
    '  and an undo arriving mid-gesture puts the document back, which is the state under test',
    `began ${interrupted.committed}x, held ${interrupted.held}x, undo restored ${interrupted.afterInterrupt}x`);
  const wrote = Object.keys(interrupted.before)
    .filter((k) => interrupted.before[k] !== interrupted.after[k]);
  check(wrote.length === 0,
    '  so the release writes nothing over the document that took the transport',
    wrote.length
      ? wrote.map((k) => `${k} ${interrupted.before[k]} -> ${interrupted.after[k]}`).join(', ')
      : `rate ${interrupted.after.rate}x, undo depth ${interrupted.after.depth}, cuts and lanes unmoved`);
  check(interrupted.playing === false,
    '  and does not resume a take the thing that took the transport had paused',
    `playing ${interrupted.playing}`);

  const continued = await heldGesture({ interrupt: 'then-more-input' });
  check(continued.after.rate === 0.8,
    '  a slider event after the takeover still moves the speed, rather than going dead',
    `undo left ${continued.afterInterrupt}x, the event left ${continued.after.rate}x`);
  const wantTimes = continued.before.keyTimes.split(' ')
    .map((t) => (Number(t) * (continued.afterInterrupt / 0.8)).toFixed(3)).join(' ');
  check(continued.after.keyTimes === wantTimes,
    '  and rescales the keys the open document has, not the ones the old snapshot held',
    `${continued.before.keyTimes} -> ${continued.after.keyTimes}, wanted ${wantTimes}`);

  await focusStage();
  await page.evaluate('__kinect.timeline.transport().pause()');
  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await page.evaluate('__kinect.keyframes.setTracks({})');
  await page.evaluate(`(() => {
    const body = __kinect.library.serialiseProjectBody();
    const clip = body.clips.find((entry) => entry.id === __kinect.editor.clipSelection());
    delete clip.tracks.pointSize;
    __kinect.library.restoreProject(body);
  })()`);
  await page.evaluate('__kinect.keyframes.undo.begin()');
  await page.evaluate('__kinect.timeline.transport().seek(0)');
  await settle();

  console.log('\n[5] keys can be removed, and ease can be shaped');
  const plant = async (spec) => {
    await page.evaluate(`__kinect.keyframes.setTracks(${JSON.stringify(spec)})`);
    await settle();
  };
  const clickKey = async (owner, i) => {
    // Quoted, because a clip's lane owner carries a colon and a slash and an unquoted attribute
    // selector holding either is not a selector at all.
    const b = await page.locator(`.tlane[data-owner="${owner}"] .tkey`).nth(i).boundingBox();
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await new Promise((r) => setTimeout(r, 200));
    return b;
  };

  await plant({ bloom: [{ t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 }] });
  await clickKey('bloom', 1);
  check(Boolean(await page.evaluate('__kinect.editor.selection()')), 'clicking a key selects it');
  await page.keyboard.press('Delete');
  await settle();
  check(await keyCount('bloom') === 2, 'Delete removes the selected key', `${await keyCount('bloom')} keys left`);

  await plant({ bloom: [{ t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 }] });
  await clickKey('bloom', 1);
  await page.locator('#tDeleteKey').click();
  await settle();
  check(await keyCount('bloom') === 2, 'and so does the delete button, for anybody without a keyboard',
    `${await keyCount('bloom')} keys left`);

  // Two clicks inside the double-click window rather than `page.mouse.dblclick`: the first click
  // rebuilds the lane, so the second lands on a different element and the browser dispatches
  // `dblclick` at their common ancestor.
  await plant({ bloom: [{ t: 1, value: 0.2 }, { t: 5, value: 0.9 }, { t: 9, value: 0.3 }] });
  const dbl = await page.locator('.tlane[data-owner=bloom] .tkey').nth(1).boundingBox();
  await page.mouse.click(dbl.x + dbl.width / 2, dbl.y + dbl.height / 2);
  await page.mouse.click(dbl.x + dbl.width / 2, dbl.y + dbl.height / 2);
  await settle();
  check(await keyCount('bloom') === 2, 'and a double click on a key removes it', `${await keyCount('bloom')} keys left`);

  const EXPECTED = {
    linear: { out: [[1 / 3, 1 / 3]], in: [[2 / 3, 2 / 3]] },
    in: { in: [[0.58, 1]] },
    out: { out: [[0.42, 0]] },
    smooth: { out: [[0.42, 0]], in: [[0.58, 1]] },
    glide: { out: [[0.2, 0], [0.4, 0]], in: [[0.6, 1], [0.8, 1]] },
    ends: {
      firstOut: [[0.2, 0], [0.4, 0]],
      lastIn: [[0.6, 1], [0.8, 1]],
      keepsSelected: true,
    },
    hold: { out: [[1, 0]], nextIn: [[1, 0]] },
  };
  const presetNames = await page.evaluate('__kinect.editor.easePresets()');
  check(presetNames.length === Object.keys(EXPECTED).length,
    'the preset row offers exactly the presets this file knows', presetNames.join(', '));

  // One fixture per kind that claims to be easable, enumerated off the page's own table, so a
  // fourth kind added next year fails the row below until somebody gives it a fixture.
  const BENT = { easeOut: [[0.9, 0.1]], easeIn: [[0.1, 0.9]] };
  const KIND_FIXTURES = {
    scalar: {
      owner: 'bloom',
      keys: [
        { t: 1, value: 0.2, ...BENT },
        { t: 5, value: 0.9, ...BENT },
        { t: 9, value: 0.3, ...BENT },
      ],
      inside: 7,
      outside: 3,
      read: (v) => v,
    },
    pose: {
      owner: 'camera',
      keys: [[-1.1, 0.9, 50], [0.2, 1.15, 44], [1.3, 0.8, 58]].map(([x, z, fov], i) => ({
        t: 1 + i * 4,
        value: { position: [x, 0.35, z], quaternion: [0, 0, 0, 1], fov },
        ...BENT,
      })),
      inside: 7,
      outside: 3,
      read: (v) => v.position[0],
    },
    // A clip's placement. The lane owner and the track are two different strings here and only
    // here: a clip value's lane is qualified by the clip that holds it, and the id is read off
    // the page rather than written down, so this fixture does not go stale on a rename.
    placement: {
      owner: `clip:${await page.evaluate('__kinect.editor.clipSelection()')}/transform`,
      track: 'transform',
      keys: [[-0.4, 0.2], [0.1, -0.1], [0.5, 0.3]].map(([x, z], i) => ({
        t: 1 + i * 4,
        value: { position: [x, 0, z], quaternion: [0, 0, 0, 1] },
        ...BENT,
      })),
      inside: 7,
      outside: 3,
      read: (v) => v.position[0],
    },
  };
  const easedKinds = await page.evaluate('__kinect.editor.easedKinds()');
  const unfixtured = easedKinds.filter((k) => !KIND_FIXTURES[k]);
  check(unfixtured.length === 0,
    'every kind the page declares easable has a fixture here, so a kind added later is asked about by existing',
    unfixtured.length ? `nothing drives ${unfixtured.join(', ')}` : `${easedKinds.join(', ')} all driven`);
  // The reverse inclusion, which is what stops this section being circular: the row above
  // enumerates the page's own declaration, so flipping `eases` to false on `pose` would silently
  // delete every pose row below and leave the whole suite green.
  const undeclared = Object.keys(KIND_FIXTURES).filter((k) => !easedKinds.includes(k));
  check(undeclared.length === 0,
    'and every kind this file has a fixture for is still declared easable, so the page cannot shrink its own coverage',
    undeclared.length ? `the page no longer eases ${undeclared.join(', ')}` : `${Object.keys(KIND_FIXTURES).join(', ')} all declared`);

  for (const kind of easedKinds.filter((k) => KIND_FIXTURES[k])) {
    const fx = KIND_FIXTURES[kind];
    for (const name of presetNames) {
      await plant({ [fx.track ?? fx.owner]: fx.keys });
      await page.evaluate(`__kinect.editor.select('${fx.owner}', 1)`);
      await settle();
      // Asked before it is pressed: Playwright's `click` waits for a control to become
      // actionable, so pressing a disabled button hangs for the full 30s timeout and takes the
      // run down - reported as DID NOT RUN with zero failed assertions, which is a crash wearing
      // the shape of a catch.
      const live = await page.evaluate(
        `document.querySelector('#tEase button[data-ease=${name}]').disabled`,
      ) === false;
      if (live) {
        await page.locator(`#tEase button[data-ease=${name}]`).click();
        await settle();
      }
      const got = await page.evaluate(`__kinect.editor.easeOf('${fx.owner}', 1)`);
      const next = await page.evaluate(`__kinect.editor.easeOf('${fx.owner}', 2)`);
      const first = await page.evaluate(`__kinect.editor.easeOf('${fx.owner}', 0)`);
      const want = EXPECTED[name];
      const sameList = (a, b) => Array.isArray(a) && a.length === b.length
        && a.every((p, i) => near(p[0], b[i][0], 1e-9) && near(p[1], b[i][1], 1e-9));
      const okOut = !want.out || sameList(got.easeOut, want.out);
      const okIn = !want.in || sameList(got.easeIn, want.in);
      const okNext = !want.nextIn || sameList(next.easeIn, want.nextIn);
      const okFirst = !want.firstOut || sameList(first.easeOut, want.firstOut);
      const okLast = !want.lastIn || sameList(next.easeIn, want.lastIn);
      const okKept = !want.keepsSelected
        || (sameList(got.easeOut, BENT.easeOut) && sameList(got.easeIn, BENT.easeIn));
      check(live && okOut && okIn && okNext && okFirst && okLast && okKept,
        `the "${name}" preset writes the handles it names on a ${kind} key`,
        live
          ? `out ${JSON.stringify(got.easeOut)} in ${JSON.stringify(got.easeIn)}`
            + (want.nextIn ? ` next-in ${JSON.stringify(next.easeIn)}` : '')
            + (want.firstOut ? ` first-out ${JSON.stringify(first.easeOut)}` : '')
            + (want.lastIn ? ` last-in ${JSON.stringify(next.easeIn)}` : '')
          : `the preset row is dead for a ${kind} key, so nothing could be pressed`);
    }
  }

  await plant({ bloom: [{ t: 1, value: 0.2, ...BENT }, { t: 5, value: 0.9, ...BENT }] });
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  const AT = [1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5];
  const sampleBloom = () => page.evaluate(
    `${JSON.stringify(AT)}.map((t) => globalThis.__kinect.keyframes.valueAt('bloom', t))`,
  );
  const pointsOn = (i) => page.evaluate(
    `(() => { const e = __kinect.editor.easeOf('bloom', ${i}); return [e.easeOut.length, e.easeIn.length]; })()`,
  );
  const curveBeforeGrow = await sampleBloom();
  const countBeforeGrow = await pointsOn(0);
  await page.locator('#tAddPoint').click();
  await settle();
  const countAfterGrow = await pointsOn(0);
  const curveAfterGrow = await sampleBloom();
  const grewBy = countAfterGrow[0] - countBeforeGrow[0];
  check(grewBy === 1, 'the add-point control grows the selected key\'s outgoing side by one',
    `easeOut went from ${countBeforeGrow[0]} control points to ${countAfterGrow[0]}`);
  const elevationDrift = Math.max(...curveAfterGrow.map((v, i) => Math.abs(v - curveBeforeGrow[i])));
  check(elevationDrift < 1e-9,
    'and the curve it grew is the same curve, which is the whole reason the control can be offered',
    `worst departure over ${AT.length} samples inside the segment: ${elevationDrift.toExponential(3)}`);
  const grownHandles = await page.locator('.tlane[data-owner=bloom] .thandle').count();
  check(grownHandles === countAfterGrow[0] + countAfterGrow[1] - 1,
    'and the lane draws one handle per control point, so the new one can be reached',
    `${grownHandles} handles for ${countAfterGrow[0]} out and ${countAfterGrow[1]} in on the first key`);

  await page.locator('#tDropPoint').click();
  await settle();
  const countAfterDrop = await pointsOn(0);
  check(countAfterDrop[0] === countBeforeGrow[0],
    'and the drop-point control takes it back off again',
    `easeOut went from ${countAfterGrow[0]} control points to ${countAfterDrop[0]}`);
  for (let i = 0; i < 4; i++) {
    if (await page.evaluate(`document.getElementById('tDropPoint').disabled`)) break;
    await page.locator('#tDropPoint').click();
    await settle();
  }
  const floored = await pointsOn(0);
  check(floored[0] === 1 && await page.evaluate(`document.getElementById('tDropPoint').disabled`),
    'and it stops at one point a side rather than emptying the handle',
    `easeOut holds ${floored[0]}, and the control is ${await page.evaluate(`document.getElementById('tDropPoint').disabled`) ? 'dead' : 'still live'}`);

  await plant({ bloom: [{ t: 30, value: 0.2, ...BENT }, { t: 38, value: 0.9, ...BENT }] });
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  await page.locator('#tEase button[data-ease=ends]').click();
  await page.locator('#tAddPoint').click();
  await settle();
  const twoPoints = await page.evaluate(`__kinect.editor.easeOf('bloom', 0)`);
  // The handles are drawn `easeOut` first and in index order, so the lane's second `.thandle` is
  // `easeOut[1]` - the one whose x is fenced by its neighbours rather than by 0 and 1.
  const handles = page.locator('.tlane[data-owner=bloom] .thandle');
  const first = await handles.nth(0).boundingBox();
  const second = await handles.nth(1).boundingBox();
  const dragY = second.y + second.height / 2;
  await page.mouse.move(second.x + second.width / 2, dragY);
  await page.mouse.down();
  // Nothing is awaited between the press and the throw: the press captures the pointer on the
  // handle element, and `settle()` lets a lane rebuild replace it, so every later move goes to a
  // node no longer in the document and the handle sits where it started.
  await page.mouse.move(first.x - 24, dragY, { steps: 8 });
  await page.mouse.up();
  await settle();
  const afterPointDrag = await page.evaluate(`__kinect.editor.easeOf('bloom', 0)`);
  check(afterPointDrag.easeOut.length === twoPoints.easeOut.length
    && afterPointDrag.easeOut[0][0] === twoPoints.easeOut[0][0],
    'dragging the second control point leaves the first one where it was, so the drag found its own index',
    `first ${JSON.stringify(afterPointDrag.easeOut[0])}, second ${JSON.stringify(afterPointDrag.easeOut[1])}`);
  const landed = afterPointDrag.easeOut[1][0];
  const neighbour = afterPointDrag.easeOut[0][0];
  check(landed !== twoPoints.easeOut[1][0] && Math.abs(landed - neighbour) < 1e-9,
    'and it stops on the point before it rather than at the segment start, because the timing '
    + 'curve has to stay single-valued in time and a crossed pair folds it',
    `dragged from ${twoPoints.easeOut[1][0].toFixed(4)} to ${landed.toFixed(4)}, `
    + `against a neighbour at ${neighbour.toFixed(4)}`);

  await plant({ bloom: [{ t: 1, value: 0.2, ...BENT }, { t: 6, value: 0.9, ...BENT }] });
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  await page.locator('#tEase button[data-ease=ends]').click();
  await settle();
  const pairFirst = await page.evaluate(`__kinect.editor.easeOf('bloom', 0)`);
  const pairLast = await page.evaluate(`__kinect.editor.easeOf('bloom', 1)`);
  const glideOut = JSON.stringify([[0.2, 0], [0.4, 0]]);
  const glideIn = JSON.stringify([[0.6, 1], [0.8, 1]]);
  check(JSON.stringify(pairFirst.easeOut) === glideOut && JSON.stringify(pairLast.easeIn) === glideIn,
    'on a two-key move `ends` shapes both ends of the one segment there is',
    `first-out ${JSON.stringify(pairFirst.easeOut)}, last-in ${JSON.stringify(pairLast.easeIn)}`);

  await plant({ bloom: [{ t: 1, value: 0.5 }, { t: 5, value: 0.5 }, { t: 9, value: 0.9 }] });
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  const flatHandles = await page.locator('.tlane[data-owner=bloom] .thandle').count();
  check(flatHandles === 0, 'a key whose only segment is flat gets no ease handle at all',
    `${flatHandles} handles`);
  await page.evaluate(`__kinect.editor.select('bloom', 1)`);
  await settle();
  const mixedHandles = await page.locator('.tlane[data-owner=bloom] .thandle').count();
  check(mixedHandles === 1, 'and a key between a flat and a shaped segment gets exactly the shaped one',
    `${mixedHandles} handles`);
  check(await page.evaluate(`document.querySelector('#tEase button[data-ease=linear]').disabled`) === false,
    'the preset row is live for that key, because one of its sides can be shaped');
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  check(await page.evaluate(`document.querySelector('#tEase button[data-ease=linear]').disabled`) === true,
    'and goes dead for the key that has nothing to shape, rather than writing into nothing');

  for (const kind of easedKinds.filter((k) => KIND_FIXTURES[k])) {
    const fx = KIND_FIXTURES[kind];
    await plant({ [fx.track ?? fx.owner]: fx.keys.map(({ easeOut, easeIn, ...rest }) => rest) });
    await page.evaluate(`__kinect.editor.select('${fx.owner}', 1)`);
    await settle();
    // The first handle drawn on a key is its `easeOut`, which shapes the segment after it, so the
    // curve is sampled at 7s and not at 3s - a probe at 3s sits in the neighbouring segment where
    // the answer is the same either way.
    const drawn = await page.locator(`.tlane[data-owner="${fx.owner}"] .thandle`).count();
    const hb = drawn > 0
      ? await page.locator(`.tlane[data-owner="${fx.owner}"] .thandle`).first().boundingBox()
      : null;
    check(hb !== null && hb.width >= 10 && hb.height >= 10, `a ${kind} ease handle is big enough to hit`,
      hb ? `${hb.width}x${hb.height}px` : `no handle drawn on the ${kind} lane at all`);
    const at = (t) => page.evaluate(`__kinect.keyframes.valueAt('${fx.owner}', ${t})`).then(fx.read);
    const easeBefore = await page.evaluate(`__kinect.editor.easeOf('${fx.owner}', 1)`);
    const ownBefore = await at(fx.inside);
    const neighbourBefore = await at(fx.outside);
    if (hb) {
      await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
      await page.mouse.down();
      await page.mouse.move(hb.x + hb.width / 2 - 40, hb.y + hb.height / 2 - 20, { steps: 5 });
      await page.mouse.up();
      await settle();
    }
    const easeAfter = await page.evaluate(`__kinect.editor.easeOf('${fx.owner}', 1)`);
    const ownAfter = await at(fx.inside);
    const neighbourAfter = await at(fx.outside);
    check(JSON.stringify(easeBefore.easeOut) !== JSON.stringify(easeAfter.easeOut),
      `dragging a ${kind} handle rewrites it`,
      `easeOut ${JSON.stringify(easeBefore.easeOut)} -> ${JSON.stringify(easeAfter.easeOut)}`);
    check(Math.abs(ownAfter - ownBefore) > 1e-4,
      `  and the ${kind} value inside the segment it shapes follows, which is the only thing a handle is for`,
      `${ownBefore.toFixed(4)} -> ${ownAfter.toFixed(4)} at ${fx.inside}s`);
    check(Math.abs(neighbourAfter - neighbourBefore) < 1e-9,
      '  and the segment on the other side of the key does not move',
      `${neighbourBefore.toFixed(4)} -> ${neighbourAfter.toFixed(4)} at ${fx.outside}s`);
  }

  await plant({ camera: KIND_FIXTURES.pose.keys.map(({ easeOut, easeIn, ...rest }) => rest) });
  await page.evaluate(`__kinect.editor.select('camera', 1)`);
  await settle();
  // Counted before it is reached for: `.first().boundingBox()` on a lane with no handle waits the
  // full 30s and takes the run down, reporting DID NOT RUN where eight clean reds were owed.
  const poseHandles = await page.locator('.tlane[data-owner=camera] .thandle').count();
  const poseHandle = poseHandles > 0
    ? await page.locator('.tlane[data-owner=camera] .thandle').first().boundingBox()
    : null;
  if (poseHandle) {
    await page.mouse.move(poseHandle.x + poseHandle.width / 2, poseHandle.y + poseHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(poseHandle.x + poseHandle.width / 2, poseHandle.y - 400, { steps: 6 });
    await page.mouse.up();
    await settle();
  }
  const dragged = await page.evaluate(`__kinect.editor.easeOf('camera', 1)`);
  check(poseHandle !== null && dragged.easeOut[0][1] <= 1 + 1e-9 && dragged.easeOut[0][1] >= -1e-9,
    'a pose handle dragged far past the lane stays inside the unit box, so the camera cannot overshoot its own key',
    poseHandle === null
      ? `no handle on the pose lane to drag, so the clamp was never exercised (y still ${dragged.easeOut[0][1].toFixed(4)})`
      : `easeOut y ${dragged.easeOut[0][1].toFixed(4)} after a 400px drag`);

  const beads = await page.evaluate(`(() => {
    const P = (x, z) => ({ position: [x, 0.35, z], quaternion: [0, 0, 0, 1], fov: 50 });
    const LIN_O = [[1 / 3, 1 / 3]];
    const LIN_I = [[2 / 3, 2 / 3]];
    const mk = (out0, in2) => [
      { t: 2, value: P(-1.4, 1.5), easeOut: out0, easeIn: LIN_I },
      { t: 5, value: P(0.2, 1.0), easeOut: LIN_O, easeIn: LIN_I },
      { t: 8, value: P(1.6, 1.4), easeOut: LIN_O, easeIn: in2 },
    ];
    const gaps = () => {
      const pts = __kinect.editor.pathBeads();
      const out = [];
      for (let i = 1; i < pts.length; i++) {
        out.push(Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]));
      }
      return out;
    };
    __kinect.keyframes.setTracks({ camera: mk(LIN_O, LIN_I) });
    const flat = gaps();
    __kinect.keyframes.setTracks({ camera: mk([[0.42, 0]], [[0.58, 1]]) });
    const eased = gaps();
    const spread = (g) => Math.max(...g) / Math.max(1e-9, Math.min(...g));
    return { count: eased.length + 1, flatSpread: spread(flat), easedSpread: spread(eased) };
  })()`);
  check(beads.count === 30, 'the path overlay beads every fourth of its 120 samples',
    `${beads.count} beads`);
  check(beads.easedSpread > beads.flatSpread * 3,
    'and their spacing follows the easing, which is what makes the overlay a picture of the timing',
    `widest-to-narrowest gap ${beads.easedSpread.toFixed(1)}x when eased against ${beads.flatSpread.toFixed(1)}x unshaped`);

  const lane = await page.evaluate(`(() => {
    const P = (x, z) => ({ position: [x, 0.35, z], quaternion: [0, 0, 0, 1], fov: 50 });
    const LIN_O = [[1 / 3, 1 / 3]];
    const LIN_I = [[2 / 3, 2 / 3]];
    const mk = (out0, in2) => [
      { t: 2, value: P(-1.4, 1.5), easeOut: out0, easeIn: LIN_I },
      { t: 5, value: P(0.2, 1.0), easeOut: LIN_O, easeIn: LIN_I },
      { t: 8, value: P(1.6, 1.4), easeOut: LIN_O, easeIn: in2 },
    ];
    const ys = () => document.querySelector('.tlane[data-owner=camera] polyline')
      .getAttribute('points').split(' ').map((p) => Number(p.split(',')[1]));
    __kinect.keyframes.setTracks({ camera: mk(LIN_O, LIN_I) });
    const flat = ys();
    __kinect.keyframes.setTracks({ camera: mk([[0.42, 0]], [[0.58, 1]]) });
    const eased = ys();
    const span = (a) => Math.max(...a) - Math.min(...a);
    const worstShift = Math.max(...eased.map((y, i) => Math.abs(y - flat[i])));
    return { span: span(flat), worstShift };
  })()`);
  check(lane.span > 80,
    'the camera lane draws a curve that crosses it, rather than a line through the middle',
    `the drawn points span ${lane.span.toFixed(1)} of the lane's 100`);
  check(lane.worstShift > 5,
    '  and that curve is redrawn when the easing changes, which is the whole of what it is for',
    `worst ${lane.worstShift.toFixed(1)} of 100 between the unshaped and eased curves`);

  console.log('\n[6] the strip stays a fixed height and the render dialog stays reachable');
  const LONG_OPTION = 'client-cut-2026-08-02-final-v3-graded-for-delivery';
  await page.evaluate(`(${((label) => {
    globalThis.__planted = [];
    for (const sel of document.querySelectorAll('.tbar .tchips select')) {
      const opt = new Option(label, '__planted__');
      sel.appendChild(opt);
      globalThis.__planted.push(opt);
    }
    return globalThis.__planted.length;
  }).toString()})(${JSON.stringify(LONG_OPTION)})`);
  note('a long option planted in every select the scroller holds',
    `${await page.evaluate('globalThis.__planted.length')} selects`);
  await page.locator('#outputMenuButton').click();
  await page.locator('#menuExport').click();
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: VIEWPORT.height });
    await new Promise((r) => setTimeout(r, 250));
    const geom = await page.evaluate(`(() => {
      const btn = document.getElementById('tExport').getBoundingClientRect();
      const hit = document.elementFromPoint((btn.left + btn.right) / 2, (btn.top + btn.bottom) / 2);
      const strip = document.getElementById('timeline');
      // Read off the strip, not off the root element. --timeline-h is declared on
      // the root and --tlanes-h is written by rebuildLanes onto the strip itself, so
      // asking the root for the second answers 0 - which made this row compare a real
      // 183px strip against a declared 148 and fail against a correct build.
      const css = getComputedStyle(strip);
      const px = (name) => parseFloat(css.getPropertyValue(name));
      return {
        hit: hit ? (hit.id || hit.tagName) : 'nothing',
        right: btn.right,
        stripH: Math.round(strip.getBoundingClientRect().height),
        declared: Math.round(px('--timeline-h') + px('--tlanes-h')),
        wrapped: [...document.querySelectorAll('.tbar')].map((b) => b.scrollHeight > b.clientHeight + 1),
      };
    })()`);
    check(geom.hit === 'tExport', `the render button is what the pointer finds at ${width}px`,
      `hits "${geom.hit}", right edge at ${geom.right.toFixed(0)} of ${width}`);
    check(geom.stripH === geom.declared,
      `  and the strip is exactly the height the stage was sized against at ${width}px`,
      `${geom.stripH}px measured, ${geom.declared}px declared`);
    check(!geom.wrapped.some(Boolean),
      `  and neither bar row wrapped at ${width}px, which is what would push the lanes out of it`,
      geom.wrapped.map((w, i) => `row ${i + 1} ${w ? 'WRAPPED' : 'ok'}`).join(', '));
  }
  await page.evaluate('globalThis.__planted.forEach((o) => o.remove())');
  await page.setViewportSize(VIEWPORT);
  await new Promise((r) => setTimeout(r, 250));

  console.log('\n[7] the export is named, and a copy of it can be saved');
  // The field is written through the element rather than through `fill`: `--mutate
  // pin-min-width-auto` pushes the pinned chips off the right edge, and a click that had to
  // scroll to reach the field would redden a naming row for a layout reason.
  const setName = async (value) => page.evaluate(`(${((v) => {
    const el = document.getElementById('tExportName');
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }).toString()})(${JSON.stringify(value)})`);

  await setName('rooftop-wide-v3');
  await new Promise((r) => setTimeout(r, 150));
  check((await page.evaluate('__kinect.editor.exportName()')).base === 'rooftop-wide-v3',
    'a name typed into the field is the name the export will use',
    (await page.evaluate('__kinect.editor.exportName()')).base);
  check(await page.evaluate(`document.getElementById('tExport').disabled`) === false,
    '  and a legal name leaves the render button live');

  await setName('../etc/passwd');
  await new Promise((r) => setTimeout(r, 150));
  check(await page.evaluate(`document.getElementById('tExport').disabled`) === true,
    'a name shaped like a path refuses to render',
    'the regex is mirrored from server/export.js, which is the copy that is enforced');
  check(await page.evaluate(`document.getElementById('tExportNameChip').classList.contains('bad')`),
    '  and says so on the field rather than only when the server rejects it');

  await setName('');
  await new Promise((r) => setTimeout(r, 150));
  check((await page.evaluate('__kinect.editor.exportName()')).base === TAKE,
    'an empty field falls back to the take id, which is what it did before there was a field',
    (await page.evaluate('__kinect.editor.exportName()')).base);

  if (NO_RENDER) {
    note('the real export was skipped', '--no-render: the naming rows above are all that ran here');
  } else {
    const sizes = await page.evaluate('__kinect.exportSizes()');
    const smallest = sizes.slice().sort((a, b) => (a.w * a.h) - (b.w * b.h))[0];
    await page.evaluate(`__kinect.setOutputSize(${JSON.stringify(`${smallest.w}x${smallest.h}`)})`);
    await settle();
    // The trim is set with the dialog shut, because the modal blocks the keyboard shortcuts
    // that target the stage behind it.
    await page.locator('#exportClose').click();
    await page.waitForFunction('!document.getElementById("exportDialog").open');
    await page.evaluate('__kinect.timeline.transport().seek(0)');
    await settle();
    await focusStage();
    await page.keyboard.press('i');
    await page.evaluate('__kinect.timeline.transport().seek(0.2)');
    await settle();
    await page.keyboard.press('o');
    await settle();
    await page.locator('#outputMenuButton').click();
    await page.locator('#menuExport').click();
    await page.waitForFunction('document.getElementById("exportDialog").open');
    await setName('editor-check-copy');
    await new Promise((r) => setTimeout(r, 150));
    note(`rendering ${smallest.w}x${smallest.h}`, `range ${JSON.stringify(await range())}`);

    await page.locator('#tExport').click();
    await page.waitForFunction('!!globalThis.__kinect.editor.lastExport()', null, { timeout: 180000 });
    const last = await page.evaluate('__kinect.editor.lastExport()');
    check(last.file.startsWith('editor-check-copy'),
      'the file the render produced carries the name that was typed', last.file);

    const res = await fetch(`${URL_BASE}${last.href}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    const serverHash = createHash('sha256').update(bytes).digest('hex');
    check(res.ok && bytes.length > 0, 'and the server serves it back at the href it reported',
      `HTTP ${res.status}, ${bytes.length} bytes`);
    const onDisk = join(REPO, 'exports', last.href.replace('/exports/', ''));
    check(existsSync(onDisk) && statSync(onDisk).size === bytes.length,
      '  and it is on disk under exports/ at that size',
      existsSync(onDisk) ? `${statSync(onDisk).size} bytes` : 'not found');

    await page.locator('#tExportSave').click();
    await page.waitForFunction('globalThis.__saved.closed === true', null, { timeout: 120000 });
    const saved = await page.evaluate(`(async () => {
      const s = globalThis.__saved;
      const total = s.chunks.reduce((n, c) => n + c.byteLength, 0);
      const buf = new Uint8Array(total);
      let at = 0;
      for (const c of s.chunks) { buf.set(c, at); at += c.byteLength; }
      const digest = await crypto.subtle.digest('SHA-256', buf);
      return {
        called: s.called,
        suggestedName: s.suggestedName,
        hadActivation: s.hadActivation,
        length: buf.length,
        sha256: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join(''),
      };
    })()`);
    check(saved.called && saved.suggestedName === last.file,
      'the save sheet is opened, and offered the render\'s own filename', saved.suggestedName);
    check(saved.hadActivation === true,
      '  while the click\'s activation was still live, which is why the picker comes before the fetch',
      `navigator.userActivation.isActive was ${saved.hadActivation}`);
    check(saved.sha256 === serverHash && saved.length === bytes.length,
      '  and what went through it is byte-identical to the file on the server',
      `${saved.length} bytes, ${saved.sha256.slice(0, 16)}… against ${bytes.length} bytes, ${serverHash.slice(0, 16)}…`);
  }

  // Leave the modal through the same control a person uses before the rest of the proof reaches
  // back into the timeline - keeping it open makes the browser correctly refuse those pointer
  // events, which is a harness failure rather than a product one.
  if (await page.evaluate('document.getElementById("exportDialog").open')) {
    await page.locator('#exportClose').click();
  }

  const putDeliverable = (name, body) => page.evaluate(`(async () => {
    const res = await __ecWrite('/deliverables/' + encodeURIComponent(${JSON.stringify(name)}), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(${JSON.stringify(body)}),
    });
    return res.json();
  })()`);

  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [{ t: 2, value: 0.2 }, { t: 6, value: 0.9 }] })`);
  await settle();
  // The far trim is read off the take rather than written down: `setClipInOut` holds a trim
  // inside the program that is open, so a flat 20s..40s comes back clamped on the sample and the
  // row below would assert the clamp where it means to assert the menu.
  const takeDur = (await read()).duration;
  const farIn = takeDur * (2 / 3);
  const farOut = takeDur * 0.9;
  const pastIn = takeDur * 1.5;
  const pastOut = takeDur * 2;
  const baseDeliverable = await page.evaluate('({ ...__kinect.library.activeDeliverable() })');
  await putDeliverable('editor-check-near', { ...baseDeliverable, name: 'editor-check-near', in: 2, out: 8 });
  await putDeliverable('editor-check-far', { ...baseDeliverable, name: 'editor-check-far', in: farIn, out: farOut });
  await putDeliverable('editor-check-past', { ...baseDeliverable, name: 'editor-check-past', in: pastIn, out: pastOut });
  await putDeliverable('editor-check-bad', { ...baseDeliverable, name: 'editor-check-bad', in: 'start', out: farOut });
  await page.evaluate('__kinect.editor.refreshDeliverables?.()');
  const menuBefore = await page.evaluate(`(() => {
    const el = document.getElementById('tDeliverable');
    return { value: el.value, options: [...el.options].map((o) => o.value) };
  })()`);
  // And where the playhead was: `setClipInOut` seeks when the new trim excludes it, and section 8
  // renders its crop rows at the playhead, so a different frame there is a different depth slab.
  const playheadBefore = await page.evaluate('__kinect.timeline.transport().programSec');
  const pick = async (name) => {
    await page.evaluate(`(() => {
      const el = document.getElementById('tDeliverable');
      if (![...el.options].some((o) => o.value === ${JSON.stringify(name)})) {
        el.append(new Option(${JSON.stringify(name)}, ${JSON.stringify(name)}));
      }
      el.value = ${JSON.stringify(name)};
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await settle();
    await new Promise((r) => setTimeout(r, 250));
    return page.evaluate('__kinect.editor.clipRange()');
  };

  const far = await pick('editor-check-far');
  check(near(far.in ?? -1, farIn, 1e-6) && near(far.out ?? -1, farOut, 1e-6),
    'choosing a deliverable puts its trim on the clip',
    `${JSON.stringify(far)}, wanted in ${farIn.toFixed(4)} out ${farOut.toFixed(4)}`);
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    el.value = String(__kinect.editor.rateSlider.toValue(2));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await settle();
  const heldRate = await page.evaluate('__kinect.timeline.read().speed');
  const swapped = await pick('editor-check-near');
  check(near(swapped.in ?? -1, 2, 1e-3) && near(swapped.out ?? -1, 8, 1e-3),
    '  even while a speed gesture is held, and as the stored program times rather than rescaled',
    `${JSON.stringify(swapped)} at ${heldRate}x`);
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    el.value = String(__kinect.editor.rateSlider.toValue(1.25));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowRight', bubbles: true }));
  })()`);
  await settle();
  const afterSwap = await page.evaluate('__kinect.editor.clipRange()');
  check(near(afterSwap.in ?? -1, 2, 1e-3) && near(afterSwap.out ?? -1, 8, 1e-3),
    '  and the gesture that continues keeps that project trim at its authored times',
    `${JSON.stringify(afterSwap)}, wanted in 2.0000 out 8.0000`);

  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await settle();
  const pastDur = (await read()).duration;
  check(pastIn > pastDur,
    'the planted trim really does begin past the end of the program, or nothing below is about it',
    `in ${pastIn.toFixed(3)}s against a ${pastDur.toFixed(3)}s program`);
  await pick('editor-check-past');
  const adopted = await page.evaluate(`(() => {
    const t = __kinect.timeline.transport();
    return {
      in: t.clipInSec,
      out: t.clipOutSec,
      duration: t.duration,
    };
  })()`);
  check(adopted.in <= adopted.out,
    '  and adopting it leaves the transport a range that runs forwards, which is the pair frameAt reads',
    `clipInSec ${adopted.in.toFixed(3)}s, clipOutSec ${adopted.out.toFixed(3)}s, program ${adopted.duration.toFixed(3)}s`);
  const pastRange = await range();
  check((pastRange.in ?? -1) <= adopted.duration + 1e-6 && (pastRange.out ?? -1) <= adopted.duration + 1e-6,
    '  and the document it wrote names times the take has, both ends of it',
    `${JSON.stringify(pastRange)} against a ${adopted.duration.toFixed(3)}s program`);
  await page.evaluate('__kinect.editor.setClipRange(0, null)');
  await settle();
  const beforeBad = await page.evaluate(`(() => {
    const t = __kinect.timeline.transport();
    return { in: t.clipInSec, out: t.clipOutSec };
  })()`);
  await pick('editor-check-bad');
  const bad = await page.evaluate(`(() => {
    const t = __kinect.timeline.transport();
    return {
      in: t.clipInSec,
      out: t.clipOutSec,
      early: t.frameAt(t.duration * 0.25),
      late: t.frameAt(t.duration * 0.75),
      note: document.getElementById('tNote').textContent.trim(),
    };
  })()`);
  check(Number.isFinite(bad.in) && Number.isFinite(bad.out),
    '  and a deliverable whose in point is not a number leaves the transport a range that is still two times',
    `clipInSec ${bad.in}, clipOutSec ${bad.out}`);
  check(near(bad.out, beforeBad.out, 1e-6),
    '  and the out point it keeps is the one the clip already had, so the document was refused rather than repaired',
    `clipOutSec ${bad.out} against ${beforeBad.out} before the document was chosen`);
  check(Number.isFinite(bad.early) && Number.isFinite(bad.late) && bad.early !== bad.late,
    '  and frameAt still resolves two positions half a program apart to two different frames',
    `frameAt(0.25) ${bad.early}, frameAt(0.75) ${bad.late}`);
  check(/not a program time/.test(bad.note),
    '  and the refusal is said out loud rather than leaving the menu looking like it took',
    `#tNote reads ${JSON.stringify(bad.note)}`);
  // `showTimelineError` also writes the refusal to `console.error`, and the sweep at the end of
  // this file asserts the page said nothing at all, so this block drains its own noise.
  const picker = await page.evaluate(`(() => {
    const el = document.getElementById('tDeliverable');
    return { value: el.value, adopted: el.dataset.adopted ?? '' };
  })()`);
  check(picker.value !== 'editor-check-bad',
    '  and the picker is not left naming the deliverable that was refused',
    `#tDeliverable reads ${JSON.stringify(picker.value)}`);
  check(picker.value === picker.adopted,
    '  and it names the one the clip is actually on, rather than merely something else',
    `#tDeliverable ${JSON.stringify(picker.value)} against the adopted ${JSON.stringify(picker.adopted)}`);
  const drained = errors.filter((e) => /not a program time/.test(e));
  for (const e of drained) errors.splice(errors.indexOf(e), 1);
  check(drained.length === 1,
    '  and it reaches the console exactly once, which is what this block takes back out of the page-error sweep',
    `${drained.length} drained: ${drained.map((e) => e.slice(0, 60)).join(' | ') || 'nothing'}`);

  await focusStage();
  await page.evaluate(`(async () => {
    for (const n of ['editor-check-near', 'editor-check-far', 'editor-check-past', 'editor-check-bad']) {
      // The content type is required on every write route, delete included - the origin
      // rule refuses a request that does not declare one, which is a 200 carrying an
      // error rather than a network failure, so a cleanup without it fails silently.
      await __ecWrite('/deliverables/' + n, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      });
    }
  })()`);
  await page.evaluate(`(${((before) => {
    const el = document.getElementById('tDeliverable');
    for (const o of [...el.options]) if (!before.options.includes(o.value)) o.remove();
    el.value = before.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }).toString()})(${JSON.stringify(menuBefore)})`);
  await settle();
  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await page.evaluate('__kinect.keyframes.setTracks({})');
  // And the trim, which nothing below resets: leaving it at the near deliverable's range
  // moved section 8's crop numbers, and those rows read as a rendering change rather than
  // as a leftover from up here.
  await page.evaluate('__kinect.editor.setClipRange(0, null)');
  await page.evaluate(`__kinect.timeline.transport().seek(${playheadBefore})`);
  await settle();

  console.log('\n[8] the crop box crops what it says, where it says');
  await page.locator('#panelTabFraming').click();
  // The scene is put back to a plain one first: the sections above leave an animated `bloom`
  // track behind, and bloom lifts most of the frame over any sensible threshold - measured at
  // 903477 lit pixels against the 194911 the same shot gives with a default look.
  await page.evaluate('__kinect.editor.setClipRange(0, null)');
  await page.evaluate('__kinect.setOutputSize("1920x1080")');
  await page.evaluate('__kinect.keyframes.setTracks({})');
  await page.evaluate('(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))');
  await page.evaluate("__kinect.params.reset(__kinect.params.names('look'))");
  await page.evaluate('__kinect.sensorView()');
  await page.evaluate('__kinect.keyframes.chrome.set(false)');
  await page.evaluate('__kinect.timeline.transport().seek(12)');
  await settle();

  const CROP_OPEN = { left: -7, right: 7, bottom: -7, top: 7 };
  const setCrop = async (o) => {
    await page.evaluate(`__kinect.params.apply(${JSON.stringify(o)})`);
    await settle();
    await new Promise((r) => setTimeout(r, 120));
  };
  const lit = async () => {
    const box = await page.locator('#stage').boundingBox();
    await page.evaluate("document.getElementById('panel').style.visibility = 'hidden'");
    const shot = await page.screenshot({ clip: box });
    await page.evaluate("document.getElementById('panel').style.visibility = ''");
    return page.evaluate(`(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, img.width, img.height).data;
      const n = { all: 0, l: 0, r: 0, t: 0, b: 0 };
      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const i = (y * img.width + x) * 4;
          if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] < 18) continue;
          n.all++;
          if (x < img.width / 2) n.l++; else n.r++;
          // Image y grows downward and world +y is up, so the image's top half is
          // the world's positive y and belongs to the "top" face.
          if (y < img.height / 2) n.t++; else n.b++;
        }
      }
      return n;
    })(${JSON.stringify(`data:image/png;base64,${shot.toString('base64')}`)})`);
  };

  /** The rightmost lit column, as a fraction of the stage. */
  const litEdge = async () => {
    const box = await page.locator('#stage').boundingBox();
    await page.evaluate("document.getElementById('panel').style.visibility = 'hidden'");
    const shot = await page.screenshot({ clip: box });
    await page.evaluate("document.getElementById('panel').style.visibility = ''");
    return page.evaluate(`(async (dataUrl) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, img.width, img.height).data;
      // Scanned right to left and stopped at the first column carrying more than a
      // handful of lit pixels, because a single stray splat at the far right would
      // otherwise be the answer to every arm.
      for (let x = img.width - 1; x >= 0; x--) {
        let n = 0;
        for (let y = 0; y < img.height; y++) {
          const i = (y * img.width + x) * 4;
          if (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2] >= 18) n++;
        }
        if (n > 4) return x / img.width;
      }
      return 0;
    })(${JSON.stringify(`data:image/png;base64,${shot.toString('base64')}`)})`);
  };

  const reachAt = await page.evaluate('__kinect.cropReach(9.5)');
  check(reachAt.limit > reachAt.x && reachAt.limit > reachAt.y,
    'the planes open wider than the sensor can see at the furthest depth a slider allows',
    `sensor x +/-${reachAt.x.toFixed(2)}m y +/-${reachAt.y.toFixed(2)}m, planes +/-${reachAt.limit}m`);

  await setCrop(CROP_OPEN);
  const litDefault = await lit();
  await page.evaluate(`(() => { const u = __kinect.uniforms;
    u.cropL.value = -100; u.cropB.value = -100; u.cropR.value = 100; u.cropT.value = 100; })()`);
  await settle();
  await new Promise((r) => setTimeout(r, 150));
  const litWide = await lit();
  check(litDefault.all === litWide.all && litDefault.all > 1000,
    'and the defaults therefore cull nothing, which is what keeps an older clip loading uncropped',
    `${litDefault.all} lit with the defaults, ${litWide.all} with the planes at 100m`);

  for (const [name, val, own, opposite] of [['right', 0.3, 'r', 'l'], ['left', -0.3, 'l', 'r'],
    ['top', 0.3, 't', 'b'], ['bottom', -0.3, 'b', 't']]) {
    await setCrop(CROP_OPEN);
    const before = await lit();
    await setCrop({ [name]: val });
    const after = await lit();
    const lostOwn = 1 - after[own] / Math.max(1, before[own]);
    const lostOther = 1 - after[opposite] / Math.max(1, before[opposite]);
    check(lostOwn > 0.15 && lostOwn > lostOther * 2,
      `${name} culls from its own side of the frame and not the other`,
      `its half lost ${(lostOwn * 100).toFixed(1)}%, the opposite half ${(lostOther * 100).toFixed(1)}% `
      + `(lit ${before.all} -> ${after.all})`);
  }

  // A box, not a wedge, and the observable is where the cut lands rather than how much it took -
  // a wedge rigged to agree with the box at 2m passed every fraction-removed row.
  const SLAB = 0.6;
  const occupied = [];
  for (let near = 0.6; near + SLAB <= 6.0; near += SLAB) {
    await setCrop({ ...CROP_OPEN, near, far: near + SLAB });
    const count = (await lit()).all;
    if (count > 500) occupied.push({ near, far: near + SLAB, count });
  }
  note('depth bands carrying something at 0.6m thickness',
    occupied.map((b) => `${b.near.toFixed(1)}-${b.far.toFixed(1)}m:${b.count}`).join(' ') || 'none');
  const slabs = [occupied[0], occupied[occupied.length - 1]];
  check(occupied.length >= 2 && slabs[1].near - slabs[0].near >= 1.2,
    'the capture holds content at two depths far enough apart to tell a plane from an angle',
    occupied.length >= 2
      ? `${slabs[0].near.toFixed(1)}m and ${slabs[1].near.toFixed(1)}m, `
        + `${(slabs[1].near - slabs[0].near).toFixed(1)}m apart`
      : `${occupied.length} band(s) with content - nothing below can be measured`);
  // And where to put the plane, asked of the capture as well: on a room whose near content stops
  // short of it, the near arm reports its own content edge and the far arm reports a real cut, so
  // the comparison comes out backwards while both numbers are honest readings of different things.
  const openEdge = [];
  for (const { near, far } of slabs) {
    await setCrop({ ...CROP_OPEN, near, far });
    openEdge.push(await litEdge());
  }
  const BITE = 0.02;
  let plane = null;
  let edge = [];
  for (const r of [0.6, 0.45, 0.3, 0.15, -0.15, -0.3, -0.45, -0.6, -0.75, -0.9, -1.1, -1.3]) {
    const cuts = [];
    for (const [i, { near, far }] of slabs.entries()) {
      await setCrop({ ...CROP_OPEN, near, far });
      await setCrop({ right: r });
      cuts.push(await litEdge());
      if (openEdge[i] - cuts[i] < BITE) break;
    }
    if (cuts.length === slabs.length && cuts.every((c, i) => openEdge[i] - c >= BITE)) {
      plane = r;
      edge = cuts;
      break;
    }
  }
  check(plane !== null,
    'a right plane can be found that cuts into both slabs rather than standing outside one',
    plane === null
      ? `no plane between 0.3m and -0.3m moved both edges by ${BITE} of the stage from `
        + `${openEdge.map((e) => e.toFixed(3)).join(' and ')}`
      : `right at ${plane}m, from open edges ${openEdge.map((e) => e.toFixed(3)).join(' and ')}`);
  if (plane !== null) {
    for (const [i, { near, far }] of slabs.entries()) {
      note(`slab ${near.toFixed(1)}-${far.toFixed(1)}m with right at ${plane}m`,
        `the surviving right edge sits at ${edge[i].toFixed(3)} of the stage, `
        + `against ${openEdge[i].toFixed(3)} uncropped`);
    }
  }
  if (plane !== null) {
    // Which way the two cuts should be apart depends on the sign of the plane: a plane at R
    // metres is crossed at `cx + R*fx/z`, so its distance from the principal point shrinks with
    // depth in R's own direction.
    const apart = plane > 0 ? edge[0] - edge[1] : edge[1] - edge[0];
    check(apart > 0.015,
      'and the cut walks with depth in the direction the plane sits, which is what a plane in metres does and an angle does not',
      `${edge[0].toFixed(3)} against ${edge[1].toFixed(3)} at a plane of ${plane}m, `
      + `${apart.toFixed(3)} of the stage apart in the direction that plane predicts`);
  }
  await setCrop({ near: 0.05, far: 6 });

  await setCrop({ left: -0.4, right: 0.4, bottom: -0.4, top: 0.4 });
  const litClosed = await lit();
  await page.locator('#cropReset').click();
  await settle();
  await new Promise((r) => setTimeout(r, 150));
  const litReopened = await lit();
  const planes = await page.evaluate(`(() => {
    const u = __kinect.uniforms;
    return [u.cropL.value, u.cropR.value, u.cropB.value, u.cropT.value];
  })()`);
  const backWithin = Math.abs(litReopened.all - litDefault.all) / litDefault.all;
  check(planes.join() === [-7, 7, -7, 7].join() && backWithin < 0.001,
    '"open the box" puts all four planes back and the whole cloud with them',
    `planes ${planes.join(', ')}; lit ${litClosed.all} -> ${litReopened.all} against `
    + `${litDefault.all} open, ${(backWithin * 100).toFixed(3)}% apart`);

  console.log('\n[8b] a take opens with the box around its own cloud');
  {
    const fresh = await openEditor();
    const atOpen = await fresh.page.evaluate(`(() => {
      const k = globalThis.__kinect;
      return {
        planes: ['left', 'right', 'bottom', 'top'].map((n) => k.params.get(n)),
        bounds: ['left', 'right', 'bottom', 'top'].map((n) => k.params.spec(n).default),
        undo: k.undoDepth(),
      };
    })()`);

    const atBound = atOpen.planes.every((v, i) => v === atOpen.bounds[i]);
    check(!atBound,
      'the four lateral faces come in off their bounds, so the box is the take\'s and not the registry\'s',
      `${atOpen.planes.map((v) => v.toFixed(2)).join(', ')} against bounds `
      + `${atOpen.bounds.join(', ')}`);
    const inside = atOpen.planes.every((v, i) => Math.abs(v) < Math.abs(atOpen.bounds[i]));
    const wide = (atOpen.planes[1] - atOpen.planes[0]) > 0.5 && (atOpen.planes[3] - atOpen.planes[2]) > 0.5;
    check(inside && wide,
      'and they land inside the bounds without collapsing, so it is a room rather than a point',
      `${(atOpen.planes[1] - atOpen.planes[0]).toFixed(2)}m across, `
      + `${(atOpen.planes[3] - atOpen.planes[2]).toFixed(2)}m up`);

    check(atOpen.undo === 0,
      'and the fit is not on the undo stack, so the first undo is not a box nobody dragged',
      `undo depth ${atOpen.undo} on a freshly opened take`);
    // ....  what this section deliberately does not test, because there is nothing there
    // The fit was written behind a gate asking whether the document had authored its four faces,
    // and the condition was false on every path that could reach it - `--mutate
    // fit-overwrites-an-authored-box` removed the gate and came back NOT CAUGHT with
    // every row green.
    const PLANTED = '__editor-check-crop__';
    const planted = await fresh.page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const doc = k.keyframes.project();
      for (const n of ['left', 'right', 'bottom', 'top']) {
        // The crop faces write the cloud, so they are the clip's block and not the project's.
        doc.clips[0].params[n] = n === 'left' || n === 'bottom' ? -6.5 : 6.5;
      }
      return doc;
    })()`);
    await writeProjectDoc(PLANTED, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(planted),
    });
    const both = await openEditor();
    await both.page.goto(`${URL_BASE}${EDITOR_PATH}?take=${encodeURIComponent(TAKE)}`
      + `&project=${encodeURIComponent(PLANTED)}`, { waitUntil: 'load' });
    await both.page.waitForFunction('globalThis.__kinect?.takeOpened?.()', null, { timeout: 60000 });
    // The restore is a second promise after the open, so the planes it writes can land a beat
    // later than `takeOpened`.
    await both.page.waitForFunction(
      `globalThis.__kinect.params.get('left') !== ${atOpen.planes[0]}`, null, { timeout: 15000 },
    ).catch(() => {});
    const readPlanes = () => both.page.evaluate(
      `['left','right','bottom','top'].map((n) => globalThis.__kinect.params.get(n))`);
    const withProject = await readPlanes();
    // Read again after a beat, because a fit is a fetch: one landing after the first read would
    // leave this row green while doing exactly what it is the control for.
    await both.page.waitForTimeout(2000);
    const settledPlanes = await readPlanes();
    check(withProject.join() === [-6.5, 6.5, -6.5, 6.5].join()
      && settledPlanes.join() === withProject.join(),
      'a project named beside the take keeps its own box, because the fit belongs to opening a bare take and a named project is not one',
      `${withProject.join(', ')} then ${settledPlanes.join(', ')} against the project's `
      + `-6.5, 6.5, -6.5, 6.5 and the fit's ${atOpen.planes.map((v) => v.toFixed(2)).join(', ')}`);
    await both.close();
    await writeProjectDoc(PLANTED, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } }).catch(() => {});

    await fresh.page.locator('#panelTabFraming').click();
    await fresh.page.locator('#cropReset').click();
    const undoBefore = await fresh.page.evaluate('globalThis.__kinect.undoDepth()');
    const openedOut = await fresh.page.evaluate(
      `['left','right','bottom','top'].map((n) => globalThis.__kinect.params.get(n)).join()`);
    check(openedOut === atOpen.bounds.join() && undoBefore > 0,
      'and opening the box back out is itself an edit, so the press below has a baseline to differ from',
      `planes ${openedOut}, undo depth ${undoBefore}`);
    await fresh.page.locator('#cropFit').click();
    await fresh.page.waitForFunction(
      `['left','right','bottom','top'].map((n) => globalThis.__kinect.params.get(n)).join() !== `
      + `${JSON.stringify(atOpen.bounds.join())}`,
      null, { timeout: 30000 },
    ).catch(() => {});
    const refitted = await fresh.page.evaluate(`(() => {
      const k = globalThis.__kinect;
      return { planes: ['left', 'right', 'bottom', 'top'].map((n) => k.params.get(n)), undo: k.undoDepth() };
    })()`);
    check(refitted.planes.join() === atOpen.planes.join(),
      'pressing "fit box to take" puts the same box back over a document that had been opened out',
      `${refitted.planes.map((v) => v.toFixed(2)).join(', ')} against the fit at open `
      + `${atOpen.planes.map((v) => v.toFixed(2)).join(', ')}`);
    check(refitted.undo > undoBefore,
      'and that press is on the undo stack, because a press is an edit where an open is not',
      `undo depth ${undoBefore} before the press, ${refitted.undo} after`);
    await fresh.close();
  }

  console.log('\n[9] a parked orbit keeps its temporal look and redraws once per frame');

  {
    await page.locator('#panelTabCamera').click();
    await page.evaluate('__kinect.timeline.transport().pause()');
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    // The page counts its own animation frames: a saturated main thread starves rAF, which is the
    // symptom, so a driver-side stopwatch would report the wall time either build takes.
    await page.evaluate(`(() => {
      globalThis.__orbitFrames = 0;
      const tick = () => { globalThis.__orbitFrames++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    })()`);

    const stage = await page.evaluate(`(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    const poseOf = () => page.evaluate('(() => { const p = __kinect.freeCamera.position;'
      + ' return [p.x, p.y, p.z]; })()');

    {
      const dampingShipped = await page.evaluate('__kinect.controls.dampingFactor');
      const poseAtStart = await poseOf();
      const viewSaved = await page.evaluate(`(() => {
        const c = __kinect.freeCamera;
        const t = __kinect.controls.target;
        return { p: c.position.toArray(), q: c.quaternion.toArray(), t: [t.x, t.y, t.z] };
      })()`);
      // Slow enough that the drain is still owed when the button is pressed, and no slower:
      // `OrbitControls` stops dispatching `change` once a step falls under a millimetre, and a
      // window with no events in it is not a window.
      await page.evaluate('__kinect.controls.dampingFactor = 0.02');
      await page.mouse.move(stage.x - 60, stage.y - 30);
      await page.mouse.down();
      await page.mouse.move(stage.x + 40, stage.y + 20);
      await page.mouse.move(stage.x + 95, stage.y + 48);
      await page.mouse.up();
      // Read before the click, not after: on a build with the fix in, the click finishes the
      // drift, so a pose sampled afterwards has nothing left owed and the control below would
      // report the window shut when it was open.
      const posePressed = await poseOf();
      await page.locator('#camKey').click();
      const keyedAt = (await read()).programSec;
      const keyed = await page.evaluate(
        `__kinect.keyframes.valueAt('camera', ${keyedAt}).position`);
      // Closed the instant the click is in. Left open it outlasts `settled()`'s two hundred turns
      // and every row below fails as a timeout.
      await page.evaluate(`__kinect.controls.dampingFactor = ${dampingShipped}`);
      await settle();
      const poseRested = await poseOf();

      const dragged = Math.hypot(...posePressed.map((v, i) => v - poseAtStart[i]));
      const owed = Math.hypot(...poseRested.map((v, i) => v - posePressed[i]));
      const keyError = Math.hypot(...poseRested.map((v, i) => v - keyed[i]));
      note('the camera key pressed while the release still owed the camera movement',
        `dragged ${dragged.toFixed(3)} m, still owed ${owed.toFixed(3)} m at the press, `
        + `key ${keyError.toFixed(4)} m from where it came to rest`);
      check(dragged > 0.05, 'the drag before the camera key moved the camera',
        `${dragged.toFixed(3)} m`);
      check(owed > 0.02, 'and the release still owed it movement when the key went in',
        `${owed.toFixed(3)} m still to travel`);
      check(keyError < 0.01,
        'so the camera key records the shot that was framed rather than one the glide leaves behind',
        `${keyError.toFixed(4)} m between the keyed pose and the resting pose`);
      await page.evaluate("__kinect.keyframes.setTracks({})");
      await page.evaluate(`(() => {
        const v = ${JSON.stringify(viewSaved)};
        const c = __kinect.freeCamera;
        c.position.fromArray(v.p);
        c.quaternion.fromArray(v.q);
        __kinect.controls.target.set(v.t[0], v.t[1], v.t[2]);
        __kinect.controls.update(0);
        c.updateMatrixWorld(true);
      })()`);
      await settle();
    }

    const poseBefore = await poseOf();
    const before = await page.evaluate(
      '({ redraws: __kinect.timeline.counters.navigationRedraws, frames: globalThis.__orbitFrames })');
    const releaseTarget = await read();
    const RELEASE_AT = releaseTarget.programSec;
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.down();
    const MOVES = 24;
    for (let i = 0; i < MOVES; i++) {
      await page.mouse.move(stage.x + Math.sin(i / 5) * 110, stage.y + Math.cos(i / 7) * 55);
      await page.evaluate('new Promise(requestAnimationFrame)');
    }
    await page.mouse.up();
    await settle();
    const after = await page.evaluate(
      '({ redraws: __kinect.timeline.counters.navigationRedraws, frames: globalThis.__orbitFrames })');
    const poseAfter = await poseOf();

    const redraws = after.redraws - before.redraws;
    const frames = after.frames - before.frames;
    const travelled = Math.hypot(...poseAfter.map((v, i) => v - poseBefore[i]));
    note(`${MOVES} pointer moves across the stage`,
      `${redraws} navigation redraws over ${frames} animation frames, camera moved ${travelled.toFixed(3)} m`);

    check(redraws > 0 && travelled > 0.05, 'the drag renders, and it moves the camera',
      `${redraws} navigation redraws, ${travelled.toFixed(3)} m`);
    check(redraws <= frames + 1, 'and never more than one redraw per frame the display was given',
      `${redraws} navigation redraws against ${frames} frames`);
    // The largest part of the renderer that nothing is drawn over, established by what is
    // actually on top rather than by the stage's bounds: the panel is fixed over the stage and
    // its cost readout changes between a draft and an accurate seek, so a stage screenshot can
    // distinguish the UI while the renderer agrees.
    const picture = await page.evaluate(`(() => {
      const canvas = __kinect.renderer.domElement;
      const r = canvas.getBoundingClientRect();
      const clean = (rect) => {
        let covered = 0;
        const over = new Set();
        for (let i = 0; i <= 4; i++) {
          for (let j = 0; j <= 4; j++) {
            const at = document.elementFromPoint(
              rect.x + (rect.width * i) / 4, rect.y + (rect.height * j) / 4,
            );
            if (at !== canvas) {
              covered++;
              over.add(at ? (at.id ? '#' + at.id : at.tagName.toLowerCase()) : 'nothing');
            }
          }
        }
        return { covered, over: [...over].join(' ') };
      };
      let rect = {
        x: Math.ceil(r.x) + 1, y: Math.ceil(r.y) + 1,
        width: Math.floor(r.width) - 2, height: Math.floor(r.height) - 2,
      };
      let hits = clean(rect);
      for (let step = 0;
        step < 40 && hits.covered > 0 && rect.width > 64 && rect.height > 64;
        step++) {
        const dx = Math.max(2, Math.round(rect.width * 0.05));
        const dy = Math.max(2, Math.round(rect.height * 0.05));
        rect = {
          x: rect.x + dx, y: rect.y + dy,
          width: rect.width - 2 * dx, height: rect.height - 2 * dy,
        };
        hits = clean(rect);
      }
      return {
        ...rect, covered: hits.covered, over: hits.over,
        chromeHidden: document.getElementById('chrome')?.hidden === true,
      };
    })()`);
    check(picture.chromeHidden,
      'the chrome overlay is off, so temporal signatures contain the renderer rather than annotations',
      '#chrome hidden');
    check(picture.covered === 0 && picture.width > 200 && picture.height > 200,
      'and nothing is drawn over the temporal signature region, hit-tested rather than assumed',
      `${picture.width}x${picture.height} at ${picture.x},${picture.y}, `
      + `${picture.covered} of 25 probes covered${picture.over ? ` by ${picture.over}` : ''}`);

    // Forty tile means across that renderer-only region rather than one lit count over it: a
    // scalar over the whole frame can come out equal for two genuinely different pictures,
    // because a cloud that has moved a second along mostly redistributes its brightness.
    const signature = async () => {
      const shot = await page.screenshot({
        clip: { x: picture.x, y: picture.y, width: picture.width, height: picture.height },
      });
      return page.evaluate(`(async (dataUrl) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const g = c.getContext('2d');
        g.drawImage(img, 0, 0);
        const px = g.getImageData(0, 0, img.width, img.height).data;
        const COLS = 8;
        const ROWS = 5;
        const sums = new Array(COLS * ROWS).fill(0);
        const counts = new Array(COLS * ROWS).fill(0);
        for (let y = 0; y < img.height; y++) {
          for (let x = 0; x < img.width; x++) {
            const i = (y * img.width + x) * 4;
            const tile = Math.min(ROWS - 1, Math.floor(y / (img.height / ROWS))) * COLS
              + Math.min(COLS - 1, Math.floor(x / (img.width / COLS)));
            sums[tile] += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
            counts[tile]++;
          }
        }
        return sums.map((s, k) => s / counts[k]);
      })(${JSON.stringify(`data:image/png;base64,${shot.toString('base64')}`)})`);
    };
    /** The worst of the forty tiles, in 0-255 luma. */
    const apart = (a, b) => Math.max(...a.map((v, k) => Math.abs(v - b[k])));

    const panelControlBefore = await signature();
    await page.evaluate("document.getElementById('panel').style.background = '#fff'");
    await page.evaluate('new Promise(requestAnimationFrame)');
    const panelControlAfter = await signature();
    await page.evaluate("document.getElementById('panel').style.background = ''");
    await page.evaluate('new Promise(requestAnimationFrame)');
    const panelApart = apart(panelControlBefore, panelControlAfter);
    check(panelApart < 0.01,
      'control: changing only the panel changes no temporal signature pixels',
      `worst tile ${panelApart.toFixed(2)}/255`);

    const releasedSig = await signature();
    const released = await read();
    check(released.drafted === false, 'and the release leaves no draft standing on the stage',
      `drafted ${released.drafted}, playhead ${released.programSec.toFixed(3)}s`);

    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const intendedSig = await signature();
    await page.evaluate('__kinect.timeline.transport().seek(20.0)');
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const sameMomentTwice = apart(intendedSig, await signature());
    const temporalBefore = await page.evaluate("__kinect.params.values(['fade', 'wake', 'trails'])");
    await page.evaluate('__kinect.params.apply({ fade: 400, wake: 900, trails: 0.5 })');
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const accurateUnderTemporal = await signature();
    await page.evaluate('__kinect.timeline.transport().draft(4.0)');
    await settle();
    const draftSig = await signature();
    await page.evaluate(`__kinect.params.apply(${JSON.stringify(temporalBefore)})`);
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();

    const draftCosts = apart(draftSig, accurateUnderTemporal);
    const landed = apart(releasedSig, intendedSig);
    note('the released picture against an accurate seek to the same moment',
      `worst tile ${landed.toFixed(4)}/255, where the same moment read twice differs by `
      + `${sameMomentTwice.toFixed(4)} and a scrub draft of it by ${draftCosts.toFixed(2)}`);
    check(near(released.programSec, RELEASE_AT, 1e-6) && released.frame === releaseTarget.frame,
      'and it parked on the moment the hand let go of, read off the transport rather than guessed from pixels',
      `playhead ${released.programSec.toFixed(6)}s against ${RELEASE_AT.toFixed(6)}s before the drag, `
      + `frame ${released.frame} against ${releaseTarget.frame}`);
    check(draftCosts > 1,
      'the renderer signature can tell a scrub draft of this moment from the accurate picture of it',
      `worst tile ${draftCosts.toFixed(2)}/255, against ${sameMomentTwice.toFixed(4)} for the same picture twice`);
    check(sameMomentTwice < 0.01,
      'the same moment renders the same picture twice, which is what makes the row below an equality',
      `worst tile ${sameMomentTwice.toFixed(4)}/255 over a seek away to 20.0s and back`);
    check(landed < 0.01,
      'and the release lands the picture an accurate seek to that moment gives, not merely an accurate seek',
      `worst tile ${landed.toFixed(4)}/255 against a ${sameMomentTwice.toFixed(4)} floor and the `
      + `${draftCosts.toFixed(2)} a draft would cost`);

    const historyProbe = await page.evaluate(`(() => {
      const k = __kinect;
      const c = k.freeCamera;
      const t = k.controls.target;
      return {
        look: k.params.values(['fade', 'wake', 'trails', 'bloom']),
        view: { p: c.position.toArray(), q: c.quaternion.toArray(), t: [t.x, t.y, t.z] },
        clears: k.timeline.counters.navigationHistoryClears,
      };
    })()`);
    await page.evaluate(`__kinect.params.apply({ fade: 0, wake: 0, trails: 0.75, bloom: 0 })`);
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const cameraBeforeHistoryMove = await poseOf();
    await page.evaluate(`(() => {
      const k = __kinect;
      const c = k.freeCamera;
      const t = k.controls.target;
      const offset = c.position.clone().sub(t).applyAxisAngle(c.up, 0.24);
      c.position.copy(t).add(offset);
      c.lookAt(t);
      k.controls.update(0);
      k.drive.stepTo(4.0);
    })()`);
    const movedWithTrails = await signature();
    const cameraAfterHistoryMove = await poseOf();
    const historyClears = await page.evaluate(
      `__kinect.timeline.counters.navigationHistoryClears - ${historyProbe.clears}`);
    await page.evaluate(`(() => {
      __kinect.drive.clearAfterimage();
      __kinect.drive.stepTo(4.0);
    })()`);
    const movedWithoutHistory = await signature();
    const historyTravel = Math.hypot(...cameraAfterHistoryMove.map(
      (v, i) => v - cameraBeforeHistoryMove[i]));
    const historyApart = apart(movedWithTrails, movedWithoutHistory);
    note('the first frame at a new camera pose against the same frame with no old screen history',
      `worst tile ${historyApart.toFixed(2)}/255 after ${historyTravel.toFixed(3)} m and ${historyClears} history clears`);
    check(historyTravel > 0.05 && historyClears > 0,
      'the camera-history probe moves the camera and exercises the clear',
      `${historyTravel.toFixed(3)} m, ${historyClears} clears`);
    check(historyApart < 0.5,
      'and camera motion carries no pixels from the previous view into the new one',
      `worst tile ${historyApart.toFixed(2)}/255`);
    await page.evaluate(`(() => {
      const k = __kinect;
      const v = ${JSON.stringify(historyProbe.view)};
      const c = k.freeCamera;
      c.position.fromArray(v.p);
      c.quaternion.fromArray(v.q);
      k.controls.target.set(v.t[0], v.t[1], v.t[2]);
      k.controls.update(0);
      k.params.apply(${JSON.stringify(historyProbe.look)});
    })()`);
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();

    const orbitLook = await page.evaluate(`(() => ({
      look: __kinect.params.values(['fade', 'wake', 'trails']),
      damping: __kinect.controls.enableDamping,
    }))()`);
    await page.evaluate('__kinect.params.apply({ fade: 400, wake: 900, trails: 0.5 })');
    await settle();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    await page.evaluate('__kinect.controls.enableDamping = false');
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.down();
    await page.mouse.move(stage.x + 95, stage.y + 45);
    await page.evaluate('new Promise(requestAnimationFrame)');
    await settle();
    const heldSig = await signature();
    const heldState = await read();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const heldAccurateSig = await signature();
    await page.evaluate('__kinect.timeline.transport().draft(4.0)');
    await settle();
    const scrubDraftSig = await signature();
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const heldApart = apart(heldSig, heldAccurateSig);
    const draftApart = apart(scrubDraftSig, heldAccurateSig);
    note('the picture while the orbit is held against an accurate seek at its pose',
      `worst tile ${heldApart.toFixed(2)}/255; a scrub draft differs by ${draftApart.toFixed(2)}`);
    check(draftApart > 1,
      'the temporal look can distinguish the scrub draft from the accurate image',
      `worst tile ${draftApart.toFixed(2)}/255`);
    check(heldState.drafted === false && heldApart < draftApart / 4,
      'and the held orbit keeps the accurate temporal look instead of substituting the scrub draft',
      `drafted ${heldState.drafted}; ${heldApart.toFixed(2)}/255 against ${draftApart.toFixed(2)}`);
    await page.mouse.up();
    await page.evaluate(`(() => {
      __kinect.controls.enableDamping = ${orbitLook.damping};
      __kinect.params.apply(${JSON.stringify(orbitLook.look)});
    })()`);
    await settle();

    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.down();
    await page.mouse.move(stage.x + 60, stage.y + 30);
    await page.mouse.up();
    await page.evaluate('__kinect.timeline.transport().play()');
    let settledAfterPlay = true;
    let why = '';
    try {
      await settle();
    } catch (err) {
      settledAfterPlay = false;
      why = err.message.split('\n')[0];
    }
    check(settledAfterPlay, 'and a drag interrupted by playback leaves nothing armed behind it', why);
    await page.evaluate('__kinect.timeline.transport().pause()');
    await settle();

    // The release settles for about a third of a second after the pointer comes up, and a hand
    // does not wait for it.
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    // The window is widened rather than raced: what this row has to arrive inside is the damping
    // still owing the camera movement, which at the shipped `dampingFactor` of 0.07 is about a
    // third of a second - a driver round trip is a real fraction of it, and the first version
    // caught the mutation once in three runs. 0.02 rather than something far smaller:
    // `OrbitControls` only dispatches `change` when the camera moved more than a millimetre since
    // the last update, so pushing the factor low enough makes each step land under that and the
    // window opens empty of the thing it was opened to catch.
    const shippedDamping = await page.evaluate('__kinect.controls.dampingFactor');
    await page.evaluate('__kinect.controls.dampingFactor = 0.02');
    // Focused ahead of the drag, so no round-trip sits between the release and the key.
    await focusStage();
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.down();
    await page.mouse.move(stage.x + 70, stage.y + 35);
    // The pointer stays down, and that is what makes this row deterministic rather than merely
    // likely: the handler admits both halves of the window through one guard, and driven through
    // the release `orbitSettling` is cleared by the loop's settle branch the moment a frame
    // finds nothing armed.
    const landings = [];
    let midSettle = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        await page.evaluate('__kinect.timeline.transport().seek(4.0)');
        await settle();
        await page.evaluate('__kinect.controls.dampingFactor = 0.02');
        await page.mouse.move(stage.x, stage.y);
        await page.mouse.down();
        await page.mouse.move(stage.x + 70 - attempt * 8, stage.y + 35 + attempt * 6);
      }
      midSettle = await read();
      await page.keyboard.press('Home');
      await page.evaluate(`__kinect.controls.dampingFactor = ${shippedDamping}`);
      await page.mouse.up();
      await settle();
      landings.push((await read()).programSec);
    }
    const clipIn = await page.evaluate('__kinect.timeline.transport().clipInSec');
    const worst = Math.max(...landings.map((s) => Math.abs(s - clipIn)));
    note('Home pressed five times with the orbit still live',
      `landed ${landings.map((s) => s.toFixed(3)).join(', ')}s against ${clipIn.toFixed(3)}s asked for`);
    check(midSettle.programSec === 4, 'the orbit had not moved the playhead before the key went in',
      `playhead ${midSettle.programSec.toFixed(3)}s`);
    check(worst < 0.05,
      'and a seek raised while the orbit is still live keeps the position it asked for, every time',
      `worst landing ${worst.toFixed(3)}s from ${clipIn.toFixed(3)}s`);

  }

  console.log('\n[10] the ruler shows a window, and the window can be driven');
  // Every arm here is zoomed and panned, and that is the design of the section: with the window
  // at the whole clip, `(t - start)/span` and the old `t/duration` are the same expression, so an
  // arm at fit-zoom passes identically on a build that has no window at all.
  const clipSec = await page.evaluate('__kinect.timeline.transport().duration');
  const at = (f) => +(clipSec * f).toFixed(3);
  await page.evaluate(`__kinect.keyframes.setTracks({ bloom: [ { t: ${at(0.04)}, value: 0.2 }, `
    + `{ t: ${at(0.12)}, value: 0.9 }, { t: ${at(0.55)}, value: 0.4 } ] })`);
  await page.evaluate("__kinect.editor.setMarks(["
    + `{ id: 'm1', sourceMs: ${Math.round(clipSec * 0.06 * 1000)} }, `
    + `{ id: 'm2', sourceMs: ${Math.round(clipSec * 0.50 * 1000)} }])`);
  await page.evaluate('__kinect.editor.view.set(0.30, 0.42)');
  await settle();
  const win = await page.evaluate('__kinect.editor.view.window()');
  check(!win.whole && win.spanSec < win.duration / 4,
    'the strip can be zoomed into a window that is a fraction of the clip',
    `${win.startSec.toFixed(2)}s..${win.endSec.toFixed(2)}s of ${win.duration.toFixed(2)}s`);

  // Both directions are read off the page rather than one being recomputed here, because a check
  // that reimplemented `pct` to test `secAtPct` would be comparing this file's
  // arithmetic against itself.
  const roundTrip = await page.evaluate(`(() => {
    const out = [];
    for (const p of [0, 12.5, 50, 87.5, 100]) {
      const t = __kinect.editor.view.secAtPct(p);
      out.push({ p, t, back: __kinect.editor.view.pct(t) });
    }
    return out;
  })()`);
  check(roundTrip.every((r) => near(r.back, r.p, 1e-6)),
    '  and a percentage across it survives a round trip through program seconds',
    roundTrip.map((r) => `${r.p}%->${r.t.toFixed(3)}s->${r.back.toFixed(3)}%`).join(' '));
  check(near(roundTrip[0].t, win.startSec, 1e-6) && near(roundTrip[4].t, win.endSec, 1e-6),
    '  and 0% and 100% are the edges of the window rather than the edges of the clip',
    `0% is ${roundTrip[0].t.toFixed(3)}s, 100% is ${roundTrip[4].t.toFixed(3)}s, clip is 0..${win.duration.toFixed(2)}s`);

  const bedBox = await page.locator('#tBed').boundingBox();
  const wantedAt25 = await page.evaluate('__kinect.editor.view.secAtPct(25)');
  await page.mouse.click(bedBox.x + bedBox.width * 0.25, bedBox.y + bedBox.height / 2);
  await settle();
  const landedAt25 = await page.evaluate('__kinect.timeline.transport().programSec');
  check(near(landedAt25, wantedAt25, 1 / 30 + 1e-6),
    '  and a click a quarter of the way across it seeks to the time it names there',
    `clicked 25%, wanted ${wantedAt25.toFixed(4)}s, landed ${landedAt25.toFixed(4)}s`);

  // Hidden rather than removed, because `repositionLanes` refuses to run when the node count and
  // the key count disagree.
  const culled = await page.evaluate(`(() => {
    const keys = [...document.querySelectorAll('.tlane[data-owner=bloom] .tkey')];
    const marks = [...document.querySelectorAll('#tMarks .tmk')];
    return {
      keys: keys.length, keysShown: keys.filter((n) => !n.hidden).length,
      marks: marks.length, marksShown: marks.filter((n) => !n.hidden).length,
      lefts: keys.map((n) => parseFloat(n.style.left)),
    };
  })()`);
  check(culled.keys === 3 && culled.keysShown === 0 && culled.marksShown === 0,
    '  a marker the window does not hold is hidden rather than drawn off the edge',
    `${culled.keysShown}/${culled.keys} keys and ${culled.marksShown}/${culled.marks} marks shown, `
    + `key lefts ${culled.lefts.map((l) => `${l.toFixed(0)}%`).join(', ')}`);
  check(culled.lefts.some((l) => l < 0) && culled.lefts.some((l) => l > 100),
    '  and its node still carries the position it would have had, on both sides',
    culled.lefts.map((l) => `${l.toFixed(0)}%`).join(', '));

  const ticksAt = () => page.evaluate(`[...document.querySelectorAll('#tRuler .ttick label')].map((l) => l.textContent)`);
  const zoomedTicks = await ticksAt();
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();
  const fitTicks = await ticksAt();
  check(zoomedTicks.join() !== fitTicks.join() && zoomedTicks.length > 2 && fitTicks.length > 2,
    'the ruler picks its spacing from the window, not from the clip',
    `fit: ${fitTicks.slice(0, 6).join(' ')} | zoomed: ${zoomedTicks.slice(0, 6).join(' ')}`);

  await page.evaluate('__kinect.editor.view.set(0.30, 0.42)');
  await settle();
  const box = await page.evaluate(`({
    left: document.getElementById('tMiniWin').style.left,
    width: document.getElementById('tMiniWin').style.width,
  })`);
  check(near(parseFloat(box.left), 30, 0.5) && near(parseFloat(box.width), 12, 0.5),
    'the overview draws the window on the whole clip, which is what says where you are',
    `box at ${box.left} wide ${box.width}`);

  // And it is driven, not merely drawn: the row above reads DOM state after no interaction at all,
  // so a build whose pointerdown handler never fires would paint that box correctly
  // forever and pass it.
  const miniBox = await page.locator('#tMini').boundingBox();
  const dragMini = async (toF, target) => {
    await page.evaluate('__kinect.editor.view.set(0.30, 0.42)');
    await settle();
    const before = await page.evaluate('__kinect.editor.view.window()');
    const y = miniBox.y + miniBox.height / 2;
    const grab = await page.locator(target).boundingBox();
    await page.mouse.move(grab.x + grab.width / 2, y);
    await page.mouse.down();
    await page.mouse.move(miniBox.x + miniBox.width * toF, y, { steps: 4 });
    await page.mouse.up();
    await settle();
    return { before, after: await page.evaluate('__kinect.editor.view.window()') };
  };

  const panned = await dragMini(0.56, '#tMiniWin');
  check(near(panned.after.a - panned.before.a, 0.2, 0.02)
    && near(panned.after.spanSec, panned.before.spanSec, 1e-6),
    '  dragging the window box pans by what the pointer moved, and does not resize it',
    `a ${panned.before.a.toFixed(3)} -> ${panned.after.a.toFixed(3)}, `
    + `span ${panned.before.spanSec.toFixed(3)}s -> ${panned.after.spanSec.toFixed(3)}s`);

  await page.evaluate('__kinect.editor.view.set(0.30, 0.42)');
  await settle();
  const beforeCentre = await page.evaluate('__kinect.editor.view.window()');
  await page.mouse.click(miniBox.x + miniBox.width * 0.8, miniBox.y + miniBox.height / 2);
  await settle();
  const afterCentre = await page.evaluate('__kinect.editor.view.window()');
  check(near((afterCentre.a + afterCentre.b) / 2, 0.8, 0.02)
    && near(afterCentre.spanSec, beforeCentre.spanSec, 1e-6),
    '  and a click on open track centres the window there rather than moving one edge to it',
    `centre ${((beforeCentre.a + beforeCentre.b) / 2).toFixed(3)} -> ${((afterCentre.a + afterCentre.b) / 2).toFixed(3)}, `
    + `span ${afterCentre.spanSec.toFixed(3)}s`);

  // Two positions, because a zoom about the centre holds the centre still and so does a zoom
  // about a pointer that is at the centre - one arm cannot tell them apart, and the wrong build
  // is the one that reads better.
  const zoomAtFraction = async (f) => {
    await page.evaluate('__kinect.editor.view.set(0.2, 0.8)');
    await settle();
    const before = await page.evaluate(`__kinect.editor.view.secAtPct(${f * 100})`);
    const bb = await page.locator('#tBed').boundingBox();
    await page.mouse.move(bb.x + bb.width * f, bb.y + bb.height / 2);
    await page.mouse.wheel(0, -300);
    await settle();
    const after = await page.evaluate(`__kinect.editor.view.secAtPct(${f * 100})`);
    return { before, after };
  };
  for (const f of [0.2, 0.8]) {
    const held = await zoomAtFraction(f);
    check(near(held.after, held.before, 0.05),
      `a wheel zoom ${Math.round(f * 100)}% across the bed holds the program time under the pointer`,
      `${held.before.toFixed(3)}s -> ${held.after.toFixed(3)}s`);
  }

  // The overview's own wheel is a different mapping rather than the same handler on a second
  // element: an x on the ruler is a position in the window and an x here is a position in the clip.
  await page.evaluate('__kinect.editor.view.set(0.2, 0.8)');
  await settle();
  const miniWheelBox = await page.locator('#tMini').boundingBox();
  const beforeMiniWheel = await page.evaluate('__kinect.editor.view.window()');
  const clipAt30 = beforeMiniWheel.duration * 0.3;
  const placeInWindow = (w) => (clipAt30 - w.startSec) / w.spanSec;
  await page.mouse.move(miniWheelBox.x + miniWheelBox.width * 0.3, miniWheelBox.y + miniWheelBox.height / 2);
  await page.mouse.wheel(0, -300);
  await settle();
  const afterMiniWheel = await page.evaluate('__kinect.editor.view.window()');
  check(near(placeInWindow(afterMiniWheel), placeInWindow(beforeMiniWheel), 0.02)
    && afterMiniWheel.spanSec < beforeMiniWheel.spanSec * 0.8,
    '  a wheel over the overview anchors on the clip position under the pointer, not on the window one',
    `30% of the clip is ${clipAt30.toFixed(2)}s, at ${(placeInWindow(beforeMiniWheel) * 100).toFixed(1)}% `
    + `of the window before and ${(placeInWindow(afterMiniWheel) * 100).toFixed(1)}% after, `
    + `span ${beforeMiniWheel.spanSec.toFixed(2)}s -> ${afterMiniWheel.spanSec.toFixed(2)}s`);

  await page.evaluate('__kinect.timeline.counters.laneRebuilds = 0; __kinect.timeline.counters.laneRepositions = 0');
  const wheelBox = await page.locator('#tBed').boundingBox();
  await page.mouse.move(wheelBox.x + wheelBox.width / 2, wheelBox.y + wheelBox.height / 2);
  for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -100);
  await settle();
  const zoomCounters = await page.evaluate('({ ...__kinect.timeline.counters })');
  check(zoomCounters.laneRepositions >= 6 && zoomCounters.laneRebuilds === 0,
    '  and eight wheel notches take the cheap path every time, never the one that resizes the buffer',
    `${zoomCounters.laneRepositions} repositions, ${zoomCounters.laneRebuilds} rebuilds`);

  await page.evaluate('__kinect.editor.view.set(0.2, 0.8)');
  const zoomWindow = await page.evaluate('__kinect.editor.view.window()');
  await page.evaluate(`__kinect.timeline.transport().seek(${(zoomWindow.startSec + zoomWindow.endSec) / 2})`);
  await settle();
  const beforeKeyZoom = await page.evaluate('__kinect.editor.view.window()');
  const parkedFor = await page.evaluate('__kinect.timeline.transport().programSec');
  check(parkedFor > beforeKeyZoom.startSec && parkedFor < beforeKeyZoom.endSec,
    'the playhead is inside the window before the zoom, which is what the row below is about',
    `playhead ${parkedFor.toFixed(2)}s in ${beforeKeyZoom.startSec.toFixed(2)}s..${beforeKeyZoom.endSec.toFixed(2)}s`);
  await focusStage();
  await page.keyboard.press('=');
  await settle();
  const afterIn = await page.evaluate('__kinect.editor.view.window()');
  await page.keyboard.press('-');
  await settle();
  const afterOut = await page.evaluate('__kinect.editor.view.window()');
  check(afterIn.spanSec < beforeKeyZoom.spanSec * 0.95 && near(afterOut.spanSec, beforeKeyZoom.spanSec, 1e-6),
    '+ zooms the ruler in and - takes it back, both about the playhead',
    `${beforeKeyZoom.spanSec.toFixed(3)}s -> ${afterIn.spanSec.toFixed(3)}s -> ${afterOut.spanSec.toFixed(3)}s`);
  const held = await page.evaluate('__kinect.timeline.transport().programSec');
  check(afterIn.startSec < held && afterIn.endSec > held,
    '  and the playhead is still inside the window after zooming in, which is what "about" means',
    `playhead ${held.toFixed(2)}s in ${afterIn.startSec.toFixed(2)}s..${afterIn.endSec.toFixed(2)}s`);
  check((await page.evaluate('__kinect.editor.shortcuts()')).includes('f fits the clip'),
    '  and the shortcut list says so, which is where anybody would look for it',
    await page.evaluate('__kinect.editor.shortcuts()'));

  await page.evaluate('__kinect.editor.view.set(0.4, 0.5)');
  await settle();
  const beforePan = await page.evaluate('__kinect.editor.view.window()');
  await focusStage();
  await page.keyboard.press('.');
  await settle();
  const keyPanned = await page.evaluate('__kinect.editor.view.window()');
  await page.keyboard.press(',');
  await settle();
  const panBack = await page.evaluate('__kinect.editor.view.window()');
  check(near(keyPanned.startSec - beforePan.startSec, beforePan.spanSec * 0.25, 1e-3),
    '. pans the window a quarter of itself along the clip',
    `${beforePan.startSec.toFixed(3)}s -> ${keyPanned.startSec.toFixed(3)}s, a quarter is `
    + `${(beforePan.spanSec * 0.25).toFixed(3)}s`);
  check(near(keyPanned.spanSec, beforePan.spanSec, 1e-6),
    '  without resizing it, which is what every other key on this surface does',
    `${beforePan.spanSec.toFixed(4)}s -> ${keyPanned.spanSec.toFixed(4)}s`);
  check(near(panBack.startSec, beforePan.startSec, 1e-3) && near(panBack.spanSec, beforePan.spanSec, 1e-6),
    '  and , brings it back', `${keyPanned.startSec.toFixed(3)}s -> ${panBack.startSec.toFixed(3)}s`);
  check((await page.evaluate('__kinect.editor.shortcuts()')).includes(',/. pan it'),
    '  and the shortcut list says so too', await page.evaluate('__kinect.editor.shortcuts()'));

  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await settle();
  const slowRate = await driveRate(0.1);
  await page.evaluate('__kinect.editor.view.set(0.5, 0.5)');
  await settle();
  const atMin = await page.evaluate('__kinect.editor.view.window()');
  const fastRate = await driveRate(4);
  const atFast = await page.evaluate('__kinect.editor.view.window()');
  const backRate = await driveRate(0.1);
  const atBack = await page.evaluate('__kinect.editor.view.window()');
  check(near(slowRate, 0.1, 1e-6) && near(fastRate, 4, 1e-6) && near(backRate, 0.1, 1e-6),
    'the round trip really went 0.1x -> 4x -> 0.1x, or the rows below mean nothing',
    `${slowRate}x, ${fastRate}x, ${backRate}x`);
  check(near(atMin.spanSec, 0.25, 1e-6),
    '  and the window was at the 0.25s minimum before it', `${atMin.spanSec.toFixed(6)}s`);
  check(atFast.spanSec >= 0.25 - 1e-9,
    '  and never went below the minimum in the middle of it, which is what the clamp is for',
    `${atFast.spanSec.toFixed(6)}s at 4x`);
  check(near(atBack.spanSec, atMin.spanSec, 1e-6),
    '  and comes back to exactly the window it started at, rather than to what the clamp left',
    `${atMin.spanSec.toFixed(6)}s -> ${atBack.spanSec.toFixed(6)}s`);
  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();

  // A control at the end of its travel should do nothing, not something else: at the minimum
  // window another notch inward asks for a span the clamp refuses, and the clamp could only widen
  // the span, so it kept the start computed for the narrower one and the window slid sideways.
  await page.evaluate('__kinect.editor.view.set(0.5, 0.5)');
  await settle();
  const atFloor = await page.evaluate('__kinect.editor.view.window()');
  const underPointer = (win) => win.startSec + win.spanSec * 0.25;
  const anchorSec = underPointer(atFloor);
  const floorBed = await page.locator('#tBed').boundingBox();
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(floorBed.x + floorBed.width * 0.25, floorBed.y + floorBed.height / 2);
    await page.mouse.wheel(0, -120);
    await new Promise((r) => setTimeout(r, 80));
  }
  await settle();
  const stillAtFloor = await page.evaluate('__kinect.editor.view.window()');
  check(near(atFloor.spanSec, 0.25, 1e-6),
    'the window really is at the minimum before the notches, or the clamp is not the thing under test',
    `${atFloor.spanSec.toFixed(6)}s`);
  check(near(stillAtFloor.spanSec, atFloor.spanSec, 1e-9),
    '  and three more zoom-ins at the clamp leave the width where it is',
    `${atFloor.spanSec.toFixed(6)}s -> ${stillAtFloor.spanSec.toFixed(6)}s`);
  check(near(stillAtFloor.startSec, atFloor.startSec, 1e-6),
    '  and leave the window where it is rather than panning it out from under the pointer',
    `${anchorSec.toFixed(4)}s under the pointer, window `
    + `${atFloor.startSec.toFixed(4)}s -> ${stillAtFloor.startSec.toFixed(4)}s`);
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();

  // The seek storm has one more door, and it is a playhead sitting on a cut: after a rescale the
  // boundary is a float and the playhead is a frame, so one that was exactly on `clipIn` can land
  // a fraction of a frame outside the rescaled one and `setClipInOut` buys a full accurate seek
  // for it on every `input`.
  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await settle();
  await page.evaluate('__kinect.timeline.transport().seek(10)');
  await settle();
  await focusStage();
  await page.keyboard.press('i');
  await settle();
  const onCut = await page.evaluate(`(() => ({
    programSec: __kinect.timeline.transport().programSec,
    in: __kinect.editor.clipRange().in,
  }))()`);
  check(near(onCut.programSec, onCut.in ?? -1, 1e-9),
    'the playhead is sitting exactly on the in point, which is the case the count row never drives',
    `playhead ${onCut.programSec.toFixed(4)}s, in ${(onCut.in ?? -1).toFixed(4)}s`);
  await page.evaluate('__kinect.timeline.counters.seeks = 0');
  await page.evaluate(`(() => {
    const el = document.getElementById('tRate');
    for (let i = 0; i < 12; i++) {
      el.value = String(__kinect.editor.rateSlider.toValue(2.3 + i * 0.01));
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await settle();
  const boundarySeeks = await page.evaluate('__kinect.timeline.counters.seeks');
  check(boundarySeeks <= 2,
    '  and twelve slider steps from there still cost one accurate seek, not one per step',
    `${boundarySeeks} seeks`);
  await page.evaluate('__kinect.editor.setClipRange(0, null)');
  await page.evaluate(`(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))`);
  await settle();

  // A wheel notch is not three pixels, and on Firefox that is what it reports: `deltaMode` is
  // `DOM_DELTA_LINE` there and on some Linux mice.
  const wheelArm = (mode, dy) => page.evaluate(`(async () => {
    __kinect.editor.view.set(0.2, 0.8);
    const bed = document.getElementById('tBed');
    const r = bed.getBoundingClientRect();
    bed.dispatchEvent(new WheelEvent('wheel', {
      deltaY: ${dy}, deltaMode: ${mode}, bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
    }));
    await __kinect.timeline.settled();
    return __kinect.editor.view.window();
  })()`);
  const inPixels = await wheelArm(0, -66);
  const inLines = await wheelArm(1, -3);
  const openSpan = inPixels.duration * 0.6;
  check(inPixels.spanSec < openSpan * 0.95,
    'a wheel notch reported in pixels zooms the ruler',
    `${openSpan.toFixed(3)}s -> ${inPixels.spanSec.toFixed(3)}s`);
  check(near(inLines.spanSec, inPixels.spanSec, 1e-6),
    '  and the same notch reported in lines zooms it by exactly as much',
    `pixels ${inPixels.spanSec.toFixed(4)}s, lines ${inLines.spanSec.toFixed(4)}s`);
  await page.evaluate('__kinect.editor.view.fit()');
  await settle();

  await focusStage();
  await page.keyboard.press('f');
  await settle();
  check((await page.evaluate('__kinect.editor.view.window()')).whole,
    'f fits the whole clip back on the ruler', JSON.stringify(await page.evaluate('__kinect.editor.view.window()')));

  console.log('\n[11] the strip is bounded, and the splitter is what bounds it');
  const LANED = ['bloom', 'grain.amount', 'raster.amount', 'rgbsplit.amount', 'glitch.amount', 'trails', 'rim',
    'thermal.amount', 'edges.amount', 'blackwall.scan', 'noise.amount', 'denoise', 'exposure'];
  // The value each key holds is asked of the registry rather than assumed, because `denoise` is a
  // step parameter and a key holding 0.2 makes `normalise` throw the moment anything
  // evaluates the track.
  const plantLanes = () => page.evaluate(`(() => {
    const spec = {};
    for (const n of ${JSON.stringify(LANED)}) {
      spec[n] = typeof __kinect.params.spec(n).default === 'boolean'
        ? [{ t: 1, value: false }, { t: 5, value: true }]
        : [{ t: 1, value: 0.2 }, { t: 5, value: 0.5 }];
    }
    __kinect.keyframes.setTracks(spec);
  })()`);
  await plantLanes();
  await settle();
  const manyLanes = await page.evaluate('__kinect.editor.strip()');
  check(manyLanes.stacked > manyLanes.ceiling && (await keyedLanes()).length === LANED.length,
    'enough keyed parameters and the lanes want more height than the stage can spare',
    `${(await keyedLanes()).length} keyed lanes stacking ${manyLanes.stacked}px against a ${manyLanes.ceiling}px ceiling, `
    + `strip ${manyLanes.height}px`);

  const gripAt = () => page.locator('#tGrip').boundingBox();
  const dragGrip = async (by) => {
    const g = await gripAt();
    await page.mouse.move(g.x + g.width / 2, g.y + 2);
    await page.mouse.down();
    await page.mouse.move(g.x + g.width / 2, g.y + 2 + by, { steps: 6 });
    await page.mouse.up();
    await settle();
    return page.evaluate('__kinect.editor.strip()');
  };

  const shrunk = await dragGrip(150);
  check(shrunk.lanes < manyLanes.lanes - 100 && shrunk.height < manyLanes.height - 100,
    'dragging the splitter down gives the height back to the stage',
    `lanes ${manyLanes.lanes}px -> ${shrunk.lanes}px, strip ${manyLanes.height}px -> ${shrunk.height}px`);
  check(shrunk.lanes < shrunk.stacked && shrunk.scrollable,
    '  and the lanes it no longer has room for scroll rather than being cut off',
    `${shrunk.lanes}px of ${shrunk.stacked}px stacked, scrollable ${shrunk.scrollable}`);

  // Optional-chained, like every other reach into the strip below it: `lanes-clear-siblings`
  // removes `#tLanes` along with everything else it clears, and a raw dereference here discarded
  // 140 correct assertions as DID NOT RUN.
  await page.evaluate("(() => { const el = document.getElementById('tLanes'); if (el) el.scrollTop = 60; })()");
  await new Promise((r) => setTimeout(r, 120));
  const scrolled = await page.evaluate('__kinect.editor.strip()');
  check(scrolled.railScrollTop === scrolled.scrollTop && scrolled.scrollTop === 60,
    '  and the rail follows them, or every lane would be labelled with its neighbour',
    `lanes at ${scrolled.scrollTop}px, rail at ${scrolled.railScrollTop}px`);

  // And the other way into the same scroller, which the wheel rows cannot speak for: a lane covers
  // its row and declared `touch-action: none`, so on a touchscreen the browser could not pan the
  // stack and the delegated pointer handler returns on anything that is not a key or a handle.
  await page.evaluate(`__kinect.editor.select('bloom', 0)`);
  await settle();
  const touch = await page.evaluate(`(() => {
    const lane = document.querySelector('.tlane');
    if (!lane) return null;
    const chain = [];
    for (let el = lane; el && el.id !== 'tLanes'; el = el.parentElement) {
      chain.push(\`\${el.tagName.toLowerCase()}\${el.id ? '#' + el.id : ''}=\${getComputedStyle(el).touchAction}\`);
    }
    const of = (sel) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).touchAction : null;
    };
    return {
      chain, blocked: chain.filter((c) => /=(none|pan-x)$/.test(c)),
      key: of('.tlane .tkey'), handle: of('.tlane .thandle'),
    };
  })()`);
  check(touch !== null && touch.blocked.length === 0,
    '  and a touch swipe can reach them, which no wheel row above can speak for',
    touch === null ? 'no lane to read' : touch.chain.join('  '));
  // The other side of the same rule, and it has to be here or the row above is an instruction to
  // break something else: a scalar key's value and an ease handle's vertical component both come
  // from `clientY`, so inheriting `pan-y` would let the browser claim a vertical drag on a key
  // for scrolling and cancel the pointer sequence.
  check(touch !== null && touch.key === 'none',
    '  while a key keeps both axes, because its value is the vertical one',
    `key touch-action ${touch?.key}`);
  check(touch !== null && touch.handle === 'none',
    '  and so does an ease handle, for the same reason',
    `handle touch-action ${touch?.handle}`);

  const g = await gripAt();
  await page.mouse.move(g.x + g.width / 2, g.y + 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2, 4, { steps: 8 });
  await page.mouse.up();
  await settle();
  const maxed = await page.evaluate('__kinect.editor.strip()');
  const stageShare = (VIEWPORT.height - maxed.height) / VIEWPORT.height;
  check(stageShare >= 0.35,
    '  and dragging it to the top of the window still leaves the stage a third of it',
    `strip ${maxed.height}px of ${VIEWPORT.height}px leaves the stage ${(stageShare * 100).toFixed(1)}%`);
  check(maxed.lanes === maxed.ceiling,
    '  and it stops exactly at that ceiling, which is the one thing bounding it',
    `${maxed.lanes}px against a ${maxed.ceiling}px ceiling, ${maxed.stacked}px stacked`);

  // `resize()` reallocates the drawing buffer and the composer's targets, so a drag that ran it
  // per pointer event is the failure `repositionLanes` was split out to avoid.
  const gd = await gripAt();
  await page.mouse.move(gd.x + gd.width / 2, gd.y + 2);
  await page.mouse.down();
  const burst = await page.evaluate(`(() => {
    const el = document.getElementById('tGrip');
    if (!el) return { before: -1, afterSync: -1, lanes: -1 };
    const y0 = ${Math.round(gd.y + 2)};
    const before = __kinect.editor.stageResizes();
    for (let i = 1; i <= 40; i++) {
      el.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 100, clientY: y0 - i, bubbles: true }));
    }
    return { before, afterSync: __kinect.editor.stageResizes(), lanes: __kinect.editor.strip().lanes };
  })()`);
  await page.mouse.up();
  await settle();
  const afterFrame = await page.evaluate('__kinect.editor.stageResizes()');
  check(burst.afterSync === burst.before,
    'forty splitter moves in one task resize the drawing buffer no times, not forty',
    `${burst.afterSync - burst.before} resizes during the burst`);
  check(afterFrame - burst.before <= 3,
    '  and at most a frame\'s worth once the frame runs, which is what the throttle is for',
    `${afterFrame - burst.before} resizes in total for 40 moves`);

  // The claim is not that the keys work but that they do only their own job: `#tGrip` is a
  // `role=separator` carrying a tabindex rather than a form field, so the window handler's
  // `isTyping` guard does not cover it, and Home and End are both ends of the splitter's travel
  // and the two clip boundaries the global shortcuts seek to.
  await page.evaluate('__kinect.timeline.transport().seek(20)');
  await settle();
  await page.evaluate("document.getElementById('tGrip')?.focus()");
  const gripFocused = await page.evaluate("document.activeElement === document.getElementById('tGrip')");
  const parked = await read();
  check(gripFocused && parked.programSec > 1 && parked.programSec < parked.duration - 1,
    'the splitter takes focus, with the playhead parked clear of both ends so a stray seek would show',
    `focused ${gripFocused}, playhead ${parked.programSec.toFixed(3)}s of ${parked.duration.toFixed(2)}s`);
  await page.keyboard.press('Home');
  await settle();
  const homeStrip = await page.evaluate('__kinect.editor.strip()');
  const homeRead = await read();
  check(homeStrip.lanes === 0, 'Home on the splitter collapses the strip', `${homeStrip.lanes}px`);
  check(near(homeRead.programSec, parked.programSec, 1e-3),
    '  and seeks nowhere, because a key another control consumed is not a shortcut',
    `${parked.programSec.toFixed(3)}s -> ${homeRead.programSec.toFixed(3)}s`);
  await page.keyboard.press('End');
  await settle();
  const endStrip = await page.evaluate('__kinect.editor.strip()');
  const endRead = await read();
  check(endStrip.lanes > homeStrip.lanes,
    'End reaches the other end of the splitter\'s travel', `${homeStrip.lanes}px -> ${endStrip.lanes}px`);
  check(near(endRead.programSec, parked.programSec, 1e-3),
    '  and seeks nowhere either', `${parked.programSec.toFixed(3)}s -> ${endRead.programSec.toFixed(3)}s`);
  await focusStage();

  // The height outlives the page, which is the only reason it is in `localStorage` at all - a
  // build that never called `setItem` would pass every row above.
  // Dragged to a computed target rather than by a fixed amount: a flat 200px landed 42px from the
  // default once `--timeline-h` moved, and the row below would then have passed on a build that
  // stored nothing at all.
  const defaulted = Math.round(VIEWPORT.height * 0.35);
  const beforeAsking = await page.evaluate('__kinect.editor.strip()');
  const askedFor = await dragGrip(beforeAsking.lanes - Math.round(defaulted / 2));
  check(Math.abs(askedFor.lanes - defaulted) > 60,
    'the dragged height is nowhere near the default, so the reload row below means something',
    `dragged to ${askedFor.lanes}px against a ${defaulted}px default`);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction('!!globalThis.__kinect', null, { timeout: 30000 });
  await page.waitForFunction('!!globalThis.__kinect.timeline.transport()', null, { timeout: 30000 });
  await settle();
  await plantLanes();
  await settle();
  const reloaded = await page.evaluate('__kinect.editor.strip()');
  check(near(reloaded.lanes, askedFor.lanes, 2),
    'the height survives a reload, which is the only reason it is stored at all',
    `${askedFor.lanes}px before, ${reloaded.lanes}px after`);

  // The one arrangement where the two candidate bounds disagree, and every row above sits outside
  // it: with fourteen lanes stacking past the ceiling, a build clamping to the content and one
  // clamping to the ceiling give the same height. Cleared of tracks the stack is shorter than the
  // ceiling, and only there does it show that the strip is bounded by the stage's share rather
  // than by what is in it.
  await page.evaluate('__kinect.keyframes.setTracks({})');
  await settle();
  const shortStack = await page.evaluate('__kinect.editor.strip()');
  check(shortStack.stacked < shortStack.ceiling,
    'cleared of tracks the lanes stack shorter than the ceiling, which is where the two bounds differ',
    `${shortStack.stacked}px stacked against a ${shortStack.ceiling}px ceiling`);
  const gs = await gripAt();
  await page.mouse.move(gs.x + gs.width / 2, gs.y + 2);
  await page.mouse.down();
  await page.mouse.move(gs.x + gs.width / 2, 4, { steps: 8 });
  await page.mouse.up();
  await settle();
  const opened = await page.evaluate('__kinect.editor.strip()');
  check(opened.lanes === opened.ceiling && opened.lanes > opened.stacked,
    '  and the splitter still opens to the ceiling, past the last lane rather than stopping at it',
    `${opened.lanes}px against a ${opened.ceiling}px ceiling and ${opened.stacked}px stacked`);

  // Put it back, so nothing below inherits a strip somebody dragged.
  await page.evaluate('__kinect.keyframes.setTracks({})');
  await page.evaluate("localStorage.removeItem('kinect.lanesHeight')");
  await settle();

  check(errors.length === 0, 'the page reported no errors while any of this happened',
    errors.length ? errors.slice(0, 3).join(' | ') : '');

  console.log('\n[12] a look leaves as a file and comes back as one');
  // This section writes to the real preset library, so it writes only names nobody else could own
  // - the import takes the document's name from the file's name, and fixed names meant a document
  // appearing in somebody's picker for good.
  await page.locator('#panelTabLook').click();
  const nonce = `ec${process.pid}-${Date.now().toString(36)}`;
  const NAME_EDITED = `${nonce}-edited-outside`;
  const NAME_BAD = `${nonce}-not-a-look`;
  const NAME_PROTO = `${nonce}-proto`;
  const NAME_PART = `${nonce}-part-of-a-look`;
  const NAME_RACE = `${nonce}-two-at-once`;
  const NAME_SAVED_PART = `${nonce}-saved-part`;
  const NAME_NO_VALUES = `${nonce}-no-values`;
  const NAME_EMPTY_VALUES = `${nonce}-empty-values`;
  const NAME_LIST_VALUES = `${nonce}-list-values`;
  const NAME_PART_READINGS = `${nonce}-part-readings`;
  const NAME_STRAY_KEY = `${nonce}-stray-key`;
  const MADE = [NAME_EDITED, NAME_BAD, NAME_PROTO, NAME_PART, NAME_RACE, NAME_SAVED_PART,
    NAME_NO_VALUES, NAME_EMPTY_VALUES, NAME_LIST_VALUES, NAME_PART_READINGS, NAME_STRAY_KEY];
  for (const n of MADE) {
    const r = await fetch(`${URL_BASE}/presets/${n}`);
    check(!r.ok, `the fixture name ${n} is free before the run, or nothing below is about this run`,
      r.ok ? 'a document already exists under it' : 'absent');
  }
  const cleanupPresets = async () => {
    for (const n of MADE) {
      const probe = await fetch(`${URL_BASE}/presets/${n}`);
      if (!probe.ok) continue;
      // The content type is required even here: `/presets/:name` is a mutating route and the
      // write guard refuses a request that does not declare JSON, DELETE included.
      const rev = (await probe.json().catch(() => null))?.rev ?? 'absent';
      const res = await fetch(`${URL_BASE}/presets/${n}?rev=${encodeURIComponent(rev)}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      }).catch((err) => ({ ok: false, status: err.message }));
      check(res.ok, `and the fixture ${n} this run created was removed again`,
        res.ok ? 'deleted' : `DELETE answered ${res.status}`);
    }
  };
  try {
    const known = { bloom: 0.75, 'grain.amount': 0.66, 'blackwall.amount': 1, readRgb: 0 };
    await page.evaluate(`globalThis.__kinect.applyPreset(${JSON.stringify(known)})`);
    // Moved again after the apply and never saved, which is what makes the row below able to fail:
    // `exportPresetFile` takes its name from the picker and its values from the live look, and a
    // build exporting the picker's document instead of the screen would write a file containing
    // `known` and pass. 0.9 exists in neither the picker's document nor any shipped look.
    const onlyOnScreen = 0.9;
    await page.evaluate(`globalThis.__kinect.params.set('bloom', ${onlyOnScreen})`);
    await settle();

    // The dialog stands between the button and the file, so this drives it rather than reaching
    // past it: a probe that called `pickPresetSubset` or handed a name list to
    // `presetFromCurrentLook` would attach below the seam and pass on a build whose boxes are
    // wired to nothing.
    const presetIdle = () => page.waitForFunction(
      '!globalThis.__kinect.library.presetGestureRunning()', null, { timeout: 15000 });
    // Focused before it is clicked, which is what a hand does and what a programmatic `click()`
    // does not - and the caret has to start on the control, or the row below asserting it comes
    // back is asserting that the body still has it.
    const openPicker = async (id) => {
      await presetIdle();
      await page.focus(`#${id}`);
      await page.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
      await page.waitForFunction("document.getElementById('presetPick').open === true", null, { timeout: 10000 });
    };
    const applyByChoosing = async (name) => {
      await presetIdle();
      await page.click('#tPreset');
      await page.waitForFunction("document.getElementById('tPresetList').hidden === false",
        null, { timeout: 10000 });
      await page.click(`#tPresetList .pickeroption[data-name=${JSON.stringify(name)}]`);
    };
    const importFile = async (path) => {
      await presetIdle();
      await page.setInputFiles('#tPresetFile', path);
    };
    await openPicker('tPresetExport');
    const offered = await page.evaluate(`(() => {
      const boxes = [...document.querySelectorAll('#ppGroups input[id^="pp-"]')];
      const heads = [...document.querySelectorAll('#ppGroups input[id^="ppg-"]')];
      return {
        named: boxes.map((b) => b.id.slice(3)),
        ticked: boxes.filter((b) => b.checked).length,
        heads: heads.length,
        whole: heads.filter((h) => h.checked && !h.indeterminate).length,
      };
    })()`);
    const lookNames = await page.evaluate('globalThis.__kinect.presetValueNames()');
    const noBox = lookNames.filter((n) => !offered.named.includes(n));
    const extraBox = offered.named.filter((n) => !lookNames.includes(n));
    check(noBox.length === 0 && extraBox.length === 0,
      `the dialog offers every preset value and only those (${lookNames.length})`,
      noBox.length || extraBox.length ? `no box for ${noBox.join(', ') || 'none'}; not a preset value: ${extraBox.join(', ') || 'none'}`
        : `${offered.named.length} boxes`);
    check(offered.ticked === offered.named.length && offered.whole === offered.heads,
      'and every box starts ticked, so the gesture that existed before this dialog writes what it wrote before',
      `${offered.ticked} of ${offered.named.length} ticked, ${offered.whole} of ${offered.heads} headings whole`);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate("document.getElementById('ppGo').click()"),
    ]);
    const saved = join(TMP, download.suggestedFilename());
    await download.saveAs(saved);
    const exported = JSON.parse(readFileSync(saved, 'utf8'));
    check(/\.braindance-preset\.json$/.test(download.suggestedFilename()),
      'export writes a named file the browser actually downloaded', download.suggestedFilename());
    const expected = { ...known, bloom: onlyOnScreen };
    const wrong = Object.entries(expected).filter(([n, v]) => exported.values?.[n] !== v);
    check(exported.version === PROJECT_VERSION && wrong.length === 0,
      'and what it wrote is the look on screen rather than the document the picker names',
      wrong.length ? wrong.map(([n, v]) => `${n} ${exported.values?.[n]} not ${v}`).join(' ') : `version ${exported.version}, bloom ${exported.values.bloom}`);

    const edited = join(TMP, `${NAME_EDITED}.braindance-preset.json`);
    const nextBody = { ...exported, values: { ...exported.values, bloom: 0.6, 'grain.amount': 0.13 } };
    writeFileSync(edited, `${JSON.stringify(nextBody, null, 2)}\n`);
    await page.evaluate("globalThis.__kinect.params.reset(globalThis.__kinect.params.names('look'))");
    await settle();
    await importFile(edited);
    await page.waitForFunction("document.getElementById('tNote').textContent.startsWith('imported')", null, { timeout: 15000 });
    await settle();
    const back = await page.evaluate("(() => { const k = globalThis.__kinect; return JSON.stringify({ bloom: k.params.get('bloom'), grain: k.params.get('grain.amount'), blackwall: k.params.get('blackwall.amount'), stamp: k.library.appliedPreset() }); })()");
    const landed = JSON.parse(back);
    check(landed.bloom === 0.6 && landed.grain === 0.13 && landed.blackwall === 1,
      'and importing it puts the edited look on screen', `bloom ${landed.bloom} grain ${landed.grain}`);
    check(landed.stamp?.name === NAME_EDITED,
      'and stamps the clip with where it came from', JSON.stringify(landed.stamp?.name));

    const ticksNow = `(() => [...document.querySelectorAll('#ppGroups input[id^="pp-"]')]
      .filter((b) => b.checked).map((b) => b.id.slice(3)))()`;
    await openPicker('tPresetExport');
    await page.fill('#ppName', NAME_PART);
    const panelPoints = await page.evaluate(`(() => {
      const group = [...document.querySelectorAll('#panel .group')]
        .find((g) => g.querySelector('label')?.textContent.trim() === 'Points');
      return group ? [...group.querySelectorAll('input')].map((i) => i.id).filter(Boolean).sort() : null;
    })()`);
    const beforeGroup = await page.evaluate(ticksNow);
    await page.click('#ppg-points');
    const afterGroup = await page.evaluate(ticksNow);
    const groupOff = beforeGroup.filter((n) => !afterGroup.includes(n)).sort();
    check(panelPoints !== null && panelPoints.length > 0 && groupOff.join() === panelPoints.join(),
      'unticking a group heading takes exactly the parameters the panel puts under that heading',
      `${groupOff.length} off: ${groupOff.join(', ')}; the panel's Points holds ${(panelPoints ?? ['(no such group)']).join(', ')}`);
    await page.click('#pp-readDepth');
    const afterReading = await page.evaluate(ticksNow);
    const readingOff = afterGroup.filter((n) => !afterReading.includes(n));
    check(readingOff.length === 5 && readingOff.includes('readDepth'),
      'and unticking one reading weight unticks all five, because half a blend is not a look',
      `${readingOff.length} off: ${readingOff.join(', ')}`);

    const [partDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.evaluate("document.getElementById('ppGo').click()"),
    ]);
    const partFile = join(TMP, partDownload.suggestedFilename());
    await partDownload.saveAs(partFile);
    const partBody = JSON.parse(readFileSync(partFile, 'utf8'));
    const wroteExtra = Object.keys(partBody.values ?? {}).filter((n) => !afterReading.includes(n));
    const wroteNone = afterReading.filter((n) => !Object.hasOwn(partBody.values ?? {}, n));
    check(wroteExtra.length === 0 && wroteNone.length === 0,
      'and the file that comes out names exactly the values that were left ticked',
      wroteExtra.length || wroteNone.length
        ? `${wroteExtra.length} it should not name (${wroteExtra.slice(0, 4).join(', ')}), ${wroteNone.length} missing`
        : `${Object.keys(partBody.values).length} of ${lookNames.length} look values`);

    // Back in through the file input, which is where the format meets the document this dialog
    // just authored: a build whose reading boxes move one at a time writes four of the five
    // weights, and `refusePresetBody` refuses exactly that file.
    const noteBeforeImport = (await text('#tNote')) ?? '';
    await importFile(partFile);
    await page.waitForFunction(`document.getElementById('tNote').textContent !== ${JSON.stringify(noteBeforeImport)}`,
      null, { timeout: 15000 }).catch(() => {});
    await settle();
    const importNote = (await text('#tNote')) ?? '';
    check(importNote.startsWith('imported'),
      'and the format accepts the document this dialog authored, which is the file rule reading back what the control wrote',
      `"${importNote}"`);
    const afterPart = await page.evaluate("(() => { const k = globalThis.__kinect; return JSON.stringify({ stamp: k.library.appliedPreset(), grain: k.params.get('grain.amount') }); })()");
    const part = JSON.parse(afterPart);
    check(part.stamp?.name === NAME_EDITED,
      'a preset that is part of a look leaves the clip\'s provenance alone - it did not say what the look is',
      `stamp ${JSON.stringify(part.stamp?.name)}, where the file just imported was ${NAME_PART}`);
    check(part.grain === 0.13,
      'while the values it does name are applied like any other look',
      `grain ${part.grain}`);

    const wroteName = await page.evaluate(`(() => {
      const el = document.getElementById('tPreset');
      el.value = ${JSON.stringify(NAME_PART)};
      return el.value;
    })()`);
    check(wroteName === NAME_PART, 'the picker holds the preset name that was written to it',
      `wrote ${JSON.stringify(NAME_PART)}, the control reads ${JSON.stringify(wroteName)}`);
    await applyByChoosing(NAME_PART);
    await page.waitForFunction("document.getElementById('tNote').textContent.startsWith('applied')", null, { timeout: 15000 })
      .catch(() => {});
    await settle();
    const partNote = await text('#tNote');
    check(partNote.startsWith('applied') && !/·\s*[0-9a-f]{8}\s*$/.test(partNote) && partNote.includes(NAME_PART),
      'and the note for it says what was applied rather than naming a revision this gesture did not apply',
      `"${partNote}"`);

    const stampBeforeSave = await page.evaluate('globalThis.__kinect.library.appliedPreset()');
    await openPicker('tPresetSave');
    await page.fill('#ppName', NAME_SAVED_PART);
    await page.click('#ppg-points');
    await page.click('#pp-readDepth');
    const savedTicks = await page.evaluate(ticksNow);
    await page.evaluate("document.getElementById('ppGo').click()");
    await page.waitForFunction(
      `document.getElementById('tNote').textContent.startsWith('saved ${NAME_SAVED_PART}')`,
      null, { timeout: 15000 }).catch(() => {});
    await settle();
    const savedDoc = await (await fetch(`${URL_BASE}/presets/${encodeURIComponent(NAME_SAVED_PART)}`)).json();
    const savedKeys = Object.keys(savedDoc.body?.values ?? {});
    const savedExtra = savedKeys.filter((n) => !savedTicks.includes(n));
    const savedMissing = savedTicks.filter((n) => !savedKeys.includes(n));
    check(savedTicks.length > 0 && savedTicks.length < lookNames.length
      && savedExtra.length === 0 && savedMissing.length === 0,
      'saving a subset puts exactly the ticked values in the library, which no export row can say',
      savedExtra.length || savedMissing.length
        ? `${savedExtra.length} it should not name (${savedExtra.slice(0, 4).join(', ')}), ${savedMissing.length} missing`
        : `${savedKeys.length} of ${lookNames.length} look values, matching the ${savedTicks.length} boxes left ticked`);
    const stampAfterSave = await page.evaluate('globalThis.__kinect.library.appliedPreset()');
    check(stampAfterSave?.name === stampBeforeSave?.name && stampAfterSave?.rev === stampBeforeSave?.rev,
      'and saving part of a look leaves the clip\'s provenance where it was, because the file does not say what the look is',
      `stamp ${JSON.stringify(stampBeforeSave?.name)} before, ${JSON.stringify(stampAfterSave?.name)} after`);

    const presetsBefore = (await (await fetch(`${URL_BASE}/presets`)).json()).presets.map((d) => d.name);
    await openPicker('tPresetSave');
    await page.fill('#ppName', `${nonce}-never-written`);
    await page.click('#ppCancel');
    await page.waitForFunction("document.getElementById('presetPick').open === false", null, { timeout: 10000 });
    const presetsAfter = (await (await fetch(`${URL_BASE}/presets`)).json()).presets.map((d) => d.name);
    check(presetsAfter.length === presetsBefore.length && !presetsAfter.includes(`${nonce}-never-written`),
      'and cancelling the dialog writes nothing at all',
      `${presetsBefore.length} documents before, ${presetsAfter.length} after`);

    // ---- two saves at once, which the dialog made possible and the `prompt` had not
    // `pickPresetSubset` closes before the PUT it authorised has been answered, so from that
    // instant both controls are live with a write still in flight, and two responses coming back
    // out of order leave `appliedPreset` naming the older revision.
    let releasePut = () => {};
    let putsSeen = 0;
    let getsSeen = 0;
    const holdPut = async (route) => {
      if (route.request().method() !== 'PUT') {
        if (route.request().method() === 'GET') getsSeen += 1;
        await route.continue();
        return;
      }
      putsSeen += 1;
      if (putsSeen === 1) await new Promise((resolve) => { releasePut = resolve; });
      await route.continue();
    };
    await page.route('**/presets/**', holdPut);
    try {
      const until = async (ready, what, ms = 15000) => {
        const began = Date.now();
        while (!ready()) {
          if (Date.now() - began > ms) throw new Error(what);
          await new Promise((r) => { setTimeout(r, 20); });
        }
      };
      await openPicker('tPresetSave');
      await page.fill('#ppName', NAME_RACE);
      await page.evaluate("document.getElementById('ppGo').click()");
      await page.waitForFunction("document.getElementById('presetPick').open === false", null, { timeout: 10000 });
      await until(() => putsSeen === 1, 'the save never reached the network, so nothing below is about a write in flight');

      const busy = await page.evaluate(`(() => ({
        save: document.getElementById('tPresetSave').disabled,
        exported: document.getElementById('tPresetExport').disabled,
        imported: document.getElementById('tPresetImport').disabled,
        dialog: document.getElementById('presetPick').open,
      }))()`);
      check(busy.save && busy.exported && busy.imported && !busy.dialog,
        'a preset write in flight disables every control that could start a second one, with the dialog already gone',
        `save disabled=${busy.save}, export disabled=${busy.exported}, `
        + `import disabled=${busy.imported}, dialog open=${busy.dialog}`);

      const second = await page.evaluate(`(() => {
        const button = document.getElementById('tPresetSave');
        button.disabled = false;
        button.click();
        return { dialog: document.getElementById('presetPick').open, note: document.getElementById('tNote').textContent };
      })()`);
      check(!second.dialog && putsSeen === 1,
        'and a second save pressed with the disable removed opens no dialog and puts no second write on the wire',
        `dialog open=${second.dialog}, ${putsSeen} PUT reached the network`);

      const stampMidRace = await page.evaluate('globalThis.__kinect.library.appliedPreset()');
      const getsBefore = getsSeen;
      await page.click('#tPreset');
      await page.waitForFunction("document.getElementById('tPresetList').hidden === false",
        null, { timeout: 10000 });
      await page.click(`#tPresetList .pickeroption[data-name=${JSON.stringify(NAME_EDITED)}]`);
      await settle();
      const stampAfterApply = await page.evaluate('globalThis.__kinect.library.appliedPreset()');
      const offered = await page.evaluate("document.getElementById('tPreset').value");
      check(offered === NAME_EDITED && getsSeen === getsBefore
        && stampAfterApply?.rev === stampMidRace?.rev,
        'and an entry chosen with a write in flight fetches no document and moves no stamp, so the write cannot be overtaken',
        `${getsSeen - getsBefore} GET on the wire, stamp ${JSON.stringify(stampMidRace?.name)} before `
        + `and ${JSON.stringify(stampAfterApply?.name)} after, offering ${offered}`);
      // The caret put back where the disable left it, because this probe moved it: pressing an
      // entry is a real click and it takes the focus, and `whileWriting` restores only from a
      // stranded caret, so a picker still holding it means the restore correctly does not fire
      // and the row reddens over the probe.
      await page.evaluate('document.activeElement?.blur?.()');

      await page.setInputFiles('#tPresetFile', edited);
      await settle();
      check(putsSeen === 1,
        'and a file chosen with a write in flight starts no second one either, which is the third door onto the same stamp',
        `${putsSeen} PUT reached the network, note "${await text('#tNote')}"`);

      releasePut();
      await page.waitForFunction(
        `document.getElementById('tNote').textContent.startsWith('saved ${NAME_RACE}')`,
        null, { timeout: 15000 }).catch(() => {});
      await settle();
      const done = await page.evaluate(`(() => ({
        note: document.getElementById('tNote').textContent,
        save: document.getElementById('tPresetSave').disabled,
        exported: document.getElementById('tPresetExport').disabled,
        imported: document.getElementById('tPresetImport').disabled,
        gesture: globalThis.__kinect.library.presetGestureRunning(),
        focus: document.activeElement ? document.activeElement.id || document.activeElement.tagName : null,
        stamp: globalThis.__kinect.library.appliedPreset(),
      }))()`);
      check(done.note.startsWith(`saved ${NAME_RACE}`) && done.stamp?.name === NAME_RACE,
        'the write the guard let through finishes and stamps the clip, so the guard refuses a second gesture rather than the first',
        `"${done.note}" with the stamp naming ${JSON.stringify(done.stamp?.name)}`);
      check(!done.save && !done.exported && !done.imported && done.gesture === false,
        'and every control comes back the moment the write is answered, so the guard is a span rather than a state to get stuck in',
        `save disabled=${done.save}, export disabled=${done.exported}, import disabled=${done.imported}, `
        + `gesture running=${done.gesture}`);
      // The caret, which the guard's own comment claimed it never took and did:
      // `pickPresetSubset` hands focus back on the `close` event and resolves in the same breath,
      // so the button is holding it when the write span disables that same button a microtask
      // later - which blurs it onto the body, and re-enabling does not undo that.
      check(done.focus === 'tPresetSave',
        'and the caret is back on the control that opened the dialog rather than on the body the disable dropped it to',
        `focus is on ${JSON.stringify(done.focus)}`);
    } finally {
      // Unrouted whatever happened above, because a parked PUT handler left installed would hold
      // the first write of every row after this one.
      releasePut();
      await page.unroute('**/presets/**', holdPut);
    }

    const bad = join(TMP, `${NAME_BAD}.braindance-preset.json`);
    writeFileSync(bad, `${JSON.stringify({ version: PROJECT_VERSION, values: { bloom: 'loud' } }, null, 2)}\n`);
    await importFile(bad);
    await page.waitForFunction("document.getElementById('tNote').textContent.includes('bloom')", null, { timeout: 15000 })
      .catch(() => {});
    const afterBad = await page.evaluate("(() => ({ note: document.getElementById('tNote').textContent, bloom: globalThis.__kinect.params.get('bloom') }))()");
    check(/bloom/.test(afterBad.note) && afterBad.bloom === 0.6,
      'a malformed file is refused at the key that is wrong, and leaves the look alone',
      `"${afterBad.note}" with bloom still ${afterBad.bloom}`);

    // And it never became a document, which the two observations above cannot see: a build that
    // PUT the file first and validated afterwards satisfies both while leaving the malformed
    // preset in the picker looking like a look.
    const storeAfterBad = await (await fetch(`${URL_BASE}/presets`)).json();
    const landedBad = storeAfterBad.presets.find((d) => d.name === NAME_BAD && !d.builtin);
    check(!landedBad,
      'and a refused file never reaches the library, which the note and the look cannot tell you',
      landedBad ? `${NAME_BAD} is in /presets` : `${NAME_BAD} is absent from /presets`);

    // And the prototype question, which a file can ask and an assignment cannot: `JSON.parse`
    // creates `__proto__` as an own enumerable property where `p.x.__proto__ = v` invokes the
    // setter and creates nothing, so this shape has to be sent as source rather than built in JS.
    const proto = join(TMP, `${NAME_PROTO}.braindance-preset.json`);
    writeFileSync(proto, `{ "version": ${PROJECT_VERSION}, "values": { "__proto__": { "polluted": true }, "bloom": 1 } }\n`);
    const parsedHasOwn = Object.keys(JSON.parse(readFileSync(proto, 'utf8')).values).includes('__proto__');
    check(parsedHasOwn, 'the probe really contains __proto__ as an own key, or the row below tests nothing');
    await importFile(proto);
    await page.waitForFunction("document.getElementById('tNote').textContent.includes('__proto__')", null, { timeout: 15000 })
      .catch(() => {});
    const afterProto = await page.evaluate("(() => ({ note: document.getElementById('tNote').textContent, polluted: ({}).polluted ?? null, bloom: globalThis.__kinect.params.get('bloom') }))()");
    check(/__proto__/.test(afterProto.note) && afterProto.polluted === null && afterProto.bloom === 0.6,
      'and a file carrying __proto__ is refused as an unknown parameter, polluting nothing',
      `"${afterProto.note}" polluted=${afterProto.polluted}`);

    const refuse = async (label, body) => {
      const path = join(TMP, `${label}.braindance-preset.json`);
      writeFileSync(path, `${body}\n`);
      const was = (await text('#tNote')) ?? '';
      await importFile(path);
      await page.waitForFunction(`document.getElementById('tNote').textContent !== ${JSON.stringify(was)}`,
        null, { timeout: 15000 }).catch(() => {});
      await settle();
      return (await text('#tNote')) ?? '';
    };

    const noValues = await refuse(NAME_NO_VALUES, `{ "version": ${PROJECT_VERSION} }`);
    const emptyValues = await refuse(NAME_EMPTY_VALUES, `{ "version": ${PROJECT_VERSION}, "values": {} }`);
    const listValues = await refuse(NAME_LIST_VALUES, `{ "version": ${PROJECT_VERSION}, "values": [1, 2, 3] }`);
    const distinct = new Set([noValues, emptyValues, listValues]).size === 3;
    check(distinct
      && /no values object/.test(noValues)
      && /nothing in it/.test(emptyValues) && /scope is nothing/.test(emptyValues)
      && /a list where its values should be/.test(listValues),
      'three documents with no look in them get three sentences, each about the shape that arrived',
      `no values key: "${noValues}" | empty values: "${emptyValues}" | a list: "${listValues}"`);

    const readings = await page.evaluate('__kinect.readings()');
    const namedTwo = readings.slice(0, 2);
    const missingThree = readings.slice(2);
    const partReadings = await refuse(NAME_PART_READINGS,
      JSON.stringify({
        version: PROJECT_VERSION,
        values: { bloom: 0.8, ...Object.fromEntries(namedTwo.map((n) => [n, 1])) },
      }));
    check(missingThree.every((n) => partReadings.includes(n))
      && namedTwo.every((n) => partReadings.includes(n))
      && partReadings.includes(`Name the other ${missingThree.length}`)
      && partReadings.includes(`take all ${namedTwo.length} it has out`),
      'a file naming some of the reading weights is refused with both ways out of it, not only the one that adds keys',
      `"${partReadings}" against ${namedTwo.join(', ')} named and ${missingThree.join(', ')} missing`);

    const strayKey = await refuse(NAME_STRAY_KEY,
      JSON.stringify({ version: PROJECT_VERSION, mode: 4, values: { bloom: 0.6 } }));
    check(/mode/.test(strayKey) && /preset/.test(strayKey),
      'a document carrying a key beside version and values is refused by name, so a field an older version had is answered rather than ignored',
      `"${strayKey}"`);
    const storeAfterStray = await (await fetch(`${URL_BASE}/presets`)).json();
    const landedStray = storeAfterStray.presets.find((d) => d.name === NAME_STRAY_KEY && !d.builtin);
    check(!landedStray,
      'and it never reached the library either, because the envelope is read before the store is touched',
      landedStray ? `${NAME_STRAY_KEY} is in /presets` : `${NAME_STRAY_KEY} is absent from /presets`);

    // ---- and the picker, on a look the apply refuses
    // `applyStoredPreset` refuses a document before it has written anything, so on a refusal
    // every look value on screen is still the previous preset's and the picker was the one
    // surface naming the refused one - the panel shows one look and the control names another.
    const appliedBefore = await page.evaluate('globalThis.__kinect.library.appliedPreset()');
    const pickedBefore = await page.evaluate("document.getElementById('tPreset').value");
    await page.route(`**/presets/${NAME_EDITED}`, (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        name: NAME_EDITED,
        rev: `sha256:${'ab'.repeat(32)}`,
        body: { version: PROJECT_VERSION, values: { pointSize: 'as big as it goes' } },
      }),
    }));
    await page.click('#tPreset');
    await page.waitForFunction("document.getElementById('tPresetList').hidden === false",
      null, { timeout: 10000 });
    await page.click(`#tPresetList .pickeroption[data-name=${JSON.stringify(NAME_EDITED)}]`);
    await page.waitForFunction(
      "document.getElementById('tNote')?.textContent?.includes('pointSize')",
      null, { timeout: 15000 },
    );
    await settle();
    await page.unroute(`**/presets/${NAME_EDITED}`);
    const refusedNote = await text('#tNote');
    const pickedAfter = await page.evaluate("document.getElementById('tPreset').value");
    const appliedAfter = await page.evaluate('globalThis.__kinect.library.appliedPreset()');
    check(/pointSize/.test(refusedNote),
      'a look the apply refuses says so by name, which is what makes the row below about the control rather than about a fetch that quietly worked',
      `"${refusedNote.slice(0, 110)}"`);
    check(pickedAfter === (appliedBefore?.name ?? ''),
      '  and the picker goes back to naming the look the clip is actually wearing, rather than the one that was refused',
      `picker read ${JSON.stringify(pickedBefore)} before, ${JSON.stringify(pickedAfter)} after, `
      + `clip on ${JSON.stringify(appliedAfter?.name ?? null)}`);
  } finally {
    // In a `finally` rather than after the last row, because a section that threw is exactly when
    // the library is most likely to be left with a fixture in it.
    await cleanupPresets();
  }

  console.log('\n[13] the note carries its whole sentence, a ruler tick seeks, and one project is a file two tabs can reach');
  {
    const OTHER = 'editor-check-other-footage';
    const putDoc = async (name, body) => {
      const res = await writeProjectDoc(name, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return res.json();
    };
    const dropDoc = (name) => writeProjectDoc(name, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});

    // Counted from here rather than from zero, because section 12 refuses two malformed presets on
    // purpose and both refusals reach the console.
    let errorsBefore = errors.length;
    // Waits for the open to have finished, not for the transport to exist: `timeline` is assigned
    // less than halfway through `openTake`, before the library is listed and before the crop is
    // fitted, and `settled()` does not close the gap because a transport with nothing queued is
    // idle in exactly that window.
    const reopen = async () => {
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction('globalThis.__kinect?.library?.opened() === true', null, { timeout: 30000 });
      await settle();
    };

    // ---- what a fresh open of this take actually gives
    // Read off a reopened page rather than off whatever twelve sections of edits left on screen,
    // because every document this block plants is built out of it.
    await reopen();
    const fresh = await page.evaluate('__kinect.keyframes.project()');
    const openHash = await page.evaluate('__kinect.library.takeHash()');
    const openId = await page.evaluate('__kinect.library.takeId()');
    check(typeof openHash === 'string' && openHash.length > 20,
      'the open take has a content hash, which is what a document\'s clips name their footage by',
      String(openHash).slice(0, 24));

    // A document cut on footage this machine has not got, for the loader row further down.
    const foreignHash = `sha256:${'0'.repeat(64)}`;
    const otherFootage = JSON.parse(JSON.stringify(fresh));
    otherFootage.clips[0].take = { id: 'some-other-take', hash: foreignHash };
    await putDoc(OTHER, otherFootage);

    await page.route('**/presets', (route) => route.fulfill({
      status: 500, contentType: 'application/json', body: '{"error":"the presets directory is not there"}',
    }));
    await reopen();
    const brokenNote = await page.evaluate("document.getElementById('tNote').textContent");
    await page.unroute('**/presets');
    check(/library unavailable/.test(brokenNote) && /presets/.test(brokenNote),
      'a presets list that refuses is reported by name rather than swallowed, so a page that came '
      + 'up missing half of what it needs says which half',
      `note "${brokenNote.slice(0, 100)}"`);
    await reopen();

    // The saved-project picker left with the timeline information bar and the recovery chip left
    // with the working document, and project UI exists again - a projects page, a rename modal and
    // a File menu that acts on the open document. So the claim is no longer "no fragment of any of
    // it remains": it is that what remains is reachable and what went is gone. `docs/proof-tools.md`
    // carries why the old assertion was written and what replaced it.
    const projectControls = await page.evaluate(`(() => {
      const at = (id) => document.getElementById(id);
      const box = (el) => (el ? el.getBoundingClientRect() : null);
      return {
        // The pair the old row named, plus the chip and its button: a picker in the strip and an
        // offer to restore a hidden document are the two shapes that were removed for good.
        gone: ['tProject', 'tProjectOpen', 'tResume', 'tResumeWhen', 'tResumeOpen']
          .filter((id) => at(id) !== null),
        // What replaced them, and the claim is reachability rather than presence: a menu item in
        // the document nobody can press is the unreachable fragment the old row was about.
        rename: (() => {
          const el = at('menuRenameProject');
          const r = box(el);
          return el === null ? null : { there: true, wide: r.width > 0 && r.height > 0, disabled: el.disabled };
        })(),
        duplicate: at('menuDuplicateProject') === null ? null : { there: true, disabled: at('menuDuplicateProject').disabled },
        modal: at('renameDialog') === null ? null : { there: true, open: at('renameDialog').open },
        // The banner is in the document and hidden, which is the state a page nobody has refused
        // is in - and it is what the rows below make appear.
        diverged: at('tDiverged') === null ? null : { there: true, hidden: at('tDiverged').hidden },
      };
    })()`);
    check(projectControls.gone.length === 0,
      'the saved-project picker and the recovery chip are gone rather than surviving as unreachable '
      + 'fragments, which is what the timeline information bar and the working document took with them',
      projectControls.gone.length ? `still in the document: ${projectControls.gone.join(', ')}` : 'none of the five');
    check(projectControls.rename?.there === true && projectControls.duplicate?.there === true
      && projectControls.modal?.there === true && projectControls.diverged?.hidden === true,
      'and the project controls that replaced them are here: Rename and Duplicate in the File menu, '
      + 'the modal a name is typed into, and the banner a refused write raises, hidden until one is',
      `rename ${JSON.stringify(projectControls.rename)}, duplicate ${JSON.stringify(projectControls.duplicate)}, `
      + `modal ${JSON.stringify(projectControls.modal)}, banner ${JSON.stringify(projectControls.diverged)}`);
    check(projectControls.rename?.disabled === true && projectControls.duplicate?.disabled === true,
      'and both are greyed on this page, because it was opened on a take and holds no document to '
      + 'act on - which is the same fact the rows below are about from the other side',
      `rename disabled ${projectControls.rename?.disabled}, duplicate ${projectControls.duplicate?.disabled}`);

    const foreignRefusal = await page.evaluate(`(async () => {
      try {
        await __kinect.library.loadProject(${JSON.stringify(OTHER)});
        return null;
      } catch (err) {
        return String(err);
      }
    })()`);
    check(/no take on this machine hashes it/.test(foreignRefusal ?? ''),
      'the project loader refuses a document whose clip names footage this machine has not got, naming the take',
      foreignRefusal ?? 'no refusal');
    // The presets refusal above deliberately produces the network error Chrome reports. The
    // remaining error sweep begins after it, so only failures the later gestures did not ask for
    // can redden that sweep.
    errorsBefore = errors.length;

    // ---- one file, two writers, and what the loser is left holding
    //
    // The subject this block used to have is deleted: there is no hidden working document and no
    // chip offering it back. What replaced it is the revision rule, and it needs a page that holds
    // a document - this one was opened on a take, so it has no file to auto-save into at all.
    //
    // The second page is opened in this run's own context and through `serveMutation`, because a
    // bare `newPage` takes the tree's own source and would put two builds inside one measurement.
    {
      const NAME = `editor-check-rev-${process.pid}`;
      const seed = JSON.parse(JSON.stringify(fresh));
      seed.clips = [seed.clips[0]];
      await putDoc(NAME, seed);

      const revErrors = [];
      const revPage = await page.context().newPage();
      revPage.on('pageerror', (err) => revErrors.push(String(err)));
      revPage.on('console', (msg) => { if (msg.type() === 'error') revErrors.push(msg.text()); });
      await revPage.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
      const revMutant = await serveMutation(revPage, EDITOR_PATH);
      await revPage.goto(`${URL_BASE}${EDITOR_PATH}?project=${encodeURIComponent(NAME)}`, { waitUntil: 'load' });
      await revPage.waitForFunction('!!globalThis.__kinect', null, { timeout: 30000 });
      await revPage.waitForFunction('globalThis.__kinect.takeOpened()', null, { timeout: 40000 });
      await revPage.evaluate('__kinect.timeline.settled()');
      // Read rather than asserted on: a page that took the tree's own build would make every row
      // below a measurement of the unmutated program under a mutated run's name.
      if (MUTATE && revMutant.served() === 0) {
        throw new Error(`${MUTATE} was staged for ${mutation.file} at ${revMutant.path} and the `
          + 'project page never requested it');
      }

      const storedOn = async (name) => (await fetch(`${URL_BASE}/projects/${encodeURIComponent(name)}`)).json();
      const pointSizeIn = (doc) => doc?.body?.clips?.[0]?.params?.pointSize ?? null;
      // Waits for the store to reach a value rather than for a fixed time, and gives up rather
      // than throwing: a row about a write that must not happen wants the same window spent and
      // then a reading, so both kinds of row here are written against one wait.
      const storeReaches = async (name, want, ms = 8000) => {
        const deadline = Date.now() + ms;
        let doc = await storedOn(name);
        while (pointSizeIn(doc) !== want && Date.now() < deadline) {
          await new Promise((done) => { setTimeout(done, 100); });
          doc = await storedOn(name);
        }
        return doc;
      };
      const commitTo = (value) => revPage.evaluate(`(() => {
        const k = globalThis.__kinect;
        k.params.set('pointSize', ${value});
        return k.keyframes.undo.commit();
      })()`);
      const bannerState = () => revPage.evaluate(`(() => {
        const el = document.getElementById('tDiverged');
        return {
          shown: !el.hidden && el.getBoundingClientRect().width > 0,
          title: el.title,
          when: document.getElementById('tDivergedWhen').textContent,
          copy: !document.getElementById('tDivergedCopy').disabled,
          note: document.getElementById('tNote').textContent,
        };
      })()`);
      // The falsification control, and it comes first because every row below it is about a write
      // being refused: on a build that never writes at all, a refusal is indistinguishable from
      // silence and the whole block passes.
      await commitTo(31.5);
      const wrote = await storeReaches(NAME, 31.5);
      check(pointSizeIn(wrote) === 31.5,
        'a commit on a page opened on a project writes that project, which is what makes every '
        + 'refusal below an absence rather than a build that was never writing',
        `stored pointSize ${pointSizeIn(wrote)}`);

      // Two commits inside one page-side task, so the second is queued behind a write whose answer
      // has not arrived. The revision has to be read inside the queued task or the second names the
      // one the first replaced and is refused against its own predecessor.
      await revPage.evaluate(`(() => {
        const k = globalThis.__kinect;
        k.params.set('pointSize', 32.5);
        k.keyframes.undo.commit();
        k.params.set('pointSize', 33.5);
        k.keyframes.undo.commit();
      })()`);
      const burst = await storeReaches(NAME, 33.5);
      const afterBurst = await bannerState();
      check(pointSizeIn(burst) === 33.5,
        'and two commits in one burst both land, because the revision each write carries is read '
        + 'inside the queue rather than at the call - where both would name the one the first replaced',
        `stored pointSize ${pointSizeIn(burst)} against the second commit's 33.5`);
      check(!afterBurst.shown,
        'and nothing was refused, so the banner stays down over a tab that is the only writer',
        afterBurst.shown ? `banner up saying "${afterBurst.title}"` : 'banner down');

      // ---- the second writer, which is what a projects page makes ordinary
      const held = await storedOn(NAME);
      const elsewhere = JSON.parse(JSON.stringify(held.body));
      elsewhere.clips[0].params.pointSize = 61.5;
      const moved = await writeProjectDoc(NAME, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(elsewhere),
      }).then((res) => res.json());
      check(moved.rev !== undefined && moved.rev !== held.rev,
        'somebody else writes the same project and the file moves, which is the state this tab is '
        + 'about to write into rather than a refusal staged by hand',
        `${String(held.rev).slice(7, 19)} to ${String(moved.rev).slice(7, 19)}`);

      let writesAfter = 0;
      await revPage.route(`**/projects/${NAME}*`, async (route) => {
        if (route.request().method() === 'PUT') writesAfter++;
        await route.continue();
      });
      await commitTo(41.5);
      // A shorter window than the rows above, because this one is waiting for a write that must
      // not land: it is spent and then read either way, and the value it waits for never arrives.
      const afterRefusal = await storeReaches(NAME, 41.5, 3000);
      const refusedState = await bannerState();
      check(refusedState.shown,
        'this tab\'s next change is refused and the banner is up, and it is standing rather than '
        + 'said once - the tab has stopped, so a sentence that scrolled away is silent data loss',
        refusedState.shown ? `"${refusedState.when}"` : 'nothing on screen');
      check(refusedState.title !== '' && !/auto-save failed/i.test(`${refusedState.title} ${refusedState.when} ${refusedState.note}`),
        'and it carries the store\'s own sentence rather than the words auto-save failed, because a '
        + 'refused write means somebody else has this project open',
        `title ${JSON.stringify(refusedState.title.slice(0, 90))}`);
      check(pointSizeIn(afterRefusal) === 61.5,
        'and the file still holds what the other writer put there, so the refusal kept their work '
        + 'rather than this tab\'s last read of it',
        `stored pointSize ${pointSizeIn(afterRefusal)}`);

      const keptOnScreen = await revPage.evaluate(`(() => {
        const k = globalThis.__kinect;
        const now = k.params.get('pointSize');
        const popped = k.keyframes.undo.pop();
        return { now, popped, back: k.params.get('pointSize') };
      })()`);
      check(keptOnScreen.now === 41.5 && keptOnScreen.popped === true && keptOnScreen.back === 33.5,
        'while the change that was refused is still on screen and still undoable, which is the loser '
        + 'keeping its work rather than being rolled back to what the file holds',
        `on screen ${keptOnScreen.now}, undo returned ${keptOnScreen.popped} and left ${keptOnScreen.back}`);

      const writesBeforeStop = writesAfter;
      await commitTo(42.5);
      await storeReaches(NAME, 42.5, 3000);
      check(writesAfter === writesBeforeStop,
        'and it has stopped writing rather than retrying, because the other tab holds the revision '
        + 'this one is at and a retry carrying it can never land',
        `${writesAfter - writesBeforeStop} write(s) went out after the refusal`);

      // ---- Duplicate is the one-click recovery, and it is in the banner rather than two clicks away
      const namesBefore = await revPage.evaluate('(async () => ((await (await fetch("/projects/all")).json()).projects ?? []).map((d) => d.name))()');
      await revPage.locator('#tDivergedCopy').click();
      await revPage.waitForFunction('document.getElementById("tDiverged").hidden === true', null, { timeout: 20000 })
        .catch(() => { /* the row below says so */ });
      const recovered = await bannerState();
      const namesAfter = await revPage.evaluate('(async () => ((await (await fetch("/projects/all")).json()).projects ?? []).map((d) => d.name))()');
      const minted = namesAfter.filter((n) => !namesBefore.includes(n));
      check(!recovered.shown && minted.length === 1,
        'pressing Duplicate on the banner mints a copy and clears it, which always succeeds because '
        + 'a create names no revision anybody else can have moved',
        `banner ${recovered.shown ? 'still up' : 'down'}, minted ${JSON.stringify(minted)}`);
      const copy = minted.length === 1 ? await storeReaches(minted[0], 42.5) : null;
      check(pointSizeIn(copy) === 42.5,
        'and the copy carries the work the refusal would otherwise have stranded, including the '
        + 'change made after this tab had stopped writing',
        `copy holds ${pointSizeIn(copy)} against the 42.5 on screen`);
      await commitTo(43.5);
      const copyAgain = minted.length === 1 ? await storeReaches(minted[0], 43.5) : null;
      check(pointSizeIn(copyAgain) === 43.5,
        'and the tab is writing again, into the copy rather than into the file it was refused',
        `copy holds ${pointSizeIn(copyAgain)}`);
      const original = await storedOn(NAME);
      check(pointSizeIn(original) === 61.5,
        'while the original is untouched and still holds the other writer\'s work',
        `original holds ${pointSizeIn(original)}`);

      // ---- Rename, which is the other half of what survived `Save project`
      // Driven here rather than credited to section 1: the modal needs a page that holds a
      // document, and the page section 1 walks was opened on a take, where the item is greyed. A
      // rule claiming a dialog the tool never opens is a credit nobody joined to a press.
      const renamed = `${minted[0]} renamed`;
      await revPage.locator('#fileMenuButton').click();
      await revPage.locator('#menuRenameProject').click();
      const modalOpen = await revPage.evaluate(`(() => ({
        open: document.getElementById('renameDialog').open,
        holds: document.getElementById('renameName').value,
        go: !document.getElementById('renameGo').disabled,
        note: document.getElementById('renameNote').textContent,
      }))()`);
      check(modalOpen.open && modalOpen.holds === minted[0],
        'Rename opens a modal holding the name the project is under, because a name is typed and '
        + 'the one to change is the one it has',
        `open ${modalOpen.open}, holds "${modalOpen.holds}" against "${minted[0]}"`);
      // The refusal is said while it is being typed rather than after the press, and the same
      // name back is one of the two things it refuses.
      await revPage.evaluate(`(() => {
        const el = document.getElementById('renameName');
        el.value = ${JSON.stringify(minted[0])};
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      const sameName = await revPage.evaluate(`(() => ({
        go: document.getElementById('renameGo').disabled,
        note: document.getElementById('renameNote').textContent,
      }))()`);
      check(sameName.go === true && /already its name/.test(sameName.note),
        'and typing the name it already has is refused while it is typed rather than after the press',
        `go ${sameName.go ? 'disabled' : 'enabled'}, "${sameName.note}"`);
      await revPage.evaluate(`(() => {
        const el = document.getElementById('renameName');
        el.value = ${JSON.stringify(renamed)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await revPage.locator('#renameGo').click();
      await revPage.waitForFunction((want) => new URL(location.href).searchParams.get('project') === want,
        renamed, { timeout: 20000 }).catch(() => { /* the row below says so */ });
      const afterRename = await revPage.evaluate('(async () => ((await (await fetch("/projects/all")).json()).projects ?? []).map((d) => d.name))()');
      check(new URL(revPage.url()).searchParams.get('project') === renamed
        && afterRename.includes(renamed) && !afterRename.includes(minted[0]),
        'and the rename moves the file and the URL together, so the page it would be reopened at '
        + 'is the name it is now under rather than one nothing answers to',
        `${revPage.url()} - the store holds ${JSON.stringify(afterRename)}`);
      // The rename goes through the same queue as the auto-save, so the write after it has to
      // land under the new name at the revision the rename handed back.
      await commitTo(44.5);
      const afterRenameDoc = await storeReaches(renamed, 44.5);
      check(pointSizeIn(afterRenameDoc) === 44.5,
        'and the auto-save follows it: the next change lands under the new name at the revision '
        + 'the rename answered with, rather than against the file it just moved',
        `${renamed} holds ${pointSizeIn(afterRenameDoc)}`);
      // The refused write is a 409 and Chrome reports it, so this block plants an entry in the
      // channel its own sweep reads. It is drained rather than filtered out, and the drain
      // asserts: a filter would go on covering whatever the page said next that happened to
      // match, and a build that stopped refusing would take the exemption with it in silence.
      const conflicts = revErrors.filter((e) => /409|Conflict/.test(String(e)));
      const rest = revErrors.filter((e) => !/409|Conflict/.test(String(e)));
      check(conflicts.length === 1,
        'exactly one refusal reached the console, which is the write this block provoked and not '
        + 'a tab that went on retrying into a file it cannot have',
        `${conflicts.length} drained: ${conflicts.map((e) => String(e).slice(0, 60)).join(' | ') || 'nothing'}`);
      check(rest.length === 0,
        'and the project page raised no other page error across any of it',
        rest.slice(0, 2).join(' | '));

      await revPage.close();
      // The renamed copy and not the name it was minted under: a cleanup that names the old one
      // leaves a document behind for whoever reads this store next.
      for (const name of [NAME, renamed]) await dropDoc(name);
    }
    await dropDoc(OTHER);

    // ---- the ruler's marks are controls
    // Under a non-unity rate, and that is what makes these rows able to fail: a mark is stored in
    // source milliseconds and drawn in program seconds, and at rate 1 with no keys the two are
    // the same number.
    const RATE = 0.5;
    const MARKS = [
      { id: 'em0', sourceMs: 1000, label: 'first' },
      { id: 'em1', sourceMs: 3000, label: 'second' },
      { id: 'em2', sourceMs: 5000, label: 'third' },
    ];
    await page.evaluate('(__kinect.keyframes.setSourceStart(0), __kinect.keyframes.setSpeed(1))');
    await page.evaluate(`(() => {
      const el = document.getElementById('tRate');
      el.value = String(__kinect.editor.rateSlider.toValue(${RATE}));
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await focusStage();
    await settle();
    await page.evaluate(`__kinect.editor.setMarks(${JSON.stringify(MARKS)})`);
    await page.evaluate('__kinect.editor.view.fit()');
    await settle();

    const geometry = await page.evaluate(`(() => {
      const total = __kinect.editor.view.window().duration;
      return {
        rate: __kinect.timeline.read().speed,
        total,
        program: ${JSON.stringify(MARKS)}.map((m) => Math.max(0, Math.min(total,
          __kinect.editor.markProgramSec(m.sourceMs / 1000)))),
        source: ${JSON.stringify(MARKS)}.map((m) => m.sourceMs / 1000),
        ticks: __kinect.library.markTicks().length,
      };
    })()`);
    const TOL = 0.08;
    const separated = geometry.program
      .map((p, i) => Math.abs(p - geometry.source[i]))
      .filter((d) => d > TOL * 4);
    check(geometry.rate !== 1 && separated.length >= 2,
      'the fixture runs at a rate where a mark\'s program second and its source second are different numbers, or nothing below can fail',
      `rate ${geometry.rate}, program ${geometry.program.map((p) => p.toFixed(2)).join('/')}`
      + ` against source ${geometry.source.map((s) => s.toFixed(2)).join('/')}`);
    check(geometry.ticks === MARKS.length, 'every mark drew a tick on the ruler', `${geometry.ticks} ticks`);

    await page.evaluate('__kinect.timeline.transport().seek(0)');
    await settle();
    await page.locator('#tMarks .tmk').nth(1).click();
    await settle();
    const pressed = (await read()).programSec;
    check(near(pressed, geometry.program[1], TOL),
      'pressing a mark tick parks the playhead on the program second the tick is drawn at',
      `playhead ${pressed.toFixed(3)}s against the tick's ${geometry.program[1].toFixed(3)}s`
      + ` (the source second is ${geometry.source[1].toFixed(3)}s)`);
    check(!near(pressed, geometry.source[1], TOL),
      'and not on the mark\'s own source second, which would ignore its clip timing',
      `${pressed.toFixed(3)}s against ${geometry.source[1].toFixed(3)}s`);

    await page.evaluate('__kinect.timeline.transport().seek(0)');
    await settle();
    await focusStage();
    await page.keyboard.press(']');
    await settle();
    const forward = (await read()).programSec;
    check(near(forward, geometry.program[0], TOL),
      'the next-mark key jumps to the first mark ahead of the playhead',
      `${forward.toFixed(3)}s against ${geometry.program[0].toFixed(3)}s`);
    await page.keyboard.press(']');
    await settle();
    const forwardAgain = (await read()).programSec;
    check(near(forwardAgain, geometry.program[1], TOL),
      'and pressing it again steps to the next one rather than finding the mark it is standing on',
      `${forwardAgain.toFixed(3)}s against ${geometry.program[1].toFixed(3)}s`);
    await page.keyboard.press('[');
    await settle();
    const back = (await read()).programSec;
    check(near(back, geometry.program[0], TOL),
      'and the previous-mark key walks back the way it came',
      `${back.toFixed(3)}s against ${geometry.program[0].toFixed(3)}s`);

    // And the layouts those two keys are actually typed on: `[` and `]` are unmodified only on a
    // US or UK keyboard, and Windows delivers AltGr by setting ctrl and alt together, so the
    // guard that rejects command modifiers rejected the character as well.
    const pressComposed = async (key, altGraph) => {
      await page.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', {
        key: ${JSON.stringify(key)}, ctrlKey: true, altKey: true,
        modifierAltGraph: ${altGraph}, bubbles: true, cancelable: true,
      }))`);
      await settle();
      return (await read()).programSec;
    };
    await page.evaluate('__kinect.timeline.transport().seek(0)');
    await settle();
    await focusStage();
    const altGr = await pressComposed(']', true);
    check(near(altGr, geometry.program[0], TOL),
      'the next-mark key works when it is typed with AltGr, which is how a German, Nordic or Polish keyboard types it at all',
      `${altGr.toFixed(3)}s against ${geometry.program[0].toFixed(3)}s`);
    const plainCtrlAlt = await pressComposed(']', false);
    check(near(plainCtrlAlt, altGr, TOL),
      'and the same two bits without AltGraph behind them move nothing, so the guard still hands ctrl+alt to the browser it belongs to',
      `${plainCtrlAlt.toFixed(3)}s, unmoved from ${altGr.toFixed(3)}s`);
    const altGrArrow = await page.evaluate(`(() => {
      const before = __kinect.timeline.transport().programSec;
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'ArrowRight', ctrlKey: true, altKey: true, modifierAltGraph: true,
        bubbles: true, cancelable: true,
      }));
      return before;
    })()`);
    await settle();
    check(near((await read()).programSec, altGrArrow, TOL),
      'and a named key under the same modifier is still the browser\'s, since AltGr only composes characters and there is no character here',
      `${(await read()).programSec.toFixed(3)}s against ${altGrArrow.toFixed(3)}s`);

    // And a trimmed clip, which is the case every row above is blind to: on the whole take
    // `Transport.frameAt`'s clamp into in..out cannot change where a press lands, so a key
    // offering marks outside the trim looked identical to one that did not.
    await page.evaluate(`__kinect.editor.setMarks([
      { id: 'outside', sourceMs: 2000, label: 'outside' },
      { id: 'inside', sourceMs: 8000, label: 'inside' },
    ])`);
    await settle();
    // Where the trim goes is derived from where the marks landed, never assumed: this section
    // runs at a rate where a mark's program second and its source second are different numbers,
    // so a trim written as two constants put both marks on the same side of it.
    const trim = await page.evaluate(`(() => {
      const window0 = __kinect.editor.view.window();
      const total = window0.duration;
      const at = (s) => Math.max(0, Math.min(total, __kinect.editor.markProgramSec(s)));
      const outside = at(2);
      const inside = at(8);
      const inAt = (outside + inside) / 2;
      // **The out point goes a distance on screen past the kept mark rather than a fixed
      // second past it.** The out cut's grab zone reaches 12px to the left of its line and
      // sits two stacking levels above the marks, so a second is far enough only while a
      // second is wide. On a 75s take at rate 0.5 the program is 151s across the bed and
      // one second is about six pixels, which put the out handle on top of the very tick
      // the rows below have to press: the click retried for thirty seconds and took the
      // run down as DID NOT RUN at 347 assertions, against a build with nothing wrong
      // with it. Thirty-two pixels is twice the handle's reach, computed from the window
      // actually on screen rather than assumed from the take.
      const perPx = window0.spanSec / Math.max(1, document.getElementById('tBed').getBoundingClientRect().width);
      const clearOfTheHandle = Math.max(1, 32 * perPx);
      return {
        total, outside, inside, inAt, clearOfTheHandle,
        park: (inAt + inside) / 2,
        outAt: Math.min(total, inside + clearOfTheHandle),
      };
    })()`);
    await page.evaluate(`__kinect.timeline.transport().seek(${trim.inAt})`);
    await settle();
    await focusStage();
    await page.keyboard.press('i');
    await page.evaluate(`__kinect.timeline.transport().seek(${trim.outAt})`);
    await settle();
    await page.keyboard.press('o');
    await settle();
    const trimmed = await page.evaluate('({ in: __kinect.timeline.transport().clipInSec, out: __kinect.timeline.transport().clipOutSec })');
    const marksNow = await page.evaluate('__kinect.library.markTicks().length');
    check(marksNow === 2 && trim.outside < trimmed.in - TOL && trimmed.in < trim.park
      && trim.park < trim.inside - TOL && trim.inside < trimmed.out + TOL,
      'the clip is trimmed with one mark outside it and one inside, and the playhead parks between the in point and the mark it keeps - which is the arrangement the clamp can be seen through',
      `outside ${trim.outside.toFixed(2)}s | in ${trimmed.in?.toFixed(2)}s | park ${trim.park.toFixed(2)}s`
      + ` | inside ${trim.inside.toFixed(2)}s | out ${trimmed.out?.toFixed(2)}s, ${marksNow} ticks`);
    // Both ticks are hit-tested before anything below aims at one: `locator.click` waits for the
    // element to become clickable, retries for thirty seconds and then takes the whole run
    // down as DID NOT RUN.
    const tickCover = await page.evaluate(`(() => {
      return [...document.querySelectorAll('#tMarks .tmk')].map((tick) => {
        const r = tick.getBoundingClientRect();
        const at = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return {
          title: tick.title,
          clear: at === tick || tick.contains(at),
          over: at ? (at.id ? '#' + at.id : at.tagName.toLowerCase() + '.' + at.className) : 'nothing',
        };
      });
    })()`);
    const covered = tickCover.filter((t) => !t.clear);
    check(tickCover.length === 2 && covered.length === 0,
      'and a pointer reaches both of them, so a tick with the out handle drawn over it is a red row rather than a timeout that ends the run',
      covered.length
        ? covered.map((t) => `"${t.title}" is under ${t.over}`).join('; ')
        : `${tickCover.length} ticks, ${trim.clearOfTheHandle.toFixed(2)}s of program between the kept mark and the out point`);
    await page.evaluate(`__kinect.timeline.transport().seek(${trim.park})`);
    await settle();
    await focusStage();
    await page.keyboard.press('[');
    await settle();
    const backFromPark = (await read()).programSec;
    check(near(backFromPark, trim.park, TOL),
      'stepping back from inside the trim past a mark the trim excludes moves nothing at all, rather than throwing the playhead onto the in point it can never get past',
      `${backFromPark.toFixed(3)}s, parked at ${trim.park.toFixed(3)}s with the in point at ${trimmed.in?.toFixed(2)}s`);
    await page.keyboard.press(']');
    await settle();
    const forwardInTrim = (await read()).programSec;
    check(near(forwardInTrim, trim.inside, TOL),
      'and the key is working while it declines, because the same press forward still reaches the mark the trim does keep',
      `${forwardInTrim.toFixed(3)}s against the kept mark at ${trim.inside.toFixed(3)}s`);

    // The same rule, pressed rather than typed: the keys were taught to refuse a mark the trim
    // excludes and the ruler's own ticks were not, so the diamond drawn inside the shading still
    // seeked and the seek was clamped to the boundary.
    const outsideTickIndex = await page.evaluate(`(() => {
      const ticks = globalThis.__kinect.library.markTicks();
      const lefts = ticks.map((t) => t.left);
      return lefts.indexOf(Math.min(...lefts));
    })()`);
    await page.evaluate(`__kinect.timeline.transport().seek(${trim.park})`);
    await settle();
    await page.locator('#tMarks .tmk').nth(outsideTickIndex).click();
    await settle();
    const afterClickingOutside = (await read()).programSec;
    const noteAfter = await page.evaluate("document.getElementById('tNote').textContent");
    check(near(afterClickingOutside, trim.park, TOL),
      'pressing a tick the trim excludes moves the playhead nowhere, rather than seeking to a boundary the diamond is not drawn at',
      `${afterClickingOutside.toFixed(3)}s, parked at ${trim.park.toFixed(3)}s with the in point at ${trimmed.in?.toFixed(2)}s`);
    check(/outside the clip range/.test(noteAfter),
      'and it says so, because a key stepping past nothing has nothing to report while a diamond somebody aimed at does',
      `note "${noteAfter.slice(0, 80)}"`);
    const insideTickIndex = await page.evaluate(`(() => {
      const ticks = globalThis.__kinect.library.markTicks();
      const lefts = ticks.map((t) => t.left);
      return lefts.indexOf(Math.max(...lefts));
    })()`);
    await page.evaluate(`__kinect.timeline.transport().seek(${trim.park})`);
    await settle();
    await page.locator('#tMarks .tmk').nth(insideTickIndex).click();
    await settle();
    const afterClickingInside = (await read()).programSec;
    check(near(afterClickingInside, trim.inside, TOL),
      'and the tick the trim keeps still seeks to itself, so the refusal above is about reachability rather than about a ruler that stopped working',
      `${afterClickingInside.toFixed(3)}s against the kept mark at ${trim.inside.toFixed(3)}s`);

    await page.evaluate(`__kinect.editor.setMarks([
      { id: 'ordinary', sourceMs: 3000, label: 'ordinary' },
      { id: 'past', sourceMs: 9000000, label: 'past the end' },
    ])`);
    await settle();
    const ticks = await page.evaluate('__kinect.library.markTicks()');
    check(ticks.length === 2 && ticks.some((t) => t.beyond) && ticks.some((t) => !t.beyond),
      'one tick is a beyond mark and one is ordinary, so the two rows below are a comparison rather than two readings of the same thing',
      ticks.map((t) => (t.beyond ? 'beyond' : 'ordinary')).join(' '));
    // Focus arrives by Tab rather than by `.focus()`, because `:focus-visible` is a claim about
    // how focus got there and a programmatic focus does not match it in Chromium.
    const focusColours = async (selector) => page.evaluate(`(async () => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const rest = getComputedStyle(el).color;
      return { rest, el: Boolean(el) };
    })()`);
    const beforeFocus = await focusColours('#tMarks .tmk.beyond');
    await page.evaluate("document.querySelector('#tMarks .tmk:not(.beyond)').focus()");
    await page.keyboard.press('Tab');
    const focused = await page.evaluate(`(() => {
      const el = document.activeElement;
      return {
        isBeyond: el?.classList?.contains('beyond') ?? false,
        visible: el?.matches(':focus-visible') ?? false,
        colour: el ? getComputedStyle(el).color : null,
        outline: el ? getComputedStyle(el).outlineStyle : null,
      };
    })()`);
    check(focused.isBeyond && focused.visible,
      'tabbing off the ordinary tick lands keyboard focus on the beyond one, which is what makes the row below about the colour rather than about where focus went',
      `beyond ${focused.isBeyond}, :focus-visible ${focused.visible}`);
    check(focused.colour !== beforeFocus.rest,
      'and a focused beyond mark looks different from a resting one - the outline is off on the grounds that the colour says it instead, so the colour has to say it',
      `resting ${beforeFocus.rest}, focused ${focused.colour}, outline ${focused.outline}`);

    const legend = await page.evaluate('__kinect.editor.shortcuts()');
    check(/\[\/\]/.test(legend),
      'and the ? legend describes the whole keyboard, including the two keys this section added',
      legend.slice(-90));

    check(errors.length === errorsBefore, 'none of it raises a page error',
      errors.slice(errorsBefore, errorsBefore + 2).join(' | '));

    // ---- a take that fails to open writes nothing anywhere
    // This used to be about the recovery slot, which is deleted: there is no hidden name for a
    // failed open to spend. The live half of the claim survives and is stronger without it - the
    // page is deliberately still standing, `openTake` threw, `history.baseline` is still null
    // because `begin()` is the last thing the open does, and a page holding no document has no
    // file to write into at all. So the store is read whole rather than one name being watched.
    const storeBefore = await (await fetch(`${URL_BASE}/projects/all`)).json();
    await page.goto(`${URL_BASE}${EDITOR_PATH}?take=take-that-does-not-exist`, { waitUntil: 'load' });
    // Waited for by the state that decides, not by a timeout: the open has to have got far enough
    // to have failed, and `takeOpened` reading false on a page that has not started yet
    // is the same false.
    await page.waitForFunction(
      "document.getElementById('tNote')?.textContent?.includes('take-that-does-not-exist')",
      null, { timeout: 30000 }).catch(() => {});
    await page.locator('#panelTabFraming').click();
    const failedOpen = await page.evaluate(`(() => ({
      opened: __kinect.takeOpened(),
      depth: __kinect.undoDepth(),
      note: document.getElementById('tNote')?.textContent ?? '',
      panel: getComputedStyle(document.getElementById('panel')).display,
      crop: (() => { const el = document.getElementById('crop');
        return el ? { there: true, disabled: el.disabled, visible: el.offsetParent !== null } : { there: false }; })(),
    }))()`);
    check(!failedOpen.opened && /take-that-does-not-exist/.test(failedOpen.note),
      'a take that does not exist fails to open and the page says so rather than going dark',
      `opened ${failedOpen.opened}, note "${failedOpen.note.slice(0, 80)}"`);
    check(failedOpen.panel !== 'none' && failedOpen.crop.there
      && !failedOpen.crop.disabled && failedOpen.crop.visible,
      'and the inspector is still drawn with its controls live, so there is genuinely a press to make',
      `panel ${failedOpen.panel}, crop ${JSON.stringify(failedOpen.crop)}`);

    await page.click('#crop');
    // The auto-save is fire-and-forget, so the write it would make is a round trip away from the
    // press: the window is spent before the store is read, or an absence is only a reading of how
    // fast this file asked.
    await new Promise((done) => { setTimeout(done, 1500); });
    const storeAfter = await (await fetch(`${URL_BASE}/projects/all`)).json();
    const nameRev = (listing) => (listing.projects ?? []).map((d) => `${d.name}=${String(d.rev).slice(7, 15)}`).sort().join(' ');
    check(await page.evaluate('__kinect.undoDepth()') === 0,
      'a press on a live control of a take that never opened is not recorded as an edit, because there is no baseline for it to be an edit against',
      `undo depth ${await page.evaluate('__kinect.undoDepth()')}`);
    check(nameRev(storeAfter) === nameRev(storeBefore),
      'and it wrote nothing anywhere: a page whose open failed holds no document, so there is no '
      + 'file for the press to reach and no hidden name for it to invent one under',
      nameRev(storeAfter) === nameRev(storeBefore)
        ? `${(storeAfter.projects ?? []).length} project(s), none of them moved`
        : `${nameRev(storeBefore)} became ${nameRev(storeAfter)}`);
    // Back onto the take the rest of this run is about. `reopen` reloads whatever is in the address
    // bar, which is the take that does not exist, so this is a `goto`.
    await page.goto(`${URL_BASE}${EDITOR_PATH}?take=${encodeURIComponent(TAKE)}`, { waitUntil: 'load' });
    await page.waitForFunction('globalThis.__kinect?.library?.opened() === true', null, { timeout: 30000 });
    await settle();

    const mine = errors.slice(errorsBefore);
    check(mine.length > 0 && mine.every((e) => /take-that-does-not-exist|404/.test(String(e))),
      'and every error this block raised is the refusal it went looking for, rather than something it broke on the way',
      `${mine.length}: ${mine.slice(0, 2).join(' | ')}`);
  }


  console.log('\n[14] resizing the stage while the playhead is parked leaves a picture on it');

  // `resize()` reallocates the drawing buffer, which clears it, and a parked editor has no clock
  // that would draw into it again: `tickNow` returns immediately on `!playing` and
  // `pumpParkedDraft` returns with nothing armed.
  {
    await page.evaluate('__kinect.keyframes.chrome.set(false)');
    await page.evaluate('__kinect.timeline.transport().pause()');
    await page.evaluate('__kinect.timeline.transport().seek(12)');
    // The picture this section counts is put there rather than inherited, and pressing "sensor
    // view" is how: it poses the camera at the sensor's own origin with a frustum fitted to its
    // rectangle, so the whole cloud is in frame by construction.
    await page.locator('#panelTabFraming').click();
    await page.locator('#camSensor').click();
    await settle();
    await new Promise((r) => setTimeout(r, 150));
    const density = async () => {
      const box = await page.locator('#stage').boundingBox();
      const n = await lit();
      return { all: n.all, per: n.all / Math.max(1, box.width * box.height), box };
    };
    // Waited on rather than slept through: `setViewportSize` returns before the page's own
    // `resize` listener has run, so a `settled()` that arrives first finds nothing scheduled and
    // reports an idle page one macrotask before the work starts.
    const throughResize = async (label, act) => {
      const was = await page.evaluate('__kinect.editor.stageResizes()');
      await act();
      await page.waitForFunction(`__kinect.editor.stageResizes() > ${was}`, null, { timeout: 15000 })
        .catch(() => { throw new Error(`${label} never reached resize()`); });
      await settle();
      await new Promise((r) => setTimeout(r, 150));
    };

    // The bar is set from measurement and set low on purpose: the blank build measures exactly
    // 0.00%, so what the threshold is for is that a section arriving on an empty view reports the
    // absence as its own precondition failing.
    const beforeResize = await density();
    check(beforeResize.per > 0.001,
      'the parked stage carries a picture before anything resizes, or nothing below is about a resize',
      `${beforeResize.all} lit pixels at ${(beforeResize.per * 100).toFixed(2)}% of `
      + `${Math.round(beforeResize.box.width)}x${Math.round(beforeResize.box.height)}, `
      + `on the ${await page.evaluate('__kinect.viewCamera() === __kinect.freeCamera ? "free" : "program"')} camera`);

    // The premise the repaint's guard rests on, asserted rather than trusted: `resize()` only
    // asks for the picture back when the drawing buffer's size actually moved, and that is only
    // safe while a same-size `setSize` reallocates nothing - a fact about `WebGLRenderTarget` and
    // Chrome's canvas rather than about this build.
    const bufferOf = () => page.evaluate(`(() => {
      const gl = __kinect.renderer.getContext();
      return { w: gl.drawingBufferWidth, h: gl.drawingBufferHeight, resizes: __kinect.editor.stageResizes() };
    })()`);
    const bufBefore = await bufferOf();
    await page.evaluate('window.dispatchEvent(new Event("resize"))');
    await settle();
    await new Promise((r) => setTimeout(r, 150));
    const bufSame = await bufferOf();
    const sameSize = await density();
    check(bufSame.resizes > bufBefore.resizes && bufSame.w === bufBefore.w && bufSame.h === bufBefore.h
      && sameSize.all === beforeResize.all,
      '  and a resize that reallocates nothing leaves it alone, which is what lets the repaint be conditional',
      `${bufSame.resizes - bufBefore.resizes} resizes, buffer ${bufBefore.w}x${bufBefore.h} -> `
      + `${bufSame.w}x${bufSame.h}, lit ${beforeResize.all} -> ${sameSize.all}`);

    await throughResize('the window resize', () => page.setViewportSize({
      width: VIEWPORT.width - 220, height: VIEWPORT.height - 120,
    }));
    const afterWindow = await density();
    check(afterWindow.per > beforeResize.per * 0.5,
      'a window resize with the playhead parked leaves the stage drawn rather than blank',
      `${afterWindow.all} lit pixels at ${(afterWindow.per * 100).toFixed(2)}% density `
      + `against ${beforeResize.all} at ${(beforeResize.per * 100).toFixed(2)}%`);
    await throughResize('the window restore', () => page.setViewportSize(VIEWPORT));

    // The render-scale slider is the subtle half: it is tagged `view`, and `paramWritten`
    // deliberately withholds the repaint every other parameter gets, so the registry's single
    // write path ran `apply`, destroyed the buffer, and then took the early return.
    const scaleWas = await page.evaluate("__kinect.params.get('renderScale')");
    await throughResize('the render-scale write', () => page.evaluate("__kinect.params.set('renderScale', 130)"));
    const afterScale = await density();
    check(afterScale.per > beforeResize.per * 0.5,
      '  and so does a render-scale write, which is the one door that asks for no repaint of its own',
      `${afterScale.all} lit pixels at ${(afterScale.per * 100).toFixed(2)}% density, render % 130`);
    await throughResize('the render-scale restore',
      () => page.evaluate(`__kinect.params.set('renderScale', ${scaleWas})`));
    const restored = await density();
    check(restored.per > beforeResize.per * 0.5,
      '  and the stage the next section inherits is a drawn one',
      `${restored.all} lit pixels at ${(restored.per * 100).toFixed(2)}%, render % back to ${scaleWas}`);
  }

  console.log('\n[15] a project is refused a track on a parameter it must not carry');

  // The writer filtered the track set and the reader did not: `serialiseProjectBody` writes
  // `params.names('look').filter(...)`, while `restoreProject` called `params.spec(name)` purely
  // for its throw-on-unknown side effect and discarded the spec it got back.
  {
    const original = await page.evaluate('JSON.stringify(__kinect.library.serialiseProjectBody())');
    // The keys are a parameter rather than a literal because the shape that walked past both
    // refusals is an empty track, and a helper that can only plant a populated one
    // cannot ask about it.
    const handTo = (name, keys = [{ t: 0, value: 100 }, { t: 4, value: 140 }]) => page.evaluate(`(() => {
      const body = JSON.parse(${JSON.stringify(original)});
      body.look.tracks[${JSON.stringify(name)}] = ${JSON.stringify(keys)};
      try {
        __kinect.library.restoreProject(body);
        return { threw: false, message: null };
      } catch (err) {
        return { threw: true, message: String(err?.message ?? err) };
      }
    })()`);
    const viewTrack = await handTo('renderScale');
    check(viewTrack.threw && /view/.test(viewTrack.message ?? ''),
      'a project carrying a track on a view parameter is refused, and the refusal names the tag',
      viewTrack.threw ? `"${viewTrack.message}"` : 'it was accepted');
    const look = await handTo('bloom');
    check(!look.threw, '  and one on a look parameter still loads, which is the shape the serialiser writes',
      look.threw ? `"${look.message}"` : 'accepted');
    // The same document with no keys in it, which is the shape that walked past both refusals:
    // `restoreProject` skipped an empty track before it asked the two questions, and
    // `serialiseProjectBody` filters the entry back out on the next commit - so the document
    // stopped saying what it said when it was opened, through the one shape with no edit in it
    // to notice missing.
    const emptyView = await handTo('renderScale', []);
    check(emptyView.threw && /view/.test(emptyView.message ?? ''),
      '  and an empty track on a view parameter is refused too, rather than skipped for being cheap to skip',
      emptyView.threw ? `"${emptyView.message}"` : 'it was accepted');
    const emptyUnknown = await handTo('notAParameterThisBuildKnows', []);
    check(emptyUnknown.threw,
      '  and so is an empty one under a name the registry has never heard of',
      emptyUnknown.threw ? `"${emptyUnknown.message}"` : 'it was accepted');
    const emptyLook = await handTo('bloom', []);
    check(!emptyLook.threw,
      '  while an empty one on a look parameter still loads, because empty is not what is being refused',
      emptyLook.threw ? `"${emptyLook.message}"` : 'accepted');
    // Asserted rather than assumed, because the build this matters on is the one that is
    // deliberately wrong: on the mutated build a `renderScale` track surviving into the next
    // section is `resize()` once per rendered frame there, and a cleanup that silently failed
    // would hand that to section 16 as a hang nobody could attribute to this block.
    const cleaned = await page.evaluate(`(() => {
      try {
        __kinect.library.restoreProject(JSON.parse(${JSON.stringify(original)}));
        return { threw: null, tracks: __kinect.keyframes.names() };
      } catch (err) {
        return { threw: String(err?.message ?? err), tracks: __kinect.keyframes.names() };
      }
    })()`);
    await settle();
    check(cleaned.threw === null && !cleaned.tracks.includes('renderScale'),
      '  and the document this section handed over is put back, carrying neither track it planted',
      cleaned.threw ? `the restore threw "${cleaned.threw}"` : `tracks: ${cleaned.tracks.join(', ') || 'none'}`);

    const enormous = await page.evaluate(`(() => {
      const original = JSON.parse(${JSON.stringify(original)});
      const body = JSON.parse(${JSON.stringify(original)});
      body.clips[0].start = 1e12;
      body.clips[0].length = 0;
      const began = performance.now();
      let result;
      try {
        __kinect.library.restoreProject(body);
        const ticks = [...document.querySelectorAll('#tRuler .ttick')]
          .map((tick) => Number.parseFloat(tick.style.left));
        result = {
          accepted: true,
          elapsed: performance.now() - began,
          duration: __kinect.timeline.read().duration,
          showing: __kinect.timeline.showingAt(1e12)[0]?.showing ?? null,
          ticks,
        };
      } catch (err) {
        result = { accepted: false, elapsed: performance.now() - began, error: String(err?.message ?? err) };
      }
      __kinect.library.restoreProject(original);
      __kinect.keyframes.undo.begin();
      return result;
    })()`);
    check(enormous.accepted && enormous.duration === 1e12
      && enormous.ticks.length > 1 && enormous.ticks.length < 20
      && enormous.ticks.every((left, index) => index === 0 || left > enormous.ticks[index - 1]),
    'a finite project far beyond the one-hour tick ladder builds a width-sized increasing ruler',
    enormous.accepted
      ? `${enormous.ticks.length} ticks in ${enormous.elapsed.toFixed(1)}ms over ${enormous.duration}s`
      : `refused after ${enormous.elapsed.toFixed(1)}ms: ${enormous.error}`);
    check(enormous.accepted && enormous.showing === 'off',
      'a zero-length clip draws no endpoint frame at the program position where it starts and ends',
      enormous.accepted ? `showing ${enormous.showing} at ${enormous.duration}s` : 'the project was refused');

    const unsafeFrames = await page.evaluate(`(() => {
      const original = JSON.parse(${JSON.stringify(original)});
      const body = JSON.parse(${JSON.stringify(original)});
      body.clips[0].start = 1e20;
      body.clips[0].length = 0;
      const began = performance.now();
      let result;
      try {
        __kinect.library.restoreProject(body);
        result = { accepted: true, elapsed: performance.now() - began };
      } catch (err) {
        result = {
          accepted: false,
          elapsed: performance.now() - began,
          error: String(err?.message ?? err),
        };
      }
      __kinect.library.restoreProject(original);
      __kinect.keyframes.undo.begin();
      return result;
    })()`);
    check(!unsafeFrames.accepted && /safe integer/.test(unsafeFrames.error ?? ''),
      'a project whose last output frame cannot advance as a JavaScript integer is refused before the timeline sees it',
      unsafeFrames.accepted
        ? `accepted in ${unsafeFrames.elapsed.toFixed(1)}ms`
        : `refused in ${unsafeFrames.elapsed.toFixed(1)}ms: ${unsafeFrames.error}`);

    // ---- the handle a file arrives with, checked the way the drag that makes one is
    // The invariants lived in the drag handler and nowhere in the loader: `restoreKey` asked
    // whether a handle was an array of finite pairs inside the count ceiling, and nothing about
    // what the numbers meant.
    const withHandle = (where, handle, arriving) => page.evaluate(`(() => {
      const body = JSON.parse(${JSON.stringify(original)});
      const handle = ${JSON.stringify(handle)};
      const arriving = ${JSON.stringify(arriving ?? null)};
      if (${JSON.stringify(where)} === 'camera') {
        // The pose comes from the registry rather than from the document, because the
        // document reaching this section has no camera keys in it - the first draft read
        // body.composition.camera[0], found nothing, and returned a message that made the
        // row read 'it was accepted' on a build that had never been asked anything.
        // params.get('camera') is the pose the page is holding, which is a real one.
        const seed = __kinect.params.get('camera');
        body.composition.camera = [{ t: 0, value: seed, easeOut: handle }, { t: 4, value: seed }];
        if (arriving) body.composition.camera[1].easeIn = arriving;
      } else {
        body.look.tracks.bloom = [{ t: 0, value: 0.4, easeOut: handle }, { t: 4, value: 0.8 }];
        if (arriving) body.look.tracks.bloom[1].easeIn = arriving;
      }
      try {
        __kinect.library.restoreProject(body);
        return { threw: false, message: null };
      } catch (err) {
        return { threw: true, message: String(err?.message ?? err) };
      }
    })()`);

    const folded = await withHandle('look', [[0.9, 0]], [[0.05, 0.5], [0.1, 1]]);
    check(folded.threw && /folds/.test(folded.message ?? ''),
      'a segment whose composed timing curve folds is refused by name, rather than rendering the move at the wrong times',
      folded.threw ? `"${String(folded.message).slice(0, 110)}"` : 'it was accepted');

    // The other half of the same claim, and the row that fails on the build this replaced: the
    // exact polygon `elevate` makes out of the ordinary BENT pair.
    const crossedLegal = await withHandle('look', [[0.675, 0.075], [0.5, 0.5]], [[0.325, 0.925]]);
    check(!crossedLegal.threw,
      '  while the legal crossed polygon elevate produces still loads, because the curve is single-valued however its polygon crosses',
      crossedLegal.threw ? `"${String(crossedLegal.message).slice(0, 110)}"` : 'accepted');

    const descending = await page.evaluate(`(() => {
      const body = JSON.parse(${JSON.stringify(original)});
      body.look.tracks.bloom = [{ t: 4, value: 0.4 }, { t: 0, value: 0.8 }];
      try {
        __kinect.library.restoreProject(body);
        return { threw: false, message: null };
      } catch (err) {
        return { threw: true, message: String(err?.message ?? err) };
      }
    })()`);
    check(descending.threw && /ascending/.test(descending.message ?? ''),
      'a track whose key times descend is refused by name, rather than handing the evaluators a track their binary search answers wrongly over',
      descending.threw ? `"${String(descending.message).slice(0, 110)}"` : 'it was accepted');

    const pastTheEnd = await withHandle('look', [[1.4, 0]]);
    check(pastTheEnd.threw && /outside the segment/.test(pastTheEnd.message ?? ''),
      '  and so is one whose point sits outside the segment it shapes',
      pastTheEnd.threw ? `"${String(pastTheEnd.message).slice(0, 110)}"` : 'it was accepted');

    const poseOver = await withHandle('camera', [[0.5, 1.4]]);
    check(poseOver.threw && /\[0, 1\]/.test(poseOver.message ?? ''),
      '  and a camera handle above the unit box, which sends the camera past the pose it was keyed at',
      poseOver.threw ? `"${String(poseOver.message).slice(0, 110)}"` : 'it was accepted');

    // The row that makes the one above about the kind rather than about handles: a look scalar
    // may overshoot, so a build that simply refused every handle outside the box would pass all
    // three rows above and take a control away from the operator.
    const scalarOver = await withHandle('look', [[0.5, 1.4]]);
    check(!scalarOver.threw,
      '  while a look handle that overshoots still loads, because overshoot is a choice on an axis that is a value',
      scalarOver.threw ? `"${String(scalarOver.message).slice(0, 110)}"` : 'accepted');

    await page.evaluate(`__kinect.library.restoreProject(JSON.parse(${JSON.stringify(original)}))`);
    await settle();
  }

  console.log('\n[15b] the badge names the effects a document needs and this build has not got');

  // A look name whose dotted prefix names an effect that is not installed is a document from a
  // machine carrying something this one lacks, so it loads, the installed part renders, and what
  // belongs to the missing effect is parked.
  {
    const original = await page.evaluate('JSON.stringify(__kinect.library.serialiseProjectBody())');
    const declared = await page.evaluate(`(() => [...new Set(__kinect.params.names('look')
      .filter((n) => n.includes('.')).map((n) => n.slice(0, n.indexOf('.'))))])()`);
    check(!declared.includes('sparkle'),
      'sparkle is not an effect this build has, which is what makes every row below about a missing one',
      `${declared.length} installed: ${declared.join(', ')}`);

    const quiet = await page.evaluate(`(() => {
      const el = document.getElementById('tMissing');
      return { hidden: el.hidden, entries: el.querySelectorAll('.missingfx').length,
        missing: __kinect.library.missingEffects().length };
    })()`);
    check(quiet.hidden === true && quiet.entries === 0 && quiet.missing === 0,
      'a complete document badges nothing at all, so the bar is bare in the ordinary case',
      `hidden ${quiet.hidden}, ${quiet.entries} entries, ${quiet.missing} missing`);

    const staged = await page.evaluate(`(() => {
      const body = JSON.parse(${JSON.stringify(original)});
      body.look.params['sparkle.amount'] = 0.6;
      body.look.params['sparkle.size'] = 3.25;
      body.look.params['sparkle.hue'] = 210;
      body.look.params['sparkle.jitter'] = 0.125;
      body.look.tracks['sparkle.amount'] = [{ t: 0, value: 0 }, { t: 2, value: 0.9 }];
      body.look.tracks['sparkle.hue'] = [{ t: 0.5, value: 10 }];
      body.requires = [...(body.requires ?? []), { id: 'sparkle', version: '1.0.0' }];
      try { __kinect.library.restoreProject(body); } catch (err) { return { threw: String(err?.message ?? err) }; }
      const el = document.getElementById('tMissing');
      return {
        threw: null,
        hidden: el.hidden,
        entries: [...el.querySelectorAll('.missingfx')].map((e) => ({
          effect: e.dataset.effect,
          text: e.querySelector('b').textContent,
          pressed: e.querySelector('button').getAttribute('aria-pressed'),
        })),
      };
    })()`);
    check(staged.threw === null,
      'a document naming an effect this build has not got loads rather than being refused',
      staged.threw ?? 'loaded');
    check(staged.hidden === false && staged.entries.length === 1,
      '  and the badge comes up, one entry for the one effect that is missing',
      `hidden ${staged.hidden}, ${staged.entries?.length ?? 0} entries`);
    check(staged.entries?.[0]?.text === 'missing: sparkle 1.0.0 — 4 values, 2 tracks parked',
      '  and it reads the effect, the version out of the document\'s own requires entry, and what is parked under it',
      JSON.stringify(staged.entries?.[0]?.text ?? null));
    check(staged.entries?.[0]?.pressed === 'false',
      '  with its suppress control up and not pressed, because nobody has said this render may go without it',
      String(staged.entries?.[0]?.pressed));

    await page.click('#tMissing button[data-suppress="sparkle"]');
    const pressed = await page.evaluate(`(() => ({
      pressed: document.querySelector('#tMissing button[data-suppress="sparkle"]').getAttribute('aria-pressed'),
      suppressed: __kinect.library.missingEffects()[0]?.suppressed ?? null,
      note: document.getElementById('tNote').textContent,
    }))()`);
    check(pressed.pressed === 'true' && pressed.suppressed === true,
      '  and pressing it is a suppression the page holds, rather than a control that only lights up',
      `aria-pressed ${pressed.pressed}, suppressed ${pressed.suppressed}`);
    check(/sparkle/.test(pressed.note ?? '') && /without/.test(pressed.note ?? ''),
      '  and it says so on the note, since what it changes is what the next export does',
      JSON.stringify(pressed.note ?? null));
    await page.click('#tMissing button[data-suppress="sparkle"]');
    const released = await page.evaluate(`document.querySelector('#tMissing button[data-suppress="sparkle"]').getAttribute('aria-pressed')`);
    check(released === 'false', '  and pressing it again requires the effect back', String(released));

    // Asserted rather than assumed: every section below serialises whatever the page is holding,
    // and a pool left behind would put a `requires` entry into each of those documents.
    await page.evaluate(`__kinect.library.restoreProject(JSON.parse(${JSON.stringify(original)}))`);
    await settle();
    const after = await page.evaluate(`(() => ({
      missing: __kinect.library.missingEffects().length,
      hidden: document.getElementById('tMissing').hidden,
    }))()`);
    check(after.missing === 0 && after.hidden === true,
      '  and putting the clip back takes the badge away, which is the must-not-badge claim read a second time from the other side',
      `${after.missing} missing, hidden ${after.hidden}`);
  }

  console.log('\n[16] which panel groups are open is derived, and only disagreements are stored');

  // The claim is that no group carries a stored open/closed state: it is open when the document
  // holds evidence that somebody has been inside it, with a person's disagreement the only
  // thing written down.
  {
    const GROUP_STATE = `(() => {
      const vis = (el) => Boolean(el) && el.checkVisibility({ checkVisibilityCSS: true });
      const rows = (g) => [...g.querySelectorAll('.row, .checkrow, .check')];
      return [...document.querySelectorAll('#panel .group[data-group]')].map((g) => {
        const toggle = g.querySelector(':scope > .grouphead > .grouptoggle');
        return {
          key: g.dataset.group,
          collapsible: Boolean(toggle),
          shut: g.classList.contains('shut'),
          expanded: toggle ? toggle.getAttribute('aria-expanded') : null,
          tab: g.dataset.panelTab,
          rendered: vis(g),
          inDom: rows(g).length,
          available: rows(g).filter((row) => !row.hidden).length,
          onScreen: rows(g).filter(vis).length,
        };
      });
    })()`;
    const groups = () => page.evaluate(GROUP_STATE);
    const groupOf = async (key) => (await groups()).find((g) => g.key === key);
    const showGroup = async (key) => {
      const group = await groupOf(key);
      if (group?.tab) await page.click(`#panelTabs [data-panel-tab="${group.tab}"]`);
      await settle();
      return groupOf(key);
    };
    const stored = () => page.evaluate("localStorage.getItem('kinect.panelGroupsOpen')");
    // Back to a document nobody has touched. `params.reset` over the look tag is what
    // `restoreProject` itself uses, so this is the state a fresh project arrives in rather than
    // an approximation.
    const freshLook = async () => {
      await page.evaluate("__kinect.keyframes.setTracks({})");
      await page.evaluate("__kinect.params.reset(__kinect.params.names('look'))");
      await settle();
    };

    // The registry's own answer for what a fresh project holds, so every row below compares
    // against the same number the page derives from.
    const defaultOf = (name) => page.evaluate(
      `__kinect.params.normalise(${JSON.stringify(name)}, __kinect.params.spec(${JSON.stringify(name)}).default)`);

    // Section 1 opens every generated group while it sweeps the controls. Clear that fixture and
    // boot the page from the empty store, because deleting storage alone does not clear the live
    // override map that was built from it.
    await page.evaluate("localStorage.removeItem('kinect.panelGroupsOpen')");
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('!!globalThis.__kinect', null, { timeout: 30000 });
    await page.waitForFunction('!!globalThis.__kinect.timeline.transport()', null, { timeout: 30000 });
    await freshLook();
    await page.evaluate('__kinect.timeline.transport().seek(3)');
    await settle();

    const all = await groups();
    const collapsible = all.filter((g) => g.collapsible);
    note(`${collapsible.length} of ${all.length} generated groups collapse`,
      collapsible.map((g) => g.key).join(', '));
    check(collapsible.length > 0 && collapsible.every((g) => g.inDom > 0),
      'every collapsible group is a group that actually holds rows',
      collapsible.map((g) => `${g.key}:${g.inDom}`).join(' '));

    // `framing` by name, and it is the one group worth an assertion: its `after()` emits
    // `#cropReset`, section 8 clicks that button, and Playwright waits for visibility - so a
    // `framing` that could be shut turns a row eight sections back into a thirty-second timeout.
    const framing = await showGroup('framing');
    check(Boolean(framing) && !framing.collapsible && framing.onScreen === framing.inDom,
      'framing is not collapsible, because the crop button under it is one section 8 has to click',
      framing ? `collapsible: ${framing.collapsible}, ${framing.onScreen} of ${framing.inDom} rows on screen` : 'no framing group');
    await showGroup('post');

    // ---- 15b. a document nobody has touched renders them shut
    const fresh = (await groups()).filter((g) => g.collapsible);
    check(fresh.every((g) => g.shut && g.expanded === 'false' && g.onScreen === 0),
      'a project at its defaults renders every collapsible group shut',
      fresh.map((g) => `${g.key}:${g.shut ? 'shut' : 'OPEN'}/${g.onScreen}`).join(' '));
    check(fresh.every((g) => g.inDom > 0),
      'and their rows are hidden rather than absent, so the panel is still the whole registry',
      `${fresh.reduce((n, g) => n + g.inDom, 0)} rows in the document, ${fresh.reduce((n, g) => n + g.onScreen, 0)} on screen`);

    // ---- 15c. moving a value opens the group that holds it
    // `bloom` because it is in `post` and because `keyframe-check` clicks its keyframe
    // diamond, a control Playwright will only press when it is visible.
    await page.evaluate("__kinect.params.set('bloom', 0.75)");
    await settle();
    const opened = await groupOf('post');
    check(!opened.shut && opened.expanded === 'true' && opened.onScreen === opened.available,
      'moving one parameter off its default opens the group that holds it',
      `post: shut=${opened.shut}, ${opened.onScreen} of ${opened.available} available rows on screen, ${opened.inDom} in the registry`);
    const neighbours = (await groups()).filter((g) => g.collapsible && g.key !== 'post');
    check(neighbours.every((g) => g.shut),
      'and only that group, so the rule is about the parameter rather than about the write',
      neighbours.map((g) => `${g.key}:${g.shut ? 'shut' : 'OPEN'}`).join(' '));

    await freshLook();
    await settle();
    const thermalDefault = await defaultOf('thermal.amount');
    const thermalSpec = await page.evaluate("__kinect.params.spec('thermal.amount')");
    // Whichever end of the travel the default is not, so this cannot become a write of the value
    // that was already there - which would leave the group untouched and the row below asserting
    // the state it started in.
    await page.evaluate(`__kinect.params.set('thermal.amount', ${thermalDefault === thermalSpec.max ? thermalSpec.min : thermalSpec.max})`);
    await settle();
    const thermalNow = await page.evaluate("__kinect.params.get('thermal.amount')");
    const readingsQuiet = await page.evaluate(`__kinect.readings().every((n) =>
      __kinect.params.get(n) === __kinect.params.normalise(n, __kinect.params.spec(n).default))`);
    check(thermalNow !== thermalDefault && readingsQuiet,
      'one effect parameter moved with every reading left at its default, or the row below tests nothing',
      `thermal.amount reads ${thermalNow} against a default of ${thermalDefault}, readings untouched: ${readingsQuiet}`);
    const tuned = await groupOf('thermal');
    check(!tuned.shut && tuned.onScreen === tuned.available,
      'moving an effect parameter opens that effect\'s own group, so the open set is the whole diff',
      `thermal: shut=${tuned.shut}, ${tuned.onScreen} of ${tuned.available} available rows on screen, ${tuned.inDom} in the registry`);

    // ---- 15d. a keyframe counts even where the value does not
    // The whole reason the predicate has a keyframe term, and the one row `reveal-ignores-tracks`
    // can reach: the track's keys are all at `grain.amount`'s own default, so the value test says
    // untouched at every frame while the parameter is being animated.
    await freshLook();
    const grainDefault = await defaultOf('grain.amount');
    await page.evaluate(`__kinect.keyframes.setTracks({ 'grain.amount': [
      { t: 1, value: ${grainDefault} }, { t: 6, value: ${grainDefault} }] })`);
    await page.evaluate('__kinect.timeline.transport().seek(3)');
    await settle();
    // The probe's own control, and without it the row below is an assertion about nothing: if the
    // planted keys had moved the value off its default, the group would open through the term
    // this row is trying to isolate.
    const parked = await page.evaluate("__kinect.params.get('grain.amount')");
    check(parked === grainDefault,
      'the keyed parameter really is sitting on its default at the parked frame, or the row below tests nothing',
      `grain reads ${parked} against a default of ${grainDefault}`);
    const keyed = await groupOf('grain');
    check(!keyed.shut && keyed.onScreen === keyed.available,
      'a keyframe opens the group even where the value it holds is the default',
      `grain: shut=${keyed.shut}, ${keyed.onScreen} of ${keyed.available} available rows on screen, ${keyed.inDom} in the registry`);

    // ---- 15e. a shut group that is in use says so
    // Pressed rather than assumed shut, because the state it starts in is exactly what
    // `group-never-reveals` changes: on that build every group is already shut and a blind
    // press would open one.
    await freshLook();
    await page.evaluate("__kinect.params.set('bloom', 0.75)");
    await settle();
    const shut = async (key) => {
      if (!(await groupOf(key)).shut) await page.click(`[data-group-toggle=${key}]`);
      await settle();
      return groupOf(key);
    };
    const marked = await shut('post');
    check(marked.shut && marked.onScreen === 0,
      'a group carrying a value can still be shut, and shutting it takes its rows off the screen',
      `post: shut=${marked.shut}, ${marked.onScreen} of ${marked.available} available rows on screen`);

    // ---- 15f. the override is a disagreement, and a toggle that agrees writes none
    // Half of the store rule, and only the half a toggle can reach: opening the group again puts
    // the two back into agreement, and what has to happen then is that the entry goes, not that
    // it flips to true.
    const disagreeing = JSON.parse((await stored()) ?? '{}');
    check(disagreeing.post === false,
      'collapsing a group that derives open writes the disagreement down',
      JSON.stringify(disagreeing));
    await page.click('[data-group-toggle=post]');
    await settle();
    const agreeing = JSON.parse((await stored()) ?? '{}');
    const reopened = await groupOf('post');
    check(!reopened.shut && !Object.hasOwn(agreeing, 'post'),
      'and opening it again removes the entry rather than storing the agreement',
      `open=${!reopened.shut}, stored ${JSON.stringify(agreeing)}`);

    // ---- 15f-bis. the term that moves afterwards is the document, not the toggle
    // The other term of the comparison is the derivation, and the derivation moves without
    // anybody pressing anything - a value set, a look applied, a project opened - so an override
    // the document has caught up with sits there winning over a rule it now agrees with.
    await freshLook();
    await settle();
    const quiet = await groupOf('post');
    if (quiet.shut) await page.click('[data-group-toggle=post]');
    await settle();
    const pinned = await groupOf('post');
    const pinnedStore = JSON.parse((await stored()) ?? '{}');
    check(!pinned.shut && pinned.onScreen === pinned.available && pinnedStore.post === true,
      'pinning a quiet group open is a disagreement and is written down, or the two rows below test nothing',
      `open=${!pinned.shut}, ${pinned.onScreen} of ${pinned.available} available rows on screen, stored ${JSON.stringify(pinnedStore)}`);
    await page.evaluate("__kinect.params.set('bloom', 0.75)");
    await settle();
    const caughtUp = await groupOf('post');
    const caughtStore = JSON.parse((await stored()) ?? '{}');
    check(!caughtUp.shut && !Object.hasOwn(caughtStore, 'post'),
      'and the document catching up with it takes the entry away, with nothing on screen changing',
      `open=${!caughtUp.shut}, stored ${JSON.stringify(caughtStore)}`);
    await freshLook();
    await settle();
    const decayed = await groupOf('post');
    check(decayed.shut && decayed.onScreen === 0,
      'so taking the value away again shuts it, rather than leaving it pinned open with nothing in it',
      `shut=${decayed.shut}, ${decayed.onScreen} of ${decayed.inDom} rows on screen, stored ${await stored()}`);
    // Put back as it was found, and this is the fixture rather than a claim: on
    // `override-prunes-only-on-toggle` the group is still pinned, and a pin that outlived this
    // block is a group 15g would read as in use - so the control would redden a neighbour's
    // fixture as well as its own two rows.
    if (!(await groupOf('post')).shut) await page.click('[data-group-toggle=post]');
    await settle();

    // ---- 15g. moving a package parameter opens that package's group
    // `ghost.amount` rather than `readRgb`, and the difference is the whole trap: `readRgb` defaults
    // to 1, so "open when a reading is non-zero" fires on a page nobody has touched.
    await freshLook();
    await settle();
    const ghostQuiet = await groupOf('ghost');
    await page.evaluate("__kinect.params.set('ghost.amount', 0.7)");
    await settle();
    const ghostLive = await groupOf('ghost');
    check(ghostQuiet.shut && !ghostLive.shut && ghostLive.onScreen === ghostLive.available,
      'moving ghost.amount opens the Ghost package group',
      `shut with the readings at their defaults: ${ghostQuiet.shut}, after ghost.amount moved: ${ghostLive.shut}`);
    const untouched = (await groups()).filter((g) => g.collapsible && g.key !== 'ghost');
    check(untouched.every((g) => g.shut),
      'and leaves every group the reading has nothing to do with shut',
      untouched.map((g) => `${g.key}:${g.shut ? 'shut' : 'OPEN'}`).join(' '));

    await page.click('[data-group-toggle=ghost]');
    await settle();
    const ghostShut = await groupOf('ghost');
    const ghostStored = JSON.parse((await stored()) ?? '{}');
    check(ghostShut.shut && ghostStored.ghost === false,
      'shutting a group while it is in use stays shut and is written down',
      `shut=${ghostShut.shut}, stored ${JSON.stringify(ghostStored)}`);

    // ---- 15i. the override outlives the page that wrote it
    // This page reloaded rather than a second page opened beside it, because `page.route` is
    // installed per page and a second page would take the tree's own `main.js` - two different
    // builds inside one measurement.
    await freshLook();
    await page.evaluate("__kinect.params.set('bloom', 0.75)");
    await settle();
    if (!(await groupOf('post')).shut) await page.click('[data-group-toggle=post]');
    if ((await groupOf('points')).shut) await page.click('[data-group-toggle=points]');
    await settle();
    const beforeReload = JSON.parse((await stored()) ?? '{}');
    check(beforeReload.post === false && beforeReload.points === true,
      'a group shut while it is in use and a quiet one pinned open are two disagreements to survive, or the rows below test nothing',
      `stored ${JSON.stringify(beforeReload)}`);
    await page.reload({ waitUntil: 'load' });
    // `__kinect` first: since the effect packages moved onto the wire the handle publishes after
    // the `load` event `reload` waits for, and a predicate that throws is not caught by
    // `waitForFunction`, so the thirty seconds it was given are never spent and the run dies.
    await page.waitForFunction('!!globalThis.__kinect', null, { timeout: 30000 });
    await page.waitForFunction('!!globalThis.__kinect.timeline.transport()', null, { timeout: 30000 });
    await settle();
    // Read straight out of storage, before anything else touches the page: a build that prunes on
    // agreement rather than on movement deletes the collapse during the boot pass, when the look
    // is at its defaults because no document has arrived yet, and writes the pruned map back.
    const carriedStore = JSON.parse((await stored()) ?? '{}');
    check(carriedStore.post === false && carriedStore.points === true,
      'the store the page booted from still holds both, so nothing pruned them against a document that had not loaded yet',
      `stored ${JSON.stringify(carriedStore)}`);
    const pinCarried = await showGroup('points');
    const quietAfter = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const known = new Set(k.params.names());
      const group = [...document.querySelectorAll('#panel .group[data-group]')].find((g) => g.dataset.group === 'points');
      const names = [...group.querySelectorAll('input')].map((i) => i.id).filter((n) => known.has(n));
      return { names: names.length, quiet: names.every((n) => k.params.get(n) === k.params.normalise(n, k.params.spec(n).default)) };
    })()`);
    check(!pinCarried.shut && pinCarried.onScreen === pinCarried.available
      && quietAfter.names > 0 && quietAfter.quiet,
      'and the page reloaded still finds the pinned one open, on a document holding nothing that would open it',
      `open=${!pinCarried.shut}, ${pinCarried.onScreen} of ${pinCarried.inDom} rows on screen, `
      + `${quietAfter.names} parameters in the group and all at their defaults: ${quietAfter.quiet}`);
    await page.evaluate("__kinect.params.set('bloom', 0.75)");
    await settle();
    const collapseCarried = await groupOf('post');
    check(collapseCarried.shut && collapseCarried.onScreen === 0,
      'and the collapse survives it too, so a group shut while it was in use is still shut when the value comes back',
      `shut=${collapseCarried.shut}, ${collapseCarried.onScreen} of ${collapseCarried.inDom} rows on screen, `
      + `stored ${await stored()}`);

    // ---- 13j. every toggle the page renders is one this section has driven
    // The reverse of the driver rule above, asked of the page rather than of this file, so a
    // group declared after today is driven by existing.
    await freshLook();
    await settle();
    const driven = [];
    const renderedToggles = (await groups()).filter((x) => x.collapsible && x.rendered);
    for (const g of renderedToggles) {
      await showGroup(g.key);
      const before = await groupOf(g.key);
      await page.click(`[data-group-toggle=${g.key}]`);
      await settle();
      const after = await groupOf(g.key);
      driven.push({
        key: g.key,
        from: before.onScreen,
        to: after.onScreen,
        moved: before.onScreen !== after.onScreen,
        honest: after.expanded === String(after.onScreen > 0),
      });
    }
    check(driven.length === renderedToggles.length && driven.every((d) => d.moved && d.honest),
      'every collapsible group the page renders was pressed here and its rows answered',
      driven.map((d) => `${d.key}:${d.from}->${d.to}${d.honest ? '' : ' (aria disagrees)'}`).join(' '));

    // ---- 13k. one re-derivation per bulk write, not one per value in it
    // The panel is re-derived from `params.set`, which is the door the evaluator writes every
    // keyed parameter through on every rendered frame - so without a gate the cost of this
    // feature scales with the number of keys on the clip, on the render path.
    const costOfKeying = async (count) => {
      await freshLook();
      const names = (await page.evaluate("__kinect.params.names('look')")).slice(0, count);
      const spec = Object.fromEntries(await Promise.all(names.map(async (name) => {
        const at = await defaultOf(name);
        return [name, [{ t: 0, value: at }, { t: 8, value: at }]];
      })));
      await page.evaluate(`__kinect.keyframes.setTracks(${JSON.stringify(spec)})`);
      await page.evaluate('__kinect.timeline.transport().seek(1)');
      await settle();
      const before = await page.evaluate(
        '({ refreshes: __kinect.groupRefreshes(), renders: __kinect.timeline.counters.renders })');
      await page.evaluate('__kinect.timeline.transport().seek(5)');
      await settle();
      const after = await page.evaluate(
        '({ refreshes: __kinect.groupRefreshes(), renders: __kinect.timeline.counters.renders })');
      await page.evaluate('__kinect.keyframes.setTracks({})');
      const frames = after.renders - before.renders;
      return { keys: names.length, frames, perFrame: frames > 0 ? (after.refreshes - before.refreshes) / frames : NaN };
    };
    // Interleaved rather than one after the other, because a sequential pair on a machine that
    // got busy between them is a comparison of the machine.
    const cheap = [await costOfKeying(4), await costOfKeying(4)];
    const dear = [await costOfKeying(8), await costOfKeying(8)];
    const worst = (runs) => Math.max(...runs.map((r) => r.perFrame));
    const ran = [...cheap, ...dear].every((r) => r.frames > 0 && Number.isFinite(r.perFrame));
    check(ran && worst(dear) <= worst(cheap) + 0.5 && worst(dear) < 2,
      'a rendered frame re-derives the panel a fixed number of times rather than once per keyed parameter',
      `${cheap.map((r) => r.perFrame.toFixed(2)).join('/')} per frame with ${cheap[0].keys} parameters keyed, `
      + `${dear.map((r) => r.perFrame.toFixed(2)).join('/')} with ${dear[0].keys}, `
      + `over ${[...cheap, ...dear].map((r) => r.frames).join('/')} rendered frames`);

    // Put the panel and the document back: the rows after this drive a pointer over the stage and
    // pin the drive, and a panel left with four groups open is a different page from the one they
    // were measured on.
    await page.evaluate("localStorage.removeItem('kinect.panelGroupsOpen')");
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction('!!globalThis.__kinect', null, { timeout: 30000 });
    await page.waitForFunction('!!globalThis.__kinect.timeline.transport()', null, { timeout: 30000 });
    await freshLook();
  }

  console.log('\n[17] a parameter can be put back, and the offer to put it back is the registry speaking');
  // The reset beside each look slider is four claims wearing one button, and they fail apart:
  // that every look scalar has one, that whether it is offered is re-read off the registry rather
  // than remembered from the panel's own gestures, that hiding it costs the row no layout, and
  // that pressing it is an ordinary registry write.
  {
    // The comparison is against `normalise(default)` rather than against the declared literal:
    // several defaults are not values a slider can hold - rim is declared 0.55 against a 0.01
    // step - so a row comparing against the literal would call a parameter modified while it sits
    // exactly where a reset would leave it.
    const RESET_STATE = `(() => {
      const k = globalThis.__kinect;
      const vis = (el) => Boolean(el) && el.checkVisibility({ checkVisibilityCSS: true });
      const rowOf = (input) => input.closest('.row') || input.closest('.checkrow') || input.closest('.check');
      const params = k.params.names().map((name) => {
        const spec = k.params.spec(name);
        const input = document.getElementById(name);
        const row = input ? rowOf(input) : null;
        const own = row ? [...row.querySelectorAll('.reset')] : [];
        const button = own.length === 1 ? own[0] : null;
        const group = row ? row.closest('.group[data-group]') : null;
        const scalar = spec.kind !== 'pose';
        const value = scalar ? k.params.get(name) : null;
        const def = scalar ? k.params.normalise(name, spec.default) : null;
        return {
          name,
          tag: spec.tag,
          kind: spec.kind,
          under: spec.under ?? null,
          control: input ? input.type : null,
          tab: group ? group.dataset.panelTab || null : null,
          group: group ? group.dataset.group || null : null,
          collapsible: Boolean(group && group.querySelector(':scope > .grouphead > .grouptoggle')),
          // Every reset in the row and the name each one claims, so a row carrying two
          // of them, or one carrying its neighbour's name, is visible here rather than
          // counted as one.
          claims: own.map((b) => b.dataset.reset || ''),
          offered: button ? button.dataset.modified : null,
          disabled: button ? button.disabled : null,
          onScreen: button ? vis(button) : null,
          rowOnScreen: vis(row),
          offDefault: scalar ? value !== def : null,
          value,
          def,
          // A checkbox answers .value with the string "on" whatever its state is, so
          // reading it that way says the same thing about a row that was just put back
          // and a row that was not. .checked is where a step parameter's state is.
          slider: input ? (input.type === 'checkbox' ? input.checked : input.value) : null,
          readout: row ? (row.querySelector('output') ? row.querySelector('output').textContent : null) : null,
        };
      });
      // Asked of the whole document rather than of the rows the walk above expects, so a
      // reset planted in a group head, in the strip, or beside a control that is not a
      // parameter at all is seen. A sweep that only looks where it expects to find
      // something cannot report one anywhere else.
      const planted = [...document.querySelectorAll('.reset')].map((b) => {
        const row = b.closest('.row') || b.closest('.checkrow') || b.closest('.check');
        const input = row ? row.querySelector('input') : null;
        return { claims: b.dataset.reset || '', inRowOf: input ? input.id : null };
      });
      return { params, planted };
    })()`;
    const resetState = () => page.evaluate(RESET_STATE);
    const freshLook = async () => {
      await page.evaluate('__kinect.keyframes.setTracks({})');
      await page.evaluate("__kinect.params.reset(__kinect.params.names('look'))");
      await settle();
    };
    // The control's own path and never `params.set`, because half of what this section is about
    // is which door a write came through - and the value that came out is read back against the
    // value that went in.
    const driveSlider = async (name, value) => page.evaluate(`(() => {
      const el = document.getElementById(${JSON.stringify(name)});
      if (el.type === 'checkbox') el.checked = Boolean(${JSON.stringify(value)});
      else el.value = String(${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return globalThis.__kinect.params.get(${JSON.stringify(name)});
    })()`);
    // One step off the default, taken off the registry's own grid rather than chosen, so this
    // cannot become a write of the value that was already there.
    const oneStepOff = (name) => page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const spec = k.params.spec(${JSON.stringify(name)});
      const def = k.params.normalise(${JSON.stringify(name)}, spec.default);
      // A step parameter has one other state and no grid to walk along, so "one step
      // off its default" is the negation. Asking a checkbox for def plus a step
      // answers with a number it cannot hold.
      if (spec.kind === 'step') return !def;
      return def + spec.step <= spec.max ? def + spec.step : def - spec.step;
    })()`);
    const rackAllEffects = async () => {
      await page.locator('.paneltab[data-panel-tab="look"]').click();
      await page.locator('#effectRackOpen').click();
      await page.locator('#effectRackSearch').fill('');
      for (;;) {
        const next = page.locator('[data-effect-add]').first();
        if (await next.count() === 0) break;
        await next.click();
      }
      await page.locator('#effectRackClose').click();
      await settle();
    };
    const clearRackAndOverrides = async () => {
      await page.locator('.paneltab[data-panel-tab="look"]').click();
      await page.locator('#effectRackOpen').click();
      await page.locator('#effectRackSearch').fill('');
      while (await page.locator('[data-effect-remove]').count() > 0) {
        await page.locator('[data-effect-remove]').first().click();
      }
      await page.locator('#effectRackClose').click();
      await page.evaluate("localStorage.removeItem('kinect.panelGroupsOpen')");
      await page.reload({ waitUntil: 'load' });
      await page.waitForFunction('!!globalThis.__kinect', null, { timeout: 30000 });
      await page.waitForFunction('!!globalThis.__kinect.timeline.transport()', null, { timeout: 30000 });
      await freshLook();
    };

    await freshLook();
    await page.locator('.paneltab[data-panel-tab="look"]').click();
    await settle();

    // ---- 17a. the set of rows that carry one, computed from the registry
    const rest = await resetState();
    const scalars = rest.params.filter((p) => p.tag === 'look'
      && (p.kind === 'scalar' || p.kind === 'step'));
    const missing = scalars.filter((p) => p.claims.length !== 1 || p.claims[0] !== p.name);
    const tabs = [...new Set(scalars.map((p) => p.tab))];
    const perTab = tabs.map((t) => {
      const on = scalars.filter((p) => p.tab === t);
      return `${t} ${on.filter((p) => p.claims.length === 1).length}/${on.length}`;
    }).join(', ');
    check(scalars.length > 0 && missing.length === 0,
      `every look parameter the panel renders a control for carries exactly one reset naming itself (${scalars.length})`,
      missing.length ? `${missing.length} wrong: ${missing.map((p) => `${p.name}[${p.tab}] ${p.claims.join('+') || 'none'}`).join(', ')}`
        : `per inspector: ${perTab}, of which `
          + `${scalars.filter((p) => p.kind === 'step').length} are checkboxes`);

    // The set above is the registry's `scalar` and the generator's condition is the rendered
    // control not being a checkbox - two spellings of one rule with nothing making them agree, so
    // a `kind` that stopped implying its control would leave the row above asserting about the
    // wrong population while reading perfectly.
    const looks = rest.params.filter((p) => p.tag === 'look');
    const splitWrong = looks.filter((p) => (p.kind === 'scalar') !== (p.control === 'range'));
    check(looks.length > 0 && splitWrong.length === 0,
      'and the registry kind that decides it is the control the panel renders, so the row above is about the set it names',
      splitWrong.length ? splitWrong.map((p) => `${p.name} is ${p.kind} on a ${p.control}`).join(', ')
        : `${looks.filter((p) => p.kind === 'scalar').length} scalars on ranges, `
          + `${looks.filter((p) => p.kind === 'step').length} steps on checkboxes`);

    const entitled = new Set(scalars.map((p) => p.name));
    const strayButton = rest.planted.filter((b) => !entitled.has(b.claims) || b.inRowOf !== b.claims);
    const strayRow = rest.params.filter((p) => !entitled.has(p.name) && p.claims.length > 0);
    check(rest.planted.length > 0 && strayButton.length === 0 && strayRow.length === 0,
      'and nothing else carries one: not a view parameter, and not a control that is no parameter at all',
      strayButton.length || strayRow.length
        ? `${strayButton.map((b) => `${b.claims || '(unnamed)'} sits in the row of ${b.inRowOf || 'nothing'}`).join(', ')} `
          + `${strayRow.map((p) => `${p.name} (${p.kind}/${p.tag}) carries ${p.claims.join('+')}`).join(', ')}`
        : `${rest.planted.length} resets, each in its own parameter's row`);

    // ---- 17b. a look nobody has touched offers nothing
    const carried = (state) => state.params.filter((p) => p.claims.length === 1 && p.claims[0] === p.name);
    const quiet = carried(rest);
    const offeredAtRest = quiet.filter((p) => p.offered !== 'no' || p.disabled !== true);
    check(quiet.length > 0 && quiet.every((p) => !p.offDefault) && offeredAtRest.length === 0,
      'a look sitting at its defaults offers no reset anywhere, and every one of them is disabled',
      offeredAtRest.length
        ? offeredAtRest.map((p) => `${p.name} offered=${p.offered} disabled=${p.disabled} value ${p.value} against ${p.def}`).join(', ')
        : `${quiet.length} rows, all unoffered and disabled, all on their defaults`);

    // The fresh Look groups are correctly collapsed. Use the non-collapsing Framing group for
    // the rendered-state arm, then return to Look before driving its preset picker.
    await page.locator('.paneltab[data-panel-tab="framing"]').click();
    await settle();
    const shownAtRest = carried(await resetState()).filter((p) => p.rowOnScreen);
    check(shownAtRest.length >= 8 && shownAtRest.every((p) => p.onScreen === false),
      'and a reset that is not offered is not on the screen either, so the attribute is the rendered state',
      `${shownAtRest.filter((p) => p.onScreen === false).length} of ${shownAtRest.length} rows on screen show nothing`);
    await page.locator('.paneltab[data-panel-tab="look"]').click();
    await settle();

    // ---- 17c. the door this control has to read, and it is not its own
    // Everything above and below could be satisfied by a button that remembered its own clicks.
    const presetIdle = () => page.waitForFunction(
      '!globalThis.__kinect.library.presetGestureRunning()', null, { timeout: 15000 });
    // Whichever look the library holds, preferring the one this repo grades against - a name
    // written down here would be a name that has to exist on somebody else's server.
    const presetName = await page.evaluate(`(() => {
      const values = [...document.querySelectorAll('#tPresetList .pickeroption')]
        .map((o) => o.dataset.name).filter(Boolean);
      return values.includes('blackwall') ? 'blackwall' : (values[0] ?? null);
    })()`);
    const beforeApply = carried(await resetState()).filter((p) => p.offered === 'yes').map((p) => p.name);
    await presetIdle();
    await page.click('#tPreset');
    await page.click(`#tPresetList .pickeroption[data-name="${presetName}"]`);
    await presetIdle();
    await settle();
    const applied = await resetState();
    const withReset = carried(applied);
    const moved = withReset.filter((p) => p.offDefault);
    const disagree = withReset.filter((p) => (p.offered === 'yes') !== p.offDefault);
    check(Boolean(presetName) && beforeApply.length === 0 && moved.length >= 3 && disagree.length === 0,
      'a preset applied from the picker moves which rows offer a reset, with no reset pressed',
      disagree.length
        ? `${disagree.length} disagree: ${disagree.slice(0, 8).map((p) => `${p.name} offered=${p.offered} value ${p.value} against ${p.def}`).join(', ')}`
        : `${presetName} moved ${moved.length} of ${withReset.length} rows off their defaults, `
          + `${beforeApply.length} were offered before it`);

    const enabledWrong = withReset.filter((p) => p.disabled !== (p.offered === 'no'));
    check(withReset.length > 0 && moved.length > 0 && moved.length < withReset.length && enabledWrong.length === 0,
      'and disabled agrees with it on every row, so a reset nobody is being offered cannot be pressed or tabbed to',
      enabledWrong.length
        ? enabledWrong.map((p) => `${p.name} offered=${p.offered} disabled=${p.disabled}`).join(', ')
        : `${moved.length} offered and enabled, ${withReset.length - moved.length} unoffered and disabled`);

    // ---- 17d. the slot is reserved, so a row does not move when the offer appears
    // Measured over the rows that are on screen and in a group nothing can collapse, so the two
    // snapshots differ in the reset's own state and in nothing else.
    await freshLook();
    await settle();
    // The inspector holding the non-collapsing group is selected first, because "on screen" is a
    // fact about which tab is showing: measured from the `look` tab this filter answers with an
    // empty list and the three rows below compare nothing while reporting that they compared
    // nothing identically.
    const steadyTab = (await resetState()).params
      .find((p) => p.tag === 'look' && p.kind === 'scalar' && !p.collapsible && p.tab)?.tab;
    if (steadyTab) {
      await page.locator(`.paneltab[data-panel-tab="${steadyTab}"]`).click();
      await settle();
    }
    const stable = (await resetState()).params
      .filter((p) => p.tag === 'look' && p.kind === 'scalar' && p.rowOnScreen && !p.collapsible)
      .map((p) => p.name);
    const GEOM = (names) => `(() => {
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return [Math.round(r.x * 100) / 100, Math.round(r.width * 100) / 100];
      };
      return ${JSON.stringify(names)}.map((name) => {
        const input = document.getElementById(name);
        const row = input.closest('.row');
        const button = row.querySelector('.reset');
        return {
          name,
          offered: button.dataset.modified,
          resetBox: box(button),
          children: [...row.children].map((c) => [c.tagName + '.' + (c.className || ''), ...box(c)]),
          readout: row.querySelector('output').textContent,
        };
      });
    })()`;
    const hiddenGeom = await page.evaluate(GEOM(stable));
    for (const name of stable) await driveSlider(name, await oneStepOff(name));
    await settle();
    const shownGeom = await page.evaluate(GEOM(stable));
    const shownOf = (name) => shownGeom.find((s) => s.name === name);
    const bothStates = stable.length >= 8
      && hiddenGeom.every((r) => r.offered === 'no') && shownGeom.every((r) => r.offered === 'yes');
    check(bothStates,
      'the two snapshots really are the hidden state and the shown state, or the two rows below compare nothing',
      `${stable.length} rows in a group nothing collapses: ${stable.join(', ')}`);
    const boxLost = hiddenGeom.filter((r) => r.resetBox[1] !== shownOf(r.name).resetBox[1] || r.resetBox[1] === 0);
    check(bothStates && boxLost.length === 0,
      'the reset keeps its box on the row while it is not being offered, rather than being taken out of the flow',
      boxLost.length ? boxLost.map((r) => `${r.name} ${r.resetBox.join('x')} against ${shownOf(r.name).resetBox.join('x')}`).join(', ')
        : `${hiddenGeom.length} rows, every reset ${hiddenGeom.length ? hiddenGeom[0].resetBox[1] : '?'}px wide in both states`);
    const reflowed = hiddenGeom.filter((r) => JSON.stringify(r.children) !== JSON.stringify(shownOf(r.name).children));
    check(bothStates && reflowed.length === 0,
      'and nothing else in the row moved between the two states, so a drag that moves a value does not move the control under the pointer',
      reflowed.length
        ? reflowed.slice(0, 3).map((r) => `${r.name} ${JSON.stringify(r.children)} -> ${JSON.stringify(shownOf(r.name).children)}`).join(' | ')
        : `${hiddenGeom.length} rows identical to the hundredth of a pixel, readouts `
          + `${hiddenGeom.length ? `${hiddenGeom[0].readout} -> ${shownGeom[0].readout}` : 'none'}`);

    // ---- 17e. the press, and what a press is
    // Three observables rather than one, because the registry agreeing with itself is exactly
    // what a build writing around the registry produces: the value the registry holds, the
    // position the slider is at, and the number the row prints.
    const armReset = async (name) => {
      await driveSlider(name, await oneStepOff(name));
      await settle();
      // The attribute value is quoted because a name may carry a dot - unquoted,
      // `[data-reset=glyph.amount]` is a CSS parse error, querySelector throws inside the waited
      // function, and the timeout files a working row under "never offered".
      const armed = await page.waitForFunction(
        `(() => { const b = document.querySelector('.reset[data-reset=${JSON.stringify(name)}]');
          return Boolean(b) && !b.disabled && b.checkVisibility({ checkVisibilityCSS: true }); })()`,
        null, { timeout: 2500 }).then(() => true, () => false);
      if (armed) await page.click(`.reset[data-reset="${name}"]`);
      await settle();
      return armed;
    };

    // Every one of them, and the count is what makes the driver rule honest: section 1 credits
    // this generated set of controls to this section by their `data-reset` attribute.
    await freshLook();
    await rackAllEffects();
    // A tuning row declared `under` is deliberately hidden while its master is zero. Put every
    // parent one step up, then drive tuning rows before their masters so every rendered reset is
    // reached without weakening that visibility rule.
    const underParents = [...new Set(scalars.map((p) => p.under).filter(Boolean))];
    const underAtZero = await page.evaluate(`(${((names) => names.map((name) => {
      const row = document.getElementById(name)?.closest('.row, .checkrow') ?? null;
      return {
        name,
        hidden: row?.hidden ?? null,
        display: row ? getComputedStyle(row).display : null,
        visible: row?.checkVisibility({ checkVisibilityCSS: true }) ?? null,
      };
    })).toString()})(${JSON.stringify(scalars.filter((p) => p.under).map((p) => p.name))})`);
    const exposedUnder = underAtZero.filter((row) => !row.hidden || row.display !== 'none' || row.visible);
    check(underAtZero.length > 0 && exposedUnder.length === 0,
      'every tuning row declared under a zero master is absent from layout and visibility',
      exposedUnder.length ? JSON.stringify(exposedUnder) : `${underAtZero.length} rows hidden`);
    for (const parent of underParents) await driveSlider(parent, await oneStepOff(parent));
    await settle();
    const unarmed = [];
    const byTab = new Map();
    // How far down an `under` chain a row sits, so the order below runs bottom-up rather than one
    // level deep. `datamosh.refresh` is under `cycleRefresh`, which is itself under `amount`:
    // pressing the middle row's reset puts it back to its default and hides the bottom row, so a
    // sort that only separates "has a parent" from "has none" drives the bottom row while it is
    // off screen and files a working reset under "never offered".
    const underOf = new Map(rest.params.map((p) => [p.name, p.under]));
    const underDepth = (name) => {
      let depth = 0;
      for (let at = underOf.get(name); at; at = underOf.get(at)) {
        depth += 1;
        // A chain naming itself would spin here, and a check that hangs reads as a busy machine.
        if (depth > underOf.size) throw new Error(`the under chain from ${name} does not terminate`);
      }
      return depth;
    };
    const resetOrder = [...scalars].sort((a, b) => underDepth(b.name) - underDepth(a.name));
    for (const p of resetOrder) {
      if (!p.tab) {
        unarmed.push(`${p.name} (no panel tab)`);
        continue;
      }
      if (!byTab.has(p.tab)) byTab.set(p.tab, []);
      byTab.get(p.tab).push(p.name);
    }
    for (const [tab, names] of byTab) {
      await page.locator(`.paneltab[data-panel-tab="${tab}"]`).click();
      await settle();
      for (const name of names) if (!(await armReset(name))) unarmed.push(name);
    }
    check(unarmed.length === 0 && scalars.length > 0,
      `every reset the panel renders was pressed here, each offered by its own drag first (${scalars.length})`,
      unarmed.length ? `${unarmed.length} never offered after the drag, so they were never pressed: ${unarmed.join(', ')}`
        : `${scalars.length} of ${scalars.length} across ${[...byTab.keys()].join(', ')}, `
          + `deepest under chain ${Math.max(...scalars.map((p) => underDepth(p.name)))}`);

    const afterPresses = carried(await resetState());
    // Three observables on a slider row and two on a checkbox row, because a checkrow has no
    // `<output>` to disagree with - comparing a missing readout against the default would redden
    // all three step rows for the one thing they cannot have.
    const notBack = afterPresses.filter((p) => p.value !== p.def
      || (p.kind === 'step'
        ? p.slider !== p.def
        : p.slider !== String(p.def) || p.readout !== String(p.def)));
    check(afterPresses.length > 0 && notBack.length === 0,
      'pressing a reset puts the registry, the slider and the readout back on the normalised default together',
      notBack.length
        ? `${notBack.length} of ${afterPresses.length} did not: `
          + notBack.slice(0, 4).map((p) => `${p.name} registry ${p.value}, slider ${p.slider}, readout ${p.readout}, default ${p.def}`).join('; ')
        : `${afterPresses.length} rows, including pointSize ${afterPresses.find((p) => p.name === 'pointSize')?.value}, `
          + `rim ${afterPresses.find((p) => p.name === 'rim')?.value}, exposure ${afterPresses.find((p) => p.name === 'exposure')?.value}`);
    const stillOffered = afterPresses.filter((p) => p.offered !== 'no' || p.disabled !== true);
    check(stillOffered.length === 0,
      'and the row stops offering it, because the offer is the comparison and the comparison has just become an equality',
      stillOffered.length
        ? `${stillOffered.length} still offered: ${stillOffered.slice(0, 6).map((p) => `${p.name} offered=${p.offered} disabled=${p.disabled}`).join(', ')}`
        : `${afterPresses.length} rows unoffered and disabled again`);
    // Racking package effects can hold a shared core group open. Clear that panel fixture before
    // asking whether a core value alone opens and then closes its own group.
    await clearRackAndOverrides();
    await page.locator('.paneltab[data-panel-tab="look"]').click();
    await settle();

    // The press is a registry write and not an assignment, and the group is where that shows: the
    // group holding `bloom` is open only because `bloom` is carrying something, so putting
    // `bloom` back has to reach the reveal rule as well as the value map.
    await freshLook();
    await settle();
    await driveSlider('bloom', await oneStepOff('bloom'));
    await settle();
    const bloomGroup = await page.evaluate(
      "document.getElementById('bloom').closest('.group[data-group]').dataset.group");
    const groupShut = (key) => page.evaluate(
      `document.querySelector('.group[data-group=${key}]').classList.contains('shut')`);
    const openedBy = (await resetState()).params.find((p) => p.name === 'bloom');
    const opticalOpen = !(await groupShut(bloomGroup));
    check(openedBy.offered === 'yes' && opticalOpen,
      'a value moved into a collapsible group opens it and offers the reset, or the three rows below test nothing',
      `bloom offered=${openedBy.offered}, ${bloomGroup} open=${opticalOpen}`);
    // Conditional for the reason `armReset` above is bounded: a press into a control the build is
    // not offering is a thirty-second timeout rather than a finding.
    if (openedBy.offered === 'yes' && opticalOpen) await page.click('.reset[data-reset=bloom]');
    await settle();
    const bloomDefault = await page.evaluate(
      "__kinect.params.normalise('bloom', __kinect.params.spec('bloom').default)");
    const afterBloom = await page.evaluate(`(() => ({
      shut: document.querySelector('.group[data-group=${bloomGroup}]').classList.contains('shut'),
      value: globalThis.__kinect.params.get('bloom'),
      focus: document.activeElement === null ? 'null'
        : (document.activeElement.id || document.activeElement.tagName.toLowerCase()),
      onBody: document.activeElement === null || document.activeElement === document.body,
    }))()`);
    check(afterBloom.shut && afterBloom.value === bloomDefault,
      'and the group re-derives shut behind it, so the press reached everything a registry write reaches',
      `${bloomGroup} shut=${afterBloom.shut}, bloom reads ${afterBloom.value} against a default of ${bloomDefault}`);

    // ---- 17f. where the caret is afterwards
    // The press removes its own control: writing the default makes the row unmodified, which
    // disables the button while it is the focused element, and focus falls to the body.
    check(!afterBloom.onBody,
      'a press that shuts the group it was in still leaves the caret somewhere in the panel',
      `the caret is on ${afterBloom.focus}`);
    await freshLook();
    await settle();
    // A parameter whose group cannot collapse, and it is chosen rather than named: this row is
    // the other half of the pair above, so it needs a group that does not shut behind the write.
    const steady = stable[0];
    if (steadyTab) {
      await page.locator(`.paneltab[data-panel-tab="${steadyTab}"]`).click();
      await settle();
    }
    await armReset(steady);
    const caret = await page.evaluate(`(() => (document.activeElement === null ? 'null'
      : (document.activeElement.id || document.activeElement.tagName.toLowerCase())))()`);
    check(caret === steady,
      "pressing a reset leaves the caret on that row's own slider, which is the control the press was about",
      `the caret is on ${caret}`);

    // Put the look, the store and the inspector back: the section after this drags a pointer
    // across the stage and pins the drive.
    await page.evaluate("localStorage.removeItem('kinect.panelGroupsOpen')");
    await freshLook();
    await page.locator('.paneltab[data-panel-tab="look"]').click();
    await settle();
  }

  console.log('\n[18] prev and next walk the selected track, and go quiet at its ends');

  // Two claims, separated because they fail for different reasons: where the playhead lands, and
  // whether the control offers a press at all when there is nothing that way.
  {
    const setTracks = async (spec) => {
      await page.evaluate(`__kinect.keyframes.setTracks(${JSON.stringify(spec)})`);
      await settle();
    };
    const at = async () => page.evaluate('__kinect.timeline.transport().programSec');
    const navState = async () => page.evaluate(`(() => ({
      prev: document.getElementById('tPrevKey').disabled,
      next: document.getElementById('tNextKey').disabled,
    }))()`);
    const park = async (t) => {
      await page.evaluate(`__kinect.timeline.transport().pause()`);
      await page.evaluate(`__kinect.timeline.transport().seek(${t})`);
      await settle();
    };

    const KEYS = [1, 5, 9];
    await setTracks({ bloom: KEYS.map((t, i) => ({ t, value: 0.2 + i * 0.3 })) });
    await page.evaluate(`__kinect.editor.select('bloom', 0)`);
    await park(0);

    const atHead = await navState();
    check(atHead.prev === true && atHead.next === false,
      'parked before every key, there is nowhere back and somewhere forward',
      `prev disabled ${atHead.prev}, next disabled ${atHead.next}`);

    // Read before pressing, and fail the row rather than driving a control that is not there: an
    // unguarded `click` on a disabled button waits out its full timeout and ends
    // the run as a crash.
    const walk = async (button, want, label) => {
      const before = await navState();
      const armed = button === '#tNextKey' ? !before.next : !before.prev;
      if (!armed) {
        check(false, label, `the control was disabled before the press, so the walk stopped short of ${want}s`);
        return false;
      }
      await page.locator(button).click();
      await settle();
      const landed = await at();
      check(near(landed, want, 1e-3), label,
        `landed ${landed.toFixed(4)}s against the key's ${want.toFixed(4)}s`);
      return true;
    };

    for (const want of KEYS) await walk('#tNextKey', want, `next walks to the key at ${want}s`);

    const atTail = await navState();
    check(atTail.next === true && atTail.prev === false,
      'and on the last key there is nowhere further forward',
      `prev disabled ${atTail.prev}, next disabled ${atTail.next}`);

    for (const want of [5, 1]) await walk('#tPrevKey', want, `prev walks back to the key at ${want}s`);

    await setTracks({ bloom: [] });
    await park(4);
    const empty = await navState();
    check(empty.prev === true && empty.next === true,
      'a track with no keys offers neither direction',
      `prev disabled ${empty.prev}, next disabled ${empty.next}`);
  }

  console.log('\n[19] the preset picker: roles, a keyboard, and a delete that leaves a caret somewhere');

  {
    const trigger = '#tPreset';
    const list = '#tPresetList';
    const shape = async () => page.evaluate(`(() => {
      const t = document.getElementById('tPreset');
      const l = document.getElementById('tPresetList');
      const options = [...l.querySelectorAll('.pickeroption')];
      return {
        role: t.getAttribute('role'),
        popup: t.getAttribute('aria-haspopup'),
        expanded: t.getAttribute('aria-expanded'),
        listRole: l.getAttribute('role'),
        hidden: l.hidden,
        value: t.value,
        shown: t.querySelector('.pickervalue').textContent,
        names: options.map((o) => o.dataset.name),
        optionRoles: [...new Set(options.map((o) => o.getAttribute('role')))],
        deletable: options.filter((o) => o.querySelector('.pickerdelete')).map((o) => o.dataset.name),
        builtin: options.filter((o) => o.dataset.builtin === 'true').map((o) => o.dataset.name),
        add: (() => { const a = document.getElementById('tPresetAdd'); return a ? [a.offsetWidth, a.offsetHeight] : null; })(),
        // Or-else and not nullish-coalescing. The DOM answers an absent id or dataset key
        // with the empty string, which is not nullish, so nullish-coalescing stops there
        // and reports it - and a row asking whether focus is off the body then passes on a
        // caret that is exactly on it. Measured: the drops-focus control came back NOT
        // CAUGHT at 415 assertions and none failed while this line coalesced. The suite
        // notes carry the same trap costing the library two red rows about nothing.
        focus: document.activeElement?.classList?.contains('pickeroption')
          ? document.activeElement.dataset.name
          : (document.activeElement?.id || document.activeElement?.tagName || 'nothing'),
        focusIsOption: Boolean(document.activeElement?.classList?.contains('pickeroption')),
      };
    })()`);

    const shut = await shape();
    check(shut.role === 'combobox' && shut.popup === 'listbox' && shut.listRole === 'listbox'
      && shut.optionRoles.length === 1 && shut.optionRoles[0] === 'option' && shut.names.length > 1,
      'the picker announces itself as a listbox and every entry in it as an option',
      `trigger ${shut.role}/${shut.popup}, list ${shut.listRole}, `
      + `${shut.names.length} entries as ${shut.optionRoles.join('/') || 'nothing'}`);
    await page.click(trigger);
    const open = await shape();
    // Measured with the list open: the add button lives inside the list, a shut list is `hidden`,
    // and a hidden element's box is 0x0 - so the first spelling of this row read `0x0` against a
    // control that is exactly the size it should be.
    check(open.add && open.add[0] === 24 && open.add[1] === 24,
      'and it carries the 24x24 add button the design draws',
      open.add ? `${open.add[0]}x${open.add[1]}` : 'no add button');
    check(open.hidden === false && open.expanded === 'true' && open.focusIsOption
      && open.names.includes(open.focus),
      'opening it says so and hands the caret to an entry rather than leaving it on the trigger',
      `expanded ${open.expanded}, focus on ${open.focus || '(none)'}`);

    await page.keyboard.press('ArrowDown');
    const down = (await shape()).focus;
    await page.keyboard.press('ArrowUp');
    const up = (await shape()).focus;
    check(down !== up && open.names.includes(down) && open.names.includes(up),
      'the arrow keys walk the entries, which is the whole of what a native option gave away',
      `down to ${down || '(none)'}, back up to ${up || '(none)'}`);

    const wanted = open.names.find((n) => n !== up && n.length > 1) ?? open.names[0];
    for (const ch of wanted.slice(0, 2)) await page.keyboard.press(ch);
    const typed = (await shape()).focus;
    check(typed === wanted, 'and typing a name reaches it, so a long library is navigable without the pointer',
      `typed ${JSON.stringify(wanted.slice(0, 2))} and landed on ${typed}, wanted ${wanted}`);

    await page.keyboard.press('Escape');
    const escaped = await shape();
    check(escaped.hidden === true && escaped.focus === 'tPreset',
      'Escape shuts it and puts the caret back on the trigger rather than on the body',
      `hidden ${escaped.hidden}, focus ${escaped.focus}`);

    const PLANTED = `ec${process.pid}-picker`;
    const seed = await (await fetch(`${URL_BASE}/presets/${encodeURIComponent(shut.names[0])}`)).json();
    await writePresetDoc(PLANTED, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: seed.version, values: seed.values }),
    });
    await page.evaluate('__kinect.library.refreshPresets()');
    const planted = await shape();
    // The list is the shipped looks, whatever has been saved, and the `none` row at the top - an
    // entry with no name and no file behind it, so it is neither shipped nor deletable and a rule
    // reading "everything but the planted one is builtin" counts it as a shipped look
    // that lost its badge.
    const named = planted.names.filter((n) => n !== '');
    check(planted.names.includes(PLANTED) && planted.deletable.join(',') === PLANTED
      && planted.builtin.length === named.length - 1,
      'a delete is drawn on the entries that have one and on no others, which is the shipped looks left alone',
      `${planted.names.length} entries, ${planted.builtin.length} shipped, deletable: `
      + `${planted.deletable.join(', ') || 'none'}`);

    await page.click(trigger);
    await page.focus(`${list} .pickeroption[data-name="${PLANTED}"]`);
    await page.click(`${list} .pickeroption[data-name="${PLANTED}"] .pickerdelete`);
    await page.waitForFunction(
      '!globalThis.__kinect.library.presetGestureRunning()', null, { timeout: 15000 },
    );
    const after = await shape();
    check(!after.names.includes(PLANTED),
      'deleting an entry takes it out of the library the picker is drawn from',
      `${after.names.length} entries: ${after.names.join(', ')}`);
    // Asked positively rather than as "not the body": a negative row is satisfied by every value
    // the probe could report by mistake, which is how the first spelling of this one passed
    // against a build that stranded focus exactly as its mutation intended.
    check(after.names.includes(after.focus) || after.focus === 'tPreset',
      'and the caret survives the rebuild the delete causes, landing on an entry or the trigger',
      `focus landed on ${after.focus}, of ${after.names.join(', ')} or the trigger`);
  }

  console.log('\n[20] the crop box: shown, dragged, and paid for out of the animation loop');

  {
    await page.locator('#panelTabFraming').click();
    await page.evaluate('__kinect.timeline.transport().pause()');
    await settle();

    const handles = (plan) => page.evaluate(`__kinect.cropHandles(${plan})`);
    const shownBefore = await page.evaluate('__kinect.cropBoxShown()');
    const beforePress = await handles(false);
    check(shownBefore === false && beforePress.length === 0,
      'the box is off until it is asked for, and offers nothing to grab',
      `shown ${shownBefore}, ${beforePress.length} handles`);

    await page.locator('#cropBox').click();
    await settle();
    const pressed = await page.locator('#cropBox').getAttribute('aria-pressed');
    check(await page.evaluate('__kinect.cropBoxShown()') === true && pressed === 'true',
      'pressing it turns the box on and says so on the control', `aria-pressed ${pressed}`);

    check(await page.evaluate('__kinect.cropOutside()') > 0,
      'and what the box is cutting draws faintly instead of vanishing while it is on');

    // Faces placed against this fixture rather than at round numbers: the cloud runs x [-2.31,
    // 2.97] and y [-2.26, 1.63], so a box at +/-0.8 has something to cull on every side and a
    // handle on each face has cloud behind it rather than empty stage.
    await page.evaluate(`(() => {
      for (const [n, v] of [['left', -0.8], ['right', 0.8], ['bottom', -0.8], ['top', 0.8], ['far', 3]]) {
        __kinect.params.set(n, v);
      }
    })()`);
    await settle();

    // Which faces can be dragged is a measurement, not a list, and the two views disagreeing about
    // it is the evidence: a face pointing along the line of sight projects its own movement onto
    // nothing, which is why the top-down offers the four upright faces and refuses
    // `bottom` and `top`.
    const planHandles = await handles(true);
    const planNames = planHandles.map((h) => h.param).sort();
    check(!planNames.includes('bottom') && !planNames.includes('top')
      && planNames.includes('near') && planNames.includes('far'),
      'the top-down offers the faces it can show the movement of, and refuses the two it cannot',
      `plan offers ${planNames.join(' ') || 'nothing'}`);
    check(planHandles.every((h) => Math.hypot(h.sx, h.sy) > 0),
      'and every handle it does offer carries a screen scale for the drag to divide by');

    // ---- the drag itself
    const grab = (await handles(false)).find((h) => h.param === 'right');
    check(Boolean(grab), 'the right face is grabbable in the picture');
    if (grab) {
      const canvas = await page.evaluate(`(() => {
        const r = __kinect.renderer.domElement.getBoundingClientRect();
        return { x: r.x, y: r.y };
      })()`);
      const from = await page.evaluate("__kinect.params.get('right')");
      // The setup above wrote through the registry without committing, so the drag's own commit
      // would otherwise be the first snapshot since the section started and one undo would walk
      // back past the box this row is about.
      await page.evaluate('__kinect.keyframes.undo.commit()');

      // Installed before the counters are read, or the first read is of a variable that does not
      // exist yet and every count below comes out NaN - which reads as a row that fired rather
      // than one that never measured anything.
      await page.evaluate(`(() => {
        globalThis.__cropFrames = 0;
        const tick = () => { globalThis.__cropFrames++; requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      })()`);
      // The control the row below is measured against, taken here rather than reasoned about:
      // every pointer move writes a registry value, and a registry write on a parked playhead is
      // a draft the transport renders, so both builds do that much.
      const MOVES = 24;
      const writeOnly = await page.evaluate(`(async () => {
        const start = __kinect.timeline.counters.renders;
        for (let i = 1; i <= ${MOVES}; i++) {
          __kinect.params.set('right', 0.8 - i * 0.01);
          await new Promise(requestAnimationFrame);
        }
        return __kinect.timeline.counters.renders - start;
      })()`);
      await page.evaluate("__kinect.params.set('right', 0.8)");
      await settle();

      const before = await page.evaluate(
        '({ renders: __kinect.timeline.counters.renders, frames: globalThis.__cropFrames })');

      const x0 = canvas.x + grab.x;
      const y0 = canvas.y + grab.y;
      await page.mouse.move(x0, y0);
      await page.mouse.down();
      for (let i = 1; i <= MOVES; i++) {
        await page.mouse.move(x0 - i * 4, y0);
        await page.evaluate('new Promise(requestAnimationFrame)');
      }
      const during = await page.evaluate("__kinect.params.get('right')");
      const shownDuring = await page.evaluate("document.getElementById('right').value");
      // Read at the release rather than after `settle()`, which drains an accurate seek and renders
      // a pre-roll nobody asked this row about.
      const after = await page.evaluate(
        '({ renders: __kinect.timeline.counters.renders, frames: globalThis.__cropFrames })');
      await page.mouse.up();
      await settle();
      const moved = from - during;
      const predicted = (MOVES * 4) / Math.abs(grab.sx);
      note('dragging the right face', `${from} -> ${during} m over ${MOVES * 4} px `
        + `at ${Math.abs(grab.sx).toFixed(1)} px/m, predicted ${predicted.toFixed(3)} m`);
      check(Math.abs(moved - predicted) <= 0.06,
        'the face follows the pointer by the scale its handle reported, in the face\'s own metres',
        `moved ${moved.toFixed(3)} m against ${predicted.toFixed(3)} m predicted`);
      check(String(during) === shownDuring,
        'and the write goes through the registry, so the slider beside it reads the drag',
        `parameter ${during}, slider ${shownDuring}`);
      // Asserted by undoing rather than by counting the stack, because the stack has a ceiling: a
      // session at its cap grows by nothing whatever a gesture pushed, so a depth comparison
      // reads a build that committed twenty-four times as one that committed once.
      await page.evaluate('__kinect.keyframes.undo.pop()');
      await settle();
      const undone = await page.evaluate("__kinect.params.get('right')");
      check(undone === from,
        'one snapshot for the whole gesture, so one undo puts the face back where it started',
        `undo left it at ${undone}, started at ${from}`);
      await page.evaluate("__kinect.params.set('right', 0.8)");

      // A handler that rendered would be asking for the next render itself: `renderProgramFrame`
      // runs `advanceNavigation`, which calls `controls.update()`, which fires `change` on
      // a damped control.
      const renders = after.renders - before.renders;
      const frames = after.frames - before.frames;
      note(`${MOVES} pointer moves on a crop handle`,
        `${renders} renders over ${frames} animation frames, against ${writeOnly} `
        + `for the same ${MOVES} writes with no pointer`);
      check(frames > 0, 'the animation loop ran during the drag', `${frames} frames`);
      check(renders > 0, 'and the drag was drawn at all', `${renders} renders`);
      // A handler that rendered would add one render per move on top of the writes it is already
      // making, so the mutated build lands a full `MOVES` above the control.
      check(renders <= writeOnly + MOVES / 2,
        'and it asked the loop for those renders rather than rendering out of the handler',
        `${renders} renders against ${writeOnly} for the writes alone`);
    }

    await page.evaluate("__kinect.params.reset(['left', 'right', 'bottom', 'top', 'near', 'far'])");
    await page.locator('#cropBox').click();
    await settle();
    check(await page.evaluate('__kinect.cropOutside()') === 0
      && (await handles(false)).length === 0,
      'pressing it again takes the box, its handles and the faint pass back off');
  }

  console.log('\n[21] the panel collapses, and what it collapses to is a fact about the surface');
  // The enumeration was never the hole here: the sweep is a `querySelectorAll` with no visibility
  // filter, so a `display: none` button is enumerated like any other.
  {
    const DOCK_IDS = ['menuShowSidebar', 'dockCentre', 'dockSensor', 'dockMark', 'dockRec'];
    const swept = DOCK_IDS.filter((id) => sweep.some((row) => row.id === id));
    check(swept.length === DOCK_IDS.length,
      'the collapse and its dock are inside the enumeration section 1 sweeps',
      `${swept.length} of ${DOCK_IDS.length}: ${swept.join(', ') || 'none'}`);

    const BAR_IDS = ['panelDock', 'dockCentre', 'dockSensor', 'dockRec', 'dockMark'];
    const GEOMETRY = `(() => {
      const box = (id) => {
        const el = document.getElementById(id);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom),
                 w: Math.round(r.width), h: Math.round(r.height) };
      };
      // Whether a control is drawn, and separately what its own cascade says about it.
      // Those are two questions and this section needs both, because everything inside a
      // hidden bar is undrawn whatever its own rules say - so a row asking only the first
      // cannot tell a control the surface withholds from one the bar took away with it.
      // The take-pair row below is that distinction and nothing else.
      const isDrawn = (id) => {
        const el = document.getElementById(id);
        return Boolean(el) && el.checkVisibility({ checkVisibilityCSS: true });
      };
      const displayOf = (id) => {
        const el = document.getElementById(id);
        return el ? getComputedStyle(el).display : 'absent';
      };
      const ids = ${JSON.stringify(BAR_IDS)};
      const canvas = document.querySelector('canvas');
      const r = canvas.getBoundingClientRect();
      const panel = document.getElementById('panel');
      return {
        collapsed: document.body.classList.contains('panelcollapsed'),
        // aria-checked on the View menu's entry, and it reads the opposite way round to
        // the aria-pressed this used to ask for. The control moved off the app bar into
        // the menu in fb03887 and became a checkbox item saying whether the sidebar is
        // shown, where the button it replaced said whether the panel was shut - main.js
        // sets it as String(!collapsed). Reading the old id here threw on null and took
        // the rest of this file down with it, so the two states are named apart rather
        // than left to a reader to invert. No backticks anywhere in this evaluate: it is
        // a template literal and one would end the string early.
        shown: document.getElementById('menuShowSidebar').getAttribute('aria-checked'),
        drawn: Object.fromEntries(ids.map((id) => [id, isDrawn(id)])),
        display: Object.fromEntries(ids.map((id) => [id, displayOf(id)])),
        panel: box('panel'), dock: box('panelDock'), timeline: box('timeline'),
        // What a collapsed editor's panel is allowed to be and no more, read off the
        // panel rather than written down as a 1 - a border drawn a pixel wider would
        // otherwise fail a row about the inspector's tab rail for a reason that is
        // about the border.
        panelBorder: Math.round(parseFloat(getComputedStyle(panel).borderTopWidth) || 0),
        canvasBottom: Math.round(r.bottom), buffer: canvas.height,
      };
    })()`;
    const geometry = () => page.evaluate(GEOMETRY);

    const open = await geometry();
    check(open.collapsed === false && open.shown === 'true' && open.dock.h === 0,
      'the panel opens as the column it has always been, with no dock drawn',
      `panel ${open.panel.w}x${open.panel.h}, dock ${open.dock.h}px, aria-checked ${open.shown}`);

    await page.locator('#viewMenuButton').click();
    await page.locator('#menuShowSidebar').click();
    await settle();
    const shut = await geometry();
    check(shut.collapsed === true && shut.shown === 'false',
      'the menu\'s entry shuts it, and the control says which way it is',
      `aria-checked ${shut.shown}, body reads ${shut.collapsed ? 'collapsed' : 'expanded'}`);

    // ---- what the editor collapses to, which is nothing ----
    // `body.editing.panelcollapsed #panelDock { display: none }` - the dock is the panel's
    // collapsed form, so an editor with no panel has no dock either.
    check(shut.display.panelDock === 'none',
      'the collapsed editor draws no dock at all, because the dock is the panel collapsed and this surface has no panel',
      `#panelDock computes to ${shut.display.panelDock}, box ${shut.dock.h}px`);

    // ---- the two that act on the take, withheld by a rule of their own ----
    // This row replaced three that passed by comparing nothing: they read `#dockRec` against
    // `#recGo` on the theory that a dock painted from one place cannot drift from what it
    // mirrors, but `askRecordState` is assigned only on the live surface, so on the editor the
    // comparison is `record` against `record` and `null` against `null`.
    const withheld = ['dockRec', 'dockMark'].every((id) => shut.display[id] === 'none');
    const kept = ['dockCentre', 'dockSensor'].every((id) => shut.display[id] !== 'none'
      && shut.display[id] !== 'absent');
    check(withheld && kept,
      'and the two that act on the take are withheld by a rule of their own rather than by the bar being gone',
      `record ${shut.display.dockRec} and mark ${shut.display.dockMark}, against `
      + `centre ${shut.display.dockCentre} and sensor ${shut.display.dockSensor}`);

    // ---- and the picture takes the height back ----
    // `resize()` subtracts `#panelDock`'s `offsetHeight` from the height available to the stage
    // while the body is collapsed, which is what stops a frame being rendered full height under a
    // bar drawn over its last 72px.
    check(shut.canvasBottom === shut.timeline.top,
      'and the picture runs down to the timeline strip, taking back the height a dock would have occupied',
      `canvas bottom ${shut.canvasBottom}, strip top ${shut.timeline.top}`);
    // The collapsed panel's own box, which is the cascade rather than the arithmetic: the panel and
    // the strip are both `position: fixed` at the same `z-index`, so the one written later wins.
    check(shut.panel.bottom === shut.timeline.top,
      'the collapsed panel stops exactly where the timeline strip starts rather than over it',
      `panel bottom ${shut.panel.bottom}, strip top ${shut.timeline.top}`);
    check(shut.panel.h === shut.panelBorder,
      'with nothing left in the collapsed editor panel but the line along the top of it',
      `panel ${shut.panel.h}px against a ${shut.panelBorder}px border`);

    await focusStage();
    await page.keyboard.press('h');
    await settle();
    const back = await geometry();
    check(back.collapsed === false && back.shown === 'true',
      'the H key drives the same state, and the entry it never touched agrees about it',
      `aria-checked ${back.shown}`);
    check(back.panel.w === open.panel.w && back.panel.h === open.panel.h
      && back.buffer === open.buffer,
      'and the panel and the buffer come back to exactly what they were',
      `panel ${back.panel.w}x${back.panel.h} buffer ${back.buffer}, `
      + `against ${open.panel.w}x${open.panel.h} and ${open.buffer}`);

    await page.keyboard.press('h');
    await settle();
    const shutAgain = await geometry();
    check(shutAgain.collapsed === true && shutAgain.shown === 'false',
      'and the key shuts it as well as opens it, so the two controls are one state',
      `aria-checked ${shutAgain.shown}`);

    // ---- the same collapse on the surface the dock was built for ----
    // A second page rather than a navigation, because the editor page has to survive into section
    // 22 with its take open.
    const RECORDER_PATH = '/record';
    const recErrors = [];
    let recorder = null;
    let recWhy = '';
    try {
      const recContext = await page.context().browser().newContext({
        viewport: VIEWPORT, deviceScaleFactor: 1,
      });
      const recPage = await recContext.newPage();
      recPage.on('pageerror', (err) => recErrors.push(String(err)));
      recPage.on('console', (msg) => { if (msg.type() === 'error') recErrors.push(msg.text()); });
      await recPage.route('**/favicon.ico', (route) => route.fulfill({ status: 204, body: '' }));
      const recMutant = await serveMutation(recPage, RECORDER_PATH);
      await recPage.goto(`${URL_BASE}${RECORDER_PATH}?panel=collapsed`, { waitUntil: 'load' });
      await recPage.waitForFunction('!!globalThis.__kinect', null, { timeout: 30000 });
      await recPage.evaluate('__kinect.timeline.settled()');
      if (MUTATE && recMutant.served() === 0) {
        throw new Error(`${MUTATE} was staged for ${mutation.file} at ${recMutant.path} and the `
          + "recorder page never requested it, so this arm ran the tree's own build");
      }
      recorder = { page: recPage, close: () => recContext.close() };
    } catch (err) {
      recWhy = err.message.split('\n')[0];
    }

    if (!recorder) {
      // Not a finding, and not a pass either: every row in the arm below is about the recorder,
      // so a page that never opened leaves them untested rather than failed.
      untested = 'the recorder arm never opened, so the six dock rows section 21 owns did not run'
        + ` - ${recWhy}`
        + (recErrors.length ? ` - the page said: ${recErrors.slice(0, 3).join(' | ')}` : '');
      note('the recorder arm did not run', recWhy
        + (recErrors.length ? ` - the page said: ${recErrors.slice(0, 3).join(' | ')}` : ''));
    } else {
      try {
        const rec = await recorder.page.evaluate(GEOMETRY);
        check(BAR_IDS.every((id) => rec.drawn[id]),
          'the same collapse on the recorder draws the dock and all four of its buttons, so the editor\'s absences are a difference between the surfaces',
          `${BAR_IDS.map((id) => `${id} ${rec.drawn[id]}`).join(', ')}, `
          + `body reads ${rec.collapsed ? 'collapsed' : 'expanded'}`);
        check(rec.canvasBottom === rec.dock.top,
          'and there the picture ends exactly where the dock begins, rather than continuing behind it',
          `canvas bottom ${rec.canvasBottom}, dock top ${rec.dock.top}`);

        // Pressable, and asked at the point a finger actually lands rather than inferred from the
        // boxes above: a dock underneath something else measures as exactly the right size in
        // exactly the right place while answering no thumb at all.
        const onTop = await recorder.page.evaluate(`(() => {
          const el = document.getElementById('dockCentre');
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return { what: hit ? (hit.id || hit.className || hit.tagName) : null,
                   own: hit === el || el.contains(hit) };
        })()`);
        check(onTop.own,
          'and a press at the middle of a dock button reaches that button',
          `the point belongs to ${onTop.what}`);

        // ---- the dock presses the panel's own controls, read as the pose each lands ----
        const recSettle = () => recorder.page.evaluate('__kinect.timeline.settled()');
        const pose = `(() => { const c = __kinect.freeCamera;
          return [+c.position.x.toFixed(4), +c.position.y.toFixed(4), +c.position.z.toFixed(4)]; })()`;
        const flick = async () => {
          const stage = await recorder.page.evaluate(`(() => {
            const r = document.getElementById('stage').getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          })()`);
          await recorder.page.mouse.move(stage.x, stage.y);
          await recorder.page.mouse.down();
          await recorder.page.mouse.move(stage.x + 60, stage.y + 30);
          await recorder.page.mouse.up();
          await recSettle();
        };

        if (!onTop.own) {
          // Skipped rather than attempted, and said out loud: a `click()` on a covered element
          // retries for thirty seconds and then throws, which ends the file as a crash.
          note('the two pose comparisons did not run, nor the row that separates them',
            'nothing can press a dock that whatever is over it is taking the presses for - '
            + 'three rows short, and the row above carries what this build is');
        } else {
          // The two reference controls are pressed synthetically and the two dock buttons are
          // not: `#menuCameraReset` is inside a closed menu and `#camSensor` is inside the panel
          // this arm has collapsed, so neither is reachable by a hand right now.
          await recorder.page.evaluate("document.getElementById('menuCameraReset').click()");
          await recSettle();
          const centreByMenu = await recorder.page.evaluate(pose);
          await flick();
          await recorder.page.locator('#dockCentre').click();
          await recSettle();
          const centreByDock = await recorder.page.evaluate(pose);
          check(JSON.stringify(centreByDock) === JSON.stringify(centreByMenu),
            'the dock\'s centre lands the pose the View menu\'s own reset lands',
            `dock ${centreByDock.join(', ')} against menu ${centreByMenu.join(', ')}`);

          await recorder.page.evaluate("document.getElementById('camSensor').click()");
          await recSettle();
          const sensorByPanel = await recorder.page.evaluate(pose);
          check(JSON.stringify(sensorByPanel) !== JSON.stringify(centreByMenu),
            'and the sensor\'s pose is a different place from the centred one, so the row below can tell them apart',
            `sensor ${sensorByPanel.join(', ')} against centre ${centreByMenu.join(', ')}`);
          await recorder.page.evaluate("document.getElementById('menuCameraReset').click()");
          await recSettle();
          await recorder.page.locator('#dockSensor').click();
          await recSettle();
          const sensorByDock = await recorder.page.evaluate(pose);
          check(JSON.stringify(sensorByDock) === JSON.stringify(sensorByPanel),
            'and the dock\'s sensor lands the pose Framing\'s own sensor view lands',
            `dock ${sensorByDock.join(', ')} against panel ${sensorByPanel.join(', ')}`);
        }
        await proveRecorderNavigation(recorder.page);
        check(recErrors.length === 0, 'recorder navigation raises no page errors', recErrors.join(' | '));
      } finally {
        // Closed before the editor is put back, so the last gesture of this section goes to the
        // page section 22 inherits and nothing is left holding a socket on the shooting server.
        await recorder.close().catch(() => {});
      }
    }

    note('what this section cannot catch',
      'what the take pair do once pressed. `record` and `mark` forward to `#recGo` and '
      + '`#recMark`, whose outcome is a take written into `captures/` or a refusal from '
      + 'the server, and neither is reachable from here without editing the library this '
      + 'file measures. What is enforced is where they are: the recorder draws them and '
      + 'the editor withholds them by a rule this section reads');

    await focusStage();
    await page.keyboard.press('h');
    await settle();
  }


  console.log('\n[22] a press on the stage moves the orbit pivot to the depth under the pointer');

  // Everything below plants a depth grid and dispatches the press in one task, because
  // `depthCurr` is swapped on every bind and a frame arriving between the two would leave the
  // sweep reading a different room from the one the row is about.
  {
    /**
     * A press at the middle of the stage over a grid of one range, and what the camera and the
     * pivot were either side of it.
     *
     * `mm` of 0 is a grid with no returns anywhere, which is the empty-space case.
     */
    const pressOn = (mm, opts = {}) => page.evaluate(`((mm, opts) => {
      const k = __kinect;
      const c = k.freeCamera;
      const fwd = c.getWorldDirection(new (c.position.constructor)());
      const before = {
        p: c.position.toArray(), q: c.quaternion.toArray(),
        target: k.controls.target.toArray(),
        clears: k.timeline.counters.navigationHistoryClears,
      };
      const depth = new Uint16Array(512 * 424);
      if (opts.singleton) depth[212 * 512 + 256] = mm;
      else depth.fill(mm);
      k.drive.injectDepth(depth);
      const r = document.getElementById('stage').getBoundingClientRect();
      const at = opts.singleton
        ? (() => {
          const z = mm * 0.001;
          const focal = k.uniforms.focal.value;
          const center = k.uniforms.center.value;
          const point = new (c.position.constructor)(
            (-(256.5 - center.x) / focal.x) * z,
            -((212.5 - center.y) / focal.y) * z,
            -z,
          ).applyQuaternion(new (c.quaternion.constructor)().fromArray(k.worldTilt())).project(c);
          return { x: r.x + ((point.x + 1) / 2) * r.width, y: r.y + ((1 - point.y) / 2) * r.height };
        })()
        : opts.inset
        ? (() => { const i = k.keyframes.chrome.inset(); return { x: r.x + i.x + i.w / 2, y: r.y + i.y + i.h / 2 }; })()
        : { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      document.getElementById(opts.on ?? 'stage').dispatchEvent(new PointerEvent('pointerdown', {
        button: opts.button ?? 0, buttons: 1, clientX: at.x, clientY: at.y,
        ctrlKey: opts.ctrlKey ?? false, metaKey: opts.metaKey ?? false,
        shiftKey: opts.shiftKey ?? false,
        bubbles: true, cancelable: true, pointerId: 71,
      }));
      const t = k.controls.target;
      const after = { target: t.toArray(), dist: t.distanceTo(c.position) };
      // Where the pivot sits relative to the way the camera is pointing. 1 is dead on the axis,
      // which is the property that makes the press cost nothing to look at.
      after.onAxis = t.clone().sub(c.position).normalize().dot(fwd);
      return { before, after };
    })(${mm}, ${JSON.stringify(opts)})`);

    /** How far apart two poses are, in metres and in quaternion components. */
    const poseApart = (a, b) => Math.max(
      ...a.p.map((v, i) => Math.abs(v - b.p[i])),
      ...a.q.map((v, i) => Math.abs(v - b.q[i])),
    );

    await page.evaluate('__kinect.timeline.transport().pause()');
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    // Read before any press, which is the whole of what makes the Reset row below an assertion.
    // Read after them it is `target0` against itself, and a build whose press calls `saveState()`
    // passes it - which is exactly what happened, and was caught only by reading which rows fired
    // rather than the run's verdict.
    const home = await page.evaluate('__kinect.controls.target0.toArray()');
    // From the sensor's own pose, so a range down the optical axis and a range from the camera
    // are the same number and the row can name the metres it expects.
    await page.evaluate('__kinect.sensorView()');
    await settle();

    const wall = await pressOn(3000);
    check(Math.abs(wall.after.dist - 3.0) < 0.02,
      'a press on a wall three metres out puts the pivot three metres out',
      `${wall.after.dist.toFixed(4)} m, from a pivot at ${
        Math.hypot(...wall.before.target.map((v, i) => v - wall.before.p[i])).toFixed(4)} m`);
    check(Math.abs(wall.after.onAxis - 1) < 1e-9,
      'and on the view axis, which is why the press changes nothing to look at',
      `the pivot lies ${wall.after.onAxis.toFixed(12)} along the way the camera points`);

    // The same press over a different room. Without this the row above passes on a build that
    // writes a constant.
    const near = await pressOn(1200);
    check(Math.abs(near.after.dist - 1.2) < 0.02,
      'and a press on a wall at 1.2 m puts it at 1.2 m, so the pivot reads the depth rather than a constant',
      `${near.after.dist.toFixed(4)} m against the ${wall.after.dist.toFixed(4)} m of the same press on a 3 m wall`);

    const held = await page.evaluate('__kinect.controls.target.toArray()');
    const empty = await pressOn(0);
    const emptyDrift = Math.max(...empty.after.target.map((v, i) => Math.abs(v - held[i])));
    check(emptyDrift === 0,
      'a press with nothing under it leaves the pivot exactly where it was',
      `${empty.after.target.map((v) => v.toFixed(12)).join(', ')} against `
      + `${held.map((v) => v.toFixed(12)).join(', ')}, worst drift ${emptyDrift.toExponential(2)}`);

    const singleton = await pressOn(300, { singleton: true });
    check(singleton.after.target.every((v, i) => v === singleton.before.target[i]),
      'a lone depth sample in otherwise empty space leaves the pivot alone',
      `${singleton.after.target.map((v) => v.toFixed(6)).join(', ')} against `
      + `${singleton.before.target.map((v) => v.toFixed(6)).join(', ')}`);

    // The far clip at 2 m with the box cutting, so a 3 m wall is geometry the renderer discards.
    const cropBefore = await page.evaluate("__kinect.params.values(['crop', 'far'])");
    await page.evaluate('__kinect.params.apply({ crop: true, far: 2.0 })');
    await settle();
    const cropped = await pressOn(3000);
    check(cropped.after.target.every((v, i) => v === cropped.before.target[i]),
      'and a press on geometry outside the crop box leaves it alone, rather than pivoting on what was discarded',
      `${cropped.after.target.map((v) => v.toFixed(6)).join(', ')} against `
      + `${cropped.before.target.map((v) => v.toFixed(6)).join(', ')} with the far clip at 2 m`);
    await page.evaluate(`__kinect.params.apply(${JSON.stringify(cropBefore)})`);
    await settle();

    // What the press costs the screen-space history, measured against two controls in the same
    // conditions rather than asserted. **The press is not free, and the plan this was built from
    // said it would be.** `OrbitControls.update()` rebuilds `position` out of `target` on every
    // frame, so any write to the pivot re-rounds the position by about an ulp, and
    // `renderedCameraChanged` compares exactly. A right-drag pan has always paid the same price
    // on every move; a press pays it once, and the drag it precedes clears on every frame anyway.
    const clears = await page.evaluate(`(() => {
      const k = __kinect;
      const at = () => k.timeline.counters.navigationHistoryClears;
      const step = () => { k.controls.update(0); k.drive.stepTo(4.0); };
      step();
      const a = at(); step(); const still = at() - a;
      const b = at();
      const t0 = k.controls.target.toArray();
      k.controls.target.set(t0[0] + 0.01, t0[1], t0[2]);
      step();
      const panned = at() - b;
      k.controls.target.fromArray(t0);
      step();
      const c = at();
      k.drive.injectDepth(new Uint16Array(512 * 424).fill(2500));
      const r = document.getElementById('stage').getBoundingClientRect();
      document.getElementById('stage').dispatchEvent(new PointerEvent('pointerdown', {
        button: 0, buttons: 1, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
        bubbles: true, cancelable: true, pointerId: 71,
      }));
      step();
      return { still, panned, pressed: at() - c };
    })()`);
    note('what a press costs the screen-space history',
      `${clears.pressed} clears, where a still camera costs ${clears.still} and one step of a pan costs ${clears.panned}`);
    check(clears.still === 0,
      'control: a still camera clears no screen-space history, so the counts below are about the writes',
      `${clears.still} clears over one step`);
    check(clears.panned === 1 && clears.pressed === 1,
      'and a press costs exactly what one step of a right-drag pan costs, which this build has always paid',
      `${clears.pressed} against ${clears.panned} for the pan`);

    // The bit-identity the plan asked for is not reachable through `OrbitControls`, so what is
    // asserted is the thing that was actually wanted: the picture does not move.
    const moved = await page.evaluate(`(() => {
      const k = __kinect, c = k.freeCamera;
      const p0 = c.position.toArray(), q0 = c.quaternion.toArray();
      k.drive.injectDepth(new Uint16Array(512 * 424).fill(3500));
      const r = document.getElementById('stage').getBoundingClientRect();
      document.getElementById('stage').dispatchEvent(new PointerEvent('pointerdown', {
        button: 0, buttons: 1, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2,
        bubbles: true, cancelable: true, pointerId: 71,
      }));
      k.controls.update(0);
      return { p: p0, q: q0, p1: c.position.toArray(), q1: c.quaternion.toArray() };
    })()`);
    const drift = poseApart({ p: moved.p, q: moved.q }, { p: moved.p1, q: moved.q1 });
    check(drift < 1e-12,
      'and the camera the press leaves behind is the camera it found, to well under a nanometre',
      `worst component moved ${drift.toExponential(2)}`);

    // A drag after the press turns about the new pivot, which is the whole feature.
    const orbited = await page.evaluate(`(() => {
      const k = __kinect, c = k.freeCamera;
      const t = k.controls.target;
      const held = t.distanceTo(c.position);
      const from = c.position.toArray();
      const offset = c.position.clone().sub(t).applyAxisAngle(c.up, 0.3);
      c.position.copy(t).add(offset);
      k.controls.update(0);
      return { held, after: t.distanceTo(c.position), target: t.toArray(),
        travelled: Math.hypot(...c.position.toArray().map((v, i) => v - from[i])) };
    })()`);
    check(orbited.travelled > 0.1 && Math.abs(orbited.after - orbited.held) < 1e-6,
      'a drag after the press turns about the new pivot, keeping its range',
      `the camera travelled ${orbited.travelled.toFixed(3)} m and stayed ${
        orbited.after.toFixed(6)} m out, from ${orbited.held.toFixed(6)}`);

    // Reset must still go to the home pose, not to wherever the last press landed.
    await page.evaluate("document.getElementById('menuCameraReset').click()");
    await settle();
    const afterReset = await page.evaluate('__kinect.controls.target.toArray()');
    check(afterReset.every((v, i) => Math.abs(v - home[i]) < 1e-9),
      'and Reset still goes to the home pose rather than to the pivot the last press picked',
      `${afterReset.map((v) => v.toFixed(4)).join(', ')} against a home of ${home.map((v) => v.toFixed(4)).join(', ')}`);

    // The top-down inset is not the cloud, and a press in it is the plan view's own gesture.
    await page.evaluate('__kinect.params.apply({ topview: true })').catch(() => {});
    await settle();
    const inset = await pressOn(3000, { inset: true });
    check(inset.after.target.every((v, i) => v === inset.before.target[i]),
      'a press inside the top-down inset leaves the pivot alone, because the inset is not the cloud',
      `${inset.after.target.map((v) => v.toFixed(6)).join(', ')} against `
      + `${inset.before.target.map((v) => v.toFixed(6)).join(', ')}`);

    const right = await pressOn(3000, { button: 2 });
    check(right.after.target.every((v, i) => v === right.before.target[i]),
      'and a right press leaves it alone, so the pan keeps its own button',
      `${right.after.target.map((v) => v.toFixed(6)).join(', ')} against `
      + `${right.before.target.map((v) => v.toFixed(6)).join(', ')}`);

    const modified = await pressOn(3000, { shiftKey: true });
    check(modified.after.target.every((v, i) => v === modified.before.target[i]),
      'and a modified left press leaves it alone, because OrbitControls uses that press to pan',
      `${modified.after.target.map((v) => v.toFixed(6)).join(', ')} against `
      + `${modified.before.target.map((v) => v.toFixed(6)).join(', ')}`);
  }

  // -------------------------------------------------------------------------------------------
  console.log('\n[24] flying, looking and the lens');
  {
    await page.evaluate('__kinect.timeline.transport().pause()');
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();

    // The damping residual is paid off before every reading, because an orbit still travelling
    // reads here as flight.
    const rest = () => page.evaluate(`(() => {
      const k = __kinect;
      const damped = k.controls.enableDamping;
      k.controls.enableDamping = false;
      k.controls.update(0);
      k.controls.enableDamping = damped;
      const c = k.freeCamera;
      const V = c.position.constructor;
      return {
        p: c.position.toArray(),
        up: c.up.clone().normalize().toArray(),
        fwd: c.getWorldDirection(new V()).toArray(),
        target: k.controls.target.toArray(),
        offset: k.controls.target.clone().sub(c.position).toArray(),
        radius: k.controls.target.distanceTo(c.position),
        fov: c.fov,
        // The height the look divides the drag by, which is the renderer's own size and not the
        // element's box: a row expecting a turn has to ask the number the code used.
        stageH: k.renderer.getSize({ set(x, y) { this.x = x; this.y = y; return this; } }).y,
        lens: document.getElementById('camLens').value,
        lensOut: document.getElementById('camLensOut').textContent,
        redraws: k.timeline.counters.navigationRedraws,
        seeks: k.timeline.counters.seeks,
        autoRotate: k.controls.autoRotate,
        enabled: k.controls.enabled,
        free: k.viewCamera() === c,
      };
    })()`);

    const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const cross3 = (a, b) => [
      a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
    ];
    const unit = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
    const flat = (v, pole) => { const k = dot3(v, pole); return unit(v.map((x, i) => x - k * pole[i])); };
    /** The signed angle from `a` to `b` about `pole`, which is what a yaw is and a pitch is not. */
    const yawAbout = (a, b, pole) => {
      const [x, y] = [flat(a, pole), flat(b, pole)];
      return Math.atan2(dot3(cross3(x, y), pole), dot3(x, y));
    };
    /** How far off the pole a direction points, in radians. Grows as the view goes down. */
    const polarTo = (v, pole) => Math.acos(Math.min(1, Math.max(-1, dot3(v, pole))));
    const apart = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));

    /**
     * Hold `keys` for about `ms` and report what the camera did over it. `seeks` is read between
     * the last frame of the hold and the release, so the release's own seek can be told from a
     * redraw that fell back to one. `shift` is not decoration: it is what takes the six keys.
     */
    const fly = async (keys, { ms = 400, shift = true, focus = true } = {}) => {
      if (focus) await focusStage();
      const before = await rest();
      const began = Date.now();
      if (shift) await page.keyboard.down('Shift');
      for (const key of keys) await page.keyboard.down(key);
      await new Promise((r) => setTimeout(r, ms));
      const heldSeeks = await page.evaluate('__kinect.timeline.counters.seeks');
      for (const key of keys) await page.keyboard.up(key);
      if (shift) await page.keyboard.up('Shift');
      const elapsed = (Date.now() - began) / 1000;
      await settle();
      const after = await rest();
      const moved = after.p.map((v, i) => v - before.p[i]);
      return { before, after, moved, elapsed, heldSeeks, length: Math.hypot(...moved) };
    };

    const stage = await page.evaluate(`(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, top: r.y, bottom: r.y + r.height };
    })()`);

    /**
     * A drag across the stage, shifted or bare, and the poses either side of it.
     * `steps` of 1 is one pointer move, which is what the pole rows need: a build with no clamp
     * turns back towards the pole it went through, so a stepped drag past it ends up reading as
     * though it had stopped there.
     */
    const drag = async (dxPx, dyPx, { shift = true, steps = 8, from = null } = {}) => {
      const at = from ?? { x: stage.x - dxPx / 2, y: stage.y - dyPx / 2 };
      const before = await rest();
      if (shift) await page.keyboard.down('Shift');
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.move(at.x + dxPx, at.y + dyPx, { steps });
      await page.mouse.up();
      if (shift) await page.keyboard.up('Shift');
      await settle();
      const after = await rest();
      return { before, after, moved: apart(after.p, before.p) };
    };

    /**
     * One wheel notch over the middle of the stage, shifted or bare. `axis` is not decoration:
     * Chrome turns shift plus a physical wheel into `deltaX`, so the horizontal branch is the
     * one a real mouse takes and rows driven on `deltaY` alone leave it untested.
     */
    const wheel = async (delta, { shift = true, axis = 'y' } = {}) => {
      const before = await rest();
      await page.mouse.move(stage.x, stage.y);
      if (shift) await page.keyboard.down('Shift');
      await page.mouse.wheel(axis === 'x' ? delta : 0, axis === 'x' ? 0 : delta);
      if (shift) await page.keyboard.up('Shift');
      await settle();
      return { before, after: await rest() };
    };

    const armed = await rest();
    // The trail is a precondition and not decoration: `redrawNow` falls back to a full seek while
    // one is up, which would take the seek pair below away without saying so.
    const trails = await page.evaluate("__kinect.params.get('trails')");
    check(armed.enabled && armed.free && armed.autoRotate === false && !(trails > 0),
      'control: the free camera is navigated, its orbit is on, the turntable is off and no trail is up',
      `enabled ${armed.enabled}, free camera ${armed.free}, autoRotate ${armed.autoRotate}, `
      + `trails ${trails}`);

    const w = await fly(['w']);
    const along = w.moved.reduce((n, v, i) => n + v * w.before.fwd[i], 0);
    const across = Math.hypot(...w.moved.map((v, i) => v - along * w.before.fwd[i]));
    note('holding shift and W at a parked playhead',
      `${w.length.toFixed(3)} m over ${w.elapsed.toFixed(2)}s held, `
      + `${w.after.redraws - w.before.redraws} navigation redraws, `
      + `${w.heldSeeks - w.before.seeks} seeks during the hold`);
    check(along > 0.1 && along < 0.8,
      'holding shift and W flies the camera along the view direction',
      `${along.toFixed(3)} m along the way it was pointing, over ${w.elapsed.toFixed(2)}s held`);
    check(w.length > 0 && across < 0.05 * w.length,
      '  and next to nothing across it, so it flies the view rather than a world axis',
      `${across.toFixed(4)} m across a ${w.length.toFixed(3)} m flight`);

    const offsetDrift = Math.max(...w.after.offset.map((v, i) => Math.abs(v - w.before.offset[i])));
    check(offsetDrift < 1e-4,
      'the pivot flies with it, so what moves is the standpoint and not the orbit\'s radius',
      `worst axis of target minus position moved ${offsetDrift.toExponential(2)} m over `
      + `${w.length.toFixed(3)} m of flight`);

    check(w.after.redraws > w.before.redraws,
      'and the picture was redrawn while it flew, out of the animation loop',
      `${w.after.redraws - w.before.redraws} navigation redraws over ${w.elapsed.toFixed(2)}s`);

    check(w.heldSeeks === w.before.seeks,
      'control: a flight redraws and does not seek, so the seek below is the release and not the hold',
      `${w.heldSeeks - w.before.seeks} seeks over the hold, with trails at ${trails} - a trail or `
      + 'a live datamosh turns every redraw into a seek and takes this pair away');
    check(w.after.seeks > w.heldSeeks,
      'and releasing the last key lands the accurate frame',
      `${w.after.seeks - w.heldSeeks} seeks after the release, against `
      + `${w.heldSeeks - w.before.seeks} during the hold`);

    // The falsification control for every row above: with the gate gone they all still pass, and
    // only this one can see it. The key is still recorded while it is down, so an unshifted hold
    // is a build that took the key and refused to move on it rather than one that never saw it.
    const bare = await fly(['w'], { shift: false });
    check(bare.length < 1e-6 && bare.after.redraws === bare.before.redraws,
      'control: an unshifted fly key moves nothing at all, which is the gate every row above is held by',
      `${bare.length.toExponential(2)} m and ${bare.after.redraws - bare.before.redraws} navigation `
      + `redraws over ${bare.elapsed.toFixed(2)}s held`);

    // Shift onto a key already down. A different failure from the gate: a build that reads shift
    // on the keydown alone never records the key, so this hold has nothing to start.
    await focusStage();
    const beforeLate = await rest();
    await page.keyboard.down('w');
    await new Promise((r) => setTimeout(r, 300));
    const heldBare = await page.evaluate('__kinect.freeCamera.position.toArray()');
    await page.keyboard.down('Shift');
    await new Promise((r) => setTimeout(r, 350));
    const heldShifted = await page.evaluate('__kinect.freeCamera.position.toArray()');
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
    await settle();
    check(apart(heldBare, beforeLate.p) < 1e-6,
      'control: the key on its own flew nothing over the 300 ms before shift arrived',
      `${apart(heldBare, beforeLate.p).toExponential(2)} m`);
    check(apart(heldShifted, heldBare) > 0.1,
      'and shift arriving onto a key already held starts the flight',
      `${apart(heldShifted, heldBare).toFixed(3)} m over the 350 ms after shift went down`);

    // Shifted, or the keys cancel for the second reason and the row passes on the gate instead.
    await focusStage();
    await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    await page.keyboard.down('s');
    const cancelledBefore = await rest();
    await new Promise((r) => setTimeout(r, 300));
    const cancelledAfter = await rest();
    await page.keyboard.up('s');
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
    await settle();
    const cancelledMove = apart(cancelledAfter.p, cancelledBefore.p);
    const cancelledRedraws = cancelledAfter.redraws - cancelledBefore.redraws;
    check(cancelledMove < 1e-6 && cancelledRedraws <= 1,
      'opposite fly keys do not keep the redraw loop alive because their requested move is zero',
      `${cancelledMove.toExponential(2)} m and ${cancelledRedraws} navigation redraws over 300 ms`);

    // Every synthetic event carries the shift, including the keyup: `flyShift` is written from
    // `e.shiftKey` on both, so a release without it puts the gate down and the re-press flies
    // nothing at all - which is the row passing for the opposite of its reason.
    await focusStage();
    await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    await new Promise((r) => setTimeout(r, 250));
    const restarted = await page.evaluate(`(async () => {
      const c = __kinect.freeCamera;
      const shift = { code: 'KeyW', key: 'w', shiftKey: true };
      dispatchEvent(new KeyboardEvent('keyup', shift));
      const until = performance.now() + 150;
      while (performance.now() < until) {}
      const before = c.position.toArray();
      dispatchEvent(new KeyboardEvent('keydown', shift));
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const one = c.position.toArray();
      for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
      const four = c.position.toArray();
      dispatchEvent(new KeyboardEvent('keyup', shift));
      const d = (a, b) => Math.hypot(...a.map((v, i) => v - b[i]));
      return { first: d(one, before), overFour: d(four, before) };
    })()`);
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
    await settle();
    check(restarted.first < 0.03 && restarted.overFour > 0.002,
      'a new hold starts a new clock even when its release and press land between frames',
      `${restarted.first.toFixed(4)} m on the first frame after a 150 ms gap, and `
      + `${restarted.overFour.toFixed(4)} m over the four frames after it, so it did fly`);

    // Pitched hard down, which is the pose that tells the room's vertical from the camera's.
    const pitched = await page.evaluate(`(() => {
      const k = __kinect, c = k.freeCamera;
      const was = { p: c.position.toArray(), t: k.controls.target.toArray() };
      c.position.set(0, 2, 0);
      k.controls.target.set(0, 0, -2.2);
      k.controls.update(0);
      c.updateMatrixWorld(true);
      const localY = new (c.position.constructor)(0, 1, 0).applyQuaternion(c.quaternion);
      return { was, pitch: localY.dot(c.up.clone().normalize()) };
    })()`);
    check(pitched.pitch < 0.9,
      'control: the camera is pitched, so its own vertical is not the room\'s',
      `the camera's local Y dots the pole at ${pitched.pitch.toFixed(3)}`);
    const climbed = await fly(['e']);
    const climb = climbed.moved.reduce((n, v, i) => n + v * climbed.before.up[i], 0)
      / Math.max(climbed.length, 1e-9);
    check(climbed.length > 0.05 && climb > 0.99,
      'E climbs the room\'s vertical rather than the camera\'s, however the camera is aimed',
      `${climbed.length.toFixed(3)} m, ${climb.toFixed(4)} of it along the pole`);
    await page.evaluate(`(() => {
      const k = __kinect, c = k.freeCamera;
      const was = ${JSON.stringify(pitched.was)};
      c.position.fromArray(was.p);
      k.controls.target.fromArray(was.t);
      k.controls.update(0);
      c.updateMatrixWorld(true);
    })()`);
    await settle();

    // The keyboard guard is two claims and not one: a text field keeps the whole keyboard, and
    // every other control keeps only the keys it works itself. Both are driven, because the
    // build that took every control's keyboard passed the first of them for years.
    //
    // The editor has no text field standing on the page, so this opens the one the export
    // dialog carries and puts its value back afterwards - the refused key would otherwise be
    // typed into the name a later section reads.
    await focusStage();
    const exportName = await page.evaluate('document.getElementById("tExportName").value');
    const beforeTextFocus = await rest();
    await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    await page.waitForTimeout(150);
    await page.locator('#outputMenuButton').click();
    await page.locator('#menuExport').click();
    await page.evaluate("document.getElementById('tExportName').focus()");
    const atTextFocus = await rest();
    await page.waitForTimeout(200);
    const afterTextFocus = await rest();
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
    check(apart(beforeTextFocus.p, atTextFocus.p) > 0.05,
      'control: the camera was flying before the text field took focus');
    check(apart(atTextFocus.p, afterTextFocus.p) < 1e-6,
      'focusing a text field stops a flight already in progress',
      `${apart(atTextFocus.p, afterTextFocus.p)} m while the filename held focus`);
    const inText = await page.evaluate('document.activeElement && document.activeElement.id');
    const whileTyping = await fly(['w'], { focus: false });
    await page.evaluate(`(() => {
      const el = document.getElementById('tExportName');
      el.value = ${JSON.stringify(exportName)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('exportDialog').close();
    })()`);
    await settle();
    check(inText === 'tExportName',
      'control: a text field holds the keyboard, which is the case the guard is about',
      `the focus is on ${JSON.stringify(inText)}`);
    check(whileTyping.length < 1e-6,
      'a fly key does nothing while a text field holds the keyboard',
      `${whileTyping.length.toExponential(2)} m over ${whileTyping.elapsed.toFixed(2)}s held`);

    // A slider is not a text field, so it keeps the arrows it works itself and nothing else.
    // `camLens` rather than `tRate`: this section already puts the lens back on the way out,
    // where a nudged clip speed would be an edit left behind in the document.
    await page.locator('#panelTabCamera').click();
    await page.locator('#camLens').focus();
    const onSlider = await page.evaluate('document.activeElement && document.activeElement.id');
    const nudgeFrom = await page.evaluate('document.getElementById("camLens").value');
    await page.keyboard.press('ArrowRight');
    const nudgeTo = await page.evaluate('document.getElementById("camLens").value');
    const whileSliding = await fly(['w'], { focus: false });
    check(onSlider === 'camLens' && Number(nudgeTo) > Number(nudgeFrom),
      'control: a focused slider still takes its own arrow key, which is what it is left holding',
      `the focus is on ${JSON.stringify(onSlider)} and the right arrow took it from `
      + `${nudgeFrom} to ${nudgeTo}`);
    check(whileSliding.length > 0.1,
      'and a fly key still flies while a slider holds the keyboard, because a slider takes no text',
      `${whileSliding.length.toFixed(3)} m over ${whileSliding.elapsed.toFixed(2)}s held, against `
      + `${whileTyping.length.toExponential(2)} m with the text field focused`);
    await focusStage();

    // A key released outside the page never arrives, so the blur has to be the release.
    const beforeBlur = await rest();
    await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    await new Promise((r) => setTimeout(r, 250));
    const atBlur = await page.evaluate('__kinect.freeCamera.position.toArray()');
    await page.evaluate("dispatchEvent(new Event('blur'))");
    await new Promise((r) => setTimeout(r, 300));
    const settledAfterBlur = await page.evaluate('__kinect.freeCamera.position.toArray()');
    await new Promise((r) => setTimeout(r, 300));
    const laterAfterBlur = await page.evaluate('__kinect.freeCamera.position.toArray()');
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
    await settle();
    const flewBeforeBlur = apart(atBlur, beforeBlur.p);
    const flewAfterBlur = apart(laterAfterBlur, settledAfterBlur);
    check(flewBeforeBlur > 0.05,
      'control: the hold was flying when the window lost the page',
      `${flewBeforeBlur.toFixed(3)} m over the 250 ms before the blur`);
    check(flewAfterBlur < 0.01,
      'and losing the page releases the key, so a held fly key stops',
      `${flewAfterBlur.toFixed(4)} m over the 300 ms after the blur had settled`);

    const onProgram = await page.evaluate(`(() => {
      const k = __kinect;
      k.setViewCamera(k.programCamera);
      return { enabled: k.controls.enabled, p: k.freeCamera.position.toArray() };
    })()`);
    await focusStage();
    await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    await new Promise((r) => setTimeout(r, 400));
    const underProgram = await page.evaluate('__kinect.freeCamera.position.toArray()');
    // Released before the free camera comes back, or the restored gate flies it on the next frame.
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
    await page.evaluate('__kinect.setViewCamera(__kinect.freeCamera)');
    await settle();
    check(onProgram.enabled === false,
      'control: the program camera turns the orbit off, which is the gate the fly reads',
      `controls.enabled is ${onProgram.enabled} under the program camera`);
    check(apart(underProgram, onProgram.p) < 1e-6,
      'and nothing flies under the program camera, whose pose is the document\'s',
      `${apart(underProgram, onProgram.p).toExponential(2)} m over a 400 ms hold`);

    // Reset first, so "home" is a pose the camera is standing at rather than one it has left.
    await page.evaluate("document.getElementById('menuCameraReset').click()");
    await settle();
    const home = await rest();
    const flownFromHome = await fly(['w']);
    await page.evaluate("document.getElementById('menuCameraReset').click()");
    await settle();
    const rehomed = await rest();
    check(flownFromHome.length > 0.1,
      'control: the camera flew away from home before Reset was pressed',
      `${flownFromHome.length.toFixed(3)} m`);
    check(rehomed.p.every((v, i) => Math.abs(v - home.p[i]) < 1e-6)
      && rehomed.target.every((v, i) => Math.abs(v - home.target[i]) < 1e-6),
      'and Reset still goes home after a flight rather than to wherever the flight ended',
      `${rehomed.p.map((v) => v.toFixed(4)).join(', ')} against a home of `
      + `${home.p.map((v) => v.toFixed(4)).join(', ')}`);

    // ---- the look ----
    // A look and an orbit of the same pixels turn the view by the same angle in the same
    // direction, so the direction rows below cannot tell them apart and the standpoint is the
    // only reading that can. That is why the position row is the first one here and why the
    // plain-drag control at the end of the block is the one that gives it a scale.
    const turned = await drag(100, 0);
    const right0 = unit(cross3(turned.before.fwd, turned.before.up));
    const yaw = yawAbout(turned.before.fwd, turned.after.fwd, turned.before.up);
    // The rate is the lens: a drag the height of the stage turns exactly one field of view, so
    // the angle a row expects is read off the camera rather than written down here. A baked
    // figure would be a second copy of the rule and would break the day the default lens moves.
    const perPixel = ((turned.before.fov * Math.PI) / 180) / turned.before.stageH;
    const yawWanted = 100 * perPixel;
    note('a 100 px shift-drag across a stage the renderer sizes',
      `${turned.before.stageH} px tall at a ${turned.before.fov.toFixed(4)} degree field of view, `
      + `so the turn asked for is ${((yawWanted * 180) / Math.PI).toFixed(3)} degrees; the view `
      + `turned ${((-yaw * 180) / Math.PI).toFixed(3)} and the camera moved `
      + `${turned.moved.toExponential(2)} m`);
    check(turned.moved < 1e-6,
      'the camera stands still through a look, so what turns is the view and not the standpoint',
      `${turned.moved.toExponential(2)} m, against the metres a plain drag of the same pixels `
      + 'moves it below');
    check(dot3(turned.after.fwd, right0) > 0 && yaw < -1e-4,
      'dragging right turns the view right, which puts the scene to the left of where it was',
      `the view direction ended dotting the right axis at ${dot3(turned.after.fwd, right0).toFixed(4)}`);
    check(Math.abs(Math.abs(yaw) - yawWanted) < 1e-3,
      '  and a drag the height of the stage turns exactly one field of view',
      `${((Math.abs(yaw) * 180) / Math.PI).toFixed(4)} degrees against `
      + `${((yawWanted * 180) / Math.PI).toFixed(4)} asked for, at a `
      + `${turned.before.fov.toFixed(4)} degree lens over ${turned.before.stageH} px`);
    check(Math.abs(turned.after.radius - turned.before.radius) < 1e-6,
      'and the pivot rides a sphere about the camera, so the orbit radius survives the turn',
      `${turned.before.radius.toFixed(9)} m before, ${turned.after.radius.toFixed(9)} m after`);

    const dipped = await drag(0, 60);
    const pitch = polarTo(dipped.after.fwd, dipped.before.up)
      - polarTo(dipped.before.fwd, dipped.before.up);
    const pitchWanted = 60 * (((dipped.before.fov * Math.PI) / 180) / dipped.before.stageH);
    check(pitch > 0 && Math.abs(pitch - pitchWanted) < 1e-3 && dipped.moved < 1e-6,
      'dragging down looks down, at the same radians per pixel as across',
      `${((pitch * 180) / Math.PI).toFixed(4)} degrees down against `
      + `${((pitchWanted * 180) / Math.PI).toFixed(4)} asked for, with the camera `
      + `${dipped.moved.toExponential(2)} m from where it stood`);

    // The lens is the rate, so the same pixels at a long lens have to turn a smaller angle. The
    // control for that rule: a build with a rate of its own passes both rows above and answers
    // the same angle here.
    const longLens = await page.evaluate(`(() => {
      const k = __kinect, c = k.freeCamera;
      const was = c.fov;
      c.fov = was / 4;
      c.updateProjectionMatrix();
      return was;
    })()`);
    const dippedLong = await drag(0, 60);
    const pitchLong = polarTo(dippedLong.after.fwd, dippedLong.before.up)
      - polarTo(dippedLong.before.fwd, dippedLong.before.up);
    await page.evaluate(`(() => {
      const c = __kinect.freeCamera;
      c.fov = ${longLens};
      c.updateProjectionMatrix();
    })()`);
    await settle();
    check(pitchLong > 0 && Math.abs(pitchLong * 4 - pitch) < 1e-3,
      '  and a quarter field of view turns a quarter as far for the same pixels',
      `${((pitchLong * 180) / Math.PI).toFixed(4)} degrees at `
      + `${(longLens / 4).toFixed(4)} degrees of view against `
      + `${((pitch * 180) / Math.PI).toFixed(4)} at ${longLens.toFixed(4)}`);

    // Both poles in one row, and each reached in a single pointer move: a stepped drag on a
    // build with no clamp turns back through the pole it went past and reads as though it had
    // stopped there. The widest lens the wheel offers first, because the reach of a drag *is*
    // the lens now - at the default 50 degrees a pixel is worth so little that 150 degrees of
    // pitch would need a drag longer than the window is tall.
    const poleLens = await page.evaluate('__kinect.freeCamera.fov');
    await wheel(1200);
    const poles = {};
    for (const [name, sign] of [['down', 1], ['up', -1]]) {
      await page.evaluate(`(() => {
        const k = __kinect, c = k.freeCamera;
        c.position.set(0, 1, 3);
        k.controls.target.set(0, 1, 0);
        k.controls.update(0);
        c.updateMatrixWorld(true);
      })()`);
      await settle();
      const level = await rest();
      // 150 degrees of pitch onto a level view, so a build with no clamp ends up 60 degrees the
      // other side of the pole - which reads -0.5 where the clamp reads -1.
      const far = Math.round((150 / level.fov) * level.stageH);
      const top = stage.top + 10;
      const past = await drag(0, far * sign, {
        steps: 1, from: { x: stage.x, y: sign > 0 ? top : stage.bottom - 10 },
      });
      poles[name] = {
        at: dot3(past.after.fwd, level.up), far: far * sign, fov: level.fov,
        asked: (far / level.stageH) * level.fov, from: dot3(level.fwd, level.up),
      };
    }
    await page.evaluate(`(() => {
      const c = __kinect.freeCamera;
      c.fov = ${poleLens};
      c.updateProjectionMatrix();
    })()`);
    await settle();
    check(poles.down.at < -0.9999 && poles.up.at > 0.9999,
      'and the pitch stops just short of either pole rather than tipping over it',
      `${poles.down.far} px down at a ${poles.down.fov.toFixed(2)} degree lens asks for `
      + `${poles.down.asked.toFixed(1)} degrees of pitch and landed the view direction at `
      + `${poles.down.at.toFixed(6)} of the pole; ${poles.up.far} px up landed at `
      + `${poles.up.at.toFixed(6)}, from ${poles.down.from.toFixed(4)} level - a build that ran `
      + 'past either lands about -0.5 and 0.5');

    await page.evaluate("document.getElementById('menuCameraReset').click()");
    await settle();
    const orbited = await drag(100, 0, { shift: false });
    check(orbited.moved > 0.1,
      'control: a plain drag still orbits, so the camera moves where a look leaves it standing',
      `${orbited.moved.toFixed(4)} m, against ${turned.moved.toExponential(2)} m for the same `
      + 'pixels with shift down');

    // The draft-per-frame and one-seek-on-release pair the fly hold has, asked of the look.
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    const lookBefore = await rest();
    await page.keyboard.down('Shift');
    await page.mouse.move(stage.x - 50, stage.y);
    await page.mouse.down();
    await page.mouse.move(stage.x, stage.y, { steps: 5 });
    await new Promise((r) => setTimeout(r, 200));
    await page.mouse.move(stage.x + 50, stage.y, { steps: 5 });
    const lookHeld = await page.evaluate(`(() => ({
      redraws: __kinect.timeline.counters.navigationRedraws,
      seeks: __kinect.timeline.counters.seeks,
    }))()`);
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await settle();
    const lookAfter = await rest();
    check(lookHeld.redraws > lookBefore.redraws && lookHeld.seeks === lookBefore.seeks,
      'a look redraws while the pointer is down and does not seek, so the seek below is the release',
      `${lookHeld.redraws - lookBefore.redraws} navigation redraws and `
      + `${lookHeld.seeks - lookBefore.seeks} seeks over the drag`);
    check(lookAfter.seeks > lookHeld.seeks,
      'and letting the pointer up lands the accurate frame',
      `${lookAfter.seeks - lookHeld.seeks} seeks after the release`);

    // Flight and look at once, which is the pair the gate change is about. Both readings are
    // taken with the pointer still down: shift and W fly perfectly well either side of the drag,
    // so a window that reaches past the release cannot see the term that keeps them together.
    await focusStage();
    await page.keyboard.down('Shift');
    await page.keyboard.down('w');
    await page.mouse.move(stage.x - 60, stage.y);
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, 150));
    const bothStart = await page.evaluate(`(() => {
      const k = __kinect, c = k.freeCamera, V = c.position.constructor;
      return {
        p: c.position.toArray(), fwd: c.getWorldDirection(new V()).toArray(),
        up: c.up.clone().normalize().toArray(), enabled: k.controls.enabled,
      };
    })()`);
    await page.mouse.move(stage.x + 60, stage.y, { steps: 6 });
    await new Promise((r) => setTimeout(r, 250));
    const bothEnd = await page.evaluate(`(() => {
      const k = __kinect, c = k.freeCamera, V = c.position.constructor;
      return { p: c.position.toArray(), fwd: c.getWorldDirection(new V()).toArray() };
    })()`);
    await page.mouse.up();
    await page.keyboard.up('w');
    await page.keyboard.up('Shift');
    await settle();
    const bothFlew = apart(bothEnd.p, bothStart.p);
    const bothTurned = Math.abs(yawAbout(bothStart.fwd, bothEnd.fwd, bothStart.up));
    check(bothStart.enabled === false,
      'control: a look drag turns the orbit off, which is the term the flight has to read past',
      `controls.enabled is ${bothStart.enabled} with the look drag up`);
    check(bothFlew > 0.1 && bothTurned > 0.01,
      'and the flight carries on through a look drag, so you fly the way you are turning',
      `${bothFlew.toFixed(3)} m flown and ${((bothTurned * 180) / Math.PI).toFixed(1)} degrees `
      + 'turned between two readings taken with the pointer down');

    // ---- the lens ----
    const lensHome = await rest();
    const zoomed = await wheel(-100);
    check(zoomed.after.fov < zoomed.before.fov * 0.95
      && apart(zoomed.after.p, zoomed.before.p) < 1e-9
      && Math.abs(zoomed.after.radius - zoomed.before.radius) < 1e-9,
      'shift and the wheel change the lens, and leave the camera where it is standing',
      `${zoomed.before.lensOut} -> ${zoomed.after.lensOut}, fov ${zoomed.before.fov.toFixed(4)} -> `
      + `${zoomed.after.fov.toFixed(4)}, camera ${apart(zoomed.after.p, zoomed.before.p).toExponential(2)} m `
      + `and radius ${(zoomed.after.radius - zoomed.before.radius).toExponential(2)} m from where it was`);
    const backAgain = await wheel(100);
    check(Math.abs(backAgain.after.fov - zoomed.before.fov) < 1e-9,
      '  and a notch back is the same lens again, so the gesture is a ratio and not a step',
      `fov ${zoomed.before.fov.toFixed(9)} -> ${zoomed.after.fov.toFixed(9)} -> `
      + `${backAgain.after.fov.toFixed(9)}`);

    // Chrome turns shift plus a physical wheel into `deltaX`, so this is the branch a real mouse
    // takes and the one no hand-drive here has ever reached.
    const sideways = await wheel(-100, { axis: 'x' });
    check(Math.abs(sideways.after.fov - zoomed.after.fov) < 1e-9,
      'and a wheel that reports its notch sideways moves the lens by the same amount, which is '
      + 'the axis a real mouse sends under shift',
      `deltaX -100 left the fov at ${sideways.after.fov.toFixed(9)}, where deltaY -100 left it `
      + `at ${zoomed.after.fov.toFixed(9)}, both from ${zoomed.before.fov.toFixed(9)}`);
    await wheel(100, { axis: 'x' });

    const dollied = await wheel(-100, { shift: false });
    check(dollied.after.radius < dollied.before.radius * 0.99
      && dollied.after.fov === dollied.before.fov,
      'control: a plain wheel still dollies, and leaves the lens exactly where it was',
      `radius ${dollied.before.radius.toFixed(5)} -> ${dollied.after.radius.toFixed(5)} m, `
      + `fov ${dollied.before.fov} -> ${dollied.after.fov}, readout ${dollied.after.lensOut}`);

    // From the 8mm clamp, -2600 asks for 395mm; -2400 only reaches 293mm.
    const wide = await wheel(1200);
    const long = await wheel(-2600);
    check(wide.after.lensOut === '8.0mm' && long.after.lensOut === '300.0mm',
      'and the wheel stops at each end of the band, at a reading the row can hold',
      `${wide.after.lensOut} at the wide end and ${long.after.lensOut} at the long end, from `
      + `${lensHome.lensOut}; the readings either end must be the band's own numbers rather than `
      + 'the words for running past it');
    note('the lens the clamps landed on',
      `fov ${wide.after.fov.toFixed(4)} wide and ${long.after.fov.toFixed(4)} long, `
      + `with the slider at ${wide.after.lens} and ${long.after.lens}`);

    // The lens back where the section found it, exactly, and the row repainted through the
    // control's own handler so the panel is not left showing the clamp.
    await page.evaluate(`(() => {
      const k = __kinect, c = k.freeCamera;
      const el = document.getElementById('camLens');
      el.value = ${JSON.stringify(lensHome.lens)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      c.fov = ${lensHome.fov};
      c.updateProjectionMatrix();
    })()`);
    await page.evaluate("document.getElementById('menuCameraReset').click()");
    await settle();

    await page.evaluate('__kinect.editor.setClipRange(4, 9)');
    await settle();
    await focusStage();
    const ruledBefore = await page.evaluate('__kinect.editor.view.window()');
    await page.keyboard.press('z');
    await settle();
    const ruledAfter = await page.evaluate('__kinect.editor.view.window()');
    check(await page.evaluate('typeof __kinect.editor.view.frame') === 'undefined',
      'the ruler has no framing call left for a key to reach',
      `view.frame is ${await page.evaluate('typeof __kinect.editor.view.frame')}`);
    check(JSON.stringify(ruledBefore) === JSON.stringify(ruledAfter),
      'and z leaves the ruler alone, with a trim set that it would have framed',
      `${JSON.stringify(ruledAfter)} with the trim at 4s..9s`);
    await page.evaluate('__kinect.editor.setClipRange(0, null)');
    await page.evaluate('__kinect.editor.view.fit()');
    // Nothing held on the way out, whatever a row above left behind.
    await proveLookInterruptions(page, 'editor');
    await page.evaluate("dispatchEvent(new Event('blur'))");
    await settle();
  }

  console.log('\n[22] adding, selecting, moving and deleting a clip');
  {
    const library = await (await fetch(`${URL_BASE}/library/takes`)).json();
    const other = (library.takes ?? []).find((t) => t.id !== TAKE && t.openable !== false) ?? null;

    const read = () => page.evaluate(`(() => {
      const k = globalThis.__kinect;
      return {
        clips: k.timeline.clips().map((c) => ({ id: c.id, take: c.take && c.take.id,
          start: c.start, end: c.end, trim: c.trim, length: c.length,
          speed: c.speed, sourceStart: c.sourceStart, selected: c.selected })),
        selection: k.editor.clipSelection(),
        rows: k.keyframes.lanes().map((l) => l.owner),
        boxes: [...document.querySelectorAll('.tclip')].length,
        duration: k.timeline.read().duration,
        undo: k.keyframes.undo.depth(),
        addDisabled: document.getElementById('tAddClip').disabled,
        deleteDisabled: document.getElementById('tDeleteClip').disabled,
      };
    })()`);

    let one = await read();
    console.log(`  the stack: ${one.rows.join(', ')}`);
    check(one.rows[0] === `clip:${one.clips[0].id}` && one.rows.includes('clip-add'),
      'the lane stack opens with the clip row and offers a row to add another clip',
      one.rows.slice(0, 3).join(', '));
    check(one.boxes === one.clips.length,
      'and one box is drawn per clip', `${one.boxes} boxes for ${one.clips.length} clips`);
    check(one.deleteDisabled === true,
      'delete is refused while the edit holds one clip, because a project carries at least one',
      `disabled ${one.deleteDisabled}`);
    // The other half of this is enforced by everything above rather than by a row: an editor
    // opened on a take that selected nothing would grey its clip half, and the several hundred
    // rows before this one that drag and reset panel controls would all be pressing dead
    // controls. This names it where the door is known - the page was opened by `?take=`.
    check(one.selection === one.clips[0].id,
      'an editor opened on a take has that take\'s clip selected, because a take is one clip of '
      + 'footage somebody has just chosen and there is nothing there to choose between',
      `${one.selection}`);

    if (!other) {
      note('[23] runs on one take', 'no second take in this library, so the add arm below cuts a '
        + 'second clip of the same footage - which proves the same thing about placement and a '
        + 'weaker thing about the picker');
    }
    const pickId = other ? other.id : TAKE;
    const raceTake = (library.takes ?? []).find((take) => take.id !== TAKE
      && take.id !== pickId && take.openable !== false) ?? null;
    const movingAddChoices = (library.takes ?? []).filter((take) => take.id !== TAKE
      && take.id !== pickId && take.id !== raceTake?.id && take.openable !== false);
    const movingAddTake = movingAddChoices.find((take) => take.id === 'sample')
      ?? movingAddChoices[0] ?? null;

    const currentTake = (library.takes ?? []).find((take) => take.id === TAKE) ?? null;
    check(currentTake !== null,
      'the take open in the editor is still in the library, so a renamed listing can resolve its hash',
      currentTake ? `${currentTake.id} at ${currentTake.hash.slice(0, 22)}…` : `no ${TAKE}`);
    if (currentTake) {
      const renameRestore = await page.evaluate(`(() => ({
        project: __kinect.library.serialiseProjectBody(),
        selection: __kinect.editor.clipSelection(),
      }))()`);
      const renamedId = 'editor-renamed-take';
      const renamedLibrary = structuredClone(library);
      renamedLibrary.takes.find((take) => take.hash === currentTake.hash).id = renamedId;
      const renamedRequests = [];
      const errorsBeforeRename = errors.length;
      const serveRenamedLibrary = (route) => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(renamedLibrary),
      });
      const serveRenamedTake = (route) => {
        const url = new URL(route.request().url());
        renamedRequests.push(url.pathname);
        url.pathname = url.pathname.replace(`/capture/${renamedId}/`, `/capture/${TAKE}/`);
        return route.continue({ url: url.href });
      };
      await page.route('**/library/takes', serveRenamedLibrary);
      await page.route(`**/capture/${renamedId}/**`, serveRenamedTake);
      try {
        const offered = structuredClone(renameRestore.project);
        offered.clips[0].take.id = renamedId;
        await page.evaluate(({ name, body }) => __kinect.library.loadProject(name, body), {
          name: 'editor-check-renamed-take', body: offered,
        });
        await settle();
        const renamed = await page.evaluate(`(() => {
          const clip = __kinect.timeline.clips()[0];
          return {
            id: clip.take?.id ?? null,
            hash: clip.take?.hash ?? null,
            openIds: __kinect.timeline.takeCaches().map((take) => take.id),
          };
        })()`);
        check(renamed.hash === currentTake.hash && renamed.id === renamedId
          && renamed.openIds.includes(renamedId),
        'loading a project after its take was renamed rebinds the clip to the current route even when the hash is unchanged',
        `clip ${renamed.id}, open ${renamed.openIds.join(', ')}, hash ${String(renamed.hash).slice(0, 22)}…`);
        check(renamedRequests.some((path) => path.endsWith('/index'))
          && renamedRequests.some((path) => /\/frames\//.test(path))
          && errors.length === errorsBeforeRename,
        'and the reopened index and rendered frames use the renamed route without a page error',
        `${renamedRequests.join(', ') || 'no renamed requests'}; errors `
          + `${errors.slice(errorsBeforeRename).join(' | ') || 'none'}`);
      } finally {
        await page.unroute('**/library/takes', serveRenamedLibrary);
        await page.unroute(`**/capture/${renamedId}/**`, serveRenamedTake);
        await page.evaluate(async ({ project, selection }) => {
          await __kinect.library.loadProject('editor-check-rename-restore', project);
          if (selection) __kinect.editor.selectClipRow(selection);
          __kinect.keyframes.undo.begin();
        }, renameRestore);
        await settle();
      }
    }

    check(raceTake !== null,
      'the export race has an uncached third take, so Add Clip must cross its await after export starts',
      raceTake ? raceTake.id : `only ${(library.takes ?? []).map((take) => take.id).join(', ')} were listed`);
    if (raceTake) {
      const raceRestore = await page.evaluate(`(() => ({
        project: __kinect.library.serialiseProjectBody(),
        selection: __kinect.editor.clipSelection(),
      }))()`);
      const panelBeforeRace = await page.evaluate(
        'document.querySelector(".paneltab[aria-selected=true]")?.dataset.panelTab ?? null');
      await page.locator('.paneltab[data-panel-tab="look"]').click();
      await settle();
      await page.evaluate((clipId) => __kinect.editor.selectClipRow(clipId), one.selection);
      await page.evaluate(`fetch('/presets/blackwall').then((response) => response.json())
        .then((doc) => __kinect.library.applyStoredPreset(doc))`);
      await page.evaluate(`(() => {
        const k = __kinect;
        k.params.set('pointSize', 17.25);
        const pose = {
          position: k.freeCamera.position.toArray(),
          quaternion: k.freeCamera.quaternion.toArray(),
          fov: k.freeCamera.fov,
        };
        k.keyframes.setTracks({
          pointSize: [
            { t: 0, value: 17.3, easeOut: [[0.42, 0]] },
            { t: 20, value: 17.3, easeIn: [[0.58, 1]] },
          ],
          camera: Array.from({ length: 601 }, (_, frame) => ({
            t: frame / 30,
            value: {
              position: [...pose.position],
              quaternion: [...pose.quaternion],
              fov: pose.fov,
            },
          })),
        });
        k.keyframes.undo.commit();
        k.keyframes.undo.begin();
      })()`);
      const beforeRace = await page.evaluate(`(() => {
        const project = __kinect.library.serialiseProjectBody();
        const selection = __kinect.editor.clipSelection();
        const target = project.clips.find((clip) => clip.id === selection);
        return {
          project,
          clips: __kinect.timeline.clips().map((clip) => clip.id),
          selection,
          pointSize: target?.params?.pointSize,
          stamp: target?.appliedPreset ?? null,
          edits: __kinect.export.editsDuringExport(),
        };
      })()`);
      const projectOffer = structuredClone(beforeRace.project);
      const projectTarget = projectOffer.clips.find((clip) => clip.id === beforeRace.selection);
      const pickTake = (library.takes ?? []).find((take) => take.id === pickId);
      projectTarget.take = { id: pickTake.id, hash: pickTake.hash };
      let releasePreset = () => {};
      let releaseSource = () => {};
      let releaseProjectSources = () => {};
      let presetRequests = 0;
      let sourceRequests = 0;
      let projectSourceRequests = 0;
      const holdPreset = async (route) => {
        presetRequests++;
        await new Promise((resolve) => { releasePreset = resolve; });
        await route.continue();
      };
      const holdSource = async (route) => {
        sourceRequests++;
        await new Promise((resolve) => { releaseSource = resolve; });
        await route.continue();
      };
      const holdProjectSources = async (route) => {
        projectSourceRequests++;
        await new Promise((resolve) => { releaseProjectSources = resolve; });
        await route.continue();
      };
      await page.route('**/presets/blackwall', holdPreset);
      await page.route(`**/capture/${raceTake.id}/index`, holdSource);
      try {
        await page.evaluate(`(() => {
          globalThis.__editorGuardPreset = fetch('/presets/blackwall')
            .then((response) => response.json())
            .then((doc) => __kinect.library.applyStoredPreset(doc));
        })()`);
        await page.locator('#tAddClip').click();
        await page.locator(`#takePicker .tp-tile[data-take="${raceTake.id}"] .tp-meta`).click();
        await page.locator('#takePicker .tp-act.go').click();
        const began = Date.now();
        while (presetRequests !== 1 || sourceRequests !== 1) {
          if (Date.now() - began > 15000) throw new Error(
            `the export-race requests did not both arrive: preset ${presetRequests}, source ${sourceRequests}`,
          );
          await new Promise((resolve) => { setTimeout(resolve, 20); });
        }
        await page.route('**/library/takes', holdProjectSources);
        await page.evaluate(({ name, body }) => {
          globalThis.__editorGuardProject = __kinect.library.loadProject(name, body)
            .then((value) => ({ ok: true, value }),
              (error) => ({ ok: false, error: String(error?.message ?? error) }));
        }, { name: 'editor-check-export-race', body: projectOffer });
        const projectBegan = Date.now();
        while (projectSourceRequests !== 1) {
          if (Date.now() - projectBegan > 15000) throw new Error(
            `the project load did not pause while resolving its footage: ${projectSourceRequests} requests`,
          );
          await new Promise((resolve) => { setTimeout(resolve, 20); });
        }
        const gizmoBeforeExport = await page.evaluate(`(() => {
          __kinect.editor.setGizmoMode('translate');
          return __kinect.editor.gizmo();
        })()`);
        await page.evaluate(`(() => {
          globalThis.__editorGuardExport = __kinect.export.run({
            from: 0, to: 600, width: 64, height: 36, name: 'editor-check-export-guard',
          }).then((done) => ({ ok: true, done }), (error) => ({ ok: false, error: String(error?.message ?? error) }));
        })()`);
        await page.waitForFunction('__kinect.export.running()', null, { timeout: 15000 });
        const gizmoDuringExport = await page.evaluate('__kinect.editor.gizmo()');
        const runningAtRelease = await page.evaluate('__kinect.export.running()');
        const guardedControlsBefore = await page.evaluate(`(() => {
          const body = __kinect.library.serialiseProjectBody();
          const selected = body.clips.find((clip) => clip.id === __kinect.editor.clipSelection());
          return {
            pointKeys: selected.tracks.pointSize,
            cameraKeys: body.composition.camera,
            edits: __kinect.export.editsDuringExport(),
          };
        })()`);
        await page.locator('#pointSize').evaluate((control) => {
          control.value = control.max;
          control.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.locator('#panelTabCamera').click();
        await page.locator('#camClear').click();
        await page.locator('#panelTabLook').click();
        await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const guardedControlsAfter = await page.evaluate(`(() => {
          const body = __kinect.library.serialiseProjectBody();
          const selected = body.clips.find((clip) => clip.id === __kinect.editor.clipSelection());
          return {
            pointKeys: selected.tracks.pointSize,
            cameraKeys: body.composition.camera,
            edits: __kinect.export.editsDuringExport(),
            note: document.getElementById('tNote').textContent,
            running: __kinect.export.running(),
          };
        })()`);
        releasePreset();
        releaseSource();
        await page.waitForFunction(`!__kinect.library.presetGestureRunning()
          && !document.getElementById('tAddClip').disabled`, null, { timeout: 15000 });
        await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const afterRace = await page.evaluate((targetId) => {
          const project = __kinect.library.serialiseProjectBody();
          const target = project.clips.find((clip) => clip.id === targetId);
          return {
            clips: __kinect.timeline.clips().map((clip) => clip.id),
            pointSize: target?.params?.pointSize,
            stamp: target?.appliedPreset ?? null,
            edits: __kinect.export.editsDuringExport(),
            running: __kinect.export.running(),
          };
        }, beforeRace.selection);
        const beforeNone = await page.evaluate((targetId) => {
          const project = __kinect.library.serialiseProjectBody();
          const target = project.clips.find((clip) => clip.id === targetId);
          return {
            pointSize: target?.params?.pointSize,
            stamp: target?.appliedPreset ?? null,
            edits: __kinect.export.editsDuringExport(),
          };
        }, beforeRace.selection);
        await page.locator('#tPreset').click();
        await page.locator('#tPresetList .pickeroption[data-name=""]').click();
        await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const afterNone = await page.evaluate((targetId) => {
          const project = __kinect.library.serialiseProjectBody();
          const target = project.clips.find((clip) => clip.id === targetId);
          return {
            pointSize: target?.params?.pointSize,
            stamp: target?.appliedPreset ?? null,
            edits: __kinect.export.editsDuringExport(),
            picker: document.getElementById('tPreset').value,
            note: document.getElementById('tNote').textContent,
            running: __kinect.export.running(),
          };
        }, beforeRace.selection);
        const beforeRate = await page.evaluate(`(() => ({
          fps: __kinect.timeline.transport().outputFps,
          edits: __kinect.export.editsDuringExport(),
        }))()`);
        await page.locator('#fileMenuButton').click();
        await page.locator('#menuProjectSettings').click();
        const otherRate = await page.evaluate(`[...document.getElementById('tFps').options]
          .map((option) => option.value)
          .find((value) => Number(value) !== __kinect.timeline.transport().outputFps)`);
        await page.selectOption('#tFps', otherRate);
        await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
        const afterRate = await page.evaluate(`({
          fps: __kinect.timeline.transport().outputFps,
          picker: document.getElementById('tFps').value,
          edits: __kinect.export.editsDuringExport(),
          note: document.getElementById('tNote').textContent,
          running: __kinect.export.running(),
        })`);
        await page.locator('#projectClose').click();
        const beforeProjectRelease = await page.evaluate('__kinect.library.serialiseProjectBody()');
        releaseProjectSources();
        const projectLoadResult = await page.evaluate(`globalThis.__editorGuardProject.then((result) => ({
          ok: result.ok,
          refused: result.value === null,
          error: result.error ?? null,
          note: document.getElementById('tNote').textContent,
          running: __kinect.export.running(),
        }))`);
        const afterProject = await page.evaluate('__kinect.library.serialiseProjectBody()');
        const exportResult = await page.evaluate(`globalThis.__editorGuardExport.then((result) => ({
          ok: result.ok,
          error: result.error ?? null,
          bytes: result.done?.bytes ?? null,
          frames: result.done?.frames ?? null,
        }))`);
        const gizmoAfterExport = await page.evaluate('__kinect.editor.gizmo()');
        check(runningAtRelease && afterRace.running,
          'the held preset and clip requests resume while a real export still owns the document',
          `running at release ${runningAtRelease}, after continuations ${afterRace.running}`);
        check(exportResult.ok && exportResult.frames === 601,
          'the real export completes all 601 frames after every refused edit leaves its document untouched',
          JSON.stringify(exportResult));
        check(gizmoBeforeExport.enabled && gizmoBeforeExport.shown
          && !gizmoDuringExport.enabled && !gizmoDuringExport.shown
          && gizmoAfterExport.enabled && gizmoAfterExport.shown,
        'an armed transform control stops hit-testing for the whole export and returns afterwards',
        `before enabled/shown ${gizmoBeforeExport.enabled}/${gizmoBeforeExport.shown}, during `
          + `${gizmoDuringExport.enabled}/${gizmoDuringExport.shown}, after `
          + `${gizmoAfterExport.enabled}/${gizmoAfterExport.shown}`);
        check(guardedControlsAfter.running
          && JSON.stringify(guardedControlsAfter.pointKeys)
            === JSON.stringify(guardedControlsBefore.pointKeys),
        'moving a keyed control while export owns the document cannot insert or replace a key',
        `keys ${guardedControlsBefore.pointKeys.length} -> ${guardedControlsAfter.pointKeys.length}, `
          + `edits ${guardedControlsBefore.edits} -> ${guardedControlsAfter.edits}`);
        check(JSON.stringify(guardedControlsAfter.cameraKeys)
          === JSON.stringify(guardedControlsBefore.cameraKeys),
        'deleting the camera key under the export playhead cannot change the camera track',
        `keys ${guardedControlsBefore.cameraKeys.length} -> ${guardedControlsAfter.cameraKeys.length}, `
          + `note ${JSON.stringify(guardedControlsAfter.note)}`);
        check(afterRace.pointSize === beforeRace.pointSize
          && JSON.stringify(afterRace.stamp) === JSON.stringify(beforeRace.stamp),
        'a fetched preset cannot apply values, stamp the clip or commit after export starts',
        `pointSize ${beforeRace.pointSize} -> ${afterRace.pointSize}, stamp `
          + `${JSON.stringify(beforeRace.stamp)} -> ${JSON.stringify(afterRace.stamp)}, `
          + `edits ${beforeRace.edits} -> ${afterRace.edits}`);
        check(JSON.stringify(afterRace.clips) === JSON.stringify(beforeRace.clips),
        'an opened take cannot append a clip or commit after export starts',
        `clips ${beforeRace.clips.join(',')} -> ${afterRace.clips.join(',')}, `
          + `edits ${beforeRace.edits} -> ${afterRace.edits}`);
        check(projectLoadResult.ok && projectLoadResult.refused && projectLoadResult.running
          && /declined/.test(projectLoadResult.note) && /export/.test(projectLoadResult.note)
          && JSON.stringify(afterProject) === JSON.stringify(beforeProjectRelease),
        'a project whose footage resolves after export starts cannot replace the document and says why',
        `load ${JSON.stringify(projectLoadResult)}, document unchanged `
          + `${JSON.stringify(afterProject) === JSON.stringify(beforeProjectRelease)}`);
        check(beforeNone.stamp?.name === 'blackwall',
          'the selected clip is stamped before preset none is pressed during export, so the refusal below has document state to protect',
          `stamp ${JSON.stringify(beforeNone.stamp)}`);
        check(afterNone.running && afterNone.pointSize === beforeNone.pointSize
          && JSON.stringify(afterNone.stamp) === JSON.stringify(beforeNone.stamp)
          && afterNone.edits === beforeNone.edits && afterNone.picker === beforeNone.stamp?.name
          && /declined/.test(afterNone.note) && /export/.test(afterNone.note),
        'choosing preset none while an export owns the document changes no values, stamp, picker or history and says why',
        `running ${afterNone.running}, pointSize ${beforeNone.pointSize} -> ${afterNone.pointSize}, `
          + `stamp ${JSON.stringify(beforeNone.stamp)} -> ${JSON.stringify(afterNone.stamp)}, `
          + `picker ${JSON.stringify(afterNone.picker)}, edits ${beforeNone.edits} -> ${afterNone.edits}, `
          + `note ${JSON.stringify(afterNone.note)}`);
        check(afterRate.running && afterRate.fps === beforeRate.fps
          && Number(afterRate.picker) === beforeRate.fps && afterRate.edits === beforeRate.edits
          && /declined/.test(afterRate.note) && /export/.test(afterRate.note),
        'changing the output rate while an export owns the document leaves the timeline grid, picker and history unchanged and says why',
        `running ${afterRate.running}, fps ${beforeRate.fps} -> ${afterRate.fps}, `
          + `picker ${JSON.stringify(afterRate.picker)}, edits ${beforeRate.edits} -> ${afterRate.edits}, `
          + `note ${JSON.stringify(afterRate.note)}`);
      } finally {
        releasePreset();
        releaseSource();
        releaseProjectSources();
        await page.evaluate('__kinect.editor.setGizmoMode(null)').catch(() => {});
        await page.unroute('**/presets/blackwall', holdPreset);
        await page.unroute(`**/capture/${raceTake.id}/index`, holdSource);
        await page.unroute('**/library/takes', holdProjectSources);
        await page.evaluate(({ project, selection }) => {
          __kinect.library.restoreProject(project);
          const selected = __kinect.timeline.clips().find((clip) => clip.id === selection);
          if (selected) __kinect.editor.selectClipRow(selected.id);
          __kinect.keyframes.undo.begin();
        }, raceRestore);
        if (panelBeforeRace) {
          await page.locator(`.paneltab[data-panel-tab="${panelBeforeRace}"]`).click();
        }
        await settle();
      }
    }
    one = await read();

    check(movingAddTake !== null,
      'the moving-playhead add arm has an uncached take, so opening it must cross a real request',
      movingAddTake ? movingAddTake.id : `only ${(library.takes ?? []).map((take) => take.id).join(', ')} were listed`);
    if (movingAddTake) {
      const beforeMovingAdd = await page.evaluate(`(async () => {
        const k = globalThis.__kinect;
        k.timeline.transport().pause();
        await k.timeline.transport().seek(4);
        await k.timeline.settled();
        return {
          project: k.library.serialiseProjectBody(),
          selection: k.editor.clipSelection(),
          clips: k.timeline.clips().length,
          program: k.timeline.transport().programSec,
          seeks: k.timeline.counters.seeks,
        };
      })()`);
      let releaseMovingSource = () => {};
      let movingSourceRequests = 0;
      const holdMovingSource = async (route) => {
        movingSourceRequests++;
        await new Promise((resolve) => { releaseMovingSource = resolve; });
        await route.continue();
      };
      await page.route(`**/capture/${movingAddTake.id}/index`, holdMovingSource);
      try {
        await page.evaluate('__kinect.timeline.transport().play()');
        await page.waitForFunction('__kinect.timeline.transport().playing', null, { timeout: 15000 });
        await page.evaluate(() => {
          document.getElementById('tAddClip')
            .addEventListener('click', () => {
              globalThis.__editorMovingAddPressedAt = __kinect.timeline.transport().programSec;
            }, { capture: true, once: true });
        });
        await page.locator('#tAddClip').click();
        await page.waitForSelector(`#takePicker .tp-tile[data-take="${movingAddTake.id}"]`, { timeout: 15000 });
        await page.locator(`#takePicker .tp-tile[data-take="${movingAddTake.id}"] .tp-meta`).click();
        await page.locator('#takePicker .tp-act.go').click();
        const began = Date.now();
        while (movingSourceRequests !== 1) {
          if (Date.now() - began > 15000) throw new Error(
            `the moving-playhead add request did not arrive: ${movingSourceRequests}`,
          );
          await new Promise((resolve) => { setTimeout(resolve, 20); });
        }
        const pressedAt = await page.evaluate('globalThis.__editorMovingAddPressedAt');
        await page.waitForFunction(
          (at) => globalThis.__kinect.timeline.transport().programSec > at + 0.25,
          pressedAt,
          { timeout: 15000 },
        );
        const whileOpening = await page.evaluate(`({
          playing: __kinect.timeline.transport().playing,
          program: __kinect.timeline.transport().programSec,
          seeks: __kinect.timeline.counters.seeks,
        })`);
        releaseMovingSource();
        await page.waitForFunction(
          (id) => globalThis.__kinect.timeline.clips().some((clip) => clip.take?.id === id)
            && document.getElementById('tNote').textContent.includes(id),
          movingAddTake.id,
          { timeout: 25000 },
        );
        for (let i = 0; i < 250; i++) {
          const complete = await page.evaluate((seeks) => __kinect.timeline.counters.seeks > seeks
            && __kinect.timeline.transport().playing, whileOpening.seeks);
          if (complete) break;
          await new Promise((resolve) => { setTimeout(resolve, 20); });
        }
        const afterMovingAdd = await page.evaluate(`(() => {
          const clips = __kinect.timeline.clips();
          const added = clips.find((clip) => clip.take?.id === ${JSON.stringify(movingAddTake.id)});
          return {
            clip: added ?? null,
            playing: __kinect.timeline.transport().playing,
            program: __kinect.timeline.transport().programSec,
            seeks: __kinect.timeline.counters.seeks,
          };
        })()`);
        check(whileOpening.playing
          && whileOpening.program > pressedAt + 0.25,
        'playback moves past the insertion point while the new take is still opening',
        `program ${pressedAt.toFixed(3)}s -> ${whileOpening.program.toFixed(3)}s, playing ${whileOpening.playing}`);
        check(afterMovingAdd.clip !== null
          && near(afterMovingAdd.clip.start, pressedAt, 1 / 30),
          'the delayed clip keeps the playhead position at which Add Clip was pressed',
          `${afterMovingAdd.clip?.start?.toFixed(3) ?? 'missing'}s against ${pressedAt.toFixed(3)}s`);
        check(afterMovingAdd.seeks > whileOpening.seeks,
          'and insertion pre-rolls the new clip at the current playhead before playback continues',
          `seeks ${whileOpening.seeks} -> ${afterMovingAdd.seeks} at program ${afterMovingAdd.program.toFixed(3)}s`);
        check(afterMovingAdd.playing,
          'and restores the play intent after the insertion seek',
          `playing ${afterMovingAdd.playing}`);
      } finally {
        releaseMovingSource();
        await page.unroute(`**/capture/${movingAddTake.id}/index`, holdMovingSource);
        await page.evaluate(({ project, selection }) => {
          __kinect.timeline.transport().pause();
          __kinect.library.restoreProject(project);
          __kinect.editor.selectClipRow(selection);
          __kinect.keyframes.undo.begin();
        }, beforeMovingAdd);
        await page.evaluate((program) => __kinect.timeline.transport().seek(program),
          beforeMovingAdd.program);
        await settle();
      }
    }
    one = await read();

    // The add, pressed rather than called: the picker is the one entry point and this is it.
    await page.evaluate(`(async () => {
      globalThis.__kinect.timeline.transport().pause();
      await globalThis.__kinect.timeline.transport().seek(4);
      await globalThis.__kinect.timeline.settled();
    })()`);
    await page.locator('#tAddClip').click();
    await page.waitForSelector(`#takePicker .tp-tile[data-take="${pickId}"]`, { timeout: 15000 });
    const offered = await page.evaluate(
      '[...document.querySelectorAll("#takePicker .tp-tile")].map((o) => o.dataset.take)',
    );
    check(offered.includes(pickId),
      'the picker offers the library\'s takes, which is what a clip is cut from',
      offered.join(', '));
    await page.locator(`#takePicker .tp-tile[data-take="${pickId}"] .tp-meta`).click();
    await page.locator('#takePicker .tp-act.go').click();
    await page.waitForFunction(() => globalThis.__kinect.timeline.clips().length === 2,
      null, { timeout: 25000 });
    await settle();
    const two = await read();
    const added = two.clips[1];
    console.log(`  added ${added.id} of ${added.take} at ${added.start.toFixed(2)}s, `
      + `${two.rows.length} lane rows, undo depth ${two.undo}`);

    check(two.clips.length === 2 && added.take === pickId,
      'the take chosen in the picker lands as a clip of that take',
      `${added.id} on ${added.take}`);
    check(near(added.start, 4, 1 / 30),
      'and it lands at the playhead rather than at the head of the edit',
      `${added.start.toFixed(3)}s against a playhead at 4s`);
    check(two.rows.includes(`clip:${added.id}`) && two.boxes === 2,
      'on a row of its own, with a box of its own', two.rows.join(', '));
    check(two.selection === added.id && added.selected === true,
      'and the strip selects what it just added - the row and the page it points at, which is '
      + 'one fact rather than two',
      `row ${two.selection}, page on ${two.clips.find((c) => c.selected)?.id}`);
    check(two.undo === one.undo + 1,
      'the add is one undo step, because a clip lives in the document the stack snapshots',
      `${one.undo} to ${two.undo}`);
    check(two.deleteDisabled === false,
      'and delete is offered now that there is a clip to lose', `disabled ${two.deleteDisabled}`);

    // ---- several takes in one press, laid end to end in pick order
    // The generalisation of the add above rather than a second path, so the fixture has to be able
    // to tell the two orders apart: the takes are picked in the reverse of the order the picker
    // lists them, or a build that ignored pick order and used its own listing would pass every row
    // here. Two rather than one because one is the case already driven above.
    {
      const spare = offered.filter((id) => id !== pickId);
      check(spare.length >= 2,
        'the picker offers at least two takes beside the one added above, which is what a pick order '
        + 'can be a fact about rather than a list of one',
        offered.join(', '));
      if (spare.length >= 2) {
        // Reversed against the listing, so `[second, first]` is what a build reading its own order
        // back would get wrong.
        const order = [spare[1], spare[0]];
        const playhead = 6.5;
        await page.evaluate(`(async () => {
          globalThis.__kinect.timeline.transport().pause();
          await globalThis.__kinect.timeline.transport().seek(${playhead});
          await globalThis.__kinect.timeline.settled();
        })()`);
        const before = await read();
        const twoClipDoc = await page.evaluate('__kinect.library.serialiseProjectBody()');
        await page.locator('#tAddClip').click();
        await page.waitForSelector(`#takePicker .tp-tile[data-take="${order[0]}"]`, { timeout: 15000 });
        const room = await page.evaluate('document.querySelector("#takePicker .tp-room").textContent');
        for (const id of order) {
          await page.locator(`#takePicker .tp-tile[data-take="${id}"] .tp-meta`).click();
        }
        // Read the numbered tiles before the dialog closes, then compare them with the rows added.
        const picker = await page.evaluate(`(() => ({
          pressed: [...document.querySelectorAll('#takePicker .tp-tile')]
            .filter((t) => t.getAttribute('aria-pressed') === 'true')
            .map((t) => ({ take: t.dataset.take, at: t.querySelector('.tp-order').textContent })),
        }))()`);
        await page.locator('#takePicker .tp-act.go').click();
        await page.waitForFunction((want) => globalThis.__kinect.timeline.clips().length === want,
          before.clips.length + 2, { timeout: 30000 });
        await settle();
        const many = await read();
        const fresh = many.clips.slice(before.clips.length);

        check(new RegExp(`${CLIP_CEILING - before.clips.length}`).test(room),
          'the picker says how much room this edit has left, which is the ceiling less what it '
          + 'already holds rather than a number written down twice',
          `"${room}" against ${CLIP_CEILING} - ${before.clips.length} clips`);
        // Read by the number on each chip and not by the order the tiles came back in: a
        // `querySelectorAll` answers in document order, which is the picker's listing and is
        // deliberately not the pick order here - so the sequence has to be rebuilt from the
        // numbers, which is what the chips are.
        const numbered = [...picker.pressed].sort((a, b) => Number(a.at) - Number(b.at));
        check(numbered.map((p) => p.take).join(' ') === order.join(' '),
          'and it numbers the picked tiles in the order they were pressed, which is the reading a '
          + 'build laying them in its own order gets wrong before anything is added',
          `${picker.pressed.map((p) => `${p.take}#${p.at}`).join(' ')} reads as ${numbered.map((p) => p.take).join(' ')}`
          + ` against the pick order ${order.join(' ')}`);
        check(fresh.map((c) => c.take).join(' ') === order.join(' '),
          'confirming adds every picked take as a clip, in pick order rather than in the order the '
          + 'picker happened to list them',
          `${fresh.map((c) => c.take).join(' ')} against the pick order ${order.join(' ')}`);
        check(near(fresh[0]?.start ?? -1, playhead, 1 / 30),
          'the first of them lands at the playhead, exactly where one take on its own does',
          `${(fresh[0]?.start ?? -1).toFixed(3)}s against a playhead at ${playhead}s`);
        check(fresh.length === 2 && near(fresh[1].start, fresh[0].end, 1 / 30),
          'and the rest are laid end to end behind it rather than stacked on the same second',
          `${fresh.map((c) => `${c.start.toFixed(2)}..${c.end.toFixed(2)}`).join(' then ')}`);
        check(many.rows.includes(`clip:${fresh[0].id}`) && many.rows.includes(`clip:${fresh[1].id}`)
          && many.boxes === many.clips.length,
          'each of them on a row of its own, so the strip is the edit rather than the last add',
          `${many.boxes} boxes over ${many.clips.length} clips: ${many.rows.join(', ')}`);
        // Read rather than asserted at a number: `addClipsFromTakes` commits per clip, so the
        // depth this moves by is a fact about that loop and a row pinning it would be asserting
        // the implementation rather than the behaviour.
        console.log(`  ...   ${fresh.length} clips added in one press cost ${many.undo - before.undo} `
          + 'undo step(s), and the ceiling refusal itself is not driven here: this library holds '
          + `${offered.length} takes against a ceiling of ${CLIP_CEILING}, so no pick can cross it`);

        // Back to the two clips the rows after this one are written against, through the
        // document rather than by deleting: `restoreProject` is the door those rows already use.
        await page.evaluate(({ project, selection }) => {
          __kinect.timeline.transport().pause();
          __kinect.library.restoreProject(project);
          __kinect.editor.selectClipRow(selection);
          __kinect.keyframes.undo.begin();
        }, { project: twoClipDoc, selection: two.selection });
        await settle();
      }
    }

    // The selection, by clicking a row.
    const boxAt = async (i) => {
      const box = (await page.$$('.tclip'))[i];
      const r = await box.boundingBox();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, r };
    };
    const first = await boxAt(0);
    await page.mouse.click(first.x, first.y);
    await settle();
    const picked = await read();
    check(picked.selection === picked.clips[0].id,
      'clicking a clip\'s row selects that clip', `${picked.selection}`);
    // The move as well as the destination: a build whose row selection never reached the page
    // would leave the page on the clip it opened with, which is this clip, and the row would
    // pass on the defect it exists to catch.
    check(picked.clips[0].selected === true && picked.clips[1].selected === false
      && two.clips.find((c) => c.selected)?.id !== picked.clips.find((c) => c.selected)?.id,
    'and the panel and the speed binding move with it, so the selection is one fact rather than two',
    `${two.clips.find((c) => c.selected)?.id} then `
      + picked.clips.map((c) => `${c.id}:${c.selected}`).join(' '));

    // Marks, mapped through the selected clip's placement.
    const selectedMarksLoaded = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return response.request().method() === 'GET'
        && url.pathname === `/capture/${encodeURIComponent(pickId)}/marks`;
    });
    await page.mouse.click((await boxAt(1)).x, (await boxAt(1)).y);
    await selectedMarksLoaded;
    await settle();
    const MARK_SOURCE_MS = 1500;
    await page.evaluate(
      `globalThis.__kinect.editor.setMarks([{ id: 'placed', sourceMs: ${MARK_SOURCE_MS}, label: 'placed' }])`,
    );
    await page.keyboard.press('f');
    await settle();
    const marked = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const clip = k.timeline.clips().find((c) => c.selected);
      return {
        clip: clip.id,
        start: clip.start,
        program: k.editor.markProgramSec(${MARK_SOURCE_MS} / 1000),
        ticks: k.library.markTicks(),
        duration: k.timeline.read().duration,
      };
    })()`);
    console.log(`  a mark at source ${MARK_SOURCE_MS / 1000}s of ${marked.clip} `
      + `(placed at ${marked.start.toFixed(2)}s) ticks at program ${marked.program.toFixed(3)}s, `
      + `drawn at ${marked.ticks.map((t) => t.left.toFixed(2)).join(', ')}%`);
    check(marked.start > 0.5,
      'the selected clip is placed away from the head of the edit, which is what makes the two '
      + 'rows below a claim about placement rather than about source timing',
      `${marked.start.toFixed(3)}s`);
    check(near(marked.program, marked.start + MARK_SOURCE_MS / 1000, 0.05),
      'a mark ticks at the selected clip\'s placement plus its source timing, because a mark is a fact '
      + 'about footage and which clip of it the ruler is drawing is the selection',
      `${marked.program.toFixed(3)}s against ${(marked.start + MARK_SOURCE_MS / 1000).toFixed(3)}s`);
    // Against the placement and the source second rather than against `markProgramSec`: a build
    // that dropped the placement from that reading would move both sides of the comparison and
    // the row would pass on the defect it exists to catch.
    const wantLeft = ((marked.start + MARK_SOURCE_MS / 1000) / marked.duration) * 100;
    check(marked.ticks.length === 1 && near(marked.ticks[0].left, wantLeft, 0.5),
      'and the tick is drawn where that says, rather than where the source second alone would put it',
      `${marked.ticks[0]?.left.toFixed(2)}% against ${wantLeft.toFixed(2)}%`);

    // Both write gestures at a program second before this placed clip. The sidecar stores source
    // time, so extrapolating the clip timing here would write a negative time the take has never
    // contained. The route returns the submitted list and keeps the real sidecar untouched.
    const markWrites = [];
    const markPattern = '**/capture/*/marks';
    const recordMarkWrite = async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      const body = route.request().postDataJSON();
      markWrites.push(body.marks[0]);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ marks: body.marks }),
      });
    };
    await page.route(markPattern, recordMarkWrite);
    try {
      await page.evaluate(`(async () => {
        const k = globalThis.__kinect;
        await k.timeline.transport().seek(0);
        await k.timeline.settled();
        k.editor.setMarks([]);
        return k.library.markHere();
      })()`);

      await page.evaluate(`(() => {
        __kinect.editor.setMarks([{ id: 'dragged', sourceMs: ${MARK_SOURCE_MS}, label: 'dragged' }]);
        __kinect.editor.view.fit();
      })()`);
      await settle();
      const tickBox = await page.locator('#tMarks .tmk').boundingBox();
      const bedBox = await page.locator('#tBed').boundingBox();
      const draggedResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === 'POST'
          && url.pathname === `/capture/${encodeURIComponent(pickId)}/marks`;
      });
      await page.mouse.move(tickBox.x + tickBox.width / 2, tickBox.y + tickBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(bedBox.x + 1, tickBox.y + tickBox.height / 2, { steps: 8 });
      await page.mouse.up();
      await draggedResponse;
    } finally {
      await page.unroute(markPattern, recordMarkWrite);
    }
    check(markWrites.length === 2 && markWrites[0].sourceMs === 0,
      'planting a mark before the selected clip pins it to the first source millisecond rather '
        + 'than writing an extrapolated negative time',
      `${markWrites.length} writes; planted at source ${markWrites[0]?.sourceMs}ms`);
    check(markWrites.length === 2 && markWrites[1].id === 'dragged' && markWrites[1].sourceMs === 0,
      'and dragging a mark there applies the same source bound through the pointer gesture',
      `${markWrites.length} writes; dragged at source ${markWrites[1]?.sourceMs}ms`);
    // The two doors onto the same edit. Both plant a mark at the playhead and both take away the
    // one already under it, and the key is asserted as well as the button because the key reached
    // only half of that and stacked a second mark on the first, invisibly, at one source second.
    // Served over a route that merges the way the sidecar does - the response is the surviving
    // list, so a tombstone has to remove a mark rather than become one.
    const toggleState = new Map();
    const togglePattern = '**/capture/*/marks';
    const recordToggle = async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      for (const mark of route.request().postDataJSON().marks) {
        if (mark.deleted) toggleState.delete(mark.id);
        else toggleState.set(mark.id, mark);
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ marks: [...toggleState.values()] }),
      });
    };
    await page.route(togglePattern, recordToggle);
    const ticks = () => page.evaluate('__kinect.library.markTicks().length');
    try {
      await page.evaluate(`(async () => {
        const k = globalThis.__kinect;
        k.editor.setMarks([]);
        await k.timeline.transport().seek(k.timeline.clips().find((c) => c.selected).start + 1);
        await k.timeline.settled();
      })()`);
      await settle();
      await page.locator('#tMark').click();
      await settle();
      const buttonPlanted = await ticks();
      await page.locator('#tMark').click();
      await settle();
      const buttonRemoved = await ticks();
      check(buttonPlanted === 1 && buttonRemoved === 0,
        'the mark button plants one at the playhead and presses again to take that one away',
        `${buttonPlanted} tick after the first press, ${buttonRemoved} after the second`);

      await focusStage();
      await page.keyboard.press('m');
      await settle();
      const keyPlanted = await ticks();
      await page.keyboard.press('m');
      await settle();
      const keyRemoved = await ticks();
      check(keyPlanted === 1 && keyRemoved === 0,
        '  and M is the same edit through the other door, rather than a second mark on top of the first',
        `${keyPlanted} tick after the first press, ${keyRemoved} after the second`);
    } finally {
      await page.unroute(togglePattern, recordToggle);
    }

    await page.evaluate(
      `globalThis.__kinect.editor.setMarks([{ id: 'placed', sourceMs: ${MARK_SOURCE_MS}, label: 'placed' }])`,
    );

    if (other) {
      const pattern = '**/capture/*/marks';
      let heldPost = null;
      let sawPost;
      const postSeen = new Promise((resolve) => { sawPost = resolve; });
      const currentMarks = [{ id: 'current-take', sourceMs: 250, label: 'current take' }];
      const staleMarks = [{ id: 'stale-take', sourceMs: 750, label: 'stale take' }];
      const holdMarkWrite = async (route) => {
        if (route.request().method() === 'POST') {
          heldPost = route;
          sawPost();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ marks: currentMarks }),
        });
      };
      await page.route(pattern, holdMarkWrite);
      let pendingWrite = null;
      try {
        pendingWrite = page.evaluate('__kinect.library.markHere()');
        await Promise.race([
          postSeen,
          new Promise((_, reject) => { setTimeout(() => reject(new Error('mark POST did not start')), 10000); }),
        ]);
        await page.evaluate(`__kinect.editor.selectClipRow(${JSON.stringify(two.clips[0].id)})`);
        await page.waitForFunction(
          `(id) => __kinect.library.takeId() === id
            && __kinect.library.marks()[0]?.id === 'current-take'`,
          two.clips[0].take,
          { timeout: 10000 },
        );
        await heldPost.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ marks: staleMarks }),
        });
        const adopted = await pendingWrite;
        pendingWrite = null;
        const afterResponse = await page.evaluate(`({
          take: __kinect.library.takeId(),
          marks: __kinect.library.marks(),
        })`);
        check(adopted === false && afterResponse.take === two.clips[0].take
          && afterResponse.marks.length === 1 && afterResponse.marks[0].id === 'current-take',
        'a mark response from the take selected before the request cannot replace the marks of '
          + 'the take selected while that request was in flight',
        `adopted ${adopted}, on ${afterResponse.take}, marks ${afterResponse.marks.map((m) => m.id).join(', ')}`);
      } finally {
        if (heldPost && pendingWrite) {
          await heldPost.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({ marks: staleMarks }),
          }).catch(() => {});
          await pendingWrite.catch(() => {});
        }
        await page.unroute(pattern, holdMarkWrite);
      }
    } else {
      note('[22] the mark response-order arm is not run',
        'it needs a second take so the selected take can change while the first take writes');
    }

    console.log('\n[22b] the handles that move a clip, and the half of a preset that is shared');

    // Stage one ordinary clip with no keys. Head trims must change timing fields, not grow a
    // hidden timing lane or key that the current document format does not have.
    await page.mouse.click((await boxAt(1)).x, (await boxAt(1)).y);
    await settle();
    const TRIM_PROBE = '__editor-check-pointer-trim__';
    const timingFixture = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const body = k.library.serialiseProjectBody();
      body.look.tracks = {};
      body.composition.camera = [];
      for (const clip of body.clips) clip.tracks = {};
      const clip = body.clips.find((candidate) => candidate.id === k.editor.clipSelection());
      clip.length = 8;
      clip.speed = 1;
      clip.sourceStart = 0;
      k.library.restoreProject(body);
      k.editor.selectClipRow(clip.id);
      k.editor.view.fit();
      k.keyframes.undo.begin();
      return clip.id;
    })()`);
    await settle();

    const bed = await page.locator('#tBed').boundingBox();
    const selectedTiming = () => page.evaluate(() => {
      const k = globalThis.__kinect;
      const c = k.timeline.clips().find((candidate) => candidate.selected);
      return {
        id: c.id,
        start: c.start,
        end: c.end,
        trim: c.trim,
        length: c.length,
        speed: c.speed,
        sourceStart: c.sourceStart,
        keys: document.querySelectorAll('#tLanes .tkey').length,
        rateKey: document.getElementById('tRateKey') !== null,
        rateDisabled: document.getElementById('tRate').disabled,
        undo: k.keyframes.undo.depth(),
      };
    });
    const sourceAt = async (programSec) => {
      await page.evaluate((at) => __kinect.timeline.transport().seek(at), programSec);
      await settle();
      return page.evaluate('__kinect.timeline.read().sourceSec');
    };
    const dragSelected = async (side, delta, destination = null) => {
      const r = (await boxAt(1)).r;
      const x = side === 'head' ? r.x + 3
        : side === 'tail' ? r.x + r.width - 3 : r.x + r.width / 2;
      const y = r.y + r.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(destination ?? x + delta, y, { steps: 8 });
      await page.mouse.up();
      await settle();
    };

    const beforeHead = await selectedTiming();
    const fixedBodyPosition = beforeHead.start + beforeHead.length - 0.5;
    const beforeHeadSource = await sourceAt(fixedBodyPosition);
    await dragSelected('head', bed.width * 0.04);
    const afterHead = await selectedTiming();
    const afterHeadSource = await sourceAt(fixedBodyPosition);
    console.log(`  head trim on ${timingFixture}: ${beforeHead.start.toFixed(3)}s -> `
      + `${afterHead.start.toFixed(3)}s, in-point ${beforeHead.sourceStart.toFixed(3)}s -> `
      + `${afterHead.sourceStart.toFixed(3)}s, fixed source ${beforeHeadSource.toFixed(4)}s -> `
      + `${afterHeadSource.toFixed(4)}s`);
    check(afterHead.start > beforeHead.start + 0.2 && afterHead.sourceStart > beforeHead.sourceStart,
      'dragging a clip\'s head later moves both its project in-point and its source in-point',
      `start ${beforeHead.start.toFixed(3)}s -> ${afterHead.start.toFixed(3)}s, source `
        + `${beforeHead.sourceStart.toFixed(3)}s -> ${afterHead.sourceStart.toFixed(3)}s`);
    check(near(afterHead.end, beforeHead.end, 1e-6)
      && afterHead.length < beforeHead.length - 0.2,
    'and leaves its out-point where it was, so the head shortens the clip rather than moving it',
    `end ${beforeHead.end.toFixed(4)}s -> ${afterHead.end.toFixed(4)}s, length `
      + `${beforeHead.length.toFixed(4)}s -> ${afterHead.length.toFixed(4)}s`);
    check(near(afterHeadSource, beforeHeadSource, 1e-9),
      'and the footage under what is left holds still, which is what makes it a trim rather than '
        + 'a slip: the same project second stands on the same source time',
      `source ${beforeHeadSource.toFixed(4)}s against ${afterHeadSource.toFixed(4)}s `
        + `at ${fixedBodyPosition.toFixed(2)}s`);
    check(beforeHead.keys === 0 && afterHead.keys === 0 && !afterHead.rateKey,
      'and the trim creates no timing key in the strip and no removed speed-key control in the DOM',
      `${beforeHead.keys} keys before, ${afterHead.keys} after, speed-key control ${afterHead.rateKey}`);
    check(afterHead.rateDisabled === false,
      'while the speed slider still answers on the trimmed clip',
      `disabled ${afterHead.rateDisabled}`);

    const draggedTiming = {
      start: afterHead.start,
      trim: afterHead.trim,
      length: afterHead.length,
      speed: afterHead.speed,
      sourceStart: afterHead.sourceStart,
    };
    await page.evaluate(`(async () => {
      const k = __kinect;
      const res = await __ecWrite('/projects/${TRIM_PROBE}', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(k.library.serialiseProjectBody()),
      });
      if (!res.ok) throw new Error('the pointer-trim project could not be saved: ' + res.status);
      await k.library.loadProject('${TRIM_PROBE}');
      await k.timeline.settled();
    })()`);
    await settle();
    const reloadedDrag = await page.evaluate((id) => {
      const clip = __kinect.timeline.clips().find((candidate) => candidate.id === id);
      return { start: clip.start, trim: clip.trim, length: clip.length,
        speed: clip.speed, sourceStart: clip.sourceStart };
    }, timingFixture);
    check(['start', 'trim', 'length', 'speed', 'sourceStart']
      .every((name) => near(reloadedDrag[name], draggedTiming[name], 1e-9)),
    'saving and loading the project preserves the timing produced by the pointer head trim',
    `${JSON.stringify(draggedTiming)} -> ${JSON.stringify(reloadedDrag)}`);
    await page.evaluate((id) => __kinect.editor.selectClipRow(id), timingFixture);
    await settle();

    const anchorAt = afterHead.start + Math.min(2, afterHead.length / 2);
    await page.evaluate((at) => __kinect.timeline.transport().seek(at), anchorAt);
    await settle();
    const beforeSpeed = await page.evaluate('__kinect.timeline.read()');
    await driveRate(1.5);
    const afterSpeed = await page.evaluate('__kinect.timeline.read()');
    const speedAnchorDrift = Math.abs(afterSpeed.sourceSec - beforeSpeed.sourceSec);
    const speedAnchorBound = afterSpeed.speed / (2 * afterSpeed.outputFps);
    check(speedAnchorDrift <= speedAnchorBound + 1e-9
      && near(afterSpeed.sourceStart, beforeSpeed.sourceStart, 1e-9)
      && Math.abs(afterSpeed.programSec - beforeSpeed.programSec) > 0.1,
    'changing speed on the trimmed clip holds the source frame to the nearest output frame by '
      + 'moving the playhead, not its in-point',
    `source ${beforeSpeed.sourceSec.toFixed(4)}s -> ${afterSpeed.sourceSec.toFixed(4)}s, `
      + `program ${beforeSpeed.programSec.toFixed(4)}s -> ${afterSpeed.programSec.toFixed(4)}s, `
      + `in-point ${beforeSpeed.sourceStart.toFixed(4)}s -> ${afterSpeed.sourceStart.toFixed(4)}s, `
      + `drift ${(speedAnchorDrift * 1000).toFixed(2)}ms against a `
      + `${(speedAnchorBound * 1000).toFixed(2)}ms output-grid bound`);

    const beforeTail = await selectedTiming();
    await dragSelected('tail', -bed.width * 0.025);
    const afterTail = await selectedTiming();
    check(afterTail.end < beforeTail.end - 0.1 && afterTail.length < beforeTail.length - 0.1,
      'dragging the tail earlier moves the out-point and shortens the clip',
      `end ${beforeTail.end.toFixed(3)}s -> ${afterTail.end.toFixed(3)}s, length `
        + `${beforeTail.length.toFixed(3)}s -> ${afterTail.length.toFixed(3)}s`);
    check(near(afterTail.start, beforeTail.start, 1e-9)
      && near(afterTail.sourceStart, beforeTail.sourceStart, 1e-9)
      && near(afterTail.speed, beforeTail.speed, 1e-9),
    'and the tail leaves the project in-point, source in-point and speed alone',
    `start ${beforeTail.start.toFixed(4)}s -> ${afterTail.start.toFixed(4)}s, source `
      + `${beforeTail.sourceStart.toFixed(4)}s -> ${afterTail.sourceStart.toFixed(4)}s, speed `
      + `${beforeTail.speed}x -> ${afterTail.speed}x`);

    const beforeBody = await selectedTiming();
    await dragSelected('body', bed.width * 0.03);
    const afterBody = await selectedTiming();
    const bodyStartMove = afterBody.start - beforeBody.start;
    const bodyEndMove = afterBody.end - beforeBody.end;
    check(bodyStartMove > 0.1 && near(bodyStartMove, bodyEndMove, 1e-6),
      'dragging the clip body moves both ends by the same project time',
      `start moved ${bodyStartMove.toFixed(4)}s, end moved ${bodyEndMove.toFixed(4)}s`);
    check(near(afterBody.length, beforeBody.length, 1e-9)
      && near(afterBody.sourceStart, beforeBody.sourceStart, 1e-9)
      && near(afterBody.speed, beforeBody.speed, 1e-9),
    'and the body leaves its length, source in-point and speed alone',
    `length ${beforeBody.length.toFixed(4)}s -> ${afterBody.length.toFixed(4)}s, source `
      + `${beforeBody.sourceStart.toFixed(4)}s -> ${afterBody.sourceStart.toFixed(4)}s, speed `
      + `${beforeBody.speed}x -> ${afterBody.speed}x`);

    await page.evaluate('__kinect.editor.view.fit()');
    await settle();
    const beforeHeadBack = await selectedTiming();
    await dragSelected('head', 0, bed.x - 20);
    const afterHeadBack = await selectedTiming();
    const sourceHead = Math.max(0,
      beforeHeadBack.start - beforeHeadBack.sourceStart / beforeHeadBack.speed);
    check(afterHeadBack.sourceStart === 0 && near(afterHeadBack.start, sourceHead, 1e-9)
      && near(afterHeadBack.end, beforeHeadBack.end, 1e-6),
    'dragging the head back to the take starts at source zero and still holds the out-point',
    `start ${beforeHeadBack.start.toFixed(4)}s -> ${afterHeadBack.start.toFixed(4)}s `
      + `(floor ${sourceHead.toFixed(4)}s), source ${beforeHeadBack.sourceStart.toFixed(4)}s -> `
      + `${afterHeadBack.sourceStart.toFixed(4)}s, end ${beforeHeadBack.end.toFixed(4)}s -> `
      + `${afterHeadBack.end.toFixed(4)}s`);
    check(afterHeadBack.undo === beforeHeadBack.undo + 1,
      'and that head trim costs one undo step',
      `depth ${beforeHeadBack.undo} -> ${afterHeadBack.undo}`);

    await page.evaluate('__kinect.keyframes.undo.pop()');
    await settle();
    const undoneHeadBack = await selectedTiming();
    check(undoneHeadBack.undo === beforeHeadBack.undo
      && ['start', 'end', 'trim', 'length', 'speed', 'sourceStart']
        .every((name) => near(undoneHeadBack[name], beforeHeadBack[name], 1e-9)),
    'undo puts the clip timing from before that head trim back as one unit',
    `depth ${afterHeadBack.undo} -> ${undoneHeadBack.undo}; `
      + `timing ${JSON.stringify({ start: beforeHeadBack.start, trim: beforeHeadBack.trim,
        speed: beforeHeadBack.speed, sourceStart: beforeHeadBack.sourceStart })} -> `
      + JSON.stringify({ start: undoneHeadBack.start, trim: undoneHeadBack.trim,
        speed: undoneHeadBack.speed, sourceStart: undoneHeadBack.sourceStart }));

    // The delete, and the undo of it.
    const before = await read();
    const deletingLive = await page.evaluate(`(async () => {
      const k = __kinect;
      const transport = k.timeline.transport();
      transport.pause();
      const clip = k.timeline.clips().find((candidate) => candidate.id === k.editor.clipSelection());
      const at = Math.min(clip.end - 1 / transport.outputFps, clip.start + 0.5);
      await transport.seek(at);
      await k.timeline.settled();
      await transport.play();
      return {
        program: transport.programSec,
        seeks: k.timeline.counters.seeks,
        playing: transport.playing,
      };
    })()`);
    await page.locator('#tDeleteClip').click();
    for (let i = 0; i < 250; i++) {
      const ready = await page.evaluate((seeks) => __kinect.timeline.counters.seeks > seeks
        && __kinect.timeline.transport().playing, deletingLive.seeks);
      if (ready) break;
      await new Promise((resolve) => { setTimeout(resolve, 20); });
    }
    const afterLiveDelete = await page.evaluate(`({
      program: __kinect.timeline.transport().programSec,
      duration: __kinect.timeline.transport().duration,
      seeks: __kinect.timeline.counters.seeks,
      playing: __kinect.timeline.transport().playing,
    })`);
    check(deletingLive.playing && afterLiveDelete.seeks > deletingLive.seeks,
      'deleting a live clip pauses and reseeks the surviving composite instead of carrying its surface history forward',
      `playing before ${deletingLive.playing}, seeks ${deletingLive.seeks} -> ${afterLiveDelete.seeks}`);
    check(afterLiveDelete.playing
      && afterLiveDelete.program >= Math.min(deletingLive.program, afterLiveDelete.duration) - 1 / 30,
    'and restores playback at the held program position after that seek',
    `playing ${afterLiveDelete.playing}, program ${deletingLive.program.toFixed(3)}s -> ${afterLiveDelete.program.toFixed(3)}s`);
    await page.evaluate('__kinect.timeline.transport().pause()');
    await settle();
    const gone = await read();
    check(gone.clips.length === 1 && gone.clips[0].id !== added.id,
      'delete removes the selected clip', gone.clips.map((c) => c.id).join(', '));
    check(gone.selection !== null && gone.selection !== added.id
      && gone.selection === gone.clips[0].id,
    'and puts the strip on whatever took its place rather than on nothing, because the panel greys '
    + 'its clip half when the strip holds no clip and an edit that still has clips has one to edit',
    `${gone.selection}`);
    await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+z`);
    await settle();
    const back = await read();
    console.log(`  after undo: ${back.clips.map((c) => `${c.id} of ${c.take} at ${c.start.toFixed(2)}s`).join(', ')}`);
    check(back.clips.length === 2,
      'undo puts the clip back, which needs the footage it was cut on to still be open - opening '
      + 'it again would be a fetch and the undo path cannot await one',
      back.clips.map((c) => c.id).join(', '));
    check(back.clips[1]?.take === before.clips[1].take
      && near(back.clips[1]?.start ?? -1, before.clips[1].start, 1e-6),
    'and it comes back on the take it was cut on, at the placement it had',
    `${back.clips[1]?.take} at ${back.clips[1]?.start?.toFixed(3)}s`);


    // The sequence the naive fix misses: delete the last clip of a take, make one more edit, and
    // undo twice. The first undo is what runs `applyProject` over a document that no longer names
    // the deleted take, so a build that dropped the take there refuses on the second.
    if (other) {
      const twoAgain = await read();
      check(twoAgain.clips.length === 2 && twoAgain.clips[1].take === pickId,
        `the edit is back on two clips, one of them the only clip of ${pickId}, which is what `
        + 'makes the sequence below about a take going out of use',
        twoAgain.clips.map((c) => `${c.id}:${c.take}`).join(' '));
      await page.mouse.click((await boxAt(1)).x, (await boxAt(1)).y);
      await settle();
      await page.locator('#tDeleteClip').click();
      await settle();
      // One more edit on top of the delete, so the undo of it is not the top of the stack.
      // Through the document and not through `timeline.clips()`: that handle rebuilds its array
      // on every call, so `clips()[0].start = …` writes to an object nothing ever reads again and
      // the commit below finds nothing to push - which leaves the two rows under it asserting
      // against a stack one entry shorter than the sequence they describe.
      const moved = await page.evaluate(`(() => {
        const k = globalThis.__kinect;
        const body = k.library.serialiseProjectBody();
        body.clips[0].start = 0.75;
        k.library.restoreProject(body);
        k.keyframes.undo.commit();
        return k.timeline.clips()[0].start;
      })()`);
      const afterBoth = await read();
      const key = process.platform === 'darwin' ? 'Meta' : 'Control';
      await page.keyboard.press(`${key}+z`);
      await settle();
      const undoneOnce = await read();
      let secondUndo = null;
      try {
        await page.keyboard.press(`${key}+z`);
        await settle();
        secondUndo = await read();
      } catch (err) {
        secondUndo = { error: String(err.message ?? err) };
      }
      console.log(`  delete the only clip of ${pickId}, move ${afterBoth.clips[0].id} to `
        + `${moved}s, then undo twice: ${undoneOnce.clips.length} clip(s) after one, `
        + `${secondUndo.clips ? secondUndo.clips.length : 'threw'} after two`);
      check(undoneOnce.clips.length === 1 && near(undoneOnce.clips[0].start, 0, 1e-9),
        'the first undo takes back the edit made after the delete and leaves the delete standing',
        `${undoneOnce.clips.length} clip(s), first at ${undoneOnce.clips[0]?.start}`);
      check(Boolean(secondUndo.clips) && secondUndo.clips.length === 2,
        'and the second takes back the delete itself, one step further down a stack that has '
        + 'already run `applyProject` over a document naming no such take',
        secondUndo.clips ? secondUndo.clips.map((c) => c.id).join(', ') : secondUndo.error);
      check(secondUndo.clips?.[1]?.take === pickId,
        `and the clip comes back on ${pickId} rather than on whatever the surviving slot held`,
        `${secondUndo.clips?.[1]?.take}`);
    } else {
      note('[22] the two-undo sequence is not run',
        'it needs a second take so the deleted clip is the last user of its footage, and this '
        + 'library holds one take');
    }

    // The view window is the project's, not the first clip's.
    const framed = await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      const clips = k.timeline.clips();
      const last = clips[clips.length - 1];
      const t = k.timeline.transport();
      return { duration: t.duration, ends: clips.map((c) => c.end), longest: last.end };
    })()`);
    check(near(framed.duration, Math.max(...framed.ends), 1e-6),
      'the edit is as long as its furthest clip reaches, so the window fits the film rather than '
      + 'the first clip', `${framed.duration.toFixed(3)}s against ends ${framed.ends.map((e) => e.toFixed(2)).join(', ')}`);

    console.log('\n  clip presets keep their scope and provenance');

    // Two clips, staged rather than inherited: section 22 above finishes on whatever its undo
    // sequence left, and both arms below are comparisons between two clips.
    const staged = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const body = k.library.serialiseProjectBody();
      const first = JSON.parse(JSON.stringify(body.clips[0]));
      const second = JSON.parse(JSON.stringify(body.clips[0]));
      second.id = 'gz2';
      second.start = 4;
      first.params.pointSize = 6.5;
      second.params.pointSize = 37.5;
      body.clips = [first, second];
      k.library.restoreProject(body);
      k.editor.selectClipRow('gz2');
      return k.timeline.clips().map((c) => ({ id: c.id, start: c.start }));
    })()`);
    check(staged.length === 2 && staged[1].id === 'gz2',
      'two clips are staged for this section, which is what makes both arms below a comparison',
      staged.map((c) => `${c.id} at ${c.start}s`).join(', '));

    const stagedProject = await page.evaluate('__kinect.library.serialiseProjectBody()');
    const rateWindowBefore = await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      const body = k.library.serialiseProjectBody();
      body.clips[0].start = 0;
      body.clips[0].length = 10;
      body.clips[0].speed = 1;
      body.clips[0].sourceStart = 0;
      body.clips[1].start = 10;
      body.clips[1].length = null;
      body.clips[1].speed = 1;
      body.clips[1].sourceStart = 0;
      k.library.restoreProject(body);
      k.editor.selectClipRow('gz2');
      const duration = k.timeline.transport().duration;
      k.editor.view.set(10 / duration, 1);
      await k.timeline.transport().seek(12);
      await k.timeline.settled();
      return k.editor.view.window();
    })()`);
    await driveRate(2);
    const rateWindowAfter = await page.evaluate('__kinect.editor.view.window()');
    check(rateWindowAfter.duration < rateWindowBefore.duration - 1
      && near(rateWindowBefore.startSec, 10, 1e-6),
    'the selected untrimmed clip shortens a multi-clip project whose ruler starts at its 10s in-point',
    `duration ${rateWindowBefore.duration.toFixed(3)}s -> ${rateWindowAfter.duration.toFixed(3)}s, `
      + `window started at ${rateWindowBefore.startSec.toFixed(3)}s`);
    check(near(rateWindowAfter.startSec, 10, 1e-6)
      && near(rateWindowAfter.endSec, rateWindowAfter.duration, 1e-6),
    'and the ruler keeps the program bounds it was showing instead of applying stale whole-project fractions',
    `window ${rateWindowBefore.startSec.toFixed(3)}-${rateWindowBefore.endSec.toFixed(3)}s -> `
      + `${rateWindowAfter.startSec.toFixed(3)}-${rateWindowAfter.endSec.toFixed(3)}s`);
    await page.evaluate((body) => {
      __kinect.library.restoreProject(body);
      __kinect.editor.selectClipRow('gz2');
      __kinect.editor.view.fit();
    }, stagedProject);
    await settle();

    await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      await k.timeline.transport().seek(5);
      await k.timeline.settled();
      await k.timeline.transport().play();
    })()`);
    await page.waitForFunction('__kinect.timeline.transport().playing', null, { timeout: 15000 });
    const movingClipBefore = await page.evaluate(`(() => {
      const clip = __kinect.timeline.clips().find((candidate) => candidate.id === 'gz2');
      return { start: clip.start, program: __kinect.timeline.transport().programSec };
    })()`);
    {
      const movingBox = (await page.$$('.tclip'))[1];
      const r = await movingBox.boundingBox();
      await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
      await page.mouse.down();
      const pausedDuringClipMove = await page.evaluate('__kinect.timeline.transport().playing');
      await page.mouse.move(r.x + r.width / 2 + (await page.locator('#tBed').boundingBox()).width * 0.04,
        r.y + r.height / 2, { steps: 6 });
      await page.mouse.up();
      for (let i = 0; i < 100 && !(await page.evaluate('__kinect.timeline.transport().playing')); i++) {
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
      const movingClipAfter = await page.evaluate(`(() => {
        const clip = __kinect.timeline.clips().find((candidate) => candidate.id === 'gz2');
        return {
          start: clip.start,
          playing: __kinect.timeline.transport().playing,
          program: __kinect.timeline.transport().programSec,
        };
      })()`);
      check(pausedDuringClipMove === false && movingClipAfter.start > movingClipBefore.start + 0.2,
        'dragging a live clip pauses playback before its source mapping moves',
        `playing during drag ${pausedDuringClipMove}, start ${movingClipBefore.start.toFixed(3)}s -> ${movingClipAfter.start.toFixed(3)}s`);
      check(movingClipAfter.playing
        && movingClipAfter.program >= movingClipBefore.program - 1 / 30,
      'and seeks the edited mapping before restoring playback at the held program position',
      `playing ${movingClipAfter.playing}, program ${movingClipBefore.program.toFixed(3)}s -> ${movingClipAfter.program.toFixed(3)}s`);
    }
    await page.evaluate((body) => {
      __kinect.timeline.transport().pause();
      __kinect.library.restoreProject(body);
      __kinect.editor.selectClipRow('gz2');
    }, stagedProject);
    await page.evaluate('__kinect.timeline.transport().seek(5)');
    await settle();

    // Both tracks are evaluated because both clouds must be ready to draw. Only the selected
    // clip may paint the one inspector the clips share, regardless of which clip is evaluated
    // last. The selected track sits at the default so the reset control checks the same owner.
    const evaluatedPanel = await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      const clean = k.library.serialiseProjectBody();
      const keyed = JSON.parse(JSON.stringify(clean));
      const selected = keyed.clips[0];
      const other = keyed.clips[1];
      const defaultValue = k.params.spec('pointSize').default;
      selected.tracks.pointSize = [{ t: 0, value: defaultValue }];
      other.tracks.pointSize = [{ t: 0, value: defaultValue + 20 }];
      k.library.restoreProject(keyed);
      k.editor.selectClipRow(selected.id);
      await k.timeline.transport().seek(5);
      await k.timeline.settled();
      const control = document.getElementById('pointSize');
      const reset = document.querySelector('.reset[data-reset="pointSize"]');
      const result = {
        selected: k.editor.clipSelection(),
        selectedValue: k.params.get('pointSize'),
        otherValue: k.library.serialiseProjectBody().clips.find((c) => c.id === other.id)
          .params.pointSize,
        controlValue: Number(control.value),
        resetDisabled: reset.disabled,
      };
      k.library.restoreProject(clean);
      k.editor.selectClipRow('gz2');
      return result;
    })()`);
    console.log(`  keyed values after a render: selected ${evaluatedPanel.selectedValue}, other `
      + `${evaluatedPanel.otherValue}; the shared control shows ${evaluatedPanel.controlValue}, `
      + `reset disabled ${evaluatedPanel.resetDisabled}`);
    check(evaluatedPanel.selectedValue !== evaluatedPanel.otherValue
      && evaluatedPanel.controlValue === evaluatedPanel.selectedValue,
    'after every clip evaluates its keyed look, the shared control still shows the selected '
      + 'clip rather than the last clip evaluated',
    `selected ${evaluatedPanel.selectedValue}, other ${evaluatedPanel.otherValue}, control `
      + `${evaluatedPanel.controlValue}`);
    check(evaluatedPanel.resetDisabled === true,
      'and its reset state is the selected clip\'s too',
      `reset disabled ${evaluatedPanel.resetDisabled}`);

    // The handles, armed by the command they are drawn beside.
    await page.locator('#tMoveClip').click();
    await settle();
    const armed = await page.evaluate('__kinect.editor.gizmo()');
    // The commands are drawn in the bed rather than in the rail, so a press on one arrives at
    // the same handler that clears the selection on empty space. That cost a run: the clear
    // rebuilt the stack and re-parented the button between the press and its click, and
    // `+ add clip` stopped opening at all.
    check(await page.evaluate('__kinect.editor.clipSelection()') === 'gz2',
      'pressing a command on the clip bar leaves the clip selected, because the bar is furniture '
      + 'rather than the empty part of the stack',
      `${await page.evaluate('__kinect.editor.clipSelection()')}`);
    check(armed.mode === 'translate' && armed.clip === 'gz2' && armed.shown === true,
      'pressing move arms the translate handles on the selected clip and draws them',
      `${armed.mode} on ${armed.clip}, shown ${armed.shown}`);

    // The handles are editor furniture. The look must change the picture behind them without
    // changing the axis pixels themselves.
    const gizmoBox = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const clip = k.timeline.clips().find((c) => c.id === 'gz2');
      const point = k.freeCamera.position.clone().fromArray(clip.placement.position);
      point.project(k.freeCamera);
      const canvas = k.renderer.domElement.getBoundingClientRect();
      const size = Math.min(240, Math.floor(canvas.width), Math.floor(canvas.height));
      const cx = canvas.left + (point.x + 1) * canvas.width / 2;
      const cy = canvas.top + (1 - point.y) * canvas.height / 2;
      return {
        x: Math.max(canvas.left, Math.min(canvas.right - size, cx - size / 2)),
        y: Math.max(canvas.top, Math.min(canvas.bottom - size, cy - size / 2)),
        width: size,
        height: size,
      };
    })()`);
    const gizmoPixels = async () => {
      const shot = await page.screenshot({ clip: gizmoBox });
      return page.evaluate(`(async (dataUrl) => {
        const img = new Image();
        img.src = dataUrl;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const context = canvas.getContext('2d');
        context.drawImage(img, 0, 0);
        const pixels = context.getImageData(0, 0, img.width, img.height).data;
        let pictureHash = 2166136261;
        let axisHash = 2166136261;
        let axes = 0;
        const mix = (hash, value) => Math.imul(hash ^ value, 16777619);
        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          pictureHash = mix(mix(mix(pictureHash, r), g), b);
          const high = Math.max(r, g, b);
          const low = Math.min(r, g, b);
          const primary = (r > g * 2.5 && r > b * 2.5)
            || (g > r * 2.5 && g > b * 2.5)
            || (b > r * 2.5 && b > g * 2.5);
          // Count the opaque cores of the axes. Their antialiased edges deliberately blend with
          // the finished picture behind them, so an edge pixel is not invariant when that picture
          // changes even though the overlay itself never enters the effect pipeline.
          if (high < 220 || low > 80 || !primary) continue;
          const pixel = i / 4;
          axisHash = mix(mix(mix(mix(axisHash, pixel), r), g), b);
          axes++;
        }
        return { pictureHash: pictureHash >>> 0, axisHash: axisHash >>> 0, axes };
      })(${JSON.stringify(`data:image/png;base64,${shot.toString('base64')}`)})`);
    };
    const setPointCloudsVisible = (visible) => page.evaluate(`(() => {
      const k = globalThis.__kinect;
      k.scene.traverse((object) => { if (object.isPoints) object.visible = ${visible}; });
      k.renderProgramFrame(k.timeline.transport().programSec);
    })()`);
    await page.evaluate("__kinect.params.reset(__kinect.params.names('look'))");
    await settle();
    await setPointCloudsVisible(true);
    const neutralPicture = await gizmoPixels();
    await setPointCloudsVisible(false);
    const neutralAxes = await gizmoPixels();
    await page.evaluate(`(async () => {
      const doc = await (await fetch('/presets/blackwall')).json();
      __kinect.library.applyStoredPreset(doc);
      await __kinect.timeline.settled();
    })()`);
    await setPointCloudsVisible(true);
    const blackwallPicture = await gizmoPixels();
    await setPointCloudsVisible(false);
    const blackwallAxes = await gizmoPixels();
    console.log(`  movement handles under neutral and Blackwall: picture hashes `
      + `${neutralPicture.pictureHash}/${blackwallPicture.pictureHash}, axis pixels `
      + `${neutralAxes.axes}/${blackwallAxes.axes} at hashes `
      + `${neutralAxes.axisHash}/${blackwallAxes.axisHash}`);
    check(neutralPicture.pictureHash !== blackwallPicture.pictureHash,
      'Blackwall changes the picture behind the handles, so the equality below is not a look '
      + 'that failed to apply',
      `picture hashes ${neutralPicture.pictureHash} and ${blackwallPicture.pictureHash}`);
    check(neutralAxes.axes > 80,
      'the isolated handle image contains enough primary-colour pixels to compare',
      `${neutralAxes.axes} primary-colour pixels`);
    check(blackwallAxes.axes === neutralAxes.axes
      && blackwallAxes.axisHash === neutralAxes.axisHash,
    'the movement handles render over the finished look, so effects cannot recolour or bloom them',
    `${neutralAxes.axes}/${neutralAxes.axisHash} neutral, `
      + `${blackwallAxes.axes}/${blackwallAxes.axisHash} Blackwall`);
    await setPointCloudsVisible(true);
    await page.evaluate("__kinect.params.reset(__kinect.params.names('look'))");
    await settle();

    await page.locator('#tRotateClip').click();
    await settle();
    const turned = await page.evaluate('__kinect.editor.gizmo()');
    check(turned.mode === 'rotate' && turned.clip === 'gz2',
      'and pressing turn moves the handles to rotation rather than adding a second set',
      `${turned.mode} on ${turned.clip}`);
    const legend22b = await page.evaluate('__kinect.editor.shortcuts()');
    check(/g moves and turns/.test(legend22b),
      'and the ? legend names the key that does the same thing, so the keyboard is described '
      + 'wherever the buttons are',
      legend22b.slice(-90));
    await page.locator('#tMoveClip').click();
    await settle();

    // The rule this whole design is under: a pointer move arms a redraw and never starts one.
    // Thirty moves, because the shipped failure was 34 rebuilds for a single one.
    const MOVES = 30;
    const dragged = await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      const before = { rebuilds: k.timeline.counters.laneRebuilds, renders: k.timeline.counters.renders };
      // OrbitControls receives the shared pointerdown before TransformControls claims the axis.
      k.controls.dispatchEvent({ type: 'start' });
      k.editor.gizmoDrag(true);
      const orbitDuring = k.editor.orbitEnabled();
      for (let i = 1; i <= ${MOVES}; i++) k.editor.moveGizmo([i * 0.02, 0, 0]);
      // Two animation frames, which is where the write is allowed to happen.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const midDrag = { rebuilds: k.timeline.counters.laneRebuilds, renders: k.timeline.counters.renders };
      const pumped = k.params.get('transform').position[0];
      k.editor.gizmoDrag(false);
      k.controls.dispatchEvent({ type: 'end' });
      await k.timeline.settled();
      const after = { rebuilds: k.timeline.counters.laneRebuilds, renders: k.timeline.counters.renders };
      return {
        rebuilds: after.rebuilds - before.rebuilds,
        duringRebuilds: midDrag.rebuilds - before.rebuilds,
        renders: after.renders - before.renders,
        duringRenders: midDrag.renders - before.renders,
        orbitDuring,
        orbitAfter: k.editor.orbitEnabled(),
        pumped,
        group: k.timeline.clips().find((c) => c.id === 'gz2').placement.position[0],
        other: k.timeline.clips().find((c) => c.id !== 'gz2').placement.position[0],
      };
    })()`);
    console.log(`  ${MOVES} pointer moves through the handles: ${dragged.duringRebuilds} lane `
      + `rebuilds and ${dragged.duringRenders} renders while the pointer was down, `
      + `${dragged.rebuilds} and ${dragged.renders} over the whole gesture`);
    // First, that the drag did anything at all: a gizmo wired to nothing costs nothing either.
    check(near(dragged.pumped, MOVES * 0.02, 1e-6) && near(dragged.group, dragged.pumped, 1e-6),
      'the drag reaches the registry and the group both, so the counts below are of a gesture '
      + 'that did something',
      `registry ${dragged.pumped.toFixed(3)}, group ${dragged.group.toFixed(3)}`);
    check(dragged.other === 0,
      'and it reaches the clip the handles are on and no other',
      `the other clip is at ${dragged.other}`);
    check(dragged.duringRebuilds === 0,
      'and no pointer move rebuilt the lane stack: the drag arms a redraw and the animation loop '
      + 'is the only thing allowed to start one',
      `${dragged.duringRebuilds} rebuilds across ${MOVES} moves`);
    check(dragged.duringRenders > 0,
      'and the changed picture is rendered while the pointer is still down rather than waiting '
      + 'for release',
      `${dragged.duringRenders} renders before release`);
    check(dragged.rebuilds <= 2,
      'and the whole gesture costs one rebuild rather than one per move, which is the 34-for-one '
      + 'this program has already shipped once',
      `${dragged.rebuilds} rebuilds for ${MOVES} moves`);
    check(dragged.orbitDuring === false && dragged.orbitAfter === true,
      'the orbit stands down for the drag and comes back after it, because two controls cannot '
      + 'both have the pointer',
      `enabled ${dragged.orbitDuring} during, ${dragged.orbitAfter} after`);

    // The placement keyed from the control that exists for it, and read between the two keys.
    // Pressed rather than called: it is the only way to plant the first key on a placement track,
    // because a placement has no panel row and no keyframe control beside one.
    const keyed = await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      const t = k.timeline.transport();
      const clip = k.timeline.clips().find((c) => c.id === 'gz2');
      const press = async (sec, position) => {
        await t.seek(sec);
        await k.timeline.settled();
        if (position) k.params.set('transform', { position, quaternion: [0, 0, 0, 1] });
        document.getElementById('tKeyClip').click();
        await k.timeline.settled();
        return document.getElementById('tKeyClip').dataset.kf;
      };
      const kfAtFirst = await press(clip.start, [0, 0, 0]);
      const kfAtSecond = await press(clip.start + 2, [1, 0, 0]);
      const doc = k.library.serialiseProjectBody().clips.find((c) => c.id === 'gz2');
      // Seeked and read without pressing, which is the third state the control has to show.
      const at = async (sec) => {
        await t.seek(sec);
        await k.timeline.settled();
        return {
          x: k.timeline.clips().find((c) => c.id === 'gz2').placement.position[0],
          kf: document.getElementById('tKeyClip').dataset.kf,
        };
      };
      const half = await at(clip.start + 1);
      const beyond = await at(clip.start + 3);
      return {
        start: clip.start,
        kfAtFirst,
        kfAtSecond,
        kfBetween: half.kf,
        keys: (doc.tracks.transform ?? []).map((key) => key.t),
        between: half.x,
        past: beyond.x,
        lanes: k.keyframes.lanes().map((l) => l.owner),
      };
    })()`);
    console.log(`  keyed at ${keyed.keys.join('s and ')}s of the clip's own time, `
      + `with the clip at ${keyed.start}s: the group reads ${keyed.between.toFixed(3)} halfway `
      + `between them and ${keyed.past.toFixed(3)} past the last`);
    check(keyed.keys.length === 2 && Math.abs(keyed.keys[0]) < 1e-9
      && Math.abs(keyed.keys[1] - 2) < 1e-9,
    'the key control plants a placement key on the clip\'s own clock, so the first key of a clip '
    + 'placed away from the head of the edit is at zero rather than at where the clip sits',
    keyed.keys.join(', '));
    check(keyed.kfAtSecond === 'here',
      'and it says a key is under the playhead once one has been planted there',
      `${keyed.kfAtFirst} then ${keyed.kfAtSecond}`);
    check(keyed.kfBetween === 'some',
      'and says the track carries keys elsewhere when the playhead is between them',
      `${keyed.kfBetween}`);
    check(Math.abs(keyed.between - 0.5) < 1e-3,
      'and the group sits halfway between the two keys at the program second halfway between them',
      `${keyed.between.toFixed(4)} against 0.5`);
    check(Math.abs(keyed.past - 1) < 1e-9,
      'and holds the last key past the end of the track rather than extrapolating out of the room',
      `${keyed.past.toFixed(4)}`);
    check(keyed.lanes.includes('clip:gz2/transform'),
      'and the track draws a lane nested under the clip that holds it',
      keyed.lanes.join(', '));

    // The preset's two halves, and which of them is shared.
    const preset = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const body = {
        version: k.library.PROJECT_VERSION,
        values: { pointSize: 33.3, opacity: 0.44, bloom: 0.75, crush: 0.05 },
      };
      const before = k.library.serialiseProjectBody();
      const report = k.library.applyStoredPreset({ name: 'scope-probe', rev: null, body });
      const after = k.library.serialiseProjectBody();
      const at = (doc, id) => doc.clips.find((c) => c.id === id).params;
      return {
        report,
        selected: k.editor.clipSelection(),
        mineBefore: at(before, 'gz2').pointSize,
        mineAfter: at(after, 'gz2').pointSize,
        theirsBefore: at(before, before.clips[0].id).pointSize,
        theirsAfter: at(after, before.clips[0].id).pointSize,
        bloomBefore: before.look.params.bloom,
        bloomAfter: after.look.params.bloom,
      };
    })()`);
    console.log(`  a preset of two cloud values and two post values applied to `
      + `${preset.selected}: its point size ${preset.mineBefore} -> ${preset.mineAfter}, the `
      + `other clip's ${preset.theirsBefore} -> ${preset.theirsAfter}, `
      + `the project's bloom ${preset.bloomBefore} -> ${preset.bloomAfter}`);
    check(preset.mineBefore !== preset.theirsBefore,
      'the two clips held different point sizes going in, so the rows below can tell them apart',
      `${preset.mineBefore} against ${preset.theirsBefore}`);
    check(near(preset.mineAfter, 33.3, 1e-9),
      'a preset\'s cloud values land on the selected clip', `${preset.mineAfter}`);
    check(preset.theirsAfter === preset.theirsBefore,
      'and on no other clip, which is what makes a look the clip\'s own',
      `${preset.theirsBefore} -> ${preset.theirsAfter}`);
    check(near(preset.bloomAfter, 0.75, 1e-9) && preset.bloomBefore !== preset.bloomAfter,
      'while its post values land on the project, which every clip in the edit is seen through',
      `${preset.bloomBefore} -> ${preset.bloomAfter}`);
    check(preset.report.shared === 2,
      'and the apply says how many of them were the shared half, so the operator is told rather '
      + 'than left to find out',
      `${preset.report.shared} of ${preset.report.written} written`);
    // Framing belongs to the shot. Drive the crop and both preset choices through the controls a
    // person uses, then ask the file door and the save dialog for the same boundary.
    const choosePreset = async (name) => {
      await page.locator('#tPreset').click();
      await page.waitForFunction("document.getElementById('tPresetList').hidden === false");
      await page.locator(`#tPresetList .pickeroption[data-name=${JSON.stringify(name)}]`).click();
      await settle();
    };
    await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const body = k.library.serialiseProjectBody();
      const selected = k.editor.clipSelection();
      const clip = body.clips.find((candidate) => candidate.id === selected);
      clip.appliedPreset = null;
      delete clip.tracks.pointSize;
      k.library.restoreProject(body);
      k.editor.selectClipRow(selected);
      k.keyframes.setTracks(clip.tracks);
    })()`);
    await settle();
    await page.locator('#panelTabFraming').click();
    await page.locator('#left').evaluate((control) => {
      control.value = '-1.25';
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.evaluate("__kinect.params.set('pointSize', 19.5)");
    await settle();
    const framingBeforePreset = await page.evaluate(`(() => ({
      left: __kinect.params.get('left'),
      pointSize: __kinect.params.get('pointSize'),
    }))()`);
    await page.locator('#panelTabLook').click();
    await choosePreset('blackwall');
    const afterBlackwall = await page.evaluate(`(() => ({
      left: __kinect.params.get('left'),
      pointSize: __kinect.params.get('pointSize'),
    }))()`);
    check(afterBlackwall.left === framingBeforePreset.left
      && afterBlackwall.pointSize !== framingBeforePreset.pointSize,
    'choosing a look changes the look and leaves the crop exactly where it was framed',
    `left ${framingBeforePreset.left} -> ${afterBlackwall.left}, point size `
      + `${framingBeforePreset.pointSize} -> ${afterBlackwall.pointSize}`);
    await choosePreset('');
    const afterNone = await page.evaluate(`(() => ({
      left: __kinect.params.get('left'),
      pointSize: __kinect.params.get('pointSize'),
      pointSizeDefault: __kinect.params.spec('pointSize').default,
    }))()`);
    check(afterNone.left === framingBeforePreset.left
      && afterNone.pointSize === afterNone.pointSizeDefault,
    'choosing preset None resets the look and leaves the crop exactly where it was framed',
    `left ${framingBeforePreset.left} -> ${afterNone.left}, point size `
      + `${afterNone.pointSize} against default ${afterNone.pointSizeDefault}`);

    await page.locator('#tPresetSave').click();
    await page.waitForFunction("document.getElementById('presetPick').open === true");
    const framingOffered = await page.evaluate(`(() => {
      const framingNames = new Set([...document.querySelectorAll(
        '#panelBody [data-group="framing"] input[id]')]
        .map((el) => el.id)
        .filter((name) => __kinect.params.names().includes(name)));
      return {
        group: document.getElementById('ppg-framing') !== null,
        values: [...document.querySelectorAll('#ppGroups input[id^="pp-"]')]
          .map((el) => el.id.slice(3))
          .filter((name) => framingNames.has(name)),
      };
    })()`);
    check(framingOffered.group === false && framingOffered.values.length === 0,
      'the preset subset dialog offers no framing group or framing value to save',
      `group ${framingOffered.group}, values ${framingOffered.values.join(', ') || 'none'}`);
    await page.locator('#ppCancel').click();
    await page.waitForFunction("document.getElementById('presetPick').open === false");

    const framingFile = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const before = k.params.get('left');
      let message = null;
      try {
        k.library.applyStoredPreset({
          name: 'framing-is-not-a-look',
          rev: null,
          body: { version: k.library.PROJECT_VERSION, values: { left: -3.75 } },
        });
      } catch (error) {
        message = error.message;
      }
      const after = k.params.get('left');
      if (after !== before) k.params.set('left', before);
      return { before, after, message };
    })()`);
    check(/framing/.test(framingFile.message ?? '')
      && framingFile.after === framingFile.before,
    'a stored document that names framing is refused before it can move the crop',
    `${JSON.stringify(framingFile.message)} with left ${framingFile.before} -> ${framingFile.after}`);
    await page.locator('#panelTabFraming').click();
    await settle();

    // A preset request does not own the selection while the server answers. Hold each write,
    // move the visible row, and then let the real continuation finish.
    const presetRaceNonce = `ec-target-${process.pid}-${Date.now().toString(36)}`;
    const importTargetName = `${presetRaceNonce}-import`;
    const saveTargetName = `${presetRaceNonce}-save`;
    const importTargetPath = join(TMP, `${importTargetName}.braindance-preset.json`);
    const panelBeforePresetRace = await page.evaluate(
      'document.querySelector(".paneltab[aria-selected=true]")?.dataset.panelTab ?? null');
    const initiatingClip = 'gz2';
    const otherClip = two.clips.find((clip) => clip.id !== initiatingClip).id;
    const clickClip = async (id) => {
      const state = await read();
      const at = state.clips.findIndex((clip) => clip.id === id);
      if (at < 0) throw new Error(`the preset race could not find clip ${id}`);
      const point = await boxAt(at);
      await page.mouse.click(point.x, point.y);
      await settle();
    };
    const waitForRequest = async (count, label) => {
      const began = Date.now();
      while (count() !== 1) {
        if (Date.now() - began > 15000) throw new Error(`${label} never reached the server`);
        await new Promise((resolve) => { setTimeout(resolve, 20); });
      }
    };
    const removePreset = async (name) => {
      const probe = await fetch(`${URL_BASE}/presets/${encodeURIComponent(name)}`);
      if (!probe.ok) return;
      const res = await writePresetDoc(name, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      });
      check(res.ok, `and the target-race fixture ${name} was removed again`, `DELETE answered ${res.status}`);
    };
    let releaseImport = () => {};
    let releaseSave = () => {};
    let importRequests = 0;
    let saveRequests = 0;
    const holdImport = async (route) => {
      importRequests++;
      await new Promise((resolve) => { releaseImport = resolve; });
      await route.continue();
    };
    const holdSave = async (route) => {
      saveRequests++;
      await new Promise((resolve) => { releaseSave = resolve; });
      await route.continue();
    };
    writeFileSync(importTargetPath, `${JSON.stringify({
      version: PROJECT_VERSION,
      values: { pointSize: 46.7 },
    }, null, 2)}\n`);
    await page.route(`**/presets/${importTargetName}*`, holdImport);
    await page.route(`**/presets/${saveTargetName}*`, holdSave);
    try {
      await page.locator('.paneltab[data-panel-tab="look"]').click();
      await settle();
      await clickClip(initiatingClip);
      const beforeImport = await page.evaluate(({ targetId, otherId }) => {
        const body = __kinect.library.serialiseProjectBody();
        const byId = (id) => body.clips.find((clip) => clip.id === id);
        return {
          targetPointSize: byId(targetId).params.pointSize,
          otherPointSize: byId(otherId).params.pointSize,
          otherStamp: byId(otherId).appliedPreset ?? null,
        };
      }, { targetId: initiatingClip, otherId: otherClip });
      const [importChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.click('#tPresetImport'),
      ]);
      await importChooser.setFiles(importTargetPath);
      await waitForRequest(() => importRequests, 'the held preset import');
      await clickClip(otherClip);
      releaseImport();
      await page.waitForFunction((name) => !__kinect.library.presetGestureRunning()
        && document.getElementById('tNote').textContent.startsWith(`imported ${name}`),
      importTargetName, { timeout: 15000 });
      await settle();
      const afterImport = await page.evaluate(({ targetId, otherId }) => {
        const body = __kinect.library.serialiseProjectBody();
        const byId = (id) => body.clips.find((clip) => clip.id === id);
        return {
          selection: __kinect.editor.clipSelection(),
          targetPointSize: byId(targetId).params.pointSize,
          otherPointSize: byId(otherId).params.pointSize,
          picker: document.getElementById('tPreset').value,
          otherStamp: byId(otherId).appliedPreset ?? null,
        };
      }, { targetId: initiatingClip, otherId: otherClip });
      check(afterImport.selection === otherClip && near(afterImport.targetPointSize, 46.7, 1e-9)
        && afterImport.otherPointSize === beforeImport.otherPointSize,
      'an imported clip value lands on the clip that started the request when another row is selected before the PUT answers',
      `selection ${afterImport.selection}, target ${beforeImport.targetPointSize} -> ${afterImport.targetPointSize}, `
        + `other ${beforeImport.otherPointSize} -> ${afterImport.otherPointSize}`);
      check(afterImport.picker === (afterImport.otherStamp?.name ?? '')
        && JSON.stringify(afterImport.otherStamp) === JSON.stringify(beforeImport.otherStamp),
      'and the picker keeps naming the newly selected clip\'s provenance instead of claiming it wears the imported values',
      `picker ${JSON.stringify(afterImport.picker)}, other stamp ${JSON.stringify(afterImport.otherStamp)}`);

      await clickClip(initiatingClip);
      const beforeSave = await page.evaluate(({ targetId, otherId }) => {
        const body = __kinect.library.serialiseProjectBody();
        const byId = (id) => body.clips.find((clip) => clip.id === id);
        return {
          targetStamp: byId(targetId).appliedPreset ?? null,
          otherStamp: byId(otherId).appliedPreset ?? null,
        };
      }, { targetId: initiatingClip, otherId: otherClip });
      await page.focus('#tPresetSave');
      await page.click('#tPresetSave');
      await page.waitForFunction("document.getElementById('presetPick').open === true", null, { timeout: 10000 });
      await page.fill('#ppName', saveTargetName);
      await page.click('#ppGo');
      await waitForRequest(() => saveRequests, 'the held whole-look save');
      await clickClip(otherClip);
      releaseSave();
      await page.waitForFunction((name) => !__kinect.library.presetGestureRunning()
        && document.getElementById('tNote').textContent.startsWith(`saved ${name}`),
      saveTargetName, { timeout: 15000 });
      await settle();
      const afterSave = await page.evaluate(({ targetId, otherId }) => {
        const body = __kinect.library.serialiseProjectBody();
        const byId = (id) => body.clips.find((clip) => clip.id === id);
        return {
          selection: __kinect.editor.clipSelection(),
          targetStamp: byId(targetId).appliedPreset ?? null,
          otherStamp: byId(otherId).appliedPreset ?? null,
        };
      }, { targetId: initiatingClip, otherId: otherClip });
      check(afterSave.selection === otherClip && afterSave.targetStamp?.name === saveTargetName
        && JSON.stringify(afterSave.otherStamp) === JSON.stringify(beforeSave.otherStamp),
      'a whole-look save stamps the clip whose values were written when another row is selected before the PUT answers',
      `selection ${afterSave.selection}, target stamp ${JSON.stringify(beforeSave.targetStamp)} -> `
        + `${JSON.stringify(afterSave.targetStamp)}, other ${JSON.stringify(beforeSave.otherStamp)} -> `
        + JSON.stringify(afterSave.otherStamp));
    } finally {
      releaseImport();
      releaseSave();
      await page.unroute(`**/presets/${importTargetName}*`, holdImport);
      await page.unroute(`**/presets/${saveTargetName}*`, holdSave);
      await page.waitForFunction('!__kinect.library.presetGestureRunning()', null, { timeout: 15000 }).catch(() => {});
      await removePreset(importTargetName);
      await removePreset(saveTargetName);
      if (panelBeforePresetRace) {
        await page.locator(`.paneltab[data-panel-tab="${panelBeforePresetRace}"]`).click();
        await settle();
      }
    }

    // The other door, and the ruling's other half. Through `loadProject` rather than through
    // `restoreProject`: the restore door is what undo arrives by and it must keep the selection,
    // so driving that one would report the opposite of what this row claims.
    const PROBE = '__editor-check-selection__';
    const savedClipTiming = await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      const body = k.library.serialiseProjectBody();
      const clip = body.clips.find((candidate) => candidate.id === 'gz2');
      clip.start = 4.25;
      clip.length = 5.75;
      clip.speed = 1.6;
      clip.sourceStart = 2.25;
      k.library.restoreProject(body);
      k.editor.selectClipRow(clip.id);
      const staged = k.timeline.clips().find((candidate) => candidate.id === clip.id);
      return { start: staged.start, trim: staged.trim, length: staged.length,
        speed: staged.speed, sourceStart: staged.sourceStart };
    })()`);
    await settle();
    await page.evaluate(`(async () => {
      const k = globalThis.__kinect;
      const res = await __ecWrite('/projects/${PROBE}', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(k.library.serialiseProjectBody()),
      });
      if (!res.ok) throw new Error('the probe project could not be saved: ' + res.status);
      await k.library.loadProject('${PROBE}');
      await k.timeline.settled();
    })()`);
    await settle();
    const loaded = await page.evaluate(`(() => ({
      selection: __kinect.editor.clipSelection(),
      clips: __kinect.timeline.clips().length,
      greyed: __kinect.editor.scopeOff(),
      clipControl: document.getElementById('pointSize').disabled,
      timing: (() => {
        const clip = __kinect.timeline.clips().find((candidate) => candidate.id === 'gz2');
        return { start: clip.start, trim: clip.trim, length: clip.length,
          speed: clip.speed, sourceStart: clip.sourceStart };
      })(),
    }))()`);
    console.log(`  a project of ${loaded.clips} clips loaded by name: `
      + `selection ${loaded.selection}, ${loaded.greyed} greyed rows`);
    check(loaded.clips === 2,
      'the probe project came back with both its clips, so the row below is about a load that '
      + 'happened rather than one that failed',
      `${loaded.clips} clips`);
    check(['start', 'trim', 'length', 'speed', 'sourceStart']
      .every((name) => near(loaded.timing[name], savedClipTiming[name], 1e-9)),
    'and a named save and load preserves the clip placement, trim, speed and source in-point',
    `${JSON.stringify(savedClipTiming)} -> ${JSON.stringify(loaded.timing)}`);
    check(loaded.selection === null && loaded.greyed > 20 && loaded.clipControl === true,
      'and loading a project selects no clip, because a document does not record which clip was '
      + 'being worked on and picking one would be a guess - which is the case the clip/project '
      + 'split is worth showing, since it is the one with a choice in it',
      `selection ${loaded.selection}, ${loaded.greyed} greyed`);
    // The content type goes on the DELETE: the document routes answer 415 without one, and a
    // swallowed refusal leaves the probe in `projects/` for the next reader to wonder about.
    await writeProjectDoc(PROBE, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
    await writeProjectDoc(TRIM_PROBE, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    }).catch(() => {});
    await page.evaluate(`__kinect.editor.selectClipRow('gz2')`);
    await settle();

    // Leave both gesture-only surfaces live before the strip is cleared. A proof that starts
    // with either one already off cannot distinguish deselection from the state it inherited.
    if (!await page.evaluate('__kinect.cropBoxShown()')) await page.locator('#cropBox').click();
    await page.evaluate(`(() => {
      for (const [name, value] of [
        ['left', -0.8], ['right', 0.8], ['bottom', -0.8], ['top', 0.8], ['far', 3],
      ]) __kinect.params.set(name, value);
    })()`);
    const hiddenMarks = [{ id: 'hidden-gesture-probe', sourceMs: 1000, label: 'probe', at: 1 }];
    await page.evaluate((marks) => __kinect.editor.setMarks(marks), hiddenMarks);
    await settle();
    await page.locator('#tMarks .tmk').click();
    await page.evaluate('__kinect.timeline.transport().seek(0)');
    await page.evaluate('__kinect.timeline.settled()');
    const liveClipGestures = await page.evaluate(`(() => {
      const canvas = __kinect.renderer.domElement.getBoundingClientRect();
      const handle = __kinect.cropHandles(false)[0] ?? null;
      return {
        handle: handle ? { ...handle, x: canvas.x + handle.x, y: canvas.y + handle.y } : null,
        ticks: __kinect.library.markTicks().length,
        shown: __kinect.cropBoxShown(),
      };
    })()`);
    check(liveClipGestures.shown && liveClipGestures.handle !== null && liveClipGestures.ticks === 1,
      'the selected clip has a crop handle and a mark tick before the deselection tests them',
      `box ${liveClipGestures.shown}, handle ${liveClipGestures.handle?.param ?? 'none'}, `
        + `${liveClipGestures.ticks} mark tick(s)`);

    // The gesture that reaches the greyed state, and the state itself. Pressed on the empty part
    // of a clip's own lane - the clip starts at 4s, so the head of its lane belongs to no clip.
    const emptyLane = await page.evaluate(`(() => {
      const lane = document.querySelector('.tlane[data-owner="clip:gz2"]');
      const r = lane.getBoundingClientRect();
      const box = lane.querySelector('.tclip').getBoundingClientRect();
      return { x: r.x + Math.max(4, (box.x - r.x) / 2), y: r.y + r.height / 2, gap: box.x - r.x };
    })()`);
    const greyedBefore = await page.evaluate('__kinect.editor.scopeOff()');
    await page.mouse.click(emptyLane.x, emptyLane.y);
    await settle();
    const off = await page.evaluate(`(() => ({
      selection: __kinect.editor.clipSelection(),
      greyed: __kinect.editor.scopeOff(),
      clipControl: document.getElementById('pointSize').disabled,
      projectControl: document.getElementById('bloom').disabled,
      handles: __kinect.editor.gizmo().shown,
      cropShown: __kinect.cropBoxShown(),
      cropHandles: __kinect.cropHandles(false).length,
      cropOutside: __kinect.cropOutside(),
      markTicks: __kinect.library.markTicks().length,
      miniMarks: document.querySelectorAll('#tMiniMarks span').length,
      time: __kinect.timeline.transport().programSec,
      gizmoMode: __kinect.editor.gizmo().mode,
      sourceClock: document.getElementById('tSource').textContent,
      addClip: (() => {
        const button = document.getElementById('tAddClip');
        return { disabled: button.disabled, text: button.textContent,
          parent: button.parentElement?.className ?? '' };
      })(),
      clipCommands: ['tDeleteClip', 'tMoveClip', 'tRotateClip', 'tKeyClip',
        'tRate', 'tPreset', 'tPresetSave', 'tPresetExport', 'tPresetImport',
        'tMark', 'camSensor', 'cropFit'].map((id) => [id, document.getElementById(id)?.disabled]),
      rateInClipOptions: document.getElementById('tRate').closest('#tClipOptions') !== null,
      clipOptionsDisplay: getComputedStyle(document.getElementById('tClipOptions')).display,
    }))()`);
    console.log(`  a press ${emptyLane.gap.toFixed(0)}px left of the clip's box: `
      + `selection ${off.selection}, ${greyedBefore} greyed rows before it and ${off.greyed} after`);
    check(off.selection === null,
      'a press on the empty part of the stack takes the strip off every clip', `${off.selection}`);
    check(off.sourceClock === '\u2014',
      'and the source clock is blank because no selected clip says which take time it should show',
      `source ${JSON.stringify(off.sourceClock)}`);
    check(greyedBefore === 0 && off.greyed > 20 && off.clipControl === true,
      'and the panel greys its clip half rather than hiding it, so the split between what a clip '
      + 'holds and what the project holds stays on screen',
      `${off.greyed} rows greyed, pointSize disabled ${off.clipControl}`);
    check(off.projectControl === false,
      'while the project half stays live, because it belongs to no clip and there is nothing to '
      + 'have deselected',
      `bloom disabled ${off.projectControl}`);
    check(off.handles === false,
      'and the handles go with it, because there is no clip for them to be on',
      `shown ${off.handles}`);
    check(off.cropShown === false && off.cropHandles === 0 && off.cropOutside === 0
      && off.markTicks === 0 && off.miniMarks === 0,
    'and the crop box, its faint pass and the mark ticks leave with the clip, so none remains as '
      + 'a gesture onto the hidden selection',
    `crop shown ${off.cropShown}, ${off.cropHandles} handles, faint ${off.cropOutside}, `
      + `${off.markTicks} ruler and ${off.miniMarks} overview mark ticks`);
    check(off.addClip.disabled === false && off.addClip.text === '+'
      && off.addClip.parent.includes('clip-add-row'),
    'while the full-width plus below the clip rows stays enabled, because adding belongs to the '
      + 'edit and not to one selected clip',
    `text ${JSON.stringify(off.addClip.text)}, disabled ${off.addClip.disabled}, `
      + `parent ${JSON.stringify(off.addClip.parent)}`);
    check(off.clipCommands.every(([, disabled]) => disabled === true),
      'and every command that does need a clip is disabled until a row is selected',
      off.clipCommands.map(([id, disabled]) => `${id}:${disabled}`).join(' '));
    check(off.rateInClipOptions && off.clipOptionsDisplay === 'none',
      'and the speed slider lives in the clip chip, which leaves the strip with the selection',
      `in clip chip ${off.rateInClipOptions}, chip display ${off.clipOptionsDisplay}`);

    // Press where the crop handle was, rather than only reading that its list is empty. This is
    // the stale visible furniture from the reported fault, driven through the real pointer path.
    if (liveClipGestures.handle) {
      const h = liveClipGestures.handle;
      const before = await page.evaluate(`__kinect.params.get(${JSON.stringify(h.param)})`);
      const length = Math.hypot(h.sx, h.sy);
      await page.mouse.move(h.x, h.y);
      await page.mouse.down();
      await page.mouse.move(h.x + h.sx / length * 36, h.y + h.sy / length * 36);
      await page.mouse.up();
      await settle();
      const after = await page.evaluate(`__kinect.params.get(${JSON.stringify(h.param)})`);
      check(after === before,
        'dragging where the old crop handle was cannot change the hidden clip',
        `${h.param} ${before} -> ${after}`);
    }

    let hiddenMarkWrites = 0;
    await page.route('**/capture/*/marks', async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return; }
      hiddenMarkWrites++;
      const body = route.request().postDataJSON();
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ marks: [...hiddenMarks, ...(body.marks ?? [])] }),
      });
    });
    await page.keyboard.press('Delete');
    await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const afterHiddenDelete = await page.evaluate('__kinect.library.marks().map((mark) => mark.id)');
    const writesAfterDelete = hiddenMarkWrites;
    check(writesAfterDelete === 0
      && afterHiddenDelete.length === 1 && afterHiddenDelete[0] === hiddenMarks[0].id,
    'Delete cannot write the mark that was selected before its clip was deselected',
    `${writesAfterDelete} POST(s), marks ${afterHiddenDelete.join(' ')}`);

    await page.keyboard.press('m');
    await page.evaluate('new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const hiddenMarkResult = await page.evaluate(`(() => ({
      ids: __kinect.library.marks().map((mark) => mark.id),
      note: document.getElementById('tNote').textContent,
    }))()`);
    await page.unroute('**/capture/*/marks');
    check(hiddenMarkWrites === writesAfterDelete
      && JSON.stringify(hiddenMarkResult.ids) === JSON.stringify(afterHiddenDelete)
      && /select a clip before adding a mark/.test(hiddenMarkResult.note),
    'and M refuses before a network write when no clip row says which take it would mark',
    `${hiddenMarkWrites - writesAfterDelete} POST(s) from M, marks ${hiddenMarkResult.ids.join(' ')}, note "${hiddenMarkResult.note}"`);

    await page.keyboard.press('g');
    await page.keyboard.press(']');
    await settle();
    const hiddenNavigation = await page.evaluate(`(() => ({
      time: __kinect.timeline.transport().programSec,
      gizmoMode: __kinect.editor.gizmo().mode,
      note: document.getElementById('tNote').textContent,
    }))()`);
    check(hiddenNavigation.time === off.time && hiddenNavigation.gizmoMode === off.gizmoMode
      && /select a clip before moving to a mark/.test(hiddenNavigation.note),
    'and the mark-jump and clip-handle keys refuse rather than acting through the hidden clip',
    `time ${off.time} -> ${hiddenNavigation.time}, gizmo ${off.gizmoMode} -> `
      + `${hiddenNavigation.gizmoMode}, note "${hiddenNavigation.note}"`);

    const addWithoutSelectionRestore = await page.evaluate(`(() => {
      const k = __kinect;
      const body = k.library.serialiseProjectBody();
      body.clips[0].params.pointSize = 17.3;
      body.clips.find((clip) => clip.id === 'gz2').params.pointSize = 31.5;
      k.library.restoreProject(body);
      return { body, count: body.clips.length, first: body.clips[0].id };
    })()`);
    await settle();
    if (off.addClip.disabled === false) {
      await page.locator('#tAddClip').click();
      await page.waitForSelector(`#takePicker .tp-tile[data-take="${pickId}"]`, { timeout: 15000 });
      await page.locator(`#takePicker .tp-tile[data-take="${pickId}"] .tp-meta`).click();
      await page.locator('#takePicker .tp-act.go').click();
      await page.waitForFunction(
        (count) => __kinect.timeline.clips().length === count + 1,
        addWithoutSelectionRestore.count,
        { timeout: 25000 },
      );
      await settle();
      const addedWithoutSelection = await page.evaluate((first) => {
        const body = __kinect.library.serialiseProjectBody();
        const selected = __kinect.editor.clipSelection();
        return {
          count: body.clips.length,
          selected,
          pointSize: body.clips.find((clip) => clip.id === selected)?.params.pointSize ?? null,
          firstPointSize: body.clips.find((clip) => clip.id === first)?.params.pointSize ?? null,
          hiddenPointSize: body.clips.find((clip) => clip.id === 'gz2')?.params.pointSize ?? null,
        };
      }, addWithoutSelectionRestore.first);
      check(addedWithoutSelection.count === addWithoutSelectionRestore.count + 1
        && addedWithoutSelection.selected !== null,
      'the plus opens the picker with no clip selected and the chosen take lands as a selected clip',
      `${addWithoutSelectionRestore.count} -> ${addedWithoutSelection.count} clips, `
        + `selection ${addedWithoutSelection.selected}`);
      check(addedWithoutSelection.firstPointSize === 17.3
        && addedWithoutSelection.hiddenPointSize === 31.5
        && addedWithoutSelection.pointSize === addedWithoutSelection.firstPointSize,
      'and with no selection the new clip copies the first clip rather than the hidden last selection',
      `new ${addedWithoutSelection.pointSize}, first ${addedWithoutSelection.firstPointSize}, `
        + `hidden ${addedWithoutSelection.hiddenPointSize}`);
    }
    await page.evaluate((body) => {
      __kinect.library.restoreProject(body);
      __kinect.editor.deselectClipRow();
      __kinect.keyframes.undo.begin();
    }, addWithoutSelectionRestore.body);
    await settle();

    await page.evaluate(`__kinect.editor.selectClipRow('gz2')`);
    await settle();
    check(await page.evaluate('__kinect.editor.scopeOff()') === 0,
      'and selecting a clip again brings the whole panel back',
      `${await page.evaluate('__kinect.editor.scopeOff()')} rows still greyed`);
    const chipBack = await page.evaluate(
      `getComputedStyle(document.getElementById('tClipOptions')).display`);
    check(chipBack !== 'none',
      'and the clip chip is back once a row is selected again',
      `chip display ${chipBack}`);
    check(await page.evaluate('__kinect.cropBoxShown()') === true,
      'and the crop box can return once a clip is selected again');
    await page.locator('#cropBox').click();
    await page.evaluate('__kinect.editor.setMarks([])');
    await page.evaluate("__kinect.params.reset(['left', 'right', 'bottom', 'top', 'near', 'far'])");

    // Put the page back on one clip with no handles up, so the sections after this one see what
    // they expect.
    await page.evaluate(`(() => {
      const k = globalThis.__kinect;
      k.editor.setGizmoMode(null);
      const body = k.library.serialiseProjectBody();
      body.clips = [body.clips[0]];
      k.library.restoreProject(body);
    })()`);
    await settle();
  }

  console.log('\n[23] pinning the drive drops what the loop was going to serve');

  // The third state that strands an armed position, and the only one `pumpParkedDraft` cannot
  // notice on its own: `drive.pin` calls `setAnimationLoop(null)`, so that function stops being
  // called and no condition written inside it ever runs again.
  {
    const stage = await page.evaluate(`(() => {
      const r = document.getElementById('stage').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await page.evaluate('__kinect.timeline.transport().pause()');
    await page.evaluate('__kinect.timeline.transport().seek(4.0)');
    await settle();
    await page.mouse.move(stage.x, stage.y);
    await page.mouse.down();
    await page.mouse.move(stage.x + 50, stage.y + 25);
    await page.mouse.up();
    // The smallest payload the pinned drive will accept: two frames, because `StampedPairSource`
    // refuses one - it interpolates between a pair.
    await page.evaluate(`__kinect.drive.pin((() => {
      const b = new ArrayBuffer(36);
      const v = new DataView(b);
      for (let k = 0; k < 2; k++) {
        const off = k * 18;
        v.setUint32(off, 2, true);
        v.setUint32(off + 4, 0, true);
        v.setBigUint64(off + 8, BigInt(k * 33), true);
      }
      return b;
    })())`);
    let settledAfterPin = true;
    let pinWhy = '';
    try {
      await settle();
    } catch (err) {
      settledAfterPin = false;
      pinWhy = err.message.split('\n')[0];
    }
    check(settledAfterPin,
      'a drag the pinned drive interrupts leaves nothing armed behind it either', pinWhy);
  }

} catch (err) {
  crashed = err;
} finally {
  await close().catch(() => {});
}

// --------------------------------------------------------------------- the verdict

if (crashed) {
  console.log(`\n[editor] DID NOT RUN - ${crashed.message}`);
  console.log(`[editor] ${checks} assertions ran, ${failures} failed before the crash`);
  if (fired.length) console.log(`[editor] rows that had already fired: ${fired.join('; ')}`);
  process.exit(2);
}
if (untested) {
  console.log(`\n[editor] UNTESTED - ${untested}`);
  console.log(`[editor] ${checks} assertions ran, ${failures} failed`);
  if (fired.length) console.log(`[editor] rows that fired: ${fired.join('; ')}`);
  if (MUTATE) console.log(`[editor] ${MUTATE} is neither caught nor missed here - the run never reached every row that answers it`);
  process.exit(2);
}

console.log(`\n[editor] ${checks} assertions, ${failures} failed`);
if (NO_RENDER) console.log('[editor] --no-render: the real export and the saved copy were not driven');

// The declared standing reds, split off the fired set so the verdict below is about this run's
// mutation rather than about rows that are red either way.
const standingFired = fired.filter((label) => STANDING_RED.has(label));
const newlyFired = fired.filter((label) => !STANDING_RED.has(label));
const standingGreen = [...STANDING_RED.keys()].filter((label) => !fired.includes(label));
for (const label of standingGreen) {
  console.log(`[editor] declared standing red is GREEN on this run: "${label}"`);
  console.log(`           declared because ${STANDING_RED.get(label)} - if it stays green here, `
    + 'take the entry out rather than leaving a row nothing is standing for');
}

if (MUTATE) {
  const mustFail = MUTATIONS[MUTATE]?.mustFail;
  if (MUTATIONS[MUTATE]?.fails) console.log(`[editor] it should redden: ${MUTATIONS[MUTATE].fails}`);
  if (standingFired.length) {
    console.log(`[editor] ${standingFired.length} of those ${failures} are red on this tree either way, `
      + 'so they are not this mutation being caught:');
    for (const label of standingFired) console.log(`           ${label}`);
  }
  if (mustFail && !fired.includes(mustFail)) {
    console.log(`[editor] NOT CAUGHT - ${MUTATE} left its required row green:`);
    console.log(`           ${mustFail}`);
    if (newlyFired.length) {
      console.log(`[editor] ${newlyFired.length} other assertions fired, but none can stand in for that row:`);
      for (const label of newlyFired) console.log(`           ${label}`);
    }
    process.exit(1);
  }
  if (newlyFired.length === 0) {
    console.log(`[editor] NOT CAUGHT - ${MUTATE} reddened nothing this tree was not already red on, `
      + 'so nothing here tests it');
    process.exit(1);
  }
  console.log(`[editor] caught ${MUTATE}, as required (${newlyFired.length} assertions fired beyond the standing set)`);
  if (mustFail) console.log(`[editor] its required row fired: ${mustFail}`);
  for (const label of newlyFired) console.log(`           ${label}`);
  process.exit(1);
}
if (failures) { console.log('[editor] FAIL'); process.exit(1); }
console.log('[editor] PASS');
process.exit(0);
