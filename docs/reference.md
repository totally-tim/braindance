# Reference

Command line, controls, the five readings and presets. [README.md](../README.md) has the
usage path; this is the detail behind it.

## Command line

Options pass through to the grabber:

```bash
node server/index.js --pipeline cpu     # CPU depth instead of OpenCL
node server/index.js --no-color         # depth only, no colour stream
node server/index.js --port 9000
node server/index.js --record           # a flag, not a path - takes are named and
                                        # placed in captures/ by the recorder
node server/index.js --replay captures/session.knct
node server/index.js --host 0.0.0.0     # reachable from other machines - see below
```

**`--record` arms the *first* take rather than offering the recorder.** The flag is read
once at boot and spent when you stop that take; arming again is the record button. So
`npm run record` writes from the moment the server is up, and `npm start` is the one that
lets you decide when.

`--replay` loops a recorded capture, for iterating on shaders with the sensor unplugged. It
replays the *recorded* arrival spacing rather than a uniform 30fps: a degraded link runs
p50 64ms against p90 222ms, so even pacing would hand the viewer the one cadence that never
happens.

## Reaching it from another machine

**There is no authentication anywhere in this program**, so whoever can reach the port can
arm the recorder and start or stop a take. The server binds `127.0.0.1` unless you pass
`--host`, and says on stdout when it did.

Mutating routes and the WebSocket upgrade require a same-origin `Origin` and an address
rather than a hostname. The socket is included because `WebSocket` is exempt from the
same-origin policy and sends no preflight; the hostname half exists because comparing
`Origin` against `Host` was measured reaching every mutating route on the default loopback
bind through DNS rebinding. It stops hostile pages and nothing else: curl and other machines
on the Wi-Fi send no origin and are allowed everything. `tools/guard-check.mjs` proves both
halves, and [SECURITY.md](../SECURITY.md) has the threat model.

## Viewer and timeline controls

Drag to orbit, scroll to zoom, right-drag to pan, `H` hides the panel.

The ruler shows a *window* of the clip, because a fifteen-minute take across one screen puts
a keyframe against gradations forty times coarser than the thing being placed. Scroll to
zoom about the pointer, `+`/`-` about the playhead, `,`/`.` to pan, `F` to fit the clip, `Z`
to frame the trim. The overview underneath is always the whole clip: drag its box to pan, an
edge to zoom, click to go there.

**Glitch** tears horizontal bands of the feed sideways, and it is six controls rather than
one because the interesting looks live off the diagonal. `amount` is the master and the one
worth keyframing — it scales density and shove together, so corruption fades in and out on a
single track. `density` is what fraction of the bands tear at a full master and `shove m` is
how far one travels, in metres in the room: sparse-and-violent and dense-and-subtle are the
two ends those give you, and neither is reachable from a single slider. `flare` is the cyan
a torn band burns, per metre it was shoved, so a bigger tear lights harder on its own.
`band rows` is the height of a band in the sensor's own scanlines — 424 over that many bands,
so 35 at the default of 12 — and `rate hz` is how often the torn set is redrawn, where 0
freezes the pattern where it stands rather than switching it off.

The tear is applied in the sensor's frame before the camera sees it, so it is only
screen-horizontal from head-on: orbit around a torn band and it shoves in depth instead, and
a levelled room tears along the angle the mount was really at. That is the effect saying the
*volume* is corrupt rather than the picture, and it is why the group sits at the displacement
stage next to what moves points rather than in `Post` next to `scanlines`.

`turbulence` displaces points with a noise field. `near`/`far` is the most useful control
for isolating a person from the room. `cull speckle` drops points whose neighbours disagree,
cleaning up the sensor's edge noise (sigma ~= 3.5 + 1.3*d mm, so 4.6mm at 0.75m and 10mm at
4.25m). `render %` scales the drawing buffer and is the one control that reliably buys back
frame time, for the reason [rendering cost](performance.md#rendering-cost) gives.

Two controls decide how much white lands on the geometry, and they are the first to reach
for if the look is blown out. **`scan`** keys off distance rather than screen position, so
it crosses an angled surface as a drifting diagonal band; wide and hot it reads as a light
leak, so it is kept narrow and cyan. **`rim`** brightens depth discontinuities and gives the
subject its edge, but under additive blending plus bloom it washes broad surfaces white, so
turn it down before turning down bloom.

**The four Post terms share one pass, and the pass carries the tonemap.** `rgb split`,
`scanlines`, `grain` and `vignette` each switch it on, because a full-screen read and write
that changes nothing is worth skipping. What rides along with it is the highlight rolloff and
the black-toe crush, so a look with all four at zero is not the same image without four
effects: it also has lifted blacks and no rolloff, and additive accumulation clips to flat
white where it would otherwise keep its hue. Raising any one of the four brings the grade back.
The vignette used to be part of that bundle and is now its own control, which is why a project
saved before it existed loses its corner falloff until it names one.

## Levelling a canted mount

A sensor bolted to a dashboard shoots a room that arrives on its side, and nothing measures
the angle, since libfreenect2 exposes camera intrinsics and no accelerometer. `tilt` and
`roll` under Framing rotate the *room* rather than the camera, so the turntable's pole, the
top-down inset, auto-orbit's axis and the exported frame all come level together. Set them
by eye against the top-down, which is where a canted room reads as canted, and **Reset
rotation** zeroes both in one press. There is no third angle because yaw is what dragging on
the picture already does.

Crop faces and the region stay in sensor metres and are tested before the model matrix, so a
box shrunk onto a subject stays there when the room levels underneath it. `level-check`
holds that as a bit-identity.

**Show crop box** draws the six faces in the picture and in the top-down, and puts a handle
on each face you can drag with the pointer. It is a viewer control and writes nothing: the
drag itself writes, through the same registry door the sliders use, so a dragged face keys,
undoes and presets exactly as a typed one does. A face is offered a handle in a view that can
show it moving, which is why the top-down carries `left`, `right`, `near` and `far` and not
`bottom`/`top`, and why the far plane has no handle when you are looking straight down the
axis it moves along — turn the orbit and it appears. While the box is on screen the points it
cuts draw faintly rather than vanishing, so you can see what a face is about to remove and
drag it onto something deliberately. None of that reaches an exported frame or the OBS
output, which `export-check` asserts as byte-identity.

**`crop`** is whether the box bites, over all six faces at once, and it is a look value like
any other — it keys, it presets, and it exports what you see. It releases by not testing
rather than by moving the planes, so `near` and `far` still normalise the depth ramp while
the crop is off and the picture you get back is the room, not a re-grade of it. Use it to
check what a tight box removed without losing the numbers; **revert all to default** is the
other way back and throws them away. With the crop released the box draws dashed and grey.

## The five readings

Five readings of the take, split on the panel into what colours a point and what is then
made of it. Each is a weight from 0 to 1, so they mix.

| Reading | What it does |
| --- | --- |
| colour (source) | registered colour mapped onto the depth points |
| depth (source) | cool-to-warm ramp across the clip range |
| ghost (treatment) | luminance shell that glows along depth discontinuities |
| contour (treatment) | topographic bands sweeping through depth |
| blackwall (treatment) | crimson containment volume, cyan scan sweep, torn datastream bands |

![The five readings on one frame of one take: colour, depth, ghost and contour in a
grid, and Blackwall full width beneath them.](../media/shading-modes.png)

All five are the same frame from the same pose, each at its own brightness: the room was
shot unlit, so colour and contour read a signal the sensor barely produced while Blackwall
blends additively into bloom and blows out early.

**They are weights and not a mode.** The shader sums whichever are non-zero and divides by
the sum of the weights, so colour at 0.6 against depth at 0.4 is a 60/40 blend. Each is an
ordinary registry parameter, so each keyframes, and a single reading at 1.0 is arithmetically
the identity; `registry-check` hashes each reading's framebuffer against the mode it replaced.

Seven constants that were literals inside the old shader branch are registry parameters too,
so they keyframe: the colour's saturation, the depth ramp's gamma, the ghost shell's rim
exponent and fill, the contour's bands per metre and line thickness, and the Blackwall scan
speed. Each defaults to the literal it replaced.

**The duotone sits on top of all five**, beside `thermal` and `edges` and for their reason:
a term written into one reading is inert in every other. It is a tonal transform rather than
a tint, because its two poles carry luminance as well as hue — the near one runs toward black
and the far one toward hot, so one term gives both the depth-keyed palette and the near-black
figure against a burning core. A plain global toe cannot draw that second thing at all, since
it darkens near and far alike, which is why there is no separate silhouette control to look
for. `duotone depth` is how far the image lands between the poles, `duotone hue` turns both of
them together, and `duotone split` is the depth they meet at, as a fraction of the clip range
— so the crossover is a place in the room rather than a fraction of the frame. The pair itself
is baked, the way `heatRamp` and `depthRamp` are: what is parameterised is how you use them.

**The scanlines term is a raster now**, with three settings under it in a `Raster` group of
its own. `angle` turns it — at 0 it is the horizontal scanline it has always been, at 90 the
dense vertical column grille the reference frames slice a picture into — and because it keys,
a raster can rotate under the playhead. `pitch` is the line frequency, promoted from a literal
and defaulting to it. `hardness` squares the wave into a grille with dark gaps between the
lines, and it is the one that makes the other two worth having: an angle over a sine only ever
buys rotated softness, where the references are hard line grilles.

They are settings of `scanlines` rather than terms beside it, so only the master gates the
grade pass — raise the angle with the master at zero and nothing happens, which is deliberate,
since switching a full-screen pass on to draw nothing is the no-op the gate exists to refuse.
The angle is one parameter behind a two-component uniform, computed in double on the way
through for the reason `contourWidth`'s two band edges are: taking the sine in the shader is
allowed to be a couple of thousandths off, and a raster meant to run along y then leaks a
whisker of x.

`crush` is the toe under the grade's Reinhard curve, promoted from a literal and defaulting to
it. It is a sub-control of the grade pass rather than a fifth term gating it — raise it on its
own and nothing happens, because the pass only runs when the split, the scanlines, the grain
or the vignette asks for it. That asymmetry is deliberate: its default is not zero, so gating
on it would hold the pass open for every look there has ever been.

The panel is generated from the registry at boot. A parameter is one entry naming its group
and label, and the row, bounds, readout and keyframe control are built from that, so an
effect cannot get a control the registry does not own. The generator refuses to boot if the
rows it emitted are not the parameters that were declared.

## Presets

Selecting Blackwall used to apply twelve post-chain values with it. They are separate now: a
preset is look values and nothing else, so applying one never moves your camera.

A preset is `{ version, values }`, and the keys it names are its scope. Five ship read-only
from `presets-builtin/`, one per reading and marked `·` in the picker, with `blackwall.json`
carrying the twelve values the old mode wrote. A preset naming two values is equally valid,
and applying it leaves everything else where the grade left it.

Saving and exporting both ask which values go in, every box ticked, so a sparse preset takes
deliberate effort. The boxes derive from the registry, so a parameter added later appears
under its own heading by existing.

**The five reading weights tick and untick together.** A file naming any reading has to name
all five, because the ones it omits stay at whatever the clip was already wearing, and two
fifths of a blend renders as a mixture nobody authored. A file naming none of them is a look
that is not about the reading, which is fine. `format.js` refuses everything in between.

**A partial preset does not stamp the clip**, because the stamp answers "what look is this
clip wearing" and three of fifty-four values did not answer it. The two surfaces that report
an apply say which of the two happened.

**Saving over a shipped name forks it**: the write lands in your library and shadows the
built-in, and deleting the fork brings the shipped look back.

`export` writes the look on screen (not the document the picker names, which diverge the
moment you move a slider) as `<name>.braindance-preset.json`, and `import` reads one back.
The bytes are the document, so a look is something you can commit, mail, or edit in a text
editor.

An imported file is validated against the registry before it is saved: a scalar carrying a
string fails at the key that is wrong instead of writing a plausible-looking look, and
`__proto__` is refused as an unknown parameter. A file is the one door nothing upstream
validates, so `editor-check` section 12 drives the round trip in a browser, with
`import-skips-normalise` as the mutation that must break it.

Documents from before the readings are version 3 and will not open. The conversion is total
and lossless, so it is a one-shot over files:

```
node tools/convert-presets.mjs presets projects jobs
```
