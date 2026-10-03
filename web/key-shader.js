// The one program the keyed webcam draws: the colour picture, with every pixel the crop box
// rejects turned transparent. A full-screen quad rather than the cloud's vertex stage, because
// what is being keyed is a video frame and not a point per depth sample.
//
// The six comparisons are spliced from `web/crop-box.js` rather than written again here, so this
// page and the cloud cannot come apart about which side of a face a point is on.

import { CROP_BOX_GLSL } from './crop-box.js';
import { KEY_DEPTH_LEVELS } from './key-stream.js';

export const KEY_VERTEX = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

export const KEY_FRAGMENT = /* glsl */ `
uniform sampler2D colourTex, depthTex;
uniform vec2 imageSize;
uniform float fx, fy, cx, cy, rangeM;
uniform float cropOn, nearClip, farClip, cropL, cropR, cropB, cropT;

varying vec2 vUv;

// The levels a quantised reading has above "no reading", from web/key-stream.js. Deliberately not
// the 255.0 below it, which is the largest value an 8-bit texel carries: the two are the same
// number today and are different quantities, and dividing by the wrong one would still look
// plausible.
const float DEPTH_LEVELS = ${KEY_DEPTH_LEVELS}.0;
${CROP_BOX_GLSL}
void main() {
  // Both textures are uploaded with flipY off, so v runs down the picture the way rows do and the
  // quad's own v has to be turned over for row 0 to land at the top of the frame.
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);

  // The byte back out of the greyscale JPEG. Nearest sampling, or this would be a blend of two
  // depths that are not near each other and a silhouette would grow a halo of invented distances.
  float v = floor(texture2D(depthTex, uv).r * 255.0 + 0.5);
  if (v == 0.0) {
    gl_FragColor = vec4(0.0);
    return;
  }

  float z = v / DEPTH_LEVELS * rangeM;
  if (outsideDepthPair(z)) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // A fragment samples at the centre of its pixel, so this already carries the half that
  // \`unproject\` in web/cloud-shader.js adds to an integer index. Both axes negated with it, which
  // is what puts image-left on positive x.
  vec2 pixel = uv * imageSize;
  vec2 lateral = vec2(-(pixel.x - cx) / fx, -(pixel.y - cy) / fy) * z;
  if (outsideLateral(lateral)) {
    gl_FragColor = vec4(0.0);
    return;
  }

  // Premultiplied, because that is what the renderer was opened for and what OBS composites.
  gl_FragColor = vec4(texture2D(colourTex, uv).rgb, 1.0);
}
`;
