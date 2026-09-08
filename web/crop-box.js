// The crop box and the nine parameters that frame a take, in one place. Three surfaces ask the
// same question of the same faces - the cloud's vertex stage, the plan inset, and the webcam
// page keying the colour picture - so the six comparisons are written once and the GLSL below is
// spliced into the cloud's spine rather than kept beside it.
//
// Nothing is imported here and nothing may be: the webcam page and its tests read these names
// under bare node, with no three.js, no page and no uniform table standing around them.

/** The framing group, in registry order. `web/main.js` refuses a table that disagrees. */
export const FRAMING_NAMES = Object.freeze([
  'tilt', 'roll', 'near', 'far', 'crop', 'left', 'right', 'bottom', 'top',
]);

/** The six faces, as the names the registry stores them under. `crop` is the switch, not a face. */
export const CROP_FACE_NAMES = Object.freeze(['near', 'far', 'left', 'right', 'bottom', 'top']);

// The depth pair's defaults, named once because four things have to agree about them: the two
// uniforms in `web/point-cloud.js`, the registry entries that overwrite them at boot, `duotoneSpan`
// whose default is the width of the range they describe, and the webcam page keying on the same
// box. The uniforms carried a different pair once, and the registry won at boot, so the shader's
// neighbours read as a lie.
export const CLIP_NEAR_DEFAULT = 0.05;
export const CLIP_FAR_DEFAULT = 6;

// How far out the four lateral planes reach, in metres. It has to clear everything the sensor can
// see at the furthest depth the near/far sliders allow; `cropReach` in `web/point-cloud.js` works
// out what that is for a given lens.
export const CROP_LIMIT = 7;

/** What each framing parameter holds before anybody moves it. */
export const FRAMING_DEFAULTS = Object.freeze({
  tilt: 0,
  roll: 0,
  near: CLIP_NEAR_DEFAULT,
  far: CLIP_FAR_DEFAULT,
  crop: true,
  left: -CROP_LIMIT,
  right: CROP_LIMIT,
  bottom: -CROP_LIMIT,
  top: CROP_LIMIT,
});

/**
 * Whether an unprojected point is on the wrong side of the crop box. Sensor metres and before the
 * levelling rotation, matching the shader: the point is what `unprojectPixel` returns, so
 * image-left is positive x and the camera looks down -z. A falsy `crop` cuts nothing.
 *
 * This takes a whole point where the GLSL `outsideDepthPair` takes the sample's positive z, because
 * the cloud tests the depth pair before it unprojects and has no point yet to hand it.
 *
 * The comparisons are strict, so a point exactly on a face is inside. A face holding NaN never
 * cuts on its own, which is what the GLSL does too.
 */
export function outsideCropBox(faces, point) {
  if (!faces.crop) return false;
  const metresOut = -point.z;
  if (metresOut < faces.near || metresOut > faces.far) return true;
  return point.x < faces.left || point.x > faces.right
    || point.y < faces.bottom || point.y > faces.top;
}

/**
 * libfreenect2's pinhole model in JavaScript, the twin of `unproject` in `web/cloud-shader.js`
 * and of the specification in `server/protocol.js`. The half pixel puts the sample at the centre
 * of its cell, and all three axes are negated, so image-left comes back positive x, image-top
 * positive y, and the camera looks down -z.
 *
 * `zMetres` is positive metres out from the sensor and the returned `z` is its negation, which is
 * the convention `outsideCropBox` reads - so the two compose with no sign flip between them.
 *
 * `target` is written in place and handed back when it is given, so a sweep over every texel
 * allocates nothing. A three.js `Vector3` qualifies, since the three fields are its own.
 */
export function unprojectPixel(col, row, zMetres, { fx, fy, cx, cy }, target) {
  const point = target ?? { x: 0, y: 0, z: 0 };
  point.x = (-(col + 0.5 - cx) / fx) * zMetres;
  point.y = (-(row + 0.5 - cy) / fy) * zMetres;
  point.z = -zMetres;
  return point;
}

/**
 * The same six comparisons for the cloud's vertex stage, spliced into its spine by
 * `web/cloud-shader.js`. It declares no uniforms of its own: every name below is one the spine
 * already declares, so a rename there is a compile error here rather than a silent zero.
 */
export const CROP_BOX_GLSL = /* glsl */ `
// Asked in two places because the depth pair is a property of the sample and is known before the
// unprojection, where the lateral four are positions in the room and are not.
bool outsideDepthPair(float z) {
  return cropOn == 1.0 && (z < nearClip || z > farClip);
}

bool outsideLateral(vec2 xy) {
  return cropOn == 1.0 && (xy.x < cropL || xy.x > cropR || xy.y < cropB || xy.y > cropT);
}
`;
