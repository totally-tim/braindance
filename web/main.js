import * as THREE from 'three';
import { DEPTH_H, DEPTH_W, POINTS, PROJECT_VERSION, versionRefusal, captureFormatRefusal } from './format.js';
import { pollRecordState } from './record-poll.js';
// The renderer and everything built directly on it. Imported before any other module of
// this page because its body appends the canvas and constructs the cameras, and the
// order modules evaluate in is the order they are imported in - a module that read
// `renderer` while this one was still evaluating would find a binding in its dead zone.
// Nothing here imports back into this file, which is what keeps that order a fact rather
// than a convention.
import {
  renderer, scene, freeCamera, programCamera, viewCamera, controls, worldTilt, WORLD_UP,
  DEFAULT_POSE, onNav, setNavigationUp, useViewCamera,
} from './scene.js';
// The pure ones: the scalar curve maths the tracks are evaluated through, the levelling
// pair's composition, the table of output sizes, the geometry of the top-down inset, the
// window of program time the strip is drawn against, and the trim a deliverable covers.
// Arithmetic and data, with no DOM, no GL and nothing constructed at import time - which
// is what makes these the parts of the editor a test can import and call under bare node,
// and it is why this block can sit anywhere in this list. A module with no top-level side
// effect cannot be reordered into a different program, and the blocks above and below it
// do not have that property.
//
// The last two are the two that hold state, and they hold it in opposite ways for the same
// reason - a boundary that cannot be written across. `view-window.js` exports a factory,
// because a window has to be bound to a transport and a DOM node before it means anything;
// `clip-range.js` exports the pair itself as two live bindings, because everything in this
// file reads them and nothing outside `writeClipRange` may write them, and an import is
// read-only where a comment is a promise.
import {
  EASE_OUT_LINEAR, EASE_IN_LINEAR, SEGMENT_POINT_CEILING, copyHandle, easeAt, elevate, keyBefore,
  HOLD_ENDS, EXTEND_ENDS, scalarAt, segmentSlope, scalarSlopeAt, stepAt, hermite, tangentAt,
} from './curve.js';
import { tiltQuaternion } from './world-tilt.js';
import {
  EXPORT_SIZES, DEFAULT_EXPORT_SIZE, reduceAspect, exportAspects, sizesForAspect,
} from './export-sizes.js';
import {
  INSET, TOP_CENTRE, PLAN_STRIDE, FRUSTUM_LEN, planScale, planPoint, planWorld, projectThrough,
} from './plan-geometry.js';
import { ZOOM_PER_NOTCH, TICK_STEPS, tickLabel, makeViewWindow } from './view-window.js';
import { clipIn, clipOut, clipBoundOrThrow, writeClipRange } from './clip-range.js';
// One number out of the halo, and nothing else. `bloom-pass.js` holds the pass and
// `post-chain.js` is what constructs it; what this file still needs is the reference the
// chain is frozen at, because `resize` sizes that chain and `resize` lives here. The two
// GLSL programs went the same way - `point-cloud.js` imports them from `cloud-shader.js`
// directly, and both modules stay reachable through the ones that use them rather than
// through a name carried here.
//
// **A name imported and not used is worse than no import**, which is why this line is one
// binding rather than the three it was. It reads as a dependency to anyone tracing the
// boot order, and it survives the deletion of the last thing that used it without a word
// from any tool - which is exactly how the three that were here got here, when the
// constructions moved out in the two commits after the modules were made.
import { bloomChainSize } from './bloom-pass.js';
// The two sensor frames the GPU holds, and the memory of where a ray used to be that is
// built from them. Imported after `scene.js` because the second of them asks the live
// context a question - whether it can render to float - and imported in this order
// because the memory's pass samples the depth texture the first of them owns.
//
// Neither builds anything while it evaluates. Each exports a build function that is
// called at its own banner below, so the order these two come up in is written out in
// this file rather than inferred from the order these lines happen to be in - which is
// what stops a sorted import list from quietly becoming a different program.
import {
  depthCurr, colorPrev, colorCurr, buildTextures, bindDepth, bindColor, plantColor,
} from './gpu-textures.js';
import {
  statePrev, stateNext, buildSurfaceMemory, stepSurfaceMemory, refuseAgeCeiling,
} from './surface-memory.js';
// Which passes the drawn frame goes through on its way to the canvas, and in what order.
// Imported after the two blocks above because it is built on all of them - the renderer
// and the scene `scene.js` owns, and the halo `bloom-pass.js` defines - and, like the
// pair above it, it builds nothing while it evaluates. `buildPostChain` is called at its
// banner below, so the moment a composer takes a pair of full-size render targets off the
// GPU is a line in this file rather than a position in this list.
import {
  composer, renderPass, afterimage, bloom, grade, buildPostChain,
} from './post-chain.js';
// What a point is made of and how it is addressed: the geometry, the uniform table both
// shaders are driven through, the material and the cloud itself. Last of the render core
// and imported last, because it is built on every block above it - the scene it joins, the
// shaders it compiles, the source cells it composes and the ghost target it samples. It
// allocates nothing while it evaluates either; `buildPointCloud` is called at its banner
// below, which is what keeps the moment the cloud joins the scene a line in this file.
//
// The uniform table crosses this boundary as an object anybody may write into, which is the
// one channel `tools/module-check.mjs` refuses in general and exempts here by name. A
// uniform is a cell the GPU reads, so a look parameter's `apply` writing `uniforms.X.value`
// is not state leaking across a boundary - it is the only way three.js can be told
// anything, and a setter per term would be the registry below spelled a second time.
import {
  geometry, uniforms, material, cloud, buildPointCloud, setAdditive,
  CLIP_NEAR_DEFAULT, CLIP_FAR_DEFAULT, CROP_LIMIT, cropReach, croppedOut,
} from './point-cloud.js';

// Which of the two surfaces this page is, decided by the path. One document still
// serves both, because there is one renderer and one image pipeline and splitting
// the markup would be the second path this design keeps rejecting - but the two are
// exclusive and the page has to know which it is before it builds any controls.
//
// Read from the path rather than from the presence of `?take=`, which is what it
// used to be. A query parameter cannot distinguish the recorder from an editor that
// has nothing open yet, and it left the recorder carrying every editing control by
// default: the keyframe buttons below are built long before the boot branch runs, so
// the answer has to be available at the top of the module rather than at the bottom.
const EDITING = location.pathname === '/edit';

/**
 * Whether this page is the program-out source rather than a surface anybody is
 * sitting in front of.
 *
 * OBS opens it as a browser source, so it is the same renderer as the viewer and the
 * editor - one file, one scene, one post chain - with three differences: the output
 * size is fixed rather than the window's, there is no chrome and no orbit, and it
 * renders when a frame arrives rather than on the display's clock.
 *
 * **It is a second WebGL context on the same GPU as the operator's, and that is the
 * trade this mode is.** A browser source cannot mirror somebody's pixels; CEF renders
 * its own. What it can do is be told the same camera, which is what mirror mode is,
 * and the cost of the pair is measurable - the rendering-cost table in docs/performance.md puts a
 * full 1080p Blackwall frame at 1.17ms, so two of them at 30fps is a small fraction
 * of the 8.33ms a 120Hz operator has. OBS window capture would give the exact pixels
 * for free and was rejected because it is window-sized and carries whatever chrome
 * the operator has not hidden.
 */
const PROGRAM_OUT = location.pathname === '/program';

// The auto-save's name, in one place because two things need to agree about it: the
// write below and the project picker that has to leave it out.
const WORKING_PROJECT = '__working__';

// What the menu's Editor entry resumes. Client state rather than a document - which
// project was open last is a property of this browser, not of the library, and the
// alternative was a last-opened stamp on the store that every read would have to
// write to. Stored against the take's **hash**: a downloaded take whose name
// collided is stored under a different id, so an id saved here can name different
// footage after a sync, which is the whole reason a project names its take by hash.
const LAST_OPENED = 'kinect.lastOpened';

function rememberOpened() {
  if (!openTakeHash) return;
  try {
    localStorage.setItem(LAST_OPENED, JSON.stringify({
      takeHash: openTakeHash,
      takeId: openTakeId,
      // The picker is where the open project's name already lives, so this reads it
      // rather than keeping a second copy that could disagree with what is on screen.
      project: ui.project?.value || null,
    }));
  } catch {
    // Private browsing, a full quota, storage disabled by policy. Resuming is a
    // convenience and the gallery is one click away, so this is not worth a
    // message on a surface someone is editing on.
  }
}

const statusEl = document.getElementById('status');
const appStatusEl = document.getElementById('appStatus');
// Read here rather than beside the rest of the timeline, because `resize` runs at
// boot and has to know how much of the window the strip is taking. Hidden it
// measures zero, which is what keeps the live viewer's viewport exactly what it
// was.
const timelineEl = document.getElementById('timeline');

// ---------------------------------------------------------------- scene setup
//
// Moved to `scene.js`. The renderer, the scene, the two cameras, the world tilt and
// the orbit controls are built there and imported here.

// ---------------------------------------------------------------- gpu textures
//
// Moved to `gpu-textures.js`. The two depth textures, the two colour textures and the
// one door a new sensor frame replaces them through are built there. What is here is
// the moment they are built, which is a decision about this program's boot rather than
// about the textures - and the five uniform cells handed back, which the point cloud's
// material composes by reference when it is built at the banner below.
const sourceCells = buildTextures();

// ------------------------------------------------------------- surface memory
//
// Moved to `surface-memory.js`. The ping-pong pair the ghost accumulates in, the pass
// that ages it and the ceiling its age is clamped at are there. Built here, after the
// textures above, because the pass samples the depth frame they own.
buildSurfaceMemory();

// ---------------------------------------------------------------- point cloud
//
// Moved to `point-cloud.js`. Two vertices per depth pixel, the uniform table both shaders
// are driven through, the material and the cloud are there. What is here is the moment
// they are built and the moment the cloud joins the scene, which are decisions about this
// program's boot rather than about the cloud - and the cells from the textures above,
// handed over rather than reached for, so the one place the two are wired together is this
// line.
buildPointCloud(sourceCells);

// ------------------------------------------------------------ levelling the world

// A sensor is a thing somebody bolted to something, and nothing measures the angle it
// ended up at, so a human has to say which way is up. What the two angles they give
// *mean* is in `world-tilt.js` - the pair, the order it composes in because the pair
// does not commute, and why there are two of them and not three. What is here is where
// that rotation lands, which is the half that needs a scene.
//
// That angle is a fact about the take rather than about whoever is looking at it, so
// it lives in the document beside the crop and not on the camera - which is also what
// makes it one fix rather than four. Rotating the cloud levels the turntable, the
// top-down, auto-orbit's axis and the exported frame at once, where a camera that
// merely rolled itself would leave the other three canted and give keyed poses a roll
// to interpolate against defaults that have none.
//
// What deliberately does *not* move with it: the crop faces and the region are tested
// on the undisplaced sensor-space position in the vertex shader, before the model
// matrix, so a box shrunk onto a subject stays shrunk onto that subject when the room
// is levelled underneath it. `level-check` holds that invariant by rotating the world
// and the camera together and demanding the picture not change at all.
//
// The two angles stay on this side of that boundary, and the reason is the write below
// them: the registry's `tilt` and `roll` apply closures assign into this object. An
// object an importer writes into is the channel `module-check` rule 3 refuses, and it is
// refused for the reason that applies exactly here - the module that declares it cannot
// see the write, so nothing at that end knows what its own state is.
const worldTiltAngles = { tilt: 0, roll: 0 };

function applyWorldTilt() {
  tiltQuaternion(worldTiltAngles.tilt, worldTiltAngles.roll, worldTilt);
  cloud.quaternion.copy(worldTilt);
  // Levelling is the gesture that says "this frame is the room's", so it takes the
  // turntable's pole back off the sensor view. Cheap to call on every write - which
  // includes every frame of a clip that keys these - because the compare short
  // circuits whenever the pole is already where it belongs.
  setNavigationUp(WORLD_UP);
}

// --------------------------------------------------------- binding a source frame
//
// Moved to `gpu-textures.js`, beside the textures it swaps. The two doors, the grid a
// decimated block is expanded back onto and the refusal for a block on no grid at all
// are there, because the door and the pair it maintains are one thing: a caller able to
// reach a texture without going through the door is the second acquisition path this
// arrangement exists to prevent, and a boundary is a stronger statement of that than a
// comment was.

// ---------------------------------------------------------------- bloom
//
// Moved to `bloom-pass.js`. The progressive down/up chain that replaced
// `UnrealBloomPass` is there, and so is `bloomChainSize`, the reference height `resize`
// below sizes it at - each with the measurement that decided it. The one instance is
// built by `post-chain.js`, which is also where it sits between the other passes, because
// the order the image is put through them in is a decision about the pipeline rather than
// about the pass.

// ---------------------------------------------------------------- post chain
//
// Moved to `post-chain.js`. The composer, the trails, the bloom instance and the grade
// shader are there, and so is the order the image is put through them in, which is that
// file's whole opinion. What is here is the moment the chain is built, which is a decision
// about this program's boot rather than about the passes: the render pass is handed the
// scene it draws, so it is built after the cloud above, and it is built by a call rather
// than by an import, so the moment reads in the order it happens in.
buildPostChain();

let renderScale = 1;

// The drawing buffer an export has taken over, or null while the window owns it.
//
// An export's output resolution is a setting rather than a property of whatever
// window it was started from, and the look is resolution-relative precisely so
// that can be true - but the buffer still has to actually become that size, and
// there is one function that sizes it. So the override lands here rather than
// beside the export, and `renderScale` loses to it: it multiplies the pixel
// ratio, so a preview left at 85% would otherwise deliver an 85% file under a
// 1080p name.
let outputSize = null;

/**
 * The aspect the editor frames at, which is the aspect the export will be.
 *
 * Before this the viewport took its aspect from the window, so what you framed was
 * only what you got if your window happened to match - mild while every size in the
 * menu was 16:9, and severe the moment one of them is 1:1 or 65:24. The stage is
 * letterboxed to this instead, so the picture on screen is the picture in the file.
 *
 * **Vertical field is what stays fixed as this changes**, which is three.js's own
 * behaviour for a perspective camera and is also the only choice consistent with the
 * rest of the renderer: `pointSize` is pixels at 1080p and scales by
 * `bufferHeight / 1080`, and every grade term is referred to the same height. Hold
 * the vertical field and a point's apparent size against the world is invariant
 * across every aspect and every output size, so a look holds. Hold the horizontal
 * field instead and changing aspect moves the vertical field underneath a point size
 * still scaling off height, so the density of points per screen height drifts and
 * the grade quietly stops being the grade anybody tuned.
 *
 * So a wider ratio shows more to the sides and a squarer one shows less, and neither
 * changes how big anything is.
 *
 * **A shape and not a size, and the split is what this refactor is about.** This used to
 * be a `{w, h}` in pixels that drove the letterbox *and* named what the export would
 * render, so choosing 1280x720 instead of 1920x1080 was a document edit - and it is not
 * one. Two sizes of one shape are the same picture, because `pointSize` and every
 * screen-space term are expressed against 1080p and bloom's chain is frozen at 600
 * whatever the buffer is, so the smaller of the two needs no re-keying and reopens
 * identically. A different *shape* is not free, because the camera was keyed against a
 * frame - which is why the shape is here, on the document, and the pixel count is on the
 * deliverable where a second one can disagree with the first without either being wrong.
 *
 * Stored as the reduced integer pair rather than as a ratio, for `reduceAspect`'s reason:
 * DCI is 1.8963 and a document carrying that decimal would record a shape 0.2% away from
 * the one the clip was composed for.
 */
let projectAspect = [16, 9];
const targetAspect = () => projectAspect[0] / projectAspect[1];

// The shape buttons in the Project settings dialog, null until the boot below builds
// them. Declared here rather than beside that build because `setProjectAspect` repaints
// them and runs first - `restoreProject` reaches it, and a `let` read before its own
// declaration is a ReferenceError rather than an `undefined` the optional chain would
// forgive.
let aspectButtons = null;

/**
 * The resolution each shape was last on, so returning to a shape returns to its size.
 *
 * Session state and deliberately not in any document: a deliverable records the one size
 * it renders at, and this is only the memory that stops a shape change from throwing away
 * a size the operator picked. Persisting it would be a second place a resolution is
 * written, which is the shape of drift this whole split exists to remove.
 */
const sizeForShape = new Map();

// Where the letterboxed stage sits in the window. Set by `resize`, read by the
// overlay so both canvases cover the same pixels.
const stageBox = { left: 0, top: 0 };

/**
 * The rates the output can be, and the only list of them.
 *
 * Here rather than as four `<option>`s in the markup because two things read it and only
 * one of them is a control: `#tFps` is built from it, and `restoreProject` refuses a
 * document naming a rate this build does not offer. A validator that read the rates off
 * the select would be a document check standing on a DOM node, and one that spelled them
 * out again would be the second list this file keeps deleting.
 */
const OUTPUT_RATES = [24, 30, 60, 120];

/** The default shape, taken off the default size so there is still one list. */
const defaultAspect = () => reduceAspect(...DEFAULT_EXPORT_SIZE.split('x').map(Number));

/** A `WIDTHxHEIGHT` string as the shape it is, or `[0, 0]` when it is not a size. */
function aspectOfSize(text) {
  const [w, h] = String(text).split('x').map(Number);
  return w > 0 && h > 0 ? reduceAspect(w, h) : [0, 0];
}

const sameAspect = (a, b) => a[0] === b[0] && a[1] === b[1];

/**
 * The size a shape opens on: the default one where the shape offers it, the smallest it
 * offers otherwise, and null for a shape the table has nothing for.
 *
 * Null rather than a manufactured size, because the only way to be here is a project
 * saved before the shape moved onto the document, whose `outputSize` was free to be
 * anything a hand had typed. Scaling `[8, 5]` up to something near 1080p would put a
 * resolution the product does not offer into a deliverable and then into a filename, and
 * a number this repo would find later and have to correct is exactly what the reduced
 * pair exists to avoid. The callers carry the null instead - the load hands the legacy
 * size straight across, and `exportClip` refuses a pair that disagrees.
 */
function openingSizeForAspect(aspect) {
  const sizes = sizesForAspect(aspect).map(([w, h]) => `${w}x${h}`);
  if (sizes.includes(DEFAULT_EXPORT_SIZE)) return DEFAULT_EXPORT_SIZE;
  return sizes[0] ?? null;
}

/**
 * The resolution menu, which is every size in the table of the project's shape.
 *
 * **Rebuilt on every shape change rather than filtered on the way past**, because the
 * alternative - one menu of everything with the wrong shapes disabled - is a control that
 * offers a reframe it will not perform, and this dialog no longer has the authority to
 * reframe anything.
 *
 * A size the table does not offer is appended rather than dropped, which is the same rule
 * the old whole-table menu carried and it survives for the same reason: a project saved
 * before the shape moved onto the document carried a hand-typed `outputSize`, so `[8, 5]`
 * is a shape with real pixels behind it and no group here to hold them. The size the clip
 * was actually framed at is a better answer than the nearest neighbour.
 */
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
      // Through the setter and then straight to the stack, because this is one of the two
      // controls in the program that edit the document from a dialog. `history.commit`
      // compares snapshots, so pressing the shape the clip is already on costs nothing.
      if (setProjectAspect(aspect)) history.commit();
      paintAspectSelection(buttons);
    });
    container.appendChild(button);
    return button;
  });
  paintAspectSelection(buttons);
  return buttons;
}

/**
 * Which shape button is lit, read off the document rather than off the last press.
 *
 * None of them, when the project's shape is one the table does not offer - which is
 * honest and is the point. A legacy `outputSize` of 1600x1000 is a real shape this build
 * will letterbox to and go on exporting, and lighting the nearest button would say the
 * clip is 16:9 while the stage says otherwise.
 */
function paintAspectSelection(buttons) {
  for (const button of buttons) {
    const aspect = button.dataset.aspect.split('x').map(Number);
    button.setAttribute('aria-pressed', String(sameAspect(aspect, projectAspect)));
  }
}

/**
 * Adopt a shape: the editor reframes to it and the project remembers it.
 *
 * The shape is document state rather than a control's position, because a composition and
 * the frame it was composed for are one thing. A 65:24 shot reopened at 16:9 would be a
 * different shot with the same keys, which is the class of silent reinterpretation the
 * point-size rebase already taught this repo to refuse.
 *
 * **The deliverable comes with it, and it has to.** Every other route into this program
 * assumes the thing being rendered is the shape the stage is showing - `exportClip`
 * refuses the pair when they disagree - so a shape change that left a 16:9 resolution
 * behind would produce an editor that cannot export until somebody notices the menu.
 * Keeping a size that already matches is what makes the shape change a no-op for the
 * deliverable when the document simply restated its own shape, which is the ordinary case
 * on every project load and every undo.
 */
function setProjectAspect(aspect, { fromDocument = false } = {}) {
  const [w, h] = reduceAspect(aspect[0], aspect[1]);
  if (!(w > 0 && h > 0)) return false;
  const leaving = projectAspect.join(':');
  projectAspect = [w, h];
  ensureActiveDeliverable();
  if (!sameAspect(aspectOfSize(activeDeliverable.outputSize), projectAspect)) {
    // **The size this shape was last on, before the size this shape opens on.** A shape
    // change replaces a resolution it cannot keep, and the deliverable is not undoable, so
    // without a memory the replacement is one-way: pick 3840x2160, change the shape, press
    // undo, and the stage comes back to where it was while the 4K the operator chose has
    // become 1920x1080 - the document restored and a per-file setting silently downgraded
    // by an edit that claims to move nothing but the frame.
    //
    // Keyed by shape rather than kept as a single previous value, because the question a
    // returning shape asks is "what was I last rendered at", and one slot answers that for
    // one shape and then lies to the next. Recorded on the way out rather than on the way
    // in, so the size being displaced is the one that gets remembered.
    sizeForShape.set(leaving, activeDeliverable.outputSize);
    // A shape the table has nothing for leaves the deliverable where it was, and
    // `exportClip` is what says so - refusing at the press rather than rendering a file
    // that is not the shape on screen.
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

/**
 * Adopt an output size, which reframes nothing and is the whole point of the split.
 *
 * Every size this can be given is of the shape the stage is already letterboxed to, so
 * there is no `resize()` here and its absence is the behaviour rather than an omission:
 * a resolution is how many pixels the same picture is delivered at, and the editor has
 * nothing to redraw when that number moves. The one thing that has to happen is that the
 * deliverable and the menu agree, because the menu is where the operator reads it back.
 */
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

// Which camera the viewport draws. Navigation is switched off while the program
// camera is on screen, because a drag would otherwise move the free camera
// somewhere nobody can see and leave it there.
function setViewCamera(cam) {
  // Through `scene.js`, because `viewCamera` is that module's binding now and an
  // importer cannot assign to what it imports. The opinion stays here - which pass
  // draws and whether navigation is live - and only the assignment moved.
  useViewCamera(cam);
  renderPass.camera = cam;
  controls.enabled = cam === freeCamera;
}

// How many times the drawing buffer has been resized. Read by `editor-check` rather
// than timed, for the reason the lane counters exist: "the splitter does not resize per
// pointer event" is a claim about how often this ran, and a stopwatch would pass on a
// fast machine that ran it every time. A plain `let` beside the function rather than a
// field on `counters`, which is declared eighteen hundred lines below this and would be
// in its temporal dead zone on the `resize()` that runs at boot.
let stageResizes = 0;

// The transport, or null until a take is open. Declared here rather than beside the
// class it is built from four thousand lines below, and for the same reason the counter
// above is: `resize()` ends by asking for a repaint, `requestRepaint` reads this binding
// first, and the `resize()` that runs at boot would be reading a `let` in its temporal
// dead zone - a ReferenceError before the page has drawn anything, on the one path
// nothing recovers from. That it is read there is deliberate rather than incidental:
// null is the honest answer at boot, and it is the answer that makes the repaint stand
// down until there is something to repaint.
let timeline = null;

/**
 * Who owns the transport's play state right now.
 *
 * Four things pause the take, do something to the document, and then decide for
 * themselves whether it should be running again: a speed gesture, an output-rate
 * change, an undo, and a project load. Each reads `timeline.playing` up front and acts
 * on it afterwards - and "afterwards" is across a seek that renders a pre-roll, which
 * is long enough for the next one to start. The one that reads first can therefore land
 * its answer on top of a newer one: a project load that deliberately restores a paused
 * take found it playing, because a speed gesture from before it still owed a resume.
 *
 * So each of them takes the transport on the way in and checks it still holds on the
 * way out. Counting rather than cancelling, because there is nothing to cancel - the
 * resume lives inside a promise chain already in flight, and the cheapest true thing to
 * ask it is whether the decision it carries is still the current one.
 */
let transportGen = 0;
const takeTransport = () => {
  transportGen += 1;
  dropRateGesture();
  return transportGen;
};

/**
 * Drops a speed gesture whose document has been replaced underneath it.
 *
 * **A gesture holds a snapshot of the document it began in, so anything that replaces
 * that document from outside the gesture has to say so.** Guarding only the release left
 * the other half open: a slider event arriving after the swap called `applyRate` with no
 * check at all, which writes the *old* cuts through `setClipInOut` and leaves the new
 * document's keys - different objects now - unrescaled while the ruler rescales under
 * them. That is the bug this whole branch exists to fix, arriving through the back. There
 * is nothing left to check once the gesture is gone, and the next slider event simply
 * starts a fresh one on the document that is actually open.
 *
 * **This is separate from `takeTransport` because the class is wider than that door, and
 * finding out cost a round.** Transport ownership and document ownership looked like one
 * thing while the only replacers were undo and a project load, which take the transport
 * on their way past. `applyDeliverable` replaces both cuts and the output rate and takes
 * nothing - so a deliverable chosen from the menu while the thumb was held had its trim
 * overwritten from the previous one's snapshot, and the export would have written the
 * wrong range. Folding it into `takeTransport` instead would have bumped the generation a
 * second time inside `loadProjectNamed`, which reads that number to decide whether to
 * resume, so the loader would have stopped resuming - one rule, two questions.
 */
const dropRateGesture = () => {
  // It cannot cancel the gesture that is being started: `beginRateGesture` calls
  // `takeTransport` before it has anything to assign.
  if (rateGesture) rateGesture = null;
};

/**
 * Stops the transport *and says so*, which is what every navigation here has to do.
 *
 * **A pause is a claim on the transport, and the resumes queued behind an older gesture
 * only ask whether anybody has claimed it since.** A rate release seeks before it plays
 * again, and that seek is a pre-roll - long enough to start a scrub, drag a cut, step a
 * frame, press space or begin an export. All of those paused, none of them took the
 * transport, so the older gesture's `.then` still found its own generation current and
 * started the take playing underneath a gesture that had deliberately stopped it. The
 * space bar was the plainest version: pause, and a moment later the take is running.
 *
 * `beginRateGesture` deliberately does not come through here - it takes the transport
 * *before* it pauses, so that the generation it keeps is its own.
 */
const pauseTransport = () => {
  takeTransport();
  timeline.pause();
};

function resize() {
  stageResizes++;
  // What the drawing buffer measured on the way in, so the repaint at the bottom can
  // ask whether this call actually reallocated it. See the comment there for why the
  // question is worth asking rather than assuming the answer is always yes.
  const wasBuffer = renderer.getDrawingBufferSize(new THREE.Vector2());
  // The stage is the window less the application bar and whatever the timeline strip
  // is taking, which is nothing at all while it is hidden. Overlaying either on the
  // image would hide part of every frame being graded.
  // Inside that space it is the largest box of the
  // target aspect that fits inside it. The letterbox is what makes the editor
  // WYSIWYG: the camera's aspect is the canvas's aspect is the file's aspect, so
  // nothing is stretched and nothing is cropped between here and the export.
  //
  // Fitting rather than masking, because the two directions are not symmetric. A
  // target narrower than the window could be shown by masking the sides, but a target
  // wider than the window sees *more* world than the window is showing, and no mask
  // can draw what was never rendered.
  const availW = innerWidth;
  const appBarHeight = document.getElementById('appBar')?.offsetHeight ?? 0;
  // The collapsed panel is a bar along the bottom, and it is the same kind of thing the
  // application bar and the timeline strip are: something drawn over the stage rather
  // than beside it. Left out of this sum it does not shrink the picture, it *covers*
  // the bottom of it - the frame is still rendered full height and the last 72px of
  // every one of them is behind the dock, which is the one part of the image an
  // operator framing a shot is most likely to be looking at.
  //
  // Expanded, the panel contributes nothing here on purpose: it is a column down the
  // side, and the stage is already letterboxed to the target aspect, so it overlays
  // margin rather than picture.
  const dockHeight = document.body.classList.contains('panelcollapsed')
    ? document.getElementById('panelDock')?.offsetHeight ?? 0
    : 0;
  const availH = Math.max(1, innerHeight - timelineEl.offsetHeight - appBarHeight - dockHeight);
  const fitH = Math.max(1, Math.min(availH, Math.round(availW / targetAspect())));
  const fitW = Math.max(1, Math.round(fitH * targetAspect()));
  const width = outputSize ? outputSize.w : fitW;
  const height = outputSize ? outputSize.h : fitH;
  // An export's aspect comes from the output it was asked for, not from the window
  // it was started in, or the file would be framed by whoever happened to be
  // watching.
  for (const cam of [freeCamera, programCamera]) {
    cam.aspect = width / height;
    cam.updateProjectionMatrix();
  }
  const ratio = outputSize ? 1 : Math.min(devicePixelRatio, 2) * renderScale;
  renderer.setPixelRatio(ratio);
  // The canvas keeps the CSS box it had while an export runs. The buffer becomes
  // the output's, which is the part that matters, and the page does not reflow
  // around a 1080p canvas in a 640px window and drag the editor's furniture with
  // it.
  renderer.setSize(width, height, !outputSize);
  composer.setPixelRatio(ratio);
  composer.setSize(width, height);
  // Where the letterboxed stage sits, published for the overlay to line up with.
  // Written rather than each canvas working it out, so the two cannot drift apart by
  // a scrollbar - and read by `drawChrome` rather than set on the chrome canvas from
  // here, because that element is created hundreds of lines below and touching it in
  // this function is a temporal-dead-zone throw on the very first `resize()`.
  if (!outputSize) {
    stageBox.left = Math.round((availW - fitW) / 2);
    stageBox.top = appBarHeight + Math.round((availH - fitH) / 2);
    renderer.domElement.style.position = 'fixed';
    renderer.domElement.style.left = `${stageBox.left}px`;
    renderer.domElement.style.top = `${stageBox.top}px`;
  }
  const buf = renderer.getDrawingBufferSize(new THREE.Vector2());
  // The chain is sized off a fixed reference rather than off this buffer, and
  // `bloomChainSize` in `bloom-pass.js` carries the measurements that decided which
  // reference and what a wrong one costs. The argument belongs beside the pass because
  // what freezes the size is the tap count that pass bakes into its shaders when it is
  // constructed, and a number without that mechanism beside it reads as a resolution bug
  // somebody should fix.
  const chain = bloomChainSize(buf.x, buf.y);
  bloom.setSize(chain.width, chain.height);
  grade.uniforms.resolution.value.set(buf.x, buf.y);
  uniforms.bufferHeight.value = buf.y;
  // And then ask for the picture back, because everything above reallocates the drawing
  // buffer and nothing above draws into it again. A parked editor has no clock of its
  // own - `tickNow` returns immediately on `!playing` and `pumpParkedDraft` returns with
  // nothing armed - so the stage stays black until something unrelated happens to seek,
  // with the chrome overlay floating over it because that is a separate 2D canvas
  // `placeChrome` goes on repainting. Every path that resizes a parked stage had it: the
  // window listener below, the three splitter entries, the render-scale slider, the
  // shape controls through `setProjectAspect`, and `rebuildLanes` reaching this
  // indirectly - which is the argument for the repaint being here, at the door, rather
  // than at a caller list the seventh path would be added outside of.
  //
  // **This is not the pump section 9 of `editor-check` forbids.** That rule is about a
  // redraw asking for the next redraw: `renderProgramFrame` moves the camera, so a
  // handler that renders on a control's `change` has armed its own successor and a
  // parked drag runs at whatever rate the machine can rebuild a frame. Nothing of that
  // shape is here. `requestRepaint` stands down while playing, scrubbing, orbiting or
  // exporting, and coalesces through `queueMicrotask`, so a splitter drag costs one
  // accurate seek per settled state rather than one per pointer move.
  //
  // What keeps it that way is that nothing in the render path reaches this function, and
  // that is a property to hold rather than one to assume. A `renderScale` track would
  // have been exactly that path - `evaluateTracks` has no tag filter and runs per
  // rendered frame - so the refusal `restoreProject` now makes is what stops this line
  // becoming a repaint requested once per frame of every pre-roll.
  //
  // **Only when the buffer actually moved, and that condition was measured rather than
  // reasoned about.** Most calls here change nothing: `rebuildLanes` runs this whenever
  // the lane set is rebuilt, so every rate change reaches it through
  // `timingChanged` -> `lanesChanged` with the strip the same height it already was.
  // Asking for a repaint there is asking for a second accurate seek on top of the one
  // the gesture's own release is about to issue - measured at 2 seeks for one held
  // arrow key against 1, which is the seek storm the speed control was rewritten to
  // avoid, coming back through a door that was opened for something else. It cost the
  // take as well: the release resumes playback behind its seek, and the repaint's seek
  // landed on top of that and put the playhead back on the frame the resume had just
  // left, so a held key stopped the take three runs out of three.
  //
  // The condition is safe because a `setSize` to the size something already has does
  // not reallocate anything: `WebGLRenderTarget.setSize` returns early on an unchanged
  // size, and Chrome's canvas does the same for an unchanged `width`/`height`. Measured
  // on this build rather than read off a specification - a stage carrying 158,247 lit
  // pixels carried exactly 158,247 across a same-size `resize()`, and 0 across one that
  // moved the buffer 1298x730 -> 1084x610. `editor-check` section 13 asserts both
  // halves, because the premise this guard rests on is a fact about a browser and the
  // day it stops being true is the day the stage goes black with nothing saying so.
  const buffer = renderer.getDrawingBufferSize(new THREE.Vector2());
  if (buffer.x !== wasBuffer.x || buffer.y !== wasBuffer.y) requestRepaint();
}
addEventListener('resize', () => {
  // The ceiling is a share of the window, so a window that got shorter can put the
  // strip over it - and a strip taller than its own bound is the state the splitter
  // exists to make unreachable. Re-applied before the stage is sized against it.
  applyLaneHeight();
  resize();
  // The ruler picks its tick step from the bed's width, so a window that changed width
  // has the previous width's tick count on it until something else happens to rebuild
  // it - a zoom, or a timing change. Narrowed, that is labels written over each other;
  // widened, it is a ruler far sparser than the space it has. Nothing else on this path
  // touches it, and the strip is the one surface whose content depends on how wide it is
  // rather than only on where it is.
  if (timeline) buildRuler();
});
resize();

function postEnabled() {
  return afterimage.enabled || bloom.enabled || grade.enabled;
}

// ------------------------------------------------------------ the registry

// One declarative registry. Every parameter that shapes the image says here what
// its default and range are, where its value lands in the renderer, how it
// interpolates once step 5 keyframes it, and which side of the look/composition
// split it sits on. Before this the values lived in four places - `uniforms.X`,
// `bloom.strength`, `afterimage.uniforms.damp` and `grade.uniforms.*` - with the
// DOM sliders as the actual source of truth, written by dispatching a synthetic
// input event at them. That works right up until something without a DOM has to
// set a look: a keyframe, a project file, a preset, or step 6's headless export
// renderer. Now those are all the same operation on one object.
//
// Three interpolation kinds cover the surface, and they are carried here rather
// than invented beside the keyframe editor, so there is one table rather than two
// that can quietly disagree:
//
//   scalar  lerps between keys, with ease handles. Most sliders.
//   step    holds until the next key. Every checkbox - lerping a boolean is
//           meaningless.
//   pose    position, orientation and field of view move together, because a
//           camera move judged one component at a time is not judged at all.
//
// The tag is the same axis that decides what a preset contains. `look` travels
// between clips. `composition` never does - applying someone else's look must not
// move your camera, which is the whole reason a preset is not just a saved
// project. `view` is neither: render scale and auto-orbit change what you are
// looking at rather than what the clip is, so they stay out of a preset and out of
// the undo snapshot for the same reason orbiting to inspect the cloud does.
//
// `near`/`far` are the awkward pair and are tagged look deliberately. They shape
// the image, but the right value depends on where the subject actually stood, so
// saving a preset picks which parameters go in with the look tags as the default
// selection rather than taking the whole tag blindly. They are also viewer clips
// and nothing else: they hide points that already arrived, which is unrelated to
// the grabber's --min-depth/--max-depth, and wiring the two together would throw
// away footage on the GPU before a frame was ever built.

function updateDrawRange() {
  const shedding = uniforms.fadeTime.value > 0 || uniforms.wakeTime.value > 0;
  geometry.setDrawRange(0, shedding ? POINTS * 2 : POINTS);
}

function gradeNeeded() {
  return grade.uniforms.rgbSplit.value > 0
    || grade.uniforms.scanlines.value > 0
    || grade.uniforms.grain.value > 0
    || grade.uniforms.vignette.value > 0
    || grade.uniforms.streak.value > 0;
}

// ------------------------------------------------- fitting the box to the footage

/**
 * How far outside the cloud the fitted faces sit, as a share of the extent they bound.
 *
 * The pad is what turns a percentile into a box that culls nothing you can see. The
 * scan answers with p0.5 and p99.5, so a face laid exactly there would cut a half
 * percent of the take off each side - real geometry at the frame edges rather than
 * only speckle - and 15% of the extent puts the plane comfortably outside it: on the
 * sample take that is 69cm across and 39cm up, against a sensor whose depth jitters
 * about 4mm.
 */
const CROP_FIT_PAD = 0.15;

/**
 * Fits the four lateral faces to the take's own cloud.
 *
 * **Why this exists at all is a fact about the defaults rather than about this take.**
 * The faces open at plus or minus `CROP_LIMIT`, which has to clear everything the
 * sensor can see at the furthest depth a slider allows or a document that never asked
 * to be cropped would load cropped - and what that produces is a box three to seven
 * times the size of any real cloud, with all twelve edges off screen and a handle
 * nobody can associate with anything. The bound is right and the box you are handed
 * was the bound, which are two different questions answered by one number.
 *
 * **The depth pair is deliberately left where the document put it.** Measured over
 * three takes, a percentile fit of `near`/`far` asks to open the far plane to about 9m
 * against the 6m it defaults to, because the cloud's far tail is the back wall and the
 * sensor sees the back wall. Fitting depth would make the box bigger and would crop
 * a room to grade it - which is the coupling `duotoneSpan` exists to have already
 * removed.
 *
 * The range is handed to the server rather than assumed there, because the answer is
 * over the points that survive it: a box has no business bounding points the box
 * already discards, and a server picking its own range would be a second declaration
 * of the clip defaults.
 *
 * Returns what it wrote, or null when the take had nothing to fit to - a scan that
 * found no samples inside the range is a clip range shut past its own footage, and the
 * honest answer there is to leave the faces open rather than to close them onto
 * nothing.
 */
async function fitCropToTake(id, near, far) {
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
  // Through `params.set` and not by assigning the uniforms, so the fit is a document
  // edit like any other: it lands in the panel's sliders, it serialises, and it is the
  // same write a drag on a face makes. `set` clamps to the declared bounds, which is
  // what keeps a wide room from asking for a face outside `CROP_LIMIT`.
  const wrote = {};
  for (const [name, value] of [['left', left], ['right', right], ['bottom', bottom], ['top', top]]) {
    wrote[name] = params.set(name, value);
  }
  return { ...wrote, frames: extent.frames, samples: extent.samples };
}

// The panel's groups, in the order they appear down the panel, and nothing about
// which parameters are in them - that is the `group` field on each registry entry
// below, so a parameter joins a group by naming it rather than by being added to a
// second list here that could disagree with the first.
//
// The headings and the notes moved here out of `index.html` along with the rows they
// belong to. A group's design argument belongs beside the group, and the group is
// now this entry.
//
// `lookgroup` decides where the group lands: everything without it goes before
// `#sensorGroup`, everything with it after `#gradeAnchor`. That is one property
// rather than two, because it is one question - is this group part of the grade, or
// is it something you need while shooting.
//
// `collapses` is the second such property, and it is declared here for the same reason
// `lookgroup` is: a group added next year answers the question by existing rather than
// by somebody remembering to put its key in a list somewhere else, which is the list
// that would go stale. It says only that the group *may* be shut - whether it is shut
// right now is derived from the document by `revealsItself` below and overridden only
// where a person has disagreed, so there is no stored open/closed state to keep in step
// with the values. Everything without it always renders open, and `framing` is the one
// where that matters beyond taste: its `after()` emits `#cropReset`, which `editor-check`
// clicks, and Playwright's click waits for visibility - so a collapsible `framing` would
// turn that row into a thirty-second timeout, which is a crash carrying no failed
// assertion rather than a finding.
//
// `reveals` is the escape hatch beside it, and exactly one group needs one. A group's
// default rule is that it is in use when its own parameters are, and `Reading · detail`
// is *also* governed by another group's values - so the rule lives on the entry with the
// group it is about rather than as a branch inside the predicate that would have to name
// it. A closure widens the default rule and must not replace it: which groups are open
// is the look's diff against its defaults, and a group that dropped its own parameters
// out of its rule would be carrying values the panel had stopped accounting for.
const PANEL_GROUPS = [
  // The five readings of the take, which were five buttons and one integer uniform
  // until they became five look parameters. They mix rather than exclude, so this is
  // sliders and not a segmented control: RGB at 0.6 against depth at 0.4 is a 60/40
  // blend of the camera image and the range ramp, and each one keyframes, so a clip
  // can dissolve from one reading into another under the playhead.
  //
  // Colour: what the point is coloured by (the source blend) and the core colour
  // adjustments. The source weights mix rather than exclude, so `readRgb` at 0.6
  // against `readDepth` at 0.4 is a 60/40 blend of the camera image and the range
  // ramp, and each one keyframes.
  { key: 'colour', label: 'Colour', tab: 'look', collapses: true },
  // Style: the treatments applied to the colour (ghost, contour, blackwall), the
  // secondary colour effects (scan, rim, thermal, edges), and the tuning parameters
  // for each. Everything that stylises the image lives here, and the tuning params
  // reveal naturally when their parent effect is enabled because they share a group.
  { key: 'style', label: 'Style', tab: 'look', lookgroup: true, collapses: true },
  // Framing: what you can see, and where you are seeing it from. `sensor view` is
  // navigation and writes nothing - distinct from `look through it` in the camera
  // group, which adopts the program camera whose pose is document state.
  {
    key: 'framing',
    label: '',
    tab: 'framing',
    collapses: false,
    // Levelling sits above the sliders. Document state, unlike the `sensor view` it
    // sits under - the angle a bracket ended up at belongs to the take, so it rotates
    // the room and not the camera, and the top-down, auto-orbit and the exported frame
    // come level with the picture.
    before: () => [
      panelButtonRow(['camSensor', 'sensor view']),
      // Beside `sensor view` because it is the same kind of thing: a control that
      // changes what the person at the screen can see and writes nothing into the
      // take. It is in this group rather than in the View menu with the other two
      // furniture toggles because it is the tool for the six sliders underneath it,
      // and a control you reach for while dragging a face should not be two clicks
      // into a menu that closes when you press it.
      panelButtonRow(['cropBox', 'show crop box']),
      // Beside the box's own switch, because it is the other half of the same job: one
      // shows you the box and one puts it where your footage is.
      //
      // **On the editor alone, and that is a fact about what it needs rather than a
      // judgement about who wants it.** The fit scans a take, and the recorder has no
      // take - it has a sensor pointed at a room, with the box being set up over live
      // frames. A button here that always refused would be a control whose surface
      // cannot answer it, which is the shape `dock-offers-the-take-on-the-editor`
      // exists to keep out of the dock.
      ...(EDITING ? [panelButtonRow(['cropFit', 'fit box to take'])] : []),
      panelButtonRow(['camLevelReset', 'reset rotation']),
    ],
    after: () => [
      panelButtonRow(['cropReset', 'revert all to default']),
      panelNote('recRange', 'preview only'),
    ],
  },
  // Below here is the grade, and every group is one stage of the pipeline rather than
  // one subject heading. The order is the order the image is built in: what the depth
  // signal is conditioned into, where the points are moved to, how they are drawn,
  // what colour they take, what persists between frames, and what the optics do to
  // the result.
  { key: 'signal', label: 'Signal', tab: 'look', lookgroup: true, collapses: true },
  // Two groups at one stage of the pipeline, on two tabs, and the split is the honest
  // one rather than a tidy one. Both displace points before projection, so both are the
  // displacement stage - but `displacement` is the turbulence field, and the region's
  // scramble adds into its amplitude and reuses its scale and speed, so those two have
  // to be readable together or a look gets tuned against half of itself. Glitch shares
  // no uniform with either of them and reads no region. It sat in `displacement` for
  // long enough that its slider was somewhere nobody stylising an image would think to
  // look, which is the whole of what "we cannot control the glitches" turned out to
  // mean, and being adjacent in the render order is not a reason to be adjacent on a
  // tab. It is not in `post` either: that group is the full-screen grade and this moves
  // geometry, so filing it there would be the subject-heading move these groups exist
  // to refuse.
  { key: 'glitch', label: 'Glitch', tab: 'look', lookgroup: true, collapses: true },
  { key: 'displacement', label: 'Displacement', tab: 'region', lookgroup: true, collapses: true },
  // One region in the room, read three ways: it displaces, it scrambles, and it
  // masks. Everything here is metres in the sensor frame, so a look holds at any
  // output size without being referred to 1080p the way the screen-space terms are.
  // Half-extents at zero with a radius is a sphere; raise them and it becomes a
  // rounded box; take two to zero and it is a capsule. No shape selector, because an
  // enum could not keyframe and these sliders can.
  { key: 'region', label: 'Region (metres)', tab: 'region', lookgroup: true, collapses: true },
  { key: 'points', label: 'Points', tab: 'look', lookgroup: true, collapses: true },
  // The three terms that accumulate across frames, together. Fade and wake are the
  // surface memory and trails is the afterimage buffer; they were two groups apart
  // while doing one thing, which is how a look gets tuned twice.
  { key: 'motion', label: 'Motion', tab: 'look', lookgroup: true, collapses: true },
  { key: 'post', label: 'Post', tab: 'look', lookgroup: true, collapses: true },
  // The raster gets a group of its own, following the precedent the glitch rework set: a
  // term that grows sub-controls gets a group rather than crowding its neighbours. It
  // sits immediately under `post` because it is the same pass - the grade - and the four
  // controls in it are one idea, where the five left in `post` are five separate ones.
  // Splitting on that basis rather than on "these are all post effects" is the same call
  // the glitch made when it left `displacement`.
  { key: 'raster', label: 'Raster', tab: 'look', lookgroup: true, collapses: true },
  // The two parameters that are not part of the clip, in the one group that says so.
  // They are tagged `view` in the registry, they get no keyframe control and no
  // preset carries them - and while they sat inside look groups that read as an
  // oversight rather than as the split it is.
  {
    key: 'viewer',
    label: 'Viewer',
    tab: 'camera',
    lookgroup: true,
    collapses: true,
    after: () => [panelNote('viewNote', 'Not saved with the clip and not exported: these '
      + 'change what you are looking at, not what the frame is.')],
  },
];

const PARAMS = {
  // Pixels at 1080p, not pixels. The unit changed exactly once, when the screen-
  // space terms went resolution-relative, and every value here changed with it:
  // this default and both presets are their old values times 1080/600, the 600
  // being the drawing buffer the look was graded against. The step went with them
  // - 0.5 was a fifth of a pixel of the old grid and 8.1 is not on it, and a
  // preset that snapped to 8.0 would leave the rebase 1.2% out for no reason
  // anyone could later find.
  pointSize: { def: 9, min: 0.5, max: 64, step: 0.1, kind: 'scalar', tag: 'look',
    group: 'points', label: 'size',
    apply: (v) => { uniforms.pointSize.value = v; } },
  opacity: { def: 1, min: 0.05, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'points', label: 'opacity',
    apply: (v) => { uniforms.opacity.value = v; } },
  exposure: { def: 1.15, min: 0.05, max: 6, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'colour', label: 'brightness',
    apply: (v) => { uniforms.exposure.value = v; } },
  additive: { def: false, kind: 'step', tag: 'look',
    group: 'points', label: 'additive glow', apply: setAdditive },

  // The mount's cant, in degrees. Document state rather than view, because the angle
  // belongs to the take and every project on it wants the same answer - see the long
  // note above `applyWorldTilt` for why it rotates the world instead of the camera.
  //
  // The ranges are the whole of what the pair can mean and not a judgement about how
  // far a bracket can lean. `roll` turns the picture in its frame, so it needs the full
  // turn; `tilt` pitches the room onto its vertical, and a quarter turn either side
  // already reaches every orientation a surface can have, because past that the same
  // room is described by a roll of the other sign. A range chosen by taste instead
  // would refuse a mount somebody actually built.
  tilt: { def: 0, min: -90, max: 90, step: 0.5, kind: 'scalar', tag: 'look',
    group: 'framing', label: 'tilt',
    apply: (v) => { worldTiltAngles.tilt = v; applyWorldTilt(); } },
  roll: { def: 0, min: -180, max: 180, step: 0.5, kind: 'scalar', tag: 'look',
    group: 'framing', label: 'roll',
    apply: (v) => { worldTiltAngles.roll = v; applyWorldTilt(); } },
  near: { def: CLIP_NEAR_DEFAULT, min: 0.05, max: 9.5, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'framing', label: 'near',
    apply: (v) => { uniforms.nearClip.value = v; } },
  far: { def: CLIP_FAR_DEFAULT, min: 0.05, max: 9.5, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'framing', label: 'far',
    apply: (v) => { uniforms.farClip.value = v; } },

  // Whether the box cuts at all, over all six faces at once.
  //
  // **This is not a second spelling of "the faces are at their bounds".** The faces say
  // where the box is and this says whether it bites, so releasing it keeps the numbers
  // where a reset throws them away - which is the whole reason to have it, because
  // cropping tight and then wanting to see what you removed is otherwise four remembered
  // values. A document that has touched neither is uncropped under both readings, so the
  // ±`CROP_LIMIT` defaults below go on meaning exactly what their own comment says.
  //
  // A look parameter and not a viewer switch, deliberately. Bypassing in the viewer alone
  // would let the editor's picture and the exported frame disagree, and the render is
  // where you would find that out. Here it keys like anything else, so a clip can open
  // its box mid-shot, and `kind: 'step'` makes that a cut rather than a ramp.
  crop: { def: true, kind: 'step', tag: 'look',
    group: 'framing', label: 'crop',
    apply: (on) => { uniforms.cropOn.value = on ? 1 : 0; } },

  // The other four faces. Same units and the same step as the two above, because they
  // are the same box - and the defaults sit at the bounds so a clip that was authored
  // before these existed loads with nothing cropped. `CROP_LIMIT` is checked against
  // the sensor's own reach at boot rather than left as a number somebody once worked
  // out; see the assertion below the registry.
  left: { def: -CROP_LIMIT, min: -CROP_LIMIT, max: CROP_LIMIT, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'framing', label: 'left',
    apply: (v) => { uniforms.cropL.value = v; } },
  right: { def: CROP_LIMIT, min: -CROP_LIMIT, max: CROP_LIMIT, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'framing', label: 'right',
    apply: (v) => { uniforms.cropR.value = v; } },
  bottom: { def: -CROP_LIMIT, min: -CROP_LIMIT, max: CROP_LIMIT, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'framing', label: 'bottom',
    apply: (v) => { uniforms.cropB.value = v; } },
  top: { def: CROP_LIMIT, min: -CROP_LIMIT, max: CROP_LIMIT, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'framing', label: 'top',
    apply: (v) => { uniforms.cropT.value = v; } },

  interpolate: { def: true, kind: 'step', tag: 'look',
    group: 'signal', label: 'interpolate frames',
    apply: (on) => { uniforms.interpolate.value = on ? 1 : 0; } },
  snapDelta: { def: 250, min: 20, max: 1200, step: 10, kind: 'scalar', tag: 'look',
    group: 'signal', label: 'snap mm',
    apply: (v) => { uniforms.snapDelta.value = v; } },

  // Both drive the same memory: fade is the honest cross-fade, wake is how much
  // longer a hard transition lingers on top of it. Sized in seconds rather than in
  // frame intervals, so improving the frame rate does not shorten the look. The
  // ghost half of the geometry is left out of the draw range entirely when neither
  // can shed, so a look with no persistence costs nothing to have the option.
  fade: { def: 120, min: 0, max: 1500, step: 10, kind: 'scalar', tag: 'look',
    group: 'motion', label: 'fade',
    apply: (v) => { uniforms.fadeTime.value = v / 1000; updateDrawRange(); } },
  wake: { def: 0, min: 0, max: 4000, step: 10, kind: 'scalar', tag: 'look',
    group: 'motion', label: 'wake',
    apply: (v) => { uniforms.wakeTime.value = v / 1000; updateDrawRange(); } },

  // The turbulence field, in world units throughout: amplitude in metres, scale in
  // cycles per metre, speed in metres of drift per program second. Nothing here is a
  // screen-space length, so unlike `pointSize` and the grade terms none of it is
  // referred to 1080p - the same values draw the same displacement at every output
  // size because they describe the room rather than the frame.
  noise: { def: 0, min: 0, max: 1, step: 0.005, kind: 'scalar', tag: 'look',
    group: 'displacement', label: 'turbulence',
    apply: (v) => { uniforms.noise.value = v; } },
  noiseScale: { def: 3, min: 0.2, max: 12, step: 0.1, kind: 'scalar', tag: 'look',
    group: 'displacement', label: 'grain m',
    apply: (v) => { uniforms.noiseScale.value = v; } },
  noiseSpeed: { def: 0.7, min: 0, max: 3, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'displacement', label: 'speed',
    apply: (v) => { uniforms.noiseSpeed.value = v; } },
  // How far the cloud is pulled onto its grid, so the two ends are the measured surface
  // and a fully reconstructed one, and everything between is the surface arriving. It
  // snaps in the levelled frame, which means a canted mount does not cut the grid on the
  // diagonal - the shader block carries that reasoning and the rotation it uses.
  lattice: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'displacement', label: 'lattice',
    apply: (v) => { uniforms.lattice.value = v; } },
  // The cell, in metres of the room like every other displacement here and unlike the
  // screen-space terms. A cell is a distance the subject stands in rather than a size on
  // screen, so the same look gives the same grid at any output resolution, and the floor
  // does not re-quantise when you export at a different size.
  latticeCell: { def: 0.05, min: 0.005, max: 0.5, step: 0.005, kind: 'scalar', tag: 'look',
    group: 'displacement', label: 'cell m',
    apply: (v) => { uniforms.latticeCell.value = v; } },

  // Datastream corruption: one master and five ceilings, where there used to be one
  // scalar carrying all six meanings at fixed ratios. The comment beside the uniforms
  // has the argument for the shape; what belongs here is why the ceilings are ceilings
  // and not absolute values. An absolute set would need a clip to animate density,
  // shove and tint on three tracks that all reach zero on the same frame just to fade
  // corruption out, and one that missed by a frame leaves a tear standing in a clean
  // plate. The master is the fade, and these say what a full one means.
  //
  // **Four of the five defaults are exactly the literals they replaced, and the fifth is
  // not.** That is the rule the readings' seven constants are held to and it is
  // load-bearing the same way here, so the exception matters: 0.45, 0.45, 12 and 7 are the
  // numbers the shader already had, and `glitchTint` is 1.8 where the old line baked 3.0.
  //
  // This sentence used to claim all five without naming an exception, with the
  // enumeration above listing precisely the four that hold - which is the shape of error
  // `CLAUDE.md` rule 5 describes, an object every observation skips behind a justification
  // that stops anybody looking twice. So `blackwall.json`, which names `glitch: 0.18` and
  // no tint, does *not* draw the picture it drew: its tear flares dimmer. The flare's move
  // out of the Blackwall branch - which is in `web/cloud-shader.js` now, and was a
  // thousand-odd lines above this even before it left the file - is a deliberate change on
  // top of that; this one was not deliberate.
  glitch: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'glitch', label: 'amount',
    apply: (v) => { uniforms.glitch.value = v; } },
  // How much of the frame tears at a full master, as a fraction of the bands. The
  // shove's other half: this one is how *often* the feed fails and the next is how
  // badly, and the two were the same number until now.
  glitchDensity: { def: 0.45, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'glitch', label: 'density',
    apply: (v) => { uniforms.glitchDensity.value = v; } },
  // Metres a band travels at a full master, half of it either way. World units like
  // the turbulence field and unlike every screen-space term here, because a tear is a
  // distance in the room: the same look draws the same shear at any output size, and a
  // shove referred to 1080p would change how far the feed failed when you exported.
  glitchShove: { def: 0.45, min: 0, max: 2, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'glitch', label: 'shove m',
    apply: (v) => { uniforms.glitchShove.value = v; } },
  // What a torn band flares, per metre it was shoved. Deliberately per metre rather
  // than normalised against `glitchShove`, so a bigger tear burns harder on its own -
  // the alternative decouples them and then wants a second slider to couple them back.
  // The default is not the 3.0 the literal was, and the arithmetic says what it is
  // instead. Inside the Blackwall branch the flare was added to `bw` and then scaled by
  // that reading's `0.55 + 0.75 * lum` on the way out, so the tint reproducing the old
  // picture is `3.0 * (0.55 + 0.75 * lum)` over the torn pixels: 1.65 where a tear falls
  // on black, 2.10 at a luminance of 0.2, 3.0 only where it crosses something as bright
  // as 0.6. Which end of that applies is a fact about the footage rather than about the
  // shader, and this look is graded for rooms shot dark - `docs/reference.md` says the
  // sample was shot unlit and that colour "reads a signal the sensor barely produced" -
  // so the torn bands land near the bottom of the range and 1.8 is the match at a
  // luminance of about 0.07.
  //
  // Stated as arithmetic and not as an A/B of rendered frames, deliberately, because at
  // the value anything ships with the choice barely resolves: `blackwall.json` asks for
  // a master of 0.18, where the largest shove is 8.1cm and the whole flare spans 0.13 to
  // 0.19 across that entire luminance range. It is at a full master that the end of the
  // range starts to matter, and a full master is a slider anybody setting it is watching.
  glitchTint: { def: 1.8, min: 0, max: 8, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'glitch', label: 'flare',
    apply: (v) => { uniforms.glitchTint.value = v; } },
  // Depth-image rows per band, so the count of bands is 424 over this - 35 of them at
  // the default. Rows and not a fraction of the frame, because a band is a run of the
  // sensor's own scanlines and that is what makes the tear read as the feed failing
  // rather than as a shape drawn over the picture.
  glitchBands: { def: 12, min: 1, max: 64, step: 1, kind: 'scalar', tag: 'look',
    group: 'glitch', label: 'band rows',
    apply: (v) => { uniforms.glitchBands.value = v; } },
  // Which way the bands run, from the sensor's rows at 0 to its columns at 1, and the
  // interesting looks are the fractions in between where the bands cross the frame on a
  // diagonal. The axis was baked as `position.y` from the first version of this effect,
  // which is why the default is 0 and why it has to be exactly 0: a document written
  // before this control existed names no axis and has to keep tearing along rows.
  //
  // A blend of the two image axes rather than an angle in degrees, and that is the honest
  // spelling rather than a lazy one. The bands are quantised in the *sensor's* frame,
  // where the two axes are 512 columns against 424 rows and a band is a run of scanlines
  // rather than a distance - so there is no square in which an angle would mean what an
  // angle means, and a raster's `scanAngle` two hundred lines down is the term that has
  // one because it runs in screen space where the pixels are square.
  //
  // No shear parameter to go with it. The tear's direction stays sensor-frame x, so
  // turning the axis rotates which bands are chosen and not which way they slide, and the
  // pair of controls that would let those disagree buys a look nothing in the references
  // shows and two more ways to author something incoherent.
  glitchAxis: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'glitch', label: 'axis',
    apply: (v) => { uniforms.glitchAxis.value = v; } },
  // Hertz: how often the torn set is redrawn, 7 by default, so a state holds for 143ms
  // or about 4.3 frames at 30fps. The phase is `floor(time * rate)` and stays a pure
  // function of program time - integrating a rate for a smoother phase would make the
  // frame depend on how the playhead got there, and seek-equals-playback dies the
  // moment it does. Keyframing the rate therefore jumps the pattern, which is in genre.
  glitchRate: { def: 7, min: 0, max: 30, step: 0.5, kind: 'scalar', tag: 'look',
    group: 'glitch', label: 'rate hz',
    apply: (v) => { uniforms.glitchRate.value = v; } },

  // One region, authored once and read three ways. Three scalars rather than a new
  // `point` kind, which is the awkward part and is deliberate: the design doc argues
  // composition is edited in the world because a position judged one component at a
  // time is not judged at all, and that argument is about a camera *move*. A static
  // blob you can see in the viewport is the weaker case, and three sliders keep it
  // consistent with every other look parameter and let you type a number. An in-world
  // handle is the follow-on, and it wants a `point` kind to key against.
  //
  // Tagged `look` and take-specific in exactly the way `near`/`far` are - they shape
  // the image, but the right value depends on where the subject actually stood - which
  // the preset path already handles by selecting parameters individually rather than
  // taking a whole tag.
  regionX: { def: 0, min: -3, max: 3, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'region', label: 'x',
    apply: (v) => { uniforms.regionCentre.value.x = v; } },
  regionY: { def: 0, min: -3, max: 3, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'region', label: 'y',
    apply: (v) => { uniforms.regionCentre.value.y = v; } },
  regionZ: { def: -2, min: -6, max: 0, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'region', label: 'z',
    apply: (v) => { uniforms.regionCentre.value.z = v; } },
  regionW: { def: 0, min: 0, max: 3, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'region', label: 'width',
    apply: (v) => { uniforms.regionHalf.value.x = v; } },
  regionH: { def: 0, min: 0, max: 3, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'region', label: 'height',
    apply: (v) => { uniforms.regionHalf.value.y = v; } },
  regionD: { def: 0, min: 0, max: 3, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'region', label: 'depth',
    apply: (v) => { uniforms.regionHalf.value.z = v; } },
  regionRound: { def: 0.5, min: 0, max: 2, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'region', label: 'radius',
    apply: (v) => { uniforms.regionRound.value = v; } },
  regionSoft: { def: 0.2, min: 0.01, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'region', label: 'falloff',
    apply: (v) => { uniforms.regionSoft.value = v; } },

  // The three effects. Push and mask are signed because both questions have two
  // answers - bulge or pinch, hide the inside or hide everything else - and a sign is
  // one slider where a direction toggle would be a second parameter that cannot lerp.
  regionPush: { def: 0, min: -1, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'region', label: 'push',
    apply: (v) => { uniforms.regionPush.value = v; } },
  regionNoise: { def: 0, min: 0, max: 1, step: 0.005, kind: 'scalar', tag: 'look',
    group: 'region', label: 'scramble',
    apply: (v) => { uniforms.regionNoise.value = v; } },
  regionMask: { def: 0, min: -1, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'region', label: 'mask',
    apply: (v) => { uniforms.regionMask.value = v; } },
  // The region read a fourth way, after displacing, scrambling and masking: a wave
  // travelling out along the radius, in metres at a full weight. Non-negative, unlike the
  // push and the mask beside it, because the phase is what a sign would invert and the
  // wave already visits both directions every cycle - a negative amplitude would be a
  // second spelling of a shift the frequency can already reach.
  ripple: { def: 0, min: 0, max: 0.5, step: 0.005, kind: 'scalar', tag: 'look',
    group: 'region', label: 'ripple m',
    apply: (v) => { uniforms.ripple.value = v; } },
  // Cycles per metre of radius, so the wave's spacing is a distance in the room.
  rippleFreq: { def: 4, min: 0.2, max: 20, step: 0.1, kind: 'scalar', tag: 'look',
    group: 'region', label: 'ripple per m',
    apply: (v) => { uniforms.rippleFreq.value = v; } },
  // Cycles per second, and it advances in eighths of one rather than smoothly - the block
  // says why. Zero freezes the wave where it stands instead of switching it off, which is
  // the state `glitchRate` reaches the same way and for the same reason: a held shape is
  // a different picture from no shape, and both keyframe.
  rippleSpeed: { def: 1, min: 0, max: 8, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'region', label: 'ripple hz',
    apply: (v) => { uniforms.rippleSpeed.value = v; } },
  // Still what it always was - orbit the view you are looking at - and still view
  // state rather than an edit: the controls advance it on the program delta the
  // render loop hands them, so the same orbit renders the same way at any output
  // frame rate and holds still when the stream stalls.
  spin: { def: false, kind: 'step', tag: 'view',
    group: 'viewer', label: 'auto-orbit',
    apply: (on) => { controls.autoRotate = on; } },

  // The five readings of the take. These were a `mode` - an integer uniform with five
  // hardcoded shader branches, held outside the registry on the argument that
  // selecting one rewrote twelve other look values and so a mode key would stomp
  // every other track at the instant it fired. That argument was about the bundling
  // rather than about the reading: `setMode(4)` applied a hardcoded BLACKWALL preset
  // on the way past, which is why picking a reading and picking a look were the same
  // gesture and neither could be had without the other. Unbundled, the objection goes
  // with it, and what is left is five ordinary scalars.
  //
  // Which is what `thermal` and `edges` below already argued for in this same file:
  // continuous rather than another branch, because a shading idea expressed as a mode
  // is refused during evaluation as a user action and can therefore never move under
  // the playhead. A clip can now dissolve from Depth into Blackwall, which is the
  // capability the mode's existence was costing.
  //
  // They mix rather than exclude - the shader normalises by their sum - so `readRgb`
  // at 0.6 against `readDepth` at 0.4 is a 60/40 blend of the camera image and the
  // range ramp, and there is no separate source selector because there is nothing
  // left for one to do.
  // `reading: true` marks them as a set the rest of the program can ask for, rather
  // than leaving five names to be spelled out again wherever the set is needed. A
  // sixth reading added below is in that set by existing, which is the difference
  // between enumerating and listing - and this file has been bitten by the listing
  // version often enough to be worth the one extra field.
  readRgb: { def: 1, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look', reading: true,
    group: 'colour', label: 'colour',
    apply: (v) => { uniforms.readRgb.value = v; } },
  readDepth: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look', reading: true,
    group: 'colour', label: 'depth',
    apply: (v) => { uniforms.readDepth.value = v; } },
  readGhost: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look', reading: true,
    group: 'style', label: 'ghost',
    apply: (v) => { uniforms.readGhost.value = v; } },
  readContour: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look', reading: true,
    group: 'style', label: 'contour',
    apply: (v) => { uniforms.readContour.value = v; } },
  readBlackwall: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look', reading: true,
    group: 'style', label: 'blackwall',
    apply: (v) => { uniforms.readBlackwall.value = v; } },

  // The seven constants each reading was built out of. Every default is exactly the
  // literal it replaces, and that is not tidiness: `registry-check --against` is pinned
  // to the commit before the readings existed and hashes each reading at 1.0 against
  // the mode it replaced, forever. So a default that drifted off its literal fails as
  // that reading's framebuffer no longer matching a build from before this feature -
  // which is a far sharper signal than any threshold on a tile mean, and it is why
  // these are declared as the numbers they were rather than as numbers somebody liked.
  //
  // They are per-reading on purpose, against the rule two paragraphs of the fragment
  // shader make for `thermal` and `edges`: those two sit after the blend because they
  // are ideas about a picture, and a term written into one reading is inert in every
  // other. These seven are not that - a contour band spacing means nothing to the
  // colour reading - so the reachability problem that rule exists to avoid is answered
  // instead by the sweep running with all five readings live at once.
  rgbSaturation: { def: 1, min: 0, max: 2, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'colour', label: 'saturation',
    apply: (v) => { uniforms.rgbSaturation.value = v; } },
  depthGamma: { def: 1, min: 0.25, max: 4, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'colour', label: 'gamma',
    apply: (v) => { uniforms.depthGamma.value = v; } },
  ghostRim: { def: 0.7, min: 0.2, max: 3, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'style', label: 'ghost rim',
    apply: (v) => { uniforms.ghostRim.value = v; } },
  ghostFill: { def: 0.35, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'style', label: 'ghost fill',
    apply: (v) => { uniforms.ghostFill.value = v; } },
  // Bands per metre of depth, so the spacing is a distance in the room rather than a
  // number of stripes across whatever the clip range happens to be - the same reasoning
  // the turbulence field is in cycles per metre for. Its step is 1 because a fraction of
  // a band per metre is not a thing anybody is grading towards.
  contourBands: { def: 12, min: 1, max: 60, step: 1, kind: 'scalar', tag: 'look',
    group: 'style', label: 'bands /m',
    apply: (v) => { uniforms.contourBands.value = v; } },
  // The one parameter here that is not a uniform: it is half the width of the drawn
  // line, and the two band edges are computed from it in double precision on the way
  // through, because doing that subtraction in the shader lands on a different float
  // than the literal it replaces. The arithmetic is stated once, here, so a check can
  // hold the pair against it rather than against a second copy of the sum.
  contourWidth: { def: 0.08, min: 0.01, max: 0.4, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'style', label: 'thickness',
    apply: (v) => { uniforms.contourLo.value = 0.5 - v; uniforms.contourHi.value = 0.5 + v; } },
  blackwallSweep: { def: 0.28, min: 0, max: 2, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'style', label: 'wall sweep',
    apply: (v) => { uniforms.blackwallSweep.value = v; } },

  scan: { def: 0, min: 0, max: 1.5, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'style', label: 'scan',
    apply: (v) => { uniforms.scanAmount.value = v; } },
  rim: { def: 0.55, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'style', label: 'rim',
    apply: (v) => { uniforms.rimAmount.value = v; } },
  // The same argument the readings above were rebuilt on, made here first.
  thermal: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'style', label: 'thermal',
    apply: (v) => { uniforms.thermal.value = v; } },
  edges: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'style', label: 'edges',
    apply: (v) => { uniforms.edges.value = v; } },
  // The duotone: how far the image lands between the two poles, which way they are
  // turned, and where they meet. Three amounts and no source selector, which is the same
  // argument `thermal` and the readings above are built on - a shading idea expressed as
  // a mode is refused during evaluation as a user action and can therefore never move
  // under the playhead, where three scalars each key like anything else.
  //
  // `duotoneDepth` is an amount rather than a switch for the reason every other term here
  // is one: a clip brings the tonal transform in and out on one track. It is the term the
  // rest of this look sits on top of, because in the frames this is graded against the
  // light is emitted by the data rather than reflected off surfaces - so the interiors
  // have to fall toward black before a raster over the top reads as a reconstruction
  // instead of as a filter laid over a video.
  duotoneDepth: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'style', label: 'duotone depth',
    apply: (v) => { uniforms.duotoneDepth.value = v; } },
  // Degrees on the slider and radians at the uniform, the way `tilt` and `roll` are, so
  // the panel reads in the unit a person turns a hue in and the shader gets the unit a
  // trigonometric function takes. The full turn either way rather than a half, because
  // the two poles are asymmetric - the near one is nearly black - so +90 and -90 are
  // genuinely different pictures and a half-range would hide one of them.
  duotoneHue: { def: 0, min: -180, max: 180, step: 1, kind: 'scalar', tag: 'look',
    group: 'style', label: 'duotone hue',
    apply: (v) => { uniforms.duotoneHue.value = THREE.MathUtils.degToRad(v); } },
  // Where the poles meet, as a fraction of the near/far clip range. A place in the room
  // rather than a fraction of the frame, which is what lets a subject keep its silhouette
  // when the camera moves - and it is the same reasoning `contourBands` is per metre for.
  duotoneSplit: { def: 0.5, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'style', label: 'duotone split',
    apply: (v) => { uniforms.duotoneSplit.value = v; } },
  // And how many metres the crossing between the poles takes, which is the one term here
  // stated in the room's units rather than as a share of the clip range. The uniform
  // carries why; what belongs beside the entry is the range.
  //
  // The floor is 0.2m rather than zero because zero is a hard edge and the ramp already
  // has one at 0.2 for anything a sensor this noisy can resolve - the jitter is about 4mm
  // per sample, so a crossing inside a couple of centimetres is a threshold with speckle
  // on it rather than a gradient. The ceiling is the full 9.5m the depth sliders reach,
  // so a ramp can always be opened wider than anything the box can hold, which is what
  // "the grade does not follow the framing" has to mean at the top end.
  //
  // **The default is the default clip range, and it is derived rather than typed.** At
  // that value `duotoneSpan / (farClip - nearClip)` is 1.0 on an untouched document and
  // the expression is the one this replaced, term for term - so nine shipped looks and
  // every saved project render what they rendered. Deriving it means the three defaults
  // cannot drift apart silently; it does not make the identity exact on its own, which is
  // why the commit carries hashes rather than this comment carrying an argument.
  duotoneSpan: { def: CLIP_FAR_DEFAULT - CLIP_NEAR_DEFAULT, min: 0.2, max: 9.5, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'style', label: 'duotone span m',
    apply: (v) => { uniforms.duotoneSpan.value = v; } },
  // The fourth of them, and the one that is not a fact about where a point is. It keys
  // the same two poles on how fast a point is moving along the sensor's axis, so a room
  // graded by distance gets whatever is moving through it in the hot pole - which is the
  // one reading the depth key cannot produce, since a subject and the wall behind it are
  // both exactly where they stand.
  //
  // **The speed is measured from the two depth frames the shader already holds and there
  // is no flow pass.** Optical flow would buy lateral motion as well, and it would buy it
  // for a full pass over the frame plus a second history to keep, on a renderer whose
  // whole transport rests on a seek producing the same image playback would - so the pass
  // would have to be walked forward through a pre-roll like the accumulators are, and a
  // scrub would arrive carrying whatever the drag had built. What the depth pair gives is
  // the axial component alone, for one texel fetch that was nearly already there, and
  // axial is the component this look is about: the sensor measures depth, so a subject
  // walking toward it is the movement it can actually see.
  //
  // An amount rather than an amount and a reference speed, on the precedent the poles
  // themselves are baked on: what a look parameterises is how much of a ramp it wants.
  // The shader carries the reference and the measurement behind it.
  duotoneMotion: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'style', label: 'duotone motion',
    apply: (v) => { uniforms.duotoneMotion.value = v; } },
  // Each post pass costs a full-screen read and write whether or not it changes
  // anything, so a zero value switches its pass off rather than running it as a
  // no-op. The three grade terms share one pass, so they gate it together.
  bloom: { def: 0, min: 0, max: 6, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'post', label: 'bloom',
    apply: (v) => { bloom.strength = v; bloom.enabled = v > 0; } },
  trails: { def: 0, min: 0, max: 0.97, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'motion', label: 'trails',
    apply: (v) => { afterimage.uniforms.damp.value = v; afterimage.enabled = v > 0; } },
  rgbSplit: { def: 0, min: 0, max: 6, step: 0.05, kind: 'scalar', tag: 'look',
    group: 'post', label: 'rgb split',
    apply: (v) => { grade.uniforms.rgbSplit.value = v; grade.enabled = gradeNeeded(); } },
  // The raster's master, and the only one of the four that gates the pass. It keeps the
  // name `scanlines`, which now describes one of its settings rather than the whole term:
  // a rename is the one change `registry-check` cannot make bit-exact against its pinned
  // commit, and it would break every preset anybody has authored. Accepted rather than
  // overlooked.
  scanlines: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'raster', label: 'scanlines',
    apply: (v) => { grade.uniforms.scanlines.value = v; grade.enabled = gradeNeeded(); } },
  // The three settings under it, and none of them gates the pass - for `crush`'s reason
  // in the case of the pitch, whose default is 1.3 and so is true of every document there
  // is, and for a plainer one in the case of the other two: raising an angle while the
  // master sits at zero rotates a raster nobody asked for, and switching a full-screen
  // pass on to draw nothing is exactly the no-op the gate exists to refuse.
  //
  // Degrees on the slider and radians at the uniform. The full half-turn either way is
  // the whole of a raster's range, because a line grille at 180 degrees is the grille at
  // 0 - what the sign buys is which way a *rotating* raster turns under the playhead.
  // One parameter, one vec2 uniform, and the trigonometry happens here rather than in
  // the shader. The comment beside the uniform carries the measurement that forced it;
  // what belongs here is that the arithmetic is stated once, in this file, so a check can
  // hold the axis against it rather than against a second copy of the same sum.
  scanAngle: { def: 0, min: -180, max: 180, step: 1, kind: 'scalar', tag: 'look',
    group: 'raster', label: 'angle',
    apply: (v) => {
      const r = THREE.MathUtils.degToRad(v);
      grade.uniforms.scanAxis.value.set(Math.sin(r), Math.cos(r));
    } },
  // Cycles per reference pixel along the raster's own axis, and the default is exactly
  // the literal it replaces.
  //
  // **The useful range runs below the default, not above it**, which is the opposite of
  // what this said when it was written and is worth stating as a correction rather than
  // quietly replacing. The claim was that 1.3 is a television artifact and 6 is the column
  // raster a reference frame gets sliced into. The first half is right and the second is
  // backwards: the wave is expressed against 1080p, so 1.3 is already about 220 cycles
  // across the picture, 6 is nearer a thousand, and a line thinner than the pixel carrying
  // it is not a grille but aliasing. The wide bands the references actually cut a picture
  // into want a pitch under about 0.6. Measured on rendered frames at a fixed pose rather
  // than reasoned about: at 0.1 the bands are wide enough to read across the room, and by
  // 1.0 they have closed up into a scanline again.
  //
  // The old range of 0.1 to 12 in tenths therefore put every value worth having inside its
  // bottom four percent, with six positions to choose between, and spent the rest of the
  // travel past the point where anything is resolvable.
  //
  // **The default has to stay reachable to the exact bit**, because the guard in the grade
  // shader tests this against the literal 1.3 and takes the old code path when it matches.
  // A range input does its stepping in decimal on its own value string, so a minimum of
  // 0.05 with a hundredth step still lands the same double `params.reset()` writes, and
  // every one of the 396 reachable positions round-trips. Checked in a browser rather than
  // reasoned about, because a default that missed by one bit would take the shipped raster
  // off its bit-exact path with nothing anywhere turning red to say so.
  scanPitch: { def: 1.3, min: 0.05, max: 4, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'raster', label: 'pitch',
    apply: (v) => { grade.uniforms.scanPitch.value = v; } },
  // How square the wave is, from the sine it has always been to a hard grille with dark
  // gaps. This is the control that makes the other two reach the look at all - an angle
  // over a sine is rotated softness, and softness is not what the references show.
  scanHard: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'raster', label: 'hardness',
    apply: (v) => { grade.uniforms.scanHard.value = v; } },
  grain: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'post', label: 'grain',
    apply: (v) => { grade.uniforms.grain.value = v; grade.enabled = gradeNeeded(); } },
  // The fifth term that gates the pass, and it gates for the plain reason the other four
  // do rather than as an exception: its default is zero, so a look that never names it
  // pays nothing and the pass stays shut. Contrast `crush` further down, whose default is
  // the literal it replaced and which therefore cannot gate anything without holding the
  // pass open for every look there has ever been.
  streak: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'post', label: 'streak',
    apply: (v) => { grade.uniforms.streak.value = v; grade.enabled = gradeNeeded(); } },
  // Which way the light runs, and this **reverses a decision the code used to state as
  // settled**, which is worth saying plainly rather than leaving as a diff. The gather ran
  // down the column and nothing else, the comment above it said it falls and only falls,
  // and `docs/reference.md` said a control for the direction would be a control for
  // getting it wrong. The argument was that gravity has one direction. It is not a bad
  // argument and it is not the operator's: a smear is a thing a lens and a sensor do, and
  // a light bleeding sideways off a hot edge is in as many reference frames as one running
  // down a column. The old sentences are gone rather than left standing next to the slider
  // that contradicts them.
  //
  // Zero has to be exactly straight down, because a look authored before this control
  // existed names no angle and has to keep the streak it was graded with. The gather's own
  // comment carries the measurement that says it does, to the bit.
  //
  // A full half-turn either way, like the raster's angle and unlike it in what the sign
  // buys: a grille at 180 degrees is the grille at 0, so there the sign only decides which
  // way a rotating raster turns, where here 0 and 180 are opposite directions and both are
  // reachable by two routes. Positive turns the streak clockwise on the glass - 90 puts it
  // across to the left, -90 across to the right - which is the same sense the raster's
  // angle turns in, and it is written down here because it was read off rendered frames
  // rather than derived. One parameter, one vec2 uniform, and the trigonometry happens in
  // this file so a check can hold the axis against the arithmetic stated once rather than
  // against a second copy of the same sum.
  streakAngle: { def: 0, min: -180, max: 180, step: 1, kind: 'scalar', tag: 'look',
    group: 'post', label: 'streak angle',
    apply: (v) => {
      const r = THREE.MathUtils.degToRad(v);
      grade.uniforms.streakAxis.value.set(Math.sin(r), Math.cos(r));
    } },
  // The corner falloff, which was a literal inside the grade shader and so arrived with
  // whichever of the three above you happened to raise. The uniform beside it carries
  // why this is the one promoted literal that does not keep its old value; what belongs
  // here is that it gates the pass like the other three, so the vignette can be had on
  // its own and a look wanting none of the four still pays for no pass at all.
  vignette: { def: 0, min: 0, max: 1, step: 0.01, kind: 'scalar', tag: 'look',
    group: 'post', label: 'vignette',
    apply: (v) => { grade.uniforms.vignette.value = v; grade.enabled = gradeNeeded(); } },
  // The toe under the grade's Reinhard curve, and **the one term sharing that pass which
  // deliberately does not gate it** - note the missing `grade.enabled` beside the four
  // above. That is the whole of its wiring and it is worth the paragraph, because the
  // symmetry is the thing a reader will reach to restore.
  //
  // Its default is the literal it replaces, so gating on it would be gating on
  // `0.018 > 0`: the pass held open for every look there has ever been, the four shipped
  // presets that ask for no grade at all suddenly paying a full-screen read and write and
  // drawing a tone curve they were never graded through, and `registry-check` red on all
  // five readings at once against a build from before any of this existed. `vignette`
  // escaped the same trap in the other direction, by defaulting to 0 because no single
  // default reproduces the conditional it replaced. `crush` has no such escape - its old
  // behaviour is a constant, and the constant is not zero.
  //
  // What that costs is honest and small: the toe is reachable only while some other term
  // is holding the pass open, exactly as it was when it was a literal. The drop-one sweep
  // still sees it, because `SCRAMBLE` has the grade up.
  crush: { def: 0.018, min: 0, max: 0.2, step: 0.001, kind: 'scalar', tag: 'look',
    group: 'post', label: 'crush',
    apply: (v) => { grade.uniforms.crush.value = v; } },

  denoise: { def: true, kind: 'step', tag: 'look',
    group: 'signal', label: 'cull speckle',
    apply: (on) => { uniforms.denoise.value = on ? 1 : 0; } },
  edgeTol: { def: 120, min: 10, max: 1200, step: 10, kind: 'scalar', tag: 'look',
    group: 'signal', label: 'edge tol',
    apply: (v) => { uniforms.edgeTol.value = v; } },
  renderScale: { def: 100, min: 40, max: 200, step: 5, kind: 'scalar', tag: 'view',
    group: 'viewer', label: 'render %',
    apply: (v) => { renderScale = v / 100; resize(); } },

  // The one composition parameter, and the only pose. The camera track reads its
  // kind off this entry rather than off a second table beside the path editor, and
  // the render path writes the evaluated pose through the same door every other
  // value goes through. Composition is edited in the world rather than on a
  // slider, which is why it is the one parameter with no `group` and no `label`:
  // the generator below builds a row for every parameter that names a group, so
  // naming none is how this one stays off the panel. The buttons that key it live
  // in a hand-written group and are not named after it.
  camera: { def: DEFAULT_POSE, kind: 'pose', tag: 'composition',
    apply: (p) => {
      programCamera.position.fromArray(p.position);
      programCamera.quaternion.fromArray(p.quaternion);
      if (programCamera.fov !== p.fov) {
        programCamera.fov = p.fov;
        programCamera.updateProjectionMatrix();
      }
    } },
};

// The readings, read off the registry rather than written down a second time. Every
// use of the set - the shader's uniforms, the panel group, the sweep arms a proof
// tool builds - goes through this, so adding a sixth reading means adding one
// registry entry and nothing else discovers it late.
const READINGS = Object.keys(PARAMS).filter((n) => PARAMS[n].reading);

/**
 * Which of the five readings a document does not name, asked at both doors a document
 * arrives through and answered differently by them.
 *
 * A project is refused for missing any of them, because `serialiseProjectBody` writes
 * the whole look tag every time and a project that is short of one is truncated. A
 * preset is refused only for missing *some* of them, because a preset may deliberately
 * be about part of a look - see `refusePresetBody` for why naming none is a scope and
 * naming two is a blend nobody authored. The count is the same question; what differs
 * is what each kind of document is allowed to leave out, which is a fact about the two
 * doors rather than about this list.
 *
 * **The defaults are what make a partial document dangerous rather than incomplete.**
 * Every loader resets to defaults first so that a key a file omits means the default
 * instead of whatever the session left behind - and `readRgb` defaults to 1, so a
 * project naming only `readBlackwall: 1` does not load as Blackwall. It loads as a
 * 50/50 blend of Blackwall and the camera image, and one naming no reading at all
 * loads as RGB. That is `format.js`'s whole argument for why version 3 is refused,
 * reappearing inside a document that passes the version gate: a look rendering as
 * something nobody authored, silently.
 *
 * Derived from the `reading` flag rather than listed, so a sixth reading is required
 * here by existing. Everything that writes either kind of document writes all five -
 * `serialiseProjectBody` and `presetFromCurrentLook` both go through the whole look
 * tag, and the converter emits them - so a document missing them is hand-made or
 * truncated, and neither is a thing to guess at.
 */
function missingReadings(values) {
  return READINGS.filter((n) => !Object.hasOwn(values, n));
}

// Each reading needs a uniform of its own name, and the two are now written in different
// files - the registry here, the shader source in `web/cloud-shader.js` - so nothing about
// reading one puts the other in front of you. A reading declared in the registry with no
// uniform behind it would fail as a slider that moves nothing rather than as an
// error. That is the shape this file keeps rejecting - a control that appears to
// work - so it is an assertion, on the same reasoning as the age ceiling below.
for (const name of READINGS) {
  if (!Object.hasOwn(uniforms, name)) {
    throw new Error(`the reading ${name} has no uniform: its slider would move nothing`);
  }
}

// The surface memory's age ceiling has to cover the longest persistence the two
// sliders can ask for, or a ray that stops swapping pins its age below its own
// life and sheds forever. The ceiling and the refusal about it are the memory's, so
// what happens here is the registry handing over the one number only it can compute -
// and it happens here rather than at the memory's own banner because `PARAMS` is
// declared above this line and not above that one.
refuseAgeCeiling((PARAMS.fade.max + PARAMS.wake.max) / 1000);

// Range inputs snap to their step grid and clamp to their bounds, and the registry
// has to do the same arithmetic rather than lean on the DOM for it - otherwise a
// value set headlessly lands on the uniform unsnapped while the same value set
// through a slider lands snapped, and two runs of the same project disagree by a
// hair for reasons nothing records.
const decimalsOf = (x) => {
  const dot = String(x).indexOf('.');
  return dot < 0 ? 0 : String(x).length - dot - 1;
};

// Every value is checked for what it is rather than coerced into something. The
// callers that matter are not the sliders - those hand over exactly what the
// registry declared - but `params.apply(JSON.parse(projectFile))` and step 5's
// track output, and there the quiet coercions are the dangerous ones. `Number(null)`
// and `Number('')` are both a finite 0, so a truncated project would restore a
// zeroed look and say nothing, while `Number('abc')` on the very next key throws:
// the same corruption failing two different ways is worse than either. `!!value`
// has the mirror problem, turning the string "false" into true. So a scalar takes
// a number, a step takes a boolean, and anything else is a loud error at the point
// the bad value arrives instead of a wrong image somewhere downstream.
function normalise(name, spec, value) {
  if (spec.kind === 'pose') {
    // Shape alone is not enough. A short position array slices to a short array,
    // `fromArray` reads past its end and the camera's z becomes NaN; a missing fov
    // stores NaN, and because NaN !== NaN the apply then rewrites the projection
    // matrix every single frame. Live viewing hides all of it, because the next
    // frame overwrites the pose from `programPose(t)` - which is exactly why this
    // has to be caught here rather than when step 5 feeds a curve or a project file
    // through the same door and an export comes out black.
    const finite = (xs, n) => Array.isArray(xs) && xs.length === n && xs.every(Number.isFinite);
    if (!finite(value?.position, 3) || !finite(value?.quaternion, 4) || !Number.isFinite(value?.fov)) {
      throw new Error(
        `${name} is a pose: it needs a 3-number position, a 4-number quaternion and a `
        + `numeric fov, got ${JSON.stringify(value)}`,
      );
    }
    // Closed in step 7, because step 7 is where a hand-edited or truncated project
    // file arrives. Four finite numbers is not a rotation: a quaternion that is not
    // of unit length reaches the camera, where three renormalises on some paths and
    // not others, and where slerping between one unit and one non-unit quaternion
    // is not the rotation either of them names - so a camera move authored between
    // two such keys renders a path nobody drew, and nothing in the console says so.
    //
    // Refused rather than renormalised, which is the same call every other branch
    // here makes. A quaternion 12% long is not a rotation with a scale attached, it
    // is a number nobody meant, and quietly normalising it would produce *an*
    // orientation and hide the fact that the file is damaged.
    //
    // The tolerance is four orders of magnitude looser than the error a real
    // quaternion carries. Three's own output is unit to about 1e-7 and a project
    // round-trips it through full-precision JSON, so 1e-3 has never been near a
    // live value - while the shapes this is for, a truncated component or a hand
    // -typed axis, miss by tenths.
    const len = Math.hypot(...value.quaternion);
    if (Math.abs(len - 1) > 1e-3) {
      throw new Error(
        `${name} has a quaternion of length ${len.toFixed(6)}: a rotation is unit length, `
        + `and interpolating through [${value.quaternion.join(', ')}] would render a `
        + 'camera move nobody authored',
      );
    }
    return {
      position: value.position.slice(),
      quaternion: value.quaternion.slice(),
      fov: value.fov,
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
  const clamped = Math.min(spec.max, Math.max(spec.min, v));
  const snapped = spec.min + Math.round((clamped - spec.min) / spec.step) * spec.step;
  const decimals = Math.max(decimalsOf(spec.min), decimalsOf(spec.step));
  return Math.min(spec.max, Math.max(spec.min, Number(snapped.toFixed(decimals))));
}

const values = new Map();
const panelControls = new Map();
// Declared up here beside `panelControls` rather than down with the button that fills
// it, because `writeControl` reads it and `params.set` calls `writeControl` while the
// registry is being seeded - long before the panel generator further down has run. A
// `const` read before its own declaration is a TDZ error rather than an empty map, so
// the map that gets read during boot has to be declared where boot can already see it.
const resetButtons = new Map();

/**
 * What a reset puts back, asked of the same function that decides what `set` stores.
 *
 * Not the registry's `def` literal. `set` puts every value through `normalise`, which
 * clamps to the bounds and snaps to the step grid, and several defaults do not survive
 * that untouched - `rim` is declared `0.55` against a `0.01` step and `exposure` `1.15`
 * against `0.05`. Comparing a stored value against the raw literal would report a row as
 * modified while it sits exactly where a reset would leave it, so the row would offer to
 * revert a parameter already on its default and go on offering after the press. One
 * function deciding both what gets stored and what "default" means is the only shape in
 * which those two cannot drift apart.
 */
function resetTarget(name) {
  const spec = specOf(name);
  return normalise(name, spec, spec.def);
}

/**
 * Whether this row is offering a reset, re-derived from the write that moved the value.
 *
 * The state is read off the registry every time rather than remembered beside it. A
 * boolean kept here would be a second answer to "has this parameter been moved", and the
 * registry is reached by presets, by project files, by undo and by step 5's tracks as
 * well as by the slider - so a remembered flag would be right only for the writes that
 * happened to go through the panel, and silently wrong for every other door.
 */
function refreshReset(name, value) {
  const button = resetButtons.get(name);
  if (!button) return;
  const modified = value !== resetTarget(name);
  button.dataset.modified = modified ? 'yes' : 'no';
  // `disabled` rather than `hidden`, and the CSS hides it by visibility: the slot is
  // reserved whether or not the control occupies it, so a row does not change width the
  // moment a parameter leaves its default. A row that reflows under the pointer is how a
  // drag that began on a slider ends on the control that slid into its place.
  button.disabled = !modified;
}

function writeControl(name, value) {
  const el = panelControls.get(name);
  if (!el) return;
  if (el.type === 'checkbox') {
    el.checked = value;
  } else {
    el.value = String(value);
    // Read the value back off the element rather than formatting the number here,
    // so the readout says exactly what the slider says even if they ever disagree.
    const out = el.parentElement.querySelector('output');
    if (out) out.textContent = el.value;
  }
  // Refreshed here for the reason `writeControl` exists at all: this is the one place a
  // scalar's shown state is brought level with the registry, so a reset offered on a row
  // whose value has gone back to its default would be the panel and the registry
  // disagreeing about what modified means. Every door into the registry ends up on this
  // line, which is what makes a preset and an undo move the control as surely as a drag.
  refreshReset(name, value);
}

// Announced after every registry write, so whatever is showing the image can
// rebuild it. Live viewing needs nothing here - it renders every frame anyway -
// which is why this starts as a no-op and the timeline installs itself into it
// rather than the registry knowing a transport exists. Assigned rather than a
// subscriber list because there is one consumer and inventing a fan-out for it
// would be machinery for a problem nobody has.
let paramWritten = () => {};

// The other announcement a write has to make, and it is separate from the one above
// because it has a second sender: whether a panel group is worth showing is decided by
// a parameter's value *and* by whether it carries keys, so a track appearing has to
// reach this too and a track appearing is not a registry write.
//
// A no-op that gets replaced, like `paramWritten`, and here that shape is load-bearing
// rather than stylistic. The predicate reads `tracks`, which is declared several hundred
// lines below this - so `params.reset()` further down, which writes every parameter
// while the module is still evaluating, would reach `tracks` in its temporal dead zone
// and throw. A module that throws while evaluating publishes no `__kinect` at all, so
// every proof tool in the suite reports DID NOT RUN and the exit code has no assertion
// behind it, which is the outcome this repo has twice written down as a bug found.
let groupRevealChanged = () => {};

// Registry writes the transport makes on its own behalf, rather than on a user's: the
// camera pose every render poses, and the three parameters a draft borrows for one frame
// and hands back. Neither may ask for a repaint, and neither may re-derive the panel. A
// render that scheduled another render would never stop, and a draft would be chased by
// the accurate seek it exists to postpone - so the drag would pay for both.
//
// This is a separate flag from `evaluating` rather than a widening of it, and the two
// mean different things: `evaluating` says a preset is not a track, this says a write
// came from the renderer rather than from a hand. Nesting is real - a draft's suppression
// spans a render that suppresses in turn - so `withoutRepaint` saves and restores instead
// of clearing.
//
// **Declared up here rather than beside `withoutRepaint`, which is the same dead zone the
// no-op above records and the second time this file has been caught by it.** `params.set`
// consults it now, and `params.reset()` further down writes every parameter while the
// module is still evaluating - so a `let` sitting beside its function four thousand lines
// later is read before it exists, and the page throws during module evaluation. That
// publishes no `__kinect` at all: every tool in the suite reports DID NOT RUN with no
// assertion behind the exit code, measured exactly once and immediately. A flag the
// registry reads is declared before the registry.
let transportWriting = false;

/**
 * The registry's door, and every way in goes through it.
 *
 * **`PARAMS[name]` is not a membership test.** `PARAMS` is an object literal, so it
 * inherits from `Object.prototype` - and `constructor`, `toString`, `valueOf` and
 * `__proto__` all answer something truthy there. Gating on truthiness let every one
 * of those names through where `wibble` was refused, so a project file naming
 * `__proto__` as a track put `__proto__` in `tracks`, `normalise` read `min`, `max`
 * and `step` off a function and made NaN out of undefined, and the page threw
 * somewhere mid-render. That is a failure *inside* the evaluator instead of a
 * decision at the door, which is the entire class of thing the door exists for.
 *
 * `Object.hasOwn` asks the question that was meant: is this one of the parameters
 * this build declares. One helper rather than four spellings of the check, because
 * four spellings is how three of them came to be `PARAMS[name]` and one `name in
 * PARAMS` - which is the same hole written two ways.
 */
function specOf(name) {
  if (!Object.hasOwn(PARAMS, name)) throw new Error(`unknown parameter ${JSON.stringify(name)}`);
  return PARAMS[name];
}

const params = {
  spec(name) {
    const spec = specOf(name);
    return { default: spec.def, min: spec.min, max: spec.max, step: spec.step, kind: spec.kind, tag: spec.tag };
  },
  names(tag) {
    return Object.keys(PARAMS).filter((n) => !tag || PARAMS[n].tag === tag);
  },
  get(name) {
    const spec = specOf(name);
    const v = values.get(name);
    return spec.kind === 'pose' ? { ...v, position: [...v.position], quaternion: [...v.quaternion] } : v;
  },
  /**
   * What `set` would store, without storing it. A key holds a parameter's value,
   * so it has to be the value the parameter would take - a key dragged in a lane
   * and the same value typed into the slider landing a hair apart would be two
   * positions the slider cannot express, differing for a reason nothing records.
   */
  normalise(name, value) {
    return normalise(name, specOf(name), value);
  },
  /** The single write path. Everything - UI, presets, step 5's tracks - goes here. */
  set(name, value) {
    const spec = specOf(name);
    const v = normalise(name, spec, value);
    values.set(name, v);
    spec.apply(v);
    writeControl(name, v);
    // Here rather than at the call sites, for the same reason this is the single
    // write path at all: a preset, a slider, a mode and step 5's tracks all end up
    // on this line, so nothing can change the image without saying that it did.
    paramWritten(name, spec.tag);
    // Beside it rather than folded into it, because the two answer different
    // questions: `paramWritten` is "the image changed, rebuild it", and this is "the
    // evidence a group is in use changed, so re-derive which groups are open". A
    // parameter written back to the value it already held moves the first and not
    // the second, which is why the refresh compares before it touches the panel.
    //
    // Skipped under the same flag `paramWritten` skips under, and for the same reason
    // rather than by analogy: the transport's own writes arrive one per keyed parameter
    // per rendered frame, and every one of them would walk every group's evidence to
    // re-derive a panel the bulk write has not finished changing yet. `withoutRepaint`
    // asks once on the way out, which is the answer for the whole write.
    if (!transportWriting) groupRevealChanged();
    return v;
  },
  /**
   * A bulk write. Guarded, because the note on `evaluating` called this the door
   * the flag did not cover: a preset assembled by hand rather than passed through
   * `applyPreset` used to get no complaint at all. The evaluator writes key by key
   * through `set` and never comes here, so closing this costs it nothing.
   */
  apply(next) {
    refuseDuringEvaluation('a bulk write');
    // **Checked in full before anything is written**, because a bulk write that throws
    // halfway leaves a look nobody authored. `set` writes as it walks, so a hand-edited
    // `{ grain: 0.9, bloom: "loud" }` used to move grain, throw at bloom, and leave the
    // page rendering a document that was reported as refused - and in no undo snapshot
    // either, since the throw goes out past the `history.commit` that would have
    // recorded it. Whatever caught the error then described a file that had already
    // changed the image.
    //
    // `restoreProject` already knew this and pre-walked `params.spec` for it; the fix
    // belongs here instead, because a name that exists is only half the question and
    // every caller of the bulk door has the same problem. `normalise` is exactly "what
    // `set` would store, without storing it", so this is the write's own rule asked
    // early rather than a second opinion that could drift from it.
    //
    // The value is normalised twice on this path, once here and once inside `set`, and
    // that is the price of keeping one write path rather than a bypass that skips the
    // checks by construction. **Measured rather than assumed to be free**, because the
    // repo has already been bitten by a last-bit difference in exactly this arithmetic:
    // every scalar and step parameter swept at 41 points across its range, plus its
    // bounds, its default, two off-grid values and two out-of-range ones - 2408 probes,
    // and `normalise(normalise(x))` is `Object.is`-identical to `normalise(x)` on all of
    // them. `contourWidth` was checked at full precision as well, since it is the one
    // whose band edges are subtracted in double here to land on the float the shader
    // literal had: 0.08 comes back 0.080000000000000001665 both times, and the derived
    // edge 0.41999999999999998446 both times.
    const checked = Object.entries(next).map(([name, value]) => [name, this.normalise(name, value)]);
    for (const [name, value] of checked) this.set(name, value);
    return this;
  },
  /**
   * A plain serialisable object. A project, a preset and an export job all start
   * here, which is why the default selection is document state - look plus
   * composition - and never view. Render scale and auto-orbit belong to whoever is
   * looking rather than to the clip, so an undo snapshot built on a bare `values()`
   * would put them in the document and pressing undo after dropping render scale
   * for performance would put it back: the exact behaviour that teaches people not
   * to trust undo. View state is still reachable, by naming it.
   */
  values(names = this.names().filter((n) => PARAMS[n].tag !== 'view')) {
    return Object.fromEntries(names.map((n) => [n, this.get(n)]));
  },
  /** Defaults, not a serialisation - so this one does cover view state. */
  reset(names = Object.keys(PARAMS)) {
    for (const name of names) this.set(name, PARAMS[name].def);
    return this;
  },
};

// ------------------------------------------------------- the panel, generated
//
// One keyframe control per look parameter, built in the same pass as the row it sits
// in. These two live here rather than beside the rest of the keyframe editor because
// the generator below calls them, and a `const` read before its own declaration is a
// TDZ error rather than a hoisted function - the painting half is still down with the
// lanes, which is where the state it reads comes from.
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

// The reset glyph, drawn as a stroked path rather than set as a background image. The
// panel's controls take their colour from the state around them - dim at rest, brighter
// under the pointer, and gone while the row is on its default - and a background image
// needs one copy of the asset per colour it appears in, which is how the state nobody
// looks at ends up wearing the wrong one. A stroke of `currentColor` is one asset that
// cannot disagree with the rule that coloured it.
function resetGlyph() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // Decorative: the button already carries the whole of what this means in its label,
  // and a screen reader reading the glyph as well would announce the control twice.
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5']) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

/**
 * One reset control per keyframable slider, built in the pass that built the row.
 *
 * It writes through `params.set` and nothing else. A reset that assigned the default
 * straight into the value map would be a second write path around the registry's one
 * door - it would skip `apply`, so the image would keep the old value; it would skip
 * `paramWritten`, so nothing downstream would rebuild; and it would skip the group
 * reveal, so a group open only because this parameter was carrying something would stay
 * open over a parameter that is no longer carrying anything.
 */
function makeResetButton(name) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'reset';
  // The parameter name, so a sweep can credit any row's reset by the attribute instead
  // of naming the rows that have one today - a rule listing the rows that happen to be
  // off their defaults stops covering the row moved tomorrow.
  button.dataset.reset = name;
  button.setAttribute('aria-label', `${name} reset to default`);
  button.append(resetGlyph());
  button.addEventListener('click', () => {
    params.set(name, resetTarget(name));
    history.commit();
    // The press removes its own control: writing the default makes the row unmodified,
    // which takes the button out of the tab order while it is the focused element, and
    // focus falls to the document body with no way back into the panel short of tabbing
    // from the top. It moves to the slider this reset just changed, which is both the
    // control the operator was reasoning about and the one whose value now needs reading.
    const slider = panelControls.get(name);
    slider.focus();
    // And the slider is not always there to take it. `params.set` ends in
    // `groupRevealChanged`, and a collapsible group is open *because* one of its
    // parameters is carrying something - so resetting the last one that was takes away
    // the evidence holding the group open, the group shuts, and `.group.shut` puts
    // `display: none` on every row in it. That happens inside the write above, before
    // the line above this ran, and `focus()` on a node that is not being displayed is a
    // no-op that reports nothing: the caret is left on the body exactly as if this
    // handler had never tried. The group's own toggle is the nearest thing still on
    // screen, and it is what the operator would press to get the row back.
    if (document.activeElement !== slider) {
      const toggle = button.closest('.group')?.querySelector('.grouptoggle');
      if (toggle) toggle.focus();
    }
  });
  // Born closed, the way the keyframe button beside it is born `none`. `params.reset()`
  // runs after this generator and writes every parameter, so the first real answer
  // arrives through `writeControl` before anything is painted - but a control whose
  // state is undefined until some later write is a control that is briefly neither
  // shown nor hidden, and the CSS rule that hides it keys off this attribute.
  button.dataset.modified = 'no';
  button.disabled = true;
  resetButtons.set(name, button);
  return button;
}

// The panel is a view on the registry and holds no parameter data of its own, and it
// is now built from the registry rather than written out beside it. A parameter used
// to cost three edits that had to agree: an entry here, a hand-written row in
// `index.html`, and - for a look parameter on the editor - a keyframe button patched
// onto that row afterwards by a second loop, which lifted a checkbox out of its own
// label to make room. Two places both building a row is the shape this file rejects
// everywhere else, and the boot loop that used to sit here was the evidence: its job
// was to throw when the registry and the markup disagreed. Generate the row and they
// cannot.
//
// What is deliberately *not* generated is everything that is not a parameter. The
// recorder's buttons, the camera group, the sensor and monitor controls and the
// navigation stay in the markup, and the generated groups are inserted around them,
// so the panel's order is the order this table declares rather than an accident of
// two lists being appended.
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

const panelNote = (id, text) => {
  const note = panelNode('div', null, text);
  note.id = id;
  return note;
};

/**
 * One row, in the shape the CSS and every proof tool already expect.
 *
 * The ids, the `.row` wrapper and the `<output>` inside it are load-bearing rather
 * than decorative. `registry-check` builds its view of the panel from `#panel input`
 * keyed by id and from `#panel .row`, and `writeControl` finds a readout by asking
 * the input's parent for one - so a generator that renamed an id, dropped the
 * wrapper or moved the output would empty those maps instead of failing, which is a
 * check that silently stopped looking at anything.
 */
function panelRow(name, spec) {
  const input = document.createElement('input');
  input.id = name;
  if (spec.kind === 'step') {
    input.type = 'checkbox';
    const label = panelNode('label', 'check');
    // The space is the gap the markup carried, and `.check` sets a flex gap on top
    // of it. Kept so the generated row reads exactly as the written one did.
    label.append(input, ` ${spec.label}`);
    return { input, node: label };
  }
  input.type = 'range';
  // Stamped from the registry, because two copies of a slider's bounds is two things
  // to keep in step and the markup copy is the one nothing headless can read.
  input.min = String(spec.min);
  input.max = String(spec.max);
  input.step = String(spec.step);
  const row = panelNode('div', 'row');
  const out = document.createElement('output');
  out.style.cursor = 'pointer';
  // Clicking the readout opens it for direct number entry. The value is clamped to
  // the slider's range on commit, so typing a number outside the range snaps it in.
  out.addEventListener('click', () => {
    const currentValue = out.textContent;
    const edit = document.createElement('input');
    edit.type = 'text';
    edit.value = currentValue;
    edit.style.cssText = 'width: 42px; text-align: right; font: inherit; background: transparent; color: var(--accent); border: 0; outline: 0; padding: 0; margin: 0;';
    // **One way out, and whether it writes is an argument to it.** Escape used to put the
    // output back on its own, which detaches the focused input - and detaching a focused
    // element blurs it, so the blur listener committed the value the press had just
    // cancelled. It left nothing on screen to show for it either: the commit's own
    // `replaceWith` was a no-op against an orphan, so the readout kept the old number
    // while the slider had already been dispatched the new one. Routing both exits
    // through here means the blur a cancel *causes* arrives to find the editor closed.
    let editing = true;
    const close = (write) => {
      if (!editing) return;
      editing = false;
      const parsed = parseFloat(edit.value);
      // Put the output back first so writeControl can find it.
      edit.replaceWith(out);
      if (!write || isNaN(parsed)) return;
      // Clamp to the slider's range.
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

// Where a generated group lands: the grade at the end of the panel body, and
// everything a shooting surface needs above it. Asserted rather than assumed because
// `insertBefore` with a missing anchor appends instead of throwing, so a renamed
// anchor would quietly move every generated group to the bottom of the panel.
function panelAnchor(group) {
  const id = group.lookgroup ? 'gradeAnchor' : 'sensorGroup';
  const anchor = document.getElementById(id);
  if (!anchor) throw new Error(`the panel group ${group.key} has no anchor: no #${id} in the markup`);
  return anchor;
}

// Placing after a fixed anchor reverses what placing before it preserves: each `before`
// against `#sensorGroup` lands under the last one, while each `after` against
// `#gradeAnchor` would land above it and build the grade upside down. So the grade
// walks a cursor - the first group goes after the anchor, every later one after its
// predecessor - and `PANEL_GROUPS` order survives down the panel either way.
const panelTail = new Map();
function panelPlace(group, groupNode) {
  const anchor = panelAnchor(group);
  if (!group.lookgroup) { anchor.before(groupNode); return; }
  (panelTail.get(anchor) || anchor).after(groupNode);
  panelTail.set(anchor, groupNode);
}

// What the collapse rule below needs to find again after this pass has run: the group's
// node, the parameters it emitted rows for, and the two elements in its head that say
// what state it is in. Taken from the pass that *built* the rows rather than from a
// second walk of the registry, because a group revealing itself over a parameter it
// does not show would be a header answering for a control somewhere else - and two walks
// of one table is exactly the drift this generator exists to remove.
const panelGroupNodes = new Map();
const panelGroupParams = new Map();

// One head per group, whether or not the group can be shut, because two shapes of
// header is two sets of CSS and the one that gets forgotten is the one nobody is
// looking at. Only a collapsible group gets a button and a mark inside it.
//
// The heading stays the first element in the head and the only `<label>` there:
// `sensor-view-check` names a group by the text of the first label it can find inside
// it, so a head that put anything labelled ahead of the heading would rename thirteen
// groups at once in a tool that has nothing to do with this feature.
function panelHead(group) {
  const head = panelNode('div', 'grouphead');
  const label = panelNode('label', null, group.label);
  head.append(label);
  if (!group.collapses) return { head, button: null, mark: null };

  // The label is clickable too, so the whole heading row toggles the group rather
  // than only the small triangle. Cursor indicates the affordance.
  label.style.cursor = 'pointer';
  label.addEventListener('click', () => toggleGroup(group.key));

  // A count of the parameters in this group that are carrying something, shown only
  // while the group is shut. Without it a collapsed group in use is the panel lying
  // about what is shaping the frame, which is the exact fear this feature answers,
  // inverted - the values would still be applied to every pixel with nothing on
  // screen saying so.
  const mark = panelNode('span', 'groupmark');
  const button = panelNode('button', 'grouptoggle');
  button.type = 'button';
  // The key rather than a position, and on the button rather than only on the group,
  // so `editor-check`'s sweep can credit *any* group toggle by the attribute instead
  // of naming the four that exist today - a rule listing four ids stops covering the
  // fifth the moment somebody declares `collapses` on another entry.
  button.dataset.groupToggle = group.key;
  button.id = `${group.key}Toggle`;
  button.append(panelNode('i', 'groupchevron'));
  button.addEventListener('click', () => toggleGroup(group.key));
  head.append(mark, button);
  return { head, button, mark };
}

let panelRowsEmitted = 0;
for (const group of PANEL_GROUPS) {
  const groupNode = panelNode('div', group.lookgroup ? 'group lookgroup' : 'group');
  // A data attribute and not an id, because the hand-written groups in the markup
  // are already `#cameraGroup`, `#sensorGroup`, `#monitorGroup`, `#programOutGroup`,
  // and `#recordGroup`, and a generated group minting ids in the same shape is one
  // registry key away from colliding with one of them silently.
  groupNode.dataset.group = group.key;
  groupNode.dataset.panelTab = group.tab;
  // Named apart from the keyframe button the row loop below declares, which is a
  // different button in a narrower scope: one `button` meaning two things in one loop
  // is how the wrong element ends up registered.
  const { head, button: headButton, mark: headMark } = panelHead(group);
  if (group.label || group.collapses) groupNode.append(head);
  if (group.before) groupNode.append(...group.before());
  const names = [];
  panelGroupParams.set(group.key, names);
  if (group.collapses) {
    panelGroupNodes.set(group.key, { group, node: groupNode, button: headButton, mark: headMark });
  }

  let rows = 0;
  for (const [name, spec] of Object.entries(PARAMS)) {
    if (spec.group !== group.key) continue;
    const { input, node: row } = panelRow(name, spec);
    panelControls.set(name, input);
    if (input.type === 'checkbox') {
      // A checkbox has no drag, so its `change` is both the write and the end of the
      // interaction.
      input.addEventListener('change', () => { writeFromControl(name, input.checked); history.commit(); });
    } else {
      // The string-to-number conversion belongs to the control rather than to the
      // registry: a slider's value is text because the DOM says so, and letting that
      // reach `normalise` would mean loosening it for every other caller too.
      input.addEventListener('input', () => writeFromControl(name, Number(input.value)));
      // The other half of the `input`/`change` split, and the whole of what makes
      // undo coalesce: one snapshot when the drag ends rather than one per pointer
      // move. Nothing is pushed if the drag put the value back where it started.
      input.addEventListener('change', () => history.commit());
    }

    // The two controls that ride beside a look row, and **they are gated by different
    // questions**, which is the whole of this block.
    //
    // The keyframe is on the editor alone: a keyframe is a position on a clip, the
    // recorder has no clip, and view state is not part of one - so a control implying
    // otherwise is the split leaking whichever of the two reasons applies.
    //
    // The reset is on both, and it was on neither but the editor because it was written
    // inside the keyframe's condition rather than beside it. Nothing about putting a
    // slider back needs a clip: the recorder grades the live cloud through these same
    // sliders, and having moved one there, the way back was to remember the number.
    // `README.md` describes the ↺ under the recorder's *Look* tab, which is where this
    // was found - the page and the page's own documentation disagreeing about a control,
    // with the condition above naming the reason for the other one.
    if (spec.tag === 'look') {
      const keyButton = EDITING ? makeKeyButton(name) : null;
      // After the keyframe control where there is one, which is the order the design
      // puts them in and the order the row reads in: what this value is, whether it is
      // keyed, and how to put it back.
      const beside = [...(keyButton ? [keyButton] : []), makeResetButton(name)];
      if (input.type === 'checkbox') {
        // The control is the whole `<label class="check">` and a button inside a
        // label would toggle the checkbox when clicked, so the two are siblings in a
        // row of their own.
        const checkrow = panelNode('div', 'checkrow');
        checkrow.append(row, ...beside);
        groupNode.append(checkrow);
      } else {
        row.append(...beside);
        groupNode.append(row);
      }
    } else {
      groupNode.append(row);
    }
    rows++;
    panelRowsEmitted++;
    // The evidence set for this group, recorded here because here is where the row was
    // emitted. A group asks whether anybody has touched it by walking exactly the
    // parameters it put on screen, so the header and the rows under it cannot come to
    // disagree about which parameters the group is.
    names.push(name);
  }
  // A heading with nothing under it is a group key that got misspelled on one side,
  // which is the only way a group can end up empty and is worth a sentence rather
  // than an empty box on the panel.
  if (rows === 0) throw new Error(`the panel group ${group.key} holds no parameter`);

  if (group.after) groupNode.append(...group.after());
  panelPlace(group, groupNode);
}

// The count, asserted rather than inferred - and this is what the old boot loop's
// throw turned into rather than a tidier spelling of it. That loop looked a control
// up by id and threw when it found none, which stops being able to fail the moment
// the same pass creates the control it then looks for: a generator that filtered one
// parameter out would produce a smaller panel that worked perfectly and said nothing.
//
// Counted against the registry from the other side, so a row lost anywhere in the
// loop above - a group key nobody declared, a filter that dropped one, a `continue`
// that ran once too often - is a refusal to boot with both numbers in it. The stray
// check above names the parameter where it can; this one catches the cases that have
// no name to give.
{
  const owned = params.names().filter((n) => PARAMS[n].tag !== 'composition');
  const stray = owned.filter((n) => !PANEL_GROUPS.some((g) => g.key === PARAMS[n].group));
  if (stray.length) {
    throw new Error(`${stray.join(', ')} name no panel group, so the panel would be missing `
      + `${stray.length} of ${owned.length} controls`);
  }
  // Composition is edited in the world - a camera path is the one thing you cannot
  // judge from a graph - so a composition parameter that grew a panel group means the
  // split has been crossed somewhere and is worth stopping over.
  const crossed = params.names('composition').filter((n) => PARAMS[n].group || PARAMS[n].label);
  if (crossed.length) throw new Error(`composition parameter ${crossed.join(', ')} declares a panel group`);
  if (panelRowsEmitted !== owned.length) {
    throw new Error(`the panel generator emitted ${panelRowsEmitted} rows for ${owned.length} `
      + 'parameters: a panel that is not the registry is a look nothing can reach');
  }
}

// The four Pencil inspectors are views over the one registry-built panel. Groups are
// tagged where they are declared above, so adding a parameter to a group inherits its
// inspector without another list of control ids. Hiding never removes a row from the
// document: the registry and proof sweeps still see the complete surface.
const panelTabsEl = document.getElementById('panelTabs');
const panelTabButtons = [...panelTabsEl.querySelectorAll('.paneltab')];
// Default to 'record' on the record surface, 'look' on the editor.
let activePanelTab = EDITING ? 'look' : 'record';

function setPanelTab(tab) {
  if (!['record', 'camera', 'framing', 'look', 'region'].includes(tab)) return false;
  activePanelTab = tab;
  for (const button of panelTabButtons) {
    button.setAttribute('aria-selected', String(button.dataset.panelTab === tab));
  }
  for (const group of document.querySelectorAll('#panelBody > [data-panel-tab]')) {
    group.hidden = group.dataset.panelTab !== tab;
  }
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

// On the record surface, initialize the tabs immediately since they're always visible.
if (!EDITING) setPanelTab(activePanelTab);

params.reset();

// ------------------------------------------------------------------- presets

// Applying a preset is a user action and can never be an evaluation-time effect: a
// look that re-applied itself while the playhead moved would make the timeline lie
// about what it is showing. The render path raises this flag for the length of one
// frame, and the bulk writes a gesture performs refuse while it is up. Ordinary
// parameter writes stay legal, because that is exactly what step 5's tracks do.
//
// What that actually covers, stated plainly so step 5 inherits the problem rather
// than a false sense of having solved it. The flag catches the doors a preset goes
// through - `applyPreset` and `params.apply` - and nothing else. There used to be a
// third, `setMode`, and dissolving the mode into five registry scalars removed it
// rather than leaving it guarded: selecting a reading is now a single `params.set`,
// which is an ordinary write and legal during evaluation precisely because a track
// is allowed to make it. And the flag spans `renderProgramFrame` alone, so an evaluator
// that writes its track values just before calling it is semantically inside
// evaluation with the flag down. Widening it needs the shape of step 5's evaluator
// to be known: the honest boundary is "the evaluator is running", and that object
// does not exist yet.
let evaluating = false;

// `transportWriting` is declared above the registry rather than here, where it would
// otherwise belong: `params.set` reads it and the boot writes run long before this line.
// The note on the declaration carries the rest.
function withoutRepaint(write) {
  const outer = transportWriting;
  transportWriting = true;
  try {
    return write();
  } finally {
    transportWriting = outer;
    // The panel asked once for the whole write rather than once per value in it, and
    // only at the outermost of a nest - a draft's suppression spans a render that
    // suppresses in turn, so an inner `finally` firing here would be the per-write
    // recompute again wearing a different name. This is not the repaint's twin: a
    // repaint is deliberately *not* requested on the way out, because these writes are
    // the renderer's own and asking for another render is the loop the flag exists to
    // stop. Re-deriving which groups are open renders nothing.
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

// The active deliverable holds the export settings (in/out, output size, codec, output
// name). It is separate from the project, so one edit can spawn several deliverables
// without the deliverable state being undoable project state.
//
// **Version 2, and the bump is what `outputFps` leaving costs.** The output rate is the
// project's now, because `trails` is counted in output frames rather than in seconds and
// the same document at two rates is two different looks. A version 1 document naming
// 24fps read by this build would simply not be read - the field is nowhere in the reader
// - and the render would come out at whatever the project says, which is a document that
// parses perfectly and produces the wrong file. That is what a version gate is for, and
// `applyDeliverable` is where it stands.
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
    // Empty rather than the take's id, because the field it feeds treats empty as "use
    // the take's id" and writing that id in would freeze it: a deliverable saved on one
    // take and opened on another would name the first one's footage in the second one's
    // file. `exportBaseName` is where the default is answered, once.
    name: '',
  };
}

function setActiveDeliverable(deliverable) {
  activeDeliverable = deliverable;
}

function applyDeliverable(deliverable) {
  // **Asked before anything is touched, so a document this program cannot read is refused
  // whole rather than half-adopted.** `setClipInOut` below is the door that refuses a
  // bound, and refusing there is what covers the marker drags and the rate rescale too -
  // but by the time it runs, `setActiveDeliverable` has already made this document the
  // active one, so a throw from inside it would leave a refused document's output size
  // and codec sitting on a clip whose cuts it never got to write. Asking the same
  // predicate here first is a second call site rather than a second rule, which is the
  // distinction that matters: there is still one answer to what a clip bound is.
  // The version, asked before the bounds and for the harder reason. A version 1
  // deliverable is the shape this program wrote until the output rate moved onto the
  // project, and every field this reader looks at is still in it - so it would adopt
  // cleanly, drop the 24fps it names on the floor, and render at whatever rate the
  // project happens to hold. A document that parses and produces the wrong file is
  // precisely what a version gate is for, and there is nothing here to convert: the rate
  // it names belongs to a project this deliverable does not know the identity of.
  if (deliverable.version !== DELIVERABLE_VERSION) {
    // **The rate it named is in the message, because it is the only copy left.** Refusing
    // a version 1 document without saying what it held sends the operator to Project
    // settings with nothing to type: the rate lived on the deliverable and nowhere else,
    // the project it belonged to carries no `outputFps` at all, and this build reads that
    // absence as 30. So a 24fps edit whose only record of 24 is the document being refused
    // becomes a 30fps edit silently, and saving the project writes 30 down for good. This
    // cannot migrate it - a deliverable does not know which project it belongs to - but it
    // can hand the number back rather than dropping it on the floor.
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
  // **And the shape, because a deliverable is not allowed to reframe the clip.** This
  // used to reach a setter that wrote the document's own framing from a size the
  // deliverable named - so adopting a stored 1:1 deliverable silently re-composed a
  // 65:24 edit, keys and all. `setDeliverableSize` is what took its place. The split
  // makes the size a choice about pixels only, and that is only true while every size
  // reaching it is of the shape the stage is showing. Refused here rather than corrected,
  // for the reason this function refuses everything else before touching anything: a
  // document naming another shape is from another edit, and quietly snapping it to this
  // one's opening size would lose which size it actually asked for.
  if (!sameAspect(aspectOfSize(deliverable.outputSize), projectAspect)) {
    throw new Error(
      `this deliverable renders ${deliverable.outputSize}, which is not the ${projectAspect.join(':')} `
      + 'this project is framed at: the shape belongs to the edit, so change it in Project settings '
      + 'rather than through a deliverable',
    );
  }
  // Before anything is written, because what follows replaces the cuts and the output
  // size wholesale - see `dropRateGesture` for why this is not `takeTransport`.
  dropRateGesture();
  setActiveDeliverable(deliverable);
  setClipInOut({ in: deliverable.in, out: deliverable.out });
  setDeliverableSize(deliverable.outputSize);
  // The output name travels with the deliverable now, which is what stops two of them
  // writing over each other's file. It has never been persisted anywhere: the field was
  // bare, falling back to the take's id, so every deliverable of one take proposed the
  // same filename and the second render replaced the first in everything but the
  // `<pid>-<seq>` directory. Empty stays empty rather than becoming the take id, because
  // empty is what `exportBaseName` reads as "use the take's id".
  if (ui.exportName) ui.exportName.value = deliverable.name ?? '';
  timingChanged();
  paintDeliverable();
  // The format segments, beside the readout that was already repainted here. They read
  // the codec off the deliverable and are painted nowhere else, so adopting a stored
  // document moved the codec the render will use while the buttons went on showing
  // whichever one was last pressed - the dialog disagreeing with the document about what
  // it is about to encode, in the one direction where the document is right.
  //
  // This is the rule `paintExportFormats` states in its own comment, and the same shape as
  // the reset rows: a control that shows document state has to be repainted by every door
  // into that state, not only by the door it happens to sit next to. A project file, an
  // autosave and this dialog all reach a deliverable, and only one of them is these three
  // buttons.
  paintExportFormats();
  // And the name chip, for the same rule read once more: the name above came off a
  // document rather than out of the field's own `input` event, so nothing else in this
  // program would have asked whether it is a filename.
  paintExportName();
}

/**
 * A trim, written and then told to the rest of the editor: the deliverable it belongs to,
 * the readout beside it, and the transport if the playhead is now outside it.
 *
 * The writing itself is `writeClipRange` in `clip-range.js`, which refuses a bound that is
 * not a time and holds the pair inside the program that is open. What is here is
 * everything that write *means*, and that is the split the two callers need: the marker
 * drags call the module directly while a pointer is down, because a preview must not move
 * the deliverable or seek the transport once per pointer event, and they come here on the
 * release. Both reach the same arithmetic, which is the whole point of it being reachable.
 */
function setClipInOut(values) {
  // `null` rather than a duration when nothing is open, because the trim is held inside
  // the program and there is no program yet - a zero would collapse both bounds to it.
  writeClipRange(values, timeline ? timeline.duration : null);
  ensureActiveDeliverable();
  activeDeliverable.in = clipIn;
  activeDeliverable.out = clipOut;
  paintDeliverable();
  if (timeline) {
    // **Compared on the output grid, because that is the only place the playhead can be.**
    // `programSec` is a frame divided by the rate, and a boundary is a float - so after a
    // speed change rescales the cuts, a playhead that was sitting exactly on `clipIn` can
    // land a fraction of a frame outside the rescaled one and read as out of range. From
    // 10s at 1x to 2.3x the boundary becomes 4.3478s and the nearest frame is 130 at
    // 4.3333s: outside by 14ms, which buys a full accurate seek. Per `input` event, that
    // is the seek storm this control was rewritten to avoid, coming back through the one
    // case the count probe cannot see - it parks the playhead in the interior.
    //
    // Nothing is lost by comparing frames: a boundary between two frames is a boundary
    // the transport cannot show either side of, so "outside by less than a frame" is a
    // distinction with no picture attached.
    const frameIn = timeline.frameOf(clipIn);
    const frameOut = clipOut === null ? null : timeline.frameOf(clipOut);
    if (timeline.frame < frameIn) timeline.seek(clipIn).catch(showTimelineError);
    else if (frameOut !== null && timeline.frame > frameOut) timeline.seek(clipOut).catch(showTimelineError);
    else timeline.paint();
  }
}

// There is no `setMode` any more, and nothing replaced it. Selecting a reading is
// writing `readDepth` - an ordinary registry write, through the one door every other
// parameter goes through, which repaints and snapshots for undo the way a slider
// does. The reason the old one existed at all was that a mode was the only thing
// that could change the image without the registry announcing it.

// ------------------------------------------------------------ keyframe tracks

// A track is keys on a registry parameter, stamped in program time. The kind is
// read off the registry entry rather than declared again here, because two tables
// that can disagree is exactly what the registry was built to remove - `wake`
// being a scalar in one of them and a step in the other is a bug nothing would
// catch until an export.
//
// Three kinds, and each is a different answer to "what is between two keys":
//
//   scalar  a cubic ease from one value to the next. The two handles are the same
//           unit square CSS `cubic-bezier` uses, so the pair (1/3,1/3),(2/3,2/3)
//           is exactly linear and every other pair bends the *timing* without
//           moving either value.
//   step    the earlier value, held. A checkbox has nothing between true and
//           false, and half a segment spent at 0.5 would be refused by
//           `normalise` anyway - loudly, in the middle of a render.
//   pose    position, orientation and field of view moving together. Position
//           runs a Catmull-Rom through the keys, because a camera cornering on
//           straight lines reads as a mistake rather than as a move; orientation
//           slerps, and fov lerps. All three read the same eased fraction the
//           scalars do, so the handles shape *when* the camera gets where it is
//           going and never the route it takes - see `poseAt`.

// The scalar curve maths moved to `curve.js`; the pose track below still needs
// three.js and stays here.
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
  // The ease handles, and they are what make this a *timing* control rather than a
  // second path editor. `easeAt` remaps how far through the segment we are and
  // nothing else, so the Catmull-Rom through the keys is the same curve and only the
  // rate along it changes. That is the whole reason composition can have this without
  // getting the graph the design deliberately keeps it off: you still cannot judge a
  // camera move from a lane, and the lane is no longer being asked to show you one.
  //
  // All three channels read the remapped value because `u` is computed once. Easing
  // position alone would slide the camera along a path it is no longer aimed down,
  // and it is also the only thing short of squad interpolation that softens the
  // quaternion's corner at a key - `smooth` handles bring du/dt to zero there, so the
  // slerp's rate arrives and leaves at nothing instead of stepping.
  //
  // Measured, because the default has to be the old behaviour rather than nearly it:
  // with the linear handles every key is created with, this is the identity to within
  // one ulp - worst |easeAt(u) - u| over 100,001 samples is 1.665e-16, exact at both
  // ends, 58,363 of them bit-identical - so a project saved before this existed
  // renders as it did. There is deliberately no short-circuit for that case. A second
  // path past this line is a second thing to keep in step, which is the trade this
  // design keeps refusing, and 1.665e-16 does not buy one.
  const u = easeAt(a.easeOut, b.easeIn, (t - a.t) / span);

  const position = [0, 1, 2].map((axis) => hermite(
    a.value.position[axis], b.value.position[axis],
    tangentAt(keys, i, axis), tangentAt(keys, i + 1, axis),
    span, u,
  ));

  // Slerp rather than a Catmull-Rom through the quaternions. The spec asks for the
  // spline on position, and it asks for it there because that is where a straight
  // line is visible as a corner; an orientation between two keys has no such
  // corner to round off, and a spline through four quaternions can leave the unit
  // sphere in ways that read as a roll nobody keyed.
  slerpA.fromArray(a.value.quaternion);
  slerpB.fromArray(b.value.quaternion);
  slerpA.slerp(slerpB, u);

  return {
    position,
    quaternion: slerpA.toArray(),
    fov: a.value.fov + (b.value.fov - a.value.fov) * u,
  };
}

class Track {
  constructor(name) {
    this.name = name;
    // Off the registry, never declared here. See the note above.
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
    if (this.kind === 'pose') return poseAt(this.keys, t);
    return scalarAt(this.keys, t, HOLD_ENDS);
  }

  serialise() {
    return this.keys.map((k) => ({
      t: k.t, value: k.value, easeOut: copyHandle(k.easeOut), easeIn: copyHandle(k.easeIn),
    }));
  }
}

// Only tracks that carry keys exist. An empty track is a parameter with a single
// value, which the registry already holds, and keeping one per parameter would
// mean the lane list and the track list had to be filtered into agreement
// everywhere instead of being the same list.
const tracks = new Map();

function trackFor(name) {
  let track = tracks.get(name);
  if (!track) {
    track = new Track(name);
    tracks.set(name, track);
  }
  return track;
}

function dropTrackIfEmpty(name) {
  const track = tracks.get(name);
  if (track && track.keys.length === 0) tracks.delete(name);
}

// ------------------------------------------------- which panel groups are open
//
// Whether a group is open is *derived from the document*, and only a disagreement is
// stored. The alternative - a stored open/closed flag per group - is a second copy of
// something the values already say, and a second copy drifts: a look applied from the
// library would put values into three groups and leave all three shut, because nothing
// in a preset knows about panel furniture. Deriving means the panel opens at whatever
// the clip is actually using without anybody teaching every writer about it.
//
// This lives here rather than beside the generator because the predicate reads both of
// the stores a parameter's evidence can be in, and `tracks` is the one declared just
// above. See `groupRevealChanged`, which is the no-op the generator's pass calls and
// which the last line of this block replaces.

// Which groups you have overruled, and nothing else - the group key against the state
// you asked for. It is client state and not document state, for the reason the `viewer`
// group's own note gives about the two parameters in it: this changes what you are
// looking at, not what the frame is. So it is out of the project, out of undo, out of
// every export, and stored per browser like `kinect.lastOpened` and `kinect.lanesHeight`.
const PANEL_GROUPS_OPEN = 'kinect.panelGroupsOpen';

const groupOverride = new Map();
try {
  // The string is checked before the parse, which is the same lesson `kinect.lanesHeight`
  // records one line at a time: `getItem` answers null when nothing was ever stored, and
  // `JSON.parse(null)` answers null rather than throwing, so a missing entry and a stored
  // `null` would arrive as one reading. `JSON.parse('')` does throw, and landing in the
  // catch would be right by accident rather than by having asked.
  const saved = localStorage.getItem(PANEL_GROUPS_OPEN);
  if (saved !== null && saved.trim() !== '') {
    const parsed = JSON.parse(saved);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      // Each entry checked rather than the object adopted, because this is a file a
      // person can edit and a `null` or a string here would make `override ?? derived`
      // answer with a truthy non-boolean and pin a group open forever. A `Map` is what
      // holds them, so the `__proto__` key that `JSON.parse` creates as an own property
      // is an ordinary entry here rather than a prototype write.
      for (const [key, want] of Object.entries(parsed)) {
        if (typeof want === 'boolean') groupOverride.set(key, want);
      }
    }
  }
} catch {
  // Private browsing, storage disabled by policy, or an entry somebody has damaged.
  // Every group answering for itself is a good state to arrive in.
}

function storeGroupOverride() {
  try {
    localStorage.setItem(PANEL_GROUPS_OPEN, JSON.stringify(Object.fromEntries(groupOverride)));
  } catch {
    // Private browsing or policy again. The panel still collapses and still opens; it
    // just will not remember which way across a reload.
  }
}

// What each parameter is worth in a project nobody has touched, computed once.
//
// **Through `normalise`, not against `PARAMS[n].def` raw**, and the difference is a
// class rather than a case. `normalise` clamps, snaps to a grid anchored at `min` and
// rounds to the decimals `min` and `step` imply, and every scalar default this build
// declares happens to land on its own grid - so raw equality is correct today and
// would go on being correct right up until somebody adds a parameter whose default is
// not on its step. That group would then read as touched from boot, on a fresh page,
// with nothing anywhere saying why. Doing it once at module scope is what keeps the
// arithmetic off the evaluator's path, where this is asked several times a frame.
const groupDefaults = new Map();
for (const names of panelGroupParams.values()) {
  for (const name of names) groupDefaults.set(name, params.normalise(name, PARAMS[name].def));
}

/**
 * Whether one parameter carries evidence that somebody has been here: a keyframe track
 * with keys on it, or a value sitting off the default a fresh project would hold. The
 * whole rule is this line and a half, and both the group's open state and the count on
 * a shut header are asked of it rather than of a copy.
 *
 * **The keyframe term is not decoration.** During playback the evaluator writes every
 * keyed parameter through `params.set`, so `params.get` answers the *evaluated* value -
 * and a curve that happens to cross its own default at the parked frame would make the
 * value test say "untouched" for that one frame. Without this term the groups would
 * breathe open and shut as the playhead moved, which is a panel that cannot be read
 * while anything is playing. `valueAtProgram` answers the un-evaluated question, and it
 * is deliberately not what this asks: a parameter with keys is in use at every position,
 * including the ones its curve passes through on the way somewhere else.
 *
 * **`keys.length > 0`, never `tracks.has(name)`.** `restoreProject` does
 * `trackFor('camera').keys = restoredCamera` with no `dropTrackIfEmpty` after it and
 * `trackFor` inserts on a miss, so a zero-key entry survives in the map for the rest of
 * the session after any project open or undo. No panel group holds `camera`, so
 * membership would answer correctly here today and be wrong the first time an empty
 * track outlives a name a group does show - and the length is what every other has-keys
 * test in this file already asks.
 *
 * **And `tracks.get`, never `trackFor`.** `trackFor` is a creating accessor. A
 * predicate built on it would author a keyframe track as a side effect of drawing a
 * panel header, which is a document that changed because somebody looked at it.
 */
function paramTouched(name) {
  if ((tracks.get(name)?.keys.length ?? 0) > 0) return true;
  return params.get(name) !== groupDefaults.get(name);
}

/**
 * The default rule: a group is in use when any parameter it shows is. Named rather than
 * inlined because a `reveals` closure on a `PANEL_GROUPS` entry is written in terms of
 * it - `Reading · detail` asks it about two other groups - so this is the vocabulary
 * those closures are written in and not an internal step of the one below.
 */
function revealsItself(key) {
  return (panelGroupParams.get(key) ?? []).some(paramTouched);
}

/**
 * What the document says about a group, which is the derived half of "is it open" and
 * the thing a toggle is measured against.
 *
 * Kept apart from `revealsItself` rather than folded into it, and the store rule below
 * is why the two cannot be one function. A group carrying a `reveals` closure answers a
 * wider question than its own parameters do, so a store rule comparing a collapse
 * against `revealsItself` would find the two agreeing on a `Reading · detail` that a
 * live reading had opened, drop the override, and re-derive the group open - a collapse
 * that does not survive the repaint it caused. `detail`'s closure also calls
 * `revealsItself` on two other groups, which is the second reason the names have to stay
 * distinguishable at a call site.
 */
function groupRevealed(group) {
  return group.reveals ? group.reveals() : revealsItself(group.key);
}

/** The predicate: what the document derives, unless a person has said otherwise. */
function groupIsOpen(group) {
  return groupOverride.get(group.key) ?? groupRevealed(group);
}

/**
 * How many of a group's own parameters are carrying something, for the shut header.
 *
 * Over the same `paramTouched` the predicate walks rather than a second copy of the
 * test, because two spellings of "has anybody been here" is two things to keep in step
 * and the header would be the one that quietly stopped agreeing with the rule that
 * opened the group above it.
 */
function groupTouchedCount(key) {
  return (panelGroupParams.get(key) ?? []).filter(paramTouched).length;
}

/**
 * What the panel shows, re-derived. Called after every registry write and after every
 * change to the set of tracks, which between them are both terms of the predicate.
 *
 * Each group is painted only where the answer moved. The evaluator writes one value per
 * keyed parameter per frame and every one of them arrives here, so an unconditional
 * write would put a `textContent` assignment and an attribute write per group into the
 * render path to say what the panel already said.
 */
const groupPainted = new Map();
// How often the panel has been re-derived, for the one question a tool cannot answer
// from outside: whether a bulk write costs one pass or one per value in it. A count the
// page keeps rather than a duration a driver times, because a rate taken around a
// gesture Playwright is pacing is a measurement of Playwright.
let groupRefreshes = 0;
// Whether the map has moved since it was last written down. It is a flag rather than a
// second `storeGroupOverride()` call at the toggle because there is exactly one rule
// about what may be in that store, and a rule with two enforcement sites is the shape
// `docs/instruments.md` records the rename refusal having: no mutation can reach one of
// them without the other covering, so one of the two is doing all the work and nothing
// can say which.
let groupOverrideDirty = false;
// Where the two terms of the store rule last stood, keyed by group and read as
// `override/derived`. It exists so a pass can tell an agreement that was just *arrived
// at* from one that has been true since the page opened, which is the whole of what the
// prune below turns on. Empty at boot on purpose.
const groupSeen = new Map();
function refreshGroups() {
  groupRefreshes++;
  for (const [key, { group, node, button, mark }] of panelGroupNodes) {
    // The same rule that decides whether the group opens, and not a wider one of its
    // own. That is a property of every `reveals` closure including its own parameters
    // rather than a coincidence: a group with something touched inside it always
    // derives open, so a shut group that is in use is always one a person shut, and the
    // mark is telling them what they hid. A closure that *replaced* the default rule
    // would break that - the group could be quietly carrying a value with nothing on
    // screen saying so - and the fix belongs in the closure rather than here, because a
    // mark widened to cover it would be a second rule drifting from the first.
    const inUse = groupRevealed(group);
    const want = groupOverride.get(key);
    // **The decay the store rule claims, and for a while it was only a claim.**
    // `toggleGroup` drops an entry that agrees with the derivation *at the moment the
    // toggle is pressed*, which closes nothing on its own, because the term that moves
    // afterwards is the other one. A group pinned open while it was quiet stores `true`
    // against a derived `false`, and then a value set, a look applied or a project
    // opened moves the derivation onto it with nothing looking - so reset the look and
    // the group is still open with nothing inside it, which is the stored panel layout
    // this whole design exists to refuse. The derivation is read here, on every write
    // and every change to the tracks, so this is where an override that has been
    // overtaken can be seen to have been.
    //
    // **What it may not do is prune on agreement alone, and the state that says so is
    // the one this page boots into.** Before the take is open and before a project has
    // been restored every look parameter sits at its default and `tracks` is empty, so
    // the derivation answers `false` for every group - which is not a statement about
    // the document, it is a statement about there not being one yet. A build comparing
    // the two terms for equality deleted every stored collapse on its way past that
    // reading, wrote the pruned map straight back, and then let the take load and derive
    // the group open again. Collapsing a group that was in use never survived a reload
    // while pinning one open always did, and the direction that failed is the one people
    // reach for, because a quiet group is already shut. The same window is open for as
    // long as the load takes rather than only at module evaluation, so a flag raised
    // until boot finishes would close half of it: `openTake` derives against a default
    // look before the project that fills it has arrived.
    //
    // So the pair is remembered and the prune fires where it has *changed* into
    // agreement - the derivation arriving on the opinion, or a toggle putting the
    // opinion on the derivation. Both terms are covered by one comparison rather than
    // two rules, which is the same reason `toggleGroup` does not prune on its own way
    // past. At boot nothing has changed into anything and the map is empty, so the page
    // reads the store and leaves it alone. An entry that agreed from the first frame and
    // never moved is kept, which costs a group rendering exactly as it would have
    // anyway, and it decays the first time the document uses that group and stops.
    //
    // `get` answers `undefined` for a group nobody has overruled and no comparison
    // against a boolean can match that, so the untouched case costs two Map lookups.
    const pair = `${want}/${inUse}`;
    const settled = groupSeen.get(key);
    if (settled !== undefined && settled !== pair && want === inUse) {
      groupOverride.delete(key);
      groupOverrideDirty = true;
    }
    groupSeen.set(key, `${groupOverride.get(key)}/${inUse}`);
    // **Nothing here may author an override.** A rule that pinned a group open when the
    // derivation went false underneath it - so that resetting a group's last value did
    // not collapse it under the hand that reset it - was here, and it fabricated a
    // disagreement nobody had expressed. The state it read was the panel's own
    // `shut` class, which no group carries until this pass has painted one, so on the
    // very first refresh every group read as open against a derivation that answers
    // false for all of them before a document exists. It wrote `true` for every group
    // in the panel, persisted that to `kinect.panelGroupsOpen`, and the editor booted
    // with the whole inspector open and every collapse it had ever been taught
    // overwritten. That is the stored panel layout this design refuses, arriving as a
    // convenience: the derivation is the rule, and the only thing allowed to disagree
    // with it is somebody pressing the toggle.
    const open = groupIsOpen(group);
    const touched = groupTouchedCount(key);
    const state = `${open}/${inUse}/${touched}`;
    if (groupPainted.get(key) === state) continue;
    groupPainted.set(key, state);

    node.classList.toggle('shut', !open);
    button.setAttribute('aria-expanded', String(open));
    // What the button says it will do, which is not the same sentence as the heading.
    button.setAttribute('aria-label', `${open ? 'collapse' : 'expand'} ${group.label}`);
    // The count only where it is the only thing that can say so. An open group has its
    // rows on screen and a number over them would be a second, worse copy of them; a
    // shut group that is genuinely at its defaults has nothing to announce.
    //
    // The empty string is still written rather than assumed, because a group can be in
    // use with nothing of its own to count: that is what a `reveals` closure answering
    // a wider question than its own parameters does, and it showed the mark without a
    // number rather than a misleading zero. No group declares one today - the rework
    // folded `detail` into `style` and its closure went with it - so the branch is
    // reachable only by the next group that needs one, which is why `groupRevealed`
    // stays a call rather than becoming `revealsItself`.
    mark.hidden = open || !inUse;
    mark.textContent = touched > 0 ? String(touched) : '';
    mark.title = touched > 0
      ? `${touched} of these are set to something` : 'this group is in use';
  }
  // Once at the end, and only where the map actually moved. `setItem` serialises the
  // whole thing synchronously, so writing it on every pass would put a `JSON.stringify`
  // and a storage write into the render path to store the bytes that were already
  // there - which is the cost the painting rule above exists to keep out, arriving
  // through the door beside it.
  if (groupOverrideDirty) {
    groupOverrideDirty = false;
    storeGroupOverride();
  }
}

/**
 * A person disagreeing with the derivation, which is the only thing that is stored.
 *
 * It writes what was asked for and nothing else. Whether that survives is the prune's
 * question and is asked in `refreshGroups` above, where the derivation is read - a
 * toggle that dropped an agreeing entry on its own way past would be the same rule
 * spelled a second time, and the second spelling would be the one covering for the
 * first every time anything tried to measure either.
 */
function toggleGroup(key) {
  const entry = panelGroupNodes.get(key);
  if (!entry) return;
  groupOverride.set(key, !groupIsOpen(entry.group));
  groupOverrideDirty = true;
  refreshGroups();
}

// The no-op declared beside `paramWritten` becomes the real thing here, where both of
// the stores the predicate reads exist, and the panel is painted once for the state the
// page booted into.
groupRevealChanged = refreshGroups;
refreshGroups();

// Every track written through the one door, at one program position. This is the
// evaluator the note on `evaluating` asked for: it runs inside
// `renderProgramFrame`, so the flag now spans exactly what its name claims, and a
// preset or a mode selected from a track's own apply would be refused rather than
// merely unlikely.
//
// The suppression is not optional and is the reason this is one function rather
// than a loop at the call site. `params.set` announces every write, the timeline
// answers an announcement by scheduling an accurate seek, and an evaluator
// writing eight track values per frame without this would schedule eight seeks
// per frame - each of which renders a pre-roll, which evaluates, which schedules
// more. It never settles, and the symptom is a tab that gets slower rather than
// an error.
// The parameters a draft has borrowed, or null. The evaluator has to see this or
// the borrow does not hold: `draftNow` zeroes fade, wake and trails and then calls
// the render, and the evaluator inside it wrote any of the three that carried keys
// straight back. A scrub over a clip with a keyed wake then drafted with the wake
// live on freshly cleared accumulators - every point newborn, the whole cloud in
// its ramp-in - which is neither the accumulator-free frame a draft is defined as
// nor an image that existed at that position. It also broke the property two
// drafts of one position are compared on.
let borrowed = null;

function evaluateTracks(t) {
  if (tracks.size === 0) return;
  withoutRepaint(() => {
    for (const track of tracks.values()) {
      if (track.keys.length === 0) continue;
      if (borrowed && borrowed.has(track.name)) continue;
      params.set(track.name, track.valueAt(t));
    }
  });
}

/**
 * What a parameter is worth at a program position rather than right now: its
 * track's value if it carries keys, the registry's if it does not, snapped either
 * way so it is the value a render at that position would actually apply.
 *
 * This exists because "what is the look here" and "what is the look on screen" are
 * different questions the moment anything is keyed, and a seek has to ask the
 * first one about a position it has not rendered yet.
 */
function valueAtProgram(name, t) {
  const track = tracks.get(name);
  if (!track || track.keys.length === 0) return params.get(name);
  return params.normalise(name, track.valueAt(t));
}

// Where a key lands, and how near an existing one has to be to count as the same
// key. Half an output frame, because the playhead is an integer output frame and
// two keys inside one of them cannot be told apart by anything downstream.
const playheadSec = () => (timeline ? timeline.programSec : 0);
const keyTolerance = () => 0.5 / (timeline ? timeline.outputFps : 30);

/**
 * A parameter written from its panel control. With keys on the track this writes
 * the key at the playhead rather than the parameter alone - Final Cut's rule, and
 * here it is not a convention but the only thing that works: the evaluator rewrites
 * every keyed parameter on the very next render, so a bare `params.set` would be
 * overwritten before the slider stopped moving and the control would appear to
 * spring back on its own.
 */
function writeFromControl(name, value) {
  const applied = params.set(name, value);
  const track = tracks.get(name);
  if (track && track.keys.length > 0) {
    // The normalised value rather than the raw one, so the key holds exactly what
    // the parameter holds. A key a hair off its own slider would put an
    // interpolated value between two positions the slider cannot express.
    track.setKey(playheadSec(), applied, keyTolerance());
    lanesChanged();
  }
}

/** Adds a key at the playhead, or removes the one already there. */
function toggleKey(name) {
  const track = trackFor(name);
  const existing = track.keyAt(playheadSec(), keyTolerance());
  if (existing) {
    track.removeKey(existing);
    dropTrackIfEmpty(name);
  } else {
    // The parameter's current value, so planting the first key on a track never
    // changes the image. A key that moved the picture the moment it appeared would
    // make keying a look a destructive act.
    track.setKey(playheadSec(), params.get(name), keyTolerance());
  }
  lanesChanged();
  requestRepaint();
  history.commit();
}

// ------------------------------------------------------------------- the project

// Everything an edit *is*, as one plain object. A project file, an undo snapshot
// and step 6's export job all start here, which is why this is one function rather
// than a serialiser per consumer that would each learn about a new track kind
// separately.
//
// What is in it is document state and nothing else. `params.values()` already
// defaults to look plus composition and leaves `view` out, so render scale and
// auto-orbit are absent by construction rather than by a list kept in step with
// the registry. The playhead, the free camera's orbit and which panel is open are
// absent for the same reason: none of them is what the clip is.
//
// Which reading is on screen is in it, and it needs no special case to be there any
// more. It used to: the mode was a sixth thing beside the registry, written into this
// body by hand, because leaving it out would have restored the twelve values Blackwall
// wrote while leaving Blackwall selected - a state that never existed, which is the
// exact failure a whole-project snapshot exists to make impossible. The readings are
// ordinary look parameters now, so `params.values(params.names('look'))` carries them
// and there is no second list to forget.

function serialiseProjectBody() {
  return {
    version: PROJECT_VERSION,
    look: {
      // Look parameters only; the registry separates look from view and from the
      // camera, so an undo snapshot or a render job does not carry render scale or
      // the free camera's orbit.
      params: params.values(params.names('look')),
      tracks: Object.fromEntries(
        params.names('look')
          .filter((n) => tracks.has(n))
          .map((n) => [n, tracks.get(n).serialise()]),
      ),
    },
    composition: {
      // Retime is the source-to-program mapping, and the camera track is the one
      // pose track. The split is only on disk; the editor still uses one tracks map.
      retime: retime.serialise(),
      camera: tracks.get('camera')?.serialise() ?? [],
    },
    // The framing the clip was composed for, as the shape rather than as a size. The
    // pixel count is the deliverable's, because the point-size rebase makes the look
    // resolution-relative and two sizes of one shape reopen identically; the shape is
    // here because the camera was keyed against a frame and a different one is a
    // different shot with the same keys.
    //
    // **No version bump for either of the two fields on these lines**, and that is
    // deliberate rather than an oversight. `PROJECT_VERSION` is shared with presets, so
    // bumping it to describe a project field would invalidate every document in
    // `presets-builtin/` for a change presets have nothing to do with. The convention for
    // an added field here is "absent is allowed and means X", which is what the
    // `outputSize` this replaces already said and what `vignette` did before it.
    aspect: [...projectAspect],
    // The output rate, moved off the deliverable because it is not free. `trails` is the
    // one look term whose length is counted in output frames rather than in seconds - at
    // damp 0.9 a trail is down to 12% after twenty frames, which is 0.83s at 24fps and
    // 0.33s at 60fps - so a rate chosen per deliverable would mean two files of one edit
    // carrying two different looks with nothing on screen saying so. `AfterimagePass` is
    // the only pass in `web/post-chain.js` that carries state between renders, so it is
    // the only such term; fixing that is a separate decision that would change the look
    // of every project already saved, and it is not this one.
    outputFps: timeline ? timeline.outputFps : 30,
    // Provenance, not a reference. The values above are already copied in, so this
    // changes nothing about what renders - it only records which revision of which
    // look this clip was built from, which is what lets a gallery see that three
    // clips are on one revision and two are on an older one.
    appliedPreset,
  };
}

function serialiseProject() {
  return {
    ...serialiseProjectBody(),
    // History is saved with the project so undo survives a reload, but it is never
    // inside an undo snapshot or a render job - a snapshot containing its own
    // history would recurse.
    history: { stack: [...history.stack], baseline: history.baseline },
  };
}

/**
 * A key as it arrives from outside, checked into a key this editor can hold.
 *
 * `t` is checked here and the value is checked by the registry, which is the split
 * that matters: a time is a time whatever the parameter, and only the registry
 * knows that `camera` is a pose and `additive` is a boolean. Handles default to
 * linear when absent - a key written without them is linear, not handleless - and
 * are checked when present, because a handle outside the unit box bends a curve
 * back on itself inside a segment.
 *
 * **A handle is a list of control points and version 5 is what says so.** A version 4
 * document wrote one pair per side, `[0.42, 0]`, and this reads `[[0.42, 0]]` - the
 * same cubic with the count made explicit. The two shapes are not distinguishable by
 * a length check, which is exactly why the conversion is a version gate upstream of
 * here and a one-shot over files rather than a sniff at this line: `[0.42, 0]` is a
 * two-element array and so is `[[0.2, 0], [0.4, 0]]`, so a loader that guessed would
 * read a quintic's first control point as a whole cubic and render a move nobody
 * authored. The count is checked against the same ceiling the editor's own control
 * obeys, because a document is a caller like any other.
 */
function restoreKey(owner, k) {
  if (!Number.isFinite(k?.t)) {
    throw new Error(`${owner} has a key at t=${JSON.stringify(k?.t)}: a key time has to be a finite number`);
  }
  const handle = (side, points, fallback) => {
    if (points === undefined) return copyHandle(fallback);
    const ok = Array.isArray(points)
      && points.length >= 1 && points.length <= SEGMENT_POINT_CEILING
      && points.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
    if (!ok) {
      throw new Error(`${owner}'s key at ${k.t}s has a ${side} handle of ${JSON.stringify(points)}: it takes `
        + `1 to ${SEGMENT_POINT_CEILING} control points, each two finite numbers`);
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

/**
 * The one door a whole document comes through, and since step 7 it is the door a
 * **file from outside this page** comes through - an undo snapshot and a project
 * loaded off disk are the same object and take the same route, because a second
 * route is a second set of checks to keep honest.
 *
 * Everything here refuses rather than repairs. That is not caution for its own
 * sake: the three things this now catches are each a *silent* wrong image rather
 * than a crash, which is the class of failure this repo keeps finding after the
 * fact. A falling retime curve stops playback with the play button still lit. A
 * non-unit quaternion renders a camera move nobody drew. A `pointSize` from before
 * step 6's rebase draws 1.8x wrong at every size.
 */
function restoreProject(project) {
  if (!project || typeof project !== 'object') {
    throw new Error(`a project is an object, got ${JSON.stringify(project)}`);
  }
  // The version gate, first, because everything below it is interpreted *in* the
  // version. A document that is not this build's version is refused, because a
  // document whose units cannot be recovered is one that renders wrong with
  // nothing to say why.
  // Which refusal it gets is `versionRefusal`'s, in `format.js` beside the history it
  // reads from - because the two doors were writing that sentence separately and a
  // version band added here would not have reached the preset one.
  if (project.version !== PROJECT_VERSION) {
    throw new Error(versionRefusal('this project', project.version));
  }
  if (!project.look || typeof project.look !== 'object') {
    throw new Error('a project carries a look object');
  }
  if (!project.composition || typeof project.composition !== 'object') {
    throw new Error('a project carries a composition object');
  }
  // The reading used to need its own bounds check here - a whole number from 0 to 4,
  // because nothing else in the loader would have caught a mode of 9 selecting an
  // undefined shader branch. It has none now, and that is the removal working rather
  // than an omission: the readings are registry scalars, so `params.apply` runs each
  // through `normalise`, which refuses a non-number loudly and clamps to the declared
  // 0..1. One validator for every look value beats a hand-written clause per special
  // case, which is what the special case was.
  //
  // Checked here rather than shrugged off, because a shape that does not parse would
  // otherwise leave the editor framing at whatever the last clip was and quietly export a
  // different shape from the one on screen. Absent is allowed and means the shape derived
  // below - the version gate above is what makes that reading safe, since nothing older
  // than it can reach here.
  //
  // A pair of positive integers, which is the whole of what a shape is. Integers rather
  // than any two numbers because the pair is a *reduced* ratio and the reduction is what
  // makes two sizes of one shape compare equal; `[16.0, 9.0]` would compare unequal to
  // `[16, 9]` under `sameAspect` and light no button while framing identically, which is
  // the kind of near-miss that reads as a rendering bug.
  const aspectShape = Array.isArray(project.aspect) && project.aspect.length === 2
    // `isSafeInteger` rather than `isInteger`, because above 2^53 the integers stop being
    // distinct: `[9007199254740993, 9007199254740992]` is parsed as two copies of the same
    // number, passes `isInteger`, reduces to `[1, 1]` and frames the clip square. A shape
    // nobody can have meant, adopted rather than refused, is the class this validator is
    // here for - and the pair is a *ratio*, so a value that cannot be told from its
    // neighbour is not a ratio at all.
    && project.aspect.every((n) => Number.isSafeInteger(n) && n > 0);
  if (project.aspect !== undefined && !aspectShape) {
    throw new Error(`aspect is ${JSON.stringify(project.aspect)}: it reads as [width, height] in whole positive numbers`);
  }
  // The legacy field, still checked because it is still read - it is the only thing a
  // project written before the shape moved onto the document has to say what it was
  // framed at, and a size that does not parse is a project this build cannot frame.
  if (project.outputSize !== undefined && !/^[1-9][0-9]*x[1-9][0-9]*$/.test(String(project.outputSize))) {
    throw new Error(`outputSize is ${JSON.stringify(project.outputSize)}: it reads as WIDTHxHEIGHT`);
  }
  // **A shape this build can offer no resolution for is refused, and refusing it here is
  // what stops a document becoming a trap.**
  //
  // `outputSize` used to carry the shape *and* the pixel count; `aspect` carries only the
  // shape, and the pixels come off the deliverable by looking the shape up in
  // `EXPORT_SIZES`. For every shape the table holds that is a lossless split. For one it
  // does not - a hand-typed 1600x1000 is 8:5, and no group here offers 8:5 - the pixel
  // count has nowhere to live once `outputSize` stops being written, so the document
  // reopens framed at 8:5 with a deliverable holding some 16:9 size, a resolution menu
  // whose only entry is that wrong-shape size, and an export that refuses. A dead end with
  // no route out of it through the product.
  //
  // Refused at the door rather than repaired, because the repair anybody reaches for makes
  // it worse. Refusing only the saved form leaves the legacy document openable and turns
  // *saving* into the destructive step: open it, save it, and it can never be opened again.
  // Manufacturing a size at that ratio would put a resolution the product does not offer
  // into a deliverable and then into a filename, which is what `web/export-sizes.js` refuses
  // in as many words. So the rule is one rule, asked of the shape however it arrived - the
  // field, or derived from a legacy size - and it costs the ability to open a project framed
  // at a shape this build has no sizes for, which is a project it could not have rendered
  // either.
  const framedAt = project.aspect
    ?? (project.outputSize === undefined ? defaultAspect() : aspectOfSize(String(project.outputSize)));
  const framedShape = reduceAspect(framedAt[0], framedAt[1]);
  if (sizesForAspect(framedShape).length === 0) {
    throw new Error(
      `this project is framed at ${framedShape.join(':')}, which this build offers no resolution for - `
      // The labels the shape buttons print, not the reduced pairs. `[256, 135]` is the
      // honest reduction of the DCI group and is the one thing on screen nobody can match
      // to a control, because the button beside it says `1.90:1`. A refusal is read by
      // somebody about to go looking for the thing it names.
      + `it renders ${exportAspects().map((a) => a.ratio).join(', ')}, so there is no size to `
      + 'export it at and no menu entry to pick one from',
    );
  }
  // The rate against the list the control is built from, so a document naming 25 is
  // refused rather than adopted into a `<select>` that cannot show it. Refused rather
  // than snapped to the nearest offered rate for the reason every other refusal here
  // exists: `trails` is counted in output frames, so a rate quietly moved from 25 to 24
  // is a look quietly changed, and the operator would have no way to see which.
  if (project.outputFps !== undefined && !OUTPUT_RATES.includes(project.outputFps)) {
    throw new Error(
      `outputFps is ${JSON.stringify(project.outputFps)}: this build offers ${OUTPUT_RATES.join(', ')}`,
    );
  }
  if (!project.look.params || typeof project.look.params !== 'object') {
    throw new Error('a project look carries a params object');
  }
  // The same demand the preset door makes, and it belongs on both for the reason the
  // helper gives: the reset below hands an omitted reading its default, and `readRgb`
  // defaults to 1. A project carrying only `readBlackwall: 1` would load as a 50/50
  // blend with the camera image rather than as the wall it names.
  const shortReadings = missingReadings(project.look.params);
  if (shortReadings.length) {
    throw new Error(
      `this project names no ${shortReadings.join(', ')}: a version ${PROJECT_VERSION} look carries `
      + 'all five reading weights, and the ones it leaves out would come back as defaults rather '
      + 'than as the look it was saved with',
    );
  }
  if (!project.look.tracks || typeof project.look.tracks !== 'object') {
    throw new Error('a project look carries a tracks object, empty if nothing is keyed');
  }
  if (!project.composition.retime || !Array.isArray(project.composition.retime.keys) || !Number.isFinite(project.composition.retime.rate) || project.composition.retime.rate <= 0) {
    throw new Error('a project composition carries a retime with a positive rate and an array of keys');
  }
  if (!Array.isArray(project.composition.camera)) {
    throw new Error('a project composition carries a camera track as an array of keys');
  }

  // Built whole before anything is written, so a project that fails halfway leaves
  // the editor on the clip it already had rather than on a half-applied one. The
  // registry's own refusals do the value checking, key by key: `params.normalise`
  // is what rejects a scalar that is a string, a step that is not a boolean and -
  // since this step - a quaternion that is not of unit length. Routing keys through
  // it is the whole of why a hand-edited camera track cannot reach `poseAt`.
  const restoredLook = [];
  for (const [name, keys] of Object.entries(project.look.tracks)) {
    if (!Array.isArray(keys)) throw new Error(`look track ${name} is not an array of keys`);
    // Names the registry does not know are refused rather than dropped. A track
    // silently discarded is an edit silently lost, and the file is more likely to
    // be from a build this one cannot read than to be harmlessly extra.
    const spec = params.spec(name);
    // And a name it does know but does not tag `look` is refused for a harder reason
    // than tidiness. `serialiseProjectBody` filters the track set down to look
    // parameters, so this is a shape no build of this program has ever written - the
    // reader was simply not making the demand the writer already meets, and the tag was
    // sitting here unread while the throw above was taken for the whole check.
    //
    // What accepting one cost is the part worth naming. `evaluateTracks` has no tag
    // filter and runs inside `renderProgramFrame`, so a track on `renderScale` is
    // `resize()` called once per rendered frame - and where the value genuinely moves
    // across a ramp, `composer.setSize` disposes and recreates the render targets and,
    // through `AfterimagePass`, the trails accumulator. That is the accumulator
    // destroyed between two consecutive frames of a pre-roll whose entire purpose is to
    // build it up, so an accurate seek stops reproducing the playback it is defined to
    // reproduce. The document stops round-tripping at the same time and just as quietly,
    // because the serialiser filters the track back out on the next commit.
    //
    // Read off the spec rather than checked against a list of view parameter names, so
    // a parameter retagged later is refused by existing rather than by being remembered.
    if (spec.tag !== 'look') {
      throw new Error(
        `the track on ${JSON.stringify(name)} is on a ${spec.tag} parameter: a project carries `
        + 'look tracks only, which is what this build writes and the only kind it can evaluate '
        + 'without resizing the drawing buffer from inside the render loop',
      );
    }
    // **Skipped only after it has been asked about, and the order is the whole of it.**
    // This shortcut used to stand above both refusals, so `{"renderScale": []}` and a
    // track under a name the registry has never heard of both walked straight past a
    // reader that had just promised to refuse them. Nothing threw and nothing was kept:
    // `serialiseProjectBody` filters the entry back out on the next commit, so the
    // document quietly stopped saying what it said when it was opened - which is the
    // "an edit silently lost" the comment above is about, arriving through the one shape
    // that has no edit in it to notice missing.
    //
    // An empty track is still nothing to restore, so it is still skipped. The change is
    // that it is skipped for being empty rather than for being cheap to skip.
    if (keys.length === 0) continue;
    restoredLook.push([name, keys.map((k) => {
      const key = restoreKey(`track ${name}`, k);
      key.value = params.normalise(name, key.value);
      return key;
    })]);
  }

  // The same refusal for the parameter values, and for the same reason - but it has
  // to happen *here*, in the build-whole phase, rather than where they are applied.
  //
  // **What this buys has changed and it is still load-bearing**, so the reason is
  // restated rather than left to read as the old one. It used to be the only thing
  // standing between a bad name and a half-applied registry, because `params.apply`
  // wrote as it walked and threw on the first name it did not know. `apply` checks the
  // whole object before writing any of it now, so that particular hole is closed at
  // the door instead. What is left is the wider window: this runs in the build-whole
  // phase, before the tracks are rebuilt and before anything at all has been written,
  // and `apply` cannot, because it is itself one of the writes. A project carrying a
  // parameter this build has since removed has to be refused with nothing touched, and
  // that is earlier than the registry can see.
  for (const name of Object.keys(project.look.params)) params.spec(name);

  const restoredCamera = project.composition.camera.map((k) => {
    const key = restoreKey('track camera', k);
    key.value = params.normalise('camera', key.value);
    return key;
  });

  const restoredRetime = project.composition.retime.keys.map((k) => {
    const key = restoreKey('the retime curve', k);
    if (!Number.isFinite(key.value)) {
      throw new Error(`the retime key at ${key.t}s maps to ${JSON.stringify(key.value)}: source time is a number`);
    }
    return key;
  });
  // The fourth door onto the curve, and the one this step exists to close. The
  // other three are gestures inside a page that already vetted the curve; this is
  // the one a file arrives through, and a descending region does not merely fail -
  // it kills the animation loop, or worse, passes the residency guard vacuously
  // because the bounds it compares have crossed, and playback simply stops
  // advancing with the play button still lit.
  retime.assertMonotonic(restoredRetime);

  // Null or a name and a revision, and checked because it is displayed: a stamp
  // carrying an object where a string belongs would put "[object Object]" on a
  // chip that is supposed to be the audit trail for a set of clips.
  const stamp = project.appliedPreset ?? null;
  if (stamp !== null && (typeof stamp.name !== 'string' || typeof stamp.rev !== 'string')) {
    throw new Error(`appliedPreset is ${JSON.stringify(stamp)}: it is null, or a name and a rev`);
  }

  // A saved project may carry its undo history. Undo snapshots and render jobs do
  // not, and this is the only place a file arrives with one, so it is restored here.
  if (project.history !== undefined) {
    if (!project.history || typeof project.history !== 'object' || !Array.isArray(project.history.stack)) {
      throw new Error('a project history is an object with a stack array');
    }
    if (project.history.baseline !== null && typeof project.history.baseline !== 'string') {
      throw new Error('a project history baseline is a string or null');
    }
  }

  // Defaults first, so a key the document does not carry means the default rather
  // than whatever the session happened to leave in the registry. `params.apply`
  // walks the document's own keys, so absent is invisible to it - which was harmless
  // only while every document carried every key. It stops being harmless the moment
  // a parameter is added, and the second project opened in one session is where it
  // would have shown up. `aspect` takes this position too, on the lines above, for
  // the same reason read the other way round.
  //
  // **The look tag, not every parameter.** `params.reset()` defaults view state too,
  // and view state is not in the document - so a bare reset made undo snap render
  // scale back to 100, which is the one thing the stack is supposed to leave alone.
  // The set reset here is exactly the set `serialiseProjectBody` writes.
  // **The first thing here that changes anything, and it used to be the first thing in
  // the function.** `setProjectAspect` resizes the stage, and the setter it replaced
  // resized the export target with it, before the
  // shape of the document had been checked at all, so a project that named a new size
  // and was then refused - for a missing reading, a track the registry does not know,
  // a retime that descends - left the editor framing something the clip on screen was
  // never composed for. `loadProjectNamed` exits on the throw without reapplying the
  // active deliverable, so nothing put it back.
  //
  // The format of both fields is still checked up in the validation phase, where a
  // refusal costs nothing. Only the write waited.
  //
  // **One reader with one documented fallback, not a second code path.** A project this
  // build wrote carries `aspect` and nothing else; one written before the split carries
  // an `outputSize`, whose ratio *is* the shape it was framed at, so the shape is derived
  // from it rather than the project being refused for lacking a field it could not have
  // known about. A project carrying neither is the shape the default size is.
  //
  // The legacy size is handed to the deliverable in the same breath, and that is the half
  // that would be easy to leave out. `outputSize` was both the shape and the pixel count,
  // so a hand-typed 1600x1000 reduces to `[8, 5]` - a shape the table offers no size for -
  // and dropping the pixels would leave the deliverable holding a 16:9 size that
  // `exportClip` then refuses. Seeding it means such a project renders exactly what it
  // rendered before, which is the whole promise of an additive field.
  const legacySize = project.outputSize === undefined ? null : String(project.outputSize);
  if (legacySize !== null && project.aspect === undefined) {
    ensureActiveDeliverable();
    activeDeliverable.outputSize = legacySize;
  }
  setProjectAspect(
    project.aspect ?? (legacySize === null ? defaultAspect() : aspectOfSize(legacySize)),
    { fromDocument: true },
  );

  // The output rate, and the playhead held across it. `timeline.frame` counts *output*
  // frames, so writing a new rate underneath it silently moves the playhead - frame 300
  // is 10s at 30fps and 5s at 60 - and undo promises in as many words that the playhead
  // does not move. Held here rather than at each caller because there are three of them
  // and one is the undo stack itself: a project load, a restored autosave and every undo
  // that crosses a rate change all arrive through this line.
  if (timeline) {
    const held = timeline.programSec;
    timeline.outputFps = project.outputFps ?? 30;
    timeline.frame = timeline.frameAt(held);
  }

  params.reset(params.names('look'));
  params.apply(project.look.params);
  appliedPreset = stamp;

  tracks.clear();
  for (const [name, keys] of restoredLook) trackFor(name).keys = keys;
  trackFor('camera').keys = restoredCamera;

  retime.rate = project.composition.retime.rate;
  retime.keys = restoredRetime;

  timingChanged();

  if (project.history) {
    history.stack = [...project.history.stack];
    history.baseline = project.history.baseline;
  }
}

// Whole snapshots rather than a command stack, and the argument is that this one
// cannot be got wrong. A command stack needs every mutation path to implement both
// directions correctly, and the classic way an editor corrupts someone's work is
// an undo that is not quite the inverse of its redo. A snapshot has no such
// failure mode: whatever the mutation was, the state before it is already held.
// The memory argument that normally favours commands does not apply - a project is
// tens of kilobytes of JSON, so a hundred levels is a few megabytes.
//
// Pushed at the end of an interaction rather than per input event. The controls
// already draw that line for us: `input` fires continuously through a drag and
// `change` fires once on release, so a slider drag is one snapshot and not two
// hundred.
const UNDO_LIMIT = 100;

/**
 * Every write to the working document, in the order they were asked for.
 *
 * **The server does not order them and it is right not to.** `DocumentStore.write` gives
 * each write its own numbered scratch file precisely so two overlapping puts to one
 * document cannot share it, and then renames - so concurrent writes all succeed and the
 * last `rename` to complete is the one on disk. Which that is has nothing to do with
 * which was asked for first: they are separate connections doing separate disk work.
 *
 * That is fine for the auto-save on its own, where every write is a later state of the
 * same document and losing a race costs one interaction's worth. It is not fine next to
 * the recovery: the auto-save is fire-and-forget, so an edit made just before the
 * operator presses Restore can still be in flight, land after the restore's write, and
 * put the overwriting edit back - after the page has said "restored the autosaved edit"
 * and dropped the only other copy. A reload then loses the work a second time, having
 * twice reported it recovered.
 *
 * Chained rather than cancelled, because a write already on the wire cannot be recalled
 * and the ordering is the whole requirement - the restore has to be last, not alone.
 *
 * **The chain carries no failure forward**, which is the difference between serialising
 * and stopping: `.catch` on the link rather than on the returned promise means one
 * auto-save that failed - a dropped connection, a 500 - leaves the next write to go out
 * normally instead of silently ending persistence for the rest of the session. Callers
 * still see their own rejection on what they were handed back.
 */
let workingWrites = Promise.resolve();
function writeWorking(body) {
  const wrote = workingWrites.then(() => fetch(`/projects/${WORKING_PROJECT}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
  workingWrites = wrote.catch(() => {});
  return wrote;
}

const history = {
  stack: [],
  // What the document looked like at the end of the last interaction. Comparing
  // against it is what makes a commit that changed nothing cost nothing - which
  // is how orbiting, scrubbing and dropping render scale leave the stack alone
  // without any of them having to know that the stack exists.
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
    // Without this the stack is not merely empty, it is poisoned: `begin` only runs
    // in `openTake`, so `baseline` is null while shooting, every slider push a `null`
    // onto the stack, and the first undo afterwards hands `restoreProject` a null and
    // throws out of the keydown handler. It also stopped the auto-save writing a
    // project that names no take on every twitch of a live slider.
    if (!EDITING) return false;
    const now = this.snapshot();
    if (now === this.baseline) return false;
    this.stack.push(this.baseline);
    if (this.stack.length > UNDO_LIMIT) this.stack.shift();
    this.baseline = now;
    // Auto-save the project after every change. Fire-and-forget: a failed save is logged
    // and must not block the interaction that caused it. It used to be logged *in the UI*,
    // on the application bar's message chip, and that is why the report is here at all -
    // the chip is gone and the console is where this lands now, which means a save that
    // has been failing all session says so nowhere the operator will look. The offer to
    // restore is still the thing that recovers from it, and that one is on the bar.
    const workingBody = { ...serialiseProject(), take: { id: openTakeId, hash: openTakeHash } };
    writeWorking(workingBody).then(async (res) => {
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        console.error('[autosave]', res.status, text.slice(0, 200));
      }
    }).catch((err) => {
      console.error('[autosave]', err);
    });
    return true;
  },

  undo() {
    const previous = this.stack.pop();
    if (previous === undefined) return false;
    // Playback walks the accumulators forward one output frame at a time and they
    // cannot be walked back, so a retime curve restored underneath a running
    // playhead asks the source to go backwards on the very next step - which it
    // refuses, from inside the animation loop. Paused across the restore and
    // re-seeked afterwards, which is the same thing the speed slider does and for
    // the same reason. Playing again afterwards is deliberate: undo is about what
    // the clip is, and stopping the transport is not part of what it undoes.
    const gen = takeTransport();
    const resume = timeline ? timeline.playing : false;
    if (resume) timeline.pause();
    // The parameterisation being left, read before the restore overwrites it. An undo
    // that crosses a speed change has to carry the cuts across the same way the
    // gesture did, and it cannot do it by restoring them: `serialiseProjectBody`
    // deliberately leaves `clipIn`/`clipOut` out, because they are deliverable state
    // rather than what the clip *is*. So the keys come back inside the snapshot
    // already in the parameterisation being returned to, and the cuts - the one term
    // outside it - are the only thing left to rescale. Without this, undoing a speed
    // change puts every keyframe back and leaves the two markers where the new rate
    // had put them, which is the original bug surviving its own fix.
    const wasRate = retime.rate;
    const wasIn = clipIn;
    const wasOut = clipOut;
    this.restoring = true;
    try {
      restoreProject(JSON.parse(previous));
      this.baseline = previous;
    } finally {
      this.restoring = false;
    }
    if (retime.rate !== wasRate) {
      reparameteriseProgramTime(wasRate / retime.rate, { clipIn: wasIn, clipOut: wasOut, keys: [] });
    }
    // The playhead deliberately does not move. Undo is about what the clip is, and
    // walking the playhead backwards on every press is the behaviour that teaches
    // people not to trust it.
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

// The keyboard lives with the controls it drives - see `the timeline UI` below.

// ---------------------------------------------------------------- stream

let framesSeen = 0;
let lastFpsAt = performance.now();
let fps = 0;

// Viewport FPS: how fast renderProgramFrame is actually running, regardless of whether
// the source is live or recorded. The sensor fps above tracks arrivals over the socket;
// this tracks what the user sees.
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
    // The decode is asynchronous, so one started while the stream was still live
    // can finish after a pinned run has taken the textures over - and it would
    // switch colour back on partway through, which is a render that differs from
    // its own repeat for reasons nothing in the transport can explain.
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
    /* a torn JPEG from a dropped USB packet: skip this frame */
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

  // **The output's clock is the sensor, and this is where that is decided.** The
  // viewer runs `renderer.setAnimationLoop(liveLoop)` and draws at the display's rate,
  // interpolating between the last two depth frames to fill the gap. A source does
  // not: one arrival, one render, so every frame it produces corresponds to a frame
  // the sensor actually delivered.
  if (PROGRAM_OUT) programOutFrame();
}

// Camera settings live on the sensor, not in the shader, so the server owns them
// and the checkboxes only mirror what it reports back. Toggling colour restarts
// the grabber; low light is applied to the running one.
const colorCamEl = document.getElementById('colorCam');
const lowLightEl = document.getElementById('lowLight');
let socket = null;

function sendCamera(patch) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ camera: patch }));
}

function showCamera(state) {
  colorCamEl.checked = state.color;
  lowLightEl.checked = state.lowLight;
  // Exposure is meaningless with the colour camera off, so the control says so
  // rather than silently doing nothing.
  lowLightEl.disabled = !state.color;
  lowLightEl.parentElement.classList.toggle('disabled', !state.color);
}

colorCamEl.addEventListener('change', () => sendCamera({ color: colorCamEl.checked }));
lowLightEl.addEventListener('change', () => sendCamera({ lowLight: lowLightEl.checked }));

// ------------------------------------------------- what this monitor pulls
//
// A depth divisor and a frame stride, asked for over the socket that is already
// carrying the frames. Decimation is a network concession and never a compute one:
// the capture node sustains full rate, and this exists because a radio link cannot
// carry 14.6 MB/s while the same machine is also writing it to disk.
//
// **Nothing here ever moves on its own.** The controls are the operator's, the
// granted setting is always on screen, and a link that cannot sustain what was asked
// says so rather than quietly coarsening - an instrument that changes its own scale
// is worse than none, because coarse depth reads as a badly placed subject and a
// dropped stride reads as a sensor losing frames, and both get blamed on the room.
const monDivisorEl = document.getElementById('monDivisor');
const monStrideEl = document.getElementById('monStride');
const monAcceptCostEl = document.getElementById('monAcceptCost');
const monNoteEl = document.getElementById('monNote');

// The last setting the server confirmed, which is what the record button consults.
// Held rather than read back off the sliders, because a slider carries what somebody
// dragged it to and this has to carry what was granted.
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

  // The stride reads as a position, so it needs a real ordinal rather than a "th"
  // glued on - the slider runs to 30 and three of the values in that range would
  // otherwise read "2th", "3th", "21th". The teens are the exception the naive rule
  // gets wrong in the other direction.
  const ordinal = (n) => {
    const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th'
      : { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
    return `${n}${suffix}`;
  };

  // A frame is 486KB at full rate; the depth block scales with the divisor squared
  // and the colour block does not move at all, which is why the saving flattens.
  // Stated from the grid rather than from a table, so the number cannot drift from
  // what the sender is actually building - which this line promised for a while
  // before it was true, having spelled the two numbers out inline as a third copy.
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

// ----------------------------------------------------------------- program out
//
// The operator's surface says what the program-out source should draw, and the
// source draws it. Everything crossing that gap goes through the registry rather
// than around it: a parameter write is forwarded by the one hook every write already
// passes through, so the set of things the output honours is the set of parameters
// that exist, and a parameter added later needs no line here. The mode, the output
// size and - in mirror mode - the operator's own camera are the only things sent
// that are not parameters, because none of them is one.

/** Which camera the output frames. */
let programOutMode = 'camera';
/** The output's pixel size, which is deliberately not the window's. */
let programOutSize = { w: 1920, h: 1080 };
// What the output has actually delivered, for the readout. Counted here rather than
// inferred from a clock, because the number worth showing is frames that left this
// renderer and not frames the sensor sent.
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

/**
 * The operator's whole state, sent when a source is known to have just connected or
 * when the operator changes mode.
 *
 * **A source that joined late has to be caught up, and a per-write stream cannot do
 * it.** Parameter writes are forwarded as they happen, so a browser source opened
 * after the operator had already set up a look would render the defaults and stay
 * wrong until every slider was touched again. `params.values()` is the same door the
 * project file and the preset library read through, so this is one snapshot of the
 * registry rather than a hand-listed set of fields that could fall behind it.
 */
function sendProgramOutState() {
  sendProgramOut({
    mode: programOutMode,
    size: programOutSize,
    params: params.values(),
    view: cameraPose(freeCamera),
  });
}

/** A camera as three plain values, which is what a pose is everywhere else here. */
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
  if (patch.params) {
    // Through the registry's own write path, so a value arriving over a socket is
    // normalised, clamped and applied exactly as one typed into a slider would be.
    // A refused name throws rather than being ignored - a source silently dropping a
    // parameter it did not recognise is a source drawing something other than what
    // the operator is looking at, which is the one thing this mode must not do.
    for (const [name, value] of Object.entries(patch.params)) {
      try {
        params.set(name, value);
      } catch (err) {
        console.error(`[program-out] ${err.message}`);
      }
    }
  }
  if (patch.view && programOutMode === 'mirror') {
    freeCamera.position.fromArray(patch.view.position);
    freeCamera.quaternion.fromArray(patch.view.quaternion);
    if (freeCamera.fov !== patch.view.fov) {
      freeCamera.fov = patch.view.fov;
      freeCamera.updateProjectionMatrix();
    }
  }
}

/**
 * Draw one output frame, called when a depth frame arrives rather than on a clock.
 *
 * **One render per sensor frame, and OBS is the clock after that.** Nothing is
 * invented and nothing is repeated here - but a browser source cannot hand frames to
 * OBS, because CEF renders offscreen and OBS pulls the latest texture at its own
 * canvas rate. So the two clocks beat: on a healthy link the sensor is a flat
 * 30.00fps and the beat is negligible, and on a degraded one it is uneven and nothing
 * available here would fix it. That is accepted rather than hidden, which is what the
 * readout below is for - a rate under the declared one has to be visible where
 * somebody is judging the picture, or it gets read as the scene.
 */
function programOutFrame() {
  const now = performance.now();
  renderProgramFrame(liveTransport.positionAt(now));
  programOutDrawn++;
  if (programOutLastAt) {
    // **The interval is measured, never assumed at 30fps.** The stream is irregular -
    // a degraded link runs p50 64ms against p90 222ms - so a counter that divided by
    // a nominal 33ms would report a healthy 15fps sensor as dropping half its frames
    // and send somebody to look at a link that was fine. `deliveryMs` is the same
    // smoothed arrival spacing the vertex shader blends against, so the readout and
    // the picture are reasoning from one number.
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

/**
 * The output's own health, on the output.
 *
 * Built here rather than in `index.html` because the other two surfaces have no use
 * for it and a control that exists on a page that never shows it is a control the
 * panel check has to special-case. It is drawn into the page rather than the WebGL
 * buffer, so it never reaches the pixels OBS captures from the canvas - the readout
 * is for whoever opens the source URL in a browser to see whether it is healthy.
 */
let programOutReadout = null;
function paintProgramOutReadout() {
  if (!programOutReadout) return;
  // **A source fed by a coarsened stream says so.** A program-out page on a capture
  // node over Wi-Fi is served at the recording cap, and an output that quietly
  // upscaled ÷4 depth to 1080p would be handing somebody a coarse picture with no
  // way to tell it from a badly placed subject - which is the misattribution the
  // monitor negotiation exists to prevent, arriving through a different door.
  const decim = monitorState && (monitorState.divisor > 1 || monitorState.stride > 1)
    ? `  ÷${monitorState.divisor} ×${monitorState.stride}`
    : '';
  programOutReadout.textContent = `PROGRAM OUT  ${programOutMode}  `
    + `${programOutSize.w}x${programOutSize.h}  ${programOutFps.toFixed(1)} fps  `
    + `${programOutMissed} missed${decim}`;
}

/**
 * The operator's two controls, and the URLs to paste into OBS.
 *
 * Wired only on a surface somebody is sitting at. A source loads the same file and so
 * has these elements too, and letting it drive them would be a source telling itself
 * what to draw a beat after being told by the operator.
 */
if (!PROGRAM_OUT && progModeEl) {
  progModeEl.addEventListener('change', () => {
    programOutMode = progModeEl.value;
    // The whole state rather than the one field, because switching to mirror is the
    // moment the source first needs a pose and it has never been sent one.
    sendProgramOutState();
  });
  progSizeEl.addEventListener('change', () => {
    const m = /^\s*([1-9][0-9]*)\s*x\s*([1-9][0-9]*)\s*$/.exec(progSizeEl.value);
    if (!m) {
      // Put back rather than left showing something that is not in force. The one
      // property every readout in this program holds is that what is on screen is
      // what is set, and a rejected size that stayed in the box would break it.
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
    // Asked for rather than waited for. OBS reconnects a browser source on its own
    // schedule - a scene change, a reload, the machine waking - and each time it is a
    // fresh page that knows nothing about the look currently set.
    if (PROGRAM_OUT) ws.send(JSON.stringify({ programOut: { hello: true } }));
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      const msg = JSON.parse(event.data);

      if (msg.status) {
        sensorState = {
          live: '', starting: 'sensor starting…', lost: 'sensor lost — restarting',
          // Not a fault to wait out, so it does not say "restarting": this is the
          // editing station, and the footage is on the node.
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

      // Any connected client can arm or stop a take, so every connected monitor
      // has to see the state change - that is the whole reason record state is
      // broadcast rather than answered only to whoever asked.
      if (msg.recording) {
        recordState = msg.recording;
        paintRecord(null);
        chromeStale = true;
        drawChrome();
        return;
      }

      // What the server granted this monitor, which is not always what it asked
      // for. Rendered from the answer rather than from the request, because the one
      // property this negotiation has to hold is that the setting on screen is the
      // setting on the wire.
      if (msg.monitor) {
        showMonitor(msg.monitor);
        return;
      }

      // What the operator wants drawn. Ignored on any page that is not a source, so
      // two operator surfaces open at once do not start applying each other's writes.
      //
      // **A source announces itself and the operator answers with everything**,
      // because a per-write stream cannot catch up a latecomer: a browser source
      // opened after the look was set would render the defaults and stay wrong until
      // every slider was touched again. This is the one message that travels from a
      // source toward an operator, and it carries nothing but the fact of arriving.
      if (msg.programOut) {
        if (msg.programOut.hello) {
          if (!PROGRAM_OUT) sendProgramOutState();
        } else {
          applyProgramOut(msg.programOut);
        }
        return;
      }

      // **The hello is recognised rather than reached by falling through, and that
      // is a fix rather than a tidy-up.** Every branch above returns, so this used
      // to be the else-case for anything unrecognised - which meant a message type
      // added later did not fail, it set `focal` to (undefined, undefined). Every
      // point then unprojects to NaN and the viewer renders an empty frame with no
      // error anywhere, on a page that looks fine. Step 9's monitor message landed
      // exactly here and `library-check` caught it as fifteen identical renders.
      //
      // Tested on the hello's own fields because the payload is written into the
      // take verbatim, so there is no discriminator the server could add without
      // changing the file format. `serial` and the four intrinsics are what the
      // grabber always emits (`native/grabber.cpp:375-381`).
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

      // Loud rather than ignored. A message this page does not understand means the
      // server is ahead of it, and the failure that produces is silent by nature.
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

// Live acquisition has to be able to go away. A timeline render or an export
// pulls its frames from a file, and an arrival landing in the depth textures
// underneath one of those would corrupt the image it was asked to reproduce.
function detachStream() {
  streamDetached = true;
  socket?.close();
  // The socket closing does not stop a frame that has already been parsed, so
  // the queued JPEG goes too and any decode still in flight drops its result.
  pendingColor = null;
  sensorLabel = 'stream detached';
  setStatus();
}

// ------------------------------------------------------------------ transport

// Program time is the coordinate everything below reads: output seconds from the
// start of the edit. A transport is the only thing that answers "what time is
// it", and live viewing is the degenerate case of one rather than an exception -
// the playhead is pinned to the newest arrival instead of being dragged along a
// timeline or stepped at k / outputFps. That is what stops the live path drifting
// from what the editor and the export renderer produce, since there is only ever
// one clock and one image pipeline.
//
// Acquisition is a separate axis, below the renderer. A pair source answers which
// two capture frames bracket a program position and how far between them the
// playhead sits, and it is the only thing that knows where the bytes came from -
// live pushes arrivals in over the socket, and step 2's indexed source will pull
// them through the frame API. Both converge on the same two depth textures, so
// the renderer never learns which one fed it.
//
// A source hands back the frames the playhead crossed as *steps*, oldest first,
// each carrying the gap the sensor recorded before it and knowing how to make its
// own depth current. The surface memory has to see each frame in turn, so a bare
// list of gaps would leave step 4's pre-roll comparing the newest depth against
// itself and computing a wake that never happened.

const NOMINAL_GAP_MS = 1000 / 30;
// Past this, a stamp step is a take boundary rather than a stall. The sample
// capture has a real 1448ms gap in it, so the threshold has to sit well clear of
// what a struggling sensor produces or genuine stalls get repaired away.
const DISCONTINUITY_MS = 5000;
const noop = () => {};

// What the instrument reads instead of taking the transport's word for anything.
// A check that asks "did the seek reset the accumulators" has to be able to see
// that it did, or it is asserting the claim rather than enforcing it.
const counters = {
  renders: 0, stateAdvances: 0, resets: 0, drafts: 0, seeks: 0, requests: 0, framesFetched: 0,
  navigationRedraws: 0, navigationHistoryClears: 0,
  // The lane rebuild is the expensive one - it resizes the drawing buffer - and the
  // reposition is the cheap one. Counted separately because "a drag no longer rebuilds"
  // is a claim about which of the two ran, and a check that timed the drag instead
  // would pass on a fast machine that rebuilt every move.
  laneRebuilds: 0, laneRepositions: 0, laneFallbacks: 0,
};

// The one function mapping program time to source time. Everything above it works
// in program time - the playhead, the look, the camera, every keyframe - and
// everything below it works in source time, because that is what a capture is
// addressed in. A constant slope is normal speed, a shallow one slow motion, a
// zero one a hold.
//
// It is an ordinary track in program time, evaluated by the same scalar code every
// look track goes through, and its value *is* a source second. That is what makes a
// speed ramp another track rather than a case inside the renderer, and it is why
// export needs no inverse: the playhead is already the coordinate the keys are in.
//
// `rate` is the slope wherever the curve has nothing to say - with no keys at all,
// which is what a clip starts as, and with the single origin key the first ramp
// creates. The speed slider writes it, so a clip with no retime keys behaves
// exactly as it did before there was a curve.
const retime = {
  rate: 1,
  // Ascending in `t`, and the first is always at program 0 once there are any. A
  // curve that started somewhere else would leave the first frame of the edit to
  // an extrapolation rule, so `keyRetime` plants the origin rather than letting
  // that be implicit.
  keys: [],

  sourceSecAt(programSec) {
    const keys = this.keys;
    if (keys.length === 0) return programSec * this.rate;
    if (keys.length === 1) return keys[0].value + (programSec - keys[0].t) * this.rate;
    return scalarAt(keys, programSec, EXTEND_ENDS);
  },

  // The local slope, in source seconds per program second. A pre-roll needs it to
  // turn fade and wake - which are source milliseconds and stay that way - into a
  // number of output frames, and step 6's audio gate reads it to decide whether
  // the take is playing at 1.0.
  slopeAt(programSec) {
    if (this.keys.length < 2) return this.rate;
    return scalarSlopeAt(this.keys, programSec);
  },

  /**
   * How many output frames back the curve has to reach for a pre-roll to cover
   * `sourceSpanSec` of source time ending at `programSec`.
   *
   * This is the question the pre-roll actually has, and reading `slopeAt` at the
   * target was the wrong answer to it the moment the slope stopped being
   * constant: slope-at-a-point times a frame count is the tangent line, not the
   * curve, so a ramp under-rolls on the shallow side and over-rolls on the steep
   * one. A hold is the extreme of that - the slope there is zero, no multiple of
   * it covers any source span at all, and the old arithmetic answered "no frames
   * needed" for the one case that needs the most. The surface memory holds what it
   * held before the hold began, so a correct pre-roll walks back *through* the
   * hold to where source time was last moving, and that is what this counts.
   *
   * Walked frame by frame rather than integrated in closed form, because a
   * pre-roll is a run of `renderProgramFrame` calls on the output frame grid and
   * nothing else - the number wanted is how many of those, so counting them is
   * the answer rather than an approximation of it.
   */
  framesBackFor(programSec, sourceSpanSec, outputFps, ceiling) {
    if (!(sourceSpanSec > 0)) return { frames: 0, covered: true };
    const at = this.sourceSecAt(programSec);
    const limit = Math.max(0, Math.floor(ceiling));
    for (let n = 1; n <= limit; n++) {
      if (at - this.sourceSecAt(programSec - n / outputFps) >= sourceSpanSec - 1e-9) {
        return { frames: n, covered: true };
      }
    }
    // A whole edit's worth of output frames that never covered the span. Reported
    // rather than rounded up to something plausible: the honest reading is that
    // this look cannot be warmed up on this curve, and a caller that wants to seek
    // anyway now knows its image is short rather than believing it is complete.
    return { frames: limit, covered: false };
  },

  /**
   * The program position a source position sits at. Export never needs it - that
   * is the whole point of keying in program time - and it is here for the two
   * places a source bound has to become a program bound: shortening a pre-roll to
   * the source frames the cache can hold, and asking how long the program is.
   *
   * Answered by searching the keys, which is legitimate precisely because it is
   * not on the render path. A curve with a hold in it is not injective, so this
   * returns the *first* program time reaching the source position, and a curve
   * that never reaches it returns where the curve ends.
   */
  programSecAt(sourceSec) {
    const keys = this.keys;
    if (keys.length === 0) return sourceSec / this.rate;
    if (keys.length === 1) return keys[0].t + (sourceSec - keys[0].value) / this.rate;
    if (sourceSec <= keys[0].value) {
      const slope = segmentSlope(keys, 0, 0);
      return slope > 0 ? keys[0].t - (keys[0].value - sourceSec) / slope : keys[0].t;
    }
    for (let i = 0; i < keys.length - 1; i++) {
      if (keys[i + 1].value < sourceSec) continue;
      // Bisected rather than solved, because the segment is an eased cubic and its
      // inverse has no useful closed form. Fifty halvings of a segment is well
      // under a microsecond and this runs once per seek, never once per frame.
      let lo = keys[i].t;
      let hi = keys[i + 1].t;
      for (let k = 0; k < 50; k++) {
        const mid = (lo + hi) / 2;
        if (this.sourceSecAt(mid) < sourceSec) lo = mid;
        else hi = mid;
      }
      return hi;
    }
    const last = keys[keys.length - 1];
    const slope = segmentSlope(keys, keys.length - 2, 1);
    // A curve that ends flat or falling never reaches any later source position,
    // so the program ends with the curve. The footage past there is unreachable
    // through this edit, which is a statement about the edit rather than a fault.
    return slope > 0 ? last.t + (sourceSec - last.value) / slope : last.t;
  },

  // How long a program is, given a source that long. It lives here rather than as
  // a division at the transport, because a curve answers it by searching and a
  // caller reaching for `rate` would be a third door into a seam that promises
  // two - which is the drift this design keeps refusing one layer up.
  programDurationFor(sourceSec) { return Math.max(0, this.programSecAt(sourceSec)); },

  /**
   * Refuses a curve that runs downhill. Non-decreasing is the invariant: equal
   * values are a hold and are legal, falling values are a reverse and are not.
   *
   * A reverse is not merely unimplemented, it is unreachable by construction. The
   * surface memory and the afterimage are advanced one source frame at a time and
   * neither can be walked back, so a descending segment asks the pair source to go
   * backwards and it refuses - from inside the animation loop, which three then
   * stops driving. The spec reaches for "a hold or a reverse" when arguing that
   * keying in source time needs an inverse, which reads as though a reverse ought
   * to be authorable; it is not, on this renderer, and that is a limitation rather
   * than an oversight.
   */
  assertMonotonic(keys) {
    for (const key of keys) {
      // Handles first, because a curve can run downhill without any pair of key
      // values doing so. Ascending keys with an outgoing y handle above 1 overshoot
      // past the later value and come back down inside the segment, which is a
      // reverse that a values-only check cannot see - and on a capture whose frames
      // are 107ms apart a shallow one hides inside single brackets, so `mixT` walks
      // backwards within a pair and the reverse renders silently rather than being
      // refused. x is checked for a different reason: outside the unit range the
      // timing curve is no longer single-valued in time, so the segment has two
      // values at one instant.
      //
      // Inside the unit box both are safe, and that is a property rather than a
      // hope: a cubic with ordinates 0, a, b, 1 has derivative
      // `3[a s² + 2(b−a)st + (1−b)t²]` for s = 1−u, t = u, which is non-negative
      // throughout [0,1]² - at worst zero, at a = 1, b = 0, where it is `3(1−2u)²`.
      //
      // **That proof is about a cubic, and the segment is only a cubic while each side
      // holds one control point.** Look and camera tracks can grow a side past that -
      // see `SEGMENT_POINT_CEILING` and the `+pt` control - and the argument above does
      // not survive the elevation: a quintic with ordinates 0, 1, 0, 1, 0, 1, every one
      // of them inside the box, oscillates. So the retime asserts the degree rather
      // than inheriting a guarantee written for a different curve. It is an assertion
      // and not a clamp because nothing offers the retime a second point: reaching here
      // with one means a document or a caller got past the gates that stop it, and the
      // honest answer to a curve this cannot vouch for is to refuse it by name.
      for (const [side, h] of [['easeOut', key.easeOut], ['easeIn', key.easeIn]]) {
        if (h.length !== 1) {
          throw new Error(
            `the retime key at program ${key.t}s has a ${side} handle of ${h.length} control `
            + 'points: the retime curve is a cubic, because the proof that a handle inside the '
            + 'unit box cannot run source time backwards is a proof about a cubic and about '
            + 'nothing else',
          );
        }
        if (!h[0].every((c) => c >= 0 && c <= 1)) {
          throw new Error(
            `the retime key at program ${key.t}s has a ${side} handle at `
            + `[${h[0].join(', ')}]: a handle outside the unit box bends the curve back on `
            + 'itself inside the segment, and source time cannot run backwards',
          );
        }
      }
    }
    for (let i = 1; i < keys.length; i++) {
      if (keys[i].value < keys[i - 1].value) {
        throw new Error(
          `the retime curve falls from ${keys[i - 1].value}s to ${keys[i].value}s between `
          + `program ${keys[i - 1].t}s and ${keys[i].t}s: source time cannot run backwards, `
          + 'because neither accumulator can',
        );
      }
    }
    return keys;
  },

  serialise() {
    return {
      rate: this.rate,
      keys: this.keys.map((k) => ({
        t: k.t, value: k.value, easeOut: copyHandle(k.easeOut), easeIn: copyHandle(k.easeIn),
      })),
    };
  },
};

/**
 * Every program time, rescaled by `k`. Changing the slope is what does this to them.
 *
 * **This is the same fix the playhead already got, applied to the class it belongs
 * to.** `beginRateGesture` holds *source* time across a speed change because program
 * and source are the same number only at rate 1: park at program 10s, go from 1x to
 * 2x, and program 10s is now source 20s - a different moment in the take under a
 * playhead that did not move. That argument says nothing about the playhead
 * specifically. It is true of anything measured in program time, and three such
 * things were left behind: the clip's `in` and `out`, the deliverable's copy of them,
 * and the `t` on every key of every track.
 *
 * The screenshots that started this are the arithmetic of it. Source runs ~960s, so
 * the ruler ends at 800s at 1.20x and at 408s at 2.35x, while `in`/`out` stayed pinned
 * at 234.509/407.612 program seconds - which puts the out cut at 50.3% of the ruler in
 * one and 99.5% in the other. Nothing moved; the ruler rescaled underneath markers
 * that did not. And the export followed the markers, so a speed change silently
 * changed which footage the file would contain.
 *
 * `k` is `oldRate / newRate` and the map is exactly uniform, which is a fact about
 * when this can run rather than a simplification. The slider is disabled the moment
 * the retime carries keys (see `timingChanged`), so the only slope this ever changes
 * is the keyless one, where `sourceSec = programSec * rate` everywhere at once. There
 * is no general-curve case to handle and writing one would be writing for a caller
 * that cannot exist. The retime's own keys are untouched for the same reason: if
 * there were any, nothing would be calling this.
 *
 * Ease handles are fractions of their segment, so a uniform stretch leaves them
 * alone - there is no fourth term hiding in them.
 *
 * `was` is where the times are read *from*, rather than the live values being
 * multiplied in place, and that is what makes a drag exact: a slider emits dozens of
 * `input` events, and a product of dozens of per-event factors is not the same number
 * as one factor from where the gesture started. Same reason `rateGesture` captures its
 * source anchor once instead of re-deriving it per event.
 */
function reparameteriseProgramTime(k, was) {
  for (const [key, t] of was.keys) key.t = t * k;
  // Through the one door the cuts have, so the deliverable's copy and the readouts
  // follow rather than being written a second time here. It also keeps the playhead
  // inside the range, which is why the caller moves the playhead to its anchor
  // *before* calling this: both scale by the same `k`, so a playhead that was inside
  // the range is still inside it and this costs a repaint rather than a seek.
  setClipInOut({ in: was.clipIn * k, out: was.clipOut === null ? null : was.clipOut * k });
}

/** Where a later rescale reads its times from. Live objects, and the `t` they had. */
const programTimeSnapshot = () => ({
  clipIn,
  clipOut,
  keys: [...tracks.values()].flatMap((track) => track.keys.map((key) => [key, key.t])),
});

class LivePairSource {
  constructor() {
    // The pair's stamps are a program clock built by accumulating the gaps the
    // sensor itself reported, so the playhead advances on capture cadence rather
    // than on however fast the socket happened to deliver.
    this.tA = 0;
    this.tB = 0;
    this.arrivedAtMs = 0;
    // Two smoothed intervals with different jobs, and conflating them is the
    // mistake to avoid. sourceGapMs stands in for a capture gap the stamps cannot
    // supply, and it is source time. deliveryMs is how long the pair is expected
    // to stay the newest one, and it is wall time - measured rather than assumed
    // at 30fps, because this stream is irregular and guessing wrong stutters
    // worse than not blending at all.
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

    // A replay loops its capture back to the start and a grabber restart opens a
    // new take, so the stamp can go backwards or leap a long way, and there the
    // smoothed gap stands in - program time only ever moves forward, because a
    // playhead that went backwards would walk the accumulators into a state no
    // sequence of frames could have produced. A merely long gap is not that: it
    // is a stall the sensor genuinely had, and the sample capture contains one of
    // 1448ms. Averaging it away would age the surface memory by a twentieth of
    // the time that actually passed and leave wakes alive that should have gone.
    const gap = (raw > 0 && raw < DISCONTINUITY_MS) ? raw : this.sourceGapMs;
    // The smoothed value only has to be a plausible stand-in, so the outliers stay
    // out of it even though they are used as they are above.
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

  at(programSec) {
    const steps = [];
    if (this.pendingFrames > 0) {
      // Only two depth textures exist on this path, so a burst of arrivals inside
      // one display interval has already overwritten the frames in between and
      // their pixels are gone. One step carrying the summed gap is the best that
      // can be done here; the indexed source can fetch every crossed frame, which
      // is what an accurate seek needs and what this cannot give.
      steps.push({ gapSec: this.pendingGapMs / 1000, makeCurrent: noop });
      this.pendingGapMs = 0;
      this.pendingFrames = 0;
    }

    // **This half of the seam is in milliseconds and the indexed half is in seconds**,
    // which is why the field carries its unit in its name and why the conversion is
    // written at each site rather than once downstream. The two `at` implementations are
    // the only producers, they keep their times in different units for good reasons of
    // their own - stamps arrive as integer milliseconds and a capture index is seconds -
    // and a seam whose field name said only "span" would take a thousandfold error from
    // either side without anything reading it noticing.
    //
    // Nothing in the suite renders this branch: `registry-check` intercepts the socket so
    // no frame ever arrives, and every pinned or indexed run is the other class. The
    // agreement between the two is held by the unit being in the name and by there being
    // exactly two sites, which is worth stating as the limit it is rather than leaving as
    // a thing a reader assumes is covered.
    const spanMs = Math.max(1, this.tB - this.tA);
    const offsetMs = Math.min(Math.max(programSec * 1000 - this.tA, 0), spanMs);
    return { steps, mixT: offsetMs / spanMs, sinceFrameSec: offsetMs / 1000, spanSec: spanMs / 1000 };
  }
}

class LiveTransport {
  constructor(source) { this.source = source; }

  /**
   * Live is the one transport that reads a wall clock, and it reads it for a
   * single purpose: deciding where inside the current pair's gap the playhead
   * sits, so a 30fps stream still blends and fades smoothly on a 120Hz display.
   * What comes out is a program position, so nothing downstream can drift with
   * how long the tab has been open.
   */
  positionAt(wallMs) {
    const s = this.source;
    if (!s.arrivedAtMs) return 0;
    // Walk across the pair over one expected delivery interval, then hold. The
    // clock only picks a position inside the gap - how far program time advances
    // is the recorded gap and nothing else - so the wall clock decides pacing and
    // never duration. Pacing to delivery rather than to the capture gap is
    // deliberate: over a link slower than the sensor the two differ, and a
    // playhead that reached the newest arrival early would sit there juddering
    // instead of moving. Holding rather than extrapolating past it is the other
    // half of that - a late frame extrapolated would overshoot into garbage.
    const frac = Math.min(1, (wallMs - s.arrivedAtMs) / Math.max(1, s.deliveryMs));
    return (s.tA + frac * (s.tB - s.tA)) / 1000;
  }
}

const livePairs = new LivePairSource();
const liveTransport = new LiveTransport(livePairs);
let pairSource = livePairs;

// ------------------------------------------------------------- render pipeline

// One ping-pong step of the surface memory, advanced by exactly one source frame.
// The transport calls it once per capture frame the playhead crosses, with that
// frame's own recorded gap, because the memory describes the sensor's timeline
// rather than the display's - and because a seek has to be able to walk it
// forward at will, which is impossible while "a frame arrived" is what drives it.
function advanceSurfaceState(dtSec) {
  counters.stateAdvances++;
  // The upper bound is the discontinuity gate and nothing tighter. A lower one
  // would undo the gate a layer down: the sample capture's real 1448ms stall
  // would arrive here and be truncated, so wakes born before the stall would
  // survive it with life left over - which is the failure the gate exists to
  // prevent. Anything past the gate never reaches this call.
  //
  // Clamped on this side of the boundary because the gate is the transport's number
  // and the snap threshold is the look's; what the memory is handed is a gap it can
  // trust, and both of the decisions behind it stay where their reasons are.
  stepSurfaceMemory(
    Math.min(DISCONTINUITY_MS / 1000, Math.max(0.001, dtSec)),
    uniforms.snapDelta.value,
  );
  // Read after the step, which has swapped: `statePrev` names the target just rendered
  // into, and it is a live import rather than a copy, so this is the state this call
  // produced rather than the one before it.
  uniforms.stateTex.value = statePrev.texture;
}

let lastProgramTime = 0;

// Screen-space history belongs to the camera pose that produced it. Carrying it
// across a different pose overlays the old view on the new one: Three's afterimage
// pass takes the component-wise maximum of the current pixel and the damped old
// pixel, so a pan raises the frame's luminance until the camera stops. The camera
// used by the render is compared here rather than inferred from OrbitControls
// events. That covers the program camera, auto-orbit and camera-view switches too,
// and it leaves one policy at the seam every surface and export already shares.
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
  // Three exposes no reset on the afterimage pass, so its two buffers are reached
  // for directly. They are the whole of its state at 0.185.1, and the check makes an
  // upstream rename loud instead of clearing the canvas while stale history survives.
  clearFeedback(
    [afterimage._textureComp, afterimage._textureOld],
    'afterimage internals moved: camera history can no longer be cleared safely',
  );
}

// Clears both feedback paths. Neither can be walked backwards, so an accurate
// seek clears them and pre-rolls forward from a known state - and all zeroes is
// that state, since a zero last-depth reads as invalid and the first frame after
// it comes through as births rather than as swaps.
function resetAccumulators() {
  counters.resets++;
  // Three exposes no reset on the afterimage pass, so its two buffers are reached
  // for directly. They are the whole of its state at 0.185.1, and the check is
  // there because a rename on upgrade would fail silently: setRenderTarget of
  // undefined binds the canvas instead, the clear lands nowhere, and the seek
  // would quietly carry the previous image's trails into its pre-roll.
  clearFeedback(
    [statePrev, stateNext, afterimage._textureComp, afterimage._textureOld],
    'afterimage internals moved: the accumulator reset is no longer complete',
  );
  lastProgramTime = 0;
}

// Where an export takes its bytes, and it is one position rather than a callback
// on every frame.
//
// The readback has to happen in the same task as the render that produced it -
// nothing preserves the drawing buffer across a paint - and `renderProgramFrame`
// is the only thing that renders, so this is the only place that is certainly
// true. A callback on every frame would be simpler and much worse: a seek's
// pre-roll renders dozens of frames nobody wants, `readPixels` is a full GPU
// stall, and paying one per discarded frame would put the cost of an accurate
// seek into every exported frame. So the export names the program position it
// wants, and the sink fires when the render is at it - which a pre-roll's
// positions never are, since both sides divide the same integer frame by the same
// output rate.
let frameSink = null;

// One image at one program position. This is the whole seam: the timeline and the
// export transports drive exactly this call, and an accurate seek is nothing more
// than running it repeatedly at earlier positions and throwing the results away.
function renderProgramFrame(t) {
  counters.renders++;
  // Viewport fps: count renders per second so the stats panel shows actual redraw rate.
  viewportRenders++;
  const now = performance.now();
  if (now - lastViewportFpsAt >= 1000) {
    viewportFps = (viewportRenders * 1000) / (now - lastViewportFpsAt);
    viewportRenders = 0;
    lastViewportFpsAt = now;
  }
  chromeStale = true;
  evaluating = true;
  try {
    // The one place program time becomes source time. Live is the degenerate case
    // - a rate of 1 with the playhead built out of the capture's own gaps, so the
    // mapping is the identity and the live path is unchanged by having it here.
    const frame = pairSource.at(retime.sourceSecAt(t));
    for (const step of frame.steps) {
      step.makeCurrent();
      advanceSurfaceState(step.gapSec);
    }

    uniforms.mixT.value = frame.mixT;
    uniforms.sinceFrameSec.value = frame.sinceFrameSec;
    // The gap the two bound frames are actually separated by, which is the denominator
    // the vertex stage turns a depth difference into a speed with. It is written here
    // beside the other two rather than derived in the shader because the obvious
    // reconstruction - the time since the older frame over the fraction across the pair -
    // divides by zero at the head of every pair, which is precisely where an accurate
    // seek lands.
    uniforms.spanSec.value = frame.spanSec;
    uniforms.time.value = t;
    grade.uniforms.time.value = t;

    // Every track, look and camera alike, written through the registry rather than
    // onto the uniforms and the camera object. That is what makes the camera a
    // parameter with a kind rather than something the render path happens to move,
    // and it is why a project file, a preset and an evaluated frame are the same
    // operation. A clip with no keys writes nothing and the registry's own values
    // stand, which is a locked-off camera and a static look.
    evaluateTracks(t);

    // Temporal source history remains valid while the camera is still. A changed
    // camera is a different projection, so only the screen-space feedback is
    // discarded; the surface-state texture still describes the same room and must
    // survive the navigation. This happens after track evaluation because that is
    // where the program camera moves.
    if (renderedCameraChanged()) {
      clearAfterimage();
      counters.navigationHistoryClears++;
    }

    const dt = Math.max(0, t - lastProgramTime);
    lastProgramTime = t;

    // The delta goes in explicitly because the composer falls back to a clock of
    // its own when render() is called bare, which would put a wall clock back
    // inside the seam even though no pass in this chain reads the delta today.
    //
    // The timer brackets the draw and only while somebody has the stats overlay open,
    // so every path that is not being watched - every proof tool, every export, every
    // pre-roll frame - issues exactly the calls it issued before this existed. A query
    // writes no pixels either way; the gate is about not adding GL calls to the seam
    // that `determinism-check` compares.
    const timing = statsVisible;
    const timerGl = timing ? renderer.getContext() : null;
    if (timing) gpuTimer.begin(timerGl);
    if (postEnabled()) composer.render(dt);
    else renderer.render(scene, viewCamera);
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
    evaluating = false;
  }
}

// Navigation's own clock, kept out of the seam. The controls mutate the free
// camera by accumulation, so calling them from inside `renderProgramFrame` would
// make two renders at the same program time produce different images - the exact
// coupling this step removes, arriving through a different door. They stay out
// here, and they read a delta of their own rather than the one the render keeps.
let lastNavTime = 0;

// Auto-orbit is the one thing the controls advance on a delta, and it gets the
// program delta rather than a wall clock, so the same orbit renders the same way
// at any output frame rate. The stall behaviour falls out of that: program time
// does not advance without frames, so the delta is zero and the orbit holds still
// instead of lurching when the next one lands. Both transports drive it, which is
// why it is a function of the position rather than a line inside the live loop.
function advanceNavigation(t) {
  controls.update(Math.max(0, t - lastNavTime));
  lastNavTime = t;
}

/**
 * How often the live cloud is allowed to be drawn, in hertz.
 *
 * **This is a capture-rate control wearing a rendering control's clothes, and the
 * measurement is the only reason to believe that.** On the capture node the depth solve
 * and this cloud are the same GPU: libfreenect2 is built on OpenGL here because the
 * Pi's V3D has no OpenCL, so `OpenGLDepthPacketProcessor` and `renderProgramFrame`
 * queue behind each other. The sensor delivers on a 33.3ms interval and the processor
 * drops the packet it is still busy for, which makes delivered frames a step function
 * of solve time rather than a slope: under 33.3ms every frame lands, over it every
 * other frame is lost and the take is written at half rate.
 *
 * Measured on the Pi, two interleaved rounds of 35s settle and a 40s window, eight
 * samples an arm, `clients=1` in both so a viewer was genuinely attached:
 *
 *     drawing at the display's rate   44.6ms solve   15.13 fps delivered
 *     not drawing at all              29.7ms solve   24.07 fps delivered
 *
 * So the drawing is the cost, and it is the *rate* of drawing rather than the amount
 * of data drawn. That distinction is what the monitor's own `depth ÷` and `every Nth`
 * cannot reach: they decimate what the server sends, and this loop redraws the last
 * cloud it has at the display's rate whatever arrives. Sweeping both to their caps
 * moved delivery 15.03 to 15.60 - four percent of a deficit of fourteen and a half -
 * while the solve went 46.0ms to 39.3ms and never crossed 33.3. A term that cannot
 * cross the threshold cannot change the answer, however far it is turned.
 *
 * Unconditional rather than raised only while a take is rolling, and that is a
 * deliberate narrowing of what this is allowed to be. Gated on `recordState.recording`
 * the machine would behave differently in two states and the picture would visibly
 * change smoothness at the moment somebody pressed record, which is the worst moment
 * to hand an operator a new variable - and the take that matters most is the one being
 * lined up in the seconds before that press. One rate, always, is also the only version
 * of this that can be measured without recording anything.
 *
 * Read through a binding rather than baked into the loop so `__kinect` can sweep it,
 * which is what the handle block calls poking at the scene from the console. One
 * variable, one reader, so a swept value and a shipped value are the same code path.
 */
let cloudDrawHz = 15;
let lastCloudDrawAt = 0;

function liveLoop() {
  const now = performance.now();
  const t = liveTransport.positionAt(now);
  // Outside the gate on purpose. This is the damping and the auto-orbit, it touches no
  // GPU, and it is what makes the camera arrive where a gesture asked - skipped with
  // the drawing, a drag would step at the draw rate *and* land somewhere else, which
  // is a second fault wearing the first one's symptom.
  advanceNavigation(t);
  // A cap of zero or less is off, which is what a sweep sets to take its control arm.
  //
  // Only this surface is capped, and it is capped by which loop it runs rather than by
  // a test of which surface it is: `liveLoop` is installed in the recorder branch alone.
  // The editor drives `timeline.tick` and `pumpParkedDraft` from its own loop and never
  // reaches here, and the program-out source has no animation loop at all - it renders
  // once per arrival, which is the whole reason a frame it produces corresponds to a
  // frame the sensor delivered. So neither can be slowed by this, and neither needed a
  // condition written to say so.
  if (cloudDrawHz > 0 && now - lastCloudDrawAt < 1000 / cloudDrawHz) {
    if (chromeOn) drawChrome();
    if (programOutMode === 'mirror') streamMirrorPose();
    return;
  }
  lastCloudDrawAt = now;
  renderProgramFrame(t);
  // The top-down and stats overlays, redrawn after the frame that marked them stale.
  // Without this, chrome on the record surface freezes while the main picture moves.
  if (chromeOn) drawChrome();
  // Mirror mode's pose, sent from the loop because that is where the orbit camera
  // has finished moving for this frame. Rate-limited to the sensor's own cadence
  // rather than the display's: the source draws once per arrival, so a pose sent at
  // 120Hz would be three poses discarded for every one that reaches a frame.
  if (programOutMode === 'mirror') streamMirrorPose();
}

// The last pose sent, so a still camera sends nothing at all. An operator who is not
// touching the mouse should not be generating socket traffic, and on a capture-node
// link that traffic competes with the frames.
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

// -------------------------------------------------------------- indexed frames

// The pull half of the acquisition axis. Live cannot be asked for a frame the
// sensor has not produced; a timeline knows exactly which frame it wants, so it
// binary-searches step 2's index and fetches through the HTTP frame API. What it
// hands back is the same shape the pushed source hands back, so the renderer
// never learns which one fed it.

// How many frames stay decoded. Depth is 434KB and a registered colour bitmap
// about 868KB, so this is the memory ceiling in the browser rather than a tuning
// knob - 192 frames is roughly 180MB with colour on half of them, and it has to
// cover the longest pre-roll a slow damp can ask for.
const CACHE_FRAMES = 192;
// The most frames one call may ask to have resident at once, kept below the cache
// so a span always has room for the two bitmaps the colour textures are holding
// and for the pair at the target. A pre-roll can reach past this: the trails half
// is a count of output frames independent of the rate, so its source span is
// `frames * rate / outputFps`, and a damp of 0.97 at 4x with 24fps out spans 25
// seconds of source - every one of those a slider value. The seek clamps and says
// what it dropped rather than asking for more than can be held.
const MAX_SPAN_FRAMES = CACHE_FRAMES - 16;
// How many frames one range request covers. The endpoint will serve any run, but
// the response is buffered whole in the browser, so the request is chunked to
// bound that allocation at about 16MB.
const RUN_FRAMES = 32;
// How far ahead playback keeps the cache filled, in output frames. A fetch is
// about a millisecond and an output frame is 33, so this only has to absorb a
// stall rather than hide the latency.
const PREFETCH_FRAMES = 30;
const KNCT_MAGIC = 0x4b4e4354;
const KNCT_HEADER = 12;

// The walk every source that can address a capture by time performs, written
// once. Bracket a source position, hand back each frame the playhead crossed with
// the gap the sensor recorded before it, and refuse to move backwards without a
// reset. The pinned run and the indexed pull are genuinely the same shape and
// were written out twice, which had already begun to drift - one clamped a
// negative gap and the other did not - so the only thing a subclass says is where
// a frame's bytes come from.
//
// Live is not one of these and stays separate on purpose: it cannot be asked for
// a frame the sensor has not produced, so it has no bracket to search and no
// frame to make current.
class StampedPairSource {
  /** @param times source seconds from the first frame, ascending. */
  constructor(times) {
    if (times.length < 2) throw new Error(`a pair source needs two frames, got ${times.length}`);
    this.times = times;
    // The accumulators have been walked through this frame.
    this.applied = -1;
  }

  get count() { return this.times.length; }

  get duration() { return this.times[this.times.length - 1]; }

  /** The frame at or before `sourceSec`, as the lower half of a bracketing pair. */
  bracket(sourceSec) {
    let lo = 0;
    let hi = this.count - 2;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.times[mid] <= sourceSec) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Puts the walk back at frame `i`, so the next `at` emits `i` and `i + 1` as
   * its steps. Both a draft scrub and an accurate seek need it for the same
   * reason: the accumulators have just been cleared, so the source's record of
   * how far they were walked no longer holds.
   */
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

    // The pair is (i, i+1) and the accumulators have been walked through i+1,
    // which is the same relationship live holds between its two arrivals. Moving
    // backwards past that leaves them describing a future that has not happened,
    // and there is no way to walk them back - the caller has to reset and seek
    // the walk forward. Refusing is the point: a transport that forgets to reset
    // before a backward seek is this design's likeliest integration bug, and
    // silently re-ageing the accumulators would hand it a subtly wrong image
    // instead of an error.
    if (i + 1 < this.applied) {
      throw new Error(
        `backward seek to ${sourceSec}s without a reset: the accumulators have `
        + `already consumed frame ${this.applied}`,
      );
    }

    const steps = [];
    for (let k = this.applied + 1; k <= i + 1; k++) {
      // Clamped, because a capture whose stamps are not strictly ascending would
      // otherwise age the surface memory backwards. The state pass clamps the
      // other end, at the discontinuity gate.
      const gapSec = k === 0 ? NOMINAL_GAP_MS / 1000 : Math.max(0, times[k] - times[k - 1]);
      steps.push({ gapSec, makeCurrent: () => this.makeCurrent(k) });
    }
    this.applied = i + 1;

    // Seconds throughout on this side, so the span goes out as it stands. The live
    // source's `at` carries the note about why the unit is in the field's name.
    const span = Math.max(1e-6, times[i + 1] - times[i]);
    const offset = Math.min(Math.max(sourceSec - times[i], 0), span);
    return { steps, mixT: offset / span, sinceFrameSec: offset, spanSec: span };
  }
}

class IndexedPairSource extends StampedPairSource {
  static async open(id) {
    const res = await fetch(`/capture/${encodeURIComponent(id)}/index`);
    if (!res.ok) throw new Error(`capture ${id}: ${res.status} ${res.statusText}`);
    return new IndexedPairSource(id, await res.json());
  }

  constructor(id, index) {
    const stamps = index.frames.stampMs;
    if (stamps.length < 2) throw new Error(`capture ${id} has ${stamps.length} frames, need two to bracket`);
    // Source seconds from the first frame, which is what a capture is addressed
    // in. The stamps themselves are the sensor's own monotonic clock and carry an
    // arbitrary origin.
    super(stamps.map((s) => (s - stamps[0]) / 1000));
    this.id = id;
    this.index = index;
    this.cache = new Map();
    this.pending = null;
  }

  resident(a, b) {
    for (let k = Math.max(0, a); k <= Math.min(this.count - 1, b); k++) {
      if (!this.cache.has(k)) return false;
    }
    return true;
  }

  /**
   * Puts frames a..b in the cache. Fetches are serialised rather than run in
   * parallel: a prefetch racing a seek would fetch the same run twice and, worse,
   * could evict the seek's own frames out from under it between its fetch and its
   * render.
   */
  ensure(a, b) {
    const run = () => this.fetchSpan(a, b);
    this.pending = (this.pending ?? Promise.resolve()).then(run, run);
    return this.pending;
  }

  async fetchSpan(a, b) {
    const from = Math.max(0, a);
    const to = Math.min(this.count - 1, b);
    // Loud, because there is no useful partial answer. A caller asking for more
    // frames than the cache can hold would have some of them evicted before it
    // rendered the rest, and the image it produced would be built from whatever
    // survived - which is exactly the silent wrong picture this source refuses
    // elsewhere. Both callers clamp; this is what makes that a requirement
    // rather than a convention.
    if (to - from + 1 > MAX_SPAN_FRAMES) {
      throw new Error(
        `a span of ${to - from + 1} frames does not fit a cache of ${CACHE_FRAMES}: `
        + 'the caller has to clamp it and say what it dropped',
      );
    }
    const runs = [];
    for (let k = from; k <= to; k++) {
      if (this.cache.has(k)) continue;
      const last = runs[runs.length - 1];
      // Split at the chunk length as well as at a cache hit. A run can be the
      // whole pre-roll, and one response covering it would be buffered whole by
      // `arrayBuffer` - hundreds of megabytes for a slow damp on a full-rate
      // take, in a single allocation, for a decode that proceeds frame by frame
      // anyway.
      if (last && last[1] === k - 1 && last[1] - last[0] + 1 < RUN_FRAMES) last[1] = k;
      else runs.push([k, k]);
    }
    // Trimmed after every chunk rather than once at the end, so the cache tracks
    // its ceiling while a long span is filling instead of overshooting it and
    // settling back afterwards. The span itself is protected, which is safe
    // precisely because the guard above bounds it below the ceiling.
    for (const [lo, hi] of runs) {
      await this.fetchRun(lo, hi);
      this.trim(from, to);
    }
  }

  /**
   * A run in one request where there is a run to have. Step 2 measured eight
   * frames as one range request at 2.27ms against 4.93ms as eight separate ones,
   * and a pre-roll asks for exactly that shape - a contiguous block, known in
   * advance, wanted at once.
   */
  async fetchRun(lo, hi) {
    counters.requests++;
    const single = lo === hi;
    const url = single
      ? `/capture/${encodeURIComponent(this.id)}/frame/${lo}`
      : `/capture/${encodeURIComponent(this.id)}/frames/${lo}-${hi}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
    const buffer = await res.arrayBuffer();

    // A single frame is the payload alone and a run is the file's own slice with
    // the KNCT framing still interleaved, because payloads concatenated have no
    // boundaries left to parse back. Two shapes, one decoder below them.
    const decodes = [];
    if (single) {
      decodes.push(this.take(lo, buffer, 0, buffer.byteLength));
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
        decodes.push(this.take(k, buffer, off + KNCT_HEADER, len));
        off += KNCT_HEADER + len;
      }
    }
    await Promise.all(decodes);
    counters.framesFetched += decodes.length;
  }

  /**
   * One frame payload into the cache. The depth block is copied out rather than
   * kept as a view: a view would pin the whole run's buffer alive for as long as
   * any one of its frames was cached, so an eight-frame run would cost eight
   * times its own size until the last of them was evicted.
   */
  async take(k, buffer, offset, length) {
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
        bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
      } catch {
        /* a torn JPEG from a dropped USB packet: this frame renders depth only */
      }
    }
    this.cache.set(k, { depth, bitmap });
  }

  /**
   * Drops the oldest frames outside the span just asked for. The two bitmaps the
   * colour textures are holding are skipped whatever their age - closing one
   * would leave the shader sampling a detached bitmap, and the failure would show
   * up as a black colour channel rather than as an error.
   */
  trim(keepFrom, keepTo) {
    if (this.cache.size <= CACHE_FRAMES) return;
    const bound = [colorPrev.image, colorCurr.image];
    for (const k of this.cache.keys()) {
      if (this.cache.size <= CACHE_FRAMES) break;
      if (k >= keepFrom && k <= keepTo) continue;
      const frame = this.cache.get(k);
      if (frame.bitmap && bound.includes(frame.bitmap)) continue;
      frame.bitmap?.close();
      this.cache.delete(k);
    }
  }

  makeCurrent(k) {
    const frame = this.cache.get(k);
    // Loud rather than approximate. A missing frame means the transport rendered
    // without awaiting its own fetch, and the alternative to throwing is an image
    // built from whatever depth happened to still be in the texture - which would
    // be a wrong picture that no later check could attribute to anything.
    if (!frame) throw new Error(`frame ${k} is not resident: ensure() was not awaited`);
    bindDepth(frame.depth);
    // Colour arrives at half the depth rate on this sensor, so a frame without a
    // JPEG leaves the pair where it was. That is what the live path does with the
    // same stream, and matching it is what makes a seek reproduce a playback.
    if (frame.bitmap) bindColor(frame.bitmap);
  }

}

// ------------------------------------------------------------------ the timeline

// The playhead driven by the timeline rather than by an arrival. Everything
// expensive about that comes from the two feedback accumulators: the image at t
// is not a function of the frames at t, so landing on a position means rendering
// the frames before it and throwing them away. How many is computable.
//
// The two halves are sized in different units and both are converted to output
// frames here, because a pre-roll is a run of `renderProgramFrame` calls and
// nothing else. Fade and wake are source milliseconds - they stay source-referred
// for the three reasons the design gives - so they convert through the retime
// slope and the output frame rate. The afterimage is already in output frames and
// depends only on damp. Neither is a constant, so both are computed per seek.

// 1% of the previous image left in the afterimage. Three's pass is
// `max(new, damp * old)` with anything under 0.1 zeroed outright, so a residual
// this small has already been cut to exactly zero rather than merely made small -
// which is what lets a seek land on the same pixels as a playback instead of near
// them.
const AFTERIMAGE_RESIDUAL = 0.01;

// The three the accumulators run on. A draft holds them at zero for one frame:
// with fade and wake at zero the ghost half leaves the draw range and the live
// half's ramp-in is a constant 1, so the surface memory contributes nothing to
// the image at all, and with trails at zero the afterimage pass is switched off.
// That is the whole of what makes a draft a single frame with no history.
const BYPASSED = ['fade', 'wake', 'trails'];
const BYPASS_ZERO = { fade: 0, wake: 0, trails: 0 };
// The same three as a set, because the evaluator asks about one name per track and
// a three-element `includes` per track per frame is a linear scan inside the render
// loop for no reason.
const BYPASSED_SET = new Set(BYPASSED);

// The most output frames one tick may render to catch up. Enough to absorb a
// hitch of a few frames, small enough that a machine which cannot sustain the
// rate still yields between ticks rather than freezing the tab trying.
const CATCHUP_FRAMES = 4;
// How far behind real time playback has to fall before it says so. About eight
// frames at 30fps: below that it is a hitch, above it the rate on screen is not
// the rate the readout claims.
// How many times an operation re-plans itself around a curve that moved while it
// was fetching, before standing down and leaving the job to the repaint the same
// mutation queued. Two, which is the smallest number that absorbs one
// interruption: a plan, a fetch during which the curve moves, a re-plan, and a
// second fetch for the span the new curve wants. Past two it is chasing a hand
// rather than absorbing an event - a drag rewrites the curve on every pointer move,
// so no finite bound catches up with one, and standing down is the right answer
// there rather than a longer chase. Measured at both ends rather than guessed: at
// three an ordinary four-move drag hit the bound every time, and at one a single
// interruption never landed at all.
const SEEK_REPLANS = 2;
// How many stand-downs in a row before this stops being contention and starts
// being a seek that cannot converge for some other reason. A drag produces a
// handful and then lands; nothing else should produce any. Without this the quiet
// stand-down would be a silent stale image, which is the one outcome worse than an
// error.
const SEEK_OVERTAKEN_LIMIT = 12;

class TimelineTransport {
  constructor(source) {
    this.source = source;
    this.outputFps = 30;
    // The playhead is an integer output frame rather than a float second, so
    // playback and a seek walk the same grid. A seek that landed between two
    // output frames would pre-roll along a different set of positions than the
    // playback it is meant to reproduce, and the images would differ for a reason
    // nothing records.
    this.frame = 0;
    this.playing = false;
    this.nextDueMs = 0;
    // Raised by a draft, because a draft is deliberately not the true image.
    // Anything that has to be true - releasing the scrubber, pressing play -
    // clears it by seeking.
    this.drafted = false;
    this.prefetching = null;
    this.lastSeek = null;
    this.lastCostMs = 0;
    // How far playback is running behind real time, in wall milliseconds. Never
    // closed by skipping - only reported.
    this.behindMs = 0;
    // How many seeks in a row stood down because the curve moved under them. Reset
    // by any seek that lands, so a drag's handful never accumulates into a fault.
    this.overtaken = 0;
    // The tail of the operation chain, and whether one is running right now.
    this.queue = null;
    this.working = false;
  }

  get programSec() { return this.frame / this.outputFps; }

  /** Program seconds. The retime answers it, because only the retime knows how. */
  get duration() { return retime.programDurationFor(this.source.duration); }

  get lastFrame() { return Math.max(0, Math.floor(this.duration * this.outputFps)); }

  /** Clip range in program seconds, read from the document. */
  get clipInSec() { return Math.max(0, Number(clipIn) || 0); }
  get clipOutSec() { return clipOut === null ? this.duration : Math.min(this.duration, clipOut); }

  /**
   * Program seconds onto the output grid, bounded by the take and by nothing else.
   *
   * Split out of `frameAt` rather than duplicated beside it, so the rounding and the
   * take's bounds have one implementation and the clip range is the only thing the
   * two callers disagree about. `applyRate` wants this one: it is mid-way through
   * changing the slope, and the clip range it would otherwise be clamped against
   * belongs to the rate it is leaving.
   */
  frameOf(programSec) {
    return Math.max(0, Math.min(this.lastFrame, Math.round(programSec * this.outputFps)));
  }

  frameAt(programSec) {
    return this.frameOf(Math.max(this.clipInSec, Math.min(this.clipOutSec, programSec)));
  }

  sourceFrameAt(programSec) {
    return this.source.bracket(retime.sourceSecAt(programSec));
  }

  /**
   * Everything that produces an image runs alone, in the order it was asked for.
   *
   * Two of them interleaved is the failure this transport keeps finding, and it
   * is always the same shape: an operation clears the accumulators and walks
   * forward, another one resumes inside that walk, and the second asks the source
   * to go backwards. The source refuses - correctly, and far too late for anyone
   * to do anything with. A repaint landing under a scrub, a scrub release landing
   * under a repaint, and a preset applied while a seek is still fetching its
   * frames are all that shape, so they are all fixed here rather than one at a
   * time at the three call sites that happen to have been noticed.
   */
  async exclusive(work) {
    const run = async () => {
      this.working = true;
      try {
        return await work();
      } finally {
        this.working = false;
      }
    };
    const mine = (this.queue ?? Promise.resolve()).then(run, run);
    // The chain itself must never reject, or one failed operation would be
    // inherited by every operation queued behind it.
    this.queue = mine.catch(() => {});
    return mine;
  }

  /** Resolves once nothing this transport started is still running. */
  idle() { return this.queue ?? Promise.resolve(); }

  /**
   * How many output frames have to be rendered and discarded ahead of a seek.
   * Reported in both halves rather than as one number, because which half wins
   * says which parameter to reach for when a seek is slow.
   */
  preroll(programSec = this.programSec) {
    // Read from the tracks *at the target*, never off the uniforms. The uniforms
    // hold whatever the last render left there, which is the look at wherever the
    // playhead happened to be parked - so with fade, wake or trails keyed, a seek
    // from a cheap position to an expensive one sized its warm-up for the cheap
    // one and landed short. Measured before the fix: trails keyed 0 at 0s and 0.9
    // at 8s, parked at 0 and seeking to 11s, computed 21 frames where the same
    // seek run warm computed 44, and landed 62/255 away from its own playback over
    // 12% of the frame. Sampling at the target is the right rule rather than a
    // conservative one: a ghost is drawn while `age < fade + wake * strength` read
    // from the uniforms *at draw time*, so it is the target's values that decide
    // what is still on screen there.
    const surfaceSec = (valueAtProgram('fade', programSec)
      + valueAtProgram('wake', programSec)) / 1000;
    // The surface half is a *window* on the curve rather than a slope times a
    // count - see `framesBackFor`. The ceiling is the whole edit in output frames,
    // because a pre-roll longer than the program it sits in cannot be rendered by
    // anything; it is deliberately not the target, so a length the head of the
    // take will clip is still reported at full and `seekNow` still says it
    // clipped it.
    const back = retime.framesBackFor(programSec, surfaceSec, this.outputFps, this.lastFrame);
    // The trails half is a window too, and for the same reason the retime half is.
    // Three's pass is `max(new, damp * old)` applied per output frame with *that
    // frame's* damp, so what survives from before a pre-roll is the *product* of
    // damp across the window - not `damp_at_target ^ n`. Sampling at the target
    // reads the tangent again: with damp keyed 0.95 up to the target and 0.5 at it,
    // the formula asked for 7 frames where the product needs 50, and the seek
    // landed 50/255 away from its own playback over 8.7% of the frame. Measured on
    // this page before the walk replaced it.
    //
    // The surface half genuinely is a point sample and stays one, which is worth
    // stating because the two look alike. The state texture's contents do not
    // depend on fade or wake at all - `advanceSurfaceState` reads only the gap and
    // the snap threshold - and the *drawing* decision reads the uniforms at the
    // frame being drawn. So covering fade plus wake of source time ending at the
    // target is exactly sufficient there, and nothing earlier in the window can ask
    // for more.
    const back2 = this.trailsFramesBack(programSec);
    const trails = back2.frames;
    const frames = Math.max(back.frames, trails);
    return {
      surface: back.frames,
      // False when a whole edit's worth of output frames still did not cover fade
      // plus wake - a curve flat enough that the surface memory cannot be warmed
      // from inside this program. The seek runs anyway and this is how it says the
      // image it produced is short.
      surfaceCovered: back.covered,
      trails,
      trailsCovered: back2.covered,
      frames,
      sec: frames / this.outputFps,
    };
  }

  /**
   * How many output frames back the afterimage has to be rebuilt from for nothing
   * of what came before to still be visible.
   *
   * A pre-roll of `L` renders frames `N-L` to `N` from a cleared buffer, so what
   * playback still carries from before `N-L` and this does not is scaled by the
   * product of damp over frames `N-L+1..N`. That is the number to drive under the
   * residual, and it is only `damp^L` while damp is constant - which is exactly
   * what it is on a clip with no trails key, so this returns what the closed form
   * returned and step 4's figures are unchanged.
   */
  trailsFramesBack(programSec) {
    // Zero damp is the pass switched off entirely, so there is no history to
    // rebuild rather than a very short one.
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
   * The true image at a program position: clear both feedback paths, then render
   * forward from far enough back that neither carries anything the playback would
   * not have carried. `frames` overrides the computed length, which is how the
   * proof tool shows that the computed one is load-bearing rather than generous.
   */
  seek(programSec, options = {}) {
    return this.exclusive(() => this.seekNow(programSec, options));
  }

  /**
   * An accurate render at wherever the playhead is **when this runs**, rather than at
   * where it was when the call was made.
   *
   * The difference is the whole of it, and it is a bug that shipped. A caller that
   * means "repaint properly, here" has no position of its own to name - it wants the
   * playhead's, and reading that at call time captures a number another seek queued
   * ahead of it is about to change. `pumpParkedDraft` is the caller: when the orbit's
   * damping stops it asks for one true image at the pose the camera arrived at, and if
   * a person pressed Home during that glide the queue then held their seek to zero
   * followed by this one to four - so the playhead travelled to the position they
   * asked for and was pulled straight back off it, once, with nothing on screen saying
   * why. Reading the position inside the queued work instead makes this what it always
   * claimed to be: a render, not a move.
   */
  seekHere(options = {}) {
    return this.exclusive(() => this.seekNow(this.programSec, options));
  }

  /**
   * Which output frames a seek renders and which source frames they need. Split
   * out because it has to be answered twice - see `seekNow`.
   */
  planSeek(programSec, frames) {
    const target = this.frameAt(programSec);
    const t = target / this.outputFps;
    const plan = this.preroll(t);
    const asked = frames ?? plan.frames;
    let length = asked;
    let start = Math.max(0, target - length);
    const to = this.sourceFrameAt(t) + 1;
    let from = this.sourceFrameAt(start / this.outputFps);

    // A pre-roll can want more source frames than the cache can hold - the trails
    // half is a count of output frames whatever the rate, so a slow damp at a high
    // speed reaches far back through the take. Fetching it anyway would evict its
    // own head before the render reached it, so the pre-roll is shortened to what
    // can be held and the shortfall is recorded the way head-clipping already is.
    // An honest short pre-roll beats a long one built on frames that went away.
    if (to - from + 1 > MAX_SPAN_FRAMES) {
      from = to - MAX_SPAN_FRAMES + 1;
      start = Math.min(target, Math.ceil(retime.programSecAt(this.source.times[from]) * this.outputFps));
      length = target - start;
    }
    return { target, t, plan, asked, length, start, from, to };
  }

  async seekNow(programSec, options = {}) {
    // Planned, fetched, then planned again, and the second plan is not belt and
    // braces. The retime curve is document state: dragging one of its keys
    // rewrites it on every pointer move, and a fetch is awaited in the middle of
    // this. So the span computed before the await can describe a program the page
    // no longer has - and rendering it walks the source backwards, which the pair
    // source refuses, correctly and far too late for anyone to do anything with.
    // Bounded rather than a `while (true)`: the plan only keeps moving while the
    // pointer is still down, and the repaint queued behind that pointer runs this
    // again anyway, so giving up is losing one frame rather than losing the edit.
    let planned = this.planSeek(programSec, options.frames);
    for (let attempt = 0; !this.source.resident(planned.from, planned.to); attempt++) {
      if (attempt >= SEEK_REPLANS) {
        // Overtaken, not broken. The hand that moved the curve has already queued a
        // repaint, so this operation is stale before it finishes and the useful
        // thing to do is stand down quietly rather than shout - a drag rewrites the
        // curve on every pointer move, and an error per move is an instrument
        // crying wolf at its own user. Asking for a repaint here is what makes the
        // quiet safe: it guarantees a successor, so standing down costs a frame
        // rather than leaving a stale image nobody could attribute to anything.
        this.overtaken++;
        if (this.overtaken > SEEK_OVERTAKEN_LIMIT) {
          this.overtaken = 0;
          throw new Error(
            `${SEEK_OVERTAKEN_LIMIT} seeks in a row were overtaken before they could land: `
            + 'the span a seek plans is not becoming resident, which is not a moving curve',
          );
        }
        requestRepaint();
        return null;
      }
      await this.source.ensure(planned.from, planned.to);
      planned = this.planSeek(programSec, options.frames);
    }
    const { target, t, plan, asked, from, to } = planned;
    const { length, start } = planned;

    const began = performance.now();
    counters.seeks++;
    resetAccumulators();
    this.source.seekTo(from);
    // Navigation advances once for the whole seek rather than once per pre-roll
    // frame. The pre-roll is hidden rendering, so letting the controls settle
    // through it would smear the orbit's damping into the afterimage of an image
    // nobody asked to be moving.
    advanceNavigation(t);
    for (let k = start; k <= target; k++) renderProgramFrame(k / this.outputFps);

    this.lastCostMs = performance.now() - began;
    this.overtaken = 0;
    this.frame = target;
    this.drafted = false;
    this.lastSeek = {
      target, start, frames: length, plan,
      // A pre-roll that ran into the head of the take is shorter than the one
      // that was computed, so an equality proved at such a position is proving
      // something easier. Recorded rather than hidden.
      clamped: asked > target,
      // And so is one the frame cache could not hold. Both are the same kind of
      // fact - the seek did less than it computed - and a reader has to be able
      // to tell which, because only the second is a ceiling worth raising.
      capped: length < Math.min(asked, target),
      shortfall: Math.min(asked, target) - length,
      sourceFrames: to - from + 1,
    };
    this.paint();
    return this.lastSeek;
  }

  /**
   * One frame with the accumulators bypassed, for the length of a drag. The
   * parameters are zeroed after the fetch and restored before returning, all
   * inside one task, so the panel never paints them at zero.
   *
   * This is the shape the note on `evaluating` predicted - a bulk write landing
   * immediately either side of a render, semantically inside evaluation with the
   * flag down - and the flag is deliberately not widened over it. Two reasons.
   * The rule the flag enforces is that a *preset* is a user action rather than a
   * track, and a draft writes no track: it borrows three parameters for one frame
   * and gives them back, so refusing a preset click during a seek would be a
   * different rule wearing this one's name. And the window that would need
   * protecting cannot be entered - there is no await between the borrow and the
   * restore, so no gesture can land inside it and leave the three parameters
   * stranded at zero. Step 5's evaluator is a different case and still wants the
   * honest boundary the note asks for.
   */
  draft(programSec) {
    return this.exclusive(() => this.draftNow(programSec));
  }

  async draftNow(programSec) {
    // The same re-plan a seek does, and for the same reason: a drag on a retime key
    // rewrites the curve while this is awaiting its two frames, and the pair the
    // old curve named is not the pair the new one wants.
    let target = this.frameAt(programSec);
    let t = target / this.outputFps;
    let i = this.sourceFrameAt(t);
    for (let attempt = 0; !this.source.resident(i, i + 1); attempt++) {
      if (attempt >= SEEK_REPLANS) {
        throw new Error(`the retime curve moved under ${SEEK_REPLANS} plans of a draft at ${programSec}s`);
      }
      await this.source.ensure(i, i + 1);
      target = this.frameAt(programSec);
      t = target / this.outputFps;
      i = this.sourceFrameAt(t);
    }

    const began = performance.now();
    // Borrow, render and hand back, none of it asking for a repaint: these three
    // writes are the transport's own, and a repaint scheduled off them would run
    // the accurate seek this frame exists to avoid.
    withoutRepaint(() => {
      const held = params.values(BYPASSED);
      params.apply(BYPASS_ZERO);
      borrowed = BYPASSED_SET;
      try {
        // The reset is what lets a drag go backwards. Nothing here reads the
        // accumulators, so clearing them costs four target clears and removes the
        // one state that could not be walked the other way.
        //
        // Skipped when the draft has not moved the playhead, which is every frame of
        // an orbit: the pair the walk would rebuild is the pair already bound, so it
        // buys two `expandDepth` passes over the whole depth grid, two binds and two
        // state advances to arrive back where it started. The two lines go together
        // or not at all, and that is what makes it correct rather than merely
        // cheaper - with `applied` left where it is, `at` emits no steps, so nothing
        // rebinds, nothing ages, and the state texture keeps exactly the memory this
        // frame was rendered with.
        //
        // The image is the same image, and it is measured rather than argued: 3.70ms
        // to 1.40ms per draft over 60 interleaved pairs, bit-identical over 3,022,672
        // bytes of readback across five alternating shots, on a look with fade at
        // 400, wake at 900 and trails at 0.85 so the accumulators genuinely held
        // something to inherit. The first version of that comparison alternated the
        // two arms back to back and could not have found a difference - a reset draft
        // clears the buffers and writes nothing back, so the skipping arm never once
        // ran on dirty ones, which is the only case this changes. Each arm re-seeks
        // now, and the control is that the seek's own image differs from its draft.
        if (target !== this.frame || this.source.applied !== i + 1) {
          resetAccumulators();
          this.source.seekTo(i);
        }
        advanceNavigation(t);
        renderProgramFrame(t);
        // Inside the borrow, not after it. The top-down draws the same cloud the
        // frame did, so drawing it once the three parameters were handed back
        // would put a wake in the plan view that the picture beside it does not
        // have - and two drafts of one position would then differ by whatever
        // fade and wake happened to be, which is exactly what a draft is defined
        // not to depend on.
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
    this.paint();
    return this.lastCostMs;
  }

  /**
   * Rebuilds the parked viewport after navigation without borrowing the scrub
   * draft's look. With trails active, the accurate image requires a pre-roll at
   * the new camera pose because screen-space history cannot be reprojected. With
   * trails off, the already-bound source pair and surface state are sufficient,
   * so the same frame can be drawn directly unless another draft left incomplete
   * state behind it.
   */
  /**
   * A navigation redraw at wherever the playhead is **when this runs**, which is the
   * same distinction `seekHere` above draws and for the same reason.
   *
   * `redrawNow` is not the read-only operation its name suggests: it assigns
   * `this.frame`, and on any of the four conditions it tests it hands off to a full
   * `seekNow`. So a position captured at call time is a *move* scheduled for later, and
   * the queue is exactly where later happens. The orbit's pump is the only caller: it
   * arms a flag during a drag and resolves the position when the loop gets its turn,
   * which is correct against the drag and still one link short of correct against
   * somebody pressing Home during it. That seek queues first, the redraw queues behind
   * it carrying the position the drag was leaving, and the playhead travels to the
   * start and is pulled straight back. Measured as one landing in five before this,
   * every time on the run that had not settled first.
   */
  redrawHere() {
    return this.exclusive(() => this.redrawNow(this.programSec));
  }

  async redrawNow(programSec) {
    counters.navigationRedraws++;
    const target = this.frameAt(programSec);
    const t = target / this.outputFps;
    const source = this.sourceFrameAt(t);
    if (this.drafted || valueAtProgram('trails', t) > 0
        || target !== this.frame || this.source.applied !== source + 1) {
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
   * One output frame forward, or false if there is nothing to advance to. The
   * playback loop and the proof tool drive the same call - the loop adds pacing
   * and prefetch around it and nothing else.
   */
  step() {
    const next = this.frame + 1;
    if (next > this.lastFrame) return false;
    const t = next / this.outputFps;
    if (t > this.clipOutSec + 1e-9) return false;
    const want = this.sourceFrameAt(t) + 1;
    // A span that runs backwards is not "already resident", it is unwalkable - and
    // the residency test cannot tell the difference, because it compares a low
    // bound against a high one and passes vacuously the moment they cross. That
    // gave a curve running downhill two different failures depending on what
    // happened to be cached: with the frames resident, the pair source refused from
    // inside the animation loop and took the page down; without them, this returned
    // false forever and the prefetch below refused the same span the same vacuous
    // way, so playback simply stopped advancing and said nothing at all. The second
    // is the worse one. Named here, at the guard that was passing, so the tick can
    // pause and surface it either way.
    if (want < this.source.applied) {
      throw new Error(
        `playback at ${t.toFixed(3)}s wants source frame ${want} while the accumulators have `
        + `consumed ${this.source.applied}: the retime curve runs backwards here`,
      );
    }
    if (!this.source.resident(this.source.applied + 1, want)) return false;
    advanceNavigation(t);
    renderProgramFrame(t);
    this.frame = next;
    return true;
  }

  /**
   * One turn of the animation loop, and the only place in this file that catches
   * broadly.
   *
   * Three's `setAnimationLoop` does not request another frame after its callback
   * throws, so anything escaping here stops the page permanently - no playback, no
   * scrubbing, no repaint, and with nothing persisted that is the whole editing
   * session. The throw that reaches it is real: `StampedPairSource.at` refuses a
   * backward walk, correctly, and a retime curve that runs downhill asks for one on
   * the next step. The doors that could author such a curve are clamped now, so
   * this is a backstop rather than the fix - but a backstop is exactly what the one
   * function whose failure costs everything should have.
   */
  tick(nowMs = performance.now()) {
    try {
      this.tickNow(nowMs);
    } catch (err) {
      // Paused rather than left running: whatever the accumulators are holding, the
      // next step would ask for the same refusal again. Surfaced rather than
      // swallowed, because a playhead that silently stopped is the wrong picture
      // problem one layer up.
      this.playing = false;
      this.paint();
      showTimelineError(err);
    }
  }

  tickNow(nowMs) {
    if (!this.playing) return;
    // An exclusive operation is mid-walk, and stepping into it would advance the
    // accumulators underneath a reset that has already happened.
    if (this.working) {
      this.prefetch();
      return;
    }
    // Every frame that has come due is rendered, up to a cap, and only the last
    // of them reaches the screen. That honours never-skip - each one still walks
    // the accumulators, which is the whole reason a frame cannot be dropped -
    // while letting a single slow tick be repaid instead of becoming a permanent
    // offset. The cap is what stops a machine that cannot keep up from spending
    // an entire tick catching up and never yielding.
    let rendered = 0;
    while (nowMs >= this.nextDueMs && rendered < CATCHUP_FRAMES) {
      if (!this.step()) break;
      this.nextDueMs += 1000 / this.outputFps;
      rendered++;
    }
    if (rendered > 0) this.paint();
    else if (this.frame >= this.lastFrame || this.programSec >= this.clipOutSec - 1e-9) this.pause();
    // Anything still owed after the cap is a deficit the machine is not going to
    // repay, and it is surfaced rather than absorbed: a link too slow to feed the
    // playhead and a renderer too slow to draw it both look like smooth playback
    // at the wrong speed, which is the one thing an instrument must not do
    // quietly. Nothing is skipped to close it - playback runs late, in order.
    this.behindMs = Math.max(0, nowMs - this.nextDueMs);
    this.prefetch();
  }

  /** The fetch in flight, or null when the window ahead is already resident. */
  prefetch() {
    if (this.prefetching) return this.prefetching;
    // Clamped for the same reason a seek is: at a high rate the window ahead
    // covers more source frames than the cache holds, and asking for them is a
    // refusal rather than a slow answer. Prefetching less is harmless - the next
    // tick asks again from wherever the playhead has reached.
    const ahead = Math.min(
      this.sourceFrameAt((this.frame + PREFETCH_FRAMES) / this.outputFps) + 1,
      this.source.applied + MAX_SPAN_FRAMES - 1,
    );
    if (this.source.resident(this.source.applied, ahead)) return null;
    const fetching = this.source.ensure(this.source.applied, ahead)
      .catch((err) => showTimelineError(err))
      .finally(() => { if (this.prefetching === fetching) this.prefetching = null; });
    this.prefetching = fetching;
    return fetching;
  }

  /**
   * Playback with the wall clock taken out: every output frame in order, as fast
   * as the bytes arrive. This is what step 6's export transport is, and it is
   * also how a proof tool reaches a position "by playback" without waiting real
   * seconds for it. It adds no rendering of its own - `step` is still the only
   * thing that renders - so a run and a played take walk identical positions.
   */
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
    // In the same task as the last `step`, because the loop only awaits when a
    // step could not run. That matters for one reason: paint is where the chrome
    // is drawn, and a run that ended without it would leave the buffer differing
    // from a seek's by the overlay alone - two arms of an equality disagreeing
    // about furniture rather than about the image.
    this.paint();
    return this.frame;
  }

  async play() {
    if (this.playing) return;
    this.behindMs = 0;
    // A draft is not the image playback would have produced, so playing on from
    // one would start the afterimage off a picture that never existed.
    if (this.drafted) await this.seek(this.programSec);
    // Keep playback inside the clip's in/out points. Starting from outside the
    // range snaps to the in point; reaching the out point stops.
    if (this.programSec < this.clipInSec || this.programSec > this.clipOutSec) {
      await this.seek(this.clipInSec);
    }
    this.playing = true;
    this.nextDueMs = performance.now();
    this.paint();
  }

  pause() {
    this.playing = false;
    this.paint();
  }

  paint() { paintTimeline(this); }
}

// ------------------------------------------------------------------- the export

// One renderer, driven with no wall clock anywhere.
//
// The classic failure here is a second offline renderer that never quite matches
// the preview, so there is not one: an export is the timeline transport stepped at
// k / outputFps, and `runTo` - playback with the clock taken out - is the driver.
// `step` stays the only thing that renders, so an exported frame and a played one
// walk identical positions by construction rather than by agreement. Slower than
// real time is fine and is arguably the point: the whole reason to record raw is
// to spend more time on the image than the sensor had.
//
// Remote encoding is then this same code driven by Playwright in headless Chrome
// on a bigger machine, which is why the job record below carries the renderer
// class from the very first job.

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  // Marked handled here so a failure that nobody is awaiting yet - the socket
  // dying between two frames, say - surfaces at the await that comes next instead
  // of as an unhandled rejection with no context attached.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

/**
 * The wire, and the flow control on it.
 *
 * Frames go out as raw RGBA binary messages and the server acks each one once it
 * has reached ffmpeg's stdin. The window is what stops the browser running ahead
 * of the encoder: a cheap look renders faster than libx264 encodes, and without an
 * ack the frames would pile up eight megabytes at a time in the server's memory
 * behind a stdin that is not draining. `bufferedAmount` would bound the browser's
 * own queue and say nothing at all about that one.
 */
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
    // `send` queues a copy, which is what lets the readback reuse one buffer for
    // the whole export rather than allocating eight megabytes a frame. If that
    // were ever untrue the exported frames would be the *last* frame repeated,
    // which is exactly what the per-frame hashes the server returns would catch.
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
    // One buffer for the whole run. `readPixels` is a GPU-to-CPU synchronisation
    // point and will stall the pipeline every frame; that is accepted at export
    // rates, and if it ever becomes the limit the fix is asynchronous readback
    // through a pixel buffer with a fence rather than a different transport.
    this.pixels = new Uint8Array(options.width * options.height * 4);
  }

  /**
   * Every frame from `from` to `to`, in order, each one read back in the same task
   * as the render that produced it.
   *
   * The first frame is the only one that costs a seek - it has to pre-roll the
   * accumulators from a known state, exactly as landing the playhead there in the
   * editor would - and every frame after it is a single step. That is why an
   * export needs no driver of its own: those are the two things the timeline
   * transport already does.
   */
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
      // Counted rather than assumed. A seek that stood down, a `runTo` asked for a
      // frame it was already past, or a program position that stopped being the
      // one the sink names would all leave the buffer holding the previous frame -
      // and an export of the same image repeated is the failure that looks most
      // like a success.
      if (hits !== 1) {
        throw new Error(`the render at ${at.toFixed(6)}s reached the export ${hits} times, not once`);
      }
      await sink.send(this.pixels);
      this.onProgress(n - this.from + 1, this.to - this.from + 1);
    }
    return this.to - this.from + 1;
  }
}

// Whether an export owns the renderer. Nothing else may draw while one does: a
// repaint queued by a slider, or a draft from a scrub, would clear the
// accumulators in the middle of a walk the export is halfway through and hand it
// a frame with no history behind it.
let exporting = false;

const rendererClass = () => {
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
};

/**
 * The door. Sizes the buffer to the output, points the viewport at the program
 * camera, takes the furniture off, renders the clip, and puts the editor back
 * exactly as it was.
 *
 * The output size is a setting rather than the window's, which is only true
 * because every screen-space term is resolution-relative now - that is the whole
 * reason this step comes after the one above it.
 */
function parseSize(text) {
  const [w, h] = String(text).split('x').map(Number);
  return { w: w > 0 ? w : 0, h: h > 0 ? h : 0 };
}

async function exportClip(options = {}) {
  if (!timeline) throw new Error('there is no clip open to export');
  if (exporting) throw new Error('an export is already running');
  ensureActiveDeliverable();
  const d = activeDeliverable;
  // **The one place the two halves of the split are checked against each other.** The
  // stage is letterboxed to the project's shape and the file is rendered at the
  // deliverable's size, and every route that writes either of them keeps them agreeing -
  // `setProjectAspect` brings the size along, `applyDeliverable` refuses a stored size of
  // another shape. This is the backstop under all of them, and it has one case it is the
  // *only* answer to: a project saved with a shape the size table offers nothing for,
  // reopened with a deliverable that never held a size of that shape. Refusing at the
  // press costs a message; rendering would cost a file that is not the picture on screen,
  // which is the failure this whole letterbox exists to make impossible.
  const requested = options.outputSize ?? d.outputSize;
  const deliverableSize = parseSize(requested);
  const width = Math.trunc(options.width ?? deliverableSize.w);
  const height = Math.trunc(options.height ?? deliverableSize.h);
  // **Asked of the size this render will actually use, which is the half the first version
  // of this check got wrong.** It skipped itself entirely when `options.width` or
  // `options.height` was supplied, on the reasoning that an explicit size is the caller's
  // business - and the lines below then write that size into `outputSize` and call
  // `resize()`, so an explicit pair does not sit beside the letterbox, it *replaces* it.
  // A job carrying 320x200 against a 16:9 project reframed the camera to 1.6 and rendered
  // a picture nobody composed, which is precisely the failure the comment below claims to
  // be the backstop against. `tools/render-worker.mjs` supplies both fields on every job,
  // so the one path that renders unattended was the one path with no check on it.
  //
  // A well-formed job cannot trip this: the worker restores the job's own project first,
  // so `projectAspect` is that project's shape and the width and height it was queued with
  // are of that shape. What trips it is a job whose size and whose project disagree, which
  // is a reframe wearing the shape of a resolution.
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
  // The project's rate, since it left the deliverable. `options.fps` is still ahead of it
  // because a queued job names the rate it was queued at, and re-rendering that job has to
  // reproduce the file rather than whatever the project has since been set to.
  const fps = options.fps ?? timeline.outputFps;
  const codec = options.codec ?? d.codec ?? 'h264';

  const restore = {
    outputFps: timeline.outputFps,
    programSec: timeline.programSec,
    chrome: chromeOn,
    camera: viewCamera,
  };

  exporting = true;
  pauseTransport();
  try {
    // The rate first, because the frame grid every position below is named in is
    // the output rate's grid.
    timeline.outputFps = fps;
    const inSec = options.in !== undefined ? options.in : d.in;
    const outSec = options.out !== undefined ? options.out : d.out;
    const inFrame = timeline.frameAt(Number(inSec) || 0);
    const outFrame = timeline.frameAt(outSec === null ? timeline.duration : outSec);
    const from = Math.max(inFrame, Math.min(outFrame, Math.trunc(options.from ?? inFrame)));
    const to = Math.max(inFrame, Math.min(outFrame, Math.trunc(options.to ?? outFrame)));
    if (to < from) throw new Error(`an export of frames ${from}..${to} has nothing in it`);

    // Composition comes from the camera track, so the export renders what the
    // program camera sees whatever the editor happens to be orbiting.
    setViewCamera(programCamera);
    // Chrome is not the frame. It lives on a canvas of its own so it cannot reach
    // the pixels anyway; taking it off is so the editor is not drawing a path over
    // a buffer that has become the output's size underneath it.
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
      width, height, fps, from, to, onProgress: options.onProgress,
    });
    const sink = new ExportSink({
      name: options.name ?? exportBaseName(),
      width,
      height,
      fps,
      frames: to - from + 1,
      codec,
      // A job is a project file plus a capture named by content hash plus output
      // settings, and it records the renderer class it was made on. There is one
      // render machine today so the field constrains nothing - but a job record
      // without it cannot be retrofitted once old jobs exist, and provenance is
      // exactly what is wanted on the day two workers disagree about an image.
      //
      // **Serialised inside the try, so `outputFps` is the rate this render is at**
      // rather than the rate the project was on before `options.fps` overrode it. That is
      // the direction that makes a job replayable: the body now carries the rate, and a
      // worker restoring it renders the file that was asked for rather than the one the
      // project would produce today. It also means `trails`, whose length is counted in
      // output frames, decays over the same span on the replay as it did here.
      project: serialiseProjectBody(),
      capture: timeline.source.index.hash,
      renderer: rendererClass(),
    });
    await sink.ready.promise;
    await run.run(sink);
    return await sink.finish();
  } finally {
    exporting = false;
    outputSize = null;
    resize();
    chromeOn = restore.chrome;
    placeChrome();
    setViewCamera(restore.camera);
    timeline.outputFps = restore.outputFps;
    timeline.frame = timeline.frameAt(restore.programSec);
    timingChanged();
    requestRepaint();
  }
}

// --------------------------------------------------------------- the timeline UI

// Deliberately small. The scrubber, the playhead, play/pause and a speed control,
// and the two clocks that say what the coordinate actually is - program time read
// off the ruler and source time derived from it through the retime, never edited.
// Step 5 is what grows lanes, keys and a curve underneath this.

const ui = {
  root: timelineEl,
  play: document.getElementById('tPlay'),
  program: document.getElementById('tProgram'),
  source: document.getElementById('tSource'),
  rate: document.getElementById('tRate'),
  rateOut: document.getElementById('tRateOut'),
  rateKey: document.getElementById('tRateKey'),
  fps: document.getElementById('tFps'),
  bed: document.getElementById('tBed'),
  rail: document.getElementById('tRail'),
  beds: document.getElementById('tBeds'),
  // The two containers the lane rebuild owns and empties. Everything else in those
  // columns is its sibling rather than its child, which is what stops the rebuild
  // reaching the cuts again - see the note on `.tstack` in the markup.
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
  camKey: document.getElementById('camKey'),
  camClear: document.getElementById('camClear'),
  camView: document.getElementById('camView'),
  // Timeline camera controls (duplicate of panel controls for quick access)
  tCamKey: document.getElementById('tCamKey'),
  tCamView: document.getElementById('tCamView'),
  camSensor: document.getElementById('camSensor'),
  camLevelReset: document.getElementById('camLevelReset'),
  cropBox: document.getElementById('cropBox'),
  // Null on the recorder, which builds no such row - see the framing group's `before()`
  // for why the surface rather than the state decides.
  cropFit: document.getElementById('cropFit'),
  cropReset: document.getElementById('cropReset'),
  // Empty in the markup and filled by `setProjectAspect`, which is the only thing that
  // knows which sizes this project's shape has. The boot call below runs after this
  // object exists, so the select is briefly empty and nothing reads it in between.
  exportSize: document.getElementById('tExportSize'),
  projectAspects: document.getElementById('projectAspects'),
  exportFormats: document.getElementById('exportFormats'),
  exportDialog: document.getElementById('exportDialog'),
  exportGo: document.getElementById('tExport'),
  exportNote: document.getElementById('tExportNote'),
  exportName: document.getElementById('tExportName'),
  exportNameChip: document.getElementById('tExportNameChip'),
  exportSave: document.getElementById('tExportSave'),
  exportTrim: document.getElementById('tExportTrim'),
  inOut: document.getElementById('tInOut'),
  outOut: document.getElementById('tOutOut'),
  clipLen: document.getElementById('tClipLen'),
  setIn: document.getElementById('tSetIn'),
  setOut: document.getElementById('tSetOut'),
  clearRange: document.getElementById('tClearRange'),
  ease: document.getElementById('tEase'),
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
  project: document.getElementById('tProject'),
  projectOpen: document.getElementById('tProjectOpen'),
  resume: document.getElementById('tResume'),
  resumeWhen: document.getElementById('tResumeWhen'),
  resumeOpen: document.getElementById('tResumeOpen'),
  recGo: document.getElementById('recGo'),
  recMark: document.getElementById('recMark'),
  recNote: document.getElementById('recNote'),
  recSpace: document.getElementById('recSpace'),
  recRange: document.getElementById('recRange'),
};

// The rates, built from `OUTPUT_RATES` rather than written into the markup, so the list
// the validator refuses against and the list the control offers are one object.
for (const rate of OUTPUT_RATES) ui.fps?.appendChild(new Option(String(rate), String(rate)));

aspectButtons = buildAspectSegments(ui.projectAspects);

/**
 * The output format, as one segmented control over the deliverable's `codec`.
 *
 * The three buttons carry the codec name the server's table is keyed by rather than a
 * label the dialog translates: a translation table here would be a second place that has
 * to agree with `CODECS` in `server/export.js`, and the one that drifts is the one nobody
 * exports with. MP4 was markup and the other two were disabled buttons carrying a
 * `title` that said the renderer could not do it - which stopped being true when the
 * server learned prores and the image sequence, and a control that lies about a
 * capability is worse than one that is missing, because nobody goes looking for it.
 *
 * The selection is painted from the document and never remembered here, for the same
 * reason the row resets are: the deliverable is reached by the project file and by the
 * autosave as well as by this dialog, so a pressed state kept beside it would be right
 * only for the presses that came through these three buttons.
 */
// The keys are the server's, not this file's: `CODECS` in `server/export.js` is where a
// codec is declared and `validateExport` is what refuses an unknown one at both doors.
// This list exists only to say which of them the dialog puts on screen - `lossless` is a
// real codec the dialog does not offer - so a name added here that the table does not
// carry is a button that fails at the end of a render rather than at the press.
// `editor-check` reads the table out of that file and asserts these are a subset of it,
// so the two cannot drift in silence.
const EXPORT_CODECS = ['h264', 'prores', 'pngseq'];

function paintExportFormats() {
  const codec = activeDeliverable?.codec ?? 'h264';
  for (const button of ui.exportFormats.querySelectorAll('button[data-codec]')) {
    button.setAttribute('aria-pressed', String(button.dataset.codec === codec));
  }
}

function setExportCodec(codec) {
  // Refused here rather than trusted, because the value comes off an attribute in the
  // markup and a typo there would otherwise travel all the way to ffmpeg's argument list.
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

// The chips strip hides its scrollbar so the bar keeps its 51px and the lanes stay
// where a dragged key expects them - which also hid the only evidence that anything
// was off its right edge. This puts a fade there when there is, and takes it away
// when there is not, so the strip says whether it has more.
//
// Watched two ways because it overflows for two reasons. The window getting narrower
// changes the strip's own box, which is the ResizeObserver; the readouts inside it
// getting longer - the pre-roll grows on a slow ramp, an export note arrives - does
// not, which is the MutationObserver. Either one alone leaves a state where the fade
// is wrong, and a fade that is wrong is worse than none.
for (const chips of document.querySelectorAll('.tchips')) {
  const sayMore = () => chips.classList.toggle('more', chips.scrollWidth > chips.clientWidth + 1);
  new ResizeObserver(sayMore).observe(chips);
  new MutationObserver(sayMore).observe(chips, { subtree: true, childList: true, characterData: true });
  sayMore();
}

// The export note is pinned beside the render button and truncates rather than
// pushing the controls off, so the whole sentence has to stay reachable somewhere -
// a failure message is exactly the one that overflows.
const sayExport = (text) => {
  ui.exportNote.textContent = text;
  ui.exportNote.title = text;
};

const timecode = (sec) => {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
};

/**
 * Where a rejected promise from the timeline goes, and now the whole of it.
 *
 * This used to be two lines: the console, and `say` putting the same sentence on a chip
 * in the application bar. The chip was asked for gone - see `index.html`'s comment on
 * `#appStatusSlot` for the argument and for what went with it - and the console line is
 * what is left, so an export refused for its filename, a project whose take hash does not
 * match, a preset the server answers 404 for and a failed auto-save are all reported to
 * the developer tools and to nobody on the page.
 *
 * Written down rather than left to be noticed, because the shape is a real one: several
 * callers below sit in a `catch` whose entire body is this call, and a reader who does not
 * know the display went on purpose will read those as handlers somebody forgot to finish.
 * The one thing that must not happen is a *second* channel growing back here - a toast, a
 * banner, a second chip somewhere quieter - because the removal was the decision and two
 * paths that drift is what this design keeps refusing.
 */
function showTimelineError(err) {
  console.error('[timeline]', err);
}

// The window of program time the strip is drawn against, built here because both of its
// readings belong to this file: the length of the program, and where the ruler's bed is on
// screen. Suppliers rather than values, because both move under a window that does not.
//
// **The length is frozen for the length of a lane drag, and that is not a nicety.** The
// retime curve *is* the program length: dragging one of its keys down slows the clip, which
// lengthens the program, which rescales the ruler, which moves the key under a pointer that
// has not moved horizontally - and the new position is read back as a new program time,
// which slows it further. Measured before it was fixed: a twelve-pixel vertical drag walked
// one key from 15.0s to 48.3s in four moves, and the drag got faster the longer it went on.
// `laneDrag` is null except while that drag is live, and it is declared three thousand
// lines below this because it belongs to the drag - which is safe only because nothing
// reads the window before a take is open, and the guard on that is `viewChanged`.
//
// The 1 with no clip open is a placeholder the floor inside the window would give it
// anyway; what it buys is that `pct` divides by something before the first paint.
const view = makeViewWindow({
  durationSec: () => (laneDrag ? laneDrag.duration : (timeline ? timeline.duration : 1)),
  bedRect: () => ui.bed.getBoundingClientRect(),
});

/**
 * What the chosen deliverable is, and what the press will take out of the clip.
 *
 * The rate is not in it any more and its absence is the change rather than a shortening:
 * it belongs to the project, so printing it beside the deliverable's own fields would say
 * it is one of them. The trim is a second element rather than the tail of this string
 * because the dialog gives it a row of its own - the operator's question there is "what
 * range is this press going to render", and an answer buried at the end of a summary line
 * is one they have to parse rather than read.
 */
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

/**
 * The furniture that says *where* on the ruler something is: the playhead, the two
 * cuts and the shading outside them.
 *
 * Split out of `paintTimeline` because a zoom gesture needs exactly this and nothing
 * else. The rest of that function recomputes the pre-roll plan and redraws the chrome
 * canvas, which is the right cost for a seek and the wrong cost per wheel notch.
 */
function paintStripPositions() {
  const dur = view.duration;
  const inPct = view.pct(Math.min(clipIn, dur));
  const outPct = view.pct(Math.min(clipOut ?? dur, dur));
  ui.playhead.style.left = `${view.pct(timeline ? timeline.programSec : 0)}%`;
  ui.in.style.left = `${inPct}%`;
  ui.out.style.left = `${outPct}%`;
  // What the export will leave out, shown rather than left to be worked out from
  // the position of two thin lines. Nothing here decides anything - `exportClip`
  // reads `clipIn`/`clipOut` directly - so this is the range made visible and not a
  // second copy of it.
  //
  // Clamped to the bed rather than drawn from the marker, because under a window that
  // starts after the in point the shading runs off the left edge and a negative width
  // draws nothing at all - which reads as "everything is included" on precisely the
  // view where the cut is out of sight and the shading is the only evidence left.
  const lo = Math.max(0, Math.min(100, inPct));
  const hi = Math.max(0, Math.min(100, outPct));
  ui.shadeIn.style.left = '0%';
  ui.shadeIn.style.width = `${lo}%`;
  ui.shadeOut.style.left = `${hi}%`;
  ui.shadeOut.style.width = `${Math.max(0, 100 - hi)}%`;
  // The overview carries the same three things, so it is repainted from here rather
  // than from a second list of callers that could fall out of step with this one.
  paintMinimap();
}

function paintTimeline(t) {
  const program = t.programSec;
  ui.play.textContent = t.playing ? '❙❙' : '▶';
  ui.play.setAttribute('aria-label', t.playing ? 'Pause' : 'Play');
  ui.program.textContent = timecode(program);
  ui.source.textContent = timecode(retime.sourceSecAt(program));
  // The name an empty field will use, said on the field rather than only in the
  // filename that turns up afterwards. Once, because it is a default and not a value.
  if (!ui.exportName.placeholder) ui.exportName.placeholder = t.source.id;
  paintStripPositions();
  // The same range as numbers. Two markers on a ruler say where the boundaries are
  // and cannot say where they are to the millisecond, which is what an export needs
  // - and "out" says `end` rather than a time when nothing has been set, because
  // `clipOut === null` means the whole clip and following the duration around would
  // read as a value somebody chose.
  //
  // `view.duration` here and `view.pct` in the positions above, and the split is the
  // distinction the rename was for: this is a *length*, which the window cannot change,
  // where a marker is a *place*, which is all the window changes.
  if (ui.inOut) ui.inOut.textContent = timecode(clipIn);
  if (ui.outOut) ui.outOut.textContent = clipOut === null ? 'end' : timecode(clipOut);
  if (ui.clipLen) ui.clipLen.textContent = `${Math.max(0, (clipOut ?? view.duration) - clipIn).toFixed(2)}s`;
  paintDeliverable();
  paintLanes();
  // Editor furniture - the camera path, its nodes and the top-down - is drawn
  // here rather than inside `renderProgramFrame`, and the distinction is not
  // cosmetic. That function is the seam: one image at one program position, and
  // it is what an export hashes and what every equality in this repo compares.
  // Chrome is not the frame. Drawing it here also means it lands in the same task
  // as the render that produced the buffer, which is the only place it can land
  // at all, since the drawing buffer is not preserved across a paint.
  drawChrome();
}

/**
 * The ruler, drawn across the visible window rather than across the clip.
 *
 * The step comes from the *window*, which is the whole reason a long take became
 * usable: at 800s the old ladder gave 20-second ticks and no way to look closer, so a
 * key was placed against gradations forty times coarser than the thing being placed.
 * The count is what is held roughly constant now - about one label per 90px - and the
 * spacing falls out of it.
 */
function buildRuler() {
  const span = Math.max(1e-6, view.spanSec);
  const width = Math.max(1, ui.bed.clientWidth);
  const wanted = span / Math.max(2, width / 90);
  const step = TICK_STEPS.find((s) => s >= wanted) ?? TICK_STEPS[TICK_STEPS.length - 1];
  const ticks = [];
  // Only the ticks the window holds are built, so a two-second window on an hour-long
  // take costs the same as a two-second window on a short one. The old loop walked the
  // whole clip and made every tick outside the view as well.
  const first = Math.ceil(view.startSec / step - 1e-9) * step;
  for (let s = first; s <= view.endSec + 1e-9; s += step) {
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

// A drag resolves at one draft per displayed frame, and never queues more than one
// behind the one in flight: the position the pointer is at now is the only one worth
// rendering, so an older one is dropped rather than caught up on. Same shape as the
// colour decode pump, and for the same reason.
//
// **Nothing here restarts itself.** It used to - the `finally` pumped whatever had
// been armed while it ran - and that is a clock built out of "however fast this
// machine can rebuild a frame". For a scrub it is harmless, because one pointer move
// arms one position and the pointer cannot outrun the display. For an orbit it is
// ruinous, because the render arms the next position itself: `renderProgramFrame`
// runs `advanceNavigation`, which calls `controls.update()`, which consumes 7% of the
// damped residual and fires `change`, which arms another draft. Measured on a paused
// orbit drag, one pointer move cost 34 drafts and raised 35 `change` events, 34 of
// them from inside a render - about 167ms of blocked main thread for a gesture that
// showed 12 frames a second while rendering 190.
//
// So the rule is stated where it can be enforced rather than left to each caller: a
// frame the compositor never gets a turn to show is work nobody sees, and the
// animation loop is what knows when that turn comes. `pumpParkedDraft` is the only
// thing that continues a drag.
/**
 * The overview strip: the whole clip, with the visible window drawn on it.
 *
 * Nothing here goes through `view.pct`, and that is the point of it rather than an
 * oversight - it is the one surface that has to be in whole-clip coordinates, because
 * it exists to say where the window is, and a window cannot say that about itself.
 */
function paintMinimap() {
  if (!ui.mini) return;
  const dur = view.duration;
  const pct = (t) => `${Math.max(0, Math.min(100, (t / dur) * 100))}%`;
  // `left` stays the plain percentage the window actually sits at, and the clamp that
  // keeps the `min-width` box inside the track rides on `margin-left` beside it. Both
  // halves of that are deliberate. A clamp written into `left` itself - `min(x%,
  // calc(100% - ...))` - draws correctly and breaks every reader: `editor-check`
  // parses this property as a number and got NaN, which is this file's own rule about
  // asserting against the resource seen from the other side. The margin resolves
  // against the track, so it is 0 until the box would hang off the end and exactly the
  // overhang after that, and it needs no measurement in JS to compute. The minimum
  // itself is read out of the custom property rather than restated here, so there is
  // one 10px - see `.tminiwin`, which declares it.
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

/**
 * The window moved. Everything drawn against it is redrawn and nothing else is.
 *
 * It goes down `lanesMoved` rather than `lanesChanged`, and that is the same rule a
 * key drag follows for the same measured reason: the structural path calls `resize()`,
 * which resizes the drawing buffer, and a wheel gesture is dozens of events. See the
 * note on `repositionLanes`, which counted 24 `renderer.setSize` calls in a ten-move
 * drag before the two were split.
 */
function viewChanged() {
  // Nothing on the strip means anything without a clip, and `view.duration` floors at
  // 1e-6 to keep its arithmetic finite - so a caller that arrived before a take opened
  // would write positions computed against that floor. Every gesture already checks;
  // the test hooks are the path that does not, which is exactly the sort of caller that
  // turns up first.
  if (!timeline) return;
  buildRuler();
  paintMarks();
  paintStripPositions();
  lanesMoved();
}

// A drag resolves at whatever rate the drafts come back, and never queues more
// than one behind the one in flight: the position the pointer is at now is the
// only one worth rendering, so an older one is dropped rather than caught up on.
// Same shape as the colour decode pump, and for the same reason.
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

// A look change while the playhead is parked has to rebuild the image, and it has
// to rebuild it *accurately*. Drafting here would be worse than useless: fade,
// wake and trails are exactly the three a draft zeroes, so grading them against
// one would show nothing changing at all - which is the WYSIWYG failure the
// single-renderer decision exists to prevent, arriving through the back door.
//
// An accurate seek is 33ms at Blackwall, so a slider drag resolves at about
// 30 repaints a second, and the coalescing below is what keeps it there: only the
// latest state is worth rebuilding, so an older request is dropped rather than
// caught up on. A look with a long pre-roll repaints more slowly, which is honest
// - the chip beside it says how many frames it is paying for.
let repaintWanted = false;
let repaintBusy = false;
let repaintScheduled = false;

async function pumpRepaint() {
  if (repaintBusy || !repaintWanted || !timeline) return;
  repaintBusy = true;
  repaintWanted = false;
  try {
    await timeline.seek(timeline.programSec);
  } catch (err) {
    showTimelineError(err);
  } finally {
    repaintBusy = false;
    if (repaintWanted) pumpRepaint();
  }
}

/** Rebuilds the image and the readouts at wherever the playhead is parked. */
function requestRepaint() {
  // Playing rebuilds every frame anyway, and a drag is about to ask for the true
  // image the moment it ends, so neither needs one scheduled underneath it. An
  // export is the same rule for a harder reason: it is walking the accumulators
  // forward a frame at a time, and a repaint landing between two of its frames
  // would reset them under it. It repaints once at the end for the editor's sake.
  if (!timeline || timeline.playing || scrubbing || orbiting || exporting) return;
  repaintWanted = true;
  if (repaintScheduled) return;
  repaintScheduled = true;
  // Deferred to the end of the task so a bulk write asks for one image rather
  // than a queue of them. Selecting Blackwall is twelve registry writes plus the
  // mode itself: repainting on the first would render a look with one parameter
  // applied and eleven still to come, then render the real one behind it - two
  // accurate seeks to show one picture, the first of which never existed.
  queueMicrotask(() => {
    repaintScheduled = false;
    pumpRepaint();
  });
}

paramWritten = (name, tag) => {
  // **Every parameter write reaches the program-out source through here**, which is
  // the one place every write already passes. Forwarding from the individual controls
  // instead would mean a list of parameters somebody has to extend, and the parameter
  // added next year would be the one the output silently did not honour. View state
  // is forwarded too, unlike the repaint below: render scale is the operator's own
  // business on their window, but a source has its own buffer and its own reason to
  // be told what scale to draw at.
  sendProgramOut({ params: { [name]: params.get(name) } });
  // View state changes what you are looking at rather than what the clip is, and both
  // of today's view parameters already do their own work: auto-orbit only means
  // anything with a clock running, and render scale resizes the buffers - which is
  // `resize()`, and `resize()` asks for its own repaint on its last line because
  // reallocating a buffer clears it. The premise this comment used to carry was that
  // resizing the buffers was the work, so a repaint here would be a second one. It is
  // not: resizing a buffer is not drawing into it, and withholding the repaint here
  // while nothing else asked for one is what left the stage black behind the chrome
  // after every move of the render-scale slider.
  if (tag === 'view' || transportWriting) return;
  requestRepaint();
};

const programAtPointer = (e) => view.timeAt(e.clientX);

let scrubbing = false;

ui.bed.addEventListener('pointerdown', (e) => {
  if (!timeline) return;
  // Clicking the bed deselects any selected mark
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
    // The queued position goes first, and it is the whole of the fix for the one
    // gesture this transport exists to get right. A draft is usually in flight
    // when the pointer comes up and a position armed behind it, which the next
    // animation frame would pump - so without this the release would render the
    // true image and then paint a draft of the second-to-last pointer position
    // over the top of it, leaving `drafted` up and the playhead a few frames out.
    // The fetch ordering guarantees the wrong one lands last rather than making
    // it a race.
    draftWanted = null;
    // Releasing is what asks for the true image, so this is the one gesture that
    // pays for a pre-roll. The picture visibly changes here, which is the
    // well-understood convention rather than a surprise.
    timeline.seek(programAtPointer(e)).catch(showTimelineError);
  });
}

// ------------------------------------------------------------ how tall the strip is

// The least of the window the stage keeps. A splitter that can be dragged until there
// is no picture left is not a bound on the strip, it is a different way of losing it.
const MIN_STAGE_SHARE = 0.35;
// Where the splitter sits before anybody drags it: as tall as the lanes need, up to
// this. Without a default the strip still grows a permanent row per keyed parameter
// and takes it off the stage, which is the thing being fixed - the splitter decides
// where the bound is, it is not the only reason there is one.
const DEFAULT_LANES_SHARE = 0.35;
// Client state, like `kinect.lastOpened`: how tall you like the strip is a property of
// this browser and this screen, not of the clip.
const LANES_HEIGHT = 'kinect.lanesHeight';

// What the lanes would take if nothing capped them, written by the rebuild.
let laneStackHeight = 0;
// What the splitter has been dragged to, or null while nobody has.
let userLaneHeight = null;
try {
  // Asked of the string, not of the number, and that is the whole of it: `getItem`
  // answers null when nothing was ever stored, `Number(null)` is 0, and the `saved > 0`
  // this replaces used that one test for both questions. So a strip deliberately dragged
  // shut - which the splitter allows, and stores as a real 0 - came back at the 35%
  // default on the next load, because a stored zero and a missing entry were the same
  // reading. `Number('')` is 0 for the same reason, so an empty entry is excluded here
  // rather than read as a collapsed strip.
  const saved = localStorage.getItem(LANES_HEIGHT);
  const px = Number(saved);
  if (saved !== null && saved.trim() !== '' && Number.isFinite(px) && px >= 0) userLaneHeight = px;
} catch {
  // Private browsing or storage disabled by policy. The default is a good height.
}

/** The tallest the lanes may be here, so the stage keeps its share of the window. */
function laneHeightCeiling() {
  // `--timeline-h` is the fixed part of the strip - the two bar rows, the ruler bed and
  // the overview - and it is read off the element rather than repeated here, because a
  // second copy of it in this file is the mistake `export-check` had already made.
  const fixed = parseFloat(getComputedStyle(ui.root).getPropertyValue('--timeline-h')) || 0;
  return Math.max(0, Math.round(innerHeight * (1 - MIN_STAGE_SHARE)) - fixed);
}

/**
 * `--tlanes-h`, from the two things that decide it, written in the one place that
 * writes it.
 *
 * The variable had a single writer - the rebuild - and the splitter is a second input
 * rather than a second writer, which is the distinction that keeps them from drifting.
 * It also preserves what `--timeline-h` was written for: content still cannot make the
 * strip taller than the lanes it actually has, and a person dragging it is a different
 * thing from a readout growing a digit.
 */
function applyLaneHeight() {
  const wanted = userLaneHeight ?? Math.round(innerHeight * DEFAULT_LANES_SHARE);
  const reachable = Math.min(laneStackHeight, laneHeightCeiling());
  const height = Math.min(laneStackHeight, Math.max(0, Math.min(wanted, laneHeightCeiling())));
  ui.root.style.setProperty('--tlanes-h', `${height}px`);
  // The separator says what it is currently at and what it can reach, written here
  // rather than by the two gestures that move it, for the same reason `--tlanes-h` is:
  // this is the one place that knows the height after both bounds have been applied,
  // and a value announced from anywhere else would be the height that was asked for.
  ui.grip.setAttribute('aria-valuenow', String(height));
  ui.grip.setAttribute('aria-valuemax', String(Math.max(0, reachable)));
}

// One scroller and one mirror. The rail has `overflow: hidden` so there is no second
// gesture that could disagree with this one - two synchronised scrollers is two
// implementations of one position.
ui.lanes.addEventListener('scroll', () => {
  ui.railLanes.scrollTop = ui.lanes.scrollTop;
});

/**
 * The splitter.
 *
 * `resize()` is throttled to one animation frame rather than run per pointer event,
 * and that is the same measured cost `repositionLanes` exists to avoid: it reallocates
 * the drawing buffer and the composer's targets. It cannot simply be deferred to the
 * release either - the strip is growing under a canvas that has not been told, so the
 * two would overlap for the length of the drag. One per frame is what a smooth drag
 * needs and is bounded; a pointer stream is neither.
 */
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

/**
 * The same splitter from the keyboard, because the pointer was the only way to it.
 *
 * A step is a lane row rather than a pixel. What is being resized is a stack of rows,
 * so a press that moves less than one of them looks like a control that does nothing -
 * and reaching a lane past the fold would take dozens of presses. Home and End are the
 * two ends the drag can reach, which is what `aria-valuemin`/`max` announce.
 *
 * Written against the height the strip *has* rather than against `userLaneHeight`,
 * which is null until something drags it - so the first press moves from where the
 * splitter visibly is instead of jumping from the default it was never told about.
 */
const LANE_KEY_STEP = 22;

ui.grip.addEventListener('keydown', (e) => {
  const from = parseFloat(getComputedStyle(ui.root).getPropertyValue('--tlanes-h')) || 0;
  const ceiling = Math.min(laneStackHeight, laneHeightCeiling());
  const to = e.key === 'ArrowUp' ? from + LANE_KEY_STEP
    : e.key === 'ArrowDown' ? from - LANE_KEY_STEP
      : e.key === 'PageUp' ? from + LANE_KEY_STEP * 4
        : e.key === 'PageDown' ? from - LANE_KEY_STEP * 4
          : e.key === 'Home' ? 0
            : e.key === 'End' ? Math.max(0, ceiling)
              : null;
  if (to === null) return;
  // Only once it is going to act, so Tab and everything else still leave the strip.
  e.preventDefault();
  userLaneHeight = Math.max(0, to);
  applyLaneHeight();
  resize();
  placeChrome();
  rememberLaneHeight();
});

/** Where the splitter has been put, kept for this browser rather than for the clip. */
function rememberLaneHeight() {
  // Stored as what was asked for rather than as what the clamp allowed, so a strip
  // dragged tall on a big screen is still tall when the window is made big again.
  try {
    localStorage.setItem(LANES_HEIGHT, String(userLaneHeight));
  } catch {
    // Storage is a convenience here; the gesture already worked.
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

// ------------------------------------------------------------------ zoom and pan

/**
 * The wheel over the strip. Vertical zooms about the pointer, horizontal pans.
 *
 * **Zooming about the pointer rather than the centre is the whole usability of it.**
 * The gesture people run is "put the cursor on the thing, zoom in" - anchoring the
 * centre instead means the thing you were pointing at walks off the edge, and the way
 * you find it again is to zoom back out, which is the gesture you were trying to
 * avoid.
 *
 * `preventDefault` is safe here rather than rude: `html, body` are `overflow: hidden`,
 * so there is no page scroll to suppress, and the trackpad's horizontal axis would
 * otherwise do nothing at all.
 */
/**
 * Where the pointer is as a fraction of the *clip*, which is the coordinate both the
 * zoom and the pan are expressed in.
 *
 * The two surfaces answer it differently because they show different things, and that
 * is the whole of what "over the overview" means: an x on the ruler is a position in
 * the window, an x on the overview is a position in the clip. Reading both through one
 * of the two mappings is how a wheel over the overview ends up zooming somewhere the
 * cursor is not.
 */
function clipFractionAt(surface, clientX) {
  const r = (surface === ui.mini ? ui.mini : ui.bed).getBoundingClientRect();
  const f = r.width > 0 ? Math.min(1, Math.max(0, (clientX - r.left) / r.width)) : 0.5;
  return surface === ui.mini ? f : view.a + f * (view.b - view.a);
}

/**
 * A wheel event's two deltas in pixels, whatever unit the browser chose to report.
 *
 * `deltaMode` is `DOM_DELTA_LINE` on Firefox and on some Linux mice, where one notch is
 * `3` rather than `100` - so a rule dividing by 100 turned a full notch into 3% of one
 * and the zoom read as a control that does nothing. `DOM_DELTA_PAGE` is rarer still and
 * is a viewport. Both are converted here rather than at the two places that consume the
 * deltas, because the second consumer is the pan and it had the same unit bug for the
 * same reason - a share of the track computed from three "pixels".
 *
 * The line height is the strip's own row rather than a constant: `LANE_KEY_STEP` is what
 * one lane is worth everywhere else in this file, and a wheel notch moving a different
 * amount from an arrow key on the same surface is the kind of disagreement nothing
 * records.
 *
 * **A page has two dimensions and the two axes get the right one each.** This converted
 * both through `ui.bed.clientHeight`, which is the ruler row - tens of pixels, and not a
 * page by any reading. The horizontal case was the worse of the two: a page of panning
 * became a couple of dozen pixels and was then divided by the track width, so a page-mode
 * pan moved almost nothing. Stated rather than measured, because nothing on this rig
 * emits `DOM_DELTA_PAGE` - the line mode is what Firefox actually sends and what the
 * proof row drives.
 */
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
  // A wheel that started inside the lane scroller, on the axis that scroller uses,
  // belongs to it rather than to the zoom - so it is left alone entirely, native
  // scrolling and all, rather than being handled here. `#tLanes` is a descendant of
  // `ui.beds`, so without this every wheel over a lane bubbled to this listener, got
  // `preventDefault`ed and zoomed, and the only way left to reach a lane below the fold
  // was to find and drag a thin scrollbar.
  //
  // Only while the lanes actually overflow, asked of `scrollHeight` against
  // `clientHeight` rather than of the scroll position - a rule keyed on position would
  // hand the wheel back to the zoom at the top and bottom of the travel, which is a
  // surface that changes what it does depending on how far you have already come. With
  // room for every lane there is nothing to scroll and the wheel zooms as it does
  // anywhere else on the strip.
  //
  // The axis test is the same one the branch below uses, so a horizontal pan over the
  // lanes still pans rather than falling through to the browser.
  if (Math.abs(delta.y) >= Math.abs(delta.x)
    && ui.lanes.contains(e.target)
    && ui.lanes.scrollHeight > ui.lanes.clientHeight) return;
  e.preventDefault();
  // A trackpad reports both axes at once and a mouse reports one, so the dominant
  // axis decides which gesture this is - reading both would zoom and pan on every
  // diagonal twitch.
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

// Both surfaces, because the overview is where somebody who has just found the window
// box will try the wheel next, and a strip that zooms on one half and does nothing on
// the other reads as broken rather than as scoped.
for (const surface of [ui.beds, ui.mini]) {
  surface.addEventListener('wheel', onStripWheel(surface), { passive: false });
}

/**
 * The overview's own gestures: drag the window to pan, drag an edge to zoom, click
 * anywhere else to bring the window there.
 *
 * One handler deciding by what was hit rather than three listeners, because the edges
 * are children of the box and a listener on each would have to stop the box's own
 * handler from also running - which is a thing to get right on every path instead of
 * a question asked once.
 */
let miniDrag = null;

ui.mini.addEventListener('pointerdown', (e) => {
  if (!timeline) return;
  const rect = ui.mini.getBoundingClientRect();
  if (rect.width <= 0) return;
  const at = (e.clientX - rect.left) / rect.width;
  const edge = e.target.classList.contains('w') ? 'w' : e.target.classList.contains('e') ? 'e' : null;
  const inside = e.target === ui.miniWin || edge !== null;
  ui.mini.setPointerCapture(e.pointerId);
  if (!inside) {
    // A click on open track centres the window there rather than jumping its left
    // edge to the pointer, which is what "take me there" means and what leaves the
    // thing you clicked on in the middle of the ruler.
    const half = (view.b - view.a) / 2;
    view.set(at - half, at + half);
    viewChanged();
  }
  miniDrag = { edge, at, a: view.a, b: view.b };
});

ui.mini.addEventListener('pointermove', (e) => {
  if (!miniDrag) return;
  const rect = ui.mini.getBoundingClientRect();
  const at = (e.clientX - rect.left) / Math.max(1, rect.width);
  const d = at - miniDrag.at;
  // Both edges read from the position the drag *started* at rather than from the last
  // event, so a drag that runs into the clamp at one end and comes back lands where
  // the pointer says instead of where the clamping left it.
  // The west edge is clamped before `set` sees it, and the east one is not, which is
  // asymmetric because `set` is. Handed a reversed pair it keeps the *start* it was
  // given and grows the minimum span rightwards from there: for an east drag that start
  // is the untouched west edge, so the gesture stops at the minimum holding the
  // opposite edge, which is what an edge resize means. For a west drag the start is the
  // pointer, so the east edge jumped past where it had been and the minimum-width
  // window then panned along with the pointer - a resize that turns into a drag once it
  // crosses the far edge.
  const moved = miniDrag.edge === 'w'
    ? view.set(Math.min(miniDrag.a + d, miniDrag.b - view.minSpan()), miniDrag.b)
    : miniDrag.edge === 'e' ? view.set(miniDrag.a, miniDrag.b + d)
      : view.set(miniDrag.a + d, miniDrag.b + d);
  if (moved) viewChanged();
});

for (const type of ['pointerup', 'pointercancel']) {
  ui.mini.addEventListener(type, () => { miniDrag = null; });
}

let handleDrag = null;

for (const handle of [ui.in, ui.out]) {
  handle.addEventListener('pointerdown', (e) => {
    if (!timeline) return;
    handle.setPointerCapture(e.pointerId);
    handleDrag = handle === ui.in ? 'in' : 'out';
    pauseTransport();
    e.stopPropagation();
  });
  // The drag itself, previewed rather than committed: the pair is written and the strip
  // repaints, and the deliverable, the undo step and the transport are the release's
  // business. That distinction is why this calls `writeClipRange` where the release calls
  // `setClipInOut` - going through `setClipInOut` here would write the deliverable and seek
  // the transport once per pointer event, which is the seek storm the comment on its own
  // frame comparison records having been rewritten to avoid.
  //
  // **This used to assign the two bindings directly, and the door's comment said no such
  // writer existed.** Both halves are fixed rather than one: the write is the module's now,
  // and what the door claims is what the language enforces. The pair's own clamp still runs
  // here, so a drag can no longer draw a trim its own release would refuse - measured on
  // the build before this, dragging the out marker left of the in point with no out point
  // set followed the pointer and then snapped back on release.
  handle.addEventListener('pointermove', (e) => {
    if (handleDrag !== (handle === ui.in ? 'in' : 'out')) return;
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
      if (handleDrag !== (handle === ui.in ? 'in' : 'out')) return;
      handleDrag = null;
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
  if (timeline.playing) timeline.pause();
  else timeline.play().catch(showTimelineError);
});

// ------------------------------------------------------------ in and out

/** Parks the playhead somewhere, stopping first. Seeks clamp into the clip range. */
function goTo(sec) {
  if (!timeline) return;
  pauseTransport();
  timeline.seek(Math.max(0, Math.min(sec, timeline.duration))).catch(showTimelineError);
}

/**
 * Puts one end of the export range where the playhead is.
 *
 * The markers on the ruler have always been draggable and were the only way to set
 * this - which was academic, because they were not in the document at all. Even with
 * them back, a drag cannot put a boundary on an exact frame, and an export range is
 * exactly the setting where that matters.
 */
function setClipRangeFromPlayhead(which) {
  if (!timeline) return;
  const t = timeline.programSec;
  if (which === 'in') setClipInOut({ in: Math.max(0, Math.min(t, clipOut ?? timeline.duration)) });
  else setClipInOut({ out: Math.max(clipIn, Math.min(t, timeline.duration)) });
  history.commit();
}

ui.setIn?.addEventListener('click', () => setClipRangeFromPlayhead('in'));
ui.setOut?.addEventListener('click', () => setClipRangeFromPlayhead('out'));
ui.clearRange?.addEventListener('click', () => {
  // `null` rather than the duration, so the range keeps meaning "to the end" if the
  // retime later makes the program longer.
  setClipInOut({ in: 0, out: null });
  history.commit();
});

// ------------------------------------------------------------ the keyboard

const TYPING_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
const isTyping = (el) => el instanceof HTMLElement && (TYPING_TAGS.has(el.tagName) || el.isContentEditable);

// **There is no `?` key any more, and no legend for it to print.** The list of shortcuts
// was one string written out onto the application bar's message chip, and when the chip
// went the string had exactly one reader left - a `__probe` accessor keeping it alive for
// three proof-tool rows that asserted the legend named the keys they had just added. A
// constant nothing displays, checked by rows about a display that does not exist, is the
// shape this repo already has a mutation for, so the legend went with the surface rather
// than being given a second one. The keys themselves are all still bound below.

/**
 * The editor's keyboard, and the guard that has to come with it.
 *
 * Nothing here existed except `h` and Cmd-Z, so the space bar - the one key everybody
 * tries first - did nothing at all. That old handler also had no typing guard, which
 * was harmless only while the page had no text field: the export name arrived in this
 * change and `i`, `o` and `m` are all letters somebody has to be able to type into it.
 *
 * **There is deliberately no J/K/L shuttle.** Reverse is not unimplemented here, it is
 * unreachable: the surface memory and the afterimage are advanced one source frame at
 * a time and neither can be walked back, which is why `retime.assertMonotonic` refuses
 * a descending curve outright. A control offering reverse would be a control that
 * cannot work, and the honest answer is not to draw one.
 */
addEventListener('keydown', (e) => {
  if (isTyping(e.target)) return;
  // A key another control has already consumed is not a shortcut, and the guard is
  // written against the class rather than against the control that found it. `isTyping`
  // covers the form fields, which is every control whose keys the *browser* owns - and
  // the splitter is the first one in this page whose keys are owned by us: it takes
  // Home and End to reach the two ends of its travel, and those are the same two keys
  // that seek to the clip boundaries. A keyboard user collapsing the strip got the
  // collapse *and* a pause and an accurate seek, one gesture reading as two.
  //
  // `defaultPrevented` rather than `stopPropagation` in the splitter, because this is
  // the handler with the conflict and a control that consumes a key already says so by
  // calling `preventDefault`. The next control that binds a key of its own is asked by
  // existing rather than having to know this handler is here.
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
  // Start or stop recording - the same action the sidebar button takes. The button's
  // disabled state is the authority on whether the action is available. Require an
  // unmodified press so Ctrl+R / Cmd+R still reloads the page.
  if ((e.key === 'r' || e.key === 'R') && !e.metaKey && !e.ctrlKey && !e.altKey && !EDITING && ui.recGo && !ui.recGo.disabled) {
    e.preventDefault();
    ui.recGo.click();
    return;
  }
  // Mark during recording - the same action the sidebar button takes, before the editing
  // surface claims the key for its own marks. The button's disabled state is the authority
  // on whether there is a recording to mark. Require an unmodified press for the same
  // reason as the record shortcut above.
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
  // A modifier other than shift means the key belongs to the browser or the OS.
  // Shift is ours: it is the difference between a frame and a second.
  //
  // **AltGr is not one of those modifiers - it is how a character gets typed.** On a
  // German, Nordic or Polish layout `[` and `]` are AltGr presses, and Windows delivers
  // AltGr as ctrl+alt, so a guard reading those two bits returned before the mark keys
  // below could run and this program advertised two shortcuts nobody on those layouts
  // could press. The test is whether the press produced a character or a command:
  // `e.key` is already the composed one, so a single character under AltGr means the
  // modifier did its composing job and the key that came out is ours, while
  // `ArrowRight` under the same two bits is the right-hand Alt being used as a command
  // modifier and is still not.
  const composed = e.key.length === 1 && e.getModifierState('AltGraph');
  if ((e.metaKey || e.ctrlKey || e.altKey) && !composed) return;

  const step = (frames) => {
    pauseTransport();
    timeline.seek(Math.max(0, Math.min((timeline.frame + frames) / timeline.outputFps, timeline.duration)))
      .catch(showTimelineError);
  };

  switch (e.key) {
    case ' ':
      // A focused button owns the space bar, because that is how a button is pressed
      // without a mouse. The transport takes it only when nothing else has a claim -
      // and pressing space just after clicking play still works, through the button.
      if (e.target instanceof HTMLElement && e.target.closest('button, [role=button]')) return;
      // Or the page scrolls under the strip.
      e.preventDefault();
      if (timeline.playing) pauseTransport();
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
      // Delete selected mark first, then try keyframe selection
      if (selectedMark) { deleteMark(selectedMark).catch(showTimelineError); return; }
      deleteSelectedKey();
      return;
    case 'm': case 'M': e.preventDefault(); markHere().catch(showTimelineError); return;
    // The other half of item three, and the half that is actually usable: a tick is
    // five pixels of diamond, so pressing one is a gesture and stepping through them
    // is a key. Through `goTo` like Home and End, so a jump pauses and clamps the
    // same way every other seek on this keyboard does.
    //
    // The epsilon is what stops a playhead parked exactly on a mark finding itself
    // and going nowhere, which reads as the key not being bound at all. It is a
    // microsecond of program time - smaller than any frame this program can show, so
    // it can never skip a mark that is genuinely a step away.
    // **Only the marks the playhead can actually get to.** `markSecondsInOrder` clamps
    // to the take, not to the trim, and `Transport.frameAt` clamps every seek into
    // in..out - so on a clip trimmed to start at five seconds, pressing `[` at the in
    // point found a mark at two, asked to go there, and arrived back at five. The key
    // read as unbound at exactly the edge where somebody is most likely to press it.
    //
    // Filtered here rather than in `markSecondsInOrder`, because the ticks must go on
    // being drawn where they are: a mark outside the trim is drawn inside `.tshade`,
    // which is the shading that exists to say "the export will not reach this". Moving
    // those ticks to the boundary would put them where the export *does* reach and
    // report a moment that is not there. What is unreachable is the seek, not the mark.
    case '[': case ']': {
      e.preventDefault();
      const here = timeline.programSec;
      const seconds = markSecondsInOrder().filter(reachableInClip);
      const to = e.key === '['
        ? seconds.filter((s) => s < here - 1e-6).pop()
        : seconds.find((s) => s > here + 1e-6);
      if (to !== undefined) goTo(to);
      return;
    }
    // Zoom about the playhead rather than about the centre of the window, for the same
    // reason the wheel zooms about the pointer: the playhead is what the keyboard is
    // pointing at, and zooming away from it is zooming away from the edit.
    case '+': case '=':
      e.preventDefault();
      if (view.zoomAbout(timeline.programSec / view.duration, ZOOM_PER_NOTCH)) viewChanged();
      return;
    case '-': case '_':
      e.preventDefault();
      if (view.zoomAbout(timeline.programSec / view.duration, 1 / ZOOM_PER_NOTCH)) viewChanged();
      return;
    // Pan the window along the clip, which was the one thing the keyboard could not do.
    //
    // Zoom, fit and frame were all here and all of them *change* the window's width;
    // moving a window of the width you already have was reachable only by dragging the
    // overview box, and the overview and its two edges are `div` and `i` elements with
    // no tabindex and nothing but pointer handlers - so on a long clip at a close zoom
    // there was no keyboard way to get from one end to the other except by widening the
    // window and narrowing it again somewhere else.
    //
    // A quarter of the visible window per press rather than a fixed number of seconds,
    // for the same reason the wheel zooms by a factor: at a close zoom a second is the
    // whole screen and at fit-zoom it is invisible, so a constant is the wrong pace at
    // every zoom but one. `panBy` already existed for this and had no caller, which is
    // its own small piece of evidence that the gesture was meant to be here.
    case ',': case '<': e.preventDefault(); if (view.panBy(-0.25)) viewChanged(); return;
    case '.': case '>': e.preventDefault(); if (view.panBy(0.25)) viewChanged(); return;
    case 'f': case 'F': e.preventDefault(); if (view.fit()) viewChanged(); return;
    case 'z': case 'Z':
      e.preventDefault();
      if (view.frame(clipIn, clipOut ?? view.duration)) viewChanged();
      return;
    default:
  }
});

// The speed slider's own coordinate, which is not the rate.
//
// `<input type="range">` is linear in its value, and program length goes as 1/rate,
// so a slider whose value *was* the rate put almost all of its useful travel in the
// bottom tenth: on the old 0.1..4 range one 0.05 step near 0.1 changed the clip's
// length by a third and the same step near 4 changed it by one percent. The travel is
// logarithmic instead, so a step anywhere is the same proportional change - about 1.9%
// of the clip's length at the 0.005 the arrow keys move.
//
// The detent is not a rounding accident. 1.00x is the value that has to be reachable
// exactly rather than approximately: it is what `slopeAt` reports to the audio gate,
// and a take that is "playing at 1.0" at 0.9995 is a take the gate reads as retimed.
// A log grid has no reason to land on 1 at all, so the band snaps to it and the rest
// is quantised to a millirate, which is finer than the readout beside it can show.
//
// Its width belongs to the control rather than to the rate, and the two attempts to
// state it in rate are both recorded below at `DETENT_PX` - the second was wrong by a
// factor of four because the arithmetic was done against a slider four times wider than
// the one the stylesheet ships.
const RATE_MIN = 0.1;
const RATE_MAX = 4;

/**
 * How wide the 1.00x detent is, in pixels of the control it lives on.
 *
 * **It was a band of rate, and a band of rate is not a band of anything a finger can
 * find.** The travel spans a factor of 40, so +/-3% of rate is `ln(1.03)/ln(40)` of the
 * slider - 0.74px on each side of the shipped 92px control, which is sub-pixel and makes
 * the one value the detent exists to make reachable unreachable again. That is the same
 * failure this constant was written to fix, surviving its own fix: the comment beside it
 * did the arithmetic against a ~380px control and the stylesheet says
 * `.tchip input[type=range] { width: 92px }`.
 *
 * So it is stated in pixels and converted against the control as rendered, rather than
 * agreed with in a comment - the same rule the proof tools learned about layout constants
 * they kept their own copy of. It costs nothing real either way, since a deliberate 2%
 * speed change is not a thing anyone grades.
 *
 * **The number of pixels it actually buys is measured rather than computed**, because the
 * value a click produces is not `x / width`: a range input's track is shorter than its box
 * by the thumb, so arithmetic from the element's width is off by however wide that is.
 * `editor-check` sweeps the control a pixel at a time and reports what a pointer really
 * gets - 8 contiguous pixels of the 92, x 56..63, on the shipped stylesheet.
 */
const DETENT_PX = 3;

const rawRateFromSlider = (v) => (
  RATE_MIN * (RATE_MAX / RATE_MIN) ** Math.min(1, Math.max(0, Number(v) || 0))
);
/**
 * Whether a slider *position* is inside the detent - a position, because the band is a
 * number of pixels and the mapping from rate to travel is logarithmic, so the same band
 * in rate is a different number of pixels at every point on the control.
 *
 * The width is read off the element each time rather than cached: the strip is resizable
 * and a cached number would be one more layout constant kept in two places. The 92px
 * fallback is for a panel that is hidden, where the rect is zero and no pointer can reach
 * the control anyway.
 */
const insideDetent = (v) => {
  const width = ui.rate.getBoundingClientRect().width || 92;
  return Math.abs(Number(v) - sliderFromRate(1)) <= DETENT_PX / Math.max(1, width);
};

/**
 * The rate a slider position means, with the detent applied - but only to a gesture that
 * came into the band from outside it.
 *
 * **A detent is for a value you are aiming at, and it was also eating one you already
 * had.** `restoreProject` accepts any positive finite rate, so a project can carry 1.02x;
 * the thumb is positioned there correctly, and then the first small pointer input - a
 * touch, a nudge, anything landing back in the same neighbourhood - came through here and
 * returned exactly 1.00. Two percent off every cut and every key and a different rendered
 * file, before the pointer had meaningfully moved. The band exists so 1.00x is *reachable*
 * exactly, not so it is the only thing reachable near it.
 *
 * Read here and armed in the `input` handler rather than armed here, because this is also
 * called by `timingChanged` to ask whether the thumb already shows the current rate -
 * arming from inside would make a comparison change the thing it is comparing, which is
 * the observer effect this repo keeps finding in its own instruments.
 */
const rateFromSlider = (v) => {
  const holding = rateGesture ? rateGesture.detentArmed === false : false;
  return !holding && insideDetent(v) ? 1 : Number(rawRateFromSlider(v).toFixed(3));
};

const sliderFromRate = (rate) => (
  Math.log(Math.min(RATE_MAX, Math.max(RATE_MIN, rate)) / RATE_MIN)
  / Math.log(RATE_MAX / RATE_MIN)
);

// Where the thumb starts. Written from the rate rather than spelled out in the markup,
// so the position of 1.00x is stated once - and written here rather than left to
// `timingChanged`, which returns early until a take is open and would otherwise leave
// the thumb at 0.1x under a readout saying 1.00x.
ui.rate.value = String(sliderFromRate(retime.rate));

/**
 * What a speed gesture holds still, captured once when it starts.
 *
 * Speed is the retime's slope, which is document state rather than transport state -
 * it is the one-key version of the curve, and the curve takes over the moment there
 * are keys. What changing it must *not* do is move the picture.
 *
 * **The anchor is source time, not program time, and that is the whole fix.** They
 * are the same number only at rate 1: with program = source / rate, holding the
 * playhead at program 10s across 1x -> 2x walks the image from source 10.000s to
 * 20.000s - a different moment in the take arriving under a playhead that did not
 * move. Measured at exactly those numbers before this, and it is the whole of "the
 * frame that you're on is not the same anymore when you change the speed".
 *
 * Anchoring source settles the other half for free, and the arithmetic is the reason
 * rather than a coincidence: the program length is `sourceDuration / rate` too, so
 * the playhead lands at the same *fraction* of a ruler that rescaled underneath it.
 * 10/44 and 5/22 are both 22.7%. The picture holds still and so does the playhead.
 *
 * Captured once for the gesture instead of recomputed per event because
 * `timeline.frame` is an integer on the output grid, so every round trip through it
 * quantises - and re-deriving the anchor from a quantised position lets a drag walk
 * the frame it is supposed to be holding.
 */
let rateGesture = null;

function beginRateGesture({ fromKey = false } = {}) {
  if (rateGesture || !timeline) return;
  // Taken before the object exists rather than inside it, so `takeTransport`'s cancel
  // provably cannot reach this gesture - the ordering is stated here instead of resting
  // on when a property initialiser happens to run.
  const gen = takeTransport();
  rateGesture = {
    // Whether a key is holding this open, which decides whether `change` may end it -
    // see the listener wiring below. Read off how the gesture *started*, because the
    // repeats after the first arrive as `input` and would otherwise look like a value
    // written by a script.
    fromKey,
    // The generation this gesture owns. A gesture is held for as long as a finger or a
    // key is down, which is long enough for a project fetch started *before* it to land
    // in the middle of it - and `loadProjectNamed` takes the transport and restores a
    // different document. `takeTransport` drops the gesture outright when that happens,
    // so this number is what the *resume* is checked against: the seek below is a
    // pre-roll, long enough for a second taker to arrive after the release has already
    // decided the take should be running.
    gen,
    // Whether the detent may act yet. Disarmed only for a gesture that *begins* inside
    // the band at something other than 1.00x, which is a rate no slider could have
    // produced - it came out of a project file. The `input` handler arms it the moment
    // the thumb leaves the band, so aiming at 1.00x from outside still snaps.
    detentArmed: retime.rate === 1 || !insideDetent(sliderFromRate(retime.rate)),
    source: retime.sourceSecAt(timeline.programSec),
    wasPlaying: timeline.playing,
    // The parameterisation the gesture started in. Every program time in the document
    // is rescaled from *these* on each event rather than from wherever the previous
    // event left them - see `reparameteriseProgramTime` for why a product of per-event
    // factors is the wrong number.
    rate: retime.rate,
    times: programTimeSnapshot(),
    // Whether the slope was ever actually put anywhere. A gesture that only ever
    // touched the control has nothing to seek for and nothing to undo but its pause.
    applied: false,
  };
  // Paused once for the gesture rather than on every event, and resumed at the end.
  timeline.pause();
}

/**
 * Ends the gesture, whichever event gets here first.
 *
 * **A gesture must end on release rather than on a change, because the two are not
 * the same set of gestures** - and the difference was silent data loss. `change` fires
 * only when the committed value differs from the one the control was picked up at, so
 * two ordinary things ended nothing: a press that releases in place, and a drag that
 * wanders and comes back. Measured in Chromium: the first emits `pointerdown ->
 * pointerup` and the second `pointerdown -> input x6 -> pointerup`, neither with a
 * `change` anywhere in it. The gesture therefore stayed live, holding a
 * `programTimeSnapshot` of the document as it was *then* - and the next real speed
 * change reused it, rewriting every key and both cuts from that stale snapshot and
 * silently undoing whatever had been edited in between. The take stayed paused too,
 * because the resume lives on the path that never ran.
 *
 * So every way out of the control ends it - `change`, `pointerup`, `pointercancel`,
 * `keyup` - and the first one through does the work while the rest find it already
 * ended. That ordering is measured rather than assumed: `pointerup` lands *before*
 * `change` on a pointer drag, and `change` before `keyup` on an arrow key, so neither
 * path has a winner that leaves the other's work undone. The control captures the
 * pointer, so a release 600px outside it still arrives here.
 */
function endRateGesture() {
  if (!rateGesture) return;
  // A take closed while the slider was held leaves a gesture with nothing to end it
  // against. Dropped rather than applied, because there is no transport to seek.
  if (!timeline) { rateGesture = null; return; }
  // No branch here for a gesture that lost the transport, because there is no such
  // gesture to find: `takeTransport` dropped it, and the guard above is what catches it.
  // A second check here would be a second thing to keep in step with the first.
  const { wasPlaying, applied, rate: began, gen } = rateGesture;
  if (!applied) {
    rateGesture = null;
    if (wasPlaying) timeline.play().catch(showTimelineError);
    return;
  }
  const rate = rateFromSlider(ui.rate.value);
  // Before the gesture is cleared, because `applyRate` rescales *from* it - the
  // snapshot and the parameterisation it was taken in both live on `rateGesture`, so
  // nulling it first throws inside the one call the release exists to make.
  const program = applyRate(rate);
  rateGesture = null;
  // Whatever is queued behind the draft in flight would otherwise paint itself over
  // the true image this is about to ask for.
  draftWanted = null;
  timingChanged();
  timeline.seek(program)
    // Only if nothing has taken the transport over since. The seek is a pre-roll, so it
    // is long enough for a second speed change, a project load, an undo or an output-rate
    // change to start and make its own decision about whether the take should be running
    // - each of them having read a transport this gesture had already paused. An
    // unconditional resume lands that older decision on top of the newer one.
    .then(() => { if (wasPlaying && gen === transportGen) return timeline.play(); })
    .catch(showTimelineError);
  // A drag that came back to the slope it started at has restored the document
  // exactly - `applyRate` reads every time from the snapshot rather than from where
  // the last event left it - so there is nothing to remember. Committing anyway would
  // put an undo step on the stack that undoes nothing. The true image is still asked
  // for above, because the drafts along the way were real and one of them is on screen.
  if (rate !== began) history.commit();
}

/**
 * Puts the slope at `rate` and carries the whole document across with it.
 *
 * The order is load-bearing rather than tidy. The playhead moves to its anchor first,
 * so that by the time the cuts are rescaled it is already sitting at the same fraction
 * of the ruler they are - which means `setClipInOut` finds it inside the range and
 * repaints instead of seeking. Rescaling first would step a still-old playhead against
 * new cuts and buy an accurate seek per slider event, which is the storm the draft
 * pump exists to avoid.
 */
function applyRate(rate) {
  retime.rate = rate;
  rateGesture.applied = true;
  const program = programHoldingAnchor();
  // `frameOf` rather than `frameAt`, and that is the second half of the ordering above.
  // `frameAt` clamps to the clip range, which at this instant is still the *previous*
  // rate's range - the cuts are rescaled on the next line. Clamping against them puts
  // the playhead on an old boundary that the rescale then moves out from under it:
  // with cuts at 10s/15s and the slope going 1x -> 2x, the anchor at 5.5s is dragged
  // up to the old in-point at 10s while the new range becomes 5s/7.5s, so
  // `setClipInOut` finds the playhead outside and buys the accurate seek this whole
  // path exists to avoid - one per slider event. Unclamped, the playhead and the cuts
  // scale by the same `k` and it stays inside by arithmetic rather than by luck.
  // **And the anchor lands on the output grid, which costs up to half a frame of program
  // time - `rate / (2 * outputFps)` of source.** A reviewer read that as the speed control
  // failing to hold the picture, and the number is real: from program 10s at 1x, 2.35x
  // wants program 4.255319s, the nearest frame is 128 at 4.266667s, and the source moment
  // moves 10.0000s to 10.0267s. At 4x and 30fps the worst case is 66.7ms, two capture
  // frames.
  //
  // It is the grid rather than the rounding, and that is worth being exact about because
  // "preserve the source position" sounds available and is not. The transport shows a
  // frame, so the only choice is *which* frame - and with `source = program * rate` the
  // two errors differ by a constant factor, so the frame nearest in program time is
  // already the frame nearest in source time. `Math.round` is the minimiser; what is left
  // is that no output frame maps to the moment being asked for.
  //
  // It also accumulates: each change re-derives the anchor from a frame the previous one
  // quantised, so 1x -> 2.35x -> 1x lands about 33ms from where it started. Carrying a
  // sub-frame program time through the transport would close that, and it would change
  // the thing `determinism-check` and `timeline-check` both rest on - a frame-indexed
  // program clock - so it is named here rather than done in passing. `editor-check` has
  // an off-grid arm asserting the bound, because its other three sit exactly on the grid
  // and had never measured this at all.
  timeline.frame = timeline.frameOf(program);
  reparameteriseProgramTime(rateGesture.rate / rate, rateGesture.times);
  return program;
}

/** Where the anchored frame sits now that the slope has changed. */
function programHoldingAnchor() {
  return Math.max(0, Math.min(retime.programSecAt(rateGesture.source), timeline.duration));
}

// Wrapped rather than passed straight in, because the listener's first argument is a
// `PointerEvent` and this function's is now an options object - handing it the event
// would read `fromKey` off it and get `undefined`, which happens to be the right answer
// today and would silently stop being one.
ui.rate.addEventListener('pointerdown', () => beginRateGesture());
// The keys a range input answers, named rather than left unconditional. Tab fires
// `keydown` here too and then takes the focus away *before* `keyup`, so an
// unconditional start paused the take and handed the gesture to a control that has no
// end handler for it. Measured: `keydown -> blur -> focusout -> button:keyup`, with the
// keyup delivered to the button.
const RATE_KEYS = new Set([
  'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End',
]);
ui.rate.addEventListener('keydown', (e) => { if (RATE_KEYS.has(e.key)) beginRateGesture({ fromKey: e.key }); });
// `blur` is in here for the same reason and is the one that closes the class: it is the
// last event the control gets on *any* way out of it, including the ones nobody thought
// of. It cannot pre-empt a commit either - on an arrow followed by Tab, `change` lands
// three events before `blur`, so the gesture is already over by then.
for (const type of ['pointerup', 'pointercancel', 'blur']) {
  ui.rate.addEventListener(type, endRateGesture);
}
// **A `keyup` ends this gesture only when it is the key holding it open**, which is why
// `fromKey` is the key's name rather than a flag. Any other release used to end it: hold
// an arrow to ramp the speed, tap Shift on the way, and the Shift release closed the
// gesture while the arrow was still repeating. The next repeat opened a *new* one, read
// `timeline.playing` off a transport the first had already paused, and so recorded
// `wasPlaying: false` - so the real release left a running take stopped, and one
// adjustment became several undo steps and several accurate seeks. Same shape as the
// `change` handler two doors up, arriving on a different event.
//
// A gesture with no `fromKey` - a pointer drag, or a value written straight into the
// control - is not ended here at all. `pointerup` and `blur` own those, and a stray
// keyboard release during a pointer drag is the same intruder wearing the other hand.
ui.rate.addEventListener('keyup', (e) => {
  if (rateGesture && rateGesture.fromKey === e.key) endRateGesture();
});
// **`change` ends a gesture only when no key is holding one open, because a held arrow
// key is not one gesture to this control - it is one per repeat.** Chromium fires
// `keydown -> input -> change` on every auto-repeat and a single `keyup` at the end, so
// an unconditional `change` handler ended and restarted the gesture on each one:
// measured at six undo commits and six accurate pre-roll seeks for one held key, where
// a drag of the same travel costs one of each. The seek storm this control was rewritten
// to avoid was still there on the keyboard, behind the one gesture that cannot be
// noticed by watching the pointer.
//
// It also lost the take. Each repeat's `beginRateGesture` read `timeline.playing` off a
// transport the previous repeat had just paused, so `wasPlaying` was true only for the
// first of six - and the resume the first one owned was invalidated by the second taking
// the transport. Releasing the key left a running take stopped.
//
// The condition is on the gesture rather than on the event because `change` is still the
// only ending a value written straight into the control ever gets - no pointer, no key,
// which is how every tool that drives this slider works.
ui.rate.addEventListener('change', () => { if (!rateGesture?.fromKey) endRateGesture(); });

ui.rate.addEventListener('input', () => {
  if (!timeline) return;
  beginRateGesture();
  // Once the thumb has been outside the band, the detent is live for the rest of the
  // gesture. Armed from the raw position rather than from the snapped rate, because the
  // snapped one cannot say whether it is inside the band or exactly on the value.
  if (rateGesture && !rateGesture.detentArmed && !insideDetent(ui.rate.value)) {
    rateGesture.detentArmed = true;
  }
  const program = applyRate(rateFromSlider(ui.rate.value));
  // `moved` because a speed change rescales every lane and adds none: the set of
  // lanes is a property of which tracks carry keys, which a slope cannot touch.
  timingChanged({ moved: true });
  // A cheap frame per event and a true one on release - the scrubber's rule, and
  // here for a measured reason: twenty slider steps used to cost twenty accurate
  // seeks, each of which renders a whole pre-roll before it can show anything.
  draftWanted = program;
  pumpDraft();
});

// The output rate, which is project state now and undoable because of it. It used to
// write the deliverable as well as the transport, and `serialiseProjectBody` carried
// neither - so the `history.commit()` at the end of this handler compared two identical
// snapshots and pushed nothing, and a rate change was the one document edit in the editor
// that could not be undone. The commit line has not moved; what changed is that there is
// now something in the snapshot for it to notice.
ui.fps?.addEventListener('change', () => {
  if (!timeline) return;
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

// Orbiting while the playhead is parked differs from scrubbing in two ways that
// matter. The first is temporal: a scrub draft deliberately zeros fade, wake and
// trails, while an orbit must keep the grade stable as the camera moves. The second
// is scheduling, and it is why this arms rather than pumps: **the render answers this
// event**. `renderProgramFrame` runs
// `advanceNavigation`, `advanceNavigation` calls `controls.update()`, and a damped
// control that moved fires `change` - so a handler that rendered here would be a
// render asking for the next render, with the damping settle running at rebuild rate
// instead of at the display's. The guard that used to stand here was `orbiting`,
// which is true for exactly the window those render-raised events arrive in.
//
// Playing has never had the problem and the reason is the shape to copy: the handler
// returns below, so `controls.update()` runs once per rendered frame from `step()`
// and the frame clock paces the damping. Parked, the animation loop is that clock.
let orbiting = false;
// Damping outlives the pointer. On release the controls still hold a residual the
// camera has not travelled through, and draining it is the loop's job - so the
// accurate seek is deferred until it has, or it would land on a pose the camera is
// still moving away from and the release would visibly jump.
let orbitSettling = false;
// What the orbit arms, and it is a flag rather than a position on purpose. Writing
// `timeline.programSec` here would be reading the transport from inside its own
// render: `programSec` is `frame / outputFps`, and both `seekNow` and `draftNow`
// assign `this.frame` only after their render loop has finished, so a `change` raised
// by `advanceNavigation` part-way through a seek reads the position the transport is
// leaving rather than the one it is travelling to. A scrub or an arrow seek started
// while a release was still settling would arm that stale position behind itself, and
// the next animation turn would pump it and pull the viewport back off the moment the
// user had just picked. Naming only *that* a redraw is wanted and letting
// `pumpParkedDraft` read the position when it pumps - outside every render - makes
// that staleness unrepresentable, rather than something each navigation entry point
// added later has to remember to cancel.
let orbitRedrawWanted = false;
// Registered through `onNav` rather than on the object, because the object does not
// outlive a change of navigation's up - see where `controls` is declared. Attached
// directly, these three would go quiet the first time somebody pressed sensor view on
// a levelled take, and quietly: orbiting would still work and only the draft frame
// would stop being asked for.
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

/**
 * Hands the camera the movement the damping still owes it, so an action that reads
 * the pose reads the one it is going to keep.
 *
 * Damping applies a fraction of the remaining delta per update, so it approaches the
 * target without ever arriving; one update with damping off applies the whole
 * remainder, which is the pose the glide was heading for anyway. Nothing is skipped
 * and nothing new is invented - the camera simply stops being between two places.
 *
 * The flags are deliberately left alone. Clearing `orbitSettling` here would drop the
 * deferred accurate seek and leave a draft standing where the true image belongs; the
 * loop's settle branch still runs on the next frame, and it now seeks to a pose that
 * has finished moving instead of one that is still travelling.
 *
 * **Nothing is asked of those flags on the way in, and that is a repair rather than a
 * tidy-up.** This opened `if (!orbiting && !orbitSettling) return`, and `orbitSettling`
 * is only ever raised by `onNav('end')` *after* that handler's own `!timeline` early
 * return - so on the recorder surface, where `timeline` is null and stays null until a
 * take is opened in the editor, the flag is never set at all. Both flags read false the
 * instant a finger lifts, so this function returned having flushed nothing, and every
 * caller was a no-op on the one surface the touchscreen runs. `sensor view` has drained
 * here since it shipped and drained nothing; pressing it during a glide was
 * indistinguishable from pressing a button that is not wired up, which is exactly the
 * report that came back from the panel.
 *
 * Measured with the editor as the control, because the two surfaces run this same code
 * and differ only in whether a `timeline` exists: same flick, same press, the camera's
 * distance from the home pose sampled at the press and 600ms later. On `/edit` the reset
 * lands at 0.00000 and holds 0.00000. On `/record` it lands 0.055 off and slides a
 * further 0.725 out over the next 600ms - the damping the press was supposed to have
 * settled, arriving afterwards and dragging the camera off the pose the operator asked
 * for. With damping off a delta of zero applies whatever movement remains, and when
 * nothing remains that is nothing, so the guard was saving a no-op at the price of the
 * surface that needed the flush most.
 */
function finishOrbitDrift() {
  const damped = controls.enableDamping;
  controls.enableDamping = false;
  // Zero rather than no argument, and the difference is not cosmetic. `update()`
  // called bare falls back to a fixed auto-rotate step, so with `spin` on this would
  // add a turn nobody asked for - and with damping off for this one call it would
  // land in full, putting the camera somewhere the manual glide was never heading.
  // A delta of zero rotates by zero, which is what "finish what is owed" means.
  controls.update(0);
  controls.enableDamping = damped;
}

/**
 * The only thing that continues a drag while the playhead is parked, called once per
 * animation frame.
 *
 * Both halves are here rather than at the gestures that want them, because both are
 * answers to "has the display had its turn yet" and that is a question only the loop
 * can answer. The armed position renders at most one frame per frame; the deferred
 * seek waits for the damping to stop arming positions, which is what tells it the
 * camera has finished arriving.
 */
function pumpParkedDraft() {
  // Dropped rather than left standing, and this is the half that has to be said. An
  // armed position is only meaningful while something will consume it, and two of the
  // three states where nothing will are visible from in here: playing and exporting.
  // Leaving it armed used to be harmless because nothing read the flag; now
  // `settled()` does, so a drag interrupted by hitting play would arm a draft nothing
  // could serve and every tool in the suite would hang on the call it synchronises
  // on. Neither state loses a picture by clearing: `play` seeks when a draft is up,
  // and an export repaints at the end.
  //
  // The third state is `drive.pin`, and it cannot be handled here for the reason that
  // makes it dangerous - it takes the animation loop away, so this function stops
  // being called at all and no condition written inside it can run. It clears the
  // same three flags itself, at the moment it detaches.
  if (!timeline || timeline.playing || exporting) {
    draftWanted = null;
    orbitRedrawWanted = false;
    orbitSettling = false;
    return;
  }
  if (draftWanted !== null) {
    pumpDraft();
    return;
  }
  // The orbit's own turn, and the position is read here rather than where it was
  // armed - see `orbitRedrawWanted` above for why that read has to happen outside a
  // render. A scrub or a seek owns `draftWanted` in the branch above, so this can
  // never paint over one that is already queued.
  if (orbitRedrawWanted && !draftBusy) {
    orbitRedrawWanted = false;
    draftBusy = true;
    timeline.redrawHere()
      .catch(showTimelineError)
      .finally(() => { draftBusy = false; });
    return;
  }
  // Nothing armed and nothing in flight, so the controls have stopped *raising events*
  // - which is not the same fact as the controls having stopped moving, and the two
  // were read as one here.
  if (orbitSettling && !draftBusy) {
    orbitSettling = false;
    // **The damping is finished before the seek, because these flags cannot see the end
    // of it.** `orbitRedrawWanted` and `orbitSettling` both come off OrbitControls'
    // `change` event, which is raised on a displacement threshold; damping is
    // asymptotic, so below that threshold the camera goes on creeping and nothing says
    // so. Every `seekNow` then runs `advanceNavigation`, which is another
    // `controls.update()`, which moves it again - so each seek renders from a slightly
    // different pose and no two pictures after a release are comparable.
    //
    // Measured on the editor with the shipped `dampingFactor` of 0.07: after
    // `settled()` returns, hand-driving `update(0)` moved the camera 8.376e-4, 7.789e-4
    // then 7.243e-4 m, a ratio of 0.92993 every step - exactly `1 - dampingFactor` -
    // and it took 356 to 496 further updates to reach a pose that renders bit-identical
    // twice. Two consecutive accurate seeks to the *same* program time came back 0.010
    // to 0.045 of 255 apart on the worst of forty tile means, with program time, frame
    // index, draft flag and the whole pre-roll plan byte-identical on both. Drain the
    // residual first and the same pair reads 0.0000 in every cycle.
    //
    // `finishOrbitDrift` is the door this file already has for it and five other
    // gestures already use, and its own comment says the loop's settle branch "now
    // seeks to a pose that has finished moving instead of one that is still
    // travelling" - which was true of every caller except this one. Safe after the
    // flags are down: `onNav('change')` returns early unless one of them is up, so the
    // movement this applies cannot re-arm the branch it is inside.
    finishOrbitDrift();
    // The redraws above are already accurate. This last seek closes the race between
    // the final redraw and the last damping step and makes release an explicit
    // accuracy boundary, the same rule the scrubber follows.
    //
    // `seekHere` and not `seek(timeline.programSec)`, because the position this wants
    // is the playhead's at the moment the queue reaches it - see the note there for
    // the seek this used to undo.
    timeline.seekHere().catch(showTimelineError);
  }
}

// ------------------------------------------------------------ look in tracks

// Look is edited here and composition is not, and the split is the same one that
// decides what a preset contains. `bloom`, `wake` and the rest have no spatial
// meaning, so they get conventional lanes with ease handles; inventing an in-world
// metaphor for a scalar would buy novelty at the cost of being able to type 0.5.
// The camera goes the other way for the same reason read backwards - see the world
// surface below.
//
// Only parameters carrying keys get a lane. Nine permanent lanes was the first
// shape of this and it spends the strip on rows that say nothing; five that are
// all animated is the same information in half the height.

/**
 * What a track kind is on the timeline, declared once instead of asked for as
 * `row.kind !== 'scalar'` at each site that needs to know.
 *
 * The camera gaining ease handles is the change that shows why the comparison was
 * the wrong shape. It appeared at five places - the curve, the handles, a key's
 * height, the lane's range and the preset row's gate - so opening the pose track
 * would have been five edits each of which had to be *found*, and a fourth kind
 * added next year would need all five found again. Reading a table means a kind is
 * asked about by existing, which is the difference between closing the class and
 * closing the instance this repo keeps having to relearn.
 *
 *   eases      whether the handles mean anything here. `step` is the one that does
 *              not: a checkbox has nothing between true and false, so there is no
 *              timing to shape and no shape to draw.
 *   laneH      the strip's height. An eased kind gets the taller one because the
 *              handles are dragged in it, so pose grew when it gained them.
 *   range      the lane's own y-axis. A scalar's is the parameter's registry range,
 *              in the units the panel types in. A pose has no such number - see
 *              `ends` for what its axis is instead.
 *   ends       where a segment's two ends sit on that axis. A scalar's are the key
 *              values. A pose's are 0 and 1, because its lane draws the fraction of
 *              *that segment* completed and nothing else: the ease curve in its own
 *              coordinates, carrying no spatial quantity anybody could misread as a
 *              camera move. Arc length was the tempting alternative and it lies -
 *              a camera pivoting in place travels nothing, so the lane would report
 *              an empty segment for a move you can plainly see.
 *   at         the value the lane's curve is drawn from, at a program time.
 *   keyValue   where a key's own diamond sits on the axis, so it lands on the drawn
 *              curve the way a scalar's does.
 *   axisIsValue whether that axis *is* the key's own value, which is what decides
 *              whether dragging a key up and down writes one. Only a scalar's is:
 *              a pose is placed in the world and a step has nothing between its two
 *              states, so for both the drag moves the key in time alone.
 *   overshoots whether a handle may be dragged outside the lane. A scalar's may: a
 *              value that swings past its key and comes back is an ordinary creative
 *              choice. A pose's may not, and the reason is the same one the retime
 *              gives rather than a preference - its axis is a *fraction of a segment*,
 *              so a handle above the box asks for a fraction past 1, which sends
 *              `hermite` off the end of the segment's own cubic. That is no longer the
 *              Catmull-Rom through the keys, and the camera would fly past the very
 *              pose it was keyed at. Overshoot has no meaning on an axis that is
 *              already normalised.
 *   moved      whether two keys differ by enough for a handle to change anything.
 *              Same arithmetic claim in all three cases - a segment whose ends are
 *              equal renders identically for every handle position, so offering one
 *              is offering a control that writes a number nothing reads.
 */
const KINDS = {
  scalar: {
    eases: true,
    laneH: 34,
    range: (spec) => ({ min: spec.min, max: spec.max }),
    ends: (keys, seg) => ({ lo: keys[seg].value, hi: keys[seg + 1].value }),
    at: (owner, t) => tracks.get(owner).valueAt(t),
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
  pose: {
    eases: true,
    laneH: 34,
    range: () => ({ min: 0, max: 1 }),
    ends: () => ({ lo: 0, hi: 1 }),
    at: (owner, t) => poseLaneFraction(keysOf(owner), t),
    // The foot of its own outgoing ramp, and the top of the incoming one for the
    // last key, so the diamonds sit *on* the curve exactly as a scalar's do. A lone
    // key has no ramp to sit on and stays mid-lane, which is where it already was.
    keyValue: (keys, i) => (keys.length < 2 ? 0.5 : (i === keys.length - 1 ? 1 : 0)),
    axisIsValue: false,
    overshoots: false,
    moved: (a, b) => poseMoved(a.value, b.value),
  },
};

/** Whether two poses differ at all - in place, in aim, or in field of view. */
const poseMoved = (a, b) => Math.abs(a.fov - b.fov) > 1e-9
  || a.position.some((v, i) => Math.abs(v - b.position[i]) > 1e-9)
  || a.quaternion.some((v, i) => Math.abs(v - b.quaternion[i]) > 1e-9);

/**
 * How far through its current segment a pose track is, eased - which is the whole
 * of what a pose lane draws.
 *
 * The branches mirror `poseAt`'s deliberately: the lane has to be a picture of the
 * thing being evaluated, and a second reading of "which segment is t in" is a second
 * thing to keep in step. What it is *not* is a picture of the path, and the sawtooth
 * it produces is the point rather than an artefact - every linear segment draws the
 * same diagonal, so the one segment somebody has eased is the one that looks
 * different. The cost worth naming: continuity across a key reads as two parallel
 * slopes at opposite edges of the lane rather than as a smooth join, because each
 * segment is drawn in its own coordinates.
 */
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

const RETIME_LANE_H = 40;
// How far a curve is sampled across a lane. The viewBox is resolution-independent,
// so this is a smoothness choice and not a pixel count.
const CURVE_SAMPLES = 120;
const SVG_NS = 'http://www.w3.org/2000/svg';

// Which key is selected, as {owner, key}. `owner` is a parameter name or the
// retime, and the pair is held rather than an index because sorting a track moves
// indices out from under a drag.
let selection = null;

const svg = (name, attrs) => {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
};

/** The value range a lane draws against. */
function laneRange(owner) {
  if (owner === 'retime') {
    const total = Math.max(1e-6, timeline ? timeline.source.duration : 1);
    return { min: 0, max: total };
  }
  const spec = params.spec(owner);
  return KINDS[spec.kind].range(spec);
}

function laneRows() {
  const rows = [];
  if (retime.keys.length > 0) {
    rows.push({ owner: 'retime', label: 'retime', kind: 'scalar', height: RETIME_LANE_H });
  }
  // Composition before look, and the camera first inside it, because that is the
  // order the split is described in everywhere else in this design.
  for (const name of ['camera', ...params.names('look')]) {
    const track = tracks.get(name);
    if (!track || track.keys.length === 0) continue;
    rows.push({ owner: name, label: name, kind: track.kind, height: KINDS[track.kind].laneH });
  }
  return rows;
}

const keysOf = (owner) => (owner === 'retime' ? retime.keys : (tracks.get(owner)?.keys ?? []));

function laneReadout(owner) {
  if (owner === 'retime') return `${retime.slopeAt(playheadSec()).toFixed(2)}×`;
  const value = params.get(owner);
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') return value >= 100 ? value.toFixed(0) : value.toFixed(2);
  return `${keysOf(owner).length} keys`;
}

/**
 * Rebuilds the lane rows. Called when the *set* of lanes or keys changes, never
 * per frame and never per pointer move - see `repositionLanes` for why that
 * distinction is worth two functions.
 *
 * It empties the two containers it owns rather than sweeping its columns for
 * children it does not recognise. The old loop spared `.ruler` and the playhead and
 * removed everything else, which silently destroyed the in/out markers on the first
 * call - during boot, before anything was on screen to notice.
 */
function rebuildLanes() {
  counters.laneRebuilds++;
  ui.railLanes.replaceChildren();
  ui.lanes.replaceChildren();
  const rows = laneRows();

  for (const row of rows) {
    const rail = document.createElement('div');
    rail.className = 'trow';
    rail.style.height = `${row.height}px`;
    const label = document.createElement('span');
    label.textContent = row.label;
    const value = document.createElement('b');
    value.dataset.readout = row.owner;
    value.textContent = laneReadout(row.owner);
    rail.append(label, value);
    ui.railLanes.appendChild(rail);

    const bed = document.createElement('div');
    bed.className = 'trow';
    bed.style.height = `${row.height}px`;
    const lane = document.createElement('div');
    lane.className = 'tlane';
    lane.dataset.owner = row.owner;
    // Held on the node so `repositionLanes` can read a lane's kind and range without
    // rebuilding the row list, which is the whole point of the cheap path.
    lane.__row = row;
    bed.appendChild(lane);
    ui.lanes.appendChild(bed);
    drawLane(lane, row);
  }

  laneStackHeight = rows.reduce((n, r) => n + r.height + 1, 0);
  applyLaneHeight();
  // The strip changed height, so the stage the renderer sizes itself to did too -
  // and so did the canvas the furniture is drawn on, which is sized to the stage.
  resize();
  placeChrome();
}

/**
 * The same lanes, moved rather than rebuilt: `left`/`top` on the nodes that already
 * exist and a fresh `points` on the curve, and nothing else.
 *
 * A drag is the reason this exists. `rebuildLanes` calls `resize()` because a lane
 * appearing changes the strip's height and therefore the stage's - and a drag runs it
 * on every pointer move, which measured **24 `renderer.setSize` calls in a ten-move
 * key drag**. Resizing the drawing buffer at pointer rate is what "editing keyframes
 * is unreliable" felt like from the outside.
 *
 * Returns false when the structure it is looking at no longer matches the tracks -
 * a key sorted past its neighbour so a handle's segment is gone, a lane whose track
 * emptied - and the caller falls back to a full rebuild. That fallback is safe
 * mid-gesture for the reason the drag was built around: the pointer is captured on
 * `ui.beds` and `laneDrag` holds key and row *objects*, so replacing the elements
 * underneath it changes nothing about where the events go.
 */
function repositionLanes() {
  for (const lane of ui.lanes.querySelectorAll('.tlane')) {
    const row = lane.__row;
    if (!row) return false;
    const keys = keysOf(row.owner);
    const nodes = lane.querySelectorAll('.tkey');
    if (nodes.length !== keys.length) return false;
    for (const node of nodes) {
      if (!keys.includes(node.__key)) return false;
      node.style.left = `${view.pct(node.__key.t)}%`;
      node.style.top = `${keyY(row, node.__key)}%`;
      // Hidden rather than removed. `repositionLanes` refuses to run when the node
      // count and the key count disagree - that identity is what lets a drag take the
      // cheap path - so culling by removal would send every zoomed drag down the
      // rebuild, which resizes the drawing buffer.
      node.hidden = !view.holds(node.__key.t);
    }
    for (const handle of lane.querySelectorAll('.thandle')) {
      // The segment is recomputed rather than trusted. `__seg` was correct when the
      // handle was drawn, and a key dragged past its neighbour re-sorts the track
      // under it - so reading the stored index would move the handle by an ordering
      // that no longer holds.
      const i = keys.indexOf(handle.__key);
      const seg = handle.__side === 'easeOut' ? i : i - 1;
      if (i < 0 || seg < 0 || seg >= keys.length - 1) return false;
      // A segment that went flat under the drag has no shape left to edit, so its
      // handle has to go rather than be moved - which is a rebuild, not a move.
      if (!segmentHasShape(keys, seg, row.kind)) return false;
      // The point count is re-read for the reason the segment is. `+pt` and `-pt`
      // rebuild, but a preset press changes a side's length without one, and a handle
      // whose index no longer exists would position itself off `undefined`.
      const points = handle.__side === 'easeOut' ? keys[seg].easeOut : keys[seg + 1].easeIn;
      if (handle.__index >= points.length) return false;
      const point = handlePoint(row, keys, seg, handle.__side, handle.__index);
      handle.__seg = seg;
      handle.style.left = `${view.pct(point.t)}%`;
      handle.style.top = `${point.y}%`;
      handle.hidden = !view.holds(point.t);
    }
    const curve = lane.querySelector('polyline');
    if (curve) curve.setAttribute('points', lanePoints(row.owner));
  }
  return true;
}

/**
 * The curve a lane draws, as a `points` attribute in the 0..1000 by 0..100
 * viewBox. One function because two callers want the same line: `drawLane` builds
 * the polyline and `repositionLanes` rewrites it during a drag, and a second copy of
 * this arithmetic would be a second thing to keep in step.
 *
 * What the curve is *of* comes off `KINDS[kind].at`, and the two answers are
 * different in kind rather than in units: a scalar lane draws the value being
 * rendered, and a pose lane draws how far through its segment the camera is. Neither
 * is a picture of a camera path, which is the property that lets the composition
 * track have a lane at all.
 *
 * **Known gap, carried deliberately.** The curve is drawn from the raw eased value
 * while the parameter itself is clamped to its range on the way in, so an
 * overshooting ease handle near a bound draws a curve leaving the lane where the
 * rendered value simply saturates. The lane is then a picture of a value the clip
 * cannot hold. The fix is to draw through `params.normalise` the way the keys
 * already are.
 */
function lanePoints(owner) {
  const { min, max } = laneRange(owner);
  const span = Math.max(1e-9, max - min);
  const at = owner === 'retime'
    ? (t) => retime.sourceSecAt(t)
    : (t) => KINDS[tracks.get(owner).kind].at(owner, t);
  const points = [];
  // Sampled across the *visible* window rather than the clip, which does two things at
  // once: nothing is drawn outside the lane, so there is no horizontal overflow to clip
  // and `.tlane svg` can stay `overflow: visible` for the vertical excursions it is
  // there for - and the same 120 samples buy proportionally more detail the further in
  // you zoom, instead of a curve that gets coarser exactly where you are looking at it.
  for (let i = 0; i <= CURVE_SAMPLES; i++) {
    const t = view.startSec + (i / CURVE_SAMPLES) * view.spanSec;
    const y = 100 - ((at(t) - min) / span) * 100;
    points.push(`${(i / CURVE_SAMPLES) * 1000},${Math.max(-20, Math.min(120, y)).toFixed(2)}`);
  }
  return points.join(' ');
}

/**
 * Whether a segment has a shape an ease handle could edit.
 *
 * It does not when its two keys hold the same value, and that is arithmetic rather
 * than a limitation to work around: the eased value is
 * `a.value + (b.value - a.value) * ease(u)`, so with `b.value === a.value` it is
 * `a.value` for every `u` and **no handle position changes anything that renders**.
 * The old code half-knew this - it guarded the y write against a division by zero
 * and left the handle on screen, so the control moved, wrote a number nothing reads,
 * and looked broken. Not drawing it is the honest answer to the same fact.
 *
 * The kind is asked for rather than assumed because the same sentence is true of a
 * pose and the arithmetic is not: a pose value is an object, so the subtraction this
 * used to do answered `NaN` for every camera segment, and `NaN > 1e-9` is false -
 * which read as "the camera never has a shape to edit" and would have been a silent
 * floor under the whole feature. `KINDS[kind].moved` carries the per-kind test.
 */
const segmentHasShape = (keys, seg, kind) => KINDS[kind].moved(keys[seg], keys[seg + 1]);

function drawLane(lane, row) {
  const keys = keysOf(row.owner);
  const x = (t) => view.pct(t);

  if (KINDS[row.kind].eases) {
    // The curve itself, because a row of diamonds says where the keys are and
    // nothing at all about the shape between them - and the shape is exactly what
    // an ease handle edits. Drawn in a 0..1000 by 0..100 viewBox stretched to the
    // lane, so it costs nothing to redraw at a different width.
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
    node.hidden = !view.holds(key.t);
    node.dataset.role = 'key';
    lane.appendChild(node);
    node.__key = key;
    node.__row = row;
  }

  if (!KINDS[row.kind].eases || !selection || keys.indexOf(selection.key) < 0) return;
  // Handles only on the selected key, and only where there is a segment for them
  // to shape. Two of them at once on every key is a lane nobody can read.
  //
  // One per *control point* rather than one per side, because a side is a list now.
  // The loop walks the list rather than drawing a fixed pair for the same reason the
  // curve evaluates a list rather than a formula: a count written down at the drawing
  // site is a second declaration of the degree, and the two would disagree the first
  // time `+pt` ran on a key this lane happened not to be showing.
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
      handle.hidden = !view.holds(point.t);
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

/** Where one of an ease handle's control points sits, in program seconds and lane percentage. */
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

/**
 * How far along the segment a control point may be dragged, as the two points either
 * side of it.
 *
 * The timing curve has to stay single-valued in time, and the sufficient condition at
 * any degree is that the control abscissae do not descend - so a point is held between
 * its neighbours, with the segment's own pinned ends standing in at the two extremes.
 * With one point a side that is exactly the `[0, 1]` clamp this replaced, which is why
 * there is one rule here rather than a rule and an exception: the cubic was never a
 * different case, it was the case where the neighbours happen to be the ends.
 *
 * **The point's own x is a third term, and leaving it out was a bug found by a drag.**
 * Descending abscissae are only *sufficient* for a fold, never necessary, so a cubic can
 * cross its own control polygon and still be perfectly single-valued - `easeOut [0.9, y]`
 * against `easeIn [0.1, y]` is exactly that, its derivative bottoming out at 0.15 and
 * never reaching zero. Those states are on disk and `elevate` carries them faithfully
 * across a `+pt`, so a strict two-term span can arrive already inverted, with `lo` above
 * `hi`; the min-then-max then collapses to `hi` and the first pointer move *teleports* a
 * handle nobody dragged that far. Including the current position makes the span
 * well-formed whatever it inherits: a drag can no longer jump, and on any polygon this
 * editor can itself produce - where the point already lies between its neighbours - the
 * third term changes nothing and this is the neighbour clamp exactly.
 */
function handleSpan(keys, seg, side, index) {
  const out = keys[seg].easeOut;
  const inn = keys[seg + 1].easeIn;
  const at = (k) => (k < 0 ? 0 : (k >= out.length + inn.length ? 1
    : (k < out.length ? out[k][0] : inn[k - out.length][0])));
  const k = side === 'easeOut' ? index : out.length + index;
  const here = at(k);
  return { lo: Math.min(at(k - 1), at(k + 1), here), hi: Math.max(at(k - 1), at(k + 1), here) };
}

/**
 * Holds a retime key inside its neighbours, in both time and value.
 *
 * The value half is what stops a reverse being authored - see
 * `retime.assertMonotonic` for why one cannot be rendered. The time half is the
 * same rule read the other way: a key dragged past its neighbour would sort into a
 * different position and pair its value with the wrong side, producing a descent
 * without any value having moved. Clamping rather than refusing, because a drag
 * that stops at the neighbour reads as the curve resisting; one that throws
 * mid-gesture reads as the editor breaking.
 */
function clampRetimeKey(keys, key) {
  const i = keys.indexOf(key);
  // The curve is anchored at the origin, so its first key holds still in time.
  // Letting it slide would leave the head of the edit to an extrapolation rule,
  // which is the thing planting the origin key exists to avoid.
  if (i === 0) key.t = 0;
  else {
    const after = i < keys.length - 1 ? keys[i + 1].t : Infinity;
    key.t = Math.max(keys[i - 1].t + KEY_GAP_SEC, Math.min(after - KEY_GAP_SEC, key.t));
  }
  const floor = i > 0 ? keys[i - 1].value : 0;
  const ceiling = i < keys.length - 1 ? keys[i + 1].value : timeline.source.duration;
  key.value = Math.max(floor, Math.min(ceiling, key.value));
}

// The least program time two retime keys may be apart. Zero would let two of them
// land on the same instant, which is a segment of no duration and a slope of
// infinity - legal arithmetic and an unreadable lane.
const KEY_GAP_SEC = 1 / 240;

/** Readouts only. Structure is `rebuildLanes`, and the two are kept apart on purpose. */
function paintLanes() {
  for (const el of ui.rail.querySelectorAll('b[data-readout]')) {
    el.textContent = laneReadout(el.dataset.readout);
  }
  for (const [name, btn] of keyButtons) paintKeyButton(name, btn);
  paintRateKey();
  paintMarkButton();
  paintEase();
}

/** A lane appeared, moved or went away. */
function lanesChanged() {
  rebuildLanes();
  paintLanes();
  // The keyframe half of the panel's collapse rule, and this is the one announcement
  // that carries it: a track appearing is not a registry write, so `params.set` never
  // hears about it. Every path that changes the set of tracks arrives here - keying
  // from a panel button, a tool writing a whole set at once, undo, and a project being
  // opened, which reaches it through `timingChanged`. A group whose only evidence is a
  // keyed parameter sitting on its default would otherwise stay shut until the next
  // time anything wrote a value.
  groupRevealChanged();
}

/**
 * A key or a handle moved and the set of them did not. The cheap half of the pair,
 * and the one a pointer drag runs - it falls back to the expensive one only when the
 * structure has actually drifted, which a drag mostly does not do.
 */
function lanesMoved() {
  counters.laneRepositions++;
  if (!repositionLanes()) {
    counters.laneFallbacks++;
    rebuildLanes();
  }
  paintLanes();
}

/**
 * The retime curve or the output rate moved, so every position on the ruler did.
 *
 * `moved` says the *set* of lanes cannot have changed - which is true of a slope
 * change, since which tracks carry keys is not something a slope can touch. It
 * matters because the structural path resizes the drawing buffer, and a speed slider
 * being dragged would do that once per pointer event.
 */
function timingChanged({ moved = false } = {}) {
  if (!timeline) return;
  // Re-clamped against the duration this may just have changed, because the window is
  // stored as *fractions* and its minimum is in *seconds*. Those disagree the moment
  // the duration moves: a window sitting at exactly `MIN_VIEW_SEC` at 0.1x is a fixed
  // fraction of a clip that a change to 4x makes forty times shorter, so the same
  // fraction is now 0.00625 program seconds - a window narrower than a single output
  // frame, which is the state `MIN_VIEW_SEC` exists to make unreachable and which
  // resolves most pointer positions on the ruler to the same frame.
  //
  // **`reclamp` rather than `set`, and the difference is a bug that lived here.** Handing
  // `set` the fractions the window already holds writes the *clamped* window back as the
  // one that was asked for, so the limit applies to its own previous output and the
  // window only ever ratchets outward: a round trip from 0.1x to 4x and back left a
  // 0.25s window at 10s, with the document returned exactly and no undo step committed.
  // `reclamp` re-derives from the request instead, so the same round trip comes back to
  // where it started. Every timing change passes through here, which is what makes undo,
  // a project load and an output-rate change get it too.
  view.reclamp();
  // The slider's coordinate, not the rate - see `rateFromSlider`. Written only when
  // the thumb is not already showing this rate, and the condition is the invariant
  // itself rather than a flag standing in for it: the rate is quantised and snapped on
  // the way through, so writing the position back unconditionally would shove the thumb
  // out from under a pointer that is mid-drag by the rounding, and inside the 1.00x
  // detent it would jump the thumb to the centre of the band from anywhere in it.
  //
  // Asking "does the thumb already mean this rate" rather than "is a gesture running"
  // is what makes it self-correcting. A gesture flag has to be cleared by something,
  // and `change` is not guaranteed to arrive - a slider nudged with the arrow keys and
  // never blurred would leave the flag set, and every later write-back from a project
  // load or an undo would be skipped by a gesture that ended long ago.
  if (rateFromSlider(ui.rate.value) !== retime.rate) {
    ui.rate.value = String(sliderFromRate(retime.rate));
  }
  ui.rateOut.textContent = `${retime.rate.toFixed(2)}×`;
  // The slider is the one-key version of the curve, so once the curve has keys it
  // has nothing left to say: it would set a slope only the extrapolated ends read.
  // Saying so is better than leaving a live control that moves nothing visible.
  ui.rate.disabled = retime.keys.length > 0;
  if (ui.fps) ui.fps.value = String(timeline.outputFps);
  buildRuler();
  paintMarks();
  // The window is fractions of a duration this may just have changed, so everything
  // positioned against it moves even though nothing in the document did. Not left to
  // the caller's seek: most of them do repaint afterwards, but "most" is how the
  // overview ends up showing the previous rate's window on the one path that does not.
  paintStripPositions();
  if (moved) lanesMoved();
  else lanesChanged();
}

// --------------------------------------------------------------- marks on the take

// The take's marks, fetched once when it opens. They belong to the take rather
// than to any project built on it, which is the whole reason they live in a
// sidecar: correcting one corrects it for every edit of that footage, and the
// gallery can draw them without loading anything that knows about edits.
let takeMarks = [];
let openTakeId = null;
let selectedMark = null; // The currently selected mark object, or null

// Where a mark is allowed to be on the ruler. A mark past the end of the edit stacks
// at the edge rather than being dropped, and the tick and the key that jumps to it
// have to agree about where the edge is - so the clamp is one expression both call
// rather than the same arithmetic written twice, which is how a press could land the
// playhead somewhere its own tick is not.
const clampToClip = (sec, total) => Math.max(0, Math.min(total, sec));

/**
 * Every mark's position on the ruler, in program seconds and in order.
 *
 * Recomputed on each press rather than cached beside the ticks: the curve moves under
 * these whenever a retime key is dragged, and a cached list is a second copy of the
 * marks that is right until the moment somebody edits the timing - which is exactly
 * the moment a jump-to-mark key gets pressed.
 */
/**
 * Whether a seek to this program second would land where it was asked to.
 *
 * `Transport.frameAt` clamps every seek into in..out, so a mark the trim excludes is a
 * destination that silently becomes the boundary instead - and the two surfaces that
 * offer marks both had to know it. The keys learned first and the ruler's ticks did
 * not, which is the instance being fixed rather than the class: one expression, called
 * by both, so the surface added next is asked by existing rather than by somebody
 * remembering this paragraph.
 *
 * The epsilons are the same slack the key stepping uses. A mark sitting exactly on a
 * boundary is reachable, because the boundary is inside the range.
 */
const reachableInClip = (programSec) => !timeline
  || (programSec >= timeline.clipInSec - 1e-6 && programSec <= timeline.clipOutSec + 1e-6);

const markSecondsInOrder = () => {
  const total = view.duration;
  return takeMarks
    .map((m) => clampToClip(retime.programSecAt(m.sourceMs / 1000), total))
    .sort((a, b) => a - b);
};

function paintMarks() {
  const host = ui.marks;
  if (!host) return;
  host.replaceChildren();
  if (!timeline) return;
  // The clip's length, not the window's: whether a mark is past the end of the edit is
  // a fact about the edit, and it must not change because somebody scrolled.
  const total = view.duration;
  for (const mark of takeMarks) {
    // Marks are stamped in source milliseconds and the ruler is program seconds,
    // so every tick goes through the curve. The two coincide only at rate 1 with
    // no keys, which is exactly the case that would let a wrong implementation
    // look right - so this is drawn through `programSecAt` even when it is the
    // identity.
    const program = retime.programSecAt(mark.sourceMs / 1000);
    // A button rather than a span, which is the whole of item three: the surface the
    // marks were pressed *for* drew them as decoration while the gallery's viewer -
    // which only reviews footage - made its own ticks pressable. The seek this needs
    // was already computed here at draw time, so the tick was one element name away
    // from being the control it looks like.
    const el = document.createElement('button');
    el.type = 'button';
    el.innerHTML = '<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><path d="M1 1l8 0 0 7-4 3-4-3z" fill="currentColor"/></svg>';
    // A mark the edit never reaches is drawn at the edge in the dim colour rather
    // than dropped. `programSecAt` returns where the curve ends for a source
    // position it never gets to, so this is the honest reading of that answer: the
    // moment is still in the footage, and a tick that silently vanished when
    // somebody shortened the clip would be worse than one that needs explaining.
    const beyond = program >= total - 1e-9 && mark.sourceMs / 1000 > retime.sourceSecAt(total) + 1e-9;
    const selected = selectedMark?.id === mark.id;
    el.className = (beyond ? 'tmk beyond' : 'tmk') + (selected ? ' sel' : '');
    const at = clampToClip(program, total);
    el.style.left = `${view.pct(at)}%`;
    el.hidden = !view.holds(at);
    el.title = `${mark.label ?? mark.id} · source ${(mark.sourceMs / 1000).toFixed(2)}s`;
    // **The clamped second, never the mark's own source second.** The two coincide
    // only at rate 1 with no keys, which is exactly the case that would let a wrong
    // implementation look right - and a tick drawn against the edge because the edit
    // never reaches it has to seek to the edge it is drawn at, or pressing it lands
    // the playhead somewhere the tick is not.
    //
    // Pointerdown handles both selection and the start of a drag. Stopping propagation
    // prevents the bed from starting a scrub.
    let dragging = false;
    let dragStartX = 0;
    el.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      // Select this mark, clear keyframe selection
      selectedMark = mark;
      if (selection) { selection = null; lanesChanged(); }
      // Add selection styling directly instead of rebuilding - paintMarks() would
      // destroy this element and break the drag.
      for (const sib of host.querySelectorAll('.tmk.sel')) sib.classList.remove('sel');
      el.classList.add('sel');
      // Prepare for potential drag
      dragging = false;
      dragStartX = e.clientX;
      el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      // Start dragging after a small threshold to distinguish from clicks
      if (!dragging && Math.abs(e.clientX - dragStartX) > 3) {
        dragging = true;
      }
      if (dragging) {
        // Update the mark position visually during drag
        const programSec = Math.max(0, Math.min(view.duration, view.timeAt(e.clientX)));
        el.style.left = `${view.pct(programSec)}%`;
      }
    });
    el.addEventListener('pointerup', (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      el.releasePointerCapture(e.pointerId);
      if (dragging) {
        // Compute new source position from drop location using view.timeAt
        const programSec = Math.max(0, Math.min(view.duration, view.timeAt(e.clientX)));
        const sourceSec = retime.sourceSecAt(programSec);
        const newSourceMs = Math.round(sourceSec * 1000);
        moveMark(mark, newSourceMs).catch(showTimelineError);
      } else {
        // Just a click - seek to the mark position. A mark outside the trim is drawn but
        // not seekable, and the refusal is now the tick simply not moving the playhead:
        // there used to be a sentence on the application bar saying which of the two it
        // was, and it went with the chip. The tick is still focusable and still keyboard
        // reachable, so this is a press that does nothing rather than a control that has
        // gone away - which is the honest shape given there is nowhere left to say why.
        if (!reachableInClip(at)) return;
        goTo(at);
      }
    });
    el.addEventListener('lostpointercapture', () => {
      // If capture is lost without pointerup, repaint to reset position
      if (dragging) paintMarks();
    });
    host.appendChild(el);
  }
  // The same marks on the overview, in whole-clip coordinates. Built here rather than
  // in `paintMinimap` because that runs on every repaint and this list only changes
  // when the marks or the timing do - rebuilding N nodes per played frame would be a
  // cost with nothing to show for it.
  if (ui.miniMarks) {
    ui.miniMarks.replaceChildren(...takeMarks.map((mark) => {
      const el = document.createElement('span');
      const program = retime.programSecAt(mark.sourceMs / 1000);
      el.style.left = `${Math.max(0, Math.min(100, (program / total) * 100))}%`;
      return el;
    }));
  }
}

async function loadMarks(id) {
  selectedMark = null;
  try {
    const res = await fetch(`/capture/${encodeURIComponent(id)}/marks`);
    takeMarks = res.ok ? (await res.json()).marks : [];
  } catch {
    takeMarks = [];
  }
  paintMarks();
  paintMarkButton();
}

/**
 * Flags the moment at the playhead. Written in source milliseconds, because a
 * mark describes the footage rather than this edit of it - it survives a retime,
 * outlives this project, and is shared by every project built on this take.
 */
async function markHere() {
  if (!openTakeId || !timeline) return;
  const sourceMs = Math.round(retime.sourceSecAt(timeline.programSec) * 1000);
  const rec = { id: `m${Date.now().toString(36)}`, sourceMs, label: `mark ${takeMarks.length + 1}`, at: Date.now() };
  const res = await fetch(`/capture/${encodeURIComponent(openTakeId)}/marks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marks: [rec] }),
  });
  takeMarks = (await res.json()).marks;
  paintMarks();
  paintMarkButton();
}

/** Deletes the given mark by writing a tombstone. */
async function deleteMark(mark) {
  if (!openTakeId || !mark) return;
  const rec = { id: mark.id, deleted: true, at: Date.now() };
  const res = await fetch(`/capture/${encodeURIComponent(openTakeId)}/marks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marks: [rec] }),
  });
  takeMarks = (await res.json()).marks;
  if (selectedMark?.id === mark.id) selectedMark = null;
  paintMarks();
  paintMarkButton();
}

/** Moves a mark to a new source position. */
async function moveMark(mark, newSourceMs) {
  if (!openTakeId || !mark) return;
  // Don't move if position hasn't changed
  if (mark.sourceMs === newSourceMs) { paintMarks(); return; }
  const rec = { ...mark, sourceMs: newSourceMs, at: Date.now() };
  const res = await fetch(`/capture/${encodeURIComponent(openTakeId)}/marks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ marks: [rec] }),
  });
  if (!res.ok) { paintMarks(); return; }
  takeMarks = (await res.json()).marks;
  // Keep the mark selected after moving
  if (selectedMark?.id === mark.id) {
    selectedMark = takeMarks.find((m) => m.id === mark.id) ?? null;
  }
  paintMarks();
  paintMarkButton();
}

// ------------------------------------------------------------- the preset library

/**
 * Where the look on screen came from, or null if nobody applied one.
 *
 * This is a copy plus a stamp rather than a reference, and the copy is what keeps
 * a project self-contained - a render worker needs the file and nothing else, and
 * re-rendering last month's project has to produce the image it produced then.
 * Resolving a preset by name at render time would give centrally-updatable
 * cohesion at the cost of both those properties, and deleting a preset would break
 * every project that named it.
 *
 * The stamp recovers most of what a reference offered, for nothing: because
 * presets are content-hashed the same way captures are, the gallery can see that
 * three clips are on one revision of a look and two are on an older one. Drift is
 * not repaired automatically - tweaking a preset means re-applying it - but it
 * stops being invisible, which is the part that bites when a set of clips is
 * supposed to belong together.
 */
let appliedPreset = null;

/**
 * A preset is look values, and that is the whole of it.
 *
 * It used to be look values *plus* a mode, carried beside the registry subset
 * because the registry excluded the mode on purpose and
 * `params.values(params.names('look'))` would neither capture nor restore it. The
 * cost of that second half was not the extra field, it was the trap under it:
 * `setMode(4)` applied a hardcoded BLACKWALL look as part of selecting the mode, so
 * a user's own preset routed through the obvious door came back with twelve of its
 * values replaced by the built-in ones, and it would appear to load while not being
 * the preset. `applyStoredPreset` avoided that by calling the half of `setMode`
 * that did not apply anything - a split that existed only to work around the weld.
 *
 * With the readings in the registry there is no second half and no weld, so no
 * door to pick between: one subset in, one subset out.
 */
function presetFromCurrentLook(names) {
  return { version: PROJECT_VERSION, values: params.values(names ?? params.names('look')) };
}

/**
 * The values a document has to name to be describing a whole look: the look tag less
 * its framing, because framing is the shot rather than the look.
 *
 * **The look tag is over-broad for this one question and correctly so.** It is the set
 * of things a project saves and the set of things step 5 can keyframe, which is why
 * `tilt`, `roll`, the clip planes and the crop box are in it - the angle a bracket ended
 * up at belongs to the take, and a crop that could not be keyframed would be a worse
 * program. But those nine are measured in the room and in metres, so a *look* that named
 * them would move your crop box when you picked it, and picking a look must not reframe
 * the shot. Every other look value is grading, and a document describing a look either
 * says what all of it is or is adjusting part of one.
 *
 * Off `PARAMS[n].group` rather than a list of the nine names here, so the line is stated
 * once, in the registry, beside the parameters it is about. Reusing the panel's grouping
 * for a question about documents is safe in exactly one direction: renaming or splitting
 * the group does not quietly change what a preset means, it makes every shipped look
 * fail `library-check`'s completeness arm at once, because they would all suddenly owe
 * nine values measured in metres. A silent drift would be the reason not to; a loud one
 * is the reason this is derived rather than restated.
 */
const completeLookNames = () => params.names('look').filter((n) => PARAMS[n].group !== 'framing');

/**
 * Whether a document says what the whole look is, rather than adjusting part of one.
 *
 * The distinction did not exist while the only thing that could write a preset wrote
 * the entire look tag, and it decides two separate things now - whether a file may
 * stamp a clip with its provenance, and whether saving one moves the stamp - so it is
 * one predicate both of them ask rather than the same `every` written twice.
 *
 * **It asks about the look and no longer about the framing**, which is what lets the
 * nine shipped documents claim provenance again. They describe grades and none of them
 * names a crop box, so under the old reading every one of them was a partial apply -
 * picking `voxel` reported "applied 35 of 77 values" and left the clip stamped with
 * whatever it had been wearing, for the sake of nine values a look has no business
 * setting. A subset of the grading is still a subset and still cannot stamp.
 */
const wholeLookTag = (values) => completeLookNames().every((n) => Object.hasOwn(values, n));

// ------------------------------------------- which look values a preset carries

/**
 * The subset picker, built once at boot and shown by both doors a look leaves by.
 *
 * `presetFromCurrentLook` has taken a subset of names since it was written and both
 * of its callers passed nothing, so every preset this program could author was the
 * whole look tag - the capability sat one layer down with no way to reach it. What
 * that cost was not expressiveness: "just my grain and bloom" had to be a hand-edited
 * file, and a hand-edited file is the one door into this program that nothing
 * upstream validates.
 *
 * **The groups come from `PANEL_GROUPS` and `PARAMS[n].group`, never from a list
 * here.** A second statement of which parameter belongs under which heading is a
 * statement that drifts, and it would drift silently, because a parameter missing
 * from this dialog is not an error anywhere - it is a value you can no longer choose
 * to leave out. Derived, a parameter added next year appears by existing, under the
 * heading the panel already gives it.
 *
 * **Built at boot rather than on the first press**, which is the same call
 * `library.js` makes for the gallery's menus and for the same reason: `editor-check`
 * enumerates what the document contains and demands a driver for every control in it,
 * so a dialog that populated itself on open would show the sweep an empty box and the
 * user fifty-odd checkboxes. A control no sweep can see is a control nothing proves.
 */
const presetPickBoxes = new Map();
const presetPickGroups = [];

/**
 * One box written, and the four that may have to move with it.
 *
 * The five reading weights tick and untick as a unit because a document naming two of
 * them is not a look at all - `refusePresetBody` refuses exactly that file, and the
 * reason is that the three left out do not arrive as anything. They stay at whatever
 * the clip was already wearing, so half a blend renders as a mixture nobody authored.
 * The rule belongs to the format; this is the control declining to assemble the file
 * the format will refuse, which is better than meeting that refusal at the end of the
 * gesture with the boxes already ticked.
 */
function presetPickSet(name, on) {
  for (const n of (PARAMS[name].reading ? READINGS : [name])) presetPickBoxes.get(n).checked = on;
}

/**
 * The group headings and the count, read back off the boxes rather than tracked
 * beside them.
 *
 * A heading is a third state and not two: ticked when the whole group is in,
 * indeterminate when part of it is, which is what makes one control both the
 * check-all and the honest readout of what the group currently holds. Recomputed from
 * the boxes after every write because the reading rule crosses two groups - unticking
 * `depth` under Reading · source takes the three under Reading · treatment with it,
 * and a heading that only heard about its own members would go on claiming they were
 * in.
 */
function presetPickSync() {
  for (const group of presetPickGroups) {
    const on = group.members.filter((n) => presetPickBoxes.get(n).checked).length;
    group.box.checked = on === group.members.length;
    group.box.indeterminate = on > 0 && on < group.members.length;
  }
  const picked = presetPickNames();
  ui.pickCount.textContent = `${picked.length} of ${presetPickBoxes.size} look values`;
  // A preset carrying nothing is refused on the way back in, so the confirm is what
  // refuses to write one: meeting that at the end of the gesture would be a dialog
  // that lets you spend a minute assembling a document it already knows it cannot use.
  ui.pickGo.disabled = picked.length === 0;
}

const presetPickNames = () => [...presetPickBoxes.keys()].filter((n) => presetPickBoxes.get(n).checked);

for (const group of PANEL_GROUPS) {
  const members = params.names('look').filter((n) => PARAMS[n].group === group.key);
  // Skipped where the panel generator refuses, and the opposite call is right for the
  // opposite reason: an empty panel group is a group key misspelled on one side, where
  // an empty group here is the Viewer heading, which holds render scale and auto-orbit
  // and both of them are `view`. View state is not in any preset, so a heading with
  // nothing under it would be the panel's shape leaking into a question about the
  // document.
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
    // Prefixed, because the panel's own control for this parameter is already `id`
    // = the parameter's name. Two nodes under one id is a document where
    // `getElementById` answers whichever came first, and `editor-check` builds the
    // set it diffs against the registry out of exactly these ids - so a bare name
    // here would let a panel that had dropped a row pass the row that exists to
    // catch it, on the strength of a checkbox in a dialog.
    input.id = `pp-${name}`;
    input.checked = true;
    row.append(input, ` ${PARAMS[name].label}`);
    groupNode.append(row);
    presetPickBoxes.set(name, input);
    input.addEventListener('change', () => { presetPickSet(name, input.checked); presetPickSync(); });
  }
  ui.pickGroups.append(groupNode);
  presetPickGroups.push({ box: all, members });
}

// Every reading needs a box, on the same reasoning as the uniform assertion beside
// `READINGS` itself: `presetPickSet` reaches for all five whenever one of them is
// ticked, so a reading the loop above did not build - one tagged something other than
// `look`, which is the only way it could be skipped - would not be a missing checkbox.
// It would be a dialog that throws on the first tick of any reading, which is a control
// that appears to work until somebody uses it.
for (const name of READINGS) {
  if (!presetPickBoxes.has(name)) {
    throw new Error(`the reading ${name} has no box in the preset subset dialog: ticking any of the five would throw`);
  }
}

// Wired once rather than per opening: cancel means the same thing every time, and a
// listener added on each open is a listener added again on the next one.
ui.pickCancel.addEventListener('click', () => ui.pickDialog.close());

/**
 * Opens the picker and answers with a name and a subset, or with null.
 *
 * **Every box starts ticked**, so the gesture somebody already knows - press save,
 * type a name, confirm - writes the whole look tag exactly as it did before, and a
 * sparse preset is something you go out of your way to author. The state is rebuilt
 * on each opening rather than remembered, because a selection carried over from the
 * last save is a document shape decided by something off screen.
 *
 * **Cancelling writes nothing**, which is the whole of what `null` means here, and
 * closing is one path rather than three: the confirm closes the dialog, so the
 * `close` event is where the promise is settled whether it arrived from the button,
 * from Escape, or from anything added later. Focus goes back to the control that
 * opened the dialog on that same path, for the reason `library.js` states beside
 * `closeMenus` - a surface dismissed while focus sat inside it leaves the caret
 * nowhere, and the fix that is a rule survives the next caller where the fix that is
 * a case does not.
 */
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
      // A document is named before it is written, and an unnamed one is neither a
      // library entry nor a filename. The refusal is the field taking the focus back
      // rather than a sentence, because there is only one field to be wrong about.
      const chosen = ui.pickName.value.trim();
      if (!chosen) { ui.pickName.focus(); return; }
      picked = { name: chosen, names: presetPickNames() };
      ui.pickDialog.close();
    };
    // Enter in the name field confirms, because it did when this was a `prompt()` and
    // a dialog that quietly stopped answering the return key would be the gesture
    // getting longer for everybody who already knew it. Guarded on the confirm being
    // live so the key cannot write a document the button is refusing to write.
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

/**
 * Everything about a preset that can be refused without writing anything.
 *
 * Split out of `applyStoredPreset` so the import path can ask the question before it
 * PUTs rather than after: a file has to be checked before it enters a library where it
 * will sit looking like a look, and it has to be *applied* only once the store has
 * answered with the revision it was given. Those were one gesture and could not be,
 * because the gesture stamped a revision the store had not issued yet.
 */
function refusePresetBody(name, body) {
  // The same refusal `restoreProject` gives, from the same helper, because a preset and
  // a project carry the same version field and a holder of either needs the same three
  // answers. Two copies of that sentence is how one of them came to be false.
  if (body?.version !== PROJECT_VERSION) {
    throw new Error(versionRefusal(`preset ${name}`, body?.version));
  }
  // **The envelope, checked with the same suspicion as what is inside it.** Every key
  // in `values` is put to the registry below, and for a while nothing looked at the
  // document's own keys at all - so `{"version": 4, "mode": 4, "values": {...}}` walked
  // straight through. `mode` is the exact field version 4 dissolved into the five
  // reading weights, it means something specific in a version 3 document, and a file
  // carrying it is a file whose author believes this build reads it. Answering that
  // file with silence is the failure the version check one line above exists to
  // prevent, arriving through the one part of the document nobody was reading.
  //
  // Named rather than counted, because the point is to tell somebody editing by hand
  // which word to delete. `Object.keys` on a parsed document reports `__proto__` as an
  // own key, so a file smuggling one is refused here as well - earlier than the values
  // walk that already refuses it, and for the more accurate reason.
  //
  // `presetFromCurrentLook` emits these two and the five shipped looks carry these two,
  // so this is the shape the program authors rather than a shape asserted about it.
  const PRESET_KEYS = ['version', 'values'];
  const stray = Object.keys(body).filter((k) => !PRESET_KEYS.includes(k));
  if (stray.length) {
    throw new Error(
      `preset ${name} carries ${stray.join(', ')}, which a version ${PROJECT_VERSION} preset has no `
      + `place for: a preset is ${PRESET_KEYS.join(' and ')} and nothing else, so a key beside them is `
      + 'either a field an older version had or a typo, and both would be read as neither',
    );
  }
  // A document with no values is not a look that happens to change nothing. `?? {}`
  // used to make it one: the apply wrote nothing, the stamp went on anyway, and what
  // came back was a clip claiming provenance from a file that had said nothing at all.
  //
  // **An empty `values` object is that same document spelled differently**, and it
  // needed saying out loud only once the reading rule below became a rule about
  // scope. While all five readings were demanded of every file, `{}` was refused for
  // naming none of them; a file whose scope is "nothing" now walks through that gate
  // truthfully, so the sentence the shape deserves has to be stated where it was
  // always meant - here, about the values.
  //
  // Three shapes and three sentences, because they are three different mistakes and
  // one sentence fitted one of them. The person reading it is editing the file by
  // hand, and telling somebody who has just deleted the last entry out of `values`
  // that their document "carries no values object" sends them looking for a key that
  // is in front of them.
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

  // The values, checked against the registry without reaching it. `params.apply` does
  // this again on the way in and has to - this is the import path's early copy, taken
  // before the PUT, so a file the registry would refuse never becomes a document.
  //
  // **Before the reading check below, deliberately.** A file gets told which of its
  // keys is wrong ahead of being told which are missing, because the wrong one is the
  // more specific answer and it is the one somebody editing a file by hand needs.
  // **A preset is look values and nothing else**, and the registry knowing a name is
  // not the same question as the name belonging in a preset. `camera` is a registry
  // parameter with a `composition` tag, and a valid pose passes `normalise` cleanly -
  // so a hand-edited file naming it used to reach `params.apply` and move the program
  // camera, changing what the next export frames. Worse, that write is in neither the
  // look values nor the camera track, so the commit that follows cannot undo it: the
  // pose is simply somewhere else now. `presetFromCurrentLook` writes the look tag and
  // only the look tag, so this is the reading side of a rule the writing side already
  // keeps, and the note in `docs/reference.md` that applying a preset never moves your
  // camera is only true with it here.
  for (const [key, value] of Object.entries(body.values)) {
    const { tag } = params.spec(key);
    if (tag !== 'look') {
      throw new Error(
        `preset ${name} names ${key}, which is a ${tag} parameter: a preset carries look values `
        + 'and nothing else, so that it can be applied to any clip without moving anything else',
      );
    }
    params.normalise(key, value);
  }

  // **And the readings are all or none**, which is the version 4 rule stated as a
  // scope rather than as a census, because the file's own keys are what it claims to
  // be about.
  //
  // The danger the rule exists for has not moved. `format.js` puts it plainly about a
  // version 3 file: every value it names is still a parameter, so the apply writes all
  // of them without complaint and only the reading is missing, leaving whatever the
  // previous document happened to select. A file naming `readRgb` and `readDepth` and
  // stopping reaches that identical state for the other three - a blend of the two it
  // set against whatever the clip was already wearing, which is a mixture nobody
  // authored and which nothing on screen says is a mixture. That file still gets the
  // sentence below.
  //
  // What changed is the file that names **none** of them, which used to be caught by
  // the same test and is a different document. It is not a look with a hole in it, it
  // is a look that is not about the reading: `applyStoredPreset` writes the keys the
  // document names and no others, so the blend on screen afterwards is the one the
  // clip already had, chosen by whoever was grading rather than left over from a file.
  // The half that made the old refusal necessary - a stamp on the clip claiming
  // provenance from a document that had not said what the look is - is closed at the
  // stamp instead, where it belongs, and a partial file cannot claim it at all.
  const missing = missingReadings(body.values);
  if (missing.length && missing.length !== READINGS.length) {
    // **Both ways out, because the file in front of this person has two.** The old
    // sentence said the look "carries all five reading weights", which stopped being
    // true the moment naming none of them became legal, and it named the one exit that
    // adds keys - so somebody who had deliberately cut the blend down to two was told
    // to put three back rather than told that taking two out is the other answer and
    // the one they probably meant. The reason for refusing the middle has not moved and
    // is still the whole of it: a document naming some of the weights leaves the rest
    // wherever the clip had them, which is a blend nobody authored.
    //
    // Off `missingReadings` for both halves rather than a second census of the same
    // thing, since two spellings of one count is how one of them comes to be wrong.
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

/**
 * Applies a saved preset, and stamps where it came from only if the document said
 * what the whole look is.
 *
 * The stamp answers one question - what look is this clip wearing - and a document
 * that set three of the fifty-four look values did not answer it. Naming it as the
 * clip's origin is the same silent lie the reading rule above exists to stop, one
 * level up: a gallery comparing revisions would show three clips agreeing on a look
 * they only agree about in the three values that file happened to carry.
 *
 * So a partial apply leaves the stamp exactly where it was, which is the same thing
 * moving a slider does, and is the honest answer for the same reason - the clip's
 * provenance is the last document that described the whole of it.
 *
 * **This returned which of the two had happened and now returns nothing**, because the two
 * surfaces that read it were both notes on the application bar's message chip and both went
 * with it. The distinction has not stopped mattering - it is the whole reason the stamp is
 * conditional - it has stopped being reported, and the caller that wants it back should read
 * `wholeLookTag` here rather than have this hand out a shape nothing consumes.
 */
function applyStoredPreset(doc) {
  refuseDuringEvaluation('a stored preset applied');
  refusePresetBody(doc.name, doc.body);
  const values = doc.body.values ?? {};
  const stamped = wholeLookTag(values);
  // The write first and the stamp after, which is an ordering rather than a style: an
  // `apply` that throws mid-document must not leave the clip claiming a provenance it
  // does not have.
  params.apply(values);
  if (stamped) appliedPreset = { name: doc.name, rev: doc.rev };
  requestRepaint();
  history.commit();
}

/**
 * The documents of one kind, or the server's reason there are none.
 *
 * This used to reach straight through `res.json()` for `[kind]`, which reads a 500 as
 * `undefined` and hands it to a `for...of` - so the refusal the server took trouble to
 * write ("the shipped preset directory ... cannot be read: ENOTDIR") arrived on screen
 * as "list is not iterable", and the one surface that does report a failed library
 * reported the wrong thing. The error carries through now, because a message that
 * names the directory is the difference between a five-second fix and a mystery.
 */
const documentsIn = async (kind) => {
  const res = await fetch(`/${kind}`);
  const body = await res.json().catch(() => null);
  if (!res.ok || !Array.isArray(body?.[kind])) {
    throw new Error(body?.error ?? `${kind} could not be listed: HTTP ${res.status}`);
  }
  return body[kind];
};

/**
 * The preset picker: a trigger that names the chosen preset and a listbox that can hold
 * what a native `<option>` cannot - a mark on the entry currently applied, and a delete on
 * the entries that have one.
 *
 * **The trigger keeps `value`, and that is deliberate rather than incidental.** A
 * `<button>` has a `value` IDL attribute, so `el.value` goes on meaning exactly what it
 * meant when this was a `<select>`: the name of the chosen preset. Every reader downstream
 * and every tool that drives this surface is unchanged, and the failure recorded in
 * `docs/instruments.md` about a control whose `value` stops meaning the quantity it is
 * named after does not arise, because the quantity did not move.
 *
 * **Only user presets get a delete.** A shipped look lives in a second directory the store
 * reads and never writes, so `DELETE` on one is refused at the server; drawing a control
 * that is always refused would be worse than drawing none. The slot is not reserved for it
 * either - unlike the panel's reset, where a row moving sideways mid-drag was the failure
 * being avoided, nothing here is dragged and a missing glyph on a shipped look reads as
 * "this one is not yours" rather than as a gap.
 *
 * The add button is on the editor's picker and not on the recorder's, because "add" is the
 * save flow under another name and the recorder has no save control to open. Pencil draws
 * it the same way - the add button is in the editor's menu and the Record surface's preset
 * row has none - so this is the design being followed rather than a corner being cut.
 */
// Built the way `resetGlyph` above builds its own, and for the same reason: a stroke of
// `currentColor` is one asset that cannot disagree with the rule that coloured it, and it
// is nodes rather than a string of markup, so nothing here is ever parsed as HTML.
// `lucide/trash-2`, which is what the design names.
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

// There was a `note` option here, a per-picker element a refusal could be written into,
// falling back to the application bar's chip when a picker had none. One picker is defined
// in this program and it never passed one, so the fallback was the only path any of it ever
// took - and with the chip gone the option is a parameter whose every value is null. It
// came out rather than being kept for a second picker somebody might add, because a
// facility with no user is a facility nothing keeps honest.
function definePicker(trigger, list, { adds = null, autoApply = false } = {}) {
  const picker = { trigger, list, adds, autoApply, docs: [], typed: '', typedAt: 0 };
  pickers.push(picker);

  trigger.addEventListener('click', () => (list.hidden ? openPicker(picker) : closePicker(picker)));
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openPicker(picker);
    }
  });
  list.addEventListener('keydown', (event) => pickerKey(picker, event));
  // On the list rather than on each option, so an option built by a later rebuild is
  // driven by existing rather than by having had a listener attached to it.
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
  // The caret has to land somewhere it can be seen. A list that shuts while holding focus
  // strands it on the body, which is the class `menu-close-strands-focus` already polices
  // on the application menus.
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
  // Type-ahead. One printable character at a time, accumulated inside a window, which is
  // what makes `bl` reach blackwall rather than landing on whatever begins with `l`.
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

/**
 * Write a name onto the trigger, which is where every reader looks for it, and repaint
 * the list so the mark moves with it. This is the *display* half and nothing else.
 *
 * It is a function of its own because "the operator picked this" and "the library was
 * rebuilt and the selection has to be put back" are two different sentences that used
 * to be one call. `refreshPresets` rebuilds after every save, import and delete and then
 * restores the visible selection - so with the apply folded into the write, a look that
 * had been applied and then tweaked by hand was fetched and re-applied by the refresh,
 * silently discarding the tweaks in the middle of the gesture that saved them. Repainting
 * a control is not choosing what it shows.
 */
function showPickerChoice(picker, name) {
  picker.trigger.value = name ?? '';
  paintPicker(picker);
}

/** The operator chose this entry: show it, and on a picker that applies, apply it. */
function choosePicker(picker, name, { close = false } = {}) {
  showPickerChoice(picker, name);
  if (close) closePicker(picker, { restoreFocus: true });
  if (picker.autoApply) {
    if (name) {
      withPresetGesture(() => whileWriting(async () => {
        try {
          const doc = await (await fetch(`/presets/${encodeURIComponent(name)}`)).json();
          // **Applying a look said so, and the sentence went with the chip it was written
          // on.** It named the revision on a complete document and the count of values
          // landed on a partial one, which is the distinction `applyStoredPreset`'s comment
          // is still about: a partial apply leaves the stamp where it was, so `appliedPreset`
          // afterwards names a document this press did not apply. Nothing on this surface
          // reports the difference any more - the values land either way, and which kind of
          // document did it is now only visible in what the panel shows.
          applyStoredPreset(doc);
        } catch (err) {
          showTimelineError(err);
        }
      }));
    } else {
      // "none" selected: reset all look parameters to their defaults, and clear the
      // stamp so autosaves stop claiming a preset and refreshPresets does not restore
      // the old name onto the picker.
      appliedPreset = null;
      params.reset(params.names('look'));
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
  // The "none" option at the top, clearing any applied preset.
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

/**
 * Delete a user preset, and put the caret somewhere afterwards.
 *
 * The rebuild is the whole difficulty: the row holding focus is the row being removed, so
 * the list that comes back has no element the browser could have kept the caret on. The
 * name of the row that will take its place is worked out *before* the refresh and looked up
 * after, which is the shape `viewer-drops-focus-on-rebuild` already polices in the gallery -
 * a rebuild that strands focus leaves a keyboard with nowhere to be.
 */
async function deletePreset(picker, name) {
  const options = pickerOptions(picker);
  const at = options.findIndex((option) => option.dataset.name === name);
  const successor = options[at + 1]?.dataset.name ?? options[at - 1]?.dataset.name ?? null;
  await withPresetGesture(() => whileWriting(async () => {
    // The content type is declared even though a delete carries no body, because every
    // route in the table that changes something requires it - the rule is about the
    // request being a deliberate one from a page that meant it, not about there being
    // JSON to read. Without it the server answers 415 and the entry stays in the list,
    // which is exactly how this arrived: section 19 deleted nothing and said so.
    const res = await fetch(`/presets/${encodeURIComponent(name)}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) throw new Error(`${res.status} ${(await res.text()).trim() || res.statusText}`);
    // The chosen name goes with the document it named. Leaving it on the trigger would
    // leave `apply` pointed at a preset the server would answer 404 for.
    if (picker.trigger.value === name) picker.trigger.value = '';
    await refreshPresets();
  })).catch(showTimelineError);
  if (picker.list.hidden) return;
  const back = successor
    ? picker.list.querySelector(`.pickeroption[data-name="${CSS.escape(successor)}"]`)
    : null;
  if (back) back.focus();
  else closePicker(picker, { restoreFocus: true });
}

definePicker(ui.preset, document.getElementById('tPresetList'), { adds: 'tPresetAdd', autoApply: true });

// A press outside any open list shuts it, which is what makes this behave like the menu it
// replaces rather than like a box that has to be dismissed by its own control.
addEventListener('pointerdown', (event) => {
  for (const picker of pickers) {
    if (!picker.list.hidden && !picker.trigger.contains(event.target) && !picker.list.contains(event.target)) {
      closePicker(picker);
    }
  }
});

async function refreshPresets() {
  const list = await documentsIn('presets');
  // Both selectors, because the preset library is one library and the recorder is
  // the surface the design wants it on most: shooting against the look you intend to
  // grade towards is the whole reason presets are a library rather than two
  // hardcoded modes. The two are never visible at once, so this is one list with two
  // views rather than two lists that could drift.
  // A shipped look is marked rather than segregated into its own group, because it is
  // the same kind of document and saving over one forks it: a separator implying two
  // libraries would be describing the storage rather than what you can do. The value
  // stays the bare name, so everything downstream is unchanged.
  for (const picker of pickers) {
    buildPicker(picker, list);
    // Only when the applied preset is still in the library. It is not, the moment one is
    // deleted - and writing a name the list no longer offers back onto the trigger would
    // leave `apply` aimed at a document the server answers 404 for, which is the state
    // the delete above is careful to leave the trigger out of.
    if (appliedPreset && list.some((doc) => doc.name === appliedPreset.name)) {
      showPickerChoice(picker, appliedPreset.name);
    } else {
      paintPicker(picker);
    }
  }
  return list;
}

/**
 * A preset as a file, both ways.
 *
 * The document *is* the file format - `{ version, values }`, the same bytes the store
 * writes - so there is nothing to convert in either direction and no second shape that
 * could drift from the first. Export is those bytes with a name on them; import is
 * `JSON.parse` and then the ordinary apply path.
 *
 * **Import goes through `params.apply` and not near a uniform**, which is the whole of
 * what makes an arriving file safe. A hand-edited or truncated preset is exactly the
 * caller `normalise` was hardened for: a scalar must be a number, a step must be a
 * boolean, and anything else throws at the key that is wrong instead of writing a
 * plausible-looking look. It also closes the prototype question by construction -
 * `specOf` asks `Object.hasOwn(PARAMS, name)`, so a file carrying `__proto__` as an own
 * enumerable property, which `JSON.parse` genuinely does produce where an assignment
 * would not, is refused as an unknown parameter rather than reaching anything.
 */
function exportPresetFile(name, body) {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(body, null, 2)}\n`], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.braindance-preset.json`;
  a.click();
  // Revoked on the next turn rather than immediately: the click is dispatched
  // synchronously but the fetch of the blob is not, and revoking in this task can
  // land first and save a zero-byte file.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

async function importPresetFile(file) {
  const text = await file.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file.name} is not JSON: ${err.message}`);
  }
  // **Checked before it is saved and applied only after**, which used to be one step
  // and could not be. The store checks the version and the name; only the registry can
  // say whether the values are values, and a file that cannot be applied has no
  // business entering a library where it will sit looking like a look until somebody
  // picks it - so the refusal still happens first, ahead of the PUT.
  //
  // What moved is the *apply*. Applying first meant stamping `sha256:imported`, a
  // revision no store ever issued, and `applyStoredPreset` commits an undo snapshot
  // and fires the auto-save on its way out - so the placeholder was written into the
  // snapshot and into the working project, and replacing `appliedPreset` afterwards
  // reached neither. Crash recovery restored the placeholder, and one edit followed by
  // an undo put it back on screen. The store's answer is the first thing that knows the
  // real revision, so nothing is stamped until it has answered.
  const name = file.name.replace(/\.braindance-preset\.json$|\.json$/i, '');
  refuseDuringEvaluation('a preset imported');
  refusePresetBody(name, body);
  const res = await fetch(`/presets/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const saved = await res.json();
  if (saved.error) throw new Error(saved.error);
  applyStoredPreset({ name: saved.name, rev: saved.rev, body });
  return saved;
}

/**
 * Offers the auto-save back, when it belongs to the take that has just opened.
 *
 * The undo stack writes the whole document to `__working__` after every change, and
 * `refreshProjects` deliberately keeps that name out of the picker - it is not a
 * document anybody chose, and listing it beside real projects offers "the thing you
 * were just doing" under a name that reads like a mistake. That reasoning is right
 * and it left the working document unreachable: opening the same take again gave a
 * fresh clip with no sign that a session's work was sitting on disk beside it.
 *
 * **A control rather than a sentence, and that is a repair.** This first offered the
 * document as text naming `?project=__working__`, which is not a path anybody can
 * follow: the editor boots on `?take=`, so replacing the query with that one leaves it
 * with no take in it and the boot path sends the browser to the gallery. An
 * instruction that reads as a recovery and is a way out of the page is worse than no
 * offer, because the work is still there and the operator now believes they tried.
 * So the offer is a button and it presses `loadProjectNamed`, which is the same door
 * the resume URL opens - the same hash refusal on the way in, and no navigation at all.
 *
 * **No extra request.** The list arrives with every document's body already on it, so
 * the stamp this needs is in hand at the moment the take opens - and a fetch here
 * would put a round trip in the path of every take opening for the sake of an offer
 * that usually has nothing to make.
 */
// The document the resume chip is currently offering, held from the moment it is
// offered because the name it came from does not stay still. Null whenever no offer
// is on screen.
let offeredWorkingBody = null;

function offerWorkingDocument(projects) {
  if (ui.resume) ui.resume.hidden = true;
  offeredWorkingBody = null;
  const working = projects?.find((doc) => doc.name === WORKING_PROJECT);
  if (!working) return;
  // **Matched on hash rather than on id.** A rename frees the old id and a later take
  // can be renamed into it (#13), so an id match is a claim about a name where a hash
  // match is a claim about footage - and offering somebody their edit back on top of
  // different footage is a wrong answer that looks exactly like a right one.
  if (!openTakeHash || working.body?.take?.hash !== openTakeHash) return;
  // And it has to differ from the clip on screen, or the offer is to restore what is
  // already there. `history.begin` has just serialised the on-screen document into
  // `baseline`, so this compares like with like rather than serialising it a second
  // time - and the two fields the auto-save adds come off first, since neither of
  // them is part of what the clip is.
  const body = { ...working.body };
  delete body.history;
  delete body.take;
  if (JSON.stringify(body) === history.baseline) return;
  // When, because "there is autosaved work" is not enough to decide with: an operator
  // who stopped an hour ago and one who lost the tab a minute ago want opposite things
  // from this button, and the stamp is the only thing that tells them apart.
  // **Held, not merely pointed at.** The next edit autosaves over `__working__`, so a
  // chip that fetched the name when pressed would restore the edit made *since* the
  // offer and report it as a recovery, with the work it was actually offering already
  // overwritten. What the operator was shown is what the button now restores.
  //
  // The store still has one slot, so a reload before the offer is taken still loses the
  // older document - that is a property of autosaving to a single name and is not what
  // this is fixing. What is fixed is a button that advertised one thing and did another.
  if (!ui.resume) return;
  offeredWorkingBody = JSON.parse(JSON.stringify(working.body));
  if (ui.resumeWhen) ui.resumeWhen.textContent = `autosaved ${new Date(working.savedAt).toLocaleString()}`;
  ui.resume.hidden = false;
}

async function refreshProjects() {
  const list = await documentsIn('projects');
  if (ui.project) {
    ui.project.replaceChildren(new Option('—', ''));
    // The auto-save is not a document anybody chose, and it is always the newest file
    // in the directory, so listing it beside real projects offers "the thing you were
    // just doing" under a name that reads like a mistake. It stays on disk and stays
    // loadable by name; it is simply not something the picker proposes.
    for (const doc of list) {
      if (doc.name === WORKING_PROJECT) continue;
      ui.project.appendChild(new Option(doc.name, doc.name));
    }
  }
  return list;
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

/**
 * Moves the picker and the record of what it is naming together.
 *
 * **Because a refusal has to be able to put the picker back, and there is nothing else
 * that knows where back is.** A `change` event arrives with `value` already moved, so the
 * previous selection is gone by the time anything can object to the new one - and
 * `activeDeliverable` cannot stand in for it, since `saveDeliverable` PUTs the document as
 * it is and stamps no name into it. Kept on the element rather than in a module binding so
 * there is one object holding both halves and no second copy to fall out of step.
 *
 * Every adoption goes through here, which is what makes the revert below mean "the one the
 * clip is actually on" rather than "the one somebody remembered to record".
 */
function showAdoptedDeliverable(name) {
  if (!ui.deliverable) return;
  ui.deliverable.value = name;
  ui.deliverable.dataset.adopted = name;
}

async function saveDeliverable(name, deliverable) {
  const res = await fetch(`/deliverables/${encodeURIComponent(name)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(deliverable),
  });
  const saved = await res.json();
  if (saved.error) throw new Error(saved.error);
  return saved;
}

// ------------------------------------------------------- dragging keys and handles

// One pointer path for keys and handles in every lane, because they differ only in
// what a drag writes. Attached to the lane column rather than per element, so a
// rebuild between two pointer events cannot leave a listener on a node that is no
// longer in the document.
let laneDrag = null;

const laneProgramAt = (clientX) => view.timeAt(clientX);

// **Known gap, carried deliberately.** An undo landing between this pointerdown
// and its pointerup rebuilds every track from the snapshot, so `laneDrag.key` is
// left pointing at an object no track holds any more: the rest of the drag writes
// into nothing and the release commits a document the drag never touched. It needs
// a keyboard undo during a pointer drag, which no gesture produces by hand. The fix
// is for the restore to cancel any drag in flight.
ui.beds.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.tkey, .thandle');
  if (!el || !timeline) return;
  e.preventDefault();
  e.stopPropagation();

  // A second press on the same key removes it - see `lastKeyClick` for why this is
  // not a `dblclick` listener. Before the capture, so a removed key never leaves a
  // drag holding it.
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

  ui.beds.setPointerCapture(e.pointerId);
  const lane = el.closest('.tlane');
  laneDrag = {
    el, row: el.__row, key: el.__key, side: el.__side, seg: el.__seg, index: el.__index,
    role: el.dataset.role, rect: lane.getBoundingClientRect(),
    // Read before anything in the drag can change it - see `view.duration`.
    duration: timeline.duration,
  };
  // Clear mark selection when selecting a keyframe
  if (selectedMark) { selectedMark = null; paintMarks(); }
  selection = { owner: el.__row.owner, key: el.__key };
  lanesChanged();
});

ui.beds.addEventListener('pointermove', (e) => {
  if (!laneDrag) return;
  const { row, key, rect } = laneDrag;
  const keys = keysOf(row.owner);
  const { min, max } = laneRange(row.owner);
  const frac = Math.min(1.15, Math.max(-0.15, (e.clientY - rect.top) / Math.max(1, rect.height)));
  const value = min + (1 - frac) * (max - min);

  if (laneDrag.role === 'key') {
    key.t = Math.max(0, laneProgramAt(e.clientX));
    if (KINDS[row.kind].axisIsValue) key.value = value;
    if (row.owner === 'retime') clampRetimeKey(keys, key);
    else {
      if (KINDS[row.kind].axisIsValue) {
        // Through the registry's own snapping without writing the parameter, so a
        // key dragged in a lane and one written from the slider hold the same
        // value. Writing it would also be wrong: the key being dragged is usually
        // not the one at the playhead, and the evaluator would put the parameter
        // back a frame later, so the panel would jump and snap back for no reason.
        key.value = params.normalise(row.owner, key.value);
      }
      // A look track may go up and down and its keys may be dragged past one
      // another, so it sorts. The retime cannot and does not - see the clamp.
      tracks.get(row.owner).keys.sort((x, y) => x.t - y.t);
    }
    // The one thing a retime key drag moves that the lanes below do not cover. A
    // mark is a source position and the curve carrying it onto the ruler is exactly
    // what this drag bends, so the ticks walk while the ruler itself stays pinned to
    // `laneDrag.duration` - see `view.duration`.
    if (row.owner === 'retime') paintMarks();
  } else {
    const a = keys[laneDrag.seg];
    const b = keys[laneDrag.seg + 1];
    const dt = Math.max(1e-9, b.t - a.t);
    // Off the kind rather than off the key values, because a pose value is an object
    // and subtracting two of them is `NaN`. A pose lane's ends are 0 and 1 - it draws
    // the fraction of the segment completed - so `h[1]` stays what it has always been:
    // a fraction of whatever the lane's own axis spans between these two keys.
    const { lo, hi } = KINDS[row.kind].ends(keys, laneDrag.seg);
    const dv = hi - lo;
    const h = (laneDrag.side === 'easeOut' ? a.easeOut : b.easeIn)[laneDrag.index];
    // x stays inside the segment because the ease is a function of time within it:
    // a handle past either end makes the timing curve fold back on itself and the
    // value would run backwards through part of the segment. With more than one point
    // a side, "either end" means the neighbouring control points rather than the
    // segment's own - see `handleSpan`, where the two readings are one rule.
    const span = handleSpan(keys, laneDrag.seg, laneDrag.side, laneDrag.index);
    h[0] = Math.min(span.hi, Math.max(span.lo, (laneProgramAt(e.clientX) - a.t) / dt));
    // `dv` is non-zero by construction - a handle only exists where
    // `segmentHasShape` said there was a shape, and a handle drag moves no key
    // value - so this is a backstop against writing NaN into the document rather
    // than the reason y appears not to move. That was the old reading of the same
    // line and it was wrong: on a flat segment y genuinely cannot do anything, and
    // the fix was to stop drawing the handle rather than to force the write.
    if (segmentHasShape(keys, laneDrag.seg, row.kind)) h[1] = (value - lo) / dv;
    // A look handle may overshoot - a value that swings past its key and comes
    // back is an ordinary creative choice. The retime's may not: y outside the unit
    // range makes the eased source time leave the segment's own bounds and run
    // downhill inside it, which is a reverse authored through the back door.
    //
    // **And a pose's may not, for a third reason that reads the same and is not.** Its
    // lane axis is already a fraction of the segment, so a handle above the box asks
    // `hermite` for a fraction past 1 and it obliges, continuing the segment's own cubic
    // past the key rather than following the spline - the camera overshoots the pose it
    // was keyed at and comes back. That contradicts the one thing easing a camera is
    // promised not to do, and the promise is in `poseAt`'s comment and in
    // `docs/reference.md` in as many words. The clamp is where the promise is kept.
    // It is off `KINDS` rather than named here because `row.owner === 'retime'` beside a
    // second hardcoded kind is the shape this whole change went to the trouble of
    // removing.
    //
    // But the overshoot is bounded, and the bound is what makes the control usable
    // rather than a nicety. `h[1]` is a fraction of the *segment's* value span, so a
    // drag across a lane that spans the whole parameter divides by whatever the two
    // keys happen to differ by - and when they differ by little, a small movement is
    // an enormous handle. Measured: a 20px drag on a segment spanning 0.6 of bloom's
    // range put y at **-5.73**, a curve leaving its lane six times over for a
    // gesture that looked like a nudge. One segment-span of overshoot each way keeps
    // "past the key and back" and drops the part nobody can aim.
    if (row.owner === 'retime' || !KINDS[row.kind].overshoots) h[1] = Math.min(1, Math.max(0, h[1]));
    else h[1] = Math.min(2, Math.max(-1, h[1]));
  }
  lanesMoved();
  requestRepaint();
});

for (const type of ['pointerup', 'pointercancel']) {
  ui.beds.addEventListener(type, () => {
    if (!laneDrag) return;
    const wasRetime = laneDrag.row.owner === 'retime';
    laneDrag = null;
    // The ruler was held still for the drag, so this is where it catches up with
    // however much longer or shorter the curve has made the program.
    if (wasRetime) timingChanged();
    else lanesChanged();
    // One drag is one interaction, which is the whole of the coalescing rule.
    history.commit();
  });
}

// ------------------------------------------------- removing keys, and shaping them

/**
 * Removes a retime key, and refuses the one removal that would leave the curve with
 * no head.
 *
 * **This closes a gap that was documented rather than fixed, and the delete gesture
 * below is what made it reachable.** The curve is anchored by a key at program 0 -
 * `clampRetimeKey` pins the first one there and the toggle plants it - because
 * without it the head of the edit falls back to the extrapolation rule at the top of
 * `sourceSecAt`. Remove the origin from a curve of two and the single remaining key
 * extrapolates backwards: at `[t=0 v=0, t=10 v=8]`, dropping the first leaves
 * `sourceSecAt(0)` answering `8 + (0 - 10) * rate`, which is a negative source time
 * at the first frame of the clip. Nothing throws and nothing looks wrong; the clip
 * simply starts somewhere nobody chose.
 *
 * So the rule is the whole class rather than the three-key case the old note named:
 * the origin cannot go while anything follows it. On its own it is free to go, which
 * is what turns the last two keys back into a plain slope.
 */
function removeRetimeKey(key) {
  const i = retime.keys.indexOf(key);
  if (i < 0) return false;
  // The refusal is the `false` and nothing else now. It carried a sentence saying the
  // origin anchors the start of the clip and to remove the ones after it first, on the
  // application bar's message chip, and that chip is gone - so a delete of the first key
  // reads to the operator as a key that will not delete, with the rule above as the only
  // record of why. The return is what every caller already branches on.
  if (i === 0 && retime.keys.length > 1) return false;
  retime.keys.splice(i, 1);
  // An origin key on its own says nothing a plain rate does not.
  if (retime.keys.length === 1 && retime.keys[0].t === 0) retime.keys.length = 0;
  return true;
}

/**
 * Removes whichever key is selected in a lane.
 *
 * There was no way to do this at all. A key could be created from the panel, dragged
 * in a lane and selected, and then only un-created by moving the playhead onto it and
 * pressing the same button that made it - so a key placed by hand at a position the
 * playhead could not be put back onto exactly was, in practice, permanent. Delete and
 * Backspace on the selection both landed on nothing, and so did a double click.
 */
function deleteSelectedKey() {
  if (!timeline || !selection) return false;
  const { owner, key } = selection;
  // A stale selection is not an error: an undo or a project load rebuilds every track
  // from a snapshot, so the object this points at can simply stop being anybody's key.
  if (!keysOf(owner).includes(key)) { selection = null; return false; }

  if (owner === 'retime') {
    if (!removeRetimeKey(key)) return false;
    selection = null;
    timingChanged();
  } else {
    tracks.get(owner).removeKey(key);
    // A track with no keys left is not a track. The parameter keeps the value it is
    // holding right now rather than snapping anywhere: `dropTrackIfEmpty` only stops
    // the evaluator writing it, so what was on screen when the last key went is what
    // stays on screen.
    dropTrackIfEmpty(owner);
    selection = null;
    lanesChanged();
  }
  requestRepaint();
  history.commit();
  return true;
}

/**
 * The shapes a handle drag is usually reaching for, as one press each.
 *
 * A key's `easeOut` is the first control point of the segment leaving it and its
 * `easeIn` is the second control point of the segment arriving - see `scalarAt`, and
 * `poseAt` for the camera, which reads the identical pair. So "ease in" is about the
 * incoming side and writes `easeIn`, "ease out" is about the outgoing side and writes
 * `easeOut`, and they are not two halves of one number.
 *
 * These are what the camera track is usually eased with, and what matters there is the
 * *track's* two outer keys: the spline holds the end pose beyond them while its tangent
 * there is half the first segment's average velocity, so an unshaped move departs and
 * arrives with a step in speed. Measured on three keys dollying 4m over 4s - 0 to
 * 0.6262 m/s in one frame at the start, 0.3125 to 0 at the end, against 0.0007 and
 * 0.0005 once eased.
 *
 * **`ends` is that edit as one press, and it exists because the two-press version was a
 * trap rather than a chore.** Shaping a move's departure and arrival means selecting the
 * first key, pressing, finding the last key, pressing again - and the obvious wrong move
 * in between, pressing on an interior key, brings the camera to a near halt as it passes
 * that key. `docs/reference.md` documented all of that and admitted "nothing on screen
 * announces it", which is a design describing a defect rather than closing one. So
 * `ends` reaches for the first key's outgoing side and the last key's incoming side
 * whichever key is selected, and leaves everything between them alone. `hold` already
 * reached past the selection through `nextIn`, so a preset whose reach is named in this
 * table rather than assumed at the call site is the shape this was already growing.
 *
 * **`glide` is the same shape one degree up, and the degree is the whole point.** A
 * cubic pinned at both ends can bring the *rate* to zero at a key but never the
 * acceleration - `smooth` steps from 0 to 3.79 in normalised units at the boundary -
 * because the second derivative there is fixed by three control points and two of them
 * are the pinned end. Two points a side makes it a quintic, and with ordinates 0,0,1,1
 * that quintic is exactly `6u^5 - 15u^4 + 10u^3`, whose first and second derivatives
 * both vanish at each end. It costs 1.875x the average rate at the midpoint against the
 * cubic's 1.724x, which is the entire price. `test/curve.test.mjs` holds it to being
 * that polynomial rather than something shaped like it, because "nearly the smoothstep"
 * is a claim no rendered frame could ever distinguish from the real one.
 *
 * `hold` is the one that reaches past the selected key, and it has to: holding a
 * value across a segment means flattening *both* of that segment's control points,
 * so it writes the next key's `easeIn` as well. It is a near-hold rather than a step
 * - the value sits under 0.01 of its span for the first half of the segment and under
 * 0.13 for seven eighths of it - because a true step is not expressible as a cubic
 * and the retime forbids the handle positions that would come closest.
 */
const EASE_PRESETS = {
  linear: { out: EASE_OUT_LINEAR, in: EASE_IN_LINEAR },
  in: { in: [[0.58, 1]] },
  out: { out: [[0.42, 0]] },
  smooth: { out: [[0.42, 0]], in: [[0.58, 1]] },
  glide: { out: [[0.2, 0], [0.4, 0]], in: [[0.6, 1], [0.8, 1]] },
  ends: { firstOut: [[0.2, 0], [0.4, 0]], lastIn: [[0.6, 1], [0.8, 1]] },
  hold: { out: [[1, 0]], nextIn: [[1, 0]] },
};

/**
 * The selected key, if it is one a preset could shape. Null covers three different
 * "no" answers on purpose - nothing selected, a selection the tracks no longer hold,
 * and a key whose neighbouring segments are all flat - because the control is
 * disabled for all three and the reason does not change what it does.
 */
function selectionEaseState() {
  if (!timeline || !selection) return null;
  const keys = keysOf(selection.owner);
  const i = keys.indexOf(selection.key);
  if (i < 0) return null;
  const row = laneRows().find((r) => r.owner === selection.owner);
  if (!row || !KINDS[row.kind].eases) return null;
  const before = i > 0 && segmentHasShape(keys, i - 1, row.kind);
  const after = i < keys.length - 1 && segmentHasShape(keys, i, row.kind);
  // The kind travels with the answer rather than being looked up again by the caller.
  // `applyEasePreset` needs it for the track-end reaches, and a second walk of
  // `laneRows` to re-find the row this one already found is the duplicate lookup that
  // drifts the first time either site learns a condition the other does not.
  return before || after ? { keys, i, kind: row.kind } : null;
}

function applyEasePreset(name) {
  const state = selectionEaseState();
  const spec = EASE_PRESETS[name];
  if (!state || !spec) return false;
  const { keys, i, kind } = state;
  if (spec.out) keys[i].easeOut = copyHandle(spec.out);
  if (spec.in) keys[i].easeIn = copyHandle(spec.in);
  if (spec.nextIn && i < keys.length - 1) keys[i + 1].easeIn = copyHandle(spec.nextIn);
  // The two reaches that are about the track rather than about the selected key. Each
  // is guarded by its own segment having a shape, for the same reason a flat segment
  // gets no handle drawn: writing a number onto a segment whose ends are equal is
  // offering a control that changes nothing, and here it would also be spending the
  // undo step that press costs on an edit with no picture behind it.
  if (spec.firstOut && segmentHasShape(keys, 0, kind)) {
    keys[0].easeOut = copyHandle(spec.firstOut);
  }
  if (spec.lastIn && segmentHasShape(keys, keys.length - 2, kind)) {
    keys[keys.length - 1].easeIn = copyHandle(spec.lastIn);
  }
  // Cannot fire on the five above - every value is inside the unit box and none of
  // them moves a key value, which is all this refuses. Called anyway because it is
  // the guard that decides what a legal retime curve is, and a sixth preset added
  // later should meet it here rather than in a render.
  if (selection.owner === 'retime') retime.assertMonotonic(retime.keys);
  lanesChanged();
  requestRepaint();
  history.commit();
  return true;
}

// The press and nothing else. It used to announce which preset had gone on which lane,
// and that announcement is what got the whole message chip removed: shaping a curve is a
// dozen presses of these buttons in a row, each one drawing an amber-bordered box at the
// top of the window to report a change already visible in the lane underneath the pointer.
for (const btn of ui.ease.querySelectorAll('button[data-ease]')) {
  btn.addEventListener('click', () => { applyEasePreset(btn.dataset.ease); });
}

/**
 * Whether the selected key's handles may grow or shrink, and by how many sides.
 *
 * The retime is excluded, and the reason is `assertMonotonic`'s rather than a
 * preference: the proof that a handle inside the unit box cannot run source time
 * backwards is a proof about a cubic, and a retime segment stops being a cubic the
 * moment a side grows. Excluding it here is what makes that assertion an assertion
 * about documents from elsewhere rather than something this editor can walk into.
 *
 * A side counts only where it has a segment to shape, so the first key offers its
 * outgoing side alone and the last its incoming - the same rule the handles are drawn
 * under, because a control that grew a list the lane would not draw is a control whose
 * effect is invisible until somebody selects a different key.
 *
 * The state is handed in rather than looked up, because `paintEase` asks this twice per
 * repaint and `selectionEaseState` walks `laneRows()` to find the kind. Four walks a
 * frame to paint two buttons is the panel cost `panel-rederives-per-write` exists about,
 * arriving through a control row instead of through the panel.
 */
function pointSides(delta, state) {
  if (!state || selection.owner === 'retime') return [];
  const { keys, i, kind } = state;
  const sides = [];
  if (i < keys.length - 1 && segmentHasShape(keys, i, kind)) sides.push('easeOut');
  if (i > 0 && segmentHasShape(keys, i - 1, kind)) sides.push('easeIn');
  // Only the sides the change is actually available on. Growth stops at the ceiling and
  // shrink at one point, and a press that could move one side but not the other moves
  // the one it can rather than refusing both - the alternative is a button that goes
  // dead because the *other* side of a key you were not thinking about is full.
  return sides.filter((side) => {
    // The selected key's own handle either way - `easeOut` shapes the segment after it
    // and `easeIn` the one before, but both lists hang off this key.
    const n = keys[i][side].length;
    return delta > 0 ? n < SEGMENT_POINT_CEILING : n > 1;
  });
}

/**
 * Adds or removes a control point on every shapeable side of the selected key.
 *
 * Growth is `elevate`, which is exact: the curve after the press is the curve before
 * it, so this hands over another handle and changes no rendered frame. That is what
 * lets it be an ordinary undoable edit rather than something that needs a warning -
 * see `elevate` in `web/curve.js`, and `test/curve.test.mjs`, which holds it to being
 * exact rather than nearly.
 *
 * Shrink drops the control point nearest the far end of the run, which is the one whose
 * removal disturbs the segment's own end least: the points closest to a key are the ones
 * holding the departure and arrival rates that the presets exist to set.
 */
function changePointCount(delta) {
  const state = selectionEaseState();
  const sides = pointSides(delta, state);
  if (sides.length === 0) return false;
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

// The count these used to report is drawn: one handle per control point appears in or
// leaves the lane on the press, and `paintEase` disables whichever button has hit the
// ceiling or the floor, so the sentence was saying what two visible controls already said.
for (const [button, delta] of [[ui.addPoint, 1], [ui.dropPoint, -1]]) {
  button.addEventListener('click', () => { changePointCount(delta); });
}

// Only meaningful while a key is selected, so the row goes quiet rather than staying
// live and writing into nothing. The two halves have different conditions on purpose:
// anything selected can be deleted, and only a key with a shapeable neighbour can be
// eased - a lone key, or one between two flat segments, has nothing for a curve to say.
function paintEase() {
  const selected = Boolean(selection && keysOf(selection.owner).includes(selection.key));
  // Once per paint, and read four times below. This runs on every repaint.
  const easeState = selectionEaseState();
  const shapeable = Boolean(easeState);
  ui.ease.classList.toggle('off', !selected);
  for (const btn of ui.ease.querySelectorAll('button[data-ease]')) btn.disabled = !shapeable;
  ui.deleteKey.disabled = !selected;
  // The point controls have a condition of their own and it is narrower than
  // `shapeable` in two directions at once: the retime is refused whatever is selected,
  // and a key already at the ceiling or already down to a single point offers nothing
  // in that direction. Asking `pointSides` rather than restating either rule, because a
  // button whose enabled state is computed from a second reading of the condition it
  // fires under is the pair that drifts - and the drift shows up as a live control that
  // does nothing, which is the exact defect this whole row is being extended to close.
  ui.addPoint.disabled = pointSides(1, easeState).length === 0;
  ui.dropPoint.disabled = pointSides(-1, easeState).length === 0;
  // A third condition, and deliberately not `selected`: walking to the next key is
  // meaningful the moment the track has one to walk to, and it is how you *reach* a key
  // in order to select it. Tying it to a selection would make the control that finds a
  // key require a key to have been found.
  ui.prevKey.disabled = neighbourKeyTime(-1) === null;
  ui.nextKey.disabled = neighbourKeyTime(1) === null;
}

/**
 * The nearest key strictly before or after the playhead on the selected parameter's
 * track, or null when there is none that way.
 *
 * Strictly, and by more than the key tolerance: a key the playhead is already sitting on
 * is not somewhere to go, and `keyAt` uses the same tolerance to decide the playhead is
 * *at* a key, so anything closer than that would be a press that appears to do nothing.
 * The owner is the selection's when there is one and the retime otherwise, because the
 * retime curve is the one track that exists without anything in the panel being chosen.
 */
function neighbourKeyTime(direction) {
  if (!timeline) return null;
  // The fallback is the whole of what makes these buttons a way to *reach* a key. With
  // `null` here they were dead until a key had already been selected, which is a control
  // for finding something that first has to be found - and it left the retime keys of an
  // opened project unreachable by anything but a click in the lane, on the one track that
  // is always there whether or not the panel has a parameter chosen.
  const owner = selection?.owner ?? 'retime';
  const now = playheadSec();
  const tol = keyTolerance();
  const times = keysOf(owner)
    .map((k) => k.t)
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
 * The double click that removes a key, tracked by hand in `pointerdown` rather than
 * taken from a `dblclick` listener.
 *
 * A `dblclick` listener does not work here and the reason is worth writing down,
 * because it looks like it should. The first click selects the key, selecting changes
 * which ease handles exist, and that rebuilds the lane - so the second click lands on
 * a *different element* than the first, and the browser dispatches `dblclick` at
 * their nearest common ancestor, which is the lane. `e.target.closest('.tkey')` was
 * therefore null on every double click. Measured: the listener fired and never once
 * saw a key.
 *
 * The key *object* survives the rebuild, so it is what the pair is matched on.
 */
let lastKeyClick = { key: null, at: 0 };
const DOUBLE_CLICK_MS = 400;

// --------------------------------------------------- the keyframe controls

// The buttons themselves are built with the panel rows they sit in - see
// `makeKeyButton` up beside the generator - because a row and its keyframe control
// are one thing to lay out, and building them in two passes is what made the second
// pass lift a checkbox out of its own label to fit one in. What is left here is the
// half that needs the tracks: what state each button is drawn in.
function paintKeyButton(name, btn) {
  const track = tracks.get(name);
  const state = !track || track.keys.length === 0
    ? 'none'
    : (track.keyAt(playheadSec(), keyTolerance()) ? 'here' : 'some');
  btn.dataset.kf = state;
}

// The retime's own key control, beside the speed slider rather than in a lane,
// because the lane only exists once there is a curve to draw in it.
ui.rateKey?.addEventListener('click', () => {
  if (!timeline) return;
  const t = playheadSec();
  const tol = keyTolerance();
  const existing = retime.keys.find((k) => Math.abs(k.t - t) <= tol);
  // Through the same door the lane's delete uses, so the rule protecting the origin
  // is stated once. It used to be a note here saying the rule ought to exist.
  //
  // The condition is `existing` alone now, where it was `existing && length > 1`.
  // Keying at program 0 on an empty curve plants exactly one key, and that guard then
  // refused to take it back off - a toggle that could be switched on and not off, at
  // the one position it is easiest to reach by accident.
  if (existing) {
    if (!removeRetimeKey(existing)) return;
  } else {
    // The source time the curve already maps to, so planting a key never moves the
    // image. The origin comes with the first one, which is what keeps the curve
    // anchored at the head of the edit rather than at an extrapolation.
    if (retime.keys.length === 0 && t > 0) {
      retime.keys.push({
        t: 0, value: retime.sourceSecAt(0),
        easeOut: copyHandle(EASE_OUT_LINEAR), easeIn: copyHandle(EASE_IN_LINEAR),
      });
    }
    retime.keys.push({
      t, value: retime.sourceSecAt(t),
      easeOut: copyHandle(EASE_OUT_LINEAR), easeIn: copyHandle(EASE_IN_LINEAR),
    });
    retime.keys.sort((x, y) => x.t - y.t);
  }
  timingChanged();
  requestRepaint();
  history.commit();
});

function paintRateKey() {
  if (!ui.rateKey) return;
  const t = playheadSec();
  const tol = keyTolerance();
  ui.rateKey.dataset.kf = retime.keys.length === 0
    ? 'none'
    : (retime.keys.some((k) => Math.abs(k.t - t) <= tol) ? 'here' : 'some');
}

/** Updates the mark button icon: filled when playhead is on a mark, stroked otherwise. */
function paintMarkButton() {
  if (!ui.mark) return;
  const t = playheadSec();
  const tol = keyTolerance();
  // Marks are stored in source milliseconds. Convert each to program time and compare.
  const onMark = takeMarks.some((m) => {
    const program = retime.programSecAt(m.sourceMs / 1000);
    return Math.abs(program - t) <= tol;
  });
  // Toggle between stroked (default) and filled (on mark) by updating the SVG path.
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

// --------------------------------------------- composition in the world

// A camera move is the one thing you cannot judge from a graph. Editing
// `position.x` as a curve while the actual question is where it flies through the
// room is the classic mistake, so the path draws in the view and in a top-down
// orthographic, and its keys are nodes you drag in space.
//
// **None of it is drawn into the rendered frame, and that is load-bearing rather
// than tidy.** The first version of this scissored a top-down into a corner of the
// same canvas, and it broke the step 4 check that ties a program position to the
// bytes of one capture frame: one arm renders through the transport and the other
// pushes a frame's depth straight into the texture, so the arm that painted
// carried furniture the arm that did not could never have. That is the general
// case rather than an accident of one check - `renderProgramFrame` is what an
// export hashes and what every equality in this repo compares, and chrome is not
// the frame. So the furniture lives on a 2D canvas of its own, over the stage,
// and the rendered image underneath is exactly what it was.
//
// The plan view then costs no readback either. The current depth frame is already
// on the CPU - `bindDepth` copies it into the DataTexture's own array - so the
// top-down projects that directly, subsampled, using the same intrinsics the
// shader unprojects with. A scatter is also the honest thing for a plan view to
// be: it answers where the subject is standing, and a wake or a bloom is not a
// place.

const chromeCanvas = document.createElement('canvas');
chromeCanvas.id = 'chrome';
chromeCanvas.hidden = true;
document.body.appendChild(chromeCanvas);
const chromeCtx = chromeCanvas.getContext('2d');

// Reused across the plan's inner loop, which runs on the main thread on every paint.
const planVec = new THREE.Vector3();

// Whether the furniture is on screen at all. Off in the live viewer, because there
// is no clip there to compose.
let chromeOn = false;
let topViewVisible = true;
let statsVisible = false;
/**
 * How long the GPU actually spent on the last frames, in milliseconds.
 *
 * **The stats overlay's `fps` is the sensor's delivery rate and has never been a
 * rendering number.** It is counted in `handleFrame` off arrivals from the socket, so
 * it measures USB and the grabber - `docs/performance.md` records it moving 12.82 to
 * 30.00 on hub topology alone, with nothing about the look changing. Anybody reading it
 * while dragging a slider is watching their USB tree, and people have: the reports that
 * the effects make performance "fluctuate wildly" are in large part this number being
 * read as though it said something about the render path. It stays, because a lagging
 * colour rate is still the one thing that explains a stale-looking image, and it is now
 * labelled `in` against this one's `gpu`.
 *
 * **A GPU timer query and not a wall clock around the draw call**, which is the whole
 * reason this is worth having rather than being a second wrong instrument. WebGL
 * submits asynchronously, so `performance.now()` either side of `composer.render`
 * measures the time spent *queueing* the frame and nothing else - measured on this
 * build, that queue is 0.005ms against 0.310ms of GPU work, so a wall clock here would
 * report a sixtieth of the cost and would not move when an effect was switched on. The
 * only other honest option is a `readPixels` barrier, and that is a full pipeline stall
 * that would make the readout change what it measures.
 *
 * **Only while the overlay is open**, which keeps it out of every path that is not
 * being watched. A proof tool never opens the stats panel, so the render seam those
 * tools compare is byte for byte the one they compare today, and an export pays
 * nothing. `EXT_disjoint_timer_query_webgl2` is absent on some drivers and the readout
 * says so rather than showing a zero that reads as "free".
 *
 * Results arrive some frames after the frame they describe, so a query is polled until
 * it is ready rather than waited on. Disjoint results are thrown away whole: the
 * extension raises that flag when the GPU was descheduled mid-query, which is the same
 * "read a health number and discard the run" rule `docs/measurement.md` states, in the
 * one place the hardware reports it directly.
 */
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
    // Drained here rather than only from the chrome paint, which is where this used to
    // sit and was wrong: the two are not on the same clock. `drawChrome` runs when the
    // furniture is repainted and the render seam runs when a frame is drawn, so a
    // surface drawing frames without repainting its overlay filled the two slots below
    // and then stopped issuing queries entirely - measured at 4 samples over a hundred
    // frames, with the readout frozen on the median of the first two. Polling on the
    // path that creates the queries means the reader cannot fall behind the writer.
    this.poll(gl);
    // Two queries in flight is plenty to cover the latency without letting a stalled
    // reader grow an unbounded pool, and only one TIME_ELAPSED query may be open at a
    // time - so a second begin before its end is a bug rather than a queue.
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
        // A short window, because the number is here to answer "is what I just
        // switched on expensive" while somebody is still holding the slider.
        if (this.samples.length > 30) this.samples.shift();
      }
      gl.deleteQuery(query);
      this.inFlight.splice(i, 1);
    }
  },

  /**
   * The median rather than the mean, for the reason every other number in this repo is
   * a median: one descheduled frame is worth more than the other twenty-nine put
   * together to a mean, and this is read while the machine is doing something else.
   */
  median() {
    if (this.samples.length === 0) return null;
    const sorted = [...this.samples].sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  },
};

// The crop box and its handles, and with them the faint pass that shows what the box
// is cutting.
//
// **A plain module flag rather than a `tag: 'view'` registry parameter**, which is the
// one thing about it worth arguing. `spin` and `renderScale` are view parameters and
// would have given this a generated row and the control sweep for free - but a generated
// step row commits history on its `change`, so undo would start flipping furniture on and
// off. Ctrl+Z means "put my edit back"; a second meaning for it is worse than a rule this
// file states once. `topViewVisible` and `statsVisible` beside it are module flags for
// the same reason.
let showCropBox = false;
// Whether anything has rendered since the furniture was last drawn, so a paint
// that produced no image does not redraw a path over a frame that never changed.
let chromeStale = false;

// How faintly a cut point draws while the box is on screen, and the one function
// allowed to write the uniform.
//
// **Derived on every call rather than assigned at the toggle**, because the two things
// it reads change independently and from a long way apart: the button, an export, a
// program-out boot. Assigning it at the button would mean every one of those places had
// to remember to clear it, and the day one forgot is the day scaffolding renders into
// somebody's deliverable. Read `chromeOn` and the flag together and the export path
// clears it by clearing the chrome it already clears.
//
// Not "ghost": `readGhost` is a look treatment and the fade half of the geometry is the
// ghost cloud, so the word is twice taken already.
const CROP_FAINT = 0.14;
function syncCropOutside() {
  uniforms.cropOutside.value = chromeOn && showCropBox ? CROP_FAINT : 0;
}

// The drawing side's own scratch. `plan-geometry.js` keeps a second one for the
// projection it took with it, which is two vectors rather than one shared object for the
// reason that module states: a `Vector3` exported for both to write into is state
// crossing a boundary, and there is no state in either - each is fully written before it
// is read on every call.
const scratchVec = new THREE.Vector3();

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

/** The sampled camera path, in world space. Empty below two keys - a point is not a path. */
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

/**
 * The program camera's frustum as world-space segments. Read off the camera the
 * registry posed rather than off the track, so what is drawn is what would be
 * rendered - including a clip with no keys at all, whose pose is a single value.
 */
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

// One bead every fourth sample rather than all 120 of them. The count is a legibility
// choice and not a resolution: 120 dots on a short on-screen path close back up into
// the line they exist to break, and every fourth is still exactly proportional to the
// speed because the samples it thins were evenly spaced in time to begin with.
const BEAD_EVERY = 4;

/**
 * The camera's timing, drawn on its own path.
 *
 * `pathPoints` already samples `poseAt` at equal intervals of program time, so the
 * gaps between consecutive samples *are* how fast the camera is going - and
 * `strokePolyline` throws exactly that away by joining them into one continuous line.
 * Drawing the samples puts it back: beads bunch where the camera is slow and spread
 * where it is fast, so an ease is visible as spacing without anything being measured
 * or labelled. Nothing is sampled here that was not already computed.
 *
 * This is the half of the ease that lives in the world, and it is deliberately not a
 * second place to edit one. The timing law is shaped in the lane, where a cubic is a
 * picture of itself and carries no spatial quantity to misread; what that law *did* is
 * judged out here, which is where this design has always said a camera move gets
 * judged. Neither surface can answer the other's question, which is why there are two.
 */
/**
 * Which of the path's samples get a bead, in world space.
 *
 * Separate from the drawing because it is the half that carries the claim, and a proof
 * tool cannot ask a canvas what it drew. `editor.pathBeads` hands this straight out, so
 * the check reads the same function the overlay does rather than a second opinion about
 * it - which is what stops the tool agreeing with a build that draws something else.
 *
 * The thinning is by index into a series that is already uniform in program time, so
 * what comes back is still uniform in time. Resampling it evenly along the path would
 * be the plausible wrong version and is the mutation this is controlled by: beads at
 * equal *distances* are a picture of the route, which the line already gives, and say
 * nothing at all about when the camera is anywhere.
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
    // Behind the eye, so it has no place on screen at all - the same answer
    // `drawNodes` gives, and for the same reason.
    if (!p) continue;
    chromeCtx.beginPath();
    chromeCtx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
    chromeCtx.fill();
  }
}

/** The point cloud from above, straight off the depth texture's own array. */
function drawPlanCloud(rect) {
  const depth = depthCurr.image.data;
  const fx = uniforms.focal.value.x;
  const fy = uniforms.focal.value.y;
  const cx = uniforms.center.value.x;
  const cy = uniforms.center.value.y;
  const s = planScale(rect);
  chromeCtx.fillStyle = 'rgba(232, 236, 241, 0.55)';
  for (let row = 0; row < DEPTH_H; row += PLAN_STRIDE) {
    for (let col = 0; col < DEPTH_W; col += PLAN_STRIDE) {
      const mm = depth[row * DEPTH_W + col];
      if (mm === 0) continue;
      const z = mm * 0.001;
      // libfreenect2's pinhole model, the same one the vertex shader unprojects
      // with, and reading the same two uniforms so there is one set of intrinsics
      // rather than two that can drift. The negation on x is the mirror correction the
      // shader's `unproject` carries the reasoning for: the sensor's frames arrive
      // horizontally flipped, and a plan drawn without it would put the room's left on
      // the plan's right while the cloud beside it disagreed.
      const wx = (-(col + 0.5 - cx) / fx) * z;
      const wy = -((row + 0.5 - cy) / fy) * z;
      // All four lateral faces, applied here for the same reason `near`/`far` are: a
      // plan that drew points the renderer discards would be a second view disagreeing
      // with the first, and the crop is exactly the setting somebody is looking at
      // this plan to judge.
      //
      // **This used to test x alone, on the grounds that a top-down has no y.** That
      // was true of a plan drawn about the sensor's own axes, where sensor y ran
      // straight up the axis the top-down projects away and a point cropped by
      // `bottom`/`top` could only ever have landed on a pixel this view does not have.
      // Levelling ends that: the rotation below mixes y into the plan's own x and z, so
      // a point the renderer has thrown away now lands somewhere inside the footprint
      // and sits there looking like geometry. The exclusion was load-bearing on an
      // assumption this change removes, which is why it goes rather than being
      // extended - it is the same six faces the vertex shader tests, and no fewer.
      //
      // Before the levelling and not after, which is the same ordering the vertex
      // shader has and has to be: the box is a place in the room in sensor metres, so
      // testing it against a rotated position would move all six faces every time the
      // room was levelled underneath them.
      //
      // Through `croppedOut` rather than spelled out here, which is also what carries
      // the `crop` switch into this view: a plan still culling by the faces while the
      // picture had released them would be the disagreement this test exists to stop,
      // arriving from the other direction.
      if (croppedOut(wx, wy, z)) continue;
      // A top-down of a canted room drawn about the sensor's axes is a slanted section
      // labelled TOP-DOWN, and that is what this drew before levelling existed: the
      // second visible symptom of the same bug, and the reason this loop needs the
      // full unprojection where it used to need one coordinate. The vertical drops out
      // *after* the rotation rather than before it, or the plan is still the sensor's.
      planVec.set(wx, wy, -z).applyQuaternion(worldTilt);
      const px = rect.x + rect.w / 2 + (planVec.x - TOP_CENTRE.x) * s;
      const py = rect.y + rect.h / 2 + (planVec.z - TOP_CENTRE.z) * s;
      if (px < rect.x || px > rect.x + rect.w || py < rect.y || py > rect.y + rect.h) continue;
      chromeCtx.fillRect(px, py, 1, 1);
    }
  }
}

// ------------------------------------------------------------- the crop box

// Six numbers describe a box and nothing on screen was ever that box. You found out
// where a face had landed by what disappeared, which makes framing a subject a
// guess-and-check loop against a boundary that is invisible by construction - the
// points that would have shown you where it is are exactly the ones it removed.
//
// So the box is drawn, and its faces are dragged. Both happen on the chrome canvas
// rather than as an object in the scene, and that is the same argument the top-down
// makes one screen up: furniture that lives in the scene has to be remembered out of
// every path that produces a picture somebody keeps, and this one would go through the
// bloom and the grade on its way there. On its own canvas it cannot reach an exported
// pixel at all, so there is no flag to forget.
//
// What that costs is depth: a projected wireframe draws over the cloud rather than
// being occluded by it. The faint pass is what gives it back, and gives back more than
// a depth test would - where the box's plane cuts through the subject, the boundary
// between full points and dim ones *is* the intersection, drawn by the cloud itself at
// the resolution the cloud has.

// Indexed `axis * 2 + side`, side 0 being the low face. The order is the order the
// panel lists them in, and the depth pair carries `flip` because a room's z runs
// backwards from a sensor's depth: `near` at 0.5m is the plane at z = -0.5.
const CROP_FACES = [
  { param: 'left', axis: 0, side: 0, flip: false },
  { param: 'right', axis: 0, side: 1, flip: false },
  { param: 'bottom', axis: 1, side: 0, flip: false },
  { param: 'top', axis: 1, side: 1, flip: false },
  { param: 'far', axis: 2, side: 0, flip: true },
  { param: 'near', axis: 2, side: 1, flip: true },
];

// A corner is three bits, one per axis, set when that axis is at its high bound. An
// edge varies along one axis and fixes the other two, which is also what names the two
// faces it belongs to - so the twelve edges and their face pairs are derived from that
// definition rather than typed out, and a typo in a hand-written table cannot put an
// edge between two faces that do not meet.
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

// Reused across the drawing and the hit test, which both run on every paint. One name
// per role rather than two shared ones: the previous shape had `cropSegment` and its
// caller writing the same vector, which is a bug that only shows up as a face drawn in
// the wrong place once somebody reorders two lines.
const cropCorners = Array.from({ length: 8 }, () => new THREE.Vector3());
const cropSegA = new THREE.Vector3();
const cropSegB = new THREE.Vector3();
const cropCentre = new THREE.Vector3();
const cropNormal = new THREE.Vector3();
const cropProbe = new THREE.Vector3();
const cropEye = new THREE.Vector3();

// The face being dragged, or null. Declared up here beside the geometry rather than
// with the pointer handlers below, because the drawing reads it to mark which handle is
// held and a `let` read before its declaration is evaluated throws.
let cropDrag = null;

/** The box's low and high bounds per axis, in sensor metres. */
function cropBoxBounds() {
  return {
    lo: [uniforms.cropL.value, uniforms.cropB.value, -uniforms.farClip.value],
    hi: [uniforms.cropR.value, uniforms.cropT.value, -uniforms.nearClip.value],
  };
}

/**
 * The eight corners of the box, in the room's frame.
 *
 * **The rotation is the whole of this function and the reason it exists.** The crop is
 * tested on the undisplaced sensor-space position, before the model matrix, while the
 * cloud it is cutting carries `worldTilt` - so the box a levelled room actually has is
 * the sensor's axis-aligned box turned by that quaternion, and a drawing that skipped
 * the turn would be a box in one frame over points in another. The top-down's old crop
 * rectangle did exactly that, and on a canted take it sat visibly beside the cloud it
 * was describing.
 */
function cropBoxCorners() {
  const { lo, hi } = cropBoxBounds();
  for (let i = 0; i < 8; i++) {
    cropCorners[i].set(
      (i & 1) ? hi[0] : lo[0],
      (i & 2) ? hi[1] : lo[1],
      (i & 4) ? hi[2] : lo[2],
    ).applyQuaternion(worldTilt);
  }
  return cropCorners;
}

/** A face's outward normal in the room's frame, written into `out`. */
function cropFaceNormal(face, out) {
  return out
    .set(face.axis === 0 ? 1 : 0, face.axis === 1 ? 1 : 0, face.axis === 2 ? 1 : 0)
    .multiplyScalar(face.side === 1 ? 1 : -1)
    .applyQuaternion(worldTilt);
}

/**
 * How a room-space point lands in the view being drawn, in stage pixels.
 *
 * One signature for both views, because everything below - the edges, the handles, the
 * leverage test and the drag itself - is the same geometry seen through a different
 * projection, and writing it twice is how the two would come to disagree about which
 * face you grabbed.
 */
function cropProjector(plan, rect) {
  if (plan) return (p) => planPoint(rect, p.x, p.z);
  const stage = { x: 0, y: 0, ...stageSize() };
  return (p) => projectThrough(p.toArray(), viewCamera, stage);
}

/**
 * A segment of the box, clipped so it can be drawn at all.
 *
 * `projectThrough` answers per point and answers `null` behind the camera, which is
 * right for a node and wrong for an edge: an edge with one end behind the eye is not
 * absent, it is shortened, and dropping it makes the box lose whole sides whenever you
 * orbit inside it. So the perspective case clips against the near plane in view space
 * first and projects what survives. The plan has no eye to be behind and needs none.
 */
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

/**
 * The middle of a projected face.
 *
 * The area centroid where there is an area, and **the mean of the points where there is
 * not, which is the case that matters rather than a guard.** Seen from directly above,
 * the four upright faces of a box are lines: the top-down collapses exactly the axis
 * they have no extent along, so their projected quads have zero area and an area
 * centroid divides by it. Those four are `left`, `right`, `near` and `far` - which is to
 * say every face the plan exists to let you drag. Returning null there gave the top-down
 * no handles at all.
 */
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

// Below this a face is too edge-on to drag: one metre of movement would travel fewer
// than this many pixels, so the pointer has nothing to resolve the distance against and
// a drag would jump by metres per pixel. Stated in pixels per metre because that is the
// quantity the drag divides by, and it is the same test that decides whether a handle is
// offered at all - a handle you can see but cannot usefully move is worse than none.
//
// Six, which is a seventh of the top-down's own resolution. The inset shows seven metres
// across a hundred and eighteen pixels, so its faces sit at about 17 px/m and everything
// it can draw at all clears this comfortably - a threshold set near that number would
// mean resizing the inset by a few pixels silently took its handles away. What it does
// still refuse is the genuinely degenerate case: a face pointing straight at the eye
// projects its own movement onto nothing, which is why the far plane offers no handle
// head-on and why the top-down offers none for `bottom` and `top`. That last one is the
// old "a plan has no y" rule arriving as a consequence rather than as a special case,
// and it stays right on a levelled take, where the rotation gives the vertical faces
// some plan leverage back and the rule hands them a handle without being told to.
const CROP_LEVERAGE_MIN = 6;
const CROP_GRAB_PX = 11;

/**
 * Where each face's handle sits and how far a metre of it travels on screen.
 *
 * The handle is the centroid of the face **as the frame actually shows it** rather than
 * the centre of the face itself, and that is not a refinement. A face sitting at its
 * `CROP_LIMIT` default is seven metres out: its true centre is off the stage or behind
 * the eye, so a handle drawn there is a handle nobody can reach on the one face most
 * likely to need pulling in. Clipped first, the handle walks along the face and stays
 * on the part of it you can see.
 */
function cropHandles(plan, rect) {
  // Nothing to grab while nothing is drawn, and this is the function that says so
  // rather than each of its three callers. The drawing, the hit test and the handle
  // list a check reads are then one answer: a build that offered a handle over an
  // invisible box would be offering a press with nothing on screen to explain it.
  if (!showCropBox) return [];
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
      // Against the near plane in view space, then projected. The order matters: a quad
      // straddling the eye has no projection to clip.
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

    // How far one metre along the face's own normal moves that point, as a screen
    // vector. It is the drag's scale and its direction at once, and its length is the
    // leverage test - so the answer to "can this be dragged" and the answer to "by how
    // much" are the same measurement rather than two that could disagree.
    const normal = cropFaceNormal(face, cropNormal);
    // Probed at the face's own middle where that lands in the picture, and at whichever
    // of its corners does when it does not. A face reaching past the eye has a middle
    // with no projection - the near plane at five centimetres is one on any normal orbit
    // - and skipping it there would take the handle off a face that is perfectly visible
    // and perfectly draggable along the part of it you can see.
    let centre = cropFaceCentre(f, corners, cropCentre);
    let a = project(centre);
    if (!a) {
      for (const i of CROP_FACE_CORNERS[f]) {
        a = project(corners[i]);
        if (a) { centre = cropCentre.copy(corners[i]); break; }
      }
    }
    if (!a) continue;
    // A quarter of a metre rather than a whole one, so the probe stays in front of the
    // camera on a face already close to it, and scaled back up afterwards. A perspective
    // projection is not linear, but over a quarter metre against a box metres across the
    // difference is far below the pixel this is measured in.
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

/**
 * The box, its faces shaded by which way they face, and its handles.
 *
 * The back edges are drawn thinner and dimmer because a wireframe box with every edge
 * equal is a Necker cube: it reads inside-out as readily as the right way round, and a
 * box you cannot tell the orientation of is worse than useless when the whole job is
 * judging where its faces sit relative to a subject. An edge is at the back when both
 * faces meeting along it are, which is exact for a box because a box is convex.
 */
function drawCropBox(plan, rect) {
  const corners = cropBoxCorners();
  const project = cropProjector(plan, rect);
  const cutting = uniforms.cropOn.value === 1;

  // Front-facing is decided from the eye in the picture and from straight above in the
  // plan, which is what makes the plan's answer "the floor and ceiling faces are the
  // back ones" rather than an accident of where the camera happens to be.
  if (plan) cropEye.set(0, 1000, 0);
  else viewCamera.getWorldPosition(cropEye);
  const frontFacing = CROP_FACES.map((face, f) => {
    const centre = cropFaceCentre(f, corners, cropCentre);
    const normal = cropFaceNormal(face, cropNormal);
    return normal.dot(cropProbe.copy(cropEye).sub(centre)) > 0;
  });

  chromeCtx.save();
  // Amber, the colour the top-down's rectangle already used for this - and dashed while
  // the crop is released, so the one state where the box is a drawing of something not
  // happening says so without a second control to read.
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

  // **On the recorder the box is a preview and has to say so.** `near`/`far` there are
  // viewer uniforms and reach nothing the grabber is writing - that is the whole of the
  // `nearClip` versus `--min-depth` distinction, and `#recRange` carries the warning
  // under the sliders for exactly this reason. A confident box drawn over a live sensor
  // reads as "this is the frame I am shooting", which is the one misreading that costs
  // footage, so the words come with the drawing rather than being left to a note in a
  // panel that may be scrolled away or hidden.
  // Top left rather than along the bottom, where the recorder already prints its
  // keyboard hints and the two overprinted each other into an unreadable smear.
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
  // Onto the letterboxed stage rather than the window's corner, so the path, the
  // nodes and the frustum land on the pixels they annotate.
  chromeCanvas.style.left = `${stageBox.left}px`;
  chromeCanvas.style.top = `${stageBox.top}px`;
  chromeCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  chromeCtx.clearRect(0, 0, w, h);

  const stage = { x: 0, y: 0, w, h };
  const path = pathPoints();

  // ── over the picture: the path, its nodes and the shot the program camera has.
  // Editor only - the recorder has no clip to compose and no path to show.
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
    // After the beads, so a key's own node reads over the timing rather than under it.
    drawNodes((p) => projectThrough(p, viewCamera, stage));
  }

  // ── the top-down. A camera move is the one thing you cannot judge from inside
  // the camera, so this is where the path is actually edited.
  const rect = insetRect();

  // The box over the picture, and **outside the `EDITING` branch above deliberately**:
  // the path and its nodes belong to a clip and the recorder has none, but framing a
  // shot is exactly what the recorder is for and the box is the same box there. Drawn
  // before the inset so the top-down lands on top of it rather than under it.
  if (showCropBox) drawCropBox(false, rect);

  if (topViewVisible) {
  chromeCtx.save();
  chromeCtx.beginPath();
  chromeCtx.rect(rect.x, rect.y, rect.w, rect.h);
  chromeCtx.fillStyle = 'rgba(13, 16, 20, 0.92)';
  chromeCtx.fill();
  chromeCtx.clip();

  // Range rings a metre apart, so the plan reads as distances rather than as a
  // picture that happens to be small.
  chromeCtx.strokeStyle = 'rgba(255, 255, 255, 0.09)';
  chromeCtx.lineWidth = 1;
  const origin = planPoint(rect, 0, 0);
  for (let m = 1; m <= 6; m++) {
    chromeCtx.beginPath();
    chromeCtx.arc(origin.x, origin.y, m * planScale(rect), Math.PI, 2 * Math.PI);
    chromeCtx.stroke();
  }

  drawPlanCloud(rect);

  // The crop box from above, the same eight corners the picture draws.
  //
  // **This used to be a rectangle of its own and decide for itself whether to appear**,
  // drawn when `cropL`/`cropR` had moved off the reach. Both halves of that were wrong
  // in the same way: it was a second rule about when the box is visible, which an
  // explicit toggle would immediately disagree with, and it was a second piece of
  // geometry, built straight from the uniforms without the levelling rotation the cloud
  // beside it was carrying - so on a canted take the plan drew a box in the sensor's
  // axes over a cloud in the room's.
  if (showCropBox) drawCropBox(true, rect);

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

  // The sensor itself, because every distance in this view is measured from it.
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

  // ── stats overlay, below the top-down view or in its place when hidden.
  if (statsVisible) {
    const statsY = topViewVisible ? rect.y + rect.h + INSET.margin : rect.y;
    // Fourteen rows at `lineH` from a first baseline 12px down, so the last one sits at
    // 166 - and this is 178 rather than that, which is a line of margin rather than a
    // fit. The two are worth separating: the box grew a line when the gpu row arrived
    // beside `fps in` and another when the viewport rate joined them, and at 167 the
    // fourteenth row cleared its own bottom edge by a single pixel. A box that exactly
    // fits its rows is one row away from drawing over itself, and the row after that is
    // added by somebody who is not looking at this constant.
    //
    // Counted off a rendered frame rather than off this list, because the list is what
    // goes stale: the comment this replaced said eleven rows and the panel had thirteen.
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

    // Performance, and **three rates that are three different quantities** - which is
    // why all three are here rather than one standing in for the others. `fps in` is the
    // sensor's delivery rate off the socket and says nothing about the look; `gpu` is
    // what one frame costs the GPU; `viewport` is how often this page actually redraws,
    // which is neither of those and is the one that moves when a look gets expensive
    // enough to miss the display's refresh. Reading any of them as another is the
    // misreading these rows exist to end - see the note on `gpuTimer` for the pair, and
    // `viewportFps` for the third.
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('PERF', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    chromeCtx.fillText(`${fps.toFixed(1)} fps in`, col2, y); y += lineH;
    gpuTimer.poll(renderer.getContext());
    const gpuMs = gpuTimer.median();
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('gpu', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    // Three states rather than two, because a zero here would read as "free" in both
    // of the cases that are not a measurement: a driver with no timer extension, and
    // a panel that has been open for less time than the queries take to come back.
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
      const footageFps = timeline.source.count / timeline.source.duration;
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
    // The deliverable's size rather than the project's shape, because this row is headed
    // "output" and the output is a count of pixels. The shape is on screen already - it is
    // the letterbox around this readout.
    chromeCtx.fillText(`${activeDeliverable?.outputSize ?? '—'}`, col2, y); y += lineH;
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('buffer', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    chromeCtx.fillText(`${Math.round(uniforms.bufferHeight.value)}p`, col2, y); y += lineH;

    // Geometry
    const drawCount = geometry.drawRange.count;
    const shedding = drawCount > POINTS;
    chromeCtx.fillStyle = '#6d7683';
    chromeCtx.fillText('points', col1, y);
    chromeCtx.fillStyle = '#e8ecf1';
    chromeCtx.fillText(`${(drawCount / 1000).toFixed(0)}k${shedding ? ' +shed' : ''}`, col2, y); y += lineH;

    // Post effects
    const posts = [afterimage.enabled && 'trail', bloom.enabled && 'bloom', grade.enabled && 'grade'].filter(Boolean);
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

  // ── recording indicator: a red outline around the viewport while recording.
  if (recordState.recording) {
    const inset = 2;
    chromeCtx.strokeStyle = 'rgba(220, 38, 38, 0.9)';
    chromeCtx.lineWidth = 4;
    chromeCtx.strokeRect(inset, inset, w - inset * 2, h - inset * 2);
  }
}

function placeChrome() {
  chromeCanvas.hidden = !chromeOn;
  // Here because this is the line every path that takes the furniture off already runs -
  // the export around its render, the program-out source at boot, a resize. The faint
  // pass is furniture, so it leaves when the rest of it does without any of those places
  // having to know it exists.
  syncCropOutside();
  if (!chromeOn) return;
  chromeStale = true;
  drawChrome();
}
addEventListener('resize', placeChrome);

// ------------------------------------------------ dragging a node in space

// Hit-testing by projecting each node to the screen rather than by raycasting.
// The same code then serves both views - the plan is a second projection of the
// same four points - and a raycaster would need a camera the plan view does not
// have, since it is drawn on a 2D canvas rather than by the renderer.
const NODE_GRAB_PX = 9;

/** Where a node lands, in stage pixels, in whichever view is asked for. */
function nodeScreenPoint(position, plan) {
  if (plan) {
    const rect = insetRect();
    return planPoint(rect, position[0], position[2]);
  }
  return projectThrough(position, viewCamera, { x: 0, y: 0, ...stageSize() });
}

/** Which view a pointer is in. The plan wins where they overlap - it is on top. */
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

// Captured on the window rather than on the canvas, and this is the one part of
// the gesture that is not obvious. OrbitControls listens on the canvas too, and
// two listeners on the same element fire in registration order whatever their
// capture flag says - so a canvas-level listener could not stop the controls from
// also seeing the press, and the node would move while the view orbited under it.
// Catching the event a level up is what makes `stopPropagation` mean anything.
addEventListener('pointerdown', (e) => {
  if (!chromeOn || e.target !== renderer.domElement) return;
  // Before the hit test rather than after it, because the hit carries a depth read
  // through the camera and the drag then unprojects every pointer move through the
  // same one. A camera still draining its release would be a different camera by the
  // second move, so the plane the pointer is being read against would slide out from
  // under the gesture and the node would land somewhere nobody pointed at. This is
  // the third member of the class `finishOrbitDrift` exists for - reading the pose,
  // fixing the pose, and now projecting through it.
  finishOrbitDrift();
  const view = viewUnder(e.clientX, e.clientY);
  if (!view) return;
  const hit = nodeUnder(view);
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
  // The plan view moves a node across the floor and leaves its height alone,
  // because a top-down drag says nothing about height and inventing one from it
  // would silently drop the camera every time a path was tidied up. The 3D view
  // moves it in the plane it is already in, facing the viewer, which is the only
  // unambiguous reading one pointer has there.
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

// ------------------------------------------------ dragging a face of the crop box

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

// The same gesture as the node drag above and for the same reasons: window-level
// capture because OrbitControls listens on the canvas and registration order beats the
// capture flag, and `finishOrbitDrift` before the hit test because a camera still
// draining its release would be a different camera by the second move.
//
// Registered after the node handler so a camera node wins where the two overlap, and
// `nodeDrag` is checked rather than relied on: the node handler calls `stopPropagation`,
// which stops other elements and not other listeners on this one.
addEventListener('pointerdown', (e) => {
  if (!showCropBox || !chromeOn || nodeDrag) return;
  if (e.target !== renderer.domElement || e.button !== 0) return;
  finishOrbitDrift();
  const view = viewUnder(e.clientX, e.clientY);
  if (!view) return;
  const hit = cropHandleUnder(view);
  if (!hit) return;
  e.preventDefault();
  e.stopPropagation();
  renderer.domElement.setPointerCapture(e.pointerId);
  controls.enabled = false;
  // **The projection is read once and held for the gesture**, which is the same rule the
  // node drag's captured depth follows. Recomputing the leverage on every move would
  // change the metres-per-pixel underneath a hand that had not changed what it was
  // doing, so a steady drag would accelerate as the face turned away from the eye.
  //
  // The value is held too, and the move sets `from + delta` rather than accumulating.
  // An accumulating drag walks: `params.set` snaps to the slider's step, so each move
  // would compound the rounding of the one before it and the face would end up somewhere
  // the pointer never asked for.
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
  // How far the pointer travelled along the face's own normal, in metres. `(sx, sy)` is
  // where one metre of the face lands on screen, so the pointer's component along it
  // divided by its squared length is the distance in the face's units - which is also
  // why a face too edge-on to have a usable `(sx, sy)` was never offered a handle.
  const { sx, sy } = cropDrag;
  const metres = ((x - cropDrag.x) * sx + (y - cropDrag.y) * sy) / (sx * sx + sy * sy);
  const face = CROP_FACES[cropDrag.face];
  // Outward is +axis for the high face of a pair and -axis for the low one, and the
  // depth pair's parameter is the negation of its room coordinate - `near` at 0.5 is the
  // plane at z = -0.5. Two sign flips, each derived from the table rather than written
  // out per face, so the six faces cannot disagree about which way is out.
  const coord = face.side === 1 ? metres : -metres;
  params.set(cropDrag.param, cropDrag.from + (face.flip ? -coord : coord));
  chromeStale = true;
  // Never a render from here. `renderProgramFrame` advances navigation, so a handler
  // that rendered would be asking for the next render itself and the drag would run at
  // a fraction of the frame rate it was driving.
  requestRepaint();
});

for (const type of ['pointerup', 'pointercancel']) {
  renderer.domElement.addEventListener(type, () => {
    if (!cropDrag) return;
    cropDrag = null;
    controls.enabled = viewCamera === freeCamera;
    // One snapshot for the gesture, the way the sliders coalesce a drag onto `change`.
    // Nothing is pushed if the face came back to where it started.
    history.commit();
    chromeStale = true;
    requestRepaint();
  });
}

// Camera keyframe handler used by both panel and timeline controls
function keyCameraHere() {
  if (!timeline) return;
  const track = trackFor('camera');
  // The pose you are looking from, which is what makes orbiting to a shot and
  // keying it one gesture. The free camera is navigation everywhere else in this
  // design; here it is the viewfinder, and the copy is one-way.
  //
  // And the gesture is why the drift has to be finished first. A hand that orbits to
  // a shot and reaches straight for this button arrives inside the release's damping
  // window, where the camera is still travelling - so the key would record a pose the
  // viewport then glides away from, and the shot that was keyed is not the shot that
  // was framed. The window is about a third of a second, which is well inside the
  // reach of the very gesture the comment above describes.
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
  const track = tracks.get('camera');
  const key = track?.keyAt(playheadSec(), keyTolerance());
  if (!key) return;
  track.removeKey(key);
  dropTrackIfEmpty('camera');
  lanesChanged();
  requestRepaint();
  history.commit();
});

// ---------------------------------------------------- the sensor's own view

// How far down the optical axis the orbit target lands. The camera goes to the
// sensor's own position, so this only decides what orbiting away from there pivots
// around; it is the depth of a person standing in a room rather than a measurement.
const SENSOR_VIEW_DISTANCE = 2.2;

/**
 * Puts the free camera where the Kinect is, looking the way the Kinect looks.
 *
 * The sensor sits at the origin of this frame facing down -Z - that is exactly what
 * `unproject` builds - so the pose is not a guess. The angles come from the same
 * `focal` uniform the unprojection reads, which is the take's own hello on the editor
 * and the attached sensor's on the recorder, so this is right for whatever camera
 * actually shot the frame rather than for the one that shot ours.
 *
 * **This is navigation and it leaves no trace.** No keyframe, no undo entry, nothing
 * in the project - the design's rule for orbiting, and this is orbiting to a
 * particular place. `camView` is the neighbouring button and the opposite thing: it
 * looks *through* the program camera, whose pose is document state.
 *
 * The one thing it cannot reproduce is the principal point. A real Kinect's optical
 * axis is off centre - (257.78, 206.78) against a centred (256, 212) on this rig -
 * and a symmetric `PerspectiveCamera` has nowhere to put that. `setViewOffset` does,
 * but it would persist through every subsequent orbit to correct a **0.82 degree**
 * vertical asymmetry, which is a mode where a button was asked for. So the frustum is
 * symmetric and the residual is named here rather than approximated quietly.
 */
function sensorView() {
  const fx = uniforms.focal.value.x;
  const fy = uniforms.focal.value.y;
  // Half-angles as tangents, which is the form the containment test needs anyway.
  const tanH = (DEPTH_W / 2) / fx;
  const tanV = (DEPTH_H / 2) / fy;
  // Fit rather than fill. three's `fov` is the vertical angle and the horizontal one
  // follows from the aspect, so matching vertical on a stage narrower than the sensor
  // would crop the sides off the very thing the button exists to show. Whichever axis
  // binds is the one matched, and the sensor's frame is always contained.
  // Before anything is assigned, for the same reason the camera key does it and one
  // gesture earlier: a pose set underneath a release that is still draining slides
  // back out, because the damping owes the camera movement it will deliver on the
  // next frames whatever was written in between. Drained first, this button's answer
  // is the one that stays.
  finishOrbitDrift();
  const aspect = freeCamera.aspect;
  const binding = aspect >= tanH / tanV ? 'vertical' : 'horizontal';
  const fovV = binding === 'vertical' ? 2 * Math.atan(tanV) : 2 * Math.atan(tanH / aspect);
  freeCamera.fov = THREE.MathUtils.radToDeg(fovV);
  freeCamera.position.set(0, 0, 0);
  freeCamera.updateProjectionMatrix();
  // Through the registry rather than onto `controls` directly, so the checkbox stops
  // saying the view is spinning while it is not. A pose set underneath a running
  // auto-orbit slides straight back out and reads as a button that did nothing.
  params.set('spin', false);
  // Posed in the sensor's frame rather than in the levelled one, because the button
  // means exactly what the sensor shot and a levelled version of that is a different
  // picture. The cloud has been turned by `worldTilt`, so the optical axis and the
  // sensor's own up have been turned with it; a camera left upright would show the
  // sensor's rectangle rotated inside a frustum fitted to a rectangle that was not
  // rotated, and the corners would fall outside the one fit this button exists to
  // demonstrate. The fit itself is untouched by any of this - at zero cant the two
  // lines below are the constants they replaced, which is why the intrinsics arms of
  // `sensor-view-check` read bit-identically either side of levelling existing.
  //
  // Navigation's pole goes with it, and it comes straight back the moment either
  // levelling slider moves. Writing the up without the rebuild `setNavigationUp`
  // performs is the half-application described where `controls` is declared.
  setNavigationUp(new THREE.Vector3(0, 1, 0).applyQuaternion(worldTilt));
  controls.target.set(0, 0, -SENSOR_VIEW_DISTANCE).applyQuaternion(worldTilt);
  controls.update();
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

/**
 * Writes both world-rotation controls as one interaction.
 *
 * The pair is written through `writeFromControl` rather than straight into the
 * registry, and that matters when either angle is keyed: a direct registry write would
 * be overwritten on the next evaluated frame while the button and its sliders briefly
 * claimed it had succeeded. The two angles go in one commit for the same reason they
 * are one gesture - an undo after `reset rotation` puts the room back where it was,
 * rather than handing back one axis and leaving the other at neutral.
 */
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

// Four planes back to their defaults, which are their bounds. Cropping is easy to do
// by accident and hard to undo by hand once all four have moved - and a box closed
// past its own subject looks exactly like a take that failed to load, so getting back
// to "no crop" has to be one press rather than four remembered numbers. `near`/`far`
// deliberately stay where they are: they are a depth range somebody usually chose on
// purpose, and this button is about the four that were opened together.
// `crop` is in the list because it is the switch over exactly the four faces this
// button reverts. Left out, "revert all to default" could hand back four faces at their
// bounds with the box still released - a document carrying a non-default value, keyed
// and exported and drawn dashed, after a press whose label says everything is back.
ui.cropReset.addEventListener('click', () => {
  params.reset(['left', 'right', 'bottom', 'top', 'crop']);
  requestRepaint();
  history.commit();
});

// Put the box back around the footage, on demand.
//
// **A second button rather than a change to the one above, and the two are not
// alternatives.** "Revert all to default" means fully open, and it is the way back from
// a box shut past its own subject - the difference between a reversible experiment and
// a take that looks like it failed to load. A fit culls the outer half percent of the
// cloud by design, so folding it into that button would take the escape hatch away and
// leave nothing that means "show me everything".
//
// Committed like a drag on a face, because that is what it is: the same four values
// through the same write path, landing on the undo stack where the fit at open
// deliberately does not.
if (ui.cropFit) {
  ui.cropFit.addEventListener('click', async () => {
    // **There is a take open on every path that builds this button, except one.**
    // `openTake` throws above the line that assigns `openTakeId` - a capture whose format
    // this build does not read, and a hello whose focal lengths or principal point are
    // unusable, are both refused before it - and the page stays up afterwards on
    // `showTimelineError`, panel and all, because footage that will not open is exactly
    // when somebody needs to see why. So this is the state where the editor is on screen
    // with nothing to measure, and the button has to decline rather than fetch an extent
    // for `undefined`. Named because the gate this feature's first draft carried looked
    // like a guard and was a branch nothing could take.
    if (!openTakeId) return;
    ui.cropFit.disabled = true;
    try {
      const fitted = await fitCropToTake(openTakeId, params.get('near'), params.get('far'));
      // Nothing inside the near/far range to measure, so nothing moves. This said so on
      // the message chip, and with that gone the press is indistinguishable from a fit
      // that landed exactly where the box already was - which it is, in the sense that
      // matters: the four faces are untouched either way.
      if (!fitted) return;
      requestRepaint();
      history.commit();
    } catch (err) {
      showTimelineError(err);
    } finally {
      ui.cropFit.disabled = false;
    }
  });
}

// Show the box, its handles, and what it is cutting.
//
// **Three effects and one control, because a third switch would buy one state that is a
// lie.** Splitting the faint pass out would allow "box drawn, nothing dimmed, crop on",
// which is a wireframe around content that is not there - the box says a boundary is
// here and the picture shows nothing crossing it. Coupled, every reachable state is
// truthful, and the useful one is the default: while you can see the box you can see
// what it removes, which is the only way to drag a face onto something deliberately
// rather than by watching it disappear.
//
// `aria-pressed` rather than `aria-checked`: this is a toggle button, where `#menuTopView`
// beside it is a menu item with a checked state.
ui.cropBox.addEventListener('click', () => {
  showCropBox = !showCropBox;
  ui.cropBox.setAttribute('aria-pressed', String(showCropBox));
  // Both, and they are not the same repaint. `syncCropOutside` changes a uniform, so the
  // cloud has to be rendered again; the box itself lives on the chrome canvas, which is
  // redrawn from `chromeStale` and would otherwise keep the last frame's furniture until
  // something else happened to move.
  syncCropOutside();
  chromeStale = true;
  drawChrome();
  requestRepaint();
});
ui.cropBox.setAttribute('aria-pressed', 'false');

// ------------------------------------------------------------- the export controls

/**
 * Mirrored from `VALID_NAME` in `server/export.js`, **which is the canonical copy** -
 * that one is enforced, this one is only what the field says before you press render.
 *
 * It stays a whitelist rather than a list of separators to reject, because it is the
 * one thing between a name somebody typed and a path assembled out of it. The static
 * handler's `isInside(EXPORTS_DIR, ...)` is the backstop, not the rule.
 */
const EXPORT_NAME_OK = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * One path to a saved copy, and a sentence where a second one would go.
 * `showSaveFilePicker` is what writes the file where you point it. A hidden
 * `<a download>` would put it in the browser's downloads folder instead, which is a
 * different feature wearing the same button - so a browser without the API is told
 * so rather than quietly handed the other thing.
 */
const CAN_SAVE_AS = typeof globalThis.showSaveFilePicker === 'function';

/** What the render will be called. The field, or the take's id when it is empty. */
function exportBaseName() {
  const typed = ui.exportName.value.trim();
  return typed || (timeline ? timeline.source.id : 'export');
}

function paintExportName() {
  const typed = ui.exportName.value.trim();
  const ok = typed === '' || EXPORT_NAME_OK.test(typed);
  ui.exportNameChip.classList.toggle('bad', !ok);
  ui.exportGo.disabled = exporting || !ok;
  return ok;
}

/**
 * The typed name, into the document that is supposed to remember it.
 *
 * **Without this the field was read and never written, so the deliverable it belongs to
 * always saved an empty one.** `applyDeliverable` copies `deliverable.name` into this box
 * on adoption and `ensureActiveDeliverable` seeds it empty, and that was the whole of the
 * wiring - nothing carried the other direction, so typing a name and pressing `new` stored
 * `""`, and reopening that deliverable put the box back to the take's id. The comment on
 * `applyDeliverable` says this field is "what stops two of them writing over each other's
 * file", and until this listener existed it stopped nothing: every deliverable of one take
 * proposed the same filename, which is the exact defect that comment describes fixing.
 *
 * Written on every keystroke rather than on blur or on save, because a deliverable is not
 * undoable state - there is no stack to flood - and because the two places that persist one
 * (`new`, and the autosave behind the picker) both read `activeDeliverable` directly. A
 * write at save time would be a second place that knows this field exists.
 *
 * An invalid name is written too, and that is deliberate: the box shows what was typed, so
 * the document should hold what the box shows. `paintExportName` disables the export button
 * for one, and `applyDeliverable` calls it after adopting, so a stored bad name arrives
 * refused rather than silently renamed.
 *
 * **Stored exactly as typed, including the spaces, because the line above is a promise.**
 * It was stored trimmed, which made that promise false in the one case anybody would
 * notice: type `" foo "`, save the deliverable, reopen it, and the box comes back holding
 * something different from what it held when you saved - a document quietly editing the
 * operator's text. Trimming belongs where the name becomes a filename, and `exportBaseName`
 * already does it there, so nothing downstream needed the trim to be here.
 */
function takeExportName() {
  ensureActiveDeliverable();
  activeDeliverable.name = ui.exportName.value;
  paintDeliverable();
}

ui.exportName.addEventListener('input', () => {
  takeExportName();
  paintExportName();
});

// The last render, and where to read it back from. `output` is an absolute path on
// the server and the page cannot fetch it; `href` is the same file under the prefix
// the static handler serves.
let lastExport = null;

// **When a copy can be handed over, stated once.** The button's disabled state and the
// Output > Export command both need this answer, and for a while they each carried their
// own version of it: the command tested `lastExport && CAN_SAVE_AS`, which is this rule
// minus the directory clause below, so after a PNG sequence it synthesised a click on a
// button `paintExportSave` had already disabled - and a disabled button dispatches
// nothing, so the menu entry that produces the deliverable silently did nothing at all.
// One predicate, read by both, is what makes the two answers the same answer.
const canSaveExportCopy = () => Boolean(lastExport) && CAN_SAVE_AS && lastExport.frameExt == null;

function paintExportSave() {
  // **A sequence is a directory, and this button hands over one file.** `done.href` for
  // the image-sequence codec names the directory the numbered frames were written into,
  // not a file, so the fetch behind this button would ask the static handler for a
  // directory and be answered with a 404 - a save that fails at the end, after the
  // picker has already asked the operator where to put it. `frameExt` is the server's
  // own answer to "is this artifact a directory", carried on `done` for exactly this,
  // so the refusal is read off the export rather than inferred from the file name.
  //
  // Refused rather than quietly saving the first frame, and refused here rather than
  // inside the click, because a button that opens a picker and then fails is worse than
  // one that says beforehand why it cannot: the frames are already on the server, and
  // saying where they are is more use than a sheet that leads nowhere.
  const sequence = lastExport?.frameExt != null;
  ui.exportSave.disabled = !canSaveExportCopy();
  ui.exportSave.title = !CAN_SAVE_AS
    ? 'This browser has no file picker - the render is in the exports directory on the server'
    : sequence
      ? `${lastExport.file} is a directory of ${lastExport.frameExt} frames - it is in the exports directory on the server`
      : (lastExport ? `Save a copy of ${lastExport.file}` : 'Render something first');
}

// The export control: one size, a name and one button. What is exported is the clip,
// at the output rate the timeline is already set to, through the program camera -
// which frames and which codec remain the job queue's questions rather than this
// one's.
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
// A driver that synthesises a click on another control inherits that control's disabled
// state and its continued existence, and neither of those is anything the caller can see
// going wrong - which is exactly how the menu command above lost its effect.
async function saveExportCopy() {
  if (!lastExport) return;
  try {
    // **The picker opens before anything is awaited, and that ordering is the whole
    // of whether this works.** `showSaveFilePicker` needs transient user activation,
    // and awaiting a fetch first spends it - the sheet then never opens and the
    // button reads as dead. So the sheet comes first and the bytes are fetched
    // against a handle that already exists.
    const handle = await globalThis.showSaveFilePicker({ suggestedName: lastExport.file });
    const res = await fetch(lastExport.href);
    if (!res.ok) throw new Error(`the render could not be read back: HTTP ${res.status}`);
    const writable = await handle.createWritable();
    // Streamed rather than buffered: a 4K render is gigabytes and holding one in an
    // ArrayBuffer to hand it over in one piece would be a second copy for nothing.
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

// ------------------------------------------------- the library controls in the editor

// Changing the resolution reframes nothing, and there is no `history.commit()` under it
// any more. Both absences are the split: every size this menu offers is of the shape the
// stage is already letterboxed to, and the pixel count is the deliverable's rather than
// the document's - `serialiseProjectBody` does not write it, so a commit here would
// compare two identical snapshots and push nothing, which is a stack entry an operator
// would press undo for and not get. The shape is what commits, in `buildAspectSegments`.
ui.exportSize.addEventListener('change', () => {
  setDeliverableSize(ui.exportSize.value);
});
// The opening shape, through the same door a document arrives by, which is what fills
// the resolution menu for the first time - it is empty in the markup until this runs.
setProjectAspect(defaultAspect(), { fromDocument: true });

ui.mark.addEventListener('click', () => { markHere().catch(showTimelineError); });

/**
 * The one thing in the recorder that must not be got backwards, said on the control
 * rather than in a comment.
 *
 * `near`/`far` are viewer uniforms: they hide points that already arrived. The
 * grabber's `--min-depth`/`--max-depth` decide what exists at all, and nothing here
 * reaches them - capturing wide is free, because the depth payload is a fixed-size
 * array whether 40% or 90% of it is populated. Getting the two the wrong way round
 * destroys footage in the one situation where nobody is watching for it.
 *
 * The kept range comes from the hello rather than from a constant, because
 * `--min-depth` and `--max-depth` are grabber flags a shoot can override and a label
 * naming the defaults would be confidently wrong on exactly the rig that changed them.
 */
function paintPreviewRange(minDepth, maxDepth) {
  const kept = Number.isFinite(minDepth) && Number.isFinite(maxDepth)
    ? `capture keeps ${minDepth.toFixed(2)}-${maxDepth.toFixed(2)}m`
    : 'capture keeps everything the sensor resolves';
  ui.recRange.textContent = `preview only · ${kept}`;
}

// Every control that starts a preset gesture, named once so a fifth is covered by being
// added to this list rather than by being remembered.
//
// **The apply and the import are in it, and leaving them out is the hole this list was
// drawn up to close arriving through the other side.** What the guard protects is
// `appliedPreset`, and four doors write it: a save that describes the whole look, an
// apply of one, an import, and the apply on the recorder. Scoping the flag to the two
// controls that share the subset dialog left the other two live with a PUT in flight -
// press save, confirm, and apply a whole-look preset while the write is unanswered, and
// the apply's stamp lands first with the save's overwriting it, so the clip ends up
// wearing the older revision. That is the same corruption the dialog introduced, through
// a door the guard did not cover.
//
// It is one gate rather than a second rule sequencing writes to `appliedPreset`, because
// two gates that agree cannot be tested apart and one of them would be doing all the
// work - `docs/instruments.md` records the rename refusal costing exactly that. And it
// sits on the handlers rather than inside `applyStoredPreset`, because that function and
// `restoreProject` beside it are exposed raw for the proof tools to drive: a guard
// pushed down there would start silently dropping calls that are not gestures at all.
const PRESET_WRITERS = [ui.presetSave, ui.presetExport, ui.presetImport];

// Whether one of those gestures is running. It is a flag on the program rather than a
// state of a control, because what has to be true is that there is one gesture, not that
// a particular button is unpressable - a second door added later would otherwise be a
// second way in with no guard on it.
let presetGesture = false;

/**
 * One preset gesture at a time, whichever control started it.
 *
 * **This is a regression the dialog introduced and the `prompt()` it replaced did not
 * have.** A `prompt` blocks the whole page, so two saves could not overlap and nothing
 * had to say so; a `<dialog>` closes before the PUT it authorised has been answered,
 * and from that moment every preset control is live again with a write in flight behind
 * them. Two gestures whose responses come back out of order then run the stale handler
 * last, and `appliedPreset` ends up naming the older revision - which corrupts the one
 * thing the stamp is for, quietly, in the direction that looks like it worked.
 *
 * **A refused gesture used to be answered rather than dropped, and now it is dropped.**
 * This took an element to write into and said "a preset gesture is still running, so this
 * one did not start" on it, on the argument that a second press of save reads as the first
 * press not having registered, and that an apply or an import chosen from a picker or an
 * operating system file dialog is a document answered with silence. That argument was
 * right and the element it depended on is gone, so the honest description of this guard
 * now is that the second gesture does not start and nothing says so. The boolean return is
 * still here and still means what it meant, which is what a caller would need if a surface
 * for it ever comes back.
 *
 * The export half of this closes no race of its own: `exportPresetFile` builds a blob
 * and clicks a link, with no request whose answer could arrive late. It is here because
 * a gesture is a gesture, and because the controls share the dialog - a save left in
 * flight underneath a fresh export sheet is a name field over a document that is still
 * being written.
 */
async function withPresetGesture(run) {
  if (presetGesture) return false;
  presetGesture = true;
  try {
    await run();
  } finally {
    presetGesture = false;
  }
  return true;
}

/**
 * The write itself: the controls held down for as long as a request is unanswered, and
 * the caret given back to whichever of them was carrying it.
 *
 * The two spans differ on purpose. The **flag** covers the whole gesture including the
 * dialog, because that is the honest statement of the rule. The **disabled** state
 * covers only the write, because while the dialog is up it is modal and nothing outside
 * it can be pressed anyway.
 *
 * **And the caret is put back, because disabling is what took it.** `pickPresetSubset`
 * hands focus to the control that opened the dialog on the `close` event and resolves in
 * the same breath, so the button is holding the caret exactly when this runs a microtask
 * later - `el.disabled = true` on a focused element blurs it, the browser falls back to
 * the body, and re-enabling does not undo that. The guard's own comment used to argue
 * that the narrow span avoided this and the order made it false. `library.js` states the
 * rule beside `closeMenus` and `library-check` carries two mutations for it, so a
 * surface that strands the caret is a defect here rather than a detail. Only where the
 * caret has fallen to the body, so a gesture the user has moved on from does not have
 * focus dragged back out from under them.
 */
async function whileWriting(run) {
  const held = document.activeElement;
  for (const el of PRESET_WRITERS) el.disabled = true;
  try {
    return await run();
  } finally {
    for (const el of PRESET_WRITERS) el.disabled = false;
    const stranded = document.activeElement === null || document.activeElement === document.body;
    if (stranded && PRESET_WRITERS.includes(held) && held.isConnected) held.focus();
  }
}

/** Pick a subset, then do one thing with it, inside the one gesture the program allows. */
async function withPresetSubset(ask, run) {
  await withPresetGesture(async () => {
    try {
      const picked = await pickPresetSubset(ask);
      if (!picked) return;
      await whileWriting(() => run(picked));
    } catch (err) {
      showTimelineError(err);
    }
  });
}

// Named by the user, because a preset library whose entries are called "preset 3" is a
// library nobody uses twice - and the name is asked for in the same gesture as the
// subset, because they are two halves of one decision about the document being written
// and asking them one after the other would put a `prompt` in front of a dialog.
ui.presetSave.addEventListener('click', () => withPresetSubset(
  { title: 'Save this look', verb: 'save', name: appliedPreset?.name ?? 'look-1' },
  async (picked) => {
    const body = presetFromCurrentLook(picked.names);
    const res = await fetch(`/presets/${encodeURIComponent(picked.name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const saved = await res.json();
    if (saved.error) throw new Error(saved.error);
    // Saving stamps the clip too, on the same condition an apply does. The look on
    // screen genuinely is that revision of that preset when the file describes the
    // whole of it, and leaving the stamp on whatever was applied before would have the
    // provenance say a look this clip no longer has. A saved *subset* is the other
    // case, and the same sentence rules it out from the other end: the file does not
    // say what this clip is wearing, so the clip's origin is still whatever last did.
    if (wholeLookTag(body.values)) appliedPreset = { name: saved.name, rev: saved.rev };
    await refreshPresets();
    // The saved name, its revision and - on a subset - how many of the look's values went
    // into it were reported on the message chip. The name is on the picker afterwards and
    // the revision was never anywhere else, so a save is now confirmed by the entry
    // appearing in the list and by nothing more precise than that.
    history.commit();
  },
));

// The look on screen, not the document the picker happens to be pointing at. Those are
// the same thing only until you move a slider, and exporting what you can see is the
// answer that is right in both cases - the picker's name is the filename it is offered
// under, because it is the best guess at what to call it, which is a different question.
//
// Through the same dialog the save goes through, and that is the point rather than a
// saving of code: a file is what a look leaves this program as, so a subset you could
// put in a library and not in a file would be a document shape that exists on one side
// of the export and not the other.
ui.presetExport.addEventListener('click', () => withPresetSubset(
  {
    title: 'Export this look',
    verb: 'export',
    name: ui.preset.value || appliedPreset?.name || 'look',
  },
  async (picked) => {
    // The browser's own download indicator is what says this happened now.
    exportPresetFile(picked.name, presetFromCurrentLook(picked.names));
  },
));

// The button and the input are two halves of one control: a file input cannot be
// styled into the strip, and one that opens on its own is a control nobody can find.
ui.presetImport.addEventListener('click', () => ui.presetFile.click());
ui.presetFile.addEventListener('change', () => {
  const file = ui.presetFile.files?.[0];
  // Cleared before the await rather than after, so choosing the same file twice in a
  // row fires `change` the second time. An input that keeps its value is an import
  // button that works once per file per session.
  ui.presetFile.value = '';
  if (!file) return;
  // The input itself is never disabled and does not need to be: the button in front of
  // it is, and this is the only thing that opens it. The gesture is what the guard is
  // about anyway, so a file arriving here by any other route is still refused.
  return withPresetGesture(() => whileWriting(async () => {
    try {
      const saved = await importPresetFile(file);
      await refreshPresets();
      // Through the picker rather than by assigning `value`, so the name on the trigger
      // and the mark in the list are written by one call. Assigning the property alone
      // would leave the control reading its old name over a library that has the new one.
      // The display half and not `choosePicker`, because `importPresetFile` has already
      // applied what it read - going through the choosing path would fetch the document
      // back off the server and apply it a second time.
      showPickerChoice(pickers.find((p) => p.trigger === ui.preset), saved.name);
    } catch (err) {
      showTimelineError(err);
    }
  }));
});

/**
 * Save the open edit under a name the operator gives, which is what File > Save as and
 * Shift+Cmd+S both do.
 *
 * A function and not a button with two things clicking it. The timeline's project chip
 * carried a `save` button and the menu command and the shortcut both reached the flow by
 * synthesising a click on it; when the app bar replaced that chip the button went with
 * it, `ui.projectSave` became null, and the optional chaining turned both drivers into
 * no-ops that reported nothing. The lesson is which way the arrow points - a driver that
 * presses another control depends on that control still existing, and nothing says so
 * when it stops. Calling the flow is a dependency the parser can see.
 */
async function saveProjectAs() {
  const name = prompt('save this edit as', ui.project?.value || `${openTakeId ?? 'clip'}-edit`);
  if (!name) return;
  try {
    // The take is named by content hash rather than by path, which is what makes a
    // project a self-contained render job and what catches a capture that was
    // truncated, re-recorded or swapped underneath an edit. A path cannot do
    // either.
    const body = { ...serialiseProject(), take: { id: openTakeId, hash: openTakeHash } };
    const res = await fetch(`/projects/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const saved = await res.json();
    if (saved.error) throw new Error(saved.error);
    await refreshProjects();
    if (ui.project) ui.project.value = saved.name;
    // The name lands on the project control, which is where a save was confirmed after
    // the size in bytes stopped being reported anywhere.
    rememberOpened();
  } catch (err) {
    showTimelineError(err);
  }
}

ui.projectOpen?.addEventListener('click', async () => {
  const name = ui.project?.value;
  if (!name) return;
  try {
    await loadProjectNamed(name);
  } catch (err) {
    showTimelineError(err);
  }
});

// The auto-save, through the same door a named project goes through rather than
// through one of its own - so the hash refusal, the paused playhead and the restored
// undo stack are the behaviour that is already proved rather than a second copy of it.
// The offer withdraws itself on success because the document on screen is now the one
// it was offering, and an offer to restore what is already there is a button that
// looks like it does something.
ui.resumeOpen?.addEventListener('click', async () => {
  try {
    const accepted = offeredWorkingBody;
    await loadProjectNamed(WORKING_PROJECT, accepted);
    // **Written back before the snapshot is dropped, or the recovery lasts only as long
    // as the tab.** Holding the offered body fixed which document the press restores;
    // it did not make the restore survive anything. `__working__` still held the edit
    // that overwrote the offer, this was the only remaining copy, and nothing writes the
    // slot again until the next `history.commit()` - so closing the page after being
    // told the edit was restored loaded the overwriting edit back and lost the work a
    // second time, having just reported it recovered. That report is gone with the message
    // chip; the withdrawal of the offer below is what says the press worked now.
    //
    // Awaited and reported rather than fired and forgotten, unlike the auto-save on
    // every edit: that one is one of thousands and must not block a drag, while this is
    // the single moment the operator asked for their work back. A failure here has to
    // reach them, and the snapshot is kept if it does - dropping it would throw away the
    // last copy on the way out of a failed save.
    //
    // Through `writeWorking` and not straight to `fetch`, which is what makes it the last
    // write rather than merely a later one: an auto-save from the edit that overwrote the
    // offer can still be on the wire, and the server orders writes by whichever `rename`
    // finishes first.
    const kept = await writeWorking(accepted);
    if (!kept.ok) throw new Error(`restored on screen, but the auto-save could not be rewritten: ${(await kept.text().catch(() => '')).slice(0, 80)}`);
    if (ui.resume) ui.resume.hidden = true;
    offeredWorkingBody = null;
  } catch (err) {
    showTimelineError(err);
  }
});

ui.deliverable?.addEventListener('change', async () => {
  const name = ui.deliverable.value;
  if (!name) return;
  try {
    const doc = await (await fetch(`/deliverables/${encodeURIComponent(name)}`)).json();
    if (doc.error) throw new Error(doc.error);
    applyDeliverable(doc.body);
    // **No `history.commit()` here, and its absence is the split rather than an
    // oversight.** There was one, and it had become dead: everything `applyDeliverable`
    // writes - the trim, the resolution, the codec, the output name - is the deliverable's,
    // and `serialiseProjectBody` writes none of it, so the commit compared two identical
    // snapshots and pushed nothing on every adoption. A call that cannot ever add an entry
    // reads as "choosing a deliverable is undoable" to anybody maintaining this, which is
    // the opposite of what the design decided. Choosing a deliverable is not an edit to the
    // clip; it is choosing which file to make from it.
    showAdoptedDeliverable(name);
  } catch (err) {
    // **Put the picker back on what the clip is actually on.** `applyDeliverable` refuses a
    // document whose cuts are not program times, and it refuses it before it has replaced
    // anything - so the clip, the export size and the readout beside the picker all still
    // describe the deliverable that was there before. The picker was the one surface left
    // naming the refused one, and the two disagreeing is worse than either: the readout says
    // one thing, the control says another, and the file that comes out of a render afterwards
    // matches the readout while carrying the name the operator can see in the menu.
    //
    // This used to say the message stays on the application bar either way, so the picker
    // going back was the refusal being told in one place instead of contradicted in a
    // second. There is no second place now and no first one either: the control returning
    // to the adopted name is the whole of what a refused deliverable looks like, which
    // makes putting it back the only thing distinguishing a refusal from a silent success.
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
    // Through the same door as the menu's own adoption: what was just saved *is* what the
    // clip is on, so this is the selection a later refusal has to be able to come back to.
    showAdoptedDeliverable(name);
  } catch (err) {
    showTimelineError(err);
  }
});

// ---------------------------------------------------------- application shell

/**
 * Every element the shell drives, looked up so that a missing one names itself.
 *
 * `document.getElementById` answers `null`, and this table used to be an object literal
 * of bare calls whose entries are then dereferenced unguarded a few hundred lines below.
 * So an id that stopped existing - renamed in `index.html`, moved into a surface this
 * page does not draw, dropped by a merge - did not fail here. It failed at whichever
 * consumer happened to touch it first, as
 * `Uncaught TypeError: Cannot read properties of undefined (reading 'addEventListener')`,
 * naming a line number and nothing else.
 *
 * **What that costs is the whole page, silently.** `connect()` is called *below* this
 * block, so a throw anywhere in the shell wiring means the socket is never opened: the
 * header sits on "connecting..." for as long as anyone leaves it, the viewport stays
 * black, and the server - which takes `/record/start` over HTTP and has no opinion about
 * whether a browser is attached - records a take perfectly happily with `clients=0`
 * beside it in the log. That combination reads as a sensor or a network fault and is
 * neither, and it cost a real session: the operator was looking at USB packet-loss
 * warnings while the actual failure was one absent element id.
 *
 * Refusing is still the right answer and this does not soften it - a surface missing a
 * control is a broken build, and a page that boots with half its wiring gone is worse
 * than one that will not boot. What changes is that the refusal happens *here*, where
 * the cause is, and carries the ids rather than a line number; and that it reaches the
 * status line as well as the console, because the console is not where the operator is
 * looking. Collected across the whole table rather than thrown on the first miss, since
 * a rename usually takes more than one id with it and one round trip should name all of
 * them.
 */
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
    // Written straight to the element rather than through `setStatus`, which reads
    // sensor state this page will never now receive.
    if (statusEl !== null) statusEl.textContent = what;
    throw new Error(`${what} - the page cannot finish starting, so nothing below this ran`);
  }
  return found;
}

const shell = shellElements({
  surfaceName: 'surfaceName',
  saveProject: 'menuSaveProject',
  projectSettings: 'menuProjectSettings',
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
  exportClose: 'exportClose',
  projectDialog: 'projectDialog',
  projectClose: 'projectClose',
  projectDone: 'projectDone',
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

// `menus` is a query rather than an id, so it sits outside the table above: an empty
// list is a legitimate answer to `querySelectorAll` and there is no missing name to
// report. It stays a plain read for that reason and not by oversight.
shell.menus = [...document.querySelectorAll('.appmenu')];

shell.surfaceName.textContent = EDITING ? 'Editor' : 'Record';
for (const control of [
  shell.saveProject, shell.projectSettings, shell.export, shell.lookImport, shell.lookExport,
]) {
  control.disabled = !EDITING;
}

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
  // A menu command is hidden before the modal opens. Native dialog focus restoration
  // cannot return to that hidden command, so remember its visible trigger instead.
  // Without this, closing Export, OBS or State leaves focus on the body and the next
  // keyboard gesture starts from nowhere in the application shell.
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

// **Neither of these repaints on the way open, and the absence is checked rather than
// assumed.** Everything the two dialogs show already has a writer that paints it where it
// is written, which is where this file puts a repaint everywhere else - `paintExportFormats`
// sits in `applyDeliverable` for exactly that reason. The shape buttons and the resolution
// menu are painted by `setProjectAspect`, the only thing that writes `projectAspect`; the
// deliverable's summary and its trim by `paintDeliverable`, which `setClipInOut`,
// `setDeliverableSize` and `applyDeliverable` all reach; and `#tFps` by `timingChanged`,
// which the comment above it calls the place undo, a project load and an output-rate change
// all pass through.
//
// Measured with both dialogs shut rather than reasoned about, because that is the only way
// to tell a writer that covers a path from one that looks like it does: a speed change from
// 1.00x to 4.00x moved the trim readout from 75.62s to 18.90s, and an undo of a rate change
// put the select back from 60 to 30. A repaint here would be a second reader of state that
// is already current - it would cost nothing today and would hide the day one of those
// writers stops, which is the wrong direction for something only ever seen inside a modal.
shell.projectSettings.addEventListener('click', () => openDialog(shell.projectDialog));
// One command for the deliverable, where there were two. `Render` opened this dialog and
// `Export` jumped past it into `saveExportCopy` when there was something to hand over,
// which meant one menu item did two unrelated things according to state nothing in the menu
// showed. Handing a finished file over is a button *inside* the dialog - it is about an
// artifact rather than about starting one - so the menu opens the dialog and the button
// beside the note is where the copy is taken, enabled by the predicate that always decided
// it. `openDialog` shuts the menus itself, so there is no `closeApplicationMenus` here.
shell.export.addEventListener('click', () => openDialog(ui.exportDialog));
shell.saveProject.addEventListener('click', () => {
  closeApplicationMenus();
  saveProjectAs();
});
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
  // The same drain `sensorView` does before it writes a pose, and for the same reason
  // its comment gives: a release that is still settling owes the camera movement it
  // will deliver over the next frames, so a pose written underneath it lands and then
  // slides back out. `sensor view` has done this since it shipped and this button
  // never did, which is why the two behaved differently after a flick.
  finishOrbitDrift();
  controls.reset();
  requestRepaint();
});

/**
 * Collapse the settings to the dock, or bring them back.
 *
 * One writer for one class, called by the `H` key and by the app bar's toggle, because
 * the version of this that shipped set `#panel`'s inline `display` from the key handler
 * and nothing else could see it: a second control would have had to read an inline style
 * to know which way to go, and the two would disagree the first time anything else
 * touched the panel. It also stranded a touchscreen - `display: none` with the only way
 * back on a keyboard is a panel that, on the Pi's own 7" screen, does not come back.
 *
 */
function setPanelCollapsed(collapsed) {
  document.body.classList.toggle('panelcollapsed', collapsed);
  // "Show inspector" checked means visible, so the boolean inverts.
  shell.showSidebar.setAttribute('aria-checked', String(!collapsed));
  // The cloud's viewport is the window minus the panel, and collapsing changes that by
  // 302px. Without this the canvas keeps the width it had and the picture is stretched
  // until something else happens to resize it. `resize()` ends by asking for a repaint,
  // so there is no separate request here.
  resize();
}

shell.showSidebar.addEventListener('click', () => {
  closeApplicationMenus();
  setPanelCollapsed(!document.body.classList.contains('panelcollapsed'));
});

// The Pi's kiosk comes up with the settings already shut, and the thing that says so is
// the unit file's URL - `/record?panel=collapsed` - beside the two other decisions that
// screen needs made for it, the basic password store and the `127.0.0.1` the origin rule
// requires.
//
// **A viewport-width rule was the other candidate and it cannot be made safe here**,
// which is worth writing down because it is the obvious answer. The panel is 302px, so
// catching the Pi's 800px screen needs a threshold above 800 - and five of this repo's
// proof tools open a page 640 wide, which is *below* it, so every threshold that shuts
// the panel on the Pi shuts it under `registry-check`, `determinism-check`,
// `timeline-check`, `keyframe-check` and `export-check` too. Measured: the canvas there
// goes 360 to 290, seventy pixels off a rendered buffer that `determinism-check` exists
// to compare images of. Only a hand-picked 800-to-900 band separates them, and a number
// chosen so the fixtures keep passing is a number that has stopped describing anything.
// A parameter changes nothing unless something asks for it, which is the property the
// heuristic had no way to have.
if (new URLSearchParams(location.search).get('panel') === 'collapsed') setPanelCollapsed(true);

// The dock presses the real controls rather than repeating what they do. `recGo` owns
// whether a take can start at all - it carries the server's `cannotRecord` refusal as a
// disabled state and a title - and `recMark` owns whether there is a recording to mark,
// so routing through them means the dock inherits both refusals instead of being a
// second place they have to be remembered.
shell.dockRec.addEventListener('click', () => ui.recGo.click());
shell.dockMark.addEventListener('click', () => ui.recMark.click());
shell.dockCentre.addEventListener('click', () => shell.cameraReset.click());
// Framing's `sensor view` puts the eye at the sensor's own optical centre with its own
// field of view, which is the pose you frame a shot from - and it is two taps and a tab
// away with the panel open, which is exactly the panel you have shut while framing.
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

/**
 * The footer's dot, driven by what the server is actually serving.
 *
 * It replaces the literal `ready`, which was wired to nothing: it said the same word on
 * a machine with nothing reading the stream and on one where OBS had been pulling for
 * an hour, so it could not be wrong because it was not about anything.
 *
 * `/record/state` rather than a route invented for this, because it already carries
 * `webcam.subscribers` - the recorder's refusal is made of the same list, and a second
 * route answering the same question is the second copy that drifts. It is memory the
 * process already holds, measured on this rig at 1.2ms against the library listing's
 * 145ms, which is what makes a two-second cadence affordable while somebody is looking
 * at the dialog. Nothing polls while it is shut.
 *
 * **Loopback subscribers count.** The costing rule filters them out, correctly, because
 * a stream that never leaves the machine is not competing with the depth packets for a
 * radio. This is a different question - the operator is asking whether anything is
 * reading - and OBS on the same machine is the ordinary answer, so a dot that ignored
 * loopback would be dark in exactly the case it exists for.
 */
const OBS_POLL_MS = 2000;
let obsPollTimer = null;
let obsPollInFlight = false;

async function refreshObsStatus() {
  // One question outstanding at a time. A tick landing on an unanswered one would queue
  // behind it and paint the older of the two answers last.
  if (obsPollInFlight) return;
  obsPollInFlight = true;
  try {
    const state = await (await fetch('/record/state')).json();
    const webcam = state?.webcam ?? {};
    const n = (webcam.subscribers ?? []).length;
    shell.obsStatus.classList.toggle('live', n > 0);
    // A server with no colour camera is a third state and not a quiet kind of idle.
    // `idle` over a replay server invites somebody to go looking for the source that
    // is not reading, where the server already knows the answer and says it in a
    // sentence - so the sentence is what goes on screen.
    shell.obsStatusText.textContent = webcam.unavailable
      ? webcam.unavailable
      : (n === 0
        ? 'idle - nothing is reading'
        : `streaming to ${n} ${n === 1 ? 'source' : 'sources'}`);
  } catch {
    // Say so rather than holding the last answer. A stale count left on screen after the
    // server went away reads as a live stream, which is the one reading this dot must
    // never produce.
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

// On the dialog's own `close` rather than on the done button, because Escape and the
// close glyph are doors too and a poll left running behind a shut dialog is a request
// every two seconds for a number nobody can see.
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
  // Shut on every open, because the synthesised `· current` entry above already shows a
  // size that is not one of the three - so a dialog reopened on a custom size shows it in
  // the picker rather than in a field the operator has to be looking at to read.
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
  // `custom` names no size, so it writes nothing. It reveals the field beside it and hands
  // it the caret; the write happens when that field is committed, through the same
  // `#progSize` the fixed options go through. Writing the literal string here would put
  // "custom" into the output size and let the recorder refuse it, which is a refusal the
  // dialog invented rather than one the operator asked for.
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

// The custom size, committed through the one control that validates it. `#progSize`
// already refuses anything that is not WIDTHxHEIGHT and puts the previous value back, so
// this deliberately does not test the string first: a second parser here would be a second
// opinion about what an output size is, and the one that drifts is the one nothing writes
// through. Repainting afterwards is what shows the operator which of the two answers it
// took - the size it typed, or the one it was given back.
shell.obsCustomSize.addEventListener('change', () => {
  progSizeEl.value = shell.obsCustomSize.value;
  progSizeEl.dispatchEvent(new Event('change', { bubbles: true }));
  paintObsDialog();
});

// **Into the span, never onto the node that holds it.** `#obsStatus` is a container -
// the live dot and `#obsStatusText` are its children, and the two-second poll writes
// the second of them. Assigning `textContent` on the container replaces both with a
// text node, so the dot goes and the poll spends the rest of the session writing a
// span no document contains: the status freezes on whatever the last press said and
// reads as a stuck OBS connection rather than as a copy that happened once. The span
// is where every other writer of this message already writes, which is what makes one
// writer rather than two.
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

// Stats for nerds is the overlay `drawChrome` paints under the top-down view, and it is
// the only one. A `stateSnapshot()` used to build the same numbers as a JSON dump for a
// `#stateDialog`, and when the overlay arrived that pair stayed behind with nothing
// opening the dialog and nothing writing the dump - two representations of one state,
// the dead one silently unable to disagree with the live one. Both are gone, which is
// why this listener only flips a flag and asks for a repaint.
//
// **The dialog half of this came back in a merge and is gone again.** A fork of this
// branch had `#menuState` open a `#stateDialog` on the record surface and toggle the
// overlay only when editing, and merging it produced code referring to three things that
// do not exist: the element, which `index.html` says in as many words was deleted rather
// than left beside what replaced it; `updateStatsDialog`, which is defined nowhere in
// this tree; and `statsInterval`, which was never declared. None of that is a design
// disagreement to settle - restoring it would mean writing the feature, not restoring it.
//
// It is worth naming what the fragment cost, because the shape recurs. The surviving
// reference was a *top-level* `shell.stateDialog.addEventListener`, so it threw during
// module evaluation, and `connect()` runs below here: both surfaces died at boot with the
// socket unopened, showing "connecting..." over a black viewport while the server went on
// recording perfectly well with `clients=0`. Git merged it without a conflict, because
// each side's lines were individually fine.
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
  // **Asked before anything below it, Escape included.** A key another control has already
  // consumed is not this handler's to act on a second time, and Escape is the one key in
  // this program that more than one thing listens for: the level selection arms on a press
  // and cancels on Escape, calling `preventDefault` when it does. That listener is
  // registered earlier, so it runs first - and with this test below the Escape branch, a
  // press meant to cancel a floor selection also shut whichever application menu happened
  // to be open, which reads as the menu closing itself. `shortcuts-ignore-consumed` is the
  // mutation this repo already carries for the class, and the guard belongs above every
  // branch rather than in front of most of them.
  if (event.defaultPrevented) return;
  if (event.key === 'Escape') {
    closeApplicationMenus({ restore: true });
    return;
  }
  // `isTyping` stays below Escape rather than above it: shutting an open menu is the right
  // answer to Escape wherever the caret is, and with no menu open the call is a no-op. The
  // command keys below are the ones a text field has a claim on.
  if (isTyping(event.target) || !(event.metaKey || event.ctrlKey)) return;
  const key = event.key.toLowerCase();
  if (key === 'o' && EDITING) {
    event.preventDefault();
    location.assign('/gallery');
  } else if (key === 's' && event.shiftKey && EDITING) {
    event.preventDefault();
    saveProjectAs();
  } else if (key === 'e' && EDITING) {
    event.preventDefault();
    shell.export.click();
  }
  // **There is no Command-R here any more, and its absence is the merge rather than a
  // dropped binding.** It opened this dialog while Command-E jumped into the save, and
  // the two menu items behind them are now one. A shortcut that outlived the command it
  // belonged to is worse than no shortcut: every key this program binds is printed in a
  // `<kbd>` beside the item that runs it, so a live Command-R would be a gesture with
  // nothing on screen declaring it - and in a browser it is the reload the operator
  // meant, silently swallowed by a `preventDefault` for a command that no longer exists.
});

/**
 * Loads a project file onto the open take. This is the untrusted door: everything
 * before now came from a state this page had already vetted, and a file has not.
 *
 * The take is checked by hash before the document is applied. A project that names
 * different footage renders somebody else's edit over this take and looks entirely
 * plausible doing it, and a project whose take was re-recorded under the same name
 * is the same failure with nobody to blame - which is exactly what hash-referencing
 * the capture was for.
 *
 * Playback is stopped across the restore for the reason undo stops it: the
 * accumulators walk forward one source frame at a time and cannot be walked back,
 * so a retime curve swapped underneath a running playhead asks the source to go
 * backwards on the very next step, from inside the animation loop.
 */
/**
 * Loads a project by name, or applies a document the caller is already holding.
 *
 * **`offered` exists because one name in this store moves under its own reader.**
 * `__working__` is rewritten by `history.commit()` on every edit, so a document the
 * resume chip offered can be gone by the time somebody presses the chip - fetching the
 * name then restores whatever was typed in between and calls it a recovery. The offer
 * captures what it is offering and hands it back here, so the button restores the
 * document it advertised rather than the current contents of a slot.
 *
 * One implementation and not two: everything below this line - the footage check, the
 * transport, the history stack - runs identically either way. What the parameter
 * decides is only whether this function still has to go and get the document.
 */
async function loadProjectNamed(name, offered = null) {
  const doc = offered === null
    ? await (await fetch(`/projects/${encodeURIComponent(name)}`)).json()
    : { body: offered };
  if (doc.error) throw new Error(doc.error);
  const take = doc.body.take;
  if (take && openTakeHash && take.hash && take.hash !== openTakeHash) {
    throw new Error(
      `project ${name} was built on ${take.id} (${take.hash.slice(0, 22)}…) and the open take `
      + `hashes ${openTakeHash.slice(0, 22)}…: this is different footage, so the edit would `
      + 'render against material it was never authored against',
    );
  }
  const gen = takeTransport();
  const resume = timeline ? timeline.playing : false;
  if (resume) timeline.pause();
  restoreProject(doc.body);
  // The stack is restored from the file when it was saved; otherwise it restarts
  // from the loaded document. Undoing across a project load would walk back into an
  // edit of something else, which is the shape of undo people learn not to trust.
  if (doc.body.history) {
    history.stack = [...doc.body.history.stack];
    history.baseline = doc.body.history.baseline;
  } else {
    history.begin();
  }
  // A freshly loaded project gets a default deliverable unless one is already
  // selected, so export always has a target.
  ensureActiveDeliverable();
  applyDeliverable(activeDeliverable);
  await timeline.seek(timeline.programSec);
  if (resume && gen === transportGen) timeline.play();
  if (ui.project) ui.project.value = name;
  rememberOpened();
  return doc;
}

// ------------------------------------------------------------- the recorder surface

// Record, mark and remaining time - the load-bearing four-fifths of a shooting
// surface. It is on the live viewer and nowhere else: a clip on the timeline has
// nothing to record, and the two transports are exclusive for the same reason.
//
// The control is an HTTP call and the *state* comes back on the socket every
// monitor is already listening to, which keeps the property the spec asks for -
// a phone watching a capture node can start the take it is watching and press
// mark, and every other monitor sees the recording state change.
let recordState = { armed: false, recording: false, takeId: null, startedAt: null };

function paintRecord(storage) {
  if (!ui.recGo) return;
  const rec = recordState.recording;
  // A server that cannot record at all says so on the button rather than offering
  // one that fails when pressed. The replay server is the case, and it is one click
  // away in the setup this repo documents: before this the button was unconditional,
  // and pressing it on a replay opened a take, threw on every frame, and took the
  // live stream down while `/record/state` went on reporting a healthy recording.
  const blocked = recordState.cannotRecord ?? null;
  ui.recGo.disabled = Boolean(blocked);
  ui.recGo.title = blocked ?? '';
  ui.recGo.textContent = rec ? 'stop' : 'record';
  ui.recGo.setAttribute('aria-pressed', String(rec));
  ui.recMark.disabled = !rec;
  // The dock is the same two controls under a collapsed panel, so it is painted here
  // rather than from its own read of `recordState` - a second derivation is a second
  // thing that can be wrong, and the failure it produces is a dock offering `record`
  // over a take that is already running.
  //
  // Unguarded, because there is no state in which these are absent: `shellElements`
  // collects every missing id and throws before the page finishes starting, so a build
  // without a dock never reaches this line. An `if` here would describe a case that
  // cannot happen and quietly stop painting the dock in the one that can - a renamed id
  // would take the throw away with it and leave a dock painted by nothing.
  shell.dockRec.disabled = ui.recGo.disabled;
  shell.dockRec.title = ui.recGo.title;
  shell.dockRec.textContent = ui.recGo.textContent;
  shell.dockRec.setAttribute('aria-pressed', String(rec));
  shell.dockMark.disabled = ui.recMark.disabled;
  // Said before the button is pressed rather than only in the 409 it would answer.
  // The refusal exists so a full-rate monitor cannot quietly cost the take frames,
  // and an operator who only learns that from an error in the second they were
  // trying to roll has been told too late to do anything with it.
  // **Consumers rather than monitors**, because the webcam costs the take the same way
  // and through a route with no divisor and no stride to name. Each entry says its own
  // kind and its own setting, so this reads them out rather than assuming both fields
  // exist - which is what it used to do, and what would have printed "÷undefined
  // ×undefined" the first time somebody attached a webcam over the network.
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
    // A directory that is not there is a different problem from one that is full,
    // and the operator gets the sentence rather than the errno that used to arrive
    // here raw.
    ui.recSpace.textContent = storage.error ?? `${storage.label} left at current settings`;
    // The warning is load-bearing rather than polish: with manual-only deletion the
    // card genuinely fills, and unattended the failure lands mid-shoot.
    ui.recSpace.classList.toggle('low', Boolean(storage.error) || storage.secondsLeft < 15 * 60);
  }
}

// This page's tick of the shared poll, held so the record button can ask again the
// instant it has changed something rather than waiting out the cadence. Assigned by
// the boot block below, and only on the live surface: an editor has no recorder to
// ask about, and a second poll started for the sake of a button is the copy this
// module exists to avoid.
let askRecordState = async () => {};

if (ui.recGo) {
  ui.recGo.addEventListener('click', async () => {
    ui.recGo.disabled = true;
    try {
      // The content type is not decoration: a route that changes something refuses
      // a request that does not declare JSON, because that declaration is the one
      // thing a page you merely visit cannot make without asking permission first.
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

// Everything below the shooting controls, revealed rather than removed. The design
// argues the shooting surface should stay small - record, mark, remaining time, a
// preset and the preview range are what the person in the room is actually using -
// but a big screen and a quiet moment before a take is a good place to find out where
// a look wants to go, and refusing that would be the panel deciding how people work.
//
// Camera view toggle handler used by both panel and timeline controls
function toggleCameraView() {
  const program = viewCamera === freeCamera;
  setViewCamera(program ? programCamera : freeCamera);
  ui.camView.setAttribute('aria-pressed', String(program));
  ui.tCamView?.setAttribute('aria-pressed', String(program));
  requestRepaint();
}
ui.camView.addEventListener('click', toggleCameraView);
ui.tCamView?.addEventListener('click', toggleCameraView);

/**
 * Opens a take on the timeline. The live socket is never opened on this path.
 *
 * The intrinsics come from the take rather than from a socket, and that is the
 * whole reason this function fetches twice. `uniforms.focal` and `uniforms.center`
 * used to arrive only in the hello the grabber sends over the WebSocket, so a page
 * opened on a take unprojected every point on the defaults baked into the uniform
 * block - fx 366, fy 366, cx 256, cy 212 against this sensor's own 366.031494 and
 * cx 257.775909, cy 206.784195. That is about 45mm of error at three metres,
 * scaling with depth, and nothing on screen could ever have shown it: the error is
 * a near-uniform translation, so both arms of every comparison in this repo were
 * wrong in exactly the same way and agreed. Step 2's scan already recorded where
 * the hello sits in the file, so this is one positioned read.
 *
 * A take with no hello is refused rather than opened on the defaults. The whole
 * point of the fetch is that geometry nobody can check must not be baked into an
 * export, and "we do not know this sensor's intrinsics" is exactly that case.
 *
 * The live socket writes the same two uniforms without this gate, and that is the
 * right place for the asymmetry rather than an omission: a live preview bakes
 * nothing, and a hello the sensor sent badly is recorded into the capture along
 * with everything else, so the file is where it becomes permanent and opening the
 * file is where it gets refused.
 */
// The open take's content hash, which is how a project names its footage. Read off
// the index the source already fetched rather than recomputed, because rehashing
// gigabytes on every project save is exactly what step 2's design refuses.
let openTakeHash = null;

// Whether `openTake` has run to the end. Exposed on the check hook, and it is there
// because a transport that exists is not a take that has opened: `timeline` is
// assigned less than halfway through, before the library is listed and before the
// resume offer has been decided, so a check waiting on the transport can read the note
// a whole fetch before anything has written it. That is a race a passing run cannot be
// told apart from a broken feature, and it cost a reproduction here.
let takeOpened = false;

async function openTake(id) {
  const source = await IndexedPairSource.open(id);
  const res = await fetch(`/capture/${encodeURIComponent(id)}/hello`);
  if (!res.ok) {
    throw new Error(
      `take ${id} carries no sensor hello (${res.status}): its intrinsics are unknown, and `
      + 'unprojecting it on the boot defaults would put every point out by tens of millimetres '
      + 'with nothing on screen to show it',
    );
  }
  const hello = await res.json();
  // **Which generation wrote this, before anything reads a field out of it.** Ahead of
  // the bounds check below rather than beside it, because the two questions nest: that
  // check asks whether these numbers are usable *as this build understands the record*,
  // and a take from a format this build has never seen is one whose fields could be
  // perfectly in range and mean something else. A gallery listing the same take has
  // already greyed its Open button off this same sentence, and the two agreeing is the
  // whole reason it is one function rather than two comparisons.
  //
  // Here rather than on the live socket, for the reason the paragraph above gives about
  // the intrinsics: a live preview bakes nothing, and the file is where a record that
  // cannot be trusted has already become permanent.
  const wrongFormat = captureFormatRefusal(`take ${id}`, hello.format ?? null);
  if (wrongFormat) throw new Error(wrongFormat);
  // Positive rather than finite, and inside the frame rather than merely a number.
  // `Number.isFinite(0)` is true, so a hello carrying `fx: 0` - the shape a writer
  // that recorded a field it never filled produces - passed a refusal written to
  // stop exactly this: every pixel unprojects through a division by zero, and a
  // negative focal mirrors the cloud through the optical axis. Both are geometry
  // nobody can check, which is the case this gate exists for rather than a corner
  // of it.
  //
  // The centre is bounded by the depth grid this page is about to index rather
  // than by a range invented here: `pixel` runs over DWxDH in the vertex shader,
  // so a principal point outside it puts the optical axis off the sensor, which is
  // a transposed or unit-confused record rather than an unusual camera. The bound
  // is deliberately not tight - a real cx sits near the middle - because a
  // plausible-but-wrong centre is a translation no bound can distinguish from a
  // correct one, and pretending otherwise would be a threshold with no method
  // behind it.
  const usable = hello.fx > 0 && hello.fy > 0
    && hello.cx > 0 && hello.cx < DEPTH_W
    && hello.cy > 0 && hello.cy < DEPTH_H;
  if (!usable) {
    throw new Error(
      `take ${id} has an unusable hello: ${JSON.stringify(hello)} - focal lengths must be `
      + `positive and the centre must lie inside the ${DEPTH_W}x${DEPTH_H} depth frame`,
    );
  }
  uniforms.focal.value.set(hello.fx, hello.fy);
  uniforms.center.value.set(hello.cx, hello.cy);
  // The range this take was actually shot at, which is a property of the file rather
  // than of whatever the grabber is configured for now.
  paintPreviewRange(hello.minDepth, hello.maxDepth);
  // A page opened on a take opens no socket at all, and the detach is still the
  // door it goes through: the flag it raises is what stops a colour decode
  // started anywhere else from landing in the textures under a timeline render.
  detachStream();
  sensorLabel = `take ${id} · ${source.count} frames · ${source.duration.toFixed(2)}s`;
  setStatus();

  pairSource = source;
  timeline = new TimelineTransport(source);
  // A new take gets the whole clip. The window is not saved anywhere on purpose: where
  // you were looking is not what the clip is, and a project that reopened zoomed into
  // four seconds of a fifteen-minute take would read as having lost the rest of it.
  view.fit();
  document.body.classList.add('editing');
  ui.root.hidden = false;
  showInspector();
  // The path, its nodes and the top-down go on with the timeline and only with it.
  // A live viewer has no clip to compose and the pinned drive hashes images, so
  // furniture in either would be furniture nobody asked for in pixels somebody is
  // comparing.
  chromeOn = true;
  placeChrome();
  openTakeId = id;
  openTakeHash = source.index.hash;
  // Remembered as soon as the take is genuinely open, so the menu can offer it again.
  // A project name lands on top of this if one is loaded after; opening a take on its
  // own is still worth resuming, since it is the footage that took the effort to shoot.
  rememberOpened();
  // The crop box, fitted to this take's own cloud.
  //
  // **Here rather than lower down, and the position is two decisions rather than one.**
  // It has to be before `history.begin` below: the baseline is the clip serialised, so a
  // fit written after it is the first thing on the undo stack - a box you never dragged,
  // undoable, and different from the document the auto-save is about to compare against.
  // And it is above the marks and the three library listings rather than beside them,
  // because every await between the take appearing and this landing is a stretch of time
  // where the editor is interactive with the wide box on screen: put after them, the box
  // visibly jumps a second later, which reads as something correcting itself.
  //
  // Softly, like those listings and for their reason: a node whose extent route is
  // unreachable is still a node you can cut footage on, and what you get is the wide box
  // it always was. It used to say so on the message chip; with that gone the console is
  // where it lands, which is the same trade the three listings below now make.
  //
  // **Unconditional, and it was written with a gate that turned out to be unreachable.**
  // The gate asked whether the document had authored its four faces, on the reasoning
  // that a box somebody dragged must not be overwritten - which is the right rule and
  // names a state this call site cannot be in. `openTake` runs once per page load, off
  // `REQUESTED_TAKE`, against a registry at its defaults; opening a take from the gallery
  // is a navigation rather than a second call; and a project named in the query is
  // restored by the `.then` after this promise, not before it. So the condition was false
  // on every path that reaches here, and a branch nothing can take is a branch that
  // silently stops being tested. The rule it was protecting still holds and is enforced
  // where it is actually decided: a restored document names all six faces and lands on
  // top of this, so a document's own box outranks a measurement by arriving later.
  await fitCropToTake(id, params.get('near'), params.get('far')).catch(showTimelineError);
  // Awaited, so the first paint of the ruler already has the ticks on it. A take
  // whose marks arrived a frame later would show them appearing, which reads as
  // the page finding them rather than the take having them.
  await loadMarks(id);
  // **Softly, but never silently.** All three of these are allowed to fail without
  // stopping the take from opening - a node with an unreachable library is still a node
  // you can watch footage on - and all three used to fail into an empty `catch`, so a
  // `--builtin-presets` pointing one directory too high drew a picker holding nothing
  // but the placeholder and said not one word about why. The server's refusal exists
  // and reaches here; only the editor was throwing it away.
  //
  // Still collected rather than reported one at a time, though the reason has changed
  // under it: it was that three notes written in sequence leave only the last one on the
  // message chip, and with the chip gone it is that one console line naming all three
  // failures is a better record than three lines a reader has to notice are related.
  // The pickers themselves are the visible half - one holding nothing but its placeholder
  // is what an unavailable library looks like on screen now.
  const unavailable = [];
  const listed = {};
  for (const [what, refresh] of [['presets', refreshPresets], ['projects', refreshProjects],
    ['deliverables', refreshDeliverables]]) {
    listed[what] = await refresh().catch((err) => { unavailable.push(`${what} (${err.message})`); return null; });
  }
  if (unavailable.length) console.error('[library] unavailable:', unavailable.join('; '));
  ensureActiveDeliverable();
  applyDeliverable(activeDeliverable);
  timingChanged();
  // The stack starts from whatever the clip already is, so the first undo has
  // somewhere honest to land rather than an empty document.
  history.begin();
  // After `begin`, because the offer is about whether the auto-save differs from the
  // clip on screen and `baseline` is that clip serialised.
  //
  // **Gated on the projects list alone, and deliberately not on the other two.** The
  // offer used to be withheld whenever any part of the library failed to list, back
  // when it was a sentence written through `say` that would have painted over the note
  // naming what was broken. It is a button now - `offerWorkingDocument` writes
  // `#tResume` and nothing else - so there is nothing left for it to overwrite, and
  // what the old gate actually did was throw away the one control that can reach
  // `__working__` because an unrelated `--builtin-presets` pointed at the wrong
  // directory. That document is deliberately absent from the project picker, so
  // withholding this button is withholding the only road back to the operator's work.
  if (listed.projects) offerWorkingDocument(listed.projects);
  await timeline.seek(0);
  // Two things per frame, and the second is not an afterthought: with the playhead
  // parked `tick` returns immediately, so this is the only clock a paused editor has.
  // A drag that continued itself off its own renders instead is what this loop was
  // added to replace - see `pumpDraft`.
  renderer.setAnimationLoop(() => { timeline.tick(); pumpParkedDraft(); });
  takeOpened = true;
  return timeline;
}

// ------------------------------------------------------------------ drive hook

// A run of capture frames pinned from a file, driving the renderer with no socket
// and no wall clock anywhere in the loop. Everything about the walk it performs is
// the shared one; all it adds is that its bytes are already in memory.
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

// ------------------------------------------------------------------------- boot

/**
 * Compile every program the look can reach, before the first frame anybody sees.
 *
 * **A pass costs nothing until it is first switched on, and then it costs 83ms.** The
 * three post passes and the point material's additive variant are each compiled the
 * first time they are actually reached, which is whenever somebody drags a slider off
 * zero or picks a preset - so the frame that engages them is one long frame and every
 * frame after it is normal. Measured on this build, editor at 0.851 Mpx, single frames
 * with a readPixels barrier, against a 0.7ms steady state:
 *
 *     first frame after the grade pass engages    83.1 ms
 *     first frame after bloom engages             48.1 ms
 *     first frame after an `additive` toggle      20.9 ms
 *     the same toggles a second time               0.7 - 2.1 ms
 *
 * A graded preset writes all three at once, so picking one costs about 150ms of
 * compilation and picking it again costs nothing. That asymmetry is why the same look
 * gets reported as smooth by somebody who tried it twice and as a stall by somebody who
 * tried it once, and it is the largest single thing behind "the effects fluctuate".
 *
 * **It is one composed frame and not a pass-by-pass warm**, because reaching into
 * `UnrealBloomPass` for its internal materials is the coupling `resetAccumulators`
 * already carries a guard against - the internals move between three versions and a
 * warm that silently stopped warming would be invisible. Rendering the chain the way
 * the chain is rendered cannot go stale that way.
 *
 * The cost is charged where nobody is waiting on a picture. This runs before either
 * transport is installed, so the depth textures are still the empty initial ones and
 * the cloud draws nothing: it compiles programs rather than shading a scene.
 *
 * **Nothing may survive it.** The enabled flags go back to what they were, and
 * `resetAccumulators` clears the surface-memory pair and the afterimage's two buffers
 * and puts `lastProgramTime` back to zero - so a warmed page and an unwarmed one are
 * the same state by every reading, which is what `determinism-check` compares. It
 * deliberately does not go through `renderProgramFrame`: that would advance the
 * surface state, move `counters.renders` off zero and evaluate tracks that do not
 * exist yet.
 */
function warmPrograms() {
  const was = { after: afterimage.enabled, bloom: bloom.enabled, grade: grade.enabled };
  const wasAdditive = uniforms.softEdge.value === 1;
  try {
    afterimage.enabled = true;
    bloom.enabled = true;
    grade.enabled = true;
    // Both blending states, because `setAdditive` flips `material.needsUpdate` and the
    // blend is its own pipeline object on a Metal driver - the 20.9ms above is that
    // object being built, not GLSL being parsed, so compiling one variant leaves the
    // other still owed.
    setAdditive(!wasAdditive);
    composer.render(0);
    setAdditive(wasAdditive);
    composer.render(0);
  } catch (err) {
    // A page that cannot warm is a page that still works, one hitch at a time. It is
    // reported rather than swallowed because a warm that silently stopped happening
    // would read exactly like the stalls coming back for some other reason.
    console.warn('could not warm the shader programs:', err.message);
  } finally {
    afterimage.enabled = was.after;
    bloom.enabled = was.bloom;
    grade.enabled = was.grade;
    resetAccumulators();
  }
}
warmPrograms();

// Which transport owns the loop is decided once, here, and the two are exclusive:
// a page editing a take must not have a socket writing depth into the textures
// underneath it, and a live viewer has no timeline to drive. Which of the two this
// is comes from `EDITING` at the top of the module; the take and the project it
// opens are named in the query, because the gallery and the menu both have to be
// able to hand this page a specific clip.
const REQUESTED_TAKE = new URLSearchParams(location.search).get('take');
const REQUESTED_PROJECT = new URLSearchParams(location.search).get('project');

if (EDITING && !REQUESTED_TAKE) {
  // The editor with nothing to edit. Both doors into this page name a take, so
  // arriving here without one means a hand-typed URL or a stale bookmark, and the
  // gallery is the only place that can answer the question it implies.
  location.replace('/gallery');
} else if (EDITING) {
  // Two failures with two names. A project can fail on its own - the resume path can
  // hand this page a project whose take hash does not match the footage, which is a
  // refusal `loadProjectNamed` raises deliberately - and blaming the take for it
  // would send someone to look at the one thing that was fine.
  openTake(REQUESTED_TAKE)
    .catch((err) => {
      sensorLabel = `cannot open take ${REQUESTED_TAKE}`;
      setStatus();
      showTimelineError(err);
      throw err;
    })
    .then(() => (REQUESTED_PROJECT ? loadProjectNamed(REQUESTED_PROJECT) : null))
    .catch((err) => {
      // The take opened and the project did not, so the editor stays on the take
      // rather than going dark: the footage is there and only the edit is missing.
      if (openTakeId) showTimelineError(new Error(`project ${REQUESTED_PROJECT}: ${err.message}`));
    });
} else if (PROGRAM_OUT) {
  // The source. A live socket like the viewer, and then three departures from it.
  //
  // **No animation loop.** `handleFrame` draws instead, so the output has one frame
  // per sensor frame rather than one per display refresh.
  //
  // **A fixed output size.** `outputSize` takes the drawing buffer off the window,
  // which is the same door `exportClip` opens for the length of a render and this
  // mode simply holds open. A browser source is sized by OBS and would otherwise hand
  // the encoder whatever the offscreen window happened to be.
  //
  // **No furniture and no orbit.** Chrome lives on its own canvas and cannot reach
  // these pixels anyway, but the controls can: an OrbitControls still listening would
  // let a stray event in the source's own window fight the pose being pushed to it.
  document.body.classList.add('program-out');
  controls.enabled = false;
  chromeOn = false;
  // The module-level resize() ran before this branch added program-out, so the
  // canvas was positioned below the appbar that is now hidden. Clear it: the
  // export path keeps the existing box because the editor is still present, but
  // here the editor is gone and the canvas fills the source window.
  renderer.domElement.style.top = '0px';
  renderer.domElement.style.left = '0px';
  outputSize = { ...programOutSize };
  resize();
  setViewCamera(programCamera);

  programOutReadout = document.createElement('div');
  programOutReadout.id = 'programOutReadout';
  programOutReadout.textContent = 'PROGRAM OUT  waiting for the operator';
  document.body.appendChild(programOutReadout);

  connect();
  // Nothing renders until a frame lands, so the first thing OBS would otherwise
  // capture is an uninitialised buffer. One frame now makes it the scene's clear
  // colour instead, which is a black frame somebody chose.
  renderProgramFrame(0);
} else {
  // Opened here rather than beside the socket code, because `handleFrame` pushes
  // into the pair source above. Arrivals cannot dispatch until module evaluation
  // finishes either way, but relying on that at the call site makes the ordering
  // look accidental when it is a requirement.
  connect();
  renderer.setAnimationLoop(liveLoop);
  // The top-down and stats overlays, on the recorder as well as the editor. The
  // comment that used to say "only with the timeline" was written when there was
  // no timeline on the recorder - now there is a preview, and the same furniture
  // that helps compose a shot helps frame one.
  chromeOn = true;
  placeChrome();
  // The preset library, refreshed at startup.
  refreshPresets().catch((err) => {
    console.error('preset library unavailable:', err.message);
  });
  // Until the hello lands there is nothing truthful to say about the kept range, and
  // the label still has to say the part that does not depend on the sensor.
  paintPreviewRange(NaN, NaN);
  // The remaining-time readout, on the surface an operator is actually looking at.
  // Polled rather than pushed because free space changes on its own - another
  // process writing, a card filling - and a number that only moved when the
  // recorder did would be stale in the one direction that matters.
  //
  // **Which is why this caller ignores the change flag entirely.** The gallery gates
  // on it because a repaint there throws away what the operator is pointing at; here
  // there is nothing to throw away and a gated readout would simply stop being true.
  // The flag is offered to both and read by one, which is the shape that lets the
  // module have no opinion about either surface.
  askRecordState = pollRecordState((state) => {
    recordState = state;
    paintRecord(state.storage);
    chromeStale = true;
    drawChrome();
  });
}

// Handles for profiling and for poking at the scene from the console.
globalThis.__kinect = {
  renderer, composer, scene, freeCamera, programCamera, uniforms, material,
  bloom, afterimage, grade, geometry, resetAccumulators, renderProgramFrame,

  // A getter and not the object, because the object is replaced whenever navigation's
  // up changes. Five checks reach for `k.controls.target` and `k.controls.update()`,
  // and a captured reference would keep answering for a disposed object - the drag
  // would work on screen while every assertion read the corpse.
  get controls() { return controls; },

  // Levelling: the rotation the room is carrying, and the neutral-state action that
  // writes the pair back through the same control path a slider does.
  //
  // Read off **the cloud** rather than off the quaternion the parameters compose into,
  // and the difference is the whole value of the row. `registry-check` calls this the
  // landing site for `tilt` and `roll`, and a landing site has to be the place the
  // renderer reads: answering from the composed value would report a rotation that had
  // been computed correctly and never applied, which is one edit away at all times and
  // is exactly what `level-check --mutate tilt-ignored` does.
  worldTilt: () => cloud.quaternion.toArray(),
  resetWorldRotation,

  // The live cloud's draw-rate cap, in hertz, readable and settable so the rate can be
  // swept on the node it was chosen for. A getter and a setter over the one binding the
  // loop reads rather than a copy, because a sweep that moved a second variable would be
  // measuring something the shipped build does not run.
  get cloudDrawHz() { return cloudDrawHz; },
  set cloudDrawHz(hz) { cloudDrawHz = Number(hz); },

  /**
   * What the GPU spent on recent frames, as the overlay reads it, plus how the reading
   * came about. Published because a check has three separate things to establish here
   * and only one of them is a number: that the extension is present at all, that the
   * timer is gated on the panel rather than always running, and that what it reports
   * moves when the frame genuinely gets more expensive.
   *
   * `sampling` is the honest answer for a panel that has just opened, and it is
   * distinguished from `unavailable` rather than folded into it, because a driver
   * without the extension and a query that has not come back yet are different facts
   * and a check that could not tell them apart would pass on the wrong one.
   */
  gpu: () => ({
    supported: gpuTimer.supported(renderer.getContext()),
    timing: statsVisible,
    samples: gpuTimer.samples.length,
    ms: gpuTimer.median(),
  }),

  // The sensor's own view, and the numbers it derived. Returned rather than left to
  // be read off the camera because the containment rule is the claim worth checking
  // and `fov` alone cannot say which axis bound it.
  sensorView,
  surface: () => (EDITING ? 'edit' : 'record'),

  // What the crop planes have to clear, from the intrinsics the page is actually
  // unprojecting with. Exposed because "the defaults crop nothing" is a claim about
  // this sensor rather than about the constant, and a check should be able to hold
  // the two against each other for the take that is open.
  cropReach,

  // The crop box as the chrome actually draws it, which is the distinction that makes
  // these worth exposing at all. `cropBoxCorners` is the array the edges and the handles
  // are built from, so a check reading it is reading the geometry on screen rather than
  // recomputing the same eight corners beside it and agreeing with itself - and the
  // rotation is the thing worth asking about, since a box drawn in the sensor's axes
  // over a levelled cloud is exactly the bug the top-down's old rectangle had.
  //
  // `cropHandles` answers per view because which faces can be dragged is a fact about
  // the projection rather than about the box: a face seen edge-on has no leverage for a
  // pointer to resolve against and is offered no handle, and that rule is what a check
  // has to be able to see to know it is a rule rather than a hardcoded list.
  cropBoxCorners: () => cropBoxCorners().map((v) => v.toArray()),
  cropHandles: (plan = false) => cropHandles(plan, insetRect())
    .map(({ param, at, sx, sy }) => ({ param, x: at.x, y: at.y, sx, sy })),
  cropBoxShown: () => showCropBox,
  // How deep the undo stack is, exposed because "the box was fitted and it is not
  // something you can undo" is two claims and only one of them is about the planes.
  // Read off the stack the keyboard pops rather than off a counter kept beside it, for
  // `worldTilt`'s reason: a number computed correctly and never applied is one edit away
  // at all times.
  undoDepth: () => history.depth,
  // Whether `openTake` has finished. `history.begin()` is the last thing it does that a
  // document can observe, so a baseline existing is "the open is over" - and a tool that
  // waited on the fitted planes instead would hang rather than fail on a build that never
  // fits, which is a thirty-second timeout carrying no failed assertion where a finding
  // was wanted.
  takeOpened: () => history.baseline !== null,
  cropOutside: () => uniforms.cropOutside.value,

  // The sizes the export menu offers, and the way to adopt one.
  //
  // **Exposed so a proof tool sweeps the sizes the product ships rather than a list
  // of its own.** That is the step 6 hole written as an interface: `export-check` had
  // four arms that were all 1.6 while this menu had four that were all 16:9, so a
  // build referring to the width was bit-identical on every arm and 11.1% wrong on
  // every size a user could pick. A tool reading this cannot drift from the menu,
  // because it is the menu.
  //
  // `setOutputSize` is here for the same reason the editor letterboxes: the stage's
  // shape is the export's shape now, so a tool asking for a stage of some size has to
  // say which shape it means rather than assuming the window decides.
  //
  // **Both gestures, because an operator making that happen performs both.** The shape
  // moved onto the project and the pixel count stayed on the deliverable, so putting the
  // product on 2048x1080 is Project settings then Export - and a hook that did only the
  // first would leave the deliverable on whichever size the new shape opens with, which
  // is not the size the tool asked for. Sweeping every size in `exportSizes` is exactly
  // what `export-check` does, and a sweep whose arms silently render a neighbour is the
  // four-arms-all-16:9 hole this hook was added to close, back under a different name.
  //
  // A size of a shape the table has nothing for - `640x400` is `[8, 5]`, and four tools
  // use it to keep the stage cheap - lands the same way a legacy project's does: the
  // shape is adopted, the size is appended to the menu as its own, and the two agree, so
  // `exportClip` has nothing to refuse.
  //
  // **This can put the editor in a framing `restoreProject` will refuse, and no user
  // gesture can.** The shape buttons only offer what `EXPORT_SIZES` holds; this takes any
  // size, so `setOutputSize('640x400')` frames at 8:5 - a shape the table has no resolution
  // for - and a document written out of that framing is refused on the way back in. Four
  // tools asked for exactly that as a cheap small stage, and the one of them that undoes
  // died mid-run on its own snapshot. All four are 640x360 now: `keyframe-check` because it
  // died, and `registry-check`, `timeline-check` and `export-check` because passing on a
  // framing no document could hold is a fact about those files rather than a state worth
  // keeping. A tool wanting a small stage asks for a shape the product offers.
  //
  // Not refused here, because the refusal that matters is on the document: this hook exists
  // so a tool can frame the stage at a *size* the product does not list, which is how
  // `export-check` sweeps sizes the menu never offers. Narrowing it to the table would take
  // that away. What it may not do is pick a *shape* the table cannot serve, and the
  // difference between those two is the whole reason `restoreProject` refuses shapes rather
  // than sizes.
  //
  // It renames `setTargetSize`, which was named for a `targetSize` that no longer exists.
  // Five of its six callers reached it as `setTargetSize?.(...)`, so the old name left
  // behind would not have thrown anywhere - it would have quietly stopped resizing while
  // every arm went on reporting, which is the failure mode this repo keeps finding.
  exportSizes: () => EXPORT_SIZES.flatMap((g) => g.sizes.map(([w, h]) => ({ ratio: g.ratio, w, h }))),
  setOutputSize: (text) => setProjectAspect(aspectOfSize(text), { fromDocument: true })
    && setDeliverableSize(text),
  outputSize: () => ({
    aspect: [...projectAspect],
    size: activeDeliverable?.outputSize ?? null,
  }),

  // The registry and the one bulk write a user gesture performs. Both refuse while a
  // frame is being evaluated, which means exactly what it says: the evaluator runs
  // inside `renderProgramFrame`, so the flag spans it.
  //
  // `setMode`, `mode()` and the two hardcoded presets used to sit here beside them,
  // and a tool wanting a reading now writes one - `params.set('readBlackwall', 1)`.
  // The five names are published rather than left to be spelled out in each check,
  // so a tool sweeping the readings sweeps the readings this build has rather than
  // the ones its author remembered, which is the same rule `exportSizes` above is
  // here for.
  params, applyPreset,
  readings: () => READINGS.slice(),

  // What a document has to name to be a whole look, published for the same reason the
  // readings are: a tool that spelled the framing exclusion out for itself would be a
  // second statement of the line, and the two would drift in the direction where the
  // check goes on passing. `library-check` asks this and then asserts every shipped
  // document names *exactly* it, which is why the arm is worth anything - the documents
  // are data on disk and this is code, so the equality is two independent probes rather
  // than one quantity asserted twice. Shrink this function and the nine become supersets
  // and redden; grow it and they come up short and redden. Its two mutations are the
  // control at each end: one drops a value from a document, the other drops a group from
  // here.
  completeLookNames,

  // How often the panel has re-derived which groups are open, since boot. Published
  // because the claim it carries is about *how many times* a bulk write asks that
  // question, and nothing outside the page can count that - a driver timing the gesture
  // measures the driver, which is the rule `docs/measurement.md` states about the paused
  // orbit. It is also the only way to see a gate whose whole effect is an absence.
  groupRefreshes: () => groupRefreshes,

  /**
   * Keys, the curve and the undo stack. Every number a check reads comes from
   * here rather than from the DOM, because a lane is a view on a track the same
   * way a slider is a view on the registry - and asserting against the view would
   * pass on a page that drew the right diamonds over the wrong curve.
   */
  keyframes: {
    /**
     * A handle as a tool hands one over, refused rather than repaired.
     *
     * Version 5 made a handle a list of control points, and the shape it replaced -
     * a bare `[0.42, 0]` - survives `copyHandle` without complaint: mapping a pair of
     * numbers gives `[[undefined, undefined], [undefined, undefined]]`, which evaluates
     * to `NaN` and renders as a track that has silently stopped existing. Every tool in
     * this tree was moved across with the format, so this guards nobody who exists today
     * and exists for the one who writes the next one against a five-year-old example.
     * A door that turns a stale fixture into a blank picture is the failure this whole
     * version gate is about, arriving through the hook the checks come in by.
     */
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
    setRetime({ rate = 1, keys = [] }) {
      retime.rate = rate;
      // Built first, then checked, then stored. The guard reads handles, so it has
      // to see the ones a key will actually have rather than the ones it arrived
      // with - a key written without them is linear, not handleless, and asking the
      // guard to know that would put the defaults in two places.
      const built = keys.map((k) => ({
        t: k.t,
        value: k.value,
        easeOut: this.handleFrom(k.easeOut ?? EASE_OUT_LINEAR, 'easeOut', 'the retime'),
        easeIn: this.handleFrom(k.easeIn ?? EASE_IN_LINEAR, 'easeIn', 'the retime'),
      }));
      retime.assertMonotonic(built);
      retime.keys = built;
      timingChanged();
    },
    /** What a track says at a program position, without rendering anything. */
    valueAt(name, t) { return tracks.get(name)?.valueAt(t) ?? null; },
    names() { return [...tracks.keys()]; },
    toggle: toggleKey,
    lanes: () => laneRows().map((r) => ({ owner: r.owner, kind: r.kind, keys: keysOf(r.owner).length })),
    project: serialiseProject,
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
  /**
   * The interaction layer's own state, for a check that drives real controls and
   * then has to read what they did. Deliberately read-only apart from `selection`:
   * every one of these was a claim nothing could see before, which is how a build
   * shipped with the in/out markers detached and the delete gesture absent.
   */
  editor: {
    clipRange: () => ({ in: clipIn, out: clipOut }),
    // The speed slider's travel is logarithmic, so its `value` is a position and not a
    // rate. A check that wants to drive the control at 2.35x has to be able to say
    // where 2.35x is, and the alternative - writing the rate into `value` - would set
    // some other rate and go on asserting happily about it.
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
    /**
     * The window the strip is drawn against, and the mapping both ways through it.
     *
     * `pct` and `secAtPct` are exposed as a pair on purpose: the claim worth checking
     * is that they invert each other at an arbitrary window, and a check that could
     * only read one of them would have to reimplement the other to say anything -
     * which is a second copy of the arithmetic under test.
     */
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
    // The take's marks as the strip draws them, planted without writing a sidecar. A
    // mark is the one thing on the ruler that must hold still across a speed change
    // *without* being rescaled - it is stored in source milliseconds and drawn through
    // the curve - so a check needs one present to tell "every term was carried across"
    // from "the ruler never moved". Going through `markHere` to get one would write
    // into the take on disk, which is a check editing the fixture it measures.
    setMarks(list) {
      takeMarks = list.map((m) => ({ ...m }));
      paintMarks();
      paintMarkButton();
    },
    selection: () => (selection ? { owner: selection.owner, t: selection.key.t } : null),
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
    // Read off `KINDS` rather than written down again, so a proof tool asks which
    // kinds claim to be easable instead of asserting against the two that happen to
    // exist today. A kind added later arrives in the sweep by existing.
    easedKinds: () => Object.keys(KINDS).filter((k) => KINDS[k].eases),
    // The beads the path overlay draws, in world space. A canvas cannot be asked what
    // it drew, so the check reads the function the drawing reads - see `beadPoints`.
    pathBeads: () => beadPoints(pathPoints()),
    exportName: () => ({ base: exportBaseName(), valid: EXPORT_NAME_OK.source, canSaveAs: CAN_SAVE_AS }),
    lastExport: () => (lastExport ? { ...lastExport } : null),
  },

  // No control switches the viewport yet - the free camera is what the live
  // viewer shows. This is how the program camera is reached until step 5 gives
  // it a path worth looking at and the top-down view a reason to draw its frustum.
  setViewCamera,
  viewCamera: () => viewCamera,

  // The timeline, and the counters a proof tool reads instead of taking the
  // transport's word for what it did. A check asserting "the seek reset the
  // accumulators once and rendered 29 frames" has to be able to see both numbers,
  // or it is restating the claim rather than testing it.
  timeline: {
    open: openTake,
    transport: () => timeline,
    retime,
    counters,
    /**
     * Resolves once every scheduled repaint has been enqueued and run and the
     * transport's queue has drained. Anything measuring renders needs it: a
     * repaint it did not ask for would land inside its window and be counted as
     * work the thing under test performed.
     *
     * The draft state is in the condition because a draft is armed a frame before it
     * runs. While `pumpDraft` restarted itself, an armed position was always either
     * already in flight or one microtask from it, so `working` covered it; now the
     * animation loop starts it, and there is a window up to a frame wide where a
     * draft is armed, `working` is down and nothing is queued. Every tool in the
     * suite synchronises on this call, so a window that reads as idle there is a
     * flake in all of them rather than in the one that opened it.
     */
    async settled() {
      for (let i = 0; i < 200; i++) {
        // A macrotask, so a repaint scheduled on the microtask queue has been
        // enqueued by the time the transport is asked whether it is idle.
        await new Promise((resolve) => { setTimeout(resolve, 0); });
        await timeline?.idle();
        if (!repaintWanted && !repaintBusy && !repaintScheduled && !timeline?.working
          && draftWanted === null && !draftBusy && !orbitRedrawWanted && !orbitSettling) return;
      }
      throw new Error('the transport never settled');
    },
    /** A snapshot, so a reader cannot accidentally hold a live object. */
    read() {
      if (!timeline) return null;
      const t = timeline;
      return {
        frame: t.frame,
        programSec: t.programSec,
        sourceSec: retime.sourceSecAt(t.programSec),
        outputFps: t.outputFps,
        rate: retime.rate,
        duration: t.duration,
        lastFrame: t.lastFrame,
        playing: t.playing,
        drafted: t.drafted,
        // Whether a released orbit is still draining its damping. Exposed because a
        // check that wants to test what happens *during* that window has no other way
        // to know it was in it - the window is about a third of a second long and
        // closing it is exactly what makes the case go away, so a row that simply
        // hurried and hoped would report a pass on the run where it arrived late.
        settling: orbitSettling,
        lastSeek: t.lastSeek,
        lastCostMs: t.lastCostMs,
        overtaken: t.overtaken,
        behindMs: t.behindMs,
        preroll: t.preroll(),
        applied: t.source.applied,
        cached: t.source.cache.size,
        mixT: uniforms.mixT.value,
        sinceFrameSec: uniforms.sinceFrameSec.value,
        hasColor: uniforms.hasColor.value,
      };
    },
  },

  /**
   * The library's half of the editor: the document version, the load path a
   * project file arrives through, the preset stamp, and the take's marks.
   *
   * `restoreProject` is exposed raw and deliberately. It is the door every refusal
   * this step added lives on, and a check that could only reach it through a
   * successful save-and-load could never hand it the malformed documents those
   * refusals exist for.
   */
  library: {
    PROJECT_VERSION,
    restoreProject,
    serialiseProject,
    serialiseProjectBody,
    loadProject: loadProjectNamed,
    applyStoredPreset,
    presetFromCurrentLook,
    // The product's own re-list, exposed rather than re-implemented. A proof tool that
    // plants a preset on the server needs the page to read the library again, and the
    // alternative is a reload - which this suite already has one crash from, and which
    // would throw away the document the section under it is standing on.
    refreshPresets,
    setActiveDeliverable,
    // The door beside the bare assignment above, and both are here on purpose. A check
    // that wants a deliverable *placed* uses the setter; anything adopting one the way a
    // surface does has to use this, because the version gate and the shape refusal live in
    // it. `tools/render-worker.mjs` used the setter and so rendered documents the editor
    // refuses - one take, one set of rules, whichever surface asks.
    applyDeliverable,
    activeDeliverable: () => activeDeliverable,
    appliedPreset: () => appliedPreset,
    /**
     * Whether a preset gesture is running, which is the guard's own state and is
     * published because a driver cannot see it any other way.
     *
     * The `disabled` attribute is only half the span - it goes on after the dialog
     * closes and comes off when the write is answered - and the flag covers the dialog
     * too. So a tool pressing one of these controls has to know when the last gesture
     * finished, and the observable it would otherwise reach for is wrong in a way that
     * costs a whole run: `dialog.close()` clears `open` synchronously and fires its
     * `close` event in a later task, so a driver that waited for `open === false` can
     * press again while the promise is still unresolved and the flag still up. That
     * press is correctly ignored, the dialog does not open, and the check dies on a
     * ten-second timeout with no failed assertion - a crash wearing the shape of a
     * finding. Measured exactly once, on `editor-check` at 238 of 274.
     */
    presetGestureRunning: () => presetGesture,
    marks: () => takeMarks.map((m) => ({ ...m })),
    markHere,
    takeId: () => openTakeId,
    takeHash: () => openTakeHash,
    /**
     * Whether `openTake` finished, which is the only moment its last decision - the
     * resume offer - has been made. A check that waits for the transport instead is
     * waiting on something assigned two fetches earlier.
     */
    opened: () => takeOpened,
    /** Where each mark ticks on the ruler, as the page actually drew it. */
    markTicks: () => [...document.querySelectorAll('#tMarks .tmk')].map((el) => ({
      left: Number.parseFloat(el.style.left),
      beyond: el.classList.contains('beyond'),
    })),
  },

  // The export, and the two things a check has to be able to ask it: run one, and
  // find out whether one is running. `run` resolves with what the server said it
  // wrote - the output path, the frame count, and the hashes of the frames that
  // actually crossed the wire, which is the only view anything has of what left
  // the browser.
  export: {
    run: exportClip,
    running: () => exporting,
    rendererClass,
  },

  // The deterministic drive. Every claim from step 1 onward is checked through
  // it: pin the inputs, step the playhead to an exact program position, read the
  // image back, and see whether the same positions give the same pixels twice.
  drive: {
    /** Detaches the live loop and feeds a run of capture frame payloads instead. */
    pin(buffer) {
      // Cleared here rather than in `pumpParkedDraft`, and the asymmetry is the whole
      // reason this is a separate site: the other two states that strand an armed
      // position leave the loop running, so the loop is able to notice them. This one
      // takes the loop away, so afterwards there is nothing left to notice anything.
      // A drag that armed a redraw or entered release settling before a check pinned
      // its inputs would leave `settled()` running out its two hundred iterations and
      // throwing - in every tool in the suite, since they all synchronise on it. The
      // rule this states is for whatever detaches the loop next: taking the clock
      // away is the last moment anything can drop what the clock was going to serve.
      draftWanted = null;
      orbitRedrawWanted = false;
      orbitSettling = false;
      renderer.setAnimationLoop(null);
      detachStream();
      pinnedPairs = new PinnedPairSource(buffer);
      pairSource = pinnedPairs;
      // Colour decode is asynchronous, so a pinned run leaves it out rather than
      // racing it. Depth is what the accumulators read anyway.
      uniforms.hasColor.value = 0;
      return pinnedPairs.times.slice();
    },
    /**
     * A colour image the caller supplies, for the one arm that cannot work without one.
     *
     * `pin` above switches colour off, and that is right for what it is for: a JPEG
     * decode is asynchronous, so a pinned run that raced it would hash a frame whose
     * colour had or had not landed. But a pinned run with no colour draws `vec3(0.7)`
     * for every point, and saturation of a uniform grey is the identity at every value -
     * so `rgbSaturation` sat in a dead zone where the sweep that proves each parameter
     * reaches a pixel would have recorded it as a parameter that cannot. That is the
     * failure this repo keeps finding, and the answer is to move the probe rather than
     * to write down an exception for it.
     *
     * The colour pair is `gpu-textures.js`'s, so this is that module's own third writer
     * exposed rather than a second one written here: an assignment to an imported
     * binding is a TypeError, and it would be thrown while this object literal is being
     * built - publishing no `__kinect` at all and leaving every tool in the suite with
     * no assertion behind its exit code. `injectDepth` below has always had the right
     * shape for the same reason.
     */
    plantColor,
    times() { return pinnedPairs.times.slice(); },
    /**
     * One frame's depth straight into the current texture, bypassing every pair
     * source. This exists for one check and it is the only one that can be made:
     * everything else a transport proves is relative, because both arms of a
     * comparison walk the same lookup, so a systematic off-by-one in which frame
     * gets bound would shift them together and agree. Rendering from bytes handed
     * in here ties a picture to a frame number instead.
     */
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

  // Reads the surface memory back off the GPU. Mostly useful for checking that a
  // static scene sheds nothing: if it does, the swap detector is firing on sensor
  // noise rather than on motion.
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
