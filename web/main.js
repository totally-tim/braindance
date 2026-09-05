import * as THREE from 'three';
import {
  CLIP_CEILING, DEPTH_H, DEPTH_W, POINTS, PROJECT_VERSION, VALID_ID, copyName, documentNameRefusal,
  effectIdsIn, effectOf, nextUntitledName, presetCarriesLookName, snapScalar,
  versionRefusal, captureFormatRefusal, requiresEntryRefusal, requiresListRefusal,
} from './format.js';
import { pollRecordState } from './record-poll.js';
import { pickTakes } from './take-picker.js';
// The renderer, imported first: its body appends the canvas, so import order is boot order.
import {
  renderer, scene, freeCamera, programCamera, viewCamera, controls, WORLD_UP,
  DEFAULT_POSE, onNav, setNavigationUp, useViewCamera,
} from './scene.js';
import {
  EASE_OUT_LINEAR, EASE_IN_LINEAR, SEGMENT_POINT_CEILING, copyHandle, easeAt, elevate, keyBefore,
  HOLD_ENDS, scalarAt, stepAt, hermite, tangentAt,
  handleRefusal, foldRefusal, foldFreeX,
} from './curve.js';
import { tiltQuaternion } from './world-tilt.js';
import {
  isFlyKey, flyDirection, flyStep, lookOffset,
} from './fly.js';
import { verticalFovForFocalLength, focalLengthForVerticalFov } from './lens.js';
import {
  EXPORT_SIZES, DEFAULT_EXPORT_SIZE, reduceAspect, exportAspects, sizesForAspect,
} from './export-sizes.js';
import {
  INSET, TOP_CENTRE, PLAN_STRIDE, FRUSTUM_LEN, planScale, planPoint, planWorld, projectThrough,
} from './plan-geometry.js';
import { pickDepth, sensorPoint } from './depth-pick.js';
import { ZOOM_PER_NOTCH, rulerTickSeconds, tickLabel, makeViewWindow } from './view-window.js';
import { clipIn, clipOut, clipBoundOrThrow, writeClipRange } from './clip-range.js';
import {
  RATE_MIN, RATE_MAX, clipAffordedSec, clipProgramSecAt, clipSourceSecAt, frameLoadByTake,
  framesBackFor, headFramesFor, headTrim, integerMidpoint, rescaleClipKeys, snapshotClipKeys,
  usableClipRate,
} from './clip-plan.js';
import {
  EFFECT_BIND_TRANSFORMS, EFFECT_GATED_TABLES, EFFECT_BOUNDED_TABLES, effectBindUniformType,
  tableFromPackages, withEffectGroups,
} from './effect-manifests.js';
import { bloomChainSize } from './bloom-pass.js';
import {
  depthCurr, colorPrev, bindDepth, bindColor, resetColorSource, plantColor, boundColorImages,
} from './gpu-textures.js';
import {
  statePrev, stateNext, stepSurfaceMemory, refuseAgeCeiling,
} from './surface-memory.js';
import {
  composer, renderPass, afterimage, mosh, bloom, grade, buildPostChain, setGradeProgram,
  setMoshProgram,
} from './post-chain.js';
import {
  geometry, uniforms, material, cloud, level, levelAngles, transform, setAdditive,
  setCloudProgram, CLIP_NEAR_DEFAULT, CLIP_FAR_DEFAULT, CROP_LIMIT, cropReach, croppedOut,
} from './point-cloud.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createCloudInstance, disposeCloudInstance, selectCloud } from './cloud-instance.js';
import { cloudSpine } from './cloud-shader.js';
import { gradeSpine } from './grade-shader.js';
import { moshSpine } from './mosh-shader.js';
import { moshFramesBack, moshRefreshes } from './mosh-pass.js';
import { assembleShaders } from './shader-assembly.js';
import { createPreviews } from './previews.js';

const revSignature = (effects) => effects.map((e) => `${e.id} ${e.rev}`).join('\n');

/** A read that met the store mid-change, as against a fetch that failed. */
const tornRead = (why) => Object.assign(new Error(why), { tornRead: true });

/**
 * A rebuild that failed because this build refuses the set, not because it could not read it.
 */
const effectRefusal = (why) => Object.assign(new Error(why), { effectRefusal: true });

/** A rebuild that failed because a shader program would not link. */
const shaderLinkFailure = (why, log) => Object.assign(new Error(why), {
  shaderLinkFailure: true,
  linkLog: log,
});

/** `GET /effects`, with the answer held to the shape every reader of it assumes. */
async function listEffects() {
  const res = await fetch('/effects');
  if (!res.ok) throw new Error(`GET /effects answered ${res.status} - the registry cannot assemble without its packages`);
  const body = await res.json();
  if (!body || !Array.isArray(body.effects) || !Number.isFinite(body.generation)) {
    throw effectRefusal('GET /effects answered a body that is not a list of installed packages and a generation - '
      + 'this page reads both of those there, and something else at that address is not a store this build can converge on');
  }
  for (const entry of body.effects) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.rev !== 'string') {
      throw effectRefusal(`GET /effects listed the entry ${JSON.stringify(entry)} - every entry is an id and the `
        + 'revision of the package behind it, and the comparison that decides whether this page is up to date is over exactly those two');
    }
  }
  return { effects: body.effects, generation: body.generation };
}

// Reads the packages a listing names. Boot and the post-install rebuild share it.
async function readEffectPackages(effects) {
  return Promise.all(effects.map(async ({ id, rev }) => {
    const res = await fetch(`/effects/${encodeURIComponent(id)}`);
    if (!res.ok) throw new Error(`GET /effects/${id} answered ${res.status} - the registry cannot assemble without its packages`);
    const pkg = await res.json();
    // The package has to be the one the list named, or the read met an install mid-flight.
    if (pkg?.rev !== rev) {
      throw tornRead(`effect ${id} was listed at revision ${rev} and answered for at ${pkg?.rev} - `
        + 'the store changed between the list this read opened with and the package it then asked for');
    }
    if (!pkg.manifest || typeof pkg.manifest !== 'object' || Array.isArray(pkg.manifest)) {
      throw effectRefusal(`GET /effects/${id} answered with no manifest object - a package is a manifest and `
        + 'its chunks, and this page assembles both shader programs out of what the manifest names');
    }
    if (pkg.manifest.chunks !== undefined && !Array.isArray(pkg.manifest.chunks)) {
      throw effectRefusal(`effect ${id} was served with its chunks as ${JSON.stringify(pkg.manifest.chunks)} - `
        + 'a manifest\'s chunks are the list this page walks to fetch the text it splices, and a package '
        + 'that has none of them leaves the key out rather than putting something else there');
    }
    for (const c of pkg.manifest.chunks ?? []) {
      if (!c || typeof c.file !== 'string') {
        throw effectRefusal(`effect ${id} declares the chunk entry ${JSON.stringify(c)}, which names no file - `
          + 'the file name is what the next request is built out of, so an entry without one asks this page for a URL nobody wrote');
      }
    }
    // A manifest may point two joints at one file, so the same bytes are fetched once.
    const names = [...new Set((pkg.manifest.chunks ?? []).map((c) => c.file))];
    const texts = await Promise.all(names.map(async (name) => {
      const chunk = await fetch(`/effects/${encodeURIComponent(id)}/file/${encodeURIComponent(name)}`);
      if (!chunk.ok) throw new Error(`GET /effects/${id}/file/${name} answered ${chunk.status} - the cloud's shaders cannot be assembled without it`);
      return chunk.text();
    }));
    pkg.chunks = Object.fromEntries(names.map((name, i) => [name, texts[i]]));
    return pkg;
  }));
}

/** Every installed package as one moment, retried when the listing changes underneath it. */
async function fetchEffectPackages() {
  let disagreement = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const opened = await listEffects();
    let packages;
    try {
      packages = await readEffectPackages(opened.effects);
    } catch (err) {
      if (!err.tornRead) throw err;
      disagreement = err.message;
      continue;
    }
    const closed = await listEffects();
    if (closed.generation === opened.generation && revSignature(closed.effects) === revSignature(opened.effects)) return packages;
    disagreement = `the store was at generation ${opened.generation} when this read opened and ${closed.generation} when it closed`;
  }
  throw new Error('the installed effects moved while this page was reading them, twice - a set read across '
    + 'an install is one package from before it beside another from after, which assembles into a program '
    + `nobody wrote, so this page keeps the set it has and asks again (${disagreement})`);
}

// `let`, because `PUT` and `DELETE /effects/:id` rebuild the set in place.
let effectPackages = await fetchEffectPackages();

// Every program this page compiles, in one call, so a refusal covers every spine.
const SPINES = { cloud: cloudSpine, grade: gradeSpine, mosh: moshSpine };
let shaderPrograms = assembleShaders(SPINES, effectPackages);

// Which of the two surfaces this page is, decided by the path.
const EDITING = location.pathname === '/edit';
const PREVIEW_RENDERER = EDITING && window.parent !== window
  && new URLSearchParams(location.search).get('preview-renderer') === '1';
let previews = null;
let previewBootError = null;
const previewBrowserBuild = EDITING
  ? await (navigator.userAgentData?.getHighEntropyValues(['fullVersionList', 'platformVersion']).catch(() => null) ?? null)
  : null;

/**
 * True when OBS has opened this page as a browser source: no controls and no take of its own.
 */
const PROGRAM_OUT = location.pathname === '/program';

// The project this page has open, and the revision the store last answered about it with. Both
// null on a page opened as `/edit?take=`, which holds no document at all: it has no file to write
// into, and that is the rule the hidden working document used to carry by existing.
let openedProjectName = null;
let openedProjectRev = null;
// When this tab's last write landed, and whether the store has refused one as somebody else's.
let lastSavedAt = null;
let projectDiverged = false;

const statusEl = document.getElementById('status');
const appStatusEl = document.getElementById('appStatus');
// Read here because `resize` runs at boot and needs the strip's height.
const timelineEl = document.getElementById('timeline');

// The cloud the first clip below draws with. Made here rather than beside the clip, because the
// registry, the panel and the post chain are all built out of the uniform table it selects.
const bootCloud = createCloudInstance(shaderPrograms.cloud);
selectCloud(bootCloud);

// The clips this program draws, in project order, and the one the panel and the render core's
// bindings name. Declared here and filled where `Clip` is, because the registry above them writes
// a clip-scope value through both and would otherwise read them out of their own dead zone.
const clips = [];
let selectedClip = null;
let documentGeneration = 0;
let pendingClipAdds = 0;

// The clip the strip has selected, and null once the operator has clicked away from every one of
// them. Session state and deliberately not in the document. Declared here rather than beside the
// strip because the panel greys its clip half off this, and the panel is generated long before
// the strip exists.
let clipRow = null;

/** Whether a gesture has a clip on the strip to write. */
const clipGestureLive = () => !EDITING || clipRow !== null;

/** One look: the values it holds, the tracks that move them, and the pool it could not read. */
const createLook = () => ({
  values: new Map(),
  tracks: new Map(),
  parked: { params: {}, tracks: {} },
});

// The first clip's look, made here rather than beside the clip for the same reason as the array:
// the registry writes its defaults before there is a `Clip` to hold them, and these are the very
// tables that clip is then built around rather than a copy handed over later.
const bootLook = createLook();

// The look that belongs to the project rather than to any clip: the post chain's terms, the view
// state, and the camera. One of it however many clips draw into it.
const projectLook = createLook();

// The clip a look write belongs to while a walk over the clips is under way, and null outside
// one. Written only by `withClip`.
let evaluatingClip = null;

/**
 * Whose look a write or a read is about: the clip under evaluation, else the selected clip.
 *
 * An explicit indirection rather than a binding repointed for the walk. The selection is the
 * user's - the panel and the lanes are both views of it - so a walk that moved it would be
 * mutating what the operator is looking at in order to render a frame.
 */
const clipOfLook = () => evaluatingClip ?? selectedClip;
const lookOf = () => clipOfLook()?.look ?? bootLook;

/** Which of the two homes a parameter's value and track live in. */
const homeOf = (spec) => (spec.scope === 'clip' ? lookOf() : projectLook);

// The point-size ceiling this GPU will actually rasterise, which no parameter can raise. Kept as
// a number as well as written, because every later clip's cloud is brought up on it too.
const pointSizeCeiling = (() => {
  const gl = renderer.getContext();
  const pointRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE);
  // One rather than zero: the shader clamps to `[1, pointCeiling]` and would invert.
  return pointRange && pointRange[1] >= 1 ? pointRange[1] : uniforms.pointCeiling.value;
})();
uniforms.pointCeiling.value = pointSizeCeiling;

/**
 * Runs a write once per clip, against that clip's look tables and with the render core pointed at
 * its cloud, then puts the selection back.
 *
 * The three modules holding a view of the selected cloud are what let the rest of this file name
 * `uniforms` and `material` rather than reaching through an instance, and this is the price of
 * that: a write that has to land in every clip says so by going through here.
 *
 * Before the first `Clip` exists there is still one look - the tables that clip is then built
 * around - so this answers with it rather than with nothing, which is what stops the boot seeding
 * a registry no clip is holding.
 */
function forEachLook(write) {
  if (clips.length === 0) {
    write(bootLook);
    return;
  }
  for (const clip of clips) withClip(clip, () => write(clip.look));
}

// Composes the selected clip's two levelling angles into the rotation its cloud draws through.
//
// Both angles off that clip's own pair, because each of the two sliders writes one member and
// then recomposes both: read off a pair shared by the program, a clip's tilt would compose with
// whichever clip last wrote a roll.
function applyWorldTilt() {
  tiltQuaternion(levelAngles.tilt, levelAngles.roll, level.quaternion);
  // Levelling says this frame is the room's, so it takes the pole off the sensor view.
  setNavigationUp(WORLD_UP);
}

buildPostChain(shaderPrograms.grade, shaderPrograms.mosh);

let renderScale = 1;

// The drawing buffer an export has taken over, or null while the window owns it.
let outputSize = null;

/** The aspect the editor frames at, which is the aspect the export will be. */
let projectAspect = [16, 9];
const targetAspect = () => projectAspect[0] / projectAspect[1];

// The shape buttons in the Project settings dialog, null until boot builds them.
let aspectButtons = null;

/** The resolution each shape was last on. Session state, never saved. */
const sizeForShape = new Map();

// Where the letterboxed stage sits. Written by `resize`, read by the overlay.
const stageBox = { left: 0, top: 0 };

/** The rates the output can be, and the only list of them. */
const OUTPUT_RATES = [24, 30, 60, 120];

/** The default shape, taken off the default size so there is still one list. */
const defaultAspect = () => reduceAspect(...DEFAULT_EXPORT_SIZE.split('x').map(Number));

/** A `WIDTHxHEIGHT` string as the shape it is, or `[0, 0]` when it is not a size. */
function aspectOfSize(text) {
  const [w, h] = String(text).split('x').map(Number);
  return w > 0 && h > 0 ? reduceAspect(w, h) : [0, 0];
}

const sameAspect = (a, b) => a[0] === b[0] && a[1] === b[1];

/** The size a shape opens on, or null for a shape the table has nothing for. */
function openingSizeForAspect(aspect) {
  const sizes = sizesForAspect(aspect).map(([w, h]) => `${w}x${h}`);
  if (sizes.includes(DEFAULT_EXPORT_SIZE)) return DEFAULT_EXPORT_SIZE;
  return sizes[0] ?? null;
}

/** Rebuilds the resolution menu as every size the table holds for the project's shape. */
function buildResolutionMenu(select, keep) {
  if (!select) return select;
  const sizes = sizesForAspect(projectAspect).map(([w, h]) => `${w}x${h}`);
  select.replaceChildren();
  for (const value of sizes) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.appendChild(option);
  }
  if (keep && !sizes.includes(keep)) {
    const option = document.createElement('option');
    option.value = keep;
    option.textContent = `${keep} (from the project)`;
    select.appendChild(option);
  }
  return select;
}

/** The shape controls are another view over `EXPORT_SIZES`, never another list. */
function buildAspectSegments(container) {
  if (!container) return [];
  const buttons = exportAspects().map(({ ratio, aspect }) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.ratio = ratio;
    button.dataset.aspect = aspect.join('x');
    button.textContent = ratio.replace(' DCI', '');
    button.addEventListener('click', () => {
      if (setProjectAspect(aspect)) history.commit();
      paintAspectSelection(buttons);
    });
    container.appendChild(button);
    return button;
  });
  paintAspectSelection(buttons);
  return buttons;
}

/** Lights the shape button the document is on, or none when the table does not offer it. */
function paintAspectSelection(buttons) {
  for (const button of buttons) {
    const aspect = button.dataset.aspect.split('x').map(Number);
    button.setAttribute('aria-pressed', String(sameAspect(aspect, projectAspect)));
  }
}

/** Adopts a shape: the editor reframes to it and the project remembers it. */
function setProjectAspect(aspect, { fromDocument = false } = {}) {
  if (!fromDocument && refuseEdit('changing the shape')) return false;
  const [w, h] = reduceAspect(aspect[0], aspect[1]);
  if (!(w > 0 && h > 0)) return false;
  const leaving = projectAspect.join(':');
  projectAspect = [w, h];
  ensureActiveDeliverable();
  if (!sameAspect(aspectOfSize(activeDeliverable.outputSize), projectAspect)) {
    // The size this shape was last on beats the size it opens on, since a shape
    // change replaces one.
    sizeForShape.set(leaving, activeDeliverable.outputSize);
    const remembered = sizeForShape.get(projectAspect.join(':'));
    const fits = remembered && sameAspect(aspectOfSize(remembered), projectAspect);
    activeDeliverable.outputSize = (fits ? remembered : openingSizeForAspect(projectAspect))
      ?? activeDeliverable.outputSize;
  }
  buildResolutionMenu(ui?.exportSize, activeDeliverable.outputSize);
  if (ui?.exportSize) ui.exportSize.value = activeDeliverable.outputSize;
  if (aspectButtons) paintAspectSelection(aspectButtons);
  void fromDocument;
  paintDeliverable();
  resize();
  return true;
}

/** Adopts an output size. It reframes nothing: every size offered has the stage's shape. */
function setDeliverableSize(text) {
  const [w, h] = String(text).split('x').map(Number);
  if (!(w > 0 && h > 0)) return false;
  ensureActiveDeliverable();
  activeDeliverable.outputSize = `${w}x${h}`;
  if (ui?.exportSize && ui.exportSize.value !== `${w}x${h}`) {
    buildResolutionMenu(ui.exportSize, `${w}x${h}`);
    ui.exportSize.value = `${w}x${h}`;
  }
  paintDeliverable();
  return true;
}

// Which camera the viewport draws. Navigation is off under the program camera.
function setViewCamera(cam) {
  stopLookDrag();
  previews?.changed();
  useViewCamera(cam);
  if (gizmo) gizmo.camera = cam;
  renderPass.camera = cam;
  controls.enabled = cam === freeCamera;
}

let stageResizes = 0;

// The transport, or null until a take is open.
let timeline = null;

/** Who owns the transport's play state, so a resume queued before a newer pause is dropped. */
let transportGen = 0;
const takeTransport = () => {
  transportGen += 1;
  dropRateGesture();
  return transportGen;
};

/** Drops a speed gesture whose document has been replaced underneath it. */
const dropRateGesture = () => {
  if (rateGesture) rateGesture = null;
};

/** Stops the transport and claims it, so a resume queued by an older owner is dropped. */
const pauseTransport = () => {
  takeTransport();
  timeline.pause();
};

function resize() {
  stageResizes++;
  const wasBuffer = renderer.getDrawingBufferSize(new THREE.Vector2());
  const availW = innerWidth;
  const appBarHeight = document.getElementById('appBar')?.offsetHeight ?? 0;
  const dockHeight = document.body.classList.contains('panelcollapsed')
    ? document.getElementById('panelDock')?.offsetHeight ?? 0
    : 0;
  const availH = Math.max(1, innerHeight - timelineEl.offsetHeight - appBarHeight - dockHeight);
  const fitH = Math.max(1, Math.min(availH, Math.round(availW / targetAspect())));
  const fitW = Math.max(1, Math.round(fitH * targetAspect()));
  const width = outputSize ? outputSize.w : fitW;
  const height = outputSize ? outputSize.h : fitH;
  // An export's aspect comes from the output asked for, never from the window.
  for (const cam of [freeCamera, programCamera]) {
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }
  const ratio = outputSize ? 1 : Math.min(devicePixelRatio, 2) * renderScale;
  renderer.setPixelRatio(ratio);
  // The canvas keeps its CSS box while an export runs. Only the buffer becomes the output's.
  renderer.setSize(width, height, !outputSize);
  composer.setPixelRatio(ratio);
  composer.setSize(width, height);
  if (!outputSize) {
    stageBox.left = Math.round((availW - fitW) / 2);
    stageBox.top = appBarHeight + Math.round((availH - fitH) / 2);
    renderer.domElement.style.position = 'fixed';
    renderer.domElement.style.left = `${stageBox.left}px`;
    renderer.domElement.style.top = `${stageBox.top}px`;
  }
  const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
  // Sized off a fixed reference rather than off this buffer. `bloom-pass.js` carries why.
  const chain = bloomChainSize(buf.x, buf.y);
  bloom.setSize(chain.width, chain.height);
  grade.uniforms.resolution.value.set(buf.x, buf.y);
  mosh.uniforms.resolution.value.set(buf.x, buf.y);
  // Every clip's, because a screen-space term is expressed against 1080p in each of them.
  forEachLook(() => { uniforms.bufferHeight.value = buf.y; });
  // Everything above reallocates the drawing buffer and nothing above redraws into it.
  const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
  if (buffer.x !== wasBuffer.x || buffer.y !== wasBuffer.y) requestRepaint();
}
addEventListener('resize', () => {
  // A window that got shorter can put the strip over its ceiling.
  applyLaneHeight();
  resize();
  // The ruler takes its tick step from the bed's width, so a width change has to rebuild it.
  if (timeline) buildRuler();
});
resize();

function postEnabled() {
  return afterimage.enabled || mosh.enabled || bloom.enabled || grade.enabled;
}

// Which uniform table each binding writes into. A map rather than a ternary per site, so a
// build that grows a fourth table adds one entry here instead of another branch at five sites -
// and a table nothing resolves throws on the write rather than landing the value in undefined.
// Built here rather than at the top of the file because every one of the three is a live
// binding the boot sequence above has just assigned.
const UNIFORM_TABLE_NAMES = Object.freeze(['points', 'grade', 'mosh']);
const uniformTable = (name) => {
  if (name === 'points') return uniforms;
  if (name === 'grade') return grade.uniforms;
  if (name === 'mosh') return mosh.uniforms;
  throw new Error(`no uniform table called ${JSON.stringify(name)}`);
};

/** The pass a gating term on each table holds open. */
const PASS_OF_TABLE = Object.freeze({ grade, mosh });

/** The terms whose being up makes each gated pass worth running, read off the packages. */
let PASS_GATES;
const passGatesOf = (packages) => Object.fromEntries(EFFECT_GATED_TABLES.map((table) => [
  table,
  packages.flatMap((pkg) => Object.values(pkg.manifest.params ?? {})
    .filter((p) => p.bind?.on === table && p.bind.gates)
    .map((p) => p.bind.uniform)),
]));

function passNeeded(table) {
  const held = uniformTable(table);
  return PASS_GATES[table].some((name) => held[name].value !== 0);
}

/**
 * The dotted registry names of the terms that hold a pass with memory open.
 *
 * Read off the manifests rather than written down, for the reason `passGatesOf` is: a package id
 * hard-coded in here is a fork installed under another name whose pre-roll silently stops being
 * computed, with nothing red anywhere.
 */
const moshMastersOf = (packages) => packages.flatMap((pkg) => Object.entries(pkg.manifest.params ?? {})
  .filter(([, p]) => EFFECT_BOUNDED_TABLES.includes(p.bind?.on) && p.bind.gates)
  .map(([short]) => `${pkg.id}.${short}`));

/** The term saying how long the mosh pass's memory lasts, by both its names, or null. */
const moshBoundOf = (packages) => packages.flatMap((pkg) => Object.entries(pkg.manifest.params ?? {})
  .filter(([, p]) => EFFECT_BOUNDED_TABLES.includes(p.bind?.on) && p.bind.bounds)
  .map(([short, p]) => ({ name: `${pkg.id}.${short}`, uniform: p.bind.uniform })))[0] ?? null;

let MOSH_MASTERS = [];
let MOSH_BOUND = null;

/** Whether the mosh pass is doing anything at a program position, and for how long it remembers. */
const moshLiveAt = (programSec) => MOSH_MASTERS.some((name) => valueAtProgram(name, programSec) !== 0);
// Zero when cycling is disabled: moshRefreshes treats 0 as "refresh every frame", so the preroll
// walk finds a keyframe immediately and returns 0. The render loop guards with moshCycles, so it
// does not actually refresh - but the preroll correctly reports no memory to replay.
const moshPeriodAt = (programSec) => {
  if (!MOSH_BOUND) return 0;
  if (!valueAtProgram('datamosh.cycleRefresh', programSec)) return 0;
  return valueAtProgram(MOSH_BOUND.name, programSec);
};

// The look terms a draft puts down for the length of its one frame. Three of them are the core's
// own accumulators and the rest are whatever the packages brought that accumulates, because a
// draft is one frame rendered out of order and a term whose value depends on the frame before it
// has nothing to read.
const BYPASSED_CORE = Object.freeze(['fade', 'wake', 'trails']);
let BYPASSED = [...BYPASSED_CORE];
let BYPASS_ZERO = Object.fromEntries(BYPASSED.map((name) => [name, 0]));
let BYPASSED_SET = new Set(BYPASSED);

/** How far outside the cloud the fitted faces sit, as a share of the extent they bound. */
const CROP_FIT_PAD = 0.15;

/** Fits the four lateral faces to the take's own cloud. */
async function fitCropToTake(id, near, far, clip = selectedClip, generation = null) {
  const res = await fetch(`/capture/${encodeURIComponent(id)}/extent`
    + `?near=${encodeURIComponent(near)}&far=${encodeURIComponent(far)}`);
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  const extent = await res.json();
  if (!extent.x || !extent.y) return null;
  const padded = ([lo, hi]) => {
    const m = (hi - lo) * CROP_FIT_PAD;
    return [lo - m, hi + m];
  };
  const [left, right] = padded(extent.x);
  const [bottom, top] = padded(extent.y);
  if (generation !== null && (generation !== documentGeneration || !clips.includes(clip))) {
    return { cancelled: true };
  }
  // Through `params.set`, so the fit is a document edit like any other.
  const wrote = {};
  withClip(clip, () => {
    for (const [name, value] of [['left', left], ['right', right], ['bottom', bottom], ['top', top]]) {
      wrote[name] = params.set(name, value);
    }
  });
  return { ...wrote, frames: extent.frames, samples: extent.samples };
}

// Where each effect parameter lands in declaration order, which is the panel's layout.
const EFFECT_PARAM_ORDER = [
  'glyph.amount', 'glyph.tone', 'glyph.hash', 'glyph.rain',
  'ghost.amount', 'ghost.rim', 'ghost.fill',
  'contour.amount', 'contour.bands', 'contour.width',
  'blackwall.amount', 'blackwall.sweep', 'blackwall.scan',
  'noise.amount', 'noise.scale', 'noise.speed', 'lattice.amount',
  'glitch.amount', 'glitch.density', 'glitch.shove', 'glitch.tint',
  'glitch.bands', 'glitch.axis', 'glitch.rate', 'push.amount',
  'noise.region', 'mask.amount', 'ripple.amount', 'ripple.freq',
  'ripple.speed', 'thermal.amount', 'edges.amount', 'duotone.amount',
  'duotone.hue', 'duotone.split', 'duotone.span', 'duotone.motion',
  'rain.amount', 'rain.speed', 'rain.span', 'rain.trail',
  'rgbsplit.amount', 'raster.amount', 'raster.angle', 'raster.pitch',
  'raster.hard', 'grain.amount', 'streak.amount', 'streak.angle',
  'halation.amount', 'halation.radius', 'halation.threshold', 'halation.tint',
  'stock.amount', 'stock.balance', 'stock.split', 'stock.latitude',
  'vignette.amount',
  'datamosh.amount', 'datamosh.reach', 'datamosh.decay', 'datamosh.splay',
  'datamosh.line', 'datamosh.grain', 'datamosh.drift', 'datamosh.speed', 'datamosh.cycleRefresh', 'datamosh.refresh',
];

// The list places the shipped set and is never a census of what is installed.
let EFFECT_PARAMS;

// The names the list above does not place: a newly installed package's parameters.
const effectAppendix = () => Object.keys(EFFECT_PARAMS).slice(EFFECT_PARAM_ORDER.length);

// A group is in use when its own parameters are up. `reveals` is the escape hatch.
const CORE_PANEL_GROUPS = [
  { key: 'colour', label: 'Colour', tab: 'look', collapses: true },
  { key: 'style', label: 'Style', tab: 'look', lookgroup: true, collapses: true },
  {
    key: 'framing',
    label: '',
    tab: 'framing',
    collapses: false,
    // Levelling is document state: the bracket's angle belongs to the take.
    before: panelOnce(() => [
      panelButtonRow(['camSensor', 'sensor view']),
      panelButtonRow(['cropBox', 'show crop box']),
      ...(EDITING ? [panelButtonRow(['cropFit', 'fit box to take'])] : []),
      panelButtonRow(['camLevelReset', 'reset rotation']),
    ]),
    after: panelOnce(() => [
      panelButtonRow(['cropReset', 'revert all to default']),
      panelNote('recRange', 'preview only'),
    ]),
  },
  { key: 'signal', label: 'Signal', tab: 'look', lookgroup: true, collapses: true },
  // The box itself, in metres in the sensor frame. The groups spliced under it are its readings,
  // which is why it comes before displacement here.
  { key: 'region', label: 'Region (metres)', tab: 'region', lookgroup: true, collapses: true },
  { key: 'displacement', label: 'Displacement', tab: 'region', lookgroup: true, collapses: true },
  { key: 'points', label: 'Points', tab: 'look', lookgroup: true, collapses: true },
  { key: 'motion', label: 'Motion', tab: 'look', lookgroup: true, collapses: true },
  { key: 'post', label: 'Post', tab: 'look', lookgroup: true, collapses: true },
  // The two parameters that are not part of the clip. Tagged `view`, with no keyframe control.
  {
    key: 'viewer',
    label: 'Viewer',
    tab: 'camera',
    lookgroup: true,
    collapses: true,
    after: panelOnce(() => [panelNote('viewNote', 'Not saved with the clip and not exported: these '
      + 'change what you are looking at, not what the frame is.')]),
  },
];

// The spine plus every group the installed packages declare, spliced at their anchors.
let PANEL_GROUPS;

/** The write one effect parameter's binding describes, as the closure the registry stores. */
function effectApply(bind) {
  const table = () => uniformTable(bind.on);
  let write;
  if (bind.transform === 'axisDeg') {
    write = (v) => {
      const r = THREE.MathUtils.degToRad(v);
      table()[bind.uniform].value.set(Math.sin(r), Math.cos(r));
    };
  } else if (bind.transform === 'centeredEdges') {
    // Subtract in JavaScript's double precision, then upload the two answers as floats. Doing
    // this arithmetic in the shader rounds the width first and moves the lower edge by one ulp.
    write = (v) => { table()[bind.uniform].value.set(0.5 - v, 0.5 + v); };
  } else if (bind.transform === 'degToRad') {
    write = (v) => { table()[bind.uniform].value = THREE.MathUtils.degToRad(v); };
  } else if (bind.transform) {
    throw new Error(
      `the binding for ${bind.uniform} names the transform ${JSON.stringify(bind.transform)}, `
      + `which this applier does not know - it implements ${EFFECT_BIND_TRANSFORMS.join(' and ')}, `
      + 'and an unknown one would land its value unconverted',
    );
  } else {
    write = (v) => { table()[bind.uniform].value = v; };
  }
  if (!bind.gates) return write;
  return (v) => { write(v); PASS_OF_TABLE[bind.on].enabled = passNeeded(bind.on); };
}

/** One run of `EFFECT_PARAMS`, as entries ready to spread into `PARAMS`. */
const effectSlice = (first, last) => {
  const names = Object.keys(EFFECT_PARAMS);
  const from = names.indexOf(first);
  const to = names.indexOf(last);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`${first}..${last} is not a run of the assembled effect table in that order`);
  }
  return Object.fromEntries(names.slice(from, to + 1).map((name) => {
    const bind = EFFECT_PARAMS[name];
    const entry = {
      def: bind.def, min: bind.min, max: bind.max, step: bind.step, kind: bind.kind,
      // Where the binding writes is where the value is stored, and the question is whether it
      // writes the cloud program: that table is one clip's, and every other one is over the
      // composited frame, of which there is one however many clips drew into it. Asked as
      // "is it points" rather than "is it grade" so a post-chain table added later is the
      // project's by existing - `mosh` arrived after this line was first written and was
      // per-clip for exactly as long as the test named the tables it was not.
      tag: 'look', scope: bind.on === 'points' ? 'clip' : 'project',
      group: bind.group, label: bind.label, apply: effectApply(bind),
    };
    if (bind.reading !== undefined) entry.reading = bind.reading;
    if (bind.under !== undefined) entry.under = bind.under;
    return [name, entry];
  }));
};

// Where a clip sits before anybody moves it: at the origin, unrotated.
const DEFAULT_PLACEMENT = { position: [0, 0, 0], quaternion: [0, 0, 0, 1] };

/** The registry, rebuilt. `PARAMS` is a function of which packages are installed. */
const buildParams = () => ({
  // Pixels at 1080p, not pixels.
  pointSize: { def: 9, min: 0.5, max: 64, step: 0.1, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'points', label: 'size',
    apply: (v) => { uniforms.pointSize.value = v; } },
  opacity: { def: 1, min: 0.05, max: 1, step: 0.01, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'points', label: 'opacity',
    apply: (v) => { uniforms.opacity.value = v; } },
  exposure: { def: 1.15, min: 0.05, max: 6, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'colour', label: 'brightness',
    apply: (v) => { uniforms.exposure.value = v; } },
  additive: { def: false, kind: 'step', tag: 'look', scope: 'clip',
    group: 'points', label: 'additive glow',
    // The switch decides which half of the draw order this clip is in, so it rewrites it.
    apply: (on) => { setAdditive(on); orderClips(); } },

  ...effectSlice('glyph.amount', 'glyph.rain'),

  // The mount's cant, in degrees. Document state, because the angle belongs to the take.
  tilt: { def: 0, min: -90, max: 90, step: 0.5, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'framing', label: 'tilt',
    apply: (v) => { levelAngles.tilt = v; applyWorldTilt(); } },
  roll: { def: 0, min: -180, max: 180, step: 0.5, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'framing', label: 'roll',
    apply: (v) => { levelAngles.roll = v; applyWorldTilt(); } },
  near: { def: CLIP_NEAR_DEFAULT, min: 0.05, max: 9.5, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'framing', label: 'near',
    apply: (v) => { uniforms.nearClip.value = v; } },
  far: { def: CLIP_FAR_DEFAULT, min: 0.05, max: 9.5, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'framing', label: 'far',
    apply: (v) => { uniforms.farClip.value = v; } },

  // Whether the box cuts at all. Not a second spelling of the faces being at their bounds.
  crop: { def: true, kind: 'step', tag: 'look', scope: 'clip',
    group: 'framing', label: 'crop',
    apply: (on) => { uniforms.cropOn.value = on ? 1 : 0; } },

  left: { def: -CROP_LIMIT, min: -CROP_LIMIT, max: CROP_LIMIT, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'framing', label: 'left',
    apply: (v) => { uniforms.cropL.value = v; } },
  right: { def: CROP_LIMIT, min: -CROP_LIMIT, max: CROP_LIMIT, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'framing', label: 'right',
    apply: (v) => { uniforms.cropR.value = v; } },
  bottom: { def: -CROP_LIMIT, min: -CROP_LIMIT, max: CROP_LIMIT, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'framing', label: 'bottom',
    apply: (v) => { uniforms.cropB.value = v; } },
  top: { def: CROP_LIMIT, min: -CROP_LIMIT, max: CROP_LIMIT, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'framing', label: 'top',
    apply: (v) => { uniforms.cropT.value = v; } },

  interpolate: { def: true, kind: 'step', tag: 'look', scope: 'clip',
    group: 'signal', label: 'interpolate frames',
    apply: (on) => { uniforms.interpolate.value = on ? 1 : 0; } },
  snapDelta: { def: 250, min: 20, max: 1200, step: 10, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'signal', label: 'snap mm',
    apply: (v) => { uniforms.snapDelta.value = v; } },

  // Fade is the cross-fade, wake is how much longer a hard transition lingers on it.
  fade: { def: 120, min: 0, max: 1500, step: 10, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'motion', label: 'fade',
    apply: (v) => { uniforms.fadeTime.value = v / 1000; } },
  wake: { def: 0, min: 0, max: 4000, step: 10, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'motion', label: 'wake',
    apply: (v) => { uniforms.wakeTime.value = v / 1000; } },

  ...effectSlice('noise.amount', 'lattice.amount'),
  // In metres of the room, like every other displacement and unlike the screen-space terms.
  'cell': { def: 0.05, min: 0.005, max: 0.5, step: 0.005, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'displacement', label: 'cell m',
    apply: (v) => { uniforms.latticeCell.value = v; } },

  ...effectSlice('glitch.amount', 'glitch.rate'),

  // One region, authored once and read four ways. Three scalars rather than a `point` kind.
  regionX: { def: 0, min: -3, max: 3, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'region', label: 'x',
    apply: (v) => { uniforms.regionCentre.value.x = v; } },
  regionY: { def: 0, min: -3, max: 3, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'region', label: 'y',
    apply: (v) => { uniforms.regionCentre.value.y = v; } },
  regionZ: { def: -2, min: -6, max: 0, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'region', label: 'z',
    apply: (v) => { uniforms.regionCentre.value.z = v; } },
  regionW: { def: 0, min: 0, max: 3, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'region', label: 'width',
    apply: (v) => { uniforms.regionHalf.value.x = v; } },
  regionH: { def: 0, min: 0, max: 3, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'region', label: 'height',
    apply: (v) => { uniforms.regionHalf.value.y = v; } },
  regionD: { def: 0, min: 0, max: 3, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'region', label: 'depth',
    apply: (v) => { uniforms.regionHalf.value.z = v; } },
  regionRound: { def: 0.5, min: 0, max: 2, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'region', label: 'radius',
    apply: (v) => { uniforms.regionRound.value = v; } },
  regionSoft: { def: 0.2, min: 0.01, max: 1, step: 0.01, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'region', label: 'falloff',
    apply: (v) => { uniforms.regionSoft.value = v; } },

  ...effectSlice('push.amount', 'ripple.speed'),
  // View state rather than an edit: the controls advance it on the program clock.
  spin: { def: false, kind: 'step', tag: 'view',
    group: 'viewer', label: 'auto-orbit',
    apply: (on) => { controls.autoRotate = on; } },

  // The five readings of the take, as look parameters that mix rather than modes that exclude.
  readRgb: { def: 1, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look', scope: 'clip', reading: true,
    group: 'colour', label: 'colour',
    apply: (v) => { uniforms.readRgb.value = v; } },
  readDepth: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look', scope: 'clip', reading: true,
    group: 'colour', label: 'depth',
    apply: (v) => { uniforms.readDepth.value = v; } },
  // The three reading effects: ghost, contour, blackwall. Each blends into the colour
  // the same way RGB and Depth do above, and carries its own tuning parameters.
  ...effectSlice('ghost.amount', 'ghost.fill'),
  ...effectSlice('contour.amount', 'contour.width'),
  ...effectSlice('blackwall.amount', 'blackwall.scan'),

  rgbSaturation: { def: 1, min: 0, max: 2, step: 0.01, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'colour', label: 'saturation',
    apply: (v) => { uniforms.rgbSaturation.value = v; } },
  depthGamma: { def: 1, min: 0.25, max: 4, step: 0.05, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'colour', label: 'gamma',
    apply: (v) => { uniforms.depthGamma.value = v; } },
  rim: { def: 0.55, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'style', label: 'rim',
    apply: (v) => { uniforms.rimAmount.value = v; } },
  ...effectSlice('thermal.amount', 'duotone.motion'),

  ...effectSlice('rain.amount', 'rain.trail'),
  // A post pass costs a full-screen read and write, so a zero value switches it off.
  bloom: { def: 0, min: 0, max: 1, step: 0.05, kind: 'scalar', tag: 'look', scope: 'project',
    group: 'post', label: 'bloom',
    apply: (v) => { bloom.strength = v; bloom.enabled = v > 0; } },
  trails: { def: 0, min: 0, max: 0.97, step: 0.01, kind: 'scalar', tag: 'look', scope: 'project',
    group: 'motion', label: 'trails',
    apply: (v) => { afterimage.uniforms.damp.value = v; afterimage.enabled = v > 0; } },
  ...effectSlice('rgbsplit.amount', 'vignette.amount'),
  // The toe under the grade's Reinhard curve, and the one term that does not gate the pass.
  crush: { def: 0.018, min: 0, max: 0.2, step: 0.001, kind: 'scalar', tag: 'look', scope: 'project',
    group: 'post', label: 'crush',
    apply: (v) => { grade.uniforms.crush.value = v; } },
  ...effectSlice('datamosh.amount', 'datamosh.refresh'),

  denoise: { def: true, kind: 'step', tag: 'look', scope: 'clip',
    group: 'signal', label: 'cull speckle',
    apply: (on) => { uniforms.denoise.value = on ? 1 : 0; } },
  edgeTol: { def: 120, min: 10, max: 1200, step: 10, kind: 'scalar', tag: 'look', scope: 'clip',
    group: 'signal', label: 'edge tol',
    apply: (v) => { uniforms.edgeTol.value = v; } },
  renderScale: { def: 100, min: 40, max: 200, step: 5, kind: 'scalar', tag: 'view',
    group: 'viewer', label: 'render %',
    apply: (v) => { renderScale = v / 100; resize(); } },

  ...(effectAppendix().length ? effectSlice(effectAppendix()[0], effectAppendix().at(-1)) : {}),

  camera: { def: DEFAULT_POSE, kind: 'pose', tag: 'composition',
    apply: (p) => {
      programCamera.position.fromArray(p.position);
      programCamera.quaternion.fromArray(p.quaternion);
      if (programCamera.fov !== p.fov) {
        programCamera.fov = p.fov;
        programCamera.updateProjectionMatrix();
      }
    } },

  // Where a clip sits in the room. A placement is a pose without a lens - a clip has no field of
  // view - and it is scoped to the clip because the group it writes is that clip's own.
  transform: { def: DEFAULT_PLACEMENT, kind: 'placement', tag: 'composition', scope: 'clip',
    apply: (p) => {
      transform.position.fromArray(p.position);
      transform.quaternion.fromArray(p.quaternion);
    } },
});

/** The registry itself, with the readings read off it rather than written down again. */
let PARAMS;
let READINGS;

/**
 * The two blocks a stored value can be written to, which is decided by where its `apply` writes:
 * the selected cloud's uniform table, its levelling angles or its placement are a clip's, the
 * grade pass, bloom and the afterimage are the project's.
 */
const BLOCK_SCOPES = ['clip', 'project'];

/** The parameters stored in one block, in registry order. Every one carrying that scope. */
const scopeNames = (scope) => params.names().filter((n) => PARAMS[n].scope === scope);

/**
 * The kinds nothing draws a control for: they are edited in the world, with a gizmo.
 *
 * A pose and a placement are both a position and a rotation, which is three handles and not a
 * slider, so the panel generator asks this rather than asking after a tag - a parameter that is
 * edited in the viewport says so by its kind.
 */
const WORLD_KINDS = new Set(['pose', 'placement']);
const editedInWorld = (name) => WORLD_KINDS.has(PARAMS[name].kind);

/** Which of the five readings a document does not name, asked at both doors. */
function missingReadings(values) {
  return READINGS.filter((n) => !Object.hasOwn(values, n));
}

/** Everything the registry has to be true of, asked of the table that has just been built. */
function refuseRegistryDisagreement() {
  for (const name of READINGS) {
    const uniform = effectOf(name) === null ? name : EFFECT_PARAMS[name]?.uniform;
    if (!uniform || !Object.hasOwn(uniforms, uniform)) {
      throw new Error(`the reading ${name} binds no point uniform: its slider would move nothing`);
    }
  }

  for (const name of Object.keys(EFFECT_PARAMS)) {
    if (!Object.hasOwn(PARAMS, name)) {
      throw new Error(
        `${name} is declared by an installed effect and reaches no registry entry: it would `
        + 'be a look term with no slider and no track, and a document naming it would be refused',
      );
    }
  }
  for (const name of Object.keys(PARAMS)) {
    if (effectOf(name) !== null && !Object.hasOwn(EFFECT_PARAMS, name)) {
      throw new Error(
        `${name} is an effect parameter written out in the registry rather than declared in `
        + 'a manifest: it is a second copy of a binding, and the copy is what drifts',
      );
    }
  }

  // The scope decides which block of the document a value is written to and read back from, so
  // a look parameter without one would be saved into neither and come back as its default. A
  // composition parameter may carry one and the camera does not: a placement is stored in the
  // block of the clip it places, and the camera is the project's and has a field of its own.
  for (const name of Object.keys(PARAMS)) {
    const scope = PARAMS[name].scope;
    const tag = PARAMS[name].tag;
    if (tag === 'look' && !BLOCK_SCOPES.includes(scope)) {
      throw new Error(
        `the look parameter ${name} is scoped ${JSON.stringify(scope)}: every look value is `
        + `stored under ${BLOCK_SCOPES.join(' or ')}, and one under neither would be written to `
        + 'no block of the document and come back as its default',
      );
    }
    if (tag === 'view' && scope !== undefined) {
      throw new Error(
        `the view parameter ${name} carries a scope of ${JSON.stringify(scope)}: view state is `
        + 'stored in no block at all, so a scope here says nothing',
      );
    }
    if (tag === 'composition' && scope !== undefined && !BLOCK_SCOPES.includes(scope)) {
      throw new Error(
        `the composition parameter ${name} is scoped ${JSON.stringify(scope)}: a composition `
        + `value is stored under ${BLOCK_SCOPES.join(' or ')} or in a field of its own, and one `
        + 'under neither would be written nowhere and come back as its default',
      );
    }
  }

  // The age ceiling has to cover the longest persistence the two sliders can ask for.
  refuseAgeCeiling((PARAMS.fade.max + PARAMS.wake.max) / 1000);
}

// Checks every value for what it is rather than coercing it into something.
function normalise(name, spec, value) {
  if (spec.kind === 'pose' || spec.kind === 'placement') {
    // A placement is a pose without a lens, so the lens is the only term the two differ over.
    const lensed = spec.kind === 'pose';
    // Shape alone is not enough: a short position array leaves the camera's z NaN.
    const finite = (xs, n) => Array.isArray(xs) && xs.length === n && xs.every(Number.isFinite);
    if (!finite(value?.position, 3) || !finite(value?.quaternion, 4)
      || (lensed && !Number.isFinite(value?.fov))) {
      throw new Error(
        `${name} is a ${spec.kind}: it needs a 3-number position, a 4-number quaternion`
        + `${lensed ? ' and a numeric fov' : ''}, got ${JSON.stringify(value)}`,
      );
    }
    // Four finite numbers is not a rotation, so the quaternion is checked for length too.
    const len = Math.hypot(...value.quaternion);
    if (Math.abs(len - 1) > 1e-3) {
      throw new Error(
        `${name} has a quaternion of length ${len.toFixed(6)}: a rotation is unit length, `
        + `and interpolating through [${value.quaternion.join(', ')}] would render a `
        + 'move nobody authored',
      );
    }
    return {
      position: value.position.slice(),
      quaternion: value.quaternion.slice(),
      ...(lensed ? { fov: value.fov } : {}),
    };
  }
  if (typeof spec.def === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${name} is a step parameter: it takes a boolean, got ${JSON.stringify(value)}`);
    return value;
  }
  const v = value;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`${name} is a scalar: it takes a finite number, got ${JSON.stringify(value)}`);
  }
  return snapScalar(spec, v);
}

const panelControls = new Map();
// Declared here rather than beside the button that fills it, because `writeControl` reads it.
const resetButtons = new Map();

let activePanelTab = EDITING ? 'look' : 'record';

const presetPickBoxes = new Map();
const presetPickGroups = [];

/** What the panel last painted per group, so a refresh writes only where the answer moved. */
const groupPainted = new Map();
const effectRackPainted = new Map();

// What each parameter is worth in an untouched project. Through `normalise`, never raw `def`.
const groupDefaults = new Map();

/** What a reset puts back, asked of the same function that decides what `set` stores. */
function resetTarget(name) {
  const spec = specOf(name);
  return normalise(name, spec, spec.def);
}

/**
 * Whether the panel row for a parameter is live: a clip value is editable while the strip has a
 * clip selected, and everything else always. The recorder has no strip and no clip rows, so its
 * whole panel is live - the greying says which clip a write would land on, and there it is the
 * only clip there is.
 */
const rowLive = (name) => PARAMS[name].scope !== 'clip' || !EDITING || clipRow !== null;

/** Whether this row is offering a reset, re-derived from the write that moved the value. */
function refreshReset(name, value) {
  const button = resetButtons.get(name);
  if (!button) return;
  const modified = value !== resetTarget(name);
  button.dataset.modified = modified ? 'yes' : 'no';
  // `disabled` rather than `hidden`: the slot is reserved, so a row cannot change height.
  button.disabled = !modified || !rowLive(name);
}

function writeControl(name, value) {
  const el = panelControls.get(name);
  if (!el) return;
  if (el.type === 'checkbox') {
    el.checked = value;
  } else {
    el.value = String(value);
    // Read the value back off the element, so the readout says exactly what the slider says.
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = el.value;
  }
  refreshReset(name, value);
}

// Announced after every registry write, so whatever is showing the image can rebuild it.
let paramWritten = () => {};

// The other announcement a write makes: whether a panel group is worth showing at all.
let groupRevealChanged = () => {};

// Registry writes the transport makes on its own behalf rather than on a user's.
let transportWriting = false;

/**
 * Runs a write against one clip: its own look tables, and the render core pointed at its cloud.
 *
 * Both halves are needed and neither is enough. The tables decide where the value is stored; the
 * selection decides which uniform table, material and levelling group `spec.apply` reaches.
 */
function withClip(clip, write) {
  const held = evaluatingClip;
  evaluatingClip = clip;
  selectCloud(clip.cloud);
  try {
    return write();
  } finally {
    evaluatingClip = held;
    selectCloud((evaluatingClip ?? selectedClip).cloud);
  }
}

/** `PARAMS[name]` is not a membership test: it inherits `toString` and the rest. */
function specOf(name) {
  if (!Object.hasOwn(PARAMS, name)) throw new Error(`unknown parameter ${JSON.stringify(name)}`);
  return PARAMS[name];
}

// Two flags declared here rather than beside the code that owns them, because `params.set`
// below reads both and the boot value walk calls it while this module is still evaluating. A
// `let` read above its declaration throws, and a page that throws here publishes no `__kinect`
// and boots into nothing.

// Applying a preset is a user action and can never be an evaluation-time effect.
let evaluating = false;

// Whether an export owns the renderer. Nothing else may draw while one does, and nothing may
// write the document it is reading.
let exporting = false;

const params = {
  spec(name) {
    const spec = specOf(name);
    return {
      default: spec.def, min: spec.min, max: spec.max, step: spec.step,
      kind: spec.kind, tag: spec.tag, scope: spec.scope ?? null, under: spec.under ?? null,
    };
  },
  names(tag) {
    return Object.keys(PARAMS).filter((n) => !tag || PARAMS[n].tag === tag);
  },
  get(name) {
    const spec = specOf(name);
    const v = homeOf(spec).values.get(name);
    return WORLD_KINDS.has(spec.kind)
      ? { ...v, position: [...v.position], quaternion: [...v.quaternion] } : v;
  },
  /** What `set` would store, without storing it. */
  normalise(name, value) {
    return normalise(name, specOf(name), value);
  },
  /** The single write path. UI, presets and the tracks all go through here. */
  set(name, value) {
    const spec = specOf(name);
    const paintControl = spec.scope !== 'clip'
      || evaluatingClip === null || evaluatingClip === selectedClip;
    // The export renders through this same path - `evaluateTracks` writes every keyed value on
    // every frame it draws - so the carve-out is what lets the render proceed while a hand on a
    // control is refused. The control is written back from the registry rather than left showing
    // the number nobody accepted, which is the second place the refusal is visible.
    if (!evaluating && refuseEdit(`a change to ${name}`)) {
      const held = homeOf(spec).values.get(name);
      if (paintControl) writeControl(name, held);
      return held;
    }
    const v = normalise(name, spec, value);
    homeOf(spec).values.set(name, v);
    // Straight through: the render core is already pointed at the clip this write is about,
    // because the only way to be writing another clip's look is to be inside `withClip`.
    spec.apply(v);
    if (paintControl) writeControl(name, v);
    paramWritten(name, spec.tag);
    // `paramWritten` says the image changed. This says a group may have appeared or gone.
    if (!transportWriting) groupRevealChanged();
    return v;
  },
  /** A bulk write. */
  apply(next) {
    refuseDuringEvaluation('a bulk write');
    // Checked in full first, because a write that throws halfway leaves an unauthored look.
    const checked = Object.entries(next).map(([name, value]) => [name, this.normalise(name, value)]);
    for (const [name, value] of checked) this.set(name, value);
    return this;
  },
  /** A plain serialisable object. A project, a preset and an export job all start here. */
  values(names = this.names().filter((n) => PARAMS[n].tag !== 'view')) {
    return Object.fromEntries(names.map((n) => [n, this.get(n)]));
  },
  /** Defaults, not a serialisation, so this one does cover view state. */
  reset(names = Object.keys(PARAMS)) {
    for (const name of names) this.set(name, PARAMS[name].def);
    return this;
  },
};

// One keyframe control per look parameter, built in the same pass as its row.
const keyButtons = new Map();

function makeKeyButton(name) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'kf';
  button.setAttribute('aria-label', `${name} keyframe`);
  button.appendChild(document.createElement('i'));
  button.addEventListener('click', () => toggleKey(name));
  button.dataset.kf = 'none';
  keyButtons.set(name, button);
  return button;
}

// The reset glyph, drawn as a stroked path so it takes its colour from the state around it.
function resetGlyph() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // Decorative: the button's label already carries the whole of what this means.
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5']) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * One reset control per keyframable slider. It writes through `params.set` and nothing else.
 */
function makeResetButton(name) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reset';
  button.dataset.reset = name;
  button.setAttribute('aria-label', `${name} reset to default`);
  button.append(resetGlyph());
  button.addEventListener('click', () => {
    retainEffectFor(name);
    params.set(name, resetTarget(name));
    history.commit();
    // The press removes its own control, which would otherwise take focus out of the tab order.
    const slider = panelControls.get(name);
    slider.focus();
    if (document.activeElement !== slider) {
      const toggle = button.closest('.group')?.querySelector('.grouptoggle');
      if (toggle) toggle.focus();
    }
  });
  button.dataset.modified = 'no';
  button.disabled = true;
  resetButtons.set(name, button);
  return button;
}

// The panel is a view on the registry and holds no parameter data of its own.
const panelNode = (tag, className, text) => {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text) el.textContent = text;
  return el;
};

const panelButtonRow = (...buttons) => {
  const row = panelNode('div', 'btnrow');
  for (const [id, text] of buttons) {
    const button = panelNode('button', null, text);
    button.type = 'button';
    button.id = id;
    row.append(button);
  }
  return row;
};

/** A group's hand-written furniture, built once and re-parented on every rebuild. */
function panelOnce(build) {
  let made = null;
  return () => (made ??= build());
}

const panelNote = (id, text) => {
  const note = panelNode('div', null, text);
  note.id = id;
  return note;
};

/** One row, in the shape the CSS and the proof tools already expect. */
function panelRow(name, spec) {
  const input = document.createElement('input');
  input.id = name;
  if (spec.kind === 'step') {
    input.type = 'checkbox';
    const label = panelNode('label', 'check');
    label.append(input, ` ${spec.label}`);
    return { input, node: label };
  }
  input.type = 'range';
  // Stamped from the registry: two copies of a slider's bounds is two things to keep in step.
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  const row = panelNode('div', 'row');
  const out = document.createElement('output');
  out.style.cursor = 'pointer';
  // Clicking the readout opens it for direct number entry.
  out.addEventListener('click', () => {
    const currentValue = out.textContent;
    const edit = document.createElement('input');
    edit.type = 'text';
    edit.value = currentValue;
    edit.style.cssText = 'width: 42px; text-align: right; font: inherit; background: transparent; color: var(--accent); border: 0; outline: 0; padding: 0; margin: 0;';
    // One way out, and whether it writes is an argument to it.
    let editing = true;
    const close = (write) => {
      if (!editing) return;
      editing = false;
      const parsed = parseFloat(edit.value);
      // Put the output back first so `writeControl` can find it.
      edit.replaceWith(out);
      if (!write || isNaN(parsed)) return;
      const clamped = Math.max(spec.min, Math.min(spec.max, parsed));
      input.value = String(clamped);
      out.textContent = input.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    edit.addEventListener('blur', () => close(true));
    edit.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(true); }
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
    });
    out.replaceWith(edit);
    edit.focus();
    edit.select();
  });
  row.append(panelNode('span', null, spec.label), input, out);
  return { input, node: row };
}

// Where a generated group lands: the grade at the end, everything a shoot needs above it.
function panelAnchor(group) {
  const id = group.lookgroup ? 'gradeAnchor' : 'sensorGroup';
  const anchor = document.getElementById(id);
  if (!anchor) throw new Error(`the panel group ${group.key} has no anchor: no #${id} in the markup`);
  return anchor;
}

// Placing after a fixed anchor reverses the order that placing before it preserves.
const panelTail = new Map();
function panelPlace(group, groupNode) {
  const anchor = panelAnchor(group);
  if (!group.lookgroup) { anchor.before(groupNode); return; }
  (panelTail.get(anchor) || anchor).after(groupNode);
  panelTail.set(anchor, groupNode);
}

// What the collapse rule has to find again: the group's node, its parameters, its elements.
const panelGroupNodes = new Map();
const panelGroupParams = new Map();
const panelGroupElements = new Map();
const panelEffectRows = new Map();
// Rows whose visibility depends on a parent parameter being non-zero. Keyed by the
// parent name (e.g. 'ghost.amount'), value is an array of row elements. When the parent
// is 0 the rows are hidden; when it's positive they're shown. This is how reading
// tuning parameters (ghost.rim, contour.bands, etc.) appear only when their reading is
// active.
const panelUnderRows = new Map();

// One head per group, whether or not the group can be shut.
function panelHead(group) {
  const head = panelNode('div', 'grouphead');
  const label = panelNode('label', null, group.label);
  head.append(label);

  // Effect groups get a remove button that appears on hover.
  const owner = groupOwner(group.key);
  if (owner) {
    const remove = panelNode('button', 'groupremove');
    remove.type = 'button';
    remove.setAttribute('aria-label', `remove ${group.label}`);
    remove.addEventListener('click', () => removeEffectFromRack(owner));
    head.append(remove);
  }

  if (!group.collapses) return { head, button: null };

  label.style.cursor = 'pointer';
  label.addEventListener('click', () => toggleGroup(group.key));

  const button = panelNode('button', 'grouptoggle');
  button.type = 'button';
  button.dataset.groupToggle = group.key;
  button.id = `${group.key}Toggle`;
  button.append(panelNode('i', 'groupchevron'));
  button.addEventListener('click', () => toggleGroup(group.key));
  head.append(button);
  return { head, button };
}

let panelRowsEmitted = 0;

/** The panel, generated out of the registry. Rebuilt whole rather than patched. */
function buildPanel() {
  for (const node of document.querySelectorAll('#panelBody > [data-group]')) node.remove();
  panelControls.clear();
  keyButtons.clear();
  resetButtons.clear();
  panelGroupNodes.clear();
  panelGroupParams.clear();
  panelGroupElements.clear();
  panelEffectRows.clear();
  panelUnderRows.clear();
  panelTail.clear();
  groupDefaults.clear();
  // `refreshGroups` skips a group whose state string has not moved, so this clears with it.
  groupPainted.clear();
  effectRackPainted.clear();
  panelRowsEmitted = 0;
  for (const group of PANEL_GROUPS) {
  const groupNode = panelNode('div', group.lookgroup ? 'group lookgroup' : 'group');
  // A data attribute and not an id: the hand-written groups already own their ids.
  groupNode.dataset.group = group.key;
  groupNode.dataset.panelTab = group.tab;
  panelGroupElements.set(group.key, groupNode);
  const { head, button: headButton } = panelHead(group);
  if (group.label || group.collapses) groupNode.append(head);
  if (group.before) groupNode.append(...group.before());
  const names = [];
  panelGroupParams.set(group.key, names);
  if (group.collapses) {
    panelGroupNodes.set(group.key, { group, node: groupNode, button: headButton });
  }

  let rows = 0;
  for (const [name, spec] of Object.entries(PARAMS)) {
    if (spec.group !== group.key) continue;
    const { input, node: row } = panelRow(name, spec);
    panelControls.set(name, input);
    if (input.type === 'checkbox') {
      // A checkbox has no drag, so `change` is the write and the end of the interaction.
      input.addEventListener('change', () => { writeFromControl(name, input.checked); history.commit(); });
    } else {
      // The conversion belongs to the control: a slider's value is text because
      // the DOM says so.
      input.addEventListener('input', () => writeFromControl(name, Number(input.value)));
      // The other half of the `input`/`change` split: one undo snapshot when the drag ends.
      input.addEventListener('change', () => history.commit());
    }

    // The two controls that ride beside a look row, gated by different questions.
    let mountedRow = row;
    if (spec.tag === 'look') {
      const keyButton = EDITING ? makeKeyButton(name) : null;
      const beside = [...(keyButton ? [keyButton] : []), makeResetButton(name)];
      if (input.type === 'checkbox') {
        // A button inside the control's own `<label>` would toggle the checkbox.
        const checkrow = panelNode('div', 'checkrow');
        checkrow.append(row, ...beside);
        groupNode.append(checkrow);
        mountedRow = checkrow;
      } else {
        row.append(...beside);
        groupNode.append(row);
      }
    } else {
      groupNode.append(row);
    }
    // The scope on the row, so the panel can say which half of the split a control belongs to
    // without asking the registry again per paint.
    if (spec.scope) mountedRow.dataset.scope = spec.scope;
    rows++;
    panelRowsEmitted++;
    const owner = effectOf(name);
    if (owner) {
      if (!panelEffectRows.has(owner)) panelEffectRows.set(owner, []);
      panelEffectRows.get(owner).push(mountedRow);
    }
    // A row that depends on another parameter being non-zero. The reading tuning params
    // are hidden until their reading is active, so ghost.rim only appears when ghost.amount > 0.
    if (spec.under) {
      if (!panelUnderRows.has(spec.under)) panelUnderRows.set(spec.under, []);
      panelUnderRows.get(spec.under).push(mountedRow);
    }
    names.push(name);
  }
  // A heading with nothing under it is a group key misspelled on one side.
  if (rows === 0) throw new Error(`the panel group ${group.key} holds no parameter`);

  if (group.after) groupNode.append(...group.after());
  panelPlace(group, groupNode);
  }

  const owned = params.names().filter((n) => !editedInWorld(n));
  const stray = owned.filter((n) => !PANEL_GROUPS.some((g) => g.key === PARAMS[n].group));
  if (stray.length) {
    throw new Error(`${stray.join(', ')} name no panel group, so the panel would be missing `
      + `${stray.length} of ${owned.length} controls`);
  }
  // A pose and a placement are dragged in the viewport, so one with a row is a mistake.
  const crossed = params.names().filter((n) => editedInWorld(n) && (PARAMS[n].group || PARAMS[n].label));
  if (crossed.length) throw new Error(`${crossed.join(', ')} is edited in the world and declares a panel group`);
  if (panelRowsEmitted !== owned.length) {
    throw new Error(`the panel generator emitted ${panelRowsEmitted} rows for ${owned.length} `
      + 'parameters: a panel that is not the registry is a look nothing can reach');
  }

  for (const names of panelGroupParams.values()) {
    for (const name of names) groupDefaults.set(name, params.normalise(name, PARAMS[name].def));
  }

  // The tab that was up, put back over the groups that have just been made.
  hideOffTab();

  // The preset subset dialog is a second view of this panel and goes stale in the same way.
  buildPresetPicker();
}

let effectSignature;

/** The store signature this page has already tried and failed to be rebuilt from, or null. */
let refusedEffectSignature = null;

/** A uniform cell for every binding the registry holds, minted where the tables have none. */
const uniformCellFits = (cell, bind) => Boolean(cell)
  && (cell.value instanceof THREE.Vector2) === (effectBindUniformType(bind.transform) === 'vec2');

function seedUniformCells() {
  for (const name of Object.keys(EFFECT_PARAMS)) {
    const bind = EFFECT_PARAMS[name];
    const table = uniformTable(bind.on);
    if (uniformCellFits(table[bind.uniform], bind)) continue;
    table[bind.uniform] = {
      value: effectBindUniformType(bind.transform) === 'vec2' ? new THREE.Vector2() : 0,
    };
  }
}

/** Which uniform every parameter writes, keyed on the table as well as the name. */
const boundUniforms = (table) => new Map(Object.values(table ?? {})
  .map((bind) => [`${bind.on} ${bind.uniform}`, bind]));

/** What each uniform table held before any parameter had ever been written into it. */
const snapshotUniformValues = (table) => new Map(Object.entries(table)
  .map(([name, cell]) => [name, cell?.value instanceof THREE.Vector2 ? cell.value.clone() : cell?.value]));
const PRISTINE_UNIFORMS = Object.fromEntries(UNIFORM_TABLE_NAMES
  .map((table) => [table, snapshotUniformValues(uniformTable(table))]));

/** Every uniform a parameter used to write and none writes now, put back where it started. */
function restoreDepartedUniforms(was, now) {
  for (const [key, bind] of was) {
    if (now.has(key)) continue;
    const table = uniformTable(bind.on);
    const cell = table[bind.uniform];
    if (!cell) continue;
    const pristine = PRISTINE_UNIFORMS[bind.on]?.get(bind.uniform);
    if (pristine === undefined) {
      cell.value = effectBindUniformType(bind.transform) === 'vec2' ? new THREE.Vector2() : 0;
    }
    else cell.value = pristine instanceof THREE.Vector2 ? pristine.clone() : pristine;
  }
}

/** The programs, the registry, the panel and every value, from one set of packages. */
function adoptEffectPackages(packages, programs, held = { project: {}, clips: [] }) {
  const wasBound = boundUniforms(EFFECT_PARAMS);
  effectPackages = packages;
  shaderPrograms = programs;
  // What the store looked like when these were read, so the poll compares against it.
  effectSignature = revSignature(packages);

  // The materials are mutated rather than replaced: everything downstream holds them.
  forEachLook(() => setCloudProgram(programs.cloud));
  setGradeProgram(programs.grade);
  setMoshProgram(programs.mosh);

  EFFECT_PARAMS = tableFromPackages(packages, EFFECT_PARAM_ORDER);
  PANEL_GROUPS = withEffectGroups(CORE_PANEL_GROUPS, packages);
  // Which terms hold each gated pass open, re-derived from the set that just arrived, and
  // which of them the transport has to put down while it drafts.
  PASS_GATES = passGatesOf(packages);
  MOSH_MASTERS = moshMastersOf(packages);
  MOSH_BOUND = moshBoundOf(packages);
  BYPASSED = [...BYPASSED_CORE, ...MOSH_MASTERS];
  BYPASS_ZERO = Object.fromEntries(BYPASSED.map((name) => [name, 0]));
  BYPASSED_SET = new Set(BYPASSED);
  PARAMS = buildParams();
  READINGS = Object.keys(PARAMS).filter((n) => PARAMS[n].reading);
  refuseRegistryDisagreement();
  forEachLook(() => {
    seedUniformCells();
    restoreDepartedUniforms(wasBound, boundUniforms(EFFECT_PARAMS));
  });

  // Every clip's and the project's: a value whose parameter has left the registry is a value
  // nothing can read, and one left in a clip nobody is looking at would be written back out.
  for (const look of [...clips.map((clip) => clip.look), projectLook, bootLook]) {
    for (const name of [...look.values.keys()]) {
      if (!Object.hasOwn(PARAMS, name)) look.values.delete(name);
    }
  }

  buildPanel();

  // Every parameter, through the one write path, in registry order. The project's half once and
  // each clip's through its own tables: a rebuild that put one clip's values back onto every clip
  // would publish a merged look, which is the failure making a clip's look its own exists to end.
  for (const name of Object.keys(PARAMS)) {
    if (PARAMS[name].scope === 'clip') continue;
    params.set(name, Object.hasOwn(held.project, name) ? held.project[name] : PARAMS[name].def);
  }
  let at = 0;
  forEachLook(() => {
    const was = held.clips[at] ?? {};
    at += 1;
    for (const name of Object.keys(PARAMS)) {
      if (PARAMS[name].scope !== 'clip') continue;
      params.set(name, Object.hasOwn(was, name) ? was[name] : PARAMS[name].def);
    }
  });

  // Asked again, because a gated parameter's own write cannot answer for a term that left.
  for (const table of EFFECT_GATED_TABLES) PASS_OF_TABLE[table].enabled = passNeeded(table);
}

adoptEffectPackages(effectPackages, shaderPrograms);

/** How much of the driver's log travels to the store, in characters. */
const REFUSE_REASON_MAX = 400;

/** Asks the store to set aside the packages this link failure can be attributed to. */
async function setAsideUnlinkable(before, after, log) {
  const held = new Map(before.map((p) => [p.id, p.rev]));
  const ids = after.filter((p) => held.get(p.id) !== p.rev).map((p) => p.id);
  if (ids.length === 0) return null;
  // On one line, because they land in a log where a newline is a new record.
  const line = String(log ?? '').replace(/[\s\p{Cc}\p{Cf}]+/gu, ' ').trim();
  const named = ids.length > 1 ? `one of ${ids.join(', ')}: ` : '';
  const reason = `${named}${line}`.slice(0, REFUSE_REASON_MAX);
  try {
    const res = await fetch('/effect-refusals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, reason }),
    });
    if (!res.ok) {
      console.warn(`could not set aside ${ids.join(', ')}: POST /effect-refusals answered ${res.status}`);
      return null;
    }
    const body = await res.json();
    const setAside = Array.isArray(body?.setAside) ? body.setAside : [];
    for (const skip of Array.isArray(body?.skipped) ? body.skipped : []) {
      console.warn(`the store kept ${skip?.id}: ${skip?.why}`);
    }
    return setAside.length ? setAside : null;
  } catch (err) {
    console.warn(`could not set aside ${ids.join(', ')}: ${err.message}`);
    return null;
  }
}

/** Every value on the page, project half and clip halves apart, as a rebuild has to put it back. */
const heldLook = () => {
  const perClip = [];
  forEachLook(() => perClip.push(params.values(scopeNames('clip'))));
  return {
    project: params.values(params.names().filter((n) => PARAMS[n].scope !== 'clip')),
    clips: perClip,
  };
};

/** The store read again, and everything on this page rebuilt from what it says. */
async function reloadEffects() {
  // Read from the live bindings before anything moves: these are what the renderer holds.
  const heldPackages = effectPackages;
  const heldPrograms = shaderPrograms;
  // Every value in flight, view state included, so an install does not move a slider. Split the
  // way the storage is: the project's half once and each clip's read through its own tables.
  const held = heldLook();
  let fetched;
  let programs;
  let open;
  try {
    fetched = await fetchEffectPackages();
  } catch (err) {
    const framed = `the installed effects changed and this page could not read them: ${err.message}`;
    throw err.effectRefusal ? effectRefusal(framed) : new Error(framed);
  }
  try {
    programs = assembleShaders(SPINES, fetched);
    open = serialiseProjectBody();
  } catch (err) {
    throw effectRefusal(`the installed effects changed and this page could not read them: ${err.message}`);
  }

  const blocked = effectRebuildBlocked();
  if (blocked) return null;

  // Whether the programs actually moved, decided before anything is swapped.
  const sameProgram = programs.cloud.vertexShader === heldPrograms.cloud.vertexShader
    && programs.cloud.fragmentShader === heldPrograms.cloud.fragmentShader
    && programs.grade.vertexShader === heldPrograms.grade.vertexShader
    && programs.grade.fragmentShader === heldPrograms.grade.fragmentShader;

  let failure = null;
  try {
    adoptEffectPackages(fetched, programs, held);
    // Compiled here rather than on the frame that first reaches them, which would stall it.
    if (!sameProgram) warmPrograms();
    restoreProject(open);
  } catch (err) {
    failure = err;
    try {
      adoptEffectPackages(heldPackages, heldPrograms, held);
      restoreProject(open);
    } catch (stuck) {
      // The corner with no repair: the document loaded onto neither registry.
      throw effectRefusal(
        'the installed effects changed, this page could not carry the open document across to them, '
        + `and it could not put itself back either - reload the page: ${stuck.message}`,
      );
    }
  }
  refreshGroups();
  requestRepaint();
  const setAside = failure?.shaderLinkFailure
    ? await setAsideUnlinkable(heldPackages, fetched, failure.linkLog)
    : null;
  // Thrown after the repaint, so the page the operator is looking at is the rolled-back one.
  if (failure) {
    throw effectRefusal(
      'the server installed the effects it was asked for, but this page could not carry the open '
      + `document across to them, so it is still running the effects it had: ${failure.message}`
      + (setAside
        ? ` (${setAside.join(', ')} set aside, so the next rebuild is without ${setAside.length > 1 ? 'them' : 'it'})`
        : ''),
    );
  }
  refusedEffectSignature = null;
  return fetched.map((p) => ({ id: p.id, version: p.manifest.version, rev: p.rev }));
}

/** Every client converges by polling, because one installing does not tell the others. */
const EFFECT_POLL_MS = 6000;
let effectReloading = false;

/** Runs a requested rebuild after the poll has released the effect set. */
async function requestEffectReload() {
  while (effectReloading) await new Promise((resolve) => setTimeout(resolve, 0));
  effectReloading = true;
  try {
    return await reloadEffects();
  } finally {
    effectReloading = false;
  }
}

/**
 * Why a document edit cannot happen right now, by name, or null.
 *
 * An export reads this document a frame at a time over minutes, so a write landing in the middle
 * of one changes the look halfway through the file being encoded - and the job record beside it,
 * serialised once when the sink is built, then describes a document that no longer exists.
 */
function editsBlocked() {
  if (exporting) return 'an export is running';
  return null;
}

/**
 * Declines a document edit and says why, or lets it through. Named for the gesture rather than
 * for the control that started it, because the sentence is what a person reads.
 *
 * A refusal has to be visible or it is worse than the corruption it prevents: a write that
 * silently does nothing is one the operator makes again, harder.
 */
function refuseEdit(what) {
  const why = editsBlocked();
  if (why === null) return false;
  say(`${what} is declined while ${why}: the file it is writing is this document`);
  return true;
}

/** How many document edits reached the document while an export was reading it. */
let editsDuringExport = 0;

/** Why a rebuild may not happen right now, by name, or null. */
function effectRebuildBlocked() {
  if (exporting) return 'an export is running';
  if (presetGesture) return 'a preset gesture is open';
  if (evaluating) return 'a track is being evaluated';
  return null;
}

// The last complaint, so a store answering the same nonsense is reported once.
let lastPollComplaint = null;

async function pollEffects() {
  // The guard goes up at the top of the tick, or two ticks overlap before the list lands.
  if (effectReloading || effectRebuildBlocked()) return;
  effectReloading = true;
  try {
    let listed;
    try {
      listed = await listEffects();
    } catch (err) {
      if (err.message !== lastPollComplaint) {
        lastPollComplaint = err.message;
        console.warn('could not read the installed effects:', err.message);
      }
      return;
    }
    lastPollComplaint = null;
    const listedSignature = revSignature(listed.effects);
    if (listedSignature === effectSignature) return;
    // The set this page has already failed to adopt, asked once rather than every six seconds.
    if (listedSignature === refusedEffectSignature) return;
    await pollRebuild(listedSignature);
  } finally {
    effectReloading = false;
  }
}

async function pollRebuild(listedSignature) {
  try {
    if (await reloadEffects() === null) return;
    say('the installed effects changed - this page has been rebuilt from them');
  } catch (err) {
    if (err.effectRefusal) refusedEffectSignature = listedSignature;
    console.warn('could not rebuild from the installed effects:', err.message);
    say(err.message);
  }
}
setInterval(pollEffects, EFFECT_POLL_MS);

const panelTabsEl = document.getElementById('panelTabs');
const panelTabButtons = [...panelTabsEl.querySelectorAll('.paneltab')];

/** Every group on screen shown or hidden by whether it belongs to the tab that is up. */
function hideOffTab() {
  const tab = activePanelTab;
  for (const group of document.querySelectorAll('#panelBody > [data-panel-tab]')) {
    group.hidden = group.dataset.panelTab !== tab;
  }
}

function setPanelTab(tab) {
  if (!['record', 'camera', 'framing', 'look', 'region'].includes(tab)) return false;
  activePanelTab = tab;
  for (const button of panelTabButtons) {
    button.setAttribute('aria-selected', String(button.dataset.panelTab === tab));
  }
  hideOffTab();
  document.getElementById('panelBody').scrollTop = 0;
  return true;
}

for (const button of panelTabButtons) {
  button.addEventListener('click', () => setPanelTab(button.dataset.panelTab));
}

function showInspector() {
  panelTabsEl.hidden = false;
  setPanelTab(activePanelTab);
}

if (!EDITING) setPanelTab(activePanelTab);

// Runs a bulk write without a repaint per value in it.
function withoutRepaint(write) {
  const outer = transportWriting;
  transportWriting = true;
  try {
    return write();
  } finally {
    transportWriting = outer;
    if (!outer) groupRevealChanged();
  }
}

function refuseDuringEvaluation(what) {
  if (evaluating) {
    throw new Error(`${what} during evaluation: a preset is a user action, not a track`);
  }
}

/** Copies a set of look values in. The only bulk write a user gesture performs. */
function applyPreset(preset) {
  refuseDuringEvaluation('preset applied');
  params.apply(preset);
}

// The export settings. Separate from the project, so one edit can spawn several.
const DELIVERABLE_VERSION = 2;

let activeDeliverable = null;

function ensureActiveDeliverable() {
  if (activeDeliverable) return;
  activeDeliverable = {
    version: DELIVERABLE_VERSION,
    in: 0,
    out: null,
    outputSize: openingSizeForAspect(projectAspect) ?? DEFAULT_EXPORT_SIZE,
    codec: 'h264',
    // Empty rather than the take's id: the field reads empty as that id, and
    // writing it freezes it.
    name: '',
  };
}

function setActiveDeliverable(deliverable) {
  activeDeliverable = deliverable;
}

function applyDeliverable(deliverable) {
  // Asked before anything is touched, so an unreadable document is refused whole.
  if (deliverable.version !== DELIVERABLE_VERSION) {
    const named = Number.isFinite(deliverable.outputFps)
      ? ` it was written at ${deliverable.outputFps}fps, which is the only record of that rate,`
      : '';
    throw new Error(
      `this deliverable is version ${JSON.stringify(deliverable.version)} and this build writes `
      + `${DELIVERABLE_VERSION}: the output rate lives on the project now, so a version 1 document `
      + `would render at a rate nothing on screen agrees with -${named} so set the rate in Project `
      + 'settings and save the deliverable again',
    );
  }
  clipBoundOrThrow(deliverable.in, 'in');
  clipBoundOrThrow(deliverable.out, 'out');
  if (!sameAspect(aspectOfSize(deliverable.outputSize), projectAspect)) {
    throw new Error(
      `this deliverable renders ${deliverable.outputSize}, which is not the ${projectAspect.join(':')} `
      + 'this project is framed at: the shape belongs to the edit, so change it in Project settings '
      + 'rather than through a deliverable',
    );
  }
  dropRateGesture();
  setActiveDeliverable(deliverable);
  setClipInOut({ in: deliverable.in, out: deliverable.out });
  setDeliverableSize(deliverable.outputSize);
  // The output name travels with the deliverable, so two cannot write over each other.
  if (ui.exportName) ui.exportName.value = deliverable.name ?? '';
  timingChanged();
  paintDeliverable();
  paintExportFormats();
  paintExportName();
}

/** A trim, then told to the deliverable, the readout beside it, and the transport. */
function setClipInOut(values) {
  // `null` rather than a duration when nothing is open: there is no program to hold it.
  writeClipRange(values, timeline ? timeline.duration : null);
  ensureActiveDeliverable();
  activeDeliverable.in = clipIn;
  activeDeliverable.out = clipOut;
  paintDeliverable();
  if (timeline) {
    // Compared on the output grid, because that is the only place the playhead can be.
    const frameIn = timeline.frameOf(clipIn);
    const frameOut = clipOut === null ? null : timeline.frameOf(clipOut);
    if (timeline.frame < frameIn) timeline.seek(clipIn).catch(showTimelineError);
    else if (frameOut !== null && timeline.frame > frameOut) timeline.seek(clipOut).catch(showTimelineError);
    else timeline.paint();
  }
}

const slerpA = new THREE.Quaternion();
const slerpB = new THREE.Quaternion();

function poseAt(keys, t) {
  const n = keys.length;
  if (n === 1) return keys[0].value;
  const i = keyBefore(keys, t);
  if (i < 0) return keys[0].value;
  if (i >= n - 1) return keys[n - 1].value;
  const a = keys[i];
  const b = keys[i + 1];
  const span = b.t - a.t;
  if (span <= 0) return b.value;
  // The ease handles, which make this a timing control rather than a second path editor.
  const u = easeAt(a.easeOut, b.easeIn, (t - a.t) / span);

  const position = [0, 1, 2].map((axis) => hermite(
    a.value.position[axis], b.value.position[axis],
    tangentAt(keys, i, axis), tangentAt(keys, i + 1, axis),
    span, u,
  ));

  // Slerp rather than a Catmull-Rom through the quaternions.
  slerpA.fromArray(a.value.quaternion);
  slerpB.fromArray(b.value.quaternion);
  slerpA.slerp(slerpB, u);

  return {
    position,
    quaternion: slerpA.toArray(),
    // A placement has no lens, so there is no fov to carry between its keys.
    ...(a.value.fov === undefined ? {} : { fov: a.value.fov + (b.value.fov - a.value.fov) * u }),
  };
}

class Track {
  constructor(name) {
    this.name = name;
    this.kind = params.spec(name).kind;
    this.keys = [];
  }

  get length() { return this.keys.length; }

  /** The key at `t`, within half an output frame, or null. */
  keyAt(t, tol) {
    for (const key of this.keys) if (Math.abs(key.t - t) <= tol) return key;
    return null;
  }

  /** Writes a key at `t`, replacing one already there. Returns it. */
  setKey(t, value, tol) {
    const existing = this.keyAt(t, tol);
    if (existing) {
      existing.value = value;
      return existing;
    }
    const key = { t, value, easeOut: copyHandle(EASE_OUT_LINEAR), easeIn: copyHandle(EASE_IN_LINEAR) };
    this.keys.push(key);
    this.sort();
    return key;
  }

  removeKey(key) {
    const i = this.keys.indexOf(key);
    if (i >= 0) this.keys.splice(i, 1);
  }

  sort() { this.keys.sort((x, y) => x.t - y.t); }

  valueAt(t) {
    if (this.kind === 'step') return stepAt(this.keys, t);
    // One slerp for both, because a placement is a pose without a lens.
    if (WORLD_KINDS.has(this.kind)) return poseAt(this.keys, t);
    return scalarAt(this.keys, t, HOLD_ENDS);
  }

  serialise() {
    return this.keys.map((k) => ({
      t: k.t, value: k.value, easeOut: copyHandle(k.easeOut), easeIn: copyHandle(k.easeIn),
    }));
  }
}

/**
 * Only tracks with keys exist. An empty one is a parameter with a single value.
 *
 * The tracks in play, routed by scope: a clip value's track belongs to whichever clip the look
 * is about and a project value's to the project. One object rather than two, because a reader
 * asking after a parameter by name has no business knowing which of the two holds it. What it is
 * deliberately not is every clip's tracks - `everyTrack` is that question and has its own name,
 * because a walk that answered both would evaluate one clip's keys through another's table.
 */
const tracks = {
  home: (name) => homeOf(specOf(name)).tracks,
  get(name) { return this.home(name).get(name); },
  has(name) { return this.home(name).has(name); },
  delete(name) { return this.home(name).delete(name); },
  clear() { lookOf().tracks.clear(); projectLook.tracks.clear(); },
  get size() { return lookOf().tracks.size + projectLook.tracks.size; },
  keys() { return [...lookOf().tracks.keys(), ...projectLook.tracks.keys()]; },
  values() { return [...lookOf().tracks.values(), ...projectLook.tracks.values()]; },
};

/** Every track in the document, clip by clip and then the project's. */
const everyTrack = () => [...clips.flatMap((clip) => [...clip.look.tracks.values()]),
  ...projectLook.tracks.values()];

function trackFor(name) {
  const home = tracks.home(name);
  let track = home.get(name);
  if (!track) {
    track = new Track(name);
    home.set(name, track);
  }
  return track;
}

function dropTrackIfEmpty(name) {
  const track = tracks.get(name);
  if (track && track.keys.length === 0) tracks.delete(name);
}

// Which groups you have overruled, and nothing else. Client state rather than document state.
const PANEL_GROUPS_OPEN = 'kinect.panelGroupsOpen';

const groupOverride = new Map();
try {
  // The string is checked before the parse: `getItem` answers null when nothing is stored.
  const saved = localStorage.getItem(PANEL_GROUPS_OPEN);
  if (saved !== null && saved.trim() !== '') {
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Each entry checked rather than the object adopted: a person can edit this file.
      for (const [key, want] of Object.entries(parsed)) {
        if (typeof want === 'boolean') groupOverride.set(key, want);
      }
    }
  }
} catch {
  // Private browsing, or an entry somebody has damaged. Every group answers for itself.
}

function storeGroupOverride() {
  try {
    localStorage.setItem(PANEL_GROUPS_OPEN, JSON.stringify(Object.fromEntries(groupOverride)));
  } catch {
    // Private browsing or policy again. The panel still collapses, it just will not remember.
  }
}

// Which installed effects are kept in the inspector. Panel state, not project state.
const EFFECT_RACKED = 'kinect.rackedEffects';
const rackedEffects = new Set();
try {
  const saved = localStorage.getItem(EFFECT_RACKED);
  if (saved !== null && saved.trim() !== '') {
    const parsed = JSON.parse(saved);
    if (Array.isArray(parsed)) {
      for (const id of parsed) if (typeof id === 'string' && id) rackedEffects.add(id);
    }
  }
} catch {
  // The values and tracks stay authoritative when storage is unavailable or damaged.
}

function storeRackedEffects() {
  try {
    localStorage.setItem(EFFECT_RACKED, JSON.stringify([...rackedEffects].sort()));
  } catch {
    // The rack still works for this page. Only the preference is lost on reload.
  }
}

function retainEffectFor(name) {
  const id = effectOf(name);
  if (!id || rackedEffects.has(id)) return;
  rackedEffects.add(id);
  storeRackedEffects();
}

function effectTouched(id) {
  return effectParamNames(id).some(paramTouched);
}

function effectPresent(id) {
  return rackedEffects.has(id) || effectTouched(id);
}

function effectGroups(id) {
  const keys = new Set(effectParamNames(id).map((name) => PARAMS[name].group));
  return PANEL_GROUPS.filter((group) => keys.has(group.key));
}

// The effect that owns a group, or null if the group is core or mixed.
function groupOwner(key) {
  const names = Object.keys(PARAMS).filter((n) => PARAMS[n].group === key);
  if (!names.length) return null;
  const ids = new Set(names.map(effectOf));
  if (ids.size !== 1) return null;
  const [id] = ids;
  return id;
}

function refreshEffectRack() {
  let moved = false;
  const installed = new Set(effectIds());
  for (const id of [...effectRackPainted.keys()]) {
    if (!installed.has(id)) effectRackPainted.delete(id);
  }
  for (const id of installed) {
    const present = effectPresent(id);
    if (effectRackPainted.get(id) === present) continue;
    effectRackPainted.set(id, present);
    for (const row of panelEffectRows.get(id) ?? []) row.hidden = !present;
    moved = true;
  }
  if (!moved) return;

  // A package group leaves with its last effect row. Mixed groups stay, being clip controls.
  for (const [key, node] of panelGroupElements) {
    const visible = (panelGroupParams.get(key) ?? []).some((name) => {
      const id = effectOf(name);
      return id === null || effectPresent(id);
    });
    node.classList.toggle('rackempty', !visible);
  }
}

function effectRackEntry(id) {
  const names = effectParamNames(id);
  const moved = names.filter((name) => params.get(name) !== groupDefaults.get(name));
  const keys = names.reduce((count, name) => count + (tracks.get(name)?.keys.length ?? 0), 0);
  return { names, moved, keys };
}

// Reading tuning rows appear only when their parent reading is active. Called whenever
// the readings change, which is every look write that touches one of them.
function refreshUnderRows() {
  for (const [parent, rows] of panelUnderRows) {
    const visible = params.get(parent) > 0;
    for (const row of rows) row.hidden = !visible;
  }
}

function addEffectToRack(id) {
  if (!effectInstalled(id)) return false;
  rackedEffects.add(id);
  storeRackedEffects();
  for (const group of effectGroups(id)) {
    if (!group.collapses) continue;
    groupOverride.set(group.key, true);
    groupOverrideDirty = true;
  }
  refreshPanel();
  paintEffectRackDialog();
  document.getElementById('effectRackSearch')?.focus();
  return true;
}

function removeEffectFromRack(id) {
  if (!effectInstalled(id)) return false;
  if (refuseEdit('taking ' + id + ' out of the rack')) return false;
  const { names } = effectRackEntry(id);
  rackedEffects.delete(id);
  storeRackedEffects();

  // Values and tracks leave as one document edit, from every clip: an effect taken out of the
  // rack that kept its values in the clips nobody was looking at would be written back out.
  withoutRepaint(() => {
    forEachLook((look) => {
      for (const name of names) {
        if (PARAMS[name].scope === 'clip') params.set(name, resetTarget(name));
        look.tracks.delete(name);
      }
    });
    for (const name of names) {
      if (PARAMS[name].scope !== 'clip') params.set(name, resetTarget(name));
      projectLook.tracks.delete(name);
    }
  });
  if (selection && names.includes(laneName(selection.owner))) selection = null;
  lanesChanged();
  requestRepaint();
  history.commit();
  paintEffectRackDialog();
  document.getElementById('effectRackSearch')?.focus();
  return true;
}

function paintEffectRackDialog() {
  const list = document.getElementById('effectRackList');
  const search = document.getElementById('effectRackSearch');
  if (!list || !search) return;
  const query = search.value.trim().toLocaleLowerCase();
  const packages = effectPackages
    .map((entry) => ({ id: entry.id, title: entry.manifest.title || entry.id }))
    .filter(({ id, title }) => !query
      || id.toLocaleLowerCase().includes(query)
      || title.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id));

  list.replaceChildren();
  if (packages.length === 0) {
    list.append(panelNode('div', 'effect-rack-empty', 'No installed effects match.'));
    return;
  }

  for (const { id, title } of packages) {
    const entry = effectRackEntry(id);
    const row = panelNode('div', 'effect-rack-row');
    row.dataset.effectRack = id;
    const name = panelNode('div', 'effect-rack-name');
    const detail = [];
    if (entry.moved.length) detail.push(`${entry.moved.length} changed`);
    if (entry.keys) detail.push(`${entry.keys} ${entry.keys === 1 ? 'key' : 'keys'}`);
    if (!detail.length) detail.push(`${entry.names.length} ${entry.names.length === 1 ? 'control' : 'controls'}`);
    name.append(panelNode('b', null, title), panelNode('small', null, `${id} · ${detail.join(' · ')}`));

    const actions = panelNode('div', 'effect-rack-actions');
    if (!effectPresent(id)) {
      const add = panelNode('button', 'dialog-secondary', 'add');
      add.type = 'button';
      add.dataset.effectAdd = id;
      add.setAttribute('aria-label', `add ${title} to the sidebar`);
      add.addEventListener('click', () => addEffectToRack(id));
      actions.append(add);
    } else {
      const remove = panelNode('button', 'dialog-secondary', 'remove');
      remove.type = 'button';
      remove.dataset.effectRemove = id;
      remove.setAttribute('aria-label', `remove ${title} from the sidebar`);
      remove.addEventListener('click', () => removeEffectFromRack(id));
      actions.append(remove);
    }
    row.append(name, actions);
    list.append(row);
  }
}


/** Whether a parameter carries evidence: keys on its track, or a value off the default. */
function paramTouched(name) {
  if ((tracks.get(name)?.keys.length ?? 0) > 0) return true;
  return params.get(name) !== groupDefaults.get(name);
}

/** A group stays open while it carries work or belongs to a racked effect. */
function revealsItself(key) {
  const names = panelGroupParams.get(key) ?? [];
  if (names.some(paramTouched)) return true;
  return names.some((name) => {
    const id = effectOf(name);
    return id !== null && rackedEffects.has(id);
  });
}

/** What the document says about a group, which is the derived half of whether it is open. */
function groupRevealed(group) {
  return group.reveals ? group.reveals() : revealsItself(group.key);
}

/** The predicate: what the document derives, unless a person has said otherwise. */
function groupIsOpen(group) {
  return groupOverride.get(group.key) ?? groupRevealed(group);
}

/** How often the panel has re-derived which groups are open, since boot. */
let groupRefreshes = 0;
let groupOverrideDirty = false;
// Where the store rule's two terms last stood, per group, read as `override/derived`.
const groupSeen = new Map();
function refreshGroups() {
  groupRefreshes++;
  for (const [key, { group, node, button }] of panelGroupNodes) {
    const inUse = groupRevealed(group);
    const want = groupOverride.get(key);
    const pair = `${want}/${inUse}`;
    const settled = groupSeen.get(key);
    if (settled !== undefined && settled !== pair && want === inUse) {
      groupOverride.delete(key);
      groupOverrideDirty = true;
    }
    groupSeen.set(key, `${groupOverride.get(key)}/${inUse}`);
    // Nothing here may author an override.
    const open = groupIsOpen(group);
    const state = `${open}/${inUse}`;
    if (groupPainted.get(key) === state) continue;
    groupPainted.set(key, state);

    node.classList.toggle('shut', !open);
    button.setAttribute('aria-expanded', String(open));
    button.setAttribute('aria-label', `${open ? 'collapse' : 'expand'} ${group.label}`);
  }
  // Once at the end and only where the map moved, since `setItem` serialises the whole thing.
  if (groupOverrideDirty) {
    groupOverrideDirty = false;
    storeGroupOverride();
  }
}

function toggleGroup(key) {
  const entry = panelGroupNodes.get(key);
  if (!entry) return;
  groupOverride.set(key, !groupIsOpen(entry.group));
  groupOverrideDirty = true;
  refreshGroups();
}

/**
 * Every clip-scope control written from the clip the panel is editing.
 *
 * A value write already moves its own control through `writeControl`; this is the other half -
 * the values did not move, the clip under them did, so every one of them has to be re-read.
 */
function paintClipPanel() {
  for (const name of scopeNames('clip')) {
    if (editedInWorld(name)) continue;
    writeControl(name, params.get(name));
  }
  for (const [name, btn] of keyButtons) paintKeyButton(name, btn);
  paintPanelScope();
  refreshPanel();
}

/** Greys the clip half of the panel while the strip has no clip selected. */
function paintPanelScope() {
  for (const name of scopeNames('clip')) {
    const el = panelControls.get(name);
    if (!el) continue;
    const live = rowLive(name);
    el.disabled = !live;
    keyButtons.get(name)?.toggleAttribute('disabled', !live);
    // Through the reset's own painter, so its enabled state stays one rule rather than two.
    refreshReset(name, params.get(name));
    const row = el.closest('.row, .checkrow');
    if (row) row.dataset.scopeOff = live ? 'no' : 'yes';
  }
}

function refreshPanel() {
  refreshEffectRack();
  refreshUnderRows();
  refreshGroups();
}

groupRevealChanged = refreshPanel;
refreshPanel();

// Every track written through the one door, at one program position.
let borrowed = null;

/**
 * The program second a parameter's keys are measured from: its clip's in-point for everything a
 * clip owns, and the head of the edit for the project's own tracks and for no clip at all.
 *
 * Everything inside a clip travels with it. Drag a clip along the strip and the placement, the
 * grade and the crop it was keyed with have to arrive with it, so a key stamped at an absolute
 * program second would stay where the clip used to be. The boundary is scope and not what the
 * parameter does: the post chain and the camera belong to the edit rather than to any clip.
 */
const trackEpoch = (name, clip) => (specOf(name).scope === 'clip' && clip ? clip.start : 0);

function evaluateTracks(t) {
  const write = (track, epoch) => {
    if (track.keys.length === 0) return;
    if (borrowed && borrowed.has(track.name)) return;
    params.set(track.name, track.valueAt(t - epoch));
  };
  withoutRepaint(() => {
    // Each clip's own look through its own tables, and then the project's once. Every clip and
    // not only the drawn ones: an idle clip's values are what the panel shows the moment it is
    // selected, and a track evaluated only while its clip was on screen would jump on selection.
    for (const clip of clips) {
      if (clip.look.tracks.size === 0) continue;
      withClip(clip, () => {
        for (const track of clip.look.tracks.values()) write(track, trackEpoch(track.name, clip));
      });
    }
    for (const track of projectLook.tracks.values()) write(track, 0);
  });
}

/**
 * What a parameter is worth at a program position rather than right now.
 *
 * The clip is explicit because a clip value now belongs to one: `fade` at a program position is a
 * question about which clip is being asked, and answering it off the selection would give one
 * clip's persistence to another's pre-roll.
 */
function valueAtProgram(name, t, clip = null) {
  const spec = specOf(name);
  const on = spec.scope === 'clip' ? (clip ?? clipOfLook()) : null;
  const look = on ? on.look : homeOf(spec);
  const track = look.tracks.get(name);
  if (!track || track.keys.length === 0) {
    const held = look.values.get(name);
    // Copied rather than handed out, because a caller writing into a pose would move the value.
    return WORLD_KINDS.has(spec.kind)
      ? { ...held, position: [...held.position], quaternion: [...held.quaternion] } : held;
  }
  return params.normalise(name, track.valueAt(t - trackEpoch(name, on)));
}

// How near an existing key has to be to count as the same key: half an output frame.
const playheadSec = () => (timeline ? timeline.programSec : 0);
const keyTolerance = () => 0.5 / (timeline ? timeline.outputFps : 30);

/** Where the playhead falls on a parameter's own clock, which for a clip's own is its clip's. */
const keyPlayhead = (name) => playheadSec() - trackEpoch(name, clipOfLook());

/** A parameter written from its control. With keys, this writes the key at the playhead. */
function writeFromControl(name, value) {
  if (refuseEdit(`a change to ${name}`)) {
    writeControl(name, params.get(name));
    return;
  }
  retainEffectFor(name);
  const applied = params.set(name, value);
  const track = tracks.get(name);
  if (track && track.keys.length > 0) {
    track.setKey(keyPlayhead(name), applied, keyTolerance());
    lanesChanged();
  }
}

/** Adds a key at the playhead, or removes the one already there. */
function toggleKey(name) {
  if (refuseEdit('keying ' + name)) return;
  retainEffectFor(name);
  const track = trackFor(name);
  const existing = track.keyAt(keyPlayhead(name), keyTolerance());
  if (existing) {
    track.removeKey(existing);
    dropTrackIfEmpty(name);
  } else {
    // The current value, so planting the first key on a track never changes the image.
    track.setKey(keyPlayhead(name), params.get(name), keyTolerance());
  }
  lanesChanged();
  requestRepaint();
  history.commit();
}

/**
 * The values and tracks of effects this build lacks, as the document wrote them, kept under the
 * block each one arrived in. A build without the effect cannot know where its values belong -
 * `bind.on` is in the manifest it has not got - so the document's own placement is the only
 * statement of it, and a pool that forgot it would save a grade effect into a clip.
 */
let parkedRequires = [];

/** Every parked value, or every parked track, for the readers that do not care which block. */
const parkedWhole = (kind) => Object.assign(
  {},
  ...clips.map((clip) => clip.look.parked[kind]),
  bootLook.parked[kind],
  projectLook.parked[kind],
);

/** The effects the document was authored against at a version not installed here. */
let effectVersionSkew = [];

/** What the operator has said to render without. Session state, not in the document. */
let suppressedEffects = new Set();

/** One block of the parked pool, less anything the registry has since started answering for. */
const writableParkedBlock = (block) => ({
  params: Object.fromEntries(Object.entries(block.params).filter(([n]) => isParkedName(n))),
  tracks: Object.fromEntries(Object.entries(block.tracks).filter(([n]) => isParkedName(n))),
});

/** The parked requires list less anything the registry has since started answering for. */
const writableRequires = () => parkedRequires.filter((entry) => !effectInstalled(entry.id));

/**
 * One scope's look values and tracks, in the params/tracks shape a clip and the project block
 * share. The save rule is asked per effect within the block, so an effect binding both the cloud
 * and the grade answers it once in each rather than being dropped from one on the other's values.
 */
function serialiseLookBlock(scope, parked, look) {
  const names = scopeNames(scope);
  const values = Object.fromEntries(names.map((n) => [n, look.values.get(n)]));
  // The save rule: an effect held at defaults with nothing keyed is not a use of it.
  for (const id of effectIdsIn(names)) {
    const mine = names.filter((n) => effectOf(n) === id);
    // A reading package stays whole even at its defaults. Version 7 requires all five reading
    // weights, and a document that sheds three because they moved behind package ids is a
    // document this same build refuses on restore.
    if (mine.some((n) => PARAMS[n].reading)) continue;
    const keyed = mine.some((n) => look.tracks.get(n)?.keys.length);
    const moved = mine.some((n) => values[n] !== PARAMS[n].def);
    if (keyed || moved) continue;
    for (const n of mine) delete values[n];
  }
  const kept = Object.keys(values);
  return {
    kept,
    block: {
      // Look parameters only, so a snapshot or a render job carries no camera and no scale.
      params: { ...values, ...parked.params },
      tracks: {
        ...Object.fromEntries(
          kept
            .filter((n) => look.tracks.has(n))
            .map((n) => [n, look.tracks.get(n).serialise()]),
        ),
        ...parked.tracks,
      },
    },
  };
}

/** `suppressed` is for the export path: a render records which effects it went without. */
function serialiseProjectBody({ suppressed = null } = {}) {
  const perProject = serialiseLookBlock(
    'project', writableParkedBlock(projectLook.parked), projectLook,
  );
  const perClip = clips.map((clip) => serialiseLookBlock(
    'clip', writableParkedBlock(clip.look.parked), clip.look,
  ));
  const requires = [
    ...requiresFor([...perClip.flatMap((b) => b.kept), ...perProject.kept]),
    ...writableRequires(),
  ];
  return {
    version: PROJECT_VERSION,
    ...(requires.length ? { requires } : {}),
    ...(suppressed ? { suppressed } : {}),
    // The terms that write the post chain, which is the project's however many clips draw into it.
    look: perProject.block,
    composition: {
      camera: projectLook.tracks.get('camera')?.serialise() ?? [],
    },
    clips: clips.map((clip, at) => ({
      id: clip.id,
      take: clip.take ? { ...clip.take } : null,
      start: clip.start,
      // The trim, and null where this clip runs for everything its footage affords. Written and
      // read back as the same fact, which is where the edit stops using the take.
      length: clip.trim,
      speed: clip.speed,
      sourceStart: clip.sourceStart,
      appliedPreset: clip.appliedPreset,
      // This clip's own look, read off its own tables. Two clips of one project hold two of
      // these and they are allowed to disagree, which is what makes a clip's look its own.
      params: perClip[at].block.params,
      tracks: perClip[at].block.tracks,
    })),
    // The framing the clip was composed for, as the shape rather than as a size.
    aspect: [...projectAspect],
    // Off the deliverable because it is not free: `trails` is counted in output frames.
    outputFps: timeline ? timeline.outputFps : 30,
  };
}

/** A key as it arrives from outside, checked into a key this editor can hold. */
function restoreKey(owner, k, kind) {
  if (!Number.isFinite(k?.t)) {
    throw new Error(`${owner} has a key at t=${JSON.stringify(k?.t)}: a key time has to be a finite number`);
  }
  const [loY, hiY] = KINDS[kind].overshoots ? [-1, 2] : [0, 1];
  const handle = (side, points, fallback) => {
    if (points === undefined) return copyHandle(fallback);
    const ok = Array.isArray(points)
      && points.length >= 1 && points.length <= SEGMENT_POINT_CEILING
      && points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
    if (!ok) {
      throw new Error(`${owner}'s key at ${k.t}s has a ${side} handle of ${JSON.stringify(points)}: it takes `
        + `1 to ${SEGMENT_POINT_CEILING} control points, each two finite numbers`);
    }
    const why = handleRefusal(points, loY, hiY);
    if (why) {
      throw new Error(`${owner}'s key at ${k.t}s has a ${side} handle with ${why}`);
    }
    return copyHandle(points);
  };
  return {
    t: k.t,
    value: k.value,
    easeOut: handle('easeOut', k.easeOut, EASE_OUT_LINEAR),
    easeIn: handle('easeIn', k.easeIn, EASE_IN_LINEAR),
  };
}

/** Refuses a restored track whose timing curve folds, one segment at a time. */
function refuseFolds(owner, keys) {
  for (let i = 0; i + 1 < keys.length; i++) {
    if (keys[i + 1].t < keys[i].t) {
      throw new Error(`${owner} holds a key at ${keys[i + 1].t}s after one at ${keys[i].t}s: keys are `
        + 'stored ascending, and the binary search the evaluators run over this track answers '
        + 'wrongly rather than failing on one that is not');
    }
    if (keys[i + 1].t === keys[i].t) continue;
    const why = foldRefusal(keys[i].easeOut, keys[i + 1].easeIn);
    if (why) {
      throw new Error(`${owner}'s segment between ${keys[i].t}s and ${keys[i + 1].t}s has ${why}`);
    }
  }
}

/** What a clip's take looks like on the wire: an id as a label beside the hash it is joined on. */
const TAKE_HASH = /^sha256:[0-9a-f]{64}$/;

/** One preset stamp held to its shape, as a sentence or null. */
function stampRefusal(what, stamp) {
  if (stamp === null) return null;
  if (typeof stamp?.name !== 'string' || typeof stamp?.rev !== 'string') {
    return `${what}'s appliedPreset is ${JSON.stringify(stamp)}: it is null, or a name and a rev`;
  }
  return null;
}

/**
 * One params/tracks block read whole: its values checked against the registry, its tracks
 * restored, and everything belonging to an effect this build has not got set aside. A clip and
 * the project's look block are the same shape, so this is asked of each at its own scope.
 */
function checkLookBlock(what, block, scope) {
  if (!block.params || typeof block.params !== 'object' || Array.isArray(block.params)) {
    throw new Error(`${what} carries a params object`);
  }
  if (!block.tracks || typeof block.tracks !== 'object' || Array.isArray(block.tracks)) {
    throw new Error(`${what} carries a tracks object, empty if nothing is keyed`);
  }
  // Where the missing-effect split happens, as one predicate rather than a special case.
  const names = [...Object.keys(block.params), ...Object.keys(block.tracks)];
  const parkedNames = new Set(names.filter(isParkedName));

  // A parked name's scope is unknowable here by construction - the manifest declaring where it
  // binds is the thing this build has not got - so only names the registry answers for are asked.
  for (const name of names) {
    if (parkedNames.has(name)) continue;
    // One guard for both wrong homes, because only a look value has a scope at all: a view or a
    // composition parameter reads as null here and is refused by the same comparison.
    const spec = params.spec(name);
    if (spec.scope !== scope) {
      throw new Error(
        `${what} carries ${JSON.stringify(name)}, which is ${spec.scope === null
          ? `a ${spec.tag} parameter rather than a look value at all`
          : `a ${spec.scope} value`}: a ${scope} block carries what writes `
        + `${scope === 'clip' ? 'the cloud one clip draws with' : 'the post chain every clip shares'}, `
        + 'and a value from the other block would come back applied at the wrong scope - or, off '
        + 'the look tag entirely, evaluated by resizing the drawing buffer from inside the render loop',
      );
    }
  }

  // Every parameter of an effect this block uses, or the ones it left out come back as defaults.
  for (const id of effectIdsIn(names).filter((n) => effectInstalled(n))) {
    const short = effectParamNames(id)
      .filter((n) => PARAMS[n].scope === scope && !Object.hasOwn(block.params, n));
    if (short.length) {
      throw new Error(
        `${what} names part of ${id} but not ${short.join(', ')}: a document carries every `
        + 'parameter of an effect it uses, and the ones it leaves out would come back as defaults '
        + 'rather than as the look it was saved with',
      );
    }
  }

  // Built whole first, so a project that fails halfway leaves the editor on its own clip.
  const restored = [];
  const parked = { params: {}, tracks: {} };
  for (const [name, keys] of Object.entries(block.tracks)) {
    if (!Array.isArray(keys)) throw new Error(`${what}'s track ${name} is not an array of keys`);
    // A track under a missing effect is parked before it is asked anything.
    if (parkedNames.has(name)) {
      parked.tracks[name] = keys;
      continue;
    }
    if (keys.length === 0) continue;
    const owner = `track ${name}`;
    const ready = keys.map((k) => {
      const key = restoreKey(owner, k, params.spec(name).kind);
      key.value = params.normalise(name, key.value);
      return key;
    });
    refuseFolds(owner, ready);
    restored.push([name, ready]);
  }

  const applied = {};
  for (const [name, value] of Object.entries(block.params)) {
    if (parkedNames.has(name)) {
      parked.params[name] = value;
      continue;
    }
    // Held to its spec here rather than where it is written: `params.apply` normalises too, and
    // by the time it runs `applyProject` has already reset the look and applied every earlier
    // clip's - so a value refused there leaves the editor holding parts of two documents.
    applied[name] = params.normalise(name, value);
  }
  return { names, applied, tracks: restored, parked };
}

/**
 * A document read whole and held to every rule this build has, as the plan `applyProject` runs.
 * Nothing here touches the page or the network, so a document is accepted or refused in full
 * before a clip's footage is fetched rather than half-adopted around a failing request.
 */
function checkProject(project) {
  if (!project || typeof project !== 'object') {
    throw new Error(`a project is an object, got ${JSON.stringify(project)}`);
  }
  // The version gate first, because everything below it is interpreted in the version.
  if (project.version !== PROJECT_VERSION) {
    throw new Error(versionRefusal('this project', project.version));
  }
  if (!project.look || typeof project.look !== 'object' || Array.isArray(project.look)) {
    throw new Error('a project carries a look object');
  }
  if (!project.composition || typeof project.composition !== 'object') {
    throw new Error('a project carries a composition object');
  }
  if (!Array.isArray(project.clips) || project.clips.length === 0) {
    throw new Error(
      `a project carries a clips array with at least one clip in it, got ${JSON.stringify(project.clips)}`,
    );
  }
  // The ids first, because uniqueness is a property of the array rather than of a clip - and
  // because asking after the ceiling would put a refusal behind one nothing can get past.
  const seenIds = new Set();
  for (const [at, clip] of project.clips.entries()) {
    if (!clip || typeof clip !== 'object' || Array.isArray(clip)) {
      throw new Error(`the clip at position ${at} is ${JSON.stringify(clip)}: a clip is an object`);
    }
    if (typeof clip.id !== 'string' || !VALID_ID.test(clip.id)) {
      throw new Error(
        `the clip at position ${at} has an id of ${JSON.stringify(clip.id)}: a clip id is a `
        + 'path-safe name, and it is what the lane owners, the selection and the panel name a '
        + 'clip by rather than its place in the array',
      );
    }
    if (seenIds.has(clip.id)) {
      throw new Error(
        `this project holds two clips called ${JSON.stringify(clip.id)}: an id names one clip, and `
        + 'a repeat would give one clip\'s tracks and selection to the other',
      );
    }
    seenIds.add(clip.id);
  }
  if (project.clips.length > CLIP_CEILING) {
    throw new Error(
      `this project holds ${project.clips.length} clips and this build composites ${CLIP_CEILING}: `
      + 'it was cut on a build that draws more, and rendering the clips this one understands would '
      + 'publish a shorter edit under the same name rather than fail',
    );
  }
  const aspectShape = Array.isArray(project.aspect) && project.aspect.length === 2
    // `isSafeInteger` rather than `isInteger`: above 2^53 the integers stop being distinct.
    && project.aspect.every((n) => Number.isSafeInteger(n) && n > 0);
  if (project.aspect !== undefined && !aspectShape) {
    throw new Error(`aspect is ${JSON.stringify(project.aspect)}: it reads as [width, height] in whole positive numbers`);
  }
  // Still checked because a project written before the shape moved still reads it.
  if (project.outputSize !== undefined && !/^[1-9][0-9]*x[1-9][0-9]*$/.test(String(project.outputSize))) {
    throw new Error(`outputSize is ${JSON.stringify(project.outputSize)}: it reads as WIDTHxHEIGHT`);
  }
  // A shape with no resolution to offer is refused, which stops a document becoming a trap.
  const framedAt = project.aspect
    ?? (project.outputSize === undefined ? defaultAspect() : aspectOfSize(String(project.outputSize)));
  const framedShape = reduceAspect(framedAt[0], framedAt[1]);
  if (sizesForAspect(framedShape).length === 0) {
    throw new Error(
      `this project is framed at ${framedShape.join(':')}, which this build offers no resolution for - `
      + `it renders ${exportAspects().map((a) => a.ratio).join(', ')}, so there is no size to `
      + 'export it at and no menu entry to pick one from',
    );
  }
  // Against the list the control is built from, so a document naming 25 is refused.
  if (project.outputFps !== undefined && !OUTPUT_RATES.includes(project.outputFps)) {
    throw new Error(
      `outputFps is ${JSON.stringify(project.outputFps)}: this build offers ${OUTPUT_RATES.join(', ')}`,
    );
  }

  // The clip blocks first and the project block second, so the parked pool and the requires list
  // this builds are in the order the serialiser writes them back out in.
  const plannedClips = [];
  for (const clip of project.clips) {
    const what = `clip ${clip.id}`;
    const take = clip.take ?? null;
    if (take === null) {
      // The editor's rule and not the format's: the recorder draws the live stream and its own
      // save writes `take: null`, so a document refused here is one only the editor cannot hold.
      if (EDITING) {
        throw new Error(
          `${what} names no take: a clip with nothing to draw is not a clip this editor can hold, `
          + 'and the composite would reach a clip pointed at no footage rather than refuse it',
        );
      }
    } else {
      const shaped = typeof take === 'object' && !Array.isArray(take)
        && typeof take.id === 'string' && VALID_ID.test(take.id)
        && typeof take.hash === 'string' && TAKE_HASH.test(take.hash);
      if (!shaped) {
        throw new Error(
          `${what} names its take as ${JSON.stringify(take)}: a take is an id and a sha256 content `
          + 'hash, and it is the hash that is joined on because a rename moves the id',
        );
      }
    }
    if (!Number.isFinite(clip.start) || clip.start < 0) {
      throw new Error(`${what} starts at ${JSON.stringify(clip.start)}: a clip starts at a finite number of project seconds, at or after zero`);
    }
    // A trim, and read back as the answer. It is where the edit stops using the take, which is
    // a different fact from how much take there is rather than a second spelling of it; null is
    // a clip that runs for everything its footage affords.
    if (clip.length !== null && (!Number.isFinite(clip.length) || clip.length < 0)) {
      throw new Error(`${what} is ${JSON.stringify(clip.length)} long: a length is a number of project seconds at or above zero, or null where the document states none`);
    }
    if (!usableClipRate(clip.speed)) {
      throw new Error(`${what} runs at ${JSON.stringify(clip.speed)}: a clip's speed is a number from ${RATE_MIN} to ${RATE_MAX}`);
    }
    // The in-point: where in the take this clip starts. Zero is an untrimmed head, and a
    // negative one would ask for footage from before the take began.
    if (!Number.isFinite(clip.sourceStart) || clip.sourceStart < 0) {
      throw new Error(`${what} starts at source ${JSON.stringify(clip.sourceStart)}: a clip's in-point is a finite number of source seconds, at or after zero`);
    }
    const stampWhy = stampRefusal(what, clip.appliedPreset ?? null);
    if (stampWhy) throw new Error(stampWhy);

    const look = checkLookBlock(what, clip, 'clip');
    const shortReadings = missingReadings(clip.params);
    if (shortReadings.length) {
      throw new Error(
        `${what} names no ${shortReadings.join(', ')}: a version ${PROJECT_VERSION} clip carries `
        + 'all five reading weights, and the ones it leaves out would come back as defaults rather '
        + 'than as the look it was saved with',
      );
    }

    plannedClips.push({
      id: clip.id,
      take: take === null ? null : { id: take.id, hash: take.hash },
      start: clip.start,
      trim: clip.length ?? null,
      appliedPreset: clip.appliedPreset ?? null,
      speed: clip.speed,
      sourceStart: clip.sourceStart,
      look,
    });
  }

  const forProject = checkLookBlock('this project look', project.look, 'project');

  // Paired with its scope rather than read off its position, so the walk below cannot put a
  // block's parked keys under the wrong one by counting.
  const blocks = [...plannedClips.map((c) => ['clip', c.look]), ['project', forProject]];
  refuseRequires('this project', project.requires, blocks.flatMap(([, b]) => b.names));

  // Each clip's look stays its clip's. There is no union any more, and that is the whole of what
  // making a clip's look its own comes to: the blocks are allowed to disagree, so a value read
  // out of one clip's block and applied to another would be a look nobody authored.
  const parked = {
    clip: { params: {}, tracks: {} },
    project: { params: {}, tracks: {} },
    requires: [],
  };
  for (const [scope, block] of blocks) {
    Object.assign(parked[scope].params, block.parked.params);
    Object.assign(parked[scope].tracks, block.parked.tracks);
  }
  const parkedIds = [...new Set(
    [...Object.keys(parked.clip.params), ...Object.keys(parked.clip.tracks),
      ...Object.keys(parked.project.params), ...Object.keys(parked.project.tracks)].map(effectOf),
  )];
  parked.requires = parkedIds.map((id) => (project.requires ?? []).find((e) => e.id === id));
  const versionSkew = (project.requires ?? [])
    .filter((e) => typeof e?.id === 'string' && effectInstalled(e.id))
    .map((e) => ({ id: e.id, wanted: e.version, installed: versionOf(e.id) }))
    .filter((e) => e.wanted !== e.installed);

  if (!Array.isArray(project.composition.camera)) {
    throw new Error('a project composition carries a camera track as an array of keys');
  }
  const camera = project.composition.camera.map((k) => {
    const key = restoreKey('track camera', k, params.spec('camera').kind);
    key.value = params.normalise('camera', key.value);
    return key;
  });
  refuseFolds('track camera', camera);

  // A deliverable's document carries what its render went without. Checked, then left alone.
  if (project.suppressed !== undefined) {
    const ok = Array.isArray(project.suppressed) && project.suppressed.every((e) => e
      && typeof e === 'object' && !Array.isArray(e)
      && typeof e.id === 'string' && /^[a-z][a-z0-9]*$/.test(e.id)
      && typeof e.version === 'string' && e.version.length > 0);
    if (!ok) {
      throw new Error(
        `this project carries ${JSON.stringify(project.suppressed)} where its suppressed list belongs: `
        + 'it is a list of { id, version } entries naming the effects a render was allowed to go '
        + 'without, and it is a record of that render rather than anything this editor adopts',
      );
    }
  }

  return {
    project,
    clips: plannedClips,
    // The project's own half, and the only half that is not per clip.
    projectLook: forProject,
    camera,
    parked,
    parkedIds,
    versionSkew,
  };
}

/**
 * A checked plan written onto the page. Nothing here refuses, so the only way to reach a
 * half-adopted document is to have skipped `checkProject`. `sources` carries the footage a clip
 * changing take has already had opened for it, keyed by its place in the array.
 */
/**
 * The clip array grown or shrunk to what a document holds, each new clip with a cloud of its own.
 *
 * A dropped clip's cloud is released rather than left in the scene: two float targets and four
 * textures per clip is what a session that opens several edits would otherwise leak.
 */
function fitClipCount(want) {
  while (clips.length < want) {
    clips.push(new Clip(mintClipId(), livePairs, createClipCloud()));
  }
  while (clips.length > want) {
    const gone = clips.pop();
    if (gone === selectedClip) selectClip(clips[0]);
    disposeCloudInstance(gone.cloud);
  }
  selectCloud(selectedClip.cloud);
  orderClips();
}

function applyProject(plan, sources = null) {
  documentGeneration++;
  const project = plan.project;
  // Read before the refit, because the refit is what can take the selected clip away.
  const wasSelected = clipRow?.id ?? null;
  // Before the look is written, because a look reaches every clip and a clip made after it would
  // come up on the registry's defaults instead.
  fitClipCount(plan.clips.length);
  // Defaults first, so an absent key means the default rather than what the session left.
  const legacySize = project.outputSize === undefined ? null : String(project.outputSize);
  if (legacySize !== null && project.aspect === undefined) {
    ensureActiveDeliverable();
    activeDeliverable.outputSize = legacySize;
  }
  setProjectAspect(
    project.aspect ?? (legacySize === null ? defaultAspect() : aspectOfSize(legacySize)),
    { fromDocument: true },
  );

  // `timeline.frame` counts output frames, so a new rate moves it unless it is held.
  if (timeline) {
    const held = timeline.programSec;
    timeline.outputFps = project.outputFps ?? 30;
    timeline.frame = timeline.frameAt(held);
  }

  // The project's half first, and its own tables. `params.reset` walks the write path, so it
  // reaches the post chain the same way a slider does.
  projectLook.tracks.clear();
  params.reset(scopeNames('project'));
  params.apply(plan.projectLook.applied);
  for (const [name, keys] of plan.projectLook.tracks) trackFor(name).keys = keys;
  projectLook.parked = plan.parked.project;
  trackFor('camera').keys = plan.camera;

  parkedRequires = plan.parked.requires;
  effectVersionSkew = plan.versionSkew;
  // Pruned rather than cleared, because undo arrives here too.
  suppressedEffects = new Set([...suppressedEffects].filter((id) => plan.parkedIds.includes(id)));
  paintMissingEffects();

  for (const [at, planned] of plan.clips.entries()) {
    const clip = clips[at];
    clip.id = planned.id;
    // This clip's own look, into this clip's own tables. Nothing is shared and nothing is
    // merged: two clips of one project are allowed to disagree about every value here.
    withClip(clip, () => {
      clip.look.tracks.clear();
      params.reset(scopeNames('clip'));
      params.apply(planned.look.applied);
      for (const [name, keys] of planned.look.tracks) trackFor(name).keys = keys;
    });
    clip.look.parked = planned.look.parked;
    // Only clips whose footage or route label changed are repointed, and the id they come back holding is
    // the one the hash resolved to: a document names its take by hash and carries the id as a
    // label, so adopting the document's copy would put a name the take has been renamed out of
    // in front of every route that asks for it by id.
    const opened = sources?.get(at) ?? null;
    if (opened) adoptSource(clip, opened);
    clip.start = planned.start;
    clip.trim = planned.trim;
    clip.appliedPreset = planned.appliedPreset;
    clip.speed = planned.speed;
    clip.sourceStart = planned.sourceStart;
  }
  releaseUnusedFrames();
  orderClips();
  // An undo rebuilds every clip in place, so a selection usually survives one, and it is re-found
  // by the id it named rather than by the object holding it: `fitClipCount` grows and shrinks at
  // the tail only, so restoring a document that had a middle clip appends an object and re-labels
  // every one past the deletion point. An identity test survives that rewrite and the selection
  // silently becomes the clip that inherited the slot. A document that dropped the clip the strip
  // was on leaves it holding a clip this edit no longer has, which `deleteSelectedClip` would
  // then splice by an index of -1 - so that one is dropped rather than moved. Dropped and not
  // re-chosen: choosing is what the two doors above do.
  clipRow = wasSelected === null ? null : (clips.find((clip) => clip.id === wasSelected) ?? null);
  // The render core moves with the strip or the panel greys one clip and reads another's values:
  // a clip-scope write goes to `selectedClip`, and `selectClipRow` is the only other writer that
  // keeps the two pointing at the same clip.
  if (clipRow) selectClip(clipRow);
  paintClipPanel();
  paintGizmo();

  timingChanged();
}

/** Refuses a checked plan whose resolved clip end cannot be enumerated as output frames. */
function refuseResolvedDurations(plan, sources) {
  const fps = plan.project.outputFps ?? 30;
  for (const [at, planned] of plan.clips.entries()) {
    const source = sources.get(at)?.take ?? clips[at]?.source;
    if (!source || source.streaming) continue;
    const sourceDuration = source.duration ?? source.times?.[source.times.length - 1];
    // Ahead of the arithmetic below, which would answer a length of zero for this and call it
    // resolved: an in-point past the end of the footage leaves the clip nothing to draw.
    if (planned.sourceStart >= sourceDuration) {
      throw new Error(
        `clip ${planned.id} starts at source ${planned.sourceStart}s in ${sourceDuration}s of `
        + 'footage: nothing of the take is left after its in-point',
      );
    }
    const length = planned.trim
      ?? clipAffordedSec({ speed: planned.speed, sourceStart: planned.sourceStart }, sourceDuration);
    const end = planned.start + length;
    if (!Number.isFinite(length) || !Number.isFinite(end)) {
      throw new Error(
        `clip ${planned.id} ends at ${String(end)} after resolving ${sourceDuration}s of footage: `
        + 'its start, trim, speed and in-point must produce a finite project duration',
      );
    }
    const lastFrame = Math.floor(end * fps);
    if (!Number.isSafeInteger(lastFrame)) {
      throw new Error(
        `clip ${planned.id} ends at ${end}s, output frame ${lastFrame} at ${fps}fps: the timeline `
        + 'enumerates frames as JavaScript integers, so its last frame must be a safe integer',
      );
    }
  }
}

/**
 * The synchronous door a document comes through when the footage is already open: the hotload
 * rollback, undo, and every proof tool that hands a document straight back. A clip naming
 * footage this page does not hold open is refused rather than fetched, because those three
 * callers cannot await and a restore that half-applied would leave the page on no document.
 *
 * Naming footage that is open but in another slot is not that case, and it is what the undo of a
 * delete is: the clip array grows back and the slot that reappeared is re-pointed from the take
 * rather than refused. `releaseUnusedFrames` is what makes that hold - a take a clip stopped
 * using loses its frames and keeps its index.
 */
function restoreProject(project) {
  const plan = checkProject(project);
  const sources = new Map();
  for (const [at, planned] of plan.clips.entries()) {
    const held = clips[at]?.source?.index?.hash ?? null;
    if ((planned.take?.hash ?? null) === held) continue;
    const open = planned.take ? takeOpenedAs(planned.take.hash) : null;
    if (open) {
      sources.set(at, open);
      continue;
    }
    throw new Error(
      `clip ${planned.id} is cut on ${planned.take ? `${planned.take.id} (${planned.take.hash.slice(0, 22)}…)` : 'no take'} `
      + `and this page holds ${held === null ? 'no take' : `${held.slice(0, 22)}…`} there and no take `
      + 'open that hashes it: opening footage is a fetch, so a document that changes it goes '
      + 'through the project loader',
    );
  }
  refuseResolvedDurations(plan, sources);
  applyProject(plan, sources);
}

// Whole snapshots, because a command stack needs every mutation path to cooperate.
const UNDO_LIMIT = 100;

/**
 * The refusal a document write came back with. `stale` is the store's own mark for a revision
 * that has moved, and it is the one refusal this page answers by stopping rather than by saying
 * a sentence: every other one is about the document, and that one is about somebody else.
 */
function documentRefusal(res, body) {
  const refused = new Error(body?.error ?? `HTTP ${res.status}`);
  if (body?.stale) {
    refused.stale = true;
    refused.rev = body.rev;
  }
  return refused;
}

/**
 * Everything that writes the open project, in the order asked. The store does not order them, and
 * a rename that overtook an auto-save would move the file out from under it.
 */
let projectWrites = Promise.resolve();
function queueProjectWrite(run) {
  const done = projectWrites.then(run);
  projectWrites = done.catch(() => {});
  return done;
}

/**
 * Writes the open project, carrying the revision this tab last saw and keeping the one it is
 * answered with. The revision is read inside the queue rather than at the call, because a burst
 * of commits would otherwise every one of them carry the revision the first of them replaced,
 * and every write after the first would be refused as somebody else's.
 */
function writeOpenProject(body) {
  return queueProjectWrite(async () => {
    const res = await fetch(
      `/projects/${encodeURIComponent(openedProjectName)}?rev=${encodeURIComponent(openedProjectRev)}`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const saved = await res.json().catch(() => null);
    if (!res.ok || saved?.error) throw documentRefusal(res, saved);
    openedProjectRev = saved.rev;
    lastSavedAt = Date.now();
    return saved;
  });
}

/**
 * Writes a preset or a deliverable, carrying the revision the store is at right now.
 *
 * Every change to a document names the revision it was made against. A project holds one, because
 * the page is inside it and every write hands the next one back - these two are written blind from
 * a picker and there is nowhere between writes to keep one, so the revision is read here. That is
 * check-then-act on the wire, and the store is what closes it: the compare runs inside its own
 * per-name queue, so a name that moved between this read and the write is refused rather than
 * quietly overwritten. One helper and not four call sites each growing a parameter.
 */
async function writeDocumentAtCurrentRev(kind, name, { method = 'PUT', body = null } = {}) {
  const send = async (rev) => {
    const res = await fetch(`/${kind}/${encodeURIComponent(name)}?rev=${encodeURIComponent(rev)}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      ...(body === null ? {} : { body: JSON.stringify(body) }),
    });
    return { res, saved: await res.json().catch(() => null) };
  };
  // Off the listing rather than off a read of the name, because a name with no file behind it
  // answers a read with 404 and a 404 this page asked for on purpose is still a console error
  // somebody has to explain. A shipped preset is in the listing with the shipped file's revision,
  // so saving over one forks it instead of reading as a create against a name already taken.
  const listed = await documentsIn(kind);
  const first = await send(listed.find((doc) => doc.name === name)?.rev ?? 'absent');
  if (first.res.ok && !first.saved?.error) return first.saved;
  // The listing skips a document this build cannot read, so a name can be filed and not listed.
  // The refusal carries the revision the file is at, which is the one this write wanted.
  if (!first.saved?.stale) throw documentRefusal(first.res, first.saved);
  const again = await send(first.saved.rev);
  if (!again.res.ok || again.saved?.error) throw documentRefusal(again.res, again.saved);
  return again.saved;
}

/** The URL this page would be reopened at, moved without navigating. */
const showProjectInUrl = (name) => {
  // `history` here is the undo stack, so the browser's own is reached through `globalThis`.
  globalThis.history.replaceState(null, '', `/edit?project=${encodeURIComponent(name)}`);
};

/**
 * Stops writing, and says so where it stays said.
 *
 * Retrying is not merely noisy, it is impossible: the other tab holds the revision this file is
 * at, so a write carrying the one this tab read can never land, and reading the file again would
 * either throw that work away or merge two edits nobody asked to have merged. So this tab stops -
 * and because it has stopped, the sentence has to still be on screen an hour later, or a tab that
 * saves nothing looks exactly like a tab that does.
 */
function stopWritingProject(refused) {
  if (projectDiverged) return;
  projectDiverged = true;
  // The store's own sentence, on the banner's title the way `say` puts a long refusal on `#tNote`.
  if (ui.diverged) ui.diverged.title = refused.message;
  paintDiverged();
}

/** The banner, which is shown by having been earned and hidden by a copy having been made. */
function paintDiverged() {
  if (!ui.diverged) return;
  ui.diverged.hidden = !projectDiverged;
  if (!projectDiverged) return;
  ui.divergedWhen.textContent = lastSavedAt === null
    ? 'Nothing this tab has changed has been written.'
    : `Saved up to ${new Date(lastSavedAt).toLocaleTimeString()}. Nothing after that has been written.`;
}

const history = {
  stack: [],
  // What the document was at the last interaction, so a no-op commit costs nothing.
  baseline: null,
  restoring: false,

  get depth() { return this.stack.length; },

  snapshot() { return JSON.stringify(serialiseProjectBody()); },

  /** Starts the stack from whatever the clip already is. */
  begin() {
    this.stack.length = 0;
    this.baseline = this.snapshot();
  },

  commit() {
    if (this.restoring) return false;
    // The recorder has no clip, so there is nothing here to undo and nothing to save.
    if (!EDITING) return false;
    // The same poisoning arrives on the editor by a road the guard above cannot see.
    if (this.baseline === null) return false;
    const now = this.snapshot();
    if (now === this.baseline) return false;
    // The backstop, and it records rather than refuses: by the time a commit runs the document
    // has already moved, so declining the record would only make that change un-undoable. A
    // commit reaching here during an export is a door this build does not guard - a different
    // fact from an edit the operator should retry, so it gets a different sentence and a counter
    // an instrument can read.
    if (exporting) {
      editsDuringExport++;
      say('a document edit reached the export: the file being written may not be this document');
    }
    this.stack.push(this.baseline);
    if (this.stack.length > UNDO_LIMIT) this.stack.shift();
    this.baseline = now;
    if (effectVersionSkew.length) {
      effectVersionSkew = [];
      paintMissingEffects();
    }
    // Every change is written to the project's own file. A page holding no document has no file
    // to write into and writes nothing at all, and a tab the store has refused has stopped.
    if (openedProjectName !== null && !projectDiverged) {
      const savedBody = serialiseProjectBody();
      // Fire-and-forget, so a refusal blocks nothing on screen.
      writeOpenProject(savedBody).catch((err) => {
        if (err.stale) stopWritingProject(err);
        else say(`this change could not be written to ${openedProjectName}: ${err.message}`);
      });
    }
    return true;
  },

  undo() {
    if (refuseEdit('an undo')) return false;
    const previous = this.stack.pop();
    if (previous === undefined) return false;
    // The accumulators walk forward one output frame at a time and cannot be walked back.
    const gen = takeTransport();
    const resume = timeline ? timeline.playing : false;
    if (resume) timeline.pause();
    this.restoring = true;
    try {
      restoreProject(JSON.parse(previous));
      this.baseline = previous;
    } finally {
      this.restoring = false;
    }
    // The playhead deliberately does not move. Undo is about what the clip is.
    if (resume) {
      timeline.seek(timeline.programSec)
        .then(() => { if (gen === transportGen) return timeline.play(); })
        .catch(showTimelineError);
    } else {
      requestRepaint();
    }
    return true;
  },
};

let framesSeen = 0;
let lastFpsAt = performance.now();
let fps = 0;

// Viewport fps counts both live renders and displayed previews.
let viewportRenders = 0;
let lastViewportFpsAt = performance.now();
let viewportFps = 0;
let sensorLabel = '';
let sensorState = '';
let decodeBusy = false;
let pendingColor = null;
let retiringBitmap = null;
let streamDetached = false;

function setStatus() {
  if (sensorState) {
    const note = document.createElement('span');
    note.textContent = sensorState;
    note.style.color = '#e8a33d';
    statusEl.replaceChildren(note);
    if (appStatusEl) appStatusEl.textContent = sensorState;
  } else {
    statusEl.replaceChildren();
    if (appStatusEl) appStatusEl.textContent = '';
  }
}

async function pumpColorDecode() {
  if (decodeBusy || !pendingColor) return;
  decodeBusy = true;
  const bytes = pendingColor;
  pendingColor = null;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    // The decode is asynchronous, so one can finish after a pinned run took the textures.
    if (streamDetached) {
      bitmap.close();
      return;
    }
    const dropped = retiringBitmap;
    retiringBitmap = colorPrev.image instanceof ImageBitmap ? colorPrev.image : null;

    bindColor(bitmap);

    // Only close a bitmap once it is two swaps old and certainly unbound.
    if (dropped) dropped.close();
  } catch {
    /** a torn JPEG from a dropped USB packet: skip this frame */
  } finally {
    decodeBusy = false;
    if (pendingColor) pumpColorDecode();
  }
}

function handleFrame(buffer) {
  const view = new DataView(buffer);
  const depthBytes = view.getUint32(0, true);
  const colorBytes = view.getUint32(4, true);
  const stampMs = Number(view.getBigUint64(8, true));
  const offset = 16; // u32 + u32 + u64 timestamp

  bindDepth(new Uint16Array(buffer, offset, depthBytes / 2));

  const now = performance.now();
  livePairs.push(stampMs, now);

  if (colorBytes > 0) {
    pendingColor = new Uint8Array(buffer, offset + depthBytes, colorBytes);
    pumpColorDecode();
  }

  framesSeen++;
  if (now - lastFpsAt >= 1000) {
    fps = (framesSeen * 1000) / (now - lastFpsAt);
    framesSeen = 0;
    lastFpsAt = now;
    setStatus();
  }

  // The output's clock is the sensor, and this is where that is decided.
  if (PROGRAM_OUT) programOutFrame();
}

// Camera settings live on the sensor, so the checkboxes mirror what the server reports.
const colorCamEl = document.getElementById('colorCam');
const lowLightEl = document.getElementById('lowLight');
let socket = null;

function sendCamera(patch) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ camera: patch }));
}

function showCamera(state) {
  colorCamEl.checked = state.color;
  lowLightEl.checked = state.lowLight;
  // Exposure is meaningless with the colour camera off, so the control says so.
  lowLightEl.disabled = !state.color;
  lowLightEl.parentElement.classList.toggle('disabled', !state.color);
}

colorCamEl.addEventListener('change', () => sendCamera({ color: colorCamEl.checked }));
lowLightEl.addEventListener('change', () => sendCamera({ lowLight: lowLightEl.checked }));

const monDivisorEl = document.getElementById('monDivisor');
const monStrideEl = document.getElementById('monStride');
const monAcceptCostEl = document.getElementById('monAcceptCost');
const monNoteEl = document.getElementById('monNote');

// The last setting the server confirmed, which is what the record button consults.
let monitorState = { divisor: 1, stride: 1, loopback: true, granted: true, wouldRefuseRecording: false };

function sendMonitor() {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const body = { divisor: Number(monDivisorEl.value), stride: Number(monStrideEl.value) };
  if (monAcceptCostEl?.checked) body.acceptMonitorCost = true;
  socket.send(JSON.stringify({ monitor: body }));
}

function showMonitor(state) {
  monitorState = state;
  monDivisorEl.value = String(state.divisor);
  monStrideEl.value = String(state.stride);
  monDivisorEl.nextElementSibling.value = String(state.divisor);
  monStrideEl.nextElementSibling.value = String(state.stride);
  if (monAcceptCostEl) {
    monAcceptCostEl.parentElement.style.display = state.loopback ? 'none' : '';
  }

  // The stride reads as a position, so it needs a real ordinal rather than a "th" glued on.
  const ordinal = (n) => {
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th'
      : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
    return `${n}${suffix}`;
  };

  // The depth block scales with the divisor squared and the colour block does not move at all.
  const depthKB = Math.ceil(DEPTH_W / state.divisor) * Math.ceil(DEPTH_H / state.divisor) * 2 / 1000;
  const perFrame = depthKB + 52;
  const rate = perFrame * (30 / state.stride) / 1000;
  const parts = [];
  if (!state.granted) parts.push('ungranted');
  parts.push(`depth ÷${state.divisor}, every ${state.stride === 1 ? 'frame' : `${ordinal(state.stride)} frame`}`);
  parts.push(`about ${perFrame.toFixed(0)}KB a frame, ${rate.toFixed(1)} MB/s`);
  if (state.refused) parts.push(`refused: ${state.refused}`);
  if (state.wouldRefuseRecording) {
    parts.push(`a take will refuse to start at this setting - finer than the ÷${state.cap.divisor} `
      + `×${state.cap.stride} a recording allows, and the frames it costs never reach the file`);
  } else if (state.granted && !state.loopback) {
    parts.push('coarse enough to record through');
  }
  parts.push('the recording is always full fidelity whatever this says');
  monNoteEl.textContent = `${parts.join(' · ')}.`;
  monNoteEl.classList.toggle('warn', Boolean(!state.granted || state.wouldRefuseRecording || state.refused));
}

for (const el of [monDivisorEl, monStrideEl]) el.addEventListener('input', sendMonitor);

let programOutMode = 'camera';
/** The output's pixel size, which is deliberately not the window's. */
let programOutSize = { w: 1920, h: 1080 };
let programOutDrawn = 0;
let programOutMissed = 0;
let programOutFps = 0;
let programOutLastAt = 0;
let programOutSince = 0;

const progModeEl = document.getElementById('progMode');
const progSizeEl = document.getElementById('progSize');
const progNoteEl = document.getElementById('progNote');

/** Send a patch to whatever program-out sources are listening. Operator side. */
function sendProgramOut(patch) {
  if (PROGRAM_OUT) return; // a source does not tell other sources what to draw
  if (socket?.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ programOut: patch }));
}

/** The operator's whole state, sent when a source connects or the operator changes mode. */
function sendProgramOutState() {
  sendProgramOut({
    mode: programOutMode,
    size: programOutSize,
    params: params.values(),
    view: cameraPose(freeCamera),
  });
}

function cameraPose(cam) {
  return {
    position: cam.position.toArray(),
    quaternion: cam.quaternion.toArray(),
    fov: cam.fov,
  };
}

/** Apply a patch. Source side. */
function applyProgramOut(patch) {
  if (!PROGRAM_OUT) return;
  // Normalised before any field is applied: a refusal after a mode switch is not a refusal.
  const mode = patch.mode === 'mirror' || patch.mode === 'camera' ? patch.mode : programOutMode;
  let view = null;
  if (patch.view && mode === 'mirror') {
    try {
      view = params.normalise('camera', patch.view);
    } catch (err) {
      console.error(`[program-out] ${err.message}`);
      return;
    }
  }
  if (patch.params) {
    try {
      params.apply(patch.params);
    } catch (err) {
      console.error(`[program-out] ${err.message}`);
      return;
    }
  }
  if (patch.size && Number.isInteger(patch.size.w) && Number.isInteger(patch.size.h)
      && patch.size.w > 0 && patch.size.h > 0) {
    programOutSize = { w: patch.size.w, h: patch.size.h };
    outputSize = { ...programOutSize };
    resize();
  }
  if (patch.mode === 'mirror' || patch.mode === 'camera') {
    programOutMode = patch.mode;
    setViewCamera(programOutMode === 'mirror' ? freeCamera : programCamera);
  }
  if (view) {
    freeCamera.position.fromArray(view.position);
    freeCamera.quaternion.fromArray(view.quaternion);
    if (freeCamera.fov !== view.fov) {
      freeCamera.fov = view.fov;
      freeCamera.updateProjectionMatrix();
    }
  }
}

/** Draw one output frame, called when a depth frame arrives rather than on a clock. */
function programOutFrame() {
  const now = performance.now();
  renderProgramFrame(liveTransport.positionAt(now));
  programOutDrawn++;
  if (programOutLastAt) {
    // The interval is measured and never assumed, because the stream is irregular.
    const expected = livePairs.deliveryMs;
    const gaps = Math.round((now - programOutLastAt) / expected) - 1;
    if (gaps > 0) programOutMissed += gaps;
  }
  programOutLastAt = now;
  if (now - programOutSince >= 1000) {
    programOutFps = (programOutDrawn * 1000) / (now - programOutSince);
    programOutDrawn = 0;
    programOutSince = now;
    paintProgramOutReadout();
  }
}

/** The output's own health, on the output. The other two surfaces have no use for it. */
let programOutReadout = null;
function paintProgramOutReadout() {
  if (!programOutReadout) return;
  // A source fed by a coarsened stream says so.
  const decim = monitorState && (monitorState.divisor > 1 || monitorState.stride > 1)
    ? `  ÷${monitorState.divisor} ×${monitorState.stride}`
    : '';
  programOutReadout.textContent = `PROGRAM OUT  ${programOutMode}  `
    + `${programOutSize.w}x${programOutSize.h}  ${programOutFps.toFixed(1)} fps  `
    + `${programOutMissed} missed${decim}`;
}

/** The operator's two controls, and the URLs to paste into OBS. Not wired on a source. */
if (!PROGRAM_OUT && progModeEl) {
  progModeEl.addEventListener('change', () => {
    programOutMode = progModeEl.value;
    sendProgramOutState();
  });
  progSizeEl.addEventListener('change', () => {
    const m = /^\s*([1-9][0-9]*)\s*x\s*([1-9][0-9]*)\s*$/.exec(progSizeEl.value);
    if (!m) {
      progSizeEl.value = `${programOutSize.w}x${programOutSize.h}`;
      return;
    }
    programOutSize = { w: Number(m[1]), h: Number(m[2]) };
    progSizeEl.value = `${programOutSize.w}x${programOutSize.h}`;
    sendProgramOut({ size: programOutSize });
  });
  progNoteEl.textContent = `browser source: ${location.origin}/program  ·  `
    + `webcam: ${location.origin}/camera.mjpg`;
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = 'arraybuffer';
  socket = ws;

  ws.onopen = () => {
    sensorLabel = 'waiting for sensor…';
    setStatus();
    // Asked for rather than waited for: OBS reconnects a browser source on its own schedule.
    if (PROGRAM_OUT) ws.send(JSON.stringify({ programOut: { hello: true } }));
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);

      if (msg.status) {
        sensorState = {
          live: '', starting: 'sensor starting…', lost: 'sensor lost — restarting',
          // Not a fault to wait out: this is the editing station and the
          // footage is on the node.
          absent: 'no sensor on this machine',
        }[msg.status] ?? msg.status;
        if (msg.status !== 'live') fps = 0;
        setStatus();
        return;
      }

      if (msg.camera) {
        showCamera(msg.camera);
        return;
      }

      // Any client can arm or stop a take, so every monitor has to see the state change.
      if (msg.recording) {
        recordState = msg.recording;
        paintRecord(null);
        chromeStale = true;
        drawChrome();
        return;
      }

      // What the server granted this monitor, which is not always what it asked for.
      if (msg.monitor) {
        showMonitor(msg.monitor);
        return;
      }

      // What the operator wants drawn. Ignored on any page that is not a source.
      if (msg.programOut) {
        if (msg.programOut.hello) {
          if (!PROGRAM_OUT) sendProgramOutState();
        } else {
          applyProgramOut(msg.programOut);
        }
        return;
      }

      // The hello is recognised rather than reached by falling through.
      if (typeof msg.serial === 'string' && Number.isFinite(msg.fx)) {
        uniforms.focal.value.set(msg.fx, msg.fy);
        uniforms.center.value.set(msg.cx, msg.cy);
        if (!msg.color) uniforms.hasColor.value = 0;
        sensorLabel = `${msg.serial} · fw ${msg.firmware}`;
        paintPreviewRange(msg.minDepth, msg.maxDepth);
        setStatus();
        console.log('sensor intrinsics', msg);
        return;
      }

      // Loud rather than ignored: a message this page cannot read means the server is ahead.
      console.warn('unrecognised message on the frame socket', msg);
    } else {
      handleFrame(event.data);
    }
  };

  ws.onclose = () => {
    if (streamDetached) return;
    sensorLabel = 'disconnected — retrying';
    setStatus();
    setTimeout(connect, 1000);
  };

  ws.onerror = () => ws.close();
}

// Live acquisition has to be able to go away: a render pulls its frames from a file.
function detachStream() {
  streamDetached = true;
  socket?.close();
  // The socket closing does not stop a frame that has already been parsed.
  pendingColor = null;
  sensorLabel = 'stream detached';
  setStatus();
}

const NOMINAL_GAP_MS = 1000 / 30;
// Past this, a stamp step is a take boundary rather than a stall.
const DISCONTINUITY_MS = 5000;
const noop = () => {};

// What the instruments read instead of taking the transport's word for anything.
const counters = {
  renders: 0, stateAdvances: 0, resets: 0, drafts: 0, seeks: 0, requests: 0, framesFetched: 0,
  navigationRedraws: 0, navigationHistoryClears: 0,
  laneRebuilds: 0, laneRepositions: 0, laneFallbacks: 0,
  // How many times a clip was cleared and positioned on the frame it entered on, which is the
  // reading that separates a warm that ran from one that was skipped.
  clipEntries: 0, clipsDrawn: 0, clipsWarmed: 0,
  // Of those entries, the ones where the clip had drawn since the last reset - the only case in
  // which clearing it on the way in changes anything.
  clipReEntries: 0,
  // One per JPEG handed to the decoder. Two clips of one take share a cache, so this is what says
  // the sharing is real rather than merely intended.
  bitmapDecodes: 0,
};

/** Every selected-clip key time, rescaled by `k` when its slope changes. */
function reparameteriseProgramTime(k, was) {
  rescaleClipKeys(was.keys, k, was.pivot);
}

/** Where a later rescale reads its times from. Live objects, and the `t` they had. */
const programTimeSnapshot = () => ({
  keys: snapshotClipKeys(lookOf().tracks.values()),
  pivot: 0,
});

class LivePairSource {
  /** No end: more of it is still arriving, so a clip on it covers whatever program time asks. */
  get streaming() { return true; }

  constructor() {
    this.tA = 0;
    this.tB = 0;
    this.arrivedAtMs = 0;
    // Two smoothed intervals with different jobs, and conflating them is the mistake to avoid.
    this.sourceGapMs = NOMINAL_GAP_MS;
    this.deliveryMs = NOMINAL_GAP_MS;
    this.lastStampMs = null;
    this.lastWallMs = 0;
    this.pendingGapMs = 0;
    this.pendingFrames = 0;
  }

  /** One arrival, after its depth has been swapped into the current texture. */
  push(stampMs, wallMs) {
    const raw = this.lastStampMs === null ? 0 : stampMs - this.lastStampMs;
    this.lastStampMs = stampMs;

    // A replay loops and a restart opens a new take, so a stamp can go backwards or leap.
    const gap = (raw > 0 && raw < DISCONTINUITY_MS) ? raw : this.sourceGapMs;
    if (raw > 5 && raw < 500) this.sourceGapMs = this.sourceGapMs * 0.8 + raw * 0.2;

    const delivered = this.lastWallMs ? wallMs - this.lastWallMs : 0;
    // Clamped so one stall does not stretch the blend across the next second.
    if (delivered > 5 && delivered < 500) this.deliveryMs = this.deliveryMs * 0.8 + delivered * 0.2;
    this.lastWallMs = wallMs;

    this.tA = this.tB;
    this.tB += gap;
    this.arrivedAtMs = wallMs;
    this.pendingGapMs += gap;
    this.pendingFrames++;
  }

  // How far the stream reaches, which for a live one is wherever the newest frame landed.
  get duration() { return this.tB / 1000; }

  at(programSec) {
    const steps = [];
    if (this.pendingFrames > 0) {
      steps.push({ gapSec: this.pendingGapMs / 1000, makeCurrent: noop });
      this.pendingGapMs = 0;
      this.pendingFrames = 0;
    }

    // This half of the seam is in milliseconds and the indexed half is in seconds.
    const spanMs = Math.max(1, this.tB - this.tA);
    const offsetMs = Math.min(Math.max(programSec * 1000 - this.tA, 0), spanMs);
    return { steps, mixT: offsetMs / spanMs, sinceFrameSec: offsetMs / 1000, spanSec: spanMs / 1000 };
  }
}

class LiveTransport {
  constructor(source) { this.source = source; }

  /** The one transport that reads a wall clock, and only to place the playhead in the gap. */
  positionAt(wallMs) {
    const s = this.source;
    if (!s.arrivedAtMs) return 0;
    // Walk across the pair over one expected delivery interval, then hold.
    const frac = Math.min(1, (wallMs - s.arrivedAtMs) / Math.max(1, s.deliveryMs));
    return (s.tA + frac * (s.tB - s.tA)) / 1000;
  }
}

const livePairs = new LivePairSource();
const liveTransport = new LiveTransport(livePairs);

/**
 * One layer of the composite: where it sits in the project, the frames it draws, how fast it
 * runs through them and the cloud it draws them with.
 *
 * Clip-local time at project time `t` is `t - start`. Two fields turn that into a source
 * position: `sourceStart`, the in-point a head trim writes, and `speed`, the slider's rate.
 */
class Clip {
  constructor(id, source, cloud, look = createLook()) {
    // Stored rather than the array index: four things name a clip, and an index reassigns one
    // clip's tracks to another the moment a clip above it is deleted.
    this.id = id;
    this.source = source;
    this.cloud = cloud;
    // This clip's own look: its clip-scope values, the tracks that move them, and the pool of
    // values it arrived carrying that this build has no effect to read.
    this.look = look;
    // The footage this clip draws, as `{ id, hash }`, or null before anything is open. The take
    // is named by hash so a rename carries it, and `source` is what that hash resolved to.
    this.take = null;
    // How fast this clip runs through its footage, in source seconds per project second.
    this.speed = 1;
    // The in-point: the source second at this clip's head, which a head trim moves.
    this.sourceStart = 0;
    // Project seconds, and where the composite puts this clip.
    this.start = 0;
    // Project seconds this clip runs for, or null to run for everything its footage affords. A
    // trim is where the edit stops using the take, which is a different fact from how much take
    // there is - so this is read as the answer rather than derived and compared to one.
    this.trim = null;
    // Where this clip's look came from, or null. A copy plus a stamp, not a reference.
    this.appliedPreset = null;
    // Whether the last render drew this clip, warmed it, or skipped it. The one frame this reads
    // 'off' on the way in is the frame the clip's surface memory has to be cleared.
    this.showing = 'off';
    // The warm window last worked out, against the inputs it was worked out from.
    this.warmCache = null;
    // Whether this clip has put anything in its surface memory since the last reset, which is
    // what says whether clearing it on the way in has anything to clear.
    this.drawnSinceReset = false;
  }

  /** How much project time this clip makes of the source left after its in-point. */
  get afforded() {
    return this.source.streaming ? Infinity : clipAffordedSec(this, this.source.duration);
  }

  /** How long this clip runs in project seconds: its trim, or everything its footage affords. */
  get length() { return this.trim === null ? this.afforded : this.trim; }

  /** Where this clip stops, in project seconds. A trim past the source holds its last frame. */
  get end() { return this.start + this.length; }

  /** The three nodes this clip draws through: its placement, its levelling, and its points. */
  get transform() { return this.cloud.points.transform; }

  get points() { return this.cloud.points.cloud; }

  /** The source frame at or before a project position, as the lower half of a bracketing pair. */
  sourceFrameAt(programSec) {
    return this.source.bracket(clipSourceSecAt(this, programSec - this.start));
  }

  /** Where a source frame lands in project seconds, which is `sourceFrameAt` run backwards. */
  programSecOf(sourceFrame) {
    return this.start + clipProgramSecAt(this, this.source.times[sourceFrame]);
  }

  /** How many output frames back this clip reaches to cover `sourceSpanSec`. */
  surfaceFramesBack(programSec, sourceSpanSec, outputFps, ceiling) {
    return framesBackFor(this.speed, sourceSpanSec, outputFps, ceiling);
  }

  /**
   * How many output frames before its in-point this clip is warmed for.
   *
   * A clip that appears mid-playback has whatever its ping-pong pair last drew still in it, so
   * without this the first frame after a cut shows no fade and no wake where the same instant
   * reached by seeking is pre-rolled and looks right. The window is this clip's own surface span
   * read at its in-point, bounded by the footage in front of that in-point: a clip whose head is
   * the head of the take has nothing to pre-roll over.
   */
  warmFrames(outputFps, ceiling) {
    if (this.source.streaming) return 0;
    const surfaceSec = (valueAtProgram('fade', this.start, this)
      + valueAtProgram('wake', this.start, this)) / 1000;
    const held = this.warmCache;
    if (held && held.surfaceSec === surfaceSec && held.outputFps === outputFps
      && held.ceiling === ceiling && held.timingGen === timingGeneration) {
      return held.frames;
    }
    const want = framesBackFor(this.speed, surfaceSec, outputFps, ceiling).frames;
    const frames = Math.min(want, this.headFrames(outputFps, want));
    this.warmCache = { surfaceSec, outputFps, ceiling, timingGen: timingGeneration, frames };
    return frames;
  }

  /** How many output frames before its in-point this clip still reaches footage over. */
  headFrames(outputFps, limit) {
    return headFramesFor(this.speed, this.sourceStart, outputFps, limit);
  }
}

// The clip array is filled here, having been declared beside the cloud the first one draws with.
clips.push(new Clip('c1', livePairs, bootCloud, bootLook));

// Bumped by anything that moves a clip's placement, speed or in-point, which is what the warm
// window above is memoised against.
let timingGeneration = 0;

// Half-open at the out-point: two clips abutting at a cut must not both draw on the frame it
// lands on, and the epsilon is there because a start and an end are both computed numbers.
const CLIP_EDGE = 1e-9;

/** The output rate the composite is on, which before the editor is up is the default. */
const outputFps = () => (timeline ? timeline.outputFps : 30);

/** The ceiling a warm walk is bounded by, which is the whole edit and never more. */
const warmCeiling = () => (timeline ? Math.max(1, timeline.lastFrame) : 1);

/** Whether a clip covers a program position at all, which is the whole of what "drawn" means. */
const coversAt = (clip, t) => t >= clip.start - CLIP_EDGE && t < clip.end - CLIP_EDGE;

/** Whether a clip is drawn at a program position, warmed for one it is about to reach, or idle. */
function clipShowingAt(clip, t) {
  if (coversAt(clip, t)) return 'live';
  // Asked before the warm window is worked out, because a clip past its out-point is idle
  // whatever its head would have cost and the window is the expensive half of this question.
  if (t >= clip.start) {
    // A half-open out-point leaves the instant an edit ends on covered by nothing at all. It
    // belongs to whatever ended there unless something else starts there, which is what stops
    // the last frame of every edit rendering black and still lets a cut draw one clip.
    const ends = Math.abs(t - clip.end) <= CLIP_EDGE;
    const hasSpan = clip.end > clip.start;
    return hasSpan && ends && !clips.some((other) => coversAt(other, t)) ? 'live' : 'off';
  }
  const warmSec = clip.warmFrames(outputFps(), warmCeiling()) / outputFps();
  return t >= clip.start - warmSec - CLIP_EDGE ? 'warming' : 'off';
}

/** The clips drawn at a program position, in project order. A gap between clips has none. */
function clipsLiveAt(t) {
  return clips.filter((clip) => clipShowingAt(clip, t) === 'live');
}

/** The clips a render at a program position touches at all, drawn or warming. */
const clipsActiveAt = (t) => clips.filter((clip) => clipShowingAt(clip, t) !== 'off');

/** Every colour bitmap a clip currently has bound, which a trim must not close. */
function boundBitmaps() {
  return clips.flatMap((clip) => boundColorImages(clip.cloud.textures));
}

/** Every clip's ping-pong pair, which is what an accumulator reset has to reach. */
function clipStateTargets() {
  return clips.flatMap((clip) => [clip.cloud.memory.statePrev, clip.cloud.memory.stateNext]);
}

/**
 * The order the clips draw in, written onto the points rather than left to three's own sort.
 *
 * Depth-writing clips first and additive ones after, because an additive layer composited under
 * one that writes depth is a different picture. The tie breaks on the clip's id and not on its
 * place in the array or its centroid: "any order" is true of the picture and false of the bytes,
 * and an export that reordered two clips between runs would write different files from one
 * document.
 */
function orderClips() {
  const order = clips.slice().sort((a, b) => {
    const additive = Number(!a.points.material.depthWrite) - Number(!b.points.material.depthWrite);
    if (additive !== 0) return additive;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
  for (const [at, clip] of order.entries()) clip.points.renderOrder = at;
}

/** A cloud for a new clip, brought up on what a cloud is set to outside its look. */
function createClipCloud() {
  const instance = createCloudInstance(shaderPrograms.cloud);
  const was = selectedClip ? selectedClip.cloud : null;
  selectCloud(instance);
  seedUniformCells();
  uniforms.pointCeiling.value = pointSizeCeiling;
  uniforms.bufferHeight.value = renderer.getDrawingBufferSize(new THREE.Vector2()).y;
  if (was) selectCloud(was);
  return instance;
}

/** A clip id nothing in the project already holds. */
function mintClipId() {
  const held = new Set(clips.map((clip) => clip.id));
  for (let n = 1; ; n++) {
    if (!held.has(`c${n}`)) return `c${n}`;
  }
}

/** Points the render core and the module bindings above at one clip. */
function selectClip(clip) {
  selectedClip = clip;
  selectCloud(clip.cloud);
}
selectClip(clips[0]);

// One ping-pong step of the surface memory, advanced by exactly one source frame.
function advanceSurfaceState(dtSec) {
  counters.stateAdvances++;
  // The upper bound is the discontinuity gate and nothing tighter, or it undoes that gate.
  stepSurfaceMemory(
    Math.min(DISCONTINUITY_MS / 1000, Math.max(0.001, dtSec)),
    uniforms.snapDelta.value,
  );
  uniforms.stateTex.value = statePrev.texture;
}

let lastProgramTime = 0;

// What the mosh pass's last rendered frame was: whether the history behind it is worth reading
// at all, and the refresh period in force when it was drawn. The second is remembered rather
// than re-derived because the period keyframes, so the step between two frames is measured with
// the value each end actually had.
let moshFresh = true;
let moshWasLive = false;
let lastMoshPeriod = 0;

// Screen-space history belongs to the camera pose that produced it.
let renderedCamera = null;
const renderedCameraPosition = new THREE.Vector3();
const renderedCameraQuaternion = new THREE.Quaternion();
const renderedProjection = new THREE.Matrix4();

function renderedCameraChanged() {
  const changed = renderedCamera !== null && (
    renderedCamera !== viewCamera
    || !renderedCameraPosition.equals(viewCamera.position)
    || !renderedCameraQuaternion.equals(viewCamera.quaternion)
    || !renderedProjection.equals(viewCamera.projectionMatrix)
  );
  renderedCamera = viewCamera;
  renderedCameraPosition.copy(viewCamera.position);
  renderedCameraQuaternion.copy(viewCamera.quaternion);
  renderedProjection.copy(viewCamera.projectionMatrix);
  return changed;
}

function clearFeedback(targets, refusal) {
  if (!targets.every((target) => target?.isWebGLRenderTarget)) throw new Error(refusal);
  const color = new THREE.Color();
  renderer.getClearColor(color);
  const alpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);
  try {
    for (const target of targets) {
      renderer.setRenderTarget(target);
      renderer.clear(true, true, true);
    }
  } finally {
    renderer.setRenderTarget(null);
    renderer.setClearColor(color, alpha);
  }
}

function clearAfterimage() {
  // Three exposes no reset on the afterimage pass, so its two buffers are reached for directly.
  clearFeedback(
    [afterimage._textureComp, afterimage._textureOld],
    'afterimage internals moved: camera history can no longer be cleared safely',
  );
}

// Clears every feedback path. None of them walks backwards, so a seek pre-rolls forward.
//
// Every clip's surface memory, the one afterimage and the mosh's history: the surface half is per
// cloud because the memory is, and the other two are the composite's. Marking every clip idle is
// the other half of the clear - a clip put back on the far side of a reset re-enters, and
// re-entering is what positions its walk.
function resetAccumulators() {
  counters.resets++;
  clearFeedback(
    [...clipStateTargets(), afterimage._textureComp, afterimage._textureOld, ...mosh.history],
    'afterimage internals moved: the accumulator reset is no longer complete',
  );
  for (const clip of clips) {
    clip.showing = 'off';
    clip.drawnSinceReset = false;
  }
  lastProgramTime = 0;
  // Cleared history is black, and a mosh chunk reading it would draw black rather than nothing,
  // so the next frame is a refresh whatever the period says.
  moshFresh = true;
}

/**
 * One clip put back to nothing on the frame it enters on, and its walk placed where it enters.
 *
 * The reset is not optional. A clip re-entered after an earlier pass still holds that pass's
 * ping-pong contents, and without this a ghost from eight seconds ago bleeds across the cut.
 * Runs with the render core pointed at the clip, because both halves are its own.
 */
function enterClip(clip, t) {
  counters.clipEntries++;
  if (clip.drawnSinceReset) counters.clipReEntries++;
  clearFeedback(
    [statePrev, stateNext],
    'the surface memory moved: a clip can no longer be cleared on the frame it enters',
  );
  // A stream has no walk to position: its frames arrive rather than being addressed by time.
  if (!clip.source.streaming) clip.source.seekTo(clip.sourceFrameAt(t));
}
// A seek clears the same pair a moment earlier, and the repeat is deliberate: a clip enters on a
// cut with no reset behind it, so "empty on the frame it enters" holds only if entering says so.

// Where an export takes its bytes. One position, since the readback shares the task.
let frameSink = null;

function noteViewportFrame() {
  viewportRenders++;
  const now = performance.now();
  if (now - lastViewportFpsAt >= 1000) {
    viewportFps = (viewportRenders * 1000) / (now - lastViewportFpsAt);
    viewportRenders = 0;
    lastViewportFpsAt = now;
  }
}

// One image at one program position. Both transports drive exactly this call.
function renderProgramFrame(t) {
  previews?.hide();
  counters.renders++;
  noteViewportFrame();
  // The overlay is still a scene, so an export and a chrome-off look take its handles out.
  if (gizmoHelper) gizmoHelper.visible = gizmoShown();
  chromeStale = true;
  evaluating = true;
  try {
    for (const clip of clips) {
      const showing = clipShowingAt(clip, t);
      if (showing === 'off') {
        // An idle clip is not drawn at all rather than drawn empty, so it costs nothing.
        clip.transform.visible = false;
        clip.showing = 'off';
        continue;
      }
      // Every door below writes the selected cloud, so the table, the textures and the memory
      // this clip's frame lands in are reached as its own before any of it means anything.
      selectCloud(clip.cloud);
      if (clip.showing === 'off') enterClip(clip, t);

      // The one place program time becomes source time, through the clip's own zero.
      const local = t - clip.start;
      const frame = clip.source.at(clipSourceSecAt(clip, local));
      for (const step of frame.steps) {
        step.makeCurrent();
        advanceSurfaceState(step.gapSec);
      }

      uniforms.mixT.value = frame.mixT;
      uniforms.sinceFrameSec.value = frame.sinceFrameSec;
      // The gap the two bound frames are separated by, which turns a depth
      // difference into a speed.
      uniforms.spanSec.value = frame.spanSec;
      uniforms.time.value = local;
      uniforms.rainPhase.value = local;

      // A warming clip is stepped and left off screen: it is building the surface memory the
      // frame after the cut needs, and drawing it would be showing footage before its in-point.
      clip.transform.visible = showing === 'live';
      clip.showing = showing;
      clip.drawnSinceReset = true;
      if (showing === 'live') counters.clipsDrawn++;
      else counters.clipsWarmed++;
    }
    // Put back, so everything outside a render reads the selected clip rather than whichever one
    // the loop above happened to end on.
    selectCloud(selectedClip.cloud);
    // The post chain is the project's rather than any clip's, so it reads project time.
    grade.uniforms.time.value = t;
    mosh.uniforms.time.value = t;

    // Every track, look and camera alike, through the registry rather than onto the uniforms.
    evaluateTracks(t);

    // Source history stays valid while the camera is still. A changed camera is
    // a new projection.
    if (renderedCameraChanged()) {
      clearAfterimage();
      counters.navigationHistoryClears++;
    }

    // Whether this is the frame the mosh pass draws exactly what it was handed. Asked before
    // `lastProgramTime` moves, because it is a question about the step between two frames: the
    // period in force at each end, and the two ends of the step. The other two answers are
    // states the pass cannot be asked about - a cleared history, and a pass that was switched
    // off while the frames it would have remembered went by.
    const moshPeriod = MOSH_BOUND ? mosh.uniforms[MOSH_BOUND.uniform].value : 0;
    const moshCycles = mosh.uniforms.moshCycleRefresh?.value ?? 1;
    mosh.uniforms.moshIFrame.value = (moshFresh || !moshWasLive
      || (moshCycles && moshRefreshes(lastProgramTime, lastMoshPeriod, t, moshPeriod))) ? 1 : 0;
    moshFresh = false;
    moshWasLive = mosh.enabled;
    lastMoshPeriod = moshPeriod;

    const dt = Math.max(0, t - lastProgramTime);
    lastProgramTime = t;

    // The delta goes in explicitly: the composer falls back to its own clock when called bare.
    const timing = statsVisible;
    const timerGl = timing ? renderer.getContext() : null;
    if (timing) gpuTimer.begin(timerGl);
    if (postEnabled()) composer.render(dt);
    else renderer.render(scene, viewCamera);
    renderGizmo();
    if (timing) gpuTimer.end(timerGl);

    if (frameSink !== null && t === frameSink.t) {
      const gl = renderer.getContext();
      gl.readPixels(
        0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight,
        gl.RGBA, gl.UNSIGNED_BYTE, frameSink.pixels,
      );
      frameSink.hits++;
    }
  } finally {
    if (selectedClip) selectCloud(selectedClip.cloud);
    evaluating = false;
  }
}

// Navigation's own clock, kept out of the seam.
let lastNavTime = 0;

// Which fly keys are down, and whether shift is with them. Written from events and read by the
// loop, because nothing but the loop may start a redraw.
const flyHeld = new Set();
let flyShift = false;
// Wall clock at the previous fly frame, or 0 when the hold has not started. The free camera is
// interactive, so it takes real seconds where auto-orbit takes the program delta.
let flyLastAt = 0;
const flyMove = new THREE.Vector3();
// The look drag's live state, written by the pointer handlers far below and read here. Null
// when no look drag is up; otherwise the last pointer position, since the turn is per-move.
let lookDrag = null;

/** Whether the held keys ask for a non-zero move. Shift gates the six, so it is a held key. */
const flyInputActive = () => (
  flyShift && flyDirection(flyHeld, freeCamera.quaternion, freeCamera.up, flyMove).lengthSq() > 0
);

/** Whether a held fly key may move the camera. `controls.enabled` is the program camera, a
 *  gizmo drag, a node drag and a crop drag in one term - each already a reason the orbit stands
 *  down. A look drag turns it off too and is the one that must not stop the flight, because
 *  flying while you turn is what the mode is. */
const flying = () => flyInputActive() && (controls.enabled || lookDrag !== null) && !exporting;

/** Change the held keys or the shift they need, starting a new clock when the move starts or
 *  stops. Shift comes through here for the same reason a key does: a resumed hold that kept the
 *  old clock takes the stall cap as its first step. */
function changeFlyKeys(change) {
  const wasActive = flyInputActive();
  change();
  if (!wasActive || !flyInputActive()) flyLastAt = 0;
}

/** One frame of flight: the camera and its pivot translate by the same vector. */
function advanceFly() {
  if (!flying()) { flyLastAt = 0; return; }
  const now = performance.now();
  const dt = flyLastAt === 0 ? 0 : (now - flyLastAt) / 1000;
  flyLastAt = now;
  flyStep(flyHeld, dt, freeCamera.quaternion, freeCamera.up, flyMove);
  freeCamera.position.add(flyMove);
  // The pivot travels with the camera. `update()` rebuilds the position out of the target, so
  // moving the camera alone would change the orbit's radius instead of where you are standing.
  controls.target.add(flyMove);
}

// Auto-orbit gets the program delta, so the same orbit renders the same at any speed.
function advanceNavigation(t) {
  if (PREVIEW_RENDERER) return;
  advanceFly();
  controls.update(Math.max(0, t - lastNavTime));
  lastNavTime = t;
}

/** How often the live cloud is allowed to be drawn, in hertz. */
let cloudDrawHz = 15;
let lastCloudDrawAt = 0;

function liveLoop() {
  const now = performance.now();
  const t = liveTransport.positionAt(now);
  advanceNavigation(t);
  if (cloudDrawHz > 0 && now - lastCloudDrawAt < 1000 / cloudDrawHz) {
    if (chromeOn) drawChrome();
    if (programOutMode === 'mirror') streamMirrorPose();
    return;
  }
  lastCloudDrawAt = now;
  renderProgramFrame(t);
  if (chromeOn) drawChrome();
  if (programOutMode === 'mirror') streamMirrorPose();
}

// The last pose sent, so a still camera sends nothing at all.
let mirrorSentAt = 0;
let mirrorLastPose = '';
function streamMirrorPose() {
  const now = performance.now();
  if (now - mirrorSentAt < 1000 / 30) return;
  const pose = cameraPose(freeCamera);
  const key = JSON.stringify(pose);
  if (key === mirrorLastPose) return;
  mirrorLastPose = key;
  mirrorSentAt = now;
  sendProgramOut({ view: pose });
}

// How many frames a take keeps decoded when nothing is asking for more. A take shared by
// several clips holds what they ask for between them; this is the floor under that, so a
// one-clip edit caches exactly what it always did.
const CACHE_FRAMES = 192;
// What one decoded frame costs resident: a depth block at two bytes a cell, plus the same grid
// as an RGBA bitmap. Measured at 1.23 MiB against 1.24 by construction - docs/performance.md.
const FRAME_BYTES = POINTS * 2 + POINTS * 4;
// What a take's decoded frames may cost. Generous on purpose: it covers the eight clips
// `CLIP_CEILING` allows, each pre-rolling two and a half seconds of persistence at 30fps.
const CACHE_BUDGET_BYTES = 768 * 1024 * 1024;
// The frames that budget buys, which is the ceiling every cache here is bounded by.
const CACHE_CEILING_FRAMES = Math.floor(CACHE_BUDGET_BYTES / FRAME_BYTES);
// The slack a cache keeps above what was asked for, so a fetch lands without evicting itself.
const CACHE_HEADROOM = 16;
const DEMAND_TRIM_BATCH = 16;
// The most frames one call may ask to have resident at once, kept below the ceiling.
const MAX_SPAN_FRAMES = CACHE_CEILING_FRAMES - CACHE_HEADROOM;
// How many frames one range request covers. The response is buffered whole, so it is capped.
const RUN_FRAMES = 32;
// How far ahead playback keeps the cache filled, in output frames.
const PREFETCH_FRAMES = 30;
const KNCT_MAGIC = 0x4b4e4354;
const KNCT_HEADER = 12;

// The walk every source that can address a capture by time performs, written once.
class StampedPairSource {
  /** @param times source seconds from the first frame, ascending. */
  constructor(times) {
    if (times.length < 2) throw new Error(`a pair source needs two frames, got ${times.length}`);
    this.times = times;
    this.applied = -1;
  }

  /** A capture has an end. The live stream does not, which is what decides a clip's length. */
  get streaming() { return false; }

  get count() { return this.times.length; }

  get duration() { return this.times[this.times.length - 1]; }

  /** The frame at or before `sourceSec`, as the lower half of a bracketing pair. */
  bracket(sourceSec) {
    let lo = 0;
    let hi = this.count - 2;
    while (lo < hi) {
      const mid = integerMidpoint(lo, hi, true);
      if (this.times[mid] <= sourceSec) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Puts the walk back at frame `i`, so the next `at` emits `i` and `i + 1` as its steps. */
  seekTo(i) {
    this.applied = Math.max(-1, Math.min(this.count - 2, i) - 1);
  }

  rewind() { this.applied = -1; }

  /** One frame's bytes in front of the shader. Where they come from is the subclass. */
  // eslint-disable-next-line no-unused-vars
  makeCurrent(k) {
    throw new Error(`${this.constructor.name} does not say where its frames come from`);
  }

  at(sourceSec) {
    const times = this.times;
    const i = this.bracket(sourceSec);

    if (i + 1 < this.applied) {
      throw new Error(
        `backward seek to ${sourceSec}s without a reset: the accumulators have `
        + `already consumed frame ${this.applied}`,
      );
    }

    const steps = [];
    for (let k = this.applied + 1; k <= i + 1; k++) {
      // Clamped: stamps that are not strictly ascending would age the surface memory backwards.
      const gapSec = k === 0 ? NOMINAL_GAP_MS / 1000 : Math.max(0, times[k] - times[k - 1]);
      steps.push({ gapSec, makeCurrent: () => this.makeCurrent(k) });
    }
    this.applied = i + 1;

    const span = Math.max(1e-6, times[i + 1] - times[i]);
    const offset = Math.min(Math.max(sourceSec - times[i], 0), span);
    return { steps, mixT: offset / span, sinceFrameSec: offset, spanSec: span };
  }
}

/**
 * One open take: its index, its decoded frames and the one queue that fetches them.
 *
 * This is the half of an indexed source that belongs to the footage rather than to a clip, and
 * the split is what stops two clips of one take fetching and JPEG-decoding it twice for the same
 * frame. Where a clip is in it - the walk cursor, and which textures the bytes land in - is the
 * other half, and lives in `IndexedPairSource` below.
 */
class IndexedTake {
  static async open(id) {
    const res = await fetch(`/capture/${encodeURIComponent(id)}/index`);
    if (!res.ok) throw new Error(`capture ${id}: ${res.status} ${res.statusText}`);
    return new IndexedTake(id, await res.json());
  }

  constructor(id, index) {
    const stamps = index.frames.stampMs;
    if (stamps.length < 2) throw new Error(`capture ${id} has ${stamps.length} frames, need two to bracket`);
    this.times = stamps.map((s) => (s - stamps[0]) / 1000);
    this.id = id;
    this.index = index;
    this.cache = new Map();
    // The intrinsics this footage was shot with, written by `openSource`. On the take because
    // that is whose they are, and because re-pointing a clip at footage already open needs them.
    this.hello = null;
    this.pending = null;
    this.generation = 0;
    // The windows callers have asked to have resident and not yet had. A trim keeps their union:
    // several clips share this cache, and a trim that kept only the run in front of it evicted
    // the frames an earlier clip of the same plan had just fetched.
    this.claims = new Set();
    // How many frames the clips cut on this take are asking for between them, written by the
    // transport when it plans. A constant here capped a four-clip pre-roll at a quarter of what
    // it had computed, because four clips of one take ask this one cache for four windows.
    this.demand = 0;
    this.demandTrim = null;
  }

  get count() { return this.times.length; }

  /**
   * How many frames this cache holds: what its clips are asking for, floored and bounded.
   *
   * This is never below what a plan may ask - `MAX_SPAN_FRAMES` is the ceiling less the same
   * headroom - and the two cannot be moved apart: a cache smaller than the span a fetch is
   * allowed to request evicts the frames that fetch just put in it, and the seek then stands
   * down for ever rather than reporting anything.
   */
  get capacity() {
    return Math.min(
      CACHE_CEILING_FRAMES,
      Math.max(CACHE_FRAMES, this.demand + CACHE_HEADROOM),
    );
  }

  /** Sets the current plan's demand, deferring a release until the render task has finished. */
  setDemand(frames) {
    this.demand = frames;
    if (frames > 0) {
      if (this.demandTrim !== null) clearTimeout(this.demandTrim);
      this.demandTrim = null;
      return;
    }
    if (this.demandTrim !== null) return;
    this.demandTrim = setTimeout(() => {
      this.demandTrim = null;
      if (this.demand !== 0) return;
      if (this.claims.size > 0) return;
      this.trim(DEMAND_TRIM_BATCH);
      if (this.cache.size > this.capacity) this.setDemand(0);
    }, 0);
  }

  /** One decoded frame, or undefined where the cache does not hold it. */
  frame(k) { return this.cache.get(k); }

  resident(a, b) {
    for (let k = Math.max(0, a); k <= Math.min(this.count - 1, b); k++) {
      if (!this.cache.has(k)) return false;
    }
    return true;
  }

  /** Puts frames a..b in the cache. Serialised, so a prefetch racing a seek fetches once. */
  ensure(a, b) {
    const claim = [a, b];
    const generation = this.generation;
    this.claims.add(claim);
    const run = () => this.fetchSpan(a, b, generation).finally(() => {
      this.claims.delete(claim);
      if (this.demand === 0) this.setDemand(0);
    });
    this.pending = (this.pending ?? Promise.resolve()).then(run, run);
    return this.pending;
  }

  async fetchSpan(a, b, generation) {
    if (generation !== this.generation) return;
    const from = Math.max(0, a);
    const to = Math.min(this.count - 1, b);
    if (to - from + 1 > MAX_SPAN_FRAMES) {
      throw new Error(
        `a span of ${to - from + 1} frames does not fit a ceiling of ${CACHE_CEILING_FRAMES}: `
        + 'the caller has to clamp it and say what it dropped',
      );
    }
    const runs = [];
    for (let k = from; k <= to; k++) {
      if (this.cache.has(k)) continue;
      const last = runs[runs.length - 1];
      if (last && last[1] === k - 1 && last[1] - last[0] + 1 < RUN_FRAMES) last[1] = k;
      else runs.push([k, k]);
    }
    for (const [lo, hi] of runs) {
      await this.fetchRun(lo, hi, generation);
      if (generation !== this.generation) return;
      this.trim();
    }
  }

  /** A run in one request where there is a run to have. */
  async fetchRun(lo, hi, generation) {
    counters.requests++;
    const single = lo === hi;
    const url = single
      ? `/capture/${encodeURIComponent(this.id)}/frame/${lo}`
      : `/capture/${encodeURIComponent(this.id)}/frames/${lo}-${hi}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
    const buffer = await res.arrayBuffer();

    // A single frame is the payload alone; a run is the file's slice, framing and all.
    const decodes = [];
    if (single) {
      decodes.push(this.take(lo, buffer, 0, buffer.byteLength, generation));
    } else {
      const view = new DataView(buffer);
      let off = 0;
      for (let k = lo; k <= hi; k++) {
        if (off + KNCT_HEADER > buffer.byteLength) {
          throw new Error(`run ${lo}-${hi} ended at frame ${k}: the response was short`);
        }
        const magic = view.getUint32(off, true);
        if (magic !== KNCT_MAGIC) {
          throw new Error(`run ${lo}-${hi} desynced at frame ${k}: magic 0x${magic.toString(16)}`);
        }
        const len = view.getUint32(off + 8, true);
        decodes.push(this.take(k, buffer, off + KNCT_HEADER, len, generation));
        off += KNCT_HEADER + len;
      }
    }
    await Promise.all(decodes);
    counters.framesFetched += decodes.length;
  }

  /** One payload into the cache. The depth block is copied out or it pins the run's buffer. */
  async take(k, buffer, offset, length, generation) {
    const view = new DataView(buffer, offset, length);
    const depthBytes = view.getUint32(0, true);
    const colorBytes = view.getUint32(4, true);
    if (depthBytes !== POINTS * 2) {
      throw new Error(`frame ${k} carries ${depthBytes} depth bytes, expected ${POINTS * 2}`);
    }
    const depth = new Uint16Array(buffer.slice(offset + 16, offset + 16 + depthBytes));
    let bitmap = null;
    if (colorBytes > 0) {
      const jpeg = new Uint8Array(buffer, offset + 16 + depthBytes, colorBytes);
      try {
        counters.bitmapDecodes++;
        bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      } catch {
        /** a torn JPEG from a dropped USB packet: this frame renders depth only */
      }
    }
    if (generation !== this.generation) {
      bitmap?.close();
      return;
    }
    this.cache.set(k, { depth, bitmap });
  }

  /** Drops the oldest frames nothing has claimed, skipping every bound bitmap. */
  trim(maxDrops = Infinity) {
    const capacity = this.capacity;
    if (this.cache.size <= capacity) return;
    // Every clip's pair and not the selected one's: two clips of one take share this cache, so a
    // trim reading only the bindings in front of it would close a bitmap another clip is drawing.
    const bound = boundBitmaps();
    let dropped = 0;
    for (const k of this.cache.keys()) {
      if (this.cache.size <= capacity || dropped >= maxDrops) break;
      let claimed = false;
      for (const [a, b] of this.claims) claimed = claimed || (k >= a && k <= b);
      if (claimed) continue;
      const frame = this.cache.get(k);
      if (frame.bitmap && bound.includes(frame.bitmap)) continue;
      frame.bitmap?.close();
      this.cache.delete(k);
      dropped++;
    }
  }

}

/**
 * One clip's walk through an open take: where it has got to, and which cloud the bytes land in.
 *
 * Everything from `createImageBitmap` back is the take's and shared; everything from the texture
 * bind forward is this clip's, because two clips of one take at different local times need
 * different frames in front of their own shaders.
 */
class IndexedPairSource extends StampedPairSource {
  constructor(take) {
    super(take.times);
    this.take = take;
  }

  get id() { return this.take.id; }

  get index() { return this.take.index; }

  /** The frames decoded for this take, which every clip cut on it shares. */
  get cache() { return this.take.cache; }

  resident(a, b) { return this.take.resident(a, b); }

  ensure(a, b) { return this.take.ensure(a, b); }

  makeCurrent(k) {
    const frame = this.take.frame(k);
    if (!frame) throw new Error(`frame ${k} is not resident: ensure() was not awaited`);
    bindDepth(frame.depth);
    // Colour arrives at half the depth rate, so a frame without a JPEG leaves the pair alone.
    if (frame.bitmap) bindColor(frame.bitmap);
  }
}

// 1% of the previous image. Three's pass zeroes anything under 0.1 outright.
const AFTERIMAGE_RESIDUAL = 0.01;

// The most output frames one tick may render to catch up.
const CATCHUP_FRAMES = 4;
// How far behind real time playback has to fall before it says so.
const SEEK_REPLANS = 2;
// How many stand-downs in a row before this is a seek that cannot converge.
const SEEK_OVERTAKEN_LIMIT = 12;

// The arithmetic of the last cap said out loud, so a seek that keeps capping says it once.
let cappedSeekSaid = '';

/** Says which take's cache held a pre-roll short, because a capped pre-roll has not converged. */
function reportCappedSeek(seek) {
  const bound = seek.bound;
  const said = bound
    ? `${bound.take} ${bound.clips} ${bound.frames} ${seek.shortfall}`
    : `- ${seek.shortfall}`;
  if (said === cappedSeekSaid) return;
  cappedSeekSaid = said;
  say(bound
    ? `pre-roll ${seek.shortfall} frames short: ${bound.clips} clip(s) on take ${bound.take} `
      + `ask its cache for ${bound.frames} frames and it holds ${bound.ceiling}`
    : `pre-roll ${seek.shortfall} frames short of the ${seek.asked} it computed`);
}

/**
 * The playhead, the output grid and the renderer, for the whole project.
 *
 * Everything here is one per project rather than one per clip: the output rate is the edit's own
 * coordinate, and `exclusive` serialises the renderer, so two of these would interleave
 * `setRenderTarget` calls. What belongs to one clip - its frames, its walk cursor, how far its
 * source timing reaches back - it asks the clip for.
 */
class TimelineTransport {
  constructor() {
    this.outputFps = 30;
    // The fetch in flight per clip. A take's own queue is what stops two clips of one take
    // fetching its bytes twice; this only stops one clip piling requests on itself.
    this.prefetching = new Map();
    // The playhead is an integer output frame, so playback and a seek walk the same grid.
    this.frame = 0;
    this.playing = false;
    // A play awaiting the seek a draft forces is one the toggle has to be able to cancel.
    this.pendingPlay = false;
    this.playGen = 0;
    this.nextDueMs = 0;
    // Raised by a draft, because a draft is deliberately not the true image.
    this.drafted = false;
    this.lastSeek = null;
    this.lastCostMs = 0;
    // How far playback is behind real time, in wall milliseconds. Reported, never skipped.
    this.behindMs = 0;
    this.overtaken = 0;
    this.queue = null;
    this.working = false;
    this.faults = 0;
    this.looping = false;
    this.previewed = false;
  }

  get programSec() { return this.frame / this.outputFps; }

  /** The clip the panel and the lanes are pointed at. */
  get clip() { return selectedClip; }

  /** Program seconds, which is where the last clip stops. Each clip's end says where. */
  get duration() {
    let end = 0;
    for (const clip of clips) if (Number.isFinite(clip.end)) end = Math.max(end, clip.end);
    return end;
  }

  get lastFrame() { return Math.max(0, Math.floor(this.duration * this.outputFps)); }

  /** Clip range in program seconds, read from the document. */
  get clipInSec() { return Math.max(0, Number(clipIn) || 0); }
  get clipOutSec() { return clipOut === null ? this.duration : Math.min(this.duration, clipOut); }

  /** Program seconds onto the output grid, bounded by the take and by nothing else. */
  frameOf(programSec) {
    return Math.max(0, Math.min(this.lastFrame, Math.round(programSec * this.outputFps)));
  }

  frameAt(programSec) {
    return this.frameOf(Math.max(this.clipInSec, Math.min(this.clipOutSec, programSec)));
  }

  /** Everything that produces an image runs alone, in the order it was asked for. */
  async exclusive(work) {
    const run = async () => {
      this.working = true;
      try {
        return await work();
      } catch (err) {
        this.faults++;
        throw err;
      } finally {
        this.working = false;
      }
    };
    const mine = (this.queue ?? Promise.resolve()).then(run, run);
    // The chain must never reject, or one failure is inherited by everything behind it.
    this.queue = mine.catch(() => {});
    return mine;
  }

  /** Resolves once nothing this transport started is still running. */
  idle() { return this.queue ?? Promise.resolve(); }

  /**
   * How many output frames have to be rendered and discarded ahead of a seek.
   *
   * The two halves have different owners. Surface memory is per cloud, so the surface half is
   * asked of each clip drawn here. A clip already inside its warm window needs the elapsed part
   * of that window rebuilt too. The project's surface half is the longest of them - one clip's
   * timing can need three times another's to cover the same span of persistence. The afterimage
   * is one screen-space buffer over the whole composite, so the trails half is asked once.
   */
  preroll(programSec = this.programSec) {
    let surface = 0;
    let surfaceCovered = true;
    for (const clip of clipsActiveAt(programSec)) {
      const showing = clipShowingAt(clip, programSec);
      if (showing === 'warming') {
        const warmFrames = clip.warmFrames(this.outputFps, this.lastFrame);
        const warmStartFrame = Math.max(0, Math.ceil(
          (clip.start - warmFrames / this.outputFps - CLIP_EDGE) * this.outputFps,
        ));
        surface = Math.max(surface, this.frameOf(programSec) - warmStartFrame);
        continue;
      }
      // Read from this clip's tracks at the target: the uniforms hold whatever the last render
      // left, and persistence is a clip value, so it is this clip's rather than the selection's.
      const surfaceSec = (valueAtProgram('fade', programSec, clip)
        + valueAtProgram('wake', programSec, clip)) / 1000;
      const back = clip.surfaceFramesBack(programSec, surfaceSec, this.outputFps, this.lastFrame);
      surface = Math.max(surface, back.frames);
      surfaceCovered = surfaceCovered && back.covered;
    }
    const back2 = this.trailsFramesBack(programSec);
    const trails = back2.frames;
    const back3 = this.moshFramesBack(programSec);
    const frames = Math.max(surface, trails, back3.frames);
    return {
      surface,
      surfaceCovered,
      trails,
      trailsCovered: back2.covered,
      mosh: back3.frames,
      moshCovered: back3.covered,
      frames,
      sec: frames / this.outputFps,
    };
  }

  /**
   * How many output frames back the mosh pass is decoded from: the nearest frame it refreshes on,
   * which is where its history stops mattering. The walk itself is in `web/mosh-pass.js`, beside
   * the pass whose memory it bounds and where bare node can reach it.
   */
  moshFramesBack(programSec) {
    return moshFramesBack(
      programSec, this.outputFps, moshLiveAt, moshPeriodAt, Math.max(1, this.lastFrame),
    );
  }

  /**
   * The run of source frames each clip walks over a window of output frames, one entry per clip.
   *
   * Per clip and contiguous, because that is what a fetch asks for. The take rides along because
   * the cache does not: two clips of one take share one, and how much of it they are asking for
   * between them is a question about the take rather than about either clip.
   */
  spansOver(startFrame, targetFrame) {
    const spans = [];
    for (const clip of clips) {
      let first = null;
      let last = null;
      for (let k = startFrame; k <= targetFrame; k++) {
        const t = k / this.outputFps;
        if (clipShowingAt(clip, t) === 'off') continue;
        if (first === null) first = t;
        last = t;
      }
      if (first === null) continue;
      spans.push({
        clip,
        take: clip.source.take ?? clip.source,
        source: clip.source,
        from: clip.sourceFrameAt(first),
        to: clip.sourceFrameAt(last) + 1,
      });
    }
    return spans;
  }

  /**
   * How many frames each take is being asked to hold at once, keyed by the take.
   *
   * Counted rather than spanned: a cache is a map from frame number to frame, so two clips of
   * one take at opposite ends of it are asking for the frames they name and not for everything
   * between them. Measuring that as a span refused windows the cache holds comfortably.
   */
  frameLoad(spans) {
    return frameLoadByTake(spans);
  }

  /**
   * Tells every open take how many frames the current plan asks it to hold.
   *
   * The cache is the take's and the demand is the plan's, so a take cannot work this out for
   * itself: it does not know which clips are cut on it, let alone how far back each one's
   * persistence reaches. Written before the fetch, because a trim runs inside one. A take absent
   * from the plan returns to the floor immediately rather than carrying the last plan's demand.
   */
  askFor(spans) {
    const load = this.frameLoad(spans);
    for (const [take, frames] of load) take.setDemand(frames);
    for (const take of openTakes.values()) {
      if (load.has(take)) continue;
      take.setDemand(0);
    }
  }

  /** Whether every take a plan names already holds the frames the plan walks. */
  resident(spans) { return spans.every(({ source, from, to }) => source.resident(from, to)); }

  /** Puts every span a plan names in its take's cache. Serialised per take by the take itself. */
  fetch(spans) {
    this.askFor(spans);
    return Promise.all(spans.map(({ source, from, to }) => source.ensure(from, to)));
  }

  /** How many output frames back the afterimage is rebuilt from for nothing before to show. */
  trailsFramesBack(programSec) {
    if (!(valueAtProgram('trails', programSec) > 0)) return { frames: 0, covered: true };
    const ceiling = Math.max(1, this.lastFrame);
    let product = 1;
    for (let n = 1; n <= ceiling; n++) {
      product *= valueAtProgram('trails', programSec - (n - 1) / this.outputFps);
      if (product <= AFTERIMAGE_RESIDUAL) return { frames: n, covered: true };
    }
    return { frames: ceiling, covered: false };
  }

  /**
   * The true image at a program position: clear both paths, render forward from
   * far enough back.
   */
  seek(programSec, options = {}) {
    return this.exclusive(() => this.seekNow(programSec, options));
  }

  /** An accurate render at wherever the playhead is when this runs, not when it was called. */
  seekHere(options = {}) {
    return this.exclusive(() => this.seekNow(this.programSec, options));
  }

  /** `seekHere` plus the question a seek does not ask: whether anything still needs drawing. */
  repaintHere(askedAtRenders = counters.renders, askedAtFaults = this.faults) {
    return this.exclusive(() => {
      const overtaken = counters.renders !== askedAtRenders && this.faults === askedAtFaults;
      if (overtaken && !this.drafted) return null;
      return this.seekNow(this.programSec);
    });
  }

  /** Which output frames a seek renders and which source frames they need. */
  planSeek(programSec, frames) {
    const target = this.frameAt(programSec);
    const t = target / this.outputFps;
    const plan = this.preroll(t);
    const asked = frames ?? plan.frames;
    let start = Math.max(0, target - asked);
    const fits = (at) => [...this.frameLoad(this.spansOver(at, target)).values()]
      .every((held) => held <= MAX_SPAN_FRAMES);

    // Walked in from the head until every take's span fits its cache. Bisected rather than
    // stepped: on a slow clip the window is the whole edit and stepping it is quadratic.
    if (!fits(start)) {
      let lo = start;
      let hi = target;
      while (lo < hi) {
        const mid = integerMidpoint(lo, hi);
        if (fits(mid)) hi = mid;
        else lo = mid + 1;
      }
      start = lo;
    }
    const spans = this.spansOver(start, target);
    // The take asking its cache for the most, which is the one that binds when a seek is capped.
    let bound = null;
    for (const [take, frames] of this.frameLoad(spans)) {
      if (bound && frames <= bound.frames) continue;
      bound = {
        take: take.id ?? null,
        clips: spans.filter((span) => span.take === take).length,
        frames,
        ceiling: MAX_SPAN_FRAMES,
      };
    }
    return { target, t, plan, asked, length: target - start, start, spans, bound };
  }

  async seekNow(programSec, options = {}) {
    // Planned, fetched, then planned again: a clip's speed, in-point or start can move under
    // the await.
    let planned = this.planSeek(programSec, options.frames);
    this.askFor(planned.spans);
    for (let attempt = 0; !this.resident(planned.spans); attempt++) {
      if (attempt >= SEEK_REPLANS) {
        // Overtaken, not broken: the hand that moved the clip timing has already queued a repaint.
        this.overtaken++;
        if (this.overtaken > SEEK_OVERTAKEN_LIMIT) {
          this.overtaken = 0;
          throw new Error(
            `${SEEK_OVERTAKEN_LIMIT} seeks in a row were overtaken before they could land: `
            + 'the span a seek plans is not becoming resident, which is not a moving clip',
          );
        }
        requestRepaint();
        return null;
      }
      await this.fetch(planned.spans);
      planned = this.planSeek(programSec, options.frames);
      this.askFor(planned.spans);
    }
    const { target, t, plan, asked, spans, bound } = planned;
    const { length, start } = planned;

    const began = performance.now();
    counters.seeks++;
    // The reset marks every clip idle, so each one is cleared and positioned on the frame it
    // enters on rather than from here - which is the same door a cut under playback goes through.
    resetAccumulators();
    advanceNavigation(t);
    for (let k = start; k <= target; k++) {
      renderProgramFrame(k / this.outputFps);
      if (options.checkpoint) await options.checkpoint();
    }

    this.lastCostMs = performance.now() - began;
    this.overtaken = 0;
    this.frame = target;
    this.drafted = false;
    this.previewed = false;
    this.lastSeek = {
      target, start, frames: length, plan,
      clamped: asked > target,
      capped: length < Math.min(asked, target),
      shortfall: Math.min(asked, target) - length,
      // Which take's cache held the window down, and the arithmetic that says so.
      bound,
      sourceFrames: spans.reduce((n, span) => n + (span.to - span.from + 1), 0),
      takes: new Set(spans.map((span) => span.take)).size,
    };
    if (this.lastSeek.capped) reportCappedSeek(this.lastSeek);
    this.paint();
    return this.lastSeek;
  }

  /** One frame with the accumulators bypassed, for the length of a drag. */
  draft(programSec) {
    return this.exclusive(() => this.draftNow(programSec));
  }

  /** Whether every clip a program position touches already stands exactly on that frame. */
  standingAt(t) {
    return clipsActiveAt(t).every((clip) => clip.showing !== 'off'
      && clip.source.applied === clip.sourceFrameAt(t) + 1);
  }

  async draftNow(programSec) {
    let target = this.frameAt(programSec);
    let t = target / this.outputFps;
    let spans = this.spansOver(target, target);
    this.askFor(spans);
    for (let attempt = 0; !this.resident(spans); attempt++) {
      if (attempt >= SEEK_REPLANS) {
        throw new Error(`a clip's timing moved under ${SEEK_REPLANS} plans of a draft at ${programSec}s`);
      }
      await this.fetch(spans);
      target = this.frameAt(programSec);
      t = target / this.outputFps;
      spans = this.spansOver(target, target);
      this.askFor(spans);
    }
    const standing = target === this.frame && this.standingAt(t);

    const began = performance.now();
    // Borrow, render and hand back, asking for no repaint: these writes are the transport's.
    withoutRepaint(() => {
      const held = params.values(BYPASSED);
      params.apply(BYPASS_ZERO);
      borrowed = BYPASSED_SET;
      try {
        // The reset is what lets a drag go backwards.
        if (!standing || this.previewed) resetAccumulators();
        advanceNavigation(t);
        renderProgramFrame(t);
        drawChrome();
      } finally {
        borrowed = null;
        params.apply(held);
      }
    });

    this.lastCostMs = performance.now() - began;
    counters.drafts++;
    this.frame = target;
    this.drafted = true;
    this.previewed = false;
    this.paint();
    return this.lastCostMs;
  }

  /** Rebuilds the parked viewport after navigation, without the scrub draft's look. */
  redrawHere() {
    return this.exclusive(() => this.redrawNow(this.programSec));
  }

  async redrawNow(programSec) {
    counters.navigationRedraws++;
    const target = this.frameAt(programSec);
    const t = target / this.outputFps;
    if (this.previewed || this.drafted || valueAtProgram('trails', t) > 0 || moshLiveAt(t)
        || target !== this.frame || !this.standingAt(t)) {
      return this.seekNow(t);
    }

    const began = performance.now();
    advanceNavigation(t);
    renderProgramFrame(t);
    this.lastCostMs = performance.now() - began;
    this.frame = target;
    this.drafted = false;
    this.paint();
    return this.lastCostMs;
  }

  /**
   * One output frame forward, or false if there is nothing to advance to.
   *
   * A render waits for every clip it would touch, drawn or warming, and never draws the ones
   * whose bytes happened to have arrived. That is the export's rule adopted for playback too:
   * with more than one clip the difference between the two policies is which clips are in the
   * frame, which is a different image rather than a later one.
   */
  step() {
    const next = this.frame + 1;
    if (next > this.lastFrame) return false;
    const t = next / this.outputFps;
    if (t > this.clipOutSec + 1e-9) return false;
    const navigating = this.playing && !exporting && !PREVIEW_RENDERER;
    if (navigating) {
      advanceNavigation(t);
      if (previews?.show(next)) {
        noteViewportFrame();
        evaluating = true;
        try { evaluateTracks(t); } finally { evaluating = false; }
        this.frame = next;
        this.previewed = true;
        chromeStale = true;
        drawChrome();
        return true;
      }
      if (this.previewed) {
        const gen = this.playGen;
        // A frame the cache holds but has not decoded yet is a stall, like a source frame in flight.
        if (previews.pending(next)) return false;
        this.seek(t).then(() => {
          if (this.playing && gen === this.playGen) this.nextDueMs = performance.now() + 1000 / this.outputFps;
        }).catch(showTimelineError);
        return false;
      }
    }
    for (const clip of clipsActiveAt(t)) {
      const want = clip.sourceFrameAt(t) + 1;
      // A clip that has not entered yet walks from where it enters rather than from a cursor
      // some earlier pass left behind.
      if (clip.showing === 'off') {
        if (!clip.source.resident(want - 1, want)) return false;
        continue;
      }
      // A span that runs backwards is unwalkable, and the residency test cannot tell.
      if (want < clip.source.applied) {
        throw new Error(
          `playback at ${t.toFixed(3)}s wants source frame ${want} of clip ${clip.id} while the `
          + `accumulators have consumed ${clip.source.applied}: the clip runs backwards here`,
        );
      }
      if (!clip.source.resident(clip.source.applied + 1, want)) return false;
    }
    if (!navigating) advanceNavigation(t);
    renderProgramFrame(t);
    this.frame = next;
    return true;
  }

  /** One turn of the animation loop, and the only place in this file that catches broadly. */
  tick(nowMs = performance.now()) {
    try {
      this.tickNow(nowMs);
    } catch (err) {
      this.playing = false;
      this.paint();
      showTimelineError(err);
    }
  }

  tickNow(nowMs) {
    if (!this.playing) return;
    if (this.working) {
      this.prefetch();
      return;
    }
    // Every frame that has come due is rendered, up to a cap. Only the last reaches the screen.
    let rendered = 0;
    while (nowMs >= this.nextDueMs && rendered < CATCHUP_FRAMES) {
      if (!this.step()) break;
      this.nextDueMs += 1000 / this.outputFps;
      rendered++;
    }
    if (rendered > 0) this.paint();
    else if (this.frame >= this.lastFrame || this.programSec >= this.clipOutSec - 1e-9) {
      if (this.looping) this.seek(this.clipInSec).catch(showTimelineError);
      else this.pause();
    }
    this.behindMs = Math.max(0, nowMs - this.nextDueMs);
    this.prefetch();
  }

  /**
   * The window every take the playhead is about to reach is asked to keep filled.
   *
   * The window looks across the clip boundary rather than at the clip under the playhead, so a
   * clip that has to warm before its in-point has its frames resident when the warm starts -
   * otherwise the warm stalls on bytes at exactly the cut it exists to smooth.
   */
  prefetch() {
    let wanted;
    if (this.previewed) {
      previews?.prefetch(this.frame + 1);
      const end = this.frameAt(this.clipOutSec);
      const ahead = Math.min(end, this.frame + PREFETCH_FRAMES);
      const missing = previews?.firstMissing(this.frame + 1, ahead);
      const target = missing ?? (ahead === end ? (this.looping ? this.frameAt(this.clipInSec) : end) : null);
      if (target === null) return null;
      wanted = this.planSeek(target / this.outputFps).spans;
    } else wanted = this.planPrefetch().spans;
    this.askFor(wanted);
    const waits = [];
    for (const span of wanted) {
      const held = this.prefetching.get(span.clip);
      if (held) {
        waits.push(held);
        continue;
      }
      const { from, to } = span;
      if (span.source.resident(from, to)) continue;
      const fetching = span.source.ensure(from, to)
        .catch((err) => showTimelineError(err))
        .finally(() => {
          if (this.prefetching.get(span.clip) === fetching) this.prefetching.delete(span.clip);
        });
      this.prefetching.set(span.clip, fetching);
      waits.push(fetching);
    }
    return waits.length === 0 ? null : Promise.all(waits);
  }

  /** The furthest common playback horizon whose per-take frame union fits each shared cache. */
  planPrefetch() {
    const ahead = Math.min(this.lastFrame, this.frame + PREFETCH_FRAMES);
    const planned = (target) => this.spansOver(this.frame, target).map((span) => {
      // Where the walk stands, for a clip already drawing; where it enters, for one that is not.
      const from = span.clip.showing === 'off'
        ? span.from
        : Math.max(0, Math.min(span.clip.source.applied, span.from));
      return { ...span, from };
    });
    const full = planned(ahead);
    const fits = (spans) => [...this.frameLoad(spans).values()]
      .every((frames) => frames <= MAX_SPAN_FRAMES);
    const current = planned(this.frame);
    if (!fits(current)) {
      const bound = Math.max(...this.frameLoad(current).values());
      throw new Error(
        `the current playback frame asks one take for ${bound} decoded frames and its cache holds `
        + `${MAX_SPAN_FRAMES}: the source walks cannot advance together`,
      );
    }
    let target = ahead;
    if (!fits(full)) {
      let lo = this.frame;
      let hi = ahead;
      while (lo < hi) {
        const mid = integerMidpoint(lo, hi, true);
        if (fits(planned(mid))) lo = mid;
        else hi = mid - 1;
      }
      target = lo;
    }
    const spans = target === ahead ? full : planned(target);
    return {
      ahead,
      target,
      spans,
      fullLoad: this.frameLoad(full),
      load: this.frameLoad(spans),
    };
  }

  /** Playback with the wall clock out: every output frame in order, as fast as bytes arrive. */
  runTo(toFrame) {
    return this.exclusive(() => this.runToNow(toFrame));
  }

  async runToNow(toFrame) {
    const limit = Math.min(toFrame, this.lastFrame);
    let stalls = 0;
    while (this.frame < limit) {
      if (this.step()) {
        stalls = 0;
        continue;
      }
      if (++stalls > 200) throw new Error(`playback stalled at output frame ${this.frame}`);
      await (this.prefetch() ?? new Promise((r) => setTimeout(r, 0)));
    }
    this.paint();
    return this.frame;
  }

  async play() {
    if (this.playing || this.pendingPlay) return;
    this.behindMs = 0;
    const gen = this.playGen;
    this.pendingPlay = true;
    try {
      // A draft is not what playback would have produced, so it cannot seed the afterimage.
      if (this.drafted) await this.seek(this.programSec);
      // Keep playback inside the clip's in/out points.
      if (this.programSec < this.clipInSec || this.programSec > this.clipOutSec) {
        await this.seek(this.clipInSec);
      }
      const warming = previews?.warm(this.frame + 1);
      if (warming) await warming;
    } finally {
      this.pendingPlay = false;
    }
    if (gen !== this.playGen) {
      this.paint();
      return;
    }
    this.playing = true;
    this.nextDueMs = performance.now();
    this.paint();
  }

  pause() {
    this.playGen += 1;
    this.playing = false;
    if (this.previewed && !this.working) this.seek(this.programSec).catch(showTimelineError);
    this.paint();
  }

  paint() { paintTimeline(this); }
}

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // Marked handled, so a failure nobody awaits yet surfaces at the next await.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

/** The wire and its flow control. Raw RGBA out, and the server acks each frame. */
class ExportSink {
  constructor(begin) {
    this.ready = deferred();
    this.done = deferred();
    this.window = 1;
    this.sent = 0;
    this.acked = 0;
    this.waiting = null;
    this.failure = null;
    this.finished = false;
    const socket = new WebSocket(`ws://${location.host}/export`);
    socket.binaryType = 'arraybuffer';
    socket.onopen = () => socket.send(JSON.stringify({ begin }));
    socket.onmessage = (event) => this.receive(JSON.parse(event.data));
    socket.onerror = () => this.fail(new Error('the export socket failed'));
    socket.onclose = () => this.fail(new Error('the export socket closed before the encode finished'));
    this.socket = socket;
  }

  receive(msg) {
    if (msg.error) {
      this.fail(new Error(msg.error));
    } else if (msg.ready) {
      this.window = msg.ready.window;
      this.ready.resolve(msg.ready);
    } else if (msg.ack) {
      this.acked = msg.ack;
      const waiter = this.waiting;
      this.waiting = null;
      waiter?.resolve();
    } else if (msg.done) {
      this.finished = true;
      this.done.resolve(msg.done);
    }
  }

  fail(err) {
    if (this.failure || this.finished) return;
    this.failure = err;
    this.ready.reject(err);
    this.done.reject(err);
    this.waiting?.reject(err);
    this.socket.close();
  }

  /** Hands one frame to the wire and returns once the pipe has room for the next. */
  async send(pixels) {
    if (this.failure) throw this.failure;
    // `send` queues a copy, which lets the readback reuse one buffer for the whole export.
    this.socket.send(pixels);
    this.sent++;
    while (!this.failure && this.sent - this.acked >= this.window) {
      this.waiting = deferred();
      await this.waiting.promise;
    }
  }

  async finish() {
    if (this.failure) throw this.failure;
    this.socket.send(JSON.stringify({ end: true }));
    return this.done.promise;
  }
}

class ExportTransport {
  constructor(transport, options) {
    this.transport = transport;
    this.width = options.width;
    this.height = options.height;
    this.fps = options.fps;
    this.from = options.from;
    this.to = options.to;
    this.onProgress = options.onProgress ?? (() => {});
    // One buffer for the run. `readPixels` stalls the pipeline, which is accepted at export.
    this.pixels = new Uint8Array(options.width * options.height * 4);
  }

  /** Every frame in order, each read back in the same task as the render that made it. */
  async run(sink) {
    for (let n = this.from; n <= this.to; n++) {
      const at = n / this.fps;
      frameSink = { t: at, pixels: this.pixels, hits: 0 };
      let hits = 0;
      try {
        if (n === this.from) await this.transport.seek(at);
        else await this.transport.runTo(n);
      } finally {
        hits = frameSink.hits;
        frameSink = null;
      }
      if (hits !== 1) {
        throw new Error(`the render at ${at.toFixed(6)}s reached the export ${hits} times, not once`);
      }
      await sink.send(this.pixels);
      this.onProgress(n - this.from + 1, this.to - this.from + 1);
    }
    return this.to - this.from + 1;
  }
}

const rendererClass = () => {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};

function previewPose(camera) {
  return {
    position: camera.position.toArray(), quaternion: camera.quaternion.toArray(),
    fov: camera.fov, near: camera.near, far: camera.far,
  };
}

function previewRendererIdentity() {
  const gl = renderer.getContext();
  return JSON.stringify({ gpu: rendererClass(), webgl: gl.getParameter(gl.VERSION),
    shader: gl.getParameter(gl.SHADING_LANGUAGE_VERSION), browser: navigator.userAgent,
    platformVersion: previewBrowserBuild?.platformVersion ?? null,
    versions: [...(previewBrowserBuild?.fullVersionList ?? [])].sort((a, b) => a.brand.localeCompare(b.brand)),
  });
}

function previewView() {
  const gl = renderer.getContext();
  return {
    camera: viewCamera === freeCamera
      ? { kind: 'free', pose: previewPose(freeCamera) }
      : { kind: 'program', pose: projectLook.tracks.get('camera')?.keys.length ? null : previewPose(programCamera) },
    width: gl.drawingBufferWidth,
    height: gl.drawingBufferHeight,
    cropOutside: clips.map((clip) => withClip(clip, () => uniforms.cropOutside.value)),
    effects: effectSignature,
  };
}

function setupPreviews() {
  previews = createPreviews({
    stage: renderer.domElement,
    closeMenu: closeApplicationMenus,
    pause: pauseTransport,
    settle: () => timeline.idle(),
    report: say,
    describe: () => (timeline && takeOpened && clips.length > 0 ? {
      project: serialiseProjectBody(), ...previewView(), renderer: previewRendererIdentity(),
    } : null),
    viewStamp: () => JSON.stringify(previewView()),
    state: () => (timeline ? {
      frame: timeline.frame, fps: timeline.outputFps, duration: timeline.duration,
      viewStart: view.startSec, viewEnd: view.endSec,
      from: timeline.frameAt(timeline.clipInSec), to: timeline.frameAt(timeline.clipOutSec),
      playing: timeline.playing || timeline.pendingPlay,
      busy: timeline.working || repaintBusy || draftBusy || presetGesture,
      moving: orbiting || orbitSettling || flying() || lookDrag !== null || scrubbing,
      blocked: exporting || gizmoMode !== null || cropDrag !== null || nodeDrag !== null
        || (viewCamera === freeCamera && controls.autoRotate) || missingEffects().length > 0,
    } : null),
  });
}

let previewRender = null;

/** The hidden renderer accepts the same document door as an export worker. */
async function preparePreview(snapshot) {
  if (!PREVIEW_RENDERER) throw new Error('Preview rendering needs its own renderer.');
  snapshot = structuredClone(snapshot);
  exporting = false;
  previewRender = null;
  await pollEffects();
  if (effectSignature !== snapshot.effects || previewRendererIdentity() !== snapshot.renderer) {
    throw new Error('The preview renderer does not match the editor. Reload the editor.');
  }
  const version = await (await fetch('/preview/renderer', { cache: 'no-store' })).json();
  if (version.version !== snapshot.version) throw new Error('The renderer changed. Reload the editor before rendering previews.');
  await loadProjectNamed('preview', snapshot.project);
  await timeline.idle();
  if (missingEffects().length) throw new Error('Install the missing effects before rendering previews.');
  exporting = true;
  repaintWanted = false;
  writeClipRange({ in: 0, out: null }, timeline.duration);
  chromeOn = false;
  placeChrome();
  outputSize = { w: snapshot.width, h: snapshot.height };
  resize();
  const camera = snapshot.camera.kind === 'free' ? freeCamera : programCamera;
  if (snapshot.camera.pose) {
    const pose = snapshot.camera.pose;
    camera.position.fromArray(pose.position);
    camera.quaternion.fromArray(pose.quaternion);
    camera.fov = pose.fov;
    camera.near = pose.near;
    camera.far = pose.far;
    camera.updateProjectionMatrix();
  }
  setViewCamera(camera);
  controls.enabled = false;
  clips.forEach((clip, at) => withClip(clip, () => { uniforms.cropOutside.value = snapshot.cropOutside[at]; }));
  const gl = renderer.getContext();
  if (gl.drawingBufferWidth !== snapshot.width || gl.drawingBufferHeight !== snapshot.height) {
    throw new Error('The preview renderer could not allocate the requested image size.');
  }
  const canvas = document.createElement('canvas');
  canvas.width = snapshot.width;
  canvas.height = snapshot.height;
  const context = canvas.getContext('2d', { alpha: false });
  previewRender = {
    last: -1, pixels: new Uint8Array(snapshot.width * snapshot.height * 4),
    image: context.createImageData(snapshot.width, snapshot.height), canvas, context,
  };
}

/** Read back only the requested frame; preceding frames rebuild the effect history. */
async function renderPreviewFrame(frame, checkpoint) {
  const run = previewRender;
  if (!PREVIEW_RENDERER || !run || !Number.isSafeInteger(frame) || frame < 0 || frame > timeline.lastFrame) {
    throw new Error('The preview frame is outside the prepared edit.');
  }
  const t = frame / timeline.outputFps;
  frameSink = { t, pixels: run.pixels, hits: 0 };
  try {
    if (run.last >= 0 && run.last === frame - 1) await timeline.runTo(frame);
    else {
      const seek = await timeline.seek(t, { checkpoint });
      if (seek.capped || !seek.plan.surfaceCovered || !seek.plan.trailsCovered || !seek.plan.moshCovered) {
        throw new Error('This preview could not rebuild the complete effect history.');
      }
    }
    if (frameSink.hits !== 1) throw new Error(`Preview frame ${frame} reached the image sink ${frameSink.hits} times.`);
    await checkpoint();
    run.last = frame;
    const rowBytes = run.canvas.width * 4;
    for (let row = 0; row < run.canvas.height; row++) {
      const start = (run.canvas.height - row - 1) * rowBytes;
      run.image.data.set(run.pixels.subarray(start, start + rowBytes), row * rowBytes);
    }
    run.context.putImageData(run.image, 0, 0);
    const plans = Object.fromEntries(clips.map((clip) => [clip.id, withClip(clip, () => {
      const depth = depthCurr.image.data;
      const sample = new Uint16Array(Math.ceil(DEPTH_H / PLAN_STRIDE) * Math.ceil(DEPTH_W / PLAN_STRIDE));
      let at = 0;
      for (let row = 0; row < DEPTH_H; row += PLAN_STRIDE) {
        for (let col = 0; col < DEPTH_W; col += PLAN_STRIDE) sample[at++] = depth[row * DEPTH_W + col];
      }
      return sample;
    })]));
    const blob = await new Promise((resolve, reject) => run.canvas.toBlob(
      (image) => image ? resolve(image) : reject(new Error('The preview image could not be encoded.')), 'image/png',
    ));
    return { blob, plans };
  } catch (err) {
    run.last = -1;
    throw err;
  } finally {
    frameSink = null;
  }
}

/** A `WIDTHxHEIGHT` string as a pair, with 0 for whichever half is not a size. */
function parseSize(text) {
  const [w, h] = String(text).split('x').map(Number);
  return { w: w > 0 ? w : 0, h: h > 0 ? h : 0 };
}

async function exportClip(options = {}) {
  if (!timeline) throw new Error('there is no clip open to export');
  if (exporting) throw new Error('an export is already running');
  // A clip whose look this build cannot render whole is refused before anything is encoded.
  const suppress = new Set(options.suppressEffects ?? []);
  const missing = missingEffects();
  const blocking = missing.filter((m) => !suppress.has(m.id));
  if (blocking.length) {
    throw new Error(
      `this clip requires ${blocking.map((m) => `${m.id} ${m.version}`).join(', ')}, which `
      + `${blocking.length === 1 ? 'is' : 'are'} not installed here: its values are parked and `
      + 'nothing is drawing them, so a render would be a file missing part of the look with '
      + `nothing in it to say so. Install ${blocking.length === 1 ? 'it' : 'them'}, or suppress `
      + `${blocking.length === 1 ? 'it' : 'each of them'} in the badge to render without.`,
    );
  }
  const suppressed = missing
    .filter((m) => suppress.has(m.id))
    .map(({ id, version }) => ({ id, version }));
  ensureActiveDeliverable();
  const d = activeDeliverable;
  const requested = options.outputSize ?? d.outputSize;
  const deliverableSize = parseSize(requested);
  const width = Math.trunc(options.width ?? deliverableSize.w);
  const height = Math.trunc(options.height ?? deliverableSize.h);
  const effective = reduceAspect(width, height);
  if (!sameAspect(effective, projectAspect)) {
    const asked = options.width === undefined && options.height === undefined
      ? `the deliverable renders ${requested}`
      : `this render was asked for at ${width}x${height}`;
    throw new Error(
      `this clip is framed at ${projectAspect.join(':')} and ${asked}, which is `
      + `${effective.join(':')}: pick a resolution of the project's shape in Export, or change `
      + 'the shape in Project settings',
    );
  }
  const fps = options.fps ?? timeline.outputFps;
  const codec = options.codec ?? d.codec ?? 'h264';

  const restore = {
    outputFps: timeline.outputFps,
    programSec: timeline.programSec,
    chrome: chromeOn,
    camera: viewCamera,
  };

  exporting = true;
  paintGizmo();
  pauseTransport();
  try {
    // The rate first, because every position below is named on the output rate's grid.
    timeline.outputFps = fps;
    const inSec = options.in !== undefined ? options.in : d.in;
    const outSec = options.out !== undefined ? options.out : d.out;
    const inFrame = timeline.frameAt(Number(inSec) || 0);
    const outFrame = timeline.frameAt(outSec === null ? timeline.duration : outSec);
    const from = Math.max(inFrame, Math.min(outFrame, Math.trunc(options.from ?? inFrame)));
    const to = Math.max(inFrame, Math.min(outFrame, Math.trunc(options.to ?? outFrame)));
    if (to < from) throw new Error(`an export of frames ${from}..${to} has nothing in it`);

    // Composition comes from the camera track, so the export sees what the program camera does.
    setViewCamera(programCamera);
    chromeOn = false;
    placeChrome();
    outputSize = { w: width, h: height };
    resize();

    const gl = renderer.getContext();
    if (gl.drawingBufferWidth !== width || gl.drawingBufferHeight !== height) {
      throw new Error(
        `the drawing buffer is ${gl.drawingBufferWidth}x${gl.drawingBufferHeight} after asking for `
        + `${width}x${height}: the output size did not reach the renderer`,
      );
    }

    const run = new ExportTransport(timeline, {
      width,
      height,
      fps,
      from,
      to,
      // The bars are the render's own, not the button's: an export started by anything else drew
      // nothing at all while the editor refused every edit, which is the state this guard creates.
      onProgress: (n, total) => {
        exportProgress = { n, total };
        paintExportProgress();
        options.onProgress?.(n, total);
      },
    });
    const sink = new ExportSink({
      name: options.name ?? exportBaseName(),
      width,
      height,
      fps,
      frames: to - from + 1,
      codec,
      project: serialiseProjectBody(suppressed.length ? { suppressed } : {}),
      captures: clips.map((clip) => clip.source.index.hash),
      renderer: rendererClass(),
    });
    await sink.ready.promise;
    await run.run(sink);
    return await sink.finish();
  } finally {
    exporting = false;
    exportProgress = null;
    paintExportProgress();
    outputSize = null;
    resize();
    chromeOn = restore.chrome;
    placeChrome();
    setViewCamera(restore.camera);
    timeline.outputFps = restore.outputFps;
    timeline.frame = timeline.frameAt(restore.programSec);
    timingChanged();
    paintGizmo();
    requestRepaint();
  }
}

// Deliberately small: the scrubber, the playhead, play/pause, speed, and the two clocks.
const ui = {
  root: timelineEl,
  play: document.getElementById('tPlay'),
  program: document.getElementById('tProgram'),
  source: document.getElementById('tSource'),
  rate: document.getElementById('tRate'),
  rateOut: document.getElementById('tRateOut'),
  fps: document.getElementById('tFps'),
  bed: document.getElementById('tBed'),
  rail: document.getElementById('tRail'),
  beds: document.getElementById('tBeds'),
  // The two containers the lane rebuild owns and empties.
  railLanes: document.getElementById('tRailLanes'),
  lanes: document.getElementById('tLanes'),
  ruler: document.getElementById('tRuler'),
  grip: document.getElementById('tGrip'),
  mini: document.getElementById('tMini'),
  miniRange: document.getElementById('tMiniRange'),
  miniMarks: document.getElementById('tMiniMarks'),
  miniHead: document.getElementById('tMiniHead'),
  miniWin: document.getElementById('tMiniWin'),
  playhead: document.getElementById('tPlayhead'),
  in: document.getElementById('tIn'),
  out: document.getElementById('tOut'),
  shadeIn: document.getElementById('tShadeIn'),
  shadeOut: document.getElementById('tShadeOut'),
  note: document.getElementById('tNote'),
  camKey: document.getElementById('camKey'),
  camClear: document.getElementById('camClear'),
  camView: document.getElementById('camView'),
  camLens: document.getElementById('camLens'),
  camLensOut: document.getElementById('camLensOut'),
  tCamKey: document.getElementById('tCamKey'),
  tCamView: document.getElementById('tCamView'),
  tLoop: document.getElementById('tLoop'),
  camSensor: document.getElementById('camSensor'),
  camLevelReset: document.getElementById('camLevelReset'),
  cropBox: document.getElementById('cropBox'),
  cropFit: document.getElementById('cropFit'),
  cropReset: document.getElementById('cropReset'),
  // Empty in the markup and filled by `setProjectAspect`, which knows this project's sizes.
  exportSize: document.getElementById('tExportSize'),
  projectAspects: document.getElementById('projectAspects'),
  exportFormats: document.getElementById('exportFormats'),
  exportDialog: document.getElementById('exportDialog'),
  exportGo: document.getElementById('tExport'),
  exportNote: document.getElementById('tExportNote'),
  exportBar: document.getElementById('exportBar'),
  exporting: document.getElementById('tExporting'),
  exportingBar: document.getElementById('tExportingBar'),
  exportingCount: document.getElementById('tExportingCount'),
  exportName: document.getElementById('tExportName'),
  exportNameChip: document.getElementById('tExportNameChip'),
  exportSave: document.getElementById('tExportSave'),
  exportTrim: document.getElementById('tExportTrim'),
  ease: document.getElementById('tEase'),
  clipOptions: document.getElementById('tClipOptions'),
  prevKey: document.getElementById('tPrevKey'),
  nextKey: document.getElementById('tNextKey'),
  deleteKey: document.getElementById('tDeleteKey'),
  addPoint: document.getElementById('tAddPoint'),
  dropPoint: document.getElementById('tDropPoint'),
  deliverable: document.getElementById('tDeliverable'),
  deliverableNew: document.getElementById('tDeliverableNew'),
  deliverableReadout: document.getElementById('tDeliverableReadout'),
  marks: document.getElementById('tMarks'),
  markCount: document.getElementById('tMarkCount'),
  mark: document.getElementById('tMark'),
  preset: document.getElementById('tPreset'),
  presetSave: document.getElementById('tPresetSave'),
  presetExport: document.getElementById('tPresetExport'),
  presetImport: document.getElementById('tPresetImport'),
  presetFile: document.getElementById('tPresetFile'),
  pickDialog: document.getElementById('presetPick'),
  pickTitle: document.getElementById('ppTitle'),
  pickName: document.getElementById('ppName'),
  pickGroups: document.getElementById('ppGroups'),
  pickCount: document.getElementById('ppCount'),
  pickCancel: document.getElementById('ppCancel'),
  pickGo: document.getElementById('ppGo'),
  diverged: document.getElementById('tDiverged'),
  divergedWhen: document.getElementById('tDivergedWhen'),
  divergedCopy: document.getElementById('tDivergedCopy'),
  missing: document.getElementById('tMissing'),
  recGo: document.getElementById('recGo'),
  recMark: document.getElementById('recMark'),
  recNote: document.getElementById('recNote'),
  recSpace: document.getElementById('recSpace'),
  recRange: document.getElementById('recRange'),
};

/** Clip commands moved through lane rebuilds without losing their listeners or focus. */
const stripCommand = (id, text, title) => {
  const el = document.createElement('button');
  el.type = 'button';
  el.id = id;
  el.className = 'tclipcmd';
  el.textContent = text;
  el.title = title;
  return el;
};
ui.addClip = stripCommand('tAddClip', '+', 'Add clips from Media library');
ui.addClip.classList.add('tclipadd');
ui.addClip.setAttribute('aria-label', 'Add clips');
ui.deleteClip = stripCommand('tDeleteClip', 'delete clip', 'Delete the selected clip (Del)');
ui.moveClip = stripCommand('tMoveClip', 'move', 'Move the selected clip in the room (g)');
ui.rotateClip = stripCommand('tRotateClip', 'rotate', 'Turn the selected clip in the room (g)');
// A placement is edited in the world, so it has no panel row and no keyframe control beside one.
// This is that control: without it the first key on a placement track could not be planted at all
// and the handles would only ever move a clip once.
ui.keyClip = stripCommand('tKeyClip', 'key', 'Keyframe the selected clip\'s placement at the playhead');

// Clip commands live in the dynamic controls area.
ui.clipOptions.append(ui.deleteClip, ui.moveClip, ui.rotateClip, ui.keyClip);

/**
 * The clip gizmo: three's own handles, attached to the selected clip's placement group.
 *
 * Built only on the editor and drawn over the finished picture, so a look cannot grade its
 * handles and an export cannot contain them.
 */
const gizmo = EDITING ? new TransformControls(viewCamera, renderer.domElement) : null;
const gizmoHelper = gizmo ? gizmo.getHelper() : null;
const gizmoScene = new THREE.Scene();
if (gizmo) {
  // The room's axes rather than the clip's, so a placed clip is still moved along the floor.
  gizmo.setSpace('world');
  gizmoHelper.visible = false;
  gizmoScene.add(gizmoHelper);
}

// Which handle set is armed - 'translate', 'rotate', or null for off. Session state.
let gizmoMode = null;
// The clip the handles are on, and null when they are on nothing.
let gizmoClip = null;
// A drag has moved the group and its value has not been written yet. A flag rather than a write,
// because a pointer move may never start a render: it arms one and the animation loop pumps it.
let gizmoWriteWanted = false;

/**
 * Whether the handles belong in this frame: on a clip, with the furniture on, and not exporting.
 *
 * One rule with two callers, because three draws the handles into the same scene the picture
 * comes out of - the paint below and every render ask it rather than each keeping its own answer.
 */
const gizmoShown = () => gizmoClip !== null && chromeOn && !exporting;

/** Draws the editor handles after the look, without clearing its finished colour. */
function renderGizmo() {
  if (!gizmoShown()) return;
  const autoClear = renderer.autoClear;
  renderer.autoClear = false;
  try {
    renderer.clearDepth();
    renderer.render(gizmoScene, viewCamera);
  } finally {
    renderer.autoClear = autoClear;
  }
}

/** Where the handles are, what they do, and whether they are drawn at all. */
function paintGizmo() {
  if (!gizmo) return;
  const on = gizmoMode !== null && clipRow !== null && !exporting;
  if (on) {
    gizmo.mode = gizmoMode;
    if (gizmoClip !== clipRow) {
      gizmo.attach(clipRow.transform);
      gizmoClip = clipRow;
    }
  } else if (gizmoClip) {
    gizmo.detach();
    gizmoClip = null;
  }
  gizmo.enabled = on;
  gizmoHelper.visible = gizmoShown();
  ui.moveClip.setAttribute('aria-pressed', String(gizmoMode === 'translate'));
  ui.rotateClip.setAttribute('aria-pressed', String(gizmoMode === 'rotate'));
  paintClipCommands();
  requestRepaint();
}

/** Arms one handle set, or puts the handles away when it is already the one showing. */
function setGizmoMode(mode) {
  gizmoMode = gizmoMode === mode ? null : mode;
  paintGizmo();
}

/**
 * The drag written into the registry, once per animation frame.
 *
 * Never from the pointer event: a write asks for a repaint, a repaint renders, and a render
 * advances navigation - so writing from the event is the loop this program has already shipped
 * once. `pumpParkedDraft` calls this, which is the only thing allowed to start one.
 */
function pumpGizmo() {
  if (!gizmoWriteWanted || !gizmoClip) return;
  gizmoWriteWanted = false;
  const clip = gizmoClip;
  withClip(clip, () => {
    const applied = params.set('transform', {
      position: clip.transform.position.toArray(),
      quaternion: clip.transform.quaternion.toArray(),
    });
    const track = tracks.get('transform');
    // On the clip's own clock, so a placement keyed here travels with the clip that holds it.
    if (track && track.keys.length > 0) {
      track.setKey(playheadSec() - trackEpoch('transform', clip), applied, keyTolerance());
      lanesMoved();
    }
  });
}

if (gizmo) {
  gizmo.addEventListener('objectChange', () => { gizmoWriteWanted = true; });
  gizmo.addEventListener('dragging-changed', (e) => {
    // Both controls want the pointer, so the orbit stands down for the drag and comes back to
    // whatever the view camera says it should be - not unconditionally on.
    controls.enabled = e.value ? false : viewCamera === freeCamera;
    if (e.value) {
      // Orbit sees the shared pointerdown first; the gizmo owns this gesture from here.
      orbiting = false;
      orbitSettling = false;
      orbitRedrawWanted = false;
      return;
    }
    // The last move of the drag, then the lane rebuild and the one undo step the gesture is.
    pumpGizmo();
    lanesChanged();
    history.commit();
  });
  ui.moveClip.addEventListener('click', () => setGizmoMode('translate'));
  ui.rotateClip.addEventListener('click', () => setGizmoMode('rotate'));
  ui.keyClip.addEventListener('click', () => toggleKey('transform'));
}

// Built from `OUTPUT_RATES` rather than the markup, so there is one list of rates.
for (const rate of OUTPUT_RATES) ui.fps?.appendChild(new Option(String(rate), String(rate)));

/** The badge that says which effects this document names and this build has not got. */
function paintMissingEffects() {
  if (!ui.missing) return;
  const missing = missingEffects();
  const skew = effectVersionSkew;
  ui.missing.hidden = missing.length === 0 && skew.length === 0;
  const notices = skew.map((s) => {
    const entry = document.createElement('span');
    entry.className = 'missingfx';
    entry.dataset.skew = s.id;
    const line = document.createElement('b');
    line.textContent = `document requires ${s.id} ${s.wanted}, installed is ${s.installed}`;
    entry.append(line);
    return entry;
  });
  ui.missing.replaceChildren(...notices, ...missing.map((m) => {
    const entry = document.createElement('span');
    entry.className = 'missingfx';
    entry.dataset.effect = m.id;
    const line = document.createElement('b');
    const values = `${m.values} value${m.values === 1 ? '' : 's'}`;
    const parked = `${m.tracks} track${m.tracks === 1 ? '' : 's'} parked`;
    line.textContent = `missing: ${m.id} ${m.version} — ${values}, ${parked}`;
    const go = document.createElement('button');
    go.type = 'button';
    go.dataset.suppress = m.id;
    go.textContent = 'suppress';
    go.setAttribute('aria-pressed', String(m.suppressed));
    go.title = m.suppressed
      ? `Exports may render without ${m.id}. Press again to require it.`
      : `Export is refused while ${m.id} is missing. Press to let a render go without it.`;
    entry.append(line, go);
    return entry;
  }));
}

// One listener on the chip, because the painter rebuilds the buttons every time this fires.
ui.missing?.addEventListener('click', (event) => {
  const id = event.target?.dataset?.suppress;
  if (!id) return;
  if (suppressedEffects.has(id)) suppressedEffects.delete(id);
  else suppressedEffects.add(id);
  paintMissingEffects();
  say(suppressedEffects.has(id)
    ? `${id} suppressed: an export will render without it`
    : `${id} required again: an export is refused while it is missing`);
});

aspectButtons = buildAspectSegments(ui.projectAspects);

/** The codec keys are the server's: `CODECS` in `server/export.js` is where one is declared. */
const EXPORT_CODECS = ['h264', 'prores', 'pngseq'];

function paintExportFormats() {
  const codec = activeDeliverable?.codec ?? 'h264';
  for (const button of ui.exportFormats.querySelectorAll('button[data-codec]')) {
    button.setAttribute('aria-pressed', String(button.dataset.codec === codec));
  }
}

function setExportCodec(codec) {
  // Refused here rather than trusted, because the value comes off an attribute in the markup.
  if (!EXPORT_CODECS.includes(codec)) {
    throw new Error(`unknown export codec ${JSON.stringify(codec)}: the dialog offers ${EXPORT_CODECS.join(', ')}`);
  }
  ensureActiveDeliverable();
  activeDeliverable.codec = codec;
  paintDeliverable();
  paintExportFormats();
}

for (const button of ui.exportFormats.querySelectorAll('button[data-codec]')) {
  button.addEventListener('click', () => setExportCodec(button.dataset.codec));
}

// The chips strip hides its scrollbar, so the bar keeps its height and the lanes hold still.
for (const chips of document.querySelectorAll('.tchips')) {
  const sayMore = () => chips.classList.toggle('more', chips.scrollWidth > chips.clientWidth + 1);
  new ResizeObserver(sayMore).observe(chips);
  new MutationObserver(sayMore).observe(chips, { subtree: true, childList: true, characterData: true });
  sayMore();
}

/** What the running render has drawn, or null between renders. */
let exportProgress = null;

/**
 * The bar in the dialog and the chip in the application bar, from the one reading.
 *
 * Both, every time, because the dialog can be closed while a render runs: progress that lived
 * only in the dialog would leave an editor refusing every edit with nothing on screen saying why.
 */
function paintExportProgress() {
  const running = exportProgress !== null;
  const { n, total } = exportProgress ?? { n: 0, total: 0 };
  // A render of no frames is refused before it starts, so the guard is against a division rather
  // than against a case: `total` is only ever 0 here between renders, where the bar is hidden.
  const percent = total > 0 ? Math.round((n / total) * 100) : 0;
  for (const bar of [ui.exportBar, ui.exportingBar]) {
    if (!bar) continue;
    bar.setAttribute('aria-valuenow', String(percent));
    bar.firstElementChild.style.width = `${percent}%`;
  }
  if (ui.exportBar) ui.exportBar.hidden = !running;
  if (ui.exporting) ui.exporting.hidden = !running;
  if (ui.exportingCount) ui.exportingCount.textContent = running ? `${n}/${total}` : '';
}

const sayExport = (text) => {
  ui.exportNote.textContent = text;
  ui.exportNote.title = text;
};

/** The editor's one line of prose, and the only way anything writes it. */
function say(text) {
  if (!ui.note) return;
  ui.note.textContent = text;
  ui.note.title = text;
}

const timecode = (sec) => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
};

function showTimelineError(err) {
  say(String(err?.message ?? err));
  console.error('[timeline]', err);
}

// The window of program time the strip is drawn against.
const view = makeViewWindow({
  // Frozen for the length of either drag: moving a clip moves where the edit ends, and a ruler
  // that rescaled under the hand would carry the footage away from the gesture aimed at it.
  durationSec: () => {
    const drag = laneDrag ?? clipDrag;
    return drag ? drag.duration : (timeline ? timeline.duration : 1);
  },
  bedRect: () => ui.bed.getBoundingClientRect(),
});

/** What the chosen deliverable is, and what the press will take out of the clip. */
function paintDeliverable() {
  if (!ui.deliverableReadout) return;
  if (!activeDeliverable) {
    ui.deliverableReadout.textContent = 'none';
    if (ui.exportTrim) ui.exportTrim.textContent = '—';
    return;
  }
  const out = activeDeliverable.out ?? view.duration;
  const outStr = activeDeliverable.out === null ? 'end' : timecode(out);
  ui.deliverableReadout.textContent = `${activeDeliverable.outputSize} ${activeDeliverable.codec}`;
  if (ui.exportTrim) {
    ui.exportTrim.textContent = `${timecode(activeDeliverable.in)} - ${outStr} · `
      + `${Math.max(0, out - activeDeliverable.in).toFixed(2)}s at ${timeline ? timeline.outputFps : 30}fps`;
  }
}

/** Where on the ruler things are: the playhead, the two cuts, and the shading outside them. */
function paintStripPositions() {
  const dur = view.duration;
  const inPct = view.pct(Math.min(clipIn, dur));
  const outPct = view.pct(Math.min(clipOut ?? dur, dur));
  ui.playhead.style.left = `${view.pct(timeline ? timeline.programSec : 0)}%`;
  ui.in.style.left = `${inPct}%`;
  ui.out.style.left = `${outPct}%`;
  const lo = Math.max(0, Math.min(100, inPct));
  const hi = Math.max(0, Math.min(100, outPct));
  ui.shadeIn.style.left = '0%';
  ui.shadeIn.style.width = `${lo}%`;
  ui.shadeOut.style.left = `${hi}%`;
  ui.shadeOut.style.width = `${Math.max(0, 100 - hi)}%`;
  paintMinimap();
}

function paintTimeline(t) {
  const program = t.programSec;
  ui.play.textContent = t.playing ? '❙❙' : '▶';
  ui.play.setAttribute('aria-label', t.playing ? 'Pause' : 'Play');
  ui.program.textContent = timecode(program);
  ui.source.textContent = EDITING && clipRow === null
    ? '\u2014' : timecode(sourceSecOfProgram(program));
  if (!ui.exportName.placeholder) ui.exportName.placeholder = t.clip.source.id;
  paintStripPositions();
  paintDeliverable();
  paintLanes();
  paintLens();
  drawChrome();
}

/** The ruler, drawn across the visible window rather than across the clip. */
function buildRuler() {
  const span = Math.max(1e-6, view.spanSec);
  const width = Math.max(1, ui.bed.clientWidth);
  const wanted = span / Math.max(2, width / 90);
  const { step, seconds } = rulerTickSeconds(view.startSec, view.endSec, wanted);
  const ticks = [];
  for (const s of seconds) {
    const tick = document.createElement('div');
    tick.className = 'ttick';
    tick.style.left = `${view.pct(s)}%`;
    const label = document.createElement('label');
    label.textContent = tickLabel(s, step);
    tick.appendChild(label);
    ticks.push(tick);
  }
  ui.ruler.replaceChildren(...ticks);
}

// The overview strip: the whole clip with the visible window on it, in whole-clip coordinates
// rather than through `view.pct`, because it exists to say where the window is.
function paintMinimap() {
  if (!ui.mini) return;
  const dur = view.duration;
  const pct = (t) => `${Math.max(0, Math.min(100, (t / dur) * 100))}%`;
  // `left` stays the plain percentage, and the clamp that keeps the box in the track rides
  // on `margin-left`.
  const leftPct = view.a * 100;
  ui.miniWin.style.left = `${leftPct}%`;
  ui.miniWin.style.marginLeft = `min(0px, calc(100% - ${leftPct}% - var(--tminiwin-min)))`;
  ui.miniWin.style.width = `${(view.b - view.a) * 100}%`;
  ui.miniHead.style.left = pct(timeline ? timeline.programSec : 0);
  const from = Math.min(clipIn, dur);
  const to = Math.min(clipOut ?? dur, dur);
  ui.miniRange.style.left = pct(from);
  ui.miniRange.style.width = `${Math.max(0, ((to - from) / dur) * 100)}%`;
}

/** The window moved. Everything drawn against it is redrawn and nothing else is. */
function viewChanged() {
  if (!timeline) return;
  buildRuler();
  paintMarks();
  paintStripPositions();
  lanesMoved();
}

// A drag resolves at whatever rate drafts come back, never queuing more than one.
let draftWanted = null;
let draftBusy = false;

async function pumpDraft() {
  if (draftBusy || draftWanted === null || !timeline || exporting) return;
  draftBusy = true;
  const t = draftWanted;
  draftWanted = null;
  try {
    await timeline.draft(t);
  } catch (err) {
    showTimelineError(err);
  } finally {
    draftBusy = false;
  }
}

// A look change at a parked playhead has to rebuild the image, and rebuild it accurately.
let repaintWanted = false;
let repaintBusy = false;
let repaintScheduled = false;
let repaintAskedAt = 0;
let repaintAskedAtFaults = 0;

async function pumpRepaint() {
  if (repaintBusy || !repaintWanted || !timeline) return;
  repaintBusy = true;
  repaintWanted = false;
  const askedAt = repaintAskedAt;
  const askedAtFaults = repaintAskedAtFaults;
  try {
    await timeline.repaintHere(askedAt, askedAtFaults);
  } catch (err) {
    showTimelineError(err);
  } finally {
    repaintBusy = false;
    if (repaintWanted) pumpRepaint();
  }
}

/** Rebuilds the image and the readouts at wherever the playhead is parked. */
function requestRepaint() {
  previews?.changed();
  if (!timeline || timeline.playing || scrubbing || orbiting || exporting) return;
  repaintWanted = true;
  repaintAskedAt = counters.renders;
  repaintAskedAtFaults = timeline.faults;
  if (repaintScheduled) return;
  repaintScheduled = true;
  // Deferred to the end of the task, so a bulk write asks for one image rather than many.
  queueMicrotask(() => {
    repaintScheduled = false;
    pumpRepaint();
  });
}

paramWritten = (name, tag) => {
  // Every parameter write reaches the program-out source through here.
  sendProgramOut({ params: { [name]: params.get(name) } });
  if (tag === 'view' || transportWriting) return;
  requestRepaint();
};

const programAtPointer = (e) => view.timeAt(e.clientX);

let scrubbing = false;

ui.bed.addEventListener('pointerdown', (e) => {
  if (!timeline) return;
  if (selectedMark) { selectedMark = null; paintMarks(); }
  ui.bed.setPointerCapture(e.pointerId);
  scrubbing = true;
  pauseTransport();
  draftWanted = programAtPointer(e);
  pumpDraft();
});

ui.bed.addEventListener('pointermove', (e) => {
  if (!scrubbing) return;
  draftWanted = programAtPointer(e);
  pumpDraft();
});

for (const type of ['pointerup', 'pointercancel']) {
  ui.bed.addEventListener(type, (e) => {
    if (!scrubbing) return;
    scrubbing = false;
    // The queued position goes first, which is the fix for the gesture this transport is for.
    draftWanted = null;
    // Releasing asks for the true image, so this is the one gesture that pays for a pre-roll.
    timeline.seek(programAtPointer(e)).catch(showTimelineError);
  });
}

// The least of the window the stage keeps.
const MIN_STAGE_SHARE = 0.35;
// Where the splitter sits before anybody drags it: as tall as the lanes need, up to this.
const DEFAULT_LANES_SHARE = 0.35;
// Client state: how tall you like the strip belongs to this browser, not to the clip.
const LANES_HEIGHT = 'kinect.lanesHeight';

let laneStackHeight = 0;
let userLaneHeight = null;
try {
  // Asked of the string: `getItem` answers null when nothing was stored, and
  // `Number(null)` is 0.
  const saved = localStorage.getItem(LANES_HEIGHT);
  const px = Number(saved);
  if (saved !== null && saved.trim() !== '' && Number.isFinite(px) && px >= 0) userLaneHeight = px;
} catch {
  // Private browsing or storage disabled by policy. The default is a good height.
}

/** The tallest the lanes may be here, so the stage keeps its share of the window. */
function laneHeightCeiling() {
  // `--timeline-h` is the strip's fixed part, read off the element rather than repeated here.
  const fixed = parseFloat(getComputedStyle(ui.root).getPropertyValue('--timeline-h')) || 0;
  return Math.max(0, Math.round(innerHeight * (1 - MIN_STAGE_SHARE)) - fixed);
}

/** `--tlanes-h`, from the two things that decide it, in the one place that writes it. */
function applyLaneHeight() {
  const wanted = userLaneHeight ?? Math.round(innerHeight * DEFAULT_LANES_SHARE);
  const reachable = laneHeightCeiling();
  const height = Math.max(0, Math.min(wanted, laneHeightCeiling()));
  // On the root and not on the strip: `#panel` and `#effectRackPanel` are siblings of the strip
  // and a custom property inherits downwards, so written there they read the stylesheet's 0 and
  // stood that many pixels too tall - over the bottom of the lane stack.
  document.documentElement.style.setProperty('--tlanes-h', `${height}px`);
  ui.grip.setAttribute('aria-valuenow', String(height));
  ui.grip.setAttribute('aria-valuemax', String(Math.max(0, reachable)));
}

ui.lanes.addEventListener('scroll', () => {
  ui.railLanes.scrollTop = ui.lanes.scrollTop;
});

// The rail has overflow:hidden so wheel events don't scroll it; forward them to the lanes.
ui.rail.addEventListener('wheel', (e) => {
  if (ui.lanes.scrollHeight <= ui.lanes.clientHeight) return;
  const delta = e.deltaY * (e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 22 : 1);
  if (Math.abs(delta) < Math.abs(e.deltaX)) return;
  e.preventDefault();
  ui.lanes.scrollTop += delta;
}, { passive: false });

/** The splitter. `resize()` is throttled to an animation frame, not run per pointer event. */
let gripDrag = null;
let gripFrame = 0;

ui.grip.addEventListener('pointerdown', (e) => {
  ui.grip.setPointerCapture(e.pointerId);
  ui.grip.classList.add('dragging');
  gripDrag = {
    y: e.clientY,
    from: parseFloat(getComputedStyle(ui.root).getPropertyValue('--tlanes-h')) || 0,
  };
});

ui.grip.addEventListener('pointermove', (e) => {
  if (!gripDrag) return;
  // Upwards is taller, which is the direction the edge is being dragged.
  userLaneHeight = Math.max(0, gripDrag.from + (gripDrag.y - e.clientY));
  applyLaneHeight();
  if (gripFrame) return;
  gripFrame = requestAnimationFrame(() => {
    gripFrame = 0;
    resize();
    placeChrome();
  });
});

/** The same splitter from the keyboard. A step is a lane row rather than a pixel. */
const LANE_KEY_STEP = 22;

ui.grip.addEventListener('keydown', (e) => {
  const from = parseFloat(getComputedStyle(ui.root).getPropertyValue('--tlanes-h')) || 0;
  // The same bound `applyLaneHeight` writes and `aria-valuemax` reports, or End would stop short
  // of the maximum the separator declares whenever the lanes stack shorter than the ceiling.
  const ceiling = laneHeightCeiling();
  const to = e.key === 'ArrowUp' ? from + LANE_KEY_STEP
    : e.key === 'ArrowDown' ? from - LANE_KEY_STEP
      : e.key === 'PageUp' ? from + LANE_KEY_STEP * 4
        : e.key === 'PageDown' ? from - LANE_KEY_STEP * 4
          : e.key === 'Home' ? 0
            : e.key === 'End' ? Math.max(0, ceiling)
              : null;
  if (to === null) return;
  e.preventDefault();
  userLaneHeight = Math.max(0, to);
  applyLaneHeight();
  resize();
  placeChrome();
  rememberLaneHeight();
});

/** Where the splitter has been put, kept for this browser rather than for the clip. */
function rememberLaneHeight() {
  try {
    localStorage.setItem(LANES_HEIGHT, String(userLaneHeight));
  } catch {
    // Storage is a convenience here, and the gesture already worked.
  }
}

for (const type of ['pointerup', 'pointercancel']) {
  ui.grip.addEventListener(type, () => {
    if (!gripDrag) return;
    gripDrag = null;
    ui.grip.classList.remove('dragging');
    if (gripFrame) cancelAnimationFrame(gripFrame);
    gripFrame = 0;
    resize();
    placeChrome();
    rememberLaneHeight();
  });
}

/**
 * Where the pointer is as a fraction of the clip, which is what zoom and pan are expressed in.
 */
function clipFractionAt(surface, clientX) {
  const r = (surface === ui.mini ? ui.mini : ui.bed).getBoundingClientRect();
  const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0.5;
  return surface === ui.mini ? f : view.a + f * (view.b - view.a);
}

/** A wheel event's two deltas in pixels, whatever unit the browser chose to report. */
const wheelPixels = (e) => {
  if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return { x: e.deltaX * LANE_KEY_STEP, y: e.deltaY * LANE_KEY_STEP };
  }
  if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return {
      x: e.deltaX * Math.max(1, globalThis.innerWidth),
      y: e.deltaY * Math.max(1, globalThis.innerHeight),
    };
  }
  return { x: e.deltaX, y: e.deltaY };
};

const onStripWheel = (surface) => (e) => {
  if (!timeline) return;
  const delta = wheelPixels(e);
  // A wheel that started in the lane scroller, on its axis, belongs to it and not the zoom.
  if (Math.abs(delta.y) >= Math.abs(delta.x)
    && ui.lanes.contains(e.target)
    && ui.lanes.scrollHeight > ui.lanes.clientHeight) return;
  e.preventDefault();
  // A trackpad reports both axes and a mouse one, so the dominant axis picks the gesture.
  if (Math.abs(delta.x) > Math.abs(delta.y)) {
    const width = Math.max(1, (surface === ui.mini ? ui.mini : ui.bed).clientWidth);
    const d = (delta.x / width) * (surface === ui.mini ? 1 : view.b - view.a);
    if (!view.set(view.a + d, view.b + d)) return;
  } else {
    const factor = ZOOM_PER_NOTCH ** (-delta.y / 100);
    if (!view.zoomAbout(clipFractionAt(surface, e.clientX), factor)) return;
  }
  viewChanged();
};

for (const surface of [ui.beds, ui.mini]) {
  surface.addEventListener('wheel', onStripWheel(surface), { passive: false });
}

/** The overview's gestures: drag to pan, click to bring the window. */
let miniDrag = null;

ui.mini.addEventListener('pointerdown', (e) => {
  if (!timeline) return;
  const rect = ui.mini.getBoundingClientRect();
  if (rect.width <= 0) return;
  const at = (e.clientX - rect.left) / rect.width;
  const inside = e.target === ui.miniWin;
  ui.mini.setPointerCapture(e.pointerId);
  if (!inside) {
    const half = (view.b - view.a) / 2;
    view.set(at - half, at + half);
    viewChanged();
  }
  miniDrag = { at, a: view.a, b: view.b };
});

ui.mini.addEventListener('pointermove', (e) => {
  if (!miniDrag) return;
  const rect = ui.mini.getBoundingClientRect();
  const at = (e.clientX - rect.left) / Math.max(1, rect.width);
  const d = at - miniDrag.at;
  if (view.set(miniDrag.a + d, miniDrag.b + d)) viewChanged();
});

for (const type of ['pointerup', 'pointercancel']) {
  ui.mini.addEventListener(type, () => { miniDrag = null; });
}

// A press on a cut marker, and whether it has turned into a drag yet. Four pixels rather than
// zero because a finger never holds still, and the same number the media picker's tiles use.
let handleDrag = null;
const HANDLE_DRAG_SLOP = 4;

for (const handle of [ui.in, ui.out]) {
  const side = handle === ui.in ? 'in' : 'out';
  handle.addEventListener('pointerdown', (e) => {
    if (!timeline) return;
    handle.setPointerCapture(e.pointerId);
    handleDrag = { side, from: e.clientX, moved: false };
    // `#tIn` and `#tOut` are siblings of `#tBed` rather than children, so this takes nothing off
    // the ruler's scrub. What it stops is the bubble to `ui.beds`, which deselects on a press
    // landing outside a clip - and grabbing a marker is not that press.
    e.stopPropagation();
  });
  handle.addEventListener('pointermove', (e) => {
    if (handleDrag?.side !== side) return;
    if (!handleDrag.moved) {
      if (Math.abs(e.clientX - handleDrag.from) <= HANDLE_DRAG_SLOP) return;
      handleDrag.moved = true;
      pauseTransport();
    }
    const t = programAtPointer(e);
    if (handle === ui.in) {
      writeClipRange({ in: Math.max(0, Math.min(t, clipOut ?? timeline.duration)) }, timeline.duration);
    } else {
      writeClipRange({ out: clipOut === null ? t : Math.max(clipIn, Math.min(t, timeline.duration)) }, timeline.duration);
    }
    timeline.paint();
  });
  for (const type of ['pointerup', 'pointercancel']) {
    handle.addEventListener(type, (e) => {
      if (handleDrag?.side !== side) return;
      const dragged = handleDrag.moved;
      handleDrag = null;
      // A press that never moved is not a trim, so the range is left where it is. The zone is the
      // ruler row alone, so a press meant for a lane never arrives here to be handed back.
      if (!dragged) return;
      const t = programAtPointer(e);
      if (handle === ui.in) {
        setClipInOut({ in: Math.max(0, Math.min(t, clipOut ?? timeline.duration)) });
      } else {
        setClipInOut({ out: Math.max(clipIn, Math.min(t, timeline.duration)) });
      }
      history.commit();
    });
  }
}

ui.play.addEventListener('click', () => {
  if (!timeline) return;
  // `pauseTransport` rather than `timeline.pause()`, so the pause takes the transport with it.
  if (timeline.playing || timeline.pendingPlay) pauseTransport();
  else timeline.play().catch(showTimelineError);
});

/** Parks the playhead somewhere, stopping first. Seeks clamp into the clip range. */
function goTo(sec) {
  if (!timeline) return;
  pauseTransport();
  timeline.seek(Math.max(0, Math.min(sec, timeline.duration))).catch(showTimelineError);
}

/** Puts one end of the export range where the playhead is. */
function setClipRangeFromPlayhead(which) {
  if (refuseEdit('setting the trim')) return;
  if (!timeline) return;
  const t = timeline.programSec;
  if (which === 'in') setClipInOut({ in: Math.max(0, Math.min(t, clipOut ?? timeline.duration)) });
  else setClipInOut({ out: Math.max(clipIn, Math.min(t, timeline.duration)) });
  history.commit();
}

function clearClipRange() {
  if (refuseEdit('clearing the trim')) return;
  // `null` rather than the duration, so the range still means to the end if the program grows.
  setClipInOut({ in: 0, out: null });
  history.commit();
}

// An input type that is not a text field. Anything else counts as text, including a type this
// list has never heard of, so a text-like type added later defaults to keeping its keyboard.
const NON_TEXT_INPUT_TYPES = new Set([
  'range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'image',
]);
// The keys a slider, a dropdown or a checkbox uses to operate itself. Everything else reaches
// the editor, so a focused lens slider does not swallow cmd-z and the fly keys.
const SELF_OPERATING_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Enter', 'Home', 'End', 'PageUp', 'PageDown',
]);

/** Whether a focused control takes text, which is the case that keeps the whole keyboard. */
function takesText(el) {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName !== 'INPUT') return false;
  return !NON_TEXT_INPUT_TYPES.has(el.type);
}

/** Whether the focused control has this key, so the editor must not take it off the control. */
function controlKeeps(el, key) {
  if (takesText(el)) return true;
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName !== 'INPUT' && el.tagName !== 'SELECT') return false;
  return SELF_OPERATING_KEYS.has(key);
}

const SHORTCUTS = 'space play/pause · arrows step a frame, with shift a second · '
  + 'home/end · i/o set in/out, with shift jump to them · option-x uses the whole clip · '
  + 'del removes the selected key · '
  + 'm marks, [/] jump to the previous and next mark · '
  + '+/- zoom the ruler, ,/. pan it, f fits the clip · '
  + 'shift-wasd fly, shift-q/e down and up, shift-drag turns the view, shift-wheel the lens · '
  + 'g moves and turns the selected clip · '
  + 'cmd-z undoes · h hides the panel';

/** The editor's keyboard, and the guard that has to come with it. */
addEventListener('keydown', (e) => {
  // Above the typing guard: shift on its own arrives as a keydown, and releasing it as a keyup
  // with `shiftKey` already false.
  changeFlyKeys(() => { flyShift = e.shiftKey; });
  if (controlKeeps(e.target, e.key)) return;
  if (e.defaultPrevented) return;

  if (e.key === 'h' || e.key === 'H') {
    setPanelCollapsed(!document.body.classList.contains('panelcollapsed'));
    return;
  }
  if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    history.undo();
    return;
  }
  // The recorder's viewport orbits the same camera, so this sits above the clip guard below.
  // A repeat is harmless: the set already holds the code. The key is recorded whether or not
  // shift is down, so pressing shift onto a key already held starts the flight rather than
  // waiting for the key to be pressed again; shift is what *takes* the key, so without it the
  // key goes on to whatever else is bound to it.
  if (isFlyKey(e.code) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    changeFlyKeys(() => flyHeld.add(e.code));
    if (e.shiftKey) {
      e.preventDefault();
      return;
    }
  }
  if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey && !EDITING && ui.recGo && !ui.recGo.disabled) {
    e.preventDefault();
    ui.recGo.click();
    return;
  }
  if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey && !EDITING && ui.recMark && !ui.recMark.disabled) {
    e.preventDefault();
    (async () => {
      const body = await (await fetch('/record/mark', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      })).json();
      ui.recNote.textContent = body.error ?? `${body.label} at ${(body.sourceMs / 1000).toFixed(1)}s`;
    })();
    return;
  }
  // Everything below is about a clip, and the recorder has none.
  if (!EDITING || !timeline) return;
  if ((e.key === 'g' || e.key === 'G') && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    if (!clipGestureLive()) { say('select a clip before moving or turning it'); return; }
    // One key for both handle sets: off, move, turn, off.
    setGizmoMode(gizmoMode === 'translate' ? 'rotate' : 'translate');
    return;
  }
  if (e.code === 'KeyX' && e.altKey && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    clearClipRange();
    return;
  }
  // Any modifier but shift belongs to the browser or the OS. Shift is a frame against a second.
  const composed = e.key.length === 1 && e.getModifierState('AltGraph');
  if ((e.metaKey || e.ctrlKey || e.altKey) && !composed) return;

  const step = (frames) => {
    pauseTransport();
    timeline.seek(Math.max(0, Math.min((timeline.frame + frames) / timeline.outputFps, timeline.duration)))
      .catch(showTimelineError);
  };

  switch (e.key) {
    case ' ':
      // A focused button owns the space bar: that is how a button is pressed without a mouse.
      if (e.target instanceof HTMLElement && e.target.closest('button, [role=button]')) return;
      // Or the page scrolls under the strip.
      e.preventDefault();
      // `pendingPlay` beside `playing`, because a play warming up from a draft is one
      // this press stops.
      if (timeline.playing || timeline.pendingPlay) pauseTransport();
      else timeline.play().catch(showTimelineError);
      return;
    case 'ArrowRight': e.preventDefault(); step(e.shiftKey ? timeline.outputFps : 1); return;
    case 'ArrowLeft': e.preventDefault(); step(e.shiftKey ? -timeline.outputFps : -1); return;
    case 'Home': e.preventDefault(); goTo(timeline.clipInSec); return;
    case 'End': e.preventDefault(); goTo(timeline.clipOutSec); return;
    case 'i': case 'I':
      e.preventDefault();
      if (e.shiftKey) goTo(clipIn);
      else setClipRangeFromPlayhead('in');
      return;
    case 'o': case 'O':
      e.preventDefault();
      if (e.shiftKey) goTo(clipOut ?? timeline.duration);
      else setClipRangeFromPlayhead('out');
      return;
    case 'Delete': case 'Backspace':
      e.preventDefault();
      if (selectedMark) { deleteMark(selectedMark).catch(showTimelineError); return; }
      // The key before the clip. A clip row and a key are two selections now rather than one
      // slot holding either, and the editor always has a clip under the panel - so asking after
      // the clip first would make Delete mean "delete the clip" from the moment it opens.
      if (selection) { deleteSelectedKey(); return; }
      if (selectedClipRow()) { deleteSelectedClip(); return; }
      return;
    case 'm': case 'M': e.preventDefault(); toggleMarkHere().catch(showTimelineError); return;
    case '[': case ']': {
      e.preventDefault();
      if (!clipGestureLive()) { say('select a clip before moving to a mark'); return; }
      const here = timeline.programSec;
      const seconds = markSecondsInOrder().filter(reachableInClip);
      const to = e.key === '['
        ? seconds.filter((s) => s < here - 1e-6).pop()
        : seconds.find((s) => s > here + 1e-6);
      if (to !== undefined) goTo(to);
      return;
    }
    case '+': case '=':
      e.preventDefault();
      if (view.zoomAbout(timeline.programSec / view.duration, ZOOM_PER_NOTCH)) viewChanged();
      return;
    case '-': case '_':
      e.preventDefault();
      if (view.zoomAbout(timeline.programSec / view.duration, 1 / ZOOM_PER_NOTCH)) viewChanged();
      return;
    case ',': case '<': e.preventDefault(); if (view.panBy(-0.25)) viewChanged(); return;
    case '.': case '>': e.preventDefault(); if (view.panBy(0.25)) viewChanged(); return;
    case 'f': case 'F': e.preventDefault(); if (view.fit()) viewChanged(); return;
    case '?': e.preventDefault(); say(SHORTCUTS); return;
    default:
  }
});

/** A key released outside the page never arrives, so losing the page releases everything. */
function clearFlyKeys() {
  flyHeld.clear();
  flyShift = false;
  flyLastAt = 0;
}

// Not behind the typing guard: a key released after the focus moved into an input would
// otherwise stay held for ever.
addEventListener('keyup', (e) => {
  changeFlyKeys(() => {
    flyShift = e.shiftKey;
    flyHeld.delete(e.code);
  });
});
addEventListener('blur', clearFlyKeys);
document.addEventListener('focusin', (e) => { if (takesText(e.target)) clearFlyKeys(); });
document.addEventListener('visibilitychange', () => { if (document.hidden) clearFlyKeys(); });

/** How wide the 1.00x detent is, in pixels of the control it lives on. */
const DETENT_PX = 3;

const rawRateFromSlider = (v) => (
  RATE_MIN * (RATE_MAX / RATE_MIN) ** Math.min(1, Math.max(0, Number(v) || 0))
);
/** Whether a slider position is inside the detent, the band being a number of pixels. */
const insideDetent = (v) => {
  // 92 is the stylesheet's width, and the reading in use whenever the slider is hidden with
  // its chip: `timingChanged` gets here with no clip selected, where the rect is empty.
  const width = ui.rate.getBoundingClientRect().width || 92;
  return Math.abs(Number(v) - sliderFromRate(1)) <= DETENT_PX / Math.max(1, width);
};

/**
 * The rate a position means, with the detent applied to a gesture that came in from outside.
 */
const rateFromSlider = (v) => {
  const holding = rateGesture ? rateGesture.detentArmed === false : false;
  return !holding && insideDetent(v) ? 1 : Number(rawRateFromSlider(v).toFixed(3));
};

const sliderFromRate = (rate) => (
  Math.log(Math.min(RATE_MAX, Math.max(RATE_MIN, rate)) / RATE_MIN)
  / Math.log(RATE_MAX / RATE_MIN)
);

ui.rate.value = String(sliderFromRate(selectedClip.speed));

/** What a speed gesture holds still, captured once when it starts. */
let rateGesture = null;

function beginRateGesture({ fromKey = false } = {}) {
  if (rateGesture || !timeline) return;
  const gen = takeTransport();
  rateGesture = {
    // Whether a key is holding this open, which decides whether `change` may end it.
    fromKey,
    gen,
    // Disarmed for a gesture that begins inside the band at something other than 1.00x.
    detentArmed: selectedClip.speed === 1 || !insideDetent(sliderFromRate(selectedClip.speed)),
    // Through the clip's own zero: the map is clip-local, so feeding it the project second
    // would anchor on the wrong source frame of a clip that starts after 0.
    source: sourceSecOfProgram(timeline.programSec),
    wasPlaying: timeline.playing,
    // The parameterisation the gesture started in. Every time is rescaled from these.
    rate: selectedClip.speed,
    times: programTimeSnapshot(),
    // Fractions preserve footage when one clip is the whole program. A clip inside a larger edit
    // changes the program length non-uniformly, so its existing program bounds are held instead.
    window: clips.length === 1 && selectedClipRow()?.start === 0
      ? null : { startSec: view.startSec, endSec: view.endSec },
    applied: false,
  };
  timeline.pause();
}

/** Ends the gesture, whichever event gets here first. */
function endRateGesture() {
  if (!rateGesture) return;
  if (!timeline) { rateGesture = null; return; }
  const { wasPlaying, applied, rate: began, gen } = rateGesture;
  if (!applied) {
    rateGesture = null;
    if (wasPlaying) timeline.play().catch(showTimelineError);
    return;
  }
  const rate = rateFromSlider(ui.rate.value);
  const program = applyRate(rate);
  rateGesture = null;
  draftWanted = null;
  timingChanged();
  timeline.seek(program)
    .then(() => { if (wasPlaying && gen === transportGen) return timeline.play(); })
    .catch(showTimelineError);
  if (rate !== began) history.commit();
}

/** Puts the slope at `rate` and carries the document with it. The order is load-bearing. */
function applyRate(rate) {
  if (refuseEdit('a speed change')) return timeline ? timeline.programSec : 0;
  // The seam: the slider and the gesture around it say rate, and the model says speed.
  selectedClip.speed = rate;
  rateGesture.applied = true;
  const program = programHoldingAnchor();
  // `frameOf` rather than `frameAt`, which clamps to a clip range that is stale here.
  timeline.frame = timeline.frameOf(program);
  reparameteriseProgramTime(rateGesture.rate / rate, rateGesture.times);
  if (rateGesture.window) {
    const duration = view.duration;
    const start = Math.min(rateGesture.window.startSec, duration);
    const end = Math.max(start, Math.min(rateGesture.window.endSec, duration));
    view.set(start / duration, end / duration);
  }
  return program;
}

/** Where the anchored frame sits now that the slope has changed, in project seconds. */
function programHoldingAnchor() {
  return Math.max(0, Math.min(programSecOfSource(rateGesture.source), timeline.duration));
}

ui.rate.addEventListener('pointerdown', () => beginRateGesture());
// The keys a range input answers, named rather than left unconditional.
const RATE_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End',
]);
ui.rate.addEventListener('keydown', (e) => { if (RATE_KEYS.has(e.key)) beginRateGesture({ fromKey: e.key }); });
for (const type of ['pointerup', 'pointercancel', 'blur']) {
  ui.rate.addEventListener(type, endRateGesture);
}
// A `keyup` ends this gesture only when it is the key holding it open.
ui.rate.addEventListener('keyup', (e) => {
  if (rateGesture && rateGesture.fromKey === e.key) endRateGesture();
});
// `change` ends a gesture only when no key holds one, since a held key repeats per repeat.
ui.rate.addEventListener('change', () => { if (!rateGesture?.fromKey) endRateGesture(); });

ui.rate.addEventListener('input', () => {
  if (!timeline) return;
  beginRateGesture();
  if (rateGesture && !rateGesture.detentArmed && !insideDetent(ui.rate.value)) {
    rateGesture.detentArmed = true;
  }
  const program = applyRate(rateFromSlider(ui.rate.value));
  timingChanged({ moved: true });
  draftWanted = program;
  pumpDraft();
});

// The output rate, which is project state now and undoable because of it.
ui.fps?.addEventListener('change', () => {
  if (!timeline) return;
  if (refuseEdit('changing the output rate')) {
    ui.fps.value = String(timeline.outputFps);
    return;
  }
  const held = timeline.programSec;
  const fps = Number(ui.fps.value);
  timeline.outputFps = fps;
  paintDeliverable();
  const gen = takeTransport();
  const wasPlaying = timeline.playing;
  timeline.pause();
  timingChanged();
  timeline.seek(held)
    .then(() => { if (wasPlaying && gen === transportGen) return timeline.play(); })
    .catch(showTimelineError);
  history.commit();
});

// Orbiting while the playhead is parked differs from scrubbing in two ways that matter.
let orbiting = false;
// Damping outlives the pointer: on release the camera has not travelled the residual.
let orbitSettling = false;
// A flag rather than a position, since reading the transport from a control event is the loop.
let orbitRedrawWanted = false;
// Whether a fly key was held on the previous frame, so the release can be seen at all.
let flyWasHeld = false;
// Through `onNav`, because the object does not outlive a change of navigation's up.
onNav('start', () => { orbiting = true; orbitSettling = false; });
onNav('change', () => {
  if ((!orbiting && !orbitSettling) || !timeline || timeline.playing) return;
  orbitRedrawWanted = true;
});
onNav('end', () => {
  orbiting = false;
  if (!timeline || timeline.playing) return;
  orbitSettling = true;
});

/** Hands the camera what the damping still owes it, so a reader gets the pose it will keep. */
function finishOrbitDrift() {
  const damped = controls.enableDamping;
  controls.enableDamping = false;
  // Zero rather than no argument: `update()` bare falls back to a fixed auto-rotate step.
  controls.update(0);
  controls.enableDamping = damped;
}

/** Settles damping only after the pointer has found something that can use the press. */
function hitAfterOrbitSettles(readHit) {
  if (!readHit()) return null;
  finishOrbitDrift();
  return readHit();
}

/** The only thing that continues a drag at a parked playhead, once per animation frame. */
function pumpParkedDraft() {
  if (!timeline || timeline.playing || exporting) {
    draftWanted = null;
    orbitRedrawWanted = false;
    orbitSettling = false;
    flyWasHeld = false;
    gizmoWriteWanted = false;
    return;
  }
  // A hold takes the same two paths a pointer orbit does: a draft-quality redraw per frame, and
  // one accurate seek on the frame it ends.
  const flyingNow = flying();
  if (flyingNow) orbitRedrawWanted = true;
  else if (flyWasHeld) orbitSettling = true;
  flyWasHeld = flyingNow;
  // Before the drafts, because the gizmo's write is what the repaint below would be drawing.
  pumpGizmo();
  if (draftWanted !== null) {
    pumpDraft();
    return;
  }
  if (orbitRedrawWanted && !draftBusy) {
    orbitRedrawWanted = false;
    draftBusy = true;
    timeline.redrawHere()
      .catch(showTimelineError)
      .finally(() => { draftBusy = false; });
    return;
  }
  if (orbitSettling && !draftBusy) {
    orbitSettling = false;
    // The damping is finished before the seek, because these flags cannot see the end of it.
    finishOrbitDrift();
    timeline.seekHere().catch(showTimelineError);
  }
}

// How a lane draws a rotation and a position: no value axis, so the curve reads how far through
// its segment the track is. Shared by the two kinds that have one.
const POSE_LANE = {
  eases: true,
  laneH: 34,
  range: () => ({ min: 0, max: 1 }),
  ends: () => ({ lo: 0, hi: 1 }),
  at: (owner, t) => poseLaneFraction(keysOf(owner), t),
  keyValue: (keys, i) => (keys.length < 2 ? 0.5 : (i === keys.length - 1 ? 1 : 0)),
  axisIsValue: false,
  overshoots: false,
  moved: (a, b) => poseMoved(a.value, b.value),
};

/**
 * What a track kind is, declared once rather than asked as `row.kind !== 'scalar'` per site.
 */
const KINDS = {
  scalar: {
    eases: true,
    laneH: 34,
    range: (spec) => ({ min: spec.min, max: spec.max }),
    ends: (keys, seg) => ({ lo: keys[seg].value, hi: keys[seg + 1].value }),
    at: (owner, t) => trackOf(owner).valueAt(t),
    keyValue: (keys, i) => keys[i].value,
    axisIsValue: true,
    overshoots: true,
    moved: (a, b) => Math.abs(b.value - a.value) > 1e-9,
  },
  step: {
    eases: false,
    laneH: 22,
    range: () => ({ min: 0, max: 1 }),
    ends: () => ({ lo: 0, hi: 1 }),
    at: () => 0.5,
    keyValue: () => 0.5,
    axisIsValue: false,
    overshoots: false,
    moved: () => false,
  },
  pose: POSE_LANE,
  // A placement draws and eases exactly as a pose does: the two differ over a lens, and a lane
  // has no axis for one. The same object, so a change to how one draws cannot miss the other.
  placement: POSE_LANE,
};

/** Whether two poses differ at all, in place, in aim, or in field of view. */
const poseMoved = (a, b) => (a.fov !== undefined && Math.abs(a.fov - b.fov) > 1e-9)
  || a.position.some((v, i) => Math.abs(v - b.position[i]) > 1e-9)
  || a.quaternion.some((v, i) => Math.abs(v - b.quaternion[i]) > 1e-9);

/** How far through its segment a pose track is, eased, which is what a pose lane draws. */
const poseLaneFraction = (keys, t) => {
  const n = keys.length;
  if (n < 2) return 0.5;
  const i = keyBefore(keys, t);
  if (i < 0) return 0;
  if (i >= n - 1) return 1;
  const span = keys[i + 1].t - keys[i].t;
  if (span <= 0) return 1;
  return easeAt(keys[i].easeOut, keys[i + 1].easeIn, (t - keys[i].t) / span);
};

// How far a curve is sampled across a lane. A smoothness choice rather than a pixel count.
const CURVE_SAMPLES = 120;
const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * The keyframe the strip has selected, as `{owner, key}`, or null.
 *
 * By object rather than by index, because an index moves when a track re-sorts or a clip above
 * one is deleted. Session state and deliberately not in the document: which key you are looking
 * at is not part of the edit, and a document recording it would make two people's saves differ
 * over nothing - so a reopened project selects nothing, the same way `suppressedEffects` starts
 * empty. Separate from `clipRow` because the two are separate facts: shaping a key on a clip's
 * lane must not take the clip out from under the panel that is editing it.
 */
let selection = null;

/** The clip the strip has selected, or null. Not `selectedClip`, which is never null. */
const selectedClipRow = () => clipRow;

// One row per clip, and the add row beneath them.
const CLIP_LANE_H = 24;
const CLIP_ADD_H = 34;
// The least a clip may be trimmed to, so an edge drag cannot make one that cannot be grabbed.
const MIN_CLIP_SEC = 0.2;

const svg = (name, attrs) => {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** The value range a lane draws against. */
function laneRange(owner) {
  const spec = params.spec(laneName(owner));
  return KINDS[spec.kind].range(spec);
}

// The clips whose own lanes are folded away under their row. Session state: which rows you have
// shut is not part of the edit, so it is not in the document and it does not survive a reload.
const clipLanesShut = new Set();
const clipLanesOpen = (clip) => !clipLanesShut.has(clip.id);

/** The parameters one clip has keyed, in registry order. */
const clipTrackNames = (clip) => scopeNames('clip')
  .filter((name) => clip.look.tracks.get(name)?.keys.length > 0);

function laneRows() {
  const rows = [];
  for (const clip of clips) {
    // A clip's own curves nest under its row and fold with it: four clips with a keyed look each
    // is four stacks of lanes, and flat they read as one stack belonging to nobody.
    const keyed = clipTrackNames(clip);
    rows.push({
      owner: `clip:${clip.id}`,
      label: clip.take?.id ?? clip.id,
      kind: 'clip',
      height: CLIP_LANE_H,
      clip,
      nested: keyed.length,
      open: clipLanesOpen(clip),
    });
    if (!clipLanesOpen(clip)) continue;
    for (const name of keyed) {
      const track = clip.look.tracks.get(name);
      rows.push({
        owner: laneOwner(clip, name),
        label: name,
        kind: track.kind,
        height: KINDS[track.kind].laneH,
        clip,
        under: clip.id,
      });
    }
  }
  rows.push({ owner: 'clip-add', label: '', kind: 'clip-add', height: CLIP_ADD_H });
  // The project's own curves at the foot, which is everything a clip does not hold: the camera,
  // and the post chain every clip is seen through.
  for (const name of ['camera', ...scopeNames('project')]) {
    const track = tracks.get(name);
    if (!track || track.keys.length === 0) continue;
    rows.push({ owner: name, label: name, kind: track.kind, height: KINDS[track.kind].laneH });
  }
  return rows;
}

/** Folds one clip's own lanes away, or opens them. */
function toggleClipLanes(clip) {
  if (clipLanesShut.has(clip.id)) clipLanesShut.delete(clip.id);
  else clipLanesShut.add(clip.id);
  lanesChanged();
}

/**
 * A lane owner names a track: a project value by its parameter name, and a clip value by both -
 * the clip it belongs to and the parameter it moves, because eight clips can key one parameter
 * and eight lanes reading `tracks.get(name)` would all draw the selected clip's keys.
 */
const laneOwner = (clip, name) => `clip:${clip.id}/${name}`;
const laneName = (owner) => (owner.includes('/') ? owner.slice(owner.indexOf('/') + 1) : owner);
const isClipRow = (owner) => owner.startsWith('clip:') && !owner.includes('/');

/** The clip a lane owner names, whether it is that clip's own row or one of its tracks. */
function laneClip(owner) {
  if (!owner.startsWith('clip:')) return null;
  const cut = owner.indexOf('/');
  const id = cut < 0 ? owner.slice(5) : owner.slice(5, cut);
  return clips.find((clip) => clip.id === id) ?? null;
}

/** The track a lane owner names, or null. Through the clip it names rather than the selection. */
function trackOf(owner) {
  const clip = laneClip(owner);
  const name = laneName(owner);
  return (clip ? clip.look.tracks : homeOf(specOf(name)).tracks).get(name) ?? null;
}

/** Runs a write against whichever clip a lane owner names, or against the selection. */
const withLaneClip = (owner, write) => {
  const clip = laneClip(owner);
  return clip ? withClip(clip, write) : write();
};

// A clip row and the bar above it own no keys, so a lane's key list is empty rather than absent.
const keysOf = (owner) => {
  if (owner === 'clip-add' || isClipRow(owner)) return [];
  return trackOf(owner)?.keys ?? [];
};

/** The clip a lane owner's row is, or null where the owner is not a clip row. */
const clipOf = (owner) => (isClipRow(owner) ? laneClip(owner) : null);

function laneReadout(owner) {
  if (owner === 'clip-add') return '';
  const clip = clipOf(owner);
  // The length rather than the placement: where a clip sits is what its box already says, and
  // the rail is 96px wide, which fits one number and not two.
  if (clip) return Number.isFinite(clip.length) ? `${clip.length.toFixed(2)}s` : '∞';
  // Out of the look the owner names rather than off the selection, or every clip's lane would
  // read the selected clip's number back however many clips are keyed.
  const name = laneName(owner);
  const value = (laneClip(owner)?.look ?? homeOf(specOf(name))).values.get(name);
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') return value >= 100 ? value.toFixed(0) : value.toFixed(2);
  return `${keysOf(owner).length} keys`;
}

/** Rebuilds the lane rows. Called when lanes or keys change, never per frame or per move. */
function rebuildLanes() {
  counters.laneRebuilds++;
  ui.railLanes.replaceChildren();
  ui.lanes.replaceChildren();
  const rows = laneRows();

  for (const row of rows) {
    const rail = document.createElement('div');
    rail.className = row.under ? 'trow nested' : 'trow';
    rail.style.height = `${row.height}px`;
    const label = document.createElement('span');
    label.textContent = row.label;
    const value = document.createElement('b');
    value.dataset.readout = row.owner;
    value.textContent = laneReadout(row.owner);
    // The fold, on the clip row and only where the clip has something to fold away.
    if (row.kind === 'clip' && row.nested > 0) {
      const fold = document.createElement('button');
      fold.type = 'button';
      fold.className = 'lanefold';
      fold.dataset.laneFold = row.clip.id;
      fold.setAttribute('aria-expanded', String(row.open));
      fold.title = `${row.nested} keyed parameter${row.nested === 1 ? '' : 's'} on ${row.clip.id}`;
      fold.append(document.createElement('i'));
      fold.addEventListener('click', () => toggleClipLanes(row.clip));
      rail.append(fold);
    }
    if (row.kind === 'clip-add') {
      rail.classList.add('clip-add-row');
      rail.append(ui.addClip);
    } else {
      rail.append(label, value);
    }
    ui.railLanes.appendChild(rail);

    const bed = document.createElement('div');
    bed.className = 'trow';
    bed.style.height = `${row.height}px`;
    const lane = document.createElement('div');
    lane.className = 'tlane';
    lane.dataset.owner = row.owner;
    lane.__row = row;
    bed.appendChild(lane);
    ui.lanes.appendChild(bed);
    drawLane(lane, row);
  }

  laneStackHeight = rows.reduce((n, r) => n + r.height + 1, 0);
  applyLaneHeight();
  resize();
  placeChrome();
}

/** The same lanes, moved rather than rebuilt. */
function repositionLanes() {
  for (const lane of ui.lanes.querySelectorAll('.tlane')) {
    const row = lane.__row;
    if (!row) return false;
    if (row.kind === 'clip') {
      const box = lane.querySelector('.tclip');
      if (!box || box.__clip !== row.clip) return false;
      placeClipBox(box, row.clip);
      continue;
    }
    const keys = keysOf(row.owner);
    const nodes = lane.querySelectorAll('.tkey');
    if (nodes.length !== keys.length) return false;
    for (const node of nodes) {
      if (!keys.includes(node.__key)) return false;
      const at = laneToProgram(row.owner, node.__key.t);
      node.style.left = `${view.pct(at)}%`;
      node.style.top = `${keyY(row, node.__key)}%`;
      // Hidden, not removed: `repositionLanes` refuses when node and key counts disagree.
      node.hidden = !view.holds(at);
    }
    for (const handle of lane.querySelectorAll('.thandle')) {
      const i = keys.indexOf(handle.__key);
      const seg = handle.__side === 'easeOut' ? i : i - 1;
      if (i < 0 || seg < 0 || seg >= keys.length - 1) return false;
      // A segment that went flat under the drag has no shape left to edit, so its handle goes.
      if (!segmentHasShape(keys, seg, row.kind)) return false;
      const points = handle.__side === 'easeOut' ? keys[seg].easeOut : keys[seg + 1].easeIn;
      if (handle.__index >= points.length) return false;
      const point = handlePoint(row, keys, seg, handle.__side, handle.__index);
      handle.__seg = seg;
      const at = laneToProgram(row.owner, point.t);
      handle.style.left = `${view.pct(at)}%`;
      handle.style.top = `${point.y}%`;
      handle.hidden = !view.holds(at);
    }
    const curve = lane.querySelector('polyline');
    if (curve) curve.setAttribute('points', lanePoints(row.owner));
  }
  return true;
}

/** The curve a lane draws, as a `points` attribute in the 0..1000 by 0..100 viewBox. */
function lanePoints(owner) {
  const { min, max } = laneRange(owner);
  const span = Math.max(1e-9, max - min);
  // Sampled on the lane's own clock: the walk below is over program seconds and a clip's keys
  // are measured from its in-point.
  const at = (t) => KINDS[trackOf(owner).kind].at(owner, programToLane(owner, t));
  const points = [];
  // Sampled across the visible window rather than the clip, so nothing is drawn outside it.
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    const t = view.startSec + (i / CURVE_SAMPLES) * view.spanSec;
    const y = 100 - ((at(t) - min) / span) * 100;
    points.push(`${(i / CURVE_SAMPLES) * 1000},${Math.max(-20, Math.min(120, y)).toFixed(2)}`);
  }
  return points.join(' ');
}

/** Whether a segment has a shape to edit. It has none when its two keys hold one value. */
const segmentHasShape = (keys, seg, kind) => KINDS[kind].moved(keys[seg], keys[seg + 1]);

/** Where a clip's box sits across the bed, in percent. The chrome that says where a clip is. */
function placeClipBox(box, clip) {
  const from = view.pct(clip.start);
  const to = view.pct(Number.isFinite(clip.end) ? clip.end : view.duration);
  box.style.left = `${from}%`;
  box.style.width = `${Math.max(0, to - from)}%`;
  box.hidden = to < -5 || from > 105;
}

function drawLane(lane, row) {
  if (row.kind === 'clip-add') return;
  if (row.kind === 'clip') {
    // A positive box, unlike the trim chrome on the ruler, which draws the region the export
    // leaves out. `#tMiniRange` is the precedent: a clip is a thing that is there.
    const box = document.createElement('div');
    box.className = clipRow === row.clip ? 'tclip sel' : 'tclip';
    box.dataset.role = 'clip';
    box.title = `${row.label} · ${row.clip.id}`;
    box.__clip = row.clip;
    box.__row = row;
    const label = document.createElement('span');
    label.textContent = row.label;
    box.appendChild(label);
    for (const side of ['head', 'tail']) {
      const edge = document.createElement('i');
      edge.className = `tclipedge ${side}`;
      edge.dataset.role = 'clipedge';
      edge.dataset.side = side;
      box.appendChild(edge);
    }
    placeClipBox(box, row.clip);
    lane.appendChild(box);
    return;
  }
  const keys = keysOf(row.owner);
  const x = (t) => view.pct(laneToProgram(row.owner, t));

  if (KINDS[row.kind].eases) {
    const box = svg('svg', { viewBox: '0 0 1000 100', preserveAspectRatio: 'none' });
    box.appendChild(svg('polyline', {
      points: lanePoints(row.owner), fill: 'none', stroke: 'var(--accent)',
      'stroke-width': 1.4, 'vector-effect': 'non-scaling-stroke',
    }));
    lane.appendChild(box);
  }

  for (const key of keys) {
    const node = document.createElement('div');
    node.className = 'tkey';
    if (selection && selection.key === key) node.classList.add('sel');
    node.style.left = `${x(key.t)}%`;
    node.style.top = `${keyY(row, key)}%`;
    node.hidden = !view.holds(laneToProgram(row.owner, key.t));
    node.dataset.role = 'key';
    lane.appendChild(node);
    node.__key = key;
    node.__row = row;
  }

  if (!KINDS[row.kind].eases || !selection || keys.indexOf(selection.key) < 0) return;
  // Handles only on the selected key, and only where there is a segment for them to shape.
  const i = keys.indexOf(selection.key);
  for (const side of ['easeOut', 'easeIn']) {
    const seg = side === 'easeOut' ? i : i - 1;
    if (seg < 0 || seg >= keys.length - 1) continue;
    // A flat segment gets none, for the reason `segmentHasShape` gives.
    if (!segmentHasShape(keys, seg, row.kind)) continue;
    const points = side === 'easeOut' ? keys[seg].easeOut : keys[seg + 1].easeIn;
    for (let index = 0; index < points.length; index++) {
      const handle = document.createElement('div');
      handle.className = 'thandle';
      const point = handlePoint(row, keys, seg, side, index);
      handle.style.left = `${x(point.t)}%`;
      handle.style.top = `${point.y}%`;
      handle.hidden = !view.holds(laneToProgram(row.owner, point.t));
      handle.dataset.role = 'handle';
      handle.__key = selection.key;
      handle.__row = row;
      handle.__side = side;
      handle.__seg = seg;
      handle.__index = index;
      lane.appendChild(handle);
    }
  }
}

/** A key's vertical place in its lane, as a percentage from the top. */
function keyY(row, key) {
  const keys = keysOf(row.owner);
  const { min, max } = laneRange(row.owner);
  const v = KINDS[row.kind].keyValue(keys, keys.indexOf(key));
  return Math.max(0, Math.min(100, 100 - ((v - min) / Math.max(1e-9, max - min)) * 100));
}

/** Where one of an ease handle's control points sits, in seconds and lane percentage. */
function handlePoint(row, keys, seg, side, index) {
  const a = keys[seg];
  const b = keys[seg + 1];
  const h = (side === 'easeOut' ? a.easeOut : b.easeIn)[index];
  const { min, max } = laneRange(row.owner);
  const { lo, hi } = KINDS[row.kind].ends(keys, seg);
  const value = lo + (hi - lo) * h[1];
  return {
    t: a.t + (b.t - a.t) * h[0],
    y: Math.max(-15, Math.min(115, 100 - ((value - min) / Math.max(1e-9, max - min)) * 100)),
  };
}

/** How far along the segment a control point may go, as the two points either side. */
function handleSpan(keys, seg, side, index) {
  const out = keys[seg].easeOut;
  const inn = keys[seg + 1].easeIn;
  const at = (k) => (k < 0 ? 0 : (k >= out.length + inn.length ? 1
    : (k < out.length ? out[k][0] : inn[k - out.length][0])));
  const k = side === 'easeOut' ? index : out.length + index;
  const here = at(k);
  return { lo: Math.min(at(k - 1), at(k + 1), here), hi: Math.max(at(k - 1), at(k + 1), here) };
}

/** Readouts only. Structure is `rebuildLanes`, and the two are kept apart on purpose. */
function paintLanes() {
  for (const el of ui.rail.querySelectorAll('b[data-readout]')) {
    el.textContent = laneReadout(el.dataset.readout);
  }
  for (const [name, btn] of keyButtons) paintKeyButton(name, btn);
  paintClipCommands();
  paintMarkButton();
  paintEase();
}

/** A lane appeared, moved or went away. */
function lanesChanged() {
  previews?.changed();
  rebuildLanes();
  paintLanes();
  groupRevealChanged();
}

/** A key or a handle moved and the set of them did not. The cheap half of the pair. */
function lanesMoved() {
  previews?.changed();
  counters.laneRepositions++;
  if (!repositionLanes()) {
    counters.laneFallbacks++;
    rebuildLanes();
  }
  paintLanes();
}

/** A clip's timing or the output rate moved, so every position on the ruler did. */
function timingChanged({ moved = false } = {}) {
  // Before the guard: the warm window is memoised against this and a recorder-side timing change
  // still moves it, whether or not there is a strip to repaint.
  timingGeneration++;
  if (!timeline) return;
  // Re-clamped against a duration this may have changed: the window is stored as fractions.
  view.reclamp();
  if (rateFromSlider(ui.rate.value) !== selectedClip.speed) {
    ui.rate.value = String(sliderFromRate(selectedClip.speed));
  }
  ui.rateOut.textContent = `${selectedClip.speed.toFixed(2)}×`;
  ui.rate.disabled = selectedClipRow() === null;
  if (ui.fps) ui.fps.value = String(timeline.outputFps);
  buildRuler();
  paintMarks();
  paintStripPositions();
  if (moved) lanesMoved();
  else lanesChanged();
}

// The take's marks, fetched when it opens. They belong to the take, not to a project.
let takeMarks = [];
let markLoadGeneration = 0;
/**
 * The open take's id and its content hash, read off the selected clip, which is what holds them.
 * Two readings rather than two variables: a clip's footage and the page's idea of it drifted
 * apart the moment either was written without the other.
 */
const openTakeId = () => selectedClip.take?.id ?? null;
const openTakeHash = () => selectedClip.take?.hash ?? null;

/**
 * The selected clip's map between its take's source time and the edit's program time.
 *
 * Through the clip's placement as well as its speed and in-point. A mark is a fact about footage,
 * so it stays keyed by take and two clips of one take share it - which is exactly why drawing one
 * needs to say which clip it is being drawn against, and the selection is what says.
 */
const programSecOfSource = (sourceSec) => selectedClip.start
  + clipProgramSecAt(selectedClip, sourceSec);
const sourceSecOfProgram = (programSec) => clipSourceSecAt(
  selectedClip, programSec - selectedClip.start,
);
const markSourceSecOfProgram = (programSec) => Math.max(
  0, Math.min(selectedClip.source.duration, sourceSecOfProgram(programSec)),
);

/**
 * The program second a lane's own clock starts at, and the two conversions across it.
 *
 * Zero for the project's own tracks, and the clip's in-point for every lane a clip owns: its
 * look and its placement. A lane that drew its keys at `view.pct(key.t)` would put them `start`
 * seconds early the moment its clip was placed anywhere but the head of the edit.
 */
function laneEpoch(owner) {
  return trackEpoch(laneName(owner), laneClip(owner));
}

const laneToProgram = (owner, t) => t + laneEpoch(owner);
const programToLane = (owner, t) => t - laneEpoch(owner);
let selectedMark = null; // The currently selected mark object, or null

// Where a mark may sit. One past the end stacks at the edge rather than being dropped.
const clampToClip = (sec, total) => Math.max(0, Math.min(total, sec));

/**
 * Whether a seek here would land where it was asked: `frameAt` clamps every seek into in..out.
 */
const reachableInClip = (programSec) => !timeline
  || (programSec >= timeline.clipInSec - 1e-6 && programSec <= timeline.clipOutSec + 1e-6);

const markSecondsInOrder = () => {
  const total = view.duration;
  return takeMarks
    .map((m) => clampToClip(programSecOfSource(m.sourceMs / 1000), total))
    .sort((a, b) => a - b);
};

function paintMarks() {
  const host = ui.marks;
  if (!host) return;
  host.replaceChildren();
  ui.miniMarks?.replaceChildren();
  if (!timeline || !clipGestureLive()) return;
  const total = view.duration;
  for (const mark of takeMarks) {
    // Marks are source milliseconds and the ruler is program seconds, so ticks go through the
    // selected clip's placement, speed and in-point.
    const program = programSecOfSource(mark.sourceMs / 1000);
    const el = document.createElement('button');
    el.type = 'button';
    el.innerHTML = '<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><path d="M1 1l8 0 0 7-4 3-4-3z" fill="currentColor"/></svg>';
    // A mark the edit never reaches is drawn at the edge in the dim colour rather than dropped.
    const beyond = program >= total - 1e-9 && mark.sourceMs / 1000 > sourceSecOfProgram(total) + 1e-9;
    const selected = selectedMark?.id === mark.id;
    el.className = (beyond ? 'tmk beyond' : 'tmk') + (selected ? ' sel' : '');
    const at = clampToClip(program, total);
    el.style.left = `${view.pct(at)}%`;
    el.hidden = !view.holds(at);
    el.title = `${mark.label ?? mark.id} · source ${(mark.sourceMs / 1000).toFixed(2)}s`;
    // The clamped second, never the mark's own source second.
    let dragging = false;
    let dragStartX = 0;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      // Select this mark, clear keyframe selection.
      selectedMark = mark;
      if (selection) { selection = null; lanesChanged(); }
      // Styled directly, because `paintMarks()` would destroy this element and break the drag.
      for (const sib of host.querySelectorAll('.tmk.sel')) sib.classList.remove('sel');
      el.classList.add('sel');
      dragging = false;
      dragStartX = e.clientX;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      if (!dragging && Math.abs(e.clientX - dragStartX) > 3) {
        dragging = true;
      }
      if (dragging) {
        const programSec = Math.max(0, Math.min(view.duration, view.timeAt(e.clientX)));
        el.style.left = `${view.pct(programSec)}%`;
      }
    });
    el.addEventListener('pointerup', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      el.releasePointerCapture(e.pointerId);
      if (dragging) {
        const programSec = Math.max(0, Math.min(view.duration, view.timeAt(e.clientX)));
        const sourceSec = markSourceSecOfProgram(programSec);
        const newSourceMs = Math.round(sourceSec * 1000);
        moveMark(mark, newSourceMs).catch(showTimelineError);
      } else {
        if (!reachableInClip(at)) {
          say('that mark is outside the clip range, so the edit cannot reach it');
          return;
        }
        goTo(at);
      }
    });
    el.addEventListener('lostpointercapture', () => {
      if (dragging) paintMarks();
    });
    host.appendChild(el);
  }
  // The same marks on the overview, in whole-clip coordinates.
  if (ui.miniMarks) {
    ui.miniMarks.replaceChildren(...takeMarks.map((mark) => {
      const el = document.createElement('span');
      const program = programSecOfSource(mark.sourceMs / 1000);
      el.style.left = `${Math.max(0, Math.min(100, (program / total) * 100))}%`;
      return el;
    }));
  }
}

async function loadMarks(id) {
  const generation = ++markLoadGeneration;
  selectedMark = null;
  takeMarks = [];
  paintMarks();
  paintMarkButton();
  let marks;
  try {
    const res = await fetch(`/capture/${encodeURIComponent(id)}/marks`);
    marks = res.ok ? (await res.json()).marks : [];
  } catch {
    marks = [];
  }
  if (generation !== markLoadGeneration || openTakeId() !== id) return false;
  return adoptMarks(id, Array.isArray(marks) ? marks : []);
}

/** Writes mark records and returns the complete sidecar the server accepted. */
async function writeMarks(id, records) {
  const res = await fetch(`/capture/${encodeURIComponent(id)}/marks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marks: records }),
  });
  if (!res.ok) throw new Error(`mark write failed (${res.status})`);
  const body = await res.json();
  if (!Array.isArray(body?.marks)) throw new Error('mark write returned no mark list');
  return body.marks;
}

/** Adopts a mark response only while its take is still selected. */
function adoptMarks(id, marks, updateSelection = null) {
  if (openTakeId() !== id) return false;
  takeMarks = marks;
  updateSelection?.();
  paintMarks();
  paintMarkButton();
  return true;
}

/** Flags the moment at the playhead, in source milliseconds: a mark describes the footage. */
async function markHere() {
  if (!clipGestureLive()) {
    say('select a clip before adding a mark');
    return false;
  }
  const id = openTakeId();
  if (!id || !timeline) return false;
  const sourceMs = Math.round(markSourceSecOfProgram(timeline.programSec) * 1000);
  const rec = { id: `m${Date.now().toString(36)}`, sourceMs, label: `mark ${takeMarks.length + 1}`, at: Date.now() };
  const marks = await writeMarks(id, [rec]);
  return adoptMarks(id, marks);
}

/** Deletes the given mark by writing a tombstone. */
async function deleteMark(mark) {
  if (!clipGestureLive()) {
    say('select a clip before deleting a mark');
    return false;
  }
  const id = openTakeId();
  if (!id || !mark) return false;
  const rec = { id: mark.id, deleted: true, at: Date.now() };
  const marks = await writeMarks(id, [rec]);
  return adoptMarks(id, marks, () => {
    if (selectedMark?.id === mark.id) selectedMark = null;
  });
}

/** Plants a mark at the playhead, or takes away the one already under it. */
function toggleMarkHere() {
  const t = playheadSec();
  const tol = keyTolerance();
  const onMark = takeMarks.find((m) => Math.abs(programSecOfSource(m.sourceMs / 1000) - t) <= tol);
  return onMark ? deleteMark(onMark) : markHere();
}

/** Moves a mark to a new source position. */
async function moveMark(mark, newSourceMs) {
  if (!clipGestureLive()) {
    say('select a clip before moving a mark');
    return false;
  }
  const id = openTakeId();
  if (!id || !mark) return false;
  if (mark.sourceMs === newSourceMs) { paintMarks(); return true; }
  const rec = { ...mark, sourceMs: newSourceMs, at: Date.now() };
  const marks = await writeMarks(id, [rec]);
  return adoptMarks(id, marks, () => {
    if (selectedMark?.id === mark.id) {
      selectedMark = takeMarks.find((m) => m.id === mark.id) ?? null;
    }
  });
}

/**
 * Where the look on screen came from, or null. A copy plus a stamp, not a reference. It lives on
 * the clip because a preset is a look and a look is the clip's; the project's half of a preset -
 * the post chain - is applied at the same time and stamped nowhere else.
 */
const appliedPreset = () => selectedClip.appliedPreset;
const stampPreset = (clip, stamp) => { clip.appliedPreset = stamp; };

/** The look values a preset may carry. Framing belongs to the shot. */
function presetValueNames() {
  return params.names('look').filter((name) => presetCarriesLookName(name, PARAMS[name].group));
}

/** A preset is look values, and that is the whole of it. */
function presetFromCurrentLook(names) {
  // The parked pool is not in here, and it is absent by construction rather than by a filter.
  const values = params.values(names ?? presetValueNames());
  // The save rule: a whole look sheds every effect it holds at defaults.
  if (wholeLookTag(values)) {
    for (const id of effectIdsIn(Object.keys(values))) {
      const mine = effectParamNames(id);
      if (mine.some((n) => PARAMS[n].reading)) continue;
      if (mine.every((n) => values[n] === PARAMS[n].def)) {
        for (const n of mine) delete values[n];
      }
    }
  }
  const requires = requiresFor(Object.keys(values));
  return { version: PROJECT_VERSION, ...(requires.length ? { requires } : {}), values };
}

/** Every look parameter of one effect, in declaration order. */
function effectParamNames(id) {
  return params.names('look').filter((n) => effectOf(n) === id);
}

/** The ids of every effect the registry currently declares. */
function effectIds() {
  return effectIdsIn(params.names('look'));
}

/** Whether an id names a package this build has, off the registry and not the listing. */
const effectInstalled = (id) => effectIds().includes(id);

/** Whether a look name belongs to an effect this build does not have. */
const isParkedName = (name) => {
  const id = effectOf(name);
  return id !== null && !effectInstalled(id);
};

/** What the open document needs and this build has not got, as the badge reads it. */
const missingEffects = () => parkedRequires.map((entry) => ({
  id: entry.id,
  version: entry.version,
  values: Object.keys(parkedWhole('params')).filter((n) => effectOf(n) === entry.id).length,
  tracks: Object.keys(parkedWhole('tracks')).filter((n) => effectOf(n) === entry.id).length,
  suppressed: suppressedEffects.has(entry.id),
}));

/** The core half of a whole look: every preset value not owned by an effect. */
const coreLookNames = () => presetValueNames().filter((name) => effectOf(name) === null);

const wholeLookNames = (values) => [
  ...coreLookNames(),
  ...effectIdsIn(Object.keys(values)).flatMap((id) => effectParamNames(id)),
];

/** Whether a document says what the whole look is, rather than adjusting part of one. */
const wholeLookTag = (values) => wholeLookNames(values).every((n) => Object.hasOwn(values, n));

/** The `requires` list against what the document touches, in both directions. */
function refuseRequires(what, requires, names) {
  const used = effectIdsIn(names);
  if (requires === undefined) {
    if (used.length) {
      throw new Error(
        `${what} names ${used.join(', ')} values but carries no requires list: a document says `
        + 'which effects its look is built from, so a reader on a machine without one of them '
        + 'can name what is missing instead of rendering something else under this name',
      );
    }
    return;
  }
  const listShape = requiresListRefusal(what, requires);
  if (listShape) throw new Error(listShape);
  const seen = new Set();
  for (const entry of requires) {
    const bad = requiresEntryRefusal(what, entry);
    if (bad) throw new Error(bad);
    if (seen.has(entry.id)) {
      throw new Error(`${what} requires ${entry.id} twice: one entry per effect, because two versions of one effect cannot both be what the look was built from`);
    }
    seen.add(entry.id);
  }
  const unlisted = used.filter((id) => !seen.has(id));
  if (unlisted.length) {
    throw new Error(
      `${what} names ${unlisted.join(', ')} values but its requires list does not claim ${unlisted.length === 1 ? 'it' : 'them'}: `
      + 'the list is derived from the values on save, so a gap between them is a hand edit to finish',
    );
  }
  const unused = [...seen].filter((id) => !used.includes(id));
  if (unused.length) {
    throw new Error(
      `${what} requires ${unused.join(', ')} but names no value under ${unused.length === 1 ? 'it' : 'them'}: `
      + 'an effect the look never touches is not required by it, so either its values were deleted by hand or the entry was added by one',
    );
  }
}

/** What version of an effect this build has, off the package that answered for it. */
const versionOf = (id) => effectPackages.find((p) => p.id === id)?.manifest.version ?? 'unknown';

/** The requires list a set of value names derives, one entry per effect touched. */
const requiresFor = (names) => effectIdsIn(names).map((id) => ({ id, version: versionOf(id) }));

/** One box written, and the four that may have to move with it. */
function presetPickSet(name, on) {
  for (const n of (PARAMS[name].reading ? READINGS : [name])) presetPickBoxes.get(n).checked = on;
}

/**
 * The group headings and the count, read back off the boxes rather than tracked beside them.
 */
function presetPickSync() {
  for (const group of presetPickGroups) {
    const on = group.members.filter((n) => presetPickBoxes.get(n).checked).length;
    group.box.checked = on === group.members.length;
    group.box.indeterminate = on > 0 && on < group.members.length;
  }
  const picked = presetPickNames();
  ui.pickCount.textContent = `${picked.length} of ${presetPickBoxes.size} look values`;
  ui.pickGo.disabled = picked.length === 0;
}

const presetPickNames = () => [...presetPickBoxes.keys()].filter((n) => presetPickBoxes.get(n).checked);

/** The subset picker, rebuilt with the panel and shown by both doors a look leaves by. */
function buildPresetPicker() {
  const host = document.getElementById('ppGroups');
  host.replaceChildren();
  presetPickBoxes.clear();
  presetPickGroups.length = 0;
  for (const group of PANEL_GROUPS) {
    const members = presetValueNames().filter((n) => PARAMS[n].group === group.key);
    if (!members.length) continue;
    const groupNode = document.createElement('div');
    groupNode.className = 'ppgroup';
    const head = document.createElement('label');
    head.className = 'check pphead';
    const all = document.createElement('input');
    all.type = 'checkbox';
    all.id = `ppg-${group.key}`;
    head.append(all, ` ${group.label}`);
    groupNode.append(head);
    all.addEventListener('change', () => {
      for (const name of members) presetPickSet(name, all.checked);
      presetPickSync();
    });

    for (const name of members) {
      const row = document.createElement('label');
      row.className = 'check';
      const input = document.createElement('input');
      input.type = 'checkbox';
      // Prefixed, because the panel's own control for this parameter owns the bare name.
      input.id = `pp-${name}`;
      input.checked = true;
      row.append(input, ` ${PARAMS[name].label}`);
      groupNode.append(row);
      presetPickBoxes.set(name, input);
      input.addEventListener('change', () => { presetPickSet(name, input.checked); presetPickSync(); });
    }
    host.append(groupNode);
    presetPickGroups.push({ box: all, members });
  }

  for (const name of READINGS) {
    if (!presetPickBoxes.has(name)) {
      throw new Error(`the reading ${name} has no box in the preset subset dialog: ticking any of the five would throw`);
    }
  }
}

ui.pickCancel.addEventListener('click', () => ui.pickDialog.close());

/** Opens the picker and answers with a name and a subset, or null. Every box starts ticked. */
function pickPresetSubset({ title, verb, name }) {
  return new Promise((resolve) => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    for (const input of presetPickBoxes.values()) input.checked = true;
    presetPickSync();
    ui.pickTitle.textContent = title;
    ui.pickGo.textContent = verb;
    ui.pickName.value = name;

    let picked = null;
    const confirm = () => {
      // A document is named before it is written: an unnamed one is neither entry nor filename.
      const chosen = ui.pickName.value.trim();
      if (!chosen) { ui.pickName.focus(); return; }
      picked = { name: chosen, names: presetPickNames() };
      ui.pickDialog.close();
    };
    const typed = (e) => {
      if (e.key !== 'Enter' || ui.pickGo.disabled) return;
      e.preventDefault();
      confirm();
    };
    const settle = () => {
      ui.pickGo.removeEventListener('click', confirm);
      ui.pickName.removeEventListener('keydown', typed);
      ui.pickDialog.removeEventListener('close', settle);
      if (opener?.isConnected && !opener.disabled) opener.focus();
      resolve(picked);
    };
    ui.pickGo.addEventListener('click', confirm);
    ui.pickName.addEventListener('keydown', typed);
    ui.pickDialog.addEventListener('close', settle);
    ui.pickDialog.showModal();
    ui.pickName.focus();
    ui.pickName.select();
  });
}

/** Everything about a preset that can be refused without writing anything. */
function refusePresetBody(name, body) {
  if (body?.version !== PROJECT_VERSION) {
    throw new Error(versionRefusal(`preset ${name}`, body?.version));
  }
  // The envelope, checked with the same suspicion as what is inside it.
  const PRESET_KEYS = ['version', 'requires', 'values'];
  const stray = Object.keys(body).filter((k) => !PRESET_KEYS.includes(k));
  if (stray.length) {
    throw new Error(
      `preset ${name} carries ${stray.join(', ')}, which a version ${PROJECT_VERSION} preset has no `
      + `place for: a preset is ${PRESET_KEYS.join(', ')} and nothing else, so a key beside them is `
      + 'either a field an older version had or a typo, and both would be read as neither',
    );
  }
  if (!body.values || typeof body.values !== 'object') {
    throw new Error(`preset ${name} carries no values object, so there is no look in it to apply`);
  }
  if (Array.isArray(body.values)) {
    throw new Error(
      `preset ${name} carries a list where its values should be: a look is an object of `
      + 'parameter names against values, so a list has nothing in it this program can name',
    );
  }
  if (Object.keys(body.values).length === 0) {
    throw new Error(
      `preset ${name} has a values object with nothing in it, so its scope is nothing: `
      + 'applying it would write no value and move no pixel. Name the values this look is '
      + 'made of, or delete the document rather than keep one that describes no look',
    );
  }

  // The values, checked against the registry without reaching it.
  for (const [key, value] of Object.entries(body.values)) {
    const { tag } = params.spec(key);
    if (tag !== 'look') {
      throw new Error(
        `preset ${name} names ${key}, which is a ${tag} parameter: a preset carries look values `
        + 'and nothing else, so that it can be applied to any clip without moving anything else',
      );
    }
    if (!presetValueNames().includes(key)) {
      throw new Error(
        `preset ${name} names ${key}, which is framing: framing belongs to the shot rather than `
        + 'the look, so a preset cannot move the crop, clip planes or levelling',
      );
    }
    params.normalise(key, value);
  }

  refuseRequires(`preset ${name}`, body.requires, Object.keys(body.values));

  const missing = missingReadings(body.values);
  if (missing.length && missing.length !== READINGS.length) {
    const named = READINGS.filter((n) => !missing.includes(n));
    throw new Error(
      `preset ${name} names ${named.join(', ')} but not ${missing.join(', ')}: the reading `
      + 'weights are all or none, because a file naming some of them blends what it says with '
      + `whatever the clip was already wearing. Name the other ${missing.length}, or take `
      + `${named.length === 1 ? 'the one it has' : `all ${named.length} it has`} out and leave `
      + 'the reading to whoever is grading',
    );
  }
}

/** Applies a saved preset, stamping it only if the document said what the whole look is. */
function applyStoredPreset(doc, target = EDITING ? selectedClipRow() : selectedClip) {
  if (refuseEdit('applying a stored preset')) return null;
  refuseDuringEvaluation('a stored preset applied');
  refusePresetBody(doc.name, doc.body);
  const values = doc.body.values ?? {};
  const clipNames = Object.keys(values).filter((name) => PARAMS[name].scope === 'clip');
  if (clipNames.length && !target) throw new Error('select a clip before applying a preset to it');
  const stamped = wholeLookTag(values);
  let applied = values;
  // A whole look says what all of it is, so effects it never mentions are at their defaults.
  if (stamped) {
    const named = new Set(effectIdsIn(Object.keys(values)));
    const resets = {};
    for (const id of effectIds()) {
      if (named.has(id)) continue;
      for (const n of effectParamNames(id)) resets[n] = PARAMS[n].def;
    }
    applied = { ...resets, ...values };
  }
  const projectValues = {};
  const clipValues = {};
  for (const [name, value] of Object.entries(applied)) {
    (PARAMS[name].scope === 'clip' ? clipValues : projectValues)[name] = value;
  }
  params.apply(projectValues);
  if (target) withClip(target, () => params.apply(clipValues));
  if (stamped && target) target.appliedPreset = { name: doc.name, rev: doc.rev };
  requestRepaint();
  history.commit();
  return {
    stamped,
    written: Object.keys(values).length,
    look: wholeLookNames(values).length,
    // The project half of what was just applied. A preset's cloud terms land on the selected
    // clip and its post terms land on the project, which every clip is seen through.
    shared: Object.keys(values).filter((n) => PARAMS[n].scope === 'project').length,
  };
}

/** The documents of one kind, or the server's reason there are none. */
const documentsIn = async (kind) => {
  const res = await fetch(`/${kind}`);
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body?.[kind])) {
    throw new Error(body?.error ?? `${kind} could not be listed: HTTP ${res.status}`);
  }
  return body[kind];
};

/** The delete glyph, a stroked path so it takes its colour from around it. `lucide/trash-2`. */
function trashGlyph() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // Decorative: the button's own label already says which preset this deletes.
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M3 6h18', 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
    'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6', 'M14 11v6']) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

const TYPE_AHEAD_MS = 700;
const pickers = [];

function definePicker(trigger, list, { adds = null, note = null, autoApply = false } = {}) {
  const picker = { trigger, list, adds, note, autoApply, docs: [], typed: '', typedAt: 0 };
  pickers.push(picker);

  trigger.addEventListener('click', () => (list.hidden ? openPicker(picker) : closePicker(picker)));
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker(picker);
    }
  });
  list.addEventListener('keydown', (event) => pickerKey(picker, event));
  // On the list and not each option, so an option from a later rebuild is driven by existing.
  list.addEventListener('click', (event) => {
    const remove = event.target.closest('.pickerdelete');
    const option = event.target.closest('.pickeroption');
    if (remove && option) {
      event.stopPropagation();
      deletePreset(picker, option.dataset.name);
      return;
    }
    if (option) choosePicker(picker, option.dataset.name, { close: true });
  });
  return picker;
}

function openPicker(picker) {
  for (const other of pickers) if (other !== picker) closePicker(other);
  picker.list.hidden = false;
  picker.trigger.setAttribute('aria-expanded', 'true');
  const here = picker.list.querySelector('.pickeroption.here') ?? picker.list.querySelector('.pickeroption');
  if (here) here.focus();
  else picker.list.focus();
}

function closePicker(picker, { restoreFocus = false } = {}) {
  if (picker.list.hidden) return;
  picker.list.hidden = true;
  picker.trigger.setAttribute('aria-expanded', 'false');
  // The caret must land somewhere visible: a list shutting on focus strands it on the body.
  if (restoreFocus || picker.list.contains(document.activeElement)) picker.trigger.focus();
}

/** Every option currently in the list, in the order a keyboard walks them. */
const pickerOptions = (picker) => [...picker.list.querySelectorAll('.pickeroption')];

function pickerKey(picker, event) {
  const options = pickerOptions(picker);
  if (!options.length) return;
  const at = options.indexOf(document.activeElement.closest('.pickeroption'));
  const move = (to) => {
    event.preventDefault();
    options[Math.max(0, Math.min(options.length - 1, to))].focus();
  };
  if (event.key === 'ArrowDown') return move(at + 1);
  if (event.key === 'ArrowUp') return move(at - 1);
  if (event.key === 'Home') return move(0);
  if (event.key === 'End') return move(options.length - 1);
  if (event.key === 'Escape') {
    event.preventDefault();
    return closePicker(picker, { restoreFocus: true });
  }
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    const option = document.activeElement.closest('.pickeroption');
    if (option) choosePicker(picker, option.dataset.name, { close: true });
    return;
  }
  // Type-ahead. One printable character at a time, accumulated inside a window.
  if (event.key.length !== 1 || event.altKey || event.ctrlKey || event.metaKey) return;
  const now = performance.now();
  picker.typed = now - picker.typedAt > TYPE_AHEAD_MS ? event.key : picker.typed + event.key;
  picker.typedAt = now;
  const wanted = picker.typed.toLowerCase();
  const hit = options.find((option) => option.dataset.name.toLowerCase().startsWith(wanted));
  if (hit) {
    event.preventDefault();
    hit.focus();
  }
}

/** Write a name onto the trigger and repaint the list. The display half only. */
function showPickerChoice(picker, name) {
  picker.trigger.value = name ?? '';
  paintPicker(picker);
}

/** The operator chose this entry: show it, and on a picker that applies, apply it. */
function choosePicker(picker, name, { close = false } = {}) {
  const target = EDITING ? selectedClipRow() : selectedClip;
  const generation = documentGeneration;
  showPickerChoice(picker, name);
  if (close) closePicker(picker, { restoreFocus: true });
  if (picker.autoApply) {
    if (name) {
      withPresetGesture(picker.note ?? ui.note, () => whileWriting(async () => {
        try {
          const doc = await (await fetch(`/presets/${encodeURIComponent(name)}`)).json();
          if (generation !== documentGeneration || (target && !clips.includes(target))) return;
          const result = applyStoredPreset(doc, target);
          if (result === null) {
            showPickerChoice(picker, appliedPreset()?.name ?? '');
            return;
          }
        } catch (err) {
          showPickerChoice(picker, appliedPreset()?.name ?? '');
          showTimelineError(err);
        }
      }));
    } else {
      // "none" selected: reset every preset value to its default, and clear the stamp.
      if (!target) return;
      if (refuseEdit('resetting the selected clip to defaults')) {
        showPickerChoice(picker, target.appliedPreset?.name ?? '');
        return;
      }
      target.appliedPreset = null;
      const lookNames = presetValueNames();
      params.reset(lookNames.filter((name) => PARAMS[name].scope === 'project'));
      withClip(target, () => params.reset(lookNames.filter((name) => PARAMS[name].scope === 'clip')));
      history.commit();
    }
  }
}

function paintPicker(picker) {
  const chosen = picker.trigger.value;
  picker.trigger.querySelector('.pickervalue').textContent = chosen || 'none';
  for (const option of pickerOptions(picker)) {
    const here = option.dataset.name === chosen;
    option.classList.toggle('here', here);
    option.setAttribute('aria-selected', String(here));
  }
}

function buildPicker(picker, docs) {
  picker.docs = docs;
  const noneOption = document.createElement('div');
  noneOption.className = 'pickeroption';
  noneOption.setAttribute('role', 'option');
  noneOption.setAttribute('aria-selected', 'false');
  noneOption.tabIndex = -1;
  noneOption.dataset.name = '';
  noneOption.dataset.builtin = 'false';
  const noneLabel = document.createElement('span');
  noneLabel.className = 'pickerlabel';
  noneLabel.textContent = 'none';
  noneOption.append(noneLabel);

  const rows = docs.map((doc) => {
    const option = document.createElement('div');
    option.className = 'pickeroption';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', 'false');
    option.tabIndex = -1;
    option.dataset.name = doc.name;
    option.dataset.builtin = String(Boolean(doc.builtin));
    const label = document.createElement('span');
    label.className = 'pickerlabel';
    label.textContent = doc.name;
    option.append(label);
    if (!doc.builtin) {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'pickerdelete';
      remove.setAttribute('aria-label', `Delete preset ${doc.name}`);
      remove.tabIndex = -1;
      remove.append(trashGlyph());
      option.append(remove);
    }
    return option;
  });
  picker.list.replaceChildren(noneOption, ...rows);
  if (picker.adds) {
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'pickeradd';
    add.id = picker.adds;
    add.setAttribute('aria-label', 'Save the current look as a new preset');
    add.textContent = '+';
    add.addEventListener('click', () => {
      closePicker(picker, { restoreFocus: true });
      ui.presetSave.click();
    });
    picker.list.append(add);
  }
  paintPicker(picker);
}

/** Delete a user preset, and put the caret somewhere afterwards. */
async function deletePreset(picker, name) {
  const options = pickerOptions(picker);
  const at = options.findIndex((option) => option.dataset.name === name);
  const successor = options[at + 1]?.dataset.name ?? options[at - 1]?.dataset.name ?? null;
  await withPresetGesture(picker.note ?? ui.note, () => whileWriting(async () => {
    await writeDocumentAtCurrentRev('presets', name, { method: 'DELETE' });
    if (picker.trigger.value === name) picker.trigger.value = '';
    await refreshPresets();
  })).catch((err) => {
    if (picker.note) picker.note.textContent = `could not delete ${name}: ${err.message}`;
    else showTimelineError(err);
    console.error(err);
  });
  if (picker.list.hidden) return;
  const back = successor
    ? picker.list.querySelector(`.pickeroption[data-name="${CSS.escape(successor)}"]`)
    : null;
  if (back) back.focus();
  else closePicker(picker, { restoreFocus: true });
}

definePicker(ui.preset, document.getElementById('tPresetList'), { adds: 'tPresetAdd', autoApply: true });

addEventListener('pointerdown', (event) => {
  for (const picker of pickers) {
    if (!picker.list.hidden && !picker.trigger.contains(event.target) && !picker.list.contains(event.target)) {
      closePicker(picker);
    }
  }
});

async function refreshPresets() {
  const list = await documentsIn('presets');
  // Both selectors, because the preset library is one library.
  for (const picker of pickers) {
    buildPicker(picker, list);
    if (appliedPreset() && list.some((doc) => doc.name === appliedPreset().name)) {
      showPickerChoice(picker, appliedPreset().name);
    } else {
      paintPicker(picker);
    }
  }
  return list;
}

/** A preset as a file, both ways. The document is the file format. */
function exportPresetFile(name, body) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(body, null, 2)}\n`], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.braindance-preset.json`;
  a.click();
  // Revoked on the next turn, because the fetch of the blob is not synchronous.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function importPresetFile(
  file,
  target = EDITING ? selectedClipRow() : selectedClip,
  generation = documentGeneration,
) {
  const text = await file.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file.name} is not JSON: ${err.message}`);
  }
  const name = file.name.replace(/\.braindance-preset\.json$|\.json$/i, '');
  refuseDuringEvaluation('a preset imported');
  refusePresetBody(name, body);
  const saved = await writeDocumentAtCurrentRev('presets', name, { body });
  if (generation !== documentGeneration || (target && !clips.includes(target))) {
    return { ...saved, applied: false };
  }
  const applied = applyStoredPreset({ name: saved.name, rev: saved.rev, body }, target);
  return { ...saved, applied: applied !== null };
}

/** Every project the store holds. Its own route because `/projects` is the page. */
async function listProjects() {
  const res = await fetch('/projects/all');
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body?.projects)) {
    throw new Error(body?.error ?? `projects could not be listed: HTTP ${res.status}`);
  }
  return body.projects;
}

async function refreshDeliverables() {
  const list = await documentsIn('deliverables');
  if (ui.deliverable) {
    const current = ui.deliverable.value;
    ui.deliverable.replaceChildren(new Option('—', ''));
    for (const doc of list) ui.deliverable.appendChild(new Option(doc.name, doc.name));
    if (list.some((d) => d.name === current)) ui.deliverable.value = current;
  }
  return list;
}

/** Moves the picker and what it names together, so a refusal can put the picker back. */
function showAdoptedDeliverable(name) {
  if (!ui.deliverable) return;
  ui.deliverable.value = name;
  ui.deliverable.dataset.adopted = name;
}

async function saveDeliverable(name, deliverable) {
  return writeDocumentAtCurrentRev('deliverables', name, { body: deliverable });
}

// One pointer path for keys and handles, since they differ only in what a drag writes.
let laneDrag = null;
// A clip being moved along the strip or trimmed at its out-point. Its own state rather than a
// third role on `laneDrag`, because what it writes is the edit's structure and not a curve.
let clipDrag = null;

const laneProgramAt = (clientX) => view.timeAt(clientX);

// Known gap: an undo between this pointerdown and its pointerup rebuilds every track.
ui.beds.addEventListener('pointerdown', (e) => {
  const box = e.target.closest('.tclip');
  if (box && timeline) {
    e.preventDefault();
    e.stopPropagation();
    ui.beds.setPointerCapture(e.pointerId);
    const clip = box.__clip;
    // Which of the three gestures this is: the head, the out-point, or the body.
    const grip = e.target.closest('.tclipedge');
    const side = grip ? grip.dataset.side : null;
    if (refuseEdit('moving a clip')) return;
    const gen = takeTransport();
    const wasPlaying = timeline.playing || timeline.pendingPlay;
    timeline.pause();
    clipDrag = {
      clip,
      side,
      gen,
      wasPlaying,
      program: timeline.programSec,
      grabbedAt: laneProgramAt(e.clientX) - (side === 'tail' ? clip.end : clip.start),
      // The out-point, held for the length of a head trim so the far end does not walk.
      end: clip.end,
      duration: timeline.duration,
      moved: false,
    };
    selectClipRow(clip);
    return;
  }
  const el = e.target.closest('.tkey, .thandle');
  // A press on the empty part of the stack is how you get out of every selection there is, and
  // it is what leaves the panel's clip half greyed with no clip under it. The clip bar is not
  // empty space: its commands are drawn in the bed rather than in the rail, and deselecting
  // under one rebuilds the stack and re-parents the button between the press and its click.
  if (!el) {
    if (!e.target.closest('.tclipbar, .tbed')) deselectClipRow();
    return;
  }
  if (!timeline) return;
  e.preventDefault();
  e.stopPropagation();

  // A second press on the same key removes it, before the capture, so it never drags.
  if (el.dataset.role === 'key') {
    const now = performance.now();
    if (lastKeyClick.key === el.__key && now - lastKeyClick.at < DOUBLE_CLICK_MS) {
      lastKeyClick = { key: null, at: 0 };
      selection = { owner: el.__row.owner, key: el.__key };
      deleteSelectedKey();
      return;
    }
    lastKeyClick = { key: el.__key, at: now };
  }

  if (refuseEdit('moving a key')) return;
  ui.beds.setPointerCapture(e.pointerId);
  const lane = el.closest('.tlane');
  laneDrag = {
    el, row: el.__row, key: el.__key, side: el.__side, seg: el.__seg, index: el.__index,
    role: el.dataset.role, rect: lane.getBoundingClientRect(),
    duration: timeline.duration,
  };
  if (selectedMark) { selectedMark = null; paintMarks(); }
  selection = { owner: el.__row.owner, key: el.__key };
  lanesChanged();
});

ui.beds.addEventListener('pointermove', (e) => {
  if (clipDrag) {
    const at = laneProgramAt(e.clientX) - clipDrag.grabbedAt;
    const clip = clipDrag.clip;
    if (clipDrag.side === 'tail') clip.trim = Math.max(MIN_CLIP_SEC, at - clip.start);
    else if (clipDrag.side === 'head') headTrimTo(clip, at, clipDrag.end);
    else clip.start = Math.max(0, at);
    clipDrag.moved = true;
    lanesMoved();
    paintStripPositions();
    requestRepaint();
    return;
  }
  if (!laneDrag) return;
  const { row, key, rect } = laneDrag;
  const keys = keysOf(row.owner);
  const { min, max } = laneRange(row.owner);
  const frac = Math.min(1.15, Math.max(-0.15, (e.clientY - rect.top) / Math.max(1, rect.height)));
  const value = min + (1 - frac) * (max - min);

  if (laneDrag.role === 'key') {
    key.t = Math.max(0, programToLane(row.owner, laneProgramAt(e.clientX)));
    if (KINDS[row.kind].axisIsValue) {
      // Through the registry's snapping without writing, so a key and a slider agree. By the
      // owner's parameter rather than the owner, which for a clip's lane names both.
      key.value = params.normalise(laneName(row.owner), value);
    }
    // A look track sorts, since its keys may be dragged past one another.
    trackOf(row.owner).keys.sort((x, y) => x.t - y.t);
  } else {
    const a = keys[laneDrag.seg];
    const b = keys[laneDrag.seg + 1];
    const dt = Math.max(1e-9, b.t - a.t);
    // Off the kind, not the key values: a pose value is an object and subtracting is `NaN`.
    const { lo, hi } = KINDS[row.kind].ends(keys, laneDrag.seg);
    const dv = hi - lo;
    const h = (laneDrag.side === 'easeOut' ? a.easeOut : b.easeIn)[laneDrag.index];
    // x stays inside the segment: a handle past either end folds the timing curve back.
    const span = handleSpan(keys, laneDrag.seg, laneDrag.side, laneDrag.index);
    // The span first and the curve last: ordering suffices only if the polygon starts ordered.
    h[0] = foldFreeX(a.easeOut, b.easeIn, laneDrag.side, laneDrag.index, h[0],
      Math.min(span.hi, Math.max(span.lo,
        (programToLane(row.owner, laneProgramAt(e.clientX)) - a.t) / dt)));
    // `dv` is non-zero by construction: a handle exists only where there was a shape.
    if (segmentHasShape(keys, laneDrag.seg, row.kind)) h[1] = (value - lo) / dv;
    if (KINDS[row.kind].overshoots) h[1] = Math.min(2, Math.max(-1, h[1]));
    else h[1] = Math.min(1, Math.max(0, h[1]));
  }
  lanesMoved();
  requestRepaint();
});

for (const type of ['pointerup', 'pointercancel']) {
  ui.beds.addEventListener(type, () => {
    if (clipDrag) {
      const drag = clipDrag;
      const { moved } = drag;
      clipDrag = null;
      // The warm window and every position on the ruler move with a clip, so this is the same
      // door a speed change goes through rather than a lane rebuild.
      if (moved) { timingChanged(); history.commit(); }
      if (drag.gen !== transportGen) return;
      if (!moved) {
        if (drag.wasPlaying) timeline.play().catch(showTimelineError);
        return;
      }
      timeline.seek(Math.min(drag.program, timeline.duration))
        .then(() => { if (drag.wasPlaying && drag.gen === transportGen) return timeline.play(); })
        .catch(showTimelineError);
      return;
    }
    if (!laneDrag) return;
    laneDrag = null;
    lanesChanged();
    history.commit();
  });
}

/** Removes whichever key is selected in a lane. */
function deleteSelectedKey() {
  if (!timeline || !selection) return false;
  if (refuseEdit('deleting a key')) return false;
  const { owner, key } = selection;
  // A stale selection is not an error: an undo rebuilds every track from a snapshot.
  if (!keysOf(owner).includes(key)) { selection = null; return false; }

  {
    // Through the clip the lane names, so a key removed on one clip's lane is removed from that
    // clip's track rather than from the selected clip's track of the same name.
    const name = laneName(owner);
    withLaneClip(owner, () => {
      retainEffectFor(name);
      tracks.get(name).removeKey(key);
      // A track with no keys is not a track. The parameter keeps the value it holds now.
      dropTrackIfEmpty(name);
    });
    selection = null;
    lanesChanged();
  }
  requestRepaint();
  history.commit();
  return true;
}


/** Points the strip, the panel and the lanes at one clip. Selection is the session's, not the document's. */
function selectClipRow(clip) {
  selectedMark = null;
  selection = null;
  clipRow = clip;
  selectClip(clip);
  if (clip.take !== null) paintSelectedTake(clip);
  // Every clip-scope control, because the values did not move - the clip under them did.
  paintClipPanel();
  paintGizmo();
  // The ruler's mapping and the marks both move with the selection, which is what
  // `timingChanged` already puts back together.
  timingChanged();
  syncCropOutside();
  if (timeline && clip.take !== null) loadMarks(clip.take.id).catch(showTimelineError);
  requestRepaint();
}

/** Takes the strip off every clip, which is what greys the panel's clip half. */
function deselectClipRow() {
  if (clipRow === null && selection === null) return;
  clipRow = null;
  selectedMark = null;
  selection = null;
  paintPanelScope();
  paintGizmo();
  paintClipCommands();
  timingChanged();
  syncCropOutside();
  chromeStale = true;
  lanesChanged();
  requestRepaint();
}

/** How the clip commands read: what the edit can still take, and what is selected. */
function paintClipCommands() {
  const selected = !EDITING || selectedClipRow() !== null;
  ui.addClip.disabled = clips.length + pendingClipAdds >= CLIP_CEILING;
  ui.deleteClip.disabled = !selected || clips.length === 1;
  // The handles need a clip to be on, which is the same thing the delete needs.
  ui.moveClip.disabled = !selected;
  ui.rotateClip.disabled = !selected;
  ui.keyClip.disabled = !selected;
  ui.rate.disabled = !selected;
  ui.preset.disabled = !selected;
  for (const button of [ui.presetSave, ui.presetExport, ui.presetImport]) button.disabled = !selected;
  for (const button of [ui.mark, ui.camSensor, ui.camLevelReset, ui.cropBox, ui.cropFit, ui.cropReset]) {
    button?.toggleAttribute('disabled', !selected);
  }
  // Through the same painter the panel's own keyframe controls use, so the two cannot disagree
  // about whether there is a key at the playhead.
  paintKeyButton('transform', ui.keyClip);
}

/**
 * A clip of `id`, starting at `start`, on a row of its own.
 *
 * It comes up on the selected clip's look, or the first clip's when the stack has no selection.
 */
async function addClipFromTake(id, start) {
  if (refuseEdit('adding a clip')) return null;
  const initiating = selectedClipRow() ?? clips[0];
  if (clips.length + pendingClipAdds >= CLIP_CEILING) {
    say(`this build composites ${CLIP_CEILING} clips and this edit already holds ${clips.length}`);
    return null;
  }
  const from = withClip(initiating, () => params.values(scopeNames('clip')));
  const generation = documentGeneration;
  pendingClipAdds++;
  paintClipCommands();
  let opened;
  try {
    opened = await openSource(id);
  } finally {
    pendingClipAdds--;
    paintClipCommands();
  }
  if (generation !== documentGeneration || !clips.includes(initiating)) return null;
  if (refuseEdit('adding a clip')) return null;
  if (clips.length >= CLIP_CEILING) {
    say(`this build composites ${CLIP_CEILING} clips and this edit already holds ${clips.length}`);
    return null;
  }
  const gen = takeTransport();
  const wasPlaying = timeline.playing || timeline.pendingPlay;
  const held = timeline.programSec;
  timeline.pause();
  const clip = new Clip(mintClipId(), livePairs, createClipCloud());
  clips.push(clip);
  adoptSource(clip, opened);
  clip.start = start;
  withClip(clip, () => params.apply(from));
  orderClips();
  selectClipRow(clip);
  history.commit();
  await timeline.seek(Math.min(held, timeline.duration));
  if (wasPlaying && gen === transportGen) await timeline.play();
  return clip;
}

/**
 * The picked takes as clips, laid end to end from `from` in the order they were picked.
 *
 * One take is one clip at the playhead, which is exactly what a single add has always been - the
 * second and the third go after it rather than on top of it, because a pick of three that landed
 * three clips on one second is three clips nobody can see past the top one.
 */
async function addClipsFromTakes(ids, from) {
  let at = from;
  const added = [];
  for (const id of ids) {
    const clip = await addClipFromTake(id, at);
    // Whatever refused it has already said so, and the ones after it would be refused the same.
    if (clip === null) break;
    added.push(clip);
    at = clip.end;
  }
  return added;
}

/** Moves a clip's head to `wantStart` while the footage under the rest of it holds still. */
function headTrimTo(clip, wantStart, holdEnd) {
  const sourceDuration = clip.source.streaming ? Infinity : clip.source.duration;
  Object.assign(clip, headTrim(clip, wantStart, holdEnd, MIN_CLIP_SEC, sourceDuration));
}

/** Removes the selected clip. The last one refuses: an edit with no clip is not a document. */
function deleteSelectedClip() {
  const clip = selectedClipRow();
  if (!clip) return false;
  if (refuseEdit('deleting a clip')) return false;
  if (clips.length === 1) {
    say('this is the only clip in the edit, and a project carries at least one');
    return false;
  }
  const gen = takeTransport();
  const wasPlaying = timeline.playing || timeline.pendingPlay;
  const held = timeline.programSec;
  timeline.pause();
  const at = clips.indexOf(clip);
  clips.splice(at, 1);
  clipLanesShut.delete(clip.id);
  // Onto whatever took its place rather than onto nothing: the panel's clip half greys when the
  // strip holds no clip, and an edit that still has clips has one under the panel.
  selectClipRow(clips[Math.min(at, clips.length - 1)]);
  disposeCloudInstance(clip.cloud);
  // Its footage stays open with its frames dropped, which is what lets the undo of this put the
  // clip back without a fetch - see `restoreProject`.
  releaseUnusedFrames();
  orderClips();
  timingChanged();
  requestRepaint();
  history.commit();
  timeline.seek(Math.min(held, timeline.duration))
    .then(() => { if (wasPlaying && gen === transportGen) return timeline.play(); })
    .catch(showTimelineError);
  return true;
}

// The shared media picker, which is the library's tile with the lifecycle buttons taken off.
// It reads the library itself and words its own ceiling refusal, so this end says which edit is
// asking and where the clips land, and nothing else.
ui.addClip.addEventListener('click', () => {
  // Where the first of them lands, read at the gesture rather than after the dialog: the playhead
  // is where the operator was when they asked, and the picker is modal over it.
  const start = timeline ? timeline.programSec : 0;
  pickTakes({ ceiling: CLIP_CEILING, taken: clips.length, title: 'Add clips', confirmLabel: 'Add to the edit' })
    .then((picked) => {
      if (picked === null || picked.length === 0) return null;
      return addClipsFromTakes(picked.map((take) => take.id), start);
    })
    .catch(showTimelineError);
});
ui.deleteClip.addEventListener('click', () => { deleteSelectedClip(); });

/** The shapes a handle drag is usually reaching for, as one press each. */
const EASE_PRESETS = {
  linear: { out: EASE_OUT_LINEAR, in: EASE_IN_LINEAR },
  in: { in: [[0.58, 1]] },
  out: { out: [[0.42, 0]] },
  smooth: { out: [[0.42, 0]], in: [[0.58, 1]] },
  glide: { out: [[0.2, 0], [0.4, 0]], in: [[0.6, 1], [0.8, 1]] },
  ends: { firstOut: [[0.2, 0], [0.4, 0]], lastIn: [[0.6, 1], [0.8, 1]] },
  hold: { out: [[1, 0]], nextIn: [[1, 0]] },
};

/** The selected key, if a preset could shape it. Null covers three different no answers. */
function selectionEaseState() {
  if (!timeline || !selection) return null;
  const keys = keysOf(selection.owner);
  const i = keys.indexOf(selection.key);
  if (i < 0) return null;
  const row = laneRows().find((r) => r.owner === selection.owner);
  if (!row || !KINDS[row.kind].eases) return null;
  const before = i > 0 && segmentHasShape(keys, i - 1, row.kind);
  const after = i < keys.length - 1 && segmentHasShape(keys, i, row.kind);
  return before || after ? { keys, i, kind: row.kind } : null;
}

function applyEasePreset(name) {
  const state = selectionEaseState();
  const spec = EASE_PRESETS[name];
  if (!state || !spec) return false;
  if (refuseEdit('shaping a key')) return false;
  const { keys, i, kind } = state;
  if (spec.out) keys[i].easeOut = copyHandle(spec.out);
  if (spec.in) keys[i].easeIn = copyHandle(spec.in);
  if (spec.nextIn && i < keys.length - 1) keys[i + 1].easeIn = copyHandle(spec.nextIn);
  if (spec.firstOut && segmentHasShape(keys, 0, kind)) {
    keys[0].easeOut = copyHandle(spec.firstOut);
  }
  if (spec.lastIn && segmentHasShape(keys, keys.length - 2, kind)) {
    keys[keys.length - 1].easeIn = copyHandle(spec.lastIn);
  }
  lanesChanged();
  requestRepaint();
  history.commit();
  return true;
}

for (const btn of ui.ease.querySelectorAll('button[data-ease]')) {
  btn.addEventListener('click', () => {
    applyEasePreset(btn.dataset.ease);
  });
}

/** Whether the selected key's handles may grow or shrink, and on how many sides. */
function pointSides(delta, state) {
  if (!state) return [];
  const { keys, i, kind } = state;
  const sides = [];
  if (i < keys.length - 1 && segmentHasShape(keys, i, kind)) sides.push('easeOut');
  if (i > 0 && segmentHasShape(keys, i - 1, kind)) sides.push('easeIn');
  return sides.filter((side) => {
    const n = keys[i][side].length;
    return delta > 0 ? n < SEGMENT_POINT_CEILING : n > 1;
  });
}

/** Adds or removes a control point on every shapeable side of the selected key. */
function changePointCount(delta) {
  const state = selectionEaseState();
  const sides = pointSides(delta, state);
  if (sides.length === 0) return false;
  if (refuseEdit('reshaping a curve')) return false;
  const { keys, i } = state;
  for (const side of sides) {
    const seg = side === 'easeOut' ? i : i - 1;
    const a = keys[seg];
    const b = keys[seg + 1];
    if (delta > 0) {
      const up = elevate(a.easeOut, b.easeIn, side);
      a.easeOut = up.easeOut;
      b.easeIn = up.easeIn;
    } else if (side === 'easeOut') {
      a.easeOut = a.easeOut.slice(0, -1);
    } else {
      b.easeIn = b.easeIn.slice(1);
    }
  }
  lanesChanged();
  requestRepaint();
  history.commit();
  return true;
}

for (const [button, delta] of [[ui.addPoint, 1], [ui.dropPoint, -1]]) {
  button.addEventListener('click', () => {
    changePointCount(delta);
  });
}

// The dynamic controls area shows one of two chips: clip options when a clip row is selected,
// key options when a keyframe is selected, nothing when neither is.
function paintDynamicControls() {
  const keySelected = Boolean(selection && keysOf(selection.owner).includes(selection.key));
  const clipSelected = !keySelected && selectedClipRow() !== null;
  // Clip options.
  ui.clipOptions.classList.toggle('off', !clipSelected);
  // Key options.
  const easeState = selectionEaseState();
  const shapeable = Boolean(easeState);
  ui.ease.classList.toggle('off', !keySelected);
  for (const btn of ui.ease.querySelectorAll('button[data-ease]')) btn.disabled = !shapeable;
  ui.deleteKey.disabled = !keySelected;
  ui.addPoint.disabled = pointSides(1, easeState).length === 0;
  ui.dropPoint.disabled = pointSides(-1, easeState).length === 0;
  ui.prevKey.disabled = neighbourKeyTime(-1) === null;
  ui.nextKey.disabled = neighbourKeyTime(1) === null;
}

// Legacy name for callers that only care about the ease state.
const paintEase = paintDynamicControls;

/** The nearest key strictly before or after the playhead on the selected track, or null. */
function neighbourKeyTime(direction) {
  if (!timeline || !selection) return null;
  const { owner } = selection;
  const now = playheadSec();
  const tol = keyTolerance();
  // Through the lane's own clock: every key a clip owns is measured from its clip's in-point,
  // and stepping to one as though it were a program second lands elsewhere.
  const times = keysOf(owner)
    .map((k) => laneToProgram(owner, k.t))
    .filter((t) => (direction < 0 ? t < now - tol : t > now + tol));
  if (times.length === 0) return null;
  return direction < 0 ? Math.max(...times) : Math.min(...times);
}

for (const [button, direction] of [[ui.prevKey, -1], [ui.nextKey, 1]]) {
  button.addEventListener('click', () => {
    const t = neighbourKeyTime(direction);
    if (t === null) return;
    goTo(t);
  });
}

ui.deleteKey.addEventListener('click', () => { deleteSelectedKey(); });

/**
 * The double click that removes a key, tracked by hand rather than by a `dblclick` listener.
 */
let lastKeyClick = { key: null, at: 0 };
const DOUBLE_CLICK_MS = 400;

function paintKeyButton(name, btn) {
  const track = tracks.get(name);
  const state = !track || track.keys.length === 0
    ? 'none'
    : (track.keyAt(keyPlayhead(name), keyTolerance()) ? 'here' : 'some');
  btn.dataset.kf = state;
}

/** Updates the mark button icon: filled when the playhead is on a mark, stroked otherwise. */
function paintMarkButton() {
  if (!ui.mark) return;
  const t = playheadSec();
  const tol = keyTolerance();
  const onMark = takeMarks.some((m) => {
    const program = programSecOfSource(m.sourceMs / 1000);
    return Math.abs(program - t) <= tol;
  });
  const svg = ui.mark.querySelector('svg');
  if (!svg) return;
  const path = svg.querySelector('path');
  if (!path) return;
  if (onMark) {
    path.setAttribute('fill', 'currentColor');
    path.setAttribute('stroke', 'none');
  } else {
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
  }
}

// The furniture is drawn on a canvas of its own over the picture, since a camera move needs it.
const chromeCanvas = document.createElement('canvas');
chromeCanvas.id = 'chrome';
chromeCanvas.hidden = true;
document.body.appendChild(chromeCanvas);
const chromeCtx = chromeCanvas.getContext('2d');

// Reused across the plan's inner loop, which runs on the main thread on every paint.
const planVec = new THREE.Vector3();

// Whether the furniture is on screen. Off in the live viewer, which has no clip to compose.
let chromeOn = false;
let topViewVisible = true;
let statsVisible = false;
/** How long the GPU actually spent on the last frames, in milliseconds. */
const gpuTimer = {
  ext: null,
  probed: false,
  inFlight: [],
  samples: [],
  active: false,

  supported(gl) {
    if (!this.probed) {
      this.probed = true;
      this.ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    }
    return this.ext !== null;
  },

  begin(gl) {
    if (this.active || !this.supported(gl)) return;
    // Drained here and not only from the chrome paint: the two are not on the same clock.
    this.poll(gl);
    // Two in flight covers the latency, and only one TIME_ELAPSED query may be open at a time.
    if (this.inFlight.length >= 2) return;
    const query = gl.createQuery();
    gl.beginQuery(this.ext.TIME_ELAPSED_EXT, query);
    this.inFlight.push(query);
    this.active = true;
  },

  end(gl) {
    if (!this.active) return;
    gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.active = false;
  },

  /** Drains whatever has become available. Called from the chrome paint, not the seam. */
  poll(gl) {
    if (!this.ext || this.active) return;
    const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
    for (let i = this.inFlight.length - 1; i >= 0; i--) {
      const query = this.inFlight[i];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) continue;
      if (!disjoint) {
        this.samples.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
        if (this.samples.length > 30) this.samples.shift();
      }
      gl.deleteQuery(query);
      this.inFlight.splice(i, 1);
    }
  },

  /** The median rather than the mean: one descheduled frame outweighs the other twenty-nine. */
  median() {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  },
};

// The crop box and its handles, and the faint pass that shows what the box is cutting.
let showCropBox = false;
// Whether anything has rendered since the furniture was last drawn.
let chromeStale = false;

const cropBoxLive = () => showCropBox && clipGestureLive();

// How faintly a cut point draws while its crop handles are shown.
const CROP_FAINT = 0.14;
function syncCropOutside() {
  if (clips.length === 0) {
    uniforms.cropOutside.value = chromeOn && cropBoxLive() ? CROP_FAINT : 0;
    return;
  }
  const target = !EDITING || selectedClipRow() === selectedClip ? selectedClip : null;
  for (const clip of clips) {
    withClip(clip, () => {
      uniforms.cropOutside.value = clip === target && chromeOn && cropBoxLive() ? CROP_FAINT : 0;
    });
  }
}

const scratchVec = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchPosition = new THREE.Vector3();

function stageSize() {
  const size = renderer.getSize(new THREE.Vector2());
  return { w: size.x, h: size.y };
}

function insetRect() {
  const { w, h } = stageSize();
  return { x: w - INSET.w - INSET.margin, y: INSET.margin, w: INSET.w, h: INSET.h, stage: { w, h } };
}

function cameraKeys() {
  const track = tracks.get('camera');
  return track ? track.keys : [];
}

/** The sampled camera path, in world space. Empty below two keys: a point is not a path. */
const PATH_SAMPLES = 120;

function pathPoints() {
  const keys = cameraKeys();
  if (keys.length < 2) return [];
  const from = keys[0].t;
  const to = keys[keys.length - 1].t;
  const out = [];
  for (let i = 0; i < PATH_SAMPLES; i++) {
    out.push(poseAt(keys, from + ((to - from) * i) / (PATH_SAMPLES - 1)).position);
  }
  return out;
}

/** The program camera's frustum as world-space segments, off the camera the registry posed. */
function frustumSegments() {
  programCamera.updateMatrixWorld(true);
  const half = Math.tan((programCamera.fov * Math.PI) / 360) * FRUSTUM_LEN;
  const wide = half * programCamera.aspect;
  const corners = [[-wide, -half], [wide, -half], [wide, half], [-wide, half]].map(([x, y]) => scratchVec
    .set(x, y, -FRUSTUM_LEN).applyMatrix4(programCamera.matrixWorld).toArray());
  const apex = programCamera.position.toArray();
  const segments = corners.map((corner) => [apex, corner]);
  for (let i = 0; i < 4; i++) segments.push([corners[i], corners[(i + 1) % 4]]);
  return segments;
}

function strokePolyline(points) {
  let started = false;
  chromeCtx.beginPath();
  for (const p of points) {
    if (!p) { started = false; continue; }
    if (started) chromeCtx.lineTo(p.x, p.y);
    else chromeCtx.moveTo(p.x, p.y);
    started = true;
  }
  chromeCtx.stroke();
}

function drawNodes(project) {
  const keys = cameraKeys();
  keys.forEach((key, i) => {
    const p = project(key.value.position);
    if (!p) return;
    chromeCtx.beginPath();
    chromeCtx.arc(p.x, p.y, 3.5, 0, Math.PI * 2);
    chromeCtx.fillStyle = '#0d1014';
    chromeCtx.fill();
    chromeCtx.strokeStyle = selection && selection.owner === 'camera' && cameraKeys()[i] === selection.key
      ? '#e8ecf1' : '#5ad1c4';
    chromeCtx.lineWidth = 1.4;
    chromeCtx.stroke();
  });
}

// One bead every fourth sample. A legibility choice rather than a resolution.
const BEAD_EVERY = 4;

/**
 * Which of the path's samples get a bead, in world space. Equal time, so gaps read as speed.
 */
function beadPoints(points) {
  const out = [];
  for (let i = 0; i < points.length; i += BEAD_EVERY) out.push(points[i]);
  return out;
}

function drawBeads(points, project) {
  chromeCtx.fillStyle = 'rgba(90, 209, 196, 0.55)';
  for (const point of beadPoints(points)) {
    const p = project(point);
    if (!p) continue;
    chromeCtx.beginPath();
    chromeCtx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
    chromeCtx.fill();
  }
}

/** The point cloud from above, straight off the depth texture's own array. */
function drawPlanCloud(rect) {
  const depth = depthCurr.image.data;
  const previewDepth = previews?.plan(selectedClip?.id);
  let previewPoint = 0;
  const fx = uniforms.focal.value.x;
  const fy = uniforms.focal.value.y;
  const cx = uniforms.center.value.x;
  const cy = uniforms.center.value.y;
  const s = planScale(rect);
  level.updateWorldMatrix(true, false);
  level.getWorldQuaternion(scratchQuat);
  level.getWorldPosition(scratchPosition);
  chromeCtx.fillStyle = 'rgba(232, 236, 241, 0.55)';
  for (let row = 0; row < DEPTH_H; row += PLAN_STRIDE) {
    for (let col = 0; col < DEPTH_W; col += PLAN_STRIDE) {
      // Reuse the depth picker's forward map so the plan and pivot cannot drift apart.
      const mm = previewDepth ? previewDepth[previewPoint++] : depth[row * DEPTH_W + col];
      const z = sensorPoint(planVec, mm, col, row, fx, fy, cx, cy);
      if (z === 0) continue;
      // All four lateral faces, so the plan does not draw points the renderer discards.
      if (croppedOut(planVec.x, planVec.y, z)) continue;
      // A canted room drawn about the sensor's axes is a slanted section labelled TOP-DOWN.
      planVec.applyQuaternion(scratchQuat).add(scratchPosition);
      const px = rect.x + rect.w / 2 + (planVec.x - TOP_CENTRE.x) * s;
      const py = rect.y + rect.h / 2 + (planVec.z - TOP_CENTRE.z) * s;
      if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) continue;
      chromeCtx.fillRect(px, py, 1, 1);
    }
  }
}

// Indexed `axis * 2 + side`, side 0 being the low face.
const CROP_FACES = [
  { param: 'left', axis: 0, side: 0, flip: false },
  { param: 'right', axis: 0, side: 1, flip: false },
  { param: 'bottom', axis: 1, side: 0, flip: false },
  { param: 'top', axis: 1, side: 1, flip: false },
  { param: 'far', axis: 2, side: 0, flip: true },
  { param: 'near', axis: 2, side: 1, flip: true },
];

// A corner is three bits, one per axis, set when that axis is at its high bound.
const CROP_EDGES = [];
for (let axis = 0; axis < 3; axis++) {
  const b = (axis + 1) % 3;
  const c = (axis + 2) % 3;
  for (const sb of [0, 1]) {
    for (const sc of [0, 1]) {
      const from = (sb << b) | (sc << c);
      CROP_EDGES.push({ from, to: from | (1 << axis), faces: [b * 2 + sb, c * 2 + sc] });
    }
  }
}

// The four corners of each face, in ring order, as indices into the corner array.
const CROP_FACE_CORNERS = CROP_FACES.map(({ axis, side }) => {
  const b = (axis + 1) % 3;
  const c = (axis + 2) % 3;
  const base = side << axis;
  return [base, base | (1 << b), base | (1 << b) | (1 << c), base | (1 << c)];
});

const cropCorners = Array.from({ length: 8 }, () => new THREE.Vector3());
const cropSegA = new THREE.Vector3();
const cropSegB = new THREE.Vector3();
const cropCentre = new THREE.Vector3();
const cropNormal = new THREE.Vector3();
const cropProbe = new THREE.Vector3();
const cropEye = new THREE.Vector3();

let cropDrag = null;

/** The box's low and high bounds per axis, in sensor metres. */
function cropBoxBounds() {
  return {
    lo: [uniforms.cropL.value, uniforms.cropB.value, -uniforms.farClip.value],
    hi: [uniforms.cropR.value, uniforms.cropT.value, -uniforms.nearClip.value],
  };
}

/** The eight corners of the box, in the room's frame. The rotation is why this exists. */
function cropBoxCorners() {
  const { lo, hi } = cropBoxBounds();
  level.updateWorldMatrix(true, false);
  for (let i = 0; i < 8; i++) {
    cropCorners[i].set(
      (i & 1) ? hi[0] : lo[0],
      (i & 2) ? hi[1] : lo[1],
      (i & 4) ? hi[2] : lo[2],
    ).applyMatrix4(level.matrixWorld);
  }
  return cropCorners;
}

/** A face's outward normal in the room's frame, written into `out`. */
function cropFaceNormal(face, out) {
  level.updateWorldMatrix(true, false);
  level.getWorldQuaternion(scratchQuat);
  return out
    .set(face.axis === 0 ? 1 : 0, face.axis === 1 ? 1 : 0, face.axis === 2 ? 1 : 0)
    .multiplyScalar(face.side === 1 ? 1 : -1)
    .applyQuaternion(scratchQuat);
}

/** How a room-space point lands in the view, in stage pixels. One signature for both views. */
function cropProjector(plan, rect) {
  if (plan) return (p) => planPoint(rect, p.x, p.z);
  const stage = { x: 0, y: 0, ...stageSize() };
  return (p) => projectThrough(p.toArray(), viewCamera, stage);
}

/** A segment of the box, clipped so it can be drawn at all. */
function cropSegment(a, b, plan, rect, project) {
  if (plan) return [project(a), project(b)];
  const va = cropSegA.copy(a).applyMatrix4(viewCamera.matrixWorldInverse);
  const vb = cropSegB.copy(b).applyMatrix4(viewCamera.matrixWorldInverse);
  // View space looks down -z, so a point in front of the near plane has z below it.
  const near = -(viewCamera.near + 1e-4);
  if (va.z > near && vb.z > near) return null;
  if (va.z > near) va.lerp(vb, (va.z - near) / (va.z - vb.z));
  else if (vb.z > near) vb.lerp(va, (vb.z - near) / (vb.z - va.z));
  const { w, h } = stageSize();
  const at = (v) => {
    v.applyMatrix4(viewCamera.projectionMatrix);
    return { x: (w * (v.x + 1)) / 2, y: (h * (1 - v.y)) / 2 };
  };
  return [at(va), at(vb)];
}

/** Sutherland-Hodgman against one half-plane, used for both the near plane and the frame. */
function clipPolygon(points, inside, intersect) {
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const cur = points[i];
    const prev = points[(i + points.length - 1) % points.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn !== prevIn) out.push(intersect(prev, cur));
    if (curIn) out.push(cur);
  }
  return out;
}

/** The middle of a projected face: the area centroid, or the mean where there is no area. */
function polygonCentroid(points) {
  if (points.length === 0) return null;
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    const cross = p.x * q.y - q.x * p.y;
    area += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(area) > 1e-6) return { x: cx / (3 * area), y: cy / (3 * area) };
  let mx = 0;
  let my = 0;
  for (const p of points) { mx += p.x; my += p.y; }
  return { x: mx / points.length, y: my / points.length };
}

// Below this a face is too edge-on to drag: a metre would travel fewer pixels than this.
const CROP_LEVERAGE_MIN = 6;
const CROP_GRAB_PX = 11;

/** Where each face's handle sits and how far a metre of it travels on screen. */
function cropHandles(plan, rect) {
  if (!cropBoxLive()) return [];
  const corners = cropBoxCorners();
  const project = cropProjector(plan, rect);
  const frame = plan
    ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h }
    : { x: 0, y: 0, ...stageSize() };
  const near = -(viewCamera.near + 1e-4);
  const out = [];
  for (let f = 0; f < CROP_FACES.length; f++) {
    const face = CROP_FACES[f];
    let poly = CROP_FACE_CORNERS[f].map((i) => corners[i]);
    if (!plan) {
      // Clipped in view space, then projected: a quad straddling the eye has no projection.
      poly = poly.map((p) => p.clone().applyMatrix4(viewCamera.matrixWorldInverse));
      poly = clipPolygon(poly, (p) => p.z <= near, (a, b) => a.clone().lerp(b, (a.z - near) / (a.z - b.z)));
      if (poly.length < 3) continue;
      poly = poly.map((p) => {
        const q = p.clone().applyMatrix4(viewCamera.projectionMatrix);
        return { x: frame.w * (q.x + 1) / 2, y: frame.h * (1 - q.y) / 2 };
      });
    } else {
      poly = poly.map((p) => project(p));
      if (poly.some((p) => !p)) continue;
    }
    for (const [inside, cut] of [
      [(p) => p.x >= frame.x, (a, b) => lerpPoint(a, b, (frame.x - a.x) / (b.x - a.x))],
      [(p) => p.x <= frame.x + frame.w, (a, b) => lerpPoint(a, b, (frame.x + frame.w - a.x) / (b.x - a.x))],
      [(p) => p.y >= frame.y, (a, b) => lerpPoint(a, b, (frame.y - a.y) / (b.y - a.y))],
      [(p) => p.y <= frame.y + frame.h, (a, b) => lerpPoint(a, b, (frame.y + frame.h - a.y) / (b.y - a.y))],
    ]) {
      poly = clipPolygon(poly, inside, cut);
      if (poly.length < 3) break;
    }
    const at = polygonCentroid(poly);
    if (!at) continue;

    // How far one metre along the face's own normal moves that point, as a screen vector.
    const normal = cropFaceNormal(face, cropNormal);
    let centre = cropFaceCentre(f, corners, cropCentre);
    let a = project(centre);
    if (!a) {
      for (const i of CROP_FACE_CORNERS[f]) {
        a = project(corners[i]);
        if (a) { centre = cropCentre.copy(corners[i]); break; }
      }
    }
    if (!a) continue;
    // A quarter of a metre, so the probe stays in front of the camera, and
    // scaled back up after.
    const b = project(cropProbe.copy(centre).addScaledVector(normal, 0.25));
    if (!b) continue;
    const sx = (b.x - a.x) * 4;
    const sy = (b.y - a.y) * 4;
    if (Math.hypot(sx, sy) < CROP_LEVERAGE_MIN) continue;
    out.push({ face: f, param: face.param, at, sx, sy });
  }
  return out;
}

function lerpPoint(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** The middle of a face, in the room's frame. */
function cropFaceCentre(f, corners, out) {
  const ring = CROP_FACE_CORNERS[f];
  out.set(0, 0, 0);
  for (const i of ring) out.add(corners[i]);
  return out.multiplyScalar(0.25);
}

/** The box, its faces shaded by which way they face, and its handles. */
function drawCropBox(plan, rect) {
  const corners = cropBoxCorners();
  const project = cropProjector(plan, rect);
  const cutting = uniforms.cropOn.value === 1;

  // Front-facing is decided from the eye in the picture and from straight above in the plan.
  if (plan) cropEye.set(0, 1000, 0);
  else viewCamera.getWorldPosition(cropEye);
  const frontFacing = CROP_FACES.map((face, f) => {
    const centre = cropFaceCentre(f, corners, cropCentre);
    const normal = cropFaceNormal(face, cropNormal);
    return normal.dot(cropProbe.copy(cropEye).sub(centre)) > 0;
  });

  chromeCtx.save();
  const hue = cutting ? '240, 176, 74' : '150, 160, 172';
  if (!cutting) chromeCtx.setLineDash([4, 3]);
  for (const edge of CROP_EDGES) {
    const back = !frontFacing[edge.faces[0]] && !frontFacing[edge.faces[1]];
    const seg = cropSegment(corners[edge.from], corners[edge.to], plan, rect, project);
    if (!seg || !seg[0] || !seg[1]) continue;
    chromeCtx.strokeStyle = `rgba(${hue}, ${back ? 0.28 : 0.9})`;
    chromeCtx.lineWidth = back ? 0.75 : 1.2;
    chromeCtx.beginPath();
    chromeCtx.moveTo(seg[0].x, seg[0].y);
    chromeCtx.lineTo(seg[1].x, seg[1].y);
    chromeCtx.stroke();
  }

  chromeCtx.setLineDash([]);
  for (const handle of cropHandles(plan, rect)) {
    const held = cropDrag && cropDrag.param === handle.param;
    chromeCtx.beginPath();
    chromeCtx.rect(handle.at.x - 3.5, handle.at.y - 3.5, 7, 7);
    chromeCtx.fillStyle = '#0d1014';
    chromeCtx.fill();
    chromeCtx.strokeStyle = held ? '#e8ecf1' : `rgba(${hue}, 0.95)`;
    chromeCtx.lineWidth = 1.4;
    chromeCtx.stroke();
  }

  // On the recorder the box is a preview and has to say so.
  if (!plan && !EDITING) {
    chromeCtx.fillStyle = `rgba(${hue}, 0.9)`;
    chromeCtx.font = '9px ui-monospace, Menlo, monospace';
    chromeCtx.fillText('CROP BOX · PREVIEW ONLY, NOT WHAT IS RECORDED', 8, 16);
  }
  chromeCtx.restore();
}

function drawChrome() {
  if (!chromeOn || !chromeStale) return;
  chromeStale = false;
  const { w, h } = stageSize();
  const dpr = Math.min(devicePixelRatio, 2);
  if (chromeCanvas.width !== Math.round(w * dpr) || chromeCanvas.height !== Math.round(h * dpr)) {
    chromeCanvas.width = Math.round(w * dpr);
    chromeCanvas.height = Math.round(h * dpr);
  }
  chromeCanvas.style.width = `${w}px`;
  chromeCanvas.style.height = `${h}px`;
  // Onto the letterboxed stage, so the furniture lands on the pixels it annotates.
  chromeCanvas.style.left = `${stageBox.left}px`;
  chromeCanvas.style.top = `${stageBox.top}px`;
  chromeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  chromeCtx.clearRect(0, 0, w, h);

  const stage = { x: 0, y: 0, w, h };
  const path = pathPoints();

  // Over the picture: the path, its nodes and the shot the program camera has. Editor only.
  if (EDITING) {
    chromeCtx.lineWidth = 1.4;
    chromeCtx.strokeStyle = 'rgba(90, 209, 196, 0.85)';
    strokePolyline(path.map((p) => projectThrough(p, viewCamera, stage)));
    drawBeads(path, (p) => projectThrough(p, viewCamera, stage));
    chromeCtx.strokeStyle = 'rgba(255, 157, 90, 0.9)';
    chromeCtx.lineWidth = 1;
    for (const [a, b] of frustumSegments()) {
      strokePolyline([projectThrough(a, viewCamera, stage), projectThrough(b, viewCamera, stage)]);
    }
    drawNodes((p) => projectThrough(p, viewCamera, stage));
  }

  const rect = insetRect();

  // Outside the `EDITING` branch deliberately: the recorder has a box and no path.
  if (cropBoxLive()) drawCropBox(false, rect);

  if (topViewVisible) {
  chromeCtx.save();
  chromeCtx.beginPath();
  chromeCtx.rect(rect.x, rect.y, rect.w, rect.h);
  chromeCtx.fillStyle = 'rgba(13, 16, 20, 0.92)';
  chromeCtx.fill();
  chromeCtx.clip();

  chromeCtx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
  chromeCtx.lineWidth = 1;
  const origin = planPoint(rect, 0, 0);
  for (let m = 1; m <= 6; m++) {
    chromeCtx.beginPath();
    chromeCtx.arc(origin.x, origin.y, m * planScale(rect), Math.PI, 2 * Math.PI);
    chromeCtx.stroke();
  }

  drawPlanCloud(rect);

  if (cropBoxLive()) drawCropBox(true, rect);

  chromeCtx.strokeStyle = 'rgba(90, 209, 196, 0.9)';
  chromeCtx.lineWidth = 1.4;
  strokePolyline(path.map((p) => planPoint(rect, p[0], p[2])));
  drawBeads(path, (p) => planPoint(rect, p[0], p[2]));
  chromeCtx.strokeStyle = 'rgba(255, 157, 90, 0.9)';
  chromeCtx.lineWidth = 1;
  for (const [a, b] of frustumSegments()) {
    strokePolyline([planPoint(rect, a[0], a[2]), planPoint(rect, b[0], b[2])]);
  }
  drawNodes((p) => planPoint(rect, p[0], p[2]));

  chromeCtx.fillStyle = '#e8ecf1';
  chromeCtx.fillRect(origin.x - 3, origin.y - 1.5, 6, 3);

  chromeCtx.restore();
  chromeCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
  chromeCtx.lineWidth = 1;
  chromeCtx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  chromeCtx.fillStyle = '#6d7683';
  chromeCtx.font = '9px ui-monospace, Menlo, monospace';
  chromeCtx.fillText('TOP-DOWN', rect.x + 5, rect.y + rect.h - 5);
  }

  // Stats overlay, below the top-down view or in its place when hidden.
  if (statsVisible) {
    const statsY = topViewVisible ? rect.y + rect.h + INSET.margin : rect.y;
    const statsH = 178;
    const statsRect = { x: rect.x, y: statsY, w: rect.w, h: statsH };

    chromeCtx.fillStyle = 'rgba(13, 16, 20, 0.92)';
    chromeCtx.fillRect(statsRect.x, statsRect.y, statsRect.w, statsRect.h);
    chromeCtx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    chromeCtx.lineWidth = 1;
    chromeCtx.strokeRect(statsRect.x + 0.5, statsRect.y + 0.5, statsRect.w - 1, statsRect.h - 1);

    chromeCtx.font = '9px ui-monospace, Menlo, monospace';
    const lineH = 11;
    const col1 = statsRect.x + 8;
    const col2 = statsRect.x + 90;
    let y = statsRect.y + 12;

    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('PERF', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    chromeCtx.fillText(`${fps.toFixed(1)} fps in`, col2, y); y += lineH;
    gpuTimer.poll(renderer.getContext());
    const gpuMs = gpuTimer.median();
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('gpu', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    // Three states rather than two: a zero would read as free in the two non-measurements.
    chromeCtx.fillText(
      gpuTimer.supported(renderer.getContext())
        ? (gpuMs === null ? 'sampling' : `${gpuMs.toFixed(2)} ms`)
        : 'unavailable',
      col2, y,
    ); y += lineH;
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('viewport', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    chromeCtx.fillText(`${viewportFps.toFixed(1)} fps`, col2, y); y += lineH;
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('renders', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    chromeCtx.fillText(`${counters.renders}`, col2, y); y += lineH;
    if (timeline) {
      const footageFps = timeline.clip.source.count / timeline.clip.source.duration;
      chromeCtx.fillStyle = '#6d7683';
      chromeCtx.fillText('footage', col1, y);
      chromeCtx.fillStyle = '#e8ecf1';
      chromeCtx.fillText(`${footageFps.toFixed(1)} fps`, col2, y); y += lineH;
    }
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('frames in', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    chromeCtx.fillText(`${framesSeen}`, col2, y); y += lineH;

    // Resolution
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('output', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    // The deliverable's size, not the project's shape, because this row is headed output.
    chromeCtx.fillText(`${activeDeliverable?.outputSize ?? '—'}`, col2, y); y += lineH;
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('buffer', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    chromeCtx.fillText(`${Math.round(uniforms.bufferHeight.value)}p`, col2, y); y += lineH;

    // Geometry
    const shedding = uniforms.fadeTime.value > 0 || uniforms.wakeTime.value > 0;
    const drawCount = shedding ? POINTS * 2 : POINTS;
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('points', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    chromeCtx.fillText(`${(drawCount / 1000).toFixed(0)}k${shedding ? ' +shed' : ''}`, col2, y); y += lineH;

    // Post effects
    const posts = [afterimage.enabled && 'trail', mosh.enabled && 'mosh',
      bloom.enabled && 'bloom', grade.enabled && 'grade'].filter(Boolean);
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('post', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    chromeCtx.fillText(posts.length ? posts.join(' ') : 'none', col2, y); y += lineH;

    // Timeline
    if (timeline) {
      chromeCtx.fillStyle = '#6d7683';
      chromeCtx.fillText('time', col1, y);
      chromeCtx.fillStyle = '#e8ecf1';
      chromeCtx.fillText(`${timeline.programSec.toFixed(2)}s${timeline.playing ? ' \u25B6' : ''}`, col2, y); y += lineH;
      chromeCtx.fillStyle = '#6d7683';
      chromeCtx.fillText('tracks', col1, y);
      chromeCtx.fillStyle = '#e8ecf1';
      chromeCtx.fillText(`${tracks.size}`, col2, y); y += lineH;
    }

    // Undo
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('undo', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    chromeCtx.fillText(`${history.depth}`, col2, y); y += lineH;

    // Camera position
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('cam xyz', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    const cp = viewCamera.position;
    chromeCtx.fillText(`${cp.x.toFixed(1)} ${cp.y.toFixed(1)} ${cp.z.toFixed(1)}`, col2, y);
  }

  // Recording indicator: a red outline around the viewport while recording.
  if (recordState.recording) {
    const inset = 2;
    chromeCtx.strokeStyle = 'rgba(220, 38, 38, 0.9)';
    chromeCtx.lineWidth = 4;
    chromeCtx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
  }
}

function placeChrome() {
  chromeCanvas.hidden = !chromeOn;
  syncCropOutside();
  if (!chromeOn) return;
  chromeStale = true;
  drawChrome();
}
addEventListener('resize', placeChrome);

// Projected to the screen rather than raycast, so the same code serves both views.
const NODE_GRAB_PX = 9;

/** Where a node lands, in stage pixels, in whichever view is asked for. */
function nodeScreenPoint(position, plan) {
  if (plan) {
    const rect = insetRect();
    return planPoint(rect, position[0], position[2]);
  }
  return projectThrough(position, viewCamera, { x: 0, y: 0, ...stageSize() });
}

/** Which view a pointer is in. The plan wins where they overlap, since it is on top. */
function viewUnder(clientX, clientY) {
  const canvas = renderer.domElement.getBoundingClientRect();
  const x = clientX - canvas.left;
  const y = clientY - canvas.top;
  if (x < 0 || y < 0 || x > canvas.width || y > canvas.height) return null;
  const inset = insetRect();
  const plan = topViewVisible
    && x >= inset.x && x <= inset.x + inset.w && y >= inset.y && y <= inset.y + inset.h;
  return { plan, x, y };
}

function nodeUnder(view) {
  let best = null;
  cameraKeys().forEach((key, i) => {
    const p = nodeScreenPoint(key.value.position, view.plan);
    if (!p) return;
    const d = Math.hypot(p.x - view.x, p.y - view.y);
    if (d <= NODE_GRAB_PX && (!best || d < best.d)) best = { key, i, d, depth: p.z ?? 0 };
  });
  return best;
}

let nodeDrag = null;

// Captured on the window and not the canvas, because OrbitControls listens on the canvas.
addEventListener('pointerdown', (e) => {
  if (!chromeOn || e.target !== renderer.domElement) return;
  const view = viewUnder(e.clientX, e.clientY);
  if (!view) return;
  const hit = hitAfterOrbitSettles(() => nodeUnder(view));
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
  renderer.domElement.setPointerCapture(e.pointerId);
  controls.enabled = false;
  selection = { owner: 'camera', key: hit.key };
  nodeDrag = { plan: view.plan, hit, pointerId: e.pointerId };
}, true);

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!nodeDrag) return;
  const canvas = renderer.domElement.getBoundingClientRect();
  const x = e.clientX - canvas.left;
  const y = e.clientY - canvas.top;
  const p = nodeDrag.hit.key.value.position;
  // The plan view moves a node across the floor and leaves its height alone.
  if (nodeDrag.plan) {
    const world = planWorld(insetRect(), x, y);
    p[0] = world.x;
    p[2] = world.z;
  } else {
    const size = stageSize();
    scratchVec.set((x / size.w) * 2 - 1, 1 - (y / size.h) * 2, nodeDrag.hit.depth).unproject(viewCamera);
    p[0] = scratchVec.x;
    p[1] = scratchVec.y;
    p[2] = scratchVec.z;
  }
  requestRepaint();
});

for (const type of ['pointerup', 'pointercancel']) {
  renderer.domElement.addEventListener(type, () => {
    if (!nodeDrag) return;
    nodeDrag = null;
    controls.enabled = viewCamera === freeCamera;
    history.commit();
  });
}

/** The nearest crop handle to a press, in whichever view the press landed in. */
function cropHandleUnder(view) {
  const rect = insetRect();
  let best = null;
  for (const handle of cropHandles(view.plan, rect)) {
    const d = Math.hypot(handle.at.x - view.x, handle.at.y - view.y);
    if (d <= CROP_GRAB_PX && (!best || d < best.d)) best = { ...handle, d };
  }
  return best;
}

addEventListener('pointerdown', (e) => {
  if (!cropBoxLive() || !chromeOn || nodeDrag) return;
  if (e.target !== renderer.domElement || e.button !== 0) return;
  const view = viewUnder(e.clientX, e.clientY);
  if (!view) return;
  const hit = hitAfterOrbitSettles(() => cropHandleUnder(view));
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
  renderer.domElement.setPointerCapture(e.pointerId);
  controls.enabled = false;
  // The projection is read once and held for the gesture.
  cropDrag = {
    param: hit.param,
    face: hit.face,
    sx: hit.sx,
    sy: hit.sy,
    x: view.x,
    y: view.y,
    from: params.get(hit.param),
    pointerId: e.pointerId,
  };
  chromeStale = true;
  requestRepaint();
}, true);

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!cropDrag) return;
  const canvas = renderer.domElement.getBoundingClientRect();
  const x = e.clientX - canvas.left;
  const y = e.clientY - canvas.top;
  // How far the pointer travelled along the face's own normal, in metres.
  const { sx, sy } = cropDrag;
  const metres = ((x - cropDrag.x) * sx + (y - cropDrag.y) * sy) / (sx * sx + sy * sy);
  const face = CROP_FACES[cropDrag.face];
  // Outward is +axis for the high face of a pair and -axis for the low one.
  const coord = face.side === 1 ? metres : -metres;
  params.set(cropDrag.param, cropDrag.from + (face.flip ? -coord : coord));
  chromeStale = true;
  // Never a render here: `renderProgramFrame` advances navigation, so it would ask for another.
  requestRepaint();
});

for (const type of ['pointerup', 'pointercancel']) {
  renderer.domElement.addEventListener(type, () => {
    if (!cropDrag) return;
    cropDrag = null;
    controls.enabled = viewCamera === freeCamera;
    history.commit();
    chromeStale = true;
    requestRepaint();
  });
}

// Avoid hypersensitive near pivots and pivots beyond the drawn range.
const PIVOT_MIN_M = 0.15;

const pivotForward = new THREE.Vector3();

/** Moves the pivot along the view axis without changing the saved Reset pose. */
function setPivotDistance(distance) {
  const d = Math.min(Math.max(distance, PIVOT_MIN_M), uniforms.farClip.value);
  freeCamera.getWorldDirection(pivotForward);
  controls.target.copy(freeCamera.position).addScaledVector(pivotForward, d);
  return d;
}

// Capture before OrbitControls reads the target; a canvas listener would write it too late.
addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey
    || e.target !== renderer.domElement) return;
  if (nodeDrag || cropDrag) return;
  if (viewCamera !== freeCamera || !controls.enabled) return;
  if (timeline?.previewed) return;
  const view = viewUnder(e.clientX, e.clientY);
  if (!view || view.plan) return;
  const hit = hitAfterOrbitSettles(() => pickDepth({
    depth: depthCurr.image.data,
    focal: uniforms.focal.value,
    center: uniforms.center.value,
    tilt: level.quaternion,
    camera: freeCamera,
    stage: { x: 0, y: 0, ...stageSize() },
    x: view.x,
    y: view.y,
    croppedOut,
  }));
  // Empty space, a hole in the returns or a press past the crop box keeps the pivot it had.
  if (!hit) return;
  setPivotDistance(hit.distance);
}, true);

// The camera turning in place, where the orbit turns it about the pivot. `lookDrag` is declared
// with the fly state, because the fly gate has to read it.
const lookPivot = new THREE.Vector3();

// After the pick above, so `nodeDrag` and `cropDrag` are already set by the time this reads them.
addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.shiftKey || e.ctrlKey || e.metaKey
    || e.target !== renderer.domElement) return;
  if (lookDrag || nodeDrag || cropDrag) return;
  if (viewCamera !== freeCamera || !controls.enabled) return;
  const view = viewUnder(e.clientX, e.clientY);
  if (!view || view.plan) return;
  e.preventDefault();
  e.stopPropagation();
  renderer.domElement.setPointerCapture(e.pointerId);
  controls.enabled = false;
  // Or the damping residual turns the camera under the first frames of the drag.
  finishOrbitDrift();
  // Decided here and never mid-gesture: a look stays a look when shift lets go, and an orbit
  // stays an orbit when shift arrives. Changing meaning under the pointer would jump the camera.
  lookDrag = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
}, true);

renderer.domElement.addEventListener('pointermove', (e) => {
  if (!lookDrag || e.pointerId !== lookDrag.pointerId) return;
  const dx = e.clientX - lookDrag.x;
  const dy = e.clientY - lookDrag.y;
  lookDrag.x = e.clientX;
  lookDrag.y = e.clientY;
  // The pivot rides a sphere about the camera, so letting go of shift orbits whatever is now in
  // front of you at the distance it already had.
  lookPivot.subVectors(controls.target, freeCamera.position);
  lookOffset(lookPivot, freeCamera.up, dx, dy, freeCamera.fov, stageSize().h, lookPivot);
  controls.target.copy(freeCamera.position).add(lookPivot);
  // Never a render here: `renderProgramFrame` advances navigation, so it would ask for another.
  orbitRedrawWanted = true;
});

function stopLookDrag() {
  if (!lookDrag) return;
  const { pointerId } = lookDrag;
  lookDrag = null;
  if (renderer.domElement.hasPointerCapture(pointerId)) renderer.domElement.releasePointerCapture(pointerId);
  controls.enabled = viewCamera === freeCamera;
  orbitSettling = true;
}

for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
  renderer.domElement.addEventListener(type, (e) => {
    if (e.pointerId === lookDrag?.pointerId) stopLookDrag();
  });
}
addEventListener('blur', stopLookDrag);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopLookDrag(); });

function keyCameraHere() {
  if (!timeline) return;
  if (refuseEdit('keying the camera')) return;
  const track = trackFor('camera');
  // The pose you are looking from, which makes orbiting to a shot and keying it one gesture.
  finishOrbitDrift();
  freeCamera.updateMatrixWorld(true);
  track.setKey(playheadSec(), {
    position: freeCamera.position.toArray(),
    quaternion: freeCamera.quaternion.toArray(),
    fov: freeCamera.fov,
  }, keyTolerance());
  lanesChanged();
  requestRepaint();
  history.commit();
}
ui.camKey.addEventListener('click', keyCameraHere);
ui.tCamKey?.addEventListener('click', keyCameraHere);

ui.camClear.addEventListener('click', () => {
  if (refuseEdit('deleting a camera key')) return;
  const track = tracks.get('camera');
  const key = track?.keyAt(playheadSec(), keyTolerance());
  if (!key) return;
  track.removeKey(key);
  dropTrackIfEmpty('camera');
  lanesChanged();
  requestRepaint();
  history.commit();
});

// The band of lenses the row offers, in millimetres. It bounds what the row shows and nothing
// else: a stored `fov` comes from a key or from `sensorView`, and clamping that would refuse
// the sensor's own intrinsics.
const LENS_MIN_MM = 8;
const LENS_MAX_MM = 300;

/** The lens row: a focal length the slider can hold, or which way it ran out of band. */
function showLens(mm) {
  ui.camLens.value = Math.min(LENS_MAX_MM, Math.max(LENS_MIN_MM, mm)).toFixed(1);
  // The band is read at the resolution the row shows. A lens the wheel clamped to exactly 8mm
  // comes back from `fov` as 7.99999999, and comparing the raw number called that wider than
  // the band it had just been held inside.
  const shown = Number(mm.toFixed(1));
  if (shown < LENS_MIN_MM) ui.camLensOut.textContent = `wider than ${LENS_MIN_MM}mm`;
  else if (shown > LENS_MAX_MM) ui.camLensOut.textContent = `longer than ${LENS_MAX_MM}mm`;
  else ui.camLensOut.textContent = `${mm.toFixed(1)}mm`;
}

// The lens of whichever camera the viewport is drawing, which is the only reading that
// describes the picture on screen: under the program camera the row follows the playhead over
// a keyed move, and under the free camera it holds the lens just set and not yet keyed.
// Reading `programCamera` instead said 85mm over a 22.7mm picture the moment `set viewport to
// camera` was pressed with a staged lens.
let paintedFov = null;
let paintedAspect = null;
function paintLens() {
  // Off under the program camera, for the reason `setViewCamera` turns the orbit off there:
  // composing a lens is navigation, and the program camera's lens is what its keys say. Set
  // ahead of the memo, because the viewport can change while the angle it draws does not.
  ui.camLens.disabled = viewCamera !== freeCamera;
  // The aspect is half of what the row shows, so a reframed project is a moved lens even
  // though no camera turned: one angle is 22.7mm at 16:9 and 32.8mm at 1:1.
  const aspect = targetAspect();
  if (viewCamera.fov === paintedFov && aspect === paintedAspect) return;
  paintedFov = viewCamera.fov;
  paintedAspect = aspect;
  showLens(focalLengthForVerticalFov(viewCamera.fov, aspect));
}

// Onto the free camera, which is what `add key` then reads - the same route `sensorView` takes.
// The aspect is the project's and never `freeCamera.aspect`, which is the window's shape: that
// would move the lens on a resize and under `render %`, for a shot that has not moved.
ui.camLens.addEventListener('input', () => {
  const mm = Number(ui.camLens.value);
  freeCamera.fov = verticalFovForFocalLength(mm, targetAspect());
  freeCamera.updateProjectionMatrix();
  showLens(mm);
  requestRepaint();
});

// How much of the lens a pixel of wheel is worth. Multiplicative in millimetres, so a notch is
// the same fraction of the lens at 8mm and at 300mm.
const LENS_ZOOM_PER_PIXEL = 0.0015;

// Captured on the window, because OrbitControls listens for the wheel on the canvas and would
// dolly the same event.
addEventListener('wheel', (e) => {
  if (!e.shiftKey || e.ctrlKey || e.metaKey || e.target !== renderer.domElement) return;
  if (viewCamera !== freeCamera || !controls.enabled) return;
  const view = viewUnder(e.clientX, e.clientY);
  if (!view || view.plan) return;
  e.preventDefault();
  e.stopPropagation();
  // Shift and a wheel arrive with the axes swapped in some browsers, so the gesture reads
  // whichever axis moved rather than the vertical one.
  const delta = wheelPixels(e);
  const pixels = Math.abs(delta.x) > Math.abs(delta.y) ? delta.x : delta.y;
  const aspect = targetAspect();
  const mm = focalLengthForVerticalFov(freeCamera.fov, aspect)
    * Math.exp(-pixels * LENS_ZOOM_PER_PIXEL);
  freeCamera.fov = verticalFovForFocalLength(
    Math.min(LENS_MAX_MM, Math.max(LENS_MIN_MM, mm)), aspect,
  );
  freeCamera.updateProjectionMatrix();
  paintLens();
  requestRepaint();
}, { capture: true, passive: false });

// How far down the optical axis the orbit target lands.
const SENSOR_VIEW_DISTANCE = 2.2;

/** Puts the free camera where the Kinect is, looking the way the Kinect looks. */
function sensorView() {
  const fx = uniforms.focal.value.x;
  const fy = uniforms.focal.value.y;
  // Half-angles as tangents, which is the form the containment test needs anyway.
  const tanH = (DEPTH_W / 2) / fx;
  const tanV = (DEPTH_H / 2) / fy;
  // Fit rather than fill: `fov` is the vertical angle and the horizontal follows from aspect.
  finishOrbitDrift();
  const aspect = freeCamera.aspect;
  const binding = aspect >= tanH / tanV ? 'vertical' : 'horizontal';
  const fovV = binding === 'vertical' ? 2 * Math.atan(tanV) : 2 * Math.atan(tanH / aspect);
  freeCamera.fov = THREE.MathUtils.radToDeg(fovV);
  level.updateWorldMatrix(true, false);
  level.getWorldQuaternion(scratchQuat);
  level.getWorldPosition(scratchPosition);
  freeCamera.position.copy(scratchPosition);
  freeCamera.updateProjectionMatrix();
  params.set('spin', false);
  setNavigationUp(new THREE.Vector3(0, 1, 0).applyQuaternion(scratchQuat));
  controls.target.set(0, 0, -SENSOR_VIEW_DISTANCE).applyQuaternion(scratchQuat).add(scratchPosition);
  controls.update();
  paintLens();
  requestRepaint();
  return {
    fov: freeCamera.fov,
    binding,
    aspect,
    intrinsics: { fx, fy, cx: uniforms.center.value.x, cy: uniforms.center.value.y },
    position: freeCamera.position.toArray(),
    target: controls.target.toArray(),
  };
}

ui.camSensor.addEventListener('click', () => { sensorView(); });

/** Writes both world-rotation controls as one interaction. */
function writeWorldRotation(tilt, roll) {
  writeFromControl('roll', roll);
  writeFromControl('tilt', tilt);
  history.commit();
  requestRepaint();
  return { tilt: params.get('tilt'), roll: params.get('roll') };
}

function resetWorldRotation() {
  return writeWorldRotation(0, 0);
}

ui.camLevelReset.addEventListener('click', () => { resetWorldRotation(); });

ui.cropReset.addEventListener('click', () => {
  params.reset(['left', 'right', 'bottom', 'top', 'crop']);
  requestRepaint();
  history.commit();
});

if (ui.cropFit) {
  ui.cropFit.addEventListener('click', async () => {
    const clip = selectedClipRow();
    if (!clip?.take) return;
    const generation = documentGeneration;
    const id = clip.take.id;
    const near = withClip(clip, () => params.get('near'));
    const far = withClip(clip, () => params.get('far'));
    ui.cropFit.disabled = true;
    try {
      const fitted = await fitCropToTake(id, near, far, clip, generation);
      if (fitted?.cancelled) return;
      if (!fitted) {
        say('nothing inside the near/far range to fit the box to');
        return;
      }
      requestRepaint();
      history.commit();
    } catch (err) {
      say(`the crop box could not be fitted to this take: ${err.message}`);
    } finally {
      ui.cropFit.disabled = false;
    }
  });
}

// Show the box, its handles, and what it is cutting. Three effects and one control.
ui.cropBox.addEventListener('click', () => {
  showCropBox = !showCropBox;
  ui.cropBox.setAttribute('aria-pressed', String(showCropBox));
  syncCropOutside();
  chromeStale = true;
  drawChrome();
  requestRepaint();
});
ui.cropBox.setAttribute('aria-pressed', 'false');

/** Mirrored from `VALID_NAME` in `server/export.js`, which is the copy that is enforced. */
const EXPORT_NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const CAN_SAVE_AS = typeof globalThis.showSaveFilePicker === 'function';

/** What the render will be called. The field, or the take's id when it is empty. */
function exportBaseName() {
  const typed = ui.exportName.value.trim();
  return typed || (timeline ? timeline.clip.source.id : 'export');
}

function paintExportName() {
  const typed = ui.exportName.value.trim();
  const ok = typed === '' || EXPORT_NAME_OK.test(typed);
  ui.exportNameChip.classList.toggle('bad', !ok);
  ui.exportGo.disabled = exporting || !ok;
  return ok;
}

/** The typed name, into the document that is supposed to remember it. */
function takeExportName() {
  ensureActiveDeliverable();
  activeDeliverable.name = ui.exportName.value;
  paintDeliverable();
}

ui.exportName.addEventListener('input', () => {
  takeExportName();
  paintExportName();
});

// The last render. `output` is a server path, `href` the same file over HTTP.
let lastExport = null;

// When a copy can be handed over, stated once.
const canSaveExportCopy = () => Boolean(lastExport) && CAN_SAVE_AS && lastExport.frameExt == null;

function paintExportSave() {
  // A sequence is a directory, and this button hands over one file.
  const sequence = lastExport?.frameExt != null;
  ui.exportSave.disabled = !canSaveExportCopy();
  ui.exportSave.title = !CAN_SAVE_AS
    ? 'This browser has no file picker - the render is in the exports directory on the server'
    : sequence
      ? `${lastExport.file} is a directory of ${lastExport.frameExt} frames - it is in the exports directory on the server`
      : (lastExport ? `Save a copy of ${lastExport.file}` : 'Render something first');
}

ui.exportGo.addEventListener('click', async () => {
  if (exporting) return;
  if (!paintExportName()) {
    sayExport('that name would not be a filename - letters, digits, dot, dash and underscore');
    return;
  }
  ui.exportGo.disabled = true;
  lastExport = null;
  paintExportSave();
  const { outputSize } = activeDeliverable || {};
  sayExport(`export ${outputSize ?? '1920x1080'} starting`);
  try {
    const done = await exportClip({
      suppressEffects: [...suppressedEffects],
      onProgress: (n, total) => {
        sayExport(`export ${Math.round((n / total) * 100)}% · frame ${n}/${total}`);
      },
    });
    lastExport = { href: done.href, file: done.href.split('/').pop(), frameExt: done.frameExt ?? null };
    sayExport(`${lastExport.file} · ${done.frames} frames · ${(done.bytes / 1e6).toFixed(1)} MB `
      + `in ${(done.elapsedMs / 1000).toFixed(1)}s`);
  } catch (err) {
    sayExport(`export failed: ${err.message}`);
    showTimelineError(err);
  } finally {
    paintExportName();
    paintExportSave();
  }
});

// Called rather than clicked, by the button beside the render and by Output > Export.
async function saveExportCopy() {
  if (!lastExport) return;
  try {
    // The picker opens before any await: `showSaveFilePicker` needs transient user activation.
    const handle = await globalThis.showSaveFilePicker({ suggestedName: lastExport.file });
    const res = await fetch(lastExport.href);
    if (!res.ok) throw new Error(`the render could not be read back: HTTP ${res.status}`);
    const writable = await handle.createWritable();
    // Streamed rather than buffered, because a 4K render is gigabytes.
    await res.body.pipeTo(writable);
    sayExport(`saved a copy of ${lastExport.file}`);
  } catch (err) {
    // Cancelling the sheet is an answer, not a failure.
    if (err?.name === 'AbortError') return;
    sayExport(`save failed: ${err.message}`);
  }
}

ui.exportSave.addEventListener('click', saveExportCopy);

paintExportSave();

ui.exportSize.addEventListener('change', () => {
  setDeliverableSize(ui.exportSize.value);
});
setProjectAspect(defaultAspect(), { fromDocument: true });

ui.mark.addEventListener('click', () => { toggleMarkHere().catch(showTimelineError); });

/** `near`/`far` are viewer uniforms and must never reach `--min-depth`/`--max-depth`. */
function paintPreviewRange(minDepth, maxDepth) {
  const kept = Number.isFinite(minDepth) && Number.isFinite(maxDepth)
    ? `capture keeps ${minDepth.toFixed(2)}-${maxDepth.toFixed(2)}m`
    : 'capture keeps everything the sensor resolves';
  ui.recRange.textContent = `preview only · ${kept}`;
}

// Every control that starts a preset gesture, named once so a fifth is covered by being added.
const PRESET_WRITERS = [ui.presetSave, ui.presetExport, ui.presetImport];

let presetGesture = false;

/** One preset gesture at a time, whichever control started it. */
async function withPresetGesture(note, run) {
  if (presetGesture) {
    note.textContent = 'a preset gesture is still running, so this one did not start';
    return false;
  }
  presetGesture = true;
  try {
    await run();
  } finally {
    presetGesture = false;
  }
  return true;
}

/** The controls held down while a request is unanswered, and the caret handed back after. */
async function whileWriting(run) {
  const held = document.activeElement;
  for (const el of PRESET_WRITERS) el.disabled = true;
  try {
    return await run();
  } finally {
    for (const el of PRESET_WRITERS) el.disabled = EDITING && selectedClipRow() === null;
    const stranded = document.activeElement === null || document.activeElement === document.body;
    if (stranded && PRESET_WRITERS.includes(held) && held.isConnected) held.focus();
  }
}

/** Pick a subset, then do one thing with it, inside the one gesture the program allows. */
async function withPresetSubset(ask, run) {
  if (EDITING && selectedClipRow() === null) {
    say('select a clip before saving or exporting its look');
    return;
  }
  await withPresetGesture(ui.note, async () => {
    try {
      const picked = await pickPresetSubset(ask);
      if (!picked) return;
      await whileWriting(() => run(picked));
    } catch (err) {
      showTimelineError(err);
    }
  });
}

// Named by the user: a library whose entries are "preset 3" is one nobody uses twice.
ui.presetSave.addEventListener('click', () => withPresetSubset(
  { title: 'Save this look', verb: 'save', name: appliedPreset()?.name ?? 'look-1' },
  async (picked) => {
    const target = EDITING ? selectedClipRow() : selectedClip;
    const generation = documentGeneration;
    const body = presetFromCurrentLook(picked.names);
    const saved = await writeDocumentAtCurrentRev('presets', picked.name, { body });
    const whole = wholeLookTag(body.values);
    const targetIsCurrent = generation === documentGeneration && target && clips.includes(target);
    if (whole && targetIsCurrent) {
      stampPreset(target, { name: saved.name, rev: saved.rev });
      history.commit();
    }
    await refreshPresets();
  },
));

ui.presetExport.addEventListener('click', () => withPresetSubset(
  {
    title: 'Export this look',
    verb: 'export',
    name: ui.preset.value || appliedPreset()?.name || 'look',
  },
  async (picked) => {
    exportPresetFile(picked.name, presetFromCurrentLook(picked.names));
  },
));

// Two halves of one control: a file input cannot be styled into the strip.
ui.presetImport.addEventListener('click', () => ui.presetFile.click());
ui.presetFile.addEventListener('change', () => {
  const file = ui.presetFile.files?.[0];
  // Cleared before the await, so choosing the same file twice still fires `change`.
  ui.presetFile.value = '';
  if (!file) return;
  return withPresetGesture(ui.note, () => whileWriting(async () => {
    try {
      const saved = await importPresetFile(file);
      await refreshPresets();
      showPickerChoice(pickers.find((p) => p.trigger === ui.preset), appliedPreset()?.name ?? '');
    } catch (err) {
      showTimelineError(err);
    }
  }));
});

/**
 * Files the open document under the first free name `pick` offers, and again under the next one
 * if the store says that name is taken.
 *
 * `rev=absent` - which is what `server/library.js` calls the revision of a name nothing is filed
 * under - is what makes this safe rather than the listing being fresh: two tabs both choosing
 * `Untitled 1` are answered by the file, so the loser is told and takes the next name. Bounded,
 * because a create that keeps being refused for some other reason is a loop.
 */
async function createProjectUnder(pick, body) {
  const taken = new Set((await listProjects()).map((doc) => doc.name));
  for (let tries = 0; tries < 12; tries++) {
    const name = pick(taken);
    const res = await fetch(`/projects/${encodeURIComponent(name)}?rev=absent`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const saved = await res.json().catch(() => null);
    if (res.ok && !saved?.error) return saved;
    if (res.status !== 409) throw documentRefusal(res, saved);
    // The name went while this was being decided. Out of the reckoning, and ask for the next.
    taken.add(name);
  }
  throw new Error('twelve names in a row were taken while this project was being written');
}

/** Where a page lands once it holds a document: what it writes into, and what it is called. */
function enterProject(saved) {
  openedProjectName = saved.name;
  openedProjectRev = saved.rev;
  lastSavedAt = Date.now();
  showProjectInUrl(saved.name);
  paintProjectCommands();
}

/**
 * The name a mint takes: one take names the project after itself, and two or more give the free
 * `Untitled N`. A take id is not held to the document-name rule - `all` is a route here and
 * nothing stops a capture being called that - so a name this store would refuse falls through to
 * the free one rather than refusing the mint.
 */
function mintName(ids, taken) {
  const wanted = ids.length === 1 ? ids[0] : null;
  if (wanted !== null && !taken.has(wanted) && documentNameRefusal('project', wanted) === null) {
    return wanted;
  }
  return nextUntitledName(taken);
}

/**
 * `/edit?new=` : a project cut from these takes, laid end to end in this order, landed in.
 *
 * Only this page can mint one. A document carries a look block whose parameter list is the live
 * registry's, and the registry is assembled at run time out of the effects this build has
 * installed, so a page without one cannot write a body `checkProject` would take.
 */
async function mintProjectFrom(ids) {
  await openTake(ids[0]);
  if (ids.length > 1) await addClipsFromTakes(ids.slice(1), clips[0].end);
  const saved = await createProjectUnder((taken) => mintName(ids, taken), serialiseProjectBody());
  enterProject(saved);
  // From the document, the way a load starts: the clips this mint just laid down are what the
  // file says, so there is nothing behind them to undo back to.
  history.begin();
}

/**
 * Stamps a copy of the open edit and leaves you in it, because forking is how somebody declines
 * to keep something once there is no save to withhold. The original is untouched and one row
 * down the projects page. The undo stack comes along - the work is the same work.
 */
async function duplicateProject() {
  const body = serialiseProjectBody();
  const from = openedProjectName;
  const saved = await queueProjectWrite(() => createProjectUnder(
    (taken) => (from === null ? nextUntitledName(taken) : copyName(from, taken)), body,
  ));
  enterProject(saved);
  // A file nobody else holds, so whatever refused the last one has nothing to say about this.
  projectDiverged = false;
  if (ui.diverged) ui.diverged.title = '';
  paintDiverged();
}

/**
 * Moves the open project to `to`. One call rather than a create and a delete, because two would
 * leave a window with the edit filed under both names and a crash in it leaves two forever - and
 * it goes through the same queue as the auto-save, or a rename could overtake a write and move
 * the file out from under it.
 */
async function renameProjectTo(to) {
  const saved = await queueProjectWrite(async () => {
    const res = await fetch(`/projects/${encodeURIComponent(openedProjectName)}/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, rev: openedProjectRev }),
    });
    const answer = await res.json().catch(() => null);
    if (!res.ok || answer?.error) throw documentRefusal(res, answer);
    return answer;
  });
  openedProjectName = saved.name;
  openedProjectRev = saved.rev;
  showProjectInUrl(saved.name);
  paintProjectCommands();
}

/** The two File items that need a document, on a page that may be holding none. */
function paintProjectCommands() {
  const held = EDITING && openedProjectName !== null;
  const why = EDITING
    ? 'this page was opened on a take, so it holds no project to act on'
    : 'the recorder holds no project to act on';
  for (const control of [shell.renameProject, shell.duplicateProject]) {
    control.disabled = !held;
    control.title = held ? '' : why;
  }
}

ui.deliverable?.addEventListener('change', async () => {
  const name = ui.deliverable.value;
  if (!name) return;
  try {
    const doc = await (await fetch(`/deliverables/${encodeURIComponent(name)}`)).json();
    if (doc.error) throw new Error(doc.error);
    applyDeliverable(doc.body);
    showAdoptedDeliverable(name);
  } catch (err) {
    ui.deliverable.value = ui.deliverable.dataset.adopted ?? '';
    showTimelineError(err);
  }
});

ui.deliverableNew?.addEventListener('click', async () => {
  const name = prompt('name this deliverable', `deliverable-${Date.now()}`);
  if (!name) return;
  ensureActiveDeliverable();
  try {
    await saveDeliverable(name, activeDeliverable);
    await refreshDeliverables();
    showAdoptedDeliverable(name);
  } catch (err) {
    showTimelineError(err);
  }
});

/** Every element the shell drives, looked up so that a missing one names itself. */
function shellElements(ids) {
  const found = {};
  const missing = [];
  for (const [key, id] of Object.entries(ids)) {
    const el = document.getElementById(id);
    if (el === null) missing.push(`#${id}`);
    found[key] = el;
  }
  if (missing.length > 0) {
    const what = `${EDITING ? 'editor' : 'record'} surface is missing ${missing.join(', ')}`;
    if (statusEl !== null) statusEl.textContent = what;
    throw new Error(`${what} - the page cannot finish starting, so nothing below this ran`);
  }
  return found;
}

const shell = shellElements({
  surfaceName: 'surfaceName',
  renameProject: 'menuRenameProject',
  duplicateProject: 'menuDuplicateProject',
  projectSettings: 'menuProjectSettings',
  wholeClip: 'menuWholeClip',
  export: 'menuExport',
  obs: 'menuObs',
  cameraReset: 'menuCameraReset',
  showSidebar: 'menuShowSidebar',
  dockRec: 'dockRec',
  dockMark: 'dockMark',
  dockCentre: 'dockCentre',
  dockSensor: 'dockSensor',
  topView: 'menuTopView',
  lookImport: 'menuLookImport',
  lookExport: 'menuLookExport',
  state: 'menuState',
  effectRackOpen: 'effectRackOpen',
  effectRackPanel: 'effectRackPanel',
  effectRackClose: 'effectRackClose',
  effectRackSearch: 'effectRackSearch',
  effectRackList: 'effectRackList',
  exportClose: 'exportClose',
  projectDialog: 'projectDialog',
  projectClose: 'projectClose',
  projectDone: 'projectDone',
  renameDialog: 'renameDialog',
  renameClose: 'renameClose',
  renameCancel: 'renameCancel',
  renameGo: 'renameGo',
  renameField: 'renameField',
  renameName: 'renameName',
  renameNote: 'renameNote',
  obsDialog: 'obsDialog',
  obsClose: 'obsClose',
  obsDone: 'obsDone',
  obsProgram: 'obsProgramMode',
  obsViewport: 'obsViewportMode',
  obsResolution: 'obsResolution',
  obsCustomSize: 'obsCustomSize',
  obsBrowserUrl: 'obsBrowserUrl',
  obsWebcamUrl: 'obsWebcamUrl',
  obsCopyBrowser: 'obsCopyBrowser',
  obsCopyWebcam: 'obsCopyWebcam',
  obsOpen: 'obsOpen',
  obsStatus: 'obsStatus',
  obsStatusText: 'obsStatusText',
});

// `menus` is a query rather than an id, so it sits outside the table above.
shell.menus = [...document.querySelectorAll('.appmenu')];

shell.surfaceName.textContent = EDITING ? 'Editor' : 'Record';
for (const control of [
  shell.projectSettings, shell.wholeClip, shell.export, shell.lookImport, shell.lookExport,
]) {
  control.disabled = !EDITING;
}
// The two document items have a second condition beside the surface - whether this page is
// holding a project at all - so one painter owns them rather than this loop and that painter both.
paintProjectCommands();

function closeApplicationMenus({ restore = false } = {}) {
  for (const menu of shell.menus) {
    const trigger = menu.querySelector('.appmenu-trigger');
    const popover = menu.querySelector('.appmenu-popover');
    const wasOpen = !popover.hidden;
    popover.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restore && wasOpen) trigger.focus();
  }
}

for (const menu of shell.menus) {
  const trigger = menu.querySelector('.appmenu-trigger');
  const popover = menu.querySelector('.appmenu-popover');
  trigger.addEventListener('click', () => {
    const opening = popover.hidden;
    closeApplicationMenus();
    popover.hidden = !opening;
    trigger.setAttribute('aria-expanded', String(opening));
    if (opening) popover.querySelector('[role="menuitem"]:not(:disabled)')?.focus();
  });
}

document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('.appmenu')) closeApplicationMenus();
});

function openDialog(dialog) {
  // A dialog opened part-way through a render shows where the render is, rather than the
  // bar it was left with when it was closed.
  if (dialog === ui.exportDialog) paintExportProgress();
  // A menu command is hidden before the modal opens, and focus cannot be restored to it.
  const active = document.activeElement;
  const returnFocus = active instanceof HTMLElement
    ? active.closest('.appmenu')?.querySelector('.appmenu-trigger') ?? active
    : null;
  closeApplicationMenus();
  if (!dialog.open) {
    const restoreFocus = () => {
      dialog.removeEventListener('close', restoreFocus);
      returnFocus?.focus();
    };
    dialog.addEventListener('close', restoreFocus);
    dialog.showModal();
  }
}

shell.projectSettings.addEventListener('click', () => openDialog(shell.projectDialog));
function closeEffectRack({ restore = false } = {}) {
  shell.effectRackPanel.hidden = true;
  shell.effectRackOpen.setAttribute('aria-expanded', 'false');
  if (restore) shell.effectRackOpen.focus();
}

function openEffectRack() {
  shell.effectRackSearch.value = '';
  paintEffectRackDialog();
  shell.effectRackPanel.hidden = false;
  shell.effectRackOpen.setAttribute('aria-expanded', 'true');
  shell.effectRackSearch.focus();
}

shell.effectRackOpen.addEventListener('click', () => {
  if (shell.effectRackPanel.hidden) openEffectRack();
  else closeEffectRack({ restore: true });
});
shell.effectRackClose.addEventListener('click', () => closeEffectRack({ restore: true }));
shell.effectRackSearch.addEventListener('input', () => paintEffectRackDialog());
shell.wholeClip.addEventListener('click', () => {
  closeApplicationMenus();
  clearClipRange();
});
shell.export.addEventListener('click', () => openDialog(ui.exportDialog));
shell.renameProject.addEventListener('click', () => {
  closeApplicationMenus();
  if (openedProjectName === null) return;
  shell.renameName.value = openedProjectName;
  paintRenameRefusal();
  openDialog(shell.renameDialog);
  shell.renameName.select();
});

shell.duplicateProject.addEventListener('click', () => {
  closeApplicationMenus();
  if (openedProjectName === null) return;
  duplicateProject().catch(showTimelineError);
});

// The banner's own copy of the same act, because the banner is where somebody who cannot save is
// looking and a menu two clicks away is not a recovery.
ui.divergedCopy?.addEventListener('click', () => {
  ui.divergedCopy.disabled = true;
  duplicateProject()
    .catch(showTimelineError)
    .finally(() => { ui.divergedCopy.disabled = false; });
});

/** What the typed name would be refused for, said while it is being typed. */
function paintRenameRefusal() {
  const to = shell.renameName.value.trim();
  const refused = to === openedProjectName
    ? 'that is already its name'
    : documentNameRefusal('project', to);
  shell.renameField.classList.toggle('bad', to !== '' && refused !== null);
  shell.renameGo.disabled = refused !== null;
  shell.renameNote.textContent = refused ?? '';
}

shell.renameName.addEventListener('input', paintRenameRefusal);
shell.renameName.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || shell.renameGo.disabled) return;
  event.preventDefault();
  shell.renameGo.click();
});
shell.renameGo.addEventListener('click', () => {
  const to = shell.renameName.value.trim();
  shell.renameDialog.close();
  renameProjectTo(to).catch(showTimelineError);
});
shell.renameClose.addEventListener('click', () => shell.renameDialog.close());
shell.renameCancel.addEventListener('click', () => shell.renameDialog.close());
shell.lookImport.addEventListener('click', () => {
  closeApplicationMenus();
  ui.presetImport.click();
});
shell.lookExport.addEventListener('click', () => {
  closeApplicationMenus();
  ui.presetExport.click();
});

shell.cameraReset.addEventListener('click', () => {
  closeApplicationMenus();
  finishOrbitDrift();
  controls.reset();
  requestRepaint();
});

/** Collapse the settings to the dock, or bring them back. One writer for one class. */
function setPanelCollapsed(collapsed) {
  document.body.classList.toggle('panelcollapsed', collapsed);
  // "Show inspector" checked means visible, so the boolean inverts.
  shell.showSidebar.setAttribute('aria-checked', String(!collapsed));
  // The cloud's viewport is the window minus the panel, so collapsing changes the canvas.
  resize();
}

shell.showSidebar.addEventListener('click', () => {
  closeApplicationMenus();
  setPanelCollapsed(!document.body.classList.contains('panelcollapsed'));
});

if (new URLSearchParams(location.search).get('panel') === 'collapsed') setPanelCollapsed(true);

// The dock presses the real controls rather than repeating what they do.
shell.dockRec.addEventListener('click', () => ui.recGo.click());
shell.dockMark.addEventListener('click', () => ui.recMark.click());
shell.dockCentre.addEventListener('click', () => shell.cameraReset.click());
shell.dockSensor.addEventListener('click', () => ui.camSensor.click());

shell.topView.addEventListener('click', () => {
  topViewVisible = !topViewVisible;
  shell.topView.setAttribute('aria-checked', String(topViewVisible));
  chromeStale = true;
  drawChrome();
  closeApplicationMenus();
});

function setObsMode(mode) {
  const value = mode === 'viewport' ? 'mirror' : 'camera';
  if (progModeEl.value !== value) {
    progModeEl.value = value;
    progModeEl.dispatchEvent(new Event('change', { bubbles: true }));
  }
  shell.obsProgram.setAttribute('aria-pressed', String(value === 'camera'));
  shell.obsViewport.setAttribute('aria-pressed', String(value === 'mirror'));
}

/** The footer's dot, driven by what the server is actually serving. */
const OBS_POLL_MS = 2000;
let obsPollTimer = null;
let obsPollInFlight = false;

async function refreshObsStatus() {
  // One question at a time, or a tick landing on an unanswered one paints the older answer.
  if (obsPollInFlight) return;
  obsPollInFlight = true;
  try {
    const state = await (await fetch('/record/state')).json();
    const webcam = state?.webcam ?? {};
    const n = (webcam.subscribers ?? []).length;
    shell.obsStatus.classList.toggle('live', n > 0);
    // A server with no colour camera is a third state and not a quiet kind of idle.
    shell.obsStatusText.textContent = webcam.unavailable
      ? webcam.unavailable
      : (n === 0
        ? 'idle - nothing is reading'
        : `streaming to ${n} ${n === 1 ? 'source' : 'sources'}`);
  } catch {
    // Say so rather than holding the last answer: a stale count reads as a live stream.
    shell.obsStatus.classList.remove('live');
    shell.obsStatusText.textContent = 'status unavailable';
  } finally {
    obsPollInFlight = false;
  }
}

function startObsStatusPoll() {
  stopObsStatusPoll();
  refreshObsStatus();
  obsPollTimer = setInterval(refreshObsStatus, OBS_POLL_MS);
}

function stopObsStatusPoll() {
  if (obsPollTimer !== null) clearInterval(obsPollTimer);
  obsPollTimer = null;
}

// On the dialog's `close` and not the done button: Escape and the glyph are doors too.
shell.obsDialog.addEventListener('close', stopObsStatusPoll);

function paintObsDialog() {
  shell.obsBrowserUrl.value = new URL('/program', location.href).href;
  shell.obsWebcamUrl.value = new URL('/camera.mjpg', location.href).href;
  for (const option of shell.obsResolution.querySelectorAll('option[data-current]')) option.remove();
  if (![...shell.obsResolution.options].some((option) => option.value === progSizeEl.value)) {
    const option = document.createElement('option');
    option.value = progSizeEl.value;
    option.textContent = `${progSizeEl.value} · current`;
    option.dataset.current = '';
    shell.obsResolution.appendChild(option);
  }
  shell.obsResolution.value = progSizeEl.value;
  shell.obsCustomSize.hidden = true;
  setObsMode(progModeEl.value === 'mirror' ? 'viewport' : 'program');
  startObsStatusPoll();
}

shell.obs.addEventListener('click', () => {
  paintObsDialog();
  openDialog(shell.obsDialog);
});
shell.obsProgram.addEventListener('click', () => setObsMode('program'));
shell.obsViewport.addEventListener('click', () => setObsMode('viewport'));
shell.obsResolution.addEventListener('change', () => {
  // `custom` names no size: it reveals the field beside it and hands it the caret.
  if (shell.obsResolution.value === 'custom') {
    shell.obsCustomSize.hidden = false;
    shell.obsCustomSize.value = progSizeEl.value;
    shell.obsCustomSize.focus();
    shell.obsCustomSize.select();
    return;
  }
  shell.obsCustomSize.hidden = true;
  progSizeEl.value = shell.obsResolution.value;
  progSizeEl.dispatchEvent(new Event('change', { bubbles: true }));
});

shell.obsCustomSize.addEventListener('change', () => {
  progSizeEl.value = shell.obsCustomSize.value;
  progSizeEl.dispatchEvent(new Event('change', { bubbles: true }));
  paintObsDialog();
});

// Into the span, never onto the node that holds it.
function sayObs(message) {
  shell.obsStatusText.textContent = message;
}

async function copyObsValue(input) {
  try {
    await navigator.clipboard.writeText(input.value);
    sayObs('copied');
  } catch {
    input.select();
    const copied = document.execCommand('copy');
    sayObs(copied ? 'copied' : 'copy unavailable');
  }
}

shell.obsCopyBrowser.addEventListener('click', () => copyObsValue(shell.obsBrowserUrl));
shell.obsCopyWebcam.addEventListener('click', () => copyObsValue(shell.obsWebcamUrl));
shell.obsOpen.addEventListener('click', () => {
  globalThis.open(shell.obsBrowserUrl.value, '_blank', 'noopener');
  sayObs('source opened');
});

shell.state.addEventListener('click', () => {
  closeApplicationMenus();
  statsVisible = !statsVisible;
  shell.state.setAttribute('aria-checked', String(statsVisible));
  chromeStale = true;
  drawChrome();
});

shell.exportClose.addEventListener('click', () => ui.exportDialog.close());
shell.projectClose.addEventListener('click', () => shell.projectDialog.close());
shell.projectDone.addEventListener('click', () => shell.projectDialog.close());
shell.obsClose.addEventListener('click', () => shell.obsDialog.close());
shell.obsDone.addEventListener('click', () => shell.obsDialog.close());

addEventListener('keydown', (event) => {
  // Asked first, Escape included: a key another control consumed is not this handler's.
  if (event.defaultPrevented) return;
  if (event.key === 'Escape') {
    if (!shell.effectRackPanel.hidden) {
      event.preventDefault();
      closeEffectRack({ restore: true });
      return;
    }
    closeApplicationMenus({ restore: true });
    return;
  }
  // The guard stays below Escape: shutting a menu is right wherever the caret is.
  if (controlKeeps(event.target, event.key) || !(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'o' && EDITING) {
    event.preventDefault();
    location.assign('/projects');
  } else if (key === 'e' && EDITING) {
    event.preventDefault();
    shell.export.click();
  }
});

/**
 * The footage a plan's clips name, opened. Resolved by content hash against the library listing
 * rather than by the id the document wrote, because a rename moves the id and a project records
 * it as a label beside the hash it is actually joined on.
 */
async function sourcesFor(plan) {
  // Which clips need footage fetched, and nothing more than that. A clip naming no take needs
  // none, which is a statement about this walk rather than about the document: whether a document
  // may hold such a clip is `checkProject`'s, and asking it twice is how it came to be asked in
  // neither - the comparison here reads null against null and skips the clip it was refusing.
  const changing = plan.clips
    .map((planned, at) => ({ at, planned }))
    .filter(({ at, planned }) => planned.take !== null
      && (planned.take.hash !== (clips[at]?.source?.index?.hash ?? null)
        || planned.take.id !== (clips[at]?.take?.id ?? null)));
  if (!changing.length) return new Map();
  const listed = await fetch('/library/takes');
  const library = await listed.json().catch(() => null);
  if (!listed.ok || !Array.isArray(library?.takes)) {
    throw new Error(library?.error ?? `the media library could not be read: HTTP ${listed.status}`);
  }
  const { takes } = library;
  const opened = new Map();
  for (const { at, planned } of changing) {
    const match = takes.find((t) => t.hash === planned.take.hash);
    if (!match) {
      throw new Error(
        `clip ${planned.id} was cut on ${planned.take.id} (${planned.take.hash.slice(0, 22)}…) and no `
        + `take on this machine hashes it: ${takes.length} take(s) are here and none of them is that `
        + 'footage, so the edit would render against material it was never authored against',
      );
    }
    const source = await openSource(match.id);
    if (source.take.index.hash !== planned.take.hash) {
      throw new Error(
        `clip ${planned.id} asks for ${planned.take.hash.slice(0, 22)}… but ${match.id} opened as `
        + `${source.take.index.hash.slice(0, 22)}…: the media library changed while the project was opening`,
      );
    }
    opened.set(at, source);
  }
  return opened;
}

/** Loads a project file and opens the footage its clips name. This is the untrusted door. */
async function loadProjectNamed(name, offered = null) {
  if (refuseEdit(`opening ${name}`)) return null;
  const doc = offered === null
    ? await (await fetch(`/projects/${encodeURIComponent(name)}`)).json()
    : { body: offered };
  if (doc.error) throw new Error(doc.error);
  // Accepted whole and synchronously first, and only then is anything fetched: the version gate,
  // the shape checks, the fold refusals and the requires check all run over the document before
  // this page opens a take on its say-so.
  const plan = checkProject(doc.body);
  const sources = await sourcesFor(plan);
  if (refuseEdit(`opening ${name}`)) return null;
  refuseResolvedDurations(plan, sources);
  const gen = takeTransport();
  const resume = timeline ? timeline.playing : false;
  if (resume) timeline.pause();
  applyProject(plan, sources);
  if (suppressedEffects.size) {
    suppressedEffects.clear();
    paintMissingEffects();
  }
  // The editor comes up on this project when the page was opened by one rather than by a take.
  const first = !takeOpened;
  if (first) await enterEditor();
  // Footage that changed under an editor already up takes its label, its window and its marks
  // with it: the ruler's ticks belong to the take rather than to the project drawn over it.
  else if (sources.size) await paintOpenTake();
  if (first) await listLibrary();
  // Started from the document, always. The stack holds whole documents and the synchronous door
  // will only take one whose footage is already open, which a live session guarantees and a load
  // cannot: it opens what the body names while a stack reaches below it.
  history.begin();
  // A loaded project gets a default deliverable unless one is selected, so export has a target.
  ensureActiveDeliverable();
  applyDeliverable(activeDeliverable);
  await timeline.seek(timeline.programSec);
  if (resume && gen === transportGen) timeline.play();
  // A document does not record which clip was being worked on - two people's saves of one edit
  // would differ over nothing - so loading one selects none, and the panel's clip half greys
  // until somebody says which clip they mean. That is the case the split is worth showing in:
  // a project is where there is a choice to make.
  deselectClipRow();
  // What every change from here writes into. A body handed straight in has no revision behind it
  // and is a tool's document rather than a file, so it opens read-only and writes nothing.
  openedProjectName = offered === null ? name : null;
  openedProjectRev = doc.rev ?? null;
  lastSavedAt = null;
  paintProjectCommands();
  if (first) await finishEditor();
  return doc;
}

// Record, mark and remaining time. On the live viewer and nowhere else.
let recordState = { armed: false, recording: false, takeId: null, startedAt: null };

function paintRecord(storage) {
  if (!ui.recGo) return;
  const rec = recordState.recording;
  // A server that cannot record says so on the button rather than failing when pressed.
  const blocked = recordState.cannotRecord ?? null;
  ui.recGo.disabled = Boolean(blocked);
  ui.recGo.title = blocked ?? '';
  ui.recGo.textContent = rec ? 'stop' : 'record';
  ui.recGo.setAttribute('aria-pressed', String(rec));
  ui.recMark.disabled = !rec;
  shell.dockRec.disabled = ui.recGo.disabled;
  shell.dockRec.title = ui.recGo.title;
  shell.dockRec.textContent = ui.recGo.textContent;
  shell.dockRec.setAttribute('aria-pressed', String(rec));
  shell.dockMark.disabled = ui.recMark.disabled;
  const costly = recordState.monitors?.costingTheTake ?? [];
  const monitorWarning = !rec && costly.length
    ? `${costly.length} consumer${costly.length > 1 ? 's are' : ' is'} reading over the network `
      + `(${costly.map((c) => `${c.kind} at ${c.at}`).join(', ')}) - a take will refuse to start until `
      + `monitors are at ÷${recordState.monitors.cap.divisor} ×${recordState.monitors.cap.stride} `
      + 'or coarser and the webcam is detached'
    : null;
  ui.recNote.textContent = blocked ?? monitorWarning ?? (rec
    ? `${recordState.takeId} · ${recordState.frames} frames`
      + (recordState.dropped ? ` · ${recordState.dropped} dropped to a slow disk` : '')
    : (recordState.armed ? 'armed, waiting for the sensor' : 'not recording'));
  if (storage) {
    // A directory that is not there is a different problem from one that is full.
    ui.recSpace.textContent = storage.error ?? `${storage.label} left at current settings`;
    // Load-bearing rather than polish: with manual-only deletion the card genuinely fills.
    ui.recSpace.classList.toggle('low', Boolean(storage.error) || storage.secondsLeft < 15 * 60);
  }
}

// This page's tick of the shared poll, so the record button can ask again at once.
let askRecordState = async () => {};

if (ui.recGo) {
  ui.recGo.addEventListener('click', async () => {
    ui.recGo.disabled = true;
    try {
      // A route that changes something refuses a request that does not declare JSON.
      const res = await fetch(recordState.recording || recordState.armed ? '/record/stop' : '/record/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const body = await res.json();
      if (body.error) ui.recNote.textContent = body.error;
    } finally {
      ui.recGo.disabled = false;
      await askRecordState();
    }
  });
  ui.recMark.addEventListener('click', async () => {
    const body = await (await fetch('/record/mark', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    })).json();
    ui.recNote.textContent = body.error ?? `${body.label} at ${(body.sourceMs / 1000).toFixed(1)}s`;
  });
}

// Everything below the shooting controls, revealed rather than removed.
function toggleCameraView() {
  const program = viewCamera === freeCamera;
  setViewCamera(program ? programCamera : freeCamera);
  ui.camView.setAttribute('aria-pressed', String(program));
  ui.tCamView?.setAttribute('aria-pressed', String(program));
  requestRepaint();
}
ui.camView.addEventListener('click', toggleCameraView);
ui.tCamView?.addEventListener('click', toggleCameraView);

function toggleLoop() {
  timeline.looping = !timeline.looping;
  ui.tLoop?.setAttribute('aria-pressed', String(timeline.looping));
}
ui.tLoop?.addEventListener('click', toggleLoop);


let takeOpened = false;

/**
 * One take's frames and the intrinsics it was shot with, read and held to this build's capture
 * format. Nothing on the page moves, so a refusal here leaves the editor on the clip it had.
 */
// Every take a clip is currently cut on, keyed by the id its frames are fetched under. Two clips
// of one take share the entry, which is what makes one fetch cache rather than two - and what
// stops the same JPEG being decoded twice for one frame.
const openTakes = new Map();
const openingTakes = new Map();

/**
 * Drops the decoded frames of every take no clip is pointed at any more.
 *
 * The frames go and the entry stays: a decoded frame is 1.3 MB and an index is a few thousand
 * numbers, and keeping the entry is what lets `restoreProject` put a clip back on footage this
 * page already holds - which is what the undo of a delete is.
 */
function releaseUnusedFrames() {
  const held = new Set(clips.map((clip) => clip.source.take ?? null));
  for (const take of openTakes.values()) {
    if (held.has(take)) continue;
    take.generation++;
    for (const frame of take.cache.values()) frame.bitmap?.close();
    take.cache.clear();
    take.demand = 0;
  }
}

/** Footage this page already holds open, by content hash. Opening one that is not here is a fetch. */
function takeOpenedAs(hash) {
  for (const [id, take] of openTakes) {
    if (take.index.hash === hash && take.hello) return { id, take, hello: take.hello };
  }
  return null;
}

async function openSourceNow(id) {
  const take = openTakes.get(id) ?? await IndexedTake.open(id);
  const res = await fetch(`/capture/${encodeURIComponent(id)}/hello`);
  if (!res.ok) {
    throw new Error(
      `take ${id} carries no sensor hello (${res.status}): its intrinsics are unknown, and `
      + 'unprojecting it on the boot defaults would put every point out by tens of millimetres '
      + 'with nothing on screen to show it',
    );
  }
  const hello = await res.json();
  // Which generation wrote this, before anything is done with the take it describes.
  const wrongFormat = captureFormatRefusal(`take ${id}`, hello.format ?? null);
  if (wrongFormat) throw new Error(wrongFormat);
  // Positive rather than finite, and inside the frame rather than merely a number.
  const usable = hello.fx > 0 && hello.fy > 0
    && hello.cx > 0 && hello.cx < DEPTH_W
    && hello.cy > 0 && hello.cy < DEPTH_H;
  if (!usable) {
    throw new Error(
      `take ${id} has an unusable hello: ${JSON.stringify(hello)} - focal lengths must be `
      + `positive and the centre must lie inside the ${DEPTH_W}x${DEPTH_H} depth frame`,
    );
  }
  // Both writes after both refusals: `takeOpenedAs` reads a take with a hello as one this page
  // holds open, so a take cached under a hello that was rejected is one the synchronous restore
  // adopts on the strength of a door that refused it.
  take.hello = hello;
  openTakes.set(id, take);
  return { id, take, hello };
}

async function openSource(id) {
  const held = openTakes.get(id);
  if (held?.hello) return { id, take: held, hello: held.hello };
  if (openingTakes.has(id)) return openingTakes.get(id);
  const opening = openSourceNow(id);
  openingTakes.set(id, opening);
  try {
    return await opening;
  } finally {
    if (openingTakes.get(id) === opening) openingTakes.delete(id);
  }
}

/**
 * Points one clip at opened footage: its frames, the take it is joined on and the intrinsics it
 * was shot with. The intrinsics go to `uniforms`, which is the selected clip's own table, so
 * this is the selected clip's until there is a second one to select.
 */
function adoptSource(clip, opened) {
  // A walk of its own over a take that may be shared: where a clip is in the footage is the
  // clip's, and the footage itself is the take's.
  clip.source = new IndexedPairSource(opened.take);
  clip.take = { id: opened.id, hash: opened.take.index.hash };
  // Into this clip's table and not the selected one's: intrinsics belong to the take, so two
  // clips on different footage unproject through different numbers.
  const was = selectedClip ? selectedClip.cloud : null;
  selectCloud(clip.cloud);
  resetColorSource();
  uniforms.focal.value.set(opened.hello.fx, opened.hello.fy);
  uniforms.center.value.set(opened.hello.cx, opened.hello.cy);
  if (was) selectCloud(was);
}

/**
 * The editor brought up onto whatever the clips are now pointed at: the transport, the chrome,
 * the take's marks and the library's three lists. Runs once, from whichever of the two entry
 * points opened the page, and answers with what the lists held.
 */
/** What the page says about the footage the selected clip is on: its label, its window, its marks. */
function paintSelectedTake(clip) {
  sensorLabel = `take ${clip.take.id} · ${clip.source.count} frames · ${clip.source.duration.toFixed(2)}s`;
  setStatus();
  const hello = clip.source.take?.hello ?? null;
  paintPreviewRange(hello?.minDepth, hello?.maxDepth);
}

async function paintOpenTake() {
  const clip = selectedClip;
  paintSelectedTake(clip);
  // A new take gets the whole clip. The window is deliberately not saved anywhere.
  view.fit();
  // Awaited, so the first paint of the ruler already has the ticks on it.
  await loadMarks(clip.take.id);
}

async function enterEditor() {
  detachStream();
  // Painted rather than chosen: which clip is selected is decided at the door the editor was
  // opened through - opening a take selects its clip, loading a project selects none - and this
  // runs for both, so all it does here is show whichever answer that door gave.
  paintPanelScope();
  paintGizmo();
  timeline = new TimelineTransport();
  // A fresh transport is not looping, and the button is the only thing that says so.
  ui.tLoop?.setAttribute('aria-pressed', String(timeline.looping));
  await paintOpenTake();
  document.body.classList.add('editing');
  ui.root.hidden = false;
  showInspector();
  chromeOn = true;
  placeChrome();
  paintProjectCommands();
}

/** The library's two lists, fetched softly but never silently. */
async function listLibrary() {
  const unavailable = [];
  const listed = {};
  for (const [what, refresh] of [['presets', refreshPresets],
    ['deliverables', refreshDeliverables]]) {
    listed[what] = await refresh().catch((err) => { unavailable.push(`${what} (${err.message})`); return null; });
  }
  if (unavailable.length) say(`library unavailable: ${unavailable.join('; ')}`);
  return listed;
}

/** The last of the bring-up, once the entry point has settled what the document is. */
async function finishEditor() {
  // The take's first accurate frame. A repaint, because the playhead may have moved by now.
  await timeline.repaintHere();
  // With the playhead parked `tick` returns at once, so this is what continues a drag.
  if (!PREVIEW_RENDERER) renderer.setAnimationLoop(() => { previews?.tick(); timeline.tick(); pumpParkedDraft(); });
  takeOpened = true;
  if (!PREVIEW_RENDERER && !previews) setupPreviews();
}

/** `/edit?take=` : a new project holding one clip of this take. */
async function openTake(id) {
  const opened = await openSource(id);
  adoptSource(selectedClip, opened);
  openedProjectName = null;
  openedProjectRev = null;
  // This door opens one clip, so select it before the awaited mark load paints the ruler.
  // Otherwise the marks exist before a clip owns gestures and the second load races the paint.
  selectClipRow(selectedClip);
  await enterEditor();
  // Before the lists, because everything after this reads a clip the fit has finished writing.
  await fitCropToTake(id, params.get('near'), params.get('far'))
    .catch((err) => { say(`the crop box could not be fitted to this take: ${err.message}`); });
  await listLibrary();
  ensureActiveDeliverable();
  applyDeliverable(activeDeliverable);
  // The stack starts from whatever the clip already is, so the first undo has
  // somewhere to land.
  history.begin();
  await finishEditor();
  return timeline;
}

// A run of capture frames pinned from a file, with no socket and no wall clock.
class PinnedPairSource extends StampedPairSource {
  constructor(buffer) {
    const view = new DataView(buffer);
    const frames = [];
    for (let off = 0; off + 16 <= buffer.byteLength;) {
      const depthBytes = view.getUint32(off, true);
      const colorBytes = view.getUint32(off + 4, true);
      frames.push({
        depth: new Uint16Array(buffer, off + 16, depthBytes / 2),
        stampMs: Number(view.getBigUint64(off + 8, true)),
      });
      off += 16 + depthBytes + colorBytes;
    }
    const first = frames[0].stampMs;
    super(frames.map((f) => (f.stampMs - first) / 1000));
    this.frames = frames;
  }

  makeCurrent(k) {
    bindDepth(this.frames[k].depth);
  }
}

let pinnedPairs = null;

/** Compile every program the look can reach, before the first frame anybody sees. */
function warmPrograms() {
  const was = {
    after: afterimage.enabled, mosh: mosh.enabled, bloom: bloom.enabled, grade: grade.enabled,
  };
  const wasAdditive = uniforms.softEdge.value === 1;
  // A shader that will not compile is not an exception anywhere, which is why this hook exists.
  const linkFailures = [];
  const priorHook = renderer.debug.onShaderError;
  renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) => {
    const log = gl.getProgramInfoLog(program)?.trim() ?? '';
    const stage = gl.getShaderInfoLog(vertexShader)?.trim()
      ? `vertex: ${gl.getShaderInfoLog(vertexShader).trim()}`
      : `fragment: ${gl.getShaderInfoLog(fragmentShader)?.trim() ?? ''}`;
    linkFailures.push(`${log || 'the program did not link'} (${stage})`);
  };
  try {
    afterimage.enabled = true;
    mosh.enabled = true;
    bloom.enabled = true;
    grade.enabled = true;
    // Both blending states: `setAdditive` flips `material.needsUpdate` and blend
    // is its own object.
    setAdditive(!wasAdditive);
    composer.render(0);
    setAdditive(wasAdditive);
    composer.render(0);
  } catch (err) {
    console.warn('could not warm the shader programs:', err.message);
  } finally {
    renderer.debug.onShaderError = priorHook;
    afterimage.enabled = was.after;
    mosh.enabled = was.mosh;
    bloom.enabled = was.bloom;
    grade.enabled = was.grade;
    resetAccumulators();
  }
  if (linkFailures.length) {
    throw shaderLinkFailure(
      `this build's shaders did not compile after the effects changed - ${linkFailures[0]}`,
      linkFailures[0],
    );
  }
}
warmPrograms();

// Which transport owns the loop is decided once, here, and the three doors are exclusive.
const EDIT_QUERY = new URLSearchParams(location.search);
const REQUESTED_TAKE = EDIT_QUERY.get('take');
const REQUESTED_PROJECT = EDIT_QUERY.get('project');
// Comma-joined, and a take id cannot carry a comma by its own rule, so the list is unambiguous.
const REQUESTED_NEW = EDIT_QUERY.get('new');

/**
 * The editor's three doors, and what each one leaves the page holding.
 *
 * `?project=` opens an existing document. `?new=` mints one from the takes it names, in the
 * order it names them, and lands in it. `?take=` is the render worker's bootstrap: the page comes
 * up on one clip of that take, holds no document, and writes nothing at all. Asked in that order
 * because only one of them is ever set, and a URL carrying two is answered rather than refused.
 */
const editorDoor = () => {
  if (REQUESTED_PROJECT) return { what: `project ${REQUESTED_PROJECT}`, open: () => loadProjectNamed(REQUESTED_PROJECT) };
  if (REQUESTED_NEW) return { what: `a project on ${REQUESTED_NEW}`, open: () => mintProjectFrom(REQUESTED_NEW.split(',')) };
  return { what: `take ${REQUESTED_TAKE}`, open: () => openTake(REQUESTED_TAKE) };
};

if (EDITING && !REQUESTED_TAKE && !REQUESTED_PROJECT && !REQUESTED_NEW) {
  // The editor has no entry that comes up on no footage, and a project is the human route in.
  location.replace('/projects');
} else if (EDITING) {
  const door = editorDoor();
  door.open()
    .catch((err) => {
      previewBootError = err.message;
      sensorLabel = `cannot open ${door.what}`;
      setStatus();
      showTimelineError(new Error(`${door.what}: ${err.message}`));
    });
} else if (PROGRAM_OUT) {
  // A live socket like the viewer, and no animation loop, because `handleFrame` draws.
  document.body.classList.add('program-out');
  controls.enabled = false;
  chromeOn = false;
  // `resize()` ran before this branch added program-out, so the canvas sat below no appbar.
  renderer.domElement.style.top = '0px';
  renderer.domElement.style.left = '0px';
  outputSize = { ...programOutSize };
  resize();
  setViewCamera(programCamera);

  programOutReadout = document.createElement('div');
  programOutReadout.id = 'programOutReadout';
  programOutReadout.textContent = 'PROGRAM OUT  idle';
  document.body.appendChild(programOutReadout);

  connect();
  // Nothing renders until a frame lands, so OBS would otherwise capture an empty buffer.
  renderProgramFrame(0);
} else {
  // Opened here, because `handleFrame` pushes into the pair source above.
  connect();
  renderer.setAnimationLoop(liveLoop);
  chromeOn = true;
  placeChrome();
  refreshPresets().catch((err) => {
    console.error('preset library unavailable:', err.message);
  });
  paintPreviewRange(NaN, NaN);
  // The remaining-time readout, on the surface an operator watches. Polled, not pushed.
  askRecordState = pollRecordState((state) => {
    recordState = state;
    paintRecord(state.storage);
    chromeStale = true;
    drawChrome();
  });
}

// Handles for profiling and for poking at the scene from the console.
globalThis.__kinect = {
  previews: {
    state: () => previews?.inspect() ?? null,
    render: () => previews?.renderRange(),
    clear: () => previews?.clear(),
  },
  previewRenderer: PREVIEW_RENDERER ? {
    ready: () => takeOpened,
    error: () => previewBootError,
    prepare: preparePreview,
    frame: renderPreviewFrame,
  } : null,
  renderer, composer, scene, freeCamera, programCamera,
  bloom, afterimage, mosh, grade, resetAccumulators, renderProgramFrame,

  // Getters and not the values: these three are views of the selected cloud, so shorthand
  // would freeze this handle on whichever instance happened to be selected at boot and
  // answer for that one after every later select - an instrument reading the wrong clip
  // and saying nothing.
  get uniforms() { return uniforms; },
  get material() { return material; },
  get geometry() { return geometry; },

  // A getter and not the object: the object is replaced when navigation's up changes.
  get controls() { return controls; },

  worldTilt: () => level.quaternion.toArray(),
  resetWorldRotation,

  /** The installed effects, and the rebuild an install triggers. */
  effects: {
    reload: requestEffectReload,
    pollNow: pollEffects,
    packages: () => effectPackages.map((p) => ({ id: p.id, version: p.manifest.version, rev: p.rev })),
    signature: () => effectSignature,
    programs: () => JSON.parse(JSON.stringify(shaderPrograms)),
  },

  // The live cloud's draw-rate cap, in hertz, readable and settable so the rate can be swept.
  get cloudDrawHz() { return cloudDrawHz; },
  set cloudDrawHz(hz) { cloudDrawHz = Number(hz); },

  /** What the GPU spent on recent frames, plus how the reading came about. */
  gpu: () => ({
    supported: gpuTimer.supported(renderer.getContext()),
    timing: statsVisible,
    samples: gpuTimer.samples.length,
    ms: gpuTimer.median(),
  }),

  sensorView,
  surface: () => (EDITING ? 'edit' : 'record'),

  // What the crop planes must clear, from the intrinsics the page unprojects with.
  cropReach,

  cropBoxCorners: () => cropBoxCorners().map((v) => v.toArray()),
  cropHandles: (plan = false) => cropHandles(plan, insetRect())
    .map(({ param, at, sx, sy }) => ({ param, x: at.x, y: at.y, sx, sy })),
  cropBoxShown: () => cropBoxLive(),
  applyProgramOut,
  undoDepth: () => history.depth,
  // `history.begin()` is the last thing `openTake` does that a document can observe.
  takeOpened: () => history.baseline !== null,
  cropOutside: () => uniforms.cropOutside.value,

  // The sizes the export menu offers, and the way to adopt one.
  exportSizes: () => EXPORT_SIZES.flatMap((g) => g.sizes.map(([w, h]) => ({ ratio: g.ratio, w, h }))),
  setOutputSize: (text) => setProjectAspect(aspectOfSize(text), { fromDocument: true })
    && setDeliverableSize(text),
  outputSize: () => ({
    aspect: [...projectAspect],
    size: activeDeliverable?.outputSize ?? null,
  }),

  params, applyPreset,
  readings: () => READINGS.slice(),

  presetValueNames,
  coreLookNames,
  wholeLookNames,
  effectOf,
  effectIds,
  effectParamNames,

  groupRefreshes: () => groupRefreshes,

  keyframes: {
    /** A handle as a tool hands one over, refused rather than repaired. */
    handleFrom(points, side, name) {
      const list = points ?? EASE_OUT_LINEAR;
      const ok = Array.isArray(list) && list.length >= 1
        && list.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
      if (!ok) {
        throw new Error(`${name}'s ${side} is ${JSON.stringify(points)}: since version 5 a handle is a `
          + 'list of control points, so a bare pair means a fixture written against version 4');
      }
      return copyHandle(list);
    },
    /** Writes a whole set of tracks at once. The keys are the tool's, not the page's. */
    setTracks(spec) {
      tracks.clear();
      for (const [name, keys] of Object.entries(spec)) {
        if (keys.length === 0) continue;
        const track = trackFor(name);
        track.keys = keys.map((k) => ({
          t: k.t,
          value: k.value,
          easeOut: this.handleFrom(k.easeOut ?? EASE_OUT_LINEAR, 'easeOut', name),
          easeIn: this.handleFrom(k.easeIn ?? EASE_IN_LINEAR, 'easeIn', name),
        }));
        track.sort();
      }
      lanesChanged();
    },
    setSpeed(speed) {
      if (refuseEdit('a speed change')) return;
      selectedClip.speed = speed;
      timingChanged();
    },
    setSourceStart(sec) {
      if (refuseEdit('an in-point change')) return;
      selectedClip.sourceStart = sec;
      timingChanged();
    },
    /**
     * What a track says at a position on its own clock, without rendering anything. Named by
     * lane owner, so a clip's track is asked of that clip rather than of the selection.
     */
    valueAt(owner, t) { return trackOf(owner)?.valueAt(t) ?? null; },
    names() { return [...tracks.keys()]; },
    toggle: toggleKey,
    lanes: () => laneRows().map((r) => ({ owner: r.owner, kind: r.kind, keys: keysOf(r.owner).length })),
    project: serialiseProjectBody,
    undo: {
      depth: () => history.depth,
      commit: () => history.commit(),
      pop: () => history.undo(),
      begin: () => history.begin(),
    },
    /** The furniture, so a check can prove it is out of the frame and not merely small. */
    chrome: {
      on: () => chromeOn,
      topView: () => topViewVisible,
      set(on) { chromeOn = on; placeChrome(); },
      inset: insetRect,
    },
    camera: {
      keys: () => cameraKeys().map((k) => ({ t: k.t, value: k.value })),
      /** Where a path node lands on screen, which is what a drag has to hit. */
      project(i, plan) { return nodeScreenPoint(cameraKeys()[i].value.position, plan); },
    },
  },
  /** The interaction layer's own state, for a check that drives controls and reads back. */
  editor: {
    /** Which clip row the strip has selected, or null. Session state, never in the document. */
    clipSelection: () => selectedClipRow()?.id ?? null,
    /** Where a mark ticks in program seconds, through the selected clip's placement, speed and in-point. */
    markProgramSec: (sourceSec) => programSecOfSource(sourceSec),
    clipRange: () => ({ in: clipIn, out: clipOut }),
    setClipRange: (inVal, outVal) => {
      // Guarded like the gesture it stands in for: a handle that can do what the control it
      // represents is refused would prove the guard against a door nobody can open.
      if (refuseEdit('setting the trim')) return;
      setClipInOut({ in: inVal, out: outVal });
      history.commit();
    },
    // The speed slider's travel is logarithmic, so its `value` is a position and not a rate.
    rateSlider: { toValue: sliderFromRate, toRate: rateFromSlider },
    /** The strip's height and what bounds it, so a check can drive the splitter. */
    strip: () => ({
      lanes: parseFloat(getComputedStyle(ui.root).getPropertyValue('--tlanes-h')) || 0,
      stacked: laneStackHeight,
      ceiling: laneHeightCeiling(),
      height: ui.root.getBoundingClientRect().height,
      scrollTop: ui.lanes.scrollTop,
      railScrollTop: ui.railLanes.scrollTop,
      scrollable: ui.lanes.scrollHeight > ui.lanes.clientHeight + 1,
    }),
    stageResizes: () => stageResizes,
    /** The window the strip is drawn against, and the mapping both ways through it. */
    view: {
      window: () => ({
        a: view.a, b: view.b, startSec: view.startSec, endSec: view.endSec,
        spanSec: view.spanSec, duration: view.duration, whole: view.whole,
      }),
      pct: (t) => view.pct(t),
      secAtPct: (p) => view.secAtPct(p),
      set(a, b) { if (view.set(a, b)) viewChanged(); return { a: view.a, b: view.b }; },
      fit() { if (view.fit()) viewChanged(); },
    },
    // The take's marks as the strip draws them, planted without writing a sidecar.
    setMarks(list) {
      takeMarks = list.map((m) => ({ ...m }));
      paintMarks();
      paintMarkButton();
    },
    selection: () => (selection ? { owner: selection.owner, t: selection.key.t } : null),
    /** The clip the strip has selected, and the gesture that takes it off every one of them. */
    selectClipRow: (id) => {
      const clip = clips.find((c) => c.id === id);
      if (!clip) throw new Error(`no clip called ${JSON.stringify(id)}: have ${clips.map((c) => c.id).join(', ')}`);
      selectClipRow(clip);
      return clip.id;
    },
    deselectClipRow,
    /** The clip gizmo as the page holds it: what it is on, what it does, whether it is drawn. */
    gizmo: () => ({
      mode: gizmoMode,
      clip: gizmoClip?.id ?? null,
      shown: gizmoHelper?.visible ?? false,
      enabled: gizmo?.enabled ?? false,
      position: gizmoClip ? gizmoClip.transform.position.toArray() : null,
    }),
    setGizmoMode: (mode) => { gizmoMode = mode; paintGizmo(); return gizmoMode; },
    /** One pointer move's worth of gizmo output: the group moved, then the event three fires. */
    moveGizmo(position, quaternion = null) {
      if (!gizmoClip) throw new Error('the gizmo is on no clip, so there is no drag to make');
      gizmoClip.transform.position.fromArray(position);
      if (quaternion) gizmoClip.transform.quaternion.fromArray(quaternion);
      gizmo.dispatchEvent({ type: 'objectChange' });
    },
    /** The two ends of a drag, which is where the orbit stands down and comes back. */
    gizmoDrag(value) { gizmo.dispatchEvent({ type: 'dragging-changed', value }); },
    orbitEnabled: () => controls.enabled,
    foldClipLanes: (id) => {
      const clip = clips.find((c) => c.id === id);
      if (!clip) throw new Error(`no clip called ${JSON.stringify(id)}: have ${clips.map((c) => c.id).join(', ')}`);
      toggleClipLanes(clip);
      return clipLanesOpen(clip);
    },
    /** Which panel rows the clip half is greying, as the page actually drew them. */
    scopeOff: () => [...document.querySelectorAll('[data-scope-off="yes"]')].length,
    select(owner, index) {
      const keys = keysOf(owner);
      selection = keys[index] ? { owner, key: keys[index] } : null;
      lanesChanged();
      return Boolean(selection);
    },
    easeOf: (owner, i) => {
      const k = keysOf(owner)[i];
      return k ? { easeOut: copyHandle(k.easeOut), easeIn: copyHandle(k.easeIn) } : null;
    },
    easePresets: () => Object.keys(EASE_PRESETS),
    easedKinds: () => Object.keys(KINDS).filter((k) => KINDS[k].eases),
    pathBeads: () => beadPoints(pathPoints()),
    shortcuts: () => SHORTCUTS,
    exportName: () => ({ base: exportBaseName(), valid: EXPORT_NAME_OK.source, canSaveAs: CAN_SAVE_AS }),
    lastExport: () => (lastExport ? { ...lastExport } : null),
  },

  setViewCamera,
  viewCamera: () => viewCamera,

  // The timeline, and the counters read instead of taking the transport's word for it.
  timeline: {
    open: openTake,
    transport: () => timeline,
    counters,
    /** Resolves once every scheduled repaint has run and the transport's queue has drained. */
    async settled() {
      for (let i = 0; i < 200; i++) {
        // A macrotask, so a repaint on the microtask queue has been enqueued by the
        // time this returns.
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        await timeline?.idle();
        if (!repaintWanted && !repaintBusy && !repaintScheduled && !timeline?.working
          && draftWanted === null && !draftBusy && !orbitRedrawWanted && !orbitSettling) return;
      }
      throw new Error('the transport never settled');
    },
    /** What the composite is made of, as a snapshot per clip in project order. */
    clips: () => {
      // Which open take each clip's walk is over, as a slot rather than an object: two clips
      // reading one take is an identity, and an id would be equal whether they shared it or not.
      const slots = [...new Set(clips.map((clip) => clip.source.take ?? clip.source))];
      return clips.map((clip) => ({
        id: clip.id,
        takeSlot: slots.indexOf(clip.source.take ?? clip.source),
        take: clip.take ? { ...clip.take } : null,
        start: clip.start,
        trim: clip.trim,
        afforded: clip.afforded,
        length: clip.length,
        end: clip.end,
        speed: clip.speed,
        sourceStart: clip.sourceStart,
        showing: clip.showing,
        visible: clip.transform.visible,
        // Where this clip sits in the room, read off the group rather than off the registry:
        // the value and what it landed on are the two ends the placement rows compare.
        placement: {
          position: clip.transform.position.toArray(),
          quaternion: clip.transform.quaternion.toArray(),
        },
        // The levelling rotation this clip actually draws through, for every clip rather than
        // for the selected one. `__kinect.worldTilt` answers for the selection alone, so a leak
        // from one clip's angles into another's group is invisible to it.
        level: clip.cloud.points.level.quaternion.toArray(),
        renderOrder: clip.points.renderOrder,
        additive: !clip.points.material.depthWrite,
        warmFrames: clip.warmFrames(outputFps(), warmCeiling()),
        applied: clip.source.applied,
        cached: clip.source.cache?.size ?? 0,
        // What this clip's take is being asked for and what its cache holds against that, which
        // is the pair that says a cache is sized by demand rather than by a constant.
        demand: clip.source.take?.demand ?? null,
        capacity: clip.source.take?.capacity ?? null,
        selected: clip === selectedClip,
      }));
    },
    /** How many takes are open, which is what says two clips of one take share its cache. */
    takes: () => openTakes.size,
    /** Each open take's cache state, including entries retained for undo. */
    takeCaches: () => [...openTakes].map(([id, take]) => ({
      id, demand: take.demand, capacity: take.capacity, cached: take.cache.size,
    })),
    /** What a take's cache is sized against: the budget, what it buys, and the floor under it. */
    cache: () => ({
      floor: CACHE_FRAMES,
      headroom: CACHE_HEADROOM,
      frameBytes: FRAME_BYTES,
      budgetBytes: CACHE_BUDGET_BYTES,
      ceiling: CACHE_CEILING_FRAMES,
      span: MAX_SPAN_FRAMES,
    }),
    /** What each clip is doing at a program position, without rendering anything. */
    showingAt: (t) => clips.map((clip) => ({ id: clip.id, showing: clipShowingAt(clip, t) })),
    /** Points the panel and the lanes at one clip by id. */
    select(id) {
      const clip = clips.find((c) => c.id === id);
      if (!clip) throw new Error(`no clip called ${JSON.stringify(id)}: have ${clips.map((c) => c.id).join(', ')}`);
      selectClip(clip);
      return clip.id;
    },

    /** A snapshot, so a reader cannot accidentally hold a live object. */
    read() {
      if (!timeline) return null;
      const t = timeline;
      return {
        frame: t.frame,
        programSec: t.programSec,
        // Through the clip's placement as well as its speed: a program second fed straight into
        // the clip-local map answers for the wrong footage on any clip that starts after zero.
        sourceSec: sourceSecOfProgram(t.programSec),
        outputFps: t.outputFps,
        speed: selectedClip.speed,
        sourceStart: selectedClip.sourceStart,
        duration: t.duration,
        lastFrame: t.lastFrame,
        playing: t.playing,
        drafted: t.drafted,
        settling: orbitSettling,
        lastSeek: t.lastSeek,
        lastCostMs: t.lastCostMs,
        overtaken: t.overtaken,
        behindMs: t.behindMs,
        preroll: t.preroll(),
        applied: t.clip.source.applied,
        cached: t.clip.source.cache.size,
        demand: t.clip.source.take?.demand ?? null,
        capacity: t.clip.source.take?.capacity ?? null,
        mixT: uniforms.mixT.value,
        sinceFrameSec: uniforms.sinceFrameSec.value,
        hasColor: uniforms.hasColor.value,
      };
    },
  },

  library: {
    PROJECT_VERSION,
    CLIP_CEILING,
    restoreProject,
    serialiseProjectBody,
    loadProject: loadProjectNamed,
    applyStoredPreset,
    presetFromCurrentLook,
    refreshPresets,
    setActiveDeliverable,
    applyDeliverable,
    activeDeliverable: () => activeDeliverable,
    appliedPreset,
    presetGestureRunning: () => presetGesture,
    missingEffects,
    effectVersionSkew: () => effectVersionSkew.map((s) => ({ ...s })),
    /** The parked pool itself, so a round-trip row can compare what went in and out. */
    parkedLook: () => JSON.parse(JSON.stringify({
      clips: clips.map((clip) => ({ id: clip.id, ...clip.look.parked })),
      project: projectLook.parked,
      requires: parkedRequires,
    })),
    marks: () => takeMarks.map((m) => ({ ...m })),
    markHere,
    takeId: openTakeId,
    takeHash: openTakeHash,
    opened: () => takeOpened,
    /** Where each mark ticks on the ruler, as the page actually drew it. */
    markTicks: () => [...document.querySelectorAll('#tMarks .tmk')].map((el) => ({
      left: Number.parseFloat(el.style.left),
      beyond: el.classList.contains('beyond'),
    })),
  },

  export: {
    run: exportClip,
    running: () => exporting,
    /** What both bars are drawn from, or null between renders. */
    progress: () => (exportProgress === null ? null : { ...exportProgress }),
    /**
     * Document edits that reached the document while a render was reading it. Zero is the claim:
     * every door is guarded, so this counts the doors that are not, and a check reads it rather
     * than reading whether any particular door refused - a door added next year is counted here
     * without anything being told about it.
     */
    editsDuringExport: () => editsDuringExport,
    rendererClass,
  },

  // Pin the inputs, step the playhead to an exact position, read the pixels back.
  drive: {
    /** Detaches the live loop and feeds a run of capture frame payloads instead. */
    pin(buffer) {
      // Cleared here and not in `pumpParkedDraft`, which a pinned run never reaches.
      draftWanted = null;
      orbitRedrawWanted = false;
      orbitSettling = false;
      renderer.setAnimationLoop(null);
      detachStream();
      pinnedPairs = new PinnedPairSource(buffer);
      selectedClip.source = pinnedPairs;
      // Colour decode is asynchronous, so a pinned run leaves it out rather than racing it.
      uniforms.hasColor.value = 0;
      return pinnedPairs.times.slice();
    },
    /** A colour image the caller supplies, for the one arm that cannot work without one. */
    plantColor,
    /** One decoded colour arrival, for proving the source pair in a real browser. */
    bindColor,
    colorPair: () => {
      const [previous, current] = boundColorImages(selectedClip.cloud.textures);
      const size = (image) => image ? [image.width, image.height] : null;
      return {
        same: previous === current,
        previous: size(previous),
        current: size(current),
        hasColor: uniforms.hasColor.value,
      };
    },
    times() { return pinnedPairs.times.slice(); },
    /** One frame's depth straight into the current texture, bypassing every pair source. */
    injectDepth(depth) { bindDepth(depth); },
    /** Clears only screen-space history, for a proof arm that keeps surface memory. */
    clearAfterimage() { clearAfterimage(); },
    reset() {
      pinnedPairs?.rewind();
      resetAccumulators();
    },
    stepTo(t) { renderProgramFrame(t); },
    /** Must be called in the same task as the render: the buffer is not preserved. */
    readPixels() {
      const gl = renderer.getContext();
      const { drawingBufferWidth: w, drawingBufferHeight: h } = gl;
      const pixels = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels;
    },
    async hashes(times) {
      const out = [];
      for (const t of times) {
        renderProgramFrame(t);
        const pixels = this.readPixels();
        const digest = await crypto.subtle.digest('SHA-256', pixels);
        out.push(Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join(''));
      }
      return out;
    },
  },

  // Reads the surface memory back off the GPU.
  stateStats() {
    const buf = new Float32Array(POINTS * 4);
    renderer.readRenderTargetPixels(statePrev, 0, 0, DEPTH_W, DEPTH_H, buf);
    let ghosts = 0, hard = 0, soft = 0, fresh = 0;
    const life = uniforms.fadeTime.value + uniforms.wakeTime.value;
    for (let i = 0; i < POINTS; i++) {
      const ghost = buf[i * 4], age = buf[i * 4 + 1], strength = buf[i * 4 + 2];
      if (ghost > 0 && age < uniforms.fadeTime.value + uniforms.wakeTime.value * strength) ghosts++;
      if (age < 0.05) {
        fresh++;
        if (strength > 0.5) hard++; else soft++;
      }
    }
    const pct = (n) => +((n / POINTS) * 100).toFixed(2);
    return { ghostsDrawn: pct(ghosts), swappedLast50ms: pct(fresh), hard: pct(hard), soft: pct(soft), life };
  },
};
