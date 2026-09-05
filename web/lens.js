// A camera's vertical field of view as the 35mm-equivalent focal length a photographer names.
//
// A file of its own so a node test can hold the arithmetic with nothing running, and because
// the aspect it takes is the trap: the angle a focal length subtends depends on the shape of
// the frame, so this has to be handed the *project's* aspect. A camera's own `aspect` is the
// window it is drawn into, and reading that here would move the lens on a window resize.
//
// Data and arithmetic. No import, nothing constructed, no top-level side effect.

// The full-frame gate the 35mm equivalence is against, in millimetres, and its half-diagonal.
// Derived rather than written down: 21.6333 is the number this works out to, and a literal
// rounded from its own definition is the disagreement this repo finds later and has to correct.
const FRAME_WIDTH_MM = 36;
const FRAME_HEIGHT_MM = 24;
const HALF_DIAGONAL_MM = Math.hypot(FRAME_WIDTH_MM, FRAME_HEIGHT_MM) / 2;

/**
 * The vertical angle a lens covers, in degrees, on a frame of the given aspect (width / height).
 *
 * Zero millimetres answers 180 degrees and an infinite focal length answers 0, which are the
 * limits rather than special cases - there is no clamp here, because the display is where a
 * band of usable lenses belongs and `sensorView` has to be free to write whatever the sensor's
 * intrinsics imply.
 */
function verticalFovForFocalLength(focalMm, aspect) {
  const halfHeight = HALF_DIAGONAL_MM / Math.sqrt(aspect * aspect + 1);
  return (2 * Math.atan(halfHeight / focalMm) * 180) / Math.PI;
}

/** The 35mm-equivalent focal length, in millimetres, of a vertical angle in degrees. */
function focalLengthForVerticalFov(fovDeg, aspect) {
  const halfHeight = HALF_DIAGONAL_MM / Math.sqrt(aspect * aspect + 1);
  return halfHeight / Math.tan((fovDeg * Math.PI) / 360);
}

/** Returns the perspective projection's vertical scale for an angle in degrees. */
function projectionScaleForVerticalFov(fovDeg) {
  return 1 / Math.tan((fovDeg * Math.PI) / 360);
}

export { verticalFovForFocalLength, focalLengthForVerticalFov, projectionScaleForVerticalFov };
