# Architecture

How the program is put together, and the coordinate decisions everything else follows from.
[README.md](../README.md) has the usage path.

```
Kinect v2 ──USB3──▶ native/grabber ──framed stdout──▶ server/index.js ──WebSocket──▶ web/main.js
                    (libfreenect2 +                   (fan-out, drop-to-latest)     (GPU unprojection,
                     OpenCL depth,                                                   217,088 points +
                     TurboJPEG colour)                                               surface memory)
```

A native grabber pulls depth and registered colour from
[libfreenect2](https://github.com/OpenKinect/libfreenect2). A Node server fans the frames out over
WebSocket and serves the pages. A Three.js viewer unprojects them on the GPU using the sensor's own
intrinsics. Around that sit a recorder, a take library reconciling between two machines, a keyframe
editor, an effect store the shaders are assembled out of, and a render queue.

## The grabber

`native/grabber.cpp` opens the device, solves depth on the processor its libfreenect2 was built
with — OpenCL where the build has it, else OpenGL, else the CPU, and `--pipeline` overrides —
and encodes colour with TurboJPEG. Depth and colour arrive on separate listeners. The colour camera
halves to 15fps in dim light while depth stays at 30, so depth runs at its own rate and reuses the
last colour frame that arrived, with no age check on it. A synced listener would drop every other
depth frame.

Frames go to stdout and every log line to stderr, because one stray log line on stdout desyncs the
stream permanently. The periodic log reads `600 frames (293 colour, 0 bad depth, 0 bad colour)`,
always with its zeroes. The colour count explains a stale-looking image, and the two refusal counts
are frames libfreenect2 marked failed itself, which separates a failing GPU readback from a
degraded USB link.

`--min-depth` and `--max-depth` clip on the GPU before a frame is built, so they decide what exists
at all. The viewer's `nearClip` and `farClip` only hide points that already arrived, and the
recorder's preview range drives that pair, never the grabber's.

## The server

`server/index.js` spawns the grabber, or replays a capture with `--replay`, parses the framing and
fans the messages out over WebSocket. A browser that falls behind is dropped to the latest frame: a
socket holding more than 4 MiB skips, because a stale cloud reads as a slow Kinect. The default
port is 8080 and the bind is `127.0.0.1` unless `--host` says otherwise, since
this server has no authentication. Every route that changes something requires its own method, a
same-origin caller and a JSON content type — `server/http-guard.js` holds all three, and together
they are what a page you merely visit cannot produce.

| module | what it owns |
| --- | --- |
| `server/capture.js` | the sidecar index over a `.knct` file, and the frame reads a playhead asks for |
| `server/recorder.js` | one take, one file: start opens it, stop closes and scans it |
| `server/library.js` | the manifest over `captures/`, the marks, the documents, the node link |
| `server/effect-store.js` | the effect packages on disk, and the routes that install and remove them |
| `server/effect-door.js` | what a package has to satisfy before it may be written |
| `server/jobs.js` | the render queue: jobs on disk, claimed by workers, one at a time |
| `server/export.js` | raw RGBA frames off a WebSocket, straight into ffmpeg's stdin |
| `server/webcam.js` | the colour camera's own 1920x1080 picture, as MJPEG for OBS |
| `server/protocol.js` | the wire format, and the `.knct` decoder specification |

`fs.readFileSync` throws `ERR_FS_FILE_TOO_LARGE` above 2 GiB, so everything reading a capture
streams. `server/capture.js` is the only module that reads frames out of one; `server/recorder.js`
writes the bytes and `server/library.js` streams a whole file through a hash.

## The surfaces

| URL | file | what it is |
| --- | --- | --- |
| `/` | `web/menu.html` | three tiles: RECORD, PROJECTS, MEDIA LIBRARY |
| `/record` | `web/index.html` | the live cloud, with the recorder armed from the same surface |
| `/edit` | `web/index.html` | the editor: the same page in its other mode |
| `/library` | `web/library.html` | every take this machine holds or can pull down off the node |
| `/projects` | `web/projects.html` | the landing page: every edit, newest write first |
| `/program` | `web/index.html` | the program output, which OBS opens as a browser source |

**The recorder** waits for the sensor's hello, then streams frames to disk in the wire's own
framing, so a capture holds the type 1 and type 2 messages as the grabber framed them. The one edit
is the hello: `stampHello` rewrites `startedAt` to when this take began before writing it, and
leaves a hello it cannot parse as an object untouched. The
recorder refuses a take it lacks the disk for, and `MIN_TAKE_SEC` is 120: a take that never started
is a decision, one that dies at eighty percent is a loss.

**The media library** joins takes across two machines on content hash, because two machines can
hold different takes under one name. A take can be pulled down, and the node's copy reclaimed once
the local one is re-hashed. Warnings — truncated, no sensor hello, no whole frame, still recording
— show as badges on the poster.

**Renaming moves a label, and a reference is a hash.** Each clip records its take as `{id, hash}`
and the loader resolves the hash against the library listing, so a rename carries the capture, its
marks and its index to a new name and every project still opens. Two renames at one name are
answered by the kernel, and the loser keeps its footage.

**Showing a take in the file manager is the only route that starts a process.** It is refused
unless the browser is on the server's machine, and refused for the take being recorded, which a
file manager would stat and index as the recorder writes it.

**The editor** keyframes the camera on its own track and the look on others. Seeking to a frame
and playing to it produce the same image, which `tools/timeline-check.mjs` proves.

**The render queue** produces video from finished edits. A job is a self-contained project body
plus the captures it names and an output spec, claimed by a worker pinned to the renderer class it
draws with, because bit-exactness does not survive a change of GPU. `tools/render-worker.mjs`
brings a page up on `/edit?take=`, which opens no document, so that page writes nothing.

## The effect store

Every effect is a package — a manifest and the GLSL chunks it splices into the shaders — and the
page assembles both point-cloud programs, the grade pass, the mosh pass, the parameter registry and
the panel out of whatever the store holds.

**Two roots, and the user's copy wins.** `effects-builtin/` is what the build ships with and
nothing in this program writes into it; `effects/` is where an install lands. An id present in both
resolves from the user's, which is the fork mechanism: install under a shipped id and it shadows
the shipped one, delete that copy and the shipped one answers again. The shipped set is always
there to fall back to, so removing a builtin nothing forks is refused, and a server missing that
root will not boot.

```
GET    /effects              { effects: [ every id either root holds, with its files and
                               revisions ], generation: how many times this store has changed }
GET    /effects/:id          one package: the parsed manifest, the file index, the revision
GET    /effects/:id/file/:n  one file's bytes, as text/plain
PUT    /effects/:id          { manifest, chunks: { <file>: <text> } }  installs into effects/
DELETE /effects/:id          removes the user's copy only
POST   /effect-refusals      { ids: [...], reason }  sets aside the user copies of packages a
                             page could not compile. Outside /effects/, where a literal
                             segment would outrank :id
```

A revision is a hash of the bytes on disk: `sha256` per file, and the package's own over the sorted
`name hash` lines. The generation sits beside it because a hash cannot say a change was undone —
installing a fork and deleting it again leaves both sides hashing alike — so a client that built a
set out of one listing and a request per file lists again and requires the generation it started
from.

**An install is atomic because a package is a directory.** The new copy is written under
`<id>.<seq>.tmp`, any existing one is renamed to `<id>.<seq>.old`, the new one is renamed in and
the old deleted; an uninstall renames aside as `<id>.<seq>.gone`. Those suffixes carry a dot and an
effect id may not, so a half-finished install is invisible to every read, and one suffix per intent
lets `recoverInterruptedInstalls` put a `.old` back. `effects/` is the one directory a client writes
into, so the file route judges a name by what it is and refuses a symlink.

**The door decides what may be written, and is asked again at every start.**
`server/effect-door.js` runs the real assembler against the set that would exist after an install.
A package that would not assemble, would bind a uniform no program declares, names an identifier
this build has not got, or carries a `def` or `max` off its own step grid is refused with the
reason and never reaches disk. The door also refuses declarations that collide in an assembled
scope, including a chunk redeclaring a spine local such as `zoom` or `k`. Chunks may not carry
preprocessor directives, because macros and conditionals can hide declarations from that check.
A fork naming a joint a later build dropped throws out of
`assembleShaders` while `web/main.js` is still evaluating, so no surface opens.
`refuseIncompatiblePackages` re-runs that door over the user root at every start and renames what
it now refuses to `<id>.<seq>.incompatible`, keeping it on disk, because a fork is authored work.
Only the user root: a builtin this build cannot assemble is a broken build.

### Assembly: a spine with joints, and the chunks that fill them

`web/cloud-shader.js`, `web/grade-shader.js` and `web/mosh-shader.js` each export a **spine** —
verbatim GLSL segments with named joints between them — and `web/shader-assembly.js` concatenates a
spine with whatever the installed packages bring. It imports nothing and interpolates nothing: a
chunk is spliced between two segments exactly as it arrived.

A joint is one of four kinds, and the kind decides what filling it means:

- a **stage** takes any number of chunks, concatenated by the `order` each declares, which is why
  two packages can both add uniforms to one declaration block;
- a **slot** takes at most one claimant and carries the text to use when nothing claims it, so a
  slot is a replacement and an uninstalled effect is exact identity by construction;
- a **service** is a value the spine computes under a gate its consumers generate, built from each
  consumer's `when` clause and joined in `gateOrder`, so a term reading the value without joining
  the gate compiles and does nothing;
- **varyings** are generated from the packages' declarations in all three places at once — the
  `out` list, the `in` list and the initialisation.

Joint names are collected across every spine at once, so two spines offering one name is a refusal,
and a chunk naming a joint nothing holds is refused by name instead of landing nowhere.

Two passes keep memory. `web/mosh-pass.js` holds a ping-pong pair of targets, drawing into one
while reading the one it drew into last time, which lets a chunk hold pixels back as well as
transform what is in front of it; the trails pass in `web/post-chain.js` reads its own last target
too. `renderProgramFrame` clears the trails on a camera move, because screen-space history belongs
to a pose, while the mosh keeps its history, which is the point of it.

Memory makes a pass unseekable, so a package binding on the mosh table declares one parameter as
its `bounds`, in seconds, and the loop raises `moshIFrame` for one frame whenever that much program
time — position in the finished output, defined below — has passed. On that frame the pass reads
no history, so it is a keyframe: `moshFramesBack` seeks back to the nearest one in frames and
decodes forward.

### Hotload, and a document naming an effect this build has not got

`adoptEffectPackages` rebuilds the shader programs, the parameter registry, the panel and the
uniform cells from a set of packages, then walks every value back through `params.set`. Boot is its
first call and there is no separate install path, because a code path that only runs after an
install is one nobody exercises until it matters. Pages converge by comparing revision lines every
few seconds. A hotload that fails part-way — a program that will not link, or a document that will
not restore onto the new set — puts the page back on the packages it held, synchronously. Only the
link failure quarantines, and `setAsideUnlinkable` names the packages that moved, since the
driver's log points into one text spliced out of all of them.

A document may name an effect that is not installed. A bare name core does not know is a typo, and
a dotted name whose package is installed but lacks the suffix is a half-package: both refuse. A
dotted name whose prefix is not installed **parks** — the viewer loads, the installed part renders
pixel-identically, and the values and tracks under that prefix go to a pool nothing evaluates and
nothing destroys. The serialiser merges it back uninspected, so a round trip through a build
lacking the effect returns every parked key holding the value it arrived with. The promise is on
the values: parked keys append after the installed ones and `JSON.parse` normalises every number,
so the file's bytes and its revision do move. Presets exclude the pool.

An effect installed at another version is surfaced and never refused, because a version string says
nothing about which direction is compatible: the clip loads and the bar carries
`document requires glyph 1.0.0, installed is 2.0.0`. Export refuses by default while anything is
parked, naming the ids and versions, because a video leaves this machine and nothing in it says a
layer of the look was absent. Suppressing is per effect and per session, and the sidecar records
what was skipped.

## Program time is the edit coordinate

Source time is a position inside the capture; program time a position inside the output. They
advance together at 1.00x and diverge at any other speed, so every keyframe is stamped in one of
them, and every track here is in program seconds. Rendering is forward-only:
`programTime = k / outputFps`, evaluate the tracks,
`sourceSec = sourceStart + (programTime - start) * speed`, binary-search the index.

- **Export needs no inverse.** It walks program time forward and a constant speed maps that onto
  source time with one multiply, so keying in program time costs it nothing.
- **The camera keeps its own pace when the footage slows**, which is the creative point: a
  photographer's movement is independent of what they are filming. The speed control changes the
  selected clip's output length and rescales that clip's own keys from its head, while project
  tracks, camera keys and output cuts hold their authored program seconds.
- **`fade` and `wake` stay in source time**, because they drive surface memory, which advances per
  source frame: how long a surface remembers is a fact about the footage.
- **`outputFps` is the project's, not the deliverable's.** It is the denominator of the edit's own
  coordinate, so two deliverables at two rates would be two edits. `trails` makes that visible: it
  is the one look term counted in output frames, because `AfterimagePass`
  multiplies the picture it holds once per rendered frame. At damp 0.9 a trail is down to 12% after
  twenty frames, which is 0.83s at 24fps and 0.33s at 60.

The shape the stage is letterboxed to is document state for the same reason, and the pixel count is
not. A project carries `aspect` as a reduced integer pair — `[16, 9]`, `[256, 135]` — because the
camera was keyed against a frame, so reopening a 65:24 edit at 16:9 would be a different shot. A
deliverable carries the resolution, because every screen-space term is expressed against 1080p and
bloom's chain is frozen at 600 whatever the buffer is, so two sizes of one shape reopen
identically. Point sizes also use the camera's 50-degree boot lens as their reference.

`PROJECT_VERSION` is 8 and presets share it. `aspect` and `outputFps` are additive and bump
nothing, so an absent `aspect` means the shape of the `outputSize` beside it and an absent
`outputFps` means 30. `web/format.js` owns the number and the refusal a document from another
version gets. Deliverables carry their own version, 2, because a version 1 document names a rate
this build ignores: it would parse perfectly and render the wrong file.

## Clips, and what a cut costs

A clip owns a source, a cloud, a `speed`, a `sourceStart`, a `start` and a `length`, and covers
`[start, start + length)` — half-open, so two clips abutting at a cut do not both draw on the frame
it lands on. `length` is the document's own field and is read back as the answer: `null` means
everything the take has past its `sourceStart`, at its speed. A gap renders an empty composite.
`CLIP_CEILING` is 8, and it gates the document alone: a clip costs a cloud whether it is on screen
or not, so a frame's cost is set by how many are live at once.

**Each clip draws through `Group(transform) -> Group(level) -> Points`.** The outer group places
the clip in the room and the inner one carries the levelling quaternion, both clip-scope, so a
reader asking which way is up is asking about the selected clip. `transform` is a registry
parameter of kind `placement`, a pose minus the field of view, and its tag is composition, so the
panel draws no row for it and no preset carries one. Position and rotation only: a
scale would fight `pointSize`, which is screen-space, and the fog, which is world-space. An idle
clip costs no draw. Draw order is written onto the points explicitly — depth-writing clips first,
additive after, ties broken on the clip's id — because an export that reordered two clips would
write different files from one document.

**The pipeline splits per take and per clip.** The capture bytes, the frame index and the fetch
cache belong to the take, and every clip cut on it shares one `IndexedTake`, so two clips decode a
frame once between them. Everything from `createImageBitmap` on is the clip's: the bound bitmap,
the four texture cells, the surface memory and the uniform table are per cloud. So a trim skips the
bitmaps bound by every clip, selected or not, and keeps the frames every outstanding fetch
claimed.

**A clip is reset, then warmed, then shown.** Its ping-pong pair holds whatever it last drew, so
without a warm the first frame after a cut would show no fade and no wake where the same instant
reached by seeking looks right. For its surface span before its in-point the clip binds its
textures and steps its memory with `visible = false`, and `warmFrames` bounds that window by the
footage in front of the in-point, so a clip starting at source 0 enters cold, as does a seek there.
Pre-roll splits the same way: the surface half is per clip and the project's is the longest, while
the trails half is one buffer over the composite.

**A take's cache is sized by the clips asking for it**, since a seek plans per clip and the cache
is per take. Capacity is what the clips demand plus 16 frames of slack, floored at the 192 frames a
single clip always has and capped by a ceiling derived from a 768 MiB budget, stated in bytes
because what a resident frame costs is the thing that varies. That ceiling is also the largest span
a plan may ask for, since a cache smaller than a fetch evicts what that fetch just put in it.

**A head trim writes the clip's `sourceStart`**, which is source seconds at the clip's head, so
trimming back to the head of the take returns it to 0. Dragging a clip's head moves `start` and the
trim together, so the out-point and the footage under the body stand still.

**Everything inside a clip is on the clip's own clock.** A clip-scope track is read at program time
less the clip's in-point; the project's tracks, the post chain and the camera, are read at program
time. `trackEpoch` is the one place that answers and what it asks is the parameter's scope, so a
term added to the clip block next year is on the clip's clock by existing. That is what dragging a
clip means: its look and its place arrive with it, and its stored key times are clip-local too, so
a saved edit survives being re-cut.

**A clip's look is its own.** Its clip-scope values, its placement, the tracks that move them and
its parked pool live on the clip; the post chain's terms, the view state, the camera and `requires`
live on the project. `checkProject` reads each clip's block into that clip and there is no union,
so two clips may disagree about every value. A preset applies through the same door, so its cloud
values land on the selected clip and its post values on the project, which moves the grade every
clip is seen through. Framing stays outside: levelling, clip planes and the crop box belong to the
shot, and no preset, `none` included, writes them.

**Which clip is selected is session state and never in the document**, because a document recording
it would make two people's saves of one edit differ over nothing. Opening a take selects its clip;
loading a project selects nothing. A look write lands on the clip under evaluation, else the
selected one, and `withClip` is the one door that changes that answer.

**Adding and removing a clip is an ordinary undo step**, because clips live in the body
`history.snapshot()` stringifies. Removing needs more than a commit: `restoreProject` is
synchronous and refuses a document naming footage this page is not holding, which is what the undo
of a delete hands it. A take a clip lets go keeps its index, so the slot is re-pointed from the
open take — which holds only because the undo stack is session state, so every take an entry names
is one the page opened.

### Rendered timeline previews

`web/previews.js` schedules one hidden editor iframe and displays completed images during
playback. The iframe opens the same document door and calls the same `renderProgramFrame` as
the editor and export. Each discontinuity seeks with full effect history; adjacent frames step
forward. Readback captures the requested framebuffer as a lossless PNG. The top-down inset
receives a small depth sample for each clip, so it follows the displayed frame too. The iframe
has separate renderer and transport state but shares the browser thread and GPU. It yields
between frames and during pre-roll; an individual GPU render or readback can still delay input.

`web/preview-cache.js` holds PNGs in IndexedDB under a canonical representation of the complete
document, source hashes, effect revisions, renderer identity, output dimensions, and camera view.
The key is used directly so previews also work on ordinary LAN HTTP, where Web Crypto is absent.
The renderer
identity includes the reported GPU, WebGL version, and browser build. The code revision comes
from `GET /preview/renderer`, which hashes the shipped web files and Three.js renderer files.
Animated values are normalized to their tracks when computing identity, so evaluating the next
frame does not change its cache. Camera and slider gestures defer full document identity work
until the editor settles. Generation checks discard renders and image decodes that finish after
a document or camera change. Storage transactions bound the encoded cache across tabs and reject
writes from renders started before a clear. BroadcastChannel notifies other editors of storage
changes. The editor closes decoded bitmaps on eviction and recreates its store after a preserved
page is restored. Clear and 30 seconds without rendering release the hidden renderer.

Cache misses and stopping cached playback seek through the live transport to restore its source
and feedback state. Cached playback prefetches a known boundary's seek window without using the
source cursor left behind by the last live frame. Preview exceptions disable previews and report
the error while the editor's animation loop continues. Export bypasses the preview path.

## Projects, and which one is open

**A project saves itself and there is no save action.** Every committed change writes the whole
body to the project's file, so no dirty flag has to be kept right on every path that mutates the
edit. The write is fire-and-forget: a failure leaves the edit on screen and says so on the status
line, and a write the store refuses as stale stops this tab queueing further writes (writes already
queued still go out) and raises a banner carrying the store's sentence and the time of the last
save that landed. What autosave costs is throwing an
experiment away by declining to save it, and duplicating is the answer. Deleting lives on the
projects page, since autosave would write the file back the moment anything was touched.

**There is one kind of document and it carries a name from the moment it exists.** The projects
page mints `Untitled 1`, and the list is ordered by each file's mtime, which every autosave moves,
so the project at the top is the one last worked on and nothing is stored to know it. `VALID_ID`
guards take ids, which nothing types, and allows no space. Document names get
`documentNameRefusal`, which allows a space and rules out everything that would change the path the
name joins to, up to `MAX_DOCUMENT_NAME_BYTES`.

**A project shows a picture, and dragging it walks the cut.** The listing hands the whole document
body over, so only frames are fetched. The finger moves through program time: the clip covering
that second is found by its `start` and `length`, its `speed` and `sourceStart` map it into source
time, and the skim changes capture at a cut. Nothing here holds the grade, the effects or the
camera, so the skim is raw geometry. `web/take-draw.js` draws it — a take, a canvas and an index
in, a frame out, the capture free to change between draws — and the library page and the clip
picker are its other callers.

**A project whose footage is not on this machine says so on its row, and the control goes to the
library.** The loader refuses a document naming a take no local capture hashes, so reclaiming one
take darkens every project cut on it. The projects page never fetches: the download and the
two-machine state live on the library page.

**A write carries the revision it was made against, and a stale one is refused.** The document
store hands a `rev` back on every read and write, so autosave sends the rev it last saw and the
server refuses a body whose rev has moved. It is the rule take rename runs under, and it stops a
rename forking a project into two diverging files. A refusal means somebody else has this project
open and this tab's last change did not land.

## Surface memory

A ray landing on a different surface between frames is a death and a birth, and teleporting the
point is the loudest artifact in the image. A ping-pong float target in `web/surface-memory.js`
remembers where each ray was and how long ago it swapped.

- **`fade`** cross-fades the transition, the new point ramping in as the old one thins out. 120ms
  by default, and the correctness half.
- **`wake`** lets a hard transition linger past the fade, shedding a trail from moving silhouettes.
  0 by default, 550ms under Blackwall.

Both are in milliseconds, so a better frame rate does not shorten the look. `MAX_AGE` is 6.0
seconds and `refuseAgeCeiling` refuses a fade and wake asking for more, because a frame depending
on more history than the memory holds is one no pre-roll reproduces. At zero the ghost geometry
leaves the draw range and the plain 217,088-point draw is restored.

## Frame interpolation

The sensor delivers 30fps on a healthy USB topology while the display runs at 120Hz, so the vertex
shader blends between the last two depth frames instead of holding each until the next arrives.

- **Blend time comes from measured arrival spacing.** The gap between stamps is kept as a running
  average weighted towards the recent ones, because assuming 30fps and guessing wrong on a degraded
  link stutters worse than not blending. The blend clamps at 1.0, so a late frame holds on the
  newest data and never extrapolates past it.
- **Discontinuities snap instead of lerping.** A hand crossing in front of a wall jumps metres
  between frames, and interpolating that smears through empty space for the whole interval. Past
  `snapDelta` millimetres — 250 by default — the point jumps to the new depth.

## Wire format

One framing for the live stream, the recording and the replay, so a capture file holds the frames
exactly as the grabber framed them:

```
[u32 magic 'KNCT'][u32 type][u32 payloadLen][payload]

type 1  hello  UTF-8 JSON, once, before any frame:
               { format, serial, firmware, width, height, fx, fy, cx, cy,
                 color, minDepth, maxDepth, lowLight, startedAt }
type 2  frame  [u32 depthBytes][u32 colorBytes][u64 timestampMs]
               [u16 depth[512*424] millimetres, 0 = no reading]
               [JPEG of the registered 512x424 colour image]
type 3  colour [u64 timestampMs][JPEG of the native 1920x1080 colour image]
               Live only, and only while something is subscribed.
```

Everything is little-endian, one message after another to EOF, and `MAX_PAYLOAD_BYTES` is
8,388,608: a longer declared payload means the stream has desynced. A short final payload is a take
cut off mid-write, so a reader stops at the tail and keeps the take. The browser unprojects with
`fx`, `fy`, `cx` and `cy` off the hello, since hardcoded intrinsics skew the cloud in a way that is
hard to spot. `server/protocol.js` carries the decoder specification.

**`format` is the generation of the capture format, and a take carrying no `format` key is
generation zero.** Nothing migrates old captures, because rewriting a capture is the one operation
this design will not perform on an artifact that cannot be shot again. A take declaring nothing
opens, one declaring this build's generation opens, and anything else is refused: the alternative
is unprojecting it on assumptions that may not be its own. `web/format.js` owns the
number as `CAPTURE_FORMAT`, `native/grabber.cpp` carries the only other spelling, and
`tools/syntax-check.mjs` holds the two equal and this key list to what the grabber emits.

**Four of the other keys are load-bearing.** `startedAt` is the only durable capture date a take
has, since frame stamps are `steady_clock` and monotonic since boot; without it the library's
ordering silently becomes when a take was last copied, with `describeTake` reporting
`dateSource: 'mtime'` and no error. `minDepth` and `maxDepth` say how much of the world the
file was allowed to contain, and the editor paints its preview range from them. `lowLight` says
whether the colour camera was run long-exposure.

**`startedAt` means one thing on the wire and a narrower thing in a file.** The grabber says hello
once per process, so the wire's value is when the grabber came up and would date a session's takes
alike. `stampHello` replaces it, so a take's hello carries when that take began.

**Type 3 never reaches a file.** The recorder drops the colour message, because a third message
type would move every take's content hash, the key the library joins two machines on.

Measured on a sensor capture, and which take is not recorded: 434,176 bytes of depth plus a
49-59KB JPEG, 486KB per frame. At 30fps that is 14.6MB/s per browser, right at the practical
ceiling of Wi-Fi.

**Every frame in this format is horizontally mirrored, and the readers are what undo it.**
libfreenect2 flips depth, IR and colour left-for-right to match the Microsoft SDK's
selfie-view convention, and the grabber `memcpy`s the buffer through untouched, which keeps the
archive single-valued: flipping columns before the wire would leave takes from either side of the
change mirrored differently with nothing in the file to tell them apart. The correction is one sign
in the unprojection, `X = -(col + 0.5 - cx) / fx * z`, with `cx` used exactly as the hello reports
it. That is one sign away from `Registration::getPointXYZ`, which describes a reflection of the
room, so `server/protocol.js` carries the derivation and a warning not to copy upstream back in.
`level-check` section 8 holds the five readers that state the sign to one answer.
