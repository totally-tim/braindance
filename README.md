# Braindance

Volumetric capture and editing for the Kinect v2. It records what the depth sensor saw, then
lets you fly a camera through the recording afterwards and render the result to video.

![A camera arcing across a recorded room, shaded by depth: the near column is warm
yellow, the far wall cool blue, and the two slide past each other as the camera
moves.](media/flythrough.gif)

**Status: experimental, maintained as a personal project.** Runs on macOS (Apple Silicon)
and on a Raspberry Pi as a capture node. There is no release cadence and no support
commitment. Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

> *Braindance* is a Cyberpunk term for a recorded experience you can step into and look
> around inside. Not affiliated with CD Projekt Red or R. Talsorian Games.

## What you need

- **A Kinect v2.** Without one you can still replay a capture and work on the browser side.
- **Node 18.15 or newer.**
- **macOS on Apple Silicon, or Debian / Raspberry Pi OS** for a capture node.
- **ffmpeg** for video out, expected at `/opt/homebrew/bin/ffmpeg`. Set `FFMPEG=` to override.

## Quickstart

```bash
npm install
npm run build:native      # one-time; needs the packages listed under Building the native side
npm start                 # opens the menu on http://localhost:8080
```

Skip the native build if you have no sensor.

The menu offers three things: record a take, open your projects, or browse the media library.

![The menu, under a bar reading Braindance: three cards reading RECORD, PROJECTS and
MEDIA LIBRARY.](media/menu.png)

Two shortcuts:

```bash
npm run record            # live sensor, first take armed at boot
npm run replay            # replay captures/sample.knct, no sensor needed
```

No capture ships with the repo. Record one, or build a synthetic one with
`npm run fixtures`.

## Using it

### 1. Record a take

Pick **Record**, then press **record** to arm. The recorder waits for the sensor before opening
a take, so every capture carries the sensor's calibration. The panel counts frames and
shows how much recording time the disk has left.

![The record surface in Blackwall: a room drawn as a crimson point cloud, with an
application bar across the top reading Record, File, Output and View, a top-down inset in
the corner, and a panel down the left whose four tabs are Record, Framing, Effects and
Region. The Record tab is open, showing the record and mark buttons, "not recording", the
recording time left, colour camera and low light toggles, the monitor's depth and every Nth
sliders, and the OBS output settings with both source URLs.](media/viewer.png)

- **mark** drops a mark at the current frame. Marks show up on the media library's scrub bar
  and the editor's ruler.
- **stop** closes the take. The `.knct` capture and its `.idx` index land in `captures/`,
  with a `.marks.jsonl` sidecar if you marked anything.
- `R` and `M` do the same two things from the keyboard.

The panel has four tabs. **Record** arms the sensor and points the OBS output somewhere.
**Framing** levels the room and sets the clip box. **Effects** is everything about how the
cloud is drawn. **Region** holds displacement and the region box. The application bar above them
carries the project, the export and the OBS status, and is the same on every surface.

The **Effects** tab's preset picker holds the twelve shipped looks. Pick one to apply it.
Shipped presets cannot be overwritten. **save** writes your own to `presets/`, and **export**
and **import** move presets between machines as JSON. Every slider underneath stays
adjustable, and a changed row grows a **↺** that resets just that one.
[Presets](docs/reference.md#presets) lists the twelve.

![The same surface with the Effects tab open. The Preset picker is expanded over the
panel, listing none, blackwall, cascade, contour, depth, ember, ghost, grille, rgb, rift and
tearline with blackwall highlighted. Underneath it the Blackwall, Glitch and Points groups
each carry sliders with values, and a changed row shows a reset arrow.](media/look.png)

Effects are packages on disk. Press **+ add effect** in the sidebar to search the installed
packages. **Remove** takes one out of the project, resetting its values and deleting its
tracks as one undoable edit.
[Installing an effect](docs/reference.md#installing-an-effect-and-taking-one-away) has the
package layout, the routes and the flags.

### 2. Find it in the media library

Pick **Media library** on the menu, or the link in any surface's header.

![The media library: four take cards of identical size with depth thumbnails, each showing its
duration, LOCAL badge, size, frame count, mark count and date above a New project from
this take, a Delete and a three-dot menu. A filter row above them reads ALL 4, LOCAL 4,
NODE ONLY 0 and BOTH 0, and the application bar carries a link back to the menu, Projects
and Media library beside each other with Media library marked, and reads 4 takes, 04:58 and a linked
node.](media/library.png)

Every take is a tile with its poster, duration, size, frame count, mark count and date. Skim a
poster to scrub it. Tap to open it large, then arrow keys step a frame and up and down move
between takes. The **⋯** menu holds **rename**, **show in the file manager** and **reclaim on
node**. Started with `--node http://<capture-node>:8080`, the library also lists that node's
takes, and the filter row splits it into *local*, *node only* and *both*.

### 3. Start a project

**New project from this take** creates a project named after the take and opens the editor.

Projects save themselves. Every change that lands on the undo stack is written to the
project's file, so there is no save button. **Projects** on the menu lists them, last written
first, with a thumbnail of the edit you can drag through. That is where you rename, duplicate
or delete a project.

![The projects page: two rows, each a wide depth thumbnail of the edit beside the project
name, when it was last written, its clip count, its shape and its rate, with a three-dot
menu at the right. A New project button sits above them and the application bar reads
2 projects, with Projects marked beside Media library.](media/projects.png)

In the editor the cloud draws on the left, the keyed camera path with it and in the top-down
inset, and the timeline underneath.

![The editor in depth shading, the room drawn cyan through orange by distance. A keyed
camera path arcs above it as a line of five nodes with the program camera's frustum
sitting on it, and the top-down inset repeats the same arc. The panel on the left is on
its Camera tab, offering add key, delete key and set viewport to camera. Underneath, the
transport reads a program clock of 00:10.967 against the same source time, and the
timeline's camera lane says 5 keys with a diamond under each.](media/editor.png)

Drag to orbit, scroll to zoom, right-drag to pan, `H` hides the panel.
[The controls reference](docs/reference.md#viewer-and-timeline-controls) has the timeline's
navigation. On a canted mount,
[level the room](docs/reference.md#levelling-a-canted-mount) first.

### 4. Key a camera move

Park the playhead, orbit to the pose you want, and press **add key** on the panel's **Camera**
tab. Move, orbit, press again. Dragging a path node in the view or the top-down moves the
key. **delete key** removes the key under the playhead, and **set viewport to camera** puts
your eye where the program camera stands. The keyframe arrows beside the transport step
between keys.

Two clocks read under the transport. **program** is a position in the output, **source** a
position in the capture. At 1.00× they advance together. Pulling **speed** makes them
diverge, so the footage slows while the camera keeps its own pace. See
[program time](docs/architecture.md#program-time-is-the-edit-coordinate).

Nearly every slider has a keyframe button, so a clip can dissolve from depth into Blackwall
under the playhead. `depth ÷`, `every Nth` and `render %` are view settings, not part of the
frame, so they are neither saved with the clip nor exported.

**View → Previews** renders the in/out range for cached playback. It follows
the authored camera path, or the current free-camera view when you leave that camera still.
**Render while idle** starts after you stop interacting; **Render range** starts immediately.
The band under the time ruler marks ready frames and **Cached** appears during playback. Changing the edit
or viewpoint returns to live rendering until matching previews are ready.

### 5. Export a video

Aspect ratio and frame rate belong to the project: set them under **Project settings** in the
application bar. Then set **in** and **out** on the timeline bar, open **Output → Export**
(`⌘E`), pick a resolution, a format and a name, and press **Export**.

![The Export dialog. A Deliverable select with a new button, reading 1920x1080 h264
underneath; a Resolution of 1920x1080; a Format row of MP4, MOV and PNG sequence with MP4
selected; an Output name whose placeholder is the take's id; a Trim line reading
00:00.000 to end, 10.80s at 30fps; and save a copy and Export at the
foot.](media/export.png)

| Format | What it is | Use it for |
| --- | --- | --- |
| MP4 | h264 | sending to someone |
| MOV | ProRes 422 HQ, 10-bit 4:2:2 | grading in another editor |
| PNG sequence | one file per frame in a directory | compositing |

The render runs in the page and lands in its own directory under `exports/` on the server.
**save a copy…** puts the file anywhere through the browser's file picker. It is disabled in a
browser without one, and for a PNG sequence, which is a directory.

Renders can also be queued from the command line without the browser. See
[batch rendering](docs/reference.md#batch-rendering).

## Streaming to OBS

Two outputs, both listed with copy buttons under **Output → OBS**:

| What | How | What it is |
| --- | --- | --- |
| the viewport | browser source on `/program` | this renderer at a fixed size, no chrome |
| the webcam | browser source on `/camera.mjpg` | the colour camera's own 1920x1080 frame |
| the keyed webcam | browser source on `/key` | the same frame with everything outside the crop box cut away, alpha to OBS |

Add a *Browser Source*, paste the URL, set *Width* and *Height*. The webcam is always
1920x1080. The viewport is whatever you set in the panel, and has two modes: *program camera*
frames the keyed camera, *mirror* follows what the operator is orbiting. OBS's own virtual
camera publishes either one to Zoom or Meet.

The keyed webcam cuts the frame by the crop box in sensor metres, and the depth behind the
cut is the same floor plan the cloud draws, so it is a hole in the picture, not a body
matte. Turning the colour camera off restarts the grabber and drops a live webcam mid-call.
`/camera.mjpg` and `/key` serve the camera to anything that can reach the port, so read
[SECURITY.md](SECURITY.md) before passing `--host 0.0.0.0`.

## Building the native side

Both builds are one-time and offline. libfreenect2 lives at `third_party/libfreenect2`
(upstream v0.2.1 plus the edits declared in `third_party/UPSTREAM.md`) and builds into the
gitignored `vendor/prefix`.

```bash
brew install libusb jpeg-turbo cmake                       # macOS
sudo apt install libusb-1.0-0-dev libturbojpeg0-dev cmake \
                 libglfw3-dev libgl1-mesa-dev              # Debian / Raspberry Pi OS
npm run build:native
```

`build:native` picks the `macos` preset (OpenCL) or the `linux` preset (OpenGL, for the Pi)
from the platform and ends by running the grabber it just built. The GL packages on the Debian
line are required: without them libfreenect2 builds a CPU-only library, and the build refuses
that. `node tools/build-native.mjs --help` lists the overrides.

## Going deeper

- **[docs/reference.md](docs/reference.md)**: the command line, the controls, levelling,
  the readings, presets, effects and batch rendering.
- **[docs/architecture.md](docs/architecture.md)**: how the pieces fit, program time, the
  effect store and the `.knct` wire format.
- **[docs/performance.md](docs/performance.md)**: what things cost, with the measurements.
- **[CONTRIBUTING.md](CONTRIBUTING.md)**: what you can work on without a sensor, and how
  changes are proven.
