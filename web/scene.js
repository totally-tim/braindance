// The renderer, the scene, the cameras and the navigation they are driven by.
//
// First out of `main.js`, and it could go first because it is the only section in that
// file that reads no top-level name declared anywhere else - everything here is built
// out of three.js and the DOM, and everything else in the viewer reads *from* it. So it
// sits at the bottom of the import order: this module imports no part of the page, and
// the page imports it before anything that needs a renderer to exist.
//
// The body below is the section as it stood in `main.js`, moved without a character
// changed. The exports are a single statement at the foot rather than an `export`
// keyword on each declaration, for the reason the whole split is careful about: the
// proof tools mutate this tree by matching exact source text, so a line that gained two
// characters in a move is a control that stops matching and says nothing about it.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
// Named, because the editor's furniture lives on a second canvas over this one and
// "the canvas" stopped being an unambiguous thing to ask for. This is the rendered
// frame; the other one is chrome.
renderer.domElement.id = 'stage';
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x05070a);
scene.fog = new THREE.FogExp2(0x05070a, 0.11);

// The camera does two unrelated jobs and they cannot share an object. Orbiting to
// inspect the cloud is navigation - view state, leaving no trace - while a camera
// key is document state a keyframe writes and an export has to reproduce exactly.
// So there are two cameras: a free one the controls drive, and a program one the
// transport poses straight from program time. Damping is why nothing keyframed
// can go through the controls at all - it is a frame-rate-dependent filter, so the
// same move would land somewhere else at a different output frame rate.
const ORBIT_TARGET = new THREE.Vector3(0, 0, -2.2);
const PROGRAM_FOV = 50;

const freeCamera = new THREE.PerspectiveCamera(PROGRAM_FOV, innerWidth / innerHeight, 0.05, 60);
freeCamera.position.set(0, 0.1, 1.6);

const programCamera = new THREE.PerspectiveCamera(PROGRAM_FOV, innerWidth / innerHeight, 0.05, 60);

// Which of the two the viewport draws. The free camera is the default, so the live
// viewer stays exactly what it was. Step 5's top-down view draws the program
// camera's frustum from outside, which is why these are two objects rather than
// one object with the controls switched off.
let viewCamera = freeCamera;

// The room's vertical, which is what +Y means once the levelling below has done its
// job. Before it, +Y is up in the sensor's bracket and the turntable spins about a
// pole the footage does not have.
const WORLD_UP = new THREE.Vector3(0, 1, 0);

// Not a constant, and that is the one surprising thing about navigation here.
// OrbitControls resolves its orbit axis from `object.up` **in the constructor** and
// never looks again - `_quat` in `three/examples/jsm/controls/OrbitControls.js`,
// applied every `update()` and recomputed by nothing - so writing a new up onto the
// camera half-applies: `lookAt` picks the roll up immediately while the azimuth axis
// keeps spinning about the old pole. That reads as damping gone wrong rather than as
// a wrong axis, which is exactly the kind of bug that survives a review. Rebuilding
// the object is the honest fix; reaching in and assigning `_quat` is not, because it
// is a private that can be renamed by a patch release with nothing to catch it.
let controls;

// Listeners are registered here rather than on the object, because the object does
// not survive a change of up. Everything the old one carried is copied across, so a
// rebuild is invisible apart from one frame of damping.
const navListeners = [];

function buildControls() {
  const previous = controls;
  controls = new OrbitControls(freeCamera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.autoRotateSpeed = 0.6;
  if (previous) {
    controls.target.copy(previous.target);
    controls.autoRotate = previous.autoRotate;
    controls.enabled = previous.enabled;
    // **The home pose is part of what the old object carried**, and it is the one thing
    // this copy used to leave behind. `OrbitControls` captures `target0`, `position0` and
    // `zoom0` in its constructor and never again, so a rebuild silently re-homes Reset on
    // wherever the camera happened to be when the up vector changed, aimed at the world
    // origin. Levelling a canted mount is the first thing the README tells an editor to
    // do, so that is the ordinary path rather than a corner: level the room, then press
    // Reset, and the camera goes to where you were standing when you moved the slider.
    // Carried across rather than re-saved, because a rebuild is meant to be invisible.
    controls.target0.copy(previous.target0);
    controls.position0.copy(previous.position0);
    controls.zoom0 = previous.zoom0;
    previous.dispose();
  } else {
    controls.target.copy(ORBIT_TARGET);
    // **And on the first construction the home has to be taken after the target is
    // written**, which is the half that has been wrong since this was first built. The
    // constructor clones `target` into `target0` before this line runs, so `reset()`
    // restored a pivot of `(0, 0, 0)` rather than the `(0, 0, -2.2)` the cloud sits at.
    //
    // It survived because it reads as working: the two aims differ by about 2 degrees, so
    // the frame immediately after the press looks right. What is wrong is everything
    // after - the orbit now turns about a point 2.2m in front of the subject, so dragging
    // swings the cloud across the frame instead of turning around it. On the Pi's
    // collapsed-panel touchscreen the dock's centre button is the only recentre there is,
    // so the one control for getting un-lost was the one leaving the camera lost.
    controls.saveState();
  }
  for (const [type, listener] of navListeners) controls.addEventListener(type, listener);
}

function onNav(type, listener) {
  navListeners.push([type, listener]);
  controls.addEventListener(type, listener);
}

/**
 * The pole the turntable spins about. One variable with two writers that want
 * opposite things: levelling wants the room's vertical, and the sensor view wants
 * the sensor's own, because a picture claiming to be exactly what the sensor shot
 * cannot be quietly rolled upright first.
 */
function setNavigationUp(up) {
  if (freeCamera.up.equals(up)) return;
  freeCamera.up.copy(up);
  buildControls();
}

buildControls();

// Orienting is done on a camera-shaped scratch object rather than on a bare
// Object3D, because three points cameras and lights down -Z and everything else
// down +Z: the same lookAt on the wrong kind of object gives a pose facing the
// other way, and it would look plausible right up until the frustum was drawn.
const poseScratch = new THREE.PerspectiveCamera();

// A pose as a value rather than as a camera that has been moved, because the
// camera is a registry parameter like every other one and everything reaches it
// through the same door. Step 4 fed this from a placeholder orbit; the camera
// track feeds it now, and nothing downstream of the registry changed for that.
function poseLookingAt(position, target = ORBIT_TARGET, fov = PROGRAM_FOV) {
  poseScratch.position.copy(position);
  poseScratch.lookAt(target);
  return {
    position: poseScratch.position.toArray(),
    quaternion: poseScratch.quaternion.toArray(),
    fov,
  };
}

// Where the program camera stands when nothing has keyed it: exactly where the
// free camera starts, looking at the same point. A clip with no camera keys is a
// locked-off shot rather than a camera at the origin staring into the void.
const DEFAULT_POSE = poseLookingAt(new THREE.Vector3(0, 0.1, 1.6));

/**
 * Point the viewport at a different camera.
 *
 * Here rather than at the call site because `viewCamera` is this module's binding, and
 * an importer cannot assign to what it imports - that is a hard rule of ES modules
 * rather than a style choice. `main.js` keeps `setViewCamera`, which is the thing with
 * an opinion about the render pass and the controls; this is only the assignment it can
 * no longer make for itself.
 */
function useViewCamera(cam) {
  viewCamera = cam;
}

export {
  PROGRAM_FOV,
  renderer,
  scene,
  freeCamera,
  programCamera,
  viewCamera,
  controls,
  WORLD_UP,
  DEFAULT_POSE,
  onNav,
  setNavigationUp,
  useViewCamera,
};
