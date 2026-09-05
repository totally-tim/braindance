# Reference

The command line, the controls, the readings, the presets, the queue and the effect store.
[README.md](../README.md) walks the path from a take to a video; this page is the detail
behind each step.

## Command line

The server is `node server/index.js`, and every flag is optional. Paths default relative to
the checkout.

| Flag | Default | What it does |
| --- | --- | --- |
| `--port N` | `8080` | The port to listen on. |
| `--host ADDR` | `127.0.0.1` | The address to bind. A non-loopback address makes the server reachable from other machines; `::1` stays loopback. |
| `--record` | off | Arms the first take at boot. |
| `--replay PATH` | none | Loops a recorded capture instead of reading a sensor. |
| `--pipeline NAME` | the grabber's own pick | Depth processor: `gl`, `cl` or `cpu`. Handed to the grabber. |
| `--no-color` | colour on | Depth only. Handed to the grabber. |
| `--grabber "BIN ARGS"` | none | The grabber binary and its own arguments, as one space-separated string. |
| `--captures DIR` | `captures/` | Where takes are recorded and read back. |
| `--projects DIR` | `projects/` | Where project documents live. |
| `--presets DIR` | `presets/` | The writable preset library. |
| `--builtin-presets DIR` | `presets-builtin/` | The read-only preset library the build ships. |
| `--effects DIR` | `effects/` | The writable effect root an install lands in. |
| `--builtin-effects DIR` | `effects-builtin/` | The effect root the build ships. |
| `--deliverables DIR` | `deliverables/` beside the captures directory | Where saved export settings live. |
| `--jobs DIR` | `jobs/` | The render queue's records. |
| `--node URL` | none | A capture node this instance links to, so its takes appear in the library here. |
| `--node-name NAME` | `node` | The label that node is listed under. |
| `--name NAME` | `mac` when `--node` is given, else `node` | The name this instance reports as. |
| `--reveal-with PROG` | the platform file manager | The program `POST /library/reveal/:id` starts. |

**The two effect roots are the fork mechanism.** Nothing writes into `--builtin-effects`, an
install lands in `--effects`, and an id present in both resolves from there. A server whose
builtin root is missing refuses to boot, so a broken install cannot read as nothing installed.

**`--record` arms the first take and is then spent**, so stopping that take gives the recorder
back its button. `--replay` loops a recorded capture with no sensor attached, replaying the
arrival spacing the capture was recorded at, which on a degraded link is uneven.

### Grabber flags

`--pipeline` and `--no-color` are read by the server and handed on. Every other grabber flag
rides inside the `--grabber` string.

| Flag | Default | What it does |
| --- | --- | --- |
| `--quality N` | `80` | JPEG quality, 1 to 100, for the colour stream. |
| `--log LEVEL` | `warning` | `none`, `error`, `warning`, `info` or `debug`. `debug` adds libfreenect2's per-packet USB diagnostics. |
| `--min-depth M` | `0.05` | Nearest depth in metres that reaches a frame. |
| `--max-depth M` | `9.0` | Furthest depth in metres that reaches a frame. |
| `--no-low-light` | low light on | Turns off the low-light exposure mode. |
| `--profile` | off | One CSV row per frame on stderr at exit, timing the serial half of the frame loop. |
| `--dump-corpus DIR` | none | Writes registration inputs for the comparison corpus. |
| `--dump-count N` | `24` | How many frames that dump holds. |
| `--help` | | Prints the usage, the pipelines this build offers and the stdin commands, then exits. |
| `--dump-every N` | `10` | Dumps every Nth frame. |

**`--min-depth` and `--max-depth` decide what exists.** They clip on the GPU before a frame is
built, so a point outside them is never recorded. The viewer's own `near` and `far` only hide
points that already arrived, so putting a preview range on the grabber flags destroys footage.

## Reaching it from another machine

There is no authentication anywhere in this program. Whoever reaches the port can arm the
recorder, start and stop a take, write documents and install effects. The server binds
`127.0.0.1` unless you pass `--host`, and prints on stdout what it bound.

Three checks stand between a page you merely visit and a route that changes something. A
request that fails one is refused before its body is read.

| Check | Refusal |
| --- | --- |
| `Origin`, when the caller sends one, matches `Host`, and `Host` is an address, `localhost` or a `.local` name | 403 |
| The method is one the route declares | 405, with an `Allow` header |
| The request declares `application/json` | 415 |

The WebSocket upgrade goes through the same origin check on both its paths, `/` for the frame
stream and `/export` for a running render. A caller sending no `Origin` is not a browser and
is allowed everything, so `curl` and other machines on the network are unrestricted.
[SECURITY.md](../SECURITY.md) carries the threat model.

## Viewer and timeline controls

| Gesture | What it does |
| --- | --- |
| Left-drag on the picture | Orbits about the pivot. |
| Right-drag on the picture | Pans the camera. |
| Wheel over the picture | Dollies in and out. |
| Shift-drag on the picture | Turns the view in place, without moving the camera. |
| Shift-wheel over the picture | Changes the lens, bounded by 8mm and 300mm. |
| Left-press on the picture | Moves the orbit pivot to the depth under the pointer. |
| Drag a crop face handle | Writes that face, through the door the sliders use. |
| Drag a clip box on the strip | Moves the clip in program time. |
| Drag either edge of a clip box | Trims that end. |
| Wheel over the ruler | Zooms the ruler window about the pointer. |
| Drag the overview box | Pans the ruler window. |
| Click the overview | Centres the ruler window on that point, keeping its width. |
| Drag on the ruler | Scrubs, drawing draft frames, and seeks for real on release. |
| Drag a cut marker | Moves the in-point or the out-point. |
| Horizontal wheel over the ruler or overview | Pans the ruler window. |
| Double-click a key in a lane | Deletes it. |
| Drag the grip above the transport | Changes how much height the lanes get. |

| Key | What it does |
| --- | --- |
| `space` | Plays and pauses. |
| `←` `→` | Steps one output frame, or one second with shift. |
| `home` `end` | Goes to the in-point and the out-point. |
| `i` `o` | Sets the trim at the playhead. With shift, jumps to it. |
| `option-x` | Restores the whole clip. |
| `del` `backspace` | Removes the selected mark, else the selected key, else the selected clip. |
| `m` | Plants a mark at the playhead, or takes away the one already there. |
| `[` `]` | Goes to the previous and next mark. |
| `+` `=` `-` `_` | Zooms the ruler about the playhead. |
| `,` `.` | Pans the ruler. |
| `f` | Fits the ruler to the clip. |
| `g` | Cycles the selected clip's move and turn handles. |
| `h` | Hides the panel. |
| `?` | Says this list. |
| `cmd-z` `ctrl-z` | Undoes. |
| `cmd-o` `ctrl-o` | Goes to the projects page. |
| `cmd-e` `ctrl-e` | Opens the export dialog. |
| `r` `m` | Starts or stops a take, and marks a running one, on the record surface. |
| `esc` | Closes an open menu, or the effect picker. |
| shift and `w` `a` `s` `d` | Flies the camera. |
| shift and `q` `e` | Takes the camera down and up. |
| up, down, page up, page down, home, end | Move the focused lane splitter: one lane row, four rows, or to either bound. |

**Shift is the free camera's modifier**, and without it the six flight keys do nothing. `w`
follows the view direction, and `q` and `e` follow the current navigation vertical: the
levelled room in the normal view, the sensor's own vertical in sensor view. Flying carries the
orbit pivot with the camera.

**A focused text field keeps the whole keyboard**, and gaining text focus releases any flight
keys being held. Sliders, dropdowns and other non-text inputs keep only the arrows, space,
enter, home, end and the page keys, so a focused slider still nudges with the arrows while
shift-`w` flies and `cmd-z` undoes.

**A shift-drag turns the view the way you drag it**, which is the opposite of an orbit: drag
right and the view turns right, so the scene sweeps left. A drag the height of the stage turns
the view by one field of view, so a longer lens turns through a smaller angle. The camera does
not move, so letting go of shift orbits whatever you are now looking at.

**The orbit turns about whatever you pressed on.** A left press moves the pivot along the view
axis to the depth under the pointer, and a press on the background, on a hole in the returns
or on geometry outside the crop box leaves the pivot where it was. The pick reads the depth
frame, so it lands on the surface really under the pointer even
with the displacement effects or the datamosh up.

**The ruler shows a window of the clip**, and the overview underneath is always the whole clip.

**A seek whose pre-roll was cut short says so on the strip**, once per distinct cap, and the
message carries the arithmetic: how many frames short it was, which take held the window down,
how many clips are cut on that take, how many frames they asked its cache for between them,
and what that cache holds. A seek short for any other reason names the shortfall and the
pre-roll it had computed. `reportCappedSeek` in [`web/main.js`](../web/main.js) writes both.

### Menus

| Menu | Item | What it does |
| --- | --- | --- |
| File | Open | Goes to the projects page. |
| File | Rename project… | Opens a modal and renames the document. |
| File | Duplicate project | Stamps a copy and leaves you editing the copy. |
| File | Project settings… | The shape the stage is letterboxed to and the rate frames come out at. |
| Output | Whole clip | Restores the trim to `{ in: 0, out: null }`. |
| Output | Export | Opens the export dialog. |
| Output | Output to OBS | The two OBS addresses, with a copy button on each. |
| View | Default camera position | Goes to the home pose. |
| View | Show top view | Toggles the top-down inset. |
| View | Show sidebar | Toggles the panel. |
| View | Import Look, Export Look | Reads and writes a preset file. |
| View | Stats for nerds | Toggles the readouts over the picture. |

### Transport and clip controls

| Control | What it does |
| --- | --- |
| play | Plays and pauses. |
| playback, source | The playhead in program seconds and in the selected clip's source seconds. |
| mark | Plants a mark at the playhead, or takes away the one already there. |
| speed | The selected clip's rate, 0.1x to 4x. The travel is logarithmic, with a detent at 1.00x. |
| clip: `delete clip`, `move`, `rotate`, `key` | Removes the selected clip, arms its move or turn handles in the viewport, and keyframes its placement at the playhead. |
| `+` below the last clip row | Opens the media library's takes. |
| camera: eye, diamond | Looks through the program camera, and keyframes it at the playhead. |
| Camera tab: `add key`, `delete key` | Writes a camera key at the playhead, and removes the one under it. |
| loop | Plays the trimmed range round instead of stopping at its end. Off whenever the editor opens. |

**`move` and `rotate` put handles on the selected clip in the viewport**, and `g` cycles the
two. A clip carries a position and a rotation in the room and nothing else. While the handles
have the pointer the orbit stands down, and an export detaches their hit target as well as
hiding them. Once a placement track has keys a handle drag writes one at the playhead, and
`key` plants the first. Placement keys are measured from the clip's own in-point, so dragging
the clip along the strip carries its move with it.

**Marks are keyed by the take and drawn against the selected clip**, so two clips of one take
share them. Where a mark ticks is that source second put back through the selected clip's
`sourceStart`, `speed` and placement, which is why the same mark sits somewhere else under the
other clip. "Already at the playhead" means within half an output frame.

### Key options

The `key options` chip shapes the segments either side of the selected key, and the handles in
the lane reach anything in between.

| Button | What it does |
| --- | --- |
| `<` `>` | Goes to the previous and next key on this parameter. |
| `lin` | Straight segments either side. |
| `in`, `out` | Eases the incoming side and the outgoing side. They are two separate numbers. |
| `smooth` | Brings the rate to zero at the key, cubic. |
| `glide` | Brings the rate and the acceleration to zero at the key, quintic. |
| `hold` | Holds the value across the segment, which flattens both of its ends. |
| `ends` | Glides the track's first departure and last arrival, leaving every key between them alone. Press it from anywhere on the track. |
| `−pt`, `+pt` | Removes and adds a control point on this key's handles, up to four a side. |
| `delete` | Deletes the selected key. |

**`ends` is the one to reach for on a camera.** An unshaped move departs the first key and
arrives at the last with a step in speed where you want a ramp. `smooth` on an interior key
brings the camera to a near halt as it passes, which is what a deliberate pause wants and not
what easing a whole move wants. `+pt` leaves the curve exactly where it was; `−pt` moves the
shape, because a curve of one degree is not generally a curve of the degree below.

Easing remaps the traversal and moves no key, so the camera's route through the world does not
change. The beads on the path in the viewport are sampled at equal intervals of program time,
so they bunch where the camera is slow.

### The lens row

The `lens` row on the Camera tab says what the camera's `fov` says, in the millimetres a lens
is sold under: a 35mm equivalent against the full-frame gate, measured against the project's
aspect, so resizing the browser leaves the number where it was. The
camera opens on 22.7mm at 16:9 and sensor view lands near 18mm. The row offers 8mm to 300mm
and says which way it ran out past either end, though the angle itself is never clamped. Under
**set viewport to camera** the row reads the shot and goes inert.
`verticalFovForFocalLength` and `focalLengthForVerticalFov` in
[`web/lens.js`](../web/lens.js) are the conversion.

Point sizes use the camera's 50-degree boot lens as their reference. A longer lens magnifies
the splats with the scene, preserving surface brightness while the points stay within their
size bounds. `lensReference` in [`web/cloud-shader.js`](../web/cloud-shader.js) sets the reference;
sensor view receives the same correction through the take's intrinsics.

The one-pixel floor and ordinary points' 64-pixel ceiling still limit the sprites. Their onset
depends on point size, depth and output size. Bloom, vignette and the glyph legibility band
also remain screen-space effects, so brightness can still change and dust can become characters
through a longer lens. Existing shots at other lenses change appearance.

## The edit, and what comes out of it

**Clips are the rows at the head of the lane stack**, one box each from where a clip starts to
where it ends. An edit holds between one and eight. The full-width `+` below the last row
opens the media library's takes, and the take you choose lands at the playhead on a row of its
own, copying the selected clip's look or, with no selection, the first clip's.

**The two edges do different things.** The right edge moves where the edit stops using the
take, which is the clip's own `length`. The left edge is a head trim: the clip starts later in
the take, its out-point stays where it is, and the footage under what is left does not move,
so the same project second stands on the same source frame afterwards. That in-point is the
clip's `sourceStart`. A trim writes no keyframe and touches no lane.

**Which clip is selected is the session's and not the document's.** It decides what the panel
writes to and which clip the ruler's marks are drawn against. Opening a take selects its clip;
loading a project selects nothing; pressing the empty part of the lane stack clears the
selection, and the panel then greys its clip half out. The rows under `points`, `framing`,
`colour` and the rest write one clip's cloud, while `post`, `motion`'s trails and the rest of
the grade write the project, so every clip is seen through them. A clip's keyed parameters
nest under its row and fold with it, and the project's curves stay at the foot of the stack.

**Nothing saves the edit, because it saves itself.** Every change that lands on the undo stack
is written to the project's file, so there is no save entry and no shortcut for one. Deleting
a project is on the projects page, since autosave here would write the file straight back.

**Shape and rate live in Project settings; resolution, format and output name live on a
deliverable.** The camera was keyed against a frame, so reopening a 65:24 shot at 16:9 would
be a different shot with the same keys, and the resolution menu therefore offers only sizes of
the project's shape. Two sizes of one shape are the same picture, because every screen-space
term is expressed against 1080p. A project stores the shape as the reduced integer pair, so
"1.90:1 DCI" is `[256, 135]`, which is exact where 1.8963 is 0.2% off.

Project settings offers 24, 30, 60 and 120 frames a second.

| Shape | Sizes |
| --- | --- |
| 16:9 | 960x540, 1280x720, 1920x1080, 3840x2160 |
| 1.90:1 DCI | 2048x1080, 4096x2160 |
| 4:3 | 1440x1080, 2880x2160 |
| 1:1 | 1080x1080, 2160x2160 |
| 65:24 | 2730x1008, 3900x1440 |

| Format | `codec` | File | What it is for |
| --- | --- | --- | --- |
| MP4 | `h264` | `.mp4` | h264 at crf 18, the one to send someone. Even dimensions only. |
| MOV | `prores` | `.mov` | ProRes 422 HQ, 10-bit 4:2:2, for an editor who will grade the shot. |
| PNG sequence | `pngseq` | a directory of `.png` | The frames themselves, for a compositor. |
| — | `lossless` | `.mkv` | FFV1 at rgb24. The export dialog does not offer it; name the codec through `POST /jobs` or the `/export` socket. |

The render runs in the page, frame by frame through the program camera, pushing frames to
ffmpeg over a socket. Each render gets its own directory under `exports/` holding the artifact
and a `.job.json` sidecar, so nothing is overwritten. **save a copy…** puts the file anywhere
through the browser's file picker.

### A clip that needs an effect this build has not got

A look parameter is named after the effect it belongs to, like `rain.speed`, and a document
lists the effects it is built from. Open a clip whose list names one this machine does not
have and the clip opens: the installed part renders, and the values and keys under the missing
effect are parked, meaning carried and never evaluated. Saving writes every parked key back
holding the value it arrived with, though the document's revision still moves.

Only a whole absent effect is parked. A name this build does not know at all is refused, and
so is a name whose effect is here with a key that is not, or a document naming an effect
through a keyframe track while carrying none of its values.

The application bar says so while such a clip is open, one entry per missing effect:
`missing: rain 1.0.0 — 4 values, 2 tracks parked`. Beside each entry is a **suppress** toggle.
An effect that is here at another version gets a line and nothing else, like
`document requires glyph 1.0.0, installed is 2.0.0`; the clip loads, the installed version
draws it, and the next save records the version this machine actually built with.

**Export is refused while anything the clip needs is missing**, and the refusal names the
effects and their versions. **suppress** says this render may go without that effect. It is
per effect, so suppressing one while another is still missing leaves the export refused. It is
session state and per document: opening another project ends every suppression, and an undo
keeps it. The render's `.job.json` carries a `suppressed` list of what it went without.

## The record surface and OBS

The record surface shares the viewer and its camera, and adds what the sensor and the monitor
are doing. `r` starts and stops a take and `m` marks a running one.

| Control | What it does |
| --- | --- |
| record | Starts a take, and stops the one running. |
| mark | Marks the running take at the moment you press. |
| colour camera | Whether the colour stream runs at all. With it off, exposure means nothing and the control says so. |
| low light | The sensor's low-light exposure mode. |
| Monitor: depth ÷ | Sends every Nth depth sample, 1 to 16, so a thin link still shows a picture. |
| Monitor: every Nth | Sends one frame in N, 1 to 30. |
| Monitor: allow cost | Consents to a monitor setting finer than the recording cap. The Record button does not carry that consent, so a costly monitor still refuses to arm. |

**A monitor decimates what this browser is shown and never what the take records.** Going into
a recording, a monitor finer than a divisor of 4 or a stride of 3 is refused at the record
boundary, because a finer monitor costs the take; coarser settings pass. A monitor
on loopback is exempt, since it costs the link nothing. A running stream is never capped
mid-take.

**Output > Output to OBS** carries the two source URLs and the settings behind them.

| Control | What it does |
| --- | --- |
| Camera: Program, Viewport | Whether the browser source renders the program camera or the viewport you are looking through. |
| Resolution | 1920x1080, 1280x720, 3840x2160, or `custom…`. |
| Custom output size | A `WxH` pair, revealed by `custom…`. |
| Browser source, copy | The program-out URL for an OBS browser source. |
| Webcam source, copy | The colour camera's own 1080p frame, at `/camera.mjpg`. |
| open source | Opens the browser source in a tab. |

The dialog also says how many webcam sources are attached right now. It counts `/camera.mjpg`
subscribers only, so a browser source on `/program` does not show there.

## Levelling a canted mount

A sensor bolted to a dashboard shoots a room that arrives on its side, and nothing measures
the angle, because libfreenect2 exposes camera intrinsics and no accelerometer.

| Control | What it does |
| --- | --- |
| `tilt` | Turns the room about its horizontal axis, -90 to 90 degrees. |
| `roll` | Turns the room about the view axis, -180 to 180 degrees. |
| `reset rotation` | Zeroes both in one press. |
| `sensor view` | Puts the camera where the Kinect is, looking the way the Kinect looks. |
| `show crop box` | Draws the six crop faces in the picture and the top-down, with a handle on each. |
| `fit box to take` | Shrinks the box onto what the take holds. Editor only. |
| `crop` | Whether the box bites, over all six faces at once. |
| `left`, `right`, `bottom`, `top` | The four side faces, in sensor metres. |
| `near`, `far` | The depth range, which both crops and normalises the depth ramp. |
| `revert all to default` | Throws away every framing value on the tab. |

`tilt` and `roll` rotate the room, so the turntable's pole, the
top-down inset, auto-orbit's axis and the exported frame all come level together. Set them by
eye against the top-down, which is where a canted room reads as canted. There is no third
angle, because yaw is what dragging on the picture already does. Crop faces and the region
stay in sensor metres and are tested before the model matrix, so a box shrunk onto a subject
stays there when the room levels underneath it.

**`show crop box` is a viewer control and writes nothing.** The drag writes, through the same
registry door the sliders use, so a dragged face keys and undoes exactly as a typed one does.
No preset can carry a face: a preset document naming the crop, the clip planes or the
levelling is refused.
A face gets a handle in a view that can show it moving, which is why the top-down carries
`left`, `right`, `near` and `far`, and the picture carries all six. While the box is on
screen the points it cuts draw faintly, so you can see what a face is about to remove. None of
it reaches an exported frame or the OBS output.

**`crop` releases by not testing the faces, and it leaves them where they are**, so `near` and `far` still
normalise the depth ramp while the crop is off. With the crop released the box draws dashed
and grey.

## The five readings

Five readings of the take, split on the panel into what colours a point and what is then made
of it. Each is a weight from 0 to 1, so they mix.

| Reading | Parameter | What it does |
| --- | --- | --- |
| colour | `readRgb` | Registered colour mapped onto the depth points. |
| depth | `readDepth` | A cool-to-warm ramp across the clip range. |
| ghost | `ghost.amount` | A luminance shell that glows along depth discontinuities. |
| contour | `contour.amount` | Topographic bands sweeping through depth. |
| blackwall | `blackwall.amount` | A crimson containment volume with a cyan scan sweep and torn datastream bands. |

![The five readings on one frame of one take: colour, depth, ghost and contour in a
grid, and Blackwall full width beneath them.](../media/shading-modes.png)

All five are the same frame from the same pose, each at its own brightness. The room was shot
unlit, so colour and contour read a signal the sensor barely produced, while Blackwall blends
additively into bloom and blows out early.

**They are weights and not a mode.** The shader sums whichever are non-zero and divides by the
sum of the weights, so colour at 0.6 against depth at 0.4 is a 60/40 blend. Each is an
ordinary registry parameter, so each keyframes, and a single reading at 1.0 is the identity.
Their tuning keyframes too: the colour's `saturation`, the depth ramp's `gamma`, the ghost
shell's `rim` and `fill`, the contour's `bands /m` and `thickness`, and Blackwall's `sweep`
and `scan`.

## The look panel

The panel is generated from the registry at boot. A parameter is one entry naming its group
and label, and the row, bounds, readout and keyframe control are built from that, so an effect
cannot get a control the registry does not own. Bounds are authoring travel and not
mathematical limits: mixes, angles and positions keep their full semantic range, and
amplifiers end where the live picture stops producing a useful new setting.

Rows declared under another parameter hide while that master sits at its absent value.
Package-effect rows stay hidden until the effect is added with **+ add effect** or one of its
values or tracks carries work. Removing an effect resets every value and deletes every track
in one undoable edit and asks nothing first: **remove** in the picker and the cross on a group
header are the same edit, and undo takes either back.

**Units.** Displacements are metres in the levelled room, so a look gives the same picture at
any export size. `pointSize` and every other screen-space term are pixels at 1080p. `trails`,
`reach px` is reference pixels at 1080p and `decay` is a multiplier applied once per rendered
frame, so both count renders where `trails` counts them too, and a look graded at one output
rate does not keep its trail at another. `fade` and `wake` are milliseconds, and
`refresh s` is program seconds.

**Every effect is one panel group of its own**, and a core group holds only the spine's own
controls. The Region tab draws in the order the shader takes them: `Region (metres)`, then
`Region push`, `Turbulence`, `Region mask` and `Ripple` at gate orders 100 to 400, then
`Displacement` and `Lattice`.

| Effect | Tab | Parameters | What it does |
| --- | --- | --- | --- |
| `blackwall` | Effects | `amount` `sweep` `scan` | A crimson containment volume, a cyan scan sweep keyed off distance, and torn datastream bands. |
| `contour` | Effects | `amount` `bands` `width` | Topographic bands through depth. |
| `datamosh` | Effects | `amount` `reach` `decay` `splay` `line` `grain` `drift` `speed` `cycleRefresh` `refresh` | Pulls the picture along Y each frame and keeps what it leaves, so highlights stretch into needles. |
| `duotone` | Effects | `amount` `hue` `split` `span` `motion` | A tonal transform between two depth-keyed poles, with `motion` keying the same poles on axial speed. |
| `edges` | Effects | `amount` | Draws depth discontinuities. |
| `ghost` | Effects | `amount` `rim` `fill` | A luminance shell glowing along depth discontinuities. |
| `glitch` | Effects | `amount` `density` `shove` `tint` `bands` `axis` `rate` | Tears bands of the feed sideways in the sensor's own frame. |
| `glyph` | Effects | `amount` `tone` `hash` `rain` | Draws each lattice cell as a character out of a table of sixty-four 8x8 bitmasks. |
| `grain` | Effects | `amount` | Film grain over the finished frame. |
| `halation` | Effects | `amount` `radius` `threshold` `tint` | The warm ring film puts around a highlight, gathered on brightness alone, so the ring is red-orange whatever colour went in. |
| `lattice` | Region | `amount` | Quantises every axis to `cell m` in the levelled frame, so surfaces break into steps. |
| `mask` | Region | `amount` | Reads the region box as a mask. |
| `noise` | Region | `amount` `scale` `speed` `region` | Turbulence: displaces points with a noise field, and `scramble` reads the region box. |
| `push` | Region | `amount` | Swells the volume out along the region box's radius. |
| `rain` | Effects | `amount` `speed` `span` `trail` | A falling counter keyed on world height and program time, brightening what a drop head passes. |
| `raster` | Effects | `amount` `angle` `pitch` `hard` | Scanlines, turnable to a vertical grille, with `hardness` squaring the wave. |
| `rgbsplit` | Effects | `amount` | Separates the channels across the frame. |
| `ripple` | Region | `amount` `freq` `speed` | A wave travelling out along the region radius, advancing in eighths of a cycle. |
| `stock` | Effects | `amount` `balance` `split` `latitude` | The emulsion's own colour, keyed on exposure and built to leave luminance alone. |
| `streak` | Effects | `amount` `angle` | Gathers back along an axis and keeps the brightest thing it finds, so highlights smear. |
| `thermal` | Effects | `amount` | A thermal palette over the reading. |
| `vignette` | Effects | `amount` | Corner falloff. |

Seven grade terms share one full-screen pass, and the pass carries the tonemap: `rgbsplit`,
`raster`, `grain`, `streak`, `halation`, `stock` and `vignette`. Each switches it on. The
highlight rolloff and the black-toe `crush` ride along with the pass, so a look with all seven
at zero also has lifted blacks and no rolloff, and additive accumulation clips to flat white.
`crush` is a sub-control of that pass and not an eighth term gating it, so raising it
alone does nothing.

**The glyph field rides the lattice**, which is its only grid: `lattice.amount`
and `cell m` cut the room into cubes and move each point to the centre of its cube, and one
cell draws one character. Characters therefore read as characters only near `lattice.amount`
1.0, and the mark crossfades back to a round splat below the legibility band, so the near room
is text and the far room is texture. `tone key`, `hash key` and `rain key` add and wrap rather
than mixing, and `hash key` is the only one defaulting to 1. `fall m/s` and `head gap m` shape
the drop coordinate the `rain key` reads as well as the rain's own, so they move the picture
with `rain.amount` at 0.

**`glitch.axis` is a blend of the two image axes and not an angle in degrees**, from the
sensor's rows at 0 to its columns at 1, because a band is a run of scanlines in the sensor's
own frame. The tear is applied before the camera sees it, so orbiting around a torn band shows
it shoved in depth. `raster.angle` and `streak.angle` get degrees instead, because they run in
screen space where the pixels are square; `streak.angle` 0 is straight down.

`datamosh.refresh` is how long that pass may remember: the picture snaps back to the frame it
was handed every that many seconds of program time, and a seek decodes forward from the last
snap, so a long refresh is a long pre-roll on every scrub. Nothing in the rain accumulates, so
a seek there lands on exactly the frame playback would have drawn.

`rim` brightens depth discontinuities and gives a subject its edge, but under additive
blending plus bloom it washes broad surfaces white, so turn it down before turning down bloom.
`render %` scales the drawing buffer and is the one control that reliably buys back frame
time. Both `render %` and `auto-orbit` are viewer state: not saved with the clip, not
exported.

## Presets

A preset is look values and nothing else. Framing belongs to the shot, so
applying one never moves your camera, a clip, its crop, its clip planes or its levelling, and
a preset document that names framing is refused before any value is written.

**Applying one is not all on one clip.** A preset's cloud values, meaning point size, the
readings and every effect that binds the cloud, land on the selected clip. Its post-chain
values, meaning bloom, trails, crush and the rest of the grade, are the project's, so applying
a graded look to one clip of four regrades the other three. The editor says how many of the
values it wrote were the shared half.

A preset is `{ version, values }`, plus a `requires` list of `{ id, version }` when the look
touches any effect, derived from the values themselves. A parameter's key is dotted by
the effect it belongs to, like `glyph.tone`, and a core value that belongs to no effect stays
bare, like `pointSize` or `readDepth`.

Twelve ship read-only from `presets-builtin/` and are marked `·` in the picker.

| Preset | Reading | What it is |
| --- | --- | --- |
| `rgb` | colour | One reading and little else, so a grade can start from it. |
| `depth` | depth | The same, on the depth ramp. |
| `ghost` | ghost | The same, on the ghost shell. |
| `contour` | contour | The same, on the contour bands. |
| `blackwall` | blackwall | The same, plus fourteen values across glitch, RGB split, raster, grain and vignette. |
| `ember` | blackwall | A finished grade: a warm duotone at hue 28, a raster at pitch 0.4 and a toe over the reading. |
| `grille` | blackwall | `ember` regraded to a neutral hue around a harder, wider grille: raster pitch 0.2, hardness 0.95. |
| `tearline` | blackwall | `ember` regraded around the tear: glitch at 0.3 against 0.1, streak at 0.45. |
| `voxel` | blackwall | The lattice at 0.55 on a 3.5cm cell, so the volume reads as reconstructed. |
| `cascade` | depth | Falling code: the lattice at 1.0 on a 5.5cm cell, glyphs full, hash key full and rain key at 0.6, over a green duotone. |
| `updraft` | blackwall | `ember`'s grade with the datamosh over it, `splay` 0, streaming the whole frame upward. |
| `rift` | blackwall | The same with `splay` 1, pulling the frame apart from `line` outward. |

**All twelve name the whole look**: the 27 bare core values every look owes, plus every
parameter of each effect the document claims, which the all-or-none reading rule makes at
least the three reading packages. Applying a whole look resets every effect the document does
not claim back to that effect's own defaults. A preset naming two values is equally valid and
leaves everything else where the grade left it, but a partial preset does not stamp the clip,
because the stamp answers "what look is this clip wearing".

**The five reading weights tick and untick together.** A file naming any reading has to name
all five, because the ones it omits stay at whatever the clip was already wearing and two
fifths of a blend renders as a mixture nobody authored. A file naming none of them is a look
that is not about the reading. Everything in between is refused.

**Saving and exporting both ask which look values go in**, every box ticked by default. A
whole-look save sheds an ordinary effect sitting wholly at its own defaults, because a
whole-look apply restores it to those defaults anyway; the three reading packages stay whole
even at their defaults, and a subset save sheds nothing.

**Saving over a shipped name forks it**: the write lands in your library and shadows the
built-in, and deleting the fork brings the shipped look back. `export` writes the look on
screen, which is not the document the picker names once you have moved a slider, as
`<name>.braindance-preset.json`. `import` validates against the registry before saving, so a
scalar carrying a string fails at the key that is wrong and `__proto__` is refused as an
unknown parameter.

**This build reads project version 8 alone**, which places footage with each clip's `speed`
and `sourceStart`. A file from any older version is refused naming its own version, and there
is no conversion.

## Batch rendering

`POST /jobs` takes the project document, one capture content hash per clip and the output's
name, size and rate. All four are required. There is no button for this anywhere in the
browser.

**What enqueue checks and what it does not.** It checks that `project` is an object carrying
some `version`, that every clip names a content hash, that `captures` equals those hashes one
for one and in order, that `project.requires` claims exactly the effect namespaces the values
and tracks use with no repeats, that `suppressEffects` is a list of effect ids, and that the
output name, size, rate and codec pass the same validator the export dialog uses. It also
refuses an output name a queued or running job already holds. It does **not** check the
project's version number beyond its presence, and it stores `deliverable` exactly as given. So
a project from another build and a malformed deliverable both enqueue cleanly: the page refuses
a project version it does not read, and `applyDeliverable` refuses a deliverable that is not
version 2 or whose `outputSize` is another shape. The worker applies a deliverable only when it
is truthy, so a `false` or `null` one renders the whole clip.

| Field | Required | What it is |
| --- | --- | --- |
| `project` | yes | The project document body, meaning what `serialiseProjectBody()` returns. The store's `{ name, rev, body }` envelope is refused. |
| `captures` | yes | One `sha256:…` content hash per clip, in project order, repeats kept. |
| `output` | yes | The output's base name: a letter or digit, then letters, digits, dots, dashes and underscores. |
| `width`, `height` | yes | Positive integers. `h264` needs both even, and one RGBA frame may not exceed 96 MiB. |
| `fps` | yes | A positive number. |
| `codec` | no, `h264` | `h264`, `prores`, `pngseq` or `lossless`. |
| `renderer` | no, unpinned | The renderer class a worker must match to claim the job. Unpinned means any worker may take it. |
| `suppressEffects` | no, empty | Effect ids this render may go without. |
| `deliverable` | no | A version 2 deliverable document, which trims the render. |

The queue derives `requires` from the namespaces the project's own values and tracks carry,
and derives the footage list from the clips, so a body whose lists disagree with its values is
refused at enqueue by name, before a browser and a minute of GPU. Two jobs cannot reserve one
output name while either is queued or running.

A render you have already done carries the same fields in its `.job.json` sidecar under
`exports/`, so the shortest correct request is that file with a new name over it:

```bash
jq -s 'max_by(.created) |
       {project, captures, output: "take2-again", width: 960, height: 540, fps: 30}' \
   exports/*/take2.mp4.job.json |
  curl -sX POST http://localhost:8080/jobs -H 'content-type: application/json' -d @-
node tools/render-worker.mjs --url http://localhost:8080 --drain
```

`max_by` picks one sidecar when the glob matches several, because exporting `take2` twice
leaves two directories and two JSON objects concatenated into one body is not JSON at all. The
object above drops the sidecar's `renderer`, so the re-render is unpinned.

**A worker claims only jobs matching its browser's renderer class**, read off the page it will
actually draw in, so it cannot be handed work that would come back looking different.

| Flag | Default | What it does |
| --- | --- | --- |
| `--url URL` | `http://localhost:8080` | The queue to claim from. |
| `--name NAME` | `worker` | The name this worker reports on a claim. |
| `--max N` | `16`, or `1` under `--once` | How many jobs this run will take. |
| `--once` | off | Takes one job and stops. |
| `--drain` | off | Stops as soon as the queue holds nothing for this worker. |
| `--poll MS` | `2000` | How long to wait between claims without `--drain`. |
| `--beat MS` | `15000` | How often a running job says it is still there. |
| `--headed` | headless | Runs Chromium with a window. |
| `--help` | | Prints the usage and exits. |

**`--drain` bounds the wait and `--max` bounds the work, so exit 0 does not mean the queue is
empty.** A run stops after `--max` jobs whatever is left behind it, and `--drain` only decides
whether it waits for more work in the meantime. The exits are 0 when every job it took
succeeded or the queue answered with no job, 1 when a job failed or the claim request itself
failed, and 2 when the claim came back 409 or 5xx, which is work pinned to another renderer
class or a server error.

The queue is records on disk, so it survives a restart. A worker heartbeats while it renders,
and `POST /jobs/:id/requeue` puts a job back, refusing a running job heard from within the
last 120 seconds.

**The trim travels on `deliverable`**, and a job without one renders the whole clip. The
worker applies it through the door the editor uses, so it is a whole version 2 deliverable
document and not a bare pair of seconds:

```json
"deliverable": {"version": 2, "in": 0, "out": 1.967,
                "outputSize": "960x540", "codec": "h264", "name": "take2-again"}
```

`outputSize` has to be a size of the shape the project is framed at, or the render fails
naming the shape. Size, rate and codec still live at the top level, which is where the queue
validates them and where the worker reads them back. **The sidecar does not record the trim**,
so the recipe above reproduces a trimmed render at full length unless you add the deliverable
back yourself.

A worker launches Chromium at startup, to read its renderer class off a real page. Then, per
job, it resolves every capture hash against its own library before it loads the project, and a
hash it has not got fails the job naming the take. After the load it attests what the page
actually opened against what the job asked for, clip by clip and in order. It refuses a job
envelope from a version it does not read, and fails a job naming an effect it has not got
unless `suppressEffects` covers it. A failed read of its own server is retried a few times
before the job is failed at all, and the job then comes back naming the read itself, never a
package or a take the machine has not got.

## HTTP routes

Every route is on one table that is also the dispatcher, served at `GET /library/routes`. A
route with a write method goes through the three checks under
[Reaching it from another machine](#reaching-it-from-another-machine).

| Route | Method | What it does |
| --- | --- | --- |
| `/capture/:id/hello` | GET | The capture's own hello stanza. |
| `/capture/:id/index` | GET | The frame index. |
| `/capture/:id/extent` | GET | How much of the capture is on disk. |
| `/capture/:id/file` | GET | The capture's bytes. |
| `/capture/:id/frame/:n` | GET | One frame's payload. |
| `/capture/:id/frames/:a-:b` | GET | A run of frames as the file's own slice. |
| `/capture/:id/marks` | GET, POST | Reads and writes the take's marks. |
| `/capture/:id/marks/log` | GET | The marks with their write log. |
| `/library/takes` | GET | The takes on this machine, with storage left. |
| `/library/all` | GET | Every take here and on the linked node. |
| `/library/remaining` | GET | Recording time left at the current rate. |
| `/library/downloads` | GET | Transfers currently moving bytes. |
| `/library/descriptors` | GET | Open descriptors against captures held. |
| `/library/routes` | GET | This table. |
| `/library/writes` | GET | Write counts per store. |
| `/library/remote-frame/:id/:n` | GET | One frame of a node-only take, fetched through here. |
| `/library/download/:id` | POST | Pulls a take from the linked node. |
| `/library/delete/:id` | POST | Deletes a take. |
| `/library/reclaim/:id` | POST | Deletes the local copy of a take the node still holds. |
| `/library/sync-marks/:id` | POST | Pushes marks to the node. |
| `/library/rename/:id` | POST | Renames a take. |
| `/library/reveal/:id` | POST | Starts the file manager on the take. |
| `/projects/all` | GET | Lists project documents. |
| `/projects/:name` | GET, PUT, POST, DELETE | Reads, writes and deletes one project. |
| `/projects/:name/rename` | POST | Renames a project. |
| `/presets` | GET | Lists presets, builtin and forked. |
| `/presets/:name` | GET, PUT, POST, DELETE | Reads, writes and deletes one preset. |
| `/deliverables` | GET | Lists saved export settings. |
| `/deliverables/:name` | GET, PUT, POST, DELETE | Reads, writes and deletes one deliverable. |
| `/effects` | GET | Lists installed effects with the store's generation. |
| `/effects/:id` | GET, PUT, DELETE | Reads, installs and removes one package. |
| `/effects/:id/file/:name` | GET | One chunk's own bytes, as `text/plain`. |
| `/effect-refusals` | POST | Sets aside packages a page could not compile. |
| `/camera.mjpg` | GET | The colour camera as MJPEG. The one embeddable route. |
| `/sensor/health` | GET | What the sensor is doing. |
| `/record/state` | GET | Whether a take is running. |
| `/record/start` | POST | Starts a take. |
| `/record/stop` | POST | Stops it. |
| `/record/mark` | POST | Marks the running take. |
| `/jobs` | GET, POST | Lists the queue and enqueues a render. |
| `/jobs/claim` | POST | Hands the oldest claimable job to a worker of a named renderer class. |
| `/jobs/:id` | GET | One job, without its lease. |
| `/jobs/:id/finish` | POST | Reports an outcome against the lease the claim handed out. |
| `/jobs/:id/heartbeat` | POST | Says the claim is still rendering. |
| `/jobs/:id/requeue` | POST | Puts a job back on the queue, still pinned. |

Every read route strips a job's `lease`, because the lease is the capability `finish` demands.

## Installing an effect and taking one away

`PUT /effects/<id>` installs a package and `DELETE /effects/<id>` removes one. The body is
`{manifest, chunks}`: the manifest as JSON, and a map of file name to GLSL text. The id in the
path is the namespace the package's parameters carry, so a manifest declaring a different one
is refused. An id starts with a lowercase letter and continues in lowercase letters and
digits, up to 64 characters.

**An install lands in `effects/` and never in `effects-builtin/`.** A package installed under
a shipped id shadows it, and deleting that copy brings the shipped one back. Nothing reachable
from the network can edit or remove what the build shipped with, so there is always a package
to fall back to, and a `DELETE` aimed at a builtin nothing is forking is refused by name.
Deleting a package that exists only in `effects/` uninstalls it, at which point every open
document's values under it park.

**A page that is open when an install happens rebuilds itself.** All three shader programs
are reassembled and swapped — the cloud, the grade and the mosh — the registry and the panel
are rebuilt, and every value is written
back through the door a slider uses, so a newly installed effect's parked values come back and
apply. The tab that was up stays up and a group you had collapsed stays collapsed. A package
that changed no GLSL is adopted without recompiling anything. Other browsers converge within a
few seconds; the poll stands down while an export, a preset gesture or a keyframe evaluation
is running, and asks again afterwards.

### What the door refuses

The door runs before a byte is written, because a bad package that landed would not fail its
install, it would fail the next page load with nothing on screen. It refuses:

- an id and a manifest that disagree, or a package format later than this build reads;
- a file name that is not a bare name in the package's own directory;
- more than one parameter marked master, or a master whose default is not the value the
  effect is absent at;
- a parameter kind or binding the registry does not implement;
- a binding whose shape does not match the uniform it writes, or one aiming at an array;
- a binding declaring `gates` that the grade gate cannot read;
- a step finer than `1e-6`;
- a uniform a parameter binds that no program declares, or a uniform the package declares that
  none of its own parameters binds and `hostDriven` does not name. `hostDriven` names the
  uniforms this build's render loop drives, which is `rainPhase` and nothing else;
- a chunk naming a joint no spine has, or reaching for an identifier this build has not got.
  A spine is one shader program written as fixed GLSL with named gaps in it, and a joint is
  one of those gaps; a chunk names the joint it fills in its `stage` field, or a single `slot` such as
  `v.pointSize` that replaces one expression, and
  [`web/cloud-shader.js`](../web/cloud-shader.js),
  [`web/grade-shader.js`](../web/grade-shader.js) and
  [`web/mosh-shader.js`](../web/mosh-shader.js) hold the three spines;
- a parameter naming a panel group this build does not hold and the package does not declare,
  or a package group key colliding with either;
- a package over 64 files, over 256 KiB of chunk text, or with a manifest over 32 KiB.

A refused package leaves nothing behind. A parameter names its group and nothing else about
the panel, so a manifest carries no tab. **A fork may add parameters and retune the ones it
inherits, and may not drop one**: the panel places every shipped parameter by hand, so a fork
short of one is a registry that cannot assemble, and the door names what it dropped.

### What the door cannot see

Nothing here compiles GLSL. The door refuses a chunk naming something this build has not got
and cannot refuse one whose GLSL is merely wrong, because that is a shader that fails to link,
which is a log line inside the driver.

The page detects it while it warms the swapped programs: it rolls back onto the set it was
holding, keeps the document it had, and says which shader did not compile. It then posts to
`POST /effect-refusals` with the driver's own sentence, and the server renames each user copy
aside as `<id>.<seq>.incompatible`, so the package is still on disk to be repaired and the
shipped one answers for that id again. The ids it names are the packages that changed in that
adoption, because a link failure is about the assembled program and never says whose GLSL it
was. Only a link failure may set anything aside, an id with no copy in the user root is
skipped, and the answer names what was set aside and what was not, with a reason for each.

### The boot gate

A fork is held against the build it was installed on, and this program's shaders gain, lose
and rename the joints a chunk can name. So the store asks the install door about every package
in `effects/` each time it starts. One the door now refuses is renamed to
`<id>.<seq>.incompatible`, the shipped package answers for that id again, and the log names
the id and the rule:

```
effect rain was installed by an earlier build of this program and this one refuses it: effect
rain does not assemble into this build's shaders: ... - the package has been renamed to
rain.4711.k2p9.incompatible rather than deleted, so it is still there to be repaired and moved
back, and the shipped package answers for that id again
```

Nothing deletes that directory. Fix what the sentence names, rename it back to `<id>`, and
restart, or install the repaired package over the top and remove the aside by hand.

One package refused this way never costs its neighbours: each is held against the shipped set
plus the packages already validated beside it. If the rename cannot be made, the server still
comes up, says so on the same line, and goes on serving the package it has just announced it
cannot use.
