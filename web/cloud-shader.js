// The core of the two programs a depth sample is drawn by, and the joints the installed effects
// are spliced into. What this file exports is source text in ordered segments, which
// `web/shader-assembly.js` joins to whatever the packages bring. Nothing here interpolates - a
// shader that needs a value from JavaScript takes it as a uniform - so the text below is exactly
// what the driver is handed.
//
// Every `uniform` in the assembled programs needs a key in the `uniforms` object in
// `web/point-cloud.js`, or three.js never writes it and the shader reads zero.
// `test/cloud-shader.test.mjs` asks that of the assembled text rather than of this file.

import { CROP_BOX_GLSL } from './crop-box.js';

// Each entry frozen as well as the list, because two callers share one object and a segment
// trimmed in place would move the look of one and the verdict of the other.
const frozen = (entries) => Object.freeze(entries.map((e) => Object.freeze(e)));

export const cloudSpine = Object.freeze({
  vertex: frozen([
    { text: /* glsl */ `\

precision highp float;
precision highp usampler2D;

uniform usampler2D depthPrev, depthCurr;
uniform sampler2D stateTex;
uniform vec2 focal, center, resolution;
uniform float bufferHeight;
// What this hardware will actually rasterise a point sprite at - a bound rather than a look
// value, so it is not a registry parameter. Written once at boot out of
// ALIASED_POINT_SIZE_RANGE, since the range is a property of the context and not of the window.
uniform float pointCeiling;
uniform float pointSize, nearClip, farClip, time, edgeTol;
uniform float cropL, cropR, cropB, cropT, cropOn, cropOutside;
uniform float noise, noiseScale, noiseSpeed;
uniform float lattice, latticeCell;
` },
    // The uniforms an effect declares for this stage. A package adds `uniform` lines here and
    // nothing else.
    { stage: 'v.decl' },
    { text: /* glsl */ `\
uniform vec3 regionCentre, regionHalf;
uniform float regionRound, regionSoft, regionPush, regionNoise, regionMask;
uniform float ripple, rippleFreq, rippleSpeed;
uniform float mixT, spanSec, snapDelta, glitch;
uniform float glitchDensity, glitchShove, glitchTint, glitchBands, glitchRate, glitchAxis;
uniform float fadeTime, wakeTime, sinceFrameSec;
uniform int denoise, interpolate;

in float aSlot;

out vec2 vUv;
out float vDepth;
out float vEdge;
out float vGlitch;
out float vSize;
out float vLegiblePx;
out float vGhost;
out float vFade;
out float vMask;
out float vSpeed;
` },
    // The channels an effect carries to the fragment stage, generated from the packages' own
    // `varyings` so this `out` and the `in` far below cannot come apart. `vCellNorm` is not one
    // of them: every additive fragment reads it whatever is installed, so it stays core.
    { varyings: 'out' },
    { text: /* glsl */ `\
out float vCellNorm;

float depthAt(usampler2D tex, ivec2 p) {
  return float(texelFetch(tex, p, 0).r);
}

float hash(float n) { return fract(sin(n) * 43758.5453123); }

// Three decorrelated hashes of one lattice corner, so a vector of noise costs one blend.
vec3 vhash3(vec3 p) {
  vec3 q = vec3(
    dot(p, vec3(127.1, 311.7, 74.7)),
    dot(p, vec3(269.5, 183.3, 246.1)),
    dot(p, vec3(113.5, 271.9, 124.6))
  );
  return fract(sin(q) * 43758.5453123);
}

// Value noise rather than gradient noise: eight hashes against twelve and a dot product, and
// the difference is a lattice-aligned bias that shows when you colour with it. Returns [-1, 1].
vec3 vnoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(vhash3(i + vec3(0.0, 0.0, 0.0)), vhash3(i + vec3(1.0, 0.0, 0.0)), u.x),
        mix(vhash3(i + vec3(0.0, 1.0, 0.0)), vhash3(i + vec3(1.0, 1.0, 0.0)), u.x), u.y),
    mix(mix(vhash3(i + vec3(0.0, 0.0, 1.0)), vhash3(i + vec3(1.0, 0.0, 1.0)), u.x),
        mix(vhash3(i + vec3(0.0, 1.0, 1.0)), vhash3(i + vec3(1.0, 1.0, 1.0)), u.x), u.y),
    u.z) * 2.0 - 1.0;
}

// One rounded box covers every shape the region needs - sphere, box, capsule, slab are all
// reached by moving continuous sliders, so each keyframes where a shape enum could not.
float sdRoundBox(vec3 p, vec3 b, float r) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}

// 1 inside the surface, ramping to 0 at regionSoft beyond it. Deep inside, the falloff width
// cannot matter, so a probe for regionSoft has to sit in the shell.
float regionWeight(vec3 p) {
  float sd = sdRoundBox(p - regionCentre, regionHalf, regionRound);
  return 1.0 - smoothstep(0.0, max(1e-4, regionSoft), sd);
}

// libfreenect2's pinhole model, with one deliberate departure from Registration::getPointXYZ.
// Image y grows downward, so it is flipped into the right-handed scene here, and x is negated
// because the frames arrive mirrored and upstream's formula does not undo it. cx is
// deliberately not rebased with it: the grid width cancels, so rebasing would double-count.
vec3 unproject(vec2 pixel, float z) {
  return vec3(
    -(pixel.x + 0.5 - center.x) / focal.x * z,
    -(pixel.y + 0.5 - center.y) / focal.y * z,
    -z
  );
}
` },
    // The crop box's two tests, spliced from `web/crop-box.js` rather than written here, so the
    // shader and the plan inset cannot come apart about which side of a face a point is on.
    { text: CROP_BOX_GLSL },
    // The blank line between them and `main` belongs to neither, so it is a segment of its own.
    { text: '\n' },
    { text: /* glsl */ `\
void main() {
  ivec2 px = ivec2(position.xy);

  // Age advances continuously between arrivals, so a 30fps stream still fades on
  // a 120Hz display instead of stepping once per frame.
  vec4 st = texelFetch(stateTex, px, 0);
  float age = st.g + sinceFrameSec;

  float z;
  vEdge = 0.0;
  vGhost = 0.0;
  vFade = 1.0;
  // Written before the branch rather than inside it: there are three early returns below this
  // line and a ghost branch that never touches either depth texture, and a varying written only
  // on the live path holds whatever the last invocation left in the register.
  vSpeed = 0.0;
  // The glyph field's three, initialised here under the same rule rather than where they are
  // computed. The identity each takes is the one that makes its consumer inert: seed and rain
  // at zero name the first character and the top of a drop, and the cell normalisation at one
  // is a multiply that changes no alpha.
` },
    // The same declarations again, each as the value that makes its consumer inert, under the
    // rule above: there are three early returns and a ghost branch between here and the writes.
    { varyings: 'init' },
    { text: /* glsl */ `\
  vCellNorm = 1.0;

  if (aSlot > 0.5) {
    // The ghost: what the ray used to be looking at. A hard swap earns a longer
    // wake than a soft one, which is what keeps a static scene from shedding.
    float life = fadeTime + wakeTime * st.b;
    if (st.r <= 0.0 || life <= 0.0 || age >= life) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    float k = 1.0 - age / life;
    vGhost = st.b;
    vFade = k * k; // eased so it thins out rather than stepping off
    z = st.r * 0.001;
    // vEdge stays 0: it drives the rim term, and a shed point burning at full rim
    // is the white blowout this look already had to be pulled back from once.
  } else {
    float mmC = depthAt(depthCurr, px);

    // Early-out before the neighbour fetches: a large share of the frame is empty,
    // and those pixels are culled regardless of what their neighbours say.
    if (mmC <= 0.0) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    // The same ray one frame ago, fetched here rather than inside the blend below because the
    // speed reads it too and would die silently the moment anybody turned interpolation off.
    float mmP = depthAt(depthPrev, px);

    // One discontinuity test, read by both. The samples either side of a depth edge are
    // different surfaces arriving on one ray, so lerping smears a point through empty space and
    // a speed measured across one is the distance to the wall behind. A zero sample means no
    // prior measurement on this ray, so a point just come into view has no speed.
    bool paired = mmP > 0.0 && abs(mmC - mmP) < snapDelta;

    float mm = mmC;
    if (interpolate == 1 && paired) mm = mix(mmP, mmC, mixT);

    // Axial speed in millimetres per second. The division by the pair's own gap is what makes
    // it a property of the room rather than of the link: a raw per-frame difference reads low
    // over a degraded link, so a look graded at 30fps would grade differently at 9.
    vSpeed = paired ? abs(mmC - mmP) / spanSec : 0.0;

    z = mm * 0.001;

    // Neighbour spread doubles as a speckle test and an edge signal: isolated points from
    // dropped USB packets have no depth-consistent neighbours.
    float maxDiff = 0.0;
    int valid = 0;
    for (int i = 0; i < 4; i++) {
      ivec2 o = i == 0 ? ivec2(1, 0) : i == 1 ? ivec2(-1, 0) : i == 2 ? ivec2(0, 1) : ivec2(0, -1);
      ivec2 q = clamp(px + o, ivec2(0), ivec2(resolution) - 1);
      float n = depthAt(depthCurr, q);
      if (n > 0.0) {
        valid++;
        maxDiff = max(maxDiff, abs(n - mmC));
      }
    }
    vEdge = clamp(maxDiff / edgeTol, 0.0, 1.0);

    bool speckle = denoise == 1 && (valid < 3 || maxDiff > edgeTol * 3.0);
    if (speckle) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }

    // Born points ramp in over the same window their predecessor fades out.
    vFade = fadeTime > 0.0 ? clamp(age / fadeTime, 0.0, 1.0) : 1.0;
  }

  // One question asked in two places: the depth pair is a property of the sample and is known
  // here, the lateral four are positions in the room and are not known until below. So
  // outsideCrop accumulates rather than being decided once. The early return is what keeps the
  // box free when nobody is looking at it - only a viewer with it on screen pays.
  bool outsideCrop = outsideDepthPair(z);
  if (outsideCrop && cropOutside <= 0.0) {
    gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    return;
  }

  vec3 pos = unproject(position.xy, z);

  // The other four faces of the same box, after the unprojection because a lateral plane is a
  // position in the room where the depth clip is a property of the sample. Metres, so a face
  // stays where it was put whatever the output size is. Tested on the undisplaced position.
  if (outsideLateral(pos.xy)) {
    if (cropOutside <= 0.0) {
      gl_Position = vec4(0.0, 0.0, 2.0, 1.0);
      gl_PointSize = 0.0;
      return;
    }
    outsideCrop = true;
  }

  // The region is read at the *undisplaced* position, so its boundary stays put when turbulence
  // is raised - read on the displaced one, a mask's edge crawls along itself as the noise rises.
  vec3 p0 = pos;
  // The gate names every effect that reads it, and a term added without joining the list is
  // inert rather than broken - the worse failure, because its slider still moves. The operators
  // are not uniform on purpose: regionPush and regionMask run from -1.
` },
    // The region weight, computed once for everything that reads it, under a gate that is the
    // consumers' own `when` clauses rather than a list kept here. This one opens no block, which
    // is the whole difference from `cell` below: its consumers are placed by name.
    {
      service: 'region',
      open: '  float rw = (',
      body: /* glsl */ `\
)
    ? regionWeight(p0)
    : 0.0;
`,
      close: '',
    },
    { text: /* glsl */ `\

  // Which cell of the room this point belongs to, and where it stands in the falling pattern.
  // Both read at the *undisplaced* position, so a character's identity is a fact about the room
  // and turbulence pushes points through a field of characters that stay where they are. The
  // grid is the lattice's own: a second cell size would be two world quantisers in one shader.
` },
    // Which cell of the room this point fell in, computed once for everything keying on the
    // lattice's grid. The gate is generated from every consumer's `when`, so a build with
    // neither consumer pays no mat3 multiply and no hashes.
    {
      service: 'cell',
      open: '  if (',
      body: /* glsl */ `\
) {
    vec3 room = mat3(modelMatrix) * p0;
    vec3 wc = floor(room / latticeCell + 0.5);
`,
      close: '  }\n',
    },
    // The blank line between the cell's block and the displacement run belongs to neither, so it
    // is a segment of its own rather than the tail of one joint or the head of the next.
    { text: '\n' },
    // The displacements the region weight drives, in the order the file held them. Two stages
    // and not one, because the mask slot stands in the middle of the run and a joint cannot be
    // spliced into the middle of a stage.
    { stage: 'v.regionDisplace' },
    // How much of this point the region hides - a replacement, because the mask and the crop's
    // dimming are one multiply on one varying. The only fallback here carrying text no build has
    // drawn: vMask is read unconditionally below, so an uninstalled mask still has to write it.
    {
      slot: 'v.mask',
      fallback: /* glsl */ `\
  vMask = outsideCrop ? cropOutside : 1.0;

`,
    },
    // The displacements an effect adds after the mask has read the region weight. A stage
    // because these compose and their order is the whole of what they mean: the lattice
    // quantises wherever the tear left the point.
    { stage: 'v.displace' },
    { text: /* glsl */ `\
  vUv = (position.xy + 0.5) / resolution;
  vDepth = z;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;

  // Every screen-space term in this renderer is defined against a 1080p reference and scales
  // with the drawing buffer, and this is the dominant one. The clamp stays in framebuffer
  // pixels deliberately: it is a bound on what the hardware can draw, not a look value.
  float k = bufferHeight / 1080.0;
  // How big one lattice cell is on screen at this distance, in the reference pixels vSize is
  // carried in, derived from the projection because the fov is part of the camera pose and
  // keyframes. max(0.15, -mv.z) is written out again below rather than hoisted into the clamp:
  // that clamp's exact text is what export-check's pointsize-absolute anchors on.
  float dist = max(0.15, -mv.z);
  float cellPx = latticeCell * projectionMatrix[1][1] * 540.0 / dist;
` },
    // How big the sprite is drawn - a replacement, since an effect growing the sprite has to
    // stand where the clamp stood. The fallback is that clamp exactly as it was written.
    {
      slot: 'v.pointSize',
      fallback: /* glsl */ `\
  gl_PointSize = clamp(pointSize * k / max(0.15, -mv.z), 1.0, 64.0);
`,
    },
    { text: /* glsl */ `\
  // Carried in reference pixels rather than framebuffer ones, because the fragment shader
  // normalises additive energy against area and the same look must not sum brighter at twice
  // the resolution.
  vSize = gl_PointSize / k;

` },
    // What a displacement does to a splat's additive energy, cancelled where the view distance
    // is known. The empty fallback leaves the 1.0 written above the early returns standing,
    // which is exactly the value that makes the multiply inert.
    { slot: 'v.cellNorm', fallback: '' },
    { text: /* glsl */ `\
  // Cut-away points draw at half the size, and this has to come after vSize or it undoes the
  // dimming it is meant to help: the fragment stage divides alpha by vSize squared, so a point
  // reported at half size gets four times the alpha back. Shrinking the sprite rather than only
  // the alpha is what makes it scaffolding - depthWrite is on, so a faint point still occludes.
  if (outsideCrop) gl_PointSize *= 0.5;

  // The size the legibility crossfade reads, and it is the lesser of two readings rather than
  // either one: dividing by max(k, 1) gives the drawn sprite below 1080 and that sprite back in
  // reference pixels above it. Neither half alone is correct - in reference pixels the fallback
  // inverts at small buffers, and in framebuffer pixels the boundary between text and texture
  // moves with output size. A cut-away point reports none at all, so it draws the round mask.
  vLegiblePx = outsideCrop ? 0.0 : gl_PointSize / max(k, 1.0);
}
` },
  ]),
  fragment: frozen([
    { text: /* glsl */ `\

precision highp float;

uniform sampler2D colorPrev, colorCurr;
uniform float opacity, exposure, nearClip, farClip, mixT, time;
uniform float rimAmount, thermal, edges;
uniform float duotoneDepth, duotoneHue, duotoneSplit, duotoneSpan, duotoneMotion;
uniform float readRgb, readDepth;
uniform float rgbSaturation, depthGamma;
` },
    // The uniforms an effect declares for this stage. A term is declared in both stages when
    // both read it, which is why the glyph field's master appears here as well.
    { stage: 'f.decl' },
    { text: /* glsl */ `\
uniform int hasColor, softEdge;

in vec2 vUv;
in float vDepth;
in float vEdge;
in float vGlitch;
in float vSize;
in float vLegiblePx;
in float vGhost;
in float vFade;
in float vMask;
in float vSpeed;
` },
    // The far end of the channels the vertex stage declared, in the same order.
    { varyings: 'in' },
    { text: /* glsl */ `\
in float vCellNorm;

out vec4 fragColor;

` },
    // Whatever an effect needs at file scope. Above the ramps, because GLSL wants a helper
    // declared before the function that calls it.
    { stage: 'f.helpers' },
    { text: /* glsl */ `\
// Black through red and orange to white, deliberately not depthRamp's cool-to-warm palette, so
// that thermal over the depth reading is a second reading and not the same one twice.
vec3 heatRamp(float t) {
  vec3 a = vec3(0.02, 0.01, 0.06);
  vec3 b = vec3(0.55, 0.05, 0.28);
  vec3 c = vec3(0.98, 0.42, 0.05);
  vec3 d = vec3(1.00, 0.98, 0.86);
  return t < 0.33 ? mix(a, b, t / 0.33)
       : t < 0.66 ? mix(b, c, (t - 0.33) / 0.33)
                  : mix(c, d, (t - 0.66) / 0.34);
}

// Smooth cool-to-warm ramp; reads as depth without the banding of a hard palette.
vec3 depthRamp(float t) {
  vec3 a = vec3(0.06, 0.10, 0.28);
  vec3 b = vec3(0.15, 0.72, 0.78);
  vec3 c = vec3(0.98, 0.78, 0.32);
  vec3 d = vec3(0.96, 0.29, 0.42);
  return t < 0.33 ? mix(a, b, t / 0.33)
       : t < 0.66 ? mix(b, c, (t - 0.33) / 0.33)
                  : mix(c, d, (t - 0.66) / 0.34);
}

// Turning both duotone poles by one angle, as a rotation about the grey axis. Rodrigues rather
// than a trip through HSV, which rebuilds the value and hands a nearly black pole back lifted.
vec3 hueSpin(vec3 c, float a) {
  const vec3 axis = vec3(0.5773502691896258);
  float ca = cos(a), sa = sin(a);
  return c * ca + cross(axis, c) * sa + axis * dot(axis, c) * (1.0 - ca);
}

void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r2 = dot(d, d);

` },
    // What shape the mark is - a replacement, since a second disc test beside the first would
    // be two answers to one question. The fallback is the text that shipped.
    {
      slot: 'f.mark',
      fallback: /* glsl */ `\
  // Additive mode shapes the sprite purely with alpha falloff. Skipping the
  // discard keeps Apple's tile-based hidden-surface removal working.
  float falloff;
  if (softEdge == 1) {
    falloff = exp(-r2 * 9.0);
  } else {
    if (r2 > 0.25) discard;
    falloff = smoothstep(0.25, 0.02, r2);
  }

`,
    },
    { text: /* glsl */ `\
  float t = clamp((vDepth - nearClip) / max(0.001, farClip - nearClip), 0.0, 1.0);
  vec3 rgb = hasColor == 1
    ? mix(texture(colorPrev, vUv).rgb, texture(colorCurr, vUv).rgb, mixT)
    : vec3(0.7);

  // Saturation on the camera image, at the source rather than after the blend, because it is
  // the colour reading's own control. Guarded so the default is exact: an unguarded mix at 1.0
  // contracts into a multiply-add and would move the pixels of every look ever authored.
  if (rgbSaturation != 1.0) {
    float rgbLum = dot(rgb, vec3(0.299, 0.587, 0.114));
    rgb = mix(vec3(rgbLum), rgb, rgbSaturation);
  }
  // The five readings, summed by weight rather than selected by an integer, with colour and
  // alpha accumulated separately because they do not combine the same way. Normalise-by-sum
  // rather than a chain of mix(), so a single reading at 1.0 comes out exactly itself. Each
  // block is guarded on its own weight, which is a cost decision on a uniform branch.
  vec3 col = vec3(0.0);
  float alphaFactor = 0.0;
  float readSum = 0.0;

  if (readRgb > 0.0) {
    col += rgb * readRgb;
    alphaFactor += readRgb;
    readSum += readRgb;
  }

  if (readDepth > 0.0) {
    // The gamma bends where the ramp's colours sit inside the clip range rather than moving its
    // ends. The default path has to *be* the old line rather than compute what it computed:
    // pow(x, 1.0) is not the arithmetic identity on this GPU, and a value handed through a
    // variable loses a contraction the inline expression gets. Both were measured.
    if (depthGamma == 1.0) {
      col += depthRamp(1.0 - t) * readDepth;
    } else {
      col += depthRamp(pow(1.0 - t, depthGamma)) * readDepth;
    }
    alphaFactor += readDepth;
    readSum += readDepth;
  }

` },
    // The reading effects: ghost, contour, blackwall. Each contributes to col,
    // alphaFactor, and readSum the same way the RGB and Depth readings above do.
    // Ordered by visual weight: ghost at 100, contour at 200, blackwall at 300.
    { stage: 'f.reading' },
    { text: /* glsl */ `\
  // Every weight at zero draws nothing. Guard only the division so alpha carries the
  // emptiness out instead of a NaN doing it.
  float norm = readSum > 0.0 ? 1.0 / readSum : 0.0;
  col *= norm;
  float alpha = opacity * alphaFactor * norm;

  // These sit after the blend rather than inside a reading: a term written into one reading is
  // inert in every other, and is then only exercised by a sweep arm that selects that reading.
` },
    // A term over the colour the readings produced. A stage rather than a slot because these
    // compose, and two effects lifting the same colour is two multiplies. The GLSL comment
    // above it is the stage's own reason and stays in the spine rather than travelling with a
    // chunk. The declared order disagrees with the order the directory hands the packages over.
    { stage: 'f.tone' },
    // What the mark actually draws. It reads the colour above it, which is the one key that
    // cannot be decided in the vertex stage.
    { slot: 'f.glyph', fallback: '' },
    { text: /* glsl */ `\
  // Cross-fade. A dying point thins out where it stood instead of blinking off,
  // and its replacement comes up over the same window.
  alpha *= vFade;
  // The region's soft mask, which is a fade rather than a cull precisely so its edge
  // can be soft - a vertex-stage discard could only ever give a hard boundary.
  alpha *= vMask;
  // Ghosts sit under the live cloud so they read as afterglow, never as surface.
  if (vGhost > 0.0) alpha *= 0.5;

  // Additive contributions sum and near points get both larger sprites and more overlap, so a
  // splat's energy is normalised against its area. 116.64 is 36 * 1.8^2, forced by the unit
  // change rather than chosen. vCellNorm is the lattice's half of the same idea.
  if (softEdge == 1) alpha *= min(116.64 / (vSize * vSize), 1.0) * vCellNorm;

  // A fragment carrying no colour still writes depth: the hard-edged path draws with depthWrite
  // on and no alphaTest, so a zero-alpha fragment is invisible in colour and solid in depth.
  // Three ways one arrives at exactly zero - an off bit of a character, a point born this
  // frame, the disc's own rim - so the condition is the product rather than three cases. The
  // additive branch takes no discard at all, which is what keeps Apple's tile-based HSR working.
  if (softEdge == 0 && alpha * falloff <= 0.0) discard;
  fragColor = vec4(col * exposure, alpha * falloff);
}
` },
  ]),
});
