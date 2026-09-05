// The keyed webcam source, drawn at /key and opened by OBS as a browser source. One pair of
// pictures in - the colour frame and the depth in its space - and one 1920x1080 frame out with
// alpha wherever the crop box says there is nothing.
//
// The pair is the clock. There is no animation loop, because a second frame drawn from the same
// two pictures is the same frame, and OBS reads the page at whatever rate it reads it.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CROP_FACE_NAMES, FRAMING_DEFAULTS } from './crop-box.js';
import { KeyFrames } from './key-frames.js';
import { KEY_FRAGMENT, KEY_VERTEX } from './key-shader.js';

const OUT_W = 1920;
const OUT_H = 1080;

const canvas = document.getElementById('key');

const renderer = new THREE.WebGLRenderer({
  canvas, alpha: true, premultipliedAlpha: true, antialias: false,
});
renderer.setPixelRatio(1);
// `false`, so the stylesheet stays the only thing that decides how big the canvas is on the page.
renderer.setSize(OUT_W, OUT_H, false);
renderer.setClearColor(0x000000, 0);

// No colour space on either: the cloud's sRGB textures are undone again by the chain's OutputPass
// and this page has no chain, so a decoded texel is passed to the framebuffer exactly as the JPEG
// carried it. Depth is not a picture at all and a conversion on it would move the metres.
const makeTexture = (filter) => {
  const tex = new THREE.Texture();
  tex.colorSpace = THREE.NoColorSpace;
  // The shader turns the row over itself, so the two textures cannot disagree about which end of
  // the image row 0 is.
  tex.flipY = false;
  tex.minFilter = filter;
  tex.magFilter = filter;
  tex.generateMipmaps = false;
  return tex;
};

const colourTex = makeTexture(THREE.LinearFilter);
const depthTex = makeTexture(THREE.NearestFilter);

const uniforms = {
  colourTex: { value: colourTex },
  depthTex: { value: depthTex },
  imageSize: { value: new THREE.Vector2(OUT_W, OUT_H) },
  fx: { value: 1 },
  fy: { value: 1 },
  cx: { value: OUT_W / 2 },
  cy: { value: OUT_H / 2 },
  rangeM: { value: 0 },
  cropOn: { value: 1 },
  nearClip: { value: FRAMING_DEFAULTS.near },
  farClip: { value: FRAMING_DEFAULTS.far },
  cropL: { value: FRAMING_DEFAULTS.left },
  cropR: { value: FRAMING_DEFAULTS.right },
  cropB: { value: FRAMING_DEFAULTS.bottom },
  cropT: { value: FRAMING_DEFAULTS.top },
};

const quad = new FullScreenQuad(new THREE.ShaderMaterial({
  uniforms,
  vertexShader: KEY_VERTEX,
  fragmentShader: KEY_FRAGMENT,
  transparent: true,
  // The fragment writes premultiplied colour, so the blend has to expect it or the alpha is
  // applied a second time on the way into the framebuffer.
  premultipliedAlpha: true,
  depthTest: false,
  depthWrite: false,
}));

// What the operator's crop box is set to. `tilt` and `roll` are deliberately absent: the box is
// tested in sensor metres, before the levelling rotation, so turning the room does not move a face.
const faces = {
  crop: FRAMING_DEFAULTS.crop,
  near: FRAMING_DEFAULTS.near,
  far: FRAMING_DEFAULTS.far,
  left: FRAMING_DEFAULTS.left,
  right: FRAMING_DEFAULTS.right,
  bottom: FRAMING_DEFAULTS.bottom,
  top: FRAMING_DEFAULTS.top,
};

const CROP_UNIFORMS = {
  near: 'nearClip', far: 'farClip', left: 'cropL', right: 'cropR', bottom: 'cropB', top: 'cropT',
};

function writeFaces() {
  uniforms.cropOn.value = faces.crop ? 1 : 0;
  for (const name of CROP_FACE_NAMES) uniforms[CROP_UNIFORMS[name]].value = faces[name];
}

/**
 * The operator's registry, whole when a source says hello and one name at a time after that. Every
 * value is checked here rather than trusted, because a face holding NaN cuts nothing and a face
 * holding a string cuts everything.
 */
function readFaces(values) {
  if (typeof values !== 'object' || !values) return;
  if (typeof values.crop === 'boolean') faces.crop = values.crop;
  for (const name of CROP_FACE_NAMES) {
    if (Number.isFinite(values[name])) faces[name] = values[name];
  }
  writeFaces();
}

/** Null rather than a throw, so one torn picture does not take its sibling's decode with it. */
const bitmapOf = async (bytes) => {
  try {
    return await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }), {
      // The depth byte is a distance and not a colour, and the colour is passed through rather
      // than graded, so neither wants the display profile applied on the way in.
      colorSpaceConversion: 'none',
    });
  } catch {
    return null;
  }
};

function draw(pair, colour, depth) {
  if (colour) {
    colourTex.image = colour;
    colourTex.needsUpdate = true;
  }
  depthTex.image = depth;
  depthTex.needsUpdate = true;
  uniforms.imageSize.value.set(depth.width, depth.height);
  uniforms.fx.value = pair.fx;
  uniforms.fy.value = pair.fy;
  uniforms.cx.value = pair.cx;
  uniforms.cy.value = pair.cy;
  uniforms.rangeM.value = pair.rangeM;

  renderer.setRenderTarget(null);
  quad.render(renderer);
}

const stream = new KeyFrames({
  decode: bitmapOf,
  draw,
  clear: () => {
    renderer.setRenderTarget(null);
    renderer.clear();
  },
});

let attached = false;
let available = false;

function readText(text) {
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    stream.errors++;
    stream.reset();
    return;
  }
  if (typeof msg?.key?.available === 'boolean') {
    available = msg.key.available;
    if (!available) stream.reset();
  }
  if ((msg?.status && msg.status !== 'live') || msg?.camera?.color === false) {
    available = false;
    stream.reset();
  }
  if (msg?.key?.attached === true) {
    attached = true;
    return;
  }
  if (msg?.programOut) readFaces(msg.programOut.params);
}

function connect() {
  const ws = new WebSocket(`ws://${location.host}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    ws.send(JSON.stringify({ key: true }));
    // Asked for rather than waited for: OBS reconnects a browser source on its own schedule, and
    // the operator only volunteers its registry when somebody says hello.
    ws.send(JSON.stringify({ programOut: { hello: true } }));
  };

  ws.onmessage = (event) => {
    if (typeof event.data === 'string') {
      readText(event.data);
      return;
    }
    // Until the server has answered, this socket is still a monitor and the binary channel is
    // carrying depth frames, which are not pairs and would decode into nonsense.
    if (attached && available) stream.offer(new Uint8Array(event.data));
  };

  ws.onclose = () => {
    attached = false;
    available = false;
    stream.reset();
    setTimeout(connect, 1000);
  };

  ws.onerror = () => ws.close();
}

connect();

// What the proof tool reads, the way `__kinect` is published: getters and not values, so a handle
// taken at boot answers for the run rather than for the moment it was taken.
globalThis.__key = {
  faces: () => ({ ...faces }),
  get frames() { return stream.frames; },
  get size() { return { w: canvas.width, h: canvas.height }; },
  get lastDepthTs() { return stream.lastDepthTs; },
  get lastColourTs() { return stream.lastColourTs; },
  get errors() { return stream.errors; },
};
